'use client';

import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import AppShell from '@/components/AppShell';
import AppCard from '@/components/AppCard';
import { adminApi, type MonitorResponse, type Overview } from '@/lib/adminApi';
import { APPS } from '@/lib/apps';

// 模块级快照：路由切换会卸载页面组件，但模块状态保留。
// 回到首页时先用上次的数据渲染，再后台刷新，避免重复出现骨架屏。
let overviewSnapshot: Overview | null = null;
let monitorSnapshot: MonitorResponse | null = null;

export default function DashboardPage() {
  const [data, setData] = useState<Overview | null>(overviewSnapshot);
  const [monitor, setMonitor] = useState<MonitorResponse | null>(monitorSnapshot);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const ov = await adminApi.overview();
        if (alive) {
          overviewSnapshot = ov;
          setData(ov);
          setError(null);
        }
      } catch (e) {
        if (alive) setError(e instanceof Error ? e.message : '加载失败');
      }
      try {
        const mo = await adminApi.monitor();
        if (alive) {
          monitorSnapshot = mo;
          setMonitor(mo);
        }
      } catch {
        // 监控数据失败不影响首页主体展示
      }
    };
    void load();
    const timer = setInterval(load, 15000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, []);

  const stats = data?.stats;
  const today = useMemo(
    () =>
      new Date().toLocaleDateString('zh-CN', {
        year: 'numeric',
        month: 'long',
        day: 'numeric',
        weekday: 'long',
      }),
    [],
  );

  const runningApps = APPS.filter((a) => a.status === 'running');

  return (
    <AppShell>
      <div className="mx-auto w-full max-w-[1180px]">
        {/* ===== Hero ===== */}
        <header className="hero-night relative animate-fade-up overflow-hidden rounded-[30px] px-5 pb-6 pt-6 text-white shadow-night md:px-8 md:pb-8 md:pt-9">
          <div aria-hidden className="pointer-events-none absolute inset-0 overflow-hidden">
            <div className="dot-grid-dark absolute inset-0 opacity-60" />
            <div className="aurora-blob aura-indigo -left-28 -top-40 h-[420px] w-[420px] animate-float-slow" />
            <div className="aurora-blob aura-pink -right-24 top-6 h-[360px] w-[360px] animate-float-slow [animation-delay:-9s]" />
            <div className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-white/45 to-transparent" />
          </div>

          <div className="relative flex flex-col gap-8 lg:flex-row lg:items-end lg:justify-between">
            <div className="max-w-[560px]">
              <div className="flex flex-wrap items-center gap-2.5">
                <span className="inline-flex items-center gap-1.5 rounded-full border border-white/15 bg-white/10 px-2.5 py-1 text-[11.5px] font-medium text-white/85 backdrop-blur">
                  <span className="live-dot h-1.5 w-1.5 rounded-full bg-emerald-400" />
                  {runningApps.length} 套知识库运行中
                </span>
                <span className="text-[11.5px] text-white/45">{today}</span>
              </div>

              <h1 className="mt-4 text-[28px] font-semibold leading-[1.15] tracking-tight-ios md:text-[41px]">
                一个客服中台，
                <br className="hidden sm:block" />
                <span className="text-gradient-aurora">跑通两套知识库场景</span>
              </h1>

              <p className="mt-3.5 max-w-[460px] text-[13px] leading-relaxed text-white/60 md:text-[14px]">
                电商导购用商品库与订单工具，企业场景用制度库与版本溯源；检索、工具调用、人工审批与 Token 监控全部共用一套底座。
              </p>

              <div className="mt-6 flex flex-wrap items-center gap-2.5">
                <Link
                  href="/apps?kb=ecommerce"
                  className="press inline-flex items-center gap-2 rounded-full bg-white px-4 py-2.5 text-[13px] font-semibold text-slate-900 shadow-[0_16px_36px_-16px_rgba(255,255,255,0.7)] hover:bg-slate-100"
                >
                  <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
                  进入智能客服
                  <svg viewBox="0 0 20 20" fill="currentColor" className="h-3.5 w-3.5">
                    <path d="M7.22 4.22a.75.75 0 011.06 0l5.25 5.25a.75.75 0 010 1.06l-5.25 5.25a.75.75 0 11-1.06-1.06L11.94 10 7.22 5.28a.75.75 0 010-1.06z" />
                  </svg>
                </Link>
                <Link
                  href="/knowledge"
                  className="press inline-flex items-center gap-1.5 rounded-full border border-white/20 bg-white/5 px-4 py-2.5 text-[13px] font-medium text-white/80 backdrop-blur transition hover:border-white/30 hover:bg-white/10 hover:text-white"
                >
                  查看知识库
                </Link>
              </div>
            </div>

            {/* 桌面端：运行中应用展示 */}
            <div className="relative hidden w-[318px] shrink-0 lg:block">
              <div className="relative rounded-[26px] border border-white/15 bg-white/[0.07] p-4 backdrop-blur-xl">
                <div className="flex items-center justify-between">
                  <span className="flex items-center gap-1.5 text-[11.5px] font-medium text-white/70">
                    <span className="flex h-5 w-5 items-center justify-center rounded-md bg-white/10">
                      <svg viewBox="0 0 24 24" fill="currentColor" className="h-3 w-3">
                        <path d="M4 4h6v6H4V4zm10 0h6v6h-6V4zM4 14h6v6H4v-6zm10 0h6v6h-6v-6z" />
                      </svg>
                    </span>
                    已接入知识库
                  </span>
                  <span className="inline-flex items-center gap-1 rounded-full bg-emerald-400/10 px-1.5 py-0.5 text-[10px] font-semibold tracking-wide text-emerald-300">
                    <span className="live-dot h-1 w-1 rounded-full bg-emerald-400" />
                    LIVE
                  </span>
                </div>

                <div className="mt-3 space-y-2">
                  {runningApps.slice(0, 3).map((app) => (
                    <div
                      key={app.id}
                      className="flex items-center gap-2.5 rounded-2xl border border-white/10 bg-white/[0.05] px-2.5 py-2 transition hover:border-white/20 hover:bg-white/[0.09]"
                    >
                      <span
                        className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br ${app.gradient} ${
                          app.iconClass ?? 'text-white'
                        }`}
                      >
                        {app.icon}
                      </span>
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-[12.5px] font-medium text-white/90">
                          {app.name}
                        </div>
                        <div className="truncate text-[10.5px] text-white/40">
                          {app.tags.join(' · ')}
                        </div>
                      </div>
                      <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-emerald-400 shadow-[0_0_8px_2px_rgba(52,211,153,0.5)]" />
                    </div>
                  ))}
                </div>

                <div className="mt-3 flex items-center justify-between border-t border-white/10 pt-3">
                  <div className="flex -space-x-1.5">
                    {runningApps.slice(0, 4).map((a) => (
                      <span
                        key={a.id}
                        className={`flex h-6 w-6 items-center justify-center rounded-full border-2 border-[#101a33] bg-gradient-to-br ${a.gradient} text-[10px] font-semibold ${
                          a.iconClass ?? 'text-white'
                        }`}
                        title={a.name}
                      >
                        {a.name.slice(0, 1)}
                      </span>
                    ))}
                  </div>
                  <Link
                    href="/apps"
                    className="text-[11.5px] font-medium text-white/55 transition hover:text-white"
                  >
                    工作台 →
                  </Link>
                </div>
              </div>
            </div>
          </div>
        </header>

        {error && (
          <div className="mt-4 flex items-center gap-2 rounded-2xl bg-rose-50/80 px-4 py-3 text-[13px] text-rose-600 hairline">
            <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-rose-500" />
            后端未连接（{error}）。请确认 FastAPI 已在 8000 端口运行。
          </div>
        )}

        {/* ===== 指标卡 ===== */}
        <section className="mt-4 grid grid-cols-2 gap-2.5 md:grid-cols-4 md:gap-3.5">
          <StatCard
            label="商品"
            value={stats?.products}
            hint="在售 SKU 主数据"
            icon={<IconBox />}
          />
          <StatCard
            label="订单"
            value={stats?.orders}
            hint="全量演示订单"
            icon={<IconReceipt />}
          />
          <StatCard
            label="会话"
            value={stats?.conversations}
            hint="累计会话数"
            icon={<IconChat />}
          />
          <StatCard
            label="今日 Token"
            value={stats?.tokens_today}
            hint={`累计 ${stats?.tokens_total ?? 0}`}
            icon={<IconBolt />}
            highlight
          />
        </section>

        {/* ===== 趋势 + 服务状态 ===== */}
        <section className="mt-3.5 grid grid-cols-1 gap-3.5 lg:grid-cols-3">
          <div className="relative overflow-hidden rounded-[24px] border border-white/70 bg-white/75 p-4 shadow-bubble backdrop-blur-xl md:p-5 lg:col-span-2">
            <div className="flex items-center justify-between gap-3">
              <div className="flex items-center gap-2.5">
                <span className="flex h-8 w-8 items-center justify-center rounded-xl bg-gradient-to-br from-brand-500 to-violet-500 text-white shadow-[0_8px_18px_-10px_rgba(99,102,241,0.9)]">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-4 w-4">
                    <path d="M3 17l5-6 4 3 6-8" strokeLinecap="round" strokeLinejoin="round" />
                    <path d="M15 6h4v4" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                </span>
                <div>
                  <div className="text-[13.5px] font-semibold text-slate-800">
                    近 7 天 Token 消耗
                  </div>
                  <div className="mt-0.5 text-[12px] text-slate-500">
                    按天汇总 chat_history 记账数据
                  </div>
                </div>
              </div>
              <span className="shrink-0 rounded-full bg-gradient-to-r from-brand-50 to-fuchsia-50 px-2.5 py-1 text-[12px] font-semibold tabular-nums text-brand-600 ring-1 ring-brand-100">
                {data ? data.trend.reduce((s, p) => s + p.tokens, 0).toLocaleString() : '—'} tokens
              </span>
            </div>
            <TrendChart trend={data?.trend ?? []} />
          </div>

          <div className="relative overflow-hidden rounded-[24px] border border-white/70 bg-white/75 p-4 shadow-bubble backdrop-blur-xl md:p-5">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-emerald-50 text-emerald-600">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-3.5 w-3.5">
                    <path d="M4 13h3l2-5 3 9 2.5-4H20" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                </span>
                <div className="text-[13.5px] font-semibold text-slate-800">系统状态</div>
              </div>
              <Link href="/monitor" className="text-[12px] font-medium text-brand-600 hover:underline">
                详情
              </Link>
            </div>
            <div className="mt-3 space-y-2">
              {(monitor?.services ?? []).map((s) => (
                <div
                  key={s.name}
                  className="flex items-center gap-2 rounded-xl border border-white/70 bg-white/70 px-3 py-2"
                >
                  <span
                    className={`h-2 w-2 shrink-0 rounded-full ${
                      s.status === 'ok'
                        ? 'bg-emerald-500'
                        : s.status === 'unconfigured'
                          ? 'bg-amber-400'
                          : 'bg-rose-500'
                    }`}
                  />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[12.5px] font-medium text-slate-700">{s.name}</div>
                    <div className="truncate text-[11.5px] text-slate-500">{s.target}</div>
                  </div>
                  <span className="shrink-0 rounded-full bg-slate-100/80 px-1.5 py-0.5 text-[10.5px] font-medium tabular-nums text-slate-500">
                    {s.latency_ms != null ? `${s.latency_ms}ms` : '—'}
                  </span>
                </div>
              ))}
              {!monitor && (
                <div className="space-y-2">
                  {[0, 1, 2].map((i) => (
                    <div key={i} className="h-[46px] animate-pulse rounded-xl bg-white/60" />
                  ))}
                </div>
              )}
            </div>
          </div>
        </section>

        {/* ===== AI 应用 ===== */}
        <section className="mt-7">
          <div className="flex items-end justify-between">
            <div>
              <div className="flex items-center gap-2">
                <h2 className="text-[17px] font-semibold tracking-tight-ios text-slate-900">
                  业务知识库
                </h2>
                <span className="rounded-full bg-white/70 px-2 py-0.5 text-[11px] font-medium text-slate-500 ring-1 ring-slate-200/70">
                  {APPS.length}
                </span>
              </div>
              <p className="mt-0.5 text-[12.5px] text-slate-500">
                同一个中台下接入 {runningApps.length} 套知识库，进入后可随时切换
              </p>
            </div>
            <Link
              href="/apps"
              className="press inline-flex items-center gap-1 rounded-full bg-white/70 px-3 py-1.5 text-[12.5px] font-medium text-brand-600 ring-1 ring-slate-200/70 hover:bg-white"
            >
              进入工作台 →
            </Link>
          </div>
          <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {APPS.map((app) => (
              <AppCard key={app.id} app={app} compact />
            ))}
          </div>
        </section>

        {/* ===== 最近会话 + 最近订单 ===== */}
        <section className="mt-7 grid grid-cols-1 gap-3.5 lg:grid-cols-5">
          <div className="rounded-[24px] border border-white/70 bg-white/75 p-4 shadow-bubble backdrop-blur-xl md:p-5 lg:col-span-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-brand-50 text-brand-600">
                  <svg viewBox="0 0 24 24" fill="currentColor" className="h-3.5 w-3.5">
                    <path d="M4 4h16a1 1 0 011 1v10a1 1 0 01-1 1H9l-5 4V5a1 1 0 011-1z" />
                  </svg>
                </span>
                <div className="text-[13.5px] font-semibold text-slate-800">最近会话</div>
              </div>
              <span className="text-[12px] text-slate-500">{stats?.messages ?? 0} 条消息</span>
            </div>
            <div className="mt-3 divide-y divide-slate-100/80">
              {(data?.recent_chats ?? []).length === 0 ? (
                <EmptyHint text="还没有会话记录，去智能客服聊一句试试。" />
              ) : (
                data?.recent_chats.map((c) => (
                  <div key={c.id} className="flex items-start gap-2.5 py-2.5">
                    <span
                      className={`mt-1 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[9px] font-semibold ${
                        c.role === 'user'
                          ? 'bg-slate-900 text-white'
                          : 'bg-brand-50 text-brand-600'
                      }`}
                    >
                      {c.role === 'user' ? '用' : 'AI'}
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-[13px] text-slate-700">{c.content}</div>
                      <div className="mt-0.5 text-[11.5px] text-slate-500">
                        {c.session_id.slice(0, 18)} · {c.created_at}
                      </div>
                    </div>
                    <span className="shrink-0 rounded-full bg-slate-100/70 px-1.5 py-0.5 text-[11px] tabular-nums text-slate-500">
                      {c.total_tokens} tk
                    </span>
                  </div>
                ))
              )}
            </div>
          </div>

          <div className="rounded-[24px] border border-white/70 bg-white/75 p-4 shadow-bubble backdrop-blur-xl md:p-5 lg:col-span-2">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-sky-50 text-sky-600">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-3.5 w-3.5">
                    <path d="M5 4h14v16l-3-2-2 2-2-2-2 2-2-2-3 2V4z" strokeLinejoin="round" />
                    <path d="M9 9h6M9 13h6" strokeLinecap="round" />
                  </svg>
                </span>
                <div className="text-[13.5px] font-semibold text-slate-800">最近订单</div>
              </div>
              <Link href="/database" className="text-[12px] font-medium text-brand-600 hover:underline">
                数据库
              </Link>
            </div>
            <div className="mt-3 space-y-2">
              {(data?.recent_orders ?? []).length === 0 ? (
                <EmptyHint text="暂无订单数据。" />
              ) : (
                data?.recent_orders.map((o) => (
                  <div
                    key={o.id}
                    className="flex items-center gap-2 rounded-xl border border-white/70 bg-white/70 px-3 py-2"
                  >
                    <span className="font-mono text-[12px] text-slate-600">#{o.id}</span>
                    <span className="min-w-0 flex-1 truncate text-[11.5px] text-slate-500">
                      {o.customer_id}
                    </span>
                    <StatusPill status={o.status} />
                    <span className="text-[12px] font-medium tabular-nums text-slate-700">
                      ¥{o.total_amount}
                    </span>
                  </div>
                ))
              )}
            </div>
          </div>
        </section>

        <footer className="mt-8 flex items-center justify-center gap-2 pb-4 text-[11.5px] text-slate-500">
          <span className="h-1.5 w-1.5 rounded-full bg-gradient-to-br from-brand-500 to-fuchsia-500" />
          AnswerY 智能客服中台 · React + FastAPI + LangGraph + pgvector · 所有数据均为演示虚构
        </footer>
      </div>
    </AppShell>
  );
}

function StatCard({
  label,
  value,
  hint,
  icon,
  highlight = false,
}: {
  label: string;
  value?: number;
  hint?: string;
  icon: React.ReactNode;
  highlight?: boolean;
}) {
  return (
    <div
      className={`sheen group relative overflow-hidden rounded-[22px] p-4 shadow-bubble hairline transition-all duration-300 hover:-translate-y-0.5 hover:shadow-lift ${
        highlight
          ? 'bg-gradient-to-br from-[#131a2e] via-[#1a2140] to-[#241a3f] text-white'
          : 'bg-white/75 text-slate-900'
      }`}
    >
      {highlight && (
        <div
          aria-hidden
          className="pointer-events-none absolute -right-10 -top-12 h-32 w-32 rounded-full bg-brand-500/40 blur-2xl"
        />
      )}
      <div className="relative flex items-center justify-between">
        <span
          className={`text-[12px] font-medium ${
            highlight ? 'text-white/60' : 'text-slate-500'
          }`}
        >
          {label}
        </span>
        <span
          className={`flex h-7 w-7 items-center justify-center rounded-lg ${
            highlight ? 'bg-white/10 text-brand-200' : 'bg-brand-50 text-brand-600'
          }`}
        >
          {icon}
        </span>
      </div>
      <div className="relative mt-2 text-[27px] font-semibold leading-none tracking-tight-ios tabular-nums">
        {value == null ? '—' : value.toLocaleString()}
      </div>
      <div
        className={`relative mt-1.5 text-[11.5px] ${
          highlight ? 'text-white/45' : 'text-slate-500'
        }`}
      >
        {hint}
      </div>
    </div>
  );
}

function IconBox() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-4 w-4">
      <path d="M4 8l8-4 8 4-8 4-8-4z" strokeLinejoin="round" />
      <path d="M4 8v8l8 4 8-4V8" strokeLinejoin="round" />
      <path d="M12 12v8" />
    </svg>
  );
}

function IconReceipt() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-4 w-4">
      <path d="M5 4h14v16l-3-2-2 2-2-2-2 2-2-2-3 2V4z" strokeLinejoin="round" />
      <path d="M9 9h6M9 13h4" strokeLinecap="round" />
    </svg>
  );
}

function IconChat() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-4 w-4">
      <path d="M4 5h16v11H9l-5 4V5z" strokeLinejoin="round" />
      <path d="M8 9h8M8 12h5" strokeLinecap="round" />
    </svg>
  );
}

function IconBolt() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-4 w-4">
      <path d="M13 2L4.5 13.5H11l-1 8.5L19.5 10.5H13l1-8.5z" strokeLinejoin="round" />
    </svg>
  );
}

function TrendChart({ trend }: { trend: { day: string; tokens: number }[] }) {
  const w = 560;
  const h = 150;
  const pad = 8;
  const points = trend.length ? trend : Array.from({ length: 7 }, (_, i) => ({ day: `d${i}`, tokens: 0 }));
  const max = Math.max(1, ...points.map((p) => p.tokens));
  const step = (w - pad * 2) / Math.max(1, points.length - 1);
  const coords = points.map((p, i) => ({
    x: pad + i * step,
    y: h - pad - (p.tokens / max) * (h - pad * 2),
    ...p,
  }));
  const line = coords
    .map((c, i) => `${i === 0 ? 'M' : 'L'}${c.x.toFixed(1)},${c.y.toFixed(1)}`)
    .join(' ');
  const area = `${line} L${coords[coords.length - 1].x.toFixed(1)},${h - pad} L${coords[0].x.toFixed(1)},${h - pad} Z`;

  return (
    <div className="mt-4">
      <svg viewBox={`0 0 ${w} ${h}`} className="h-[150px] w-full" preserveAspectRatio="none">
        <defs>
          <linearGradient id="areaFill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#6366f1" stopOpacity="0.32" />
            <stop offset="100%" stopColor="#6366f1" stopOpacity="0" />
          </linearGradient>
          <linearGradient id="lineStroke" x1="0" y1="0" x2="1" y2="0">
            <stop offset="0%" stopColor="#6366f1" />
            <stop offset="55%" stopColor="#8b5cf6" />
            <stop offset="100%" stopColor="#d946ef" />
          </linearGradient>
          <filter id="lineGlow" x="-20%" y="-60%" width="140%" height="220%">
            <feGaussianBlur stdDeviation="3.5" result="blur" />
            <feMerge>
              <feMergeNode in="blur" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
        </defs>
        {[0.25, 0.5, 0.75].map((r) => (
          <line
            key={r}
            x1={pad}
            x2={w - pad}
            y1={h - pad - r * (h - pad * 2)}
            y2={h - pad - r * (h - pad * 2)}
            stroke="#e2e8f0"
            strokeDasharray="3 4"
            strokeWidth="1"
          />
        ))}
        <path d={area} fill="url(#areaFill)" />
        <path
          d={line}
          fill="none"
          stroke="url(#lineStroke)"
          strokeWidth="2.5"
          strokeLinecap="round"
          filter="url(#lineGlow)"
        />
        {coords.map((c) => (
          <circle key={c.x} cx={c.x} cy={c.y} r="3" fill="#fff" stroke="#6366f1" strokeWidth="2" />
        ))}
      </svg>
      <div className="mt-1 flex justify-between px-1 text-[11px] text-slate-500">
        {points.map((p) => (
          <span key={p.day}>{p.day.slice(5)}</span>
        ))}
      </div>
    </div>
  );
}

function StatusPill({ status }: { status: string }) {
  const map: Record<string, { label: string; cls: string }> = {
    paid: { label: '已支付', cls: 'bg-sky-50 text-sky-600' },
    shipped: { label: '已发货', cls: 'bg-indigo-50 text-indigo-600' },
    delivered: { label: '已签收', cls: 'bg-emerald-50 text-emerald-600' },
    completed: { label: '已完成', cls: 'bg-emerald-50 text-emerald-600' },
    pending_payment: { label: '待支付', cls: 'bg-amber-50 text-amber-600' },
    refunding: { label: '退款中', cls: 'bg-rose-50 text-rose-600' },
    cancelled: { label: '已取消', cls: 'bg-slate-100 text-slate-600' },
  };
  const item = map[status] ?? { label: status, cls: 'bg-slate-100 text-slate-600' };
  return (
    <span className={`shrink-0 rounded-full px-1.5 py-0.5 text-[11px] font-medium ${item.cls}`}>
      {item.label}
    </span>
  );
}

function EmptyHint({ text }: { text: string }) {
  return (
    <div className="rounded-xl border border-dashed border-slate-200 px-3 py-6 text-center text-[12px] text-slate-500">
      {text}
    </div>
  );
}
