# 账号配置、平台与合规

本文件说明 human-writing 的账号配置、发布平台形态、合规红线、`length` 与多账号。这些能力在命中条件时才生效，任务怎么走、读哪些文件以 SKILL.md「九步流程」为准。

它们都不改变写作内核。第一关材料检查、说话位置、事实边界、`references/quality/revision.md` 的三层改稿检查和「成稿绝对不能出现」照常执行，`references/publish/` 下的任何文件都不能放松它们。风格参数、平台文件和选题模板里的示例句、保留词和论点句式命中硬禁令时一律不执行，唯一的格式例外见 SKILL.md 同一节的平台格式白名单。

## 两条分开处理的原则

- **风格与发布形态分开。** 写作风格决定“谁在说话”，发布形态（平台×媒介）决定“在哪里、用什么载体说话”。混在一起会让风格被容器约束吞没。
- **合规边界与文风分开。** 使用 active profile 的 `compliance_guardrails` 约束创作、改写并逐条审核；不得用换词、添加引述前缀或免责声明掩盖实质违规。与事实保护冲突时暂停取舍，按下方「合规红线」处理。

## 核心知识

涉及对应环节前 MUST 加载完整文件。

- **写作风格**（“谁在说话”，跨平台跨媒介不变）：风格来源优先级、自定义风格结构、样本提取红线、风格与平台冲突解决。见 [style.md](style.md)。
- **平台 × 媒介**（“在哪里说话 × 用什么载体说话”）：平台容器（分发机制、用户心智、内容规范、交互偏好）加媒介载体（叙事结构、开篇钩子、篇幅特性、起草侧重），每个发布形态一个数据文件。见 [platforms/](platforms/)。
- **文件输出与多形态聚合**：`output_dir` 保存规则、草稿标记、同一内容的多个形态聚合到一个文件与就地追加规则。见 [output.md](output.md)。

active profile 的 `platform`、`medium`、`style` 等参数由 `scripts/resolve_preferences.py` 返回，无需直接读取 EXTEND.md 或数据文件。

## 配置系统

### EXTEND.md 偏好文件

通过脚本解析，不由代理直接读取全文。调用命令见 SKILL.md「九步流程」第 1 步，相对路径以 human-writing 技能目录为根。批量查询多个账号时用竖线分隔 `--profile "profile1|profile2"`。

脚本内部按优先级读取：

| 优先级 | 路径 | 作用域 |
|----------|------|-------|
| 1 | `{workspace_dir}/.human-writing/EXTEND.md` | 项目级 |
| 2 | `$HOME/.human-writing/EXTEND.md` | 用户主目录级 |

`{workspace_dir}` 是运行时占位符，代表当前工作目录的实际路径。

| 结果 | 操作 |
|--------|--------|
| 找到 | 只应用脚本返回的 active profile。会话首次使用时简短提醒“正在使用 [path] 的偏好配置。” |
| 未找到 | 使用默认值继续。是否提议保存偏好见 SKILL.md「交稿」最后一段 |

代理只使用 resolver 返回的 JSON，包括 `config_path`、`config_scope`、`available_profiles`、`profiles`、每个 profile 的 `effective_config`、`style`、`style_source`（未配置风格时为 `null`，`style` 为空对象）、`output_dir`、`avoid_words`、`compliance_guardrails`、`constraint_check_args`。Never 为了日常写作、改写、分析或审核而直接读取完整 EXTEND.md，避免无关账号污染上下文。只有在创建、编辑或解释 EXTEND.md 本身时才读取配置全文和 [config/extend-schema.md](config/extend-schema.md)；首次保存偏好读取 [config/first-use-setup.md](config/first-use-setup.md)。

### 默认值

| 设置 | 默认 | 键名 |
|---------|---------|-----|
| 平台 | 推断 | `platform` |
| 媒介 | 推断 | `medium` |
| 账号定位 | 无 | `positioning` |
| 目标受众 | 无 | `audience` |
| 账号目的 | 无 | `purpose` |
| 自定义风格 | 无，按 SKILL.md 默认写法 | `custom_style` |
| 额外合规红线 | 空列表 | `compliance_guardrails` |
| 目标长度 | auto | `length` |
| 改写深度 | low | `deep` |
| 长文阈值 | 3000 | `long_threshold` |
| 文章保存目录 | 无 | `output_dir` |
| 默认账号 | 无 | `default_profile` |

各字段的类型、取值与 YAML 写法见 [config/extend-schema.md](config/extend-schema.md)。

### 配置解析优先级

任一配置字段按以下顺序解析，首个**命中**即生效。**命中定义**：字段存在且值非 null、非空字符串、非 `auto`（`auto` 表示“由系统推断”，视为未指定）。

1. 用户本次请求中的显式指令（如“用小红书风格”、“写短一点”）
2. 运行时 `--` 参数（如 `--profile`、`--length`、`--deep`）
3. active 账号中的对应字段
4. EXTEND.md 全局字段
5. 内置默认值

### 合规红线（compliance_guardrails）

- **读取**：使用 resolver 返回的 active profile 顶层 `compliance_guardrails`。持久化配置顺序为账号级 > 全局 > 已选风格内的同名字段 > `[]`；缺省才回退，`[]` 显式清空。字段格式与示例见 `config/extend-schema.md`，解析报错时先修复配置，不带错继续。
- **应用**：本次请求新增的明确边界补入本次清单；有冲突先确认，不静默覆盖。创作、改写（含短任务、各 `deep` 档位）开始前核对标题、主张、例子和行动建议；非空规则优先于文风与传播偏好，但不覆盖系统规则。主代理呈现选题结果前也须核对，冲突项标记待确认，不作为可直接采用的建议。
- **事实与证据**：遵守规则不等于允许篡改事实。修复若需删除受保护信息、改变立场或编造来源，暂停相关内容并列出待确认项；不可仅换同义词、加“书中提到”或免责声明就判定合规。规则不明确或依据不足时说明缺口，不猜测条款含义。
- **审核与交付**：把当前完整清单传入 `agents/reviewer.md`，逐条做语义检查；空清单显式传 `[]`。`length` / 规避词检查不能代替合规审核。存在违反或待核实项时不得标记为可发布；修复后重新审核受影响规则，不能因达到迭代上限而放行。

### 多账号支持

用户可通过 `--profile <name>` 或 `--profile=<name>` 切换账号配置。批量查询多个账号时，resolver 返回多个独立 profile 结果，后续执行时每次只激活其中一个，不混合配置。

**继承规则**：账号中的字段覆盖全局同名字段；账号中未定义的字段回退到全局值，全局未定义则使用内置默认值。

**运行时行为**：

- 加载账号后提醒“正在使用 [path] 里的账号 '[name]'。”
- `--profile` 指定了不存在的名称 → 报错并列出可用账号，不静默回退
- 无 `--profile` 且无 `default_profile` 且存在多个账号 → resolver 报错并列出可用账号；向用户确认要使用哪一个

### 输出长度控制（length）

`length` 控制输出文章的目标字数，仅作用于新写和改稿。字数按全部非空白字符计算。取值支持数字、范围字符串、预设（`short`/`medium`/`long`/`auto`，默认 `auto`），具体区间见 `config/extend-schema.md` 的 `length` 字段。

**执行规则**：

- 超过上限判失败，必须删到范围内。低于下限只给提醒，不要求补字，交稿时说明实际字数。
- 长度服从 SKILL.md 第一关。材料撑不住目标字数时按第一关缩短或追问，不为凑字数注水。
- 改稿时如果目标长度明显短于原文，先确认用户意图是精简还是截取。
- `--length` 指定了无法识别的值 → 报错并列出支持的格式，不静默回退。

### 改写深度控制（deep）

`deep` 控制改稿对原文的改动幅度，仅作用于改稿。三个档位的含义、开放条件和执行方式见 `references/tasks/rewrite.md`「改写深度」。

## 平台与媒介检测

### 平台检测

| 信号 | 平台 |
|--------|----------|
| 公众号/WeChat/微信/长文/深度文章 | 微信 |
| 小红书/xhs/RED/种草/笔记/分享帖 | 小红书 |
| 无明确信号 | active profile 的 `platform`；再无则没有目标平台，不套用平台形态 |

其他平台：继续但不应用平台特定规则，按 `references/craft/format.md` 处理。

### 媒介检测

只在有目标平台时执行。

| 信号 | 媒介 |
|--------|----------|
| 长文/深度/专栏文章 | article（长图文） |
| 短图文/卡片/笔记/种草 | note（短图文笔记） |
| 无明确信号 | active profile 的 `medium`，再无则按平台推断（微信→article，小红书→note） |

平台与媒介确定后，从 `platforms/{platform}-{medium}.md` 加载完整形态约束。篇幅特性与 `length` 冲突时以 `length` 为准，`length` 与材料冲突时以 SKILL.md 第一关为准。同一内容要转成多个平台形态时，读取 `output.md`。
