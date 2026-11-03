"""评测中台接口：金标数据集、批量跑批、历史对比与用例下钻。

全部接口要求管理员身份；跑批在后台执行，前端轮询 run 状态。
"""

from __future__ import annotations

import csv
import io
from datetime import datetime

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Query
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field
from sqlalchemy import delete, func, select

from ..config import settings
from ..database import SessionLocal
from ..eval_judge import judge_run, judgment_stats
from ..eval_metrics import summarize
from ..evaluation import dataset_stats, ensure_dataset, execute_run
from ..models import (
    ChatTrace,
    EvalCase,
    EvalCaseReview,
    EvalDataset,
    EvalJudgment,
    EvalResult,
    EvalRun,
)
from .auth import require_admin

router = APIRouter(
    prefix="/api/admin/eval", tags=["eval"], dependencies=[Depends(require_admin)]
)


def _dt(value: datetime | None) -> str | None:
    return value.isoformat(sep=" ", timespec="seconds") if value else None


def _run_dict(run: EvalRun, progress: int = 0) -> dict:
    return {
        "id": run.id,
        "dataset_id": run.dataset_id,
        "status": run.status,
        "engine": run.engine,
        "top_k": run.top_k,
        "case_count": run.case_count,
        "hit_count": run.hit_count,
        "hit_rate": run.hit_rate,
        "mrr": run.mrr,
        "avg_latency_ms": run.avg_latency_ms,
        "p95_latency_ms": run.p95_latency_ms,
        "degraded_count": run.degraded_count,
        "note": run.note,
        "error": run.error,
        "progress": progress,
        "started_at": _dt(run.started_at),
        "finished_at": _dt(run.finished_at),
    }


class RunRequest(BaseModel):
    dataset_id: int | None = None
    top_k: int = Field(default=5, ge=1, le=10)
    note: str | None = Field(default=None, max_length=120)


class ReviewRequest(BaseModel):
    status: str = Field(pattern="^(open|fixed|ignored)$")
    note: str | None = Field(default=None, max_length=255)


class JudgeRequest(BaseModel):
    sample: int = Field(default=10, ge=1, le=40)


class CasePayload(BaseModel):
    case_no: str = Field(min_length=1, max_length=16)
    question: str = Field(min_length=1, max_length=255)
    kb_id: str = Field(pattern="^(shop|enterprise)$")
    expected_doc: str = Field(min_length=1, max_length=128)
    expected_keywords: str | None = Field(default=None, max_length=255)
    category: str = Field(default="未分类", min_length=1, max_length=32)
    difficulty: str = Field(default="normal", pattern="^(easy|normal|hard)$")


class ImportRequest(BaseModel):
    csv: str = Field(min_length=1, max_length=200_000)


def _case_dict(case: EvalCase) -> dict:
    return {
        "id": case.id,
        "case_no": case.case_no,
        "question": case.question,
        "kb_id": case.kb_id,
        "expected_doc": case.expected_doc,
        "expected_keywords": case.expected_keywords,
        "category": case.category,
        "difficulty": case.difficulty,
    }


@router.get("/overview")
async def overview():
    """评测首页：数据集规模、最近两次运行与历史列表。"""
    stats = await dataset_stats()
    if stats["id"] is None:
        # 新环境首次打开评测页时自动写入金标集，避免空白页
        await ensure_dataset()
        stats = await dataset_stats()
    async with SessionLocal() as db:
        dataset = (
            await db.execute(select(EvalDataset).where(EvalDataset.code == "golden-v1"))
        ).scalar_one_or_none()
        runs = (
            await db.execute(
                select(EvalRun).order_by(EvalRun.id.desc()).limit(12)
            )
        ).scalars().all()
        completed = [r for r in runs if r.status == "completed"]
        latest = completed[0] if completed else None
        previous = completed[1] if len(completed) > 1 else None

        progress = 0
        if runs and runs[0].status == "running":
            progress = int(
                await db.scalar(
                    select(func.count())
                    .select_from(EvalResult)
                    .where(EvalResult.run_id == runs[0].id)
                )
                or 0
            )

        return {
            "dataset": {
                "id": dataset.id if dataset else stats["id"],
                "name": dataset.name if dataset else "",
                "code": dataset.code if dataset else "",
                "description": dataset.description if dataset else "",
                "cases": stats["cases"],
                "categories": stats["categories"],
            },
            "latest": _run_dict(latest) if latest else None,
            "previous": _run_dict(previous) if previous else None,
            "running": _run_dict(runs[0], int(progress)) if runs and runs[0].status == "running" else None,
            "runs": [_run_dict(r) for r in runs],
        }


@router.get("/datasets/{dataset_id}/cases")
async def dataset_cases(dataset_id: int):
    async with SessionLocal() as db:
        dataset = (
            await db.execute(select(EvalDataset).where(EvalDataset.id == dataset_id))
        ).scalar_one_or_none()
        if dataset is None:
            raise HTTPException(status_code=404, detail="数据集不存在")
        cases = (
            await db.execute(
                select(EvalCase)
                .where(EvalCase.dataset_id == dataset_id)
                .order_by(EvalCase.case_no)
            )
        ).scalars().all()
    return {
        "dataset": {
            "id": dataset.id,
            "code": dataset.code,
            "name": dataset.name,
            "description": dataset.description,
        },
        "cases": [
            {
                "id": c.id,
                "case_no": c.case_no,
                "question": c.question,
                "kb_id": c.kb_id,
                "expected_doc": c.expected_doc,
                "expected_keywords": c.expected_keywords,
                "category": c.category,
                "difficulty": c.difficulty,
            }
            for c in cases
        ],
    }


@router.post("/runs")
async def create_run(payload: RunRequest, tasks: BackgroundTasks):
    dataset_id = payload.dataset_id or await ensure_dataset()
    async with SessionLocal() as db:
        dataset = (
            await db.execute(select(EvalDataset).where(EvalDataset.id == dataset_id))
        ).scalar_one_or_none()
        if dataset is None:
            raise HTTPException(status_code=404, detail="数据集不存在")
        active = (
            await db.execute(
                select(EvalRun).where(EvalRun.status == "running").limit(1)
            )
        ).scalar_one_or_none()
        if active is not None:
            raise HTTPException(status_code=409, detail="已有评测正在运行")
        run = EvalRun(
            dataset_id=dataset_id,
            status="running",
            engine="hybrid+rerank",
            top_k=payload.top_k,
            note=payload.note,
        )
        db.add(run)
        await db.commit()
        await db.refresh(run)

    tasks.add_task(execute_run, run.id, payload.top_k)
    return _run_dict(run)


@router.get("/runs")
async def list_runs(limit: int = Query(default=12, ge=1, le=50)):
    async with SessionLocal() as db:
        runs = (
            await db.execute(select(EvalRun).order_by(EvalRun.id.desc()).limit(limit))
        ).scalars().all()
    return {"runs": [_run_dict(r) for r in runs]}


def _category_rows(rows: list[tuple[EvalResult, str]]) -> list[dict]:
    """按场景切片汇总：主流评测平台都会看分片指标，避免整体分数掩盖短板。"""
    groups: dict[str, dict] = {}
    for result, category in rows:
        group = groups.setdefault(category, {"ranks": [], "latencies": []})
        group["ranks"].append(result.rank)
        group["latencies"].append(result.latency_ms)
    output = []
    for category, group in groups.items():
        metrics = summarize(group["ranks"], group["latencies"])
        output.append({"category": category, **metrics})
    return sorted(output, key=lambda item: (-item["case_count"], item["category"]))


async def _load_results(db, run_id: int) -> list[tuple[EvalResult, str]]:
    rows = await db.execute(
        select(EvalResult, EvalCase.category)
        .join(EvalCase, EvalCase.id == EvalResult.case_id)
        .where(EvalResult.run_id == run_id)
        .order_by(EvalResult.case_no)
    )
    return [(row[0], row[1]) for row in rows.all()]


@router.get("/runs/{run_id}")
async def run_detail(run_id: int):
    async with SessionLocal() as db:
        run = (await db.execute(select(EvalRun).where(EvalRun.id == run_id))).scalar_one_or_none()
        if run is None:
            raise HTTPException(status_code=404, detail="评测记录不存在")
        rows = await _load_results(db, run_id)
        reviews = {
            r.case_id: r
            for r in (
                await db.execute(
                    select(EvalCaseReview).where(
                        EvalCaseReview.case_id.in_([row[0].case_id for row in rows] or [0])
                    )
                )
            ).scalars().all()
        }
    return {
        "run": _run_dict(run, len(rows)),
        "categories": _category_rows(rows),
        "results": [
            {
                "case_id": r.case_id,
                "case_no": r.case_no,
                "question": r.question,
                "category": category,
                "kb_id": r.kb_id,
                "expected_doc": r.expected_doc,
                "retrieved_doc": r.retrieved_doc,
                "rank": r.rank,
                "hit": bool(r.hit),
                "latency_ms": r.latency_ms,
                "degraded": r.degraded,
                "top_docs": r.top_docs,
                "review_status": reviews.get(r.case_id).status if r.case_id in reviews else "open",
                "review_note": reviews.get(r.case_id).note if r.case_id in reviews else None,
            }
            for r, category in rows
        ],
    }


@router.get("/runs/{run_id}/compare")
async def compare_run(run_id: int, baseline_id: int = Query(...)):
    """A/B 对比：整体 delta + 分片 delta + 逐条用例的提升/退化清单。"""
    if run_id == baseline_id:
        raise HTTPException(status_code=400, detail="基线不能与当前 run 相同")
    async with SessionLocal() as db:
        runs = {
            r.id: r
            for r in (
                await db.execute(
                    select(EvalRun).where(EvalRun.id.in_([run_id, baseline_id]))
                )
            ).scalars().all()
        }
        if run_id not in runs or baseline_id not in runs:
            raise HTTPException(status_code=404, detail="评测记录不存在")
        current_rows = await _load_results(db, run_id)
        base_rows = await _load_results(db, baseline_id)

    current = {r.case_no: (r, cat) for r, cat in current_rows}
    baseline = {r.case_no: (r, cat) for r, cat in base_rows}
    cases = []
    improved = regressed = 0
    for case_no in sorted(set(current) | set(baseline)):
        cur, cat = current.get(case_no, (None, None))
        old, _ = baseline.get(case_no, (None, None))
        if cur is None or old is None:
            continue
        if cur.hit and not old.hit:
            status, improved = "improved", improved + 1
        elif old.hit and not cur.hit:
            status, regressed = "regressed", regressed + 1
        else:
            status = "same"
        cases.append(
            {
                "case_no": case_no,
                "category": cat,
                "question": cur.question,
                "baseline_hit": bool(old.hit),
                "current_hit": bool(cur.hit),
                "baseline_rank": old.rank,
                "current_rank": cur.rank,
                "delta_latency_ms": cur.latency_ms - old.latency_ms,
                "status": status,
            }
        )

    base_by_cat = {item["category"]: item for item in _category_rows(base_rows)}
    cur_by_cat = {item["category"]: item for item in _category_rows(current_rows)}
    categories = []
    for category in sorted(set(base_by_cat) | set(cur_by_cat)):
        base = base_by_cat.get(category, {})
        cur = cur_by_cat.get(category, {})
        categories.append(
            {
                "category": category,
                "baseline_hit_rate": base.get("hit_rate", 0),
                "current_hit_rate": cur.get("hit_rate", 0),
                "delta_hit_rate": round(
                    cur.get("hit_rate", 0) - base.get("hit_rate", 0), 4
                ),
                "delta_mrr": round(cur.get("mrr", 0) - base.get("mrr", 0), 4),
            }
        )

    base_run, cur_run = runs[baseline_id], runs[run_id]
    return {
        "baseline": _run_dict(base_run),
        "current": _run_dict(cur_run),
        "delta": {
            "hit_rate": round(cur_run.hit_rate - base_run.hit_rate, 4),
            "mrr": round(cur_run.mrr - base_run.mrr, 4),
            "p95_latency_ms": cur_run.p95_latency_ms - base_run.p95_latency_ms,
        },
        "counts": {"improved": improved, "regressed": regressed, "same": len(cases) - improved - regressed},
        "categories": categories,
        "cases": cases,
    }


@router.get("/runs/{run_id}/export")
async def export_run(run_id: int):
    """导出 CSV：带 BOM，Excel 直接打开不乱码。"""
    async with SessionLocal() as db:
        run = (await db.execute(select(EvalRun).where(EvalRun.id == run_id))).scalar_one_or_none()
        if run is None:
            raise HTTPException(status_code=404, detail="评测记录不存在")
        rows = await _load_results(db, run_id)
        reviews = {
            r.case_id: r
            for r in (
                await db.execute(
                    select(EvalCaseReview).where(
                        EvalCaseReview.case_id.in_([row[0].case_id for row in rows] or [0])
                    )
                )
            ).scalars().all()
        }

    buffer = io.StringIO()
    buffer.write("\ufeff")
    writer = csv.writer(buffer)
    writer.writerow(
        ["编号", "场景", "问题", "期望来源", "Top1 实际", "首中位次", "命中", "耗时(ms)", "复盘状态", "复盘备注", "TopK 来源"]
    )
    for result, category in rows:
        review = reviews.get(result.case_id)
        writer.writerow(
            [
                result.case_no,
                category,
                result.question,
                result.expected_doc,
                result.retrieved_doc or "",
                result.rank,
                "HIT" if result.hit else "MISS",
                result.latency_ms,
                review.status if review else "open",
                (review.note or "") if review else "",
                result.top_docs or "",
            ]
        )
    return StreamingResponse(
        iter([buffer.getvalue()]),
        media_type="text/csv; charset=utf-8",
        headers={"Content-Disposition": f'attachment; filename="eval-run-{run_id}.csv"'},
    )


@router.post("/cases/{case_id}/review")
async def review_case(case_id: int, payload: ReviewRequest):
    """人工复盘：标记用例待复盘/已修复/忽略，跨 run 保留。"""
    async with SessionLocal() as db:
        case = (await db.execute(select(EvalCase).where(EvalCase.id == case_id))).scalar_one_or_none()
        if case is None:
            raise HTTPException(status_code=404, detail="用例不存在")
        review = (
            await db.execute(select(EvalCaseReview).where(EvalCaseReview.case_id == case_id))
        ).scalar_one_or_none()
        if review is None:
            review = EvalCaseReview(case_id=case_id, status=payload.status, note=payload.note)
            db.add(review)
        else:
            review.status = payload.status
            review.note = payload.note
        await db.commit()
    return {"case_id": case_id, "status": payload.status, "note": payload.note}


# ------------------------------------------------------------------
# 生成质量评测（LLM-as-judge）
# ------------------------------------------------------------------


@router.post("/runs/{run_id}/judge")
async def start_judge(run_id: int, payload: JudgeRequest, tasks: BackgroundTasks):
    """对已完成的 run 抽样：生成回答 + 裁判打分，结果轮询获取。"""
    if not settings.chat_api_key:
        raise HTTPException(status_code=400, detail="未配置对话模型 API Key，无法做生成质量评测")
    async with SessionLocal() as db:
        run = (await db.execute(select(EvalRun).where(EvalRun.id == run_id))).scalar_one_or_none()
        if run is None:
            raise HTTPException(status_code=404, detail="评测记录不存在")
        if run.status != "completed":
            raise HTTPException(status_code=409, detail="请等待检索评测完成后再做生成评测")
        judged = int(
            await db.scalar(
                select(func.count())
                .select_from(EvalJudgment)
                .where(EvalJudgment.run_id == run_id)
            )
            or 0
        )
    tasks.add_task(judge_run, run_id, payload.sample)
    return {"run_id": run_id, "sample": payload.sample, "existing": judged, "status": "running"}


@router.get("/runs/{run_id}/judgments")
async def run_judgments(run_id: int):
    async with SessionLocal() as db:
        run = (await db.execute(select(EvalRun).where(EvalRun.id == run_id))).scalar_one_or_none()
        if run is None:
            raise HTTPException(status_code=404, detail="评测记录不存在")
    return await judgment_stats(run_id)


# ------------------------------------------------------------------
# 数据集维护：在线增删改用例 + CSV 导入
# ------------------------------------------------------------------

_CSV_FIELDS = {
    "case_no": "case_no",
    "编号": "case_no",
    "question": "question",
    "问题": "question",
    "kb_id": "kb_id",
    "知识库": "kb_id",
    "expected_doc": "expected_doc",
    "期望来源": "expected_doc",
    "expected_keywords": "expected_keywords",
    "答案要点": "expected_keywords",
    "category": "category",
    "场景": "category",
    "difficulty": "difficulty",
    "难度": "difficulty",
}


def _difficulty(value: str | None) -> str:
    text = (value or "").strip().lower()
    return {"简单": "easy", "普通": "normal", "困难": "hard"}.get(text, text or "normal")


def _parse_row(row: dict[str, str]) -> tuple[dict | None, str | None]:
    """校验 CSV 一行，返回规范化字段或错误信息。"""
    case_no = (row.get("case_no") or "").strip()
    question = (row.get("question") or "").strip()
    kb_id = (row.get("kb_id") or "").strip()
    expected_doc = (row.get("expected_doc") or "").strip()
    if not case_no:
        return None, "缺少编号"
    if len(case_no) > 16:
        return None, "编号超过 16 字符"
    if not question:
        return None, "缺少问题"
    if len(question) > 255:
        return None, "问题超过 255 字符"
    if kb_id not in {"shop", "enterprise"}:
        return None, "kb_id 只能是 shop/enterprise"
    if not expected_doc:
        return None, "缺少期望来源"
    if len(expected_doc) > 128:
        return None, "期望来源超过 128 字符"
    difficulty = _difficulty(row.get("difficulty"))
    if difficulty not in {"easy", "normal", "hard"}:
        return None, "difficulty 只能是 easy/normal/hard"
    return (
        {
            "case_no": case_no,
            "question": question,
            "kb_id": kb_id,
            "expected_doc": expected_doc,
            "expected_keywords": (row.get("expected_keywords") or "").strip()[:255] or None,
            "category": (row.get("category") or "").strip()[:32] or "未分类",
            "difficulty": difficulty,
        },
        None,
    )


async def _assert_case_no_free(db, dataset_id: int, case_no: str, exclude_id: int | None = None) -> None:
    query = select(EvalCase).where(
        EvalCase.dataset_id == dataset_id, EvalCase.case_no == case_no
    )
    if exclude_id:
        query = query.where(EvalCase.id != exclude_id)
    exists = (await db.execute(query.limit(1))).scalar_one_or_none()
    if exists is not None:
        raise HTTPException(status_code=409, detail=f"用例编号 {case_no} 已存在")


@router.post("/datasets/{dataset_id}/cases")
async def create_case(dataset_id: int, payload: CasePayload):
    async with SessionLocal() as db:
        dataset = (
            await db.execute(select(EvalDataset).where(EvalDataset.id == dataset_id))
        ).scalar_one_or_none()
        if dataset is None:
            raise HTTPException(status_code=404, detail="数据集不存在")
        await _assert_case_no_free(db, dataset_id, payload.case_no)
        case = EvalCase(dataset_id=dataset_id, **payload.model_dump())
        db.add(case)
        await db.commit()
        await db.refresh(case)
    return _case_dict(case)


@router.put("/cases/{case_id}")
async def update_case(case_id: int, payload: CasePayload):
    async with SessionLocal() as db:
        case = (await db.execute(select(EvalCase).where(EvalCase.id == case_id))).scalar_one_or_none()
        if case is None:
            raise HTTPException(status_code=404, detail="用例不存在")
        await _assert_case_no_free(db, case.dataset_id, payload.case_no, exclude_id=case_id)
        for key, value in payload.model_dump().items():
            setattr(case, key, value)
        await db.commit()
        await db.refresh(case)
    return _case_dict(case)


@router.delete("/cases/{case_id}")
async def delete_case(case_id: int):
    """删除用例并清理关联结果；历史 run 的汇总指标保持不变。"""
    async with SessionLocal() as db:
        case = (await db.execute(select(EvalCase).where(EvalCase.id == case_id))).scalar_one_or_none()
        if case is None:
            raise HTTPException(status_code=404, detail="用例不存在")
        await db.execute(delete(EvalResult).where(EvalResult.case_id == case_id))
        await db.execute(delete(EvalCaseReview).where(EvalCaseReview.case_id == case_id))
        await db.execute(delete(EvalJudgment).where(EvalJudgment.case_id == case_id))
        await db.delete(case)
        await db.commit()
    return {"deleted": case_id}


@router.post("/datasets/{dataset_id}/cases/import")
async def import_cases(dataset_id: int, payload: ImportRequest):
    """CSV 导入：表头支持中英文，按 case_no 覆盖更新，失败行不阻断整批。"""
    async with SessionLocal() as db:
        dataset = (
            await db.execute(select(EvalDataset).where(EvalDataset.id == dataset_id))
        ).scalar_one_or_none()
        if dataset is None:
            raise HTTPException(status_code=404, detail="数据集不存在")

        rows = list(csv.reader(io.StringIO(payload.csv.lstrip("\ufeff"))))
        if not rows:
            raise HTTPException(status_code=400, detail="CSV 为空")
        header = [_CSV_FIELDS.get(h.strip().lower()) for h in rows[0]]
        if "case_no" not in header or "question" not in header:
            raise HTTPException(
                status_code=400,
                detail="首行必须为表头，且至少包含 case_no / question",
            )

        existing = {
            c.case_no: c
            for c in (
                await db.execute(select(EvalCase).where(EvalCase.dataset_id == dataset_id))
            ).scalars().all()
        }
        created = updated = 0
        errors: list[str] = []
        for index, raw in enumerate(rows[1:], start=2):
            if not any(cell.strip() for cell in raw):
                continue
            record = {
                header[i]: raw[i]
                for i in range(min(len(header), len(raw)))
                if header[i]
            }
            values, error = _parse_row(record)
            if error:
                errors.append(f"第 {index} 行：{error}")
                continue
            case = existing.get(values["case_no"])
            if case is None:
                case = EvalCase(dataset_id=dataset_id, **values)
                db.add(case)
                existing[values["case_no"]] = case
                created += 1
            else:
                for key, value in values.items():
                    setattr(case, key, value)
                updated += 1
        await db.commit()

    return {
        "created": created,
        "updated": updated,
        "failed": len(errors),
        "errors": errors[:10],
    }


@router.get("/candidates")
async def online_candidates(limit: int = Query(default=12, ge=1, le=50)):
    """线上抽样：从 chat_trace 找尚未入库的真实问题，一键回灌金标集。"""
    async with SessionLocal() as db:
        known = {
            (q or "").strip().lower()
            for q in (await db.execute(select(EvalCase.question))).scalars().all()
        }
        traces = (
            await db.execute(
                select(ChatTrace).order_by(ChatTrace.id.desc()).limit(limit * 6)
            )
        ).scalars().all()

    items: list[dict] = []
    seen: set[str] = set()
    for trace in traces:
        question = (trace.question or "").strip()
        key = question.lower()
        if not question or key in known or key in seen:
            continue
        seen.add(key)
        kb_id = "enterprise" if (trace.app or "").lower() == "enterprise" else "shop"
        items.append(
            {
                "id": trace.id,
                "question": question,
                "app": trace.app,
                "kb_id": kb_id,
                "category": "商品咨询" if kb_id == "shop" else "制度咨询",
                "status": trace.status,
                "hits": trace.hits,
                "tools": trace.tools,
                "degraded": trace.degraded,
                "created_at": _dt(trace.created_at),
            }
        )
        if len(items) >= limit:
            break
    return {"candidates": items, "existing": len(known)}

