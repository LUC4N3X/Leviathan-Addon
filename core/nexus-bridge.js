const crypto = require("crypto");
const pLimitModule = require("p-limit");
const pLimit = typeof pLimitModule === "function" ? pLimitModule : pLimitModule.default;
const { LEGACY_BROWSER_PROFILES } = require('./browser_profiles');

const DEBUG_MODE = process.env.DEBUG_MODE === "true";

const EXTERNAL_ADDONS = {
    torrentio_main: {
        baseUrl: "https://thorrentan.elninhostre.dpdns.org/e30",
        name: "Torrentio Main",
        emoji: "🅣",
        timeout: Number(process.env.EXT_TORRENTIO_MAIN_TIMEOUT || 2200),
        priority: 1,
        maxFailures: 3,
        cooldownMs: Number(process.env.EXT_ADDON_COOLDOWN_MS || 30000)
    },
    torrentio_mirror: {
        baseUrl: "https://torrentio.strem.fun",
        name: "Torrentio Mirror",
        emoji: "🅣",
        timeout: Number(process.env.EXT_TORRENTIO_MIRROR_TIMEOUT || 2200),
        priority: 2,
        maxFailures: 3,
        cooldownMs: Number(process.env.EXT_ADDON_COOLDOWN_MS || 30000)
    }
    /* === MediaFusion disattivato ===
    ,
    mediafusion: {
        baseUrl: "https://mediafusionfortheweebs.midnightignite.me/D-FCO8JXfrGOKFpP-Rim96nHZU9epOb5RPbSpgkgVbYoR1NRJNR1C-9X4VDrUSJJNEvp5pk7CGvSLN7cUHUrth3QG8e3mSPa8Ind2k4VzVGFEa-310EjXdsXT_uUXGri86EVnnQ6f_9b0yoVTuVu7Aqk4uY8IXZp47-0FmuxgXX6wleis_0Evllc0v2wcrWIj-D5m3IZhI18CKHr-pUL5h61ZWcaRuxGjgwYK88Xy3PIN2U3YzTi4J9pazQBpCNDH-NpZPwk2RVnjs0WF7dRU5XD_D0robmhH9q0edoqaR_71u1j2y-XnxkwPNjg-o5Yb_",
        name: "MediaFusion",
        emoji: "🅜",
        timeout: Number(process.env.EXT_MEDIAFUSION_TIMEOUT || 1700),
        priority: 3,
        maxFailures: 4,
        cooldownMs: Number(process.env.EXT_ADDON_COOLDOWN_MS || 30000)
    }
    */
};

const KNOWN_PROVIDERS = [
    "ThePirateBay", "ilCorSaRoNeRo", "1337x", "Cyber", "Torrent9", "Wolfmax4K",
    "Comando", "YTS", "YIFY", "BestTorrents", "Knaben", "BTM", "Byndr", "Wadu",
    "Sp33dy94", "MIRCrew", "Cosmo Crew", "Ph4nt0mx", "Nueng", "Rutor",
    "TorrentGalaxy", "TGx", "RARBG", "EZTV", "Nyaa", "Erai-raws", "SubsPlease",
    "Judas", "QxR", "Tigole", "PSA", "EAGLE", "ICV", "MegaPhone", "iDN_CreW",
    "MUX", "DDN", "DLMux", "WebMux", "TRIDIM", "Lidri", "Ghizzo", "MeGaPeER",
    "Papeete", "Vics", "Gaiage", "Dtone", "BlackBit", "Pantry", "Bric", "USAbit",
    "Uindex", "Contribution Stream"
].sort((a, b) => b.length - a.length);

const REGEX_AUDIO_ITA = /\b(?:ITA(?:LIAN)?(?:\s*(?:AUDIO|DDP|AAC|AC3|EAC3|ATMOS|TRUEHD|DTS(?:-?HD)?))?|MULTI\s*ITA|DUAL\s*AUDIO\s*ITA|TRUE\s*ITALIAN|AUDIO\s*ITA|ITA\s*AC3|ITA\s*AAC|ITA\s*DDP)\b/i;
const REGEX_SUB_ITA = /\b(?:SUB[-.\s_]*ITA|SOFTSUB[-.\s_]*ITA|VOST(?:ITA)?|ITALIAN\s*SUBS?)\b/i;
const REGEX_TRUSTED_ITA = /\b(?:CORSARO|ICV|MEGAPHONE|IDN[_\s-]*CREW|DDN|MUX(?:\s*ITA)?|TRIDIM|LUX|WMS|MIRCREW|CINEFILE)\b/i;
const REGEX_NEGATIVE_LANGUAGE = /\b(?:TRUEFRENCH|FRENCH|GERMAN|SPANISH|LATINO|RUSSIAN|POLISH|HINDI|TAMIL|TELUGU|KOREAN|JAPANESE|ENG(?:LISH)?\s*ONLY)\b/i;
const REGEX_MULTI_LANGUAGE = /\b(?:MULTI|DUAL\s*AUDIO|VOST)\b/i;
const VIDEO_FILE_REGEX = /\.(mkv|mp4|avi|mov|wmv|flv|webm|m4v|ts|m2ts)$/i;
const SIZE_REGEX = /(?:📦|💾|💽|Size:?|Dimensione:?|File\s*Size:?|Peso:?)[\s:]*([\d.,]+)\s*(B|KB|MB|GB|TB|KIB|MIB|GIB|TIB)/i;
const SEEDERS_REGEX = /(?:👤|👥|Seeders?:?|Peers?:?)\s*[:\-]?\s*(\d+)/i;
const QUALITY_PATTERNS = [
    { regex: /\b(?:2160p|4k|uhd)\b/i, label: "2160p", score: 40 },
    { regex: /\b1080p\b/i, label: "1080p", score: 30 },
    { regex: /\b720p\b/i, label: "720p", score: 20 },
    { regex: /\b(?:480p|sd)\b/i, label: "480p", score: 10 }
];

const FETCH_CACHE_TTL = Number(process.env.EXTERNAL_ADDONS_CACHE_TTL || 30000);
const NEGATIVE_CACHE_TTL = Number(process.env.EXTERNAL_ADDONS_NEGATIVE_CACHE_TTL || 12000);
const MAX_TRACKERS_IN_MAGNET = Number(process.env.EXTERNAL_ADDONS_MAX_TRACKERS || 10);
const MAX_CONCURRENCY = Number(process.env.EXTERNAL_ADDONS_MAX_CONCURRENCY || 3);

const fetchLimiter = pLimit(MAX_CONCURRENCY);
const fetchCache = new Map();
const inflightFetches = new Map();
const addonHealth = new Map();

// ─────────────────────────────────────────────────────────────────────────────
// Browser fingerprint pools — rotati ad ogni richiesta
// ─────────────────────────────────────────────────────────────────────────────

const BROWSER_PROFILES = LEGACY_BROWSER_PROFILES;

/**
 * Sceglie un profilo in modo pseudo-casuale ma deterministico per addonKey+id,
 * così la stessa risorsa usa sempre lo stesso "browser" nella stessa sessione
 * (più naturale), ma profili diversi tra addon diversi.
 */
function pickBrowserProfile(addonKey, id) {
    const seed = crypto.createHash("sha1").update(`${addonKey}:${id}`).digest("hex");
    const idx = parseInt(seed.slice(0, 4), 16) % BROWSER_PROFILES.length;
    return BROWSER_PROFILES[idx];
}

/**
 * Costruisce un oggetto headers HTTP completo e coerente con il profilo scelto.
 * - Aggiunge Referer plausibile (stremio.com o il dominio dell'addon stesso)
 * - Aggiunge Connection: keep-alive
 * - Aggiunge DNT solo per Firefox (comportamento reale)
 * - Evita header superflui che i veri browser non mandano
 */
function buildBrowserHeaders(profile, targetUrl) {
    let origin;
    try { origin = new URL(targetUrl).origin; } catch { origin = "https://stremio.com"; }

    const headers = {
        "User-Agent": profile.userAgent,
        "Accept": profile.accept,
        "Accept-Language": profile.acceptLanguage,
        "Accept-Encoding": "gzip, deflate, br",
        "Connection": "keep-alive",
        "Cache-Control": "no-cache",
        "Pragma": "no-cache",
        "Sec-Fetch-Dest": profile.secFetchDest,
        "Sec-Fetch-Mode": profile.secFetchMode,
        "Sec-Fetch-Site": profile.secFetchSite,
        "Sec-Fetch-User": profile.secFetchUser,
        // Referer: simula arrivo da Stremio web o dall'addon stesso
        "Referer": `${origin}/`
    };

    // Chromium-only: Sec-CH-UA headers
    if (profile.secChUa) {
        headers["Sec-CH-UA"] = profile.secChUa;
        headers["Sec-CH-UA-Mobile"] = profile.secChUaMobile;
        headers["Sec-CH-UA-Platform"] = profile.secChUaPlatform;
    }

    // Firefox manda DNT, Chrome no (nella maggior parte dei casi)
    if (profile.name.startsWith("firefox")) {
        headers["DNT"] = "1";
        headers["Upgrade-Insecure-Requests"] = "1";
    }

    // Chrome e Safari mandano Upgrade-Insecure-Requests su navigate
    if (profile.name.startsWith("chrome") || profile.name.startsWith("safari")) {
        headers["Upgrade-Insecure-Requests"] = "1";
    }

    return headers;
}

// ─────────────────────────────────────────────────────────────────────────────
// Jitter adattivo: più lento sotto stress, più veloce in condizioni normali
// ─────────────────────────────────────────────────────────────────────────────

function computeJitter(addonKey) {
    const state = addonHealth.get(addonKey);
    const failures = state?.failures || 0;
    // Base: 80–280ms. Ogni failure aggiunge 100ms fino a +500ms extra
    const base = 80 + Math.floor(Math.random() * 200);
    const extra = Math.min(failures * 100, 500);
    return base + extra;
}

// ─────────────────────────────────────────────────────────────────────────────
// Utility
// ─────────────────────────────────────────────────────────────────────────────

function now() { return Date.now(); }
function debugLog(...args) { if (DEBUG_MODE) console.log(...args); }

function getCache(map, key) {
    const hit = map.get(key);
    if (!hit) return null;
    if (hit.expiresAt <= now()) { map.delete(key); return null; }
    return hit.value;
}

function setCache(map, key, value, ttl) {
    if (!ttl || ttl <= 0) return value;
    map.set(key, { value, expiresAt: now() + ttl });
    if (map.size > 600) pruneCache(map);
    return value;
}

function pruneCache(map) {
    const ts = now();
    for (const [key, value] of map.entries()) {
        if (!value || value.expiresAt <= ts) map.delete(key);
    }
    while (map.size > 450) {
        const firstKey = map.keys().next().value;
        if (firstKey === undefined) break;
        map.delete(firstKey);
    }
}

function normalizeText(value) {
    return String(value || "").replace(/[\u2010-\u2015]/g, "-").replace(/[|_]+/g, " ").replace(/\s+/g, " ").trim();
}

function normalizeForComparison(value) {
    return normalizeText(value).normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toUpperCase();
}

function getStreamText(stream) {
    return normalizeText([
        stream.title, stream.name, stream.description,
        stream.behaviorHints?.filename, stream.behaviorHints?.folderName,
        stream.filename, stream.provider
    ].filter(Boolean).join(" "));
}

function analyzeItalianSignals(stream) {
    const fullText = normalizeForComparison(getStreamText(stream));
    if (!fullText) return { isItalian: false, hasAudioItalian: false, hasSubItalian: false, hasTrustedItalian: false, hasNegativeLanguage: false, confidence: 0, reason: "empty" };

    const hasAudioItalian = REGEX_AUDIO_ITA.test(fullText);
    const hasSubItalian = REGEX_SUB_ITA.test(fullText);
    const hasTrustedItalian = REGEX_TRUSTED_ITA.test(fullText);
    const hasNegativeLanguage = REGEX_NEGATIVE_LANGUAGE.test(fullText);
    const hasMultiLanguage = REGEX_MULTI_LANGUAGE.test(fullText);

    let confidence = 0;
    const reasons = [];

    if (hasAudioItalian) { confidence += 100; reasons.push("audio"); }
    if (hasTrustedItalian) { confidence += 35; reasons.push("trusted"); }
    if (hasSubItalian) { confidence += 18; reasons.push("subs"); }
    if (hasMultiLanguage && hasAudioItalian) { confidence += 12; reasons.push("multi"); }
    if (hasNegativeLanguage && !hasAudioItalian && !hasTrustedItalian) { confidence -= 70; reasons.push("negative"); }

    return {
        isItalian: confidence >= 20 || hasAudioItalian || (hasTrustedItalian && !hasNegativeLanguage),
        hasAudioItalian, hasSubItalian, hasTrustedItalian, hasNegativeLanguage, confidence,
        reason: reasons.join("|") || "none"
    };
}

function isItalianContent(stream) { return analyzeItalianSignals(stream).isItalian; }

function extractInfoHash(stream) {
    const candidates = [
        stream.infoHash, stream.behaviorHints?.infoHash, stream.behaviorHints?.magnet,
        stream.magnet, stream.url, ...(Array.isArray(stream.sources) ? stream.sources : [])
    ].filter(Boolean).map(value => String(value));

    for (const candidate of candidates) {
        const match = candidate.match(/btih:([A-Fa-f0-9]{40}|[A-Za-z2-7]{32})/i);
        if (match) return match[1].toUpperCase();
        if (/^[A-Fa-f0-9]{40}$/.test(candidate)) return candidate.toUpperCase();
        if (/^[A-Za-z2-7]{32}$/.test(candidate)) return candidate.toUpperCase();
    }
    return null;
}

function extractQuality(text) {
    const normalized = normalizeText(text);
    for (const item of QUALITY_PATTERNS) {
        if (item.regex.test(normalized)) return item.label.toLowerCase();
    }
    return "";
}

function extractSeeders(text, stream = {}) {
    if (Number.isFinite(stream.seeders) && stream.seeders >= 0) return stream.seeders;
    if (Number.isFinite(stream.peers) && stream.peers >= 0) return stream.peers;
    const normalized = normalizeText(text);
    const match = normalized.match(SEEDERS_REGEX);
    return match ? parseInt(match[1], 10) || 0 : 0;
}

function parseSizeParts(value, unit) {
    const parsedValue = parseFloat(String(value).replace(",", "."));
    const normalizedUnit = String(unit || "").toUpperCase();
    if (!Number.isFinite(parsedValue) || parsedValue <= 0) return 0;
    const multipliers = { B: 1, KB: 1024, KIB: 1024, MB: 1024 ** 2, MIB: 1024 ** 2, GB: 1024 ** 3, GIB: 1024 ** 3, TB: 1024 ** 4, TIB: 1024 ** 4 };
    return Math.round(parsedValue * (multipliers[normalizedUnit] || 1));
}

function extractSize(text, stream = {}) {
    const hintedSize = stream.behaviorHints?.videoSize || stream.video_size || stream.videoSize || stream.mainFileSize || stream.sizeBytes;
    if (Number.isFinite(hintedSize) && hintedSize > 0) return { formatted: formatBytes(hintedSize), bytes: hintedSize };

    const normalized = normalizeText(text);
    const match = normalized.match(SIZE_REGEX) || normalized.match(/([\d.,]+)\s*(TB|GB|MB|KB|TIB|GIB|MIB|KIB)\b/i);
    if (!match) return { formatted: "", bytes: 0 };

    const bytes = parseSizeParts(match[1], match[2]);
    if (bytes <= 0) return { formatted: "", bytes: 0 };
    return { formatted: `${parseFloat(String(match[1]).replace(",", "."))} ${String(match[2]).toUpperCase().replace("IB", "B")}`, bytes };
}

function extractRealProvider(text) {
    const normalized = normalizeForComparison(text);
    if (!normalized) return null;
    for (const provider of KNOWN_PROVIDERS) {
        if (normalized.includes(normalizeForComparison(provider))) return provider;
    }
    const tailToken = normalized.match(/\b([A-Z0-9][A-Z0-9 _-]{2,})\b$/);
    return tailToken ? tailToken[1].trim() : null;
}

function normalizeMediaFusionProvider(provider) {
    if (!provider) return provider;
    if (/^Contribution Stream\b/i.test(provider)) return "Contribution Stream";
    return provider;
}

function extractPackTitle(stream) {
    const text = normalizeText(stream.title || stream.description || "");
    const match = text.match(/📁\s*([^\n]+)/);
    if (match) return match[1].trim();
    const folderName = normalizeText(stream.behaviorHints?.folderName || "");
    if (folderName && !VIDEO_FILE_REGEX.test(folderName)) return folderName;
    return null;
}

function extractFilename(stream) {
    const hintedFilename = normalizeText(stream.behaviorHints?.filename || stream.filename || "");
    if (hintedFilename) return hintedFilename;
    const text = normalizeText(stream.title || stream.description || "");
    const match = text.match(/📄\s*([^\n]+)/);
    if (match) return match[1].trim();
    return normalizeText(stream.name || "");
}

function maskToken(value) {
    const token = String(value || "");
    return token.length <= 8 ? "***" : `${token.slice(0, 3)}***${token.slice(-3)}`;
}

function hashConfigSignature(value) {
    return crypto.createHash("sha1").update(String(value || "")).digest("hex").slice(0, 12);
}

function getTorrentioCredential(userConfig, service) {
    if (!userConfig || !service) return null;
    const configByService = {
        rd: userConfig.rd || userConfig.realdebrid || userConfig.key,
        tb: userConfig.tb || userConfig.torbox || userConfig.key
    };
    return configByService[service] || null;
}

function encodeBase64Url(data) {
    return Buffer.from(String(data || "")).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function buildTorrentioBaseUrl(baseUrl, userConfig) {
    const service = userConfig?.service;
    const apiKey = getTorrentioCredential(userConfig, service);
    if (!service || !apiKey) return baseUrl;

    const torrentioConf = {};
    if (service === "rd") torrentioConf.realdebrid = apiKey;
    else if (service === "tb") torrentioConf.torbox = apiKey;
    else return baseUrl;

    const encodedConf = encodeBase64Url(JSON.stringify(torrentioConf));

    try {
        const url = new URL(String(baseUrl || ""));
        const segments = url.pathname.split("/").filter(Boolean);
        const lastSegment = segments[segments.length - 1];
        if (lastSegment && /^[A-Za-z0-9_-]{2,}$/.test(lastSegment)) {
            segments[segments.length - 1] = encodedConf;
        } else {
            segments.push(encodedConf);
        }
        url.pathname = `/${segments.join("/")}`;
        return url.toString().replace(/\/+$/, "");
    } catch {
        const trimmed = String(baseUrl || "").replace(/\/+$/, "");
        return `${trimmed}/${encodedConf}`;
    }
}

function sanitizeFetchType(type, id) {
    const rawType = String(type || "").trim().toLowerCase();
    const rawId = String(id || "");
    if (rawType === "anime" || rawId.startsWith("kitsu:")) return "series";
    return rawType || "movie";
}

function sanitizePathSegment(value) { return encodeURIComponent(String(value || "").trim()); }
function normalizeAddonUrl(baseUrl) { return baseUrl ? String(baseUrl).replace(/\/+$/, "") : null; }

function getAddonHealth(addonKey) {
    const state = addonHealth.get(addonKey);
    if (!state) {
        const initial = { failures: 0, cooldownUntil: 0, lastLatency: 0, lastError: null };
        addonHealth.set(addonKey, initial);
        return initial;
    }
    return state;
}

function registerAddonFailure(addonKey, addon, errorMessage) {
    const state = getAddonHealth(addonKey);
    state.failures += 1;
    state.lastError = errorMessage || "Unknown error";
    if (state.failures >= (addon.maxFailures || 3)) state.cooldownUntil = now() + (addon.cooldownMs || 30000);
    addonHealth.set(addonKey, state);
}

function registerAddonSuccess(addonKey, latency) {
    const state = getAddonHealth(addonKey);
    state.failures = 0;
    state.cooldownUntil = 0;
    state.lastLatency = latency || 0;
    state.lastError = null;
    addonHealth.set(addonKey, state);
}

function shouldSkipAddon(addonKey, addon) {
    const state = getAddonHealth(addonKey);
    if (state.cooldownUntil > now()) {
        debugLog(`⏭️ [${addon.name}] skipped due to cooldown`);
        return true;
    }
    return false;
}

function buildAddonCacheKey(addonKey, type, id, options = {}) {
    const conf = options.userConfig || {};
    const service = conf.service || "";
    const token = getTorrentioCredential(conf, service) || "";
    return JSON.stringify({
        addonKey, type: sanitizeFetchType(type, id), id: String(id || ""),
        onlyItalian: options.onlyItalian !== false,
        minConfidence: Number(options.minimumItalianConfidence || 20),
        service, tokenSig: token ? hashConfigSignature(token) : ""
    });
}

function formatBytes(bytes, decimals = 2) {
    const value = Number(bytes);
    if (!Number.isFinite(value) || value <= 0) return "";
    const k = 1024;
    const dm = decimals < 0 ? 0 : decimals;
    const sizes = ["Bytes", "KB", "MB", "GB", "TB"];
    const i = Math.min(Math.floor(Math.log(value) / Math.log(k)), sizes.length - 1);
    return `${parseFloat((value / (k ** i)).toFixed(dm))} ${sizes[i]}`;
}

function buildMagnetLink(infoHash, sources, displayName = "") {
    if (!infoHash) return null;
    let magnet = `magnet:?xt=urn:btih:${infoHash}`;
    if (displayName) magnet += `&dn=${encodeURIComponent(displayName)}`;

    const trackers = Array.isArray(sources)
        ? sources.filter(source => typeof source === "string" && /^(tracker:|udp:\/\/|http:\/\/|https:\/\/)/.test(source))
            .map(source => source.replace(/^tracker:/, "")).filter(Boolean)
        : [];

    for (const tracker of [...new Set(trackers)].slice(0, MAX_TRACKERS_IN_MAGNET)) {
        magnet += `&tr=${encodeURIComponent(tracker)}`;
    }
    return magnet;
}

function extractVideoTags(text) {
    const normalized = normalizeText(text);
    const tags = [];
    if (/\b(?:REMUX)\b/i.test(normalized)) tags.push("REMUX");
    if (/\b(?:WEB[- .]?DL|WEBRIP)\b/i.test(normalized)) tags.push("WEB");
    if (/\b(?:BLURAY|BDRIP|BRRIP)\b/i.test(normalized)) tags.push("BLURAY");
    if (/\b(?:HDR10?\+?|HDR)\b/i.test(normalized)) tags.push("HDR");
    if (/\b(?:DV|DOLBY\s*VISION)\b/i.test(normalized)) tags.push("DV");
    if (/\b(?:X265|HEVC|H265)\b/i.test(normalized)) tags.push("HEVC");
    if (/\b(?:X264|H264|AVC)\b/i.test(normalized)) tags.push("H264");
    return tags.join(" ");
}

function scoreNormalizedStream(normalized) {
    const italian = normalized.languageInfo?.confidence || 0;
    const quality = (() => {
        const matched = QUALITY_PATTERNS.find(item => item.label.toLowerCase() === String(normalized.quality || "").toLowerCase());
        return matched ? matched.score : 0;
    })();
    const seeders = Math.min(30, Math.round(Math.log2((normalized.seeders || 0) + 1) * 4));
    const size = normalized.mainFileSize > 0 ? Math.min(18, Math.round(Math.log10(normalized.mainFileSize))) : 0;
    const providerBonus = normalized.externalProvider ? 8 : 0;
    const packBonus = normalized.potentialPack ? 3 : 0;
    return italian + quality + seeders + size + providerBonus + packBonus;
}

function normalizeExternalStream(stream, addonKey) {
    const addon = EXTERNAL_ADDONS[addonKey];
    if (!addon || !stream || typeof stream !== "object") return null;

    const text = getStreamText(stream);
    const infoHash = extractInfoHash(stream);
    const rawUrl = stream.url || null;
    if (!infoHash && !rawUrl) return null;

    const filename = extractFilename(stream);
    const packTitle = extractPackTitle(stream);
    const preferredTitle = packTitle || filename || normalizeText(stream.name || stream.title || "");
    if (!preferredTitle) return null;

    const quality = extractQuality(`${preferredTitle} ${text}`) || String(stream.resolution || "").replace(/[^0-9kp]/gi, "").toLowerCase() || "";
    const sizeInfo = extractSize(text, stream);
    const seeders = extractSeeders(text, stream);
    const languageInfo = analyzeItalianSignals(stream);

    let originalProvider = extractRealProvider(text);
    if (addonKey === "mediafusion") originalProvider = normalizeMediaFusionProvider(originalProvider || null);

    const techTags = extractVideoTags(text);
    let sizeBytes = sizeInfo.bytes;
    if (Number.isFinite(stream.behaviorHints?.videoSize) && stream.behaviorHints.videoSize > 0) sizeBytes = stream.behaviorHints.videoSize;
    if (Number.isFinite(stream.video_size) && stream.video_size > 0) sizeBytes = stream.video_size;

    const normalizedFileIdx = Number.isInteger(stream.fileIdx) ? stream.fileIdx : -1;
    const magnetLink = buildMagnetLink(infoHash, stream.sources, preferredTitle);

    const normalized = {
        infoHash, fileIdx: normalizedFileIdx, title: preferredTitle, filename, websiteTitle: preferredTitle,
        file_title: filename, quality, size: sizeInfo.formatted || formatBytes(sizeBytes), mainFileSize: sizeBytes,
        seeders: seeders || 0, leechers: 0, rawDescription: text,
        potentialPack: Boolean(packTitle) || (filename && text && !text.startsWith(filename) && text.length > filename.length + 20),
        packTitle, source: originalProvider ? `${addon.name} (${originalProvider})` : addon.name,
        externalAddon: addonKey, externalProvider: originalProvider, sourceEmoji: addon.emoji, magnetLink, url: rawUrl,
        isCached: true, cacheState: "cached",
        pubDate: new Date().toISOString(), isItalian: languageInfo.isItalian, hasItalianAudio: languageInfo.hasAudioItalian,
        hasItalianSubs: languageInfo.hasSubItalian, languageInfo, techTags
    };

    normalized._score = scoreNormalizedStream(normalized);
    normalized._dedupeKey = normalized.infoHash ? `${normalized.infoHash}:${normalized.fileIdx}` : `${normalizeForComparison(normalized.title)}|${normalized.url || ""}`;
    return normalized;
}

function mergeNormalizedStream(base, candidate) {
    const winner = (candidate._score || 0) > (base._score || 0) ? candidate : base;
    const loser = winner === base ? candidate : base;

    winner.seeders = Math.max(winner.seeders || 0, loser.seeders || 0);
    winner.mainFileSize = Math.max(winner.mainFileSize || 0, loser.mainFileSize || 0);
    winner.size = winner.size || loser.size;
    winner.url = winner.url || loser.url;
    winner.magnetLink = winner.magnetLink || loser.magnetLink;
    winner.externalProvider = winner.externalProvider || loser.externalProvider;
    winner.source = winner.source || loser.source;
    winner.hasItalianAudio = winner.hasItalianAudio || loser.hasItalianAudio;
    winner.hasItalianSubs = winner.hasItalianSubs || loser.hasItalianSubs;
    winner.isItalian = winner.isItalian || loser.isItalian;
    winner._score = Math.max(winner._score || 0, loser._score || 0);
    return winner;
}

function dedupeNormalizedStreams(streams) {
    const bestByKey = new Map();
    for (const stream of streams) {
        if (!stream) continue;
        const key = stream._dedupeKey || `${normalizeForComparison(stream.title)}|${stream.url || ""}`;
        const existing = bestByKey.get(key);
        if (!existing) { bestByKey.set(key, stream); continue; }
        bestByKey.set(key, mergeNormalizedStream(existing, stream));
    }
    return [...bestByKey.values()].sort((a, b) => {
        if ((b._score || 0) !== (a._score || 0)) return (b._score || 0) - (a._score || 0);
        if ((b.seeders || 0) !== (a.seeders || 0)) return (b.seeders || 0) - (a.seeders || 0);
        return (b.mainFileSize || 0) - (a.mainFileSize || 0);
    });
}

function passesItalianFilter(stream, options = {}) {
    if (options.onlyItalian === false) return true;
    const minimumConfidence = Number(options.minimumItalianConfidence || 20);
    const analysis = analyzeItalianSignals(stream);
    return analysis.isItalian && analysis.confidence >= minimumConfidence;
}

// ─────────────────────────────────────────────────────────────────────────────
// Core fetch — got-scraping + TLS fingerprint + headers browser-grade
// ─────────────────────────────────────────────────────────────────────────────

async function fetchExternalAddon(addonKey, type, id, options = {}) {
    const addon = EXTERNAL_ADDONS[addonKey];
    if (!addon) {
        console.error(`❌ [External] Unknown addon: ${addonKey}`);
        return [];
    }

    if (shouldSkipAddon(addonKey, addon)) return [];

    const cacheKey = buildAddonCacheKey(addonKey, type, id, options);
    const cached = getCache(fetchCache, cacheKey);
    if (cached) return cached;

    const inflight = inflightFetches.get(cacheKey);
    if (inflight) return inflight;

    const task = fetchLimiter(async () => {
        let baseUrl = normalizeAddonUrl(addon.baseUrl);
        if (addonKey.includes("torrentio")) baseUrl = buildTorrentioBaseUrl(baseUrl, options.userConfig || null);
        if (!baseUrl) return [];

        const fetchType = sanitizeFetchType(type, id);
        const safeId = sanitizePathSegment(id);
        const url = `${baseUrl}/stream/${fetchType}/${safeId}.json`;

        debugLog(`🌐 [${addon.name}] Fetching ${fetchType}/${id}`);
        const startedAt = now();

        try {
            // Jitter adattivo: più failures → più attesa → meno sospetto
            const jitter = computeJitter(addonKey);
            await new Promise(resolve => setTimeout(resolve, jitter));

            // Import ESM dinamico (got-scraping è ESM-only)
            const { gotScraping } = await import("got-scraping");

            // Fingerprint browser coerente per questo addon+id
            const profile = pickBrowserProfile(addonKey, String(id));
            const headers = buildBrowserHeaders(profile, url);

            debugLog(`🕵️ [${addon.name}] Profile: ${profile.name}, jitter: ${jitter}ms`);

            const response = await gotScraping({
                url,
                method: "GET",
                headers,                         // Header browser-grade iniettati manualmente
                timeout: { request: addon.timeout },
                retry: { limit: 0 },              // Nessun retry automatico
                // got-scraping gestisce internamente:
                //   - TLS ClientHello spoofing (JA3/JA4 fingerprint)
                //   - HTTP/2 con ALPN negotiation
                //   - Ordine header conforme al browser scelto
                headerGeneratorOptions: {
                    browsers: [{ name: profile.name.startsWith("firefox") ? "firefox" : profile.name.startsWith("safari") ? "safari" : "chrome" }],
                    devices: [profile.name.includes("android") || profile.name.includes("ios") ? "mobile" : "desktop"],
                    locales: ["it-IT", "en-US"],
                    operatingSystems: [
                        profile.name.includes("windows") ? "windows" :
                        profile.name.includes("android") ? "android" :
                        "macos"
                    ]
                },
                decompress: true  // accetta gzip/br come un browser reale
            });

            // Parsing sicuro
            let data;
            try {
                data = JSON.parse(response.body);
            } catch {
                throw new Error(`Invalid JSON response (status ${response.statusCode})`);
            }

            const streams = Array.isArray(data?.streams) ? data.streams : [];
            const countBefore = streams.length;

            const filteredStreams = streams.filter(stream => passesItalianFilter(stream, options));
            debugLog(`🇮🇹 [${addon.name}] Filter ${countBefore} -> ${filteredStreams.length}`);

            const normalized = dedupeNormalizedStreams(
                filteredStreams.map(stream => normalizeExternalStream(stream, addonKey)).filter(Boolean)
            );

            registerAddonSuccess(addonKey, now() - startedAt);
            const ttl = normalized.length > 0 ? FETCH_CACHE_TTL : NEGATIVE_CACHE_TTL;
            setCache(fetchCache, cacheKey, normalized, ttl);
            return normalized;

        } catch (error) {
            const isTimeout = error.name === "TimeoutError" || error.code === "ETIMEDOUT" || error.code === "ESOCKETTIMEDOUT";
            const errorMessage = isTimeout
                ? `Timeout after ${addon.timeout}ms`
                : (error?.message || String(error));

            registerAddonFailure(addonKey, addon, errorMessage);

            if (isTimeout) console.error(`⏱️ [${addon.name}] ${errorMessage}`);
            else console.error(`❌ [${addon.name}] Error: ${errorMessage}`);

            setCache(fetchCache, cacheKey, [], NEGATIVE_CACHE_TTL);
            return [];
        }
    });

    inflightFetches.set(cacheKey, task);
    try {
        return await task;
    } finally {
        inflightFetches.delete(cacheKey);
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Aggregatori pubblici
// ─────────────────────────────────────────────────────────────────────────────

async function fetchAllExternalAddons(type, id, options = {}) {
    const requestedAddons = Array.isArray(options.enabledAddons) && options.enabledAddons.length > 0
        ? options.enabledAddons : Object.keys(EXTERNAL_ADDONS);

    const enabledAddons = requestedAddons
        .filter(addonKey => EXTERNAL_ADDONS[addonKey])
        .sort((a, b) => EXTERNAL_ADDONS[a].priority - EXTERNAL_ADDONS[b].priority);

    if (enabledAddons.length === 0) return {};

    debugLog(`🔗 [External Addons] Fetching from: ${enabledAddons.join(", ")}`);
    const startTime = now();

    const promises = enabledAddons.map(async addonKey => ({
        addonKey, results: await fetchExternalAddon(addonKey, type, id, options)
    }));

    const settledResults = await Promise.allSettled(promises);
    const resultsByAddon = {};
    let totalResults = 0;

    for (const result of settledResults) {
        if (result.status === "fulfilled") {
            const { addonKey, results } = result.value;
            resultsByAddon[addonKey] = results;
            totalResults += results.length;
        } else {
            console.error("❌ [External] Promise rejected:", result.reason);
        }
    }

    debugLog(`✅ [External Addons] Total streams: ${totalResults} in ${now() - startTime}ms`);
    return resultsByAddon;
}

async function fetchExternalAddonsFlat(type, id, options = {}) {
    const resultsByAddon = await fetchAllExternalAddons(type, id, options);
    const flattened = Object.values(resultsByAddon).flat();
    return dedupeNormalizedStreams(flattened);
}

module.exports = {
    EXTERNAL_ADDONS,
    fetchExternalAddon,
    fetchAllExternalAddons,
    fetchExternalAddonsFlat,
    normalizeExternalStream,
    extractInfoHash,
    isItalianContent,
    analyzeItalianSignals
};
