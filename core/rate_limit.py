from __future__ import annotations

import asyncio
import heapq
import os
import time
from typing import Any

from fastapi import Request
from fastapi.responses import JSONResponse, Response

from core.config import coerce_float, coerce_int, normalize_csv_items

RATE_LIMIT_ENABLED = os.getenv("RATE_LIMIT_ENABLED", "1").strip().lower() not in {"0", "false", "no", "off"}
RATE_LIMIT_WINDOW = coerce_float(os.getenv("RATE_LIMIT_WINDOW_SECONDS"), 60.0, minimum=1.0, maximum=3600.0)
RATE_LIMIT_STREAM_REQUESTS = coerce_int(os.getenv("RATE_LIMIT_STREAM_REQUESTS"), 60, minimum=1, maximum=50000)
RATE_LIMIT_PLAYBACK_REQUESTS = coerce_int(os.getenv("RATE_LIMIT_PLAYBACK_REQUESTS"), 45, minimum=1, maximum=50000)
RATE_LIMIT_BYPASS_IPS = frozenset(normalize_csv_items(os.getenv("RATE_LIMIT_BYPASS_IPS", "")))
RATE_LIMIT_EXEMPT_PATHS = tuple(
    path.strip()
    for path in os.getenv("RATE_LIMIT_EXEMPT_PATHS", "/health,/health/details,/manifest.json,/api/config-token").split(",")
    if path.strip()
)

_LOCK = asyncio.Lock()
_BUCKETS: dict[str, dict[str, float]] = {}
_EXPIRY_HEAP: list[tuple[float, str]] = []


def _prune_expired_locked(now: float) -> None:
    while _EXPIRY_HEAP and _EXPIRY_HEAP[0][0] <= now:
        reset_at, key = heapq.heappop(_EXPIRY_HEAP)
        state = _BUCKETS.get(key)
        if state is None:
            continue
        if float(state.get("reset_at", 0.0) or 0.0) != float(reset_at):
            continue
        if float(state.get("reset_at", 0.0) or 0.0) <= now:
            _BUCKETS.pop(key, None)


def _extract_client_ip(request: Request) -> str:
    forwarded = str(request.headers.get("x-forwarded-for", "") or "").strip()
    if forwarded:
        first = forwarded.split(",")[0].strip().lower()
        if first:
            return first

    real_ip = str(request.headers.get("x-real-ip", "") or "").strip().lower()
    if real_ip:
        return real_ip

    if request.client and request.client.host:
        return str(request.client.host).strip().lower()

    return "unknown"


def _scope_for_request(request: Request) -> tuple[str, int]:
    path = str(request.url.path or "")
    if "/stream/" in path:
        return "stream", RATE_LIMIT_STREAM_REQUESTS
    if "/playback/" in path:
        return "playback", RATE_LIMIT_PLAYBACK_REQUESTS
    return "", 0


def _is_bypassed(request: Request, ip_address: str, scope: str) -> bool:
    if not RATE_LIMIT_ENABLED or not scope:
        return True

    path = str(request.url.path or "")
    if any(path.endswith(exempt) or path == exempt for exempt in RATE_LIMIT_EXEMPT_PATHS):
        return True

    if ip_address in RATE_LIMIT_BYPASS_IPS:
        return True

    if request.headers.get("x-preload") == "1" or request.query_params.get("preload") == "1":
        return True

    return False


async def enforce_rate_limit(request: Request) -> Response | None:
    scope, limit = _scope_for_request(request)
    client_ip = _extract_client_ip(request)

    if _is_bypassed(request, client_ip, scope):
        return None

    now = time.time()
    bucket_key = f"{scope}:{client_ip}"

    async with _LOCK:
        _prune_expired_locked(now)

        state = _BUCKETS.get(bucket_key)
        if state is None:
            reset_at = now + RATE_LIMIT_WINDOW
            state = {"count": 0.0, "reset_at": reset_at}
            _BUCKETS[bucket_key] = state
            heapq.heappush(_EXPIRY_HEAP, (reset_at, bucket_key))

        remaining_window = max(1, int(round(float(state["reset_at"]) - now)))
        current_count = int(state.get("count", 0.0))
        if current_count >= limit:
            return JSONResponse(
                status_code=429,
                content={
                    "error": "Too many requests",
                    "scope": scope,
                    "retry_after_seconds": remaining_window,
                },
                headers={
                    "Retry-After": str(remaining_window),
                    "X-RateLimit-Scope": scope,
                    "X-RateLimit-Limit": str(limit),
                    "X-RateLimit-Remaining": "0",
                },
            )

        state["count"] = current_count + 1
        request.state.rate_limit_scope = scope
        request.state.rate_limit_limit = limit
        request.state.rate_limit_remaining = max(0, limit - int(state["count"]))
        request.state.rate_limit_reset_at = float(state["reset_at"])

    return None


def annotate_response_headers(request: Request, response: Response) -> None:
    scope = getattr(request.state, "rate_limit_scope", "")
    if not scope:
        return
    limit = int(getattr(request.state, "rate_limit_limit", 0) or 0)
    remaining = int(getattr(request.state, "rate_limit_remaining", 0) or 0)
    reset_at = float(getattr(request.state, "rate_limit_reset_at", 0.0) or 0.0)
    response.headers["X-RateLimit-Scope"] = scope
    response.headers["X-RateLimit-Limit"] = str(limit)
    response.headers["X-RateLimit-Remaining"] = str(max(0, remaining))
    if reset_at > 0:
        response.headers["X-RateLimit-Reset"] = str(max(1, int(round(reset_at - time.time()))))


def rate_limit_stats() -> dict[str, Any]:
    now = time.time()
    _prune_expired_locked(now)
    return {
        "enabled": int(RATE_LIMIT_ENABLED),
        "window_seconds": RATE_LIMIT_WINDOW,
        "stream_requests": RATE_LIMIT_STREAM_REQUESTS,
        "playback_requests": RATE_LIMIT_PLAYBACK_REQUESTS,
        "active_buckets": len(_BUCKETS),
    }
