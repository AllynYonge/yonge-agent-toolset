#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
PreToolUse Hook - 为子代理注入技能特定上下文（可选）
为 {{workflow_name}} 工作流自动生成
仅在子代理模式（如 Codex）且配置了 context-manifest.jsonl 时使用
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


def load_context_manifest(workflow_root: Path) -> list[dict]:
    """读取上下文清单"""
    manifest_file = workflow_root / ".workflow" / "runtime" / "context-manifest.jsonl"
    if not manifest_file.is_file():
        return []
    
    entries = []
    try:
        for line in manifest_file.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if not line:
                continue
            try:
                entry = json.loads(line)
                entries.append(entry)
            except json.JSONDecodeError:
                continue
    except OSError:
        pass
    
    return entries


def get_current_skill(workflow_root: Path) -> Optional[str]:
    """获取当前执行的技能"""
    state_file = workflow_root / ".workflow" / "runtime" / "state.json"
    if not state_file.is_file():
        return None
    
    try:
        state = json.loads(state_file.read_text(encoding="utf-8"))
        # 查找 in_progress 的技能
        for skill_name, skill_info in state.get("skills", {}).items():
            if skill_info.get("status") == "in_progress":
                return skill_name
    except (json.JSONDecodeError, OSError):
        pass
    
    return None


def collect_context_for_skill(
    skill_name: str,
    manifest: list[dict],
    workflow_root: Path
) -> str:
    """收集指定技能的上下文"""
    context_parts = []
    
    # 过滤出该技能的上下文条目
    skill_entries = [e for e in manifest if e.get("skill") == skill_name]
    
    if not skill_entries:
        return ""
    
    context_parts.append(f"<!-- trellis-hook-injected: {skill_name} -->")
    context_parts.append(f"\n## 上下文：{skill_name}\n")
    
    for entry in skill_entries:
        entry_type = entry.get("type", "input")
        source = entry.get("source", "unknown")
        file_path = entry.get("file")
        reason = entry.get("reason", "")
        
        context_parts.append(f"\n### {entry_type.upper()}: {source}")
        if reason:
            context_parts.append(f"用途：{reason}")
        
        # 如果有文件路径，尝试读取内容
        if file_path:
            full_path = workflow_root / file_path
            if full_path.is_file():
                try:
                    content = full_path.read_text(encoding="utf-8")
                    # 限制长度（前 2000 字符）
                    if len(content) > 2000:
                        content = content[:2000] + "\n\n[...内容截断，查看完整文件：" + file_path + "]"
                    context_parts.append(f"\n```\n{content}\n```\n")
                except OSError:
                    context_parts.append(f"\n[无法读取文件: {file_path}]\n")
            else:
                context_parts.append(f"\n[文件不存在: {file_path}]\n")
    
    return "\n".join(context_parts)


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
        sys.exit(0)
    
    # 加载上下文清单
    manifest = load_context_manifest(workflow_root)
    if not manifest:
        # 没有配置上下文清单，不注入
        sys.exit(0)
    
    # 获取当前技能
    current_skill = get_current_skill(workflow_root)
    if not current_skill:
        sys.exit(0)
    
    # 收集上下文
    context_text = collect_context_for_skill(current_skill, manifest, workflow_root)
    
    if not context_text:
        sys.exit(0)
    
    # 输出
    output = {
        "hookSpecificOutput": {
            "hookEventName": "PreToolUse",
            "additionalContext": context_text
        }
    }
    
    print(json.dumps(output, ensure_ascii=False))


if __name__ == "__main__":
    main()
