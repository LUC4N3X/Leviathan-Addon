from __future__ import annotations

import asyncio
import logging
import os
import re
import xml.etree.ElementTree as ET
from typing import Any

import httpx

from core.config import coerce_float, coerce_int

logger = logging.getLogger("torrenthan.rss")

RSS_ENABLED = os.getenv("TORRENTHAN_RSS_ENABLED", "0").strip().lower() in {"1", "true", "yes", "on"}
RSS_URLS = [u.strip() for u in os.getenv("TORRENTHAN_RSS_URLS", "").split(",") if u.strip()]
RSS_TIMEOUT = coerce_float(os.getenv("TORRENTHAN_RSS_TIMEOUT_MS"), 3500, minimum=1000, maximum=15000) / 1000
RSS_MAX_RESULTS = coerce_int(os.getenv("TORRENTHAN_RSS_MAX_RESULTS"), 30, minimum=1, maximum=100)
RSS_CONCURRENCY = coerce_int(os.getenv("TORRENTHAN_RSS_CONCURRENCY"), 2, minimum=1, maximum=8)

_INFOHASH_RE = re.compile(r"\b[a-f0-9]{40}\b", re.I)
_BTIH_RE = re.compile(r"btih:([a-f0-9]{40})", re.I)
_SIZE_RE = re.compile(r"([\d]+(?:[.,]\d+)?)\s*([KMGT]I?B|[KMGT]B)", re.I)


def is_enabled() -> bool:
    return bool(RSS_ENABLED and RSS_URLS)


def _text(item: ET.Element, tag: str) -> str:
    child = item.find(tag)
    return (child.text or "").strip() if child is not None and child.text else ""


def _enclosure_url(item: ET.Element) -> str:
    enc = item.find("enclosure")
    if enc is not None:
        return str(enc.attrib.get("url", "") or "").strip()
    return ""


def _extract_hash(*values: str) -> str:
    for value in values:
        text = str(value or "")
        match = _BTIH_RE.search(text) or _INFOHASH_RE.search(text)
        if match:
            return match.group(1).lower() if match.lastindex else match.group(0).lower()
    return ""


def _size_from_text(*values: str) -> str:
    joined = " ".join(str(v or "") for v in values)
    match = _SIZE_RE.search(joined)
    return match.group(0).upper().replace(",", ".") if match else "N/A"


def _matches_query(title: str, title_tokens: str) -> bool:
    wanted = [t for t in str(title_tokens or "").lower().split() if len(t) >= 4]
    if not wanted:
        return True
    haystack = str(title or "").lower()
    return any(token in haystack for token in wanted[:4])


def _parse_xml(payload: bytes, source_name: str, title_tokens: str) -> list[dict[str, Any]]:
    try:
        root = ET.fromstring(payload)
    except ET.ParseError:
        logger.debug("RSS XML non valido da %s", source_name, exc_info=True)
        return []
    streams: list[dict[str, Any]] = []
    for item in root.findall(".//item")[:RSS_MAX_RESULTS]:
        title = _text(item, "title")
        link = _enclosure_url(item) or _text(item, "link")
        guid = _text(item, "guid")
        description = _text(item, "description")
        if not title or not _matches_query(title, title_tokens):
            continue
        info_hash = _extract_hash(link, guid, description, title)
        if not (info_hash or link):
            continue
        stream: dict[str, Any] = {
            "name": "Torrenthan RSS",
            "title": f"{title}\n💾 {_size_from_text(title, description)}\n👤 0\n⚙️ {source_name}",
            "behaviorHints": {"bingeGroup": f"torrenthan-rss-{source_name}"},
            "_external_source": "rss",
        }
        if info_hash:
            stream["infoHash"] = info_hash
        if link:
            stream["url"] = link
        streams.append(stream)
    return streams


async def _fetch_feed(client: httpx.AsyncClient, url: str, title_tokens: str) -> list[dict[str, Any]]:
    source_name = re.sub(r"^www\.", "", httpx.URL(url).host or "rss")[:32]
    try:
        response = await client.get(url, timeout=RSS_TIMEOUT)
        response.raise_for_status()
    except Exception:
        logger.info("[RSS] fetch failed source=%s", source_name, exc_info=True)
        return []
    streams = _parse_xml(response.content or b"", source_name, title_tokens)
    logger.info("[RSS] source=%s streams=%d", source_name, len(streams))
    return streams


async def fetch_rss_streams(client: httpx.AsyncClient, *, title_tokens: str) -> list[dict[str, Any]]:
    if not is_enabled():
        return []
    sem = asyncio.Semaphore(RSS_CONCURRENCY)

    async def guarded(url: str) -> list[dict[str, Any]]:
        async with sem:
            return await _fetch_feed(client, url, title_tokens)

    groups = await asyncio.gather(*(guarded(url) for url in RSS_URLS), return_exceptions=True)
    streams: list[dict[str, Any]] = []
    for group in groups:
        if isinstance(group, list):
            streams.extend(group)
    return streams[:RSS_MAX_RESULTS]
