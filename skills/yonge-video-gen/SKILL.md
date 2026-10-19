---
name: yonge-video-gen
description: 火山方舟 Seedance 与 OpenAI 兼容接口的 AI 视频生成。支持文生视频、首帧/尾帧图生视频、参考图（自动转 asset:// 授权素材，含真人人脸可用）、参考视频、参考音频、画幅/分辨率/时长控制、批量分镜生成与断点续查。当用户要求生成视频、出片、跑分镜、图生视频、首尾帧动画、让图片动起来、给关键帧配运镜、批量生成短视频素材时使用；用户提到 Seedance、方舟视频、豆包视频、doubao-seedance、Sora 时也走本技能。
version: 1.0.0
metadata:
  openclaw:
    requires:
      anyBins:
        - bun
        - npx
---

# 视频生成（火山方舟 Seedance / OpenAI 兼容）

官方 API 直连的视频生成。两条通道：

- **ark**（默认）：火山方舟 Seedance。文生视频、图生视频、首尾帧、参考视频/音频、asset:// 授权素材，功能最全。
- **openai**：OpenAI 兼容 `/videos` 任务接口（Sora 系及各类网关）。只支持文生视频与参考图。

## 用户输入工具

需要向用户提问时，按优先级选择：

1. **优先用运行时自带的用户输入工具** — 如 `AskUserQuestion`、`ask_user_question`、`request_user_input`、`clarify` 等。
2. **兜底**：没有这类工具时，输出编号列表，让用户回复编号。
3. **合并提问**：工具支持一次多问就合并成一次调用，只支持单问就按优先级逐个问。

## 脚本目录

`{baseDir}` = 本 SKILL.md 所在目录。下文 `scripts/...` 均相对于它。主脚本：`{baseDir}/scripts/main.ts`。

`${BUN_X}` 解析顺序：优先 `bun`；否则 `npx -y bun`；都没有则提示 `brew install oven-sh/bun/bun`。

## 视频生成的三个前提

在动手之前先确认这三件事，它们决定了后面所有参数怎么填：

1. **异步任务，分钟级**。一条 5 秒 720p 视频通常 1-3 分钟，1080p 更久。脚本会自动轮询，但**任务 ID 一定要留住**：脚本创建成功后立刻打印 `taskId`，中断了用 `--task-id <id> --video out.mp4` 续查，不必重新付费生成。
2. **视频比图片贵得多，也慢得多**。不要用"多生几条挑一条"的图片思路跑视频。先用 480p 短时长验证提示词与运镜，确认对了再升到目标分辨率。默认并发只有 2，这是刻意的。
3. **含真人人脸的参考图必须走 asset://**。方舟直接拒绝上传含真人脸的图片。本技能默认把所有本地参考图自动转成 asset:// 授权素材（本地图 → 腾讯 COS → 方舟素材库 → 轮询 Active），你不需要手动做任何事。

## 步骤 0：加载偏好配置 ⛔ 阻断

生成前必须完成。用 `--task-id` 续查已创建的任务不受此限制。

按顺序检查，命中第一个就停，不合并：

| 路径 | 作用域 |
|------|--------|
| `<cwd>/.yonge/.yonge-skills/.yonge-video-gen/EXTEND.md` | 项目 |
| `~/.yonge/.yonge-skills/.yonge-video-gen/EXTEND.md` | 用户 |

- **找到** → 加载并应用。`default_provider` 为空且两个供应商的密钥都存在时，只补问供应商。
- **没找到** → 走首次设置（`references/config/first-time-setup.md`），收集供应商 + 画幅 + 分辨率 + 时长 + 保存位置，写入 EXTEND.md 后继续原任务。

**EXTEND.md 字段**：默认供应商、默认画幅、默认分辨率、默认时长、是否生成音频、是否打水印、各供应商默认模型、批量并发上限。结构见 `references/config/preferences-schema.md`。

检查配置能否被正确读取（只列变量名，不显示密钥）：`${BUN_X} {baseDir}/scripts/lib/skill-config.ts --skill yonge-video-gen`

## 凭证

`ARK_API_KEY` 是方舟视频生成的唯一必需项，从 https://console.volcengine.com/ark 获取。密钥只放 `~/.yonge/.yonge-skills/.env`（项目级 `<cwd>/.yonge/.yonge-skills/.env` 可覆盖），不写进 EXTEND.md，写了会报错。加载顺序：

```
CLI 参数 > EXTEND.md > 环境变量 > <cwd>/.yonge/.yonge-skills/.env > ~/.yonge/.yonge-skills/.env > 内置默认值
```

方舟 AK/SK 与腾讯 COS 凭证（asset:// 素材流程用）也放在同一份 `.env` 里，与 API Key 集中一处维护。详见 `references/ark-asset-flow.md`。

## 用法

```bash
# 文生视频
${BUN_X} {baseDir}/scripts/main.ts --prompt "镜头缓慢推近，晨雾中的山谷" --video out.mp4

# 首帧图生视频（最常用）
${BUN_X} {baseDir}/scripts/main.ts --prompt "人物转身走向窗边" --video out.mp4 --ref keyframe.png

# 首尾帧（仅方舟）
${BUN_X} {baseDir}/scripts/main.ts --prompt "平滑过渡" --video out.mp4 --first-frame a.png --last-frame b.png

# 竖版 1080p 8 秒，不要音频
${BUN_X} {baseDir}/scripts/main.ts -p "城市夜景航拍" --video out.mp4 --ratio 9:16 --resolution 1080p --duration 8 --no-audio

# 提示词从文件读（配合 commands/video 下的分镜提示词产物）
${BUN_X} {baseDir}/scripts/main.ts --promptfiles shots/s01.md --video out/s01.mp4 --ref kf/s01.png

# 参考视频（运镜/风格参考，2-15 秒，仅方舟）
${BUN_X} {baseDir}/scripts/main.ts -p "沿用视频1的运镜节奏" --video out.mp4 --ref-video ref.mp4

# 只创建任务不等待（长任务想先释放终端）
${BUN_X} {baseDir}/scripts/main.ts -p "..." --video out.mp4 --no-wait

# 续查已创建的任务
${BUN_X} {baseDir}/scripts/main.ts --task-id cgt-2026xxxx --video out.mp4

# 批量分镜
${BUN_X} {baseDir}/scripts/main.ts --batchfile batch.json --jobs 2
```

更多示例见 `references/usage-examples.md`。

## 参数

| 参数 | 说明 |
|------|------|
| `--prompt <text>`, `-p` | 提示词 |
| `--promptfiles <files...>` | 从文件读提示词（多文件拼接） |
| `--video <path>`, `-o` | 输出路径（单任务必填）。扩展名非 mp4/mov 时自动补 `.mp4` |
| `--batchfile <path>` | 批量任务 JSON |
| `--jobs <count>` | 批量并发（默认 2） |
| `--provider ark\|openai` | 指定供应商（默认自动，ark 优先） |
| `--model <id>`, `-m` | 模型 ID |
| `--ratio <r>` | 画幅 `16:9\|9:16\|1:1\|4:3\|3:4\|21:9\|adaptive`，也接受 `WxH`（就近映射到枚举） |
| `--resolution <r>` | `480p\|720p\|1080p`（默认 720p） |
| `--duration <n>` | `4\|5\|6\|8\|10\|12\|15` 秒，或 `-1` 由模型自适应（默认 5） |
| `--ref <files...>` | 参考图/首帧。本地路径、`https://` 或 `asset://`。方舟最多 9 张，OpenAI 最多 7 张 |
| `--first-frame <file>` | 首帧图（等价于单张 `--ref`） |
| `--last-frame <file>` | 尾帧图（仅方舟，需同时有首帧） |
| `--ref-video <files...>` | 参考视频，mp4/mov，单条 2-15 秒（仅方舟，最多 3 条） |
| `--ref-audio <files...>` | 参考音频，单条 2-15 秒（仅方舟，最多 3 条，需搭配视觉素材） |
| `--audio` / `--no-audio` | 是否生成音频（默认生成） |
| `--watermark` / `--no-watermark` | 水印（默认不打） |
| `--seed <n>` | 随机种子。同种子 + 同参数可复现，用于微调提示词时控制变量 |
| `--camera-fixed` | 固定镜头，抑制运镜 |
| `--no-wait` | 只创建任务、打印 taskId 后退出 |
| `--task-id <id>` | 轮询已存在的任务 |
| `--json` | JSON 输出 |

## 模型解析

优先级（高 → 低）：

1. CLI `--model <id>`
2. EXTEND.md `default_model.[provider]`
3. 环境变量 `ARK_VIDEO_MODEL` / `OPENAI_VIDEO_MODEL`
4. 内置默认（ark: `doubao-seedance-1-0-pro-250528`；openai: `sora-2`）

**每次生成前脚本会打印**供应商 / 模型 / 画幅 / 分辨率（含实际像素）/ 时长 / 音频开关，便于确认参数没跑偏。

## 供应商能力对照

| 能力 | ark（方舟 Seedance） | openai 兼容 |
|------|---------------------|-------------|
| 文生视频 | ✅ | ✅ |
| 参考图 / 首帧 | ✅ 最多 9 张，自动转 asset:// | ✅ 最多 7 张，仅本地文件 |
| 尾帧 | ✅ | ❌ |
| 参考视频 | ✅ 最多 3 条 | ❌ |
| 参考音频 | ✅ 最多 3 条 | ❌ |
| 生成音频 | ✅ | 由模型决定 |
| 画幅 | 7 种枚举 | 横/竖两档 |
| 时长 | 4-15 秒 + 自适应 | 秒数透传 |

用到参考视频、参考音频或尾帧时，**脚本会强制走 ark**，不需要显式加 `--provider`。

## 参考图与同一性保持

图生视频最常见的失败不是画面差，而是**主体在动起来之后变了人**。写提示词时：

- 明确说参考图里的人/物就是视频主体，不要重新设计或另造一个相似的。
- 只描述**动作、运镜、场景变化、光线变化**，不要复述人物长相。写"照片里的女性抬头看向窗外"，不要写"一位年轻东亚女性，鹅蛋脸，大眼睛，抬头看向窗外"——后者会让模型按描述重新合成一个人。
- 多张参考图时说明它们是同一主体的不同角度，共同定义同一性。
- 不要拿上一条生成结果的截帧当下一条的参考图，除非用户明确要求。漂移会累积。

## 提示词写法

视频提示词的信息结构与图片不同，缺了运镜就等于把控制权交给模型：

```
[主体与动作] + [运镜] + [场景与光线] + [节奏/氛围]
```

- **运镜词要具体**：推、拉、摇、移、跟、升降、环绕、手持轻晃；配上速度（缓慢、匀速、快速）。只写"镜头移动"等于没写。
- **一条视频只讲一个动作**。5 秒装不下"起身—走过去—开门—回头"，拆成多条分镜。
- **时长与动作量要匹配**。复杂动作给 8-10 秒，单一动作 5 秒就够，`--duration -1` 让模型自适应也是个稳妥选择。
- **别写转场**。"切到下一个镜头"这类词会让模型在一条视频里硬切，通常是废片。转场交给后期。
- 已有 `commands/video/` 下的分镜与视频提示词专家产物时，直接用 `--promptfiles` 喂进来，不要二次改写。

## 生成模式

**默认串行**。批量文件里有 2 个以上任务时自动并发，默认 2 路。

| 场景 | 选择 | 原因 |
|------|------|------|
| 单条视频，或先验证提示词 | 单任务 | 便于快速迭代 |
| 分镜提示词已定稿，要成批出片 | `--batchfile` | 复用提示词，统一限流与重试 |
| 每条还需要独立构思提示词 | 先写提示词文件，再批量 | 创作与执行分开，出错好定位 |

**并发别调高**。视频接口的限流比图片严，方舟 429 之后整批都会拖慢。默认 2 路是权衡后的值，除非确认账号配额宽松。

## 批量文件格式

```json
{
  "jobs": 2,
  "tasks": [
    {
      "id": "s01",
      "promptFiles": ["shots/s01.md"],
      "video": "out/s01.mp4",
      "ref": ["kf/s01.png"],
      "ratio": "16:9",
      "resolution": "720p",
      "duration": 5
    },
    {
      "id": "s02",
      "prompt": "镜头横移，人物走出画面",
      "video": "out/s02.mp4",
      "firstFrame": "kf/s02.png",
      "lastFrame": "kf/s02-end.png",
      "duration": 8
    }
  ]
}
```

任务内的相对路径按**批量文件所在目录**解析；`https://`、`asset://`、`data:` 原样保留。任务级参数覆盖全局，未给则继承 CLI/EXTEND.md。

## 出片流程建议

1. **先定分镜与关键帧**。关键帧用 `baoyu-image-gen` 出图，视频只负责让它动起来。图生视频的可控性远高于文生视频。
2. **480p 试跑**。用目标提示词跑 480p / 5 秒，确认主体没变形、运镜方向对了。这一步的成本只有正片的零头。
3. **升分辨率出正片**。参数不动，只改 `--resolution`，避免引入新变量。
4. **批量补齐剩余分镜**。提示词定稿后走 `--batchfile`。

## 错误处理

- 缺 `ARK_API_KEY` / `OPENAI_API_KEY` → 报错并给出配置位置
- 参数类错误（画幅、时长、素材数量、格式）→ **本地先拦**，不消耗额度。方舟服务端对这类错误通常只回 `InvalidParameter`，排查成本高得多
- 网络 / 429 / 5xx / 超时 → 自动重试 1 次；参数类错误不重试
- 轮询超时（默认 10 分钟）→ 按失败上报，但**保留 taskId**，用 `--task-id` 续查
- 视频已生成但下载失败 → 打印带时效的 URL，不算失败
- 含真人人脸被拒 → 错误信息会指出要走 asset://（默认已自动处理）

## 参考文档

| 文件 | 内容 |
|------|------|
| `references/providers/ark.md` | 方舟 Seedance 模型、画幅像素表、素材限制、参数细节 |
| `references/providers/openai.md` | OpenAI 兼容接口的能力边界与网关注意事项 |
| `references/ark-asset-flow.md` | asset:// 素材流程全链路、凭证配置、失败排查 |
| `references/prompt-guide.md` | 视频提示词结构、运镜词表、常见坑 |
| `references/usage-examples.md` | 扩展 CLI 示例与批量场景 |
| `references/config/preferences-schema.md` | EXTEND.md 结构 |
| `references/config/first-time-setup.md` | 首次配置流程 |

## 扩展

通过 EXTEND.md 自定义默认值，路径与结构见步骤 0。
