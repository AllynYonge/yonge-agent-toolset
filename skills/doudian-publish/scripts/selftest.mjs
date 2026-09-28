#!/usr/bin/env node
/**
 * 离线自测：不连浏览器、不碰抖店，只验纯逻辑。
 *
 * 覆盖：选择器常量表完整性、与 doudian-page.mjs 的哈希一致性、
 *       AI 标题按钮/推荐项的定位逻辑（在假 DOM 上真跑）、
 *       状态文件读写、resume 过滤、计数口径、jitter 范围、
 *       模板解析（含「未生效配置」提示）、登录态 URL 分类、
 *       工作台标签页复用（只认首页、接管页不关）。
 *
 * 用法: node selftest.mjs
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { SEL, SKU_CELL, TEXT, candidates, queryExpr } from './selectors.mjs';
import {
  aiTitleButtonExpr, firstAiOptionExpr, sizeOptionsExpr,
  styleSelectExpr, styleOptionExpr, shortTitleAiExpr, radioGroupExpr,
} from './doudian-page.mjs';
import {
  WS_CACHE as cdpWsCache, DEDICATED_PROFILE as cdpProfile,
  classifyDoudianUrl, DOUDIAN_HOME, DOUDIAN_LOGIN,
  isDoudianHomepageUrl, findHomepageTab, jitter,
} from './cdp.mjs';

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

const NEEDS_VALUES = ['image', 'ai-live', 'style-live', 'category', 'step2', 'manual', 'sku'];

ok('needs 取值合法',
  Object.values(SEL).every((v) => v.needs === undefined || NEEDS_VALUES.includes(v.needs)),
  Object.entries(SEL).filter(([, v]) => v.needs !== undefined && !NEEDS_VALUES.includes(v.needs))
    .map(([k]) => k).join(','));

// soft 项在 doctor 里不计入失效，因为 doudian-page 对它们另有几何兜底路径。
// 这两项必须保持 soft，否则抖店改一次类名体检就会报假错。
ok('AI 相关选择器标为 soft（有几何兜底）',
  SEL.aiTitleButton?.soft === true && SEL.aiTitleOption?.soft === true);

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

ok('SKU_CELL 三个 placeholder 齐全',
  ['price', 'stock', 'code'].every((k) => typeof SKU_CELL[k] === 'string'));

ok('TEXT 锚点含关键正则',
  TEXT.validationError instanceof RegExp && TEXT.publishOk instanceof RegExp);

/* ---------- 状态文件与计数口径 ---------- */
group('状态文件 / resume / 计数');

const SUCCESS_STATES = new Set(['已发布', '已存草稿']);

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
appendState(planPath, { 款号: 'A3', 状态: '校验失败' });
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
  { 状态: '校验失败' },
];
const failed = results.filter((r) => !SUCCESS_STATES.has(r.状态));
ok('失败=2（失败+校验失败）', failed.length === 2);
ok('成功 1 / 3', (results.length - failed.length) === 1 && results.length === 3);

// 旧版这里有两条 jitter 测试，但它测的是本文件里现场定义的局部函数，
// 跟 cdp.mjs 里真正在用的实现毫无关系 —— 改坏实现也不会报错。
// 已改为直接测导入的 jitter，见下面「拟人化节奏与条件等待」一组。

/* ---------- 登录态 URL 分类 ---------- */
group('登录态判定');

// 这是「打开浏览器后自动检验登录」的判据核心：分错一次就会误判、白等或直接冲进去报超时。
ok('登录页 → login', [
  DOUDIAN_LOGIN,
  'https://fxg.jinritemai.com/login/common?redirect=%2Fffa%2Fg%2Fcreate',
  'https://fxg.jinritemai.com/account/login',
  'https://sso.jinritemai.com/authorize?xxx',
  'https://fxg.jinritemai.com/passport/web/login/',
].every((u) => classifyDoudianUrl(u) === 'login'),
  [DOUDIAN_LOGIN, 'https://fxg.jinritemai.com/account/login']
    .map((u) => `${u} → ${classifyDoudianUrl(u)}`).join(' | '));

ok('后台业务页 → app', [
  'https://fxg.jinritemai.com/ffa/g/create',
  'https://fxg.jinritemai.com/ffa/mshop/homepage/index',
  'https://fxg.jinritemai.com/ffa/g/list?status=1',
].every((u) => classifyDoudianUrl(u) === 'app'));

// 根路径是对外招商官网，登录与否都能打开，且页面写着「登录抖店」——不可作判据。
ok('根路径 → marketing（对外官网，不可作判据）', [
  'https://fxg.jinritemai.com/',
  'https://fxg.jinritemai.com',
  'https://fxg.jinritemai.com/?from=x',
].every((u) => classifyDoudianUrl(u) === 'marketing'));

// 探针必须打需要鉴权的后台路径，否则永远判不出已登录（踩过的坑）。
ok('DOUDIAN_HOME 是需鉴权的后台路径', classifyDoudianUrl(DOUDIAN_HOME) === 'app',
  `${DOUDIAN_HOME} → ${classifyDoudianUrl(DOUDIAN_HOME)}`);
ok('DOUDIAN_LOGIN 被判为 login', classifyDoudianUrl(DOUDIAN_LOGIN) === 'login');

ok('非抖店 → other', [
  'about:blank', '', 'https://www.baidu.com/', 'chrome-extension://abc/popup.html',
].every((u) => classifyDoudianUrl(u) === 'other'));

// 「create」这种路径里带 e-a-t-e 不该被误判成 login；反过来
// 后台路径里出现 login 关键字才算未登录。
ok('不把普通后台路径误判成 login',
  classifyDoudianUrl('https://fxg.jinritemai.com/ffa/g/create') !== 'login');

/* ---------- AI 标题 / 自动类目的定位逻辑 ---------- */
group('AI 标题定位（假 DOM）');

/**
 * 极小 DOM shim：只实现 aiTitleButtonExpr / firstAiOptionExpr 用到的那几个 API，
 * 但几何（getBoundingClientRect）和父子关系是真的 —— 这两段代码靠「容器内查找 +
 * 坐标判定」定位，光读代码看不出对不对，必须能测。
 * 不引 jsdom：本技能不带 node_modules，不为测试加依赖。
 *
 * 节点写法：{ id, tag, cls, text, x, y, w, h, kids: [...] }
 *   attrs   —— 额外属性（如 { type: 'checkbox' }）
 *   checked —— checkbox 初始勾选态
 * 被派发到节点上的事件名会记在 el._events，供断言「真的发了那四个鼠标事件」。
 *
 * 除几何与父子关系外，还实现了 closest / matches / nextElementSibling /
 * createTreeWalker：「风格」「导购短标题」「radio 组」这三处定位都靠它们
 * （标签与控件是兄弟关系，从文案节点上溯），不实现就没法离线验。
 */
function fakeDom(tree) {
  const all = [];
  const build = (n, parent = null) => {
    const attrs = { class: n.cls ?? '', ...(n.attrs ?? {}) };
    const el = {
      tagName: (n.tag ?? 'div').toUpperCase(),
      innerText: n.text ?? '',
      value: n.value,
      placeholder: n.placeholder ?? '',
      checked: n.checked ?? false,
      disabled: n.disabled ?? false,
      children: [],
      parentElement: parent,
      nextElementSibling: null,
      offsetParent: n.hidden ? null : { tagName: 'BODY' },
      getBoundingClientRect: () => ({
        x: n.x, y: n.y, left: n.x, top: n.y,
        width: n.w, height: n.h, right: n.x + n.w, bottom: n.y + n.h,
      }),
      setAttribute: (k, v) => { attrs[k] = v; },
      removeAttribute: (k) => { delete attrs[k]; },
      getAttribute: (k) => attrs[k] ?? null,
      scrollIntoView: () => {},
      focus: () => {},
      _events: [],
      dispatchEvent(e) { this._events.push(e?.type ?? String(e)); return true; },
      _attrs: attrs,
      _id: n.id,
    };
    el.click = () => { el._events.push('click'); };
    // 代码里大量 /xxx/.test(el.className)，必须能读到
    Object.defineProperty(el, 'className', { get: () => attrs.class ?? '' });
    el.matches = (sel) => sel.split(',').map((x) => x.trim()).filter(Boolean)
      .some((one) => matchOne(el, one));
    el.closest = (sel) => {
      let e = el;
      while (e) { if (e.matches(sel)) return e; e = e.parentElement; }
      return null;
    };
    all.push(el);
    for (const k of n.kids ?? []) {
      const c = build(k, el);
      el.children.push(c);
    }
    // 兄弟指针：标签容器与控件容器是兄弟，nextElementSibling 是定位主路径
    el.children.forEach((c, i) => { c.nextElementSibling = el.children[i + 1] ?? null; });
    // 容器内查询要能看到全部后代
    el._desc = [];
    for (const c of el.children) el._desc.push(c, ...(c._desc ?? []));
    el.querySelectorAll = (sel) => sel.split(',').map((x) => x.trim()).filter(Boolean)
      .flatMap((one) => {
        const parts = one.split(/\s+/);
        if (parts.length === 1) return el._desc.filter((d) => matchOne(d, parts[0]));
        const anc = el._desc.filter((d) => matchOne(d, parts[0]));
        return anc.flatMap((a) => a._desc.filter((d) => matchOne(d, parts[parts.length - 1])));
      })
      .filter((v, i, a) => a.indexOf(v) === i);
    el.querySelector = (sel) => el.querySelectorAll(sel)[0] ?? null;
    return el;
  };

  // 只支持测试里用到的形式：tag、tag.class、.class、[attr=v]、[attr*=v]
  function matchOne(el, part) {
    const m = part.match(/^\[([a-z-]+)([*^$]?)=?"?([^\]"]*)"?\]$/);
    if (m) {
      const [, name, op, want] = m;
      const v = el._attrs[name];
      if (v === undefined) return false;
      if (!want) return true;
      return op === '*' ? v.includes(want) : v === want;
    }
    if (part.includes('[')) {
      const i = part.indexOf('[');
      return matchOne(el, part.slice(0, i) || '*') && matchOne(el, part.slice(i));
    }
    if (part.includes('.')) {
      const [tag, ...cls] = part.split('.');
      if (tag && el.tagName !== tag.toUpperCase()) return false;
      const have = (el._attrs.class ?? '').split(/\s+/);
      return cls.every((c) => have.includes(c));
    }
    if (part === '*') return true;
    return el.tagName === part.toUpperCase();
  }

  for (const n of tree) build(n);

  const querySelectorAll = (sel) => sel.split(',').map((x) => x.trim()).filter(Boolean)
    // 后代组合选择器：取右侧部分再校验祖先，测试用例里够用
    .flatMap((one) => {
      const parts = one.split(/\s+/);
      if (parts.length === 1) return all.filter((el) => matchOne(el, parts[0]));
      const anc = all.filter((el) => matchOne(el, parts[0]));
      return anc.flatMap((a) => a._desc.filter((d) => matchOne(d, parts[parts.length - 1])));
    })
    .filter((v, i, a) => a.indexOf(v) === i);

  return {
    querySelector: (s) => querySelectorAll(s)[0] ?? null,
    querySelectorAll,
    _byId: (id) => all.find((e) => e._id === id),
    // radioGroupExpr 靠 TreeWalker 从文本节点找标签。假 DOM 里没有真的文本节点，
    // 用「叶子元素的 innerText」充当：给每个无子元素且有文案的节点造一个
    // { nodeValue, parentElement } 的文本节点替身，语义与真 DOM 一致。
    createTreeWalker: () => {
      const nodes = all.filter((e) => e.children.length === 0 && (e.innerText ?? '').trim())
        .map((e) => ({ nodeValue: e.innerText, parentElement: e }));
      let i = 0;
      return { nextNode: () => (i < nodes.length ? nodes[i++] : null) };
    },
    body: { click: () => {}, innerText: '' },
  };
}

/** 假 DOM 上的 NodeFilter 常量（createTreeWalker 完全忽略它，只为不报 undefined） */
const NodeFilterStub = { SHOW_TEXT: 4 };

/** 在假 DOM 上跑一段页内 JS（与 page.eval 的包裹方式一致：IIFE） */
function runExpr(expr, document) {
  // MouseEvent / KeyboardEvent 在 Node 里不存在，给只带 type 的最小替身：
  // 被测代码只关心“派发了哪几个事件”，fakeDom 的 dispatchEvent 也只记 type。
  const EventStub = class { constructor(type, init) { this.type = type; Object.assign(this, init ?? {}); } };
  // eslint-disable-next-line no-new-func
  return new Function('document', 'MouseEvent', 'KeyboardEvent', 'NodeFilter', 'window',
    `return (() => { ${expr} })()`)(document, EventStub, EventStub, NodeFilterStub, {});
}

/**
 * 真实页面结构还原（坐标取自实测 dump）：
 *   span.ecom-g-input-affix-wrapper.ecom-g-dropdown-trigger  [252,349,706,32]
 *     input.ecom-g-input                                     [264,355,630,20]
 *     span.ecom-g-input-suffix                               [898,355,52,20]
 *       span 「0/60」                                         [898,357,28,16]
 *       img  AI 图标（无 class）                               [930,355,20,20]
 */
const titleRowTree = (extra = []) => [
  {
    id: 'wrap',
    tag: 'span',
    cls: 'ecom-g-input-affix-wrapper ecom-g-dropdown-trigger',
    x: 252,
    y: 349,
    w: 706,
    h: 32,
    kids: [
      { id: 'input', tag: 'input', cls: 'ecom-g-input', value: '', x: 264, y: 355, w: 630, h: 20 },
      {
        id: 'suffix',
        tag: 'span',
        cls: 'ecom-g-input-suffix',
        x: 898,
        y: 355,
        w: 52,
        h: 20,
        kids: [
          { id: 'counter', tag: 'span', text: '0/60', x: 898, y: 357, w: 28, h: 16 },
          { id: 'ai', tag: 'img', x: 930, y: 355, w: 20, h: 20 },
        ],
      },
    ],
  },
  ...extra,
];

// 页面上另有一行「标题推荐：…… 立即使用」，不点 AI 也存在。它不是 AI 弹层，
// 不能被当成推荐项 —— 这是实测发现的真实干扰源。
const PREDICT_ROW = {
  id: 'predict',
  tag: 'div',
  cls: 'style_predictContentWrapper__UdtJQ',
  text: '标题推荐：|时尚套装女气质通勤法式高级感显瘦百搭无袖上衣半身裙| |立即使用',
  x: 252,
  y: 385,
  w: 706,
  h: 36,
  kids: [
    { id: 'predictTitle', tag: 'span', text: '时尚套装女气质通勤法式高级感显瘦百搭无袖上衣半身裙', x: 340, y: 394, w: 300, h: 17 },
    { id: 'useNow', tag: 'a', text: '立即使用', x: 644, y: 395, w: 48, h: 16 },
  ],
};

// 场景 1：正常结构 → 命中 suffix 里那个 img
{
  const doc = fakeDom(titleRowTree([PREDICT_ROW]));
  const via = runExpr(aiTitleButtonExpr(), doc);
  ok('AI 按钮命中 input-suffix 内的 img（via=suffix）', via === 'suffix', `得到 ${via}`);
  ok('命中项被打上 data-dp=ai-title',
    doc._byId('ai')._attrs['data-dp'] === 'ai-title');
  ok('不会误选字数计数器 0/60',
    doc._byId('counter')._attrs['data-dp'] === undefined);
}

// 场景 2：suffix 类名被改掉（抖店发版）→ 几何兜底仍能找到
{
  const tree = titleRowTree();
  tree[0].kids[1].cls = 'style_zz9__Kq1';
  const doc = fakeDom(tree);
  const via = runExpr(aiTitleButtonExpr(), doc);
  ok('suffix 类名失效 → 几何兜底（via=geometry）', via === 'geometry', `得到 ${via}`);
  ok('几何兜底仍选中 AI 图标', doc._byId('ai')._attrs['data-dp'] === 'ai-title');
}

// 场景 3：标题行以外的图标不能被误点（如页面底部 AI 素材工具入口）
{
  const doc = fakeDom(titleRowTree([
    { id: 'far', tag: 'img', x: 930, y: 900, w: 20, h: 20 },
  ]).map((n) => (n.id === 'wrap' ? { ...n, kids: n.kids.filter((k) => k.id !== 'suffix') } : n)));
  ok('标题行以外的图标不被误点',
    runExpr(aiTitleButtonExpr(), doc) === null
    && doc._byId('far')._attrs['data-dp'] === undefined);
}

/** AI 弹层：ul.ecom-g-dropdown-menu > li.ecom-g-dropdown-menu-item ×2 + 「重新生成」按钮 */
const T1 = '时尚套装女气质通勤法式高级感显瘦百搭夏季';
const T2 = '2025夏季新款女法式高级感圆领不规则无袖上衣高腰显瘦包臀半身裙';
/** @param items 菜单项节点；@param y 弹层顶部 y（外层 div 与内层 ul 保持一致） */
const dropdownTree = (items, y = 384) => ({
  id: 'dd',
  tag: 'div',
  cls: 'ecom-g-dropdown ecom-g-dropdown-placement-bottomLeft',
  x: 252,
  y,
  w: 706,
  h: 164,
  kids: [{
    id: 'menu',
    tag: 'ul',
    cls: 'ecom-g-dropdown-menu ecom-g-dropdown-menu-root',
    x: 252,
    y,
    w: 706,
    h: 164,
    kids: [
      ...items,
      {
        id: 'regen', tag: 'button', cls: 'ecom-g-dropdown-menu-item', text: '重新生成', x: 265, y: y + 91, w: 103, h: 28,
      },
    ],
  }],
});

// 场景 4：弹层未出现 → null（上层靠这个回退到老流程）
ok('AI 弹层未出现 → null',
  runExpr(firstAiOptionExpr(), fakeDom(titleRowTree([PREDICT_ROW]))) === null);

// 场景 5：弹层出现 → 取位置最上那条（DOM 顺序故意反着放）
{
  const doc = fakeDom(titleRowTree([PREDICT_ROW, dropdownTree([
    { id: 'opt2', tag: 'li', cls: 'ecom-g-dropdown-menu-item', text: T2, x: 253, y: 431, w: 704, h: 32 },
    { id: 'opt1', tag: 'li', cls: 'ecom-g-dropdown-menu-item', text: T1, x: 253, y: 399, w: 704, h: 32 },
  ])]));
  const got = runExpr(firstAiOptionExpr(), doc);
  ok('取到位置最上面那条推荐（不是 DOM 顺序）', got === T1, `得到 ${got}`);
  ok('第一条被打上 data-dp=ai-option',
    doc._byId('opt1')._attrs['data-dp'] === 'ai-option'
    && doc._byId('opt2')._attrs['data-dp'] === undefined);
  ok('「重新生成」按钮不会被当成推荐项',
    doc._byId('regen')._attrs['data-dp'] === undefined);
  ok('页面自带的「标题推荐：…立即使用」行不会被当成推荐项',
    doc._byId('predict')._attrs['data-dp'] === undefined
    && doc._byId('predictTitle')._attrs['data-dp'] === undefined);
}

// 场景 6：只有「标题推荐」干扰行、没有 AI 弹层时必须返回 null，
// 否则会去点一个需要「立即使用」才生效的行，静默什么也不发生。
ok('只有干扰行、无 AI 弹层 → null',
  runExpr(firstAiOptionExpr(), fakeDom(titleRowTree([PREDICT_ROW]))) === null);

// 场景 7：标题框上方的下拉（如其他控件的弹层）不能被当成 AI 弹层
ok('标题框上方的 dropdown 不被当成 AI 弹层',
  runExpr(firstAiOptionExpr(), fakeDom(titleRowTree([
    dropdownTree([
      { id: 'x1', tag: 'li', cls: 'ecom-g-dropdown-menu-item', text: T1, x: 253, y: 115, w: 704, h: 32 },
    ], 100),
  ]))) === null);

// publish.mjs 的行为契约：AI 优先、失败回退、类目不一致只警告
const pubSrcAi = fs.readFileSync(path.join(HERE, 'publish.mjs'), 'utf-8');
ok('publish.mjs 调用 aiTitleAndCategory', pubSrcAi.includes('dp.aiTitleAndCategory(page)'));
ok('AI 不可用时回退 fillTitle + selectCategory',
  /AI 推荐不可用[\s\S]{0,200}dp\.fillTitle\(page, title\)[\s\S]{0,300}dp\.selectCategory\(page, item\.类目\)/
    .test(pubSrcAi));
ok('类目不一致只警告不覆写',
  /自动类目与模板不一致/.test(pubSrcAi)
  && !/ai\.category[\s\S]{0,120}selectCategory/.test(pubSrcAi));

/* ---------- 拟人化节奏与条件等待 ---------- */
group('拟人化节奏与条件等待');

{
  // 注意：本文件开头没设 DOUDIAN_NO_JITTER，所以这里测的是真实抖动行为。
  const N = 3000;
  const vals = Array.from({ length: N }, () => jitter(1000));
  const min = Math.min(...vals);
  const max = Math.max(...vals);
  const avg = vals.reduce((a, b) => a + b, 0) / N;
  const uniq = new Set(vals).size;

  ok('jitter 不会把等待削得过短（≥ 0.8倍）', min >= 800, `min=${min}`);
  ok('jitter 有上限，不会无限拉长（< 1.8倍）', max < 1800, `max=${max}`);
  ok('jitter 期望值略大于原值（1.1~1.5倍）', avg > 1100 && avg < 1500, `avg=${Math.round(avg)}`);
  ok('jitter 真的随机（方差不为零，这是避免固定指纹的关键）',
    uniq > N / 10, `${N} 次取样得到 ${uniq} 个不同值`);

  // 可重现开关：子进程里开 DOUDIAN_NO_JITTER 验证变回固定值
  const out = execFileSync(process.execPath, ['-e', `
    import('${path.join(HERE, 'cdp.mjs')}').then(m => {
      const v = new Set(Array.from({length: 50}, () => m.jitter(1000)));
      console.log(JSON.stringify([...v]));
    });
  `], { env: { ...process.env, DOUDIAN_NO_JITTER: '1' }, encoding: 'utf-8' });
  ok('DOUDIAN_NO_JITTER=1 关掉抖动（保证测试可重现）',
    JSON.parse(out).length === 1 && JSON.parse(out)[0] === 1000, out.trim());
}

{
  const cdpSrc = fs.readFileSync(path.join(HERE, 'cdp.mjs'), 'utf-8');

  ok('sleep 默认带抖动', /export const sleep = \(ms\) => new Promise\(\(r\) => setTimeout\(r, jitter\(ms\)\)\)/.test(cdpSrc));
  ok('另提供 sleepExact 给内部节奏用', /export const sleepExact/.test(cdpSrc));

  // 轮询步进用了抖动的话，实际轮询次数会不确定，侵蚀超时预算
  ok('waitFor 的轮询间隔不加抖动', /if \(ok\) return true;\s*\n\s*await sleepExact\(interval\)/.test(cdpSrc));
  ok('waitReady / waitRendered 的轮询不加抖动',
    !/await sleep\(300\)/.test(cdpSrc) && !/await sleep\(500\)/.test(cdpSrc));
  ok('登录等待轮询不加抖动（pollMs 要可预测）', /await sleepExact\(pollMs\)/.test(cdpSrc));
  ok('鼠标事件间隔不走全局抖动', !/await sleep\(40\)/.test(cdpSrc));

  // clickReal 拟人化
  ok('clickReal 落点在元素内随机微偏（不总取正中心）',
    /const off = \(size\)/.test(cdpSrc) && /Math\.min\(4,/.test(cdpSrc));
  ok('clickReal 分步移动而非瞬移', /const steps = 3 \+ Math\.floor\(Math\.random\(\) \* 3\)/.test(cdpSrc));
  ok('clickReal 按下与松开之间有随机停留', /sleepExact\(50 \+ Math\.floor\(Math\.random\(\) \* 70\)\)/.test(cdpSrc));
}

{
  const dpSrc = fs.readFileSync(path.join(HERE, 'doudian-page.mjs'), 'utf-8');

  ok('新版资料上传流程有独立入口', /export async function prepareSmartFill/.test(dpSrc));
  ok('新版资料页使用统一多文件 input',
    dpSrc.includes('input[type=file][accept=".jpg,.png,.jpeg,.csv,.xls,.xlsx"]'));
  ok('新版流程等待「确认信息，继续生成」解除禁用',
    /确认信息，继续生成/.test(dpSrc) && /智能填写预填完成/.test(dpSrc));
  ok('新版流程等待二次 AI 解析完成后再进入详情表单',
    /完成 AI 解析并进入详情表单/.test(dpSrc) && /商品详情图/.test(dpSrc));
  ok('新版流程保留旧版上传首图回退', /旧版流程；新版由 prepareSmartFill 自动带入/.test(dpSrc));

  ok('有可复用的下拉选项等待原语', /async function waitDropdownOptions/.test(dpSrc));

  // 四个靠服务端返回的下拉，都不能再是「固定 sleep 后读一次」
  for (const [what, re] of [
    ['品牌', /waitDropdownOptions\(page, \{\s*match: 'auto-dropdown-id-品牌'/],
    ['运费模板', /waitDropdownOptions\(page, \{\s*match: 'auto-dropdown-id-运费模板'/],
    ['尺码表模板', /waitDropdownOptions\(page, \{ label: '尺码表模板列表加载' \}\)/],
    ['材质候选', /label: `材质候选列表（\$\{name\}）`/],
  ]) {
    ok(`${what} 改成等选项真的出现（不再赌固定时间）`, re.test(dpSrc));
  }

  ok('规格值确认按钮改成等它挂载', /label: `规格值确认按钮（\$\{value\}）`/.test(dpSrc));

  // 这几个报错文案里「可选项为空」曾是读早了的征候，保留文案但不应再被误触发
  ok('仍保留真失败时的报错路径',
    /品牌未找到/.test(dpSrc) && /面料材质未找到候选/.test(dpSrc)
    && /未找到模板，可选/.test(dpSrc));
}

/* ---------- 尺码面板两种视图（假 DOM） ---------- */
group('尺码面板两种视图（假 DOM）');

/**
 * 视图A：传统两级 cascader。结构取自实测 dump —— 文案在 li 上，
 * label 内部 innerText 是空的（文字在 label 外的 span）。
 */
const sizeViewA = (sizes, checked = []) => [{
  id: 'panel',
  cls: 'ecom-g-cascader-menus styles_cascaderPopup__fgDlb',
  kids: [
    // 第一列：码制，没有 checkbox
    {
      tag: 'ul',
      cls: 'ecom-g-cascader-menu',
      kids: ['中国码', '欧码', '英码'].map((t) => ({
        tag: 'li', cls: 'ecom-g-cascader-menu-item', text: t,
      })),
    },
    // 最后一列：具体尺码，li 上带文案，内层 label 文案为空
    {
      tag: 'ul',
      cls: 'ecom-g-cascader-menu',
      kids: sizes.map((t) => ({
        tag: 'li',
        cls: 'ecom-g-cascader-menu-item',
        text: t,
        kids: [{
          tag: 'label',
          cls: 'ecom-g-checkbox-wrapper',
          text: '',
          kids: [{
            id: `A-${t}`,
            tag: 'input',
            cls: 'ecom-g-checkbox-input',
            attrs: { type: 'checkbox' },
            checked: checked.includes(t),
          }],
        }],
      })),
    },
  ],
}];

/**
 * 视图B：自定义布局，没有 ul/li，容器类名是 CSS Modules 哈希。
 * 码制列同样没有 checkbox，所以不会被误当成尺码。
 */
const sizeViewB = (sizes, checked = []) => [{
  id: 'panel',
  cls: 'ecom-g-cascader-menus styles_popupBlock__vjLB2',
  kids: [
    ...['中国码', '欧码', '英码'].map((t) => ({
      cls: 'styles_leftItem__pRdkI', text: t,
    })),
    ...sizes.map((t) => ({
      cls: 'styles_groupItem__l3XDn',
      text: t,
      kids: [{
        tag: 'label',
        cls: 'ecom-g-checkbox-wrapper',
        text: t,
        kids: [
          {
            id: `B-${t}`,
            tag: 'input',
            cls: 'ecom-g-checkbox-input',
            attrs: { type: 'checkbox' },
            checked: checked.includes(t),
          },
          { tag: 'span', text: t },
        ],
      }],
    })),
  ],
}];

const ALL_SIZES = ['XS', 'S', 'M', 'L', 'XL', '16XL', 'XXXS女'];

for (const [name, mk, pre] of [['视图A', sizeViewA, 'A'], ['视图B', sizeViewB, 'B']]) {
  const doc = fakeDom(mk(ALL_SIZES));
  const r = runExpr(sizeOptionsExpr(['S', 'M', 'L', 'XL']), doc);

  ok(`${name} 无报错且识别出视图 ${pre}`, !r.error && r.view === pre, JSON.stringify(r).slice(0, 120));
  ok(`${name} 四个尺码全部勾上`,
    ['S', 'M', 'L', 'XL'].every((s) => r.clicked.includes(s)) && !r.missing.length,
    `clicked=${r.clicked} missing=${r.missing}`);
  ok(`${name} 码制列（中国码/欧码）不会被当成尺码`,
    !r.checked.some((c) => /码$/.test(c)) && !r.clicked.some((c) => /码$/.test(c)));
  ok(`${name} 未请求的尺码不被误勾`,
    !r.clicked.includes('XS') && !r.clicked.includes('16XL'));
  ok(`${name} 每个勾选项都收到了完整鼠标事件序列`,
    ['S', 'M', 'L', 'XL'].every((s) => {
      const ev = doc._byId(`${pre}-${s}`)._events;
      return ['mouseover', 'mousedown', 'mouseup', 'click'].every((t) => ev.includes(t));
    }));
  ok(`${name} 长尺码文案（16XL / XXXS女）也能被定位`,
    !runExpr(sizeOptionsExpr(['16XL', 'XXXS女']), fakeDom(mk(ALL_SIZES))).missing.length);
}

// 已勾选的项不重复点（页面进来时 S/M/L/XL 可能已被预勾选）
for (const [name, mk, pre] of [['视图A', sizeViewA, 'A'], ['视图B', sizeViewB, 'B']]) {
  const doc = fakeDom(mk(ALL_SIZES, ['S', 'M']));
  const r = runExpr(sizeOptionsExpr(['S', 'M', 'L']), doc);
  ok(`${name} 已勾选的项归入 already、不重复派发事件`,
    r.already.includes('S') && r.already.includes('M') && r.clicked.includes('L')
    && doc._byId(`${pre}-S`)._events.length === 0,
    JSON.stringify(r).slice(0, 120));
}

// 平台缺某个尺码 → 报到 missing，由 setSizes 抛错
{
  const r = runExpr(sizeOptionsExpr(['S', '99XL']), fakeDom(sizeViewB(ALL_SIZES)));
  ok('平台没有的尺码进 missing', r.missing.includes('99XL') && r.clicked.includes('S'));
}

// 面板未展开 / 面板里没有 checkbox → 报错而不是静默返回空
{
  const empty = runExpr(sizeOptionsExpr(['S']), fakeDom([{ cls: 'unrelated' }]));
  ok('面板不存在时报「未展开」', empty.error?.includes('未展开'), JSON.stringify(empty));

  const noCb = runExpr(sizeOptionsExpr(['S']), fakeDom([{
    id: 'panel',
    cls: 'ecom-g-cascader-menus styles_popupBlock__vjLB2',
    kids: [{ cls: 'styles_leftItem__pRdkI', text: '中国码' }],
  }]));
  ok('面板里没有可勾选项时报错（不静默）', !!noCb.error, JSON.stringify(noCb));
}

// 哈希类名全变（模拟抖店发版）→ 仍然能定位，这是这套逻辑的意义所在
{
  const tree = sizeViewB(ALL_SIZES);
  tree[0].cls = 'ecom-g-cascader-menus styles_popupBlock__ZZ999';
  for (const k of tree[0].kids) {
    if (k.cls.includes('groupItem')) k.cls = 'styles_groupItem__ZZ999';
    if (k.cls.includes('leftItem')) k.cls = 'styles_leftItem__ZZ999';
  }
  const r = runExpr(sizeOptionsExpr(['S', 'M', 'L', 'XL']), fakeDom(tree));
  ok('CSS Modules 哈希全变后仍能勾选（不依赖哈希）',
    !r.error && !r.missing.length && r.clicked.length === 4, JSON.stringify(r).slice(0, 120));
}

// setSizes 的行为契约：勾选未生效必须抛错，不能静默放过
{
  const dpSrc = fs.readFileSync(path.join(HERE, 'doudian-page.mjs'), 'utf-8');
  ok('setSizes 用 sizeOptionsExpr 定位（未把逻辑复制回模板串）',
    /setSizes[\s\S]{0,2000}page\.eval\(sizeOptionsExpr\(sizes\)\)/.test(dpSrc));
  ok('setSizes 校验勾选是否真生效并抛错',
    /尺码勾选未生效/.test(dpSrc) && /尺码写入规格区失败/.test(dpSrc));
  ok('尺码写入规格区用轮询等待（不是固定 sleep 后一次性读）',
    /尺码写入规格区失败[\s\S]{0,200}/.test(dpSrc)
    && /written = await listSizeValues\(page\)/.test(dpSrc));
}

/* ---------- 风格 / 导购短标题 / radio 组（假 DOM） ---------- */
group('风格多选（假 DOM）');

/**
 * 真实结构还原（根据实测 dump）：标签容器与控件容器是**兄弟**，
 * 标签容器的 style 里带 width: 110px，文案在它里嵌了 4 层。
 * 所以定位必须逐层上溯找「nextElementSibling 里有 select」的那一层，
 * 写死层数（实测第 4 层）改一版就坑。
 */
const styleRowTree = (extraLabel = null) => [{
  id: 'row',
  cls: 'style_categoryPropertiesItemNew__kP5wv',
  kids: [
    {
      id: 'labelCol',
      attrs: { style: 'width: 110px; text-align: right;' },
      kids: [{
        kids: [{
          cls: 'style_labelWrapper__krth8',
          text: '风格',
          kids: [{ id: 'labelLeaf', tag: 'span', text: '风格' }],
        }],
      }],
    },
    {
      id: 'ctrlCol',
      kids: [{
        cls: 'style_helperWrapper__hGySD',
        kids: [{
          id: 'sel',
          cls: 'ecom-g-select ecom-g-tree-select styles_multiSelect__Nmxaq ecom-g-select-multiple',
          kids: [{ tag: 'input', cls: 'ecom-g-select-selection-search-input' }],
        }],
      }],
    },
    ...(extraLabel ? [extraLabel] : []),
  ],
}];

{
  const doc = fakeDom(styleRowTree());
  const cls = runExpr(styleSelectExpr(), doc);
  ok('风格选择器命中（文案→兄弟节点上溯）', typeof cls === 'string' && cls.includes('tree-select'),
    `得到 ${cls}`);
  ok('命中项被打上 data-dp=style', doc._byId('sel')._attrs['data-dp'] === 'style');
}

// 哈希全变（抖店发版）仍能定位 —— 不依赖 styles_multiSelect__Nmxaq 这个哈希
{
  const tree = styleRowTree();
  tree[0].kids[1].kids[0].kids[0].cls = 'ecom-g-select ecom-g-tree-select styles_multiSelect__ZZ999 ecom-g-select-multiple';
  const doc = fakeDom(tree);
  ok('风格：CSS Modules 哈希变了仍能定位',
    typeof runExpr(styleSelectExpr(), doc) === 'string'
    && doc._byId('sel')._attrs['data-dp'] === 'style');
}

/** 风格下拉：tree 节点，勾选目标是 .ecom-g-select-tree-checkbox（不是选项本身） */
const styleDropdown = (names, checked = []) => [{
  id: 'dd',
  cls: 'ecom-g-select-dropdown ecom-g-tree-select-dropdown',
  kids: names.map((n) => ({
    id: `node-${n}`,
    cls: 'ecom-g-select-tree-treenode',
    kids: [
      {
        id: `cb-${n}`,
        cls: `ecom-g-select-tree-checkbox${checked.includes(n) ? ' ecom-g-select-tree-checkbox-checked' : ''}`,
      },
      {
        cls: 'ecom-g-select-tree-node-content-wrapper',
        kids: [{ cls: 'ecom-g-select-tree-title', text: n }],
      },
    ],
  })),
}];

{
  const doc = fakeDom(styleDropdown(['法式']));
  const r = runExpr(styleOptionExpr('法式'), doc);
  ok('风格选项勾选成功', r?.state === 'clicked', JSON.stringify(r));
  ok('勾选打在 checkbox 上且四个鼠标事件齐全',
    ['mouseover', 'mousedown', 'mouseup', 'click']
      .every((t) => doc._byId('cb-法式')._events.includes(t)),
    JSON.stringify(doc._byId('cb-法式')._events));
}

{
  // 已勾选的不重复点（重复点会变成取消勾选，那才是真的坑）
  const doc = fakeDom(styleDropdown(['法式'], ['法式']));
  const r = runExpr(styleOptionExpr('法式'), doc);
  ok('已勾选的风格返回 already、不再派事件',
    r?.state === 'already' && doc._byId('cb-法式')._events.length === 0, JSON.stringify(r));
}

{
  const r = runExpr(styleOptionExpr('不存在风'), fakeDom(styleDropdown(['法式', '轻熟风'])));
  ok('平台没有的风格报 missing（由 setStyles 转成警告不阻断）', r?.missing === true,
    JSON.stringify(r));

  const closed = runExpr(styleOptionExpr('法式'), fakeDom([{ cls: 'unrelated' }]));
  ok('面板未展开时报错（不静默）', !!closed?.error, JSON.stringify(closed));
}

{
  // 正在消失的面板（带 -leave）不能被当成当前面板 —— 那会点到上一次的旧选项
  const tree = styleDropdown(['法式']);
  tree[0].cls = 'ecom-g-select-dropdown ecom-g-tree-select-dropdown ecom-g-slide-up-leave';
  ok('正在收起的面板不被误认',
    !!runExpr(styleOptionExpr('法式'), fakeDom(tree))?.error);
}

group('导购短标题（假 DOM）');

/** 实测：input 带 dropdownclassname=auto-dropdown-id-导购短标题，suffix 里 20×20 img 是 AI 按钮 */
const shortTitleTree = (value = '', withAi = true) => [{
  cls: 'ecom-g-input-affix-wrapper',
  kids: [
    {
      id: 'inp',
      tag: 'input',
      cls: 'ecom-g-input',
      value,
      placeholder: '建议填写简明准确的标题内容，避免重复表达',
      attrs: { dropdownclassname: 'auto-dropdown-id-导购短标题' },
    },
    {
      cls: 'ecom-g-input-suffix',
      kids: [
        { id: 'counter', tag: 'span', text: '0/24' },
        ...(withAi ? [{ id: 'ai', tag: 'img' }] : []),
      ],
    },
  ],
}];

{
  const doc = fakeDom(shortTitleTree());
  const r = runExpr(shortTitleAiExpr(), doc);
  ok('导购短标题：输入框与 AI 按钮都命中', r?.ai === true && r?.value === '', JSON.stringify(r));
  ok('两者各自打上标记',
    doc._byId('inp')._attrs['data-dp'] === 'short-title'
    && doc._byId('ai')._attrs['data-dp'] === 'short-ai');
  ok('不会把字数计数器 0/24 当成 AI 按钮',
    doc._byId('counter')._attrs['data-dp'] === undefined);
}

{
  // 平台已预填时不应再点 AI（setShortTitle 直接返回现值）
  const r = runExpr(shortTitleAiExpr(), fakeDom(shortTitleTree('高腰套装清新白色显瘦百搭')));
  ok('已预填时报回现值', r?.value === '高腰套装清新白色显瘦百搭');
}

{
  // AI 图标不存在（抖店改版下掉了）→ ai:false，由调用方跳过而不是报错
  const r = runExpr(shortTitleAiExpr(), fakeDom(shortTitleTree('', false)));
  ok('无 AI 图标时返回 ai:false（跳过而非抛错）', r?.ai === false, JSON.stringify(r));

  const none = runExpr(shortTitleAiExpr(), fakeDom([{ cls: 'nothing' }]));
  ok('字段整体不存在时返回 null', none === null);
}

group('radio 组（假 DOM）');

/**
 * 四处 radio 组完全同构，且 value 在字段间**重复**：
 *   现货发货时间 48小时=2，订单库存计数 付款减库存=2，商品状态 下架=1…
 * 所以必须先靠标签文案锁区域、再靠选项文案选中。
 * 这组用例把三个字段放在同一份 DOM 里，就是为了卡住「选错字段」这个风险。
 */
const radioSection = () => [{
  id: 'section',
  kids: [
    ['现货发货时间', [['当日发', '9999', false], ['次日发', '1', false], ['48小时', '2', false]]],
    ['订单库存计数', [['下单减库存', '1', true], ['付款减库存', '2', false]]],
    ['商品状态', [['上架', '0', true], ['下架', '1', false]]],
  ].flatMap(([label, opts]) => [
    {
      attrs: { style: 'width: 110px;' },
      kids: [{ kids: [{ tag: 'span', text: label }] }],
    },
    {
      id: `ctrl-${label}`,
      kids: opts.map(([text, value, checked]) => ({
        id: `label-${label}-${text}`,
        tag: 'label',
        cls: 'ecom-g-radio-wrapper',
        text,
        kids: [{
          id: `radio-${label}-${text}`,
          tag: 'input',
          value,
          checked,
          attrs: { type: 'radio' },
        }],
      })),
    },
  ]),
}];

{
  const doc = fakeDom(radioSection());
  const r = runExpr(radioGroupExpr('现货发货时间', '48小时', 'shiptime'), doc);
  ok('现货发货时间：命中 48小时', r?.marked === true, JSON.stringify(r));
  ok('只标记该字段的选项，不误伤 value 相同的其他字段',
    doc._byId('label-现货发货时间-48小时')._attrs['data-dp'] === 'shiptime'
    && doc._byId('label-订单库存计数-付款减库存')._attrs['data-dp'] === undefined);
}

{
  const doc = fakeDom(radioSection());
  ok('订单库存计数：命中付款减库存',
    runExpr(radioGroupExpr('订单库存计数', '付款减库存', 'stockmode'), doc)?.marked === true
    && doc._byId('label-订单库存计数-付款减库存')._attrs['data-dp'] === 'stockmode');
}

{
  // 已是目标值时不重复点（radio 重点无害，但少一次真实鼠标手势少一分风险）
  const r = runExpr(radioGroupExpr('商品状态', '上架', 'shelf'), fakeDom(radioSection()));
  ok('已选中时返回 already', r?.already === true, JSON.stringify(r));
}

{
  // 区域找到了但选项名写错 → 把真实可选项列出来（setRadioOption 据此抛错）
  const r = runExpr(radioGroupExpr('现货发货时间', '72小时', 'shiptime'), fakeDom(radioSection()));
  ok('选项名不对时回报实际可选项',
    Array.isArray(r?.options) && r.options.includes('48小时'), JSON.stringify(r));

  // 字段整体不存在（部分类目没有这一项）→ null，setRadioOption 跳过不阻断
  const none = runExpr(radioGroupExpr('不存在的字段', 'X', 'x'), fakeDom(radioSection()));
  ok('字段不存在时返回 null（不阻断上架）', none === null);
}

/* ---------- 新增字段的行为契约 ---------- */
group('新增字段的行为契约');

{
  const src = fs.readFileSync(path.join(HERE, 'doudian-page.mjs'), 'utf-8');

  // 风格选项列表是虚拟滚动（实测 50 项、一屏只挂 10-12 个）。
  // 靠搜索框过滤命中，不能改回「滚动扫全表找目标」—— 后者会漏护未渲染的项。
  ok('setStyles 靠搜索框过滤（而非滚动扫虚拟列表）',
    /setStyles[\s\S]{0,2500}selection-search-input[\s\S]{0,400}styleOptionExpr/.test(src));
  ok('setStyles 收尾清搜索词并收起面板',
    /setStyles[\s\S]{0,3500}Escape[\s\S]{0,200}document\.body\.click/.test(src));
  ok('setStyles 限 5 项并上报超限项', /const STYLE_MAX = 5/.test(src)
    && /超限: over/.test(src));
  ok('平台没有的风格只进未找到、不抛错', /missing\.push\(name\)/.test(src));

  // 未命中时要把该类目实际可选项一并回报。否则只说「没找到 X」，
  // 人得自己去后台翻——这是当初弄了个 --list-styles 单跑一轮的起因，
  // 而那做法要多上传一次主图、多担一份风控。别退回去。
  ok('风格未命中时回报该类目实际可选项',
    /该类目可选: availableWhenMissing/.test(src)
    && /missing\.length \? await collectOptions\(page\)/.test(src));
  // 2026-08-30 设计变更：风格全集现在也是 pi 候选集的常规来源
  //（getStyleCandidates，同一次流程内收集、无额外上传），所以允许第二处调用；
  // 但报错路径的条件调用（missing.length ? ...）必须保留。
  ok('收集全集：报错路径条件调用 + getStyleCandidates 各一处',
    /async function collectOptions/.test(src)
    && /missing\.length \? await collectOptions\(page\)/.test(src)
    && /getStyleCandidates[\s\S]{0,2000}await collectOptions\(page\)/.test(src));
  ok('收集前先清搜索词（否则读到上一个关键词的过滤结果）',
    /async function collectOptions[\s\S]{0,600}set\.call\(i, ''\)/.test(src));
  ok('滚动终止看实际 scrollTop（不看未夹取的请求值）',
    /next\.top >= next\.max/.test(src));

  // 导购短标题的 AI 不弹推荐列表，判据必须是输入框 value 变非空。
  // 若有人把它改成去找 dropdown（照搬商品标题那套），会永远超时。
  ok('setShortTitle 以输入框 value 为判据（不找 dropdown）',
    /setShortTitle[\s\S]{0,1200}data-dp=short-title[\s\S]{0,200}value/.test(src)
    && !/setShortTitle[\s\S]{0,1200}dropdown-menu/.test(src));
  ok('setShortTitle 重试一次后返回 null（由调用方跳过）',
    /export async function setShortTitle\(page, \{ timeoutMs = \d+, retries = 1 \}/.test(src));

  const pub = fs.readFileSync(path.join(HERE, 'publish.mjs'), 'utf-8');
  ok('publish.mjs 对导购短标题失败只警告不阻断',
    /setShortTitle\(page\)\.catch\(\(\) => null\)/.test(pub)
    && /导购短标题 AI 未返回，已跳过/.test(pub));
  ok('publish.mjs 风格走 --styles 而非 Excel 列',
    /opts\.styleMap\?\.\[item\.款号\]/.test(pub) && !/item\.风格/.test(pub));
  ok('publish.mjs 写入发货时效与库存计数',
    /dp\.setShipTime\(page, item\.发货时效\)/.test(pub)
    && /dp\.setStockDeductMode\(page, item\.订单库存计数\)/.test(pub));
  ok('默认品牌回落 对门的猫', /\|\| '对门的猫'/.test(pub));

  // --styles 同时接 inline JSON 与文件路径。只读文件的旧写法遇到 inline 会报
  // 「ENOENT: ... open '{"A1":[…]}'」，报错指向完全错的方向，要防回归。
  ok('--styles 区分 inline JSON 与文件路径',
    /const inline = raw\.startsWith\('\{'\)/.test(pub)
    && /JSON\.parse\(inline \? raw : fs\.readFileSync/.test(pub));
  ok('--styles 两种失败分开报错', /JSON 解析失败/.test(pub) && /文件读取失败/.test(pub));
  ok('--styles 校验值是数组、且提示不在货盘里的款号',
    /值不是数组/.test(pub) && /不在本次待处理货盘里/.test(pub));
}

/* ---------- 工作台标签页复用 ---------- */
group('工作台标签页复用');

// 只认工作台首页。放宽到任意 /ffa/ 会接管到用户正在手填的发布页，把内容冲掉。
ok('DOUDIAN_HOME 命中工作台首页匹配', isDoudianHomepageUrl(DOUDIAN_HOME));
ok('工作台首页（带 query/hash、无 /index）都命中', [
  'https://fxg.jinritemai.com/ffa/mshop/homepage',
  'https://fxg.jinritemai.com/ffa/mshop/homepage/index',
  'https://fxg.jinritemai.com/ffa/mshop/homepage/index?tab=1#a',
].every(isDoudianHomepageUrl));
ok('发布页 / 登录页 / 官网 / 外域均不命中', [
  'https://fxg.jinritemai.com/ffa/g/create',
  'https://fxg.jinritemai.com/ffa/g/list?status=1',
  DOUDIAN_LOGIN,
  'https://fxg.jinritemai.com/',
  'about:blank',
  // 防伪造域名：路径像工作台但不是抖店
  'https://evil.com/ffa/mshop/homepage/index',
  'https://fxg.jinritemai.com.evil.com/ffa/mshop/homepage',
].every((u) => !isDoudianHomepageUrl(u)));

// findHomepageTab 只靠 Target.getTargets，用假 conn 就能离线验选页逻辑。
const fakeConn = (targetInfos) => ({ cdp: { send: async () => ({ targetInfos }) }, port: 0 });

const homeHit = await findHomepageTab(fakeConn([
  { type: 'page', targetId: 'T1', url: 'https://www.baidu.com/' },
  { type: 'page', targetId: 'T2', url: 'https://fxg.jinritemai.com/ffa/g/create' },
  { type: 'page', targetId: 'T3', url: 'https://fxg.jinritemai.com/ffa/mshop/homepage/index' },
]));
ok('多 tab 中能挑出工作台首页', homeHit?.targetId === 'T3',
  `命中 ${homeHit?.targetId ?? 'null'}`);

const noHome = await findHomepageTab(fakeConn([
  { type: 'page', targetId: 'T1', url: 'https://fxg.jinritemai.com/ffa/g/create' },
  // 工作台 URL 但 type 不是 page（service worker / iframe）不能算
  { type: 'other', targetId: 'T2', url: DOUDIAN_HOME },
]));
ok('没有工作台 tab 时返回 null（后续会新开）', noHome === null);

// 接管来的页 owned 必需为 false，否则 close() 会关掉用户自己的标签页。
const cdpSrc = fs.readFileSync(path.join(HERE, 'cdp.mjs'), 'utf-8');
ok('attachPage 默认 owned=false', /export async function attachPage\([^)]*owned = false/.test(cdpSrc));
ok('probeLogin 接管时传 owned:false',
  /attachPage\(conn, hit\.targetId, \{ owned: false \}\)/.test(cdpSrc));
ok('probeLogin 释放接管页用 detach 而不是 close',
  /adopted[\s\S]{0,200}Target\.detachFromTarget/.test(cdpSrc));
ok('复用后仍会重新加载以校验会话（不信旧 DOM 快照）',
  /adopted = true;[\s\S]{0,400}safeNavigate\(url\)/.test(cdpSrc));

const pubSrc = fs.readFileSync(path.join(HERE, 'publish.mjs'), 'utf-8');
ok('publish.mjs 已改用 openOrAdoptPage',
  pubSrc.includes('openOrAdoptPage(u, { conn })') && !/openPage\(u, \{ conn \}\)/.test(pubSrc));
ok('publish.mjs 收尾对接管页先退回工作台',
  /!keptPage\.owned[\s\S]{0,80}safeNavigate\(DOUDIAN_HOME\)/.test(pubSrc));

const docSrc = fs.readFileSync(path.join(HERE, 'doctor.mjs'), 'utf-8');
ok('doctor.mjs 已改用 openOrAdoptPage',
  docSrc.includes('openOrAdoptPage(u, { conn })') && !/openPage\(u, \{ conn \}\)/.test(docSrc));

/* ---------- wsUrl 缓存（免「Allow remote debugging?」确认框） ---------- */
group('wsUrl 缓存与隔离');

// 不启浏览器，只验缓存文件的校验语义（这是隔离的关键）。
// 真实事故：专用实例被杀后，自动探测回落到 9222 连上了日常浏览器，
// 若把那个终结点写进专用 profile 缓存，下次就会静默驾驭用户的日常浏览器。
const wsProf = fs.mkdtempSync(path.join(os.tmpdir(), 'doudian-ws-'));
const wsFile = path.join(wsProf, 'devtools-ws.json');
const pidFile = path.join(wsProf, 'chrome.pid');

// 用当前进程的 pid 充当“活着的实例”
const livePid = process.pid;
const deadPid = 999999;   // 几乎不可能存在

function fakeCache(obj) { fs.writeFileSync(wsFile, JSON.stringify(obj), 'utf-8'); }
function fakePidFile(pid, port) { fs.writeFileSync(pidFile, `${pid}\n${port}\n`, 'utf-8'); }

// 复刻 readWsCache 的校验逻辑（cdp.mjs 里是模块私有函数）
function validateCache(profile) {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(profile, 'devtools-ws.json'), 'utf-8'));
    if (!j?.wsUrl || !j?.port || !j?.pid) return null;
    try { process.kill(j.pid, 0); } catch { return null; }
    const [pidLine] = fs.readFileSync(path.join(profile, 'chrome.pid'), 'utf-8').split('\n');
    if (Number.parseInt(pidLine.trim(), 10) !== j.pid) return null;
    return j;
  } catch { return null; }
}

fakeCache({ port: 1234, wsUrl: 'ws://127.0.0.1:1234/devtools/browser/abc', pid: livePid });
fakePidFile(livePid, 1234);
ok('pid 活着且与 chrome.pid 一致 → 缓存有效', validateCache(wsProf) !== null);

fakeCache({ port: 1234, wsUrl: 'ws://127.0.0.1:1234/devtools/browser/abc', pid: deadPid });
fakePidFile(deadPid, 1234);
ok('pid 已死 → 缓存失效', validateCache(wsProf) === null);

// 关键隔离用例：缓存指向日常浏览器（9222），但 chrome.pid 是别的实例
fakeCache({ port: 9222, wsUrl: 'ws://127.0.0.1:9222/devtools/browser/daily', pid: livePid });
fakePidFile(livePid + 1, 62677);
ok('缓存 pid 与 chrome.pid 不符 → 拒绝（防误连日常浏览器）',
  validateCache(wsProf) === null);

fakeCache({ port: 1234, wsUrl: 'ws://127.0.0.1:1234/devtools/browser/abc' });   // 缺 pid
fakePidFile(livePid, 1234);
ok('旧格式缓存（无 pid）→ 拒绝', validateCache(wsProf) === null);

fs.writeFileSync(wsFile, 'not-json', 'utf-8');
ok('损坏的缓存文件不抛异常', validateCache(wsProf) === null);

fs.rmSync(wsProf, { recursive: true, force: true });

ok('cdp.mjs 导出 WS_CACHE 常量', typeof cdpWsCache === 'string' && cdpWsCache.endsWith('devtools-ws.json'));
ok('WS_CACHE 落在 profile 目录内', cdpWsCache.startsWith(cdpProfile));

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
  // 发货时效、订单库存计数已实装（radio 组），不再算未生效。
  // 发货模式、售后政策仍取页面默认值（售后政策在发布页没有独立控件）。
  ok('未生效配置正好是发货模式 + 售后政策',
    ['发货模式', '售后政策'].every((k) => plan.未生效配置.includes(k))
    && plan.未生效配置.length === 2,
    `实际: ${plan.未生效配置.join('、')}`);
  ok('已实装项不在未生效列表',
    ['品牌', '运费模板', '发货时效', '订单库存计数']
      .every((k) => !plan.未生效配置.includes(k)),
    `实际: ${plan.未生效配置.join('、')}`);
  ok('defaults 读到品牌（默认 对门的猫）', plan.defaults.品牌 === '对门的猫',
    `实际: ${plan.defaults.品牌}`);
  ok('defaults 默认发货时效 48小时、库存计数 付款减库存',
    plan.defaults.发货时效 === '48小时' && plan.defaults.订单库存计数 === '付款减库存',
    `实际: ${plan.defaults.发货时效} / ${plan.defaults.订单库存计数}`);

  const assetXlsx = path.join(tmp, 'asset-test.xlsx');
  const assetDir = path.join(tmp, 'assets', 'A1');
  fs.mkdirSync(assetDir, { recursive: true });
  const assetPy = `
from openpyxl import Workbook
from PIL import Image
from openpyxl.drawing.image import Image as XLImage
wb = Workbook()
ws = wb.active
ws.title = '商品'
ws.append(['款号', '商品标题', '类目', '面料材质', '素材目录', '参考图', '规格组名', '规格值', '尺码', '价格', '库存'])
ws.append(['A1', '', '服装>女装>时尚套装', '聚酯纤维', ${JSON.stringify(assetDir)}, '', '颜色分类', '红|蓝', 'S', '红:10|蓝:10', 'S:1'])
ws.append(['A2', '', '服装>女装>时尚套装', '聚酯纤维', ${JSON.stringify(assetDir)}, '', '颜色分类', '红', 'S', '红:10', 'S:1'])
Image.new('RGB', (200, 200), (0, 0, 255)).save(${JSON.stringify(path.join(tmp, 'ref1.png'))})
Image.new('RGB', (200, 200), (0, 255, 0)).save(${JSON.stringify(path.join(tmp, 'ref2.png'))})
for f in [${JSON.stringify(path.join(tmp, 'ref1.png'))}, ${JSON.stringify(path.join(tmp, 'ref2.png'))}]:
    img = XLImage(f)
    img.anchor = 'F2'
    ws.add_image(img)
wb.save(${JSON.stringify(assetXlsx)})
Image.new('RGB', (600, 800), (255, 0, 0)).save(${JSON.stringify(path.join(assetDir, '主图01.jpg'))})
`;
  execFileSync('python3', ['-c', assetPy], { stdio: 'pipe' });
  execFileSync('python3', [path.join(HERE, 'normalize-assets.py'), assetXlsx], { stdio: 'pipe' });
  const normalizedPlan = JSON.parse(execFileSync(
    'python3', [path.join(HERE, 'read-plan.py'), assetXlsx], { encoding: 'utf-8' },
  ));
  const normalized = normalizedPlan.items[0];
  ok('非 1:1 主图被规范化为 1:1',
    normalizedPlan.errors.length === 1 && path.basename(normalized.素材.主图[0]) === '主图01_1x1.jpg');
  ok('缺少规格图时回退使用首张主图',
    normalized.素材.规格图.红 === normalized.素材.主图[0]
      && normalized.素材.规格图.蓝 === normalized.素材.主图[0]
      && normalized.素材.规格图回退.length === 2);

  const refDir = path.join(assetDir, '参考图');
  ok('单元格内嵌参考图被导出到 <素材目录>/参考图/',
    normalized.素材.参考图.length === 2
      && normalized.素材.参考图.every((p) => path.dirname(p) === refDir && fs.existsSync(p)),
    `实际: ${JSON.stringify(normalized.素材.参考图)}`);
  ok('参考图不污染主图/详情图/规格图',
    !normalized.素材.主图.some((p) => p.includes(`${path.sep}参考图${path.sep}`))
      && normalized.素材.详情图.length === 0);

  const beforeRerun = fs.readdirSync(refDir).sort();
  execFileSync('python3', [path.join(HERE, 'read-plan.py'), assetXlsx], { encoding: 'utf-8' });
  ok('重复解析不累积参考图文件（幂等）',
    JSON.stringify(fs.readdirSync(refDir).sort()) === JSON.stringify(beforeRerun));

  const refMissing = normalizedPlan.errors.find((e) => e.款号 === 'A2');
  ok('参考图为必填，缺失时阻断',
    !!refMissing && refMissing.问题.some((p) => p.includes('缺少参考图')),
    `实际: ${JSON.stringify(normalizedPlan.errors)}`);

  const noRefCol = path.join(tmp, 'no-ref-col.xlsx');
  execFileSync('python3', ['-c', `
from openpyxl import Workbook
wb = Workbook(); ws = wb.active; ws.title = '商品'
ws.append(['款号', '类目', '面料材质', '素材目录', '规格组名', '规格值', '尺码', '价格', '库存'])
wb.save(${JSON.stringify(noRefCol)})
`], { stdio: 'pipe' });
  let colErr = '';
  try {
    execFileSync('python3', [path.join(HERE, 'read-plan.py'), noRefCol],
      { encoding: 'utf-8', stdio: 'pipe' });
  } catch (e) { colErr = e.stdout || ''; }
  ok('旧模板缺「参考图」列时明确报错', colErr.includes('模板缺少必需列') && colErr.includes('参考图'));

  // WPS 单元格图片回归：openpyxl 的 ws._images 为空，但 XLSX ZIP 中有
  // cellimages.xml + DISPIMG 公式，read-plan.py 必须能按单元格恢复图片。
  const wpsXlsx = path.join(tmp, 'wps-cell-image.xlsx');
  const wpsAssetDir = path.join(tmp, 'wps-assets', 'W1');
  const wpsPy = `
from pathlib import Path
from zipfile import ZipFile, ZIP_DEFLATED
from openpyxl import Workbook
from PIL import Image

out = ${JSON.stringify(wpsXlsx)}
asset_dir = ${JSON.stringify(wpsAssetDir)}
Path(asset_dir).mkdir(parents=True, exist_ok=True)
Image.new('RGB', (200, 200), (255, 0, 0)).save(Path(asset_dir) / '主图01.jpg')

wb = Workbook()
ws = wb.active
ws.title = '商品'
ws.append(['款号', '参考图', '商品标题', '类目', '面料材质', '材质含量',
           '素材目录', '规格组名', '规格值', '尺码', '价格', '库存'])
ws.append(['W1', '=_xlfn.DISPIMG("ID_TEST",1)', '', '服装>女装>时尚套装',
           '聚酯纤维', '', asset_dir, '颜色分类', '红', 'S', '红:10', 'S:1'])
base = str(Path(out).with_suffix('.base.xlsx'))
wb.save(base)

with ZipFile(base) as zin:
    files = {name: zin.read(name) for name in zin.namelist()}

files['xl/media/wps-test.png'] = b'\\x89PNG\\r\\n\\x1a\\n' + b'WPS-TEST'
files['xl/cellimages.xml'] = b'''<?xml version="1.0" encoding="UTF-8"?>
<etc:cellImages xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing"
 xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"
 xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"
 xmlns:etc="http://www.wps.cn/officeDocument/2017/etCustomData">
 <etc:cellImage><xdr:pic><xdr:nvPicPr><xdr:cNvPr id="1" name="ID_TEST"/></xdr:nvPicPr>
 <xdr:blipFill><a:blip r:embed="rId1"/></xdr:blipFill></xdr:pic></etc:cellImage>
</etc:cellImages>'''
files['xl/_rels/cellimages.xml.rels'] = b'''<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
 <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/wps-test.png"/>
</Relationships>'''
rels = files['xl/_rels/workbook.xml.rels'].decode('utf-8')
rels = rels.replace('</Relationships>', '<Relationship Id="rId99" Type="http://www.wps.cn/officeDocument/2020/cellImage" Target="cellimages.xml"/></Relationships>')
files['xl/_rels/workbook.xml.rels'] = rels.encode('utf-8')
ct = files['[Content_Types].xml'].decode('utf-8')
ct = ct.replace('</Types>', '<Override PartName="/xl/cellimages.xml" ContentType="application/vnd.wps-officedocument.cellimage+xml"/></Types>')
files['[Content_Types].xml'] = ct.encode('utf-8')

with ZipFile(out, 'w', ZIP_DEFLATED) as zout:
    for name, data in files.items():
        zout.writestr(name, data)
Path(base).unlink()
`;
  execFileSync('python3', ['-c', wpsPy], { stdio: 'pipe' });
  const wpsPlan = JSON.parse(execFileSync(
    'python3', [path.join(HERE, 'read-plan.py'), wpsXlsx], { encoding: 'utf-8' },
  ));
  const wpsItem = wpsPlan.items.find((it) => it.款号 === 'W1');
  ok('WPS DISPIMG 单元格图片可被恢复并导出',
    !!wpsItem && wpsItem.素材.参考图.length === 1
      && fs.existsSync(wpsItem.素材.参考图[0])
      && wpsPlan.errors.length === 0,
    JSON.stringify(wpsPlan));
  ok('WPS DISPIMG 不再被当作文件路径',
    !JSON.stringify(wpsPlan).includes('参考图路径不存在或不是图片')
      && !JSON.stringify(wpsPlan).includes('DISPIMG 单元格图片，但图片数据无法'),
    JSON.stringify(wpsPlan.errors));
}

fs.rmSync(tmp, { recursive: true, force: true });

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
