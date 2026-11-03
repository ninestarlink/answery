"""初始化评测中台：建表 + 写入 40 条金标用例，可选立即跑一次。

用法（在 backend/ 下）：
    $env:PYTHONPATH="."; python scripts/seed_eval.py
    $env:PYTHONPATH="."; python scripts/seed_eval.py --run
"""

from __future__ import annotations

import argparse
import asyncio
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.database import Base, SessionLocal, engine  # noqa: E402
from app.evaluation import ensure_dataset, execute_run  # noqa: E402
from app.models import EvalRun  # noqa: E402
from sqlalchemy import select  # noqa: E402


async def main(run: bool, top_k: int) -> None:
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)

    dataset_id = await ensure_dataset()
    print(f"dataset_id={dataset_id}")

    if not run:
        return

    async with SessionLocal() as db:
        record = EvalRun(dataset_id=dataset_id, top_k=top_k, status="running", note="seed 脚本")
        db.add(record)
        await db.commit()
        await db.refresh(record)
        run_id = record.id

    await execute_run(run_id, top_k)
    async with SessionLocal() as db:
        finished = (
            await db.execute(select(EvalRun).where(EvalRun.id == run_id))
        ).scalar_one()
        print(
            f"run={run_id} status={finished.status} "
            f"hit_rate={finished.hit_rate:.1%} mrr={finished.mrr:.3f} "
            f"p95={finished.p95_latency_ms}ms"
        )


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--run", action="store_true", help="写入后立即执行一次评测")
    parser.add_argument("--top-k", type=int, default=5)
    args = parser.parse_args()
    asyncio.run(main(args.run, args.top_k))
