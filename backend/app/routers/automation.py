"""自动化控制台接口：任务清单、运行历史、手动触发、Excel 导出。

全部要求管理员身份；手动触发只负责落一条 running 记录，实际执行交给
FastAPI BackgroundTasks，前端轮询运行历史即可看到状态变化。
"""

from __future__ import annotations

import json
from datetime import datetime
from io import BytesIO

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Query
from fastapi.responses import StreamingResponse
from openpyxl import Workbook
from openpyxl.styles import Font, PatternFill

from ..schemas import AutomationRunRequest
from ..services import automation
from .auth import require_admin

XLSX_MEDIA_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
TRIGGER_LABEL = {"schedule": "定时", "manual": "手动", "agent": "Agent"}
STATUS_LABEL = {"running": "执行中", "success": "成功", "failed": "失败"}

router = APIRouter(
    prefix="/api/admin/automation",
    tags=["automation"],
    dependencies=[Depends(require_admin)],
)


@router.get("/jobs")
async def jobs():
    """注册表里的定时任务与下次执行时间（代码定义，不提供任务 CRUD）。"""
    return {
        "jobs": [automation.job_to_dict(job) for job in automation.JOBS.values()],
        "scheduler_running": automation.scheduler_running(),
    }


@router.get("/runs")
async def runs(
    job_key: str | None = Query(default=None, max_length=32),
    limit: int = Query(default=20, ge=1, le=100),
    offset: int = Query(default=0, ge=0),
):
    """运行历史：按 id 倒序，可按任务过滤。"""
    items, total = await automation.list_runs(job_key, limit=limit, offset=offset)
    return {"items": items, "total": total}


@router.get("/export")
async def export_runs():
    """导出运行历史与各任务最近一次结果，用于周报归档。"""
    items, total = await automation.list_runs(limit=500)

    workbook = Workbook()
    history = workbook.active
    history.title = "运行历史"
    history.append(
        [
            "运行ID",
            "任务Key",
            "任务名",
            "触发方式",
            "状态",
            "开始时间",
            "结束时间",
            "耗时(ms)",
            "结果摘要",
            "错误",
            "幂等键",
        ]
    )
    for item in items:
        history.append(
            [
                item["id"],
                item["job_key"],
                item["job_name"],
                TRIGGER_LABEL.get(item["trigger"], item["trigger"]),
                STATUS_LABEL.get(item["status"], item["status"]),
                item["started_at"] or "",
                item["finished_at"] or "",
                item["duration_ms"] or 0,
                json.dumps(item["summary"], ensure_ascii=False) if item["summary"] else "",
                item["error"] or "",
                item["idempotency_key"],
            ]
        )

    # 运行历史按 id 倒序，第一条即各任务的最近一次结果
    latest: dict[str, dict] = {}
    for item in items:
        latest.setdefault(item["job_key"], item)

    summary = workbook.create_sheet("任务最近结果")
    summary.append(
        [
            "任务Key",
            "任务名",
            "计划",
            "最近状态",
            "最近开始时间",
            "耗时(ms)",
            "结果摘要",
            "错误",
            "下次执行",
        ]
    )
    for job in automation.JOBS.values():
        meta = automation.job_to_dict(job)
        run = latest.get(job.key) or {}
        summary.append(
            [
                meta["key"],
                meta["name"],
                meta["schedule_label"],
                STATUS_LABEL.get(run.get("status", ""), "未运行"),
                run.get("started_at") or "",
                run.get("duration_ms") or 0,
                json.dumps(run["summary"], ensure_ascii=False) if run.get("summary") else "",
                run.get("error") or "",
                meta["next_run_at"] or "",
            ]
        )

    _style_sheet(history, [10, 16, 18, 10, 10, 20, 20, 12, 60, 40, 40])
    _style_sheet(summary, [16, 18, 14, 10, 20, 14, 60, 40, 20])

    buffer = BytesIO()
    workbook.save(buffer)
    buffer.seek(0)
    filename = f"automation-{datetime.now().strftime('%Y%m%d-%H%M%S')}.xlsx"
    return StreamingResponse(
        buffer,
        media_type=XLSX_MEDIA_TYPE,
        headers={
            "Content-Disposition": f'attachment; filename="{filename}"',
            "X-Total-Runs": str(total),
        },
    )


def _style_sheet(sheet, widths: list[int]) -> None:
    header_fill = PatternFill("solid", fgColor="E2E8F0")
    for index, width in enumerate(widths, start=1):
        sheet.column_dimensions[sheet.cell(row=1, column=index).column_letter].width = width
    for cell in sheet[1]:
        cell.font = Font(bold=True)
        cell.fill = header_fill
    sheet.freeze_panes = "A2"


@router.post("/jobs/{key}/run")
async def run_now(
    key: str,
    background: BackgroundTasks,
    body: AutomationRunRequest | None = None,
):
    """手动触发一次。命中幂等键时返回已有记录，不重复执行。"""
    if key not in automation.JOBS:
        raise HTTPException(status_code=404, detail="任务不存在")

    try:
        record, duplicated = await automation.create_run(
            key, trigger="manual", force=body.force if body else False
        )
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=503, detail=f"自动化记录不可用：{exc}") from exc

    if not duplicated:
        background.add_task(automation.execute_run, record.id, key)

    return {"run": automation.run_to_dict(record), "duplicated": duplicated}
