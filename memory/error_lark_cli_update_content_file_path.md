---
type: error
date: 2026-06-11
---

# lark-cli docs update content file path

## 什么不起作用

`lark-cli docs +update --content "@/absolute/path/file.md"` 会被拒绝，即使文件存在。CLI 报错说明 `@file` 必须是当前目录内的相对路径。

## 什么起作用了

在项目根目录作为 `workdir` 执行命令，并传入相对路径，例如：

```bash
lark-cli docs +update --api-version v2 --doc <doc_token> --command overwrite --doc-format markdown --content "@path/from/cwd/file.md"
```

## 下次注意

使用 `docs +update` 写入本地文件内容时，先确认 `workdir`，再构造 `@` 后面的相对路径；不要传绝对路径。
