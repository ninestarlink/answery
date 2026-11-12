"""Mock ERP 服务：模拟 SAP OData 风格的只读接口，用于本地演示与联调。

两种用法：
1. 独立进程（可被 `HttpErpAdapter` 真实 HTTP 调用，验证鉴权 / 超时 / 解包）：
       cd backend
       python -m app.integrations.erp.mock_service        # 监听 127.0.0.1:8010
2. 复用主应用挂载：`ERP_MODE=mock` 时数据在进程内直接读取，也可直接访问
       http://127.0.0.1:8000/mock-erp/odata/Orders('12345')

数据全部虚构，且与 `mock.py` 共用，避免两套 Mock 说法不一致。
"""

from __future__ import annotations

from fastapi import FastAPI, Header, HTTPException, Query

from ...config import settings
from .mock import NATIVE_ORDERS, NATIVE_PRODUCTS, NATIVE_STOCK, STOCK_BY_SKU

mock_erp_app = FastAPI(
    title="Mock ERP（SAP OData 风格）",
    version="0.1.0",
    description="只读演示服务：订单 / 库存 / 商品主数据，Bearer Token 鉴权。",
)


def _check_token(authorization: str | None = Header(default=None)) -> None:
    """简单 Bearer 校验：固定令牌，不引入 JWT，够演示鉴权链路即可。"""
    expected = (settings.mock_erp_token or "").strip()
    if not expected:
        return
    token = ""
    if authorization and authorization.lower().startswith("bearer "):
        token = authorization[7:].strip()
    if token != expected:
        raise HTTPException(
            status_code=401,
            detail={"error": {"code": "401", "message": "Invalid or missing bearer token"}},
        )


@mock_erp_app.get("/health", tags=["system"])
async def health():
    return {
        "service": "mock-erp",
        "status": "ok",
        "orders": len(NATIVE_ORDERS),
        "skus": len(NATIVE_STOCK),
        "products": len(NATIVE_PRODUCTS),
    }


@mock_erp_app.get("/odata/Orders('{order_no}')")
async def get_order(order_no: str, authorization: str | None = Header(default=None)):
    _check_token(authorization)
    raw = NATIVE_ORDERS.get(order_no.strip())
    if raw is None:
        raise HTTPException(
            status_code=404,
            detail={"error": {"code": "404", "message": f"SalesOrder {order_no} not found"}},
        )
    return {"d": raw}


@mock_erp_app.get("/odata/Stock")
async def get_stock(
    flt: str = Query(default="", alias="$filter"),
    authorization: str | None = Header(default=None),
):
    """支持 `$filter=Sku eq 'SKU-P1004-42'`；不带过滤条件时返回全部库存行。"""
    _check_token(authorization)
    keyword = flt.split("'")[1].strip().upper() if "'" in flt else ""
    if keyword:
        row = STOCK_BY_SKU.get(keyword)
        rows = [row] if row else []
    else:
        rows = NATIVE_STOCK
    return {"d": {"results": rows}}


@mock_erp_app.get("/odata/Products")
async def get_products(
    top: int = Query(default=50, alias="$top"),
    authorization: str | None = Header(default=None),
):
    _check_token(authorization)
    return {"d": {"results": NATIVE_PRODUCTS[: max(top, 1)]}}


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(mock_erp_app, host="127.0.0.1", port=8010)
