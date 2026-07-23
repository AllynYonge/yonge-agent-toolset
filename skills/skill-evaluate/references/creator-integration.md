# 复用 skill-creator（引用而非复制）

skill-evaluate 复用已安装的 skill-creator 来避免重造轮子。原则是**引用而非复制**：
需要哪个能力就调它的脚本/agent，不把它的逻辑抄进来。这样 creator 升级后本技能自动受益，
本技能的代码和维护面也更小。

封装在 `scripts/creator.py`，你不用记路径，直接调函数即可。

## 任务与 skill-creator 能力映射

| 你要做的事 | 调用 | creator.py 里的入口 |
|------------|------|---------------------|
| 结构校验 | `quick_validate.py` | `quick_validate(skill_dir) -> (ok, msg)` |
| 触发准确率评估 | `run_eval.py` | `run_eval(eval_set, skill_dir, model)` |
| 描述优化（自动迭代 description） | `run_loop.py` / `improve_description.py` | 用 `require_creator()` 拿路径后自行调 |
| 基线对比数值汇总 | `aggregate_benchmark.py` | `aggregate_benchmark(iter_dir, skill_name)` |
| 人工参与的浏览器审阅界面 | `eval-viewer/generate_review.py` | `generate_review_cmd(...)` 返回命令，后台运行 |
| 打包成 .skill | `package_skill.py` | `package_skill(skill_dir)` |
| 评分 / 诊断 / 盲评 agent 定义 | `agents/grader.md` 等 | `agent_path("grader.md")` 返回文件路径 |

## 本技能只保留自己独有的部分

creator 没有、必须留在 skill-evaluate 的：

- **真实 agent 行为测试框架（harness）**（多后端 hermes/claude/codex）：`dynamic_skill_behavior_harness.py`
- **稳定性运行**：`stability.py`（多次运行取 pass_rate，creator 没这个）
- **质量评分**：`quality.py`
- **人工检查点**：`humanloop.py`
- **提升探索发现器 Discoverer**：`agents/discoverer.md`（creator 没有）
- **跨迭代记忆 / 采纳判定 / 版本锁定与回滚**：`memory.py` / `gate.py` / `ratchet.py`

## 路径怎么找、找不到怎么办

`creator.py` 按以下顺序查找（命中即用）：

1. `$SKILL_CREATOR_PATH` 环境变量
2. `~/.claude/skills/skill-creator`、`~/.codex/skills/skill-creator`、`~/.codex/agents/skill-creator`
3. `./.claude/skills/skill-creator`

找不到时 `require_creator()` 会**抛错并打印安装指引**，而不是静默跳过——
因为结构校验和描述优化都依赖它，静默跳过会让人误以为“已经检查过”，反而更危险。

自检命令：

```bash
python3 scripts/creator.py --which                 # 打印找到的路径
python3 scripts/creator.py --validate <skill-dir>  # 试跑一次结构校验
```
