from __future__ import annotations

import asyncio
import logging
import os
from dataclasses import dataclass, field
from typing import Any

import httpx
try:
    from curl_cffi.requests import AsyncSession
except Exception:  # pragma: no cover - fallback for test/runtime environments without curl_cffi
    import httpx

    AsyncSession = httpx.AsyncClient  # type: ignore[assignment]

from core.cache_utils import TTLCache
from core.config import coerce_float, coerce_int, normalize_api_key, sanitize_decoded_config
from core.shared_state import get_json, prefixed_key, set_json, shared_backend_name
from core.stream_pipeline import extract_requested_episode, normalize_excluded_qualities, tokenized_text
from core.torrentio import (
    TorrentioCircuitOpenError,
    TorrentioError,
    TorrentioHTTPError,
    cache_stats as torrentio_runtime_stats,
    fetch_torrentio_streams,
)
from core.jackett_client import fetch_jackett_streams, is_configured as jackett_is_configured
from core.rss_ingestor import fetch_rss_streams, is_enabled as rss_is_enabled

logger = logging.getLogger("torrenthan.request_context")

TMDB_API_KEY = os.getenv("TMDB_API_KEY", "").strip()
TMDB_CACHE_TTL = coerce_int(os.getenv("TMDB_CACHE_TTL"), 3600, minimum=60, maximum=86400)
TMDB_CACHE_MAXSIZE = coerce_int(os.getenv("TMDB_CACHE_MAXSIZE"), 1024, minimum=32, maximum=10000)
TORRENTIO_CACHE_TTL = coerce_int(os.getenv("TORRENTIO_CACHE_TTL"), 25, minimum=5, maximum=3600)
TORRENTIO_CACHE_MAXSIZE = coerce_int(os.getenv("TORRENTIO_CACHE_MAXSIZE"), 512, minimum=32, maximum=10000)
TORRENTIO_ERROR_CACHE_TTL = coerce_int(os.getenv("TORRENTIO_ERROR_CACHE_TTL"), 12, minimum=2, maximum=120)
TORRENTIO_FOREGROUND_TIMEOUT = coerce_float(
    os.getenv("TORRENTIO_FOREGROUND_TIMEOUT_MS"),
    3500,
    minimum=500,
    maximum=30000,
) / 1000
EXTERNAL_SOURCE_TIMEOUT = coerce_float(
    os.getenv("TORRENTHAN_EXTERNAL_TIMEOUT_MS"),
    5500,
    minimum=750,
    maximum=30000,
) / 1000
REQUEST_SHARED_CACHE_ENABLED = os.getenv("REQUEST_SHARED_CACHE_ENABLED", "1").strip().lower() not in {"0", "false", "no", "off"}
STEALTH_TIMEOUT = coerce_float(os.getenv("STEALTH_TIMEOUT"), 20.0, minimum=2.0, maximum=120.0)
STEALTH_MAX_CLIENTS = coerce_int(os.getenv("STEALTH_MAX_CLIENTS"), 16, minimum=1, maximum=128)
RD_CACHE_CHECK_LIMIT = coerce_int(
    os.getenv("RD_SCAN_LIMIT") or os.getenv("RD_CACHE_CHECK_LIMIT"),
    5,
    minimum=0,
    maximum=10,
)

_tmdb_cache: TTLCache[tuple[str, str, str]] = TTLCache(maxsize=TMDB_CACHE_MAXSIZE)
_torrentio_cache: TTLCache[list[dict[str, Any]]] = TTLCache(maxsize=TORRENTIO_CACHE_MAXSIZE)
_torrentio_error_cache: TTLCache[str] = TTLCache(maxsize=TORRENTIO_CACHE_MAXSIZE)
_torrentio_warning_last: dict[str, float] = {}


def _consume_background_task(task: asyncio.Task[Any]) -> None:
    try:
        _ = task.exception()
    except asyncio.CancelledError:
        pass
    except Exception:
        pass


async def _await_stream_list_task(
    task: asyncio.Task[list[dict[str, Any]]],
    *,
    timeout: float,
    label: str,
) -> list[dict[str, Any]]:
    try:
        result = await asyncio.wait_for(asyncio.shield(task), timeout=timeout)
    except asyncio.TimeoutError:
        task.add_done_callback(_consume_background_task)
        logger.info("[%s] foreground timeout after %.0fms; continuo con fallback disponibili", label, timeout * 1000)
        return []
    except Exception as exc:
        logger.info("[%s] sorgente fallita: %s", label, exc)
        return []

    if not isinstance(result, list):
        return []
    return [dict(item) for item in result if isinstance(item, dict)]


async def _collect_external_sources(tasks: list[asyncio.Task[list[dict[str, Any]]]]) -> list[dict[str, Any]]:
    if not tasks:
        return []
    groups = await asyncio.gather(*tasks, return_exceptions=True)
    merged: list[dict[str, Any]] = []
    for group in groups:
        if isinstance(group, list):
            merged.extend(dict(item) for item in group if isinstance(item, dict))
        elif isinstance(group, Exception):
            logger.info("[EXTERNAL] sorgente opzionale fallita: %s", group)
    return merged



def _is_transient_torrentio_error(exc: Exception) -> bool:
    if isinstance(exc, TorrentioCircuitOpenError):
        return True
    if isinstance(exc, TorrentioHTTPError):
        return exc.status_code in {408, 409, 425, 429, 500, 502, 503, 504}
    if isinstance(exc, TorrentioError):
        return True
    return False


def _log_torrentio_fetch_problem(media_type: str, media_id: str, exc: Exception) -> None:
    now = asyncio.get_running_loop().time()
    if isinstance(exc, TorrentioCircuitOpenError):
        bucket = "circuit_open"
        level = logging.INFO
    elif isinstance(exc, TorrentioHTTPError):
        bucket = f"http_{exc.status_code}"
        level = logging.WARNING if exc.status_code in {403, 429} else logging.INFO
    else:
        bucket = type(exc).__name__
        level = logging.INFO

    last = _torrentio_warning_last.get(bucket, 0.0)
    if now - last < 20.0:
        return

    _torrentio_warning_last[bucket] = now
    stats = torrentio_runtime_stats()
    logger.log(
        level,
        "Torrentio temporaneamente non disponibile: type=%s id=%s reason=%s circuit=%s rps=%s",
        media_type,
        media_id,
        bucket,
        stats.get("circuit_state"),
        stats.get("rate_limiter_rps"),
    )

def _tmdb_locale_for_language(content_language: str) -> str:
    if str(content_language or "").strip().lower() == "eng":
        return "en-US"
    return "it-IT"


def _tmdb_shared_key(content_language: str, media_type: str, imdb_id: str) -> str:
    normalized_language = "eng" if str(content_language or "").strip().lower() == "eng" else "ita"
    return prefixed_key("tmdb_info", normalized_language, media_type, imdb_id)


def _torrentio_shared_key(media_type: str, media_id: str, options: str) -> str:
    return prefixed_key("torrentio_streams", media_type, media_id, options)


async def get_tmdb_info(
    media_type: str,
    imdb_id: str,
    client: httpx.AsyncClient,
    content_language: str = "ita",
) -> tuple[str, str, str]:
    if not TMDB_API_KEY or not imdb_id.startswith("tt"):
        return "", "", ""

    normalized_language = "eng" if str(content_language or "").strip().lower() == "eng" else "ita"
    cache_key = f"{normalized_language}:{media_type}:{imdb_id}"
    cached = _tmdb_cache.get(cache_key)
    if cached is not None:
        return cached

    if REQUEST_SHARED_CACHE_ENABLED:
        shared_cached = await get_json(_tmdb_shared_key(normalized_language, media_type, imdb_id))
        if isinstance(shared_cached, (list, tuple)) and len(shared_cached) == 3:
            result = (str(shared_cached[0] or ""), str(shared_cached[1] or ""), str(shared_cached[2] or ""))
            _tmdb_cache.set(cache_key, result, TMDB_CACHE_TTL)
            return result

    url = (
        f"https://api.themoviedb.org/3/find/{imdb_id}"
        f"?api_key={TMDB_API_KEY}&external_source=imdb_id&language={_tmdb_locale_for_language(normalized_language)}"
    )
    result = ("", "", "")
    try:
        response = await client.get(url)
        response.raise_for_status()
        data = response.json()
        results = data.get("movie_results", []) if media_type == "movie" else data.get("tv_results", [])
        results = results or []
        if results:
            item = results[0]
            title_ita = item.get("title") or item.get("name") or ""
            title_orig = item.get("original_title") or item.get("original_name") or ""
            date_str = item.get("release_date") or item.get("first_air_date") or ""
            year = date_str[:4] if date_str else ""
            result = (title_ita, title_orig, year)
    except Exception:
        logger.exception("Errore TMDB su %s", imdb_id)
    _tmdb_cache.set(cache_key, result, TMDB_CACHE_TTL)
    if REQUEST_SHARED_CACHE_ENABLED:
        await set_json(_tmdb_shared_key(normalized_language, media_type, imdb_id), list(result), TMDB_CACHE_TTL)
    return result


async def get_torrentio_streams_cached(media_type: str, media_id: str, options: str, client: AsyncSession) -> list[dict[str, Any]]:
    cache_key = f"{media_type}:{media_id}:{options}"
    cached = _torrentio_cache.get(cache_key)
    if cached is not None:
        return [dict(item) for item in cached]

    if REQUEST_SHARED_CACHE_ENABLED:
        shared_cached = await get_json(_torrentio_shared_key(media_type, media_id, options))
        if isinstance(shared_cached, list):
            restored = [dict(item) for item in shared_cached if isinstance(item, dict)]
            _torrentio_cache.set(cache_key, restored, TORRENTIO_CACHE_TTL)
            return [dict(item) for item in restored]

    if _torrentio_error_cache.get(cache_key) is not None:
        return []

    try:
        data = await fetch_torrentio_streams(media_type, media_id, options)
        streams = data.get("streams", []) or []
    except Exception as exc:
        if _is_transient_torrentio_error(exc):
            _torrentio_error_cache.set(cache_key, type(exc).__name__, TORRENTIO_ERROR_CACHE_TTL)
            _log_torrentio_fetch_problem(media_type, media_id, exc)
            return []

        logger.exception("Errore fetch Torrentio non transiente su %s/%s", media_type, media_id)
        _torrentio_error_cache.set(cache_key, type(exc).__name__, TORRENTIO_ERROR_CACHE_TTL)
        return []

    normalized_streams = [dict(item) for item in streams if isinstance(item, dict)]
    _torrentio_cache.set(cache_key, normalized_streams, TORRENTIO_CACHE_TTL)
    if REQUEST_SHARED_CACHE_ENABLED:
        await set_json(_torrentio_shared_key(media_type, media_id, options), normalized_streams, TORRENTIO_CACHE_TTL)
    return [dict(item) for item in normalized_streams]


@dataclass
class StreamRequestContext:
    type: str
    raw_id: str
    settings: dict[str, Any]
    imdb_id: str = ""
    season: int = 0
    episode: int = 0
    service: str = ""
    api_key: str = ""
    options: str = ""
    excluded_qualities: list[str] = field(default_factory=list)
    size_limit: float = 0.0
    selected_style: str = "torrenthan"
    sort_mode: str = "quality"
    content_language: str = "ita"
    preferred_title_tokens: str = ""
    raw_streams: list[dict[str, Any]] = field(default_factory=list)
    rd_cache_check_limit: int = RD_CACHE_CHECK_LIMIT
    jackett_enabled: bool = False

    @classmethod
    def from_request(cls, type_: str, raw_id: str, settings: dict[str, Any]) -> "StreamRequestContext":
        clean_settings = sanitize_decoded_config(settings, default_rd_cache_check=RD_CACHE_CHECK_LIMIT)
        imdb_id, season, episode = extract_requested_episode(type_, raw_id)
        ctx = cls(
            type=type_,
            raw_id=raw_id,
            settings=clean_settings,
            imdb_id=imdb_id,
            season=season,
            episode=episode,
            service=str(clean_settings.get("service", "") or "").lower(),
            api_key=normalize_api_key(clean_settings.get("key")),
            options=str(clean_settings.get("options", "") or ""),
            excluded_qualities=normalize_excluded_qualities(clean_settings.get("qualityfilter", "")),
            size_limit=coerce_float(clean_settings.get("sizelimit", 0), 0.0, minimum=0.0),
            selected_style=str(clean_settings.get("formatter", "torrenthan") or "torrenthan"),
            sort_mode=str(clean_settings.get("sort", "quality") or "quality").lower(),
            content_language="eng" if str(clean_settings.get("language", "ita") or "ita").lower() == "eng" else "ita",
            rd_cache_check_limit=coerce_int(
                clean_settings.get("rdcachecheck", RD_CACHE_CHECK_LIMIT),
                RD_CACHE_CHECK_LIMIT,
                minimum=0,
                maximum=10,
            ),
            jackett_enabled=bool(clean_settings.get("jackett")),
        )
        return ctx

    async def fetch(self, client: httpx.AsyncClient, stealth_client: AsyncSession) -> None:
        tmdb_task = asyncio.create_task(get_tmdb_info(self.type, self.imdb_id, client, self.content_language))
        torrentio_task = asyncio.create_task(get_torrentio_streams_cached(self.type, self.raw_id, self.options, stealth_client))
        meta_title_ita, meta_title_orig, meta_year = await tmdb_task
        self.preferred_title_tokens = tokenized_text(meta_title_ita, meta_title_orig, meta_year)

        external_tasks: list[asyncio.Task[list[dict[str, Any]]]] = []
        if self.jackett_enabled and jackett_is_configured():
            external_tasks.append(
                asyncio.create_task(
                    fetch_jackett_streams(
                        client,
                        media_type=self.type,
                        imdb_id=self.imdb_id,
                        title_tokens=self.preferred_title_tokens,
                        season=self.season,
                        episode=self.episode,
                    )
                )
            )
        if rss_is_enabled():
            external_tasks.append(asyncio.create_task(fetch_rss_streams(client, title_tokens=self.preferred_title_tokens)))

        external_task: asyncio.Task[list[dict[str, Any]]] | None = None
        if external_tasks:
            external_task = asyncio.create_task(_collect_external_sources(external_tasks))

        raw_streams = await _await_stream_list_task(
            torrentio_task,
            timeout=TORRENTIO_FOREGROUND_TIMEOUT,
            label="TORRENTIO",
        )

        external_streams: list[dict[str, Any]] = []
        if external_task is not None:
            external_streams = await _await_stream_list_task(
                external_task,
                timeout=EXTERNAL_SOURCE_TIMEOUT,
                label="EXTERNAL",
            )

        merged_streams = list(raw_streams)
        merged_streams.extend(external_streams)

        if self.jackett_enabled and not jackett_is_configured():
            logger.info("[JACKETT] abilitato da config ma TORRENTHAN_JACKETT_URL/API_KEY non configurati negli env")

        if self.jackett_enabled:
            logger.info(
                "[JACKETT] merge state enabled=%s configured=%s external=%d torrentio=%d total=%d",
                self.jackett_enabled,
                jackett_is_configured(),
                len([item for item in external_streams if str(item.get("_external_source", "")) == "jackett"]),
                len(raw_streams),
                len(merged_streams),
            )

        self.raw_streams = merged_streams



def build_stealth_client(factory: Any):
    try:
        return factory(timeout=STEALTH_TIMEOUT, max_clients=STEALTH_MAX_CLIENTS)
    except TypeError:
        return factory(timeout=STEALTH_TIMEOUT)


def cache_stats() -> dict[str, Any]:
    return {
        "tmdb": _tmdb_cache.stats(),
        "torrentio": _torrentio_cache.stats(),
        "torrentio_error": _torrentio_error_cache.stats(),
        "torrentio_runtime": torrentio_runtime_stats(),
        "shared_cache_enabled": int(REQUEST_SHARED_CACHE_ENABLED),
        "shared_backend": shared_backend_name(),
    }
