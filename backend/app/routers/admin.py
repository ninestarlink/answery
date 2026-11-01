"""运营控制台只读接口：首页概览、数据库浏览、知识库文档、系统监控。

全部为演示用的只读查询，不做任何写操作。
"""

from __future__ import annotations

import logging
import re
import time
from datetime import date, datetime, timedelta
from decimal import Decimal
from pathlib import Path

import httpx
from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import FileResponse
from sqlalchemy import text

from ..config import settings
from ..database import SessionLocal, get_redis
from ..rag import store as rag_store
from .auth import require_admin

logger = logging.getLogger("admin")

# 控制台全部接口都要求管理员角色
router = APIRouter(prefix="/api/admin", tags=["admin"], dependencies=[Depends(require_admin)])

# 允许在「数据库」页浏览的表（白名单，避免任意 SQL）
ALLOWED_TABLES: dict[str, str] = {
    "products": "商品主表",
    "product_variants": "商品 SKU 与库存",
    "orders": "订单主表",
    "order_items": "订单明细",
    "customers": "客户",
    "shipments": "物流单",
    "shipment_events": "物流轨迹",
    "coupons": "优惠券",
    "store_policies": "店铺政策",
    "talk_templates": "话术模板",
    "chat_history": "会话记录与 Token 记账",
    "chat_trace": "对话执行轨迹（检索命中 / 工具 / 中断 / 延迟）",
    "tickets": "IT 工单（规则引擎自动生成）",
}

# 知识库源文件（与 pgvector 索引同源）
# 源文件在 shop_kb/ 下，这里按文件位置推导，避免写死绝对路径
KB_DOCS_DIR = Path(__file__).resolve().parents[3] / "shop_kb"
KB_FILES = [p.name for p in sorted(KB_DOCS_DIR.glob("*.md"))]
# 企业制度知识库：多格式源文件，检索与索引都在本项目内完成
ENTERPRISE_KB_DIR = Path(__file__).resolve().parents[3] / "enterprise_kb"
ENTERPRISE_FORMATS = {".md", ".pdf", ".docx", ".xlsx"}

_started_at = time.time()


def _jsonable(value):
    if isinstance(value, (datetime, date)):
        return value.isoformat(sep=" ") if isinstance(value, datetime) else value.isoformat()
    if isinstance(value, Decimal):
        return float(value)
    if isinstance(value, bytes):
        return value.decode("utf-8", errors="replace")
    return value


async def _scalar(sql: str, **params) -> int:
    async with SessionLocal() as db:
        result = await db.execute(text(sql), params)
        value = result.scalar()
    return int(value or 0)


@router.get("/overview")
async def overview():
    """首页概览：核心指标 + 近 7 天 token 趋势 + 最近会话 + 最近订单。"""
    stats = {
        "products": await _scalar("SELECT COUNT(*) FROM products"),
        "orders": await _scalar("SELECT COUNT(*) FROM orders"),
        "customers": await _scalar("SELECT COUNT(*) FROM customers"),
        "coupons": await _scalar("SELECT COUNT(*) FROM coupons"),
        "conversations": await _scalar("SELECT COUNT(DISTINCT session_id) FROM chat_history"),
        "messages": await _scalar("SELECT COUNT(*) FROM chat_history"),
        "tokens_today": await _scalar(
            "SELECT COALESCE(SUM(total_tokens),0) FROM chat_history WHERE DATE(created_at)=CURDATE()"
        ),
        "tokens_total": await _scalar("SELECT COALESCE(SUM(total_tokens),0) FROM chat_history"),
    }

    async with SessionLocal() as db:
        trend_rows = (
            await db.execute(
                text(
                    """
                    SELECT DATE(created_at) AS day,
                           COALESCE(SUM(total_tokens),0) AS tokens,
                           COUNT(*) AS messages
                    FROM chat_history
                    WHERE created_at >= DATE_SUB(CURDATE(), INTERVAL 6 DAY)
                    GROUP BY DATE(created_at)
                    ORDER BY day
                    """
                )
            )
        ).mappings().all()

        recent = (
            await db.execute(
                text(
                    """
                    SELECT id, session_id, role, LEFT(content, 120) AS content,
                           total_tokens, created_at
                    FROM chat_history
                    ORDER BY id DESC
                    LIMIT 8
                    """
                )
            )
        ).mappings().all()

        orders = (
            await db.execute(
                text(
                    """
                    SELECT id, customer_id, status, total_amount, created_at
                    FROM orders
                    ORDER BY created_at DESC
                    LIMIT 6
                    """
                )
            )
        ).mappings().all()

    # 补齐没有数据的日期，保证折线图连续
    by_day = {str(r["day"]): r for r in trend_rows}
    trend = []
    for i in range(6, -1, -1):
        d = (date.today() - timedelta(days=i)).isoformat()
        row = by_day.get(d)
        trend.append(
            {
                "day": d,
                "tokens": int(row["tokens"]) if row else 0,
                "messages": int(row["messages"]) if row else 0,
            }
        )

    return {
        "stats": stats,
        "trend": trend,
        "recent_chats": [
            {k: _jsonable(v) for k, v in r.items()} for r in recent
        ],
        "recent_orders": [
            {k: _jsonable(v) for k, v in r.items()} for r in orders
        ],
    }


@router.get("/db/tables")
async def db_tables():
    """数据库页：白名单表的行数与表说明。"""
    counts: dict[str, int] = {}
    async with SessionLocal() as db:
        for name in ALLOWED_TABLES:
            try:
                result = await db.execute(text(f"SELECT COUNT(*) FROM `{name}`"))
                counts[name] = int(result.scalar() or 0)
            except Exception:
                counts[name] = -1
    return {
        "database": settings.mysql_db,
        "tables": [
            {"name": name, "comment": comment, "rows": counts.get(name, 0)}
            for name, comment in ALLOWED_TABLES.items()
        ],
    }


@router.get("/db/tables/{name}")
async def db_rows(
    name: str,
    limit: int = Query(default=20, ge=1, le=100),
    offset: int = Query(default=0, ge=0),
):
    """数据库页：查看单张表的数据（只读，最多 100 行）。"""
    if name not in ALLOWED_TABLES:
        raise HTTPException(status_code=404, detail="表不存在或未开放浏览")

    async with SessionLocal() as db:
        count = (await db.execute(text(f"SELECT COUNT(*) FROM `{name}`"))).scalar() or 0
        result = await db.execute(
            text(f"SELECT * FROM `{name}` LIMIT :limit OFFSET :offset"),
            {"limit": limit, "offset": offset},
        )
        columns = list(result.keys())
        rows = [
            {col: _jsonable(val) for col, val in zip(columns, row)}
            for row in result.fetchall()
        ]

    return {
        "name": name,
        "comment": ALLOWED_TABLES[name],
        "columns": columns,
        "rows": rows,
        "total": int(count),
        "limit": limit,
        "offset": offset,
    }


# ------------------------------------------------------------------
# 知识库：解析商品知识库 Markdown（与 Dify 中导入的是同一份源文件）
# ------------------------------------------------------------------

# 二级标题对应一份独立知识（商品库是一商品一节）
_KB_ENTRY_RE = re.compile(r"^##\s+\S")


def _parse_kb_file(path: Path) -> dict:
    """知识库 Markdown 的元信息：只统计条目数，不向前端暴露原始分段正文。"""
    text_content = path.read_text(encoding="utf-8-sig", errors="replace")
    lines = text_content.splitlines()
    stat = path.stat()
    title = lines[0].lstrip("# ").strip() if lines else path.stem
    return {
        "file": path.name,
        "title": title.split(" / ")[0],
        "entries": sum(1 for line in lines if _KB_ENTRY_RE.match(line.strip())),
        "chars": len(text_content),
        "updated_at": datetime.fromtimestamp(stat.st_mtime).isoformat(sep=" "),
    }


def _extract_doc_text(path: Path) -> str:
    """提取多格式文档的纯文本，用于统计字符数与文档元信息。"""
    suffix = path.suffix.lower()
    try:
        if suffix in (".md", ".txt"):
            return path.read_text(encoding="utf-8-sig", errors="replace")
        if suffix == ".pdf":
            from pypdf import PdfReader

            return "\n".join((p.extract_text() or "") for p in PdfReader(str(path)).pages)
        if suffix == ".docx":
            from docx import Document

            doc = Document(str(path))
            parts = [p.text for p in doc.paragraphs]
            for table in doc.tables:
                for row in table.rows:
                    parts.append(" | ".join(c.text.strip() for c in row.cells))
            return "\n".join(parts)
        if suffix == ".xlsx":
            from openpyxl import load_workbook

            wb = load_workbook(str(path), read_only=True, data_only=True)
            lines = []
            for ws in wb.worksheets:
                for row in ws.iter_rows(values_only=True):
                    cells = [str(c) for c in row if c is not None]
                    if cells:
                        lines.append(" | ".join(cells))
            return "\n".join(lines)
    except Exception as exc:  # 单份文档解析失败不应该让整个接口 500
        logger.warning("解析文档失败 %s：%s", path.name, exc)
    return ""


_DOC_NO_RE = re.compile(r"(YC-[A-Z]{2,4}-\d{3}(?:-[A-Z]\d)?)")
# Word 文档里的版本号常落在表格单元格中（版本 | V2.1），这里允许分隔符
_DOC_VER_RE = re.compile(r"版本[\s|:：]*([Vv]?\d+(?:\.\d+)?)")


def _doc_info(path: Path, text: str) -> dict:
    head = text[:600]
    doc_no = _DOC_NO_RE.search(head) or _DOC_NO_RE.search(text)
    version = _DOC_VER_RE.search(head) or _DOC_VER_RE.search(text)
    stat = path.stat()
    return {
        "file": path.name,
        "title": re.sub(r"^\d+_", "", path.stem).replace("_v2025", ""),
        "format": path.suffix.lstrip(".").upper(),
        "chars": len(text),
        "doc_no": doc_no.group(1) if doc_no else "",
        "version": f"V{version.group(1).lstrip('Vv')}" if version else "",
        "updated_at": datetime.fromtimestamp(stat.st_mtime).isoformat(sep=" ")[:16],
    }


def _enterprise_doc_info(path: Path) -> dict:
    return _doc_info(path, _extract_doc_text(path))


def _kb_source(dataset: str) -> tuple[Path, list[str]]:
    """返回知识库对应的源文件目录与白名单文件名，防止任意路径读取。"""
    if dataset == "ecommerce":
        return KB_DOCS_DIR, list(KB_FILES)
    if dataset == "enterprise" and ENTERPRISE_KB_DIR.exists():
        names = sorted(
            p.name
            for p in ENTERPRISE_KB_DIR.glob("*")
            if p.suffix.lower() in ENTERPRISE_FORMATS
        )
        return ENTERPRISE_KB_DIR, names
    raise HTTPException(status_code=404, detail="知识库不存在")


@router.get("/knowledge")
async def knowledge():
    """知识库页：两个知识库的文档清单（均按 Embedding + 混合检索 + Rerank 展示）。"""
    docs = []
    for name in KB_FILES:
        path = KB_DOCS_DIR / name
        if not path.exists():
            docs.append(
                {
                    "file": name,
                    "title": name,
                    "entries": 0,
                    "chars": 0,
                    "updated_at": None,
                    "missing": True,
                }
            )
            continue
        docs.append(_parse_kb_file(path))

    enterprise_docs = [
        _enterprise_doc_info(p)
        for p in sorted(ENTERPRISE_KB_DIR.glob("*"))
        if p.suffix.lower() in ENTERPRISE_FORMATS
    ] if ENTERPRISE_KB_DIR.exists() else []

    # 索引规模来自 pgvector，而不是按源文件估算
    index_stats: dict[str, dict] = {}
    for kb_id in ("shop", "enterprise"):
        try:
            index_stats[kb_id] = await rag_store.kb_stats(kb_id)
        except Exception as exc:  # noqa: BLE001
            logger.warning("读取 %s 索引统计失败：%s", kb_id, exc)
            index_stats[kb_id] = {"docs": 0, "chunks": 0, "parents": 0}

    datasets = [
        {
            "id": "ecommerce",
            "name": "电商商品知识库",
            "subtitle": "商品详情 / 卖点 / 适用场景 / 尺码库存",
            "engine": "pgvector + BM25 混合检索 + RRF + Rerank",
            "segmentation": "父子切片 · 父块 1200 / 子块 220 字",
            "kind": "markdown",
            "total_documents": index_stats["shop"]["docs"],
            "total_segments": index_stats["shop"]["chunks"],
            "total_parents": index_stats["shop"]["parents"],
            "total_chars": sum(d["chars"] for d in docs),
            "docs": [
                {
                    "file": d["file"],
                    "title": d["title"],
                    "format": "MD",
                    "chars": d["chars"],
                    "segments": d["entries"],
                    "updated_at": (d.get("updated_at") or "")[:16],
                    "doc_no": "",
                    "version": "",
                    "missing": d.get("missing", False),
                }
                for d in docs
            ],
        },
        {
            "id": "enterprise",
            "name": "企业制度知识库",
            "subtitle": "员工制度 / 差旅报销 / 采购 / 信息安全 / 客服 SOP",
            "engine": "pgvector + BM25 混合检索 + RRF + Rerank",
            "segmentation": "父子切片 · 父块 1200 / 子块 220 字",
            "kind": "document",
            "total_documents": index_stats["enterprise"]["docs"],
            "total_segments": index_stats["enterprise"]["chunks"],
            "total_parents": index_stats["enterprise"]["parents"],
            "total_chars": sum(d["chars"] for d in enterprise_docs),
            "docs": [{**d, "segments": None, "missing": False} for d in enterprise_docs],
        },
    ]

    return {"datasets": datasets}


@router.get("/knowledge/doc")
async def knowledge_doc(
    dataset: str = Query(min_length=1, max_length=32),
    file: str = Query(min_length=1, max_length=128),
):
    """读取单份文档原文，供前端点开核对答案。"""
    base, allowed = _kb_source(dataset)
    if file not in allowed:
        raise HTTPException(status_code=404, detail="文档不存在")
    path = base / file
    if not path.exists():
        raise HTTPException(status_code=404, detail="文档不存在")

    text = _extract_doc_text(path)
    meta = _doc_info(path, text)
    if dataset == "ecommerce":
        meta["title"] = next(
            (ln.lstrip("# ").strip() for ln in text.splitlines() if ln.strip()),
            path.stem,
        )
        meta["doc_no"] = ""
        meta["version"] = ""
    entry_count = sum(1 for line in text.splitlines() if _KB_ENTRY_RE.match(line.strip()))
    limit = 20000
    return {
        "dataset": dataset,
        **meta,
        "file": file,
        "segments": entry_count if dataset == "ecommerce" else None,
        "content": text[:limit],
        "truncated": len(text) > limit,
    }


@router.get("/knowledge/download")
async def knowledge_download(
    dataset: str = Query(min_length=1, max_length=32),
    file: str = Query(min_length=1, max_length=128),
):
    """下载知识库原始文件（PDF / Word / Excel / Markdown），下载后用本地应用打开核对。"""
    base, allowed = _kb_source(dataset)
    if file not in allowed:
        raise HTTPException(status_code=404, detail="文档不存在")
    path = base / file
    if not path.exists():
        raise HTTPException(status_code=404, detail="文档不存在")
    return FileResponse(path, filename=path.name)


# ------------------------------------------------------------------
# 系统监控
# ------------------------------------------------------------------


async def _probe_services() -> list[dict]:
    """逐个探活 MySQL / Redis / PostgreSQL(pgvector) / 智谱 GLM，返回带本次往返耗时的状态列表。"""
    services = []

    t0 = time.perf_counter()
    mysql_ok = True
    mysql_error = None
    try:
        async with SessionLocal() as db:
            await db.execute(text("SELECT 1"))
    except Exception as exc:  # noqa: BLE001
        mysql_ok = False
        mysql_error = str(exc)[:200]
    services.append(
        {
            "name": "MySQL",
            "target": f"{settings.mysql_host}:{settings.mysql_port}/{settings.mysql_db}",
            "status": "ok" if mysql_ok else "down",
            "latency_ms": round((time.perf_counter() - t0) * 1000, 1),
            "error": mysql_error,
        }
    )

    t0 = time.perf_counter()
    redis_ok = True
    redis_error = None
    try:
        await get_redis().ping()
    except Exception as exc:  # noqa: BLE001
        redis_ok = False
        redis_error = str(exc)[:200]
    services.append(
        {
            "name": "Redis",
            "target": settings.redis_url,
            "status": "ok" if redis_ok else "down",
            "latency_ms": round((time.perf_counter() - t0) * 1000, 1),
            "error": redis_error,
        }
    )

    if not settings.zhipu_api_key:
        services.append(
            {
                "name": "智谱 GLM API",
                "target": settings.zhipu_api_base,
                "status": "unconfigured",
                "latency_ms": None,
                "error": "未配置 ZHIPU_API_KEY",
            }
        )
    else:
        # GET /models 只做鉴权与连通性检查，不消耗模型 token
        t0 = time.perf_counter()
        model_error = None
        try:
            async with httpx.AsyncClient(timeout=5.0, trust_env=False) as client:
                resp = await client.get(
                    f"{settings.zhipu_api_base.rstrip('/')}/models",
                    headers={"Authorization": f"Bearer {settings.zhipu_api_key}"},
                )
            latency = round((time.perf_counter() - t0) * 1000, 1)
            if resp.status_code != 200:
                model_error = f"HTTP {resp.status_code}"
        except Exception as exc:  # noqa: BLE001
            latency = None
            model_error = str(exc)[:200]

        services.append(
            {
                "name": "智谱 GLM API",
                "target": f"{settings.zhipu_api_base} · {settings.zhipu_chat_model}",
                "status": "ok" if model_error is None else "down",
                "latency_ms": latency,
                "error": model_error,
            }
        )

    # 向量化 / 精排供应商：与对话模型独立计费，单独探测一次
    provider = (settings.embedding_provider or "siliconflow").strip().lower()
    if provider == "siliconflow":
        base = settings.siliconflow_api_base
        key, label = settings.siliconflow_api_key, "硅基流动 Embedding / Rerank"
    else:
        base = settings.zhipu_api_base
        key, label = settings.zhipu_api_key, "智谱 Embedding / Rerank"
    if not key:
        services.append(
            {
                "name": label,
                "target": base,
                "status": "unconfigured",
                "latency_ms": None,
                "error": f"未配置 {provider.upper()} 的 API Key",
            }
        )
    else:
        t0 = time.perf_counter()
        embed_error = None
        try:
            async with httpx.AsyncClient(timeout=5.0, trust_env=False) as client:
                resp = await client.get(
                    f"{base.rstrip('/')}/models",
                    headers={"Authorization": f"Bearer {key}"},
                )
            latency = round((time.perf_counter() - t0) * 1000, 1)
            if resp.status_code != 200:
                embed_error = f"HTTP {resp.status_code}"
        except Exception as exc:  # noqa: BLE001
            latency = None
            embed_error = str(exc)[:200]
        services.append(
            {
                "name": label,
                "target": base,
                "status": "ok" if embed_error is None else "down",
                "latency_ms": latency,
                "error": embed_error,
            }
        )

    t0 = time.perf_counter()
    pg_error = None
    try:
        pg = await rag_store.health()
        pg_target = f"pgvector {pg.get('pgvector')} · {pg.get('chunks')} 切片"
    except Exception as exc:  # noqa: BLE001
        pg_error = str(exc)[:200]
        pg_target = settings.pg_dsn.split("@")[-1]
    services.append(
        {
            "name": "PostgreSQL + pgvector",
            "target": pg_target,
            "status": "ok" if pg_error is None else "down",
            "latency_ms": round((time.perf_counter() - t0) * 1000, 1),
            "error": pg_error,
        }
    )

    return services


@router.get("/services")
async def services_health():
    """仅依赖探活，供监控页 3 秒级轮询，避免每次都带统计查询。"""
    return {
        "services": await _probe_services(),
        "checked_at": datetime.now().isoformat(sep=" "),
    }


@router.get("/monitor")
async def monitor(include_services: bool = True):
    """监控页：依赖健康状态、耗时、Token 汇总、运行时长。"""
    services = await _probe_services() if include_services else []

    async with SessionLocal() as db:
        tokens_today = (
            await db.execute(
                text(
                    "SELECT COALESCE(SUM(total_tokens),0) FROM chat_history WHERE DATE(created_at)=CURDATE()"
                )
            )
        ).scalar() or 0
        messages_today = (
            await db.execute(
                text(
                    "SELECT COUNT(*) FROM chat_history WHERE DATE(created_at)=CURDATE()"
                )
            )
        ).scalar() or 0
        avg_latency = (
            await db.execute(
                text("SELECT COALESCE(AVG(latency_ms),0) FROM chat_history WHERE role='assistant'")
            )
        ).scalar() or 0

    return {
        "services": services,
        "uptime_seconds": int(time.time() - _started_at),
        "tokens_today": int(tokens_today),
        "messages_today": int(messages_today),
        "avg_latency_ms": round(float(avg_latency), 1),
        "checked_at": datetime.now().isoformat(sep=" "),
    }


@router.get("/traces")
async def traces(limit: int = Query(default=20, ge=1, le=100)):
    """最近的对话执行轨迹：一眼看出这轮走了检索还是工具、有没有人工中断、慢在哪。"""
    async with SessionLocal() as db:
        rows = (
            await db.execute(
                text(
                    """
                    SELECT id, session_id, app, question, status, hits, tools,
                           tool_names, degraded, first_token_ms, latency_ms,
                           total_tokens, error, created_at
                    FROM chat_trace
                    ORDER BY id DESC
                    LIMIT :limit
                    """
                ),
                {"limit": limit},
            )
        ).mappings().all()

    return {"traces": [{k: _jsonable(v) for k, v in r.items()} for r in rows]}
