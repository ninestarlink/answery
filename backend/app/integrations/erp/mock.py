"""内置 Mock ERP：进程内虚构数据，不依赖网络与外部账号。

数据刻意做成「厂商原生结构」（SalesOrder / Material / Unrestricted 这类 SAP 风格字段），
再由 `base.map_*` 映射成项目契约。这样 Mock 与真实 ERP 走的是同一套映射代码，
换成真网关时不会出现「Mock 能跑、真实接口对不上」的情况。

所有订单号、客户、地址均为虚构演示数据。
"""

from __future__ import annotations

from .base import ErpNotFound, map_order, map_product, map_stock, normalize_sku

# ------------------------------------------------------------------
# 商品目录：price 用字符串保留厂商常见的 decimal 序列化形态
# ------------------------------------------------------------------
_CATALOG: dict[str, dict] = {
    "p1001": {
        "name": "轻云 Pro 缓震跑鞋",
        "price": "499.00",
        "color": "蓝紫",
        "stock": {"40": 25, "41": 40, "42": 38, "43": 12},
    },
    "p1002": {
        "name": "疾风 2.0 碳板跑鞋",
        "price": "699.00",
        "color": "橙黑",
        "stock": {"40": 15, "41": 22, "42": 18, "43": 9},
    },
    "p1003": {
        "name": "烈焰 X3 实战篮球鞋",
        "price": "569.00",
        "color": "黑红",
        "stock": {"41": 20, "42": 26, "43": 14, "44": 8},
    },
    "p1004": {
        "name": "山野 GTX 越野跑鞋",
        "price": "759.00",
        "color": "深绿",
        "stock": {"41": 6, "42": 2, "43": 5},
    },
    "p1005": {
        "name": "街头 Classic 休闲板鞋",
        "price": "329.00",
        "color": "米白",
        "stock": {"39": 35, "40": 42, "41": 38, "42": 25},
    },
    "p1006": {
        "name": "云步 轻量健步鞋",
        "price": "289.00",
        "color": "灰色",
        "stock": {"39": 28, "40": 24, "41": 16, "42": 10},
    },
}

# 库存行：一行 = 一个 SKU，Reserved 是被订单占用、尚未出库的数量
NATIVE_STOCK: list[dict] = [
    {
        "Sku": f"SKU-{pid.upper()}-{size}",
        "Material": pid,
        "Size": size,
        "Color": item["color"],
        "Unrestricted": qty,
        "Reserved": 0,
        "Warehouse": "杭州仓",
    }
    for pid, item in _CATALOG.items()
    for size, qty in item["stock"].items()
]
STOCK_BY_SKU = {row["Sku"]: row for row in NATIVE_STOCK}

NATIVE_PRODUCTS: list[dict] = [
    {
        "Material": pid,
        "MaterialName": item["name"],
        "ListPrice": item["price"],
        "Currency": "CNY",
        "MaterialGroup": "SHOES",
    }
    for pid, item in _CATALOG.items()
]

# 订单号与 db/02_seed.sql 保持一致，便于同一句对话里对照 ERP 与本地库的差异
NATIVE_ORDERS: dict[str, dict] = {
    "12345": {
        "SalesOrder": "12345",
        "Vendor": "SAP S/4HANA（Mock）",
        "Status": "S",
        "CustomerNo": "C0001",
        "NetAmount": "699.00",
        "DiscountAmount": "0.00",
        "Currency": "CNY",
        "PaymentMethod": "WECHAT_PAY",
        "ShipToAddress": "广东省广州市天河区体育西路 88 号 3 栋 1202",
        "CreatedAt": "2026-10-22T10:12:00",
        "PaidAt": "2026-10-22T10:13:00",
        "ShippedAt": "2026-10-22T18:30:00",
        "DeliveredAt": None,
        "Items": [
            {
                "Material": "p1002",
                "MaterialName": "疾风 2.0 碳板跑鞋",
                "Size": "42",
                "Quantity": 1,
                "UnitPrice": "699.00",
            }
        ],
    },
    "12346": {
        "SalesOrder": "12346",
        "Vendor": "SAP S/4HANA（Mock）",
        "Status": "D",
        "CustomerNo": "C0001",
        "NetAmount": "329.00",
        "DiscountAmount": "30.00",
        "Currency": "CNY",
        "PaymentMethod": "ALIPAY",
        "ShipToAddress": "广东省广州市天河区体育西路 88 号 3 栋 1202",
        "CreatedAt": "2026-09-15T09:20:00",
        "PaidAt": "2026-09-15T09:22:00",
        "ShippedAt": "2026-09-15T17:00:00",
        "DeliveredAt": "2026-09-17T14:05:00",
        "Items": [
            {
                "Material": "p1005",
                "MaterialName": "街头 Classic 休闲板鞋",
                "Size": "41",
                "Quantity": 1,
                "UnitPrice": "329.00",
            }
        ],
    },
    "12347": {
        "SalesOrder": "12347",
        "Vendor": "SAP S/4HANA（Mock）",
        "Status": "R",
        "CustomerNo": "C0002",
        "NetAmount": "569.00",
        "DiscountAmount": "0.00",
        "Currency": "CNY",
        "PaymentMethod": "WECHAT_PAY",
        "ShipToAddress": "上海市浦东新区张江路 66 号 1 栋 801",
        "CreatedAt": "2026-10-18T20:05:00",
        "PaidAt": "2026-10-18T20:07:00",
        "ShippedAt": None,
        "DeliveredAt": None,
        "Items": [
            {
                "Material": "p1003",
                "MaterialName": "烈焰 X3 实战篮球鞋",
                "Size": "42",
                "Quantity": 1,
                "UnitPrice": "569.00",
            }
        ],
    },
}


class MockErpAdapter:
    """进程内 Mock ERP：与独立 Mock 服务共用同一份虚构数据。"""

    name = "mock-erp"

    async def get_order(self, order_no: str) -> dict:
        raw = NATIVE_ORDERS.get((order_no or "").strip())
        if raw is None:
            raise ErpNotFound(f"ERP 中不存在订单 {order_no}")
        return map_order(raw)

    async def get_stock(self, sku: str) -> dict:
        code = normalize_sku(sku)
        raw = STOCK_BY_SKU.get(code)
        if raw is None:
            raise ErpNotFound(f"ERP 中不存在 SKU {code}")
        return map_stock(raw)

    async def pull_master_data(self, entity: str) -> dict:
        key = (entity or "").strip().lower()
        if key not in ("products", "materials"):
            raise ErpNotFound(f"不支持的主数据实体 {entity!r}，当前仅支持 products")
        return {
            "entity": "products",
            "count": len(NATIVE_PRODUCTS),
            "items": [map_product(p) for p in NATIVE_PRODUCTS],
        }

    async def probe(self) -> dict:
        return {
            "ok": True,
            "adapter": self.name,
            "orders": len(NATIVE_ORDERS),
            "skus": len(NATIVE_STOCK),
            "note": "进程内虚构数据，不产生网络请求",
        }
