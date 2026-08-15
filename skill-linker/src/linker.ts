import { lstat, mkdir, stat, symlink, unlink } from "node:fs/promises";
import { basename, resolve } from "node:path";

import { ConfigError, resolveSourcePath } from "./config.js";
import { type Platform, resolvePlatformDirectory } from "./platform.js";

export interface CreatedLink {
  name: string;
  destination: string;
  target: string;
  replaced: boolean;
}

export interface LinkResult {
  created: CreatedLink[];
  warnings: string[];
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function sourceLabel(rawSource: string, resolvedSource: string | undefined): string {
  return resolvedSource ?? (rawSource.length > 0 ? rawSource : "<empty path>");
}

function getSourcePath(rawSource: string, configDirectory: string): string | undefined {
  if (rawSource.trim().length === 0) {
    return undefined;
  }

  return resolveSourcePath(rawSource, configDirectory);
}

function findDuplicateNames(mode: string, sources: string[], configDirectory: string): void {
  const names = new Map<string, string>();

  for (const rawSource of sources) {
    const resolvedSource = getSourcePath(rawSource, configDirectory);
    if (resolvedSource === undefined) {
      continue;
    }

    const name = basename(resolvedSource);
    const previousSource = names.get(name);
    if (previousSource !== undefined) {
      throw new ConfigError(
        `mode "${mode}" contains duplicate link name "${name}" for ${previousSource} and ${resolvedSource}`,
      );
    }

    names.set(name, resolvedSource);
  }
}

async function getSourceProblem(sourcePath: string): Promise<string | undefined> {
  let sourceStats: Awaited<ReturnType<typeof stat>>;

  try {
    sourceStats = await stat(sourcePath);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return "directory does not exist";
    }

    const detail = error instanceof Error ? error.message : String(error);
    return `cannot inspect source (${detail})`;
  }

  if (!sourceStats.isDirectory()) {
    return "source is not a directory";
  }

  try {
    const skillFileStats = await stat(resolve(sourcePath, "SKILL.md"));
    if (!skillFileStats.isFile()) {
      return "SKILL.md is not a file";
    }
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return "missing SKILL.md";
    }

    const detail = error instanceof Error ? error.message : String(error);
    return `cannot inspect SKILL.md (${detail})`;
  }

  return undefined;
}

async function getDestinationKind(destination: string): Promise<"missing" | "symlink" | "other"> {
  try {
    const destinationStats = await lstat(destination);
    return destinationStats.isSymbolicLink() ? "symlink" : "other";
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return "missing";
    }

    throw error;
  }
}

async function ensurePlatformDirectory(
  cwd: string,
  platform: Platform,
): Promise<{ directory?: string; warning?: string }> {
  const directory = resolvePlatformDirectory(cwd, platform);

  try {
    await mkdir(directory, { recursive: true });
    return { directory };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return {
      warning: `WARN: skipped platform ${platform} - cannot create ${directory} (${detail})`,
    };
  }
}

export async function linkMode(
  mode: string,
  sources: string[],
  configDirectory: string,
  cwd: string = process.cwd(),
  platforms: readonly Platform[] = ["codex"],
): Promise<LinkResult> {
  findDuplicateNames(mode, sources, configDirectory);

  const result: LinkResult = { created: [], warnings: [] };
  const linkType = process.platform === "win32" ? "junction" : "dir";
  const platformDirectories: string[] = [];

  for (const platform of platforms) {
    const ensured = await ensurePlatformDirectory(cwd, platform);
    if (ensured.warning !== undefined) {
      result.warnings.push(ensured.warning);
    }
    if (ensured.directory !== undefined) {
      platformDirectories.push(ensured.directory);
    }
  }

  const validSources: Array<{ name: string; target: string }> = [];

  for (const rawSource of sources) {
    const resolvedSource = getSourcePath(rawSource, configDirectory);
    const problem = resolvedSource === undefined
      ? "source path is empty"
      : await getSourceProblem(resolvedSource);

    if (problem !== undefined) {
      result.warnings.push(
        `WARN: skipped ${sourceLabel(rawSource, resolvedSource)} - ${problem}`,
      );
      continue;
    }

    validSources.push({ name: basename(resolvedSource as string), target: resolvedSource as string });
  }

  for (const directory of platformDirectories) {
    for (const source of validSources) {
      const destination = resolve(directory, source.name);
      const destinationKind = await getDestinationKind(destination);

      if (destinationKind === "other") {
        continue;
      }

      const replaced = destinationKind === "symlink";
      if (replaced) {
        await unlink(destination);
      }

      await symlink(source.target, destination, linkType);
      result.created.push({ name: source.name, destination, target: source.target, replaced });
    }
  }

  return result;
}
