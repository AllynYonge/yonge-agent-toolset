# Spec schema

Use this file when writing or reviewing a behavior test spec.

## Required fields

```json
{
  "skill": "target-skill",
  "cases": []
}
```

## Optional fields

- `backend`: `hermes`, `codex`, or `claude_code`
- `timeout`: per-turn timeout in seconds
- `agent_max_turns`: max turns for the backend runner
- `related_skills`: extra skills to copy into the temp home
- `model` / `provider`: backend model selection
- `judge_backend`: backend used for semantic assertions
- `command_template`: non-Hermes backend command template

## Command template tokens

- `{prompt}`: current user prompt
- `{skill}`: target skill name
- `{home}`: temporary backend home
- `{model}`: selected model, if any
- `{session_id}`: backend session id, if the adapter has captured one
