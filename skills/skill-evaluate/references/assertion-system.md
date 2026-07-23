# 断言系统

## 分层策略

遵循混合断言管线原则——确定性检查优先，语义评审补充，质量评分用于比较版本变化：

| 层级 | 断言类型 | 适用场景 | 稳定性 | 成本 |
|------|----------|----------|--------|------|
| 确定性断言 | `exit_code`, `contains`, `regex` | 格式合规、硬约束验证 | 高 | 零 |
| 语义断言 | `semantic`, `not_semantic` | 结果质量、流程合理性、风格判断 | 中 | 1 次 LLM 调用/断言 |
| 质量评分 | `quality.dimensions` | 多维度综合质量、基线对比 | 中低 | N 次 LLM 调用 |

组合规则：
- 关键检查点（不可逆操作确认、必须调用的工具）→ 必须使用确定性断言或工具事件断言
- 结果质量（完整度、风格、准确性）→ 语义断言 + 可选质量评分
- 不得只使用语义断言验证关键检查点；关键检查点应同时配合确定性断言
- 这三类断言是互补关系，不等同于迭代流程中的 L1/L2/L3 层级

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

`target` 可选值：`stdout`、`stderr`、`transcript`、`final_text`、`agent_messages`、`last_agent_message`、`all`。

- `final_text` / `agent_messages`：后端抽取后的用户可见正文（Codex 为全部 `agent_message` 拼接）
- `last_agent_message`：最后一条非空 agent 消息
- `stdout`：原始 CLI 输出（Codex 为 JSONL 事件流，适合查工具/事件，不适合做正文质量断言）
- `all`：拼接常见原始字段（不含 derived final_text 重复）

## 匹配语义

**文本断言**（`contains`、`not_contains`、`regex`、`not_regex`）在目标文本上匹配：
- `contains` / `not_contains`：纯子串查找
- `regex` / `not_regex`：`re.search(pattern, text, re.DOTALL)`；单个正则可以表达局部顺序

**工具事件断言**（`tool_called`、`tool_not_called`）根据会话中解析出的工具名判断，属于启发式的轨迹检查，不是普通文本匹配。

**语义断言**（`semantic`、`not_semantic`）额外调用 `judge_backend` 作为评审器；未指定时使用被测后端。评审器返回 `{"passed": true|false, "reason": "..."}`。它适合判断流程质量、风格质量等文本匹配难以覆盖的问题，但会增加一次 LLM 调用，结果也可能轻微不稳定。

示例：

```json
{
  "type": "semantic",
  "target": "stdout",
  "rubric": "输出表明 agent 理解了用户要发布的平台和素材类型；当关键信息不足以产出高质量结果时，agent 应以最低成本方式补全信息，而非直接生成低质量的最终发布文案。"
}
```

## 语义评审器校准

- rubric 必须使用具体可判断的标准，不得使用模糊词（"大概"、"可能"、"差不多"、"质量好"）
  - 好：「输出包含对目标平台的明确识别，且未虚构用户未提供的事实信息」
  - 差：「输出质量好」「回答合理」
- 新语义断言上线前，用 `stability.py --runs 5` 验证并达到 `stable_pass`（pass_rate ≥ 0.9）
- judge_model 应选择 ≥ 被测 agent 同等能力的模型
- 复杂标准拆分为多个独立断言，而非一个超长 rubric
- 每个 rubric 聚焦单一可判断维度——评审器同时评估多个维度时准确率下降

## 轨迹级评估

`transcript` target 包含可捕获的会话轨迹，通常包括工具调用和输出；若后端提供，也可能包含 reasoning。可用于：

| 评估目标 | 断言方式 |
|----------|----------|
| 工具调用顺序/参数正确性 | regex 匹配 transcript 中的工具调用模式 |
| 特定轮次的中间推理 | regex 锚定 `---TURN N` 标记 |
| 排除虚构工具结果 | not_regex 检查 transcript 中无伪造内容 |
| 排除信息泄露 | not_contains 检查 transcript 中无密钥/内部路径 |

评估可捕获的完整轨迹而非仅最终输出，能发现“结果正确但执行过程存在风险”的问题。

**顺序断言限制**：多个独立断言之间不保证出现顺序；单个正则仍可表达局部顺序。变通方案：
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

不得写四重反斜杠——这通常表示转义层级理解错误。


## 质量评分读取的文本

L2 quality 默认对 `final_text`（抽取后的用户可见正文）评分，而不是 raw `stdout` 事件流。解析失败时维度记 `judge_status=parse_error` 且 **不计为普通低分**；threshold 会以基础设施失败关闭，避免把 harness 问题误判成 skill 质量差。


## 重放调试

改断言后先用 `--replay-report` + `--assertions-only` 在旧轨迹上验证；只有断言本身稳定后，再重新跑真实 agent。Codex 场景下 replay 会重建 `final_text`，因此 raw JSONL 正则不应再作为正文检查的默认写法。
