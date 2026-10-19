#!/usr/bin/env bun
/**
 * 解析 human-writing 当前生效的账号偏好，只输出写作需要的字段，不暴露 EXTEND.md 全文。
 *
 * 用法：
 *   bun scripts/resolve_preferences.ts [--workspace-dir <目录>] [--profile "a|b"] [--list-profiles]
 *
 * 定位与解析由 lib/skill-config.ts 负责；语义规则见 lib/preferences.ts。
 */
import path from "node:path";
import process from "node:process";

import { ConfigError, resolvePreferences, splitProfiles } from "./lib/preferences";

interface Args {
  workspaceDir: string;
  profile: string | null;
  listProfiles: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { workspaceDir: process.cwd(), profile: null, listProfiles: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--workspace-dir") args.workspaceDir = argv[++index] ?? "";
    else if (arg === "--profile") args.profile = argv[++index] ?? "";
    else if (arg === "--list-profiles") args.listProfiles = true;
    else if (arg === "-h" || arg === "--help") {
      console.log(`用法: bun resolve_preferences.ts [--workspace-dir <目录>] [--profile "a|b"] [--list-profiles]`);
      process.exit(0);
    } else {
      throw new ConfigError(`未知参数：${arg}`);
    }
  }
  return args;
}

function main(): number {
  try {
    const args = parseArgs(process.argv.slice(2));
    const { resolved, warnings } = resolvePreferences(
      path.resolve(args.workspaceDir || "."),
      splitProfiles(args.profile),
    );

    for (const warning of warnings) console.error(`警告：${warning}`);

    const output = args.listProfiles
      ? {
          config_path: resolved.config_path,
          config_scope: resolved.config_scope,
          available_profiles: resolved.available_profiles,
        }
      : resolved;

    console.log(JSON.stringify(output, null, 2));
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`resolve_preferences error: ${message}`);
    return 2;
  }
}

process.exit(main());
