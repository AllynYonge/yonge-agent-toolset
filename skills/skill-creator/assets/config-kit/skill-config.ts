#!/usr/bin/env bun
/**
 * 技能配置读取工具（config-kit）。
 *
 * 来源：skill-creator/assets/config-kit/skill-config.ts
 * 用法：原样复制到目标技能的 scripts/lib/skill-config.ts，不要在目标技能里单独修改。
 *       需要改动时先改 skill-creator 里的这一份，再同步到各技能，避免各技能的读取规则悄悄分叉。
 *
 * 实现的约定（详见 skill-creator/references/config-paradigm.md）：
 *   - 偏好文件：<cwd>/.yonge/.yonge-skills/<技能名>/EXTEND.md → ~/.yonge/.yonge-skills/<技能名>/EXTEND.md，命中第一个就停，不合并
 *   - 密钥文件：<cwd>/.yonge/.yonge-skills/.env 与 ~/.yonge/.yonge-skills/.env
 *   - 优先级：CLI 参数 > EXTEND.md > 进程环境变量 > 项目 .env > 用户 .env > 内置默认值
 *   - 密钥只能放 .env；EXTEND.md 里出现密钥类字段直接报错
 *
 * 零依赖，Bun 与 Node 均可运行。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

export const CONFIG_KIT_VERSION = 1;
export const CONFIG_ROOT = path.join(".yonge", ".yonge-skills");
export const EXTEND_FILE = "EXTEND.md";
export const ENV_FILE = ".env";

export type Scalar = string | number | boolean | null;
export type ConfigValue = Scalar | ConfigMap;
export interface ConfigMap {
  [key: string]: ConfigValue;
}

export type ConfigScope = "project" | "user";

export interface ConfigSource {
  scope: ConfigScope;
  path: string;
}

export interface LocateOptions {
  /** 项目目录，默认 process.cwd() */
  cwd?: string;
  /** 用户主目录，默认 os.homedir() */
  home?: string;
}

export interface LoadConfigOptions extends LocateOptions {
  /** 技能名，即配置目录名 */
  skill: string;
  /** 本实现支持的最高 schema 版本，默认 1 */
  supportedVersion?: number;
  /**
   * 允许的字段路径，用点号分隔，`*` 匹配一段。例如 ["version", "default_model.*", "batch.max_workers"]。
   * 提供后，未列出的字段会进入 warnings，而不是被静默丢弃。
   */
  allowedKeys?: string[];
}

export interface LoadConfigResult {
  config: ConfigMap;
  /** 未找到 EXTEND.md 时为 null */
  source: ConfigSource | null;
  warnings: string[];
}

/** 配置写法有误。带文件路径与行号，便于用户直接定位。 */
export class ConfigError extends Error {
  constructor(message: string, readonly filePath?: string, readonly line?: number) {
    const where = filePath ? `${filePath}${line ? `:${line}` : ""}：` : "";
    super(`${where}${message}`);
    this.name = "ConfigError";
  }
}

// ---------------------------------------------------------------------------
// 路径
// ---------------------------------------------------------------------------

function resolveDirs(options: LocateOptions = {}): { project: string; user: string } {
  const cwd = options.cwd ?? process.cwd();
  const home = options.home ?? (process.env.HOME || process.env.USERPROFILE || os.homedir());
  return { project: path.join(cwd, CONFIG_ROOT), user: path.join(home, CONFIG_ROOT) };
}

/** 按查找顺序列出某个技能的 EXTEND.md 候选路径。 */
export function extendCandidates(skill: string, options: LocateOptions = {}): ConfigSource[] {
  const dirs = resolveDirs(options);
  return [
    { scope: "project", path: path.join(dirs.project, skill, EXTEND_FILE) },
    { scope: "user", path: path.join(dirs.user, skill, EXTEND_FILE) },
  ];
}

/** 按查找顺序列出 .env 候选路径（项目在前，项目覆盖用户）。 */
export function envCandidates(options: LocateOptions = {}): ConfigSource[] {
  const dirs = resolveDirs(options);
  return [
    { scope: "project", path: path.join(dirs.project, ENV_FILE) },
    { scope: "user", path: path.join(dirs.user, ENV_FILE) },
  ];
}

function isFile(filePath: string): boolean {
  try {
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

/** 返回第一个存在的 EXTEND.md；都不存在返回 null。 */
export function findExtendFile(skill: string, options: LocateOptions = {}): ConfigSource | null {
  return extendCandidates(skill, options).find((candidate) => isFile(candidate.path)) ?? null;
}

// ---------------------------------------------------------------------------
// EXTEND.md 解析（YAML 子集）
// ---------------------------------------------------------------------------

/**
 * 解析 EXTEND.md 的 front matter。支持的写法：
 *   - 多层嵌套映射（缩进只能用空格，同一层缩进必须一致）
 *   - 标量：字符串（可带单/双引号）、整数/小数、true/false、null/~/空值
 *   - 整行注释与行内注释（未加引号的值里，空格后的 # 起算注释；值本身以 # 开头或含「空格 + #」时必须加引号）
 * 不支持、遇到即报错（不会静默丢弃）：
 *   - 数组（`- item`）、flow 写法（`{a: 1}` / `[1, 2]`）、多行字符串（`|` / `>`）、锚点与别名（`&` / `*`）
 *   - Tab 缩进、重复键、缺少 front matter
 */
export function parseExtend(content: string, filePath = EXTEND_FILE): ConfigMap {
  const lines = content.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n").split("\n");
  if (lines[0]?.trim() !== "---") {
    throw new ConfigError("缺少 front matter：文件第一行必须是 ---", filePath, 1);
  }
  const end = lines.findIndex((line, index) => index > 0 && line.trim() === "---");
  if (end === -1) {
    throw new ConfigError("front matter 没有闭合：缺少结尾的 ---", filePath);
  }
  return parseYamlSubset(lines.slice(1, end), 2, filePath);
}

interface Frame {
  indent: number;
  map: ConfigMap;
}

interface Pending {
  map: ConfigMap;
  key: string;
  indent: number;
}

function parseYamlSubset(lines: string[], firstLineNo: number, filePath: string): ConfigMap {
  const root: ConfigMap = {};
  const stack: Frame[] = [{ indent: 0, map: root }];
  let pending: Pending | null = null;

  lines.forEach((line, offset) => {
    const lineNo = firstLineNo + offset;
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) return;

    const leading = line.match(/^[ \t]*/)?.[0] ?? "";
    if (leading.includes("\t")) throw new ConfigError("缩进只能用空格，不能用 Tab", filePath, lineNo);
    const indent = leading.length;

    if (trimmed === "-" || trimmed.startsWith("- ")) {
      throw new ConfigError("不支持数组写法（- item）。请改成映射，或拆成多个字段", filePath, lineNo);
    }

    // 键名不允许点号：点号用来表示嵌套路径（default_model.ark），允许了会产生歧义
    const match = trimmed.match(/^([A-Za-z0-9_-]+)\s*:(?:\s+(.*)|)$/);
    if (!match) throw new ConfigError(`无法识别的行：${trimmed}（应为 key: value）`, filePath, lineNo);
    const key = match[1]!;
    const rawValue = match[2] ?? "";

    // 上一行是空值的键：本行缩进更深则它是父级映射，否则它就是 null
    if (pending && indent > pending.indent) {
      const child: ConfigMap = {};
      pending.map[pending.key] = child;
      stack.push({ indent, map: child });
    }
    pending = null;

    while (stack.length > 1 && indent < stack[stack.length - 1]!.indent) stack.pop();
    const frame = stack[stack.length - 1]!;
    if (indent !== frame.indent) {
      throw new ConfigError(`缩进不一致：本行缩进 ${indent} 个空格，同层应为 ${frame.indent} 个`, filePath, lineNo);
    }
    if (Object.prototype.hasOwnProperty.call(frame.map, key)) {
      throw new ConfigError(`重复的键：${key}`, filePath, lineNo);
    }

    const value = parseScalar(rawValue, filePath, lineNo);
    frame.map[key] = value;
    if (value === null && stripComment(rawValue) === "") pending = { map: frame.map, key, indent };
  });

  return root;
}

function stripComment(raw: string): string {
  const value = raw.trim();
  if (value.startsWith("#")) return "";
  return value.replace(/\s+#.*$/, "").trim();
}

function parseScalar(raw: string, filePath: string, lineNo: number): Scalar {
  const value = raw.trim();

  const double = value.match(/^"((?:[^"\\]|\\.)*)"\s*(?:#.*)?$/);
  if (double) return double[1]!.replace(/\\(["\\])/g, "$1");
  const single = value.match(/^'((?:[^']|'')*)'\s*(?:#.*)?$/);
  if (single) return single[1]!.replace(/''/g, "'");

  const bare = stripComment(value);
  if (/^[{[]/.test(bare)) throw new ConfigError("不支持 flow 写法（{...} / [...]），请改成逐行缩进的映射", filePath, lineNo);
  if (/^[|>]/.test(bare)) throw new ConfigError("不支持多行字符串（| / >），请写成单行", filePath, lineNo);
  if (/^[&*]/.test(bare)) throw new ConfigError("不支持锚点与别名（& / *）", filePath, lineNo);

  if (bare === "" || bare === "~" || bare.toLowerCase() === "null") return null;
  if (bare.toLowerCase() === "true") return true;
  if (bare.toLowerCase() === "false") return false;
  if (/^-?\d+(\.\d+)?$/.test(bare)) return Number(bare);
  return bare;
}

// ---------------------------------------------------------------------------
// 校验
// ---------------------------------------------------------------------------

/** 字段名的最后一段命中这些后缀即视为密钥。 */
const SECRET_KEY_PATTERN = /(^|_)(api_?key|secret|secret_key|app_secret|token|access_token|refresh_token|access_key|password|passwd)$/i;

export function isSecretKey(key: string): boolean {
  return SECRET_KEY_PATTERN.test(key);
}

/** 把嵌套映射展开成「点号路径 → 叶子值」。空映射本身算一个叶子。 */
export function flattenConfig(config: ConfigMap, prefix = ""): Array<[string, Scalar | ConfigMap]> {
  const entries: Array<[string, Scalar | ConfigMap]> = [];
  for (const [key, value] of Object.entries(config)) {
    const fullKey = prefix ? `${prefix}.${key}` : key;
    if (value !== null && typeof value === "object" && Object.keys(value).length > 0) {
      entries.push(...flattenConfig(value, fullKey));
    } else {
      entries.push([fullKey, value]);
    }
  }
  return entries;
}

function matchesPattern(keyPath: string, pattern: string): boolean {
  const keyParts = keyPath.split(".");
  const patternParts = pattern.split(".");
  // 父级映射写成空值（如 `default_model:` 下面什么都没有）时，路径是模式的前缀，也算合法
  if (keyParts.length < patternParts.length) {
    return keyParts.every((part, index) => patternParts[index] === "*" || patternParts[index] === part);
  }
  if (keyParts.length !== patternParts.length) return false;
  return patternParts.every((part, index) => part === "*" || part === keyParts[index]);
}

function validateConfig(config: ConfigMap, filePath: string, options: LoadConfigOptions): string[] {
  const warnings: string[] = [];
  const supported = options.supportedVersion ?? 1;

  const version = config.version;
  if (version === undefined || version === null) {
    warnings.push(`${filePath}：缺少 version 字段，按 version: ${supported} 处理`);
  } else if (typeof version !== "number" || !Number.isInteger(version)) {
    throw new ConfigError(`version 必须是整数，当前为 ${JSON.stringify(version)}`, filePath);
  } else if (version > supported) {
    throw new ConfigError(`配置版本 ${version} 高于当前技能支持的版本 ${supported}，请升级技能或把 version 改回 ${supported}`, filePath);
  }

  for (const [keyPath, value] of flattenConfig(config)) {
    const leafKey = keyPath.split(".").pop()!;
    if (value !== null && isSecretKey(leafKey)) {
      throw new ConfigError(
        `字段 ${keyPath} 看起来是密钥。密钥不能写进 EXTEND.md，请删除该字段，改写到 ${path.join("~", CONFIG_ROOT, ENV_FILE)}`,
        filePath,
      );
    }
    if (options.allowedKeys && !options.allowedKeys.some((pattern) => matchesPattern(keyPath, pattern))) {
      warnings.push(`${filePath}：未知字段 ${keyPath}，已忽略（检查是否拼写错误或层级不对）`);
    }
  }
  return warnings;
}

// ---------------------------------------------------------------------------
// 加载
// ---------------------------------------------------------------------------

/**
 * 加载技能偏好。未找到 EXTEND.md 时返回空配置与 source: null，由调用方决定是否走首次设置。
 * 写法错误、版本过高、出现密钥字段时抛出 ConfigError。
 */
export function loadSkillConfig(options: LoadConfigOptions): LoadConfigResult {
  const source = findExtendFile(options.skill, options);
  if (!source) return { config: {}, source: null, warnings: [] };
  const config = parseExtend(fs.readFileSync(source.path, "utf8"), source.path);
  const warnings = validateConfig(config, source.path, options);
  return { config, source, warnings };
}

/** 按点号路径读取配置值，不存在时返回 undefined。 */
export function getConfigValue(config: ConfigMap, keyPath: string): ConfigValue | undefined {
  let current: ConfigValue | undefined = config;
  for (const part of keyPath.split(".")) {
    if (current === null || typeof current !== "object") return undefined;
    current = current[part];
  }
  return current;
}

/** 返回第一个「有值」的候选（跳过 undefined、null、空字符串）。用来按优先级链取值。 */
export function pickFirst<T>(...candidates: Array<T | null | undefined>): T | undefined {
  return candidates.find((value) => value !== undefined && value !== null && value !== "") as T | undefined;
}

// ---------------------------------------------------------------------------
// .env 与密钥
// ---------------------------------------------------------------------------

/** 解析 .env：KEY=VALUE，可带 export 前缀与引号；未加引号的值里，空格后的 # 起算注释。 */
export function parseDotEnv(content: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const rawLine of content.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n").split("\n")) {
    const line = rawLine.trim().replace(/^export\s+/, "");
    if (!line || line.startsWith("#")) continue;
    const index = line.indexOf("=");
    if (index <= 0) continue;
    const key = line.slice(0, index).trim();
    let value = line.slice(index + 1).trim();
    const quoted = value.match(/^(["'])(.*)\1\s*(?:#.*)?$/);
    if (quoted) value = quoted[2]!;
    else value = value.replace(/\s+#.*$/, "").trim();
    result[key] = value;
  }
  return result;
}

export interface LoadDotEnvOptions extends LocateOptions {
  /** 写入目标，默认 process.env */
  env?: Record<string, string | undefined>;
}

export interface LoadDotEnvResult {
  /** 实际存在并读取过的 .env 文件 */
  files: string[];
  /** 本次写入的变量名 → 来源文件（已存在于环境里的变量不会被覆盖，也不会出现在这里） */
  applied: Record<string, string>;
}

/**
 * 把 .env 中的变量写入环境。进程里已有的变量不覆盖；项目 .env 先读，所以项目覆盖用户。
 * 最终效果：进程环境变量 > 项目 .env > 用户 .env。
 */
export function loadDotEnv(options: LoadDotEnvOptions = {}): LoadDotEnvResult {
  const env = options.env ?? process.env;
  const result: LoadDotEnvResult = { files: [], applied: {} };
  for (const candidate of envCandidates(options)) {
    if (!isFile(candidate.path)) continue;
    result.files.push(candidate.path);
    for (const [key, value] of Object.entries(parseDotEnv(fs.readFileSync(candidate.path, "utf8")))) {
      if (env[key] !== undefined && env[key] !== "") continue;
      env[key] = value;
      result.applied[key] = candidate.path;
    }
  }
  return result;
}

/** 把别名转成环境变量片段：大写，非字母数字转下划线。 */
export function envSegment(value: string): string {
  return value.trim().toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

export interface SecretLookup {
  /** 变量前缀，如 "WECHAT"、"ARK" */
  prefix: string;
  /** 密钥名，如 "APP_SECRET"、"API_KEY" */
  key: string;
  /** 多账号别名。提供时先查 <PREFIX>_<ALIAS>_<KEY>，再回退到 <PREFIX>_<KEY> */
  alias?: string | null;
}

/** 按查找顺序列出密钥变量名。报错时把这份清单告诉用户，用户就知道该写哪个名字。 */
export function secretNames(lookup: SecretLookup): string[] {
  const prefix = envSegment(lookup.prefix);
  const key = envSegment(lookup.key);
  const names = [`${prefix}_${key}`];
  if (lookup.alias) names.unshift(`${prefix}_${envSegment(lookup.alias)}_${key}`);
  return names;
}

/** 读取密钥。先调用 loadDotEnv，再调用本函数。找不到返回 null。 */
export function resolveSecret(
  lookup: SecretLookup,
  env: Record<string, string | undefined> = process.env,
): { name: string; value: string } | null {
  for (const name of secretNames(lookup)) {
    const value = env[name]?.trim();
    if (value) return { name, value };
  }
  return null;
}

// ---------------------------------------------------------------------------
// 命令行：检查某个技能的配置是否能被正确读取（只显示变量名，不显示密钥值）
// ---------------------------------------------------------------------------

function runCli(argv: string[]): number {
  const args = { skill: "", cwd: process.cwd(), json: false, allowedKeys: undefined as string[] | undefined };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--skill") args.skill = argv[++i] ?? "";
    else if (arg === "--cwd") args.cwd = path.resolve(argv[++i] ?? ".");
    else if (arg === "--allowed") args.allowedKeys = (argv[++i] ?? "").split(",").map((s) => s.trim()).filter(Boolean);
    else if (arg === "--json") args.json = true;
    else if (arg === "-h" || arg === "--help") {
      console.log(`用法: bun skill-config.ts --skill <技能名> [--cwd <目录>] [--allowed k1,k2.*] [--json]

退出码: 0 找到并解析成功 | 2 未找到 EXTEND.md | 1 配置写法错误`);
      return 0;
    }
  }
  if (!args.skill) {
    console.error("缺少 --skill <技能名>");
    return 1;
  }

  const report: Record<string, unknown> = {
    candidates: extendCandidates(args.skill, { cwd: args.cwd }).map((c) => `${c.scope}: ${c.path}`),
  };
  let code = 0;
  try {
    const loaded = loadSkillConfig({ skill: args.skill, cwd: args.cwd, allowedKeys: args.allowedKeys });
    report.source = loaded.source;
    report.config = loaded.config;
    report.warnings = loaded.warnings;
    if (!loaded.source) code = 2;
  } catch (error) {
    report.error = error instanceof Error ? error.message : String(error);
    code = 1;
  }

  const envFiles = envCandidates({ cwd: args.cwd })
    .filter((c) => isFile(c.path))
    .map((c) => ({ ...c, keys: Object.keys(parseDotEnv(fs.readFileSync(c.path, "utf8"))) }));
  report.envFiles = envFiles;

  if (args.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(`查找顺序：\n  ${(report.candidates as string[]).join("\n  ")}`);
    if (report.error) console.log(`错误：${report.error}`);
    else if (!report.source) console.log("结果：未找到 EXTEND.md，需要走首次设置");
    else {
      const source = report.source as ConfigSource;
      console.log(`命中：${source.scope} ${source.path}`);
      console.log(`内容：${JSON.stringify(report.config, null, 2)}`);
      for (const warning of report.warnings as string[]) console.log(`警告：${warning}`);
    }
    if (!envFiles.length) console.log(".env：未找到");
    for (const file of envFiles) console.log(`.env（${file.scope}）${file.path}：${file.keys.join(", ") || "（空）"}`);
  }
  return code;
}

const isMain =
  (import.meta as { main?: boolean }).main ??
  (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url));

if (isMain) process.exit(runCli(process.argv.slice(2)));
