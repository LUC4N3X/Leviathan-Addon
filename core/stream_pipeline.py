from __future__ import annotations

import os
import re
from typing import Any, TypeVar

from core import formatter
from core.filter import english_confidence, italian_confidence, language_profile
from core.ranking_profiles import sort_key as ranking_sort_key
from core.stream_fingerprint import build_stream_fingerprint

PUBLIC_BASE_URL = os.getenv("PUBLIC_BASE_URL", "").strip().rstrip("/")
VALID_SERVICES = {"", "realdebrid", "torbox"}
VALID_TYPES = {"movie", "series", "anime"}
TRACKERS = [
    "udp://tracker.opentrackr.org:1337/announce",
    "udp://open.demonoid.ch:6969/announce",
    "udp://open.demonii.com:1337/announce",
    "udp://open.stealth.si:80/announce",
    "udp://tracker.torrent.eu.org:451/announce",
    "udp://tracker.therarbg.to:6969/announce",
    "udp://tracker.doko.moe:6969/announce",
    "udp://opentracker.i2p.rocks:6969/announce",
    "udp://exodus.desync.com:6969/announce",
    "udp://tracker.moeking.me:6969/announce",
]

SIZE_PATTERN = re.compile(r"([\d]+(?:[.,]\d+)?)\s*([KMGT]I?B)", re.I)
SEED_PATTERN = re.compile(r"(?:👤|seeders?|seeds?|peers?)\s*[:=]?\s*(\d+)", re.I)
INFOHASH_PATTERN = re.compile(r"^[a-f0-9]{40}$", re.I)
BTIH_PATTERN = re.compile(r"btih:([a-f0-9]{40})", re.I)

QUALITY_PATTERNS = {
    "2160p": re.compile(r"(?<!\d)2160p(?!\d)|\b(?:4k|uhd)\b", re.I),
    "1080p": re.compile(r"(?<!\d)1080p(?!\d)|\bfhd\b", re.I),
    "720p": re.compile(r"(?<!\d)720p(?!\d)", re.I),
    "480p": re.compile(r"(?<!\d)480p(?!\d)|\bsd\b", re.I),
    "remux": re.compile(r"\bremux\b", re.I),
    "bluray": re.compile(r"\b(?:blu-?ray|bdrip)\b", re.I),
    "webdl": re.compile(r"\bweb[ .-]?dl\b", re.I),
    "webrip": re.compile(r"\bweb[ .-]?rip\b", re.I),
    "dv": re.compile(r"\b(?:dolby vision|dovi|dv)\b", re.I),
    "hdr10p": re.compile(r"\bhdr10\+\b", re.I),
    "hdr": re.compile(r"\b(?:hdr10|hdr)\b", re.I),
    "atmos": re.compile(r"\batmos\b", re.I),
    "lossless_audio": re.compile(r"\b(?:truehd|dts-hd|dts:x)\b", re.I),
    "hevc": re.compile(r"\b(?:hevc|x265|h265|av1)\b", re.I),
    "cam": re.compile(r"\b(?:cam|hdcam|ts|hd-?ts|telesync|workprint)\b", re.I),
}

EXCLUSION_PATTERNS = {
    "cam": re.compile(r"\b(?:cam|hdcam|ts|hd-?ts|telesync|tc)\b", re.I),
    "scr": re.compile(r"\b(?:scr|screener|dvdscr|bdscr)\b", re.I),
    "3d": re.compile(r"\b(?:3d|sbs|hou|half-sbs)\b", re.I),
    "4k": re.compile(r"(?<!\d)2160p(?!\d)|\b(?:4k|uhd)\b", re.I),
    "1080p": re.compile(r"(?<!\d)1080p(?!\d)|\bfhd\b", re.I),
    "720p": re.compile(r"(?<!\d)720p(?!\d)", re.I),
    "hdr": re.compile(r"\b(?:hdr|hdr10|hdr10\+)\b", re.I),
    "dolbyvision": re.compile(r"\b(?:dv|dovi|dolby vision)\b", re.I),
    "hevc": re.compile(r"\b(?:hevc|x265|h265|av1)\b", re.I),
}

PACK_PATTERNS = (
    re.compile(r"\bcomplete season\b", re.I),
    re.compile(r"\bseason pack\b", re.I),
    re.compile(r"\bfull season\b", re.I),
    re.compile(r"\bstagione completa\b", re.I),
    re.compile(r"\bcomplete series\b", re.I),
    re.compile(r"\bseries pack\b", re.I),
    re.compile(r"\bcollezione completa\b", re.I),
    re.compile(r"\bintegrale\b", re.I),
)
PACK_SEASON_ONLY_RE = re.compile(r"(?<!\w)s\d{1,2}(?![\w.\-]*e\d{1,3})", re.I)
EPISODE_RE = re.compile(r"(?<!\w)e\d{1,3}\b", re.I)
EPISODE_RANGE_RE = re.compile(r"\b(?:episodes?|episodi?)\s*1\s*[-–]\s*\d+\b", re.I)

T = TypeVar("T")


def get_public_base_url(request: Any, fallback: str = "") -> str:
    if fallback:
        return fallback
    if PUBLIC_BASE_URL:
        return PUBLIC_BASE_URL
    return str(request.base_url).rstrip("/")


def _compact_spaces(text: str) -> str:
    return re.sub(r"\s+", " ", text).strip()


def tokenized_text(*values: Any) -> str:
    return _compact_spaces(" ".join(str(v or "") for v in values).lower())


def safe_float(value: Any, default: float = 0.0) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


LANGUAGE_THRESHOLDS = {"ita": 35, "eng": 35}


def normalize_content_language(value: Any) -> str:
    return "eng" if str(value or "").strip().lower() == "eng" else "ita"


def language_threshold(content_language: str) -> int:
    return LANGUAGE_THRESHOLDS[normalize_content_language(content_language)]


def stream_language_score(stream: dict[str, Any], content_language: str) -> int:
    normalized_language = normalize_content_language(content_language)
    if normalized_language == "eng":
        return int(stream.get("_eng_score", 0) or 0)
    return int(stream.get("_ita_score", 0) or 0)


def is_language_match(stream: dict[str, Any], content_language: str) -> bool:
    normalized_language = normalize_content_language(content_language)
    target_score = stream_language_score(stream, normalized_language)
    if target_score < language_threshold(normalized_language):
        return False
    if normalized_language == "eng":
        english_score = int(stream.get("_eng_score", 0) or 0)
        italian_score = int(stream.get("_ita_score", 0) or 0)
        if english_score <= 0:
            return False
        if italian_score >= 80 and english_score < 40:
            return False
    return True


def normalize_excluded_qualities(raw: Any) -> list[str]:
    if not raw:
        return []
    if isinstance(raw, str):
        return [item.strip().lower() for item in raw.split(",") if item.strip()]
    if isinstance(raw, (list, tuple, set)):
        return [str(item).strip().lower() for item in raw if str(item).strip()]
    return []


def parse_size_to_gb(size_str: str | None) -> float:
    if not size_str:
        return 0.0
    text = str(size_str).strip()
    if not text or text.upper() == "N/A":
        return 0.0
    match = SIZE_PATTERN.search(text.replace(",", "."))
    if not match:
        return 0.0
    value = float(match.group(1))
    unit = match.group(2).upper()
    if unit in {"KB", "KIB"}:
        return value / (1024 * 1024)
    if unit in {"MB", "MIB"}:
        return value / 1024
    if unit in {"TB", "TIB"}:
        return value * 1024
    return value


def get_hash_from_stream(stream: dict[str, Any]) -> str:
    info_hash = str(stream.get("infoHash", "") or "").strip()
    if INFOHASH_PATTERN.fullmatch(info_hash):
        return info_hash.lower()
    url = str(stream.get("url", "") or "")
    match = BTIH_PATTERN.search(url)
    if match:
        return match.group(1).lower()
    return ""


def extract_size_from_stream(stream: dict[str, Any]) -> float:
    title = str(stream.get("title", "") or "")
    match = re.search(r"💾\s*([\d.,]+\s*[KMGT]I?B)", title, re.I)
    if match:
        return parse_size_to_gb(match.group(1))
    match = re.search(r"([\d.,]+\s*[KMGT]I?B)", title, re.I)
    if match:
        return parse_size_to_gb(match.group(1))
    return 0.0


def extract_seeders_from_stream(stream: dict[str, Any]) -> int:
    for key in ("seeders", "seeds", "peers"):
        raw = stream.get(key)
        if raw is not None:
            try:
                return max(0, int(str(raw).strip()))
            except (TypeError, ValueError):
                pass
    combined = tokenized_text(stream.get("name"), stream.get("title"))
    match = SEED_PATTERN.search(combined)
    if not match:
        return 0
    try:
        return max(0, int(match.group(1)))
    except (TypeError, ValueError):
        return 0


def calculate_quality_score(text: str) -> int:
    t = tokenized_text(text)
    score = 0
    if QUALITY_PATTERNS["2160p"].search(t):
        score += 420
    elif QUALITY_PATTERNS["1080p"].search(t):
        score += 300
    elif QUALITY_PATTERNS["720p"].search(t):
        score += 200
    elif QUALITY_PATTERNS["480p"].search(t):
        score += 100
    if QUALITY_PATTERNS["remux"].search(t):
        score += 150
    if QUALITY_PATTERNS["bluray"].search(t):
        score += 60
    if QUALITY_PATTERNS["webdl"].search(t):
        score += 45
    if QUALITY_PATTERNS["webrip"].search(t):
        score += 35
    if QUALITY_PATTERNS["dv"].search(t):
        score += 65
    if QUALITY_PATTERNS["hdr10p"].search(t):
        score += 55
    elif QUALITY_PATTERNS["hdr"].search(t):
        score += 40
    if QUALITY_PATTERNS["atmos"].search(t):
        score += 30
    if QUALITY_PATTERNS["lossless_audio"].search(t):
        score += 18
    if QUALITY_PATTERNS["hevc"].search(t):
        score += 20
    if QUALITY_PATTERNS["cam"].search(t):
        score -= 500
    return score


def extract_requested_episode(type_: str, raw_id: str) -> tuple[str, int, int]:
    imdb_id = raw_id
    season = 0
    episode = 0
    if type_ in {"series", "anime"} and ":" in raw_id:
        parts = raw_id.split(":")
        imdb_id = parts[0]
        try:
            if len(parts) >= 3:
                season = int(parts[1])
                episode = int(parts[2])
        except (TypeError, ValueError):
            season = 0
            episode = 0
    return imdb_id, season, episode


def should_exclude_stream(stream: dict[str, Any], excluded_qualities: list[str], size_limit: float) -> bool:
    combined_text = str(stream.get("_combined_text", "") or "")
    parsed_size = safe_float(stream.get("_parsed_size", 0.0), 0.0)
    for quality in excluded_qualities:
        pattern = EXCLUSION_PATTERNS.get(quality)
        if pattern and pattern.search(combined_text):
            return True
    if size_limit > 0 and parsed_size > 0 and parsed_size > size_limit:
        return True
    return False


def detect_pack_flag(stream: dict[str, Any]) -> bool:
    media_type = str(stream.get("type") or stream.get("_media_type") or "").lower()
    if media_type == "movie":
        return False
    combined = tokenized_text(stream.get("name"), stream.get("title"))
    if any(pattern.search(combined) for pattern in PACK_PATTERNS):
        return True
    if PACK_SEASON_ONLY_RE.search(combined) and not EPISODE_RE.search(combined):
        return True
    if EPISODE_RANGE_RE.search(combined):
        return True
    return False


def enrich_stream(stream: dict[str, Any], *, content_language: str = "ita") -> dict[str, Any]:
    enriched = dict(stream)
    name = str(enriched.get("name", "") or "")
    title = str(enriched.get("title", "") or "")
    combined = tokenized_text(name, title)
    normalized_language = normalize_content_language(content_language)
    ita_score = int(italian_confidence(name, title) or 0)
    eng_score = int(english_confidence(name, title) or 0)
    enriched["_combined_text"] = combined
    enriched["_info_hash"] = get_hash_from_stream(enriched)
    enriched["_parsed_size"] = extract_size_from_stream(enriched)
    enriched["_seeders"] = extract_seeders_from_stream(enriched)
    enriched["_ita_score"] = ita_score
    enriched["_eng_score"] = eng_score
    enriched["_lang_score"] = eng_score if normalized_language == "eng" else ita_score
    enriched["_quality_score"] = calculate_quality_score(combined)
    profile = language_profile(name, title, normalized_language)
    enriched["_language_profile"] = profile
    enriched["_language_class"] = profile.get("class", "unknown")
    fingerprint = build_stream_fingerprint(enriched)
    enriched["_fingerprint"] = fingerprint.identity
    enriched["_fingerprint_strategy"] = fingerprint.strategy
    enriched["_title_bonus"] = 0
    enriched["_is_pack"] = detect_pack_flag(enriched)
    return enriched


def title_match_bonus(stream: dict[str, Any], preferred_title_tokens: str) -> int:
    if not preferred_title_tokens:
        return 0
    combined = str(stream.get("_combined_text", "") or "")
    bonus = 0
    for token in preferred_title_tokens.split():
        if len(token) >= 4 and token in combined:
            bonus += 3
    return bonus


def finalize_ranking_fields(streams: list[dict[str, Any]], *, preferred_title_tokens: str) -> None:
    tokens = tuple(tok for tok in preferred_title_tokens.split() if len(tok) >= 4)
    for stream in streams:
        combined = str(stream.get("_combined_text", "") or "")
        stream.setdefault("_cached_boost", 0)
        stream["_title_bonus"] = sum(3 for token in tokens if token in combined)


def stream_rank_tuple(stream: dict[str, Any], *, preferred_title_tokens: str) -> tuple[int, int, int, int]:
    language_score = int(stream.get("_lang_score", stream.get("_ita_score", 0)) or 0)
    quality_score = int(stream.get("_quality_score", 0) or 0) + title_match_bonus(stream, preferred_title_tokens)
    size_score = int(safe_float(stream.get("_parsed_size", 0.0), 0.0) * 1000)
    seed_score = int(stream.get("_seeders", 0) or 0)
    return (language_score, quality_score, seed_score, size_score)


def _dedupe_identity(stream: dict[str, Any]) -> str:
    return str(stream.get("_fingerprint", "") or "").strip()


def dedupe_streams(streams: list[dict[str, Any]], *, preferred_title_tokens: str) -> list[dict[str, Any]]:
    return dedupe_streams_with_stats(streams, preferred_title_tokens=preferred_title_tokens)[0]


def dedupe_streams_with_stats(
    streams: list[dict[str, Any]],
    *,
    preferred_title_tokens: str,
) -> tuple[list[dict[str, Any]], dict[str, int]]:
    by_identity: dict[str, dict[str, Any]] = {}
    anonymous: list[dict[str, Any]] = []
    stats = {"input": len(streams), "deduped": 0, "anonymous": 0, "hash_fileidx": 0, "hash_smart": 0, "technical": 0}
    for stream in streams:
        identity = _dedupe_identity(stream)
        strategy = str(stream.get("_fingerprint_strategy", "anonymous") or "anonymous")
        if not identity:
            stats["anonymous"] += 1
            anonymous.append(stream)
            continue
        if strategy in stats:
            stats[strategy] += 1
        current_best = by_identity.get(identity)
        if current_best is None:
            by_identity[identity] = stream
            continue
        stats["deduped"] += 1
        if stream_rank_tuple(stream, preferred_title_tokens=preferred_title_tokens) > stream_rank_tuple(
            current_best,
            preferred_title_tokens=preferred_title_tokens,
        ):
            by_identity[identity] = stream
    result = list(by_identity.values()) + anonymous
    stats["output"] = len(result)
    return result, stats


def sort_key(item: dict[str, Any], sort_mode: str) -> tuple[Any, ...]:
    return ranking_sort_key(item, sort_mode)


def _inject_pack_badge(title: str) -> str:
    text = str(title or "").strip()
    if not text or "PACK" in text.upper():
        return text
    lines = text.splitlines()
    if len(lines) <= 1:
        return f"{text}\n📦 PACK"
    return "\n".join([lines[0], "📦 PACK", *lines[1:]])


def format_stream_output(
    stream: dict[str, Any],
    *,
    service: str,
    has_key: bool,
    host_url: str,
    config: str,
    season_req: int,
    episode_req: int,
    selected_style: str,
    content_language: str = "ita",
) -> dict[str, Any]:
    formatted = {k: v for k, v in stream.items() if not k.startswith("_")}
    info_hash = str(stream.get("_info_hash", "") or "")
    file_idx_val = str(formatted.get("fileIdx", "none"))

    if service in {"realdebrid", "torbox"} and has_key and info_hash:
        formatted["url"] = (
            f"{host_url}/{config}/playback/{service}/{info_hash}/"
            f"{season_req}/{episode_req}/{file_idx_val}/video.mp4"
        )
        hints = dict(formatted.get("behaviorHints") or {})
        hints["notWebReady"] = True
        formatted["behaviorHints"] = hints
        formatted.pop("infoHash", None)
        formatted["_playback_hash"] = info_hash
        formatted["_playback_file_index"] = file_idx_val

    new_name, new_title = formatter.format_display(
        formatted,
        service,
        has_key,
        style=selected_style,
        content_language=content_language,
    )
    if bool(stream.get("_is_pack")):
        new_title = _inject_pack_badge(new_title)
    formatted["name"] = new_name
    formatted["title"] = new_title
    return formatted
