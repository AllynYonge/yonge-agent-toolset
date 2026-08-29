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
 *   --mode draft|publish
 *                      draft(默认)=填完存草稿；publish=正式发布
 *   --brand <name>     品牌，默认取「全局默认」Sheet，回落 对门的猫
 *   --styles <json>    风格映射：inline JSON 或 JSON 文件路径，
 *                      形如 {"款号": ["法式", "轻熟风"]}。
 *                      风格要根据图片判定，而本脚本无视觉能力，所以由 agent
 *                      在上品前看主图选好再传进来（见 SKILL.md）
 *   --launch           用专用 profile 启动/复用浏览器（推荐，与日常浏览器隔离）
 *   --port <n>         手动指定调试端口
 *   --keep-tab         跑完不关标签页（便于人工复核）
 *   --shots <dir>      每款保存一张提交前截图
 *   --report <path>    结果写成 JSON，便于交给下一个流程
 *   --resume           跳过状态文件里已成功的款号
 *   --no-wait-login    未登录时直接退出，不等用户登录（CI / 无人值守）
 *   --login-timeout <秒> 等待登录的上限，默认 300
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  openOrAdoptPage, sleep, checkPython, connectBrowser, browserOpenHint,
  launchDedicated, findExistingDebugPort, ensureLogin, DEDICATED_PROFILE,
  DOUDIAN_HOME,
} from './cdp.mjs';
import * as dp from './doudian-page.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

function parseArgs(argv) {
  const o = { mode: 'draft', unknown: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === '--plan') o.plan = next();
    else if (a === '--root') o.root = next();
    else if (a === '--sku') o.sku = next();
    else if (a === '--mode') o.mode = next();
    else if (a === '--brand') o.brand = next();
    else if (a === '--styles') o.styles = next();
    else if (a === '--port') o.port = next();
    else if (a === '--shots') o.shots = next();
    else if (a === '--report') o.report = next();
    else if (a === '--launch') o.launch = true;
    else if (a === '--resume') o.resume = true;
    else if (a === '--no-wait-login') o.noWaitLogin = true;
    else if (a === '--login-timeout') o.loginTimeout = next();
    else if (a === '--keep-tab') o.keepTab = true;
    else if (a === '--help' || a === '-h') o.help = true;
    else if (a.startsWith('--')) o.unknown.push(a);
  }
  return o;
}

function usage() {
  console.log(`抖店商品批量上架

用法:
  node publish.mjs --plan <货盘.xlsx> [--root <素材目录>] [--sku GZ0021,GZ0027]
                   [--mode draft|publish] [--brand 对门的猫] [--styles styles.json]
                   [--launch] [--port <n>] [--shots ./shots] [--keep-tab]
                   [--report out.json] [--resume]

mode 说明:
  draft   （默认）填完全部字段后保存草稿，不上架
  publish 填完并点「发布商品」

风格:
  --styles  按款号指定风格（每款最多 5 项）。接 inline JSON 或 JSON 文件路径：
              --styles '{"GZ0021": ["法式", "轻熟风"]}'
              --styles styles.json
            风格靠看图定，本脚本不做判断；不传就跳过（会拉低商品质量分）。

浏览器:
  --launch  用专用 profile 启动/复用一个隔离的浏览器实例（推荐）。
            启动后自动检验登录态：已登录直接继续；未登录则打开登录页，
            等你在窗口里登录完成后自动继续，不需要重跑命令。
            profile: ${DEDICATED_PROFILE}
  --port    手动指定调试端口；两者都不给则自动探测

登录:
  --no-wait-login       未登录就直接退出，不等待（CI / 无人值守）
  --login-timeout <秒>  等待登录的上限，默认 300

批量:
  --resume    跳过状态文件里已成功的款号（状态文件与 --plan 同目录）
  --report    把结果写成 JSON

环境变量:
  DOUDIAN_PROFILE_DIR   专用 profile 目录
  DOUDIAN_DEBUG_PORT    钉死调试端口
  DOUDIAN_CHROME_PATH   浏览器可执行文件
`);
}

function normalizeAssets(plan, root, sku) {
  const args = [path.join(HERE, 'normalize-assets.py'), plan];
  if (root) args.push('--root', root);
  if (sku) args.push('--sku', sku);
  execFileSync('python3', args, { encoding: 'utf-8', stdio: 'inherit' });
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
  const planTitle = item.标题;
  const mats = item.素材;

  if (!mats.主图.length) throw new Error('无主图，无法发布');

  const smart = await dp.prepareSmartFill(page, mats.主图[0]);
  if (smart) {
    log(`  [1/13] 上传资料并进入智能填写助手 ${path.basename(mats.主图[0])}`);
  } else {
    log(`  [1/13] 上传首图 ${path.basename(mats.主图[0])}`);
    await dp.uploadFirstImage(page, mats.主图[0]);
  }

  const extra = mats.主图.slice(1, 5);
  if (extra.length) {
    log(`  [2/13] 上传辅助图 ${extra.length} 张`);
    await dp.uploadExtraImages(page, extra);
  }

  let title;
  if (smart) {
    log('  [3/13] 等待智能填写预填标题/类目并确认');
    const info = await dp.gotoStepTwo(page);
    title = info.title || planTitle || fallbackTitle(item);
    const category = info.category || '';
    log(`         标题（智能填写）: ${title}`);
    if (category) log(`  [4/13] 类目（智能填写）: ${category.replace(/\n/g, ' ')}`);
    if (planTitle && planTitle !== title) {
      log(`         ℹ Excel 标题已忽略（智能填写优先）: ${planTitle}`);
    }
    const wantLeaf = item.类目[item.类目.length - 1];
    if (wantLeaf && category && !category.includes(wantLeaf)) {
      log(`         ⚠ 自动类目与模板不一致（模板: ${item.类目.join(' > ')}），以自动填充为准`);
    }
  } else {
    log(`  [3/13] AI 标题 + 自动类目`);
    const ai = await dp.aiTitleAndCategory(page);
    if (ai) {
      // AI 标题优先：选中推荐后平台会顺带把类目填好，比自己逐级点稳。
      // Excel「商品标题」列此时不生效，只当 AI 不可用时的兜底。
      title = ai.title;
      log(`         标题（AI 推荐第一条）: ${title}`);
      log(`  [4/13] 类目（平台自动填充）: ${ai.category.replace(/\n/g, ' ')}`);
      if (planTitle && planTitle !== title) {
        log(`         ℹ Excel 标题已忽略（AI 标题优先）: ${planTitle}`);
      }
      // 不一致只警告、不覆写：以平台识别为准，不阻断批量
      const wantLeaf = item.类目[item.类目.length - 1];
      if (wantLeaf && !ai.category.includes(wantLeaf)) {
        log(`         ⚠ 自动类目与模板不一致（模板: ${item.类目.join(' > ')}），以自动填充为准`);
      }
    } else {
      // 回退老流程：手填标题 + 手动选 Excel 里的类目
      title = planTitle || fallbackTitle(item);
      log(`         AI 推荐不可用，回退手填标题: ${title}`);
      await dp.fillTitle(page, title);
      log(`  [4/13] 类目（手动选择）: ${item.类目.join(' > ')}`);
      const cat = await dp.selectCategory(page, item.类目);
      log(`         已选 ${cat.replace(/\n/g, '')}`);
    }

    log('  [5/13] 进入详情表单');
    await dp.gotoStepTwo(page);
  }

  log(`  [6/13] 面料材质: ${item.面料材质.map(([n, p]) => `${n} ${p}%`).join(' + ')}`);
  await dp.setFabric(page, item.面料材质);
  log(`         品牌: ${opts.brand}，货号: ${item.款号}`);
  await dp.setBrand(page, opts.brand);
  await dp.setArticleNo(page, item.款号);

  // 导购短标题：非必填，点 AI 后平台 5-7s 直接写入输入框（不弹推荐列表）。
  // 拿不到只警告，不阻断 —— 空着仅影响商品质量分。
  const shortTitle = await dp.setShortTitle(page).catch(() => null);
  if (shortTitle) {
    log(`         导购短标题（AI）: ${shortTitle}`);
  } else {
    log('         ⚠ 导购短标题 AI 未返回，已跳过（非必填，可在草稿里手工补）');
  }

  // 风格：要根据图片选，由 agent 选完经 --styles 传进来（本脚本不做视觉判断）
  const wantStyles = opts.styleMap?.[item.款号] ?? [];
  if (wantStyles.length) {
    const r = await dp.setStyles(page, wantStyles);
    log(`         风格: ${r.已选.join('、') || '无'}`);
    if (r.未找到.length) {
      log(`         ⚠ 当前类目无此风格（已跳过）: ${r.未找到.join('、')}`);
      // 光说「没找到」人还得自己去后台翻。直接把该类目真实可选项列出来，
      // 下一次 --styles 该改成什么一目了然。
      if (r.该类目可选?.length) {
        log(`           该类目可选（${r.该类目可选.length} 项）: ${r.该类目可选.join('、')}`);
      }
    }
    if (r.超限.length) {
      log(`         ⚠ 风格最多 5 项，已舍弃: ${r.超限.join('、')}`);
    }
  } else {
    log('         ⚠ 未指定风格（会拉低商品质量分），用 --styles 传入');
  }

  if (mats.详情图.length) {
    log(`  [7/13] 详情图 ${mats.详情图.length} 张`);
    const n = await dp.uploadDetailImages(page, mats.详情图);
    log(`         商详图片共 ${n} 张`);
  }

  log(`  [8/13] 规格: ${item.规格组名} = ${item.规格值.join('、')} × ${item.尺码.join('、')}`);
  await dp.switchToManualSpec(page);
  for (const v of item.规格值) {
    await dp.addSpecValue(page, v);
    log(`         + ${v}`);
  }
  const sizeView = await dp.setSizes(page, item.尺码);
  if (sizeView?.view) log(`         尺码面板视图 ${sizeView.view}`);

  const specImgs = Object.keys(mats.规格图);
  if (mats.规格图回退?.length) {
    log(`         缺少规格图，已默认使用主图: ${mats.规格图回退.join('、')}`);
  }
  if (specImgs.length) {
    const done = await dp.uploadSpecImages(page, item.规格值, mats.规格图);
    log(`         规格图已上传: ${done.join('、')}`);
  }

  log('  [9/13] 填 SKU 价格/库存/商家编码');
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

  // 价格库存区的两组 radio。两者都靠标签文案定位，字段不存在时返回 null 不阻断。
  const ship = await dp.setShipTime(page, item.发货时效);
  log(`  [10/13] 现货发货时间: ${ship ?? '字段不存在，已跳过'}`);
  const deduct = await dp.setStockDeductMode(page, item.订单库存计数);
  log(`          订单库存计数: ${deduct ?? '字段不存在，已跳过'}`);

  if (item.尺码表模板) {
    log(`  [11/13] 尺码表模板: ${item.尺码表模板}`);
    await dp.applySizeTemplate(page, item.尺码表模板);
  }
  if (item.运费模板) {
    log(`  [12/13] 运费模板: ${item.运费模板}`);
    await dp.setFreightTemplate(page, item.运费模板);
  }
  const st = await dp.setShelfStatus(page, item.商品状态);
  log(`          商品状态: ${st}`);

  // draft 模式不跑「填写检查」：草稿本来就允许字段不齐（如水洗标/吊牌图这类
  // 本技能不负责上传的项），拿发布标准去卡草稿只会白白阻断。留给人工复核。
  if (opts.mode === 'publish') {
    log('  [13/13] 填写检查');
    const v = await dp.runValidation(page);
    if (v.count > 0) {
      return { ok: false, title, validation: v };
    }
    log('          校验通过，0 个错误');
    return { ok: true, title, validation: v };
  }

  log('  [13/13] draft 模式，跳过填写检查，直接保存草稿');
  return { ok: true, title, validation: null };
}
/**
 * 建立浏览器连接。
 *
 * 底层端口来源有三种：--port 显式指定、--launch 专用 profile、自动探测。
 * 无论哪种，最后都走同一条登录态检测 + 首页复用路径，行为一致。
 */
async function connect(opts) {
  if (opts.port) {
    const c = await connectBrowser(opts.port);
    if (!c) throw new Error(`指定的调试端口 ${opts.port} 连不上`);
    return { conn: c, port: c.port };
  }
  if (opts.launch) {
    // 落地页用后台首页而非登录页：已登录时它直接进工作台，未登录时抖店自己会
    // 重定向到登录页。这样「已登录」和「未登录」两条路都不需要用户先看到登录页。
    const r = await launchDedicated({ url: DOUDIAN_HOME });
    if (r.launched) {
      console.log(`已启动专用浏览器（profile: ${r.profile}，端口 ${r.port}）`);
    } else {
      console.log(`复用已在跑的专用浏览器（端口 ${r.port}）`);
    }
    return { conn: { port: r.port, cdp: r.cdp }, port: r.port };
  }
  const own = await findExistingDebugPort();
  const c = await connectBrowser(own ?? undefined);
  if (!c) {
    console.error(browserOpenHint());
    console.error('');
    console.error('若 web-access 的 cdp-proxy 正在占用调试终结点，先执行: pkill -f cdp-proxy.mjs');
    process.exit(1);
  }
  return { conn: c, port: c.port };
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

const SUCCESS_STATES = new Set(['已发布', '已存草稿']);

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

  if (opts.unknown.length) {
    console.error(`未知参数: ${opts.unknown.join('、')}`);
    process.exit(1);
  }
  if (!['draft', 'publish'].includes(opts.mode)) {
    console.error(`不支持的 mode: ${opts.mode}。仅支持 draft 或 publish。`);
    process.exit(1);
  }

  normalizeAssets(opts.plan, opts.root, opts.sku);
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

  // 品牌优先级：--brand > 「全局默认」Sheet > 对门的猫
  const brand = opts.brand || plan.defaults?.品牌 || '对门的猫';

  // 风格映射：{"款号": ["法式", "轻熟风"]}。
  // 不进 Excel，因为这个字段要看图定，判断属于 agent 而不是货盘。
  // 同时接 inline JSON 和文件路径：少量款写在命令行更顺手，款多了再落成文件。
  let styleMap = {};
  if (opts.styles) {
    const raw = opts.styles.trim();
    const inline = raw.startsWith('{');
    try {
      styleMap = JSON.parse(inline ? raw : fs.readFileSync(raw, 'utf-8'));
    } catch (e) {
      console.error(inline
        ? `--styles 的 JSON 解析失败: ${e.message}`
        : `--styles 文件读取失败: ${e.message}`);
      process.exit(1);
    }
    if (typeof styleMap !== 'object' || styleMap === null || Array.isArray(styleMap)) {
      console.error('--styles 内容必须是对象，形如 {"GZ0021": ["法式"]}');
      process.exit(1);
    }
    const bad = Object.entries(styleMap).filter(([, v]) => !Array.isArray(v));
    if (bad.length) {
      console.error(`--styles 里以下款号的值不是数组: ${bad.map(([k]) => k).join('、')}`);
      process.exit(1);
    }
    // 款号写错时静默不生效是最难查的，开跑前先对一下
    const codes = new Set(plan.items.map((i) => i.款号));
    const unknown = Object.keys(styleMap).filter((k) => !codes.has(k));
    if (unknown.length) {
      console.log(`⚠ --styles 里这些款号不在本次待处理货盘里，已忽略: ${unknown.join('、')}\n`);
    }
  }

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

  const { conn, port } = await connect(opts);

  // 上架前先确认登录态，否则会卡在登录页报一堆模糊的「等待超时」。
  // 已登录 → 直接继续，并保留首页标签页复用（避免一闪一关再开的体验问题）；
  // 未登录 → 打开登录页并轮询等待，用户登录完自动往下跑。
  let keptPage = null;
  {
    const timeoutMs = Number.parseInt(opts.loginTimeout ?? '', 10) > 0
      ? Number.parseInt(opts.loginTimeout, 10) * 1000
      : 300000;
    const st = await ensureLogin(conn, {
      wait: !opts.noWaitLogin,
      timeoutMs,
      keepPage: true,
      log: (m) => console.log(m),
    }).catch((e) => ({ loggedIn: false, 依据: `检测失败: ${e.message}` }));
    if (!st.loggedIn) {
      console.error('');
      console.error(st.timeout
        ? '等待登录超时，未做任何上架操作。请登录后重跑本命令。'
        : `未登录抖店（${st.依据 ?? '原因未知'}），未做任何上架操作。`);
      if (st.url) console.error(`当前页面: ${st.url}`);
      conn.cdp.close();
      process.exit(1);
    }
    keptPage = st.page ?? null;
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
      // 每款都走「工作台 → 站内跳转到发布页」。keptPage 在款与款之间持续复用，
      // 避免反复新开标签页直开 create（那种无 referer 的顶层导航行为特征差）。
      // 没有 keptPage 时，openOrAdoptPage 优先接管浏览器里已打开的工作台首页。
      page = await dp.openCreatePage((u) => openOrAdoptPage(u, { conn }), keptPage, log);
      keptPage = page;
      const r = await publishOne(page, item, { ...opts, brand, styleMap }, log);

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
      // 失败时保留标签页，便于人工在浏览器里查现场。
      if (page && failed) {
        const u = await page.url().catch(() => 'unknown');
        console.log(`  ⓘ 失败，标签页已保留供调试: ${u}`);
        keptPage = null; // 现场页不能再拿去跑下一款，下款重开干净标签
      }
      // 成功的标签页不在这里关：留给下一款回工作台复用，循环结束后统一收。
    }
    console.log('');
    await sleep(jitter(2500));
  }

  // 复用的工作标签页到这里才收（--keep-tab 则留给人工复核）。
  // 若这一页是接管用户已打开的工作台而来（owned=false），close() 不会动它，
  // 但得先退回工作台，别留一个填了半截内容的发布页给用户。
  if (keptPage && !opts.keepTab) {
    if (!keptPage.owned) await keptPage.safeNavigate(DOUDIAN_HOME).catch(() => {});
    await keptPage.close().catch(() => {});
    keptPage = null;
  }

  console.log('══ 汇总');
  for (const r of results) {
    console.log(`  ${r.款号}\t${r.状态}\t${r.标题 ?? r.详情 ?? ''}`);
  }
  const failed = results.filter((r) => !SUCCESS_STATES.has(r.状态));
  const succeeded = results.filter((r) => SUCCESS_STATES.has(r.状态));
  console.log(`\n总数 ${results.length}，成功 ${succeeded.length}，失败 ${failed.length}`);
  console.log(`状态文件: ${stateFile(opts.plan)}（重跑时加 --resume 可跳过已成功的款）`);

  if (opts.report) {
    const payload = {
      模板: path.resolve(opts.plan),
      模式: opts.mode,
      品牌: brand,
      时间: new Date().toISOString(),
      成功: succeeded.length,
      失败: failed.length,
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
