"""向量化 / 精排客户端：支持硅基流动（默认）与智谱，两者都是 HTTP 短请求。

只负责 embedding 与 rerank，对话模型仍由 langgraph 里的智谱调用（glm-4-flash 免费）。
供应商之间可以随时切换，失败时向上抛异常，由检索层降级为 BM25，不影响对话。
"""

from __future__ import annotations

import asyncio
import logging
import time

import httpx

from ..config import settings

logger = logging.getLogger("rag.embedding")

_EMBED_BATCH = 64
# 额度不足是持续性故障，短时间内重试没有意义：熔断一段时间直接降级
_disabled_until = 0.0
_DISABLE_SECONDS = 300


class ModelAPIError(RuntimeError):
    """向量化 / 精排接口不可用（未配置 Key、额度不足、超时、返回结构异常）。"""


# 兼容旧调用方（检索层按这个名字捕获异常）
ZhipuError = ModelAPIError


def _provider() -> str:
    """返回当前生效的向量供应商：siliconflow / zhipu。"""
    name = (settings.embedding_provider or "siliconflow").strip().lower()
    return name if name in ("siliconflow", "zhipu") else "siliconflow"


def _base_url() -> str:
    if _provider() == "siliconflow":
        return settings.siliconflow_api_base.rstrip("/")
    return settings.zhipu_api_base.rstrip("/")


def _api_key() -> str:
    return settings.siliconflow_api_key if _provider() == "siliconflow" else settings.zhipu_api_key


def _key_name() -> str:
    return "SILICONFLOW_API_KEY" if _provider() == "siliconflow" else "ZHIPU_API_KEY"


def _model(kind: str) -> str:
    if _provider() == "siliconflow":
        return settings.siliconflow_embedding_model if kind == "embedding" else settings.siliconflow_rerank_model
    return settings.zhipu_embedding_model if kind == "embedding" else settings.zhipu_rerank_model


def _headers() -> dict[str, str]:
    key = _api_key()
    if not key:
        raise ModelAPIError(f"未配置 {_key_name()}（当前向量供应商：{_provider()}）")
    return {
        "Authorization": f"Bearer {key}",
        "Content-Type": "application/json",
    }


async def _post(path: str, payload: dict) -> dict:
    global _disabled_until
    if time.time() < _disabled_until:
        raise ModelAPIError("embedding/rerank 额度不可用，已临时熔断")
    url = f"{_base_url()}/{path}"
    last_error: Exception | None = None
    for attempt in range(3):
        try:
            async with httpx.AsyncClient(timeout=settings.request_timeout) as client:
                resp = await client.post(url, json=payload, headers=_headers())
            if resp.status_code == 429 or "1113" in resp.text:
                _disabled_until = time.time() + _DISABLE_SECONDS
                raise ModelAPIError(f"{path} 额度不足：{resp.text[:120]}")
            if resp.status_code != 200:
                raise ModelAPIError(f"{path} 返回 HTTP {resp.status_code}：{resp.text[:200]}")
            return resp.json()
        except (httpx.HTTPError, ModelAPIError) as exc:
            last_error = exc
            if isinstance(exc, ModelAPIError) and "额度不足" in str(exc):
                break
            if attempt < 2:
                await asyncio.sleep(1 + attempt)
    raise ModelAPIError(str(last_error))


async def embed_texts(texts: list[str]) -> list[list[float]]:
    """批量向量化，单次请求 64 条，保持输入顺序。"""
    vectors: list[list[float]] = []
    for start in range(0, len(texts), _EMBED_BATCH):
        batch = texts[start : start + _EMBED_BATCH]
        payload: dict = {"model": _model("embedding"), "input": batch}
        # 智谱 embedding-3 支持显式指定维度；硅基流动的 bge-m3 固定 1024 维
        if _provider() == "zhipu":
            payload["dimensions"] = settings.rag_embedding_dims
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
        "model": _model("rerank"),
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
