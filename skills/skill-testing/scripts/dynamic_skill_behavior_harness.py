#!/usr/bin/env python3
"""Generic behavior test harness for agent skills.

Runs real agent CLI turns in an isolated backend home, captures stdout/stderr
and backend-specific transcripts, then evaluates expectations declared in a
JSON spec.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import subprocess
import time
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any

from backends import get_backend
from quality import run_quality_evaluation

REPO = Path(os.environ.get("HERMES_REPO", os.getcwd()))
DEFAULT_TIMEOUT = 240


@dataclass
class AssertionResult:
    assertion: dict[str, Any]
    passed: bool
    detail: str


@dataclass
class CaseResult:
    id: str
    passed: bool
    turns: list[dict[str, Any]]
    assertions: list[AssertionResult]
    quality: dict[str, Any] | None = None


def target_text(target: str, blob: dict[str, str]) -> str:
    return blob.get(target, "") if target != "all" else "\n".join(blob.values())


def tools_in(text: str) -> list[str]:
    out: list[str] = []
    for pat in [
        r'"name"\s*:\s*"([A-Za-z0-9_:-]+)"',
        r"tool(?:_call)?\s*[:=]\s*([A-Za-z0-9_:-]+)",
        r"Calling tool\s+([A-Za-z0-9_:-]+)",
    ]:
        out += re.findall(pat, text)
    return out


def default_spec_path(test_root: Path, skill: str, scenario: str) -> Path:
    return test_root / "specs" / f"{skill}_{scenario}.json"


def default_report_path(test_root: Path, skill: str, scenario: str) -> Path:
    return test_root / "reports" / f"{skill}_{scenario}_report.json"


def resolve_artifact_path(path: Path | None, *, test_root: Path, default_subdir: str, default_name: str) -> Path:
    if path is None:
        return test_root / default_subdir / default_name
    if path.is_absolute():
        return path
    return test_root / path


def eval_assertion(
    assertion: dict[str, Any],
    blob: dict[str, str],
    tool_names: list[str],
    backend,
    *,
    spec: dict[str, Any],
    judge_backend,
    judge_env: dict[str, str],
    timeout: int,
) -> AssertionResult:
    typ = assertion["type"]
    target = assertion.get("target", "all")
    text = target_text(target, blob)
    if typ == "contains":
        ok = assertion["value"] in text
        return AssertionResult(assertion, ok, f"expected {target} to contain {assertion['value']!r}")
    if typ == "not_contains":
        ok = assertion["value"] not in text
        return AssertionResult(assertion, ok, f"expected {target} not to contain {assertion['value']!r}")
    if typ == "regex":
        ok = re.search(assertion["pattern"], text, re.S) is not None
        return AssertionResult(assertion, ok, f"expected {target} to match /{assertion['pattern']}/s")
    if typ == "not_regex":
        ok = re.search(assertion["pattern"], text, re.S) is None
        return AssertionResult(assertion, ok, f"expected {target} not to match /{assertion['pattern']}/s")
    if typ == "semantic":
        ok, reason = judge_backend.run_semantic_judge(assertion, text, judge_env, timeout)
        return AssertionResult(assertion, ok, f"semantic judge: {reason}")
    if typ == "not_semantic":
        ok, reason = judge_backend.run_semantic_judge(assertion, text, judge_env, timeout)
        return AssertionResult(assertion, not ok, f"semantic judge expected false; judge said {ok}: {reason}")
    if typ == "tool_called":
        ok = assertion["name"] in tool_names
        return AssertionResult(assertion, ok, f"expected tool {assertion['name']!r} in {tool_names}")
    if typ == "tool_not_called":
        ok = assertion["name"] not in tool_names
        return AssertionResult(assertion, ok, f"expected tool {assertion['name']!r} not in {tool_names}")
    if typ == "exit_code":
        actual = int(blob.get("exit_code", "999999"))
        ok = actual == int(assertion["value"])
        return AssertionResult(assertion, ok, f"expected exit_code={assertion['value']}, got {actual}")
    raise ValueError(f"unknown assertion type {typ!r}")


def _run_baseline_without_skill(
    case: dict[str, Any],
    spec: dict[str, Any],
    backend,
    env: dict[str, str],
    home: Path,
    timeout: int,
) -> dict[str, str]:
    """Run the same prompts without loading the target skill.

    Creates a temporary home without the skill tree, runs all turns,
    and returns the captured output blob for quality comparison.
    """
    test_root = home.parent.parent  # home is under test/tmp/
    baseline_home = backend.make_temp_home(test_root)
    backend.prepare_home(baseline_home, spec)
    # Copy related skills but NOT the target skill
    for name in spec.get("related_skills", []):
        backend.copy_skill_tree(name, baseline_home)

    baseline_env = backend.env(baseline_home, spec)
    # Build a modified spec that disables skill preloading
    baseline_spec = {**spec, "preload_skill": False}

    state = backend.new_case_state()
    blob: dict[str, str] = {"stdout": "", "stderr": "", "transcript": "", "exit_code": "0", "exit_codes": ""}
    before = backend.files_for_transcript(baseline_home)
    exit_codes: list[int] = []

    for index, prompt in enumerate(case["turns"]):
        result = backend.run_turn(
            prompt,
            index=index,
            spec=baseline_spec,
            case=case,
            state=state,
            home=baseline_home,
            env=baseline_env,
            timeout=timeout,
        )
        exit_codes.append(result.exit_code if result.error != "timeout" else -1)
        blob["stdout"] += f"\n---TURN {index + 1} STDOUT---\n{result.stdout}"
        blob["stderr"] += f"\n---TURN {index + 1} STDERR---\n{result.stderr}"
        blob["exit_code"] = str(result.exit_code) if result.error != "timeout" else "-1"
        if result.error == "timeout":
            break

    blob["exit_codes"] = ",".join(str(c) for c in exit_codes)
    blob["transcript"] = backend.read_new_transcript(before, baseline_home)
    shutil.rmtree(baseline_home, ignore_errors=True)
    return blob


def _run_baseline_previous_version(
    case: dict[str, Any],
    spec: dict[str, Any],
    backend,
    env: dict[str, str],
    home: Path,
    timeout: int,
) -> dict[str, str] | None:
    """Run the same prompts with the previous git version of the skill.

    Uses `git show HEAD~1:path` to extract the previous SKILL.md and related
    files into a temporary home, then runs all turns against that version.
    Returns None if no previous version exists (e.g., skill is new).
    """
    skill_name = spec["skill"]
    try:
        skill_dir, rel_dir = backend.find_skill_dir(skill_name)
    except FileNotFoundError:
        return None

    # Check if a previous version exists in git
    skill_root = backend.skill_root()
    rel_path = str(rel_dir / "SKILL.md")
    try:
        cp = subprocess.run(
            ["git", "show", f"HEAD~1:{rel_path}"],
            cwd=str(skill_root),
            capture_output=True,
            text=True,
            timeout=10,
        )
        if cp.returncode != 0:
            return None  # No previous version in git
    except (subprocess.TimeoutExpired, FileNotFoundError):
        return None

    # Create baseline home with previous version of the skill
    test_root = home.parent.parent
    baseline_home = backend.make_temp_home(test_root)
    backend.prepare_home(baseline_home, spec)

    # Extract previous skill version from git into baseline home
    dst_skill_dir = baseline_home / "skills" / rel_dir
    dst_skill_dir.mkdir(parents=True, exist_ok=True)

    # Get list of files in the skill dir at HEAD~1
    try:
        tree_cp = subprocess.run(
            ["git", "ls-tree", "-r", "--name-only", "HEAD~1", str(rel_dir)],
            cwd=str(skill_root),
            capture_output=True,
            text=True,
            timeout=10,
        )
        if tree_cp.returncode != 0:
            shutil.rmtree(baseline_home, ignore_errors=True)
            return None
    except (subprocess.TimeoutExpired, FileNotFoundError):
        shutil.rmtree(baseline_home, ignore_errors=True)
        return None

    for file_rel in tree_cp.stdout.strip().splitlines():
        if not file_rel.strip():
            continue
        try:
            file_cp = subprocess.run(
                ["git", "show", f"HEAD~1:{file_rel}"],
                cwd=str(skill_root),
                capture_output=True,
                text=True,
                timeout=10,
            )
            if file_cp.returncode == 0:
                # file_rel is relative to skill_root; we need it relative to rel_dir
                out_path = baseline_home / "skills" / file_rel
                out_path.parent.mkdir(parents=True, exist_ok=True)
                out_path.write_text(file_cp.stdout, encoding="utf-8")
        except (subprocess.TimeoutExpired, FileNotFoundError):
            continue

    # Copy related skills (current version)
    for name in spec.get("related_skills", []):
        backend.copy_skill_tree(name, baseline_home)

    baseline_env = backend.env(baseline_home, spec)
    state = backend.new_case_state()
    blob: dict[str, str] = {"stdout": "", "stderr": "", "transcript": "", "exit_code": "0", "exit_codes": ""}
    before = backend.files_for_transcript(baseline_home)
    exit_codes: list[int] = []

    for index, prompt in enumerate(case["turns"]):
        result = backend.run_turn(
            prompt,
            index=index,
            spec=spec,
            case=case,
            state=state,
            home=baseline_home,
            env=baseline_env,
            timeout=timeout,
        )
        exit_codes.append(result.exit_code if result.error != "timeout" else -1)
        blob["stdout"] += f"\n---TURN {index + 1} STDOUT---\n{result.stdout}"
        blob["stderr"] += f"\n---TURN {index + 1} STDERR---\n{result.stderr}"
        blob["exit_code"] = str(result.exit_code) if result.error != "timeout" else "-1"
        if result.error == "timeout":
            break

    blob["exit_codes"] = ",".join(str(c) for c in exit_codes)
    blob["transcript"] = backend.read_new_transcript(before, baseline_home)
    shutil.rmtree(baseline_home, ignore_errors=True)
    return blob


def run_case(
    spec: dict[str, Any],
    case: dict[str, Any],
    backend,
    env: dict[str, str],
    home: Path,
    *,
    judge_backend,
    judge_env: dict[str, str],
) -> CaseResult:
    state = backend.new_case_state()
    turns = []
    exit_codes = []
    blob = {
        "stdout": "",
        "stderr": "",
        "transcript": "",
        "exit_code": "0",
        "exit_codes": "",
    }
    before = backend.files_for_transcript(home)
    timeout = int(case.get("timeout", spec.get("timeout", DEFAULT_TIMEOUT)))
    for index, prompt in enumerate(case["turns"]):
        result = backend.run_turn(
            prompt,
            index=index,
            spec=spec,
            case=case,
            state=state,
            home=home,
            env=env,
            timeout=timeout,
        )
        if result.error == "timeout":
            turn_data = result.as_dict()
            if state.session_id:
                turn_data["session_id"] = state.session_id
            turns.append(turn_data)
            exit_codes.append(-1)
            blob["stdout"] += f"\n---TURN {index + 1} STDOUT---\n{result.stdout}"
            blob["stderr"] += f"\n---TURN {index + 1} STDERR---\n{result.stderr}"
            blob["exit_code"] = "-1"
            break
        turn_data = result.as_dict()
        if state.session_id:
            turn_data["session_id"] = state.session_id
        turns.append(turn_data)
        exit_codes.append(result.exit_code)
        blob["stdout"] += f"\n---TURN {index + 1} STDOUT---\n{result.stdout}"
        blob["stderr"] += f"\n---TURN {index + 1} STDERR---\n{result.stderr}"
        blob["exit_code"] = str(result.exit_code)
    blob["exit_codes"] = ",".join(str(code) for code in exit_codes)
    blob["transcript"] = backend.read_new_transcript(before, home)
    names = tools_in("\n".join(blob.values()))
    assertions = [
        eval_assertion(
            a,
            blob,
            names,
            backend,
            spec=spec,
            judge_backend=judge_backend,
            judge_env=judge_env,
            timeout=timeout,
        )
        for a in case.get("assertions", [])
    ]
    has_exit_code_assertion = any(a["type"] == "exit_code" for a in case.get("assertions", []))
    if has_exit_code_assertion:
        passed = all(a.passed for a in assertions)
    else:
        passed = all(a.passed for a in assertions) and all(code == 0 for code in exit_codes)

    # Quality evaluation: only runs when behavior passes and quality is configured
    quality = None
    quality_config = spec.get("quality")
    if passed and quality_config and quality_config.get("enabled", False):
        # Run baseline if configured
        baseline_blob = None
        baseline_config = quality_config.get("baseline")
        if baseline_config and baseline_config.get("mode") == "without_skill":
            baseline_blob = _run_baseline_without_skill(
                case=case,
                spec=spec,
                backend=backend,
                env=env,
                home=home,
                timeout=timeout,
            )
        elif baseline_config and baseline_config.get("mode") == "previous_version":
            baseline_blob = _run_baseline_previous_version(
                case=case,
                spec=spec,
                backend=backend,
                env=env,
                home=home,
                timeout=timeout,
            )

        quality_report = run_quality_evaluation(
            blob=blob,
            quality_config=quality_config,
            case_assertions=case.get("assertions", []),
            judge_backend=judge_backend,
            judge_env=judge_env,
            timeout=timeout,
            baseline_blob=baseline_blob,
        )
        quality = quality_report.to_dict()

    return CaseResult(case.get("id", "unnamed"), passed, turns, assertions, quality)


def load_spec(spec_path: Path) -> dict[str, Any]:
    return json.loads(spec_path.read_text(encoding="utf-8"))


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("spec", type=Path, nargs="?", help="Spec JSON path. Relative paths resolve from the target skill's test/ dir when --skill is provided.")
    ap.add_argument("--skill", help="Target skill name.")
    ap.add_argument("--scenario", default="behavior", help="Scenario name used for default spec/report filenames.")
    ap.add_argument("--backend", default="hermes", help="Backend name: hermes, codex, or claude_code.")
    ap.add_argument("--out", type=Path, help="Report JSON path. Relative paths resolve from the target skill's test/ dir.")
    ap.add_argument("--keep-home", action="store_true")
    args = ap.parse_args()

    backend = get_backend(args.backend)

    if args.spec is None:
        if not args.skill:
            ap.error("either spec or --skill is required")
        test_root = backend.target_test_root({"skill": args.skill})
        spec_path = default_spec_path(test_root, args.skill, args.scenario)
        spec = load_spec(spec_path)
    elif args.spec.is_absolute() or not args.skill:
        spec_path = args.spec
        spec = load_spec(spec_path)
    else:
        test_root = backend.target_test_root({"skill": args.skill})
        spec_path = resolve_artifact_path(args.spec, test_root=test_root, default_subdir="specs", default_name=f"{args.skill}_{args.scenario}.json")
        spec = load_spec(spec_path)

    if "backend" in spec:
        backend = get_backend(spec.get("backend"))
    judge_backend = get_backend(spec.get("judge_backend") or backend.name)

    test_root = backend.target_test_root(spec)
    home = backend.make_temp_home(test_root)
    judge_home = home if judge_backend.name == backend.name else judge_backend.make_temp_home(test_root)
    out_path = resolve_artifact_path(args.out, test_root=test_root, default_subdir="reports", default_name=f"{spec['skill']}_{args.scenario}_report.json")

    backend.prepare_home(home, spec)
    if judge_home != home:
        judge_backend.prepare_home(judge_home, spec)
    backend.copy_skill_tree(spec["skill"], home)
    for name in spec.get("related_skills", []):
        backend.copy_skill_tree(name, home)

    env = backend.env(home, spec)
    judge_env = judge_backend.env(judge_home, spec)
    started = time.time()
    results = [run_case(spec, case, backend, env, home, judge_backend=judge_backend, judge_env=judge_env) for case in spec.get("cases", [])]
    report = {
        "skill": spec["skill"],
        "backend": backend.name,
        "judge_backend": judge_backend.name,
        "success": all(case.passed for case in results),
        "passed": sum(case.passed for case in results),
        "failed": sum(not case.passed for case in results),
        "total": len(results),
        "duration_seconds": round(time.time() - started, 2),
        "spec_path": str(spec_path),
        "report_path": str(out_path),
        "test_root": str(test_root),
        "backend_home": str(home),
        "quality_enabled": bool(spec.get("quality", {}).get("enabled", False)),
        "cases": [
            {
                "id": case.id,
                "passed": case.passed,
                "turns": case.turns,
                "assertions": [asdict(a) for a in case.assertions],
                **({"quality": case.quality} if case.quality else {}),
            }
            for case in results
        ],
    }
    text = json.dumps(report, ensure_ascii=False, indent=2)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(text, encoding="utf-8")
    print(text)
    if not args.keep_home:
        shutil.rmtree(home, ignore_errors=True)
        if judge_home != home:
            shutil.rmtree(judge_home, ignore_errors=True)
    return 0 if report["success"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
