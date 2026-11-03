"""评测指标的纯函数测试：CI 里作为回归门禁的一部分运行，不依赖数据库与模型。"""

import unittest

from app.eval_metrics import summarize


class SummarizeTest(unittest.TestCase):
    def test_all_hit_at_top_one(self):
        result = summarize([1, 1, 1], [100, 120, 140])
        self.assertEqual(result["case_count"], 3)
        self.assertEqual(result["hit_count"], 3)
        self.assertEqual(result["hit_rate"], 1.0)
        self.assertEqual(result["mrr"], 1.0)

    def test_miss_and_lower_rank(self):
        result = summarize([1, 2, 0, 0], [100, 200, 300, 400])
        self.assertEqual(result["hit_count"], 2)
        self.assertEqual(result["hit_rate"], 0.5)
        self.assertAlmostEqual(result["mrr"], (1 + 0.5) / 4, places=4)

    def test_p95_latency_uses_upper_bound(self):
        # 20 个样本，最近秩法第 19 个（下标 18）即 P95，避免只取平均掩盖长尾
        latencies = list(range(100, 2100, 100))
        result = summarize([1] * 20, latencies)
        self.assertEqual(result["p95_latency_ms"], 1900)

    def test_empty(self):
        result = summarize([], [])
        self.assertEqual(result["case_count"], 0)
        self.assertEqual(result["hit_rate"], 0)
        self.assertEqual(result["p95_latency_ms"], 0)


if __name__ == "__main__":
    unittest.main()
