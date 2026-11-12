/** ERP 适配层只读接口（对应 FastAPI /api/erp/*，无需管理员 Token） */

const API_BASE = process.env.NEXT_PUBLIC_API_BASE_URL?.replace(/\/+$/, '') ?? '';

export type ErpSource = 'mock-erp' | 'http-erp' | 'local' | 'local-fallback';

export interface ErpHealth {
  mode: 'local' | 'mock' | 'http' | string;
  ok: boolean;
  adapter: string | null;
  latency_ms?: number;
  probe?: {
    orders?: number;
    skus?: number;
    products?: number;
    endpoint?: string;
    note?: string;
  };
  error?: string;
  note?: string;
}

export interface ErpOrderItem {
  product_id: string;
  product_name: string;
  size: string;
  qty: number;
  unit_price: number;
}

export interface ErpOrder {
  order_no: string;
  status: string;
  status_text: string;
  total_amount: number;
  discount_amount: number;
  pay_method?: string | null;
  address?: string | null;
  created_at?: string | null;
  paid_at?: string | null;
  shipped_at?: string | null;
  items: ErpOrderItem[];
  source: ErpSource;
  note?: string;
}

export interface ErpStock {
  sku: string;
  product_id: string;
  size: string;
  color: string;
  available: number;
  reserved: number;
  warehouse: string;
  low_stock: boolean;
  source: ErpSource;
  note?: string;
}

export interface ErpProduct {
  product_id: string;
  name: string;
  price: number;
  currency: string;
  category: string;
}

export interface ErpMasterData {
  entity: string;
  count: number;
  items: ErpProduct[];
}

async function request<T>(path: string): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, { cache: 'no-store' });
  if (!res.ok) {
    let detail = `${res.status} ${res.statusText}`;
    try {
      const body = (await res.json()) as { detail?: unknown };
      if (typeof body.detail === 'string') detail = body.detail;
    } catch {
      // 非 JSON 错误体，保留状态码即可
    }
    throw new Error(detail);
  }
  return (await res.json()) as T;
}

export const erpApi = {
  health: () => request<ErpHealth>('/api/erp/health'),
  order: (orderNo: string) =>
    request<ErpOrder>(`/api/erp/orders/${encodeURIComponent(orderNo)}`),
  stock: (sku: string) => request<ErpStock>(`/api/erp/stock/${encodeURIComponent(sku)}`),
  products: () => request<ErpMasterData>('/api/erp/master-data/products'),
};
