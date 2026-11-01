'use client';

import Link from 'next/link';
import { APPS } from '@/lib/apps';
import type { AppDef } from '@/lib/apps';

/** AI 应用卡片（首页与「AI 应用」页复用） */
export default function AppCard({
  app,
  compact = false,
}: {
  app: AppDef;
  compact?: boolean;
}) {
  const running = app.status === 'running';
  return (
    <div
      className={`sheen group relative overflow-hidden rounded-[26px] border border-white/70 bg-white/75 shadow-bubble backdrop-blur-xl transition-all duration-300 hover:-translate-y-1 hover:bg-white/90 hover:shadow-lift ${
        compact ? 'p-4' : 'p-5'
      }`}
    >
      {/* 顶部渐变细线 */}
      <span
        aria-hidden
        className={`absolute inset-x-5 top-0 h-px bg-gradient-to-r ${app.gradient} opacity-50`}
      />
      {/* 悬停时的品牌光晕 */}
      <div
        aria-hidden
        className={`pointer-events-none absolute -right-12 -top-14 h-36 w-36 rounded-full bg-gradient-to-br ${app.gradient} opacity-0 blur-2xl transition-opacity duration-500 group-hover:opacity-30`}
      />

      <div className="relative flex items-start gap-3">
        <div
          className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl bg-gradient-to-br ${app.gradient} ${
            app.iconClass ?? 'text-white'
          } shadow-[0_10px_22px_-10px_rgba(99,102,241,0.7)] transition-transform duration-300 group-hover:-rotate-3 group-hover:scale-105`}
        >
          {app.icon}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className="truncate text-[13.5px] font-semibold text-slate-900">
              {app.name}
            </span>
            <span
              className={`inline-flex shrink-0 items-center gap-1 rounded-full px-1.5 py-0.5 text-[11px] font-medium ${
                running ? 'bg-emerald-50 text-emerald-600' : 'bg-slate-100 text-slate-600'
              }`}
            >
              {running && <span className="h-1 w-1 rounded-full bg-emerald-500" />}
              {running ? '运行中' : '规划中'}
            </span>
          </div>
          <div className="mt-0.5 text-[12px] text-slate-500">{app.en}</div>
        </div>
      </div>

      <p className="relative mt-2.5 line-clamp-2 text-[12.5px] leading-relaxed text-slate-600">
        {app.desc}
      </p>

      <div className="relative mt-2.5 flex flex-wrap gap-1">
        {app.tags.map((t) => (
          <span
            key={t}
            className="rounded-md bg-slate-100/80 px-1.5 py-0.5 text-[11.5px] text-slate-600 transition group-hover:bg-white/80"
          >
            {t}
          </span>
        ))}
      </div>

      <div className="relative mt-3">
        {running ? (
          <Link
            href={app.href ?? '/apps'}
            className="press inline-flex items-center gap-1.5 rounded-full bg-slate-900 py-1.5 pl-3.5 pr-2 text-[12px] font-medium text-white shadow-[0_10px_22px_-12px_rgba(15,23,42,0.95)] hover:bg-slate-800"
          >
            进入工作台
            <span className="flex h-5 w-5 items-center justify-center rounded-full bg-white/15 transition-transform duration-300 group-hover:translate-x-0.5">
              <svg viewBox="0 0 20 20" fill="currentColor" className="h-3 w-3">
                <path d="M7.22 4.22a.75.75 0 011.06 0l5.25 5.25a.75.75 0 010 1.06l-5.25 5.25a.75.75 0 11-1.06-1.06L11.94 10 7.22 5.28a.75.75 0 010-1.06z" />
              </svg>
            </span>
          </Link>
        ) : (
          <span className="inline-flex items-center gap-1 rounded-full bg-white/70 px-3 py-1.5 text-[12px] font-medium text-slate-500 hairline">
            敬请期待
          </span>
        )}
      </div>
    </div>
  );
}

export { APPS };
