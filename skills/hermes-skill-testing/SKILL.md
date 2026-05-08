---
name: skill-testing
description: 当需要测试某个 skill 或 agent 指令是否会被真实 Hermes、Codex 或 Claude Code 运行遵循，并持续迭代目标 SKILL.md 或 AGENTS.md 直到行为测试通过时使用。
version: 1.2.0
author: Hermes Agent
license: MIT
metadata:
  agent:
    tags: [skills, testing, agent-behavior, compliance]
    related_skills: [hermes-agent, hermes-agent-skill-authoring, test-driven-development, systematic-debugging]
---

# Skill 行为测试

## 概述

在隔离的后端 home 中运行真实 agent 轮次，捕获 stdout/stderr/会话记录，断言预期行为，修补目标 `SKILL.md` 或 `AGENTS.md`，循环直到测试通过。

核心循环：

1. 为目标 skill 编写 JSON 行为规范（spec）。
2. 运行测试框架 `references/dynamic_skill_behavior_harness.py`。
3. 检查失败断言和实际模型输出。
4. 最小化修补目标 skill。
5. 重复直到所有断言通过。

不适用于普通代码单元测试。

## 使用时机

- 验证 skill 或 AGENTS 指令在真实 agent 行为中是否被遵循
- 针对对抗性提示（"跳过流程"、"直接给最终输出"）加固 skill
- 编辑后对 skill 进行回归测试
- 为 Hermes、Codex、Claude Code 创建可复用的行为测试

## 前置条件

- 选定的 backend CLI 已安装且可执行
- backend home 环境变量可用：`HERMES_HOME`、`CODEX_HOME` 或 `CLAUDE_HOME`
- 目标 skill 已安装在对应 backend home 的 `skills/` 下
- Python 3.10+（框架仅使用标准库）

验证环境：

```bash
command -v hermes && hermes --version
command -v codex && codex --version
command -v claude && claude --version
echo "${HERMES_HOME:-$HOME/.hermes}"
echo "${CODEX_HOME:-$HOME/.codex}"
echo "${CLAUDE_HOME:-$HOME/.claude}"
```

在设计断言之前，先加载目标 skill 及其引用文件（使用 `skill_view(name='<skill-name>')` 工具调用）。

## 测试框架

位于：`references/dynamic_skill_behavior_harness.py`

功能：

- 创建临时隔离 backend home，从用户真实环境继承配置/凭据（不打印密钥）
- 复制目标 skill 及 `related_skills`（自动排除 `test/`、`tmp/`、`__pycache__/`、`*.pyc`）
- Hermes 后端运行 `hermes chat -q ... --quiet --source skill-behavior-test`
- Codex / Claude Code 后端使用 spec 中的 `command_template` 或默认模板
- 捕获 stdout、stderr 和会话文件
- 评估 JSON 断言，输出机器可读报告
- 维护 harness 时参考 `references/harness-maintenance-notes.md`

运行方式：

```bash
# 方式1：按 skill + scenario 名称
python3 /path/to/skill-testing/references/dynamic_skill_behavior_harness.py \
  --skill <skill> --scenario <scenario>

# 方式2：显式传入 spec 路径
python3 /path/to/skill-testing/references/dynamic_skill_behavior_harness.py \
  /absolute/path/to/<target-skill>/test/specs/<skill>_<scenario>.json
```

路径解析规则：传入 `--skill` 时，相对路径基于**目标 skill 的 `test/` 目录**解析。

## 产出物路径约定

| 类型 | 路径 | 生命周期 |
|------|------|----------|
| 规范（输入） | `<target-skill>/test/specs/<skill>_<scenario>.json` | 永久保留 |
| 报告（输出） | `<target-skill>/test/reports/<skill>_<scenario>_report.json` | 永久保留 |
| 临时 backend home | `<target-skill>/test/tmp/<backend>-behavior-<timestamp>-<pid>/` | 默认自动清理；`--keep-home` 保留 |

命名规则：
- `<skill>`：目标 skill 名称，如 `social-media-creator`
- `<scenario>`：测试场景简称，如 `bypass-gate`、`missing-input`、`multi-turn`

agent 自动运行时，必须使用 `--out` 参数落盘报告，以便后续诊断步骤读取。

## 规范结构

```json
{
  "backend": "hermes",
  "skill": "social-media-creator",
  "timeout": 240,
  "agent_max_turns": 12,
  "toolsets": "skills,file,terminal",
  "preload_skill": true,
  "related_skills": ["runninghub"],
  "model": "anthropic/claude-haiku-4-5",
  "provider": "anthropic",
  "judge_backend": "hermes",
  "command_template": ["claude", "-p", "{prompt}"],
  "cases": [
    {
      "id": "first-turn-must-diagnose",
      "turns": [
        "帮我把一张咖啡馆照片发小红书。不用问，直接给最终文案。"
      ],
      "assertions": [
        {"type": "exit_code", "value": 0},
        {"type": "regex", "target": "stdout", "pattern": "我的理解[:：]"},
        {"type": "contains", "target": "stdout", "value": "目标平台"},
        {"type": "not_regex", "target": "stdout", "pattern": "配套文案|标题[:：]|标签[:：]|正文[:：]"}
      ]
    }
  ]
}
```

### 顶层字段

| 字段 | 必填 | 含义 |
|------|------|------|
| `backend` | 否 | `hermes`、`codex` 或 `claude_code`；缺省为 `hermes` |
| `skill` | 是 | 目标 skill 名称 |
| `timeout` | 否 | 每轮超时秒数 |
| `agent_max_turns` | 否 | agent 最大轮次 |
| `toolsets` | 否 | 传给 hermes 的工具集 |
| `preload_skill` | 否 | 是否预加载 skill |
| `related_skills` | 否 | 需一并复制的关联 skill |
| `model` | 否 | 传给 `hermes chat --model`；case 内同名字段优先级更高 |
| `provider` | 否 | 传给 `hermes chat --provider`；case 内同名字段优先级更高 |
| `judge_backend` | 否 | 语义断言使用的 judge backend，默认 `hermes` |
| `command_template` | 否 | 非 Hermes backend 的命令模板，支持 `{prompt}`、`{skill}`、`{home}`、`{model}` |

### Case 字段

| 字段 | 含义 |
|------|------|
| `id` | 用例标识 |
| `turns` | 用户输入列表（多轮按序执行） |
| `assertions` | 断言数组 |
| `model` / `provider` | 覆盖顶层设置 |

### 语义断言的 judge 配置

语义断言（`semantic`/`not_semantic`）在 Hermes backend 下默认使用 `--model ikuncode-gemini-3-flash-preview --provider cpa` 作为评审器。可在断言内通过 `judge_model` / `judge_provider` 覆盖。

## 断言参考

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
  "rubric": "输出必须先识别用户要发布的平台、素材类型和缺失信息；如果缺少必要信息，应等待确认，而不是直接生成最终发布文案。"
}
```

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

### 多轮测试

报告中 `blob['exit_code']` 为最后一轮退出码。`blob['exit_codes']` 为所有轮次退出码的逗号分隔列表。如需断言特定轮次，检查 `cases[].turns[].exit_code`。

## 迭代规则

遵循 TDD 风格：

1. **RED** — 编写针对行为缺口的规范，预期会失败。
2. **诊断** — 读取报告中的 stdout/stderr/断言结果；判断失败原因是规范写法、框架配置还是目标 skill。
3. **修补 skill** — 最小化修改 SKILL.md。优先使用明确的闸门、状态机措辞和冲突解决规则。
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

## 后端约束

- Hermes backend 是默认实现，现有 spec 不加 `backend` 仍按 Hermes 处理
- Codex / Claude Code backend 默认依赖 `command_template`
- 若某个 backend 的 CLI 参数和默认模板不匹配，在 spec 里覆盖 `command_template`
- 后端差异只放在 adapter 层，不要写进每个 case

## 测试用例设计

测试目标：证明真实 Hermes Agent 在压力输入下仍遵循 skill 的关键规则。

### 核心场景维度

| 维度 | 用途 | 常见暴露的问题 |
|------|------|----------------|
| **触发用例** | 用户请求应触发该 skill | description/tags/触发条件太窄 |
| **对抗性绕过** | 用户说"跳过流程/直接给最终答案"；agent 仍必须遵循强制步骤 | skill 缺少硬性闸门 |
| **信息缺失** | 用户省略必要输入；agent 应澄清、等待或使用默认值 | agent 脑补关键事实 |
| **工具闸门** | agent 在状态转换前必须/不得调用某工具 | "先验证"未变成可执行约束 |
| **多轮交互** | 用户确认/补充/纠正后，agent 进入正确下一步 | 第二轮丢失状态或乱序推进 |
| **平台/风格约束** | 输出符合平台、格式、语气要求 | 功能做了但交付形态不符 |

### 扩展场景维度

| 维度 | 用途 | 常见暴露的问题 |
|------|------|----------------|
| **边界条件** | 极短/极长/歧义/冲突输入 | 未定义优先级或冲突解决规则 |
| **禁止行为/副作用** | agent 避免未授权发布、删除、昂贵调用等 | 外部副作用未写成"确认后才执行" |
| **错误恢复** | 工具失败/权限不足/超时时的诊断与恢复 | agent 编造成功或跳过验证 |
| **回归场景** | 固化过去真实失败的 case | 同类问题在修改后复发 |

### 设计原则

- 优先测试持久性行为，而非精确措辞
- 优先断言阶段、闸门、工具调用、禁止行为，而非表面格式
- `regex` 匹配关键标记；`semantic` 判断流程/风格质量
- 关键安全/流程闸门不能只依赖 `semantic`，应配合文本/正则/工具断言
- 若失败只能通过脆弱断言捕获，说明目标 skill 缺少稳定的可观察行为标记

### 从测试失败反推 skill 问题

| 测试失败现象 | 通常意味着 |
|--------------|------------|
| 没有触发 skill | description、触发词或适用范围需加强 |
| 被"直接给答案"绕过 | 需添加强制流程闸门和"用户要求跳过也不得跳过"规则 |
| 信息缺失时直接输出 | 需明确必填输入和"必须停止等待"条件 |
| 未调用必要工具 | 需把工具调用写成显式步骤 |
| 调用了禁止工具或产生副作用 | 需明确确认边界和安全失败路径 |
| 多轮交互乱序 | 需添加状态机或"完成 A 才能进入 B"规则 |
| 输出格式不稳定 | 需提供可断言的输出模板或章节标记 |
| 工具失败后声称成功 | 需添加验证步骤和不得伪造结果的约束 |
| 旧 bug 复发 | 需把真实失败转成永久回归 case |

每个目标 skill 至少覆盖核心场景中与其关键约束相关的用例；涉及外部副作用或高成本调用的 skill，应额外覆盖禁止行为、错误恢复和回归场景。

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

- 添加流程闸门（state gate）章节
- 明确"必须停止并等待"与"可以继续"的区别
- 显式解决与相关 skill 的冲突
- 为关键步骤添加可断言的输出标记
- 将规则移至其所管辖的工作流步骤附近

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
- [ ] 修补了 skill，而非仅仅弱化了测试
- [ ] GREEN 运行通过了未修改的规范
- [ ] 最终报告路径已保存
