"""IT 工单 AI 语义分析：直连智谱 GLM-4-Flash，补充规则引擎理解不到的信息。

分工：
- 规则引擎决定类别、优先级、指派组、SLA —— 确定性、可复现，演示不会翻车；
- 模型只做语义补充：问题摘要、可能原因、一线处置建议、风险提示；
- 未配置 / 超时 / 返回异常时返回 None，工单照常生成，不让模型拖垮主流程。
"""

from __future__ import annotations

import json
import logging
import re
import time

import httpx

from .config import settings

logger = logging.getLogger("ticket_ai")

MODEL_LABEL = "GLM-4-Flash"

_SYSTEM_PROMPT = """你是企业 IT 服务台的工单助手。根据员工描述的问题和规则引擎给出的分级，
输出严格的 JSON（不要任何解释文字），字段：
{
  "summary": "一句话问题摘要（不超过 40 字）",
  "possible_causes": ["可能原因，最多 3 条"],
  "actions": ["一线可先尝试的处置步骤，最多 4 条"],
  "risk": "如果不处理可能造成的影响，一句话"
}
不要推翻规则引擎给出的类别与优先级，只做补充。"""


def _strip_fences(text: str) -> str:
    """模型偶尔会套一层 ```json 代码块，先剥掉。"""
    cleaned = text.strip()
    if cleaned.startswith("```"):
        cleaned = re.sub(r"^```[a-zA-Z]*\s*", "", cleaned)
        cleaned = re.sub(r"\s*```$", "", cleaned)
    return cleaned.strip()


def _parse(text: str) -> dict | None:
    """把模型输出解析成前端可直接渲染的结构；格式不符时返回 None。"""
    cleaned = _strip_fences(text)
    start = cleaned.find("{")
    end = cleaned.rfind("}")
    if start < 0 or end <= start:
        return None
    try:
        data = json.loads(cleaned[start : end + 1])
    except json.JSONDecodeError:
        return None
    if not isinstance(data, dict):
        return None

    def _one_line(value) -> str:
        # 模型偶尔会在词中间插入换行，压平成单行，避免前端出现断裂文字
        return " ".join(str(value).split())

    def _str_list(value) -> list[str]:
        if not isinstance(value, list):
            return []
        return [_one_line(v)[:60] for v in value if _one_line(v)][:4]

    summary = _one_line(data.get("summary") or "")
    if not summary:
        return None
    return {
        "summary": summary[:120],
        "possible_causes": _str_list(data.get("possible_causes")),
        "actions": _str_list(data.get("actions")),
        "risk": _one_line(data.get("risk") or "")[:120],
    }


async def analyze_ticket(description: str, rule_summary: str) -> dict | None:
    """调用智谱对话接口；未配置 Key、超时或返回异常时返回 None（降级为纯规则）。"""
    if not settings.ticket_ai_enabled or not settings.zhipu_api_key:
        return None

    started = time.perf_counter()
    payload = {
        "model": settings.zhipu_chat_model,
        "messages": [
            {"role": "system", "content": _SYSTEM_PROMPT},
            {
                "role": "user",
                "content": f"问题描述：{description}\n\n规则引擎结论：\n{rule_summary}",
            },
        ],
        "temperature": 0.2,
        "stream": False,
    }

    try:
        async with httpx.AsyncClient(timeout=settings.ticket_ai_timeout) as client:
            resp = await client.post(
                f"{settings.zhipu_api_base.rstrip('/')}/chat/completions",
                json=payload,
                headers={
                    "Authorization": f"Bearer {settings.zhipu_api_key}",
                    "Content-Type": "application/json",
                },
            )
    except httpx.HTTPError as exc:
        logger.warning("工单 AI 分析请求失败，降级为纯规则结果：%s", exc)
        return None

    if resp.status_code != 200:
        logger.warning("工单 AI 分析返回 HTTP %s：%s", resp.status_code, resp.text[:200])
        return None

    try:
        body = resp.json()
    except json.JSONDecodeError:
        logger.warning("工单 AI 分析返回非 JSON，降级为纯规则结果")
        return None

    choices = body.get("choices") or []
    raw = str((choices[0].get("message") or {}).get("content") or "") if choices else ""
    parsed = _parse(raw)
    if parsed is None:
        # 模型没按 JSON 输出时，把清理后的原文当摘要，页面至少仍有分析内容
        fallback = _strip_fences(raw).strip()
        if not fallback:
            return None
        parsed = {
            "summary": fallback[:120],
            "possible_causes": [],
            "actions": [],
            "risk": "",
        }

    usage = body.get("usage") or {}
    parsed.update(
        {
            "model": MODEL_LABEL,
            "latency_ms": int((time.perf_counter() - started) * 1000),
            "tokens": int(usage.get("total_tokens") or 0),
        }
    )
    return parsed
