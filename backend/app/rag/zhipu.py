"""智谱 API 客户端：embedding-3 + rerank。

两者都是 HTTP 短请求，不引入额外的 SDK，方便替换供应商。
失败时向上抛出异常，由检索层降级（保留 RRF 排序），不让检索整体不可用。
"""

from __future__ import annotations

import asyncio
import logging
import time

import httpx

from ..config import settings

logger = logging.getLogger("rag.zhipu")

_EMBED_BATCH = 64
# 额度不足是持续性故障，短时间内重试没有意义：熔断一段时间直接降级
_disabled_until = 0.0
_DISABLE_SECONDS = 300


class ZhipuError(RuntimeError):
    """智谱接口不可用（未配置 Key、额度不足、超时、返回结构异常）。"""


def _headers() -> dict[str, str]:
    if not settings.zhipu_api_key:
        raise ZhipuError("未配置 ZHIPU_API_KEY")
    return {
        "Authorization": f"Bearer {settings.zhipu_api_key}",
        "Content-Type": "application/json",
    }


async def _post(path: str, payload: dict) -> dict:
    global _disabled_until
    if time.time() < _disabled_until:
        raise ZhipuError("embedding/rerank 额度不可用，已临时熔断")
    url = f"{settings.zhipu_api_base.rstrip('/')}/{path}"
    last_error: Exception | None = None
    for attempt in range(3):
        try:
            async with httpx.AsyncClient(timeout=settings.request_timeout) as client:
                resp = await client.post(url, json=payload, headers=_headers())
            if resp.status_code == 429 or "1113" in resp.text:
                _disabled_until = time.time() + _DISABLE_SECONDS
                raise ZhipuError(f"{path} 额度不足：{resp.text[:120]}")
            if resp.status_code != 200:
                raise ZhipuError(f"{path} 返回 HTTP {resp.status_code}：{resp.text[:200]}")
            return resp.json()
        except (httpx.HTTPError, ZhipuError) as exc:
            last_error = exc
            if isinstance(exc, ZhipuError) and "额度不足" in str(exc):
                break
            if attempt < 2:
                await asyncio.sleep(1 + attempt)
    raise ZhipuError(str(last_error))


async def embed_texts(texts: list[str]) -> list[list[float]]:
    """批量向量化，单次请求 64 条，保持输入顺序。"""
    vectors: list[list[float]] = []
    for start in range(0, len(texts), _EMBED_BATCH):
        batch = texts[start : start + _EMBED_BATCH]
        payload = {
            "model": settings.zhipu_embedding_model,
            "input": batch,
            "dimensions": settings.rag_embedding_dims,
        }
        data = await _post("embeddings", payload)
        items = sorted(data.get("data") or [], key=lambda x: x.get("index", 0))
        if len(items) != len(batch):
            raise ZhipuError("embedding 返回条数与输入不一致")
        vectors.extend([list(map(float, item["embedding"])) for item in items])
    return vectors


async def rerank(query: str, documents: list[str], top_n: int) -> list[tuple[int, float]]:
    """返回 [(原始下标, 相关度)]，按相关度倒序。"""
    if not documents:
        return []
    payload = {
        "model": settings.zhipu_rerank_model,
        "query": query,
        "documents": documents,
        "top_n": min(top_n, len(documents)),
    }
    data = await _post("rerank", payload)
    results = data.get("results") or []
    if not results:
        raise ZhipuError("rerank 返回空结果")
    ranked = [
        (int(item.get("index", 0)), float(item.get("relevance_score", 0.0)))
        for item in results
        if isinstance(item, dict)
    ]
    return sorted(ranked, key=lambda x: x[1], reverse=True)
