from __future__ import annotations

import asyncio
import hashlib
import os
from typing import Any, Awaitable, Callable
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

from core.cache_utils import TTLCache
from core.config import coerce_int

_FALLBACK_TTL = coerce_int(os.getenv("PLAYBACK_FALLBACK_TTL"), 900, minimum=30, maximum=86400)
_STORE: TTLCache[list[dict[str, str]]] = TTLCache(maxsize=4096)
_LOCK = asyncio.Lock()


async def _store_list(items: list[dict[str, str]]) -> str:
    joined = "|".join(f"{item.get('hash','')}::{item.get('file_index','')}" for item in items)
    key = hashlib.sha1(joined.encode("utf-8")).hexdigest()
    async with _LOCK:
        _STORE.set(key, items, _FALLBACK_TTL)
    return key


async def _get_list(key: str) -> list[dict[str, str]]:
    async with _LOCK:
        item = _STORE.get(key)
        return list(item or [])


def _append_param(url: str, key: str, value: str) -> str:
    parts = urlsplit(url)
    query = dict(parse_qsl(parts.query, keep_blank_values=True))
    query[key] = value
    return urlunsplit((parts.scheme, parts.netloc, parts.path, urlencode(query, doseq=True), parts.fragment))


async def attach_fallback_tokens(streams: list[dict[str, Any]], *, fallback_count: int = 2) -> None:
    eligible: list[dict[str, str]] = []
    stream_refs: list[dict[str, Any]] = []
    for stream in streams:
        playback_hash = str(stream.get("_playback_hash") or "").strip().lower()
        file_index = str(stream.get("_playback_file_index") or "none").strip()
        url = str(stream.get("url") or "").strip()
        if playback_hash and url:
            eligible.append({"hash": playback_hash, "file_index": file_index})
            stream_refs.append(stream)

    if len(eligible) < 2 or fallback_count <= 0:
        return

    key = await _store_list(eligible)
    for index, stream in enumerate(stream_refs):
        upcoming = eligible[index + 1:index + 1 + fallback_count]
        if not upcoming:
            continue
        token = f"{index}:::{fallback_count}:::{key}"
        stream["url"] = _append_param(str(stream["url"]), "fbk", token)


async def get_fallback_candidates(token: str) -> list[dict[str, str]]:
    parts = token.split(":::")
    if len(parts) != 3:
        return []
    try:
        index = int(parts[0])
        count = int(parts[1])
    except ValueError:
        return []
    key = parts[2].strip()
    if not key or count <= 0:
        return []
    entries = await _get_list(key)
    if not entries:
        return []
    return entries[index + 1:index + 1 + count]


async def resolve_with_fallbacks(
    token: str,
    resolver: Callable[[str, str], Awaitable[str | None]],
) -> tuple[str | None, dict[str, str] | None]:
    candidates = await get_fallback_candidates(token)
    for item in candidates:
        hash_value = str(item.get("hash") or "").strip().lower()
        file_index = str(item.get("file_index") or "none").strip()
        if not hash_value:
            continue
        final_url = await resolver(hash_value, file_index)
        if final_url:
            return final_url, item
    return None, None


def strip_fallback_helpers(stream: dict[str, Any]) -> dict[str, Any]:
    return {
        key: value
        for key, value in stream.items()
        if not key.startswith("_playback_")
    }


def fallback_store_stats() -> dict[str, int]:
    return _STORE.stats()
