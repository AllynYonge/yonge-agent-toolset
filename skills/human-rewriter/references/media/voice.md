# 声音风格

本文件只管"谁在说话"的声音身份，也就是风格预设、自定义风格和样本提取。写作风格跨平台、跨媒介不变；发布形态约束见 [platforms/](platforms/)。

散文的底层写法不在这里定义。材料检查、说话位置、具体细节、判断来路和事实边界，一律以 SKILL.md、`references/forum-prose.md` 和 `references/reality.md` 为准。风格只调整语域、立场、节奏、标志手法和用词，不能放松这些底线。

风格参数与硬禁令冲突时，硬禁令优先。`words_to_keep`、`favorite_moves`、`preferred_opening` 里出现 SKILL.md「成稿绝对不能出现」覆盖的词和句式时，一律不执行。

## 写作风格系统

写作风格是"谁在说话"的声音身份，跨平台、跨媒介不变。发布形态（平台×媒介）是"在哪里、用什么载体说话"的约束，跨作者不变。两者分开处理（关键规则#3）。以下是写作风格的解析与运用。

### 风格来源与优先级

按优先级解析，首个命中的生效：

1. 用户本次请求的显式指令（"用犀利的风格"、"轻松一点"）
2. EXTEND.md 中的 `custom_style`（内联自定义风格定义）
3. EXTEND.md 中的 `writing_style`（内置风格预设名）→ 加载 `references/media/styles/{name}.md`（脚本读 frontmatter 字段，正文是给代理读的风格说明）
4. 都没有时不套用任何预设，按 SKILL.md 的默认写法写。内置预设只在选用时生效

### 内置风格预设

存放于 `references/media/styles/`，可直接在 `writing_style` 中引用：

| 预设名 | 适合场景 |
|--------|----------|
| `lucid-tech` | 技术分析、产品评测、行业拆解 |
| `life-observer` | 生活方式、个人成长、日常分享 |
| `sharp-commentary` | 行业评论、观点输出、现象批评 |
| `warm-narrative` | 故事型内容、人物特写、回忆录 |

### 自定义风格结构

自定义风格（用户提供或从样本提取）用一组字段描述声音身份：`name`、`description`、`register`（语域）、`stance`（立场）、`sentence_rhythm`（句子节奏）、`paragraph_behavior`（段落行为）、`favorite_moves`（标志手法）、`words_to_keep`（标志词）、`words_to_avoid`（规避词）、`emotional_range`（情感范围）、`self_presence`（自我存在感）、`preferred_opening`（偏好开头：scene / contradiction / data / confession / problem）、`ending_style`（结尾方式）。带注释的完整 YAML 模板见 [config/extend-schema.md](config/extend-schema.md) 的 `custom_style` 字段。

字段规则：

- `words_to_avoid` 与 EXTEND.md 全局 `avoid_words` 取并集生效
- `compliance_guardrails` 是可选的独立内容边界，不是声音参数；可放在 `custom_style` 中作为回退，优先放在账号级。仅使用 resolver 已解析的顶层清单，执行规则见 `references/media/overview.md`「合规红线」，不要重复写进风格描述
- `preferred_opening` 是偏好而非强制——内容需要时可选其他开头方式
- Never 在风格定义里混入平台约束（段落字数、emoji 策略）或媒介约束（叙事结构、开篇钩子）——那属于 [platforms/](platforms/)

### 从用户样本提取风格

当用户提供写作样本（"像我写的"、"保持我的风格"）时，读取样本并沿以下维度观察，填入上述字段结构（内部使用，除非用户要求否则不暴露）：

句子长度、段落开篇方式、措辞（口语/文学/技术/讽刺/平实）、标点习惯、立场、第一人称频率、过渡风格（显性连接词还是跳切）、结尾习惯。

提取完成后，只有在 detail 流程里才主动提示："要我把提取的风格保存到 EXTEND.md 的 `custom_style` 中？保存后下次自动使用。" 用户拒绝或没回应就不保存，同一会话不再问。simple 流程不主动提议，用户自己要求保存时照做（见 SKILL.md「交稿」最后一段）。

匹配时的取舍：节奏优先于词汇；保留写作者日常用词，不要"升级"它们；保留无伤大雅的癖好——小瑕疵可能就是声音本身；除非用户要求，不照抄样本原句，不编造个人经历或传记细节。

红线（不过度拟合）：样本有错别字→保留随意感不保留错误；样本愤怒→保留力度不保留辱骂；样本诗意→只在新主题撑得住的地方保留意象；样本正式→不强行注入俚语来显得"有人味"。

### 风格与平台/媒介冲突解决

| 冲突类型 | 解决方式 |
|---------|---------|
| 写作风格要求长段落，平台/媒介要求短段落 | 平台/媒介优先——容器与载体限制 |
| 写作风格要求正式，平台建议口语化 | 写作风格优先——声音身份 |
| 风格预设的 `preferred_opening` 与内容需要矛盾 | 内容需要优先——偏好非强制 |
