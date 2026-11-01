"""聊天主链路：Redis 历史 → LangGraph（自建 RAG + 工具调用）→ 统一 SSE → 落库记账。

设计要点：
1. 会话历史只由后端维护最近 N 轮，模型不持有状态，多端 / 多会话互不串味；
2. 知识库检索、工具调用、Agent 编排全部在本项目内完成，不依赖 Dify；
3. 输出帧统一成 {"event": ...}，前端 chatStream.ts 只认这一套；
4. Token 用量在 message_end 时写入 chat_history，用于成本可观测。
"""

import json
import logging
import re
import time
from datetime import date
from uuid import uuid4

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import StreamingResponse
from langchain_core.messages import AIMessage, HumanMessage, ToolMessage
from langgraph.types import Command
from sqlalchemy import select

from ..agent.graph import MAX_TOOL_ROUNDS, get_graph
from ..config import settings
from ..database import SessionLocal, get_redis
from ..models import ChatHistory, ChatTrace, Customer, Product
from ..schemas import ChatRequest, ResumeRequest
from .auth import optional_customer

logger = logging.getLogger("chat")

router = APIRouter(prefix="/api/chat", tags=["chat"])

HISTORY_TTL = 60 * 60 * 24  # 会话上下文保留一天
_EMPTY_USAGE = {"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0}

# 公网演示的额度保护：单个会话 10 分钟 30 轮，全站每天 1000 轮
CHAT_SESSION_LIMIT = 30
CHAT_SESSION_WINDOW = 600
CHAT_DAILY_LIMIT = 1000

VALID_APPS = ("ecommerce", "enterprise")


def _sse(payload: dict) -> str:
    """按 SSE 协议拼一帧。"""
    return f"data: {json.dumps(payload, ensure_ascii=False)}\n\n"


def _friendly_error(message: str) -> str:
    """把模型供应商的英文报错翻译成用户能理解的中文提示。"""
    text = message.lower()
    if "1113" in text or "余额" in text or "quota" in text or "insufficient" in text:
        return "AI 模型额度不足，请稍后重试或联系管理员充值。"
    if "timeout" in text or "timed out" in text:
        return "AI 服务响应超时，请稍后重试。"
    if "401" in text or "api key" in text or "unauthorized" in text:
        return "AI 服务鉴权失败，请检查后端 ZHIPU_API_KEY 配置。"
    if "429" in text:
        return "AI 服务请求过于频繁，请稍后重试。"
    return "AI 服务暂时不可用，请稍后重试。"


def _history_key(app: str, session_id: str) -> str:
    return f"chat:history:{app}:{session_id}"


async def _check_chat_quota(app: str, session_id: str) -> str | None:
    """公网演示额度检查，返回超限提示；Redis 不可用时放行，不影响正常使用。"""
    redis = get_redis()
    try:
        session_key = f"chat:quota:{app}:{session_id}"
        session_count = await redis.incr(session_key)
        if session_count == 1:
            await redis.expire(session_key, CHAT_SESSION_WINDOW)
        if session_count > CHAT_SESSION_LIMIT:
            ttl = await redis.ttl(session_key)
            minutes = max(1, (int(ttl) + 59) // 60)
            return (
                f"本轮演示额度已用完（每 10 分钟 {CHAT_SESSION_LIMIT} 轮），"
                f"请约 {minutes} 分钟后再试。"
            )

        daily_key = f"chat:quota:daily:{date.today().isoformat()}"
        daily_count = await redis.incr(daily_key)
        if daily_count == 1:
            await redis.expire(daily_key, 60 * 60 * 48)
        if daily_count > CHAT_DAILY_LIMIT:
            return "今日演示额度已用完，请明天再试。"
    except Exception as exc:  # noqa: BLE001
        logger.warning("对话额度检查失败，本次放行：%s", exc)
    return None


def _quota_sse(message: str) -> StreamingResponse:
    """用 SSE 帧返回额度提示，前端展示为普通中文提示而不是 HTTP 异常。"""

    async def _stream():
        yield _sse({"event": "error", "message": message})
        yield "data: [DONE]\n\n"

    return StreamingResponse(
        _stream(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


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
_PUNCT_RE = re.compile(r"[\s\-_/·，。！？、,.!?()（）\[\]【】]+")
_ORDER_RE = re.compile(r"(?<!\d)(\d{5,12})(?!\d)")


def _normalize_name(value: str) -> str:
    return _PUNCT_RE.sub("", value.lower())


def _match_product(question: str, name: str) -> bool:
    """商品名匹配：整名命中，或去掉「跑鞋/板鞋」等通用后缀后命中核心词。"""
    q = _normalize_name(question)
    n = _normalize_name(name)
    if not q or not n:
        return False
    if n in q:
        return True
    core = n
    for suffix in _PRODUCT_SUFFIXES:
        s = _normalize_name(suffix)
        if core.endswith(s) and len(core) - len(s) >= 2:
            core = core[: -len(s)]
            break
    return len(core) >= 3 and core in q


async def _recognize_business_entities(question: str) -> str:
    """把问题里的商品名 / 订单号确定性解析成工具参数约束。

    Agent 偶尔会把「山野 GTX 越野跑鞋」猜成不存在的 p2008，导致 get_product 404；
    这里先查一次商品主数据，把真实 product_id 写进提示词作为强约束。
    """
    hints: list[str] = []
    for order_no in dict.fromkeys(_ORDER_RE.findall(question)):
        hints.append(f"订单号 {order_no}：调用 get_order 时 order_no 必须使用 {order_no}。")

    try:
        async with SessionLocal() as db:
            products = (await db.scalars(select(Product))).all()
    except Exception as exc:  # 识别失败就退回原有链路，不影响对话
        logger.warning("商品名预识别失败（不影响对话）：%s", exc)
        return "\n".join(hints)

    matched = [p for p in products if _match_product(question, p.name or "")]
    if len(matched) == 1:
        product = matched[0]
        hints.append(
            f"商品「{product.name}」已确认，product_id 必须使用 {product.id}；"
            "调用 get_product 时禁止猜测或改写 product_id。"
        )
    elif len(matched) > 1:
        listing = "、".join(f"{p.name}({p.id})" for p in matched)
        hints.append(f"问题可能涉及多款商品：{listing}；请逐个确认，禁止猜测 product_id。")
    return "\n".join(hints)


async def _load_history(app: str, session_id: str) -> list[dict]:
    try:
        raw = await get_redis().lrange(_history_key(app, session_id), 0, -1)
        return [json.loads(item) for item in raw]
    except Exception as exc:  # Redis 挂了就退化为单轮，不影响主流程
        logger.warning("读取 Redis 上下文失败，本次不携带历史：%s", exc)
        return []


async def _save_history(app: str, session_id: str, question: str, answer: str) -> None:
    try:
        redis = get_redis()
        key = _history_key(app, session_id)
        pipe = redis.pipeline()
        pipe.rpush(
            key,
            json.dumps({"role": "user", "content": question}, ensure_ascii=False),
            json.dumps({"role": "assistant", "content": answer}, ensure_ascii=False),
        )
        pipe.ltrim(key, -settings.history_rounds * 2, -1)
        pipe.expire(key, HISTORY_TTL)
        await pipe.execute()
    except Exception as exc:
        logger.warning("写入 Redis 上下文失败：%s", exc)


async def _persist(
    session_id: str,
    customer_id: str | None,
    question: str,
    answer: str,
    usage: dict,
    model: str,
    latency_ms: int,
) -> None:
    """落库：一问一答 + Token 记账。失败只打日志，不影响已推给前端的回复。"""
    try:
        async with SessionLocal() as db:
            db.add(
                ChatHistory(
                    session_id=session_id,
                    customer_id=customer_id,
                    role="user",
                    content=question,
                )
            )
            db.add(
                ChatHistory(
                    session_id=session_id,
                    customer_id=customer_id,
                    role="assistant",
                    content=answer,
                    prompt_tokens=usage["prompt_tokens"],
                    completion_tokens=usage["completion_tokens"],
                    total_tokens=usage["total_tokens"],
                    model=model or None,
                    latency_ms=latency_ms,
                )
            )
            await db.commit()
    except Exception as exc:
        logger.warning("写入 chat_history 失败（不影响本次回复）：%s", exc)


_DOC_REF_RE = re.compile(r"《([^》]{2,40})》")


def _filter_sources_by_doc_ref(question: str, sources: list[dict]) -> list[dict]:
    """用户点名《某文档》时，来源只保留该文档，避免展示无关文档造成误解。"""
    names = _DOC_REF_RE.findall(question)
    if not names or not sources:
        return sources
    matched = [s for s in sources if any(n in s["document_name"] for n in names)]
    return matched or sources


def _filter_sources_by_answer(answer: str, sources: list[dict], *, degraded: bool) -> list[dict]:
    """来源卡片只展示答案真正引用到的文档，避免把弱相关命中列成「依据」。

    模型按提示词会写「依据：文档名｜编号｜版本」，这里按文档名反查；
    一条都没匹配上时（模型没写依据）退化为按分数取前几条，降级检索时只取前 3 条。
    """
    if not sources:
        return []

    def _stem(source: dict) -> str:
        base = source["document_name"].split(" · ")[0].strip()
        return re.sub(r"\.(pdf|docx|xlsx|xls|md|txt)$", "", base, flags=re.I)

    if answer:
        cited = [s for s in sources if _stem(s) and _stem(s) in answer]
        if cited:
            return cited
    return sources[:3] if degraded else sources[:5]


def _sources_from_evidence(evidence: list[dict]) -> list[dict]:
    """证据链 → 来源卡片：文件名 + 章节 + 页码，展开后显示文档编号与版本。"""
    rows: list[dict] = []
    for item in evidence:
        name = str(item.get("doc_name") or item.get("document_name") or "").strip()
        if not name:
            continue
        section = str(item.get("section") or "").strip()
        page = item.get("page")
        label = f"{name} · {section}" if section else name
        if page:
            label = f"{label}（第 {page} 页）"
        detail = (
            f"文档编号 {item.get('doc_no') or '-'}｜版本 {item.get('version') or '-'}"
            f"｜章节 {section or '-'}"
        )
        if page:
            detail = f"{detail}｜第 {page} 页"
        rows.append(
            {
                "document_name": label,
                "score": round(float(item.get("score") or 0), 4),
                "content": detail,
            }
        )
    return rows


_TOOL_LABELS = {
    "search_products": "商品库 · 商品检索",
    "get_product": "商品库 · 商品详情",
    "get_order": "订单库 · 订单查询",
    "get_policies": "政策库 · 店铺政策",
    "get_coupons": "优惠券库 · 优惠查询",
    "create_escalation_ticket": "人工接管 · 升级工单",
}

_INITIAL_STATUS = {
    "ecommerce": "正在检索商品知识库",
    "enterprise": "正在检索企业知识库",
}


def _brief_tool_result(data) -> str:
    """把工具返回的业务 JSON 压成一句人话，供工具卡片展示。"""
    if not isinstance(data, dict):
        return "已返回结果"
    if data.get("ticket_no"):
        return (
            f"已创建工单 {data['ticket_no']}（{data.get('priority') or 'P2'}，"
            f"指派 {data.get('assignee_group') or '人工客服'}）"
        )
    products = data.get("products")
    if isinstance(products, list):
        names = "、".join(
            f"{p.get('name')}（¥{p.get('price')}）"
            for p in products[:3]
            if isinstance(p, dict) and p.get("name")
        )
        return f"命中 {len(products)} 款" + (f"：{names}" if names else "")
    if data.get("product_id") and data.get("name"):
        variants = data.get("variants") or []
        return f"{data['name']}（¥{data.get('price')}）· {len(variants)} 个尺码"
    if data.get("order_no"):
        ship = data.get("shipment") or {}
        events = data.get("events") or []
        where = f"，{ship.get('current_city')}" if ship.get("current_city") else ""
        latest = events[0] if events and isinstance(events[0], dict) else None
        tail = ""
        if latest:
            tail = f" · 物流 {len(events)} 条，最新 {latest.get('time') or ''} {latest.get('city') or ''}".rstrip()
        return f"订单 {data['order_no']}：{data.get('status_text') or data.get('status') or '已查询'}{where}{tail}"
    policies = data.get("policies")
    if isinstance(policies, list):
        return f"命中 {len(policies)} 条店铺政策"
    coupons = data.get("coupons")
    if isinstance(coupons, list):
        return f"返回 {len(coupons)} 张优惠券"
    for key in ("detail", "message", "error"):
        value = data.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip()[:80]
    return "已返回结果"


def _tool_details(data) -> list[str]:
    """挑出能逐条核对的明细（物流轨迹、订单商品、商品命中），供前端展开。"""
    if not isinstance(data, dict):
        return []
    lines: list[str] = []
    for e in (data.get("events") or [])[:8]:
        if isinstance(e, dict):
            lines.append(
                f"{e.get('time') or ''} {e.get('city') or ''} · {e.get('description') or ''}".strip()
            )
    for i in (data.get("items") or [])[:4]:
        if isinstance(i, dict):
            lines.append(
                f"{i.get('product_name')} × {i.get('qty')} · ¥{i.get('unit_price')}"
            )
    for p in (data.get("products") or [])[:4]:
        if isinstance(p, dict):
            stock = f" · 库存 {p.get('total_stock')}" if p.get("total_stock") is not None else ""
            lines.append(f"{p.get('name')} ¥{p.get('price')}{stock}")
    for v in (data.get("variants") or [])[:8]:
        if isinstance(v, dict):
            color = f"{v.get('color')} " if v.get("color") else ""
            stock = "有货" if v.get("available") else "缺货"
            lines.append(f"尺码 {v.get('size')} · {color}· {stock}（库存 {v.get('stock')}）")
    return [line[:120] for line in lines if line.strip()][:8]


def _tool_card(msg: ToolMessage, pending: dict[str, dict]) -> dict | None:
    """把一次 LangGraph 工具调用的结果转成前端可渲染的数据来源。"""
    call = pending.get(str(msg.tool_call_id or ""), {})
    name = msg.name or call.get("name") or ""
    if not name:
        return None
    data = msg.artifact if isinstance(msg.artifact, dict) else None
    if data is None:
        raw = msg.content if isinstance(msg.content, str) else ""
        try:
            parsed = json.loads(raw)
            data = parsed if isinstance(parsed, dict) else None
        except json.JSONDecodeError:
            data = None
    ok = not (isinstance(data, dict) and data.get("error"))
    summary = _brief_tool_result(data) if data is not None else "已返回结果"
    return {
        "tool": name,
        "label": _TOOL_LABELS.get(name, name),
        "args": {k: v for k, v in (call.get("args") or {}).items() if v not in (None, "")},
        "summary": summary,
        "details": _tool_details(data) if ok else [],
        "ok": ok,
    }


def _text_of(content) -> str:
    """LangChain 流式片段可能是字符串或多段内容块，这里统一取纯文本。"""
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts = []
        for block in content:
            if isinstance(block, str):
                parts.append(block)
            elif isinstance(block, dict) and isinstance(block.get("text"), str):
                parts.append(block["text"])
        return "".join(parts)
    return ""


def _new_acc() -> dict:
    return {
        "answer_parts": [],
        "usage": dict(_EMPTY_USAGE),
        "evidence": [],
        "retrieval": {},
        "tool_calls": [],
        "pending": {},
        "interrupt": None,
        "first_token_ms": 0,
    }


async def _consume_stream(graph, graph_input, config: dict, started: float, acc: dict):
    """LangGraph 事件 → SSE 帧；只做翻译与累加，收尾由调用方决定。"""
    async for mode, payload in graph.astream(
        graph_input, config=config, stream_mode=["messages", "updates"]
    ):
        if mode == "messages":
            chunk, meta = payload
            if (meta or {}).get("langgraph_node") != "agent":
                continue
            text = _text_of(getattr(chunk, "content", ""))
            if text:
                if not acc["first_token_ms"]:
                    acc["first_token_ms"] = max(1, int((time.perf_counter() - started) * 1000))
                acc["answer_parts"].append(text)
                yield _sse({"event": "message", "answer": text})
            chunk_usage = getattr(chunk, "usage_metadata", None)
            if chunk_usage:
                acc["usage"] = {
                    "prompt_tokens": int(chunk_usage.get("input_tokens") or 0),
                    "completion_tokens": int(chunk_usage.get("output_tokens") or 0),
                    "total_tokens": int(chunk_usage.get("total_tokens") or 0),
                }
            continue

        updates = payload or {}

        # 写操作前的人工闸门：图在这里暂停，把审批信息透传给前端
        if "__interrupt__" in updates:
            interrupts = updates["__interrupt__"]
            first = interrupts[0] if interrupts else None
            value = getattr(first, "value", first)
            acc["interrupt"] = value if isinstance(value, dict) else {"type": "approval"}
            continue

        for node, update in updates.items():
            if node == "retrieve":
                acc["evidence"] = list(update.get("evidence") or []) or acc["evidence"]
                acc["retrieval"] = update.get("retrieval") or acc["retrieval"]
                if not acc["evidence"]:
                    yield _sse({"event": "status", "label": "未检索到资料，正在切换工具查询"})
            elif node == "agent":
                last = (update.get("messages") or [None])[-1]
                calls = getattr(last, "tool_calls", None) or []
                if calls:
                    for call in calls:
                        acc["pending"][str(call.get("id") or "")] = {
                            "name": call.get("name") or "",
                            "args": call.get("args") or {},
                        }
                    labels = "、".join(
                        _TOOL_LABELS.get(c.get("name") or "", c.get("name") or "")
                        for c in calls
                    )
                    yield _sse({"event": "status", "label": "正在调用工具", "detail": labels})
            elif node == "tools":
                for msg in update.get("messages") or []:
                    if isinstance(msg, ToolMessage):
                        card = _tool_card(msg, acc["pending"])
                        if card:
                            acc["tool_calls"].append(card)


async def _persist_trace(
    session_id: str,
    app: str,
    question: str,
    acc: dict,
    *,
    status: str,
    latency_ms: int,
    error: str | None = None,
) -> None:
    """执行轨迹落库：检索命中数、工具、降级原因、首 Token 延迟。"""
    try:
        retrieval = acc.get("retrieval") or {}
        names = ",".join(str(c.get("tool") or "") for c in acc.get("tool_calls") or [])
        degraded = retrieval.get("degraded") or []
        async with SessionLocal() as db:
            db.add(
                ChatTrace(
                    session_id=session_id,
                    app=app,
                    question=question[:255],
                    status=status,
                    hits=int(retrieval.get("hits") or 0),
                    tools=len(acc.get("tool_calls") or []),
                    tool_names=names[:255] or None,
                    degraded=(",".join(str(d) for d in degraded))[:128] or None,
                    first_token_ms=int(acc.get("first_token_ms") or 0),
                    latency_ms=latency_ms,
                    total_tokens=int((acc.get("usage") or {}).get("total_tokens") or 0),
                    error=(error[:255] if error else None),
                )
            )
            await db.commit()
    except Exception as exc:
        logger.warning("写入 chat_trace 失败（不影响回复）：%s", exc)


async def _drop_checkpoint(thread_id: str) -> None:
    """本轮结束后清掉检查点，避免 InMemorySaver 无限增长。"""
    try:
        await get_graph().checkpointer.adelete_thread(thread_id)
    except Exception as exc:  # 清理失败不影响业务
        logger.warning("清理检查点失败 %s：%s", thread_id, exc)


def _final_frames(question: str, acc: dict, started: float) -> list[str]:
    """正常收尾：来源裁剪 + message_end + DONE。"""
    answer = "".join(acc["answer_parts"])
    latency_ms = int((time.perf_counter() - started) * 1000)
    degraded = bool((acc.get("retrieval") or {}).get("degraded"))
    sources = _filter_sources_by_doc_ref(question, _sources_from_evidence(acc["evidence"]))
    sources = _filter_sources_by_answer(answer, sources, degraded=degraded)
    return [
        _sse(
            {
                "event": "message_end",
                "metadata": {
                    "usage": acc["usage"],
                    "model": settings.zhipu_chat_model,
                    "latency_ms": latency_ms,
                    "rag": acc["retrieval"],
                    "first_token_ms": acc["first_token_ms"],
                    "max_tool_rounds": MAX_TOOL_ROUNDS,
                },
                "sources": sources,
                "tool_calls": acc["tool_calls"],
            }
        ),
        "data: [DONE]\n\n",
    ]


async def _event_stream(
    question: str,
    session_id: str,
    customer_id: str | None,
    customer_name: str,
    app: str,
    started: float | None = None,
):
    started = started or time.perf_counter()
    acc = _new_acc()

    if not settings.zhipu_api_key:
        yield _sse(
            {
                "event": "error",
                "message": "后端未配置 ZHIPU_API_KEY：请把智谱 Key 写入 backend/.env 后重启服务",
            }
        )
        return

    history = await _load_history(app, session_id)
    messages = [
        HumanMessage(content=m["content"]) if m.get("role") == "user" else AIMessage(content=m["content"])
        for m in history
        if m.get("content")
    ]
    messages.append(HumanMessage(content=question))

    hints = ""
    if app == "ecommerce":
        hints = await _recognize_business_entities(question)

    yield _sse({"event": "status", "label": _INITIAL_STATUS.get(app, "正在思考中")})

    # 每次提问独立 thread_id：检查点只服务本次中断恢复，不污染其它轮次
    thread_id = f"{session_id}-{uuid4().hex[:8]}"
    config = {"configurable": {"thread_id": thread_id}}
    state = {
        "messages": messages,
        "app": app,
        "kb_id": "shop" if app == "ecommerce" else "enterprise",
        "question": question,
        "today": date.today().isoformat(),
        "customer_name": customer_name,
        "customer_id": customer_id or "",
        "history_text": "",
        "hints": hints,
        "tool_rounds": 0,
        "session_id": session_id,
    }

    try:
        async for frame in _consume_stream(get_graph(), state, config, started, acc):
            yield frame
    except Exception as exc:  # 兜底：任何意外都转成可读错误，避免前端一直转圈
        logger.exception("聊天流式处理异常")
        await _persist_trace(
            session_id, app, question, acc, status="error",
            latency_ms=int((time.perf_counter() - started) * 1000), error=str(exc),
        )
        yield _sse({"event": "error", "message": _friendly_error(str(exc))})
        return

    if acc["interrupt"]:
        await _persist_trace(
            session_id, app, question, acc, status="interrupted",
            latency_ms=int((time.perf_counter() - started) * 1000),
        )
        yield _sse(
            {
                "event": "interrupt",
                "thread_id": thread_id,
                "session_id": session_id,
                "app": app,
                "payload": acc["interrupt"],
            }
        )
        yield "data: [DONE]\n\n"
        return

    answer = "".join(acc["answer_parts"])
    latency_ms = int((time.perf_counter() - started) * 1000)

    if not answer:
        await _persist_trace(session_id, app, question, acc, status="error", latency_ms=latency_ms, error="模型没有返回内容")
        yield _sse({"event": "error", "message": "模型没有返回内容，请换个问法再试一次。"})
        return

    # 先落库再收尾：前端收到 message_end 会立刻断开，之后再写会和生成器一起被取消
    await _save_history(app, session_id, question, answer)
    await _persist(session_id, customer_id, question, answer, acc["usage"], settings.zhipu_chat_model, latency_ms)
    await _persist_trace(session_id, app, question, acc, status="ok", latency_ms=latency_ms)
    await _drop_checkpoint(thread_id)

    for frame in _final_frames(question, acc, started):
        yield frame


async def _resume_stream(thread_id: str, approved: bool, by: str, started: float | None = None):
    """HITL 恢复：从检查点继续被中断的图，前端拿同一 thread_id 回来。"""
    started = started or time.perf_counter()
    graph = get_graph()
    config = {"configurable": {"thread_id": thread_id}}

    values: dict = {}
    try:
        snapshot = await graph.aget_state(config)
        values = dict(snapshot.values or {})
    except Exception as exc:
        logger.warning("读取中断检查点失败：%s", exc)
        yield _sse({"event": "error", "message": "审批会话已失效，请重新提问。"})
        return

    acc = _new_acc()
    acc["evidence"] = list(values.get("evidence") or [])
    acc["retrieval"] = values.get("retrieval") or {}
    question = str(values.get("question") or "")
    app = str(values.get("app") or "ecommerce")
    session_id = str(values.get("session_id") or "")
    customer_id = values.get("customer_id") or None

    yield _sse({"event": "status", "label": "已收到审批结果，继续处理"})

    try:
        async for frame in _consume_stream(
            graph, Command(resume={"approved": approved, "by": by}), config, started, acc
        ):
            yield frame
    except Exception as exc:
        logger.exception("HITL 恢复异常")
        await _persist_trace(
            session_id, app, question, acc, status="error",
            latency_ms=int((time.perf_counter() - started) * 1000), error=str(exc),
        )
        yield _sse({"event": "error", "message": _friendly_error(str(exc))})
        return

    if acc["interrupt"]:
        await _persist_trace(
            session_id, app, question, acc, status="interrupted",
            latency_ms=int((time.perf_counter() - started) * 1000),
        )
        yield _sse(
            {
                "event": "interrupt",
                "thread_id": thread_id,
                "session_id": session_id,
                "app": app,
                "payload": acc["interrupt"],
            }
        )
        yield "data: [DONE]\n\n"
        return

    answer = "".join(acc["answer_parts"])
    latency_ms = int((time.perf_counter() - started) * 1000)
    if not answer:
        yield _sse({"event": "error", "message": "审批后模型没有返回内容，请重新提问。"})
        return

    await _save_history(app, session_id, question, answer)
    await _persist(session_id, customer_id, question, answer, acc["usage"], settings.zhipu_chat_model, latency_ms)
    await _persist_trace(session_id, app, question, acc, status="ok", latency_ms=latency_ms)
    await _drop_checkpoint(thread_id)

    for frame in _final_frames(question, acc, started):
        yield frame


@router.post("/resume")
async def resume(body: ResumeRequest, customer: Customer | None = Depends(optional_customer)):
    """HITL 审批回调：前端带着原来的 thread_id 回来，批准或拒绝写操作。"""
    thread_id = (body.thread_id or "").strip()
    if not thread_id:
        raise HTTPException(status_code=400, detail="thread_id 不能为空")

    return StreamingResponse(
        _resume_stream(thread_id, body.approved, body.by, time.perf_counter()),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


@router.post("/chat")
async def chat(body: ChatRequest, customer: Customer | None = Depends(optional_customer)):
    started = time.perf_counter()
    question = (body.message or "").strip()
    if not question:
        raise HTTPException(status_code=400, detail="消息不能为空")

    session_id = (body.session_id or "").strip()
    if not session_id:
        session_id = f"c-{customer.id}" if customer else "guest-demo"

    app = (body.app or "ecommerce").strip().lower()
    if app not in VALID_APPS:
        raise HTTPException(status_code=400, detail=f"未知的 AI 应用：{app}")

    quota_message = await _check_chat_quota(app, session_id)
    if quota_message:
        return _quota_sse(quota_message)

    return StreamingResponse(
        _event_stream(
            question,
            session_id,
            customer.id if customer else None,
            customer.name if customer else "游客",
            app,
            started,
        ),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )
