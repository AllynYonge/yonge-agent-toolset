#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
UserPromptSubmit Hook - 注入当前工作流状态提示
为 {{workflow_name}} 工作流自动生成
"""
from __future__ import annotations

import json
import os
import re
import sys
from pathlib import Path
from typing import Optional

# Windows UTF-8 强制
if sys.platform.startswith("win"):
    import io as _io
    for _stream_name in ("stdin", "stdout", "stderr"):
        _stream = getattr(sys, _stream_name, None)
        if _stream is None:
            continue
        if hasattr(_stream, "reconfigure"):
            try:
                _stream.reconfigure(encoding="utf-8", errors="replace")
            except Exception:
                pass
        elif hasattr(_stream, "detach"):
            try:
                setattr(sys, _stream_name, _io.TextIOWrapper(_stream.detach(), encoding="utf-8", errors="replace"))
            except Exception:
                pass


def find_workflow_root(start: Path) -> Optional[Path]:
    """查找包含 .workflow/ 的根目录"""
    cur = start.resolve()
    while cur != cur.parent:
        if (cur / ".workflow").is_dir():
            return cur
        cur = cur.parent
    return None


def load_state(workflow_root: Path) -> dict:
    """读取工作流状态"""
    state_file = workflow_root / ".workflow" / "runtime" / "state.json"
    if not state_file.is_file():
        return {"current_skill": "no_active_task"}
    try:
        return json.loads(state_file.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return {"current_skill": "no_active_task"}


def parse_workflow_state_blocks(workflow_root: Path) -> dict[str, str]:
    """解析 workflow.md 中的 [workflow-state:STATUS] 块"""
    wf_file = workflow_root / ".workflow" / "workflow.md"
    if not wf_file.is_file():
        return {}
    
    try:
        content = wf_file.read_text(encoding="utf-8")
    except OSError:
        return {}
    
    # 正则匹配 [workflow-state:STATUS]...内容...[/workflow-state:STATUS]
    pattern = re.compile(
        r'\[workflow-state:([A-Za-z0-9_-]+)\]\s*\n(.*?)\n\s*\[/workflow-state:\1\]',
        re.DOTALL
    )
    
    result = {}
    for match in pattern.finditer(content):
        status = match.group(1)
        body = match.group(2).strip()
        if body:
            result[status] = body
    
    return result


def detect_platform(input_data: dict) -> Optional[str]:
    """检测 AI 平台"""
    # Cursor 版本字段
    if isinstance(input_data.get("cursor_version"), str):
        return "cursor"
    
    # 环境变量检测
    env_map = {
        "CLAUDE_PROJECT_DIR": "claude",
        "CURSOR_PROJECT_DIR": "cursor",
        "CODEX_PROJECT_DIR": "codex",
        "GEMINI_PROJECT_DIR": "gemini",
        "QODER_PROJECT_DIR": "qoder",
    }
    for env_name, platform in env_map.items():
        if os.environ.get(env_name):
            return platform
    
    return None


def build_breadcrumb(current_status: str, state_blocks: dict[str, str]) -> str:
    """构建状态面包屑"""
    body = state_blocks.get(current_status)
    
    if body is None:
        # 降级为通用提示
        body = f"参考 .workflow/workflow.md 查看当前步骤（状态：{current_status}）"
    
    return f"<workflow-state>\n状态：{current_status}\n{body}\n</workflow-state>"


def main():
    """主函数"""
    # 检查是否禁用 Hook
    if os.environ.get("WORKFLOW_HOOKS") == "0":
        sys.exit(0)
    
    # 读取 Hook 输入
    try:
        data = json.loads(sys.stdin.read())
    except (json.JSONDecodeError, ValueError):
        data = {}
    
    # 查找工作流根目录
    cwd_str = data.get("cwd") or os.getcwd()
    cwd = Path(cwd_str)
    workflow_root = find_workflow_root(cwd)
    
    if workflow_root is None:
        # 不是工作流项目，静默退出
        sys.exit(0)
    
    # 加载状态和状态块
    state = load_state(workflow_root)
    state_blocks = parse_workflow_state_blocks(workflow_root)
    
    # 获取当前状态
    current_status = state.get("current_skill", "no_active_task")
    
    # 构建面包屑
    breadcrumb = build_breadcrumb(current_status, state_blocks)
    
    # 检测平台
    platform = detect_platform(data)
    
    # Gemini 使用 BeforeAgent，其他平台使用 UserPromptSubmit
    hook_event_name = "BeforeAgent" if platform == "gemini" else "UserPromptSubmit"
    
    # 输出
    output = {
        "hookSpecificOutput": {
            "hookEventName": hook_event_name,
            "additionalContext": breadcrumb
        }
    }
    
    print(json.dumps(output, ensure_ascii=False))
    sys.exit(0)


if __name__ == "__main__":
    main()
