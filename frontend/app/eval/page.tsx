'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import AppShell from '@/components/AppShell';
import {
  adminApi,
  type EvalCaseResult,
  type EvalCompare,
  type EvalOverview,
  type EvalReviewStatus,
  type EvalRun,
  type EvalRunDetail,
} from '@/lib/adminApi';

const GATE_HIT = 0.85;
const GATE_MRR = 0.7;

function pct(value: number) {
  return `${(value * 100).toFixed(1)}%`;
}

function duration(run: EvalRun | null) {
  if (!run) return '—';
  return `${run.avg_latency_ms} / ${run.p95_latency_ms} ms`;
}

function Delta({
  value,
  suffix = 'pp',
  digits = 1,
}: {
  value: number;
  suffix?: string;
  digits?: number;
}) {
  if (!Number.isFinite(value) || value === 0) {
    return <span className="text-[11px] text-muted">持平</span>;
  }
  const up = value > 0;
  return (
    <span
      className={`text-[11px] font-medium tabular-nums ${
        up ? 'text-emerald-700' : 'text-rose-600'
      }`}
    >
      {up ? '▲' : '▼'} {Math.abs(value).toFixed(digits)}
      {suffix}
    </span>
  );
}

export default function EvalPage() {
  const [overview, setOverview] = useState<EvalOverview | null>(null);
  const [detail, setDetail] = useState<EvalRunDetail | null>(null);
  const [compare, setCompare] = useState<EvalCompare | null>(null);
  const [baselineId, setBaselineId] = useState<number | null>(null);
  const [selected, setSelected] = useState<number | null>(null);
  const [filter, setFilter] = useState<'all' | 'miss'>('all');
  const [starting, setStarting] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const detailBusy = useRef(false);
  const runCount = overview?.runs.length ?? 0;

  const loadDetail = useCallback(async (runId: number) => {
    if (detailBusy.current) return;
    detailBusy.current = true;
    try {
      setDetail(await adminApi.evalRun(runId));
    } catch (e) {
      setError(e instanceof Error ? e.message : '加载评测详情失败');
    } finally {
      detailBusy.current = false;
    }
  }, []);

  const load = useCallback(async () => {
    try {
      const data = await adminApi.evalOverview();
      setOverview(data);
      const target = data.running?.id ?? data.latest?.id ?? selected;
      setSelected((prev) => prev ?? target ?? null);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : '加载失败');
    }
  }, [selected]);

  useEffect(() => {
    void load();
  }, [load]);

  const activeRun = useMemo(() => {
    if (!overview) return null;
    const all = overview.runs ?? [];
    if (!selected) return overview.latest;
    return all.find((r) => r.id === selected) ?? overview.latest;
  }, [overview, selected]);

  useEffect(() => {
    if (selected) void loadDetail(selected);
  }, [selected, loadDetail]);

  // 默认把「当前 run 之前最近一次完成」作为基线，便于直接看到回归 delta
  useEffect(() => {
    const runs = overview?.runs ?? [];
    if (!selected) {
      setBaselineId(null);
      return;
    }
    const candidates = runs.filter((r) => r.status === 'completed' && r.id !== selected);
    if (candidates.length === 0) {
      setBaselineId(null);
      return;
    }
    setBaselineId((prev) => {
      // 保留用户手动选择的基线，只在失效时回落到「上一个完成的 run」
      if (prev && candidates.some((r) => r.id === prev)) return prev;
      return (candidates.find((r) => r.id < selected) ?? candidates[0]).id;
    });
  }, [selected, overview?.runs]);

  useEffect(() => {
    if (!selected || !baselineId) {
      setCompare(null);
      return;
    }
    let alive = true;
    adminApi
      .evalCompare(selected, baselineId)
      .then((data) => alive && setCompare(data))
      .catch(() => alive && setCompare(null));
    return () => {
      alive = false;
    };
  }, [selected, baselineId, runCount]);

  // 跑批期间每 2 秒刷新状态；结束后自动拉一次总览与结果
  useEffect(() => {
    if (!overview?.running) return;
    const timer = setInterval(() => {
      void load();
      if (overview.running) void loadDetail(overview.running.id);
    }, 2000);
    return () => clearInterval(timer);
  }, [overview?.running, load, loadDetail]);

  const startRun = async () => {
    if (starting || overview?.running) return;
    setStarting(true);
    try {
      const run = await adminApi.evalStart({
        dataset_id: overview?.dataset.id ?? undefined,
        top_k: 5,
        note: '手动触发',
      });
      setSelected(run.id);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : '启动评测失败');
    } finally {
      setStarting(false);
    }
  };

  const exportCsv = async (runId: number) => {
    if (exporting) return;
    setExporting(true);
    try {
      const blob = await adminApi.evalExport(runId);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `eval-run-${runId}.csv`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (e) {
      setError(e instanceof Error ? e.message : '导出失败');
    } finally {
      setExporting(false);
    }
  };

  const changeReview = async (caseId: number, status: EvalReviewStatus) => {
    setDetail((prev) =>
      prev
        ? {
            ...prev,
            results: prev.results.map((r) =>
              r.case_id === caseId ? { ...r, review_status: status } : r,
            ),
          }
        : prev,
    );
    try {
      await adminApi.evalReview(caseId, status);
    } catch (e) {
      setError(e instanceof Error ? e.message : '更新复盘状态失败');
      if (selected) void loadDetail(selected);
    }
  };

  const latest = overview?.latest ?? null;
  const previous = overview?.previous ?? null;
  const running = overview?.running ?? null;
  const gatePass = latest ? latest.hit_rate >= GATE_HIT && latest.mrr >= GATE_MRR : false;

  const results = detail?.results ?? [];
  const shown = filter === 'miss' ? results.filter((r) => !r.hit) : results;
  const misses = results.filter((r) => !r.hit);
  const categories = detail?.categories ?? [];
  const completedRuns = (overview?.runs ?? []).filter(
    (r) => r.status === 'completed' && r.id !== activeRun?.id,
  );
  const regressed = compare?.cases.filter((c) => c.status === 'regressed') ?? [];

  return (
    <AppShell>
      <div className="mx-auto w-full max-w-[1180px]">
        <header className="flex flex-wrap items-end justify-between gap-3 border-t-[3px] border-ink-900 pt-4">
          <div>
            <div className="mono-label text-accent-600">QUALITY GATE · OFFLINE EVAL</div>
            <h1 className="mt-1 text-[28px] leading-tight text-slate-900 md:text-[34px]">
              评测中台
            </h1>
            <p className="mt-1 max-w-[620px] text-[13px] leading-relaxed text-slate-600">
              同一套金标用例回归检索链路：embedding + BM25 + RRF + rerank。改动切片、参数或知识库后，
              用命中率与 MRR 证明它真的变好了。
            </p>
          </div>
          <div className="flex items-center gap-2">
            {activeRun && activeRun.status === 'completed' && (
              <button
                onClick={() => void exportCsv(activeRun.id)}
                disabled={exporting}
                className="press rounded-[2px] bg-paper-2 px-3 py-2 text-[12.5px] text-ink ring-1 ring-rule disabled:opacity-60"
              >
                {exporting ? '导出中…' : '导出 CSV'}
              </button>
            )}
            {running ? (
              <span className="rounded-[2px] bg-accent-50 px-3 py-2 text-[12px] font-medium text-accent-700 ring-1 ring-accent-100">
                评测中 {running.progress}/{running.case_count || overview?.dataset.cases}
              </span>
            ) : (
              <button
                onClick={() => void startRun()}
                disabled={starting}
                className="press rounded-[2px] bg-accent px-4 py-2 text-[13px] font-medium text-accent-ink shadow-lift disabled:opacity-60"
              >
                {starting ? '启动中…' : '运行评测'}
              </button>
            )}
          </div>
        </header>

        {error && (
          <div className="mt-3 rounded-[2px] bg-rose-50 px-4 py-2.5 text-[12.5px] text-rose-600 ring-1 ring-rose-200">
            {error}
          </div>
        )}

        {/* 指标条 */}
        <section className="mt-5 grid grid-cols-2 gap-2.5 md:grid-cols-4">
          <div className="rounded-[2px] bg-paper-2 p-4 shadow-lift">
            <div className="mono-label text-muted">CASES</div>
            <div className="mt-2 font-display text-[30px] leading-none tabular-nums text-ink">
              {overview?.dataset.cases ?? '—'}
            </div>
            <div className="mt-1.5 text-[11.5px] text-muted">
              {overview?.dataset.categories ?? 0} 类 · {overview?.dataset.name ?? '金标集'}
            </div>
          </div>

          <div className="rounded-[2px] bg-paper-2 p-4 shadow-lift">
            <div className="mono-label text-muted">HIT@5</div>
            <div className="mt-2 font-display text-[30px] leading-none tabular-nums text-ink">
              {latest ? pct(latest.hit_rate) : '—'}
            </div>
            <div className="mt-1.5 flex items-center gap-1.5 text-[11.5px] text-muted">
              {latest ? `${latest.hit_count}/${latest.case_count} 命中` : '尚未运行'}
              {latest && previous && (
                <Delta value={(latest.hit_rate - previous.hit_rate) * 100} />
              )}
            </div>
          </div>

          <div className="rounded-[2px] bg-paper-2 p-4 shadow-lift">
            <div className="mono-label text-muted">MRR</div>
            <div className="mt-2 font-display text-[30px] leading-none tabular-nums text-ink">
              {latest ? latest.mrr.toFixed(3) : '—'}
            </div>
            <div className="mt-1.5 flex items-center gap-1.5 text-[11.5px] text-muted">
              平均倒数排名
              {latest && previous && (
                <Delta
                  value={latest.mrr - previous.mrr}
                  suffix=""
                  digits={3}
                />
              )}
            </div>
          </div>

          <div className="rounded-[2px] bg-paper-2 p-4 shadow-lift">
            <div className="mono-label text-muted">P95 LATENCY</div>
            <div className="mt-2 font-display text-[30px] leading-none tabular-nums text-ink">
              {latest ? latest.p95_latency_ms : '—'}
              <span className="ml-1 text-[12px] font-normal text-muted">ms</span>
            </div>
            <div className="mt-1.5 text-[11.5px] text-muted">
              均值 {duration(latest)} · 降级 {latest?.degraded_count ?? 0}
            </div>
          </div>
        </section>

        {/* 分场景切片 + A/B 对比 */}
        <section className="mt-3.5 grid grid-cols-1 gap-3.5 md:grid-cols-2">
          <div className="rounded-[2px] bg-paper-2 p-4 shadow-lift">
            <div className="flex items-center justify-between">
              <div className="mono-label text-muted">SLICES · 分场景指标</div>
              <span className="font-mono text-[10.5px] text-muted">
                {categories.length || 0} 类
              </span>
            </div>
            <div className="mt-2.5 space-y-1.5">
              {categories.map((c) => {
                const cat = compare?.categories.find((x) => x.category === c.category);
                return (
                  <div
                    key={c.category}
                    className="flex items-center gap-2"
                    title={`MRR ${c.mrr.toFixed(3)} · P95 ${c.p95_latency_ms}ms`}
                  >
                    <span className="w-[96px] shrink-0 truncate text-[11.5px] text-ink-2">
                      {c.category}
                    </span>
                    <div className="h-1.5 flex-1 overflow-hidden rounded-[1px] bg-paper-3">
                      <div
                        className={`h-full ${
                          c.hit_rate >= GATE_HIT ? 'bg-emerald-600' : 'bg-accent'
                        }`}
                        style={{ width: `${c.hit_rate * 100}%` }}
                      />
                    </div>
                    <span className="w-[46px] text-right font-mono text-[10.5px] tabular-nums text-ink">
                      {pct(c.hit_rate)}
                    </span>
                    <span className="w-[44px] text-right font-mono text-[10px] tabular-nums text-muted">
                      {c.hit_count}/{c.case_count}
                    </span>
                    <span className="w-[52px] text-right font-mono text-[10px] tabular-nums">
                      {cat && cat.delta_hit_rate !== 0 ? (
                        <span
                          className={
                            cat.delta_hit_rate > 0 ? 'text-emerald-700' : 'text-rose-600'
                          }
                        >
                          {cat.delta_hit_rate > 0 ? '+' : ''}
                          {(cat.delta_hit_rate * 100).toFixed(0)}pp
                        </span>
                      ) : (
                        <span className="text-muted">—</span>
                      )}
                    </span>
                  </div>
                );
              })}
              {categories.length === 0 && (
                <div className="py-8 text-center text-[12px] text-muted">
                  {activeRun?.status === 'running' ? '跑批中，返回结果后出分片…' : '选择运行查看分片'}
                </div>
              )}
            </div>
          </div>

          <div className="rounded-[2px] bg-paper-2 p-4 shadow-lift">
            <div className="flex items-center justify-between gap-2">
              <div className="mono-label text-muted">A/B 对比</div>
              {completedRuns.length > 0 ? (
                <label className="flex items-center gap-1.5 font-mono text-[10.5px] text-muted">
                  baseline
                  <select
                    value={baselineId ?? ''}
                    onChange={(e) => setBaselineId(Number(e.target.value))}
                    className="rounded-[2px] bg-paper-3 px-1.5 py-0.5 font-mono text-[10.5px] text-ink outline-none"
                  >
                    {completedRuns.map((r) => (
                      <option key={r.id} value={r.id}>
                        #{r.id} · {pct(r.hit_rate)}
                      </option>
                    ))}
                  </select>
                </label>
              ) : (
                <span className="font-mono text-[10.5px] text-muted">需要 ≥ 2 次运行</span>
              )}
            </div>

            {compare ? (
              <>
                <div className="mt-3 flex items-end justify-between font-mono text-[11px] text-muted">
                  <span>
                    #{compare.baseline.id} <span className="text-ink-2">→</span> #
                    {compare.current.id}
                  </span>
                  <span>
                    提升 <span className="text-emerald-700">{compare.counts.improved}</span> ·
                    退化 <span className="text-rose-600">{compare.counts.regressed}</span> · 持平{' '}
                    {compare.counts.same}
                  </span>
                </div>
                <div className="mt-2.5 grid grid-cols-3 gap-2 border-y border-rule py-2.5">
                  <div>
                    <div className="mono-label text-muted">Δ HIT@5</div>
                    <div
                      className={`mt-1 font-display text-[19px] tabular-nums ${
                        compare.delta.hit_rate > 0
                          ? 'text-emerald-700'
                          : compare.delta.hit_rate < 0
                            ? 'text-rose-600'
                            : 'text-ink'
                      }`}
                    >
                      {compare.delta.hit_rate > 0 ? '+' : ''}
                      {(compare.delta.hit_rate * 100).toFixed(1)}
                      <span className="ml-0.5 text-[10.5px] font-normal text-muted">pp</span>
                    </div>
                  </div>
                  <div>
                    <div className="mono-label text-muted">Δ MRR</div>
                    <div
                      className={`mt-1 font-display text-[19px] tabular-nums ${
                        compare.delta.mrr > 0
                          ? 'text-emerald-700'
                          : compare.delta.mrr < 0
                            ? 'text-rose-600'
                            : 'text-ink'
                      }`}
                    >
                      {compare.delta.mrr > 0 ? '+' : ''}
                      {compare.delta.mrr.toFixed(3)}
                    </div>
                  </div>
                  <div>
                    <div className="mono-label text-muted">Δ P95</div>
                    <div
                      className={`mt-1 font-display text-[19px] tabular-nums ${
                        compare.delta.p95_latency_ms > 0 ? 'text-rose-600' : 'text-emerald-700'
                      }`}
                    >
                      {compare.delta.p95_latency_ms > 0 ? '+' : ''}
                      {compare.delta.p95_latency_ms}
                      <span className="ml-0.5 text-[10.5px] font-normal text-muted">ms</span>
                    </div>
                  </div>
                </div>
                <div className="mt-2.5">
                  {regressed.length > 0 ? (
                    <div className="space-y-1">
                      {regressed.slice(0, 4).map((c) => (
                        <div
                          key={c.case_no}
                          className="flex items-center justify-between gap-2 text-[11px]"
                        >
                          <span className="min-w-0 truncate text-ink-2">
                            <span className="mr-1.5 font-mono text-[10px] text-rose-600">
                              {c.case_no}
                            </span>
                            {c.question}
                          </span>
                          <span className="shrink-0 font-mono text-[10px] text-muted">
                            #{c.baseline_rank || '—'} → #{c.current_rank || '—'}
                          </span>
                        </div>
                      ))}
                      {regressed.length > 4 && (
                        <div className="font-mono text-[10px] text-muted">
                          另有 {regressed.length - 4} 条退化，见 CSV
                        </div>
                      )}
                    </div>
                  ) : (
                    <div className="text-[11.5px] text-muted">
                      相对基线没有退化用例，质量门禁保持不变。
                    </div>
                  )}
                </div>
              </>
            ) : (
              <div className="py-8 text-center text-[12px] leading-relaxed text-muted">
                {activeRun?.status === 'running'
                  ? '跑批结束后自动与基线对比。'
                  : '选择一条运行记录，自动对比上一个完成的 run。'}
              </div>
            )}
          </div>
        </section>

        <section className="mt-3.5 grid grid-cols-1 gap-3.5 lg:grid-cols-[320px_1fr]">
          {/* 左：数据集 + 运行历史 */}
          <div className="flex flex-col gap-3.5">
            <div className="rounded-[2px] bg-paper-2 p-4 shadow-lift">
              <div className="flex items-center justify-between">
                <div className="mono-label text-muted">DATASET</div>
                <span className="rounded-[2px] bg-paper-3 px-1.5 py-0.5 font-mono text-[10.5px] text-ink-2">
                  {overview?.dataset.code || 'golden-v1'}
                </span>
              </div>
              <div className="mt-2 font-display text-[17px] text-ink">
                {overview?.dataset.name || '客服回答金标集'}
              </div>
              <p className="mt-1.5 text-[12px] leading-relaxed text-muted">
                {overview?.dataset.description || '覆盖售前、售后、企业制度与合规的检索用例'}
              </p>

              <div className="mt-3 border-t border-rule pt-3">
                <div className="flex items-center justify-between">
                  <span className="mono-label text-muted">QUALITY GATE</span>
                  <span
                    className={`rounded-[2px] px-2 py-0.5 font-mono text-[10.5px] ${
                      latest && gatePass
                        ? 'bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200'
                        : 'bg-accent-50 text-accent-700 ring-1 ring-accent-100'
                    }`}
                  >
                    {latest ? (gatePass ? 'PASS' : 'REVIEW') : 'WAITING'}
                  </span>
                </div>
                <div className="mt-2 space-y-1 font-mono text-[10.5px] text-muted">
                  <div className="flex justify-between">
                    <span>Hit@5 ≥ {pct(GATE_HIT)}</span>
                    <span className={latest && latest.hit_rate >= GATE_HIT ? 'text-emerald-700' : ''}>
                      {latest ? pct(latest.hit_rate) : '—'}
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span>MRR ≥ {GATE_MRR.toFixed(2)}</span>
                    <span className={latest && latest.mrr >= GATE_MRR ? 'text-emerald-700' : ''}>
                      {latest ? latest.mrr.toFixed(3) : '—'}
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span>降级检索 = 0</span>
                    <span className={latest && latest.degraded_count === 0 ? 'text-emerald-700' : ''}>
                      {latest?.degraded_count ?? 0}
                    </span>
                  </div>
                </div>
              </div>
            </div>

            <div className="rounded-[2px] bg-paper-2 p-4 shadow-lift">
              <div className="flex items-center justify-between">
                <div className="mono-label text-muted">RUN HISTORY</div>
                <span className="font-mono text-[10.5px] text-muted">
                  {overview?.runs.length ?? 0} 次
                </span>
              </div>
              <div className="mt-2 divide-y divide-rule">
                {(overview?.runs ?? []).slice(0, 8).map((run) => {
                  const active = run.id === activeRun?.id;
                  return (
                    <button
                      key={run.id}
                      onClick={() => setSelected(run.id)}
                      className={`flex w-full items-center justify-between gap-2 py-2 text-left transition ${
                        active ? 'text-ink' : 'text-muted hover:text-ink'
                      }`}
                    >
                      <span className="flex items-center gap-2">
                        <span
                          className={`h-1.5 w-1.5 rounded-full ${
                            run.status === 'completed'
                              ? run.hit_rate >= GATE_HIT
                                ? 'bg-emerald-600'
                                : 'bg-accent'
                              : run.status === 'failed'
                                ? 'bg-rose-500'
                                : 'bg-apricot'
                          }`}
                        />
                        <span className="font-mono text-[11px]">#{run.id}</span>
                        <span className="text-[11.5px]">
                          {run.status === 'running'
                            ? `${run.progress}/${run.case_count || '—'}`
                            : run.status === 'failed'
                              ? '失败'
                              : pct(run.hit_rate)}
                        </span>
                      </span>
                      <span className="font-mono text-[10.5px] text-muted">
                        {run.started_at?.slice(5, 16) ?? '—'}
                      </span>
                    </button>
                  );
                })}
                {(overview?.runs.length ?? 0) === 0 && (
                  <div className="py-6 text-center text-[12px] text-muted">
                    还没有运行记录，点右上角「运行评测」。
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* 右：运行详情 + 用例结果 */}
          <div className="min-w-0 rounded-[2px] bg-paper-2 shadow-lift">
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-rule px-4 py-3">
              <div className="flex flex-wrap items-center gap-2">
                <span className="mono-label text-muted">RUN</span>
                <span className="font-mono text-[12px] text-ink">
                  #{activeRun?.id ?? '—'}
                </span>
                {activeRun && (
                  <span className="rounded-[2px] bg-paper-3 px-1.5 py-0.5 font-mono text-[10px] text-muted">
                    {activeRun.engine} · top{activeRun.top_k}
                  </span>
                )}
                {activeRun?.status === 'running' && (
                  <span className="font-mono text-[10.5px] text-accent-700">
                    {activeRun.progress}/{activeRun.case_count || overview?.dataset.cases}
                  </span>
                )}
              </div>
              <div className="flex items-center gap-1">
                {(
                  [
                    ['all', `全部 ${results.length}`],
                    ['miss', `未命中 ${misses.length}`],
                  ] as const
                ).map(([key, label]) => (
                  <button
                    key={key}
                    onClick={() => setFilter(key)}
                    className={`rounded-[2px] px-2.5 py-1 font-mono text-[10.5px] transition ${
                      filter === key
                        ? 'bg-ink text-paper-2'
                        : 'text-muted hover:text-ink'
                    }`}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>

            {activeRun?.status === 'running' && (
              <div className="border-b border-rule px-4 py-3">
                <div className="h-1 w-full overflow-hidden rounded-[1px] bg-paper-3">
                  <div
                    className="h-full bg-accent transition-all"
                    style={{
                      width: `${Math.min(
                        100,
                        ((activeRun.progress || 0) /
                          (activeRun.case_count || overview?.dataset.cases || 1)) *
                          100,
                      )}%`,
                    }}
                  />
                </div>
              </div>
            )}

            <div className="overflow-x-auto">
              <table className="w-full min-w-[760px] border-collapse text-left">
                <thead>
                  <tr className="border-b border-rule text-[10.5px] uppercase tracking-[0.12em] text-muted">
                    <th className="px-4 py-2 font-normal">编号</th>
                    <th className="px-2 py-2 font-normal">问题</th>
                    <th className="px-2 py-2 font-normal">期望来源</th>
                    <th className="px-2 py-2 font-normal">Top1 实际</th>
                    <th className="px-2 py-2 text-right font-normal">位次</th>
                    <th className="px-2 py-2 text-right font-normal">耗时</th>
                    <th className="px-2 py-2 text-right font-normal">结果</th>
                    <th className="px-4 py-2 text-right font-normal">复盘</th>
                  </tr>
                </thead>
                <tbody>
                  {shown.map((row) => (
                    <ResultRow
                      key={row.case_no}
                      row={row}
                      onChange={(status) => void changeReview(row.case_id, status)}
                    />
                  ))}
                  {shown.length === 0 && (
                    <tr>
                      <td colSpan={8} className="px-4 py-10 text-center text-[12px] text-muted">
                        {detail
                          ? '当前筛选下没有用例'
                          : activeRun?.status === 'running'
                            ? '评测运行中，结果会逐条写入…'
                            : '选择一条运行记录查看用例明细'}
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>

            {activeRun && activeRun.status !== 'running' && (
              <div className="flex flex-wrap items-center justify-between gap-2 border-t border-rule px-4 py-3 font-mono text-[10.5px] text-muted">
                <span>
                  started {activeRun.started_at ?? '—'} · finished {activeRun.finished_at ?? '—'}
                </span>
                <span>
                  {activeRun.note || '—'} · 降级 {activeRun.degraded_count}
                </span>
              </div>
            )}
          </div>
        </section>
      </div>
    </AppShell>
  );
}

function ResultRow({
  row,
  onChange,
}: {
  row: EvalCaseResult;
  onChange: (status: EvalReviewStatus) => void;
}) {
  const reviewTone =
    row.review_status === 'fixed'
      ? 'bg-emerald-50 text-emerald-700 ring-emerald-200'
      : row.review_status === 'ignored'
        ? 'bg-paper-3 text-muted ring-rule'
        : 'bg-accent-50 text-accent-700 ring-accent-100';
  return (
    <tr className="border-b border-rule/70 align-top transition hover:bg-accent-50/40">
      <td className="whitespace-nowrap px-4 py-2.5 font-mono text-[11px] text-muted">
        {row.case_no}
      </td>
      <td className="max-w-[280px] px-2 py-2.5 text-[12.5px] leading-snug text-ink" title={row.review_note ?? ''}>
        {row.question}
        {row.degraded && (
          <span className="ml-1 rounded-[2px] bg-apricot/10 px-1 font-mono text-[9.5px] text-apricot-deep">
            degraded
          </span>
        )}
      </td>
      <td className="whitespace-nowrap px-2 py-2.5 font-mono text-[11px] text-ink-2">
        {row.expected_doc}
      </td>
      <td
        className="max-w-[180px] truncate px-2 py-2.5 font-mono text-[11px] text-muted"
        title={row.top_docs ?? ''}
      >
        {row.retrieved_doc || '—'}
      </td>
      <td className="px-2 py-2.5 text-right font-mono text-[11px] tabular-nums text-ink">
        {row.rank > 0 ? `#${row.rank}` : '—'}
      </td>
      <td className="px-2 py-2.5 text-right font-mono text-[11px] tabular-nums text-muted">
        {row.latency_ms}
      </td>
      <td className="px-2 py-2.5 text-right">
        <span
          className={`inline-flex rounded-[2px] px-1.5 py-0.5 font-mono text-[10px] ${
            row.hit
              ? 'bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200'
              : 'bg-rose-50 text-rose-600 ring-1 ring-rose-200'
          }`}
        >
          {row.hit ? 'HIT' : 'MISS'}
        </span>
      </td>
      <td className="px-4 py-2.5 text-right">
        <select
          value={row.review_status}
          onChange={(e) => onChange(e.target.value as EvalReviewStatus)}
          aria-label={`${row.case_no} 复盘状态`}
          className={`cursor-pointer appearance-none rounded-[2px] px-1.5 py-0.5 text-center font-mono text-[10px] ring-1 outline-none ${reviewTone}`}
        >
          <option value="open">待复盘</option>
          <option value="fixed">已修复</option>
          <option value="ignored">已忽略</option>
        </select>
      </td>
    </tr>
  );
}

