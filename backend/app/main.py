"""FastAPI 入口：注册路由、CORS、启动自检。

自检只打日志不阻断启动：没启动 MySQL 时也能看到明确的报错原因，
而不是一个干巴巴的 500。
"""

import asyncio
import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy import text

from .config import settings
from .database import SessionLocal, engine, get_redis
from .rag import store as rag_store
from .rag import wiki as wiki_store
from .rag import graph_store
from .routers import admin, auth, chat, eval, rag, sandbox, tickets, tools, wiki as wiki_router
from . import sandbox as sandbox_service

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s - %(message)s",
)
logger = logging.getLogger("app")


@asynccontextmanager
async def lifespan(app: FastAPI):
    try:
        async with SessionLocal() as db:
            await db.execute(text("SELECT 1"))
        logger.info(
            "MySQL 连接正常：%s:%s/%s",
            settings.mysql_host,
            settings.mysql_port,
            settings.mysql_db,
        )
    except Exception as exc:
        logger.warning("MySQL 暂不可用（%s），请先执行 docker compose up -d", exc)

    try:
        await get_redis().ping()
        logger.info("Redis 连接正常")
    except Exception as exc:
        logger.warning("Redis 暂不可用（%s），上下文记忆会退化为单轮", exc)

    try:
        info = await rag_store.health()
        logger.info("pgvector 连接正常：版本 %s，切片 %s 条", info["pgvector"], info["chunks"])
    except Exception as exc:
        logger.warning("pgvector 暂不可用（%s），知识库检索会降级；请执行 docker compose up -d", exc)

    if settings.neo4j_enabled:
        try:
            info = await graph_store.health()
            logger.info(
                "Neo4j 连接正常：版本 %s，实体 %s 个，关系 %s 条",
                info["neo4j"],
                info["entities"],
                info["relations"],
            )
        except Exception as exc:
            logger.warning(
                "Neo4j 暂不可用（%s），图关系召回会降级；请执行 docker compose up -d", exc
            )

    if not settings.zhipu_api_key:
        logger.warning("ZHIPU_API_KEY 未配置：聊天与工单分析都会返回明确提示")
    if settings.embedding_provider == "siliconflow" and not settings.siliconflow_api_key:
        logger.warning("SILICONFLOW_API_KEY 未配置：向量检索会降级为 BM25（对话不受影响）")

    await sandbox_service.warm_up()

    # 关系索引为空时后台建一次：不阻塞启动，失败也不影响 RAG 主链路
    if settings.wiki_enabled:
        app.state.wiki_build_task = asyncio.create_task(wiki_store.ensure_built())

    yield

    await sandbox_service.shutdown()
    await rag_store.close_pool()
    await graph_store.close()
    await engine.dispose()


app = FastAPI(title=settings.app_name, version="0.1.0", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origin_list,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(auth.router)
app.include_router(chat.router)
app.include_router(tools.router)
app.include_router(tickets.router)
app.include_router(rag.router)
app.include_router(admin.router)
app.include_router(eval.router)
app.include_router(wiki_router.router)
app.include_router(sandbox.router)


@app.get("/health", tags=["system"])
async def health():
    """健康检查：前端联调时先看这里，能快速定位是哪个依赖没起来。"""
    status = {
        "app": "ok",
        "mysql": "ok",
        "redis": "ok",
        "pgvector": "ok",
        "neo4j": "ok" if settings.neo4j_enabled else "disabled",
        "zhipu_api_key": bool(settings.zhipu_api_key),
        "embedding_provider": settings.embedding_provider,
        "embedding_api_key": bool(
            settings.siliconflow_api_key
            if settings.embedding_provider == "siliconflow"
            else settings.zhipu_api_key
        ),
    }
    try:
        async with SessionLocal() as db:
            await db.execute(text("SELECT 1"))
    except Exception:
        status["mysql"] = "down"
    try:
        await get_redis().ping()
    except Exception:
        status["redis"] = "down"
    try:
        await rag_store.health()
    except Exception:
        status["pgvector"] = "down"
    if settings.neo4j_enabled:
        try:
            await graph_store.health()
        except Exception:
            status["neo4j"] = "down"
    return status
