# Spec 字段规范

Use this file when writing or reviewing a behavior test spec.

## Required fields

```json
{
  "skill": "target-skill",
  "cases": []
}
```

## Optional top-level fields

| Field | Default | Description |
|---|---|---|
| `backend` | `codex` | 执行后端：`codex`、`hermes` 或 `claude_code` |
| `level` | `auto` | 手动固定迭代层级：`auto`（从 L1 起逐层解锁）/ `L1`（只做行为检查）/ `L2`（直接进质量评估，隐含 `quality.iterate: true`）/ `L3`（直接进提升探索，隐含 `aspiration.enabled: true`）。只改起点/上限，不豁免采纳判定——进 L2/L3 前 L1 仍须全通过 |
| `timeout` | `240` | Per-turn timeout in seconds |
| `agent_max_turns` | `20` | Agent 单次运行的最大推理步数（tool call 循环上限） |
| `toolsets` | — | Toolsets passed to `hermes chat --toolsets` (Hermes only) |
| `preload_skill` | `true` | Load the target skill before the first turn (Hermes only) |
| `related_skills` | `[]` | Extra skills to copy into the temp home |
| `model` | — | Model name; passed as `--model` (Hermes) or `-m` (Codex) |
| `provider` | — | Provider name; passed as `--provider` (Hermes only) |
| `judge_backend` | tested backend | 用于 `semantic` / `not_semantic` 断言的评审后端；未指定时使用被测后端 |
| `gate` | 见下 | 多维度采纳判定阈值覆盖（`min_delta` / `max_token_increase` / `min_stability` / `noise_threshold`），详见 [gate-and-memory.md](gate-and-memory.md) |
| `aspiration` | 未启用 | 提升探索配置；`enabled` 控制是否进入 L3，`discoverer_prompt` 提供可选探索方向，由迭代流程读取 |
| `memory` | `true` | 是否写跨迭代记忆到 `test/memory/`（results.tsv / experiments.jsonl / best_versions），详见 [gate-and-memory.md](gate-and-memory.md) |
| `conversation_mode` | `native_session` | 会话策略：`native_session` = 真实多轮对话续接；`isolated` = 每轮独立进程 |
| `command_template` | backend default | Command template for Codex/Claude Code backends |
| `inherit_runtime_config` | `true` | Inherit config/credentials from the real backend home |

## Optional case-level fields

| Field | Description |
|---|---|
| `id` | Case identifier (used in reports) |
| `turns` | List of user prompt strings, executed in order |
| `assertions` | List of assertion objects |
| `model` / `provider` | Override top-level model/provider for this case |
| `timeout` | Override top-level timeout for this case |
| `conversation_mode` | Override top-level conversation mode for this case |

## Command template tokens

- `{prompt}`: current user prompt
- `{skill}`: target skill name
- `{home}`: temporary backend home path
- `{model}`: selected model, if any
- `{session_id}`: backend session id, if the adapter has captured one

## Backend default command templates

| Backend | Default template |
|---|---|
| `hermes` | native `hermes chat -q` (not a command template) |
| `codex` | `["codex", "exec", "--dangerously-bypass-approvals-and-sandbox", "{prompt}"]` |
| `claude_code` | `["claude", "-p", "--dangerously-skip-permissions", "{prompt}"]` |

The default Codex and Claude Code adapters use native session resume when no
`command_template` is supplied:

| Backend | Native first turn | Native later turns |
|---|---|---|
| `codex` | `codex exec --json --dangerously-bypass-approvals-and-sandbox <prompt>` | `codex exec resume --json --dangerously-bypass-approvals-and-sandbox <thread_id> <prompt>` |
| `claude_code` | `claude -p --output-format json --dangerously-skip-permissions --session-id <uuid> <prompt>` | `claude -p --output-format json --dangerously-skip-permissions --resume <uuid> <prompt>` |

Set `conversation_mode` to `isolated` or provide `command_template` to preserve
the older independent-process behavior.

## Assertion types

| Type | Required fields | Notes |
|---|---|---|
| `exit_code` | `value` | Integer exit code of the last turn |
| `contains` | `target`, `value` | Literal substring match |
| `not_contains` | `target`, `value` | Literal substring absence |
| `regex` | `target`, `pattern` | `re.search` with `DOTALL`; one layer of JSON escaping |
| `not_regex` | `target`, `pattern` | Absence of regex match |
| `semantic` | `target`, `rubric` | LLM judge through `judge_backend` or the tested backend by default |
| `not_semantic` | `target`, `rubric` | Negated LLM judge through `judge_backend` or the tested backend by default |
| `tool_called` | `name` | Tool name appears in transcript/stdout heuristic |
| `tool_not_called` | `name` | Tool name absent from transcript/stdout |

`target` values: `stdout`, `stderr`, `transcript`, `final_text`, `agent_messages`, `last_agent_message`, `all`

Prefer `final_text` / `agent_messages` for user-visible behavior checks on Codex JSON streams. `stdout` remains the raw event log and is easy to overfit with brittle regexes.

## Quality evaluation (optional)

The `quality` top-level field enables a post-behavior quality evaluation layer.
It only runs for cases where **all behavior assertions pass**, adding zero cost
to failing cases.

```json
{
  "quality": {
    "enabled": true,
    "dimensions": ["correctness", "completeness", "format"],
    "rubrics": {
      "correctness": "All factual claims in the output are derivable from the input",
      "completeness": "All sub-tasks requested by the user are addressed",
      "format": "Output matches the template defined in SKILL.md"
    },
    "claim_extraction": true,
    "eval_critique": true,
    "judge_model": null,
    "baseline": null
  }
}
```

| Field | Default | Description |
|---|---|---|
| `enabled` | `false` | Master switch for quality evaluation |
| `dimensions` | `[]` | List of quality dimension names to grade |
| `rubrics` | `{}` | Map of dimension name → grading criterion text |
| `claim_extraction` | `false` | 提取输出中的事实性声明并逐一核查 |
| `eval_critique` | `false` | 让 judge 自检当前 spec 断言本身的质量和覆盖度 |
| `judge_model` | — | Override model for quality judge calls |
| `baseline` | `null` | Baseline comparison config (see below) |
| `thresholds` | `null` | Quality threshold config (see below) |
| `iterate` | `false` | Enable quality iteration when thresholds not met |
| `max_candidate_chars` | `20000` | Max chars of extracted candidate text sent to quality judges |
| `max_iterations` | `2` | Max quality iteration attempts (1-5) |

### Baseline comparison (optional)

```json
{
  "baseline": {
    "mode": "without_skill",
    "runs": 1
  }
}
```

| Mode | Description |
|---|---|
| `null` | No baseline (default, zero extra cost) |
| `"without_skill"` | Run same prompts without loading the target skill |
| `"previous_version"` | Run same prompts with the previous git version of the skill |

### Quality thresholds (optional)

```json
{
  "thresholds": {
    "min_score": 4,
    "min_mean": 3.5,
    "per_dimension": {
      "correctness": 5
    }
  }
}
```

| Field | Default | Description |
|---|---|---|
| `min_score` | — | Every dimension must score at least this (1-5) |
| `min_mean` | — | Mean score across all dimensions must meet this |
| `per_dimension` | `{}` | Per-dimension minimum overrides (takes priority over `min_score`) |

When thresholds are configured, the quality report includes `threshold_passed` (bool) and `threshold_failures` (list of reasons). Set `iterate: true` to have the agent auto-patch the skill when thresholds are not met.

### Stability runner

Run the harness multiple times for statistical stability analysis:

```bash
python3 stability.py [spec] --skill <name> --scenario <scenario> --runs 3 [--case <id>] [--assertions-only]
```

Output is a stability report with per-assertion `pass_rate` and `classification`:
- `stable_pass`（≥0.9）/ `mostly_pass`（0.7–<0.9）/ `flaky`（0.3–0.7）/ `mostly_fail`（>0.1–<0.3）/ `stable_fail`（≤0.1）

Exit codes: 0=stable, 1=error, 2=flaky detected.

### Human-in-the-loop mode

Run the harness with human intervention for ambiguous cases:

```bash
python3 humanloop.py [spec] --skill <name> --scenario <scenario> --runs 3
```

Triggers for human input:
- 语义断言 pass_rate 在 0.3–0.7（`flaky`）
- 质量维度得分等于阈值或低于阈值 1 分
- Behavior iteration exhausted (3x failed)
- Baseline delta negative (regression)

User decisions are saved to `clarifications.json`:

```json
[
  {
    "trigger": "quality_borderline",
    "case_id": "first-turn-must-diagnose",
    "choice": "1",
    "clarification": "小红书文案要像跟朋友聊天，用口语化表达",
    "detail": "tone: score 3 is at/near threshold 4",
    "timestamp": "2026-06-02T15:30:00"
  }
]
```

评分标准逐步明确：当用户针对 `quality_borderline` 触发器选择“提高标准”并提供补充文本时，文本会追加到该维度的 `quality.rubrics`，以便后续评审标准更明确。

### Quality report output

When quality evaluation runs, each case in the report gains a `quality` field:

```json
{
  "quality": {
    "grades": {
      "correctness": {"dimension": "correctness", "score": 5, "evidence": "...", "gaps": ""},
      "completeness": {"dimension": "completeness", "score": 4, "evidence": "...", "gaps": "missing edge case"}
    },
    "claims": [
      {"text": "The API supports batch operations", "status": "unverified", "reason": "not confirmed in context"}
    ],
    "eval_feedback": {
      "weak_assertions": ["regex assertion always passes on any output"],
      "missing_coverage": ["no assertion for error handling path"],
      "suggestions": ["add not_contains for forbidden output patterns"]
    },
    "threshold_passed": false,
    "threshold_failures": ["completeness: score 4 < 5 (gaps: missing edge case)"]
  }
}
```

The top-level report also includes:
- `"quality_passed": true|false` — aggregate: all behaviorally-passing cases meet quality thresholds

## 采纳判定配置（可选）

顶层 `gate` 字段覆盖多维度采纳判定的默认阈值。省略则用默认值。判定逻辑见 [gate-and-memory.md](gate-and-memory.md)。

```json
{
  "gate": {
    "min_delta": 0.02,
    "max_token_increase": 0.20,
    "min_stability": 0.8,
    "noise_threshold": 0.01
  }
}
```

| 字段 | 默认 | 含义 |
|------|------|------|
| `min_delta` | 0.02 | 质量最小提升幅度（低于此不算提升） |
| `max_token_increase` | 0.20 | token 使用量最多增加 20% |
| `min_stability` | 0.8 | 采纳判定使用的多次运行 pass_rate 下限；它不同于 `stable_pass` 的分类阈值 0.9 |
| `noise_threshold` | 0.01 | 小于此幅度的变化视为噪声 |


## Replay / filter flags (harness CLI)

| Flag | Meaning |
|---|---|
| `--case <id>` | Run/replay only selected case ids (repeatable or comma-separated) |
| `--replay-report <path>` | Re-evaluate using trajectories stored in an existing report |
| `--assertions-only` | Skip quality evaluation |
| `--quality-only` | With `--replay-report`, recompute quality from stored trajectories |


## Report naming

Default report filenames are derived from the **spec file stem** and evaluation level:

| Level | Default name |
|---|---|
| L1 | `<spec-stem>-l1-report.json` |
| L2 | `<spec-stem>-l2-report.json` |
| L3 | `<spec-stem>-l3-report.json` |

Example: `article-analysis-behavior.json` -> `article-analysis-behavior-l2-report.json`.

Use CLI `--level L1|L2|L3` to force the level used for naming and run mode. Prefer hyphenated spec names for new specs.
