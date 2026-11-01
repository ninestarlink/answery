"""沙箱验收脚本：直接打真实接口，逐项打印 PASS/FAIL。

覆盖：预热池状态、Python/Node 运行、只读文件系统、禁网、超时销毁重建、结果缓存。
用法：先启动后端，然后 `PYTHONPATH=. python scripts/sandbox_test.py`
"""

from __future__ import annotations

import sys

import httpx

BASE = "http://127.0.0.1:8000"
PY_LOOP = "while True:\n    pass"
PY_WRITE = (
    "open('/etc/passwd', 'a').write('x')"
    "\nopen('/flag', 'w').write('x')"
)
PY_NET = (
    "import urllib.request\n"
    "try:\n"
    "    urllib.request.urlopen('http://example.com', timeout=2)\n"
    "    print('NETWORK_OK')\n"
    "except Exception as exc:\n"
    "    print('NETWORK_BLOCKED', type(exc).__name__)\n"
)

results: list[tuple[str, bool, str]] = []


def check(name: str, ok: bool, detail: str = "") -> None:
    results.append((name, ok, detail))
    print(f"{'PASS' if ok else 'FAIL'}  {name}  {detail}")


def main() -> int:
    with httpx.Client(trust_env=False, timeout=120) as client:
        login = client.post(
            f"{BASE}/api/auth/login",
            json={"username": "13900002345", "password": "demo1234"},
        )
        if login.status_code != 200:
            print("登录失败，后端未启动？", login.status_code, login.text[:200])
            return 1
        headers = {"Authorization": f"Bearer {login.json()['access_token']}"}

        status = client.get(f"{BASE}/api/sandbox/status", headers=headers).json()
        check("Docker 可用", bool(status.get("docker_version")), str(status.get("docker_version")))
        check(
            "运行时镜像就绪",
            all(status.get("images", {}).values()),
            str(status.get("images")),
        )
        check(
            "预热池为 WARM",
            all(info["state"] in ("WARM", "CLAIMED") for info in status["pool"].values()),
            str({k: v["state"] for k, v in status["pool"].items()}),
        )

        run = lambda language, code: client.post(  # noqa: E731
            f"{BASE}/api/sandbox/run",
            json={"language": language, "code": code},
            headers=headers,
        )

        resp = run("python", "print(6 * 7)").json()
        check("Python 执行", resp.get("exit_code") == 0 and "42" in resp.get("output", ""), resp.get("output", "").strip())

        resp = run("node", "console.log('node ok', [1,2,3].length)").json()
        check("Node 执行", resp.get("exit_code") == 0 and "node ok 3" in resp.get("output", ""), resp.get("output", "").strip())

        resp = run("python", PY_WRITE).json()
        check(
            "只读文件系统",
            resp.get("exit_code") != 0 and "Permission" in resp.get("output", ""),
            resp.get("output", "").strip().splitlines()[-1][:120] if resp.get("output") else "",
        )

        resp = run("python", PY_NET).json()
        check("容器禁网", "NETWORK_BLOCKED" in resp.get("output", ""), resp.get("output", "").strip()[-120:])

        resp = run("python", "print('cache-me')")
        check("缓存写入", resp.status_code == 200, f"HTTP {resp.status_code}")
        again = run("python", "print('cache-me')").json()
        check("缓存命中", bool(again.get("cached")) and again.get("pool_state") == "CACHED", str(again.get("pool_state")))

        resp = run("python", PY_LOOP)
        check("超时中止", resp.status_code == 408, f"HTTP {resp.status_code} {resp.text[:80]}")

        after = client.get(f"{BASE}/api/sandbox/status", headers=headers).json()
        check(
            "超时后自动重建",
            after["pool"]["python"]["state"] in ("WARM", "CREATE"),
            f"state={after['pool']['python']['state']} runs={after['pool']['python']['runs']}",
        )

        resp = run("python", "print('after-timeout')").json()
        check("超时后可继续执行", resp.get("exit_code") == 0 and "after-timeout" in resp.get("output", ""), resp.get("output", "").strip())

        bad = run("ruby", "puts 1")
        check("未支持语言被拒", bad.status_code == 400, f"HTTP {bad.status_code}")

    failed = [name for name, ok, _ in results if not ok]
    print()
    if failed:
        print(f"RESULT: FAIL（{len(failed)} 项）：{', '.join(failed)}")
        return 1
    print(f"RESULT: PASS（{len(results)} 项全部通过）")
    return 0


if __name__ == "__main__":
    sys.exit(main())
