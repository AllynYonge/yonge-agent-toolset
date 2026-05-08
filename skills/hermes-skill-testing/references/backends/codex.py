"""Codex CLI backend for skill behavior tests.

The default template assumes a non-interactive `codex exec` style command.
Override `command_template` in a spec if the local Codex CLI uses different flags.
"""

from __future__ import annotations

from .base import CommandTemplateBackend


class CodexBackend(CommandTemplateBackend):
    name = "codex"
    home_env_var = "CODEX_HOME"
    default_home_name = ".codex"
    temp_prefix = "codex-behavior"
    default_command_template = ["codex", "exec", "{prompt}"]

