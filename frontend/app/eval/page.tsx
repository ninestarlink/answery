'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import AppShell from '@/components/AppShell';
import {
  adminApi,
  type EvalCandidate,
  type EvalCase,
  type EvalCaseDraft,
  type EvalCaseResult,
  type EvalCompare,
  type EvalImportResult,
  type EvalJudgments,
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
  const [judgments, setJudgments] = useState<EvalJudgments | null>(null);
  const [judging, setJudging] = useState(false);
  const [datasetOpen, setDatasetOpen] = useState(false);
  const judgeTarget = useRef(0);
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

  const loadJudgments = useCallback(async (runId: number) => {
    try {
      setJudgments(await adminApi.evalJudgments(runId));
    } catch {
      setJudgments(null);
    }
  }, []);

  useEffect(() => {
    setJudging(false);
    setJudgments(null);
    if (selected) void loadJudgments(selected);
  }, [selected, loadJudgments]);

  // 裁判在后台逐条写入，这里轮询进度直到达到抽样数
  useEffect(() => {
    if (!judging || !selected) return;
    const started = Date.now();
    const timer = setInterval(async () => {
      const data = await adminApi.evalJudgments(selected).catch(() => null);
      if (!data) return;
      setJudgments(data);
      if (data.total >= judgeTarget.current || Date.now() - started > 180_000) {
        setJudging(false);
      }
    }, 2000);
    return () => clearInterval(timer);
  }, [judging, selected]);

  const runJudge = async (sample: number) => {
    if (!activeRun || activeRun.status !== 'completed' || judging) return;
    setJudging(true);
    judgeTarget.current = sample;
    try {
      await adminApi.evalJudge(activeRun.id, sample);
      await loadJudgments(activeRun.id);
      if (sample <= (judgments?.total ?? 0)) setJudging(false);
    } catch (e) {
      setJudging(false);
      setError(e instanceof Error ? e.message : '启动生成评测失败');
    }
  };

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
            <button
              onClick={() => setDatasetOpen(true)}
              className="press rounded-[2px] bg-paper-2 px-3 py-2 text-[12.5px] text-ink ring-1 ring-rule"
            >
              管理用例
            </button>
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

        {/* 生成质量：LLM 裁判抽样 */}
        <section className="mt-3.5 rounded-[2px] bg-paper-2 p-4 shadow-lift">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div>
              <div className="mono-label text-muted">GEN QUALITY · 生成质量评测</div>
              <p className="mt-1 max-w-[640px] text-[11.5px] leading-relaxed text-muted">
                用检索上下文让模型作答，再由裁判模型判定忠实度、相关性与引用是否正确，
                补上「资料找得到」之外的「回答是否可信」。抽样控制成本，已评过的用例不会重复计费。
              </p>
            </div>
            <div className="flex items-center gap-1.5">
              {[10, 20, 40].map((sample) => (
                <button
                  key={sample}
                  onClick={() => void runJudge(sample)}
                  disabled={
                    !activeRun ||
                    activeRun.status !== 'completed' ||
                    judging ||
                    Boolean(running)
                  }
                  className={`rounded-[2px] px-2.5 py-1 font-mono text-[10.5px] ring-1 transition disabled:opacity-50 ${
                    judging
                      ? 'bg-paper-3 text-muted ring-rule'
                      : 'bg-accent-50 text-accent-700 ring-accent-100 hover:bg-accent-100'
                  }`}
                >
                  抽样 {sample}
                </button>
              ))}
            </div>
          </div>

          {judgments && judgments.total > 0 ? (
            <>
              <div className="mt-3 grid grid-cols-2 gap-2 border-y border-rule py-3 md:grid-cols-5">
                <div>
                  <div className="mono-label text-muted">PASS RATE</div>
                  <div className="mt-1 font-display text-[21px] tabular-nums text-ink">
                    {pct(judgments.pass_rate)}
                  </div>
                  <div className="text-[10.5px] text-muted">
                    {judgments.pass_count}/{judgments.total} 通过
                  </div>
                </div>
                <div>
                  <div className="mono-label text-muted">FAITHFUL</div>
                  <div className="mt-1 font-display text-[21px] tabular-nums text-ink">
                    {pct(judgments.grounded_rate)}
                  </div>
                  <div className="text-[10.5px] text-muted">回答有资料依据</div>
                </div>
                <div>
                  <div className="mono-label text-muted">RELEVANCE</div>
                  <div className="mt-1 font-display text-[21px] tabular-nums text-ink">
                    {judgments.avg_relevance.toFixed(1)}
                    <span className="ml-0.5 text-[10.5px] font-normal text-muted">/ 5</span>
                  </div>
                  <div className="text-[10.5px] text-muted">平均相关性</div>
                </div>
                <div>
                  <div className="mono-label text-muted">CITATION</div>
                  <div className="mt-1 font-display text-[21px] tabular-nums text-ink">
                    {pct(judgments.citation_rate)}
                  </div>
                  <div className="text-[10.5px] text-muted">引用与期望来源一致</div>
                </div>
                <div>
                  <div className="mono-label text-muted">JUDGE LATENCY</div>
                  <div className="mt-1 font-display text-[21px] tabular-nums text-ink">
                    {judgments.avg_latency_ms}
                    <span className="ml-0.5 text-[10.5px] font-normal text-muted">ms</span>
                  </div>
                  <div className="text-[10.5px] text-muted">
                    {judging ? '评测中…' : `样本 ${judgments.total} 条`}
                  </div>
                </div>
              </div>

              {judgments.fail_count > 0 ? (
                <div className="mt-2.5 space-y-1">
                  {judgments.rows
                    .filter((r) => r.verdict === 'fail')
                    .slice(0, 4)
                    .map((r) => (
                      <div
                        key={r.case_no}
                        className="flex items-start justify-between gap-2 text-[11px]"
                      >
                        <span className="min-w-0 text-ink-2">
                          <span className="mr-1.5 font-mono text-[10px] text-rose-600">
                            {r.case_no}
                          </span>
                          <span className="font-medium">{r.question}</span>
                          <span className="ml-1.5 text-muted">{r.reason || '裁判判定不通过'}</span>
                        </span>
                        <span className="shrink-0 font-mono text-[10px] text-muted">
                          相关性 {r.relevance} · {r.latency_ms}ms
                        </span>
                      </div>
                    ))}
                  {judgments.fail_count > 4 && (
                    <div className="font-mono text-[10px] text-muted">
                      另有 {judgments.fail_count - 4} 条未通过，完整结果见表格与导出
                    </div>
                  )}
                </div>
              ) : (
                <div className="mt-2.5 text-[11.5px] text-emerald-700">
                  抽样回答全部通过：忠实、切题且引用了正确来源。
                </div>
              )}
            </>
          ) : (
            <div className="mt-3 rounded-[2px] border border-dashed border-rule px-3 py-6 text-center text-[12px] text-muted">
              {judging
                ? `正在抽样评测… 已完成 ${judgments?.total ?? 0}/${judgeTarget.current}`
                : activeRun?.status === 'completed'
                  ? '还没有生成质量样本，点右上角「抽样 10 / 20 / 40」。'
                  : '先完成一次检索评测，再抽样生成回答并裁判。'}
            </div>
          )}
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

      {datasetOpen && overview?.dataset.id != null && (
        <DatasetDrawer
          datasetId={overview.dataset.id}
          onClose={() => setDatasetOpen(false)}
          onChanged={() => {
            void load();
            if (selected) void loadDetail(selected);
          }}
        />
      )}
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

const SAMPLE_CSV = `case_no,question,kb_id,expected_doc,expected_keywords,category,difficulty
E41,新用例示例,shop,products,答案要点,商品咨询,normal`;

const INPUT_CLS =
  'w-full rounded-[2px] bg-paper-2 px-2 py-1.5 text-[12px] text-ink ring-1 ring-rule outline-none focus:ring-accent-300';

type CaseForm = {
  case_no: string;
  question: string;
  kb_id: string;
  expected_doc: string;
  expected_keywords: string;
  category: string;
  difficulty: string;
};

function blankCase(cases: EvalCase[]): CaseForm {
  return {
    case_no: nextCaseNo(cases),
    question: '',
    kb_id: 'shop',
    expected_doc: '',
    expected_keywords: '',
    category: '商品咨询',
    difficulty: 'normal',
  };
}

function nextCaseNo(cases: EvalCase[]) {
  const nums = cases
    .map((c) => /^E(\d+)$/.exec(c.case_no))
    .filter((m): m is RegExpExecArray => m !== null)
    .map((m) => Number(m[1]));
  const next = (nums.length ? Math.max(...nums) : 0) + 1;
  return `E${String(next).padStart(2, '0')}`;
}

function DatasetDrawer({
  datasetId,
  onClose,
  onChanged,
}: {
  datasetId: number;
  onClose: () => void;
  onChanged: () => void;
}) {
  const [tab, setTab] = useState<'cases' | 'import' | 'online'>('cases');
  const [cases, setCases] = useState<EvalCase[]>([]);
  const [form, setForm] = useState<CaseForm>({ ...blankCase([]), case_no: '' });
  const [editingId, setEditingId] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [csv, setCsv] = useState(SAMPLE_CSV);
  const [imported, setImported] = useState<EvalImportResult | null>(null);
  const [candidates, setCandidates] = useState<EvalCandidate[]>([]);
  const [candidateBusy, setCandidateBusy] = useState(false);

  const reload = useCallback(async () => {
    try {
      const data = await adminApi.evalCases(datasetId);
      setCases(data.cases);
      setForm((prev) => (prev.case_no ? prev : { ...prev, case_no: nextCaseNo(data.cases) }));
    } catch (e) {
      setError(e instanceof Error ? e.message : '加载用例失败');
    }
  }, [datasetId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const loadCandidates = useCallback(async () => {
    setCandidateBusy(true);
    try {
      const data = await adminApi.evalCandidates(20);
      setCandidates(data.candidates);
    } catch (e) {
      setError(e instanceof Error ? e.message : '加载线上样本失败');
    } finally {
      setCandidateBusy(false);
    }
  }, []);

  useEffect(() => {
    if (tab === 'online') void loadCandidates();
  }, [tab, loadCandidates]);

  const startNew = (preset?: Partial<CaseForm>) => {
    setEditingId(null);
    setError(null);
    setNotice(null);
    setForm({ ...blankCase(cases), ...preset });
  };

  const startEdit = (item: EvalCase) => {
    setEditingId(item.id);
    setTab('cases');
    setError(null);
    setNotice(null);
    setForm({
      case_no: item.case_no,
      question: item.question,
      kb_id: item.kb_id,
      expected_doc: item.expected_doc,
      expected_keywords: item.expected_keywords ?? '',
      category: item.category,
      difficulty: item.difficulty,
    });
  };

  const save = async () => {
    if (busy) return;
    if (!form.case_no.trim() || !form.question.trim() || !form.expected_doc.trim()) {
      setError('编号、问题、期望来源为必填项');
      return;
    }
    setBusy(true);
    setError(null);
    setNotice(null);
    const payload: EvalCaseDraft = {
      case_no: form.case_no.trim(),
      question: form.question.trim(),
      kb_id: form.kb_id,
      expected_doc: form.expected_doc.trim(),
      expected_keywords: form.expected_keywords.trim() || null,
      category: form.category.trim() || '未分类',
      difficulty: form.difficulty,
    };
    try {
      if (editingId) {
        await adminApi.evalUpdateCase(editingId, payload);
        setNotice('用例已更新');
      } else {
        await adminApi.evalCreateCase(datasetId, payload);
        setNotice('用例已新增');
      }
      setEditingId(null);
      setForm({ ...blankCase([]), case_no: '' });
      await reload();
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : '保存失败');
    } finally {
      setBusy(false);
    }
  };

  const remove = async (item: EvalCase) => {
    if (!window.confirm(`删除用例 ${item.case_no}？关联的评测结果也会一起清理。`)) return;
    setBusy(true);
    setError(null);
    try {
      await adminApi.evalDeleteCase(item.id);
      if (editingId === item.id) startNew();
      setNotice(`已删除 ${item.case_no}`);
      await reload();
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : '删除失败');
    } finally {
      setBusy(false);
    }
  };

  const runImport = async () => {
    if (busy || !csv.trim()) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const result = await adminApi.evalImportCases(datasetId, csv);
      setImported(result);
      await reload();
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : '导入失败');
    } finally {
      setBusy(false);
    }
  };

  const adopt = (candidate: EvalCandidate) => {
    setTab('cases');
    setEditingId(null);
    setError(null);
    setNotice('已填入线上问题，补充「期望来源」后保存');
    setForm({
      ...blankCase(cases),
      question: candidate.question,
      kb_id: candidate.kb_id,
      category: candidate.category,
    });
  };

  const tabs = [
    ['cases', `用例列表 ${cases.length}`],
    ['import', 'CSV 导入'],
    ['online', '线上抽样'],
  ] as const;

  return (
    <>
      <div className="fixed inset-0 z-40 bg-ink/25" onClick={onClose} />
      <aside className="fixed right-0 top-0 z-50 flex h-full w-full max-w-[700px] flex-col border-l border-rule bg-paper-2 shadow-2xl">
        <header className="flex items-center justify-between border-b border-rule px-4 py-3">
          <div>
            <div className="mono-label text-muted">DATASET #{datasetId}</div>
            <div className="text-[16px] font-medium text-ink">金标用例管理</div>
          </div>
          <button
            onClick={onClose}
            className="press rounded-[2px] bg-paper-3 px-2.5 py-1.5 text-[12px] text-ink-2 ring-1 ring-rule"
          >
            关闭
          </button>
        </header>

        <div className="flex gap-1 border-b border-rule px-4 py-2">
          {tabs.map(([key, label]) => (
            <button
              key={key}
              onClick={() => {
                setTab(key);
                setNotice(null);
                setError(null);
              }}
              className={`rounded-[2px] px-2.5 py-1 font-mono text-[10.5px] transition ${
                tab === key ? 'bg-ink text-paper-2' : 'text-muted hover:text-ink'
              }`}
            >
              {label}
            </button>
          ))}
        </div>

        {(notice || error) && (
          <div
            className={`mx-4 mt-3 rounded-[2px] px-3 py-2 text-[11.5px] ring-1 ${
              error
                ? 'bg-rose-50 text-rose-600 ring-rose-200'
                : 'bg-emerald-50 text-emerald-700 ring-emerald-200'
            }`}
          >
            {error || notice}
          </div>
        )}

        <div className="flex-1 overflow-y-auto p-4">
          {tab === 'cases' && (
            <>
              <div className="rounded-[2px] bg-paper-3 p-3">
                <div className="flex items-center justify-between">
                  <span className="mono-label text-muted">
                    {editingId ? `编辑用例 ${form.case_no}` : '新增用例'}
                  </span>
                  {editingId && (
                    <button
                      onClick={() => startNew()}
                      className="font-mono text-[10.5px] text-muted hover:text-ink"
                    >
                      取消编辑
                    </button>
                  )}
                </div>

                <div className="mt-2 grid grid-cols-2 gap-2">
                  <label className="block">
                    <span className="mono-label text-muted">编号</span>
                    <input
                      value={form.case_no}
                      onChange={(e) => setForm({ ...form, case_no: e.target.value })}
                      className={INPUT_CLS}
                      placeholder="E41"
                    />
                  </label>
                  <label className="block">
                    <span className="mono-label text-muted">知识库</span>
                    <select
                      value={form.kb_id}
                      onChange={(e) => setForm({ ...form, kb_id: e.target.value })}
                      className={INPUT_CLS}
                    >
                      <option value="shop">shop · 商品/售后</option>
                      <option value="enterprise">enterprise · 企业制度</option>
                    </select>
                  </label>
                  <label className="col-span-2 block">
                    <span className="mono-label text-muted">问题</span>
                    <textarea
                      value={form.question}
                      onChange={(e) => setForm({ ...form, question: e.target.value })}
                      rows={2}
                      className={INPUT_CLS}
                      placeholder="用户会怎么问？"
                    />
                  </label>
                  <label className="block">
                    <span className="mono-label text-muted">期望来源</span>
                    <input
                      value={form.expected_doc}
                      onChange={(e) => setForm({ ...form, expected_doc: e.target.value })}
                      className={INPUT_CLS}
                      placeholder="products / returns / 信息安全规范"
                    />
                  </label>
                  <label className="block">
                    <span className="mono-label text-muted">场景</span>
                    <input
                      value={form.category}
                      onChange={(e) => setForm({ ...form, category: e.target.value })}
                      className={INPUT_CLS}
                      placeholder="商品咨询"
                    />
                  </label>
                  <label className="col-span-2 block">
                    <span className="mono-label text-muted">答案要点</span>
                    <input
                      value={form.expected_keywords}
                      onChange={(e) => setForm({ ...form, expected_keywords: e.target.value })}
                      className={INPUT_CLS}
                      placeholder="逗号分隔，供人工复盘"
                    />
                  </label>
                  <label className="block">
                    <span className="mono-label text-muted">难度</span>
                    <select
                      value={form.difficulty}
                      onChange={(e) => setForm({ ...form, difficulty: e.target.value })}
                      className={INPUT_CLS}
                    >
                      <option value="easy">easy</option>
                      <option value="normal">normal</option>
                      <option value="hard">hard</option>
                    </select>
                  </label>
                  <div className="flex items-end justify-end">
                    <button
                      onClick={() => void save()}
                      disabled={busy}
                      className="press rounded-[2px] bg-accent px-3 py-1.5 text-[12px] font-medium text-accent-ink shadow-lift disabled:opacity-60"
                    >
                      {busy ? '保存中…' : editingId ? '保存修改' : '新增用例'}
                    </button>
                  </div>
                </div>
              </div>

              <div className="mt-3 flex items-center justify-between">
                <span className="font-mono text-[10.5px] text-muted">共 {cases.length} 条</span>
                <button
                  onClick={() => startNew()}
                  className="font-mono text-[10.5px] text-accent-700 hover:underline"
                >
                  + 新增空白用例
                </button>
              </div>
              <div className="mt-1 divide-y divide-rule border-y border-rule">
                {cases.map((item) => (
                  <div key={item.id} className="flex items-start justify-between gap-2 py-2">
                    <div className="min-w-0">
                      <div className="flex items-baseline gap-1.5">
                        <span className="shrink-0 font-mono text-[10.5px] text-muted">
                          {item.case_no}
                        </span>
                        <span className="truncate text-[12px] text-ink" title={item.question}>
                          {item.question}
                        </span>
                      </div>
                      <div className="mt-0.5 truncate font-mono text-[10px] text-muted">
                        {item.kb_id} · {item.expected_doc} · {item.category} · {item.difficulty}
                      </div>
                    </div>
                    <div className="flex shrink-0 gap-1">
                      <button
                        onClick={() => startEdit(item)}
                        className="rounded-[2px] px-1.5 py-0.5 font-mono text-[10px] text-muted ring-1 ring-rule hover:text-ink"
                      >
                        编辑
                      </button>
                      <button
                        onClick={() => void remove(item)}
                        className="rounded-[2px] px-1.5 py-0.5 font-mono text-[10px] text-rose-600 ring-1 ring-rose-200 hover:bg-rose-50"
                      >
                        删除
                      </button>
                    </div>
                  </div>
                ))}
                {cases.length === 0 && (
                  <div className="py-10 text-center text-[12px] text-muted">
                    还没有用例，先新增或导入 CSV。
                  </div>
                )}
              </div>
            </>
          )}

          {tab === 'import' && (
            <>
              <div className="text-[12px] leading-relaxed text-muted">
                表头支持中英文（编号/问题/知识库/期望来源/答案要点/场景/难度）。
                按 case_no 幂等覆盖：已存在则更新，不存在则新增，失败行会单独列出。
              </div>
              <textarea
                value={csv}
                onChange={(e) => setCsv(e.target.value)}
                rows={11}
                spellCheck={false}
                className="mt-2 w-full rounded-[2px] bg-paper-3 px-3 py-2 font-mono text-[11px] leading-relaxed text-ink ring-1 ring-rule outline-none focus:ring-accent-300"
              />
              <div className="mt-2 flex items-center justify-between gap-2">
                <span className="font-mono text-[10px] text-muted">
                  case_no,question,kb_id,expected_doc,expected_keywords,category,difficulty
                </span>
                <button
                  onClick={() => void runImport()}
                  disabled={busy}
                  className="press shrink-0 rounded-[2px] bg-accent px-3 py-1.5 text-[12px] font-medium text-accent-ink shadow-lift disabled:opacity-60"
                >
                  {busy ? '导入中…' : '导入 CSV'}
                </button>
              </div>
              {imported && (
                <div className="mt-3 rounded-[2px] bg-paper-3 px-3 py-2.5 text-[11.5px] text-ink-2">
                  <div className="font-mono text-[10.5px]">
                    新增 {imported.created} · 更新 {imported.updated} · 失败 {imported.failed}
                  </div>
                  {imported.errors.length > 0 && (
                    <ul className="mt-1.5 space-y-0.5 text-[10.5px] text-rose-600">
                      {imported.errors.map((item) => (
                        <li key={item}>{item}</li>
                      ))}
                    </ul>
                  )}
                </div>
              )}
            </>
          )}

          {tab === 'online' && (
            <>
              <div className="flex items-start justify-between gap-2">
                <div>
                  <div className="mono-label text-muted">ONLINE · 线上抽样回灌</div>
                  <p className="mt-1 text-[11.5px] leading-relaxed text-muted">
                    取自 chat_trace 的真实问题，已进入金标集的问题自动过滤。
                    点「加入金标集」填入表单，补一个期望来源即可保存。
                  </p>
                </div>
                <button
                  onClick={() => void loadCandidates()}
                  disabled={candidateBusy}
                  className="press shrink-0 rounded-[2px] bg-paper-3 px-2.5 py-1.5 font-mono text-[10.5px] text-ink-2 ring-1 ring-rule disabled:opacity-60"
                >
                  {candidateBusy ? '加载中…' : '刷新'}
                </button>
              </div>

              <div className="mt-2 divide-y divide-rule border-y border-rule">
                {candidates.map((item) => (
                  <div key={item.id} className="flex items-start justify-between gap-2 py-2.5">
                    <div className="min-w-0">
                      <div className="text-[12px] leading-snug text-ink">{item.question}</div>
                      <div className="mt-1 flex flex-wrap items-center gap-1.5 font-mono text-[10px] text-muted">
                        <span
                          className={`rounded-[2px] px-1 ${
                            item.status === 'ok'
                              ? 'bg-emerald-50 text-emerald-700'
                              : 'bg-rose-50 text-rose-600'
                          }`}
                        >
                          {item.status}
                        </span>
                        <span>{item.kb_id}</span>
                        <span>hits {item.hits}</span>
                        <span>tools {item.tools}</span>
                        <span>{item.created_at ?? '—'}</span>
                      </div>
                    </div>
                    <button
                      onClick={() => adopt(item)}
                      className="press shrink-0 rounded-[2px] bg-accent-50 px-2 py-1 font-mono text-[10px] text-accent-700 ring-1 ring-accent-100 hover:bg-accent-100"
                    >
                      加入金标集
                    </button>
                  </div>
                ))}
                {candidates.length === 0 && (
                  <div className="py-10 text-center text-[12px] text-muted">
                    暂无新的线上问题。先到客服页产生几段对话，再回来抽样。
                  </div>
                )}
              </div>
            </>
          )}
        </div>
      </aside>
    </>
  );
}

