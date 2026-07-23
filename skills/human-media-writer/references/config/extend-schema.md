# EXTEND.md 模式定义

本文件定义了 human-media-writer EXTEND.md 配置文件的所有支持字段。

## 文件格式

EXTEND.md 使用 YAML 前言（frontmatter）来定义结构化字段。每个账号以 kebab-case 名称作为顶层 key，直接定义其属性。

```yaml
---
default_profile: wechat-tech
long_threshold: 3000
output_dir: articles
avoid_words:
  - 赋能
  - 助力

wechat-tech:
  platform: wechat
  medium: article
  positioning: "泛技术人群的认知升级"
  audience: "25-40岁互联网从业者，关注效率与思维方式"
  purpose: "建立个人品牌，沉淀方法论内容资产"
  writing_style: lucid-tech
  length: long
  long_threshold: 5000
  avoid_words:
    - 底层逻辑
    - 生态闭环

xhs-lifestyle:
  platform: xhs
  medium: note
  positioning: "生活方式分享与好物种草"
  audience: "20-35岁女性，追求品质生活"
  purpose: "变现（带货/广告合作）"
  writing_style: life-observer
  length: short
  long_threshold: 2000
  avoid_words:
    - 赋能

wechat-personal:
  platform: wechat
  medium: article
  positioning: "个人思考与生活记录"
  audience: "熟人圈层，朋友和同事"
  purpose: "记录生活，保持表达习惯"
  writing_style: warm-narrative
  length: "1000-1500"
  custom_style:                   # 完整字段结构见下方 §custom_style
    name: 个人随笔
    register: 口语-温暖型
    preferred_opening: scene
    ending_style: 落在一个未解的念头上
---
```

**继承规则**：账号内的字段覆盖全局同名字段；账号中未定义的字段回退到全局值，全局未定义则使用内置默认值。

**账号 key 识别**：YAML 顶层 key 中，值为对象（dict）且不属于保留字的，视为账号定义。保留字：`default_profile`、`long_threshold`、`output_dir`、`avoid_words`。

## 字段定义

### 全局字段

多账号时用于设置回退默认值。单账号时可省略。

| 字段 | 类型 | 默认值 | 说明 |
|-------|------|---------|------|
| `default_profile` | 字符串 | （无） | 默认激活的账号名 |
| `long_threshold` | 数字 | 3000 | 长内容流的字符数阈值 |
| `output_dir` | 字符串 | （无） | 创建/改写完成后保存 Markdown 文章的目录 |
| `avoid_words` | 列表 | （无） | 全局规避词（与风格文件中的 words_to_avoid 合并取并集） |

### 账号属性

每个账号 key 下可包含以下字段：

| 字段 | 类型 | 默认值 | 说明 |
|-------|------|---------|------|
| `platform` | 字符串 | （推断） | `wechat` 或 `xhs` |
| `medium` | 字符串 | （推断） | 内容媒介（载体）：`article`（长图文）或 `note`（短图文笔记） |
| `positioning` | 字符串 | （无） | 账号定位——一句话描述账号的内容方向和差异化角度 |
| `audience` | 字符串 | （无） | 目标受众画像——描述核心读者群体特征 |
| `purpose` | 字符串 | （无） | 做账号的最终目的——变现方式、品牌目标或个人动机 |
| `writing_style` | 字符串 | `warm-narrative` | 内置预设名 |
| `custom_style` | 对象 | （无） | 内联自定义写作风格（字段结构同 styles/*.md 的 frontmatter），优先级高于 `writing_style` |
| `length` | 数字/字符串 | `auto` | 输出文章目标字数。数字、范围字符串（`"800-1200"`）或预设（`short`/`medium`/`long`/`auto`） |
| `long_threshold` | 数字 | 3000 | 长内容流的字符数阈值 |
| `output_dir` | 字符串 | （无） | 创建/改写完成后保存 Markdown 文章的目录；账号内配置可覆盖全局配置 |
| `avoid_words` | 列表 | （无） | 该账号的规避词列表（替换而非合并全局列表） |

## 字段详情

### platform

设置后将跳过平台推断。技能仍会遵循用户请求中明确提及的平台（这些会覆盖此值）。

### medium

内容媒介（载体），决定叙事结构、开篇钩子、篇幅特性，与平台组合为发布形态。技能从 `references/platforms/{platform}-{medium}.md` 加载对应约束。

```yaml
medium: article    # 长图文（公众号深度文、专栏）
medium: note       # 短图文笔记（小红书笔记、公众号短图文）
```

**行为规则**：

- 设置后跳过媒介推断；用户请求中明确提及的媒介（"写条笔记"、"写篇长文"）覆盖此值。
- 未设置时按平台推断默认媒介：微信→article，小红书→note。
- 媒介的篇幅特性是软性结构指导；与 `length` 硬约束冲突时**以 `length` 为准**（`length` 由脚本确定性校验，媒介篇幅只是载体倾向）。

### positioning

一句话描述账号的内容方向和差异化角度。用于帮助技能理解内容应在什么领域、以什么视角展开。

```yaml
positioning: "泛技术人群的认知升级"
positioning: "生活方式分享与好物种草"
positioning: "商业分析与行业洞察"
```

**行为规则**：
- 影响选题建议的方向——技能会优先推荐与定位吻合的切入角度
- 当用户素材与账号定位明显不匹配时，提醒用户确认
- 不会机械地限制内容范围——定位是引导，不是硬约束

### audience

描述核心读者群体特征。可以包含年龄段、职业、兴趣、痛点等信息。

```yaml
audience: "25-40岁互联网从业者，关注效率与思维方式"
audience: "20-35岁女性，追求品质生活"
audience: "中小企业主和创业者，关注增长和管理"
```

**行为规则**：
- 影响措辞选择——技能会根据受众特征调整用语的专业程度和亲和度
- 影响例子和类比的选取——优先使用受众熟悉的场景
- 影响内容深度——面向专业读者可跳过基础解释，面向泛人群需降低门槛

### purpose

做账号的最终目的。明确目的有助于技能在内容策略层面做出更贴合的判断。

```yaml
purpose: "建立个人品牌，沉淀方法论内容资产"
purpose: "变现（带货/广告合作）"
purpose: "获客引流至私域"
purpose: "记录生活，保持表达习惯"
```

**行为规则**：
- 影响 CTA（行动号召）的使用——变现目的允许更明确的引导，个人记录则不需要
- 影响选题优先级——品牌目的偏向深度内容，获客目的偏向高传播性内容
- 不会在文章中直接暴露目的——这是策略层信息，不是写作指令

### writing_style

指定写作风格来源。值为内置预设名，技能从 `references/styles/{name}.md` 加载（脚本读 frontmatter 字段，正文是给代理读的风格说明）。

```yaml
writing_style: lucid-tech
```

可用预设：`lucid-tech`、`life-observer`、`sharp-commentary`、`warm-narrative`

未设置时自动使用 `warm-narrative` 预设。

### length

控制输出文章的目标字数。仅作用于创建和改写模式，审核模式不受影响。

支持三种值类型：

```yaml
# 精确目标（允许 ±15% 浮动）
length: 1500

# 范围
length: "800-1200"

# 预设
length: short      # 300-500 字符（适合小红书笔记）
length: medium     # 1000-2000 字符
length: long       # 2500-4000 字符（适合公众号深度文）
length: auto       # 根据素材量和平台自动判断（默认）
```

**行为规则**：
- 用户本次请求的显式长度指令（"写短一点"、"2000字左右"）优先于此配置
- 长度是软约束——宁可内容完整地少写 100 字，也不为凑字数注水
- 素材量与目标长度严重不匹配时，提醒用户而非强行填充
- 改写模式下目标长度明显短于原文时，先确认用户意图是精简还是截取
- 创建/改写完成后的审核阶段由审核子代理调用 `scripts/check_article_constraints.py` 确定性检查实际字数是否落入目标范围，避免只靠模型估算

### output_dir

设置创建和改写模式的文章保存目录。未设置时只在对话中输出文章，不写文件。

```yaml
# 相对路径：保存到当前项目工作目录下的 articles/
output_dir: articles

# 绝对路径：保存到指定目录
output_dir: /Users/me/articles
```

**路径规则**：
- 以 `/` 开头的路径按绝对路径处理
- 不以 `/` 开头的路径按当前项目工作目录的相对路径处理
- 账号内的 `output_dir` 覆盖全局 `output_dir`

**行为规则**：
- 仅作用于创建和改写模式，审核和分析模式不自动保存文章
- resolver 返回的 `output_dir` 是解析后的实际保存目录
- 技能保存最终版本为 Markdown 文件，并避免覆盖同名文件
- 保存失败时仍输出文章，并说明失败原因

### custom_style

内联自定义写作风格，字段结构与 `references/styles/*.md` 的 frontmatter 相同（custom_style 是 EXTEND.md 里的 dict，只有 frontmatter 字段、没有正文——正文是 styles 文件给代理读的说明，机器只读 `words_to_avoid`）。设置后优先级高于 `writing_style` 风格预设名。这是自定义风格字段结构的权威模板——`references/writing-style.md` §写作风格系统 只列字段名，需要照抄完整结构时读这里。

```yaml
custom_style:
  name: "风格名称"
  description: "一句话描述风格特征"

  # 语域与基调
  register: "随性-技术型"          # 正式 / 随性 / 口语 / 文学 / 混合描述
  stance: "自信但留余地"           # 用自然语言描述立场

  # 节奏
  sentence_rhythm: "短中混合，偶尔长句做收束"
  paragraph_behavior: "短段落，每段一个论点，不对称"

  # 措辞
  favorite_moves:                  # 3-5 个标志性手法
    - "矛盾式开头"
    - "冷幽默收尾"
  words_to_keep: "其实|说白了"       # 作者常用的口头禅/标志词，用"|"分隔多个
  words_to_avoid: "赋能|助力"         # 此风格下应规避的词，用"|"分隔多个

  # 情感与自我
  emotional_range: "从觉得好笑到轻度无奈"
  self_presence: "第一人称较多，但不自恋"

  # 开头与结尾
  preferred_opening: "contradiction"  # scene / contradiction / data / confession / problem
  ending_style: "具体收获或未解问题，不要口号"
```

字段规则：

- 所有值用自然语言描述——风格是连续谱，不是离散枚举
- `words_to_avoid` 与全局 `avoid_words` 取并集生效
- `preferred_opening` 是偏好而非强制——内容需要时可选其他开头方式
- 不要在风格定义里混入平台约束（段落字数、emoji 策略）或媒介约束（叙事结构、开篇钩子）

**优先级**：`custom_style` > `writing_style` 预设名。

### avoid_words

扩展内置的 ai-tell-catalog 和风格文件中的 `words_to_avoid`。此处列出的词语在审核和重写时会被视为 P1 级别信号。

**合并规则**：最终的规避词列表 = ai-tell-catalog 内置词 ∪ 风格文件的 words_to_avoid ∪ EXTEND.md 的 avoid_words。

审核阶段由审核子代理调用 `scripts/check_article_constraints.py` 确定性扫描最终正文。脚本只检查 EXTEND.md、active 账号、custom_style 和风格预设中可逐字匹配的规避词；ai-tell-catalog 中的结构、句法和语气信号仍由审核子代理判断。命中 `avoid_words` 或 `custom_style.words_to_avoid` 时，先按硬约束修复；只有当修复会删减事实或改变立场时，才进入待确认清单。

### default_profile

指定未使用 `--profile` 参数时默认激活的账号名。值必须是 YAML 中已定义的账号 key。

如果设置了 `default_profile` 但对应的账号 key 不存在 → 忽略该字段，回退到第一个账号定义。

### 账号 key 命名

**命名规范**：使用 kebab-case，建议格式为 `平台-定位`（如 `wechat-tech`、`xhs-lifestyle`）。

**字段覆盖规则**：
- 标量字段（字符串、数字、布尔）：账号值直接替换全局值
- 列表字段（`avoid_words`）：账号值完整替换全局列表，不做合并
- 未在账号中出现的字段：回退到全局值，全局未定义则使用内置默认值
