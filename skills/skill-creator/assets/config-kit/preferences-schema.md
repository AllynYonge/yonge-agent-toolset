---
name: preferences-schema
description: {{skill}} 的 EXTEND.md 字段说明
---

<!--
  模板：目标技能的 references/config/preferences-schema.md。
  复制后替换 {{...}} 占位，删除本注释。
  规则：
  - 默认值只出现在字段表的「默认值」列，示例里不要写全部默认值
  - 可选值清单只在本表写一次，其它文档写「见 preferences-schema.md」
  - 按后端区分的字段用映射（default_model.<后端>），不要写成 <后端>_model
  - 本表不出现任何密钥字段；密钥只在「密钥」一节列变量名
-->

# 偏好配置字段

## 字段表

| 字段 | 类型 | 默认值 | 等价环境变量 | 说明 |
|------|------|--------|--------------|------|
| `version` | 整数 | `1` | — | 配置格式版本。高于技能支持的版本时报错 |
| `default_{{field}}` | 字符串 \| null | `{{default}}` | `{{ENV_NAME}}` | {{说明，可选值写在这里}} |
| `default_model.<后端>` | 字符串 \| null | 内置默认 | `{{PROVIDER}}_{{SKILL}}_MODEL` | 各后端默认模型 |
| `batch.max_workers` | 整数 \| null | `{{n}}` | `{{SKILL_ENV}}_MAX_WORKERS` | 批量并发上限 |

`null` 表示未设置，使用默认值列的值。

## 最小示例

最少写这些就能运行：

```yaml
---
version: 1
---
```

## 常见覆盖示例

只写真正需要覆盖的字段：

```yaml
---
version: 1
default_{{field}}: {{value}}
---
```

## 密钥

密钥不写进 EXTEND.md。写在 `~/.yonge/.yonge-skills/.env`，项目级 `<cwd>/.yonge/.yonge-skills/.env` 可覆盖：

| 变量 | 用途 | 获取方式 |
|------|------|----------|
| `{{PREFIX}}_API_KEY` | {{用途}} | {{获取地址}} |

多账号时用带别名的变量名：`{{PREFIX}}_<别名>_<KEY>`，别名转大写、连字符转下划线。找不到时回退到不带别名的 `{{PREFIX}}_<KEY>`。

## 写法限制

解析器只支持 YAML 的一个子集。以下写法会直接报错，不会被静默忽略：

- flow 映射（`{a: 1}`）、多行字符串（`|` / `>`）、锚点与别名
- Tab 缩进、同层缩进不一致、重复的键
- 密钥类字段（`*_api_key`、`*_secret`、`*_token`、`*_password` 等）

其它说明：

- 列表用逐行 `- item`，或行内 `[a, b]`；空列表写 `[]`。列表项写 `- key: value` 会被当成单键映射，需要字面冒号时加引号

- 值可以带引号也可以不带；`null`、`~`、留空都表示未设置
- 未加引号的值里，空格后的 `#` 起算注释。值以 `#` 开头（如颜色 `#0F4C81`）时必须加引号
- 未知字段会给出警告并被忽略
- front matter 之后的正文不参与解析
