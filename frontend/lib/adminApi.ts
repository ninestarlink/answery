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

/** 评测中台：一次批量运行 */
export interface EvalRun {
  id: number;
  dataset_id: number;
  status: 'running' | 'completed' | 'failed';
  engine: string;
  top_k: number;
  case_count: number;
  hit_count: number;
  hit_rate: number;
  mrr: number;
  avg_latency_ms: number;
  p95_latency_ms: number;
  degraded_count: number;
  note: string | null;
  error: string | null;
  progress: number;
  started_at: string | null;
  finished_at: string | null;
}

export interface EvalDatasetInfo {
  id: number | null;
  code: string;
  name: string;
  description: string;
  cases: number;
  categories: number;
}

export interface EvalOverview {
  dataset: EvalDatasetInfo;
  latest: EvalRun | null;
  previous: EvalRun | null;
  running: EvalRun | null;
  runs: EvalRun[];
}

export interface EvalCase {
  id: number;
  case_no: string;
  question: string;
  kb_id: string;
  expected_doc: string;
  expected_keywords: string | null;
  category: string;
  difficulty: string;
}

export type EvalReviewStatus = 'open' | 'fixed' | 'ignored';

export interface EvalCategory {
  category: string;
  case_count: number;
  hit_count: number;
  hit_rate: number;
  mrr: number;
  avg_latency_ms: number;
  p95_latency_ms: number;
}

export interface EvalCaseResult {
  case_id: number;
  case_no: string;
  question: string;
  category: string;
  kb_id: string;
  expected_doc: string;
  retrieved_doc: string | null;
  rank: number;
  hit: boolean;
  latency_ms: number;
  degraded: string | null;
  top_docs: string | null;
  review_status: EvalReviewStatus;
  review_note: string | null;
}

export interface EvalRunDetail {
  run: EvalRun;
  categories: EvalCategory[];
  results: EvalCaseResult[];
}

export interface EvalCompareCategory {
  category: string;
  baseline_hit_rate: number;
  current_hit_rate: number;
  delta_hit_rate: number;
  delta_mrr: number;
}

export interface EvalCompareCase {
  case_no: string;
  category: string;
  question: string;
  baseline_hit: boolean;
  current_hit: boolean;
  baseline_rank: number;
  current_rank: number;
  delta_latency_ms: number;
  status: 'improved' | 'regressed' | 'same';
}

export interface EvalCompare {
  baseline: EvalRun;
  current: EvalRun;
  delta: { hit_rate: number; mrr: number; p95_latency_ms: number };
  counts: { improved: number; regressed: number; same: number };
  categories: EvalCompareCategory[];
  cases: EvalCompareCase[];
}

/** 生成质量抽样评测（LLM 裁判） */
export interface EvalJudgmentRow {
  case_no: string;
  question: string;
  answer: string;
  context_docs: string | null;
  faithful: boolean;
  relevance: number;
  citation_ok: boolean;
  verdict: 'pass' | 'fail';
  reason: string | null;
  latency_ms: number;
  created_at: string | null;
}

export interface EvalJudgments {
  run_id: number;
  total: number;
  pass_count: number;
  fail_count: number;
  pass_rate: number;
  grounded_rate: number;
  citation_rate: number;
  avg_relevance: number;
  avg_latency_ms: number;
  running: boolean;
  rows: EvalJudgmentRow[];
}

/** 线上抽样候选：chat_trace 中尚未进入金标集的真实问题 */
export interface EvalCandidate {
  id: number;
  question: string;
  app: string;
  kb_id: string;
  category: string;
  status: string;
  hits: number;
  tools: number;
  degraded: string | null;
  created_at: string | null;
}

export interface EvalCaseDraft {
  case_no: string;
  question: string;
  kb_id: string;
  expected_doc: string;
  expected_keywords?: string | null;
  category: string;
  difficulty: string;
}

export interface EvalImportResult {
  created: number;
  updated: number;
  failed: number;
  errors: string[];
}

async function mutateJSON<T>(
  path: string,
  method: 'POST' | 'PUT' | 'DELETE',
  body?: unknown,
): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    method,
    cache: 'no-store',
    headers: { ...authHeaders(), 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (res.status === 401) {
    memoryCache.clear();
    clearSession();
    redirectToLogin();
    throw new Error('登录已过期，请重新登录');
  }
  if (res.status === 403) throw new Error('当前账号不是管理员，无权执行评测');
  if (!res.ok) {
    const detail = await res.text();
    throw new Error(detail || `${res.status} ${res.statusText}`);
  }
  memoryCache.clear();
  return (await res.json()) as T;
}

async function postJSON<T>(path: string, body: unknown): Promise<T> {
  return mutateJSON<T>(path, 'POST', body);
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
  evalOverview: () => getJSON<EvalOverview>('/api/admin/eval/overview', 3_000),
  evalRun: (id: number) => getJSON<EvalRunDetail>(`/api/admin/eval/runs/${id}`, 0),
  evalStart: (payload: { dataset_id?: number; top_k?: number; note?: string }) =>
    postJSON<EvalRun>('/api/admin/eval/runs', payload),
  evalCompare: (runId: number, baselineId: number) =>
    getJSON<EvalCompare>(
      `/api/admin/eval/runs/${runId}/compare?baseline_id=${baselineId}`,
      0,
    ),
  evalReview: (caseId: number, status: EvalReviewStatus, note?: string | null) =>
    postJSON<{ case_id: number; status: EvalReviewStatus; note: string | null }>(
      `/api/admin/eval/cases/${caseId}/review`,
      { status, note: note ?? null },
    ),
  evalJudge: (runId: number, sample: number) =>
    postJSON<{ run_id: number; sample: number; existing: number; status: string }>(
      `/api/admin/eval/runs/${runId}/judge`,
      { sample },
    ),
  evalJudgments: (runId: number) =>
    getJSON<EvalJudgments>(`/api/admin/eval/runs/${runId}/judgments`, 0),
  evalCases: (datasetId: number) =>
    getJSON<{ dataset: { id: number; code: string; name: string }; cases: EvalCase[] }>(
      `/api/admin/eval/datasets/${datasetId}/cases`,
      0,
    ),
  evalCreateCase: (datasetId: number, payload: EvalCaseDraft) =>
    postJSON<EvalCase>(`/api/admin/eval/datasets/${datasetId}/cases`, payload),
  evalUpdateCase: (caseId: number, payload: EvalCaseDraft) =>
    mutateJSON<EvalCase>(`/api/admin/eval/cases/${caseId}`, 'PUT', payload),
  evalDeleteCase: (caseId: number) =>
    mutateJSON<{ deleted: number }>(`/api/admin/eval/cases/${caseId}`, 'DELETE'),
  evalImportCases: (datasetId: number, csv: string) =>
    postJSON<EvalImportResult>(`/api/admin/eval/datasets/${datasetId}/cases/import`, { csv }),
  evalCandidates: (limit = 12) =>
    getJSON<{ candidates: EvalCandidate[]; existing: number }>(
      `/api/admin/eval/candidates?limit=${limit}`,
      0,
    ),
  evalExport: async (runId: number) => {
    const res = await fetch(`${API_BASE}/api/admin/eval/runs/${runId}/export`, {
      cache: 'no-store',
      headers: authHeaders(),
    });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    return res.blob();
  },
};
