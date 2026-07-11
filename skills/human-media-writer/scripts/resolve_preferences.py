#!/usr/bin/env python3
"""Resolve human-media-writer preferences without exposing full EXTEND.md.

This script is intentionally a narrow read boundary for agents. It reads the
first available EXTEND.md, resolves only the requested active profile(s), and
prints the minimal JSON needed for writing, rewriting, analysis, or review.
"""

from __future__ import annotations

import argparse
import json
import os
import shlex
import sys
from typing import Any, Dict, List, Optional

from check_article_constraints import (
    ConfigError,
    load_yaml_file,
    style_path,
    unique_words,
)


DEFAULTS = {
    "platform": "auto",
    "writing_style": "warm-narrative",
    "length": "auto",
    "deep": "low",
    "long_threshold": 3000,
    "output_dir": None,
}

RESERVED_GLOBAL_KEYS = {
    "default_profile",
    "platform",
    "positioning",
    "audience",
    "purpose",
    "writing_style",
    "custom_style",
    "length",
    "deep",
    "long_threshold",
    "output_dir",
    "avoid_words",
}


def find_extend_path(workspace_dir: str) -> tuple[Optional[str], str]:
    project_path = os.path.join(workspace_dir, ".human-media-writer", "EXTEND.md")
    if os.path.exists(project_path):
        return project_path, "project"

    user_path = os.path.join(os.path.expanduser("~"), ".human-media-writer", "EXTEND.md")
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
        effective = dict(global_fields)
        effective.update(accounts[profile_name])
        effective["_active_profile"] = profile_name
        return effective

    default_profile = choose_default_profile(base_config, accounts)
    effective = dict(global_fields)
    if default_profile:
        effective.update(accounts[default_profile])
        effective["_active_profile"] = default_profile
    return effective


def load_style(skill_root: str, effective: Dict[str, Any]) -> tuple[Dict[str, Any], str]:
    custom_style = effective.get("custom_style") or {}
    if custom_style:
        if not isinstance(custom_style, dict):
            raise ConfigError("custom_style must be an object")
        return custom_style, "custom_style"

    style_name = str(effective.get("writing_style") or DEFAULTS["writing_style"])
    path = style_path(skill_root, style_name)
    if not os.path.exists(path):
        raise ConfigError(f"style preset '{style_name}' not found at {path}")
    return load_yaml_file(path), path


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
    style_config, style_source = load_style(skill_root, effective)
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
        "style_source": style_source,
        "style": style_config,
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
        description="Resolve human-media-writer active profile preferences."
    )
    parser.add_argument(
        "--workspace-dir",
        default=os.getcwd(),
        help="Workspace directory. Defaults to current working directory.",
    )
    parser.add_argument(
        "--skill-root",
        default=os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
        help="human-media-writer skill root path.",
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
