---
name: preferences-schema
description: yonge-video-gen 的 EXTEND.md 字段说明
---

# 偏好配置字段

存放位置、查找顺序与优先级见 SKILL.md 步骤 0。

## 字段表

| 字段 | 类型 | 默认值 | 等价环境变量 | 说明 |
|------|------|--------|--------------|------|
| `version` | 整数 | `1` | — | 配置格式版本。高于技能支持的版本时报错 |
| `default_provider` | 字符串 \| null | 按可用凭证自动选，ark 优先 | — | `ark` \| `openai`。写其它值会报错 |
| `default_ratio` | 字符串 \| null | `adaptive` | — | `16:9` \| `9:16` \| `1:1` \| `4:3` \| `3:4` \| `21:9` \| `adaptive`。含冒号，建议加引号 |
| `default_resolution` | 字符串 \| null | `720p` | — | `480p` \| `720p` \| `1080p` |
| `default_duration` | 整数 \| null | `5` | — | `4` \| `5` \| `6` \| `8` \| `10` \| `12` \| `15`，`-1` 表示由模型自适应 |
| `default_generate_audio` | 布尔 \| null | `true` | — | 是否生成音频 |
| `default_watermark` | 布尔 \| null | `false` | — | 是否打水印 |
| `default_model.ark` | 字符串 \| null | `doubao-seedance-1-0-pro-250528` | `ARK_VIDEO_MODEL` | 方舟模型 ID，或 `ep-` 开头的推理接入点 ID |
| `default_model.openai` | 字符串 \| null | `sora-2` | `OPENAI_VIDEO_MODEL` | OpenAI 兼容接口的模型 ID |
| `batch.max_workers` | 整数 \| null | `3` | `YONGE_VIDEO_GEN_MAX_WORKERS` | 批量并发上限。实际并发还会受每个供应商的上限 2 限制 |

`null` 表示未设置，使用默认值列的值。

EXTEND.md 覆盖环境变量：`default_model.ark` 写了 A，环境变量 `ARK_VIDEO_MODEL` 写了 B，最终用 A。

## 最小示例

最少写这些就能运行：

```yaml
---
version: 1
---
```

## 常见覆盖示例

竖版短视频，固定 1080p：

```yaml
---
version: 1
default_ratio: "9:16"
default_resolution: 1080p
---
```

## 密钥

密钥不写进 EXTEND.md。写在 `~/.yonge/.yonge-skills/.env`，项目级 `<cwd>/.yonge/.yonge-skills/.env` 可覆盖：

| 变量 | 用途 | 获取方式 |
|------|------|----------|
| `ARK_API_KEY` | 方舟视频生成（必需） | https://console.volcengine.com/ark → API Key 管理 |
| `OPENAI_API_KEY` | OpenAI 兼容接口 | https://platform.openai.com/api-keys |
| `ARK_ACCESS_KEY` / `ARK_SECRET_KEY` | asset:// 素材流程 | 见 `references/ark-asset-flow.md` |
| `TENCENT_COS_*` | asset:// 素材流程 | 见 `references/ark-asset-flow.md` |

## 写法限制

解析器只支持 YAML 的一个子集。以下写法会直接报错，不会被静默忽略：

- flow 映射（`{a: 1}`）、多行字符串（`|` / `>`）、锚点与别名
- Tab 缩进、同层缩进不一致、重复的键
- 密钥类字段（`*_api_key`、`*_secret`、`*_token`、`*_password` 等）
- 字段类型不对（如 `default_duration: long`、`default_watermark: yes`）
- 列表用逐行 `- item`，或行内 `[a, b]`；空列表写 `[]`。列表项写 `- key: value` 会被当成单键映射，需要字面冒号时加引号

其它说明：

- 值可以带引号也可以不带；`null`、`~`、留空都表示未设置
- 未加引号的值里，空格后的 `#` 起算注释
- 未知字段会给出警告并被忽略
- front matter 之后的正文不参与解析
