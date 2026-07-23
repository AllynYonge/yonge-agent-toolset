# 执行后端兼容性说明

本说明用于保持 Hermes、Codex 和 Claude Code 的行为测试规则一致。

## Recommended split

- Keep assertions backend-agnostic.
- Keep CLI invocation differences inside backend adapters.
- Use `command_template` only when a backend does not expose a stable non-interactive mode in code.

## Default assumptions

- `hermes` backend remains the canonical implementation.
- `codex` backend defaults to native session mode: `codex exec --json {prompt}` then `codex exec resume <thread_id> {prompt}`.
- `claude_code` backend defaults to native session mode: `claude -p --session-id <uuid> {prompt}` then `claude -p --resume <uuid> {prompt}`.
- Semantic assertions default to the tested backend. Use `judge_backend` only when you want semantic assertions to run through a different backend than the tested one.
- Use `conversation_mode: "isolated"` only when a test intentionally needs independent one-prompt processes or a custom `command_template`.

## Maintenance rule

If a backend needs different session capture, add that logic to the adapter rather than the shared evaluator.

Native session adapters must record the active session id in `CaseState.session_id` so the report can show it under each turn.


## Codex — known constraints

### Isolated CODEX_HOME must inherit model catalog files
Harness creates a temporary `CODEX_HOME` and, by default, inherits runtime config via `inherit_runtime_config: true`.

Copying only `config.toml` + `auth.json` is **not enough** when config contains a relative catalog path such as:

```toml
model_catalog_json = "cpa-router-models.json"
```

In that case both the **tested agent** and the **semantic/quality judge** start with the same temporary home. Missing catalog files produce:

```text
Error: No such file or directory (os error 2)
```

and quality dimensions show `judge_status=error` / `infra_failed=true`.

**Current adapter behavior**: `CodexBackend.prepare_home()` also inherits:
- model catalog files referenced by `model_catalog_json`
- common catalogs: `cpa-router-models.json`, `cc-switch-model-catalog.json`, `models.json`
- optional `rules/` directory

**Consequence for operators**:
- This is a harness/env class failure, not a target-skill defect.
- If you still see os error 2 after updating skill-evaluate, check whether the catalog file exists under the real `$CODEX_HOME` and whether `prepare_home` copied it into the temp home (`--keep-home` helps inspect).
- Do not loosen assertions or edit the target `SKILL.md` because judge/agent failed to boot.

### Semantic / quality judge
`codex` implements judges through a separate `codex exec --json` turn in the same temporary `CODEX_HOME`. Quality expects `{"score","evidence","gaps"}`; semantic expects `{"passed","reason"}`. Both need a bootable Codex home first.

## Claude Code — known constraints

### Slash command routing
`claude -p "/skill-name ..."` is intercepted by Claude Code's slash command router **before** the LLM sees the prompt. If the skill name does not match a registered skill, the CLI returns `"Unknown skill: <name>"` immediately.

**Consequence**: test prompts for claude_code must use natural language, not `/skill-name` prefixes. For example, use `"analyze my Obsidian notes"` instead of `"/wiki analyze my notes"`.

### Working directory sandbox
`claude -p` runs with a restricted working directory (the harness `cwd`). Paths outside that directory (e.g. `/tmp/...`) may be rejected with a permission/access error before the skill's gate logic can execute.

**Consequence**: test vault paths in specs must be absolute paths inside the harness working directory, or inside a directory that claude is allowed to access. Use a subdirectory of the harness `references/` folder as a test fixture (e.g. `references/test-vault/`) rather than `/tmp/` paths.

### Semantic judge
`claude_code` implements `run_semantic_judge` through a separate `claude -p --output-format json` turn. `codex` implements it through `codex exec --json`. Both judges expect strict `{"passed": true|false, "reason": "..."}` output and fall back to extracting the first JSON object if the model adds surrounding text.
