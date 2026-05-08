# Backend compatibility notes

Use this note to keep Hermes, Codex, and Claude Code behavior tests aligned.

## Recommended split

- Keep assertions backend-agnostic.
- Keep CLI invocation differences inside backend adapters.
- Use `command_template` only when a backend does not expose a stable non-interactive mode in code.

## Default assumptions

- `hermes` backend remains the canonical implementation.
- `codex` backend defaults to `codex exec {prompt}`.
- `claude_code` backend defaults to `claude -p {prompt}`.
- Use `judge_backend` if you want semantic assertions to run through a different backend than the tested one.

## Maintenance rule

If a backend needs different session capture, add that logic to the adapter rather than the shared evaluator.
