"""轻量自动化：进程内定时任务 + 运行历史。

这里没有工作流引擎：任务在代码里注册，调度只依赖 APScheduler，
每次执行写一行 automation_runs。幂等键由数据库唯一索引兜底，
重复触发（例如两次定时落在同一分钟、手动点了两下）不会重复执行。
"""

from __future__ import annotations

import hashlib
import logging
import time
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from datetime import date, datetime, timedelta
from pathlib import Path

from apscheduler.schedulers.asyncio import AsyncIOScheduler
from apscheduler.triggers.cron import CronTrigger
from sqlalchemy import func, select, update
from sqlalchemy.exc import IntegrityError

from ..database import SessionLocal, engine
from ..models import AutomationRun, Ticket

logger = logging.getLogger("automation")

# 知识库源文件目录（与 ingest 同源，按文件位置推导）
_ROOT = Path(__file__).resolve().parents[3]
KB_DIRS = {"shop": _ROOT / "shop_kb", "enterprise": _ROOT / "enterprise_kb"}
KB_SUFFIXES = {".md", ".pdf", ".docx", ".xlsx"}

# 工单超时阈值：创建或更新超过 24 小时仍未处理完
STALE_HOURS = 24
# 评测固定用 TopK=5，与评测中台默认值一致
EVAL_TOP_K = 5

Runner = Callable[[], Awaitable[dict]]


@dataclass(frozen=True)
class JobSpec:
    key: str
    name: str
    # crontab 五段式：分 时 日 月 周；按后端进程本地时区解释
    schedule: str
    schedule_label: str
    description: str
    runner: Runner
    idempotency: Callable[[], str]


JOBS: dict[str, JobSpec] = {}
_scheduler: AsyncIOScheduler | None = None


def _register(job: JobSpec) -> None:
    JOBS[job.key] = job


# ------------------------------------------------------------------
# 任务实现
# ------------------------------------------------------------------


def _kb_digest(kb_id: str) -> str:
    """按文件名 + 大小 + 修改时间生成知识库指纹，避免每 10 分钟重复读全文。"""
    root = KB_DIRS[kb_id]
    digest = hashlib.sha1()
    if root.exists():
        for path in sorted(root.rglob("*")):
            if not path.is_file() or path.suffix.lower() not in KB_SUFFIXES:
                continue
            stat = path.stat()
            digest.update(
                f"{path.relative_to(root).as_posix()}:{stat.st_size}:{stat.st_mtime_ns};".encode()
            )
    return digest.hexdigest()[:12]


def _kb_sync_idempotency() -> str:
    return f"kb_sync:{_kb_digest('shop')}-{_kb_digest('enterprise')}"


async def _run_kb_sync() -> dict:
    from ..rag import ingest

    results = []
    for kb_id in KB_DIRS:
        results.append(await ingest.ingest_kb(kb_id))

    return {
        "changed_docs": sum(r["docs"] for r in results),
        "skipped_docs": sum(r["skipped"] for r in results),
        "children": sum(r["children"] for r in results),
        "degraded": any(r["degraded"] for r in results),
        "errors": [err for r in results for err in r["errors"]][:5],
        "kb": [
            {
                "kb_id": r["kb_id"],
                "docs": r["docs"],
                "skipped": r["skipped"],
                "children": r["children"],
                "pruned": r["pruned"],
            }
            for r in results
        ],
    }


async def _run_nightly_eval() -> dict:
    from ..evaluation import ensure_dataset, execute_run
    from ..models import EvalRun

    dataset_id = await ensure_dataset()
    async with SessionLocal() as db:
        record = EvalRun(
            dataset_id=dataset_id, top_k=EVAL_TOP_K, status="running", note="定时回归"
        )
        db.add(record)
        await db.commit()
        await db.refresh(record)
        run_id = record.id

    await execute_run(run_id, EVAL_TOP_K)

    async with SessionLocal() as db:
        finished = (
            await db.execute(select(EvalRun).where(EvalRun.id == run_id))
        ).scalar_one()
    if finished.status != "completed":
        raise RuntimeError(finished.error or "评测跑批失败")

    return {
        "run_id": run_id,
        "case_count": finished.case_count,
        "hit_count": finished.hit_count,
        "hit_rate": round(finished.hit_rate, 4),
        "mrr": round(finished.mrr, 4),
        "p95_latency_ms": finished.p95_latency_ms,
        "degraded_count": finished.degraded_count,
    }


async def _run_stale_ticket_scan() -> dict:
    """只读扫描：超过 SLA 仍未处理完的工单，不修改任何状态。"""
    cutoff = datetime.now() - timedelta(hours=STALE_HOURS)
    async with SessionLocal() as db:
        rows = (
            await db.execute(
                select(Ticket.ticket_no, Ticket.priority, Ticket.status, Ticket.updated_at)
                .where(Ticket.status.in_(("new", "in_progress")), Ticket.updated_at < cutoff)
                .order_by(Ticket.updated_at)
                .limit(200)
            )
        ).all()

    return {
        "threshold_hours": STALE_HOURS,
        "count": len(rows),
        "tickets": [
            {
                "ticket_no": row.ticket_no,
                "priority": row.priority,
                "status": row.status,
                "updated_at": row.updated_at.isoformat(sep=" ", timespec="minutes"),
            }
            for row in rows[:20]
        ],
    }


def _half_hour_bucket() -> str:
    now = datetime.now()
    return now.replace(minute=now.minute // 30 * 30, second=0, microsecond=0).isoformat(
        timespec="minutes"
    )


_register(
    JobSpec(
        key="kb_sync",
        name="知识库增量同步",
        schedule="*/10 * * * *",
        schedule_label="每 10 分钟",
        description="比对源文件指纹，有变更才触发 ingest；ingest 内部按单文件哈希跳过未变更文档。",
        runner=_run_kb_sync,
        idempotency=_kb_sync_idempotency,
    )
)
_register(
    JobSpec(
        key="nightly_eval",
        name="夜间检索回归",
        schedule="0 2 * * *",
        schedule_label="每天 02:00",
        description="用 48 条金标用例跑一次检索回归，结果写入评测中台，可直接和基线对比。",
        runner=_run_nightly_eval,
        idempotency=lambda: f"nightly_eval:{date.today().isoformat()}",
    )
)
_register(
    JobSpec(
        key="stale_ticket_scan",
        name="超时工单巡检",
        schedule="*/30 * * * *",
        schedule_label="每 30 分钟",
        description="只读扫描超过 24 小时未关闭的工单，记录数量与单号，不修改状态。",
        runner=_run_stale_ticket_scan,
        idempotency=lambda: f"stale_ticket_scan:{_half_hour_bucket()}",
    )
)


# ------------------------------------------------------------------
# 执行与幂等
# ------------------------------------------------------------------


def _fmt(value: datetime | None) -> str | None:
    return value.isoformat(sep=" ", timespec="seconds") if value else None


def run_to_dict(run: AutomationRun) -> dict:
    return {
        "id": run.id,
        "job_key": run.job_key,
        "job_name": run.job_name,
        "trigger": run.trigger,
        "status": run.status,
        "idempotency_key": run.idempotency_key,
        "summary": run.summary,
        "error": run.error,
        "started_at": _fmt(run.started_at),
        "finished_at": _fmt(run.finished_at),
        "duration_ms": run.duration_ms,
    }


def _next_run(key: str) -> str | None:
    if _scheduler is None:
        return None
    job = _scheduler.get_job(key)
    if job is None or job.next_run_time is None:
        return None
    return job.next_run_time.astimezone().replace(tzinfo=None).isoformat(
        sep=" ", timespec="seconds"
    )


def job_to_dict(job: JobSpec) -> dict:
    return {
        "key": job.key,
        "name": job.name,
        "schedule": job.schedule,
        "schedule_label": job.schedule_label,
        "description": job.description,
        "next_run_at": _next_run(job.key),
    }


async def create_run(
    key: str, trigger: str = "manual", force: bool = False
) -> tuple[AutomationRun, bool]:
    """插入一条 running 记录。返回 (记录, 是否命中幂等键)。"""
    job = JOBS.get(key)
    if job is None:
        raise KeyError(key)

    idempotency = job.idempotency()
    if force:
        # 演示用：手动强制再跑一次，追加时间戳避开唯一索引
        idempotency = f"{idempotency}:manual:{datetime.now().strftime('%H%M%S')}"

    async with SessionLocal() as db:
        existing = (
            await db.execute(
                select(AutomationRun).where(AutomationRun.idempotency_key == idempotency)
            )
        ).scalar_one_or_none()
        if existing is not None:
            # 上次失败允许用同一个幂等键重试，成功后不再重复执行
            if existing.status != "failed":
                return existing, True
            existing.status = "running"
            existing.trigger = trigger
            existing.summary = None
            existing.error = None
            existing.started_at = datetime.now()
            existing.finished_at = None
            existing.duration_ms = 0
            await db.commit()
            await db.refresh(existing)
            return existing, False

        record = AutomationRun(
            job_key=job.key,
            job_name=job.name,
            trigger=trigger,
            status="running",
            idempotency_key=idempotency,
        )
        db.add(record)
        try:
            await db.commit()
        except IntegrityError:
            # 并发触发时唯一索引兜底，回读已存在的记录
            await db.rollback()
            existing = (
                await db.execute(
                    select(AutomationRun).where(AutomationRun.idempotency_key == idempotency)
                )
            ).scalar_one()
            return existing, True
        await db.refresh(record)
        return record, False


async def execute_run(record_id: int, key: str) -> None:
    """执行任务并回写结果。异常只落库，不向外抛。"""
    job = JOBS[key]
    started = time.perf_counter()
    status, summary, error = "success", None, None
    try:
        summary = await job.runner()
    except Exception as exc:  # noqa: BLE001
        logger.exception("自动化任务 %s 执行失败", key)
        status, error = "failed", str(exc)[:500]

    async with SessionLocal() as db:
        record = await db.get(AutomationRun, record_id)
        if record is None:
            return
        record.status = status
        record.summary = summary
        record.error = error
        record.finished_at = datetime.now()
        record.duration_ms = int((time.perf_counter() - started) * 1000)
        await db.commit()


async def trigger(key: str, trigger: str = "schedule", force: bool = False) -> dict:
    """同步执行一次（调度器使用），返回运行记录。"""
    record, duplicated = await create_run(key, trigger=trigger, force=force)
    if duplicated:
        logger.info("自动化任务 %s 命中幂等键 %s，跳过", key, record.idempotency_key)
        return run_to_dict(record)

    await execute_run(record.id, key)
    async with SessionLocal() as db:
        fresh = await db.get(AutomationRun, record.id)
    return run_to_dict(fresh or record)


async def list_runs(
    job_key: str | None = None, limit: int = 20, offset: int = 0
) -> tuple[list[dict], int]:
    query = select(AutomationRun)
    count_query = select(func.count()).select_from(AutomationRun)
    if job_key:
        query = query.where(AutomationRun.job_key == job_key)
        count_query = count_query.where(AutomationRun.job_key == job_key)

    async with SessionLocal() as db:
        total = int(
            (await db.execute(count_query)).scalar() or 0
        )
        rows = (
            (
                await db.execute(
                    query.order_by(AutomationRun.id.desc()).limit(limit).offset(offset)
                )
            )
            .scalars()
            .all()
        )
    return [run_to_dict(r) for r in rows], total


# ------------------------------------------------------------------
# 调度器生命周期
# ------------------------------------------------------------------


async def _scheduled(key: str) -> None:
    try:
        await trigger(key, trigger="schedule")
    except Exception:  # noqa: BLE001
        logger.exception("定时任务 %s 调度失败", key)


async def start() -> None:
    """建表 + 注册定时任务，随 FastAPI lifespan 调用。数据库不可用时不阻断启动。"""
    global _scheduler
    try:
        async with engine.begin() as conn:
            await conn.run_sync(AutomationRun.__table__.create, checkfirst=True)
        # 进程重启后，把上次遗留的 running 记录标记为失败，避免页面一直转圈
        async with SessionLocal() as db:
            await db.execute(
                update(AutomationRun)
                .where(
                    AutomationRun.status == "running",
                    AutomationRun.started_at < datetime.now() - timedelta(hours=1),
                )
                .values(status="failed", error="进程重启，执行中断", finished_at=datetime.now())
            )
            await db.commit()
    except Exception as exc:  # noqa: BLE001
        logger.warning("automation_runs 建表失败（%s），自动化接口可能不可用", exc)

    if _scheduler is not None:
        return

    scheduler = AsyncIOScheduler()
    for job in JOBS.values():
        scheduler.add_job(
            _scheduled,
            CronTrigger.from_crontab(job.schedule),
            args=[job.key],
            id=job.key,
            name=job.name,
            max_instances=1,
            coalesce=True,
            misfire_grace_time=300,
            replace_existing=True,
        )
    scheduler.start()
    _scheduler = scheduler
    logger.info("自动化调度已启动：%s", "、".join(f"{j.name}({j.schedule_label})" for j in JOBS.values()))


async def stop() -> None:
    global _scheduler
    if _scheduler is not None:
        _scheduler.shutdown(wait=False)
        _scheduler = None
        logger.info("自动化调度已停止")


def scheduler_running() -> bool:
    return _scheduler is not None and _scheduler.running
