from __future__ import annotations

import re
import unicodedata
from functools import lru_cache
from typing import Iterable


ITALIAN_BRANDS = {
    "ilcorsaronero",
    "corsaronero",
    "mircrew",
    "tntvillage",
    "ddlstreamitaly",
    "darksidemux",
    "pir8",
    "giuseppetornatore",
}

BAD_TOKENS = {
    "cam",
    "hdcam",
    "ts",
    "hdts",
    "telesync",
    "telecine",
    "tc",
    "workprint",
    "wp",
    "xxx",
}

VIDEO_EXTENSIONS = (
    ".mkv",
    ".mp4",
    ".avi",
    ".mov",
    ".m4v",
    ".ts",
    ".m2ts",
    ".wmv",
)

AUDIO_CODECS = r"(?:aac|ac3|eac3|dd|ddp|dts|truehd|atmos)"
LANG_IT = r"(?:ita|italian|italiano)"
LANG_EN = r"(?:eng|english)"
LANG_FR = r"(?:fre|fra|french)"
LANG_ES = r"(?:spa|es|spanish)"
LANG_DE = r"(?:ger|de|german)"
LANG_IT_EXPLICIT = r"(?:ita|italian|italiano)"
LANG_EN_EXPLICIT = r"(?:eng|english|en-us|en-gb)"
LANG_FR_EXPLICIT = r"(?:fre|fra|french)"
LANG_ES_EXPLICIT = r"(?:spa|esp|spanish|espanol|castellano|latino)"
LANG_DE_EXPLICIT = r"(?:ger|german)"
FLAG_ENG = r"(?:🇬🇧|🇺🇸)"
FLAG_IT = r"(?:🇮🇹)"
FLAG_ES = r"(?:🇪🇸)"
FLAG_FR = r"(?:🇫🇷)"
FLAG_DE = r"(?:🇩🇪)"

POSITIVE_PATTERNS = [
    re.compile(rf"\b{LANG_IT}\b", re.IGNORECASE),
    re.compile(FLAG_IT),
    re.compile(r"\b(?:it\s+(?:gb|uk|us|en|eng)|(?:gb|uk|us|en|eng)\s+it)\b", re.IGNORECASE),
    re.compile(r"\baudio\s*ita\b", re.IGNORECASE),
    re.compile(r"\bitalian\b", re.IGNORECASE),
    re.compile(rf"\bita\s*{AUDIO_CODECS}\b", re.IGNORECASE),
    re.compile(rf"\b(?:audio|lang|language)\s*{LANG_IT}\b", re.IGNORECASE),
    re.compile(rf"\b{LANG_IT}\s*(?:dub|dubbed|mux|multi)\b", re.IGNORECASE),
    re.compile(rf"\b(?:multi|multi-audio|dual(?:\s|-)?audio)\b.*\b{LANG_IT}\b", re.IGNORECASE),
    re.compile(rf"\b{LANG_IT}\b.*\b(?:multi|multi-audio|dual(?:\s|-)?audio)\b", re.IGNORECASE),
    re.compile(rf"\b(?:{LANG_IT})\s*(?:{LANG_EN}|{LANG_FR}|{LANG_ES}|{LANG_DE})\b", re.IGNORECASE),
    re.compile(rf"\b(?:{LANG_EN}|{LANG_FR}|{LANG_ES}|{LANG_DE})\s*(?:{LANG_IT})\b", re.IGNORECASE),
    re.compile(r"\bsub\s*ita\b", re.IGNORECASE),
    re.compile(r"\bsubs?\s*ita\b", re.IGNORECASE),
    re.compile(r"\bsottotitol[ia].*ita\b", re.IGNORECASE),
    re.compile(r"\bsoftsub\s*ita\b", re.IGNORECASE),
    re.compile(r"\bforced\s*ita\b", re.IGNORECASE),
    re.compile(r"\baccoppialo\b", re.IGNORECASE),
]

SUB_ONLY_PATTERNS = [
    re.compile(r"\bsub\s*ita\b", re.IGNORECASE),
    re.compile(r"\bsubs?\s*ita\b", re.IGNORECASE),
    re.compile(r"\bsottotitol[ia].*ita\b", re.IGNORECASE),
    re.compile(r"\bsoftsub\s*ita\b", re.IGNORECASE),
    re.compile(r"\bforced\s*ita\b", re.IGNORECASE),
]

NEGATIVE_PATTERNS = [
    re.compile(r"\bsub(?:bed)?\s*eng\b", re.IGNORECASE),
    re.compile(r"\benglish\b", re.IGNORECASE),
    re.compile(r"\beng\b", re.IGNORECASE),
    re.compile(r"\bvo\b", re.IGNORECASE),
    re.compile(r"\boriginal\s*audio\b", re.IGNORECASE),
    re.compile(r"\bvostfr\b", re.IGNORECASE),
    re.compile(r"\bvose\b", re.IGNORECASE),
]

AUDIO_ITA_PATTERN = re.compile(
    rf"\b(?:{LANG_IT}|audio\s*ita|ita\s*{AUDIO_CODECS}|(?:audio|lang|language)\s*{LANG_IT})\b",
    re.IGNORECASE,
)

ENGLISH_POSITIVE_PATTERNS = [
    re.compile(rf"\b{LANG_EN_EXPLICIT}\b", re.IGNORECASE),
    re.compile(FLAG_ENG),
    re.compile(r"\baudio\s*eng(?:lish)?\b", re.IGNORECASE),
    re.compile(rf"\beng\s*{AUDIO_CODECS}\b", re.IGNORECASE),
    re.compile(rf"\b(?:audio|lang|language)\s*{LANG_EN_EXPLICIT}\b", re.IGNORECASE),
    re.compile(rf"\b{LANG_EN_EXPLICIT}\s*(?:dub|dubbed|mux|multi)\b", re.IGNORECASE),
    re.compile(rf"\b(?:multi|multi-audio|dual(?:\s|-)?audio)\b.*\b{LANG_EN_EXPLICIT}\b", re.IGNORECASE),
    re.compile(rf"\b{LANG_EN_EXPLICIT}\b.*\b(?:multi|multi-audio|dual(?:\s|-)?audio)\b", re.IGNORECASE),
]

ENGLISH_SUB_ONLY_PATTERNS = [
    re.compile(r"\bsub(?:bed)?\s*eng\b", re.IGNORECASE),
    re.compile(r"\bsubs?\s*eng\b", re.IGNORECASE),
    re.compile(r"\benglish\s*subs?\b", re.IGNORECASE),
    re.compile(r"\bsoftsub\s*eng\b", re.IGNORECASE),
]

FOREIGN_LANGUAGE_HINT_PATTERNS = [
    re.compile(rf"\b{LANG_IT_EXPLICIT}\b", re.IGNORECASE),
    re.compile(rf"\b{LANG_FR_EXPLICIT}\b", re.IGNORECASE),
    re.compile(rf"\b{LANG_ES_EXPLICIT}\b", re.IGNORECASE),
    re.compile(rf"\b{LANG_DE_EXPLICIT}\b", re.IGNORECASE),
    re.compile(FLAG_IT),
    re.compile(FLAG_FR),
    re.compile(FLAG_ES),
    re.compile(FLAG_DE),
    re.compile(r"\bvostfr\b", re.IGNORECASE),
    re.compile(r"\bvose\b", re.IGNORECASE),
]

AUDIO_ENG_PATTERN = re.compile(
    rf"\b(?:audio\s*eng(?:lish)?|eng\s*{AUDIO_CODECS}|(?:audio|lang|language)\s*{LANG_EN_EXPLICIT}|{LANG_EN_EXPLICIT}\s*(?:dub|dubbed|mux|multi))\b",
    re.IGNORECASE,
)

_BAD_TOKENS_PATTERN = re.compile(
    r"(?<!\w)(?:" + "|".join(re.escape(token) for token in BAD_TOKENS) + r")(?!\w)",
    re.IGNORECASE,
)
_ITALIAN_BRANDS_PATTERN = re.compile(
    "(?:" + "|".join(re.escape(brand) for brand in ITALIAN_BRANDS) + ")",
    re.IGNORECASE,
)
_AUDIO_LANG_IT_PATTERN = re.compile(rf"\b(?:audio|lang|language)\s*{LANG_IT}\b", re.IGNORECASE)
_IT_DUB_PATTERN = re.compile(rf"\b{LANG_IT}\s*(?:dubbed|dub|mux|multi)\b", re.IGNORECASE)
_MULTI_AUDIO_PATTERN = re.compile(r"\b(?:multi|dual(?:\s|-)?audio)\b", re.IGNORECASE)
_LANG_IT_WORD_PATTERN = re.compile(rf"\b{LANG_IT}\b", re.IGNORECASE)
_IT_CODEC_PATTERN = re.compile(rf"\b{LANG_IT}\b.*\b(?:ac3|eac3|aac|dts|truehd|atmos)\b", re.IGNORECASE)
_EN_CODEC_PATTERN = re.compile(rf"\b{LANG_EN_EXPLICIT}\b.*\b(?:ac3|eac3|aac|dts|truehd|atmos)\b", re.IGNORECASE)
_MULTI_AUDIO_BROAD_PATTERN = re.compile(r"\b(?:multi|multi-audio|dual(?:\s|-)?audio)\b", re.IGNORECASE)
_DUB_BROAD_PATTERN = re.compile(r"\b(?:dub|dubbed|mux)\b", re.IGNORECASE)
_ORIGINAL_AUDIO_PATTERN = re.compile(r"\boriginal\s*audio\b", re.IGNORECASE)
_FLAG_ENG_PATTERN = re.compile(FLAG_ENG)
_FOREIGN_AUDIO_PATTERNS = (
    AUDIO_ITA_PATTERN,
    re.compile(rf"\b(?:audio\s*{LANG_FR_EXPLICIT}|(?:audio|lang|language)\s*{LANG_FR_EXPLICIT}|{LANG_FR_EXPLICIT}\s*(?:dub|dubbed|mux|multi))\b", re.IGNORECASE),
    re.compile(rf"\b(?:audio\s*{LANG_ES_EXPLICIT}|(?:audio|lang|language)\s*{LANG_ES_EXPLICIT}|{LANG_ES_EXPLICIT}\s*(?:dub|dubbed|mux|multi))\b", re.IGNORECASE),
    re.compile(rf"\b(?:audio\s*{LANG_DE_EXPLICIT}|(?:audio|lang|language)\s*{LANG_DE_EXPLICIT}|{LANG_DE_EXPLICIT}\s*(?:dub|dubbed|mux|multi))\b", re.IGNORECASE),
)


@lru_cache(maxsize=8192)
def normalize_text(text: str) -> str:
    """Normalizza testo rumoroso da release/torrent title."""
    if not text:
        return ""

    text = unicodedata.normalize("NFKD", text)
    text = "".join(ch for ch in text if not unicodedata.combining(ch))
    text = text.lower()

    text = (
        text.replace("_", " ")
        .replace(".", " ")
        .replace("-", " ")
        .replace("/", " ")
        .replace("\\", " ")
        .replace("+", " ")
        .replace("[", " ")
        .replace("]", " ")
        .replace("(", " ")
        .replace(")", " ")
    )

    text = re.sub(r"\s+", " ", text).strip()
    return text


def _contains_any_token(text: str, tokens: Iterable[str]) -> bool:
    return any(re.search(rf"(?<!\w){re.escape(token)}(?!\w)", text) for token in tokens)


def _contains_bad_token(text: str) -> bool:
    return bool(_BAD_TOKENS_PATTERN.search(text))


def _contains_italian_brand(text: str) -> bool:
    return bool(_ITALIAN_BRANDS_PATTERN.search(text))


def _full_text(title: str = "", filename: str = "") -> str:
    return normalize_text(f"{title} {filename}")


def contains_bad_release_terms(title: str = "", filename: str = "") -> bool:
    full_text = _full_text(title, filename)
    return _contains_bad_token(full_text)


def has_video_extension(filename: str) -> bool:
    filename = (filename or "").lower().strip()
    return filename.endswith(VIDEO_EXTENSIONS)


def is_sub_ita_only(title: str = "", filename: str = "") -> bool:
    full_text = _full_text(title, filename)
    return _is_sub_ita_only_from_normalized(full_text)


def _is_sub_ita_only_from_normalized(full_text: str) -> bool:
    has_sub = any(pattern.search(full_text) for pattern in SUB_ONLY_PATTERNS)
    has_audio_ita = bool(
        _AUDIO_LANG_IT_PATTERN.search(full_text)
        or _IT_DUB_PATTERN.search(full_text)
        or _IT_CODEC_PATTERN.search(full_text)
        or re.search(r"\bita\s*(?:aac|ac3|eac3|dd|ddp|dts|truehd|atmos)\b", full_text, re.IGNORECASE)
    )
    return has_sub and not has_audio_ita


def _is_sub_eng_only_from_normalized(full_text: str) -> bool:
    has_sub = any(pattern.search(full_text) for pattern in ENGLISH_SUB_ONLY_PATTERNS)
    has_audio_eng = bool(AUDIO_ENG_PATTERN.search(full_text))
    return has_sub and not has_audio_eng


def italian_confidence(title: str = "", filename: str = "") -> int:
    """
    Restituisce uno score 0..100.
    >= 55: molto probabile italiano
    >= 35: accettabile / sub ita / multi ita
    """
    full_text = _full_text(title, filename)
    if not full_text:
        return 0

    if _contains_bad_token(full_text):
        return 0

    score = 0

    if _contains_italian_brand(full_text):
        score += 40

    if re.search(FLAG_IT, full_text) or re.search(r"\b(?:it\s+(?:gb|uk|us|en|eng)|(?:gb|uk|us|en|eng)\s+it)\b", full_text, re.IGNORECASE):
        score += 38

    for pattern in POSITIVE_PATTERNS:
        if pattern.search(full_text):
            score += 24

    if _AUDIO_LANG_IT_PATTERN.search(full_text):
        score += 18

    if _IT_DUB_PATTERN.search(full_text):
        score += 18

    if _MULTI_AUDIO_PATTERN.search(full_text) and _LANG_IT_WORD_PATTERN.search(full_text):
        score += 12

    if _IT_CODEC_PATTERN.search(full_text):
        score += 10

    if any(pattern.search(full_text) for pattern in NEGATIVE_PATTERNS):
        score -= 16

    if _is_sub_ita_only_from_normalized(full_text):
        score -= 10
        score = max(score, 36)

    return max(0, min(score, 100))


def has_explicit_english_audio(title: str = "", filename: str = "") -> bool:
    full_text = _full_text(title, filename)
    if not full_text:
        return False
    if _is_sub_eng_only_from_normalized(full_text):
        return False
    return any(pattern.search(full_text) for pattern in ENGLISH_POSITIVE_PATTERNS) or bool(AUDIO_ENG_PATTERN.search(full_text))


def has_explicit_italian_audio(title: str = "", filename: str = "") -> bool:
    full_text = _full_text(title, filename)
    if not full_text:
        return False
    if _is_sub_ita_only_from_normalized(full_text):
        return False
    return any(pattern.search(full_text) for pattern in POSITIVE_PATTERNS[:10]) or bool(AUDIO_ITA_PATTERN.search(full_text))


def _has_release_signature(full_text: str) -> bool:
    return bool(
        re.search(r"\b(?:2160p|1080p|720p|480p|4k|uhd)\b", full_text)
        and re.search(r"\b(?:web[ .-]?dl|web[ .-]?rip|blu[ .-]?ray|bdrip|remux|x264|x265|h264|h265|hevc)\b", full_text)
    )


def _has_explicit_foreign_audio_without_english(full_text: str) -> bool:
    if has_explicit_english_audio(full_text, ""):
        return False
    return any(pattern.search(full_text) for pattern in _FOREIGN_AUDIO_PATTERNS)


def english_confidence(title: str = "", filename: str = "") -> int:
    """
    Restituisce uno score 0..100.
    In modalità ENG il file deve dichiarare in modo esplicito ENG/English
    oppure mostrare una bandiera inglese/americana. Le release neutre non bastano.
    """
    full_text = _full_text(title, filename)
    if not full_text:
        return 0

    if _contains_bad_token(full_text):
        return 0

    has_eng_marker = has_explicit_english_audio(title, filename)
    has_audio_ita = has_explicit_italian_audio(title, filename)
    has_sub_only_eng = _is_sub_eng_only_from_normalized(full_text)
    has_foreign_language = any(pattern.search(full_text) for pattern in FOREIGN_LANGUAGE_HINT_PATTERNS)

    if has_sub_only_eng:
        return 0

    if not has_eng_marker:
        return 0

    if _has_explicit_foreign_audio_without_english(full_text):
        return 0

    if _ORIGINAL_AUDIO_PATTERN.search(full_text) and not has_eng_marker:
        return 0

    score = 0

    for pattern in ENGLISH_POSITIVE_PATTERNS:
        if pattern.search(full_text):
            score += 16

    if has_eng_marker:
        score += 22

    if _EN_CODEC_PATTERN.search(full_text):
        score += 10

    if _MULTI_AUDIO_BROAD_PATTERN.search(full_text):
        score += 8

    if _DUB_BROAD_PATTERN.search(full_text):
        score += 5

    if has_audio_ita and has_eng_marker:
        score -= 6

    if has_foreign_language and not _FLAG_ENG_PATTERN.search(full_text):
        score -= 4

    if score < 35:
        return 0

    return max(0, min(score, 100))

def is_italian_content(title: str, filename: str) -> bool:
    """
    Compatibile con il codice esistente.
    True se il contenuto è verosimilmente in italiano o con sub ITA utili.
    """
    return italian_confidence(title, filename) >= 35


def is_english_content(title: str, filename: str) -> bool:
    """
    True se il contenuto ha un'indicazione esplicita di inglese.
    """
    return english_confidence(title, filename) > 0


def language_profile(title: str = "", filename: str = "", target_language: str = "ita") -> dict[str, object]:
    """Classifica la lingua senza mescolare audio certo e soli sottotitoli."""
    target = "eng" if str(target_language or "").strip().lower() == "eng" else "ita"
    full_text = _full_text(title, filename)
    if not full_text:
        return {"target": target, "score": 0, "class": "unknown", "audio": False, "sub_only": False, "reason": "empty"}

    if target == "eng":
        score = english_confidence(title, filename)
        sub_only = _is_sub_eng_only_from_normalized(full_text)
        audio = has_explicit_english_audio(title, filename)
        if audio and score >= 55:
            cls = "audio_strong"
        elif audio and score > 0:
            cls = "audio_weak"
        elif sub_only:
            cls = "sub_only"
        else:
            cls = "foreign_or_unknown"
        return {"target": target, "score": score, "class": cls, "audio": audio, "sub_only": sub_only, "reason": cls}

    score = italian_confidence(title, filename)
    sub_only = _is_sub_ita_only_from_normalized(full_text)
    audio = has_explicit_italian_audio(title, filename)
    brand = _contains_italian_brand(full_text)
    flag_or_combo = bool(
        re.search(FLAG_IT, full_text)
        or re.search(r"\b(?:it\s+(?:gb|uk|us|en|eng)|(?:gb|uk|us|en|eng)\s+it)\b", full_text, re.IGNORECASE)
    )

    if (audio or flag_or_combo or brand) and score >= 55:
        cls = "audio_strong"
    elif sub_only and not audio:
        cls = "sub_only"
    elif score >= 35:
        cls = "audio_weak"
    else:
        cls = "foreign_or_unknown"
    return {"target": target, "score": score, "class": cls, "audio": bool(audio or flag_or_combo or brand), "sub_only": sub_only, "reason": cls}
