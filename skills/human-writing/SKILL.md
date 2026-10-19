---
name: human-writing
description: 通用中文创作与改稿 Skill。用于知乎回答、论坛长帖、公众号文章，也用于起标题、搭文章框架，也用于润色、去 AI 味、查 AI 痕迹和按平台改写。覆盖公众号和小红书发布，包括种草笔记、想选题、发布前合规审核和多账号风格配置。也用于分析拆解一篇文章，包括提取核心观点、生成阅读笔记、深度解读、从文章里找创作灵感和选题方向；用户只说“帮我看看这篇文章”“这篇文章讲了什么”也应使用。默认写成一个见过事、查过材料、愿意把来龙去脉讲清楚的人在说话，保留中文互联网长回答与长帖的活人感和自然韵律，避免机构腔、演说腔、营销腔和模型腔。
---
# 活人感写作

默认把文章写成一篇值得读完的中文长帖。读者应当感觉对面有一个具体的人。这个人知道一些事，也有不知道的地方。他愿意讲细节，敢下判断，偶尔岔开一句，随后还能把话接回来。

不要把“活人感”理解成口头禅、粗口、错别字和网络梗。它首先来自材料，其次来自说话位置，最后才是语气。

只服务当前作品。不建立长期作者画像，不生成个人规则库，不创建新的个人写作 Skill。唯一的例外是用户同意后保存偏好，见「交稿」。

## 按任务走

### 先判定任务

- 新写或改稿，走下文「七步流程」。改稿包括润色、去 AI 味和按平台改写。
- 想选题，或者只给了宽泛话题、没有明确的切入角度，先按「七步流程」第 1 步读配置，再按第 3 步的选题分支派 `agents/topic-selector.md`。
- 分析、拆解一篇文章，或者想从文章里找创作方向，读取 `references/tasks/analyze.md`。
- 审核合规或质量，读取 `agents/reviewer.md`「审核模式入口」。
- 只查 AI 痕迹，读取 `agents/reviewer.md`「审核模式入口」，只启用去 AI 味维度，不修改原稿。
- 用户只说“帮我看看”“这篇改改”时，按材料是谁的来判断。给的是别人的文章或链接，进入分析模式。给的是用户自己的稿子，或者看不出是谁的，问一句是想直接改，还是先看哪里有问题。

## 代理分工与交互原则

派子代理前先读取对应的 `agents/*.md`，按其中的调度规则派发。没有账号配置时，派选题子代理的 `[PROFILE_CONTEXT]` 填“（空）”。没有目标平台时，派复审子代理的 `[PLATFORM]` 填当前文稿类型，比如知乎回答或短篇小说。合规清单为空时传 `[]`。

创作正文由主代理一个人完成，子代理只负责选题（含选题调研）和最终复审。需要向用户提问时，使用运行时自带的提问工具，没有就输出编号列表。同一轮要问的事尽量合并，一次最多问三个。向用户要个人材料时，固定问这三个：你和这件事实际发生过什么关系；哪个瞬间、数字、动作或原话最让你在意；你现在最想说的判断是什么。

## 新写与改稿

### 七步流程

新写和改稿走同一条流程，第 2、3、5 步分新写和改稿两支。标着「有配置时」的内容，在没有账号配置、目标平台和风格时全部跳过。

1. **读配置。** 工作目录下的 `.yonge/.yonge-skills/human-writing/EXTEND.md` 或用户目录下的 `~/.yonge/.yonge-skills/human-writing/EXTEND.md` 存在时，或者带了 `--profile` 参数时，运行下面的命令，只使用它返回的结果，不直接读取 EXTEND.md。否则跳过，合规清单按 `[]` 处理。账号、合规红线、`length` 和 `deep` 的用法见 `references/publish/overview.md`。
   ```bash
     bun scripts/resolve_preferences.ts \
       --workspace-dir "{workspace_dir}" \
       [--profile "<name>"]
   ```
2. **明确需求。** 厘清用户的初始需求与任务底线，不围绕没有依据的猜想规划内容。
   - 新写：明确文稿类型、目标读者、主题意图与发布目标，梳理用户本次提供的信息。关键信息缺失时向用户提问，问清后再进入后续环节。
   - 改稿：读取 `references/tasks/rewrite.md`。根据改写深度档位锁定原稿的核心事实、数据与立场不予篡改，同时保留原稿中生动的真实细节与语气。若用户要求借题另写，按新写流程处理。
   - 有合规配置时：将配置的合规红线（`compliance_guardrails`）与用户明确的禁忌要求合并为避坑清单，在梳理需求时先行核对；若用户要求与红线冲突，先向用户确认，不得违规硬写。
3. **定论点。**
   - 新写：用户未给明确切入角度时，加载 `agents/topic-selector.md` 委派子代理出 3 个方案，把结果原样呈现给用户，等用户选定。通用选题方法论与推演范式见 `references/craft/topic.md`。选定前不输出大纲，也不起草正文。用户已明确指定切入角度时直接使用。
   - 改稿：阅读原文，然后再委派子代理出 3 个选题方案。
   - 从分析模式带来的「选题交接信息」在这里进入，视为用户已明确指定的切入角度，直接使用，不派选题子代理。
4. **定调。**
   - 确定内容形式，然后按下文「不同形式怎样写」对照表“读取”相关参考文件；
   - 发布形态：按 `references/publish/overview.md`「平台与媒介检测」分别确定平台与媒介，合成后读取 `references/publish/platforms/{platform}-{medium}.md`。只读到近似形态时向用户说明。平台与媒介都判断不出时不套用平台形态。
5. **动笔。** 起草初稿或执行改写。
   - 新写/改稿必须遵循 `references/modes/prose.md` 的正向创作规范。改稿按 `references/tasks/rewrite.md` 对应的 `--deep` 档位改写。
   - 指定平台时，把平台文件的「起草侧重」叠加在通用写法上。形态侧重优先于通用倾向，但不越过材料边界和 `length` 上限。
   - 有合规清单时，动笔前逐条核对标题、论点、叙事路径、案例和行动建议。有冲突先处理，不把违规主张写进正文。
   - 预估成稿超过 `long_threshold`（默认 3000 字）时分节写。先把叙事路径展开成分节大纲，每节写一句意图和计划用的材料，与用户确认后分节起草。每完成一节，按 `references/tasks/rewrite.md`「长稿逐节处理」检查衔接。
6. **综合审核。** 所有新写和改稿都执行这一步,包括少于 500 字的短改稿。呈现初稿，附 2 到 4 条优化建议供用户确认。用户确认(或提出修改意见、采纳建议)后,派 `agents/reviewer.md` 执行综合审核(脚本检查 + 按启用维度审核),主代理根据报告修改,最多 3 轮。传递给子代理的上下文包括:完整文章、第 2 步记录的不能改的东西、第 4 步的风格约束和平台要求、完整合规清单、resolver 返回的 `constraint_check_args`。调度与修改闭环见 `agents/reviewer.md`。
7. **交稿。** 按下文「交稿」执行。

### 不同形式怎样写

这个目录只处理形式差异，一种形式一个文件，规则和示范放在一起。起草时只读当前形式对应的一个文件，按下表找。“形式”指这次要写的东西属于哪一类，可以指语体或内容类型。用户指定的形式覆盖默认写法，说话者、材料、推进和事实边界仍由主流程决定。实验写作不强行套用现代散文的完整主干与段落形状。

下表把两类文件放在一起查。`references/modes/` 管用哪种语体写，以现代散文 `prose.md` 为统一默认语体。`references/genres/` 管写的是哪类内容。发布形态（平台×媒介）不占表里的行，按 `references/publish/overview.md`「平台与媒介检测」单独确定，再从 `references/publish/platforms/{platform}-{medium}.md` 读取该形态文件；每个形态文件自己在开头写明它这一形态额外要读哪些文件。

「示范」一节的片段均为虚构，「原课程实战范例」一节是 Vicky《公众号变现 25 讲》里发表过的文章开头。两者都只示范写法，不能把其中的人物、数字和经历拿去冒充事实。

「必读」列的文件每次起草都要读。形式对应的文件（`references/modes/` 和 `references/genres/` 下的文件）确定用哪种语体写、写哪类内容；`prose.md` 是现代散文与各类文稿的默认语体写法。「按需」列的文件在篇幅较长、需要先搭架子，或者用户要求时才读，它们是通用写法：`references/craft/hooks.md`（开头、结尾与金句）、`references/craft/structure.md`（框架与结构范式）和 `references/craft/material.md`（素材）。发布形态文件不在本表里，按上一段单独确定后叠加读取。标题不在起草时读，成稿以后按 `references/craft/title.md` 取，所有现实类文章都适用。

| 形式 | 必读 | 按需 |
| --- | --- | --- |
| 博客长文 | `prose.md`、`hooks.md`、`structure.md`、`material.md` | — |
| 人物稿、历史稿 | `references/genres/profile-history.md`、`prose.md`、`hooks.md`、`structure.md`、`material.md` | — |
| 新闻、产品、行业解读 | `references/genres/news-product.md`、`prose.md` | `hooks.md`、`structure.md`、`material.md` |
| 观点、评论、认知观点文 | `references/genres/opinion.md`、`prose.md`、`hooks.md`、`structure.md`、`material.md` | — |
| 读书观点文、书评 | `references/genres/book-opinion.md`、`prose.md`、`hooks.md`、`structure.md`、`material.md` | — |
| 个人叙事、散文、个人成长文 | `references/genres/personal-narrative.md`、`prose.md`、`hooks.md` | `structure.md`、`material.md`（个人成长文必读） |
| 清单体、金句体 | `references/genres/listicle.md`、`prose.md`、`hooks.md`、`structure.md`、`material.md` | — |
| 其他短文、社交内容 | `prose.md` | `hooks.md`、`structure.md`、`material.md` |
| 教程、方法、实操干货文 | `references/genres/tutorial.md`、`prose.md`、`hooks.md`、`structure.md`、`material.md` | — |
| 评测、商业稿 | `references/genres/review-commercial.md`、`prose.md`、`hooks.md`、`structure.md`、`material.md` | — |
| 口播、播客、演讲稿 | `references/genres/spoken-script.md`、`prose.md` | `hooks.md`、`structure.md`、`material.md` |
| 小说、故事等虚构叙事 | `references/genres/fiction.md`、`prose.md` | — |

表里找不到的语体或内容类型，选最接近的一个文件，判断不出就只按 `references/modes/prose.md` 写。发布形态只影响读到哪个 `platforms/` 文件，不影响本表的选择。平台与媒介都判断不出时不套用平台形态，只按本表和 `prose.md` 写。

写作前先按本表确定语体和内容类型，再按 `references/publish/overview.md`「平台与媒介检测」确定发布形态，两者读到的文件合在一起。发布形态的读取集合写在各自的形态文件里，另加在语体和内容类型之上。

## 交稿

交付复审完成后的最终成品。现实类文章按 `references/craft/title.md` 从成稿里取 3 个候选标题一并呈现（用户已指定标题时只给建议不替换）。不要展示内部提纲、规则检查和创作过程。

交稿时附带第 6 步综合审核产出的修订摘要，并在末尾用一行话提出自然的下一步建议，不自动执行。配置了 `output_dir` 时，按 `references/publish/output.md` 保存文件。

来源的处理只有一条规则。全靠公开材料写成的现实稿，在文末列出对结论重要的来源；个人经历和观点稿不附。用户另有要求时听用户的。不把检索笔记塞进正文。来源区放在结尾叮嘱之后，用一条分隔线隔开，标题固定写“参考来源”。

