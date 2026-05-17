from __future__ import annotations

import asyncio
import logging
import os
import re
from typing import Any, Iterable, Sequence
from urllib.parse import quote

import httpx

from core.config import coerce_float, coerce_int, fingerprint_secret
from core.shared_state import get_json, get_json_many, prefixed_key, set_json, shared_backend_name

logger = logging.getLogger("torrenthan.rd")

API_URL = "https://api.real-debrid.com/rest/1.0"
REQUEST_DELAY = coerce_float(os.getenv("RD_REQUEST_DELAY"), 0.20, minimum=0.0, maximum=10.0)
DEFAULT_TIMEOUT = httpx.Timeout(connect=8.0, read=30.0, write=30.0, pool=30.0)
DEFAULT_POLL_INTERVAL = coerce_float(os.getenv("RD_POLL_INTERVAL"), 1.50, minimum=0.2, maximum=10.0)
DEFAULT_POLL_ATTEMPTS = coerce_int(os.getenv("RD_POLL_ATTEMPTS"), 24, minimum=1, maximum=120)
DEFAULT_MAX_RETRIES = coerce_int(os.getenv("RD_MAX_RETRIES"), 3, minimum=0, maximum=10)
DEFAULT_FILE_CANDIDATES = coerce_int(os.getenv("RD_FILE_CANDIDATES"), 3, minimum=1, maximum=10)
DEFAULT_CACHE_CHECK_LIMIT = 5
DEFAULT_ACTIVE_TORRENT_TTL = coerce_int(os.getenv("RD_ACTIVE_TORRENT_TTL"), 1800, minimum=60, maximum=86400)

_CACHE_PROBE_TTL_TRUE = coerce_int(os.getenv("RD_CACHE_PROBE_TTL_TRUE"), 1800, minimum=30, maximum=86400)
_CACHE_PROBE_TTL_FALSE = coerce_int(os.getenv("RD_CACHE_PROBE_TTL_FALSE"), 600, minimum=15, maximum=86400)
_CACHE_PROBE_TTL_UNKNOWN = coerce_int(os.getenv("RD_CACHE_PROBE_TTL_UNKNOWN"), 180, minimum=10, maximum=86400)
_CACHE_PROBE_ATTEMPTS = coerce_int(os.getenv("RD_CACHE_PROBE_ATTEMPTS"), 2, minimum=1, maximum=10)
_CACHE_PROBE_INTERVAL = coerce_float(os.getenv("RD_CACHE_PROBE_INTERVAL"), 0.25, minimum=0.05, maximum=5.0)
_CACHE_PROBE_CONCURRENCY = coerce_int(os.getenv("RD_CACHE_PROBE_CONCURRENCY"), 3, minimum=1, maximum=8)
_CACHE_PROBE_DELETE_CONCURRENCY = coerce_int(
    os.getenv("RD_CACHE_PROBE_DELETE_CONCURRENCY"),
    1,
    minimum=1,
    maximum=4,
)
_CACHE_PROBE_SHARED_ENABLED = os.getenv("RD_CACHE_PROBE_SHARED_ENABLED", "1").strip().lower() not in {"0", "false", "no", "off"}
_CACHE_PROBE_SHARED_TTL_TRUE = coerce_int(
    os.getenv("RD_CACHE_PROBE_SHARED_TTL_TRUE"),
    _CACHE_PROBE_TTL_TRUE,
    minimum=30,
    maximum=86400,
)
_CACHE_PROBE_SHARED_FALSE_ENABLED = os.getenv("RD_CACHE_PROBE_SHARED_FALSE_ENABLED", "0").strip().lower() in {
    "1",
    "true",
    "yes",
    "on",
}
_CACHE_PROBE_SHARED_TTL_FALSE = coerce_int(
    os.getenv("RD_CACHE_PROBE_SHARED_TTL_FALSE"),
    45,
    minimum=10,
    maximum=3600,
)

_ACTIVE_TORRENTS: dict[str, dict[str, Any]] = {}
_ACTIVE_TORRENTS_LOCK = asyncio.Lock()
_CACHE_PROBE_RESULTS: dict[str, dict[str, Any]] = {}
_CACHE_PROBE_LOCK = asyncio.Lock()
_CACHE_PROBE_SHARED_RESULTS: dict[str, dict[str, Any]] = {}
_RD_SHARED_PROBE_NAMESPACE = "rd_cache_probe"
_CACHE_PROBE_SHARED_LOCK = asyncio.Lock()
_CACHE_PROBE_INFLIGHT: dict[str, asyncio.Task[bool | None]] = {}
_CACHE_PROBE_INFLIGHT_LOCK = asyncio.Lock()
_BACKGROUND_TASKS: set[asyncio.Task[None]] = set()
_BACKGROUND_TASKS_LOCK = asyncio.Lock()
_PROBE_DELETE_SEMAPHORE = asyncio.Semaphore(_CACHE_PROBE_DELETE_CONCURRENCY)

VALID_HASH_RE = re.compile(r"^[a-fA-F0-9]{40}$")
VIDEO_EXTENSIONS = (".mkv", ".mp4", ".avi", ".mov", ".m4v", ".ts", ".m2ts", ".wmv", ".webm", ".flv")
VIDEO_EXT_RE = re.compile(r"\.(mkv|mp4|avi|mov|wmv|flv|webm|m4v|ts|m2ts)$", re.I)
JUNK_VIDEO_RE = re.compile(
    r"\b(sample|trailer|extras?|featurettes?|behind[\s._-]?the[\s._-]?scenes|interview|proof|preview)\b",
    re.I,
)
_RETRY_STATUS_CODES = frozenset({429, 500, 502, 503, 504})


class RealDebridError(RuntimeError):
    pass


class RealDebridAPIError(RealDebridError):
    def __init__(self, message: str, status_code: int | None = None, payload: Any | None = None):
        super().__init__(message)
        self.status_code = status_code
        self.payload = payload


class RealDebridResponseError(RealDebridError):
    pass


def _http2_enabled() -> bool:
    try:
        import h2  
        return True
    except ImportError:
        return False


def create_realdebrid_client(api_key: str, timeout: httpx.Timeout = DEFAULT_TIMEOUT) -> httpx.AsyncClient:
    return httpx.AsyncClient(
        timeout=timeout,
        headers=rd_headers(api_key),
        follow_redirects=True,
        http2=_http2_enabled(),
    )


def rd_headers(api_key: str) -> dict[str, str]:
    clean_key = str(api_key or "").replace("Bearer ", "").strip()
    return {
        "Authorization": f"Bearer {clean_key}",
        "Accept": "application/json",
        "User-Agent": "torrenthan-rd/4.1",
    }


async def _sleep_if_needed(delay: float | int = 0) -> None:
    actual = float(delay) if delay else REQUEST_DELAY
    if actual > 0:
        await asyncio.sleep(actual)


async def _request(
    client: httpx.AsyncClient,
    method: str,
    path: str,
    *,
    api_key: str,
    delay: float | int = 0,
    expected_statuses: Sequence[int] = (200,),
    retry_statuses: Sequence[int] = tuple(_RETRY_STATUS_CODES),
    max_retries: int = DEFAULT_MAX_RETRIES,
    **kwargs: Any,
) -> httpx.Response:
    last_error: Exception | None = None
    statuses = tuple(expected_statuses)
    retryable = set(retry_statuses)

    for attempt in range(max(0, max_retries) + 1):
        if attempt == 0:
            await _sleep_if_needed(delay)
        elif delay:
            await asyncio.sleep(min(3.0, float(delay) * (attempt + 1)))
        else:
            await asyncio.sleep(min(3.0, 0.45 * (attempt + 1)))

        headers = dict(kwargs.pop("headers", {}) or {})
        headers.update(rd_headers(api_key))

        try:
            response = await client.request(method, f"{API_URL}{path}", headers=headers, **kwargs)
        except httpx.HTTPError as exc:
            last_error = exc
            if attempt >= max_retries:
                raise RealDebridError(f"Real-Debrid {method} {path} network error") from exc
            continue

        if response.status_code in statuses:
            return response

        if response.status_code in retryable and attempt < max_retries:
            continue

        try:
            payload: Any = response.json()
        except Exception:
            payload = response.text[:400]

        raise RealDebridAPIError(
            f"Real-Debrid {method} {path} failed with status {response.status_code}",
            status_code=response.status_code,
            payload=payload,
        )

    raise RealDebridError(f"Real-Debrid {method} {path} failed") from last_error


async def _request_json(
    client: httpx.AsyncClient,
    method: str,
    path: str,
    *,
    api_key: str,
    delay: float | int = 0,
    expected_statuses: Sequence[int] = (200,),
    default: Any = None,
    **kwargs: Any,
) -> Any:
    response = await _request(
        client,
        method,
        path,
        api_key=api_key,
        delay=delay,
        expected_statuses=expected_statuses,
        **kwargs,
    )
    if response.status_code == 204 or not response.content:
        return default
    try:
        return response.json()
    except Exception as exc:
        raise RealDebridResponseError(f"Invalid JSON from Real-Debrid on {method} {path}") from exc


def normalize_hash(value: str) -> str:
    normalized = str(value or "").strip().lower()
    return normalized if VALID_HASH_RE.fullmatch(normalized) else ""


def normalize_hashes(hashes: Iterable[str]) -> list[str]:
    seen: set[str] = set()
    out: list[str] = []
    for item in hashes or []:
        normalized = normalize_hash(item)
        if normalized and normalized not in seen:
            seen.add(normalized)
            out.append(normalized)
    return out


def build_magnet_link(hash_value: str, trackers: Sequence[str] | None = None) -> str:
    normalized = normalize_hash(hash_value)
    if not normalized:
        raise ValueError("Invalid magnet hash")
    magnet = f"magnet:?xt=urn:btih:{normalized}&dn=video"
    for tracker in trackers or ():
        magnet += f"&tr={quote(str(tracker), safe='')}"
    return magnet


async def get_torrents(client: httpx.AsyncClient, api_key: str, delay: float | int = 0) -> list[dict[str, Any]]:
    data = await _request_json(client, "GET", "/torrents", api_key=api_key, delay=delay, default=[])
    return data if isinstance(data, list) else []


async def get_torrent_info(client: httpx.AsyncClient, api_key: str, torrent_id: str, delay: float | int = 0) -> dict[str, Any]:
    data = await _request_json(
        client,
        "GET",
        f"/torrents/info/{torrent_id}",
        api_key=api_key,
        delay=delay,
        default={},
    )
    return data if isinstance(data, dict) else {}


async def delete_torrent(client: httpx.AsyncClient, api_key: str, torrent_id: str, delay: float | int = 0) -> int:
    response = await _request(
        client,
        "DELETE",
        f"/torrents/delete/{torrent_id}",
        api_key=api_key,
        delay=delay,
        expected_statuses=(200, 202, 204, 404),
    )
    return response.status_code


async def add_magnet(
    client: httpx.AsyncClient,
    api_key: str,
    hash_or_magnet: str,
    *,
    trackers: Sequence[str] | None = None,
    delay: float | int = 0,
) -> dict[str, Any]:
    raw_value = str(hash_or_magnet or "").strip()
    magnet_link = raw_value if raw_value.startswith("magnet:?") else build_magnet_link(raw_value, trackers=trackers)
    data = await _request_json(
        client,
        "POST",
        "/torrents/addMagnet",
        api_key=api_key,
        delay=delay,
        data={"magnet": magnet_link, "host": "rd"},
        expected_statuses=(200, 201),
        default={},
    )
    return data if isinstance(data, dict) else {}


async def select_files(
    client: httpx.AsyncClient,
    api_key: str,
    torrent_id: str,
    file_ids: str,
    delay: float | int = 0,
) -> int:
    response = await _request(
        client,
        "POST",
        f"/torrents/selectFiles/{torrent_id}",
        api_key=api_key,
        delay=delay,
        data={"files": str(file_ids).strip()},
        expected_statuses=(200, 202, 204),
    )
    return response.status_code


async def unrestrict_link(
    client: httpx.AsyncClient,
    api_key: str,
    link: str,
    delay: float | int = 0,
) -> str | None:
    data = await _request_json(
        client,
        "POST",
        "/unrestrict/link",
        api_key=api_key,
        delay=delay,
        data={"link": link},
        expected_statuses=(200, 201),
        default={},
    )
    if not isinstance(data, dict):
        return None
    return str(data.get("download") or data.get("link") or "").strip() or None


def _cache_probe_key(
    api_key: str,
    normalized_hash: str,
    season: int = 0,
    episode: int = 0,
    file_index_hint: str | int | None = None,
) -> str:
    return "::".join((
        fingerprint_secret(api_key),
        normalized_hash,
        str(season),
        str(episode),
        str(file_index_hint or "").strip(),
    ))


def _cache_probe_shared_key(
    normalized_hash: str,
    season: int = 0,
    episode: int = 0,
    file_index_hint: str | int | None = None,
) -> str:
    return "::".join((
        normalized_hash,
        str(season),
        str(episode),
        str(file_index_hint or "").strip(),
    ))


async def _cache_probe_lookup(
    store: dict[str, dict[str, Any]],
    lock: asyncio.Lock,
    key: str,
) -> bool | None | object:
    async with lock:
        item = store.get(key)
        if not item:
            return ...
        expires_at = item.get("expires_at")
        if isinstance(expires_at, (int, float)) and expires_at < asyncio.get_running_loop().time():
            store.pop(key, None)
            return ...
        return item.get("value")


async def _cache_probe_write(
    store: dict[str, dict[str, Any]],
    lock: asyncio.Lock,
    key: str,
    value: bool | None,
    ttl: int,
) -> None:
    async with lock:
        store[key] = {
            "value": value,
            "expires_at": asyncio.get_running_loop().time() + ttl,
        }


def _shared_probe_state_key(shared_key: str) -> str:
    return prefixed_key(_RD_SHARED_PROBE_NAMESPACE, shared_key)


async def _cache_probe_get(key: str, *, shared_key: str | None = None) -> bool | None | object:
    if _CACHE_PROBE_SHARED_ENABLED and shared_key:
        shared = await _cache_probe_lookup(_CACHE_PROBE_SHARED_RESULTS, _CACHE_PROBE_SHARED_LOCK, shared_key)
        if shared is not ...:
            return shared
        shared_payload = await get_json(_shared_probe_state_key(shared_key))
        if isinstance(shared_payload, dict) and "value" in shared_payload:
            shared_value = shared_payload.get("value")
            if shared_value in {True, False, None}:
                ttl = int(shared_payload.get("ttl") or _CACHE_PROBE_SHARED_TTL_TRUE)
                await _cache_probe_write(
                    _CACHE_PROBE_SHARED_RESULTS,
                    _CACHE_PROBE_SHARED_LOCK,
                    shared_key,
                    shared_value,
                    max(10, ttl),
                )
                return shared_value
    return await _cache_probe_lookup(_CACHE_PROBE_RESULTS, _CACHE_PROBE_LOCK, key)


async def _cache_probe_set(key: str, value: bool | None, *, shared_key: str | None = None) -> None:
    if value is True:
        ttl = max(30, _CACHE_PROBE_TTL_TRUE)
    elif value is False:
        ttl = max(15, _CACHE_PROBE_TTL_FALSE)
    else:
        ttl = max(10, _CACHE_PROBE_TTL_UNKNOWN)

    await _cache_probe_write(_CACHE_PROBE_RESULTS, _CACHE_PROBE_LOCK, key, value, ttl)

    if not (_CACHE_PROBE_SHARED_ENABLED and shared_key):
        return

    shared_ttl = 0
    shared_value: bool | None | object = ...
    if value is True:
        shared_ttl = max(30, _CACHE_PROBE_SHARED_TTL_TRUE)
        shared_value = True
    elif value is False and _CACHE_PROBE_SHARED_FALSE_ENABLED:
        shared_ttl = max(10, _CACHE_PROBE_SHARED_TTL_FALSE)
        shared_value = False

    if shared_value is ...:
        return

    await _cache_probe_write(
        _CACHE_PROBE_SHARED_RESULTS,
        _CACHE_PROBE_SHARED_LOCK,
        shared_key,
        shared_value,
        shared_ttl,
    )
    await set_json(
        _shared_probe_state_key(shared_key),
        {"value": shared_value, "ttl": shared_ttl},
        shared_ttl,
    )


async def _dedupe_cache_probe(
    cache_key: str,
    resolver: Any,
) -> bool | None:
    async with _CACHE_PROBE_INFLIGHT_LOCK:
        task = _CACHE_PROBE_INFLIGHT.get(cache_key)
        if task is None or task.done():
            task = asyncio.create_task(resolver())
            _CACHE_PROBE_INFLIGHT[cache_key] = task

    try:
        return await task
    finally:
        if task.done():
            async with _CACHE_PROBE_INFLIGHT_LOCK:
                if _CACHE_PROBE_INFLIGHT.get(cache_key) is task:
                    _CACHE_PROBE_INFLIGHT.pop(cache_key, None)


def _track_background_task(task: asyncio.Task[None]) -> None:
    async def _cleanup() -> None:
        async with _BACKGROUND_TASKS_LOCK:
            _BACKGROUND_TASKS.discard(task)
        try:
            task.result()
        except asyncio.CancelledError:
            logger.debug("RD background task cancelled")
        except Exception:
            logger.debug("RD background task failed", exc_info=True)

    async def _register() -> None:
        async with _BACKGROUND_TASKS_LOCK:
            _BACKGROUND_TASKS.add(task)

    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:
        return

    loop.create_task(_register())
    task.add_done_callback(lambda finished: loop.create_task(_cleanup()))


def _schedule_probe_delete(client: httpx.AsyncClient, api_key: str, torrent_id: str) -> None:
    async def _delete_later() -> None:
        async with _PROBE_DELETE_SEMAPHORE:
            try:
                await delete_torrent(client, api_key, torrent_id, delay=0)
            except Exception:
                logger.warning("RD cache probe delete failed torrent=%s", torrent_id, exc_info=True)

    task = asyncio.create_task(_delete_later())
    _track_background_task(task)


async def shutdown_rd_tasks() -> None:
    async with _BACKGROUND_TASKS_LOCK:
        pending = [task for task in _BACKGROUND_TASKS if not task.done()]

    if not pending:
        return

    for task in pending:
        task.cancel()

    await asyncio.gather(*pending, return_exceptions=True)


def _path_of(item: dict[str, Any]) -> str:
    return str(item.get("path") or item.get("filename") or item.get("name") or item.get("short_name") or "")


def _size_of(item: dict[str, Any]) -> int:
    for key in ("bytes", "filesize", "size"):
        try:
            return int(item.get(key) or 0)
        except Exception:
            continue
    return 0


def _file_id_of(item: dict[str, Any]) -> str:
    return str(item.get("id") or "").strip()


def _clean_path(path: str) -> str:
    return str(path or "").replace("\\", "/").strip().lower()


def is_video_file_path(file_path: str) -> bool:
    return isinstance(file_path, str) and bool(VIDEO_EXT_RE.search(file_path.strip()))


def is_sample_or_junk(file_path: str) -> bool:
    if not isinstance(file_path, str):
        return True
    lower = _clean_path(file_path)
    return "sample" in lower or bool(JUNK_VIDEO_RE.search(lower))


def normalize_files(files: Sequence[dict[str, Any]] | None) -> list[dict[str, Any]]:
    if not isinstance(files, Sequence):
        return []
    out: list[dict[str, Any]] = []
    for item in files:
        if not isinstance(item, dict):
            continue
        path = _path_of(item)
        file_id = _file_id_of(item)
        if path.strip() and file_id:
            out.append(item)
    return out


def get_valid_video_files(files: Sequence[dict[str, Any]] | None) -> list[dict[str, Any]]:
    return [
        item for item in normalize_files(files)
        if is_video_file_path(_path_of(item)) and not is_sample_or_junk(_path_of(item))
    ]


def pick_best_movie_file_id(files: Sequence[dict[str, Any]] | None) -> str | None:
    candidates = get_valid_video_files(files)
    if not candidates:
        return None
    ranked: list[tuple[int, str]] = []
    for item in candidates:
        path = _clean_path(_path_of(item))
        score = _size_of(item)
        if "/extras/" in path:
            score -= 5_000_000_000_000
        if "/specials/" in path:
            score -= 5_000_000_000_000
        if "commentary" in path:
            score -= 3_000_000_000_000
        depth = len([part for part in path.split("/") if part])
        score -= depth * 1_000_000_000
        ranked.append((score, _file_id_of(item)))
    ranked.sort(reverse=True)
    return ranked[0][1] if ranked else None


def _episode_match_patterns(season: int, episode: int) -> tuple[tuple[int, re.Pattern[str]], ...]:
    s = int(season)
    e = int(episode)
    e_str = f"{e:02d}"
    compact_num = f"{s}{e_str}"
    return (
        (5, re.compile(fr"S0*{s}.*?E0*{e}\b", re.I)),
        (4, re.compile(fr"\b{s}x0*{e}\b", re.I)),
        (3, re.compile(fr"(^|\D){compact_num}(\D|$)", re.I)),
        (2, re.compile(fr"(ep|episode)[^0-9]*0*{e}\b", re.I)),
        (1, re.compile(fr"[ \-\[_]0*{e}[ \-\]_]", re.I)),
    )


def _episode_match_tier(path: str, season: int, episode: int) -> int:
    if season <= 0 or episode <= 0:
        return 0
    for tier, pattern in _episode_match_patterns(season, episode):
        if pattern.search(path):
            return tier
    return 0


def match_file_id(files: Sequence[dict[str, Any]] | None, season: int, episode: int) -> str | None:
    if season <= 0 or episode <= 0:
        return None

    video_files = get_valid_video_files(files)
    if not video_files:
        return None

    for _, pattern in _episode_match_patterns(int(season), int(episode)):
        found = next((item for item in video_files if pattern.search(_path_of(item))), None)
        if found:
            return _file_id_of(found)

    return None


def _season_episode_conflict_penalty(path: str, season: int, episode: int) -> int:
    if season <= 0 or episode <= 0:
        return 0

    penalty = 0

    for match in re.finditer(r"s(\d{1,3})[^a-z0-9]{0,3}e(\d{1,4})", path, re.I):
        found_season = int(match.group(1))
        found_episode = int(match.group(2))
        if found_season != season:
            penalty -= 8_000_000_000_000_000
        if found_episode != episode:
            penalty -= 6_000_000_000_000_000

    for match in re.finditer(r"\b(\d{1,3})x(\d{1,4})\b", path, re.I):
        found_season = int(match.group(1))
        found_episode = int(match.group(2))
        if found_season != season:
            penalty -= 8_000_000_000_000_000
        if found_episode != episode:
            penalty -= 6_000_000_000_000_000

    return penalty


def _penalty_score(path: str) -> int:
    score = 0
    if any(token in path for token in ("sample", "trailer", "promo")):
        score -= 50_000
    if any(token in path for token in ("/extras/", "/specials/", "featurette", "behind the scenes", "bonus", "commentary")):
        score -= 25_000
    if any(token in path for token in ("/subs/", "/subtitles/", ".srt", ".ass", ".ssa")):
        score -= 50_000
    return score


def rank_file_candidates(
    files: list[dict[str, Any]],
    *,
    season: int = 0,
    episode: int = 0,
    file_index_hint: str | int | None = None,
    limit: int | None = None,
) -> list[str]:
    normalized = normalize_files(files)
    if not normalized:
        return []

    valid_videos = get_valid_video_files(normalized)
    candidates = valid_videos or normalized

    hint_raw = str(file_index_hint).strip() if file_index_hint is not None else ""
    hint_value = int(hint_raw) if hint_raw.isdigit() else None
    exact_match_id = match_file_id(candidates, season, episode) if season > 0 and episode > 0 else None

    ranked: list[tuple[int, int, str]] = []
    for original_index, item in enumerate(candidates):
        file_id = _file_id_of(item)
        path = _clean_path(_path_of(item))
        size_bytes = _size_of(item)

        score = size_bytes
        score += _penalty_score(path)

        if season > 0 and episode > 0:
            match_tier = _episode_match_tier(path, season, episode)
            if file_id == exact_match_id:
                score += 20_000_000_000_000_000
            elif match_tier > 0:
                score += match_tier * 2_000_000_000_000_000
            else:
                score -= 10_000_000_000_000_000
            score += _season_episode_conflict_penalty(path, season, episode)
        else:
            if "/extras/" in path or "/specials/" in path:
                score -= 5_000_000_000_000
            if "commentary" in path:
                score -= 3_000_000_000_000
            depth = len([part for part in path.split("/") if part])
            score -= depth * 1_000_000_000

        if hint_value is not None:
            if original_index == hint_value:
                score += 28_000
            if original_index + 1 == hint_value:
                score += 22_000
            try:
                file_id_int = int(file_id)
                if file_id_int == hint_value:
                    score += 24_000
                if file_id_int == hint_value + 1:
                    score += 18_000
            except Exception:
                pass

        ranked.append((score, size_bytes, file_id))

    ranked.sort(reverse=True)
    file_ids = [file_id for _, _, file_id in ranked]
    if limit is not None and limit > 0:
        return file_ids[:limit]
    return file_ids


def select_best_file(
    files: list[dict[str, Any]],
    *,
    season: int = 0,
    episode: int = 0,
    file_index_hint: str | int | None = None,
) -> str | None:
    if season > 0 and episode > 0:
        exact_match = match_file_id(files, season, episode)
        if exact_match:
            return exact_match
        ranked = rank_file_candidates(
            files,
            season=season,
            episode=episode,
            file_index_hint=file_index_hint,
            limit=1,
        )
        return ranked[0] if ranked else None
    best_movie = pick_best_movie_file_id(files)
    if best_movie:
        return best_movie
    ranked = rank_file_candidates(files, file_index_hint=file_index_hint, limit=1)
    return ranked[0] if ranked else None


def resolve_selected_link(info: dict[str, Any], selected_file_id: str | None = None) -> str | None:
    links = [str(link).strip() for link in (info.get("links") or []) if str(link).strip()]
    if not links:
        return None
    if len(links) == 1:
        return links[0]

    files = list(info.get("files") or [])
    selected_files = [
        item for item in files
        if str(item.get("selected") or "").strip().lower() in {"1", "true"} or item.get("selected") == 1
    ]

    if selected_file_id and selected_files and len(selected_files) == len(links):
        idx = next((i for i, item in enumerate(selected_files) if str(item.get("id")) == str(selected_file_id)), -1)
        if 0 <= idx < len(links):
            return links[idx]

    return links[0]


def _active_key(api_key: str, normalized_hash: str, season: int, episode: int, file_index_hint: str | int | None) -> str:
    return "::".join((
        fingerprint_secret(api_key),
        normalized_hash,
        str(season),
        str(episode),
        str(file_index_hint or "").strip(),
    ))


async def _active_get(key: str) -> dict[str, Any] | None:
    async with _ACTIVE_TORRENTS_LOCK:
        item = _ACTIVE_TORRENTS.get(key)
        if not item:
            return None
        expires_at = item.get("expires_at")
        if isinstance(expires_at, (int, float)) and expires_at < asyncio.get_running_loop().time():
            _ACTIVE_TORRENTS.pop(key, None)
            return None
        return dict(item)


async def _active_set(key: str, torrent_id: str, selected_file_id: str | None) -> None:
    async with _ACTIVE_TORRENTS_LOCK:
        _ACTIVE_TORRENTS[key] = {
            "torrent_id": str(torrent_id or "").strip(),
            "selected_file_id": str(selected_file_id or "").strip() or None,
            "expires_at": asyncio.get_running_loop().time() + max(60, DEFAULT_ACTIVE_TORRENT_TTL),
        }


async def _active_clear(key: str, torrent_id: str | None = None) -> None:
    async with _ACTIVE_TORRENTS_LOCK:
        current = _ACTIVE_TORRENTS.get(key)
        if not current:
            return
        if torrent_id and str(current.get("torrent_id") or "").strip() != str(torrent_id or "").strip():
            return
        _ACTIVE_TORRENTS.pop(key, None)


def rd_runtime_stats() -> dict[str, int]:
    now = 0.0
    try:
        now = asyncio.get_running_loop().time()
    except RuntimeError:
        now = 0.0

    return {
        "active_torrents": sum(
            1
            for item in _ACTIVE_TORRENTS.values()
            if float(item.get("expires_at") or 0.0) > now
        ),
        "cache_probe_entries": sum(
            1
            for item in _CACHE_PROBE_RESULTS.values()
            if float(item.get("expires_at") or 0.0) > now
        ),
        "shared_cache_probe_enabled": int(_CACHE_PROBE_SHARED_ENABLED),
        "shared_cache_probe_entries": sum(
            1
            for item in _CACHE_PROBE_SHARED_RESULTS.values()
            if float(item.get("expires_at") or 0.0) > now
        ),
        "shared_cache_backend": shared_backend_name(),
        "cache_probe_inflight": sum(1 for task in _CACHE_PROBE_INFLIGHT.values() if not task.done()),
        "background_tasks": sum(1 for task in _BACKGROUND_TASKS if not task.done()),
    }


async def has_active_download(
    api_key: str,
    hash_value: str,
    *,
    season: int = 0,
    episode: int = 0,
    file_index_hint: str | int | None = None,
) -> bool:
    normalized_hash = normalize_hash(hash_value)
    if not normalized_hash:
        return False
    key = _active_key(api_key, normalized_hash, season, episode, file_index_hint)
    active = await _active_get(key)
    return bool(active and str(active.get("torrent_id") or "").strip())


async def wait_for_torrent_status(
    client: httpx.AsyncClient,
    api_key: str,
    torrent_id: str,
    *,
    wanted_statuses: set[str] | None = None,
    terminal_statuses: set[str] | None = None,
    attempts: int = DEFAULT_POLL_ATTEMPTS,
    interval: float = DEFAULT_POLL_INTERVAL,
) -> dict[str, Any]:
    wanted = {status.lower() for status in (wanted_statuses or {"downloaded"})}
    terminal = {status.lower() for status in (terminal_statuses or {"error", "dead", "virus", "magnet_error"})}
    last_info: dict[str, Any] = {}
    for attempt in range(max(1, attempts)):
        info = await get_torrent_info(client, api_key, torrent_id, delay=0)
        last_info = info
        status = str(info.get("status") or "").lower()
        if status in wanted:
            return info
        if status in terminal:
            return info
        if attempt < attempts - 1:
            await asyncio.sleep(max(0.1, interval))
    return last_info


async def _probe_single_hash_cache(
    client: httpx.AsyncClient,
    api_key: str,
    hash_value: str,
    *,
    trackers: Sequence[str] | None = None,
    season: int = 0,
    episode: int = 0,
    file_index_hint: str | int | None = None,
    attempts: int = _CACHE_PROBE_ATTEMPTS,
    interval: float = _CACHE_PROBE_INTERVAL,
) -> bool | None:
    normalized_hash = normalize_hash(hash_value)
    if not normalized_hash:
        return None

    cache_key = _cache_probe_key(api_key, normalized_hash, season, episode, file_index_hint)
    shared_key = _cache_probe_shared_key(normalized_hash, season, episode, file_index_hint)
    cached = await _cache_probe_get(cache_key, shared_key=shared_key)
    if cached is not ...:
        return cached

    async def _resolver() -> bool | None:
        torrent_id: str | None = None

        try:
            magnet_resp = await add_magnet(client, api_key, normalized_hash, trackers=trackers, delay=0)
            torrent_id = str(magnet_resp.get("id") or "").strip()
            if not torrent_id:
                await _cache_probe_set(cache_key, None, shared_key=shared_key)
                return None

            info = await get_torrent_info(client, api_key, torrent_id, delay=0)
            if not info:
                await _cache_probe_set(cache_key, None, shared_key=shared_key)
                return None

            observed = _classify_probe_info(info)
            if observed is not None:
                await _cache_probe_set(cache_key, observed, shared_key=shared_key)
                return observed

            if str(info.get("status") or "").lower() == "waiting_files_selection":
                files = list(info.get("files") or [])
                selected_file_id = select_best_file(
                    files,
                    season=season,
                    episode=episode,
                    file_index_hint=file_index_hint,
                )
                file_ids = selected_file_id or "all"
                await select_files(client, api_key, torrent_id, file_ids, delay=0)

            last_status = str(info.get("status") or "").lower()
            remaining_attempts = max(0, max(1, attempts) - 1)
            for attempt in range(remaining_attempts):
                info = await get_torrent_info(client, api_key, torrent_id, delay=0)
                last_status = str(info.get("status") or "").lower()
                observed = _classify_probe_info(info)
                if observed is not None:
                    await _cache_probe_set(cache_key, observed, shared_key=shared_key)
                    return observed
                if attempt < remaining_attempts - 1:
                    await asyncio.sleep(max(0.08, interval))

            if last_status in {"queued", "downloading", "compressing", "uploading", "waiting_files_selection", "magnet_conversion"}:
                await _cache_probe_set(cache_key, False, shared_key=shared_key)
                return False

            await _cache_probe_set(cache_key, None, shared_key=shared_key)
            return None

        except RealDebridAPIError as exc:
            logger.warning("RD cache probe API error hash=%s torrent=%s status=%s", normalized_hash, torrent_id, exc.status_code)
            await _cache_probe_set(cache_key, None, shared_key=shared_key)
            return None
        except Exception:
            logger.warning("RD cache probe failed hash=%s torrent=%s", normalized_hash, torrent_id, exc_info=True)
            await _cache_probe_set(cache_key, None, shared_key=shared_key)
            return None
        finally:
            if torrent_id:
                _schedule_probe_delete(client, api_key, torrent_id)

    dedupe_key = shared_key if _CACHE_PROBE_SHARED_ENABLED else cache_key
    return await _dedupe_cache_probe(dedupe_key, _resolver)


def _classify_probe_info(info: dict[str, Any]) -> bool | None:
    status = str(info.get("status") or "").lower()
    links = [str(link).strip() for link in (info.get("links") or []) if str(link).strip()]
    if status == "downloaded" and links:
        return True
    if status in {"error", "dead", "virus", "magnet_error"}:
        return False
    return None


async def annotate_cache_probe(
    client: httpx.AsyncClient,
    api_key: str,
    streams: list[dict[str, Any]],
    *,
    limit: int = DEFAULT_CACHE_CHECK_LIMIT,
    season: int = 0,
    episode: int = 0,
    trackers: Sequence[str] | None = None,
) -> None:
    if not api_key or not streams or limit <= 0:
        return

    checked = 0
    cached_count = 0

    for stream in streams:
        stream.setdefault("_rd_checked", False)
        stream.setdefault("_rd_cached", False)
        stream.setdefault("_cached_boost", 0)

    candidates: list[tuple[dict[str, Any], str, str | int | None]] = []
    for stream in streams:
        hash_value = normalize_hash(stream.get("_info_hash", ""))
        if not hash_value:
            continue
        if len(candidates) >= limit:
            break
        candidates.append((stream, hash_value, stream.get("fileIdx")))

    # Bulk-prime the shared probe cache via Redis MGET / SQLite batch to avoid
    # one network round-trip per hash on the hot stream-list path.
    if _CACHE_PROBE_SHARED_ENABLED and candidates:
        shared_keys: list[str] = []
        shared_key_map: dict[str, str] = {}
        for _stream, hash_value, file_index_hint in candidates:
            shared_key = _cache_probe_shared_key(hash_value, season, episode, file_index_hint)
            redis_key = _shared_probe_state_key(shared_key)
            if redis_key not in shared_key_map:
                shared_key_map[redis_key] = shared_key
                shared_keys.append(redis_key)
        try:
            bulk = await get_json_many(shared_keys)
        except Exception:
            logger.debug("RD shared probe bulk prefetch failed", exc_info=True)
            bulk = {}
        for redis_key, payload in bulk.items():
            if not isinstance(payload, dict) or "value" not in payload:
                continue
            shared_value = payload.get("value")
            if shared_value not in {True, False, None}:
                continue
            shared_key = shared_key_map.get(redis_key)
            if not shared_key:
                continue
            ttl = int(payload.get("ttl") or _CACHE_PROBE_SHARED_TTL_TRUE)
            await _cache_probe_write(
                _CACHE_PROBE_SHARED_RESULTS,
                _CACHE_PROBE_SHARED_LOCK,
                shared_key,
                shared_value,
                max(10, ttl),
            )

    semaphore = asyncio.Semaphore(_CACHE_PROBE_CONCURRENCY)

    async def _run_one(stream: dict[str, Any], hash_value: str, file_index_hint: str | int | None) -> tuple[dict[str, Any], bool | None]:
        async with semaphore:
            cached = await _probe_single_hash_cache(
                client,
                api_key,
                hash_value,
                trackers=trackers,
                season=season,
                episode=episode,
                file_index_hint=file_index_hint,
            )
            return stream, cached

    results = await asyncio.gather(*[
        _run_one(stream, hash_value, file_index_hint)
        for stream, hash_value, file_index_hint in candidates
    ], return_exceptions=False)

    for stream, cached in results:
        if cached is None:
            continue
        checked += 1
        stream["_rd_checked"] = True
        stream["_rd_cached"] = bool(cached)
        stream["_cached_boost"] = 5000 if cached else 0
        if cached:
            cached_count += 1

    if checked:
        logger.info("RD cache probe checked=%s cached=%s limit=%s", checked, cached_count, limit)


def _availability_entry(data: dict[str, Any], hash_value: str) -> Any:
    normalized = normalize_hash(hash_value)
    if not normalized:
        return None
    return data.get(normalized) or data.get(normalized.upper()) or data.get(normalized.lower())


def is_hash_cache_probe_positive(data: dict[str, Any], hash_value: str) -> bool:
    entry = _availability_entry(data, hash_value)
    if isinstance(entry, bool):
        return entry
    return False


async def _poll_selected_torrent(
    client: httpx.AsyncClient,
    api_key: str,
    normalized_hash: str,
    torrent_id: str,
    selected_file_id: str,
    *,
    poll_attempts: int,
    poll_interval: float,
) -> tuple[str | None, dict[str, Any], bool]:
    terminal_statuses = {"error", "dead", "virus", "magnet_error"}
    last_info: dict[str, Any] = {}

    for attempt in range(max(1, poll_attempts)):
        info = await get_torrent_info(client, api_key, torrent_id)
        last_info = info
        status = str(info.get("status") or "").lower()
        progress = info.get("progress")
        links = [str(link).strip() for link in (info.get("links") or []) if str(link).strip()]

        if status == "waiting_files_selection":
            try:
                await select_files(client, api_key, torrent_id, selected_file_id)
            except Exception:
                logger.warning("RD re-selectFiles failed for torrent=%s", torrent_id, exc_info=True)
            if attempt < poll_attempts - 1:
                await asyncio.sleep(max(0.1, poll_interval))
            continue

        if status == "downloaded" and links:
            chosen_link = resolve_selected_link(info, selected_file_id)
            if chosen_link:
                try:
                    final_url = await unrestrict_link(client, api_key, chosen_link)
                except Exception:
                    logger.warning(
                        "RD unrestrict failed for torrent=%s selected=%s",
                        torrent_id,
                        selected_file_id,
                        exc_info=True,
                    )
                else:
                    if final_url:
                        return final_url, last_info, False

        if status in terminal_statuses:
            logger.warning(
                "RD terminal status hash=%s torrent=%s status=%s progress=%s selected=%s",
                normalized_hash,
                torrent_id,
                status,
                progress,
                selected_file_id,
            )
            return None, last_info, False

        if attempt < poll_attempts - 1:
            await asyncio.sleep(max(0.1, poll_interval))

    logger.warning(
        "RD resolve timeout hash=%s torrent=%s status=%s progress=%s selected=%s links=%s",
        normalized_hash,
        torrent_id,
        last_info.get("status"),
        last_info.get("progress"),
        selected_file_id,
        len(last_info.get("links") or []),
    )

    status = str(last_info.get("status") or "").lower()
    keep_active = status in {"waiting_files_selection", "queued", "downloading", "compressing", "uploading", "downloaded"}
    return None, last_info, keep_active


async def resolve_download_url(
    client: httpx.AsyncClient,
    api_key: str,
    hash_value: str,
    *,
    trackers: Sequence[str] | None = None,
    season: int = 0,
    episode: int = 0,
    file_index_hint: str | int | None = None,
    poll_attempts: int = DEFAULT_POLL_ATTEMPTS,
    poll_interval: float = DEFAULT_POLL_INTERVAL,
    delete_on_finish: bool = True,
) -> str | None:
    normalized_hash = normalize_hash(hash_value)
    if not normalized_hash:
        return None

    active_key = _active_key(api_key, normalized_hash, season, episode, file_index_hint)
    candidate_limit = max(1, DEFAULT_FILE_CANDIDATES)
    tried_candidate_ids: set[str] = set()

    active = await _active_get(active_key)
    if active:
        torrent_id = str(active.get("torrent_id") or "").strip()
        selected_file_id = str(active.get("selected_file_id") or "").strip() or None
        if torrent_id:
            try:
                info = await get_torrent_info(client, api_key, torrent_id)
                files = list(info.get("files") or [])
                if not selected_file_id:
                    selected_file_id = select_best_file(
                        files,
                        season=season,
                        episode=episode,
                        file_index_hint=file_index_hint,
                    )
                    if selected_file_id:
                        await select_files(client, api_key, torrent_id, selected_file_id)
                        await _active_set(active_key, torrent_id, selected_file_id)

                if selected_file_id:
                    tried_candidate_ids.add(selected_file_id)
                    final_url, _, keep_active = await _poll_selected_torrent(
                        client,
                        api_key,
                        normalized_hash,
                        torrent_id,
                        selected_file_id,
                        poll_attempts=poll_attempts,
                        poll_interval=poll_interval,
                    )
                    if final_url:
                        await _active_clear(active_key, torrent_id)
                        if delete_on_finish:
                            try:
                                await delete_torrent(client, api_key, torrent_id)
                            except Exception:
                                logger.warning("RD delete torrent failed torrent=%s", torrent_id, exc_info=True)
                        return final_url
                    if keep_active:
                        return None

                await _active_clear(active_key, torrent_id)
                if delete_on_finish:
                    try:
                        await delete_torrent(client, api_key, torrent_id)
                    except Exception:
                        logger.warning("RD delete torrent failed torrent=%s", torrent_id, exc_info=True)
            except RealDebridAPIError as exc:
                if exc.status_code == 404:
                    await _active_clear(active_key, torrent_id)
                else:
                    logger.warning("RD active torrent reuse failed torrent=%s", torrent_id, exc_info=True)
            except Exception:
                logger.warning("RD active torrent reuse failed torrent=%s", torrent_id, exc_info=True)

    for attempt_index in range(candidate_limit):
        torrent_id: str | None = None
        selected_file_id: str | None = None

        try:
            magnet_resp = await add_magnet(client, api_key, normalized_hash, trackers=trackers)
            torrent_id = str(magnet_resp.get("id") or "").strip()
            if not torrent_id:
                logger.warning("RD addMagnet returned no torrent id for hash=%s", normalized_hash)
                return None

            info = await get_torrent_info(client, api_key, torrent_id)
            files = list(info.get("files") or [])
            candidate_ids = rank_file_candidates(
                files,
                season=season,
                episode=episode,
                file_index_hint=file_index_hint,
                limit=candidate_limit,
            )

            candidate_pool = [candidate_id for candidate_id in candidate_ids if candidate_id not in tried_candidate_ids]
            if not candidate_pool and candidate_ids:
                candidate_pool = candidate_ids[:]
            if not candidate_pool:
                fallback_id = select_best_file(
                    files,
                    season=season,
                    episode=episode,
                    file_index_hint=file_index_hint,
                )
                if fallback_id:
                    candidate_pool = [fallback_id]

            if not candidate_pool:
                logger.warning("RD no selectable file for hash=%s torrent=%s", normalized_hash, torrent_id)
                await _active_clear(active_key, torrent_id)
                if delete_on_finish:
                    try:
                        await delete_torrent(client, api_key, torrent_id)
                    except Exception:
                        logger.warning("RD delete torrent failed torrent=%s", torrent_id, exc_info=True)
                return None

            selected_file_id = candidate_pool[0]
            tried_candidate_ids.add(selected_file_id)

            await select_files(client, api_key, torrent_id, selected_file_id)
            await _active_set(active_key, torrent_id, selected_file_id)

            final_url, _, keep_active = await _poll_selected_torrent(
                client,
                api_key,
                normalized_hash,
                torrent_id,
                selected_file_id,
                poll_attempts=poll_attempts,
                poll_interval=poll_interval,
            )
            if final_url:
                await _active_clear(active_key, torrent_id)
                if delete_on_finish:
                    try:
                        await delete_torrent(client, api_key, torrent_id)
                    except Exception:
                        logger.warning("RD delete torrent failed torrent=%s", torrent_id, exc_info=True)
                return final_url

            if keep_active:
                return None

            await _active_clear(active_key, torrent_id)
            if delete_on_finish:
                try:
                    await delete_torrent(client, api_key, torrent_id)
                except Exception:
                    logger.warning("RD delete torrent failed torrent=%s", torrent_id, exc_info=True)

        except RealDebridAPIError:
            logger.warning(
                "RD API error hash=%s torrent=%s selected=%s",
                normalized_hash,
                torrent_id,
                selected_file_id,
                exc_info=True,
            )
            if torrent_id:
                await _active_clear(active_key, torrent_id)
                if delete_on_finish:
                    try:
                        await delete_torrent(client, api_key, torrent_id)
                    except Exception:
                        logger.warning("RD delete torrent failed torrent=%s", torrent_id, exc_info=True)
        except Exception:
            logger.exception("RD resolve error hash=%s torrent=%s", normalized_hash, torrent_id)
            if torrent_id:
                await _active_clear(active_key, torrent_id)
                if delete_on_finish:
                    try:
                        await delete_torrent(client, api_key, torrent_id)
                    except Exception:
                        logger.warning("RD delete torrent failed torrent=%s", torrent_id, exc_info=True)

        if attempt_index >= candidate_limit - 1:
            break

    return None


__all__ = [
    "API_URL",
    "DEFAULT_CACHE_CHECK_LIMIT",
    "DEFAULT_POLL_ATTEMPTS",
    "DEFAULT_POLL_INTERVAL",
    "RealDebridAPIError",
    "RealDebridError",
    "RealDebridResponseError",
    "VIDEO_EXTENSIONS",
    "add_magnet",
    "annotate_cache_probe",
    "build_magnet_link",
    "create_realdebrid_client",
    "delete_torrent",
    "get_torrent_info",
    "get_torrents",
    "has_active_download",
    "is_hash_cache_probe_positive",
    "normalize_hash",
    "normalize_hashes",
    "pick_best_movie_file_id",
    "rank_file_candidates",
    "rd_headers",
    "rd_runtime_stats",
    "resolve_download_url",
    "resolve_selected_link",
    "select_best_file",
    "select_files",
    "shutdown_rd_tasks",
    "unrestrict_link",
    "wait_for_torrent_status",
]
