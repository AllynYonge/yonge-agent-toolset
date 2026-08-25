#!/usr/bin/env node
/**
 * 抖店商品批量上架 CLI。
 *
 * 用法:
 *   node publish.mjs --plan 货盘.xlsx [选项]
 *
 * 选项:
 *   --plan <path>      模板 Excel（必填）
 *   --root <dir>       素材根目录，默认取 Excel 所在目录
 *   --sku A,B          只处理指定款号
 *   --mode draft|publish|dry
 *                      draft(默认)=填完存草稿；publish=正式发布；dry=只校验不提交
 *   --brand <name>     品牌，默认取「全局默认」Sheet，回落 无品牌
 *   --launch           用专用 profile 启动/复用浏览器（推荐，与日常浏览器隔离）
 *   --port <n>         手动指定调试端口
 *   --keep-tab         跑完不关标签页（便于人工复核）
 *   --shots <dir>      每款保存一张提交前截图
 *   --report <path>    结果写成 JSON，便于交给下一个流程
 *   --resume           跳过状态文件里已成功的款号
 *   --no-dedup         跳过提交前的货号查重
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  openPage, sleep, checkPython, connectBrowser, browserOpenHint,
  launchDedicated, findExistingDebugPort, isLoggedIn, DEDICATED_PROFILE,
} from './cdp.mjs';
import * as dp from './doudian-page.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

function parseArgs(argv) {
  const o = { mode: 'draft' };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === '--plan') o.plan = next();
    else if (a === '--root') o.root = next();
    else if (a === '--sku') o.sku = next();
    else if (a === '--mode') o.mode = next();
    else if (a === '--brand') o.brand = next();
    else if (a === '--port') o.port = next();
    else if (a === '--shots') o.shots = next();
    else if (a === '--report') o.report = next();
    else if (a === '--launch') o.launch = true;
    else if (a === '--resume') o.resume = true;
    else if (a === '--no-dedup') o.noDedup = true;
    else if (a === '--keep-tab') o.keepTab = true;
    else if (a === '--help' || a === '-h') o.help = true;
  }
  return o;
}

function usage() {
  console.log(`抖店商品批量上架

用法:
  node publish.mjs --plan <货盘.xlsx> [--root <素材目录>] [--sku GZ0021,GZ0027]
                   [--mode draft|publish|dry] [--brand 无品牌]
                   [--launch] [--port <n>] [--shots ./shots] [--keep-tab]
                   [--report out.json] [--resume] [--no-dedup]

mode 说明:
  draft   （默认）填完全部字段后保存草稿，不上架
  publish 填完并点「发布商品」
  dry     只填字段并跑填写检查，不提交，便于验证映射是否正确

浏览器:
  --launch  用专用 profile 启动/复用一个隔离的浏览器实例（推荐）。
            首次需在弹出窗口里手动登录抖店，登录态之后持久保留。
            profile: ${DEDICATED_PROFILE}
  --port    手动指定调试端口；两者都不给则自动探测

批量:
  --resume    跳过状态文件里已成功的款号（状态文件与 --plan 同目录）
  --no-dedup  跳过提交前的货号查重（默认会查，避免重复建商品）
  --report    把结果写成 JSON

环境变量:
  DOUDIAN_PROFILE_DIR   专用 profile 目录
  DOUDIAN_DEBUG_PORT    钉死调试端口
  DOUDIAN_CHROME_PATH   浏览器可执行文件
`);
}

function readPlan(plan, root, sku) {
  const args = [path.join(HERE, 'read-plan.py'), plan];
  if (root) args.push('--root', root);
  if (sku) args.push('--sku', sku);
  const out = execFileSync('python3', args, { encoding: 'utf-8', maxBuffer: 32 * 1024 * 1024 });
  return JSON.parse(out);
}

/** 无标题时用规则生成一个合规标题（15-60 字符，8-30 汉字） */
function fallbackTitle(item) {
  const leaf = item.类目[item.类目.length - 1];
  const parts = item.规格值.join('');
  const base = `${item.面料材质[0]?.[0] ?? ''}${leaf}女${parts.includes('套装') ? '两件套' : ''}时尚气质通勤百搭`;
  let t = base.replace(/\s/g, '');
  if (t.length < 8) t = `${t}新款${item.款号}`;
  return t.slice(0, 30);
}

async function publishOne(page, item, opts, log) {
  const title = item.标题 || fallbackTitle(item);
  const mats = item.素材;

  if (!mats.主图.length) throw new Error('无主图，无法发布');

  log(`  [1/11] 上传首图 ${path.basename(mats.主图[0])}`);
  await dp.uploadFirstImage(page, mats.主图[0]);

  const extra = mats.主图.slice(1, 5);
  if (extra.length) {
    log(`  [2/11] 上传辅助图 ${extra.length} 张`);
    await dp.uploadExtraImages(page, extra);
  }

  log(`  [3/11] 标题: ${title}`);
  await dp.fillTitle(page, title);

  log(`  [4/11] 类目: ${item.类目.join(' > ')}`);
  const cat = await dp.selectCategory(page, item.类目);
  log(`         已选 ${cat.replace(/\n/g, '')}`);

  log('  [5/11] 进入详情表单');
  await dp.gotoStepTwo(page);

  log(`  [6/11] 面料材质: ${item.面料材质.map(([n, p]) => `${n} ${p}%`).join(' + ')}`);
  await dp.setFabric(page, item.面料材质);
  log(`         品牌: ${opts.brand}，货号: ${item.款号}`);
  await dp.setBrand(page, opts.brand);
  await dp.setArticleNo(page, item.款号);

  if (mats.详情图.length) {
    log(`  [7/11] 详情图 ${mats.详情图.length} 张`);
    const n = await dp.uploadDetailImages(page, mats.详情图);
    log(`         商详图片共 ${n} 张`);
  }

  log(`  [8/11] 规格: ${item.规格组名} = ${item.规格值.join('、')} × ${item.尺码.join('、')}`);
  await dp.switchToManualSpec(page);
  for (const v of item.规格值) {
    await dp.addSpecValue(page, v);
    log(`         + ${v}`);
  }
  await dp.setSizes(page, item.尺码);

  const specImgs = Object.keys(mats.规格图);
  if (specImgs.length) {
    const done = await dp.uploadSpecImages(page, item.规格值, mats.规格图);
    log(`         规格图已上传: ${done.join('、')}`);
  }

  log('  [9/11] 填 SKU 价格/库存/商家编码');
  const filled = await dp.fillSkuTable(page, {
    specValues: item.规格值,
    sizes: item.尺码,
    prices: item.价格,
    stocks: item.库存,
    stockDetail: item.库存明细,
    codeRule: item.商家编码规则,
    code: item.款号,
  });
  log(`         ${filled.length} 条 SKU`);

  if (item.尺码表模板) {
    log(`  [10/11] 尺码表模板: ${item.尺码表模板}`);
    await dp.applySizeTemplate(page, item.尺码表模板);
  }
  if (item.运费模板) {
    log(`          运费模板: ${item.运费模板}`);
    await dp.setFreightTemplate(page, item.运费模板);
  }
  const st = await dp.setShelfStatus(page, item.商品状态);
  log(`          商品状态: ${st}`);

  log('  [11/11] 填写检查');
  const v = await dp.runValidation(page);
  if (v.count > 0) {
    return { ok: false, title, validation: v };
  }
  log('          校验通过，0 个错误');
  return { ok: true, title, validation: v };
}
/**
 * 建立浏览器连接。优先级：--port > --launch > 自动探测（专用 profile 优先）。
 * --launch 不回落到通用探测，否则日常浏览器开着 9222 时会静默接上去，隔离形同虚设。
 */
async function connect(opts) {
  if (opts.port) {
    const c = await connectBrowser(opts.port);
    if (!c) throw new Error(`指定的调试端口 ${opts.port} 连不上`);
    return { conn: c, port: c.port, dedicated: false };
  }
  if (opts.launch) {
    const r = await launchDedicated({ url: 'https://fxg.jinritemai.com/login/common' });
    if (r.launched) {
      console.log(`已启动专用浏览器（profile: ${r.profile}，端口 ${r.port}）`);
      console.log('首次使用请先在弹出的窗口里登录抖店。');
    } else {
      console.log(`复用已在跑的专用浏览器（端口 ${r.port}）`);
    }
    return { conn: { port: r.port, cdp: r.cdp }, port: r.port, dedicated: true };
  }
  const own = await findExistingDebugPort();
  const c = await connectBrowser(own ?? undefined);
  if (!c) {
    console.error(browserOpenHint());
    console.error('');
    console.error('若 web-access 的 cdp-proxy 正在占用调试终结点，先执行: pkill -f cdp-proxy.mjs');
    process.exit(1);
  }
  return { conn: c, port: c.port, dedicated: !!own };
}

/** 状态文件：记住哪些款号已成功，供 --resume 跳过。与 --plan 同目录同名。 */
function stateFile(plan) {
  return path.join(path.dirname(path.resolve(plan)),
    `.${path.basename(plan, path.extname(plan))}.state.jsonl`);
}

function readDone(plan) {
  const done = new Map();
  try {
    for (const line of fs.readFileSync(stateFile(plan), 'utf-8').split('\n')) {
      if (!line.trim()) continue;
      const r = JSON.parse(line);
      if (r.款号) done.set(r.款号, r);
    }
  } catch {
    /* 首次跑没有这个文件 */
  }
  return done;
}

function appendState(plan, rec) {
  try {
    fs.appendFileSync(stateFile(plan),
      `${JSON.stringify({ ...rec, 时间: new Date().toISOString() })}\n`, 'utf-8');
  } catch {
    /* 写不下不影响主流程 */
  }
}

const SUCCESS_STATES = new Set(['已发布', '已存草稿', 'dry 通过']);
/** 主动跳过不算失败，也不算成功，不影响退出码 */
const SKIP_STATES = new Set(['已跳过（重复）']);

/** 跨步长的随机休息：完全规整的节奏本身就是自动化特征 */
function jitter(baseMs, ratio = 0.4) {
  return Math.round(baseMs * (1 + (Math.random() * 2 - 1) * ratio));
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help || !opts.plan) {
    usage();
    process.exit(opts.plan ? 0 : 1);
  }

  const py = checkPython();
  if (!py.ok) {
    console.error(`需要 python3 + openpyxl 来解析 Excel。安装: ${py.hint}`);
    process.exit(1);
  }

  const plan = readPlan(opts.plan, opts.root, opts.sku);

  if (plan.errors?.length) {
    console.error('模板存在阻断性问题，已中止：');
    for (const e of plan.errors) {
      if (typeof e === 'string') console.error(`  - ${e}`);
      else console.error(`  - 第 ${e.行} 行 ${e.款号}: ${e.问题.join('；')}`);
    }
    process.exit(1);
  }

  if (!plan.items.length) {
    console.error('模板中没有可处理的商品行');
    process.exit(1);
  }

  // 品牌优先级：--brand > 「全局默认」Sheet > 无品牌
  const brand = opts.brand || plan.defaults?.品牌 || '无品牌';

  // 「全局默认」里填了但脚本不写入页面的项，必须说清楚，不然用户以为改了就生效
  if (plan.未生效配置?.length) {
    console.log(`⚠ 「全局默认」以下项目前不会写入页面，取抖店页面默认值: ${plan.未生效配置.join('、')}`);
    console.log('  需要这些字段生效的话，请在抖店后台先设好店铺默认，或提 issue 补齐。\n');
  }

  // 续盘：跳过状态文件里已成功的款号
  let items = plan.items;
  if (opts.resume) {
    const done = readDone(opts.plan);
    const skip = items.filter((it) => SUCCESS_STATES.has(done.get(it.款号)?.状态));
    if (skip.length) {
      console.log(`--resume：跳过已成功的 ${skip.length} 款（${skip.map((s) => s.款号).join('、')}）`);
      items = items.filter((it) => !SUCCESS_STATES.has(done.get(it.款号)?.状态));
    }
    if (!items.length) {
      console.log('全部款号已完成，无事可做。');
      process.exit(0);
    }
  }

  const { conn, port, dedicated } = await connect(opts);

  // 专用实例先确认登录态，否则会卡在登录页报一堆模糊的等待超时
  if (dedicated || opts.launch) {
    const st = await isLoggedIn(conn).catch(() => ({ loggedIn: true }));
    if (!st.loggedIn) {
      console.error('');
      console.error('专用 profile 尚未登录抖店。请在已打开的浏览器窗口里完成登录，然后重跑本命令。');
      console.error(`当前页面: ${st.url}`);
      conn.cdp.close();
      process.exit(1);
    }
  }

  console.log(`共 ${items.length} 款待处理，mode=${opts.mode}，品牌=${brand}，调试端口 ${port}\n`);

  if (opts.shots) fs.mkdirSync(opts.shots, { recursive: true });

  const results = [];
  for (const item of items) {
    console.log(`── ${item.款号}（第 ${item.行} 行）`);
    if (item.警告.length) {
      for (const w of item.警告) console.log(`  ⚠ ${w}`);
    }

    let page;
    let failed = false;
    const log = (m) => console.log(m);
    const record = (r) => {
      results.push(r);
      appendState(opts.plan, r);
    };
    try {
      // 提交前查重：同一份货盘跑两次就会建出两批重复商品。
      // dry 模式不提交，无需查。
      if (!opts.noDedup && opts.mode !== 'dry') {
        const probe = await openPage('about:blank', { conn });
        try {
          const hit = await dp.findExistingByCode(probe, item.款号);
          if (hit.hint) {
            console.log(`  ⓘ 查重未完成：${hit.hint}`);
          } else if (hit.exists) {
            console.log(`  ⚠ 已存在货号 ${item.款号} 的商品（${hit.count} 条），跳过。强行重建用 --no-dedup`);
            record({ 款号: item.款号, 状态: '已跳过（重复）', 详情: `后台已有 ${hit.count} 条同货号商品` });
            continue;
          }
        } finally {
          await probe.close().catch(() => {});
        }
      }

      page = await dp.openCreatePage((u) => openPage(u, { conn }));
      const r = await publishOne(page, item, { ...opts, brand }, log);

      if (opts.shots) {
        const f = path.join(opts.shots, `${item.款号}.png`);
        await page.screenshot(f);
        console.log(`  截图 ${f}`);
      }

      if (!r.ok) {
        failed = true;
        console.log(`  ✗ 校验未通过（${r.validation.count} 个错误），未提交`);
        console.log(`    ${r.validation.detail.replace(/\n/g, ' | ').slice(0, 220)}`);
        record({ 款号: item.款号, 状态: '校验失败', 详情: r.validation.detail.slice(0, 200) });
      } else if (opts.mode === 'dry') {
        console.log('  ✓ dry 模式：校验通过，未提交');
        record({ 款号: item.款号, 状态: 'dry 通过', 标题: r.title });
      } else if (opts.mode === 'publish') {
        const out = await dp.publishProduct(page);
        const ok = /发布成功|提交成功|审核中/.test(out.text);
        console.log(ok ? '  ✓ 已发布' : '  ? 已点击发布，请人工确认结果');
        record({ 款号: item.款号, 状态: ok ? '已发布' : '发布待确认', 标题: r.title });
      } else {
        const ok = await dp.saveDraft(page);
        console.log(ok ? '  ✓ 已存草稿' : '  ? 已点击保存草稿，请人工确认结果');
        record({ 款号: item.款号, 状态: ok ? '已存草稿' : '草稿待确认', 标题: r.title });
      }
    } catch (e) {
      failed = true;
      console.log(`  ✗ 失败: ${e.message}`);
      if (page && opts.shots) {
        const f = path.join(opts.shots, `${item.款号}-error.png`);
        await page.screenshot(f).catch(() => {});
        console.log(`  错误截图 ${f}`);
      }
      record({ 款号: item.款号, 状态: '失败', 详情: e.message });
    } finally {
      // 失败时保留标签页，便于人工在浏览器里查现场。只有成功才关。
      if (page && failed) {
        const u = await page.url().catch(() => 'unknown');
        console.log(`  ⓘ 失败，标签页已保留供调试: ${u}`);
      } else if (page && !opts.keepTab) {
        await page.close().catch(() => {});
      }
    }
    console.log('');
    await sleep(jitter(2500));
  }

  console.log('══ 汇总');
  for (const r of results) {
    console.log(`  ${r.款号}\t${r.状态}\t${r.标题 ?? r.详情 ?? ''}`);
  }
  const failed = results.filter((r) => !SUCCESS_STATES.has(r.状态) && !SKIP_STATES.has(r.状态));
  const skipped = results.filter((r) => SKIP_STATES.has(r.状态));
  console.log(`\n成功 ${results.length - failed.length - skipped.length} / ${results.length - skipped.length}`
    + (skipped.length ? `（另有 ${skipped.length} 款因重复被跳过）` : ''));
  console.log(`状态文件: ${stateFile(opts.plan)}（重跑时加 --resume 可跳过已成功的款）`);

  if (opts.report) {
    const payload = {
      模板: path.resolve(opts.plan),
      模式: opts.mode,
      品牌: brand,
      时间: new Date().toISOString(),
      成功: results.length - failed.length - skipped.length,
      跳过: skipped.length,
      总数: results.length,
      结果: results,
    };
    fs.writeFileSync(opts.report, JSON.stringify(payload, null, 2), 'utf-8');
    console.log(`报告: ${path.resolve(opts.report)}`);
  }

  conn.cdp.close();
  if (failed.length) process.exitCode = 1;
}

main().catch((e) => {
  console.error(`致命错误: ${e.message}`);
  process.exit(1);
});
