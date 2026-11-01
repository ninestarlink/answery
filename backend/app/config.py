"""全局配置：统一从 backend/.env 读取，缺省值保证本地可以直接跑起来。

大模型只依赖智谱（OpenAI 兼容接口），知识库检索与向量存储全部在本项目内完成，
不再依赖 Dify。
"""

from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict

_ENV_FILE = Path(__file__).resolve().parent.parent / ".env"


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=_ENV_FILE,
        env_file_encoding="utf-8",
        extra="ignore",
    )

    # ---------- 应用 ----------
    app_name: str = "企业级 AI 客服 Agent 平台"
    app_env: str = "dev"
    secret_key: str = "demo-secret-change-me"
    jwt_expire_minutes: int = 24 * 60
    # 演示账号统一密码（生产环境应改为数据库 password_hash + bcrypt 校验）
    demo_password: str = "demo1234"
    cors_origins: str = "http://localhost:3000,http://127.0.0.1:3000"

    # ---------- MySQL ----------
    mysql_host: str = "127.0.0.1"
    mysql_port: int = 3306
    mysql_user: str = "ecom"
    mysql_password: str = "ecom123456"
    mysql_db: str = "ecom_ai_demo"

    # ---------- Redis（最近 N 轮上下文） ----------
    redis_url: str = "redis://127.0.0.1:6379/0"

    # ---------- PostgreSQL + pgvector（自建知识库） ----------
    # 单独一个库，不复用 Dify 自带的 postgres；端口用 5433 避免冲突
    pg_dsn: str = "postgresql://rag:rag123456@127.0.0.1:5433/rag"
    # 知识库索引维度，必须与 embedding 模型输出一致
    rag_embedding_dims: int = 1024

    # ---------- 检索参数 ----------
    rag_dense_top_k: int = 30
    rag_sparse_top_k: int = 30
    rag_rerank_top_k: int = 8
    # RRF 融合常数，经验值 60
    rag_rrf_k: int = 60
    # 精排分数阈值，低于该值视为「没有依据」
    rag_min_score: float = 0.3
    # 送进模型的上下文最大字符数
    rag_max_chars: int = 3200

    # ---------- 对话模型（智谱，OpenAI 兼容） ----------
    zhipu_api_base: str = "https://open.bigmodel.cn/api/paas/v4"
    zhipu_api_key: str = ""
    zhipu_chat_model: str = "glm-4-flash"

    # ---------- 向量化 / 精排（默认硅基流动，可与对话模型分开计费） ----------
    # embedding_provider 取 siliconflow 或 zhipu
    embedding_provider: str = "siliconflow"
    siliconflow_api_base: str = "https://api.siliconflow.cn/v1"
    siliconflow_api_key: str = ""
    # bge-m3 输出 1024 维，与 rag_embedding_dims / pgvector 表结构一致
    siliconflow_embedding_model: str = "Pro/BAAI/bge-m3"
    siliconflow_rerank_model: str = "Pro/BAAI/bge-reranker-v2-m3"
    # 仅 provider=zhipu 时生效
    zhipu_embedding_model: str = "embedding-3"
    zhipu_rerank_model: str = "rerank"
    # 工单 AI 语义补充的单独开关，未配置时只走规则引擎
    ticket_ai_enabled: bool = True
    ticket_ai_timeout: float = 15.0
    # 每个会话携带的历史轮数（1 轮 = 一问一答）
    history_rounds: int = 3
    # 模型流式响应超时（秒）
    request_timeout: float = 120.0

    # ---------- 网页抓取 ----------
    # 已移除网页抓取 / 比价 / 多模态等小工具，项目聚焦电商客服与企业知识库

    @property
    def mysql_dsn(self) -> str:
        """SQLAlchemy 异步连接串。"""
        return (
            f"mysql+aiomysql://{self.mysql_user}:{self.mysql_password}"
            f"@{self.mysql_host}:{self.mysql_port}/{self.mysql_db}?charset=utf8mb4"
        )

    @property
    def cors_origin_list(self) -> list[str]:
        return [o.strip() for o in self.cors_origins.split(",") if o.strip()]


settings = Settings()
