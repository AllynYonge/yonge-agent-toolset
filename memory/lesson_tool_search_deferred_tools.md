---
type: lesson
date: 2026-08-23
---

# ENABLE_TOOL_SEARCH=true 导致工具"消失"（非 Claude 模型直接不可用）

**结论**：本机所有 Claude Code 会话（含 Orca worktree 会话）因 `ENABLE_TOOL_SEARCH=true` 启用工具延迟加载。会话初始只显示 ToolSearch；Read/Bash/Grep 等核心工具仍在注册表、可直接调用，但不出现在可见列表，关键词搜索也搜不到，只能 `select:<工具名>` 获取。**非 Claude 模型（如 glm-5.3）在延迟模式下完全无法执行这些工具**（用户 2026-08-23 实证：glm-5.3 不能执行、Claude 系模型可以），因为 Claude 系模型可凭训练内置的 schema 盲调，GLM 看不到 schema 就调不了。

**依据**：反编译 @cometix/claude-code 2.1.224 cli.js：① 工具是否延迟由 shouldDefer 标志决定，MCP 工具一律延迟；② 延迟工具以 `defer_loading:true` + DeferredToolPlaceholder 占位发出，命中后靠 `tool_reference` 块注入 schema——这是 Anthropic API beta 特性，中转站/非 Claude 模型不支持；③ "不支持模型"黑名单默认仅 ["claude-3-5-haiku","claude-3-haiku"]，glm-5.3 不在名单被误判为支持；④ 非 Anthropic 官方端点默认自动禁用工具搜索，但显式设 true 会绕过该安全网；⑤ settings.json 的 env 覆盖进程环境变量，包装函数里 export 覆盖不掉它；⑥ ENABLE_TOOL_SEARCH=false 是干净的关闭值；⑦ --settings 传内联 JSON 会整体替换配置（丢掉中转站地址导致 ENOTFOUND），按会话覆盖需传完整配置文件。

**下次注意**：Agent 声称"没有某工具"时，先直接调用或 `select:<name>`；换用非 Claude 模型（glm/gemini/qwen 等）前必须关掉 ENABLE_TOOL_SEARCH。开关设在 ~/.claude/settings.json 的 env 块及 ~/.zshrc 的 claude_anyrouter / claude_duck_gpt 函数里，改动必须动 settings.json（shell 导出无效）。附：api.iksvip.cc 的 cc-kiro 分组下 glm-5.3 无可用渠道（503），该 token 模型列表全是 claude 系。
