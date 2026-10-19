#!/usr/bin/env node

import { realpathSync } from "node:fs";
import { stat } from "node:fs/promises";
import { basename, relative, resolve } from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";

import { expandHome, loadConfig, resolveSourcePath } from "./config.js";
import { linkBaseInstructions, linkMode, validateBaseInstructions } from "./linker.js";
import { writeMcpServers } from "./mcp.js";
import { isPlatform, type Platform } from "./platform.js";
import type { ModeConfig } from "./types.js";

const HELP = `Usage:
  skill-linker list [--config <path>]
  skill-linker link <mode...> [--platform <codex|claude|agents>] [--path <dir>] [--config <path>]
`;

export async function run(
  argv: string[] = process.argv.slice(2),
  cwd: string = process.cwd(),
  stdout: NodeJS.WritableStream = process.stdout,
  stderr: NodeJS.WritableStream = process.stderr,
): Promise<number> {
  try {
    const parsed = parseArgs({
      args: argv,
      options: {
        config: { type: "string", short: "c" },
        path: { type: "string" },
        platform: { type: "string", short: "p", multiple: true },
      },
      allowPositionals: true,
      strict: true,
    });
    const configPath = typeof parsed.values.config === "string"
      ? parsed.values.config
      : undefined;
    const platformValues = parsed.values.platform;
    if (platformValues !== undefined && platformValues.length !== 1) {
      throw new CliUsageError("link accepts at most one --platform value");
    }
    const platformValue = platformValues?.[0];
    const pathValue = typeof parsed.values.path === "string"
      ? parsed.values.path
      : undefined;

    if (parsed.positionals.length === 0) {
      if (platformValue !== undefined) {
        throw new CliUsageError("--platform requires the link command");
      }
      if (pathValue !== undefined) {
        throw new CliUsageError("--path requires the link command");
      }
      stdout.write(HELP);
      return 0;
    }

    const [command, ...positionals] = parsed.positionals;

    if (command === "list" && platformValue !== undefined) {
      throw new CliUsageError("list does not accept --platform");
    }

    if (command === "list" && pathValue !== undefined) {
      throw new CliUsageError("list does not accept --path");
    }

    const loaded = await loadConfig(configPath, cwd);

    if (command === "list") {
      if (positionals.length > 0) {
        throw new CliUsageError("list does not accept positional arguments");
      }

      writeModeList(loaded.config.modes, stdout);
      return 0;
    }

    if (command === "link") {
      if (positionals.length === 0) {
        throw new CliUsageError("link requires at least one mode");
      }

      for (const mode of positionals) {
        if (!Object.hasOwn(loaded.config.modes, mode)) {
          throw new CliUsageError(`unknown mode: ${mode}`);
        }
      }

      if (platformValue !== undefined && !isPlatform(platformValue)) {
        throw new CliUsageError(
          `invalid platform "${platformValue}"; expected codex, claude, or agents`,
        );
      }

      const platforms: readonly Platform[] = platformValue === undefined
        ? ["codex", "claude", "agents"]
        : [platformValue];
      const targetDirectory = await resolveTargetDirectory(pathValue, cwd);
      const modeConfig = mergeModeConfigs(
        positionals,
        loaded.config.modes,
        loaded.configDirectory,
      );
      await validateBaseInstructions(
        modeConfig.baseInstruction,
        loaded.configDirectory,
        targetDirectory,
        platforms,
      );
      const linkResult = await linkMode(
        positionals.join(", "),
        modeConfig.skills,
        loaded.configDirectory,
        targetDirectory,
        platforms,
      );
      const mcpResult = await writeMcpServers(modeConfig.mcpServers, targetDirectory, platforms);
      const baseResult = await linkBaseInstructions(
        modeConfig.baseInstruction,
        loaded.configDirectory,
        targetDirectory,
        platforms,
      );
      for (const warning of [...linkResult.warnings, ...mcpResult.warnings, ...baseResult.warnings]) {
        stderr.write(`${warning}\n`);
      }
      for (const link of linkResult.created) {
        const suffix = link.replaced ? " (replaced)" : "";
        const destination = relative(targetDirectory, link.destination) || ".";
        stdout.write(`LINK: ${destination} -> ${link.target}${suffix}\n`);
      }
      for (const server of mcpResult.written) {
        const destination = relative(targetDirectory, server.destination) || ".";
        stdout.write(`MCP: ${server.name} -> ${destination}\n`);
      }
      for (const instruction of baseResult.created) {
        const suffix = instruction.replaced ? " (replaced)" : "";
        const destination = relative(targetDirectory, instruction.destination) || ".";
        stdout.write(`BASE: ${destination} -> ${instruction.target}${suffix}\n`);
      }
      return 0;
    }

    throw new CliUsageError(`unknown command: ${command}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    stderr.write(`ERROR: ${message}\n`);
    return 1;
  }
}

async function resolveTargetDirectory(
  pathValue: string | undefined,
  cwd: string,
): Promise<string> {
  if (pathValue === undefined) {
    return cwd;
  }

  if (pathValue.trim().length === 0) {
    throw new CliUsageError("--path requires a non-empty directory");
  }

  const candidate = resolve(cwd, expandHome(pathValue));
  let candidateStats: Awaited<ReturnType<typeof stat>>;

  try {
    candidateStats = await stat(candidate);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      throw new CliUsageError(`--path does not exist: ${candidate}`);
    }

    const detail = error instanceof Error ? error.message : String(error);
    throw new CliUsageError(`cannot inspect --path ${candidate} (${detail})`);
  }

  if (!candidateStats.isDirectory()) {
    throw new CliUsageError(`--path is not a directory: ${candidate}`);
  }

  return candidate;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function mergeModeConfigs(
  modeNames: string[],
  modes: Record<string, ModeConfig>,
  configDirectory: string,
): ModeConfig {
  const skillsByName = new Map<string, string>();
  const invalidSkills: string[] = [];
  const mcpServers: Record<string, unknown> = {};
  const baseInstruction: ModeConfig["baseInstruction"] = {};

  for (const modeName of modeNames) {
    const mode = modes[modeName] as ModeConfig;
    for (const source of mode.skills) {
      if (source.trim().length === 0) {
        invalidSkills.push(source);
        continue;
      }

      const name = basename(resolveSourcePath(source, configDirectory));
      skillsByName.delete(name);
      skillsByName.set(name, source);
    }

    for (const [name, server] of Object.entries(mode.mcpServers)) {
      delete mcpServers[name];
      mcpServers[name] = server;
    }

    Object.assign(baseInstruction, mode.baseInstruction);
  }

  return {
    skills: [...skillsByName.values(), ...invalidSkills],
    mcpServers,
    baseInstruction,
  };
}

function writeModeList(
  modes: Record<string, ModeConfig>,
  stdout: NodeJS.WritableStream,
): void {
  const entries = Object.entries(modes);
  const width = entries.reduce((longest, [mode]) => Math.max(longest, mode.length), 0);

  for (const [mode, config] of entries) {
    const skillNoun = config.skills.length === 1 ? "skill" : "skills";
    const mcpCount = Object.keys(config.mcpServers).length;
    const mcpNoun = mcpCount === 1 ? "MCP" : "MCPs";
    const baseCount = Object.keys(config.baseInstruction).length;
    const baseNoun = baseCount === 1 ? "baseInstruction" : "baseInstructions";
    const baseSuffix = baseCount === 0 ? "" : `  ${baseCount} ${baseNoun}`;
    stdout.write(
      `${mode.padEnd(width)}  ${config.skills.length} ${skillNoun}  ${mcpCount} ${mcpNoun}${baseSuffix}\n`,
    );
  }
}

class CliUsageError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "CliUsageError";
  }
}

if (isMainModule()) {
  const exitCode = await run();
  process.exitCode = exitCode;
}

function isMainModule(): boolean {
  if (process.argv[1] === undefined) {
    return false;
  }

  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}
