"""检索评测：固定问题集 + 期望文档，输出 Recall@k 与 MRR。

用途：改切片、改检索参数后，用同一套问题回归，避免「感觉变好了」。
用法（在 backend/ 下）：
    $env:PYTHONPATH="."; python scripts/eval_retrieval.py
    $env:PYTHONPATH="."; python scripts/eval_retrieval.py --list   # 先看库里有哪些文档名
"""

from __future__ import annotations

import argparse
import asyncio
import sys

from app.rag import retriever, store

# (kb_id, 问题, 期望文档名关键字, 期望章节关键字)  —— 章节为空表示只校验文档
CASES: list[tuple[str, str, str, str]] = [
    ("enterprise", "新员工入职第一年有几天年假？", "员工手册", "假期"),
    ("enterprise", "试用期多久，转正要走什么流程？", "员工手册", "入职"),
    ("enterprise", "出差去上海住一晚，住宿标准是多少？", "差旅报销", "住宿"),
    ("enterprise", "出差可以坐高铁一等座吗？交通标准怎么算？", "差旅报销", "交通"),
    ("enterprise", "供应商分级标准和账期是怎么规定的？", "采购", "供应商分级"),
    ("enterprise", "采购金额多少需要走招投标流程？", "采购", ""),
    ("enterprise", "公司账号密码多久需要更换一次？", "信息安全", "密码"),
    ("enterprise", "发生数据泄露应该怎么上报？", "信息安全", "事件"),
    ("enterprise", "客户投诉多久要升级到主管？", "客服升级", ""),
    ("enterprise", "供应商清单在哪里查看？", "报销标准", ""),
    ("shop", "哪款跑鞋缓震好，适合日常跑步？", "products", ""),
    ("shop", "预算 500 元以内有什么鞋推荐？", "products", ""),
    ("shop", "适合实战的篮球鞋有哪些？", "products", ""),
]


async def list_docs() -> None:
    for kb_id in ("enterprise", "shop"):
        print(f"\n[{kb_id}]")
        for row in await store.list_documents(kb_id):
            print(
                f"  {row['doc_name']}｜{row.get('doc_no') or '-'}｜"
                f"{row.get('child_count')} 子块 / {row.get('parent_count')} 父块"
            )


def _relevant(hit: dict, doc: str, section: str) -> bool:
    if doc not in (hit.get("doc_name") or ""):
        return False
    return section in (hit.get("section") or "") if section else True


async def run(top_k: int = 5) -> int:
    rows: list[dict] = []
    for kb_id, question, doc, section in CASES:
        try:
            result = await retriever.search(kb_id, question, top_k=top_k)
        except Exception as exc:  # 向量库没起来时直接暴露原因
            print(f"检索失败：{kb_id} / {question} → {exc}", file=sys.stderr)
            return 1

        hits = result["hits"]
        rank = next(
            (i for i, h in enumerate(hits, start=1) if _relevant(h, doc, section)),
            None,
        )
        rows.append(
            {
                "kb": kb_id,
                "question": question,
                "doc": doc,
                "rank": rank,
                "top1": (hits[0].get("doc_name") if hits else "-") or "-",
                "degraded": bool(result["degraded"]),
            }
        )

    print(f"{'KB':<11}{'命中':<6}{'问题':<40}{'期望文档':<16}Top1 实际")
    print("-" * 96)
    for r in rows:
        rank_label = f"#{r['rank']}" if r["rank"] else "未命中"
        print(
            f"{r['kb']:<11}{rank_label:<6}"
            f"{r['question'][:38]:<40}{r['doc']:<16}{r['top1']}"
        )

    total = len(rows)
    for k in (1, 3, 5):
        hit = sum(1 for r in rows if r["rank"] and r["rank"] <= k)
        print(f"Recall@{k}: {hit}/{total} = {hit / total:.1%}")
    mrr = sum(1.0 / r["rank"] for r in rows if r["rank"]) / total
    print(f"MRR: {mrr:.3f}")
    degraded = sum(1 for r in rows if r["degraded"])
    if degraded:
        print(f"注意：{degraded}/{total} 条为降级检索（embedding/rerank 不可用，仅 BM25）")
    return 0 if all(r["rank"] for r in rows) else 2


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--list", action="store_true", help="只打印知识库文档清单")
    parser.add_argument("--top-k", type=int, default=5)
    args = parser.parse_args()
    raise SystemExit(asyncio.run(list_docs() if args.list else run(args.top_k)))
