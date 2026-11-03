"""评测中台接口：金标数据集、批量跑批、历史对比与用例下钻。

全部接口要求管理员身份；跑批在后台执行，前端轮询 run 状态。
"""

from __future__ import annotations

from datetime import datetime

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Query
from pydantic import BaseModel, Field
from sqlalchemy import func, select

from ..database import SessionLocal
from ..evaluation import dataset_stats, ensure_dataset, execute_run
from ..models import EvalCase, EvalDataset, EvalResult, EvalRun
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


@router.get("/runs/{run_id}")
async def run_detail(run_id: int):
    async with SessionLocal() as db:
        run = (await db.execute(select(EvalRun).where(EvalRun.id == run_id))).scalar_one_or_none()
        if run is None:
            raise HTTPException(status_code=404, detail="评测记录不存在")
        results = (
            await db.execute(
                select(EvalResult)
                .where(EvalResult.run_id == run_id)
                .order_by(EvalResult.case_no)
            )
        ).scalars().all()
    return {
        "run": _run_dict(run, len(results)),
        "results": [
            {
                "case_no": r.case_no,
                "question": r.question,
                "kb_id": r.kb_id,
                "expected_doc": r.expected_doc,
                "retrieved_doc": r.retrieved_doc,
                "rank": r.rank,
                "hit": bool(r.hit),
                "latency_ms": r.latency_ms,
                "degraded": r.degraded,
                "top_docs": r.top_docs,
            }
            for r in results
        ],
    }
