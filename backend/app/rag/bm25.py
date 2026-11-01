"""轻量 BM25：中文用字符二元组，英文/数字按词切。

不引入 jieba 之类的分词依赖，换环境不需要额外词典；
对「员工手册」「差旅报销」这类领域词，二元组召回已经足够稳。
"""

from __future__ import annotations

import math
import re
from collections import Counter

_WORD_RE = re.compile(r"[a-z0-9]+")
_CJK_RE = re.compile(r"[\u4e00-\u9fff]+")


def tokenize(text: str) -> list[str]:
    text = text.lower()
    tokens: list[str] = _WORD_RE.findall(text)
    for run in _CJK_RE.findall(text):
        run = run.strip()
        if len(run) == 1:
            tokens.append(run)
            continue
        tokens.extend(run[i : i + 2] for i in range(len(run) - 1))
    return tokens


class BM25Index:
    """Okapi BM25，数据量在千级分片时一次构建只要几十毫秒。"""

    def __init__(self, docs: list[tuple[str, str]], k1: float = 1.2, b: float = 0.75):
        self.doc_ids = [doc_id for doc_id, _ in docs]
        self.doc_tokens: list[Counter[str]] = []
        self.doc_len: list[int] = []
        self.df: Counter[str] = Counter()

        for _, text in docs:
            tokens = tokenize(text)
            counts = Counter(tokens)
            self.doc_tokens.append(counts)
            self.doc_len.append(len(tokens))
            for token in counts:
                self.df[token] += 1

        self.n = len(docs)
        self.avg_len = (sum(self.doc_len) / self.n) if self.n else 0.0
        self.k1 = k1
        self.b = b

    def search(self, query: str, top_k: int = 30) -> list[tuple[str, float]]:
        if not self.n:
            return []
        q_tokens = set(tokenize(query))
        scores: list[tuple[str, float]] = []
        for i, doc_id in enumerate(self.doc_ids):
            counts = self.doc_tokens[i]
            length = self.doc_len[i] or 1
            score = 0.0
            for token in q_tokens:
                freq = counts.get(token, 0)
                if not freq:
                    continue
                df = self.df.get(token, 0)
                idf = math.log(1 + (self.n - df + 0.5) / (df + 0.5))
                denom = freq + self.k1 * (1 - self.b + self.b * length / (self.avg_len or 1))
                score += idf * freq * (self.k1 + 1) / denom
            if score > 0:
                scores.append((doc_id, score))
        scores.sort(key=lambda x: x[1], reverse=True)
        return scores[:top_k]
