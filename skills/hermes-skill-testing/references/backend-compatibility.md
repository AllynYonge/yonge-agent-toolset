# Backend compatibility notes

Use this note to keep Hermes, Codex, and Claude Code behavior tests aligned.

## Recommended split

- Keep assertions backend-agnostic.
- Keep CLI invocation differences inside backend adapters.
- Use `command_template` only when a backend does not expose a stable non-interactive mode in code.

## Default assumptions

- `hermes` backend remains the canonical implementation.
- `codex` backend defaults to native session mode: `codex exec --json {prompt}` then `codex exec resume <thread_id> {prompt}`.
- `claude_code` backend defaults to native session mode: `claude -p --session-id <uuid> {prompt}` then `claude -p --resume <uuid> {prompt}`.
- Use `judge_backend` if you want semantic assertions to run through a different backend than the tested one.
- Use `conversation_mode: "isolated"` only when a test intentionally needs independent one-prompt processes or a custom `command_template`.

## Maintenance rule

If a backend needs different session capture, add that logic to the adapter rather than the shared evaluator.

Native session adapters must record the active session id in `CaseState.session_id` so the report can show it under each turn.

## Claude Code — known constraints

### Slash command routing
`claude -p "/skill-name ..."` is intercepted by Claude Code's slash command router **before** the LLM sees the prompt. If the skill name does not match a registered skill, the CLI returns `"Unknown skill: <name>"` immediately.

**Consequence**: test prompts for claude_code must use natural language, not `/skill-name` prefixes. For example, use `"analyze my Obsidian notes"` instead of `"/wiki analyze my notes"`.

### Working directory sandbox
`claude -p` runs with a restricted working directory (the harness `cwd`). Paths outside that directory (e.g. `/tmp/...`) may be rejected with a permission/access error before the skill's gate logic can execute.

**Consequence**: test vault paths in specs must be absolute paths inside the harness working directory, or inside a directory that claude is allowed to access. Use a subdirectory of the harness `references/` folder as a test fixture (e.g. `references/test-vault/`) rather than `/tmp/` paths.

### Semantic judge
`claude_code` backend does not implement `run_semantic_judge`. Avoid `semantic`/`not_semantic` assertions in claude_code specs, or set `judge_backend: "hermes"` and ensure Hermes is available.
