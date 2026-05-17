from __future__ import annotations

import asyncio
import gzip
import json
import logging
import os
import random
import time
import zlib
from collections import OrderedDict
from dataclasses import dataclass
from email.utils import parsedate_to_datetime
from functools import lru_cache
from typing import Any
from urllib.parse import quote, urlsplit

_HTTPX_REQUEST_ERRORS: tuple[type[BaseException], ...] = ()

try:
    from curl_cffi.requests import AsyncSession, Response
    from curl_cffi.requests.errors import RequestsError
except Exception:
    import httpx

    AsyncSession = httpx.AsyncClient
    Response = httpx.Response
    _HTTPX_REQUEST_ERRORS = (httpx.RequestError, httpx.TimeoutException)

    class RequestsError(Exception):
        pass


logger = logging.getLogger("torrenthan")


@dataclass(frozen=True, slots=True)
class _BrowserProfile:
    impersonate: str
    accept_language: str
    user_agent: str
    sec_ch_ua: str | None = None
    sec_ch_ua_platform: str | None = None
    sec_ch_ua_mobile: str | None = "?0"
    platform_hint: str = "Windows"
    accept_encoding_pool: tuple[str, ...] = ("gzip, deflate, br", "gzip, deflate")
    referer_pool: tuple[str, ...] = (
        "https://web.stremio.com/",
        "https://app.stremio.com/",
        "https://www.stremio.com/",
    )
    dnt: str | None = None


_BROWSER_PROFILES: tuple[_BrowserProfile, ...] = (
    _BrowserProfile(
        impersonate="chrome120",
        accept_language="it-IT,it;q=0.9,en-US;q=0.8,en;q=0.7",
        user_agent="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        sec_ch_ua='"Chromium";v="120", "Google Chrome";v="120", "Not=A?Brand";v="99"',
        sec_ch_ua_platform='"Windows"',
        platform_hint="Windows",
        dnt="1",
    ),
    _BrowserProfile(
        impersonate="chrome120",
        accept_language="it-IT,it;q=0.9,en;q=0.8",
        user_agent="Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        sec_ch_ua='"Chromium";v="120", "Google Chrome";v="120", "Not=A?Brand";v="99"',
        sec_ch_ua_platform='"macOS"',
        platform_hint="macOS",
    ),
    _BrowserProfile(
        impersonate="chrome123",
        accept_language="it-IT,it;q=0.9,en;q=0.8",
        user_agent="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36",
        sec_ch_ua='"Chromium";v="123", "Google Chrome";v="123", "Not:A-Brand";v="8"',
        sec_ch_ua_platform='"Windows"',
        platform_hint="Windows",
    ),
    _BrowserProfile(
        impersonate="chrome124",
        accept_language="en-US,en;q=0.9,it;q=0.8",
        user_agent="Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        sec_ch_ua='"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"',
        sec_ch_ua_platform='"Linux"',
        platform_hint="Linux",
    ),
    _BrowserProfile(
        impersonate="chrome126",
        accept_language="it;q=0.9,en-US;q=0.8,en;q=0.7",
        user_agent="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
        sec_ch_ua='"Chromium";v="126", "Google Chrome";v="126", "Not/A)Brand";v="8"',
        sec_ch_ua_platform='"Windows"',
        platform_hint="Windows",
        dnt="1",
    ),
    _BrowserProfile(
        impersonate="chrome128",
        accept_language="en-GB,en;q=0.9,it-IT;q=0.8,it;q=0.7",
        user_agent="Mozilla/5.0 (Macintosh; Intel Mac OS X 14_4_1) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
        sec_ch_ua='"Chromium";v="128", "Google Chrome";v="128", "Not;A=Brand";v="24"',
        sec_ch_ua_platform='"macOS"',
        platform_hint="macOS",
    ),
    _BrowserProfile(
        impersonate="chrome131",
        accept_language="it-IT,it;q=0.9,en-US;q=0.8,en;q=0.7",
        user_agent="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
        sec_ch_ua='"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"',
        sec_ch_ua_platform='"Windows"',
        platform_hint="Windows",
    ),
    _BrowserProfile(
        impersonate="chrome133",
        accept_language="en-US,en;q=0.9",
        user_agent="Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36",
        sec_ch_ua='"Chromium";v="133", "Google Chrome";v="133", "Not(A:Brand";v="99"',
        sec_ch_ua_platform='"Linux"',
        platform_hint="Linux",
    ),
    _BrowserProfile(
        impersonate="chrome136",
        accept_language="it;q=0.9,en-US;q=0.8,en;q=0.7",
        user_agent="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36",
        sec_ch_ua='"Chromium";v="136", "Google Chrome";v="136", "Not.A/Brand";v="24"',
        sec_ch_ua_platform='"Windows"',
        platform_hint="Windows",
        dnt="1",
    ),
    _BrowserProfile(
        impersonate="chrome136",
        accept_language="it-IT,it;q=0.9,en-US;q=0.8",
        user_agent="Mozilla/5.0 (Macintosh; Intel Mac OS X 15_4) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36",
        sec_ch_ua='"Chromium";v="136", "Google Chrome";v="136", "Not.A/Brand";v="24"',
        sec_ch_ua_platform='"macOS"',
        platform_hint="macOS",
    ),
    _BrowserProfile(
        impersonate="edge101",
        accept_language="en-US,en;q=0.9,it-IT;q=0.8,it;q=0.7",
        user_agent="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/101.0.4951.64 Safari/537.36 Edg/101.0.1210.53",
        sec_ch_ua='"Microsoft Edge";v="101", "Chromium";v="101", "Not A;Brand";v="99"',
        sec_ch_ua_platform='"Windows"',
        platform_hint="Windows",
    ),
    _BrowserProfile(
        impersonate="edge120",
        accept_language="it-IT,it;q=0.9,en;q=0.8",
        user_agent="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 Edg/120.0.0.0",
        sec_ch_ua='"Microsoft Edge";v="120", "Chromium";v="120", "Not=A?Brand";v="99"',
        sec_ch_ua_platform='"Windows"',
        platform_hint="Windows",
    ),
    _BrowserProfile(
        impersonate="edge131",
        accept_language="en-US,en;q=0.9,it;q=0.8",
        user_agent="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0",
        sec_ch_ua='"Microsoft Edge";v="131", "Chromium";v="131", "Not_A Brand";v="24"',
        sec_ch_ua_platform='"Windows"',
        platform_hint="Windows",
    ),
    _BrowserProfile(
        impersonate="safari17_0",
        accept_language="it-IT,it;q=0.8,en-GB;q=0.7,en;q=0.6",
        user_agent="Mozilla/5.0 (Macintosh; Intel Mac OS X 14_4_1) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4.1 Safari/605.1.15",
        sec_ch_ua=None,
        sec_ch_ua_platform=None,
        sec_ch_ua_mobile=None,
        platform_hint="macOS",
        accept_encoding_pool=("gzip, deflate", "gzip, deflate, br"),
        referer_pool=("https://web.stremio.com/", "https://www.stremio.com/"),
    ),
    _BrowserProfile(
        impersonate="safari17_2_ios",
        accept_language="it-IT,it;q=0.9,en-US;q=0.8",
        user_agent="Mozilla/5.0 (iPhone; CPU iPhone OS 17_4_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4.1 Mobile/15E148 Safari/604.1",
        sec_ch_ua=None,
        sec_ch_ua_platform=None,
        sec_ch_ua_mobile="?1",
        platform_hint="iOS",
        accept_encoding_pool=("gzip, deflate",),
        referer_pool=("https://web.stremio.com/",),
    ),
    _BrowserProfile(
        impersonate="safari18_0",
        accept_language="en-US,en;q=0.9",
        user_agent="Mozilla/5.0 (Macintosh; Intel Mac OS X 15_0) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15",
        sec_ch_ua=None,
        sec_ch_ua_platform=None,
        sec_ch_ua_mobile=None,
        platform_hint="macOS",
        accept_encoding_pool=("gzip, deflate, br",),
    ),
    _BrowserProfile(
        impersonate="firefox117",
        accept_language="it-IT,it;q=0.8,en-US;q=0.5,en;q=0.3",
        user_agent="Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:117.0) Gecko/20100101 Firefox/117.0",
        sec_ch_ua=None,
        sec_ch_ua_platform=None,
        sec_ch_ua_mobile=None,
        platform_hint="Windows",
        accept_encoding_pool=("gzip, deflate, br",),
        dnt="1",
    ),
    _BrowserProfile(
        impersonate="firefox120",
        accept_language="en-US,en;q=0.7,it;q=0.3",
        user_agent="Mozilla/5.0 (X11; Linux x86_64; rv:120.0) Gecko/20100101 Firefox/120.0",
        sec_ch_ua=None,
        sec_ch_ua_platform=None,
        sec_ch_ua_mobile=None,
        platform_hint="Linux",
        accept_encoding_pool=("gzip, deflate, br",),
        dnt="1",
    ),
    _BrowserProfile(
        impersonate="firefox124",
        accept_language="it-IT,it;q=0.8,en-US;q=0.5,en;q=0.3",
        user_agent="Mozilla/5.0 (Macintosh; Intel Mac OS X 14.4; rv:124.0) Gecko/20100101 Firefox/124.0",
        sec_ch_ua=None,
        sec_ch_ua_platform=None,
        sec_ch_ua_mobile=None,
        platform_hint="macOS",
        accept_encoding_pool=("gzip, deflate, br",),
    ),
    _BrowserProfile(
        impersonate="chrome120",
        accept_language="it-IT,it;q=0.9,en-US;q=0.8",
        user_agent="Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.6099.144 Mobile Safari/537.36",
        sec_ch_ua='"Chromium";v="120", "Google Chrome";v="120", "Not=A?Brand";v="99"',
        sec_ch_ua_platform='"Android"',
        sec_ch_ua_mobile="?1",
        platform_hint="Android",
        accept_encoding_pool=("gzip, deflate, br",),
    ),
    _BrowserProfile(
        impersonate="chrome131",
        accept_language="en-US,en;q=0.9",
        user_agent="Mozilla/5.0 (Linux; Android 14; SM-S928B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.6778.135 Mobile Safari/537.36",
        sec_ch_ua='"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"',
        sec_ch_ua_platform='"Android"',
        sec_ch_ua_mobile="?1",
        platform_hint="Android",
        accept_encoding_pool=("gzip, deflate, br",),
    ),
)

TORRENTIO_DEFAULT_BASE_URL = "https://torrentio.strem.fun"
TORRENTIO_BASE_URLS: tuple[str, ...] = (TORRENTIO_DEFAULT_BASE_URL,)

_SAFE_IMPERSONATE_TARGETS: tuple[str, ...] = (
    "chrome120",
    "safari17_0",
    "safari17_2_ios",
)

_SAFE_BROWSER_PROFILES: tuple[_BrowserProfile, ...] = (
    tuple(p for p in _BROWSER_PROFILES if p.impersonate in _SAFE_IMPERSONATE_TARGETS)
    or _BROWSER_PROFILES
)

_IMPERSONATE_TARGETS: tuple[str, ...] = tuple(sorted({p.impersonate for p in _SAFE_BROWSER_PROFILES}))

_ACCEPT_VARIANTS: tuple[str, ...] = (
    "application/json, text/plain, */*",
    "application/json,text/plain;q=0.9,*/*;q=0.8",
    "application/json;q=0.9,*/*;q=0.8",
)

_CACHE_CONTROL_VARIANTS: tuple[str, ...] = (
    "no-cache",
    "no-store, no-cache",
    "max-age=0, no-cache",
    "max-age=0",
)


def _normalize_base_url(value: str) -> str:
    raw = str(value or "").strip().rstrip("/")
    if not raw:
        return ""
    if not raw.startswith(("http://", "https://")):
        raw = f"https://{raw}"
    parsed = urlsplit(raw)
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        return ""
    path = parsed.path.rstrip("/")
    return f"{parsed.scheme}://{parsed.netloc}{path}"


def _env_bool(name: str, default: bool = False) -> bool:
    raw = os.getenv(name)
    if raw is None:
        return default
    value = raw.strip().lower()
    if value in {"1", "true", "yes", "on", "enabled", "enable"}:
        return True
    if value in {"0", "false", "no", "off", "disabled", "disable"}:
        return False
    return default


def _env_int(name: str, default: int, *, minimum: int, maximum: int) -> int:
    try:
        parsed = int(str(os.getenv(name, default)).strip())
    except (TypeError, ValueError):
        parsed = default
    return max(minimum, min(maximum, parsed))


def _env_status_set(name: str, default: set[int]) -> set[int]:
    raw = os.getenv(name, "").strip()
    if not raw:
        return set(default)
    parsed: set[int] = set()
    for item in raw.split(","):
        try:
            code = int(item.strip())
        except ValueError:
            continue
        if 100 <= code <= 599:
            parsed.add(code)
    return parsed or set(default)


def _mask_proxy_url(value: str) -> str:
    raw = str(value or "").strip()
    if not raw:
        return ""
    parsed = urlsplit(raw)
    if not parsed.scheme or not parsed.netloc:
        return "configured"
    host = parsed.hostname or "proxy"
    port = f":{parsed.port}" if parsed.port else ""
    return f"{parsed.scheme}://***:***@{host}{port}" if parsed.username or parsed.password else f"{parsed.scheme}://{host}{port}"


def _proxy_config(proxy_url: str) -> dict[str, str]:
    if not proxy_url:
        return {}
    return {"http": proxy_url, "https": proxy_url}


def _split_proxy_urls(raw: str) -> tuple[str, ...]:
    values: list[str] = []

    for item in str(raw or "").replace("\n", ",").split(","):
        value = item.strip().strip('"').strip("'")
        if value and value not in values:
            values.append(value)

    return tuple(values)


def _env_proxy_urls(primary_env: str, legacy_env: str = "") -> tuple[str, ...]:
    configured = _split_proxy_urls(os.getenv(primary_env, ""))
    if configured:
        return configured
    return _split_proxy_urls(os.getenv(legacy_env, "")) if legacy_env else ()


DEFAULT_BASE_URL = TORRENTIO_BASE_URLS[0]

DEFAULT_TIMEOUT = 12.0
MAX_RETRIES = 3
RETRY_BASE_DELAY = 0.65
RETRY_MAX_DELAY = 7.0

SESSION_MAX_CLIENTS = 4
ALLOW_REDIRECTS = True
TRUST_ENV = False

RETRYABLE_STATUS_CODES = {408, 409, 425, 500, 502, 503, 504}
BAN_SIGNAL_CODES = {403, 429}
BREAKER_FAILURE_STATUS_CODES = RETRYABLE_STATUS_CODES | BAN_SIGNAL_CODES

RL_REQUESTS_PER_SECOND = 0.85
RL_BURST = 2
RL_MIN_SPACING = 0.9
RL_BACKOFF_MULTIPLIER = 3.5
RL_BACKOFF_DECAY = 120.0

MAX_CONCURRENT_REQUESTS = 2

SESSION_MAX_REQUESTS = 30
SESSION_MAX_AGE = 180.0
SESSION_ROTATE_ON_BAN = True

CACHE_TTL = 420
CACHE_MAX_ENTRIES = 8192
CACHE_STALE_SERVE_TTL = 7200

CB_FAILURE_THRESHOLD = 5
CB_RECOVERY_TIMEOUT = 75.0
CB_HALF_OPEN_MAX = 1

BG_FETCH_TIMEOUT = 8.0
ENDPOINT_COOLDOWN_MAX = 900.0

# Proxy fallback opzionale: resta spento finché non abiliti le env var.
# Usalo solo per endpoint che sei autorizzato a raggiungere. Di default non proxyamo i 429:
# il Retry-After/rate limit va rispettato, non aggirato.
PROXY_FALLBACK_ENABLED = _env_bool("TORRENTHAN_PROXY_FALLBACK_ENABLED", False)
PROXY_FALLBACK_URLS = _env_proxy_urls("TORRENTHAN_PROXY_URLS", "TORRENTHAN_PROXY_URL")
PROXY_FALLBACK_URL = PROXY_FALLBACK_URLS[0] if PROXY_FALLBACK_URLS else ""
PROXY_FALLBACK_ON_STATUS = _env_status_set("TORRENTHAN_PROXY_ON_STATUS", {403, 502, 503, 504})
PROXY_FALLBACK_ON_NETWORK_ERROR = _env_bool("TORRENTHAN_PROXY_ON_NETWORK_ERROR", True)
PROXY_FALLBACK_COOLDOWN = _env_int("TORRENTHAN_PROXY_COOLDOWN_SECONDS", 300, minimum=30, maximum=3600)
PROXY_FALLBACK_MAX_ATTEMPTS = _env_int("TORRENTHAN_PROXY_MAX_ATTEMPTS", 1, minimum=1, maximum=10)
PROXY_FALLBACK_DISABLE_ON_429 = _env_bool("TORRENTHAN_PROXY_DISABLE_ON_429", True)
PROXY_FALLBACK_ACTIVE = bool(PROXY_FALLBACK_ENABLED and PROXY_FALLBACK_URLS)

_HAS_BROTLI = False
_brotli_decompress = None

try:
    import brotli as _brotli

    _brotli_decompress = _brotli.decompress
    _HAS_BROTLI = True
except Exception:
    try:
        import brotlicffi as _brotli

        _brotli_decompress = _brotli.decompress
        _HAS_BROTLI = True
    except Exception:
        _brotli_decompress = None
        _HAS_BROTLI = False


class TorrentioError(RuntimeError):
    pass


class TorrentioResponseError(TorrentioError):
    pass


class TorrentioPayloadEmpty(TorrentioResponseError):
    pass


class TorrentioHTTPError(TorrentioError):
    def __init__(
        self,
        status_code: int,
        url: str,
        message: str | None = None,
        *,
        retry_after: float | None = None,
    ):
        self.status_code = int(status_code)
        self.url = url
        self.retry_after = retry_after
        super().__init__(message or f"Torrentio HTTP {self.status_code} su {url}")


class TorrentioCircuitOpenError(TorrentioError):
    pass


class TorrentioRateLimitedError(TorrentioError):
    pass


def _safe_preview(raw: bytes, limit: int = 80) -> str:
    if not raw:
        return "<empty>"
    return raw[:limit].hex(" ")


def _normalize_options(torrentio_options: str = "") -> str:
    if not torrentio_options:
        return ""
    return str(torrentio_options).strip().strip("/").replace(" ", "")


@lru_cache(maxsize=4096)
def _build_torrentio_url_cached(
    base_url: str,
    media_type: str,
    media_id: str,
    torrentio_options: str,
) -> str:
    base = _normalize_base_url(base_url) or DEFAULT_BASE_URL
    mt = quote(str(media_type).strip().lower(), safe="")
    mi = quote(str(media_id).strip(), safe=":")
    opts = _normalize_options(torrentio_options)

    if opts:
        return f"{base}/{opts}/stream/{mt}/{mi}.json"

    return f"{base}/stream/{mt}/{mi}.json"


def build_torrentio_url(
    media_type: str,
    media_id: str,
    torrentio_options: str = "",
    *,
    base_url: str | None = None,
) -> str:
    return _build_torrentio_url_cached(
        str(base_url or DEFAULT_BASE_URL),
        str(media_type or ""),
        str(media_id or ""),
        str(torrentio_options or ""),
    )


def _cache_key(media_type: str, media_id: str, torrentio_options: str) -> str:
    mt = str(media_type or "").strip().lower()
    mi = str(media_id or "").strip()
    opts = _normalize_options(torrentio_options)
    return f"{mt}|{mi}|{opts}"


def _choose_browser_profile(impersonate: str | None = None) -> _BrowserProfile:
    pool = _SAFE_BROWSER_PROFILES

    if impersonate:
        matches = [p for p in pool if p.impersonate == impersonate]
        if matches:
            return random.choice(matches)

        logger.debug(
            "Impersonate Torrentio non supportato o disabilitato: %s, uso profilo sicuro",
            impersonate,
        )

    return random.choice(pool)


def _build_headers_for_profile(profile: _BrowserProfile) -> dict[str, str]:
    headers: dict[str, str] = {
        "User-Agent": profile.user_agent,
        "Accept": random.choice(_ACCEPT_VARIANTS),
        "Accept-Language": profile.accept_language,
        "Cache-Control": random.choice(_CACHE_CONTROL_VARIANTS),
        "Referer": random.choice(profile.referer_pool),
        "Origin": "https://web.stremio.com",
        "Sec-Fetch-Dest": "empty",
        "Sec-Fetch-Mode": "cors",
        "Sec-Fetch-Site": "cross-site",
    }

    if profile.sec_ch_ua is not None:
        headers["Sec-Ch-Ua"] = profile.sec_ch_ua
        if profile.sec_ch_ua_mobile is not None:
            headers["Sec-Ch-Ua-Mobile"] = profile.sec_ch_ua_mobile
        if profile.sec_ch_ua_platform is not None:
            headers["Sec-Ch-Ua-Platform"] = profile.sec_ch_ua_platform

    if profile.dnt is not None:
        headers["DNT"] = profile.dnt

    return headers


def _pick_accept_encoding(profile: _BrowserProfile) -> str:
    choices: list[str] = []

    for candidate in profile.accept_encoding_pool:
        parts: list[str] = []

        for raw_part in str(candidate or "").split(","):
            part = raw_part.strip().lower()
            if not part:
                continue

            if part == "br" and not _HAS_BROTLI:
                continue

            # Non chiediamo zstd finche non viene aggiunto un decoder esplicito.
            if part == "zstd":
                continue

            parts.append(part)

        if parts:
            choices.append(", ".join(parts))

    return random.choice(choices or ["gzip, deflate"])


def _new_async_session(
    *,
    profile: _BrowserProfile,
    timeout: float,
    max_clients: int,
    proxy_url: str = "",
) -> AsyncSession:
    headers = _build_headers_for_profile(profile)
    proxies = _proxy_config(proxy_url)

    try:
        kwargs: dict[str, Any] = {
            "impersonate": profile.impersonate,
            "timeout": timeout,
            "max_clients": max_clients,
            "headers": headers,
            "allow_redirects": ALLOW_REDIRECTS,
            "trust_env": TRUST_ENV,
            "default_headers": False,
        }
        if proxies:
            kwargs["proxies"] = proxies
        return AsyncSession(**kwargs)
    except TypeError:
        kwargs = {
            "timeout": timeout,
            "headers": headers,
            "follow_redirects": ALLOW_REDIRECTS,
            "trust_env": TRUST_ENV,
        }
        if proxies:
            kwargs["proxies"] = proxies
        return AsyncSession(**kwargs)
    except Exception as exc:
        message = str(exc).lower()
        if "impersonat" in message and "not supported" in message and profile.impersonate != "chrome120":
            logger.warning("Impersonate %s non supportato da curl_cffi: fallback chrome120", profile.impersonate)
            fallback = _choose_browser_profile("chrome120")
            return _new_async_session(profile=fallback, timeout=timeout, max_clients=max_clients, proxy_url=proxy_url)
        raise


def create_async_client(
    timeout: float = DEFAULT_TIMEOUT,
    *,
    impersonate: str | None = None,
    max_clients: int = SESSION_MAX_CLIENTS,
) -> AsyncSession:
    profile = _choose_browser_profile(impersonate)
    return _new_async_session(profile=profile, timeout=timeout, max_clients=max_clients)


def _decode_body_bytes(raw: bytes, headers: dict[str, Any]) -> bytes:
    if not raw:
        return raw

    encoding = str(headers.get("content-encoding", "") or "").lower().strip()
    content_type = str(headers.get("content-type", "") or "").lower().strip()

    if raw.startswith(b"\x1f\x8b") or "gzip" in encoding or "gzip" in content_type:
        try:
            return gzip.decompress(raw)
        except OSError:
            pass

    if "br" in encoding and _HAS_BROTLI and _brotli_decompress is not None:
        try:
            return _brotli_decompress(raw)
        except Exception:
            pass

    if "deflate" in encoding:
        for wbits in (zlib.MAX_WBITS, -zlib.MAX_WBITS):
            try:
                return zlib.decompress(raw, wbits)
            except zlib.error:
                continue

    return raw


def _parse_payload(response: Response) -> dict[str, Any]:
    try:
        payload = response.json()
        if isinstance(payload, dict):
            return payload
    except (ValueError, UnicodeDecodeError, json.JSONDecodeError):
        pass

    raw = response.content or b""
    if not raw:
        raise TorrentioPayloadEmpty("Risposta vuota")

    decoded = _decode_body_bytes(raw, dict(response.headers))

    try:
        payload = json.loads(decoded.decode("utf-8-sig"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        logger.warning(
            "Body non decodificabile: status=%s content-type=%s content-encoding=%s len=%s preview=%s",
            response.status_code,
            response.headers.get("content-type", ""),
            response.headers.get("content-encoding", ""),
            len(raw),
            _safe_preview(raw),
        )
        raise TorrentioResponseError("JSON non decodificabile") from exc

    if not isinstance(payload, dict):
        raise TorrentioResponseError("Payload non valido")

    return payload


def _sanitize_payload(payload: dict[str, Any]) -> dict[str, Any]:
    streams = payload.get("streams", [])

    if streams is None:
        payload["streams"] = []
        return payload

    if not isinstance(streams, list):
        raise TorrentioResponseError("'streams' non e una lista")

    return payload


def _extract_retry_after(response: Response) -> float | None:
    raw = response.headers.get("Retry-After") or response.headers.get("retry-after")
    if not raw:
        return None

    value = str(raw).strip()

    try:
        return max(0.5, float(value))
    except ValueError:
        pass

    try:
        dt = parsedate_to_datetime(value)
        delay = dt.timestamp() - time.time()
        return max(0.5, delay)
    except Exception:
        return None


def _retry_delay(attempt: int, exc: Exception | None = None) -> float:
    retry_after = getattr(exc, "retry_after", None)
    if isinstance(retry_after, (int, float)) and retry_after > 0:
        return min(float(retry_after), RETRY_MAX_DELAY)

    base = min(RETRY_BASE_DELAY * (2 ** max(0, attempt - 1)), RETRY_MAX_DELAY)
    return base + random.uniform(0.1, 0.5)


def _is_network_exception(exc: Exception) -> bool:
    if isinstance(exc, RequestsError):
        return True

    if _HTTPX_REQUEST_ERRORS and isinstance(exc, _HTTPX_REQUEST_ERRORS):
        return True

    if isinstance(exc, (asyncio.TimeoutError, TimeoutError, ConnectionError, OSError)):
        return True

    return False


def _should_retry_exception(exc: Exception) -> bool:
    if isinstance(exc, TorrentioHTTPError):
        if exc.status_code in BAN_SIGNAL_CODES:
            return False
        return exc.status_code in RETRYABLE_STATUS_CODES

    if isinstance(exc, TorrentioPayloadEmpty):
        return True

    if isinstance(exc, TorrentioResponseError):
        return False

    return _is_network_exception(exc)


def _should_count_breaker_failure(exc: Exception) -> bool:
    if isinstance(exc, TorrentioHTTPError):
        return exc.status_code in BREAKER_FAILURE_STATUS_CODES

    if isinstance(exc, TorrentioPayloadEmpty):
        return True

    if isinstance(exc, TorrentioResponseError):
        return False

    return _is_network_exception(exc)


class _AdaptiveRateLimiter:
    __slots__ = (
        "_base_rate",
        "_current_rate",
        "_burst",
        "_tokens",
        "_last_refill",
        "_min_spacing",
        "_last_request",
        "_backoff_multiplier",
        "_backoff_decay",
        "_last_ban_time",
        "_lock",
    )

    def __init__(
        self,
        rate: float = RL_REQUESTS_PER_SECOND,
        burst: int = RL_BURST,
        min_spacing: float = RL_MIN_SPACING,
        backoff_multiplier: float = RL_BACKOFF_MULTIPLIER,
        backoff_decay: float = RL_BACKOFF_DECAY,
    ):
        self._base_rate = float(rate)
        self._current_rate = float(rate)
        self._burst = int(burst)
        self._tokens = float(burst)
        self._last_refill = time.monotonic()
        self._min_spacing = float(min_spacing)
        self._last_request = 0.0
        self._backoff_multiplier = float(backoff_multiplier)
        self._backoff_decay = float(backoff_decay)
        self._last_ban_time = 0.0
        self._lock = asyncio.Lock()

    def _refill(self) -> None:
        now = time.monotonic()
        elapsed = now - self._last_refill

        if elapsed > 0:
            self._tokens = min(self._burst, self._tokens + elapsed * self._current_rate)
            self._last_refill = now

        if self._last_ban_time > 0 and self._current_rate < self._base_rate:
            since_ban = now - self._last_ban_time
            if since_ban >= self._backoff_decay:
                old = self._current_rate
                self._current_rate = min(self._base_rate, self._current_rate * 1.5)
                self._last_ban_time = now

                if old != self._current_rate:
                    logger.debug("Rate limiter recovery: %.2f -> %.2f req/s", old, self._current_rate)

    async def acquire(self) -> None:
        async with self._lock:
            self._refill()

            now = time.monotonic()
            spacing = self._min_spacing + random.uniform(0.05, 0.25)
            since_last = now - self._last_request

            if since_last < spacing:
                await asyncio.sleep(spacing - since_last)

            while self._tokens < 1.0:
                wait = (1.0 - self._tokens) / max(self._current_rate, 0.01)
                await asyncio.sleep(wait + random.uniform(0.01, 0.1))
                self._refill()

            self._tokens -= 1.0
            self._last_request = time.monotonic()

    def signal_rate_limited(self, retry_after: float | None = None) -> None:
        self._last_ban_time = time.monotonic()
        old = self._current_rate
        self._current_rate = max(0.05, self._current_rate / self._backoff_multiplier)
        self._tokens = min(self._tokens, 0.0)

        if retry_after and retry_after > 0:
            self._tokens = min(self._tokens, -(retry_after * self._current_rate))

        logger.warning("Rate limiter 429 backoff: %.2f -> %.2f req/s retry_after=%s", old, self._current_rate, retry_after or "none")

    def signal_ban(self) -> None:
        self._last_ban_time = time.monotonic()
        old = self._current_rate
        self._current_rate = max(0.03, self._current_rate / (self._backoff_multiplier * 2))
        self._tokens = 0.0
        logger.warning("Rate limiter 403 BAN: %.2f -> %.2f req/s", old, self._current_rate)

    @property
    def current_rate(self) -> float:
        return self._current_rate

    @property
    def effective_state(self) -> str:
        if self._current_rate < self._base_rate * 0.3:
            return "throttled_heavy"

        if self._current_rate < self._base_rate * 0.7:
            return "throttled_light"

        return "normal"


class _SessionManager:
    __slots__ = (
        "_session",
        "_profile",
        "_request_count",
        "_created_at",
        "_max_requests",
        "_max_age",
        "_lock",
        "_proxy_url",
        "_label",
    )

    def __init__(
        self,
        max_requests: int = SESSION_MAX_REQUESTS,
        max_age: float = SESSION_MAX_AGE,
        *,
        proxy_url: str = "",
        label: str = "Torrentio",
    ):
        self._session: AsyncSession | None = None
        self._profile: _BrowserProfile | None = None
        self._request_count = 0
        self._created_at = 0.0
        self._max_requests = max_requests
        self._max_age = max_age
        self._lock = asyncio.Lock()
        self._proxy_url = str(proxy_url or "").strip()
        self._label = str(label or "Torrentio")

    def _needs_rotation(self) -> bool:
        if self._session is None:
            return True

        if self._request_count >= self._max_requests:
            return True

        if (time.monotonic() - self._created_at) >= self._max_age:
            return True

        return False

    def _create_session(self) -> AsyncSession:
        self._profile = _choose_browser_profile()

        logger.debug(
            "Nuova sessione %s: target=%s lang=%s proxy=%s",
            self._label,
            self._profile.impersonate,
            self._profile.accept_language[:24],
            "on" if self._proxy_url else "off",
        )

        return _new_async_session(
            profile=self._profile,
            timeout=DEFAULT_TIMEOUT,
            max_clients=SESSION_MAX_CLIENTS,
            proxy_url=self._proxy_url,
        )

    async def _close_current(self) -> None:
        if self._session is not None:
            try:
                if hasattr(self._session, "aclose"):
                    await self._session.aclose()
                elif hasattr(self._session, "close"):
                    maybe_result = self._session.close()
                    if asyncio.iscoroutine(maybe_result):
                        await maybe_result
            except Exception:
                logger.debug("Errore chiusura sessione Torrentio", exc_info=True)

            self._session = None
            self._profile = None

    async def get_session(self) -> AsyncSession:
        async with self._lock:
            if self._needs_rotation():
                await self._close_current()
                self._session = self._create_session()
                self._request_count = 0
                self._created_at = time.monotonic()

            self._request_count += 1
            return self._session

    async def force_rotate(self) -> None:
        async with self._lock:
            logger.info("Rotazione sessione %s forzata", self._label)
            await self._close_current()
            self._session = self._create_session()
            self._request_count = 0
            self._created_at = time.monotonic()

    async def close(self) -> None:
        async with self._lock:
            await self._close_current()

    @property
    def current_browser_profile(self) -> _BrowserProfile | None:
        return self._profile

    @property
    def current_profile(self) -> dict[str, Any]:
        profile = self._profile
        if profile is None:
            return {"active": False}

        return {
            "active": True,
            "impersonate": profile.impersonate,
            "accept_language": profile.accept_language,
            "sec_ch_ua": profile.sec_ch_ua,
            "sec_ch_ua_platform": profile.sec_ch_ua_platform,
            "platform_hint": profile.platform_hint,
        }


class _TTLCache:
    __slots__ = ("_store", "_max_entries", "_ttl", "_stale_ttl")

    def __init__(
        self,
        max_entries: int = CACHE_MAX_ENTRIES,
        ttl: float = CACHE_TTL,
        stale_ttl: float = CACHE_STALE_SERVE_TTL,
    ):
        self._store: OrderedDict[str, tuple[dict[str, Any], float]] = OrderedDict()
        self._max_entries = int(max_entries)
        self._ttl = float(ttl)
        self._stale_ttl = float(stale_ttl)

    def get(self, key: str, *, allow_stale: bool = False) -> dict[str, Any] | None:
        entry = self._store.get(key)
        if entry is None:
            return None

        payload, ts = entry
        age = time.monotonic() - ts

        if age <= self._ttl:
            self._store.move_to_end(key)
            return payload

        if allow_stale and age <= self._stale_ttl:
            self._store.move_to_end(key)
            return payload

        self._store.pop(key, None)
        return None

    def put(self, key: str, payload: dict[str, Any]) -> None:
        self._store.pop(key, None)
        self._store[key] = (payload, time.monotonic())

        while len(self._store) > self._max_entries:
            self._store.popitem(last=False)

    def invalidate(self, key: str) -> None:
        self._store.pop(key, None)

    def clear(self) -> None:
        self._store.clear()

    def __len__(self) -> int:
        return len(self._store)


class _CircuitBreaker:
    STATE_CLOSED = "closed"
    STATE_OPEN = "open"
    STATE_HALF_OPEN = "half_open"

    __slots__ = (
        "_state",
        "_failure_count",
        "_last_failure_time",
        "_failure_threshold",
        "_recovery_timeout",
        "_half_open_count",
        "_half_open_max",
    )

    def __init__(
        self,
        failure_threshold: int = CB_FAILURE_THRESHOLD,
        recovery_timeout: float = CB_RECOVERY_TIMEOUT,
        half_open_max: int = CB_HALF_OPEN_MAX,
    ):
        self._state = self.STATE_CLOSED
        self._failure_count = 0
        self._last_failure_time = 0.0
        self._failure_threshold = int(failure_threshold)
        self._recovery_timeout = float(recovery_timeout)
        self._half_open_count = 0
        self._half_open_max = int(half_open_max)

    @property
    def state(self) -> str:
        if self._state == self.STATE_OPEN:
            if (time.monotonic() - self._last_failure_time) >= self._recovery_timeout:
                self._state = self.STATE_HALF_OPEN
                self._half_open_count = 0

        return self._state

    def allow_request(self) -> bool:
        state = self.state

        if state == self.STATE_CLOSED:
            return True

        if state == self.STATE_HALF_OPEN:
            if self._half_open_count < self._half_open_max:
                self._half_open_count += 1
                return True

            return False

        return False

    def record_success(self) -> None:
        self._failure_count = 0
        self._state = self.STATE_CLOSED
        self._half_open_count = 0

    def record_failure(self) -> None:
        self._failure_count += 1
        self._last_failure_time = time.monotonic()

        if self._failure_count >= self._failure_threshold:
            previous = self._state
            self._state = self.STATE_OPEN

            if previous != self.STATE_OPEN:
                logger.warning(
                    "Circuit breaker Torrentio APERTO dopo %d fallimenti - cooldown %.0fs",
                    self._failure_count,
                    self._recovery_timeout,
                )


class _EndpointPool:
    __slots__ = ("_endpoints", "_state", "_rr")

    def __init__(self, endpoints: tuple[str, ...]):
        clean: list[str] = []
        for item in endpoints:
            base = _normalize_base_url(item)
            if base and base not in clean:
                clean.append(base)
        self._endpoints = tuple(clean or [DEFAULT_BASE_URL])
        self._state: dict[str, dict[str, Any]] = {
            endpoint: {
                "failures": 0,
                "successes": 0,
                "cooldown_until": 0.0,
                "last_status": 0,
                "last_error": "",
                "last_ms": 0.0,
            }
            for endpoint in self._endpoints
        }
        self._rr = 0

    @property
    def endpoints(self) -> tuple[str, ...]:
        return self._endpoints

    def _rotated(self, items: list[str]) -> list[str]:
        if len(items) <= 1:
            return items
        start = self._rr % len(items)
        self._rr += 1
        return items[start:] + items[:start]

    def candidate_bases(self) -> tuple[str, ...]:
        now = time.monotonic()
        available = [base for base in self._endpoints if self._state[base]["cooldown_until"] <= now]
        if available:
            return tuple(self._rotated(available))

        soonest = min(self._endpoints, key=lambda base: self._state[base]["cooldown_until"])
        return (soonest,)

    def base_for_url(self, url: str) -> str:
        raw = str(url or "")
        for base in sorted(self._endpoints, key=len, reverse=True):
            if raw == base or raw.startswith(f"{base}/"):
                return base
        parsed = urlsplit(raw)
        if parsed.scheme and parsed.netloc:
            return f"{parsed.scheme}://{parsed.netloc}"
        return DEFAULT_BASE_URL

    def urls_for(self, url: str) -> tuple[str, ...]:
        raw = str(url or "").strip()
        base = self.base_for_url(raw)
        suffix = raw[len(base):] if raw.startswith(base) else ""
        if not suffix.startswith("/"):
            suffix = f"/{suffix.lstrip('/')}" if suffix else ""
        ordered = []
        for candidate in self.candidate_bases():
            full = f"{candidate}{suffix}" if suffix else raw
            if full and full not in ordered:
                ordered.append(full)
        if raw and raw not in ordered:
            ordered.append(raw)
        return tuple(ordered or [raw])

    def _cooldown_for_error(self, base: str, exc: Exception) -> float:
        state = self._state.get(base, {})
        failures = int(state.get("failures", 0) or 0)
        retry_after = getattr(exc, "retry_after", None)
        if isinstance(retry_after, (int, float)) and retry_after > 0:
            return min(ENDPOINT_COOLDOWN_MAX, max(2.0, float(retry_after)))

        if isinstance(exc, TorrentioHTTPError):
            if exc.status_code == 403:
                return min(ENDPOINT_COOLDOWN_MAX, 60.0 * max(1, failures))
            if exc.status_code == 429:
                return min(ENDPOINT_COOLDOWN_MAX, 35.0 * max(1, failures))
            if exc.status_code in RETRYABLE_STATUS_CODES:
                return min(ENDPOINT_COOLDOWN_MAX, 8.0 * max(1, failures))
            return min(ENDPOINT_COOLDOWN_MAX, 20.0 * max(1, failures))

        if isinstance(exc, TorrentioPayloadEmpty):
            return min(ENDPOINT_COOLDOWN_MAX, 12.0 * max(1, failures))

        if _is_network_exception(exc):
            return min(ENDPOINT_COOLDOWN_MAX, 10.0 * max(1, failures))

        return min(ENDPOINT_COOLDOWN_MAX, 5.0 * max(1, failures))

    def record_success(self, url: str, *, elapsed_ms: float) -> None:
        base = self.base_for_url(url)
        if base not in self._state:
            return
        state = self._state[base]
        state["failures"] = 0
        state["successes"] = int(state.get("successes", 0) or 0) + 1
        state["cooldown_until"] = 0.0
        state["last_status"] = 200
        state["last_error"] = ""
        state["last_ms"] = round(float(elapsed_ms), 1)

    def record_failure(self, url: str, exc: Exception) -> None:
        base = self.base_for_url(url)
        if base not in self._state:
            return
        state = self._state[base]
        failures = int(state.get("failures", 0) or 0) + 1
        state["failures"] = failures
        status = int(getattr(exc, "status_code", 0) or 0)
        state["last_status"] = status
        state["last_error"] = type(exc).__name__
        cooldown = self._cooldown_for_error(base, exc)
        state["cooldown_until"] = max(float(state.get("cooldown_until", 0.0) or 0.0), time.monotonic() + cooldown)
        logger.info(
            "Torrentio endpoint cooldown: base=%s status=%s failures=%d cooldown=%.1fs reason=%s",
            base,
            status or "network",
            failures,
            cooldown,
            exc,
        )

    def stats(self) -> dict[str, Any]:
        now = time.monotonic()
        items: list[dict[str, Any]] = []
        for base in self._endpoints:
            state = self._state[base]
            cooldown_for = max(0.0, float(state.get("cooldown_until", 0.0) or 0.0) - now)
            items.append(
                {
                    "base_url": base,
                    "available": int(cooldown_for <= 0),
                    "cooldown_seconds": round(cooldown_for, 1),
                    "failures": int(state.get("failures", 0) or 0),
                    "successes": int(state.get("successes", 0) or 0),
                    "last_status": int(state.get("last_status", 0) or 0),
                    "last_error": str(state.get("last_error", "") or ""),
                    "last_ms": float(state.get("last_ms", 0.0) or 0.0),
                }
            )
        return {"count": len(self._endpoints), "items": items}


_endpoint_pool = _EndpointPool(TORRENTIO_BASE_URLS)
_cache = _TTLCache()
_breaker = _CircuitBreaker()
_rate_limiter = _AdaptiveRateLimiter()
_session_mgr = _SessionManager()
_proxy_session_mgrs: tuple[tuple[str, _SessionManager], ...] = (
    tuple(
        (
            proxy_url,
            _SessionManager(proxy_url=proxy_url, label=f"Torrentio proxy {index}"),
        )
        for index, proxy_url in enumerate(PROXY_FALLBACK_URLS, start=1)
    )
    if PROXY_FALLBACK_ACTIVE
    else ()
)
_proxy_fallback_rr = 0

_concurrency_sem: asyncio.Semaphore | None = None
_inflight: dict[str, asyncio.Task[dict[str, Any]]] = {}


def _get_semaphore() -> asyncio.Semaphore:
    global _concurrency_sem

    if _concurrency_sem is None:
        _concurrency_sem = asyncio.Semaphore(MAX_CONCURRENT_REQUESTS)

    return _concurrency_sem


def _consume_task_exception(task: asyncio.Task[Any]) -> None:
    try:
        _ = task.exception()
    except asyncio.CancelledError:
        pass
    except Exception:
        pass


async def _fetch_once(url: str, client: AsyncSession) -> dict[str, Any]:
    await _rate_limiter.acquire()

    profile = _session_mgr.current_browser_profile or _choose_browser_profile()
    headers = _build_headers_for_profile(profile)
    headers["Accept-Encoding"] = _pick_accept_encoding(profile)
    headers["Pragma"] = "no-cache"
    headers["Priority"] = random.choice(("u=1, i", "u=0, i"))

    async with _get_semaphore():
        response = await client.get(url, headers=headers)

    status = int(response.status_code)

    if status == 429:
        retry_after = _extract_retry_after(response)
        _rate_limiter.signal_rate_limited(retry_after)
        raise TorrentioHTTPError(status, url, "Rate limited (429)", retry_after=retry_after)

    if status == 403:
        _rate_limiter.signal_ban()
        raise TorrentioHTTPError(status, url, "Blocked (403)")

    if status >= 400:
        raise TorrentioHTTPError(status, url)

    return _sanitize_payload(_parse_payload(response))


def _should_try_alternate_endpoint(exc: Exception) -> bool:
    if isinstance(exc, TorrentioHTTPError):
        return exc.status_code in (BAN_SIGNAL_CODES | RETRYABLE_STATUS_CODES)
    if isinstance(exc, TorrentioPayloadEmpty):
        return True
    if isinstance(exc, TorrentioResponseError):
        return False
    return _is_network_exception(exc)


_proxy_fallback_cooldown_until = 0.0


def _proxy_fallback_available() -> bool:
    return bool(PROXY_FALLBACK_ACTIVE and time.monotonic() >= _proxy_fallback_cooldown_until)


def _should_try_proxy_fallback(exc: Exception | None) -> bool:
    if exc is None or not PROXY_FALLBACK_ACTIVE:
        return False

    if isinstance(exc, TorrentioHTTPError):
        if exc.status_code == 429 and PROXY_FALLBACK_DISABLE_ON_429:
            return False
        return exc.status_code in PROXY_FALLBACK_ON_STATUS

    if PROXY_FALLBACK_ON_NETWORK_ERROR and _is_network_exception(exc):
        return True

    return False


def _proxy_fallback_failed(exc: Exception) -> None:
    global _proxy_fallback_cooldown_until
    _proxy_fallback_cooldown_until = time.monotonic() + PROXY_FALLBACK_COOLDOWN
    status = int(getattr(exc, "status_code", 0) or 0)
    logger.warning(
        "Torrentio proxy fallback in cooldown: status=%s cooldown=%ss reason=%s",
        status or "network",
        PROXY_FALLBACK_COOLDOWN,
        type(exc).__name__,
    )


def _rotated_proxy_managers() -> tuple[tuple[str, _SessionManager], ...]:
    global _proxy_fallback_rr

    managers = list(_proxy_session_mgrs)
    if len(managers) <= 1:
        return tuple(managers)

    start = _proxy_fallback_rr % len(managers)
    _proxy_fallback_rr += 1
    return tuple(managers[start:] + managers[:start])


async def _fetch_with_proxy_fallback(url: str, cause: Exception) -> dict[str, Any]:
    if not _proxy_session_mgrs or not _proxy_fallback_available():
        raise cause

    last_error: Exception = cause
    candidate_urls = _endpoint_pool.urls_for(url)
    proxy_managers = _rotated_proxy_managers()
    attempt_budget = max(1, PROXY_FALLBACK_MAX_ATTEMPTS)

    logger.info(
        "Torrentio proxy fallback attivo: cause=%s proxies=%d attempts=%d",
        type(cause).__name__,
        len(proxy_managers),
        attempt_budget,
    )

    attempts = 0
    for proxy_url, proxy_session_mgr in proxy_managers:
        for candidate_url in candidate_urls:
            if attempts >= attempt_budget:
                break

            attempts += 1
            session = await proxy_session_mgr.get_session()
            started = time.perf_counter()
            try:
                result = await _fetch_once(candidate_url, session)
                elapsed_ms = (time.perf_counter() - started) * 1000
                _endpoint_pool.record_success(candidate_url, elapsed_ms=elapsed_ms)
                _breaker.record_success()
                logger.info(
                    "Torrentio proxy fallback OK: base=%s proxy=%s ms=%.1f streams=%d",
                    _endpoint_pool.base_for_url(candidate_url),
                    _mask_proxy_url(proxy_url),
                    elapsed_ms,
                    len(result.get("streams", []) or []),
                )
                return result
            except Exception as exc:
                last_error = exc
                try:
                    await proxy_session_mgr.force_rotate()
                except Exception:
                    logger.debug("Rotazione proxy session fallita", exc_info=True)

        if attempts >= attempt_budget:
            break

    _proxy_fallback_failed(last_error)
    raise cause


async def _fetch_with_retry(
    url: str,
    client: AsyncSession | None = None,
) -> dict[str, Any]:
    last_error: Exception | None = None
    owns_session_strategy = client is None
    breaker_failure = False
    total_attempts = max(1, MAX_RETRIES)

    for attempt in range(1, total_attempts + 1):
        candidate_urls = _endpoint_pool.urls_for(url)
        attempted_this_round = 0

        for candidate_url in candidate_urls:
            attempted_this_round += 1
            session = client or await _session_mgr.get_session()
            started = time.perf_counter()

            try:
                result = await _fetch_once(candidate_url, session)
                elapsed_ms = (time.perf_counter() - started) * 1000
                _endpoint_pool.record_success(candidate_url, elapsed_ms=elapsed_ms)
                _breaker.record_success()
                if candidate_url != url:
                    logger.info(
                        "Torrentio mirror OK: primary=%s used=%s ms=%.1f streams=%d",
                        _endpoint_pool.base_for_url(url),
                        _endpoint_pool.base_for_url(candidate_url),
                        elapsed_ms,
                        len(result.get("streams", []) or []),
                    )
                return result

            except Exception as exc:
                last_error = exc

                if _should_count_breaker_failure(exc):
                    breaker_failure = True
                    _endpoint_pool.record_failure(candidate_url, exc)

                if owns_session_strategy:
                    should_rotate = False

                    if isinstance(exc, TorrentioHTTPError) and exc.status_code in BAN_SIGNAL_CODES:
                        should_rotate = SESSION_ROTATE_ON_BAN
                    elif _is_network_exception(exc):
                        should_rotate = True

                    if should_rotate:
                        try:
                            await _session_mgr.force_rotate()
                        except Exception:
                            logger.debug("Rotazione sessione fallita dopo errore Torrentio", exc_info=True)

                if not _should_try_alternate_endpoint(exc):
                    break

                if attempted_this_round < len(candidate_urls):
                    logger.debug(
                        "Torrentio provo endpoint alternativo: attempt=%s/%s failed=%s err=%s",
                        attempt,
                        total_attempts,
                        _endpoint_pool.base_for_url(candidate_url),
                        exc,
                    )

        if attempt >= total_attempts:
            break

        if last_error is None or not (_should_retry_exception(last_error) or _should_try_alternate_endpoint(last_error)):
            break

        delay = _retry_delay(attempt, last_error)
        logger.debug(
            "Torrentio retry round %s/%s delay=%.2fs url=%s endpoints=%d err=%s",
            attempt,
            total_attempts,
            delay,
            url,
            len(candidate_urls),
            last_error,
        )
        await asyncio.sleep(delay)

    if breaker_failure:
        _breaker.record_failure()

    if _should_try_proxy_fallback(last_error):
        try:
            return await _fetch_with_proxy_fallback(url, last_error)
        except TorrentioError:
            pass
        except Exception:
            logger.debug("Torrentio proxy fallback non riuscito", exc_info=True)

    if isinstance(last_error, TorrentioError):
        raise last_error

    if isinstance(last_error, ValueError):
        raise TorrentioResponseError("JSON non decodificabile") from last_error

    if last_error is not None:
        raise TorrentioError(f"Errore rete: {last_error}") from last_error

    raise TorrentioError("Errore sconosciuto")


async def _fetch_and_cache(cache_key: str, url: str) -> dict[str, Any]:
    result = await _fetch_with_retry(url)
    _cache.put(cache_key, result)
    return result


async def _shared_fetch_task(cache_key: str, url: str) -> dict[str, Any]:
    try:
        result = await _fetch_and_cache(cache_key, url)
        logger.debug("Torrentio FETCH OK: %s -> %d stream", cache_key, len(result.get("streams", [])))
        return result
    finally:
        _inflight.pop(cache_key, None)


def _ensure_inflight_fetch(cache_key: str, url: str) -> asyncio.Task[dict[str, Any]]:
    task = _inflight.get(cache_key)

    if task is not None and not task.done():
        return task

    loop = asyncio.get_running_loop()
    task = loop.create_task(
        _shared_fetch_task(cache_key, url),
        name=f"torrentio-fetch-{cache_key}",
    )
    task.add_done_callback(_consume_task_exception)
    _inflight[cache_key] = task
    return task


async def get_torrentio_streams(
    media_type: str,
    media_id: str,
    torrentio_options: str = "",
    *,
    wait: bool = True,
    wait_timeout: float = 3.0,
) -> dict[str, Any]:
    key = _cache_key(media_type, media_id, torrentio_options)
    empty: dict[str, Any] = {"streams": []}

    cached = _cache.get(key, allow_stale=False)
    if cached is not None:
        return cached

    url = build_torrentio_url(media_type, media_id, torrentio_options)
    task: asyncio.Task[dict[str, Any]] | None = None

    if _breaker.allow_request():
        task = _ensure_inflight_fetch(key, url)

    if wait and task is not None:
        try:
            result = await asyncio.wait_for(
                asyncio.shield(task),
                timeout=min(wait_timeout, BG_FETCH_TIMEOUT),
            )
            if result is not None:
                return result
        except asyncio.TimeoutError:
            logger.debug("Torrentio wait timeout: key=%s timeout=%.2fs", key, wait_timeout)
        except TorrentioError:
            stale = _cache.get(key, allow_stale=True)
            if stale is not None:
                return stale
        except Exception:
            logger.debug("Errore get_torrentio_streams wait: key=%s", key, exc_info=True)

    stale = _cache.get(key, allow_stale=True)
    return stale if stale is not None else empty


async def fetch_torrentio_streams(
    type: str,
    id: str,
    torrentio_options: str = "",
    client: AsyncSession | None = None,
) -> dict[str, Any]:
    key = _cache_key(type, id, torrentio_options)

    cached = _cache.get(key, allow_stale=False)
    if cached is not None:
        return cached

    inflight = _inflight.get(key)
    if inflight is not None and not inflight.done():
        try:
            return await asyncio.shield(inflight)
        except TorrentioError:
            stale = _cache.get(key, allow_stale=True)
            if stale is not None:
                return stale
            raise

    if not _breaker.allow_request():
        stale = _cache.get(key, allow_stale=True)
        if stale is not None:
            return stale

        raise TorrentioCircuitOpenError(f"Circuit breaker aperto per {key}")

    url = build_torrentio_url(type, id, torrentio_options)

    if client is None:
        task = _ensure_inflight_fetch(key, url)
        try:
            return await asyncio.shield(task)
        except TorrentioError:
            stale = _cache.get(key, allow_stale=True)
            if stale is not None:
                return stale
            raise

    try:
        result = await _fetch_with_retry(url, client)
        _cache.put(key, result)
        return result
    except TorrentioError:
        stale = _cache.get(key, allow_stale=True)
        if stale is not None:
            return stale
        raise


def prefetch_torrentio_streams(
    media_type: str,
    media_id: str,
    torrentio_options: str = "",
) -> None:
    key = _cache_key(media_type, media_id, torrentio_options)

    if _cache.get(key, allow_stale=False) is not None:
        return

    if key in _inflight:
        return

    if not _breaker.allow_request():
        return

    url = build_torrentio_url(media_type, media_id, torrentio_options)

    try:
        _ensure_inflight_fetch(key, url)
    except RuntimeError:
        logger.debug("Prefetch Torrentio saltato: nessun event loop attivo key=%s", key)


def invalidate_torrentio_cache(
    media_type: str,
    media_id: str,
    torrentio_options: str = "",
) -> None:
    key = _cache_key(media_type, media_id, torrentio_options)
    _cache.invalidate(key)


def clear_torrentio_cache() -> None:
    _cache.clear()


def cache_stats() -> dict[str, Any]:
    return {
        "cache_entries": len(_cache),
        "inflight_tasks": len(_inflight),
        "circuit_state": _breaker.state,
        "rate_limiter_state": _rate_limiter.effective_state,
        "rate_limiter_rps": round(_rate_limiter.current_rate, 2),
        "session_profile": _session_mgr.current_profile,
        "max_clients": SESSION_MAX_CLIENTS,
        "max_concurrent_requests": MAX_CONCURRENT_REQUESTS,
        "max_retries": MAX_RETRIES,
        "cache_ttl_seconds": CACHE_TTL,
        "stale_if_error_ttl_seconds": CACHE_STALE_SERVE_TTL,
        "base_urls": list(TORRENTIO_BASE_URLS),
        "endpoint_pool": _endpoint_pool.stats(),
        "retryable_status_codes": sorted(RETRYABLE_STATUS_CODES),
        "ban_signal_codes": sorted(BAN_SIGNAL_CODES),
        "breaker_failure_status_codes": sorted(BREAKER_FAILURE_STATUS_CODES),
        "impersonate_targets": list(_IMPERSONATE_TARGETS),
        "browser_profile_count": len(_BROWSER_PROFILES),
        "brotli_available": _HAS_BROTLI,
        "proxy_fallback": {
            "enabled": PROXY_FALLBACK_ACTIVE,
            "configured_proxies": len(PROXY_FALLBACK_URLS),
            "on_status": sorted(PROXY_FALLBACK_ON_STATUS),
            "on_network_error": PROXY_FALLBACK_ON_NETWORK_ERROR,
            "disable_on_429": PROXY_FALLBACK_DISABLE_ON_429,
            "cooldown_seconds": PROXY_FALLBACK_COOLDOWN,
            "max_attempts": PROXY_FALLBACK_MAX_ATTEMPTS,
        },
    }


async def shutdown() -> None:
    tasks = list(_inflight.values())

    for task in tasks:
        task.cancel()

    if tasks:
        await asyncio.gather(*tasks, return_exceptions=True)

    _inflight.clear()
    await _session_mgr.close()
    for _, proxy_session_mgr in _proxy_session_mgrs:
        await proxy_session_mgr.close()
    _cache.clear()

    logger.info("Torrentio client shutdown completato")
