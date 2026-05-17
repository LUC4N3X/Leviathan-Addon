from __future__ import annotations

import asyncio
import logging
import os
from typing import Any

import httpx

from core.app_settings import TORBOX_POLL_ATTEMPTS, TORBOX_POLL_INTERVAL
from core.config import coerce_int
from core.rd import build_magnet_link, rank_file_candidates, select_best_file
from core.stream_pipeline import TRACKERS

logger = logging.getLogger("torrenthan.torbox")
TORBOX_API_BASE = "https://api.torbox.app/v1/api"
TORBOX_REQUESTDL_RETRIES = coerce_int(os.getenv("TORBOX_REQUESTDL_RETRIES"), 3, minimum=1, maximum=10)
TORBOX_FILE_CANDIDATES = coerce_int(os.getenv("TORBOX_FILE_CANDIDATES"), 4, minimum=1, maximum=12)
TORBOX_MYLIST_LIMIT = coerce_int(os.getenv("TORBOX_MYLIST_LIMIT"), 1000, minimum=1, maximum=5000)


def _clean_api_key(api_key: str) -> str:
    return str(api_key or "").replace("Bearer ", "").strip()


def torbox_headers(api_key: str) -> dict[str, str]:
    clean_key = _clean_api_key(api_key)
    return {
        "Authorization": f"Bearer {clean_key}",
        "Accept": "application/json",
        "User-Agent": "torrenthan-torbox/5.1",
    }


def _response_json(response: httpx.Response) -> dict[str, Any]:
    try:
        data = response.json()
    except Exception:
        return {"success": False, "error": response.text[:500], "data": None}
    return data if isinstance(data, dict) else {"success": False, "error": "invalid_json_shape", "data": data}


async def torbox_create_torrent(client: httpx.AsyncClient, api_key: str, magnet: str) -> dict[str, Any]:
    response = await client.post(
        f"{TORBOX_API_BASE}/torrents/createtorrent",
        data={"magnet": magnet, "seed": "1", "allow_zip": "false"},
        headers=torbox_headers(api_key),
    )
    if response.status_code >= 400:
        logger.warning("TorBox createtorrent %s - %s", response.status_code, response.text[:350])
        return {"success": False, "error": response.text[:500], "data": None}
    return _response_json(response)


async def torbox_list_torrents(client: httpx.AsyncClient, api_key: str) -> list[dict[str, Any]]:
    response = await client.get(
        f"{TORBOX_API_BASE}/torrents/mylist",
        params={"bypass_cache": "true", "limit": TORBOX_MYLIST_LIMIT},
        headers=torbox_headers(api_key),
    )
    if response.status_code >= 400:
        logger.warning("TorBox mylist %s - %s", response.status_code, response.text[:350])
        return []
    data = _response_json(response).get("data", [])
    return data if isinstance(data, list) else []


async def torbox_get_torrent(client: httpx.AsyncClient, api_key: str, torrent_id: str | int) -> dict[str, Any] | None:
    if str(torrent_id or "").strip() == "":
        return None
    response = await client.get(
        f"{TORBOX_API_BASE}/torrents/mylist",
        params={"bypass_cache": "true", "id": torrent_id},
        headers=torbox_headers(api_key),
    )
    if response.status_code >= 400:
        logger.warning("TorBox mylist?id=%s %s - %s", torrent_id, response.status_code, response.text[:350])
        return None
    data = _response_json(response).get("data")
    if isinstance(data, dict):
        return data
    if isinstance(data, list) and data:
        found = next((item for item in data if str(item.get("id")) == str(torrent_id)), None)
        return found or data[0]
    return None


def _extract_torrent_id(create_response: dict[str, Any]) -> str | None:
    data = create_response.get("data") if isinstance(create_response, dict) else None
    if isinstance(data, dict):
        for key in ("torrent_id", "id"):
            value = str(data.get(key) or "").strip()
            if value:
                return value
    if isinstance(data, int):
        return str(data)
    if isinstance(data, str) and data.strip().isdigit():
        return data.strip()
    return None


def _torrent_matches_hash(item: dict[str, Any], hash_val: str) -> bool:
    needle = str(hash_val or "").strip().lower()
    if not needle:
        return False
    if str(item.get("hash") or "").strip().lower() == needle:
        return True
    alternatives = item.get("alternative_hashes") or []
    if isinstance(alternatives, list):
        return any(str(value or "").strip().lower() == needle for value in alternatives)
    return False


def _torrent_files(item: dict[str, Any] | None) -> list[dict[str, Any]]:
    if not isinstance(item, dict):
        return []
    files = item.get("files") or []
    return [file_item for file_item in files if isinstance(file_item, dict)] if isinstance(files, list) else []


def _normalize_torbox_files(files: list[dict[str, Any]]) -> list[dict[str, Any]]:
    mapped: list[dict[str, Any]] = []
    for idx, file_item in enumerate(files):
        file_id = file_item.get("id")
        if file_id is None or str(file_id).strip() == "":
            continue
        path = (
            file_item.get("absolute_path")
            or file_item.get("short_name")
            or file_item.get("name")
            or file_item.get("path")
            or ""
        )
        mapped.append(
            {
                "id": str(file_id).strip(),
                "path": str(path or ""),
                "name": str(file_item.get("name") or path or ""),
                "short_name": str(file_item.get("short_name") or ""),
                "bytes": file_item.get("size", 0),
                "size": file_item.get("size", 0),
                "mimetype": str(file_item.get("mimetype") or ""),
                "_original_index": idx,
            }
        )
    return mapped


def _candidate_file_ids(
    mapped_files: list[dict[str, Any]],
    *,
    season: int,
    episode: int,
    file_index: str,
) -> list[str]:
    candidates: list[str] = []

    selected = select_best_file(
        mapped_files,
        season=season,
        episode=episode,
        file_index_hint=file_index,
    )
    if selected:
        candidates.append(str(selected))

    ranked = rank_file_candidates(
        mapped_files,
        season=season,
        episode=episode,
        file_index_hint=file_index,
        limit=TORBOX_FILE_CANDIDATES,
    )
    for file_id in ranked:
        value = str(file_id or "").strip()
        if value and value not in candidates:
            candidates.append(value)

    return candidates[:TORBOX_FILE_CANDIDATES]


async def torbox_request_download(
    client: httpx.AsyncClient,
    api_key: str,
    torrent_id: str | int,
    file_id: str,
) -> str | None:
    clean_key = _clean_api_key(api_key)
    for attempt in range(TORBOX_REQUESTDL_RETRIES):
        response = await client.get(
            f"{TORBOX_API_BASE}/torrents/requestdl",
            params={
                "token": clean_key,
                "torrent_id": torrent_id,
                "file_id": file_id,
                "zip_link": "false",
                "append_name": "true",
            },
            headers=torbox_headers(api_key),
        )
        if response.status_code >= 400:
            logger.warning(
                "TorBox requestdl failed | status=%s | torrent=%s | file=%s | attempt=%s/%s | body=%s",
                response.status_code,
                torrent_id,
                file_id,
                attempt + 1,
                TORBOX_REQUESTDL_RETRIES,
                response.text[:300],
            )
            if response.status_code in {408, 425, 429, 500, 502, 503, 504} and attempt < TORBOX_REQUESTDL_RETRIES - 1:
                await asyncio.sleep(min(3.0, 0.8 * (attempt + 1)))
                continue
            return None

        payload = _response_json(response)
        if not payload.get("success"):
            logger.warning(
                "TorBox requestdl unsuccessful | torrent=%s | file=%s | detail=%s | error=%s",
                torrent_id,
                file_id,
                str(payload.get("detail") or "")[:180],
                str(payload.get("error") or "")[:180],
            )
            return None

        data = payload.get("data")
        if isinstance(data, str) and data.strip():
            return data.strip()
        if isinstance(data, dict):
            for key in ("download", "link", "url"):
                value = str(data.get(key) or "").strip()
                if value:
                    return value
        logger.warning("TorBox requestdl returned no URL | torrent=%s | file=%s", torrent_id, file_id)
        return None
    return None


async def _find_torbox_torrent(
    client: httpx.AsyncClient,
    api_key: str,
    hash_val: str,
    torrent_id_hint: str | None,
) -> dict[str, Any] | None:
    if torrent_id_hint:
        target = await torbox_get_torrent(client, api_key, torrent_id_hint)
        if target and (not hash_val or _torrent_matches_hash(target, hash_val) or str(target.get("id")) == str(torrent_id_hint)):
            return target

    torrents = await torbox_list_torrents(client, api_key)
    return next((item for item in torrents if _torrent_matches_hash(item, hash_val)), None)


async def resolve_torbox_download(
    hash_val: str,
    api_key: str,
    season: int,
    episode: int,
    file_index: str,
    client: httpx.AsyncClient,
) -> str | None:
    try:
        full_magnet = build_magnet_link(hash_val, trackers=TRACKERS)
    except ValueError:
        logger.warning("TorBox invalid hash for playback | hash=%s", str(hash_val)[:80])
        return None

    try:
        create_response = await torbox_create_torrent(client, api_key, full_magnet)
        torrent_id_hint = _extract_torrent_id(create_response)
        if not create_response.get("success") and not torrent_id_hint:
            logger.warning(
                "TorBox create failed | hash=%s | detail=%s | error=%s",
                hash_val,
                str(create_response.get("detail") or "")[:180],
                str(create_response.get("error") or "")[:180],
            )

        target: dict[str, Any] | None = None
        raw_files: list[dict[str, Any]] = []
        for attempt in range(TORBOX_POLL_ATTEMPTS):
            target = await _find_torbox_torrent(client, api_key, hash_val, torrent_id_hint)
            raw_files = _torrent_files(target)
            if target and raw_files:
                break
            if attempt < TORBOX_POLL_ATTEMPTS - 1:
                await asyncio.sleep(TORBOX_POLL_INTERVAL)

        if not target:
            logger.warning("TorBox torrent not found after create | hash=%s | torrent_id=%s", hash_val, torrent_id_hint or "n/a")
            return None

        torrent_id = target.get("id") or torrent_id_hint
        if not torrent_id:
            logger.warning("TorBox target without torrent id | hash=%s", hash_val)
            return None

        if not raw_files:
            logger.warning(
                "TorBox torrent has no files yet | hash=%s | torrent=%s | state=%s | progress=%s | cached=%s",
                hash_val,
                torrent_id,
                target.get("download_state"),
                target.get("progress"),
                target.get("cached"),
            )
            return None

        mapped_files = _normalize_torbox_files(raw_files)
        candidate_ids = _candidate_file_ids(mapped_files, season=season, episode=episode, file_index=file_index)
        if not candidate_ids:
            logger.warning(
                "TorBox no playable candidate | hash=%s | torrent=%s | files=%s",
                hash_val,
                torrent_id,
                len(mapped_files),
            )
            return None

        for selected_file_id in candidate_ids:
            final_url = await torbox_request_download(client, api_key, torrent_id, selected_file_id)
            if final_url:
                logger.info(
                    "TorBox resolved playback | hash=%s | torrent=%s | file=%s | candidates=%s",
                    hash_val,
                    torrent_id,
                    selected_file_id,
                    len(candidate_ids),
                )
                return final_url

        logger.warning(
            "TorBox all candidate files failed | hash=%s | torrent=%s | candidates=%s | state=%s | progress=%s",
            hash_val,
            torrent_id,
            ",".join(candidate_ids),
            target.get("download_state"),
            target.get("progress"),
        )
    except Exception:
        logger.exception("TorBox resolve error su hash %s", hash_val)
    return None
