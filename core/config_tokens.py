from __future__ import annotations

import base64
import hashlib
import hmac
import json
import logging
import os
import secrets
import threading
import time
from pathlib import Path
from typing import Any

from core.cache_utils import TTLCache
from core.config import canonical_config_json, coerce_int, sanitize_decoded_config
from core.shared_state import prefixed_key, shared_backend_name, sync_get_json, sync_set_json

logger = logging.getLogger("torrenthan.config_tokens")

TOKEN_PREFIX = "cfg_"
_TOKEN_BYTES = coerce_int(os.getenv("CONFIG_TOKEN_BYTES"), 24, minimum=16, maximum=64)
_TOKEN_CACHE_TTL = coerce_int(os.getenv("CONFIG_TOKEN_CACHE_TTL"), 900, minimum=30, maximum=86400)
_TOKEN_CACHE_MAXSIZE = coerce_int(os.getenv("CONFIG_TOKEN_CACHE_MAXSIZE"), 4096, minimum=128, maximum=50000)
_TOKEN_TTL = coerce_int(os.getenv("CONFIG_TOKEN_TTL_SECONDS"), 31536000, minimum=30, maximum=315360000)
_SHARED_TOKEN_CACHE_ENABLED = os.getenv("CONFIG_TOKEN_SHARED_CACHE_ENABLED", "1").strip().lower() not in {"0", "false", "no", "off"}
_UNSIGNED_RECOVERY_ENABLED = os.getenv("CONFIG_TOKEN_UNSIGNED_RECOVERY", "0").strip().lower() in {"1", "true", "yes", "on"}

_LOCK = threading.Lock()
_TOKEN_CACHE: TTLCache[dict[str, Any]] = TTLCache(maxsize=_TOKEN_CACHE_MAXSIZE)
_TOKEN_INDEX: TTLCache[str] = TTLCache(maxsize=_TOKEN_CACHE_MAXSIZE)
_SECRET_BYTES: bytes | None = None


def _shared_token_key(token: str) -> str:
    return prefixed_key("config_token", token)


def _shared_index_key(digest: str) -> str:
    return prefixed_key("config_token_digest", digest)


def _canonical_config(config: dict[str, Any]) -> tuple[dict[str, Any], str, str]:
    clean = sanitize_decoded_config(config)
    canonical = canonical_config_json(clean)
    digest = hashlib.sha256(canonical.encode("utf-8")).hexdigest()
    return clean, canonical, digest


def _secret_file_path() -> Path:
    configured_path = str(os.getenv("CONFIG_TOKEN_SECRET_FILE", "")).strip()
    target = configured_path or "/data/config_token_secret.txt"
    return Path(target)


def _read_secret_file(path: Path) -> bytes | None:
    try:
        raw = path.read_text(encoding="utf-8").strip()
    except FileNotFoundError:
        return None
    except Exception:
        logger.warning("Config token secret file unreadable: %s", path, exc_info=True)
        return None
    if not raw:
        return None
    return raw.encode("utf-8")


def _write_secret_file(path: Path, secret_text: str) -> bytes:
    path.parent.mkdir(parents=True, exist_ok=True)
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL
    try:
        fd = os.open(str(path), flags, 0o600)
    except FileExistsError:
        existing = _read_secret_file(path)
        if existing is not None:
            return existing
        raise
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            handle.write(secret_text)
            handle.flush()
            try:
                os.fsync(handle.fileno())
            except OSError:
                pass
    except Exception:
        try:
            path.unlink(missing_ok=True)
        except Exception:
            logger.debug("Failed cleanup for config token secret file", exc_info=True)
        raise
    try:
        os.chmod(path, 0o600)
    except OSError:
        pass
    return secret_text.encode("utf-8")


def _secret() -> bytes:
    global _SECRET_BYTES
    if _SECRET_BYTES is not None:
        return _SECRET_BYTES

    configured = os.getenv("CONFIG_TOKEN_SECRET", "").strip()
    if configured:
        _SECRET_BYTES = configured.encode("utf-8")
        return _SECRET_BYTES

    path = _secret_file_path()
    file_secret = _read_secret_file(path)
    if file_secret is not None:
        _SECRET_BYTES = file_secret
        return _SECRET_BYTES

    generated = secrets.token_urlsafe(48)
    try:
        _SECRET_BYTES = _write_secret_file(path, generated)
        logger.info("Auto-generated persistent config token secret at %s", path)
        return _SECRET_BYTES
    except Exception:
        logger.warning("Config token secret file write failed, using deterministic fallback", exc_info=True)

    stable_seed = "|".join(
        part.strip()
        for part in (
            os.getenv("PUBLIC_BASE_URL", ""),
            os.getenv("HOSTNAME", ""),
            os.getenv("COMPUTERNAME", ""),
            os.getenv("ADMIN_TOKEN", ""),
            "torrenthan-config-token-v1",
        )
        if part and part.strip()
    )
    if not stable_seed:
        stable_seed = "torrenthan-config-token-v1"
    _SECRET_BYTES = hashlib.sha256(stable_seed.encode("utf-8")).digest()
    return _SECRET_BYTES


def _b64_encode(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).decode("ascii").rstrip("=")


def _b64_decode(data: str) -> bytes:
    padded = data + "=" * (-len(data) % 4)
    return base64.urlsafe_b64decode(padded.encode("ascii"))


def is_config_token(value: str) -> bool:
    return str(value or "").strip().startswith(TOKEN_PREFIX)


def _token_signature(payload_segment: str) -> str:
    digest = hmac.new(_secret(), payload_segment.encode("ascii"), hashlib.sha256).digest()
    return _b64_encode(digest)


def _resolve_payload_segment(payload_segment: str) -> tuple[dict[str, Any], int] | None:
    try:
        payload = json.loads(_b64_decode(payload_segment).decode("utf-8"))
    except Exception:
        logger.warning("Config token payload unreadable", exc_info=True)
        return None

    expires_at = int(payload.get("exp") or 0)
    if expires_at < int(time.time()):
        return None

    raw_config = payload.get("cfg")
    config = sanitize_decoded_config(raw_config)
    if not config and raw_config:
        logger.warning("Config token resolved to invalid payload")
        return None

    return dict(config), expires_at


def _shared_get_cached_config(token: str) -> dict[str, Any] | None:
    if not _SHARED_TOKEN_CACHE_ENABLED:
        return None
    cached = sync_get_json(_shared_token_key(token))
    if isinstance(cached, dict):
        clean = sanitize_decoded_config(cached)
        if clean or cached == {}:
            return clean
    return None


def _shared_get_existing_token(digest: str) -> str:
    if not _SHARED_TOKEN_CACHE_ENABLED:
        return ""
    value = sync_get_json(_shared_index_key(digest))
    return str(value or "").strip()


def _shared_store(token: str, clean: dict[str, Any], digest: str, ttl: int) -> None:
    if not _SHARED_TOKEN_CACHE_ENABLED:
        return
    try:
        sync_set_json(_shared_token_key(token), dict(clean), ttl)
        sync_set_json(_shared_index_key(digest), token, _TOKEN_TTL)
    except Exception:
        logger.debug("Shared config token cache write failed", exc_info=True)


def create_config_token(config: dict[str, Any]) -> str:
    clean, canonical, digest = _canonical_config(config)
    if not clean:
        clean = {}

    with _LOCK:
        existing_token = _TOKEN_INDEX.get(digest) or _shared_get_existing_token(digest)
        if existing_token:
            cached = resolve_config_token(existing_token)
            if cached == clean:
                return existing_token

        issued_at = int(time.time())
        payload = {
            "v": 1,
            "iat": issued_at,
            "exp": issued_at + _TOKEN_TTL,
            "cfg": json.loads(canonical or "{}"),
        }
        payload_segment = _b64_encode(json.dumps(payload, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode("utf-8"))
        signature = _token_signature(payload_segment)
        token = f"{TOKEN_PREFIX}{payload_segment}.{signature}"

        cache_ttl = min(_TOKEN_CACHE_TTL, _TOKEN_TTL)
        _TOKEN_CACHE.set(token, dict(clean), cache_ttl)
        _TOKEN_INDEX.set(digest, token, _TOKEN_TTL)
        _shared_store(token, clean, digest, cache_ttl)
        return token


def resolve_config_token_checked(token: str) -> tuple[dict[str, Any], bool]:
    """Resolve a signed config token and report whether the token itself is valid.

    A valid P2P/default installation intentionally stores an empty config ({}).
    Returning only a dict makes that case indistinguishable from a broken or expired
    token, so callers that need to block invalid tokens must use the boolean too.
    """
    normalized = str(token or "").strip()
    if not is_config_token(normalized):
        return {}, False

    cached = _TOKEN_CACHE.get(normalized)
    if cached is not None:
        return dict(cached), True

    shared_cached = _shared_get_cached_config(normalized)
    if shared_cached is not None:
        _, _, digest = _canonical_config(shared_cached)
        cache_ttl = min(_TOKEN_CACHE_TTL, _TOKEN_TTL)
        _TOKEN_CACHE.set(normalized, dict(shared_cached), cache_ttl)
        _TOKEN_INDEX.set(digest, normalized, _TOKEN_TTL)
        return dict(shared_cached), True

    try:
        payload_segment, signature = normalized[len(TOKEN_PREFIX):].rsplit(".", 1)
    except ValueError:
        return {}, False

    expected_signature = _token_signature(payload_segment)
    signature_valid = hmac.compare_digest(signature, expected_signature)
    if not signature_valid and not _UNSIGNED_RECOVERY_ENABLED:
        return {}, False

    resolved = _resolve_payload_segment(payload_segment)
    if resolved is None:
        return {}, False

    config, expires_at = resolved
    if not signature_valid:
        logger.warning("Recovered config token with changed/old signature; switch this install to the stable base64 URL")

    remaining_ttl = max(30, expires_at - int(time.time()))
    cache_ttl = max(30, min(_TOKEN_CACHE_TTL, remaining_ttl))
    _TOKEN_CACHE.set(normalized, dict(config), cache_ttl)
    _, _, digest = _canonical_config(config)
    _TOKEN_INDEX.set(digest, normalized, remaining_ttl)
    _shared_store(normalized, config, digest, cache_ttl)
    return dict(config), True


def resolve_config_token(token: str) -> dict[str, Any]:
    config, _valid = resolve_config_token_checked(token)
    return config


def is_valid_config_token(token: str) -> bool:
    _config, valid = resolve_config_token_checked(token)
    return valid


def config_token_stats() -> dict[str, Any]:
    return {
        "entries": _TOKEN_CACHE.stats()["entries"],
        "cache": _TOKEN_CACHE.stats(),
        "index": _TOKEN_INDEX.stats(),
        "ttl_seconds": _TOKEN_TTL,
        "storage": "signed-memory-cache",
        "shared_cache_enabled": int(_SHARED_TOKEN_CACHE_ENABLED),
        "unsigned_recovery_enabled": int(_UNSIGNED_RECOVERY_ENABLED),
        "shared_backend": shared_backend_name(),
    }


def reset_config_token_state() -> None:
    global _SECRET_BYTES
    with _LOCK:
        _TOKEN_CACHE.clear()
        _TOKEN_INDEX.clear()
        _SECRET_BYTES = None
