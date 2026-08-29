---
name: dom-notes
description: 抖店商品发布页的 DOM 结构与交互坑位记录，改动 doudian-page.mjs 前必读
---

# 抖店发布页 DOM 笔记

页面：`https://fxg.jinritemai.com/ffa/g/create`
组件库：两套混用 —— `ecom-g-*`（旧，rc-* 系）和 `aurora-*`（新）。
两套的展开方式、事件要求都不一样，不能用同一套办法处理。

以下全部为实测结论。改选择器前先在真实页面上验证，不要凭猜测改。

本文只讲发布页 DOM。浏览器接入、登录态检测、调试端点与 wsUrl 缓存属于 `cdp.mjs`
的范畴，见 [browser-setup.md](browser-setup.md)「机制与实测」。

## 页面版本：两条路径

直接打开 `/ffa/g/create` 时，页面可能先进入「商品发布 / 智能填写助手」资料页（新版），
也可能直接出现首图上传表单（旧版）。脚本自动识别，新版为主路径、旧版为回退。

**差异只在进入完整编辑页之前**（单款 12 步里的第 1/3/5 步）。一旦进到编辑页，
面料、品牌、货号、规格、尺码表、价格库存、服务履约全部共用同一套 DOM。
所以平台再出新版时，改动面通常也只在这三步——下面按版本分节，共用部分在后面。

## 新版：资料上传 + 智能填写助手（2026-08-29 实测）

### 资料上传页

- 统一资料 input：`input[type=file][accept=".jpg,.png,.jpeg,.csv,.xls,.xlsx"]`，`multiple`。
- 支持商品图、Excel、CSV、截图等资料，最多 20 个文件，至少有一张不小于 `600×600` 的商品图。
- 上传后按钮文案为「下一步，生成商品」，实测类名为
  `styles-module_nextButton__Y91rv`。
- 必须先上传资料，再点击该按钮；按钮上传完成前是 disabled。
- 该页上传的首图会自动带入下一页主图位，因此新版不要再调用旧版
  `uploadFirstImage()` 重复上传首图。

### 智能填写确认页

- 下一页显示“智能填写助手”和“已智能为你填写部分商品信息，请确认后继续生成”。
- 平台异步预填标题和类目；识别未完成时「确认信息，继续生成」按钮 disabled。
- 实测按钮类名为 `style_aiPublishButton__DLNg7`。
- 必须等待按钮解除 disabled 后再点击「确认信息，继续生成」。
- 点击后页面会先显示：
  `继续解析你上传的材料，AI将自动帮你填好表单，预计需要5～10秒`。
- 必须等待该提示消失，并确认“商品详情图”和“价格库存”等完整表单区出现，
  才算进入后续属性/SKU 流程。

### 完整编辑页新增区域

二次解析完成后进入一个长表单，顶部新增“商品信息质量分”“待完善信息”“继续上传材料”，
并增加或强化导购短标题、热搜词、主图 3:4 智能裁剪、主图视频、白底图、AI 智能创作等区域。
原有面料、品牌、货号、规格、尺码表、价格库存和服务履约区域仍存在。

## 选择器怎么维护

所有 CSS Modules 哈希选择器集中在 `scripts/selectors.mjs`，**不要散落在交互代码里**。
每条带语义化 `alt` 兜底，抖店改版时优先靠 `alt` 撑住，再回来更新 `hash`。

抖店改版后的排查顺序：

```bash
node scripts/doctor.mjs --launch     # 看哪些选择器失效 / 走了兜底
node scripts/selftest.mjs            # 改完常量表后验证一致性（离线）
```

`doctor.mjs` 输出里：

| 标记 | 含义 |
|------|------|
| `✓` | 命中首选 hash，正常 |
| `·` | hash 失效但兜底命中 —— 哈希已变，去更新 `selectors.mjs` |
| `✗` | 全部候选未命中 —— 得去真实页面上找新结构 |

`selftest.mjs` 会校验 `selectors.mjs` 与 `doudian-page.mjs` 里的哈希**双向一致**，
防止「改了常量表但交互代码还写着老哈希」这类静默不生效。

### 什么时候干脆别用哈希

`selectors.mjs` 是**体检清单**，只被 `doctor.mjs` / `selftest.mjs` 引用；
运行时代码里的选择器仍是各自硬编码的。所以往清单里登记一条，
并不等于运行时就有了兜底。

有些地方登记哈希反而有害 —— 典型是尺码面板：它有两种随机切换的视图，
两边选项容器的类名毫无共同点，登记任何一边都会让 `doctor` 报假阳性
（哈希变了但功能完好）。这类地方应该找结构不变量，
把哈希从运行时代码里彻底去掉，并在清单里留一条注释说明为什么不登记。

判断标准：能找到「不依赖类名也能唯一定位」的结构特征（某种标签、
某个 ARIA 属性、某种父子关系、可见文案）时，优先用它，
哈希只作为加速命中的第一道尝试。

## 通用坑位

### 1. `ecom-g-select` / `ecom-g-cascader` 必须真实鼠标点击

`el.click()` **不会**展开这些下拉。必须走 CDP `Input.dispatchMouseEvent`
派发真实的 `mousePressed` / `mouseReleased`（`cdp.mjs` 里的 `clickReal`）。

同样适用于 `aurora-select-input`（面料材质）。这个坑踩过两次：
第一次面料材质失败报 `Cannot read properties of null (reading 'focus')`，
第二次改成 `i.click()` 后报 `等待超时: 材质搜索框`，最后才确认必须真实点击。

### 2. 下拉选项要用 `dispatchEvent`，不要用坐标点击

下拉面板渲染在 portal 里，用的是 document 坐标而非 viewport 坐标。
`getBoundingClientRect()` 常常返回负数（实测出现过 `x:-9547, y:-14218`），
按这个坐标点击会打到屏幕外，静默无效。

正确做法：拿到选项元素后依次派发
`mouseover` → `mousedown` → `mouseup` → `click`（都要 `bubbles: true`）。

### 3. 受控输入框必须走原生 value setter

React 受控组件直接赋值 `input.value` 不会触发 onChange。必须：

```js
const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
input.focus();
set.call(input, '值');
input.dispatchEvent(new Event('input', { bubbles: true }));
```

### 3.1 写入结果要轮询，不要固定 sleep 后一次性读
点完「确定」到页面真的把值渲染出来，中间隔着组件重建（规格区、SKU 表都要重建）。
固定 `sleep(2500)` 后读一次，会**间歇性**读到空数组，报出一堆假错：

- `规格值写入失败: 上衣（当前: ）` —— 括号里是空的就是这个症状
- `尺码写入规格区失败: S、M、L、XL（当前: 无）`

都改成轮询（800ms 一次，上限 20s）：读到期望值立即返回，超时才报错。
凡是「操作后读回校验」的地方都该轮询，不用担心多等 ——
成功时它立即返回，只有真失败才走到超时。

### 3.2 开下拉要两种点法交替重试

面料材质那个 aurora 下拉，两种方式实测**各自都会偶发失效**：

- CDP 真实鼠标点击（`Input.dispatchMouseEvent`）
- 向 `.aurora-select-content` 派发 `mouseover`→`mousedown`→`mouseup`→`click`

单靠任何一种都出现过「等待超时: 材质搜索框」。现在 `ensureOpen()` 按尝试
次数奇偶交替两种点法，每次点完轮询 6s 看搜索框出没出来，最多 4 次。

定位可点容器要的是 `.aurora-dorami-composition-select-select`，**不是** `-wrapper`。
wrapper 在 DOM 里排在前面，把两者写进同一个 `querySelectorAll` 会按 DOM 顺序
取到 wrapper，点它间歇性不生效。弹层容器类名是
`.aurora-dorami-composition-select-dropdown`（早期写的 `-select-popup` 已不存在）。

### 3.3 等服务端返回的下拉，用 `waitDropdownOptions`

品牌 / 材质 / 运费模板 / 尺码表模板 这四个下拉的内容都是**接口返回**的，
比本地渲染更不可控。早期写法是 `sleep(2500)` 后读一次，网络稍慢就报：

```
品牌未找到: 无品牌
未找到模板，可选:            ← 可选项为空就是读早了的征候
面料材质未找到候选: 聚酯纤维
```

**报错里列出的可选项是空的，就不是真的没有，而是列表还没回来。**

统一走 `waitDropdownOptions(page, { match, label })`，`match` 传
`auto-dropdown-id-品牌` 这类正则源串用于区分同时存在的多个 dropdown。
成功时立即返回（比固定 sleep 快），只有真的没加载出来才等到超时。

### 3.4 sleep 带随机抖动，但轮询步进不能抖

`sleep()` 默认乘 [0.8, 1.75) 的随机系数。原因不是“等久一点更保险”，
而是固定的 800/1500/2500 每次跑一模一样，**方差为零这个特征本身就是自动化指纹**。
把固定值翻倍并不能改善这一点（一串精确的 3000ms 比 1500ms 更可疑），
只会让每款耗时翻倍。**可靠性靠条件等待，拟人度靠抖动，两件事分开做。**

以下位置必须用 `sleepExact`（不抖）：

| 位置 | 为何不能抖 |
|------|-----------|
| `waitFor` / `waitReady` / `waitRendered` 的轮询间隔 | 抖了实际轮询次数不确定，侵蚀超时预算 |
| `probeLogin` 的 `pollMs` | 等登录的进度提示靠它计时 |
| `clickReal` 内部鼠标事件间隔 | 它自己已经是随机的，再叠一层无意义 |
| 浏览器启动等待 | 纯基础设施，与页面行为无关 |

`DOUDIAN_NO_JITTER=1` 可关掉抖动（selftest 靠它保证可重现）。

### 3.5 `clickReal` 的手势特征

不要改回「瞬移到中心 → 按下 → 松开」。现在做了三件事：

1. **落点微偏**：在元素尺寸 1/4 以内、不超 4px 随机偏移。
   限制必须留着 —— 偏出元素就点不中了。
2. **分步移动**：从目标左上方分 3-5 步逼近，每步间隔 15-45ms。
3. **按压时长**：按下到松开停留 50-120ms。

移动阶段的 `mouseMoved` 带 `.catch(() => undefined)`：轨迹中的中间点可能落在
视口外而被 CDP 拒，那不影响最终点击，不该为此中断整个流程。

### 4. SPA 渲染晚于 `document.readyState`

`readyState` 到 `interactive` 时表单可能还没挂载，不能直接操作页面。
`page.waitRendered()` 现在优先等待发布页语义控件（如主图上传 input），
文本长度只作为兜底条件；不要把固定的 `body.innerText.length` 当成唯一就绪标准。
真实页面曾出现正文长度 180、表单已完整可用但旧阈值 200 误报超时的情况。

另外 `Target.createTarget` 传 `background: true` 时 Chromium 会推迟渲染，
SPA 可能长时间不挂载。`openPage` 现在默认前台打开并 `Page.bringToFront`。

### 4.1 工作台标签页复用

接管已打开的工作台 tab（而不是无条件新开）有三条约束，
见 [browser-setup.md](browser-setup.md)「工作台标签页复用」。

### 5. 关闭标签页前必须摘掉 `beforeunload`（严重）

发布页注册了 `beforeunload`。直接 `Target.closeTarget` 会弹出浏览器**原生**
「离开站点？」确认框。这个框由浏览器 UI 线程持有，没人点就会把整个浏览器
主线程卡死 —— DevTools 端口不再完成 WebSocket 握手，AppleScript 也超时，
只能强杀浏览器。

`Page.close()` 已做双保险：先注入代码摘掉 `beforeunload` 监听，
再订阅 `Page.javascriptDialogOpening` 自动 accept。别删这段逻辑。

## 旧版：第一步页 主图 + 标题 + 类目（回退路径）

新版识别失败时才走这条。以下选择器与流程仅属旧版；从「第二步页」起两版共用。

| 目标 | 选择器 / 做法 |
|------|--------------|
| 首图上传 | `input[type=file][accept="image/*"]` |
| 辅助图上传 | `div.material-upload-button input[type=file]`，`multiple`，一次可传多张 |
| 已上传图计数 | `div.index-module_batchImageUpload__JtBRX img` |
| 标题 | `input.ecom-g-input`（第一步页只有这一个） |
| AI 标题按钮 | `.ecom-g-input-suffix img`（20×20，无 class，紧挨计数器 `0/60`） |
| AI 推荐项 | `.ecom-g-dropdown-menu .ecom-g-dropdown-menu-item`（点 AI 后弹出） |
| 类目快捷项 | `.style_searchHistoryItems__FdSkW`，文案形如 `服装 > ... > 时尚套装` |
| 类目确认 | 弹层内 `button.ecom-g-btn-primary` |

**主图槽位上限 5 张**（4 个缩略图 + 1 个上传位）。首图单独一个 input，
其余 4 张走辅助图 input。

### AI 标题 → 自动类目（当前主路径）

上传主图后点标题框右侧的 AI 图标，下方弹出推荐标题列表，选第一条；
选中后**类目由平台自动填充**（实测得到「服装 > 女装 > 时尚套装」），
不需要再手动选类目。由 `aiTitleAndCategory()` 实现。

真实 DOM（已 dump 验过，坐标为实测值）：

```
span.ecom-g-input-affix-wrapper.ecom-g-dropdown-trigger   [252,349,706,32]
  input.ecom-g-input                                      [264,355,630,20]
  span.ecom-g-input-suffix                                [898,355,52,20]
    span 「0/60」  字数计数器                              [898,357,28,16]
    img          ← AI 按钮，**无 class**                  [930,355,20,20]

点击后弹出：
div.ecom-g-dropdown
  ul.ecom-g-dropdown-menu
    li.ecom-g-dropdown-menu-item   × 2（推荐标题）
    button 「重新生成」
```

四个实测踩坑点：

1. **AI 按钮没有任何类名**（连 CSS Modules 哈希都没有）。所以不能猜类名，
   主路径是「在 `.ecom-g-input-suffix` 容器内找 `img`」，兼验尺寸 14-30px 且与
   标题框同一垂直带。suffix 类名也变了才退到整页几何扫描。
   同容器里的字数计数器是 `span`，不会误取。
2. **页面上另有一行「标题推荐：…… 立即使用」**（`predictContentWrapper`），
   不点 AI 也存在，位置与弹层重叠，文案也像标题。它**不是** AI 弹层（需要点
   「立即使用」才生效）。必须限定在 `.ecom-g-dropdown-menu` 内查找推荐项，
   否则会点错对象、静默失败。
3. **弹层底部有「重新生成」按钮**，也带 `dropdown-menu-item` 类，
   靠文案黑名单排除。推荐项要按 `top` 排序取第一条，**不能用 DOM 顺序**。
4. **推荐接口会偶发不返回**（连续快跑时 3 次里赶上过 1 次）。
   `aiTitleAndCategory` 因此内置重试 1 次（间隔 2.5s），加重试后 3/3 通过。

AI 按钮和推荐项都要**真实鼠标点击**（`clickReal`）。
推荐列表异步返回，默认轮询 25s；类目也是异步填充，等 15s。
任一环节不成立就返回 `null`，**不抛错**，publish.mjs 回退到老流程
（`fillTitle` + `selectCategory`），不中断批量。

行为约定（已经用户确认）：
- **AI 标题优先**。走通时 Excel「商品标题」列被忽略，日志会明确提示。
- **类目以自动填充为准**。与 Excel「类目」列不一致只打警告，**不覆写**、不阻断。

两处选择器在 `selectors.mjs` 里标了 `soft: true`（未命中不计失效，因为有几何兜底）。
`aiTitleOption` 的 `needs` 是 `ai-live`：弹层选完即关，事后用选择器探不到，
所以 doctor 里这项永远显「跳过」，它通不通看输出里的「AI 标题路径」一行。

定位逻辑已在 `selftest.mjs` 用假 DOM 离线覆盖（含上述 4 个坑的回归用例），
真页面验证跑 `node scripts/doctor.mjs --image <1:1 主图>`（不提交、不存草稿）。

### 其他

填标题后平台也会异步跑 AI 识别，之后才出现「标题推荐」和类目推荐区。
走回退路径手填标题时，填完要 sleep ≥ 2s 再操作类目。

上传主图后平台可能自动打开「AI素材工具」抽屉（`.auxo-drawer`），
它会遮挡详情页控件。进入面料材质等后续步骤前必须先关闭可见的
`button[aria-label="Close"]`，当前由 `dismissModals()` 统一处理。

「最近创建」里如果已有目标类目，一次点击直达，比逐级点全部类目稳得多。
（仅适用于 AI 自动类目不可用、回退到手动选类目的情况。）

## 第二步页：类目属性

| 字段 | 控件 | 要点 |
|------|------|------|
| 面料材质 | `aurora-dorami-composition-select` | 材质+含量两段式，含量总和须为 100% |
| 品牌 | `ecom-g-select`，dropdown id = `auto-dropdown-id-品牌` | 默认「对门的猫」；无品牌就选「无品牌」选项 |
| 货号 | `input.ecom-g-input`（placeholder=请输入） | 填款号 |
| 导购短标题 | `input[dropdownclassname="auto-dropdown-id-导购短标题"]` | 非必填，0/24；靠 suffix 里的 AI 图标填 |
| 风格 | `ecom-g-tree-select` 多选 | 最多 5 项，选项虚拟滚动，见下 |

面料材质流程：真实点击 → 在弹层内 `input[placeholder=搜索材质]` 输入 →
点选项 → 在含量框填 `100` → 关闭弹层。
只输入不点选项不会生效（列表会停在默认项，看起来像搜索没反应）。

### 标签与控件是兄弟关系（下面几个字段共用的定位思路）

「风格」「订单库存计数」「现货发货时间」「商品状态」「运费模板」都是同一种布局：

```
<div>                                   行容器
  <div style="width: 110px; ...">      标签列（文案可能嵌好几层）
    ... <span>风格</span>
  <div>                                控件列 ← nextElementSibling
    <div class="ecom-g-select ...">
```

所以定位统一走「文案叶子节点 → 逐层上溯 → 找 nextElementSibling 里有目标控件的那一层」。
**不要写死层数**：风格实测是第 4 层，订单库存计数是第 3 层，现货发货时间是第 5 层，
同一个页面内就不一致，改一版更不用说。

### 风格（`ecom-g-tree-select`，与品牌不是一套）

控件是多选树，与品牌那种 `ecom-g-select` 不是一套：

| 差异点 | 品牌（`ecom-g-select`） | 风格（`ecom-g-tree-select`） |
|---|---|---|
| 选项节点 | `.ecom-g-select-item-option` | `.ecom-g-select-tree-title` |
| 面板容器 | `.ecom-g-select-dropdown` | `.ecom-g-tree-select-dropdown` |
| 勾选目标 | 选项本身 | `.ecom-g-select-tree-checkbox` |
| 已选态判据 | — | 节点 checkbox 类名含 `-checked` |
| 已选标签 | `.ecom-g-select-selection-item` | 同（多个） |

三个实测约束：

1. **选项列表是虚拟滚动**。实测 `scrollHeight` 1366 / `clientHeight` 256，
   50 个选项里一屏只挂 10-12 个 DOM 节点。两个场景两种策略，别混：

   | 场景 | 做法 | 为什么 |
   |---|---|---|
   | 勾选已知的名字（主路径） | 往 `input.ecom-g-select-selection-search-input` 输入名字，列表只剩命中项 | 一步命中，不受虚拟滚动影响 |
   | 收集全集（仅报错时） | 清空搜索词，滚 `.ecom-g-select-tree-list-holder` 逐屏收 | 全集拿不到搜索捷径 |

   主路径不要写成「滚动扫全表再找目标」——和 SKU 表不同，那里必须扫（要填每一行），
   这里只需命中几项。`setStyles` 就是按搜索过滤写的，selftest 里有断言盯着。

   收集全集只在有值未命中时才跑，它是报错信息的一部分，不是常规路径。
   滚动步长取可视高度的一部分让相邻两屏有重叠，否则会漏中间的项。
   终止条件看 `holder.scrollTop` 的**实际值**：写超上限会被浏览器默默夹取，
   拿未夹取的请求值判终止会在没到底时就退出（和 SKU 表那个坑同源）。
   收集前**必须先清空搜索词**，否则读到的是上一个关键词的过滤结果。

2. **展开必须真实鼠标点击**（同其他 `ecom-g-*`）。
   展开成功的判据是 select 类名出现 `ecom-g-select-open`，不要靠 sleep 赌。

3. **勾选要向 checkbox 派发四个鼠标事件**（`mouseover`→`mousedown`→`mouseup`→`click`），
   和尺码面板同源。已勾选的项要跳过 —— 重复点一次会变成**取消**勾选。

另三个细节：

- 面板正在收起时类名里会带 `ecom-g-slide-up-leave`，它仍然 `offsetParent` 非空。
  不排除它会点到上一轮的旧选项上。
- 收尾要**清搜索词 + 收起面板**（写空 value 发 input，再发 Escape / 点 body），
  否则残留的过滤词会影响后续字段的可见性判断。
- 下拉底部有「+新建风格」，本技能**不用**：自建值不参与平台搜索/推荐匹配。

标签定位同样不写死层数（见上文「标签与控件是兄弟关系」）：实测风格在第 4 层，
标签容器 style 带 `width: 110px`。

选项个数与可选值随类目变，不是 DOM 事实：怎么根据图片选见
[style-options.md](style-options.md)，当前类目的全集见
[categories/womens-suit.md](categories/womens-suit.md)。

### 导购短标题：AI 不弹推荐列表，直接回填

这是与商品标题 AI 最容易搞错的一处。两者都是「输入框 suffix 里一个 20×20 无 class 的 img」，
但行为不同：

| | 商品标题 AI | 导购短标题 AI |
|---|---|---|
| 点击后 | 弹 `ecom-g-dropdown-menu` 推荐列表，要选一条 | **不弹层**，5-7s 后直接写进输入框 |
| 完成判据 | 标题框 value == 选中的推荐文案 | 输入框 value 从空变非空 |
| 字数上限 | 60 | 24 |

拿商品标题那套去找 dropdown 会永远超时（实测确认点完页面上一个可见 dropdown 都没有）。
输入框靠 `dropdownclassname="auto-dropdown-id-导购短标题"` 属性定位（比 placeholder 稳），
placeholder 作兜底。

该字段**非必填**：AI 不返回时重试 1 次、仍失败就打警告跳过。
拿它阻断上架是不划算的 —— 空着只影响商品质量分。

## 图文信息

| 目标 | 做法 |
|------|------|
| 详情图上传 | `styles_decorateImgEditTitleWrapper__wfpvu` 附近的 `input[type=file][multiple]` |

点「从主图填入」会自动带入 1 张主图，所以最终张数 = 详情图数 + 1。

## 规格设置（最复杂的部分）

默认进来是「智能填写助手」（上传 Excel/图片 让平台 AI 填）。
要手动填必须先点文案为「切换手动填写」的按钮（旧版哈希 `switchButton` 已失效，
现按文案定位 + 真实鼠标点击），切换成功的标志是页面出现 `*商品规格`。

### 新建规格值：六步序列，缺一步静默失败

这是整个流程里最容易错的地方。实测必须严格按序：

1. 点 `.style_forCreate__c19CW .ecom-g-cascader-picker`
   —— 这是**追加新值的空位**。点已有值的 picker 会**覆盖**那个值而不是新增
   （踩过：本想加「裙子」，结果把「上衣」改成了「裙子」）。
2. 在 `.style_forCreate__c19CW input.ecom-g-cascader-input` 输入候选词。
3. 点下拉里的 `创建类型` 链接（`<a>`）。
   若平台已有同名标准选项（如「白色」），跳过 3-5，直接勾选 label 即可。
4. 在 `input.styles_skuNameInput__eV89r` 填最终值。
5. 点绿色 ✓ `[data-kora=确认]` —— 把值加入候选列表并自动勾选。
   缺这步，值只是停在输入框里，不会成为选项。
6. 点下拉底部 `button` 文案含 `确定` —— 把勾选项写入规格。
   底部按钮文案会显示 `确定 (1)` 表示已勾选 1 项。

每步之间要 sleep 1.2-2.5s。写完用 `listSpecValues()` 校验，不校验容易漏。

### 尺码

平台已内置 XS-16XL 全套，不需要创建。有三个坑：

1. **展开方式与颜色分类相反**。尺码 cascader 用 `el.click()` 就能展开；
   对它用真实鼠标点击反而会把已展开的面板点关。
2. **`label.click()` 勾不上**。实测点完 className 里仍无 `checked`。
   必须向 label 内层的 `input` 派发 `mouseover`→`mousedown`→`mouseup`→`click`。
3. **面板有两种视图，平台会随机切换**（见下）。

第 2 条曾导致**静默失败**：`setSizes` 不报错，但尺码一个都没选上，
于是 SKU 表只生成 3 行（只有规格值维度）而不是 12 行。
现在 `setSizes` 会在关面板前校验 `checked` 状态、关完再校验规格区，两处都不通过就抛错。

注意：进页面时 S/M/L/XL 可能已被预勾选且 `disabled`（因为尺码表默认带了行）。

#### 两种视图（同一账号、同一类目也会变）

| | 视图 A | 视图 B |
|---|---|---|
| 面板 class | 带 `cascaderPopup` | 带 `popupBlock` |
| 结构 | 传统两级 cascader，有 `ul`/`li` | 自定义布局，**完全没有 ul/li** |
| 码制列 | 第一个 `ul.ecom-g-cascader-menu` | 带 CSS Modules 哈希的 div |
| 尺码项 | 最后一个 ul 的 `li.ecom-g-cascader-menu-item` | 带 CSS Modules 哈希的 div |
| 尺码文案位置 | 在 `li` 上（内层 label 的 innerText 是**空**的，文字在 label 外的 span） | 在容器和 label 上都有 |

只认视图 A 的写法遇到 B 时，`[...ul].pop()` 返回 `undefined`，
报 `Cannot read properties of undefined (reading 'querySelectorAll')`。

**不要按类名去认这两种视图。** 两边的选项容器类名完全不同，且 B 的类名是
CSS Modules 哈希（`styles_groupItem__xxxxx` 这种），抖店发一次版就变。
`sizeOptionsExpr()` 改成只用两边共同的结构不变量：

1. 可勾选项 = 面板里的 `input[type=checkbox]`。
   码制列（中国码/欧码/英码…）**没有** checkbox，天然被排除，不需要额外过滤。
2. 尺码文案 = 从该 checkbox 往上走，第一个 innerText 非空且很短的祖先。
   视图 A 走到 `li`，视图 B 走到那个哈希 div，同一条路径。

走祖先时限 6 层、文案限 12 字符：不设上限会一路走到整个面板，
而面板的 innerText 是全部尺码拼串。尺码文案最长是 `XXXS女` / `16XL` / `M/L`
这种，12 字符够用。

这段逻辑提成了可导出的 `sizeOptionsExpr()`，`selftest.mjs` 里对两种视图各跑一组
假 DOM（含「把哈希全改成 `__ZZ999` 仍能勾选」那条）。改它之前先跑
`node scripts/selftest.mjs`。

日志里会打印「尺码面板视图 A/B」，排障时能直接看出这次遇到的是哪种。

### 规格值容器

```
.style_specValueBox__i8sD6      规格值区（页面上有多个：颜色分类、尺码各一个）
  .style_skuValue__QyAOk        单个规格值行（含 picker、备注框、规格图上传位）
.style_forCreate__c19CW         追加新值的空位
```

`listSpecValues` 取**第一个** box（颜色分类），`listSizeValues` 取**最后一个**（尺码）。

规格图只有**第一组**规格支持，宽高比 1:1，<5MB。
定位规格图 input 时给每行打 `data-specidx` 标记，不要靠 `nth-child`（会漂移）。

## 价格与库存

表格是 `styles_customVirtualTable__nLhAS`，**窗口化虚拟表**（这是最坑的一点）。

### 只有可视窗口内的行存在于 DOM

滚动容器是 `.ecom-g-table-tbody-virtual-holder`，它的 `max-height`（实测 575px）
小于内容高度（12 行 × 61px = 732px），所以 DOM 里任何时刻只有 ~10-11 个 `tr`。
12 行 SKU 只能数到 11 行，直接按 `tr` 数量校验会误报「行数不匹配」。

无效的办法（都试过）：

- `window.scrollBy` / 外层页面滚动 —— 行数不变
- `scrollIntoView({block:'end'|'center'|'start'})` —— 行数不变
- `Emulation.setDeviceMetricsOverride` 把 viewport 拉到 3000px 高 —— 行数不变

**必须滚动 holder 自身**：设 `holder.scrollTop` 再派发 `scroll` 事件。

### 行的全局下标

`row.offsetTop` 每个窗口都会**重置为 0**，只靠它会把前几行重复填一遍。
正确算法：

```js
const ty = /translateY\((-?[\d.]+)px\)/.exec(inner.style.transform)?.[1] ?? 0;
const globalIndex = Math.round((ty + row.offsetTop) / rowHeight);
```

`inner` = `.ecom-g-table-tbody-virtual-holder-inner`。实测这个算法在两个窗口下
分别得到 0-10 和 2-11，合并后正好覆盖 0-11 无重复无遗漏。

### rowHeight 必须在 tbody 内取（踩过的坑，影响面很大）

上面那个 `globalIndex` 公式的分母 `rowHeight` 一旦取错，全部下标都会算歪
并且**互相碰撞**（不同行算出同一个下标），去重后行数就少了。

取行高时**不能**写成 `w.querySelectorAll('tr')`：`thead` 的表头行里有一个
「批量传图」的 `input[type=file]`，所以它也满足「有 input」这个数据行特征，
会被当成第一行取到 —— 而表头高 67px，数据行是 73px。

必须限定在 holder（tbody）内找：

```js
const h  = w.querySelector('.ecom-g-table-tbody-virtual-holder');
const tr = [...h.querySelectorAll('tr')].find(r => r.querySelectorAll('input').length > 0);
```

这个坑的表现是「SKU 行数不匹配: 页面 10 行，预期 12 行」，
历史上还出现过 13 行（876 / 67 ≈ 13）。两边都是同一个根因。

### 总行数用几何计算，不要滚动扫描

`rowHeight` 取对之后，`holder.scrollHeight / rowHeight` 是精确的（实测 876 / 73 = 12）。
分组行（`上衣`/`裤子`/`套装` 那种 rowspan 单元格）是绝对定位的，
不计入 `scrollHeight`，不会把结果抹高。

曾经改成「逐窗口滚动扫全部下标再去重」，看似更严谨，实际上反而引入了
**时序竞态**：虚拟表重渲染是异步的，滚动后等 700ms 并不总够，
没重渲染就 resolve 的话只数到首屏的 10 行。几何计算没有这个风险。

### 滚动终止条件要看实际位置

往 `scrollTop` 写超过上限的值会被浏览器**默默夹取**到 `scrollHeight - clientHeight`
（实测上限 251，写 511 也只到 251）。拿未夹取的请求值去判断循环终止，
会在还没真正滚到底时就退出。应该用 `h.scrollTop` 的返回值跟 `maxScroll` 比。

### 行顺序

**行顺序 = 规格值顺序 × 尺码顺序**，且规格值的实际顺序可能与写入顺序相反。
实测写入顺序 上衣→裙子→套装，页面上显示的是 套装/裙子/上衣（早期版本）。
所以填表前必须先 `listSpecValues()` 读页面实际顺序，不能直接用 Excel 顺序。

### 单元格定位

每行 4 个输入框，按 placeholder 区分：

| placeholder | 含义 |
|-------------|------|
| `请输入` | 价格 |
| `请输入库存` | 现货库存 |
| `请输入erp编码` | 商家编码 |

（`请输入条形码` 那一列存在但脚本不填，故未登记到 `SKU_CELL`。）

分组行（`套装`/`裙子`/`上衣` 这种 rowspan 单元格）也在 tbody 里，但
`querySelectorAll('input').length === 0`，按这个过滤即可，别按高度判断。

## 服务与履约

**运费模板的坑**：这个 select 的**显示文案就是已选模板名**。
实测页面上显示「偏远区域限购」时，容易误判成是旁边那个「偏远区域限购」开关，
其实那就是运费模板 select 的当前值。确认方法：展开后看
dropdown 的 class 里带 `auto-dropdown-id-运费模板`。

选项来自店铺已建模板（实测有 `偏远区域限购` / `包邮` / `新建`）。

### 四组同构的 radio

`发货模式` / `现货发货时间` / `订单库存计数` / `商品状态` 四处结构完全一样，
都是 `label.ecom-g-radio-wrapper` 包着 `input.ecom-g-radio-input`，
选中态看 label 类名有没有 `ecom-g-radio-wrapper-checked`。
所以四者共用一个 `setRadioOption()`，不要各写一份。

实测到的 value：

| 字段 | 选项：value |
|------|-------------|
| 发货模式 | 现货:0、现货预售混合:2 |
| 现货发货时间 | 当日发:9999、次日发:1、**48小时:2** |
| 订单库存计数 | 下单减库存:1、**付款减库存:2** |
| 商品状态 | 上架:0、下架:1 |

**不要靠 value 定位**：value 在字段间重复（四个字段里都有 1 和 2），
全页找 `input[value=2]` 会选到完全不相干的字段上。必须先靠标签文案锁区域（上文
「标签与控件是兄弟关系」），再在区域内靠选项文案匹配。selftest 里把三个字段
放在同一份假 DOM 里就是为了卡住这个风险。

还有两个行为约定：

- **已经是目标值就不点**（返回 `already`）。radio 重复点本身无害，但少一次真实鼠标手势
  就少一分风险。实测默认值：发货模式=现货（已选）、商品状态=上架。
- **字段不存在时返回 null、不抛错**。这几项在部分类目下可能没有，
  不应让整款上架失败。但区域找到了、选项名不对（如填了「72小时」）要抛错并
  把实际可选项列出来 —— 那是配置写错了，静默跳过只会让人以为生效了。

「售后政策」在发布页上**没有独立控件**（只有「订单完成15天…」这类只读文案），
所以它仍留在「未生效配置」里。发货模式有控件但当前不写（页面默认就是「现货」）。

## 尺码表

「区间值」是每列表头上的 checkbox，勾上后该列从 1 个输入框变成 2 个（from-to）。
不勾就往里写 `150-175` 会被吞掉连字符，变成 `150175`，然后报
「身高(cm)不能大于220」。

更省事的办法：用「一键复用尺码信息」选已存模板（如「身高体重」），
模板会自带各尺码的身高/体重区间值，且自动把两列切成区间模式。
**模板值会覆盖脚本写入的值**，所以要么用模板、要么手填，别混。

该类目强制要求尺码表含「身高+体重」，否则「填写检查」不通过。

## 校验与提交

| 按钮 | 说明 |
|------|------|
| `填写检查` | 跑校验，顶部显示「N 个错误问题待处理」 |
| `保存草稿` | 存草稿不上架 |
| `发布商品` | 正式提交 |

提交前常有「我知道了」提示弹窗挡住按钮，需要先关掉（`dismissModals`）。

成功提示文案：`必填项已完成，可提交发布商品`（校验通过）、
`发布成功` / `提交成功` / `审核中`（发布结果）。

### draft 模式不跑「填写检查」

「填写检查」是**发布**级标准，它会把本技能根本不负责上传的项也算成错误
（实例：「请输入水洗标/吊牌图」），拿它去卡草稿只会白白阻断。
草稿本身允许字段不齐，所以：

- `--mode draft`：跳过填写检查，填完直接点「保存草稿」，缺什么留给人工复核。
- `--mode publish`：仍跑检查，有错就不提交。

## 不在本文的相关话题

| 话题 | 去处 |
|------|------|
| 登录态检测（探针路径、URL 四分类、轮询等待） | [browser-setup.md](browser-setup.md) |
| 调试端点、wsUrl 缓存、Allow 确认框 | [browser-setup.md](browser-setup.md) |
| 标签页复用的三条约束 | [browser-setup.md](browser-setup.md) |
| 当前类目（女装/时尚套装）的属性与校验特殊性 | [categories/womens-suit.md](categories/womens-suit.md) |
