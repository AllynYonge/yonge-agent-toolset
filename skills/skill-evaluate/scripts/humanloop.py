#!/usr/bin/env python3
"""Human-in-the-loop wrapper for skill behavior testing.

Runs the harness (optionally with stability analysis), inspects results,
and pauses for human input when specific ambiguity conditions are met.

Trigger conditions for human intervention:
  - Semantic assertion pass_rate in 0.3-0.7 (flaky)
  - Quality dimension score at threshold boundary
  - Behavior iteration exhausted (3x failed)
  - Baseline delta negative (regression)

User decisions are persisted to clarifications.json and optionally
written back into the spec's quality rubrics (rubric convergence).
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
import time
from dataclasses import dataclass, asdict
from pathlib import Path
from typing import Any


@dataclass
class HumanLoopTrigger:
    condition: str  # "flaky_assertion" | "quality_borderline" | "iteration_exhausted" | "baseline_regression"
    case_id: str
    detail: str
    context: dict[str, Any]


def detect_triggers(
    report: dict[str, Any],
    stability: dict[str, Any] | None,
    quality_config: dict[str, Any],
) -> list[HumanLoopTrigger]:
    """Analyze reports and detect conditions requiring human input."""
    triggers: list[HumanLoopTrigger] = []
    thresholds = quality_config.get("thresholds", {})
    min_score = thresholds.get("min_score", 3)

    # 1. Flaky semantic assertions (from stability report)
    if stability:
        for case in stability.get("cases", []):
            for a in case.get("flaky_assertions", []):
                triggers.append(HumanLoopTrigger(
                    condition="flaky_assertion",
                    case_id=case["id"],
                    detail=f"Assertion #{a['index']} pass_rate={a['pass_rate']} ({a['classification']})",
                    context={"assertion": a["assertion"], "pass_rate": a["pass_rate"]},
                ))

    # 2. Quality borderline (score == min_score or min_score - 1)
    for case in report.get("cases", []):
        quality = case.get("quality")
        if not quality or not quality.get("grades"):
            continue
        for dim, grade in quality["grades"].items():
            score = grade.get("score", 5)
            if score in (min_score, min_score - 1):
                triggers.append(HumanLoopTrigger(
                    condition="quality_borderline",
                    case_id=case["id"],
                    detail=f"{dim}: score {score} is at/near threshold {min_score}",
                    context={
                        "dimension": dim,
                        "score": score,
                        "threshold": min_score,
                        "evidence": grade.get("evidence", ""),
                        "gaps": grade.get("gaps", ""),
                    },
                ))

    # 3. Behavior iteration exhausted
    if not report.get("success"):
        iteration_count = report.get("_iteration_count", 0)
        if iteration_count >= 3:
            for case in report.get("cases", []):
                if not case["passed"]:
                    failed_assertions = [
                        a for a in case.get("assertions", [])
                        if not a.get("passed")
                    ]
                    triggers.append(HumanLoopTrigger(
                        condition="iteration_exhausted",
                        case_id=case["id"],
                        detail=f"3 behavior iterations failed, {len(failed_assertions)} assertion(s) still failing",
                        context={"failed_assertions": failed_assertions},
                    ))

    # 4. Baseline delta negative (regression)
    for case in report.get("cases", []):
        quality = case.get("quality")
        if not quality or not quality.get("baseline_delta"):
            continue
        delta = quality["baseline_delta"]
        if delta.get("mean_delta", 0) < 0:
            triggers.append(HumanLoopTrigger(
                condition="baseline_regression",
                case_id=case["id"],
                detail=f"Skill caused quality regression: mean_delta={delta['mean_delta']}",
                context={"baseline_delta": delta},
            ))

    return triggers


def prompt_human(trigger: HumanLoopTrigger) -> dict[str, Any]:
    """Print a structured prompt and read user decision from stdin."""
    print(f"\n{'=' * 60}")
    print(f"  HUMAN INPUT NEEDED: {trigger.condition}")
    print(f"  Case: {trigger.case_id}")
    print(f"  {trigger.detail}")
    print(f"{'=' * 60}")

    if trigger.context:
        print(f"\nContext:")
        for key, val in trigger.context.items():
            if isinstance(val, (dict, list)):
                print(f"  {key}: {json.dumps(val, ensure_ascii=False, indent=4)[:500]}")
            else:
                print(f"  {key}: {val}")

    options = _options_for(trigger.condition)
    print(f"\nOptions:")
    for i, opt in enumerate(options, 1):
        print(f"  [{i}] {opt}")
    print(f"  [s] Skip this trigger")

    choice = input("\nYour choice: ").strip().lower()
    clarification = ""
    if choice in ("1", "2") and trigger.condition in ("flaky_assertion", "quality_borderline"):
        clarification = input("Clarification text (how should this be judged?): ").strip()
    elif choice == "1" and trigger.condition == "iteration_exhausted":
        clarification = input("Guidance for skill patch: ").strip()
    elif choice == "1" and trigger.condition == "baseline_regression":
        clarification = input("Reason for accepting regression: ").strip()

    return {
        "trigger": trigger.condition,
        "case_id": trigger.case_id,
        "choice": choice,
        "clarification": clarification,
        "detail": trigger.detail,
        "timestamp": time.strftime("%Y-%m-%dT%H:%M:%S"),
    }


def _options_for(condition: str) -> list[str]:
    if condition == "flaky_assertion":
        return [
            "Tighten rubric (provide clarification to stabilize judge)",
            "Convert to deterministic assertion (I'll describe the pattern)",
            "Accept instability (mark as known-flaky, don't block iteration)",
        ]
    if condition == "quality_borderline":
        return [
            "Raise standard (provide rubric refinement text)",
            "Accept current score (lower threshold for this dimension)",
            "Skip quality check for this dimension",
        ]
    if condition == "iteration_exhausted":
        return [
            "Provide guidance for skill patch",
            "Relax assertion (explain why it's too strict)",
            "Abort testing",
        ]
    if condition == "baseline_regression":
        return [
            "Accept regression (document reason)",
            "Provide improvement guidance",
            "Block — do not accept regression",
        ]
    return ["Continue", "Skip"]


def load_clarifications(path: Path) -> list[dict[str, Any]]:
    if path.exists():
        try:
            return json.loads(path.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, ValueError):
            return []
    return []


def save_clarifications(path: Path, clarifications: list[dict[str, Any]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(clarifications, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )


def apply_clarification_to_spec(
    spec_path: Path,
    decision: dict[str, Any],
    trigger: HumanLoopTrigger,
) -> bool:
    """Apply user's clarification back into the spec's quality rubrics.

    Returns True if the spec was modified.
    """
    if not decision.get("clarification"):
        return False
    if decision.get("choice") == "s":
        return False

    spec = json.loads(spec_path.read_text(encoding="utf-8"))
    quality = spec.setdefault("quality", {})
    rubrics = quality.setdefault("rubrics", {})
    modified = False

    if trigger.condition == "quality_borderline" and decision["choice"] == "1":
        dim = trigger.context.get("dimension", "")
        if dim and dim in rubrics:
            rubrics[dim] += f"\n\nUser clarification: {decision['clarification']}"
            modified = True
        elif dim:
            rubrics[dim] = decision["clarification"]
            modified = True

    elif trigger.condition == "quality_borderline" and decision["choice"] == "2":
        thresholds = quality.setdefault("thresholds", {})
        per_dim = thresholds.setdefault("per_dimension", {})
        dim = trigger.context.get("dimension", "")
        score = trigger.context.get("score", 3)
        if dim:
            per_dim[dim] = score
            modified = True

    elif trigger.condition == "flaky_assertion" and decision["choice"] == "1":
        quality.setdefault("rubric_clarifications", []).append({
            "case_id": decision["case_id"],
            "text": decision["clarification"],
        })
        modified = True

    if modified:
        spec_path.write_text(
            json.dumps(spec, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )

    return modified


def run_harness(args: argparse.Namespace) -> dict[str, Any] | None:
    """Run the harness once and return the report."""
    cmd = [sys.executable, str(Path(__file__).parent / "dynamic_skill_behavior_harness.py")]
    if args.spec:
        cmd.append(str(args.spec))
    if args.skill:
        cmd += ["--skill", args.skill]
    cmd += ["--scenario", args.scenario, "--backend", args.backend]
    if args.keep_home:
        cmd.append("--keep-home")

    try:
        cp = subprocess.run(
            cmd, cwd=str(Path(__file__).parent),
            capture_output=True, text=True, timeout=1800,
        )
    except subprocess.TimeoutExpired:
        print("[humanloop] Harness timed out", file=sys.stderr)
        return None

    try:
        return json.loads(cp.stdout)
    except (json.JSONDecodeError, ValueError):
        print(f"[humanloop] Harness produced invalid output", file=sys.stderr)
        if cp.stderr:
            print(f"  {cp.stderr[:300]}", file=sys.stderr)
        return None


def run_stability(args: argparse.Namespace) -> dict[str, Any] | None:
    """Run stability.py and return the stability report."""
    cmd = [sys.executable, str(Path(__file__).parent / "stability.py")]
    if args.spec:
        cmd.append(str(args.spec))
    if args.skill:
        cmd += ["--skill", args.skill]
    cmd += ["--scenario", args.scenario, "--backend", args.backend]
    cmd += ["--runs", str(args.runs)]
    if args.keep_home:
        cmd.append("--keep-home")

    try:
        cp = subprocess.run(
            cmd, cwd=str(Path(__file__).parent),
            capture_output=True, text=True, timeout=3600,
        )
    except subprocess.TimeoutExpired:
        print("[humanloop] Stability runner timed out", file=sys.stderr)
        return None

    try:
        return json.loads(cp.stdout)
    except (json.JSONDecodeError, ValueError):
        print("[humanloop] Stability runner produced invalid output", file=sys.stderr)
        return None


def resolve_spec_path(args: argparse.Namespace) -> Path | None:
    """Best-effort resolution of the spec path for writing back clarifications."""
    if args.spec:
        return args.spec
    if args.skill:
        from backends import get_backend
        backend = get_backend(args.backend)
        try:
            test_root = backend.target_test_root({"skill": args.skill})
            return test_root / "specs" / f"{args.skill}_{args.scenario}.json"
        except FileNotFoundError:
            return None
    return None


def main() -> int:
    ap = argparse.ArgumentParser(
        description="Human-in-the-loop wrapper for skill behavior testing"
    )
    ap.add_argument("spec", type=Path, nargs="?")
    ap.add_argument("--skill", help="Target skill name")
    ap.add_argument("--scenario", default="behavior")
    ap.add_argument("--backend", default="hermes")
    ap.add_argument("--runs", type=int, default=1,
                    help="Stability runs (>1 enables flaky detection)")
    ap.add_argument("--out", type=Path, help="Clarifications output path")
    ap.add_argument("--keep-home", action="store_true")
    args = ap.parse_args()

    # Step 1: Run harness (with optional stability)
    stability = None
    if args.runs > 1:
        print(f"[humanloop] Running stability analysis ({args.runs} runs)...", file=sys.stderr)
        stability = run_stability(args)
        if not stability:
            print("[humanloop] Stability run failed, falling back to single run", file=sys.stderr)

    print("[humanloop] Running harness...", file=sys.stderr)
    report = run_harness(args)
    if not report:
        print("[humanloop] Harness failed to produce a report", file=sys.stderr)
        return 1

    # Step 2: Load quality config from spec
    spec_path = resolve_spec_path(args)
    quality_config = {}
    if spec_path and spec_path.exists():
        spec = json.loads(spec_path.read_text(encoding="utf-8"))
        quality_config = spec.get("quality", {})

    # Step 3: Detect triggers
    triggers = detect_triggers(report, stability, quality_config)

    if not triggers:
        print("[humanloop] No human input needed. All clear.", file=sys.stderr)
        status = "pass" if report.get("success") else "behavior_fail"
        if report.get("quality_passed") is False:
            status = "quality_below_threshold"
        print(f"[humanloop] Status: {status}", file=sys.stderr)
        return 0 if report.get("success") else 1

    # Step 4: Prompt for each trigger
    print(f"\n[humanloop] {len(triggers)} trigger(s) detected, requesting input...\n", file=sys.stderr)

    # Default clarifications path: <target-skill>/test/<skill>_<scenario>_clarifications.json
    if args.out:
        clarifications_path = args.out
    elif spec_path:
        clarifications_path = spec_path.parent.parent / f"{args.skill or 'unnamed'}_{args.scenario}_clarifications.json"
    else:
        clarifications_path = Path(f"./{args.skill or 'unnamed'}_{args.scenario}_clarifications.json")
    all_clarifications = load_clarifications(clarifications_path)
    spec_modified = False

    for trigger in triggers:
        decision = prompt_human(trigger)
        if decision["choice"] == "s":
            continue
        all_clarifications.append(decision)

        if spec_path and spec_path.exists():
            if apply_clarification_to_spec(spec_path, decision, trigger):
                spec_modified = True
                print(f"  → Spec rubric updated for {trigger.condition}", file=sys.stderr)

    save_clarifications(clarifications_path, all_clarifications)
    print(f"\n[humanloop] {len(all_clarifications)} total decision(s) saved to {clarifications_path}", file=sys.stderr)

    if spec_modified:
        print("[humanloop] Spec was modified. Re-run the harness to see updated evaluation.", file=sys.stderr)

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
