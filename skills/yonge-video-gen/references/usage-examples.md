# 扩展用法示例

`${BUN_X}` = `bun`，或 `npx -y bun`。`{baseDir}` = SKILL.md 所在目录。

## 基础

```bash
# 文生视频，默认 720p / 5 秒 / 自适应画幅
${BUN_X} {baseDir}/scripts/main.ts --prompt "镜头缓慢推近，晨雾中的山谷" --video out.mp4

# 位置参数也当提示词用
${BUN_X} {baseDir}/scripts/main.ts "海浪拍打礁石，镜头固定" --video out.mp4

# 提示词从文件读（多文件按顺序拼接）
${BUN_X} {baseDir}/scripts/main.ts --promptfiles style.md shot-01.md --video out.mp4
```

## 图生视频

```bash
# 首帧图（最常用）
${BUN_X} {baseDir}/scripts/main.ts -p "人物转身走向窗边，镜头缓慢右移跟随" --video out.mp4 --ref keyframe.png

# --first-frame 等价写法，语义更明确
${BUN_X} {baseDir}/scripts/main.ts -p "..." --video out.mp4 --first-frame kf.png

# 首尾帧插值（仅方舟）
${BUN_X} {baseDir}/scripts/main.ts -p "平滑过渡" --video out.mp4 --first-frame a.png --last-frame b.png

# 多张参考图定义同一主体（最多 9 张）
${BUN_X} {baseDir}/scripts/main.ts -p "图片1到图片3是同一个人的不同角度。该人物在街边回头" \
  --video out.mp4 --ref p1.png p2.png p3.png

# 直接用已有的 asset:// 授权素材，跳过上传
${BUN_X} {baseDir}/scripts/main.ts -p "..." --video out.mp4 --ref asset://asset-20260904115107-wrttv

# 用公网图片，跳过 COS 上传（仍会建 asset）
${BUN_X} {baseDir}/scripts/main.ts -p "..." --video out.mp4 --ref https://example.com/kf.png
```

## 画幅 / 分辨率 / 时长

```bash
# 竖版 1080p 8 秒，不要音频
${BUN_X} {baseDir}/scripts/main.ts -p "城市夜景航拍" --video out.mp4 \
  --ratio 9:16 --resolution 1080p --duration 8 --no-audio

# 480p 试跑，验证提示词与运镜
${BUN_X} {baseDir}/scripts/main.ts -p "..." --video test.mp4 --resolution 480p --duration 5

# 传 WxH 会就近映射到枚举画幅（1920x1080 → 16:9）
${BUN_X} {baseDir}/scripts/main.ts -p "..." --video out.mp4 --ratio 1920x1080

# 时长交给模型自适应
${BUN_X} {baseDir}/scripts/main.ts -p "..." --video out.mp4 --duration -1

# 固定镜头 + 固定 seed，用于对照实验
${BUN_X} {baseDir}/scripts/main.ts -p "..." --video out.mp4 --camera-fixed --seed 42
```

## 参考视频 / 音频（仅方舟）

```bash
# 参考运镜节奏
${BUN_X} {baseDir}/scripts/main.ts -p "沿用视频1的运镜节奏，主体换成图片1里的人" \
  --video out.mp4 --ref-video ref.mp4 --ref p.png

# 参考音频需要搭配视觉素材
${BUN_X} {baseDir}/scripts/main.ts -p "画面节奏跟随音频1" \
  --video out.mp4 --ref p.png --ref-audio bgm.mp3

# 用了 ref-video/ref-audio 会自动强制走 ark，不用加 --provider
```

## 长任务与续查

```bash
# 只创建任务，打印 taskId 后退出
${BUN_X} {baseDir}/scripts/main.ts -p "..." --video out.mp4 --no-wait

# 续查并落盘
${BUN_X} {baseDir}/scripts/main.ts --task-id cgt-20260904xxxx --video out.mp4

# 只想看结果 URL，不落盘
${BUN_X} {baseDir}/scripts/main.ts --task-id cgt-20260904xxxx
```

轮询超时（默认 10 分钟）后任务仍会在服务端继续生成，taskId 会打印在失败信息里，用 `--task-id` 续查即可，不必重新付费。

## 批量分镜

```bash
${BUN_X} {baseDir}/scripts/main.ts --batchfile batch.json --jobs 2
```

`batch.json`：

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
      "duration": 8,
      "generateAudio": false
    },
    {
      "id": "s03",
      "promptFiles": ["shots/s03.md"],
      "video": "out/s03.mp4",
      "ref": ["asset://asset-xxx"],
      "seed": 1234
    }
  ]
}
```

- 相对路径按**批量文件所在目录**解析；`https://`、`asset://`、`data:` 原样保留
- 任务级参数覆盖 CLI/EXTEND.md，未给则继承
- 输出路径扩展名非 mp4/mov 时自动补 `.mp4`
- `--jobs` 不建议超过 2，视频接口限流比图片严

## JSON 输出

```bash
${BUN_X} {baseDir}/scripts/main.ts --batchfile batch.json --json
```

```json
{
  "total": 2,
  "succeeded": 1,
  "failed": 1,
  "results": [
    { "id": "s01", "provider": "ark", "model": "doubao-seedance-1-0-pro-250528",
      "outputPath": "out/s01.mp4", "taskId": "cgt-xxx", "url": "https://...",
      "success": true, "attempts": 1, "error": null },
    { "id": "s02", "provider": "ark", "model": "doubao-seedance-1-0-pro-250528",
      "outputPath": null, "taskId": "cgt-yyy", "url": null,
      "success": false, "attempts": 2, "error": "轮询超时（10 分钟）。任务可能仍在生成，用 --task-id cgt-yyy 续查" }
  ]
}
```

有任务失败时进程退出码为 1。

## 典型出片流程

```bash
# 1. 关键帧交给 baoyu-image-gen 出图
#    视频只负责让它动起来，图生视频可控性远高于文生视频

# 2. 480p 试跑，固定 seed
${BUN_X} {baseDir}/scripts/main.ts --promptfiles shots/s01.md --video test/s01.mp4 \
  --ref kf/s01.png --resolution 480p --seed 42

# 3. 确认后升分辨率出正片，其他参数不动
${BUN_X} {baseDir}/scripts/main.ts --promptfiles shots/s01.md --video out/s01.mp4 \
  --ref kf/s01.png --resolution 1080p --seed 42

# 4. 提示词定稿后批量补齐剩余分镜
${BUN_X} {baseDir}/scripts/main.ts --batchfile batch.json --jobs 2
```
