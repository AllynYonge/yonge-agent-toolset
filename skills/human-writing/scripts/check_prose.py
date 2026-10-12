#!/usr/bin/env python3
"""检查中文成稿的模型化形状：同构排比与节奏。只报警，不自动改文。

每条规则名对应 references/quality/ai-traces.md 里的同名小节，修改时按规则名找修法。
命中一律按 fail 输出并返回退出码 1，供复审子代理当作必须处理的门禁。
本脚本只判断形状，不读任何账号配置；篇幅与规避词由 scripts/check_constraints.py 检查。
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, List


AI_TRACES = "references/quality/ai-traces.md"

# 规则名对应审查维度文件里的同名小节，修改时按规则名找修法。
RULE_FILES = {
    "排比": AI_TRACES,
    "节奏": AI_TRACES,
}

# 下面的刻度是脚本判断形状的阈值，改动同时要核对 ai-traces.md 对应小节的说明。
ANAPHORA_LIMIT = 4  # 排比最多报几处，超出部分同类不重复
SENTENCE_CV_MIN = 0.42  # 句长变异系数下限，低于它算长短句差距太小
MIN_SENTENCES = 12  # 句子太少时变异系数不可信
MIN_PARAGRAPHS = 10  # 段落太少时单句段占比不可信
ONE_SENTENCE_RATIO = 0.75  # 单句段占比上限，达到它算短段鼓点
SHORT_PARAGRAPH_HAN = 24  # 短段字数上限
SHORT_STREAK_MIN = 4  # 连续几个短促单句段算排队喊结论


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
    if len(lengths) < MIN_SENTENCES:
        return None
    mean = sum(lengths) / len(lengths)
    if mean == 0:
        return None
    variance = sum((value - mean) ** 2 for value in lengths) / len(lengths)
    return (variance ** 0.5) / mean, len(lengths)


def prose_paragraphs(text: str) -> List[Paragraph]:
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


def short_streak(paragraphs: List[Paragraph]):
    """连续多个短促单句段。"""

    streak = []
    for paragraph in paragraphs:
        if paragraph.han <= SHORT_PARAGRAPH_HAN and paragraph.sentences <= 1:
            streak.append(paragraph)
            if len(streak) >= SHORT_STREAK_MIN:
                return streak
        else:
            streak = []
    return None


def read_text(path: str) -> str:
    if path == "-":
        return sys.stdin.read()
    return Path(path).read_text(encoding="utf-8")


def find_shape_issues(text: str) -> List[Dict[str, Any]]:
    """返回排比与节奏的命中项，每项含 name、file、level 和说明失败原因的消息。"""

    prose = mask_non_prose(text)
    issues: List[Dict[str, Any]] = []

    def record(name: str, message: str) -> None:
        issues.append({"name": name, "file": RULE_FILES[name], "level": "fail", "message": message})

    anaphoras = anaphora_runs(prose)
    for match in anaphoras[:ANAPHORA_LIMIT]:
        record(
            "排比",
            f"第 {line_number(text, match.start())} 行三连以上同构排比，"
            f"“{excerpt(match.group(), 44)}”。同一个句型连排三次是在抬价，"
            "留两项，第三项换说法或删掉。",
        )

    cv_result = sentence_length_cv(prose)
    if cv_result and cv_result[0] < SENTENCE_CV_MIN:
        record(
            "节奏",
            f"全文 {cv_result[1]} 个句子长度过于接近（变异系数 {cv_result[0]:.2f}，"
            f"低于 {SENTENCE_CV_MIN}），读起来是齐整的机器节奏。"
            "挑一句压到十个字以内，或者放开一句让它长过三十字。",
        )

    paragraphs = prose_paragraphs(prose)
    if len(paragraphs) >= MIN_PARAGRAPHS:
        one_sentence = sum(paragraph.sentences <= 1 for paragraph in paragraphs)
        ratio = one_sentence / len(paragraphs)
        if ratio >= ONE_SENTENCE_RATIO:
            record(
                "节奏",
                f"可识别段落中 {len(paragraphs)} 段里有 {ratio:.0%} 只有一句话，"
                "会形成统一的短段鼓点。合并其中能顺着读下去的部分。",
            )

    streak = short_streak(paragraphs)
    if streak:
        record(
            "节奏",
            f"从第 {line_number(text, streak[0].position)} 行起连续 {len(streak)} 个短促单句段"
            f"（每段不超过 {SHORT_PARAGRAPH_HAN} 字），是在排队喊结论。"
            "合并其中能顺着读下去的部分。",
        )

    return issues


def main() -> int:
    parser = argparse.ArgumentParser(
        description="检查中文成稿的模型化形状（排比、节奏），只报警不改文"
    )
    parser.add_argument("path", help="Markdown 或文本文件路径。使用 - 从标准输入读取")
    parser.add_argument("--json", action="store_true", help="输出 JSON")
    args = parser.parse_args()

    try:
        text = read_text(args.path)
    except (OSError, UnicodeError) as error:
        print(f"无法读取稿件。{error}", file=sys.stderr)
        return 2

    total_han = han_count(mask_non_prose(text))
    if total_han == 0:
        print("没有检测到汉字。", file=sys.stderr)
        return 2

    issues = find_shape_issues(text)
    failures = [f"[{issue['name']}] {issue['message']}" for issue in issues]

    if args.json:
        print(json.dumps(
            {
                "pass": not issues,
                "han_count": total_han,
                "failures": failures,
                "warnings": [],
                "issues": issues,
            },
            ensure_ascii=False,
            indent=2,
        ))
        return 1 if issues else 0

    print(f"汉字数 {total_han}")
    print(
        f"同构排比 {sum(issue['name'] == '排比' for issue in issues)} 处，"
        f"节奏 {sum(issue['name'] == '节奏' for issue in issues)} 处。"
        f"每项开头是规则名，修法见 {AI_TRACES} 的同名小节"
    )

    if not issues:
        print("\n未发现这份检查器覆盖的问题。")
        return 0

    print("\n需要修改")
    for item in failures:
        print(f"- {item}")

    return 1


if __name__ == "__main__":
    raise SystemExit(main())
