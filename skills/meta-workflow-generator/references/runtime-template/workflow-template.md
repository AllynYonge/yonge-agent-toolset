# {{workflow_name}} 工作流

## 工作流概览

{{领域名称}}工作流 — {{一句话描述核心任务}}

**核心原则**：
1. {{原则1}}
2. {{原则2}}
3. {{原则3}}

---

## 技能流水线

```
[{{skill1_name}}] → [{{skill2_name}}] → [{{skill3_name}}] → ...
```

**说明**：
- 线性流水线：按顺序执行
- 分支流水线：条件路由到不同分支
- 并行流水线：多个技能同时执行

---

## 质量门配置

| 技能 | 门禁级别 | 检查维度 | 未通过处理 |
|---|---|---|---|
| {{skill1}} | 严格 | 输出格式 + 内容完整性 + 契约字段 | 退回修正，最多2轮 |
| {{skill2}} | 标准 | 输出格式 + 契约字段 | 退回修正，最多1轮 |
| {{skill3}} | 标准 | 输出格式 + 契约字段 | 退回修正，最多1轮 |
| {{skill_last}} | 严格 | 输出格式 + 内容完整性 + 契约字段 | 退回修正，最多2轮 |

**门禁级别说明**：
- **严格**：第一个技能（定义全局框架）、最后一个技能（最终交付）、多下游依赖的技能
- **标准**：普通节点
- **宽松**：辅助节点、无下游依赖的技能

---

## 状态提示块

<!-- UserPromptSubmit Hook 从这里提取当前状态的操作提示 -->
<!-- 不要删除或修改 [workflow-state:STATUS] 标签格式 -->

[workflow-state:no_active_task]
当前无活跃任务。

**启动工作流**：
- 描述你的具体需求，AI 将引导你完成需求澄清
- 或运行 `python .workflow/scripts/workflow.py start` 直接启动

**单独使用技能**：
- 直接指定技能名称（如 "使用 {{skill1_name}}"）
- 技能可独立运行，无需完整工作流
[/workflow-state:no_active_task]

[workflow-state:skill1_in_progress]
正在执行：{{skill1_name}}
- 当前步骤：{{skill1_description}}
- 产出目标：{{skill1_output}}
- 完成后自动进入：{{skill2_name}}
- 门禁级别：严格（输出格式 + 内容完整性 + 契约字段检查）

**质量要求**：
- {{quality_requirement_1}}
- {{quality_requirement_2}}

**完成后运行**：
```bash
python .workflow/scripts/workflow.py next --output "{{output_path}}"
```
[/workflow-state:skill1_in_progress]

[workflow-state:skill2_in_progress]
正在执行：{{skill2_name}}
- 当前步骤：{{skill2_description}}
- 产出目标：{{skill2_output}}
- 上游输入：{{skill1_output}}（来自 {{skill1_name}}）
- 完成后自动进入：{{skill3_name}}
- 门禁级别：标准（输出格式 + 契约字段检查）

**契约要求**：
- 必须包含字段：{{required_fields}}
- 格式：{{output_format}}

**完成后运行**：
```bash
python .workflow/scripts/workflow.py next --output "{{output_path}}"
```
[/workflow-state:skill2_in_progress]

<!-- 为每个技能添加对应的状态块 -->

[workflow-state:completed]
工作流已完成。所有产出物已就绪。

**查看执行报告**：
```bash
python .workflow/scripts/workflow.py report
```

**最终交付物**：
- {{output1_path}} — {{output1_description}}
- {{output2_path}} — {{output2_description}}
- {{output3_path}} — {{output3_description}}

**归档工作流**：
```bash
python .workflow/scripts/workflow.py archive
```

归档后可清理工作目录，保留 `.workflow/archive/` 中的历史记录。
[/workflow-state:completed]

---

## 分支路由（如有）

### 条件 A：{{condition_a}}
- 判断方式：{{detection_method_a}}
- 路由到：{{target_skill_a}}

### 条件 B：{{condition_b}}
- 判断方式：{{detection_method_b}}
- 路由到：{{target_skill_b}}

### 默认路由
- 以上条件均不满足时：{{default_target}}

---

## 中断恢复

工作流支持中断恢复。状态保存在 `.workflow/runtime/state.json`。

**恢复工作流**：
1. 查看当前状态：`python .workflow/scripts/workflow.py status`
2. 如果显示某个技能 `in_progress`，继续执行该技能
3. 完成后运行：`python .workflow/scripts/workflow.py next`

**重置工作流**：
```bash
rm .workflow/runtime/state.json
python .workflow/scripts/workflow.py start
```

---

## 使用说明

### 自动模式（推荐）

AI 会自动：
- 注入工作流状态（通过 Hook）
- 跟踪当前进度
- 提示下一步操作
- 执行质量门禁检查

你只需：
1. 描述需求
2. 确认 AI 的输出
3. 必要时手动运行 `workflow.py next`

### 手动模式

如果 Hook 未生效，可以手动：
1. 查看当前状态：`python .workflow/scripts/workflow.py status`
2. 查看当前技能上下文：`python .workflow/scripts/context.py load {{skill_name}}`
3. 执行技能步骤
4. 标记完成：`python .workflow/scripts/workflow.py next --output "{{path}}"`

---

## 参考文件

- 运行时层详细说明：`references/runtime-guide.md`
- 技能模板：`references/skill-template.md`
- 架构模式：`references/architecture-patterns.md`
- 验证指南：`references/validation-guide.md`
