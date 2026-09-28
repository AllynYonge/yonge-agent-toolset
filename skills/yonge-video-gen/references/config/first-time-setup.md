---
name: first-time-setup
description: yonge-video-gen 首次配置流程
---

# 首次配置

没找到 EXTEND.md 时走这个流程。**生成会被阻断到 EXTEND.md 写好为止。**

## 步骤 1：确认凭证

先检查环境里有什么，再决定问什么。按加载顺序找 `ARK_API_KEY` 与 `OPENAI_API_KEY`：

```
环境变量 → ~/.yonge/.yonge-skills/.env → <cwd>/.yonge/.yonge-skills/.env
```

- **只有一个** → 直接用它，不必问供应商。
- **两个都有** → 进步骤 2 问供应商。
- **都没有** → 告诉用户需要配置，并说明获取方式：

  | 变量 | 获取 |
  |------|------|
  | `ARK_API_KEY` | https://console.volcengine.com/ark → API Key 管理 |
  | `OPENAI_API_KEY` | https://platform.openai.com/api-keys |

  建议写入 `~/.yonge/.yonge-skills/.env`：

  ```
  ARK_API_KEY=your-key-here
  ```

  凭证是用户自己的敏感信息，让用户自行写入文件，不要代为写入，也不要在回复里回显 key 内容。

**参考图相关的额外凭证**：本地参考图需要转 asset:// 授权素材，这需要方舟 AK/SK 与腾讯 COS 凭证，与 API Key 同放 `~/.yonge/.yonge-skills/.env`（变量名 `ARK_ACCESS_KEY`/`ARK_SECRET_KEY`/`TENCENT_COS_*`）。只做文生视频时不需要。缺失时脚本会在用到时报错并说明配法，见 `references/ark-asset-flow.md`。这一步不必在首次配置时追问。

## 步骤 2：收集偏好

用 AskUserQuestion 一次问完（工具支持多问就合并，只支持单问就按下面顺序逐个问）。每项都给"暂不设置"的余地——留 null 比猜一个值更好，后者会在用户没意识到的情况下影响每次生成。

**Q1 默认供应商**（两个 key 都有时才问）

- `ark` — 火山方舟 Seedance。功能最全：首尾帧、参考视频/音频、asset:// 素材（推荐）
- `openai` — OpenAI 兼容接口。只支持文生视频与参考图

**Q2 默认画幅**

- `16:9` — 横版，常规视频、B 站、YouTube
- `9:16` — 竖版，抖音、视频号、Reels
- `1:1` — 方形，社交信息流
- `adaptive` — 由参考图尺寸决定（图生视频为主时推荐）

**Q3 默认分辨率**

- `720p` — 日常出片，速度与质量平衡（推荐）
- `1080p` — 正片交付，更慢更贵
- `480p` — 试跑验证提示词

**Q4 默认时长**

- `5` 秒 — 单一动作，最常用（推荐）
- `8` 秒 — 需要铺垫的动作
- `-1` — 由模型按内容自适应

如果工具一次只能问 4 个以内，把「是否生成音频」和「是否打水印」留作默认（生成音频、不打水印），不必追问——这两项改动成本低，用命令行参数临时覆盖即可。

## 步骤 3：写入 EXTEND.md

默认写到 `~/.yonge/.yonge-skills/yonge-video-gen/EXTEND.md`。用户明确说只对当前项目生效时，写到 `<cwd>/.yonge/.yonge-skills/yonge-video-gen/EXTEND.md`。

```yaml
---
version: 1
default_provider: ark
default_ratio: "16:9"
default_resolution: 720p
default_duration: 5
default_generate_audio: true
default_watermark: false
default_model:
  ark: null
  openai: null
batch:
  max_workers: 2
---

由 yonge-video-gen 首次配置生成。字段说明见技能的
references/config/preferences-schema.md。
```

`default_model` 留 null 表示用内置默认，模型列表会随方舟更新变动，写死反而容易过期。

## 步骤 4：确认并继续

告诉用户配置写在哪、当前生效的默认值是什么，然后继续原本的生成任务。不要让用户重新提一遍需求。

## 后续修改

改 EXTEND.md 即可，或用命令行参数临时覆盖单次生成。CLI 参数优先级最高。
