"""端到端冒烟测试：鉴权 → 问答 → 人工审批中断/恢复 → 轨迹落库。

前提：Docker 依赖已启动、后端跑在 BASE_URL（默认 http://127.0.0.1:8000），
且 backend/.env 已配置 ZHIPU_API_KEY（否则对话会直接返回额度提示）。

    python scripts/smoke_test.py

输出每一步的实际结果，最后打印 PASS / FAIL，退出码可直接用于 CI 或验收记录。
"""

import json
import os
import sys

import httpx

BASE_URL = os.getenv("BASE_URL", "http://127.0.0.1:8000")
ADMIN_PHONE = os.getenv("SMOKE_ADMIN_PHONE", "13800001234")
CUSTOMER_PHONE = os.getenv("SMOKE_CUSTOMER_PHONE", "13900002345")
PASSWORD = os.getenv("SMOKE_PASSWORD", "demo1234")


def read_sse(resp: httpx.Response) -> list[dict]:
    """把 SSE 流解析成事件列表，遇到 [DONE] 停止。"""
    frames: list[dict] = []
    for line in resp.iter_lines():
        if not line or not line.startswith("data: "):
            continue
        raw = line[6:]
        if raw == "[DONE]":
            break
        try:
            frames.append(json.loads(raw))
        except json.JSONDecodeError:
            continue
    return frames


def text_of(frames: list[dict]) -> str:
    return "".join(f.get("answer") or "" for f in frames if f.get("event") == "message")


def main() -> int:
    ok = True
    with httpx.Client(base_url=BASE_URL, timeout=180) as client:
        # 1. 依赖健康
        health = client.get("/health").json()
        print("1. health:", {k: health.get(k) for k in ("mysql", "redis", "pgvector")})

        # 2. 未登录访问管理端
        r = client.get("/api/admin/traces")
        print("2. admin without token:", r.status_code)
        ok &= r.status_code == 401

        # 3. 管理员登录
        r = client.post("/api/auth/login", json={"username": ADMIN_PHONE, "password": PASSWORD})
        body = r.json()
        print("3. admin login:", r.status_code, body.get("customer", {}).get("role"))
        ok &= r.status_code == 200
        admin_headers = {"Authorization": f"Bearer {body['access_token']}"}

        # 4. 普通客户访问管理端应 403
        r = client.post("/api/auth/login", json={"username": CUSTOMER_PHONE, "password": PASSWORD})
        r403 = client.get(
            "/api/admin/traces",
            headers={"Authorization": f"Bearer {r.json()['access_token']}"},
        )
        print("4. customer -> admin:", r403.status_code)
        ok &= r403.status_code == 403

        # 5. 普通问答
        with client.stream(
            "POST",
            "/api/chat/chat",
            json={
                "app": "ecommerce",
                "session_id": "smoke-plain",
                "message": "轻云 Pro 缓震跑鞋适合什么场景穿？",
            },
        ) as resp:
            frames = read_sse(resp)
        meta = next((f for f in frames if f.get("event") == "message_end"), {})
        rag = (meta.get("metadata") or {}).get("rag") or {}
        print(
            "5. plain chat: chars=%d degraded=%s sources=%d"
            % (len(text_of(frames)), rag.get("degraded"), len(meta.get("sources") or []))
        )
        ok &= bool(text_of(frames))

        # 6. 写操作触发人工审批
        with client.stream(
            "POST",
            "/api/chat/chat",
            json={
                "app": "ecommerce",
                "session_id": "smoke-hitl",
                "message": "帮我转人工建个工单：订单 12347 一直显示退款中，三天没人处理。",
            },
        ) as resp:
            frames = read_sse(resp)
        interrupts = [f for f in frames if f.get("event") == "interrupt"]
        print("6. interrupt:", len(interrupts))
        if not interrupts:
            ok = False
        else:
            payload = interrupts[0]["payload"]
            print("   action=%s title=%s" % (payload.get("action"), payload.get("title")))
            with client.stream(
                "POST",
                "/api/chat/resume",
                json={"thread_id": interrupts[0]["thread_id"], "approved": True, "by": "冒烟测试"},
            ) as resp2:
                frames2 = read_sse(resp2)
            meta2 = next((f for f in frames2 if f.get("event") == "message_end"), {})
            tools = [t.get("tool") for t in (meta2.get("tool_calls") or [])]
            print("7. resume approved: chars=%d tools=%s" % (len(text_of(frames2)), tools))
            ok &= bool(text_of(frames2))

        # 8. 拒绝路径：模型应改走自助方案
        with client.stream(
            "POST",
            "/api/chat/chat",
            json={
                "app": "ecommerce",
                "session_id": "smoke-reject",
                "message": "帮我转人工，建个工单，我怀疑账号被盗用了。",
            },
        ) as resp:
            frames = read_sse(resp)
        rejected = [f for f in frames if f.get("event") == "interrupt"]
        if rejected:
            with client.stream(
                "POST",
                "/api/chat/resume",
                json={"thread_id": rejected[0]["thread_id"], "approved": False, "by": "冒烟测试"},
            ) as resp2:
                frames2 = read_sse(resp2)
            print("8. resume rejected: chars=%d" % len(text_of(frames2)))
            ok &= bool(text_of(frames2))
        else:
            print("8. resume rejected: 模型未触发审批（跳过）")

        # 9. 轨迹落库
        r = client.get("/api/admin/traces", headers=admin_headers, params={"limit": 5})
        rows = r.json().get("traces", [])
        print(
            "9. traces:",
            r.status_code,
            len(rows),
            [(x["status"], x["app"], x["hits"], x["tools"]) for x in rows[:3]],
        )
        ok &= r.status_code == 200 and len(rows) > 0

    print("\nRESULT:", "PASS" if ok else "FAIL")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
