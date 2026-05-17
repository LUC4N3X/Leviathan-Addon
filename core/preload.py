from __future__ import annotations

import asyncio
import hashlib
import logging
import os
import time
from typing import Any
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

import httpx

from core.cache_utils import TTLCache
from core.config import coerce_float, coerce_int
from core.shared_state import (
    is_set_member,
    prefixed_key,
    set_member,
    shared_backend_name,
    sync_scard,
)

logger = logging.getLogger("torrenthan.preload")

PRELOAD_ENABLED = os.getenv("PRELOAD_ENABLED", "1").strip().lower() not in {"0", "false", "no", "off"}
PRELOAD_TIMEOUT = coerce_float(os.getenv("PRELOAD_TIMEOUT"), 8.0, minimum=1.0, maximum=60.0)
PRELOAD_CONCURRENCY = coerce_int(os.getenv("PRELOAD_CONCURRENCY"), 2, minimum=1, maximum=16)
PRELOAD_INTERNAL_BASE_URL = os.getenv("PRELOAD_INTERNAL_BASE_URL", "").strip().rstrip("/")
PRELOAD_SHUTDOWN_TIMEOUT = coerce_float(os.getenv("PRELOAD_SHUTDOWN_TIMEOUT"), 3.0, minimum=0.1, maximum=30.0)
PRELOAD_SHARED_DEDUPE_ENABLED = os.getenv("PRELOAD_SHARED_DEDUPE_ENABLED", "1").strip().lower() not in {"0", "false", "no", "off"}
_PRELOAD_TTL = coerce_int(os.getenv("PRELOAD_SEEN_TTL"), 120, minimum=10, maximum=3600)
_PRELOAD_LOCAL_CACHE_MAXSIZE = coerce_int(os.getenv("PRELOAD_LOCAL_CACHE_MAXSIZE"), 4096, minimum=128, maximum=100000)
_PRELOADED_LOCAL: TTLCache[bool] = TTLCache(maxsize=_PRELOAD_LOCAL_CACHE_MAXSIZE)
_PRELOAD_SET_KEY = prefixed_key("preload_seen")
_TASKS: set[asyncio.Task[None]] = set()
_TASKS_LOCK = asyncio.Lock()


def _append_preload_flag(url: str) -> str:
    parts = urlsplit(url)
    query = dict(parse_qsl(parts.query, keep_blank_values=True))
    query["preload"] = "1"
    new_query = urlencode(query, doseq=True)
    return urlunsplit((parts.scheme, parts.netloc, parts.path, new_query, parts.fragment))


def _rewrite_to_internal(url: str) -> str:
    if not PRELOAD_INTERNAL_BASE_URL:
        return url
    try:
        original = urlsplit(url)
        internal = urlsplit(PRELOAD_INTERNAL_BASE_URL)
        return urlunsplit((internal.scheme, internal.netloc, original.path, original.query, original.fragment))
    except Exception:
        return url


def _member_for_url(url: str) -> str:
    return hashlib.sha1(url.encode("utf-8")).hexdigest()


async def _mark_seen(url: str) -> bool:
    if _PRELOADED_LOCAL.get(url):
        return False

    member = _member_for_url(url)
    if PRELOAD_SHARED_DEDUPE_ENABLED:
        try:
            if await is_set_member(_PRELOAD_SET_KEY, member):
                _PRELOADED_LOCAL.set(url, True, _PRELOAD_TTL)
                return False
        except Exception:
            logger.debug("Shared preload membership check failed", exc_info=True)

    _PRELOADED_LOCAL.set(url, True, _PRELOAD_TTL)

    if PRELOAD_SHARED_DEDUPE_ENABLED:
        try:
            await set_member(_PRELOAD_SET_KEY, member, _PRELOAD_TTL)
        except Exception:
            logger.debug("Shared preload membership write failed", exc_info=True)

    return True


async def _ping(client: httpx.AsyncClient, url: str) -> None:
    target = _append_preload_flag(_rewrite_to_internal(url))
    if not await _mark_seen(target):
        return
    try:
        response = await client.get(
            target,
            follow_redirects=False,
            timeout=PRELOAD_TIMEOUT,
            headers={"x-preload": "1"},
        )
        logger.debug("Preload %s -> %s", target, response.status_code)
    except Exception as exc:
        logger.debug("Preload failed for %s: %s", target, exc)


async def schedule_preload(client: httpx.AsyncClient, streams: list[dict[str, Any]], *, limit: int = 1) -> None:
    if not PRELOAD_ENABLED or limit <= 0:
        return

    urls = [str(item.get("url") or "") for item in streams if str(item.get("url") or "")]
    urls = urls[:limit]
    if not urls:
        return

    semaphore = asyncio.Semaphore(PRELOAD_CONCURRENCY)

    async def _runner(url: str) -> None:
        async with semaphore:
            await _ping(client, url)

    async def _background() -> None:
        await asyncio.gather(*(_runner(url) for url in urls), return_exceptions=True)

    task = asyncio.create_task(_background())
    async with _TASKS_LOCK:
        _TASKS.add(task)
    task.add_done_callback(_discard_task)


def _discard_task(task: asyncio.Task[None]) -> None:
    async def _cleanup() -> None:
        async with _TASKS_LOCK:
            _TASKS.discard(task)
        try:
            task.result()
        except asyncio.CancelledError:
            logger.debug("Preload task cancelled")
        except Exception:
            logger.debug("Preload task failed", exc_info=True)

    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:
        return
    loop.create_task(_cleanup())


async def shutdown_preload_tasks() -> None:
    async with _TASKS_LOCK:
        pending = [task for task in _TASKS if not task.done()]

    if not pending:
        return

    for task in pending:
        task.cancel()

    try:
        await asyncio.wait_for(
            asyncio.gather(*pending, return_exceptions=True),
            timeout=PRELOAD_SHUTDOWN_TIMEOUT,
        )
    except asyncio.TimeoutError:
        logger.warning("Timed out waiting for preload tasks to stop")
    finally:
        async with _TASKS_LOCK:
            for task in list(_TASKS):
                if task.done():
                    _TASKS.discard(task)


def preload_stats() -> dict[str, Any]:
    shared_seen = sync_scard(_PRELOAD_SET_KEY) if PRELOAD_SHARED_DEDUPE_ENABLED else None
    return {
        "enabled": int(PRELOAD_ENABLED),
        "timeout": PRELOAD_TIMEOUT,
        "concurrency": PRELOAD_CONCURRENCY,
        "seen_entries": _PRELOADED_LOCAL.stats()["entries"],
        "shared_seen_entries": int(shared_seen or 0) if shared_seen is not None else 0,
        "shared_dedupe_enabled": int(PRELOAD_SHARED_DEDUPE_ENABLED),
        "shared_backend": shared_backend_name(),
        "active_tasks": sum(1 for task in _TASKS if not task.done()),
        "internal_base_configured": int(bool(PRELOAD_INTERNAL_BASE_URL)),
    }
