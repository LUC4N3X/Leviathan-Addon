from __future__ import annotations

import logging
import re
from typing import Any, Iterable, Sequence

import httpx

logger = logging.getLogger("torrenthan.debrid")

RD_BASE_URL = "https://api.real-debrid.com/rest/1.0/torrents/instantAvailability"
TORBOX_URL = "https://api.torbox.app/v1/api/torrents/checkcached"
RD_TIMEOUT = httpx.Timeout(connect=8.0, read=20.0, write=20.0, pool=20.0)
TORBOX_TIMEOUT = httpx.Timeout(connect=8.0, read=25.0, write=25.0, pool=25.0)
RD_BATCH_SIZE = 40
TORBOX_BATCH_SIZE = 80
VALID_HASH_RE = re.compile(r"^[a-fA-F0-9]{40}$")


def _http2_enabled() -> bool:
    try:
        import h2  
        return True
    except ImportError:
        return False


def _build_client(timeout: httpx.Timeout) -> httpx.AsyncClient:
    return httpx.AsyncClient(
        timeout=timeout,
        http2=_http2_enabled(),
        follow_redirects=True,
        headers={
            "Accept": "application/json",
            "User-Agent": "torrenthan-debrid/2.0",
        },
    )


def _sanitize_api_key(api_key: str | None) -> str:
    return str(api_key or "").replace("Bearer ", "").strip()


def _normalize_hashes(hash_list: Iterable[str]) -> list[str]:
    normalized: list[str] = []
    seen: set[str] = set()
    for raw in hash_list or []:
        value = str(raw or "").strip().lower()
        if not VALID_HASH_RE.fullmatch(value):
            continue
        if value in seen:
            continue
        seen.add(value)
        normalized.append(value)
    return normalized


def _chunks(items: Sequence[str], size: int) -> list[list[str]]:
    return [list(items[i : i + size]) for i in range(0, len(items), size)]


def _has_rd_variants(variants: Any) -> bool:
    if not variants:
        return False
    if not isinstance(variants, dict):
        return False
    rd_entry = variants.get("rd")
    if rd_entry is None:
        return False
    if isinstance(rd_entry, (list, tuple, set, dict)):
        return bool(rd_entry)
    return True


def _extract_torbox_hashes(data: Any) -> set[str]:
    found: set[str] = set()
    payload = data.get("data", []) if isinstance(data, dict) else []
    if not isinstance(payload, list):
        return found

    for item in payload:
        if isinstance(item, str):
            value = item.strip().lower()
            if VALID_HASH_RE.fullmatch(value):
                found.add(value)
            continue
        if not isinstance(item, dict):
            continue
        for key in ("hash", "infohash", "torrent_hash", "magnet_hash", "sha1"):
            value = str(item.get(key) or "").strip().lower()
            if VALID_HASH_RE.fullmatch(value):
                found.add(value)
                break
    return found


async def check_realdebrid_cache(
    hash_list: list[str],
    api_key: str,
    *,
    client: httpx.AsyncClient | None = None,
    chunk_size: int = RD_BATCH_SIZE,
) -> set[str]:
    clean_key = _sanitize_api_key(api_key)
    clean_hashes = _normalize_hashes(hash_list)
    if not clean_key or not clean_hashes:
        return set()

    headers = {"Authorization": f"Bearer {clean_key}"}
    cached_hashes: set[str] = set()
    owns_client = client is None
    client = client or _build_client(RD_TIMEOUT)

    try:
        for batch in _chunks(clean_hashes, max(1, int(chunk_size))):
            url = f"{RD_BASE_URL}/{'/'.join(batch)}"
            try:
                resp = await client.get(url, headers=headers)
                if resp.status_code != 200:
                    logger.warning("RD cache check failed (%s): %s", resp.status_code, resp.text[:300])
                    continue
                data = resp.json()
            except Exception as exc:
                logger.warning("RD cache check exception: %s", exc)
                continue

            if not isinstance(data, dict):
                continue
            for torrent_hash, variants in data.items():
                if _has_rd_variants(variants):
                    cached_hashes.add(str(torrent_hash).lower())
    finally:
        if owns_client:
            await client.aclose()

    return cached_hashes


async def check_torbox_cache(
    hash_list: list[str],
    api_key: str,
    *,
    client: httpx.AsyncClient | None = None,
    chunk_size: int = TORBOX_BATCH_SIZE,
) -> set[str]:
    clean_key = _sanitize_api_key(api_key)
    clean_hashes = _normalize_hashes(hash_list)
    if not clean_key or not clean_hashes:
        return set()

    headers = {"Authorization": f"Bearer {clean_key}"}
    cached_hashes: set[str] = set()
    owns_client = client is None
    client = client or _build_client(TORBOX_TIMEOUT)

    try:
        for batch in _chunks(clean_hashes, max(1, int(chunk_size))):
            hashes_str = ",".join(batch)
            url = f"{TORBOX_URL}?hash_list={hashes_str}&format=list"
            try:
                resp = await client.get(url, headers=headers)
            except Exception as exc:
                logger.warning("TorBox cache exception: %s", exc)
                continue

            if resp.status_code != 200:
                logger.warning("TorBox cache failed (%s): %s", resp.status_code, resp.text[:300])
                continue

            try:
                data = resp.json()
            except Exception as exc:
                logger.warning("TorBox JSON decode failed: %s", exc)
                continue

            if isinstance(data, dict) and data.get("success") is False:
                logger.warning("TorBox API error: %s", data)
                continue

            cached_hashes.update(_extract_torbox_hashes(data))
    finally:
        if owns_client:
            await client.aclose()

    return cached_hashes


async def check_multi_debrid_cache(
    hash_list: list[str],
    *,
    realdebrid_api_key: str | None = None,
    torbox_api_key: str | None = None,
) -> dict[str, set[str]]:
    rd_task = check_realdebrid_cache(hash_list, realdebrid_api_key or "")
    torbox_task = check_torbox_cache(hash_list, torbox_api_key or "")
    rd_cached, torbox_cached = await __import__("asyncio").gather(rd_task, torbox_task)
    return {
        "realdebrid": rd_cached,
        "torbox": torbox_cached,
        "any": set(rd_cached) | set(torbox_cached),
    }
