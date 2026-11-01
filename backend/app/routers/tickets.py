"""IT 工单接口：报障一句话 → 规则引擎分级 → 落库 → 前端渲染。

只暴露三个动作：生成、查询、改状态。
工单号、类别、优先级、指派小组、SLA 全部由后端决定，前端不参与拼装，
避免演示时出现「卡片好看但数据编造」的情况。
"""

from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from ..database import get_db
from ..models import Ticket
from ..schemas import TicketCreate, TicketStatusUpdate
from ..ticket_ai import analyze_ticket
from ..ticket_engine import analyze

router = APIRouter(prefix="/api/tickets", tags=["tickets"])

STATUS_LABELS = {"new": "待受理", "in_progress": "处理中", "resolved": "已解决"}
ALLOWED_STATUS = set(STATUS_LABELS)


def _serialize(ticket: Ticket) -> dict:
    return {
        "ticket_no": ticket.ticket_no,
        "reporter": ticket.reporter,
        "department": ticket.department,
        "description": ticket.description,
        "category": ticket.category,
        "category_label": ticket.category_label,
        "priority": ticket.priority,
        "assignee_group": ticket.assignee_group,
        "sla_response": ticket.sla_response,
        "sla_resolve": ticket.sla_resolve,
        "status": ticket.status,
        "status_label": STATUS_LABELS.get(ticket.status, ticket.status),
        "matched_keywords": ticket.matched_keywords or [],
        "missing_info": ticket.missing_info or [],
        "suggestions": ticket.suggestions or [],
        "created_at": ticket.created_at.strftime("%Y-%m-%d %H:%M") if ticket.created_at else None,
        "updated_at": ticket.updated_at.strftime("%Y-%m-%d %H:%M") if ticket.updated_at else None,
    }


async def _next_ticket_no(db: AsyncSession) -> str:
    """IT-YYYYMMDD-NNN：取当天已有最大序号 +1，避免同一天重置后重号。"""
    day = datetime.now().strftime("%Y%m%d")
    prefix = f"IT-{day}-"
    latest = await db.scalar(
        select(func.max(Ticket.ticket_no)).where(Ticket.ticket_no.like(f"{prefix}%"))
    )
    seq = 1
    if latest:
        try:
            seq = int(latest.rsplit("-", 1)[-1]) + 1
        except ValueError:
            seq = 1
    return f"{prefix}{seq:03d}"


def _rule_summary(result: dict) -> str:
    """把规则引擎结论压成一段文字，作为工作流输入，保证 AI 不越权重判分级。"""
    lines = [
        f"类别：{result['category_label']}",
        f"优先级：{result['priority_label']}（{result['priority_reason']}）",
        f"指派小组：{result['assignee_group']}",
        f"响应时限：{result['sla_response']}；解决时限：{result['sla_resolve']}",
    ]
    if result["matched_keywords"]:
        lines.append(f"命中关键词：{'、'.join(result['matched_keywords'])}")
    if result["missing_info"]:
        lines.append(f"缺失信息：{'、'.join(result['missing_info'])}")
    return "\n".join(lines)


@router.post("/generate")
async def generate_ticket(req: TicketCreate, db: AsyncSession = Depends(get_db)):
    description = req.description.strip()
    if len(description) < 4:
        raise HTTPException(status_code=400, detail="请补充问题描述（至少 4 个字）")
    if len(description) > 300:
        raise HTTPException(status_code=400, detail="问题描述请控制在 300 字以内")

    result = analyze(description)
    # 规则引擎先出确定性字段，AI 只做语义补充；失败时 ai_analysis 为 None
    ai_analysis = await analyze_ticket(description, _rule_summary(result))
    ticket = Ticket(
        ticket_no=await _next_ticket_no(db),
        reporter=(req.reporter or "").strip() or "匿名员工",
        department=(req.department or "").strip() or None,
        description=description,
        category=result["category"],
        category_label=result["category_label"],
        priority=result["priority"],
        assignee_group=result["assignee_group"],
        sla_response=result["sla_response"],
        sla_resolve=result["sla_resolve"],
        status="new",
        matched_keywords=result["matched_keywords"],
        missing_info=result["missing_info"],
        suggestions=result["suggestions"],
    )
    db.add(ticket)
    await db.commit()
    await db.refresh(ticket)

    payload = _serialize(ticket)
    # 判定依据与自动回复只在生成时返回，列表接口不需要
    payload.update(
        {
            "priority_label": result["priority_label"],
            "priority_reason": result["priority_reason"],
            "auto_reply": result["auto_reply"],
            "ai_analysis": ai_analysis,
        }
    )
    return payload


@router.get("")
async def list_tickets(
    status: str | None = None,
    limit: int = Query(20, ge=1, le=50),
    db: AsyncSession = Depends(get_db),
):
    stmt = select(Ticket).order_by(Ticket.id.desc()).limit(limit)
    if status:
        if status not in ALLOWED_STATUS:
            raise HTTPException(status_code=400, detail=f"未知状态：{status}")
        stmt = stmt.where(Ticket.status == status)
    rows = (await db.scalars(stmt)).all()
    return {"items": [_serialize(t) for t in rows], "total": len(rows)}


@router.get("/stats")
async def ticket_stats(db: AsyncSession = Depends(get_db)):
    """队列概览：总量、各优先级、各状态。"""
    by_priority = {
        p: await db.scalar(select(func.count()).select_from(Ticket).where(Ticket.priority == p))
        for p in ("P0", "P1", "P2", "P3")
    }
    by_status = {
        s: await db.scalar(select(func.count()).select_from(Ticket).where(Ticket.status == s))
        for s in ("new", "in_progress", "resolved")
    }
    return {
        "total": await db.scalar(select(func.count()).select_from(Ticket)),
        "by_priority": by_priority,
        "by_status": by_status,
    }


@router.patch("/{ticket_no}/status")
async def update_status(
    ticket_no: str,
    req: TicketStatusUpdate,
    db: AsyncSession = Depends(get_db),
):
    if req.status not in ALLOWED_STATUS:
        raise HTTPException(status_code=400, detail=f"状态仅支持 {'/'.join(sorted(ALLOWED_STATUS))}")

    ticket = await db.scalar(select(Ticket).where(Ticket.ticket_no == ticket_no))
    if ticket is None:
        raise HTTPException(status_code=404, detail=f"未找到工单 {ticket_no}")

    ticket.status = req.status
    await db.commit()
    await db.refresh(ticket)
    return _serialize(ticket)
