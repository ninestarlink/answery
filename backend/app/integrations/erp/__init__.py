"""ERP 适配层：契约、映射、Mock / HTTP 实现与工厂。"""

from .base import (
    ErpAdapter,
    ErpError,
    ErpNotFound,
    ErpUnavailable,
    map_order,
    map_product,
    map_stock,
    normalize_sku,
)
from .factory import erp_health, erp_mode, get_erp_adapter
from .http import HttpErpAdapter
from .mock import MockErpAdapter

__all__ = [
    "ErpAdapter",
    "ErpError",
    "ErpNotFound",
    "ErpUnavailable",
    "HttpErpAdapter",
    "MockErpAdapter",
    "erp_health",
    "erp_mode",
    "get_erp_adapter",
    "map_order",
    "map_product",
    "map_stock",
    "normalize_sku",
]
