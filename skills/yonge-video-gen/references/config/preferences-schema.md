---
name: preferences-schema
description: yonge-video-gen 的 EXTEND.md YAML 结构
---

# 偏好配置结构

## 完整结构

```yaml
---
version: 1

default_provider: null       # ark|openai|null（null = 按可用凭证自动选，ark 优先）

default_ratio: null          # "16:9"|"9:16"|"1:1"|"4:3"|"3:4"|"21:9"|"adaptive"|null（null = adaptive）

default_resolution: null     # 480p|720p|1080p|null（null = 720p）

default_duration: null       # 4|5|6|8|10|12|15|-1|null（null = 5，-1 = 模型自适应）

default_generate_audio: null # true|false|null（null = true）

default_watermark: null      # true|false|null（null = false）

default_model:
  ark: null                  # 如 "doubao-seedance-1-0-pro-250528"，或 ep- 开头的推理接入点 ID
  openai: null               # 如 "sora-2"

batch:
  max_workers: 2             # 批量并发上限。视频接口限流严，不建议超过 2
---

正文可以写任意说明，不参与解析。
```

## 存放位置

按顺序检查，命中即用：

| 路径 | 作用域 |
|------|--------|
| `<cwd>/.yonge/.yonge-skills/yonge-video-gen/EXTEND.md` | 项目 |
| `~/.yonge/.yonge-skills/yonge-video-gen/EXTEND.md` | 用户 |

## 优先级

```
CLI 参数 > EXTEND.md > 环境变量 > ~/.yonge/.yonge-skills/.env > <cwd>/.yonge/.yonge-skills/.env
```

EXTEND.md 压过环境变量：`default_model.ark` 设了值时，`ARK_VIDEO_MODEL` 不生效。

## 解析说明

只解析 front matter（`---` 之间的部分），且只认两层结构，不引 YAML 依赖。因此：

- 不支持数组、锚点、多行字符串
- 值可以带引号也可以不带；`null` 和 `~` 都表示未设置
- 行内 `#` 后的内容当注释丢掉
- 认不出的键会被忽略，不会报错

## 最小示例

只固定分辨率和画幅：

```yaml
---
version: 1
default_resolution: 1080p
default_ratio: "9:16"
---
```

竖版短视频常用配置：

```yaml
---
version: 1
default_provider: ark
default_ratio: "9:16"
default_resolution: 1080p
default_duration: 5
default_generate_audio: true
default_watermark: false
default_model:
  ark: doubao-seedance-1-0-pro-250528
batch:
  max_workers: 2
---
```
