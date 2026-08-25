#!/usr/bin/env node
/**
 * 选择器体检：打开发布页，逐个检查 selectors.mjs 里的选择器是否还命中。
 *
 * 为什么需要：页面上大量选择器是 CSS Modules 哈希，抖店发一次版就全变，
 * 而失效表现是上架跑到一半报「等待超时」。与其拿真账号试错，不如先跑体检。
 *
 * 用法:
 *   node doctor.mjs [--launch | --port <n>] [--shot doctor.png] [--json]
 *                   [--image <主图路径>] [--deep]
 *
 * 分级说明（很重要）：
 *   空白发布页上，类目区、第二步页、规格区、SKU 表**根本不存在**，
 *   把它们报成「失效」是误报。所以每条选择器在 selectors.mjs 里标了 `needs`，
 *   本脚本只对「前置条件已满足」的项判定成败，其余标为「跳过」。
 *
 *   不带 --image 时只能验白页可见的那几项。
 *   带 --image 会真的上传一张主图（这是让类目区出现的唯一办法），
 *   再配 --deep 会继续进第二步页、切手动规格、建一个临时规格值，
 *   从而覆盖到 SKU 表。**全程不提交、不保存草稿**，跑完关掉标签页即弃。
 */
import {
  openPage, connectBrowser, launchDedicated, findExistingDebugPort,
  browserOpenHint, isLoggedIn, sleep,
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
  image: argv.includes('--image') ? argv[argv.indexOf('--image') + 1] : undefined,
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
    needs: SEL[key].needs ?? null,
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

  // 已满足的前置条件集合。白页什么都没有。
  const met = new Set();
  const steps = [];

  try {
    if (opt.image) {
      steps.push('上传主图');
      await dp.uploadFirstImage(page, opt.image);
      await sleep(4000);
      met.add('image');

      // 类目区要等标题填完、平台跑完 AI 识别才出现；
      // 「最近创建」快捷项还要再点开「手动选择类目」弹层才存在。
      steps.push('填标题');
      await dp.fillTitle(page, '体检用标题聚酯纤维时尚套装女两件套通勤百搭');
      await sleep(5000);
      const opened = await page.eval(`
        const s = [...document.querySelectorAll('span')]
          .find(e => e.children.length === 0 && e.innerText.trim() === '手动选择类目');
        if (s) s.click();
        return !!s;
      `);
      if (opened) {
        steps.push('开类目弹层');
        await sleep(3500);
        met.add('category');
      }

      if (opt.deep) {
        // 关掉类目弹层再往下走，否则它会挡住「下一步」
        await page.eval(`
          const b = [...document.querySelectorAll('button')]
            .find(x => x.offsetParent && /^(取消|关闭)$/.test(x.innerText.trim()));
          if (b) b.click();
          return !!b;
        `).catch(() => {});
        await sleep(1500);

        steps.push('进第二步');
        await dp.gotoStepTwo(page);
        await sleep(2000);
        met.add('step2');

        steps.push('切手动规格');
        await dp.switchToManualSpec(page);
        await sleep(1500);
        met.add('manual');

        steps.push('建临时规格值');
        await dp.addSpecValue(page, '上衣');
        await dp.setSizes(page, ['S', 'M']);
        await sleep(2000);
        met.add('sku');
      }
    }
  } catch (e) {
    console.error(`⚠ 推进页面状态时出错（已完成: ${steps.join(' → ') || '无'}）: ${e.message}`);
    console.error('  后续依赖该状态的项会被标为「跳过」。\n');
  }

  const results = [];
  for (const key of Object.keys(SEL)) {
    const needs = SEL[key].needs;
    const r = await probe(page, key);
    r.skipped = !!needs && !met.has(needs);
    results.push(r);
  }

  if (opt.shot) await page.screenshot(opt.shot).catch(() => {});

  const checked = results.filter((r) => !r.skipped);
  const skipped = results.filter((r) => r.skipped);
  const broken = checked.filter((r) => !r.ok);
  const stale = checked.filter((r) => r.viaFallback);

  if (opt.json) {
    console.log(JSON.stringify({
      时间: new Date().toISOString(),
      已满足前置: [...met],
      推进步骤: steps,
      失效: broken.map((b) => b.key),
      哈希已变: stale.map((s) => ({ key: s.key, 命中: s.hitSel })),
      跳过: skipped.map((s) => ({ key: s.key, 需要: s.needs })),
      明细: results,
    }, null, 2));
  } else {
    console.log(`选择器体检${steps.length ? `（已推进: ${steps.join(' → ')}）` : '（白页，仅验基础项）'}\n`);
    for (const r of results) {
      if (r.skipped) {
        console.log(`- ${r.key.padEnd(22)} 跳过（需要「${r.needs}」状态）`);
        continue;
      }
      const mark = !r.ok ? '✗' : r.viaFallback ? '·' : '✓';
      const tail = !r.ok
        ? '全部候选均未命中'
        : r.viaFallback
          ? `命中兜底 ${r.hitSel}（哈希已变，请更新 selectors.mjs）`
          : `${r.count} 个`;
      console.log(`${mark} ${r.key.padEnd(22)} ${tail}`);
      if (!r.ok) for (const t of r.tried) console.log(`    tried: ${t.sel}`);
      if (r.note && (!r.ok || r.viaFallback)) console.log(`    用途: ${r.note}`);
    }

    console.log('');
    console.log(`已验 ${checked.length} 项：命中 ${checked.length - broken.length}`
      + (stale.length ? `（其中 ${stale.length} 条走兜底）` : '')
      + (broken.length ? `，失效 ${broken.length}` : ''));
    if (skipped.length) {
      console.log(`跳过 ${skipped.length} 项：前置条件未满足`);
      const needImage = skipped.filter((s) => s.needs === 'image').length;
      if (needImage && !opt.image) {
        console.log('  → 加 --image <主图路径> 可验类目区等依赖主图的项');
      }
      if (!opt.deep) {
        console.log('  → 加 --image <主图> --deep 可验第二步页/规格区/SKU 表');
      }
    }
    if (broken.length) {
      console.log('');
      console.log('有选择器确实失效，去真实页面上确认新类名，再更新 scripts/selectors.mjs。');
      console.log('改之前读 references/dom-notes.md —— 那里记着每处的交互序列约束。');
    }
    if (opt.shot) console.log(`截图: ${opt.shot}`);
    console.log('');
    console.log('本次未提交、未保存草稿。标签页已关闭。');
  }

  await page.close().catch(() => {});
  conn.cdp.close();
  process.exit(broken.length ? 1 : 0);
}

main().catch((e) => {
  console.error(`体检失败: ${e.message}`);
  process.exit(1);
});
