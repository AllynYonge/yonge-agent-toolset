"""Hermes CLI backend for skill behavior tests."""

from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
from pathlib import Path
from typing import Any

from .base import AgentBackend, CaseState, TurnResult


REPO = Path(os.environ.get("HERMES_REPO", os.getcwd()))
DEFAULT_JUDGE_MODEL = "ikuncode-gemini-3-flash-preview"
DEFAULT_JUDGE_PROVIDER = "cpa"


class HermesBackend(AgentBackend):
    name = "hermes"
    home_env_var = "HERMES_HOME"
    default_home_name = ".hermes"
    temp_prefix = "hermes-behavior"

    def prepare_home(self, home: Path, spec: dict[str, Any]) -> None:
        home.mkdir(parents=True, exist_ok=True)
        real_home = self.real_home()
        if spec.get("inherit_runtime_config", True) and (real_home / "config.yaml").exists():
            shutil.copy2(real_home / "config.yaml", home / "config.yaml")
            for name in [".env", "auth.json"]:
                src = real_home / name
                if src.exists():
                    shutil.copy2(src, home / name)
            with (home / "config.yaml").open("a", encoding="utf-8") as f:
                f.write("\n\n# skill-behavior-test overrides\n")
                f.write(f"agent:\n  max_turns: {spec.get('agent_max_turns', 20)}\n")
                f.write("memory:\n  memory_enabled: false\n  user_profile_enabled: false\n")
                f.write("compression:\n  enabled: false\n")
                f.write("display:\n  tool_progress: false\n")
            return
        (home / "config.yaml").write_text(
            "agent:\n  max_turns: 20\n"
            "memory:\n  memory_enabled: false\n  user_profile_enabled: false\n"
            "compression:\n  enabled: false\n"
            "display:\n  tool_progress: false\n",
            encoding="utf-8",
        )

    def env(self, home: Path, spec: dict[str, Any]) -> dict[str, str]:
        env = super().env(home, spec)
        env["HERMES_ACCEPT_HOOKS"] = "1"
        return env

    def files_for_transcript(self, home: Path) -> set[Path]:
        d = home / "sessions"
        return set(p for p in d.rglob("*") if p.is_file()) if d.exists() else set()

    def add_model_flags(
        self,
        cmd: list[str],
        obj: dict[str, Any],
        *,
        model_key: str = "model",
        provider_key: str = "provider",
        default_model: str | None = None,
        default_provider: str | None = None,
    ) -> None:
        model = obj.get(model_key) or default_model
        provider = obj.get(provider_key) or default_provider
        if model:
            cmd += ["--model", str(model)]
        if provider:
            cmd += ["--provider", str(provider)]

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
        cmd = [
            "hermes",
            "chat",
            "-q",
            prompt,
            "--quiet",
            "--source",
            "skill-behavior-test",
            "--max-turns",
            str(case.get("max_turns", spec.get("agent_max_turns", 20))),
        ]
        if spec.get("preload_skill", True) and index == 0:
            cmd += ["--skills", spec["skill"]]
        if spec.get("toolsets"):
            cmd += ["--toolsets", str(spec["toolsets"])]
        self.add_model_flags(cmd, case)
        if not case.get("model") and spec.get("model"):
            cmd += ["--model", str(spec["model"])]
        if not case.get("provider") and spec.get("provider"):
            cmd += ["--provider", str(spec["provider"])]
        if state.session_id:
            cmd += ["--resume", state.session_id]
        try:
            cp = subprocess.run(
                cmd,
                cwd=str(REPO),
                env=env,
                text=True,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                timeout=timeout,
            )
        except subprocess.TimeoutExpired as e:
            return TurnResult(prompt, cmd, -1, e.stdout or "", f"{e.stderr or ''}\n[TIMEOUT] Process exceeded {timeout}s", "timeout")
        match = re.search(r"Session(?: ID)?:\s*([A-Za-z0-9_.:-]+)", (cp.stdout or "") + "\n" + (cp.stderr or ""))
        if match:
            state.session_id = match.group(1)
        return TurnResult(prompt, cmd, cp.returncode, cp.stdout or "", cp.stderr or "")

    def semantic_prompt(self, assertion: dict[str, Any], text: str) -> str:
        rubric = assertion.get("rubric") or assertion.get("criteria") or assertion.get("value") or assertion.get("claim")
        if not rubric:
            raise ValueError("semantic assertion requires rubric/criteria/value/claim")
        return (
            "你是 agent skill 行为测试的语义评审器。只输出 JSON，不要解释。\n"
            "判断候选输出是否满足测试准则。\n"
            "输出格式必须是：{\"passed\": true|false, \"reason\": \"一句话原因\"}\n\n"
            f"测试准则：\n{rubric}\n\n"
            f"候选输出：\n{text[:12000]}\n"
        )

    def run_semantic_judge(self, assertion: dict[str, Any], text: str, env: dict[str, str], timeout: int) -> tuple[bool, str]:
        cmd = [
            "hermes",
            "chat",
            "-q",
            self.semantic_prompt(assertion, text),
            "--quiet",
            "--source",
            "skill-semantic-judge",
            "--max-turns",
            "2",
        ]
        self.add_model_flags(
            cmd,
            assertion,
            model_key="judge_model",
            provider_key="judge_provider",
            default_model=DEFAULT_JUDGE_MODEL,
            default_provider=DEFAULT_JUDGE_PROVIDER,
        )
        try:
            cp = subprocess.run(
                cmd,
                cwd=str(REPO),
                env=env,
                text=True,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                timeout=int(assertion.get("timeout", timeout)),
            )
        except subprocess.TimeoutExpired as e:
            raw = f"{e.stdout or ''}\n{e.stderr or ''}"
            return False, f"semantic judge timeout after {int(assertion.get('timeout', timeout))}s: {raw[-500:]}"
        raw = (cp.stdout or "") + "\n" + (cp.stderr or "")
        match = re.search(r"\{.*\}", raw, re.S)
        if cp.returncode != 0:
            return False, f"semantic judge exited {cp.returncode}: {raw[-500:]}"
        if not match:
            return False, f"semantic judge returned non-JSON: {raw[-500:]}"
        try:
            obj = json.loads(match.group(0))
        except Exception as e:
            return False, f"semantic judge JSON parse failed: {e}; raw={raw[-500:]}"
        passed = bool(obj.get("passed"))
        reason = str(obj.get("reason", ""))
        return passed, reason or f"semantic judge passed={passed}"
