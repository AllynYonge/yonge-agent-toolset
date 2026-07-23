#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
SessionStart Hook - 注入工作流全景和当前状态
为 {{workflow_name}} 工作流自动生成
"""
from __future__ import annotations

import json
import os
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
        return {
            "workflow_id": "{{workflow_name}}",
            "current_skill": "no_active_task",
            "skills": {}
        }
    try:
        return json.loads(state_file.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return {
            "workflow_id": "{{workflow_name}}",
            "current_skill": "no_active_task",
            "skills": {}
        }


def read_workflow_md(workflow_root: Path) -> str:
    """读取 workflow.md 的简化版本"""
    wf_file = workflow_root / ".workflow" / "workflow.md"
    if not wf_file.is_file():
        return "工作流文件缺失"
    
    try:
        content = wf_file.read_text(encoding="utf-8")
        lines = content.split("\n")
        
        # 提取工作流概览和技能流水线部分
        output = []
        in_overview = False
        in_pipeline = False
        
        for line in lines:
            if line.strip().startswith("## 工作流概览"):
                in_overview = True
                output.append(line)
                continue
            elif line.strip().startswith("## 技能流水线"):
                in_pipeline = True
                output.append(line)
                continue
            elif line.strip().startswith("##"):
                in_overview = False
                in_pipeline = False
                continue
            
            if in_overview or in_pipeline:
                output.append(line)
        
        return "\n".join(output[:20])  # 限制长度
    except OSError:
        return "无法读取工作流文件"


def build_session_context(state: dict, workflow_root: Path) -> str:
    """构建会话上下文"""
    current_skill = state.get("current_skill", "no_active_task")
    skills = state.get("skills", {})
    
    # 统计完成和待执行的技能
    completed = [name for name, info in skills.items() if info.get("status") == "completed"]
    pending = [name for name, info in skills.items() if info.get("status") == "pending"]
    in_progress = [name for name, info in skills.items() if info.get("status") == "in_progress"]
    
    total_skills = len(skills)
    completed_count = len(completed)
    
    # 当前技能信息
    current_skill_name = "无"
    if in_progress:
        current_skill_name = in_progress[0]
    
    context = f"""<session-context>
工作流：{{workflow_name}}
技能节点：{total_skills} 个
当前状态：{current_skill}
当前技能：{current_skill_name} ({completed_count}/{total_skills})
已完成：{', '.join(completed) if completed else '无'}
待执行：{', '.join(pending) if pending else '无'}
</session-context>

<workflow-overview>
{read_workflow_md(workflow_root)}
</workflow-overview>"""
    
    return context


def main():
    """主函数"""
    # 检查是否禁用 Hook
    if os.environ.get("WORKFLOW_HOOKS") == "0":
        sys.exit(0)
    
    # 读取 Hook 输入
    try:
        hook_input = json.loads(sys.stdin.read())
        if not isinstance(hook_input, dict):
            hook_input = {}
    except (json.JSONDecodeError, ValueError):
        hook_input = {}
    
    # 查找工作流根目录
    cwd_str = hook_input.get("cwd") or os.getcwd()
    cwd = Path(cwd_str)
    workflow_root = find_workflow_root(cwd)
    
    if workflow_root is None:
        # 不是工作流项目，静默退出
        sys.exit(0)
    
    # 加载状态
    state = load_state(workflow_root)
    
    # 构建上下文
    context_text = build_session_context(state, workflow_root)
    
    # 输出 Hook 结果
    result = {
        "hookSpecificOutput": {
            "hookEventName": "SessionStart",
            "additionalContext": context_text
        },
        # Cursor 兼容格式
        "additional_context": context_text
    }
    
    print(json.dumps(result, ensure_ascii=False), flush=True)


if __name__ == "__main__":
    main()
