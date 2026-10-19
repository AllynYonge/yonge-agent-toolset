# EXTEND.md 模式定义

本文件定义了 human-writing EXTEND.md 配置文件的所有支持字段。配置文件位于 `{workspace_dir}/.yonge/.yonge-skills/human-writing/EXTEND.md`（项目级）或 `~/.yonge/.yonge-skills/human-writing/EXTEND.md`（用户级），查找顺序是项目级优先、命中即停。旧路径 `.human-writing/`、`.yonge-skills/.human-writing/` 与 `~/.human-writing/` 已不再读取，遇到旧配置请按新路径移动。

用户同意保存时，才创建或写入这个文件。首个任务完成后会主动提议保存一次（SKILL.md「交稿」最后一段）。只写用户同意保存的字段。

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
  length: "1000-1500"
  custom_style:                   # 完整字段结构见下方 §custom_style
    name: 个人随笔
    register: 口语-温暖型
    preferred_opening: scene
    ending_style: 落在一个未解的念头上
---
```

**继承规则**：账号内的字段覆盖全局同名字段；账号中未定义的字段回退到全局值，全局未定义则使用内置默认值。

**账号 key 识别**：YAML 顶层 key 中，值为对象（dict）且不属于保留字的，视为账号定义。保留字由 `scripts/lib/preferences.ts` 的 `RESERVED_GLOBAL_KEYS` 定义，包含 `compliance_guardrails`；该字段不会被识别为账号。

## 字段定义

### 全局字段

多账号时用于设置回退默认值。单账号时可省略。

| 字段 | 类型 | 默认值 | 说明 |
|-------|------|---------|------|
| `version` | 整数 | 1 | 配置格式版本，由 config-kit 校验；缺省时按 1 处理并给出提醒 |
| `default_profile` | 字符串 | （无） | 默认激活的账号名 |
| `long_threshold` | 数字 | 3000 | 长内容流的字符数阈值 |
| `output_dir` | 字符串 | （无） | 创建/改写完成后保存 Markdown 文章的目录 |
| `avoid_words` | 列表 | （无） | 全局规避词（与 custom_style 中的 words_to_avoid 合并取并集） |
| `compliance_guardrails` | 字符串列表 | `[]` | 全局合规红线；解析顺序与格式见下方同名小节 |

### 账号属性

每个账号 key 下可包含以下字段：

| 字段 | 类型 | 默认值 | 说明 |
|-------|------|---------|------|
| `platform` | 字符串 | （推断） | `wechat`、`xhs`、`zhihu` 或 `forum` |
| `medium` | 字符串 | （推断） | 内容媒介（载体）：`article`（长图文）、`note`（短图文笔记）、`answer`（知乎回答）或 `post`（论坛帖） |
| `positioning` | 字符串 | （无） | 账号定位——一句话描述账号的内容方向和差异化角度 |
| `audience` | 字符串 | （无） | 目标受众画像——描述核心读者群体特征 |
| `purpose` | 字符串 | （无） | 做账号的最终目的——变现方式、品牌目标或个人动机 |
| `deep` | 字符串 | `low` | 改写深度：`low`、`medium` 或 `high` |
| `custom_style` | 对象 | （无） | 内联自定义写作风格，字段结构见下方 §custom_style；未设置时按 SKILL.md 默认写法 |
| `length` | 数字/字符串 | `auto` | 输出文章目标字数。数字、范围字符串（`"800-1200"`）或预设（`short`/`medium`/`long`/`auto`） |
| `long_threshold` | 数字 | 3000 | 长内容流的字符数阈值 |
| `output_dir` | 字符串 | （无） | 创建/改写完成后保存 Markdown 文章的目录；账号内配置可覆盖全局配置 |
| `avoid_words` | 列表 | （无） | 该账号的规避词列表（与全局列表取并集） |
| `compliance_guardrails` | 字符串列表 | 继承 | 账号合规红线，覆盖而非合并全局清单 |

## 字段详情

### platform

设置后将跳过平台推断。技能仍会遵循用户请求中明确提及的平台（这些会覆盖此值）。

### medium

内容媒介（载体），决定叙事结构、开篇钩子、篇幅特性，与平台组合为发布形态。技能从 `references/publish/platforms/{platform}-{medium}.md` 加载对应约束。

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

### length

控制输出文章的目标字数。仅作用于创建和改写模式，审核模式不受影响。

字数按全部非空白字符计算。支持三种值类型：

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
- 超过上限判失败，必须删到范围内；低于下限只给提醒，不要求补字，交稿时说明实际字数
- 改写模式下目标长度明显短于原文时，先确认用户意图是精简还是截取

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

内联自定义写作风格，是 EXTEND.md 里的 dict。resolver 返回完整风格，并提取 `words_to_avoid` 和可选的 `compliance_guardrails`；后者由代理做语义审核。技能没有内置风格预设，旧配置里的 `writing_style` 字段已取消，resolver 遇到会报错，请删除该字段。这是自定义风格字段结构的权威模板——`references/publish/style.md` 只列字段名，需要照抄完整结构时读这里。

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
  words_to_keep: "其实|换句话说"     # 作者常用的口头禅/标志词，用"|"分隔多个；命中硬禁令的词不生效
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
- `words_to_avoid` 与全局、账号 `avoid_words` 取并集生效
- `preferred_opening` 是偏好而非强制——内容需要时可选其他开头方式
- `words_to_keep`、`favorite_moves` 里出现违背 `references/modes/prose.md` 语体规范的词和句式时，一律不执行
- 不要在风格定义里混入平台约束（段落字数、emoji 策略）或媒介约束（叙事结构、开篇钩子）

可在 `custom_style` 中放置 `compliance_guardrails` 作为回退清单；它不是声音参数，优先放在账号级。不要同时复制到 `stance`、`description` 等字段；具体行为见下一节。

### compliance_guardrails

该账号创作、改写与审核时必须遵守的内容边界，独立于文风和逐字规避词。规则须用完整自然语言说明禁止的行为及适用条件，不要只填条款编号或假定代理读过其它会话。示例是账号自定规则，不是平台公布的通用违禁词表。

```yaml
wechat-living:
  compliance_guardrails:
    - "不得宣称或暗示普通食品、日用品可以治疗疾病或替代药物。"
    - "不得借生活知识分享变相推销医疗服务、药品、医疗器械或保健食品，也不得引导读者联系销售人员购买。"
    - "引用书籍或研究时注明真实来源，不编造来源，也不把相关性写成因果关系。"
```

**解析顺序**：账号级 `compliance_guardrails` > 全局同名字段 > `custom_style` 中的同名字段 > `[]`。只取首个存在的字段，不跨层合并；结果由 resolver 的每个 profile 顶层 `compliance_guardrails` 返回，代理不再自行选择原始字段。

**格式与空值**：

- 类型为非空字符串组成的列表；条目前后空白会被移除，顺序不变。
- 字段缺省才继承；显式 `[]` 表示不使用下层清单，不会撤销系统规则或实际适用的法律、平台要求。
- 本字段不使用通用的 `null` / `auto` 回退约定。被选中的值若为字符串、对象、数字、布尔值、`null` 或含空白/非字符串条目的列表，resolver 报错，不继续写作。
- 使用两空格缩进的多行 YAML 列表，每条规则用引号包裹并写在单行。空清单写 `[]`，不要只留字段名；行内数组 `[a, b]` 也能解析，但规则含逗号或冒号时必须加引号。`|` / `>` 多行字符串不支持。
- 没有独立 CLI 参数或环境变量入口；本次请求新增的明确内容边界由主代理补入任务清单。若与已生效规则冲突，先确认取舍，不静默覆盖。

**执行与检查**：

- 执行契约见 `references/publish/overview.md`「合规红线」：写作前核对，成稿后逐条审核，不因风格、传播效果或篇幅要求放宽边界。
- `check_constraints.ts` 的配置检查只确定性检查字数和规避词，不判断这些规则的语义；脚本通过不代表合规通过。需要逐字匹配的词仍放在 `avoid_words` / `words_to_avoid`。
- 审核任务须收到完整清单并逐条返回结论、原文证据或核实缺口。配置为空时写明未配置额外规则，不宣称已通过全部法律或平台审核。

### avoid_words

扩展 `custom_style` 中的 `words_to_avoid`。此处列出的词语在审核和重写时按硬约束修复。

**合并规则**：最终的规避词列表 = 全局 `avoid_words` ∪ 账号 `avoid_words` ∪ `custom_style` 的 `words_to_avoid`。

账号写 `avoid_words: []` 表示本账号不额外增加规避词，全局词继续生效。

`scripts/check_constraints.ts` 的规避词检查只覆盖 EXTEND.md、active 账号和 custom_style 中可逐字匹配的词；结构、句法和语气层面的 AI 痕迹由 `scripts/check_prose.ts` 的形状检查提示。

账号规避词来自用户配置，独立于通用散文语体规范。命中 `avoid_words` 或 `custom_style.words_to_avoid` 时，先按硬约束修复；只有当修复会删减事实或改变立场时，才进入待确认清单。

### default_profile

指定未使用 `--profile` 参数时默认激活的账号名。值必须是 YAML 中已定义的账号 key。

如果设置了 `default_profile` 但对应的账号 key 不存在 → 忽略该字段，回退到第一个账号定义。

### 账号 key 命名

**命名规范**：使用 kebab-case，建议格式为 `平台-定位`（如 `wechat-tech`、`xhs-lifestyle`）。

**字段覆盖规则**：
- 标量字段（字符串、数字、布尔）：账号值直接替换全局值
- `avoid_words`：全局与账号取并集，账号写 `[]` 也不清空全局词
- 列表字段 `compliance_guardrails`：账号值完整替换全局列表，不做合并
- 未在账号中出现的字段：回退到全局值，全局未定义则使用内置默认值
