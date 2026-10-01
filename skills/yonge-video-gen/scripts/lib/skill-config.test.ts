/**
 * skill-config.ts 的行为测试。复制到目标技能时可一并复制，用 `bun test` 运行。
 */
import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  ConfigError,
  getConfigValue,
  loadDotEnv,
  loadSkillConfig,
  parseDotEnv,
  parseExtend,
  pickFirst,
  resolveSecret,
  secretNames,
} from "./skill-config";

const tempDirs: string[] = [];

function makeTemp(): { cwd: string; home: string } {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "skill-config-"));
  tempDirs.push(base);
  const cwd = path.join(base, "project");
  const home = path.join(base, "home");
  fs.mkdirSync(cwd, { recursive: true });
  fs.mkdirSync(home, { recursive: true });
  return { cwd, home };
}

function writeFile(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("parseExtend", () => {
  test("解析嵌套映射、标量、注释与正文", () => {
    const config = parseExtend(`---
version: 1
default_provider: ark   # 行内注释
default_ratio: "9:16"
default_duration: 8
default_watermark: false
default_color: "#0F4C81"
empty_value:
default_model:
  ark: doubao-seedance
  openai: ~
batch:
  max_workers: 2
  provider_limits:
    ark:
      concurrency: 1
---

正文不参与解析。default_provider: openai
`);
    expect(config).toEqual({
      version: 1,
      default_provider: "ark",
      default_ratio: "9:16",
      default_duration: 8,
      default_watermark: false,
      default_color: "#0F4C81",
      empty_value: null,
      default_model: { ark: "doubao-seedance", openai: null },
      batch: { max_workers: 2, provider_limits: { ark: { concurrency: 1 } } },
    });
  });

  test("未加引号的 # 开头值被当作注释，结果为 null", () => {
    expect(parseExtend("---\ndefault_color: #0F4C81\n---\n").default_color).toBeNull();
  });

  test.each([
    ["数组", "---\nlist:\n  - a\n---\n", "不支持数组"],
    ["flow 映射", "---\nmodel: {ark: x}\n---\n", "flow"],
    ["flow 数组", "---\nitems: [1, 2]\n---\n", "flow"],
    ["多行字符串", "---\nnote: |\n---\n", "多行"],
    ["Tab 缩进", "---\nbatch:\n\tmax_workers: 2\n---\n", "Tab"],
    ["缩进不一致", "---\nbatch:\n    a: 1\n  b: 2\n---\n", "缩进不一致"],
    ["重复键", "---\nversion: 1\nversion: 2\n---\n", "重复"],
    ["缺少 front matter", "version: 1\n", "front matter"],
    ["front matter 未闭合", "---\nversion: 1\n", "闭合"],
  ])("%s 直接报错而不是静默丢弃", (_name, content, message) => {
    expect(() => parseExtend(content, "/tmp/EXTEND.md")).toThrow(message);
  });

  test("错误信息带文件路径与行号", () => {
    try {
      parseExtend("---\nversion: 1\nlist:\n  - a\n---\n", "/tmp/EXTEND.md");
      throw new Error("应当报错");
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      expect((error as ConfigError).message).toContain("/tmp/EXTEND.md:4");
    }
  });
});

describe("loadSkillConfig", () => {
  test("项目级优先，命中第一个就停，不合并", () => {
    const { cwd, home } = makeTemp();
    writeFile(path.join(cwd, ".yonge/.yonge-skills/demo/EXTEND.md"), "---\nversion: 1\na: project\n---\n");
    writeFile(path.join(home, ".yonge/.yonge-skills/demo/EXTEND.md"), "---\nversion: 1\na: user\nb: user\n---\n");
    const result = loadSkillConfig({ skill: "demo", cwd, home });
    expect(result.source?.scope).toBe("project");
    expect(result.config).toEqual({ version: 1, a: "project" });
  });

  test("只有用户级时读取用户级", () => {
    const { cwd, home } = makeTemp();
    writeFile(path.join(home, ".yonge/.yonge-skills/demo/EXTEND.md"), "---\nversion: 1\na: user\n---\n");
    expect(loadSkillConfig({ skill: "demo", cwd, home }).source?.scope).toBe("user");
  });

  test("都不存在时返回 source: null", () => {
    const { cwd, home } = makeTemp();
    expect(loadSkillConfig({ skill: "demo", cwd, home })).toEqual({ config: {}, source: null, warnings: [] });
  });

  test("版本高于支持版本时报错", () => {
    const { cwd, home } = makeTemp();
    writeFile(path.join(home, ".yonge/.yonge-skills/demo/EXTEND.md"), "---\nversion: 2\n---\n");
    expect(() => loadSkillConfig({ skill: "demo", cwd, home })).toThrow("高于当前技能支持的版本");
  });

  test("缺少 version 给出警告", () => {
    const { cwd, home } = makeTemp();
    writeFile(path.join(home, ".yonge/.yonge-skills/demo/EXTEND.md"), "---\na: 1\n---\n");
    expect(loadSkillConfig({ skill: "demo", cwd, home }).warnings[0]).toContain("缺少 version");
  });

  test("密钥类字段写进 EXTEND.md 时报错，即使在嵌套层级里", () => {
    const { cwd, home } = makeTemp();
    writeFile(
      path.join(home, ".yonge/.yonge-skills/demo/EXTEND.md"),
      "---\nversion: 1\naccounts:\n  main:\n    app_secret: abc\n---\n",
    );
    expect(() => loadSkillConfig({ skill: "demo", cwd, home })).toThrow("accounts.main.app_secret");
  });

  test("密钥字段留空不报错", () => {
    const { cwd, home } = makeTemp();
    writeFile(path.join(home, ".yonge/.yonge-skills/demo/EXTEND.md"), "---\nversion: 1\napi_key: null\n---\n");
    expect(() => loadSkillConfig({ skill: "demo", cwd, home })).not.toThrow();
  });

  test("提供 allowedKeys 时，未知字段进入警告", () => {
    const { cwd, home } = makeTemp();
    writeFile(
      path.join(home, ".yonge/.yonge-skills/demo/EXTEND.md"),
      "---\nversion: 1\ndefault_model:\n  ark: x\ndefualt_ratio: 16:9\nbatch:\n---\n",
    );
    const result = loadSkillConfig({
      skill: "demo",
      cwd,
      home,
      allowedKeys: ["version", "default_ratio", "default_model.*", "batch.max_workers"],
    });
    expect(result.warnings).toEqual([expect.stringContaining("未知字段 defualt_ratio")]);
  });
});

describe("取值工具", () => {
  test("getConfigValue 按点号路径取值", () => {
    const config = { default_model: { ark: "x" }, version: 1 };
    expect(getConfigValue(config, "default_model.ark")).toBe("x");
    expect(getConfigValue(config, "default_model.openai")).toBeUndefined();
    expect(getConfigValue(config, "version.sub")).toBeUndefined();
  });

  test("pickFirst 跳过 undefined、null 与空字符串，保留 false 与 0", () => {
    expect(pickFirst(undefined, null, "", "cli")).toBe("cli");
    expect(pickFirst(undefined, false, true)).toBe(false);
    expect(pickFirst(null, 0, 5)).toBe(0);
    expect(pickFirst(undefined, null)).toBeUndefined();
  });
});

describe(".env 与密钥", () => {
  test("parseDotEnv 处理 export、引号与注释", () => {
    expect(
      parseDotEnv(`# 注释
export A=1
B="two words" # 注释
C='single'
D=plain # 注释
E=has#hash
BROKEN
`),
    ).toEqual({ A: "1", B: "two words", C: "single", D: "plain", E: "has#hash" });
  });

  test("优先级：进程环境变量 > 项目 .env > 用户 .env", () => {
    const { cwd, home } = makeTemp();
    writeFile(path.join(cwd, ".yonge/.yonge-skills/.env"), "SHARED=project\nPROJECT_ONLY=p\nFROM_ENV=project\n");
    writeFile(path.join(home, ".yonge/.yonge-skills/.env"), "SHARED=user\nUSER_ONLY=u\n");
    const env: Record<string, string | undefined> = { FROM_ENV: "process" };
    const result = loadDotEnv({ cwd, home, env });
    expect(env).toEqual({ FROM_ENV: "process", SHARED: "project", PROJECT_ONLY: "p", USER_ONLY: "u" });
    expect(result.files).toHaveLength(2);
    expect(result.applied.FROM_ENV).toBeUndefined();
  });

  test("secretNames 先查带别名的变量，再回退到不带别名的", () => {
    expect(secretNames({ prefix: "wechat", key: "app_secret", alias: "ai-tools" })).toEqual([
      "WECHAT_AI_TOOLS_APP_SECRET",
      "WECHAT_APP_SECRET",
    ]);
    expect(secretNames({ prefix: "ARK", key: "API_KEY" })).toEqual(["ARK_API_KEY"]);
  });

  test("resolveSecret 返回命中的变量名", () => {
    const env = { WECHAT_APP_SECRET: "fallback", WECHAT_MAIN_APP_SECRET: " main " };
    expect(resolveSecret({ prefix: "WECHAT", key: "APP_SECRET", alias: "main" }, env)).toEqual({
      name: "WECHAT_MAIN_APP_SECRET",
      value: "main",
    });
    expect(resolveSecret({ prefix: "WECHAT", key: "APP_SECRET", alias: "other" }, env)?.name).toBe("WECHAT_APP_SECRET");
    expect(resolveSecret({ prefix: "ARK", key: "API_KEY" }, env)).toBeNull();
  });
});
