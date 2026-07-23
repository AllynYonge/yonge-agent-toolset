#!/usr/bin/env python3
"""多维度门控：判断一次改动该采纳(keep)、丢弃(discard)还是回滚(revert)。

为什么要多维度：只看质量分很容易"改好一个指标、悄悄弄坏另一个"。
所以采纳一次改动必须同时满足所有维度（AND 逻辑），任一不满足就丢弃。

五个维度（刻意精简，避免逐个调参的复杂门控）：
  1. 结构合规  —— 由 creator 的 quick_validate 保证（在本模块外先跑，结果传入 struct_ok）
  2. 行为不退步 —— L1 断言 pass_rate 没下降
  3. 质量有提升 —— 目标维度平均分涨了（超过 min_delta）
  4. 成本没暴涨 —— token 没超过基线的 (1 + max_token_increase) 倍
  5. 结果稳定  —— stability 多次运行的 pass_rate ≥ min_stability

crash/timeout 直接回滚。quality 基础设施失败（抽取/judge 协议）时 discard。质量维度在基线已接近满分时切换为"不退步即可"。
"""

from __future__ import annotations

from dataclasses import dataclass


@dataclass
class Policy:
    """门控阈值。可在 spec 的 gate 字段覆盖默认值。"""
    min_delta: float = 0.02          # 质量最小提升幅度
    max_token_increase: float = 0.20  # token 最多允许膨胀 20%
    min_stability: float = 0.8        # 稳定性 pass_rate 下限
    noise_threshold: float = 0.01     # 小于此幅度视为噪声

    @classmethod
    def from_spec(cls, spec: dict | None) -> "Policy":
        """从 spec['gate'] 读取覆盖值，缺的用默认。"""
        cfg = (spec or {}).get("gate", {}) if spec else {}
        return cls(**{k: cfg[k] for k in cfg if k in cls.__dataclass_fields__})


@dataclass
class EvalSnapshot:
    """一次评估的结果快照。current 与 baseline 都用这个结构。"""
    status: str = "ok"               # ok / crash / timeout
    struct_ok: bool = True           # creator quick_validate 是否通过
    behavior_pass_rate: float = 1.0  # L1 行为断言通过率
    quality_mean: float = 0.0        # L2 目标维度平均分（仅 judge_status=ok）
    quality_infra_failed: bool = False  # quality judge/抽取基础设施失败
    stability_pass_rate: float = 1.0  # stability 多次运行通过率
    tokens_mean: float = 0.0         # 平均 token 消耗


def gate_decision(current: EvalSnapshot, baseline: EvalSnapshot,
                  policy: Policy | None = None) -> tuple[str, list[str]]:
    """返回 (决定, 原因列表)。决定 ∈ {"keep", "discard", "revert"}。

    原因列表记录每个维度的判定，写进记忆便于事后回看为什么采纳/丢弃。
    """
    policy = policy or Policy()
    reasons: list[str] = []

    # 硬失败：崩溃或超时 → 回滚
    if current.status in ("crash", "timeout"):
        return "revert", [f"运行异常({current.status})，回滚"]

    # 结构合规（creator quick_validate 的结果，外部先跑好传入）
    if not current.struct_ok:
        return "discard", ["结构校验未通过(quick_validate)"]

    # quality 基础设施失败时，质量分不可信，禁止据此 keep
    if current.quality_infra_failed:
        return "discard", ["质量评审基础设施失败(infra/judge)，分数不可信，禁止据此改 skill"]

    # 行为不退步
    behavior_ok = current.behavior_pass_rate >= baseline.behavior_pass_rate - policy.noise_threshold
    reasons.append(
        f"行为 {current.behavior_pass_rate:.2f} vs 基线 {baseline.behavior_pass_rate:.2f} "
        f"→ {'ok' if behavior_ok else '退步'}"
    )

    # 质量有提升；基线接近满分(5分制)时退化为"不退步即可"
    if baseline.quality_mean >= 5.0 - policy.noise_threshold:
        quality_ok = current.quality_mean >= baseline.quality_mean - policy.noise_threshold
        reasons.append(f"质量已近满分，只需不退步 → {'ok' if quality_ok else '退步'}")
    else:
        quality_ok = current.quality_mean >= baseline.quality_mean + policy.min_delta
        reasons.append(
            f"质量 {current.quality_mean:.2f} vs 基线 {baseline.quality_mean:.2f} "
            f"(需 +{policy.min_delta}) → {'ok' if quality_ok else '不足'}"
        )

    # 成本没暴涨（基线为 0 时跳过，无从比较）
    if baseline.tokens_mean > 0:
        cost_ok = current.tokens_mean <= baseline.tokens_mean * (1 + policy.max_token_increase)
        reasons.append(
            f"token {current.tokens_mean:.0f} vs 上限 "
            f"{baseline.tokens_mean * (1 + policy.max_token_increase):.0f} "
            f"→ {'ok' if cost_ok else '超支'}"
        )
    else:
        cost_ok = True

    # 结果稳定
    stability_ok = current.stability_pass_rate >= policy.min_stability
    reasons.append(
        f"稳定性 {current.stability_pass_rate:.2f} (需 ≥{policy.min_stability}) "
        f"→ {'ok' if stability_ok else '不稳'}"
    )

    if behavior_ok and quality_ok and cost_ok and stability_ok:
        return "keep", reasons
    return "discard", reasons


if __name__ == "__main__":
    # 冒烟自检：一个明显该 keep 和一个明显该 discard 的例子
    base = EvalSnapshot(behavior_pass_rate=1.0, quality_mean=3.0, tokens_mean=1000)
    better = EvalSnapshot(behavior_pass_rate=1.0, quality_mean=3.5,
                          tokens_mean=1050, stability_pass_rate=0.9)
    worse = EvalSnapshot(behavior_pass_rate=0.8, quality_mean=3.5,
                         tokens_mean=1050, stability_pass_rate=0.9)
    print("better →", gate_decision(better, base)[0])
    print("worse  →", gate_decision(worse, base)[0])
