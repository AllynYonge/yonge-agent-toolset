import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, resolve } from "node:path";

import type { LoadedConfig, SkillLinkerConfig } from "./types.js";

const DEFAULT_CONFIG_FILENAME = "skill-linker.config.json";

export class ConfigError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

export function expandHome(input: string): string {
  if (input === "~") {
    return homedir();
  }

  if (input.startsWith("~/")) {
    return resolve(homedir(), input.slice(2));
  }

  return input;
}

export function resolveConfigPath(configPath: string | undefined, cwd: string): string {
  const candidate = expandHome(configPath ?? DEFAULT_CONFIG_FILENAME);
  return isAbsolute(candidate) ? candidate : resolve(cwd, candidate);
}

export function resolveConfigPaths(
  configPath: string | undefined,
  cwd: string,
  homeDirectory: string = homedir(),
): string[] {
  if (configPath !== undefined) {
    return [resolveConfigPath(configPath, cwd)];
  }

  return [
    resolve(homeDirectory, ".yonge-skill", DEFAULT_CONFIG_FILENAME),
    resolve(cwd, DEFAULT_CONFIG_FILENAME),
  ];
}

export function resolveSourcePath(sourcePath: string, configDirectory: string): string {
  const candidate = expandHome(sourcePath);
  return isAbsolute(candidate) ? candidate : resolve(configDirectory, candidate);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseConfig(raw: string, configPath: string): SkillLinkerConfig {
  let parsed: unknown;

  try {
    parsed = JSON.parse(raw) as unknown;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new ConfigError(`invalid JSON in ${configPath}: ${detail}`);
  }

  if (!isRecord(parsed) || !isRecord(parsed.modes)) {
    throw new ConfigError(`configuration ${configPath} must contain a "modes" object`);
  }

  const modes: Record<string, string[]> = {};

  for (const [mode, entries] of Object.entries(parsed.modes)) {
    if (mode.length === 0) {
      throw new ConfigError(`configuration ${configPath} contains an empty mode name`);
    }

    if (!Array.isArray(entries) || entries.some((entry) => typeof entry !== "string")) {
      throw new ConfigError(`mode "${mode}" in ${configPath} must be an array of source paths`);
    }

    modes[mode] = entries as string[];
  }

  return { modes };
}

export async function loadConfig(
  configPath: string | undefined,
  cwd: string = process.cwd(),
  homeDirectory: string = homedir(),
): Promise<LoadedConfig> {
  const candidatePaths = resolveConfigPaths(configPath, cwd, homeDirectory);

  for (const candidatePath of candidatePaths) {
    let raw: string;

    try {
      raw = await readFile(candidatePath, "utf8");
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        continue;
      }

      const detail = error instanceof Error ? error.message : String(error);
      throw new ConfigError(`cannot read configuration ${candidatePath}: ${detail}`);
    }

    return {
      config: parseConfig(raw, candidatePath),
      configPath: candidatePath,
      configDirectory: dirname(candidatePath),
    };
  }

  throw new ConfigError(`configuration file not found. Tried: ${candidatePaths.join(", ")}`);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
