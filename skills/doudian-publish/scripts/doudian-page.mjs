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
import { sleep, DOUDIAN_HOME } from './cdp.mjs';

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
 */
export async function prepareSmartFill(page, file) {
  const landing = await page.eval(`return !!document.querySelector(
    'input[type=file][accept=".jpg,.png,.jpeg,.csv,.xls,.xlsx"]'
  ) && !!(document.querySelector('button.styles-module_nextButton__Y91rv')
    || [...document.querySelectorAll('button')].find(
      b => b.offsetParent && b.innerText.trim() === '下一步，生成商品'
    ));`).catch(() => false);
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

/** 上传剩余主图（辅助图槽位，一次可传多张；兼容新旧首图页） */
export async function uploadExtraImages(page, files) {
  if (!files.length) return;
  const countExpr = `new Set([
    ...document.querySelectorAll('div.material-preview-button img'),
    ...document.querySelectorAll('div.index-module_batchImageUpload__JtBRX img'),
  ]).size`;
  const before = await page.eval(`return ${countExpr}`).catch(() => 0);
  await page.setFiles('div.material-upload-button input[type=file]', files);
  await page.waitFor(
    `return ${countExpr} >= ${before + files.length}`,
    { label: '辅助图上传完成', timeoutMs: 90000 },
  );
  await sleep(1000);
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
      return t.includes('商品详情图') && t.includes('价格库存')
        && !t.includes('继续解析你上传的材料');
    `, { label: '完成 AI 解析并进入详情表单', timeoutMs: 120000 });
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
  await sleep(1500);
  return await page.eval(`
    const t = document.body.innerText;
    const i = t.indexOf('面料材质');
    return t.slice(i, i + 40).split('\\n').slice(1, 2).join('');
  `);
}

/** 品牌：ecom-g-select，需要先输入再选。无品牌时传 '无品牌' */
export async function setBrand(page, brand = '无品牌') {
  await page.eval(`
    const s = [...document.querySelectorAll('.ecom-g-select')]
      .find(x => /请输入需要关联的品牌/.test(x.innerText));
    if (!s) return false;
    const i = s.querySelector('input');
    s.scrollIntoView({ block: 'center' });
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    i.focus(); i.click(); set.call(i, ${JSON.stringify(brand)});
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
  const deadline = Date.now() + 20000;
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

