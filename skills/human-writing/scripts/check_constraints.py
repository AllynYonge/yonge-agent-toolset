#!/usr/bin/env python3
"""按账号配置检查成稿的篇幅与规避词。只报警，不自动改文。

每条规则名对应 references/quality/review.md 里的同名小节，修改时按规则名找修法。
篇幅超过目标上限、命中规避词都按 fail 输出并返回退出码 1；篇幅低于下限只按 warn
提醒，因为材料撑不住时宁可短稿，不为凑字数注水。
配置解析由 resolve_preferences.py 负责，本脚本不重复实现。
模型化句式痕迹由 scripts/check_prose.py 检查。
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path
from typing import Any, Dict, List


REVIEW = "references/quality/review.md"

# 规则名对应审查维度文件里的同名小节，修改时按规则名找修法。
RULE_FILES = {
    "篇幅": REVIEW,
    "规避词": REVIEW,
}

CONSTRAINT_RULES = {"length": "篇幅", "avoid_word": "规避词"}

# 文末“参考来源”区不是正文，不计入篇幅。标题行可带 # 前缀，也可以是纯文字行。
SOURCE_BLOCK = re.compile(r"(?m)^[ \t]*(?:#{1,6}[ \t]*)?参考来源[ \t]*$")


def read_text(path: str) -> str:
    if path == "-":
        return sys.stdin.read()
    return Path(path).read_text(encoding="utf-8")


def visible_char_count(text: str) -> int:
    return len(re.sub(r"\s+", "", text))


def strip_source_block(text: str) -> str:
    match = SOURCE_BLOCK.search(text)
    return text[: match.start()] if match else text


def paragraph_number(text: str, offset: int) -> int:
    before = text[:offset]
    paragraphs = [p for p in re.split(r"\n\s*\n", before) if p.strip()]
    return max(1, len(paragraphs))


def excerpt_at(text: str, start: int, end: int, radius: int = 18) -> str:
    left = max(0, start - radius)
    right = min(len(text), end + radius)
    return re.sub(r"\s+", " ", text[left:right]).strip()


def find_avoid_word_hits(text: str, words: List[str]) -> List[Dict[str, Any]]:
    hits: List[Dict[str, Any]] = []
    for word in words:
        start = 0
        while True:
            index = text.find(word, start)
            if index == -1:
                break
            end = index + len(word)
            hits.append(
                {
                    "word": word,
                    "paragraph": paragraph_number(text, index),
                    "offset": index,
                    "excerpt": excerpt_at(text, index, end),
                }
            )
            start = end
    return sorted(hits, key=lambda item: (item["offset"], item["word"]))


def make_issue(name: str, level: str, message: str, **extra: Any) -> Dict[str, Any]:
    issue = {"name": name, "file": RULE_FILES[name], "level": level, "message": message}
    issue.update(extra)
    return issue


def build_report(article: str, constraints: Dict[str, Any]) -> Dict[str, Any]:
    from resolve_preferences import resolve_length_range

    length_range = resolve_length_range(constraints["length"])
    body = strip_source_block(article)
    char_count = visible_char_count(body)
    source_block_chars = visible_char_count(article) - char_count
    failures: List[Dict[str, Any]] = []
    warnings: List[Dict[str, Any]] = []

    length_result: Dict[str, Any] = {
        "configured_length": constraints["length"],
        "visible_char_count": char_count,
        "source_block_chars": source_block_chars,
        "status": "skipped" if length_range is None else "pass",
    }
    if length_range is not None:
        lower, upper, label = length_range
        length_result.update({"target": label, "min": lower, "max": upper})
        if char_count > upper:
            length_result["status"] = "fail"
            failures.append(make_issue(
                "篇幅", "fail",
                f"字数 {char_count} 超过目标上限 {upper}（目标 {lower}-{upper}）",
            ))
        elif char_count < lower:
            # 低于下限只提醒：材料撑不住时宁可短，不为凑字数注水
            length_result["status"] = "under"
            warnings.append(make_issue(
                "篇幅", "warn",
                f"字数 {char_count} 低于目标下限 {lower}（目标 {lower}-{upper}）。"
                "材料不够时保持短稿，交稿时说明实际字数",
            ))

    hits = find_avoid_word_hits(article, constraints["avoid_words"])
    avoid_result = {
        "checked_words": constraints["avoid_words"],
        "hit_count": len(hits),
        "hits": hits,
        "status": "pass" if not hits else "fail",
    }
    for hit in hits:
        failures.append(make_issue(
            "规避词", "fail",
            f"规避词“{hit['word']}”，第 {hit['paragraph']} 段，“{hit['excerpt']}”",
            word=hit["word"],
            paragraph=hit["paragraph"],
            excerpt=hit["excerpt"],
        ))

    return {
        "pass": not failures,
        "issues": failures + warnings,
        "failures": [f"[{issue['name']}] {issue['message']}" for issue in failures],
        "warnings": [f"[{issue['name']}] {issue['message']}" for issue in warnings],
        "length": length_result,
        "avoid_words": avoid_result,
        "style_source": constraints["style_source"],
        "active_profile": constraints["effective_config"].get("_active_profile"),
    }


def main() -> int:
    parser = argparse.ArgumentParser(
        description="按账号配置检查成稿的篇幅与规避词，只报警不改文"
    )
    parser.add_argument("path", help="Markdown 或文本文件路径。使用 - 从标准输入读取")
    config_group = parser.add_argument_group("账号配置")
    config_group.add_argument("--extend", help="EXTEND.md 路径，通常取 resolver 返回的 constraint_check_args")
    config_group.add_argument("--profile", help="账号名")
    config_group.add_argument("--length", help="本次覆盖的目标长度")
    parser.add_argument("--json", action="store_true", help="输出 JSON")
    args = parser.parse_args()

    try:
        text = read_text(args.path)
    except (OSError, UnicodeError) as error:
        print(f"无法读取稿件。{error}", file=sys.stderr)
        return 2

    from resolve_preferences import ConfigError, resolve_constraints

    try:
        constraints = resolve_constraints(
            extend_path=args.extend,
            profile=args.profile,
            explicit_length=args.length,
        )
    except (OSError, ConfigError) as error:
        print(f"配置解析失败。{error}", file=sys.stderr)
        return 2

    report = build_report(text, constraints)

    if args.json:
        print(json.dumps(report, ensure_ascii=False, indent=2))
        return 1 if report["failures"] else 0

    length = report["length"]
    if length["status"] == "skipped":
        print("篇幅未设目标，跳过")
    else:
        print(
            f"篇幅 {length['visible_char_count']} 字（非空白字符，不含参考来源区 "
            f"{length.get('source_block_chars', 0)} 字），目标 {length['min']}-{length['max']}"
        )

    avoid = report["avoid_words"]
    print(f"规避词 命中 {avoid['hit_count']} 处，已检查 {len(avoid['checked_words'])} 个词")

    if report["failures"] or report["warnings"]:
        print(f"每项开头是规则名，修法见 {REVIEW} 的同名小节。")

    if report["failures"]:
        print("\n需要修改")
        for item in report["failures"]:
            print(f"- {item}")

    if report["warnings"]:
        print("\n需要人工判断")
        for item in report["warnings"]:
            print(f"- {item}")

    if not report["failures"] and not report["warnings"]:
        print("\n未发现这份检查器覆盖的问题。")

    return 1 if report["failures"] else 0


if __name__ == "__main__":
    raise SystemExit(main())
