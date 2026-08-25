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

### 「Allow remote debugging?」确认框（Chrome 136+）

Chrome 136 起，对 DevTools **HTTP** 终结点（`/json/version`）的请求会弹一个
原生确认框「An external app wants full control over this Chrome session」。
**拿着完整 `ws://.../devtools/browser/<uuid>` 地址直连 WebSocket 不走这条检测。**

本机实测（Chrome 151.0.7922，macOS）：

| 连接方式 | 目标 | 结果 |
|---------|------|------|
| WS 直连 | 隔离 profile | 27ms / 28ms，无弹框 |
| WS 直连 | 日常 profile（已授权过） | 首次 8s+ 超时，之后 4.4s → 1.6s |
| HTTP `/json/version` | 隔离 profile | 正常返回，无弹框 |

两个反直觉的结论：

1. **`DevToolsActivePort` 文件在 Chrome 151/macOS 上根本不写。** 用
   `--user-data-dir` + `--remote-debugging-port` 起一个干净实例，等 20s
   该文件始终不出现，但 HTTP 端点和 WS 都正常。日常 profile 里那个文件是
   旧版本留下的残留（内容里的端口早已失效）。所以「读 DevToolsActivePort
   拿 wsUrl」这条路**在当前版本上基本空跑**。
2. **隔离 profile 上 HTTP 也不弹框。** 弹框主要发生在日常 profile 上。

因此实际做法是**自己缓存 wsUrl**：首次不得不走 HTTP 拿到带 uuid 的地址后写进缓存，
之后每次连接直读缓存、零 HTTP 请求。实测复用时 3-25ms、`fetch` 调用数为 0。

缓存分两套，**都需要**：

| 缓存 | 位置 | 归属校验 | 适用 |
|------|------|---------|------|
| profile 缓存 | `<profile>/devtools-ws.json` | pid 三重校验 | 本脚本启动的专用实例 |
| 端口缓存 | `~/.yonge/doudian/ws-cache/port-<n>.json` | 无（只回答"该端口上 wsUrl 是什么"） | 任意浏览器，含用户日常浏览器 |

端口缓存是补出来的：日常浏览器不是本脚本启动的、没有 `chrome.pid`，
profile 缓存那套 pid 校验对它永远不成立，于是早期版本**完全不为它写缓存** ——
结果 `--port 9222` 每次都要重新走 HTTP 协商，也就每次都弹确认框。
端口缓存不做归属判断，所以对日常浏览器也安全适用；uuid 失效时自动清理重建。

### 弹框已经出现时会发生什么

确认框是 macOS 原生 sheet，会**阻塞该端口上所有 HTTP 请求**（`/json/version`
返回空）。实测它挂着时脚本连不上，且没人点就一直挂着。
用 AppleScript 可以查到并点掉（层级较深，`entire contents` 遍历不到）：

```
sheet 1 of window 1 → group 1 → group 1 → group 1 → group 2 → group 1
  → AXButton desc 分别为 "Turn off in settings" / "Cancel" / "Allow"
```

判断有没有挂着：
`osascript -e 'tell application "System Events" to tell process "Google Chrome" to get count of sheets of every window'`
返回非 0 就是有弹框在等。

### 缓存必须带 pid 校验（踩过的坑）

`devtools-ws.json` 里除了 `port`/`wsUrl` 还必须存 `pid`，读取时三重校验：
pid 存在 → pid 还活着 → 与该 profile 的 `chrome.pid` 一致。

原因是个真实事故：专用实例被 kill 后，`connectBrowser` 的自动探测回落到
9222 连上了**用户的日常浏览器**，若把那个终结点写进专用 profile 的缓存，
下一次就会静默地去驾驭日常浏览器 —— 隔离形同虚设。
所以 `connectBrowser` 的 `cacheFor` 参数只在调用方能确认「连的就是该 profile
自己的实例」时才传 pid；自动探测路径一律不传、不写缓存。

### 其他既有约束

部分 Chrome 的 HTTP `/json/*` 会返回 404（被扩展或安全策略拦了），
只有 WebSocket 端点可用，所以不能只靠 HTTP 判断端口可用性。
**本机日常 Chrome 就是这种情况**：点掉确认框之后 `/json/version` 稳定返回 404，
连接完全靠 WS 直连回落（实测 3.9s 连上并重建端口缓存）。
这也是为什么端口缓存对日常浏览器格外重要 —— 它那条 HTTP 路本来就是坏的。

裸 `/devtools/browser`（不带 uuid）只在没人占用时偶尔能连，不可依赖。

`/devtools/browser`（裸路径）**只允许一个客户端**。web-access 的
`cdp-proxy.mjs` 是常驻进程会占着它，冲突时先 `pkill -f cdp-proxy.mjs`。
另外「探测完关闭、再重新连接」会和自己抢这个单客户端位，所以
`connectBrowser` 只连一次并复用连接，不要恢复成先探测后连接的写法。
