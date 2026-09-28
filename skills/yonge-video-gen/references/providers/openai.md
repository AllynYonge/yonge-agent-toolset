# OpenAI 兼容视频接口

用户选择 `--provider openai` 或设置 `default_model.openai` 时读这份。

## 接口形态

```
POST {base}/videos                 → { id }        （multipart/form-data）
GET  {base}/videos/{id}            → { status }
GET  {base}/videos/{id}/content    → 视频二进制    （任务对象没给 URL 时走这条）
```

`base` 默认 `https://api.openai.com/v1`，用 `OPENAI_BASE_URL` 覆盖。鉴权 `Authorization: Bearer $OPENAI_API_KEY`。默认模型 `sora-2`，用 `--model` 或 `OPENAI_VIDEO_MODEL` 切换。

与方舟不同，创建任务用 **multipart/form-data**，参考图放 `input_reference[]` 字段，不是 JSON。

## 能力边界

| 能力 | 支持 |
|------|------|
| 文生视频 | ✅ |
| 参考图 | ✅ 最多 7 张，**必须是本地文件路径** |
| 尾帧 | ❌ 用 `--last-frame` 会直接报错 |
| 参考视频 / 参考音频 | ❌ 用了会直接报错，提示改用 ark |
| 画幅 | 只有横竖两档 |

需要尾帧、参考视频或参考音频时，脚本会**自动强制走 ark**，不必手动切。

参考图不接受 `https://` 或 `asset://`——multipart 要的是文件字节。传了引用型地址会报错，需要先下载到本地。

## 画幅映射

OpenAI 侧只有固定档位，方舟的 7 种画幅会被压到两档：

| `--ratio` | 实际 `size` |
|-----------|------------|
| `9:16` `2:3` `3:4` | `720x1280`（竖版） |
| 其他枚举值 | `1280x720`（横版） |
| `adaptive` | 不传 `size`，由模型决定 |

`--resolution` 透传为 `resolution_name`（`480p`/`720p`/`1080p`）。`--duration -1` 会落成 6 秒——这个接口没有自适应时长的概念。

## 网关注意事项

`--provider openai` 只表示**鉴权与路由是 OpenAI 兼容的**，不保证上游语义一致。第三方网关常见的偏差：

- **200 + JSON 错误体伪装成视频流**。脚本会检查 `content-type`，是 json 就解析出错误抛出，否则会写出一个坏 mp4 文件。
- **`{ code, data, msg }` 信封**而非裸对象。脚本两种都拆。
- **只给 URL 不给 content 端点**，或反过来。两条路都会尝试。
- **`resolution_name` / `preset` 字段不认**。这类网关通常会忽略未知字段，但如果直接报 400，说明该网关只接受最小参数集，需要换 provider 或直连官方接口。

## 结果获取

优先从任务对象里找 URL（`video_url` / `result_url` / `url` / `content.video_url` / `content.url`），拿到就直接下载。都没有且状态是完成，才去 `/videos/{id}/content` 取二进制。

URL 下载失败不算生成失败：脚本会打印 URL，用户仍可在有效期内自取。

## 官方文档

- [OpenAI Video generation](https://platform.openai.com/docs/guides/video-generation)
