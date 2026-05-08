"""Claude Code CLI backend for skill behavior tests.

Default template uses `claude -p --dangerously-skip-permissions` for
non-interactive, approval-free execution in automated test runs.

Known constraints:
- Slash command routing: `claude -p "/skill-name ..."` is intercepted by the
  CLI router before the LLM sees the prompt. Test prompts must use natural
  language, not /skill-name prefixes.
- Working directory sandbox: `claude -p` restricts file access to the cwd.
  Vault/fixture paths in specs must be inside the harness working directory or
  an explicitly added directory (--add-dir). Avoid /tmp/ paths.
- Semantic assertions: claude_code does not implement run_semantic_judge.
  Set judge_backend="hermes" in the spec if Hermes is available, or avoid
  semantic/not_semantic assertions entirely.
"""

from __future__ import annotations

import json
import shutil
from pathlib import Path
from typing import Any

from .base import CommandTemplateBackend

# Keys from ~/.claude/settings.json that are safe to inherit into the test home.
# Excludes keys that would interfere with test isolation (e.g. hooks, projects).
_INHERIT_SETTINGS_KEYS = {
    "model",
    "effortLevel",
    "skipDangerousModePermissionPrompt",
    "env",
}


class ClaudeCodeBackend(CommandTemplateBackend):
    name = "claude_code"
    home_env_var = "CLAUDE_HOME"
    default_home_name = ".claude"
    temp_prefix = "claude-code-behavior"
    # --dangerously-skip-permissions: bypass all tool-call confirmation prompts
    # so the test harness can run fully non-interactively.
    default_command_template = [
        "claude",
        "-p",
        "--dangerously-skip-permissions",
        "{prompt}",
    ]

    def prepare_home(self, home: Path, spec: dict[str, Any]) -> None:
        home.mkdir(parents=True, exist_ok=True)
        if not spec.get("inherit_runtime_config", True):
            return
        real_home = self.real_home()
        # Inherit a filtered subset of settings so the test agent has the right
        # model and permission flags without picking up hooks or project state.
        settings_src = real_home / "settings.json"
        if settings_src.exists():
            try:
                src_data = json.loads(settings_src.read_text(encoding="utf-8"))
                inherited = {k: v for k, v in src_data.items() if k in _INHERIT_SETTINGS_KEYS}
                # Always enable permission bypass in test homes.
                inherited["skipDangerousModePermissionPrompt"] = True
                (home / "settings.json").write_text(
                    json.dumps(inherited, ensure_ascii=False, indent=2),
                    encoding="utf-8",
                )
            except Exception:
                # If settings can't be parsed, write a minimal safe default.
                (home / "settings.json").write_text(
                    '{"skipDangerousModePermissionPrompt": true}',
                    encoding="utf-8",
                )
        else:
            (home / "settings.json").write_text(
                '{"skipDangerousModePermissionPrompt": true}',
                encoding="utf-8",
            )
        # Inherit CLAUDE.md if present (global instructions).
        for name in ["CLAUDE.md"]:
            src = real_home / name
            if src.exists():
                shutil.copy2(src, home / name)
