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
    """Resolve assertion target text from the capture blob.

    Supported targets:
    - stdout / stderr / transcript / exit_code / exit_codes: raw capture fields
    - final_text / agent_messages: user-visible agent message text
    - last_agent_message: last non-empty agent message only
    - all: join of common raw fields (excludes derived final_text duplicates)
    """
    if target in {"final_text", "agent_messages"}:
        return blob.get("final_text") or blob.get("agent_messages") or ""
    if target == "last_agent_message":
        return blob.get("last_agent_message") or ""
    if target == "all":
        parts = [blob.get(k, "") for k in ("stdout", "stderr", "transcript", "exit_code", "exit_codes")]
        return "\n".join(parts)
    return blob.get(target, "")




def enrich_blob_with_candidate_text(blob: dict[str, str], backend) -> dict[str, str]:
    """Attach derived user-visible text fields used by assertions and quality."""
    final_text = ""
    messages: list[str] = []
    if hasattr(backend, "extract_agent_messages"):
        messages = backend.extract_agent_messages(blob.get("stdout", "") or "")
    if messages:
        final_text = "\n\n".join(m for m in messages if m and str(m).strip()).strip()
        blob["agent_messages"] = final_text
        blob["last_agent_message"] = next((m for m in reversed(messages) if m and str(m).strip()), "")
    if not final_text and hasattr(backend, "extract_candidate_output"):
        final_text = (backend.extract_candidate_output(blob) or "").strip()
    if not final_text:
        # Last-resort local Codex JSONL extraction so assertions still work in replay.
        msgs = []
        for line in (blob.get("stdout") or "").splitlines():
            line = line.strip()
            if not line.startswith("{"):
                continue
            try:
                obj = json.loads(line)
            except Exception:
                continue
            item = obj.get("item")
            if isinstance(item, dict) and item.get("type") == "agent_message" and item.get("text"):
                msgs.append(str(item["text"]))
        if msgs:
            final_text = "\n\n".join(msgs).strip()
            blob["agent_messages"] = final_text
            blob["last_agent_message"] = msgs[-1]
    blob["final_text"] = final_text
    if "agent_messages" not in blob:
        blob["agent_messages"] = final_text
    if "last_agent_message" not in blob:
        blob["last_agent_message"] = final_text
    return blob

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
    """Prefer hyphenated names: <skill>-<scenario>.json; fall back to underscore legacy."""
    hyphen = test_root / "specs" / f"{skill}-{scenario}.json"
    underscore = test_root / "specs" / f"{skill}_{scenario}.json"
    if hyphen.exists():
        return hyphen
    if underscore.exists():
        return underscore
    return hyphen


def spec_basename(spec_path: Path) -> str:
    """Return the spec file stem used as the report basename prefix.

    Example: article-analysis-behavior.json -> article-analysis-behavior
    """
    return Path(spec_path).stem


def normalize_eval_level(raw: str | None) -> str | None:
    if raw is None:
        return None
    value = str(raw).strip().upper()
    if value in {"L1", "L2", "L3"}:
        return value
    if value in {"1", "2", "3"}:
        return f"L{value}"
    if value == "AUTO":
        return "AUTO"
    return None


def resolve_eval_level(
    spec: dict[str, Any],
    *,
    assertions_only: bool = False,
    quality_only: bool = False,
    cli_level: str | None = None,
) -> str:
    """Resolve which evaluation level this run represents for report naming.

    Priority:
    1. explicit CLI --level
    2. --assertions-only => L1
    3. --quality-only => L2
    4. spec.level when L1/L2/L3
    5. auto: aspiration.enabled => L3; quality.enabled => L2; else L1
    """
    explicit = normalize_eval_level(cli_level)
    if explicit and explicit != "AUTO":
        return explicit
    if assertions_only:
        return "L1"
    if quality_only:
        return "L2"

    spec_level = normalize_eval_level(spec.get("level"))
    if spec_level and spec_level != "AUTO":
        return spec_level

    aspiration = spec.get("aspiration") or {}
    if isinstance(aspiration, dict) and aspiration.get("enabled"):
        return "L3"
    quality = spec.get("quality") or {}
    if isinstance(quality, dict) and quality.get("enabled"):
        return "L2"
    return "L1"


def default_report_name(
    spec_stem: str,
    level: str,
    *,
    case_id: str | None = None,
    replay: bool = False,
) -> str:
    """Build the canonical report filename.

    Examples:
      article-analysis-behavior-l1-report.json
      article-analysis-behavior-l2-report.json
      article-analysis-behavior-l3-report.json
      article-analysis-behavior-l2-missing-source-report.json  (single-case filter)
      article-analysis-behavior-l2-report-replay.json
    """
    level_token = normalize_eval_level(level) or "L1"
    level_slug = level_token.lower()  # l1/l2/l3
    parts = [spec_stem, level_slug]
    if case_id:
        # keep case id readable but filesystem-safe-ish
        safe_case = re.sub(r"[^A-Za-z0-9._-]+", "-", case_id).strip("-")
        if safe_case:
            parts.append(safe_case)
    parts.append("report")
    name = "-".join(parts)
    if replay:
        name = f"{name}-replay"
    return f"{name}.json"


def default_report_path(test_root: Path, skill: str, scenario: str, level: str = "L1") -> Path:
    stem = f"{skill}-{scenario}"
    return test_root / "reports" / default_report_name(stem, level)


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
    run_quality: bool = True,
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
    return evaluate_blob(
        spec=spec,
        case=case,
        blob=blob,
        turns=turns,
        backend=backend,
        judge_backend=judge_backend,
        judge_env=judge_env,
        timeout=timeout,
        run_quality=run_quality,
    )




def parse_case_filters(values: list[str] | None) -> set[str] | None:
    """Parse repeated --case values and comma-separated lists into a set of ids."""
    if not values:
        return None
    ids: set[str] = set()
    for raw in values:
        for part in str(raw).split(","):
            part = part.strip()
            if part:
                ids.add(part)
    return ids or None


def filter_cases(cases: list[dict[str, Any]], case_ids: set[str] | None) -> list[dict[str, Any]]:
    if not case_ids:
        return cases
    selected = [c for c in cases if c.get("id") in case_ids]
    missing = sorted(case_ids - {c.get("id") for c in selected})
    if missing:
        available = ", ".join(c.get("id", "?") for c in cases) or "(none)"
        raise ValueError(f"unknown case id(s): {', '.join(missing)}; available: {available}")
    return selected


def blob_from_turns(turns: list[dict[str, Any]]) -> dict[str, str]:
    """Rebuild a capture blob from stored turn results (for replay)."""
    blob: dict[str, str] = {
        "stdout": "",
        "stderr": "",
        "transcript": "",
        "exit_code": "0",
        "exit_codes": "",
    }
    exit_codes: list[str] = []
    for index, turn in enumerate(turns or []):
        stdout = turn.get("stdout") or ""
        stderr = turn.get("stderr") or ""
        blob["stdout"] += f"\n---TURN {index + 1} STDOUT---\n{stdout}"
        blob["stderr"] += f"\n---TURN {index + 1} STDERR---\n{stderr}"
        code = turn.get("exit_code", 0)
        exit_codes.append(str(code if code is not None else 0))
        blob["exit_code"] = str(code if code is not None else 0)
        if turn.get("error") == "timeout":
            blob["exit_code"] = "-1"
            exit_codes[-1] = "-1"
            break
    blob["exit_codes"] = ",".join(exit_codes)
    return blob


def evaluate_blob(
    *,
    spec: dict[str, Any],
    case: dict[str, Any],
    blob: dict[str, str],
    turns: list[dict[str, Any]],
    backend,
    judge_backend,
    judge_env: dict[str, str],
    timeout: int,
    run_quality: bool,
) -> CaseResult:
    """Evaluate assertions (and optional quality) against an existing blob/turns."""
    enrich_blob_with_candidate_text(blob, backend)
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
    exit_codes = [int(x) for x in (blob.get("exit_codes") or blob.get("exit_code") or "0").split(",") if x != ""]
    if has_exit_code_assertion:
        passed = all(a.passed for a in assertions)
    else:
        passed = all(a.passed for a in assertions) and all(code == 0 for code in exit_codes)

    quality = None
    quality_config = spec.get("quality")
    if (
        run_quality
        and passed
        and quality_config
        and quality_config.get("enabled", False)
    ):
        quality_report = run_quality_evaluation(
            blob=blob,
            quality_config=quality_config,
            case_assertions=case.get("assertions", []),
            judge_backend=judge_backend,
            judge_env=judge_env,
            timeout=timeout,
            baseline_blob=None,
        )
        quality = quality_report.to_dict()
    return CaseResult(case.get("id", "unnamed"), passed, turns, assertions, quality)


def replay_case(
    *,
    spec: dict[str, Any],
    case: dict[str, Any],
    prior_case: dict[str, Any],
    backend,
    judge_backend,
    judge_env: dict[str, str],
    run_quality: bool,
    assertions_only: bool,
    quality_only: bool,
) -> CaseResult:
    """Re-evaluate a case using trajectories stored in a previous report."""
    turns = prior_case.get("turns") or []
    blob = blob_from_turns(turns)
    # Preserve transcript if the prior report embedded it somewhere later; usually absent.
    timeout = int(case.get("timeout", spec.get("timeout", DEFAULT_TIMEOUT)))
    if quality_only:
        # Keep prior assertion pass/fail if present, but recompute from current assertions
        # unless caller wants pure quality regrade of a previously passing case.
        result = evaluate_blob(
            spec=spec,
            case=case,
            blob=blob,
            turns=turns,
            backend=backend,
            judge_backend=judge_backend,
            judge_env=judge_env,
            timeout=timeout,
            run_quality=True,
        )
        return result
    return evaluate_blob(
        spec=spec,
        case=case,
        blob=blob,
        turns=turns,
        backend=backend,
        judge_backend=judge_backend,
        judge_env=judge_env,
        timeout=timeout,
        run_quality=(run_quality and not assertions_only),
    )


def load_spec(spec_path: Path) -> dict[str, Any]:
    return json.loads(spec_path.read_text(encoding="utf-8"))


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("spec", type=Path, nargs="?", help="Spec JSON path. Relative paths resolve from the target skill's test/ dir when --skill is provided.")
    ap.add_argument("--skill", help="Target skill name.")
    ap.add_argument("--scenario", default="behavior", help="Scenario name used for default spec/report filenames.")
    ap.add_argument(
        "--level",
        default=None,
        help="Evaluation level for this run/report naming: L1|L2|L3|auto. Overrides inference from flags/spec.",
    )
    ap.add_argument("--backend", default="codex", help="Backend name: codex, hermes, or claude_code.")
    ap.add_argument("--out", type=Path, help="Report JSON path. Relative paths resolve from the target skill's test/ dir.")
    ap.add_argument("--keep-home", action="store_true")
    ap.add_argument(
        "--case",
        action="append",
        default=[],
        help="Only run/replay these case ids. Repeatable, or comma-separated.",
    )
    ap.add_argument(
        "--replay-report",
        type=Path,
        help="Re-evaluate assertions/quality from an existing report's trajectories without re-running the agent.",
    )
    ap.add_argument(
        "--assertions-only",
        action="store_true",
        help="Skip quality evaluation even if spec.quality.enabled is true.",
    )
    ap.add_argument(
        "--quality-only",
        action="store_true",
        help="With --replay-report, recompute quality (and assertions) from stored trajectories.",
    )
    args = ap.parse_args()

    if args.quality_only and not args.replay_report:
        ap.error("--quality-only requires --replay-report")
    if args.assertions_only and args.quality_only:
        ap.error("--assertions-only and --quality-only are mutually exclusive")

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
        spec_path = resolve_artifact_path(
            args.spec,
            test_root=test_root,
            default_subdir="specs",
            default_name=f"{args.skill}-{args.scenario}.json",
        )
        spec = load_spec(spec_path)

    if "backend" in spec:
        backend = get_backend(spec.get("backend"))
    judge_backend = get_backend(spec.get("judge_backend") or backend.name)

    test_root = backend.target_test_root(spec)
    case_ids = parse_case_filters(args.case)
    try:
        cases = filter_cases(list(spec.get("cases", [])), case_ids)
    except ValueError as e:
        ap.error(str(e))

    eval_level = resolve_eval_level(
        spec,
        assertions_only=args.assertions_only,
        quality_only=args.quality_only,
        cli_level=args.level,
    )
    # L1 runs should not pay for quality even if the spec has quality.enabled.
    if eval_level == "L1":
        args.assertions_only = True
    # Naming is always derived from the spec file stem, e.g.
    # article-analysis-behavior.json -> article-analysis-behavior-l2-report.json
    report_stem = spec_basename(spec_path)
    only_case = next(iter(case_ids)) if case_ids and len(case_ids) == 1 else None
    out_name = default_report_name(
        report_stem,
        eval_level,
        case_id=only_case,
        replay=bool(args.replay_report),
    )
    out_path = resolve_artifact_path(
        args.out,
        test_root=test_root,
        default_subdir="reports",
        default_name=out_name,
    )

    run_quality = not args.assertions_only
    started = time.time()
    results: list[CaseResult] = []
    home = None
    judge_home = None

    if args.replay_report:
        replay_path = args.replay_report
        if not replay_path.is_absolute():
            replay_path = (Path.cwd() / replay_path).resolve()
        prior = json.loads(replay_path.read_text(encoding="utf-8"))
        prior_cases = {c.get("id"): c for c in prior.get("cases", [])}
        missing = [c.get("id") for c in cases if c.get("id") not in prior_cases]
        if missing:
            ap.error(f"--replay-report missing trajectories for case id(s): {', '.join(missing)}")

        # Quality replay may need a judge home/auth; assertions-only does not.
        needs_judge = run_quality and bool(spec.get("quality", {}).get("enabled", False))
        if needs_judge or args.quality_only:
            home = backend.make_temp_home(test_root)
            judge_home = home if judge_backend.name == backend.name else judge_backend.make_temp_home(test_root)
            backend.prepare_home(home, spec)
            if judge_home != home:
                judge_backend.prepare_home(judge_home, spec)
            judge_env = judge_backend.env(judge_home, spec)
        else:
            judge_env = {}

        for case in cases:
            prior_case = prior_cases[case.get("id")]
            results.append(
                replay_case(
                    spec=spec,
                    case=case,
                    prior_case=prior_case,
                    backend=backend,
                    judge_backend=judge_backend,
                    judge_env=judge_env,
                    run_quality=run_quality,
                    assertions_only=args.assertions_only,
                    quality_only=args.quality_only,
                )
            )
        mode = "replay"
    else:
        home = backend.make_temp_home(test_root)
        judge_home = home if judge_backend.name == backend.name else judge_backend.make_temp_home(test_root)
        backend.prepare_home(home, spec)
        if judge_home != home:
            judge_backend.prepare_home(judge_home, spec)
        backend.copy_skill_tree(spec["skill"], home)
        for name in spec.get("related_skills", []):
            backend.copy_skill_tree(name, home)

        env = backend.env(home, spec)
        judge_env = judge_backend.env(judge_home, spec)
        results = [
            run_case(
                spec,
                case,
                backend,
                env,
                home,
                judge_backend=judge_backend,
                judge_env=judge_env,
                run_quality=run_quality,
            )
            for case in cases
        ]
        mode = "live"

    quality_passed = all(
        case.quality.get("threshold_passed", True) if case.quality else True
        for case in results
        if case.passed
    )
    infra_failed = any(
        bool(case.quality and case.quality.get("infra_failed"))
        for case in results
        if case.passed
    )
    report = {
        "skill": spec["skill"],
        "backend": backend.name,
        "judge_backend": judge_backend.name,
        "mode": mode,
        "eval_level": eval_level,
        "spec_stem": report_stem,
        "success": all(case.passed for case in results),
        "passed": sum(case.passed for case in results),
        "failed": sum(not case.passed for case in results),
        "total": len(results),
        "duration_seconds": round(time.time() - started, 2),
        "spec_path": str(spec_path),
        "report_path": str(out_path),
        "test_root": str(test_root),
        "backend_home": str(home) if home is not None else None,
        "replay_report": str(args.replay_report) if args.replay_report else None,
        "case_filter": sorted(case_ids) if case_ids else None,
        "assertions_only": bool(args.assertions_only),
        "quality_only": bool(args.quality_only),
        "quality_enabled": bool(spec.get("quality", {}).get("enabled", False)) and run_quality,
        "quality_passed": quality_passed,
        "quality_infra_failed": infra_failed,
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
    text_out = json.dumps(report, ensure_ascii=False, indent=2)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(text_out, encoding="utf-8")
    print(text_out)
    if home is not None and not args.keep_home:
        shutil.rmtree(home, ignore_errors=True)
        if judge_home is not None and judge_home != home:
            shutil.rmtree(judge_home, ignore_errors=True)
    # Replay assertion success still uses behavioral success; infra quality failure
    # is exposed via quality_passed/quality_infra_failed fields.
    return 0 if report["success"] else 1



if __name__ == "__main__":
    raise SystemExit(main())
