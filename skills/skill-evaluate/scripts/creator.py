#!/usr/bin/env python3
"""定位已安装的 skill-creator，并暴露对它现成能力的薄封装。

skill-evaluate 复用 skill-creator（"引用而非复制"）来避免重造轮子：
结构校验、触发/描述优化、基线对比数值汇总、浏览器审阅界面、打包。
本模块只负责"找到它 + 调它"，不复制它的逻辑——creator 升级后本技能自动受益。

命令行自检：
    python3 creator.py --which          # 打印找到的 skill-creator 路径
    python3 creator.py --validate <skill-dir>   # 调 quick_validate.py
"""

from __future__ import annotations

import glob
import os
import subprocess
import sys
from pathlib import Path

# 缓存首次解析结果，避免重复扫描文件系统
_cached: Path | None = None
_resolved = False


class CreatorNotFoundError(RuntimeError):
    """skill-creator 未安装或找不到时抛出，附带安装指引。"""


def _search_paths() -> list[str]:
    """按优先级列出候选路径（字符串，含 glob 通配）。"""
    home = Path.home()
    env = os.environ.get("SKILL_CREATOR_PATH")
    paths: list[str] = []
    if env:
        paths.append(env)
    paths += [
        str(home / ".claude/plugins/marketplaces/*/plugins/skill-creator/skills/skill-creator"),
        str(home / ".claude/plugins/marketplaces/*/plugins/skill-creator"),
        str(home / ".claude/plugins/skill-creator/skills/skill-creator"),
        str(home / ".claude/plugins/skill-creator/plugin/skills/skill-creator"),
        str(home / ".claude/skills/skill-creator"),
        str(home / ".claude/skills/.system/skill-creator"),
        ".claude/skills/skill-creator",
    ]
    return paths


def find_creator() -> Path | None:
    """返回 skill-creator 目录路径，找不到返回 None。

    判定标准：目录存在且内含 SKILL.md（确认是个真 skill 而非空目录）。
    """
    for pattern in _search_paths():
        for hit in sorted(glob.glob(pattern)):
            p = Path(hit)
            if (p / "SKILL.md").exists():
                return p
    return None


def require_creator() -> Path:
    """返回 skill-creator 路径，找不到就抛错并给出安装指引。

    为什么不静默降级：evaluate 的结构门控、描述优化、审阅界面都依赖它，
    悄悄跳过会让用户以为"检查过了"，反而更危险——所以宁可明确报错。
    """
    global _cached, _resolved
    if _resolved:
        if _cached is not None:
            return _cached
        _raise_not_found()
    _cached = find_creator()
    _resolved = True
    if _cached is None:
        _raise_not_found()
    return _cached


def _raise_not_found() -> None:
    env_val = os.environ.get("SKILL_CREATOR_PATH", "未设置")
    raise CreatorNotFoundError(
        "找不到 skill-creator，而 skill-evaluate 的结构校验/描述优化/审阅界面依赖它。\n\n"
        "安装方式：\n"
        "  1. 插件市场（推荐）：在 Claude Code 里运行 /install skill-creator\n"
        "  2. 从 GitHub 手动安装：\n"
        "     git clone https://github.com/anthropics/skills.git /tmp/anthropic-skills\n"
        "     cp -r /tmp/anthropic-skills/skills/skill-creator ~/.claude/skills/skill-creator\n"
        "  3. 已装在别处：export SKILL_CREATOR_PATH=/your/path/to/skill-creator\n\n"
        f"已按顺序搜索（$SKILL_CREATOR_PATH={env_val}），均未命中。"
    )


def agent_path(agent_name: str) -> Path:
    """返回 creator 的某个 agent 定义文件路径，如 'grader.md'。"""
    creator = require_creator()
    p = creator / "agents" / agent_name
    if not p.exists():
        raise FileNotFoundError(
            f"creator agent '{agent_name}' 不存在于 {p}，你的 skill-creator 可能已过期。"
        )
    return p


def _run(script_rel: str, args: list[str]) -> subprocess.CompletedProcess:
    """在 creator 目录下用 `python3 -m scripts.<name>` 方式运行它的脚本。

    creator 脚本内部用 `from scripts.utils import ...` 这类包内导入，
    所以必须把 cwd 设为 creator 根目录、以模块方式启动，否则导入会失败。
    """
    creator = require_creator()
    module = "scripts." + script_rel.removesuffix(".py")
    return subprocess.run(
        [sys.executable, "-m", module, *args],
        cwd=str(creator),
        capture_output=True,
        text=True,
    )


def quick_validate(skill_dir: str | Path) -> tuple[bool, str]:
    """调 creator 的 quick_validate.py 校验 skill 结构/frontmatter。

    返回 (是否通过, 说明)。用作 L1 门控的"结构合规"检查。
    """
    proc = _run("quick_validate.py", [str(skill_dir)])
    msg = (proc.stdout or proc.stderr).strip()
    return proc.returncode == 0, msg


def run_eval(eval_set: str | Path, skill_dir: str | Path, model: str,
             extra: list[str] | None = None) -> subprocess.CompletedProcess:
    """调 creator 的 run_eval.py 做触发准确率评估。参数透传，结果原样返回。"""
    args = ["--eval-set", str(eval_set), "--skill-path", str(skill_dir), "--model", model]
    return _run("run_eval.py", args + (extra or []))


def aggregate_benchmark(iteration_dir: str | Path, skill_name: str) -> subprocess.CompletedProcess:
    """调 creator 的 aggregate_benchmark.py 汇总基线对比数值。"""
    return _run("aggregate_benchmark.py", [str(iteration_dir), "--skill-name", skill_name])


def package_skill(skill_dir: str | Path) -> subprocess.CompletedProcess:
    """调 creator 的 package_skill.py 打包成 .skill。"""
    return _run("package_skill.py", [str(skill_dir)])


def generate_review_cmd(iteration_dir: str | Path, skill_name: str,
                        static_out: str | Path | None = None) -> list[str]:
    """返回启动 creator 审阅界面的命令行（供调用方 nohup 后台运行）。

    不直接执行——审阅界面是长驻进程，交给调用方决定前台/后台/静态输出。
    """
    creator = require_creator()
    cmd = [sys.executable, str(creator / "eval-viewer/generate_review.py"),
           str(iteration_dir), "--skill-name", skill_name]
    if static_out:
        cmd += ["--static", str(static_out)]
    return cmd


if __name__ == "__main__":
    if len(sys.argv) >= 2 and sys.argv[1] == "--which":
        try:
            print(require_creator())
        except CreatorNotFoundError as e:
            print(e, file=sys.stderr)
            sys.exit(1)
    elif len(sys.argv) >= 3 and sys.argv[1] == "--validate":
        ok, msg = quick_validate(sys.argv[2])
        print(msg)
        sys.exit(0 if ok else 1)
    else:
        print(__doc__)
        sys.exit(2)
