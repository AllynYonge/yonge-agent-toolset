/**
 * 抖店发布页选择器的单一来源。
 *
 * 为什么要单独一个文件：页面上大量选择器是 CSS Modules 构建产物
 * （形如 `style_forCreate__c19CW`），抖店前端发一次版哈希就全变，
 * 而失效表现是「等待超时」这类间接报错，得逐个去页面上翻。
 * 集中在这里 + 配语义化 fallback，改版时只改一处，并且 doctor.mjs
 * 能一次性告诉你哪几条失效了。
 *
 * 每条约定：
 *   hash  —— 实测命中的 CSS Modules 选择器（脆，随发版失效）
 *   alt   —— 语义化兜底选择器数组（按结构/属性定位，抗改版）
 *   text  —— 用于兜底的可见文案（正则源串），配合 byText 使用
 *   note  —— 这个选择器指向什么，doctor 输出时会打印
 *   needs —— 需要什么页面状态才存在。空表示白页就在。
 *            doctor 靠这个区分「真失效」和「本次条件不具备」，
 *            否则会把空白发布页上本就不存在的元素误报成选择器坏了。
 *
 * 改动前先读 references/dom-notes.md，那里记着每处的交互序列约束。
 */

/** needs 的取值含义 */
export const NEEDS = {
  IMAGE: 'image',       // 需先上传主图
  CATEGORY: 'category', // 需先填标题（等 AI 识别）+ 点「手动选择类目」开弹层
  STEP2: 'step2',       // 需先点「下一步」进详情表单
  MANUAL: 'manual',     // 需先从「智能填写助手」切到手动填写
  SKU: 'sku',           // 需先建好规格值，SKU 表才会生成
};

/** 语义化优先级：先试 hash，命中不了再逐个试 alt */
export const SEL = {
  // ---------- 第一步页 ----------
  firstImageInput: {
    hash: 'input[type=file][accept="image/*"]',
    alt: ['div.material-preview-button input[type=file]'],
    note: '首图上传 input',
    stage: 'step1',
  },
  extraImageInput: {
    hash: 'div.material-upload-button input[type=file]',
    alt: ['input[type=file][multiple][accept*="image"]'],
    note: '辅助图上传 input（一次可多张）',
    stage: 'step1',
  },
  uploadedImageCount: {
    hash: 'div.index-module_batchImageUpload__JtBRX img',
    alt: ['div[class*=batchImageUpload] img'],
    note: '已上传主图计数用的 img',
    stage: 'step1',
    needs: 'image',
  },
  titleInput: {
    hash: 'input.ecom-g-input',
    alt: ['input[placeholder*="标题"]'],
    note: '商品标题输入框（第一步页只有这一个）',
    stage: 'step1',
  },
  categoryHistory: {
    hash: '.style_searchHistoryItems__FdSkW',
    alt: ['div[class*=searchHistoryItems]'],
    note: '类目「最近创建」快捷项（需先点「手动选择类目」开弹层）',
    stage: 'step1',
    needs: 'category',
  },
  categorySelector: {
    hash: '[class*=categorySelectorV2]',
    alt: ['[class*=allCategory]', '[class*=categoryGroupTitle]'],
    note: '类目选择器弹层容器',
    stage: 'step1',
    needs: 'category',
  },
  categoryConfirm: {
    hash: 'button.ecom-g-btn-primary',
    alt: [],
    note: '类目弹层的确认按钮',
    stage: 'step1',
  },

  // ---------- 第二步页 ----------
  fabricSelect: {
    hash: 'aurora-dorami-composition-select',
    alt: ['[class*=composition-select]'],
    note: '面料材质选择器（材质+含量两段式）',
    stage: 'step2',
    needs: 'step2',
  },
  detailImageInput: {
    hash: '.styles_decorateImgEditTitleWrapper__wfpvu input[type=file]',
    alt: ['div[class*=decorateImgEdit] input[type=file]'],
    note: '详情图上传 input',
    stage: 'step2',
    needs: 'step2',
  },

  // ---------- 规格设置 ----------
  specSwitchButton: {
    hash: 'button.style_switchButton__guvWZ',
    alt: ['button[class*=switchButton]'],
    note: '从「智能填写助手」切到手动填写的按钮',
    stage: 'spec',
    needs: 'step2',
  },
  specForCreate: {
    hash: '.style_forCreate__c19CW',
    alt: ['div[class*=forCreate]'],
    note: '追加新规格值的空位容器（点已有值的 picker 会覆盖，别用错）',
    stage: 'spec',
    needs: 'manual',
  },
  specForCreatePicker: {
    hash: '.style_forCreate__c19CW .ecom-g-cascader-picker',
    alt: ['div[class*=forCreate] .ecom-g-cascader-picker'],
    note: '追加位的 cascader picker',
    stage: 'spec',
    needs: 'manual',
  },
  specForCreateInput: {
    hash: '.style_forCreate__c19CW input.ecom-g-cascader-input',
    alt: ['div[class*=forCreate] input.ecom-g-cascader-input'],
    note: '追加位的搜索输入框',
    stage: 'spec',
    needs: 'manual',
  },
  specNameInput: {
    hash: 'input.styles_skuNameInput__eV89r',
    alt: ['input[class*=skuNameInput]'],
    note: '自定义规格值的最终名称输入框',
    stage: 'spec',
    needs: 'sku',
  },
  specValueBox: {
    hash: '.style_specValueBox__i8sD6',
    alt: ['div[class*=specValueBox]'],
    note: '规格值区容器（第一个=颜色分类，最后一个=尺码）',
    stage: 'spec',
    needs: 'manual',
  },
  specValueRow: {
    hash: '.style_skuValue__QyAOk',
    alt: ['div[class*=skuValue]'],
    note: '单个规格值行（含 picker、备注框、规格图上传位）',
    stage: 'spec',
    needs: 'sku',
  },
  specConfirmCheck: {
    hash: '[data-kora=确认]',
    alt: [],
    note: '绿色 ✓，把新值加入候选并自动勾选',
    stage: 'spec',
    needs: 'sku',
  },

  // ---------- SKU 表 ----------
  skuTable: {
    hash: '.styles_customVirtualTable__nLhAS',
    alt: ['div[class*=customVirtualTable]'],
    note: 'SKU 价格库存表（窗口化虚拟表）',
    stage: 'sku',
    needs: 'sku',
  },
  skuScrollHolder: {
    hash: '.ecom-g-table-tbody-virtual-holder',
    alt: [],
    note: '虚拟表滚动容器（必须滚它自己，不是 window）',
    stage: 'sku',
    needs: 'sku',
  },
  skuScrollInner: {
    hash: '.ecom-g-table-tbody-virtual-holder-inner',
    alt: [],
    note: '虚拟表内层，translateY 用于算行全局下标',
    stage: 'sku',
    needs: 'sku',
  },
};

/** SKU 表单元格按 placeholder 区分，比列下标稳 */
export const SKU_CELL = {
  price: '请输入',
  stock: '请输入库存',
  code: '请输入erp编码',
  barcode: '请输入条形码',
};

/** 关键文案锚点。页面改版时文案通常比类名稳定，用于兜底与 doctor 校验。 */
export const TEXT = {
  manualSpecReady: '*商品规格',
  detailImageCount: /商详图片（(\d+)\/50）/,
  validationError: /(\d+)个错误问题待处理/,
  validationPass: '必填项已完成',
  publishOk: /发布成功|提交成功|审核中/,
  draftOk: /保存成功|草稿|已保存/,
};

/**
 * 取一个选择器的全部候选（hash 优先，然后 alt）。
 * 页面交互代码应该用这个而不是直接写死字符串。
 */
export function candidates(key) {
  const s = SEL[key];
  if (!s) throw new Error(`未知选择器: ${key}`);
  return [s.hash, ...(s.alt ?? [])].filter(Boolean);
}

/** 生成一段 JS：按候选顺序找元素，返回第一个命中的（供 page.eval 用） */
export function queryExpr(key) {
  const list = candidates(key);
  return `(() => {
    for (const s of ${JSON.stringify(list)}) {
      const el = document.querySelector(s);
      if (el) return { el, sel: s };
    }
    return null;
  })()`;
}
