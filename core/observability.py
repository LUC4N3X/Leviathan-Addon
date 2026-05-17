from __future__ import annotations

import time
from typing import Any

from prometheus_client import CONTENT_TYPE_LATEST, Counter, Gauge, Histogram, generate_latest

HTTP_REQUESTS_TOTAL = Counter(
    "torrenthan_http_requests_total",
    "HTTP requests handled by Torrenthan",
    ["method", "route", "status"],
)
HTTP_REQUEST_DURATION_SECONDS = Histogram(
    "torrenthan_http_request_duration_seconds",
    "HTTP request latency",
    ["method", "route", "status"],
    buckets=(0.01, 0.03, 0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 30),
)
RD_CACHE_PROBE_TOTAL = Counter(
    "torrenthan_rd_cache_probe_total",
    "Real-Debrid cache probe outcomes",
    ["result", "source"],
)
DEBRID_CACHE_CHECK_TOTAL = Counter(
    "torrenthan_debrid_cache_check_total",
    "Debrid cache check outcomes",
    ["provider", "result"],
)
FALLBACK_RESOLVE_TOTAL = Counter(
    "torrenthan_fallback_resolve_total",
    "Fallback resolution outcomes",
    ["result"],
)
RATE_LIMIT_TOTAL = Counter(
    "torrenthan_rate_limit_total",
    "Rate limit blocks",
    ["scope", "reason"],
)
RD_API_QUOTA_REMAINING = Gauge(
    "torrenthan_rd_api_quota_remaining",
    "Last observed Real-Debrid quota remaining if exposed by upstream headers",
)
APP_UPTIME_SECONDS = Gauge(
    "torrenthan_uptime_seconds",
    "Process uptime seconds",
)


def observe_http_request(method: str, route: str, status_code: int, elapsed_seconds: float) -> None:
    status = str(int(status_code))
    safe_route = str(route or "unknown")[:160]
    safe_method = str(method or "GET").upper()[:12]
    HTTP_REQUESTS_TOTAL.labels(safe_method, safe_route, status).inc()
    HTTP_REQUEST_DURATION_SECONDS.labels(safe_method, safe_route, status).observe(max(0.0, float(elapsed_seconds)))


def record_rd_probe(result: str, source: str = "live") -> None:
    RD_CACHE_PROBE_TOTAL.labels(str(result or "unknown"), str(source or "live")).inc()


def record_debrid_cache_check(provider: str, result: str, amount: int = 1) -> None:
    DEBRID_CACHE_CHECK_TOTAL.labels(str(provider or "unknown"), str(result or "unknown")).inc(max(0, int(amount)))


def record_fallback_resolve(result: str) -> None:
    FALLBACK_RESOLVE_TOTAL.labels(str(result or "unknown")).inc()


def record_rate_limit(scope: str, reason: str) -> None:
    RATE_LIMIT_TOTAL.labels(str(scope or "unknown"), str(reason or "blocked")).inc()


def observe_rd_headers(headers: Any) -> None:
    if not headers:
        return
    for key in ("x-ratelimit-remaining", "x-rate-limit-remaining", "x-rd-rate-limit-remaining"):
        raw = headers.get(key) or headers.get(key.upper())
        if raw in (None, ""):
            continue
        try:
            RD_API_QUOTA_REMAINING.set(float(raw))
        except Exception:
            pass
        break


def set_uptime(started_at: float) -> None:
    APP_UPTIME_SECONDS.set(max(0.0, time.time() - float(started_at)))


def render_metrics() -> tuple[bytes, str]:
    payload = generate_latest()
    return payload, CONTENT_TYPE_LATEST
