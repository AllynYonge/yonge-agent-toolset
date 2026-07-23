# 工作流运行时层指南

## 概述

运行时层为复杂工作流（≥6 个技能节点）提供执行时支持，包括：
- Hook 自动注入上下文
- 状态持久化和中断恢复
- 会话记忆和质量门系统

**轻量级工作流**（<6 节点）不生成运行时层，保持纯技能模式。

---

## 目录结构

```
.workflow/
├── hooks/
│   ├── session-start.py         # SessionStart Hook
│   ├── inject-workflow-state.py # UserPromptSubmit Hook
│   └── inject-skill-context.py  # PreToolUse Hook（可选）
├── runtime/
│   ├── state.json               # 工作流执行状态
│   ├── context-manifest.jsonl   # 技能上下文清单
│   └── session-memory.md        # 会话记忆
├── workflow.md                  # 工作流定义和状态提示块
└── scripts/
    ├── workflow.py              # 工作流管理脚本
    └── context.py               # 上下文查询工具
```

---

## Hook 机制

### SessionStart Hook

**触发时机**：会话开始时（新会话、清空上下文、紧凑模式后）

**注入内容**：
- 工作流名称和技能总数
- 当前状态和进度
- 已完成/待执行技能列表
- 工作流概览（流水线图 + 核心原则）

**实现原理**：
1. 读取 `.workflow/runtime/state.json`
2. 提取当前状态和进度
3. 读取 `workflow.md` 的概览部分
4. 注入到 `<session-context>` 和 `<workflow-overview>` 标签

---

### UserPromptSubmit Hook

**触发时机**：每次用户输入时

**注入内容**：
- 当前工作流状态对应的操作提示
- 下一步建议
- 门禁要求（如适用）

**实现原理**：
1. 读取 `state.json` 获取当前状态（如 `skill2_in_progress`）
2. 从 `workflow.md` 解析对应的 `[workflow-state:STATUS]` 块
3. 注入到 `<workflow-state>` 标签

**示例状态块**：

```markdown
[workflow-state:skill2_in_progress]
正在执行：content2-outline-design
- 当前步骤：大纲与论证结构设计
- 产出目标：结构化大纲（含论点+论据+素材需求）
- 完成后自动进入：content3-draft-writing
- 门禁级别：标准（输出格式 + 契约字段检查）
[/workflow-state:skill2_in_progress]
```

---

### PreToolUse Hook（可选）

**触发时机**：调用子代理（Agent/Task）工具前

**触发条件**：
- 使用子代理模式（如 Codex）
- 配置了 `context-manifest.jsonl`

**注入内容**：
- 上游产出物全文
- 当前技能的 `domain-guide.md`
- 相关会话记忆条目

**实现原理**：
1. 读取 `context-manifest.jsonl`
2. 过滤当前技能的上下文条目
3. 读取对应文件内容（限制长度）
4. 注入到 `<!-- trellis-hook-injected -->` 块

---

## state.json 格式

```json
{
  "workflow_id": "content-marketing",
  "created_at": "2026-07-22T14:30:00Z",
  "current_skill": "skill2_in_progress",
  "skills": {
    "skill1": {
      "status": "completed",
      "output_path": "docs/content/topic-research.md",
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
    },
    "skill3": {
      "status": "pending",
      "dependencies": ["skill2"],
      "gate_level": "standard"
    }
  },
  "context": {
    "user_preferences": {},
    "corrections": []
  }
}
```

**状态值**：
- `pending`：等待依赖完成
- `in_progress`：正在执行
- `completed`：已完成
- `failed`：执行失败
- `skipped`：用户跳过

**更新时机**：
- 技能开始：`pending` → `in_progress`
- 技能完成：`in_progress` → `completed`
- 失败重试：`attempts` +1

---

## workflow.py 命令参考

### status - 显示当前状态

```bash
python .workflow/scripts/workflow.py status
```

输出：
- 工作流名称和当前状态
- 所有技能的执行进度
- 产出物路径
- 统计信息

---

### start - 启动工作流

```bash
python .workflow/scripts/workflow.py start
```

功能：
- 找到第一个无依赖或依赖已满足的技能
- 将其标记为 `in_progress`
- 更新 `current_skill` 状态

---

### next - 标记当前技能完成

```bash
python .workflow/scripts/workflow.py next
python .workflow/scripts/workflow.py next --output "docs/content/outline.md"
```

功能：
- 将当前 `in_progress` 的技能标记为 `completed`
- 可选记录产出物路径
- 自动进入下一个可执行的技能

---

### skip - 跳过当前技能

```bash
python .workflow/scripts/workflow.py skip --reason "用户提供了替代输入"
```

功能：
- 将当前技能标记为 `skipped`
- 记录跳过原因
- 下游技能需要检查降级策略

---

### report - 生成执行报告

```bash
python .workflow/scripts/workflow.py report
```

输出：
- 工作流统计（完成/跳过/失败）
- 最终交付物列表
- 执行摘要

---

### archive - 归档工作流

```bash
python .workflow/scripts/workflow.py archive
```

功能：
- 将 `state.json` 保存到 `.workflow/archive/` 目录
- 使用时间戳命名
- 提示清理命令

---

## context-manifest.jsonl 格式

为每个技能定义上下文清单：

```jsonl
{"skill": "skill1", "type": "input", "source": "user", "description": "用户的方向描述"}
{"skill": "skill2", "type": "input", "source": "skill1", "file": "docs/content/topic-research.md", "fields": ["主题", "角度", "受众画像"]}
{"skill": "skill2", "type": "reference", "source": "domain-guide", "file": ".claude/skills/content2-outline-design/references/domain-guide.md", "reason": "大纲设计方法论"}
{"skill": "skill3", "type": "input", "source": "skill2", "file": "docs/content/outline.md", "fields": ["论点", "论据", "素材需求"]}
```

**字段说明**：
- `skill`：目标技能
- `type`：`input`（必需输入）/ `reference`（参考资料）/ `template`（模板）
- `source`：来源（上游技能名 / `user` / `domain-guide`）
- `file`：文件路径
- `fields`：关键字段（可选）
- `reason`：用途说明（可选）

---

## 调试 Hook 脚本

### 手动测试 Hook

```bash
# SessionStart Hook
echo '{"cwd": "/path/to/project"}' | python .workflow/hooks/session-start.py

# UserPromptSubmit Hook
echo '{"cwd": "/path/to/project"}' | python .workflow/hooks/inject-workflow-state.py
```

### 禁用 Hook

```bash
export WORKFLOW_HOOKS=0
```

### 查看 Hook 输出

Hook 输出 JSON 格式：

```json
{
  "hookSpecificOutput": {
    "hookEventName": "SessionStart",
    "additionalContext": "<session-context>...</session-context>"
  }
}
```

---

## 跨平台兼容性

### 支持的平台

运行时层已测试并兼容：
- Claude Code
- Cursor
- Codex
- Gemini（使用 `BeforeAgent` 事件名）
- Qoder
- CodeBuddy

### Windows 特殊处理

- 强制 UTF-8 编码（stdin/stdout/stderr）
- 路径规范化（处理反斜杠）
- 避免使用 POSIX 特定功能

### 平台检测逻辑

```python
def detect_platform(input_data: dict) -> Optional[str]:
    # 1. 检查 Cursor 版本字段
    if isinstance(input_data.get("cursor_version"), str):
        return "cursor"
    
    # 2. 检查环境变量
    env_map = {
        "CLAUDE_PROJECT_DIR": "claude",
        "CURSOR_PROJECT_DIR": "cursor",
        "CODEX_PROJECT_DIR": "codex",
        "GEMINI_PROJECT_DIR": "gemini",
        "QODER_PROJECT_DIR": "qoder",
    }
    for env_name, platform in env_map.items():
        if os.environ.get(env_name):
            return platform
    
    return None
```

---

## 会话记忆系统

### session-memory.md 格式

自动记录执行过程中的关键事件：

```markdown
## 经验 — content3-draft-writing — 2026-07-22

**问题**：初稿生成时段落逻辑跳跃，缺少过渡句。

**原因**：大纲中的论点之间关系未明确标注（并列/递进/转折）。

**解法**：在 content2-outline-design 的输出模板中增加"论点关系"字段。

**影响范围**：content2 输出模板、content3 输入契约。

**状态**：已修正，重新生成。
```

### 记录触发条件

| 信号 | 记录内容 |
|---|---|
| 技能重试 ≥ 2 次 | 失败原因 + 最终解法 |
| 门禁退回修正 | 缺陷模式 + 修正方式 |
| 用户修正产出物 | 修正前后对比 + 原因 |
| 降级模式触发 | 触发原因 + 实际影响 |
| 分支路由决策 | 选择的分支 + 判断依据 |

### 复用机制

下次执行相同工作流时，SessionStart Hook 自动加载 `session-memory.md` 的摘要（最近 10 条），避免重复错误。

---

## 质量门系统

### 门禁级别

| 级别 | 检查维度 | 未通过处理 |
|---|---|---|
| **严格** | 输出格式 + 内容完整性 + 契约字段 | 退回修正，最多 2 轮 |
| **标准** | 输出格式 + 契约字段 | 退回修正，最多 1 轮 |
| **宽松** | 仅输出格式 | 标注问题，继续推进 |

### 级别分配规则

- **严格**：第一个技能、最后一个技能、多下游依赖的技能
- **标准**：普通节点
- **宽松**：辅助节点、无下游依赖的技能

### 实现方式

在技能 SKILL.md 末尾增加"## 门禁检查"章节，列出检查清单和未通过处理策略。

---

## 常见问题

### Q: 如何为已有工作流添加运行时层？

A: 重新运行 meta-workflow-generator，它会检测到现有技能并补充运行时层。

### Q: 可以禁用某个 Hook 吗？

A: 可以。删除或重命名对应的 Hook 脚本即可。

### Q: state.json 丢失了怎么办？

A: 运行 `python .workflow/scripts/workflow.py start` 会重新初始化状态。如果有归档，可以从 `.workflow/archive/` 恢复。

### Q: 如何重置工作流？

A: 删除 `.workflow/runtime/state.json`，然后运行 `python .workflow/scripts/workflow.py start`。

### Q: Hook 不生效怎么办？

A: 检查：
1. 脚本是否可执行（`chmod +x .workflow/hooks/*.py`）
2. Python 版本（需要 3.7+）
3. 是否设置了 `WORKFLOW_HOOKS=0`
4. 平台是否支持 Hook

---

## 进阶用法

### 自定义状态块

在 `workflow.md` 中添加自定义状态块：

```markdown
[workflow-state:custom_state]
自定义状态提示内容
[/workflow-state:custom_state]
```

然后在 `state.json` 中设置 `current_skill` 为 `custom_state`。

### 扩展上下文清单

在 `context-manifest.jsonl` 中添加新条目：

```jsonl
{"skill": "skill3", "type": "reference", "source": "external", "file": "path/to/reference.md", "reason": "外部参考资料"}
```

### 集成外部工具

在技能 SKILL.md 中调用外部工具，并将结果写入产出物：

```bash
python external-tool.py --input "$INPUT" --output "$OUTPUT"
python .workflow/scripts/workflow.py next --output "$OUTPUT"
```

---

## 总结

运行时层为复杂工作流提供了：
1. **自动上下文注入** — Hook 机制消除手动加载
2. **状态持久化** — 支持中断恢复
3. **会话记忆** — 避免重复错误
4. **质量门** — 多层次质量保证
5. **跨平台** — 适配多种 AI 编码平台

轻量级工作流保持纯技能模式，复杂工作流自动获得完整运行时支持。
