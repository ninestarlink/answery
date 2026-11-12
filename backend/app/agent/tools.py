"""Agent 工具集：把业务查询封装成 OpenAI 函数调用，直接复用路由层的数据访问逻辑。

每个工具返回 (给模型看的 JSON 字符串, 给前端渲染的原始 dict)，前端据此展示
「调用了什么工具、参数是什么、返回了什么明细」，而不是只显示一句「已调用工具」。
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import logging
from typing import Any

from fastapi import HTTPException
from langchain_core.tools import tool

from ..database import SessionLocal, get_redis
from ..integrations.erp import get_erp_adapter, normalize_sku
from ..models import Ticket
from ..routers.tickets import _next_ticket_no
from ..routers.tools import (
    _get_coupons,
    _get_order,
    _get_policies,
    _product_detail,
    _search_products,
)
from ..ticket_engine import analyze

logger = logging.getLogger("agent.tools")


def _dump(payload: Any) -> str:
    return json.dumps(payload, ensure_ascii=False)


def _error(exc: Exception) -> tuple[str, dict]:
    """工具失败也返回结构化结果，让模型能据此解释，而不是把异常抛穿整条链路。"""
    message = exc.detail if isinstance(exc, HTTPException) else str(exc)
    payload = {"error": str(message)}
    return _dump(payload), payload


# 写操作幂等窗口：同一诉求 10 分钟内重复触发，直接返回上一次的工单，不再落库
TICKET_DEDUPE_TTL = 600


def _ticket_dedupe_key(reporter: str, description: str) -> str:
    digest = hashlib.sha256(f"{reporter}|{description}".encode("utf-8")).hexdigest()[:32]
    return f"ticket:dedupe:{digest}"


@tool("search_products", response_format="content_and_artifact")
async def search_products(
    keyword: str = "",
    tag: str = "",
    max_price: float | None = None,
    limit: int = 5,
) -> tuple[str, dict]:
    """按关键词、标签或预算检索在售商品，返回商品 id、价格、标签、库存与卖点摘要。"""
    try:
        async with SessionLocal() as db:
            data = await _search_products(
                db,
                keyword=keyword.strip(),
                tag=(tag or "").strip() or None,
                max_price=max_price,
                limit=max(1, min(int(limit or 5), 5)),
            )
        return _dump(data), data
    except Exception as exc:  # noqa: BLE001
        logger.warning("search_products 失败：%s", exc)
        return _error(exc)


@tool("get_product", response_format="content_and_artifact")
async def get_product(product_id: str) -> tuple[str, dict]:
    """查询单个商品详情：售价、卖点、适用场景，以及每个尺码 / 颜色的库存。"""
    try:
        async with SessionLocal() as db:
            data = await _product_detail(db, product_id.strip())
        return _dump(data), data
    except Exception as exc:  # noqa: BLE001
        logger.warning("get_product 失败：%s", exc)
        return _error(exc)


@tool("erp_stock_check", response_format="content_and_artifact")
async def erp_stock_check(sku: str) -> tuple[str, dict]:
    """查询 ERP 实时可用库存。sku 可传 SKU-P1004-42，也可传 variant_id（如 p1004-42）。"""
    code = normalize_sku(sku)
    if not code:
        return _error(ValueError("sku 不能为空，形如 SKU-P1004-42"))

    adapter = get_erp_adapter()
    if adapter is None:
        return _error(
            ValueError("ERP 未启用（ERP_MODE=local），请改用 get_product 查看尺码库存")
        )

    try:
        data = await adapter.get_stock(code)
    except Exception as exc:  # noqa: BLE001
        logger.warning("erp_stock_check 失败：%s", exc)
        return _error(exc)

    payload = {**data, "source": adapter.name}
    return _dump(payload), payload


@tool("get_order", response_format="content_and_artifact")
async def get_order(order_no: str) -> tuple[str, dict]:
    """查询订单状态、金额、商品明细、承运商与物流轨迹。"""
    try:
        async with SessionLocal() as db:
            data = await _get_order(db, order_no.strip())
        return _dump(data), data
    except Exception as exc:  # noqa: BLE001
        logger.warning("get_order 失败：%s", exc)
        return _error(exc)


@tool("get_policies", response_format="content_and_artifact")
async def get_policies(key: str = "") -> tuple[str, dict]:
    """查询店铺政策：运费、退换货、质保、支付方式、发货时效。key 留空返回全部。"""
    try:
        async with SessionLocal() as db:
            data = await _get_policies(db, key=(key or "").strip() or None)
        return _dump(data), data
    except Exception as exc:  # noqa: BLE001
        logger.warning("get_policies 失败：%s", exc)
        return _error(exc)


@tool("get_coupons", response_format="content_and_artifact")
async def get_coupons(customer_id: str) -> tuple[str, dict]:
    """查询客户可用的优惠券：面额、门槛、有效期与是否可用。"""
    try:
        async with SessionLocal() as db:
            data = await _get_coupons(db, customer_id.strip())
        return _dump(data), data
    except Exception as exc:  # noqa: BLE001
        logger.warning("get_coupons 失败：%s", exc)
        return _error(exc)


@tool("create_escalation_ticket", response_format="content_and_artifact")
async def create_escalation_ticket(
    issue: str,
    order_no: str = "",
    reporter: str = "匿名客户",
) -> tuple[str, dict]:
    """创建人工接管工单。用户要求人工、投诉赔偿，或关键信息连续查不到时调用。

    issue 用一句话描述用户诉求；order_no 有则带上，便于人工核对。
    """
    description = issue.strip()[:300]
    if len(description) < 4:
        return _error(ValueError("issue 太短，至少 4 个字"))
    if order_no:
        description = f"{description}（订单号 {order_no.strip()}）"

    reporter_name = reporter.strip()[:32] or "匿名客户"
    dedupe_key = _ticket_dedupe_key(reporter_name, description)

    # 幂等前置检查：模型可能同轮重试、用户可能连点，重复建单对人工队列是灾难
    redis = get_redis()
    try:
        cached = await redis.get(dedupe_key)
        if cached:
            payload = json.loads(cached)
            payload["deduplicated"] = True
            payload["note"] = "10 分钟内已为同一诉求建过单，本次未重复创建"
            return _dump(payload), payload
    except Exception as exc:  # Redis 不可用时放行，不影响主流程
        logger.warning("工单幂等检查失败，本次直接建单：%s", exc)

    try:
        result = analyze(description)
        async with SessionLocal() as db:
            ticket = Ticket(
                ticket_no=await _next_ticket_no(db),
                reporter=reporter_name,
                department="电商客服",
                description=description,
                category=result["category"],
                category_label=result["category_label"],
                priority=result["priority"],
                assignee_group=result["assignee_group"],
                sla_response=result["sla_response"],
                sla_resolve=result["sla_resolve"],
                status="new",
                matched_keywords=result["matched_keywords"],
                missing_info=result["missing_info"],
                suggestions=result["suggestions"],
            )
            db.add(ticket)
            await db.commit()
            await db.refresh(ticket)
        payload = {
            "ticket_no": ticket.ticket_no,
            "priority": ticket.priority,
            "assignee_group": ticket.assignee_group,
            "sla_response": ticket.sla_response,
            "sla_resolve": ticket.sla_resolve,
            "status": "new",
            "auto_reply": result["auto_reply"],
        }
        try:
            await redis.set(dedupe_key, _dump(payload), ex=TICKET_DEDUPE_TTL)
        except Exception as exc:  # 去重标记失败只影响幂等，不影响工单本身
            logger.warning("写入工单幂等标记失败：%s", exc)
        return _dump(payload), payload
    except Exception as exc:  # noqa: BLE001
        logger.warning("create_escalation_ticket 失败：%s", exc)
        return _error(exc)


# create_task 的返回值必须留引用，否则任务可能在执行前被回收
_automation_tasks: set[asyncio.Task] = set()


@tool("trigger_automation_job", response_format="content_and_artifact")
async def trigger_automation_job(job_key: str) -> tuple[str, dict]:
    """触发一次已注册的后台自动化任务：kb_sync / nightly_eval / stale_ticket_scan。"""
    # 延迟导入：避免 Agent 模块在 apscheduler 不可用时整体导入失败
    from ..services import automation

    key = (job_key or "").strip()
    job = automation.JOBS.get(key)
    if job is None:
        return _error(
            ValueError(f"未知任务 {job_key!r}，可选：{' / '.join(automation.JOBS)}")
        )

    try:
        record, duplicated = await automation.create_run(key, trigger="agent")
    except Exception as exc:  # noqa: BLE001
        logger.warning("trigger_automation_job 失败：%s", exc)
        return _error(exc)

    if duplicated:
        payload = {
            "run_id": record.id,
            "job_key": key,
            "job_name": job.name,
            "status": record.status,
            "duplicated": True,
            "note": "幂等键已存在，未重复执行，直接复用已有运行记录",
        }
        return _dump(payload), payload

    task = asyncio.create_task(automation.execute_run(record.id, key))
    _automation_tasks.add(task)
    task.add_done_callback(_automation_tasks.discard)

    payload = {
        "run_id": record.id,
        "job_key": key,
        "job_name": job.name,
        "status": "running",
        "duplicated": False,
        "note": "已提交后台执行，可在「运营自动化」页查看运行结果",
    }
    return _dump(payload), payload


SHOP_TOOLS = [
    search_products,
    get_product,
    erp_stock_check,
    get_order,
    get_policies,
    get_coupons,
    create_escalation_ticket,
    trigger_automation_job,
]
