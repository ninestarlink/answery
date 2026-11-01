"""索引构建 CLI：解析源文件 → 父子切片 → 向量化 → 写入 pgvector。

用法：
    python -m app.rag.ingest --kb all
    python -m app.rag.ingest --kb enterprise --force
"""

from __future__ import annotations

import argparse
import asyncio
import logging
import time

from . import registry, retriever, store, zhipu
from .chunker import chunk_doc
from .parser import parse_file

logger = logging.getLogger("rag.ingest")


async def ingest_kb(kb_id: str, force: bool = False) -> dict:
    kb = registry.get_kb(kb_id)
    if not kb:
        raise ValueError(f"未知知识库：{kb_id}")

    summary = {
        "kb_id": kb_id,
        "docs": 0,
        "skipped": 0,
        "parents": 0,
        "children": 0,
        "pruned": 0,
        "degraded": False,
        "errors": [],
    }
    doc_ids: list[str] = []
    for path in kb.paths:
        started = time.perf_counter()
        try:
            doc = parse_file(path)
        except Exception as exc:  # 单个文件解析失败不阻断整库构建
            logger.warning("解析失败 %s：%s", path.name, exc)
            summary["errors"].append(f"{path.name}: {exc}")
            continue

        existing = await store.get_document_hash(kb_id, doc.doc_id)
        doc_ids.append(doc.doc_id)
        if existing and existing == doc.file_hash and not force:
            logger.info("跳过未变更文档：%s", path.name)
            summary["skipped"] += 1
            continue

        parents, children = chunk_doc(doc)
        if not children:
            summary["errors"].append(f"{path.name}: 未切出有效分片")
            continue

        try:
            vectors = await zhipu.embed_texts([c.content for c in children])
        except zhipu.ZhipuError as exc:
            # embedding 额度不可用时仍然建好关键词索引，检索退化而不是整库失败
            logger.warning("向量化不可用，%s 仅建立关键词索引：%s", path.name, exc)
            vectors = None
            summary["degraded"] = True

        await store.replace_document(kb_id, doc, parents, children, vectors)
        summary["docs"] += 1
        summary["parents"] += len(parents)
        summary["children"] += len(children)
        logger.info(
            "已入库 %s（%d 父块 / %d 子块，%.1fs）",
            path.name,
            len(parents),
            len(children),
            time.perf_counter() - started,
        )

    summary["pruned"] = await store.prune_documents(kb_id, doc_ids)
    retriever.invalidate_cache(kb_id)
    return summary


async def _main() -> None:
    parser = argparse.ArgumentParser(description="构建知识库索引")
    parser.add_argument("--kb", default="all", help="shop / enterprise / all")
    parser.add_argument("--force", action="store_true", help="忽略文件哈希，强制重建")
    args = parser.parse_args()

    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s - %(message)s")
    targets = list(registry.KBS) if args.kb == "all" else [args.kb]
    for kb_id in targets:
        summary = await ingest_kb(kb_id, force=args.force)
        print(f"[{kb_id}] 入库 {summary['docs']} 篇，跳过 {summary['skipped']} 篇，"
              f"父块 {summary['parents']}，子块 {summary['children']}")
        if summary["errors"]:
            print(f"[{kb_id}] 失败：{summary['errors']}")
    await store.close_pool()


if __name__ == "__main__":
    asyncio.run(_main())
