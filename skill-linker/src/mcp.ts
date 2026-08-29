import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, relative, resolve } from "node:path";

import { parse as parseToml, stringify as stringifyToml } from "smol-toml";

import { type Platform, resolvePlatformMcpFile } from "./platform.js";
import type { McpServerConfig } from "./types.js";

const MCP_NAME_PATTERN = /^[A-Za-z0-9_-]+$/;

export interface WrittenMcpServer {
  name: string;
  destination: string;
}

export interface McpWriteResult {
  written: WrittenMcpServer[];
  warnings: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return isRecord(value) && Object.values(value).every((entry) => typeof entry === "string");
}

function validateStartupTimeout(raw: unknown): string | undefined {
  if (typeof raw !== "number" || !Number.isSafeInteger(raw) || raw <= 0) {
    return "startup_timeout_sec must be a positive integer";
  }

  return undefined;
}

function validateMcpServer(name: string, raw: unknown): McpServerConfig | string {
  if (!MCP_NAME_PATTERN.test(name)) {
    return "service name may contain only letters, numbers, hyphens, and underscores";
  }

  if (!isRecord(raw)) {
    return "configuration must be an object";
  }

  if (raw.type === "local") {
    if (typeof raw.command !== "string" || raw.command.trim().length === 0) {
      return "local server requires a non-empty command";
    }
    if (raw.args !== undefined && (!Array.isArray(raw.args) || raw.args.some((arg) => typeof arg !== "string"))) {
      return "local server args must be an array of strings";
    }
    if (raw.env !== undefined && !isStringRecord(raw.env)) {
      return "local server env must contain only string values";
    }

    const startupTimeoutProblem = raw.startup_timeout_sec === undefined
      ? undefined
      : validateStartupTimeout(raw.startup_timeout_sec);
    if (startupTimeoutProblem !== undefined) {
      return startupTimeoutProblem;
    }

    return {
      type: "local",
      command: raw.command,
      ...(raw.args === undefined ? {} : { args: raw.args as string[] }),
      ...(raw.env === undefined ? {} : { env: raw.env as Record<string, string> }),
      ...(raw.startup_timeout_sec === undefined
        ? {}
        : { startup_timeout_sec: raw.startup_timeout_sec as number }),
    };
  }

  if (raw.type === "remote") {
    if (typeof raw.url !== "string" || raw.url.trim().length === 0) {
      return "remote server requires a non-empty url";
    }
    if (raw.headers !== undefined && !isStringRecord(raw.headers)) {
      return "remote server headers must contain only string values";
    }

    const startupTimeoutProblem = raw.startup_timeout_sec === undefined
      ? undefined
      : validateStartupTimeout(raw.startup_timeout_sec);
    if (startupTimeoutProblem !== undefined) {
      return startupTimeoutProblem;
    }

    return {
      type: "remote",
      url: raw.url,
      ...(raw.headers === undefined ? {} : { headers: raw.headers as Record<string, string> }),
      ...(raw.startup_timeout_sec === undefined
        ? {}
        : { startup_timeout_sec: raw.startup_timeout_sec as number }),
    };
  }

  return "type must be local or remote";
}

function validateMcpServers(
  rawServers: Record<string, unknown>,
): { servers: Record<string, McpServerConfig>; warnings: string[] } {
  const servers: Record<string, McpServerConfig> = {};
  const warnings: string[] = [];

  for (const [name, raw] of Object.entries(rawServers)) {
    const validated = validateMcpServer(name, raw);
    if (typeof validated === "string") {
      warnings.push(`WARN: skipped MCP ${name || "<empty name>"} - ${validated}`);
      continue;
    }
    servers[name] = validated;
  }

  return { servers, warnings };
}

function toClaudeConfig(server: McpServerConfig): Record<string, unknown> {
  if (server.type === "local") {
    return {
      type: "stdio",
      command: server.command,
      ...(server.args === undefined ? {} : { args: server.args }),
      ...(server.env === undefined ? {} : { env: server.env }),
    };
  }

  return {
    type: "http",
    url: server.url,
    ...(server.headers === undefined ? {} : { headers: server.headers }),
  };
}

function toOpenCodeConfig(server: McpServerConfig): Record<string, unknown> {
  if (server.type === "local") {
    return {
      type: "local",
      command: [server.command, ...(server.args ?? [])],
      ...(server.env === undefined ? {} : { environment: server.env }),
      ...(server.startup_timeout_sec === undefined
        ? {}
        : { timeout: server.startup_timeout_sec * 1000 }),
    };
  }

  return {
    type: "remote",
    url: server.url,
    ...(server.headers === undefined ? {} : { headers: server.headers }),
    ...(server.startup_timeout_sec === undefined
      ? {}
      : { timeout: server.startup_timeout_sec * 1000 }),
  };
}

function toCodexConfig(server: McpServerConfig): Record<string, unknown> {
  const startupTimeout = server.startup_timeout_sec === undefined
    ? {}
    : { startup_timeout_sec: server.startup_timeout_sec };

  if (server.type === "local") {
    return {
      command: server.command,
      ...(server.args === undefined ? {} : { args: server.args }),
      ...(server.env === undefined ? {} : { env: server.env }),
      ...startupTimeout,
    };
  }

  return {
    url: server.url,
    ...(server.headers === undefined ? {} : { http_headers: server.headers }),
    ...startupTimeout,
  };
}

function jsonObject(raw: string, destination: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`cannot parse ${destination} (${detail})`);
  }

  if (!isRecord(parsed)) {
    throw new Error(`${destination} must contain a JSON object`);
  }
  return parsed;
}

async function readOptional(destination: string): Promise<string | undefined> {
  try {
    return await readFile(destination, "utf8");
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

async function atomicWrite(destination: string, content: string): Promise<void> {
  await mkdir(dirname(destination), { recursive: true });
  const temporary = resolve(
    dirname(destination),
    `.${basename(destination)}.${process.pid}.${randomUUID()}.tmp`,
  );

  try {
    await writeFile(temporary, content, "utf8");
    await rename(temporary, destination);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

async function writeClaude(
  destination: string,
  servers: Record<string, McpServerConfig>,
): Promise<void> {
  const existingRaw = await readOptional(destination);
  const root = existingRaw === undefined ? {} : jsonObject(existingRaw, destination);
  const existingServers = root.mcpServers;
  if (existingServers !== undefined && !isRecord(existingServers)) {
    throw new Error(`${destination} has an invalid mcpServers object`);
  }

  const merged = existingServers ?? {};
  for (const [name, server] of Object.entries(servers)) {
    merged[name] = toClaudeConfig(server);
  }
  root.mcpServers = merged;
  await atomicWrite(destination, `${JSON.stringify(root, null, 2)}\n`);
}

async function writeOpenCode(
  destination: string,
  servers: Record<string, McpServerConfig>,
): Promise<void> {
  const existingRaw = await readOptional(destination);
  const root = existingRaw === undefined
    ? { $schema: "https://opencode.ai/config.json" }
    : jsonObject(existingRaw, destination);
  const existingMcp = root.mcp;
  if (existingMcp !== undefined && !isRecord(existingMcp)) {
    throw new Error(`${destination} has an invalid mcp object`);
  }

  const mcp = existingMcp ?? {};
  const existingV2Servers = mcp.servers;
  if (existingV2Servers !== undefined && !isRecord(existingV2Servers)) {
    throw new Error(`${destination} has an invalid mcp.servers object`);
  }
  const target = existingV2Servers ?? mcp;

  for (const [name, server] of Object.entries(servers)) {
    target[name] = toOpenCodeConfig(server);
  }
  if (existingV2Servers !== undefined) {
    mcp.servers = target;
  }
  root.mcp = mcp;
  await atomicWrite(destination, `${JSON.stringify(root, null, 2)}\n`);
}

function stripCodexServerBlocks(raw: string, names: Set<string>): string {
  const lines = raw.match(/.*(?:\r?\n|$)/g)?.filter((line) => line.length > 0) ?? [];
  let skipping = false;
  const kept: string[] = [];

  for (const line of lines) {
    const header = line.match(/^\s*\[([^\]]+)\]\s*(?:#.*)?(?:\r?\n)?$/);
    if (header !== null) {
      const table = header[1]?.trim() ?? "";
      skipping = [...names].some(
        (name) => table === `mcp_servers.${name}` || table.startsWith(`mcp_servers.${name}.`),
      );
    }
    if (!skipping) {
      kept.push(line);
    }
  }

  return kept.join("");
}

async function writeCodex(
  destination: string,
  servers: Record<string, McpServerConfig>,
): Promise<void> {
  const existingRaw = await readOptional(destination);
  if (existingRaw !== undefined) {
    try {
      parseToml(existingRaw);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`cannot parse ${destination} (${detail})`);
    }
  }

  const converted = Object.fromEntries(
    Object.entries(servers).map(([name, server]) => [name, toCodexConfig(server)]),
  );
  const newline = existingRaw?.includes("\r\n") === true ? "\r\n" : "\n";
  const generated = stringifyToml({ mcp_servers: converted }).trim().replaceAll("\n", newline);
  const preserved = stripCodexServerBlocks(existingRaw ?? "", new Set(Object.keys(servers)));
  const separator = preserved.length === 0
    ? ""
    : preserved.endsWith(`${newline}${newline}`)
      ? ""
      : preserved.endsWith(newline)
        ? newline
        : `${newline}${newline}`;
  const content = `${preserved}${separator}${generated}${newline}`;

  try {
    parseToml(content);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`cannot safely merge ${destination} (${detail})`);
  }
  await atomicWrite(destination, content);
}

async function writePlatform(
  platform: Platform,
  destination: string,
  servers: Record<string, McpServerConfig>,
): Promise<void> {
  if (platform === "codex") {
    await writeCodex(destination, servers);
  } else if (platform === "claude") {
    await writeClaude(destination, servers);
  } else {
    await writeOpenCode(destination, servers);
  }
}

export async function writeMcpServers(
  rawServers: Record<string, unknown>,
  cwd: string,
  platforms: readonly Platform[],
): Promise<McpWriteResult> {
  const validated = validateMcpServers(rawServers);
  const result: McpWriteResult = { written: [], warnings: [...validated.warnings] };
  const names = Object.keys(validated.servers);
  if (names.length === 0) {
    return result;
  }

  for (const platform of platforms) {
    const destination = resolvePlatformMcpFile(cwd, platform);
    try {
      await writePlatform(platform, destination, validated.servers);
      result.written.push(...names.map((name) => ({ name, destination })));
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      const label = relative(cwd, destination) || destination;
      result.warnings.push(`WARN: skipped MCP config ${label} - ${detail}`);
    }
  }

  return result;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
