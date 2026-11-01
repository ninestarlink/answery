# 测试与验收记录

本文件记录实际跑过的验证，不是示例。每次重要改动后重新跑一遍并更新时间。

## 环境

| 项 | 值 |
| --- | --- |
| 日期 | 2026-11-01 |
| 系统 | Windows 11 + PowerShell 5.1 |
| 后端 | Python 3.12.8 / FastAPI 0.162.0 / LangGraph 1.2.x |
| 前端 | Node 20.18.1 / Next.js 14.2.15 / React 18.3.1 |
| 依赖 | MySQL 8.0（3306）、Redis 7（6379）、pgvector 0.8.7（5433，161 条子切片 / 134 个父块） |
| 模型 | 对话：智谱 `glm-4-flash`；向量：硅基流动 `Pro/BAAI/bge-m3`（1024 维）；精排：硅基流动 `Pro/BAAI/bge-reranker-v2-m3` |

## 一、端到端冒烟测试

脚本：[backend/scripts/smoke_test.py](../backend/scripts/smoke_test.py)

```bash
cd backend
python scripts/smoke_test.py
```

2026-11-01 实跑结果：

```text
1. health: {'mysql': 'ok', 'redis': 'ok', 'pgvector': 'ok'}
2. admin without token: 401
3. admin login: 200 admin
4. customer -> admin: 403
5. plain chat: chars=245 degraded=[] sources=5
6. interrupt: 1
   action=create_escalation_ticket title=创建人工工单需要确认
7. resume approved: chars=83 tools=[create_escalation_ticket]
8. resume rejected: chars=209
9. traces: 200 5 [('ok', 'ecommerce', 0, 0), ('interrupted', 'ecommerce', 0, 0), ('ok', 'ecommerce', 1, 1)]
RESULT: PASS
```

覆盖点：依赖健康、未授权 401、越权 403、普通问答、写操作中断、批准恢复、拒绝改走自助方案、轨迹落库。

## 二、检索评测

脚本：[backend/scripts/eval_retrieval.py](../backend/scripts/eval_retrieval.py)，13 条人工标注问题（企业制度 10 条 + 电商商品 3 条）。

```bash
cd backend
PYTHONPATH=. python scripts/eval_retrieval.py
```

```text
enterprise #1    新员工入职第一年有几天年假？              员工手册        员工手册_v2025
enterprise #1    试用期多久，转正要走什么流程？             员工手册        员工手册_v2025
enterprise #1    出差去上海住一晚，住宿标准是多少？           差旅报销        差旅报销制度_v2025
enterprise #2    出差可以坐高铁一等座吗？交通标准怎么算？      差旅报销        差旅报销制度_v2025
enterprise #2    供应商分级标准和账期是怎么规定的？           采购            报销标准与供应商清单
enterprise #2    采购金额多少需要走招投标流程？              采购            报销标准与供应商清单
enterprise #1    公司账号密码多久需要更换一次？              信息安全        信息安全规范
enterprise #2    发生数据泄露应该怎么上报？                 信息安全        数据合规与客户隐私政策
enterprise #1    客户投诉多久要升级到主管？                 客服升级        客服升级SOP
enterprise #1    供应商清单在哪里查看？                    报销标准        报销标准与供应商清单
shop       #1    哪款跑鞋缓震好，适合日常跑步？              products       products
shop       #1    预算 500 元以内有什么鞋推荐？              products       products
shop       #1    适合实战的篮球鞋有哪些？                   products       products
Recall@1: 9/13  = 69.2%
Recall@3: 13/13 = 100.0%
Recall@5: 13/13 = 100.0%
MRR: 0.846
```

说明：本轮为全量向量 + 精排（`bge-m3` + `bge-reranker-v2-m3`），没有再走 BM25 降级。两条 `#2` 用例的 Top1 落到「报销标准与供应商清单」，是因为该文档同时覆盖采购与报销场景，Top3 内均可命中，召回率仍为 100%。

## 三、前端检查

```text
tsc --noEmit            通过（0 error）
next build              通过，9 条路由：
                        /  /_not-found  /apps  /database  /knowledge  /login  /monitor
                        以及 /api/chat/chat 代理
生产模式 curl /apps     200，含单一对话窗口、欢迎语与「答案带出处 · 写操作先审批 · 全程可回放」
生产模式 curl /login    200，含 AnswerY 品牌
```

## 四、手工验收清单

| 场景 | 预期 | 结果 |
| --- | --- | --- |
| 首页 | 显示 AnswerY，入口为单一「进入智能客服」 | 通过 |
| 工作台 | 单窗口对话，一个输入框混合问答（商品库 + 制度库同时召回） | 通过 |
| 企业问答 | 回答给出制度数值并标注来源与版本 | 通过（出差住宿 600 元/晚，来源指向差旅报销制度对应章节） |
| 混合问答 | 同一输入框既能答商品也能答制度，工具类问题不挂无关文档来源 | 通过（订单物流走工具且来源为空，制度问题引用到章节） |
| 写操作审批 | 弹审批卡，可批准/拒绝，批准后继续回答 | 通过 |
| 登录与权限 | 管理员可见监控/知识库管理，客户仅对话 | 通过 |
| 监控页 | 显示最近轨迹（状态、命中数、首 Token 延迟） | 通过 |

## 五、已知限制

- 精排分数阈值按供应商配置：智谱 rerank 分数在 0.3 以上，`bge-reranker-v2-m3` 压缩在 0~0.3，因此 `RAG_MIN_SCORE_SILICONFLOW` 默认 0.08；换供应商时需重新校准，否则会把候选全部过滤掉。
- 任一模型额度不足（HTTP 429 / 错误码 1113）时熔断 300 秒并降级为 BM25-only，前端会明确提示本轮为降级检索。
- `InMemorySaver` 检查点仅存于单进程；多实例部署需换 Redis/Postgres checkpointer。
- 额度统计用 Redis 计数器，Redis 不可用时放行（优先保证可用性）。
- 工单幂等窗口为 10 分钟，超出窗口会新建工单。

## 六、复现步骤

```bash
docker compose -f backend/docker-compose.yml up -d
cd backend && pip install -r requirements.txt && python -m uvicorn app.main:app --port 8000
# 另开终端
cd frontend && npm ci && npm run build && npm start
# 冒烟 + 评测
cd backend && python scripts/smoke_test.py
PYTHONPATH=. python scripts/eval_retrieval.py
```
