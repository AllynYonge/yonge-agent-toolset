"""Quality evaluation layer for skill behavior tests.

Runs after all behavior assertions pass. Evaluates output quality through
multi-dimensional grading, claim extraction, and eval self-critique.

Judges are expected to return structured JSON objects. This module no longer
reuses the semantic-judge passed/reason protocol for scoring.
"""

from __future__ import annotations

import json
import re
from dataclasses import asdict, dataclass, field
from typing import Any


@dataclass
class DimensionGrade:
    dimension: str
    score: int  # 1-5, or 0 when judge failed
    evidence: str
    gaps: str = ""
    judge_status: str = "ok"  # ok | parse_error | timeout | error | empty_output


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
    candidate_text_chars: int = 0
    candidate_text_preview: str = ""
    judge_error_count: int = 0
    infra_failed: bool = False

    def to_dict(self) -> dict[str, Any]:
        result: dict[str, Any] = {
            "candidate_text_chars": self.candidate_text_chars,
            "candidate_text_preview": self.candidate_text_preview,
            "judge_error_count": self.judge_error_count,
            "infra_failed": self.infra_failed,
        }
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
    """Extract a JSON object from text that may contain markdown or prose."""
    if not text:
        return None
    try:
        obj = json.loads(text)
        if isinstance(obj, dict):
            return obj
    except Exception:
        pass
    matches = list(re.finditer(r"\{.*\}", text, re.S))
    for match in reversed(matches):
        try:
            obj = json.loads(match.group(0))
            if isinstance(obj, dict):
                return obj
        except Exception:
            continue
    return None


def _preview_text(text: str, limit: int = 500) -> str:
    text = (text or "").strip()
    if len(text) <= limit:
        return text
    head = text[: limit // 2]
    tail = text[-(limit // 2) :]
    return head + "\n...\n" + tail


def select_candidate_output(blob: dict[str, str], judge_backend=None) -> str:
    """Prefer backend-extracted user-visible text over raw event logs."""
    if judge_backend is not None and hasattr(judge_backend, "extract_candidate_output"):
        text = judge_backend.extract_candidate_output(blob)
        if text and text.strip():
            return text.strip()
    # Fallbacks for replay / backends without extractor
    for key in ("final_text", "agent_messages", "stdout"):
        val = (blob.get(key) or "").strip()
        if val:
            # If stdout looks like Codex JSONL, try a local extraction.
            if key == "stdout" and '"type":"item.completed"' in val:
                msgs = []
                for line in val.splitlines():
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
                    return "\n\n".join(msgs).strip()
            return val
    transcript = (blob.get("transcript") or "").strip()
    return transcript


def _grade_prompt(dimension: str, rubric: str, output_text: str, max_chars: int) -> str:
    return (
        "You are a quality evaluator for agent skill outputs. "
        "Return only JSON, no markdown or explanation outside JSON.\n\n"
        f"Evaluate the following dimension: {dimension}\n"
        f"Criterion: {rubric}\n\n"
        "Score from 1 (completely fails) to 5 (fully satisfies).\n"
        "Required format: {\"score\": <1-5>, \"evidence\": \"what supports this score\", "
        "\"gaps\": \"what is missing or wrong, empty string if none\"}\n\n"
        f"Candidate output:\n{output_text[:max_chars]}\n"
    )


def _claim_prompt(output_text: str, max_chars: int) -> str:
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
        f"Candidate output:\n{output_text[:max_chars]}\n"
    )


def _critique_prompt(
    spec_assertions: list[dict[str, Any]],
    grades: list[DimensionGrade],
) -> str:
    assertions_text = json.dumps(spec_assertions, ensure_ascii=False, indent=2)
    grades_text = "\n".join(
        f"- {g.dimension}: {g.score}/5 status={g.judge_status} (gaps: {g.gaps or 'none'})"
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


def _call_json_judge(
    prompt: str,
    judge_backend,
    judge_env: dict[str, str],
    timeout: int,
    judge_model: str | None,
) -> tuple[dict[str, Any] | None, str]:
    """Call backend JSON judge; fall back to semantic path only for infrastructure errors."""
    if hasattr(judge_backend, "run_json_judge"):
        return judge_backend.run_json_judge(
            prompt,
            judge_env,
            timeout,
            judge_model=judge_model,
        )
    # Fallback: some backends only implement semantic judge. We still ask for the
    # quality JSON in the prompt; parse from the returned reason/raw text.
    assertion_obj = {"rubric": prompt, "judge_model": judge_model}
    ok, reason = judge_backend.run_semantic_judge(assertion_obj, "", judge_env, timeout)
    parsed = _parse_json_from_text(reason)
    if parsed is not None:
        return parsed, "ok"
    return None, reason


def _grade_dimensions(
    output_text: str,
    quality_config: dict[str, Any],
    judge_backend,
    judge_env: dict[str, str],
    timeout: int,
) -> list[DimensionGrade]:
    """Grade output text across all configured dimensions."""
    grades: list[DimensionGrade] = []
    rubrics = quality_config.get("rubrics", {})
    max_chars = int(quality_config.get("max_candidate_chars", 20000))
    judge_model = quality_config.get("judge_model")
    for dimension in quality_config.get("dimensions", []):
        rubric = rubrics.get(dimension, dimension)
        prompt = _grade_prompt(dimension, rubric, output_text, max_chars)
        parsed, detail = _call_json_judge(prompt, judge_backend, judge_env, timeout, judge_model)
        if isinstance(parsed, dict) and "score" in parsed:
            try:
                score = int(parsed["score"])
            except Exception:
                score = 0
            score = max(0, min(5, score))
            grades.append(
                DimensionGrade(
                    dimension=dimension,
                    score=score,
                    evidence=str(parsed.get("evidence", "")),
                    gaps=str(parsed.get("gaps", "")),
                    judge_status="ok",
                )
            )
            continue

        status = "parse_error"
        detail_l = (detail or "").lower()
        if "timeout" in detail_l:
            status = "timeout"
        elif detail_l.startswith("judge exited") or "not supported" in detail_l:
            status = "error"
        grades.append(
            DimensionGrade(
                dimension=dimension,
                score=0,
                evidence=f"judge response unparseable: {(detail or '')[:300]}",
                gaps="quality judge did not return structured score JSON",
                judge_status=status,
            )
        )
    return grades


def compute_baseline_delta(
    with_skill_grades: list[DimensionGrade],
    baseline_grades: list[DimensionGrade],
) -> dict[str, Any]:
    """Compute score delta between with-skill and baseline grades."""
    skill_map = {g.dimension: g.score for g in with_skill_grades if g.judge_status == "ok"}
    base_map = {g.dimension: g.score for g in baseline_grades if g.judge_status == "ok"}
    dimensions: dict[str, Any] = {}
    total_delta = 0
    count = 0
    for dim in skill_map:
        if dim not in base_map:
            continue
        skill_score = skill_map[dim]
        base_score = base_map[dim]
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
        "mean_delta": round(total_delta / max(count, 1), 2) if count else 0.0,
        "improved": sum(1 for d in dimensions.values() if d["delta"] > 0),
        "degraded": sum(1 for d in dimensions.values() if d["delta"] < 0),
        "unchanged": sum(1 for d in dimensions.values() if d["delta"] == 0),
        "compared_dimensions": count,
    }


def quality_meets_thresholds(
    report: QualityReport,
    thresholds: dict[str, Any],
) -> tuple[bool, list[str]]:
    """Check whether quality grades meet configured thresholds.

    Judge infrastructure failures never count as a normal low score. If any
    dimension has judge_status != ok, thresholds fail closed with an infra reason.
    """
    if not report.grades:
        return True, []

    failures: list[str] = []
    infra = [g for g in report.grades if g.judge_status != "ok"]
    if infra:
        for g in infra:
            failures.append(
                f"{g.dimension}: judge_status={g.judge_status} (not scored; {g.gaps or g.evidence})"
            )
        return False, failures

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
    """Run quality evaluation on a case that passed all behavior assertions."""
    report = QualityReport()
    output_text = select_candidate_output(blob, judge_backend)
    report.candidate_text_chars = len(output_text)
    report.candidate_text_preview = _preview_text(output_text)

    if not output_text.strip():
        report.infra_failed = True
        report.judge_error_count = 1
        report.grades = [
            DimensionGrade(
                dimension=dim,
                score=0,
                evidence="candidate output empty after extraction",
                gaps="no user-visible agent text available for quality judging",
                judge_status="empty_output",
            )
            for dim in quality_config.get("dimensions", ["quality"])
        ]
        thresholds = quality_config.get("thresholds")
        if thresholds:
            passed, failures = quality_meets_thresholds(report, thresholds)
            report.threshold_passed = passed
            report.threshold_failures = failures
        return report

    # Phase 1: Multi-dimensional grading
    report.grades = _grade_dimensions(output_text, quality_config, judge_backend, judge_env, timeout)
    report.judge_error_count = sum(1 for g in report.grades if g.judge_status != "ok")
    report.infra_failed = report.judge_error_count > 0

    # Phase 2: Claim extraction (optional)
    if quality_config.get("claim_extraction", False) and not report.infra_failed:
        max_chars = int(quality_config.get("max_candidate_chars", 20000))
        prompt = _claim_prompt(output_text, max_chars)
        parsed, detail = _call_json_judge(
            prompt,
            judge_backend,
            judge_env,
            timeout,
            quality_config.get("judge_model"),
        )
        claims_data = None
        if isinstance(parsed, list):
            claims_data = parsed
        elif isinstance(parsed, dict) and isinstance(parsed.get("claims"), list):
            claims_data = parsed.get("claims")
        else:
            array_match = re.search(r"\[.*\]", detail or "", re.S)
            if array_match:
                try:
                    maybe = json.loads(array_match.group(0))
                    if isinstance(maybe, list):
                        claims_data = maybe
                except Exception:
                    claims_data = None
        if isinstance(claims_data, list):
            for item in claims_data[:10]:
                if isinstance(item, dict) and "text" in item:
                    report.claims.append(
                        Claim(
                            text=str(item["text"]),
                            status=str(item.get("status", "unverified")),
                            reason=str(item.get("reason", "")),
                        )
                    )

    # Phase 3: Eval self-critique (optional)
    if quality_config.get("eval_critique", False) and report.grades and not report.infra_failed:
        prompt = _critique_prompt(case_assertions, report.grades)
        parsed, detail = _call_json_judge(
            prompt,
            judge_backend,
            judge_env,
            timeout,
            quality_config.get("judge_model"),
        )
        if parsed is None:
            parsed = _parse_json_from_text(detail)
        if parsed:
            report.eval_feedback = EvalFeedback(
                weak_assertions=parsed.get("weak_assertions", []),
                missing_coverage=parsed.get("missing_coverage", []),
                suggestions=parsed.get("suggestions", []),
            )

    # Phase 4: Baseline comparison (optional)
    if baseline_blob is not None and report.grades and not report.infra_failed:
        baseline_text = select_candidate_output(baseline_blob, judge_backend)
        baseline_grades = _grade_dimensions(baseline_text, quality_config, judge_backend, judge_env, timeout)
        report.baseline_delta = compute_baseline_delta(report.grades, baseline_grades)

    # Phase 5: Threshold checking (optional)
    thresholds = quality_config.get("thresholds")
    if thresholds and report.grades:
        passed, failures = quality_meets_thresholds(report, thresholds)
        report.threshold_passed = passed
        report.threshold_failures = failures

    return report
