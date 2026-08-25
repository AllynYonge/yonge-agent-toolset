#!/usr/bin/env node
/**
 * 离线自测：不连浏览器、不碰抖店，只验纯逻辑。
 *
 * 覆盖：选择器常量表完整性、与 doudian-page.mjs 的哈希一致性、
 *       状态文件读写、resume 过滤、计数口径、jitter 范围、
 *       模板解析（含「未生效配置」提示）。
 *
 * 用法: node selftest.mjs
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { SEL, SKU_CELL, TEXT, candidates, queryExpr } from './selectors.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
let pass = 0;
let fail = 0;

function ok(name, cond, extra = '') {
  if (cond) { pass += 1; console.log(`✓ ${name}`); } else {
    fail += 1;
    console.log(`✗ ${name}${extra ? `\n    ${extra}` : ''}`);
  }
}

function group(t) { console.log(`\n── ${t}`); }

/* ---------- 选择器常量表 ---------- */
group('selectors.mjs');

const HASH_RE = /(style|styles|index-module)[_-][A-Za-z]+__[A-Za-z0-9]{5,}/g;

ok('每条都有 hash / note / stage',
  Object.values(SEL).every((v) => v.hash && v.note && v.stage),
  Object.entries(SEL).filter(([, v]) => !v.hash || !v.note || !v.stage).map(([k]) => k).join(','));

ok('stage 取值合法',
  Object.values(SEL).every((v) => ['step1', 'step2', 'spec', 'sku'].includes(v.stage)));

ok('candidates() 首项即 hash',
  Object.keys(SEL).every((k) => candidates(k)[0] === SEL[k].hash));

ok('candidates() 无空串无重复',
  Object.keys(SEL).every((k) => {
    const c = candidates(k);
    return c.every(Boolean) && new Set(c).size === c.length;
  }));

ok('未知 key 抛错', (() => {
  try { candidates('nope'); return false; } catch { return true; }
})());

ok('queryExpr 产出合法 JS', (() => {
  try {
    // 能被解析即可（不在浏览器里跑）
    new Function(`return ${queryExpr('titleInput')}`); // eslint-disable-line no-new-func
    return true;
  } catch { return false; }
})());

// selectors 与实际交互代码的哈希必须完全一致，否则改了常量表却没生效
const pageSrc = fs.readFileSync(path.join(HERE, 'doudian-page.mjs'), 'utf-8');
const inPage = new Set(pageSrc.match(HASH_RE) ?? []);
const inSel = new Set();
for (const v of Object.values(SEL)) for (const h of v.hash.match(HASH_RE) ?? []) inSel.add(h);

ok('doudian-page 里的哈希都登记在 selectors',
  [...inPage].every((h) => inSel.has(h)),
  `漏登记: ${[...inPage].filter((h) => !inSel.has(h)).join(', ')}`);

ok('selectors 里的哈希都真实存在于 doudian-page',
  [...inSel].every((h) => inPage.has(h)),
  `可能打错: ${[...inSel].filter((h) => !inPage.has(h)).join(', ')}`);

ok('SKU_CELL 四个 placeholder 齐全',
  ['price', 'stock', 'code', 'barcode'].every((k) => typeof SKU_CELL[k] === 'string'));

ok('TEXT 锚点含关键正则',
  TEXT.validationError instanceof RegExp && TEXT.publishOk instanceof RegExp);

/* ---------- 状态文件与计数口径 ---------- */
group('状态文件 / resume / 计数');

const SUCCESS_STATES = new Set(['已发布', '已存草稿', 'dry 通过']);
const SKIP_STATES = new Set(['已跳过（重复）']);

function stateFile(plan) {
  return path.join(path.dirname(path.resolve(plan)),
    `.${path.basename(plan, path.extname(plan))}.state.jsonl`);
}
function appendState(plan, rec) {
  fs.appendFileSync(stateFile(plan),
    `${JSON.stringify({ ...rec, 时间: new Date().toISOString() })}\n`, 'utf-8');
}
function readDone(plan) {
  const done = new Map();
  try {
    for (const line of fs.readFileSync(stateFile(plan), 'utf-8').split('\n')) {
      if (!line.trim()) continue;
      const r = JSON.parse(line);
      if (r.款号) done.set(r.款号, r);
    }
  } catch { /* 首次跑 */ }
  return done;
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'doudian-selftest-'));
const planPath = path.join(tmp, '货盘.xlsx');
fs.writeFileSync(planPath, 'placeholder');

ok('状态文件名带点前缀、与模板同目录',
  stateFile(planPath) === path.join(tmp, '.货盘.state.jsonl'));
ok('无状态文件时读出空 Map', readDone(planPath).size === 0);

appendState(planPath, { 款号: 'A1', 状态: '已存草稿' });
appendState(planPath, { 款号: 'A2', 状态: '失败', 详情: 'boom' });
appendState(planPath, { 款号: 'A3', 状态: '已跳过（重复）' });
appendState(planPath, { 款号: 'A2', 状态: '已存草稿' });   // 重跑成功

const done = readDone(planPath);
ok('同款号取最新记录', done.size === 3 && SUCCESS_STATES.has(done.get('A2').状态));
ok('每行都带时间戳',
  fs.readFileSync(stateFile(planPath), 'utf-8').trim().split('\n')
    .every((l) => JSON.parse(l).时间));

const items = [{ 款号: 'A1' }, { 款号: 'A2' }, { 款号: 'A3' }, { 款号: 'A4' }];
const remain = items.filter((it) => !SUCCESS_STATES.has(done.get(it.款号)?.状态));
ok('resume 跳过 A1/A2，剩 A3/A4', remain.map((r) => r.款号).join(',') === 'A3,A4');

ok('损坏的行不会让读取崩', (() => {
  fs.appendFileSync(stateFile(planPath), 'not-json\n');
  try { return readDone(planPath).size >= 1; } catch { return false; }
})());

const results = [
  { 状态: '已存草稿' }, { 状态: '失败' },
  { 状态: '已跳过（重复）' }, { 状态: '校验失败' }, { 状态: 'dry 通过' },
];
const failed = results.filter((r) => !SUCCESS_STATES.has(r.状态) && !SKIP_STATES.has(r.状态));
const skipped = results.filter((r) => SKIP_STATES.has(r.状态));
ok('失败=2（失败+校验失败）', failed.length === 2);
ok('跳过=1 且不计入失败', skipped.length === 1);
ok('分母排除跳过：成功 2 / 4',
  (results.length - failed.length - skipped.length) === 2 && (results.length - skipped.length) === 4);

const jitter = (b, r = 0.4) => Math.round(b * (1 + (Math.random() * 2 - 1) * r));
const js = Array.from({ length: 500 }, () => jitter(2500));
ok('jitter 落在 ±40% 区间', js.every((v) => v >= 1500 && v <= 3500));
ok('jitter 具备随机性', new Set(js).size > 100);

/* ---------- 模板解析 ---------- */
group('read-plan.py');

let pyOk = true;
try {
  execFileSync('python3', ['-c', 'import openpyxl'], { stdio: 'pipe' });
} catch { pyOk = false; }

if (!pyOk) {
  console.log('· 跳过（缺 python3 + openpyxl）');
} else {
  const xlsx = path.join(tmp, 't.xlsx');
  execFileSync('python3', [path.join(HERE, '..', 'templates', 'make-template.py'), xlsx], { stdio: 'pipe' });
  ok('make-template 生成文件', fs.existsSync(xlsx));

  const out = execFileSync('python3', [path.join(HERE, 'read-plan.py'), xlsx],
    { encoding: 'utf-8', maxBuffer: 32 * 1024 * 1024 });
  const plan = JSON.parse(out);

  ok('输出含 defaults / items / errors / 未生效配置',
    plan.defaults && Array.isArray(plan.items) && Array.isArray(plan.errors)
    && Array.isArray(plan.未生效配置));
  ok('示例行被过滤掉，items 为空', plan.items.length === 0);
  ok('未生效配置正好是那 4 项',
    ['发货模式', '发货时效', '售后政策', '订单库存计数']
      .every((k) => plan.未生效配置.includes(k)) && plan.未生效配置.length === 4,
    `实际: ${plan.未生效配置.join('、')}`);
  ok('品牌/运费模板等已消费项不在未生效列表',
    !plan.未生效配置.includes('品牌') && !plan.未生效配置.includes('运费模板'));
  ok('defaults 读到品牌', plan.defaults.品牌 === '无品牌');
}

fs.rmSync(tmp, { recursive: true, force: true });

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
