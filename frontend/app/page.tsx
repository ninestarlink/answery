﻿'use client';

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
        {/* ===== Hero：工业报纸头版 ===== */}
        <header className="animate-fade-up pt-4">
          {/* 报头 */}
          <div className="masthead flex flex-wrap items-end justify-between gap-x-6 gap-y-2 pb-2.5 pt-2.5">
            <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
              <span className="font-display text-[22px] font-semibold leading-none tracking-[0.02em] text-ink">
                AnswerY
              </span>
              <span className="mono-label text-muted">自建知识库 · 智能客服中台</span>
            </div>
            <div className="flex items-baseline gap-3">
              <span className="mono-label text-muted">{today}</span>
              <span className="mono-label text-accent">No. 01 · Daily Edition</span>
            </div>
          </div>

          <div className="mt-5 grid gap-8 md:grid-cols-[1.65fr_1fr]">
            <div>
              <div className="flex flex-wrap items-center gap-2">
                <span className="mono-label bg-accent px-2 py-1 text-accent-ink">
                  头条 / Lead
                </span>
                <span className="mono-label text-muted">RAG · Traceable · Replayable</span>
              </div>

              <h1 className="mt-4 text-[38px] leading-[1.06] md:text-[62px]">
                答案有出处，
                <br />
                <span className="text-accent">过程可回放。</span>
              </h1>

              <p className="mt-4 max-w-[560px] text-[14px] leading-[1.85] text-muted md:text-[15.5px]">
                每条结论都能翻到文档编号与章节；建工单等写操作先经人工确认；每轮对话落库，随时回放。
              </p>

              <div className="mt-6 flex flex-wrap items-center gap-2.5">
                <Link
                  href="/apps"
                  className="press inline-flex min-h-[44px] items-center bg-accent px-6 text-[13px] font-semibold text-accent-ink shadow-[3px_3px_0_rgba(23,21,18,0.2)] transition hover:bg-accent-hi"
                >
                  进入智能客服
                </Link>
                <Link
                  href="/knowledge"
                  className="press inline-flex min-h-[44px] items-center border border-ink-900 px-5 text-[13px] font-medium text-ink transition hover:bg-paper-3"
                >
                  查看知识库
                </Link>
              </div>
            </div>

            {/* 右栏：本期速览 */}
            <aside className="md:border-l md:border-rule md:pl-6">
              <div className="flex items-baseline justify-between border-b border-rule pb-2">
                <span className="mono-label text-ink">本期速览</span>
                <span className="mono-label text-muted">In this issue</span>
              </div>
              <div>
                {[
                  ['01', '知识库', '商品库 + 企业制度，多格式入库', '/knowledge'],
                  ['02', '可溯源', '每条结论附文档编号与章节', '/monitor'],
                  ['03', '可回放', '检索、工具、中断与延迟全记录', '/monitor'],
                ].map(([no, title, desc, href]) => (
                  <Link
                    key={no}
                    href={href}
                    className="press group flex gap-3 border-b border-rule py-3"
                  >
                    <span className="font-mono text-[11px] leading-5 text-accent">{no}</span>
                    <span className="min-w-0">
                      <span className="block text-[14px] font-semibold leading-5 text-ink transition group-hover:text-accent">
                        {title}
                      </span>
                      <span className="mt-0.5 block text-[11.5px] leading-relaxed text-muted">
                        {desc}
                      </span>
                    </span>
                  </Link>
                ))}
              </div>
              <div className="mt-4 flex items-baseline justify-between border-t border-ink-900/40 pt-2">
                <span className="mono-label text-muted">System AY—2026</span>
                <span className="mono-label text-muted">Hybrid · Rerank</span>
              </div>
            </aside>
          </div>

          <div className="masthead-rule mt-7" aria-hidden />
        </header>

        {error && (
          <div className="mt-4 flex items-center gap-2 rounded-2xl bg-rose-50/80 px-4 py-3 text-[13px] text-rose-600 hairline">
            <span className="h-1.5 w-1.5 shrink-0 rounded-[2px] bg-rose-500" />
            后端未连接（{error}）。请确认 FastAPI 已在 8000 端口运行。
          </div>
        )}

        {/* ===== 指标卡 ===== */}
        <section className="mt-10 grid grid-cols-2 gap-3 md:grid-cols-4 md:gap-4">
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
          <div className="relative overflow-hidden rounded-[2px] bg-paper-2 p-4 shadow-lift md:p-5 lg:col-span-2">
            <div className="flex items-center justify-between gap-3">
              <div className="flex items-center gap-2.5">
                <span className="flex h-8 w-8 items-center justify-center rounded-[2px] bg-accent text-accent-ink">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-4 w-4">
                    <path d="M3 17l5-6 4 3 6-8" strokeLinecap="round" strokeLinejoin="round" />
                    <path d="M15 6h4v4" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                </span>
                <div>
                  <div className="font-display text-[15px] font-semibold text-slate-800">
                    近 7 天 Token 消耗
                  </div>
                  <div className="mt-0.5 text-[12px] text-slate-500">
                    按天汇总 chat_history 记账数据
                  </div>
                </div>
              </div>
              <span className="shrink-0 rounded-[2px] bg-accent-50 px-2.5 py-1 text-[12px] font-medium tabular-nums text-accent-600 ring-1 ring-accent-100">
                {data ? data.trend.reduce((s, p) => s + p.tokens, 0).toLocaleString() : '—'} tokens
              </span>
            </div>
            <TrendChart trend={data?.trend ?? []} />
          </div>

          <div className="relative overflow-hidden rounded-[2px] bg-paper-2 p-4 shadow-lift md:p-5">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-emerald-50 text-emerald-600">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-3.5 w-3.5">
                    <path d="M4 13h3l2-5 3 9 2.5-4H20" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                </span>
                <div className="font-display text-[15px] font-semibold text-slate-800">系统状态</div>
              </div>
              <Link href="/monitor" className="text-[12px] font-medium text-brand-600 hover:underline">
                详情
              </Link>
            </div>
            <div className="mt-3 space-y-2">
              {(monitor?.services ?? [])
                .filter((s) => !s.name.startsWith('硅基流动'))
                .map((s) => (
                  <div
                    key={s.name}
                    className="flex items-center gap-2 rounded-[2px] border border-rule bg-paper-2 px-3 py-2"
                  >
                    <span
                      className={`h-2 w-2 shrink-0 rounded-[2px] ${
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
                    <span className="shrink-0 rounded-[2px] bg-slate-100/80 px-1.5 py-0.5 text-[10.5px] font-medium tabular-nums text-slate-500">
                      {s.latency_ms != null ? `${s.latency_ms}ms` : '—'}
                    </span>
                  </div>
                ))}
              {!monitor && (
                <div className="space-y-2">
                  {[0, 1, 2].map((i) => (
                    <div key={i} className="h-[46px] animate-pulse rounded-[2px] bg-paper-2" />
                  ))}
                </div>
              )}
            </div>
          </div>
        </section>

        {/* ===== AI 应用 ===== */}
        <section className="mt-9 border-t-[3px] border-ink-900 pt-4">
          <div className="flex items-end justify-between">
            <div>
              <div className="flex items-center gap-2">
                <h2 className="text-[22px] font-semibold tracking-tight-ios text-slate-900">
                  覆盖场景
                </h2>
                <span className="rounded-[2px] bg-paper-2 px-2 py-0.5 text-[11px] font-medium text-slate-500 ring-1 ring-slate-200/70">
                  {APPS.length}
                </span>
              </div>
              <p className="mt-1 text-[12.5px] text-slate-500">
                同一个输入框自动判断该查商品库还是制度库，答不出来会转人工
              </p>
            </div>
            <Link
              href="/apps"
              className="press inline-flex items-center gap-1 rounded-[2px] bg-paper-2 px-3 py-1.5 text-[12.5px] font-medium text-brand-600 ring-1 ring-slate-200/70 hover:bg-paper-2"
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
          <div className="rounded-[2px] bg-paper-2 p-4 shadow-lift md:p-5 lg:col-span-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-brand-50 text-brand-600">
                  <svg viewBox="0 0 24 24" fill="currentColor" className="h-3.5 w-3.5">
                    <path d="M4 4h16a1 1 0 011 1v10a1 1 0 01-1 1H9l-5 4V5a1 1 0 011-1z" />
                  </svg>
                </span>
                <div className="font-display text-[15px] font-semibold text-slate-800">最近会话</div>
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
                      className={`mt-1 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-[2px] text-[9px] font-semibold ${
                        c.role === 'user'
                          ? 'bg-accent text-accent-ink'
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
                    <span className="shrink-0 rounded-[2px] bg-slate-100/70 px-1.5 py-0.5 text-[11px] tabular-nums text-slate-500">
                      {c.total_tokens} tk
                    </span>
                  </div>
                ))
              )}
            </div>
          </div>

          <div className="rounded-[2px] bg-paper-2 p-4 shadow-lift md:p-5 lg:col-span-2">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-sky-50 text-sky-600">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-3.5 w-3.5">
                    <path d="M5 4h14v16l-3-2-2 2-2-2-2 2-2-2-3 2V4z" strokeLinejoin="round" />
                    <path d="M9 9h6M9 13h6" strokeLinecap="round" />
                  </svg>
                </span>
                <div className="font-display text-[15px] font-semibold text-slate-800">最近订单</div>
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
                    className="flex items-center gap-2 rounded-xl border border-rule bg-paper-2 px-3 py-2"
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
          <span className="h-1.5 w-1.5 rounded-full bg-accent" />
          AnswerY智能客服中台 · React + FastAPI + LangGraph + pgvector · 所有数据均为演示虚构
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
      className={`group relative overflow-hidden rounded-[2px] p-4 shadow-lift transition-colors duration-300 ${
        highlight
          ? 'bg-accent text-accent-ink'
          : 'bg-paper-2 text-ink'
      }`}
    >
      <div className="relative flex items-center justify-between">
        <span
          className={`mono-label text-[9.5px] ${
            highlight ? 'text-accent-ink/70' : 'text-muted'
          }`}
        >
          {label}
        </span>
        <span
          className={`flex h-7 w-7 items-center justify-center rounded-[2px] ${
            highlight ? 'border border-accent-ink/35 text-accent-ink' : 'bg-paper-3 text-accent'
          }`}
        >
          {icon}
        </span>
      </div>
      <div className="relative mt-2.5 font-display text-[30px] leading-none tracking-tight tabular-nums">
        {value == null ? '—' : value.toLocaleString()}
      </div>
      <div
        className={`relative mt-1.5 text-[11.5px] ${
          highlight ? 'text-accent-ink/75' : 'text-muted'
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
            <stop offset="0%" stopColor="#c8452b" stopOpacity="0.18" />
            <stop offset="100%" stopColor="#c8452b" stopOpacity="0" />
          </linearGradient>
          <linearGradient id="lineStroke" x1="0" y1="0" x2="1" y2="0">
            <stop offset="0%" stopColor="#b0341f" />
            <stop offset="100%" stopColor="#c8452b" />
          </linearGradient>
        </defs>
        {[0.25, 0.5, 0.75].map((r) => (
          <line
            key={r}
            x1={pad}
            x2={w - pad}
            y1={h - pad - r * (h - pad * 2)}
            y2={h - pad - r * (h - pad * 2)}
            stroke="#d8d3c8"
            strokeDasharray="3 4"
            strokeWidth="1"
          />
        ))}
        <path d={area} fill="url(#areaFill)" />
        <path
          d={line}
          fill="none"
          stroke="url(#lineStroke)"
          strokeWidth="2"
          strokeLinecap="round"
        />
        {coords.map((c) => (
          <circle key={c.x} cx={c.x} cy={c.y} r="3" fill="#faf8f3" stroke="#c8452b" strokeWidth="2" />
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
    <span className={`shrink-0 rounded-[2px] px-1.5 py-0.5 text-[11px] font-medium ${item.cls}`}>
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
