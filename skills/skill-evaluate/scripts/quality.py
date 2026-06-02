"""Quality evaluation layer for skill behavior tests.

Runs after all behavior assertions pass. Evaluates output quality through
multi-dimensional grading, claim extraction, and eval self-critique.

This module reuses the existing judge_backend infrastructure (semantic judge)
rather than introducing separate agent processes.
"""

from __future__ import annotations

import json
import re
from dataclasses import asdict, dataclass, field
from typing import Any


@dataclass
class DimensionGrade:
    dimension: str
    score: int  # 1-5
    evidence: str
    gaps: str = ""


@dataclass
class Claim:
    text: str
    status: str  # "verified" | "unverified" | "false"
    reason: str = ""


@dataclass
class EvalFeedback:
    weak_assertions: list[str] = field(default_factory=list)
    missing_coverage: list[str] = field(default_factory=list)
    suggestions: list[str] = field(default_factory=list)


@dataclass
class QualityReport:
    grades: list[DimensionGrade] = field(default_factory=list)
    claims: list[Claim] = field(default_factory=list)
    eval_feedback: EvalFeedback | None = None
    baseline_delta: dict[str, Any] | None = None
    threshold_passed: bool | None = None
    threshold_failures: list[str] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        result: dict[str, Any] = {}
        if self.grades:
            result["grades"] = {g.dimension: asdict(g) for g in self.grades}
        if self.claims:
            result["claims"] = [asdict(c) for c in self.claims]
        if self.eval_feedback:
            result["eval_feedback"] = asdict(self.eval_feedback)
        if self.baseline_delta:
            result["baseline_delta"] = self.baseline_delta
        if self.threshold_passed is not None:
            result["threshold_passed"] = self.threshold_passed
            result["threshold_failures"] = self.threshold_failures
        return result


def _parse_json_from_text(text: str) -> dict[str, Any] | None:
    """Extract first JSON object from text that may contain markdown or prose."""
    match = re.search(r"\{.*\}", text, re.S)
    if not match:
        return None
    try:
        return json.loads(match.group(0))
    except Exception:
        return None


def _grade_prompt(dimension: str, rubric: str, output_text: str) -> str:
    return (
        "You are a quality evaluator for agent skill outputs. "
        "Return only JSON, no markdown or explanation outside JSON.\n\n"
        f"Evaluate the following dimension: {dimension}\n"
        f"Criterion: {rubric}\n\n"
        "Score from 1 (completely fails) to 5 (fully satisfies).\n"
        "Required format: {\"score\": <1-5>, \"evidence\": \"what supports this score\", "
        "\"gaps\": \"what is missing or wrong, empty string if none\"}\n\n"
        f"Candidate output:\n{output_text[:10000]}\n"
    )


def _claim_prompt(output_text: str) -> str:
    return (
        "You are a fact-checker for agent skill outputs. "
        "Return only a JSON array, no markdown or explanation outside JSON.\n\n"
        "Extract all factual claims from the output below. For each claim, "
        "determine if it can be verified from the output context alone.\n\n"
        "Required format: [{\"text\": \"the claim\", \"status\": \"verified|unverified|false\", "
        "\"reason\": \"why this status\"}]\n\n"
        "Rules:\n"
        "- Only extract objective factual statements, not opinions or instructions\n"
        "- 'verified' = clearly supported by the input/context\n"
        "- 'unverified' = cannot confirm from available context\n"
        "- 'false' = contradicted by available context\n"
        "- Maximum 10 claims\n\n"
        f"Candidate output:\n{output_text[:10000]}\n"
    )


def _critique_prompt(
    spec_assertions: list[dict[str, Any]],
    grades: list[DimensionGrade],
) -> str:
    assertions_text = json.dumps(spec_assertions, ensure_ascii=False, indent=2)
    grades_text = "\n".join(
        f"- {g.dimension}: {g.score}/5 (gaps: {g.gaps or 'none'})"
        for g in grades
    )
    return (
        "You are a test quality reviewer. Analyze the behavior assertions and "
        "quality grades below, then identify weaknesses in the test design.\n"
        "Return only JSON, no markdown or explanation outside JSON.\n\n"
        "Required format: {\"weak_assertions\": [\"description of weak assertion\"], "
        "\"missing_coverage\": [\"what is not tested\"], "
        "\"suggestions\": [\"how to improve\"]}\n\n"
        f"Behavior assertions:\n{assertions_text}\n\n"
        f"Quality grades:\n{grades_text}\n"
    )


def _grade_dimensions(
    output_text: str,
    quality_config: dict[str, Any],
    judge_backend,
    judge_env: dict[str, str],
    timeout: int,
) -> list[DimensionGrade]:
    """Grade output text across all configured dimensions. Returns list of grades."""
    grades: list[DimensionGrade] = []
    rubrics = quality_config.get("rubrics", {})
    for dimension in quality_config.get("dimensions", []):
        rubric = rubrics.get(dimension, dimension)
        prompt = _grade_prompt(dimension, rubric, output_text)
        assertion_obj = {"rubric": prompt, "judge_model": quality_config.get("judge_model")}
        ok, reason = judge_backend.run_semantic_judge(assertion_obj, "", judge_env, timeout)
        parsed = _parse_json_from_text(reason)
        if parsed and "score" in parsed:
            grades.append(DimensionGrade(
                dimension=dimension,
                score=int(parsed["score"]),
                evidence=str(parsed.get("evidence", "")),
                gaps=str(parsed.get("gaps", "")),
            ))
        else:
            grades.append(DimensionGrade(
                dimension=dimension,
                score=3,
                evidence=f"judge response unparseable: {reason[:200]}",
                gaps="quality judge did not return structured JSON",
            ))
    return grades


def compute_baseline_delta(
    with_skill_grades: list[DimensionGrade],
    baseline_grades: list[DimensionGrade],
) -> dict[str, Any]:
    """Compute score delta between with-skill and baseline grades.

    Returns a dict with per-dimension deltas and an overall summary.
    """
    skill_map = {g.dimension: g.score for g in with_skill_grades}
    base_map = {g.dimension: g.score for g in baseline_grades}
    dimensions: dict[str, Any] = {}
    total_delta = 0
    count = 0
    for dim in skill_map:
        skill_score = skill_map[dim]
        base_score = base_map.get(dim, 3)  # default 3 if baseline didn't grade this
        delta = skill_score - base_score
        dimensions[dim] = {
            "with_skill": skill_score,
            "baseline": base_score,
            "delta": delta,
        }
        total_delta += delta
        count += 1
    return {
        "dimensions": dimensions,
        "mean_delta": round(total_delta / max(count, 1), 2),
        "improved": sum(1 for d in dimensions.values() if d["delta"] > 0),
        "degraded": sum(1 for d in dimensions.values() if d["delta"] < 0),
        "unchanged": sum(1 for d in dimensions.values() if d["delta"] == 0),
    }


def quality_meets_thresholds(
    report: QualityReport,
    thresholds: dict[str, Any],
) -> tuple[bool, list[str]]:
    """Check whether quality grades meet configured thresholds.

    Args:
        report: The QualityReport from run_quality_evaluation
        thresholds: Dict with optional keys:
            - min_score: int (1-5), every dimension must meet this
            - min_mean: float, mean of all dimensions must meet this
            - per_dimension: dict[str, int], per-dimension minimums

    Returns:
        (passed, failures) where failures is a list of human-readable reasons
    """
    if not report.grades:
        return True, []

    failures: list[str] = []
    min_score = thresholds.get("min_score")
    min_mean = thresholds.get("min_mean")
    per_dim = thresholds.get("per_dimension", {})

    scores = [g.score for g in report.grades]
    mean = sum(scores) / len(scores)

    if min_score is not None:
        for g in report.grades:
            dim_min = per_dim.get(g.dimension, min_score)
            if g.score < dim_min:
                failures.append(
                    f"{g.dimension}: score {g.score} < {dim_min}"
                    f" (gaps: {g.gaps or 'none'})"
                )
    else:
        for dim, required in per_dim.items():
            for g in report.grades:
                if g.dimension == dim and g.score < required:
                    failures.append(
                        f"{g.dimension}: score {g.score} < per_dimension minimum {required}"
                    )

    if min_mean is not None and mean < min_mean:
        failures.append(f"mean score {mean:.2f} < min_mean {min_mean}")

    return len(failures) == 0, failures


def run_quality_evaluation(
    blob: dict[str, str],
    quality_config: dict[str, Any],
    case_assertions: list[dict[str, Any]],
    judge_backend,
    judge_env: dict[str, str],
    timeout: int,
    baseline_blob: dict[str, str] | None = None,
) -> QualityReport:
    """Run quality evaluation on a case that passed all behavior assertions.

    Args:
        blob: The captured output blob (stdout, stderr, transcript, etc.)
        quality_config: The "quality" section from the spec
        case_assertions: The behavior assertions from the case (for critique)
        judge_backend: Backend instance to use for LLM judge calls
        judge_env: Environment dict for the judge backend
        timeout: Timeout in seconds for each judge call
        baseline_blob: Optional baseline output blob for comparison

    Returns:
        QualityReport with grades, claims, eval feedback, and optional baseline delta
    """
    report = QualityReport()
    output_text = blob.get("stdout", "") + "\n" + blob.get("transcript", "")

    # Phase 1: Multi-dimensional grading
    report.grades = _grade_dimensions(output_text, quality_config, judge_backend, judge_env, timeout)

    # Phase 2: Claim extraction (optional)
    if quality_config.get("claim_extraction", False):
        prompt = _claim_prompt(output_text)
        assertion_obj = {"rubric": prompt, "judge_model": quality_config.get("judge_model")}
        ok, reason = judge_backend.run_semantic_judge(assertion_obj, "", judge_env, timeout)
        array_match = re.search(r"\[.*\]", reason, re.S)
        if array_match:
            try:
                claims_data = json.loads(array_match.group(0))
                for item in claims_data[:10]:
                    if isinstance(item, dict) and "text" in item:
                        report.claims.append(Claim(
                            text=str(item["text"]),
                            status=str(item.get("status", "unverified")),
                            reason=str(item.get("reason", "")),
                        ))
            except Exception:
                pass

    # Phase 3: Eval self-critique (optional)
    if quality_config.get("eval_critique", False) and report.grades:
        prompt = _critique_prompt(case_assertions, report.grades)
        assertion_obj = {"rubric": prompt, "judge_model": quality_config.get("judge_model")}
        ok, reason = judge_backend.run_semantic_judge(assertion_obj, "", judge_env, timeout)
        parsed = _parse_json_from_text(reason)
        if parsed:
            report.eval_feedback = EvalFeedback(
                weak_assertions=parsed.get("weak_assertions", []),
                missing_coverage=parsed.get("missing_coverage", []),
                suggestions=parsed.get("suggestions", []),
            )

    # Phase 4: Baseline comparison (optional)
    if baseline_blob is not None and report.grades:
        baseline_text = baseline_blob.get("stdout", "") + "\n" + baseline_blob.get("transcript", "")
        baseline_grades = _grade_dimensions(baseline_text, quality_config, judge_backend, judge_env, timeout)
        report.baseline_delta = compute_baseline_delta(report.grades, baseline_grades)

    # Phase 5: Threshold checking (optional)
    thresholds = quality_config.get("thresholds")
    if thresholds and report.grades:
        passed, failures = quality_meets_thresholds(report, thresholds)
        report.threshold_passed = passed
        report.threshold_failures = failures

    return report
