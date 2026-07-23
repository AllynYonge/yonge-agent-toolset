# 跨 Skill 集成测试

当 skill A 的行为依赖 skill B 的输出（如 skill A 调用 skill B 完成子任务），单独测试 A 或 B 无法发现接口不匹配的问题。集成测试验证 skill 间的端到端协作。

## 何时需要集成测试

- `related_skills` 中的 skill 不仅是"被复制"，而是在运行中被实际调用
- skill 的某个步骤显式依赖另一个 skill 的输出格式或副作用
- 两个 skill 共享状态（如同一文件、同一会话上下文）

不得对所有含 `related_skills` 的 spec 都写集成测试——仅当存在运行时调用依赖时才需要。

## 集成 Spec 结构

在标准 spec 基础上新增 `integration` 字段：

```json
{
  "skill": "skill-a",
  "related_skills": ["skill-b"],
  "integration": {
    "chain": ["skill-b", "skill-a"],
    "interface_contract": {
      "skill-b.output": "包含结构化的图片生成结果（URL 或本地路径）",
      "skill-a.expects": "从 skill-b 输出中提取图片路径用于后续发布"
    },
    "failure_injection": [
      {"skill": "skill-b", "mode": "timeout", "expect": "skill-a 降级处理而非崩溃"},
      {"skill": "skill-b", "mode": "malformed_output", "expect": "skill-a 识别并报告错误"}
    ]
  },
  "cases": [...]
}
```

| 字段 | 含义 |
|------|------|
| `chain` | 调用链顺序，框架按此顺序验证 skill 间数据流 |
| `interface_contract` | 上下游 skill 的输入输出契约（语义描述，用于生成语义断言） |
| `failure_injection` | 故障注入场景：模拟下游 skill 超时/异常输出时上游的处理能力 |

## 集成测试断言策略

- 契约验证用语义断言：「skill-a 的输出中正确引用了 skill-b 产出的资源」
- 故障注入用确定性断言：`exit_code` + `not_contains`（确保无崩溃、无伪造结果）
- 必须同时保留各 skill 的独立 spec——集成测试是补充而非替代
