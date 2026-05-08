"""Codex CLI backend for skill behavior tests.

Default template uses `codex exec --dangerously-bypass-approvals-and-sandbox`
for non-interactive, approval-free execution. Override `command_template` in a
spec if the local Codex CLI uses different flags.

Known constraints:
- Codex reads config from CODEX_HOME/config.toml; prepare_home() inherits it.
- `--dangerously-bypass-approvals-and-sandbox` is required to avoid interactive
  approval prompts during automated test runs.
- Semantic assertions are not natively supported; set judge_backend="hermes" in
  the spec if Hermes is available, otherwise avoid semantic/not_semantic assertions.
"""

from __future__ import annotations

import shutil
from pathlib import Path
from typing import Any

from .base import CommandTemplateBackend


class CodexBackend(CommandTemplateBackend):
    name = "codex"
    home_env_var = "CODEX_HOME"
    default_home_name = ".codex"
    temp_prefix = "codex-behavior"
    # --dangerously-bypass-approvals-and-sandbox: skip all confirmation prompts
    # so the test harness can run fully non-interactively.
    default_command_template = [
        "codex",
        "exec",
        "--dangerously-bypass-approvals-and-sandbox",
        "{prompt}",
    ]

    def prepare_home(self, home: Path, spec: dict[str, Any]) -> None:
        home.mkdir(parents=True, exist_ok=True)
        if not spec.get("inherit_runtime_config", True):
            return
        real_home = self.real_home()
        # Inherit config and auth so the test agent has model/provider settings.
        for name in ["config.toml", "auth.json"]:
            src = real_home / name
            if src.exists():
                shutil.copy2(src, home / name)
