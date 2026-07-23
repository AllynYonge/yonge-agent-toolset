# 运行机制

## 测试框架

位于：`scripts/dynamic_skill_behavior_harness.py`

功能：

- 创建临时隔离运行环境，从用户真实环境继承配置和凭据（不打印密钥）
  - Codex：除 `config.toml` / `auth.json` 外，还会继承 `model_catalog_json` 指向的模型目录文件（如 `cpa-router-models.json`）以及可选 `rules/`；缺这些文件时 agent/judge 都会以 `No such file or directory` 启动失败，属于环境/框架问题，不是目标 skill 行为问题
- 复制目标 skill 及 `related_skills`（自动排除 `test/`、`tmp/`、`__pycache__/`、`*.pyc`）
- 通过后端适配器（`scripts/backends/`）调度对应 CLI 执行
- 捕获 stdout、stderr 和会话文件
- 评估 JSON 断言（确定性 + 语义），输出机器可读报告

运行方式：

```bash
# 方式1：按 skill + scenario 名称
python3 /path/to/skill-evaluate/scripts/dynamic_skill_behavior_harness.py \
  --skill <skill> --scenario <scenario>

# 方式2：显式传入 spec 路径
python3 /path/to/skill-evaluate/scripts/dynamic_skill_behavior_harness.py \
  /absolute/path/to/<target-skill>/test/specs/<skill>_<scenario>.json
```

路径解析规则：传入 `--skill` 时，相对路径基于**目标 skill 的 `test/` 目录**解析。

## 产出物路径约定

| 类型 | 路径 | 生命周期 |
|------|------|----------|
| spec（输入） | `<target-skill>/test/specs/<spec-stem>.json` | 永久保留 |
| 报告（输出） | `<target-skill>/test/reports/<spec-stem>-l1-report.json` 等 | 永久保留 |
| 迭代日志 | `<target-skill>/test/memory/experiments.jsonl` | 永久保留（追加写入） |
| 临时 HERMES_HOME | `<target-skill>/test/tmp/hermes-skill-behavior-<timestamp>-<pid>/` | 默认自动清理；`--keep-home` 保留 |

### 报告命名（固化）

报告名**从 spec 文件名派生**，并带评估层级：

| 层级 | 默认报告名 |
|------|------------|
| L1 | `<spec-stem>-l1-report.json` |
| L2 | `<spec-stem>-l2-report.json` |
| L3 | `<spec-stem>-l3-report.json` |

示例：spec 为 `article-analysis-behavior.json` 时：

- `article-analysis-behavior-l1-report.json`
- `article-analysis-behavior-l2-report.json`
- `article-analysis-behavior-l3-report.json`

补充规则：
- `<spec-stem>` = spec 文件名去掉 `.json`（推荐用连字符：`article-analysis-behavior`）
- 单 case 过滤：`<spec-stem>-l2-<case-id>-report.json`
- replay：在末尾追加 `-replay`，如 `<spec-stem>-l2-report-replay.json`
- 稳定性汇总：`<spec-stem>-l1-stability.json`（或对应层级）
- 层级推断：CLI `--level` > `--assertions-only`(L1) / `--quality-only`(L2) > `spec.level` > `aspiration.enabled`(L3) / `quality.enabled`(L2) > 默认 L1
- 仍可用 `--out` 覆盖默认路径

兼容：旧的 `<skill>_<scenario>.json` / `<skill>_<scenario>_report.json` 仍可被读取或手动指定；**新建默认命名统一为连字符 + `-lN-report`**。

agent 自动运行时，必须使用 `--out` 参数落盘报告，以便后续诊断步骤读取。

## 超时处理

当某轮超过 `timeout` 秒时：终止子进程，记录 `exit_code: -1` 和 `[TIMEOUT]` 到 stderr，跳过后续轮次，报告中标记该 case 为失败。

## exit_code 判定逻辑

- spec 中有显式 `exit_code` 断言：仅由断言结果决定
- spec 中无 `exit_code` 断言：隐式要求所有轮次退出码为 0

可用于测试"预期失败"场景：`{"type": "exit_code", "value": 1}`。

## Case 隔离

框架在一次运行内共享同一个临时 `HERMES_HOME`，通过比较运行前后的 session 文件集合，提取每个 case 新增的 transcript。已验证连续 `hermes chat -q` 调用会创建独立 session 文件，不会追加写入。

如果未来 Hermes 改为追加/复用 session 文件，需替换为每个 case 独立 `HERMES_HOME` 的隔离方案。

## 多轮测试

报告中 `turn_result['exit_code']` 为最后一轮退出码。`turn_result['exit_codes']` 为所有轮次退出码的逗号分隔列表。如需断言特定轮次，检查 `cases[].turns[].exit_code`。

## 重放与过滤

修断言 / 修 judge 时，优先重放已有轨迹，避免重复支付真实 agent 成本：

```bash
# 只重放一个 case 的 L1 断言
python3 scripts/dynamic_skill_behavior_harness.py \
  --skill <skill> --scenario behavior \
  --replay-report <old_report.json> \
  --case <case-id> \
  --assertions-only \
  --out <replay_report.json>

# 用旧轨迹重算 quality（会调用 judge，但不再跑被测 agent）
python3 scripts/dynamic_skill_behavior_harness.py \
  --skill <skill> --scenario behavior \
  --replay-report <old_report.json> \
  --case <case-id> \
  --quality-only
```

规则：
- `--case` 可重复，也支持逗号分隔
- `--replay-report` 从旧报告的 `cases[].turns[]` 重建 stdout/stderr，再抽取 `final_text`
- `--assertions-only` 跳过 quality；`--quality-only` 必须配合 `--replay-report`
- 报告字段 `mode=replay|live`、`case_filter`、`quality_infra_failed` 便于区分真实失败与 harness 失败

## 稳定性验证

当语义断言或质量评分出现间歇性波动时，用稳定性运行器量化：

```bash
python3 scripts/stability.py --spec <path> --runs N
```

分类标准：

| pass_rate | 分类 | 处置 |
|-----------|------|------|
| ≥ 0.9 | stable_pass | 可信通过 |
| 0.7 < pass_rate < 0.9 | mostly_pass | 大多通过，但尚不足以视为稳定通过 |
| 0.3 ≤ pass_rate ≤ 0.7 | flaky | 需收紧 rubric 或改用确定性断言 |
| 0.1 < pass_rate < 0.3 | mostly_fail | 大多失败，但尚未达到稳定失败 |
| ≤ 0.1 | stable_fail | 确认失败，进入修补循环 |

规则：
- 新增语义断言必须经过 `--runs 5` 验证并达到 `stable_pass` 后，才纳入正式 spec
- `flaky` 断言不得作为迭代终止条件——必须先解决稳定性，再判定 skill 行为
- 稳定性报告保存在 `<target-skill>/test/reports/<spec-stem>-lN-stability.json`

设计决策：
- 每次运行是独立子进程（干净状态，不共享临时目录）
- scenario 名称添加 `_stability_runN` 后缀避免报告文件名冲突
- `flaky` 分类区间为 0.3–0.7（LLM judge 在此区间波动较大）
- 退出码 2（检测到 flaky）区别于 1（错误），便于 CI 区分“不稳定但可运行”和“运行失败”

## 人工检查点

以下条件触发时，暂停自动迭代并请求用户确认：

| 触发条件 | 暂停原因 | 恢复方式 |
|----------|----------|----------|
| 语义断言被分类为 flaky | 自动判定不可靠 | 用户确认 rubric 调整方向或改用文本断言 |
| 质量分数等于阈值或低于阈值 1 分 | 通过/失败边界模糊 | 用户判定是否接受或继续优化 |
| 同一 case 迭代 3 次仍失败 | 可能是模型能力边界 | 用户决定放宽标准/换模型/标记为已知限制 |
| 质量迭代中出现行为回归 | patch 有副作用 | 用户决定回滚范围和优先级 |

运行方式：

```bash
python3 scripts/humanloop.py --spec <path>
```

人工检查点的判定结果保存到独立的 `clarifications.json`；若用户提供评分标准补充，则追加到 spec 的质量 rubric 记录中。

架构约定：
- humanloop.py 不修改 harness 流程——它运行 harness 子进程，检查报告，决定是否暂停
- 触发检测是纯事后分析（读取报告 → 检查条件 → 按需提示）
- 用户决策 append-only 保存在 `clarifications.json`
- 评分标准逐步明确：用户文本追加到 `spec.quality.rubrics[dimension]`，不替换已有文本
- 目标是快速收敛：每次交互细化 spec，使同一触发器不再在后续运行中触发
