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
 *            取值：image（需先上传主图）、ai-live（需 AI 弹层正开着，
 *            但弹层选完即关，所以 doctor 里这类项总是「跳过」）、
 *            style-live（同理：风格下拉选完就收起）、
 *            category（需先填标题并开类目弹层）、
 *            step2（需先进详情表单）、manual（需先切手动填写）、sku（需先建好规格值）。
 *   soft  —— 该项未命中不算「失效」：doudian-page.mjs 对它另有几何/文案兜底路径，
 *            选择器只是加速命中的第一道尝试。doctor 会报成提醒而不是错误。
 *
 * 改动前先读 references/dom-notes.md，那里记着每处的交互序列约束。
 */

/** 语义化优先级：先试 hash，命中不了再逐个试 alt */
export const SEL = {
  // ---------- 新版智能填写前置页 ----------
  materialUploadInput: {
    hash: 'input[type=file][accept=".jpg,.png,.jpeg,.csv,.xls,.xlsx"]',
    alt: ['input[data-testid="pub-by-pic-card-dragger"]'],
    note: '智能填写助手资料上传 input（至少包含一张商品图）',
    stage: 'step1',
  },
  materialNextButton: {
    hash: 'button.styles-module_nextButton__Y91rv',
    alt: [],
    note: '资料上传页「下一步，生成商品」按钮',
    stage: 'step1',
  },
  smartConfirmButton: {
    hash: 'button.style_aiPublishButton__DLNg7',
    alt: ['button[class*=aiPublishButton]'],
    note: '智能填写页「确认信息，继续生成」按钮',
    stage: 'step1',
    needs: 'image',
  },

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
  aiTitleButton: {
    hash: '.ecom-g-input-suffix img',
    alt: ['.ecom-g-dropdown-trigger .ecom-g-input-suffix img'],
    note: 'AI 标题按钮（标题框 suffix 里的 20×20 img，无 class，紧挨字数计数器 0/60）。代码另有几何兜底',
    stage: 'step1',
    needs: 'image',
    soft: true,
  },
  aiTitleOption: {
    hash: '.ecom-g-dropdown-menu .ecom-g-dropdown-menu-item',
    alt: ['.ecom-g-dropdown-menu li'],
    note: 'AI 推荐标题列表项（点 AI 后弹出的 ecom-g-dropdown，取位置最上那条；底部「重新生成」按钮靠文案黑名单排除）',
    stage: 'step1',
    // 注意：弹层选完就关了，事后探不到。doctor 靠 aiTitleAndCategory 的回报
    // 判它通不通（needs: 'ai-live' 永远不会被标为已满足，因此总是「跳过」），
    // 而不是事后去 querySelector —— 否则会报假失效。
    needs: 'ai-live',
    soft: true,
  },
  categoryHistory: {
    hash: '.style_searchHistoryItems__FdSkW',
    alt: ['div[class*=searchHistoryItems]'],
    note: '类目「最近创建」快捷项（需先点「手动选择类目」开弹层）',
    stage: 'step1',
    needs: 'category',
  },
  // ---------- 第二步页 ----------
  fabricSelect: {
    hash: '.aurora-dorami-composition-select-select',
    alt: ['.aurora-dorami-composition-select-wrapper', '[class*=composition-select]'],
    note: '面料材质选择器（点外层容器，不要点 4px 宽的内部 aurora-select-input）',
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
  shortTitleInput: {
    hash: 'input[dropdownclassname="auto-dropdown-id-导购短标题"]',
    alt: ['input[placeholder*="简明准确的标题内容"]'],
    note: '导购短标题输入框（suffix 里的 20×20 img 就是 AI 按钮，点完 5-7s 直接回填，不弹推荐列表）',
    stage: 'step2',
    needs: 'step2',
  },
  // 风格是 ecom-g-tree-select（非 ecom-g-select），选项虚拟滚动，靠搜索框过滤命中。
  // 详见 references/style-options.md。
  styleSelect: {
    hash: '.styles_multiSelect__Nmxaq.ecom-g-tree-select',
    alt: ['.ecom-g-tree-select.ecom-g-select-multiple'],
    note: '风格多选框（最多 5 项）。代码另有「风格文案→兄弟节点」的文案兵底',
    stage: 'step2',
    needs: 'step2',
    soft: true,
  },
  styleTreeNode: {
    hash: '.ecom-g-tree-select-dropdown .ecom-g-select-tree-title',
    alt: ['.ecom-g-select-tree-node-content-wrapper'],
    note: '风格选项节点文案（面板需已展开）',
    stage: 'step2',
    needs: 'style-live',
    soft: true,
  },

  // ---------- 规格设置 ----------
  specSwitchButton: {
    hash: '[data-dp=manualspec]',
    alt: ['button[class*=switchButton]'],
    note: '从「智能填写助手」切到手动填写的按钮（现按文案「切换手动填写」定位）',
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
  // 尺码面板有两种随机切换的视图，两边的选项容器类名完全不同（一个是
  // li.ecom-g-cascader-menu-item，一个是带 CSS Modules 哈希的 div）。所以 setSizes
  // 不按类名找选项，而是抽两边共同的结构不变量：
  // 「面板里的 input[type=checkbox] + 从它往上走找到的短文案祖先」。
  // 因此这里**故意不登记**尺码选项的哈希 —— 登了反而会让 doctor 报假阳性
  // （哈希变了但功能完好）。参见 references/dom-notes.md「尺码」节。
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
