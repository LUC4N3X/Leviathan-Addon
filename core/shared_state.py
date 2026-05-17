from __future__ import annotations

import asyncio
import json
import logging
import os
import sqlite3
import threading
import time
from pathlib import Path
from typing import Any

from core.config import coerce_float, coerce_int

logger = logging.getLogger("torrenthan.shared_state")

REDIS_URL = os.getenv("REDIS_URL", "").strip()
REDIS_PREFIX = os.getenv("REDIS_PREFIX", "torrenthan").strip() or "torrenthan"
REDIS_CONNECT_TIMEOUT = coerce_float(os.getenv("REDIS_CONNECT_TIMEOUT"), 1.5, minimum=0.1, maximum=30.0)
REDIS_SOCKET_TIMEOUT = coerce_float(os.getenv("REDIS_SOCKET_TIMEOUT"), 2.0, minimum=0.1, maximum=30.0)

SQLITE_STATE_ENABLED = os.getenv("SQLITE_STATE_ENABLED", "1").strip().lower() not in {"0", "false", "no", "off"}
SQLITE_STATE_PATH = os.getenv("SQLITE_STATE_PATH", "/data/torrenthan_state.db").strip() or "/data/torrenthan_state.db"
SQLITE_BUSY_TIMEOUT_MS = coerce_int(os.getenv("SQLITE_BUSY_TIMEOUT_MS"), 5000, minimum=100, maximum=60000)
SQLITE_PURGE_INTERVAL_SECONDS = coerce_int(os.getenv("SQLITE_PURGE_INTERVAL_SECONDS"), 60, minimum=5, maximum=3600)

_REDIS_CLIENT = None
_REDIS_IMPORT_ERROR: str | None = None
_REDIS_DISABLED_LOGGED = False
_SQLITE_CONN: sqlite3.Connection | None = None
_SQLITE_LOCK = threading.RLock()
_SQLITE_LAST_PURGE = 0.0
_SQLITE_ERROR_LOGGED = False


def _redis_module():
    global _REDIS_IMPORT_ERROR
    try:
        import redis.asyncio as redis  # type: ignore
        return redis
    except Exception as exc:  # pragma: no cover
        _REDIS_IMPORT_ERROR = str(exc)
        return None


def redis_enabled() -> bool:
    return bool(REDIS_URL)


def sqlite_enabled() -> bool:
    return (not REDIS_URL) and SQLITE_STATE_ENABLED


def shared_backend_name() -> str:
    if REDIS_URL:
        return "redis"
    if SQLITE_STATE_ENABLED:
        return "sqlite"
    return "memory"


def _sqlite_path() -> Path:
    return Path(SQLITE_STATE_PATH)


def _sqlite_available() -> bool:
    return sqlite_enabled()


def _sqlite_connect() -> sqlite3.Connection | None:
    global _SQLITE_CONN, _SQLITE_ERROR_LOGGED
    if not _sqlite_available():
        return None
    if _SQLITE_CONN is not None:
        return _SQLITE_CONN
    with _SQLITE_LOCK:
        if _SQLITE_CONN is not None:
            return _SQLITE_CONN
        try:
            path = _sqlite_path()
            path.parent.mkdir(parents=True, exist_ok=True)
            conn = sqlite3.connect(str(path), check_same_thread=False, isolation_level=None)
            conn.execute(f"PRAGMA busy_timeout={int(SQLITE_BUSY_TIMEOUT_MS)}")
            conn.execute("PRAGMA journal_mode=WAL")
            conn.execute("PRAGMA synchronous=NORMAL")
            conn.execute("PRAGMA temp_store=MEMORY")
            conn.execute("CREATE TABLE IF NOT EXISTS kv_store (key TEXT PRIMARY KEY, value TEXT NOT NULL, expires_at INTEGER NOT NULL)")
            conn.execute("CREATE TABLE IF NOT EXISTS set_store (set_key TEXT NOT NULL, member TEXT NOT NULL, expires_at INTEGER NOT NULL, PRIMARY KEY (set_key, member))")
            conn.execute("CREATE INDEX IF NOT EXISTS idx_kv_expires_at ON kv_store(expires_at)")
            conn.execute("CREATE INDEX IF NOT EXISTS idx_set_expires_at ON set_store(expires_at)")
            _SQLITE_CONN = conn
            return _SQLITE_CONN
        except Exception as exc:  # pragma: no cover
            if not _SQLITE_ERROR_LOGGED:
                logger.warning("SQLite shared state unavailable, falling back to memory-only mode: %s", exc)
                _SQLITE_ERROR_LOGGED = True
            return None


def _sqlite_purge_expired(conn: sqlite3.Connection) -> None:
    global _SQLITE_LAST_PURGE
    now = time.time()
    if now - _SQLITE_LAST_PURGE < SQLITE_PURGE_INTERVAL_SECONDS:
        return
    _SQLITE_LAST_PURGE = now
    ts = int(now)
    conn.execute("DELETE FROM kv_store WHERE expires_at <= ?", (ts,))
    conn.execute("DELETE FROM set_store WHERE expires_at <= ?", (ts,))


def _sqlite_get_json_sync(key: str) -> Any | None:
    conn = _sqlite_connect()
    if conn is None:
        return None
    now_ts = int(time.time())
    with _SQLITE_LOCK:
        _sqlite_purge_expired(conn)
        row = conn.execute("SELECT value, expires_at FROM kv_store WHERE key = ?", (key,)).fetchone()
        if not row:
            return None
        raw, expires_at = row
        if int(expires_at or 0) <= now_ts:
            conn.execute("DELETE FROM kv_store WHERE key = ?", (key,))
            return None
    try:
        return json.loads(raw)
    except Exception:
        logger.debug("SQLite JSON decode failed for %s", key, exc_info=True)
        return None


def _sqlite_set_json_sync(key: str, value: Any, ttl: int | float) -> bool:
    conn = _sqlite_connect()
    if conn is None:
        return False
    try:
        expires_at = int(time.time() + max(1, int(float(ttl))))
        payload = json.dumps(value, separators=(",", ":"), ensure_ascii=False)
        with _SQLITE_LOCK:
            _sqlite_purge_expired(conn)
            conn.execute(
                "INSERT INTO kv_store(key, value, expires_at) VALUES(?, ?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, expires_at=excluded.expires_at",
                (key, payload, expires_at),
            )
        return True
    except Exception:
        logger.debug("SQLite SET failed for %s", key, exc_info=True)
        return False


def _sqlite_delete_sync(key: str) -> bool:
    conn = _sqlite_connect()
    if conn is None:
        return False
    try:
        with _SQLITE_LOCK:
            conn.execute("DELETE FROM kv_store WHERE key = ?", (key,))
            conn.execute("DELETE FROM set_store WHERE set_key = ?", (key,))
        return True
    except Exception:
        logger.debug("SQLite delete failed for %s", key, exc_info=True)
        return False


def _sqlite_set_member_sync(key: str, value: str, ttl: int | float) -> bool:
    conn = _sqlite_connect()
    if conn is None:
        return False
    try:
        expires_at = int(time.time() + max(1, int(float(ttl))))
        with _SQLITE_LOCK:
            _sqlite_purge_expired(conn)
            conn.execute(
                "INSERT INTO set_store(set_key, member, expires_at) VALUES(?, ?, ?) ON CONFLICT(set_key, member) DO UPDATE SET expires_at=excluded.expires_at",
                (key, value, expires_at),
            )
        return True
    except Exception:
        logger.debug("SQLite SADD failed for %s", key, exc_info=True)
        return False


def _sqlite_is_set_member_sync(key: str, value: str) -> bool:
    conn = _sqlite_connect()
    if conn is None:
        return False
    now_ts = int(time.time())
    try:
        with _SQLITE_LOCK:
            _sqlite_purge_expired(conn)
            row = conn.execute("SELECT expires_at FROM set_store WHERE set_key = ? AND member = ?", (key, value)).fetchone()
            if not row:
                return False
            expires_at = int(row[0] or 0)
            if expires_at <= now_ts:
                conn.execute("DELETE FROM set_store WHERE set_key = ? AND member = ?", (key, value))
                return False
            return True
    except Exception:
        logger.debug("SQLite SISMEMBER failed for %s", key, exc_info=True)
        return False


def _sqlite_set_remove_sync(key: str, value: str) -> bool:
    conn = _sqlite_connect()
    if conn is None:
        return False
    try:
        with _SQLITE_LOCK:
            conn.execute("DELETE FROM set_store WHERE set_key = ? AND member = ?", (key, value))
        return True
    except Exception:
        logger.debug("SQLite SREM failed for %s", key, exc_info=True)
        return False


def _sqlite_scard_sync(key: str) -> int | None:
    conn = _sqlite_connect()
    if conn is None:
        return None
    now_ts = int(time.time())
    try:
        with _SQLITE_LOCK:
            _sqlite_purge_expired(conn)
            row = conn.execute("SELECT COUNT(*) FROM set_store WHERE set_key = ? AND expires_at > ?", (key, now_ts)).fetchone()
            return int(row[0] if row else 0)
    except Exception:
        logger.debug("SQLite SCARD failed for %s", key, exc_info=True)
        return None


def prefixed_key(namespace: str, *parts: Any) -> str:
    normalized_parts = [str(part or "").strip() for part in parts if str(part or "").strip()]
    joined = ":".join(normalized_parts)
    if joined:
        return f"{REDIS_PREFIX}:{namespace}:{joined}"
    return f"{REDIS_PREFIX}:{namespace}"


async def get_redis_client():
    global _REDIS_CLIENT, _REDIS_DISABLED_LOGGED
    if not REDIS_URL:
        return None
    if _REDIS_CLIENT is not None:
        return _REDIS_CLIENT

    redis = _redis_module()
    if redis is None:
        if not _REDIS_DISABLED_LOGGED:
            logger.warning("Redis requested but redis package is unavailable: %s", _REDIS_IMPORT_ERROR)
            _REDIS_DISABLED_LOGGED = True
        return None

    try:
        client = redis.from_url(
            REDIS_URL,
            encoding="utf-8",
            decode_responses=True,
            socket_connect_timeout=REDIS_CONNECT_TIMEOUT,
            socket_timeout=REDIS_SOCKET_TIMEOUT,
            health_check_interval=30,
        )
        await client.ping()
        _REDIS_CLIENT = client
        return _REDIS_CLIENT
    except Exception as exc:  # pragma: no cover
        if not _REDIS_DISABLED_LOGGED:
            logger.warning("Redis unavailable, continuing with SQLite/in-memory fallback: %s", exc)
            _REDIS_DISABLED_LOGGED = True
        return None


def sync_get_json(key: str) -> Any | None:
    return _sqlite_get_json_sync(key)


def sync_set_json(key: str, value: Any, ttl: int | float) -> bool:
    return _sqlite_set_json_sync(key, value, ttl)


def sync_delete(key: str) -> bool:
    return _sqlite_delete_sync(key)


def sync_set_member(key: str, value: str, ttl: int | float) -> bool:
    return _sqlite_set_member_sync(key, value, ttl)


def sync_is_set_member(key: str, value: str) -> bool:
    return _sqlite_is_set_member_sync(key, value)


def sync_set_remove(key: str, value: str) -> bool:
    return _sqlite_set_remove_sync(key, value)


def sync_scard(key: str) -> int | None:
    return _sqlite_scard_sync(key)


def _sqlite_get_json_many_sync(keys: list[str]) -> dict[str, Any]:
    conn = _sqlite_connect()
    if conn is None or not keys:
        return {}
    now_ts = int(time.time())
    out: dict[str, Any] = {}
    with _SQLITE_LOCK:
        _sqlite_purge_expired(conn)
        placeholders = ",".join("?" for _ in keys)
        rows = conn.execute(
            f"SELECT key, value, expires_at FROM kv_store WHERE key IN ({placeholders})",
            keys,
        ).fetchall()
        expired_keys: list[str] = []
        for key, raw, expires_at in rows:
            if int(expires_at or 0) <= now_ts:
                expired_keys.append(key)
                continue
            try:
                out[key] = json.loads(raw)
            except Exception:
                logger.debug("SQLite JSON decode failed for %s", key, exc_info=True)
        if expired_keys:
            placeholders_del = ",".join("?" for _ in expired_keys)
            conn.execute(f"DELETE FROM kv_store WHERE key IN ({placeholders_del})", expired_keys)
    return out


def _sqlite_set_json_many_sync(items: list[tuple[str, Any, int | float]]) -> bool:
    conn = _sqlite_connect()
    if conn is None or not items:
        return False
    try:
        now = time.time()
        prepared = [
            (
                key,
                json.dumps(value, separators=(",", ":"), ensure_ascii=False),
                int(now + max(1, int(float(ttl)))),
            )
            for key, value, ttl in items
        ]
        with _SQLITE_LOCK:
            _sqlite_purge_expired(conn)
            conn.executemany(
                "INSERT INTO kv_store(key, value, expires_at) VALUES(?, ?, ?) "
                "ON CONFLICT(key) DO UPDATE SET value=excluded.value, expires_at=excluded.expires_at",
                prepared,
            )
        return True
    except Exception:
        logger.debug("SQLite MSET failed", exc_info=True)
        return False


async def get_json_many(keys: list[str]) -> dict[str, Any]:
    """Bulk JSON read. Returns a dict mapping only the keys that exist."""
    if not keys:
        return {}
    deduped = list(dict.fromkeys(keys))
    client = await get_redis_client()
    if client is not None:
        try:
            raw_values = await client.mget(deduped)
        except Exception as exc:  # pragma: no cover
            logger.debug("Redis MGET failed (count=%s): %s", len(deduped), exc)
        else:
            out: dict[str, Any] = {}
            for key, raw in zip(deduped, raw_values):
                if not raw:
                    continue
                try:
                    out[key] = json.loads(raw)
                except Exception:
                    logger.debug("Redis JSON decode failed for %s", key, exc_info=True)
            return out
    return await asyncio.to_thread(_sqlite_get_json_many_sync, deduped)


async def set_json_many(items: list[tuple[str, Any, int | float]]) -> bool:
    """Bulk JSON write. Uses Redis pipeline or SQLite executemany."""
    if not items:
        return True
    client = await get_redis_client()
    if client is not None:
        try:
            async with client.pipeline(transaction=False) as pipe:
                for key, value, ttl in items:
                    ttl_seconds = max(1, int(float(ttl)))
                    pipe.set(
                        key,
                        json.dumps(value, separators=(",", ":"), ensure_ascii=False),
                        ex=ttl_seconds,
                    )
                await pipe.execute()
            return True
        except Exception as exc:  # pragma: no cover
            logger.debug("Redis MSET pipeline failed (count=%s): %s", len(items), exc)
    return await asyncio.to_thread(_sqlite_set_json_many_sync, list(items))


async def get_json(key: str) -> Any | None:
    client = await get_redis_client()
    if client is not None:
        try:
            raw = await client.get(key)
        except Exception as exc:  # pragma: no cover
            logger.debug("Redis GET failed for %s: %s", key, exc)
        else:
            if not raw:
                return None
            try:
                return json.loads(raw)
            except Exception:
                logger.debug("Redis JSON decode failed for %s", key, exc_info=True)
                return None
    return await asyncio.to_thread(_sqlite_get_json_sync, key)


async def set_json(key: str, value: Any, ttl: int | float) -> bool:
    client = await get_redis_client()
    if client is not None:
        try:
            ttl_seconds = max(1, int(float(ttl)))
            await client.set(key, json.dumps(value, separators=(",", ":"), ensure_ascii=False), ex=ttl_seconds)
            return True
        except Exception as exc:  # pragma: no cover
            logger.debug("Redis SET failed for %s: %s", key, exc)
    return await asyncio.to_thread(_sqlite_set_json_sync, key, value, ttl)


async def delete(key: str) -> bool:
    client = await get_redis_client()
    if client is not None:
        try:
            await client.delete(key)
            return True
        except Exception as exc:  # pragma: no cover
            logger.debug("Redis DEL failed for %s: %s", key, exc)
    return await asyncio.to_thread(_sqlite_delete_sync, key)


async def set_member(key: str, value: str, ttl: int | float) -> bool:
    client = await get_redis_client()
    if client is not None:
        try:
            ttl_seconds = max(1, int(float(ttl)))
            async with client.pipeline(transaction=True) as pipe:
                pipe.sadd(key, value)
                pipe.expire(key, ttl_seconds)
                await pipe.execute()
            return True
        except Exception as exc:  # pragma: no cover
            logger.debug("Redis SADD failed for %s: %s", key, exc)
    return await asyncio.to_thread(_sqlite_set_member_sync, key, value, ttl)


async def is_set_member(key: str, value: str) -> bool:
    client = await get_redis_client()
    if client is not None:
        try:
            return bool(await client.sismember(key, value))
        except Exception as exc:  # pragma: no cover
            logger.debug("Redis SISMEMBER failed for %s: %s", key, exc)
    return await asyncio.to_thread(_sqlite_is_set_member_sync, key, value)


async def set_remove(key: str, value: str) -> bool:
    client = await get_redis_client()
    if client is not None:
        try:
            await client.srem(key, value)
            return True
        except Exception as exc:  # pragma: no cover
            logger.debug("Redis SREM failed for %s: %s", key, exc)
    return await asyncio.to_thread(_sqlite_set_remove_sync, key, value)


async def scard(key: str) -> int | None:
    client = await get_redis_client()
    if client is not None:
        try:
            return int(await client.scard(key))
        except Exception as exc:  # pragma: no cover
            logger.debug("Redis SCARD failed for %s: %s", key, exc)
    return await asyncio.to_thread(_sqlite_scard_sync, key)


async def close_redis_client() -> None:
    global _REDIS_CLIENT, _SQLITE_CONN
    if _REDIS_CLIENT is not None:
        try:
            await _REDIS_CLIENT.aclose()
        except Exception:
            logger.debug("Redis close failed", exc_info=True)
        finally:
            _REDIS_CLIENT = None
    if _SQLITE_CONN is not None:
        try:
            with _SQLITE_LOCK:
                _SQLITE_CONN.close()
        except Exception:
            logger.debug("SQLite close failed", exc_info=True)
        finally:
            _SQLITE_CONN = None


async def shared_state_status() -> dict[str, Any]:
    client = await get_redis_client()
    sqlite_conn = await asyncio.to_thread(_sqlite_connect)
    return {
        "backend": shared_backend_name(),
        "redis_enabled": int(bool(REDIS_URL)),
        "redis_connected": int(client is not None),
        "sqlite_enabled": int(SQLITE_STATE_ENABLED),
        "sqlite_connected": int(sqlite_conn is not None),
        "sqlite_path": SQLITE_STATE_PATH if SQLITE_STATE_ENABLED else "",
        "prefix": REDIS_PREFIX,
        "import_error": _REDIS_IMPORT_ERROR or "",
    }
