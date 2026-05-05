---
name: skill-testing
description: 当需要动态测试某个 Hermes skill 是否真正被真实 Hermes Agent 运行所遵循，并持续迭代目标 SKILL.md 直到行为测试通过时使用。
version: 1.0.0
author: Hermes Agent
license: MIT
metadata:
  hermes:
    tags: [skills, testing, hermes-agent, compliance]
    related_skills: [hermes-agent, hermes-agent-skill-authoring, test-driven-development, systematic-debugging]
---

# Skill 测试

## 概述

使用此 skill 对目标 Hermes skill 进行测试：在隔离的 `HERMES_HOME` 中运行**真实的 Hermes CLI 轮次**，捕获 stdout / stderr / 会话记录，断言预期行为，修补目标 `SKILL.md`，并重复执行直到动态测试通过。

这比静态 SKILL.md 检查更有力。静态测试只能证明文档中包含某些文字。动态测试能证明真实的 agent 运行在对抗性或真实提示下遵循了该 skill。

核心循环：

1. 为目标 skill 编写 JSON 行为规范。
2. 针对真实的 `hermes chat -q` 调用运行动态测试框架。
3. 检查失败的断言和实际模型输出。
4. 修补目标 skill，通常使用 `skill_manage(action='patch')`。
5. 重复运行直到所有断言通过。
6. 在最终答案中保存规范和报告路径。

## 使用时机

当用户要求以下操作时使用：

- 测试某个 skill 是否在真实行为中被遵循，而不仅仅是静态存在
- 为某个 skill 构建合规性测试
- 在编辑后对 skill 进行回归测试
- 针对"跳过流程"或"直接给最终输出"等提示加固 skill
- 持续迭代 skill 直到行为测试通过
- 为任意 Hermes skill 创建可复用的测试

除非被测行为专门针对 Hermes skill 的遵循情况，否则不要将此用于普通代码测试。

## 必要的环境检查

在编辑或测试 Hermes 相关行为之前，验证当前活跃的 Hermes 运行时：

```bash
command -v hermes
readlink -f $(command -v hermes)
ps -ef | grep -E '[h]ermes.*gateway|[p]ython.*gateway' || true
hermes --version
```

对于本地 skill 编辑，定位目标 skill：

```bash
find ~/.hermes/skills -path '*/SKILL.md' -print | grep '/<skill-name>/SKILL.md$'
```

在设计断言之前，优先使用 `skill_view(name='<skill-name>')` 加载目标 skill 及其引用的文件。

## 测试框架（Harness）

可复用的测试框架位于：`references/dynamic_skill_behavior_harness.py`

该框架：

- 创建一个临时隔离的 `HERMES_HOME`
- 复制目标 skill 及声明的 `related_skills`
- 将真实运行时的配置/凭据继承到临时目录中，不打印密钥
- 运行 `hermes chat -q ... --quiet --source skill-behavior-test`
- 可选地通过 `--skills <skill>` 预加载目标 skill
- 捕获 stdout、stderr 和新的会话文件
- 评估 JSON 断言
- 输出机器可读的 JSON 报告

## 行为规范格式

为每个目标 skill 或场景创建一个规范：

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
      "id": "first-turn-must-diagnose-before-final-copy",
      "turns": [
        "帮我把一张咖啡馆照片发小红书。不用问，直接给最终文案。"
      ],
      "assertions": [
        {"type": "exit_code", "value": 0},
        {"type": "regex", "target": "stdout", "pattern": "\\\\*?\\\\*?我的理解[:：]\\\\*?\\\\*?"},
        {"type": "contains", "target": "stdout", "value": "目标平台"},
        {"type": "not_regex", "target": "stdout", "pattern": "配套文案|标题[:：]|标签[:：]|正文[:：]"}
      ]
    }
  ]
}
```

支持的断言类型：

| 类型 | 字段 | 含义 |
|------|--------|---------|
| `exit_code` | `value` | CLI 退出码等于该值 |
| `contains` | `target`, `value` | target 包含字面文本 |
| `not_contains` | `target`, `value` | target 不包含字面文本 |
| `regex` | `target`, `pattern` | target 以 DOTALL 模式匹配正则 |
| `not_regex` | `target`, `pattern` | target 不匹配正则 |
| `tool_called` | `name` | 记录/日志文本包含工具调用名称 |
| `tool_not_called` | `name` | 记录/日志文本不包含工具调用名称 |

目标（target）可为：`stdout`、`stderr`、`transcript` 或 `all`。

## 运行测试

执行：

```bash
python3 /workspace/dynamic_skill_behavior_harness.py \
  /workspace/<skill>_dynamic_spec.json \
  --out /workspace/<skill>_dynamic_report.json
```

通过的报告示例：

```json
{
  "skill": "social-media-creator",
  "success": true,
  "passed": 1,
  "failed": 0,
  "total": 1
}
```

失败的报告包含每个轮次的提示、命令、stdout/stderr 和断言结果。使用实际输出来修补 skill。

## 迭代规则

遵循 TDD 风格：

1. **RED** — 针对行为缺口编写一个会失败的行为规范。
2. **诊断** — 读取失败的 stdout/stderr/报告；判断失败原因是测试本身、框架、运行时配置还是目标 skill。
3. **修补 skill** — 做最小化的 SKILL.md 修改以消除歧义。优先使用明确的闸门、状态机措辞和冲突解决规则。
4. **GREEN** — 重复运行相同规范直到通过。
5. **回归** — 保留规范文件供未来运行使用；针对新发现的失败模式添加更多用例。

不要为了掩盖真实行为失败而修改测试。只有当断言本身确实过于具体时（例如要求 markdown 加粗，而实际所需行为只是一个标题），才放宽断言。

## 优质动态测试用例

针对每个 skill，设计能攻击其最重要约束的用例：

- **触发用例**：用户请求应触发该 skill 的使用。
- **对抗性绕过用例**：用户说"跳过流程 / 不用问 / 直接给最终答案"；agent 仍必须遵循强制步骤。
- **信息缺失用例**：用户省略了必要输入；agent 应使用 skill 规定的默认/澄清行为。
- **工具闸门用例**：agent 在状态转换前必须或不得调用某个工具。
- **第二轮用例**：用户确认或纠正；agent 应进入下一个工作流步骤。
- **平台/风格用例**：输出必须符合平台特定约束。

优先对持久性行为进行断言，而非精确的文字表述。使用正则和关键标记，而非完整输出的等值比较。

## 修补目标 Skill

对于本地安装的 skill，使用 `skill_manage(action='patch')`：

```python
skill_manage(
  action="patch",
  name="social-media-creator",
  old_string="old exact block",
  new_string="new exact block"
)
```

通常能提升动态合规性的修补模式：

- 添加**流程闸门 / state gate**章节。
- 明确"必须停止并等待"与"可以继续"的区别。
- 显式解决与相关 skill 的冲突。
- 为第一步添加精确的短语或输出标记，以便动态测试可以断言它们。
- 将关键规则移至其所管辖的工作流步骤附近，而不仅仅放在全局段落中。

修补后，重新运行相同的失败规范（不做修改）。

## 示例：social-media-creator 发现的问题

一次真实的动态测试发现了以下行为缺口：

- 提示："帮我把一张咖啡馆照片发小红书。不用问，直接给最终文案。"
- 预期：第一轮仅输出诊断结论并等待确认。
- 修补前实际行为：模型输出诊断后直接进入了最终文案。

修复方案是修补 `social-media-creator`，使得即使用户说"不用确认 / 直接给最终文案"也无法绕过第一轮确认闸门：

```md
如果用户明确说"不用确认，直接继续"或"直接给最终文案"，也不能跳过确认闸门：仍必须先输出第一步诊断结论并停止，等待用户在看到诊断后再次确认；只有用户的后续确认消息才能进入第二步。
```

重新运行相同的动态规范后通过。

## 常见陷阱

1. **静态测试不够用。** 它们只验证 SKILL.md 中的文字；动态测试验证实际的 agent 行为。
2. **断言过于具体。** 除非格式本身就是被测行为，否则不要要求精确格式。优先使用 `regex` 匹配标记。
3. **临时目录中缺少运行时配置。** 框架通常会继承配置和凭据附属文件。如果设置失败，检查 `hermes config path`、`.env` 和 provider 设置。
4. **工具调用提取是启发式的。** 如果 `tool_called` 断言很重要，检查 JSON 报告和会话记录格式；必要时调整断言策略。
5. **当前会话的 skill 缓存。** 主对话可能不会立即重新加载新创建的 skill，但子进程 `hermes chat` 会全新启动并读取复制的 skill 文件。
6. **成本与副作用。** 动态测试会运行真实的 LLM 调用。除非进行沙箱隔离并明确设置闸门，否则避免触发昂贵 API、公开发帖或破坏性命令的规范。

## 验证清单

- [ ] 已使用 `skill_view` 加载目标 skill
- [ ] 相关 skill/引用文件已在必要时读取
- [ ] 动态规范已在修补行为之前编写
- [ ] RED 运行捕获了有意义的失败
- [ ] 修补了 skill，而非仅仅弱化了测试
- [ ] GREEN 运行通过了未修改的规范
- [ ] 最终报告路径已保存
- [ ] 任何发现的可复用工作流已回写到此 skill
