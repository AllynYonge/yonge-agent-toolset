---
name: first-time-setup
description: {{skill}} 的首次设置流程
---

<!--
  模板：目标技能的 references/config/first-time-setup.md。
  复制后替换 {{...}} 占位，删除本注释。
  规则：
  - 问题一次问完；工具一次最多 4 问时，按重要性取前 4 个，其余用默认值并在确认里说明
  - 每个问题的选项写在本文件，可选值的完整清单只引用 preferences-schema.md
  - 每个问题都给「暂不设置」的余地：留 null 比猜一个值更好
-->

# 首次设置

## 触发情况

| 情况 | 处理 |
|------|------|
| 没有 EXTEND.md | 流程 A：完整设置 |
| 有 EXTEND.md，但必需字段 `{{required_field}}` 为空 | 流程 B：只补问该字段 |

{{gated_actions}}会一直被阻断，直到设置完成。不要先问内容或任务细节。

## 流程 A：完整设置

### A1 检查密钥

只检查变量是否存在，不读取、不显示密钥的值：

```bash
bun {baseDir}/scripts/lib/skill-config.ts --skill {{skill}}
```

输出里会列出各个 .env 文件中有哪些变量名。

- 必需的密钥都在 → 进入 A2
- 有缺失 → 告诉用户缺哪个变量、去哪里获取、写到 `~/.yonge/.yonge-skills/.env`。让用户自己写入文件，不要代写，也不要在回复里显示密钥内容

| 变量 | 获取方式 |
|------|----------|
| `{{PREFIX}}_API_KEY` | {{获取地址}} |

### A2 收集偏好

用提问工具一次问完：

**Q1 {{问题}}**

- `{{选项 1}}`（推荐）— {{说明}}
- `{{选项 2}}` — {{说明}}

**Q{{n}} 保存位置**（放在最后一问）

- 用户级（推荐）— `~/.yonge/.yonge-skills/{{skill}}/EXTEND.md`，所有项目共用
- 项目级 — `<cwd>/.yonge/.yonge-skills/{{skill}}/EXTEND.md`，只对当前项目生效

### A3 写入 EXTEND.md

只写用户回答过的字段，没回答的不写（这样以后调整默认值时，用户能跟着更新）：

```yaml
---
version: 1
{{answered_field}}: {{value}}
---

由 {{skill}} 首次设置生成。字段说明见技能的 references/config/preferences-schema.md。
```

写完后运行检查命令确认能被正确读取：

```bash
bun {baseDir}/scripts/lib/skill-config.ts --skill {{skill}}
```

### A4 确认并继续

告诉用户：配置写在哪个文件、现在生效的值是什么、以后怎么改（改 EXTEND.md，或用 CLI 参数临时覆盖）。然后继续原来的任务，不要让用户把需求重新说一遍。

## 流程 B：只补问缺失字段

1. 只问 `{{required_field}}` 这一项，选项同 A2 对应问题
2. 读取现有 EXTEND.md，只改这一个字段，其它内容（包括注释和正文）保持原样
3. 运行检查命令确认，然后继续原任务
