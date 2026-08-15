import { resolve } from "node:path";

export const PLATFORM_DIRECTORIES = {
  codex: ".codex/skills",
  claude: ".claude/skills",
  agents: ".agents/skills",
} as const;

export const PLATFORM_MCP_FILES = {
  codex: ".codex/config.toml",
  claude: ".mcp.json",
  agents: "opencode.json",
} as const;

export type Platform = keyof typeof PLATFORM_DIRECTORIES;

export function isPlatform(value: string): value is Platform {
  return Object.hasOwn(PLATFORM_DIRECTORIES, value);
}

export function resolvePlatformDirectory(cwd: string, platform: Platform): string {
  return resolve(cwd, PLATFORM_DIRECTORIES[platform]);
}

export function resolvePlatformMcpFile(cwd: string, platform: Platform): string {
  return resolve(cwd, PLATFORM_MCP_FILES[platform]);
}
