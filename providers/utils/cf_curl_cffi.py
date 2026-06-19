from __future__ import annotations

import argparse
import hashlib
import inspect
import json
import os
import random
import re
import shlex
import subprocess
import sys
import time
from http.cookies import SimpleCookie
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Tuple
from urllib.parse import urlparse

UA_BY_IMPERSONATE: Dict[str, str] = {
    "chrome": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/142.0.0.0 Safari/537.36"
    ),
    "chrome142": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/142.0.0.0 Safari/537.36"
    ),
    "edge": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/142.0.0.0 Safari/537.36 Edg/142.0.0.0"
    ),
    "edge142": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/142.0.0.0 Safari/537.36 Edg/142.0.0.0"
    ),
    "firefox": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:144.0) "
        "Gecko/20100101 Firefox/144.0"
    ),
    "firefox144": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:144.0) "
        "Gecko/20100101 Firefox/144.0"
    ),
    "safari": (
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
        "AppleWebKit/605.1.15 (KHTML, like Gecko) "
        "Version/26.0 Safari/605.1.15"
    ),
    "safari260": (
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
        "AppleWebKit/605.1.15 (KHTML, like Gecko) "
        "Version/26.0 Safari/605.1.15"
    ),
    "safari260_ios": (
        "Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) "
        "AppleWebKit/605.1.15 (KHTML, like Gecko) "
        "Version/26.0 Mobile/15E148 Safari/604.1"
    ),
    "safari184": (
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
        "AppleWebKit/605.1.15 (KHTML, like Gecko) "
        "Version/18.4 Safari/605.1.15"
    ),
    "safari18_4": (
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
        "AppleWebKit/605.1.15 (KHTML, like Gecko) "
        "Version/18.4 Safari/605.1.15"
    ),
    "safari180": (
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
        "AppleWebKit/605.1.15 (KHTML, like Gecko) "
        "Version/18.0 Safari/605.1.15"
    ),
    "safari18_2": (
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
        "AppleWebKit/605.1.15 (KHTML, like Gecko) "
        "Version/18.2 Safari/605.1.15"
    ),
}
DEFAULT_FALLBACK_UA = UA_BY_IMPERSONATE["chrome142"]
DEFAULT_IMPERSONATE_CHAIN = [
    "chrome142",
    "edge142",
    "firefox144",
    "safari260",
    "safari260_ios",
    "safari184",
]

IMPERSONATE_TLS_ALIASES: Dict[str, str] = {
    "chrome": "chrome142",
    "edge": "chrome142",
    "edge142": "chrome142",
    "firefox": "firefox144",
    "safari18_2": "safari184",
    "safari18_4": "safari184",
}
RETRY_STATUSES = {403, 408, 425, 429, 500, 502, 503, 504, 520, 521, 522, 523, 524}
HOP_BY_HOP_HEADERS = {
    "connection",
    "content-length",
    "host",
    "proxy-authorization",
    "proxy-connection",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade",
}
COOKIE_META_FIELDS = {"domain", "path", "secure", "expires", "httpOnly", "sameSite", "createdAt"}
CF_COOKIE_NAMES = {"cf_clearance", "__cf_bm", "__cfseq", "cf_chl_rc_i", "cf_chl_rc_ni", "cf_chl_rc_m"}

DEFAULT_CONFIG: Dict[str, str] = {
    "CURL_CFFI_ENABLED": "true",
    "CURL_CFFI_IMPERSONATE": "auto",
    "CURL_CFFI_IMPERSONATE_COMPAT_ALIASES": "true",
    "CURL_CFFI_TIMEOUT_MS": "15000",
    "CURL_CFFI_RETRIES": "1",
    "CURL_CFFI_RETRY_BACKOFF_MS": "250",
    "CURL_CFFI_WARMUP_ORIGIN": "true",
    "CURL_CFFI_WARMUP_JITTER_MIN_MS": "800",
    "CURL_CFFI_WARMUP_JITTER_MAX_MS": "1800",
    "CURL_CFFI_BROWSER_HEADERS": "true",
    "CURL_CFFI_STRICT_HEADER_ORDER": "true",
    "CURL_CFFI_ACCEPT_LANGUAGE": "it-IT,it;q=0.9,en-US;q=0.8,en;q=0.7",
    "CURL_CFFI_ACCEPT_ENCODING": "auto",
    "CURL_CFFI_ASSUME_ZSTD": "false",
    "CURL_CFFI_HTTP_VERSION": "auto",
    "CURL_CFFI_INSECURE": "false",
    "CURL_CFFI_DEBUG": "false",
    "CURL_CFFI_MAX_CONCURRENT": "4",
    "CURL_CFFI_MAX_QUEUE": "40",
    "CURL_CFFI_QUEUE_TIMEOUT_MS": "20000",
    "CURL_CFFI_COOKIE_JAR": "true",
    "CURL_CFFI_COOKIE_JAR_DIR": "/tmp/curl_cffi_cookie_jars",
    "CURL_CFFI_CF_COOKIE_TTL_SECONDS": "1800",
    "CURL_CFFI_REFERER_POOL": "",
    "CURL_CFFI_BEFORE_FLARE": "false",
    "CURL_CFFI_BEFORE_FLARE_CMD": "",
    "CURL_CFFI_BEFORE_FLARE_TIMEOUT_MS": "6500",
    "CURL_CFFI_PROXY": "",
    "CURL_CFFI_PYTHON": "",
    "CURL_CFFI_PROFILE_STATE": "true",
    "CURL_CFFI_PROFILE_STATE_PATH": "/tmp/curl_cffi_profile_state.json",
    "CURL_CFFI_PROFILE_STATE_TTL_SECONDS": "604800",
    "CURL_CFFI_PROFILE_STATE_MAX_HOSTS": "256",
    "CURL_CFFI_ADAPTIVE_HTTP_VERSION": "true",
    "CURL_CFFI_HTTP_VERSION_ON_RETRY": "1.1",
}

CF_CHALLENGE_RE = re.compile(
    r"just a moment|checking your browser|cloudflare ray id|cf-browser-verification|"
    r"enable javascript and cookies|cf-chl-widget|__cf_chl_opt|cf\.challenge\.orchestrate|"
    r"challenge-platform|turnstile\.cloudflare\.com|/cdn-cgi/challenge-platform/|"
    r"<title>\s*(?:just a moment|attention required|verifica)",
    re.I,
)


def cfg(name: str, fallback: str = "") -> str:
    value = os.getenv(name)
    if value is not None and str(value).strip():
        return str(value)
    return DEFAULT_CONFIG.get(name, fallback)


def cfg_bool(name: str, fallback: bool = False) -> bool:
    raw = cfg(name, "true" if fallback else "false").strip().lower()
    return raw in {"1", "true", "yes", "on"}


def cfg_int(name: str, fallback: int, *, minimum: int = 0, maximum: int = 2_147_483_647) -> int:
    try:
        value = int(cfg(name, str(fallback)))
    except (TypeError, ValueError):
        value = fallback
    return max(minimum, min(maximum, value))


def emit(payload: Dict[str, Any], code: int = 0) -> None:
    print(json.dumps(payload, ensure_ascii=False, separators=(",", ":")))
    sys.exit(code)


def now_ts() -> int:
    return int(time.time())


def parse_json_object(value: Optional[str], fallback: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    if not value:
        return dict(fallback or {})
    try:
        parsed = json.loads(value)
    except (TypeError, ValueError, json.JSONDecodeError):
        return dict(fallback or {})
    return parsed if isinstance(parsed, dict) else dict(fallback or {})


def parse_json_list(value: Optional[str]) -> List[Any]:
    if not value:
        return []
    try:
        parsed = json.loads(value)
    except (TypeError, ValueError, json.JSONDecodeError):
        return []
    return parsed if isinstance(parsed, list) else []


def header_key(headers: Dict[str, str], name: str) -> Optional[str]:
    target = name.lower()
    for key in headers or {}:
        if str(key).lower() == target:
            return key
    return None


def header_get(headers: Dict[str, str], name: str) -> str:
    key = header_key(headers, name)
    return str(headers[key]) if key is not None else ""


def put_header(headers: Dict[str, str], name: str, value: str, *, force: bool = False) -> None:
    if not value:
        return
    existing = header_key(headers, name)
    if existing is not None:
        if force:
            headers[existing] = str(value)
        return
    headers[name] = str(value)


def pop_header(headers: Dict[str, str], name: str) -> None:
    key = header_key(headers, name)
    if key is not None:
        headers.pop(key, None)


def origin_from_url(url: str) -> str:
    parsed = urlparse(str(url or ""))
    if not parsed.scheme or not parsed.netloc:
        return ""
    return f"{parsed.scheme}://{parsed.netloc}/"


def host_from_url(url: str) -> str:
    return (urlparse(str(url or "")).hostname or "").lower().strip(".")


def path_from_url(url: str) -> str:
    parsed = urlparse(str(url or ""))
    return parsed.path or "/"


def ua_for_impersonate(impersonate: str) -> str:
    value = str(impersonate or "")
    if value in UA_BY_IMPERSONATE:
        return UA_BY_IMPERSONATE[value]
    for key in sorted(UA_BY_IMPERSONATE, key=len, reverse=True):
        if value.startswith(key):
            return UA_BY_IMPERSONATE[key]
    return DEFAULT_FALLBACK_UA


def tls_impersonate_for(impersonate: str) -> str:
    value = str(impersonate or "").strip()
    if not value:
        return value
    if not cfg_bool("CURL_CFFI_IMPERSONATE_COMPAT_ALIASES", True):
        return value
    return IMPERSONATE_TLS_ALIASES.get(value, value)


def is_chromium_based(impersonate: str, user_agent: str = "") -> bool:
    value = str(impersonate or "").lower()
    ua = str(user_agent or "").lower()
    return value.startswith(("chrome", "edge", "chromium")) or " chrome/" in ua or " edg/" in ua


def is_firefox_based(impersonate: str, user_agent: str = "") -> bool:
    value = str(impersonate or "").lower()
    ua = str(user_agent or "").lower()
    return value.startswith("firefox") or "firefox/" in ua


def is_safari_based(impersonate: str, user_agent: str = "") -> bool:
    value = str(impersonate or "").lower()
    ua = str(user_agent or "").lower()
    return value.startswith("safari") or ("safari/" in ua and "chrome/" not in ua and "chromium/" not in ua)


def chrome_major_from_ua(user_agent: str) -> str:
    match = re.search(r"Chrome/(\d+)", user_agent or "")
    return match.group(1) if match else "142"


def is_edge_user_agent(user_agent: str) -> bool:
    return bool(re.search(r"\bEdg/\d+", user_agent or "", re.I))


def sec_ch_ua_for_chromium(major: str, edge: bool = False) -> str:
    try:
        major_int = int(major)
    except (TypeError, ValueError):
        major_int = 142
    if edge:
        return f'"Microsoft Edge";v="{major}", "Chromium";v="{major}", "Not(A:Brand";v="8"'
    if major_int >= 131:
        return f'"Google Chrome";v="{major}", "Not A(Brand";v="8", "Chromium";v="{major}"'
    return f'"Google Chrome";v="{major}", "Chromium";v="{major}", "Not.A/Brand";v="99"'


def sec_ch_ua_full_version_list_for_chromium(major: str, edge: bool = False) -> str:
    try:
        major_int = int(major)
    except (TypeError, ValueError):
        major_int = 142
    if major_int < 131:
        return ""
    full = f"{major}.0.0.0"
    if edge:
        return f'"Microsoft Edge";v="{full}", "Chromium";v="{full}", "Not(A:Brand";v="8.0.0.0"'
    return f'"Google Chrome";v="{full}", "Not A(Brand";v="8.0.0.0", "Chromium";v="{full}"'


def platform_label_from_ua(user_agent: str) -> str:
    ua = user_agent or ""
    if re.search(r"Macintosh|Mac OS X", ua, re.I):
        return '"macOS"'
    if re.search(r"CrOS", ua, re.I):
        return '"Chrome OS"'
    if re.search(r"Android", ua, re.I):
        return '"Android"'
    if re.search(r"Linux", ua, re.I):
        return '"Linux"'
    return '"Windows"'


def is_mobile_ua(user_agent: str) -> bool:
    return bool(re.search(r"Mobile|Android", user_agent or "", re.I))


def sec_fetch_site_for(url: str, referer: str) -> str:
    if not referer:
        return "none"
    request_origin = origin_from_url(url).rstrip("/")
    referer_origin = origin_from_url(referer).rstrip("/")
    if request_origin and request_origin == referer_origin:
        return "same-origin"
    request_host = host_from_url(url)
    referer_host = host_from_url(referer)
    if request_host and referer_host and (
        request_host == referer_host
        or request_host.endswith(f".{referer_host}")
        or referer_host.endswith(f".{request_host}")
    ):
        return "same-site"
    return "cross-site"


def parse_referer_pool(value: str) -> List[str]:
    raw = str(value or "").strip()
    if not raw:
        return []
    if raw.startswith("["):
        parsed = parse_json_list(raw)
        return [str(item).strip() for item in parsed if str(item).strip().startswith(("http://", "https://"))]
    return [part.strip() for part in raw.split(",") if part.strip().startswith(("http://", "https://"))]


def choose_referer(url: str, explicit_referer: str, referer_pool: str) -> str:
    if explicit_referer:
        return explicit_referer
    pool = parse_referer_pool(referer_pool)
    if not pool:
        return ""
    return random.choice(pool)


def zstd_supported_by_runtime() -> bool:
    if cfg_bool("CURL_CFFI_ASSUME_ZSTD", False):
        return True
    try:
        import curl_cffi  # type: ignore

        blob = " ".join(
            str(getattr(curl_cffi, attr, ""))
            for attr in ("__curl_version__", "curl_version", "__version__")
        ).lower()
        if "zstd" in blob:
            return True
    except Exception:
        pass
    return False


def effective_accept_encoding(value: str) -> str:
    raw = str(value or "auto").strip()
    if raw and raw.lower() not in {"auto", "browser"}:
        parts = [part.strip() for part in raw.split(",") if part.strip()]
    else:
        parts = ["gzip", "deflate", "br"]
        if zstd_supported_by_runtime():
            parts.append("zstd")
    if "zstd" in {part.lower() for part in parts} and not zstd_supported_by_runtime() and raw.lower() in {"auto", "browser"}:
        parts = [part for part in parts if part.lower() != "zstd"]
    return ", ".join(dict.fromkeys(parts))


def normalize_custom_headers(headers: Dict[str, Any]) -> Dict[str, str]:
    normalized: Dict[str, str] = {}
    for key, value in (headers or {}).items():
        if value is None:
            continue
        clean_key = str(key).strip()
        if not clean_key or clean_key.lower() in HOP_BY_HOP_HEADERS:
            continue
        normalized[clean_key] = str(value)
    return normalized


def browser_ordered_headers(
    headers: Dict[str, Any],
    *,
    default_user_agent: str,
    url: str,
    accept_language: str,
    accept_encoding: str,
    referer: str = "",
    browser_headers: bool = True,
    impersonate: str = "",
    strict_order: bool = True,
) -> Dict[str, str]:
    custom = normalize_custom_headers(headers)
    if not browser_headers:
        if not header_get(custom, "user-agent") and default_user_agent:
            custom["User-Agent"] = default_user_agent
        return custom

    ua = header_get(custom, "user-agent") or default_user_agent or DEFAULT_FALLBACK_UA
    parsed = urlparse(str(url or ""))
    generated_referer = origin_from_url(url) if parsed.path not in ("", "/") else ""
    effective_referer = referer or header_get(custom, "referer") or generated_referer
    sec_fetch_site = header_get(custom, "sec-fetch-site") or sec_fetch_site_for(url, effective_referer)

    ordered: Dict[str, str] = {}

    if is_chromium_based(impersonate, ua):
        chrome_major = chrome_major_from_ua(ua)
        edge_ua = is_edge_user_agent(ua) or str(impersonate or "").lower().startswith("edge")
        put_header(ordered, "sec-ch-ua", sec_ch_ua_for_chromium(chrome_major, edge_ua))
        put_header(ordered, "sec-ch-ua-mobile", "?1" if is_mobile_ua(ua) else "?0")
        put_header(ordered, "sec-ch-ua-platform", platform_label_from_ua(ua))
        full_version = sec_ch_ua_full_version_list_for_chromium(chrome_major, edge_ua)
        if full_version:
            put_header(ordered, "sec-ch-ua-full-version-list", full_version)

    put_header(ordered, "Upgrade-Insecure-Requests", "1")
    put_header(ordered, "User-Agent", ua)

    if is_firefox_based(impersonate, ua):
        put_header(ordered, "Accept", "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8")
    elif is_safari_based(impersonate, ua):
        put_header(ordered, "Accept", "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8")
    else:
        put_header(ordered, "Accept", "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7")

    put_header(ordered, "Sec-Fetch-Site", sec_fetch_site)
    put_header(ordered, "Sec-Fetch-Mode", "navigate")
    put_header(ordered, "Sec-Fetch-User", "?1")
    put_header(ordered, "Sec-Fetch-Dest", "document")

    if effective_referer:
        put_header(ordered, "Referer", effective_referer)

    put_header(ordered, "Accept-Encoding", accept_encoding)
    put_header(ordered, "Accept-Language", accept_language)

    if is_chromium_based(impersonate, ua):
        put_header(ordered, "Priority", "u=0, i")

    for key, value in custom.items():
        if key.lower() in HOP_BY_HOP_HEADERS:
            continue
        existing = header_key(ordered, key)
        if existing is not None:
            ordered[existing] = value
        elif not strict_order:
            ordered[key] = value
        else:
            ordered[key] = value

    if not is_chromium_based(impersonate, header_get(ordered, "user-agent")):
        for name in list(ordered.keys()):
            if name.lower().startswith("sec-ch-ua"):
                ordered.pop(name, None)

    return ordered


def cookie_value(item: Dict[str, Any]) -> Any:
    return item["value"] if "value" in item else item.get("val")


def normalize_cookie_domain(domain: str) -> str:
    return str(domain or "").strip().lower().lstrip(".")


def serialize_cookie(cookie: Any) -> Optional[Dict[str, Any]]:
    name = getattr(cookie, "name", None) or getattr(cookie, "key", None)
    value = getattr(cookie, "value", None)
    if not name or value is None:
        return None
    item: Dict[str, Any] = {"name": str(name), "value": str(value), "createdAt": now_ts()}
    for field in ("domain", "path", "secure", "expires"):
        field_value = getattr(cookie, field, None)
        if field_value is not None:
            item[field] = bool(field_value) if field == "secure" else field_value
    rest = getattr(cookie, "_rest", None) or getattr(cookie, "rest", None)
    if isinstance(rest, dict):
        if rest.get("HttpOnly") is not None or rest.get("httponly") is not None:
            item["httpOnly"] = True
        same_site = rest.get("SameSite") or rest.get("samesite")
        if same_site:
            item["sameSite"] = same_site
    return item


def serialize_cookies(cookies: Any) -> List[Dict[str, Any]]:
    if not cookies:
        return []

    candidates: List[Any] = []
    jar = getattr(cookies, "jar", None)
    if jar is not None:
        try:
            candidates.extend(list(jar))
        except Exception:
            pass

    try:
        candidates.extend(list(cookies))
    except Exception:
        pass

    if not candidates and hasattr(cookies, "get_dict"):
        try:
            return [
                {"name": str(name), "value": str(value), "path": "/", "createdAt": now_ts()}
                for name, value in cookies.get_dict().items()
            ]
        except Exception:
            return []

    output: List[Dict[str, Any]] = []
    seen = set()

    for cookie in candidates:
        item: Optional[Dict[str, Any]]
        if isinstance(cookie, str):
            if "=" not in cookie:
                continue
            name, value = cookie.split("=", 1)
            item = {"name": name.strip(), "value": value.strip(), "path": "/", "createdAt": now_ts()}
        elif isinstance(cookie, tuple) and len(cookie) >= 2:
            item = {"name": str(cookie[0]), "value": str(cookie[1]), "path": "/", "createdAt": now_ts()}
        elif isinstance(cookie, dict):
            name = str(cookie.get("name") or cookie.get("key") or "").strip()
            value = cookie_value(cookie)
            if not name or value is None:
                continue
            item = {"name": name, "value": str(value), "createdAt": int(cookie.get("createdAt") or now_ts())}
            for field in COOKIE_META_FIELDS:
                if cookie.get(field) is not None:
                    item[field] = cookie[field]
        else:
            item = serialize_cookie(cookie)

        if not item:
            continue

        item.setdefault("path", "/")
        key = (item.get("name"), item.get("domain"), item.get("path"))
        if key in seen:
            continue
        seen.add(key)
        output.append(item)

    return output


def cookie_header_from_items(items: Iterable[Dict[str, Any]]) -> str:
    merged: Dict[str, str] = {}
    for item in items or []:
        name = str(item.get("name") or "").strip()
        value = item.get("value")
        if name and value is not None:
            merged[name] = str(value)
    return "; ".join(f"{name}={value}" for name, value in merged.items())


def cookie_header_to_items(cookie_header: str, url: str = "") -> List[Dict[str, Any]]:
    raw = str(cookie_header or "").strip()
    if not raw:
        return []

    domain = host_from_url(url)
    items: List[Dict[str, Any]] = []

    try:
        jar = SimpleCookie()
        jar.load(raw)
        for name, morsel in jar.items():
            if not name:
                continue
            item: Dict[str, Any] = {"name": str(name), "value": str(morsel.value), "path": "/", "createdAt": now_ts()}
            if domain:
                item["domain"] = domain
            items.append(item)
    except Exception:
        items = []

    if items:
        return items

    ignored = {"path", "domain", "expires", "max-age", "secure", "httponly", "samesite"}
    for part in raw.split(";"):
        clean = part.strip()
        if not clean or "=" not in clean:
            continue
        name, value = clean.split("=", 1)
        name = name.strip()
        if not name or name.lower() in ignored:
            continue
        item = {"name": name, "value": value.strip(), "path": "/", "createdAt": now_ts()}
        if domain:
            item["domain"] = domain
        items.append(item)

    return items


def parse_cookies_json(value: Optional[str], url: str = "") -> List[Dict[str, Any]]:
    if not value:
        return []

    try:
        parsed = json.loads(value)
    except (TypeError, ValueError, json.JSONDecodeError):
        return []

    default_domain = host_from_url(url)
    output: List[Dict[str, Any]] = []

    def push(item: Any) -> None:
        if not item:
            return
        if isinstance(item, str):
            output.extend(cookie_header_to_items(item, url))
            return
        if not isinstance(item, dict):
            return

        name = str(item.get("name") or item.get("key") or "").strip()
        raw_value = cookie_value(item)
        if not name or raw_value is None:
            return

        cookie: Dict[str, Any] = {
            "name": name,
            "value": str(raw_value),
            "path": str(item.get("path") or "/"),
            "createdAt": int(item.get("createdAt") or now_ts()),
        }
        domain = str(item.get("domain") or item.get("host") or default_domain or "").strip().lstrip(".")
        if domain:
            cookie["domain"] = domain
        for field in ("secure", "httpOnly"):
            if item.get(field) is not None:
                cookie[field] = bool(item.get(field))
        for field in ("expires", "sameSite"):
            if item.get(field) is not None:
                cookie[field] = item.get(field)
        output.append(cookie)

    if isinstance(parsed, list):
        for entry in parsed:
            push(entry)
    elif isinstance(parsed, dict):
        if "cookies" in parsed and isinstance(parsed["cookies"], list):
            for entry in parsed["cookies"]:
                push(entry)
        else:
            for name, raw_value in parsed.items():
                push({"name": name, **raw_value} if isinstance(raw_value, dict) else {"name": name, "value": raw_value})

    return dedupe_cookie_items(output)


def dedupe_cookie_items(items: Iterable[Dict[str, Any]]) -> List[Dict[str, Any]]:
    deduped: List[Dict[str, Any]] = []
    seen = set()
    for item in items or []:
        name = str(item.get("name") or "").strip()
        if not name:
            continue
        normalized = dict(item)
        normalized.setdefault("path", "/")
        if normalized.get("domain"):
            normalized["domain"] = normalize_cookie_domain(str(normalized.get("domain")))
        normalized.setdefault("createdAt", now_ts())
        key = (name, str(normalized.get("domain") or ""), str(normalized.get("path") or "/"))
        if key in seen:
            continue
        seen.add(key)
        deduped.append(normalized)
    return deduped


def merge_cookie_items(*groups: Iterable[Dict[str, Any]]) -> List[Dict[str, Any]]:
    merged: Dict[Tuple[str, str, str], Dict[str, Any]] = {}
    for group in groups:
        for item in group or []:
            name = str(item.get("name") or "").strip()
            if not name:
                continue
            normalized = dict(item)
            normalized.setdefault("path", "/")
            normalized.setdefault("createdAt", now_ts())
            if normalized.get("domain"):
                normalized["domain"] = normalize_cookie_domain(str(normalized.get("domain")))
            key = (name, str(normalized.get("domain") or ""), str(normalized.get("path") or "/"))
            merged[key] = normalized
    return list(merged.values())


def cookie_is_expired(item: Dict[str, Any], *, cf_ttl_seconds: int) -> bool:
    current = now_ts()
    name = str(item.get("name") or "").lower()
    expires = item.get("expires")
    try:
        if expires is not None and float(expires) > 0 and float(expires) <= current:
            return True
    except (TypeError, ValueError):
        pass
    if name in CF_COOKIE_NAMES or name.startswith("cf_") or name.startswith("__cf"):
        try:
            created = int(float(item.get("createdAt") or current))
        except (TypeError, ValueError):
            created = current
        if cf_ttl_seconds > 0 and current - created > cf_ttl_seconds:
            return True
    return False


def cookie_matches_url(item: Dict[str, Any], url: str, *, cf_ttl_seconds: int) -> bool:
    if cookie_is_expired(item, cf_ttl_seconds=cf_ttl_seconds):
        return False
    parsed = urlparse(str(url or ""))
    host = (parsed.hostname or "").lower().strip(".")
    if not host:
        return False
    domain = normalize_cookie_domain(str(item.get("domain") or host))
    if domain and host != domain and not host.endswith(f".{domain}"):
        return False
    path = str(item.get("path") or "/")
    request_path = parsed.path or "/"
    if path != "/" and not request_path.startswith(path.rstrip("/") + "/") and request_path != path:
        return False
    if bool(item.get("secure")) and parsed.scheme != "https":
        return False
    return True


def cookies_for_url(items: Iterable[Dict[str, Any]], url: str, *, cf_ttl_seconds: int) -> List[Dict[str, Any]]:
    return [dict(item) for item in items or [] if cookie_matches_url(item, url, cf_ttl_seconds=cf_ttl_seconds)]


def seed_session_cookies(session: Any, cookie_header: str, url: str, cookie_items: Optional[List[Dict[str, Any]]] = None, *, cf_ttl_seconds: int = 1800) -> List[Dict[str, Any]]:
    items = merge_cookie_items(cookie_header_to_items(cookie_header, url), cookie_items or [])
    items = cookies_for_url(items, url, cf_ttl_seconds=cf_ttl_seconds)
    if not items:
        return []

    for item in items:
        try:
            kwargs: Dict[str, Any] = {"path": item.get("path") or "/"}
            if item.get("domain"):
                kwargs["domain"] = item.get("domain")
            session.cookies.set(str(item["name"]), str(item["value"]), **kwargs)
        except Exception:
            try:
                session.cookies.set(str(item["name"]), str(item["value"]))
            except Exception:
                pass

    return items


def proxy_fingerprint(proxy: str) -> str:
    clean = str(proxy or "").strip()
    if not clean:
        return "direct"
    parsed = urlparse(clean)
    safe = f"{parsed.scheme}://{parsed.hostname or ''}:{parsed.port or ''}"
    return hashlib.sha256(safe.encode("utf-8", "ignore")).hexdigest()[:16]


def cookie_jar_path(base_dir: str, url: str, impersonate: str, proxy: str) -> Path:
    host = host_from_url(url) or "unknown-host"
    key = f"{host}|{impersonate}|{proxy_fingerprint(proxy)}"
    digest = hashlib.sha256(key.encode("utf-8", "ignore")).hexdigest()[:24]
    safe_host = re.sub(r"[^a-zA-Z0-9_.-]+", "_", host)[:120]
    return Path(base_dir).expanduser().resolve() / f"{safe_host}_{digest}.json"


def load_cookie_jar(base_dir: str, url: str, impersonate: str, proxy: str, *, cf_ttl_seconds: int) -> List[Dict[str, Any]]:
    path = cookie_jar_path(base_dir, url, impersonate, proxy)
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return []
    items = data.get("cookies") if isinstance(data, dict) else data
    if not isinstance(items, list):
        return []
    return cookies_for_url(dedupe_cookie_items([item for item in items if isinstance(item, dict)]), url, cf_ttl_seconds=cf_ttl_seconds)


def save_cookie_jar(base_dir: str, url: str, impersonate: str, proxy: str, items: Iterable[Dict[str, Any]], *, cf_ttl_seconds: int) -> None:
    usable = cookies_for_url(dedupe_cookie_items(items), url, cf_ttl_seconds=cf_ttl_seconds)
    if not usable:
        return
    path = cookie_jar_path(base_dir, url, impersonate, proxy)
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(
            json.dumps(
                {
                    "host": host_from_url(url),
                    "impersonate": impersonate,
                    "proxyKey": proxy_fingerprint(proxy),
                    "updatedAt": now_ts(),
                    "cookies": usable,
                },
                ensure_ascii=False,
                separators=(",", ":"),
            ),
            encoding="utf-8",
        )
    except Exception:
        pass




def profile_state_file_path(raw_path: str) -> Path:
    clean = str(raw_path or "").strip() or "/tmp/curl_cffi_profile_state.json"
    return Path(clean).expanduser().resolve()


def load_profile_state(path: Path, *, ttl_seconds: int) -> Dict[str, Any]:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return {"version": 1, "hosts": {}}
    if not isinstance(data, dict):
        return {"version": 1, "hosts": {}}
    hosts = data.get("hosts")
    if not isinstance(hosts, dict):
        data["hosts"] = {}
        return data
    current = now_ts()
    ttl = max(60, int(ttl_seconds or 604800))
    for host in list(hosts.keys()):
        entry = hosts.get(host)
        if not isinstance(entry, dict):
            hosts.pop(host, None)
            continue
        profiles = entry.get("profiles")
        if not isinstance(profiles, dict):
            entry["profiles"] = {}
            continue
        for key in list(profiles.keys()):
            profile = profiles.get(key)
            if not isinstance(profile, dict):
                profiles.pop(key, None)
                continue
            last_seen = int(profile.get("lastSeen") or 0)
            if last_seen and current - last_seen > ttl:
                profiles.pop(key, None)
        if not profiles and int(entry.get("updatedAt") or 0) and current - int(entry.get("updatedAt") or 0) > ttl:
            hosts.pop(host, None)
    return data


def save_profile_state(path: Path, state: Dict[str, Any], *, max_hosts: int) -> None:
    try:
        hosts = state.setdefault("hosts", {})
        if isinstance(hosts, dict) and len(hosts) > max(1, int(max_hosts or 256)):
            ordered = sorted(
                hosts.items(),
                key=lambda item: int((item[1] or {}).get("updatedAt") or 0),
                reverse=True,
            )[: max(1, int(max_hosts or 256))]
            state["hosts"] = dict(ordered)
        state["version"] = 1
        state["updatedAt"] = now_ts()
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_suffix(path.suffix + ".tmp")
        tmp.write_text(json.dumps(state, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
        tmp.replace(path)
    except Exception:
        pass


def host_state_for(state: Dict[str, Any], url: str) -> Dict[str, Any]:
    host = host_from_url(url) or "unknown-host"
    hosts = state.setdefault("hosts", {})
    if not isinstance(hosts, dict):
        state["hosts"] = hosts = {}
    entry = hosts.setdefault(host, {"profiles": {}, "updatedAt": now_ts()})
    if not isinstance(entry, dict):
        entry = {"profiles": {}, "updatedAt": now_ts()}
        hosts[host] = entry
    profiles = entry.setdefault("profiles", {})
    if not isinstance(profiles, dict):
        entry["profiles"] = {}
    return entry


def profile_state_key(impersonate: str, proxy: str) -> str:
    return f"{impersonate or 'default'}|{proxy_fingerprint(proxy)}"


def profile_entry_for(state: Dict[str, Any], url: str, impersonate: str, proxy: str) -> Dict[str, Any]:
    host_state = host_state_for(state, url)
    profiles = host_state.setdefault("profiles", {})
    key = profile_state_key(impersonate, proxy)
    entry = profiles.setdefault(key, {"profile": impersonate, "proxyKey": proxy_fingerprint(proxy), "success": 0, "fail": 0, "challenge": 0, "avgMs": 0, "score": 0.5, "lastSeen": 0})
    if not isinstance(entry, dict):
        entry = {"profile": impersonate, "proxyKey": proxy_fingerprint(proxy), "success": 0, "fail": 0, "challenge": 0, "avgMs": 0, "score": 0.5, "lastSeen": 0}
        profiles[key] = entry
    return entry


def score_profile_entry(entry: Dict[str, Any]) -> float:
    success = max(0.0, float(entry.get("success") or 0))
    fail = max(0.0, float(entry.get("fail") or 0))
    challenge = max(0.0, float(entry.get("challenge") or 0))
    avg_ms = max(0.0, float(entry.get("avgMs") or 0))
    total = success + fail + challenge
    if total <= 0:
        return 0.5
    success_ratio = (success + 0.35) / (total + 0.7)
    challenge_penalty = min(0.45, challenge * 0.08)
    latency_penalty = min(0.18, avg_ms / 30000.0)
    status_penalty = 0.08 if int(entry.get("lastStatus") or 0) in RETRY_STATUSES else 0.0
    return max(0.01, min(0.99, success_ratio - challenge_penalty - latency_penalty - status_penalty))


def reorder_impersonate_chain(chain: List[str], state: Dict[str, Any], url: str, proxy: str) -> List[str]:
    if not chain:
        return chain
    host_state = host_state_for(state, url)
    profiles = host_state.get("profiles") or {}
    proxy_key = proxy_fingerprint(proxy)

    def best_score(profile: str) -> float:
        scored = []
        direct_key = profile_state_key(profile, proxy)
        if isinstance(profiles.get(direct_key), dict):
            scored.append(float(profiles[direct_key].get("score") or score_profile_entry(profiles[direct_key])))
        for _key, value in profiles.items():
            if not isinstance(value, dict):
                continue
            if value.get("profile") == profile:
                weight = 1.0 if value.get("proxyKey") == proxy_key else 0.75
                scored.append(float(value.get("score") or score_profile_entry(value)) * weight)
        return max(scored) if scored else 0.5

    indexed = list(enumerate(dict.fromkeys(chain)))
    indexed.sort(key=lambda item: (best_score(item[1]), -item[0]), reverse=True)
    return [profile for _, profile in indexed]


def record_profile_result(
    state: Dict[str, Any],
    url: str,
    impersonate: str,
    proxy: str,
    *,
    status: int = 0,
    challenge: bool = False,
    elapsed_ms: int = 0,
    error: str = "",
) -> Dict[str, Any]:
    entry = profile_entry_for(state, url, impersonate, proxy)
    previous_avg = float(entry.get("avgMs") or 0)
    elapsed = max(0, int(elapsed_ms or 0))
    if elapsed:
        entry["avgMs"] = int(elapsed if previous_avg <= 0 else (previous_avg * 0.72 + elapsed * 0.28))

    code = int(status or 0)
    ok = bool(code and 200 <= code < 400 and not challenge and not error)
    if ok:
        entry["success"] = int(entry.get("success") or 0) + 1
    elif challenge:
        entry["challenge"] = int(entry.get("challenge") or 0) + 1
        entry["fail"] = int(entry.get("fail") or 0) + 1
    else:
        entry["fail"] = int(entry.get("fail") or 0) + 1

    entry["lastStatus"] = code
    entry["lastError"] = str(error or "")[:160]
    entry["lastSeen"] = now_ts()
    entry["score"] = round(score_profile_entry(entry), 4)
    host_state_for(state, url)["updatedAt"] = now_ts()
    return entry


def adaptive_http_version_mode(requested: str, profile_entry: Dict[str, Any], retry_index: int, input_signals: Dict[str, Any]) -> str:
    raw = str(requested or "auto").strip().lower() or "auto"
    if raw not in {"", "auto"}:
        return raw
    if not cfg_bool("CURL_CFFI_ADAPTIVE_HTTP_VERSION", True):
        return raw
    preferred = str(input_signals.get("preferHttpVersion") or input_signals.get("httpVersion") or "").strip().lower()
    if preferred in {"1.1", "http1.1", "2", "h2", "http2", "3", "h3", "http3"}:
        return preferred
    if retry_index > 0 and int(profile_entry.get("fail") or 0) >= 1:
        return cfg("CURL_CFFI_HTTP_VERSION_ON_RETRY", "1.1") or "1.1"
    return raw

def is_usable_proxy_url(value: str) -> bool:
    clean = str(value or "").strip()
    if not clean:
        return False
    try:
        parsed = urlparse(clean)
    except Exception:
        return False
    if parsed.scheme.lower() not in {"http", "https", "socks4", "socks4a", "socks5", "socks5h"}:
        return False
    if parsed.query or (parsed.path and parsed.path != "/"):
        return False
    return bool(parsed.hostname)


def build_proxies(proxy: Optional[str]) -> Optional[Dict[str, str]]:
    if not proxy:
        return None
    clean = proxy.strip()
    return {"http": clean, "https": clean} if is_usable_proxy_url(clean) else None


def parse_impersonate_chain(value: str) -> List[str]:
    raw = str(value or "auto").strip()
    if not raw or raw.lower() == "auto":
        return list(DEFAULT_IMPERSONATE_CHAIN)

    parts = [part.strip() for part in raw.split(",") if part.strip()]
    if not parts:
        parts = list(DEFAULT_IMPERSONATE_CHAIN)

    for fallback in DEFAULT_IMPERSONATE_CHAIN:
        if fallback not in parts:
            parts.append(fallback)

    return parts


def has_cf_response_headers(response_headers: Dict[str, str]) -> bool:
    for key, value in (response_headers or {}).items():
        header = str(key).lower()
        text = str(value).lower()
        if header in {"cf-ray", "cf-cache-status", "cf-request-id"}:
            return True
        if header == "server" and "cloudflare" in text:
            return True
    return False


def is_cloudflare_mitigated(response_headers: Dict[str, str]) -> bool:
    value = header_get({str(k): str(v) for k, v in (response_headers or {}).items()}, "cf-mitigated")
    return value.lower().strip() == "challenge"


def is_challenge_url(url: str) -> bool:
    parsed = urlparse(str(url or ""))
    path = parsed.path or ""
    return "/cdn-cgi/challenge-platform/" in path or "/cdn-cgi/challenge" in path


def is_challenge_page(text: str, status: int, response_headers: Optional[Dict[str, str]] = None, final_url: str = "") -> bool:
    body = str(text or "")
    code = int(status or 0)
    headers = response_headers or {}

    if is_cloudflare_mitigated(headers):
        return True
    if final_url and is_challenge_url(final_url):
        return True
    if CF_CHALLENGE_RE.search(body[:60000]):
        return True
    if len(body) < 8192 and re.search(r"checking your browser|just a moment|attention required", body, re.I):
        return True
    if code in {403, 429, 503}:
        return True if response_headers is None else has_cf_response_headers(headers)

    return False


def callable_accepts_kw(func: Any, name: str) -> bool:
    try:
        signature = inspect.signature(func)
    except Exception:
        return False
    for parameter in signature.parameters.values():
        if parameter.kind == inspect.Parameter.VAR_KEYWORD:
            return True
    return name in signature.parameters


def curl_http_version_value(mode: str, impersonate: str) -> Any:
    raw = str(mode or "auto").strip().lower()
    if raw in {"", "auto"}:
        if not is_chromium_based(impersonate):
            return None
        try:
            major = int(re.search(r"(\d+)", impersonate).group(1))  # type: ignore[union-attr]
        except Exception:
            major = 120
        if major < 120:
            return None
        raw = "2"

    try:
        from curl_cffi.const import CurlHttpVersion  # type: ignore

        if raw in {"2", "h2", "http2", "v2"}:
            return getattr(CurlHttpVersion, "V2_0", None) or getattr(CurlHttpVersion, "CURL_HTTP_VERSION_2_0", None)
        if raw in {"1.1", "http1.1", "v1_1"}:
            return getattr(CurlHttpVersion, "V1_1", None) or getattr(CurlHttpVersion, "CURL_HTTP_VERSION_1_1", None)
        if raw in {"3", "h3", "http3", "v3"}:
            return getattr(CurlHttpVersion, "V3", None) or getattr(CurlHttpVersion, "CURL_HTTP_VERSION_3", None)
    except Exception:
        return None
    return None


def sleep_ms(milliseconds: int) -> None:
    if milliseconds > 0:
        time.sleep(milliseconds / 1000.0)


def sleep_jitter(min_ms: int, max_ms: int) -> None:
    low = max(0, min(min_ms, max_ms))
    high = max(0, max(min_ms, max_ms))
    if high <= 0:
        return
    sleep_ms(random.randint(low, high))


def sleep_before_retry(backoff_ms: int, retry_index: int) -> None:
    sleep_for = (backoff_ms / 1000.0) * (retry_index + 1) + random.uniform(0, min(0.25, backoff_ms / 1000.0))
    if sleep_for > 0:
        time.sleep(sleep_for)


def run_before_flare_hook(command: str, context: Dict[str, Any], timeout_ms: int) -> Dict[str, Any]:
    clean = str(command or "").strip()
    if not clean:
        return {}
    try:
        args = shlex.split(clean)
        completed = subprocess.run(
            args,
            input=json.dumps(context, ensure_ascii=False),
            capture_output=True,
            text=True,
            timeout=max(1.0, timeout_ms / 1000.0),
            check=False,
        )
    except Exception as exc:
        return {"status": "error", "message": str(exc)[:240]}

    stdout = (completed.stdout or "").strip()
    if not stdout:
        return {"status": "empty", "returnCode": completed.returncode, "stderr": (completed.stderr or "")[:240]}
    try:
        parsed = json.loads(stdout)
    except json.JSONDecodeError:
        return {"status": "invalid_json", "returnCode": completed.returncode, "stdout": stdout[:240], "stderr": (completed.stderr or "")[:240]}
    return parsed if isinstance(parsed, dict) else {"status": "invalid_payload", "returnCode": completed.returncode}


def apply_hook_result(headers: Dict[str, str], hook_result: Dict[str, Any], url: str) -> Tuple[Dict[str, str], List[Dict[str, Any]]]:
    updated_headers = dict(headers)
    hook_headers = hook_result.get("headers")
    if isinstance(hook_headers, dict):
        for key, value in hook_headers.items():
            if value is not None and str(key).lower() not in HOP_BY_HOP_HEADERS:
                put_header(updated_headers, str(key), str(value), force=True)

    if hook_result.get("userAgent"):
        put_header(updated_headers, "User-Agent", str(hook_result.get("userAgent")), force=True)

    cookies: List[Dict[str, Any]] = []
    if hook_result.get("cookieHeader"):
        cookies.extend(cookie_header_to_items(str(hook_result.get("cookieHeader")), url))
    if hook_result.get("cookies"):
        cookies.extend(parse_cookies_json(json.dumps(hook_result.get("cookies"), ensure_ascii=False), url))

    return updated_headers, dedupe_cookie_items(cookies)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="curl_cffi browser-impersonated fetcher")
    parser.add_argument("url")
    parser.add_argument("--method", default="GET")
    parser.add_argument("--data")
    parser.add_argument("--headers")
    parser.add_argument("--cookies-json", default="", help="Optional structured cookies from a shared authorized session")
    parser.add_argument("--timeout", type=int, default=cfg_int("CURL_CFFI_TIMEOUT_MS", 15000, minimum=1000), help="Timeout per request in milliseconds")
    parser.add_argument("--impersonate", default=cfg("CURL_CFFI_IMPERSONATE", "auto"), help="auto or comma-separated logical/browser curl_cffi impersonation labels")
    parser.add_argument("--proxy", default=cfg("CURL_CFFI_PROXY", ""))
    parser.add_argument("--signals-json", default="", help="Optional decision hints supplied by the Node.js provider layer")
    parser.add_argument("--profile-state", dest="profile_state", action="store_true", default=cfg_bool("CURL_CFFI_PROFILE_STATE", True), help="Reorder impersonation profiles per host using recent reliability feedback")
    parser.add_argument("--no-profile-state", dest="profile_state", action="store_false")
    parser.add_argument("--profile-state-path", default=cfg("CURL_CFFI_PROFILE_STATE_PATH", "/tmp/curl_cffi_profile_state.json"))
    parser.add_argument("--profile-state-ttl", type=int, default=cfg_int("CURL_CFFI_PROFILE_STATE_TTL_SECONDS", 604800, minimum=60, maximum=31536000))
    parser.add_argument("--retries", type=int, default=cfg_int("CURL_CFFI_RETRIES", 1, minimum=0, maximum=5))
    parser.add_argument("--retry-backoff", type=int, default=cfg_int("CURL_CFFI_RETRY_BACKOFF_MS", 250, minimum=0, maximum=5000), help="Base backoff in milliseconds")
    parser.add_argument("--accept-language", default=cfg("CURL_CFFI_ACCEPT_LANGUAGE", "it-IT,it;q=0.9,en-US;q=0.8,en;q=0.7"))
    parser.add_argument("--accept-encoding", default=cfg("CURL_CFFI_ACCEPT_ENCODING", "auto"))
    parser.add_argument("--referer", default="")
    parser.add_argument("--referer-pool", default=cfg("CURL_CFFI_REFERER_POOL", ""))
    parser.add_argument("--http-version", default=cfg("CURL_CFFI_HTTP_VERSION", "auto"))
    parser.add_argument("--warmup-origin", dest="warmup_origin", action="store_true", default=cfg_bool("CURL_CFFI_WARMUP_ORIGIN", True), help="Hit the origin before a deep-link request using the same session")
    parser.add_argument("--no-warmup-origin", dest="warmup_origin", action="store_false")
    parser.add_argument("--warmup-jitter-min", type=int, default=cfg_int("CURL_CFFI_WARMUP_JITTER_MIN_MS", 800, minimum=0, maximum=30000))
    parser.add_argument("--warmup-jitter-max", type=int, default=cfg_int("CURL_CFFI_WARMUP_JITTER_MAX_MS", 1800, minimum=0, maximum=30000))
    parser.add_argument("--browser-headers", dest="browser_headers", action="store_true", default=cfg_bool("CURL_CFFI_BROWSER_HEADERS", True), help="Add browser navigation headers when missing")
    parser.add_argument("--no-browser-headers", dest="browser_headers", action="store_false")
    parser.add_argument("--strict-header-order", dest="strict_header_order", action="store_true", default=cfg_bool("CURL_CFFI_STRICT_HEADER_ORDER", True))
    parser.add_argument("--loose-header-order", dest="strict_header_order", action="store_false")
    parser.add_argument("--cookie-jar", dest="cookie_jar", action="store_true", default=cfg_bool("CURL_CFFI_COOKIE_JAR", True))
    parser.add_argument("--no-cookie-jar", dest="cookie_jar", action="store_false")
    parser.add_argument("--cookie-jar-dir", default=cfg("CURL_CFFI_COOKIE_JAR_DIR", "/tmp/curl_cffi_cookie_jars"))
    parser.add_argument("--cf-cookie-ttl", type=int, default=cfg_int("CURL_CFFI_CF_COOKIE_TTL_SECONDS", 1800, minimum=60, maximum=86400), help="Prudential TTL for Cloudflare-like cookies in seconds")
    parser.add_argument("--before-flare", dest="before_flare", action="store_true", default=cfg_bool("CURL_CFFI_BEFORE_FLARE", False), help="Call an external authorized session hook when configured")
    parser.add_argument("--no-before-flare", dest="before_flare", action="store_false")
    parser.add_argument("--before-flare-cmd", default=cfg("CURL_CFFI_BEFORE_FLARE_CMD", ""))
    parser.add_argument("--before-flare-timeout", type=int, default=cfg_int("CURL_CFFI_BEFORE_FLARE_TIMEOUT_MS", 6500, minimum=1000, maximum=60000))
    parser.add_argument("--insecure", dest="insecure", action="store_true", default=cfg_bool("CURL_CFFI_INSECURE", False), help="Disable TLS certificate verification")
    parser.add_argument("--secure", dest="insecure", action="store_false")
    return parser


def response_payload_from(
    *,
    response: Any,
    session: Any,
    seeded_cookies: List[Dict[str, Any]],
    headers: Dict[str, str],
    matched_ua: str,
    impersonate: str,
    tls_impersonate: str,
    impersonate_chain: List[str],
    attempts: List[Dict[str, Any]],
    started: float,
    args: argparse.Namespace,
    input_signals: Optional[Dict[str, Any]] = None,
    profile_state_entry: Optional[Dict[str, Any]] = None,
    http_version_mode: str = "auto",
) -> Dict[str, Any]:
    html = getattr(response, "text", "") or ""
    response_headers = dict(getattr(response, "headers", None) or {})
    response_cookies = serialize_cookies(getattr(response, "cookies", None))
    session_cookies = serialize_cookies(getattr(session, "cookies", None))
    cookies = merge_cookie_items(seeded_cookies, session_cookies, response_cookies)
    status = int(getattr(response, "status_code", 0) or 0)
    final_url = str(getattr(response, "url", args.url) or args.url)
    challenge = is_challenge_page(html, status, response_headers, final_url)
    user_agent = header_get(headers, "user-agent") or matched_ua

    return {
        "status": "ok",
        "code": status,
        "url": final_url,
        "html": html,
        "headers": response_headers,
        "cookies": cookies,
        "cookieHeader": cookie_header_from_items(cookies),
        "seededCookieHeader": cookie_header_from_items(seeded_cookies),
        "userAgent": user_agent,
        "requestHeaders": headers,
        "impersonate": impersonate,
        "tlsImpersonate": tls_impersonate,
        "impersonateChain": impersonate_chain,
        "profileScore": (profile_state_entry or {}).get("score"),
        "profileStats": {key: (profile_state_entry or {}).get(key) for key in ("success", "fail", "challenge", "avgMs", "lastStatus") if (profile_state_entry or {}).get(key) is not None},
        "httpVersionMode": http_version_mode,
        "inputSignals": input_signals or {},
        "challengeDetected": challenge,
        "challengeReason": challenge_reason(html, status, response_headers, final_url),
        "shouldRotateProxy": bool(challenge or status in {429, 503}),
        "cookieJarKey": proxy_fingerprint(args.proxy),
        "attempts": attempts,
        "elapsedMs": int((time.time() - started) * 1000),
    }


def challenge_reason(text: str, status: int, headers: Dict[str, str], final_url: str) -> str:
    if is_cloudflare_mitigated(headers):
        return "cf-mitigated"
    if final_url and is_challenge_url(final_url):
        return "challenge-url"
    if CF_CHALLENGE_RE.search((text or "")[:60000]):
        return "challenge-body"
    if int(status or 0) in {403, 429, 503} and has_cf_response_headers(headers):
        return "cf-status"
    return ""


def main() -> None:
    parser = build_parser()
    args = parser.parse_args()
    started = time.time()
    attempts: List[Dict[str, Any]] = []

    try:
        from curl_cffi import requests  # type: ignore
    except Exception as exc:
        emit({"status": "error", "message": f"curl_cffi_not_available: {exc}"}, 1)

    method = str(args.method or "GET").upper()
    timeout_seconds = max(1.0, float(args.timeout or 15000) / 1000.0)
    retry_budget = max(0, min(5, int(args.retries or 0)))
    backoff_ms = max(0, min(5000, int(args.retry_backoff or 0)))
    proxies = build_proxies(args.proxy)
    impersonate_chain = parse_impersonate_chain(args.impersonate)
    raw_headers = parse_json_object(args.headers)
    structured_cookie_items = parse_cookies_json(args.cookies_json, args.url)
    accept_encoding = effective_accept_encoding(args.accept_encoding)
    explicit_referer = choose_referer(args.url, args.referer, args.referer_pool)
    input_signals = parse_json_object(args.signals_json)
    profile_state_path = profile_state_file_path(args.profile_state_path)
    profile_state = load_profile_state(profile_state_path, ttl_seconds=args.profile_state_ttl) if args.profile_state else {"version": 1, "hosts": {}}
    if args.profile_state:
        impersonate_chain = reorder_impersonate_chain(impersonate_chain, profile_state, args.url, args.proxy)
    last_error = ""
    last_payload: Optional[Dict[str, Any]] = None

    request_supports_http_version = callable_accepts_kw(requests.Session.request, "http_version")
    request_supports_accept_encoding = callable_accepts_kw(requests.Session.request, "accept_encoding")

    for impersonate in impersonate_chain:
        tls_impersonate = tls_impersonate_for(impersonate)
        matched_ua = ua_for_impersonate(impersonate)
        persistent_cookies = load_cookie_jar(args.cookie_jar_dir, args.url, impersonate, args.proxy, cf_ttl_seconds=args.cf_cookie_ttl) if args.cookie_jar else []
        current_profile_entry = profile_entry_for(profile_state, args.url, impersonate, args.proxy) if args.profile_state else {}
        challenge_seen_for_profile = False

        for retry_index in range(retry_budget + 1):
            attempt_started = time.time()

            try:
                headers = browser_ordered_headers(
                    raw_headers,
                    default_user_agent=matched_ua,
                    url=args.url,
                    accept_language=args.accept_language,
                    accept_encoding=accept_encoding,
                    referer=explicit_referer,
                    browser_headers=args.browser_headers,
                    impersonate=impersonate,
                    strict_order=args.strict_header_order,
                )

                try:
                    session = requests.Session(impersonate=tls_impersonate)
                    session_supports_impersonate = True
                except TypeError:
                    session = requests.Session()
                    session_supports_impersonate = False

                raw_cookie_header = header_get(headers, "cookie")
                seeded_cookies = seed_session_cookies(
                    session,
                    raw_cookie_header,
                    args.url,
                    merge_cookie_items(persistent_cookies, structured_cookie_items),
                    cf_ttl_seconds=args.cf_cookie_ttl,
                )
                if seeded_cookies:
                    put_header(headers, "Cookie", cookie_header_from_items(seeded_cookies), force=True)

                if args.before_flare and args.before_flare_cmd and not seeded_cookies:
                    hook_context = {
                        "phase": "before_request",
                        "url": args.url,
                        "method": method,
                        "headers": headers,
                        "impersonate": impersonate,
                        "tlsImpersonate": tls_impersonate,
                        "proxyConfigured": bool(proxies),
                        "host": host_from_url(args.url),
                    }
                    hook_result = run_before_flare_hook(args.before_flare_cmd, hook_context, args.before_flare_timeout)
                    attempts.append({"impersonate": impersonate, "tlsImpersonate": tls_impersonate, "retry": retry_index, "hookPhase": "before_request", "hookStatus": hook_result.get("status", "ok")})
                    headers, hook_cookies = apply_hook_result(headers, hook_result, args.url)
                    if hook_cookies:
                        seeded_cookies = seed_session_cookies(session, header_get(headers, "cookie"), args.url, merge_cookie_items(seeded_cookies, hook_cookies), cf_ttl_seconds=args.cf_cookie_ttl)
                        put_header(headers, "Cookie", cookie_header_from_items(seeded_cookies), force=True)

                http_version_mode = adaptive_http_version_mode(args.http_version, current_profile_entry, retry_index, input_signals)
                request_kwargs: Dict[str, Any] = {
                    "headers": headers,
                    "timeout": timeout_seconds,
                    "allow_redirects": True,
                    "verify": not bool(args.insecure),
                }

                if proxies:
                    request_kwargs["proxies"] = proxies
                if not session_supports_impersonate:
                    request_kwargs["impersonate"] = tls_impersonate
                if request_supports_accept_encoding:
                    request_kwargs["accept_encoding"] = accept_encoding
                http_version_value = curl_http_version_value(http_version_mode, tls_impersonate)
                if request_supports_http_version and http_version_value is not None:
                    request_kwargs["http_version"] = http_version_value

                origin = origin_from_url(args.url)
                if args.warmup_origin and origin and origin.rstrip("/") != str(args.url).rstrip("/"):
                    try:
                        warm_headers = dict(headers)
                        put_header(warm_headers, "Sec-Fetch-Site", "none", force=True)
                        pop_header(warm_headers, "Referer")
                        pop_header(warm_headers, "Cookie")
                        if seeded_cookies:
                            origin_cookies = cookies_for_url(seeded_cookies, origin, cf_ttl_seconds=args.cf_cookie_ttl)
                            if origin_cookies:
                                put_header(warm_headers, "Cookie", cookie_header_from_items(origin_cookies), force=True)
                        warm_kwargs = dict(request_kwargs)
                        warm_kwargs["headers"] = warm_headers
                        warm_resp = session.get(origin, **warm_kwargs)
                        warm_status = int(getattr(warm_resp, "status_code", 0) or 0)
                        attempts.append({"impersonate": impersonate, "tlsImpersonate": tls_impersonate, "retry": retry_index, "warmupStatus": warm_status})
                        sleep_jitter(args.warmup_jitter_min, args.warmup_jitter_max)
                    except Exception as warm_exc:
                        attempts.append({"impersonate": impersonate, "tlsImpersonate": tls_impersonate, "retry": retry_index, "warmupError": str(warm_exc)[:240]})

                if method not in {"GET", "HEAD"} and args.data is not None:
                    request_kwargs["data"] = args.data

                response = session.request(method, args.url, **request_kwargs)
                payload = response_payload_from(
                    response=response,
                    session=session,
                    seeded_cookies=seeded_cookies,
                    headers=headers,
                    matched_ua=matched_ua,
                    impersonate=impersonate,
                    tls_impersonate=tls_impersonate,
                    impersonate_chain=impersonate_chain,
                    attempts=attempts,
                    started=started,
                    args=args,
                    input_signals=input_signals,
                    profile_state_entry=current_profile_entry,
                    http_version_mode=http_version_mode,
                )

                cookies = payload.get("cookies") or []
                if args.cookie_jar:
                    save_cookie_jar(args.cookie_jar_dir, args.url, impersonate, args.proxy, cookies, cf_ttl_seconds=args.cf_cookie_ttl)

                status = int(payload.get("code") or 0)
                challenge = bool(payload.get("challengeDetected"))
                last_payload = payload

                attempt_elapsed_ms = int((time.time() - attempt_started) * 1000)
                if args.profile_state:
                    current_profile_entry = record_profile_result(
                        profile_state,
                        args.url,
                        impersonate,
                        args.proxy,
                        status=status,
                        challenge=challenge,
                        elapsed_ms=attempt_elapsed_ms,
                    )
                    save_profile_state(profile_state_path, profile_state, max_hosts=cfg_int("CURL_CFFI_PROFILE_STATE_MAX_HOSTS", 256, minimum=1, maximum=10000))
                    payload["profileScore"] = current_profile_entry.get("score")
                    payload["profileStats"] = {key: current_profile_entry.get(key) for key in ("success", "fail", "challenge", "avgMs", "lastStatus") if current_profile_entry.get(key) is not None}

                attempts.append({
                    "impersonate": impersonate,
                    "tlsImpersonate": tls_impersonate,
                    "retry": retry_index,
                    "status": status,
                    "challenge": challenge,
                    "challengeReason": payload.get("challengeReason") or "",
                    "seededCookies": len(seeded_cookies),
                    "httpVersionMode": http_version_mode,
                    "profileScore": current_profile_entry.get("score") if isinstance(current_profile_entry, dict) else None,
                    "ms": attempt_elapsed_ms,
                })

                if challenge and args.before_flare and args.before_flare_cmd and not challenge_seen_for_profile:
                    challenge_seen_for_profile = True
                    hook_context = {
                        "phase": "challenge_detected",
                        "url": args.url,
                        "finalUrl": payload.get("url"),
                        "method": method,
                        "status": status,
                        "headers": headers,
                        "responseHeaders": payload.get("headers") or {},
                        "cookies": cookies,
                        "impersonate": impersonate,
                        "tlsImpersonate": tls_impersonate,
                        "proxyConfigured": bool(proxies),
                        "host": host_from_url(args.url),
                        "challengeReason": payload.get("challengeReason") or "",
                    }
                    hook_result = run_before_flare_hook(args.before_flare_cmd, hook_context, args.before_flare_timeout)
                    attempts.append({"impersonate": impersonate, "tlsImpersonate": tls_impersonate, "retry": retry_index, "hookPhase": "challenge_detected", "hookStatus": hook_result.get("status", "ok")})
                    retry_headers, hook_cookies = apply_hook_result(headers, hook_result, args.url)
                    if hook_cookies:
                        retry_session = session
                        retry_seeded = seed_session_cookies(retry_session, header_get(retry_headers, "cookie"), args.url, merge_cookie_items(cookies, hook_cookies), cf_ttl_seconds=args.cf_cookie_ttl)
                        put_header(retry_headers, "Cookie", cookie_header_from_items(retry_seeded), force=True)
                        retry_kwargs = dict(request_kwargs)
                        retry_kwargs["headers"] = retry_headers
                        retry_response = retry_session.request(method, args.url, **retry_kwargs)
                        retry_payload = response_payload_from(
                            response=retry_response,
                            session=retry_session,
                            seeded_cookies=retry_seeded,
                            headers=retry_headers,
                            matched_ua=matched_ua,
                            impersonate=impersonate,
                            tls_impersonate=tls_impersonate,
                            impersonate_chain=impersonate_chain,
                            attempts=attempts,
                            started=started,
                            args=args,
                            input_signals=input_signals,
                            profile_state_entry=current_profile_entry,
                            http_version_mode=http_version_mode,
                        )
                        last_payload = retry_payload
                        if args.cookie_jar:
                            save_cookie_jar(args.cookie_jar_dir, args.url, impersonate, args.proxy, retry_payload.get("cookies") or [], cf_ttl_seconds=args.cf_cookie_ttl)
                        attempts.append({
                            "impersonate": impersonate,
                            "tlsImpersonate": tls_impersonate,
                            "retry": retry_index,
                            "afterHookStatus": retry_payload.get("code"),
                            "afterHookChallenge": retry_payload.get("challengeDetected"),
                            "ms": int((time.time() - attempt_started) * 1000),
                        })
                        if not retry_payload.get("challengeDetected") and int(retry_payload.get("code") or 0) not in RETRY_STATUSES:
                            retry_payload["attempts"] = attempts
                            retry_payload["elapsedMs"] = int((time.time() - started) * 1000)
                            emit(retry_payload)

                if status not in RETRY_STATUSES and not challenge:
                    payload["attempts"] = attempts
                    payload["elapsedMs"] = int((time.time() - started) * 1000)
                    emit(payload)

                if challenge:
                    break

                if status in RETRY_STATUSES and retry_index < retry_budget:
                    sleep_before_retry(backoff_ms, retry_index)
                    continue

                break

            except Exception as exc:
                last_error = str(exc)
                attempt_elapsed_ms = int((time.time() - attempt_started) * 1000)
                if args.profile_state:
                    current_profile_entry = record_profile_result(
                        profile_state,
                        args.url,
                        impersonate,
                        args.proxy,
                        status=0,
                        challenge=False,
                        elapsed_ms=attempt_elapsed_ms,
                        error=last_error,
                    )
                    save_profile_state(profile_state_path, profile_state, max_hosts=cfg_int("CURL_CFFI_PROFILE_STATE_MAX_HOSTS", 256, minimum=1, maximum=10000))
                attempts.append({"impersonate": impersonate, "tlsImpersonate": tls_impersonate, "retry": retry_index, "error": last_error[:240], "profileScore": current_profile_entry.get("score") if isinstance(current_profile_entry, dict) else None, "ms": attempt_elapsed_ms})

                if retry_index < retry_budget:
                    sleep_before_retry(backoff_ms, retry_index)
                    continue

                break

    if last_payload:
        last_payload["attempts"] = attempts
        last_payload["elapsedMs"] = int((time.time() - started) * 1000)
        emit(last_payload)

    emit({"status": "error", "message": last_error or "curl_cffi_no_response", "attempts": attempts, "elapsedMs": int((time.time() - started) * 1000)}, 1)


if __name__ == "__main__":
    main()

