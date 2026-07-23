#!/usr/bin/env python3
"""Deterministic checks for human-media-writer article constraints.

The script intentionally avoids third-party YAML dependencies. It supports the
subset of YAML used by EXTEND.md and references/styles/*.yaml.
"""

from __future__ import annotations

import argparse
import json
import math
import os
import re
import sys
from typing import Any, Dict, Iterable, List, Optional, Tuple


LENGTH_PRESETS = {
    "short": (500, 800),
    "medium": (1000, 2000),
    "long": (2500, 4000),
}

DEFAULTS = {
    "writing_style": "default",
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
    return os.path.join(skill_root, "references", "styles", f"{style_name}.md")


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
    if custom_style:
        style_config = custom_style
        style_source = "custom_style"
    else:
        style_name = str(effective.get("writing_style") or "default")
        path = style_path(skill_root, style_name)
        if not os.path.exists(path):
            raise ConfigError(f"style preset '{style_name}' not found at {path}")
        style_config = load_yaml_file(path, frontmatter=True)
        style_source = path

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

    length_result: Dict[str, Any] = {
        "configured_length": constraints["length"],
        "visible_char_count": char_count,
        "status": "skipped" if length_range is None else "pass",
    }
    if length_range is not None:
        lower, upper, label = length_range
        length_result.update({"target": label, "min": lower, "max": upper})
        if char_count < lower or char_count > upper:
            length_result["status"] = "fail"
            issues.append(
                {
                    "type": "length",
                    "severity": "hard",
                    "message": f"visible character count {char_count} is outside target {lower}-{upper}",
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
                "message": f"avoid word '{hit['word']}' appears in paragraph {hit['paragraph']}",
                "word": hit["word"],
                "paragraph": hit["paragraph"],
                "excerpt": hit["excerpt"],
            }
        )

    return {
        "pass": not issues,
        "issues": issues,
        "length": length_result,
        "avoid_words": avoid_result,
        "style_source": constraints["style_source"],
        "active_profile": constraints["effective_config"].get("_active_profile"),
    }


def human_report(report: Dict[str, Any]) -> str:
    lines = ["确定性约束检查"]
    length = report["length"]
    if length["status"] == "skipped":
        lines.append(f"- length: skipped (configured: {length['configured_length']})")
    else:
        lines.append(
            "- length: {status} ({count}/{lower}-{upper} visible chars, target: {target})".format(
                status=length["status"],
                count=length["visible_char_count"],
                lower=length["min"],
                upper=length["max"],
                target=length["target"],
            )
        )

    avoid = report["avoid_words"]
    lines.append(
        f"- words_to_avoid/avoid_words: {avoid['status']} ({avoid['hit_count']} hits, {len(avoid['checked_words'])} words checked)"
    )
    for hit in avoid["hits"][:20]:
        lines.append(
            f"  - P{hit['paragraph']} '{hit['word']}': \"{hit['excerpt']}\""
        )
    if len(avoid["hits"]) > 20:
        lines.append(f"  - ... {len(avoid['hits']) - 20} more hits")
    lines.append(f"- style_source: {report['style_source']}")
    if report.get("active_profile"):
        lines.append(f"- active_profile: {report['active_profile']}")
    lines.append(f"- overall: {'pass' if report['pass'] else 'fail'}")
    return "\n".join(lines)


def read_article(path: str) -> str:
    if path == "-":
        return sys.stdin.read()
    return read_text(path)


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Check human-media-writer hard article constraints."
    )
    source_group = parser.add_mutually_exclusive_group(required=True)
    source_group.add_argument("--article", help="Article file path, or '-' for stdin.")
    source_group.add_argument("--text", help="Article content passed directly as an argument.")
    parser.add_argument("--extend", help="EXTEND.md path.")
    parser.add_argument("--profile", help="Active profile name.")
    parser.add_argument("--length", help="Runtime length override.")
    parser.add_argument("--writing-style", help="Runtime writing_style override.")
    parser.add_argument(
        "--avoid-word",
        action="append",
        default=[],
        help="Runtime avoid word. Repeat for multiple words.",
    )
    parser.add_argument(
        "--skill-root",
        default=os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
        help="human-media-writer skill root path.",
    )
    parser.add_argument("--json", action="store_true", help="Output JSON.")
    parser.add_argument(
        "--fail-on-issues",
        action="store_true",
        help="Exit 1 when deterministic constraints fail.",
    )
    args = parser.parse_args()

    try:
        constraints = resolve_constraints(
            skill_root=args.skill_root,
            extend_path=args.extend,
            profile=args.profile,
            explicit_length=args.length,
            explicit_style=args.writing_style,
            extra_avoid_words=args.avoid_word,
        )
        article = args.text if args.text is not None else read_article(args.article)
        report = build_report(article, constraints)
    except (OSError, ConfigError) as error:
        print(f"check_article_constraints error: {error}", file=sys.stderr)
        return 2

    if args.json:
        print(json.dumps(report, ensure_ascii=False, indent=2))
    else:
        print(human_report(report))

    if args.fail_on_issues and not report["pass"]:
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
