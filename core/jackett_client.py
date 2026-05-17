from __future__ import annotations

import asyncio
import logging
import os
import re
import xml.etree.ElementTree as ET
from dataclasses import dataclass
from typing import Any
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

import httpx

from core.config import coerce_float, coerce_int

logger = logging.getLogger("torrenthan.jackett")

JACKETT_URL = os.getenv("TORRENTHAN_JACKETT_URL", "").strip()
JACKETT_API_KEY = os.getenv("TORRENTHAN_JACKETT_API_KEY", "").strip()
JACKETT_INDEXERS = [
    item.strip()
    for item in os.getenv("TORRENTHAN_JACKETT_INDEXERS", "all").split(",")
    if item.strip()
]
JACKETT_TIMEOUT = coerce_float(os.getenv("TORRENTHAN_JACKETT_TIMEOUT_MS"), 4500, minimum=1000, maximum=20000) / 1000
JACKETT_MAX_RESULTS = coerce_int(os.getenv("TORRENTHAN_JACKETT_MAX_RESULTS"), 40, minimum=1, maximum=200)
JACKETT_CONCURRENCY = coerce_int(os.getenv("TORRENTHAN_JACKETT_CONCURRENCY"), 3, minimum=1, maximum=10)

_INFOHASH_RE = re.compile(r"\b[a-f0-9]{40}\b", re.I)
_BTIH_RE = re.compile(r"btih:([a-f0-9]{40})", re.I)
_SIZE_UNITS = ("B", "KB", "MB", "GB", "TB")


@dataclass(frozen=True, slots=True)
class JackettSource:
    url: str
    name: str


def _query_pairs(url: str) -> dict[str, str]:
    return dict(parse_qsl(urlsplit(url).query, keep_blank_values=True))


def is_configured() -> bool:
    if not JACKETT_URL:
        return False
    if JACKETT_API_KEY:
        return True
    return bool(_query_pairs(JACKETT_URL).get("apikey"))


def _with_query(base_url: str, params: dict[str, Any]) -> str:
    split = urlsplit(base_url)
    query = dict(parse_qsl(split.query, keep_blank_values=True))
    query.update({k: str(v) for k, v in params.items() if v is not None and str(v) != ""})
    return urlunsplit((split.scheme, split.netloc, split.path, urlencode(query), split.fragment))


def _normalize_endpoint(base_url: str, indexer: str) -> str:
    clean = str(base_url or "").strip()
    if not clean:
        return ""
    split = urlsplit(clean)
    path = split.path.rstrip("/")
    if "/api/v2.0/indexers/" in path and "/results/torznab" in path:
        return clean
    path = f"{path}/api/v2.0/indexers/{indexer}/results/torznab/api" if path else f"/api/v2.0/indexers/{indexer}/results/torznab/api"
    return urlunsplit((split.scheme, split.netloc, path, split.query, split.fragment))


def _source_name(endpoint: str, indexer: str) -> str:
    host = urlsplit(endpoint).netloc or "jackett"
    host = host.split(":", 1)[0].replace("www.", "")
    if indexer and indexer != "all":
        return _clean_provider_label(indexer)[:32] or "Jackett"
    return _clean_provider_label(host)[:32] or "Jackett"


def _clean_provider_label(value: Any) -> str:
    text = re.sub(r"\s+", " ", str(value or "")).strip(" -–—|/\\")
    if not text:
        return ""
    text = re.sub(r"(?i)^jackett\s*/\s*", "", text).strip(" -–—|/\\")
    text = re.sub(r"(?i)^tracker\s*[:=-]\s*", "", text).strip(" -–—|/\\")
    return text


def _is_numeric_category(value: Any) -> bool:
    text = _clean_provider_label(value)
    return not text or bool(re.fullmatch(r"\d+(?:\s*,\s*\d+)*", text))


def _child_text_by_suffix(item: ET.Element, *suffixes: str) -> str:
    wanted = tuple(suffix.lower() for suffix in suffixes)
    for child in list(item):
        tag = str(child.tag or "").lower()
        local = tag.rsplit("}", 1)[-1]
        if any(local.endswith(suffix) for suffix in wanted):
            value = _clean_provider_label(child.text)
            if value:
                return value
    return ""


def _child_attr_by_suffix(item: ET.Element, attr_name: str, *suffixes: str) -> str:
    wanted = tuple(suffix.lower() for suffix in suffixes)
    for child in list(item):
        tag = str(child.tag or "").lower()
        local = tag.rsplit("}", 1)[-1]
        if any(local.endswith(suffix) for suffix in wanted):
            value = _clean_provider_label(child.attrib.get(attr_name, ""))
            if value:
                return value
    return ""


def _display_provider(item: ET.Element, attrs: dict[str, str], source: JackettSource) -> str:
    candidates = [
        _child_text_by_suffix(item, "jackettindexer", "indexer", "tracker"),
        _child_attr_by_suffix(item, "id", "jackettindexer", "indexer", "tracker"),
        attrs.get("tracker"),
        attrs.get("trackerid"),
        attrs.get("indexer"),
        attrs.get("indexerid"),
        source.name,
    ]
    for candidate in candidates:
        clean = _clean_provider_label(candidate)
        if clean and not _is_numeric_category(clean):
            return clean[:40]
    return "Jackett"


def _sources() -> list[JackettSource]:
    if not JACKETT_URL:
        return []
    indexers = JACKETT_INDEXERS or ["all"]
    sources: list[JackettSource] = []
    for indexer in indexers:
        endpoint = _normalize_endpoint(JACKETT_URL, indexer)
        if endpoint:
            sources.append(JackettSource(url=endpoint, name=_source_name(endpoint, indexer)))
    return sources


def _query_for(media_type: str, imdb_id: str, title_tokens: str, season: int, episode: int) -> dict[str, Any]:
    q = " ".join(token for token in str(title_tokens or "").split() if len(token) >= 3)[:120]
    params: dict[str, Any] = {"t": "search", "extended": "1", "limit": JACKETT_MAX_RESULTS}
    if imdb_id.startswith("tt"):
        params["imdbid"] = imdb_id[2:]
    if q:
        params["q"] = q
    if media_type in {"series", "anime"}:
        params["t"] = "tvsearch"
        if season > 0:
            params["season"] = season
        if episode > 0:
            params["ep"] = episode
    if JACKETT_API_KEY:
        params["apikey"] = JACKETT_API_KEY
    return params


def _text(item: ET.Element, tag: str) -> str:
    child = item.find(tag)
    return (child.text or "").strip() if child is not None and child.text else ""


def _attrs(item: ET.Element) -> dict[str, str]:
    out: dict[str, str] = {}
    for child in list(item):
        if not child.tag.lower().endswith("attr"):
            continue
        name = str(child.attrib.get("name", "") or "").strip().lower()
        value = str(child.attrib.get("value", "") or "").strip()
        if name and value:
            out[name] = value
    return out


def _enclosure_url(item: ET.Element) -> str:
    enc = item.find("enclosure")
    if enc is not None:
        return str(enc.attrib.get("url", "") or "").strip()
    return ""


def _extract_info_hash(*values: str) -> str:
    for value in values:
        text = str(value or "")
        match = _BTIH_RE.search(text) or _INFOHASH_RE.search(text)
        if match:
            return match.group(1).lower() if match.lastindex else match.group(0).lower()
    return ""


def _human_size(raw: Any) -> str:
    try:
        value = float(str(raw or "0"))
    except (TypeError, ValueError):
        return "N/A"
    if value <= 0:
        return "N/A"
    unit_index = 0
    while value >= 1024 and unit_index < len(_SIZE_UNITS) - 1:
        value /= 1024
        unit_index += 1
    return f"{value:.2f} {_SIZE_UNITS[unit_index]}"


def _jackett_display_label(provider: str) -> str:
    clean = _clean_provider_label(provider)
    if not clean or clean.lower() == "jackett":
        return "Jackett"
    return f"Jackett · {clean[:40]}"


def _parse_item(item: ET.Element, source: JackettSource) -> dict[str, Any] | None:
    attrs = _attrs(item)
    title = _text(item, "title")
    link = attrs.get("magneturl") or _enclosure_url(item) or _text(item, "link")
    info_hash = attrs.get("infohash") or _extract_info_hash(link, title, _text(item, "guid"))
    if not title or not (link or info_hash):
        return None

    seeders = attrs.get("seeders") or attrs.get("seed") or attrs.get("peers") or "0"
    size = attrs.get("size") or _text(item, "size") or "0"
    size_human = _human_size(size)
    provider = _display_provider(item, attrs, source)
    provider_label = _jackett_display_label(provider)
    provider_key = re.sub(r"[^a-z0-9]+", "-", provider.lower()).strip("-") or "jackett"
    stream: dict[str, Any] = {
        "name": "Torrenthan Jackett",
        "title": f"{title}\n💾 {size_human}\n👤 {seeders}\n⚙️ {provider_label}",
        "behaviorHints": {"bingeGroup": f"torrenthan-jackett-{provider_key}"},
        "_external_source": "jackett",
        "_jackett_provider": provider,
        "_jackett_provider_label": provider_label,
    }
    if info_hash:
        stream["infoHash"] = info_hash
    if link:
        stream["url"] = link
    return stream


def _parse_xml(payload: bytes, source: JackettSource) -> list[dict[str, Any]]:
    try:
        root = ET.fromstring(payload)
    except ET.ParseError:
        logger.debug("[JACKETT] XML non valido da %s", source.name, exc_info=True)
        return []
    streams: list[dict[str, Any]] = []
    for item in root.findall(".//item")[:JACKETT_MAX_RESULTS]:
        parsed = _parse_item(item, source)
        if parsed:
            streams.append(parsed)
    return streams


async def _fetch_source(
    client: httpx.AsyncClient,
    source: JackettSource,
    *,
    media_type: str,
    imdb_id: str,
    title_tokens: str,
    season: int,
    episode: int,
) -> list[dict[str, Any]]:
    params = _query_for(media_type, imdb_id, title_tokens, season, episode)
    url = _with_query(source.url, params)
    try:
        response = await client.get(url, timeout=JACKETT_TIMEOUT)
        response.raise_for_status()
    except Exception:
        logger.info("[JACKETT] fetch failed source=%s", source.name, exc_info=True)
        return []
    streams = _parse_xml(response.content or b"", source)
    logger.info("[JACKETT] source=%s streams=%d", source.name, len(streams))
    return streams


async def fetch_jackett_streams(
    client: httpx.AsyncClient,
    *,
    media_type: str,
    imdb_id: str,
    title_tokens: str,
    season: int = 0,
    episode: int = 0,
) -> list[dict[str, Any]]:
    if not is_configured():
        return []
    sem = asyncio.Semaphore(JACKETT_CONCURRENCY)

    async def guarded(source: JackettSource) -> list[dict[str, Any]]:
        async with sem:
            return await _fetch_source(
                client,
                source,
                media_type=media_type,
                imdb_id=imdb_id,
                title_tokens=title_tokens,
                season=season,
                episode=episode,
            )

    groups = await asyncio.gather(*(guarded(source) for source in _sources()), return_exceptions=True)
    streams: list[dict[str, Any]] = []
    for group in groups:
        if isinstance(group, list):
            streams.extend(group)
    return streams[:JACKETT_MAX_RESULTS]
