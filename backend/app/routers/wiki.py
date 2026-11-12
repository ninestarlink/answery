"""知识图谱关系层管理接口：总览、实体页、关系检索、图谱与重建。

控制台「知识网络」页直接消费这一组接口：左侧实体列表、右侧实体页（出边 / 入边）、
顶部关系检索用于演示「先命中实体，再沿关系取邻居」。
"""

from __future__ import annotations

import logging

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field

from ..config import settings
from ..rag import graph_store, registry, wiki
from .auth import require_admin

logger = logging.getLogger("wiki.api")

router = APIRouter(prefix="/api/admin/wiki", tags=["wiki"], dependencies=[Depends(require_admin)])


class RebuildRequest(BaseModel):
    kb_id: str = Field(default="all", description="shop / enterprise / all")


def _assert_kb(kb_id: str) -> None:
    if kb_id != "all" and not registry.get_kb(kb_id):
        raise HTTPException(status_code=404, detail=f"未知知识库：{kb_id}")


@router.get("/overview")
async def overview(kb_id: str = Query(default="all")):
    """实体页 / 关系边 / 别名规模 + 入度最高的实体。"""
    _assert_kb(kb_id)
    total = (await wiki.stats())["pages"] if kb_id == "all" else (await wiki.stats(kb_id))["pages"]
    if total == 0:
        # 新环境首次打开知识网络页时后台建一次，避免空白演示
        await wiki.ensure_built()
    try:
        data = await wiki.stats(None if kb_id == "all" else kb_id)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=503, detail=f"关系索引不可用：{exc}") from exc
    return {**data, "enabled": settings.wiki_enabled, "kb_id": kb_id}


@router.get("/pages")
async def pages(
    kb_id: str = Query(default="all"),
    q: str | None = Query(default=None, max_length=80),
    page_type: str | None = Query(default=None, pattern="^(product|policy|section)$"),
    limit: int = Query(default=100, ge=1, le=300),
):
    _assert_kb(kb_id)
    try:
        items = await wiki.list_pages(
            None if kb_id == "all" else kb_id, q=q, page_type=page_type, limit=limit
        )
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=503, detail=f"关系索引不可用：{exc}") from exc
    return {"items": items, "total": len(items)}


@router.get("/pages/{slug}")
async def page_detail(slug: str):
    try:
        data = await wiki.get_page(slug)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=503, detail=f"关系索引不可用：{exc}") from exc
    if data is None:
        raise HTTPException(status_code=404, detail="实体页不存在，请先重建关系索引")
    return data


@router.get("/search")
async def search(
    q: str = Query(min_length=1, max_length=120),
    kb_id: str = Query(default="all"),
):
    """关系检索：实体命中 + N 跳邻居（默认 2 跳）+ 可注入提示词的关系上下文。"""
    _assert_kb(kb_id)
    targets = list(registry.KBS) if kb_id == "all" else [kb_id]
    items: list[dict] = []
    paths: list[dict] = []
    contexts: list[str] = []
    for item in targets:
        try:
            result = await wiki.retrieve(item, q)
        except Exception as exc:  # noqa: BLE001
            raise HTTPException(status_code=503, detail=f"关系检索不可用：{exc}") from exc
        items.extend(result["pages"])
        paths.extend(result["paths"])
        if result["context"]:
            contexts.append(result["context"])
    return {
        "query": q,
        "kb_id": kb_id,
        "pages": items[:8],
        "paths": paths[:12],
        "context": "\n\n".join(contexts)[: settings.wiki_context_chars * 2],
    }


@router.get("/path")
async def explain_path(
    from_slug: str = Query(alias="from", min_length=1, max_length=80),
    to_slug: str = Query(alias="to", min_length=1, max_length=80),
    max_hops: int = Query(default=3, ge=1, le=4),
):
    """路径解释：两个实体在 Neo4j 上的最短关系链（方向无关，最多 4 跳）。"""
    if not settings.neo4j_enabled:
        raise HTTPException(status_code=503, detail="Neo4j 未启用，路径解释不可用")
    try:
        data = await graph_store.shortest_path(from_slug, to_slug, max_hops)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=503, detail=f"图查询不可用：{exc}") from exc
    if data is None:
        raise HTTPException(status_code=404, detail="两个实体之间没有可达路径")
    return {"from": from_slug, "to": to_slug, **data}


@router.get("/graph")
async def graph(
    kb_id: str = Query(default="all"),
    limit: int = Query(default=120, ge=10, le=300),
):
    _assert_kb(kb_id)
    try:
        return await wiki.graph(None if kb_id == "all" else kb_id, limit=limit)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=503, detail=f"关系索引不可用：{exc}") from exc


@router.post("/rebuild")
async def rebuild(payload: RebuildRequest):
    """重建关系索引：只解析源文件，不影响向量索引。"""
    _assert_kb(payload.kb_id)
    try:
        if payload.kb_id == "all":
            items = await wiki.build_all()
        else:
            items = [await wiki.build_kb(payload.kb_id)]
    except Exception as exc:  # noqa: BLE001
        logger.exception("知识图谱关系层重建失败")
        raise HTTPException(status_code=500, detail=f"重建失败：{exc}") from exc
    return {"items": items}
