"""ERP 网关：演示「前端 / Agent → 适配层 → ERP」的完整调用链。

三条读接口共用同一套降级策略：
- 优先走 ERP（mock / http 由 ERP_MODE 决定）；
- `ERP_MODE=local` 直接查本地库，标注 `source=local`；
- ERP 超时 / 鉴权失败等故障时回落本地 MySQL，标注 `source=local-fallback`；
- 响应里的 `source` 明确区分 mock-erp / http-erp / local / local-fallback，
  不把兜底数据伪装成 ERP 结果。
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ..database import get_db
from ..integrations.erp import (
    ErpNotFound,
    ErpUnavailable,
    erp_health,
    get_erp_adapter,
    normalize_sku,
)
from ..models import ProductVariant
from .tools import _get_order

router = APIRouter(prefix="/api/erp", tags=["erp"])


def _local_note() -> str:
    return "ERP_MODE=local，未启用 ERP"


@router.get("/health")
async def api_erp_health():
    """ERP 模式、适配器与连通性自检。"""
    return await erp_health()


@router.get("/orders/{order_no}")
async def api_erp_order(order_no: str, db: AsyncSession = Depends(get_db)):
    adapter = get_erp_adapter()
    if adapter is None:
        # 主动配置 local 不算「降级」，直接标注 local，避免和故障兜底混为一谈
        data = await _get_order(db, order_no)
        return {**data, "source": "local"}

    try:
        data = await adapter.get_order(order_no)
        return {**data, "source": adapter.name}
    except ErpNotFound:
        # ERP 明确说没有，就不要用本地库「猜」一个回来
        raise HTTPException(status_code=404, detail=f"ERP 中未找到订单 {order_no}")
    except ErpUnavailable as exc:
        note = str(exc)
    except Exception as exc:  # 适配器实现里的未知异常同样降级，避免对话 500
        note = f"{exc.__class__.__name__}: {exc}"

    data = await _get_order(db, order_no)
    return {**data, "source": "local-fallback", "note": note}


@router.get("/stock/{sku}")
async def api_erp_stock(sku: str, db: AsyncSession = Depends(get_db)):
    """按 SKU 查实时可用库存，如 /api/erp/stock/SKU-P1004-42。"""
    code = normalize_sku(sku)
    adapter = get_erp_adapter()

    note = ""
    if adapter is None:
        note = _local_note()
    else:
        try:
            data = await adapter.get_stock(code)
            return {**data, "source": adapter.name}
        except ErpNotFound as exc:
            raise HTTPException(status_code=404, detail=str(exc))
        except ErpUnavailable as exc:
            note = str(exc)
        except Exception as exc:
            note = f"{exc.__class__.__name__}: {exc}"

    variant = await db.scalar(select(ProductVariant).where(ProductVariant.sku == code))
    if variant is None:
        raise HTTPException(status_code=404, detail=f"本地库也未找到 SKU {code}")
    payload = {
        "sku": variant.sku,
        "product_id": variant.product_id,
        "size": variant.size,
        "color": variant.color,
        "available": variant.stock,
        "reserved": 0,
        "warehouse": "本地库",
        "low_stock": variant.stock <= 5,
    }
    if adapter is None:
        return {**payload, "source": "local", "note": note}
    return {**payload, "source": "local-fallback", "note": note}


@router.get("/master-data/{entity}")
async def api_erp_master_data(entity: str):
    """拉商品主数据（entity=products），用于演示主数据同步方向。"""
    adapter = get_erp_adapter()
    if adapter is None:
        raise HTTPException(status_code=503, detail="ERP 未启用，无主数据可拉取")

    try:
        return await adapter.pull_master_data(entity)
    except ErpNotFound as exc:
        raise HTTPException(status_code=404, detail=str(exc))
    except ErpUnavailable as exc:
        raise HTTPException(status_code=503, detail=f"ERP 不可用：{exc}")
