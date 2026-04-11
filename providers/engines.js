const axios = require("axios");
const cheerio = require("cheerio");
const https = require("https");
const pLimit = require("p-limit");
const he = require("he");
const { ENGINE_BROWSER_PROFILES } = require('../core/browser_profiles');

const BROWSER_PROFILES = ENGINE_BROWSER_PROFILES;

const DEFAULT_TRACKERS = [
    "udp://tracker.opentrackr.org:1337/announce",
    "udp://open.demonoid.ch:6969/announce",
    "udp://open.demonii.com:1337/announce",
    "udp://open.stealth.si:80/announce",
    "udp://tracker.torrent.eu.org:451/announce",
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
    ENGINE_CONCURRENCY: Number(process.env.ENGINES_ENGINE_CONCURRENCY || 5),
    DETAIL_FETCH_CONCURRENCY: Number(process.env.ENGINES_DETAIL_CONCURRENCY || 12),
    RESULT_LIMIT_PER_ENGINE: Number(process.env.ENGINES_RESULT_LIMIT_PER_ENGINE || 120),
    FINAL_RESULT_LIMIT: Number(process.env.ENGINES_FINAL_RESULT_LIMIT || 300),
    MAX_QUERY_VARIANTS_PER_ENGINE: Number(process.env.ENGINES_MAX_QUERY_VARIANTS || 4),
    SEARCH_CACHE_TTL: Number(process.env.ENGINES_SEARCH_CACHE_TTL || 180000),
    HTML_CACHE_TTL: Number(process.env.ENGINES_HTML_CACHE_TTL || 45000),
    NEGATIVE_CACHE_TTL: Number(process.env.ENGINES_NEGATIVE_CACHE_TTL || 20000),
    RETRIES: Number(process.env.ENGINES_RETRIES || 2),
    RETRY_BACKOFF_MS: Number(process.env.ENGINES_RETRY_BACKOFF_MS || 350),
    KNABEN_API: "https://api.knaben.org/v1",
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
const searchCache = new Map();
const htmlCache = new Map();
const inflightRequests = new Map();
let gotScrapingLoader = null;

async function getGotScrapingClient() {
    if (!gotScrapingLoader) {
        gotScrapingLoader = import("got-scraping")
            .then((mod) => mod.gotScraping || mod.default?.gotScraping || mod.default || mod)
            .catch((error) => {
                gotScrapingLoader = null;
                throw error;
            });
    }
    return gotScrapingLoader;
}

async function requestWithGotScraping(url, config = {}) {
    const gotScraping = await getGotScrapingClient();
    const response = await gotScraping({
        url,
        method: "GET",
        headers: config.headers,
        timeout: { request: config.timeout || CONFIG.TIMEOUT },
        https: { rejectUnauthorized: false },
        followRedirect: (config.maxRedirects ?? 5) > 0,
        maxRedirects: config.maxRedirects ?? 5,
        throwHttpErrors: false,
        retry: { limit: 0 },
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
const OTHER_LANGUAGE_REGEX = /\b(?:TRUEFRENCH|FRENCH|GERMAN|SPANISH|LATINO|RUSSIAN|POLISH|TAMIL|TELUGU|HINDI|KOREAN|JAPANESE)\b/i;
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
    "1337x": 23,
    BitSearch: 22,
    RARBG: 21,
    LimeTorrents: 19,
    "TPB Mirror": 18,
    TPB: 17,
    UIndex: 14
};
const ENGINE_BLACKLISTED_CATEGORIES = new Set([6006000, 6007000, 6005000]);

function now() {
    return Date.now();
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function getCache(map, key) {
    const hit = map.get(key);
    if (!hit) return null;
    if (hit.expiresAt <= now()) {
        map.delete(key);
        return null;
    }
    return hit.value;
}

function setCache(map, key, value, ttl) {
    if (!ttl || ttl <= 0) return value;
    map.set(key, { value, expiresAt: now() + ttl });
    if (map.size > 800) pruneCache(map);
    return value;
}

function pruneCache(map) {
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
        .replace(/[:"'’`´]/g, "")
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
    const season = parseInt(parts[1], 10);
    const episode = parseInt(parts[2], 10);
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
                const canTryGotScraping = method === "GET";
                if (canTryGotScraping) {
                    try {
                        const response = await requestWithGotScraping(url, {
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
    const trackers = [...new Set(CONFIG.TRACKERS.filter(Boolean))].slice(0, 20);
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

function getLanguageScore(name, langMode = 'ita') {
    const normalized = normalizeSpaces(name).toUpperCase();
    const hasItalianAudio = ITALIAN_AUDIO_REGEX.test(normalized);
    const hasItalianSubs = ITALIAN_SUB_REGEX.test(normalized);
    const isTrustedItalian = TRUSTED_ITALIAN_REGEX.test(normalized);
    const hasEnglishAudio = ENGLISH_AUDIO_REGEX.test(normalized);
    const hasMultiLanguage = MULTI_LANGUAGE_REGEX.test(normalized);
    const hasOtherLanguage = OTHER_LANGUAGE_REGEX.test(normalized);

    if (langMode === 'eng') {
        if (hasItalianAudio || isTrustedItalian || hasItalianSubs) return -50;
        if (hasMultiLanguage) return -15;
        if (hasOtherLanguage && !hasEnglishAudio) return -45;
        if (hasEnglishAudio) return 30;
        return 12;
    }

    if (langMode === 'all') {
        if (hasOtherLanguage && !hasItalianAudio && !hasEnglishAudio && !hasMultiLanguage) return -30;
        if (hasItalianAudio) return 30;
        if (hasEnglishAudio) return 28;
        if (hasMultiLanguage) return 24;
        if (isTrustedItalian) return 20;
        if (hasItalianSubs) return 10;
        return 6;
    }

    if (hasItalianAudio) return 30;
    if (isTrustedItalian && !hasOtherLanguage) return 22;
    if (hasItalianSubs) return 12;
    if (hasEnglishAudio || hasOtherLanguage) return -40;
    return -8;
}

function isValidResult(name, langMode = 'ita') {
    if (!name) return false;
    const normalized = normalizeSpaces(name);
    if (NOISY_TITLE_REGEX.test(normalized)) return false;
    if (getLanguageScore(normalized, langMode) < 0) return false;
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

function isCorrectFormat(name, reqSeason, reqEpisode) {
    if (!reqSeason && !reqEpisode) return true;
    const normalized = normalizeSpaces(name).toUpperCase();

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
            if (Number.isInteger(season) && season !== reqSeason) return false;
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
        const reqSeason = context.reqSeason;
        const reqEpisode = context.reqEpisode;

        pushUnique(bucket, base);

        if (context.year && !isSeries) {
            pushUnique(bucket, `${base} ${context.year}`);
        }

        if (isSeries && reqSeason && reqEpisode) {
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

    for (const query of baseQueries) {
        pushUnique(itaQueries, `${query} ITA`);
        pushUnique(itaQueries, `${query} MULTI`);
        pushUnique(engQueries, query);
        pushUnique(engQueries, `${query} ENG`);
        pushUnique(engQueries, `${query} ENGLISH`);
    }

    if (context.langMode === 'eng') {
        return [...engQueries].slice(0, CONFIG.MAX_QUERY_VARIANTS_PER_ENGINE);
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
        return mixed.slice(0, CONFIG.MAX_QUERY_VARIANTS_PER_ENGINE);
    }

    return [...itaQueries].slice(0, CONFIG.MAX_QUERY_VARIANTS_PER_ENGINE);
}

function buildSearchContext(title, year, type, imdbId, options = {}) {
    const episodeContext = extractEpisodeContext(imdbId);
    const langMode = resolveLangMode(options);
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
        options
    };
}

function passesResultFilters(name, context) {
    if (!isValidResult(name, context.langMode)) return false;
    if (!checkYear(name, context.year, context.type)) return false;
    if (!isCorrectFormat(name, context.reqSeason, context.reqEpisode)) return false;

    const matchScore = titleMatchScore(name, context.title);
    if (context.normalizedType === "movie" && matchScore < 0.34) return false;
    if (context.normalizedType === "series" && matchScore < 0.30) return false;
    return true;
}

function computeResultScore(result, context) {
    const seeders = Math.max(0, Number(result.seeders) || 0);
    const sizeBytes = Math.max(0, Number(result.sizeBytes) || 0);
    const languageScore = getLanguageScore(result.title, context.langMode);
    const resolutionScore = getResolutionScore(result.title) * 8;
    const yearScore = checkYear(result.title, context.year, context.type) ? 8 : -30;
    const formatScore = isCorrectFormat(result.title, context.reqSeason, context.reqEpisode) ? 18 : -60;
    const overlapScore = Math.round(titleMatchScore(result.title, context.title) * 40);
    const sourceScore = SOURCE_WEIGHTS[result.source] || 10;
    const sizeScore = sizeBytes > 0 ? Math.min(20, Math.round(Math.log10(sizeBytes + 1))) : 0;
    const seederScore = Math.min(35, Math.round(Math.log2(seeders + 1) * 4));
    return languageScore + resolutionScore + yearScore + formatScore + overlapScore + sourceScore + sizeScore + seederScore;
}

function normalizeResult(raw, context, source) {
    if (!raw) return null;
    const title = normalizeSpaces(raw.title || raw.name || "");
    const magnet = appendTrackers(raw.magnet || raw.magnetLink || "");
    const hash = extractInfoHash(magnet);
    if (!title || !magnet || !hash) return null;
    if (!passesResultFilters(title, context)) return null;

    let sizeBytes = Number(raw.sizeBytes) || 0;
    if (!sizeBytes && raw.size) sizeBytes = parseSize(raw.size);
    let size = raw.size || "";
    if (!size && sizeBytes > 0) size = bytesToSize(sizeBytes);

    const normalized = {
        title,
        magnet,
        size,
        sizeBytes,
        seeders: Math.max(0, parseInt(raw.seeders, 10) || 0),
        source: source || raw.source || "Unknown"
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

async function searchCorsaro(context) {
    console.log(`[IlCorsaroNero] Avvio ricerca per: ${context.title}...`);
    try {
        const candidates = await collectQueryResults(context, async query => {
            const url = `https://ilcorsaronero.link/search?q=${encodeURIComponent(query)}`;
            const { data } = await requestHtml(url, { langMode: context.langMode });
            if (!data || isCloudflareResponse(data)) return [];

            const $ = cheerio.load(data);
            const items = [];

            $("table tr, tbody tr").each((_, row) => {
                const $row = $(row);
                const linkTag = $row.find('a[href*="/torrent/"]').first();
                if (!linkTag.length) return;

                const name = normalizeSpaces(linkTag.text());
                const href = linkTag.attr("href");
                if (!name || !href || !passesResultFilters(name, context)) return;

                const seedersText = $row.find('.green, font[color="#008000"], td.text-green-500').text().trim();
                const seeders = parseInt(seedersText.replace(/,/g, ""), 10) || 0;

                let sizeStr = "";
                $row.find("td").each((__, cell) => {
                    const text = normalizeSpaces($(cell).text());
                    if (!sizeStr && /\b(?:GiB|MiB|KiB|TiB|GB|MB|KB|TB)\b/i.test(text)) {
                        sizeStr = text.replace(/([GMTK])iB/gi, "$1B");
                    }
                });

                items.push({
                    title: name,
                    detailUrl: href.startsWith("http") ? href : `https://ilcorsaronero.link${href}`,
                    size: sizeStr || "",
                    seeders
                });
            });

            return items;
        });

        const results = await Promise.all(
            candidates.slice(0, 30).map(candidate =>
                detailLimit(async () => {
                    try {
                        const html = (await requestHtml(candidate.detailUrl, { timeout: 4500, langMode: context.langMode })).data;
                        if (!html) return null;
                        const magnet =
                            cheerio.load(html)('a[href^="magnet:"]').attr("href") ||
                            html.match(/magnet:\?xt=urn:btih:[A-Za-z0-9]{32,40}[^"'\s]*/i)?.[0];
                        return normalizeResult({ ...candidate, magnet }, context, "Corsaro");
                    } catch {
                        return null;
                    }
                })
            )
        );

        const finalResults = dedupeResults(results.filter(Boolean)).slice(0, CONFIG.RESULT_LIMIT_PER_ENGINE);
        console.log(`[IlCorsaroNero] Trovati ${finalResults.length} risultati validi.`);
        return finalResults;
    } catch (error) {
        console.log(`[IlCorsaroNero] Errore: ${error.message}`);
        return [];
    }
}

function getKnabenCategories(type) {
    const normalizedType = normalizeType(type);
    if (normalizedType === "movie") return [3000000];
    if (normalizedType === "series") return [2000000, 6000000];
    return [];
}

function isBlacklistedCategory(categoryId) {
    if (categoryId === undefined || categoryId === null) return false;
    if (Array.isArray(categoryId)) return categoryId.some(isBlacklistedCategory);
    const numeric = parseInt(String(categoryId), 10);
    return ENGINE_BLACKLISTED_CATEGORIES.has(numeric);
}

async function searchKnaben(context) {
    console.log(`[Knaben] Avvio ricerca per: ${context.title}...`);
    try {
        const categories = getKnabenCategories(context.type);
        const results = await collectQueryResults(context, async query => {
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
                if (!hit?.title || isBlacklistedCategory(hit.categoryId)) return null;
                const magnet = hit.magnetUrl || buildMagnetFromHash(hit.hash, hit.title);
                if (!magnet) return null;
                return normalizeResult({
                    title: hit.title,
                    magnet,
                    sizeBytes: Number(hit.bytes) || 0,
                    size: hit.bytes ? bytesToSize(hit.bytes) : "",
                    seeders: parseInt(hit.seeders, 10) || 0
                }, context, "Knaben");
            }).filter(Boolean);
        }, { maxQueries: 3 });

        const finalResults = dedupeResults(results).slice(0, CONFIG.RESULT_LIMIT_PER_ENGINE);
        console.log(`[Knaben] Trovati ${finalResults.length} risultati validi.`);
        return finalResults;
    } catch (error) {
        console.log(`[Knaben] Errore durante la ricerca: ${error.message}`);
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
    console.log(`[UIndex] Avvio ricerca per: ${context.title}...`);
    try {
        const results = await collectQueryResults(context, async query => {
            const { data } = await requestHtml(`https://uindex.org/search.php?search=${encodeURIComponent(query)}&c=0`, { timeout: 5000, langMode: context.langMode });
            if (!data) return [];

            return data
                .split(/<tr[^>]*>/gi)
                .map(row => {
                    const magnet = row.match(/href=["'](magnet:[^"']+)["']/i)?.[1]?.replace(/&amp;/g, "&");
                    const name = row.match(/<td[^>]*><a[^>]*>([^<]+)/i)?.[1];
                    return normalizeResult({
                        title: name,
                        magnet,
                        size: "",
                        sizeBytes: 0,
                        seeders: 0
                    }, context, "UIndex");
                })
                .filter(Boolean);
        }, { maxQueries: 2 });

        const finalResults = dedupeResults(results).slice(0, CONFIG.RESULT_LIMIT_PER_ENGINE);
        console.log(`[UIndex] Trovati ${finalResults.length} risultati validi.`);
        return finalResults;
    } catch (error) {
        console.log(`[UIndex] Errore: ${error.message}`);
        return [];
    }
}

const ACTIVE_ENGINES = [
    { name: "Corsaro", fn: searchCorsaro, timeout: CONFIG.ENGINE_TIMEOUT },
    { name: "Knaben", fn: searchKnaben, timeout: CONFIG.ENGINE_TIMEOUT },
    { name: "TPB", fn: searchTPB, timeout: CONFIG.ENGINE_TIMEOUT },
    { name: "TPB Mirror", fn: searchTPBMirror, timeout: CONFIG.ENGINE_TIMEOUT },
    { name: "1337x", fn: search1337x, timeout: CONFIG.ENGINE_TIMEOUT + 2000 },
    { name: "BitSearch", fn: searchBitSearch, timeout: CONFIG.ENGINE_TIMEOUT },
    { name: "LimeTorrents", fn: searchLime, timeout: CONFIG.ENGINE_TIMEOUT },
    { name: "RARBG", fn: searchRARBG, timeout: CONFIG.ENGINE_TIMEOUT },
    { name: "UIndex", fn: searchUindex, timeout: CONFIG.ENGINE_TIMEOUT }
];

function buildSearchCacheKey(context) {
    return JSON.stringify({
        title: context.cleanTitle.toLowerCase(),
        year: context.year || "",
        type: context.normalizedType,
        reqSeason: context.reqSeason || 0,
        reqEpisode: context.reqEpisode || 0,
        langMode: context.langMode
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
    try {
        const { data } = await axios.get("https://ngosang.github.io/trackerslist/trackers_best.txt", {
            timeout: 4000,
            httpsAgent,
            headers: { "Accept-Language": getAcceptLanguage('all') }
        });
        const trackers = String(data || "")
            .split("\n")
            .map(line => line.trim())
            .filter(Boolean)
            .filter(line => /^udp:\/\/|^https?:\/\//i.test(line));

        if (trackers.length) {
            CONFIG.TRACKERS = [...new Set(trackers)].slice(0, 40);
            console.log(`[Trackers] Aggiornati correttamente. Totale tracker: ${CONFIG.TRACKERS.length}`);
            return CONFIG.TRACKERS;
        }
    } catch {
        console.log(`[Trackers] Impossibile aggiornare i tracker dal master list.`);
    }

    CONFIG.TRACKERS = [...DEFAULT_TRACKERS];
    return CONFIG.TRACKERS;
}

module.exports = {
    searchMagnet,
    updateTrackers,
    CONFIG,
    requestHtml,
    clean,
    parseSize,
    bytesToSize,
    isValidResult,
    checkYear,
    isCorrectFormat
};
