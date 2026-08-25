---
name: doudian-publish
description: 用浏览器自动化在抖店（抖音小店）批量上架商品。读取 Excel 货盘 + 本地素材目录，自动完成主图上传、标题、类目、类目属性、详情图、多规格 SKU、价格库存、尺码表、运费模板，最后存草稿或发布。当用户提到「抖店上架」「批量上架」「抖店发布商品」「上品」「doudian publish」「货盘上架」时使用。
version: 0.2.0
metadata:
  requires:
    bins:
      - node
      - python3
---

# 抖店商品批量上架

## 风险须知（必须先展示给用户）

首次使用时，先原样输出以下内容再动手：

```
温馨提示：抖店对浏览器自动化操作检测严格，存在账号封禁风险。
已内置防护措施但无法完全避免，继续操作即视为接受。

建议流程：先 --mode dry 验证映射，再 --mode draft 存草稿人工复核，
最后才 --mode publish。「商品状态」建议先设「下架」。
```

## 用户提问工具

需要向用户提问时，按优先级：

1. 优先用当前运行时的内置提问工具（`ask_user_question` / `AskUserQuestion` /
   `request_user_input` 等）。
2. 没有则输出编号列表，让用户回复编号。
3. 支持多问一次的，把所有问题合并成一次调用。

## 语言

用用户的语言回复。技术标识（路径、参数名、字段名、选择器）保持原文。

## 脚本目录

`{baseDir}` = 本 SKILL.md 所在目录。

| 脚本 | 用途 |
|------|------|
| `scripts/check-env.mjs` | 环境检查：Node、浏览器、python3+openpyxl、专用 profile |
| `scripts/publish.mjs` | 批量上架主入口 |
| `scripts/doctor.mjs` | 选择器体检：抖店改版后一条命令看哪些选择器失效 |
| `scripts/selftest.mjs` | 离线自测（不连浏览器），改动后先跑这个 |
| `scripts/selectors.mjs` | 选择器单一来源（CSS Modules 哈希 + 语义兜底） |
| `scripts/read-plan.py` | 解析模板 Excel + 扫描素材目录，输出 JSON |
| `scripts/migrate-old-plan.py` | 旧版货盘 → 新模板 |
| `scripts/doudian-page.mjs` | 发布页交互原语 |
| `scripts/cdp.mjs` | 无依赖 CDP 客户端 + 浏览器生命周期管理 |
| `templates/make-template.py` | 生成空白模板 Excel |

| 参考文档 | 内容 |
|----------|------|
| `references/excel-template.md` | 模板列定义、素材命名规范、旧货盘迁移 |
| `references/dom-notes.md` | 发布页 DOM 结构与坑位（**改 doudian-page.mjs 前必读**） |

## 前置条件

### 浏览器

**推荐：专用 profile**（与日常浏览器隔离，登录态持久保留）

```bash
node {baseDir}/scripts/check-env.mjs --launch
```

首次会开一个干净的 Chrome，**在里面手动登录一次抖店**即可，之后一直有效。
profile 放在 `~/.yonge/doudian/chrome-profile`，端口动态分配。

后续所有命令加 `--launch` 就会复用这个实例（幂等，不会重复开）。

**备选：用日常浏览器**

```bash
open -na 'Google Chrome' --args --remote-debugging-port=9222
```

启动前要**完全退出** Chrome，否则参数会被丢给现有实例、调试端口不生效。
日常 Chrome 若装了拦截 DevTools 端点的扩展（`/json/version` 返回 404），
只能用专用 profile。

若 web-access 技能的 `cdp-proxy.mjs` 正在跑，它会占用浏览器级调试端点，
先 `pkill -f cdp-proxy.mjs`。

### 环境变量

| 变量 | 用途 |
|------|------|
| `DOUDIAN_PROFILE_DIR` | 改专用 profile 目录 |
| `DOUDIAN_DEBUG_PORT` | 钉死调试端口（默认动态分配） |
| `DOUDIAN_CHROME_PATH` | 指定浏览器可执行文件 |

### 环境检查

```bash
node {baseDir}/scripts/check-env.mjs [--launch]
```

| 检查失败 | 处理 |
|----------|------|
| Node.js | 需要 22+（用原生 WebSocket） |
| 浏览器调试端口 | 加 `--launch` 自动起专用实例 |
| python3 + openpyxl | `pip3 install openpyxl` |

## 工作流

```
- [ ] Step 0: 展示风险须知 + 跑环境检查
- [ ] Step 1: 确认数据来源（新模板 / 旧货盘迁移 / 新建模板）
- [ ] Step 2: 校验模板与素材
- [ ] Step 3: dry 跑一款验证
- [ ] Step 4: draft 批量存草稿
- [ ] Step 5: 人工复核后发布
- [ ] Step 6: 汇报结果

久未使用、或出现大量「等待超时」时，先跑一次选择器体检：

```bash
node {baseDir}/scripts/doctor.mjs --launch
```

改过脚本后先跑离线自测（不连浏览器、不碰账号）：

```bash
node {baseDir}/scripts/selftest.mjs
```
```

### Step 1: 确认数据来源

| 用户手上有 | 做法 |
|-----------|------|
| 本技能的模板 Excel | 直接进 Step 2 |
| 旧版货盘 Excel | 跑 `migrate-old-plan.py`，然后**必须**让用户复核迁移警告 |
| 什么都没有 | 跑 `make-template.py` 生成空模板，让用户填 |

迁移的详细注意事项见 `references/excel-template.md`。

### Step 2: 校验模板与素材

```bash
python3 {baseDir}/scripts/read-plan.py 模板.xlsx --root 素材根目录
```

读 JSON 输出：

- `errors` 非空 → 阻断性问题，先修模板再继续。
- `items[].警告` 非空 → 如「缺少规格图」，向用户报告并确认是否继续。
- 检查素材是否按命名规范（`主图01.jpg` / `详情图01.jpg` / `SKU_<规格值>.jpg`）。
  命名不规范就识别不到，需要先重命名。

### Step 3: dry 跑一款

**不要跳过这步。** 先用单款验证字段映射是否正确：

```bash
node {baseDir}/scripts/publish.mjs --plan 模板.xlsx --sku GZ0021 --mode dry --shots ./shots
```

dry 模式会填完所有字段并跑「填写检查」，但不提交。
看截图确认标题、类目、规格、价格、库存都对上了再往下走。

### Step 4: draft 批量存草稿

```bash
node {baseDir}/scripts/publish.mjs --plan 模板.xlsx --mode draft --shots ./shots
```

### Step 5: 发布

让用户在抖店后台复核草稿后再发。确认后：

```bash
node {baseDir}/scripts/publish.mjs --plan 模板.xlsx --mode publish
```

## publish.mjs 参数

```bash
node {baseDir}/scripts/publish.mjs --plan <货盘.xlsx> [选项]
```

| 参数 | 说明 |
|------|------|
| `--plan <path>` | 模板 Excel（必填） |
| `--root <dir>` | 素材根目录，默认取 Excel 所在目录 |
| `--sku A,B` | 只处理指定款号 |
| `--mode draft\|publish\|dry` | 默认 `draft`。`dry` 只校验不提交 |
| `--brand <name>` | 品牌，默认取「全局默认」Sheet，回落 `无品牌` |
| `--launch` | 用专用 profile 启动/复用浏览器（推荐） |
| `--port <n>` | 手动指定调试端口 |
| `--keep-tab` | 跑完不关标签页，便于人工复核 |
| `--shots <dir>` | 每款保存提交前截图（失败时也存错误截图） |
| `--resume` | 跳过状态文件里已成功的款号（中断后续跑用） |
| `--no-dedup` | 跳过提交前的货号查重（默认会查） |
| `--report <path>` | 把结果写成 JSON |

### 中断后怎么续

每款的结果会实时追加到 `.<模板名>.state.jsonl`（与模板同目录）。
跑到一半失败，修好问题后加 `--resume` 重跑即可，已成功的款不会重复建。

### 查重

`draft` / `publish` 模式下，每款提交前会按货号在商品管理里搜一次，
已存在就跳过（状态记为「已跳过（重复）」，不计入失败）。
确实要重建就加 `--no-dedup`。

## 单款上架的 11 步

`publish.mjs` 对每款执行：

| 步 | 动作 | 数据来源 |
|----|------|---------|
| 1 | 上传首图 | `主图01.*` |
| 2 | 上传辅助图（最多 4 张） | `主图02-05.*` |
| 3 | 填标题 | 「商品标题」列，留空则按规则生成 |
| 4 | 选类目 | 「类目」列，优先命中「最近创建」 |
| 5 | 进入详情表单 | 点「下一步」 |
| 6 | 面料材质 / 品牌 / 货号 | 对应列 + `--brand` |
| 7 | 上传详情图 | `详情图*.*` |
| 8 | 建规格值 + 勾尺码 + 规格图 | 「规格值」「尺码」列 + `SKU_*.*` |
| 9 | 填 SKU 价格/库存/商家编码 | 「价格」「库存」「库存明细」列 |
| 10 | 尺码表模板 / 运费模板 / 商品状态 | 对应列 |
| 11 | 跑填写检查 | 有错误则不提交 |

## 已知限制

- **主图视频未接入**。模板留了 `视频01.mp4` 约定，脚本还没实现上传。
- **白底图未接入**。
- **详情图不含尺码表**。该类目要求详情页有清晰尺码表，目前靠「尺码表模板」
  满足校验；想要图片版尺码表需自己放进详情图并命名 `尺码表.jpg`。
- **发货模式/发货时效/售后政策/订单库存计数取页面默认值**，未按「全局默认」Sheet 覆写。
  这四项现在会在运行时明确提示「不会生效」，不再静默忽略。
- 「组合件数」「适用年龄」「风格」等非必填属性未填，会拉低商品质量分。

## 排障

| 现象 | 原因 / 处理 |
|------|------------|
| `未检测到已开启调试端口的浏览器` | 浏览器没开调试端口，或 `cdp-proxy.mjs` 占着端点（先 pkill） |
| `等待超时: 发布页首图上传控件` | SPA 没渲染完。已用 `waitRendered` 处理；仍失败则查是否未登录、被风控跳转 |
| `规格值写入失败` | 六步序列被打断，见 `references/dom-notes.md` |
| 浏览器整体卡死、DevTools 端口不响应 | 关标签页时弹了原生「离开站点？」框。`Page.close()` 已做双保险；若仍出现，手动点掉弹窗 |
| 校验报「需上传完整尺码表信息」 | 「尺码表模板」列填抖店已存的模板名 |
| 价格/库存串行 | SKU 表行顺序 = 页面实际规格值顺序，与 Excel 顺序可能相反。脚本已按页面顺序读，若改过这段先看 dom-notes |
| `SKU 行数不匹配: 页面 3 行，预期 12 行` | 尺码没选上（只有规格值维度）。`setSizes` 现已校验并抛错，若仍出现看 dom-notes「尺码」节 |
| `SKU 行数不匹配: 页面 11 行，预期 12 行` | 虚拟表只渲染窗口内的行。已改成按 `scrollHeight/rowH` 算总数 + 逐窗口填写 |
| `以下 SKU 行未填写` | 虚拟表滚动步长没覆盖到全部行，看报错里列出的规格-尺码 |
| 大量 `等待超时` / 选择器找不到 | 抖店可能改版了。跑 `node {baseDir}/scripts/doctor.mjs --launch` 体检，命中兜底或失效的项去更新 `scripts/selectors.mjs` |
| 专用浏览器起不来 | 看 `~/.yonge/doudian/chrome-profile/chrome-err.log` |

失败时脚本会**保留标签页**（不自动关），方便在浏览器里直接看现场。
调试完手动关掉即可。配合 `--shots` 还会存一张错误截图。

## 完成汇报

```
抖店上架完成

模板: [路径]
素材: [根目录]
模式: [dry | draft | publish]

结果:
✓ [款号] [状态] [标题]
✗ [款号] [失败原因]

成功 N / M
截图: [目录]

待人工处理:
• [迁移警告 / 缺素材 / 校验未通过的项]

下一步:
→ 抖店后台复核: https://fxg.jinritemai.com（商品管理 → 草稿箱）
```
