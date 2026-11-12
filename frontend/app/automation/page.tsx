'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import AppShell from '@/components/AppShell';
import {
  adminApi,
  type AutomationJob,
  type AutomationRunRow,
} from '@/lib/adminApi';

const POLL_INTERVAL = 3_000;
const IDLE_INTERVAL = 15_000;

export default function AutomationPage() {
  const [jobs, setJobs] = useState<AutomationJob[]>([]);
  const [runs, setRuns] = useState<AutomationRunRow[]>([]);
  const [schedulerRunning, setSchedulerRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [auto, setAuto] = useState(true);
  const [loading, setLoading] = useState(false);
  const [triggering, setTriggering] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const busy = useRef(false);

  const hasRunning = runs.some((r) => r.status === 'running');

  const load = useCallback(async () => {
    if (busy.current) return;
    if (document.visibilityState !== 'visible') return;
    busy.current = true;
    try {
      const [jobRes, runRes] = await Promise.all([
        adminApi.automationJobs(),
        adminApi.automationRuns(30),
      ]);
      setJobs(jobRes.jobs);
      setSchedulerRunning(jobRes.scheduler_running);
      setRuns(runRes.items);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : '加载失败');
    } finally {
      busy.current = false;
    }
  }, []);

  useEffect(() => {
    setLoading(true);
    void load().finally(() => setLoading(false));
  }, [load]);

  useEffect(() => {
    if (!auto) return;
    const timer = setInterval(
      () => void load(),
      hasRunning ? POLL_INTERVAL : IDLE_INTERVAL,
    );
    return () => clearInterval(timer);
  }, [auto, hasRunning, load]);

  const runNow = async (job: AutomationJob, force = false) => {
    setTriggering(`${job.key}${force ? ':force' : ''}`);
    setNotice(null);
    try {
      const res = await adminApi.automationRun(job.key, force);
      setNotice(
        res.duplicated
          ? `「${job.name}」本轮已执行过（幂等键 ${res.run.idempotency_key}），直接复用记录 #${res.run.id}`
          : `已触发「${job.name}」，后台执行中，结果会自动刷新`,
      );
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : '触发失败');
    } finally {
      setTriggering(null);
    }
  };

  const exportRuns = async () => {
    setExporting(true);
    setNotice(null);
    try {
      const blob = await adminApi.automationExport();
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `automation-${new Date().toISOString().slice(0, 10)}.xlsx`;
      link.click();
      URL.revokeObjectURL(url);
      setNotice('已导出运行历史与各任务最近一次结果（Excel）');
    } catch (e) {
      setError(e instanceof Error ? e.message : '导出失败');
    } finally {
      setExporting(false);
    }
  };

  return (
    <AppShell>
      <div className="mx-auto w-full max-w-[1180px]">
        <header className="flex flex-wrap items-end justify-between gap-3 border-b border-rule border-t-[3px] border-t-ink-900 pb-3 pt-3">
          <div>
            <div className="mono-label text-muted">Automation / 运营自动化</div>
            <h1 className="mt-1.5 text-[26px] leading-tight text-slate-900 md:text-[30px]">
              运营自动化
            </h1>
            <p className="mt-1 text-[13px] text-slate-600">
              代码注册的定时任务，按幂等键落库；执行中每 3 秒刷新，空闲每 15 秒刷新。
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <span
              className={`rounded-[2px] px-2.5 py-1 text-[11.5px] font-medium hairline ${
                schedulerRunning
                  ? 'bg-emerald-50 text-emerald-600'
                  : 'bg-amber-50 text-amber-600'
              }`}
            >
              调度器 {schedulerRunning ? '运行中' : '未启动'}
            </span>
            <button
              onClick={() => setAuto((v) => !v)}
              className={`press rounded-[2px] px-3 py-1.5 text-[12px] font-medium hairline ${
                auto ? 'bg-emerald-50 text-emerald-600' : 'bg-paper-2 text-slate-600'
              }`}
            >
              {auto ? '自动刷新 · 开' : '自动刷新 · 关'}
            </button>
            <button
              onClick={() => void exportRuns()}
              disabled={exporting}
              title="导出运行历史与各任务最近一次结果"
              className="press rounded-[2px] bg-paper-2 px-3 py-1.5 text-[12px] font-medium text-slate-600 hairline hover:text-slate-900 disabled:opacity-60"
            >
              {exporting ? '导出中…' : '导出 Excel'}
            </button>
            <button
              onClick={() => {
                setLoading(true);
                void load().finally(() => setLoading(false));
              }}
              disabled={loading}
              className="press rounded-[2px] bg-accent px-3.5 py-1.5 text-[12px] font-medium text-accent-ink hover:bg-accent-hi disabled:opacity-60"
            >
              {loading ? '刷新中' : '立即刷新'}
            </button>
          </div>
        </header>

        {error && (
          <div className="mt-4 rounded-2xl bg-rose-50/80 px-4 py-3 text-[13px] text-rose-600 hairline">
            自动化接口不可用：{error}
          </div>
        )}
        {notice && (
          <div className="mt-4 rounded-2xl bg-emerald-50/60 px-4 py-3 text-[13px] text-emerald-700 hairline">
            {notice}
          </div>
        )}

        <section className="mt-4 grid grid-cols-1 gap-3.5 md:grid-cols-3">
          {jobs.map((job) => {
            const latest = runs.find((r) => r.job_key === job.key) ?? null;
            return (
              <div key={job.key} className="flex flex-col rounded-[2px] bg-paper-2 p-4 shadow-lift md:p-5">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="text-[13.5px] font-semibold text-slate-800">{job.name}</div>
                    <div className="mt-0.5 font-mono text-[11px] text-slate-400">{job.key}</div>
                  </div>
                  <span className="shrink-0 rounded-[2px] bg-paper-3 px-2 py-0.5 text-[11px] text-slate-600">
                    {job.schedule_label}
                  </span>
                </div>

                <p className="mt-2.5 min-h-[48px] text-[12px] leading-relaxed text-slate-600">
                  {job.description}
                </p>

                <div className="mt-2 flex items-center justify-between rounded-[2px] bg-canvas px-2.5 py-2">
                  <span className="text-[11px] text-slate-500">下次执行</span>
                  <span className="font-mono text-[11.5px] tabular-nums text-slate-700">
                    {job.next_run_at ? job.next_run_at.slice(5, 16) : '—'}
                  </span>
                </div>

                <div className="mt-2.5">
                  <div className="flex items-center gap-1.5">
                    <StatusBadge status={latest?.status} />
                    <span className="truncate text-[11px] text-slate-500">
                      {latest?.started_at ? latest.started_at.slice(5, 16) : '暂无执行记录'}
                    </span>
                  </div>
                  <div
                    className={`mt-1.5 line-clamp-2 min-h-[32px] text-[11.5px] leading-4 ${
                      latest?.status === 'failed' ? 'text-rose-500' : 'text-slate-600'
                    }`}
                    title={latest ? summaryText(latest) : ''}
                  >
                    {summaryText(latest)}
                  </div>
                </div>

                <div className="mt-3 flex items-center gap-2">
                  <button
                    onClick={() => void runNow(job)}
                    disabled={triggering !== null || latest?.status === 'running'}
                    className="press flex-1 rounded-[2px] bg-accent px-3 py-1.5 text-[12px] font-medium text-accent-ink hover:bg-accent-hi disabled:opacity-50"
                  >
                    {triggering === job.key ? '触发中…' : '立即运行'}
                  </button>
                  <button
                    onClick={() => void runNow(job, true)}
                    disabled={triggering !== null}
                    title="忽略幂等键，强制再执行一次（演示用）"
                    className="press rounded-[2px] px-2.5 py-1.5 text-[12px] text-slate-500 hairline hover:text-slate-800 disabled:opacity-50"
                  >
                    强制
                  </button>
                </div>
              </div>
            );
          })}
        </section>

        <section className="mt-3.5 rounded-[2px] bg-paper-2 p-4 shadow-lift md:p-5">
          <div className="flex items-center justify-between">
            <div className="text-[13.5px] font-semibold text-slate-800">运行历史</div>
            <span className="text-[11.5px] text-slate-500">
              automation_runs · 最近 {runs.length} 条
            </span>
          </div>

          {runs.length === 0 ? (
            <p className="mt-2.5 text-[12px] text-slate-500">
              还没有执行记录。点上面的「立即运行」，或等调度器到点自动触发。
            </p>
          ) : (
            <div className="nice-scroll mt-2.5 overflow-x-auto">
              <table className="w-full min-w-[860px] border-separate border-spacing-y-1 text-left">
                <thead>
                  <tr className="text-[11px] font-medium text-slate-400">
                    <th className="px-2 pb-1">时间</th>
                    <th className="px-2 pb-1">任务</th>
                    <th className="px-2 pb-1">触发</th>
                    <th className="px-2 pb-1">状态</th>
                    <th className="px-2 pb-1 text-right">耗时</th>
                    <th className="px-2 pb-1">结果</th>
                    <th className="px-2 pb-1">幂等键</th>
                  </tr>
                </thead>
                <tbody>
                  {runs.map((run) => (
                    <tr key={run.id} className="rounded-xl bg-paper-2 text-[12px] text-slate-600">
                      <td className="whitespace-nowrap px-2 py-1.5 tabular-nums text-slate-500">
                        {(run.started_at || '').slice(5, 16)}
                      </td>
                      <td className="whitespace-nowrap px-2 py-1.5">{run.job_name}</td>
                      <td className="whitespace-nowrap px-2 py-1.5">
                        {run.trigger === 'manual' ? '手动' : run.trigger === 'agent' ? 'Agent' : '定时'}
                      </td>
                      <td className="whitespace-nowrap px-2 py-1.5">
                        <StatusBadge status={run.status} />
                      </td>
                      <td className="whitespace-nowrap px-2 py-1.5 text-right tabular-nums">
                        {formatDuration(run.duration_ms)}
                      </td>
                      <td
                        className={`max-w-[320px] truncate px-2 py-1.5 ${
                          run.status === 'failed' ? 'text-rose-500' : ''
                        }`}
                        title={summaryText(run)}
                      >
                        {summaryText(run)}
                      </td>
                      <td
                        className="max-w-[220px] truncate px-2 py-1.5 font-mono text-[11px] text-slate-400"
                        title={run.idempotency_key}
                      >
                        {run.idempotency_key}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        <section className="mt-3.5 rounded-[2px] bg-paper-2 p-4 shadow-lift md:p-5">
          <div className="text-[13.5px] font-semibold text-slate-800">设计说明</div>
          <ul className="mt-2.5 space-y-1.5 text-[12px] leading-relaxed text-slate-600">
            <li>· 任务是代码注册的固定清单，不提供任务 CRUD：定时策略随代码评审一起变更。</li>
            <li>· 幂等键由数据库唯一索引兜底，同一轮重复触发只会复用已有记录，不会重复写库或重复跑评测。</li>
            <li>· 调度只做进程内触发（APScheduler），没有引入 Temporal / Airflow 之类的工作流引擎。</li>
            <li>· 除定时与手动外，Agent 可调用 trigger_automation_job 触发任务；kb_sync 走审批，其余直接执行，运行记录标注 trigger=agent。</li>
            <li>· 运行历史可一键导出 Excel（运行明细 + 各任务最近一次摘要），用于周报归档。</li>
            <li>· 每次执行都落 automation_runs，失败原因、耗时与摘要可直接在页面复盘。</li>
          </ul>
        </section>
      </div>
    </AppShell>
  );
}

function StatusBadge({ status }: { status?: AutomationRunRow['status'] }) {
  if (!status) {
    return (
      <span className="rounded-[2px] bg-paper-3 px-2 py-0.5 text-[11px] font-medium text-slate-500">
        未运行
      </span>
    );
  }
  const style =
    status === 'success'
      ? 'bg-emerald-50 text-emerald-600'
      : status === 'failed'
        ? 'bg-rose-50 text-rose-600'
        : 'bg-amber-50 text-amber-600';
  const label = status === 'success' ? '成功' : status === 'failed' ? '失败' : '执行中';
  return (
    <span className={`rounded-[2px] px-2 py-0.5 text-[11px] font-medium ${style}`}>{label}</span>
  );
}

function num(value: unknown): number {
  return typeof value === 'number' ? value : 0;
}

/** 把不同任务的 summary 渲染成一行可读结论 */
function summaryText(run: AutomationRunRow | null): string {
  if (!run) return '暂无执行记录';
  if (run.status === 'running') return '执行中…';
  if (run.status === 'failed') return run.error || '执行失败';

  const s = run.summary ?? {};
  switch (run.job_key) {
    case 'kb_sync':
      return `变更 ${num(s.changed_docs)} 篇 · 跳过 ${num(s.skipped_docs)} 篇 · 子块 ${num(s.children)}`;
    case 'nightly_eval':
      return `Hit@5 ${(num(s.hit_rate) * 100).toFixed(1)}% · MRR ${num(s.mrr).toFixed(3)} · ${num(s.case_count)} 条用例`;
    case 'stale_ticket_scan':
      return `超时工单 ${num(s.count)} 个 · 阈值 ${num(s.threshold_hours)}h`;
    default:
      return JSON.stringify(s);
  }
}

function formatDuration(ms: number): string {
  if (!ms) return '—';
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}
