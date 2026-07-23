---
type: error
date: 2026-07-19
---

# skill-evaluate / Codex 质量评审的常见假失败

## 什么不起作用
- 对 Codex `exec --json` 的 raw stdout 用过窄的 `agent_message` 首行正则；语义正确但措辞变化会红。
- 直接把 quality 层接到 `run_semantic_judge`：semantic judge 协议是 `{"passed": bool, "reason": "..."}`，而 quality 期望 `{"score": 1-5, "evidence": "...", "gaps": "..."}`。解析失败时若仍记 3 分，会把 harness 故障伪装成 skill 质量中等。
- quality 对 `stdout + transcript` 从头截断，且 stdout 含大量 Codex 事件 JSON；judge 容易把“中间截断/缺后半报告”误判为 skill 不完整。
- 每次改断言都重跑真实 agent：慢、贵，且不利于隔离 “spec 问题 / skill 问题”。
- Codex `prepare_home` 只复制 `config.toml/auth.json` 时，相对路径 `model_catalog_json = "cpa-router-models.json"` 在临时 CODEX_HOME 下会报 `No such file or directory`，quality 全维度 `judge_status=error`。

## 什么起作用了
- 后端提供 `extract_agent_messages` / `extract_candidate_output`，断言与 quality 默认读 `final_text`。
- quality 走 `run_json_judge`，解析失败记 `judge_status=parse_error/error` 且 **fail-closed 为 infra**，不计普通低分。
- L1 断言优先 `target: final_text`，证据边界场景接受同义表述，不锁死口号。
- 修断言/judge 时用 `--replay-report --assertions-only` 重放旧轨迹；`--case` 过滤单场景。
- 真实 quality 重评用 `--quality-only --replay-report --case ...`；article-analysis 的 complete case 已验证 5/5、threshold pass。
- `prepare_home` 额外继承 model catalog（`cpa-router-models.json` 等）和 `rules/`。
- stability 透传 `--case/--assertions-only`；质量聚合只统计 `judge_status=ok` 的分数。
- gate 在 `quality_infra_failed` 时 discard，禁止据此改目标 skill。

## 下次注意
- 看到 quality 全维度同分、全是 unparseable/error、或 `candidate_text_preview` 仍是 JSONL 事件时，先修 skill-evaluate，不改目标 skill。
- Codex 正文断言不要再写 `item.completed` + `agent_message` 的 raw JSON 正则。
- 先 replay 变绿，再决定是否重跑真实 agent。
- judge 报 os error 2 时，先查临时 CODEX_HOME 是否缺 model catalog。
