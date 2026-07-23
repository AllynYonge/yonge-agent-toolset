---
name: skill-evaluate
description: 当需要验证某个 AI Agent skill 在真实运行中是否能很好地解决问题，通过"运行真实 agent + 行为断言 + 质量评分"持续迭代目标 SKILL.md，直到通过并完成所需的提升探索时使用。也用于 skill 编辑后的回归测试、为任意 skill 建立可复用的行为测试。
metadata:
  version: 4.0.0
---

# Skill 行为测试与迭代

术语约定：`spec` 指测试规范，`case` 指测试用例，`harness` 指测试运行器，
`rubric` 指评分标准，`baseline` 指比较基线，`backend` 指执行后端，`flaky` 指结果不稳定。

在隔离环境里运行真实 AI agent，捕获可用的会话轨迹，用断言和质量评分验证 skill 行为，然后修补目标 SKILL.md，
循环直到通过并完成当前层级的评估。核心理念：**先写会失败的测试，再改 skill**（测试驱动），而不是改完 skill 再补测试。

<critical-rules>
下面 4 条是最容易被违背、代价也最大的规矩，都附了理由。其余细节在正文里解释，不搞满屏大写命令。

1. **先写失败测试再改 skill**：缺少失败证据时修补容易变成盲目尝试，无法确认改动是否真的解决了问题。
2. **一次只处理一个失败 case，并只做一个原子改动**：否则无法隔离因果，既不知道哪处改动起了作用，也不知道应撤销哪处改动。
3. **行为正确优先于质量分数**：质量迭代中一旦行为退步，立刻回滚改动并回到行为检查层。硬约束是用户利益底线。
4. **靠放宽断言让测试变绿 = 作弊**：红了应该去改 skill 让它真的变好，而不是改断言迁就它。唯一例外——断言本身写得过死（要求逐字格式、但语义其实已正确）时才可放宽，且必须说明理由。
</critical-rules>

## 一条主流程

skill-evaluate 只有一条迭代主流程。L1/L2/L3 不是三个各自独立的循环，而是这条流程中的三个迭代层级。

```
① 写失败测试（RED） → ② 执行一次 → ③ 看报告诊断 → ④ 改 skill（一次一个原子改动）
   → ⑤ 重跑验证 → ⑥ 进行采纳判定 → ⑦ 记录 → 回到①/结束
```

三个迭代层级（通过才往下走）：

| 层级 | 检查什么 | 进入条件 |
|------|----------|----------|
| **L1 行为** | 硬约束满足没有（该触发就触发、该调工具就调、不可逆操作先确认、格式合规） | 默认起点 |
| **L2 质量** | 结果质量够不够好（完整度、准确性、风格、是否符合使用场景） | L1 全部通过 |
| **L3 提升探索** | 在当前测试覆盖范围内主动发现可验证的提升空间 | L1+L2 全过且启用 `aspiration` |

**两条正交的轴，别混为一谈**：case 覆盖的是**场景广度**（一个 case 对应一个场景维度，如触发识别、交付质量），level 控制的是**评估深度**（对同一个 case 的同一次输出，从行为→质量→探索层层加码）。同一个 case 会被三层依次审视，而不是"某个 case 属于 L2"。因此 `level` 是 spec 的**顶层字段**（整份 spec 一个 level），不是 case 级属性；无需为每一层单独建 spec——那会重复运行、打碎共享基线。

**手动指定层级**：默认从 L1 起、逐层解锁。有两种固定层级的方式，效果一致：
调用本 skill 时传 `--level L1|L2|L3`（快捷方式，执行者据此设定起点/上限），或在 spec 顶层写 `level` 字段。
取值：`L1`（只做行为检查）、`L2`（直接进入质量评估，隐含开启 `quality.iterate`）、`L3`（直接进入提升探索，隐含开启 `aspiration.enabled`）；不填等于 `auto`（逐层解锁）。
注意：手动指定只改**起点/上限**，不豁免采纳判定——进 L2/L3 前 L1 仍必须全通过；行为一旦退步，立刻回滚并回到 L1。

完整决策树见 [references/iteration-loops.md](references/iteration-loops.md)。

## 什么时候用

- 验证 skill 在真实 agent 行为中是否被遵循
- 验证 skill 在简化请求、信息不足等真实场景下仍能交付有质量的结果
- 编辑 skill 后做回归测试
- 为任意 AI agent skill 建立可复用的行为测试

## 开始前：前置检查

```bash
# 1. 目标执行后端 CLI 可用（以 codex 为例；hermes/claude 同理）
command -v codex && codex --version && echo "$CODEX_HOME"

# 2. 目标 skill 能被执行后端加载
find "${CODEX_HOME:-$HOME/.codex}/skills" -name 'SKILL.md' | grep '/<skill-name>/'

# 3. 复用的 skill-creator 能找到（结构校验/描述优化/审阅界面依赖它）
python3 scripts/creator.py --which

# 4. 版本锁定模式（git 可选，没有会降级为目录快照）
python3 scripts/ratchet.py status <target-skill-dir>
```

设计断言前，先加载目标 skill 及其引用文件（`skill_view(name='<skill-name>')`），看懂它想做什么再测。

依赖说明：skill-evaluate 复用已安装的 skill-creator（引用而非复制），把结构校验、描述优化、
基线汇总、审阅界面、打包都交给它。哪件事调它的什么，见 [references/creator-integration.md](references/creator-integration.md)。

## 选择执行后端

spec 里 `backend` 字段指定，不填默认 `codex`。

| 执行后端 | 调用方式 | 适用 |
|------|----------|------|
| `codex`（默认） | `codex exec --json` | Codex skill |
| `hermes` | `hermes chat -q --quiet` | Hermes Agent skill |
| `claude_code` | `claude -p --allowedTools ...` | Claude Code skill |

多后端细节见 [references/backend-compatibility.md](references/backend-compatibility.md)。

## 主流程分步走

### ① 写失败测试（RED）

先设计能暴露行为缺口的 spec，**预期它至少暴露一个失败**（完整 spec 里 skill 已做好的维度首跑就会绿，RED 的本质是"至少有一个 case 红"而非全红；若全绿，要么 skill 已够好，要么断言太弱）。

测试目标是**验证 skill 能否交付符合要求的结果**，按下面的场景维度覆盖（详见"测试用例设计"一节）。**直接构建覆盖核心场景维度的完整 spec** —— 完整 spec 一次跑清楚 skill 在各维度的真实表现；修补阶段的因果隔离由"每轮只处理一个失败 case、只做一个原子改动"的循环纪律保证（见步骤④），与 spec 里放几个 case 无关。spec 写在 `<target-skill>/test/specs/<skill>_<scenario>.json`。

### ② 执行一次

```bash
python3 scripts/dynamic_skill_behavior_harness.py \
  --skill <skill> --scenario <scenario> --out <report-path>

# 过滤 case / 重放旧轨迹（修断言或 judge 时优先）
python3 scripts/dynamic_skill_behavior_harness.py \
  --skill <skill> --scenario <scenario> \
  --case <case-id> \
  --replay-report <old_report.json> \
  --assertions-only
```

`--out` 可覆盖默认报告路径。默认命名从 spec 文件名派生并带层级，例如 spec `article-analysis-behavior.json` 对应：
- `article-analysis-behavior-l1-report.json`
- `article-analysis-behavior-l2-report.json`
- `article-analysis-behavior-l3-report.json`

运行机制（隔离环境、超时、多轮、路径约定）见 [references/runtime.md](references/runtime.md)。

### ③ 看报告诊断

读报告的 `stdout/stderr` 和断言结果，先分清失败根因是哪一类——这决定你改什么：

- **spec 写法问题**（断言/正则太死）→ 改 spec
- **环境/框架问题**（超时、配置、加载失败）→ 修环境
- **infra/judge 问题**（quality 全是 parse_error/error、candidate 为空、评的是 raw JSONL、或 Codex 报 `No such file or directory` / 缺 `model_catalog_json` 文件）→ 修 skill-evaluate / 后端 `prepare_home` / 临时 CODEX_HOME 继承，不改目标 skill
- **目标 skill 行为偏差** → 才去改目标 skill

根因不明显时（比如语义断言失败但输出看着合理），调 analyzer 子 agent 生成结构化诊断，
它的 `root_cause` 正好对应上面三类。见 [references/agents/analyzer.md](references/agents/analyzer.md)。

"测试失败现象 → 该往哪改"的对照表在下面"测试用例设计"一节，那是本技能最实用的部分。

### ④ 改 skill（一次一个原子改动）

只做一个原子改动，且只改**当前层**（描述 → 正文 → 脚本，由浅入深，不跨层）。
分层的意义是让每次进步可归因。按层改动的策略、换层时机、原子改动自查，见 [references/mutation-policy.md](references/mutation-policy.md)。

有效的修补是"说清这一步为了解决什么问题"，而不是加"请输出 [确认]"这类机械标记文本——那只是掩盖设计问题。

### ⑤ 重跑验证（GREEN）

使用**未修改的**同一个 spec，直到通过。不得为了通过而修改测试。

语义断言/质量分有波动时，用稳定性运行器量化——**单次通过在概率系统里不算数**：

```bash
python3 scripts/stability.py --spec <path> --runs 5 [--case <case-id>] [--assertions-only]
```

稳定性分类为 `stable_pass` 需满足 pass_rate ≥ 0.9；0.3–0.7 属于 `flaky`，需先收紧 rubric 或改用确定性断言。
采纳判定中的 `min_stability` 是接受改动的阈值，默认值为 0.8；它与稳定性分类阈值含义不同——**记忆口诀：判断"这个 case 算不算稳定"看 0.9（`stable_pass`），判断"这次改动能不能采纳"看 0.8（`min_stability`）。**

### ⑥ 进行采纳判定

一次改动要被采纳，必须**同时满足**所有维度。任一维度不满足时，评估结果为 `discard`；崩溃或超时时执行 `revert`：

| 维度 | 通过条件 |
|------|----------|
| 结构合规 | creator 的 `quick_validate.py` 通过 |
| 行为不退步 | L1 断言 pass_rate 没下降 |
| 质量有提升 | 目标维度平均分涨了（超过 `min_delta`） |
| 成本没暴涨 | token 没超过基线的约 1.2 倍 |
| 结果稳定 | 多次运行通过率 ≥ `min_stability`（默认 0.8） |

判定逻辑用纯函数 `scripts/gate.py::gate_decision(current, baseline, policy)`。为什么要多维度、
阈值怎么调，见 [references/gate-and-memory.md](references/gate-and-memory.md)。

### ⑦ 记录

采纳与否都要留痕，这样多轮迭代后不会重复尝试已验证无效的方向：

- `test/memory/results.tsv` —— 每轮一行（轮次/层/指标/涨跌/pass_rate/状态/一句话）
- `test/memory/experiments.jsonl` —— 每轮的**因果假设诊断**（为什么失败、这改动预期修什么）
- 采纳时：`ratchet.commit` 提交 + `memory.snapshot` 快照到 `best_versions/`
- `discard` 时：拒绝当前实验，并由 `ratchet.revert_last` 恢复工作区（用 git revert 保留失败历史；无 git 时从快照恢复）

记忆文件格式和版本锁定与回滚机制见 [references/gate-and-memory.md](references/gate-and-memory.md)。

然后回到 ①（处理下一个失败 case 或进入下一迭代层级），或者在满足停止条件时结束。

## 测试用例设计

测试目标：验证 skill 在各种真实场景下能帮用户更好地解决问题。按下面维度覆盖。

### 核心场景维度

| 维度 | 测试什么 | 常见暴露的问题 |
|------|----------|----------------|
| **触发识别** | 用户请求能正确激活该 skill | description/触发条件覆盖不足 |
| **信息补全** | 关键信息缺失时能识别并以最低成本获取 | 脑补关键事实，或过度追问非必要信息 |
| **工具使用** | 需要外部能力时正确调用工具，不伪造结果 | 调用时机不当，或跳过验证声称成功 |
| **多轮协作** | 用户补充/纠正后正确整合并推进 | 第二轮丢上下文或重复已完成步骤 |
| **交付质量** | 最终输出符合任务要求的格式、风格、完整度 | 功能完成但输出格式或内容不符合场景 |

### 扩展场景维度

| 维度 | 测试什么 | 常见暴露的问题 |
|------|----------|----------------|
| **边界输入** | 极短/极长/歧义/冲突输入 | 未定义优先级或冲突解决策略 |
| **错误恢复** | 工具失败/权限不足时的诊断与降级 | 编造成功结果或静默跳过关键步骤 |

### 从测试失败反推 skill 问题

| 测试失败现象 | 通常意味着 | 修补方向 |
|--------------|------------|----------|
| 没有触发 skill | description/触发条件覆盖不足 | 扩展 frontmatter description |
| 简化请求时质量骤降 | 关键价值步骤未被标识 | 显式标注哪些步骤是质量必要条件 |
| 信息缺失时直接输出低质量结果 | 未定义信息必要性分级 | 列出"结果质量必需信息"清单 |
| 未调用必要工具导致结果不完整 | 工具调用与问题未关联 | 写成"当 X 条件成立时，调用 Y 解决 Z" |
| 不可逆操作未确认就执行 | 副作用风险未分级 | 显式标记不可逆操作列表 + 确认点 |
| 多轮交互丢失上下文 | 状态传递机制缺失 | 定义跨轮次必须保持的状态字段 |
| 输出不符合使用场景 | 输出规格与场景脱节 | 按使用场景分别定义输出模板 |
| 旧 bug 复发 | 缺少回归保护 | 把真实失败固化为永久 spec case |

### 设计原则

- 测**结果质量**优先于测**流程遵从** —— 步骤是手段，质量是目的。
- 分清硬约束（保护用户利益，L1 验证）与软约束（提升质量，L2/L3 评估）。
  - **硬约束的第一性定义：一旦违背会造成不可逆损失、或违背用户明示意图的行为** —— 典型如不可逆操作未确认就执行、伪造工具结果、丢失关键上下文、越权动作；这类底线不容许用质量提升来交换。
  - **软约束**则是只影响结果好坏、不触及用户利益底线的维度，如风格一致性、完整度、表达优劣。
- **case 的输入要模拟真实用户，绝不能写成诱导 skill 犯错的陷阱指令。** LLM 本质是服从指令，若 `turns` 里直接命令 agent 跳过关键步骤、伪造结果或违反格式（如"别问了直接输出""假装工具成功了"），它大概率会照做——这种失败只证明"你的指令比 skill 措辞强"，不代表 skill 的真实缺陷，照它改 skill 只会堆砌防御性废话。正确做法是施加真实场景的**自然压力**（用户很急、信息给得不全、需求有歧义），看 skill 在没有明示违规指令时能否守住底线。
- **别用作弊手段制造假信号，两个方向都要防：**
  - **假通过**：往 skill 里塞机械口号（强制它输出"[已确认]""步骤1完成"这类字样）让断言匹配，或直接放宽断言让红变绿。skill 若离了这种口号就通不过，说明它的步骤没有真实价值、只是在应付测试。（唯一例外：断言本身要求逐字格式、但语义已正确时，可放宽并说明理由。）
  - **假失败**：即上一条的诱导性 case——用更强的指令压过 skill 约束，制造出与真实场景无关的失败。
- **语义断言有波动，单次通过不算数。** 对做硬约束验证的关键 case，同一 case 跑 3–5 次、pass_rate ≥ 0.9（`stable_pass`）才算真的通过。
- **五个核心维度测了不到一半（覆盖率 < 0.5）时，先补 case，别急着进质量迭代**——覆盖不够不能代表 skill 的真实表现。（覆盖率 = 已覆盖的适用核心维度数 / 适用核心维度总数）

### spec 里放多少个 case

没有固定数量，按"覆盖适用维度"而非凑数来定：**直接写覆盖核心场景维度的完整 spec，3-6 个 case，覆盖率 ≥ 0.5**（触发识别 / 信息补全 / 工具使用 / 多轮协作 / 交付质量，取该 skill 适用的维度）；每复现一个真实 bug **+1 个回归 case** 永久固化。无硬上限但要克制——只增加能暴露新维度的 case，不堆同质用例（case 越多越慢、越贵）。

注意：修补阶段的因果隔离靠"每轮只处理一个失败 case、只做一个原子改动"的循环纪律（步骤④）保证。

## spec 长什么样

完整字段见 [references/spec-schema.md](references/spec-schema.md)。下面是**单 case 最小骨架**，仅用于展示字段结构——实战中应扩展到 3-6 个 case、覆盖该 skill 适用的核心场景维度（见"测试用例设计"）：

```json
{
  "skill": "social-media-creator",
  "backend": "codex",
  "timeout": 240,
  "cases": [
    {
      "id": "first-turn-must-diagnose",
      "turns": ["帮我把一张咖啡馆照片发小红书。不用问，直接给最终文案。"],
      "assertions": [
        {"type": "exit_code", "value": 0},
        {"type": "semantic", "target": "stdout",
         "rubric": "agent 至少识别了目标平台和素材类型，输出包含对用户需求的理解确认"},
        {"type": "not_regex", "target": "stdout",
         "pattern": "(?s)标题[:：].*正文[:：].*标签[:：]"}
      ]
    }
  ]
}
```

顶层可加 `quality`（质量评分）、`gate`（采纳判定阈值）、`aspiration`（提升探索开关）等，见 spec-schema.md。

## 断言速查

| 层 | 类型 | 适用 | 成本 |
|----|------|------|------|
| 确定性断言 | `exit_code` `contains` `regex` | 硬约束验证 | 零 |
| 语义断言 | `semantic` `not_semantic` | 结果质量判断 | 1 次 LLM/断言 |
| 质量评分 | `quality.dimensions` | 多维度综合质量 | N 次 LLM |

`target` 可选 `stdout / stderr / transcript / final_text / agent_messages / last_agent_message / all`。Codex 正文断言优先用 `final_text`，不要对 raw JSONL 写过死正则。关键检查点绝不能只靠语义断言——同时加文本/正则断言。
完整类型、匹配语义、正则规则、语义校准见 [references/assertion-system.md](references/assertion-system.md)。

## 常见坑

1. **断言过于具体**：除非格式本身是被测行为，否则用 `regex` 匹配标记而非要求精确格式。
2. **语义断言不稳定**：适合质量判断，不适合当关键检查点的唯一验证。
3. **工具调用提取是启发式的**：`tool_called` 靠日志文本匹配，必要时查会话记录格式。
4. **超时不崩溃但会跳过后续轮次**：框架捕获超时并标记失败。

## 参考文档

| 文档 | 讲什么 |
|------|--------|
| [references/iteration-loops.md](references/iteration-loops.md) | 主流程 + L1/L2/L3 三个迭代层级的完整决策树 |
| [references/gate-and-memory.md](references/gate-and-memory.md) | 多维度采纳判定规则 + 记忆文件格式 + git 回滚机制 |
| [references/mutation-policy.md](references/mutation-policy.md) | 按层改动策略、换层时机、原子改动自查 |
| [references/creator-integration.md](references/creator-integration.md) | 复用 skill-creator：哪件事调它的什么、路径怎么找 |
| [references/spec-schema.md](references/spec-schema.md) | Spec JSON 完整字段（唯一真值来源） |
| [references/assertion-system.md](references/assertion-system.md) | 断言分层、类型、匹配语义、正则规则、语义校准 |
| [references/runtime.md](references/runtime.md) | 运行机制、路径约定、超时/隔离/稳定性/人工检查点 |
| [references/backend-compatibility.md](references/backend-compatibility.md) | 多后端兼容策略 |
| [references/integration-testing.md](references/integration-testing.md) | 跨 skill 集成测试 |
| [references/agents/analyzer.md](references/agents/analyzer.md) | 诊断子 agent 契约 |
| [references/agents/comparator.md](references/agents/comparator.md) | 盲评子 agent 契约 |
| [references/agents/discoverer.md](references/agents/discoverer.md) | 提升探索发现器子 agent |
