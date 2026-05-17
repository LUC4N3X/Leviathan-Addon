from __future__ import annotations

from typing import Any

VALID_RANKING_PROFILES = {
    "quality",
    "balanced",
    "ita_first",
    "cached",
    "small",
    "size_desc",
    "size_asc",
}


def safe_float(value: Any, default: float = 0.0) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


def cached_weight(stream: dict[str, Any]) -> int:
    if stream.get("_rd_cached") is True or stream.get("_tb_cached") is True or stream.get("_cached") is True:
        return 2
    if stream.get("_rd_checked") is True or stream.get("_tb_checked") is True:
        return 1
    return 0


def quality_score(stream: dict[str, Any]) -> int:
    return int(stream.get("_quality_score", 0) or 0) + int(stream.get("_title_bonus", 0) or 0) + int(stream.get("_cached_boost", 0) or 0)


def language_score(stream: dict[str, Any]) -> int:
    return int(stream.get("_lang_score", stream.get("_ita_score", 0)) or 0)


def seed_score(stream: dict[str, Any]) -> int:
    for key in ("seeders", "seeds", "_seeders"):
        raw = stream.get(key)
        if raw is not None:
            try:
                return max(0, int(str(raw).strip()))
            except (TypeError, ValueError):
                continue
    return 0


def sort_key(item: dict[str, Any], sort_mode: str) -> tuple[Any, ...]:
    mode = str(sort_mode or "quality").strip().lower()
    q = quality_score(item)
    lang = language_score(item)
    size_gb = safe_float(item.get("_parsed_size", 0.0), 0.0)
    cache = cached_weight(item)
    seeds = seed_score(item)

    if mode == "size_desc":
        return (-size_gb, -q, -lang, -seeds)
    if mode in {"size_asc", "small"}:
        # 0 GB usually means unknown, so push unknown after known light files.
        size_order = size_gb if size_gb > 0 else 9999.0
        return (size_order, -cache, -lang, -q, -seeds)
    if mode == "cached":
        return (-cache, -lang, -q, -seeds, -size_gb)
    if mode == "ita_first":
        return (-lang, -cache, -q, -seeds, -size_gb)
    if mode == "balanced":
        return (-cache, -lang, -q, -seeds, abs(size_gb - 8.0) if size_gb > 0 else 999.0)

    return (-q, -lang, -cache, -seeds, -size_gb)
