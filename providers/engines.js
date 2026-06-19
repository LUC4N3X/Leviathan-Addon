const axios = require("axios");
const cheerio = require("cheerio");
const https = require("https");
const pLimitModule = require("p-limit");
const pLimit = typeof pLimitModule === "function" ? pLimitModule : pLimitModule.default;
const he = require("he");
const { ENGINE_BROWSER_PROFILES } = require('../core/security/browser_profiles');
const { TtlLruCache } = require('./utils/provider_runtime');
const { requestWithImpit } = require('./utils/bypass');

const BROWSER_PROFILES = ENGINE_BROWSER_PROFILES;

const DEFAULT_TRACKERS = [
    "udp://tracker.opentrackr.org:1337/announce",
    "udp://tracker.openbittorrent.com:6969/announce",
    "udp://open.demonoid.ch:6969/announce",
    "udp://open.demonii.com:1337/announce",
    "udp://open.stealth.si:80/announce",
    "udp://tracker.torrent.eu.org:451/announce",
    "udp://tracker.tiny-vps.com:6969/announce",
    "udp://tracker.therarbg.to:6969/announce",
    "udp://tracker.doko.moe:6969/announce",
    "udp://opentracker.i2p.rocks:6969/announce",
    "udp://exodus.desync.com:6969/announce",
    "udp://tracker.moeking.me:6969/announce"
];

const CONFIG = {
    TIMEOUT: Number(process.env.ENGINES_TIMEOUT || 12000),
    TIMEOUT_API: Number(process.env.ENGINES_TIMEOUT_API || 8000),
    ENGINE_TIMEOUT: Number(process.env.ENGINES_ENGINE_TIMEOUT || 9000),
    MAX_CONCURRENCY: Number(process.env.ENGINES_MAX_CONCURRENCY || 24),
    ENGINE_CONCURRENCY: Number(process.env.ENGINES_ENGINE_CONCURRENCY || 8),
    DETAIL_FETCH_CONCURRENCY: Number(process.env.ENGINES_DETAIL_CONCURRENCY || 12),
    RESULT_LIMIT_PER_ENGINE: Number(process.env.ENGINES_RESULT_LIMIT_PER_ENGINE || 120),
    FINAL_RESULT_LIMIT: Number(process.env.ENGINES_FINAL_RESULT_LIMIT || 300),
    MAX_QUERY_VARIANTS_PER_ENGINE: Number(process.env.ENGINES_MAX_QUERY_VARIANTS || 4),
    MAX_ANIME_QUERY_VARIANTS_PER_ENGINE: Number(process.env.ENGINES_MAX_ANIME_QUERY_VARIANTS || 8),
    QUERY_CONCURRENCY: Number(process.env.ENGINES_QUERY_CONCURRENCY || 2),
    KNABEN_QUERY_CONCURRENCY: Number(process.env.KNABEN_QUERY_CONCURRENCY || 3),
    KNABEN_FRESH_TTL_MS: Number(process.env.KNABEN_FRESH_TTL_MS || 20 * 60 * 1000),
    KNABEN_STALE_TTL_MS: Number(process.env.KNABEN_STALE_TTL_MS || 24 * 60 * 60 * 1000),
    CORSARO_QUERY_CONCURRENCY: Number(process.env.CORSARO_QUERY_CONCURRENCY || 2),
    CORSARO_SEARCH_TIMEOUT_MS: Number(process.env.CORSARO_SEARCH_TIMEOUT_MS || 3500),
    CORSARO_DETAIL_TIMEOUT_MS: Number(process.env.CORSARO_DETAIL_TIMEOUT_MS || 2600),
    CORSARO_MAX_DETAIL_CANDIDATES: Number(process.env.CORSARO_MAX_DETAIL_CANDIDATES || 18),
    CORSARO_FRESH_TTL_MS: Number(process.env.CORSARO_FRESH_TTL_MS || 10 * 60 * 1000),
    CORSARO_STALE_TTL_MS: Number(process.env.CORSARO_STALE_TTL_MS || 6 * 60 * 60 * 1000),
    UINDEX_QUERY_CONCURRENCY: Number(process.env.UINDEX_QUERY_CONCURRENCY || 3),
    UINDEX_SEARCH_TIMEOUT_MS: Number(process.env.UINDEX_SEARCH_TIMEOUT_MS || 3500),
    UINDEX_DETAIL_TIMEOUT_MS: Number(process.env.UINDEX_DETAIL_TIMEOUT_MS || 2400),
    UINDEX_MAX_DETAIL_CANDIDATES: Number(process.env.UINDEX_MAX_DETAIL_CANDIDATES || 20),
    UINDEX_FRESH_TTL_MS: Number(process.env.UINDEX_FRESH_TTL_MS || 15 * 60 * 1000),
    UINDEX_STALE_TTL_MS: Number(process.env.UINDEX_STALE_TTL_MS || 12 * 60 * 60 * 1000),
    KAT_QUERY_CONCURRENCY: Number(process.env.KAT_QUERY_CONCURRENCY || 2),
    KAT_SEARCH_TIMEOUT_MS: Number(process.env.KAT_SEARCH_TIMEOUT_MS || 4500),
    TORLOCK_QUERY_CONCURRENCY: Number(process.env.TORLOCK_QUERY_CONCURRENCY || 2),
    TORLOCK_SEARCH_TIMEOUT_MS: Number(process.env.TORLOCK_SEARCH_TIMEOUT_MS || 5000),
    TORLOCK_DETAIL_TIMEOUT_MS: Number(process.env.TORLOCK_DETAIL_TIMEOUT_MS || 3000),
    TORLOCK_MAX_DETAIL_CANDIDATES: Number(process.env.TORLOCK_MAX_DETAIL_CANDIDATES || 14),
    TORRENTDOWNLOADS_QUERY_CONCURRENCY: Number(process.env.TORRENTDOWNLOADS_QUERY_CONCURRENCY || 2),
    TORRENTDOWNLOADS_SEARCH_TIMEOUT_MS: Number(process.env.TORRENTDOWNLOADS_SEARCH_TIMEOUT_MS || 5000),
    THERARBG_QUERY_CONCURRENCY: Number(process.env.THERARBG_QUERY_CONCURRENCY || 2),
    THERARBG_SEARCH_TIMEOUT_MS: Number(process.env.THERARBG_SEARCH_TIMEOUT_MS || 5000),
    THERARBG_DETAIL_TIMEOUT_MS: Number(process.env.THERARBG_DETAIL_TIMEOUT_MS || 3000),
    THERARBG_MAX_DETAIL_CANDIDATES: Number(process.env.THERARBG_MAX_DETAIL_CANDIDATES || 14),
    YTS_TIMEOUT_MS: Number(process.env.YTS_TIMEOUT_MS || 6000),
    YTS_FRESH_TTL_MS: Number(process.env.YTS_FRESH_TTL_MS || 30 * 60 * 1000),
    YTS_STALE_TTL_MS: Number(process.env.YTS_STALE_TTL_MS || 12 * 60 * 60 * 1000),
    EZTV_TIMEOUT_MS: Number(process.env.EZTV_TIMEOUT_MS || 7000),
    EZTV_FRESH_TTL_MS: Number(process.env.EZTV_FRESH_TTL_MS || 30 * 60 * 1000),
    EZTV_STALE_TTL_MS: Number(process.env.EZTV_STALE_TTL_MS || 12 * 60 * 60 * 1000),
    SOLID_QUERY_CONCURRENCY: Number(process.env.SOLID_QUERY_CONCURRENCY || 1),
    SOLID_TIMEOUT_MS: Number(process.env.SOLID_TIMEOUT_MS || 6500),
    SOLID_MIN_INTERVAL_MS: Number(process.env.SOLID_MIN_INTERVAL_MS || 2000),
    SOLID_MAX_QUERY_VARIANTS: Number(process.env.SOLID_MAX_QUERY_VARIANTS || 2),
    SOLID_FRESH_TTL_MS: Number(process.env.SOLID_FRESH_TTL_MS || 20 * 60 * 1000),
    SOLID_STALE_TTL_MS: Number(process.env.SOLID_STALE_TTL_MS || 12 * 60 * 60 * 1000),
    SEARCH_CACHE_TTL: Number(process.env.ENGINES_SEARCH_CACHE_TTL || 180000),
    HTML_CACHE_TTL: Number(process.env.ENGINES_HTML_CACHE_TTL || 45000),
    NEGATIVE_CACHE_TTL: Number(process.env.ENGINES_NEGATIVE_CACHE_TTL || 20000),
    RETRIES: Number(process.env.ENGINES_RETRIES || 2),
    RETRY_BACKOFF_MS: Number(process.env.ENGINES_RETRY_BACKOFF_MS || 350),
    KNABEN_API: "https://api.knaben.org/v1",
    MAGNET_MAX_TRACKERS: Number(process.env.ENGINES_MAGNET_MAX_TRACKERS || 30),
    TRACKERS: [...DEFAULT_TRACKERS],
    HTTPS_AGENT_OPTIONS: {
        rejectUnauthorized: false,
        keepAlive: true,
        keepAliveMsecs: 10000,
        maxSockets: 64,
        maxFreeSockets: 16
    }
};

const httpsAgent = new https.Agent(CONFIG.HTTPS_AGENT_OPTIONS);
const detailLimit = pLimit(CONFIG.DETAIL_FETCH_CONCURRENCY);
const engineLimit = pLimit(CONFIG.ENGINE_CONCURRENCY);
const searchCache = new TtlLruCache({ name: 'engines:search', max: 800, ttlMs: CONFIG.SEARCH_CACHE_TTL });
const htmlCache = new TtlLruCache({ name: 'engines:html', max: 800, ttlMs: CONFIG.HTML_CACHE_TTL });
const knabenCache = new TtlLruCache({
    name: 'engines:knaben:fresh-stale',
    max: 600,
    ttlMs: CONFIG.KNABEN_FRESH_TTL_MS,
    staleTtlMs: CONFIG.KNABEN_STALE_TTL_MS,
    staleMode: 'extension'
});
const corsaroCache = new TtlLruCache({
    name: 'engines:corsaro:fresh-stale',
    max: 400,
    ttlMs: CONFIG.CORSARO_FRESH_TTL_MS,
    staleTtlMs: CONFIG.CORSARO_STALE_TTL_MS,
    staleMode: 'extension'
});
const uindexCache = new TtlLruCache({
    name: 'engines:uindex:fresh-stale',
    max: 500,
    ttlMs: CONFIG.UINDEX_FRESH_TTL_MS,
    staleTtlMs: CONFIG.UINDEX_STALE_TTL_MS,
    staleMode: 'extension'
});
const ytsCache = new TtlLruCache({
    name: 'engines:yts:fresh-stale',
    max: 400,
    ttlMs: CONFIG.YTS_FRESH_TTL_MS,
    staleTtlMs: CONFIG.YTS_STALE_TTL_MS,
    staleMode: 'extension'
});
const eztvCache = new TtlLruCache({
    name: 'engines:eztv:fresh-stale',
    max: 400,
    ttlMs: CONFIG.EZTV_FRESH_TTL_MS,
    staleTtlMs: CONFIG.EZTV_STALE_TTL_MS,
    staleMode: 'extension'
});
const solidCache = new TtlLruCache({
    name: 'engines:solid:fresh-stale',
    max: 400,
    ttlMs: CONFIG.SOLID_FRESH_TTL_MS,
    staleTtlMs: CONFIG.SOLID_STALE_TTL_MS,
    staleMode: 'extension'
});
const knabenRefreshInflight = new Map();
const corsaroRefreshInflight = new Map();
const uindexRefreshInflight = new Map();
const ytsRefreshInflight = new Map();
const eztvRefreshInflight = new Map();
const solidRefreshInflight = new Map();
const engineProviderCooldowns = new Map();
const engineProviderQueues = new Map();
const inflightRequests = new Map();

async function requestWithImpitFallback(url, config = {}) {
    const response = await requestWithImpit({
        url,
        method: "GET",
        headers: config.headers,
        timeout: config.timeout || CONFIG.TIMEOUT,
        ignoreTlsErrors: true,
        followRedirect: (config.maxRedirects ?? 5) > 0,
        maxRedirects: config.maxRedirects ?? 5,
        responseType: "text"
    });

    return {
        data: response.body,
        status: response.statusCode,
        headers: response.headers || {}
    };
}

const ITALIAN_AUDIO_REGEX = /\b(?:ITA(?:LIAN(?:O)?)?(?:\s*(?:AUDIO|DDP|AAC|AC3|EAC3|ATMOS|TRUEHD|DTS(?:-?HD)?))?|MULTI\s*ITA|DUAL\s*AUDIO\s*ITA|TRUE\s*ITALIAN|AUDIO\s*ITA|ITA\s*AC3|ITA\s*AAC|ITA\s*DDP|ITA\s*DTS|ITA\s*TRUEHD)\b/i;
const ITALIAN_SUB_REGEX = /\b(?:SUB[-.\s_]*ITA|SOFTSUB[-.\s_]*ITA|VOST(?:ITA)?|ITALIAN\s*SUBS?)\b/i;
const TRUSTED_ITALIAN_REGEX = /\b(?:CORSARO|ICV|MEGAPHONE|IDN[_\s-]*CREW|DDN|MUX(?:\s*ITA)?|TRIDIM|LUX|WMS|CiNEFiLE|SPEEDVIDEO|CORSARO(?:NERO)?)\b/i;
const NEGATIVE_LANGUAGE_REGEX = /\b(?:TRUEFRENCH|FRENCH|GERMAN|SPANISH|LATINO|RUSSIAN|POLISH|TAMIL|TELUGU|HINDI|KOREAN|JAPANESE|ENG(?:LISH)?\s*ONLY|DUBBED\s*ENG)\b/i;
const OTHER_LANGUAGE_REGEX = /\b(?:TRUEFRENCH|FRENCH|GERMAN|SPANISH|LATINO|RUSSIAN|POLISH|LEKTOR|NAPISY|PLDUB|PLSUB(?:BED)?|TAMIL|TELUGU|HINDI|KOREAN|JAPANESE)\b/i;
const ENGLISH_AUDIO_REGEX = /\b(?:ENG(?:LISH)?(?:\s*(?:AUDIO|DDP|AAC|AC3|EAC3|ATMOS|TRUEHD|DTS(?:-?HD)?))?|TRUE\s*ENGLISH|AUDIO\s*ENG|ENG\s*AC3|ENG\s*AAC|ENG\s*DDP|ENG\s*DTS|ENG\s*TRUEHD|DUBBED\s*ENG|ENG(?:LISH)?\s*ONLY)\b/i;
const MULTI_LANGUAGE_REGEX = /\b(?:MULTI(?:LANG|AUDIO)?|DUAL\s*AUDIO)\b/i;
const NOISY_TITLE_REGEX = /\b(?:x265\s*meets|sample|trailer|soundtrack|ebook|audiobook|xxx|porn)\b/i;
const QUALITY_SCORES = [
    { regex: /\b(?:2160p|4k|uhd)\b/i, value: 4 },
    { regex: /\b1080p\b/i, value: 3 },
    { regex: /\b720p\b/i, value: 2 },
    { regex: /\b(?:480p|sd)\b/i, value: 1 }
];
const SOURCE_WEIGHTS = {
    Corsaro: 28,
    Knaben: 26,
    Nyaa: 25,
    SubsPlease: 25,
    "1337x": 23,
    BitSearch: 22,
    RARBG: 21,
    LimeTorrents: 19,
    YTS: 22,
    EZTV: 22,
    SolidTorrents: 21,
    KickassTorrents: 21,
    TorLock: 20,
    TheRarBG: 20,
    TorrentDownloads: 18,
    "TPB Mirror": 18,
    TPB: 17,
    UIndex: 14
};
const ENGINE_BLACKLISTED_CATEGORIES = new Set([6006000, 6007000, 6005000]);
const KNABEN_CATEGORY_MOVIE = [3000000];
const KNABEN_CATEGORY_SERIES = [2000000];
const KNABEN_CATEGORY_ANIME = [2000000, 6000000, 6001000, 6002000, 6003000, 6008000];
const KNABEN_CATEGORY_BLACKLIST = new Set([6005000, 6006000, 6007000]);
const ANIME_RELEASE_GROUP_REGEX = /\b(?:SUBSPLEASE|ERAI[-.\s]?RAWS|HORRIBLESUBS|EMBER|JUDAS|ASW|RAZE|MUSE|ANI|YAMEII|DUBS[-.\s]?EMPIRE|SEADEx|KAWAIKA|CTR|PAS)\b/i;
const ANIME_RELEASE_FEATURE_REGEX = /\b(?:BD(?:REMUX|RIP)?|BLU[-.\s]?RAY|WEB[-.\s]?DL|WEBRIP|HEVC|X265|H265|AV1|OPUS|FLAC|AAC|SOFTSUB|SUBBED|DUAL[-.\s]?AUDIO|MULTI)\b/i;
const ANIME_FOREIGN_DUB_REGEX = /\b(?:TRUEFRENCH|FRENCH|GERMAN|SPANISH|LATINO|RUSSIAN|POLISH|TAMIL|TELUGU|HINDI|KOREAN|DUBBED\s*ENG|ENG(?:LISH)?\s*ONLY)\b/i;
const TRUSTED_ANIME_TRACKER_REGEX = /\b(?:NYAA|ANIMETOSHO|TOKYOTOSHO|SEADEx|NEKOBT|SUBSPLEASE)\b/i;

function now() {
    return Date.now();
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function getCache(map, key) {
    if (!map || typeof map.get !== 'function') return null;
    const value = map.get(key);
    return value === undefined ? null : value;
}

function setCache(map, key, value, ttl) {
    if (!ttl || ttl <= 0) return value;
    if (map && typeof map.set === 'function') map.set(key, value, ttl);
    if (map && map.size > 800) pruneCache(map);
    return value;
}

function pruneCache(map) {
    if (map && typeof map.prune === 'function') {
        map.prune(now());
        return;
    }
    const ts = now();
    for (const [key, entry] of map.entries()) {
        if (!entry || entry.expiresAt <= ts) map.delete(key);
    }
    while (map.size > 600) {
        const firstKey = map.keys().next().value;
        if (firstKey === undefined) break;
        map.delete(firstKey);
    }
}

function withTimeout(promise, ms) {
    let timer = null;
    return new Promise((resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`timeout of ${ms}ms exceeded`)), ms);
        Promise.resolve(promise)
            .then(value => resolve(value))
            .catch(error => reject(error))
            .finally(() => clearTimeout(timer));
    });
}

function clean(title) {
    if (!title) return "";
    const decoded = he.decode(String(title));
    return decoded
        .normalize("NFKD")
        .replace(/[\u0300-\u036f]/g, "")
        .replace(/[:"'`´‘’]/g, "")
        .replace(/[^a-zA-Z0-9\s\-.\[\]()/]/g, " ")
        .replace(/\s+/g, " ")
        .trim();
}

function normalizeSpaces(value) {
    return String(value || "")
        .replace(/[\u2010-\u2015]/g, "-")
        .replace(/[|_]+/g, " ")
        .replace(/\s+/g, " ")
        .trim();
}

function tokenizeTitle(value) {
    return clean(value)
        .toLowerCase()
        .replace(/\b(?:the|a|an|un|una|il|lo|la|gli|le|di|de|del|della|season|stagione|episode|episodio|part)\b/g, " ")
        .replace(/\b(?:2160p|1080p|720p|480p|x264|x265|h264|h265|hevc|hdr|dv|ddp|aac|ac3|remux|webdl|webrip|bluray|brrip|dvdrip)\b/g, " ")
        .replace(/\b(19\d{2}|20\d{2})\b/g, " ")
        .split(/\s+/)
        .filter(token => token && token.length > 1);
}

function titleMatchScore(candidate, expectedTitle) {
    const candTokens = tokenizeTitle(candidate);
    const expectedTokens = tokenizeTitle(expectedTitle);
    if (!expectedTokens.length || !candTokens.length) return 0;
    const candSet = new Set(candTokens);
    const expectedSet = new Set(expectedTokens);
    let hits = 0;
    for (const token of expectedSet) {
        if (candSet.has(token)) hits += 1;
    }
    return hits / Math.max(expectedSet.size, 1);
}

function parseSize(sizeStr) {
    if (!sizeStr) return 0;
    const normalized = String(sizeStr).replace(",", ".");
    const match = normalized.match(/([\d.]+)\s*(PB|TB|GB|MB|KB|B|PIB|TIB|GIB|MIB|KIB)/i);
    if (!match) return 0;
    const value = parseFloat(match[1]);
    if (!Number.isFinite(value) || value <= 0) return 0;
    const unit = match[2].toUpperCase();
    const multipliers = {
        B: 1,
        KB: 1024,
        KIB: 1024,
        MB: 1024 ** 2,
        MIB: 1024 ** 2,
        GB: 1024 ** 3,
        GIB: 1024 ** 3,
        TB: 1024 ** 4,
        TIB: 1024 ** 4,
        PB: 1024 ** 5,
        PIB: 1024 ** 5
    };
    return Math.round(value * (multipliers[unit] || 1));
}

function bytesToSize(bytes) {
    const value = Number(bytes);
    if (!Number.isFinite(value) || value <= 0) return "?? GB";
    const sizes = ["B", "KB", "MB", "GB", "TB"];
    const index = Math.min(Math.floor(Math.log(value) / Math.log(1024)), sizes.length - 1);
    const normalized = value / (1024 ** index);
    return `${normalized.toFixed(index === 0 ? 0 : 2)} ${sizes[index]}`;
}

function extractEpisodeContext(imdbId) {
    if (!imdbId || typeof imdbId !== "string") return {};
    const parts = imdbId.split(":");
    if (parts.length < 3) return {};

    let season = null;
    let episode = null;

    if (parts[0].toLowerCase() === "kitsu" && /^\d+$/.test(parts[1])) {
        season = parts.length >= 4 ? parseInt(parts[2], 10) : 1;
        episode = parseInt(parts[parts.length >= 4 ? 3 : 2], 10);
    } else {
        season = parseInt(parts[1], 10);
        episode = parseInt(parts[2], 10);
    }

    return {
        season: Number.isInteger(season) ? season : undefined,
        episode: Number.isInteger(episode) ? episode : undefined
    };
}

function normalizeType(type) {
    const raw = String(type || "").toLowerCase();
    if (raw === "tv" || raw === "series" || raw === "anime") return "series";
    return "movie";
}

function resolveLangMode(options = {}) {
    const explicit = String(options.langMode || options.languageMode || options.language || '').toLowerCase();
    if (explicit === 'ita' || explicit === 'eng' || explicit === 'all') return explicit;
    if (typeof options.allowEng === 'boolean') return options.allowEng ? 'all' : 'ita';
    return 'ita';
}

function getAcceptLanguage(langMode = 'ita') {
    if (langMode === 'eng') return 'en-US,en;q=0.9';
    if (langMode === 'all') return 'it-IT,it;q=0.9,en-US;q=0.8,en;q=0.7';
    return 'it-IT,it;q=0.9,en-US;q=0.8,en;q=0.7';
}

function getStealthHeaders(url, langMode = 'ita') {
    const profile = BROWSER_PROFILES[Math.floor(Math.random() * BROWSER_PROFILES.length)];
    const urlObj = new URL(url);
    return {
        profileName: profile.name,
        headers: {
            "User-Agent": profile.userAgent,
            Referer: `${urlObj.origin}/`,
            Origin: urlObj.origin,
            ...profile.headers,
            "Accept-Language": getAcceptLanguage(langMode)
        }
    };
}

function isCloudflareResponse(data) {
    if (typeof data !== "string") return false;
    return /cloudflare|verify you are human|attention required|cf-browser-verification/i.test(data);
}

function mergeHeaders(url, customHeaders = {}, langMode = 'ita') {
    const { headers: stealthHeaders } = getStealthHeaders(url, langMode);
    return { ...stealthHeaders, ...customHeaders };
}

async function requestHtml(url, config = {}, retries = CONFIG.RETRIES) {
    const method = String(config.method || "GET").toUpperCase();
    const timeout = config.timeout || CONFIG.TIMEOUT;
    const cacheKey = `${method}:${url}:${method === "POST" ? JSON.stringify(config.data || {}) : ""}`;

    if (method === "GET" && !config.skipCache) {
        const cached = getCache(htmlCache, cacheKey);
        if (cached) return cached;
    }

    const inflight = inflightRequests.get(cacheKey);
    if (inflight) return inflight;

    const requestPromise = (async () => {
        const headers = mergeHeaders(url, config.headers, config.langMode || 'ita');
        let lastError = null;

        for (let attempt = 0; attempt <= retries; attempt += 1) {
            try {
                const response = await axios({
                    url,
                    method,
                    headers,
                    data: config.data,
                    httpsAgent,
                    timeout,
                    maxRedirects: config.maxRedirects ?? 5,
                    validateStatus: config.validateStatus || (status => status >= 200 && status < 500)
                });

                if (method === "GET" && isCloudflareResponse(response.data)) {
                    throw new Error("CF challenge");
                }

                if (method === "GET" && !config.skipCache) {
                    setCache(htmlCache, cacheKey, response, CONFIG.HTML_CACHE_TTL);
                }
                return response;
            } catch (error) {
                lastError = error;
                const canTryImpit = method === "GET";
                if (canTryImpit) {
                    try {
                        const response = await requestWithImpitFallback(url, {
                            headers,
                            timeout,
                            maxRedirects: config.maxRedirects
                        });
                        if (isCloudflareResponse(response.data)) {
                            throw new Error("CF challenge");
                        }
                        if (!config.skipCache) {
                            setCache(htmlCache, cacheKey, response, CONFIG.HTML_CACHE_TTL);
                        }
                        return response;
                    } catch (scrapingError) {
                        lastError = scrapingError;
                    }
                }

                if (attempt < retries) {
                    await sleep(CONFIG.RETRY_BACKOFF_MS * (attempt + 1));
                }
            }
        }

        return { data: "", status: 599, headers: {}, error: lastError };
    })();

    inflightRequests.set(cacheKey, requestPromise);
    try {
        return await requestPromise;
    } finally {
        inflightRequests.delete(cacheKey);
    }
}

let _centralTrackerRegistry;
function getCentralTrackers() {
    if (_centralTrackerRegistry === undefined) {
        try {
            _centralTrackerRegistry = require('../core/storage/tracker_registry');
        } catch (_) {
            _centralTrackerRegistry = null;
        }
    }
    if (_centralTrackerRegistry && typeof _centralTrackerRegistry.getActiveTrackers === 'function') {
        try {
            const list = _centralTrackerRegistry.getActiveTrackers();
            return Array.isArray(list) ? list : [];
        } catch (_) {
            return [];
        }
    }
    return [];
}

function buildMagnetFromHash(hash, name = "") {
    if (!hash) return null;
    const dn = name ? `&dn=${encodeURIComponent(name)}` : "";
    return `magnet:?xt=urn:btih:${hash}${dn}`;
}

function extractInfoHash(magnet) {
    if (!magnet) return null;
    const match = String(magnet).match(/btih:([A-Fa-f0-9]{40}|[A-Za-z2-7]{32})/i);
    return match ? match[1].toLowerCase() : null;
}

function appendTrackers(magnet) {
    if (!magnet) return null;
    if (magnet.includes("&tr=") || magnet.includes("?tr=")) return magnet;
    const trackers = [...new Set([...CONFIG.TRACKERS, ...getCentralTrackers()].filter(Boolean))].slice(0, CONFIG.MAGNET_MAX_TRACKERS);
    if (!trackers.length) return magnet;
    return `${magnet}${magnet.includes("?") ? "&" : "?"}${trackers.map(tracker => `tr=${encodeURIComponent(tracker)}`).join("&")}`;
}

function getResolutionScore(text) {
    const normalized = normalizeSpaces(text).toLowerCase();
    for (const item of QUALITY_SCORES) {
        if (item.regex.test(normalized)) return item.value;
    }
    return 0;
}

function isAnimeContext(context = {}) {
    return Boolean(context?.isAnime);
}

function parseMagnetSizeBytes(magnet) {
    const match = String(magnet || "").match(/[?&]xl=(\d+)/i);
    const bytes = match ? parseInt(match[1], 10) : 0;
    return Number.isFinite(bytes) && bytes > 0 ? bytes : 0;
}

function getLanguageScore(name, langMode = 'ita', context = {}) {
    const normalized = normalizeSpaces(name).toUpperCase();
    const animeMode = isAnimeContext(context);
    const hasItalianAudio = ITALIAN_AUDIO_REGEX.test(normalized);
    const hasItalianSubs = ITALIAN_SUB_REGEX.test(normalized);
    const isTrustedItalian = TRUSTED_ITALIAN_REGEX.test(normalized);
    const hasEnglishAudio = ENGLISH_AUDIO_REGEX.test(normalized);
    const hasMultiLanguage = MULTI_LANGUAGE_REGEX.test(normalized);
    const hasOtherLanguage = OTHER_LANGUAGE_REGEX.test(normalized);

    if (langMode === 'eng') {
        if (hasEnglishAudio) {
            if (hasMultiLanguage) return 34;
            if (hasItalianAudio || isTrustedItalian) return 30;
            return 36;
        }
        if (hasOtherLanguage) return -45;
        if (hasItalianAudio || isTrustedItalian || hasItalianSubs) return -38;
        if (hasMultiLanguage) return -18;
        return 12;
    }

    if (langMode === 'all') {
        if (hasOtherLanguage && !hasItalianAudio && !hasEnglishAudio && !hasMultiLanguage) return -30;
        if (hasItalianAudio) return 30;
        if (hasEnglishAudio) return 28;
        if (hasMultiLanguage) return 24;
        if (animeMode && ANIME_RELEASE_GROUP_REGEX.test(normalized)) return 18;
        if (isTrustedItalian) return 20;
        if (hasItalianSubs) return 10;
        return 6;
    }

    if (hasItalianAudio) return 30;
    if (hasMultiLanguage && hasItalianAudio) return 24;
    if (isTrustedItalian && !hasOtherLanguage && !hasEnglishAudio) return 22;
    if (hasItalianSubs && !hasEnglishAudio) return 12;

    if (animeMode) {
        if (hasItalianSubs) return 20;
        if (hasMultiLanguage) return 16;
        if (ANIME_FOREIGN_DUB_REGEX.test(normalized)) return -42;
        if (ANIME_RELEASE_GROUP_REGEX.test(normalized)) return 14;
        if (ANIME_RELEASE_FEATURE_REGEX.test(normalized) && !hasOtherLanguage) return 6;
        if (hasEnglishAudio && !hasMultiLanguage) return -18;
        return 0;
    }

    if (hasEnglishAudio || hasOtherLanguage) return -40;
    if (hasMultiLanguage && !hasItalianAudio) return -40;

    return -8;
}

function hasExplicitSeasonMarker(text = '') {
    return /\b(?:S(?:EASON)?\s*0?\d{1,2}|\d{1,2}x\d{1,3}|STAGIONE\s*0?\d{1,2}|(?:1ST|2ND|3RD|4TH)\s+SEASON)\b/i.test(String(text || ''));
}

function isValidResult(name, langMode = 'ita', context = {}) {
    if (!name) return false;
    const normalized = normalizeSpaces(name);
    if (NOISY_TITLE_REGEX.test(normalized)) return false;
    if (getLanguageScore(normalized, langMode, context) < 0) return false;
    return true;
}

function checkYear(name, year, type) {
    if (!year || normalizeType(type) !== "movie") return true;
    const yearValue = parseInt(year, 10);
    if (!Number.isInteger(yearValue)) return true;
    const matches = [...String(name).matchAll(/\b(19\d{2}|20\d{2})\b/g)].map(match => parseInt(match[1], 10));
    if (!matches.length) return true;
    return matches.some(candidate => Math.abs(candidate - yearValue) <= 1);
}

function isCorrectFormat(name, reqSeason, reqEpisode, context = {}) {
    if (!reqSeason && !reqEpisode) return true;
    const normalized = normalizeSpaces(name).toUpperCase();
    const animeMode = isAnimeContext(context);
    const ignoreAnimeSeason = animeMode && String(context?.imdbId || '').toLowerCase().startsWith('kitsu:') && !hasExplicitSeasonMarker(normalized);

    if (animeMode && reqEpisode) {
        const animeSeasonMatch = normalized.match(/\bS(?:EASON)?\s*0?(\d{1,2})(?!\d)/i)
            || normalized.match(/\b(\d{1,2})(?:ST|ND|RD|TH)\s+SEASON\b/i);
        if (animeSeasonMatch && reqSeason && !ignoreAnimeSeason) {
            const season = parseInt(animeSeasonMatch[1], 10);
            if (Number.isInteger(season) && season !== reqSeason) return false;
        }

        const absolutePattern = new RegExp(`(?:^|[\\s.\\-_\\[(])0*${reqEpisode}(?:V\\d+)?(?=$|[\\s.\\-_\\])])`, 'i');
        const explicitPattern = new RegExp(`(?:EP(?:ISODE)?|EPISODIO)\\s*0*${reqEpisode}(?:V\\d+)?`, 'i');
        const rangeMatch = normalized.match(/(?:^|[^\d])0?(\d{1,4})\s*(?:~|-)\s*0?(\d{1,4})(?:[^\d]|$)/);
        if (absolutePattern.test(normalized) || explicitPattern.test(normalized)) return true;
        if (rangeMatch) {
            const start = parseInt(rangeMatch[1], 10);
            const end = parseInt(rangeMatch[2], 10);
            if (Number.isInteger(start) && Number.isInteger(end) && reqEpisode >= Math.min(start, end) && reqEpisode <= Math.max(start, end)) {
                return true;
            }
        }
        if (/\b(?:BATCH|COMPLETE|PACK|COLLECTION)\b/i.test(normalized)) return true;
    }

    const seasonEpisodePatterns = [
        /S(\d{1,2})E(\d{1,3})/i,
        /\b(\d{1,2})x(\d{1,3})\b/i,
        /SEASON[ ._-]?(\d{1,2})[ ._-]?EP(?:ISODE)?[ ._-]?(\d{1,3})/i,
        /STAGIONE[ ._-]?(\d{1,2})[ ._-]?EP(?:ISODIO)?[ ._-]?(\d{1,3})/i
    ];

    for (const pattern of seasonEpisodePatterns) {
        const match = normalized.match(pattern);
        if (!match) continue;
        const season = parseInt(match[1], 10);
        const episode = parseInt(match[2], 10);
        if (reqSeason && Number.isInteger(season) && season !== reqSeason) return false;
        if (reqEpisode && Number.isInteger(episode) && episode !== reqEpisode) return false;
        return true;
    }

    if (reqSeason) {
        const seasonMatch = normalized.match(/(?:\bS(?:EASON)?[ ._-]?|STAGIONE[ ._-]?)(\d{1,2})\b/i);
        if (seasonMatch) {
            const season = parseInt(seasonMatch[1], 10);
            if (Number.isInteger(season) && season !== reqSeason && !ignoreAnimeSeason) return false;
        }
    }

    return true;
}

function buildSearchQueries(context) {
    const base = clean(context.title);
    if (!base) return [];

    const pushUnique = (bucket, value) => {
        const normalized = clean(value);
        if (normalized) bucket.add(normalized);
    };

    const buildBaseSet = () => {
        const bucket = new Set();
        const isSeries = normalizeType(context.type) === 'series';
        const isAnime = context.isAnime;
        const reqSeason = context.reqSeason;
        const reqEpisode = context.reqEpisode;

        if (!(isSeries && isAnime)) {
            pushUnique(bucket, base);
        }

        if (context.year && !isSeries) {
            pushUnique(bucket, `${base} ${context.year}`);
        }

        if (isSeries && isAnime) {
            if (reqEpisode) {
                const e = String(reqEpisode).padStart(2, '0');
                pushUnique(bucket, `${base} - ${e}`);
                pushUnique(bucket, `${base} ${e}`);
                pushUnique(bucket, `${base} episode ${reqEpisode}`);
                pushUnique(bucket, `${base} ep ${reqEpisode}`);
                if (reqSeason && reqSeason > 1) {
                    pushUnique(bucket, `${base} S${reqSeason} - ${e}`);
                    pushUnique(bucket, `${base} season ${reqSeason} episode ${reqEpisode}`);
                }
            }
            pushUnique(bucket, base);
            if (reqSeason && reqSeason > 1) {
                pushUnique(bucket, `${base} season ${reqSeason}`);
                pushUnique(bucket, `${base} S${reqSeason}`);
            }
            pushUnique(bucket, `${base} batch`);
            pushUnique(bucket, `${base} complete`);
            pushUnique(bucket, `${base} pack`);
        } else if (isSeries && reqSeason && reqEpisode) {
            const s = String(reqSeason).padStart(2, '0');
            const e = String(reqEpisode).padStart(2, '0');
            pushUnique(bucket, `${base} S${s}E${e}`);
            pushUnique(bucket, `${base} ${reqSeason}x${reqEpisode}`);
            pushUnique(bucket, `${base} stagione ${reqSeason} episodio ${reqEpisode}`);
            pushUnique(bucket, `${base} season ${reqSeason} episode ${reqEpisode}`);
        } else if (isSeries && reqSeason) {
            const s = String(reqSeason).padStart(2, '0');
            pushUnique(bucket, `${base} S${s}`);
            pushUnique(bucket, `${base} stagione ${reqSeason}`);
            pushUnique(bucket, `${base} season ${reqSeason}`);
        }

        return [...bucket];
    };

    const baseQueries = buildBaseSet();
    const itaQueries = new Set();
    const engQueries = new Set();
    const limitUniqueQueries = (queries, max = CONFIG.MAX_QUERY_VARIANTS_PER_ENGINE) => {
        const output = [];
        const seen = new Set();
        for (const query of queries) {
            const key = clean(query).toLowerCase();
            if (!key || seen.has(key)) continue;
            seen.add(key);
            output.push(query);
            if (output.length >= max) break;
        }
        return output;
    };

    for (const query of baseQueries) {
        if (context.isAnime) {
            pushUnique(itaQueries, query);
            pushUnique(engQueries, query);
            continue;
        }
        pushUnique(itaQueries, `${query} ITA`);
        pushUnique(itaQueries, `${query} MULTI`);
        pushUnique(engQueries, query);
        pushUnique(engQueries, `${query} ENG`);
        pushUnique(engQueries, `${query} ENGLISH`);
    }

    if (context.isAnime) {
        for (const query of baseQueries) {
            pushUnique(itaQueries, `${query} ITA`);
            pushUnique(itaQueries, `${query} MULTI`);
            pushUnique(engQueries, `${query} ENG`);
            pushUnique(engQueries, `${query} ENGLISH`);
        }
    }

    const queryLimit = context.isAnime ? CONFIG.MAX_ANIME_QUERY_VARIANTS_PER_ENGINE : CONFIG.MAX_QUERY_VARIANTS_PER_ENGINE;

    if (context.langMode === 'eng') {
        return limitUniqueQueries([...engQueries], queryLimit);
    }

    if (context.langMode === 'all') {
        const mixed = [];
        const ita = [...itaQueries];
        const eng = [...engQueries];
        const maxLen = Math.max(ita.length, eng.length);
        for (let i = 0; i < maxLen; i += 1) {
            if (ita[i]) mixed.push(ita[i]);
            if (eng[i]) mixed.push(eng[i]);
        }
        return limitUniqueQueries(mixed, queryLimit);
    }

    return limitUniqueQueries([...itaQueries], queryLimit);
}

function buildSearchContext(title, year, type, imdbId, options = {}) {
    const episodeContext = extractEpisodeContext(imdbId);
    const langMode = resolveLangMode(options);
    const isAnime = normalizeType(type) === 'series' && (String(type || '').toLowerCase() === 'anime' || String(imdbId || '').toLowerCase().startsWith('kitsu:') || options.isAnime === true);
    return {
        title,
        cleanTitle: clean(title),
        year,
        type,
        normalizedType: normalizeType(type),
        reqSeason: episodeContext.season,
        reqEpisode: episodeContext.episode,
        imdbId,
        langMode,
        allowEng: langMode === 'eng' || langMode === 'all',
        isAnime,
        options
    };
}

function passesResultFilters(name, context) {
    if (!isValidResult(name, context.langMode, context)) return false;
    if (!checkYear(name, context.year, context.type)) return false;
    if (!isCorrectFormat(name, context.reqSeason, context.reqEpisode, context)) return false;

    const matchScore = titleMatchScore(name, context.title);
    if (context.normalizedType === "movie" && matchScore < 0.34) return false;
    if (context.normalizedType === "series" && matchScore < (context.isAnime ? 0.18 : 0.30)) return false;
    return true;
}

function computeResultScore(result, context) {
    const seeders = Math.max(0, Number(result.seeders) || 0);
    const sizeBytes = Math.max(0, Number(result.sizeBytes) || 0);
    const languageScore = getLanguageScore(result.title, context.langMode, context);
    const resolutionScore = getResolutionScore(result.title) * 8;
    const yearScore = checkYear(result.title, context.year, context.type) ? 8 : -30;
    const formatScore = isCorrectFormat(result.title, context.reqSeason, context.reqEpisode, context) ? 18 : -60;
    const overlapScore = Math.round(titleMatchScore(result.title, context.title) * 40);
    const sourceScore = SOURCE_WEIGHTS[result.source] || 10;
    const animeGroupScore = context.isAnime && ANIME_RELEASE_GROUP_REGEX.test(result.title) ? 18 : 0;
    const animeFeatureScore = context.isAnime && ANIME_RELEASE_FEATURE_REGEX.test(result.title) ? 6 : 0;
    const trackerText = `${result.tracker || ''} ${result.trackerId || ''} ${result.details || ''}`;
    const trustedTrackerScore = context.isAnime && TRUSTED_ANIME_TRACKER_REGEX.test(trackerText) ? 8 : 0;
    const categoryScore = context.isAnime && !isBlacklistedCategory(result.categoryId) && KNABEN_CATEGORY_ANIME.includes(Number(result.categoryId)) ? 7 : 0;
    const lastSeenMs = Number(result.lastSeen) || 0;
    const ageDays = lastSeenMs > 0 ? (now() - lastSeenMs) / (24 * 60 * 60 * 1000) : null;
    const freshnessScore = ageDays === null ? 0 : (ageDays <= 14 ? 8 : (ageDays <= 90 ? 4 : 0));
    const virusPenalty = Number(result.virusDetection) > 0 ? -25 : 0;
    const sizeScore = sizeBytes > 0 ? Math.min(20, Math.round(Math.log10(sizeBytes + 1))) : 0;
    const seederScore = Math.min(35, Math.round(Math.log2(seeders + 1) * 4));
    return languageScore + resolutionScore + yearScore + formatScore + overlapScore + sourceScore + animeGroupScore + animeFeatureScore + trustedTrackerScore + categoryScore + freshnessScore + virusPenalty + sizeScore + seederScore;
}

function normalizeResult(raw, context, source) {
    if (!raw) return null;
    const title = normalizeSpaces(raw.title || raw.name || "");
    const magnet = appendTrackers(raw.magnet || raw.magnetLink || "");
    const hash = extractInfoHash(magnet);
    if (!title || !magnet || !hash) return null;
    if (!passesResultFilters(title, context)) return null;

    let sizeBytes = Number(raw.sizeBytes) || 0;
    if (!sizeBytes && magnet) sizeBytes = parseMagnetSizeBytes(magnet);
    if (!sizeBytes && raw.size) sizeBytes = parseSize(raw.size);
    let size = raw.size || "";
    if (!size && sizeBytes > 0) size = bytesToSize(sizeBytes);

    const normalized = {
        title,
        magnet,
        size,
        sizeBytes,
        seeders: Math.max(0, parseInt(raw.seeders, 10) || 0),
        source: source || raw.source || "Unknown",
        tracker: raw.tracker || "",
        trackerId: raw.trackerId || "",
        categoryId: raw.categoryId ?? null,
        lastSeen: raw.lastSeen || 0,
        virusDetection: Number(raw.virusDetection) || 0,
        details: raw.details || ""
    };
    normalized._score = computeResultScore(normalized, context);
    return normalized;
}

function dedupeResults(results) {
    const bestByKey = new Map();

    for (const result of results) {
        if (!result) continue;
        const hash = extractInfoHash(result.magnet);
        const fallbackKey = `${clean(result.title).toLowerCase()}|${result.sizeBytes || 0}`;
        const key = hash || fallbackKey;
        const existing = bestByKey.get(key);
        if (!existing) {
            bestByKey.set(key, result);
            continue;
        }

        const currentScore = Number(result._score) || 0;
        const existingScore = Number(existing._score) || 0;
        const currentSeeders = Number(result.seeders) || 0;
        const existingSeeders = Number(existing.seeders) || 0;

        if (
            currentScore > existingScore ||
            (currentScore === existingScore && currentSeeders > existingSeeders) ||
            (currentScore === existingScore && currentSeeders === existingSeeders && (result.sizeBytes || 0) > (existing.sizeBytes || 0))
        ) {
            bestByKey.set(key, result);
        }
    }

    return [...bestByKey.values()];
}

async function fetchJsonApi(url, payload, timeout = CONFIG.TIMEOUT_API, langMode = 'ita') {
    const { data } = await requestHtml(url, {
        method: "POST",
        data: payload,
        headers: {
            "Content-Type": "application/json",
            Accept: "application/json"
        },
        timeout,
        langMode
    });
    if (!data) return null;
    return data;
}

async function collectQueryResults(context, handler, { maxQueries = CONFIG.MAX_QUERY_VARIANTS_PER_ENGINE } = {}) {
    const queries = buildSearchQueries(context).slice(0, maxQueries);
    const all = [];
    const seen = new Set();

    for (const query of queries) {
        const results = await handler(query);
        for (const item of results || []) {
            const key = item.detailUrl || item.url || item.magnet || item.title;
            if (!key || seen.has(key)) continue;
            seen.add(key);
            all.push(item);
        }
        if (all.length >= CONFIG.RESULT_LIMIT_PER_ENGINE) break;
    }

    return all;
}

async function collectQueryResultsParallel(context, handler, {
    maxQueries = CONFIG.MAX_QUERY_VARIANTS_PER_ENGINE,
    concurrency = CONFIG.QUERY_CONCURRENCY
} = {}) {
    const queries = buildSearchQueries(context).slice(0, maxQueries);
    const limit = pLimit(Math.max(1, Number(concurrency) || 1));
    const seen = new Set();
    const all = [];

    const batches = await Promise.all(queries.map(query => limit(async () => {
        try {
            return await handler(query);
        } catch (error) {
            console.log(`[ENGINES] query failed for "${query}": ${error.message}`);
            return [];
        }
    })));

    for (const results of batches) {
        for (const item of results || []) {
            const key = item.detailUrl || item.url || item.magnet || item.title;
            if (!key || seen.has(key)) continue;
            seen.add(key);
            all.push(item);
            if (all.length >= CONFIG.RESULT_LIMIT_PER_ENGINE) return all;
        }
    }

    return all;
}


function buildEngineCacheKey(engineName, context = {}) {
    return `${engineName}:${buildSearchCacheKey(context)}`;
}

function startProviderRefresh(cache, inflight, key, label, producer) {
    if (inflight.has(key)) return inflight.get(key);
    const promise = (async () => {
        try {
            const fresh = await producer();
            cache.set(key, Array.isArray(fresh) ? fresh : []);
            console.log(`[${label}] cache refresh ok results=${Array.isArray(fresh) ? fresh.length : 0}`);
            return fresh;
        } catch (error) {
            console.log(`[${label}] cache refresh failed: ${error.message}`);
            return [];
        } finally {
            inflight.delete(key);
        }
    })();
    inflight.set(key, promise);
    return promise;
}

async function resolveProviderCache(cache, inflight, key, label, producer) {
    const cached = cache.getEntry(key, { allowStale: true });
    if (cached && !cached.isStale) {
        console.log(`[${label}] cache hit fresh results=${cached.value.length}`);
        return cached.value;
    }

    if (cached && cached.isStale) {
        console.log(`[${label}] cache hit stale results=${cached.value.length} -> refresh async`);
        startProviderRefresh(cache, inflight, key, label, producer);
        return cached.value;
    }

    return await startProviderRefresh(cache, inflight, key, label, producer);
}

function getHostFallbackList(envName, defaults = []) {
    const explicit = String(process.env[envName] || '').trim();
    const source = explicit ? explicit.split(/[\s,;]+/g) : defaults;
    return [...new Set(source.map(host => String(host || '').trim().replace(/^https?:\/\//i, '').replace(/\/+$/, '')).filter(Boolean))];
}

function isProviderOnCooldown(provider) {
    const until = engineProviderCooldowns.get(provider);
    return Boolean(until && Date.now() < until);
}

function setProviderCooldown(provider, ms) {
    const duration = Math.max(0, Number(ms) || 0);
    if (!duration) return;
    engineProviderCooldowns.set(provider, Date.now() + duration);
    console.log(`[${provider}] cooldown attivo per ${Math.round(duration / 1000)}s.`);
}

function runProviderSerial(provider, minIntervalMs, fn) {
    const previous = engineProviderQueues.get(provider) || Promise.resolve();
    const next = previous.then(async () => {
        const key = `${provider}:lastCall`;
        const last = engineProviderCooldowns.get(key) || 0;
        const waitMs = Math.max(0, Number(minIntervalMs || 0) - (Date.now() - last));
        if (waitMs > 0) await sleep(waitMs);
        engineProviderCooldowns.set(key, Date.now());
        return fn();
    });
    engineProviderQueues.set(provider, next.catch(() => null));
    return next;
}

function firstTitleToken(value) {
    return tokenizeTitle(value)[0] || '';
}

function looksLikeSameMovieTitle(candidate, expected) {
    if (!candidate || !expected) return true;
    const overlap = titleMatchScore(candidate, expected);
    if (overlap >= 0.34) return true;
    const expectedFirst = firstTitleToken(expected);
    return Boolean(expectedFirst && tokenizeTitle(candidate).includes(expectedFirst));
}

function decodeHref(value) {
    return he.decode(String(value || '').replace(/&amp;/g, '&')).trim();
}

function buildAbsoluteUrl(baseUrl, href) {
    const decoded = decodeHref(href);
    if (!decoded) return '';
    if (/^magnet:/i.test(decoded)) return decoded;
    try {
        return new URL(decoded, baseUrl).toString();
    } catch {
        return decoded.startsWith('http') ? decoded : `${String(baseUrl || '').replace(/\/$/, '')}/${decoded.replace(/^\//, '')}`;
    }
}

function numberFromHumanInt(value) {
    const parsed = parseInt(String(value || '').replace(/[.,\s]/g, ''), 10);
    return Number.isFinite(parsed) ? parsed : 0;
}

function extractFirstMagnet(value) {
    const text = he.decode(String(value || '').replace(/&amp;/g, '&'));
    const match = text.match(/magnet:\?xt=urn:btih:[A-Za-z0-9]{32,40}[^"'<>\s]*/i);
    return match ? match[0].replace(/\s+/g, '') : '';
}

function extractInfoHashFromText(value) {
    const text = he.decode(String(value || ''));
    const labelled = text.match(/(?:Info\s*Hash|Hash|btih)[^A-Fa-f0-9A-Z2-7]{0,16}([A-Fa-f0-9]{40}|[A-Z2-7]{32})\b/i);
    if (labelled) return labelled[1].toLowerCase();
    const generic = text.match(/\b[A-Fa-f0-9]{40}\b/);
    return generic ? generic[0].toLowerCase() : '';
}

function parsePeerHealthFromText(value) {
    const text = normalizeSpaces(value);
    const health = text.match(/(?:Good|Medium|Poor|Health)?\s*([\d.,]+)\s*\/\s*([\d.,]+)\b/i);
    if (health) {
        return {
            seeders: numberFromHumanInt(health[1]),
            leechers: numberFromHumanInt(health[2])
        };
    }

    const seed = text.match(/(?:Seed(?:er)?s?|S)\s*[:()]?\s*([\d.,]+)/i);
    const leech = text.match(/(?:Leech(?:er)?s?|L)\s*[:()]?\s*([\d.,]+)/i);
    return {
        seeders: seed ? numberFromHumanInt(seed[1]) : 0,
        leechers: leech ? numberFromHumanInt(leech[1]) : 0
    };
}

function parsePeerColumns($, row) {
    if (!$ || !row) return { seeders: 0, leechers: 0 };
    const $row = typeof row.find === 'function' ? row : $(row);
    const cells = $row.find('td').map((_, cell) => normalizeSpaces($(cell).text())).get();
    if (!cells.length) return { seeders: 0, leechers: 0 };

    const sizeIndex = cells.findIndex(cell => /\b(?:TiB|GiB|MiB|KiB|TB|GB|MB|KB)\b/i.test(cell));
    const numericAfterSize = sizeIndex >= 0
        ? cells.slice(sizeIndex + 1).map(numberFromHumanInt).filter(value => value > 0)
        : [];
    if (numericAfterSize.length) {
        return {
            seeders: numericAfterSize[0] || 0,
            leechers: numericAfterSize[1] || 0
        };
    }

    const numericCells = cells.map(numberFromHumanInt).filter(value => value > 0);
    if (numericCells.length >= 2) {
        return {
            seeders: numericCells[numericCells.length - 2] || 0,
            leechers: numericCells[numericCells.length - 1] || 0
        };
    }

    return { seeders: numericCells[0] || 0, leechers: 0 };
}

function parseSizeLabelFromText(value) {
    const text = normalizeSpaces(value);
    const match = text.match(/\b(\d+(?:[.,]\d+)?)\s*(TiB|GiB|MiB|KiB|TB|GB|MB|KB)\b/i);
    if (!match) return '';
    return `${match[1].replace(',', '.')} ${match[2].replace(/([GMTK])iB/i, '$1B').toUpperCase()}`;
}

function normalizeUindexTitle(value) {
    return normalizeSpaces(he.decode(String(value || '')))
        .replace(/^\s*(?:www\.)?uindex\.org\s*[-–—:]\s*/i, '')
        .replace(/\s+NEW\s*$/i, '')
        .trim();
}

function rankDetailCandidates(candidates, context, maxCandidates) {
    return [...(candidates || [])]
        .filter(candidate => candidate && candidate.title && (candidate.detailUrl || candidate.magnet))
        .sort((a, b) => {
            const score = candidate => {
                const titleScore = Math.round(titleMatchScore(candidate.title, context.title) * 100);
                const seederScore = Math.min(50, Math.round(Math.log2((Number(candidate.seeders) || 0) + 1) * 8));
                const resolutionScore = getResolutionScore(candidate.title) * 12;
                const sizeScore = parseSize(candidate.size) > 0 ? 3 : 0;
                const directMagnetScore = candidate.magnet ? 20 : 0;
                return titleScore + seederScore + resolutionScore + sizeScore + directMagnetScore;
            };
            return score(b) - score(a);
        })
        .slice(0, Math.max(1, Number(maxCandidates) || 20));
}

function parseCorsaroSearchRows(html, context, baseUrl = 'https://ilcorsaronero.link') {
    if (!html) return [];
    const $ = cheerio.load(html);
    const items = [];
    const seen = new Set();

    $('table tr, tbody tr, .table tr').each((_, row) => {
        const $row = $(row);
        const rowHtml = $row.html() || '';
        const directMagnet = extractFirstMagnet(rowHtml);
        const linkTag = $row.find('a[href*="/torrent/"], a[href*="torrent"], a[href^="magnet:"]').filter((__, link) => {
            const href = $(link).attr('href') || '';
            const text = normalizeSpaces($(link).text());
            return /^magnet:/i.test(href) || /torrent/i.test(href) || text.length > 6;
        }).first();
        if (!linkTag.length && !directMagnet) return;

        const rawHref = linkTag.attr('href') || directMagnet;
        const href = buildAbsoluteUrl(baseUrl, rawHref);
        const name = normalizeSpaces(linkTag.text() || $row.find('td').first().text());
        if (!name || !passesResultFilters(name, context)) return;

        const rowText = normalizeSpaces($row.text());
        const health = parsePeerHealthFromText(rowText);
        const seedersText = $row.find('.green, font[color="#008000"], td.text-green-500, .seeders, .seeds').text().trim();
        const cellHealth = parsePeerColumns($, $row);
        const seeders = seedersText ? numberFromHumanInt(seedersText) : (cellHealth.seeders || health.seeders);
        const size = parseSizeLabelFromText(rowText);
        const key = directMagnet || href || name;
        if (seen.has(key)) return;
        seen.add(key);

        items.push({
            title: name,
            detailUrl: /^magnet:/i.test(href) ? '' : href,
            magnet: directMagnet || (/^magnet:/i.test(href) ? href : ''),
            size,
            seeders
        });
    });

    return items;
}

function parseUindexListRows(html, context, baseUrl = 'https://uindex.org') {
    if (!html) return [];
    const $ = cheerio.load(html);
    const items = [];
    const seen = new Set();

    $('table tr, tbody tr, .table tr').each((_, row) => {
        const $row = $(row);
        const rowHtml = $row.html() || '';
        const directMagnet = extractFirstMagnet(rowHtml);
        const linkTag = $row.find('a[href*="details.php"], a[href*="/details"], a[href^="magnet:"]').filter((__, link) => {
            const href = $(link).attr('href') || '';
            const text = normalizeUindexTitle($(link).text());
            return /^magnet:/i.test(href) || /details/i.test(href) || text.length > 6;
        }).first();
        if (!linkTag.length && !directMagnet) return;

        const rawHref = linkTag.attr('href') || directMagnet;
        const href = buildAbsoluteUrl(baseUrl, rawHref);
        const name = normalizeUindexTitle(linkTag.text() || $row.find('td').first().text());
        if (!name || !passesResultFilters(name, context)) return;

        const rowText = normalizeSpaces($row.text());
        const health = parsePeerHealthFromText(rowText);
        const size = parseSizeLabelFromText(rowText);
        const key = directMagnet || href || name;
        if (seen.has(key)) return;
        seen.add(key);

        items.push({
            title: name,
            detailUrl: /^magnet:/i.test(href) ? '' : href,
            magnet: directMagnet || (/^magnet:/i.test(href) ? href : ''),
            size,
            seeders: parsePeerColumns($, $row).seeders || health.seeders,
            leechers: parsePeerColumns($, $row).leechers || health.leechers
        });
    });

    return items;
}

function parseUindexDetailPayload(html, candidate = {}) {
    if (!html) return { ...candidate };
    const $ = cheerio.load(html);
    const text = normalizeSpaces($.text());
    const magnet = extractFirstMagnet(html);
    const hash = extractInfoHashFromText(text);
    const health = parsePeerHealthFromText(text);
    const size = parseSizeLabelFromText(text) || candidate.size || '';
    const title = normalizeUindexTitle($('h1').first().text()) || candidate.title;

    return {
        ...candidate,
        title,
        magnet: magnet || (hash ? buildMagnetFromHash(hash, title || candidate.title || '') : candidate.magnet),
        size,
        seeders: health.seeders || candidate.seeders || 0,
        leechers: health.leechers || candidate.leechers || 0,
        details: hash ? `uindex:${hash}` : candidate.details || ''
    };
}

function normalizeProviderBase(host) {
    const value = String(host || '').trim().replace(/\/+$/, '');
    if (!value) return '';
    return /^https?:\/\//i.test(value) ? value : `https://${value}`;
}

async function requestProviderHtml(provider, hosts, pathBuilder, context, options = {}) {
    const candidates = [...new Set((hosts || []).map(normalizeProviderBase).filter(Boolean))];
    let lastError = null;

    for (const baseUrl of candidates) {
        const cooldownKey = `${provider}:${baseUrl}`;
        if (isProviderOnCooldown(cooldownKey)) continue;

        try {
            const url = pathBuilder(baseUrl);
            const response = await requestHtml(url, {
                timeout: options.timeout || CONFIG.TIMEOUT,
                langMode: context.langMode,
                maxRedirects: options.maxRedirects ?? 3,
                headers: options.headers || {},
                skipCache: options.skipCache === true
            });
            const status = Number(response.status) || 0;
            const data = response.data || '';
            if (status === 429) {
                lastError = new Error(`${baseUrl}: http_${status}`);
                setProviderCooldown(cooldownKey, options.rateLimitCooldownMs || 90_000);
                continue;
            }
            if (status === 403 || status >= 500 || !data || isCloudflareResponse(data)) {
                lastError = new Error(`${baseUrl}: http_${status || 599}`);
                setProviderCooldown(cooldownKey, options.cooldownMs || 60_000);
                continue;
            }
            return { data, baseUrl, status };
        } catch (error) {
            lastError = error;
            setProviderCooldown(cooldownKey, options.cooldownMs || 60_000);
        }
    }

    if (lastError) console.log(`[${provider}] host fallback fallito: ${lastError.message}`);
    return { data: '', baseUrl: '', status: 599 };
}

function pickBestTitleLink($, row, selectors = '') {
    const $row = typeof row.find === 'function' ? row : $(row);
    const preferred = selectors ? $row.find(selectors).filter((_, link) => normalizeSpaces($(link).text()).length > 3).first() : null;
    if (preferred && preferred.length) return preferred;
    return $row.find('a').filter((_, link) => {
        const href = String($(link).attr('href') || '');
        const text = normalizeSpaces($(link).text());
        if (!text || text.length < 4) return false;
        if (/^magnet:/i.test(href)) return false;
        if (/^(download|magnet|torrent)$/i.test(text)) return false;
        return true;
    }).first();
}

function normalizeCandidateFromRow($, row, context, baseUrl, selectors = {}) {
    const $row = typeof row.find === 'function' ? row : $(row);
    const rowHtml = $row.html() || '';
    const rowText = normalizeSpaces($row.text());
    const directMagnet = extractFirstMagnet(rowHtml) || ($row.find('a[href^="magnet:"]').first().attr('href') || '');
    const titleLink = pickBestTitleLink($, $row, selectors.title || '');
    const href = titleLink.length ? buildAbsoluteUrl(baseUrl, titleLink.attr('href') || '') : '';
    const title = normalizeSpaces(titleLink.text() || $row.find(selectors.titleFallback || 'td').first().text());
    if (!title || !passesResultFilters(title, context)) return null;

    const cells = $row.find('td').map((_, cell) => normalizeSpaces($(cell).text())).get();
    const health = parsePeerHealthFromText(rowText);
    const columnHealth = parsePeerColumns($, $row);
    const hash = extractInfoHash(directMagnet) || extractInfoHashFromText(`${href} ${rowHtml} ${rowText}`);
    const sizeCell = selectors.sizeIndex !== undefined && cells[selectors.sizeIndex] ? cells[selectors.sizeIndex] : '';
    const size = parseSizeLabelFromText(sizeCell) || parseSizeLabelFromText(rowText);
    const seedersCell = selectors.seedersIndex !== undefined && cells[selectors.seedersIndex] ? numberFromHumanInt(cells[selectors.seedersIndex]) : 0;
    const leechersCell = selectors.leechersIndex !== undefined && cells[selectors.leechersIndex] ? numberFromHumanInt(cells[selectors.leechersIndex]) : 0;

    return {
        title,
        detailUrl: /^https?:\/\//i.test(href) ? href : '',
        magnet: directMagnet || (hash ? buildMagnetFromHash(hash, title) : ''),
        size,
        seeders: seedersCell || columnHealth.seeders || health.seeders || 0,
        leechers: leechersCell || columnHealth.leechers || health.leechers || 0,
        details: hash ? `${selectors.detailsPrefix || 'hash'}:${hash}` : ''
    };
}

function parseKickassRows(html, context, baseUrl) {
    if (!html) return [];
    const $ = cheerio.load(html);
    const items = [];
    const seen = new Set();

    $('tr.odd, tr.even, table tbody tr, table tr').each((_, row) => {
        const candidate = normalizeCandidateFromRow($, row, context, baseUrl, {
            title: 'a.cellMainLink, a[href*="/torrent/"], a[href*="/kat/"]',
            sizeIndex: 1,
            detailsPrefix: 'kat'
        });
        if (!candidate || !candidate.magnet) return;
        const key = extractInfoHash(candidate.magnet) || candidate.detailUrl || candidate.title;
        if (!key || seen.has(key)) return;
        seen.add(key);
        items.push(candidate);
    });

    return items;
}

function parseTorLockRows(html, context, baseUrl) {
    if (!html) return [];
    const $ = cheerio.load(html);
    const items = [];
    const seen = new Set();

    $('table tbody tr, table tr, div.table-striped article').each((_, row) => {
        const candidate = normalizeCandidateFromRow($, row, context, baseUrl, {
            title: 'td:first-child a, a[href*="/torrent/"]',
            sizeIndex: 2,
            seedersIndex: 3,
            leechersIndex: 4,
            detailsPrefix: 'torlock'
        });
        if (!candidate || (!candidate.magnet && !candidate.detailUrl)) return;
        const key = extractInfoHash(candidate.magnet) || candidate.detailUrl || candidate.title;
        if (!key || seen.has(key)) return;
        seen.add(key);
        items.push(candidate);
    });

    return items;
}

function parseTorrentDownloadsRows(html, context, baseUrl) {
    if (!html) return [];
    const $ = cheerio.load(html);
    const items = [];
    const seen = new Set();

    $('table.table2 tr, table tbody tr, table tr, div.grey_bar3').each((index, row) => {
        const candidate = normalizeCandidateFromRow($, row, context, baseUrl, {
            title: 'td:first-child a, a[href*="/torrent/"]',
            sizeIndex: 1,
            seedersIndex: 2,
            leechersIndex: 3,
            detailsPrefix: 'torrentdownloads'
        });
        if (!candidate || !candidate.magnet) return;
        const key = extractInfoHash(candidate.magnet) || candidate.detailUrl || `${candidate.title}:${index}`;
        if (!key || seen.has(key)) return;
        seen.add(key);
        items.push(candidate);
    });

    return items;
}

function parseTheRarBGSearchRows(html, context, baseUrl) {
    if (!html) return [];
    const $ = cheerio.load(html);
    const items = [];
    const seen = new Set();

    $('table tbody tr, table tr').each((_, row) => {
        const candidate = normalizeCandidateFromRow($, row, context, baseUrl, {
            title: 'td:nth-child(2) a, a[href*="/post-detail/"], a[href*="/torrent/"]',
            sizeIndex: 5,
            seedersIndex: 6,
            leechersIndex: 7,
            detailsPrefix: 'therarbg'
        });
        if (!candidate || (!candidate.detailUrl && !candidate.magnet)) return;
        const key = extractInfoHash(candidate.magnet) || candidate.detailUrl || candidate.title;
        if (!key || seen.has(key)) return;
        seen.add(key);
        items.push(candidate);
    });

    return items;
}

async function enrichCandidateFromDetail(candidate, context, source, timeout) {
    if (!candidate?.detailUrl) return candidate;
    try {
        const { data } = await requestHtml(candidate.detailUrl, {
            timeout,
            langMode: context.langMode,
            maxRedirects: 3
        });
        if (!data) return candidate;
        const $ = cheerio.load(data);
        const pageText = normalizeSpaces($.text());
        const magnet = extractFirstMagnet(data) || $('a[href^="magnet:"]').first().attr('href') || candidate.magnet || '';
        const hash = extractInfoHash(magnet) || extractInfoHashFromText(pageText) || extractInfoHashFromText(data);
        const health = parsePeerHealthFromText(pageText);
        const title = normalizeSpaces($('h1').first().text() || $('title').first().text().replace(/\s*[-|].*$/g, '') || candidate.title);
        const size = parseSizeLabelFromText(pageText) || candidate.size || '';
        return {
            ...candidate,
            title: title || candidate.title,
            magnet: magnet || (hash ? buildMagnetFromHash(hash, title || candidate.title || '') : candidate.magnet),
            size,
            seeders: health.seeders || candidate.seeders || 0,
            leechers: health.leechers || candidate.leechers || 0,
            details: hash ? `${String(source || 'detail').toLowerCase()}:${hash}` : candidate.details || ''
        };
    } catch {
        return candidate;
    }
}

async function searchCorsaro(context) {
    console.log(`[IlCorsaroNero] Avvio ricerca turbo per: ${context.title}...`);
    const cacheKey = buildEngineCacheKey('corsaro', context);

    const producer = async () => {
        const candidates = await collectQueryResultsParallel(context, async query => {
            const url = `https://ilcorsaronero.link/search?q=${encodeURIComponent(query)}`;
            const { data } = await requestHtml(url, {
                timeout: CONFIG.CORSARO_SEARCH_TIMEOUT_MS,
                langMode: context.langMode
            });
            if (!data || isCloudflareResponse(data)) return [];
            return parseCorsaroSearchRows(data, context, 'https://ilcorsaronero.link');
        }, {
            maxQueries: Math.min(CONFIG.MAX_QUERY_VARIANTS_PER_ENGINE, context.isAnime ? 4 : 3),
            concurrency: CONFIG.CORSARO_QUERY_CONCURRENCY
        });

        const ranked = rankDetailCandidates(candidates, context, CONFIG.CORSARO_MAX_DETAIL_CANDIDATES);
        const directResults = ranked
            .filter(candidate => candidate.magnet)
            .map(candidate => normalizeResult(candidate, context, 'Corsaro'))
            .filter(Boolean);

        const detailResults = await Promise.all(
            ranked.filter(candidate => !candidate.magnet && candidate.detailUrl).map(candidate =>
                detailLimit(async () => {
                    try {
                        const html = (await requestHtml(candidate.detailUrl, {
                            timeout: CONFIG.CORSARO_DETAIL_TIMEOUT_MS,
                            langMode: context.langMode,
                            maxRedirects: 3
                        })).data;
                        if (!html) return null;
                        const magnet = extractFirstMagnet(html) || cheerio.load(html)('a[href^="magnet:"]').attr('href') || '';
                        return normalizeResult({ ...candidate, magnet }, context, 'Corsaro');
                    } catch {
                        return null;
                    }
                })
            )
        );

        const finalResults = dedupeResults([...directResults, ...detailResults.filter(Boolean)])
            .slice(0, CONFIG.RESULT_LIMIT_PER_ENGINE);
        console.log(`[IlCorsaroNero] Trovati ${finalResults.length} risultati validi.`);
        return finalResults;
    };

    try {
        return await resolveProviderCache(corsaroCache, corsaroRefreshInflight, cacheKey, 'IlCorsaroNero', producer);
    } catch (error) {
        console.log(`[IlCorsaroNero] Errore: ${error.message}`);
        return [];
    }
}

function getKnabenCategories(context = {}) {
    if (isAnimeContext(context)) return [...KNABEN_CATEGORY_ANIME];
    const normalizedType = normalizeType(context.type);
    if (normalizedType === "movie") return [...KNABEN_CATEGORY_MOVIE];
    if (normalizedType === "series") return [...KNABEN_CATEGORY_SERIES];
    return [];
}

function parseKnabenCategoryId(hit = {}) {
    const raw = hit.categoryId ?? hit.category_id ?? hit.category ?? hit.cat ?? hit.catId;
    if (Array.isArray(raw)) {
        const parsed = raw.map(value => parseInt(String(value), 10)).find(value => Number.isInteger(value));
        return Number.isInteger(parsed) ? parsed : null;
    }
    const parsed = parseInt(String(raw ?? ''), 10);
    return Number.isInteger(parsed) ? parsed : null;
}

function isBlacklistedCategory(categoryId) {
    if (categoryId === undefined || categoryId === null) return false;
    if (Array.isArray(categoryId)) return categoryId.some(isBlacklistedCategory);
    const numeric = parseInt(String(categoryId), 10);
    return ENGINE_BLACKLISTED_CATEGORIES.has(numeric) || KNABEN_CATEGORY_BLACKLIST.has(numeric);
}

function parseKnabenLastSeen(hit = {}) {
    const raw = hit.lastSeen || hit.last_seen || hit.updatedAt || hit.updated_at || hit.createdAt || hit.created_at;
    if (!raw) return 0;
    const parsed = typeof raw === 'number' ? raw : Date.parse(raw);
    if (!Number.isFinite(parsed)) return 0;
    return parsed > 0 && parsed < 10_000_000_000 ? parsed * 1000 : parsed;
}

function getKnabenCacheKey(context, query, categories) {
    return JSON.stringify({
        q: clean(query).toLowerCase(),
        categories: [...categories].sort((a, b) => a - b),
        type: context.normalizedType,
        anime: context.isAnime === true,
        lang: context.langMode
    });
}

async function fetchKnabenQuery(context, query, categories) {
    const cacheKey = getKnabenCacheKey(context, query, categories);
    const cachedEntry = knabenCache.getEntry(cacheKey, { allowStale: true });
    if (cachedEntry?.value) {
        if (cachedEntry.isStale && !knabenRefreshInflight.has(cacheKey)) {
            const refresh = fetchKnabenQueryLive(context, query, categories)
                .then(results => knabenCache.set(cacheKey, results, CONFIG.KNABEN_FRESH_TTL_MS, CONFIG.KNABEN_STALE_TTL_MS))
                .catch(error => console.log(`[Knaben] refresh stale fallito per "${query}": ${error.message}`))
                .finally(() => knabenRefreshInflight.delete(cacheKey));
            knabenRefreshInflight.set(cacheKey, refresh);
        }
        console.log(`[Knaben] cache ${cachedEntry.isStale ? 'stale' : 'fresh'} hit per "${query}" -> ${cachedEntry.value.length} risultati.`);
        return cachedEntry.value;
    }

    const liveResults = await fetchKnabenQueryLive(context, query, categories);
    knabenCache.set(cacheKey, liveResults, CONFIG.KNABEN_FRESH_TTL_MS, CONFIG.KNABEN_STALE_TTL_MS);
    return liveResults;
}

async function fetchKnabenQueryLive(context, query, categories) {
    const payload = {
        query,
        search_type: "100%",
        search_field: "title",
        size: 250,
        from: 0,
        hide_unsafe: false,
        hide_xxx: true
    };
    if (categories.length) payload.categories = categories;

    const data = await fetchJsonApi(CONFIG.KNABEN_API, payload, CONFIG.TIMEOUT_API, context.langMode);
    if (!data?.hits || !Array.isArray(data.hits)) return [];

    return data.hits.map(hit => {
        const categoryId = parseKnabenCategoryId(hit);
        if (!hit?.title || isBlacklistedCategory(categoryId)) return null;
        const magnet = hit.magnetUrl || hit.magnet || buildMagnetFromHash(hit.hash || hit.infoHash || hit.info_hash, hit.title);
        if (!magnet) return null;
        return normalizeResult({
            title: hit.title,
            magnet,
            sizeBytes: Number(hit.bytes ?? hit.size ?? hit.filesize) || 0,
            size: hit.bytes ? bytesToSize(hit.bytes) : "",
            seeders: parseInt(hit.seeders ?? hit.seeds, 10) || 0,
            tracker: hit.tracker || hit.trackerName || hit.source || '',
            trackerId: hit.trackerId || hit.tracker_id || '',
            categoryId,
            lastSeen: parseKnabenLastSeen(hit),
            virusDetection: Number(hit.virusDetection ?? hit.virus_detection ?? hit.malware ?? 0) || 0,
            details: hit.details || hit.detailsUrl || hit.url || ''
        }, context, "Knaben");
    }).filter(Boolean);
}

async function searchKnaben(context) {
    console.log(`[Knaben] Avvio ricerca per: ${context.title}...`);
    try {
        const categories = getKnabenCategories(context);
        const maxQueries = context.isAnime ? Math.min(CONFIG.MAX_ANIME_QUERY_VARIANTS_PER_ENGINE, 6) : 3;
        const results = await collectQueryResultsParallel(context, async query => {
            return fetchKnabenQuery(context, query, categories);
        }, { maxQueries, concurrency: CONFIG.KNABEN_QUERY_CONCURRENCY });

        const finalResults = dedupeResults(results).slice(0, CONFIG.RESULT_LIMIT_PER_ENGINE);
        console.log(`[Knaben] Trovati ${finalResults.length} risultati validi.`);
        return finalResults;
    } catch (error) {
        console.log(`[Knaben] Errore durante la ricerca: ${error.message}`);
        return [];
    }
}

async function fetchJsonFromHosts(hosts, pathBuilder, options = {}) {
    let lastError = null;
    for (const host of hosts) {
        const url = pathBuilder(host);
        try {
            const { data, status } = await axios.get(url, {
                timeout: options.timeout || CONFIG.TIMEOUT_API,
                httpsAgent,
                maxRedirects: options.maxRedirects ?? 3,
                headers: {
                    Accept: 'application/json, text/plain, */*',
                    'Accept-Language': getAcceptLanguage(options.langMode || 'all'),
                    ...(options.headers || {})
                },
                validateStatus: code => code >= 200 && code < 500
            });
            if (status === 429) {
                setProviderCooldown(options.provider || host, options.cooldownMs || 60_000);
                return null;
            }
            if (status === 403 || status >= 400) {
                lastError = new Error(`${host}: http_${status}`);
                continue;
            }
            return data;
        } catch (error) {
            lastError = error;
        }
    }
    if (lastError && options.provider) console.log(`[${options.provider}] host fallback fallito: ${lastError.message}`);
    return null;
}

async function searchYTS(context) {
    if (context.normalizedType !== 'movie') return [];
    if (context.langMode === 'ita') return [];
    if (isProviderOnCooldown('YTS')) return [];
    console.log(`[YTS] Avvio ricerca per: ${context.title}...`);
    const cacheKey = buildEngineCacheKey('yts', context);

    const producer = async () => {
        const hosts = getHostFallbackList('YTS_HOST', ['yts.am', 'yts.mx']);
        const query = clean(context.title);
        if (!query) return [];
        const data = await fetchJsonFromHosts(
            hosts,
            host => `https://${host}/api/v2/list_movies.json?query_term=${encodeURIComponent(query)}&limit=30`,
            { provider: 'YTS', timeout: CONFIG.YTS_TIMEOUT_MS, langMode: context.langMode, cooldownMs: 60_000 }
        );
        const movies = data?.data?.movies;
        if (!Array.isArray(movies)) return [];

        const rows = [];
        for (const movie of movies) {
            if (context.year && movie.year && Math.abs(Number(movie.year) - Number(context.year)) > 1) continue;
            const movieTitle = movie.title_long || movie.title || '';
            if (!looksLikeSameMovieTitle(movieTitle, context.title)) continue;
            for (const torrent of movie.torrents || []) {
                if (!torrent?.hash) continue;
                const title = normalizeSpaces(`${movieTitle} ${torrent.quality || ''} ${torrent.type || ''} ${torrent.video_codec || ''}`);
                rows.push(normalizeResult({
                    title,
                    magnet: buildMagnetFromHash(torrent.hash, title),
                    sizeBytes: Number(torrent.size_bytes) || parseSize(torrent.size || ''),
                    size: torrent.size || '',
                    seeders: Number(torrent.seeds) || 0,
                    tracker: 'yts'
                }, context, 'YTS'));
            }
        }

        return dedupeResults(rows.filter(Boolean)).slice(0, CONFIG.RESULT_LIMIT_PER_ENGINE);
    };

    try {
        return await resolveProviderCache(ytsCache, ytsRefreshInflight, cacheKey, 'YTS', producer);
    } catch (error) {
        console.log(`[YTS] Errore: ${error.message}`);
        return [];
    }
}

async function searchEZTV(context) {
    if (context.normalizedType !== 'series' || context.isAnime) return [];
    if (context.langMode === 'ita') return [];
    if (isProviderOnCooldown('EZTV')) return [];
    console.log(`[EZTV] Avvio ricerca per: ${context.title}...`);
    const cacheKey = buildEngineCacheKey('eztv', context);

    const producer = async () => {
        const imdb = String(context.imdbId || '').match(/tt(\d+)/i)?.[1];
        if (!imdb) return [];
        const hosts = getHostFallbackList('EZTV_HOST', ['eztv.tf', 'eztvx.to']);
        const data = await fetchJsonFromHosts(
            hosts,
            host => `https://${host}/api/get-torrents?imdb_id=${encodeURIComponent(imdb)}&limit=100`,
            { provider: 'EZTV', timeout: CONFIG.EZTV_TIMEOUT_MS, langMode: context.langMode, cooldownMs: 60_000 }
        );
        const torrents = data?.torrents;
        if (!Array.isArray(torrents)) return [];

        const rows = [];
        for (const torrent of torrents) {
            const season = Number(torrent.season) || 0;
            const episode = Number(torrent.episode) || 0;
            if (context.reqSeason && season && season !== Number(context.reqSeason)) continue;
            if (context.reqEpisode && episode && episode !== Number(context.reqEpisode)) continue;
            const hash = torrent.hash || extractInfoHash(torrent.magnet_url || torrent.magnet || '');
            if (!hash) continue;
            const title = normalizeSpaces(torrent.title || `${context.title} S${String(season || context.reqSeason || 1).padStart(2, '0')}E${String(episode || context.reqEpisode || 1).padStart(2, '0')}`);
            rows.push(normalizeResult({
                title,
                magnet: torrent.magnet_url || torrent.magnet || buildMagnetFromHash(hash, title),
                sizeBytes: Number(torrent.size_bytes) || 0,
                size: Number(torrent.size_bytes) > 0 ? bytesToSize(Number(torrent.size_bytes)) : '',
                seeders: Number(torrent.seeds) || 0,
                tracker: 'eztv'
            }, context, 'EZTV'));
        }

        return dedupeResults(rows.filter(Boolean)).slice(0, CONFIG.RESULT_LIMIT_PER_ENGINE);
    };

    try {
        return await resolveProviderCache(eztvCache, eztvRefreshInflight, cacheKey, 'EZTV', producer);
    } catch (error) {
        console.log(`[EZTV] Errore: ${error.message}`);
        return [];
    }
}

async function fetchSolidQuery(context, query) {
    if (isProviderOnCooldown('SolidTorrents')) return [];
    const hosts = getHostFallbackList('SOLID_HOST', ['solidtorrents.eu', 'solidtorrents.to']);
    const data = await runProviderSerial('SolidTorrents', CONFIG.SOLID_MIN_INTERVAL_MS, () => fetchJsonFromHosts(
        hosts,
        host => `https://${host}/api/v1/search?q=${encodeURIComponent(query)}&sort=seeders`,
        { provider: 'SolidTorrents', timeout: CONFIG.SOLID_TIMEOUT_MS, langMode: context.langMode, cooldownMs: 300_000 }
    ));
    const results = data?.results;
    if (!Array.isArray(results)) return [];

    return results.map(item => normalizeResult({
        title: item.title,
        magnet: item.magnet || buildMagnetFromHash(item.infohash || item.infoHash || item.hash, item.title),
        sizeBytes: Number(item.size) || Number(item.size_bytes) || 0,
        size: Number(item.size) > 0 ? bytesToSize(Number(item.size)) : '',
        seeders: Number(item.swarm?.seeders ?? item.seeders ?? item.seeds) || 0,
        tracker: 'solidtorrents'
    }, context, 'SolidTorrents')).filter(Boolean);
}

async function searchSolid(context) {
    if (context.isAnime) return [];
    if (isProviderOnCooldown('SolidTorrents')) return [];
    console.log(`[SolidTorrents] Avvio ricerca per: ${context.title}...`);
    const cacheKey = buildEngineCacheKey('solid', context);

    const producer = async () => {
        const results = await collectQueryResultsParallel(context, query => fetchSolidQuery(context, query), {
            maxQueries: Math.min(CONFIG.SOLID_MAX_QUERY_VARIANTS, context.langMode === 'all' ? 4 : 2),
            concurrency: CONFIG.SOLID_QUERY_CONCURRENCY
        });
        return dedupeResults(results).slice(0, CONFIG.RESULT_LIMIT_PER_ENGINE);
    };

    try {
        return await resolveProviderCache(solidCache, solidRefreshInflight, cacheKey, 'SolidTorrents', producer);
    } catch (error) {
        console.log(`[SolidTorrents] Errore: ${error.message}`);
        return [];
    }
}

async function searchNyaa(context) {
    if (!context.isAnime) return [];
    console.log(`[Nyaa] Avvio ricerca per: ${context.title}...`);
    try {
        const results = await collectQueryResults(context, async query => {
            const url = `https://nyaa.si/?f=0&c=1_0&q=${encodeURIComponent(query)}`;
            const { data } = await requestHtml(url, { timeout: 6500, langMode: 'all' });
            if (!data) return [];

            const $ = cheerio.load(data);
            const rows = [];

            $("table.torrent-list tbody tr").each((_, row) => {
                const cells = $(row).find("td");
                if (cells.length < 6) return;

                const titleEl = $(row).find('a[href^="/view/"]').last();
                const magnet = $(row).find('a[href^="magnet:"]').attr("href");
                const name = normalizeSpaces(titleEl.attr("title") || titleEl.text());
                if (!name || !magnet || !passesResultFilters(name, context)) return;

                const size = normalizeSpaces(cells.eq(Math.max(0, cells.length - 5)).text());
                const seeders = parseInt(cells.eq(Math.max(0, cells.length - 3)).text().trim(), 10) || 0;

                rows.push(normalizeResult({
                    title: name,
                    magnet,
                    size,
                    seeders
                }, context, "Nyaa"));
            });

            return rows.filter(Boolean);
        }, { maxQueries: 3 });

        const finalResults = dedupeResults(results).slice(0, CONFIG.RESULT_LIMIT_PER_ENGINE);
        console.log(`[Nyaa] Trovati ${finalResults.length} risultati validi.`);
        return finalResults;
    } catch (error) {
        console.log(`[Nyaa] Errore: ${error.message}`);
        return [];
    }
}

async function searchTPB(context) {
    console.log(`[TPB (ApiBay)] Avvio ricerca per: ${context.title}...`);
    try {
        const results = await collectQueryResults(context, async query => {
            const { data } = await axios.get(`https://apibay.org/q.php?q=${encodeURIComponent(query)}&cat=0`, {
                timeout: CONFIG.TIMEOUT_API,
                httpsAgent,
                headers: { "Accept-Language": getAcceptLanguage(context.langMode) }
            });

            if (!Array.isArray(data) || data[0]?.id === "0") return [];
            return data.map(item => normalizeResult({
                title: item.name,
                magnet: buildMagnetFromHash(item.info_hash, item.name),
                sizeBytes: parseInt(item.size, 10) || 0,
                size: (parseInt(item.size, 10) || 0) > 0 ? bytesToSize(parseInt(item.size, 10) || 0) : "",
                seeders: parseInt(item.seeders, 10) || 0
            }, context, "TPB")).filter(Boolean);
        }, { maxQueries: 3 });

        const finalResults = dedupeResults(results).slice(0, CONFIG.RESULT_LIMIT_PER_ENGINE);
        console.log(`[TPB (ApiBay)] Trovati ${finalResults.length} risultati validi.`);
        return finalResults;
    } catch (error) {
        console.log(`[TPB (ApiBay)] Errore: ${error.message}`);
        return [];
    }
}

async function searchTPBMirror(context) {
    console.log(`[TPB Mirror] Avvio ricerca per: ${context.title}...`);
    try {
        const results = await collectQueryResults(context, async query => {
            const url = `https://thepibay.site/search/${encodeURIComponent(query)}/1/99/0`;
            const { data } = await requestHtml(url, { timeout: 6500, langMode: context.langMode });
            if (!data) return [];

            const $ = cheerio.load(data);
            const rows = [];

            $("table#searchResult tr").each((_, row) => {
                const titleEl = $(row).find(".detName a.detLink");
                const magnet = $(row).find('a[href^="magnet:"]').attr("href");
                if (!titleEl.length || !magnet) return;

                const name = normalizeSpaces(titleEl.text());
                if (!passesResultFilters(name, context)) return;

                let sizeBytes = 0;
                const detDesc = $(row).find(".detDesc").text();
                const sizeMatch = detDesc.match(/Size\s+([\d.,]+\s*[A-Za-z]+)/i);
                if (sizeMatch) sizeBytes = parseSize(sizeMatch[1]);
                const tds = $(row).find('td[align="right"]');
                const seeders = tds.length > 0 ? (parseInt($(tds[0]).text().trim(), 10) || 0) : 0;

                rows.push(normalizeResult({
                    title: name,
                    magnet,
                    sizeBytes,
                    size: sizeBytes > 0 ? bytesToSize(sizeBytes) : "",
                    seeders
                }, context, "TPB Mirror"));
            });

            return rows.filter(Boolean);
        }, { maxQueries: 2 });

        const finalResults = dedupeResults(results).slice(0, CONFIG.RESULT_LIMIT_PER_ENGINE);
        console.log(`[TPB Mirror] Trovati ${finalResults.length} risultati validi.`);
        return finalResults;
    } catch (error) {
        console.log(`[TPB Mirror] Errore: ${error.message}`);
        return [];
    }
}

async function searchLime(context) {
    console.log(`[LimeTorrents] Avvio ricerca per: ${context.title}...`);
    try {
        const candidates = await collectQueryResults(context, async query => {
            const baseUrl = "https://limetorrents.org";
            const { data } = await requestHtml(`${baseUrl}/search?q=${encodeURIComponent(query)}`, { timeout: 7000, langMode: context.langMode });
            if (!data) return [];

            const $ = cheerio.load(data);
            const items = [];

            $("table.table2 tbody.torsearch tr").each((_, row) => {
                const tds = $(row).find("td");
                if (tds.length < 5) return;

                const titleEl = tds.eq(0).find(".tt-name a").last();
                const name = normalizeSpaces(titleEl.text());
                let detailUrl = titleEl.attr("href");
                if (!name || !detailUrl || !passesResultFilters(name, context)) return;

                if (!detailUrl.startsWith("http")) detailUrl = `${baseUrl}${detailUrl}`;
                const size = normalizeSpaces(tds.eq(2).text());
                const seeders = parseInt(tds.eq(3).text().trim(), 10) || 0;

                items.push({ title: name, detailUrl, size, seeders });
            });

            return items;
        }, { maxQueries: 2 });

        const results = await Promise.all(
            candidates.slice(0, 25).map(candidate =>
                detailLimit(async () => {
                    try {
                        const html = (await requestHtml(candidate.detailUrl, { timeout: 4500, langMode: context.langMode })).data;
                        const magnet = html ? cheerio.load(html)('a[href^="magnet:"]').first().attr("href") : null;
                        return normalizeResult({ ...candidate, magnet }, context, "LimeTorrents");
                    } catch {
                        return null;
                    }
                })
            )
        );

        const finalResults = dedupeResults(results.filter(Boolean)).slice(0, CONFIG.RESULT_LIMIT_PER_ENGINE);
        console.log(`[LimeTorrents] Trovati ${finalResults.length} risultati validi.`);
        return finalResults;
    } catch (error) {
        console.log(`[LimeTorrents] Errore: ${error.message}`);
        return [];
    }
}

async function searchRARBG(context) {
    console.log(`[RARBG] Avvio ricerca per: ${context.title}...`);
    const baseUrl = "https://www.rarbgproxy.to";
    try {
        const candidates = await collectQueryResults(context, async query => {
            const { data } = await requestHtml(`${baseUrl}/search/?search=${encodeURIComponent(query)}`, { timeout: 7000, langMode: context.langMode });
            if (!data) return [];

            const $ = cheerio.load(data);
            const items = [];

            $("tr.table2ta_rarbgproxy, table.lista2 tr").each((_, row) => {
                const tds = $(row).find("td");
                if (tds.length < 4) return;

                const linkTag = tds.eq(1).find("a").first();
                const name = normalizeSpaces(linkTag.text() || linkTag.attr("title"));
                let detailHref = linkTag.attr("href");
                if (!name || !detailHref || !passesResultFilters(name, context)) return;

                if (!detailHref.startsWith("http")) {
                    detailHref = `${baseUrl}${detailHref.startsWith("/") ? "" : "/"}${detailHref}`;
                }

                let size = normalizeSpaces(tds.eq(3).text());
                let seeders = parseInt(tds.eq(4).text().trim(), 10) || 0;
                if ($(row).hasClass("table2ta_rarbgproxy")) {
                    size = normalizeSpaces(tds.eq(4).text()) || size;
                    seeders = parseInt(tds.eq(5).text().trim(), 10) || seeders;
                }

                items.push({ title: name, detailUrl: detailHref, size, seeders });
            });

            return items;
        }, { maxQueries: 2 });

        const results = await Promise.all(
            candidates.slice(0, 25).map(candidate =>
                detailLimit(async () => {
                    try {
                        const detailHtml = (await requestHtml(candidate.detailUrl, { timeout: 4500 })).data;
                        if (!detailHtml) return null;
                        const magnet =
                            cheerio.load(detailHtml)('a[href^="magnet:"]').first().attr("href") ||
                            detailHtml.match(/magnet:\?xt=urn:btih:[A-Za-z0-9]{32,40}[^"'\s]*/i)?.[0];
                        return normalizeResult({ ...candidate, magnet }, context, "RARBG");
                    } catch {
                        return null;
                    }
                })
            )
        );

        const finalResults = dedupeResults(results.filter(Boolean)).slice(0, CONFIG.RESULT_LIMIT_PER_ENGINE);
        console.log(`[RARBG] Trovati ${finalResults.length} risultati validi.`);
        return finalResults;
    } catch (error) {
        console.log(`[RARBG] Errore di connessione al proxy: ${error.message}`);
        return [];
    }
}

async function search1337x(context) {
    console.log(`[1337x] Avvio ricerca per: ${context.title}...`);
    try {
        const queries = buildSearchQueries(context).slice(0, 2);
        const baseUrl = "https://1337x.bz";
        const headers = {
            "User-Agent": BROWSER_PROFILES[2].userAgent,
            Accept: "application/json, text/plain, */*",
            "Accept-Language": getAcceptLanguage(context.langMode),
            Referer: `${baseUrl}/home/`
        };

        const pageJobs = [];
        for (const query of queries) {
            for (let page = 1; page <= 3; page += 1) {
                const url = page === 1
                    ? `${baseUrl}/get-posts/keywords:${encodeURIComponent(query)}:format:json:ncategory:XXX/`
                    : `${baseUrl}/get-posts/keywords:${encodeURIComponent(query)}:format:json:ncategory:XXX/?page=${page}`;
                pageJobs.push(
                    axios.get(url, { timeout: CONFIG.TIMEOUT_API * 2, headers, httpsAgent })
                        .then(response => response.data)
                        .catch(() => null)
                );
            }
        }

        const pageResults = await Promise.all(pageJobs);
        const normalized = [];
        const seenHashes = new Set();

        for (const data of pageResults) {
            if (!data?.results || !Array.isArray(data.results)) continue;
            for (const item of data.results) {
                const infoHash = (item.h || String(item.pk || "")).replace(/[^A-Za-z0-9]/g, "").toLowerCase();
                if (!infoHash || infoHash.length < 32 || seenHashes.has(infoHash)) continue;
                seenHashes.add(infoHash);

                const result = normalizeResult({
                    title: item.n || "Unknown Title",
                    magnet: buildMagnetFromHash(infoHash, item.n),
                    sizeBytes: parseInt(item.s, 10) || 0,
                    size: (parseInt(item.s, 10) || 0) > 0 ? bytesToSize(parseInt(item.s, 10) || 0) : "",
                    seeders: parseInt(item.se, 10) || 0
                }, context, "1337x");

                if (result) normalized.push(result);
            }
        }

        const finalResults = dedupeResults(normalized).slice(0, CONFIG.RESULT_LIMIT_PER_ENGINE);
        console.log(`[1337x] Trovati ${finalResults.length} risultati validi.`);
        return finalResults;
    } catch (error) {
        console.log(`[1337x] Errore: ${error.message}`);
        return [];
    }
}

async function searchBitSearch(context) {
    console.log(`[BitSearch] Avvio ricerca per: ${context.title}...`);
    try {
        const results = await collectQueryResults(context, async query => {
            const { data } = await axios.get(`https://bitsearch.to/api/v1/search?q=${encodeURIComponent(query)}&limit=50`, {
                timeout: CONFIG.TIMEOUT_API,
                httpsAgent,
                headers: { "Accept-Language": getAcceptLanguage(context.langMode) }
            });

            if (!data?.data || !Array.isArray(data.data)) return [];
            return data.data.map(item => normalizeResult({
                title: item.name,
                magnet: buildMagnetFromHash(item.infohash, item.name),
                sizeBytes: parseInt(item.size, 10) || 0,
                size: (parseInt(item.size, 10) || 0) > 0 ? bytesToSize(parseInt(item.size, 10) || 0) : "",
                seeders: parseInt(item.seeders, 10) || 0
            }, context, "BitSearch")).filter(Boolean);
        }, { maxQueries: 3 });

        const finalResults = dedupeResults(results).slice(0, CONFIG.RESULT_LIMIT_PER_ENGINE);
        console.log(`[BitSearch] Trovati ${finalResults.length} risultati validi.`);
        return finalResults;
    } catch (error) {
        console.log(`[BitSearch] Errore durante la ricerca: ${error.message}`);
        return [];
    }
}

async function searchUindex(context) {
    console.log(`[UIndex] Avvio ricerca turbo per: ${context.title}...`);
    const cacheKey = buildEngineCacheKey('uindex', context);

    const producer = async () => {
        const candidates = await collectQueryResultsParallel(context, async query => {
            const url = `https://uindex.org/search.php?search=${encodeURIComponent(query)}&c=0`;
            const { data } = await requestHtml(url, {
                timeout: CONFIG.UINDEX_SEARCH_TIMEOUT_MS,
                langMode: context.langMode
            });
            if (!data || isCloudflareResponse(data)) return [];
            return parseUindexListRows(data, context, 'https://uindex.org');
        }, {
            maxQueries: Math.min(context.isAnime ? CONFIG.MAX_ANIME_QUERY_VARIANTS_PER_ENGINE : 4, 6),
            concurrency: CONFIG.UINDEX_QUERY_CONCURRENCY
        });

        const ranked = rankDetailCandidates(candidates, context, CONFIG.UINDEX_MAX_DETAIL_CANDIDATES);
        const directResults = ranked
            .filter(candidate => candidate.magnet)
            .map(candidate => normalizeResult(candidate, context, 'UIndex'))
            .filter(Boolean);

        const detailResults = await Promise.all(
            ranked.filter(candidate => !candidate.magnet && candidate.detailUrl).map(candidate =>
                detailLimit(async () => {
                    try {
                        const html = (await requestHtml(candidate.detailUrl, {
                            timeout: CONFIG.UINDEX_DETAIL_TIMEOUT_MS,
                            langMode: context.langMode,
                            maxRedirects: 3
                        })).data;
                        const enriched = parseUindexDetailPayload(html, candidate);
                        return normalizeResult(enriched, context, 'UIndex');
                    } catch {
                        return null;
                    }
                })
            )
        );

        const finalResults = dedupeResults([...directResults, ...detailResults.filter(Boolean)])
            .slice(0, CONFIG.RESULT_LIMIT_PER_ENGINE);
        console.log(`[UIndex] Trovati ${finalResults.length} risultati validi.`);
        return finalResults;
    };

    try {
        return await resolveProviderCache(uindexCache, uindexRefreshInflight, cacheKey, 'UIndex', producer);
    } catch (error) {
        console.log(`[UIndex] Errore: ${error.message}`);
        return [];
    }
}

async function searchKickassTorrents(context) {
    console.log(`[KickassTorrents] Avvio ricerca per: ${context.title}...`);
    try {
        const hosts = getHostFallbackList('KAT_HOST', ['katcr.to', 'kickasstorrents.to', 'kickasstorrents.unblockit.download']);
        const results = await collectQueryResultsParallel(context, async query => {
            const { data, baseUrl } = await requestProviderHtml('KickassTorrents', hosts, base => `${base}/usearch/${encodeURIComponent(query)}/`, context, {
                timeout: CONFIG.KAT_SEARCH_TIMEOUT_MS
            });
            return parseKickassRows(data, context, baseUrl);
        }, {
            maxQueries: Math.min(context.isAnime ? CONFIG.MAX_ANIME_QUERY_VARIANTS_PER_ENGINE : CONFIG.MAX_QUERY_VARIANTS_PER_ENGINE, 4),
            concurrency: CONFIG.KAT_QUERY_CONCURRENCY
        });

        const finalResults = dedupeResults(results.map(item => normalizeResult(item, context, 'KickassTorrents')).filter(Boolean))
            .slice(0, CONFIG.RESULT_LIMIT_PER_ENGINE);
        console.log(`[KickassTorrents] Trovati ${finalResults.length} risultati validi.`);
        return finalResults;
    } catch (error) {
        console.log(`[KickassTorrents] Errore: ${error.message}`);
        return [];
    }
}

async function searchTorLock(context) {
    console.log(`[TorLock] Avvio ricerca per: ${context.title}...`);
    try {
        const hosts = getHostFallbackList('TORLOCK_HOST', ['torlock2.com', 'torlock.com']);
        const category = context.normalizedType === 'movie' ? 'movies' : 'television';
        const candidates = await collectQueryResultsParallel(context, async query => {
            const { data, baseUrl } = await requestProviderHtml('TorLock', hosts, base => `${base}/${category}/torrents/${encodeURIComponent(query)}.html`, context, {
                timeout: CONFIG.TORLOCK_SEARCH_TIMEOUT_MS
            });
            return parseTorLockRows(data, context, baseUrl);
        }, {
            maxQueries: Math.min(context.isAnime ? CONFIG.MAX_ANIME_QUERY_VARIANTS_PER_ENGINE : CONFIG.MAX_QUERY_VARIANTS_PER_ENGINE, 4),
            concurrency: CONFIG.TORLOCK_QUERY_CONCURRENCY
        });

        const ranked = rankDetailCandidates(candidates, context, CONFIG.TORLOCK_MAX_DETAIL_CANDIDATES);
        const directResults = ranked
            .filter(candidate => candidate.magnet)
            .map(candidate => normalizeResult(candidate, context, 'TorLock'))
            .filter(Boolean);
        const detailResults = await Promise.all(
            ranked.filter(candidate => !candidate.magnet && candidate.detailUrl).map(candidate =>
                detailLimit(async () => {
                    const enriched = await enrichCandidateFromDetail(candidate, context, 'TorLock', CONFIG.TORLOCK_DETAIL_TIMEOUT_MS);
                    return normalizeResult(enriched, context, 'TorLock');
                })
            )
        );
        const finalResults = dedupeResults([...directResults, ...detailResults.filter(Boolean)])
            .slice(0, CONFIG.RESULT_LIMIT_PER_ENGINE);
        console.log(`[TorLock] Trovati ${finalResults.length} risultati validi.`);
        return finalResults;
    } catch (error) {
        console.log(`[TorLock] Errore: ${error.message}`);
        return [];
    }
}

async function searchTorrentDownloads(context) {
    console.log(`[TorrentDownloads] Avvio ricerca per: ${context.title}...`);
    try {
        const hosts = getHostFallbackList('TORRENTDOWNLOADS_HOST', ['torrentdownload.info', 'torrentdownloads.pro']);
        const category = context.normalizedType === 'movie' ? '4' : '8';
        const results = await collectQueryResultsParallel(context, async query => {
            const { data, baseUrl } = await requestProviderHtml('TorrentDownloads', hosts, base => `${base}/search/?search=${encodeURIComponent(query)}&cat=${category}`, context, {
                timeout: CONFIG.TORRENTDOWNLOADS_SEARCH_TIMEOUT_MS
            });
            return parseTorrentDownloadsRows(data, context, baseUrl);
        }, {
            maxQueries: Math.min(context.isAnime ? CONFIG.MAX_ANIME_QUERY_VARIANTS_PER_ENGINE : CONFIG.MAX_QUERY_VARIANTS_PER_ENGINE, 4),
            concurrency: CONFIG.TORRENTDOWNLOADS_QUERY_CONCURRENCY
        });

        const finalResults = dedupeResults(results.map(item => normalizeResult(item, context, 'TorrentDownloads')).filter(Boolean))
            .slice(0, CONFIG.RESULT_LIMIT_PER_ENGINE);
        console.log(`[TorrentDownloads] Trovati ${finalResults.length} risultati validi.`);
        return finalResults;
    } catch (error) {
        console.log(`[TorrentDownloads] Errore: ${error.message}`);
        return [];
    }
}

async function searchTheRarBG(context) {
    console.log(`[TheRarBG] Avvio ricerca per: ${context.title}...`);
    try {
        const hosts = getHostFallbackList('THERARBG_HOST', ['therarbg.com']);
        const category = context.normalizedType === 'movie' ? 'Movies' : 'TV';
        const candidates = await collectQueryResultsParallel(context, async query => {
            const { data, baseUrl } = await requestProviderHtml('TheRarBG', hosts, base => `${base}/get-posts/order:-se:category:${category}:keywords:${encodeURIComponent(query)}/`, context, {
                timeout: CONFIG.THERARBG_SEARCH_TIMEOUT_MS
            });
            return parseTheRarBGSearchRows(data, context, baseUrl);
        }, {
            maxQueries: Math.min(context.isAnime ? CONFIG.MAX_ANIME_QUERY_VARIANTS_PER_ENGINE : CONFIG.MAX_QUERY_VARIANTS_PER_ENGINE, 4),
            concurrency: CONFIG.THERARBG_QUERY_CONCURRENCY
        });

        const ranked = rankDetailCandidates(candidates, context, CONFIG.THERARBG_MAX_DETAIL_CANDIDATES);
        const directResults = ranked
            .filter(candidate => candidate.magnet)
            .map(candidate => normalizeResult(candidate, context, 'TheRarBG'))
            .filter(Boolean);
        const detailResults = await Promise.all(
            ranked.filter(candidate => !candidate.magnet && candidate.detailUrl).map(candidate =>
                detailLimit(async () => {
                    const enriched = await enrichCandidateFromDetail(candidate, context, 'TheRarBG', CONFIG.THERARBG_DETAIL_TIMEOUT_MS);
                    return normalizeResult(enriched, context, 'TheRarBG');
                })
            )
        );
        const finalResults = dedupeResults([...directResults, ...detailResults.filter(Boolean)])
            .slice(0, CONFIG.RESULT_LIMIT_PER_ENGINE);
        console.log(`[TheRarBG] Trovati ${finalResults.length} risultati validi.`);
        return finalResults;
    } catch (error) {
        console.log(`[TheRarBG] Errore: ${error.message}`);
        return [];
    }
}

async function searchSubsPlease(context) {
    if (!context.isAnime) return [];
    console.log(`[SubsPlease] Avvio ricerca per: ${context.title}...`);
    try {
        const results = await collectQueryResults(context, async query => {
            const { data } = await axios.get(`https://subsplease.org/api/?f=search&tz=UTC&s=${encodeURIComponent(query)}`, {
                timeout: CONFIG.TIMEOUT_API * 2,
                httpsAgent,
                headers: { "Accept-Language": getAcceptLanguage('all') }
            });

            if (!data || typeof data !== "object") return [];
            return Object.values(data).flatMap(entry => {
                const downloads = Array.isArray(entry?.downloads) ? entry.downloads : [];
                const episode = parseInt(entry?.episode, 10) || context.reqEpisode || 0;
                const show = normalizeSpaces(entry?.show || context.title);

                return downloads.map(download => {
                    const magnet = download?.magnet;
                    if (!magnet) return null;

                    const resolution = normalizeSpaces(download?.res ? `${download.res}p` : "");
                    const title = normalizeSpaces(`[SubsPlease] ${show}${episode > 0 ? ` - ${String(episode).padStart(2, '0')}` : ''}${resolution ? ` (${resolution})` : ''}`);
                    const sizeBytes = parseMagnetSizeBytes(magnet);

                    return normalizeResult({
                        title,
                        magnet,
                        sizeBytes,
                        size: sizeBytes > 0 ? bytesToSize(sizeBytes) : "",
                        seeders: 0
                    }, context, "SubsPlease");
                }).filter(Boolean);
            });
        }, { maxQueries: 2 });

        const finalResults = dedupeResults(results).slice(0, CONFIG.RESULT_LIMIT_PER_ENGINE);
        console.log(`[SubsPlease] Trovati ${finalResults.length} risultati validi.`);
        return finalResults;
    } catch (error) {
        console.log(`[SubsPlease] Errore: ${error.message}`);
        return [];
    }
}

const ACTIVE_ENGINES = [
    { name: "Corsaro", fn: searchCorsaro, timeout: CONFIG.ENGINE_TIMEOUT },
    { name: "Knaben", fn: searchKnaben, timeout: CONFIG.ENGINE_TIMEOUT },
    { name: "Nyaa", fn: searchNyaa, timeout: CONFIG.ENGINE_TIMEOUT },
    { name: "SubsPlease", fn: searchSubsPlease, timeout: CONFIG.ENGINE_TIMEOUT },
    { name: "YTS", fn: searchYTS, timeout: CONFIG.ENGINE_TIMEOUT },
    { name: "EZTV", fn: searchEZTV, timeout: CONFIG.ENGINE_TIMEOUT },
    { name: "TPB", fn: searchTPB, timeout: CONFIG.ENGINE_TIMEOUT },
    { name: "TPB Mirror", fn: searchTPBMirror, timeout: CONFIG.ENGINE_TIMEOUT },
    { name: "SolidTorrents", fn: searchSolid, timeout: CONFIG.ENGINE_TIMEOUT + 2000 },
    { name: "1337x", fn: search1337x, timeout: CONFIG.ENGINE_TIMEOUT + 2000 },
    { name: "BitSearch", fn: searchBitSearch, timeout: CONFIG.ENGINE_TIMEOUT },
    { name: "LimeTorrents", fn: searchLime, timeout: CONFIG.ENGINE_TIMEOUT },
    { name: "RARBG", fn: searchRARBG, timeout: CONFIG.ENGINE_TIMEOUT },
    { name: "TheRarBG", fn: searchTheRarBG, timeout: CONFIG.ENGINE_TIMEOUT + 2000 },
    { name: "KickassTorrents", fn: searchKickassTorrents, timeout: CONFIG.ENGINE_TIMEOUT },
    { name: "TorLock", fn: searchTorLock, timeout: CONFIG.ENGINE_TIMEOUT + 1000 },
    { name: "TorrentDownloads", fn: searchTorrentDownloads, timeout: CONFIG.ENGINE_TIMEOUT },
    { name: "UIndex", fn: searchUindex, timeout: CONFIG.ENGINE_TIMEOUT }
];

function buildSearchCacheKey(context) {
    return JSON.stringify({
        title: context.cleanTitle.toLowerCase(),
        year: context.year || "",
        type: context.normalizedType,
        reqSeason: context.reqSeason || 0,
        reqEpisode: context.reqEpisode || 0,
        langMode: context.langMode,
        isAnime: context.isAnime === true
    });
}

async function runEngine(engine, context) {
    return engineLimit(async () => {
        try {
            const startedAt = now();
            const results = await withTimeout(engine.fn(context), engine.timeout);
            console.log(`[${engine.name}] completato in ${now() - startedAt}ms con ${results.length} risultati.`);
            return results;
        } catch (error) {
            console.log(`[TIMEOUT/CRITICAL] ${engine.name} interrotto: ${error.message}`);
            return [];
        }
    });
}

async function searchMagnet(title, year, type, imdbId, options = {}) {
    console.log(`\n======================================================`);
    console.log(`🚀 AVVIO RICERCA GLOBALE: "${title}" (Anno: ${year || "N/D"})`);
    console.log(`======================================================\n`);

    const context = buildSearchContext(title, year, type, imdbId, options);
    const cacheKey = buildSearchCacheKey(context);
    const cached = getCache(searchCache, cacheKey);
    if (cached) {
        console.log(`⚡ [CACHE] Hit per "${title}" -> ${cached.length} risultati.`);
        return cached;
    }

    const settledResults = await Promise.allSettled(
        ACTIVE_ENGINES.map(engine => runEngine(engine, context))
    );

    const rawResults = settledResults
        .filter(item => item.status === "fulfilled")
        .flatMap(item => item.value);

    const uniqueResults = dedupeResults(rawResults)
        .sort((a, b) => {
            if ((b._score || 0) !== (a._score || 0)) return (b._score || 0) - (a._score || 0);
            if ((b.seeders || 0) !== (a.seeders || 0)) return (b.seeders || 0) - (a.seeders || 0);
            return (b.sizeBytes || 0) - (a.sizeBytes || 0);
        })
        .slice(0, CONFIG.FINAL_RESULT_LIMIT)
        .map(result => ({
            title: result.title,
            magnet: appendTrackers(result.magnet),
            size: result.size || bytesToSize(result.sizeBytes),
            sizeBytes: result.sizeBytes || 0,
            seeders: result.seeders || 0,
            source: result.source
        }));

    const ttl = uniqueResults.length > 0 ? CONFIG.SEARCH_CACHE_TTL : CONFIG.NEGATIVE_CACHE_TTL;
    setCache(searchCache, cacheKey, uniqueResults, ttl);

    console.log(`\n✅ RICERCA CONCLUSA. Trovati ${uniqueResults.length} risultati unici totali per "${title}".\n`);
    return uniqueResults;
}

async function updateTrackers() {
    let fetched = [];
    try {
        const { data } = await axios.get("https://ngosang.github.io/trackerslist/trackers_best.txt", {
            timeout: 4000,
            httpsAgent,
            headers: { "Accept-Language": getAcceptLanguage('all') }
        });
        fetched = String(data || "")
            .split("\n")
            .map(line => line.trim())
            .filter(Boolean)
            .filter(line => /^udp:\/\/|^https?:\/\//i.test(line));
    } catch {
        console.log(`[Trackers] Impossibile aggiornare i tracker dal master list.`);
    }

    const merged = [...new Set([...fetched, ...getCentralTrackers(), ...DEFAULT_TRACKERS].filter(Boolean))]
        .slice(0, 50);
    CONFIG.TRACKERS = merged.length ? merged : [...DEFAULT_TRACKERS];
    console.log(`[Trackers] Pool unificato: ${CONFIG.TRACKERS.length} tracker (upstream=${fetched.length}, central=${getCentralTrackers().length}).`);
    return CONFIG.TRACKERS;
}

module.exports = {
    name: "TorrentEngines",
    searchMagnet,
    updateTrackers,
    CONFIG,
    requestHtml,
    clean,
    parseSize,
    bytesToSize,
    isValidResult,
    checkYear,
    isCorrectFormat,
    __internals: {
        buildSearchContext,
        buildSearchQueries,
        getLanguageScore,
        getKnabenCategories,
        parseKnabenCategoryId,
        isBlacklistedCategory,
        extractInfoHashFromText,
        parsePeerHealthFromText,
        normalizeUindexTitle,
        parseUindexListRows,
        parseUindexDetailPayload,
        parseCorsaroSearchRows,
        rankDetailCandidates,
        fetchSolidQuery,
        searchYTS,
        searchEZTV,
        searchSolid,
        computeResultScore,
        normalizeResult
    }
};

