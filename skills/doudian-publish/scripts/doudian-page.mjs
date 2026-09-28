/**
 * 抖店商品发布页的交互原语。
 *
 * 所有选择器与操作序列都在 fxg.jinritemai.com/ffa/g/create 上实测通过。
 * 关键约束（踩坑记录，改动前先读 references/dom-notes.md）：
 *  1. ecom-g-select 下拉必须真实鼠标点击才展开；纯 el.click() 无效。
 *  2. 下拉选项要用 dispatchEvent 派发 mouseover/mousedown/mouseup/click，
 *     因为选项经常渲染在视口外，clickAt 的坐标会算成负数。
 *  3. 新建规格值是六步序列，缺一步就静默失败，详见 addSpecValue。
 *  4. 受控输入框必须走原生 value setter + input 事件。
 */
import { sleep, sleepExact, DOUDIAN_HOME } from './cdp.mjs';

/** 智能填写二次解析超时：平台解析 5~10s 是常态，但实测慢时远超，可环境变量调 */
const SMART_PARSE_TIMEOUT = Number(process.env.DOUDIAN_SMART_PARSE_TIMEOUT ?? 120000);
/** 单个规格值写入后的轮询上限：页面重建 SKU 表慢时 20s 不够，可环境变量调 */
const SPEC_WRITE_TIMEOUT = Number(process.env.DOUDIAN_SPEC_WRITE_TIMEOUT ?? 20000);

const CREATE_URL = 'https://fxg.jinritemai.com/ffa/g/create';

export { CREATE_URL };

/**
 * 等待下拉里真的出现可选项。
 *
 * 为何需要它：品牌 / 材质 / 运费模板 / 尺码表模板 这几个下拉的内容是
 * **服务端返回**的（搜索接口 / 模板列表接口），比本地渲染更不可控。
 * 早期写法是 `sleep(2500)` 后读一次，网络稍慢就报
 * 「品牌未找到」/「未找到模板，可选: 」—— 报错里可选项为空就是这个症状，
 * 它并不代表模板真的不存在。
 *
 * 成功时立即返回（比固定 sleep 更快），只有真的没加载出来才等到超时。
 *
 * @param match 可选：面板 className 需要匹配的正则源串（如 'auto-dropdown-id-品牌'）。
 *              页面上同时存在多个 dropdown 时用它区分。
 */
async function waitDropdownOptions(page, { match = null, label, timeoutMs = 20000 } = {}) {
  const cond = `
    const ds = [...document.querySelectorAll('.ecom-g-select-dropdown')]
      .filter(x => x.offsetParent)
      ${match ? `.filter(x => ${new RegExp(match).toString()}.test(x.className))` : ''};
    return ds.some(d => d.querySelectorAll('.ecom-g-select-item-option').length > 0);
  `;
  await page.waitFor(cond, { label, timeoutMs });
}

/** ---------- 第一步页：主图 + 标题 + 类目 ---------- */

/**
 * 定位工作台上的「商品创建」入口。单一来源，三处复用，避免选择器漂移。
 * 优先取文本恰好是「商品创建」的叶子节点，其次取 href 指向 create 的链接。
 */
const FIND_CREATE_ENTRY = `
  const hit = [...document.querySelectorAll('a, span, div, button')]
    .filter(x => x.offsetParent && x.children.length <= 2)
    .find(x => /^\\s*商品创建\\s*$/.test(x.innerText ?? ''))
    ?? [...document.querySelectorAll('a[href*="/ffa/g/create"]')]
      .find(x => x.offsetParent);
`;

/**
 * 把当前标签页弄到工作台。已经在工作台就不动（避免无用重载）。
 *
 * 已在发布页 / 其他后台页时也要回工作台，保证「工作台 → 发布页」这段
 * 路径每款都真实走一遍。
 */
async function gotoHomepage(page) {
  const cur = await page.url().catch(() => '');
  if (!cur.includes('/ffa/mshop/homepage')) {
    // 上一款的发布页可能已填了一堆内容，直接跳会弹「离开站点？」卡死浏览器，
    // 必须走 safeNavigate。
    await page.safeNavigate(DOUDIAN_HOME);
  }
  // 工作台也是 SPA，得等侧边菜单/入口渲染出来才能点
  await page.waitRendered({
    timeoutMs: 60000,
    readyExpr: `return /商品创建|商品管理|待办事项|工作台/.test(document.body?.innerText ?? '')`,
  }).catch(() => {});
  await sleep(800);
}

/**
 * 从工作台进发布页。三级降级，优先保留站内跳转特征：
 *
 *  1. 真实点击「商品创建」入口（最贴近真人）。入口可能开新标签页，
 *     所以先把 target=_blank 拆掉，让它在本标签页跳。
 *  2. 点不到就在页内用 location.assign 跳——仍然带 referer，仍算站内导航。
 *  3. 那也不行才用 CDP Page.navigate（无 referer，最后手段）。
 */
async function gotoCreateFromHome(page, log = () => {}) {
  const ready = await page.eval(`
    ${FIND_CREATE_ENTRY}
    if (!hit) return false;
    // 入口可能 target=_blank 或走 window.open；新标签页会让当前 CDP session
    // 指错对象（后续操作全打在工作台上），还会攒出孤儿标签。
    // 两手都按住，强制在本标签页完成跳转（仍是带 referer 的站内导航）。
    const a = hit.closest('a') ?? hit;
    if (a.tagName === 'A') a.removeAttribute('target');
    window.open = (u) => { if (u) location.assign(u); return null; };
    a.scrollIntoView({ block: 'center' });
    return true;
  `).catch(() => false);

  if (ready) {
    // 真实鼠标手势；拿不到坐标（入口在折叠菜单里）就退回 el.click()
    if (await clickCreateEntry(page)) {
      if (await waitUrl(page, '/ffa/g/create', 8000)) {
        await page.waitReady().catch(() => {});
        log('  → 工作台点「商品创建」进入发布页');
        return;
      }
    }
  }

  // 降级 2：页内 location.assign（带 referer 的站内导航）
  await page.disarmBeforeUnload().catch(() => {});
  await page.eval(`location.assign(${JSON.stringify(CREATE_URL)}); return true;`).catch(() => {});
  if (await waitUrl(page, '/ffa/g/create', 10000)) {
    await page.waitReady().catch(() => {});
    log('  → 入口点不到，已改用站内 location 跳转（选择器可能已变，建议跑 doctor）');
    return;
  }

  // 降级 3：CDP 直导
  log('  → 站内跳转失效，回退 CDP 直导（无 referer）');
  await page.safeNavigate(CREATE_URL);
}

/** 点「商品创建」入口：先试真实鼠标，不行就 el.click() */
async function clickCreateEntry(page) {
  const box = await page.eval(`
    ${FIND_CREATE_ENTRY}
    if (!hit) return null;
    const r = hit.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return null;
    const x = r.x + r.width / 2, y = r.y + r.height / 2;
    if (y < 0 || y > innerHeight || x < 0 || x > innerWidth) return { inView: false };
    return { inView: true, x, y };
  `).catch(() => null);

  if (box?.inView) {
    for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
      await page.cdp.send('Input.dispatchMouseEvent', {
        type, x: box.x, y: box.y, button: 'left',
        clickCount: type === 'mouseMoved' ? 0 : 1,
      }, page.sessionId).catch(() => {});
      await sleep(60);
    }
    return true;
  }

  return await page.eval(`
    ${FIND_CREATE_ENTRY}
    if (!hit) return false;
    (hit.closest('a') ?? hit).click();
    return true;
  `).catch(() => false);
}

/** 轮询等 URL 包含指定片段 */
async function waitUrl(page, fragment, timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const u = await page.url().catch(() => '');
    if (u.includes(fragment)) return true;
    await sleep(400);
  }
  return false;
}

/**
 * 从工作台站内跳转进发布页。
 *
 * 为什么不直接开 CREATE_URL：那样每款都是一次「凭空冒出来的」顶层导航，
 * 没有 referer、没有站内前序页面，行为特征和真人差得远。统一改成
 * 先落工作台（DOUDIAN_HOME），再从工作台点「商品创建」走站内跳转。
 *
 * @param openPage      拿工作台页的工厂函数 (url) => Page。
 *                      实际传的是 cdp.mjs 的 openOrAdoptPage：浏览器里已开着
 *                      工作台首页就接管那一页，否则才新开 tab。
 * @param existingPage  已在手上的页（如 probeLogin keepPage 返回的工作台页）→ 复用，不再开新标签
 */
export async function openCreatePage(openPage, existingPage, log = () => {}) {
  // 1. 先确保手上这一页停在工作台
  let page = existingPage;
  if (!page) {
    page = await openPage(DOUDIAN_HOME);
  }
  await gotoHomepage(page);

  // 2. 从工作台站内跳转进发布页
  await gotoCreateFromHome(page, log);
  // 先等 SPA 真正渲染。优先等待发布页语义控件，避免用固定文本长度误判。
  await page.waitRendered({
    timeoutMs: 60000,
    readyExpr: `return !!document.querySelector('input[type=file][accept="image/*"]')
      || !!document.querySelector('input[type=file][accept=".jpg,.png,.jpeg,.csv,.xls,.xlsx"]')
      || document.body?.innerText.includes('上传主图')
      || document.body?.innerText.includes('点击或拖拽文件到此处上传')`,
  });
  await page.waitFor(
    `return !!document.querySelector('div.material-preview-button input[type=file]')
         || !!document.querySelector('input[type=file][accept="image/*"]')
         || !!document.querySelector('input[type=file][accept=".jpg,.png,.jpeg,.csv,.xls,.xlsx"]')
         || document.body.innerText.includes('上传主图')
         || document.body.innerText.includes('点击或拖拽文件到此处上传')`,
    { label: '发布页资料上传控件', timeoutMs: 30000 },
  );
  return page;
}

/**
 * 兼容新版「智能填写助手」前置资料页。
 *
 * 新版直接访问 create 页先进入资料上传页，必须先上传至少一张商品图，
 * 再点「下一步，生成商品」；上传的首图会自动带入后续首图位。
 * 旧版没有这个资料页时返回 false，由调用方继续走旧流程。
 *
 * 新版资料页的「下一步，生成商品」按钮是异步挂载的：文件 input 先出现，
 * 按钮晚若干秒。一次性 eval 会把「还没挂载完」误判成「不是新版页面」，
 * 落到旧版路径后找不到 image/* input，报 file input 不存在。
 * 所以这里轮询等待，直到新版资料页或旧版首图表单二者之一真正挂载完成。
 */
export async function prepareSmartFill(page, file) {
  const probe = `
    return {
      smart: !!document.querySelector('input[type=file][accept=".jpg,.png,.jpeg,.csv,.xls,.xlsx"]')
        && !!(document.querySelector('button.styles-module_nextButton__Y91rv')
          || [...document.querySelectorAll('button')].find(
            b => b.offsetParent && b.innerText.trim() === '下一步，生成商品'
          )),
      legacy: !!document.querySelector('input[type=file][accept="image/*"]')
        || !!document.querySelector('div.material-upload-button input[type=file]'),
    };`;
  let landing = false;
  const deadline = Date.now() + 20000;
  for (;;) {
    const st = await page.eval(probe).catch(() => null);
    if (st?.smart) { landing = true; break; }
    // 旧版控件已挂载：确定不是新版资料页，立即交给调用方走旧流程
    if (st?.legacy) break;
    if (Date.now() > deadline) break;
    await sleep(800);
  }
  if (!landing) return false;

  await page.setFiles('input[type=file][accept=".jpg,.png,.jpeg,.csv,.xls,.xlsx"]', [file]);
  await page.waitFor(`
    const b = [...document.querySelectorAll('button')]
      .find(x => x.offsetParent && x.innerText.trim() === '下一步，生成商品');
    return !!b && !b.disabled;
  `, { label: '资料上传完成，可生成商品', timeoutMs: 90000 });

  const marked = await page.eval(`
    const b = document.querySelector('button.styles-module_nextButton__Y91rv')
      ?? [...document.querySelectorAll('button')]
        .find(x => x.offsetParent && x.innerText.trim() === '下一步，生成商品');
    if (!b) return false;
    b.setAttribute('data-dp', 'smart-next');
    b.scrollIntoView({ block: 'center' });
    return true;
  `);
  if (!marked) throw new Error('未找到「下一步，生成商品」按钮');
  await page.clickReal('[data-dp=smart-next]');

  await page.waitFor(`
    return [...document.querySelectorAll('button')].some(
      b => b.offsetParent && b.innerText.trim() === '确认信息，继续生成'
    );
  `, { label: '进入智能填写确认页', timeoutMs: 60000 });
  return true;
}

/** 上传首图（旧版流程；新版由 prepareSmartFill 自动带入） */
export async function uploadFirstImage(page, file) {
  await page.setFiles('input[type=file][accept="image/*"]', [file]);
  await page.waitFor(
    `return document.querySelectorAll('div.material-upload-button input[type=file]').length > 0`,
    { label: '首图上传完成', timeoutMs: 60000 },
  );
  await sleep(1500);
}

/**
 * 上传剩余主图（辅助图槽位，一次可传多张；兼容新旧首图页）。
 *
 * 2026-08-31 实测修正（覆盖上一版的错误结论）：新版的辅助图就应该在
 * **智能填写确认页**上传，而不是等进完整表单页。确认页的主图区就是
 * 「1 个首图槽 + 4 个上传辅助图」，上传后 5/5，点「确认信息，继续生成」
 * 跳转到完整表单后主图区仍是 5 张（已逐张比对 img src 验证，不会被丢弃）。
 * 好处是不需要任何 3:4 派生图：完整表单页里第二个上传区才是「主图3:4」，
 * 在那里传 1:1 图就变成了填 3:4 槽位。
 *
 * 主图区的定位不能再用「第一个含 5 个 file input 的 batchImageUpload」：
 * 完整表单页里「主图」与「主图3:4」两个区块都是 5 个 input，靠计数会搞错对象。
 * 改用祖先文案区分：主图区祖先含「主图」且**不含「3:4」/「白底图」**。
 */
export async function uploadExtraImages(page, files) {
  if (!files.length) return;
  // 主图区块的图片统计。靠祖先文案锁定区块，不靠 input 个数。
  //
  // 只数**已落到 CDN 的图**（src 不是 blob:/data:）。这一条是关键：
  // 平台在文件选完的瞬间就把槽位渲染出来，此时 img 已存在但还没上传完，
  // 单纯数 img 会让等待提前通过 —— 表现为「日志说传了 4 张，
  // 点确认跳转后主图区只剩 1 张」（2026-08-31 实测：src 从无到
  // png_m_xxx 约需 5s，期间 img 已挂载）。
  const blockStatExpr = `(() => {
    const blks = [...document.querySelectorAll('[class*=batchImageUpload]')]
      .filter(x => x.offsetParent && x.querySelectorAll('input[type=file]').length >= 5);
    const ctx = (b) => {
      let p = b, t = '';
      for (let k = 0; k < 6; k += 1) {
        p = p.parentElement; if (!p) break;
        const s = (p.innerText || '');
        if (s.length > 0 && s.length < 260) t = s;
      }
      return t;
    };
    // 主图区：祖先文案含「主图」且不含 3:4 / 白底图。确认页只有一个块，
    // 文案也命中（「*主图上传」）；两页同一套判据。
    const blk = blks.find(b => { const t = ctx(b); return /主图/.test(t) && !/3:4|白底图/.test(t); })
      ?? blks[0];
    if (!blk) return { total: 0, done: 0 };
    const imgs = [...blk.querySelectorAll('img')];
    const done = imgs.filter(i => {
      const s = i.src || '';
      return s && !s.startsWith('blob:') && !s.startsWith('data:');
    }).length;
    return { total: imgs.length, done };
  })()`;

  // 先等辅助图槽位渲染：确认页的「确认信息，继续生成」按钮比
  // material-upload-button 先挂载，上一版直接 setFiles 报过
  // 「file input 不存在: div.material-upload-button input[type=file]」。
  await page.waitFor(
    `return document.querySelectorAll('div.material-upload-button input[type=file]').length > 0`,
    { label: '辅助图槽位渲染', timeoutMs: 60000 },
  );

  const stat = async () => await page.eval(`return ${blockStatExpr}`).catch(() => ({ total: 0, done: 0 }));
  const before = (await stat()).done;
  const want = before + files.length;

  // setFiles 偶发静默不生效（实测出现过 input.files 仍为 0、页面毫无反应），
  // 所以整段「投文件 → 等上传完」做成可重试的，而不是投一次就死等。
  let lastDone = before;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    await page.setFiles('div.material-upload-button input[type=file]', files)
      .catch((e) => { if (attempt === 3) throw e; });

    // 等到「已落 CDN 的图片数」达标且连续 3 次采样不再变化（稳定即完成）。
    const deadline = Date.now() + 90000;
    let stable = 0;
    while (Date.now() < deadline) {
      await sleep(1500);
      const cur = await stat();
      lastDone = cur.done;
      if (cur.done >= want) {
        stable += 1;
        if (stable >= 3) {
          await sleep(1000);
          return cur.done;
        }
      } else {
        stable = 0;
      }
    }
    if (lastDone > before) break; // 有进展但没齐，交给调用方的补齐逻辑处理
  }
  if (lastDone <= before) {
    throw new Error(`等待超时: 辅助图上传完成（主图区已上传 ${lastDone} 张，期望 ${want} 张）`);
  }
  return lastDone;
}

/**
 * 读主图区已上传完成（落到 CDN）的图片数。
 * 供上传后二次核对用：跨页跳转后再确认一次，比只信上传时的等待更稳。
 */
export async function countMainImages(page) {
  return await page.eval(`
    const blks = [...document.querySelectorAll('[class*=batchImageUpload]')]
      .filter(x => x.offsetParent && x.querySelectorAll('input[type=file]').length >= 5);
    const ctx = (b) => {
      let p = b, t = '';
      for (let k = 0; k < 6; k += 1) {
        p = p.parentElement; if (!p) break;
        const s = (p.innerText || '');
        if (s.length > 0 && s.length < 260) t = s;
      }
      return t;
    };
    const blk = blks.find(b => { const t = ctx(b); return /主图/.test(t) && !/3:4|白底图/.test(t); })
      ?? blks[0];
    if (!blk) return 0;
    return [...blk.querySelectorAll('img')].filter(i => {
      const s = i.src || '';
      return s && !s.startsWith('blob:') && !s.startsWith('data:');
    }).length;
  `).catch(() => 0);
}

export async function fillTitle(page, title) {
  await page.setInput('input.ecom-g-input', title);
  await sleep(2000);
}

/** ---------- AI 标题（顺带自动填类目） ---------- */

/**
 * 标题输入框。第一步页只有这一个 ecom-g-input，
 * 但 AI 按钮的定位要以它的位置为基准，所以单独抽出来。
 */
const TITLE_INPUT_SEL = 'input.ecom-g-input';

/**
 * 生成「标记标题框右侧 AI 按钮」的页内 JS（打上 data-dp=ai-title）。
 *
 * 实测结构（已在真页面 dump 验过，不是猜的）：
 *   span.ecom-g-input-affix-wrapper.ecom-g-dropdown-trigger
 *     └─ input.ecom-g-input
 *     └─ span.ecom-g-input-suffix        ← 字数计数器 0/60 + AI 图标都在这里
 *          └─ span  「0/60」              28×16
 *          └─ img                        20×20，无 class，就是 AI 按钮
 *
 * 没有任何稳定类名可用（那个 img 连 class 都没有），所以主路径就是
 * 「在 input-suffix 容器内找 img」，而不是猜 CSS Modules 哈希。
 * suffix 容器也不在时才退到几何扫描（标题行右端的 14-30px img）。
 *
 * 返回值：'suffix' | 'geometry' | null
 */
export function aiTitleButtonExpr() {
  return `
    const input = document.querySelector(${JSON.stringify(TITLE_INPUT_SEL)});
    if (!input) return null;
    const ir = input.getBoundingClientRect();
    document.querySelectorAll('[data-dp=ai-title]')
      .forEach(e => e.removeAttribute('data-dp'));

    const okIcon = (e) => {
      if (!e.offsetParent) return false;
      const r = e.getBoundingClientRect();
      // AI 图标实测 20×20，跟标题框同一垂直带，且在输入框右侧
      return r.width >= 14 && r.width <= 30 && r.height >= 14 && r.height <= 30
        && r.top >= ir.top - 12 && r.bottom <= ir.bottom + 12
        && r.left >= ir.right - 8;
    };

    // 主路径：input-suffix 容器内的 img。计数器是 span，不会误取。
    const suffix = [...document.querySelectorAll('.ecom-g-input-suffix')]
      .find(s => {
        const r = s.getBoundingClientRect();
        return s.offsetParent && r.top >= ir.top - 12 && r.bottom <= ir.bottom + 12;
      });
    if (suffix) {
      const img = [...suffix.querySelectorAll('img,svg')].find(okIcon);
      if (img) { img.setAttribute('data-dp', 'ai-title'); return 'suffix'; }
    }

    // 兜底：整页扫标题行右端的小图标，取最右那个
    const cands = [...document.querySelectorAll('img,svg')].filter(okIcon)
      .sort((a, b) => b.getBoundingClientRect().left - a.getBoundingClientRect().left);
    if (!cands.length) return null;
    cands[0].setAttribute('data-dp', 'ai-title');
    return 'geometry';
  `;
}

/** 标记标题框右侧的 AI 按钮，打上 data-dp=ai-title 供 clickReal 用。 */
async function markAiTitleButton(page) {
  return page.eval(aiTitleButtonExpr()).catch(() => null);
}

/**
 * 生成「标记 AI 推荐列表第一条」的页内 JS（打上 data-dp=ai-option）。
 *
 * 实测结构：点 AI 图标后弹出的是标准 ecom-g-dropdown：
 *   div.ecom-g-dropdown
 *     └─ ul.ecom-g-dropdown-menu
 *          └─ li.ecom-g-dropdown-menu-item   ← 每条推荐标题（一般 2 条）
 *          └─ button「重新生成」
 *
 * 注意页面上另有一个长得很像的「标题推荐：…… 立即使用」行（predictContentWrapper，
 * 不点 AI 也存在）。它不是 AI 弹层，只有一条、且需要点「立即使用」链接。
 * 靠限定在 dropdown-menu 内查找排除它，否则会点错对象
 * （踩过：几何扫描会把这行当成第一条推荐）。
 *
 * 返回值：第一条推荐的文案，未出现则 null
 */
export function firstAiOptionExpr() {
  return `
    const input = document.querySelector(${JSON.stringify(TITLE_INPUT_SEL)});
    if (!input) return null;
    const ir = input.getBoundingClientRect();
    document.querySelectorAll('[data-dp=ai-option]')
      .forEach(e => e.removeAttribute('data-dp'));

    const looksLikeTitle = (t) => {
      const s = (t ?? '').trim();
      if (s.length < 8 || s.length > 80) return false;
      if (s.includes('\\n')) return false;
      // 弹层底部的「重新生成」之类按钮不是推荐项
      if (/重新生成|帮我生成|立即使用|标题推荐|收起|展开/.test(s)) return false;
      return true;
    };

    // 只认标题框下方的那个下拉菜单（页面上可能同时存在其他 dropdown）
    const menu = [...document.querySelectorAll('.ecom-g-dropdown-menu')]
      .filter(m => m.offsetParent)
      .find(m => {
        const r = m.getBoundingClientRect();
        return r.top > ir.bottom - 20 && r.top < ir.bottom + 200 && r.width > ir.width * 0.5;
      });
    if (!menu) return null;

    const items = [...menu.querySelectorAll('.ecom-g-dropdown-menu-item')]
      .filter(e => e.offsetParent && looksLikeTitle(e.innerText))
      .sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top);
    if (!items.length) return null;

    items[0].setAttribute('data-dp', 'ai-option');
    return items[0].innerText.trim();
  `;
}

/** 标记 AI 推荐列表的第一条 */
async function markFirstAiOption(page) {
  return page.eval(firstAiOptionExpr()).catch(() => null);
}

/** 读第一步页当前已选的类目文案。没选中时返回空串。 */
export async function readSelectedCategory(page) {
  return page.eval(`
    const t = document.body?.innerText ?? '';
    const i = t.indexOf('已选');
    if (i >= 0) {
      const seg = t.slice(i + 2, i + 80).split('\\n').find(x => x.trim());
      if (seg && seg.includes('>')) return seg.trim();
    }
    // 没有「已选」前缀时，找页面上形如 A > B > C 的类目路径文案
    const path = [...document.querySelectorAll('div,span')]
      .filter(e => e.offsetParent && e.children.length <= 2)
      .map(e => (e.innerText ?? '').trim())
      .find(x => /^[^\\n]{2,60}(\\s*>\\s*[^\\n]{1,20}){1,5}$/.test(x));
    return path ?? '';
  `).catch(() => '');
}

/**
 * 点标题框右侧的 AI 按钮 → 选第一条推荐标题 → 等平台自动填充类目。
 *
 * 这是当前的主路径：AI 推荐标题被平台用来推断类目，选中后类目自动带出，
 * 比自己逐级点类目稳且快。任一环节不成立就返回 null，
 * 由调用方回退到「手填标题 + 手动选类目」的老流程（不抛错、不中断批量）。
 *
 * 注意 AI 按钮要真实鼠标点击 —— 和页面上其他 ecom-g / aurora 控件一样，
 * 纯 el.click() 大概率不触发。
 *
 * @returns {{ title: string, category: string, via: string }|null}
 */
export async function aiTitleAndCategory(page, { timeoutMs = 25000, retries = 1 } = {}) {
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    // eslint-disable-next-line no-await-in-loop
    const r = await aiTitleOnce(page, timeoutMs);
    if (r) return r;
    // 实测：连续快跑时推荐接口偶尔不返回（3 次里赶上 1 次）。
    // 重试一次就能接住，不必直接回退到老流程。
    // eslint-disable-next-line no-await-in-loop
    if (attempt < retries) await sleep(2500);
  }
  return null;
}

/** 单次尝试：点 AI → 选第一条 → 等类目。任一环节不成立返回 null。 */
async function aiTitleOnce(page, timeoutMs) {
  // 上传主图后平台可能自动弹 AI 素材工具抽屉，它会遮住标题行
  await dismissModals(page);

  const via = await markAiTitleButton(page);
  if (!via) return null;

  await page.clickReal('[data-dp=ai-title]').catch(() => {});
  await sleep(1500);

  // 推荐列表是异步请求回来的，轮询等它出现
  let optionText = null;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    optionText = await markFirstAiOption(page);
    if (optionText) break;
    await sleep(700);
  }
  if (!optionText) return null;

  await page.clickReal('[data-dp=ai-option]').catch(() => {});
  await sleep(1200);

  // 选中判据：标题框的值变成了那条推荐文案（允许平台做截断）
  const applied = await page.waitFor(`
    const el = document.querySelector(${JSON.stringify(TITLE_INPUT_SEL)});
    const v = (el?.value ?? '').trim();
    if (!v) return false;
    const want = ${JSON.stringify(optionText)};
    return v === want || want.startsWith(v.slice(0, 8));
  `, { label: 'AI 标题写入标题框', timeoutMs: 8000 }).catch(() => false);
  if (!applied) return null;

  const title = await page.eval(`
    const el = document.querySelector(${JSON.stringify(TITLE_INPUT_SEL)});
    return (el?.value ?? '').trim();
  `).catch(() => optionText);

  // 类目由平台异步填充，等它出现；等不到就算这条路走通了一半，仍回退
  let category = '';
  const catDeadline = Date.now() + 15000;
  while (Date.now() < catDeadline) {
    category = await readSelectedCategory(page);
    if (category) break;
    await sleep(800);
  }
  if (!category) return null;

  return { title: title || optionText, category, via };
}

/**
 * 选类目。优先命中「最近创建」快捷项（一次点击直达），
 * 否则在全部类目里逐级点击。
 */
export async function selectCategory(page, categoryPath) {
  const leaf = categoryPath[categoryPath.length - 1];

  await page.eval(`
    const s = [...document.querySelectorAll('span')]
      .find(e => e.children.length === 0 && e.innerText.trim() === '手动选择类目');
    if (s) s.click();
    return !!s;
  `);
  await sleep(2500);

  // 快捷路径：最近创建里已有该末级类目
  const viaHistory = await page.eval(`
    const e = [...document.querySelectorAll('div.style_searchHistoryItems__FdSkW')]
      .find(x => x.innerText.includes(${JSON.stringify(leaf)}));
    if (!e) return false;
    e.click();
    return true;
  `);

  if (!viaHistory) {
    for (const seg of categoryPath) {
      const hit = await page.eval(`
        const els = [...document.querySelectorAll('li,div,span')]
          .filter(e => e.children.length === 0 && e.innerText.trim() === ${JSON.stringify(seg)});
        if (!els.length) return false;
        els[els.length - 1].click();
        return true;
      `);
      if (!hit) throw new Error(`类目层级未找到: ${seg}`);
      await sleep(1500);
    }
  }
  await sleep(1500);

  const selected = await page.eval(`
    const t = document.body.innerText;
    const i = t.indexOf('已选');
    return i > 0 ? t.slice(i, i + 60) : '';
  `);

  await page.eval(`
    const b = [...document.querySelectorAll('button')].find(x => x.innerText.trim() === '确认');
    if (b) b.click();
    return !!b;
  `);
  await sleep(2500);
  return selected;
}

/**
 * 进入完整详情表单页。
 *
 * 旧版按钮文案是「下一步」；新版智能填写流程先等待 AI 预填完成，
 * 再点击「确认信息，继续生成」，随后还会进行一次 5～10 秒的二次解析。
 * 两条路径都保留，便于兼容旧页面或回退场景。
 *
 * @returns {{smart: boolean, title?: string, category?: string}}
 */
export async function gotoStepTwo(page) {
  const smart = await page.eval(`
    const b = document.querySelector('button.style_aiPublishButton__DLNg7')
      ?? [...document.querySelectorAll('button')]
        .find(x => x.offsetParent && x.innerText.trim() === '确认信息，继续生成');
    if (!b) return null;
    const title = document.querySelector('input.ecom-g-input')?.value?.trim() ?? '';
    const text = document.body?.innerText ?? '';
    const category = text.match(/服装\\s*>\\s*[^\\n]{2,80}/)?.[0]?.trim() ?? '';
    b.setAttribute('data-dp', 'smart-confirm');
    b.scrollIntoView({ block: 'center' });
    return { title, category };
  `).catch(() => null);

  if (smart) {
    await page.waitFor(`
      const b = document.querySelector('[data-dp=smart-confirm]');
      return !!b && !b.disabled;
    `, { label: '智能填写预填完成', timeoutMs: 90000 });
    const info = await page.eval(`
      const title = document.querySelector('input.ecom-g-input')?.value?.trim() ?? '';
      const text = document.body?.innerText ?? '';
      const category = text.match(/服装\\s*>\\s*[^\\n]{2,80}/)?.[0]?.trim() ?? '';
      return { title, category };
    `).catch(() => ({ title: '', category: '' }));
    await sleep(500);
    await page.clickReal('[data-dp=smart-confirm]');
    await page.waitFor(`
      const t = document.body?.innerText ?? '';
      // 2026-08-30 实测：平台文案把「商品详情图」改成了「详情图片」，两者任一出现即可
      const hasDetail = t.includes('商品详情图') || t.includes('详情图片');
      return hasDetail && t.includes('价格库存')
        && !t.includes('继续解析你上传的材料');
    `, { label: '完成 AI 解析并进入详情表单', timeoutMs: SMART_PARSE_TIMEOUT });
    await sleep(2000);
    return { smart: true, ...info };
  }

  const marked = await page.eval(`
    const b = [...document.querySelectorAll('button')]
      .find(x => x.offsetParent && x.innerText.trim() === '下一步');
    if (!b) return false;
    b.setAttribute('data-dp', 'next');
    b.scrollIntoView({ block: 'center' });
    return true;
  `);
  if (!marked) throw new Error('未找到「下一步」或「确认信息，继续生成」按钮');
  await sleep(500);
  await page.clickReal('[data-dp=next]');
  await sleep(1500);

  const advanced = await page.eval(`return document.body.innerText.includes('类目属性')`);
  if (!advanced) {
    // 兜底：真实点击没生效时再试一次 JS click
    await page.eval(`
      const b = document.querySelector('[data-dp=next]');
      if (b) b.click();
      return !!b;
    `);
  }

  await page.waitFor(`return document.body.innerText.includes('类目属性')`, {
    label: '进入详情表单页', timeoutMs: 60000,
  });
  await sleep(2000);
  return { smart: false };
}

/** ---------- 第二步页：属性 ---------- */

/**
 * 面料材质：aurora composition-select，材质 + 含量两段。
 *
 * 展开的坑（踩过四次）：不能点 `input.aurora-select-input` —— 它是 aurora-select 内部的
 * 隐藏搜索框，实测宽度只有 4px，按它的中心点发鼠标事件不会展开下拉，
 * 表现为「等待超时: 材质搜索框」。必须点外层可见容器
 * `.aurora-dorami-composition-select-select`（**不是 -wrapper**，wrapper 在 DOM 里排前面，
 * 早期版本按 DOM 顺序取到它，点击间歇性不生效），且必须真实鼠标点击。
 * 单次点击仍会偶发丢失，所以下面用「点击 → 等搜索框 → 没出现就重点」的重试循环。
 *
 * 2026-08-31 实测修复——**必须先清预填值**：新版智能填写会自己填一个材质
 * （实测填了「新型聚酯纤维」且**不带含量**）。直接追加自己的「聚酯纤维 100%」
 * 会变成两条并存，平台报两条错：「该项为必填，请输入」+「含量必须全填写或
 * 全不填写，且材质不能重复」（且两者还同属聚酯纤维系）。预填项的删除入口是
 * `.aurora-select-selection-item-remove`，纯 JS click 即可生效。
 */
export async function setFabric(page, pairs) {
  // 上传主图后抖店可能自动弹出 AI素材工具 抽屉，先关闭再操作属性控件。
  await dismissModals(page);
  await sleep(500);
  await page.waitFor(
    `return !![...document.querySelectorAll('.aurora-dorami-composition-select-select, .aurora-dorami-composition-select-wrapper')]
      .find(x => x.offsetParent && x.getBoundingClientRect().width > 20)`,
    { label: '面料材质控件渲染', timeoutMs: 30000 },
  );

  // 先清掷智能填写预填的材质项（可能多条，每删一条 DOM 重建，所以逐次删到空）。
  // 不清就会与下面追加的值并存，触发「含量必须全填写或全不填写，且材质不能重复」。
  for (let i = 0; i < 8; i += 1) {
    const removed = await page.eval(`
      const w = [...document.querySelectorAll('.aurora-dorami-composition-select-wrapper')]
        .find(x => x.offsetParent);
      if (!w) return null;
      const item = w.querySelector('.aurora-select-selection-item');
      if (!item) return null;
      const txt = (item.innerText || '').trim();
      const rm = item.querySelector('.aurora-select-selection-item-remove');
      if (!rm) return null;
      rm.click();
      return txt;
    `).catch(() => null);
    if (!removed) break;
    await sleep(600);
  }

  // 弹层里的材质搜索框是否已就绪
  const SEARCH_EXPR = `[...document.querySelectorAll('input.aurora-dorami-composition-select-search, input[placeholder="搜索材质"], input[placeholder="请输入"]')]
    .find(x => x.offsetParent && !x.matches('[data-dp=fabric]') &&
      (x.closest('[role="dialog"], [role="listbox"], [class*=popup], [class*=dropdown], [class*=composition]') ||
       x.className.includes('composition')))`;

  // 点开材质下拉。两种策略交替重试：真实鼠标点击（历史上有效但偶发不生效）
  // 与向 `.aurora-select-content` 派发 mouseover/mousedown/mouseup/click（实测稳定生效）。
  // 单靠其中一种都出现过「等待超时: 材质搜索框」。
  const ensureOpen = async () => {
    if (await page.eval(`return !!${SEARCH_EXPR}`)) return;
    for (let attempt = 1; attempt <= 4; attempt += 1) {
      const marked = await page.eval(`
        const el = [...document.querySelectorAll('.aurora-dorami-composition-select-select')]
            .find(x => x.offsetParent && x.getBoundingClientRect().width > 20)
          ?? [...document.querySelectorAll('.aurora-dorami-composition-select-wrapper')]
            .find(x => x.offsetParent && x.getBoundingClientRect().width > 20);
        if (!el) return false;
        el.setAttribute('data-dp', 'fabric');
        el.scrollIntoView({ block: 'center' });
        return true;
      `);
      if (!marked) throw new Error('未找到面料材质控件');
      await sleep(800);

      if (attempt % 2 === 1) {
        await page.clickReal('[data-dp=fabric]');
      } else {
        await page.eval(`
          const el = document.querySelector('[data-dp=fabric]');
          if (!el) return false;
          const target = el.querySelector('.aurora-select-content') || el;
          for (const ty of ['mouseover', 'mousedown', 'mouseup', 'click']) {
            target.dispatchEvent(new MouseEvent(ty, { bubbles: true, cancelable: true, view: window }));
          }
          return true;
        `);
      }

      for (let waited = 0; waited < 6000; waited += 500) {
        await sleep(500);
        if (await page.eval(`return !!${SEARCH_EXPR}`)) return;
      }
    }
    throw new Error('等待超时: 材质搜索框（真实点击与 JS 派发各试 2 次后下拉仍未展开）');
  };

  await ensureOpen();

  for (const [name, pct] of pairs) {
    await ensureOpen();
    await page.eval(`
      const i = ${SEARCH_EXPR};
      if (!i) return false;
      const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      i.focus(); set.call(i, ${JSON.stringify(name)});
      i.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    `);
    // 材质候选是服务端搜索返回的；固定 sleep 后读会误报「面料材质未找到候选」。
    // 这里等到弹层里真的出现选项为止（搜索后候选列表会重建）。
    await page.waitFor(
      `const d = [...document.querySelectorAll('.aurora-dorami-composition-select-dropdown, [role="dialog"]')]
         .filter(x => x.offsetParent)
         .find(x => x.querySelector('[class*=option-label], [role="option"]'));
       return !!d && d.querySelectorAll('[class*=option-label], [role="option"]').length > 0;`,
      { label: `材质候选列表（${name}）`, timeoutMs: 20000 },
    );

    const picked = await page.eval(`
      const d = [...document.querySelectorAll('.aurora-dorami-composition-select-dropdown, .aurora-dorami-composition-select-select-popup, [role="dialog"]')]
        .filter(x => x.offsetParent)
        .find(x => x.querySelector('input[placeholder="搜索材质"], input[placeholder="请输入"], [class*=option-label], [role="option"]'));
      if (!d) return null;
      const opts = [...d.querySelectorAll('[class*=option-label], [role="option"]')];
      const exact = opts.find(o => o.textContent.trim() === ${JSON.stringify(name)});
      const target = exact || opts[0];
      if (!target) return null;
      target.click();
      return target.textContent.trim();
    `);
    if (!picked) throw new Error(`面料材质未找到候选: ${name}`);
    await sleep(1500);

    await page.eval(`
      const d = [...document.querySelectorAll('.aurora-dorami-composition-select-dropdown, .aurora-dorami-composition-select-select-popup, [role="dialog"]')]
        .filter(x => x.offsetParent)
        .find(x => x.querySelector('input[placeholder="搜索材质"], input[placeholder="请输入"], [class*=option-label], [role="option"]'));
      if (!d) return false;
      const i = [...d.querySelectorAll('input')].find(x => x.placeholder === '请输入' && !x.value);
      if (!i) return false;
      const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      i.focus(); set.call(i, ${JSON.stringify(String(pct))});
      i.dispatchEvent(new Event('input', { bubbles: true }));
      i.dispatchEvent(new Event('blur', { bubbles: true }));
      return true;
    `);
    await sleep(1200);
  }

  await page.evalExpr('document.body.click()');
  await sleep(500);
  // 材质 AI 工具抽屉可能仍覆盖完整表单；必须关闭后再操作品牌等控件。
  await dismissModals(page);
  await sleep(1000);
  return await page.eval(`
    const t = document.body.innerText;
    const i = t.indexOf('面料材质');
    return t.slice(i, i + 40).split('\\n').slice(1, 2).join('');
  `);
}

/**
 * 品牌：`ecom-g-select`，先输入再选。无品牌时传 '无品牌'。
 *
 * 2026-08-31 实测修复：**不能靠 placeholder「请输入需要关联的品牌」定位**。
 * 新版智能填写会把品牌预填成「无品牌」，此时控件已有选中值、placeholder 消失，
 * 老选择器一个都匹配不到 → setBrand 静默什么都没做，接着卡在
 * 「等待超时: 品牌搜索结果」。改用「品牌」标签的兄弟容器定位（同 setComboCount /
 * setAgeRange 那套结构不变量），预填与空白两种状态都命中。
 *
 * 展开也必须走 clickReal：已有选中值时纯 JS 写 input.value 不触发服务端搜索，
 * 下拉永远不出现（通用坑位 1）。
 */
export async function setBrand(page, brand = '无品牌') {
  const marked = await page.eval(`
    document.querySelectorAll('[data-dp=brand]').forEach(e => e.removeAttribute('data-dp'));
    const leaf = [...document.querySelectorAll('span,div,label')]
      .find(x => x.offsetParent && x.children.length === 0 && (x.innerText || '').trim() === '品牌');
    if (!leaf) return false;
    let p = leaf;
    for (let k = 0; k < 8; k += 1) {
      p = p.parentElement;
      if (!p) break;
      const sel = p.nextElementSibling?.querySelector('.ecom-g-select');
      if (sel) {
        sel.setAttribute('data-dp', 'brand');
        sel.scrollIntoView({ block: 'center' });
        return (sel.innerText || '').trim();
      }
    }
    return false;
  `);
  if (marked === false) throw new Error('未找到品牌控件');
  // 已是目标品牌就不动（幂等，少一次无谓的服务端搜索）
  if (typeof marked === 'string' && marked === brand) {
    await sleep(500);
    return;
  }

  await page.clickReal('[data-dp=brand]');
  await sleep(1200);
  await page.eval(`
    const s = document.querySelector('[data-dp=brand]');
    const i = s?.querySelector('input');
    if (!i) return false;
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    i.focus(); set.call(i, ${JSON.stringify(brand)});
    i.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  `);
  // 品牌列表是服务端搜索返回的；固定 sleep 后读一次，网络稍慢就误报「品牌未找到」
  await waitDropdownOptions(page, {
    match: 'auto-dropdown-id-品牌',
    label: `品牌搜索结果（${brand}）`,
  });

  const ok = await page.eval(`
    const d = [...document.querySelectorAll('.ecom-g-select-dropdown')]
      .find(x => /auto-dropdown-id-品牌/.test(x.className));
    if (!d) return false;
    const opts = [...d.querySelectorAll('.ecom-g-select-item-option')];
    const exact = opts.find(o => o.innerText.trim() === ${JSON.stringify(brand)});
    const target = exact || opts[0];
    if (!target) return false;
    ['mouseover','mousedown','mouseup','click'].forEach(t =>
      target.dispatchEvent(new MouseEvent(t, { bubbles: true, cancelable: true, view: window })));
    return true;
  `);
  if (!ok) throw new Error(`品牌未找到: ${brand}`);
  await sleep(2000);
}

/**
 * 风格：`ecom-g-tree-select` 多选，最多 5 项。
 *
 * 与品牌那种 `ecom-g-select` 不同的三点（都是实测踩出来的）：
 *  1. 选项是 tree 节点（`.ecom-g-select-tree-title`），**不是** `.ecom-g-select-item-option`，
 *     拿老选择器去找会永远为空。
 *  2. 选项列表是**虚拟滚动**（实测 scrollHeight 1366 / clientHeight 256，50 个风格里
 *     一屏只挂 10-12 个节点）。所以不要滚动扫全表去找目标，而是用 select 内的
 *     搜索框过滤 —— 输入后列表只剩命中项，一次就够。
 *  3. 勾选要打在 `.ecom-g-select-tree-checkbox` 上并派发
 *     mouseover/mousedown/mouseup/click，跟尺码面板同一个坑。
 *
 * 平台可选值**随类目变化**（女装套装实测 50 项，童装/鞋靴又是另一套），
 * 所以不在任何地方维护硬编码清单。传了当前类目没有的值只警告不抛错
 *（风格是非必填属性，缺了只影响商品质量分，不该让整款上架失败），
 * 并且会把该类目实际可选项一并回报（`该类目可选`），下次改啥一目了然。
 */
export function styleSelectExpr() {
  return `
    document.querySelectorAll('[data-dp=style]').forEach(e => e.removeAttribute('data-dp'));
    const leaf = [...document.querySelectorAll('span,div,label')]
      .find(x => x.offsetParent && x.children.length === 0 && (x.innerText || '').trim() === '风格');
    if (!leaf) return null;
    // 标签与控件是兄弟关系（标签容器 style 里带 width: 110px）。
    // 逐层上溯找「nextElementSibling 里有 select」的那一层，比写死层数抗改版。
    let p = leaf;
    for (let k = 0; k < 8; k += 1) {
      p = p.parentElement;
      if (!p) break;
      const sel = p.nextElementSibling?.querySelector(
        '.ecom-g-tree-select, .styles_multiSelect__Nmxaq, .ecom-g-select');
      if (sel) {
        sel.setAttribute('data-dp', 'style');
        sel.scrollIntoView({ block: 'center' });
        return sel.className;
      }
    }
    return null;
  `;
}

/** 在已展开的风格面板里勾选一个值。返回 'clicked' | 'already' | null（面板里没这个值） */
export function styleOptionExpr(name) {
  return `
    const d = [...document.querySelectorAll('.ecom-g-tree-select-dropdown')]
      .filter(x => x.offsetParent && !/-hidden|-leave/.test(x.className))[0];
    if (!d) return { error: '风格下拉未展开' };
    const node = [...d.querySelectorAll('.ecom-g-select-tree-treenode')].find(n => {
      const t = n.querySelector('.ecom-g-select-tree-title');
      return t && (t.innerText || '').trim() === ${JSON.stringify(name)};
    });
    if (!node) return { missing: true };
    if (/-checked/.test(node.querySelector('.ecom-g-select-tree-checkbox')?.className ?? '')) {
      return { state: 'already' };
    }
    // checkbox 优先；没有就退到整行内容容器（不同类目模板略有差异）
    const target = node.querySelector('.ecom-g-select-tree-checkbox')
      ?? node.querySelector('.ecom-g-select-tree-node-content-wrapper');
    if (!target) return { error: '风格选项无可点击目标' };
    ['mouseover', 'mousedown', 'mouseup', 'click'].forEach(t =>
      target.dispatchEvent(new MouseEvent(t, { bubbles: true, cancelable: true, view: window })));
    return { state: 'clicked' };
  `;
}

const STYLE_MAX = 5;

/**
 * 收集风格候选全集：打开风格下拉，虚拟滚动收集当前类目全部可选项后收起。
 *
 * 用运行时事实替代文档快照：平台选项集会变，页面上拿到的才是「当前支持」。
 * 交互约束与 setStyles 同源（真实点击展开、收集前清搜索词、收尾清词+收起），
 * 详见 dom-notes.md「风格」节。收集失败返回 { 存在: false }，不阻断。
 */
export async function getStyleCandidates(page) {
  const cls = await page.eval(styleSelectExpr());
  if (!cls) return { 存在: false, 可选: [] };
  await sleep(600);

  const isOpen = () => page.eval(`
    const s = document.querySelector('[data-dp=style]');
    return !!s && /ecom-g-select-open/.test(s.className);
  `).catch(() => false);

  let opened = false;
  for (let i = 0; i < 3 && !opened; i += 1) {
    await page.clickReal('[data-dp=style]').catch(() => {});
    for (let waited = 0; waited < 3000; waited += 400) {
      await sleep(400);
      if (await isOpen()) { opened = true; break; }
    }
  }
  if (!opened) return { 存在: false, 可选: [] };

  const options = await collectOptions(page);

  // 收尾：清搜索词 + 收起面板（同 setStyles，残留过滤词会挡住后续字段）
  await page.eval(`
    const s = document.querySelector('[data-dp=style]');
    const i = s?.querySelector('input.ecom-g-select-selection-search-input');
    if (i) {
      const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      set.call(i, '');
      i.dispatchEvent(new Event('input', { bubbles: true }));
      i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    }
    document.body.click();
    return true;
  `).catch(() => {});
  await sleep(1000);
  return { 存在: options.length > 0, 可选: options };
}

export async function setStyles(page, styles) {
  const want = (styles ?? []).filter(Boolean);
  if (!want.length) return { 已选: [], 未找到: [], 超限: [] };

  const over = want.slice(STYLE_MAX);
  const pick = want.slice(0, STYLE_MAX);

  const cls = await page.eval(styleSelectExpr());
  if (!cls) throw new Error('未找到「风格」选择器');
  await sleep(600);

  const isOpen = async () => page.eval(`
    const s = document.querySelector('[data-dp=style]');
    return !!s && /ecom-g-select-open/.test(s.className);
  `).catch(() => false);

  // 与其他 ecom-g 控件一样，必须真实鼠标点击才展开
  const ensureOpen = async () => {
    if (await isOpen()) return;
    for (let i = 0; i < 3; i += 1) {
      await page.clickReal('[data-dp=style]').catch(() => {});
      for (let waited = 0; waited < 3000; waited += 400) {
        await sleep(400);
        if (await isOpen()) return;
      }
    }
    throw new Error('等待超时: 风格下拉未展开');
  };

  const done = [];
  const missing = [];
  for (const name of pick) {
    await ensureOpen();
    // 列表是虚拟滚动的，只有搜过滤后目标节点才一定挂在 DOM 里
    await page.eval(`
      const s = document.querySelector('[data-dp=style]');
      const i = s?.querySelector('input.ecom-g-select-selection-search-input');
      if (!i) return false;
      const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      i.focus(); set.call(i, ${JSON.stringify(name)});
      i.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    `);
    await sleep(1200);

    const r = await page.eval(styleOptionExpr(name));
    if (r?.missing) {
      missing.push(name);
    } else if (r?.error) {
      throw new Error(`${r.error}（风格: ${name}）`);
    } else {
      done.push(name);
    }
    await sleep(800);
  }

  // 清掉搜索词并收起面板，否则残留的过滤词会挡住后续字段的可见性判断。
  // 有没命中的值时多做一件事：把该类目实际可选项收集下来。
  // 否则只说「未找到 X」，人还得自己去后台翻才知道该改成什么。
  const availableWhenMissing = missing.length ? await collectOptions(page) : [];

  await page.eval(`
    const s = document.querySelector('[data-dp=style]');
    const i = s?.querySelector('input.ecom-g-select-selection-search-input');
    if (i) {
      const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      set.call(i, '');
      i.dispatchEvent(new Event('input', { bubbles: true }));
      i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    }
    document.body.click();
    return true;
  `).catch(() => {});
  await sleep(1000);

  const applied = await page.eval(`
    const s = document.querySelector('[data-dp=style]');
    if (!s) return [];
    return [...s.querySelectorAll('.ecom-g-select-selection-item')]
      .map(x => (x.innerText || '').trim()).filter(Boolean);
  `).catch(() => []);

  return {
    已选: applied.length ? applied : done,
    未找到: missing,
    超限: over,
    该类目可选: availableWhenMissing,
  };
}

/**
 * 收集风格下拉里的全量选项（面板已展开、搜索词已清空时调用）。
 *
 * 只在有值未命中时跑 —— 它是报错信息的一部分，不是常规路径。
 * 正常情况下 `setStyles` 靠搜索框一步命中，不需要知道全集。
 *
 * 列表是虚拟滚动的（实测 scrollHeight 1366 / clientHeight 256，50 项里一屏只挂 10-12 个），
 * 所以必须逐屏滚。步长取可视高度的一部分让相邻两屏有重叠，否则会漏中间的项。
 * 终止看 `holder.scrollTop` 的**实际值**：写超上限会被浏览器默默夹取，
 * 拿未夹取的请求值判终止会在没到底时就退出（跟 SKU 表那个坑同源）。
 */
async function collectOptions(page) {
  // 先把搜索词清掉，否则读到的是上一个关键词的过滤结果
  await page.eval(`
    const s = document.querySelector('[data-dp=style]');
    const i = s?.querySelector('input.ecom-g-select-selection-search-input');
    if (i) {
      const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      i.focus(); set.call(i, '');
      i.dispatchEvent(new Event('input', { bubbles: true }));
    }
    return true;
  `).catch(() => {});
  await sleep(1000);

  const readWindow = async (scrollTo) => page.eval(`
    const d = [...document.querySelectorAll('.ecom-g-tree-select-dropdown')]
      .filter(x => x.offsetParent && !/-hidden|-leave/.test(x.className))[0];
    if (!d) return null;
    const h = d.querySelector('.ecom-g-select-tree-list-holder');
    if (!h) return null;
    ${scrollTo === null ? '' : `h.scrollTop = ${scrollTo}; h.dispatchEvent(new Event('scroll', { bubbles: true }));`}
    return {
      titles: [...d.querySelectorAll('.ecom-g-select-tree-title')]
        .map(x => (x.innerText || '').trim()).filter(Boolean),
      top: h.scrollTop,
      max: h.scrollHeight - h.clientHeight,
    };
  `).catch(() => null);

  const seen = [];
  let state = await readWindow(null);
  if (!state) return [];
  for (const t of state.titles) if (!seen.includes(t)) seen.push(t);

  const step = Math.max(80, Math.floor((state.max || 0) / 8));
  for (let y = step; y <= (state.max || 0) + step; y += step) {
    const next = await readWindow(Math.min(y, state.max));
    if (!next) break;
    for (const t of next.titles) if (!seen.includes(t)) seen.push(t);
    if (next.top >= next.max) break;      // 看实际位置，不看请求值
    await sleep(250);
  }

  // 「+新建风格」是入口而非选项
  return seen.filter((t) => !/^\+|新建/.test(t));
}

/**
 * 热搜词推荐：风格控件下方的推荐词区块，点击词即追加进商品标题。
 *
 * 实测行为（2026-08-30 真页验证，非推断）：
 * - 标题计数器按**字节**计（中文 2、英文 1），上限 60；标题框是本页
 *   第一个 input.ecom-g-input，可用来验证点击是否生效。
 * - 点击词元素必须打在最内层 div（文本与外层包裹 div 相同，
 *   querySelectorAll 按 DOM 序会先命中外层，点它不触发 handler）。
 * - 点击方式：向最内层词 div 派发四事件（mouseover→mousedown→mouseup→click，
 *   bubbles），已真页验证生效。
 * - 停止条件有两个：①点击后弹「标题过长」toast（实测未触发过，
 *   作为兑底保留）；②**标题余量放不下任何一个推荐词时，整个区块
 *   直接从 DOM 撤下**（实测主路径：计数器 57/60 时区块消失）。
 * - 页面常驻 toast「尺码表缺少…」等与本功能无关，只匹配「标题过长」。
 *
 * 结构：
 *   div.style_recomands__*
 *     ├─ span 「热搜词推荐」
 *     └─ div.style_tags__*[data-kora-exposure*=seo_word_expo]
 *          └─ div > div.style_words__*（词 + #icon-tianjia 图标）
 *
 * 定位不用 CSS Modules 哈希（发版即变），只用两层稳定锚点：
 *   ① [data-kora-exposure*="seo_word_expo"] 属性（顺便白送推荐词全集 JSON）
 *   ② 「热搜词推荐」可见文案
 * 见 selectors.mjs 尾部注释，哈希不登记（登记了反而让 doctor 报假阳性）。
 *
 * 区块不渲染时返回 { 存在: false }，调用方警告跳过，不阻断。
 */

/** 读热搜词候选集：只定位+读 keyword_list，不点击。区块不存在返回 { 存在: false } */
export async function getHotWordCandidates(page) {
  const found = await locateHotWords(page);
  if (!found) return { 存在: false, 可选: [] };
  await sleep(800);
  return { 存在: true, 可选: found.words };
}

/**
 * 点击热搜词（列表顺序即点击顺序）。配合 getHotWordCandidates 用：
 * 候选集来自页面推荐，相关度判断与排序由调用方（pi 视觉或手动）完成后传入。
 * 停止条件与实测行为见本文件上方热搜词总注释。
 */
export async function clickHotWords(page, words) {
  const want = (words ?? []).filter(Boolean);
  const empty = { 已添加: [], 停止: null, 停止原因: null };
  if (!want.length) return empty;

  const added = [];
  let stopped = null;
  let stopReason = null;
  for (const word of want) {
    // 每词重新定位：React 重渲染会重置 data-dp 标记，且区块可能随时被撤下
    const click = await page.eval(`
      const locate = () => {
        const tags = document.querySelector('[data-kora-exposure*="seo_word_expo"]');
        if (tags) return tags.closest('div')?.parentElement || null;
        const label = [...document.querySelectorAll('span')]
          .find(x => x.offsetParent && /热搜词推荐/.test(x.innerText));
        if (label) return label.closest('div[class*=recomands]') || label.parentElement?.parentElement || null;
        return null;
      };
      const c = locate();
      if (!c) return { state: '区块不存在' };
      c.setAttribute('data-dp', 'hotwords');
      const w = ${JSON.stringify(word)};
      const matches = [...c.querySelectorAll('div')]
        .filter((d) => (d.innerText || '').trim() === w);
      // 必须选最内层：外层包裹 div 文本相同，点它不触发 handler
      const inner = matches.reverse()
        .find((d) => ![...d.querySelectorAll('div')].some((k) => (k.innerText || '').trim() === w));
      if (!inner || !inner.offsetParent) return { state: '词不存在' };
      inner.scrollIntoView({ block: 'center' });
      for (const type of ['mouseover', 'mousedown', 'mouseup', 'click']) {
        inner.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
      }
      return { state: 'ok' };
    `).catch(() => ({ state: 'eval失败' }));

    if (click.state === '区块不存在') { stopReason = '推荐区块已被平台撤下（标题余量不足）'; break; }
    if (click.state !== 'ok') continue;   // 词不在当前推荐里，跳过

    // 点完轮询 toast：出现「标题过长」即停止，本词不算已添加
    let hit = false;
    for (let t = 0; t < 10; t += 1) {
      await sleepExact(400);
      hit = await page.eval(`
        return [...document.querySelectorAll('[class*=message]')]
          .some((x) => x.offsetParent && /标题过长/.test(x.innerText));
      `).catch(() => false);
      if (hit) break;
    }
    if (hit) { stopped = word; stopReason = '标题过长，无法添加'; break; }
    added.push(word);
    await sleep(1200);   // 拟人间隔，词与词之间
  }

  return { 已添加: added, 停止: stopped, 停止原因: stopReason };
}

/** 定位热搜词区块：属性/文案双稳定锚点，不用哈希。返回推荐词列表或 null */
async function locateHotWords(page) {
  return await page.eval(`
    const locate = () => {
      const tags = document.querySelector('[data-kora-exposure*="seo_word_expo"]');
      if (tags) return tags.closest('div')?.parentElement || null;
      const label = [...document.querySelectorAll('span')]
        .find(x => x.offsetParent && /热搜词推荐/.test(x.innerText));
      if (label) return label.closest('div[class*=recomands]') || label.parentElement?.parentElement || null;
      return null;
    };
    const c = locate();
    if (!c) return null;
    c.scrollIntoView({ block: 'center' });
    const tags = c.querySelector('[data-kora-exposure*="seo_word_expo"]');
    let list = [];
    try {
      const meta = JSON.parse(tags?.getAttribute('data-kora-exposure') || '{}');
      list = (meta.data?.keyword_list ?? []).map((k) => k.name).filter(Boolean);
    } catch {}
    return { words: list };
  `).catch(() => null);
}

/**
 * 导购短标题：点输入框右侧 AI 图标，平台 5-7 秒后**直接把结果写进输入框**。
 *
 * 与商品标题的 AI 不同：那个会弹一个推荐列表让你选，这个不弹层、直接填。
 * 所以判据是「输入框的 value 从空变成非空」，不要去找 dropdown（找不到）。
 *
 * 非必填字段，AI 不返回时返回 null 让调用方打警告继续，不阻断上架。
 */
export function shortTitleAiExpr() {
  return `
    document.querySelectorAll('[data-dp=short-title],[data-dp=short-ai]')
      .forEach(e => e.removeAttribute('data-dp'));
    const inp = [...document.querySelectorAll('input.ecom-g-input, input')]
      .find(x => x.offsetParent
        && (x.getAttribute('dropdownclassname') === 'auto-dropdown-id-导购短标题'
          || /简明准确的标题内容/.test(x.placeholder || '')));
    if (!inp) return null;
    inp.setAttribute('data-dp', 'short-title');
    inp.scrollIntoView({ block: 'center' });
    // AI 图标在 affix-wrapper 的 suffix 里，实测 20×20 且无 class（同商品标题那个）。
    // 同容器里的字数计数器是 span，不会误取。
    const wrap = inp.closest('.ecom-g-input-affix-wrapper') ?? inp.parentElement;
    const img = wrap?.querySelector('.ecom-g-input-suffix img, .ecom-g-input-suffix svg');
    if (!img) return { value: inp.value, ai: false };
    img.setAttribute('data-dp', 'short-ai');
    return { value: inp.value, ai: true };
  `;
}

export async function setShortTitle(page, { timeoutMs = 25000, retries = 1 } = {}) {
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const found = await page.eval(shortTitleAiExpr()).catch(() => null);
    if (!found) return null;
    if (found.value) return found.value;      // 平台已预填，不必再点
    if (!found.ai) return null;

    await page.clickReal('[data-dp=short-ai]').catch(() => {});

    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      await sleep(1000);
      const v = await page.eval(`
        const i = document.querySelector('[data-dp=short-title]');
        return (i?.value ?? '').trim();
      `).catch(() => '');
      if (v) return v;
    }
    if (attempt < retries) await sleep(2000);
  }
  return null;
}

/** 货号（对应模板的款号） */
export async function setArticleNo(page, code) {
  return await page.eval(`
    const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let n;
    while (n = w.nextNode()) {
      if (n.nodeValue.trim() === '货号') {
        let p = n.parentElement;
        for (let k = 0; k < 6; k++) {
          p = p.parentElement; if (!p) break;
          const ins = p.querySelectorAll('input');
          if (ins.length === 1) {
            const i = ins[0];
            const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
            i.focus(); set.call(i, ${JSON.stringify(code)});
            i.dispatchEvent(new Event('input', { bubbles: true }));
            i.dispatchEvent(new Event('blur', { bubbles: true }));
            return i.value;
          }
        }
      }
    }
    return null;
  `);
}

/** ---------- 类目属性补充：组合件数 / 适用年龄 / 上市时间 ---------- */

/**
 * 三个非必填属性（2026-08-30 实测，不填拉低商品质量分，见 SKILL.md 已知限制）：
 *
 * 【组合件数】ecom-g-select 单选，服务端搜索型（同品牌）：
 *   输入搜索词 → 等待 auto-dropdown-id-组合件数 下拉 → 点精确选项。
 *   选项集：单件 / 两件 / 三件 / 4件套。
 *
 * 【适用年龄】ecom-g-select 单选，但选项是**本地静态**（搜索无结果，
 *   必须真实点击展开才能看到）；且分桶固定（18-29、29-39、39-49 等），
 *   自定义值要走「+新建适用年龄」：
 *     ① clickReal 展开下拉
 *     ② el.click() 点内层 span.styles_newSKU（外层 div 点了无效）
 *     ③ 控件被替换为自定义输入框 input[class*=skuNameInput]
 *        —— 先查已有值，非空且不等目标值要先清空（重复输入会拼成 19-3919-39）
 *     ④ 真实 CDP 键盘输入（合成 KeyboardEvent 进不去 React onKeyDown）
 *     ⑤ 点 img[alt="确认"]（是 img 元素，不是 svg/button/data-kora，
 *        旁边还有 img[alt="取消"]）
 *
 * 【上市时间】自由文本 input[dropdownclassname="auto-dropdown-id-上市时间"]，
 *   原生 setter 写入即可，blur 后值保持（实测 "2026" 无需选下拉）。
 */

/** 读「属性信息」里某个 label 对应的选中标签（.ecom-g-select-selection-item） */
async function readAttrSelection(page, name) {
  return await page.eval(`
    const leaf = [...document.querySelectorAll('span,div,label')]
      .find(x => x.offsetParent && x.children.length === 0 && (x.innerText || '').trim() === ${JSON.stringify(name)});
    if (!leaf) return null;
    let p = leaf;
    for (let k = 0; k < 8; k++) {
      p = p.parentElement;
      if (!p) break;
      const ctrl = p.nextElementSibling;
      if (ctrl) {
        return [...ctrl.querySelectorAll('.ecom-g-select-selection-item')]
          .map(x => (x.innerText || '').trim()).filter(Boolean);
      }
    }
    return null;
  `);
}

/** 组合件数：服务端搜索下拉，同 setBrand 交互 */
export async function setComboCount(page, value = '两件') {
  await page.eval(`
    const leaf = [...document.querySelectorAll('span,div,label')]
      .find(x => x.offsetParent && x.children.length === 0 && (x.innerText || '').trim() === '组合件数');
    if (!leaf) return false;
    let p = leaf;
    for (let k = 0; k < 8; k++) {
      p = p.parentElement;
      if (!p) break;
      const sel = p.nextElementSibling?.querySelector('.ecom-g-select');
      if (sel) {
        sel.scrollIntoView({ block: 'center' });
        sel.setAttribute('data-dp', 'combo-count');
        const i = sel.querySelector('input');
        const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
        i.focus(); i.click();
        set.call(i, ${JSON.stringify(value)});
        i.dispatchEvent(new Event('input', { bubbles: true }));
        return true;
      }
    }
    return false;
  `);
  await waitDropdownOptions(page, {
    match: 'auto-dropdown-id-组合件数',
    label: `组合件数搜索结果（${value}）`,
  });
  const ok = await page.eval(`
    const d = [...document.querySelectorAll('.ecom-g-select-dropdown')]
      .find(x => /auto-dropdown-id-组合件数/.test(x.className));
    if (!d) return false;
    const opts = [...d.querySelectorAll('.ecom-g-select-item-option')];
    const exact = opts.find(o => o.innerText.trim() === ${JSON.stringify(value)});
    const target = exact || opts[0];
    if (!target) return false;
    ['mouseover', 'mousedown', 'mouseup', 'click'].forEach(t =>
      target.dispatchEvent(new MouseEvent(t, { bubbles: true, cancelable: true, view: window })));
    return true;
  `);
  if (!ok) throw new Error(`组合件数未找到: ${value}`);
  await sleep(2000);
  const sel = await readAttrSelection(page, '组合件数');
  return sel;
}

/** 真实 CDP 键盘输入（合成 KeyboardEvent 触发不了 React onKeyDown） */
async function typeReal(page, text) {
  for (const ch of text) {
    await page.cdp.send('Input.dispatchKeyEvent', {
      type: 'keyDown', text: ch, key: ch, unmodifiedText: ch,
      windowsVirtualKeyCode: ch.charCodeAt(0), nativeVirtualKeyCode: ch.charCodeAt(0),
    }, page.sessionId);
    await page.cdp.send('Input.dispatchKeyEvent', {
      type: 'keyUp', key: ch,
      windowsVirtualKeyCode: ch.charCodeAt(0), nativeVirtualKeyCode: ch.charCodeAt(0),
    }, page.sessionId);
  }
}

/**
 * 适用年龄：单选 + 本地静态选项。
 *
 * 注意：平台选项集是店铺级持久的——「19-39」一旦创建过就直接是选项，
 * 所以先找已有选项直接点；找不到才走「+新建适用年龄」，且**确认≠选中**：
 * img[alt=确认] 只是把自定义值加入选项列表，必须再点一次该选项才真正选中。
 * 流程与坑见本文件上方「类目属性补充」总注释。提交后轮询选中标签。
 */
export async function setAgeRange(page, value = '19-39') {
  // 已是目标值就不动（幂等）
  const existing = await readAttrSelection(page, '适用年龄');
  if (existing?.includes(value)) return existing;

  // 展开下拉
  await page.eval(`
    document.querySelectorAll('[data-dp=age-select]').forEach(e => e.removeAttribute('data-dp'));
    const leaf = [...document.querySelectorAll('span,div,label')]
      .find(x => x.offsetParent && x.children.length === 0 && (x.innerText || '').trim() === '适用年龄');
    if (!leaf) return false;
    let p = leaf;
    for (let k = 0; k < 8; k++) {
      p = p.parentElement;
      if (!p) break;
      const sel = p.nextElementSibling?.querySelector('.ecom-g-select');
      if (sel) { sel.setAttribute('data-dp', 'age-select'); sel.scrollIntoView({ block: 'center' }); return true; }
    }
    return false;
  `);
  await page.clickReal('[data-dp=age-select]');
  await sleep(2000);

  /** 点下拉里文本精确等于 value 的选项（四事件），返回是否找到 */
  const clickOption = () => page.eval(`
    const d = [...document.querySelectorAll('.ecom-g-select-dropdown')]
      .find(x => x.offsetParent && /auto-dropdown-id-适用年龄/.test(x.className));
    if (!d) return false;
    const opt = [...d.querySelectorAll('.ecom-g-select-item-option')]
      .find(o => (o.innerText || '').trim() === ${JSON.stringify(value)});
    if (!opt) return false;
    ['mouseover', 'mousedown', 'mouseup', 'click'].forEach(t =>
      opt.dispatchEvent(new MouseEvent(t, { bubbles: true, cancelable: true, view: window })));
    return true;
  `);

  // 路径 A：选项已存在（之前创建过）→ 直接点
  if (await clickOption()) {
    const sel = await pollAgeSelection(page, value);
    return sel;
  }

  // 路径 B：不存在 → 走「+新建适用年龄」
  const clicked = await page.eval(`
    const d = [...document.querySelectorAll('.ecom-g-select-dropdown')]
      .find(x => x.offsetParent && /auto-dropdown-id-适用年龄/.test(x.className));
    if (!d) return false;
    const el = d.querySelector('span[class*=newSKU]');
    if (!el) return false;
    el.click();
    return true;
  `);
  if (!clicked) throw new Error('适用年龄下拉里未找到「+新建适用年龄」');
  await sleep(2000);

  // 自定义输入框：先查已有值（残留会导致重复拼接），再决定是否补输
  const marked = await page.eval(`
    const d = [...document.querySelectorAll('.ecom-g-select-dropdown')]
      .find(x => x.offsetParent && /auto-dropdown-id-适用年龄/.test(x.className));
    const i = d?.querySelector('input[class*=skuNameInput]');
    if (!i) return null;
    i.setAttribute('data-dp', 'age-custom-input');
    i.scrollIntoView({ block: 'center' });
    return i.value;
  `);
  if (marked === null) throw new Error('适用年龄自定义输入框未出现');
  await page.clickReal('[data-dp=age-custom-input]');
  await sleep(600);
  if (marked !== value) {
    // 清掉残留（真实全选 + 覆盖输入）
    await page.cdp.send('Input.dispatchKeyEvent', {
      type: 'keyDown', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 65,
      modifiers: 2,
    }, page.sessionId);
    await page.cdp.send('Input.dispatchKeyEvent', {
      type: 'keyUp', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 65,
      modifiers: 2,
    }, page.sessionId);
    await typeReal(page, value);
  }
  await sleep(800);

  // 点 img[alt="确认"]（注意不是 svg/button，旁边还有 img[alt="取消"]）。
  // 确认只是把值加入选项列表，不等于选中。
  const confirmed = await page.eval(`
    const d = [...document.querySelectorAll('.ecom-g-select-dropdown')]
      .find(x => x.offsetParent && /auto-dropdown-id-适用年龄/.test(x.className));
    const img = d?.querySelector('img[alt="确认"]');
    if (!img) return false;
    img.click();
    return true;
  `);
  if (!confirmed) throw new Error('适用年龄未找到确认按钮 img[alt=确认]');
  await sleep(1500);

  // 新选项入列后，必须再点一次选项才真正选中
  const deadline = Date.now() + 15000;
  for (;;) {
    if (await clickOption()) {
      const sel = await pollAgeSelection(page, value);
      return sel;
    }
    const sel = await readAttrSelection(page, '适用年龄');
    if (sel?.includes(value)) return sel;
    if (Date.now() > deadline) {
      throw new Error(`适用年龄写入失败: ${value}（当前: ${sel?.join('、') ?? '无'}）`);
    }
    await sleep(800);
  }
}

/** 轮询等选中标签出现目标值（点选项后异步生效） */
async function pollAgeSelection(page, value) {
  const deadline = Date.now() + 15000;
  for (;;) {
    const sel = await readAttrSelection(page, '适用年龄');
    if (sel?.includes(value)) return sel;
    if (Date.now() > deadline) {
      throw new Error(`适用年龄选中失败: ${value}（当前: ${sel?.join('、') ?? '无'}）`);
    }
    await sleep(800);
  }
}

/** 上市时间：自由文本 input，原生 setter 写入 + blur */
export async function setLaunchYear(page, value = '2026') {
  const v = await page.eval(`
    const i = document.querySelector('input[dropdownclassname="auto-dropdown-id-上市时间"]');
    if (!i) return null;
    if (i.value === ${JSON.stringify(value)}) return i.value;
    i.scrollIntoView({ block: 'center' });
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    i.focus();
    set.call(i, ${JSON.stringify(value)});
    i.dispatchEvent(new Event('input', { bubbles: true }));
    i.dispatchEvent(new Event('blur', { bubbles: true }));
    return i.value;
  `);
  if (v === null) throw new Error('未找到「上市时间」输入框');
  if (v !== value) throw new Error(`上市时间写入失败（当前: ${v}）`);
  return v;
}

/** ---------- 图文信息 ---------- */

export async function uploadDetailImages(page, files) {
  if (!files.length) return 0;
  await page.setFiles('.styles_decorateImgEditTitleWrapper__wfpvu input[type=file]', files);
  await page.waitFor(
    `const m = document.body.innerText.match(/商详图片（(\\d+)\\/50）/);
     return m && Number(m[1]) >= ${files.length};`,
    { label: '详情图上传完成', timeoutMs: 120000 },
  );
  await sleep(1500);
  return await page.eval(`
    const m = document.body.innerText.match(/商详图片（(\\d+)\\/50）/);
    return m ? Number(m[1]) : 0;
  `);
}

/** ---------- 规格设置 ---------- */

/**
 * 删掉智能填写预填的、不在模板「规格值」里的**第一组**规格值。
 *
 * 2026-08-31 实测：新版会从主图猜一个颜色（实测「杏色」）先占一行。
 * 不删它就会与 addSpecValue 追加的值并存，后果是连锰的：
 *  - SKU 行数变 4×4=16 而不是 3×4=12，多出的「杏色」四行既无价格（模板里没有
 *    这个规格值）也无规格图 → 平台报「价格该项为必填」+「请上传规格图」；
 *  - fillSkuTable 的 codeRule 也会给它生成 GZ0074-杏色-S 这类垃圾编码。
 *
 * **作用域必须锁在第一组**（踩过的坑）：`.style_specValueContent___uoY8`
 * 第一组（颜色分类）与第二组（尺码大小）**共用同一个类名**。全页扫会把
 * S/M/L/XL 也一并删光（实测已发生：返回 [杏色,S,M,L,XL]，尺码组被清空）。
 * 组容器的结构不变量：含组名文案且**不含「尺码大小」**的最小容器。
 *
 * 删除入口是行尾的 `[data-kora="删除规格值"]`（span，14×20）。
 * 每删一行表格重建，所以逐行重新查询，不缓存元素引用。
 * 只删「不在 keep 里」的值，幂等：预填值恰好命中模板时不动。
 */
export async function removePrefilledSpecValues(page, keep, groupName = '颜色分类') {
  const keepJson = JSON.stringify(keep);
  const nameJson = JSON.stringify(groupName);
  const removed = [];
  for (let i = 0; i < 12; i += 1) {
    const gone = await page.eval(`
      const keep = ${keepJson};
      const gname = ${nameJson};
      // 第一组容器：含组名、不含「尺码大小」、且里面真有规格值行。
      // 取满足条件的**最内层**（DOM 顺序里最后一个），避开包住两组的外层。
      const groups = [...document.querySelectorAll('div')].filter(d => {
        if (!d.offsetParent) return false;
        const t = d.innerText || '';
        return t.includes(gname) && !t.includes('尺码大小')
          && d.querySelectorAll('.style_specValueContent___uoY8').length > 0;
      });
      const scope = groups[groups.length - 1];
      if (!scope) return null;
      const rows = [...scope.querySelectorAll('.style_specValueContent___uoY8')]
        .filter(x => x.offsetParent);
      for (const row of rows) {
        const label = row.querySelector('.ecom-g-cascader-picker-label');
        const v = (label?.innerText || '').trim();
        if (!v || keep.includes(v)) continue;
        const del = row.querySelector('[data-kora="删除规格值"]');
        if (!del) continue;
        for (const ty of ['mouseover', 'mousedown', 'mouseup', 'click']) {
          del.dispatchEvent(new MouseEvent(ty, { bubbles: true, cancelable: true, view: window }));
        }
        return v;
      }
      return null;
    `).catch(() => null);
    if (!gone) break;
    removed.push(gone);
    await sleep(900);
    // 删除可能弹确认框（已有 SKU 行时平台会问），有就确认
    await confirmDialog(page, /^(确定|确认|删除)$/).catch(() => {});
  }
  return removed;
}

/**
 * 点弹窗里的确认按钮（存在则点，不存在不报错）。
 * 与 dismissModals 分开：那个是「关掉干扰弹窗」，这个是「确认一个动作」。
 */
async function confirmDialog(page, re = /^(确定|确认)$/) {
  const found = await page.eval(`
    document.querySelectorAll('[data-dp=confirm-dialog]').forEach(e => e.removeAttribute('data-dp'));
    const scope = [...document.querySelectorAll('.ecom-g-modal, [role="dialog"], .auxo-modal')]
      .find(x => x.offsetParent);
    if (!scope) return false;
    const b = [...scope.querySelectorAll('button')]
      .find(x => x.offsetParent && ${re.toString()}.test((x.innerText || '').trim()));
    if (!b) return false;
    b.setAttribute('data-dp', 'confirm-dialog');
    return true;
  `).catch(() => false);
  if (!found) return false;
  await page.clickReal('[data-dp=confirm-dialog]').catch(() => {});
  await sleep(1000);
  return true;
}

/**
 * 从「智能填写助手」切到手动填写模式。
 *
 * 不再写死 CSS Modules 哈希（旧的 switchButton 哈希已随抖店发版失效），
 * 改用文案定位「切换手动填写」+ 真实鼠标点击，并保留哈希与 JS click 作为兜底。
 */
export async function switchToManualSpec(page) {
  const already = await page.eval(`return document.body.innerText.includes('*商品规格')`);
  if (already) return;

  const marked = await page.eval(`
    const cands = [...document.querySelectorAll('button, a, span, div')]
      .filter(x => x.offsetParent && x.children.length === 0 &&
        /^\\s*切换手动填写\\s*$/.test(x.innerText || ''));
    let el = cands[0];
    if (!el) el = document.querySelector('button[class*=switchButton]');
    if (!el) return false;
    const btn = el.closest('button, a') || el;
    btn.setAttribute('data-dp', 'manualspec');
    btn.scrollIntoView({ block: 'center' });
    return true;
  `);
  if (!marked) throw new Error('未找到「切换手动填写」按钮');
  await sleep(500);
  await page.clickReal('[data-dp=manualspec]');
  await sleep(1500);

  const ok = await page.eval(`return document.body.innerText.includes('*商品规格')`);
  if (!ok) {
    await page.eval(`
      const b = document.querySelector('[data-dp=manualspec]');
      if (b) b.click();
      return !!b;
    `);
  }

  await page.waitFor(`return document.body.innerText.includes('*商品规格')`, {
    label: '切换到手动填写规格', timeoutMs: 20000,
  });
  await sleep(1500);
}

/**
 * 新建一个第一组规格值（如「上衣」）。
 *
 * 六步序列，缺任何一步都会静默失败：
 *  1) 点 .style_forCreate__c19CW 里的 cascader（这是"追加新值"的空位，
 *     不是已有值的 picker——用错会覆盖已有值）
 *  2) 在同一容器内的 cascader-input 里输入候选词
 *  3) 点下拉里的「创建类型」链接
 *  4) 在 styles_skuNameInput__eV89r 里填最终值
 *  5) 点绿色 ✓（[data-kora=确认]）把值加入候选列表并自动勾选
 *  6) 点下拉底部「确定」把勾选项写入规格
 */
export async function addSpecValue(page, value) {
  const v = JSON.stringify(value);

  const opened = await page.eval(`
    const p = document.querySelector('.style_forCreate__c19CW .ecom-g-cascader-picker');
    if (!p) return false;
    p.scrollIntoView({ block: 'center' });
    p.click();
    return true;
  `);
  if (!opened) throw new Error('未找到规格值追加控件 .style_forCreate__c19CW');
  await sleep(1800);

  await page.eval(`
    const i = document.querySelector('.style_forCreate__c19CW input.ecom-g-cascader-input');
    if (!i) return false;
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    i.focus(); set.call(i, ${v});
    i.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  `);
  await sleep(1800);

  // 若平台已有同名标准选项，直接勾选，跳过创建流程
  const existing = await page.eval(`
    const d = [...document.querySelectorAll('[class*=cascader-menus]')].find(x => x.offsetParent);
    if (!d) return false;
    const lab = [...d.querySelectorAll('label.ecom-g-checkbox-wrapper')]
      .find(l => l.innerText.trim() === ${v});
    if (!lab || lab.className.includes('checked')) return false;
    lab.click();
    return true;
  `);

  if (!existing) {
    const created = await page.eval(`
      const ds = [...document.querySelectorAll('[class*=cascader-menus]')].filter(x => x.offsetParent);
      for (const d of ds) {
        const a = [...d.querySelectorAll('a')].find(x => /创建类型/.test(x.innerText));
        if (a) { a.click(); return true; }
      }
      return false;
    `);
    if (!created) throw new Error(`规格值下拉里既无同名选项也无「创建类型」入口: ${value}`);
    await sleep(2000);

    await page.eval(`
      const i = [...document.querySelectorAll('input.styles_skuNameInput__eV89r')]
        .find(x => x.offsetParent);
      if (!i) return false;
      const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      i.focus(); set.call(i, ${v});
      i.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    `);
    // 等绿色 ✓ 真的挂载出来，而不是固定 sleep 后赌它已经在
    await page.waitFor(
      `return [...document.querySelectorAll('[data-kora=确认]')].some(x => x.offsetParent);`,
      { label: `规格值确认按钮（${value}）`, timeoutMs: 15000 },
    );

    const confirmed = await page.eval(`
      const ok = [...document.querySelectorAll('[data-kora=确认]')].filter(x => x.offsetParent);
      if (!ok.length) return false;
      ok[ok.length - 1].click();
      return true;
    `);
    if (!confirmed) throw new Error(`未找到规格值确认按钮（绿色✓）: ${value}`);
    await sleep(2000);
  }

  await page.eval(`
    const d = [...document.querySelectorAll('[class*=cascader-menus]')].find(x => x.offsetParent);
    if (!d) return false;
    const b = [...d.querySelectorAll('button')].find(x => /确定/.test(x.innerText));
    if (!b) return false;
    b.click();
    return true;
  `);
  await sleep(2500);

  // 写入规格区是异步的（点「确定」后组件要重建规格区 + SKU 表），
  // 固定 sleep 会间歇性读到空数组 → 误报「规格值写入失败（当前: ）」。改为轮询。
  let now = [];
  const deadline = Date.now() + SPEC_WRITE_TIMEOUT;
  for (;;) {
    now = await listSpecValues(page);
    if (now.includes(value)) break;
    if (Date.now() > deadline) {
      throw new Error(`规格值写入失败: ${value}（当前: ${now.join('、')}）`);
    }
    await sleep(800);
  }
  return now;
}

/** 读已写入的第一组（颜色分类）规格值。页面上有多个 specValueBox，第一个才是颜色分类 */
export async function listSpecValues(page) {
  return await page.eval(`
    const b = document.querySelector('.style_specValueBox__i8sD6');
    if (!b) return [];
    return [...b.querySelectorAll('.style_skuValue__QyAOk')]
      .map(r => r.innerText.trim().split('\\n')[0].trim())
      .filter(Boolean);
  `);
}

/**
 * 尺码面板里定位并勾选指定尺码的页内 JS。提成单独函数是为了能在假 DOM 上直接跑
 * （selftest 里两种视图各一组），而不是把逻辑埋在模板串里靠读代码看对不对。
 *
 * 为何不按类名找选项：两种视图的选项容器类名完全不同（一个是
 * `li.ecom-g-cascader-menu-item`，一个是带 CSS Modules 哈希的 div，而哈希随发版就变）。
 * 这里只用两边共同的结构不变量：
 *   1) 可勾选项 = 面板里的 `input[type=checkbox]`（码制列没有 checkbox，自然被排除）；
 *   2) 尺码文案 = 从该 checkbox 往上走，第一个 innerText 非空且很短的祖先。
 *      视图A 走到 li（label 内部文字是空的，在 label 外的 span），
 *      视图B 走到带哈希的 div。同一条路径。
 *
 * 勾选必须向 `input` 派发 mouseover/mousedown/mouseup/click：
 * `label.click()` 对这个组件无效（实测点完 className 仍无 checked）。
 */
export function sizeOptionsExpr(sizes) {
  return `
    const d = [...document.querySelectorAll('[class*=cascader-menus]')].find(x => x.offsetParent);
    if (!d) return { error: '尺码下拉未展开' };
    const want = ${JSON.stringify(sizes)};

    // 限 6 层 + 限长 12，避免一路往上走到整个面板（它的 innerText 是全部尺码拼串）。
    // 尺码文案最长是 'XXXS女' / '16XL' / 'M/L' 这种，12 字符结结有余。
    const labelOf = (cb) => {
      let e = cb.parentElement;
      for (let i = 0; i < 6 && e && e !== d; i += 1) {
        const t = (e.innerText || '').trim();
        if (t && t.length <= 12 && !t.includes('\\n')) return t;
        e = e.parentElement;
      }
      return null;
    };

    const opts = [...d.querySelectorAll('input[type=checkbox]')]
      .map(cb => ({ cb, label: labelOf(cb) }))
      .filter(o => o.label);
    if (!opts.length) return { error: '尺码下拉无可勾选项（面板里没找到带文案的 checkbox）' };

    // view 仅用于日志诊断，不参与定位逻辑
    const view = d.querySelector('ul.ecom-g-cascader-menu') ? 'A' : 'B';

    const missing = [], clicked = [], already = [];
    for (const s of want) {
      const o = opts.find(x => x.label === s);
      if (!o) { missing.push(s); continue; }
      if (o.cb.checked) { already.push(s); continue; }
      for (const t of ['mouseover', 'mousedown', 'mouseup', 'click']) {
        o.cb.dispatchEvent(new MouseEvent(t, { bubbles: true }));
      }
      clicked.push(s);
    }
    const checked = opts.filter(o => o.cb.checked).map(o => o.label);
    return { view, missing, clicked, already, checked };
  `;
}

/**
 * 尺码组：走标准 checkbox 勾选，平台已有 XS-16XL 全套。
 *
 * **两种视图随机切换**（同一账号、同一类目也会变）：
 *   视图A（面板 class 带 cascaderPopup）：传统两级 cascader，有 ul/li。
 *   视图B（面板 class 带 popupBlock）：自定义布局，**没有 ul/li**。
 * 选项定位统一交给 `sizeOptionsExpr()`（不靠类名，详见那里的注释）。
 * 早期只认 A 的版本遇到 B 时，`[...ul].pop()` 返回 undefined，
 * 报 `Cannot read properties of undefined (reading 'querySelectorAll')`。
 *
 * 勾选未生效会导致静默失败：尺码一个都没选上时，后面 SKU 表只生成 3 行
 * （只有规格值维度）而不是 12 行。所以下面关面板前后各校验一次。
 *
 * 另外这个 cascader 用 `el.click()` 就能展开（与颜色分类不同，
 * 那个需要真实鼠标）；对它用 clickReal 反而会把已展开的面板点关。
 */
export async function setSizes(page, sizes) {
  const opened = await page.eval(`
    // 尺码 cascader placeholder 存在改版（「请选择尺码大小」→「请选择/输入尺码大小」），
    // 用宽松的 /尺码大小/ 匹配，别再依赖精确文案。
    const p = [...document.querySelectorAll('.ecom-g-cascader-picker')]
      .find(x => /尺码大小/.test(x.innerText));
    if (!p) return false;
    p.scrollIntoView({ block: 'center' });
    p.click();
    return true;
  `);
  if (!opened) {
    throw new Error('未找到尺码 cascader（当前页面上没有含「尺码大小」的 picker）');
  }
  await sleep(2500);

  // 面板容器出现得比里面的选项早，直接取选项会拿到空。
  // 等到面板里出现 checkbox 为止（两种视图通用，不依赖类名）。
  await page.waitFor(
    `const d = [...document.querySelectorAll('[class*=cascader-menus]')].find(x => x.offsetParent);
     return !!d && d.querySelectorAll('input[type=checkbox]').length > 0;`,
    { label: '尺码下拉选项渲染', timeoutMs: 20000 },
  );

  const result = await page.eval(sizeOptionsExpr(sizes));
  if (result.error) throw new Error(result.error);
  if (result.missing?.length) throw new Error(`平台尺码列表缺少: ${result.missing.join('、')}`);

  // 勾选必须真的生效，否则后面 SKU 表行数就不对。在关面板前先校验。
  const notChecked = sizes.filter((s) => !result.checked.includes(s));
  if (notChecked.length) {
    throw new Error(`尺码勾选未生效: ${notChecked.join('、')}（当前已勾: ${result.checked.join('、') || '无'}）`);
  }
  await sleep(1200);

  await page.eval(`
    const d = [...document.querySelectorAll('[class*=cascader-menus]')].find(x => x.offsetParent);
    if (!d) return false;
    const b = [...d.querySelectorAll('button')].find(x => /确定/.test(x.innerText));
    if (b) b.click();
    return !!b;
  `);
  await sleep(2500);

  // 确认尺码已写入规格区。写入是异步的（点「确定」后组件要重建规格区 + SKU 表），
  // 固定 sleep 会间歇性读到空数组 → 误报「尺码写入规格区失败」。改为轮询等待。
  let written = [];
  const deadline = Date.now() + 20000;
  for (;;) {
    written = await listSizeValues(page);
    if (sizes.every((s) => written.includes(s))) break;
    if (Date.now() > deadline) {
      const miss = sizes.filter((s) => !written.includes(s));
      throw new Error(`尺码写入规格区失败: ${miss.join('、')}（当前: ${written.join('、') || '无'}）`);
    }
    await sleep(800);
  }
  return { values: written, view: result.view };
}

/** 读已写入的尺码规格值（第二组规格） */
export async function listSizeValues(page) {
  return await page.eval(`
    const boxes = [...document.querySelectorAll('.style_specValueBox__i8sD6')];
    const b = boxes[boxes.length - 1];
    if (!b) return [];
    return [...b.querySelectorAll('.style_skuValue__QyAOk')]
      .map(r => r.innerText.trim().split('\\n')[0].trim())
      .filter(Boolean);
  `);
}

/** 上传各规格值的规格图。用 data-specidx 打标定位，避免 nth-child 漂移 */
export async function uploadSpecImages(page, specValues, imageMap) {
  const n = await page.eval(`
    const b = document.querySelector('.style_specValueBox__i8sD6');
    const rows = [...b.querySelectorAll('.style_skuValue__QyAOk')];
    rows.forEach((r, i) => {
      const f = r.querySelector('input[type=file]');
      if (f) f.setAttribute('data-specidx', String(i));
    });
    return rows.map(r => r.innerText.trim().split('\\n')[0].trim());
  `);

  const done = [];
  for (let i = 0; i < n.length; i += 1) {
    const file = imageMap[n[i]];
    if (!file) continue;
    await page.setFiles(`input[type=file][data-specidx='${i}']`, [file]);
    await sleep(5000);
    done.push(n[i]);
  }
  return done;
}

/** ---------- 价格与库存 ---------- */

/**
 * 填 SKU 表。行顺序 = 页面实际规格值顺序 × 尺码顺序。
 *
 * 坑：这是**窗口化虚拟表**（`.ecom-g-table-tbody-virtual-holder`，
 * `max-height` 小于内容高度）。DOM 里任何时刻只存在可视窗口内的 ~10-11 行，
 * 12 行 SKU 只能看到 11 行。直接数 tr 会报「行数不匹配」。
 *
 * 外层页面滚动、抬高 viewport 都无效，必须滚动 holder 本身。
 * 行的全局下标 = (inner 的 translateY + row.offsetTop) / 行高，
 * 因为 offsetTop 每个窗口会重置，只靠它会重复填前几行。
 */
export async function fillSkuTable(page, { specValues, sizes, prices, stocks, stockDetail, codeRule, code }) {
  // 以页面实际规格值顺序为准，不用 Excel 顺序
  const actual = await listSpecValues(page);
  const order = actual.length ? actual : specValues;

  const rows = [];
  for (const sv of order) {
    for (const sz of sizes) {
      const key = `${sv}-${sz}`;
      rows.push({
        规格值: sv,
        尺码: sz,
        价格: prices[sv],
        库存: stockDetail?.[key] ?? stocks[sz] ?? 0,
        编码: codeRule.replace('{款号}', code).replace('{规格值}', sv).replace('{尺码}', sz),
      });
    }
  }

  const geo = await page.eval(`
    const w = document.querySelector('.styles_customVirtualTable__nLhAS');
    if (!w) return { error: '未找到 SKU 表' };
    const h = w.querySelector('.ecom-g-table-tbody-virtual-holder');
    if (!h) return { error: '未找到虚拟表滚动容器' };
    // 只在 holder（tbody）内找数据行：thead 的表头行也含 input（「批量传图」的 file
    // input），若把它当成数据行取高度，rowH 会取成表头高 67 而非真实行高 73，
    // 之后所有全局下标都会算歪并互相碰撞（实测 12 行被数成 10 行或 13 行）。
    const tr = [...h.querySelectorAll('tr')].find(r => r.querySelectorAll('input').length > 0);
    if (!tr) return { error: 'SKU 表无数据行' };
    const rowH = Math.round(tr.getBoundingClientRect().height) || 61;
    return { rowH, scrollHeight: Math.round(h.scrollHeight), clientHeight: Math.round(h.clientHeight) };
  `);
  if (geo.error) throw new Error(geo.error);

  // 行数判断：直接用 scrollHeight / rowH。rowH 取对（只在 holder 内找数据行）后这个商
  // 是精确的：实测 876 / 73 = 12。分组行（「上衣/裤子/套装」那种 rowspan 单元格）
  // 是绝对定位的，不计入 scrollHeight，不会把结果抹高。
  //
  // 早期版本改成「逐窗口滚动扫全部下标再去重」，但虚拟表重渲染是异步的，
  // 滚动后 700ms 并不总够，会在没重渲染时就 resolve，只数到首屏的 10 行
  // → 误报「SKU 行数不匹配: 页面 10 行，预期 12 行」。几何计算没有这个时序风险。
  const realTotal = Math.round(geo.scrollHeight / geo.rowH);

  if (realTotal !== rows.length) {
    throw new Error(`SKU 行数不匹配: 页面 ${realTotal} 行，预期 ${rows.length} 行`);
  }

  const filled = new Array(rows.length).fill(null);
  const step = Math.max(1, Math.floor(geo.clientHeight / geo.rowH) - 1);
  // 可滚动上限：往 scrollTop 写超过它的值会被浏览器默默夹到这个上限，
  // 若拿未夹取的 top 去判断循环终止，会在还没真正滚到底时就提前退出。
  const maxScroll = Math.max(0, geo.scrollHeight - geo.clientHeight);

  // 逐窗口滚动，每次只填当前 DOM 里存在的行，按全局下标写入
  for (let top = 0; ; top += step * geo.rowH) {
    const at = await page.eval(`
      const h = document.querySelector('.styles_customVirtualTable__nLhAS .ecom-g-table-tbody-virtual-holder');
      h.scrollTop = ${top};
      h.dispatchEvent(new Event('scroll', { bubbles: true }));
      return h.scrollTop;
    `);
    await sleep(900);

    const res = await page.eval(`
      const w = document.querySelector('.styles_customVirtualTable__nLhAS');
      const inner = w.querySelector('.ecom-g-table-tbody-virtual-holder-inner');
      const m = /translateY\\((-?[\\d.]+)px\\)/.exec(inner.style.transform || '');
      const ty = m ? parseFloat(m[1]) : 0;
      const data = ${JSON.stringify(rows)};
      const rowH = ${geo.rowH};
      const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      const fill = (i, v) => {
        i.focus(); set.call(i, String(v));
        i.dispatchEvent(new Event('input', { bubbles: true }));
        i.dispatchEvent(new Event('change', { bubbles: true }));
        i.dispatchEvent(new Event('blur', { bubbles: true }));
      };
      const done = [];
      const holder = w.querySelector('.ecom-g-table-tbody-virtual-holder');
      for (const r of [...holder.querySelectorAll('tr')]) {
        const ins = [...r.querySelectorAll('input')];
        if (!ins.length) continue;
        const g = Math.round((ty + r.offsetTop) / rowH);
        if (g < 0 || g >= data.length) continue;
        const p = ins.find(x => x.placeholder === '请输入');
        const s = ins.find(x => x.placeholder === '请输入库存');
        const c = ins.find(x => x.placeholder === '请输入erp编码');
        if (p) fill(p, data[g].价格);
        if (s) fill(s, data[g].库存);
        if (c) fill(c, data[g].编码);
        done.push([g, (p ? p.value : '') + '/' + (s ? s.value : '') + '/' + (c ? c.value : '')]);
      }
      return done;
    `);
    for (const [g, v] of res) filled[g] = v;

    // 终止条件用**实际**滚到的位置（at）而不是请求值 top：
    // top 可能已超过 maxScroll 而被夹取，拿它判断会提前退出。
    if (at >= maxScroll) break;
  }

  // 回到顶部，方便后续操作和截图
  await page.eval(`
    const h = document.querySelector('.styles_customVirtualTable__nLhAS .ecom-g-table-tbody-virtual-holder');
    h.scrollTop = 0; h.dispatchEvent(new Event('scroll', { bubbles: true })); return 1;
  `);
  await sleep(1200);

  const missed = filled.map((v, i) => (v ? null : i)).filter((i) => i !== null);
  if (missed.length) {
    const names = missed.map((i) => `${rows[i].规格值}-${rows[i].尺码}`);
    throw new Error(`以下 SKU 行未填写（虚拟表滚动未覆盖）: ${names.join('、')}`);
  }
  return filled;
}

/** ---------- 服务与履约 ---------- */

/**
 * 运费模板。这个 select 的显示文本就是当前选中的模板名，
 * 容易误判成别的字段——它的 dropdown className 带 auto-dropdown-id-运费模板。
 */
export async function setFreightTemplate(page, name) {
  if (!name) return null;
  await page.eval(`
    const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let n;
    while (n = w.nextNode()) {
      if (n.nodeValue.trim() === '运费模板') {
        let lbl = n.parentElement;
        while (lbl && !/width: 110px/.test(lbl.getAttribute('style') || '')) lbl = lbl.parentElement;
        const sel = lbl.nextElementSibling.querySelector('.ecom-g-select');
        if (!sel) return false;
        sel.setAttribute('data-dp', 'freight');
        sel.scrollIntoView({ block: 'center' });
        return true;
      }
    }
    return false;
  `);
  await sleep(800);
  await page.clickReal('[data-dp=freight]');
  // 模板列表靠接口拉，固定 sleep 后读会报「未找到模板，可选: 」且列表为空
  await waitDropdownOptions(page, {
    match: 'auto-dropdown-id-运费模板',
    label: '运费模板列表加载',
  });

  const ok = await page.eval(`
    const d = [...document.querySelectorAll('.ecom-g-select-dropdown')]
      .find(x => x.offsetParent && /auto-dropdown-id-运费模板/.test(x.className));
    if (!d) return { error: '运费模板下拉未展开' };
    const opts = [...d.querySelectorAll('.ecom-g-select-item-option')];
    const t = opts.find(o => o.innerText.trim() === ${JSON.stringify(name)});
    if (!t) return { error: '未找到模板，可选: ' + opts.map(o => o.innerText.trim()).join('、') };
    ['mouseover','mousedown','mouseup','click'].forEach(e =>
      t.dispatchEvent(new MouseEvent(e, { bubbles: true, cancelable: true, view: window })));
    return { ok: true };
  `);
  if (ok.error) throw new Error(ok.error);
  await sleep(2500);
  return name;
}

/**
 * 按标签文案定位一组 radio 并选中指定选项。
 *
 * 页面上「商品状态」「发货模式」「现货发货时间」「订单库存计数」四处结构完全同构：
 * 文案节点往上数层后能找到一个含 ≥2 个 `input[type=radio]` 的容器。
 * 实测到的 value（仅供参考，不依赖它定位，因为同一区域里 value 会重复）：
 *   发货模式     现货=0 / 现货预售混合=2
 *   现货发货时间 当日发=9999 / 次日发=1 / 48小时=2
 *   订单库存计数 下单减库存=1 / 付款减库存=2
 *   商品状态     上架=0 / 下架=1
 * value 在不同字段间重复（都有 1 和 2），所以必须先靠标签文案锁定区域，再靠
 * 选项文案选中 —— 直接全页找 value 会选错字段。
 *
 * @returns 选中后的选项文案；已是目标值时也返回它。
 */
export function radioGroupExpr(label, option, mark) {
  return `
    document.querySelectorAll('[data-dp=${mark}]').forEach(e => e.removeAttribute('data-dp'));
    const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let n;
    while (n = w.nextNode()) {
      if (n.nodeValue.trim() !== ${JSON.stringify(label)}) continue;
      let p = n.parentElement;
      for (let k = 0; k < 8; k += 1) {
        p = p.parentElement;
        if (!p) break;
        const rs = [...p.querySelectorAll('input[type=radio]')];
        if (rs.length < 2) continue;
        const t = rs.find(r => (r.closest('label')?.innerText ?? '').trim() === ${JSON.stringify(option)});
        // 数到的确实是一组 radio，但里面没有目标选项 → 区域定位对了、选项名错了
        if (!t) return { options: rs.map(r => (r.closest('label')?.innerText ?? '').trim()) };
        if (t.checked) return { already: true };
        const l = t.closest('label');
        l.setAttribute('data-dp', '${mark}');
        l.scrollIntoView({ block: 'center' });
        return { marked: true };
      }
    }
    return null;
  `;
}

/**
 * 选中一组 radio 里的指定项。未找到字段时返回 null（不抛错）：
 * 这几项在部分类目下可能不存在，不应让整款上架失败。
 * 区域找到但选项名不对时抛错，并把实际可选项列出来 —— 那是配置写错了。
 */
export async function setRadioOption(page, { label, option, mark }) {
  const r = await page.eval(radioGroupExpr(label, option, mark)).catch(() => null);
  if (!r) return null;
  if (r.options) {
    throw new Error(`${label} 无此选项: ${option}（可选: ${r.options.join('、')}）`);
  }
  if (r.already) return option;

  await sleep(800);
  await page.clickReal(`[data-dp=${mark}]`);
  await sleep(1200);
  const ok = await page.eval(`
    const l = document.querySelector('[data-dp=${mark}]');
    return !!l?.querySelector('input[type=radio]')?.checked;
  `).catch(() => false);
  if (!ok) throw new Error(`${label} 选中未生效: ${option}`);
  return option;
}

/** 商品状态：上架 / 下架 */
export async function setShelfStatus(page, status) {
  const want = status === '上架' ? '上架' : '下架';
  return setRadioOption(page, { label: '商品状态', option: want, mark: 'shelf' });
}

/** 订单库存计数：下单减库存 / 付款减库存 */
export async function setStockDeductMode(page, mode) {
  if (!mode) return null;
  return setRadioOption(page, { label: '订单库存计数', option: mode, mark: 'stockmode' });
}

/**
 * 现货发货时间：当日发 / 次日发 / 48小时。
 * 宽容写法：「48小时发货」「48 小时」都归一到页面上的「48小时」。
 */
export async function setShipTime(page, value) {
  if (!value) return null;
  const raw = String(value).replace(/\s/g, '');
  const option = /48/.test(raw) ? '48小时'
    : /当日/.test(raw) ? '当日发'
      : /次日/.test(raw) ? '次日发'
        : raw;
  return setRadioOption(page, { label: '现货发货时间', option, mark: 'shiptime' });
}

/** ---------- 尺码表 ---------- */

/** 套用已存的尺码表模板（模板自带各尺码的身高/体重区间值） */
export async function applySizeTemplate(page, name) {
  if (!name) return null;
  await page.eval(`
    const s = [...document.querySelectorAll('.ecom-g-select')]
      .find(x => /一键复用尺码信息/.test(x.innerText));
    if (!s) return false;
    s.setAttribute('data-dp', 'sizetpl');
    s.scrollIntoView({ block: 'center' });
    return true;
  `);
  await sleep(800);
  await page.clickReal('[data-dp=sizetpl]');
  // 尺码表模板同样靠接口拉
  await waitDropdownOptions(page, { label: '尺码表模板列表加载' });

  const r = await page.eval(`
    const d = [...document.querySelectorAll('.ecom-g-select-dropdown')].find(x => x.offsetParent);
    if (!d) return { error: '尺码表模板下拉未展开' };
    const opts = [...d.querySelectorAll('.ecom-g-select-item-option')];
    const t = opts.find(o => o.innerText.includes(${JSON.stringify(name)}));
    if (!t) return { error: '未找到尺码表模板，可选: ' + opts.map(o => o.innerText.trim()).join('、') };
    ['mouseover','mousedown','mouseup','click'].forEach(e =>
      t.dispatchEvent(new MouseEvent(e, { bubbles: true, cancelable: true, view: window })));
    return { ok: true };
  `);
  if (r.error) throw new Error(r.error);
  await sleep(4000);
  return name;
}

/** ---------- 校验与提交 ---------- */

/** 跑「填写检查」，返回错误条目 */
export async function runValidation(page) {
  await page.eval(`
    const b = [...document.querySelectorAll('button')].find(x => /填写检查/.test(x.innerText));
    if (b) b.click();
    return !!b;
  `);
  await sleep(6000);

  const result = await page.eval(`
    const t = document.body.innerText;
    const m = t.match(/(\\d+)个错误问题待处理/);
    const count = m ? Number(m[1]) : 0;
    let detail = '';
    const i = t.indexOf('错误提示');
    if (i >= 0) detail = t.slice(i, i + 300);
    const toasts = [...new Set([...document.querySelectorAll('[class*=message]')]
      .filter(x => x.offsetParent).map(x => x.innerText.trim().slice(0, 80)))];
    return { count, detail, toasts };
  `);

  // 「填写检查」在无错误时仍会弹出“发布提醒”确认框，必须先点“返回确认”，
  // 否则弹窗会遮挡底部的“保存草稿”按钮，导致 draft 流程停在检查弹窗。
  if (result.count === 0) {
    await page.eval(`
      const b = [...document.querySelectorAll('button')]
        .find(x => x.offsetParent && /返回确认/.test(x.innerText));
      if (b) b.click();
    `);
    await sleep(800);
  }
  return result;
}

/** 保存草稿（不发布）。返回 true 表示看到成功提示 */
export async function saveDraft(page) {
  await dismissModals(page);
  await page.eval(`
    const b = [...document.querySelectorAll('button')]
      .find(x => x.offsetParent && /保存草稿/.test(x.innerText));
    if (!b) return false;
    b.setAttribute('data-dp', 'savedraft');
    b.scrollIntoView({ block: 'center' });
    return true;
  `);
  await sleep(800);
  await page.clickReal('[data-dp=savedraft]');
  await sleep(8000);
  return await page.eval(`
    const t = document.body.innerText;
    return /保存成功|草稿|已保存/.test(t);
  `);
}

/** 正式发布商品 */
export async function publishProduct(page) {
  await dismissModals(page);
  await page.eval(`
    const b = [...document.querySelectorAll('button')]
      .find(x => x.offsetParent && x.innerText.trim() === '发布商品');
    if (!b) return false;
    b.setAttribute('data-dp', 'publish');
    b.scrollIntoView({ block: 'center' });
    return true;
  `);
  await sleep(800);
  await page.clickReal('[data-dp=publish]');
  await sleep(10000);
  return await page.eval(`
    return { url: location.href, text: document.body.innerText.slice(0, 400) };
  `);
}

/** 关闭挡住操作的提示、AI 工具抽屉等覆盖层。 */
export async function dismissModals(page) {
  for (let i = 0; i < 5; i += 1) {
    const kind = await page.eval(`
      const drawer = [...document.querySelectorAll('.auxo-drawer')]
        .find(x => x.offsetParent && x.querySelector('button[aria-label="Close"]'));
      if (drawer) {
        const b = drawer.querySelector('button[aria-label="Close"]');
        b.setAttribute('data-dp', 'drawer-close');
        return 'drawer';
      }
      const ack = [...document.querySelectorAll('button')]
        .find(x => x.offsetParent && /^(我知道了|知道了|关闭)$/.test(x.innerText.trim()));
      if (ack) {
        ack.setAttribute('data-dp', 'ack');
        return 'ack';
      }
      return '';
    `);
    if (!kind) return;
    await page.clickReal(kind === 'drawer' ? '[data-dp=drawer-close]' : '[data-dp=ack]').catch(() => {});
    await sleep(1000);
  }
}

