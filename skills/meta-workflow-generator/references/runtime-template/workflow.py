#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
工作流管理脚本
为 {{workflow_name}} 工作流自动生成
提供状态查询、进度追踪、中断恢复等功能
"""
from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime
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


def load_state(workflow_root: Path) -> dict:
    """加载状态文件"""
    state_file = workflow_root / ".workflow" / "runtime" / "state.json"
    if not state_file.is_file():
        return {}
    try:
        return json.loads(state_file.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return {}


def save_state(workflow_root: Path, state: dict) -> None:
    """保存状态文件"""
    state_file = workflow_root / ".workflow" / "runtime" / "state.json"
    state_file.parent.mkdir(parents=True, exist_ok=True)
    state_file.write_text(json.dumps(state, indent=2, ensure_ascii=False), encoding="utf-8")


def cmd_status(workflow_root: Path) -> int:
    """显示当前状态"""
    state = load_state(workflow_root)
    
    if not state:
        print("状态：未初始化")
        print("运行 `python .workflow/scripts/workflow.py start` 启动工作流")
        return 0
    
    workflow_id = state.get("workflow_id", "未知")
    current = state.get("current_skill", "no_active_task")
    skills = state.get("skills", {})
    
    print(f"工作流：{workflow_id}")
    print(f"当前状态：{current}")
    print()
    
    if not skills:
        print("技能列表：空")
        return 0
    
    print("技能进度：")
    print("=" * 60)
    
    for skill_name in sorted(skills.keys()):
        skill_info = skills[skill_name]
        status = skill_info.get("status", "pending")
        output_path = skill_info.get("output_path", "—")
        attempts = skill_info.get("attempts", 0)
        
        status_symbol = {
            "pending": "☐",
            "in_progress": "◐",
            "completed": "☑",
            "failed": "☒",
            "skipped": "⊘"
        }.get(status, "?")
        
        print(f"{status_symbol} {skill_name}")
        print(f"   状态：{status}")
        if output_path != "—":
            print(f"   产出：{output_path}")
        if attempts > 1:
            print(f"   重试：{attempts} 次")
    
    print("=" * 60)
    
    # 统计
    total = len(skills)
    completed = sum(1 for s in skills.values() if s.get("status") == "completed")
    print(f"\n进度：{completed}/{total} 技能已完成")
    
    return 0


def cmd_start(workflow_root: Path) -> int:
    """启动工作流"""
    state = load_state(workflow_root)
    
    if not state or not state.get("skills"):
        print("错误：状态文件不完整，请检查 .workflow/runtime/state.json")
        return 1
    
    # 找到第一个 pending 的技能
    skills = state.get("skills", {})
    first_skill = None
    
    for skill_name in sorted(skills.keys()):
        if skills[skill_name].get("status") == "pending":
            # 检查依赖
            deps = skills[skill_name].get("dependencies", [])
            if not deps or all(skills.get(d, {}).get("status") == "completed" for d in deps):
                first_skill = skill_name
                break
    
    if not first_skill:
        print("所有技能已完成或无法启动（依赖未满足）")
        return 0
    
    # 更新状态
    skills[first_skill]["status"] = "in_progress"
    skills[first_skill]["started_at"] = datetime.now().isoformat()
    state["current_skill"] = f"{first_skill}_in_progress"
    
    save_state(workflow_root, state)
    
    print(f"✓ 工作流已启动")
    print(f"当前技能：{first_skill}")
    print(f"\n开始执行该技能的步骤...")
    
    return 0


def cmd_next(workflow_root: Path, current_output: Optional[str] = None) -> int:
    """标记当前技能完成，进入下一个"""
    state = load_state(workflow_root)
    
    if not state or not state.get("skills"):
        print("错误：无活跃工作流")
        return 1
    
    # 找到当前 in_progress 的技能
    skills = state.get("skills", {})
    current_skill = None
    
    for skill_name, skill_info in skills.items():
        if skill_info.get("status") == "in_progress":
            current_skill = skill_name
            break
    
    if not current_skill:
        print("错误：没有正在执行的技能")
        return 1
    
    # 标记为完成
    skills[current_skill]["status"] = "completed"
    skills[current_skill]["completed_at"] = datetime.now().isoformat()
    if current_output:
        skills[current_skill]["output_path"] = current_output
    
    # 查找下一个可执行的技能
    next_skill = None
    for skill_name in sorted(skills.keys()):
        if skills[skill_name].get("status") == "pending":
            deps = skills[skill_name].get("dependencies", [])
            if not deps or all(skills.get(d, {}).get("status") == "completed" for d in deps):
                next_skill = skill_name
                break
    
    if next_skill:
        skills[next_skill]["status"] = "in_progress"
        skills[next_skill]["started_at"] = datetime.now().isoformat()
        state["current_skill"] = f"{next_skill}_in_progress"
        
        save_state(workflow_root, state)
        
        print(f"✓ {current_skill} 已完成")
        print(f"→ 进入下一个技能：{next_skill}")
    else:
        state["current_skill"] = "completed"
        save_state(workflow_root, state)
        
        print(f"✓ {current_skill} 已完成")
        print("✓ 所有技能已完成！")
        print("\n运行 `python .workflow/scripts/workflow.py report` 查看执行报告")
    
    return 0


def cmd_skip(workflow_root: Path, reason: str = "") -> int:
    """跳过当前技能"""
    state = load_state(workflow_root)
    
    if not state or not state.get("skills"):
        print("错误：无活跃工作流")
        return 1
    
    skills = state.get("skills", {})
    current_skill = None
    
    for skill_name, skill_info in skills.items():
        if skill_info.get("status") == "in_progress":
            current_skill = skill_name
            break
    
    if not current_skill:
        print("错误：没有正在执行的技能")
        return 1
    
    # 标记为跳过
    skills[current_skill]["status"] = "skipped"
    skills[current_skill]["skipped_at"] = datetime.now().isoformat()
    if reason:
        skills[current_skill]["skip_reason"] = reason
    
    save_state(workflow_root, state)
    
    print(f"⊘ {current_skill} 已跳过")
    if reason:
        print(f"原因：{reason}")
    
    return 0


def cmd_report(workflow_root: Path) -> int:
    """生成执行报告"""
    state = load_state(workflow_root)
    
    if not state or not state.get("skills"):
        print("错误：无可用状态")
        return 1
    
    workflow_id = state.get("workflow_id", "未知")
    skills = state.get("skills", {})
    
    print("=" * 60)
    print(f"工作流执行报告：{workflow_id}")
    print("=" * 60)
    print()
    
    # 统计
    total = len(skills)
    completed = sum(1 for s in skills.values() if s.get("status") == "completed")
    skipped = sum(1 for s in skills.values() if s.get("status") == "skipped")
    failed = sum(1 for s in skills.values() if s.get("status") == "failed")
    
    print(f"总技能数：{total}")
    print(f"已完成：{completed}")
    print(f"已跳过：{skipped}")
    print(f"失败：{failed}")
    print()
    
    # 产出物列表
    print("最终交付物：")
    print("-" * 60)
    
    has_output = False
    for skill_name in sorted(skills.keys()):
        skill_info = skills[skill_name]
        if skill_info.get("status") == "completed" and skill_info.get("output_path"):
            output_path = skill_info["output_path"]
            print(f"  • {output_path}")
            has_output = True
    
    if not has_output:
        print("  （无产出物记录）")
    
    print("=" * 60)
    
    return 0


def cmd_archive(workflow_root: Path) -> int:
    """归档工作流"""
    state = load_state(workflow_root)
    
    if not state:
        print("错误：无可用状态")
        return 1
    
    # 检查是否还有未完成的技能
    skills = state.get("skills", {})
    incomplete = [
        name for name, info in skills.items()
        if info.get("status") not in ("completed", "skipped")
    ]
    
    if incomplete:
        print(f"警告：以下技能未完成：{', '.join(incomplete)}")
        response = input("仍要归档吗？(y/N): ")
        if response.lower() != "y":
            print("已取消")
            return 0
    
    # 创建归档目录
    archive_dir = workflow_root / ".workflow" / "archive"
    archive_dir.mkdir(parents=True, exist_ok=True)
    
    # 生成归档文件名
    workflow_id = state.get("workflow_id", "workflow")
    timestamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    archive_file = archive_dir / f"{workflow_id}-{timestamp}.json"
    
    # 保存归档
    archive_file.write_text(json.dumps(state, indent=2, ensure_ascii=False), encoding="utf-8")
    
    print(f"✓ 工作流已归档到：{archive_file}")
    print("\n如需清理工作目录，运行：")
    print("  rm .workflow/runtime/state.json")
    
    return 0


def main():
    """主函数"""
    parser = argparse.ArgumentParser(description="工作流管理脚本")
    subparsers = parser.add_subparsers(dest="command", help="命令")
    
    subparsers.add_parser("status", help="显示当前状态")
    subparsers.add_parser("start", help="启动工作流")
    
    next_parser = subparsers.add_parser("next", help="标记当前技能完成，进入下一个")
    next_parser.add_argument("--output", help="当前技能的产出物路径")
    
    skip_parser = subparsers.add_parser("skip", help="跳过当前技能")
    skip_parser.add_argument("--reason", default="", help="跳过原因")
    
    subparsers.add_parser("report", help="生成执行报告")
    subparsers.add_parser("archive", help="归档工作流")
    
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
    if args.command == "status":
        return cmd_status(workflow_root)
    elif args.command == "start":
        return cmd_start(workflow_root)
    elif args.command == "next":
        return cmd_next(workflow_root, args.output)
    elif args.command == "skip":
        return cmd_skip(workflow_root, args.reason)
    elif args.command == "report":
        return cmd_report(workflow_root)
    elif args.command == "archive":
        return cmd_archive(workflow_root)
    else:
        print(f"未知命令：{args.command}")
        return 1


if __name__ == "__main__":
    sys.exit(main())
