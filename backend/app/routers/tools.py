"""工具网关：把业务数据以 HTTP 接口暴露给前端与自建 Agent。

Agent 直接复用本文件里的业务查询协程（见 app/agent/tools.py），
也可以统一打到 POST /api/tools/invoke（name + arguments），避免模型直连数据库。

所有返回都是给大模型看的扁平 JSON：字段少、值明确、不带无意义的内部主键。
"""

from datetime import date, datetime
from decimal import Decimal

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from ..database import get_db
from ..models import (
    Coupon,
    Order,
    OrderItem,
    Product,
    ProductVariant,
    Shipment,
    ShipmentEvent,
    StorePolicy,
)
from ..schemas import ToolCallRequest

router = APIRouter(prefix="/api/tools", tags=["tools"])

STATUS_TEXT = {
    "pending_payment": "待支付",
    "paid": "已支付待发货",
    "shipped": "已发货运输中",
    "delivered": "已签收",
    "completed": "已完成",
    "refunding": "退款/退货处理中",
    "cancelled": "已取消",
}

SHIPMENT_TEXT = {
    "created": "已下单待揽收",
    "picked_up": "已揽收",
    "in_transit": "运输中",
    "delivering": "派送中",
    "delivered": "已签收",
}


# ------------------------------------------------------------------
# 小工具函数
# ------------------------------------------------------------------
def _money(value: Decimal | None) -> float:
    return float(value or 0)


def _dt(value: datetime | None) -> str | None:
    return value.strftime("%Y-%m-%d %H:%M") if value else None


# ------------------------------------------------------------------
# 商品
# ------------------------------------------------------------------
async def _search_products(
    db: AsyncSession,
    keyword: str = "",
    tag: str | None = None,
    max_price: float | None = None,
    limit: int = 5,
) -> dict:
    stmt = select(Product)
    if keyword:
        like = f"%{keyword}%"
        stmt = stmt.where(
            or_(
                Product.name.like(like),
                Product.description.like(like),
                Product.tags.like(like),
                Product.scene_desc.like(like),
            )
        )
    if tag:
        stmt = stmt.where(Product.tags.like(f"%{tag}%"))
    if max_price:
        stmt = stmt.where(Product.price <= max_price)

    products = (await db.scalars(stmt.order_by(Product.price).limit(limit))).all()

    # 一次性把库存汇总出来，避免 N+1 查询
    stock_map: dict[str, int] = {}
    ids = [p.id for p in products]
    if ids:
        res = await db.execute(
            select(ProductVariant.product_id, func.coalesce(func.sum(ProductVariant.stock), 0))
            .where(ProductVariant.product_id.in_(ids))
            .group_by(ProductVariant.product_id)
        )
        stock_map = {pid: int(total) for pid, total in res.all()}

    return {
        "count": len(products),
        "products": [
            {
                "product_id": p.id,
                "name": p.name,
                "price": _money(p.price),
                "original_price": _money(p.original_price) or None,
                "tags": p.tags.split(",") if p.tags else [],
                "scene": p.scene_desc,
                "summary": p.description,
                "total_stock": stock_map.get(p.id, 0),
                "low_stock": stock_map.get(p.id, 0) <= 5,
            }
            for p in products
        ],
    }


async def _product_detail(db: AsyncSession, product_id: str) -> dict:
    product = await db.get(Product, product_id)
    if product is None:
        raise HTTPException(status_code=404, detail=f"未找到商品 {product_id}")

    variants = (
        await db.scalars(
            select(ProductVariant)
            .where(ProductVariant.product_id == product_id)
            .order_by(ProductVariant.size)
        )
    ).all()

    return {
        "product_id": product.id,
        "name": product.name,
        "subtitle": product.subtitle,
        "price": _money(product.price),
        "original_price": _money(product.original_price) or None,
        "tags": product.tags.split(",") if product.tags else [],
        "scene": product.scene_desc,
        "description": product.description,
        "variants": [
            {
                "variant_id": v.id,
                "size": v.size,
                "color": v.color,
                "stock": v.stock,
                "available": v.stock > 0,
            }
            for v in variants
        ],
    }


# ------------------------------------------------------------------
# 订单 / 物流
# ------------------------------------------------------------------
async def _get_order(db: AsyncSession, order_no: str) -> dict:
    order = await db.get(Order, order_no)
    if order is None:
        raise HTTPException(status_code=404, detail=f"未找到订单 {order_no}")

    items = (
        await db.scalars(select(OrderItem).where(OrderItem.order_id == order_no))
    ).all()
    shipment = await db.scalar(
        select(Shipment).where(Shipment.order_id == order_no)
    )
    events: list[ShipmentEvent] = []
    if shipment is not None:
        events = (
            await db.scalars(
                select(ShipmentEvent)
                .where(ShipmentEvent.shipment_id == shipment.id)
                .order_by(ShipmentEvent.event_time.desc())
            )
        ).all()

    return {
        "order_no": order.id,
        "status": order.status,
        "status_text": STATUS_TEXT.get(order.status, order.status),
        "total_amount": _money(order.total_amount),
        "discount_amount": _money(order.discount_amount),
        "pay_method": order.pay_method,
        "address": order.address,
        "created_at": _dt(order.created_at),
        "paid_at": _dt(order.paid_at),
        "shipped_at": _dt(order.shipped_at),
        "delivered_at": _dt(order.delivered_at),
        "items": [
            {
                "product_id": i.product_id,
                "product_name": i.product_name,
                "size": i.size,
                "qty": i.qty,
                "unit_price": _money(i.unit_price),
            }
            for i in items
        ],
        "shipment": (
            {
                "carrier": shipment.carrier,
                "tracking_no": shipment.tracking_no,
                "status": shipment.status,
                "status_text": SHIPMENT_TEXT.get(shipment.status, shipment.status),
                "origin_city": shipment.origin_city,
                "current_city": shipment.current_city,
                "estimated_delivery": (
                    shipment.estimated_delivery.isoformat()
                    if shipment.estimated_delivery
                    else None
                ),
            }
            if shipment
            else None
        ),
        "events": [
            {
                "time": _dt(e.event_time),
                "city": e.city,
                "description": e.description,
            }
            for e in events
        ],
    }


# ------------------------------------------------------------------
# 店铺政策 / 优惠券
# ------------------------------------------------------------------
async def _get_policies(db: AsyncSession, key: str | None = None) -> dict:
    stmt = select(StorePolicy)
    if key:
        stmt = stmt.where(StorePolicy.policy_key == key)
    rows = (await db.scalars(stmt.order_by(StorePolicy.id))).all()
    return {
        "policies": [
            {"key": r.policy_key, "title": r.title, "content": r.content} for r in rows
        ]
    }


async def _get_coupons(db: AsyncSession, customer_id: str) -> dict:
    rows = (
        await db.scalars(
            select(Coupon)
            .where(or_(Coupon.customer_id == customer_id, Coupon.customer_id.is_(None)))
            .order_by(Coupon.valid_to.desc())
        )
    ).all()

    today = date.today()
    out = []
    for c in rows:
        expired = c.valid_to < today
        used = c.status == "used"
        out.append(
            {
                "code": c.code,
                "name": c.name,
                "discount": _money(c.discount_amount),
                "min_amount": _money(c.min_amount),
                "valid_from": c.valid_from.isoformat(),
                "valid_to": c.valid_to.isoformat(),
                "usable": (not expired) and (not used),
                "status": "已过期" if expired else ("已使用" if used else "可用"),
                "tips": "已过期，无法再使用" if expired else None,
            }
        )
    return {"customer_id": customer_id, "coupons": out}


# ------------------------------------------------------------------
# REST 接口（前端 / 外部系统可直接调）
# ------------------------------------------------------------------
@router.get("/products/search")
async def api_search_products(
    keyword: str = "",
    tag: str | None = None,
    max_price: float | None = None,
    limit: int = 5,
    db: AsyncSession = Depends(get_db),
):
    return await _search_products(db, keyword=keyword, tag=tag, max_price=max_price, limit=limit)


@router.get("/products/{product_id}")
async def api_product_detail(product_id: str, db: AsyncSession = Depends(get_db)):
    return await _product_detail(db, product_id)


@router.get("/orders/{order_no}")
async def api_order(order_no: str, db: AsyncSession = Depends(get_db)):
    return await _get_order(db, order_no)


@router.get("/policies")
async def api_policies(key: str | None = None, db: AsyncSession = Depends(get_db)):
    return await _get_policies(db, key=key)


@router.get("/coupons")
async def api_coupons(customer_id: str, db: AsyncSession = Depends(get_db)):
    return await _get_coupons(db, customer_id)


# ------------------------------------------------------------------
# 统一分发（函数调用风格）
# ------------------------------------------------------------------
@router.post("/invoke")
async def invoke(req: ToolCallRequest, db: AsyncSession = Depends(get_db)):
    """函数调用统一入口：{"name": "...", "arguments": {...}}"""
    args = req.arguments or {}
    name = req.name

    if name == "search_products":
        return await _search_products(
            db,
            keyword=str(args.get("keyword") or ""),
            tag=args.get("tag"),
            max_price=args.get("max_price"),
            limit=int(args.get("limit") or 5),
        )
    if name == "get_product":
        return await _product_detail(db, str(args.get("product_id") or ""))
    if name == "get_order":
        return await _get_order(db, str(args.get("order_no") or ""))
    if name == "get_policies":
        return await _get_policies(db, key=args.get("key"))
    if name == "get_coupons":
        return await _get_coupons(db, str(args.get("customer_id") or ""))

    raise HTTPException(status_code=400, detail=f"未知工具：{name}")
