"""Docker 代码执行沙箱：预热容器池 + 五层硬隔离 + 结果缓存。

设计取舍：
- 不追求「一个容器跑完就扔」，而是每个语言维持一个预热容器（WARM），
  请求来了直接 exec，避免每次 2~3 秒的容器启动开销；
- 只读根文件系统 + 独立 tmpfs 临时目录 + 内存/CPU 上限 + 全部 Capability 移除
  + 禁网 + 非 root 用户 + pids 上限，保证跑的是「代码」而不是「我的机器」；
- 单次执行超时后直接 kill 容器并重建，超时线程的残留进程不会留在池里；
- 相同代码走 Redis 结果缓存（CACHED），命中后不再进容器。

状态机：CREATE → WARM → CLAIMED →（命中缓存时 CACHED）→ DESTROY → CREATE
"""

from __future__ import annotations

import asyncio
import base64
import hashlib
import json
import logging
import time
from concurrent.futures import ThreadPoolExecutor
from typing import Any

import docker
from docker.errors import DockerException, NotFound

from .config import settings
from .database import get_redis

logger = logging.getLogger("app.sandbox")

# 语言 → 镜像与命令包装。代码用 base64 传参，避免引号/换行把命令拼坏
RUNTIMES: dict[str, dict[str, Any]] = {
    "python": {
        "image": "python:3.11-alpine",
        "command": lambda code: ["python3", "-c", _python_wrapper(code)],
    },
    "node": {
        "image": "node:20-alpine",
        "command": lambda code: ["node", "-e", _node_wrapper(code)],
    },
}

LOCK = asyncio.Lock()
EXECUTOR = ThreadPoolExecutor(max_workers=4, thread_name_prefix="sandbox")

_client: docker.DockerClient | None = None
_containers: dict[str, Any] = {}
_state: dict[str, dict[str, Any]] = {
    lang: {"state": "CREATE", "runs": 0, "last_error": None, "container": None}
    for lang in RUNTIMES
}


class SandboxError(Exception):
    """沙箱不可用或执行失败，路由层转成明确 HTTP 状态码。"""


class SandboxUnavailable(SandboxError):
    pass


class SandboxTimeout(SandboxError):
    pass


def _python_wrapper(code: str) -> str:
    payload = base64.b64encode(code.encode("utf-8")).decode("ascii")
    return f"import base64;exec(base64.b64decode('{payload}').decode('utf-8'))"


def _node_wrapper(code: str) -> str:
    payload = base64.b64encode(code.encode("utf-8")).decode("ascii")
    return f"eval(Buffer.from('{payload}','base64').toString('utf-8'))"


def _client_or_raise() -> docker.DockerClient:
    global _client
    if _client is None:
        try:
            _client = docker.from_env()
            _client.ping()
        except DockerException as exc:
            raise SandboxUnavailable(f"Docker 不可用：{exc}") from exc
    return _client


def _create_container(lang: str) -> Any:
    client = _client_or_raise()
    spec = RUNTIMES[lang]
    _state[lang]["state"] = "CREATE"
    container = client.containers.run(
        spec["image"],
        # 容器常驻，代码通过 exec 注入；sleep 循环不占 CPU
        command=["sh", "-c", "while true; do sleep 5; done"],
        detach=True,
        # ① 只读根文件系统，代码改不了镜像内容
        read_only=True,
        # ② /tmp 走内存盘，限 64m 且允许 nobody 写入
        tmpfs={"/tmp": "size=64m,mode=1777"},
        # ③④ 内存与 CPU 上限
        mem_limit=settings.sandbox_memory,
        memswap_limit=settings.sandbox_memory,
        nano_cpus=int(settings.sandbox_cpus * 1e9),
        # ⑤ 禁网：容器内拿不到任何网络出口
        network_mode="none",
        # ⑥ 移除全部 Linux Capability，并禁止提权
        cap_drop=["ALL"],
        security_opt=["no-new-privileges:true"],
        # ⑦ 进程数上限 + 非 root 运行（seccomp 走 Docker 默认白名单）
        pids_limit=64,
        user="65534:65534",
        working_dir="/tmp",
        environment={"PYTHONUNBUFFERED": "1", "NODE_NO_WARNINGS": "1"},
        labels={"app": "answery-sandbox", "runtime": lang},
    )
    _state[lang].update(state="WARM", container=container.id[:12], last_error=None)
    logger.info("沙箱容器就绪：%s (%s)", lang, container.id[:12])
    return container


def _destroy_container(lang: str, reason: str | None = None) -> None:
    container = _containers.pop(lang, None)
    _state[lang].update(state="DESTROY", container=None, last_error=reason)
    if container is None:
        return
    try:
        container.remove(force=True)
    except NotFound:
        pass
    except DockerException as exc:
        logger.warning("沙箱容器清理失败：%s", exc)


def _ensure_container(lang: str) -> Any:
    """取一个可用容器：没有就建，已退出就重建。"""
    container = _containers.get(lang)
    if container is not None:
        try:
            container.reload()
            if container.status == "running":
                _state[lang].update(state="WARM", container=container.id[:12])
                return container
        except NotFound:
            pass
        _destroy_container(lang, "容器已退出")
    container = _create_container(lang)
    _containers[lang] = container
    return container


def _exec(container: Any, cmd: list[str]) -> tuple[int, bytes]:
    exit_code, output = container.exec_run(cmd, demux=False, tty=False)
    return exit_code, output


def _cleanup_stale() -> None:
    """启动时清掉上次进程遗留的沙箱容器，避免占内存。"""
    client = _client_or_raise()
    for container in client.containers.list(all=True, filters={"label": "app=answery-sandbox"}):
        try:
            container.remove(force=True)
        except DockerException:
            pass


def _cache_key(language: str, code: str) -> str:
    digest = hashlib.sha256(f"{language}\n{code}".encode("utf-8")).hexdigest()
    return f"sandbox:result:{digest}"


async def _cache_get(language: str, code: str) -> dict[str, Any] | None:
    try:
        raw = await get_redis().get(_cache_key(language, code))
    except Exception:  # Redis 挂了不影响执行
        return None
    if not raw:
        return None
    try:
        return json.loads(raw)
    except ValueError:
        return None


async def _cache_put(language: str, code: str, payload: dict[str, Any]) -> None:
    try:
        await get_redis().set(_cache_key(language, code), json.dumps(payload), ex=settings.sandbox_cache_ttl)
    except Exception:
        pass


async def warm_up() -> None:
    """启动时预热 Python / Node 两个运行时；失败只记日志。"""
    if not settings.sandbox_enabled:
        return
    try:
        loop = asyncio.get_running_loop()
        await loop.run_in_executor(EXECUTOR, _cleanup_stale)
        await asyncio.gather(
            *(loop.run_in_executor(EXECUTOR, _ensure_container, lang) for lang in RUNTIMES)
        )
        logger.info("沙箱预热完成：%s", ", ".join(RUNTIMES))
    except Exception as exc:  # noqa: BLE001
        logger.warning("沙箱预热失败（不影响主流程）：%s", exc)


async def shutdown() -> None:
    for lang in list(_containers):
        _destroy_container(lang, "服务退出")
    if _client is not None:
        try:
            _client.close()
        except DockerException:
            pass


async def run_code(language: str, code: str) -> dict[str, Any]:
    if not settings.sandbox_enabled:
        raise SandboxUnavailable("沙箱功能已关闭（SANDBOX_ENABLED=false）")
    if language not in RUNTIMES:
        raise SandboxError(f"暂不支持的语言：{language}，可选 {', '.join(RUNTIMES)}")
    code = code or ""
    if not code.strip():
        raise SandboxError("代码不能为空")
    if len(code) > settings.sandbox_code_limit:
        raise SandboxError(f"代码超长（上限 {settings.sandbox_code_limit} 字符）")

    cached = await _cache_get(language, code)
    if cached:
        _state[language].update(state="CACHED")
        return {**cached, "cached": True, "pool_state": "CACHED"}

    loop = asyncio.get_running_loop()
    async with LOCK:
        container = await loop.run_in_executor(EXECUTOR, _ensure_container, language)
        _state[language].update(state="CLAIMED")
        _state[language]["runs"] += 1
        cmd = RUNTIMES[language]["command"](code)
        started = time.perf_counter()
        try:
            exit_code, output = await asyncio.wait_for(
                loop.run_in_executor(EXECUTOR, _exec, container, cmd),
                timeout=settings.sandbox_timeout,
            )
        except asyncio.TimeoutError as exc:
            # 超时：直接销毁容器，重建一个干净的预热实例
            await loop.run_in_executor(EXECUTOR, _destroy_container, language, "执行超时")
            await loop.run_in_executor(EXECUTOR, _ensure_container, language)
            raise SandboxTimeout(f"执行超时（>{settings.sandbox_timeout}s），容器已销毁重建") from exc
        except DockerException as exc:
            _destroy_container(language, str(exc))
            raise SandboxUnavailable(f"容器执行失败：{exc}") from exc

        duration_ms = int((time.perf_counter() - started) * 1000)
        text = output.decode("utf-8", errors="replace") if isinstance(output, (bytes, bytearray)) else str(output)
        truncated = False
        if len(text) > 4000:
            text = text[:4000]
            truncated = True
        _state[language].update(state="WARM")

    payload = {
        "language": language,
        "exit_code": exit_code,
        "output": text,
        "truncated": truncated,
        "duration_ms": duration_ms,
    }
    await _cache_put(language, code, payload)
    return {**payload, "cached": False, "pool_state": "CLAIMED→WARM"}


def status() -> dict[str, Any]:
    images: dict[str, bool] = {}
    try:
        client = _client_or_raise()
        tags = {f"{tag.split(':')[0]}:{tag.split(':')[-1]}" for image in client.images.list() for tag in (image.tags or [])}
        images = {lang: spec["image"] in tags for lang, spec in RUNTIMES.items()}
        version = client.version().get("Version")
    except SandboxError:
        version = None
    except DockerException as exc:
        version = None
        logger.warning("沙箱状态探测失败：%s", exc)
    return {
        "enabled": settings.sandbox_enabled,
        "docker_version": version,
        "images": images,
        "runtimes": list(RUNTIMES),
        "limits": {
            "timeout_s": settings.sandbox_timeout,
            "memory": settings.sandbox_memory,
            "cpus": settings.sandbox_cpus,
            "code_limit": settings.sandbox_code_limit,
            "network": "none",
            "rootfs": "read-only",
            "capabilities": "ALL dropped",
            "user": "65534:65534",
        },
        "pool": {lang: dict(info) for lang, info in _state.items()},
    }
