from __future__ import annotations

import logging
from collections import Counter
from typing import Any

logger = logging.getLogger("torrenthan.parity")


def build_parity_report(
    *,
    media_type: str,
    media_id: str,
    content_language: str,
    raw_streams: list[dict[str, Any]],
    enriched_streams: list[dict[str, Any]],
    candidate_streams: list[dict[str, Any]],
    final_streams: list[dict[str, Any]],
    rejection_reasons: Counter[str] | dict[str, int] | None = None,
    dedupe_stats: dict[str, int] | None = None,
) -> dict[str, Any]:
    reasons = dict(rejection_reasons or {})
    dedupe = dict(dedupe_stats or {})
    lang_classes = Counter(str(item.get("_language_class", "unknown") or "unknown") for item in enriched_streams)
    fingerprint_strategies = Counter(str(item.get("_fingerprint_strategy", "anonymous") or "anonymous") for item in enriched_streams)
    target = "eng" if str(content_language or "").lower() == "eng" else "ita"
    likely_target = sum(1 for item in enriched_streams if int(item.get("_lang_score", 0) or 0) >= 35)

    report = {
        "media_type": media_type,
        "media_id": media_id,
        "language": target,
        "raw": len(raw_streams),
        "enriched": len(enriched_streams),
        "likely_target_language": likely_target,
        "candidates": len(candidate_streams),
        "final": len(final_streams),
        "rejections": reasons,
        "dedupe": dedupe,
        "language_classes": dict(lang_classes),
        "fingerprint_strategies": dict(fingerprint_strategies),
    }
    return report


def log_parity_report(report: dict[str, Any]) -> None:
    raw = int(report.get("raw", 0) or 0)
    likely = int(report.get("likely_target_language", 0) or 0)
    final = int(report.get("final", 0) or 0)
    candidates = int(report.get("candidates", 0) or 0)
    lost_likely = max(0, likely - candidates)
    deduped = int((report.get("dedupe") or {}).get("deduped", 0) or 0)

    level = logging.INFO
    if raw >= 6 and likely >= 4 and final <= 2:
        level = logging.WARNING

    logger.log(
        level,
        "[PARITY] type=%s id=%s lang=%s raw=%s likely=%s candidates=%s final=%s lost_likely=%s deduped=%s rejections=%s lang_classes=%s fp=%s",
        report.get("media_type"),
        report.get("media_id"),
        report.get("language"),
        raw,
        likely,
        candidates,
        final,
        lost_likely,
        deduped,
        report.get("rejections"),
        report.get("language_classes"),
        report.get("fingerprint_strategies"),
    )
