/** 控制台只读接口封装（对应 FastAPI /api/admin/*），全部要求管理员 Token */

import { authHeaders, clearSession, redirectToLogin } from './auth';

const API_BASE =
  process.env.NEXT_PUBLIC_API_BASE_URL?.replace(/\/+$/, '') ?? '';

// 控制台数据几乎不变，短 TTL 内存缓存可让页面切换瞬间出内容，
// 同时合并并发请求，避免返回页面时重复打后端。
type CacheEntry = { at: number; data: unknown };
const memoryCache = new Map<string, CacheEntry>();
const inflight = new Map<string, Promise<unknown>>();

async function getJSON<T>(path: string, ttlMs = 15_000): Promise<T> {
  const cached = memoryCache.get(path);
  if (cached && Date.now() - cached.at < ttlMs) {
    return cached.data as T;
  }

  const pending = inflight.get(path);
  if (pending) return pending as Promise<T>;

  const request = (async () => {
    try {
      const res = await fetch(`${API_BASE}${path}`, {
        cache: 'no-store',
        headers: authHeaders(),
      });
      // 未登录 → 去登录页；已登录但不是管理员 → 明确提示，不跳转
      if (res.status === 401) {
        memoryCache.clear();
        clearSession();
        redirectToLogin();
        throw new Error('登录已过期，请重新登录');
      }
      if (res.status === 403) {
        throw new Error('当前账号不是管理员，无权访问控制台');
      }
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
      const data = (await res.json()) as T;
      memoryCache.set(path, { at: Date.now(), data });
      return data;
    } catch (e) {
      // 后端短暂异常时先展示上一次的数据，避免整页空白
      if (cached) return cached.data as T;
      throw e;
    } finally {
      inflight.delete(path);
    }
  })();

  inflight.set(path, request);
  return request;
}

export interface OverviewStats {
  products: number;
  orders: number;
  customers: number;
  coupons: number;
  conversations: number;
  messages: number;
  tokens_today: number;
  tokens_total: number;
}

export interface TrendPoint {
  day: string;
  tokens: number;
  messages: number;
}

export interface RecentChat {
  id: number;
  session_id: string;
  role: string;
  content: string;
  total_tokens: number;
  created_at: string;
}

export interface RecentOrder {
  id: string;
  customer_id: string;
  status: string;
  total_amount: number;
  created_at: string;
}

export interface Overview {
  stats: OverviewStats;
  trend: TrendPoint[];
  recent_chats: RecentChat[];
  recent_orders: RecentOrder[];
}

export interface DbTable {
  name: string;
  comment: string;
  rows: number;
}

export interface TablesResponse {
  database: string;
  tables: DbTable[];
}

export interface TableRows {
  name: string;
  comment: string;
  columns: string[];
  rows: Record<string, unknown>[];
  total: number;
  limit: number;
  offset: number;
}

export interface KbDatasetDoc {
  file: string;
  title: string;
  format: string;
  chars: number;
  segments: number | null;
  updated_at: string;
  doc_no: string;
  version: string;
  missing: boolean;
}

export interface KbDataset {
  id: string;
  name: string;
  subtitle: string;
  engine: string;
  segmentation: string;
  kind: 'markdown' | 'document';
  total_documents: number;
  total_segments: number | null;
  total_chars: number;
  docs: KbDatasetDoc[];
}

export interface KbResponse {
  datasets: KbDataset[];
}

export interface KbDocContent {
  dataset: string;
  file: string;
  title: string;
  format: string;
  doc_no: string;
  version: string;
  chars: number;
  segments: number | null;
  updated_at: string;
  content: string;
  truncated: boolean;
}

export interface MonitorService {
  name: string;
  target: string;
  status: 'ok' | 'down' | 'unconfigured';
  latency_ms: number | null;
  error: string | null;
}

export interface MonitorResponse {
  services: MonitorService[];
  uptime_seconds: number;
  tokens_today: number;
  messages_today: number;
  avg_latency_ms: number;
  checked_at: string;
}

export interface ServicesResponse {
  services: MonitorService[];
  checked_at: string;
}

/** 单条对话执行轨迹（对应后端 chat_trace 表） */
export interface ChatTraceRow {
  id: number;
  session_id: string | null;
  app: string;
  question: string;
  status: 'ok' | 'interrupted' | 'error';
  hits: number;
  tools: number;
  tool_names: string | null;
  degraded: string | null;
  first_token_ms: number;
  latency_ms: number;
  total_tokens: number;
  error: string | null;
  created_at: string;
}

export interface TracesResponse {
  traces: ChatTraceRow[];
}

export const adminApi = {
  overview: () => getJSON<Overview>('/api/admin/overview'),
  tables: () => getJSON<TablesResponse>('/api/admin/db/tables', 60_000),
  tableRows: (name: string, limit = 20, offset = 0) =>
    getJSON<TableRows>(
      `/api/admin/db/tables/${encodeURIComponent(name)}?limit=${limit}&offset=${offset}`,
      15_000,
    ),
  knowledge: () => getJSON<KbResponse>('/api/admin/knowledge', 60_000),
  knowledgeDoc: (dataset: string, file: string) =>
    getJSON<KbDocContent>(
      `/api/admin/knowledge/doc?dataset=${encodeURIComponent(dataset)}&file=${encodeURIComponent(file)}`,
      300_000,
    ),
  knowledgeDownload: async (dataset: string, file: string) => {
    const res = await fetch(
      `${API_BASE}/api/admin/knowledge/download?dataset=${encodeURIComponent(dataset)}&file=${encodeURIComponent(file)}`,
      { cache: 'no-store' },
    );
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    return res.blob();
  },
  monitor: (includeServices = true) =>
    getJSON<MonitorResponse>(
      `/api/admin/monitor${includeServices ? '' : '?include_services=0'}`,
      5_000,
    ),
  services: () => getJSON<ServicesResponse>('/api/admin/services', 0),
  traces: (limit = 20) =>
    getJSON<TracesResponse>(`/api/admin/traces?limit=${limit}`, 0),
};
