---
type: error
date: 2026-07-12
---

# Codex MCP 工具注入快照失效

当 `codex mcp list` 和连接日志显示 MCP 已连接、`tools/list` 也能返回工具，但当前模型工具列表里没有对应的 `mcp__*` 工具时，问题通常在 Codex 当前任务的工具面快照/请求上下文组装，而非 MCP 服务连接。

有效恢复方法：重启 Codex Desktop 并新建任务，让应用重新组装 MCP tool surface；随后直接调用一个 MCP 工具验证。`list_mcp_resources` 返回 `resources not supported` 不能据此判定工具连接失败，因为服务器可以只实现 tools。
