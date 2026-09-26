# 账号配置、平台与合规

本文件说明 human-rewriter 的账号配置、发布平台形态、合规红线、`length` 与 `deep`。这些能力在命中条件时才生效，任务怎么走、读哪些文件以 SKILL.md「按任务读取」为准。

它们都不改变写作内核。第一关材料检查、说话位置、事实边界、`references/revision.md` 的七遍改稿和「成稿绝对不能出现」照常执行，`references/media/` 下的任何文件都不能放松它们。

## 关键规则

这些规则贯穿选题、创建、改写、分析和审核全流程。

1. **MUST 先保意思，再改文风。** 语义锚点（名称、数字、因果、极性等）不可改变含义。改写模式下此规则受 `--deep` 档位调节，`low` 全部保护，`medium` 仅保护核心事实，`high` 转为结构蓝图约束（详见 `workflows/rewrite.md` 步骤 3）。
2. **MUST 理解段落意图后重新组织表达。** Never 仅做同义词替换或短语级修饰。逐段重写的做法见 `references/rework.md`。
3. **MUST 风格与发布形态分开处理。** 写作风格决定"谁在说话"，发布形态（平台×媒介）决定"在哪里、用什么载体说话"。混在一起会让风格被容器约束吞没。
4. **MUST 把合规边界与文风分开处理。** 使用 active profile 的 `compliance_guardrails` 约束创作、改写并逐条审核；不得用换词、添加引述前缀或免责声明掩盖实质违规。与事实保护冲突时暂停取舍，按下方「合规红线」处理。
5. **MUST 让硬禁令高于平台、风格和选题模板。** 平台文件、风格预设和选题子代理给出的示例句、保留词、论点句式，命中 SKILL.md「成稿绝对不能出现」时一律不执行。唯一的格式例外见 SKILL.md 同一节的平台格式白名单。

## 核心知识

涉及对应环节前 MUST 加载完整文件。

- **写作风格**（"谁在说话"，跨平台跨媒介不变）：风格来源优先级、内置预设（`lucid-tech` / `life-observer` / `sharp-commentary` / `warm-narrative`）、自定义风格结构、样本提取红线、风格与平台冲突解决。见 [voice.md](voice.md)。
- **平台 × 媒介**（"在哪里说话 × 用什么载体说话"）：平台容器（分发机制、用户心智、内容规范、交互偏好）加媒介载体（叙事结构、开篇钩子、篇幅特性、起草侧重），每个发布形态一个数据文件。见 [platforms/](platforms/)。
- **内容形态转换输出**：同一内容的多个形态聚合到一个文件（`# {platform}-{medium}` 分区）与就地追加规则。见 [multi-format-output.md](multi-format-output.md)。

active profile 的 `platform`、`medium`、`style` 等参数由 `scripts/resolve_preferences.py` 返回，无需直接读取 EXTEND.md 或数据文件。

## 交互流程 simple 与 detail

环节对照与决定顺序见 SKILL.md「交互流程 simple 与 detail」。有目标平台时，平台形态文件在两种流程里都加载，分析结束后转入写作时沿用当前 flow。

simple 模式仍然检查合规红线。合规清单没有逐条通过时，稿子不能标为可发布，这条不因 flow 放宽。清单为空时 simple 不多出任何步骤。

## 配置系统

### EXTEND.md 偏好文件

通过脚本解析，不由代理直接读取全文。下面的相对路径以 human-rewriter 技能目录为根：

```bash
python3 scripts/resolve_preferences.py \
  --workspace-dir "{workspace_dir}" \
  --profile "profile1|profile2"
```

脚本内部按优先级读取：

| 优先级 | 路径 | 作用域 |
|----------|------|-------|
| 1 | `{workspace_dir}/.human-rewriter/EXTEND.md` | 项目级 |
| 2 | `$HOME/.human-rewriter/EXTEND.md` | 用户主目录级 |

| 结果 | 操作 |
|--------|--------|
| 找到 | 只应用脚本返回的 active profile。会话首次使用时简短提醒 "Using preferences from [path]." |
| 未找到 | 使用默认值继续。detail 流程在首个任务完成后提供 "要我把这些偏好保存下来，下次自动用？"；simple 流程不提 |

代理只使用 resolver 返回的 JSON，包括 `config_path`、`config_scope`、`available_profiles`、`profiles`、每个 profile 的 `effective_config`、`style`、`style_source`（未配置风格时为 `null`，`style` 为空对象）、`output_dir`、`avoid_words`、`compliance_guardrails`、`constraint_check_args`。Never 为了日常写作、改写、分析或审核而直接读取完整 EXTEND.md；只有在创建、编辑或解释 EXTEND.md 本身时才读取配置全文和 schema。

### 默认值

| 设置 | 默认 | 键名 |
|---------|---------|-----|
| 平台 | 推断 | `platform` |
| 媒介 | 推断 | `medium` |
| 账号定位 | 无 | `positioning` |
| 目标受众 | 无 | `audience` |
| 账号目的 | 无 | `purpose` |
| 写作风格 | 无，按 SKILL.md 默认写法 | `writing_style` |
| 自定义风格 | 无 | `custom_style` |
| 额外合规红线 | 空列表 | `compliance_guardrails` |
| 目标长度 | auto | `length` |
| 改写深度 | low | `deep` |
| 长文阈值 | 3000 | `long_threshold` |
| 文章保存目录 | 无 | `output_dir` |
| 默认账号 | 无 | `default_profile` |

各字段的类型、取值与 YAML 写法见 [config/extend-schema.md](config/extend-schema.md)。首次使用设置见 [config/first-use-setup.md](config/first-use-setup.md)。

### 配置解析优先级

任一配置字段按以下顺序解析，首个**命中**即生效。**命中定义**：字段存在且值非 null、非空字符串、非 `auto`（`auto` 表示"由系统推断"，视为未指定）。

1. 用户本次请求中的显式指令（如"用小红书风格"、"写短一点"）
2. 运行时 `--` 参数（如 `--profile`、`--length`、`--deep`）
3. active 账号中的对应字段
4. EXTEND.md 全局字段
5. 内置默认值

### 合规红线（compliance_guardrails）

- **读取**：使用 resolver 返回的 active profile 顶层 `compliance_guardrails`。持久化配置顺序为账号级 > 全局 > 已选风格内的同名字段 > `[]`；缺省才回退，`[]` 显式清空。字段格式与示例见 `config/extend-schema.md`，解析报错时先修复配置，不带错继续。
- **应用**：本次请求新增的明确边界补入本次清单；有冲突先确认，不静默覆盖。创作、改写（含短任务、各 `deep` 档位、simple 与 detail 两种流程）开始前核对标题、主张、例子和行动建议；非空规则优先于文风与传播偏好，但不覆盖系统规则。主代理呈现选题结果前也须核对，冲突项标记待确认，不作为可直接采用的建议。
- **事实与证据**：遵守规则不等于允许篡改事实。修复若需删除受保护信息、改变立场或编造来源，暂停相关内容并列出待确认项；不可仅换同义词、加"书中提到"或免责声明就判定合规。规则不明确或依据不足时说明缺口，不猜测条款含义。
- **审核与交付**：把当前完整清单传入 `agents/article-review.md`，逐条做语义检查；空清单显式传 `[]`。`length` / 规避词检查不能代替合规审核。存在违反或待核实项时不得标记为可发布；修复后重新审核受影响规则，不能因达到迭代上限而放行。

### 多账号支持

用户可通过 `--profile <name>` 或 `--profile=<name>` 切换账号配置。批量查询多个账号时使用竖线分隔 `--profile "profile1|profile2"`；resolver 返回多个独立 profile 结果，后续执行时每次只激活其中一个，不混合配置。

**继承规则**：账号中的字段覆盖全局同名字段；账号中未定义的字段回退到全局值，全局未定义则使用内置默认值。

**运行时行为**：

- 加载账号后提醒 "Using profile '[name]' from [path]."
- `--profile` 指定了不存在的名称 → 报错并列出可用账号，不静默回退
- 无 `--profile` 且无 `default_profile` 且存在多个账号 → resolver 报错并列出可用账号；向用户确认要使用哪一个

### 输出长度控制（length）

`length` 控制输出文章的目标字数，仅作用于创建和改写模式。字数按全部非空白字符计算。取值支持数字、范围字符串、预设（`short`/`medium`/`long`/`auto`，默认 `auto`），具体区间见 `config/extend-schema.md` 的 `length` 字段。

**执行规则**：

- 超过上限判失败，必须删到范围内。低于下限只给提醒，不要求补字，交稿时说明实际字数。
- 长度服从 SKILL.md 第一关。材料撑不住目标字数时按第一关缩短或追问，不为凑字数注水。
- 改写模式下，如果目标长度明显短于原文，先确认用户意图是精简还是截取。
- `--length` 指定了无法识别的值 → 报错并列出支持的格式，不静默回退。

### 改写深度控制（deep）

`deep` 控制改写模式对原文的改动幅度，仅作用于改写模式。

| 档位 | 含义 | 约束对象 | 典型场景 |
|------|------|----------|----------|
| `low`（默认） | 表层改写 | 语义锚点全部保护 | 去 AI 味、润色、换表达 |
| `medium` | 中度改写 | 仅保护核心事实（名称/数据/因果），释放示例和过渡 | 替换论据、重排段落、增删支撑细节 |
| `high` | 结构复刻 | 不提取语义锚点，改为提取结构框架 | 借用原文骨架，以全新内容重写 |

`medium` 和 `high` 引入的新论据、案例和数据，只能来自用户材料或检索到的可核验来源。虚构题材可以按 `references/fiction.md` 创造。现实题材没有新材料时不开放 `high`，改用 `low` 或 `medium`，并告诉用户原因。

`--deep` 指定了无法识别的值 → 报错并列出支持的档位，不静默回退。

## 运行规则

任务类型的判断和文件加载清单见 SKILL.md「按任务读取」，本节只补账号、平台与子代理相关的规则。

### 代理行为

- **配置读取**：存在 EXTEND.md 或带了 `--profile` 时，MUST 调用 `scripts/resolve_preferences.py` 获取 active profile，Never 直接 `read` 完整 EXTEND.md，避免无关账号污染上下文。只有在创建、编辑或解释 EXTEND.md 本身时才读取 `config/extend-schema.md`；首次保存偏好读取 `config/first-use-setup.md`。
- **工作目录**：`{workspace_dir}` 是运行时占位符，代表当前工作目录的实际路径。
- **子代理调度**：选题与审核需要派发子代理时，MUST 先读取对应子代理说明（`agents/*.md`），按其中的调度规则派发。选题子代理只产出选题评审和 3 个推荐方案，不写正文；审核子代理只评估质量，不参与创作。创作正文 MUST 使用单代理完成。Never 向审核子代理传递创作会话历史。
- **用户提问工具**：需要向用户提问时，使用运行时内置的用户输入工具；没有时输出纯文本编号列表。尽量合并问题，一次最多问 3 个。

### 平台检测

| 信号 | 平台 |
|--------|----------|
| 公众号/WeChat/微信/长文/深度文章 | 微信 |
| 小红书/xhs/RED/种草/笔记/分享帖 | 小红书 |
| 无明确信号 | active profile 的 `platform`；再无则没有目标平台，不套用平台形态 |

其他平台：继续但不应用平台特定规则，按 `references/formats.md` 处理。

### 媒介检测

只在有目标平台时执行。

| 信号 | 媒介 |
|--------|----------|
| 长文/深度/专栏文章 | article（长图文） |
| 短图文/卡片/笔记/种草 | note（短图文笔记） |
| 无明确信号 | active profile 的 `medium`，再无则按平台推断（微信→article，小红书→note） |

平台与媒介确定后，从 `platforms/{platform}-{medium}.md` 加载完整形态约束。同一内容要转成多个平台形态时，读取 `multi-format-output.md`。

### 短任务压缩

少于 500 字符（固定阈值，不受 `long_threshold` 影响）、且用户只需要语气修复或小幅润色的任务，按"读取 → 修复 → 检查"执行。审核子代理是否派发按 flow 决定。500 字符至 `long_threshold`（默认 3000）之间走常规流程，超过 `long_threshold` 走长内容流程。

### 长内容处理（> long_threshold）

1. **创建**：先拟分节大纲。detail 流程与用户确认结构后再分节起草；simple 流程直接分节起草。
2. **改写**：按标题或主题分节处理，保持跨节语气一致性。
3. **审核**：委派审核子代理，按节呈现报告，附带段落引用。

## 下一步建议

detail 流程完成任务后，用一行简短话语提供自然的下一步引导，不自动执行，等待用户回应。simple 流程不加这一行。

## 收尾强制检查

输出前 MUST 确认以下全部通过，任一不通过则继续修改：

1. 表达经过重建而非仅替换词语（关键规则#2）
2. 第一关材料检查已执行，篇幅与材料相称
3. `scripts/check_prose.py` 的失败项已清零（平台标签冒号只在 `--platform-labels` 下放行）
4. 已配置的合规红线逐条审核，无未解决的违反或待核实项；否则仅交付问题说明或标明待处理的草稿，不标记为可发布
