import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, resolve } from "node:path";

import { parse, printParseErrorCode, type ParseError } from "jsonc-parser";

import { PLATFORMS, type Platform } from "./platform.js";
import type {
  BaseInstructionConfig,
  LoadedConfig,
  ModeConfig,
  SkillLinkerConfig,
} from "./types.js";

const DEFAULT_CONFIG_FILENAMES = ["linker.config.jsonc", "linker.config.json"] as const;

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
  const candidate = expandHome(configPath ?? DEFAULT_CONFIG_FILENAMES[0]);
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
    ...DEFAULT_CONFIG_FILENAMES.map((filename) => resolve(homeDirectory, ".yonge", filename)),
    ...DEFAULT_CONFIG_FILENAMES.map((filename) => resolve(cwd, filename)),
  ];
}

export function resolveSourcePath(sourcePath: string, configDirectory: string): string {
  const candidate = expandHome(sourcePath);
  return isAbsolute(candidate) ? candidate : resolve(configDirectory, candidate);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateBaseInstructions(
  modeName: string,
  value: unknown,
  configPath: string,
): BaseInstructionConfig {
  if (!isRecord(value)) {
    throw new ConfigError(
      'mode "' + modeName + '" in ' + configPath + ' has an invalid "baseInstruction" object',
    );
  }

  const baseInstruction: BaseInstructionConfig = {};

  for (const platform of Object.keys(value) as Platform[]) {
    if (!PLATFORMS.includes(platform)) {
      throw new ConfigError(
        'baseInstruction platform "' + platform + '" in mode "' + modeName + '" of ' +
          configPath + ' must be one of ' + PLATFORMS.join(", "),
      );
    }

    const entry = value[platform];
    if (!isRecord(entry)) {
      throw new ConfigError(
        'baseInstruction "' + platform + '" in mode "' + modeName + '" of ' + configPath +
          ' must be an object',
      );
    }

    const allowedFields = ["PATH", "NAME"] as const;
    for (const field of Object.keys(entry)) {
      if (!(allowedFields as readonly string[]).includes(field)) {
        throw new ConfigError(
          'baseInstruction "' + platform + '" in mode "' + modeName + '" of ' + configPath +
            ' contains unknown field "' + field + '"',
        );
      }
    }

    for (const field of allowedFields) {
      const fieldValue = entry[field];
      if (typeof fieldValue !== "string" || fieldValue.length === 0) {
        throw new ConfigError(
          'baseInstruction "' + platform + '" in mode "' + modeName + '" of ' + configPath +
            ' requires a non-empty "' + field + '" string',
        );
      }
    }

    const name = entry.NAME as string;
    if (
      name === "." ||
      name === ".." ||
      name.includes("/") ||
      name.includes("\\") ||
      name.includes("\0")
    ) {
      throw new ConfigError(
        'baseInstruction "' + platform + '" NAME in mode "' + modeName + '" of ' + configPath +
          ' must be a single filename',
      );
    }

    baseInstruction[platform] = { PATH: entry.PATH as string, NAME: name };
  }

  return baseInstruction;
}

function parseConfig(raw: string, configPath: string): SkillLinkerConfig {
  const errors: ParseError[] = [];
  const parsed = parse(raw, errors, {
    allowEmptyContent: false,
    allowTrailingComma: true,
    disallowComments: false,
  }) as unknown;

  if (errors.length > 0) {
    const first = errors[0] as ParseError;
    const beforeError = raw.slice(0, first.offset);
    const line = beforeError.split(/\r?\n/).length;
    const lastNewline = Math.max(beforeError.lastIndexOf("\n"), beforeError.lastIndexOf("\r"));
    const column = first.offset - lastNewline;
    throw new ConfigError(
      `invalid JSONC in ${configPath}: ${printParseErrorCode(first.error)} at ${line}:${column}`,
    );
  }

  if (!isRecord(parsed) || !isRecord(parsed.modes)) {
    throw new ConfigError(`configuration ${configPath} must contain a "modes" object`);
  }

  const modes: Record<string, ModeConfig> = {};

  for (const [mode, modeValue] of Object.entries(parsed.modes)) {
    if (mode.length === 0) {
      throw new ConfigError(`configuration ${configPath} contains an empty mode name`);
    }

    if (!isRecord(modeValue)) {
      throw new ConfigError('mode "' + mode + '" in ' + configPath + ' must be an object');
    }

    const hasSkills = Object.hasOwn(modeValue, "skills");
    const hasMcpServers = Object.hasOwn(modeValue, "mcpServers");
    const hasBaseInstruction = Object.hasOwn(modeValue, "baseInstruction");
    if (!hasSkills && !hasMcpServers && !hasBaseInstruction) {
      throw new ConfigError(
        'mode "' + mode + '" in ' + configPath +
          ' must contain "skills", "mcpServers", or "baseInstruction"',
      );
    }

    const skills = modeValue.skills ?? [];
    if (!Array.isArray(skills) || skills.some((entry) => typeof entry !== "string")) {
      throw new ConfigError(
        'mode "' + mode + '" in ' + configPath + ' has an invalid "skills" array',
      );
    }

    const mcpServers = modeValue.mcpServers ?? {};
    if (!isRecord(mcpServers)) {
      throw new ConfigError(
        'mode "' + mode + '" in ' + configPath + ' has an invalid "mcpServers" object',
      );
    }

    const baseInstruction = hasBaseInstruction
      ? validateBaseInstructions(mode, modeValue.baseInstruction, configPath)
      : {};

    modes[mode] = {
      skills: skills as string[],
      mcpServers,
      baseInstruction,
    };
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
