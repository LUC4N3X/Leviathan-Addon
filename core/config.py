from __future__ import annotations

import hashlib
import json
from typing import Any

VALID_SERVICES = {"", "realdebrid", "torbox"}
VALID_SORT_MODES = {"quality", "balanced", "ita_first", "cached", "small", "size_desc", "size_asc"}
VALID_FORMATTERS = {"torrenthan", "torrentio"}
VALID_CONTENT_LANGUAGES = {"ita", "eng"}

_SERVICE_ALIASES = {
    "": "",
    "rd": "realdebrid",
    "realdebrid": "realdebrid",
    "real-debrid": "realdebrid",
    "real_debrid": "realdebrid",
    "realdebrid": "realdebrid",
    "tb": "torbox",
    "torbox": "torbox",
    "tor-box": "torbox",
    "tor_box": "torbox",
    "p2p": "",
    "web": "",
}


def normalize_api_key(value: Any) -> str:
    return str(value or "").replace("Bearer ", "").strip()



def normalize_service_name(value: Any) -> str:
    raw = str(value or "").strip().lower()
    return _SERVICE_ALIASES.get(raw, "")



def canonical_config_dict(config: Any, *, default_rd_cache_check: int = 3) -> dict[str, Any]:
    return sanitize_decoded_config(config, default_rd_cache_check=default_rd_cache_check)



def canonical_config_json(config: Any, *, default_rd_cache_check: int = 3) -> str:
    clean = canonical_config_dict(config, default_rd_cache_check=default_rd_cache_check)
    return json.dumps(clean, sort_keys=True, separators=(",", ":"), ensure_ascii=False)



def config_identity_digest(config: Any, *, default_rd_cache_check: int = 3, prefix_length: int = 12) -> str:
    canonical = canonical_config_json(config, default_rd_cache_check=default_rd_cache_check)
    digest = hashlib.sha256(canonical.encode("utf-8")).hexdigest()
    return digest[: max(8, int(prefix_length))]



def fingerprint_secret(value: Any, *, prefix_length: int = 24) -> str:
    secret = str(value or "").strip()
    if not secret:
        return ""
    digest = hashlib.sha256(secret.encode("utf-8")).hexdigest()
    return digest[: max(8, int(prefix_length))]



def coerce_int(
    value: Any,
    default: int,
    *,
    minimum: int | None = None,
    maximum: int | None = None,
) -> int:
    try:
        parsed = int(str(value).strip())
    except (AttributeError, TypeError, ValueError):
        parsed = int(default)

    if minimum is not None:
        parsed = max(int(minimum), parsed)
    if maximum is not None:
        parsed = min(int(maximum), parsed)
    return parsed



def coerce_float(
    value: Any,
    default: float,
    *,
    minimum: float | None = None,
    maximum: float | None = None,
) -> float:
    try:
        parsed = float(str(value).strip())
    except (AttributeError, TypeError, ValueError):
        parsed = float(default)

    if minimum is not None:
        parsed = max(float(minimum), parsed)
    if maximum is not None:
        parsed = min(float(maximum), parsed)
    return parsed


def coerce_bool(value: Any, default: bool = False) -> bool:
    if isinstance(value, bool):
        return value
    if value is None:
        return default
    text = str(value).strip().lower()
    if text in {"1", "true", "yes", "on", "enabled", "enable"}:
        return True
    if text in {"0", "false", "no", "off", "disabled", "disable"}:
        return False
    return default



def normalize_csv_items(value: Any) -> list[str]:
    if not value:
        return []
    if isinstance(value, str):
        raw_items = value.split(",")
    elif isinstance(value, (list, tuple, set)):
        raw_items = list(value)
    else:
        raw_items = [value]

    normalized: list[str] = []
    seen: set[str] = set()
    for item in raw_items:
        token = str(item or "").strip().lower()
        if not token or token in seen:
            continue
        seen.add(token)
        normalized.append(token)
    return normalized



def sanitize_decoded_config(raw: Any, *, default_rd_cache_check: int = 3) -> dict[str, Any]:
    if not isinstance(raw, dict):
        return {}

    clean: dict[str, Any] = {}

    content_language = str(raw.get("language") or raw.get("lang") or raw.get("contentLanguage") or "ita").strip().lower()
    if content_language in VALID_CONTENT_LANGUAGES and content_language != "ita":
        clean["language"] = content_language

    service = normalize_service_name(raw.get("service") or raw.get("provider"))
    if service in VALID_SERVICES and service:
        clean["service"] = service

    api_key = normalize_api_key(
        raw.get("key")
        or raw.get("api")
        or raw.get("api_key")
        or raw.get("apikey")
        or raw.get("token")
        or raw.get("realdebrid")
        or raw.get("rd")
        or raw.get("torbox")
        or raw.get("tb")
    )
    if api_key:
        clean["key"] = api_key

    options = str(raw.get("options") or "").strip().strip("/")
    if options:
        clean["options"] = options[:512]

    quality_items = normalize_csv_items(raw.get("qualityfilter") or raw.get("qualityFilter") or raw.get("exc") or raw.get("exclude"))
    if quality_items:
        clean["qualityfilter"] = ",".join(quality_items)

    size_limit = coerce_float(raw.get("sizelimit") or raw.get("sizeLimit") or raw.get("maxsize") or raw.get("maxSize"), 0.0, minimum=0.0, maximum=500.0)
    if size_limit > 0:
        clean["sizelimit"] = size_limit

    formatter = str(raw.get("formatter") or raw.get("layout") or "torrenthan").strip().lower()
    if formatter in VALID_FORMATTERS and formatter != "torrenthan":
        clean["formatter"] = formatter

    sort_mode = str(raw.get("sort") or "quality").strip().lower()
    if sort_mode in VALID_SORT_MODES and sort_mode != "quality":
        clean["sort"] = sort_mode

    if coerce_bool(raw.get("jackett") or raw.get("jackettEnabled") or raw.get("jackett_enabled"), False):
        clean["jackett"] = 1

    rd_cache_check = coerce_int(
        raw.get("rdcachecheck") or raw.get("rdCacheCheck") or raw.get("rddepth") or raw.get("rdDepth"),
        default_rd_cache_check,
        minimum=0,
        maximum=10,
    )
    if rd_cache_check != default_rd_cache_check:
        clean["rdcachecheck"] = rd_cache_check

    return clean
