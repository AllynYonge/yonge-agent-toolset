# 工作流验证指南（可选）

本文件提供工作流交付后的验证方法。验证是可选步骤，不阻塞交付。

## 何时验证

- 流水线包含 5+ 节点
- 技能之间有复杂依赖或分支
- 用户明确要求验证
- 领域知识主要基于模型生成（标注了多处 `[基于通用方法论]`）

## 验证场景选择

与用户协商一个**中等复杂度的真实任务**作为试运行场景。选择标准：
- 能覆盖流水线中 ≥ 70% 的技能节点
- 复杂度适中（不是最简单也不是最复杂的典型任务）
- 用户熟悉预期结果（能判断产出质量）

如果用户无法提供真实场景，构造一个合理的模拟场景并标注 `[模拟场景]`。

## 逐技能走查

按流水线顺序，逐个技能执行试运行：

| 步骤 | 检查内容 | 通过标准 |
|---|---|---|
| 触发 | 技能是否在预期条件下被正确触发 | description 中的触发条件与实际场景匹配 |
| 输入 | 上游产出是否能满足当前技能的输入契约 | 无缺失字段、格式兼容 |
| 执行 | 工作流程步骤是否可顺畅执行 | 无卡顿、无歧义、无死循环 |
| 输出 | 产出物是否符合输出规范 | 格式正确、内容完整、路径正确 |
| 传递 | 产出物是否能作为下游技能的有效输入 | 下游技能可无障碍读取和使用 |

## 问题收集与修正

试运行中发现的问题分类处理：

| 问题类型 | 处理方式 | 示例 |
|---|---|---|
| 契约不匹配 | 修正上游输出规范或下游输入契约 | 技能A输出缺少技能B需要的字段 |
| 步骤模糊 | 补充具体操作指导 | "分析数据"太笼统，改为具体分析方法 |
| 环节缺失 | 新增技能节点或在现有技能中补充步骤 | 发现需要一个"数据清洗"预处理环节 |
| 质量标准不可判 | 补充量化标准或示例 | "写得好"改为"覆盖所有用户故事" |
| 分支未覆盖 | 补充条件分支和降级策略 | 输入数据不完整时应如何处理 |

**修正后重新运行受影响的节点**，确认修正有效。

## 试运行报告模板

```markdown
## 试运行报告

**验证场景：** {场景描述}
**覆盖技能：** {N}/{总数} 个节点

### 通过项
- {技能名}: {一句话确认}

### 发现并修正的问题
| # | 技能 | 问题 | 修正内容 |
|---|---|---|---|

### 未覆盖项（需后续验证）
- {未触发的技能及原因}

### 整体评估
{流水线整体可用性判断 + 建议}
```

---

## 运行时层验证（复杂工作流）

以下验证项仅在生成了运行时层（≥6 节点）时执行。

### 验证清单

| # | 检查项 | 验证方法 | 通过标准 |
|---|---|---|---|
| 1 | Hook 脚本可执行且语法正确 | `python -m py_compile .workflow/hooks/*.py` | 无语法错误 |
| 2 | state.json 初始状态正确 | 检查 JSON 格式、必需字段、技能列表 | 符合 state-schema.json |
| 3 | context-manifest.jsonl 覆盖所有技能 | 运行 `python .workflow/scripts/context.py validate` | 无缺失文件 |
| 4 | workflow.md 的状态块与技能数量匹配 | 每个技能有对应的 `[workflow-state:skill{N}_in_progress]` 块 | 数量一致 |
| 5 | workflow.py 命令可正常运行 | 运行 `python .workflow/scripts/workflow.py status` | 正常输出，退出码 0 |
| 6 | 质量门配置完整 | workflow.md 包含"质量门配置"表格 | 每个技能有门禁级别 |

### Hook 脚本测试

```bash
# 测试 SessionStart Hook
echo '{"cwd": "'$(pwd)'"}' | python .workflow/hooks/session-start.py

# 测试 UserPromptSubmit Hook
echo '{"cwd": "'$(pwd)'"}' | python .workflow/hooks/inject-workflow-state.py

# 检查输出 JSON 格式
echo '{"cwd": "'$(pwd)'"}' | python .workflow/hooks/session-start.py | python -m json.tool
```

### 状态文件验证

```bash
# 验证 state.json 符合 schema
python -c "
import json
from pathlib import Path

state = json.loads(Path('.workflow/runtime/state.json').read_text())
schema = json.loads(Path('.workflow/scripts/../runtime-template/state-schema.json').read_text())

# 简单验证必需字段
required = ['workflow_id', 'current_skill', 'skills']
missing = [f for f in required if f not in state]
if missing:
    print(f'缺少必需字段: {missing}')
    exit(1)

print('✓ state.json 格式正确')
"
```

### 工作流命令测试

```bash
# 测试所有命令
python .workflow/scripts/workflow.py status
python .workflow/scripts/workflow.py start
python .workflow/scripts/workflow.py status
python .workflow/scripts/workflow.py report

# 测试上下文查询
python .workflow/scripts/context.py list
python .workflow/scripts/context.py validate
```

### 完整端到端测试

1. 初始化状态：`python .workflow/scripts/workflow.py start`
2. 验证 Hook 注入：启动 AI 会话，检查是否自动注入上下文
3. 模拟技能完成：`python .workflow/scripts/workflow.py next --output "test.md"`
4. 验证状态转换：`python .workflow/scripts/workflow.py status`
5. 生成报告：`python .workflow/scripts/workflow.py report`
6. 归档工作流：`python .workflow/scripts/workflow.py archive`

---

## 修正常见问题

### 问题 1：Hook 脚本不可执行

```bash
chmod +x .workflow/hooks/*.py
```

### 问题 2：state.json 缺失或损坏

重新初始化：
```bash
rm .workflow/runtime/state.json
python .workflow/scripts/workflow.py start
```

### 问题 3：workflow.md 缺少状态块

检查是否包含 `[workflow-state:STATUS]...[/workflow-state:STATUS]` 格式的块。

### 问题 4：Python 版本过低

确保 Python >= 3.7：
```bash
python --version
# 或
python3 --version
```
