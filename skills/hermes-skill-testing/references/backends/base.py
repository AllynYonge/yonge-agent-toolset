"""Shared backend protocol for real-agent behavior tests."""

from __future__ import annotations

import os
import shlex
import shutil
import subprocess
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any


DEFAULT_TIMEOUT = 240


@dataclass
class TurnResult:
    prompt: str
    cmd: list[str]
    exit_code: int
    stdout: str
    stderr: str
    error: str | None = None

    def as_dict(self) -> dict[str, Any]:
        data = {
            "prompt": self.prompt,
            "cmd": self.cmd,
            "exit_code": self.exit_code,
            "stdout": self.stdout,
            "stderr": self.stderr,
        }
        if self.error:
            data["error"] = self.error
        return data


@dataclass
class CaseState:
    session_id: str | None = None


class AgentBackend:
    """Base class for backend-specific CLI setup, execution, and transcript capture."""

    name = "base"
    home_env_var = "AGENT_HOME"
    default_home_name = ".agent"
    temp_prefix = "agent-behavior"

    def real_home(self) -> Path:
        return Path(os.environ.get(self.home_env_var, Path.home() / self.default_home_name))

    def skill_root(self) -> Path:
        return self.real_home() / "skills"

    def find_skill_dir(self, skill_name: str) -> tuple[Path, Path]:
        src_root = self.skill_root()
        matches = [p for p in src_root.rglob("SKILL.md") if p.parent.name == skill_name]
        if not matches:
            raise FileNotFoundError(f"Skill {skill_name!r} not found under {src_root}")
        skill_dir = matches[0].parent
        return skill_dir, skill_dir.relative_to(src_root)

    def target_test_root(self, spec: dict[str, Any]) -> Path:
        skill_dir, _ = self.find_skill_dir(spec["skill"])
        root = skill_dir / "test"
        root.mkdir(parents=True, exist_ok=True)
        for child in ["specs", "reports", "tmp"]:
            (root / child).mkdir(parents=True, exist_ok=True)
        return root

    def make_temp_home(self, test_root: Path) -> Path:
        tmp_root = test_root / "tmp"
        tmp_root.mkdir(parents=True, exist_ok=True)
        name = f"{self.temp_prefix}-{time.strftime('%Y%m%d-%H%M%S')}-{os.getpid()}"
        home = tmp_root / name
        home.mkdir(parents=True, exist_ok=False)
        return home

    def copy_skill_tree(self, skill_name: str, home: Path) -> None:
        _, rel_dir = self.find_skill_dir(skill_name)
        src = self.skill_root() / rel_dir
        dst = home / "skills" / rel_dir
        dst.parent.mkdir(parents=True, exist_ok=True)
        if dst.exists():
            shutil.rmtree(dst)
        shutil.copytree(src, dst, ignore=shutil.ignore_patterns("test", "tmp", "__pycache__", "*.pyc"))

    def prepare_home(self, home: Path, spec: dict[str, Any]) -> None:
        home.mkdir(parents=True, exist_ok=True)

    def env(self, home: Path, spec: dict[str, Any]) -> dict[str, str]:
        env = os.environ.copy()
        env[self.home_env_var] = str(home)
        return env

    def files_for_transcript(self, home: Path) -> set[Path]:
        if not home.exists():
            return set()
        ignored_parts = {"skills", "tmp", "__pycache__"}
        return {
            p
            for p in home.rglob("*")
            if p.is_file() and not any(part in ignored_parts for part in p.parts)
        }

    def read_new_transcript(self, before: set[Path], home: Path) -> str:
        chunks = []
        for p in sorted(self.files_for_transcript(home) - before, key=lambda item: item.stat().st_mtime):
            try:
                chunks.append(f"\n---FILE {p}---\n" + p.read_text(encoding="utf-8", errors="replace"))
            except Exception:
                pass
        return "\n".join(chunks)

    def new_case_state(self) -> CaseState:
        return CaseState()

    def run_turn(
        self,
        prompt: str,
        *,
        index: int,
        spec: dict[str, Any],
        case: dict[str, Any],
        state: CaseState,
        home: Path,
        env: dict[str, str],
        timeout: int,
    ) -> TurnResult:
        raise NotImplementedError

    def run_semantic_judge(self, assertion: dict[str, Any], text: str, env: dict[str, str], timeout: int) -> tuple[bool, str]:
        raise NotImplementedError(f"semantic assertions are not implemented for backend {self.name!r}")


class CommandTemplateBackend(AgentBackend):
    """Backend for CLIs that can run one prompt per process through a command template."""

    command_template_key = "command_template"
    default_command_template: list[str] = []

    def command_template(self, spec: dict[str, Any], case: dict[str, Any]) -> list[str]:
        raw = case.get(self.command_template_key) or spec.get(self.command_template_key) or self.default_command_template
        if isinstance(raw, str):
            raw = shlex.split(raw)
        if not raw:
            raise ValueError(f"backend {self.name!r} requires {self.command_template_key}")
        return [str(part) for part in raw]

    def build_command(self, prompt: str, spec: dict[str, Any], case: dict[str, Any], state: CaseState, home: Path) -> list[str]:
        values = {
            "prompt": prompt,
            "skill": spec.get("skill", ""),
            "home": str(home),
            "model": str(case.get("model") or spec.get("model") or ""),
            "session_id": state.session_id or "",
        }
        return [part.format(**values) for part in self.command_template(spec, case)]

    def run_turn(
        self,
        prompt: str,
        *,
        index: int,
        spec: dict[str, Any],
        case: dict[str, Any],
        state: CaseState,
        home: Path,
        env: dict[str, str],
        timeout: int,
    ) -> TurnResult:
        cmd = self.build_command(prompt, spec, case, state, home)
        try:
            cp = subprocess.run(
                cmd,
                cwd=str(Path(os.environ.get("AGENT_TEST_CWD", os.getcwd()))),
                env=env,
                text=True,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                timeout=timeout,
            )
        except subprocess.TimeoutExpired as e:
            return TurnResult(prompt, cmd, -1, e.stdout or "", f"{e.stderr or ''}\n[TIMEOUT] Process exceeded {timeout}s", "timeout")
        return TurnResult(prompt, cmd, cp.returncode, cp.stdout or "", cp.stderr or "")
