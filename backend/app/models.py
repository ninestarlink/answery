"""SQLAlchemy ORM 模型，字段与 db/01_schema.sql 一一对应。

这里只定义运行时真正会查询的表；talk_templates 仅作为知识库的话术落库预留表，
当前不参与代码逻辑。
"""

from datetime import date, datetime
from decimal import Decimal

from sqlalchemy import (
    JSON,
    BigInteger,
    Date,
    DateTime,
    Float,
    Integer,
    Numeric,
    String,
    Text,
    func,
)
from sqlalchemy.orm import Mapped, mapped_column

from .database import Base


class Product(Base):
    """商品主表（商品图由前端按 id 复用静态资源，这里只存相对路径）。"""

    __tablename__ = "products"

    id: Mapped[str] = mapped_column(String(16), primary_key=True)
    name: Mapped[str] = mapped_column(String(64))
    subtitle: Mapped[str | None] = mapped_column(String(128), default=None)
    category: Mapped[str | None] = mapped_column(String(32), default=None)
    price: Mapped[Decimal] = mapped_column(Numeric(10, 2))
    original_price: Mapped[Decimal | None] = mapped_column(Numeric(10, 2), default=None)
    tags: Mapped[str | None] = mapped_column(String(128), default=None)
    scene_desc: Mapped[str | None] = mapped_column(String(128), default=None)
    description: Mapped[str | None] = mapped_column(Text, default=None)
    image_url: Mapped[str | None] = mapped_column(String(256), default=None)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())


class ProductVariant(Base):
    """SKU：尺码 + 库存。"""

    __tablename__ = "product_variants"

    id: Mapped[str] = mapped_column(String(24), primary_key=True)
    product_id: Mapped[str] = mapped_column(String(16), index=True)
    sku: Mapped[str] = mapped_column(String(32))
    size: Mapped[str] = mapped_column(String(16))
    color: Mapped[str | None] = mapped_column(String(32), default=None)
    stock: Mapped[int] = mapped_column(Integer, default=0)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())


class Customer(Base):
    """客户（登录账号用手机号）。"""

    __tablename__ = "customers"

    id: Mapped[str] = mapped_column(String(16), primary_key=True)
    name: Mapped[str] = mapped_column(String(32))
    phone: Mapped[str] = mapped_column(String(20), unique=True)
    level: Mapped[str] = mapped_column(String(16), default="normal")
    # customer / admin：admin 才能访问 /api/admin/* 与索引重建
    role: Mapped[str] = mapped_column(String(16), default="customer")
    # bcrypt 哈希；为空时回落到演示环境统一密码
    password_hash: Mapped[str | None] = mapped_column(String(128), default=None)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())


class Order(Base):
    """订单主表。"""

    __tablename__ = "orders"

    id: Mapped[str] = mapped_column(String(16), primary_key=True)
    customer_id: Mapped[str] = mapped_column(String(16), index=True)
    status: Mapped[str] = mapped_column(
        String(16),
        comment="pending_payment/paid/shipped/delivered/refunding/completed/cancelled",
    )
    total_amount: Mapped[Decimal] = mapped_column(Numeric(10, 2))
    discount_amount: Mapped[Decimal] = mapped_column(Numeric(10, 2), default=0)
    pay_method: Mapped[str | None] = mapped_column(String(16), default=None)
    address: Mapped[str | None] = mapped_column(String(255), default=None)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())
    paid_at: Mapped[datetime | None] = mapped_column(DateTime, default=None)
    shipped_at: Mapped[datetime | None] = mapped_column(DateTime, default=None)
    delivered_at: Mapped[datetime | None] = mapped_column(DateTime, default=None)


class OrderItem(Base):
    """订单明细。"""

    __tablename__ = "order_items"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    order_id: Mapped[str] = mapped_column(String(16), index=True)
    product_id: Mapped[str] = mapped_column(String(16))
    variant_id: Mapped[str | None] = mapped_column(String(24), default=None)
    product_name: Mapped[str] = mapped_column(String(64))
    size: Mapped[str | None] = mapped_column(String(16), default=None)
    qty: Mapped[int] = mapped_column(Integer, default=1)
    unit_price: Mapped[Decimal] = mapped_column(Numeric(10, 2))


class Shipment(Base):
    """物流单。"""

    __tablename__ = "shipments"

    id: Mapped[str] = mapped_column(String(24), primary_key=True)
    order_id: Mapped[str] = mapped_column(String(16), index=True)
    carrier: Mapped[str] = mapped_column(String(32))
    tracking_no: Mapped[str] = mapped_column(String(32))
    status: Mapped[str] = mapped_column(String(16), comment="created/picked_up/in_transit/delivering/delivered")
    origin_city: Mapped[str | None] = mapped_column(String(32), default=None)
    current_city: Mapped[str | None] = mapped_column(String(32), default=None)
    estimated_delivery: Mapped[date | None] = mapped_column(Date, default=None)
    shipped_at: Mapped[datetime | None] = mapped_column(DateTime, default=None)


class ShipmentEvent(Base):
    """物流轨迹（按时间倒序展示）。"""

    __tablename__ = "shipment_events"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    shipment_id: Mapped[str] = mapped_column(String(24), index=True)
    event_time: Mapped[datetime] = mapped_column(DateTime)
    city: Mapped[str | None] = mapped_column(String(32), default=None)
    description: Mapped[str] = mapped_column(String(128))


class Coupon(Base):
    """优惠券。"""

    __tablename__ = "coupons"

    id: Mapped[str] = mapped_column(String(16), primary_key=True)
    customer_id: Mapped[str | None] = mapped_column(String(16), index=True, default=None)
    code: Mapped[str] = mapped_column(String(24), unique=True)
    name: Mapped[str] = mapped_column(String(64))
    discount_amount: Mapped[Decimal] = mapped_column(Numeric(10, 2))
    min_amount: Mapped[Decimal] = mapped_column(Numeric(10, 2), default=0)
    valid_from: Mapped[date] = mapped_column(Date)
    valid_to: Mapped[date] = mapped_column(Date)
    status: Mapped[str] = mapped_column(String(16), default="unused", comment="unused/used")


class StorePolicy(Base):
    """店铺政策（与 facts.md 保持一致的唯一事实源）。"""

    __tablename__ = "store_policies"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    policy_key: Mapped[str] = mapped_column(String(32), unique=True)
    title: Mapped[str] = mapped_column(String(64))
    content: Mapped[str] = mapped_column(Text)
    updated_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())


class ChatHistory(Base):
    """会话记录（Token 记账 + 事后审计）。"""

    __tablename__ = "chat_history"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    session_id: Mapped[str] = mapped_column(String(64), index=True)
    customer_id: Mapped[str | None] = mapped_column(String(16), default=None)
    role: Mapped[str] = mapped_column(String(16), comment="user/assistant")
    content: Mapped[str] = mapped_column(Text)
    prompt_tokens: Mapped[int] = mapped_column(Integer, default=0)
    completion_tokens: Mapped[int] = mapped_column(Integer, default=0)
    total_tokens: Mapped[int] = mapped_column(Integer, default=0)
    model: Mapped[str | None] = mapped_column(String(64), default=None)
    latency_ms: Mapped[int] = mapped_column(Integer, default=0)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())


class ChatTrace(Base):
    """一次问答的执行轨迹：检索、工具、降级、首 Token 延迟，用于排障与效果复盘。"""

    __tablename__ = "chat_trace"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    session_id: Mapped[str] = mapped_column(String(64), index=True)
    app: Mapped[str] = mapped_column(String(16), default="ecommerce")
    question: Mapped[str] = mapped_column(String(255))
    # ok / interrupted / error
    status: Mapped[str] = mapped_column(String(16), default="ok")
    hits: Mapped[int] = mapped_column(Integer, default=0)
    tools: Mapped[int] = mapped_column(Integer, default=0)
    tool_names: Mapped[str | None] = mapped_column(String(255), default=None)
    degraded: Mapped[str | None] = mapped_column(String(128), default=None)
    first_token_ms: Mapped[int] = mapped_column(Integer, default=0)
    latency_ms: Mapped[int] = mapped_column(Integer, default=0)
    total_tokens: Mapped[int] = mapped_column(Integer, default=0)
    error: Mapped[str | None] = mapped_column(String(255), default=None)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())


class EvalDataset(Base):
    """评测数据集：一组金标用例，可按版本迭代。"""

    __tablename__ = "eval_dataset"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    code: Mapped[str] = mapped_column(String(32), unique=True)
    name: Mapped[str] = mapped_column(String(64))
    description: Mapped[str | None] = mapped_column(String(255), default=None)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())


class EvalCase(Base):
    """单条金标用例：问题 + 期望命中的文档，用于检索质量回归。"""

    __tablename__ = "eval_case"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    dataset_id: Mapped[int] = mapped_column(Integer, index=True)
    case_no: Mapped[str] = mapped_column(String(16), comment="数据集内编号，如 E01")
    question: Mapped[str] = mapped_column(String(255))
    kb_id: Mapped[str] = mapped_column(String(16), comment="shop / enterprise")
    expected_doc: Mapped[str] = mapped_column(String(128), comment="期望命中的文档名")
    expected_keywords: Mapped[str | None] = mapped_column(
        String(255), default=None, comment="逗号分隔的答案要点，供人工复盘"
    )
    category: Mapped[str] = mapped_column(String(32))
    difficulty: Mapped[str] = mapped_column(String(8), default="normal")
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())


class EvalRun(Base):
    """一次批量评测的汇总结果，前端按 run 对比新旧版本。"""

    __tablename__ = "eval_run"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    dataset_id: Mapped[int] = mapped_column(Integer, index=True)
    status: Mapped[str] = mapped_column(
        String(16), default="running", comment="running/completed/failed"
    )
    engine: Mapped[str] = mapped_column(String(32), default="hybrid+rerank")
    top_k: Mapped[int] = mapped_column(Integer, default=5)
    case_count: Mapped[int] = mapped_column(Integer, default=0)
    hit_count: Mapped[int] = mapped_column(Integer, default=0)
    hit_rate: Mapped[float] = mapped_column(Float, default=0.0)
    mrr: Mapped[float] = mapped_column(Float, default=0.0)
    avg_latency_ms: Mapped[int] = mapped_column(Integer, default=0)
    p95_latency_ms: Mapped[int] = mapped_column(Integer, default=0)
    degraded_count: Mapped[int] = mapped_column(Integer, default=0)
    note: Mapped[str | None] = mapped_column(String(128), default=None)
    error: Mapped[str | None] = mapped_column(String(255), default=None)
    started_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())
    finished_at: Mapped[datetime | None] = mapped_column(DateTime, default=None)


class EvalResult(Base):
    """单条用例的执行结果：排名、耗时、Top 文档，支持下钻复盘。"""

    __tablename__ = "eval_result"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    run_id: Mapped[int] = mapped_column(BigInteger, index=True)
    case_id: Mapped[int] = mapped_column(BigInteger)
    case_no: Mapped[str] = mapped_column(String(16))
    question: Mapped[str] = mapped_column(String(255))
    kb_id: Mapped[str] = mapped_column(String(16))
    expected_doc: Mapped[str] = mapped_column(String(128))
    retrieved_doc: Mapped[str | None] = mapped_column(String(128), default=None)
    rank: Mapped[int] = mapped_column(Integer, default=0, comment="期望文档首次出现的位次，0=未命中")
    hit: Mapped[int] = mapped_column(Integer, default=0)
    latency_ms: Mapped[int] = mapped_column(Integer, default=0)
    degraded: Mapped[str | None] = mapped_column(String(128), default=None)
    top_docs: Mapped[str | None] = mapped_column(Text, default=None, comment="TopK 文档名，逗号分隔")
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())


class Ticket(Base):
    """IT 工单：由本地规则引擎从自然语言报障生成，字段全部可解释。"""

    __tablename__ = "tickets"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    ticket_no: Mapped[str] = mapped_column(String(24), unique=True)
    reporter: Mapped[str] = mapped_column(String(32), default="匿名员工")
    department: Mapped[str | None] = mapped_column(String(32), default=None)
    description: Mapped[str] = mapped_column(Text)
    category: Mapped[str] = mapped_column(String(24))
    category_label: Mapped[str] = mapped_column(String(32))
    priority: Mapped[str] = mapped_column(String(4), comment="P0/P1/P2/P3")
    assignee_group: Mapped[str] = mapped_column(String(48))
    sla_response: Mapped[str] = mapped_column(String(32))
    sla_resolve: Mapped[str] = mapped_column(String(32))
    status: Mapped[str] = mapped_column(
        String(16), default="new", comment="new/in_progress/resolved"
    )
    matched_keywords: Mapped[list] = mapped_column(JSON, default=list)
    missing_info: Mapped[list] = mapped_column(JSON, default=list)
    suggestions: Mapped[list] = mapped_column(JSON, default=list)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, server_default=func.now(), onupdate=func.now()
    )
