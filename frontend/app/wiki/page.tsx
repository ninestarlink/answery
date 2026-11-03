'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import AppShell from '@/components/AppShell';
import {
  adminApi,
  type WikiGraph,
  type WikiOverview,
  type WikiPageDetail,
  type WikiPageSummary,
  type WikiPageType,
  type WikiSearchResult,
} from '@/lib/adminApi';

const KB_OPTIONS = [
  { value: 'all', label: '全部知识库' },
  { value: 'shop', label: '店铺客服' },
  { value: 'enterprise', label: '企业制度' },
];

const TYPE_LABEL: Record<WikiPageType, string> = {
  product: '商品',
  policy: '制度/政策',
  section: '章节',
};

const TYPE_STYLE: Record<WikiPageType, string> = {
  product: 'bg-accent-50 text-accent-700 ring-accent-100',
  policy: 'bg-paper-2 text-slate-600 ring-rule',
  section: 'bg-paper-2 text-slate-500 ring-rule',
};

const SUGGESTIONS = [
  '轻云 Pro 售后怎么算',
  '退货运费谁承担',
  '多久发货',
  '供应商批量质量问题',
  '绩效 C 还能晋升吗',
  '离职账号权限回收',
];

function TypeBadge({ type }: { type: WikiPageType }) {
  return (
    <span
      className={`rounded-[2px] px-1.5 py-0.5 font-mono text-[10px] tracking-wide ring-1 ${TYPE_STYLE[type]}`}
    >
      {TYPE_LABEL[type] ?? type}
    </span>
  );
}

export default function WikiPage() {
  const [kb, setKb] = useState('all');
  const [overview, setOverview] = useState<WikiOverview | null>(null);
  const [pages, setPages] = useState<WikiPageSummary[]>([]);
  const [graph, setGraph] = useState<WikiGraph | null>(null);
  const [keyword, setKeyword] = useState('');
  const [typeFilter, setTypeFilter] = useState<'all' | WikiPageType>('all');
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<WikiPageDetail | null>(null);
  const [query, setQuery] = useState('轻云 Pro 售后怎么算');
  const [searching, setSearching] = useState(false);
  const [searchResult, setSearchResult] = useState<WikiSearchResult | null>(null);
  const [rebuilding, setRebuilding] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadList = useCallback(async (kbId: string) => {
    try {
      const [ov, list, dot] = await Promise.all([
        adminApi.wikiOverview(kbId),
        adminApi.wikiPages(kbId),
        adminApi.wikiGraph(kbId, 160).catch(() => null),
      ]);
      setOverview(ov);
      setPages(list.items);
      setGraph(dot);
      setError(null);
      setSelected((prev) => {
        if (prev && list.items.some((item) => item.slug === prev)) return prev;
        return list.items[0]?.slug ?? null;
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : '加载知识网络失败');
    }
  }, []);

  useEffect(() => {
    void loadList(kb);
    setSearchResult(null);
  }, [kb, loadList]);

  useEffect(() => {
    if (!selected) {
      setDetail(null);
      return;
    }
    let alive = true;
    adminApi
      .wikiPage(selected)
      .then((data) => {
        if (alive) setDetail(data);
      })
      .catch((e) => {
        if (alive) setError(e instanceof Error ? e.message : '加载实体页失败');
      });
    return () => {
      alive = false;
    };
  }, [selected]);

  const visiblePages = useMemo(() => {
    const needle = keyword.trim().toLowerCase();
    return pages.filter((page) => {
      if (typeFilter !== 'all' && page.page_type !== typeFilter) return false;
      if (!needle) return true;
      const haystack = [page.title, page.summary ?? '', ...page.aliases].join(' ').toLowerCase();
      return haystack.includes(needle);
    });
  }, [pages, keyword, typeFilter]);

  const runSearch = useCallback(async (text: string) => {
    const value = text.trim();
    if (!value) return;
    setSearching(true);
    try {
      const result = await adminApi.wikiSearch(value, kb);
      setSearchResult(result);
      if (result.pages[0]) setSelected(result.pages[0].slug);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : '关系检索失败');
    } finally {
      setSearching(false);
    }
  }, [kb]);

  const rebuild = useCallback(async () => {
    setRebuilding(true);
    try {
      await adminApi.wikiRebuild(kb);
      await loadList(kb);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : '重建失败');
    } finally {
      setRebuilding(false);
    }
  }, [kb, loadList]);

  const stats = [
    { label: 'ENTITY PAGES', value: overview?.pages ?? '—', hint: '商品页 + 制度页' },
    { label: 'RELATIONS', value: overview?.links ?? '—', hint: 'wikilink / backlink' },
    { label: 'ALIASES', value: overview?.aliases ?? '—', hint: '文档号 / 口语叫法' },
    { label: 'SOURCE DOCS', value: overview?.docs ?? '—', hint: '已组织源文档' },
  ];

  return (
    <AppShell>
      <div className="mx-auto w-full max-w-[1180px]">
        <header className="flex flex-wrap items-end justify-between gap-3 border-t-[3px] border-ink-900 pt-4">
          <div>
            <div className="mono-label text-accent-600">LLMWIKI · RELATIONAL KNOWLEDGE</div>
            <h1 className="mt-1 text-[28px] leading-tight text-slate-900 md:text-[34px]">
              知识网络
            </h1>
            <p className="mt-1 max-w-[660px] text-[13px] leading-relaxed text-slate-600">
              先把原文组织成实体页与关系边，检索时先命中实体，再沿一跳邻居补充召回。
              RAG 仍是唯一召回通道，LLMWiki 负责「知识怎么连起来」。
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <div className="flex overflow-hidden rounded-[2px] ring-1 ring-rule">
              {KB_OPTIONS.map((item) => (
                <button
                  key={item.value}
                  onClick={() => setKb(item.value)}
                  className={`px-3 py-2 text-[12px] transition ${
                    kb === item.value
                      ? 'bg-ink text-paper-2'
                      : 'bg-paper-2 text-slate-600 hover:bg-paper-3'
                  }`}
                >
                  {item.label}
                </button>
              ))}
            </div>
            <button
              onClick={() => void rebuild()}
              disabled={rebuilding}
              className="press rounded-[2px] bg-accent px-4 py-2 text-[13px] font-medium text-accent-ink shadow-lift disabled:opacity-60"
            >
              {rebuilding ? '重建中…' : '重建关系索引'}
            </button>
          </div>
        </header>

        {error && (
          <div className="mt-3 rounded-[2px] bg-rose-50 px-4 py-2.5 text-[12.5px] text-rose-600 ring-1 ring-rose-200">
            {error}
          </div>
        )}

        <section className="mt-5 grid grid-cols-2 gap-2.5 md:grid-cols-4">
          {stats.map((item) => (
            <div key={item.label} className="rounded-[2px] bg-paper-2 p-4 shadow-lift">
              <div className="mono-label text-muted">{item.label}</div>
              <div className="mt-2 font-display text-[30px] leading-none tabular-nums text-ink">
                {item.value}
              </div>
              <div className="mt-1.5 text-[11.5px] text-muted">{item.hint}</div>
            </div>
          ))}
        </section>

        <section className="mt-5 rounded-[2px] bg-paper-2 p-4 shadow-lift">
          <div className="flex flex-wrap items-center gap-2">
            <div className="mono-label text-muted">RELATION RECALL · 关系检索</div>
            <span className="font-mono text-[10.5px] text-muted">
              实体命中 → 一跳邻居 → 送入原 RAG 精排
            </span>
          </div>
          <form
            className="mt-3 flex flex-col gap-2 sm:flex-row"
            onSubmit={(event) => {
              event.preventDefault();
              void runSearch(query);
            }}
          >
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="例如：轻云 Pro 售后怎么算 / 退货运费谁承担"
              className="h-10 flex-1 rounded-[2px] bg-paper px-3 text-[13px] text-ink ring-1 ring-rule outline-none focus:ring-accent"
            />
            <button
              type="submit"
              disabled={searching}
              className="press h-10 rounded-[2px] bg-ink px-4 text-[13px] font-medium text-paper-2 disabled:opacity-60"
            >
              {searching ? '检索中…' : '关系检索'}
            </button>
          </form>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {SUGGESTIONS.map((item) => (
              <button
                key={item}
                onClick={() => {
                  setQuery(item);
                  void runSearch(item);
                }}
                className="rounded-[2px] bg-paper px-2 py-1 font-mono text-[10.5px] text-slate-500 ring-1 ring-rule transition hover:text-accent-700 hover:ring-accent-200"
              >
                {item}
              </button>
            ))}
          </div>

          {searchResult && (
            <div className="mt-3 rounded-[2px] bg-paper p-3 ring-1 ring-rule">
              {searchResult.pages.length === 0 ? (
                <div className="text-[12px] text-muted">
                  没有命中实体页。换一个实体名（商品名 / 制度名 / 文档编号）再试。
                </div>
              ) : (
                <>
                  <div className="flex flex-wrap items-center gap-1.5">
                    {searchResult.pages.slice(0, 6).map((page) => (
                      <button
                        key={page.slug}
                        onClick={() => setSelected(page.slug)}
                        className={`rounded-[2px] px-2 py-1 text-[11.5px] ring-1 transition ${
                          page.distance === 0
                            ? 'bg-accent-50 text-accent-700 ring-accent-200'
                            : 'bg-paper-2 text-slate-600 ring-rule hover:ring-accent-200'
                        }`}
                      >
                        {page.title}
                        <span className="ml-1 font-mono text-[10px] text-muted">
                          {page.distance === 0 ? '命中' : '一跳'}
                        </span>
                      </button>
                    ))}
                  </div>
                  {searchResult.paths.length > 0 && (
                    <div className="mt-2.5 space-y-1">
                      {searchResult.paths.slice(0, 6).map((path, index) => (
                        <div key={`${path.from}-${path.to}-${index}`} className="font-mono text-[10.5px] text-muted">
                          {path.from_title}
                          <span className="mx-1 text-accent-600">—{path.relation}→</span>
                          {path.to_title}
                        </div>
                      ))}
                    </div>
                  )}
                  {searchResult.context && (
                    <pre className="mt-2.5 max-h-[168px] overflow-auto whitespace-pre-wrap rounded-[2px] bg-paper-2 p-2.5 font-mono text-[10.5px] leading-relaxed text-slate-600">
                      {searchResult.context}
                    </pre>
                  )}
                </>
              )}
            </div>
          )}
        </section>

        <div className="mt-5 grid gap-4 lg:grid-cols-[minmax(0,340px)_minmax(0,1fr)]">
          <section className="rounded-[2px] bg-paper-2 p-4 shadow-lift">
            <div className="flex items-center justify-between">
              <div className="mono-label text-muted">ENTITY PAGES</div>
              <span className="font-mono text-[10.5px] text-muted">{visiblePages.length} / {pages.length}</span>
            </div>
            <input
              value={keyword}
              onChange={(event) => setKeyword(event.target.value)}
              placeholder="按标题、摘要或别名过滤"
              className="mt-2 h-9 w-full rounded-[2px] bg-paper px-2.5 text-[12px] text-ink ring-1 ring-rule outline-none focus:ring-accent"
            />
            <div className="mt-2 flex gap-1">
              {(['all', 'product', 'policy'] as const).map((item) => (
                <button
                  key={item}
                  onClick={() => setTypeFilter(item)}
                  className={`rounded-[2px] px-2 py-1 font-mono text-[10px] ring-1 transition ${
                    typeFilter === item
                      ? 'bg-accent-50 text-accent-700 ring-accent-200'
                      : 'bg-paper text-slate-500 ring-rule'
                  }`}
                >
                  {item === 'all' ? '全部' : TYPE_LABEL[item]}
                </button>
              ))}
            </div>
            <div className="mt-2.5 max-h-[560px] space-y-1.5 overflow-auto pr-1">
              {visiblePages.length === 0 && (
                <div className="py-8 text-center text-[12px] text-muted">
                  {rebuilding ? '关系索引重建中…' : '没有匹配的实体页'}
                </div>
              )}
              {visiblePages.map((page) => (
                <button
                  key={page.slug}
                  onClick={() => setSelected(page.slug)}
                  className={`w-full rounded-[2px] p-2.5 text-left ring-1 transition ${
                    selected === page.slug
                      ? 'bg-accent-50 ring-accent-200'
                      : 'bg-paper ring-rule hover:ring-accent-200'
                  }`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="truncate text-[12.5px] font-medium text-ink">{page.title}</span>
                    <TypeBadge type={page.page_type} />
                  </div>
                  <div className="mt-1 line-clamp-2 text-[11px] leading-snug text-muted">
                    {page.summary || '—'}
                  </div>
                  <div className="mt-1 flex items-center gap-2 font-mono text-[10px] text-muted">
                    <span>{page.slug}</span>
                    <span>← {page.backlinks} 入链</span>
                  </div>
                </button>
              ))}
            </div>
          </section>

          <section className="rounded-[2px] bg-paper-2 p-4 shadow-lift">
            {!detail ? (
              <div className="py-16 text-center text-[12.5px] text-muted">
                选择左侧实体页查看关系与别名
              </div>
            ) : (
              <>
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div>
                    <div className="flex items-center gap-2">
                      <TypeBadge type={detail.page.page_type} />
                      <span className="font-mono text-[10.5px] text-muted">
                        {detail.page.kb_id} · {detail.page.slug}
                      </span>
                    </div>
                    <h2 className="mt-1.5 text-[22px] leading-tight text-ink">{detail.page.title}</h2>
                  </div>
                  <div className="text-right font-mono text-[10.5px] text-muted">
                    <div>{detail.links.length} 出链</div>
                    <div>{detail.backlinks.length} 入链</div>
                  </div>
                </div>

                <p className="mt-2 text-[12.5px] leading-relaxed text-slate-600">{detail.page.summary || '暂无摘要'}</p>

                <div className="mt-3">
                  <div className="mono-label text-muted">ALIASES · 别名</div>
                  <div className="mt-1.5 flex flex-wrap gap-1.5">
                    {detail.page.aliases.map((alias) => (
                      <span
                        key={alias}
                        className="rounded-[2px] bg-paper px-1.5 py-0.5 font-mono text-[10.5px] text-slate-600 ring-1 ring-rule"
                      >
                        {alias}
                      </span>
                    ))}
                  </div>
                </div>

                <div className="mt-4 grid gap-3 md:grid-cols-2">
                  <div className="rounded-[2px] bg-paper p-3 ring-1 ring-rule">
                    <div className="mono-label text-muted">OUTLINKS · 关系出边</div>
                    <div className="mt-2 space-y-1.5">
                      {detail.links.length === 0 && (
                        <div className="text-[11.5px] text-muted">暂无出边</div>
                      )}
                      {detail.links.map((link) => (
                        <button
                          key={`${link.target_slug}-${link.relation}`}
                          onClick={() => setSelected(link.target_slug)}
                          className="flex w-full items-start justify-between gap-2 rounded-[2px] px-1.5 py-1 text-left transition hover:bg-paper-2"
                        >
                          <span className="min-w-0">
                            <span className="block truncate text-[11.5px] text-ink">
                              {link.target_title ?? link.target_slug}
                            </span>
                            <span className="font-mono text-[10px] text-muted">{link.target_slug}</span>
                          </span>
                          <span className="shrink-0 rounded-[2px] bg-paper-2 px-1.5 py-0.5 text-[10px] text-accent-700 ring-1 ring-rule">
                            {link.relation}
                          </span>
                        </button>
                      ))}
                    </div>
                  </div>

                  <div className="rounded-[2px] bg-paper p-3 ring-1 ring-rule">
                    <div className="mono-label text-muted">BACKLINKS · 关系入边</div>
                    <div className="mt-2 space-y-1.5">
                      {detail.backlinks.length === 0 && (
                        <div className="text-[11.5px] text-muted">暂无入边</div>
                      )}
                      {detail.backlinks.map((link) => (
                        <button
                          key={`${link.source_slug}-${link.relation}`}
                          onClick={() => setSelected(link.source_slug)}
                          className="flex w-full items-start justify-between gap-2 rounded-[2px] px-1.5 py-1 text-left transition hover:bg-paper-2"
                        >
                          <span className="min-w-0">
                            <span className="block truncate text-[11.5px] text-ink">
                              {link.source_title ?? link.source_slug}
                            </span>
                            <span className="font-mono text-[10px] text-muted">{link.source_slug}</span>
                          </span>
                          <span className="shrink-0 rounded-[2px] bg-paper-2 px-1.5 py-0.5 text-[10px] text-slate-500 ring-1 ring-rule">
                            {link.relation}
                          </span>
                        </button>
                      ))}
                    </div>
                  </div>
                </div>

                <div className="mt-4">
                  <div className="flex items-center justify-between">
                    <div className="mono-label text-muted">PAGE BODY · 原文摘录</div>
                    <span className="font-mono text-[10px] text-muted">
                      来源：{detail.page.source_docs.join(' / ') || '—'}
                    </span>
                  </div>
                  <pre className="mt-1.5 max-h-[260px] overflow-auto whitespace-pre-wrap rounded-[2px] bg-paper p-3 font-mono text-[10.5px] leading-relaxed text-slate-600 ring-1 ring-rule">
                    {detail.page.body || '暂无内容'}
                  </pre>
                </div>

                {graph && graph.nodes.length > 0 && (
                  <div className="mt-3 font-mono text-[10px] text-muted">
                    当前视图 {graph.nodes.length} 个实体 / {graph.edges.length} 条关系 · 入度最高的实体：
                    {overview?.hubs.slice(0, 3).map((hub) => hub.title).join('、') || '—'}
                  </div>
                )}
              </>
            )}
          </section>
        </div>
      </div>
    </AppShell>
  );
}
