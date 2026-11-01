'use client';

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
      <aside className="relative z-20 hidden w-[248px] shrink-0 flex-col border-r border-white/60 bg-white/50 backdrop-blur-2xl md:flex">
        <div
          aria-hidden
          className="pointer-events-none absolute inset-x-0 top-0 h-44 bg-gradient-to-b from-white/75 to-transparent"
        />
        <Link href="/" className="relative flex items-center gap-3 px-5 pb-5 pt-6">
          <div className="relative flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-gradient-to-br from-brand-500 via-indigo-500 to-violet-500 text-[17px] font-semibold text-white shadow-[0_12px_26px_-10px_rgba(99,102,241,0.9)]">
            Y
            <span className="absolute -inset-1 -z-10 animate-breathe rounded-2xl bg-gradient-to-br from-brand-400/70 to-fuchsia-400/60 blur-lg" />
          </div>
          <div className="min-w-0">
            <div className="text-[14.5px] font-semibold tracking-tight-ios text-slate-900">
              AnswerY
            </div>
            <div className="mt-0.5 text-[11.5px] text-slate-500">
              智能客服中台 · Knowledge Desk
            </div>
          </div>
        </Link>

        <div className="relative px-5 pb-2 text-[10px] font-semibold uppercase tracking-[0.22em] text-slate-400">
          Workspace
        </div>

        <nav className="relative flex-1 space-y-1.5 px-3 pt-1">
          {NAV_ITEMS.map((item) => {
            const active = isActive(item.href);
            return (
              <Link
                key={item.href}
                href={item.href}
                className={`press group relative flex items-center gap-2.5 rounded-2xl px-2.5 py-2 text-[13px] font-medium transition ${
                  active
                    ? 'bg-white text-slate-900 shadow-bubble hairline'
                    : 'text-slate-600 hover:bg-white/55 hover:text-slate-900'
                }`}
              >
                {active && (
                  <span
                    aria-hidden
                    className="absolute left-0 top-1/2 h-6 w-[3px] -translate-y-1/2 rounded-r-full bg-gradient-to-b from-brand-500 to-violet-500"
                  />
                )}
                <span
                  className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-xl transition ${
                    active
                      ? 'bg-gradient-to-br from-brand-500 to-violet-500 text-white shadow-[0_8px_18px_-10px_rgba(99,102,241,0.9)]'
                      : 'bg-white/60 text-slate-500 hairline group-hover:bg-white group-hover:text-slate-700'
                  }`}
                >
                  <NavIcon>{item.icon}</NavIcon>
                </span>
                {item.label}
                {active && (
                  <span className="ml-auto h-1.5 w-1.5 shrink-0 rounded-full bg-brand-500" />
                )}
              </Link>
            );
          })}
        </nav>

        <AccountBox />

        <div className="relative px-4 pb-5">
          <div className="rounded-2xl border border-white/70 bg-white/60 p-3.5 backdrop-blur-xl">
            <div className="flex items-center justify-between">
              <span className="text-[11px] font-medium text-slate-500">平台状态</span>
              <span
                className={`inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[10.5px] font-medium ${
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
        <nav className="fixed inset-x-0 bottom-0 z-40 flex items-stretch justify-around border-t border-white/70 bg-white/80 px-2 pb-safe pt-1.5 backdrop-blur-2xl md:hidden">
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
                      ? 'bg-gradient-to-br from-brand-500 to-violet-500 text-white shadow-[0_8px_18px_-10px_rgba(99,102,241,0.9)]'
                      : 'text-slate-500'
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
          className="press flex items-center justify-between rounded-2xl border border-white/70 bg-white/60 px-3 py-2.5 text-[12px] font-medium text-slate-600 backdrop-blur-xl transition hover:bg-white/80"
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
      <div className="rounded-2xl border border-white/70 bg-white/60 px-3 py-2.5 backdrop-blur-xl">
        <div className="flex items-center gap-2">
          <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-brand-500 to-violet-500 text-[11px] font-semibold text-white">
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
