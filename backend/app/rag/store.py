"""pgvector 存储层：文档元数据 + 父子切片 + 向量索引。

设计：
- 父块与子块同表，用 is_parent 区分；父块 embedding 为 NULL，只做上下文展开。
- 文档级 file_hash 用于增量重建：源文件没变就跳过。
- 向量维度由配置固定，换 embedding 模型需要重建索引（写入前校验）。
"""

from __future__ import annotations

import asyncio
import logging
from typing import Any

import asyncpg

from ..config import settings
from .chunker import ChildChunk, ParentChunk
from .parser import ParsedDoc

logger = logging.getLogger("rag.store")

_pool: asyncpg.Pool | None = None
_init_lock = asyncio.Lock()


def _vector_literal(values: list[float]) -> str:
    return "[" + ",".join(f"{v:.6f}" for v in values) + "]"


async def _init_schema(conn: asyncpg.Connection) -> None:
    dims = settings.rag_embedding_dims
    await conn.execute("CREATE EXTENSION IF NOT EXISTS vector")
    await conn.execute(
        f"""
        CREATE TABLE IF NOT EXISTS rag_documents (
            kb_id TEXT NOT NULL,
            doc_id TEXT NOT NULL,
            doc_name TEXT NOT NULL,
            doc_no TEXT,
            version TEXT,
            source_file TEXT NOT NULL,
            file_hash TEXT NOT NULL,
            page_count INT DEFAULT 0,
            updated_at TIMESTAMPTZ DEFAULT now(),
            PRIMARY KEY (kb_id, doc_id)
        )
        """
    )
    await conn.execute(
        f"""
        CREATE TABLE IF NOT EXISTS rag_chunks (
            chunk_id TEXT PRIMARY KEY,
            kb_id TEXT NOT NULL,
            doc_id TEXT NOT NULL,
            parent_id TEXT,
            is_parent BOOLEAN NOT NULL DEFAULT FALSE,
            content TEXT NOT NULL,
            embedding vector({dims}),
            section TEXT,
            page INT,
            doc_no TEXT,
            version TEXT,
            doc_name TEXT,
            source_file TEXT,
            status TEXT NOT NULL DEFAULT 'active',
            created_at TIMESTAMPTZ DEFAULT now()
        )
        """
    )
    # 已有表的维度不一致时直接报错，避免静默写入错维度
    actual = await conn.fetchval(
        "SELECT format_type(atttypid, atttypmod) FROM pg_attribute "
        "WHERE attrelid = 'rag_chunks'::regclass AND attname = 'embedding'"
    )
    expected = f"vector({dims})"
    if actual and actual != expected:
        raise RuntimeError(f"rag_chunks.embedding 维度为 {actual}，配置要求 {expected}，请重建索引表")

    await conn.execute(
        "CREATE INDEX IF NOT EXISTS rag_chunks_kb_idx ON rag_chunks (kb_id, is_parent, status)"
    )
    await conn.execute(
        "CREATE INDEX IF NOT EXISTS rag_documents_kb_idx ON rag_documents (kb_id)"
    )
    try:
        await conn.execute(
            "CREATE INDEX IF NOT EXISTS rag_chunks_vec_idx ON rag_chunks "
            "USING hnsw (embedding vector_cosine_ops) WITH (m = 16, ef_construction = 64)"
        )
    except Exception as exc:  # 维度超限或 pgvector 版本过旧时退化为顺序扫描
        logger.warning("HNSW 索引创建失败，退化为顺序扫描：%s", exc)


async def get_pool() -> asyncpg.Pool:
    global _pool
    if _pool is not None:
        return _pool
    async with _init_lock:
        if _pool is None:
            pool = await asyncpg.create_pool(settings.pg_dsn, min_size=1, max_size=5, command_timeout=30)
            async with pool.acquire() as conn:
                await _init_schema(conn)
            _pool = pool
    return _pool


async def close_pool() -> None:
    global _pool
    if _pool is not None:
        await _pool.close()
        _pool = None


async def health() -> dict:
    pool = await get_pool()
    async with pool.acquire() as conn:
        version = await conn.fetchval("SELECT extversion FROM pg_extension WHERE extname='vector'")
        count = await conn.fetchval("SELECT count(*) FROM rag_chunks")
    return {"status": "ok", "pgvector": version, "chunks": int(count or 0)}


async def get_document_hash(kb_id: str, doc_id: str) -> str | None:
    pool = await get_pool()
    async with pool.acquire() as conn:
        return await conn.fetchval(
            "SELECT file_hash FROM rag_documents WHERE kb_id=$1 AND doc_id=$2", kb_id, doc_id
        )


async def replace_document(
    kb_id: str,
    doc: ParsedDoc,
    parents: list[ParentChunk],
    children: list[ChildChunk],
    vectors: list[list[float]] | None,
) -> None:
    """整篇替换：先删旧切片再写入，保证更新文档不会残留过期内容。

    vectors 为 None 表示 embedding 服务不可用，只建关键词索引；
    此时子块 embedding 为 NULL，检索自动退化为 BM25。
    """
    if vectors is not None and len(children) != len(vectors):
        raise ValueError("子块数量与向量数量不一致")
    pool = await get_pool()
    async with pool.acquire() as conn:
        async with conn.transaction():
            await conn.execute("DELETE FROM rag_chunks WHERE kb_id=$1 AND doc_id=$2", kb_id, doc.doc_id)
            await conn.execute(
                """
                INSERT INTO rag_documents
                    (kb_id, doc_id, doc_name, doc_no, version, source_file, file_hash, page_count, updated_at)
                VALUES ($1,$2,$3,$4,$5,$6,$7,$8,now())
                ON CONFLICT (kb_id, doc_id) DO UPDATE SET
                    doc_name=EXCLUDED.doc_name, doc_no=EXCLUDED.doc_no, version=EXCLUDED.version,
                    source_file=EXCLUDED.source_file, file_hash=EXCLUDED.file_hash,
                    page_count=EXCLUDED.page_count, updated_at=now()
                """,
                kb_id,
                doc.doc_id,
                doc.doc_name,
                doc.doc_no,
                doc.version,
                doc.source_file,
                doc.file_hash,
                len(doc.pages),
            )

            parent_rows = [
                (
                    p.parent_id,
                    kb_id,
                    doc.doc_id,
                    None,
                    True,
                    p.content,
                    p.section,
                    p.page,
                    doc.doc_no,
                    doc.version,
                    doc.doc_name,
                    doc.source_file,
                )
                for p in parents
            ]
            await conn.executemany(
                """
                INSERT INTO rag_chunks
                    (chunk_id, kb_id, doc_id, parent_id, is_parent, content, section, page,
                     doc_no, version, doc_name, source_file)
                VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
                """,
                parent_rows,
            )

            child_rows = [
                (
                    c.chunk_id,
                    kb_id,
                    doc.doc_id,
                    c.parent_id,
                    False,
                    c.content,
                    _vector_literal(vector) if vector is not None else None,
                    c.section,
                    c.page,
                    doc.doc_no,
                    doc.version,
                    doc.doc_name,
                    doc.source_file,
                )
                for c, vector in zip(children, vectors or [None] * len(children))
            ]
            # embedding 用参数化向量字面量写入，避免拼 SQL
            await conn.executemany(
                """
                INSERT INTO rag_chunks
                    (chunk_id, kb_id, doc_id, parent_id, is_parent, content, embedding,
                     section, page, doc_no, version, doc_name, source_file)
                VALUES ($1,$2,$3,$4,$5,$6,$7::vector,$8,$9,$10,$11,$12,$13)
                """,
                child_rows,
            )


async def dense_search(kb_id: str, vector: list[float], top_k: int) -> list[dict[str, Any]]:
    pool = await get_pool()
    async with pool.acquire() as conn:
        rows = await conn.fetch(
            """
            SELECT chunk_id, parent_id, content, section, page, doc_name, doc_no, version,
                   1 - (embedding <=> $1::vector) AS score
            FROM rag_chunks
            WHERE kb_id=$2 AND is_parent=FALSE AND status='active' AND embedding IS NOT NULL
            ORDER BY embedding <=> $1::vector
            LIMIT $3
            """,
            _vector_literal(vector),
            kb_id,
            top_k,
        )
    return [dict(r) for r in rows]


async def all_children(kb_id: str) -> list[dict[str, Any]]:
    pool = await get_pool()
    async with pool.acquire() as conn:
        rows = await conn.fetch(
            """
            SELECT chunk_id, parent_id, content, section, page, doc_name, doc_no, version
            FROM rag_chunks
            WHERE kb_id=$1 AND is_parent=FALSE AND status='active'
            """,
            kb_id,
        )
    return [dict(r) for r in rows]


async def children_by_ids(kb_id: str, ids: list[str]) -> list[dict[str, Any]]:
    if not ids:
        return []
    pool = await get_pool()
    async with pool.acquire() as conn:
        rows = await conn.fetch(
            """
            SELECT chunk_id, parent_id, content, section, page, doc_name, doc_no, version
            FROM rag_chunks
            WHERE kb_id=$1 AND is_parent=FALSE AND chunk_id = ANY($2::text[])
            """,
            kb_id,
            ids,
        )
    return [dict(r) for r in rows]


async def parents_by_ids(kb_id: str, parent_ids: list[str]) -> dict[str, dict[str, Any]]:
    if not parent_ids:
        return {}
    pool = await get_pool()
    async with pool.acquire() as conn:
        rows = await conn.fetch(
            """
            SELECT chunk_id, content, section, page, doc_name, doc_no, version
            FROM rag_chunks
            WHERE kb_id=$1 AND is_parent=TRUE AND chunk_id = ANY($2::text[])
            """,
            kb_id,
            parent_ids,
        )
    return {r["chunk_id"]: dict(r) for r in rows}


async def prune_documents(kb_id: str, keep_doc_ids: list[str]) -> int:
    """删除源文件已不存在的旧文档，避免知识库里残留过期内容。"""
    pool = await get_pool()
    async with pool.acquire() as conn:
        removed = await conn.execute(
            "DELETE FROM rag_chunks WHERE kb_id=$1 AND doc_id <> ALL($2::text[])", kb_id, keep_doc_ids
        )
        await conn.execute(
            "DELETE FROM rag_documents WHERE kb_id=$1 AND doc_id <> ALL($2::text[])", kb_id, keep_doc_ids
        )
    try:
        return int(removed.split()[-1])
    except (ValueError, IndexError):
        return 0


async def list_documents(kb_id: str) -> list[dict[str, Any]]:
    pool = await get_pool()
    async with pool.acquire() as conn:
        rows = await conn.fetch(
            """
            SELECT d.doc_id, d.doc_name, d.doc_no, d.version, d.source_file, d.page_count,
                   d.updated_at,
                   (SELECT count(*) FROM rag_chunks c
                    WHERE c.kb_id=d.kb_id AND c.doc_id=d.doc_id AND c.is_parent=FALSE) AS child_count,
                   (SELECT count(*) FROM rag_chunks c
                    WHERE c.kb_id=d.kb_id AND c.doc_id=d.doc_id AND c.is_parent=TRUE) AS parent_count
            FROM rag_documents d
            WHERE d.kb_id=$1
            ORDER BY d.doc_name
            """,
            kb_id,
        )
    return [dict(r) for r in rows]


async def kb_stats(kb_id: str) -> dict[str, Any]:
    pool = await get_pool()
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            """
            SELECT count(*) FILTER (WHERE is_parent=FALSE) AS chunks,
                   count(*) FILTER (WHERE is_parent=TRUE) AS parents,
                   count(DISTINCT doc_id) AS docs
            FROM rag_chunks WHERE kb_id=$1 AND status='active'
            """,
            kb_id,
        )
    return {k: int(v or 0) for k, v in dict(row).items()}
