#!/usr/bin/env node
/** 临时探针：dump 发布页规格/尺码区域 DOM 结构 */
import {
  openOrAdoptPage, connectBrowser, launchDedicated, findExistingDebugPort,
  ensureLogin, sleep, DOUDIAN_HOME, Page,
} from './cdp.mjs';
import * as dp from './doudian-page.mjs';

const argv = process.argv.slice(2);
const opt = {
  launch: argv.includes('--launch'),
  port: argv.includes('--port') ? argv[argv.indexOf('--port') + 1] : undefined,
};

async function connect() {
  if (opt.port) {
    const c = await connectBrowser(opt.port);
    if (!c) throw new Error(`端口 ${opt.port} 连不上`);
    return c;
  }
  if (opt.launch) {
    const r = await launchDedicated({ url: DOUDIAN_HOME });
    return { port: r.port, cdp: r.cdp };
  }
  const own = await findExistingDebugPort();
  const c = await connectBrowser(own ?? undefined);
  if (!c) throw new Error('未找到浏览器');
  return c;
}

async function main() {
  const conn = await connect();
  await ensureLogin(conn, { wait: true });

  console.log('→ 进入发布页');
  const page = await openOrAdoptPage(dp.CREATE_URL, { conn });

  // 上传主图
  console.log('→ 上传主图');
  const mainImg = process.argv.find(a => a.endsWith('.jpg') || a.endsWith('.png'));
  if (mainImg) {
    await dp.uploadFirstImage(page, mainImg);
    await sleep(3000);
  }

  console.log('→ AI 标题');
  await dp.aiTitleAndCategory(page);
  await sleep(2000);

  console.log('→ 进第二步');
  await dp.gotoStepTwo(page);
  await sleep(3000);

  console.log('→ 切手动规格');
  await dp.switchToManualSpec(page);
  await sleep(2000);

  // Dump 1: 整体规格区
  const dump1 = await page.eval(`
    const body = document.body.innerText;
    const idx = body.indexOf('商品规格');
    const around = idx >= 0 ? body.slice(Math.max(0, idx - 100), idx + 600) : 'NOT FOUND';

    const pickers = [...document.querySelectorAll('.ecom-g-cascader-picker, [class*=cascader-picker]')]
      .map(p => ({
        tag: p.tagName,
        text: (p.innerText || '').trim().slice(0, 80),
        classes: p.className.slice(0, 120),
        offsetParent: !!p.offsetParent,
        rect: (() => { const r = p.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; })(),
      }));

    const boxes = [...document.querySelectorAll('.style_specValueBox__i8sD6, [class*=specValueBox]')]
      .map((b, i) => ({
        idx: i,
        text: (b.innerText || '').trim().slice(0, 200),
        classes: b.className.slice(0, 120),
        childCount: b.children.length,
      }));

    const sizeEls = [...document.querySelectorAll('*')]
      .filter(x => x.offsetParent && /尺码|S\\s*M\\s*L|请选择尺码/.test(x.innerText?.slice(0, 60) || ''))
      .slice(0, 10)
      .map(x => ({
        tag: x.tagName,
        text: (x.innerText || '').trim().slice(0, 120),
        classes: x.className.slice(0, 120),
      }));

    const switchBtn = [...document.querySelectorAll('button, a, span, div')]
      .filter(x => x.offsetParent && /切换手动填写|手动填写|手动录入|智能填写/.test(x.innerText || ''))
      .map(x => ({
        tag: x.tagName,
        text: (x.innerText || '').trim().slice(0, 80),
        classes: x.className.slice(0, 120),
      }));

    return { around, pickers, boxes, sizeEls, switchBtn };
  `);

  console.log('\n=== 规格区周边文案 ===');
  console.log(dump1.around);

  console.log('\n=== Cascader Pickers ===');
  console.log(JSON.stringify(dump1.pickers, null, 2));

  console.log('\n=== SpecValueBox ===');
  console.log(JSON.stringify(dump1.boxes, null, 2));

  console.log('\n=== 尺码相关元素 ===');
  console.log(JSON.stringify(dump1.sizeEls, null, 2));

  console.log('\n=== 切换手动填写按钮 ===');
  console.log(JSON.stringify(dump1.switchBtn, null, 2));

  // Dump 2: cascader 元素
  const dump2 = await page.eval(`
    [...document.querySelectorAll('[class*=cascader]')]
      .filter(x => x.offsetParent)
      .map(x => ({
        tag: x.tagName,
        text: (x.innerText || '').trim().slice(0, 150),
        classes: x.className.slice(0, 150),
      }));
  `);
  console.log('\n=== 所有可见 cascader 元素 ===');
  console.log(JSON.stringify(dump2, null, 2));

  // Dump 3: 规格区域 HTML
  const dump3 = await page.eval(`
    const box = document.querySelector('.style_specValueBox__i8sD6, [class*=specValueBox]');
    if (!box) return 'NO specValueBox found';
    const parent = box.closest('div[class*=spec], div[class*=sku], form, [class*=product]') || box.parentElement?.parentElement;
    return (parent || box).innerHTML.slice(0, 3000);
  `);
  console.log('\n=== 规格区域 HTML (前 3000 字符) ===');
  console.log(dump3);

  await page.close();
  console.log('\n探针完成');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});