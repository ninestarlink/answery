"""Neo4j 知识图谱存储：实体页 + 有向关系边。

数据分工：
- pgvector 只存文档切片与向量；
- Neo4j 存实体页（商品 / 制度 / 文档）与 wikilink 关系，检索时先命中实体，
  再在图上做关系扩展（默认 2 跳）并输出可解释路径。

关系层的读写都以本模块为准；Neo4j 未启用或不可用时，wiki.py 退回 PostgreSQL
的 `wiki_pages / wiki_links` 副本，主检索链路（向量 + BM25 + RRF + rerank）不受影响。
"""

from __future__ import annotations

import logging
from datetime import datetime
from typing import Any

from ..config import settings

logger = logging.getLogger("app.rag.graph")

try:
    from neo4j import AsyncGraphDatabase
except ImportError:  # pragma: no cover - 未安装驱动时降级
    AsyncGraphDatabase = None

_driver = None

_SCHEMA_STATEMENTS = (
    "CREATE CONSTRAINT entity_slug IF NOT EXISTS FOR (e:Entity) REQUIRE e.slug IS UNIQUE",
    "CREATE INDEX entity_kb IF NOT EXISTS FOR (e:Entity) ON (e.kb_id)",
)


def _get_driver():
    global _driver
    if not settings.neo4j_enabled:
        return None
    if AsyncGraphDatabase is None:
        raise RuntimeError("未安装 neo4j 驱动，请执行 pip install -r requirements.txt")
    if _driver is None:
        _driver = AsyncGraphDatabase.driver(
            settings.neo4j_uri,
            auth=(settings.neo4j_user, settings.neo4j_password),
        )
    return _driver


def _session():
    driver = _get_driver()
    if driver is None:
        raise RuntimeError("Neo4j 未启用")
    return driver.session(database=settings.neo4j_database)


async def _ensure_schema(session) -> None:
    for statement in _SCHEMA_STATEMENTS:
        await (await session.run(statement)).consume()


async def health() -> dict:
    """返回 Neo4j 版本与实体 / 关系数量，供 /health 与监控页使用。"""
    driver = _get_driver()
    if driver is None:
        return {"enabled": False, "neo4j": "disabled", "entities": 0, "relations": 0}

    async with _session() as session:
        record = await session.run(
            "CALL dbms.components() YIELD versions RETURN versions[0] AS version"
        )
        row = await record.single()
        version = row["version"] if row else "unknown"

        record = await session.run(
            "MATCH (e:Entity) WITH count(e) AS entities "
            "OPTIONAL MATCH ()-[r:RELATED]->() "
            "RETURN entities, count(r) AS relations"
        )
        row = await record.single()
        entities = row["entities"] if row else 0
        relations = row["relations"] if row else 0

    return {
        "enabled": True,
        "neo4j": version,
        "entities": entities,
        "relations": relations,
    }


async def upsert_corpus(kb_id: str, pages: list[Any], links: list[Any]) -> None:
    """整库覆盖写入：先删该库的旧实体与边，再写入实体页和关系。"""
    page_payload = [
        {
            "slug": page.slug,
            "title": page.title,
            "page_type": page.page_type,
            "summary": page.summary,
            "body": page.body,
            "aliases": page.aliases,
            "source_docs": page.source_docs,
        }
        for page in pages
    ]
    link_payload = [
        {
            "source": link.source,
            "target": link.target,
            "relation": link.relation,
            "weight": link.weight,
        }
        for link in links
    ]

    async with _session() as session:
        await _ensure_schema(session)
        tx = await session.begin_transaction()
        try:
            await (
                await tx.run("MATCH (e:Entity {kb_id: $kb_id}) DETACH DELETE e", kb_id=kb_id)
            ).consume()
            await (
                await tx.run(
                    """
                    UNWIND $pages AS p
                    MERGE (e:Entity {slug: p.slug})
                    SET e.kb_id = $kb_id,
                        e.title = p.title,
                        e.page_type = p.page_type,
                        e.summary = p.summary,
                        e.body = p.body,
                        e.aliases = p.aliases,
                        e.source_docs = p.source_docs,
                        e.built_at = $built_at
                    """,
                    pages=page_payload,
                    kb_id=kb_id,
                    built_at=datetime.now().isoformat(timespec="seconds"),
                )
            ).consume()
            await (
                await tx.run(
                    """
                    UNWIND $links AS l
                    MATCH (a:Entity {slug: l.source}), (b:Entity {slug: l.target})
                    MERGE (a)-[r:RELATED {relation: l.relation}]->(b)
                    SET r.weight = l.weight
                    """,
                    links=link_payload,
                )
            ).consume()
            await tx.commit()
        except Exception:
            await tx.rollback()
            raise


async def load_corpus(kb_id: str) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    """读回一个知识库的实体页与关系边，字段与旧 PostgreSQL 表保持一致。"""
    async with _session() as session:
        result = await session.run(
            """
            MATCH (e:Entity {kb_id: $kb_id})
            RETURN e ORDER BY e.page_type DESC, e.title
            """,
            kb_id=kb_id,
        )
        pages = [dict(record["e"]) for record in [r async for r in result]]

        result = await session.run(
            """
            MATCH (a:Entity {kb_id: $kb_id})-[r:RELATED]->(b:Entity)
            RETURN a.slug AS source_slug, b.slug AS target_slug,
                   r.relation AS relation, coalesce(r.weight, 1) AS weight
            """,
            kb_id=kb_id,
        )
        links = [
            {
                "kb_id": kb_id,
                "source_slug": record["source_slug"],
                "target_slug": record["target_slug"],
                "relation": record["relation"],
                "weight": int(record["weight"] or 1),
            }
            async for record in result
        ]

    for page in pages:
        page["aliases"] = list(page.get("aliases") or [])
        page["source_docs"] = list(page.get("source_docs") or [])
    return pages, links


async def count_pages(kb_id: str | None = None) -> int:
    async with _session() as session:
        result = await session.run(
            "MATCH (e:Entity) WHERE ($kb_id IS NULL OR e.kb_id = $kb_id) RETURN count(e) AS c",
            kb_id=kb_id,
        )
        record = await result.single()
        return int(record["c"]) if record else 0


async def page_detail(slug: str) -> dict[str, Any] | None:
    """实体页详情：属性 + 出边 + 入边（backlink）。"""
    async with _session() as session:
        result = await session.run("MATCH (e:Entity {slug: $slug}) RETURN e", slug=slug)
        record = await result.single()
        if record is None:
            return None
        page = dict(record["e"])

        result = await session.run(
            """
            MATCH (e:Entity {slug: $slug})-[r:RELATED]->(t:Entity)
            RETURN t.slug AS target_slug, r.relation AS relation,
                   t.title AS target_title, t.page_type AS target_type
            """,
            slug=slug,
        )
        outbound = [dict(record) async for record in result]

        result = await session.run(
            """
            MATCH (s:Entity)-[r:RELATED]->(e:Entity {slug: $slug})
            RETURN s.slug AS source_slug, r.relation AS relation,
                   s.title AS source_title, s.page_type AS source_type
            """,
            slug=slug,
        )
        inbound = [dict(record) async for record in result]

    page["aliases"] = list(page.get("aliases") or [])
    page["source_docs"] = list(page.get("source_docs") or [])
    return {"page": page, "links": outbound, "backlinks": inbound}


async def expand(
    start_slugs: list[str],
    hops: int = 2,
    limit: int = 200,
) -> list[dict[str, Any]]:
    """从命中的实体页出发做 N 跳扩展（无向），返回可解释的关系路径。

    每条路径都带上完整节点链与逐边关系名，供检索侧拼上下文、也供路径解释接口复用。
    """
    if not start_slugs:
        return []
    depth = max(1, min(int(hops), 3))
    async with _session() as session:
        result = await session.run(
            f"""
            MATCH (start:Entity) WHERE start.slug IN $slugs
            MATCH p = (start)-[:RELATED*1..{depth}]-(end:Entity)
            WHERE end.slug <> start.slug
            WITH start, end, p, length(p) AS hops
            ORDER BY hops
            RETURN start.slug AS from_slug,
                   end.slug AS to_slug,
                   hops,
                   [n IN nodes(p) | n.slug] AS nodes,
                   [n IN nodes(p) | coalesce(n.title, n.slug)] AS titles,
                   [n IN nodes(p) | coalesce(n.page_type, 'section')] AS types,
                   [n IN nodes(p) | coalesce(n.summary, '')] AS summaries,
                   [n IN nodes(p) | coalesce(n.source_docs, [])] AS docs,
                   [r IN relationships(p) | r.relation] AS relations,
                   [r IN relationships(p) | startNode(r).slug] AS sources
            LIMIT $limit
            """,
            slugs=list(start_slugs),
            limit=int(limit),
        )
        return [dict(record) async for record in result]


async def shortest_path(
    from_slug: str,
    to_slug: str,
    max_hops: int = 3,
) -> dict[str, Any] | None:
    """两个实体之间的最短关系路径，用于解释「这两个东西为什么相关」。"""
    depth = max(1, min(int(max_hops), 4))
    async with _session() as session:
        result = await session.run(
            f"""
            MATCH (a:Entity {{slug: $from_slug}}), (b:Entity {{slug: $to_slug}})
            MATCH p = shortestPath((a)-[:RELATED*1..{depth}]-(b))
            RETURN [n IN nodes(p) | {{slug: n.slug, title: n.title,
                                      page_type: n.page_type, kb_id: n.kb_id}}] AS nodes,
                   [r IN relationships(p) | {{relation: r.relation,
                                              source: startNode(r).slug,
                                              target: endNode(r).slug}}] AS edges
            """,
            from_slug=from_slug,
            to_slug=to_slug,
        )
        record = await result.single()
        if record is None:
            return None
        nodes = [dict(item) for item in record["nodes"]]
        edges = [dict(item) for item in record["edges"]]
    return {"hops": max(0, len(nodes) - 1), "nodes": nodes, "edges": edges}


async def close() -> None:
    global _driver
    if _driver is not None:
        await _driver.close()
        _driver = None
