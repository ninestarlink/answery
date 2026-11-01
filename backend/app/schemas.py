"""请求 / 响应数据模型。"""

from pydantic import BaseModel, Field


class LoginRequest(BaseModel):
    username: str = Field(..., description="手机号或客户编号")
    password: str


class CustomerOut(BaseModel):
    id: str
    name: str
    phone: str
    level: str
    role: str = "customer"

    model_config = {"from_attributes": True}


class LoginResponse(BaseModel):
    access_token: str
    token_type: str = "bearer"
    expires_in: int
    customer: CustomerOut


class ChatRequest(BaseModel):
    """与前端 frontend/lib/types.ts 的 ChatRequestBody 对齐。"""

    message: str
    session_id: str | None = None
    # AI 应用标识：ecommerce = 电商客服（RAG + 工具调用）；enterprise = 企业知识库问答
    app: str = Field("ecommerce", description="AI 应用标识：ecommerce / enterprise")


class ResumeRequest(BaseModel):
    """HITL 恢复：前端把中断事件里的 thread_id 原样带回，并给出审批结果。"""

    thread_id: str
    approved: bool
    by: str = "管理员"


class ToolCallRequest(BaseModel):
    """统一的工具调用入口：外部系统可一次性打到 /api/tools/invoke。"""

    name: str
    arguments: dict = Field(default_factory=dict)


class TicketCreate(BaseModel):
    """一句话报障，其余字段由后端规则引擎推导。"""

    description: str = Field(..., description="问题描述")
    reporter: str = Field("匿名员工", description="报障人")
    department: str | None = Field(None, description="部门")


class TicketStatusUpdate(BaseModel):
    """演示用状态流转：new → in_progress → resolved。"""

    status: str = Field(..., description="new / in_progress / resolved")
