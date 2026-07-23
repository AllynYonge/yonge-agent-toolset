#!/usr/bin/env python3
"""跨迭代记忆：读写 results.tsv / experiments.jsonl / best_versions 快照。

放在目标 skill 自己的 test/memory/ 下（不引入独立 workspace）。
作用：grep 一下就知道"哪种改法有效、哪种失败过"，避免重复踩坑。
纯文件操作，只用标准库。

命令行自检：
    python3 memory.py init <target-skill-dir>
    python3 memory.py append <target-skill-dir> <tsv-row-json>
    python3 memory.py snapshot <target-skill-dir> <iter>
"""

from __future__ import annotations

import json
import shutil
import sys
from pathlib import Path

# results.tsv 的列顺序（每轮一行）
RESULTS_COLUMNS = [
    "iter", "commit", "layer", "metric", "delta",
    "pass_rate", "tokens", "status", "desc",
]
KEEP_SNAPSHOTS = 3  # best_versions 只留最近 N 份


def memory_dir(skill_dir: str | Path) -> Path:
    """返回目标 skill 的记忆目录 <skill>/test/memory/。"""
    return Path(skill_dir) / "test" / "memory"


def init(skill_dir: str | Path) -> Path:
    """创建记忆目录与文件（幂等）。返回记忆目录路径。"""
    mem = memory_dir(skill_dir)
    (mem / "best_versions").mkdir(parents=True, exist_ok=True)
    results = mem / "results.tsv"
    if not results.exists():
        header = "# metric_direction: higher_is_better\n" + "\t".join(RESULTS_COLUMNS) + "\n"
        results.write_text(header)
    (mem / "experiments.jsonl").touch(exist_ok=True)
    return mem


def append_result(skill_dir: str | Path, row: dict) -> None:
    """向 results.tsv 追加一行。row 用列名做键，缺的列填 '-'。"""
    mem = init(skill_dir)
    cells = [str(row.get(col, "-")) for col in RESULTS_COLUMNS]
    with (mem / "results.tsv").open("a") as f:
        f.write("\t".join(cells) + "\n")


def append_experiment(skill_dir: str | Path, record: dict) -> None:
    """向 experiments.jsonl 追加一条细粒度诊断记录（一行一个 JSON）。

    建议字段：iter / mutation_layer / intent / diagnosis(反事实) /
    cases_improved / cases_degraded / status / failure_reason
    """
    mem = init(skill_dir)
    with (mem / "experiments.jsonl").open("a") as f:
        f.write(json.dumps(record, ensure_ascii=False) + "\n")


def snapshot(skill_dir: str | Path, iteration: int | str) -> Path:
    """采纳一次改动时，把 skill 当前状态存进 best_versions/iter-N/。

    自动排除 test/、tmp、缓存等噪声，并只保留最近 KEEP_SNAPSHOTS 份。
    返回新快照目录路径。
    """
    skill_dir = Path(skill_dir)
    mem = init(skill_dir)
    dest = mem / "best_versions" / f"iter-{iteration}"
    if dest.exists():
        shutil.rmtree(dest)
    shutil.copytree(
        skill_dir, dest,
        ignore=shutil.ignore_patterns("test", "tmp", "__pycache__", "*.pyc", ".git"),
    )
    _prune_snapshots(mem / "best_versions")
    return dest


def _prune_snapshots(versions_dir: Path) -> None:
    """只保留最近 KEEP_SNAPSHOTS 份快照，按 iter 号数值排序删旧的。"""
    snaps = [d for d in versions_dir.iterdir() if d.is_dir() and d.name.startswith("iter-")]

    def _num(d: Path) -> int:
        tail = d.name.removeprefix("iter-")
        return int(tail) if tail.isdigit() else -1

    for old in sorted(snaps, key=_num)[:-KEEP_SNAPSHOTS]:
        shutil.rmtree(old)


def read_results(skill_dir: str | Path) -> list[dict]:
    """读回 results.tsv 为 dict 列表（跳过注释行和表头）。供诊断时观察趋势。"""
    results = memory_dir(skill_dir) / "results.tsv"
    if not results.exists():
        return []
    rows: list[dict] = []
    for line in results.read_text().splitlines():
        if not line.strip() or line.startswith("#") or line.startswith("iter\t"):
            continue
        cells = line.split("\t")
        rows.append(dict(zip(RESULTS_COLUMNS, cells)))
    return rows


def _cli() -> int:
    if len(sys.argv) < 3:
        print(__doc__)
        return 2
    cmd, skill_dir = sys.argv[1], sys.argv[2]
    if cmd == "init":
        print(init(skill_dir))
    elif cmd == "append" and len(sys.argv) >= 4:
        append_result(skill_dir, json.loads(sys.argv[3]))
        print("ok")
    elif cmd == "snapshot" and len(sys.argv) >= 4:
        print(snapshot(skill_dir, sys.argv[3]))
    else:
        print(__doc__)
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(_cli())
