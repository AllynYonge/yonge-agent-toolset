#!/usr/bin/env python3
"""Shared config helpers for the human-writing self-media route.

Library module only; run `check_prose.py` or `resolve_preferences.py` instead.
It intentionally avoids third-party YAML dependencies and supports the subset
of YAML used by EXTEND.md and references/publish/styles/*.md frontmatter.
"""

from __future__ import annotations

import math
import os
import re
from typing import Any, Dict, Iterable, List, Optional, Tuple


LENGTH_PRESETS = {
    "short": (300, 500),
    "medium": (1000, 2000),
    "long": (2500, 4000),
}

DEFAULTS = {
    "length": "auto",
    "long_threshold": 3000,
}


class ConfigError(Exception):
    pass


def strip_inline_comment(value: str) -> str:
    in_single = False
    in_double = False
    for index, char in enumerate(value):
        if char == "'" and not in_double:
            in_single = not in_single
        elif char == '"' and not in_single:
            in_double = not in_double
        elif char == "#" and not in_single and not in_double:
            if index == 0 or value[index - 1].isspace():
                return value[:index].rstrip()
    return value.rstrip()


def parse_scalar(value: str) -> Any:
    value = strip_inline_comment(value.strip())
    if value == "":
        return ""
    if (value.startswith('"') and value.endswith('"')) or (
        value.startswith("'") and value.endswith("'")
    ):
        return value[1:-1]
    if value.startswith("[") and value.endswith("]"):
        body = value[1:-1].strip()
        if not body:
            return []
        return [parse_scalar(item.strip()) for item in body.split(",")]
    if value in {"true", "True"}:
        return True
    if value in {"false", "False"}:
        return False
    if re.fullmatch(r"-?\d+", value):
        return int(value)
    return value


def prepare_yaml_lines(text: str) -> List[Tuple[int, str]]:
    lines: List[Tuple[int, str]] = []
    for raw in text.splitlines():
        if not raw.strip() or raw.lstrip().startswith("#"):
            continue
        indent = len(raw) - len(raw.lstrip(" "))
        lines.append((indent, raw.strip()))
    return lines


def parse_block(lines: List[Tuple[int, str]], start: int, indent: int) -> Tuple[Any, int]:
    if start >= len(lines):
        return {}, start

    if lines[start][1].startswith("- "):
        result: List[Any] = []
        index = start
        while index < len(lines):
            line_indent, stripped = lines[index]
            if line_indent < indent or not stripped.startswith("- "):
                break
            if line_indent > indent:
                break
            item = stripped[2:].strip()
            if item == "":
                nested, index = parse_block(lines, index + 1, indent + 2)
                result.append(nested)
                continue
            if ":" in item and not item.startswith(("'", '"')):
                key, value = item.split(":", 1)
                item_dict: Dict[str, Any] = {}
                if value.strip():
                    item_dict[key.strip()] = parse_scalar(value.strip())
                    index += 1
                else:
                    nested, index = parse_block(lines, index + 1, indent + 2)
                    item_dict[key.strip()] = nested
                result.append(item_dict)
                continue
            result.append(parse_scalar(item))
            index += 1
        return result, index

    result_dict: Dict[str, Any] = {}
    index = start
    while index < len(lines):
        line_indent, stripped = lines[index]
        if line_indent < indent:
            break
        if line_indent > indent:
            index += 1
            continue
        if stripped.startswith("- "):
            break
        if ":" not in stripped:
            index += 1
            continue
        key, value = stripped.split(":", 1)
        key = key.strip()
        value = value.strip()
        if value:
            result_dict[key] = parse_scalar(value)
            index += 1
        else:
            nested, index = parse_block(lines, index + 1, indent + 2)
            result_dict[key] = nested
    return result_dict, index


def parse_simple_yaml(text: str) -> Dict[str, Any]:
    parsed, _ = parse_block(prepare_yaml_lines(text), 0, 0)
    if isinstance(parsed, dict):
        return parsed
    raise ConfigError("YAML root must be an object")


def extract_frontmatter(text: str) -> Dict[str, Any]:
    if not text.startswith("---"):
        return {}
    match = re.match(r"^---\s*\n(.*?)\n---(?:\s*\n|$)", text, re.S)
    if not match:
        raise ConfigError("EXTEND.md frontmatter starts with --- but has no closing ---")
    return parse_simple_yaml(match.group(1))


def read_text(path: str) -> str:
    with open(path, "r", encoding="utf-8") as handle:
        return handle.read()


def load_yaml_file(path: str, frontmatter: bool = False) -> Dict[str, Any]:
    if not path or not os.path.exists(path):
        return {}
    text = read_text(path)
    return extract_frontmatter(text) if frontmatter else parse_simple_yaml(text)


GLOBAL_KEYS = {"default_profile", "long_threshold", "avoid_words"}


def merge_effective_config(base: Dict[str, Any], profile_name: Optional[str]) -> Dict[str, Any]:
    global_fields = {k: v for k, v in base.items() if k in GLOBAL_KEYS or not isinstance(v, dict)}
    accounts = {k: v for k, v in base.items() if isinstance(v, dict) and k not in GLOBAL_KEYS}

    config = dict(global_fields)

    if profile_name:
        if profile_name not in accounts:
            available = ", ".join(sorted(accounts.keys())) or "(none)"
            raise ConfigError(f"profile '{profile_name}' not found. Available: {available}")
        config.update(accounts[profile_name])
        config["_active_profile"] = profile_name
        return config

    default_profile = base.get("default_profile")
    if default_profile and default_profile in accounts:
        config.update(accounts[default_profile])
        config["_active_profile"] = default_profile
    elif accounts:
        first_account = next(iter(accounts))
        config.update(accounts[first_account])
        config["_active_profile"] = first_account
    return config


def unique_words(groups: Iterable[Iterable[Any]]) -> List[str]:
    seen = set()
    words: List[str] = []
    for group in groups:
        if isinstance(group, str):
            items = [w.strip() for w in group.split("|")]
        else:
            items = group or []
        for item in items:
            word = str(item).strip()
            if word and word not in seen:
                seen.add(word)
                words.append(word)
    return words


def style_path(skill_root: str, style_name: str) -> str:
    return os.path.join(skill_root, "references", "publish", "styles", f"{style_name}.md")


def resolve_constraints(
    skill_root: str,
    extend_path: Optional[str],
    profile: Optional[str],
    explicit_length: Optional[str],
    explicit_style: Optional[str],
    extra_avoid_words: List[str],
) -> Dict[str, Any]:
    base = dict(DEFAULTS)
    extend_config: Dict[str, Any] = {}
    if extend_path:
        extend_config = load_yaml_file(extend_path, frontmatter=True)
        base.update(extend_config)

    effective = merge_effective_config(base, profile)

    if explicit_length is not None:
        effective["length"] = parse_scalar(explicit_length)
    if explicit_style is not None:
        effective["writing_style"] = explicit_style

    custom_style = effective.get("custom_style") or {}
    style_name = effective.get("writing_style")
    if custom_style:
        style_config = custom_style
        style_source: Optional[str] = "custom_style"
    elif style_name not in (None, "", "auto"):
        style_name = str(style_name)
        path = style_path(skill_root, style_name)
        if not os.path.exists(path):
            raise ConfigError(f"style preset '{style_name}' not found at {path}")
        style_config = load_yaml_file(path, frontmatter=True)
        style_source = path
    else:
        # No style configured: no preset words_to_avoid, SKILL.md default prose applies.
        style_config = {}
        style_source = None

    avoid_words = unique_words(
        [
            style_config.get("words_to_avoid", []),
            effective.get("avoid_words", []),
            extra_avoid_words,
        ]
    )

    return {
        "effective_config": effective,
        "style_source": style_source,
        "length": effective.get("length", "auto"),
        "avoid_words": avoid_words,
    }


def resolve_length_range(length_value: Any) -> Optional[Tuple[int, int, str]]:
    if length_value is None or length_value == "auto":
        return None
    if isinstance(length_value, int):
        lower = math.floor(length_value * 0.85)
        upper = math.ceil(length_value * 1.15)
        return lower, upper, f"{length_value} +/-15%"
    value = str(length_value).strip()
    if value in LENGTH_PRESETS:
        lower, upper = LENGTH_PRESETS[value]
        return lower, upper, value
    range_match = re.fullmatch(r"(\d+)\s*[-~到至]\s*(\d+)", value)
    if range_match:
        lower = int(range_match.group(1))
        upper = int(range_match.group(2))
        if lower > upper:
            lower, upper = upper, lower
        return lower, upper, value
    raise ConfigError(f"unrecognized length value: {length_value!r}")


def visible_char_count(text: str) -> int:
    return len(re.sub(r"\s+", "", text))


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
    length_range = resolve_length_range(constraints["length"])
    char_count = visible_char_count(article)
    issues: List[Dict[str, Any]] = []
    warnings: List[Dict[str, Any]] = []

    length_result: Dict[str, Any] = {
        "configured_length": constraints["length"],
        "visible_char_count": char_count,
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
