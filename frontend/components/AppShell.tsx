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
    <div className="relative flex h-[100dvh] w-full overflow-hidden bg-paper">
      {/* 全站底材：纸面 + 极淡点阵 */}
      <div aria-hidden className="pointer-events-none absolute inset-0 overflow-hidden">
        <div className="absolute inset-0 bg-paper" />
        <div className="dot-grid absolute inset-0 opacity-40" />
      </div>

      {/* 桌面端侧边导航 */}
      <aside className="relative z-20 hidden w-[248px] shrink-0 flex-col border-r border-rule bg-paper-2 md:flex">
        <Link href="/" className="relative flex items-center gap-3 px-5 pb-5 pt-6">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-[7px] bg-graphite font-display text-[16px] font-semibold text-graphite-ink">
            Y
          </div>
          <div className="min-w-0">
            <div className="whitespace-nowrap font-display text-[13.5px] font-semibold text-ink">
              AnswerY智能客服中台
            </div>
            <div className="mt-0.5 text-[11px] text-ink-muted">Knowledge Desk · 自建 RAG Agent</div>
          </div>
        </Link>

        <div className="relative px-5 pb-2 text-[10.5px] font-medium text-ink-muted">工作区</div>

        <nav className="relative flex-1 space-y-1 px-3 pt-1">
          {NAV_ITEMS.map((item) => {
            const active = isActive(item.href);
            return (
              <Link
                key={item.href}
                href={item.href}
                className={`group relative flex items-center gap-2.5 rounded-[6px] border px-2.5 py-2 text-[13px] font-medium transition ${
                  active
                    ? 'border-rule-2 bg-paper text-ink'
                    : 'border-transparent text-ink-2 hover:bg-paper hover:text-ink'
                }`}
              >
                {active && (
                  <span
                    aria-hidden
                    className="absolute inset-y-1.5 left-0 w-[2px] rounded-r-[2px] bg-accent"
                  />
                )}
                <span
                  className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-[5px] border transition ${
                    active
                      ? 'border-transparent text-accent'
                      : 'border-rule bg-paper text-ink-muted group-hover:text-ink-2'
                  }`}
                >
                  <NavIcon>{item.icon}</NavIcon>
                </span>
                {item.label}
              </Link>
            );
          })}
        </nav>

        <AccountBox />

        <div className="relative px-4 pb-5">
          <div className="cut p-3.5">
            <div className="flex items-center justify-between">
              <span className="text-[11px] font-medium text-ink-muted">平台状态</span>
              <span className="inline-flex items-center gap-1.5 text-[10.5px] font-medium text-ink-2">
                <span
                  className={`h-1.5 w-1.5 rounded-full ${
                    online === null
                      ? 'bg-ink-muted'
                      : online
                        ? 'live-dot bg-emerald-600'
                        : 'bg-rose-500'
                  }`}
                />
                {online === null ? '检测中' : online ? '正常' : '离线'}
              </span>
            </div>
            <div className="mt-2 font-mono text-[10.5px] leading-4 text-ink-muted">
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
        <nav className="fixed inset-x-0 bottom-0 z-40 flex items-stretch justify-around border-t border-rule bg-paper px-2 pb-safe pt-1.5 md:hidden">
          {NAV_ITEMS.map((item) => {
            const active = isActive(item.href);
            return (
              <Link
                key={item.href}
                href={item.href}
                className={`flex flex-1 flex-col items-center gap-1 py-1 text-[10.5px] font-medium transition ${
                  active ? 'text-accent-deep' : 'text-ink-muted'
                }`}
              >
                <span
                  className={`flex h-7 w-8 items-center justify-center rounded-[5px] border ${
                    active ? 'border-transparent text-accent' : 'border-rule text-ink-muted'
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
          className="flex items-center justify-between rounded-[6px] border border-rule-2 bg-paper px-3 py-2.5 text-[12px] font-medium text-ink-2 transition hover:bg-paper-3 hover:text-ink"
        >
          管理员登录
          <span className="text-[11px] text-ink-muted">→</span>
        </Link>
      </div>
    );
  }

  const isAdmin = user.role === 'admin';
  return (
    <div className="relative px-4 pb-2">
      <div className="cut px-3 py-2.5">
        <div className="flex items-center gap-2">
          <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-[5px] bg-graphite text-[11px] font-semibold text-graphite-ink">
            {user.name.slice(0, 1)}
          </span>
          <div className="min-w-0 flex-1">
            <div className="truncate text-[12px] font-medium text-ink">{user.name}</div>
            <div className="truncate text-[10.5px] text-ink-muted">
              {isAdmin ? '管理员' : '普通用户'} · {user.phone}
            </div>
          </div>
          <button
            onClick={() => {
              logout();
              window.location.href = '/login';
            }}
            className="shrink-0 text-[11px] font-medium text-ink-muted transition hover:text-rose-500"
          >
            退出
          </button>
        </div>
      </div>
    </div>
  );
}
