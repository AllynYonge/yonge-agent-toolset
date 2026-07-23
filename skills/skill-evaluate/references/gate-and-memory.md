# 采纳判定、记忆与回滚

这三件事是主流程第⑥⑦步的实现细节。SKILL.md 里只讲“该做采纳判定、记录和回滚”，
具体规则和文件格式看这里。全部落在目标 skill 自己的 `test/` 目录下，不引入独立工作区。

## 多维度采纳判定：是否接受这次改动

**为什么要多维度**：只看质量分很容易"改好一个指标、悄悄弄坏另一个"（比如质量涨了但 token 翻倍、
或者行为退步了）。所以采纳一次改动必须**同时满足**所有维度；任一不满足就将评估结果记为 `discard`。

脚本：`scripts/gate.py`，纯函数 `gate_decision(current, baseline, policy)`，只用标准库。

五个维度（刻意精简，避免引入需要逐个调参的复杂采纳判定）：

| 维度 | 通过条件 | 为什么 |
|------|----------|--------|
| 结构合规 | creator 的 `quick_validate.py` 通过 | frontmatter/结构被改坏了，后面都白搭；直接借 creator 不自己写 |
| 行为不退步 | L1 断言 pass_rate ≥ 比较基线 - 容许噪声 | 硬约束是用户利益底线，不能为了提升质量而破坏 |
| 质量有提升 | 目标维度平均分 ≥ 比较基线 + `min_delta` | 没有提升就没必要采纳；比较基线已近满分时改为只要求不退步 |
| 成本不显著增加 | token ≤ 比较基线 ×(1+`max_token_increase`) | 防止 skill 越改越冗长、越运行越昂贵 |
| 结果稳定 | stability 多次运行 pass_rate ≥ `min_stability` | **单次通过在概率系统里不算数**；这是 evaluate 相对同类工具的关键严谨点 |

崩溃/超时 → 直接 `revert`。结构不合规 → 记为 `discard`；若工作区已有实验改动，再执行回滚。

### 判定伪代码（对应 gate.py 实现）

```
if current.status in (crash, timeout):      return "revert"
if not current.struct_ok:                    return "discard"

behavior_ok  = behavior_pass_rate ≥ baseline - noise
quality_ok   = quality_mean ≥ baseline + min_delta   # 基线近满分时改为 ≥ baseline - noise
cost_ok      = tokens ≤ baseline × (1 + max_token_increase)   # 基线为 0 则跳过
stability_ok = stability_pass_rate ≥ min_stability

return "keep" if (behavior_ok and quality_ok and cost_ok and stability_ok) else "discard"
```

### 默认阈值（可在 spec 的 `gate` 字段覆盖）

| 参数 | 默认 | 含义 |
|------|------|------|
| `min_delta` | 0.02 | 质量最小提升幅度 |
| `max_token_increase` | 0.20 | token 使用量最多增加 20% |
| `min_stability` | 0.8 | 稳定性 pass_rate 下限 |
| `noise_threshold` | 0.01 | 小于此幅度视为噪声 |

## 跨迭代记忆：记住什么改法有效

**为什么要记忆**：迭代几十轮后，很容易重复试同一个失败方向。有了结构化记忆，
`grep` 一下就知道"这条路走过、没用"，把精力放在没试过的方向上。

脚本：`scripts/memory.py`，纯文件操作。三份产物都在 `<skill>/test/memory/` 下：

### results.tsv —— 每轮一行的时序日志

```
# metric_direction: higher_is_better
iter  commit  layer  metric  delta  pass_rate  tokens  status  desc
0     a1b2c3d  -      0.65    0.0    0.90       1200    baseline  初始基线
1     b2c3d4e  body   0.68    +0.03  0.90       1180    keep      明确歧义路径的检索指令
2     -        body   0.64    -0.01  0.85       1350    discard   把流程简化成两步（导致退步）
```

`status ∈ {baseline, keep, discard, revert}`；`layer ∈ {description, body, script}`；被拒绝实验的 commit 填 `-`。

### experiments.jsonl —— 每轮的细粒度诊断（一行一 JSON）

关键字段：`iter / mutation_layer / intent / diagnosis / cases_improved / cases_degraded / status / failure_reason`。

`diagnosis` 要写**因果假设诊断**——不是“case 3 失败了”，而是“case 3 失败是因为路径重叠时检索到了错误类别；
加一条按类别排序的规则，输出就会优先命中正确类别”。这样下次读取记忆时可以复用因果判断。

### best_versions/ —— 每次采纳的 skill 快照

采纳一次改动就 `memory.snapshot(skill, iter)`，存一份到 `best_versions/iter-N/`（自动排除 test/、缓存），
只保留最近 3 份。作用：随时能取回“当前最佳版本”，也是无 git 环境下的回滚兜底。

### 每轮开始时读取记忆

诊断前先看：`tail results.tsv`（趋势）、`tail experiments.jsonl`（近期失败原因）、
`git log --oneline`（改动历史）。重点提取：哪些改法被采纳过（可复用）、哪些被丢弃过（别重试）、
哪些 case 反复失败（优先处理）、是否卡住（连续 5 次 `discard` → 切换到更深层或更大粒度的修补策略）。

## 改进基线与回滚：采纳后锁定，拒绝后恢复

脚本：`scripts/ratchet.py`。**git 是可选的，不是必要依赖**；没有 git 时使用快照恢复。

| 场景 | 做法 |
|------|------|
| 采纳(keep) | `ratchet.commit(skill, layer, desc)` 提交为一个实验 + `memory.snapshot` 快照 |
| 拒绝(discard) | 拒绝当前实验；如已产生工作区改动，则调用 `ratchet.revert_last(skill)` 用 `git revert` 恢复（保留失败历史供后续诊断） |
| 崩溃(revert) | 同拒绝处理，并在 experiments.jsonl 记 `failure_reason` |
| 没装 git | 降级为从 `best_versions/` 最近快照恢复，不阻塞流程 |

为什么用 `git revert` 而不是 `reset`：失败的尝试本身是记忆的一部分，`git log` 里能看到“该方向已尝试且未改善”，
和 experiments.jsonl 相互印证，避免重复踩坑。
