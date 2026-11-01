"""登录与 JWT 鉴权。

密码优先用 customers.password_hash（bcrypt）校验；演示账号未写哈希时
回落到统一的 DEMO_PASSWORD，方便本地零配置跑通。
"""

import time

import bcrypt
import jwt
from fastapi import APIRouter, Depends, Header, HTTPException
from sqlalchemy import or_, select
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.ext.asyncio import AsyncSession

from ..config import settings
from ..database import get_db
from ..models import Customer
from ..schemas import CustomerOut, LoginRequest, LoginResponse

router = APIRouter(prefix="/api/auth", tags=["auth"])


def create_access_token(customer_id: str, role: str = "customer") -> str:
    """签发 HS256 Token，角色写进 claims，接口鉴权不用再查库。"""
    now = int(time.time())
    payload = {
        "sub": customer_id,
        "role": role,
        "iat": now,
        "exp": now + settings.jwt_expire_minutes * 60,
    }
    return jwt.encode(payload, settings.secret_key, algorithm="HS256")


def decode_token(token: str) -> dict:
    """解析 Token 拿到 claims，失败统一抛 401。"""
    try:
        payload = jwt.decode(token, settings.secret_key, algorithms=["HS256"])
    except jwt.PyJWTError as exc:
        raise HTTPException(status_code=401, detail="登录状态无效或已过期") from exc
    if not payload.get("sub"):
        raise HTTPException(status_code=401, detail="登录状态无效")
    return payload


def _bearer_token(authorization: str | None) -> str | None:
    if not authorization:
        return None
    scheme, _, token = authorization.partition(" ")
    if scheme.lower() != "bearer" or not token.strip():
        return None
    return token.strip()


async def optional_customer(
    authorization: str | None = Header(default=None),
    db: AsyncSession = Depends(get_db),
) -> Customer | None:
    """有合法 Token 就带出客户，没有就按游客处理（不拦截请求）。"""
    token = _bearer_token(authorization)
    if not token:
        return None
    try:
        claims = decode_token(token)
        customer_id = str(claims["sub"])
    except HTTPException:
        return None
    try:
        return await db.get(Customer, customer_id)
    except SQLAlchemyError:
        # 数据库挂了也不拦截请求，按游客继续（聊天主流程会自己给出提示）
        return None


async def require_customer(customer: Customer | None = Depends(optional_customer)) -> Customer:
    if customer is None:
        raise HTTPException(status_code=401, detail="请先登录")
    return customer


async def require_admin(customer: Customer = Depends(require_customer)) -> Customer:
    """管理接口统一入口：校验角色，未授权一律 403。"""
    if customer.role != "admin":
        raise HTTPException(status_code=403, detail="需要管理员权限")
    return customer


def _verify_password(customer: Customer, password: str) -> bool:
    if customer.password_hash:
        try:
            return bcrypt.checkpw(password.encode(), customer.password_hash.encode())
        except ValueError:
            return False
    return password == settings.demo_password


@router.post("/login", response_model=LoginResponse)
async def login(body: LoginRequest, db: AsyncSession = Depends(get_db)):
    try:
        customer = await db.scalar(
            select(Customer).where(
                or_(Customer.phone == body.username, Customer.id == body.username)
            )
        )
    except SQLAlchemyError as exc:
        raise HTTPException(status_code=503, detail="数据库不可用，请先启动 MySQL 容器") from exc

    if customer is None:
        raise HTTPException(status_code=404, detail="客户不存在，演示手机号：13800001234")

    if not _verify_password(customer, body.password):
        raise HTTPException(status_code=401, detail="密码错误")

    return LoginResponse(
        access_token=create_access_token(customer.id, customer.role),
        expires_in=settings.jwt_expire_minutes * 60,
        customer=CustomerOut.model_validate(customer),
    )


@router.get("/me", response_model=CustomerOut)
async def me(customer: Customer = Depends(require_customer)):
    return customer
