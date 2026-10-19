#!/usr/bin/env bun
/**
 * human-writing 偏好语义层。
 *
 * 路径查找与 YAML 解析交给 lib/skill-config.ts（config-kit 原样副本，不要在这里改），
 * 本文件只实现 human-writing 自己的规则：账号识别、全局与账号继承、自定义风格、
 * 合规红线、篇幅档位、输出目录与约束检查参数。命令行入口见 scripts/resolve_preferences.ts。
 *
 * 配置路径（由 config-kit 决定）：{workspace}/.yonge/.yonge-skills/human-writing/EXTEND.md
 *                           或 ~/.yonge/.yonge-skills/human-writing/EXTEND.md
 */
import fs from "node:fs";
import path from "node:path";

import {
  ConfigError,
  loadSkillConfig,
  parseExtend,
  type ConfigMap,
  type ConfigValue,
} from "./skill-config";

export { ConfigError };
export type { ConfigMap, ConfigValue };

export const SKILL_NAME = "human-writing";
export const CONFIG_SUBPATH = [".yonge", ".yonge-skills", SKILL_NAME, "EXTEND.md"].join("/");

export const LENGTH_PRESETS: Record<string, [number, number]> = {
  short: [300, 500],
  medium: [1000, 2000],
  long: [2500, 4000],
};

export const DEFAULTS: ConfigMap = {
  platform: "auto",
  medium: "auto",
  length: "auto",
  deep: "low",
  long_threshold: 3000,
  output_dir: null,
};

/** 这些顶层键不是账号定义。version 只用于 config-kit 的版本检查。 */
export const RESERVED_GLOBAL_KEYS = new Set([
  "version",
  "default_profile",
  "platform",
  "medium",
  "positioning",
  "audience",
  "purpose",
  "custom_style",
  "length",
  "deep",
  "long_threshold",
  "output_dir",
  "avoid_words",
  "compliance_guardrails",
]);

export type LengthRange = [number, number, string];

export interface LoadedConfig {
  config: ConfigMap;
  extendPath: string | null;
  scope: "project" | "user" | "default";
  warnings: string[];
}

export interface ResolvedConstraints {
  effective_config: ConfigMap;
  style_source: string | null;
  length: ConfigValue;
  avoid_words: string[];
}

export interface ProfileResult {
  active_profile: string | null;
  effective_config: ConfigMap;
  platform: ConfigValue;
  medium: ConfigValue;
  style_source: string | null;
  style: ConfigMap;
  compliance_guardrails: string[];
  length: ConfigValue;
  deep: ConfigValue;
  long_threshold: ConfigValue;
  output_dir: string | null;
  avoid_words: string[];
  constraint_check_args: string;
}

export interface ResolvedPreferences {
  config_path: string | null;
  config_scope: "project" | "user" | "default";
  workspace_dir: string;
  available_profiles: string[];
  requested_profiles: string[];
  profiles: Record<string, ProfileResult>;
}

// ---------------------------------------------------------------------------
// 基础工具
// ---------------------------------------------------------------------------

export function isConfigMap(value: ConfigValue | undefined): value is ConfigMap {
  return value !== null && value !== undefined && typeof value === "object" && !Array.isArray(value);
}

export function isAccountKey(key: string, value: ConfigValue | undefined): boolean {
  return isConfigMap(value) && !RESERVED_GLOBAL_KEYS.has(key);
}

/** 把字符串的 `a|b` 写法与列表写法统一成去重后的词表。 */
export function uniqueWords(groups: Array<ConfigValue | undefined>): string[] {
  const seen = new Set<string>();
  const words: string[] = [];
  for (const group of groups) {
    const items: ConfigValue[] =
      typeof group === "string" ? group.split("|") : Array.isArray(group) ? group : [];
    for (const item of items) {
      const word = item === null || item === undefined ? "" : String(item).trim();
      if (word && !seen.has(word)) {
        seen.add(word);
        words.push(word);
      }
    }
  }
  return words;
}

/** 账号字段覆盖全局，但 avoid_words 取并集而不是替换。 */
export function mergeAvoidWords(globalFields: ConfigMap, account: ConfigMap): ConfigMap {
  const effective: ConfigMap = { ...globalFields, ...account };
  if ("avoid_words" in globalFields && "avoid_words" in account) {
    effective.avoid_words = uniqueWords([globalFields.avoid_words, account.avoid_words]);
  }
  return effective;
}

/** 内置风格预设已取消。遗留的 writing_style 直接报错，避免被静默忽略。 */
export function rejectRemovedStyleKey(effective: ConfigMap): void {
  if ("writing_style" in effective) {
    throw new ConfigError(
      "writing_style 已取消，内置风格预设不再提供。请删除该字段，需要固定声音时改用 custom_style",
    );
  }
}

/** 与旧解析器一致的标量转换，用于 --length 这类命令行值。 */
export function parseScalarArg(raw: string): ConfigValue {
  const value = raw.trim();
  const quoted =
    (value.startsWith('"') && value.endsWith('"') && value.length > 1) ||
    (value.startsWith("'") && value.endsWith("'") && value.length > 1);
  if (quoted) return value.slice(1, -1);
  if (value === "true" || value === "True") return true;
  if (value === "false" || value === "False") return false;
  if (/^-?\d+$/.test(value)) return Number(value);
  return value;
}

export function resolveLengthRange(value: ConfigValue | undefined): LengthRange | null {
  if (value === null || value === undefined || value === "auto") return null;
  if (typeof value === "number") {
    return [Math.floor(value * 0.85), Math.ceil(value * 1.15), `${value} +/-15%`];
  }
  const text = String(value).trim();
  const preset = LENGTH_PRESETS[text];
  if (preset) return [preset[0], preset[1], text];
  const match = text.match(/^(\d+)\s*[-~到至]\s*(\d+)$/);
  if (match) {
    let lower = Number(match[1]);
    let upper = Number(match[2]);
    if (lower > upper) [lower, upper] = [upper, lower];
    return [lower, upper, text];
  }
  throw new ConfigError(`unrecognized length value: ${JSON.stringify(value)}`);
}

/** 与 shlex.quote 一致：能不加引号就不加，需要时用单引号包起来。 */
export function shellArgs(parts: string[]): string {
  return parts.map(shellQuote).join(" ");
}

function shellQuote(value: string): string {
  if (!value) return "''";
  if (!/[^\w@%+=:,./-]/.test(value)) return value;
  return "'" + value.split("'").join("'\"'\"'") + "'";
}

function withDefault(config: ConfigMap, key: string, fallback: ConfigValue): ConfigValue {
  return key in config ? (config[key] as ConfigValue) : fallback;
}

// ---------------------------------------------------------------------------
// 读取配置
// ---------------------------------------------------------------------------

/** 读取某个工作目录生效的配置（项目级优先，命中第一个就停）。 */
export function loadConfigForWorkspace(workspaceDir: string, home?: string): LoadedConfig {
  const loaded = loadSkillConfig({ skill: SKILL_NAME, cwd: workspaceDir, home });
  return {
    config: { ...DEFAULTS, ...loaded.config },
    extendPath: loaded.source?.path ?? null,
    scope: loaded.source?.scope ?? "default",
    warnings: loaded.warnings,
  };
}

/** 按显式路径读取配置（check_constraints 的 --extend 用）。文件不存在视为空配置。 */
export function loadYamlFile(filePath: string | null | undefined): ConfigMap {
  if (!filePath || !fs.existsSync(filePath)) return {};
  return parseExtend(fs.readFileSync(filePath, "utf8"), filePath);
}

// ---------------------------------------------------------------------------
// 账号与继承
// ---------------------------------------------------------------------------

export function extractAccounts(config: ConfigMap): Record<string, ConfigMap> {
  const accounts: Record<string, ConfigMap> = {};
  for (const [key, value] of Object.entries(config)) {
    if (isAccountKey(key, value)) accounts[key] = value as ConfigMap;
  }
  return accounts;
}

export function extractGlobalFields(config: ConfigMap): ConfigMap {
  const fields: ConfigMap = {};
  for (const [key, value] of Object.entries(config)) {
    if (!isAccountKey(key, value)) fields[key] = value;
  }
  return fields;
}

function availableNames(accounts: Record<string, ConfigMap>): string {
  const names = Object.keys(accounts).sort();
  return names.length ? names.join(", ") : "(none)";
}

export function chooseDefaultProfile(
  config: ConfigMap,
  accounts: Record<string, ConfigMap>,
): string | null {
  const defaultProfile = config.default_profile;
  if (defaultProfile) {
    if (typeof defaultProfile !== "string" || !(defaultProfile in accounts)) {
      throw new ConfigError(
        `default_profile '${String(defaultProfile)}' not found. Available: ${availableNames(accounts)}`,
      );
    }
    return defaultProfile;
  }

  const names = Object.keys(accounts);
  if (names.length === 1) return names[0]!;
  if (names.length > 1) {
    throw new ConfigError(
      `multiple profiles found but no default_profile is set. Use --profile. Available: ${availableNames(accounts)}`,
    );
  }
  return null;
}

export function resolveEffectiveConfig(
  baseConfig: ConfigMap,
  profileName: string | null,
): ConfigMap {
  const accounts = extractAccounts(baseConfig);
  const globalFields = extractGlobalFields(baseConfig);

  if (profileName) {
    if (!(profileName in accounts)) {
      throw new ConfigError(
        `profile '${profileName}' not found. Available: ${availableNames(accounts)}`,
      );
    }
    const effective = mergeAvoidWords(globalFields, accounts[profileName]!);
    effective._active_profile = profileName;
    return effective;
  }

  const defaultProfile = chooseDefaultProfile(baseConfig, accounts);
  let effective: ConfigMap = { ...globalFields };
  if (defaultProfile) {
    effective = mergeAvoidWords(effective, accounts[defaultProfile]!);
    effective._active_profile = defaultProfile;
  }
  return effective;
}

/** 返回配置的 custom_style；没有配置时返回空对象与 null。 */
export function loadStyle(effective: ConfigMap): [ConfigMap, string | null] {
  rejectRemovedStyleKey(effective);
  const raw = effective.custom_style;
  if (raw === null || raw === undefined || raw === "" || raw === false || raw === 0) return [{}, null];
  if (Array.isArray(raw)) {
    if (!raw.length) return [{}, null];
    throw new ConfigError("custom_style must be an object");
  }
  if (!isConfigMap(raw)) throw new ConfigError("custom_style must be an object");
  if (!Object.keys(raw).length) return [{}, null];
  return [raw, "custom_style"];
}

/** 先看账号与全局，再回退到 custom_style；显式 `[]` 表示不使用下层清单。 */
export function resolveComplianceGuardrails(
  effective: ConfigMap,
  styleConfig: ConfigMap,
): string[] {
  const hasOwn = "compliance_guardrails" in effective;
  const value: ConfigValue = hasOwn
    ? (effective.compliance_guardrails as ConfigValue)
    : withDefault(styleConfig, "compliance_guardrails", []);
  const field = hasOwn ? "compliance_guardrails" : "style.compliance_guardrails";

  if (!Array.isArray(value)) {
    throw new ConfigError(`${field} must be a list of non-empty strings; use [] for no rules`);
  }

  const rules: string[] = [];
  value.forEach((rule, index) => {
    if (typeof rule !== "string" || !rule.trim()) {
      throw new ConfigError(`${field}[${index + 1}] must be a non-empty string`);
    }
    rules.push(rule.trim());
  });
  return rules;
}

export function resolveOutputDir(
  workspaceDir: string,
  value: ConfigValue | undefined,
): string | null {
  if (value === null || value === undefined || value === "" || value === "auto") return null;
  if (typeof value !== "string") throw new ConfigError("output_dir must be a string path");
  const requested = value.trim();
  if (!requested) return null;
  return path.resolve(workspaceDir, requested);
}

// ---------------------------------------------------------------------------
// 组合结果
// ---------------------------------------------------------------------------

export function buildProfileResult(
  extendPath: string | null,
  profileName: string | null,
  config: ConfigMap,
  workspaceDir: string,
): ProfileResult {
  const effective = resolveEffectiveConfig(config, profileName);
  const [styleConfig, styleSource] = loadStyle(effective);
  const guardrails = resolveComplianceGuardrails(effective, styleConfig);
  const outputDir = resolveOutputDir(
    workspaceDir,
    withDefault(effective, "output_dir", DEFAULTS.output_dir!),
  );
  const avoidWords = uniqueWords([styleConfig.words_to_avoid, effective.avoid_words]);

  const constraintArgs: string[] = [];
  const activeProfile = effective._active_profile;
  if (extendPath) constraintArgs.push("--extend", extendPath);
  if (activeProfile) constraintArgs.push("--profile", String(activeProfile));

  return {
    active_profile: activeProfile ? String(activeProfile) : null,
    effective_config: effective,
    platform: withDefault(effective, "platform", DEFAULTS.platform!),
    medium: withDefault(effective, "medium", DEFAULTS.medium!),
    style_source: styleSource,
    style: styleConfig,
    compliance_guardrails: guardrails,
    length: withDefault(effective, "length", DEFAULTS.length!),
    deep: withDefault(effective, "deep", DEFAULTS.deep!),
    long_threshold: withDefault(effective, "long_threshold", DEFAULTS.long_threshold!),
    output_dir: outputDir,
    avoid_words: avoidWords,
    constraint_check_args: shellArgs(constraintArgs),
  };
}

export function resolvePreferences(
  workspaceDir: string,
  requestedProfiles: string[],
): { resolved: ResolvedPreferences; warnings: string[] } {
  const loaded = loadConfigForWorkspace(workspaceDir);
  const accounts = extractAccounts(loaded.config);
  const profileNames = requestedProfiles.length ? requestedProfiles : [null];
  const profiles: Record<string, ProfileResult> = {};

  for (const profileName of profileNames) {
    const result = buildProfileResult(loaded.extendPath, profileName, loaded.config, workspaceDir);
    profiles[result.active_profile ?? "__default__"] = result;
  }

  return {
    resolved: {
      config_path: loaded.extendPath,
      config_scope: loaded.scope,
      workspace_dir: workspaceDir,
      available_profiles: Object.keys(accounts).sort(),
      requested_profiles: requestedProfiles,
      profiles,
    },
    warnings: loaded.warnings,
  };
}

/** 解析 check_constraints 需要的篇幅与规避词边界。 */
export function resolveConstraints(
  extendPath: string | null,
  profile: string | null,
  explicitLength: string | null,
): ResolvedConstraints {
  const baseConfig = loadYamlFile(extendPath);
  const effective = resolveEffectiveConfig(baseConfig, profile);
  const [styleConfig, styleSource] = loadStyle(effective);

  if (explicitLength !== null) effective.length = parseScalarArg(explicitLength);

  return {
    effective_config: effective,
    style_source: styleSource,
    length: "length" in effective ? (effective.length as ConfigValue) : "auto",
    avoid_words: uniqueWords([styleConfig.words_to_avoid, effective.avoid_words]),
  };
}

export function splitProfiles(profileValue: string | null | undefined): string[] {
  if (!profileValue) return [];
  return profileValue
    .split("|")
    .map((item) => item.trim())
    .filter(Boolean);
}
