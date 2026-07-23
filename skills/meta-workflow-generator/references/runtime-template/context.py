#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
上下文查询工具
为 {{workflow_name}} 工作流自动生成
提供技能上下文查询和加载功能
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Optional


def find_workflow_root() -> Optional[Path]:
    """查找工作流根目录"""
    cur = Path.cwd()
    while cur != cur.parent:
        if (cur / ".workflow").is_dir():
            return cur
        cur = cur.parent
    return None


def load_context_manifest(workflow_root: Path) -> list[dict]:
    """加载上下文清单"""
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


def cmd_list(workflow_root: Path, skill_name: Optional[str] = None) -> int:
    """列出上下文条目"""
    manifest = load_context_manifest(workflow_root)
    
    if not manifest:
        print("上下文清单为空")
        return 0
    
    # 过滤
    if skill_name:
        manifest = [e for e in manifest if e.get("skill") == skill_name]
        if not manifest:
            print(f"技能 {skill_name} 没有上下文条目")
            return 0
    
    print("上下文清单：")
    print("=" * 60)
    
    current_skill = None
    for entry in manifest:
        skill = entry.get("skill", "unknown")
        if skill != current_skill:
            if current_skill is not None:
                print()
            print(f"\n[{skill}]")
            current_skill = skill
        
        entry_type = entry.get("type", "input")
        source = entry.get("source", "unknown")
        file_path = entry.get("file", "—")
        reason = entry.get("reason", "")
        
        print(f"  • {entry_type.upper()}: {source}")
        if file_path != "—":
            print(f"    文件：{file_path}")
        if reason:
            print(f"    用途：{reason}")
    
    print("=" * 60)
    
    return 0


def cmd_load(workflow_root: Path, skill_name: str) -> int:
    """加载并显示技能的完整上下文"""
    manifest = load_context_manifest(workflow_root)
    
    if not manifest:
        print("上下文清单为空")
        return 1
    
    # 过滤该技能的条目
    skill_entries = [e for e in manifest if e.get("skill") == skill_name]
    
    if not skill_entries:
        print(f"技能 {skill_name} 没有上下文条目")
        return 1
    
    print(f"技能上下文：{skill_name}")
    print("=" * 60)
    
    for entry in skill_entries:
        entry_type = entry.get("type", "input")
        source = entry.get("source", "unknown")
        file_path = entry.get("file")
        reason = entry.get("reason", "")
        
        print(f"\n## {entry_type.upper()}: {source}")
        if reason:
            print(f"用途：{reason}")
        
        if file_path:
            full_path = workflow_root / file_path
            if full_path.is_file():
                try:
                    content = full_path.read_text(encoding="utf-8")
                    print(f"\n文件：{file_path}")
                    print("-" * 60)
                    print(content)
                    print("-" * 60)
                except OSError:
                    print(f"\n[无法读取文件: {file_path}]")
            else:
                print(f"\n[文件不存在: {file_path}]")
    
    print("\n" + "=" * 60)
    
    return 0


def cmd_validate(workflow_root: Path) -> int:
    """验证上下文清单的完整性"""
    manifest = load_context_manifest(workflow_root)
    
    if not manifest:
        print("上下文清单为空")
        return 0
    
    print("验证上下文清单...")
    print("=" * 60)
    
    issues = []
    
    for idx, entry in enumerate(manifest, 1):
        skill = entry.get("skill")
        if not skill:
            issues.append(f"条目 {idx}: 缺少 skill 字段")
            continue
        
        entry_type = entry.get("type")
        if not entry_type:
            issues.append(f"条目 {idx} ({skill}): 缺少 type 字段")
        
        source = entry.get("source")
        if not source:
            issues.append(f"条目 {idx} ({skill}): 缺少 source 字段")
        
        file_path = entry.get("file")
        if file_path:
            full_path = workflow_root / file_path
            if not full_path.is_file():
                issues.append(f"条目 {idx} ({skill}): 文件不存在 - {file_path}")
    
    if issues:
        print("发现问题：")
        for issue in issues:
            print(f"  ⚠ {issue}")
        print("=" * 60)
        return 1
    else:
        print("✓ 上下文清单完整，所有文件存在")
        print("=" * 60)
        return 0


def main():
    """主函数"""
    parser = argparse.ArgumentParser(description="上下文查询工具")
    subparsers = parser.add_subparsers(dest="command", help="命令")
    
    list_parser = subparsers.add_parser("list", help="列出上下文条目")
    list_parser.add_argument("--skill", help="过滤指定技能")
    
    load_parser = subparsers.add_parser("load", help="加载并显示技能的完整上下文")
    load_parser.add_argument("skill", help="技能名称")
    
    subparsers.add_parser("validate", help="验证上下文清单的完整性")
    
    args = parser.parse_args()
    
    if not args.command:
        parser.print_help()
        return 1
    
    # 查找工作流根目录
    workflow_root = find_workflow_root()
    if not workflow_root:
        print("错误：当前目录不是工作流项目（缺少 .workflow/ 目录）")
        return 1
    
    # 执行命令
    if args.command == "list":
        return cmd_list(workflow_root, args.skill)
    elif args.command == "load":
        return cmd_load(workflow_root, args.skill)
    elif args.command == "validate":
        return cmd_validate(workflow_root)
    else:
        print(f"未知命令：{args.command}")
        return 1


if __name__ == "__main__":
    sys.exit(main())
