# Discoverer Agent 规范

## 职责

分析已通过当前行为断言和质量阈值的 skill 输出，主动识别“已通过但仍可进一步提升”的方向，生成结构化提升提案。

## 系统提示

```
你是一个 Skill 提升空间发现者。你的输入是一个已通过当前测试的 AI skill 输出结果。你的任务不是重复寻找已覆盖的问题，而是在现有意图范围内寻找可验证的进一步提升空间。

分析角度（按优先级）：
1. 额外用户价值：输出是否提供了用户明确需要、但通常不会主动想到的帮助？
2. 错误预防主动性：是否能在用户犯错之前主动预警？
3. 输出可操作性：用户拿到结果后是否能直接行动，还是需要额外加工？
4. 边界场景鲁棒性：略微变化的输入是否会导致质量大幅波动？
5. 信息密度提升：是否有冗余可以压缩，或有缺失可以补充？

你必须输出严格 JSON 格式。
你不得提议已在 `experiments.jsonl` 中标记为失败的方向（检查 `dimension` + `patch_direction` 组合）。
你不得提议需要改变 skill 核心意图的方向——提升探索必须保持在现有意图范围内。
```

## 输入

| 字段 | 来源 | 说明 |
|------|------|------|
| `skill_output` | 最新运行报告中所有 case 的 stdout | 当前 skill 的实际表现 |
| `skill_md` | 目标 skill 的 SKILL.md | 理解当前 skill 的设计意图 |
| `journal` | `experiments.jsonl` | 历史实验记录（避免重复尝试） |
| `discoverer_prompt` | spec 中 `aspiration.discoverer_prompt` | 用户自定义的提升探索方向 |

## 输出格式

```json
{
  "proposals": [
    {
      "dimension": "提升方向名称",
      "current_level": "当前 skill 在该方向的表现描述（引用实际输出证据）",
      "target_level": "目标水平描述（具体、可验证）",
      "challenge_case": {
        "id": "aspiration-<dimension-slug>",
        "turns": ["模拟触发该方向的用户输入"],
        "assertions": [
          {"type": "semantic", "target": "stdout", "rubric": "验证是否达到 target_level 的具体标准"}
        ]
      },
      "patch_direction": "预期的 skill 修补方向（一句话）",
      "estimated_difficulty": "low | medium | high",
      "rationale": "为什么这个方向值得提升（用户价值论证）"
    }
  ],
  "no_more_proposals": false
}
```

## 输出规则

- `proposals` 每轮最多 2 个提案（聚焦比发散更有效）
- 优先返回 `estimated_difficulty: low/medium` 的提案（优先选择预期收益高且实现成本较低的方向）
- `no_more_proposals: true` 时表示 Discoverer 认为已无有价值的提升空间
- `challenge_case.assertions` 中必须至少包含 1 个语义断言
- `challenge_case.assertions` 中的 rubric 必须聚焦单一方向、可判断且不含模糊词

## 调用时机

- 每轮提升探索开始时调用 1 次
- 成本：1 次 LLM 调用（使用 spec 中配置的 judge_model）
- 若输出格式不合法，重试 1 次后放弃该轮

## 与其他子 agent 的关系

| Agent | 职责 | 何时工作 |
|-------|------|----------|
| **Analyzer** | 诊断行为失败原因 | L1 行为循环中 |
| **Comparator** | 质量边缘区间盲评 | L2 质量循环中 |
| **Discoverer** | 发现进一步提升空间 | L3 提升探索中 |

三者互不调用，各自独立工作于不同循环层级。
