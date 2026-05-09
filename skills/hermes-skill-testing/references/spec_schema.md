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
| `judge_backend` | `hermes` | Backend used for `semantic`/`not_semantic` assertions |
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
| `semantic` | `target`, `rubric` | LLM judge; requires `judge_backend` to be available |
| `not_semantic` | `target`, `rubric` | Negated LLM judge |
| `tool_called` | `name` | Tool name appears in transcript/stdout heuristic |
| `tool_not_called` | `name` | Tool name absent from transcript/stdout |

`target` values: `stdout`, `stderr`, `transcript`, `all`
