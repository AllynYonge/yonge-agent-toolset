import { resolve } from "node:path";

export const PLATFORM_DIRECTORIES = {
  codex: ".codex/skills",
  claude: ".claude/skills",
  agents: ".agents/skills",
} as const;

export const PLATFORM_MCP_FILES = {
  codex: ".codex/config.toml",
  claude: ".mcp.json",
  agents: ".pi/mcp.json",
} as const;

export type Platform = keyof typeof PLATFORM_DIRECTORIES;

export const PLATFORMS: readonly Platform[] = ["codex", "claude", "agents"];

export function isPlatform(value: string): value is Platform {
  return PLATFORMS.includes(value as Platform);
}

export function resolvePlatformDirectory(cwd: string, platform: Platform): string {
  return resolve(cwd, PLATFORM_DIRECTORIES[platform]);
}

export function resolvePlatformMcpFile(cwd: string, platform: Platform): string {
  return resolve(cwd, PLATFORM_MCP_FILES[platform]);
}

export const PLATFORM_BASE_INSTRUCTION_DESTINATIONS = {
  codex: "",
  claude: ".claude",
  agents: "",
} as const satisfies Record<Platform, string>;

export function resolvePlatformBaseInstructionFile(
  cwd: string,
  platform: Platform,
  name: string,
): string {
  const directory = PLATFORM_BASE_INSTRUCTION_DESTINATIONS[platform];
  return directory.length === 0
    ? resolve(cwd, name)
    : resolve(cwd, directory, name);
}
