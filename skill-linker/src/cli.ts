#!/usr/bin/env node

import { realpathSync } from "node:fs";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";

import { loadConfig } from "./config.js";
import { linkMode } from "./linker.js";

const HELP = `Usage:
  skill-linker list [--config <path>]
  skill-linker link <mode> [--config <path>]
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
      },
      allowPositionals: true,
      strict: true,
    });
    const configPath = typeof parsed.values.config === "string"
      ? parsed.values.config
      : undefined;

    if (parsed.positionals.length === 0) {
      stdout.write(HELP);
      return 0;
    }

    const [command, ...positionals] = parsed.positionals;
    const loaded = await loadConfig(configPath, cwd);

    if (command === "list") {
      if (positionals.length > 0) {
        throw new CliUsageError("list does not accept positional arguments");
      }

      writeModeList(loaded.config.modes, stdout);
      return 0;
    }

    if (command === "link") {
      const mode = positionals[0];
      if (mode === undefined || positionals.length > 1) {
        throw new CliUsageError("link requires exactly one mode");
      }

      const sources = loaded.config.modes[mode];
      if (sources === undefined) {
        throw new CliUsageError(`unknown mode: ${mode}`);
      }

      const result = await linkMode(mode, sources, loaded.configDirectory, cwd);
      for (const warning of result.warnings) {
        stderr.write(`${warning}\n`);
      }
      for (const link of result.created) {
        const suffix = link.replaced ? " (replaced)" : "";
        stdout.write(`LINK: ${link.name} -> ${link.target}${suffix}\n`);
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

function writeModeList(
  modes: Record<string, string[]>,
  stdout: NodeJS.WritableStream,
): void {
  const entries = Object.entries(modes);
  const width = entries.reduce((longest, [mode]) => Math.max(longest, mode.length), 0);

  for (const [mode, sources] of entries) {
    const noun = sources.length === 1 ? "skill" : "skills";
    stdout.write(`${mode.padEnd(width)}  ${sources.length} ${noun}\n`);
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
