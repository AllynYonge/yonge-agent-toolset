#!/usr/bin/env python3
"""Resolve human-writing preferences without exposing full EXTEND.md.

Two roles live here on purpose:

* CLI: the narrow read boundary for agents. It reads the first available
  EXTEND.md, resolves only the requested active profile(s), and prints the
  minimal JSON needed for writing, rewriting, analysis, or review.
* Library: the only EXTEND.md config layer. It owns YAML parsing, account
  detection and constraint resolution. `check_prose.py` imports it instead of
  resolving config a second time.

The YAML reader is deliberately dependency-free and supports only the subset of
YAML used by EXTEND.md.
"""

from __future__ import annotations

import argparse
import json
import math
import os
import re
import shlex
import sys
from typing import Any, Dict, Iterable, List, Optional, Tuple


class ConfigError(Exception):
    pass


LENGTH_PRESETS = {
    "short": (300, 500),
    "medium": (1000, 2000),
    "long": (2500, 4000),
}


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


def load_yaml_file(path: str, frontmatter: bool = False) -> Dict[str, Any]:
    if not path or not os.path.exists(path):
        return {}
    with open(path, "r", encoding="utf-8") as handle:
        text = handle.read()
    return extract_frontmatter(text) if frontmatter else parse_simple_yaml(text)


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


def merge_avoid_words(global_fields: Dict[str, Any], account: Dict[str, Any]) -> Dict[str, Any]:
    """账号字段覆盖全局，但 avoid_words 取并集而不是替换。

    全局规避词与账号规避词合并去重后生效，账号写 `[]` 也不会清空全局词。
    最终列表还会与 `custom_style.words_to_avoid` 合并，见 `resolve_constraints`。
    """
    effective = dict(global_fields)
    effective.update(account)
    if "avoid_words" in global_fields and "avoid_words" in account:
        effective["avoid_words"] = unique_words(
            [global_fields["avoid_words"], account["avoid_words"]]
        )
    return effective


def reject_removed_style_key(effective: Dict[str, Any]) -> None:
    """内置风格预设已取消。遗留的 writing_style 直接报错，避免被静默忽略。"""
    if "writing_style" in effective:
        raise ConfigError(
            "writing_style 已取消，内置风格预设不再提供。"
            "请删除该字段，需要固定声音时改用 custom_style"
        )


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


def resolve_constraints(
    extend_path: Optional[str],
    profile: Optional[str],
    explicit_length: Optional[str],
) -> Dict[str, Any]:
    """Resolve the constraints `check_prose.py` enforces on a finished draft.

    Reuses `resolve_effective_config` and `load_style` so a profile can never
    resolve one way here and another way in the CLI output.
    """
    base_config: Dict[str, Any] = {}
    if extend_path:
        base_config = load_yaml_file(extend_path, frontmatter=True)

    effective = resolve_effective_config(base_config, profile)
    style_config, style_source = load_style(effective)

    if explicit_length is not None:
        effective["length"] = parse_scalar(explicit_length)

    avoid_words = unique_words(
        [
            style_config.get("words_to_avoid", []),
            effective.get("avoid_words", []),
        ]
    )

    return {
        "effective_config": effective,
        "style_source": style_source,
        "length": effective.get("length", "auto"),
        "avoid_words": avoid_words,
    }



DEFAULTS = {
    "platform": "auto",
    "medium": "auto",
    "length": "auto",
    "deep": "low",
    "long_threshold": 3000,
    "output_dir": None,
}

RESERVED_GLOBAL_KEYS = {
    "default_profile",
    "platform",
    "medium",
    "positioning",
    "audience",
    "purpose",
    "custom_style",
    "length",
    "deep",
    "long_threshold",
    "output_dir",
    "avoid_words",
    "compliance_guardrails",
}


def find_extend_path(workspace_dir: str) -> tuple[Optional[str], str]:
    project_path = os.path.join(workspace_dir, ".human-writing", "EXTEND.md")
    if os.path.exists(project_path):
        return project_path, "project"

    user_path = os.path.join(os.path.expanduser("~"), ".human-writing", "EXTEND.md")
    if os.path.exists(user_path):
        return user_path, "user"

    return None, "default"


def split_profiles(profile_value: Optional[str]) -> List[str]:
    if not profile_value:
        return []
    profiles = [item.strip() for item in profile_value.split("|")]
    return [item for item in profiles if item]


def is_account_key(key: str, value: Any) -> bool:
    return isinstance(value, dict) and key not in RESERVED_GLOBAL_KEYS


def extract_accounts(config: Dict[str, Any]) -> Dict[str, Dict[str, Any]]:
    return {
        key: value
        for key, value in config.items()
        if is_account_key(key, value)
    }


def extract_global_fields(config: Dict[str, Any]) -> Dict[str, Any]:
    return {
        key: value
        for key, value in config.items()
        if not is_account_key(key, value)
    }


def choose_default_profile(config: Dict[str, Any], accounts: Dict[str, Dict[str, Any]]) -> Optional[str]:
    default_profile = config.get("default_profile")
    if default_profile:
        if default_profile not in accounts:
            available = ", ".join(sorted(accounts)) or "(none)"
            raise ConfigError(
                f"default_profile '{default_profile}' not found. Available: {available}"
            )
        return str(default_profile)

    if len(accounts) == 1:
        return next(iter(accounts))

    if len(accounts) > 1:
        available = ", ".join(sorted(accounts))
        raise ConfigError(
            f"multiple profiles found but no default_profile is set. Use --profile. Available: {available}"
        )

    return None


def resolve_effective_config(
    base_config: Dict[str, Any],
    profile_name: Optional[str],
) -> Dict[str, Any]:
    accounts = extract_accounts(base_config)
    global_fields = extract_global_fields(base_config)

    if profile_name:
        if profile_name not in accounts:
            available = ", ".join(sorted(accounts)) or "(none)"
            raise ConfigError(f"profile '{profile_name}' not found. Available: {available}")
        effective = merge_avoid_words(global_fields, accounts[profile_name])
        effective["_active_profile"] = profile_name
        return effective

    default_profile = choose_default_profile(base_config, accounts)
    effective = dict(global_fields)
    if default_profile:
        effective = merge_avoid_words(effective, accounts[default_profile])
        effective["_active_profile"] = default_profile
    return effective


def load_style(effective: Dict[str, Any]) -> tuple[Dict[str, Any], Optional[str]]:
    """Return the configured custom_style, or ({}, None) when none is configured.

    There are no built-in presets; without custom_style the writing falls back
    to SKILL.md's default prose rules.
    """
    reject_removed_style_key(effective)
    custom_style = effective.get("custom_style") or {}
    if custom_style:
        if not isinstance(custom_style, dict):
            raise ConfigError("custom_style must be an object")
        return custom_style, "custom_style"
    return {}, None


def resolve_compliance_guardrails(
    effective: Dict[str, Any],
    style_config: Dict[str, Any],
) -> List[str]:
    """Resolve account/global rules before style fallback; [] clears fallback.

    These are semantic review instructions, not literal avoid-word patterns.
    Validate explicitly so malformed rules cannot silently disable review.
    """
    if "compliance_guardrails" in effective:
        value = effective["compliance_guardrails"]
        field = "compliance_guardrails"
    else:
        value = style_config.get("compliance_guardrails", [])
        field = "style.compliance_guardrails"

    if not isinstance(value, list):
        raise ConfigError(f"{field} must be a list of non-empty strings; use [] for no rules")

    rules = []
    for index, rule in enumerate(value, start=1):
        if not isinstance(rule, str) or not rule.strip():
            raise ConfigError(f"{field}[{index}] must be a non-empty string")
        rules.append(rule.strip())
    return rules


def shell_args(parts: List[str]) -> str:
    return " ".join(shlex.quote(part) for part in parts)


def resolve_output_dir(workspace_dir: str, value: Any) -> Optional[str]:
    if value in (None, "", "auto"):
        return None
    if not isinstance(value, str):
        raise ConfigError("output_dir must be a string path")

    path = value.strip()
    if not path:
        return None
    if path.startswith("/"):
        return os.path.abspath(path)
    return os.path.abspath(os.path.join(workspace_dir, path))


def build_profile_result(
    skill_root: str,
    extend_path: Optional[str],
    profile_name: Optional[str],
    config: Dict[str, Any],
    workspace_dir: str,
) -> Dict[str, Any]:
    effective = resolve_effective_config(config, profile_name)
    style_config, style_source = load_style(effective)
    guardrails = resolve_compliance_guardrails(effective, style_config)
    output_dir = effective.get("output_dir", DEFAULTS["output_dir"])
    output_dir = resolve_output_dir(workspace_dir, output_dir)

    avoid_words = unique_words(
        [
            style_config.get("words_to_avoid", []),
            effective.get("avoid_words", []),
        ]
    )

    constraint_args = []
    if extend_path:
        constraint_args.extend(["--extend", extend_path])
    if effective.get("_active_profile"):
        constraint_args.extend(["--profile", str(effective["_active_profile"])])

    return {
        "active_profile": effective.get("_active_profile"),
        "effective_config": effective,
        "platform": effective.get("platform", DEFAULTS["platform"]),
        "medium": effective.get("medium", DEFAULTS["medium"]),
        "style_source": style_source,
        "style": style_config,
        "compliance_guardrails": guardrails,
        "length": effective.get("length", DEFAULTS["length"]),
        "deep": effective.get("deep", DEFAULTS["deep"]),
        "long_threshold": effective.get("long_threshold", DEFAULTS["long_threshold"]),
        "output_dir": output_dir,
        "avoid_words": avoid_words,
        "constraint_check_args": shell_args(constraint_args),
    }


def resolve_preferences(
    workspace_dir: str,
    skill_root: str,
    requested_profiles: List[str],
) -> Dict[str, Any]:
    extend_path, scope = find_extend_path(workspace_dir)

    config = dict(DEFAULTS)
    if extend_path:
        config.update(load_yaml_file(extend_path, frontmatter=True))

    accounts = extract_accounts(config)
    profile_names = requested_profiles or [None]
    profiles: Dict[str, Dict[str, Any]] = {}

    for profile_name in profile_names:
        result = build_profile_result(skill_root, extend_path, profile_name, config, workspace_dir)
        output_key = result.get("active_profile") or "__default__"
        profiles[str(output_key)] = result

    return {
        "config_path": extend_path,
        "config_scope": scope,
        "workspace_dir": workspace_dir,
        "available_profiles": sorted(accounts),
        "requested_profiles": requested_profiles,
        "profiles": profiles,
    }


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Resolve human-writing self-media active profile preferences."
    )
    parser.add_argument(
        "--workspace-dir",
        default=os.getcwd(),
        help="Workspace directory. Defaults to current working directory.",
    )
    parser.add_argument(
        "--skill-root",
        default=os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
        help="human-writing skill root path.",
    )
    parser.add_argument(
        "--profile",
        help="Profile name, or multiple names separated by '|', e.g. profile1|profile2.",
    )
    parser.add_argument(
        "--list-profiles",
        action="store_true",
        help="Only list available profiles from the selected config file.",
    )
    args = parser.parse_args()

    try:
        requested_profiles = split_profiles(args.profile)
        resolved = resolve_preferences(
            workspace_dir=os.path.abspath(args.workspace_dir),
            skill_root=os.path.abspath(args.skill_root),
            requested_profiles=requested_profiles,
        )
        if args.list_profiles:
            resolved = {
                "config_path": resolved["config_path"],
                "config_scope": resolved["config_scope"],
                "available_profiles": resolved["available_profiles"],
            }
    except (OSError, ConfigError) as error:
        print(f"resolve_preferences error: {error}", file=sys.stderr)
        return 2

    print(json.dumps(resolved, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
