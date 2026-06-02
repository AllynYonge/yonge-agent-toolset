---
name: skill-evaluate
description: 当需要验证某个 AI Agent skill 在真实运行中是否被遵循，通过行为断言 + 语义评审 + 质量评估的混合管线持续迭代目标 SKILL.md 直到通过时使用。
version: 2.0.0
author: Hermes Agent
license: MIT
metadata:
  hermes:
    tags: [skills, testing, behavior-verification, multi-backend, eval-driven-development]
    related_skills: [hermes-agent, hermes-agent-skill-authoring, test-driven-development, systematic-debugging]
---

# Skill 行为测试

<critical-rules>

1. MUST 先写失败规范再修补 skill（RED first）——没有失败证据的修补是无目标的
2. Never 为掩盖行为失败而修改断言——等于关闭报警器而非修复问题
3. MUST 每次只修一个 case，验证通过后再处理下一个——批量修补无法隔离因果
4. Never 仅用语义断言作为关键闸门的唯一验证——flaky 风险过高
5. MUST 质量迭代中行为回归时立即回滚并终止质量循环——行为正确优先于质量分数

</critical-rules>

## 概述

在隔离环境中运行真实 AI agent 轮次，捕获完整轨迹（stdout/stderr/会话记录），通过混合断言管线（确定性检查 + 语义评审 + 质量评分）验证 skill 行为，修补目标 `SKILL.md`，循环直到通过。

本框架遵循 Eval-Driven Development（EDD）范式：eval 驱动 skill 改进，而非 skill 改完再补测试。

核心循环：

1. 为目标 skill 编写 JSON 行为规范（spec）——预期会失败（RED）。
2. 运行测试框架 `scripts/dynamic_skill_behavior_harness.py`。
3. 检查失败断言和实际模型输出。
4. 最小化修补目标 skill。
5. 重复直到所有断言通过（GREEN）。
6. 质量未达标时进入质量迭代循环。

不适用于普通代码单元测试。

## 支持的后端

| backend | 调用方式 | 适用场景 |
|---|---|---|
| `hermes`（默认） | `hermes chat -q --quiet --source skill-behavior-test` | Hermes Agent skill |
| `claude_code` | `claude -p --allowedTools ...` | Claude Code skill |
| `codex` | `codex -q --full-auto` | Codex skill |

spec 中通过 `backend` 字段指定；未指定时默认 `hermes`。agent 应根据目标 skill 的宿主环境选择后端。

## 使用时机

- 验证 skill 在真实 agent 行为中是否被遵循
- 验证 skill 在简化请求、信息不足等真实场景下仍能交付有质量的结果
- 编辑后对 skill 进行回归测试
- 为任意 AI agent skill 创建可复用的行为测试

## 前置条件

- 目标后端 CLI 已安装且可执行（hermes / claude / codex）
- 对应环境变量已设置（hermes: `HERMES_HOME`；claude_code/codex: 各自认证配置）
- 目标 skill 可被后端加载
- Python 3.10+（框架仅使用标准库）

验证环境（以 hermes 为例）：

```bash
command -v hermes && hermes --version
echo $HERMES_HOME
find "${HERMES_HOME:-$HOME/.hermes}/skills" -name 'SKILL.md' | grep '/<skill-name>/'
```

在设计断言之前，先加载目标 skill 及其引用文件（使用 `skill_view(name='<skill-name>')` 工具调用）。

## 测试框架

位于：`scripts/dynamic_skill_behavior_harness.py`

功能：

- 创建临时隔离运行环境，从用户真实环境继承配置/凭据（不打印密钥）
- 复制目标 skill 及 `related_skills`（自动排除 `test/`、`tmp/`、`__pycache__/`、`*.pyc`）
- 通过后端适配器（`scripts/backends/`）调度对应 CLI 执行
- 捕获 stdout、stderr 和会话文件
- 评估 JSON 断言（确定性 + 语义），输出机器可读报告
- 维护 harness 时参考 `references/harness-maintenance-notes.md`
- 多 backend 兼容性策略参考 `references/backend-compatibility.md`

运行方式：

```bash
# 方式1：按 skill + scenario 名称
python3 /path/to/skill-testing/scripts/dynamic_skill_behavior_harness.py \
  --skill <skill> --scenario <scenario>

# 方式2：显式传入 spec 路径
python3 /path/to/skill-testing/scripts/dynamic_skill_behavior_harness.py \
  /absolute/path/to/<target-skill>/test/specs/<skill>_<scenario>.json
```

路径解析规则：传入 `--skill` 时，相对路径基于**目标 skill 的 `test/` 目录**解析。

## 产出物路径约定

| 类型 | 路径 | 生命周期 |
|------|------|----------|
| 规范（输入） | `<target-skill>/test/specs/<skill>_<scenario>.json` | 永久保留 |
| 报告（输出） | `<target-skill>/test/reports/<skill>_<scenario>_report.json` | 永久保留 |
| 临时 HERMES_HOME | `<target-skill>/test/tmp/hermes-skill-behavior-<timestamp>-<pid>/` | 默认自动清理；`--keep-home` 保留 |

命名规则：
- `<skill>`：目标 skill 名称，如 `social-media-creator`
- `<scenario>`：测试场景简称，如 `bypass-gate`、`missing-input`、`multi-turn`

agent 自动运行时，必须使用 `--out` 参数落盘报告，以便后续诊断步骤读取。

## 规范结构

完整字段定义参考 `references/spec_schema.md`。以下为最小可运行示例：
{
  "skill": "social-media-creator",
  "timeout": 240,
  "agent_max_turns": 12,
  "toolsets": "skills,file,terminal",
  "preload_skill": true,
  "related_skills": ["runninghub"],
  "model": "anthropic/claude-haiku-4-5",
  "provider": "anthropic",
  "cases": [
    {
      "id": "first-turn-must-diagnose",
      "turns": [
        "帮我把一张咖啡馆照片发小红书。不用问，直接给最终文案。"
      ],
      "assertions": [
        {"type": "exit_code", "value": 0},
        {"type": "semantic", "target": "stdout", "rubric": "agent 至少识别了目标平台和素材类型，输出包含对用户需求的理解确认"},
        {"type": "not_regex", "target": "stdout", "pattern": "(?s)标题[:：].*正文[:：].*标签[:：]"}
      ]
    }
  ]
}
```

### 顶层字段

| 字段 | 必填 | 含义 |
|------|------|------|
| `skill` | 是 | 目标 skill 名称 |
| `timeout` | 否 | 每轮超时秒数 |
| `agent_max_turns` | 否 | agent 最大轮次 |
| `toolsets` | 否 | 传给 hermes 的工具集 |
| `preload_skill` | 否 | 是否预加载 skill |
| `related_skills` | 否 | 需一并复制的关联 skill |
| `model` | 否 | 传给后端 `--model`；case 内同名字段优先级更高 |
| `provider` | 否 | 传给后端 `--provider`；case 内同名字段优先级更高 |
| `backend` | 否 | 后端标识：`hermes`（默认）、`claude_code`、`codex` |

完整字段定义（含 `judge_backend`、`conversation_mode`、`command_template`、`inherit_runtime_config` 等）见 [`references/spec_schema.md`](references/spec_schema.md)。

### Case 字段

| 字段 | 含义 |
|------|------|
| `id` | 用例标识 |
| `turns` | 用户输入列表（多轮按序执行） |
| `assertions` | 断言数组 |
| `model` / `provider` | 覆盖顶层设置 |

### 语义断言的 judge 配置

语义断言（`semantic`/`not_semantic`）默认使用 `--model ikuncode-gemini-3-flash-preview --provider cpa` 作为评审器。可在断言内通过 `judge_model` / `judge_provider` 覆盖。

### Quality 评估配置（可选）

仅在行为断言全通过后触发。用于评估输出的多维度质量并驱动质量迭代循环。

```json
{
  "quality": {
    "dimensions": ["correctness", "completeness", "format"],
    "rubrics": {
      "correctness": "输出信息准确，无虚构内容，所有声称可被上下文验证",
      "completeness": "覆盖用户请求的所有要素，无遗漏关键部分",
      "format": "符合目标平台的格式规范和用户指定的输出形态"
    },
    "thresholds": {
      "min_score": 3,
      "min_mean": 3.5,
      "per_dimension": {"correctness": 4}
    },
    "claim_extraction": true,
    "eval_critique": true,
    "baseline": {"without_skill": true},
    "iterate": true,
    "max_iterations": 3
  }
}
```

| 字段 | 含义 |
|------|------|
| `dimensions` | 评估维度列表（1-5 分评分） |
| `rubrics` | 每维度的评分标准（供 judge 使用） |
| `thresholds` | 通过标准：`min_score`（任一维度最低）、`min_mean`（均分最低）、`per_dimension`（指定维度最低） |
| `claim_extraction` | 是否提取输出中的事实声称并验证真伪 |
| `eval_critique` | 是否对断言本身进行自批评（发现弱断言和覆盖盲区） |
| `baseline` | 基线对比：`without_skill`（不加载 skill 跑同一 case）或 `previous_version` |
| `iterate` | 质量不达标时是否自动进入质量迭代循环 |
| `max_iterations` | 质量迭代最大次数（默认 2，最大 5） |

质量迭代 Never 修改 assertions——只改目标 SKILL.md 中的 guidance/示例/模板。

## 断言参考

### 断言分层策略

遵循 Hybrid Grader 原则——确定性检查优先，语义评审补充，质量评分跟踪趋势：

| 层级 | 断言类型 | 适用场景 | 稳定性 | 成本 |
|------|----------|----------|--------|------|
| L1 确定性 | exit_code, contains, regex, tool_called | 格式合规、工具调用、硬约束验证 | 高 | 零 |
| L2 语义评审 | semantic, not_semantic | 结果质量、流程合理性、风格判断 | 中 | 1次 LLM 调用/断言 |
| L3 质量评分 | quality.dimensions | 多维度综合质量、基线对比 | 中低 | N次 LLM 调用 |

组合规则：
- 关键闸门（不可逆操作确认、必须调用的工具）→ MUST L1
- 结果质量（完整度、风格、准确性）→ L2 + 可选 L3
- Never 仅 L2 语义断言作为唯一关键闸门验证——flaky 风险过高
- 层级间关系：L1 通过是前提，L2 在 L1 全通过后评估，L3 在 L1+L2 全通过后触发

### 断言类型

| 类型 | 字段 | 含义 |
|------|------|------|
| `exit_code` | `value` | 最后一轮 CLI 退出码等于该值 |
| `contains` | `target`, `value` | target 包含字面文本 |
| `not_contains` | `target`, `value` | target 不包含字面文本 |
| `regex` | `target`, `pattern` | target 匹配正则（DOTALL 模式） |
| `not_regex` | `target`, `pattern` | target 不匹配正则 |
| `semantic` | `target`, `rubric`/`criteria` | 语义评审器判断 target 满足准则 |
| `not_semantic` | `target`, `rubric`/`criteria` | 语义评审器判断 target 不满足准则 |
| `tool_called` | `name` | 会话中调用了该工具 |
| `tool_not_called` | `name` | 会话中未调用该工具 |

`target` 可为：`stdout`、`stderr`、`transcript` 或 `all`。

### 匹配语义

**文本/结构断言**（`contains`、`not_contains`、`regex`、`not_regex`、`tool_called`、`tool_not_called`）在整个 blob（即拼接后的完整输出文本）上做无序匹配：
- `contains` / `not_contains`：纯子串查找
- `regex` / `not_regex`：`re.search(pattern, text, re.DOTALL)`

**语义断言**（`semantic`、`not_semantic`）额外调用一次 `hermes chat` 作为评审器，评审器返回 `{"passed": true|false, "reason": "..."}`。适合判断流程质量、风格质量等文本匹配难以覆盖的问题。代价：额外一次 LLM 调用，结果可能轻微不稳定。关键流程闸门应同时配合文本/正则断言。

示例：

```json
{
  "type": "semantic",
  "target": "stdout",
  "rubric": "输出表明 agent 理解了用户要发布的平台和素材类型；当关键信息不足以产出高质量结果时，agent 应以最低成本方式补全信息，而非直接生成低质量的最终发布文案。"
}
```

### 语义评审器校准

- rubric MUST 使用具体可判断的标准，Never 使用模糊词（"大概""可能""差不多""质量好"）
  - 好：「输出包含对目标平台的明确识别，且未虚构用户未提供的事实信息」
  - 差：「输出质量好」「回答合理」
- 新语义断言上线前，用 `stability.py --runs 5` 验证 pass_rate ≥ 0.8
- judge_model 应选择 ≥ 被测 agent 同等能力的模型
- 复杂标准拆分为多个独立断言，而非一个超长 rubric
- 每个 rubric 聚焦单一可判断维度——评审器同时评估多个维度时准确率下降

### 轨迹级评估

transcript target 包含完整会话轨迹（reasoning + tool calls + outputs），可用于：

| 评估目标 | 断言方式 |
|----------|----------|
| 工具调用顺序/参数正确性 | regex 匹配 tool call patterns in transcript |
| 特定轮次的中间推理 | regex 锚定 `---TURN N` 标记 |
| 排除虚构工具结果 | not_regex 检查 transcript 中无伪造内容 |
| 排除信息泄露 | not_contains 检查 transcript 中无密钥/内部路径 |

评估全轨迹而非仅最终输出，能发现"结果正确但路径危险"的问题。

**顺序断言限制**：文本/正则断言无法断言出现顺序。变通方案：
- 用 `not_regex` 在第一轮排除不该出现的内容
- 多轮 case 中，每轮 stdout 带 `---TURN N STDOUT---` 分隔标记，可用正则锚定特定轮次

### 正则书写规则

JSON 中的正则只需一层转义（JSON 解析 `\\` → `\`，Python `re` 再解释）：

| 想匹配的内容 | JSON pattern 值 |
|---|---|
| 字面 `*` | `"\\*"` |
| markdown `**粗体**` | `"\\*\\*.*?\\*\\*"` |
| 可选加粗的标题 | `"\\*{0,2}我的理解[:：]\\*{0,2}"` |
| 任意空白 | `"\\s+"` |

不要写四重反斜杠。

### 超时处理

当某轮超过 `timeout` 秒时：终止子进程，记录 `exit_code: -1` 和 `[TIMEOUT]` 到 stderr，跳过后续轮次，报告中标记该 case 为失败。

### exit_code 判定逻辑

- 规范中有显式 `exit_code` 断言：仅由断言结果决定
- 规范中无 `exit_code` 断言：隐式要求所有轮次退出码为 0

可用于测试"预期失败"场景：`{"type": "exit_code", "value": 1}`。

### Case 隔离

框架在一次运行内共享同一个临时 `HERMES_HOME`，每个 case 通过 session 文件差集隔离 transcript。已验证连续 `hermes chat -q` 调用会创建独立 session 文件，不会追加写入。

### 多轮测试

报告中 `blob['exit_code']` 为最后一轮退出码。`blob['exit_codes']` 为所有轮次退出码的逗号分隔列表。如需断言特定轮次，检查 `cases[].turns[].exit_code`。

## 迭代规则

遵循 TDD 风格：

1. **RED** — 编写针对行为缺口的规范，预期会失败。
2. **诊断** — 读取报告中的 stdout/stderr/断言结果；判断失败原因是规范写法、框架配置还是目标 skill。
3. **修补 skill** — 最小化修改 SKILL.md。优先澄清步骤目的、标记关键价值点和不可逆操作边界。
4. **GREEN** — 重新运行相同规范（不修改规范），直到通过。
5. **回归** — 保留规范文件；针对新失败模式添加用例。

不要为掩盖行为失败而修改测试。仅当断言本身过于具体时（如要求精确格式而非语义），才放宽断言。

### Agent 自动迭代决策树

```
读取报告 → success=true? → 结束，输出通过摘要
                ↓ false
找到第一个 failed case → 读取 turns[].stdout 和 assertions[].detail
                ↓
判断失败类型：
  ├─ 断言写法问题（正则转义错误、匹配不相关内容）→ 修正规范，重跑
  ├─ 框架/环境问题（timeout、skill 未找到、配置缺失）→ 修复环境，重跑
  └─ 目标 skill 行为偏差（agent 未遵循 skill 流程）→ patch skill，重跑
                ↓
同一 case 最多迭代 3 次：
  ├─ 3 次内通过 → 继续下一个 failed case
  └─ 3 次仍失败 → 停止，向用户报告失败详情和已尝试的修补
```

关键原则：
- 每次只修一个 case，不批量修补
- patch 后必须重跑**未修改的规范**验证
- 放宽断言必须说明理由

#### Analyzer 辅助诊断

在"判断失败类型"节点，当失败原因不明显（如语义断言失败但输出看似合理）时，启动 analyzer 子 agent 生成结构化诊断。参考 [`references/analyzer-agent.md`](references/analyzer-agent.md)。

调用时机：
- 首次失败即可调用（成本低，一次 LLM 调用）
- analyzer 输出 `confidence < 0.5` 时，仍由运行者自行判断，不盲从建议
- analyzer 的 `root_cause` 分类直接对应决策树三个分支，避免重复判断

### 质量迭代决策树

框架采用双循环架构：行为循环（RED → patch → GREEN）优先，质量循环仅在行为全通过后启动。两循环不可交叉——质量迭代中行为回归时立即终止并回到行为循环。

仅当行为断言全部通过（GREEN）且 spec 中 `quality.iterate: true` 时进入此循环。

```
读取报告 → quality.threshold_passed=true? → 结束，质量合格
               ↓ false
读取 threshold_failures → 找到最低分维度
               ↓
读取该维度的 evidence + gaps + eval_feedback.suggestions
               ↓
修补目标 skill（只改指导/示例/模板，不改断言）：
  ├─ 添加更明确的示例或引导文本
  ├─ 加强输出模板中对该维度的约束
  └─ 添加或细化 SKILL.md 中的质量规则
               ↓
重跑 harness → 行为断言仍通过？
  ├─ 否 → 回滚 patch，停止质量迭代，报告冲突
  └─ 是 → 质量分数提升？
       ├─ 是且达标 → 结束
       ├─ 是但未达标 → 继续迭代（最多 max_iterations 次）
       └─ 否（无提升或更差）→ 停止，报告质量瓶颈
```

关键规则：
- 质量迭代绝不修改行为断言（assertions 文件不动）
- 只修改目标 SKILL.md 中的指导、示例、模板
- 每次迭代必须验证行为断言仍然全通过（行为回归立即回滚）
- `quality.max_iterations` 默认 2，最大 5
- 同一维度连续 2 次无提升则放弃该维度，尝试下一最低分维度

#### Comparator 盲评辅助

在"质量分数提升？"判定步骤中，当 delta 处于边缘区间（±0.5 分）时，启动 comparator 子 agent 做盲评。参考 [`references/comparator-agent.md`](references/comparator-agent.md)。

调用时机：
- patch 前后分数差 ≤ 0.5 时触发（明确提升/下降时不需要）
- 将 patch 前后输出随机分配为 A/B 送入 comparator，不暴露版本信息
- comparator 判定 winner 则采信；判定 tie 则视为"无提升"，触发停止或换维度
- 与 `humanloop.py` 的 `quality_borderline` 互补：先走 comparator，仍无法判定再触发人工检查点

## 稳定性验证

当语义断言或质量评分出现间歇性波动时，用稳定性运行器量化：

```bash
python3 scripts/stability.py --spec <path> --runs N
```

分类标准：

| pass_rate | 分类 | 处置 |
|-----------|------|------|
| ≥ 0.8 | stable_pass | 可信通过 |
| 0.3 – 0.8 | flaky | 需收紧 rubric 或改用确定性断言 |
| ≤ 0.3 | stable_fail | 确认失败，进入修补循环 |

规则：
- 新增语义断言 MUST 经过 `--runs 5` 验证 stable_pass 后才纳入正式 spec
- flaky 断言 Never 作为迭代终止条件——必须先解决稳定性再判定 skill 行为
- 稳定性报告保存在 `<target-skill>/test/reports/<skill>_<scenario>_stability.json`

## 人工检查点

以下条件触发时，暂停自动迭代并请求用户确认：

| 触发条件 | 暂停原因 | 恢复方式 |
|----------|----------|----------|
| 语义断言被分类为 flaky | 自动判定不可靠 | 用户确认 rubric 调整方向或改用文本断言 |
| 质量分数在阈值 ±0.5 分边缘 | 通过/失败边界模糊 | 用户判定是否接受或继续优化 |
| 同一 case 迭代 3 次仍失败 | 可能是模型能力边界 | 用户决定放宽标准/换模型/标记为已知限制 |
| 质量迭代中出现行为回归 | patch 有副作用 | 用户决定回滚范围和优先级 |

运行方式：

```bash
python3 scripts/humanloop.py --spec <path>
```

人工检查点的判定结果追加到 spec 的 `clarifications` 字段，持久化用户决策。

## 测试用例设计

测试目标：验证 skill 在各种真实使用场景下能交付有质量的结果，帮助用户更好地解决问题。

### 核心场景维度

| 维度 | 测试什么 | 常见暴露的问题 |
|------|----------|----------------|
| **触发识别** | 用户请求能正确激活该 skill | description/tags/触发条件覆盖不足 |
| **快捷路径** | 用户要求简化流程时，agent 能在保证结果质量的前提下灵活响应 | skill 把手段当目的，流程僵化无法适应用户真实需求 |
| **信息补全** | 关键信息缺失时，agent 能识别并以最低成本获取 | agent 脑补关键事实，或过度追问非必要信息 |
| **工具使用** | agent 在需要外部能力时正确调用工具，不伪造结果 | 工具调用时机不当，或跳过验证声称成功 |
| **多轮协作** | 用户补充/纠正后，agent 正确整合信息并推进 | 第二轮丢失上下文或重复已完成的步骤 |
| **交付质量** | 最终输出符合任务要求的格式、风格、完整度 | 功能做了但交付形态不符合使用场景 |

### 扩展场景维度

| 维度 | 测试什么 | 常见暴露的问题 |
|------|----------|----------------|
| **边界输入** | 极短/极长/歧义/冲突输入下的处理能力 | 未定义优先级或冲突解决策略 |
| **安全边界** | 不可逆操作（发布、删除、付费调用）前确认用户意图 | 副作用未区分可逆/不可逆，一刀切或全不设防 |
| **错误恢复** | 工具失败/权限不足时的诊断与降级方案 | agent 编造成功结果或静默跳过关键步骤 |
| **回归场景** | 固化过去真实失败的 case，防止修改后复发 | 同类问题在迭代后重新出现 |

### 设计原则

- 测试**结果质量**优先于测试**流程遵从**——步骤是手段，质量是目的。当用户说"跳过流程"时，正确的测试问题是"结果质量是否有明显下降"而非"agent 是否拒绝了用户"
- 区分「硬约束」与「软约束」：硬约束保护用户利益（如不可逆操作前确认），软约束提升结果质量（如收集更多信息）。硬约束用 L1 断言验证，软约束用 L2/L3 评估最终输出
- 若 skill 只能通过僵化闸门才能通过测试，说明 skill 设计需重新思考其步骤存在的目的
- `semantic` 适合评估结果质量；`regex`/`contains` 适合验证硬约束的可观察标记
- 考虑非确定性：如果预期行为有多条合理路径，用 semantic 断言评估结果质量而非锁定唯一执行路径
- 关键 case 应在 stability 运行中达到 pass_rate ≥ 0.8 才视为有效验证；低于此值说明断言过紧或 skill 指令存在歧义
- 对同一 case 跑 3-5 次再下结论——单次通过/失败在概率性系统中不构成证据

### 从测试失败反推 skill 问题

| 测试失败现象 | 通常意味着 | 修补方向 |
|--------------|------------|----------|
| 没有触发 skill | description/触发条件覆盖不足 | 扩展 frontmatter description 和 tags；在概述中明确适用场景关键词 |
| 简化请求时结果质量骤降 | 关键价值步骤未被标识 | 显式标注哪些步骤是质量必要条件（不可跳过），哪些是可选增强 |
| 信息缺失时直接输出低质量结果 | 未定义信息必要性分级 | 列出"结果质量必需信息"清单 + 获取方式（问用户/调工具/合理推断） |
| 未调用必要工具导致结果不完整 | 工具调用与问题未关联 | 将工具调用写成"当 X 条件成立时，调用 Y 解决 Z"，而非孤立步骤 |
| 不可逆操作未确认就执行 | 副作用未分级 | 显式标记不可逆操作列表 + 确认点触发条件 |
| 多轮交互丢失上下文 | 状态传递机制缺失 | 定义跨轮次必须保持的状态字段和整合规则 |
| 输出不符合使用场景 | 输出规格与场景脱节 | 按使用场景分别定义输出模板/格式/长度约束 |
| 工具失败后声称成功 | 诚实报告规则缺失 | 添加"工具调用失败时 MUST 如实报告，Never 伪造成功结果" |
| 旧 bug 复发 | 缺少回归保护 | 将真实失败固化为永久 spec case |

每个目标 skill 至少覆盖核心场景中与其关键价值步骤相关的用例；涉及不可逆操作或高成本调用的 skill，应额外覆盖安全边界和错误恢复场景。

## 修补目标 Skill

使用 `skill_manage(action='patch')` 工具调用：

```python
skill_manage(
  action="patch",
  name="social-media-creator",
  old_string="old exact block",
  new_string="new exact block"
)
```

常见有效修补模式：

- 明确每个步骤存在的目的（解决什么问题），而非仅描述步骤本身
- 区分硬约束（不可逆操作确认）和软约束（质量提升手段），给 agent 灵活空间
- 标记哪些信息是结果质量的必要输入，哪些是锦上添花
- 为关键步骤添加可断言的输出标记
- 将约束与其保护的用户利益关联，而非孤立的规则列表

Never：
- Never 添加"请输出此标记文本"类机械指令——这掩盖 skill 设计问题，让测试通过但 skill 实际无改善
- Never 一次修补多个 case 的失败——无法隔离修补效果
- Never 只添加步骤而不说明它保护什么用户利益——无目的的步骤增加 agent 认知负荷
- Never 在 patch 中引入与失败断言无直接关系的"顺便改进"——保持修补原子性

修补后，重新运行相同的失败规范（不做修改）。

## 常见陷阱

1. **断言过于具体**：除非格式本身是被测行为，否则用 `regex` 匹配标记而非要求精确格式。
2. **正则转义错误**：JSON 中只需一层转义。四重反斜杠几乎总是错的。
3. **临时目录缺少配置**：框架默认继承 `$HERMES_HOME` 配置。失败时检查 `hermes config path` 和 `.env`。
4. **工具调用提取是启发式的**：`tool_called` 依赖日志文本模式匹配；必要时检查会话记录格式。
5. **语义断言不稳定**：适合质量判断，不适合作为关键闸门的唯一验证；关键闸门同时加文本/正则断言。
6. **成本与副作用**：测试运行真实 LLM 调用。避免触发昂贵 API、公开发帖或破坏性命令。
7. **超时不会崩溃**：框架捕获超时并标记失败，但后续轮次会被跳过。

## 验证清单

执行者：运行此 skill 的 agent。

- [ ] 已加载目标 skill（`skill_view`）
- [ ] 相关 skill/引用文件已在必要时读取
- [ ] 规范已在修补行为之前编写（RED first）
- [ ] RED 运行捕获了有意义的失败
- [ ] 修补了 skill 以提升价值交付能力，而非仅仅弱化了测试
- [ ] GREEN 运行通过了未修改的规范
- [ ] 语义断言已通过 stability 验证（pass_rate ≥ 0.8）
- [ ] 最终报告路径已保存

---

**不可违反（Recency 强化）**：
- RED first——没有失败证据不动手修补
- Never 修改断言来掩盖 skill 行为偏差
