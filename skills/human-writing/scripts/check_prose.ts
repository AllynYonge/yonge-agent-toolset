#!/usr/bin/env bun
/**
 * 检查中文成稿的模型化形状：同构排比与节奏。只报警，不自动改文。
 *
 * 每条规则名对应 references/quality/ai-traces.md 里的同名小节，修改时按规则名找修法。
 * 命中一律按 fail 输出并返回退出码 1，供复审子代理当作必须处理的门禁。
 * 本脚本只判断形状，不读任何账号配置；篇幅与规避词由 scripts/check_constraints.ts 检查。
 */
import fs from "node:fs";
import process from "node:process";

const AI_TRACES = "references/quality/ai-traces.md";

/** 规则名对应审查维度文件里的同名小节，修改时按规则名找修法。 */
export const RULE_FILES: Record<string, string> = {
  排比: AI_TRACES,
  节奏: AI_TRACES,
};

// 下面的刻度是脚本判断形状的阈值，改动同时要核对 ai-traces.md 对应小节的说明。
const ANAPHORA_LIMIT = 4; // 排比最多报几处，超出部分同类不重复
const SENTENCE_CV_MIN = 0.42; // 句长变异系数下限，低于它算长短句差距太小
const MIN_SENTENCES = 12; // 句子太少时变异系数不可信
const MIN_PARAGRAPHS = 10; // 段落太少时单句段占比不可信
const ONE_SENTENCE_RATIO = 0.75; // 单句段占比上限，达到它算短段鼓点
const SHORT_PARAGRAPH_HAN = 24; // 短段字数上限
const SHORT_STREAK_MIN = 4; // 连续几个短促单句段算排队喊结论

export interface Paragraph {
  position: number;
  text: string;
  han: number;
  sentences: number;
}

export interface ShapeIssue {
  name: string;
  file: string;
  level: "fail";
  message: string;
}

export function hanCount(text: string): number {
  return (text.match(/[\u4e00-\u9fff]/g) ?? []).length;
}

function lineNumber(text: string, position: number): number {
  return text.slice(0, position).split("\n").length;
}

function excerpt(value: string, width = 72): string {
  const clean = value.replace(/\s+/gu, " ").trim();
  const chars = [...clean];
  return chars.length <= width ? clean : chars.slice(0, width - 1).join("") + "…";
}

/** 屏蔽代码、网址和机器元数据，同时保留字符位置与换行。 */
export function maskNonProse(text: string): string {
  const mask = (match: string): string => match.replace(/[^\n]/g, " ");
  const patterns: RegExp[] = [
    /^---\s*\n[\s\S]*?\n---\s*(?:\n|$)/,
    /```[\s\S]*?```/g,
    /`[^`\n]*`/g,
    /\]\([^\n)]*\)/g,
    /https?:\/\/[^\s)>]+/g,
    /<[^>\n]+>/g,
  ];
  let masked = text;
  for (const pattern of patterns) masked = masked.replace(pattern, mask);
  return masked;
}

interface SentenceMatch {
  index: number;
  text: string;
}

/** 找出同一句里三个以上小句用同一个开头的排比。 */
export function anaphoraRuns(text: string, minimum = 3): SentenceMatch[] {
  const matches: SentenceMatch[] = [];
  for (const sentence of text.matchAll(/[^。！？!?\n]+(?:[。！？!?]|$)/g)) {
    const raw = sentence[0];
    const clauses = raw
      .split(/[，、；,;]/)
      .map((clause) => clause.trim())
      .filter((clause) => hanCount(clause) >= 3);
    if (clauses.length < minimum) continue;
    let run = 1;
    for (let index = 1; index < clauses.length; index += 1) {
      const previous = clauses[index - 1]!;
      const current = clauses[index]!;
      if (previous.slice(0, 2) === current.slice(0, 2) && /^[\u4e00-\u9fff]{2}/.test(current)) {
        run += 1;
        if (run >= minimum) {
          matches.push({ index: sentence.index ?? 0, text: raw });
          break;
        }
      } else {
        run = 1;
      }
    }
  }
  return matches;
}

/** 句长变异系数。人写的长短句差距大，模型的句长彼此接近。 */
export function sentenceLengthCv(text: string): [number, number] | null {
  const lengths = [...text.matchAll(/[^。！？!?\n]+[。！？!?]/g)]
    .map((match) => hanCount(match[0]))
    .filter((value) => value >= 4);
  if (lengths.length < MIN_SENTENCES) return null;
  const mean = lengths.reduce((sum, value) => sum + value, 0) / lengths.length;
  if (mean === 0) return null;
  const variance = lengths.reduce((sum, value) => sum + (value - mean) ** 2, 0) / lengths.length;
  return [Math.sqrt(variance) / mean, lengths.length];
}

export function proseParagraphs(text: string): Paragraph[] {
  const paragraphs: Paragraph[] = [];
  let cursor = 0;
  for (const block of text.split(/\n\s*\n/)) {
    const position = text.indexOf(block, cursor);
    cursor = Math.max(position + block.length, cursor);
    const clean = block.replace(/[>*_`]/g, "").trim();
    if (!clean || /^(#|http|!\[|```)/.test(clean)) continue;
    if (/^(?:[-+*]|\d+[.、])\s/.test(clean)) continue;
    const han = hanCount(clean);
    if (han < 4) continue;
    const sentences = Math.max(1, (clean.match(/[。！？!?]/g) ?? []).length);
    paragraphs.push({ position, text: clean, han, sentences });
  }
  return paragraphs;
}

/** 连续多个短促单句段。 */
export function shortStreak(paragraphs: Paragraph[]): Paragraph[] | null {
  let streak: Paragraph[] = [];
  for (const paragraph of paragraphs) {
    if (paragraph.han <= SHORT_PARAGRAPH_HAN && paragraph.sentences <= 1) {
      streak.push(paragraph);
      if (streak.length >= SHORT_STREAK_MIN) return streak;
    } else {
      streak = [];
    }
  }
  return null;
}

export function readText(filePath: string): string {
  return filePath === "-" ? fs.readFileSync(0, "utf8") : fs.readFileSync(filePath, "utf8");
}

/** 返回排比与节奏的命中项，每项含 name、file、level 和说明失败原因的消息。 */
export function findShapeIssues(text: string): ShapeIssue[] {
  const prose = maskNonProse(text);
  const issues: ShapeIssue[] = [];
  const record = (name: string, message: string): void => {
    issues.push({ name, file: RULE_FILES[name]!, level: "fail", message });
  };

  for (const match of anaphoraRuns(prose).slice(0, ANAPHORA_LIMIT)) {
    record(
      "排比",
      `第 ${lineNumber(text, match.index)} 行三连以上同构排比，“${excerpt(match.text, 44)}”。` +
        "同一个句型连排三次是在抬价，留两项，第三项换说法或删掉。",
    );
  }

  const cv = sentenceLengthCv(prose);
  if (cv && cv[0] < SENTENCE_CV_MIN) {
    record(
      "节奏",
      `全文 ${cv[1]} 个句子长度过于接近（变异系数 ${cv[0].toFixed(2)}，低于 ${SENTENCE_CV_MIN}），` +
        "读起来是齐整的机器节奏。挑一句压到十个字以内，或者放开一句让它长过三十字。",
    );
  }

  const paragraphs = proseParagraphs(prose);
  if (paragraphs.length >= MIN_PARAGRAPHS) {
    const oneSentence = paragraphs.filter((paragraph) => paragraph.sentences <= 1).length;
    const ratio = oneSentence / paragraphs.length;
    if (ratio >= ONE_SENTENCE_RATIO) {
      record(
        "节奏",
        `可识别段落中 ${paragraphs.length} 段里有 ${Math.round(ratio * 100)}% 只有一句话，` +
          "会形成统一的短段鼓点。合并其中能顺着读下去的部分。",
      );
    }
  }

  const streak = shortStreak(paragraphs);
  if (streak) {
    record(
      "节奏",
      `从第 ${lineNumber(text, streak[0]!.position)} 行起连续 ${streak.length} 个短促单句段` +
        `（每段不超过 ${SHORT_PARAGRAPH_HAN} 字），是在排队喊结论。合并其中能顺着读下去的部分。`,
    );
  }

  return issues;
}

function main(): number {
  const argv = process.argv.slice(2);
  let json = false;
  let filePath: string | null = null;
  for (const arg of argv) {
    if (arg === "--json") json = true;
    else if (arg === "-h" || arg === "--help") {
      console.log("用法: bun check_prose.ts <稿件路径|-> [--json]");
      return 0;
    } else if (filePath === null) filePath = arg;
    else {
      console.error(`无法识别的参数：${arg}`);
      return 2;
    }
  }
  if (filePath === null) {
    console.error("缺少稿件路径。用法: bun check_prose.ts <稿件路径|-> [--json]");
    return 2;
  }

  let text: string;
  try {
    text = readText(filePath);
  } catch (error) {
    console.error(`无法读取稿件。${error instanceof Error ? error.message : String(error)}`);
    return 2;
  }

  const totalHan = hanCount(maskNonProse(text));
  if (totalHan === 0) {
    console.error("没有检测到汉字。");
    return 2;
  }

  const issues = findShapeIssues(text);
  const failures = issues.map((issue) => `[${issue.name}] ${issue.message}`);

  if (json) {
    console.log(
      JSON.stringify(
        { pass: issues.length === 0, han_count: totalHan, failures, warnings: [], issues },
        null,
        2,
      ),
    );
    return issues.length ? 1 : 0;
  }

  console.log(`汉字数 ${totalHan}`);
  console.log(
    `同构排比 ${issues.filter((issue) => issue.name === "排比").length} 处，` +
      `节奏 ${issues.filter((issue) => issue.name === "节奏").length} 处。` +
      `每项开头是规则名，修法见 ${AI_TRACES} 的同名小节`,
  );

  if (!issues.length) {
    console.log("\n未发现这份检查器覆盖的问题。");
    return 0;
  }

  console.log("\n需要修改");
  for (const item of failures) console.log(`- ${item}`);

  return 1;
}

if (import.meta.main) process.exit(main());
