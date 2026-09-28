# 火山方舟 Seedance

用户选择 `--provider ark`（默认）或设置 `default_model.ark` 时读这份。

## 接口形态

方舟视频是**纯异步任务制**，没有同步返回：

```
POST {base}/contents/generations/tasks        → { id }
GET  {base}/contents/generations/tasks/{id}   → { status, content: { video_url } }
```

`base` 默认 `https://ark.cn-beijing.volces.com/api/v3`，可用 `ARK_BASE_URL` 覆盖。鉴权是 `Authorization: Bearer $ARK_API_KEY`。

`status` 取值：`queued` → `running` → `succeeded`/`completed`，或 `failed`/`cancelled`/`expired`。轮询间隔 5 秒（方舟官方建议值，调更密没有收益）。

## 请求体结构

关键差异：参数不是平铺字段，参考素材全部塞进 `content` 数组，每项用 `role` 标明用途。

```json
{
  "model": "doubao-seedance-1-0-pro-250528",
  "content": [
    { "type": "text", "text": "参考资产编号：图片1。..." },
    { "type": "image_url", "image_url": { "url": "asset://asset-xxx" }, "role": "reference_image" },
    { "type": "image_url", "image_url": { "url": "asset://asset-yyy" }, "role": "last_frame" },
    { "type": "video_url", "video_url": { "url": "data:video/mp4;base64,..." }, "role": "reference_video" },
    { "type": "audio_url", "audio_url": { "url": "data:audio/mpeg;base64,..." }, "role": "reference_audio" }
  ],
  "ratio": "16:9",
  "resolution": "720p",
  "duration": 5,
  "generate_audio": true,
  "watermark": false
}
```

`seed` 与 `camera_fixed` 只在显式指定时下发，避免覆盖模型默认策略。

提示词会被自动加上参考素材编号前缀（`参考资产编号：图片1、视频1。...`）。多素材时模型无法凭空知道"图片2"指哪张，显式编号后提示词里就能写"图片1里的人走进图片2的房间"。

## 模型

默认 `doubao-seedance-1-0-pro-250528`。用 `--model` 或 `ARK_VIDEO_MODEL` 切换。

方舟同时接受**模型 ID** 和**推理接入点 ID**（`ep-` 开头）。用了接入点的话，画幅/分辨率等限制由接入点配置决定，本地校验仍按通用规则走。

模型列表会变，需要确切的可用型号时查控制台的「模型广场 → 视频生成」，不要照抄这里的默认值。

## 画幅与分辨率

`ratio` 只认枚举值：`16:9` `9:16` `1:1` `4:3` `3:4` `21:9` `adaptive`。

传 `WxH` 时脚本会按比例就近映射到枚举值（`1920x1080` → `16:9`），不会透传原始尺寸。`adaptive` 表示由参考图/首帧的尺寸决定。

实际输出像素：

| ratio | 480p | 720p | 1080p |
|-------|------|------|-------|
| 16:9 | 864x496 | 1280x720 | 1920x1080 |
| 4:3 | 752x560 | 1112x834 | 1664x1248 |
| 1:1 | 640x640 | 960x960 | 1440x1440 |
| 3:4 | 560x752 | 834x1112 | 1248x1664 |
| 9:16 | 496x864 | 720x1280 | 1080x1920 |
| 21:9 | 992x432 | 1470x630 | 2206x946 |

## 时长

`duration` 可选 `4 5 6 8 10 12 15`，或 `-1` 让模型按内容自适应。超出范围的值会被裁剪到 4-15。

动作复杂度和时长要匹配：5 秒装不下多段动作，10 秒以上则容易出现主体漂移或动作循环。

## 参考素材限制

这些数值都是方舟的硬限制，越界会在创建任务时被服务端拒绝，脚本会**先在本地拦一次**：

| 类型 | 数量 | 单个体积 | 时长 | 其他 |
|------|------|---------|------|------|
| 参考图 | ≤ 9 | ≤ 30MB | — | 含真人人脸必须走 asset:// |
| 参考视频 | ≤ 3 | ≤ 200MB | 单条 2-15 秒，总和 ≤ 15 秒 | mp4/mov，H.264/H.265，FPS 24-60 |
| 参考音频 | ≤ 3 | ≤ 15MB | 单条 2-15 秒，总和 ≤ 15 秒 | 需搭配至少一路视觉素材 |

参考视频的尺寸约束：

- 宽高各在 300-6000 之间
- 宽高比在 0.4-2.5 之间
- 总像素在 409600（640x640）到 8295044（3326x2494）之间

本地探测依赖 `ffprobe`。装了就能在提交前拦掉时长/尺寸问题；没装则只校验体积和扩展名，剩下的交给服务端。`ffprobe` 不是硬依赖，但建议装上（`brew install ffmpeg`）——本地拦一次比等服务端回 `InvalidParameter` 省事得多。

## 首帧与尾帧

- 单张 `--ref` / `--first-frame`：方舟按首帧处理，视频从这一帧开始。
- `--last-frame`：必须同时有首帧，否则脚本直接报错。首尾帧模式下方舟会在两帧之间插值，适合做平滑过渡，不适合需要中间有复杂剧情的镜头。
- 多张 `--ref`：作为 `reference_image` 组共同影响画面，不再是严格的首帧语义。

## 参考图与 asset://

**方舟拒绝直接上传含真人人脸的参考图**，只接受素材库里已授权的 `asset://<id>`。

由于事先无法可靠判断一张图里有没有真人脸，本技能**默认把所有本地参考图都转成 asset://**。完整链路和排查见 `references/ark-asset-flow.md`。

确认素材里没有真人、且想省掉一次上传时，可以设 `YONGE_VIDEO_GEN_ARK_DIRECT_IMAGE=1` 跳过转换，直接以 Data URL 提交。真人图用了这个开关会被服务端拒，错误信息里会提示去掉它。

已经是 `asset://` 或 `https://` 的地址不会重复上传：`asset://` 原样透传，`https://` 直接拿去建素材，跳过 COS。

## 错误响应

方舟有两种响应形态，脚本都会拆：

```json
{ "id": "cgt-xxx", "status": "running" }                          // 裸对象
{ "code": 0, "data": { "id": "cgt-xxx" }, "msg": "" }             // 信封
```

常见错误：

| 现象 | 原因 |
|------|------|
| `The API key format is incorrect` | `ARK_API_KEY` 不对或没设 |
| 401 / 403 | Key 无效或没开通对应模型权限 |
| 429 | 并发或 QPS 超限，降 `--jobs` |
| `InvalidParameter` | 参数越界。本地校验已覆盖大部分情况，仍出现时对照上面的限制表逐项核 |
| 提到 `real person` / 真人 / 人脸 | 参考图含真人脸却没走 asset://，检查是否误设了 `YONGE_VIDEO_GEN_ARK_DIRECT_IMAGE` |

## 官方文档

- [视频生成 API](https://www.volcengine.com/docs/82379/1520757)
- [Seedance 模型说明](https://www.volcengine.com/docs/82379/1330310)
- [控制台](https://console.volcengine.com/ark)
