#!/usr/bin/env python3
"""进步棘轮：把每次实验固化成一次提交，丢弃时能干净回滚。

为什么要棘轮：迭代会做很多次尝试，采纳的要锁住、丢弃的要能退回。
git 是最可靠的做法（每个实验一个 commit，丢弃用 git revert 保留失败历史）。

git 是可选的：有 git 就用（没仓库自动 init）；没有 git 就退化成目录快照 +
从快照恢复。这样守住 skill-evaluate 自包含的习惯，不把 git 设成硬门槛。

命令行自检：
    python3 ratchet.py status <skill-dir>
"""

from __future__ import annotations

import shutil
import subprocess
import sys
from pathlib import Path


def _git(skill_dir: Path, *args: str) -> subprocess.CompletedProcess:
    return subprocess.run(
        ["git", "-C", str(skill_dir), *args],
        capture_output=True, text=True,
    )


def git_available() -> bool:
    """git 二进制是否在 PATH 上。"""
    return shutil.which("git") is not None


def is_repo(skill_dir: str | Path) -> bool:
    """该目录是否已在 git 仓库内。"""
    if not git_available():
        return False
    p = _git(Path(skill_dir), "rev-parse", "--is-inside-work-tree")
    return p.returncode == 0 and p.stdout.strip() == "true"


def ensure_repo(skill_dir: str | Path) -> bool:
    """确保处于 git 跟踪下。返回 True=用 git，False=需退化为快照模式。

    没装 git → 退化。装了但没 init → 自动 init 并首提。
    """
    skill_dir = Path(skill_dir)
    if not git_available():
        return False
    if is_repo(skill_dir):
        return True
    _git(skill_dir, "init")
    _git(skill_dir, "add", ".")
    _git(skill_dir, "commit", "-m", "chore: init git for skill-evaluate tracking")
    return is_repo(skill_dir)


def commit(skill_dir: str | Path, layer: str, message: str) -> str | None:
    """把当前改动提交为一个实验。返回短 commit hash，退化模式返回 None。

    layer ∈ {description, body, script}，用于 commit message 前缀，
    也让 `git log` 一眼看出每轮改的是哪层。
    """
    skill_dir = Path(skill_dir)
    if not ensure_repo(skill_dir):
        return None
    _git(skill_dir, "add", "-A")
    _git(skill_dir, "commit", "-m", f"experiment({layer}): {message}")
    p = _git(skill_dir, "rev-parse", "--short", "HEAD")
    return p.stdout.strip() or None


def revert_last(skill_dir: str | Path) -> bool:
    """丢弃上一次实验：git revert HEAD（保留失败历史，不丢记录）。

    用 revert 而非 reset 的原因：失败的尝试本身是记忆的一部分，
    下次诊断时能看到"这个方向试过、没用"，避免重复踩坑。
    """
    skill_dir = Path(skill_dir)
    if not is_repo(skill_dir):
        return False
    p = _git(skill_dir, "revert", "HEAD", "--no-edit")
    return p.returncode == 0


def status(skill_dir: str | Path) -> str:
    """返回一句话说明当前棘轮模式，供人排查。"""
    if not git_available():
        return "git 未安装 → 退化为目录快照模式（best_versions 恢复）"
    if is_repo(skill_dir):
        return "git 可用且已在仓库内 → 使用 commit/revert 棘轮"
    return "git 可用但目录未初始化 → 首次 commit 时会自动 git init"


if __name__ == "__main__":
    if len(sys.argv) >= 3 and sys.argv[1] == "status":
        print(status(sys.argv[2]))
    else:
        print(__doc__)
        sys.exit(2)
