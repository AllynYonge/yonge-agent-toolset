#!/usr/bin/env bun
/**
 * 按账号配置检查成稿的篇幅与规避词。只报警，不自动改文。
 *
 * 每条规则名对应 references/quality/review.md 里的同名小节，修改时按规则名找修法。
 * 篇幅超过目标上限、命中规避词都按 fail 输出并返回退出码 1；篇幅低于下限只按 warn
 * 提醒，因为材料撑不住时宁可短稿，不为凑字数注水。
 * 配置解析由 lib/preferences.ts 负责，本脚本不重复实现。
 * 模型化句式痕迹由 scripts/check_prose.ts 检查。
 */
import fs from "node:fs";
import process from "node:process";

import {
  resolveConstraints,
  resolveLengthRange,
  type ResolvedConstraints,
} from "./lib/preferences";

const REVIEW = "references/quality/review.md";

/** 规则名对应审查维度文件里的同名小节，修改时按规则名找修法。 */
export const RULE_FILES: Record<string, string> = {
  篇幅: REVIEW,
  规避词: REVIEW,
};

// 文末“参考来源”区不是正文，不计入篇幅。标题行可带 # 前缀，也可以是纯文字行。
const SOURCE_BLOCK = /^[ \t]*(?:#{1,6}[ \t]*)?参考来源[ \t]*$/m;

export interface Issue {
  name: string;
  file: string;
  level: "fail" | "warn";
  message: string;
  word?: string;
  paragraph?: number;
  excerpt?: string;
}

export interface AvoidWordHit {
  word: string;
  paragraph: number;
  offset: number;
  excerpt: string;
}

export function readText(filePath: string): string {
  return filePath === "-" ? fs.readFileSync(0, "utf8") : fs.readFileSync(filePath, "utf8");
}

export function visibleCharCount(text: string): number {
  return [...text.replace(/\s+/gu, "")].length;
}

export function stripSourceBlock(text: string): string {
  const match = SOURCE_BLOCK.exec(text);
  return match ? text.slice(0, match.index) : text;
}

function paragraphNumber(text: string, offset: number): number {
  const paragraphs = text
    .slice(0, offset)
    .split(/\n\s*\n/)
    .filter((paragraph) => paragraph.trim());
  return Math.max(1, paragraphs.length);
}

function excerptAt(text: string, start: number, end: number, radius = 18): string {
  const left = Math.max(0, start - radius);
  const right = Math.min(text.length, end + radius);
  return text.slice(left, right).replace(/\s+/gu, " ").trim();
}

export function findAvoidWordHits(text: string, words: string[]): AvoidWordHit[] {
  const hits: AvoidWordHit[] = [];
  for (const word of words) {
    let start = 0;
    while (true) {
      const index = text.indexOf(word, start);
      if (index === -1) break;
      const end = index + word.length;
      hits.push({
        word,
        paragraph: paragraphNumber(text, index),
        offset: index,
        excerpt: excerptAt(text, index, end),
      });
      start = end;
    }
  }
  return hits.sort((a, b) => a.offset - b.offset || (a.word < b.word ? -1 : a.word > b.word ? 1 : 0));
}

function makeIssue(
  name: string,
  level: "fail" | "warn",
  message: string,
  extra: Record<string, string | number> = {},
): Issue {
  return { name, file: RULE_FILES[name]!, level, message, ...extra };
}

export interface ConstraintReport {
  pass: boolean;
  issues: Issue[];
  failures: string[];
  warnings: string[];
  length: Record<string, unknown>;
  avoid_words: Record<string, unknown>;
  style_source: string | null;
  active_profile: string | null;
}

export function buildReport(article: string, constraints: ResolvedConstraints): ConstraintReport {
  const lengthRange = resolveLengthRange(constraints.length);
  const body = stripSourceBlock(article);
  const charCount = visibleCharCount(body);
  const sourceBlockChars = visibleCharCount(article) - charCount;
  const failures: Issue[] = [];
  const warnings: Issue[] = [];

  const lengthResult: Record<string, unknown> = {
    configured_length: constraints.length,
    visible_char_count: charCount,
    source_block_chars: sourceBlockChars,
    status: lengthRange === null ? "skipped" : "pass",
  };
  if (lengthRange !== null) {
    const [lower, upper, label] = lengthRange;
    lengthResult.target = label;
    lengthResult.min = lower;
    lengthResult.max = upper;
    if (charCount > upper) {
      lengthResult.status = "fail";
      failures.push(
        makeIssue("篇幅", "fail", `字数 ${charCount} 超过目标上限 ${upper}（目标 ${lower}-${upper}）`),
      );
    } else if (charCount < lower) {
      // 低于下限只提醒：材料撑不住时宁可短，不为凑字数注水
      lengthResult.status = "under";
      warnings.push(
        makeIssue(
          "篇幅",
          "warn",
          `字数 ${charCount} 低于目标下限 ${lower}（目标 ${lower}-${upper}）。材料不够时保持短稿，交稿时说明实际字数`,
        ),
      );
    }
  }

  const hits = findAvoidWordHits(article, constraints.avoid_words);
  const avoidResult = {
    checked_words: constraints.avoid_words,
    hit_count: hits.length,
    hits,
    status: hits.length ? "fail" : "pass",
  };
  for (const hit of hits) {
    failures.push(
      makeIssue("规避词", "fail", `规避词“${hit.word}”，第 ${hit.paragraph} 段，“${hit.excerpt}”`, {
        word: hit.word,
        paragraph: hit.paragraph,
        excerpt: hit.excerpt,
      }),
    );
  }

  const activeProfile = constraints.effective_config._active_profile;

  return {
    pass: failures.length === 0,
    issues: [...failures, ...warnings],
    failures: failures.map((issue) => `[${issue.name}] ${issue.message}`),
    warnings: warnings.map((issue) => `[${issue.name}] ${issue.message}`),
    length: lengthResult,
    avoid_words: avoidResult,
    style_source: constraints.style_source,
    active_profile: activeProfile ? String(activeProfile) : null,
  };
}

interface Args {
  path: string | null;
  extend: string | null;
  profile: string | null;
  length: string | null;
  json: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { path: null, extend: null, profile: null, length: null, json: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--extend") args.extend = argv[++index] ?? null;
    else if (arg === "--profile") args.profile = argv[++index] ?? null;
    else if (arg === "--length") args.length = argv[++index] ?? null;
    else if (arg === "--json") args.json = true;
    else if (arg === "-h" || arg === "--help") {
      console.log(`用法: bun check_constraints.ts <稿件路径|-> [--extend <EXTEND.md>] [--profile <账号>] [--length <目标>] [--json]`);
      process.exit(0);
    } else if (args.path === null) args.path = arg;
    else {
      console.error(`无法识别的参数：${arg}`);
      process.exit(2);
    }
  }
  return args;
}

function main(): number {
  const args = parseArgs(process.argv.slice(2));
  if (!args.path) {
    console.error("缺少稿件路径。用法: bun check_constraints.ts <稿件路径|-> [选项]");
    return 2;
  }

  let text: string;
  try {
    text = readText(args.path);
  } catch (error) {
    console.error(`无法读取稿件。${error instanceof Error ? error.message : String(error)}`);
    return 2;
  }

  let constraints: ResolvedConstraints;
  try {
    constraints = resolveConstraints(args.extend, args.profile, args.length);
  } catch (error) {
    console.error(`配置解析失败。${error instanceof Error ? error.message : String(error)}`);
    return 2;
  }

  const report = buildReport(text, constraints);

  if (args.json) {
    console.log(JSON.stringify(report, null, 2));
    return report.failures.length ? 1 : 0;
  }

  const length = report.length as Record<string, string | number>;
  if (length.status === "skipped") {
    console.log("篇幅未设目标，跳过");
  } else {
    console.log(
      `篇幅 ${length.visible_char_count} 字（非空白字符，不含参考来源区 ${length.source_block_chars} 字），目标 ${length.min}-${length.max}`,
    );
  }

  const avoid = report.avoid_words as { hit_count: number; checked_words: string[] };
  console.log(`规避词 命中 ${avoid.hit_count} 处，已检查 ${avoid.checked_words.length} 个词`);

  if (report.failures.length || report.warnings.length) {
    console.log(`每项开头是规则名，修法见 ${REVIEW} 的同名小节。`);
  }

  if (report.failures.length) {
    console.log("\n需要修改");
    for (const item of report.failures) console.log(`- ${item}`);
  }

  if (report.warnings.length) {
    console.log("\n需要人工判断");
    for (const item of report.warnings) console.log(`- ${item}`);
  }

  if (!report.failures.length && !report.warnings.length) {
    console.log("\n未发现这份检查器覆盖的问题。");
  }

  return report.failures.length ? 1 : 0;
}

if (import.meta.main) process.exit(main());
