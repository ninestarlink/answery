"""LangGraph 状态机：检索 → 决策 → (审批) → 工具 → 再决策 → 回答。

图结构（带检查点，可在写操作前中断并恢复）：

    START → retrieve → agent ─┬─(有 tool_calls)-> approval ─┬─(通过)-> tools → agent
                              └─(无 tool_calls)-> END        └─(拒绝)-> agent

设计要点：
- 检索放在模型之前，模型拿到的是「父块 + 文档坐标」而不是零散片段；
- 工具轮数硬上限 3，防止模型无限重试同一个工具；
- 企业知识库应用不绑定工具，纯检索问答，避免越权查业务数据；
- 创建人工工单属于写操作，先 interrupt 等人工确认，拒绝则改走自助方案。
"""

from __future__ import annotations

import logging
from typing import Annotated, Any, TypedDict

from langchain_core.messages import AnyMessage, SystemMessage, ToolMessage
from langchain_openai import ChatOpenAI
from langgraph.checkpoint.memory import InMemorySaver
from langgraph.graph import END, START, StateGraph
from langgraph.graph.message import add_messages
from langgraph.prebuilt import ToolNode
from langgraph.types import interrupt

from ..config import settings
from ..rag import retriever
from .prompts import build_system
from .tools import SHOP_TOOLS

logger = logging.getLogger("agent.graph")

MAX_TOOL_ROUNDS = 3

# 需要人工确认的写操作文案；trigger_automation_job 仅 kb_sync（重建索引）需要确认
APPROVAL_COPY = {
    "create_escalation_ticket": (
        "创建人工工单需要确认",
        "工单会写入业务库并触发人工跟进，属于不可逆写操作",
    ),
    "trigger_automation_job": (
        "同步知识库需要确认",
        "kb_sync 会重建向量索引，属于写操作",
    ),
}


def _needs_approval(call: dict[str, Any]) -> bool:
    name = str(call.get("name") or "")
    if name == "create_escalation_ticket":
        return True
    if name == "trigger_automation_job":
        return str((call.get("args") or {}).get("job_key") or "") == "kb_sync"
    return False


class AgentState(TypedDict, total=False):
    messages: Annotated[list[AnyMessage], add_messages]
    app: str
    kb_id: str
    question: str
    today: str
    customer_name: str
    customer_id: str
    history_text: str
    hints: str
    context: str
    evidence: list[dict[str, Any]]
    retrieval: dict[str, Any]
    tool_rounds: int
    approval: dict[str, Any]


_llm: ChatOpenAI | None = None
_graph = None


def _llm_client() -> ChatOpenAI:
    """对话模型（OpenAI 兼容接口）；流式开启 usage 统计，便于 Token 记账。"""
    global _llm
    if _llm is None:
        _llm = ChatOpenAI(
            model=settings.chat_model,
            base_url=settings.chat_api_base,
            api_key=settings.chat_api_key,
            temperature=0.1,
            timeout=settings.request_timeout,
            max_retries=1,
            streaming=True,
            stream_usage=True,
        )
    return _llm


async def _retrieve(state: AgentState) -> dict[str, Any]:
    app = state.get("app") or "ecommerce"
    kb_id = state.get("kb_id") or ""
    if not settings.zhipu_api_key:
        return {"context": "", "evidence": [], "retrieval": {"degraded": ["检索未启用"]}}

    question = state.get("question") or ""
    try:
        if app == "auto":
            # 统一入口：两个知识库同时召回，由提示词按问题语义挑用
            result = await retriever.search_multi(["shop", "enterprise"], question)
        elif kb_id:
            result = await retriever.search(kb_id, question)
        else:
            return {"context": "", "evidence": [], "retrieval": {"degraded": ["检索未启用"]}}
    except Exception as exc:  # 检索失败不阻断对话，让模型明确「没有资料」
        logger.warning("知识库检索失败：%s", exc)
        return {
            "context": "",
            "evidence": [],
            "retrieval": {"degraded": [f"检索失败：{exc}"]},
        }

    return {
        "context": result["context"],
        "evidence": result["evidence"],
        "retrieval": {
            "hits": len(result["hits"]),
            "timings": result["timings"],
            "degraded": result["degraded"],
            "wiki_pages": len((result.get("wiki") or {}).get("pages") or []),
        },
    }


def _system_message(state: AgentState) -> SystemMessage:
    content = build_system(
        state.get("app") or "ecommerce",
        context=state.get("context") or "",
        today=state.get("today") or "",
        customer_name=state.get("customer_name") or "游客",
        customer_id=state.get("customer_id") or "",
        history_text=state.get("history_text") or "",
        hints=state.get("hints") or "",
    )
    return SystemMessage(content=content)


async def _agent(state: AgentState) -> dict[str, Any]:
    rounds = int(state.get("tool_rounds") or 0)
    # 统一入口也允许调工具：是否调用由提示词按问题类型判断
    can_use_tools = state.get("app") in ("ecommerce", "auto") and rounds < MAX_TOOL_ROUNDS
    llm = _llm_client()
    if can_use_tools:
        llm = llm.bind_tools(SHOP_TOOLS)

    messages = [_system_message(state), *state.get("messages", [])]
    response = await llm.ainvoke(messages)
    return {"messages": [response]}


async def _tools(state: AgentState) -> dict[str, Any]:
    result = await _tool_node.ainvoke(state)
    return {
        "messages": result.get("messages", []),
        "tool_rounds": int(state.get("tool_rounds") or 0) + 1,
        "approval": {},
    }


async def _approval(state: AgentState) -> dict[str, Any]:
    """写操作前的人工闸门：建工单、kb_sync 必须由前端确认后才执行。

    interrupt() 会暂停图并把 payload 传给客户端；恢复时把确认结果作为返回值。
    """
    last = (state.get("messages") or [None])[-1]
    calls = getattr(last, "tool_calls", None) or []
    targets = [c for c in calls if _needs_approval(c)]
    if not targets:
        return {}

    call = targets[0]
    title, reason = APPROVAL_COPY.get(
        str(call.get("name") or ""), ("该操作需要确认", "写操作不可逆")
    )
    payload = {
        "type": "approval",
        "action": call.get("name"),
        "title": title,
        "args": call.get("args") or {},
        "reason": reason,
    }
    decision = interrupt(payload)

    approved = False
    by = ""
    if isinstance(decision, dict):
        approved = bool(decision.get("approved"))
        by = str(decision.get("by") or "")
    else:
        approved = bool(decision)

    if approved:
        return {"approval": {"approved": True, "by": by}}

    # 拒绝后补一条 ToolMessage，让模型改走自助方案，而不是继续调用写工具
    if any(str(c.get("name") or "") == "trigger_automation_job" for c in targets):
        content = "操作已取消：人工确认未通过，任务没有执行。请如实告知用户未执行，不要声称已完成。"
    else:
        content = "操作已取消：人工确认未通过。请改为给出自助解决方案，并告知用户可以稍后联系人工。"
    rejected = [
        ToolMessage(
            content=content,
            tool_call_id=str(c.get("id") or ""),
            name=str(c.get("name") or ""),
        )
        for c in targets
    ]
    return {
        "messages": rejected,
        "approval": {"approved": False, "by": by},
        "tool_rounds": int(state.get("tool_rounds") or 0) + 1,
    }


def _route(state: AgentState) -> str:
    last = (state.get("messages") or [None])[-1]
    calls = getattr(last, "tool_calls", None)
    if calls and int(state.get("tool_rounds") or 0) < MAX_TOOL_ROUNDS:
        return "approval"
    return END


def _route_after_approval(state: AgentState) -> str:
    if (state.get("approval") or {}).get("approved") is False:
        return "agent"
    return "tools"


_tool_node = ToolNode(SHOP_TOOLS)
_checkpointer = InMemorySaver()


def get_graph():
    """编译一次，进程内复用；checkpointer 让中断的图能按 thread_id 恢复。"""
    global _graph
    if _graph is None:
        builder = StateGraph(AgentState)
        builder.add_node("retrieve", _retrieve)
        builder.add_node("agent", _agent)
        builder.add_node("approval", _approval)
        builder.add_node("tools", _tools)
        builder.add_edge(START, "retrieve")
        builder.add_edge("retrieve", "agent")
        builder.add_conditional_edges("agent", _route, {"approval": "approval", END: END})
        builder.add_conditional_edges(
            "approval", _route_after_approval, {"tools": "tools", "agent": "agent"}
        )
        builder.add_edge("tools", "agent")
        _graph = builder.compile(checkpointer=_checkpointer)
    return _graph
