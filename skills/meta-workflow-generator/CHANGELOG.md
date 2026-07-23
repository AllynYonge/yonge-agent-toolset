# Meta-Workflow-Generator 优化迭代日志

## 版本 2.0 - 运行时层增强 (2026-07-22)

### 概述

为 meta-workflow-generator 引入运行时层支持，借鉴 Trellis 设计，为复杂工作流（≥6 节点）自动生成 Hook 机制、状态持久化和质量门系统。

### 新增文件

#### 1. 运行时模板目录 (`references/runtime-template/`)

| 文件 | 行数 | 说明 |
|---|---|---|
| `session-start.py` | 161 | SessionStart Hook - 注入工作流全景和当前状态 |
| `inject-workflow-state.py` | 123 | UserPromptSubmit Hook - 注入当前状态提示 |
| `inject-skill-context.py` | 152 | PreToolUse Hook - 为子代理注入上下文（可选） |
| `workflow.py` | 300 | 工作流管理脚本（status/start/next/skip/report/archive） |
| `context.py` | 180 | 上下文查询工具（list/load/validate） |
| `state-schema.json` | 80 | state.json 的 JSON Schema |
| `state-init-template.json` | 20 | state.json 初始化模板 |
| `context-manifest-template.jsonl` | 5 | 上下文清单模板 |
| `workflow-template.md` | 200 | workflow.md 完整模板（含状态提示块） |
| `session-memory-template.md` | 30 | 会话记忆初始化模板 |
| `README.md` | 150 | 运行时模板使用说明 |

**总计**：11 个文件，约 1,400 行代码/文档

#### 2. 运行时指南 (`references/runtime-guide.md`)

- 60 KB，详细说明运行时层机制
- 包含：Hook 工作原理、state.json 格式、命令参考、调试方法、跨平台兼容性

#### 3. 更新现有文件

| 文件 | 变更 |
|---|---|
| `SKILL.md` | 更新模式选择表格，添加运行时层说明（3个新段落） |
| `references/skill-template.md` | 新增"门禁检查"和"运行时集成"章节 |
| `references/validation-guide.md` | 新增运行时层验证清单（6个验证项） |
| `references/orchestrator-template.md` | 添加与运行时层关系说明 |

### 核心功能

#### 1. Hook 自动注入

- **SessionStart Hook**：会话开始时注入工作流全景、当前进度、已完成/待执行技能列表
- **UserPromptSubmit Hook**：每次用户输入时从 workflow.md 解析并注入当前状态提示块
- **PreToolUse Hook**（可选）：子代理调用前注入技能特定上下文

#### 2. 状态持久化

- `state.json` 记录每个技能的执行状态（pending/in_progress/completed/failed/skipped）
- 支持中断恢复：会话中断后从上次进度继续
- 产出物路径追踪
- 重试次数统计

#### 3. 质量门系统

- 三级门禁：严格/标准/宽松
- 自动分配规则：
  - 严格：第一个和最后一个技能、多下游依赖的技能
  - 标准：普通节点
  - 宽松：辅助节点、无下游依赖的技能
- 检查维度：输出格式 + 契约字段 + 内容完整性（严格级）

#### 4. 会话记忆系统

- 自动记录：技能重试、门禁退回、用户修正、降级模式、分支决策
- 格式化存储：问题-原因-解法-影响范围-状态
- 下次执行时自动加载最近 10 条

#### 5. 工作流管理命令

```bash
python .workflow/scripts/workflow.py status    # 显示当前状态
python .workflow/scripts/workflow.py start     # 启动工作流
python .workflow/scripts/workflow.py next      # 进入下一个技能
python .workflow/scripts/workflow.py skip      # 跳过当前技能
python .workflow/scripts/workflow.py report    # 生成执行报告
python .workflow/scripts/workflow.py archive   # 归档工作流
```

#### 6. 上下文查询工具

```bash
python .workflow/scripts/context.py list       # 列出上下文条目
python .workflow/scripts/context.py load       # 加载技能上下文
python .workflow/scripts/context.py validate   # 验证清单完整性
```

### 生成规则

| 条件 | 运行时层 | 编排器 |
|---|---|---|
| 节点 < 6 | 不生成 | 不生成 |
| 节点 ≥ 6，线性 | Hook + 脚本 | 不生成 |
| 节点 ≥ 6，非线性 | Hook + 脚本 | 生成 |

### 平台兼容性

- Claude Code
- Cursor
- Codex
- Gemini（使用 BeforeAgent 事件名）
- Qoder
- CodeBuddy
- Windows 特殊处理：UTF-8 强制编码、路径规范化

### 向后兼容性

- 已有工作流（v1.0）继续正常工作
- 不会因引入运行时层而破坏现有技能
- 用户可选择为已有工作流补充运行时层

### 技术细节

#### workflow.md 状态提示块格式

```markdown
[workflow-state:skill2_in_progress]
正在执行：技能名称
- 当前步骤：步骤描述
- 产出目标：产出物
- 完成后自动进入：下一个技能
- 门禁级别：标准
[/workflow-state:skill2_in_progress]
```

#### state.json 格式

```json
{
  "workflow_id": "workflow-name",
  "created_at": "2026-07-22T14:30:00Z",
  "current_skill": "skill2_in_progress",
  "skills": {
    "skill1": {
      "status": "completed",
      "output_path": "path/to/output.md",
      "completed_at": "2026-07-22T14:25:00Z",
      "attempts": 1,
      "gate_level": "strict"
    },
    "skill2": {
      "status": "in_progress",
      "started_at": "2026-07-22T14:26:00Z",
      "attempts": 1,
      "dependencies": ["skill1"],
      "gate_level": "standard"
    }
  },
  "context": {
    "user_preferences": {},
    "corrections": []
  }
}
```

#### context-manifest.jsonl 格式

```jsonl
{"skill": "skill1", "type": "input", "source": "user", "description": "用户输入"}
{"skill": "skill2", "type": "input", "source": "skill1", "file": "path/to/output.md", "fields": ["field1", "field2"]}
{"skill": "skill2", "type": "reference", "source": "domain-guide", "file": ".claude/skills/.../domain-guide.md"}
```

### 测试覆盖

#### 测试场景 1：简单工作流（3节点）
- ✓ 仅生成技能目录
- ✓ 无 .workflow/ 目录
- ✓ 无 Hook 脚本

#### 测试场景 2：复杂线性工作流（6节点）
- ✓ 生成 .workflow/ 目录
- ✓ Hook 脚本可执行
- ✓ workflow.py 命令正常
- ✓ 不生成编排器

#### 测试场景 3：复杂非线性工作流（7节点+分支）
- ✓ 生成完整运行时层
- ✓ 生成编排器技能
- ✓ 支持并行分支调度

### 文档更新

- 新增 `references/runtime-guide.md`（60 KB）
- 更新 `SKILL.md` 模式选择说明
- 更新 `references/skill-template.md` 技能模板
- 更新 `references/validation-guide.md` 验证清单
- 更新 `references/orchestrator-template.md` 编排器说明

### 已知限制

1. 并行执行上限 3 个技能（避免上下文过载）
2. Hook 依赖平台支持（某些平台可能不支持）
3. 会话记忆最多保留最近 10 条（避免过长）
4. 上下文注入单个文件最大 2000 字符（PreToolUse Hook）

### 未来改进

1. 可视化界面（Web UI 查看工作流状态）
2. 性能指标追踪（每个技能的耗时统计）
3. 回滚机制（撤销某个技能的完成状态）
4. 并行执行监控（多技能同时 in_progress）
5. 增量更新（只重新生成变更的部分）

### 升级指南

#### 为现有工作流添加运行时层

1. 备份现有工作流目录
2. 重新运行 meta-workflow-generator（会检测现有技能）
3. 选择"补充运行时层"选项
4. 验证：`python .workflow/scripts/workflow.py status`

#### 从 v1.0 迁移

v1.0 生成的纯技能模式工作流无需修改，可以继续使用。如需运行时层支持：
1. 评估工作流复杂度（节点数、依赖关系）
2. 如果 ≥ 6 节点，运行升级命令
3. 如果 < 6 节点，保持纯技能模式更简洁

### 贡献者

- 设计与实现：基于 Trellis 工作流和 meta-workflow-generator v1.0
- 参考项目：Trellis (`.trellis/`)

### 许可证

MIT License

---

## 版本 1.0 - 初始版本

（保留原有版本日志）
