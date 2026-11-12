"""Neo4j 知识图谱存储。

Phase 0 只提供连接与健康检查；实体页 / 关系边的读写放在 Phase 1，
避免在基础设施未验证前改动检索主链路。
"""

from __future__ import annotations

import logging

from ..config import settings

logger = logging.getLogger("app.rag.graph")

try:
    from neo4j import AsyncGraphDatabase
except ImportError:  # pragma: no cover - 未安装驱动时降级
    AsyncGraphDatabase = None

_driver = None


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


async def health() -> dict:
    """返回 Neo4j 版本与实体 / 关系数量，供 /health 与监控页使用。"""
    driver = _get_driver()
    if driver is None:
        return {"enabled": False, "neo4j": "disabled", "entities": 0, "relations": 0}

    async with driver.session(database=settings.neo4j_database) as session:
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


async def close() -> None:
    global _driver
    if _driver is not None:
        await _driver.close()
        _driver = None
