#!/usr/bin/env python3

from __future__ import annotations

import argparse
import json
import os
import random
import re
import sys
import time
from http.cookies import SimpleCookie
from typing import Any, Dict, Iterable, List, Optional, Tuple
from urllib.parse import urlparse

UA_BY_IMPERSONATE: Dict[str, str] = {
    "chrome138": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/138.0.0.0 Safari/537.36"
    ),
    "chrome137": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/137.0.0.0 Safari/537.36"
    ),
    "chrome136": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/136.0.0.0 Safari/537.36"
    ),
    "chrome133": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/133.0.0.0 Safari/537.36"
    ),
    "chrome131": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/131.0.0.0 Safari/537.36"
    ),
    "chrome124": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/124.0.0.0 Safari/537.36"
    ),
    "chrome120": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/120.0.0.0 Safari/537.36"
    ),
    "firefox137": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:137.0) "
        "Gecko/20100101 Firefox/137.0"
    ),
    "firefox135": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:135.0) "
        "Gecko/20100101 Firefox/135.0"
    ),
    "firefox128": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:128.0) "
        "Gecko/20100101 Firefox/128.0"
    ),
    "safari18_2": (
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
        "AppleWebKit/605.1.15 (KHTML, like Gecko) "
        "Version/18.2 Safari/605.1.15"
    ),
}

DEFAULT_FALLBACK_UA = UA_BY_IMPERSONATE["chrome136"]
DEFAULT_IMPERSONATE_CHAIN = ["chrome138", "chrome137", "chrome136", "chrome133", "chrome124", "chrome120"]
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

DEFAULT_CONFIG: Dict[str, str] = {
    "CURL_CFFI_ENABLED": "true",
    "CURL_CFFI_IMPERSONATE": "auto",
    "CURL_CFFI_TIMEOUT_MS": "15000",
    "CURL_CFFI_RETRIES": "1",
    "CURL_CFFI_RETRY_BACKOFF_MS": "250",
    "CURL_CFFI_WARMUP_ORIGIN": "true",
    "CURL_CFFI_BROWSER_HEADERS": "true",
    "CURL_CFFI_ACCEPT_LANGUAGE": "it-IT,it;q=0.9,en-US;q=0.8,en;q=0.7",
    "CURL_CFFI_INSECURE": "false",
    "CURL_CFFI_DEBUG": "false",
    "CURL_CFFI_MAX_CONCURRENT": "4",
    "CURL_CFFI_MAX_QUEUE": "40",
    "CURL_CFFI_QUEUE_TIMEOUT_MS": "20000",
    "CURL_CFFI_BEFORE_FLARE": "true",
    "CURL_CFFI_BEFORE_FLARE_TIMEOUT_MS": "6500",
    "CURL_CFFI_PROXY": "",
    "CURL_CFFI_PYTHON": "",
}

CF_CHALLENGE_RE = re.compile(
    r"just a moment|checking your browser|cloudflare ray id|cf-browser-verification|"
    r"enable javascript and cookies|cf-chl-widget|__cf_chl_opt|cf\.challenge\.orchestrate|"
    r"challenge-platform|turnstile\.cloudflare\.com|<title>\s*(?:just a moment|attention required|verifica)",
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


def parse_json_object(value: Optional[str], fallback: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    if not value:
        return dict(fallback or {})
    try:
        parsed = json.loads(value)
    except (TypeError, ValueError, json.JSONDecodeError):
        return dict(fallback or {})
    return parsed if isinstance(parsed, dict) else dict(fallback or {})


def header_get(headers: Dict[str, str], name: str) -> str:
    target = name.lower()
    for key, value in (headers or {}).items():
        if str(key).lower() == target:
            return str(value)
    return ""


def set_header_if_missing(headers: Dict[str, str], name: str, value: str) -> None:
    if value and not any(str(key).lower() == name.lower() for key in headers):
        headers[name] = value


def origin_from_url(url: str) -> str:
    parsed = urlparse(str(url or ""))
    if not parsed.scheme or not parsed.netloc:
        return ""
    return f"{parsed.scheme}://{parsed.netloc}/"


def host_from_url(url: str) -> str:
    return (urlparse(str(url or "")).hostname or "").lower().strip(".")


def ua_for_impersonate(impersonate: str) -> str:
    value = str(impersonate or "")
    if value in UA_BY_IMPERSONATE:
        return UA_BY_IMPERSONATE[value]
    for key in sorted(UA_BY_IMPERSONATE, key=len, reverse=True):
        if value.startswith(key):
            return UA_BY_IMPERSONATE[key]
    return DEFAULT_FALLBACK_UA


def is_chromium_based(impersonate: str) -> bool:
    value = str(impersonate or "").lower()
    return value.startswith(("chrome", "edge", "chromium"))


def chrome_major_from_ua(user_agent: str) -> str:
    match = re.search(r"Chrome/(\d+)", user_agent or "")
    return match.group(1) if match else "138"


def sec_ch_ua_for_chrome(major: str) -> str:
    try:
        major_int = int(major)
    except (TypeError, ValueError):
        major_int = 138
    if major_int >= 131:
        return f'"Google Chrome";v="{major}", "Not A(Brand";v="8", "Chromium";v="{major}"'
    return f'"Google Chrome";v="{major}", "Chromium";v="{major}", "Not.A/Brand";v="99"'


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
    if request_host and referer_host and (request_host == referer_host or request_host.endswith(f".{referer_host}") or referer_host.endswith(f".{request_host}")):
        return "same-site"
    return "cross-site"


def normalize_headers(
    headers: Dict[str, Any],
    *,
    default_user_agent: str,
    url: str,
    accept_language: str,
    referer: str = "",
    browser_headers: bool = True,
    impersonate: str = "",
) -> Dict[str, str]:
    normalized: Dict[str, str] = {}

    for key, value in (headers or {}).items():
        if value is None:
            continue
        clean_key = str(key).strip()
        if not clean_key or clean_key.lower() in HOP_BY_HOP_HEADERS:
            continue
        normalized[clean_key] = str(value)

    if not header_get(normalized, "user-agent") and default_user_agent:
        normalized["User-Agent"] = default_user_agent

    if not browser_headers:
        return normalized

    ua = header_get(normalized, "user-agent") or default_user_agent
    parsed = urlparse(str(url or ""))
    generated_referer = origin_from_url(url) if parsed.path not in ("", "/") else ""
    effective_referer = referer or header_get(normalized, "referer") or generated_referer

    set_header_if_missing(normalized, "Accept", "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7")
    set_header_if_missing(normalized, "Accept-Language", accept_language)
    set_header_if_missing(normalized, "Accept-Encoding", "gzip, deflate, br, zstd")
    set_header_if_missing(normalized, "Upgrade-Insecure-Requests", "1")
    set_header_if_missing(normalized, "Sec-Fetch-Dest", "document")
    set_header_if_missing(normalized, "Sec-Fetch-Mode", "navigate")
    set_header_if_missing(normalized, "Sec-Fetch-Site", sec_fetch_site_for(url, effective_referer))
    set_header_if_missing(normalized, "Sec-Fetch-User", "?1")
    set_header_if_missing(normalized, "Priority", "u=0, i")

    if not impersonate or is_chromium_based(impersonate):
        chrome_major = chrome_major_from_ua(ua)
        set_header_if_missing(normalized, "sec-ch-ua", sec_ch_ua_for_chrome(chrome_major))
        set_header_if_missing(normalized, "sec-ch-ua-mobile", "?1" if is_mobile_ua(ua) else "?0")
        set_header_if_missing(normalized, "sec-ch-ua-platform", platform_label_from_ua(ua))

    if effective_referer:
        set_header_if_missing(normalized, "Referer", effective_referer)

    return normalized


def cookie_value(item: Dict[str, Any]) -> Any:
    return item["value"] if "value" in item else item.get("val")


def serialize_cookie(cookie: Any) -> Optional[Dict[str, Any]]:
    name = getattr(cookie, "name", None) or getattr(cookie, "key", None)
    value = getattr(cookie, "value", None)
    if not name or value is None:
        return None
    item: Dict[str, Any] = {"name": str(name), "value": str(value)}
    for field in ("domain", "path", "secure", "expires"):
        field_value = getattr(cookie, field, None)
        if field_value is not None:
            item[field] = bool(field_value) if field == "secure" else field_value
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
            return [{"name": str(name), "value": str(value)} for name, value in cookies.get_dict().items()]
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
            item = {"name": name.strip(), "value": value.strip()}
        elif isinstance(cookie, tuple) and len(cookie) >= 2:
            item = {"name": str(cookie[0]), "value": str(cookie[1])}
        elif isinstance(cookie, dict):
            name = str(cookie.get("name") or cookie.get("key") or "").strip()
            value = cookie_value(cookie)
            if not name or value is None:
                continue
            item = {"name": name, "value": str(value)}
            for field in ("domain", "path", "secure", "expires"):
                if cookie.get(field) is not None:
                    item[field] = cookie[field]
        else:
            item = serialize_cookie(cookie)

        if not item:
            continue

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
            item: Dict[str, Any] = {"name": str(name), "value": str(morsel.value), "path": "/"}
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
        item = {"name": name, "value": value.strip(), "path": "/"}
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
        }
        domain = str(item.get("domain") or item.get("host") or default_domain or "").strip().lstrip(".")
        if domain:
            cookie["domain"] = domain
        if item.get("secure") is not None:
            cookie["secure"] = bool(item.get("secure"))
        if item.get("expires") is not None:
            cookie["expires"] = item.get("expires")
        output.append(cookie)

    if isinstance(parsed, list):
        for entry in parsed:
            push(entry)
    elif isinstance(parsed, dict):
        for name, raw_value in parsed.items():
            push({"name": name, **raw_value} if isinstance(raw_value, dict) else {"name": name, "value": raw_value})

    deduped: List[Dict[str, Any]] = []
    seen = set()
    for item in output:
        key = (item.get("name"), item.get("domain", ""), item.get("path", ""))
        if key in seen:
            continue
        seen.add(key)
        deduped.append(item)

    return deduped


def merge_cookie_items(*groups: Iterable[Dict[str, Any]]) -> List[Dict[str, Any]]:
    merged: Dict[Tuple[str, str, str], Dict[str, Any]] = {}
    for group in groups:
        for item in group or []:
            name = str(item.get("name") or "").strip()
            if not name:
                continue
            key = (name, str(item.get("domain") or ""), str(item.get("path") or ""))
            merged[key] = dict(item)
    return list(merged.values())


def seed_session_cookies(session: Any, cookie_header: str, url: str, cookie_items: Optional[List[Dict[str, Any]]] = None) -> List[Dict[str, Any]]:
    items = merge_cookie_items(cookie_header_to_items(cookie_header, url), cookie_items or [])
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
        if header in {"cf-ray", "cf-cache-status"}:
            return True
        if header == "server" and "cloudflare" in str(value).lower():
            return True
    return False


def is_challenge_page(text: str, status: int, response_headers: Optional[Dict[str, str]] = None) -> bool:
    body = str(text or "")
    code = int(status or 0)

    if CF_CHALLENGE_RE.search(body[:60000]):
        return True

    if code in {403, 429, 503}:
        return True if response_headers is None else has_cf_response_headers(response_headers)

    return False


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="curl_cffi browser-impersonated fetcher")
    parser.add_argument("url")
    parser.add_argument("--method", default="GET")
    parser.add_argument("--data")
    parser.add_argument("--headers")
    parser.add_argument("--cookies-json", default="", help="Optional structured cookies from a shared FlareSolverr/Redis session")
    parser.add_argument("--timeout", type=int, default=cfg_int("CURL_CFFI_TIMEOUT_MS", 15000, minimum=1000), help="Timeout per request in milliseconds")
    parser.add_argument("--impersonate", default=cfg("CURL_CFFI_IMPERSONATE", "auto"), help="auto or comma-separated curl_cffi impersonation labels")
    parser.add_argument("--proxy", default=cfg("CURL_CFFI_PROXY", ""))
    parser.add_argument("--retries", type=int, default=cfg_int("CURL_CFFI_RETRIES", 1, minimum=0, maximum=5))
    parser.add_argument("--retry-backoff", type=int, default=cfg_int("CURL_CFFI_RETRY_BACKOFF_MS", 250, minimum=0, maximum=5000), help="Base backoff in milliseconds")
    parser.add_argument("--accept-language", default=cfg("CURL_CFFI_ACCEPT_LANGUAGE", "it-IT,it;q=0.9,en-US;q=0.8,en;q=0.7"))
    parser.add_argument("--referer", default="")
    parser.add_argument("--warmup-origin", dest="warmup_origin", action="store_true", default=cfg_bool("CURL_CFFI_WARMUP_ORIGIN", True), help="Hit the origin before a deep-link request using the same session")
    parser.add_argument("--no-warmup-origin", dest="warmup_origin", action="store_false")
    parser.add_argument("--browser-headers", dest="browser_headers", action="store_true", default=cfg_bool("CURL_CFFI_BROWSER_HEADERS", True), help="Add browser navigation headers when missing")
    parser.add_argument("--no-browser-headers", dest="browser_headers", action="store_false")
    parser.add_argument("--insecure", dest="insecure", action="store_true", default=cfg_bool("CURL_CFFI_INSECURE", False), help="Disable TLS certificate verification")
    parser.add_argument("--secure", dest="insecure", action="store_false")
    return parser


def sleep_before_retry(backoff_ms: int, retry_index: int) -> None:
    sleep_for = (backoff_ms / 1000.0) * (retry_index + 1) + random.uniform(0, min(0.25, backoff_ms / 1000.0))
    if sleep_for > 0:
        time.sleep(sleep_for)


def main() -> None:
    parser = build_parser()
    args = parser.parse_args()
    started = time.time()
    attempts: List[Dict[str, Any]] = []

    try:
        from curl_cffi import requests
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
    last_error = ""
    last_payload: Optional[Dict[str, Any]] = None

    for impersonate in impersonate_chain:
        matched_ua = ua_for_impersonate(impersonate)

        for retry_index in range(retry_budget + 1):
            attempt_started = time.time()

            try:
                headers = normalize_headers(
                    raw_headers,
                    default_user_agent=matched_ua,
                    url=args.url,
                    accept_language=args.accept_language,
                    referer=args.referer,
                    browser_headers=args.browser_headers,
                    impersonate=impersonate,
                )

                try:
                    session = requests.Session(impersonate=impersonate)
                    session_supports_impersonate = True
                except TypeError:
                    session = requests.Session()
                    session_supports_impersonate = False

                raw_cookie_header = header_get(headers, "cookie")
                seeded_cookies = seed_session_cookies(session, raw_cookie_header, args.url, structured_cookie_items)
                if seeded_cookies:
                    headers["Cookie"] = cookie_header_from_items(seeded_cookies)

                request_kwargs: Dict[str, Any] = {
                    "headers": headers,
                    "timeout": timeout_seconds,
                    "allow_redirects": True,
                    "verify": not bool(args.insecure),
                }

                if proxies:
                    request_kwargs["proxies"] = proxies
                if not session_supports_impersonate:
                    request_kwargs["impersonate"] = impersonate

                origin = origin_from_url(args.url)
                if args.warmup_origin and origin and origin.rstrip("/") != str(args.url).rstrip("/"):
                    try:
                        warm_headers = dict(headers)
                        warm_headers["Sec-Fetch-Site"] = "none"
                        warm_headers.pop("Referer", None)
                        warm_kwargs = dict(request_kwargs)
                        warm_kwargs["headers"] = warm_headers
                        warm_resp = session.get(origin, **warm_kwargs)
                        attempts.append({"impersonate": impersonate, "retry": retry_index, "warmupStatus": getattr(warm_resp, "status_code", 0)})
                    except Exception as warm_exc:
                        attempts.append({"impersonate": impersonate, "retry": retry_index, "warmupError": str(warm_exc)[:240]})

                if method not in {"GET", "HEAD"} and args.data is not None:
                    request_kwargs["data"] = args.data

                response = session.request(method, args.url, **request_kwargs)
                html = response.text or ""
                response_headers = dict(response.headers or {})
                response_cookies = serialize_cookies(getattr(response, "cookies", None))
                session_cookies = serialize_cookies(getattr(session, "cookies", None))
                cookies = merge_cookie_items(seeded_cookies, session_cookies, response_cookies)
                status = int(getattr(response, "status_code", 0) or 0)
                challenge = is_challenge_page(html, status, response_headers)
                user_agent = header_get(headers, "user-agent") or matched_ua

                payload = {
                    "status": "ok",
                    "code": status,
                    "url": str(getattr(response, "url", args.url) or args.url),
                    "html": html,
                    "headers": response_headers,
                    "cookies": cookies,
                    "cookieHeader": cookie_header_from_items(cookies),
                    "seededCookieHeader": cookie_header_from_items(seeded_cookies),
                    "userAgent": user_agent,
                    "requestHeaders": headers,
                    "impersonate": impersonate,
                    "impersonateChain": impersonate_chain,
                    "challengeDetected": challenge,
                    "attempts": attempts,
                    "elapsedMs": int((time.time() - started) * 1000),
                }

                last_payload = payload
                attempts.append({
                    "impersonate": impersonate,
                    "retry": retry_index,
                    "status": status,
                    "challenge": challenge,
                    "seededCookies": len(seeded_cookies),
                    "ms": int((time.time() - attempt_started) * 1000),
                })

                if status not in RETRY_STATUSES and not challenge:
                    emit(payload)

                if challenge:
                    break

                if status in RETRY_STATUSES and retry_index < retry_budget:
                    sleep_before_retry(backoff_ms, retry_index)
                    continue

                break

            except Exception as exc:
                last_error = str(exc)
                attempts.append({"impersonate": impersonate, "retry": retry_index, "error": last_error[:240], "ms": int((time.time() - attempt_started) * 1000)})

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
