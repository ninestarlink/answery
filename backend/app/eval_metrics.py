"""评测指标的纯计算：不依赖数据库、检索器或模型，便于单元测试与 CI 回归。"""

from __future__ import annotations

import math


def summarize(ranks: list[int], latencies: list[int]) -> dict:
    """由每条用例的首中位次和耗时汇总指标。rank=0 表示未命中。"""
    total = len(ranks)
    hits = [r for r in ranks if r > 0]
    hit_rate = len(hits) / total if total else 0.0
    mrr = sum(1.0 / r for r in hits) / total if total else 0.0
    ordered = sorted(latencies)
    p95 = 0
    if ordered:
        p95 = ordered[max(0, math.ceil(len(ordered) * 0.95) - 1)]
    return {
        "case_count": total,
        "hit_count": len(hits),
        "hit_rate": round(hit_rate, 4),
        "mrr": round(mrr, 4),
        "avg_latency_ms": int(sum(latencies) / len(latencies)) if latencies else 0,
        "p95_latency_ms": p95,
    }
