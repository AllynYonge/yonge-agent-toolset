---
name: skill-testing
description: 当需要测试某个 Hermes skill 是否真正被真实 Hermes Agent 运行所遵循，并持续迭代目标 SKILL.md 直到行为测试通过时使用。
version: 1.1.0
author: Hermes Agent
license: MIT
metadata:
  hermes:
    tags: [skills, testing, hermes-agent, compliance]
    related_skills: [hermes-agent, hermes-agent-skill-authoring, test-driven-development, systematic-debugging]
---

# Skill 行为测试

## 概述

在隔离的 `HERMES_HOME` 中运行真实的 Hermes CLI 轮次，捕获 stdout / stderr / 会话记录，断言预期行为，修补目标 `SKILL.md`，重复执行直到测试通过。

核心循环：

1. 为目标 skill 编写 JSON 行为规范。
2. 运行测试框架 `references/dynamic_skill_behavior_harness.py`。
3. 检查失败的断言和实际模型输出。
4. 修补目标 skill（最小化修改）。
5. 重复运行直到所有断言通过。

## 使用时机

- 测试某个 skill 是否在真实 agent 行为中被遵循
- 针对"跳过流程"或"直接给最终输出"等对抗性提示加固 skill
- 在编辑后对 skill 进行回归测试
- 为任意 Hermes skill 创建可复用的行为测试

不适用于普通代码单元测试。

## 前置条件

- `hermes` CLI 已安装且可执行
- `HERMES_HOME` 环境变量已设置（默认 `~/.hermes`）
- 目标 skill 已安装在 `$HERMES_HOME/skills/` 下
- Python 3.10+（框架仅使用标准库）

验证环境：

```bash
command -v hermes && hermes --version
echo $HERMES_HOME
find "${HERMES_HOME:-$HOME/.hermes}/skills" -name 'SKILL.md' | grep '/<skill-name>/'
```

在设计断言之前，使用 `skill_view(name='<skill-name>')` 加载目标 skill 及其引用文件。

## 测试框架

位于：`references/dynamic_skill_behavior_harness.py`

功能：

- 创建临时隔离的 `HERMES_HOME`
- 从用户真实 `HERMES_HOME` 继承配置/凭据（不打印密钥）
- 复制目标 skill 及 `related_skills`
- 运行 `hermes chat -q ... --quiet --source skill-behavior-test`
- 捕获 stdout、stderr 和会话文件
- 评估 JSON 断言，输出机器可读报告

运行方式：

```bash
python3 references/dynamic_skill_behavior_harness.py \
  <spec>.json \
  --out <report>.json
```

## 行为规范格式

```json
{
  "skill": "social-media-creator",
  "timeout": 240,
  "agent_max_turns": 12,
  "toolsets": "skills,file,terminal",
  "preload_skill": true,
  "related_skills": ["runninghub"],
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

### 断言类型

| 类型 | 字段 | 含义 |
|------|--------|---------|
| `exit_code` | `value` | 最后一轮 CLI 退出码等于该值 |
| `contains` | `target`, `value` | target 包含字面文本 |
| `not_contains` | `target`, `value` | target 不包含字面文本 |
| `regex` | `target`, `pattern` | target 匹配正则（DOTALL 模式） |
| `not_regex` | `target`, `pattern` | target 不匹配正则 |
| `tool_called` | `name` | 会话中调用了该工具 |
| `tool_not_called` | `name` | 会话中未调用该工具 |

`target` 可为：`stdout`、`stderr`、`transcript` 或 `all`。

### 正则书写注意

JSON 中的正则只需一层转义。常见对照：

| 想匹配的内容 | JSON pattern 值 |
|---|---|
| 字面 `*` | `"\\*"` |
| markdown `**粗体**` | `"\\*\\*.*?\\*\\*"` |
| 可选加粗的标题 | `"\\*{0,2}我的理解[:：]\\*{0,2}"` |
| 任意空白 | `"\\s+"` |

规则：JSON 解析消耗一层 `\\` → `\`，Python `re` 再解释。不要写四重反斜杠。

### 超时处理

当某轮执行超过 `timeout` 秒时，框架会：
- 终止该轮子进程
- 记录 `exit_code: -1` 和 `[TIMEOUT]` 标记到 stderr
- 跳过后续轮次
- 正常输出报告（该 case 标记为失败）

### exit_code 判定逻辑

- 如果规范中包含显式 `exit_code` 断言：仅由断言结果决定通过与否
- 如果规范中无 `exit_code` 断言：框架隐式要求所有轮次退出码为 0

这意味着你可以测试"预期失败"场景（如 `{"type": "exit_code", "value": 1}`）。

### 多轮测试注意

`blob['exit_code']` 保存的是**最后一轮**的退出码。如需断言特定轮次的退出码，检查报告中 `cases[].turns[].exit_code` 字段。`blob['exit_codes']` 包含所有轮次退出码的逗号分隔列表。

## 迭代规则

遵循 TDD 风格：

1. **RED** — 编写一个针对行为缺口的规范，预期会失败。
2. **诊断** — 读取报告中的 stdout/stderr/断言结果；判断失败原因是规范写法、框架配置还是目标 skill。
3. **修补 skill** — 最小化修改 SKILL.md。优先使用明确的闸门、状态机措辞和冲突解决规则。
4. **GREEN** — 重新运行相同规范（不修改规范），直到通过。
5. **回归** — 保留规范文件；针对新发现的失败模式添加用例。

不要为了掩盖行为失败而修改测试。只有当断言本身过于具体时（如要求精确格式而非语义），才放宽断言。

## 测试用例设计

针对每个 skill，设计攻击其最重要约束的用例：

- **触发用例**：用户请求应触发该 skill。
- **对抗性绕过**：用户说"跳过流程 / 不用问 / 直接给最终答案"；agent 仍必须遵循强制步骤。
- **信息缺失**：用户省略必要输入；agent 应按 skill 规定的方式澄清或使用默认值。
- **工具闸门**：agent 在状态转换前必须/不得调用某个工具。
- **多轮交互**：用户确认或纠正后，agent 应进入下一步。
- **平台/风格约束**：输出必须符合平台特定格式。

优先对持久性行为断言，而非精确文字。使用 `regex` 匹配关键标记。

## 修补目标 Skill

使用 `skill_manage(action='patch')`：

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

1. **断言过于具体。** 除非格式本身是被测行为，否则不要要求精确格式。优先用 `regex` 匹配标记。
2. **正则转义错误。** JSON 中只需一层转义（`\\*` 匹配字面星号）。四重反斜杠几乎总是错的。
3. **临时目录缺少运行时配置。** 框架默认继承 `$HERMES_HOME` 的配置。如果失败，检查 `hermes config path` 和 `.env`。
4. **工具调用提取是启发式的。** `tool_called` 断言依赖日志文本中的模式匹配；必要时检查会话记录格式。
5. **成本与副作用。** 测试运行真实 LLM 调用。避免触发昂贵 API、公开发帖或破坏性命令的规范。
6. **超时不会崩溃。** 框架会捕获超时并在报告中标记失败，但后续轮次会被跳过。

## 验证清单

执行者：运行此 skill 的 agent。

- [ ] 已使用 `skill_view` 加载目标 skill
- [ ] 相关 skill/引用文件已在必要时读取
- [ ] 规范已在修补行为之前编写（RED first）
- [ ] RED 运行捕获了有意义的失败
- [ ] 修补了 skill，而非仅仅弱化了测试
- [ ] GREEN 运行通过了未修改的规范
- [ ] 最终报告路径已保存
