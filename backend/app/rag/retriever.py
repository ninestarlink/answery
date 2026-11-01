"""混合检索：向量召回 + BM25 召回 → RRF 融合 → 精排 → 父块展开。

为什么不用单一向量检索：
- 制度类问题经常带精确词（「YC-HR-001」「年假」「6 个月」），BM25 更稳；
- 口语化问题（「刚来公司能休几天假」）靠向量；
- RRF 不依赖两路分数量纲，融合稳定；
- 精排只对候选集做，成本可控，精排不可用时自动退化到 RRF 排序。
"""

from __future__ import annotations

import asyncio
import time
from typing import Any

from ..config import settings
from . import store, zhipu
from .bm25 import BM25Index

_BM25_TTL = 300
_bm25_cache: dict[str, tuple[float, BM25Index, list[dict[str, Any]]]] = {}


def _min_score() -> float:
    """精排阈值按供应商区分：智谱 0.3，硅基流动 bge-reranker 分数压缩在 0~0.3。"""
    if zhipu._provider() == "siliconflow":
        return settings.rag_min_score_siliconflow
    return settings.rag_min_score


async def _bm25(kb_id: str) -> tuple[BM25Index, list[dict[str, Any]]]:
    now = time.time()
    cached = _bm25_cache.get(kb_id)
    if cached and now - cached[0] < _BM25_TTL:
        return cached[1], cached[2]
    rows = await store.all_children(kb_id)
    index = BM25Index([(r["chunk_id"], r["content"]) for r in rows])
    _bm25_cache[kb_id] = (now, index, rows)
    return index, rows


def invalidate_cache(kb_id: str | None = None) -> None:
    if kb_id:
        _bm25_cache.pop(kb_id, None)
    else:
        _bm25_cache.clear()


def _rrf_merge(
    dense: list[dict[str, Any]],
    sparse_ids: list[str],
    sparse_rows: dict[str, dict[str, Any]],
    k: int,
) -> list[dict[str, Any]]:
    fused: dict[str, dict[str, Any]] = {}
    for rank, row in enumerate(dense, start=1):
        item = fused.setdefault(row["chunk_id"], {**row, "dense_rank": rank, "sparse_rank": None})
        item["dense_rank"] = rank
        item["rrf"] = 1.0 / (k + rank)
    for rank, chunk_id in enumerate(sparse_ids, start=1):
        item = fused.get(chunk_id)
        if item is None:
            base = sparse_rows.get(chunk_id)
            if not base:
                continue
            item = fused[chunk_id] = {**base, "dense_rank": None, "rrf": 0.0}
        item["sparse_rank"] = rank
        item["rrf"] += 1.0 / (k + rank)
    ranked = sorted(fused.values(), key=lambda x: x["rrf"], reverse=True)
    return ranked


async def search_multi(
    kb_ids: list[str],
    query: str,
    top_k: int | None = None,
) -> dict[str, Any]:
    """跨知识库混合检索：各库独立跑一遍，再按归一化分数合并。

    用于「一个输入框问所有问题」的场景：企业制度和商品手册同时召回，
    由模型按问题语义挑用；每个库内部仍然是向量 + BM25 + RRF + 精排。
    """
    started = time.perf_counter()
    limit = top_k or settings.rag_rerank_top_k
    empty = {"hits": [], "context": "", "evidence": [], "timings": {}, "degraded": []}
    if not kb_ids or not (query or "").strip():
        return empty

    results = await asyncio.gather(
        *(search(kb, query, top_k=limit, use_rerank=False) for kb in kb_ids)
    )

    merged: list[dict[str, Any]] = []
    seen: set[str] = set()
    degraded: list[str] = []
    timings: dict[str, int] = {}
    for kb, result in zip(kb_ids, results):
        degraded.extend(f"{kb}：{d}" for d in result["degraded"])
        for key, value in result["timings"].items():
            timings[key] = max(timings.get(key, 0), value)
        for hit in result["hits"]:
            if hit["chunk_id"] in seen:
                continue
            seen.add(hit["chunk_id"])
            merged.append({**hit, "kb_id": kb})

    merged.sort(key=lambda x: x["final_score"], reverse=True)
    hits = merged[:limit]

    # 精排只跑一次，覆盖两个库的候选，避免各库单独精排导致分数不可比
    reranked = False
    if hits:
        try:
            t0 = time.perf_counter()
            ranked = await zhipu.rerank(query, [h["content"] for h in hits], limit)
            scores = {hits[i]["chunk_id"]: score for i, score in ranked}
            for hit in hits:
                if hit["chunk_id"] in scores:
                    hit["final_score"] = scores[hit["chunk_id"]]
                    hit["score"] = scores[hit["chunk_id"]]
            hits.sort(key=lambda x: x["final_score"], reverse=True)
            timings["rerank_ms"] = int((time.perf_counter() - t0) * 1000)
            reranked = True
        except zhipu.ZhipuError as exc:
            degraded.append(f"rerank 不可用：{exc}")

    # 与单库检索保持一致：精排后按阈值剔除弱相关片段，
    # 否则同名文档的低分兄弟块会作为「依据」出现在来源卡片里
    if reranked:
        hits = [h for h in hits if (h["final_score"] or 0) >= _min_score()]

    context_parts: list[str] = []
    evidence: list[dict[str, Any]] = []
    used = 0
    seen_parents: set[str] = set()
    seen_sources: set[tuple[str, str]] = set()
    for hit in hits:
        parent_id = hit.get("parent_id") or hit["chunk_id"]
        # 同一父块的多个子块命中时只展开一次；同一文档同一章节的多个父块也只留一条，
        # 避免来源卡片里出现两个完全同名的条目
        source_key = (hit["doc_name"], (hit.get("section") or "").strip())
        if parent_id in seen_parents or source_key in seen_sources:
            continue
        seen_parents.add(parent_id)
        seen_sources.add(source_key)
        header = (
            f"【{hit['doc_name']}｜{hit.get('doc_no') or '-'}｜版本 {hit.get('version') or '-'}"
            f"｜章节 {hit.get('section') or '-'}"
            + (f"｜第 {hit['page']} 页" if hit.get("page") else "")
            + "】"
        )
        block = f"{header}\n{hit.get('parent_content') or hit['content']}"
        if used + len(block) > settings.rag_max_chars and context_parts:
            break
        context_parts.append(block)
        used += len(block)
        evidence.append(
            {
                "document_name": hit["doc_name"],
                "doc_no": hit.get("doc_no") or "",
                "version": hit.get("version") or "",
                "section": hit.get("section") or "",
                "page": hit.get("page"),
                "score": round(float(hit["final_score"]), 4),
                "content": (hit.get("parent_content") or hit["content"])[:160].replace("\n", " "),
            }
        )

    timings["total_ms"] = int((time.perf_counter() - started) * 1000)
    return {
        "hits": hits,
        "context": "\n\n".join(context_parts),
        "evidence": evidence,
        "timings": timings,
        "degraded": degraded,
    }


async def search(
    kb_id: str,
    query: str,
    top_k: int | None = None,
    use_rerank: bool = True,
) -> dict[str, Any]:
    started = time.perf_counter()
    timings: dict[str, int] = {}
    degraded: list[str] = []
    empty = {"hits": [], "context": "", "evidence": [], "timings": timings, "degraded": degraded}

    query = (query or "").strip()
    if not query:
        return empty

    try:
        t0 = time.perf_counter()
        query_vector = (await zhipu.embed_texts([query]))[0]
        timings["embed_ms"] = int((time.perf_counter() - t0) * 1000)
    except zhipu.ZhipuError as exc:
        # 向量不可用时只走 BM25，保证「知识库还能查」
        degraded.append(f"embedding 不可用：{exc}")
        query_vector = []

    dense: list[dict[str, Any]] = []
    if query_vector:
        dense = await store.dense_search(kb_id, query_vector, settings.rag_dense_top_k)

    index, sparse_rows_map = await _bm25(kb_id)
    sparse = index.search(query, settings.rag_sparse_top_k)
    sparse_ids = [chunk_id for chunk_id, _ in sparse]
    sparse_rows = {r["chunk_id"]: r for r in sparse_rows_map}

    fused = _rrf_merge(dense, sparse_ids, sparse_rows, settings.rag_rrf_k)
    candidates = fused[: max(settings.rag_rerank_top_k * 3, 20)]

    rerank_scores: dict[str, float] = {}
    if use_rerank and candidates:
        try:
            t0 = time.perf_counter()
            ranked = await zhipu.rerank(
                query, [c["content"] for c in candidates], settings.rag_rerank_top_k
            )
            rerank_scores = {candidates[i]["chunk_id"]: score for i, score in ranked}
            timings["rerank_ms"] = int((time.perf_counter() - t0) * 1000)
        except zhipu.ZhipuError as exc:
            degraded.append(f"rerank 不可用：{exc}")

    max_rrf = max((c["rrf"] for c in candidates), default=1.0) or 1.0
    for item in candidates:
        item["score"] = rerank_scores.get(item["chunk_id"])
        item["final_score"] = (
            item["score"] if item["score"] is not None else item["rrf"] / max_rrf
        )

    if rerank_scores:
        candidates = [c for c in candidates if (c["score"] or 0) >= _min_score()]
    candidates.sort(key=lambda x: x["final_score"], reverse=True)
    hits = candidates[: (top_k or settings.rag_rerank_top_k)]

    parent_ids = list({h["parent_id"] for h in hits if h.get("parent_id")})
    parents = await store.parents_by_ids(kb_id, parent_ids)
    for hit in hits:
        parent = parents.get(hit.get("parent_id") or "")
        hit["parent_content"] = parent["content"] if parent else hit["content"]

    context_parts: list[str] = []
    evidence: list[dict[str, Any]] = []
    used = 0
    seen_parents: set[str] = set()
    seen_sources: set[tuple[str, str]] = set()
    for hit in hits:
        parent_id = hit.get("parent_id") or hit["chunk_id"]
        # 同一父块的多个子块命中时只展开一次；同一文档同一章节的多个父块也只留一条
        source_key = (hit["doc_name"], (hit.get("section") or "").strip())
        if parent_id in seen_parents or source_key in seen_sources:
            continue
        seen_parents.add(parent_id)
        seen_sources.add(source_key)
        parent = parents.get(hit.get("parent_id") or "") or {}
        header = (
            f"【{hit['doc_name']}｜{hit.get('doc_no') or '-'}｜版本 {hit.get('version') or '-'}"
            f"｜章节 {hit.get('section') or '-'}"
            + (f"｜第 {hit['page']} 页" if hit.get("page") else "")
            + "】"
        )
        block = f"{header}\n{hit['parent_content']}"
        if used + len(block) > settings.rag_max_chars and context_parts:
            break
        context_parts.append(block)
        used += len(block)
        evidence.append(
            {
                "document_name": hit["doc_name"],
                "doc_no": hit.get("doc_no") or "",
                "version": hit.get("version") or "",
                "section": hit.get("section") or "",
                "page": hit.get("page"),
                "score": round(float(hit["final_score"]), 4),
                "content": (hit["parent_content"] or "")[:160].replace("\n", " "),
            }
        )

    timings["total_ms"] = int((time.perf_counter() - started) * 1000)
    return {
        "hits": hits,
        "context": "\n\n".join(context_parts),
        "evidence": evidence,
        "timings": timings,
        "degraded": degraded,
    }
