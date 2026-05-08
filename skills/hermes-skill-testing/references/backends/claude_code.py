"""Claude Code CLI backend for skill behavior tests.

The default template assumes Claude Code's non-interactive print mode.
Override `command_template` in a spec if the local CLI uses different flags.
"""

from __future__ import annotations

from .base import CommandTemplateBackend


class ClaudeCodeBackend(CommandTemplateBackend):
    name = "claude_code"
    home_env_var = "CLAUDE_HOME"
    default_home_name = ".claude"
    temp_prefix = "claude-code-behavior"
    default_command_template = ["claude", "-p", "{prompt}"]

