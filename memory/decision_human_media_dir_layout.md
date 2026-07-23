---
name: decision_human_media_dir_layout
description: human-media-writer 目录分层语义与子代理框架可移植边界
metadata:
  type: decision
---
2026-07-18 重构了 `skills/human-media-writer/` 的目录结构，确立四层分层语义，后续新增内容按此归位：

- `references/knowledge/` = **是什么**（跨模式静态知识）：`writing-style.md`（声音身份）、`platform.md`（容器约束+多形态聚合输出）、`ai-tell-catalog-zh.md`。
- `references/workflows/` = **怎么做**（模式流程）：`craft.md` / `rewrite.md` / `analysis.md` / `review.md`。
- `references/tasks/` = **派给子代理的活**（业务任务说明，用 subagents/template.md 定义）：`topic-selection.md` / `article-review.md`。
- `references/subagents/` = **怎么派**（可移植委派框架）：`protocol.md` + `template.md` + `adapters/*`。

**关键约束**：`subagents/` 只含可移植框架，**不放任何业务任务**——用户明确要求该框架能原样复制到任何技能。新增子代理业务任务放 `references/tasks/`，不要放回 `subagents/agents/`（该目录已删除）。

**理由**：原 SKILL.md（414 行）把 4 大知识块内联、references/ 扁平混乱、业务任务污染了可移植框架。重构后 SKILL.md 只留身份+关键规则+配置+路由+加载表，知识块抽到 knowledge/ 按需加载。

**脚本约束**：`scripts/check_article_constraints.py` 的 `style_path()` 硬编码 `references/styles/`——移动 styles 目录必须同步改脚本。

关联 [[decision_human_media_multiform_output]]。
