"""检索质量评测：金标数据集、批量跑批与回归指标。

评测只调用检索层（embedding + BM25 + RRF + rerank），不触发大模型生成，
因此可重复、低成本、适合每次改检索参数或知识库后回归。
"""

from __future__ import annotations

import time
from datetime import datetime

from sqlalchemy import func, select

from .database import SessionLocal
from .eval_metrics import summarize
from .models import EvalCase, EvalDataset, EvalResult, EvalRun
from .rag import retriever

DATASET_CODE = "golden-v1"

# 金标用例：问题 -> 必须命中的文档。分类覆盖售前、售中、售后、企业制度与合规。
GOLDEN_CASES: list[dict] = [
    # 商品与库存
    {
        "no": "E01",
        "q": "轻云 Pro 的定位和售价是多少？",
        "kb": "shop",
        "doc": "products",
        "kw": "轻云 Pro,日常慢跑,售价",
        "cat": "商品咨询",
    },
    {
        "no": "E02",
        "q": "山野 GTX 是防水跑鞋吗？",
        "kb": "shop",
        "doc": "products",
        "kw": "山野 GTX,GORE-TEX,防水",
        "cat": "商品咨询",
    },
    {
        "no": "E03",
        "q": "烈焰 X3 适合什么水平的跑者？",
        "kb": "shop",
        "doc": "products",
        "kw": "烈焰 X3,竞速,碳板",
        "cat": "商品咨询",
    },
    {
        "no": "E04",
        "q": "预算三百以内推荐哪双跑鞋？",
        "kb": "shop",
        "doc": "products",
        "kw": "三百,入门,推荐",
        "cat": "商品咨询",
    },
    {
        "no": "E05",
        "q": "云步健步鞋适合给父母买吗？",
        "kb": "shop",
        "doc": "products",
        "kw": "云步,健步,长辈",
        "cat": "商品咨询",
    },
    {
        "no": "E06",
        "q": "街头 Classic 是头层牛皮吗？",
        "kb": "shop",
        "doc": "products",
        "kw": "街头 Classic,牛皮,材质",
        "cat": "商品咨询",
    },
    {
        "no": "E07",
        "q": "疾风 2.0 的 43 码还有库存吗？",
        "kb": "shop",
        "doc": "products",
        "kw": "疾风 2.0,43,库存",
        "cat": "商品咨询",
    },
    {
        "no": "E08",
        "q": "轻云 Pro 单只鞋重多少克？",
        "kb": "shop",
        "doc": "products",
        "kw": "轻云 Pro,重量,克",
        "cat": "商品咨询",
    },
    # 物流
    {
        "no": "E09",
        "q": "满多少钱可以免运费？",
        "kb": "shop",
        "doc": "shipping",
        "kw": "满,免运费",
        "cat": "物流",
    },
    {
        "no": "E10",
        "q": "发往新疆需要额外加运费吗？",
        "kb": "shop",
        "doc": "shipping",
        "kw": "新疆,运费,偏远",
        "cat": "物流",
    },
    {
        "no": "E11",
        "q": "下午四点以后下单当天还能发货吗？",
        "kb": "shop",
        "doc": "shipping",
        "kw": "16 点,发货,次日",
        "cat": "物流",
    },
    {
        "no": "E12",
        "q": "江浙沪一般几天能到？",
        "kb": "shop",
        "doc": "shipping",
        "kw": "江浙沪,时效,天",
        "cat": "物流",
    },
    {
        "no": "E13",
        "q": "可以指定发顺丰吗？",
        "kb": "shop",
        "doc": "shipping",
        "kw": "顺丰,指定,快递",
        "cat": "物流",
    },
    # 售后
    {
        "no": "E14",
        "q": "七天无理由退货还是十五天？",
        "kb": "shop",
        "doc": "returns",
        "kw": "无理由,天,退货",
        "cat": "售后",
    },
    {
        "no": "E15",
        "q": "尺码不合适多久内可以免费换？",
        "kb": "shop",
        "doc": "returns",
        "kw": "换货,尺码,免费",
        "cat": "售后",
    },
    {
        "no": "E16",
        "q": "碳板跑鞋的质保期是多久？",
        "kb": "shop",
        "doc": "returns",
        "kw": "碳板,质保",
        "cat": "售后",
    },
    {
        "no": "E17",
        "q": "退款退回到银行卡要几天？",
        "kb": "shop",
        "doc": "returns",
        "kw": "退款,到账,工作日",
        "cat": "售后",
    },
    {
        "no": "E18",
        "q": "大促买的鞋还能无理由退吗？",
        "kb": "shop",
        "doc": "returns",
        "kw": "大促,无理由,退货",
        "cat": "售后",
    },
    # 优惠券
    {
        "no": "E19",
        "q": "一单最多能用几张优惠券？",
        "kb": "shop",
        "doc": "coupons",
        "kw": "一张,叠加,优惠券",
        "cat": "营销",
    },
    {
        "no": "E20",
        "q": "优惠券可以提现或折现吗？",
        "kb": "shop",
        "doc": "coupons",
        "kw": "折现,提现,不可",
        "cat": "营销",
    },
    {
        "no": "E21",
        "q": "过期的券能补发吗？",
        "kb": "shop",
        "doc": "coupons",
        "kw": "过期,补发",
        "cat": "营销",
    },
    {
        "no": "E22",
        "q": "新人券和店铺满减能一起用吗？",
        "kb": "shop",
        "doc": "coupons",
        "kw": "新人券,满减,叠加",
        "cat": "营销",
    },
    # 尺码
    {
        "no": "E23",
        "q": "平时穿 42 码这款该选多大？",
        "kb": "shop",
        "doc": "sizing",
        "kw": "42,选码,建议",
        "cat": "尺码",
    },
    {
        "no": "E24",
        "q": "跑马拉松选码要留半码吗？",
        "kb": "shop",
        "doc": "sizing",
        "kw": "马拉松,半码,选码",
        "cat": "尺码",
    },
    {
        "no": "E25",
        "q": "脚背高、脚宽应该怎么选码？",
        "kb": "shop",
        "doc": "sizing",
        "kw": "脚宽,脚背,选码",
        "cat": "尺码",
    },
    {
        "no": "E26",
        "q": "疾风 2.0 的楦型偏窄吗？",
        "kb": "shop",
        "doc": "sizing",
        "kw": "疾风 2.0,楦型,偏窄",
        "cat": "尺码",
    },
    # 企业制度
    {
        "no": "E27",
        "q": "员工密码长度和更换周期有什么要求？",
        "kb": "enterprise",
        "doc": "信息安全规范",
        "kw": "密码,长度,更换",
        "cat": "信息安全",
    },
    {
        "no": "E28",
        "q": "哪些操作必须使用多因素认证？",
        "kb": "enterprise",
        "doc": "信息安全规范",
        "kw": "MFA,多因素,操作",
        "cat": "信息安全",
    },
    {
        "no": "E29",
        "q": "可以把客户数据传给外部 AI 工具吗？",
        "kb": "enterprise",
        "doc": "信息安全规范",
        "kw": "外部,AI,客户数据",
        "cat": "信息安全",
    },
    {
        "no": "E30",
        "q": "离职后账号权限什么时候回收？",
        "kb": "enterprise",
        "doc": "信息安全规范",
        "kw": "离职,权限,回收",
        "cat": "信息安全",
    },
    {
        "no": "E31",
        "q": "L2 客服升级后多久必须响应？",
        "kb": "enterprise",
        "doc": "客服升级SOP",
        "kw": "L2,升级,响应,时限",
        "cat": "客服管理",
    },
    {
        "no": "E32",
        "q": "一线客服最多可以赔多少钱？",
        "kb": "enterprise",
        "doc": "客服升级SOP",
        "kw": "一线,赔付,额度",
        "cat": "客服管理",
    },
    {
        "no": "E33",
        "q": "绩效等级各档的比例怎么分布？",
        "kb": "enterprise",
        "doc": "绩效考核管理办法",
        "kw": "绩效,等级,比例",
        "cat": "人力资源",
    },
    {
        "no": "E34",
        "q": "连续两个季度绩效为 C 会有什么处理？",
        "kb": "enterprise",
        "doc": "绩效考核管理办法",
        "kw": "连续,C,绩效改进",
        "cat": "人力资源",
    },
    {
        "no": "E35",
        "q": "申请晋升需要满足哪些条件？",
        "kb": "enterprise",
        "doc": "员工培训与晋升规范",
        "kw": "晋升,条件,司龄",
        "cat": "人力资源",
    },
    {
        "no": "E36",
        "q": "新员工导师带教期是多长？",
        "kb": "enterprise",
        "doc": "员工培训与晋升规范",
        "kw": "导师,带教,新员工",
        "cat": "人力资源",
    },
    {
        "no": "E37",
        "q": "忘记打卡应该怎么补？",
        "kb": "enterprise",
        "doc": "办公与行政管理制度",
        "kw": "打卡,补卡,考勤",
        "cat": "行政",
    },
    {
        "no": "E38",
        "q": "公司每周允许远程办公几天？",
        "kb": "enterprise",
        "doc": "办公与行政管理制度",
        "kw": "远程办公,每周,天",
        "cat": "行政",
    },
    {
        "no": "E39",
        "q": "客服对话记录会保存多久？",
        "kb": "enterprise",
        "doc": "数据合规与客户隐私政策",
        "kw": "对话,留存,期限",
        "cat": "合规",
    },
    {
        "no": "E40",
        "q": "用户注销账号后数据多久删除？",
        "kb": "enterprise",
        "doc": "数据合规与客户隐私政策",
        "kw": "注销,删除,天",
        "cat": "合规",
    },
]


async def ensure_dataset() -> int:
    """幂等创建金标数据集：已存在的用例按编号跳过。"""
    async with SessionLocal() as db:
        dataset = (
            await db.execute(select(EvalDataset).where(EvalDataset.code == DATASET_CODE))
        ).scalar_one_or_none()
        if dataset is None:
            dataset = EvalDataset(
                code=DATASET_CODE,
                name="客服回答金标集 v1",
                description="40 条覆盖售前、售后、企业制度与合规的检索金标用例",
            )
            db.add(dataset)
            await db.flush()

        existing = set(
            (
                await db.execute(
                    select(EvalCase.case_no).where(EvalCase.dataset_id == dataset.id)
                )
            )
            .scalars()
            .all()
        )
        for item in GOLDEN_CASES:
            if item["no"] in existing:
                continue
            db.add(
                EvalCase(
                    dataset_id=dataset.id,
                    case_no=item["no"],
                    question=item["q"],
                    kb_id=item["kb"],
                    expected_doc=item["doc"],
                    expected_keywords=item["kw"],
                    category=item["cat"],
                    difficulty="normal",
                )
            )
        await db.commit()
        return dataset.id


async def execute_run(run_id: int, top_k: int) -> None:
    """批量跑检索：逐条记录首中位次、耗时与 TopK 来源，最后写入汇总。"""
    async with SessionLocal() as db:
        run = (await db.execute(select(EvalRun).where(EvalRun.id == run_id))).scalar_one()
        cases = (
            await db.execute(
                select(EvalCase)
                .where(EvalCase.dataset_id == run.dataset_id)
                .order_by(EvalCase.case_no)
            )
        ).scalars().all()

        ranks: list[int] = []
        latencies: list[int] = []
        degraded_count = 0
        try:
            for case in cases:
                started = time.perf_counter()
                degraded: list[str] = []
                try:
                    result = await retriever.search(
                        case.kb_id, case.question, top_k=top_k, use_rerank=True
                    )
                    evidence = result.get("evidence") or []
                    docs = [e["document_name"] for e in evidence]
                    degraded = result.get("degraded") or []
                except Exception as exc:  # 单条失败不中断整批
                    docs = []
                    degraded = [f"检索异常：{exc}"]

                latency = int((time.perf_counter() - started) * 1000)
                rank = docs.index(case.expected_doc) + 1 if case.expected_doc in docs else 0
                if degraded:
                    degraded_count += 1
                ranks.append(rank)
                latencies.append(latency)
                db.add(
                    EvalResult(
                        run_id=run_id,
                        case_id=case.id,
                        case_no=case.case_no,
                        question=case.question,
                        kb_id=case.kb_id,
                        expected_doc=case.expected_doc,
                        retrieved_doc=docs[0] if docs else None,
                        rank=rank,
                        hit=1 if rank else 0,
                        latency_ms=latency,
                        degraded="；".join(degraded)[:128] or None,
                        top_docs=", ".join(docs),
                    )
                )
                await db.commit()

            summary = summarize(ranks, latencies)
            run.case_count = summary["case_count"]
            run.hit_count = summary["hit_count"]
            run.hit_rate = summary["hit_rate"]
            run.mrr = summary["mrr"]
            run.avg_latency_ms = summary["avg_latency_ms"]
            run.p95_latency_ms = summary["p95_latency_ms"]
            run.degraded_count = degraded_count
            run.status = "completed"
            run.finished_at = datetime.now()
        except Exception as exc:
            run.status = "failed"
            run.error = str(exc)[:255]
            run.finished_at = datetime.now()
        await db.commit()


async def dataset_stats() -> dict:
    async with SessionLocal() as db:
        dataset = (
            await db.execute(select(EvalDataset).where(EvalDataset.code == DATASET_CODE))
        ).scalar_one_or_none()
        if dataset is None:
            return {"id": None, "cases": 0, "categories": 0}
        cases = await db.scalar(
            select(func.count()).select_from(EvalCase).where(EvalCase.dataset_id == dataset.id)
        )
        categories = await db.scalar(
            select(func.count(func.distinct(EvalCase.category))).where(
                EvalCase.dataset_id == dataset.id
            )
        )
        return {"id": dataset.id, "cases": int(cases or 0), "categories": int(categories or 0)}
