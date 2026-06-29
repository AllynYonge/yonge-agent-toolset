---
type: error
date: 2026-06-20
---

# Codex CLI image backend can fail or timeout for XHS card generation

## 什么不起作用

使用 `baoyu-xhs-images` 生成多张小红书知识卡时，`codex-cli` 图片后端可能出现：

- `no_image_gen_tool_use`：Codex 子进程没有调用图片生成工具
- `timeout`：`codex exec` 超过 300000ms

这会导致封面图都无法稳定产出，后续锚点链也无法继续。

## 什么起作用了

改用 `baoyu-image-gen` 的 API 后端，当前验证有效组合：

```bash
bun /Users/mine/Documents/GitHub/claude-mytools/baoyu-skills/skills/baoyu-image-gen/scripts/main.ts \
  --provider runninghub \
  --model gpt-image-2 \
  --promptfiles <prompt.md> \
  --image <out.png> \
  --ar 3:4 \
  --quality 2k
```

对于系列图，先生成第 1 张封面，再用封面作为 `ref` 批量生成后续图片；RunningHub 并发按配置限制为 2。

## 下次注意

小红书图文卡片任务若 `codex-cli` 首次失败或超过数分钟无结果，不要反复等待；直接切换到 `baoyu-image-gen` 的 RunningHub/OpenAI 等 API 后端。
