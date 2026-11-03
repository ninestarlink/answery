"""生成质量抽样评测：模型作答 + LLM 裁判。

检索评测只能证明「资料找得到」，这里补上「回答是否忠于资料」这一层：
- 先用检索上下文让对话模型生成客服回答；
- 再让裁判模型按忠实度、相关性、引用正确性输出结构化结论；
- 结果落到 eval_judgment，同一 run 可重复抽样（已评过的用例跳过）。
"""

from __future__ import annotations

import json
import re
import time
from datetime import datetime

import httpx
from sqlalchemy import select

from .config import settings
from .database import SessionLocal
from .models import EvalJudgment, EvalResult, EvalRun
from .rag import retriever

MAX_SAMPLE = 40
# 单进程内防止同一 run 重复触发（页面轮询期间用户连点也不会重复扣费）
RUNNING: set[int] = set()

_ANSWER_SYSTEM = (
    "你是电商与企业客服助手。只能依据给定资料回答，资料没写的不要编造；"
    "回答简洁、分点，并在句末用【文档名】标注依据。资料不足时直接说明「资料中未提及」。"
)

_JUDGE_SYSTEM = (
    "你是严格的评测裁判。判断客服回答是否忠于给定资料、是否切题、引用是否准确。"
    "只输出 JSON，不要解释，格式："
    '{"faithful": true/false, "relevance": 1-5, "citation_ok": true/false, "reason": "20 字内理由"}'
    " faithful 表示回答中的事实是否都能在资料中找到依据；"
    " relevance 表示回答对用户问题的解决程度（1 完全跑题，5 完全解决）；"
    " citation_ok 表示回答引用的来源是否与期望来源一致。"
)


def _headers() -> dict[str, str]:
    return {
        "Authorization": f"Bearer {settings.chat_api_key}",
        "Content-Type": "application/json",
    }


async def _chat(
    client: httpx.AsyncClient,
    messages: list[dict],
    max_tokens: int = 800,
    temperature: float = 0.2,
) -> str:
    payload = {
        "model": settings.chat_model,
        "messages": messages,
        "temperature": temperature,
        "max_tokens": max_tokens,
        "stream": False,
    }
    resp = await client.post(
        f"{settings.chat_api_base.rstrip('/')}/chat/completions",
        headers=_headers(),
        json=payload,
    )
    resp.raise_for_status()
    data = resp.json()
    return (data["choices"][0]["message"]["content"] or "").strip()


def _parse_judgment(text: str) -> dict:
    """裁判输出可能被 ``` 包裹，尽量宽松地取出 JSON。"""
    match = re.search(r"\{.*\}", text, re.S)
    if not match:
        raise ValueError(f"裁判未返回 JSON：{text[:80]}")
    data = json.loads(match.group(0))
    relevance = int(data.get("relevance") or 0)
    return {
        "faithful": 1 if data.get("faithful") is True else 0,
        "relevance": max(0, min(5, relevance)),
        "citation_ok": 1 if data.get("citation_ok") is True else 0,
        "reason": str(data.get("reason") or "")[:255],
    }


def _even_sample(rows: list[EvalResult], need: int) -> list[EvalResult]:
    """按顺序等间隔取样，让不同场景都能覆盖，而不是永远只测前几条。"""
    if need >= len(rows):
        return rows
    step = len(rows) / need
    return [rows[int(i * step)] for i in range(need)]


async def judge_run(run_id: int, sample: int) -> None:
    """后台任务：抽样生成回答并裁判打分。"""
    if run_id in RUNNING:
        return
    RUNNING.add(run_id)
    try:
        async with SessionLocal() as db:
            run = (
                await db.execute(select(EvalRun).where(EvalRun.id == run_id))
            ).scalar_one_or_none()
            if run is None:
                return
            results = (
                await db.execute(
                    select(EvalResult)
                    .where(EvalResult.run_id == run_id)
                    .order_by(EvalResult.case_no)
                )
            ).scalars().all()
            judged = set(
                (
                    await db.execute(
                        select(EvalJudgment.case_id).where(EvalJudgment.run_id == run_id)
                    )
                )
                .scalars()
                .all()
            )

        limit = min(max(1, sample), MAX_SAMPLE)
        need = limit - len(judged)
        if need <= 0:
            return
        targets = _even_sample([r for r in results if r.case_id not in judged], need)
        if not targets:
            return

        async with httpx.AsyncClient(
            timeout=settings.request_timeout, trust_env=False
        ) as client:
            for result in targets:
                started = time.perf_counter()
                judgment = {
                    "faithful": 0,
                    "relevance": 0,
                    "citation_ok": 0,
                    "reason": "",
                }
                answer = ""
                context = ""
                docs: list[str] = []
                try:
                    retrieved = await retriever.search(
                        result.kb_id, result.question, top_k=5, use_rerank=True
                    )
                    context = retrieved.get("context") or ""
                    evidence = retrieved.get("evidence") or []
                    docs = [e["document_name"] for e in evidence]
                    if not context:
                        raise ValueError("检索无可用上下文")
                    answer = await _chat(
                        client,
                        [
                            {"role": "system", "content": _ANSWER_SYSTEM},
                            {
                                "role": "user",
                                "content": (
                                    f"资料：\n{context}\n\n"
                                    f"用户问题：{result.question}\n\n"
                                    "请依据资料作答并标注来源。"
                                ),
                            },
                        ],
                    )
                    judged_text = await _chat(
                        client,
                        [
                            {"role": "system", "content": _JUDGE_SYSTEM},
                            {
                                "role": "user",
                                "content": (
                                    f"用户问题：{result.question}\n"
                                    f"期望来源：{result.expected_doc}\n"
                                    f"实际召回：{', '.join(docs) or '无'}\n"
                                    f"资料：\n{context[:2200]}\n\n"
                                    f"客服回答：\n{answer[:1200]}"
                                ),
                            },
                        ],
                        max_tokens=300,
                        temperature=0.1,
                    )
                    judgment = _parse_judgment(judged_text)
                except Exception as exc:  # 单条失败不中断抽样，留痕便于复盘
                    judgment = {
                        **judgment,
                        "reason": f"评测异常：{exc}"[:255],
                    }

                latency = int((time.perf_counter() - started) * 1000)
                verdict = (
                    "pass"
                    if judgment["faithful"]
                    and judgment["citation_ok"]
                    and judgment["relevance"] >= 3
                    else "fail"
                )
                async with SessionLocal() as db:
                    existing = (
                        await db.execute(
                            select(EvalJudgment).where(
                                EvalJudgment.run_id == run_id,
                                EvalJudgment.case_id == result.case_id,
                            )
                        )
                    ).scalar_one_or_none()
                    if existing is None:
                        db.add(
                            EvalJudgment(
                                run_id=run_id,
                                case_id=result.case_id,
                                case_no=result.case_no,
                                question=result.question,
                                answer=answer[:4000] or "（生成失败）",
                                context_docs=", ".join(docs)[:255] or None,
                                faithful=judgment["faithful"],
                                relevance=judgment["relevance"],
                                citation_ok=judgment["citation_ok"],
                                verdict=verdict,
                                reason=judgment["reason"] or None,
                                latency_ms=latency,
                                created_at=datetime.now(),
                            )
                        )
                        await db.commit()
    finally:
        RUNNING.discard(run_id)


async def judgment_stats(run_id: int) -> dict:
    """聚合抽样结果：前端只关心几个通过率 + 失败原因。"""
    async with SessionLocal() as db:
        rows = (
            await db.execute(
                select(EvalJudgment)
                .where(EvalJudgment.run_id == run_id)
                .order_by(EvalJudgment.case_no)
            )
        ).scalars().all()
    total = len(rows)
    passed = sum(1 for r in rows if r.verdict == "pass")
    faithful = sum(r.faithful for r in rows)
    citation = sum(r.citation_ok for r in rows)
    relevance = [r.relevance for r in rows if r.relevance > 0]
    return {
        "run_id": run_id,
        "total": total,
        "pass_count": passed,
        "fail_count": total - passed,
        "pass_rate": round(passed / total, 4) if total else 0.0,
        "grounded_rate": round(faithful / total, 4) if total else 0.0,
        "citation_rate": round(citation / total, 4) if total else 0.0,
        "avg_relevance": round(sum(relevance) / len(relevance), 2) if relevance else 0.0,
        "avg_latency_ms": int(sum(r.latency_ms for r in rows) / total) if total else 0,
        "running": run_id in RUNNING,
        "rows": [
            {
                "case_no": r.case_no,
                "question": r.question,
                "answer": r.answer,
                "context_docs": r.context_docs,
                "faithful": bool(r.faithful),
                "relevance": r.relevance,
                "citation_ok": bool(r.citation_ok),
                "verdict": r.verdict,
                "reason": r.reason,
                "latency_ms": r.latency_ms,
                "created_at": r.created_at.isoformat(sep=" ", timespec="seconds")
                if r.created_at
                else None,
            }
            for r in rows
        ],
    }
