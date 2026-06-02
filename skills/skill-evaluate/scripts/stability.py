#!/usr/bin/env python3
"""Stability runner: execute the behavior harness N times and aggregate results.

Detects flaky assertions (pass rate between 0.3-0.7) and produces a stability
report alongside individual run reports.

Exit codes:
  0 = all assertions stable
  1 = error (no reports produced)
  2 = flaky assertions detected
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path
from typing import Any

from dynamic_skill_behavior_harness import load_spec, main as harness_main


def parse_args() -> argparse.Namespace:
    ap = argparse.ArgumentParser(
        description="Run behavior harness multiple times for stability analysis"
    )
    ap.add_argument("spec", type=Path, nargs="?", help="Spec JSON path")
    ap.add_argument("--skill", help="Target skill name")
    ap.add_argument("--scenario", default="behavior")
    ap.add_argument("--backend", default="hermes")
    ap.add_argument("--runs", type=int, default=3, help="Number of harness runs (default: 3)")
    ap.add_argument("--out", type=Path, help="Stability report output path")
    ap.add_argument("--keep-home", action="store_true")
    return ap.parse_args()


def classify_assertion(pass_rate: float) -> str:
    if pass_rate >= 0.9:
        return "stable_pass"
    if pass_rate <= 0.1:
        return "stable_fail"
    if 0.3 <= pass_rate <= 0.7:
        return "flaky"
    if pass_rate > 0.7:
        return "mostly_pass"
    return "mostly_fail"


def run_harness_once(
    spec_path: Path | None,
    skill: str | None,
    scenario: str,
    backend: str,
    keep_home: bool,
    run_index: int,
) -> dict[str, Any] | None:
    """Run the harness as a subprocess to get a clean report."""
    import subprocess

    cmd = [sys.executable, str(Path(__file__).parent / "dynamic_skill_behavior_harness.py")]
    if spec_path:
        cmd.append(str(spec_path))
    if skill:
        cmd += ["--skill", skill]
    cmd += ["--scenario", f"{scenario}_stability_run{run_index}", "--backend", backend]
    if keep_home:
        cmd.append("--keep-home")

    try:
        cp = subprocess.run(
            cmd,
            cwd=str(Path(__file__).parent),
            capture_output=True,
            text=True,
            timeout=1800,
        )
    except subprocess.TimeoutExpired:
        print(f"[stability] Run {run_index} timed out", file=sys.stderr)
        return None

    try:
        return json.loads(cp.stdout)
    except (json.JSONDecodeError, ValueError):
        print(f"[stability] Run {run_index} produced invalid JSON", file=sys.stderr)
        if cp.stderr:
            print(f"  stderr: {cp.stderr[:500]}", file=sys.stderr)
        return None


def aggregate_runs(reports: list[dict[str, Any]]) -> dict[str, Any]:
    """Aggregate N run reports into stability metrics."""
    n = len(reports)
    if not reports:
        return {"runs": 0, "overall_pass_rate": 0.0, "cases": [], "has_flaky": False}

    case_ids = [c["id"] for c in reports[0].get("cases", [])]
    case_stability: list[dict[str, Any]] = []

    for case_id in case_ids:
        case_pass_count = 0
        assertion_stats: list[dict[str, Any]] = []

        for report in reports:
            case_data = next((c for c in report.get("cases", []) if c["id"] == case_id), None)
            if case_data and case_data["passed"]:
                case_pass_count += 1

        sample_case = next(
            (c for c in reports[0].get("cases", []) if c["id"] == case_id), None
        )
        if sample_case:
            for a_idx, assertion in enumerate(sample_case.get("assertions", [])):
                pass_count = 0
                for report in reports:
                    case_data = next(
                        (c for c in report.get("cases", []) if c["id"] == case_id), None
                    )
                    if case_data and a_idx < len(case_data.get("assertions", [])):
                        if case_data["assertions"][a_idx].get("passed"):
                            pass_count += 1
                rate = pass_count / n
                assertion_stats.append({
                    "index": a_idx,
                    "assertion": assertion.get("assertion", {}),
                    "pass_rate": round(rate, 3),
                    "classification": classify_assertion(rate),
                })

        quality_scores: dict[str, list[int]] = {}
        for report in reports:
            case_data = next((c for c in report.get("cases", []) if c["id"] == case_id), None)
            if case_data and case_data.get("quality") and case_data["quality"].get("grades"):
                for dim, grade in case_data["quality"]["grades"].items():
                    quality_scores.setdefault(dim, []).append(grade["score"])

        quality_stats: dict[str, dict[str, float]] = {}
        for dim, scores in quality_scores.items():
            mean = sum(scores) / len(scores)
            variance = sum((s - mean) ** 2 for s in scores) / max(len(scores) - 1, 1) if len(scores) > 1 else 0.0
            quality_stats[dim] = {
                "mean": round(mean, 2),
                "std": round(variance ** 0.5, 2),
                "min": min(scores),
                "max": max(scores),
            }

        case_stability.append({
            "id": case_id,
            "case_pass_rate": round(case_pass_count / n, 3),
            "assertions": assertion_stats,
            "quality_stats": quality_stats if quality_stats else None,
            "flaky_assertions": [a for a in assertion_stats if a["classification"] == "flaky"],
        })

    return {
        "runs": n,
        "overall_pass_rate": round(
            sum(1 for r in reports if r.get("success")) / n, 3
        ),
        "cases": case_stability,
        "has_flaky": any(cs["flaky_assertions"] for cs in case_stability),
    }


def resolve_default_out(args: argparse.Namespace) -> Path | None:
    """Resolve default output path to <target-skill>/test/reports/."""
    if args.out:
        return args.out
    if args.skill:
        from backends import get_backend
        backend = get_backend(args.backend)
        try:
            test_root = backend.target_test_root({"skill": args.skill})
            return test_root / "reports" / f"{args.skill}_{args.scenario}_stability.json"
        except FileNotFoundError:
            pass
    return None


def main() -> int:
    args = parse_args()
    reports: list[dict[str, Any]] = []

    for i in range(args.runs):
        print(f"[stability] Run {i + 1}/{args.runs}...", file=sys.stderr)
        report = run_harness_once(
            spec_path=args.spec,
            skill=args.skill,
            scenario=args.scenario,
            backend=args.backend,
            keep_home=args.keep_home,
            run_index=i,
        )
        if report:
            reports.append(report)

    if not reports:
        print("[stability] All runs failed to produce reports", file=sys.stderr)
        return 1

    stability = aggregate_runs(reports)
    stability["timestamp"] = time.strftime("%Y-%m-%dT%H:%M:%S")
    stability["spec"] = str(args.spec) if args.spec else f"{args.skill}_{args.scenario}"

    output = json.dumps(stability, ensure_ascii=False, indent=2)
    out_path = resolve_default_out(args)
    if out_path:
        out_path.parent.mkdir(parents=True, exist_ok=True)
        out_path.write_text(output, encoding="utf-8")
        print(f"[stability] Report written to {out_path}", file=sys.stderr)
    print(output)

    if stability["has_flaky"]:
        flaky_count = sum(len(c["flaky_assertions"]) for c in stability["cases"])
        print(f"[stability] WARNING: {flaky_count} flaky assertion(s) detected", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
