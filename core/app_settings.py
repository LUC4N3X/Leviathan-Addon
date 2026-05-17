from __future__ import annotations

import hmac
import os
import time
from urllib.parse import urlsplit

import httpx
from fastapi import Request

from core.config import canonical_config_dict, coerce_float, coerce_int, config_identity_digest, normalize_service_name

APP_VERSION = os.getenv("APP_VERSION", "6.2.0").strip() or "6.2.0"
APP_STARTED_AT = time.time()
APP_DEBUG = os.getenv("APP_DEBUG", "0").strip().lower() in {"1", "true", "yes", "on"}
APP_MODE = "debug" if APP_DEBUG else "production"
APP_PORT = coerce_int(os.getenv("PORT") or os.getenv("APP_PORT"), 7002, minimum=1, maximum=65535)
ADMIN_TOKEN = os.getenv("ADMIN_TOKEN", "").strip()
PUBLIC_BASE_URL = os.getenv("PUBLIC_BASE_URL", "").strip().rstrip("/")
CORS_ALLOW_ALL = APP_DEBUG or os.getenv("CORS_ALLOW_ALL", "0").strip().lower() in {"1", "true", "yes", "on"}
CORS_ALLOW_ORIGIN_REGEX = None if CORS_ALLOW_ALL else (
    os.getenv("CORS_ALLOW_ORIGIN_REGEX", r"https?://(localhost|127\.0\.0\.1)(:\d+)?$").strip() or None
)

HTTP_TIMEOUT = httpx.Timeout(connect=8.0, read=20.0, write=20.0, pool=20.0)
HTTP_LIMITS = httpx.Limits(
    max_keepalive_connections=coerce_int(os.getenv("HTTP_MAX_KEEPALIVE"), 200, minimum=10, maximum=2000),
    max_connections=coerce_int(os.getenv("HTTP_MAX_CONNECTIONS"), 400, minimum=20, maximum=4000),
    keepalive_expiry=coerce_float(os.getenv("HTTP_KEEPALIVE_EXPIRY"), 45.0, minimum=1.0, maximum=300.0),
)
HTTP_DEFAULT_HEADERS = {
    "Connection": "keep-alive",
    "Accept-Encoding": "gzip, br",
}

MAX_STREAMS_RETURNED = coerce_int(os.getenv("MAX_STREAMS_RETURNED"), 20, minimum=1, maximum=100)
PLAYBACK_CACHE_TTL = coerce_int(os.getenv("PLAYBACK_CACHE_TTL"), 45, minimum=5, maximum=3600)
PLAYBACK_CACHE_MAXSIZE = coerce_int(os.getenv("PLAYBACK_CACHE_MAXSIZE"), 1024, minimum=32, maximum=20000)
RD_POLL_ATTEMPTS = coerce_int(os.getenv("RD_POLL_ATTEMPTS"), 24, minimum=1, maximum=120)
RD_POLL_INTERVAL = coerce_float(os.getenv("RD_POLL_INTERVAL"), 1.5, minimum=0.2, maximum=10.0)
TORBOX_POLL_ATTEMPTS = coerce_int(os.getenv("TORBOX_POLL_ATTEMPTS"), 10, minimum=1, maximum=60)
TORBOX_POLL_INTERVAL = coerce_float(os.getenv("TORBOX_POLL_INTERVAL"), 1.2, minimum=0.2, maximum=10.0)
PRELOAD_LIMIT = coerce_int(os.getenv("PRELOAD_TOP_LIMIT"), 1, minimum=0, maximum=10)
FALLBACK_COUNT = coerce_int(os.getenv("PLAYBACK_FALLBACK_COUNT"), 2, minimum=0, maximum=10)
DEFAULT_RD_SCAN_LIMIT = coerce_int(os.getenv("RD_SCAN_LIMIT"), 5, minimum=0, maximum=10)


def origin_from_url(url: str) -> str:
    raw_url = str(url or "").strip()
    if not raw_url:
        return ""
    parsed = urlsplit(raw_url)
    if not parsed.scheme or not parsed.netloc:
        return ""
    return f"{parsed.scheme}://{parsed.netloc}"



def build_cors_origins() -> list[str]:
    configured = [origin.strip() for origin in os.getenv("CORS_ALLOW_ORIGINS", "").split(",") if origin.strip()]
    if configured:
        return list(dict.fromkeys(configured))

    defaults = [
        "https://web.stremio.com",
        "https://app.strem.io",
        "https://strem.io",
    ]
    public_origin = origin_from_url(PUBLIC_BASE_URL)
    if public_origin:
        defaults.append(public_origin)
    return list(dict.fromkeys(defaults))


CORS_ALLOW_ORIGINS = ["*"] if CORS_ALLOW_ALL else build_cors_origins()



def is_admin_request(request: Request) -> bool:
    if APP_DEBUG:
        return True
    if not ADMIN_TOKEN:
        return False
    supplied = str(request.headers.get("x-admin-token", "") or "").strip()
    return bool(supplied) and hmac.compare_digest(supplied, ADMIN_TOKEN)



def manifest_name_for_language(content_language: str = "ita") -> str:
    normalized_language = "eng" if str(content_language or "").strip().lower() == "eng" else "ita"
    flag = "🇬🇧" if normalized_language == "eng" else "🇮🇹"
    return f"Torrenthan {flag}"



def manifest_service_badge(service: str, has_key: bool) -> str:
    normalized_service = normalize_service_name(service)
    if normalized_service == "realdebrid" and has_key:
        return " 🔱 RD"
    if normalized_service == "torbox" and has_key:
        return " 🔱 TB"
    return ""



def build_manifest(config: dict[str, object] | None = None, *, config_invalid: bool = False) -> dict[str, object]:
    clean_config = canonical_config_dict(config or {})
    content_language = str(clean_config.get("language") or "ita")
    service = normalize_service_name(clean_config.get("service"))
    has_key = bool(str(clean_config.get("key") or "").strip())

    manifest_id = "org.ita.torrenthan"
    if clean_config:
        manifest_id = f"{manifest_id}.{config_identity_digest(clean_config)}"

    if config_invalid:
        return {
            "id": manifest_id,
            "version": APP_VERSION,
            "name": f"{manifest_name_for_language(content_language)} ⚠️ Reconfigure",
            "description": (
                "La configurazione installata non è più valida o è scaduta. "
                "Reinstalla l'addon dal pannello di configurazione per evitare fallback P2P/Web."
            ),
            "logo": "https://i.ibb.co/Mkm5mJ8X/Chat-GPT-Image-20-feb-2026-20-26-45.png",
            "resources": ["stream"],
            "types": ["movie", "series", "anime"],
            "catalogs": [],
            "idPrefixes": ["tt", "kitsu"],
            "behaviorHints": {
                "configurable": True,
                "configurationRequired": True,
            },
        }

    return {
        "id": manifest_id,
        "version": APP_VERSION,
        "name": f"{manifest_name_for_language(content_language)}{manifest_service_badge(service, has_key)}",
        "description": (
            "Addon ottimizzato per stream ITA ed ENG con filtro lingua rigoroso su risultati Torrentio, "
            "probe RD lazy, fallback playback e preload controllato per RD/TorBox."
        ),
        "logo": "https://i.ibb.co/Mkm5mJ8X/Chat-GPT-Image-20-feb-2026-20-26-45.png",
        "resources": ["stream"],
        "types": ["movie", "series", "anime"],
        "catalogs": [],
        "idPrefixes": ["tt", "kitsu"],
        "behaviorHints": {
            "configurable": True,
            "configurationRequired": False,
        },
    }
