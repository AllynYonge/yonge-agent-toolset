# description 优化 - 详细流程

## 步骤 1：生成触发评测查询

创建 20 条评测查询——混合 should-trigger 与 should-not-trigger。存为 JSON：

```json
[
  {"query": "the user prompt", "should_trigger": true},
  {"query": "another prompt", "should_trigger": false}
]
```

查询必须真实，是 Claude Code 或 Claude.ai 用户会真的输入的那种。不是抽象请求，而是具体、有细节的请求。例如文件路径、关于用户工作或处境的个人上下文、列名与取值、公司名、URL。一点背景故事。有些可以是小写，或含缩写、错别字、口语。长度要混搭，并侧重边界情况，而不是一目了然的（用户会有机会签核）。

不好：`"Format this data"`、`"Extract text from PDF"`、`"Create a chart"`

好：`"ok so my boss just sent me this xlsx file (its in my downloads, called something like 'Q4 sales final FINAL v2.xlsx') and she wants me to add a column that shows the profit margin as a percentage. The revenue is in column C and costs are in column D i think"`

对 **should-trigger** 查询（8–10 条），考虑覆盖面。同一意图要有不同说法——有正式、有随意。包含用户未点名技能或文件类型、但明显需要它的情况。再加一些少见用例，以及本技能与其他技能竞争但应胜出的情况。

对 **should-not-trigger** 查询（8–10 条），最有价值的是擦边负例（near-misses）——与技能共享关键词或概念、实际却需要别的东西的查询。想相邻领域、朴素关键词匹配会误触发的模糊措辞，以及触及技能能力、但在该语境下更适合别的工具的情况。

关键要避免：不要把 should-not-trigger 做成明显无关。对 PDF 技能用 "Write a fibonacci function" 做负例太容易——测不到任何东西。负例应当真正棘手。

## 步骤 2：与用户审阅

用 HTML 模板把评测集呈现给用户审阅：

1. 从 `assets/eval_review.html` 读取模板
2. 替换占位符：
   - `__EVAL_DATA_PLACEHOLDER__` → 评测项的 JSON 数组（外面不要加引号——这是 JS 变量赋值）
   - `__SKILL_NAME_PLACEHOLDER__` → 技能名称
   - `__SKILL_DESCRIPTION_PLACEHOLDER__` → 技能当前 description
3. 写到临时文件（例如 `/tmp/eval_review_<skill-name>.html`）并打开：`open /tmp/eval_review_<skill-name>.html`
4. 用户可编辑查询、切换 should-trigger、增删条目，然后点 "Export Eval Set"
5. 文件会下载到 `~/Downloads/eval_set.json`——检查 Downloads 里最新版本，以防有多个（例如 `eval_set (1).json`）

这一步很重要——差的评测查询会带出差的 description。

## 步骤 3：运行优化循环

告诉用户：「这需要一些时间——我会在后台运行优化循环，并定期检查进度。」

将评测集保存到工作区，然后在后台运行：

```bash
python -m scripts.run_loop \
  --eval-set <path-to-trigger-eval.json> \
  --skill-path <path-to-skill> \
  --model <model-id-powering-this-session> \
  --max-iterations 5 \
  --verbose
```

使用系统提示中的模型 ID（驱动当前会话的那个），使触发测试与用户实际体验一致。

运行过程中，定期查看（tail）输出，向用户汇报当前迭代轮次和分数情况。

该脚本会自动完成整条优化循环：将评测集按 60% 训练集、40% 留出测试集（held-out test）划分；评估当前 description（每个查询跑 3 次以得到可靠触发率）；再根据失败样例调用 Claude 提出改进。每个新 description 都会在训练集和测试集上重新评估，最多迭代 5 次。完成后在浏览器中打开 HTML 报告，展示各轮结果，并返回含 `best_description` 的 JSON——按测试分数而非训练分数选取，以避免过拟合（overfitting）。

## 技能触发如何工作

理解触发机制有助于设计更好的评测查询。技能会出现在 Claude 的 `available_skills` 列表中，附带名称 + description；Claude 据此决定是否查阅该技能。关键点是：Claude 只会为它难以自行轻松完成的任务去查阅技能——像「读这个 PDF」这类简单、单步查询，即便 description 完全匹配，也可能不触发技能，因为 Claude 可直接用基础工具处理。复杂、多步骤或专业化的查询，在 description 匹配时会更稳定地触发技能。

所以评测查询应足够有实质内容，使 Claude 确实有必要查阅技能。像「读取文件 X」这类简单查询是差的测试用例——无论 description 质量如何，它们都不会触发技能。

## 步骤 4：应用结果

从 JSON 输出中取出 `best_description`，更新技能 SKILL.md 的 frontmatter。向用户展示前后对比，并报告分数。
