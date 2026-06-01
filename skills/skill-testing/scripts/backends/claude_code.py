"""Claude Code CLI backend for skill behavior tests.

Default native-session mode uses `claude -p --session-id <uuid>` for the first
turn and `claude -p --resume <uuid>` for later turns. Override
`command_template` or set `conversation_mode` to `isolated` if the local Claude
Code CLI uses different flags or the test intentionally needs independent turns.

Known constraints:
- Slash command routing: `claude -p "/skill-name ..."` is intercepted by the
  CLI router before the LLM sees the prompt. Test prompts must use natural
  language, not /skill-name prefixes.
- Working directory sandbox: `claude -p` restricts file access to the cwd.
  Vault/fixture paths in specs must be inside the harness working directory or
  an explicitly added directory (--add-dir). Avoid /tmp/ paths.
- Semantic assertions are judged through a separate `claude -p --output-format
  json` turn.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import uuid
from pathlib import Path
from typing import Any

from .base import CaseState, CommandTemplateBackend, TurnResult

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

    def conversation_mode(self, spec: dict[str, Any], case: dict[str, Any]) -> str:
        if case.get(self.command_template_key) or spec.get(self.command_template_key):
            return "isolated"
        return str(case.get("conversation_mode") or spec.get("conversation_mode") or "native_session")

    def new_case_state(self) -> CaseState:
        return CaseState(session_id=str(uuid.uuid4()))

    def _add_model_flags(self, cmd: list[str], spec: dict[str, Any], case: dict[str, Any]) -> None:
        model = case.get("model") or spec.get("model")
        if model:
            cmd += ["--model", str(model)]

    def _add_judge_model_flags(self, cmd: list[str], assertion: dict[str, Any]) -> None:
        model = assertion.get("judge_model")
        if model:
            cmd += ["--model", str(model)]

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

    def env(self, home: Path, spec: dict[str, Any]) -> dict[str, str]:
        env = super().env(home, spec)
        claude_bin = shutil.which("claude", path=env.get("PATH"))
        if claude_bin:
            # Claude Code is usually installed next to its expected Node runtime.
            env["PATH"] = str(Path(claude_bin).parent) + os.pathsep + env.get("PATH", "")
        return env

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

        if not state.session_id:
            state.session_id = str(uuid.uuid4())
        cmd = [
            "claude",
            "-p",
            "--output-format",
            "json",
            "--dangerously-skip-permissions",
        ]
        self._add_model_flags(cmd, spec, case)
        if index == 0:
            cmd += ["--session-id", state.session_id, prompt]
        else:
            cmd += ["--resume", state.session_id, prompt]

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

        try:
            obj = json.loads(cp.stdout or "{}")
            if obj.get("session_id"):
                state.session_id = str(obj["session_id"])
        except Exception:
            pass
        return TurnResult(prompt, cmd, cp.returncode, cp.stdout or "", cp.stderr or "")

    def run_semantic_judge(self, assertion: dict[str, Any], text: str, env: dict[str, str], timeout: int) -> tuple[bool, str]:
        cmd = [
            "claude",
            "-p",
            "--output-format",
            "json",
            "--dangerously-skip-permissions",
        ]
        self._add_judge_model_flags(cmd, assertion)
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
        try:
            cli_obj = json.loads(cp.stdout or "{}")
            answer = str(cli_obj.get("result") or cp.stdout or "")
        except Exception:
            answer = cp.stdout or raw
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
