# Skill-testing harness iteration notes

Use this reference when maintaining or extending `skill-testing`'s behavior harness.

## Semantic assertions

The harness supports LLM-judged assertions for cases where keyword/regex matching is insufficient:

```json
{
  "type": "semantic",
  "target": "stdout",
  "rubric": "输出必须先识别用户要发布的平台、素材类型和缺失信息；如果缺少必要信息，应等待确认，而不是直接生成最终发布文案。"
}
```

Implementation pattern:
- `semantic` / `not_semantic` call the selected judge backend's judge turn. If the spec omits `judge_backend`, the tested backend judges its own output.
- The judge prompt must demand strict JSON: `{"passed": true|false, "reason": "..."}`.
- Treat semantic assertions as quality/meaning checks, not the sole guard for critical gates; pair them with deterministic `contains` / `regex` / `not_regex` assertions where possible.
- Expect extra LLM cost and some nondeterminism.

## Backend templates

The harness now dispatches through backend adapters:

- `hermes` uses the native `hermes chat -q` flow.
- `codex` uses native non-interactive resume by default: first turn parses `thread.started.thread_id` from `codex exec --json`, later turns call `codex exec resume <thread_id>`.
- `claude_code` uses native non-interactive resume by default: first turn passes a generated `--session-id <uuid>`, later turns pass `--resume <uuid>`.
- `codex` and `claude_code` fall back to spec-driven `command_template` execution only when `conversation_mode` is `isolated` or a custom `command_template` is present.
- Keep backend-specific behavior out of cases; put it in the adapter or the top-level spec.

Adapter files live in `scripts/backends/`. The main harness is `scripts/dynamic_skill_behavior_harness.py`. Always run the harness from the `scripts/` directory so the `backends` package import resolves correctly.

## Target-skill `test/` artifact layout

Artifacts for a skill behavior test belong under the **target skill being tested**, not under the `skill-testing` skill that owns the harness.

Canonical layout:

```text
<target-skill>/
├── SKILL.md
└── test/
    ├── specs/<skill>_<scenario>.json
    ├── reports/<skill>_<scenario>_report.json
    └── tmp/<backend>-behavior-<timestamp>-<pid>/
```

Implementation implications:
- Resolve the target skill directory from `spec["skill"]` under `$HERMES_HOME/skills`.
- If the CLI is invoked with `--skill <name> --scenario <scenario>`, default to:
  - spec: `<target-skill>/test/specs/<name>_<scenario>.json`
  - report: `<target-skill>/test/reports/<name>_<scenario>_report.json`
  - temp home: `<target-skill>/test/tmp/<backend>-behavior-.../`
- If a relative `spec` or `--out` path is provided together with `--skill`, resolve it relative to `<target-skill>/test/`, not relative to the harness directory or current working directory.
- `copy_skill_tree()` must exclude `test/` as well as `tmp/`, `__pycache__/`, and `*.pyc`; otherwise test artifacts are copied into the sandbox and may recurse or pollute the behavior under test.

Known-good copy pattern:

```python
shutil.copytree(
    skill_src,
    dst,
    ignore=shutil.ignore_patterns("test", "tmp", "__pycache__", "*.pyc"),
)
```

## Model/provider selection for speed

`hermes chat -q` supports model selection directly:

```bash
hermes chat -q "..." --model <model> --provider <provider>
# or: hermes chat -q "..." -m <model> --provider <provider>
```

Harness specs should support this at three levels:
- top-level `model` / `provider`: default for all tested cases;
- per-case `model` / `provider`: overrides the top-level values for that case;
- semantic assertion `judge_model` / `judge_provider`: separate model/provider for the LLM judge. `judge_provider` is currently Hermes-specific; Codex and Claude Code use `judge_model`.

Use this to run cheap/fast smoke tests without changing the user's global Hermes config.


## Session-file isolation verification

The harness uses one temporary `HERMES_HOME` per harness run and isolates cases by session-file set difference: snapshot `sessions/` before a case, then read only newly created files after the case.

This depends on an operational assumption: independent `hermes chat -q ...` invocations without `--resume` create new session files instead of appending to existing files.

A probe run on the active Hermes (`/root/.local/bin/hermes` -> `/root/hermes-agent/venv/bin/hermes`, Hermes Agent v0.12.0, 2026-05-05) confirmed:

```text
new_after_first = ['sessions/session_20260505_141836_82aea9.json']
new_after_second = ['sessions/session_20260505_141844_b4edb9.json']
changed_existing_after_second = []
```

If a future Hermes changes session storage to append/reuse files across independent invocations, replace diff-set isolation with per-case `HERMES_HOME` directory isolation.


## Stability runner

`scripts/stability.py` runs the harness N times and aggregates per-assertion pass rates.

Key design decisions:
- Each run is a fresh subprocess (clean state, no shared temp homes)
- Scenario names get a `_stability_runN` suffix to avoid report filename collisions
- Flaky classification threshold is 0.3-0.7 pass rate — this range was chosen because semantic assertions using LLM judges typically exhibit variance in this band
- Exit code 2 (flaky detected) is distinct from 1 (error) so CI can distinguish "unstable but running" from "broken"
- Quality scores are aggregated with mean/std to surface judge consistency issues

When to use: before trusting a semantic assertion, run `--runs 3` minimum. If an assertion shows flaky classification, either tighten the rubric or replace with a deterministic assertion.


## Human-in-the-loop

`scripts/humanloop.py` wraps the harness (and optionally stability.py) with human checkpoints.

Architecture:
- humanloop.py does NOT modify the harness flow — it runs harness as a subprocess, inspects the report, and decides whether to pause
- Trigger detection is purely post-hoc (read report → check conditions → prompt if needed)
- User decisions are append-only in `clarifications.json`
- Rubric convergence: user text is appended to `spec.quality.rubrics[dimension]`, not replacing existing text

Trigger conditions and their rationale:
- `flaky_assertion`: judge can't decide consistently → human breaks the tie and refines the rubric
- `quality_borderline`: score at threshold boundary → could go either way, human sets direction
- `iteration_exhausted`: 3 auto-retries failed → human provides new diagnostic angle
- `baseline_regression`: skill made things worse → human decides if tradeoff is acceptable

The goal of humanloop is to converge quickly: each interaction refines the spec so the same trigger doesn't fire again on subsequent runs.


## Quality iteration

Quality iteration is a second loop that runs AFTER behavior assertions pass. It is controlled by `quality.iterate: true` in the spec.

Key invariants:
- Quality iteration NEVER modifies behavior assertions
- It only patches the target skill's guidance, examples, and templates
- If a quality patch causes behavior regression, it is immediately rolled back
- The loop terminates after `max_iterations` (default 2) attempts

The agent decision tree in SKILL.md governs quality iteration behavior. The harness itself does not implement the loop — it only provides the `threshold_passed` and `threshold_failures` data that the agent uses to decide whether to continue.

Separation of concerns:
- `quality.py` → evaluates and reports (passive)
- `SKILL.md` decision tree → tells the agent what to do with the report (active)
- `humanloop.py` → optionally inserts human judgment at ambiguous points
