'use strict';

const crypto = require('crypto');
let pLimit;
try {
    const pLimitModule = require('p-limit');
    pLimit = typeof pLimitModule === 'function' ? pLimitModule : pLimitModule.default;
} catch {
    pLimit = function createLocalLimit(concurrency) {
        const max = Math.max(1, Number(concurrency) || 1);
        let active = 0;
        const queue = [];
        const next = () => {
            if (active >= max || queue.length === 0) return;
            const item = queue.shift();
            active += 1;
            Promise.resolve()
                .then(item.fn)
                .then(item.resolve, item.reject)
                .finally(() => { active -= 1; next(); });
        };
        return (fn) => new Promise((resolve, reject) => {
            queue.push({ fn, resolve, reject });
            next();
        });
    };
}
const { LEGACY_BROWSER_PROFILES } = require('../browser_profiles');
let logger; try { ({ logger } = require('../utils/runtime')); } catch { logger = console; }
const { EXTERNAL_ADDONS, getAddon, getAddonGroup, getAddonEmoji } = require('./addons');
const { getImpitBrowserForFingerprint, requestWithImpit } = require('../../providers/utils/bypass');

const DEBUG_MODE = process.env.DEBUG_MODE === 'true';

const KNOWN_PROVIDERS = [
    'ThePirateBay', 'ilCorSaRoNeRo', '1337x', 'Cyber', 'Torrent9', 'Wolfmax4K',
    'Comando', 'YTS', 'YIFY', 'BestTorrents', 'Knaben', 'BTM', 'Byndr', 'Wadu',
    'Sp33dy94', 'MIRCrew', 'Cosmo Crew', 'Ph4nt0mx', 'Nueng', 'Rutor',
    'TorrentGalaxy', 'TGx', 'RARBG', 'EZTV', 'Nyaa', 'Erai-raws', 'SubsPlease',
    'Judas', 'QxR', 'Tigole', 'PSA', 'EAGLE', 'MegaPhone', 'iDN_CreW',
    'MUX', 'DDN', 'DLMux', 'WebMux', 'TRIDIM', 'Lidri', 'Ghizzo', 'MeGaPeER',
    'Papeete', 'Vics', 'Gaiage', 'Dtone', 'BlackBit', 'Pantry', 'Bric', 'USAbit',
    'Uindex', 'Contribution Stream'
].sort((a, b) => b.length - a.length);

const REGEX_AUDIO_ITA = /(?:🇮🇹|\b(?:ITA|ITALIAN|ITALIANO|ITALIANA)\b|\b(?:AUDIO|DUB|DUBBED|LANG(?:UAGE)?|LINGUA|VOCE|TRACK)\s*[:._-]?\s*(?:ITA|ITALIAN|ITALIANO|ITALIANA|IT)\b|\b(?:ITA|ITALIAN|ITALIANO|ITALIANA|IT)\s*[:._-]?\s*(?:AUDIO|DUB|DUBBED|DDP|AAC|AC3|EAC3|ATMOS|TRUEHD|DTS(?:-?HD)?)\b|\b(?:MULTI|DUAL\s*AUDIO)\s*(?:ITA|IT)\b|\bTRUE\s*ITALIAN\b|\bIT\s*[\/+,\-]\s*(?:GB|UK|US|EN|ENG|ENGLISH|MULTI|VO|SUB|AAC|AC3|DDP|EAC3|DTS)\b|\b(?:GB|UK|US|EN|ENG|ENGLISH|MULTI|VO)\s*[\/+,\-]\s*IT\b|[\[(]\s*IT\s*[\])])/i;
const REGEX_SUB_ITA = /(?:\b(?:SUB[-.\s_]*ITA|SOFTSUB[-.\s_]*ITA|VOST(?:ITA)?|ITALIAN\s*SUBS?|SUB(?:TITLE)?S?\s*(?:ITALIAN|ITALIANO|ITA))\b|🇮🇹\s*SUB)/i;
const REGEX_TRUSTED_ITA = /\b(?:CORSARO|MEGAPHONE|IDN[_\s-]*CREW|DDN|MUX(?:\s*ITA)?|TRIDIM|LUX|WMS|MIRCREW|CINEFILE)\b/i;
const REGEX_ENGLISH_LANGUAGE = /(?:🇬🇧|🇺🇸|\b(?:ENG|ENGLISH)\b|(?:^|[^A-Z0-9])EN(?:[^A-Z0-9]|$))/i;
const REGEX_NEGATIVE_LANGUAGE = /(?:🇬🇧|🇺🇸|🇷🇺|🇺🇦|🇫🇷|🇩🇪|🇪🇸|🇵🇱|🇯🇵|🇰🇷|🇨🇳|🇮🇳|\b(?:ENGLISH(?:\s*(?:DUBBED|DUB|AUDIO|ONLY))?|ENG(?:\s*(?:DUBBED|DUB|AUDIO|ONLY))?|TRUEFRENCH|FRENCH|FRA|GERMAN|GER|DEU|SPANISH|SPA|ESP|LATINO|RUSSIAN|RUS|UKRAINIAN|UKR|POLISH|POL|HINDI|TAMIL|TELUGU|KOREAN|JAPANESE|JPN|CHINESE|MANDARIN)\b)/i;
const REGEX_MULTI_LANGUAGE = /\b(?:MULTI|DUAL\s*AUDIO|VOST)\b/i;
const REGEX_STRONG_ITA_AUDIO = /(?:🇮🇹|\b(?:ITA|ITALIAN|ITALIANO|ITALIANA)\b|\b(?:AUDIO|DUB|DUBBED|LANG(?:UAGE)?|LINGUA|VOCE|TRACK)\s*[:._\-/ ]?\s*(?:ITA|ITALIAN|ITALIANO|ITALIANA|IT)\b|\b(?:ITA|ITALIAN|ITALIANO|ITALIANA|IT)\s*[:._\-/ ]?\s*(?:AUDIO|DUB|DUBBED|DDP|AAC|AC3|EAC3|ATMOS|TRUEHD|DTS(?:-?HD)?)\b)/i;
const REGEX_TORRENTIO_LOOSE_ITA = /(?:🇮🇹|\b(?:ITA|ITALIAN|ITALIANO|ITALIANA)\b|(?:^|[^A-Z0-9])IT(?:[^A-Z0-9]|$))/i;
const VIDEO_FILE_REGEX = /\.(mkv|mp4|avi|mov|wmv|flv|webm|m4v|ts|m2ts)$/i;
const SIZE_REGEX = /(?:📦|💾|💽|Size:?|Dimensione:?|File\s*Size:?|Peso:?)[\s:]*([\d.,]+)\s*(B|KB|MB|GB|TB|KIB|MIB|GIB|TIB)/i;
const SEEDERS_REGEX = /(?:👤|👥|Seeders?:?|Peers?:?)\s*[:\-]?\s*(\d+)/i;
const QUALITY_PATTERNS = [
    { regex: /\b(?:2160p|4k|uhd)\b/i, label: '2160p', score: 40 },
    { regex: /\b1080p\b/i, label: '1080p', score: 30 },
    { regex: /\b720p\b/i, label: '720p', score: 20 },
    { regex: /\b(?:480p|sd)\b/i, label: '480p', score: 10 }
];
const FAKE_RESULT_REGEX = /\b(?:no\s*(?:result|stream)s?|nessun\s*risultato|not\s*found|non\s*trovato|empty|unavailable|offline)\b/i;

const TORRENTHAN_ITALIAN_BRANDS = [
    'ilcorsaronero', 'corsaronero', 'mircrew', 'tntvillage', 'ddlstreamitaly',
    'darksidemux', 'pir8', 'giuseppetornatore', 'megaphone', 'idn crew', 'ddn', 'mux', 'tridim'
];
const TORRENTHAN_BAD_TOKENS = ['cam', 'hdcam', 'ts', 'hdts', 'telesync', 'telecine', 'tc', 'workprint', 'wp', 'xxx'];
const REGEX_TORRENTHAN_BAD = new RegExp(`(?:^|[^A-Z0-9])(?:${TORRENTHAN_BAD_TOKENS.join('|')})(?:[^A-Z0-9]|$)`, 'i');
const REGEX_TORRENTHAN_BRAND = new RegExp(TORRENTHAN_ITALIAN_BRANDS.map((value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '[\\s._-]*')).join('|'), 'i');
const REGEX_TORRENTHAN_IT_COMBO = /(?:🇮🇹|\bIT\s*[\/+,_\-. ]\s*(?:GB|UK|US|EN|ENG|ENGLISH|MULTI)\b|\b(?:GB|UK|US|EN|ENG|ENGLISH|MULTI)\s*[\/+,_\-. ]\s*IT\b|\bITA\s*[\/+,_\-. ]\s*(?:ENG|EN|ENGLISH|MULTI)\b|\b(?:ENG|EN|ENGLISH|MULTI)\s*[\/+,_\-. ]\s*ITA\b)/i;
const REGEX_TORRENTHAN_POSITIVE_ITA = /(?:🇮🇹|\b(?:ITA|ITALIAN|ITALIANO)\b|\bAUDIO\s*ITA\b|\bITA\s*(?:AAC|AC3|EAC3|DD|DDP|DTS|TRUEHD|ATMOS)\b|\b(?:AUDIO|LANG|LANGUAGE|LINGUA)\s*(?:ITA|ITALIAN|ITALIANO)\b|\b(?:ITA|ITALIAN|ITALIANO)\s*(?:DUB|DUBBED|MUX|MULTI)\b|\b(?:MULTI|MULTI-AUDIO|DUAL\s*AUDIO|DUAL-AUDIO)\b.*\b(?:ITA|ITALIAN|ITALIANO|IT)\b|\b(?:ITA|ITALIAN|ITALIANO|IT)\b.*\b(?:MULTI|MULTI-AUDIO|DUAL\s*AUDIO|DUAL-AUDIO)\b|\bSUB\s*ITA\b|\bSUBS?\s*ITA\b|\bSOFTSUB\s*ITA\b|\bFORCED\s*ITA\b|\bACCOPPIALO\b)/i;
const REGEX_TORRENTHAN_AUDIO_ITA = /(?:\bAUDIO\s*ITA\b|\bITA\s*(?:AAC|AC3|EAC3|DD|DDP|DTS|TRUEHD|ATMOS)\b|\b(?:AUDIO|LANG|LANGUAGE|LINGUA)\s*(?:ITA|ITALIAN|ITALIANO)\b|\b(?:ITA|ITALIAN|ITALIANO)\s*(?:AUDIO|DUB|DUBBED|MUX|MULTI|AAC|AC3|EAC3|DD|DDP|DTS|TRUEHD|ATMOS)\b|\b(?:MULTI|MULTI-AUDIO|DUAL\s*AUDIO|DUAL-AUDIO)\b.*\b(?:ITA|ITALIAN|ITALIANO|IT)\b)/i;
const REGEX_TORRENTHAN_SUB_ITA = /(?:\bSUB\s*ITA\b|\bSUBS?\s*ITA\b|\bSOTTOTITOL[IA].*\bITA\b|\bSOFTSUB\s*ITA\b|\bFORCED\s*ITA\b|\bSUB[-.\s_]*ITA\b|\bVOST(?:ITA)?\b)/i;
const REGEX_TORRENTHAN_NEGATIVE = /(?:\bSUB(?:BED)?\s*ENG\b|\bENGLISH\b|\bENG\b|\bVO\b|\bORIGINAL\s*AUDIO\b|\bVOSTFR\b|\bVOSE\b)/i;
const REGEX_TORRENTHAN_MULTI = /\b(?:MULTI|MULTI-AUDIO|DUAL(?:\s|-)?AUDIO)\b/i;
const REGEX_TORRENTHAN_IT_CODEC = /\b(?:ITA|ITALIAN|ITALIANO)\b.*\b(?:AC3|EAC3|AAC|DTS|TRUEHD|ATMOS|DDP)\b/i;

const REGEX_TORRENTIO_RD_DOWNLOAD_MARKER = /(?:⬇️|\[\s*RD\s*download\s*\]|\bRD\s*(?:download|DL)\b|\bReal[-\s]?Debrid\s*download\b|\bdownload\s*(?:to|in|su|nel|sul)?\s*(?:debrid|RD|Real[-\s]?Debrid|cloud)\b|\b(?:add|aggiungi|manda|send)\s*(?:to|al|in)?\s*(?:cloud|debrid|RD|Real[-\s]?Debrid)\b)/i;
const REGEX_TORRENTIO_RD_CACHED_MARKER = /(?:⚡|\[\s*RD\s*\+\s*\]|\bRD\s*\+\b|\bRD\+\b|\bReal[-\s]?Debrid\s*(?:cached|instant|ready)\b|\binstant(?:ly)?\s*(?:available|ready)\b|\b(?:cached|cache)\s*(?:on|su)?\s*(?:RD|Real[-\s]?Debrid)\b)/i;

function collectRdMarkerText(stream = {}, fallbackText = '') {
    const hints = stream?.behaviorHints && typeof stream.behaviorHints === 'object' ? stream.behaviorHints : {};
    const values = [
        fallbackText,
        stream?.title,
        stream?.name,
        stream?.description,
        stream?.filename,
        stream?.file_title,
        stream?.provider,
        stream?.source,
        stream?.cachedStatus,
        stream?.debridStatus,
        stream?.availability,
        stream?.cacheState,
        stream?.rdCacheState,
        stream?._rdCacheState,
        hints.filename,
        hints.cached,
        hints.cacheState,
        hints.rdCacheState,
        hints.bingeGroup,
        hints.infoHash
    ];
    return values.flatMap((value) => Array.isArray(value) ? value : [value]).filter(Boolean).join(' ');
}

function hasTorrentioRdDownloadMarkerFromStream(stream = {}, fallbackText = '') {
    return REGEX_TORRENTIO_RD_DOWNLOAD_MARKER.test(collectRdMarkerText(stream, fallbackText));
}

function hasTorrentioRdCachedMarkerFromStream(stream = {}, fallbackText = '') {
    const markerText = collectRdMarkerText(stream, fallbackText);
    if (!markerText) return false;
    if (stream?._dbCachedRd === true || stream?.cached_rd === true || stream?.isCached === true || stream?.cached === true) return true;
    if (/^(?:cached|rd_cached|instant|instant_available)$/i.test(String(stream?._rdCacheState || stream?.rdCacheState || stream?.cacheState || '').trim())) return true;
    return REGEX_TORRENTIO_RD_CACHED_MARKER.test(markerText);
}

const FETCH_CACHE_TTL = Number(process.env.EXTERNAL_ADDONS_CACHE_TTL || 30000);
const NEGATIVE_CACHE_TTL = Number(process.env.EXTERNAL_ADDONS_NEGATIVE_CACHE_TTL || 12000);
const MAX_TRACKERS_IN_MAGNET = Number(process.env.EXTERNAL_ADDONS_MAX_TRACKERS || 10);
const MAX_CONCURRENCY = Number(process.env.EXTERNAL_ADDONS_MAX_CONCURRENCY || 3);
const FETCH_CACHE_MAX_ENTRIES = Math.max(100, Number(process.env.EXTERNAL_ADDONS_CACHE_MAX_ENTRIES || 600) || 600);
const FETCH_CACHE_SWEEP_INTERVAL_MS = Math.max(1000, Number(process.env.EXTERNAL_ADDONS_CACHE_SWEEP_INTERVAL_MS || 15000) || 15000);

const fetchLimiter = pLimit(MAX_CONCURRENCY);
const BROWSER_PROFILES = LEGACY_BROWSER_PROFILES;

class TimedLruCache {
    constructor({ maxEntries, sweepIntervalMs }) {
        this.maxEntries = Math.max(50, maxEntries || 600);
        this.sweepIntervalMs = Math.max(1000, sweepIntervalMs || 15000);
        this.store = new Map();
        this.nextSweepAt = 0;
    }

    get(key) {
        const entry = this.store.get(key);
        if (!entry) return null;
        if (entry.expiresAt <= now()) {
            this.store.delete(key);
            return null;
        }
        this.store.delete(key);
        this.store.set(key, entry);
        return entry.value;
    }

    set(key, value, ttlMs) {
        if (!ttlMs || ttlMs <= 0) return value;
        this.sweep();
        this.store.delete(key);
        this.store.set(key, { value, expiresAt: now() + ttlMs });
        this.trim();
        return value;
    }

    sweep(force = false) {
        const ts = now();
        if (!force && this.store.size <= this.maxEntries && ts < this.nextSweepAt) return;
        this.nextSweepAt = ts + this.sweepIntervalMs;
        for (const [key, value] of this.store.entries()) {
            if (!value || value.expiresAt <= ts) this.store.delete(key);
        }
        this.trim();
    }

    trim() {
        while (this.store.size > this.maxEntries) {
            const firstKey = this.store.keys().next().value;
            if (firstKey === undefined) break;
            this.store.delete(firstKey);
        }
    }
}

const fetchCache = new TimedLruCache({
    maxEntries: FETCH_CACHE_MAX_ENTRIES,
    sweepIntervalMs: FETCH_CACHE_SWEEP_INTERVAL_MS
});
const inflightFetches = new Map();
const addonHealth = new Map();

function now() { return Date.now(); }
function debugLog(...args) { if (DEBUG_MODE) logger.debug(require('util').format(...args)); }
function infoLog(...args) { logger.info(require('util').format(...args)); }
function getCache(cache, key) { return cache?.get?.(key) ?? null; }
function setCache(cache, key, value, ttl) { return cache?.set?.(key, value, ttl) ?? value; }

function normalizeText(value) {
    return String(value || '').replace(/[\u2010-\u2015]/g, '-').replace(/[|_]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function normalizeForComparison(value) {
    return normalizeText(value).normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toUpperCase();
}

function getTorrentioLanguageEvidence(stream) {
    const raw = [
        stream?.title,
        stream?.name,
        stream?.description,
        stream?.behaviorHints?.filename,
        stream?.behaviorHints?.folderName,
        stream?.filename,
        stream?.provider
    ].filter(Boolean).join(' ');

    const normalized = normalizeForComparison(raw);
    const hasExplicitItalianAudio = /(?:🇮🇹|\b(?:AUDIO|DUB|DUBBED|LANG(?:UAGE)?|LINGUA|VOCE|TRACK)\s*[:._\-/ ]?\s*(?:ITA|ITALIAN|ITALIANO|ITALIANA|IT)\b|\b(?:ITA|ITALIAN|ITALIANO|ITALIANA|IT)\s*[:._\-/ ]?\s*(?:AUDIO|DUB|DUBBED|DDP|AAC|AC3|EAC3|ATMOS|TRUEHD|DTS(?:-?HD)?)\b)/i.test(raw);
    const hasItalianSubtitleOnly = REGEX_SUB_ITA.test(raw) && !hasExplicitItalianAudio;
    const hasLooseItalian = REGEX_TORRENTIO_LOOSE_ITA.test(raw) || REGEX_TORRENTIO_LOOSE_ITA.test(normalized);        
    const hasItalian = Boolean(hasLooseItalian || REGEX_STRONG_ITA_AUDIO.test(raw) || REGEX_STRONG_ITA_AUDIO.test(normalized));
    const hasForeign = REGEX_NEGATIVE_LANGUAGE.test(raw) || REGEX_NEGATIVE_LANGUAGE.test(normalized);
    const onlyForeignFlagBlock = hasForeign && !hasItalian;

    return { hasItalian, hasForeign, onlyForeignFlagBlock, hasItalianSubtitleOnly, hasLooseItalian };
}

function looksLikeSeasonPackTitle(value) {
    const title = normalizeForComparison(value).replace(/[‐‑–—―〜～]/g, '-');
    if (!title) return false;

    if (/\bS\d{1,2}E\d{1,3}\s*(?:-|~|TO|A)\s*(?:E)?\d{1,3}\b/i.test(title)) return true;
    if (/\bS\d{1,2}\s*(?:-|~|TO|A)\s*(?:S)?\d{1,2}\b/i.test(title)) return true;
    if (/\b(?:SEASON|STAGIONE)\s*\d{1,2}\s*(?:-|~|TO|A)\s*\d{1,2}\b/i.test(title)) return true;
    if (/\b(?:EPISODES?|EPISODI?)\s*\d{1,3}\s*(?:-|~|TO|A)\s*\d{1,3}\b/i.test(title)) return true;
    if (/\b(?:PACK|BATCH|COMPLETE|COMPLETA|INTEGRALE|COLLECTION)\b/i.test(title)) return true;

    if (/\bS\d{1,2}E\d{1,3}\b/i.test(title)) return false;
    if (/\b\d{1,2}X\d{1,3}\b/i.test(title)) return false;

    return /\bS\d{1,2}(?!E)\b/i.test(title) || /\b(?:SEASON|STAGIONE)\s*\d{1,2}\b/i.test(title);
}

function getStreamText(stream) {
    return normalizeText([
        stream.title, stream.name, stream.description,
        stream.behaviorHints?.filename, stream.behaviorHints?.folderName,
        stream.filename, stream.provider
    ].filter(Boolean).join(' '));
}

function analyzeItalianSignals(stream) {
    const fullText = normalizeForComparison(getStreamText(stream));
    if (!fullText) return { isItalian: false, hasAudioItalian: false, hasSubItalian: false, hasTrustedItalian: false, hasNegativeLanguage: false, hasEnglish: false, isMulti: false, detectedLanguages: [], displayLabel: '', confidence: 0, reason: 'empty' };

    if (REGEX_TORRENTHAN_BAD.test(fullText)) {
        return { isItalian: false, hasAudioItalian: false, hasSubItalian: false, hasTrustedItalian: false, hasNegativeLanguage: true, hasEnglish: false, isMulti: false, detectedLanguages: [], displayLabel: '', confidence: 0, reason: 'bad_release_token' };
    }

    const hasTorrenthanBrand = REGEX_TORRENTHAN_BRAND.test(fullText);
    const hasTorrenthanCombo = REGEX_TORRENTHAN_IT_COMBO.test(fullText);
    const hasTorrenthanPositive = REGEX_TORRENTHAN_POSITIVE_ITA.test(fullText);
    const hasTorrenthanAudio = REGEX_TORRENTHAN_AUDIO_ITA.test(fullText);
    const hasSubItalian = REGEX_SUB_ITA.test(fullText) || REGEX_TORRENTHAN_SUB_ITA.test(fullText);
    const hasSubOnlyItalian = hasSubItalian && !hasTorrenthanAudio;
    const hasTrustedItalian = REGEX_TRUSTED_ITA.test(fullText) || hasTorrenthanBrand;
    const hasNegativeLanguage = REGEX_NEGATIVE_LANGUAGE.test(fullText) || REGEX_TORRENTHAN_NEGATIVE.test(fullText);
    const hasEnglish = REGEX_ENGLISH_LANGUAGE.test(fullText);
    const hasMultiLanguage = REGEX_MULTI_LANGUAGE.test(fullText) || REGEX_TORRENTHAN_MULTI.test(fullText);

    let confidence = 0;
    const reasons = [];

    if (hasTorrenthanBrand) { confidence += 40; reasons.push('torrenthan_brand'); }
    if (hasTorrenthanCombo) { confidence += 38; reasons.push('it_combo'); }
    if (hasTorrenthanPositive) { confidence += 24; reasons.push('positive_ita'); }
    if (hasTorrenthanAudio) { confidence += 18; reasons.push('audio'); }
    if (hasMultiLanguage && /\b(?:ITA|ITALIAN|ITALIANO|IT)\b/i.test(fullText)) { confidence += 12; reasons.push('multi_ita'); }
    if (REGEX_TORRENTHAN_IT_CODEC.test(fullText)) { confidence += 10; reasons.push('codec_ita'); }
    if (hasTrustedItalian && !hasTorrenthanBrand) { confidence += 35; reasons.push('trusted'); }
    if (hasSubOnlyItalian) { confidence -= 10; confidence = Math.max(confidence, 36); reasons.push('sub_ita'); }
    if (hasNegativeLanguage && !hasTorrenthanAudio && !hasTrustedItalian && !hasTorrenthanCombo) { confidence -= 16; reasons.push('negative'); }

    confidence = Math.max(0, Math.min(100, confidence));
    const isItalian = confidence >= 35 || hasTorrenthanAudio || hasTorrenthanCombo || (hasTrustedItalian && !hasNegativeLanguage);
    const detectedLanguages = [];
    if (isItalian) detectedLanguages.push('Italian');
    if (hasEnglish && !isItalian) detectedLanguages.push('English');
    if (hasMultiLanguage && !detectedLanguages.includes('Multi')) detectedLanguages.push('Multi');

    return {
        isItalian,
        hasAudioItalian: Boolean(hasTorrenthanAudio || hasTorrenthanCombo || hasTorrenthanBrand),
        hasSubItalian: hasSubItalian,
        hasTrustedItalian,
        hasNegativeLanguage,
        hasEnglish,
        isMulti: hasMultiLanguage,
        detectedLanguages,
        displayLabel: isItalian ? (hasSubOnlyItalian ? '🇮🇹 SUB-ITA' : '🇮🇹') : (hasEnglish ? '🇬🇧' : ''),
        confidence,
        reason: reasons.join('|') || 'none'
    };
}

function isItalianContent(stream) { return analyzeItalianSignals(stream).isItalian; }

function extractInfoHash(stream) {
    const candidates = [
        stream?.infoHash, stream?.hash, stream?.behaviorHints?.infoHash, stream?.behaviorHints?.magnet,
        stream?.magnet, stream?.magnetLink, stream?.url, ...(Array.isArray(stream?.sources) ? stream.sources : [])
    ].filter(Boolean).map((value) => String(value));

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
    return '';
}

function extractSeeders(text, stream = {}) {
    if (Number.isFinite(stream.seeders) && stream.seeders >= 0) return stream.seeders;
    if (Number.isFinite(stream.peers) && stream.peers >= 0) return stream.peers;
    const normalized = normalizeText(text);
    const match = normalized.match(SEEDERS_REGEX);
    return match ? parseInt(match[1], 10) || 0 : 0;
}

function parseSizeParts(value, unit) {
    const parsedValue = parseFloat(String(value).replace(',', '.'));
    const normalizedUnit = String(unit || '').toUpperCase();
    if (!Number.isFinite(parsedValue) || parsedValue <= 0) return 0;
    const multipliers = { B: 1, KB: 1024, KIB: 1024, MB: 1024 ** 2, MIB: 1024 ** 2, GB: 1024 ** 3, GIB: 1024 ** 3, TB: 1024 ** 4, TIB: 1024 ** 4 };
    return Math.round(parsedValue * (multipliers[normalizedUnit] || 1));
}

function formatBytes(bytes, decimals = 2) {
    const value = Number(bytes);
    if (!Number.isFinite(value) || value <= 0) return '';
    const k = 1024;
    const dm = decimals < 0 ? 0 : decimals;
    const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.min(Math.floor(Math.log(value) / Math.log(k)), sizes.length - 1);
    return `${parseFloat((value / (k ** i)).toFixed(dm))} ${sizes[i]}`;
}

function extractSize(text, stream = {}) {
    const hintedSize = stream.behaviorHints?.videoSize || stream.video_size || stream.videoSize || stream.mainFileSize || stream.sizeBytes;
    if (Number.isFinite(hintedSize) && hintedSize > 0) return { formatted: formatBytes(hintedSize), bytes: hintedSize };

    const normalized = normalizeText(text);
    const match = normalized.match(SIZE_REGEX) || normalized.match(/([\d.,]+)\s*(TB|GB|MB|KB|TIB|GIB|MIB|KIB)\b/i);
    if (!match) return { formatted: '', bytes: 0 };

    const bytes = parseSizeParts(match[1], match[2]);
    if (bytes <= 0) return { formatted: '', bytes: 0 };
    return { formatted: `${parseFloat(String(match[1]).replace(',', '.'))} ${String(match[2]).toUpperCase().replace('IB', 'B')}`, bytes };
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
    if (/^Contribution Stream\b/i.test(provider)) return 'Contribution Stream';
    return provider;
}

function extractPackTitle(stream) {
    const rawText = String(stream.title || stream.description || '');
    const match = rawText.match(/📁\s*([^\r\n]+)/);
    if (match) return normalizeText(match[1]);
    const folderName = normalizeText(stream.behaviorHints?.folderName || '');
    if (folderName && !VIDEO_FILE_REGEX.test(folderName)) return folderName;
    return null;
}

function extractFilename(stream) {
    const hintedFilename = normalizeText(stream.behaviorHints?.filename || stream.filename || '');
    if (hintedFilename) return hintedFilename;
    const rawText = String(stream.title || stream.description || '');
    const match = rawText.match(/📄\s*([^\r\n]+)/);
    if (match) return normalizeText(match[1]);
    return normalizeText(stream.name || '');
}
function hashConfigSignature(value) {
    return crypto.createHash('sha1').update(String(value || '')).digest('hex').slice(0, 12);
}

function getTorrentioCredential(userConfig, service) {
    if (!userConfig || !service) return null;
    const configByService = {
        rd: userConfig.rd || userConfig.realdebrid || userConfig.key,
        tb: userConfig.tb || userConfig.torbox || userConfig.key
    };
    return configByService[service] || null;
}

function getRealDebridToken(userConfig) {
    if (!userConfig) return null;
    return userConfig.rd || userConfig.realdebrid || (userConfig.service === 'rd' ? userConfig.key : null) || null;
}

function encodeBase64Url(data) {
    return Buffer.from(String(data || '')).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function safeDecodeURIComponent(value) {
    try { return decodeURIComponent(String(value || '')); } catch { return String(value || ''); }
}

function safeEncodeTorrentioConfigSegment(value) {        
    return encodeURIComponent(String(value || '').trim())
        .replace(/%7C/gi, '|')
        .replace(/%3D/gi, '=')
        .replace(/%2C/gi, ',')
        .replace(/%3A/gi, ':');
}

function isTorrentioConfigSegment(value = '') {
    const text = safeDecodeURIComponent(value).trim();
    if (!text || /^manifest\.json$/i.test(text) || /^stream$/i.test(text)) return false;
    return /(?:^|\|)(?:providers|qualityfilter|sort|debridoptions|realdebrid|premiumize|alldebrid|debridlink|offcloud|putio|torbox|language|limit|cachedonly)=/i.test(text)
        || (text.includes('|') && text.includes('='));
}

function stripTorrentioDebridTokens(configText = '') {
    return String(configText || '')
        .split('|')
        .map((part) => part.trim())
        .filter(Boolean)
        .filter((part) => !/^(?:realdebrid|torbox|premiumize|alldebrid|debridlink|offcloud|putio)=/i.test(part))
        .join('|');
}

function upsertTorrentioConfigPart(configText = '', key, value) {
    const wantedKey = String(key || '').trim();
    if (!wantedKey) return String(configText || '').trim();
    const encodedValue = String(value || '').trim();
    const parts = String(configText || '')
        .split('|')
        .map((part) => part.trim())
        .filter(Boolean)
        .filter((part) => !part.toLowerCase().startsWith(`${wantedKey.toLowerCase()}=`));
    if (encodedValue) parts.push(`${wantedKey}=${encodedValue}`);
    return parts.join('|');
}

function normalizeTorrentioDebridOptions(configText = '') {
    const text = String(configText || '').trim();
    const forceNoDownload = process.env.EXT_TORRENTIO_FORCE_NO_DOWNLOAD_LINKS === 'true';
    const allowDownload = process.env.EXT_TORRENTIO_ALLOW_DOWNLOAD_LINKS === 'true';
    const existing = text.split('|').find((part) => /^debridoptions=/i.test(part));

    // Default compatto: nasconde i download-to-debrid di Torrentio.
    // Si possono riabilitare solo esplicitamente con EXT_TORRENTIO_ALLOW_DOWNLOAD_LINKS=true.
    if (!forceNoDownload && allowDownload) {
        if (!existing) return text;
        const value = existing.split('=').slice(1).join('=')
            .split(',')
            .map((part) => part.trim())
            .filter(Boolean)
            .filter((part) => !/^nodownloadlinks$/i.test(part))
            .join(',');
        return value ? upsertTorrentioConfigPart(text, 'debridoptions', value) : upsertTorrentioConfigPart(text, 'debridoptions', '');
    }

    if (!existing) return upsertTorrentioConfigPart(text, 'debridoptions', 'nodownloadlinks');
    const value = existing.split('=').slice(1).join('=');
    if (/(^|,)nodownloadlinks(,|$)/i.test(value)) return text;
    return upsertTorrentioConfigPart(text, 'debridoptions', `${value},nodownloadlinks`);
}

function buildTorrentioPipeConfig(baseConfig = '', apiKey = '') {
    let configText = stripTorrentioDebridTokens(safeDecodeURIComponent(baseConfig || process.env.EXT_TORRENTIO_BASE_CONFIG || ''));
    configText = normalizeTorrentioDebridOptions(configText);
    configText = upsertTorrentioConfigPart(configText, 'realdebrid', encodeURIComponent(String(apiKey || '').trim()));
    return configText;
}

function buildTorrentioBaseUrl(baseUrl, userConfig) {
    const service = userConfig?.service;
    const apiKey = getTorrentioCredential(userConfig, service);
    if (!service || !apiKey) return baseUrl;
    if (process.env.EXT_TORRENTIO_INJECT_DEBRID === 'false') return baseUrl;
     
    if (service === 'rd') {
        try {
            const url = new URL(String(baseUrl || ''));
            const originalSegments = url.pathname.split('/').filter(Boolean);
            const segments = [...originalSegments];
            while (segments.length && /^manifest\.json$/i.test(segments[segments.length - 1])) segments.pop();
            while (segments.length && /^stream$/i.test(segments[segments.length - 1])) segments.pop();

            let configIndex = -1;
            for (let i = segments.length - 1; i >= 0; i -= 1) {
                if (isTorrentioConfigSegment(segments[i])) { configIndex = i; break; }
            }

            const baseConfig = configIndex >= 0 ? segments[configIndex] : '';
            const rdConfig = buildTorrentioPipeConfig(baseConfig, apiKey);
            if (!rdConfig) return baseUrl;
            const encodedConfig = safeEncodeTorrentioConfigSegment(rdConfig);

            if (configIndex >= 0) segments[configIndex] = encodedConfig;
            else segments.push(encodedConfig);

            url.pathname = `/${segments.join('/')}`;
            const injected = url.toString().replace(/\/+$/, '');
            if (injected !== baseUrl) {
                infoLog(`[TORRENTIO CONFIG] RD native config injected tokenSig=${hashConfigSignature(apiKey)} baseHadConfig=${configIndex >= 0} downloadRows=${process.env.EXT_TORRENTIO_ALLOW_DOWNLOAD_LINKS === 'true' && process.env.EXT_TORRENTIO_FORCE_NO_DOWNLOAD_LINKS !== 'true' ? 'true' : 'false'}`);
            }
            return injected;
        } catch {
            const trimmed = String(baseUrl || '').replace(/\/+$/, '');
            const rdConfig = safeEncodeTorrentioConfigSegment(buildTorrentioPipeConfig('', apiKey));
            return rdConfig ? `${trimmed}/${rdConfig}` : baseUrl;
        }
    }

    
    const torrentioConf = {};
    if (service === 'tb') torrentioConf.torbox = apiKey;
    else return baseUrl;

    const encodedConf = encodeBase64Url(JSON.stringify(torrentioConf));

    try {
        const url = new URL(String(baseUrl || ''));
        const segments = url.pathname.split('/').filter(Boolean);
        const lastSegment = segments[segments.length - 1];
        const hasPreconfiguredPath = segments.length > 0 && !/^manifest\.json$/i.test(lastSegment || '') && !/^stream$/i.test(lastSegment || '');

        if (hasPreconfiguredPath && process.env.EXT_TORRENTIO_FORCE_REWRITE_CONFIG !== 'true') return baseUrl;

        if (lastSegment && /^[A-Za-z0-9_-]{2,}$/.test(lastSegment)) segments[segments.length - 1] = encodedConf;
        else segments.push(encodedConf);
        url.pathname = `/${segments.join('/')}`;
        return url.toString().replace(/\/+$/, '');
    } catch {
        const trimmed = String(baseUrl || '').replace(/\/+$/, '');
        return `${trimmed}/${encodedConf}`;
    }
}

function getMediaFusionCredential(userConfig, service) {
    if (!userConfig || String(service || '').toLowerCase() !== 'rd') return null;
    return userConfig.rd || userConfig.realdebrid || (userConfig.service === 'rd' ? userConfig.key : null) || null;
}

function buildMediaFusionBaseUrl(baseUrl, userConfig) {
    const service = String(userConfig?.service || '').toLowerCase();
    if (service !== 'rd') return baseUrl;
    if (process.env.EXT_MEDIAFUSION_INJECT_DEBRID === 'false') return baseUrl;

    const configuredRdUrl = envFirst([
        'EXT_MEDIAFUSION_RD_URL',
        'MEDIAFUSION_RD_URL',
        'NEXUS_MEDIAFUSION_RD_URL'
    ]);
    if (configuredRdUrl) {
        const token = getMediaFusionCredential(userConfig, service);
        infoLog(`[MEDIAFUSION CONFIG] RD configured URL selected tokenSig=${hashConfigSignature(token || 'none')}`);
        return configuredRdUrl;
    }

    return baseUrl;
}

function sanitizeFetchType(type, id) {
    const rawType = String(type || '').trim().toLowerCase();
    const rawId = String(id || '');
    if (rawType === 'anime' || rawId.startsWith('kitsu:')) return 'series';
    return rawType || 'movie';
}

function sanitizePathSegment(value) { return encodeURIComponent(String(value || '').trim()); }
function normalizeAddonUrl(baseUrl) {
    if (!baseUrl) return null;
    return String(baseUrl)
        .replace(/\/+$/, '')
        .replace(/\/manifest\.json$/i, '')
        .replace(/\/stream$/i, '');
}

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
    state.lastError = errorMessage || 'Unknown error';
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
    const service = conf.service || '';
    const token = getTorrentioCredential(conf, service) || getRealDebridToken(conf) || '';
    return JSON.stringify({
        addonKey, type: sanitizeFetchType(type, id), id: String(id || ''),
        onlyItalian: options.onlyItalian !== false,
        languageMode: String(options.languageMode || ''),
        minConfidence: Number(options.minimumItalianConfidence || 35),
        rdOnly: options.requireRdCached === true || getAddon(addonKey)?.requireRdCached === true || addonKey === 'mediafusion',
        service, tokenSig: token ? hashConfigSignature(token) : ''
    });
}

function buildMagnetLink(infoHash, sources, displayName = '') {
    if (!infoHash) return null;
    let magnet = `magnet:?xt=urn:btih:${infoHash}`;
    if (displayName) magnet += `&dn=${encodeURIComponent(displayName)}`;

    const trackers = Array.isArray(sources)
        ? sources.filter((source) => typeof source === 'string' && /^(tracker:|udp:\/\/|http:\/\/|https:\/\/)/.test(source))
            .map((source) => source.replace(/^tracker:/, '')).filter(Boolean)
        : [];

    for (const tracker of [...new Set(trackers)].slice(0, MAX_TRACKERS_IN_MAGNET)) magnet += `&tr=${encodeURIComponent(tracker)}`;
    return magnet;
}

function extractVideoTags(text) {
    const normalized = normalizeText(text);
    const tags = [];
    if (/\b(?:REMUX)\b/i.test(normalized)) tags.push('REMUX');
    if (/\b(?:WEB[- .]?DL|WEBRIP)\b/i.test(normalized)) tags.push('WEB');
    if (/\b(?:BLURAY|BDRIP|BRRIP)\b/i.test(normalized)) tags.push('BLURAY');
    if (/\b(?:HDR10?\+?|HDR)\b/i.test(normalized)) tags.push('HDR');
    if (/\b(?:DV|DOLBY\s*VISION)\b/i.test(normalized)) tags.push('DV');
    if (/\b(?:X265|HEVC|H265)\b/i.test(normalized)) tags.push('HEVC');
    if (/\b(?:X264|H264|AVC)\b/i.test(normalized)) tags.push('H264');
    return tags.join(' ');
}

function scoreNormalizedStream(normalized) {
    const italian = normalized.languageInfo?.confidence || 0;
    const quality = (() => {
        const matched = QUALITY_PATTERNS.find((item) => item.label.toLowerCase() === String(normalized.quality || '').toLowerCase());
        return matched ? matched.score : 0;
    })();
    const seeders = Math.min(30, Math.round(Math.log2((normalized.seeders || 0) + 1) * 4));
    const size = normalized.mainFileSize > 0 ? Math.min(18, Math.round(Math.log10(normalized.mainFileSize))) : 0;
    const providerBonus = normalized.externalProvider ? 8 : 0;
    const packBonus = normalized.potentialPack ? 3 : 0;
    return italian + quality + seeders + size + providerBonus + packBonus;
}


function looksLikeEpisodeRangeTitle(value) {
    const title = normalizeForComparison(value).replace(/[‐‑–—―〜～]/g, '-');
    if (!title) return false;
    return /\bS\d{1,2}E\d{1,3}\s*(?:-|~|TO|A)\s*(?:E)?\d{1,3}\b/i.test(title)
        || /\b\d{1,2}X\d{1,3}\s*(?:-|~|TO|A)\s*(?:\d{1,2}X)?\d{1,3}\b/i.test(title)
        || /\b(?:EPISODES?|EPISODI?)\s*\d{1,3}\s*(?:-|~|TO|A)\s*\d{1,3}\b/i.test(title);
}

function looksLikeSingleEpisodeTitle(value) {
    const title = normalizeForComparison(value).replace(/[‐‑–—―〜～]/g, '-');
    if (!title || looksLikeEpisodeRangeTitle(title)) return false;
    return /\bS\d{1,2}E\d{1,3}\b/i.test(title) || /\b\d{1,2}X\d{1,3}\b/i.test(title);
}

function hasExplicitSeasonPackCue(value) {
    const title = normalizeForComparison(value).replace(/[‐‑–—―〜～]/g, '-');
    if (!title) return false;
    if (looksLikeEpisodeRangeTitle(title)) return true;
    if (/\b(?:PACK|BATCH|COMPLETE|COMPLETA|FULL|INTEGRALE|COLLECTION|RACCOLTA|全集|合集)\b/i.test(title)) return true;
    if (/\b(?:SEASON|STAGIONE)\s*\d{1,2}\s*(?:COMPLETE|COMPLETA|FULL|PACK)?\b/i.test(title) && !looksLikeSingleEpisodeTitle(title)) return true;
    if (/\bS\d{1,2}(?!\s*E)\b/i.test(title) && !looksLikeSingleEpisodeTitle(title)) return true;
    return false;
}

function isConfidentExternalSeasonPack({ preferredTitle = '', filename = '', rawPackTitle = '', text = '', streamTitle = '', streamName = '' } = {}) {
    const playableText = [preferredTitle, filename, streamTitle, streamName].filter(Boolean).join(' ');
    if (looksLikeEpisodeRangeTitle(playableText)) return true;
    if (looksLikeSingleEpisodeTitle(playableText)) return false;

    const allText = [preferredTitle, filename, rawPackTitle, text, streamTitle, streamName].filter(Boolean).join(' ');
    if (!hasExplicitSeasonPackCue(allText)) return false;
    if (rawPackTitle && hasExplicitSeasonPackCue(rawPackTitle)) return true;
    return hasExplicitSeasonPackCue(preferredTitle || text);
}

function stripMoviePackArtifacts(value) {
    return normalizeText(value)
        .replace(/\s*📦\s*(?:SEASON\s*)?PACK\b/ig, '')
        .replace(/\bSEASON\s+PACK\b/ig, '')
        .replace(/\bSTAGIONE\s+PACK\b/ig, '')
        .replace(/\s{2,}/g, ' ')
        .trim();
}

function normalizeExternalStream(stream, addonKey, mediaType = null) {
    const addon = getAddon(addonKey);
    if (!addon || !stream || typeof stream !== 'object') return null;

    const text = getStreamText(stream);
    const infoHash = extractInfoHash(stream);
    const rawUrl = stream.url || stream.externalUrl || null;
    if (!infoHash && !rawUrl) return null;

    const mediaTypeNormalized = String(mediaType || '').toLowerCase();
    const isSeriesType = mediaTypeNormalized === 'series' || mediaTypeNormalized === 'anime';
    const filename = extractFilename(stream);
    const rawPackTitle = isSeriesType ? extractPackTitle(stream) : '';
    const basePreferredTitle = filename || normalizeText(stream.name || stream.title || '');
    const packCandidate = isSeriesType && isConfidentExternalSeasonPack({
        preferredTitle: basePreferredTitle,
        filename,
        rawPackTitle,
        text,
        streamTitle: stream.title,
        streamName: stream.name
    });
    const packTitle = packCandidate ? rawPackTitle : '';
    let preferredTitle = (packCandidate && rawPackTitle) ? rawPackTitle : basePreferredTitle;
    if (!isSeriesType) preferredTitle = stripMoviePackArtifacts(preferredTitle) || filename || normalizeText(stream.name || stream.title || '');
    if (!preferredTitle || FAKE_RESULT_REGEX.test(preferredTitle)) return null;

    const quality = extractQuality(`${preferredTitle} ${text}`) || String(stream.resolution || '').replace(/[^0-9kp]/gi, '').toLowerCase() || '';
    const sizeInfo = extractSize(text, stream);
    const seeders = extractSeeders(text, stream);
    let languageInfo = analyzeItalianSignals(stream);
    if (addonKey === 'torrentio_mirror') {
        const evidence = getTorrentioLanguageEvidence(stream);
        if (evidence.hasItalian) {
            languageInfo = {
                ...languageInfo,
                isItalian: true,
                hasAudioItalian: true,
                confidence: Math.max(Number(languageInfo.confidence || 0), 98),
                hasNegativeLanguage: false,
                reason: languageInfo.reason && languageInfo.reason !== 'none' ? `torrentio_it_token|${languageInfo.reason}` : 'torrentio_it_token'
            };
        } else if (evidence.hasForeign) {
            languageInfo = {
                ...languageInfo,
                isItalian: false,
                hasAudioItalian: false,
                confidence: Math.min(Number(languageInfo.confidence || 0), -80),
                hasNegativeLanguage: true,
                reason: languageInfo.reason && languageInfo.reason !== 'none' ? `torrentio_foreign|${languageInfo.reason}` : 'torrentio_foreign'
            };
        }
    }

    let originalProvider = extractRealProvider(text);
    if (addonKey === 'mediafusion') originalProvider = normalizeMediaFusionProvider(originalProvider || null);

    const techTags = extractVideoTags(text);
    let sizeBytes = sizeInfo.bytes;
    if (Number.isFinite(stream.behaviorHints?.videoSize) && stream.behaviorHints.videoSize > 0) sizeBytes = stream.behaviorHints.videoSize;
    if (Number.isFinite(stream.video_size) && stream.video_size > 0) sizeBytes = stream.video_size;

    const normalizedFileIdx = Number.isInteger(stream.fileIdx) ? stream.fileIdx : -1;
    const magnetLink = buildMagnetLink(infoHash, stream.sources, preferredTitle);
    const hasDirectUrl = typeof rawUrl === 'string' && /^https?:\/\//i.test(rawUrl);
    const addonGroup = getAddonGroup(addonKey);
    const isTorrentioAddon = addonGroup === 'torrentio';
    const isMediaFusionAddon = addonGroup === 'mediafusion';            
    const torrentioDownloadMarker = isTorrentioAddon && hasTorrentioRdDownloadMarkerFromStream(stream, text);
    const torrentioCachedMarker = isTorrentioAddon && !torrentioDownloadMarker && hasTorrentioRdCachedMarkerFromStream(stream, text);
    const torrentioPlayableUrl = hasDirectUrl && isTorrentioAddon && !torrentioDownloadMarker ? rawUrl : null;
    const mediaFusionPlayableUrl = hasDirectUrl && isMediaFusionAddon ? rawUrl : null;
    const trustedTorrentioDirectUrl = hasDirectUrl && isTorrentioAddon && !torrentioDownloadMarker && addon.trustDirectUrl !== false;
    const trustedMediaFusionDirectUrl = hasDirectUrl && isMediaFusionAddon && process.env.MEDIAFUSION_TRUST_NATIVE_RD_URLS !== 'false';
    const trustedDirectUrl = trustedTorrentioDirectUrl || trustedMediaFusionDirectUrl;
    const externalCached = trustedDirectUrl || torrentioCachedMarker;
    const externalRdState = externalCached ? 'cached' : (torrentioDownloadMarker ? 'download' : 'unknown');
    const externalCachedBool = externalCached ? true : null;

    const potentialPack = Boolean(isSeriesType && packCandidate);

    const normalized = {
        infoHash, fileIdx: normalizedFileIdx, title: preferredTitle, filename, websiteTitle: preferredTitle,
        file_title: filename, quality, size: sizeInfo.formatted || formatBytes(sizeBytes), mainFileSize: sizeBytes,
        seeders: seeders || 0, leechers: 0, rawDescription: text,
        potentialPack,
        packTitle, source: originalProvider ? `${addon.name} (${originalProvider})` : addon.name,
        mediaType: String(mediaType || ''),
        externalAddon: addonKey, externalProvider: originalProvider, externalGroup: addonGroup, sourceEmoji: getAddonEmoji(addonKey),
        magnetLink, url: rawUrl, directUrl: rawUrl, externalDirectUrl: rawUrl, _externalDirectUrl: rawUrl,
        externalPlayableUrl: torrentioPlayableUrl || mediaFusionPlayableUrl, _torrentioPlayableUrl: torrentioPlayableUrl,
        _mediafusionPlayableUrl: mediaFusionPlayableUrl, _mediafusionPassthrough: Boolean(mediaFusionPlayableUrl),
        _torrentioPassthrough: Boolean(torrentioPlayableUrl), _externalOriginalUrl: rawUrl,
        isCached: externalCached, cacheState: externalRdState, rdCacheState: externalRdState,
        cached_rd: externalCachedBool, _dbCachedRd: externalCachedBool, _nexusBridgeRdChecked: Boolean(trustedDirectUrl || torrentioCachedMarker || torrentioDownloadMarker), _externalRdChecked: Boolean(trustedDirectUrl || torrentioCachedMarker || torrentioDownloadMarker),
        _torrentioRdAuthority: Boolean(torrentioCachedMarker || trustedTorrentioDirectUrl), _torrentioCached: Boolean(torrentioCachedMarker || trustedTorrentioDirectUrl),
        _torrentioRdDirect: Boolean(trustedTorrentioDirectUrl), _torrentioRdDownload: Boolean(torrentioDownloadMarker),
        _mediafusionRdAuthority: Boolean(trustedMediaFusionDirectUrl), _rdProof: trustedMediaFusionDirectUrl ? 'mediafusion_passthrough_url' : (torrentioDownloadMarker ? 'torrentio_download_marker' : (torrentioCachedMarker ? 'torrentio_cached_marker' : undefined)),
        pubDate: new Date().toISOString(), isItalian: languageInfo.isItalian, hasItalianAudio: languageInfo.hasAudioItalian,
        hasItalianSubs: languageInfo.hasSubItalian, languageInfo, techTags
    };

    normalized._score = scoreNormalizedStream(normalized);
    if (normalized.infoHash && getAddonGroup(addonKey) === 'torrentio' && languageInfo.isItalian) {
        const sourceKey = normalizeForComparison([normalized.source, normalized.externalProvider, normalized.title, normalized.url].filter(Boolean).join('|'));
        normalized._dedupeKey = `torrentio:${normalized.infoHash}:${normalized.fileIdx}:${sourceKey || 'nosource'}`;
    } else {
        normalized._dedupeKey = normalized.infoHash ? `${normalized.infoHash}:${normalized.fileIdx}` : `${normalizeForComparison(normalized.title)}|${normalized.url || ''}`;
    }
    return normalized;
}

function mergeNormalizedStream(base, candidate) {
    const winner = (candidate._score || 0) > (base._score || 0) ? candidate : base;
    const loser = winner === base ? candidate : base;

    winner.seeders = Math.max(winner.seeders || 0, loser.seeders || 0);
    winner.mainFileSize = Math.max(winner.mainFileSize || 0, loser.mainFileSize || 0);
    winner.size = winner.size || loser.size;
    winner.url = winner.url || loser.url;
    winner.directUrl = winner.directUrl || loser.directUrl;
    winner.externalDirectUrl = winner.externalDirectUrl || loser.externalDirectUrl;
    winner._externalDirectUrl = winner._externalDirectUrl || loser._externalDirectUrl;
    winner.externalPlayableUrl = winner.externalPlayableUrl || loser.externalPlayableUrl;
    winner._torrentioPlayableUrl = winner._torrentioPlayableUrl || loser._torrentioPlayableUrl;
    winner._mediafusionPlayableUrl = winner._mediafusionPlayableUrl || loser._mediafusionPlayableUrl;
    winner._externalOriginalUrl = winner._externalOriginalUrl || loser._externalOriginalUrl;
    winner._torrentioPassthrough = winner._torrentioPassthrough || loser._torrentioPassthrough;
    winner._mediafusionPassthrough = winner._mediafusionPassthrough || loser._mediafusionPassthrough;
    winner._mediafusionRdAuthority = winner._mediafusionRdAuthority || loser._mediafusionRdAuthority;
    winner._torrentioRdAuthority = winner._torrentioRdAuthority || loser._torrentioRdAuthority;
    winner._torrentioCached = winner._torrentioCached || loser._torrentioCached;
    winner._torrentioRdDirect = winner._torrentioRdDirect || loser._torrentioRdDirect;
    winner._torrentioRdDownload = winner._torrentioRdDownload || loser._torrentioRdDownload;
    winner._rdProof = winner._rdProof || loser._rdProof;
    if ((winner.rdCacheState || winner.cacheState) !== 'cached' && (loser.rdCacheState === 'download' || loser.cacheState === 'download')) {
        winner.rdCacheState = 'download';
        winner.cacheState = 'download';
    }
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
        const key = stream._dedupeKey || `${normalizeForComparison(stream.title)}|${stream.url || ''}`;
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
    const minimumConfidence = Number(options.minimumItalianConfidence || 35);
    const analysis = analyzeItalianSignals(stream);
    return analysis.isItalian && analysis.confidence >= minimumConfidence;
}

function isRealExternalResult(stream) {
    if (!stream || typeof stream !== 'object') return false;
    const title = normalizeText(stream.title || stream.filename || stream.name || stream.websiteTitle || '');
    if (!title || title.length < 3 || FAKE_RESULT_REGEX.test(title)) return false;
    return Boolean(extractInfoHash(stream) || stream.magnetLink || stream.magnet || stream.url);
}

function countRealResults(streams) {
    return (Array.isArray(streams) ? streams : []).filter(isRealExternalResult).length;
}

function pickBrowserProfile(addonKey, id) {
    const seed = crypto.createHash('sha1').update(`${addonKey}:${id}`).digest('hex');
    const idx = parseInt(seed.slice(0, 4), 16) % BROWSER_PROFILES.length;
    return BROWSER_PROFILES[idx];
}

function buildBrowserHeaders(profile, targetUrl) {
    let origin;
    try { origin = new URL(targetUrl).origin; } catch { origin = 'https://stremio.com'; }

    const headers = {
        'User-Agent': profile.userAgent,
        Accept: profile.accept,
        'Accept-Language': profile.acceptLanguage,
        'Accept-Encoding': 'gzip, deflate, br',
        Connection: 'keep-alive',
        'Cache-Control': 'no-cache',
        Pragma: 'no-cache',
        'Sec-Fetch-Dest': profile.secFetchDest,
        'Sec-Fetch-Mode': profile.secFetchMode,
        'Sec-Fetch-Site': profile.secFetchSite,
        'Sec-Fetch-User': profile.secFetchUser,
        Referer: `${origin}/`
    };

    if (profile.secChUa) {
        headers['Sec-CH-UA'] = profile.secChUa;
        headers['Sec-CH-UA-Mobile'] = profile.secChUaMobile;
        headers['Sec-CH-UA-Platform'] = profile.secChUaPlatform;
    }

    if (profile.name.startsWith('firefox')) {
        headers.DNT = '1';
        headers['Upgrade-Insecure-Requests'] = '1';
    }

    if (profile.name.startsWith('chrome') || profile.name.startsWith('safari')) headers['Upgrade-Insecure-Requests'] = '1';
    return headers;
}

function computeJitter(addonKey) {
    const state = addonHealth.get(addonKey);
    const failures = state?.failures || 0;
    const base = 80 + Math.floor(Math.random() * 200);
    const extra = Math.min(failures * 100, 500);
    return base + extra;
}

async function fetchConfiguredExternalAddon(addonKey, type, id, options = {}) {
    const addon = getAddon(addonKey);
    if (!addon) {
        logger.error(`❌ [External] Unknown addon: ${addonKey}`);
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
        const addonGroup = getAddonGroup(addonKey);
        if (addonGroup === 'torrentio') baseUrl = buildTorrentioBaseUrl(baseUrl, options.userConfig || null);
        if (addonGroup === 'mediafusion') baseUrl = buildMediaFusionBaseUrl(baseUrl, options.userConfig || null);
        if (!baseUrl) return [];

        const fetchType = sanitizeFetchType(type, id);
        const safeId = sanitizePathSegment(id);
        const url = `${baseUrl}/stream/${fetchType}/${safeId}.json`;

        debugLog(`🌐 [${addon.name}] Fetching ${fetchType}/${id}`);
        const startedAt = now();

        try {
            const jitter = computeJitter(addonKey);
            await new Promise((resolve) => setTimeout(resolve, jitter));

            const profile = pickBrowserProfile(addonKey, String(id));
            const headers = buildBrowserHeaders(profile, url);

            debugLog(`🕵️ [${addon.name}] Profile: ${profile.name}, jitter: ${jitter}ms`);

            const response = await requestWithImpit({
                url,
                method: 'GET',
                headers,
                timeout: addon.timeout,
                browser: getImpitBrowserForFingerprint(profile),
                responseType: 'text'
            });

            let data;
            try {
                data = JSON.parse(response.body);
            } catch {
                throw new Error(`Invalid JSON response (status ${response.statusCode})`);
            }

            const streams = Array.isArray(data?.streams) ? data.streams : [];
            const trustItalian = addonKey === 'torrentio_mirror' && addon.trustItalian === true && options.onlyItalian !== false;
            const filteredStreams = options.onlyItalian === false
                ? streams
                : streams.filter((stream) => {
                    if (trustItalian) return true;
                    const analysis = analyzeItalianSignals(stream);
                    if (addonKey === 'torrentio_mirror') {
                        const evidence = getTorrentioLanguageEvidence(stream);
                        if (evidence.hasItalian) return true;
                        if (!evidence.hasItalian && evidence.hasForeign) return false;
                    }
                    return analysis.isItalian && analysis.confidence >= Number(options.minimumItalianConfidence || 35);
                });
            debugLog(`🇮🇹 [${addon.name}] Filter ${streams.length} -> ${filteredStreams.length}${trustItalian ? ' (forced-trusted-mirror)' : ''}`);
            if (streams.length > 0 && filteredStreams.length === 0 && options.onlyItalian !== false) {
                infoLog(`[${addon.name}] raw=${streams.length} ma filtro lingua ITA=0`);
            }

            const normalized = dedupeNormalizedStreams(
                filteredStreams.map((stream) => normalizeExternalStream(stream, addonKey, fetchType)).filter(Boolean)
            );

            registerAddonSuccess(addonKey, now() - startedAt);
            const ttl = normalized.length > 0 ? FETCH_CACHE_TTL : NEGATIVE_CACHE_TTL;
            setCache(fetchCache, cacheKey, normalized, ttl);
            return normalized;
        } catch (error) {
            const isTimeout = error.name === 'TimeoutError' || error.code === 'ETIMEDOUT' || error.code === 'ESOCKETTIMEDOUT';
            const errorMessage = isTimeout ? `Timeout after ${addon.timeout}ms` : (error?.message || String(error));

            registerAddonFailure(addonKey, addon, errorMessage);
            if (isTimeout) logger.warn(`⏱️ [${addon.name}] ${errorMessage}`);
            else logger.warn(`❌ [${addon.name}] Error: ${errorMessage}`);

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

module.exports = {
    EXTERNAL_ADDONS,
    QUALITY_PATTERNS,
    TimedLruCache,
    debugLog,
    infoLog,
    normalizeText,
    normalizeForComparison,
    looksLikeSeasonPackTitle,
    getStreamText,
    analyzeItalianSignals,
    isItalianContent,
    extractInfoHash,
    extractQuality,
    extractSeeders,
    extractSize,
    formatBytes,
    getTorrentioCredential,
    getRealDebridToken,
    normalizeTorrentioDebridOptions,
    hasTorrentioRdDownloadMarkerFromStream,
    hasTorrentioRdCachedMarkerFromStream,
    sanitizeFetchType,
    normalizeExternalStream,
    mergeNormalizedStream,
    dedupeNormalizedStreams,
    passesItalianFilter,
    isRealExternalResult,
    countRealResults,
    fetchConfiguredExternalAddon
};

