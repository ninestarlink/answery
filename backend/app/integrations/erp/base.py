"""ERP 适配层契约与字段映射。

设计目标：把「接的是哪家 ERP」收在一层薄适配器里，上层（REST 网关 / Agent 工具）
完全不感知厂商差异。

- 能力面只保留客服真正用到的三件事：查订单、查实时库存、拉商品主数据；
- 返回结构对齐项目现有契约（订单同 `routers/tools._get_order`，库存对齐商品 variant），
  换供应商时前端、Agent 提示词、评测用例都不用动；
- 厂商原生结构（SAP OData 的 `d.results`、金蝶 Cloud 的嵌套 JSON）只在 adapter 内部出现，
  字段转换集中在 `map_order / map_stock / map_product`，出问题只有一个排查点。
"""

from __future__ import annotations

from typing import Any, Protocol


class ErpError(RuntimeError):
    """ERP 调用失败的基类：上层捕获后决定降级还是报错。"""


class ErpUnavailable(ErpError):
    """连接失败、超时、鉴权失败、未配置。可降级到本地库。"""


class ErpNotFound(ErpError):
    """ERP 明确返回「不存在」。不降级，避免拿本地旧数据冒充 ERP 结果。"""


class ErpAdapter(Protocol):
    """最小能力集。新增厂商只需实现这四个方法。"""

    name: str

    async def get_order(self, order_no: str) -> dict:
        """按订单号查订单，返回结构与 `_get_order` 一致。"""

    async def get_stock(self, sku: str) -> dict:
        """按 SKU 查实时可用库存。"""

    async def pull_master_data(self, entity: str) -> dict:
        """拉取主数据（当前只用到商品）。"""

    async def probe(self) -> dict:
        """连通性自检，供 /api/erp/health 使用。"""


# ------------------------------------------------------------------
# 编码与枚举映射
# ------------------------------------------------------------------
def normalize_sku(value: str) -> str:
    """把 variant_id（p1004-42）或半成品编码统一成 ERP 的 SKU（SKU-P1004-42）。"""
    raw = (value or "").strip().upper()
    if not raw:
        return ""
    return raw if raw.startswith("SKU-") else f"SKU-{raw}"


# ERP 侧的订单状态码 → 项目内部状态；新增厂商时在这里补映射即可
_ORDER_STATUS = {
    "N": "pending_payment",
    "P": "paid",
    "S": "shipped",
    "D": "delivered",
    "C": "completed",
    "R": "refunding",
    "X": "cancelled",
}

# 展示文案与 routers/tools.py 的 STATUS_TEXT 保持一致，前端和模型看到的是同一套说法
_ORDER_STATUS_TEXT = {
    "pending_payment": "待支付",
    "paid": "已支付待发货",
    "shipped": "已发货运输中",
    "delivered": "已签收",
    "completed": "已完成",
    "refunding": "退款/退货处理中",
    "cancelled": "已取消",
}

_PAY_METHOD = {
    "WECHAT_PAY": "微信支付",
    "ALIPAY": "支付宝",
    "CARD": "银行卡",
}


def _money(value: Any) -> float:
    return float(value or 0)


def _dt(value: Any) -> str | None:
    """ISO 8601 → 项目展示格式。真实 SAP 的 `/Date(1690000000000)/` 需在 adapter 里先转换。"""
    if not value:
        return None
    return str(value).strip().replace("T", " ")[:16]


def map_order(raw: dict) -> dict:
    """ERP 原生订单 → 项目订单契约。

    物流轨迹属于 TMS / WMS，不在 ERP 能力面内，这里显式返回空，
    避免前端把「ERP 没有物流」误解成「订单没发货」。
    """
    status_code = str(raw.get("Status") or "").strip().upper()
    status = _ORDER_STATUS.get(status_code, status_code.lower() or "unknown")
    pay_code = str(raw.get("PaymentMethod") or "").strip().upper()

    return {
        "order_no": raw.get("SalesOrder"),
        "status": status,
        "status_text": _ORDER_STATUS_TEXT.get(status, status),
        "total_amount": _money(raw.get("NetAmount")),
        "discount_amount": _money(raw.get("DiscountAmount")),
        "pay_method": _PAY_METHOD.get(pay_code, pay_code or None),
        "address": raw.get("ShipToAddress"),
        "created_at": _dt(raw.get("CreatedAt")),
        "paid_at": _dt(raw.get("PaidAt")),
        "shipped_at": _dt(raw.get("ShippedAt")),
        "delivered_at": _dt(raw.get("DeliveredAt")),
        "items": [
            {
                "product_id": i.get("Material"),
                "product_name": i.get("MaterialName"),
                "size": i.get("Size"),
                "qty": int(i.get("Quantity") or 0),
                "unit_price": _money(i.get("UnitPrice")),
            }
            for i in raw.get("Items") or []
        ],
        "shipment": None,
        "events": [],
    }


def map_stock(raw: dict) -> dict:
    """ERP 库存 → 项目 variant 风格。available 扣掉已被订单占用（Reserved）的部分。"""
    reserved = int(raw.get("Reserved") or 0)
    available = max(int(raw.get("Unrestricted") or 0) - reserved, 0)
    return {
        "sku": raw.get("Sku"),
        "product_id": raw.get("Material"),
        "size": raw.get("Size"),
        "color": raw.get("Color"),
        "available": available,
        "reserved": reserved,
        "warehouse": raw.get("Warehouse"),
        "low_stock": available <= 5,
    }


def map_product(raw: dict) -> dict:
    return {
        "product_id": raw.get("Material"),
        "name": raw.get("MaterialName"),
        "price": _money(raw.get("ListPrice")),
        "currency": raw.get("Currency") or "CNY",
        "category": raw.get("MaterialGroup"),
    }
