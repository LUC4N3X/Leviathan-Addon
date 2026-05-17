from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Any


_RESOLUTION_RE = re.compile(r"(?<!\d)(2160p|1080p|720p|480p)(?!\d)|\b(4k|uhd|fhd|sd)\b", re.I)
_CODEC_RE = re.compile(r"\b(hevc|x265|h265|x264|h264|av1)\b", re.I)
_SOURCE_RE = re.compile(r"\b(remux|web[ ._-]?dl|web[ ._-]?rip|blu[ ._-]?ray|bdrip|hdrip|hdtv|dvdrip)\b", re.I)
_RELEASE_GROUP_RE = re.compile(r"(?:-|\b)([A-Za-z0-9]{2,24})\s*$")
_SIZE_RE = re.compile(r"([\d]+(?:[.,]\d+)?)\s*([KMGT]I?B)", re.I)

INFOHASH_RE = re.compile(r"^[a-f0-9]{40}$", re.I)
BTIH_RE = re.compile(r"btih:([a-f0-9]{40})", re.I)


def tokenized_text(*values: Any) -> str:
    return re.sub(r"\s+", " ", " ".join(str(v or "") for v in values).lower()).strip()


def safe_float(value: Any, default: float = 0.0) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


def parse_size_to_gb(size_str: str | None) -> float:
    if not size_str:
        return 0.0
    match = _SIZE_RE.search(str(size_str).replace(",", "."))
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
    if INFOHASH_RE.fullmatch(info_hash):
        return info_hash.lower()
    match = BTIH_RE.search(str(stream.get("url", "") or ""))
    return match.group(1).lower() if match else ""
_YEAR_RE = re.compile(r"\b(?:19|20)\d{2}\b")
_NOISE_RE = re.compile(
    r"\b(?:2160p|1080p|720p|480p|4k|uhd|fhd|sd|hdr10\+?|hdr|dv|dovi|hevc|x265|h265|x264|h264|av1|"
    r"web\s?dl|web\s?rip|bluray|blu\s?ray|bdrip|remux|ita|eng|english|italian|multi|dual|audio|aac|ac3|eac3|ddp?5?1?|"
    r"dts|truehd|atmos|thepiratebay|ilcorsaronero|torrentio|torrenthan|tb|rd|source)\b",
    re.I,
)


@dataclass(frozen=True, slots=True)
class StreamFingerprint:
    identity: str
    strategy: str
    title_key: str
    size_bucket: str
    resolution: str
    codec: str
    source: str
    release_group: str


def _clean_title(text: str) -> str:
    release_lines = []
    for line in str(text or "").splitlines():
        if re.search(r"[💾👤⚙]|\b(?:seeders?|peers?|source|provider|tracker)\b", line, re.I):
            continue
        release_lines.append(line)
    cleaned = tokenized_text(" ".join(release_lines) or text)
    cleaned = _YEAR_RE.sub(" ", cleaned)
    cleaned = _SIZE_RE.sub(" ", cleaned)
    cleaned = _NOISE_RE.sub(" ", cleaned)
    cleaned = re.sub(r"\b(?:gb|gib|mb|mib|kb|kib|tb|tib)\b", " ", cleaned, flags=re.I)
    cleaned = re.sub(r"[^a-z0-9]+", " ", cleaned)
    return " ".join(part for part in cleaned.split() if len(part) > 1 and not part.isdigit())[:96]


def _first(pattern: re.Pattern[str], text: str, default: str = "") -> str:
    match = pattern.search(text)
    if not match:
        return default
    for group in match.groups():
        if group:
            return group.lower().replace(" ", "").replace("_", "-")
    return match.group(0).lower().replace(" ", "").replace("_", "-")


def _size_from_stream(stream: dict[str, Any], combined: str) -> float:
    direct = safe_float(stream.get("_parsed_size", 0.0), 0.0)
    if direct > 0:
        return direct
    match = _SIZE_RE.search(combined)
    if not match:
        return 0.0
    return parse_size_to_gb(match.group(0))


def _size_bucket(size_gb: float) -> str:
    if size_gb <= 0:
        return "size:unknown"
    if size_gb < 1:
        bucket = round(size_gb, 1)
    elif size_gb < 10:
        bucket = round(size_gb * 2) / 2
    else:
        bucket = round(size_gb)
    return f"size:{bucket:g}gb"


def _release_group(text: str) -> str:
    tail = re.sub(r"[\]\)\}\s]+$", "", text.strip())
    match = _RELEASE_GROUP_RE.search(tail)
    if not match:
        return "group:unknown"
    value = match.group(1).lower()
    if value in {"ita", "eng", "hevc", "h264", "h265", "x264", "x265", "aac", "ac3", "1080p", "2160p", "720p"}:
        return "group:unknown"
    return f"group:{value[:24]}"


def build_stream_fingerprint(stream: dict[str, Any]) -> StreamFingerprint:
    name = str(stream.get("name", "") or "")
    title = str(stream.get("title", "") or "")
    combined = tokenized_text(name, title)

    info_hash = str(stream.get("_info_hash", "") or get_hash_from_stream(stream) or "").strip().lower()
    file_idx = str(stream.get("fileIdx", "") or stream.get("file_idx", "") or "").strip().lower()
    file_idx = "" if file_idx in {"none", "null", "-1"} else file_idx

    resolution = _first(_RESOLUTION_RE, combined, "res:unknown")
    if resolution == "4k" or resolution == "uhd":
        resolution = "2160p"
    elif resolution == "fhd":
        resolution = "1080p"
    elif resolution == "sd":
        resolution = "480p"
    resolution = f"res:{resolution}" if not resolution.startswith("res:") else resolution

    codec = _first(_CODEC_RE, combined, "codec:unknown")
    codec = codec.replace("x265", "h265").replace("hevc", "h265").replace("x264", "h264")
    codec = f"codec:{codec}" if not codec.startswith("codec:") else codec

    source = _first(_SOURCE_RE, combined, "src:unknown")
    source = source.replace("web-dl", "webdl").replace("webdl", "webdl").replace("web-rip", "webrip").replace("bluray", "bluray").replace("blu-ray", "bluray")
    source = f"src:{source}" if not source.startswith("src:") else source

    size_bucket = _size_bucket(_size_from_stream(stream, combined))
    title_key = _clean_title(f"{name} {title}") or "title:unknown"
    group = _release_group(f"{name} {title}")

    technical_key = "|".join([title_key, size_bucket, resolution, codec, source, group])

    if info_hash and file_idx:
        return StreamFingerprint(
            identity=f"hash-file:{info_hash}:{file_idx}",
            strategy="hash_fileidx",
            title_key=title_key,
            size_bucket=size_bucket,
            resolution=resolution,
            codec=codec,
            source=source,
            release_group=group,
        )

    if info_hash:
        return StreamFingerprint(
            identity=f"hash-smart:{info_hash}:{technical_key}",
            strategy="hash_smart",
            title_key=title_key,
            size_bucket=size_bucket,
            resolution=resolution,
            codec=codec,
            source=source,
            release_group=group,
        )

    if title_key != "title:unknown":
        return StreamFingerprint(
            identity=f"technical:{technical_key}",
            strategy="technical",
            title_key=title_key,
            size_bucket=size_bucket,
            resolution=resolution,
            codec=codec,
            source=source,
            release_group=group,
        )

    return StreamFingerprint(
        identity="",
        strategy="anonymous",
        title_key=title_key,
        size_bucket=size_bucket,
        resolution=resolution,
        codec=codec,
        source=source,
        release_group=group,
    )
