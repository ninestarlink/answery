# 测试与验收记录

本文件记录实际跑过的验证，不是示例。每次重要改动后重新跑一遍并更新时间。

## 环境

| 项 | 值 |
| --- | --- |
| 日期 | 2026-11-01 |
| 系统 | Windows 11 + PowerShell 5.1 |
| 后端 | Python 3.12.8 / FastAPI 0.162.0 / LangGraph 1.2.x |
| 前端 | Node 20.18.1 / Next.js 14.2.15 / React 18.3.1 |
| 依赖 | MySQL 8.0（3306）、Redis 7（6379）、pgvector 0.8.7（5433，190 条切片） |

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
5. plain chat: chars=245 degraded=[...] sources=3
6. interrupt: 1
   action=create_escalation_ticket title=创建人工工单需要确认
7. resume approved: chars=89 tools=[create_escalation_ticket]
8. resume rejected: chars=195
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
Recall@1: 9/13  = 69.2%
Recall@3: 13/13 = 100.0%
Recall@5: 13/13 = 100.0%
MRR: 0.846
注意：13/13 条为降级检索（embedding/rerank 不可用，仅 BM25）
```

说明：本轮智谱额度用尽（错误码 1113），系统自动熔断并降级为 BM25-only，因此数字是**降级状态下**的基线。配置可用 Key 后重新入库即可恢复向量 + 重排，指标会更高；降级行为本身也是被验证的特性。

## 三、前端检查

```text
tsc --noEmit            通过（0 error）
next build              通过，9 条路由：
                        /  /_not-found  /apps  /database  /knowledge  /login  /monitor
                        以及 /api/chat/chat 代理
生产模式 curl /apps     200，含知识库切换控件
生产模式 curl /login    200，含 AnswerY 品牌
```

## 四、手工验收清单

| 场景 | 预期 | 结果 |
| --- | --- | --- |
| 首页 | 显示 AnswerY，入口为单一「进入智能客服」 | 通过 |
| 工作台 | 单窗口对话，顶部可切「电商商品库 / 企业制度库」 | 通过 |
| 企业问答 | 回答给出制度数值并标注来源与版本 | 通过（降级检索下来源仅 3 条） |
| 写操作审批 | 弹审批卡，可批准/拒绝，批准后继续回答 | 通过 |
| 登录与权限 | 管理员可见监控/知识库管理，客户仅对话 | 通过 |
| 监控页 | 显示最近轨迹（状态、命中数、首 Token 延迟） | 通过 |

## 五、已知限制

- 智谱额度不足时只走 BM25，来源条数被裁剪为前 3 条。
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
