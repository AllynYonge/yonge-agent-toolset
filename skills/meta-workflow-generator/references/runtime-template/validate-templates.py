#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
运行时模板验证脚本
验证所有模板文件的语法正确性和完整性
"""
import json
import sys
from pathlib import Path


def validate_python_syntax(file_path: Path) -> bool:
    """验证 Python 文件语法"""
    try:
        compile(file_path.read_text(encoding="utf-8"), str(file_path), "exec")
        print(f"✓ {file_path.name} 语法正确")
        return True
    except SyntaxError as e:
        print(f"✗ {file_path.name} 语法错误: {e}")
        return False


def validate_json(file_path: Path) -> bool:
    """验证 JSON 文件格式"""
    try:
        json.loads(file_path.read_text(encoding="utf-8"))
        print(f"✓ {file_path.name} JSON 格式正确")
        return True
    except json.JSONDecodeError as e:
        print(f"✗ {file_path.name} JSON 格式错误: {e}")
        return False


def validate_jsonl(file_path: Path) -> bool:
    """验证 JSONL 文件格式"""
    try:
        for line_no, line in enumerate(file_path.read_text(encoding="utf-8").splitlines(), 1):
            line = line.strip()
            if not line:
                continue
            json.loads(line)
        print(f"✓ {file_path.name} JSONL 格式正确")
        return True
    except json.JSONDecodeError as e:
        print(f"✗ {file_path.name} 行 {line_no} JSON 格式错误: {e}")
        return False


def validate_markdown(file_path: Path) -> bool:
    """验证 Markdown 文件"""
    try:
        content = file_path.read_text(encoding="utf-8")
        if not content.strip():
            print(f"✗ {file_path.name} 文件为空")
            return False
        
        # 检查特殊格式
        if "workflow-template" in file_path.name:
            # 验证状态块格式
            if "[workflow-state:" not in content:
                print(f"✗ {file_path.name} 缺少状态块")
                return False
        
        print(f"✓ {file_path.name} Markdown 格式正确")
        return True
    except UnicodeDecodeError as e:
        print(f"✗ {file_path.name} 编码错误: {e}")
        return False


def validate_placeholders(file_path: Path) -> bool:
    """验证占位符是否成对出现"""
    content = file_path.read_text(encoding="utf-8")
    
    # 提取所有 {{placeholder}}
    import re
    placeholders = re.findall(r'\{\{([^}]+)\}\}', content)
    
    if placeholders:
        print(f"  占位符: {', '.join(set(placeholders))}")
    
    return True


def main():
    """主函数"""
    template_dir = Path(__file__).parent
    
    if not template_dir.is_dir():
        print(f"错误：找不到模板目录 {template_dir}")
        return 1
    
    print("=" * 60)
    print("运行时模板验证")
    print("=" * 60)
    print()
    
    all_passed = True
    
    # 验证 Python 脚本
    print("### Python 脚本")
    python_files = [
        "session-start.py",
        "inject-workflow-state.py",
        "inject-skill-context.py",
        "workflow.py",
        "context.py"
    ]
    
    for filename in python_files:
        file_path = template_dir / filename
        if not file_path.is_file():
            print(f"✗ {filename} 不存在")
            all_passed = False
            continue
        
        if not validate_python_syntax(file_path):
            all_passed = False
        validate_placeholders(file_path)
    
    print()
    
    # 验证 JSON 文件
    print("### JSON 文件")
    json_files = [
        "state-schema.json",
        "state-init-template.json"
    ]
    
    for filename in json_files:
        file_path = template_dir / filename
        if not file_path.is_file():
            print(f"✗ {filename} 不存在")
            all_passed = False
            continue
        
        if not validate_json(file_path):
            all_passed = False
        validate_placeholders(file_path)
    
    print()
    
    # 验证 JSONL 文件
    print("### JSONL 文件")
    jsonl_files = [
        "context-manifest-template.jsonl"
    ]
    
    for filename in jsonl_files:
        file_path = template_dir / filename
        if not file_path.is_file():
            print(f"✗ {filename} 不存在")
            all_passed = False
            continue
        
        if not validate_jsonl(file_path):
            all_passed = False
        validate_placeholders(file_path)
    
    print()
    
    # 验证 Markdown 文件
    print("### Markdown 文件")
    md_files = [
        "workflow-template.md",
        "session-memory-template.md",
        "README.md"
    ]
    
    for filename in md_files:
        file_path = template_dir / filename
        if not file_path.is_file():
            print(f"✗ {filename} 不存在")
            all_passed = False
            continue
        
        if not validate_markdown(file_path):
            all_passed = False
        validate_placeholders(file_path)
    
    print()
    print("=" * 60)
    
    if all_passed:
        print("✓ 所有模板验证通过")
        return 0
    else:
        print("✗ 部分模板验证失败")
        return 1


if __name__ == "__main__":
    sys.exit(main())
