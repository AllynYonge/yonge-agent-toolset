"""Backend registry for agent skill behavior tests."""

from __future__ import annotations

from .base import AgentBackend
from .claude_code import ClaudeCodeBackend
from .codex import CodexBackend
from .hermes import HermesBackend


def get_backend(name: str | None) -> AgentBackend:
    backend_name = (name or "hermes").replace("-", "_").lower()
    if backend_name == "hermes":
        return HermesBackend()
    if backend_name == "codex":
        return CodexBackend()
    if backend_name in {"claude_code", "claude"}:
        return ClaudeCodeBackend()
    raise ValueError(f"unknown backend {name!r}; expected hermes, codex, or claude_code")

