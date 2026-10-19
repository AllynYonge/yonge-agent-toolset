/**
 * human-writing 的回归测试：配置解析、两个检查脚本、以及技能文档的接线。
 *
 * 运行：bun test（技能目录下）
 * 这些测试只覆盖脚本的确定性行为，不认证模型审核质量，也不替代平台合规判断。
 */
import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  ConfigError,
  LENGTH_PRESETS,
  buildProfileResult,
  extractAccounts,
  parseScalarArg,
  resolveComplianceGuardrails,
  resolveConstraints,
  resolveLengthRange,
} from "../scripts/lib/preferences";
import { parseExtend } from "../scripts/lib/skill-config";
import {
  RULE_FILES as CONSTRAINT_RULES,
  buildReport,
  stripSourceBlock,
  visibleCharCount,
  type ResolvedConstraints,
} from "../scripts/check_constraints";
import { RULE_FILES as PROSE_RULES } from "../scripts/check_prose";

const SKILL_ROOT = path.resolve(import.meta.dir, "..");
const SCRIPTS = path.join(SKILL_ROOT, "scripts");

const tempDirs: string[] = [];

function makeTemp(): string {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), "human-writing-"));
  tempDirs.push(folder);
  return folder;
}

afterEach(() => {
  for (const folder of tempDirs.splice(0)) fs.rmSync(folder, { recursive: true, force: true });
});

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

function runScript(script: string, args: string[], home?: string): RunResult {
  const result = Bun.spawnSync([process.execPath, path.join(SCRIPTS, script), ...args], {
    env: { ...process.env, HOME: home ?? path.join(os.tmpdir(), "absent-home"), NO_COLOR: "1" },
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    code: result.exitCode ?? 0,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  };
}

function readText(relative: string): string {
  return fs.readFileSync(path.join(SKILL_ROOT, relative), "utf8");
}

function parseConfig(yaml: string) {
  return parseExtend(`---\n${yaml}\n---\n`, "EXTEND.md");
}

describe("合规红线解析", () => {
  const profile = (config: Record<string, unknown>, name: string | null = null) =>
    buildProfileResult(null, name, config as never, SKILL_ROOT);

  test("没有配置时为空清单", () => {
    const result = profile({});
    expect(result.compliance_guardrails).toEqual([]);
  });

  test("账号覆盖全局，风格里的是回退", () => {
    const data = {
      compliance_guardrails: ["global"],
      demo: { compliance_guardrails: ["account"], custom_style: { name: "c", compliance_guardrails: ["style"] } },
    };
    expect(profile(data, "demo").compliance_guardrails).toEqual(["account"]);
  });

  test("全局优先于风格里的清单", () => {
    const data = {
      compliance_guardrails: ["global"],
      demo: { custom_style: { compliance_guardrails: ["style"] } },
    };
    expect(profile(data, "demo").compliance_guardrails).toEqual(["global"]);
  });

  test("账号缺字段时继承全局", () => {
    const data = { compliance_guardrails: ["global"], demo: { platform: "wechat" } };
    expect(profile(data, "demo").compliance_guardrails).toEqual(["global"]);
  });

  test("没有账号与全局时回退到风格", () => {
    const data = { demo: { custom_style: { compliance_guardrails: ["style"] } } };
    expect(profile(data, "demo").compliance_guardrails).toEqual(["style"]);
  });

  test("风格没有清单时是空数组", () => {
    const result = profile({ custom_style: { name: "custom" } });
    expect(result.style_source).toBe("custom_style");
    expect(result.compliance_guardrails).toEqual([]);
  });

  test("显式空清单不再向下回退", () => {
    const configs = [
      {
        compliance_guardrails: ["global"],
        demo: { compliance_guardrails: [], custom_style: { compliance_guardrails: ["style"] } },
      },
      { compliance_guardrails: [], demo: { custom_style: { compliance_guardrails: ["style"] } } },
      { demo: { custom_style: { compliance_guardrails: [] } } },
    ];
    for (const data of configs) expect(profile(data, "demo").compliance_guardrails).toEqual([]);
  });

  test("规则保留顺序与原文，不与规避词混用", () => {
    const rules = ["  不承诺投资收益  ", "引用来源必须真实", "不承诺投资收益"];
    const data = {
      demo: {
        compliance_guardrails: rules,
        custom_style: { name: "custom", words_to_avoid: "赋能|助力" },
        avoid_words: ["绝对安全"],
        length: "800-1500",
      },
    };
    const result = profile(data, "demo");
    expect(result.compliance_guardrails).toEqual([
      "不承诺投资收益",
      "引用来源必须真实",
      "不承诺投资收益",
    ]);
    expect(rules[0]).toBe("  不承诺投资收益  ");
    expect(result.avoid_words).toEqual(["赋能", "助力", "绝对安全"]);
    expect(result.length).toBe("800-1500");
    expect(result.constraint_check_args).toBe("--profile demo");
  });

  test("非法取值直接报错", () => {
    const invalid: unknown[] = [
      null,
      "",
      "auto",
      "null",
      "~",
      "no claims",
      false,
      3,
      {},
      { rule: "text" },
      [""],
      ["  "],
      [false],
      [3],
      [{}],
      [[]],
    ];
    for (const value of invalid) {
      for (const location of ["effective", "style"] as const) {
        const effective = location === "effective" ? { compliance_guardrails: value } : {};
        const style = location === "style" ? { compliance_guardrails: value } : {};
        expect(() => resolveComplianceGuardrails(effective as never, style as never)).toThrow(
          /compliance_guardrails/,
        );
      }
    }
  });

  test("全局写成映射时不识别为账号", () => {
    const data = { compliance_guardrails: { bad: "shape" }, demo: { platform: "wechat" } };
    expect(Object.keys(extractAccounts(data as never))).toEqual(["demo"]);
    expect(() => profile(data, "demo")).toThrow(/must be a list/);
  });

  test("多行 YAML 的引号、注释与嵌套回退", () => {
    const folder = makeTemp();
    const workspace = path.join(folder, "workspace");
    const home = path.join(folder, "home");
    const configDir = path.join(workspace, ".yonge", ".yonge-skills", "human-writing");
    fs.mkdirSync(configDir, { recursive: true });
    fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(
      path.join(configDir, "EXTEND.md"),
      `---
default_profile: demo
demo:
  custom_style:
    name: "日常记录"
    compliance_guardrails:
      - "来源: 不得编造 #1；保留 A|B 的条件。" # 说明
      - "不得声称普通食品可以替代药物。"
---
`,
    );
    const result = runScript("resolve_preferences.ts", ["--workspace-dir", workspace], home);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout).profiles.demo.compliance_guardrails).toEqual([
      "来源: 不得编造 #1；保留 A|B 的条件。",
      "不得声称普通食品可以替代药物。",
    ]);
  });

  test("命令行对格式错误的规则返回 2", () => {
    const folder = makeTemp();
    const workspace = path.join(folder, "workspace");
    const home = path.join(folder, "home");
    const configDir = path.join(workspace, ".yonge", ".yonge-skills", "human-writing");
    fs.mkdirSync(configDir, { recursive: true });
    fs.mkdirSync(home, { recursive: true });
    const write = (yaml: string) =>
      fs.writeFileSync(path.join(configDir, "EXTEND.md"), `---\n${yaml}\n---\n`);

    for (const value of ["null", "~", "auto", "false", "42", '""', ""]) {
      write(`compliance_guardrails: ${value}`);
      const result = runScript("resolve_preferences.ts", ["--workspace-dir", workspace], home);
      expect(result.code).toBe(2);
      expect(result.stderr).toContain("compliance_guardrails");
      expect(result.stdout).toBe("");
    }

    // 多行字符串在解析层就被拒绝，报错带文件与行号而不是字段名
    for (const value of ["|", ">"]) {
      write(`compliance_guardrails: ${value}`);
      const result = runScript("resolve_preferences.ts", ["--workspace-dir", workspace], home);
      expect(result.code).toBe(2);
      expect(result.stderr).toContain("EXTEND.md:2");
      expect(result.stdout).toBe("");
    }

    write(`demo:\n  compliance_guardrails:\n    - rule: "mapping not string"`);
    const result = runScript(
      "resolve_preferences.ts",
      ["--workspace-dir", workspace, "--profile", "demo"],
      home,
    );
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("compliance_guardrails[1]");
  });

  test("多个账号的规则互不泄漏", () => {
    const folder = makeTemp();
    const workspace = path.join(folder, "workspace");
    const home = path.join(folder, "home");
    const configDir = path.join(workspace, ".yonge", ".yonge-skills", "human-writing");
    fs.mkdirSync(configDir, { recursive: true });
    fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(
      path.join(configDir, "EXTEND.md"),
      `---
compliance_guardrails:
  - "公共规则"
a:
  compliance_guardrails:
    - "账号 A 规则"
b:
  compliance_guardrails: []
c:
  platform: wechat
---
`,
    );
    const result = runScript(
      "resolve_preferences.ts",
      ["--workspace-dir", workspace, "--profile", "a|b|c"],
      home,
    );
    expect(result.code).toBe(0);
    const profiles = JSON.parse(result.stdout).profiles;
    expect(profiles.a.compliance_guardrails).toEqual(["账号 A 规则"]);
    expect(profiles.b.compliance_guardrails).toEqual([]);
    expect(profiles.c.compliance_guardrails).toEqual(["公共规则"]);
  });

  test("已有账号不改其它字段", () => {
    const config = parseConfig(`demo:
  platform: wechat
  medium: article
  length: "800-1500"
  output_dir: articles
  custom_style:
    name: "原有风格"
    stance: "平实"
    words_to_avoid: "赋能|助力"
`);
    const result = buildProfileResult(null, "demo", config, SKILL_ROOT);
    expect(result.effective_config).toEqual({
      ...(config.demo as Record<string, unknown>),
      _active_profile: "demo",
    });
    expect(result.style).toEqual((config.demo as Record<string, unknown>).custom_style as never);
    expect(result.compliance_guardrails).toEqual([]);
    expect(result.output_dir).toBe(path.join(SKILL_ROOT, "articles"));
  });

  test("规避词检查不冒充合规审核", () => {
    const folder = makeTemp();
    const extend = path.join(folder, "EXTEND.md");
    fs.writeFileSync(
      extend,
      `---
demo:
  length: auto
  custom_style:
    name: "简洁"
    words_to_avoid: "违禁样例词"
  compliance_guardrails:
    - "不得承诺投资收益。"
---
`,
    );
    const constraints = resolveConstraints(extend, "demo", null);
    // 语义违规但没有逐字命中的规避词：脚本通过不代表合规通过，审核仍需逐条核规则
    const report = buildReport("这项投资保证本金翻倍。", constraints);
    expect(report.pass).toBe(true);
    expect("compliance_guardrails" in report).toBe(false);
    expect(buildReport("违禁样例词", constraints).pass).toBe(false);
  });
});

describe("工作流接线", () => {
  test("流程与独立审核都传入合规清单", () => {
    for (const relative of ["SKILL.md", "agents/reviewer.md"]) {
      const text = readText(relative);
      expect(text).toContain("compliance_guardrails");
      expect(text).toContain("[]");
    }
    expect(readText("SKILL.md")).toContain("agents/reviewer.md");
  });

  test("复审提示词含完整契约", () => {
    const text = readText("agents/reviewer.md");
    const prompt = text.split("```prompt\n")[1]!.split("```")[0]!;
    expect(prompt).toContain("[COMPLIANCE_GUARDRAILS]");
    const defaultReview = readText("references/quality/review.md");
    expect(defaultReview).toContain("## 内容合规红线审查");
    expect(defaultReview).toContain("严禁编造核验依据");
    expect(prompt).toContain("违反和待核实均阻止 PASS");
    expect(prompt).toContain("输入或依赖缺失、脚本执行失败时使用 ERROR");
    expect(text).toContain("不得标记为可发布");
  });

  test("技能说明语义检查与冲突处理", () => {
    const text = readText("references/publish/overview.md");
    expect(text).toContain("length` / 规避词检查不能代替合规审核");
    expect(text).toContain("含短任务、各 `deep` 档位");
    expect(text).toContain("不能因达到迭代上限而放行");
    expect(text).toContain("暂停相关内容并列出待确认项");
  });
});

describe("检查脚本", () => {
  /** 两个检查器：check_prose 只查形状，check_constraints 只查账号配置的边界。 */
  function runOn(script: string, text: string, ...args: string[]): RunResult {
    const folder = makeTemp();
    const draft = path.join(folder, "draft.md");
    fs.writeFileSync(draft, text);
    return runScript(script, [...args, draft]);
  }

  const baseConstraints = (length: string): ResolvedConstraints => ({
    length,
    avoid_words: [],
    style_source: "x",
    effective_config: {},
  });

  test("short 档位与字段表一致", () => {
    expect(LENGTH_PRESETS.short).toEqual([300, 500]);
  });

  test("超上限失败，低于下限只提醒", () => {
    const constraints = baseConstraints("5-8");
    const over = buildReport("一二三四五六七八九十", constraints);
    expect(over.pass).toBe(false);
    expect(over.length.status).toBe("fail");
    expect(over.issues[0]!.name).toBe("篇幅");

    const under = buildReport("一二三", constraints);
    expect(under.pass).toBe(true);
    expect(under.length.status).toBe("under");
    expect(under.issues[0]!.name).toBe("篇幅");
    expect(under.issues[0]!.level).toBe("warn");
    expect(under.failures).toHaveLength(0);
    expect(under.warnings).toHaveLength(1);
  });

  test("篇幅统计所有非空白字符", () => {
    expect(visibleCharCount("ab 中文\n，。")).toBe(6);
  });

  test("参考来源区不计入篇幅", () => {
    const constraints = baseConstraints("5-8");
    const body = "一二三四五六\n";
    const tail = "\n---\n\n参考来源\n\n- 甲乙丙丁戊己庚辛壬癸 https://example.com\n";
    const withTail = buildReport(body + tail, constraints);
    expect(withTail.length.visible_char_count).toBe(9);
    expect(withTail.length.status).toBe("fail");
    expect(withTail.length.source_block_chars as number).toBeGreaterThan(0);
    expect(visibleCharCount(stripSourceBlock(body + tail))).toBe(
      visibleCharCount(body + "---"),
    );
    // 带 # 前缀的标题同样识别
    expect(stripSourceBlock(body + "\n## 参考来源\n- 甲\n")).not.toContain("甲");
    // 没有来源区时统计不变
    const plain = buildReport(body, constraints);
    expect(plain.length.visible_char_count).toBe(6);
    expect(plain.length.source_block_chars).toBe(0);
    // 正文里提到“参考来源”但不是独立标题行时，不截断
    const inline = "参考来源很重要，这句在正文里。";
    expect(stripSourceBlock(inline)).toBe(inline);
  });

  test("形状检查器不读配置，也不接受配置参数", () => {
    const result = runOn("check_prose.ts", "他把表格改了一遍，第二天交给了组长。\n");
    expect(result.code).toBe(0);
    expect(result.stdout).not.toContain("篇幅");
    expect(result.stdout).not.toContain("规避词");
    // 账号配置参数只属于第二层，误传时直接报参数错误
    const wrong = runOn("check_prose.ts", "他把表格改了一遍，第二天交给了组长。\n", "--length", "5");
    expect(wrong.code).toBe(2);
  });

  test("形状检查器按形状门禁", () => {
    const clean = runOn("check_prose.ts", "他把表格改了一遍，第二天交给了组长。\n", "--json");
    expect(clean.code).toBe(0);
    expect(JSON.parse(clean.stdout).pass).toBe(true);

    const noisy = runOn("check_prose.ts", "为什么出发，为什么放弃，为什么留下，他都没说。\n", "--json");
    expect(noisy.code).toBe(1);
    const data = JSON.parse(noisy.stdout);
    expect(data.pass).toBe(false);
    expect(data.issues.map((issue: { name: string }) => issue.name)).toEqual(["排比"]);
    expect(data.issues[0].level).toBe("fail");
    expect(data.issues[0].file).toBe("references/quality/ai-traces.md");
  });

  test("没有账号配置时检查器什么也不报", () => {
    const result = runOn("check_constraints.ts", "他把表格改了一遍，第二天交给了组长。\n");
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("篇幅未设目标");
    expect(result.stdout).toContain("已检查 0 个词");
  });

  test("超上限与命中规避词都算失败", () => {
    const over = runOn("check_constraints.ts", "他把表格改了一遍，第二天交给了组长。\n", "--length", "5");
    expect(over.code).toBe(1);
    expect(over.stdout).toContain("超过目标上限");

    const folder = makeTemp();
    const extend = path.join(folder, "EXTEND.md");
    fs.writeFileSync(extend, "---\navoid_words: [表格]\n---\n");
    const hit = runOn("check_constraints.ts", "他把表格改了一遍。\n", "--extend", extend, "--json");
    const data = JSON.parse(hit.stdout);
    expect(data.pass).toBe(false);
    expect(data.avoid_words.hit_count).toBe(1);
    expect(data.issues[0].name).toBe("规避词");
    expect(data.issues[0].level).toBe("fail");
    expect(data.issues[0].file).toBe("references/quality/review.md");
    expect(data.failures[0]).toContain("[规避词]");
  });
});

describe("flow 已移除", () => {
  test("resolver 不再返回 flow", () => {
    const result = buildProfileResult(
      null,
      "demo",
      { flow: "detail", demo: { flow: "detail" } },
      SKILL_ROOT,
    );
    expect("flow" in result).toBe(false);
  });

  test("字段定义里没有 flow", () => {
    const text = readText("references/publish/config/extend-schema.md");
    expect(text).not.toContain("### flow");
    expect(text).not.toContain("| `flow` |");
  });

  test("技能不用 flow 参数或双流程", () => {
    const text = readText("SKILL.md");
    expect(text).not.toContain("--flow");
    expect(text).not.toContain("## 交互流程 simple 与 detail");
    for (const old of ["`--simple`", "`--detail`", "simple 流程", "detail 流程"]) {
      expect(text).not.toContain(old);
    }
  });

  test("没有文档把 flow 规则指向 overview", () => {
    for (const file of globExt(SKILL_ROOT, ".md")) {
      if (file.split(path.sep).includes("dist")) continue;
      const text = fs.readFileSync(file, "utf8");
      expect(text).not.toContain("overview.md「交互流程");
      expect(text).not.toContain("overview.md`「交互流程");
      expect(text).not.toContain("`--simple`");
      expect(text).not.toContain("`--detail`");
      expect(text).not.toContain("--flow");
    }
  });
});

describe("单一流程", () => {
  test("没配风格时不套用预设", () => {
    const result = buildProfileResult(null, null, {}, SKILL_ROOT);
    expect(result.style_source).toBeNull();
    expect(result.style).toEqual({});
    expect(result.avoid_words).toEqual([]);
    const constraints = resolveConstraints(null, null, null);
    expect(constraints.style_source).toBeNull();
    expect(constraints.avoid_words).toEqual([]);
  });

  test("遗留的 writing_style 直接报错", () => {
    // 内置预设已取消：遗留的 writing_style 必须报错，不能被静默忽略
    expect(() =>
      buildProfileResult(null, null, { writing_style: "warm-narrative" }, SKILL_ROOT),
    ).toThrow(ConfigError);
    expect(() =>
      buildProfileResult(
        null,
        "demo",
        { demo: { writing_style: "warm-narrative", custom_style: { name: "x" } } },
        SKILL_ROOT,
      ),
    ).toThrow(ConfigError);

    const folder = makeTemp();
    const extend = path.join(folder, "EXTEND.md");
    fs.writeFileSync(extend, "---\ndemo:\n  writing_style: lucid-tech\n---\n");
    expect(() => resolveConstraints(extend, "demo", null)).toThrow(ConfigError);
  });

  test("风格目录已删除", () => {
    expect(fs.existsSync(path.join(SKILL_ROOT, "references", "publish", "styles"))).toBe(false);
  });

  test("没有留下路线概念", () => {
    const files = [
      path.join(SKILL_ROOT, "SKILL.md"),
      ...globExt(path.join(SKILL_ROOT, "references"), ".md"),
      ...globExt(path.join(SKILL_ROOT, "agents"), ".md"),
      ...globExt(path.join(SKILL_ROOT, "scripts"), ".ts"),
      ...globExt(path.join(SKILL_ROOT, "tests"), ".ts"),
    ];
    for (const file of files) {
      if (path.basename(file) === path.basename(import.meta.path)) continue;
      const text = fs.readFileSync(file, "utf8");
      expect(text).not.toContain("自媒体路线");
      expect(text).not.toContain("本路线");
    }
  });

  test("唯一流程写在技能文件里", () => {
    const text = readText("SKILL.md");
    expect(text).toContain("### 七步流程");
    expect(text).toContain("references/tasks/rewrite.md");
    expect(text).not.toContain("workflows/");
    expect(fs.existsSync(path.join(SKILL_ROOT, "references", "publish", "workflows"))).toBe(false);
  });
});

describe("引用完整性", () => {
  const PATH_RE = /`((?:references|agents|scripts|tests|dist)\/[A-Za-z0-9_./-]+\.(?:md|ts|yaml))`/g;
  const LINK_RE = /\]\(([^)#:]+\.md)/g;

  test("文档引用的路径都存在", () => {
    for (const file of globExt(SKILL_ROOT, ".md")) {
      const text = fs.readFileSync(file, "utf8");
      for (const target of text.match(PATH_RE) ?? []) {
        expect(fs.existsSync(path.join(SKILL_ROOT, target.slice(1, -1)))).toBe(true);
      }
      for (const link of text.match(LINK_RE) ?? []) {
        const target = link.slice(2);
        expect(fs.existsSync(path.join(path.dirname(file), target))).toBe(true);
      }
    }
  });

  test("resolver 命令只在一处写", () => {
    const hits = globExt(SKILL_ROOT, ".md")
      .filter((file) => fs.readFileSync(file, "utf8").includes("bun scripts/resolve_preferences.ts"))
      .map((file) => path.relative(SKILL_ROOT, file));
    expect(hits).toEqual(["SKILL.md"]);
  });
});

describe("规则名与维度文件对齐", () => {
  function runJson(text: string, ...args: string[]) {
    const folder = makeTemp();
    const draft = path.join(folder, "draft.md");
    fs.writeFileSync(draft, text);
    const result = runScript("check_constraints.ts", [...args, "--json", draft]);
    return JSON.parse(result.stdout);
  }

  test("每条规则在对应维度文件里都有落点", () => {
    for (const [name, relative] of Object.entries({ ...PROSE_RULES, ...CONSTRAINT_RULES })) {
      const text = readText(relative);
      expect(
        text.includes(`### ${name}\n`) || text.includes(`- **${name}**`) || text.includes(name),
      ).toBe(true);
    }
    for (const name of ["排比", "节奏"]) {
      expect(PROSE_RULES[name]).toBe("references/quality/ai-traces.md");
    }
    for (const name of ["篇幅", "规避词"]) {
      expect(CONSTRAINT_RULES[name]).toBe("references/quality/review.md");
    }
  });

  test("维度文件里没有规则代码", () => {
    for (const file of globExt(path.join(SKILL_ROOT, "references", "quality"), ".md")) {
      expect(/\b[ASCFGQM]\d{1,2}\b/.test(fs.readFileSync(file, "utf8"))).toBe(false);
    }
  });

  test("复审提示词列出每个维度文件", () => {
    const text = readText("agents/reviewer.md");
    const prompt = text.split("```prompt\n")[1]!;
    expect(prompt).toContain("[CHECK_DIMENSIONS]");
    for (const file of globExt(path.join(SKILL_ROOT, "references", "quality"), ".md")) {
      const body = fs.readFileSync(file, "utf8");
      expect(text).toContain(`\`references/quality/${path.basename(file)}\``);
      expect(body).toMatch(/^## /m);
    }
  });

  test("问题项带规则名", () => {
    const folder = makeTemp();
    const extend = path.join(folder, "EXTEND.md");
    fs.writeFileSync(extend, "---\navoid_words: [搜索]\n---\n");
    const data = runJson("他说白了就是想赋能。\n我留下来靠的是搜索。\n", "--extend", extend);
    const names = new Set(
      data.issues
        .filter((issue: { level: string }) => issue.level === "fail")
        .map((issue: { name: string }) => issue.name),
    );
    expect(names.has("规避词")).toBe(true);
    for (const issue of data.issues) expect(issue.file.startsWith("references/quality/")).toBe(true);
    for (const item of data.failures) expect(item.startsWith("[")).toBe(true);
    expect(data.failures.length + data.warnings.length).toBe(data.issues.length);
  });

  test("翻案句不算问题", () => {
    expect("翻案句" in PROSE_RULES).toBe(false);
    expect("翻案句" in CONSTRAINT_RULES).toBe(false);
    const data = runJson("真正决定我留下来的不是速度，而是搜索。\n");
    expect(data.pass).toBe(true);
    const names = data.issues.map((issue: { name: string }) => issue.name);
    expect(names).not.toContain("翻案句");
  });
});

describe("示例只写一次", () => {
  const SAMPLES = [
    "天将明，人未归",
    "他从抽屉里翻出一张收据",
    "他关掉一条好走的路",
    "会后悔，而且通常不是买错那一下就后悔",
  ];

  test("示例只出现在一个起草文件里", () => {
    const files = [
      path.join(SKILL_ROOT, "SKILL.md"),
      ...globExt(path.join(SKILL_ROOT, "references", "craft"), ".md"),
      ...globExt(path.join(SKILL_ROOT, "references", "modes"), ".md"),
      ...globExt(path.join(SKILL_ROOT, "references", "genres"), ".md"),
      ...globExt(path.join(SKILL_ROOT, "references", "publish", "platforms"), ".md"),
    ];
    for (const sample of SAMPLES) {
      const hits = files.filter((file) => fs.readFileSync(file, "utf8").includes(sample));
      expect(hits.map((file) => path.basename(file))).toHaveLength(1);
    }
  });

  test("技能按两个问题路由读取", () => {
    const text = readText("SKILL.md");
    expect(text).toContain("不同形式怎样写");
    expect(text).not.toContain("craft/voice.md");
    expect(fs.existsSync(path.join(SKILL_ROOT, "references", "craft", "voice.md"))).toBe(false);
  });
});

describe("形式路由", () => {
  test("每个形式文件都在表里", () => {
    const table = readText("SKILL.md");
    for (const folder of ["genres", "modes"]) {
      for (const file of globExt(path.join(SKILL_ROOT, "references", folder), ".md")) {
        const name = path.basename(file);
        if (name === "README.md" || name === "prose.md") continue;
        expect(table).toContain(`\`references/${folder}/${name}\``);
      }
    }
  });

  test("旧的单文件已删除", () => {
    const craft = path.join(SKILL_ROOT, "references", "craft");
    for (const name of ["format.md", "examples.md", "fiction.md"]) {
      expect(fs.existsSync(path.join(craft, name))).toBe(false);
    }
    expect(fs.existsSync(path.join(SKILL_ROOT, "references", "genres", "README.md"))).toBe(false);
  });

  test("技能接上了写法文件", () => {
    const text = readText("SKILL.md");
    for (const name of [
      "modes/prose.md",
      "craft/structure.md",
      "craft/hooks.md",
      "craft/material.md",
      "craft/title.md",
    ]) {
      expect(text).toContain(`references/${name}`);
    }
  });
});

describe("篇幅档位", () => {
  test("预设、区间与数字写法", () => {
    expect(resolveLengthRange("short")).toEqual([300, 500, "short"]);
    expect(resolveLengthRange("800-1500")).toEqual([800, 1500, "800-1500"]);
    expect(resolveLengthRange("1500~800")).toEqual([800, 1500, "1500~800"]);
    expect(resolveLengthRange("800 到 1500")).toEqual([800, 1500, "800 到 1500"]);
    expect(resolveLengthRange(1000)).toEqual([850, 1150, "1000 +/-15%"]);
    expect(resolveLengthRange("auto")).toBeNull();
    expect(resolveLengthRange(null)).toBeNull();
  });

  test("无法识别的写法报错", () => {
    expect(() => resolveLengthRange("很长")).toThrow(ConfigError);
  });

  test("命令行长度值按标量转换", () => {
    expect(parseScalarArg("800-1500")).toBe("800-1500");
    expect(parseScalarArg("1000")).toBe(1000);
    expect(parseScalarArg('"1200"')).toBe("1200");
  });
});

describe("配置查找", () => {
  function writeConfig(root: string, relative: string, yaml: string): void {
    const file = path.join(root, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `---\n${yaml}\n---\n`);
  }

  test("项目级优先于用户级", () => {
    const folder = makeTemp();
    const workspace = path.join(folder, "workspace");
    const home = path.join(folder, "home");
    writeConfig(workspace, ".yonge/.yonge-skills/human-writing/EXTEND.md", "version: 1\nplatform: project");
    writeConfig(home, ".yonge/.yonge-skills/human-writing/EXTEND.md", "version: 1\nplatform: user");
    const result = runScript("resolve_preferences.ts", ["--workspace-dir", workspace], home);
    expect(result.code).toBe(0);
    const data = JSON.parse(result.stdout);
    expect(data.config_scope).toBe("project");
    expect(data.profiles.__default__.platform).toBe("project");
  });

  test("只有用户级时读用户级", () => {
    const folder = makeTemp();
    const workspace = path.join(folder, "workspace");
    const home = path.join(folder, "home");
    writeConfig(home, ".yonge/.yonge-skills/human-writing/EXTEND.md", "version: 1\nplatform: user");
    const data = JSON.parse(
      runScript("resolve_preferences.ts", ["--workspace-dir", workspace], home).stdout,
    );
    expect(data.config_scope).toBe("user");
    expect(data.profiles.__default__.platform).toBe("user");
  });

  test("旧路径不再被读取", () => {
    const folder = makeTemp();
    const workspace = path.join(folder, "workspace");
    const home = path.join(folder, "home");
    writeConfig(workspace, ".human-writing/EXTEND.md", "version: 1\nplatform: legacy");
    writeConfig(workspace, ".yonge-skills/.human-writing/EXTEND.md", "version: 1\nplatform: legacy");
    const data = JSON.parse(
      runScript("resolve_preferences.ts", ["--workspace-dir", workspace], home).stdout,
    );
    expect(data.config_scope).toBe("default");
    expect(data.config_path).toBeNull();
  });

  test("都没有配置时使用默认值", () => {
    const folder = makeTemp();
    const workspace = path.join(folder, "workspace");
    const home = path.join(folder, "home");
    fs.mkdirSync(workspace, { recursive: true });
    fs.mkdirSync(home, { recursive: true });
    const result = runScript("resolve_preferences.ts", ["--workspace-dir", workspace], home);
    expect(result.code).toBe(0);
    const data = JSON.parse(result.stdout);
    expect(data.config_scope).toBe("default");
    expect(data.profiles.__default__.platform).toBe("auto");
    expect(data.profiles.__default__.compliance_guardrails).toEqual([]);
  });

  test("--list-profiles 只列可用账号", () => {
    const folder = makeTemp();
    const workspace = path.join(folder, "workspace");
    const home = path.join(folder, "home");
    writeConfig(workspace, ".yonge/.yonge-skills/human-writing/EXTEND.md", "version: 1\ndefault_profile: a\na:\n  platform: wechat\nb:\n  platform: zhihu");
    const data = JSON.parse(
      runScript("resolve_preferences.ts", ["--workspace-dir", workspace, "--list-profiles"], home)
        .stdout,
    );
    expect(data.available_profiles).toEqual(["a", "b"]);
    expect("profiles" in data).toBe(false);
  });
});

/** 递归收集某个扩展名的文件，按路径排序，保证断言顺序稳定。 */
function globExt(dir: string, extension: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const files: string[] = [];
  const walk = (current: string) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(extension)) files.push(full);
    }
  };
  walk(dir);
  return files.sort();
}
