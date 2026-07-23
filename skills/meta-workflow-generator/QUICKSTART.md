# Meta-Workflow-Generator 快速上手指南

## 什么是运行时层？

运行时层是为复杂工作流（≥6 个技能节点）自动生成的执行时支持系统，包括：
- **Hook 自动注入**：会话开始和用户输入时自动注入工作流状态
- **状态持久化**：记录每个技能的执行进度，支持中断恢复
- **质量门系统**：多层次质量检查，防止低质量产出流入下游
- **会话记忆**：自动记录错误和解法，避免重复问题

---

## 何时会生成运行时层？

| 你的工作流 | 生成内容 |
|---|---|
| **≤ 4 个技能节点** | 纯技能模式，无运行时层 |
| **5-6 个节点，线性流水线** | Hook + 管理脚本 |
| **≥ 6 个节点，有分支/并行/循环** | Hook + 管理脚本 + 编排器 |

---

## 5 分钟快速体验

### 1. 生成一个复杂工作流

```bash
# 使用 meta-workflow-generator 生成数据分析工作流
# （假设有 6 个技能节点：问题定义 → 数据探索 → 分析执行 → 洞察提炼 → 报告生成 → 可视化）
```

AI 会自动检测到节点数 ≥ 6，并生成运行时层。

---

### 2. 查看生成的目录结构

```bash
ls -la .workflow/
```

你会看到：
```
.workflow/
├── hooks/                       # Hook 脚本
│   ├── session-start.py
│   └── inject-workflow-state.py
├── runtime/                     # 运行时数据
│   ├── state.json
│   ├── context-manifest.jsonl
│   └── session-memory.md
├── workflow.md                  # 工作流定义
└── scripts/                     # 管理脚本
    ├── workflow.py
    └── context.py
```

---

### 3. 查看当前状态

```bash
python .workflow/scripts/workflow.py status
```

输出示例：
```
工作流：data-analysis
当前状态：no_active_task

技能进度：
============================================================
☐ skill1
   状态：pending
☐ skill2
   状态：pending
   ...
============================================================

进度：0/6 技能已完成
```

---

### 4. 启动工作流

```bash
python .workflow/scripts/workflow.py start
```

输出：
```
✓ 工作流已启动
当前技能：skill1

开始执行该技能的步骤...
```

---

### 5. 体验 Hook 自动注入

在 AI 编码环境中开启新会话，你会看到 AI 自动获得：
- 工作流概览
- 当前进度（0/6）
- 当前技能的操作提示

每次你输入时，AI 都会看到：
- 当前状态对应的提示块（从 workflow.md 解析）
- 下一步建议
- 质量要求

**你无需手动提供这些信息，Hook 自动注入！**

---

### 6. 标记技能完成

当你完成 skill1 后，运行：

```bash
python .workflow/scripts/workflow.py next --output "docs/analysis/problem-definition.md"
```

输出：
```
✓ skill1 已完成
→ 进入下一个技能：skill2
```

再次查看状态：
```bash
python .workflow/scripts/workflow.py status
```

输出：
```
技能进度：
============================================================
☑ skill1
   状态：completed
   产出：docs/analysis/problem-definition.md
◐ skill2
   状态：in_progress
☐ skill3
   状态：pending
   ...
============================================================

进度：1/6 技能已完成
```

---

### 7. 中断恢复

如果你关闭了会话，下次继续时：

```bash
python .workflow/scripts/workflow.py status
```

会显示上次的进度（skill2 in_progress）。

Hook 会在新会话开始时自动加载这个状态，AI 知道从哪里继续。

---

### 8. 生成执行报告

完成所有技能后：

```bash
python .workflow/scripts/workflow.py report
```

输出：
```
============================================================
工作流执行报告：data-analysis
============================================================

总技能数：6
已完成：6
已跳过：0
失败：0

最终交付物：
------------------------------------------------------------
  • docs/analysis/problem-definition.md
  • docs/analysis/data-exploration.md
  • docs/analysis/analysis-results.md
  • docs/analysis/insights.md
  • docs/analysis/report.pdf
  • docs/analysis/visualizations/
============================================================
```

---

### 9. 归档工作流

```bash
python .workflow/scripts/workflow.py archive
```

输出：
```
✓ 工作流已归档到：.workflow/archive/data-analysis-20260722-143000.json

如需清理工作目录，运行：
  rm .workflow/runtime/state.json
```

---

## 核心概念

### Hook 注入

**SessionStart Hook**（会话开始时）：
- 注入工作流全景（技能总数、流水线图）
- 注入当前进度（已完成 X/总数 Y）
- 注入已完成和待执行技能列表

**UserPromptSubmit Hook**（每次用户输入时）：
- 从 workflow.md 解析当前状态的提示块
- 注入当前步骤、产出目标、下一步建议
- 注入质量要求和门禁级别

**效果**：AI 始终知道当前处于工作流的哪个位置，应该做什么。

---

### 状态持久化

`state.json` 记录：
- 每个技能的状态（pending/in_progress/completed/failed/skipped）
- 产出物路径
- 开始/完成时间
- 重试次数

**效果**：会话中断后可以从上次进度继续，无需重头开始。

---

### 质量门

三级门禁：
- **严格**：第一个和最后一个技能，检查输出格式 + 内容完整性 + 契约字段
- **标准**：普通节点，检查输出格式 + 契约字段
- **宽松**：辅助节点，仅检查输出格式

**效果**：每个技能完成后自动检查，不通过则退回修正。

---

### 会话记忆

`session-memory.md` 自动记录：
- 技能重试（≥2 次）：失败原因 + 最终解法
- 门禁退回：缺陷模式 + 修正方式
- 用户修正：修正前后对比 + 原因
- 降级模式：触发原因 + 实际影响

**效果**：下次执行相同工作流时，Hook 自动加载最近 10 条记忆，避免重复错误。

---

## 常见场景

### 场景 1：跳过某个技能

```bash
python .workflow/scripts/workflow.py skip --reason "用户已手动完成该步骤"
```

### 场景 2：查看某个技能的上下文

```bash
python .workflow/scripts/context.py load skill2
```

输出：
- 上游产出物全文
- domain-guide.md 内容
- 相关会话记忆

### 场景 3：验证上下文清单

```bash
python .workflow/scripts/context.py validate
```

检查：
- 所有引用的文件是否存在
- 必需字段是否完整

### 场景 4：重置工作流

```bash
rm .workflow/runtime/state.json
python .workflow/scripts/workflow.py start
```

---

## 与纯技能模式的对比

| 特性 | 纯技能模式（<6 节点） | 运行时层（≥6 节点） |
|---|---|---|
| **上下文传递** | 手动或通过"工作流协同"章节 | Hook 自动注入 |
| **进度追踪** | AI 记忆（会话内） | state.json 持久化 |
| **中断恢复** | 需要重新说明进度 | 自动从上次继续 |
| **质量检查** | 技能内自检 | 多层质量门自动执行 |
| **会话记忆** | 无 | 自动记录和复用 |
| **管理命令** | 无 | workflow.py 6 个命令 |
| **复杂度** | 低 | 中等 |

---

## 调试技巧

### 1. Hook 不生效？

检查：
```bash
# Hook 脚本是否可执行
ls -l .workflow/hooks/*.py

# 如果不可执行
chmod +x .workflow/hooks/*.py
```

手动测试：
```bash
echo '{"cwd": "'$(pwd)'"}' | python .workflow/hooks/session-start.py
```

### 2. 状态不更新？

检查 state.json 权限：
```bash
ls -l .workflow/runtime/state.json

# 如果只读
chmod 644 .workflow/runtime/state.json
```

### 3. 查看 Hook 输出

Hook 输出 JSON，可以用 jq 格式化：
```bash
echo '{"cwd": "'$(pwd)'"}' | python .workflow/hooks/inject-workflow-state.py | jq
```

---

## 禁用运行时层

如果你想临时禁用 Hook：

```bash
export WORKFLOW_HOOKS=0
```

管理脚本不受影响，仍可正常使用。

---

## 下一步

- 阅读 [references/runtime-guide.md](references/runtime-guide.md) 了解详细机制
- 查看 [references/runtime-template/README.md](references/runtime-template/README.md) 了解模板结构
- 阅读 [CHANGELOG.md](CHANGELOG.md) 查看完整变更列表

---

## 常见问题

### Q: 我可以只用部分运行时层功能吗？

A: 可以。你可以：
- 只使用管理脚本（workflow.py），手动更新状态
- 只使用 Hook，不用管理脚本
- 删除某个 Hook 脚本，保留其他

### Q: 运行时层会增加多少复杂度？

A: 对于用户来说，复杂度几乎为零：
- Hook 自动工作，无需手动调用
- 管理命令简单（status/start/next）
- 大部分时候你只需正常使用 AI，运行时层在后台工作

### Q: 如何迁移已有工作流？

A: 如果你的工作流 < 6 节点，保持纯技能模式更简洁。如果 ≥ 6 节点，重新运行 meta-workflow-generator 生成运行时层。

### Q: 运行时层支持哪些平台？

A: Claude Code、Cursor、Codex、Gemini、Qoder、CodeBuddy 等主流 AI 编码工具。

### Q: 可以自定义状态块吗？

A: 可以。编辑 `workflow.md`，添加自定义的 `[workflow-state:custom_state]` 块，然后在 `state.json` 中设置 `current_skill` 为 `custom_state`。
