# 运行与评测测试用例 - 详细流程

## 步骤 1：同一轮内拉起全部运行（使用技能与基线）

对每个测试用例，在同一轮里生成两个子智能体——一个带技能，一个不带。这很重要：不要先跑完使用技能的，再回头补基线。一次全部启动，让它们大致同时结束。

**使用技能的运行：**

```
Execute this task:
- Skill path: <path-to-skill>
- Task: <eval prompt>
- Input files: <eval files if any, or "none">
- Save outputs to: <workspace>/iteration-<N>/eval-<ID>/with_skill/outputs/
- Outputs to save: <what the user cares about — e.g., "the .docx file", "the final CSV">
```

**基线运行**（同一提示词，但基线随上下文而定）：

- **创建新技能**：完全不带技能。同一提示词，无技能路径，保存到 `without_skill/outputs/`。
- **改进已有技能**：旧版本。编辑前先快照技能（`cp -r <skill-path> <workspace>/skill-snapshot/`），再让基线子智能体指向该快照。保存到 `old_skill/outputs/`。

为每个测试用例写 `eval_metadata.json`（断言可先为空）。给每个评测起描述性名称，基于它测什么——不要只叫 "eval-0"。目录名也用这个名称。若本轮迭代用了新的或改过的评测提示词，为每个新的评测目录创建这些文件——不要假设会从上轮迭代继承。

```json
{
  "eval_id": 0,
  "eval_name": "descriptive-name-here",
  "prompt": "The user's task prompt",
  "assertions": []
}
```

## 步骤 2：运行进行期间起草断言

不要干等运行结束——这段时间可以有效利用。为每个测试用例起草定量断言，并向用户解释。若 `evals/evals.json` 里已有断言，审阅并说明它们检查什么。

好的断言应客观可验证，且有描述性名称——在基准测试查看器里应一眼可读，让人扫结果时立刻明白每条在查什么。主观技能（文风、设计质量）更适合定性评估——不要把断言硬套到需要人判断的事情上。

起草后，把断言更新进 `eval_metadata.json` 与 `evals/evals.json`。同时向用户说明他们会在查看器里看到什么——定性输出与定量基准测试。

## 步骤 3：运行完成时捕获计时数据

每个子智能体任务完成时，你会收到含 `total_tokens` 与 `duration_ms` 的通知。立刻把数据存到该次运行目录的 `timing.json`：

```json
{
  "total_tokens": 84852,
  "duration_ms": 23332,
  "total_duration_seconds": 23.3
}
```

这是捕获该数据的唯一机会——它只经任务通知传来，别处不会持久化。通知一到就处理，不要攒着批量做。

## 步骤 4：评分、聚合并启动查看器

全部运行结束后：

1. **给每次运行评分** — 生成评分器子智能体（或内联评分），读取 `agents/grader.md`，对照输出评估每条断言。结果保存到各运行目录的 `grading.json`。grading.json 的 expectations 数组必须使用字段 `text`、`passed`、`evidence`（不要用 `name`/`met`/`details` 或其他变体）——查看器依赖这些确切字段名。对可程序化检查的断言，编写并运行脚本，而不是目测——脚本更快、更可靠，且可跨迭代复用。

2. **聚合为基准测试** — 在 skill-creator 目录运行聚合脚本：
   ```bash
   python -m scripts.aggregate_benchmark <workspace>/iteration-N --skill-name <name>
   ```
   这会生成 `benchmark.json` 与 `benchmark.md`，含每种配置的 pass_rate、耗时与 token，以及 mean ± stddev 和 delta。若手动生成 benchmark.json，查看器期望的精确 schema 见 `references/schemas.md`。把每个 with_skill 版本放在其基线对应项之前。

3. **做分析师审阅** — 阅读基准测试数据，挖出汇总统计可能掩盖的模式。关注点见 `agents/analyzer.md`（「Analyzing Benchmark Results」一节）——例如无论有无技能都总通过的断言（无区分力）、高方差评测（可能不稳定 / flaky）、时间/token 权衡。

4. **启动查看器**，同时展示定性输出与定量数据：
   ```bash
   nohup python <skill-creator-path>/eval-viewer/generate_review.py \
     <workspace>/iteration-N \
     --skill-name "my-skill" \
     --benchmark <workspace>/iteration-N/benchmark.json \
     > /dev/null 2>&1 &
   VIEWER_PID=$!
   ```
   第 2 次及以后的迭代，还要传 `--previous-workspace <workspace>/iteration-<N-1>`。

   **Cowork / 无头环境：** 若 `webbrowser.open()` 不可用或环境无显示器，用 `--static <output_path>` 写出独立 HTML，而不是起服务器。用户点击 "Submit All Reviews" 后，反馈会下载为 `feedback.json`。下载后把 `feedback.json` 复制进工作区目录，供下一轮迭代读取。

注意：请用 generate_review.py 创建查看器；不必手写自定义 HTML。

5. **告诉用户**类似这样的话：「我已在浏览器中打开结果。有两个标签——『Outputs』可逐个点开测试用例并留下反馈，『Benchmark』展示定量对比。看完后回到这里告诉我。」

### 用户在查看器中看到什么

「Outputs」标签一次显示一个测试用例：

- **Prompt（提示）**：给出的任务
- **Output（输出）**：技能产出的文件，尽可能内联渲染
- **Previous Output（上一轮输出）**（第 2 次迭代+）：折叠区，显示上一轮输出
- **Formal Grades（正式评分）**（若已评分）：折叠区，显示断言通过/失败
- **Feedback（反馈）**：边输入边自动保存的文本框
- **Previous Feedback（上次反馈）**（第 2 次迭代+）：上次评论，显示在文本框下方

「Benchmark」标签显示统计摘要：每种配置的通过率、耗时与 token 用量，以及按评测的细分与分析师观察。

用 prev/next 按钮或方向键导航。完成后点击 "Submit All Reviews"，把全部反馈写入 `feedback.json`。

## 步骤 5：读取反馈

用户说做完后，读取 `feedback.json`：

```json
{
  "reviews": [
    {"run_id": "eval-0-with_skill", "feedback": "the chart is missing axis labels", "timestamp": "..."},
    {"run_id": "eval-1-with_skill", "feedback": "", "timestamp": "..."},
    {"run_id": "eval-2-with_skill", "feedback": "perfect, love this", "timestamp": "..."}
  ],
  "status": "complete"
}
```

空反馈表示用户觉得没问题。把改进重点放在用户有具体抱怨的测试用例上。

用完后关掉查看器服务器：

```bash
kill $VIEWER_PID 2>/dev/null
```
