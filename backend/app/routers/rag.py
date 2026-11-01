"""知识库接口：检索、文档清单、索引构建、健康检查。

前端不直接拼检索参数，只传 kb_id + query；返回的 evidence 用于「参考来源」卡片。
"""

from __future__ import annotations

import logging

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from ..rag import ingest, registry, retriever, store, zhipu
from .auth import require_admin

logger = logging.getLogger("rag.api")

router = APIRouter(prefix="/api/rag", tags=["rag"])


class SearchRequest(BaseModel):
    kb_id: str = Field(..., description="shop / enterprise")
    query: str
    top_k: int | None = None
    use_rerank: bool = True


class IngestRequest(BaseModel):
    kb_id: str = Field("all", description="shop / enterprise / all")
    force: bool = False


@router.get("/kbs")
async def list_kbs():
    """知识库清单 + 当前索引规模，前端知识库页直接渲染。"""
    items = []
    for kb in registry.KBS.values():
        try:
            stats = await store.kb_stats(kb.kb_id)
        except Exception as exc:  # 向量库没起来时仍然展示配置
            logger.warning("读取知识库统计失败：%s", exc)
            stats = {"docs": 0, "chunks": 0, "parents": 0}
        items.append({**next(x for x in registry.kb_summary() if x["kb_id"] == kb.kb_id), **stats})
    return {"items": items}


@router.get("/kbs/{kb_id}/documents")
async def list_documents(kb_id: str):
    if not registry.get_kb(kb_id):
        raise HTTPException(status_code=404, detail=f"未知知识库：{kb_id}")
    try:
        rows = await store.list_documents(kb_id)
    except Exception as exc:
        raise HTTPException(status_code=503, detail=f"向量库不可用：{exc}") from exc
    return {"items": rows}


@router.post("/search")
async def search(req: SearchRequest):
    if not registry.get_kb(req.kb_id):
        raise HTTPException(status_code=404, detail=f"未知知识库：{req.kb_id}")
    try:
        result = await retriever.search(
            req.kb_id, req.query, top_k=req.top_k, use_rerank=req.use_rerank
        )
    except Exception as exc:
        raise HTTPException(status_code=503, detail=f"检索失败：{exc}") from exc

    hits = [
        {
            "chunk_id": h["chunk_id"],
            "parent_id": h.get("parent_id"),
            "section": h.get("section"),
            "page": h.get("page"),
            "score": round(float(h.get("final_score") or 0), 4),
            "content": (h.get("content") or "")[:200],
        }
        for h in result["hits"]
    ]
    return {
        "kb_id": req.kb_id,
        "query": req.query,
        "hits": hits,
        "evidence": result["evidence"],
        "timings": result["timings"],
        "degraded": result["degraded"],
    }


@router.post("/ingest")
async def rebuild(req: IngestRequest, _: object = Depends(require_admin)):
    """重建索引：仅管理员可操作，演示时可在知识库页面一键触发。"""
    targets = list(registry.KBS) if req.kb_id == "all" else [req.kb_id]
    results = []
    for kb_id in targets:
        if not registry.get_kb(kb_id):
            raise HTTPException(status_code=404, detail=f"未知知识库：{kb_id}")
        try:
            results.append(await ingest.ingest_kb(kb_id, force=req.force))
        except Exception as exc:
            raise HTTPException(status_code=500, detail=f"{kb_id} 重建失败：{exc}") from exc
    return {"items": results}


@router.get("/health")
async def health():
    checks = {"pgvector": "ok", "zhipu_key": "ok" if zhipu.settings.zhipu_api_key else "missing"}
    try:
        pg = await store.health()
    except Exception as exc:
        pg = {"status": "down", "error": str(exc)}
    return {"pgvector": pg, "zhipu": checks}
