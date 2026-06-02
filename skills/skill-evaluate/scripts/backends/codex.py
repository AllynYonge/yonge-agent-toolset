"""Codex CLI backend for skill behavior tests.

Default native-session mode uses `codex exec --json` for the first turn and
`codex exec resume <thread_id>` for later turns. Override `command_template` or
set `conversation_mode` to `isolated` if the local Codex CLI uses different
flags or the test intentionally needs independent turns.

Known constraints:
- Codex reads config from CODEX_HOME/config.toml; prepare_home() inherits it.
- `--dangerously-bypass-approvals-and-sandbox` is required to avoid interactive
  approval prompts during automated test runs.
- Semantic assertions are judged through a separate `codex exec --json` turn.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
from pathlib import Path
from typing import Any

from .base import CaseState, CommandTemplateBackend, TurnResult


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

    def conversation_mode(self, spec: dict[str, Any], case: dict[str, Any]) -> str:
        if case.get(self.command_template_key) or spec.get(self.command_template_key):
            return "isolated"
        return str(case.get("conversation_mode") or spec.get("conversation_mode") or "native_session")

    def _add_model_flags(self, cmd: list[str], spec: dict[str, Any], case: dict[str, Any]) -> None:
        model = case.get("model") or spec.get("model")
        if model:
            cmd += ["-m", str(model)]

    def _extract_thread_id(self, text: str) -> str | None:
        for line in text.splitlines():
            try:
                obj = json.loads(line)
            except Exception:
                continue
            if obj.get("type") == "thread.started" and obj.get("thread_id"):
                return str(obj["thread_id"])
        return None

    def _extract_agent_text(self, text: str) -> str:
        chunks: list[str] = []
        for line in text.splitlines():
            try:
                obj = json.loads(line)
            except Exception:
                continue
            item = obj.get("item")
            if isinstance(item, dict) and item.get("type") == "agent_message" and item.get("text"):
                chunks.append(str(item["text"]))
        return "\n".join(chunks) or text

    def semantic_prompt(self, assertion: dict[str, Any], text: str) -> str:
        rubric = assertion.get("rubric") or assertion.get("criteria") or assertion.get("value") or assertion.get("claim")
        if not rubric:
            raise ValueError("semantic assertion requires rubric/criteria/value/claim")
        return (
            "You are a strict behavior-test judge for an agent skill. "
            "Return only JSON, with no markdown or explanation outside JSON.\n"
            "Decide whether the candidate output satisfies the test criterion.\n"
            "Required format: {\"passed\": true|false, \"reason\": \"one short reason\"}\n\n"
            f"Test criterion:\n{rubric}\n\n"
            f"Candidate output:\n{text[:12000]}\n"
        )

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
        if self.conversation_mode(spec, case) == "isolated":
            return super().run_turn(
                prompt,
                index=index,
                spec=spec,
                case=case,
                state=state,
                home=home,
                env=env,
                timeout=timeout,
            )

        if index == 0:
            cmd = [
                "codex",
                "exec",
                "--json",
                "--dangerously-bypass-approvals-and-sandbox",
            ]
            self._add_model_flags(cmd, spec, case)
            cmd.append(prompt)
        else:
            if not state.session_id:
                return TurnResult(
                    prompt,
                    [],
                    1,
                    "",
                    "native_session mode requires a Codex thread_id captured from the previous turn",
                    "session_id",
                )
            cmd = [
                "codex",
                "exec",
                "resume",
                "--json",
                "--dangerously-bypass-approvals-and-sandbox",
            ]
            self._add_model_flags(cmd, spec, case)
            cmd += [state.session_id, prompt]

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

        thread_id = self._extract_thread_id((cp.stdout or "") + "\n" + (cp.stderr or ""))
        if thread_id:
            state.session_id = thread_id
        if len(case.get("turns", [])) > 1 and not state.session_id:
            stderr = (cp.stderr or "") + "\n[SESSION] Codex did not emit a thread.started thread_id; cannot resume later turns"
            return TurnResult(prompt, cmd, cp.returncode or 1, cp.stdout or "", stderr, "session_id")
        return TurnResult(prompt, cmd, cp.returncode, cp.stdout or "", cp.stderr or "")

    def run_semantic_judge(self, assertion: dict[str, Any], text: str, env: dict[str, str], timeout: int) -> tuple[bool, str]:
        cmd = [
            "codex",
            "exec",
            "--json",
            "--dangerously-bypass-approvals-and-sandbox",
        ]
        judge_model = assertion.get("judge_model")
        if judge_model:
            cmd += ["-m", str(judge_model)]
        cmd.append(self.semantic_prompt(assertion, text))
        try:
            cp = subprocess.run(
                cmd,
                cwd=str(Path(os.environ.get("AGENT_TEST_CWD", os.getcwd()))),
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
        if cp.returncode != 0:
            return False, f"semantic judge exited {cp.returncode}: {raw[-500:]}"
        answer = self._extract_agent_text(raw)
        try:
            obj = json.loads(answer)
        except Exception:
            import re

            match = re.search(r"\{.*\}", answer, re.S)
            if not match:
                return False, f"semantic judge returned non-JSON: {answer[-500:]}"
            try:
                obj = json.loads(match.group(0))
            except Exception as e:
                return False, f"semantic judge JSON parse failed: {e}; raw={answer[-500:]}"
        passed = bool(obj.get("passed"))
        reason = str(obj.get("reason", ""))
        return passed, reason or f"semantic judge passed={passed}"
