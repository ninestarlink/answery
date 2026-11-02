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
      className={`group relative overflow-hidden rounded-[2px] border border-rule bg-paper-2 shadow-bubble transition-all duration-300 hover:-translate-y-0.5 hover:bg-paper-2 hover:shadow-lift ${
        compact ? 'p-4' : 'p-5'
      }`}
    >
      {/* 顶部栏线 */}
      <span
        aria-hidden
        className="absolute inset-x-0 top-0 h-[3px] bg-accent/75"
      />

      <div className="relative flex items-start gap-3 pt-1">
        <div
          className="flex h-10 w-10 shrink-0 items-center justify-center rounded-[2px] bg-accent text-accent-ink shadow-[3px_3px_0_rgba(23,21,18,0.16)] transition-transform duration-300 group-hover:-rotate-3"
        >
          {app.icon}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className="truncate font-display text-[15px] font-semibold text-ink">
              {app.name}
            </span>
            <span
              className={`inline-flex shrink-0 items-center gap-1 rounded-[2px] px-1.5 py-0.5 text-[10px] font-medium ${
                running ? 'bg-emerald-50 text-emerald-600' : 'bg-slate-100 text-slate-600'
              }`}
            >
              {running && <span className="h-1 w-1 rounded-full bg-emerald-500" />}
              {running ? '运行中' : '规划中'}
            </span>
          </div>
          <div className="mono-label mt-1 text-[9px] text-muted">{app.en}</div>
        </div>
      </div>

      <p className="relative mt-2.5 line-clamp-2 text-[12.5px] leading-relaxed text-slate-600">
        {app.desc}
      </p>

      <div className="relative mt-2.5 flex flex-wrap gap-1">
        {app.tags.map((t) => (
          <span
            key={t}
            className="rounded-[2px] bg-slate-100/80 px-1.5 py-0.5 text-[11px] text-slate-600 transition group-hover:bg-paper-3"
          >
            {t}
          </span>
        ))}
      </div>

      <div className="relative mt-3">
        {running ? (
          <Link
            href={app.href ?? '/apps'}
            className="press inline-flex items-center gap-1.5 rounded-[2px] bg-accent py-1.5 pl-3.5 pr-2 text-[12px] font-semibold text-accent-ink shadow-[2px_2px_0_rgba(23,21,18,0.16)] hover:bg-accent-hi"
          >
            进入工作台
            <span className="flex h-5 w-5 items-center justify-center rounded-[2px] bg-paper-2 text-ink transition-transform duration-300 group-hover:translate-x-0.5">
              <svg viewBox="0 0 20 20" fill="currentColor" className="h-3 w-3">
                <path d="M7.22 4.22a.75.75 0 011.06 0l5.25 5.25a.75.75 0 010 1.06l-5.25 5.25a.75.75 0 11-1.06-1.06L11.94 10 7.22 5.28a.75.75 0 010-1.06z" />
              </svg>
            </span>
          </Link>
        ) : (
          <span className="inline-flex items-center gap-1 rounded-[2px] bg-paper-2 px-3 py-1.5 text-[12px] font-medium text-slate-500 hairline">
            敬请期待
          </span>
        )}
      </div>
    </div>
  );
}

export { APPS };
