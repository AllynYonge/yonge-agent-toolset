#!/usr/bin/env python3
"""检查中文成稿的硬禁令与常见模型化形状。只报警，不自动改文。

默认只检查 SKILL.md 与 references/quality/revision.md 写明的硬禁令和形状提醒，不读任何配置。
每条结果带 revision.md 的规则编号，--json 输出的 issues 里同时给出 code、name 和 level。
传入 --profile、--extend 或 --length 时，额外检查账号配置的篇幅与规避词。
配置解析由 resolve_preferences.py 负责，本脚本不重复实现。
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, List


PIVOT_PATTERNS = (
    re.compile(r"(?:并)?不是[^。！？\n]{0,90}而是"),
    re.compile(r"并非[^。！？\n]{0,90}而是"),
    re.compile(r"不在于[^。！？\n]{0,90}而在于"),
    re.compile(r"与其说[^。！？\n]{0,90}(?:不如|毋宁|倒不如)"),
    re.compile(r"[。！？!?]\s*而是"),
    re.compile(r"表面(?:上)?[^。！？\n]{0,90}(?:其实|实际|实则)"),
    re.compile(r"看似[^。！？\n]{0,90}(?:其实|实际|实则)"),
)

SEMANTIC_PIVOT_PATTERNS = (
    re.compile(r"(?:总|一直|曾|都)?以为[^！？\n]{2,60}?(?:其实|才发现|才明白|才知道|后来才)"),
    re.compile(r"(?:总|都|一直)以为[^！？\n]{2,60}?[。，](?:可|但|其实)"),
    re.compile(r"回头(?:看|一看)?才(?:发现|明白|知道)"),
    re.compile(r"(?:并)?不是[^。！？\n]{1,40}，(?:更|才)?是[^，。！？\n]"),
    re.compile(r"从来(?:都)?(?:不是|与[^。！？，\n]{1,12}无关)"),
    re.compile(r"答案(?:是否定的|恰恰相反)|恰恰相反"),
    re.compile(r"表面(?:上)?[^！？\n]{0,60}。[^！？\n]{0,12}(?:其实|实际|实则)"),
    re.compile(r"看似[^！？\n]{0,60}。[^！？\n]{0,12}(?:其实|实际|实则)"),
    re.compile(r"[^，。！？\n]{1,12}不重要，(?:重要|要紧)的是"),
    re.compile(r"真正[^，。！？\n]{0,16}的(?:，)?是"),
    re.compile(r"不只(?:是)?[^。！？\n]{0,90}(?:还|也)"),
)

NOMINALIZATION_PATTERNS = (
    re.compile(r"进行(?:了|一次|一场|着)?[^。，！？\n]{0,10}(?:调整|优化|升级|分析|讨论|沟通|梳理|复盘|迭代|探索|尝试|思考|规划|布局)"),
    re.compile(r"实现了?[^。，！？\n]{0,14}的?[^。，！？\n]{0,6}(?:提升|增长|突破|转变|跃升|落地)"),
    re.compile(r"完成了?对[^。，！？\n]{0,16}的"),
    re.compile(r"起到了?[^。，！？\n]{0,12}的?作用"),
    re.compile(r"具有[^。，！？\n]{0,10}(?:意义|价值)"),
)

LEFT_BRANCH_PATTERNS = (
    re.compile(r"(?:^|[。！？]\s*)在[^，。！？\n]{12,70}(?:以后|之后|之前|以前|过程中|情况下|背景下)，"),
    re.compile(r"(?:^|[。！？]\s*)那些[^，。！？\n]{10,60}的[^，。！？\n]{2,30}[，。]"),
    re.compile(r"(?:^|[。！？]\s*)(?:真正|最终|最后)让[^，。！？\n]{8,70}的，是"),
)

# 每条结果的编号与 references/quality/revision.md 的小节一一对应，修改时按编号找修法。
RULE_NAMES = {
    "S2": "翻案腔",
    "S3": "排比",
    "S4": "假深刻",
    "S5": "名词化与翻译腔",
    "S6": "主干太晚",
    "S7": "节奏",
    "C1": "篇幅",
    "C2": "规避词",
}

CONSTRAINT_CODES = {"length": "C1", "avoid_word": "C2"}


@dataclass
class Paragraph:
    position: int
    text: str
    han: int
    sentences: int


def han_count(text: str) -> int:
    return len(re.findall(r"[\u4e00-\u9fff]", text))


def line_number(text: str, position: int) -> int:
    return text.count("\n", 0, position) + 1


def excerpt(value: str, width: int = 72) -> str:
    value = re.sub(r"\s+", " ", value).strip()
    return value if len(value) <= width else value[: width - 1] + "…"


def mask_non_prose(text: str) -> str:
    """屏蔽代码、网址和机器元数据，同时保留字符位置与换行。"""

    def mask(match: re.Match[str]) -> str:
        return "".join("\n" if char == "\n" else " " for char in match.group())

    patterns = (
        re.compile(r"\A---\s*\n.*?\n---\s*(?:\n|\Z)", re.DOTALL),
        re.compile(r"```.*?```", re.DOTALL),
        re.compile(r"`[^`\n]*`"),
        re.compile(r"\]\([^\n)]*\)"),
        re.compile(r"https?://[^\s)>]+"),
        re.compile(r"<[^>\n]+>"),
    )
    masked = text
    for pattern in patterns:
        masked = pattern.sub(mask, masked)
    return masked


def non_overlapping_terms(text: str, terms: tuple[str, ...]):
    matches = []
    occupied = []
    for term in sorted(terms, key=len, reverse=True):
        for match in re.finditer(re.escape(term), text):
            start, end = match.span()
            if any(start < old_end and end > old_start for old_start, old_end in occupied):
                continue
            matches.append((start, term))
            occupied.append((start, end))
    return sorted(matches)


def all_matches(text: str, patterns: tuple[re.Pattern[str], ...]):
    matches = []
    for pattern in patterns:
        matches.extend(pattern.finditer(text))
    return sorted(matches, key=lambda match: match.start())


def heavy_de_sentences(text: str):
    """找出主干可能被多个“的”压到后面的长句。"""

    matches = []
    pattern = re.compile(r"[^。！？!?\n]+(?:[。！？!?]|$)")
    for match in pattern.finditer(text):
        value = match.group()
        if han_count(value) >= 38 and value.count("的") >= 4:
            matches.append(match)
    return matches


def anaphora_runs(text: str, minimum: int = 3):
    """找出同一句里三个以上小句用同一个开头的排比。"""

    matches = []
    for sentence in re.finditer(r"[^。！？!?\n]+(?:[。！？!?]|$)", text):
        clauses = [
            clause.strip()
            for clause in re.split(r"[，、；,;]", sentence.group())
            if han_count(clause) >= 3
        ]
        if len(clauses) < minimum:
            continue
        run = 1
        for previous, current in zip(clauses, clauses[1:]):
            if previous[:2] == current[:2] and re.match(r"[一-鿿]{2}", current):
                run += 1
                if run >= minimum:
                    matches.append(sentence)
                    break
            else:
                run = 1
    return matches


def sentence_length_cv(text: str):
    """句长变异系数。人写的长短句差距大，模型的句长彼此接近。"""

    lengths = [
        han_count(match.group())
        for match in re.finditer(r"[^。！？!?\n]+[。！？!?]", text)
        if han_count(match.group()) >= 4
    ]
    if len(lengths) < 12:
        return None
    mean = sum(lengths) / len(lengths)
    if mean == 0:
        return None
    variance = sum((value - mean) ** 2 for value in lengths) / len(lengths)
    return (variance ** 0.5) / mean, len(lengths)


def bracket_highlights(text: str):
    """「」括起来的短语。太密说明在批量造金句。"""

    return list(re.finditer(r"[「『][^」』\n]{1,6}[」』]", text))


def prose_paragraphs(text: str) -> list[Paragraph]:
    paragraphs = []
    cursor = 0
    for block in re.split(r"\n\s*\n", text):
        position = text.find(block, cursor)
        cursor = max(position + len(block), cursor)
        clean = re.sub(r"[>*_`]", "", block).strip()
        if not clean or clean.startswith(("#", "http", "![", "```")):
            continue
        if re.match(r"^(?:[-+*]|\d+[.、])\s", clean):
            continue
        count = han_count(clean)
        if count < 4:
            continue
        sentences = max(1, len(re.findall(r"[。！？!?]", clean)))
        paragraphs.append(Paragraph(position, clean, count, sentences))
    return paragraphs
def short_streak(paragraphs: list[Paragraph], limit: int = 4):
    streak = []
    for paragraph in paragraphs:
        if paragraph.han <= 24 and paragraph.sentences <= 1:
            streak.append(paragraph)
            if len(streak) >= limit:
                return streak
        else:
            streak = []
    return None
def read_text(path: str) -> str:
    if path == "-":
        return sys.stdin.read()
    return Path(path).read_text(encoding="utf-8")


def visible_char_count(text: str) -> int:
    return len(re.sub(r"\s+", "", text))


# 文末“参考来源”区不是正文，不计入 length。标题行可带 # 前缀，也可以是纯文字行。
SOURCE_BLOCK = re.compile(r"(?m)^[ \t]*(?:#{1,6}[ \t]*)?参考来源[ \t]*$")


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


def build_report(article: str, constraints: Dict[str, Any]) -> Dict[str, Any]:
    from resolve_preferences import resolve_length_range

    length_range = resolve_length_range(constraints["length"])
    body = strip_source_block(article)
    char_count = visible_char_count(body)
    source_block_chars = visible_char_count(article) - char_count
    issues: List[Dict[str, Any]] = []
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
            issues.append(
                {
                    "type": "length",
                    "severity": "hard",
                    "message": f"字数 {char_count} 超过目标上限 {upper}（目标 {lower}-{upper}）",
                }
            )
        elif char_count < lower:
            # 低于下限只提醒：材料撑不住时宁可短，不为凑字数注水
            length_result["status"] = "under"
            warnings.append(
                {
                    "type": "length",
                    "severity": "soft",
                    "message": f"字数 {char_count} 低于目标下限 {lower}（目标 {lower}-{upper}）。材料不够时保持短稿，交稿时说明实际字数",
                }
            )

    hits = find_avoid_word_hits(article, constraints["avoid_words"])
    avoid_result = {
        "checked_words": constraints["avoid_words"],
        "hit_count": len(hits),
        "hits": hits,
        "status": "pass" if not hits else "fail",
    }
    for hit in hits:
        issues.append(
            {
                "type": "avoid_word",
                "severity": "hard",
                "message": f"规避词“{hit['word']}”，第 {hit['paragraph']} 段，“{hit['excerpt']}”",
                "word": hit["word"],
                "paragraph": hit["paragraph"],
                "excerpt": hit["excerpt"],
            }
        )

    return {
        "pass": not issues,
        "issues": issues,
        "warnings": warnings,
        "length": length_result,
        "avoid_words": avoid_result,
        "style_source": constraints["style_source"],
        "active_profile": constraints["effective_config"].get("_active_profile"),
    }


def check_constraints(text: str, args: argparse.Namespace):
    """按账号配置检查篇幅与规避词。未传配置参数时返回 None。"""
    requested = args.profile or args.extend or args.length
    if not requested:
        return None
    from resolve_preferences import ConfigError, resolve_constraints

    try:
        constraints = resolve_constraints(
            extend_path=args.extend,
            profile=args.profile,
            explicit_length=args.length,
        )
    except (OSError, ConfigError) as error:
        raise ValueError(f"配置解析失败。{error}") from error
    return build_report(text, constraints)


def main() -> int:
    parser = argparse.ArgumentParser(description="检查中文成稿的硬禁令与模型化形状")
    parser.add_argument("path", help="Markdown 或文本文件路径。使用 - 从标准输入读取")
    config_group = parser.add_argument_group("账号配置的篇幅与规避词检查")
    config_group.add_argument("--extend", help="EXTEND.md 路径，通常取 resolver 返回的 constraint_check_args")
    config_group.add_argument("--profile", help="账号名")
    config_group.add_argument("--length", help="本次覆盖的目标长度")
    config_group.add_argument(
        "--skill-root",
        default=os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
        help="human-writing 技能根目录",
    )
    parser.add_argument("--json", action="store_true", help="输出 JSON")
    args = parser.parse_args()

    try:
        text = read_text(args.path)
    except (OSError, UnicodeError) as error:
        print(f"无法读取稿件。{error}", file=sys.stderr)
        return 2

    try:
        constraint_report = check_constraints(text, args)
    except ValueError as error:
        print(str(error), file=sys.stderr)
        return 2

    prose = mask_non_prose(text)
    total_han = han_count(prose)
    if total_han == 0:
        print("没有检测到汉字。", file=sys.stderr)
        return 2

    failures = []
    warnings = []
    issues = []

    def record(level: str, code: str, message: str) -> None:
        name = RULE_NAMES[code]
        issues.append({"code": code, "name": name, "level": level, "message": message})
        (failures if level == "fail" else warnings).append(f"[{code} {name}] {message}")

    def fail(code: str, message: str) -> None:
        record("fail", code, message)

    def warn(code: str, message: str) -> None:
        record("warn", code, message)

    pivots = all_matches(prose, PIVOT_PATTERNS)
    for match in pivots:
        fail("S2",
            f"禁用翻案句，第 {line_number(text, match.start())} 行，"
            f"“{excerpt(match.group())}”"
        )

    occupied_spans = [match.span() for match in pivots]
    semantic_pivots = []
    for match in all_matches(prose, SEMANTIC_PIVOT_PATTERNS):
        if any(
            match.start() < end and match.end() > start
            for start, end in occupied_spans
        ):
            continue
        semantic_pivots.append(match)
        occupied_spans.append(match.span())
    for match in semantic_pivots:
        warn("S2",
            f"疑似翻案腔变形，第 {line_number(text, match.start())} 行，"
            f"“{excerpt(match.group(), 44)}”。先立误解再推翻就改成正面陈述，正常用法保留。"
        )

    anaphoras = anaphora_runs(prose)
    for match in anaphoras[:4]:
        warn("S3",
            f"三连以上同构排比，第 {line_number(text, match.start())} 行，"
            f"“{excerpt(match.group(), 44)}”。留两项，第三项换说法或删掉。"
        )

    nominalizations = all_matches(prose, NOMINALIZATION_PATTERNS)
    for match in nominalizations[:4]:
        warn("S5",
            f"名词化句式，第 {line_number(text, match.start())} 行，"
            f"“{excerpt(match.group(), 36)}”。还原成直接的动词。"
        )

    highlights = bracket_highlights(prose)
    highlight_limit = max(3, total_han // 700)
    if len(highlights) > highlight_limit:
        samples = "、".join(dict.fromkeys(match.group() for match in highlights[:6]))
        warn("S4",
            f"「」括起的短语共 {len(highlights)} 处。{samples}。太密说明在批量造金句。"
        )

    cv_result = sentence_length_cv(prose)
    if cv_result and cv_result[0] < 0.42:
        warn("S7",
            f"全文 {cv_result[1]} 个句子长度过于接近（变异系数 {cv_result[0]:.2f}）。"
            "人写的段落里十个字的句子会挨着四十个字的句子，放开几句，压短几句。"
        )

    left_branches = all_matches(prose, LEFT_BRANCH_PATTERNS)
    left_limit = max(2, total_han // 1200)
    if len(left_branches) > left_limit:
        samples = "；".join(
            f"第 {line_number(text, match.start())} 行“{excerpt(match.group(), 44)}”"
            for match in left_branches[:4]
        )
        warn("S6",
            f"长前置成分共 {len(left_branches)} 处，可能让主干来得太晚。{samples}"
        )

    dense_de = heavy_de_sentences(prose)
    dense_de_limit = max(1, total_han // 1500)
    if len(dense_de) > dense_de_limit:
        samples = "；".join(
            f"第 {line_number(text, match.start())} 行“{excerpt(match.group(), 44)}”"
            for match in dense_de[:4]
        )
        warn("S6",
            f"有 {len(dense_de)} 个长句包含四个以上的“的”，可能要先交代人和动作。{samples}"
        )

    paragraphs = prose_paragraphs(prose)
    if len(paragraphs) >= 10:
        one_sentence = sum(paragraph.sentences <= 1 for paragraph in paragraphs)
        ratio = one_sentence / len(paragraphs)
        if ratio >= 0.75:
            warn("S7",
                f"可识别段落中有 {ratio:.0%} 只有一句话，可能形成统一的短段鼓点。"
            )

    streak = short_streak(paragraphs)
    if streak:
        first = streak[0]
        warn("S7",
            f"从第 {line_number(text, first.position)} 行起连续出现 {len(streak)} 个短促单句段，"
            "检查是否在排队喊结论。"
        )



    if constraint_report is not None:
        for issue in constraint_report["issues"]:
            fail(CONSTRAINT_CODES[issue["type"]], issue["message"])
        for issue in constraint_report["warnings"]:
            warn(CONSTRAINT_CODES[issue["type"]], issue["message"])

    summary = (
        f"翻案句 {len(pivots)}，翻案腔变形 {len(semantic_pivots)}，"
        f"同构排比 {len(anaphoras)}，名词化 {len(nominalizations)}，"
        f"长前置成分 {len(left_branches)}，重定语句 {len(dense_de)}"
    )

    if args.json:
        payload = {
            "pass": not failures,
            "han_count": total_han,
            "failures": failures,
            "warnings": warnings,
            "issues": issues,
        }
        if constraint_report is not None:
            payload["constraints"] = {
                key: constraint_report[key]
                for key in ("length", "avoid_words", "style_source", "active_profile")
            }
        print(json.dumps(payload, ensure_ascii=False, indent=2))
        return 1 if failures else 0

    print(f"汉字数 {total_han}")
    if constraint_report is not None:
        length = constraint_report["length"]
        if length["status"] == "skipped":
            print("篇幅未设目标，跳过")
        else:
            print(
                f"篇幅 {length['visible_char_count']} 字（非空白字符，不含参考来源区"
                f"{length.get('source_block_chars', 0)} 字），"
                f"目标 {length['min']}-{length['max']}"
            )
    print(summary)
    if failures or warnings:
        print("每项开头的编号对应 references/quality/revision.md 的同名小节，按编号找修法。")

    if failures:
        print("\n需要修改")
        for item in failures:
            print(f"- {item}")

    if warnings:
        print("\n需要人工判断")
        for item in warnings:
            print(f"- {item}")

    if not failures and not warnings:
        print("\n未发现这份检查器覆盖的问题。")

    return 1 if failures else 0

if __name__ == "__main__":
    raise SystemExit(main())
