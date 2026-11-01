# 测试与验收记录

本文件记录实际跑过的验证，不是示例。每次重要改动后重新跑一遍并更新时间。

## 环境

| 项 | 值 |
| --- | --- |
| 日期 | 2026-11-01 |
| 系统 | Windows 11 + PowerShell 5.1 |
| 后端 | Python 3.12.8 / FastAPI 0.162.0 / LangGraph 1.2.x |
| 前端 | Node 20.18.1 / Next.js 14.2.15 / React 18.3.1 |
| 依赖 | MySQL 8.0（3306）、Redis 7（6379）、pgvector 0.8.7（5433，162 条子切片 / 134 个父块） |
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

脚本：[backend/scripts/eval_retrieval.py](../backend/scripts/eval_retrieval.py)，21 条人工标注问题（企业制度 14 条 + 电商 7 条），覆盖扩充后的全部 16 份文档。

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
enterprise #1    绩效考核多久评一次，等级怎么划分？           绩效考核        绩效考核管理办法
enterprise #1    晋升需要满足哪些条件，走什么流程？           员工培训与晋升   员工培训与晋升规范
enterprise #1    会议室要提前多久预约？                    办公与行政      办公与行政管理制度
enterprise #1    客户数据可以留存多久，到期怎么处理？          数据合规        数据合规与客户隐私政策
shop       #1    哪款跑鞋缓震好，适合日常跑步？              products       products
shop       #1    预算 500 元以内有什么鞋推荐？              products       products
shop       #1    适合实战的篮球鞋有哪些？                   products       products
shop       #1    满多少免运费，运费多少钱？                 shipping       shipping
shop       #1    鞋子吊牌剪了还能无理由退货吗？               returns        returns
shop       #1    两张优惠券可以叠加使用吗？                 coupons        coupons
shop       #1    平时穿 43 码，脚长应该量多少？              sizing         sizing
Recall@1: 17/21 = 81.0%
Recall@3: 21/21 = 100.0%
Recall@5: 21/21 = 100.0%
MRR: 0.905
```

说明：本轮为全量向量 + 精排（`bge-m3` + `bge-reranker-v2-m3`），没有 BM25 降级。未进 Top1 的 4 条都是企业制度问题，Top3 内均可命中：两条采购问题落到「报销标准与供应商清单」（与采购文档内容交叉），「高铁一等座」落到「差旅报销制度」的其它章节，「数据泄露上报」落到「数据合规与客户隐私政策」（与信息安全规范交叉）。回答侧另做了端到端校验（见下表），不只看检索排名。

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
| 运费问答 | 问「满多少免运费」给出 199 元免运费、12 元运费、偏远 +8 | 通过（走 get_policies，`key=shipping` 也命中运费规则） |
| 退换问答 | 问「吊牌剪了还能退吗」按 30 天无理由 + 吊牌完整作答 | 通过（来源 returns · 1 无理由退货） |
| 制度边界 | 问「会议室要提前多久预约」资料未规定时应说明未规定 | 通过（回答「文档未规定」，未反推 15 分钟） |
| 制度数值 | 问绩效等级，按文档 4.2 给出五档定义与比例 | 通过（S/A/B+/B/C 与原文一致） |
| 写操作审批 | 弹审批卡，可批准/拒绝，批准后继续回答 | 通过 |
| 登录与权限 | 管理员可见监控/知识库管理，客户仅对话 | 通过 |
| 监控页 | 显示最近轨迹（状态、命中数、首 Token 延迟） | 通过 |

## 五、代码沙箱验收

脚本：[backend/scripts/sandbox_test.py](../backend/scripts/sandbox_test.py)，直接打 `/api/sandbox/run` 与 `/api/sandbox/status`，13 项全部通过。

```text
PASS  Docker 可用  29.9.2
PASS  运行时镜像就绪  {'python': True, 'node': True}
PASS  预热池为 WARM  {'python': 'WARM', 'node': 'WARM'}
PASS  Python 执行  42
PASS  Node 执行  node ok 3
PASS  只读文件系统  PermissionError: [Errno 13] Permission denied: '/etc/passwd'
PASS  容器禁网  NETWORK_BLOCKED URLError
PASS  缓存写入  HTTP 200
PASS  缓存命中  CACHED
PASS  超时中止  HTTP 408 {"detail":"执行超时（>8s），容器已销毁重建"}
PASS  超时后自动重建  state=WARM runs=5
PASS  超时后可继续执行  after-timeout
PASS  未支持语言被拒  HTTP 400

RESULT: PASS（13 项全部通过）
```

容器实际配置（`docker inspect` 摘录，非文档描述）：

```text
ReadonlyRootfs : True
Memory         : 536870912      # 512 MB
NanoCpus       : 1000000000     # 1 CPU
PidsLimit      : 64
NetworkMode    : none
CapDrop        : {ALL}
SecurityOpt    : {no-new-privileges:true}
Tmpfs          : /tmp=size=64m,mode=1777
```

说明：seccomp 未自定义白名单，走 Docker 默认 profile（已屏蔽高危 syscall）；语言支持 Python / Node 两个运行时，Go 需要编译链、镜像体积大，暂未接入。

## 六、已知限制

- 精排分数阈值按供应商配置：智谱 rerank 分数在 0.3 以上，`bge-reranker-v2-m3` 压缩在 0~0.3，因此 `RAG_MIN_SCORE_SILICONFLOW` 默认 0.08；换供应商时需重新校准，否则会把候选全部过滤掉。
- 对话模型 `glm-4-flash` 在档位类问题上容易补写片段没有的释义；已把 temperature 降到 0.1、在提示词里禁止补写释义，并把常用定义补进制度原文（如绩效五档定义），实测回答已与原文一致。接更强模型可进一步降低风险。
- 任一模型额度不足（HTTP 429 / 错误码 1113）时熔断 300 秒并降级为 BM25-only，前端会明确提示本轮为降级检索。
- `InMemorySaver` 检查点仅存于单进程；多实例部署需换 Redis/Postgres checkpointer。
- 额度统计用 Redis 计数器，Redis 不可用时放行（优先保证可用性）。
- 工单幂等窗口为 10 分钟，超出窗口会新建工单。
- 沙箱每个语言只保留一个预热容器，执行按语言串行；并发量大时应改成容器池 + 队列。
- 沙箱依赖本机 Docker，部署到无 Docker 的环境时请设置 `SANDBOX_ENABLED=false`。

## 七、复现步骤

```bash
docker compose -f backend/docker-compose.yml up -d
cd backend && pip install -r requirements.txt && python -m uvicorn app.main:app --port 8000
# 另开终端
cd frontend && npm ci && npm run build && npm start
# 冒烟 + 评测 + 沙箱
cd backend && python scripts/smoke_test.py
PYTHONPATH=. python scripts/eval_retrieval.py
PYTHONPATH=. python scripts/sandbox_test.py   # 需要本机 Docker 与两个运行时镜像
```
