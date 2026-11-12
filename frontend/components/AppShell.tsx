﻿'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';
import { AUTH_EVENT, getStoredUser, logout, type AuthUser } from '@/lib/auth';

interface NavItem {
  href: string;
  label: string;
  short: string;
  icon: React.ReactNode;
}

const NAV_ITEMS: NavItem[] = [
  {
    href: '/',
    label: '首页',
    short: '首页',
    icon: (
      <path d="M3 10.5L12 3l9 7.5v8.25a1.5 1.5 0 01-1.5 1.5h-4.25v-6h-6.5v6H4.5a1.5 1.5 0 01-1.5-1.5V10.5z" />
    ),
  },
  {
    href: '/apps',
    label: '智能客服',
    short: '客服',
    icon: (
      <path d="M4 4h6v6H4V4zm10 0h6v6h-6V4zM4 14h6v6H4v-6zm10 0h6v6h-6v-6z" />
    ),
  },
  {
    href: '/knowledge',
    label: '知识库',
    short: '知识',
    icon: (
      <path d="M5 3h9.5A2.5 2.5 0 0117 5.5V21H6.5A2.5 2.5 0 014 18.5v-14A1.5 1.5 0 015.5 3H5zm2 4v2h8V7H7zm0 5v2h8v-2H7z" />
    ),
  },
  {
    href: '/wiki',
    label: '知识网络',
    short: 'Wiki',
    icon: (
      <path d="M12 3a3 3 0 110 6 3 3 0 010-6zM5 15a3 3 0 110 6 3 3 0 010-6zm14 0a3 3 0 110 6 3 3 0 010-6zM10.8 8.4l-4.1 6.3 1.7 1.1 4.1-6.3-1.7-1.1zm2.4 0l4.1 6.3-1.7 1.1-4.1-6.3 1.7-1.1z" />
    ),
  },
  {
    href: '/database',
    label: '数据库',
    short: '数据',
    icon: (
      <path d="M12 3c4.42 0 8 1.34 8 3s-3.58 3-8 3-8-1.34-8-3 3.58-3 8-3zm8 8.5c0 1.66-3.58 3-8 3s-8-1.34-8-3v-2c1.7 1.28 4.74 2 8 2s6.3-.72 8-2v2zm0 5c0 1.66-3.58 3-8 3s-8-1.34-8-3v-2c1.7 1.28 4.74 2 8 2s6.3-.72 8-2v2z" />
    ),
  },
  {
    href: '/monitor',
    label: '系统监控',
    short: '监控',
    icon: (
      <path d="M3 12h4l2.5-6 4 12 2.5-6h5v2h-3.8l-3.2 7.5-3.9-11.7L9.3 14H3v-2z" />
    ),
  },
  {
    href: '/eval',
    label: '评测中台',
    short: '评测',
    icon: (
      <path d="M4 4h16v3H4V4zm0 5.5h4v10H4V9.5zm6 0h4v10h-4V9.5zm6 0h4v10h-4V9.5z" />
    ),
  },
  {
    href: '/automation',
    label: '运营自动化',
    short: '自动化',
    icon: (
      <path d="M13 2L4.5 13.5H11l-1 8.5 8.5-11.5H12l1-8.5z" />
    ),
  },
  {
    href: '/erp',
    label: 'ERP 集成',
    short: 'ERP',
    icon: (
      <path d="M4 7h6v2H6v9h12v-4h2v6H4V7zm10-3h6v6h-2V7.41l-7.29 7.3-1.42-1.42L16.59 6H14V4z" />
    ),
  },
];

function NavIcon({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className={`h-[18px] w-[18px] ${className}`}>
      {children}
    </svg>
  );
}

/**
 * 控制台外壳：桌面端左侧导航，移动端底部 Tab 栏
 * scrollable=false 用于聊天页（自身占满高度、内部滚动）
 */
export default function AppShell({
  children,
  scrollable = true,
}: {
  children: React.ReactNode;
  scrollable?: boolean;
}) {
  const pathname = usePathname();
  const [online, setOnline] = useState<boolean | null>(null);

  useEffect(() => {
    let alive = true;
    const check = async () => {
      try {
        const base =
          process.env.NEXT_PUBLIC_API_BASE_URL?.replace(/\/+$/, '') ?? '';
        const r = await fetch(`${base}/health`, { cache: 'no-store' });
        const data = await r.json();
        if (alive) setOnline(data.mysql === 'ok' && data.redis === 'ok');
      } catch {
        if (alive) setOnline(false);
      }
    };
    void check();
    const timer = setInterval(check, 15000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, []);

  const isActive = (href: string) =>
    href === '/' ? pathname === '/' : pathname.startsWith(href);

  return (
    <div className="relative flex h-[100dvh] w-full overflow-hidden bg-canvas">
      {/* 全站氛围背景：极光光斑 + 顶部点阵 */}
      <div aria-hidden className="pointer-events-none absolute inset-0 overflow-hidden">
        <div className="ambient-canvas absolute inset-0" />
        <div className="dot-grid absolute inset-0 opacity-70" />
        <div className="aurora-blob aura-indigo -left-56 -top-64 h-[620px] w-[620px] animate-float-slow" />
        <div className="aurora-blob aura-cyan -right-44 top-1/3 h-[540px] w-[540px] animate-float-slow [animation-delay:-7s]" />
        <div className="aurora-blob aura-pink bottom-[-280px] left-1/3 h-[520px] w-[520px] animate-float-slow [animation-delay:-12s]" />
      </div>

      {/* 桌面端侧边导航 */}
      <aside className="relative z-20 hidden w-[248px] shrink-0 flex-col border-r border-rule border-t-[3px] border-t-ink-900 bg-paper-2 backdrop-blur-2xl md:flex">
        <div
          aria-hidden
          className="pointer-events-none absolute inset-x-0 top-0 h-44 bg-gradient-to-b from-paper-2/75 to-transparent"
        />
        <Link
          href="/"
          className="relative flex items-center gap-3 border-b border-rule px-5 pb-4 pt-6"
        >
          <div className="relative flex h-11 w-11 shrink-0 items-center justify-center rounded-[2px] bg-accent font-display text-[20px] font-semibold text-accent-ink shadow-[3px_3px_0_rgba(23,21,18,0.18)]">
            Y
          </div>
          <div className="min-w-0">
            <div className="whitespace-nowrap font-display text-[16px] font-semibold tracking-[0.01em] text-ink">
              AnswerY
            </div>
            <div className="mono-label mt-1 text-[9px] text-muted">
              Knowledge Desk · RAG Agent
            </div>
          </div>
        </Link>

        <div className="relative flex items-center justify-between px-5 pb-2 pt-4">
          <span className="mono-label text-[9.5px] text-muted">Workspace</span>
          <span className="mono-label text-[9.5px] text-muted">
            00—{String(NAV_ITEMS.length - 1).padStart(2, '0')}
          </span>
        </div>

        <nav className="relative flex-1 space-y-1.5 px-3 pt-1">
          {NAV_ITEMS.map((item) => {
            const active = isActive(item.href);
            return (
              <Link
                key={item.href}
                href={item.href}
                className={`press group relative flex items-center gap-2.5 rounded-[2px] px-2.5 py-2 text-[13px] font-medium transition ${
                  active
                    ? 'bg-ink text-paper-2'
                    : 'text-muted hover:bg-paper-3/60 hover:text-ink'
                }`}
              >
                <span
                  className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-[2px] transition ${
                    active ? 'text-accent-soft' : 'text-muted group-hover:text-ink'
                  }`}
                >
                  <NavIcon>{item.icon}</NavIcon>
                </span>
                {item.label}
                {active && (
                  <span className="ml-auto h-1.5 w-1.5 shrink-0 rounded-[2px] bg-accent" />
                )}
              </Link>
            );
          })}
        </nav>

        <AccountBox />

        <div className="relative px-4 pb-5">
          <div className="rounded-2xl border border-rule bg-paper-2 p-3.5 backdrop-blur-xl">
            <div className="flex items-center justify-between">
              <span className="text-[11px] font-medium text-slate-500">平台状态</span>
              <span
                className={`inline-flex items-center gap-1 rounded-[2px] px-1.5 py-0.5 text-[10.5px] font-medium ${
                  online === null
                    ? 'bg-slate-100 text-slate-500'
                    : online
                      ? 'bg-emerald-50 text-emerald-600'
                      : 'bg-rose-50 text-rose-500'
                }`}
              >
                <span
                  className={`h-1.5 w-1.5 rounded-full ${
                    online === null
                      ? 'bg-slate-300'
                      : online
                        ? 'live-dot bg-emerald-500'
                        : 'bg-rose-400'
                  }`}
                />
                {online === null ? '检测中' : online ? '正常' : '离线'}
              </span>
            </div>
            <div className="mt-2 text-[11px] leading-4 text-slate-500">
              React · FastAPI · LangGraph
              <br />
              演示数据均为虚构
            </div>
          </div>
        </div>
      </aside>

      {/* 内容区 */}
      <div className="relative flex min-w-0 flex-1 flex-col">
        <main
          className={
            scrollable
              ? 'nice-scroll flex-1 overflow-y-auto px-3.5 pb-24 pt-4 md:px-8 md:pb-8 md:pt-6'
              : 'flex min-h-0 flex-1 flex-col overflow-hidden'
          }
        >
          {children}
        </main>

        {/* 移动端底部 Tab */}
        <nav className="fixed inset-x-0 bottom-0 z-40 flex items-stretch justify-around border-t border-rule bg-paper-2 px-2 pb-safe pt-1.5 backdrop-blur-2xl md:hidden">
          {NAV_ITEMS.map((item) => {
            const active = isActive(item.href);
            return (
              <Link
                key={item.href}
                href={item.href}
                className={`flex flex-1 flex-col items-center gap-1 rounded-xl py-1 text-[10.5px] font-medium transition ${
                  active ? 'text-brand-600' : 'text-slate-500'
                }`}
              >
                <span
                  className={`flex h-8 w-9 items-center justify-center rounded-xl transition ${
                    active
                      ? 'bg-accent text-accent-ink'
                      : 'text-muted'
                  }`}
                >
                  <NavIcon>{item.icon}</NavIcon>
                </span>
                {item.short}
              </Link>
            );
          })}
        </nav>
      </div>
    </div>
  );
}

/** 侧边栏底部账号区：未登录给入口，已登录显示角色并可退出。 */
function AccountBox() {
  const [user, setUser] = useState<AuthUser | null>(null);

  useEffect(() => {
    const sync = () => setUser(getStoredUser());
    sync();
    window.addEventListener(AUTH_EVENT, sync);
    window.addEventListener('storage', sync);
    return () => {
      window.removeEventListener(AUTH_EVENT, sync);
      window.removeEventListener('storage', sync);
    };
  }, []);

  if (!user) {
    return (
      <div className="relative px-4 pb-2">
        <Link
          href="/login"
          className="press flex items-center justify-between rounded-2xl border border-rule bg-paper-2 px-3 py-2.5 text-[12px] font-medium text-muted transition hover:border-rule-2 hover:text-ink"
        >
          管理员登录
          <span className="text-[11px] text-slate-400">→</span>
        </Link>
      </div>
    );
  }

  const isAdmin = user.role === 'admin';
  return (
    <div className="relative px-4 pb-2">
      <div className="rounded-2xl border border-rule bg-paper-2 px-3 py-2.5 backdrop-blur-xl">
        <div className="flex items-center gap-2">
          <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-[2px] bg-accent text-[11px] font-semibold text-accent-ink">
            {user.name.slice(0, 1)}
          </span>
          <div className="min-w-0 flex-1">
            <div className="truncate text-[12px] font-medium text-slate-700">{user.name}</div>
            <div className="truncate text-[10.5px] text-slate-400">
              {isAdmin ? '管理员' : '普通用户'} · {user.phone}
            </div>
          </div>
          <button
            onClick={() => {
              logout();
              window.location.href = '/login';
            }}
            className="press shrink-0 text-[11px] font-medium text-slate-400 transition hover:text-rose-500"
          >
            退出
          </button>
        </div>
      </div>
    </div>
  );
}
