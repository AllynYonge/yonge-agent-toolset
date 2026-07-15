# 断言系统

## 分层策略

遵循混合断言管线原则——确定性检查优先，语义评审补充，质量评分跟踪趋势：

| 层级 | 断言类型 | 适用场景 | 稳定性 | 成本 |
|------|----------|----------|--------|------|
| L1 确定性 | exit_code, contains, regex, tool_called | 格式合规、工具调用、硬约束验证 | 高 | 零 |
| L2 语义评审 | semantic, not_semantic | 结果质量、流程合理性、风格判断 | 中 | 1次 LLM 调用/断言 |
| L3 质量评分 | quality.dimensions | 多维度综合质量、基线对比 | 中低 | N次 LLM 调用 |

组合规则：
- 关键检查点（不可逆操作确认、必须调用的工具）→ MUST 使用 L1
- 结果质量（完整度、风格、准确性）→ L2 + 可选 L3
- Never 仅 L2 语义断言作为唯一关键检查点验证（遵循 critical-rules #4）
- 层级间关系：L1 通过是前提，L2 在 L1 全通过后评估，L3 在 L1+L2 全通过后触发

## 断言类型

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

`target` 可选值：`stdout`、`stderr`、`transcript`、`all`。

## 匹配语义

**文本/结构断言**（`contains`、`not_contains`、`regex`、`not_regex`、`tool_called`、`tool_not_called`）在拼接后的完整输出文本上做无序匹配：
- `contains` / `not_contains`：纯子串查找
- `regex` / `not_regex`：`re.search(pattern, text, re.DOTALL)`

**语义断言**（`semantic`、`not_semantic`）额外调用一次 `hermes chat` 作为评审器，评审器返回 `{"passed": true|false, "reason": "..."}`。适合判断流程质量、风格质量等文本匹配难以覆盖的问题。代价：额外一次 LLM 调用，结果可能轻微不稳定。关键检查点应同时配合文本/正则断言。

示例：

```json
{
  "type": "semantic",
  "target": "stdout",
  "rubric": "输出表明 agent 理解了用户要发布的平台和素材类型；当关键信息不足以产出高质量结果时，agent 应以最低成本方式补全信息，而非直接生成低质量的最终发布文案。"
}
```

## 语义评审器校准

- rubric MUST 使用具体可判断的标准，Never 使用模糊词（"大概""可能""差不多""质量好"）
  - 好：「输出包含对目标平台的明确识别，且未虚构用户未提供的事实信息」
  - 差：「输出质量好」「回答合理」
- 新语义断言上线前，用 `stability.py --runs 5` 验证 pass_rate ≥ 0.8
- judge_model 应选择 ≥ 被测 agent 同等能力的模型
- 复杂标准拆分为多个独立断言，而非一个超长 rubric
- 每个 rubric 聚焦单一可判断维度——评审器同时评估多个维度时准确率下降

## 轨迹级评估

`transcript` target 包含完整会话轨迹（reasoning + tool calls + outputs），可用于：

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

## 正则书写规则

JSON 中的正则只需一层转义（JSON 解析 `\\` → `\`，Python `re` 再解释）：

| 想匹配的内容 | JSON pattern 值 |
|---|---|
| 字面 `*` | `"\\*"` |
| markdown `**粗体**` | `"\\*\\*.*?\\*\\*"` |
| 可选加粗的标题 | `"\\*{0,2}我的理解[:：]\\*{0,2}"` |
| 任意空白 | `"\\s+"` |

Never 写四重反斜杠——几乎总是转义层级理解错误。
