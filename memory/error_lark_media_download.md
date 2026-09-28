---
type: error
date: 2026-09-03
---

# lark-cli 文档媒体下载：+media-download 403、输出路径与扩展名坑

## What did not work

- `lark-cli docs +media-download` 对 WayToAGI 飞书 Wiki 文档的全部 136 个图片/视频/音频 token 均返回 HTTP 403（`docs +fetch` 正文可读，权限正常）。
- `drive +download` 对 WayToAGI 的 Drive file token（GIF 素材）同样 403；`feishu.cn/file/<token>` 短链匿名 curl 也是 404，但登录态下文件存在。
- `--output` 使用绝对路径会被拒绝：`unsafe output path: --output must be a relative path`。
- `+media-preview` 自动补扩展名的逻辑：若输出文件名中已含点（如 `name.mp4__token`），会把 `.mp4__token` 当作已有扩展名而不再追加，导致下载的文件没有真实扩展名，Obsidian 无法播放。

## What worked

- 用 `docs +media-preview --token <t> --output <相对路径>`（`cwd` 设为目标 assets 目录）代替 `+media-download`，同一批 token 全部成功；且对 Drive **file token**（GIF 等）同样有效，输出名不含点时自动扩展名可靠。用 `drive +inspect --url <短链>` 反查文件标题/类型/真实扩展名。
- 扩展名修复：从 `+fetch` 返回内容的 `<img>`/`<source>` 标签 `mime` 属性建立 token→扩展名映射，批量重命名补上真实扩展名。
- 文件名建议用 `{原始name}__{token}.{ext}` 格式：保证唯一、可反查 token、可按后缀筛选。

## Next time

飞书文档批量下载素材时直接用 `+media-preview` + 相对路径；下载后校验文件是否带真实扩展名，没有则按 mime 映射重命名。
