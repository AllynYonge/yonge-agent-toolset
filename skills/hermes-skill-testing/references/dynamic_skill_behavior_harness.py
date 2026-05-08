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
import time
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any

from backends import get_backend

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
            turns.append(result.as_dict())
            exit_codes.append(-1)
            blob["stdout"] += f"\n---TURN {index + 1} STDOUT---\n{result.stdout}"
            blob["stderr"] += f"\n---TURN {index + 1} STDERR---\n{result.stderr}"
            blob["exit_code"] = "-1"
            break
        turns.append(result.as_dict())
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
    return CaseResult(case.get("id", "unnamed"), passed, turns, assertions)


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
    judge_backend = get_backend(spec.get("judge_backend", "hermes"))

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
        "cases": [
            {"id": case.id, "passed": case.passed, "turns": case.turns, "assertions": [asdict(a) for a in case.assertions]}
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
