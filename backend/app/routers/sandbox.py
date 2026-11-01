"""沙箱接口：跑一段代码、看一下池子状态。

只对已登录用户开放，并按账号做 10 分钟 20 次的演示额度，
避免公网部署时被人当成免费算力。
"""

import logging
from datetime import date

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from .. import sandbox
from ..config import settings
from ..database import get_redis
from ..models import Customer
from .auth import require_customer

logger = logging.getLogger("app.sandbox.api")

router = APIRouter(prefix="/api/sandbox", tags=["sandbox"])

_WINDOW = 600


class RunRequest(BaseModel):
    language: str = Field(default="python", description="python / node")
    code: str = Field(description="要执行的代码")


async def _check_quota(customer: Customer) -> None:
    redis = get_redis()
    try:
        key = f"sandbox:quota:{date.today().isoformat()}:{customer.id}"
        count = await redis.incr(key)
        if count == 1:
            await redis.expire(key, _WINDOW)
        if count > settings.sandbox_quota:
            raise HTTPException(status_code=429, detail="沙箱演示额度已用完，请 10 分钟后再试")
    except HTTPException:
        raise
    except Exception:  # Redis 不可用时放行，不影响功能演示
        return


@router.post("/run")
async def run_code(body: RunRequest, customer: Customer = Depends(require_customer)):
    await _check_quota(customer)
    try:
        result = await sandbox.run_code(body.language, body.code)
    except sandbox.SandboxTimeout as exc:
        raise HTTPException(status_code=408, detail=str(exc)) from exc
    except sandbox.SandboxUnavailable as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    except sandbox.SandboxError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return {"ok": True, **result}


@router.get("/status")
async def sandbox_status(customer: Customer = Depends(require_customer)):
    return sandbox.status()
