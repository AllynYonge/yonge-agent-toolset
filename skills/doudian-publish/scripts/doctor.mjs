#!/usr/bin/env node
/**
 * 选择器体检：打开发布页，逐个检查 selectors.mjs 里的选择器是否还命中。
 *
 * 为什么需要：页面上大量选择器是 CSS Modules 哈希，抖店发一次版就全变，
 * 而失效表现是上架跑到一半报「等待超时」。与其拿真账号试错，不如先跑体检。
 *
 * 用法:
 *   node doctor.mjs [--launch] [--port <n>] [--shot doctor.png] [--json]
 *
 * 说明：只读页面，不填任何字段、不提交，对账号的动作最小。
 * 受限的是「阶段可见性」——第二步页/规格区/SKU 表要走完前面的流程才存在，
 * 所以默认只体检 step1；带 --deep 会填最少字段进到第二步（仍不提交）。
 */
import {
  openPage, connectBrowser, launchDedicated, findExistingDebugPort,
  browserOpenHint, isLoggedIn,
} from './cdp.mjs';
import { SEL, candidates } from './selectors.mjs';
import * as dp from './doudian-page.mjs';
const argv = process.argv.slice(2);
const opt = {
  launch: argv.includes('--launch'),
  deep: argv.includes('--deep'),
  json: argv.includes('--json'),
  port: argv.includes('--port') ? argv[argv.indexOf('--port') + 1] : undefined,
  shot: argv.includes('--shot') ? argv[argv.indexOf('--shot') + 1] : undefined,
};

async function connect() {
  if (opt.port) {
    const c = await connectBrowser(opt.port);
    if (!c) throw new Error(`调试端口 ${opt.port} 连不上`);
    return c;
  }
  if (opt.launch) {
    const r = await launchDedicated({ url: 'https://fxg.jinritemai.com/login/common' });
    return { port: r.port, cdp: r.cdp };
  }
  const own = await findExistingDebugPort();
  const c = await connectBrowser(own ?? undefined);
  if (!c) {
    console.error(browserOpenHint());
    process.exit(1);
  }
  return c;
}

/** 在页面里逐个候选试探，返回命中的选择器与元素数 */
async function probe(page, key) {
  const list = candidates(key);
  const r = await page.eval(`
    const out = [];
    for (const s of ${JSON.stringify(list)}) {
      let n = 0;
      try { n = document.querySelectorAll(s).length; } catch (e) { n = -1; }
      out.push({ sel: s, n });
    }
    return out;
  `);
  const hit = r.find((x) => x.n > 0);
  return {
    key,
    note: SEL[key].note,
    stage: SEL[key].stage,
    ok: !!hit,
    // 命中的是不是首选（hash）；命中 alt 说明哈希已变，该更新常量表了
    viaFallback: !!hit && hit.sel !== list[0],
    hitSel: hit?.sel ?? null,
    count: hit?.n ?? 0,
    tried: r,
  };
}

async function main() {
  const conn = await connect();

  // 先确认登录态。不先查的话，openCreatePage 会报「等待超时: 发布页首图上传控件」，
  // 让人误以为是选择器失效，实际只是没登录——这两种原因必须分开报。
  const st = await isLoggedIn(conn).catch((e) => ({ loggedIn: false, url: `检测失败: ${e.message}` }));
  if (!st.loggedIn) {
    console.error('未登录抖店，无法体检选择器。');
    console.error(`当前页面: ${st.url}`);
    console.error('');
    console.error('请在已打开的浏览器窗口里登录抖店，然后重跑。');
    conn.cdp.close();
    process.exit(2);
  }

  const page = await dp.openCreatePage((u) => openPage(u, { conn }));

  const results = [];
  const stages = opt.deep ? ['step1', 'step2', 'spec', 'sku'] : ['step1'];

  for (const key of Object.keys(SEL)) {
    if (!stages.includes(SEL[key].stage)) continue;
    results.push(await probe(page, key));
  }

  // 文案锚点也查一下，它们比类名稳，是 fallback 的基础
  const bodyText = await page.text();
  const textChecks = [
    ['标题区文案', /商品标题|上传主图|主图/.test(bodyText)],
    ['类目区文案', /类目|最近创建/.test(bodyText)],
  ];

  if (opt.shot) {
    await page.screenshot(opt.shot).catch(() => {});
  }

  const broken = results.filter((r) => !r.ok);
  const stale = results.filter((r) => r.viaFallback);

  if (opt.json) {
    console.log(JSON.stringify({
      时间: new Date().toISOString(),
      阶段: stages,
      失效: broken.map((b) => b.key),
      哈希已变: stale.map((s) => ({ key: s.key, 命中: s.hitSel })),
      明细: results,
    }, null, 2));
  } else {
    console.log(`选择器体检（阶段: ${stages.join(' / ')}）\n`);
    for (const r of results) {
      const mark = !r.ok ? '✗' : r.viaFallback ? '·' : '✓';
      const tail = !r.ok
        ? '全部候选均未命中'
        : r.viaFallback
          ? `命中兜底 ${r.hitSel}（哈希已变，请更新 selectors.mjs）`
          : `${r.count} 个`;
      console.log(`${mark} ${r.key.padEnd(22)} ${tail}`);
      if (!r.ok) {
        for (const t of r.tried) console.log(`    tried: ${t.sel}`);
      }
      if (r.note && (!r.ok || r.viaFallback)) console.log(`    用途: ${r.note}`);
    }
    console.log('');
    for (const [name, ok] of textChecks) {
      console.log(`${ok ? '✓' : '✗'} 文案锚点 ${name}`);
    }
    console.log('');
    console.log(`命中 ${results.length - broken.length} / ${results.length}`
      + (stale.length ? `，其中 ${stale.length} 条走了兜底` : ''));
    if (broken.length) {
      console.log('');
      console.log('有选择器失效，先去真实页面上确认新的类名，再更新 scripts/selectors.mjs。');
      console.log('改之前读 references/dom-notes.md —— 那里记着每处的交互序列约束。');
    }
    if (!opt.deep) {
      console.log('');
      console.log('提示：第二步页/规格区/SKU 表需要走完前置流程才存在，本次未体检。');
      console.log('      想连它们一起查，加 --deep（会填最少字段进第二步，仍不提交）。');
    }
    if (opt.shot) console.log(`截图: ${opt.shot}`);
  }

  await page.close().catch(() => {});
  conn.cdp.close();
  process.exit(broken.length ? 1 : 0);
}

main().catch((e) => {
  console.error(`体检失败: ${e.message}`);
  process.exit(1);
});
