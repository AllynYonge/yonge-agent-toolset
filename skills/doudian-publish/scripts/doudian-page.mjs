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
import { sleep } from './cdp.mjs';

const CREATE_URL = 'https://fxg.jinritemai.com/ffa/g/create';

/** ---------- 第一步页：主图 + 标题 + 类目 ---------- */

export async function openCreatePage(openPage) {
  const page = await openPage(CREATE_URL);
  // 先等 SPA 真正渲染（readyState 到 interactive 时表单还不存在），再找上传控件。
  await page.waitRendered({ timeoutMs: 60000 });
  await page.waitFor(
    `return !!document.querySelector('div.material-preview-button input[type=file]')
         || !!document.querySelector('input[type=file][accept="image/*"]')
         || document.body.innerText.includes('上传主图')`,
    { label: '发布页首图上传控件', timeoutMs: 30000 },
  );
  return page;
}

/** 上传首图（触发平台 AI 识别，随后才会出现标题推荐与类目推荐） */
export async function uploadFirstImage(page, file) {
  await page.setFiles('input[type=file][accept="image/*"]', [file]);
  await page.waitFor(
    `return document.querySelectorAll('div.material-upload-button input[type=file]').length > 0`,
    { label: '首图上传完成', timeoutMs: 60000 },
  );
  await sleep(1500);
}

/** 上传剩余主图（辅助图槽位，一次可传多张） */
export async function uploadExtraImages(page, files) {
  if (!files.length) return;
  await page.setFiles('div.material-upload-button input[type=file]', files);
  await page.waitFor(
    `return document.querySelectorAll('div.index-module_batchImageUpload__JtBRX img').length >= ${files.length}`,
    { label: '辅助图上传完成', timeoutMs: 90000 },
  );
  await sleep(1000);
}

export async function fillTitle(page, title) {
  await page.setInput('input.ecom-g-input', title);
  await sleep(2000);
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

export async function gotoStepTwo(page) {
  await page.eval(`
    const b = [...document.querySelectorAll('button')].find(x => x.innerText.trim() === '下一步');
    if (b) b.click();
    return !!b;
  `);
  await page.waitFor(`return document.body.innerText.includes('类目属性')`, {
    label: '进入详情表单页', timeoutMs: 60000,
  });
  await sleep(2000);
}

/** ---------- 第二步页：属性 ---------- */

/**
 * 面料材质：aurora composition-select，材质 + 含量两段。
 * 这个下拉和 ecom-g-select 一样，必须真实鼠标点击才会展开。
 */
export async function setFabric(page, pairs) {
  await page.waitFor(`return !!document.querySelector('input.aurora-select-input')`, {
    label: '面料材质控件渲染', timeoutMs: 30000,
  });
  await page.eval(`
    const i = document.querySelector('input.aurora-select-input');
    const box = i.closest('.aurora-select') || i.parentElement;
    box.setAttribute('data-dp', 'fabric');
    box.scrollIntoView({ block: 'center' });
    return true;
  `);
  await sleep(800);
  await page.clickReal('[data-dp=fabric]');
  await sleep(2000);

  for (const [name, pct] of pairs) {
    await page.waitFor(
      `return !!document.querySelector('input.aurora-dorami-composition-select-search')`,
      { label: '材质搜索框', timeoutMs: 15000 },
    );
    await page.eval(`
      const i = document.querySelector('input.aurora-dorami-composition-select-search');
      const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      i.focus(); set.call(i, ${JSON.stringify(name)});
      i.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    `);
    await sleep(2000);

    const picked = await page.eval(`
      const d = [...document.querySelectorAll('.aurora-dorami-composition-select-select-popup')]
        .find(x => x.offsetParent);
      if (!d) return null;
      const opts = [...d.querySelectorAll('[class*=option-label]')];
      const exact = opts.find(o => o.textContent.trim() === ${JSON.stringify(name)});
      const target = exact || opts[0];
      if (!target) return null;
      target.click();
      return target.textContent.trim();
    `);
    if (!picked) throw new Error(`面料材质未找到候选: ${name}`);
    await sleep(1500);

    await page.eval(`
      const d = [...document.querySelectorAll('.aurora-dorami-composition-select-select-popup')]
        .find(x => x.offsetParent);
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
  await sleep(2500);

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

/** 从「智能填写助手」切到手动填写模式 */
export async function switchToManualSpec(page) {
  const already = await page.eval(`return document.body.innerText.includes('*商品规格')`);
  if (already) return;
  await page.click('button.style_switchButton__guvWZ');
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
    await sleep(1200);

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

  const now = await listSpecValues(page);
  if (!now.includes(value)) throw new Error(`规格值写入失败: ${value}（当前: ${now.join('、')}）`);
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
 * 尺码组：走标准 checkbox 勾选，平台已有 XS-16XL 全套。
 *
 * 坑：`label.click()` 对这些 checkbox **无效**（实测点完 className 仍无 checked）。
 * 必须向内层 `input` 派发 mouseover/mousedown/mouseup/click 才会勾上。
 * 之前用 label.click() 导致静默失败：函数不报错，但尺码一个都没选上，
 * 后面 SKU 表只生成 3 行（只有规格值维度）而不是 12 行。
 *
 * 另外这个 cascader 用 `el.click()` 就能展开（与颜色分类不同，
 * 那个需要真实鼠标）；对它用 clickReal 反而会把已展开的面板点关。
 */
export async function setSizes(page, sizes) {
  await page.eval(`
    const p = [...document.querySelectorAll('.ecom-g-cascader-picker')]
      .find(x => /请选择尺码大小/.test(x.innerText));
    if (!p) return false;
    p.scrollIntoView({ block: 'center' });
    p.click();
    return true;
  `);
  await sleep(2500);

  const result = await page.eval(`
    const d = [...document.querySelectorAll('[class*=cascader-menus]')].find(x => x.offsetParent);
    if (!d) return { error: '尺码下拉未展开' };
    const want = ${JSON.stringify(sizes)};
    const labs = [...d.querySelectorAll('label.ecom-g-checkbox-wrapper')];
    const missing = [], clicked = [], already = [];
    for (const s of want) {
      const l = labs.find(x => x.innerText.trim() === s);
      if (!l) { missing.push(s); continue; }
      if (l.className.includes('checked')) { already.push(s); continue; }
      const i = l.querySelector('input');
      if (!i) { missing.push(s); continue; }
      // label.click() 对这个组件无效，必须向 input 派发完整鼠标事件序列
      for (const t of ['mouseover', 'mousedown', 'mouseup', 'click']) {
        i.dispatchEvent(new MouseEvent(t, { bubbles: true }));
      }
      clicked.push(s);
    }
    const checked = labs.filter(l => l.className.includes('checked')).map(l => l.innerText.trim());
    return { missing, clicked, already, checked };
  `);
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

  // 确认尺码已写入规格区
  const written = await listSizeValues(page);
  const miss = sizes.filter((s) => !written.includes(s));
  if (miss.length) {
    throw new Error(`尺码写入规格区失败: ${miss.join('、')}（当前: ${written.join('、') || '无'}）`);
  }
  return written;
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
    const tr = [...w.querySelectorAll('tr')].find(r => r.querySelectorAll('input').length > 0);
    if (!tr) return { error: 'SKU 表无数据行' };
    const rowH = Math.round(tr.getBoundingClientRect().height) || 61;
    return { rowH, scrollHeight: Math.round(h.scrollHeight), clientHeight: Math.round(h.clientHeight),
             total: Math.round(h.scrollHeight / rowH) };
  `);
  if (geo.error) throw new Error(geo.error);

  if (geo.total !== rows.length) {
    throw new Error(`SKU 行数不匹配: 页面 ${geo.total} 行，预期 ${rows.length} 行`);
  }

  const filled = new Array(rows.length).fill(null);
  const step = Math.max(1, Math.floor(geo.clientHeight / geo.rowH) - 1);

  // 逐窗口滚动，每次只填当前 DOM 里存在的行，按全局下标写入
  for (let top = 0; ; top += step * geo.rowH) {
    await page.eval(`
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
      for (const r of [...w.querySelectorAll('tr')]) {
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

    if (top + geo.clientHeight >= geo.scrollHeight) break;
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
  await sleep(2500);

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

/** 商品状态：上架 / 下架 */
export async function setShelfStatus(page, status) {
  const want = status === '上架' ? '上架' : '下架';
  await page.eval(`
    const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let n;
    while (n = w.nextNode()) {
      if (n.nodeValue.trim() === '商品状态') {
        let p = n.parentElement;
        for (let k = 0; k < 7; k++) {
          p = p.parentElement; if (!p) break;
          const rs = [...p.querySelectorAll('input[type=radio]')];
          if (rs.length >= 2) {
            const t = rs.find(r => r.closest('label').innerText.trim() === ${JSON.stringify(want)});
            if (!t) return false;
            const l = t.closest('label');
            l.setAttribute('data-dp', 'shelf');
            l.scrollIntoView({ block: 'center' });
            return true;
          }
        }
      }
    }
    return false;
  `);
  await sleep(800);
  await page.clickReal('[data-dp=shelf]');
  await sleep(1500);
  return await page.eval(`
    const l = document.querySelector('[data-dp=shelf]');
    const r = l.querySelector('input[type=radio]');
    return r.checked ? ${JSON.stringify(want)} : null;
  `);
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
  await sleep(2500);

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

  return await page.eval(`
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

/** 关掉挡住按钮的「我知道了」等提示弹窗 */
export async function dismissModals(page) {
  for (let i = 0; i < 3; i += 1) {
    const found = await page.eval(`
      const b = [...document.querySelectorAll('button')]
        .find(x => x.offsetParent && /^(我知道了|知道了|关闭)$/.test(x.innerText.trim()));
      if (!b) return false;
      b.setAttribute('data-dp', 'ack');
      return true;
    `);
    if (!found) return;
    await page.clickReal('[data-dp=ack]').catch(() => {});
    await sleep(1500);
  }
}

/** ---------- 查重 ---------- */

/**
 * 按货号在商品管理里查是否已存在同款（含草稿箱）。
 *
 * 为什么需要：同一份货盘跑两次就会建出两批重复商品，抖店那边清理很麻烦。
 * 走列表页的搜索框而不是接口，避免额外的鉴权与签名问题。
 *
 * 返回 { exists, count, hint }。查不动时返回 exists:false + hint，
 * 由调用方决定是放行还是中止 —— 查重失败不该阻断整个批次。
 */
export async function findExistingByCode(page, code) {
  const url = 'https://fxg.jinritemai.com/ffa/g/list?tab=all';
  await page.navigate(url);
  await page.waitRendered({ timeoutMs: 45000 }).catch(() => {});
  await sleep(2500);

  // 搜索类型可能默认是「商品名称」，先切到「货号」；切不了就直接搜，
  // 抖店的全局搜索一般也能命中货号。
  const typed = await page.eval(`
    const ins = [...document.querySelectorAll('input')]
      .filter(x => x.offsetParent && /搜索|请输入/.test(x.placeholder || ''));
    const i = ins.find(x => /货号|商品/.test(x.placeholder)) || ins[0];
    if (!i) return false;
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    i.focus();
    set.call(i, ${JSON.stringify(code)});
    i.dispatchEvent(new Event('input', { bubbles: true }));
    i.setAttribute('data-dp', 'dedup-input');
    return true;
  `);
  if (!typed) return { exists: false, count: 0, hint: '未找到商品列表的搜索框，已跳过查重' };

  // 回车触发搜索
  for (const type of ['keyDown', 'keyUp']) {
    await page.cdp.send('Input.dispatchKeyEvent', {
      type, key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13,
    }, page.sessionId).catch(() => {});
  }
  await sleep(5000);

  return await page.eval(`
    const t = document.body.innerText;
    if (/暂无数据|没有找到|无搜索结果/.test(t)) return { exists: false, count: 0 };
    const rows = [...document.querySelectorAll('tbody tr')]
      .filter(r => r.offsetParent && r.innerText.includes(${JSON.stringify(code)}));
    return { exists: rows.length > 0, count: rows.length };
  `);
}
