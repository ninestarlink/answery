"""数据库与 Redis 连接管理。

MySQL 用 SQLAlchemy 2.0 异步引擎（aiomysql 驱动），
Redis 用 redis.asyncio，流式响应中会单独创建会话，避免依赖注入的生命周期问题。
"""

from collections.abc import AsyncGenerator

import redis.asyncio as aioredis
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from sqlalchemy.orm import DeclarativeBase

from .config import settings


class Base(DeclarativeBase):
    """所有 ORM 模型的基类。"""


engine = create_async_engine(
    settings.mysql_dsn,
    echo=False,
    pool_pre_ping=True,
    pool_recycle=1800,
)

# expire_on_commit=False：提交后仍可读取对象属性，避免额外查询
SessionLocal = async_sessionmaker(engine, expire_on_commit=False)


async def get_db() -> AsyncGenerator[AsyncSession, None]:
    """FastAPI 依赖：每个请求一个数据库会话。"""
    async with SessionLocal() as session:
        yield session


_redis_client: aioredis.Redis | None = None


def get_redis() -> aioredis.Redis:
    """懒加载 Redis 客户端（连接池内部复用，不需要每次新建）。"""
    global _redis_client
    if _redis_client is None:
        _redis_client = aioredis.from_url(
            settings.redis_url,
            decode_responses=True,
            socket_connect_timeout=2,
        )
    return _redis_client
