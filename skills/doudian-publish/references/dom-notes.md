---
name: dom-notes
description: 抖店商品发布页的 DOM 结构与交互坑位记录，改动 doudian-page.mjs 前必读
---

# 抖店发布页 DOM 笔记

页面：`https://fxg.jinritemai.com/ffa/g/create`
组件库：两套混用 —— `ecom-g-*`（旧，rc-* 系）和 `aurora-*`（新）。
两套的展开方式、事件要求都不一样，不能用同一套办法处理。

以下全部为实测结论。改选择器前先在真实页面上验证，不要凭猜测改。

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

### 4. SPA 渲染晚于 `document.readyState`

`readyState` 到 `interactive` 时 `body.innerText.length` 可能只有 64
（那是浏览器扩展留下的文本，如 "AIX Downloader"），表单根本还没挂载。
必须用 `page.waitRendered()` 等文本长度到位，再找元素。

另外 `Target.createTarget` 传 `background: true` 时 Chromium 会推迟渲染，
SPA 可能长时间不挂载。`openPage` 现在默认前台打开并 `Page.bringToFront`。

### 5. 关闭标签页前必须摘掉 `beforeunload`（严重）

发布页注册了 `beforeunload`。直接 `Target.closeTarget` 会弹出浏览器**原生**
「离开站点？」确认框。这个框由浏览器 UI 线程持有，没人点就会把整个浏览器
主线程卡死 —— DevTools 端口不再完成 WebSocket 握手，AppleScript 也超时，
只能强杀浏览器。

`Page.close()` 已做双保险：先注入代码摘掉 `beforeunload` 监听，
再订阅 `Page.javascriptDialogOpening` 自动 accept。别删这段逻辑。

## 第一步页：主图 + 标题 + 类目

| 目标 | 选择器 / 做法 |
|------|--------------|
| 首图上传 | `input[type=file][accept="image/*"]` |
| 辅助图上传 | `div.material-upload-button input[type=file]`，`multiple`，一次可传多张 |
| 已上传图计数 | `div.index-module_batchImageUpload__JtBRX img` |
| 标题 | `input.ecom-g-input`（第一步页只有这一个） |
| 类目快捷项 | `.style_searchHistoryItems__FdSkW`，文案形如 `服装 > ... > 时尚套装` |
| 类目确认 | 弹层内 `button.ecom-g-btn-primary` |

**主图槽位上限 5 张**（4 个缩略图 + 1 个上传位）。首图单独一个 input，
其余 4 张走辅助图 input。

**填标题后平台会异步跑 AI 识别**，之后才出现「标题推荐」和类目推荐区。
填完标题要 sleep ≥2s 再操作类目。

「最近创建」里如果已有目标类目，一次点击直达，比逐级点全部类目稳得多。

## 第二步页：类目属性

| 字段 | 控件 | 要点 |
|------|------|------|
| 面料材质 | `aurora-dorami-composition-select` | 材质+含量两段式，含量总和须为 100% |
| 品牌 | `ecom-g-select`，dropdown id = `auto-dropdown-id-品牌` | 无品牌就选「无品牌」选项 |
| 货号 | `input.ecom-g-input`（placeholder=请输入） | 填款号 |

面料材质流程：真实点击 → 在弹层内 `input[placeholder=搜索材质]` 输入 →
点选项 → 在含量框填 `100` → 关闭弹层。
只输入不点选项不会生效（列表会停在默认项，看起来像搜索没反应）。

## 图文信息

| 目标 | 做法 |
|------|------|
| 详情图上传 | `styles_decorateImgEditTitleWrapper__wfpvu` 附近的 `input[type=file][multiple]` |

点「从主图填入」会自动带入 1 张主图，所以最终张数 = 详情图数 + 1。

## 规格设置（最复杂的部分）

默认进来是「智能填写助手」（上传 Excel/图片 让平台 AI 填）。
要手动填必须先点 `button.style_switchButton__guvWZ` 切换，
切换成功的标志是页面出现 `*商品规格`。

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

平台已内置 XS-16XL 全套，不需要创建。但有两个坑：

1. **展开方式与颜色分类相反**。尺码 cascader 用 `el.click()` 就能展开；
   对它用真实鼠标点击反而会把已展开的面板点关。
2. **`label.click()` 勾不上**。实测点完 className 里仍无 `checked`。
   必须向 label 内层的 `input` 派发 `mouseover`→`mousedown`→`mouseup`→`click`。

第 2 条曾导致**静默失败**：`setSizes` 不报错，但尺码一个都没选上，
于是 SKU 表只生成 3 行（只有规格值维度）而不是 12 行。
现在 `setSizes` 会在关面板前校验 `checked` 状态、关完再校验规格区，两处都不通过就抛错。

注意：进页面时 S/M/L/XL 可能已被预勾选且 `disabled`（因为尺码表默认带了行）。

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

总行数用 `holder.scrollHeight / rowHeight` 推，不要用 `tr` 数量。

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
| `请输入条形码` | 条形码 |

分组行（`套装`/`裙子`/`上衣` 这种 rowspan 单元格）也在 tbody 里，但
`querySelectorAll('input').length === 0`，按这个过滤即可，别按高度判断。

## 服务与履约

**运费模板的坑**：这个 select 的**显示文案就是已选模板名**。
实测页面上显示「偏远区域限购」时，容易误判成是旁边那个「偏远区域限购」开关，
其实那就是运费模板 select 的当前值。确认方法：展开后看
dropdown 的 class 里带 `auto-dropdown-id-运费模板`。

选项来自店铺已建模板（实测有 `偏远区域限购` / `包邮` / `新建`）。

商品状态是 radio：`上架` value=0，`下架` value=1。
批量上架建议先设「下架」，人工复核后再统一上架。

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

## 浏览器调试端点

本机 Chrome 的 HTTP `/json/*` 全部返回 404（被扩展或安全策略拦了），
只有 WebSocket 端点可用。所以 `connectBrowser` 先试 HTTP，失败退回
WebSocket 直连探测 —— 只用 HTTP 判断会漏掉可用端口。

WebSocket 路径优先从 `DevToolsActivePort` 文件第二行读（带 UUID），
退回裸 `/devtools/browser`。

`/devtools/browser`（裸路径）**只允许一个客户端**。web-access 的
`cdp-proxy.mjs` 是常驻进程会占着它，冲突时先 `pkill -f cdp-proxy.mjs`。
另外「探测完关闭、再重新连接」会和自己抢这个单客户端位，所以
`connectBrowser` 只连一次并复用连接，不要恢复成先探测后连接的写法。
