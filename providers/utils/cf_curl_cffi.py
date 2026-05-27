#!/usr/bin/env python3
"""
Lightweight Cloudflare-aware HTTP fetcher powered by curl_cffi.

Node.js invokes this script as a subprocess and receives one JSON object on
stdout. It does not solve interactive CAPTCHA challenges; it gives Leviathan a
fast browser-impersonated TLS/JA3 pass before escalating to heavier fallbacks.
"""

from __future__ import annotations

import argparse
import json
import os
import random
import re
import sys
import time
from typing import Any, Dict, Iterable, List, Optional, Tuple
from urllib.parse import urlparse


# UA strings matched exactly to each curl_cffi impersonate target.
# Having the TLS fingerprint and User-Agent agree is critical: Cloudflare's
# bot-score model correlates JA3/JA4 with the browser declared in the UA.
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

# Fallback UA used only when impersonate target is not in UA_BY_IMPERSONATE.
DEFAULT_FALLBACK_UA = UA_BY_IMPERSONATE["chrome136"]


def ua_for_impersonate(impersonate: str) -> str:
    """Return a User-Agent string that matches the impersonate target's TLS fingerprint."""
    ua = UA_BY_IMPERSONATE.get(impersonate)
    if ua:
        return ua
    # Fuzzy match: find the longest key that is a prefix of impersonate
    for key in sorted(UA_BY_IMPERSONATE, key=len, reverse=True):
        if impersonate.startswith(key):
            return UA_BY_IMPERSONATE[key]
    return DEFAULT_FALLBACK_UA


def is_chromium_based(impersonate: str) -> bool:
    name = impersonate.lower()
    return name.startswith("chrome") or name.startswith("edge") or name.startswith("chromium")


def is_firefox_based(impersonate: str) -> bool:
    return impersonate.lower().startswith("firefox")


# Newer curl_cffi releases support the newest labels; older releases will raise
# on unsupported labels, so we automatically walk down the chain.
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
    # Master behavior
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
    # Node-side queue/pre-Flare defaults mirrored here for documentation.
    "CURL_CFFI_MAX_CONCURRENT": "4",
    "CURL_CFFI_MAX_QUEUE": "40",
    "CURL_CFFI_QUEUE_TIMEOUT_MS": "20000",
    "CURL_CFFI_BEFORE_FLARE": "true",
    "CURL_CFFI_BEFORE_FLARE_TIMEOUT_MS": "6500",
    # Must be a real HTTP/SOCKS proxy listener, not Kraken /forward?url=.
    "CURL_CFFI_PROXY": "",
    "CURL_CFFI_PYTHON": "",
}


def cfg(name: str, fallback: str = "") -> str:
    value = os.getenv(name)
    if value is not None and str(value).strip() != "":
        return str(value)
    return DEFAULT_CONFIG.get(name, fallback)


def cfg_bool(name: str, fallback: bool = False) -> bool:
    raw = cfg(name, "true" if fallback else "false").strip().lower()
    return raw in {"1", "true", "yes", "on"}


def cfg_int(name: str, fallback: int, *, minimum: int = 0, maximum: int = 2_147_483_647) -> int:
    try:
        parsed = int(cfg(name, str(fallback)))
    except Exception:
        parsed = fallback
    return max(minimum, min(maximum, parsed))


CF_CHALLENGE_RE = re.compile(
    r"just a moment|checking your browser|cloudflare ray id|cf-browser-verification|"
    r"enable javascript and cookies|cf-chl-widget|__cf_chl_opt|cf\.challenge\.orchestrate|"
    r"challenge-platform|turnstile\.cloudflare\.com|<title>\s*(?:just a moment|attention required|verifica)",
    re.I,
)


def emit(payload: Dict[str, Any], code: int = 0) -> None:
    print(json.dumps(payload, ensure_ascii=False, separators=(",", ":")))
    sys.exit(code)


def parse_json_object(value: Optional[str], fallback: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    if not value:
        return dict(fallback or {})
    try:
        parsed = json.loads(value)
        return parsed if isinstance(parsed, dict) else dict(fallback or {})
    except Exception:
        return dict(fallback or {})


def header_get(headers: Dict[str, str], name: str) -> str:
    target = name.lower()
    for key, value in headers.items():
        if key.lower() == target:
            return value
    return ""


def set_header_if_missing(headers: Dict[str, str], name: str, value: str) -> None:
    if not value:
        return
    target = name.lower()
    if any(key.lower() == target for key in headers):
        return
    headers[name] = value


def origin_from_url(url: str) -> str:
    parsed = urlparse(str(url or ""))
    if not parsed.scheme or not parsed.netloc:
        return ""
    return f"{parsed.scheme}://{parsed.netloc}/"


def chrome_major_from_ua(user_agent: str) -> str:
    match = re.search(r"Chrome/(\d+)", user_agent or "")
    return match.group(1) if match else "138"


def sec_ch_ua_for_chrome(major: str) -> str:
    """Generate sec-ch-ua brand string appropriate for the Chrome major version."""
    try:
        major_int = int(major)
    except (ValueError, TypeError):
        major_int = 138
    if major_int >= 131:
        return f'"Google Chrome";v="{major}", "Not A(Brand";v="8", "Chromium";v="{major}"'
    return f'"Google Chrome";v="{major}", "Chromium";v="{major}", "Not.A/Brand";v="99"'


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
    out: Dict[str, str] = {}
    has_user_agent = False
    for key, value in (headers or {}).items():
        if value is None:
            continue
        clean_key = str(key).strip()
        if not clean_key:
            continue
        if clean_key.lower() in HOP_BY_HOP_HEADERS:
            continue
        if clean_key.lower() == "user-agent":
            has_user_agent = True
        out[clean_key] = str(value)

    if not has_user_agent and default_user_agent:
        out["User-Agent"] = default_user_agent

    if browser_headers:
        ua = header_get(out, "user-agent") or default_user_agent
        parsed = urlparse(str(url or ""))
        same_origin_ref = origin_from_url(url)
        set_header_if_missing(out, "Accept", "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7")
        set_header_if_missing(out, "Accept-Language", accept_language)
        set_header_if_missing(out, "Accept-Encoding", "gzip, deflate, br, zstd")
        set_header_if_missing(out, "Upgrade-Insecure-Requests", "1")
        set_header_if_missing(out, "Sec-Fetch-Dest", "document")
        set_header_if_missing(out, "Sec-Fetch-Mode", "navigate")
        set_header_if_missing(out, "Sec-Fetch-Site", "none" if not referer else "same-origin")
        set_header_if_missing(out, "Sec-Fetch-User", "?1")
        set_header_if_missing(out, "Priority", "u=0, i")

        # Set sec-ch-ua only for Chromium-based impersonation targets.
        # curl_cffi does NOT automatically inject these HTTP headers even when
        # impersonating Chrome — the caller must supply them. Using values that
        # match the impersonated Chrome major avoids a UA/TLS-fingerprint mismatch.
        if not impersonate or is_chromium_based(impersonate):
            chrome_major = chrome_major_from_ua(ua)
            set_header_if_missing(out, "sec-ch-ua", sec_ch_ua_for_chrome(chrome_major))
            set_header_if_missing(out, "sec-ch-ua-mobile", "?0")
            set_header_if_missing(out, "sec-ch-ua-platform", '"Windows"')

        if referer:
            set_header_if_missing(out, "Referer", referer)
        elif parsed.path not in ("", "/"):
            set_header_if_missing(out, "Referer", same_origin_ref)

    return out


def serialize_cookie(cookie: Any) -> Optional[Dict[str, Any]]:
    name = getattr(cookie, "name", None) or getattr(cookie, "key", None)
    value = getattr(cookie, "value", None)
    if not name or value is None:
        return None
    item: Dict[str, Any] = {"name": str(name), "value": str(value)}
    for field in ("domain", "path", "secure", "expires"):
        value = getattr(cookie, field, None)
        if value is not None:
            item[field] = bool(value) if field == "secure" else value
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
            return [{"name": str(k), "value": str(v)} for k, v in cookies.get_dict().items()]
        except Exception:
            return []

    out: List[Dict[str, Any]] = []
    seen = set()
    for cookie in candidates:
        if isinstance(cookie, str):
            if "=" not in cookie:
                continue
            name, value = cookie.split("=", 1)
            item = {"name": name.strip(), "value": value.strip()}
        elif isinstance(cookie, tuple) and len(cookie) >= 2:
            item = {"name": str(cookie[0]), "value": str(cookie[1])}
        elif isinstance(cookie, dict):
            name = cookie.get("name") or cookie.get("key")
            value = cookie.get("value") or cookie.get("val")
            if not name or value is None:
                continue
            item = {"name": str(name), "value": str(value)}
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
        out.append(item)
    return out


def cookie_header_from_items(items: Iterable[Dict[str, Any]]) -> str:
    merged: Dict[str, str] = {}
    for item in items or []:
        name = str(item.get("name") or "").strip()
        value = item.get("value")
        if name and value is not None:
            merged[name] = str(value)
    return "; ".join(f"{name}={value}" for name, value in merged.items())


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
    if not is_usable_proxy_url(clean):
        return None
    return {"http": clean, "https": clean}


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
    """Return True if response headers indicate a Cloudflare-protected origin."""
    for key, value in (response_headers or {}).items():
        k = key.lower()
        if k in ("cf-ray", "cf-cache-status"):
            return True
        if k == "server" and "cloudflare" in str(value).lower():
            return True
    return False


def is_challenge_page(text: str, status: int, response_headers: Optional[Dict[str, str]] = None) -> bool:
    """
    Return True if the response is a Cloudflare challenge page.

    When response_headers are provided we require either CF-specific headers
    or CF-specific body patterns before classifying status-code-only blocks
    (403/429/503) as challenges. This avoids false-positives on non-CF servers
    that legitimately return those status codes, preventing unnecessary
    escalation to FlareSolverr.
    """
    body = str(text or "")
    code = int(status or 0)

    # Body-pattern check is always authoritative regardless of status code.
    if CF_CHALLENGE_RE.search(body[:60000]):
        return True

    if code in {403, 429, 503}:
        if response_headers is None:
            # No headers available (backward-compat): treat as potential CF block.
            return True
        # Only flag status-code blocks when CF headers confirm origin is CF-protected.
        return has_cf_response_headers(response_headers)

    return False


def main() -> None:
    parser = argparse.ArgumentParser(description="curl_cffi browser-impersonated fetcher")
    parser.add_argument("url")
    parser.add_argument("--method", default="GET")
    parser.add_argument("--data")
    parser.add_argument("--headers")
    parser.add_argument("--timeout", type=int, default=cfg_int("CURL_CFFI_TIMEOUT_MS", 15000, minimum=1000), help="Timeout per request in milliseconds")
    parser.add_argument("--impersonate", default=cfg("CURL_CFFI_IMPERSONATE", "auto"), help="auto or comma-separated curl_cffi impersonation labels")
    parser.add_argument("--proxy", default=cfg("CURL_CFFI_PROXY", ""))
    parser.add_argument("--retries", type=int, default=cfg_int("CURL_CFFI_RETRIES", 1, minimum=0, maximum=5))
    parser.add_argument("--retry-backoff", type=int, default=cfg_int("CURL_CFFI_RETRY_BACKOFF_MS", 250, minimum=0, maximum=5000), help="Base backoff in milliseconds")
    parser.add_argument("--accept-language", default=cfg("CURL_CFFI_ACCEPT_LANGUAGE", "it-IT,it;q=0.9,en-US;q=0.8,en;q=0.7"))
    parser.add_argument("--referer", default="")
    parser.add_argument("--warmup-origin", action="store_true", default=cfg_bool("CURL_CFFI_WARMUP_ORIGIN", True), help="Hit the origin before a deep-link request using the same session")
    parser.add_argument("--browser-headers", action="store_true", default=cfg_bool("CURL_CFFI_BROWSER_HEADERS", True), help="Add browser navigation headers when missing")
    parser.add_argument("--insecure", action="store_true", default=cfg_bool("CURL_CFFI_INSECURE", False), help="Disable TLS certificate verification")
    args = parser.parse_args()

    started = time.time()
    attempts: List[Dict[str, Any]] = []
    try:
        from curl_cffi import requests
    except Exception as exc:  # pragma: no cover - depends on runtime image
        emit({"status": "error", "message": "curl_cffi_not_available: " + str(exc)}, 1)

    method = str(args.method or "GET").upper()
    timeout_seconds = max(1.0, float(args.timeout or 15000) / 1000.0)
    retry_budget = max(0, min(5, int(args.retries or 0)))
    backoff_ms = max(0, min(5000, int(args.retry_backoff or 0)))
    proxies = build_proxies(args.proxy)
    impersonate_chain = parse_impersonate_chain(args.impersonate)
    raw_headers = parse_json_object(args.headers)

    last_error = ""
    last_payload: Optional[Dict[str, Any]] = None

    for impersonate in impersonate_chain:
        # Use a User-Agent that matches this impersonate target's TLS fingerprint.
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
                        # If the warmup itself gets a CF challenge page, the session
                        # still benefits from the TLS handshake; don't abort here.
                        attempts.append({
                            "impersonate": impersonate,
                            "retry": retry_index,
                            "warmupStatus": getattr(warm_resp, "status_code", 0),
                        })
                    except Exception as warm_exc:
                        attempts.append({"impersonate": impersonate, "retry": retry_index, "warmupError": str(warm_exc)[:240]})

                if method not in {"GET", "HEAD"} and args.data is not None:
                    request_kwargs["data"] = args.data

                response = session.request(method, args.url, **request_kwargs)
                html = response.text or ""
                response_headers = dict(response.headers or {})
                cookies = serialize_cookies(getattr(response, "cookies", None))
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
                    "ms": int((time.time() - attempt_started) * 1000),
                })

                if status not in RETRY_STATUSES and not challenge:
                    emit(payload)

                # A challenge page cannot be resolved by retrying the same
                # impersonate target — move on to the next one immediately.
                if challenge:
                    break

                if status in RETRY_STATUSES and retry_index < retry_budget:
                    sleep_for = (backoff_ms / 1000.0) * (retry_index + 1) + random.uniform(0, min(0.25, backoff_ms / 1000.0))
                    if sleep_for > 0:
                        time.sleep(sleep_for)
                    continue

                break

            except Exception as exc:
                last_error = str(exc)
                attempts.append({"impersonate": impersonate, "retry": retry_index, "error": last_error[:240], "ms": int((time.time() - attempt_started) * 1000)})
                if retry_index < retry_budget:
                    sleep_for = (backoff_ms / 1000.0) * (retry_index + 1) + random.uniform(0, min(0.25, backoff_ms / 1000.0))
                    if sleep_for > 0:
                        time.sleep(sleep_for)
                    continue
                break

    if last_payload:
        last_payload["attempts"] = attempts
        last_payload["elapsedMs"] = int((time.time() - started) * 1000)
        emit(last_payload)

    emit(
        {
            "status": "error",
            "message": last_error or "curl_cffi_no_response",
            "attempts": attempts,
            "elapsedMs": int((time.time() - started) * 1000),
        },
        1,
    )


if __name__ == "__main__":
    main()
