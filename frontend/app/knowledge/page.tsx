'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import AppShell from '@/components/AppShell';
import {
  adminApi,
  type KbDatasetDoc,
  type KbDocContent,
  type KbResponse,
} from '@/lib/adminApi';

const FORMAT_STYLES: Record<string, string> = {
  PDF: 'bg-rose-50 text-rose-600',
  DOCX: 'bg-sky-50 text-sky-600',
  XLSX: 'bg-emerald-50 text-emerald-600',
  MD: 'bg-amber-50 text-amber-600',
};

export default function KnowledgePage() {
  const [kb, setKb] = useState<KbResponse | null>(null);
  const [activeDatasetId, setActiveDatasetId] = useState<string>('ecommerce');
  const [openKey, setOpenKey] = useState<string | null>(null);
  const [doc, setDoc] = useState<KbDocContent | null>(null);
  const [loadingDoc, setLoadingDoc] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const cache = useRef(new Map<string, KbDocContent>());

  useEffect(() => {
    let alive = true;
    adminApi
      .knowledge()
      .then((res) => alive && setKb(res))
      .catch((e) => alive && setError(String(e.message ?? e)));
    return () => {
      alive = false;
    };
  }, []);

  const datasets = kb?.datasets ?? [];
  const activeDataset = useMemo(
    () => datasets.find((d) => d.id === activeDatasetId) ?? datasets[0],
    [datasets, activeDatasetId],
  );

  const switchDataset = (id: string) => {
    setActiveDatasetId(id);
    setOpenKey(null);
    setDoc(null);
  };

  const openDocument = async (dsId: string, item: KbDatasetDoc) => {
    const key = `${dsId}:${item.file}`;
    if (openKey === key) {
      setOpenKey(null);
      setDoc(null);
      return;
    }

    setOpenKey(key);
    setError(null);
    const cached = cache.current.get(key);
    if (cached) {
      setDoc(cached);
      return;
    }

    setDoc(null);
    setLoadingDoc(true);
    try {
      const res = await adminApi.knowledgeDoc(dsId, item.file);
      cache.current.set(key, res);
      setDoc(res);
    } catch (e) {
      setError(e instanceof Error ? e.message : '文档读取失败');
    } finally {
      setLoadingDoc(false);
    }
  };

  const downloadDoc = async (dsId: string, file: string) => {
    try {
      const blob = await adminApi.knowledgeDownload(dsId, file);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = file;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : '下载失败');
    }
  };

  return (
    <AppShell>
      <div className="mx-auto w-full max-w-[1180px]">
        <header className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <div className="text-[12px] font-medium tracking-wide text-slate-500">
              KNOWLEDGE BASE
            </div>
            <h1 className="mt-1 text-[26px] font-semibold leading-tight tracking-tight-ios text-slate-900 md:text-[30px]">
              知识库
            </h1>
            <p className="mt-1 text-[13px] text-slate-600">
              统一走 Embedding + 混合检索 + Rerank 精排，检索时按问题语义挑用；点开文档可核对原文。
            </p>
          </div>
          <span className="rounded-full bg-emerald-50 px-3 py-1 text-[12px] font-medium text-emerald-600">
            {datasets.length} 个知识库 ·{' '}
            {datasets.reduce((s, d) => s + d.total_documents, 0)} 份文档
          </span>
        </header>

        {error && (
          <div className="mt-4 rounded-2xl bg-rose-50/80 px-4 py-3 text-[13px] text-rose-600 hairline">
            {error}
          </div>
        )}

        {/* 知识库列表 */}
        <section className="mt-3.5 grid grid-cols-1 gap-2.5 md:grid-cols-2">
          {datasets.map((ds) => {
            const selected = ds.id === activeDataset?.id;
            return (
              <button
                key={ds.id}
                onClick={() => switchDataset(ds.id)}
                className={`press rounded-[24px] p-4 text-left transition hairline ${
                  selected ? 'bg-white shadow-bubble' : 'bg-white/60 hover:bg-white/85'
                }`}
              >
                <div className="flex items-start gap-2.5">
                  <span
                    className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${
                      selected ? 'bg-emerald-500' : 'bg-slate-300'
                    }`}
                  />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="truncate text-[14px] font-semibold tracking-tight-ios text-slate-900">
                        {ds.name}
                      </span>
                      {selected && (
                        <span className="shrink-0 rounded-full bg-emerald-50 px-1.5 py-0.5 text-[11px] font-medium text-emerald-600">
                          当前
                        </span>
                      )}
                    </div>
                    <div className="mt-0.5 truncate text-[12px] text-slate-500">{ds.subtitle}</div>
                    <div className="mt-2 flex flex-wrap items-center gap-1.5 text-[11.5px]">
                      <span className="rounded-full bg-slate-100/80 px-2 py-0.5 text-slate-600">
                        {ds.total_documents} 份文档
                      </span>
                      <span className="rounded-full bg-slate-100/80 px-2 py-0.5 text-slate-600">
                        {ds.total_chars.toLocaleString()} 字符
                      </span>
                      <span className="rounded-full bg-brand-50 px-2 py-0.5 text-brand-600">
                        {ds.engine}
                      </span>
                    </div>
                  </div>
                </div>
              </button>
            );
          })}
        </section>

        {/* 汇总指标 */}
        <section className="mt-3.5 grid grid-cols-3 gap-2.5">
          <MiniStat label="文档" value={activeDataset?.total_documents} />
          <MiniStat label="字符" value={activeDataset?.total_chars} />
          <MiniStat
            label={activeDataset?.total_segments == null ? '篇均字符' : '知识条目'}
            value={
              activeDataset?.total_segments ??
              (activeDataset?.total_documents
                ? Math.round(activeDataset.total_chars / activeDataset.total_documents)
                : undefined)
            }
          />
        </section>

        {/* 文档清单：两个知识库统一结构，可点开查看原文 */}
        <section className="mt-3.5 rounded-[24px] bg-white/72 p-4 shadow-bubble hairline backdrop-blur-xl md:p-5">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <div>
              <div className="text-[13.5px] font-semibold text-slate-800">文档清单</div>
              <div className="mt-0.5 text-[11.5px] text-slate-500">
                点击任意文档查看原文，用于核对回答是否与知识库一致
              </div>
            </div>
            {activeDataset && (
              <span className="rounded-full bg-brand-50 px-2.5 py-1 text-[11px] font-medium text-brand-600">
                {activeDataset.segmentation}
              </span>
            )}
          </div>

          <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2">
            {(activeDataset?.docs ?? []).map((item) => {
              const key = `${activeDataset?.id}:${item.file}`;
              const selected = openKey === key;
              return (
                <div
                  key={item.file}
                  className={`relative rounded-2xl transition hairline ${
                    selected ? 'bg-white shadow-bubble' : 'bg-white/80 hover:bg-white'
                  } ${item.missing ? 'opacity-60' : ''}`}
                >
                  <button
                    onClick={() => activeDataset && void openDocument(activeDataset.id, item)}
                    disabled={item.missing}
                    className={`press w-full rounded-2xl p-3 pr-11 text-left ${
                      item.missing ? 'cursor-not-allowed' : ''
                    }`}
                  >
                    <div className="flex items-center gap-2">
                      <span
                        className={`shrink-0 rounded-md px-1.5 py-0.5 font-mono text-[11px] font-semibold ${
                          FORMAT_STYLES[item.format] ?? 'bg-slate-100 text-slate-600'
                        }`}
                      >
                        {item.format}
                      </span>
                      <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-slate-800">
                        {item.title}
                      </span>
                      <svg
                        viewBox="0 0 20 20"
                        fill="currentColor"
                        className={`h-3.5 w-3.5 shrink-0 text-slate-400 transition-transform ${
                          selected ? 'rotate-90 text-brand-500' : ''
                        }`}
                      >
                        <path d="M7.22 4.22a.75.75 0 011.06 0l5.25 5.25a.75.75 0 010 1.06l-5.25 5.25a.75.75 0 11-1.06-1.06L11.94 10 7.22 5.28a.75.75 0 010-1.06z" />
                      </svg>
                    </div>
                    <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-[11.5px] text-slate-500">
                      {item.doc_no && (
                        <span className="rounded bg-slate-50 px-1.5 py-0.5 font-mono text-slate-600">
                          {item.doc_no}
                        </span>
                      )}
                      {item.version && (
                        <span className="rounded bg-brand-50 px-1.5 py-0.5 text-brand-600">
                          {item.version}
                        </span>
                      )}
                      {item.segments != null && (
                        <span className="rounded bg-slate-50 px-1.5 py-0.5 text-slate-600">
                          {item.segments} 条知识
                        </span>
                      )}
                      <span className="ml-auto">{item.missing ? '文件缺失' : item.updated_at}</span>
                    </div>
                  </button>

                  {!item.missing && activeDataset && (
                    <button
                      onClick={() => void downloadDoc(activeDataset.id, item.file)}
                      title="下载原文件，用本地应用打开"
                      className="press absolute right-2 top-2 flex h-7 w-7 items-center justify-center rounded-full bg-slate-100/80 text-slate-500 transition hover:bg-slate-200 hover:text-slate-900"
                    >
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-3.5 w-3.5">
                        <path d="M12 4v10m0 0l-3.5-3.5M12 14l3.5-3.5M5 18h14" strokeLinecap="round" strokeLinejoin="round" />
                      </svg>
                    </button>
                  )}
                </div>
              );
            })}
            {activeDataset?.docs.length === 0 && (
              <div className="rounded-xl border border-dashed border-slate-200 px-3 py-8 text-center text-[12px] text-slate-500">
                未找到该知识库的源文件
              </div>
            )}
          </div>

          {/* 文档原文 */}
          {openKey && (
            <div className="mt-3 animate-fade-up rounded-2xl bg-white/85 p-3 shadow-bubble hairline md:p-4">
              {loadingDoc && (
                <div className="space-y-2">
                  {[0, 1, 2, 3].map((i) => (
                    <div key={i} className="h-3.5 animate-pulse rounded-full bg-slate-100" />
                  ))}
                </div>
              )}

              {!loadingDoc && doc && (
                <>
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <span
                          className={`shrink-0 rounded-md px-1.5 py-0.5 font-mono text-[11px] font-semibold ${
                            FORMAT_STYLES[doc.format] ?? 'bg-slate-100 text-slate-600'
                          }`}
                        >
                          {doc.format}
                        </span>
                        <span className="truncate text-[13px] font-semibold text-slate-900">
                          {doc.title}
                        </span>
                      </div>
                      <div className="mt-1 flex flex-wrap gap-1.5 text-[11.5px] text-slate-500">
                        {doc.doc_no && <span className="font-mono">{doc.doc_no}</span>}
                        {doc.version && <span>· {doc.version}</span>}
                        <span>· {doc.chars.toLocaleString()} 字符</span>
                        <span>· 更新于 {doc.updated_at}</span>
                      </div>
                    </div>
                    <div className="flex shrink-0 items-center gap-1.5">
                      <button
                        onClick={() => void downloadDoc(doc.dataset, doc.file)}
                        className="press rounded-full bg-slate-900 px-2.5 py-1 text-[11.5px] font-medium text-white hover:bg-slate-800"
                      >
                        下载原文件
                      </button>
                      <button
                        onClick={() => {
                          setOpenKey(null);
                          setDoc(null);
                        }}
                        className="press rounded-full bg-slate-100 px-2.5 py-1 text-[11.5px] font-medium text-slate-600 hover:bg-slate-200"
                      >
                        收起
                      </button>
                    </div>
                  </div>

                  <div className="nice-scroll mt-3 max-h-[52vh] overflow-y-auto rounded-xl bg-white/70 p-3 hairline">
                    {doc.format === 'MD' ? (
                      <div className="md-body">
                        <ReactMarkdown remarkPlugins={[remarkGfm]}>{doc.content}</ReactMarkdown>
                      </div>
                    ) : (
                      <pre className="whitespace-pre-wrap break-words font-sans text-[12.5px] leading-6 text-slate-600">
                        {doc.content}
                      </pre>
                    )}
                    {doc.truncated && (
                      <div className="mt-2 text-[11px] text-slate-500">
                        文档较长，仅展示前 20,000 字符。
                      </div>
                    )}
                  </div>
                </>
              )}
            </div>
          )}

          <div className="mt-3 rounded-xl bg-slate-50 px-3.5 py-2.5 text-[12px] leading-5 text-slate-600">
            问答中的「参考来源」卡片来自检索证据链（文档名、章节、版本），可直接展开查看命中的原文片段，与这里的文档内容互相印证。
          </div>
        </section>
      </div>
    </AppShell>
  );
}

function MiniStat({ label, value }: { label: string; value?: number }) {
  return (
    <div className="rounded-[20px] bg-white/72 px-4 py-3 shadow-bubble hairline backdrop-blur-xl">
      <div className="text-[11.5px] font-medium text-slate-500">{label}</div>
      <div className="mt-1 text-[22px] font-semibold leading-none tabular-nums tracking-tight-ios text-slate-900">
        {value == null ? '—' : value.toLocaleString()}
      </div>
    </div>
  );
}
