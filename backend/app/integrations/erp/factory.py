"""适配器工厂：把 `ERP_MODE` 映射到具体实现，进程内复用实例。

- `local`：不接 ERP，订单与库存直接查本地 MySQL（完全绕过本目录）
- `mock` ：内置虚构 ERP（默认，开箱即用，便于本地演示与录屏）
- `http` ：真实 ERP 网关，读 `ERP_BASE_URL / ERP_API_TOKEN / ERP_TIMEOUT`
"""

from __future__ import annotations

import time

from ...config import settings
from .base import ErpAdapter, ErpError
from .http import HttpErpAdapter
from .mock import MockErpAdapter

_adapter: ErpAdapter | None = None
_adapter_mode: str = ""


def erp_mode() -> str:
    return (settings.erp_mode or "mock").strip().lower()


def get_erp_adapter() -> ErpAdapter | None:
    """返回当前模式的适配器；`local` 模式返回 None，由调用方直接走本地库。"""
    global _adapter, _adapter_mode

    mode = erp_mode()
    if mode == "local":
        return None
    if _adapter is not None and _adapter_mode == mode:
        return _adapter

    if mode == "mock":
        _adapter = MockErpAdapter()
    elif mode == "http":
        _adapter = HttpErpAdapter(
            base_url=settings.erp_base_url,
            token=settings.erp_api_token,
            timeout=settings.erp_timeout,
        )
    else:
        raise ValueError(f"未知 ERP_MODE={mode!r}，可选 local / mock / http")

    _adapter_mode = mode
    return _adapter


async def erp_health() -> dict:
    """连通性自检：给 /api/erp/health 用，失败不抛异常，只回报状态。"""
    mode = erp_mode()
    adapter = get_erp_adapter()
    if adapter is None:
        return {
            "mode": "local",
            "ok": True,
            "adapter": None,
            "note": "ERP 未启用，订单与库存直接查本地 MySQL",
        }

    started = time.perf_counter()
    try:
        probe = await adapter.probe()
        elapsed = int((time.perf_counter() - started) * 1000)
        return {"mode": mode, "ok": True, "adapter": adapter.name, "latency_ms": elapsed, "probe": probe}
    except ErpError as exc:
        elapsed = int((time.perf_counter() - started) * 1000)
        return {
            "mode": mode,
            "ok": False,
            "adapter": adapter.name,
            "latency_ms": elapsed,
            "error": str(exc),
            "note": "调用失败时上层会自动降级到本地库，并在响应的 source 字段标注",
        }
