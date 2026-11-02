# AnswerY智能客服中台

> AnswerY = **Answer You**。一个自建 RAG + LangGraph Agent 的客服中台：**回答带出处、写操作先审批、全过程可回放**，覆盖电商导购与企业制度问答。

同一套 Agent 运行时、同一条检索链路、同一套鉴权与监控。工作台只有一个输入框——商品、订单、制度问题都能问，系统按语义判断该查文档还是调工具。

![stack](https://img.shields.io/badge/React-18-149ECA) ![stack](https://img.shields.io/badge/Next.js-14-000000) ![stack](https://img.shields.io/badge/FastAPI-0.162-009688) ![stack](https://img.shields.io/badge/LangGraph-1.2-1C3C3C) ![stack](https://img.shields.io/badge/pgvector-0.8-336791)

## 这个项目解决什么问题

企业做客服智能化，常见做法是接一个开源问答平台，把文档丢进去，然后被三个问题卡住：

1. **回答不可追溯**：员工或客户追问「依据是哪份文件、哪一版」，系统答不上来；
2. **只会说话不会办事**：查订单、查物流、建工单这类动作，纯 RAG 做不到；
3. **不可控**：写操作（建工单、退款）直接执行，出问题没人兜底。

AnswerY 针对这三点做了完整闭环：**引用到章节与页码 → 工具调用 → 写操作人工审批 → 全链路轨迹可查**。

## 功能一览

### 一、自建 RAG

- **多格式解析**：PDF / DOCX / XLSX / Markdown / TXT
- **父子切片**：父块保留完整章节上下文，子块用于向量召回，命中后回溯父块，避免「一句半句」式引用
- **混合检索**：pgvector（HNSW，1024 维）+ 中文二元组 BM25，RRF 融合排序，再走一轮 rerank
- **引用溯源**：回答末尾标注「文档名｜文档编号｜版本｜章节｜页码」，前端来源卡片只展示答案真正引用到的文档
- **降级策略**：模型额度 429 时熔断 300 秒并自动降级为 BM25-only，前端明确提示「本轮为降级检索」，不假装正常

### 二、Agent 编排（LangGraph）

- 意图路由：先判断「查知识 / 调工具 / 直答」，再决定是否进工具循环
- 6 个业务工具：商品检索、商品详情、订单查询、店铺政策、优惠券、创建升级工单
- **真实体归一**：问题里的商品名 / 订单号先做一次确定性解析，把真实 `product_id` 写进约束，避免模型瞎猜 ID

### 三、人工审批（HITL）

- 写操作（`create_escalation_ticket`）触发 LangGraph `interrupt()`，图停在审批节点
- 前端弹出审批卡片：动作、参数、原因一目了然，可批准 / 拒绝
- 批准 → 继续执行工具；拒绝 → 注入一条 `ToolMessage`，模型改走自助方案
- 审批状态由 checkpointer 持有，通过 `POST /api/chat/resume` 恢复，SSE 流不中断体验

### 四、代码执行沙箱（可选，需要本机 Docker）

AI 会写代码是一回事，敢让它在本机跑是另一回事。这里给了一个最小但真实的隔离执行环境：每种语言常驻一个预热容器，代码通过 `exec` 注入，跑完容器保留复用；超时或异常直接销毁重建。

| 加固项 | 实际参数 |
| --- | --- |
| 根文件系统 | `read_only`，代码改不了镜像 |
| 临时目录 | `/tmp` 内存盘，64 MB，`mode=1777` |
| 内存 / CPU | `mem_limit=512m`、`nano_cpus=1.0` |
| 网络 | `network_mode=none`，容器内没有任何出口 |
| 权限 | `cap_drop=ALL` + `no-new-privileges:true` |
| 进程 / 用户 | `pids_limit=64`、`65534:65534` 非 root |
| 超时 | 8 秒，超时立即 kill 并重建一个干净容器 |
| 结果缓存 | 相同代码命中 Redis 缓存，10 分钟内不再进容器 |

状态机：`CREATE → WARM → CLAIMED →（命中缓存 CACHED）→ DESTROY → CREATE`。

```bash
curl -X POST http://127.0.0.1:8000/api/sandbox/run \
  -H "Authorization: Bearer <token>" -H "Content-Type: application/json" \
  -d '{"language":"python","code":"print(sum(range(10)))"}'
```

`GET /api/sandbox/status` 返回 Docker 版本、镜像是否就绪、各项限制与当前池状态。首次启动会自动拉起 `python:3.11-alpine`、`node:20-alpine` 并预热；Docker 不可用时接口返回 503，不影响客服主流程。

### 五、可观测与安全

- **对话轨迹**：每轮写入 `chat_trace`（命中数、工具、降级原因、首 Token 延迟、总耗时、Token 用量）
- **鉴权闭环**：JWT（含 `role` claim）+ bcrypt 密码 + RBAC，管理端与索引重建接口均需 admin
- **工具幂等**：建工单按「报障人 + 描述」做 10 分钟 Redis 去重，模型重试不会重复建单
- **额度保护**：单会话 10 分钟 30 轮、全站每天 1000 轮，Redis 故障时放行不影响可用性
- **敏感信息**：`.env`、日志、缓存全部 gitignore；演示数据均为虚构

## 架构

```text
┌────────────────────────────── 浏览器（Next.js 14 / React 18）──────────────────────────────┐
│  统一工作台：单输入框混合问答 · 审批卡片 · 来源卡片 · 知识库管理 · 运行监控                  │
└───────────────┬──────────────────────────────────────────────────────────────────────────────┘
                │ 同源 /api（rewrites 转发，避免跨域）
┌───────────────▼──────────────────────────── FastAPI ──────────────────────────────────────────┐
│ 鉴权层   JWT + bcrypt + RBAC                       SSE 层   统一事件帧（status/message/…）   │
│ ─────────────────────────────────────────────────────────────────────────────────────────── │
│ 编排层   LangGraph：route → agent ⇄ tools → approval(interrupt) → resume                      │
│ 检索层   解析 → 父子切片 → embedding → pgvector+BM25 → RRF → rerank → 证据链                 │
│ 工具层   商品 / 订单 / 政策 / 优惠券 / 工单（Redis 幂等）                                     │
│ 记账层   chat_history（Token 成本） · chat_trace（执行轨迹）                                  │
└──────────┬───────────────────────┬──────────────────────────────┬───────────────────────────┘
           │                       │                              │
      MySQL 8                 Redis 7                    PostgreSQL + pgvector
   业务库/会话/轨迹      历史上下文/额度/幂等        知识库向量（独立实例，端口 5433）
```

## 目录结构

```text
.
├── backend/
│   ├── app/
│   │   ├── agent/          # LangGraph 图、工具、提示词
│   │   ├── rag/            # 解析、切片、embedding、向量库、BM25、检索编排
│   │   ├── routers/        # chat / rag / admin / auth / tickets / tools
│   │   ├── config.py       # 环境变量
│   │   ├── models.py       # ORM
│   │   ├── sandbox.py      # Docker 预热池与隔离执行
│   │   └── main.py         # 应用入口与健康检查
│   ├── db/                 # 建表与种子数据（首次启动自动执行）
│   ├── scripts/            # 冒烟测试、检索评测、沙箱验收
│   └── docker-compose.yml  # MySQL / Redis / pgvector
├── frontend/               # Next.js 14 App Router
│   ├── app/                # 页面：工作台、知识库、监控、登录
│   ├── components/         # 对话、消息、审批卡、来源卡、侧栏
│   └── lib/                # SSE 客户端、鉴权、会话 store
├── enterprise_kb/          # 企业制度知识库（11 份虚构文档：手册/报销/采购/安全/合规等）
├── shop_kb/                # 电商商品知识库（5 份：商品、配送、退换、券、尺码）
└── start-demo.bat          # Windows 一键启动
```

## 快速开始

前置：Docker Desktop、Python 3.11+、Node.js 20+。

```bash
# 1. 启动 MySQL / Redis / pgvector
docker compose -f backend/docker-compose.yml up -d

# 2. 后端
cd backend
python -m venv .venv
.venv\Scripts\activate            # macOS/Linux: source .venv/bin/activate
pip install -r requirements.txt
copy .env.example .env            # 填入 SILICONFLOW_API_KEY（对话/向量/精排）
python -m uvicorn app.main:app --host 0.0.0.0 --port 8000

# 3. 前端
cd ../frontend
npm install
npm run dev
```

打开 <http://localhost:3000>，用演示账号登录：

| 角色 | 手机号 | 密码 | 权限 |
| --- | --- | --- | --- |
| 管理员 | 13800001234 | demo1234 | 知识库管理、索引重建、监控、数据库浏览 |
| 普通客户 | 13900002345 | demo1234 | 仅对话 |

Windows 用户也可以直接双击 `start-demo.bat`（需 Node 已在 PATH 中）。

首次对话前需要在「知识库」页点一次**重建索引**：文档解析 → 切片 → 向量化 → 写入 pgvector。没有配置 `SILICONFLOW_API_KEY` 时只能走 BM25 检索，回答质量会明显下降。

## 环境变量

完整清单见 [backend/.env.example](backend/.env.example)。关键项：

| 变量 | 说明 |
| --- | --- |
| `SECRET_KEY` | JWT 签名密钥，**生产必须替换** |
| `DEMO_PASSWORD` | 无 bcrypt 哈希账号的回落密码 |
| `SILICONFLOW_API_KEY` | 对话、向量、精排统一使用（`CHAT_PROVIDER=siliconflow`） |
| `CHAT_PROVIDER` / `SILICONFLOW_CHAT_MODEL` | 对话供应商与模型，默认 `siliconflow` / `deepseek-ai/DeepSeek-V4.1-Flash` |
| `ZHIPU_API_KEY` | 备用对话供应商（`CHAT_PROVIDER=zhipu` 时生效，工单 AI 补充也用它） |
| `SILICONFLOW_EMBEDDING_MODEL` / `SILICONFLOW_RERANK_MODEL` | 向量与精排模型，默认 `bge-m3` / `bge-reranker-v2-m3`，缺失时检索降级为 BM25 |
| `EMBEDDING_PROVIDER` | 向量/精排供应商，默认 `siliconflow`，可切回 `zhipu` |
| `PG_DSN` | pgvector 连接串（容器端口 5433） |
| `HISTORY_ROUNDS` | 携带的历史轮数，默认 3 |

## API 概览

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/api/chat/chat` | 对话主链路，返回 SSE 流 |
| POST | `/api/chat/resume` | 恢复被中断的审批（`thread_id` + `approved`） |
| POST | `/api/rag/ingest` | 重建知识库索引（admin） |
| GET | `/api/rag/kbs/{kb_id}/documents` | 知识库文档清单 |
| GET | `/api/admin/traces` | 最近对话轨迹（admin） |
| POST | `/api/sandbox/run` | 在隔离容器里执行一段 Python/Node 代码（登录可见） |
| GET | `/api/sandbox/status` | 沙箱镜像、限制与预热池状态 |
| GET | `/api/admin/overview` `/monitor` `/services` | 概览、监控、依赖健康（admin） |
| POST | `/api/auth/login` | 登录，返回 JWT |

SSE 事件类型：`status`、`message`、`message_end`、`interrupt`、`error`、`[DONE]`。

## 检索评测

```bash
cd backend
python scripts/eval_retrieval.py            # 21 条用例，输出 Recall@1/3/5 与 MRR
python scripts/eval_retrieval.py --list     # 打印知识库文档清单
```

实测（硅基流动 `bge-m3` 向量 + `bge-reranker-v2-m3` 精排，全量 162 个子切片，21 条用例）：Recall@1 81.0%、Recall@3 100%、Recall@5 100%、MRR 0.905。重排分数分布与智谱不同，阈值按供应商分开配置（`RAG_MIN_SCORE_SILICONFLOW`，默认 0.08）。

## 测试与验收

- 端到端冒烟脚本：`backend/scripts/smoke_test.py`（鉴权、问答、审批中断与恢复、轨迹落库）
- 检索评测脚本：`backend/scripts/eval_retrieval.py`（Recall@k / MRR）
- 沙箱验收脚本：`backend/scripts/sandbox_test.py`（13 项：执行、只读、禁网、超时、缓存）
- 实际运行记录与环境信息：[docs/TESTING.md](docs/TESTING.md)
- CI：GitHub Actions 跑后端编译与导入检查、前端类型检查与生产构建、敏感文件扫描

## 说明

- 本项目所有商品、订单、员工、供应商、制度文档均为**虚构演示数据**，与真实企业无关。
- 写操作审批是为演示「AI 不越权」设计的最小闭环，接入真实业务时请把审批人身份、审计日志与工单系统打通。
- 演示环境的口令与端口均为默认值，**上线前请全部替换**。

## License

[MIT](LICENSE)
