import re
import unicodedata


def to_bold(text):
    """Converte usando una mappatura dizionario esatta per evitare caratteri strani"""
    if not text:
        return ""

    bold_map = {
        '0':'𝟬','1':'𝟭','2':'𝟮','3':'𝟯','4':'𝟰','5':'𝟱','6':'𝟲','7':'𝟳','8':'𝟴','9':'𝟵',
        'A':'𝗔','B':'𝗕','C':'𝗖','D':'𝗗','E':'𝗘','F':'𝗙','G':'𝗚','H':'𝗛','I':'𝗜','J':'𝗝','K':'𝗞','L':'𝗟','M':'𝗠','N':'𝗡','O':'𝗢','P':'𝗣','Q':'𝗤','R':'𝗥','S':'𝗦','T':'𝗧','U':'𝗨','V':'𝗩','W':'𝗪','X':'𝗫','Y':'𝗬','Z':'𝗭',
        'a':'𝗮','b':'𝗯','c':'𝗰','d':'𝗱','e':'𝗲','f':'𝗳','g':'𝗴','h':'𝗵','i':'𝗶','j':'𝗷','k':'𝗸','l':'𝗹','m':'𝗺','n':'𝗻','o':'𝗼','p':'𝗽','q':'𝗾','r':'𝗿','s':'𝘀','t':'𝘁','u':'𝘂','v':'𝘃','w':'𝘄','x':'𝘅','y':'𝘆','z':'𝘇'
    }

    return "".join(bold_map.get(c, c) for c in text)


RELEASE_METADATA_SPLIT_RE = re.compile(
    r"(?i)(?:\b(19\d{2}|20\d{2})\b|\b(?:2160p|1080p|720p|480p|4k|uhd)\b|\b(?:web[ .-]?dl|web[ .-]?rip|blu[ .-]?ray|bdrip|remux|x264|x265|h264|h265|hevc|hdr|dv|ddp|aac|ac3|dts|truehd)\b)"
)
SIZE_RE = re.compile(r"([\d]+(?:[.,]\d+)?)\s*([KMGT]I?B|[KMGT]B)", re.I)
PEERS_RE = re.compile(r"(?:👤|seeders?|peers?)\s*[:=]?\s*(\d+)", re.I)
SOURCE_LINE_RE = re.compile(r"(?:⚙️|⚙|source|provider|tracker)\s*[:=]?\s*([^\n]+)", re.I)
ALT_SPLIT_RE = re.compile(r"\s*/\s*|\s+\|\s+")
TECH_HINT_RE = re.compile(r"(?i)\b(?:2160p|1080p|720p|480p|4k|uhd|web[ .-]?dl|web[ .-]?rip|blu[ .-]?ray|bdrip|remux|x264|x265|h264|h265|hevc|ddp|aac|ac3|dts|truehd|hdr|dv)\b")
LATIN_RE = re.compile(r"[A-Za-z]")
NON_LATIN_RE = re.compile(r"[^\x00-\x7F]")


# --- PARSER DEI DATI ---

def parse_size(size_str: str) -> str:
    """Pulisce la stringa della dimensione."""
    if not size_str:
        return "N/A"
    return str(size_str).upper()


def _normalize_spaces(text: str) -> str:
    return re.sub(r"\s+", " ", str(text or "")).strip()


def _sanitize_title_piece(text: str) -> str:
    text = unicodedata.normalize("NFKC", str(text or ""))
    text = text.replace("_", " ").replace(".", " ")
    text = re.sub(r"\s+", " ", text).strip(" -–—|/\\")
    text = re.sub(r"\s*\[[^\]]+\]\s*$", "", text).strip()
    text = re.sub(r"\s*\([^)]*(?:extended|proper|repack|remux|web[ .-]?dl|blu[ .-]?ray|2160p|1080p|720p|480p)[^)]*\)\s*$", "", text, flags=re.I).strip()
    text = re.sub(r"\s*[([{]\s*$", "", text).strip(" -–—|/\\")
    return text


def _latin_score(text: str) -> int:
    return len(LATIN_RE.findall(text)) - len(NON_LATIN_RE.findall(text))


def _split_alternative_titles(text: str) -> list[str]:
    cleaned = _sanitize_title_piece(text)
    if not cleaned:
        return []
    parts = [part.strip() for part in ALT_SPLIT_RE.split(cleaned) if part.strip()]
    return parts or [cleaned]


def _strip_release_metadata(text: str) -> str:
    cleaned = _sanitize_title_piece(text)
    if not cleaned:
        return ""
    parts = RELEASE_METADATA_SPLIT_RE.split(cleaned, maxsplit=1)
    candidate = _normalize_spaces(parts[0] if parts else cleaned)
    if candidate:
        return candidate
    return cleaned


def _choose_best_title(original_title: str, original_name: str, content_language: str) -> str:
    raw_title_line = _normalize_spaces(str(original_title or "").splitlines()[0])
    raw_name_line = _normalize_spaces(str(original_name or "").splitlines()[0])

    candidates: list[str] = []
    for raw in (raw_title_line, raw_name_line):
        if not raw:
            continue
        parts = _split_alternative_titles(raw)
        if content_language == "eng" and len(parts) > 1:
            parts = sorted(parts, key=lambda item: (_latin_score(item), len(item)), reverse=True)
        candidates.extend(parts)
        stripped = _strip_release_metadata(raw)
        if stripped:
            candidates.append(stripped)

    best = ""
    best_score = -10**9
    for candidate in candidates:
        if not candidate:
            continue
        score = len(candidate)
        if content_language == "eng":
            score += _latin_score(candidate) * 3
        if TECH_HINT_RE.search(candidate):
            score -= 20
        if len(candidate.split()) >= 2:
            score += 4
        if candidate.isupper():
            score -= 3
        if score > best_score:
            best_score = score
            best = candidate

    best = _strip_release_metadata(best) if best else _strip_release_metadata(raw_name_line or raw_title_line)
    best = _sanitize_title_piece(best)
    return best or _sanitize_title_piece(raw_name_line or raw_title_line) or "Torrentio Release"


def _extract_resolution(text: str) -> str:
    lower = text.lower()
    if "2160p" in lower or "4k" in lower or "uhd" in lower:
        return "4K"
    if "1080p" in lower:
        return "1080p"
    if "720p" in lower:
        return "720p"
    if "480p" in lower:
        return "SD"
    return "UNK"


def _extract_codec(text: str) -> str:
    lower = text.lower()
    if "hevc" in lower or "x265" in lower or "h265" in lower:
        return "HEVC"
    if "avc" in lower or "h264" in lower or "x264" in lower:
        return "AVC"
    return "x264"


def _extract_hdr(text: str) -> str:
    lower = text.lower()
    hdr_tags = []
    if "dv" in lower or "dolby vision" in lower or "dovi" in lower:
        hdr_tags.append("DV")
    if "hdr" in lower:
        hdr_tags.append("HDR")

    hdr_tag = ""
    if "DV" in hdr_tags and "HDR" in hdr_tags:
        hdr_tag = "DV+HDR"
    elif hdr_tags:
        hdr_tag = hdr_tags[0]

    if "10bit" in lower:
        hdr_tag += "+10b" if hdr_tag else "10bit"
    return hdr_tag


def _extract_audio(text: str) -> str:
    lower = text.lower()
    if "ddp" in lower or "eac3" in lower:
        return "Dolby DDP"
    if "ac3" in lower or "dd5.1" in lower:
        return "Dolby Digital"
    if "truehd" in lower:
        return "TrueHD"
    if "dts" in lower:
        return "DTS"
    return "AAC"


def _extract_size(text: str) -> str:
    match = SIZE_RE.search(text)
    if not match:
        return "N/A"
    return f"{match.group(1).replace(',', '.')} {match.group(2).upper()}"


def _extract_peers(text: str) -> str:
    match = PEERS_RE.search(text)
    if match:
        return match.group(1)
    return "0"


def _extract_uploader(title: str, name: str) -> str:
    joined = "\n".join(part for part in [title, name] if part)
    match = SOURCE_LINE_RE.search(joined)
    if match:
        value = _sanitize_title_piece(match.group(1))
        if value:
            return value

    for line in reversed([ln.strip() for ln in str(title or "").splitlines() if ln.strip()]):
        cleaned = re.sub(r"^[^\w]+", "", line).strip()
        if not cleaned:
            continue
        if SIZE_RE.search(cleaned) or PEERS_RE.search(cleaned):
            continue
        if cleaned == str(title or "").splitlines()[0].strip():
            continue
        if len(cleaned) <= 40 and not TECH_HINT_RE.search(cleaned):
            return cleaned

    return "Torrentio"


def extract_stream_data(title: str, name: str, content_language: str = "ita"):
    combined = f"{title}\n{name}"
    display_title = _choose_best_title(title, name, content_language)

    return {
        "res": _extract_resolution(combined),
        "source": "WEB-DL" if re.search(r"(?i)\bweb\b", combined) else ("BluRay" if re.search(r"(?i)\b(?:blu[ .-]?ray|bdrip|remux)\b", combined) else "Source"),
        "codec": _extract_codec(combined),
        "hdr": _extract_hdr(combined),
        "audio": _extract_audio(combined),
        "peers": _extract_peers(combined),
        "size": _extract_size(combined),
        "uploader": _extract_uploader(title, name),
        "filename": display_title,
        "original_title": title,
    }



def _language_label(style: str, content_language: str) -> str:
    if str(content_language or "").strip().lower() == "eng":
        return "EN"
    if style == "torrentio":
        return "GB/IT"
    return "IT/GB"


# --- STILI DI FORMATTAZIONE ---

def style_torrenthan(data, provider_info, content_language="ita"):
    """
    Stile personalizzato Torrenthan con layout Premium e minimal.
    """
    prov_code = provider_info['code']
    left_icon = "☁"
    if prov_code == "RD":
        left_icon = "👑"
    elif prov_code == "TB":
        left_icon = "🧊"
    elif prov_code == "AD":
        left_icon = "🟡"
    elif prov_code == "PM":
        left_icon = "🟣"

    name = f"{left_icon} {prov_code} {provider_info['icon']}\nTorrenthan"

    tech_parts = [data['res'], data['source'], data['codec']]
    if data['hdr']:
        tech_parts.append(data['hdr'])
    tech_line = " ✦ ".join(part for part in tech_parts if part and part != "UNK")

    bold_title = to_bold(data['filename'])
    language_label = _language_label("torrenthan", content_language)

    title = (
        f"🎬 {bold_title}\n"
        f"✨ {tech_line}\n"
        f"🌍 {language_label} ｜ 🎵 {data['audio']}\n"
        f"📦 {data['size']} ｜ 🔥 {data['peers']}\n"
        f"📡 {data['uploader']}"
    )
    return name, title


def style_torrentio(data, provider_info, content_language="ita"):
    """
    Replica lo stile con titoli più puliti e leggibili.
    """
    prov_code = provider_info['code']
    tag = f"[{prov_code}+]" if prov_code != "P2P" else "[P2P]"

    name_lines = [tag, f"Torrenthan {data['res']}"]
    if data['hdr']:
        name_lines.append(data['hdr'])
    name = "\n".join(name_lines)

    title_lines = [f"🎬 {to_bold(data['filename'])}"]
    title_lines.append(f"🔥 {data['peers']} ｜ 📦 {data['size']} ｜ 📡 {data['uploader']}")
    title_lines.append(f"🌍 {_language_label('torrentio', content_language)} ｜ 🎵 {data['audio']}")
    title = "\n".join(title_lines)
    return name, title


# --- DISPATCHER ---

def format_display(stream, service, has_key, style="torrenthan", content_language="ita"):
    original_name = stream.get('name', '')
    original_title = stream.get('title', '')

    data = extract_stream_data(original_title, original_name, content_language=content_language)

    provider_info = {
        "code": "P2P",
        "icon": "👤"
    }

    if has_key:
        if service == 'realdebrid':
            provider_info = {"code": "RD", "icon": "⚡"}
        elif service == 'torbox':
            provider_info = {"code": "TB", "icon": "⚡"}
        elif service == 'alldebrid':
            provider_info = {"code": "AD", "icon": "⚡"}
        elif service == 'premiumize':
            provider_info = {"code": "PM", "icon": "⚡"}

    if style == "torrentio":
        name, title = style_torrentio(data, provider_info, content_language=content_language)
    else:
        name, title = style_torrenthan(data, provider_info, content_language=content_language)

    return name, title
