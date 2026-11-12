"""真实 ERP 的通用 HTTP / OData 客户端骨架。

`ERP_MODE=http` 时启用；未配置 `ERP_BASE_URL` 直接抛 `ErpUnavailable`，
由上层降级到本地库，而不是让对话链路 500。

接具体厂商时的改动点只有三处：
1. 路径与查询参数（SAP OData / 金蝶 Cloud / 用友 U8 各不相同）；
2. 响应解包（`d.results`、`data.items` 等）；
3. 时间戳与枚举格式（如 SAP 的 `/Date(1690000000000)/`）。
字段映射统一走 `base.map_*`，不要在客户端里另写一套。
"""

from __future__ import annotations

from urllib.parse import quote

import httpx

from .base import ErpNotFound, ErpUnavailable, map_order, map_product, map_stock, normalize_sku


class HttpErpAdapter:
    """只读 HTTP ERP 网关客户端。"""

    name = "http-erp"

    def __init__(self, base_url: str, token: str = "", timeout: float = 5.0) -> None:
        self.base_url = (base_url or "").strip().rstrip("/")
        self.token = (token or "").strip()
        self.timeout = timeout

    # ------------------------------------------------------------------
    # 底层请求
    # ------------------------------------------------------------------
    async def _request(self, path: str, params: dict | None = None):
        if not self.base_url:
            raise ErpUnavailable("ERP_BASE_URL 未配置，无法访问真实 ERP")

        headers = {}
        if self.token:
            headers["Authorization"] = f"Bearer {self.token}"

        try:
            async with httpx.AsyncClient(
                base_url=self.base_url,
                timeout=self.timeout,
                # ERP 一般在内网；不读系统代理，避免 Windows 代理把内网/本机请求转出去
                trust_env=False,
            ) as client:
                resp = await client.get(path, params=params, headers=headers)
        except httpx.TimeoutException as exc:
            raise ErpUnavailable(f"ERP 请求超时（>{self.timeout}s）") from exc
        except httpx.HTTPError as exc:
            raise ErpUnavailable(f"ERP 请求失败：{exc.__class__.__name__}") from exc

        if resp.status_code == 404:
            raise ErpNotFound(f"ERP 返回 404：{path}")
        if resp.status_code in (401, 403):
            raise ErpUnavailable("ERP 鉴权失败，检查 ERP_API_TOKEN")
        if resp.status_code >= 400:
            raise ErpUnavailable(f"ERP 返回 HTTP {resp.status_code}")

        try:
            return resp.json()
        except ValueError as exc:
            raise ErpUnavailable("ERP 返回的不是合法 JSON") from exc

    @staticmethod
    def _unwrap(payload):
        """兼容 OData 的 `{"d": {...}}` / `{"d": {"results": [...]}}` 与普通 REST 平铺结构。"""
        if isinstance(payload, dict) and "d" in payload:
            body = payload["d"]
            if isinstance(body, dict) and "results" in body:
                return body["results"]
            return body
        return payload

    # ------------------------------------------------------------------
    # 能力实现
    # ------------------------------------------------------------------
    async def get_order(self, order_no: str) -> dict:
        safe_no = quote((order_no or "").strip(), safe="")
        payload = await self._request(f"/odata/Orders('{safe_no}')")
        raw = self._unwrap(payload)
        if not isinstance(raw, dict) or not raw:
            raise ErpNotFound(f"ERP 中不存在订单 {order_no}")
        return map_order(raw)

    async def get_stock(self, sku: str) -> dict:
        code = normalize_sku(sku)
        payload = await self._request(
            "/odata/Stock",
            params={"$filter": f"Sku eq '{code}'", "$top": 1},
        )
        rows = self._unwrap(payload)
        if not isinstance(rows, list) or not rows:
            raise ErpNotFound(f"ERP 中不存在 SKU {code}")
        return map_stock(rows[0])

    async def pull_master_data(self, entity: str) -> dict:
        key = (entity or "").strip().lower()
        if key not in ("products", "materials"):
            raise ErpNotFound(f"不支持的主数据实体 {entity!r}，当前仅支持 products")
        payload = await self._request("/odata/Products", params={"$top": 50})
        rows = self._unwrap(payload)
        if not isinstance(rows, list):
            raise ErpUnavailable("ERP 主数据返回结构不是列表")
        return {
            "entity": "products",
            "count": len(rows),
            "items": [map_product(r) for r in rows],
        }

    async def probe(self) -> dict:
        await self._request("/odata/Products", params={"$top": 1})
        return {
            "ok": True,
            "adapter": self.name,
            "endpoint": self.base_url,
            "note": "已完成一次只读探测（GET /odata/Products）",
        }
