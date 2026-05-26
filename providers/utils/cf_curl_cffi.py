#!/usr/bin/env python3
"""
Lightweight Cloudflare-aware HTTP fetcher powered by curl_cffi.

This script is intentionally standalone: Node.js invokes it as a subprocess and
receives a single JSON object on stdout. It does not solve interactive CAPTCHA
challenges; it gives Leviathan a fast TLS/JA3/browser-impersonated first pass
before escalating to heavier browser-based fallbacks.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
from typing import Any, Dict, Iterable, List, Optional


DEFAULT_CHROME_120_UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/120.0.0.0 Safari/537.36"
)

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


def normalize_headers(headers: Dict[str, Any], *, default_user_agent: str) -> Dict[str, str]:
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
    return out


def header_get(headers: Dict[str, str], name: str) -> str:
    target = name.lower()
    for key, value in headers.items():
        if key.lower() == target:
            return value
    return ""


def serialize_cookie(cookie: Any) -> Optional[Dict[str, Any]]:
    name = getattr(cookie, "name", None) or getattr(cookie, "key", None)
    value = getattr(cookie, "value", None)
    if not name or value is None:
        return None
    item: Dict[str, Any] = {"name": str(name), "value": str(value)}
    domain = getattr(cookie, "domain", None)
    path = getattr(cookie, "path", None)
    secure = getattr(cookie, "secure", None)
    expires = getattr(cookie, "expires", None)
    if domain:
        item["domain"] = str(domain)
    if path:
        item["path"] = str(path)
    if secure is not None:
        item["secure"] = bool(secure)
    if expires is not None:
        item["expires"] = expires
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


def build_proxies(proxy: Optional[str]) -> Optional[Dict[str, str]]:
    if not proxy:
        return None
    clean = proxy.strip()
    if not clean:
        return None
    return {"http": clean, "https": clean}


def main() -> None:
    parser = argparse.ArgumentParser(description="curl_cffi browser-impersonated fetcher")
    parser.add_argument("url")
    parser.add_argument("--method", default="GET")
    parser.add_argument("--data")
    parser.add_argument("--headers")
    parser.add_argument("--timeout", type=int, default=15000, help="Timeout in milliseconds")
    parser.add_argument("--impersonate", default=os.getenv("CURL_CFFI_IMPERSONATE", "chrome120"))
    parser.add_argument("--proxy", default=os.getenv("CURL_CFFI_PROXY", ""))
    parser.add_argument("--insecure", action="store_true", help="Disable TLS certificate verification")
    args = parser.parse_args()

    started = time.time()
    try:
        from curl_cffi import requests
    except Exception as exc:  # pragma: no cover - depends on runtime image
        emit({"status": "error", "message": "curl_cffi_not_available: " + str(exc)}, 1)

    raw_headers = parse_json_object(args.headers)
    headers = normalize_headers(raw_headers, default_user_agent=DEFAULT_CHROME_120_UA)
    method = str(args.method or "GET").upper()
    timeout_seconds = max(1.0, float(args.timeout or 15000) / 1000.0)

    try:
        try:
            session = requests.Session(impersonate=args.impersonate)
            session_supports_impersonate = True
        except TypeError:
            session = requests.Session()
            session_supports_impersonate = False

        proxies = build_proxies(args.proxy)
        request_kwargs: Dict[str, Any] = {
            "headers": headers,
            "timeout": timeout_seconds,
            "allow_redirects": True,
            "verify": not bool(args.insecure),
        }
        if proxies:
            request_kwargs["proxies"] = proxies
        if not session_supports_impersonate:
            request_kwargs["impersonate"] = args.impersonate
        if method not in {"GET", "HEAD"} and args.data is not None:
            request_kwargs["data"] = args.data

        response = session.request(method, args.url, **request_kwargs)
        html = response.text or ""
        response_headers = dict(response.headers or {})
        user_agent = header_get(headers, "user-agent") or DEFAULT_CHROME_120_UA

        emit(
            {
                "status": "ok",
                "code": int(getattr(response, "status_code", 0) or 0),
                "url": str(getattr(response, "url", args.url) or args.url),
                "html": html,
                "headers": response_headers,
                "cookies": serialize_cookies(getattr(response, "cookies", None)),
                "userAgent": user_agent,
                "requestHeaders": headers,
                "impersonate": args.impersonate,
                "elapsedMs": int((time.time() - started) * 1000),
            }
        )
    except Exception as exc:
        emit(
            {
                "status": "error",
                "message": str(exc),
                "elapsedMs": int((time.time() - started) * 1000),
            },
            1,
        )


if __name__ == "__main__":
    main()
