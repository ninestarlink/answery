"""LLMWiki：知识组织层（实体页 + wikilink / backlink / 别名 + 关系召回）。

定位：不替代 RAG，而是把「文档切片」先组织成可读的实体页与关系边：
- 商品页 → 退换货 / 配送 / 尺码政策；跑鞋之间互为同类对比；
- 制度页 → 引用制度、脱敏与安全条款、绩效与晋升衔接；
- 每个实体页带别名（文档编号、文件名、口语叫法），检索时先命中实体，再沿 1 跳关系取邻居。

检索融合：关系召回只作为额外的一路候选，交给原来同一次 rerank 打分，
向量 / BM25 / RRF / 精排顺序不变，因此不改变 RAG 主链路的既有行为。
"""

from __future__ import annotations

import asyncio
import hashlib
import logging
import re
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from ..config import settings
from . import registry, store
from .bm25 import BM25Index
from .parser import DOC_NO_RE, parse_file

logger = logging.getLogger("rag.wiki")

# 商品标题里的通用品类后缀，用来抽「轻云 Pro」这类核心名做别名
_PRODUCT_SUFFIXES = (
    "越野跑鞋",
    "碳板跑鞋",
    "缓震跑鞋",
    "实战篮球鞋",
    "休闲板鞋",
    "健步鞋",
    "跑鞋",
    "篮球鞋",
    "板鞋",
)
_PRODUCT_RE = re.compile(r"^##\s+(?:[一二三四五六七八九十]+、)?(.+?)\s*（([pP]\d{4})）\s*$", re.M)
_REF_RE = re.compile(r"《([^》]{2,40})》")
_VER_SUFFIX_RE = re.compile(r"_v\d{4}$", re.I)
_NUM_PREFIX_RE = re.compile(r"^[0-9]+_")
_NORM_RE = re.compile(r"[^0-9a-z\u4e00-\u9fff]+")

# 店铺政策文档的口语别名：用户很少说全称，别名直接决定实体能不能命中
_SHOP_DOC_ALIASES: dict[str, list[str]] = {
    "products": ["商品知识库", "商品目录", "商品清单", "商品详情"],
    "returns": ["退换货政策", "退货政策", "换货政策", "退换货与质保政策", "售后政策", "质保政策"],
    "shipping": ["配送政策", "运费政策", "发货时效", "物流政策"],
    "coupons": ["优惠券规则", "优惠券政策", "用券规则"],
    "sizing": ["尺码指南", "选码规则", "尺码建议"],
}

# 文档之间正文没写全、但业务上明确相关的边；按源文件名做键更稳定（标题可能来自 H1）
_MANUAL_DOC_LINKS: dict[tuple[str, str], list[tuple[str, str]]] = {
    ("shop", "returns"): [("配送与运费政策", "退换运费")],
    ("shop", "shipping"): [("退换货与质保政策", "退换运费")],
    ("shop", "sizing"): [("退换货与质保政策", "换码规则")],
    ("shop", "products"): [
        ("退换货与质保政策", "售后政策"),
        ("配送与运费政策", "配送政策"),
        ("尺码选择指南", "尺码规则"),
    ],
    ("enterprise", "绩效考核管理办法"): [("员工培训与晋升规范", "绩效与晋升")],
    ("enterprise", "员工培训与晋升规范"): [("绩效考核管理办法", "晋升条件")],
    ("enterprise", "信息安全规范"): [("数据合规与客户隐私政策", "数据合规")],
    ("enterprise", "数据合规与客户隐私政策"): [("信息安全规范", "安全基线")],
}

_PRODUCT_POLICY_LINKS = [
    ("退换货与质保政策", "售后政策"),
    ("配送与运费政策", "配送政策"),
    ("尺码选择指南", "尺码规则"),
]

_TYPE_LABELS = {"product": "商品", "policy": "制度/政策", "section": "章节"}

_create_lock = asyncio.Lock()
_locks: dict[str, asyncio.Lock] = {}
_cache: dict[str, tuple[float, list[dict[str, Any]], list[dict[str, Any]]]] = {}
_auto_build_attempted = False


@dataclass
class _Page:
    slug: str
    kb_id: str
    title: str
    page_type: str
    summary: str
    body: str
    aliases: list[str] = field(default_factory=list)
    source_docs: list[str] = field(default_factory=list)


@dataclass
class _Link:
    source: str
    target: str  # 构建阶段先存标题 / 文档编号，最后统一解析成 slug
    relation: str
    weight: int = 1


def _norm(text: str) -> str:
    return _NORM_RE.sub("", (text or "").lower())


def _clean_title(name: str) -> str:
    return _VER_SUFFIX_RE.sub("", (name or "").strip())


def _stem_title(path: Path) -> str:
    return _NUM_PREFIX_RE.sub("", path.stem)


def _slug_for_doc(doc_no: str, title: str, source_file: str) -> str:
    if doc_no:
        return doc_no.lower()
    digest = hashlib.sha1(f"{title}|{source_file}".encode()).hexdigest()[:10]
    return f"doc-{digest}"


def _doc_aliases(kb_id: str, doc, path: Path) -> list[str]:
    stem = _stem_title(path)
    values = [
        doc.doc_name,
        _clean_title(doc.doc_name),
        doc.doc_no,
        stem,
        path.name,
        path.stem,
    ]
    if kb_id == "shop":
        values.extend(_SHOP_DOC_ALIASES.get(stem.lower(), []))
    out: list[str] = []
    seen: set[str] = set()
    for value in values:
        value = (value or "").strip()
        key = _norm(value)
        if not key or key in seen:
            continue
        seen.add(key)
        out.append(value)
    return out


def _title_of(body: str, fallback: str, stem: str) -> str:
    """优先用正文一级标题做实体名：文件名是 returns，用户认的是「退换货与质保政策」。"""
    if stem.lower() == "products":
        return "商品知识库"
    match = re.search(r"^#\s+(.+)$", body, re.M)
    if match:
        title = match.group(1).strip().replace("**", "").replace("#", "").strip()
        if 2 <= len(title) <= 32 and "·" not in title and "/" not in title:
            return title
    return fallback


def _unique_slug(base: str, used: set[str]) -> str:
    """同一知识库里文档编号可能重复（制度正文 + 配套清单），给后来者加序号。"""
    if base not in used:
        used.add(base)
        return base
    index = 2
    while f"{base}-{index}" in used:
        index += 1
    slug = f"{base}-{index}"
    used.add(slug)
    return slug


def _summary_of(text: str, title: str) -> str:
    """取文档 / 商品的第一段可读描述作为摘要，跳过引用块与标题行。"""
    for line in (text or "").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or line.startswith(">") or line.startswith("|"):
            continue
        line = re.sub(r"^[-*]\s+", "", line)
        line = re.sub(r"\*\*", "", line)
        if len(line) >= 6:
            return line[:140]
    return title


def _product_core(title: str) -> str:
    core = title.strip()
    for suffix in _PRODUCT_SUFFIXES:
        if core.endswith(suffix) and len(core) - len(suffix) >= 2:
            return core[: -len(suffix)].strip()
    return core


def _product_sections(text: str) -> list[tuple[str, str, str]]:
    """从商品 Markdown 里切出「商品名 + pID + 章节正文」。"""
    matches = list(_PRODUCT_RE.finditer(text))
    headings = [m.start() for m in re.finditer(r"^##\s", text, re.M)]
    output: list[tuple[str, str, str]] = []
    for match in matches:
        end = next((pos for pos in headings if pos > match.end()), len(text))
        output.append((match.group(1).strip(), match.group(2).lower(), text[match.end() : end].strip()))
    return output


def _build_corpus(kb_id: str) -> tuple[list[_Page], list[_Link]]:
    """解析知识库源文件，生成实体页与关系边（纯同步，放到线程里跑）。"""
    kb = registry.get_kb(kb_id)
    if kb is None:
        raise ValueError(f"未知知识库：{kb_id}")

    pages: list[_Page] = []
    links: list[_Link] = []
    products: list[tuple[_Page, str]] = []
    used_slugs: set[str] = set()

    for path in kb.paths:
        try:
            doc = parse_file(path)
        except Exception as exc:  # 单个文件解析失败不阻断整库
            logger.warning("LLMWiki 解析失败 %s：%s", path.name, exc)
            continue

        stem = _stem_title(path)
        fallback = _clean_title(doc.doc_name) or stem
        body = doc.full_text.strip()
        title = _title_of(body, fallback, stem)
        slug = _unique_slug(_slug_for_doc(doc.doc_no, title, path.stem), used_slugs)
        aliases = _doc_aliases(kb_id, doc, path)
        page = _Page(
            slug=slug,
            kb_id=kb_id,
            title=title,
            page_type="policy",
            summary=_summary_of(body, title),
            body=body[:2400],
            aliases=aliases,
            source_docs=[doc.doc_name],
        )
        pages.append(page)

        # 商品库：把每个商品章节升级为独立实体页，关系比整篇文档更强
        if kb_id == "shop" and stem.lower() == "products":
            for product_title, pid, section in _product_sections(body):
                variant = re.search(r"也写作(.+?)）", section)
                product_aliases = [product_title, product_title.replace(" ", ""), _product_core(product_title)]
                if variant:
                    product_aliases.append(variant.group(1).strip())
                summary_hit = re.search(r"一句话定位[：:]\s*([^\n]+)", section)
                product = _Page(
                    slug=_unique_slug(pid, used_slugs),
                    kb_id=kb_id,
                    title=product_title,
                    page_type="product",
                    summary=(summary_hit.group(1).strip() if summary_hit else _summary_of(section, product_title))[:140],
                    body=section[:1600],
                    aliases=[a for a in dict.fromkeys(product_aliases) if a],
                    source_docs=[doc.doc_name],
                )
                pages.append(product)
                products.append((product, section))

        # 业务上明确但正文没写全的关系（按源文件名挂载，标题变化不影响）
        for target_title, relation in _MANUAL_DOC_LINKS.get((kb_id, stem.lower()), []):
            links.append(_Link(source=slug, target=target_title, relation=relation))

        # 文档里点名的《制度》与文档编号 → 引用边
        for ref in _REF_RE.findall(body):
            ref = ref.strip()
            if _norm(ref) != _norm(title):
                links.append(_Link(source=slug, target=ref, relation="引用制度"))
        for doc_no in dict.fromkeys(DOC_NO_RE.findall(body)):
            if doc_no.lower() != slug:
                links.append(_Link(source=slug, target=doc_no.lower(), relation="引用制度"))

    # 商品之间：选购建议里提到另一款，就建一条「同类对比」边
    for product, section in products:
        section_norm = _norm(section)
        for other, _ in products:
            if other.slug == product.slug:
                continue
            if _norm(_product_core(other.title)) and _norm(_product_core(other.title)) in section_norm:
                links.append(_Link(source=product.slug, target=other.slug, relation="同类对比"))

    # 商品 → 店铺政策：售后、运费、选码都是商品问题的下一跳
    for product, _ in products:
        for target_title, relation in _PRODUCT_POLICY_LINKS:
            links.append(_Link(source=product.slug, target=target_title, relation=relation))

    return _resolve_links(pages, links)


def _resolve_links(pages: list[_Page], links: list[_Link]) -> tuple[list[_Page], list[_Link]]:
    """把「标题 / 文档编号」目标解析成 slug，解析不到的外部引用直接丢弃。"""
    lookup: dict[str, str] = {}
    for page in pages:
        for value in [page.slug, page.title, _clean_title(page.title), *page.aliases]:
            key = _norm(value)
            if key:
                lookup.setdefault(key, page.slug)

    resolved: list[_Link] = []
    seen: set[tuple[str, str, str]] = set()
    for link in links:
        target = lookup.get(_norm(link.target))
        if target is None:
            # 允许「《信息安全规范》」这类书名号引用做包含匹配
            key = _norm(link.target)
            if len(key) >= 4:
                for candidate_key, slug in lookup.items():
                    if key in candidate_key or candidate_key in key:
                        target = slug
                        break
        if not target or target == link.source:
            continue
        item = (link.source, target, link.relation)
        if item in seen:
            continue
        seen.add(item)
        resolved.append(_Link(source=link.source, target=target, relation=link.relation, weight=link.weight))
    return pages, resolved


async def _ensure_schema(conn) -> None:
    await conn.execute(
        """
        CREATE TABLE IF NOT EXISTS wiki_pages (
            slug TEXT PRIMARY KEY,
            kb_id TEXT NOT NULL,
            title TEXT NOT NULL,
            page_type TEXT NOT NULL,
            summary TEXT,
            body TEXT,
            aliases TEXT[] NOT NULL DEFAULT '{}',
            source_docs TEXT[] NOT NULL DEFAULT '{}',
            built_at TIMESTAMPTZ DEFAULT now()
        )
        """
    )
    await conn.execute(
        """
        CREATE TABLE IF NOT EXISTS wiki_links (
            kb_id TEXT NOT NULL,
            source_slug TEXT NOT NULL,
            target_slug TEXT NOT NULL,
            relation TEXT NOT NULL,
            weight INT DEFAULT 1
        )
        """
    )
    await conn.execute("CREATE INDEX IF NOT EXISTS wiki_pages_kb_idx ON wiki_pages (kb_id)")
    await conn.execute("CREATE INDEX IF NOT EXISTS wiki_links_kb_idx ON wiki_links (kb_id)")
    await conn.execute("CREATE INDEX IF NOT EXISTS wiki_links_target_idx ON wiki_links (kb_id, target_slug)")


async def _persist(kb_id: str, pages: list[_Page], links: list[_Link]) -> None:
    pool = await store.get_pool()
    async with pool.acquire() as conn:
        await _ensure_schema(conn)
        async with conn.transaction():
            await conn.execute("DELETE FROM wiki_links WHERE kb_id=$1", kb_id)
            await conn.execute("DELETE FROM wiki_pages WHERE kb_id=$1", kb_id)
            await conn.executemany(
                """
                INSERT INTO wiki_pages (slug, kb_id, title, page_type, summary, body, aliases, source_docs)
                VALUES ($1,$2,$3,$4,$5,$6,$7::text[],$8::text[])
                ON CONFLICT (slug) DO UPDATE SET
                    kb_id=EXCLUDED.kb_id, title=EXCLUDED.title, page_type=EXCLUDED.page_type,
                    summary=EXCLUDED.summary, body=EXCLUDED.body, aliases=EXCLUDED.aliases,
                    source_docs=EXCLUDED.source_docs, built_at=now()
                """,
                [
                    (p.slug, p.kb_id, p.title, p.page_type, p.summary, p.body, p.aliases, p.source_docs)
                    for p in pages
                ],
            )
            await conn.executemany(
                """
                INSERT INTO wiki_links (kb_id, source_slug, target_slug, relation, weight)
                VALUES ($1,$2,$3,$4,$5)
                """,
                [(kb_id, l.source, l.target, l.relation, l.weight) for l in links],
            )


def invalidate(kb_id: str | None = None) -> None:
    if kb_id:
        _cache.pop(kb_id, None)
    else:
        _cache.clear()


async def build_kb(kb_id: str) -> dict[str, Any]:
    """重建单个知识库的实体页与关系边。"""
    lock = _locks.setdefault(kb_id, asyncio.Lock())
    async with lock:
        pages, links = await asyncio.to_thread(_build_corpus, kb_id)
        await _persist(kb_id, pages, links)
        invalidate(kb_id)
        summary = {
            "kb_id": kb_id,
            "pages": len(pages),
            "links": len(links),
            "products": sum(1 for p in pages if p.page_type == "product"),
            "aliases": sum(len(p.aliases) for p in pages),
            "docs": len({d for p in pages for d in p.source_docs}),
        }
        logger.info("LLMWiki 重建完成：%s", summary)
        return summary


async def build_all() -> list[dict[str, Any]]:
    results = []
    for kb_id in registry.KBS:
        results.append(await build_kb(kb_id))
    return results


async def _count_pages() -> int:
    pool = await store.get_pool()
    async with pool.acquire() as conn:
        await _ensure_schema(conn)
        return int(await conn.fetchval("SELECT count(*) FROM wiki_pages") or 0)


async def ensure_built() -> None:
    """启动自检：关系表为空时后台建一次，失败只打日志，不影响服务启动。"""
    global _auto_build_attempted
    if not settings.wiki_enabled or _auto_build_attempted:
        return
    async with _create_lock:
        if _auto_build_attempted:
            return
        _auto_build_attempted = True
        try:
            if await _count_pages() == 0:
                await build_all()
        except Exception as exc:  # noqa: BLE001
            logger.warning("LLMWiki 自动构建失败（可稍后手动重建）：%s", exc)


async def _load(kb_id: str) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    cached = _cache.get(kb_id)
    if cached and time.time() - cached[0] < settings.wiki_cache_ttl:
        return cached[1], cached[2]
    pool = await store.get_pool()
    async with pool.acquire() as conn:
        await _ensure_schema(conn)
        pages = await conn.fetch(
            """
            SELECT slug, kb_id, title, page_type, summary, body, aliases, source_docs, built_at
            FROM wiki_pages WHERE kb_id=$1
            ORDER BY page_type DESC, title
            """,
            kb_id,
        )
        links = await conn.fetch(
            "SELECT kb_id, source_slug, target_slug, relation, weight FROM wiki_links WHERE kb_id=$1",
            kb_id,
        )
    page_items = [dict(row) for row in pages]
    for item in page_items:
        item["aliases"] = list(item["aliases"] or [])
        item["source_docs"] = list(item["source_docs"] or [])
    link_items = [dict(row) for row in links]
    _cache[kb_id] = (time.time(), page_items, link_items)
    return page_items, link_items


def _empty(query: str = "") -> dict[str, Any]:
    return {"query": query, "pages": [], "paths": [], "context": "", "doc_names": []}


async def retrieve(kb_id: str, query: str, limit: int | None = None) -> dict[str, Any]:
    """关系召回：别名/标题命中 + 页正文 BM25 → 1 跳邻居 → 关系上下文。"""
    query = (query or "").strip()
    if not query:
        return _empty(query)
    pages, links = await _load(kb_id)
    if not pages:
        return _empty(query)

    by_slug = {page["slug"]: page for page in pages}
    query_norm = _norm(query)
    scores: dict[str, float] = {}
    matched: dict[str, str] = {}

    for page in pages:
        for alias in [page["title"], *page["aliases"]]:
            alias_norm = _norm(alias)
            if not alias_norm:
                continue
            if alias_norm == query_norm:
                scores[page["slug"]] = 4.0
                matched[page["slug"]] = alias
            elif alias_norm in query_norm and len(alias_norm) >= 2:
                score = 3.0 if len(alias_norm) >= 4 else 2.0
                if score > scores.get(page["slug"], 0):
                    scores[page["slug"]] = score
                    matched[page["slug"]] = alias
            elif query_norm in alias_norm and len(query_norm) >= 3:
                if 1.5 > scores.get(page["slug"], 0):
                    scores[page["slug"]] = 1.5
                    matched[page["slug"]] = alias

    docs = [(page["slug"], " ".join([page["title"], *page["aliases"], page["summary"] or ""])) for page in pages]
    index = BM25Index(docs)
    hits = index.search(query, max(limit or settings.wiki_max_pages, 4) * 3)
    # BM25 原始分太低时宁可不出页：避免在错误的知识库里把「售后」硬匹配成客服 SOP
    top_score = hits[0][1] if hits else 0.0
    for slug, score in hits:
        if score < 2.0:
            continue
        scores[slug] = scores.get(slug, 0.0) + 1.2 * (score / top_score if top_score else 0)

    ranked = sorted(scores.items(), key=lambda item: item[1], reverse=True)
    if not ranked:
        return _empty(query)
    # 相对阈值：跨库问「轻云 Pro」时，企业库只有弱 BM25 命中，不应被当成实体页带出
    cutoff = max(1.0, ranked[0][1] * 0.45)
    primary = [slug for slug, score in ranked if score >= cutoff][: (limit or settings.wiki_max_pages)]
    if not primary:
        return _empty(query)

    # 1 跳关系扩展：出边 + 入边，让「商品 → 政策」「制度 → 被引用制度」一起进入上下文
    neighbours: dict[str, list[dict[str, str]]] = {}
    seen_edges: dict[str, set[tuple[str, str]]] = {}
    edge_set = {(link["source_slug"], link["target_slug"]) for link in links}
    for link in links:
        source, target = link["source_slug"], link["target_slug"]
        if source in primary and target in by_slug:
            item = {"to": target, "title": by_slug[target]["title"], "relation": link["relation"]}
        elif target in primary and source in by_slug:
            # 双向边只保留出边，避免「A 同类对比 B」和「B 被引用（同类对比）A」重复出现
            if (target, source) in edge_set:
                continue
            item = {
                "to": source,
                "title": by_slug[source]["title"],
                "relation": f"被引用（{link['relation']}）",
            }
        else:
            continue
        key = source if source in primary else target
        pair = (item["to"], item["relation"])
        if pair in seen_edges.setdefault(key, set()):
            continue
        seen_edges[key].add(pair)
        neighbours.setdefault(key, []).append(item)

    linked: list[str] = []
    if settings.wiki_hop >= 1:
        for slug in primary:
            for item in neighbours.get(slug, []):
                if item["to"] not in primary:
                    linked.append(item["to"])
    linked = list(dict.fromkeys(linked))[: limit or settings.wiki_max_pages]

    lines: list[str] = []
    for slug in primary:
        page = by_slug[slug]
        label = _TYPE_LABELS.get(page["page_type"], page["page_type"])
        lines.append(f"[LLMWiki · {label}] {page['title']}")
        if page["summary"]:
            lines.append(f"摘要：{page['summary']}")
        rels = neighbours.get(slug, [])[:4]
        if rels:
            lines.append("关系：" + "；".join(f"{item['relation']}→{item['title']}" for item in rels))
    for slug in linked[:3]:
        page = by_slug[slug]
        lines.append(f"关联页：{page['title']}｜{page['summary'] or ''}".rstrip("｜"))

    context = "\n".join(lines)[: settings.wiki_context_chars]
    doc_names: list[str] = []
    # 主实体 + 一跳邻居的原文都进入候选：问商品售后时，真正的答案在「退换货政策」文档里
    for slug in primary + linked:
        doc_names.extend(by_slug[slug]["source_docs"])
    doc_names = list(dict.fromkeys(doc_names))[:6]

    return {
        "kb_id": kb_id,
        "query": query,
        "pages": [
            {
                "slug": slug,
                "title": by_slug[slug]["title"],
                "page_type": by_slug[slug]["page_type"],
                "summary": by_slug[slug]["summary"],
                "aliases": by_slug[slug]["aliases"][:6],
                "distance": 0,
                "matched": matched.get(slug),
                "relations": neighbours.get(slug, [])[:6],
            }
            for slug in primary
        ]
        + [
            {
                "slug": slug,
                "title": by_slug[slug]["title"],
                "page_type": by_slug[slug]["page_type"],
                "summary": by_slug[slug]["summary"],
                "aliases": by_slug[slug]["aliases"][:6],
                "distance": 1,
                "matched": None,
                "relations": [],
            }
            for slug in linked
        ],
        "paths": [
            {"from": slug, "from_title": by_slug[slug]["title"], "relation": item["relation"], "to": item["to"], "to_title": item["title"]}
            for slug in primary
            for item in neighbours.get(slug, [])[:4]
        ],
        "context": context,
        "doc_names": doc_names,
    }


async def stats(kb_id: str | None = None) -> dict[str, Any]:
    """控制台概览：页数、边数、别名数、类型分布与入度最高的实体。"""
    pool = await store.get_pool()
    async with pool.acquire() as conn:
        await _ensure_schema(conn)
        where = "WHERE kb_id=$1" if kb_id else ""
        args = [kb_id] if kb_id else []
        page_count = int(await conn.fetchval(f"SELECT count(*) FROM wiki_pages {where}", *args) or 0)
        link_count = int(await conn.fetchval(f"SELECT count(*) FROM wiki_links {where}", *args) or 0)
        alias_count = int(
            await conn.fetchval(
                f"SELECT coalesce(sum(cardinality(aliases)), 0) FROM wiki_pages {where}", *args
            )
            or 0
        )
        doc_count = int(
            await conn.fetchval(
                f"SELECT count(DISTINCT doc) FROM (SELECT unnest(source_docs) AS doc FROM wiki_pages {where}) t",
                *args,
            )
            or 0
        )
        built_at = await conn.fetchval(f"SELECT max(built_at) FROM wiki_pages {where}", *args)
        types = await conn.fetch(
            f"SELECT page_type, count(*) AS pages FROM wiki_pages {where} GROUP BY page_type", *args
        )

        hub_where = "AND l.kb_id=$1" if kb_id else ""
        hubs = await conn.fetch(
            f"""
            SELECT p.title, p.slug, count(*) AS backlinks
            FROM wiki_links l JOIN wiki_pages p ON p.slug = l.target_slug
            WHERE TRUE {hub_where}
            GROUP BY p.title, p.slug
            ORDER BY backlinks DESC, p.title
            LIMIT 6
            """,
            *args,
        )

    return {
        "kb_id": kb_id,
        "pages": page_count,
        "links": link_count,
        "aliases": alias_count,
        "docs": doc_count,
        "types": [{"page_type": row["page_type"], "pages": int(row["pages"])} for row in types],
        "hubs": [
            {"title": row["title"], "slug": row["slug"], "backlinks": int(row["backlinks"])}
            for row in hubs
        ],
        "built_at": built_at.isoformat(sep=" ", timespec="seconds") if built_at else None,
    }


async def list_pages(
    kb_id: str | None = None,
    q: str | None = None,
    page_type: str | None = None,
    limit: int = 100,
) -> list[dict[str, Any]]:
    kb_ids = [kb_id] if kb_id else list(registry.KBS)
    items: list[dict[str, Any]] = []
    for item in kb_ids:
        pages, links = await _load(item)
        incoming: dict[str, int] = {}
        for link in links:
            incoming[link["target_slug"]] = incoming.get(link["target_slug"], 0) + 1
        for page in pages:
            if page_type and page["page_type"] != page_type:
                continue
            if q:
                needle = _norm(q)
                haystack = _norm(" ".join([page["title"], page["summary"] or "", *page["aliases"]]))
                if needle not in haystack:
                    continue
            items.append(
                {
                    "slug": page["slug"],
                    "kb_id": page["kb_id"],
                    "title": page["title"],
                    "page_type": page["page_type"],
                    "summary": page["summary"],
                    "aliases": page["aliases"][:6],
                    "source_docs": page["source_docs"],
                    "backlinks": incoming.get(page["slug"], 0),
                }
            )
    items.sort(key=lambda item: (-item["backlinks"], item["page_type"], item["title"]))
    return items[:limit]


async def get_page(slug: str) -> dict[str, Any] | None:
    pool = await store.get_pool()
    async with pool.acquire() as conn:
        await _ensure_schema(conn)
        row = await conn.fetchrow("SELECT * FROM wiki_pages WHERE slug=$1", slug)
        if row is None:
            return None
        outbound = await conn.fetch(
            """
            SELECT l.target_slug, l.relation, p.title AS target_title, p.page_type AS target_type
            FROM wiki_links l LEFT JOIN wiki_pages p ON p.slug = l.target_slug
            WHERE l.source_slug=$1
            """,
            slug,
        )
        inbound = await conn.fetch(
            """
            SELECT l.source_slug, l.relation, p.title AS source_title, p.page_type AS source_type
            FROM wiki_links l LEFT JOIN wiki_pages p ON p.slug = l.source_slug
            WHERE l.target_slug=$1
            """,
            slug,
        )
    page = dict(row)
    page["aliases"] = list(page["aliases"] or [])
    page["source_docs"] = list(page["source_docs"] or [])
    page["built_at"] = page["built_at"].isoformat(sep=" ", timespec="seconds") if page["built_at"] else None
    return {
        "page": page,
        "links": [dict(item) for item in outbound if item["target_slug"]],
        "backlinks": [dict(item) for item in inbound if item["source_slug"]],
    }


async def graph(kb_id: str | None = None, limit: int = 120) -> dict[str, Any]:
    kb_ids = [kb_id] if kb_id else list(registry.KBS)
    nodes: list[dict[str, Any]] = []
    edges: list[dict[str, Any]] = []
    for item in kb_ids:
        pages, links = await _load(item)
        for page in pages:
            nodes.append(
                {
                    "slug": page["slug"],
                    "title": page["title"],
                    "page_type": page["page_type"],
                    "kb_id": page["kb_id"],
                }
            )
        known = {page["slug"] for page in pages}
        for link in links:
            if link["source_slug"] in known and link["target_slug"] in known:
                edges.append(
                    {
                        "source": link["source_slug"],
                        "target": link["target_slug"],
                        "relation": link["relation"],
                    }
                )
    nodes = nodes[:limit]
    allowed = {node["slug"] for node in nodes}
    edges = [edge for edge in edges if edge["source"] in allowed and edge["target"] in allowed][
        : limit * 2
    ]
    return {"nodes": nodes, "edges": edges}
