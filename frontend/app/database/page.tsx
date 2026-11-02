﻿'use client';

import { useEffect, useMemo, useState } from 'react';
import AppShell from '@/components/AppShell';
import { adminApi, type DbTable, type TableRows } from '@/lib/adminApi';

const PAGE_SIZE = 20;

export default function DatabasePage() {
  const [database, setDatabase] = useState('ecom_ai_demo');
  const [tables, setTables] = useState<DbTable[]>([]);
  const [active, setActive] = useState<string>('products');
  const [data, setData] = useState<TableRows | null>(null);
  const [offset, setOffset] = useState(0);
  const [keyword, setKeyword] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    adminApi
      .tables()
      .then((res) => {
        if (!alive) return;
        setDatabase(res.database);
        setTables(res.tables);
        if (!res.tables.some((t) => t.name === active) && res.tables[0]) {
          setActive(res.tables[0].name);
        }
      })
      .catch((e) => alive && setError(String(e.message ?? e)));
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    adminApi
      .tableRows(active, PAGE_SIZE, offset)
      .then((res) => {
        if (alive) {
          setData(res);
          setError(null);
        }
      })
      .catch((e) => alive && setError(String(e.message ?? e)))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [active, offset]);

  const rows = useMemo(() => {
    if (!data) return [];
    const q = keyword.trim().toLowerCase();
    if (!q) return data.rows;
    return data.rows.filter((row) =>
      Object.values(row).some((v) => String(v ?? '').toLowerCase().includes(q)),
    );
  }, [data, keyword]);

  const selectTable = (name: string) => {
    if (name === active) return;
    setActive(name);
    setOffset(0);
    setKeyword('');
  };

  return (
    <AppShell>
      <div className="mx-auto w-full max-w-[1240px]">
        <header className="border-b border-rule border-t-[3px] border-t-ink-900 pb-3 pt-3">
          <div className="mono-label text-muted">
            Database / 数据总账
          </div>
          <h1 className="mt-1.5 text-[26px] leading-tight text-slate-900 md:text-[30px]">
            数据库
          </h1>
          <p className="mt-1 text-[13px] text-slate-600">
            MySQL · <span className="font-mono text-[12.5px]">{database}</span> · 只读浏览，
            工具与 AI 共用同一份业务数据。
          </p>
        </header>

        {error && (
          <div className="mt-4 rounded-2xl bg-rose-50/80 px-4 py-3 text-[13px] text-rose-600 hairline">
            加载失败：{error}
          </div>
        )}

        <div className="mt-4 grid grid-cols-1 gap-3.5 lg:grid-cols-[250px_minmax(0,1fr)]">
          {/* 表列表 */}
          <div className="rounded-[2px] bg-paper-2 p-3 shadow-lift">
            <div className="px-2 pb-2 pt-1 text-[12px] font-semibold uppercase tracking-[0.08em] text-slate-500">
              数据表（{tables.length}）
            </div>
            <div className="nice-scroll space-y-1 overflow-y-auto lg:max-h-[calc(100dvh-300px)]">
              {tables.map((t) => {
                const selected = t.name === active;
                return (
                  <button
                    key={t.name}
                    onClick={() => selectTable(t.name)}
                    className={`press flex w-full items-center gap-2 rounded-xl px-2.5 py-2 text-left transition ${
                      selected
                        ? 'bg-paper-2 text-slate-900 shadow-lift'
                        : 'text-slate-600 hover:bg-paper-2 hover:text-slate-800'
                    }`}
                  >
                    <svg
                      viewBox="0 0 24 24"
                      fill="currentColor"
                      className={`h-4 w-4 shrink-0 ${selected ? 'text-brand-500' : 'text-slate-400'}`}
                    >
                      <path d="M12 3c4.42 0 8 1.34 8 3s-3.58 3-8 3-8-1.34-8-3 3.58-3 8-3zm8 8.5c0 1.66-3.58 3-8 3s-8-1.34-8-3v-2c1.7 1.28 4.74 2 8 2s6.3-.72 8-2v2zm0 5c0 1.66-3.58 3-8 3s-8-1.34-8-3v-2c1.7 1.28 4.74 2 8 2s6.3-.72 8-2v2z" />
                    </svg>
                    <div className="min-w-0 flex-1">
                      <div className="truncate font-mono text-[12px]">{t.name}</div>
                      <div className="truncate text-[11px] text-slate-500">{t.comment}</div>
                    </div>
                    <span className="shrink-0 rounded-[2px] bg-slate-100/80 px-1.5 py-0.5 text-[11px] tabular-nums text-slate-600">
                      {t.rows < 0 ? '—' : t.rows}
                    </span>
                  </button>
                );
              })}
              {tables.length === 0 && (
                <div className="space-y-1.5">
                  {Array.from({ length: 6 }).map((_, i) => (
                    <div key={i} className="h-10 animate-pulse rounded-xl bg-paper-2" />
                  ))}
                </div>
              )}
            </div>
          </div>

          {/* 数据区 */}
          <div className="min-w-0 rounded-[2px] bg-paper-2 p-4 shadow-lift md:p-5">
            <div className="flex flex-wrap items-center gap-2">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="font-mono text-[13px] font-semibold text-slate-900">
                    {active}
                  </span>
                  <span className="rounded-[2px] bg-brand-50 px-2 py-0.5 text-[11px] font-medium text-brand-600">
                    {data?.comment ?? '—'}
                  </span>
                </div>
                <div className="mt-0.5 text-[11.5px] text-slate-500">
                  共 {data?.total ?? 0} 行 · 当前展示 {offset + 1}–
                  {Math.min(offset + PAGE_SIZE, data?.total ?? 0)} 行
                </div>
              </div>

              <div className="flex items-center gap-1.5 rounded-[2px] bg-paper-2 px-3 py-1.5 hairline">
                <svg viewBox="0 0 20 20" fill="currentColor" className="h-3.5 w-3.5 text-slate-500">
                  <path d="M8.5 3a5.5 5.5 0 104.23 8.99l2.64 2.64a.75.75 0 101.06-1.06l-2.64-2.64A5.5 5.5 0 008.5 3zm-4 5.5a4 4 0 118 0 4 4 0 01-8 0z" />
                </svg>
                <input
                  value={keyword}
                  onChange={(e) => setKeyword(e.target.value)}
                  placeholder="筛选当前页"
                  className="w-[110px] bg-transparent text-[12px] text-slate-700 outline-none placeholder:text-slate-500 sm:w-[140px]"
                />
              </div>
            </div>

            <div className="nice-scroll mt-3 overflow-x-auto rounded-2xl hairline">
              <table className="w-full min-w-[640px] border-collapse text-[12px]">
                <thead>
                  <tr className="bg-slate-50/80">
                    {(data?.columns ?? []).map((c) => (
                      <th
                        key={c}
                        className="whitespace-nowrap px-3 py-2 text-left font-medium text-slate-600"
                      >
                        {c}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {loading ? (
                    <tr>
                      <td
                        colSpan={Math.max(1, data?.columns.length ?? 4)}
                        className="px-3 py-10 text-center text-slate-500"
                      >
                        读取中…
                      </td>
                    </tr>
                  ) : rows.length === 0 ? (
                    <tr>
                      <td
                        colSpan={Math.max(1, data?.columns.length ?? 4)}
                        className="px-3 py-10 text-center text-slate-500"
                      >
                        {keyword ? '当前页没有匹配的行' : '空表'}
                      </td>
                    </tr>
                  ) : (
                    rows.map((row, i) => (
                      <tr
                        key={i}
                        className={`border-t border-slate-100/80 ${
                          i % 2 ? 'bg-paper-2/60' : 'bg-transparent'
                        }`}
                      >
                        {(data?.columns ?? []).map((c) => {
                          const v = row[c];
                          return (
                            <td
                              key={c}
                              title={typeof v === 'string' ? v : undefined}
                              className={`max-w-[220px] truncate whitespace-nowrap px-3 py-2 ${
                                v == null ? 'text-slate-400 italic' : 'text-slate-600'
                              }`}
                            >
                              {v == null ? 'NULL' : String(v)}
                            </td>
                          );
                        })}
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>

            <div className="mt-3 flex items-center justify-between">
              <span className="text-[11.5px] text-slate-500">
                只读演示：接口为 /api/admin/db/tables/{active}
              </span>
              <div className="flex items-center gap-1.5">
                <button
                  onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
                  disabled={offset === 0}
                  className="press rounded-[2px] bg-paper-2 px-3 py-1.5 text-[12px] text-slate-600 hairline disabled:opacity-40"
                >
                  上一页
                </button>
                <span className="px-1 text-[11.5px] tabular-nums text-slate-500">
                  {Math.floor(offset / PAGE_SIZE) + 1} /{' '}
                  {Math.max(1, Math.ceil((data?.total ?? 0) / PAGE_SIZE))}
                </span>
                <button
                  onClick={() => setOffset(offset + PAGE_SIZE)}
                  disabled={offset + PAGE_SIZE >= (data?.total ?? 0)}
                  className="press rounded-[2px] bg-paper-2 px-3 py-1.5 text-[12px] text-slate-600 hairline disabled:opacity-40"
                >
                  下一页
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </AppShell>
  );
}
