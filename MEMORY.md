- [lesson] [AGENTS.zh.md 编辑原则](memory/feedback_AGENTS_CLAUDE_editing_rules.md) — 修改原则条目时：抽象优于具象，按决策性质分类而非场景枚举
- [lesson] [重大页面设计先出线框图](memory/feedback_impeccable_wireframe_first.md) — 任何重大系统页面设计必须先 ASCII 线框图确认再实施
- [error] [Feishu/Lark 文档 generic 抓取截断](memory/error_feishu_doc_generic_truncation.md) — 飞书/Lark Wiki/Docx 的 generic 抓取可能只得目录和开头，应优先用 lark-cli `docs +fetch` 或 `lark-doc` 适配器
- [error] [lark-cli 媒体下载坑](memory/error_lark_media_download.md) — `+media-download` 可能全部 403（改用 `+media-preview`+相对路径）；自动扩展名会被文件名中已有点号误导，需按 mime 重命名
- [error] [baoyu-image-gen 的 --quality 不接受 "1k"](memory/error_baoyu_quality_1k_invalid.md) — 只放行 `normal`（1k）与 `2k` 两个预设名，传 1k 在参数解析阶段就 Invalid quality 报错

