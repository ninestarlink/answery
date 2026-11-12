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

    # ---------- Neo4j（知识图谱关系层） ----------
    # 向量仍在 pgvector；Neo4j 只存实体页与关系边，用 chunk_id 关联。
    neo4j_enabled: bool = True
    neo4j_uri: str = "bolt://127.0.0.1:7687"
    neo4j_user: str = "neo4j"
    neo4j_password: str = "neo4j123456"
    neo4j_database: str = "neo4j"

    # ---------- 检索参数 ----------
    rag_dense_top_k: int = 30
    rag_sparse_top_k: int = 30
    rag_rerank_top_k: int = 8
    # RRF 融合常数，经验值 60
    rag_rrf_k: int = 60
    # 精排分数阈值，低于该值视为「没有依据」
    # 两家 rerank 的分数量纲不同：智谱 rerank 常见 0.5-0.95，bge-reranker 压缩在 0.0-0.3
    rag_min_score: float = 0.3
    rag_min_score_siliconflow: float = 0.08
    # 送进模型的上下文最大字符数
    rag_max_chars: int = 3200

    # ---------- LLMWiki 关系知识层 ----------
    # 实体页 + wikilink/backlink 做知识组织，检索时作为额外的关系召回通道，
    # 与向量 / BM25 共用同一次 rerank，不替换原混合检索。
    wiki_enabled: bool = True
    # 关系扩展跳数：2 跳覆盖「商品 → 售后政策」「制度 A → 制度 B → 引用制度 C」
    wiki_hop: int = 2
    # 单次关系检索最多带出的实体页数量
    wiki_max_pages: int = 4
    # 关系上下文注入提示词的最大字符数
    wiki_context_chars: int = 700
    # 实体页 / 关系边内存缓存时长（秒）
    wiki_cache_ttl: int = 60
    # 命中实体页后，其原文章节在精排分上获得的小幅实体先验加成。
    # 语义是「问题已经明确指向这个实体」，比单块词面重合更可靠，但仍由精排主导排序。
    wiki_score_boost: float = 0.05

    # ---------- 对话模型（默认硅基流动；智谱配置保留备用） ----------
    # chat_provider 取 siliconflow 或 zhipu
    chat_provider: str = "siliconflow"
    siliconflow_chat_model: str = "deepseek-ai/DeepSeek-V3.2"
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

    # ---------- 代码执行沙箱（Docker，可选能力） ----------
    sandbox_enabled: bool = True
    sandbox_timeout: int = 8
    sandbox_memory: str = "512m"
    sandbox_cpus: float = 1.0
    sandbox_code_limit: int = 4000
    # 同一段代码的命中结果在 Redis 里缓存多久（秒）
    sandbox_cache_ttl: int = 600
    # 单个账号 10 分钟内最多执行次数
    sandbox_quota: int = 20

    # ---------- ERP 集成（适配层 + Mock ERP） ----------
    # erp_mode: local（只查本地库）/ mock（内置虚构 ERP，默认开箱即用）/ http（真实网关）
    erp_mode: str = "mock"
    erp_base_url: str = ""
    erp_api_token: str = ""
    erp_timeout: float = 5.0
    # Mock ERP 服务的 Bearer Token，独立进程与主应用挂载共用
    mock_erp_token: str = "demo-erp-token"

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

    # ---------- 对话模型解析 ----------
    @property
    def chat_api_base(self) -> str:
        if self.chat_provider == "siliconflow":
            return self.siliconflow_api_base
        return self.zhipu_api_base

    @property
    def chat_api_key(self) -> str:
        if self.chat_provider == "siliconflow":
            return self.siliconflow_api_key
        return self.zhipu_api_key

    @property
    def chat_model(self) -> str:
        if self.chat_provider == "siliconflow":
            return self.siliconflow_chat_model
        return self.zhipu_chat_model


settings = Settings()
