﻿'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import AppShell from '@/components/AppShell';
import {
  adminApi,
  type ChatTraceRow,
  type MonitorResponse,
  type MonitorService,
} from '@/lib/adminApi';

const SERVICES_INTERVAL = 1_000;
const STATS_INTERVAL = 30_000;

export default function MonitorPage() {
  const [services, setServices] = useState<MonitorService[]>([]);
  const [stats, setStats] = useState<MonitorResponse | null>(null);
  const [traces, setTraces] = useState<ChatTraceRow[]>([]);
  const [checkedAt, setCheckedAt] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [auto, setAuto] = useState(true);
  const [loading, setLoading] = useState(false);
  const svcBusy = useRef(false);
  const statsBusy = useRef(false);
  const tracesBusy = useRef(false);

  const requestServices = useCallback(async () => {
    if (svcBusy.current) return;
    if (document.visibilityState !== 'visible') return;
    svcBusy.current = true;
    try {
      const res = await adminApi.services();
      setServices(res.services);
      setCheckedAt(res.checked_at);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : '加载失败');
    } finally {
      svcBusy.current = false;
    }
  }, []);

  const requestStats = useCallback(async () => {
    if (statsBusy.current) return;
    if (document.visibilityState !== 'visible') return;
    statsBusy.current = true;
    try {
      setStats(await adminApi.monitor(false));
    } catch (e) {
      setError(e instanceof Error ? e.message : '加载失败');
    } finally {
      statsBusy.current = false;
    }
  }, []);

  const requestTraces = useCallback(async () => {
    if (tracesBusy.current) return;
    if (document.visibilityState !== 'visible') return;
    tracesBusy.current = true;
    try {
      const res = await adminApi.traces(20);
      setTraces(res.traces);
    } catch (e) {
      setError(e instanceof Error ? e.message : '加载失败');
    } finally {
      tracesBusy.current = false;
    }
  }, []);

  const refreshAll = useCallback(async () => {
    setLoading(true);
    await Promise.all([requestServices(), requestStats(), requestTraces()]);
    setLoading(false);
  }, [requestServices, requestStats, requestTraces]);

  useEffect(() => {
    void requestServices();
    void requestStats();
    void requestTraces();
  }, [requestServices, requestStats, requestTraces]);

  useEffect(() => {
    if (!auto) return;
    const serviceTimer = setInterval(() => void requestServices(), SERVICES_INTERVAL);
    const statsTimer = setInterval(() => void requestStats(), STATS_INTERVAL);
    const tracesTimer = setInterval(() => void requestTraces(), STATS_INTERVAL);
    return () => {
      clearInterval(serviceTimer);
      clearInterval(statsTimer);
      clearInterval(tracesTimer);
    };
  }, [auto, requestServices, requestStats, requestTraces]);

  const healthy = services.length > 0 && services.every((s) => s.status === 'ok');

  return (
    <AppShell>
      <div className="mx-auto w-full max-w-[1180px]">
        <header className="flex flex-wrap items-end justify-between gap-3 border-b border-rule border-t-[3px] border-t-ink-900 pb-3 pt-3">
          <div>
            <div className="mono-label text-muted">
              Observability / 系统监控
            </div>
            <h1 className="mt-1.5 text-[26px] leading-tight text-slate-900 md:text-[30px]">
              系统监控
            </h1>
            <p className="mt-1 text-[13px] text-slate-600">
              依赖健康每 {auto ? '3' : '—'} 秒刷新，业务指标每 {auto ? '30' : '—'} 秒刷新。
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => setAuto((v) => !v)}
              className={`press rounded-[2px] px-3 py-1.5 text-[12px] font-medium hairline ${
                auto ? 'bg-emerald-50 text-emerald-600' : 'bg-paper-2 text-slate-600'
              }`}
            >
              {auto ? '自动刷新 · 开' : '自动刷新 · 关'}
            </button>
            <button
              onClick={() => void refreshAll()}
              disabled={loading}
              className="press rounded-[2px] bg-accent px-3.5 py-1.5 text-[12px] font-medium text-accent-ink hover:bg-accent-hi disabled:opacity-60"
            >
              {loading ? '刷新中' : '立即刷新'}
            </button>
          </div>
        </header>

        {error && (
          <div className="mt-4 rounded-2xl bg-rose-50/80 px-4 py-3 text-[13px] text-rose-600 hairline">
            监控接口不可用：{error}
          </div>
        )}

        {/* 总体状态 */}
        <div
          className={`mt-4 flex items-center gap-3 rounded-[2px] p-4 hairline md:p-5 ${
            healthy
              ? 'bg-gradient-to-r from-accent-50/90 to-paper-2'
              : 'bg-gradient-to-r from-paper-3/90 to-paper-2'
          }`}
        >
          <div
            className={`relative flex h-11 w-11 shrink-0 items-center justify-center rounded-[2px] ${
              healthy ? 'bg-accent text-accent-ink' : 'bg-paper-3 text-ink-2 hairline'
            }`}
          >
            <svg viewBox="0 0 24 24" fill="currentColor" className="h-5 w-5">
              <path d="M12 2a10 10 0 100 20 10 10 0 000-20zm-1.2 14.4l-4-4 1.4-1.4 2.6 2.6 5.6-5.6 1.4 1.4-7 7z" />
            </svg>
          </div>
          <div className="min-w-0 flex-1">
            <div className="text-[14px] font-semibold text-slate-900">
              {healthy ? '所有依赖运行正常' : '有依赖未就绪'}
            </div>
            <div className="mt-0.5 text-[12px] text-slate-600">
              最近检查：{checkedAt || '—'} · 运行时长 {formatUptime(stats?.uptime_seconds)}
            </div>
          </div>
          <div className="hidden text-right sm:block">
            <div className="text-[11.5px] text-slate-500">今日 Token</div>
            <div className="text-[17px] font-semibold tabular-nums text-slate-900">
              {(stats?.tokens_today ?? 0).toLocaleString()}
            </div>
          </div>
        </div>

        {/* 服务卡片 */}
        <section className="mt-3.5 grid grid-cols-1 gap-3.5 md:grid-cols-3">
          {services
            .filter((s) => !s.name.startsWith('硅基流动'))
            .map((s) => (
              <div
                key={s.name}
                className="rounded-[2px] bg-paper-2 p-4 shadow-lift md:p-5"
              >
                <div className="flex items-center justify-between">
                  <div className="text-[13px] font-semibold text-slate-800">{s.name}</div>
                  <span
                    className={`inline-flex items-center gap-1 rounded-[2px] px-2 py-0.5 text-[11px] font-medium ${
                      s.status === 'ok'
                        ? 'bg-emerald-50 text-emerald-600'
                        : s.status === 'unconfigured'
                          ? 'bg-amber-50 text-amber-600'
                          : 'bg-rose-50 text-rose-600'
                    }`}
                  >
                    <span
                      className={`h-1.5 w-1.5 rounded-full ${
                        s.status === 'ok'
                          ? 'bg-emerald-500'
                          : s.status === 'unconfigured'
                            ? 'bg-amber-500'
                            : 'bg-rose-500'
                      }`}
                    />
                    {s.status === 'ok' ? '正常' : s.status === 'unconfigured' ? '未配置' : '异常'}
                  </span>
                </div>
                <div className="mt-1 truncate font-mono text-[11.5px] text-slate-500">
                  {s.target}
                </div>

                <div className="mt-3 flex items-end justify-between">
                  <div>
                    <div className="text-[11px] text-slate-500">响应延迟</div>
                    <div className="mt-0.5 text-[22px] font-semibold leading-none tabular-nums text-slate-900">
                      {s.latency_ms != null ? s.latency_ms : '—'}
                      <span className="ml-1 text-[11.5px] font-normal text-slate-500">ms</span>
                    </div>
                  </div>
                  <LatencyBars latency={s.latency_ms} status={s.status} />
                </div>

                {s.error && (
                  <div className="mt-2 truncate text-[11px] text-rose-500" title={s.error}>
                    {s.error}
                  </div>
                )}
              </div>
            ))}
        </section>

        {/* 业务指标 */}
        <section className="mt-3.5 grid grid-cols-3 gap-2.5 md:grid-cols-3">
          <Metric label="今日消息" value={stats?.messages_today} unit="条" />
          <Metric label="今日 Token" value={stats?.tokens_today} unit="tk" />
          <Metric
            label="运行时长"
            value={stats ? Math.floor((stats.uptime_seconds ?? 0) / 60) : undefined}
            unit="min"
          />
        </section>

        {/* 对话执行轨迹 */}
        <section className="mt-3.5 rounded-[2px] bg-paper-2 p-4 shadow-lift md:p-5">
          <div className="flex items-center justify-between">
            <div className="text-[13.5px] font-semibold text-slate-800">最近执行轨迹</div>
            <span className="text-[11.5px] text-slate-500">chat_trace · 最近 {traces.length} 条</span>
          </div>

          {traces.length === 0 ? (
            <p className="mt-2.5 text-[12px] text-slate-500">
              还没有对话记录，去任一应用问一句就会出现在这里。
            </p>
          ) : (
            <div className="nice-scroll mt-2.5 overflow-x-auto">
              <table className="w-full min-w-[760px] border-separate border-spacing-y-1 text-left">
                <thead>
                  <tr className="text-[11px] font-medium text-slate-400">
                    <th className="px-2 pb-1">时间</th>
                    <th className="px-2 pb-1">应用</th>
                    <th className="px-2 pb-1">问题</th>
                    <th className="px-2 pb-1">状态</th>
                    <th className="px-2 pb-1 text-right">命中</th>
                    <th className="px-2 pb-1 text-right">工具</th>
                    <th className="px-2 pb-1 text-right">首字</th>
                    <th className="px-2 pb-1 text-right">总耗时</th>
                  </tr>
                </thead>
                <tbody>
                  {traces.map((t) => (
                    <tr key={t.id} className="rounded-xl bg-paper-2 text-[12px] text-slate-600">
                      <td className="whitespace-nowrap px-2 py-1.5 tabular-nums text-slate-500">
                        {(t.created_at || '').slice(5, 16)}
                      </td>
                      <td className="whitespace-nowrap px-2 py-1.5">
                        {t.app === 'enterprise' ? '企业知识库' : '电商客服'}
                      </td>
                      <td className="max-w-[260px] truncate px-2 py-1.5" title={t.question}>
                        {t.question}
                      </td>
                      <td className="whitespace-nowrap px-2 py-1.5">
                        <span
                          className={`inline-flex items-center gap-1 rounded-[2px] px-2 py-0.5 text-[11px] font-medium ${
                            t.status === 'ok'
                              ? 'bg-emerald-50 text-emerald-600'
                              : t.status === 'interrupted'
                                ? 'bg-amber-50 text-amber-600'
                                : 'bg-rose-50 text-rose-600'
                          }`}
                        >
                          {t.status === 'ok' ? '完成' : t.status === 'interrupted' ? '待审批' : '失败'}
                        </span>
                      </td>
                      <td className="px-2 py-1.5 text-right tabular-nums">{t.hits}</td>
                      <td className="px-2 py-1.5 text-right tabular-nums" title={t.tool_names ?? ''}>
                        {t.tools}
                      </td>
                      <td className="px-2 py-1.5 text-right tabular-nums">{t.first_token_ms}ms</td>
                      <td className="px-2 py-1.5 text-right tabular-nums">{t.latency_ms}ms</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        <section className="mt-3.5 rounded-[2px] bg-paper-2 p-4 shadow-lift md:p-5">
          <div className="flex items-center justify-between">
            <div className="text-[13.5px] font-semibold text-slate-800">说明</div>
            <span className="text-[11.5px] text-slate-500">GET /api/admin/services · 3s</span>
          </div>
          <ul className="mt-2.5 space-y-1.5 text-[12px] leading-relaxed text-slate-600">
            <li>· MySQL / Redis / PostgreSQL(pgvector) / 对话模型每 3 秒实际探活一次，延迟为本次往返耗时；业务指标每 30 秒刷新。</li>
            <li>· 对话模型探活走 GET /models，只校验密钥与连通性，不消耗模型 Token。</li>
            <li>· 页面切到后台时暂停轮询，避免无意义请求。</li>
            <li>· 对话链路的真实延迟逐条记录在 chat_history.latency_ms，可在下方「最近执行轨迹」查看总耗时。</li>
          </ul>
        </section>
      </div>
    </AppShell>
  );
}

function Metric({ label, value, unit }: { label: string; value?: number; unit: string }) {
  return (
    <div className="rounded-[2px] bg-paper-2 px-4 py-3 shadow-lift">
      <div className="text-[11.5px] font-medium text-slate-500">{label}</div>
      <div className="mt-1 text-[20px] font-semibold leading-none tabular-nums tracking-tight-ios text-slate-900">
        {value == null ? '—' : value.toLocaleString()}
        <span className="ml-1 text-[11px] font-normal text-slate-500">{unit}</span>
      </div>
    </div>
  );
}

function LatencyBars({ latency, status }: { latency: number | null; status: string }) {
  const level = status !== 'ok' ? 0 : latency == null ? 2 : latency < 20 ? 3 : latency < 80 ? 2 : 1;
  return (
    <div className="flex items-end gap-1">
      {[1, 2, 3].map((n) => (
        <span
          key={n}
          className={`w-1.5 rounded-[2px] ${
            n <= level
              ? status === 'ok'
                ? 'bg-emerald-500'
                : 'bg-rose-400'
              : 'bg-slate-200'
          }`}
          style={{ height: 6 + n * 5 }}
        />
      ))}
    </div>
  );
}

function formatUptime(seconds?: number) {
  if (seconds == null) return '—';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}
