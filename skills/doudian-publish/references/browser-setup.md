---
name: browser-setup
description: 抖店自动化的浏览器接入：专用 profile、登录态检测、标签页复用、调试端点与缓存。改 cdp.mjs 前必读
---

# 浏览器接入

分两层：前半是「怎么用」，日常按这部分操作即可；后半是「机制与实测」，
改 `scripts/cdp.mjs` 前必读——里面每条都是踩过的坑，凭直觉改会踩回去。

## 怎么用

### 专用 profile

```bash
node {baseDir}/scripts/check-env.mjs --launch
```

profile 放在 `~/.yonge/doudian/chrome-profile`，端口动态分配。登录态持久保留，
后续所有命令加 `--launch` 就会复用这个实例（幂等，不会重复开）。

`publish.mjs` 和 `doctor.mjs` 与 `check-env.mjs` 共用同一套启动/登录逻辑，
也支持同样的 `--no-wait-login` 与 `--login-timeout <秒>`。

启动失败看 `~/.yonge/doudian/chrome-profile/chrome-err.log`。

### 登录态检验

`--launch` 打开浏览器后会自动检验登录态：

- 已登录 → 直接继续执行，不打扰用户。
- 未登录 → 自动打开登录页并把窗口抬到前台，提示用户手动登录（扫码或账号密码），
  然后轮询等待。用户登录完成后脚本自己检测到并继续，**不需要重跑命令**。
  默认最长等 300s，用 `--login-timeout <秒>` 调整。
- 无人值守场景加 `--no-wait-login`：未登录就直接以退出码 1 结束，不等待。

### 备选：用日常浏览器

```bash
open -na 'Google Chrome' --args --remote-debugging-port=9222
```

启动前要**完全退出** Chrome，否则参数会被丢给现有实例、调试端口不生效。
日常 Chrome 若装了拦截 DevTools 端点的扩展（`/json/version` 返回 404），
只能用专用 profile。

### 端点冲突

裸路径 `/devtools/browser` **只允许一个客户端**。web-access 技能的
`cdp-proxy.mjs` 是常驻进程会占着它，冲突时先 `pkill -f cdp-proxy.mjs`。

同理，`connectBrowser` 只连一次并复用连接——「探测完关闭、再重新连接」
会和自己抢这个单客户端位，不要恢复成先探测后连接的写法。

---

## 机制与实测

以下为本机实测结论（Chrome 151.0.7922 / macOS）。

### 登录探针不能用抖店根路径

`https://fxg.jinritemai.com/` 是**对外招商官网**，不是工作台：

- 登录与否都能正常打开，**已登录时也不会跳转到工作台**；
- 页面文本里就含「登录抖店」「登录入口」「立即入驻」，
  任何基于文本的登录判断都会把它读成登录页。

实测：已登录状态下打开根路径，8 次轮询里 URL 一直停在 `/`，
`body.innerText` 恒为招商内容（约 1.3k 字符）→ 判定成「未登录」，
于是脚本一边看着一个已登录的 `/ffa/mshop/homepage/index` 标签页，
一边报「未登录」并干等超时。

正确做法：探针打**需要鉴权的后台路径**。`cdp.mjs` 里用
`DOUDIAN_HOME = https://fxg.jinritemai.com/ffa/mshop/homepage/index`：

| 状态 | 表现 |
|------|------|
| 未登录 | 被重定向到 `/login/common?extra={"target_url":...}` |
| 已登录 | 留在 `/ffa/...`，1.5s 内渲染出侧边菜单（商品创建/商品管理/订单管理…） |

### URL 四分类

`classifyDoudianUrl()` 把 URL 分成四类，缺一类就会误判：

| 分类 | 判据 | 含义 |
|------|------|------|
| `login` | 含 `/login`、`passport`、`/authorize`、`/account/login` | 未登录 |
| `app` | 抖店域 + 有业务路径（`/ffa/...`） | 已进入后台 |
| `marketing` | 抖店域 + 根路径 | 招商官网，**不可作判据** |
| `other` | 非抖店域（`about:blank`、扩展页…） | 无信息 |

文本二次判定（`classifyByText`）只在 URL 已是 `app` 时才使用，
用来抓「路径没变但弹了登录浮层 / 会话过期提示」。
它的 login 关键词刻意**不含**裸的「登录」二字，就是为了不被
招商页和后台页脚上的「登录」字样带偏。

### 等待登录为什么用轮询而不是 prompt

脚本由 agent 非交互地调起，**没有可读的 stdin**，读回车会直接 EOF。
所以 `ensureLogin` 的做法是：

1. 先 `probeLogin` 做一次权威判定，已登录直接返回（零打扰）；
2. 未登录 → `focusLoginTab` 打开/激活登录页并把窗口抬到前台；
3. 每 2s 用 `peekLoginByTabs` 只读 `Target.getTargets` 的 URL 轮询
   （不新建 tab、不跑页面 JS，代价极低）；
4. 看到有 `app` 态 tab 才做一次权威 `probeLogin` 确认，避免每 2s 开关标签页；
5. 发现没有任何抖店 tab（用户把登录页关了）就补开一个；
6. 每 30s 打一行进度，超时（默认 300s）返回 `timeout: true`。

`--no-wait-login` 跳过第 2 步之后的一切，直接以退出码 1 结束，供 CI 使用。

### 工作台标签页复用（`openOrAdoptPage` / `probeLogin`）

不要无条件 `Target.createTarget`。`isDoudianHomepageUrl()` 命中时先用
`Target.getTargets` 找现成的工作台首页 tab，`Target.attachToTarget` 接管。

三条约束，改动前看清：

1. **只认 `/ffa/mshop/homepage`**。别放宽到任意 `/ffa/` —— 那会接管到用户
   正在手工填的 `/ffa/g/create`，把人家填的内容冲掉。域名也得卡住，
   `evil.com/ffa/mshop/homepage` 不能命中。
2. **接管来的 Page 必须 `owned=false`**。`Page.close()` 看这个标志决定要不要
   `Target.closeTarget`。弄错就会关掉用户自己开的标签页。
   探针释放时走 `Target.detachFromTarget`，不走 close。
3. **接管后仍要 `safeNavigate(url)` 重新加载一次**。拿到的 tab 可能是几小时前
   的快照，会话早过期。只读 URL 就下「已登录」结论是错的。用 `safeNavigate`
   而不是 `navigate` —— 这一页也可能被用户点进了带 `beforeunload` 的表单。

收尾时（publish.mjs / doctor.mjs）对 `owned=false` 的页要先退回 `DOUDIAN_HOME`，
别给用户留一个填了半截的发布页。

没有现成的工作台 tab 时才新开一个，这种自建的 tab（`owned=true`）跑完会自动关掉，
`--keep-tab` 则保留。

### 「Allow remote debugging?」确认框（Chrome 136+）

Chrome 136 起，对 DevTools **HTTP** 终结点（`/json/version`）的请求会弹一个
原生确认框「An external app wants full control over this Chrome session」。
**拿着完整 `ws://.../devtools/browser/<uuid>` 地址直连 WebSocket 不走这条检测。**

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

### wsUrl 缓存分两套，都需要

| 缓存 | 位置 | 归属校验 | 适用 |
|------|------|---------|------|
| profile 缓存 | `<profile>/devtools-ws.json` | pid 三重校验 | 本脚本启动的专用实例 |
| 端口缓存 | `~/.yonge/doudian/ws-cache/port-<n>.json` | 无（只回答「该端口上 wsUrl 是什么」） | 任意浏览器，含用户日常浏览器 |

端口缓存是补出来的：日常浏览器不是本脚本启动的、没有 `chrome.pid`，
profile 缓存那套 pid 校验对它永远不成立，于是早期版本**完全不为它写缓存** ——
结果 `--port 9222` 每次都要重新走 HTTP 协商，也就每次都弹确认框。
端口缓存不做归属判断，所以对日常浏览器也安全适用；uuid 失效时自动清理重建。

### 缓存必须带 pid 校验（踩过的坑）

`devtools-ws.json` 里除了 `port`/`wsUrl` 还必须存 `pid`，读取时三重校验：
pid 存在 → pid 还活着 → 与该 profile 的 `chrome.pid` 一致。

原因是个真实事故：专用实例被 kill 后，`connectBrowser` 的自动探测回落到
9222 连上了**用户的日常浏览器**，若把那个终结点写进专用 profile 的缓存，
下一次就会静默地去驾驭日常浏览器 —— 隔离形同虚设。
所以 `connectBrowser` 的 `cacheFor` 参数只在调用方能确认「连的就是该 profile
自己的实例」时才传 pid；自动探测路径一律不传、不写缓存。

怀疑连错了浏览器时，看 `<profile>/devtools-ws.json` 里的 `pid`/`port` 是否与
`chrome.pid` 一致；不一致会被自动拒绝。

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

### HTTP 端点不可靠，WS 才是主路径

部分 Chrome 的 HTTP `/json/*` 会返回 404（被扩展或安全策略拦了），
只有 WebSocket 端点可用，所以不能只靠 HTTP 判断端口可用性。
**本机日常 Chrome 就是这种情况**：点掉确认框之后 `/json/version` 稳定返回 404，
连接完全靠 WS 直连回落（实测 3.9s 连上并重建端口缓存）。
这也是为什么端口缓存对日常浏览器格外重要 —— 它那条 HTTP 路本来就是坏的。

裸 `/devtools/browser`（不带 uuid）只在没人占用时偶尔能连，不可依赖。
