---
name: first-time-setup
description: yonge-video-gen 的首次设置流程
---

# 首次设置

## 触发情况

| 情况 | 处理 |
|------|------|
| 没有 EXTEND.md | 流程 A：完整设置 |
| 有 EXTEND.md，`default_provider` 为空，且 `ARK_API_KEY` 与 `OPENAI_API_KEY` 都存在 | 流程 B：只补问供应商 |

生成会一直被阻断，直到设置完成。不要先问视频内容或任务细节。

## 流程 A：完整设置

### A1 检查密钥

只检查变量是否存在，不读取、不显示密钥的值：

```bash
${BUN_X} {baseDir}/scripts/lib/skill-config.ts --skill yonge-video-gen
```

输出里会列出各个 .env 文件中有哪些变量名。进程环境变量里的也算，可用 `[ -n "$ARK_API_KEY" ] && echo 有` 检查。

- 只有一个供应商的密钥 → 直接用它，A2 不问供应商
- 两个都有 → A2 问供应商
- 都没有 → 告诉用户需要配置，并说明获取方式，建议写到 `~/.yonge/.yonge-skills/.env`：

  | 变量 | 获取方式 |
  |------|----------|
  | `ARK_API_KEY` | https://console.volcengine.com/ark → API Key 管理 |
  | `OPENAI_API_KEY` | https://platform.openai.com/api-keys |

  密钥是用户自己的敏感信息。让用户自己写入文件，不要代写，也不要在回复里显示密钥内容。

本地参考图需要的方舟 AK/SK 与腾讯 COS 凭证，这一步不必追问。只做文生视频时用不到；用到时脚本会报错并说明配法，见 `references/ark-asset-flow.md`。

### A2 收集偏好

用提问工具一次问完。每项都允许「暂不设置」：留空比猜一个值更好，猜的值会在用户不知情时影响每次生成。

**Q1 默认供应商**（两个密钥都有时才问）

- `ark`（推荐）— 火山方舟 Seedance。功能最全：首尾帧、参考视频/音频、asset:// 素材
- `openai` — OpenAI 兼容接口。只支持文生视频与参考图

**Q2 默认画幅**

- `16:9` — 横版，常规视频、B 站、YouTube
- `9:16` — 竖版，抖音、视频号、Reels
- `adaptive`（推荐）— 由参考图尺寸决定，图生视频为主时合适

完整可选值见 `preferences-schema.md`。

**Q3 默认分辨率**

- `720p`（推荐）— 日常出片，速度与质量平衡
- `1080p` — 正片交付，更慢更贵
- `480p` — 试跑验证提示词

**Q4 保存位置**（放在最后一问）

- 用户级（推荐）— `~/.yonge/.yonge-skills/.yonge-video-gen/EXTEND.md`，所有项目共用
- 项目级 — `<cwd>/.yonge/.yonge-skills/.yonge-video-gen/EXTEND.md`，只对当前项目生效

时长、音频、水印、模型不在首次设置里问，使用默认值（5 秒、生成音频、不打水印、内置默认模型），在 A4 里告诉用户。它们改起来成本低，用命令行参数临时覆盖或之后改 EXTEND.md 都可以。模型列表会随方舟更新而变化，写死反而容易过期。

### A3 写入 EXTEND.md

只写用户回答过的字段，没回答的不写。这样以后调整默认值时，用户能跟着更新：

```yaml
---
version: 1
default_provider: ark
default_ratio: "9:16"
default_resolution: 720p
---

由 yonge-video-gen 首次设置生成。字段说明见技能的 references/config/preferences-schema.md。
```

写完后运行 A1 的检查命令，确认能被正确读取。

### A4 确认并继续

告诉用户：配置写在哪个文件、现在生效的值是什么（包括没问、使用默认值的那几项）、以后怎么改（改 EXTEND.md，或用 CLI 参数临时覆盖）。然后继续原来的生成任务，不要让用户把需求重新说一遍。

## 流程 B：只补问供应商

1. 只问 A2 的 Q1
2. 读取现有 EXTEND.md，只改 `default_provider` 这一个字段，其它内容（包括注释和正文）保持原样
3. 运行检查命令确认，然后继续原任务
