# Spec schema

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
| `backend` | `hermes` | `hermes`, `codex`, or `claude_code` |
| `timeout` | `240` | Per-turn timeout in seconds |
| `agent_max_turns` | `20` | Max agent turns per run |
| `toolsets` | — | Toolsets passed to `hermes chat --toolsets` (Hermes only) |
| `preload_skill` | `true` | Load the target skill before the first turn (Hermes only) |
| `related_skills` | `[]` | Extra skills to copy into the temp home |
| `model` | — | Model name; passed as `--model` (Hermes) or `-m` (Codex) |
| `provider` | — | Provider name; passed as `--provider` (Hermes only) |
| `judge_backend` | tested backend | Backend used for `semantic`/`not_semantic` assertions; set only when judging with a different backend |
| `conversation_mode` | `native_session` | `native_session` for real multi-turn resume; `isolated` for independent one-prompt processes |
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

`target` values: `stdout`, `stderr`, `transcript`, `all`

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
| `claim_extraction` | `false` | Extract and verify factual claims in output |
| `eval_critique` | `false` | Have the judge critique the test assertions themselves |
| `judge_model` | — | Override model for quality judge calls |
| `baseline` | `null` | Baseline comparison config (see below) |

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
    }
  }
}
```
