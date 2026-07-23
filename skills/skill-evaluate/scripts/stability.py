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

from dynamic_skill_behavior_harness import (
    default_report_name,
    load_spec,
    resolve_eval_level,
    spec_basename,
    main as harness_main,
)


def parse_args() -> argparse.Namespace:
    ap = argparse.ArgumentParser(
        description="Run behavior harness multiple times for stability analysis"
    )
    ap.add_argument("spec", type=Path, nargs="?", help="Spec JSON path")
    ap.add_argument("--skill", help="Target skill name")
    ap.add_argument("--scenario", default="behavior")
    ap.add_argument("--level", default=None, help="L1|L2|L3|auto for report naming / harness pass-through")
    ap.add_argument("--backend", default="codex")
    ap.add_argument("--runs", type=int, default=3, help="Number of harness runs (default: 3)")
    ap.add_argument("--out", type=Path, help="Stability report output path")
    ap.add_argument("--keep-home", action="store_true")
    ap.add_argument(
        "--case",
        action="append",
        default=[],
        help="Only run these case ids (passed through to the harness). Repeatable or comma-separated.",
    )
    ap.add_argument(
        "--assertions-only",
        action="store_true",
        help="Skip quality evaluation during stability runs.",
    )
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
    case_filters: list[str] | None = None,
    assertions_only: bool = False,
    level: str | None = None,
    out_path: Path | None = None,
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
    for raw in case_filters or []:
        cmd += ["--case", raw]
    if assertions_only:
        cmd.append("--assertions-only")
    if level:
        cmd += ["--level", str(level)]
    if out_path is not None:
        cmd += ["--out", str(out_path)]

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
        quality_infra_count = 0
        quality_present = 0
        for report in reports:
            case_data = next((c for c in report.get("cases", []) if c["id"] == case_id), None)
            if not case_data or not case_data.get("quality"):
                continue
            quality_present += 1
            q = case_data["quality"]
            if q.get("infra_failed"):
                quality_infra_count += 1
            grades = q.get("grades") or {}
            for dim, grade in grades.items():
                # Only aggregate successfully judged scores; parse/timeout errors are infra noise.
                if grade.get("judge_status", "ok") != "ok":
                    continue
                try:
                    quality_scores.setdefault(dim, []).append(int(grade["score"]))
                except Exception:
                    continue

        quality_stats: dict[str, dict[str, float]] = {}
        for dim, scores in quality_scores.items():
            mean = sum(scores) / len(scores)
            variance = sum((s - mean) ** 2 for s in scores) / max(len(scores) - 1, 1) if len(scores) > 1 else 0.0
            quality_stats[dim] = {
                "mean": round(mean, 2),
                "std": round(variance ** 0.5, 2),
                "min": min(scores),
                "max": max(scores),
                "n": len(scores),
            }

        case_stability.append({
            "id": case_id,
            "case_pass_rate": round(case_pass_count / n, 3),
            "assertions": assertion_stats,
            "quality_stats": quality_stats if quality_stats else None,
            "quality_infra_rate": round(quality_infra_count / quality_present, 3) if quality_present else None,
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


def resolve_default_out(args: argparse.Namespace, *, spec_stem: str | None = None, level: str = "L1") -> Path | None:
    """Resolve default stability summary path to <target-skill>/test/reports/."""
    if args.out:
        return args.out
    stem = spec_stem or (f"{args.skill}-{args.scenario}" if args.skill else None)
    if not stem and args.spec:
        stem = Path(args.spec).stem
    if args.skill:
        from backends import get_backend
        backend = get_backend(args.backend)
        try:
            test_root = backend.target_test_root({"skill": args.skill})
            level_slug = (level or "L1").lower()
            name = f"{stem}-{level_slug}-stability.json" if stem else f"{args.skill}-{args.scenario}-{level_slug}-stability.json"
            return test_root / "reports" / name
        except FileNotFoundError:
            pass
    if stem:
        level_slug = (level or "L1").lower()
        return Path(f"{stem}-{level_slug}-stability.json")
    return None


def main() -> int:
    args = parse_args()
    reports: list[dict[str, Any]] = []

    # Resolve naming stem/level up front so every run lands in a predictable path.
    if args.spec:
        spec_path = Path(args.spec)
        spec = load_spec(spec_path) if spec_path.exists() else {}
        report_stem = spec_basename(spec_path)
    else:
        spec = {"skill": args.skill, "level": args.level}
        if args.assertions_only:
            # keep inference consistent with harness
            pass
        report_stem = f"{args.skill}-{args.scenario}" if args.skill else "unknown-spec"
        # Try load default hyphen/underscore later only if skill path known; optional.
        if args.skill:
            try:
                from backends import get_backend
                backend = get_backend(args.backend)
                test_root = backend.target_test_root({"skill": args.skill})
                from dynamic_skill_behavior_harness import default_spec_path
                spec_path = default_spec_path(test_root, args.skill, args.scenario)
                if spec_path.exists():
                    spec = load_spec(spec_path)
                    report_stem = spec_basename(spec_path)
            except Exception:
                pass

    eval_level = resolve_eval_level(
        spec if isinstance(spec, dict) else {},
        assertions_only=args.assertions_only,
        quality_only=False,
        cli_level=args.level,
    )

    # Per-run report files: <stem>-lN-stability-run{i}-report.json under skill reports when possible.
    run_out_dir = None
    if args.skill:
        try:
            from backends import get_backend
            backend = get_backend(args.backend)
            run_out_dir = backend.target_test_root({"skill": args.skill}) / "reports"
            run_out_dir.mkdir(parents=True, exist_ok=True)
        except Exception:
            run_out_dir = None

    for i in range(args.runs):
        print(f"[stability] Run {i + 1}/{args.runs}...", file=sys.stderr)
        run_out = None
        if run_out_dir is not None:
            run_out = run_out_dir / default_report_name(
                f"{report_stem}-stability-run{i+1}",
                eval_level,
            )
        report = run_harness_once(
            spec_path=args.spec,
            skill=args.skill,
            scenario=args.scenario,
            backend=args.backend,
            keep_home=args.keep_home,
            run_index=i,
            case_filters=args.case,
            assertions_only=args.assertions_only,
            level=eval_level,
            out_path=run_out,
        )
        if report:
            reports.append(report)

    if not reports:
        print("[stability] All runs failed to produce reports", file=sys.stderr)
        return 1

    stability = aggregate_runs(reports)
    stability["timestamp"] = time.strftime("%Y-%m-%dT%H:%M:%S")
    stability["spec"] = str(args.spec) if args.spec else f"{args.skill}-{args.scenario}"
    stability["spec_stem"] = report_stem
    stability["eval_level"] = eval_level
    if args.case:
        stability["case_filter"] = args.case
    stability["assertions_only"] = bool(args.assertions_only)

    output = json.dumps(stability, ensure_ascii=False, indent=2)
    out_path = resolve_default_out(args, spec_stem=report_stem, level=eval_level)
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
