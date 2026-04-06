require('dotenv').config();
const crypto = require("crypto");
const Bottleneck = require("bottleneck");
const winston = require('winston');
const NodeCache = require("node-cache");
const ptt = require('parse-torrent-title'); 
const axios = require("axios");
const http = require("http");
const https = require("https");

const DEFAULT_HTTP_TIMEOUT = Math.max(parseInt(process.env.HTTP_TIMEOUT_MS || "10000", 10) || 10000, 1000);
const HTTP_AGENT = new http.Agent({ keepAlive: true, maxSockets: 128, maxFreeSockets: 32 });
const HTTPS_AGENT = new https.Agent({ keepAlive: true, maxSockets: 128, maxFreeSockets: 32 });

axios.defaults.timeout = DEFAULT_HTTP_TIMEOUT;
axios.defaults.httpAgent = HTTP_AGENT;
axios.defaults.httpsAgent = HTTPS_AGENT;

const logger = winston.createLogger({
  level: 'debug',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json()
  ),
  transports: [
    new winston.transports.File({ filename: 'error.log', level: 'error' }),
    new winston.transports.File({ filename: 'combined.log' }),
    new winston.transports.Console({ format: winston.format.simple() })
  ]
});

const myCache = new NodeCache({ stdTTL: 1800, checkperiod: 120, maxKeys: 5000 });
const rawCache = new NodeCache({ stdTTL: 43200, checkperiod: 600, maxKeys: 15000 });
const cloudBuildCache = new NodeCache({ stdTTL: 900, checkperiod: 60, maxKeys: 5000 });
const cloudBuildInflight = new Map();
const sharedFetchInflight = new Map();
const streamInflight = new Map();
const metadataInflight = new Map();
const parsedTitleCache = new NodeCache({ stdTTL: 3600, checkperiod: 300, maxKeys: 20000 });
const normalizedTextCache = new NodeCache({ stdTTL: 3600, checkperiod: 300, maxKeys: 20000 });
const languageInfoCache = new NodeCache({ stdTTL: 1800, checkperiod: 180, maxKeys: 20000 });
const streamCacheTags = new Map();
const streamCacheKeysByHash = new Map();
const streamCacheKeysByImdb = new Map();

const TRACKERS = Object.freeze([
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
]);

const runtimeMetrics = {
    startedAt: Date.now(),
    counters: Object.create(null),
    timers: Object.create(null),
    providers: Object.create(null),
    cache: {
        stream: { hit: 0, miss: 0, set: 0 },
        metadata: { hit: 0, miss: 0, set: 0 },
        lazy: { hit: 0, miss: 0, set: 0 },
        cloud: { hit: 0, miss: 0, set: 0 },
        raw: { hit: 0, miss: 0, set: 0 }
    }
};

function incrementMetric(name, value = 1) {
    runtimeMetrics.counters[name] = (runtimeMetrics.counters[name] || 0) + value;
}

function recordDuration(name, ms) {
    if (!Number.isFinite(ms) || ms < 0) return;
    const bucket = runtimeMetrics.timers[name] || { count: 0, totalMs: 0, minMs: Number.POSITIVE_INFINITY, maxMs: 0, avgMs: 0 };
    bucket.count += 1;
    bucket.totalMs += ms;
    bucket.minMs = Math.min(bucket.minMs, ms);
    bucket.maxMs = Math.max(bucket.maxMs, ms);
    bucket.avgMs = Math.round((bucket.totalMs / bucket.count) * 100) / 100;
    runtimeMetrics.timers[name] = bucket;
}

function recordProviderMetric(provider, ok, ms = null, extra = null) {
    const key = String(provider || 'unknown');
    const bucket = runtimeMetrics.providers[key] || { calls: 0, ok: 0, fail: 0, timeout: 0, totalMs: 0, avgMs: 0, lastError: null, lastSeenAt: null };
    bucket.calls += 1;
    if (ok) bucket.ok += 1;
    else bucket.fail += 1;
    if (Number.isFinite(ms) && ms >= 0) {
        bucket.totalMs += ms;
        bucket.avgMs = Math.round((bucket.totalMs / bucket.calls) * 100) / 100;
    }
    if (extra && extra.timeout) bucket.timeout += 1;
    if (extra && extra.error) bucket.lastError = String(extra.error).slice(0, 300);
    bucket.lastSeenAt = new Date().toISOString();
    runtimeMetrics.providers[key] = bucket;
}

function registerCacheAccess(section, hit) {
    const bucket = runtimeMetrics.cache[section];
    if (!bucket) return;
    if (hit) bucket.hit += 1;
    else bucket.miss += 1;
}

function registerCacheSet(section) {
    const bucket = runtimeMetrics.cache[section];
    if (!bucket) return;
    bucket.set += 1;
}

function getCacheSnapshot(bucket) {
    const hits = Number(bucket?.hit || 0);
    const misses = Number(bucket?.miss || 0);
    const total = hits + misses;
    return {
        hit: hits,
        miss: misses,
        set: Number(bucket?.set || 0),
        hitRate: total > 0 ? Math.round((hits / total) * 10000) / 100 : 0
    };
}

const EMPTY_FETCH_TTL = Math.max(parseInt(process.env.EMPTY_FETCH_TTL || "90", 10) || 90, 15);
const EMPTY_STREAM_TTL = Math.max(parseInt(process.env.EMPTY_STREAM_TTL || "60", 10) || 60, 15);
const METADATA_CACHE_TTL = Math.max(parseInt(process.env.METADATA_CACHE_TTL || "1800", 10) || 1800, 60);
const MAX_CONFIG_LENGTH = Math.max(parseInt(process.env.MAX_CONFIG_LENGTH || "16384", 10) || 16384, 2048);
const ADMIN_PASS = String(process.env.ADMIN_PASS || "").trim();

function safeCompare(secretA, secretB) {
    const a = Buffer.from(String(secretA || ""));
    const b = Buffer.from(String(secretB || ""));
    if (a.length === 0 || b.length === 0 || a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
}

async function withSharedPromise(map, key, factory) {
    if (map.has(key)) return map.get(key);
    const task = Promise.resolve().then(factory).finally(() => {
        map.delete(key);
    });
    map.set(key, task);
    return task;
}

function getStreamCacheStorageKey(key) {
    return `stream:${String(key || '').trim()}`;
}

function normalizeHashTag(hash) {
    const normalized = String(hash || '').trim().toUpperCase();
    return /^[A-F0-9]{40}$/.test(normalized) ? normalized : null;
}

function normalizeImdbTag(imdbId) {
    const normalized = String(imdbId || '').trim().toLowerCase();
    return /^tt\d+$/.test(normalized) ? normalized : null;
}

function addTaggedCacheKey(indexMap, tag, cacheKey) {
    if (!tag || !cacheKey) return;
    let keys = indexMap.get(tag);
    if (!keys) {
        keys = new Set();
        indexMap.set(tag, keys);
    }
    keys.add(cacheKey);
}

function removeTaggedCacheKey(indexMap, tag, cacheKey) {
    if (!tag || !cacheKey) return;
    const keys = indexMap.get(tag);
    if (!keys) return;
    keys.delete(cacheKey);
    if (keys.size === 0) indexMap.delete(tag);
}

function unregisterStreamCacheKey(cacheKey) {
    const normalizedKey = String(cacheKey || '').trim();
    if (!normalizedKey) return;
    const tags = streamCacheTags.get(normalizedKey);
    if (!tags) return;

    for (const hash of tags.hashes || []) {
        removeTaggedCacheKey(streamCacheKeysByHash, hash, normalizedKey);
    }
    if (tags.imdbId) removeTaggedCacheKey(streamCacheKeysByImdb, tags.imdbId, normalizedKey);
    streamCacheTags.delete(normalizedKey);
}

function registerStreamCacheKey(cacheKey, tags = {}) {
    const normalizedKey = String(cacheKey || '').trim();
    if (!normalizedKey) return;

    unregisterStreamCacheKey(normalizedKey);

    const uniqueHashes = [...new Set((Array.isArray(tags?.hashes) ? tags.hashes : [])
        .map(normalizeHashTag)
        .filter(Boolean))];
    const imdbId = normalizeImdbTag(tags?.imdbId);

    streamCacheTags.set(normalizedKey, { hashes: uniqueHashes, imdbId });
    for (const hash of uniqueHashes) addTaggedCacheKey(streamCacheKeysByHash, hash, normalizedKey);
    if (imdbId) addTaggedCacheKey(streamCacheKeysByImdb, imdbId, normalizedKey);
}

function deleteStreamCacheKey(cacheKey) {
    const normalizedKey = String(cacheKey || '').trim();
    if (!normalizedKey) return 0;
    unregisterStreamCacheKey(normalizedKey);
    return myCache.del(getStreamCacheStorageKey(normalizedKey));
}

function collectTaggedStreamKeys(indexMap, tags) {
    const keys = new Set();
    for (const tag of tags) {
        const bucket = indexMap.get(tag);
        if (!bucket) continue;
        for (const cacheKey of bucket) keys.add(cacheKey);
    }
    return keys;
}

const Cache = {
    getCachedMagnets: async (key) => { return myCache.get(`magnets:${key}`) || null; },
    cacheMagnets: async (key, value, ttl = 3600) => { myCache.set(`magnets:${key}`, value, ttl); },
    getCachedStream: async (key) => {
        const normalizedKey = String(key || '').trim();
        const data = myCache.get(getStreamCacheStorageKey(normalizedKey));
        registerCacheAccess('stream', !!data);
        if (data) logger.info(`⚡ CACHE HIT (USER): ${key}`);
        else unregisterStreamCacheKey(normalizedKey);
        return data || null;
    },
    cacheStream: async (key, value, ttl = 1800, tags = {}) => {
        const normalizedKey = String(key || '').trim();
        registerCacheSet('stream');
        registerStreamCacheKey(normalizedKey, tags);
        myCache.set(getStreamCacheStorageKey(normalizedKey), value, ttl);
    },
    getMetadata: async (key) => { const data = myCache.get(`meta:${key}`) || null; registerCacheAccess('metadata', !!data); return data; },
    cacheMetadata: async (key, value, ttl = METADATA_CACHE_TTL) => { registerCacheSet('metadata'); myCache.set(`meta:${key}`, value, ttl); },
    getLazyLink: async (key) => { const data = myCache.get(`lazy:${key}`) || null; registerCacheAccess('lazy', !!data); return data; },
    cacheLazyLink: async (key, value, ttl = 120) => { registerCacheSet('lazy'); myCache.set(`lazy:${key}`, value, ttl); },
    getCloudBuild: async (key) => { const data = cloudBuildCache.get(`cloud:${key}`) || null; registerCacheAccess('cloud', !!data); return data; },
    setCloudBuild: async (key, value, ttl = 900) => { registerCacheSet('cloud'); cloudBuildCache.set(`cloud:${key}`, value, ttl); },
    listKeys: async () => myCache.keys(),
    deleteKey: async (key) => {
        const normalizedKey = String(key || '').trim();
        if (normalizedKey.startsWith('stream:')) {
            return deleteStreamCacheKey(normalizedKey.slice('stream:'.length));
        }
        return myCache.del(normalizedKey);
    },
    flushAll: async () => {
        myCache.flushAll();
        rawCache.flushAll();
        cloudBuildCache.flushAll();
        sharedFetchInflight.clear();
        streamInflight.clear();
        metadataInflight.clear();
        streamCacheTags.clear();
        streamCacheKeysByHash.clear();
        streamCacheKeysByImdb.clear();
    },
    invalidateStreamsByHashes: async (hashes, reason = 'hash_update') => {
        const normalizedHashes = [...new Set((Array.isArray(hashes) ? hashes : [])
            .map(normalizeHashTag)
            .filter(Boolean))];
        if (normalizedHashes.length === 0) return { invalidated: 0, hashes: 0 };

        const keys = collectTaggedStreamKeys(streamCacheKeysByHash, normalizedHashes);
        let deleted = 0;
        for (const cacheKey of keys) deleted += deleteStreamCacheKey(cacheKey);

        if (keys.size > 0) {
            incrementMetric('cache.stream.invalidations');
            incrementMetric('cache.stream.invalidatedKeys', keys.size);
            logger.info(`[CACHE] Stream invalidation by hash | reason=${reason} | hashes=${normalizedHashes.length} | keys=${keys.size}`);
        }

        return { invalidated: keys.size, hashes: normalizedHashes.length, deleted };
    },
    invalidateStreamsByImdb: async (imdbId, reason = 'imdb_update') => {
        const normalizedImdb = normalizeImdbTag(imdbId);
        if (!normalizedImdb) return { invalidated: 0, imdbId: null };

        const keys = collectTaggedStreamKeys(streamCacheKeysByImdb, [normalizedImdb]);
        let deleted = 0;
        for (const cacheKey of keys) deleted += deleteStreamCacheKey(cacheKey);

        if (keys.size > 0) {
            incrementMetric('cache.stream.invalidations');
            incrementMetric('cache.stream.invalidatedKeys', keys.size);
            logger.info(`[CACHE] Stream invalidation by imdb | reason=${reason} | imdb=${normalizedImdb} | keys=${keys.size}`);
        }

        return { invalidated: keys.size, imdbId: normalizedImdb, deleted };
    },
    getStreamCacheIndexStats: () => ({
        trackedKeys: streamCacheTags.size,
        hashBuckets: streamCacheKeysByHash.size,
        imdbBuckets: streamCacheKeysByImdb.size,
        cachedEntries: myCache.keys().filter((key) => String(key).startsWith('stream:')).length
    }),

    getRaw: (provider, id) => {
        const data = rawCache.get(`raw:${provider}:${id}`);
        registerCacheAccess('raw', !!data);
        if (data) logger.info(`🌍 GLOBAL CACHE HIT [${provider}]: ${id}`);
        return data || null;
    },
    setRaw: (provider, id, value, ttl = 43200) => {
        registerCacheSet('raw');
        rawCache.set(`raw:${provider}:${id}`, value, ttl);
        logger.info(`💾 GLOBAL CACHE SET [${provider}]: ${id}`);
    },

    fetchWithCache: async (provider, id, ttl, fetcherFunc) => {
        const cached = Cache.getRaw(provider, id);
        if (cached !== null) return cached;

        const inflightKey = `${provider}:${id}`;
        return withSharedPromise(sharedFetchInflight, inflightKey, async () => {
            const secondCacheHit = Cache.getRaw(provider, id);
            if (secondCacheHit !== null) return secondCacheHit;

            try {
                const freshData = await fetcherFunc();
                const normalized = Array.isArray(freshData) ? freshData : (freshData ? [freshData] : []);
                Cache.setRaw(provider, id, normalized, normalized.length > 0 ? ttl : EMPTY_FETCH_TTL);
                return normalized;
            } catch (error) {
                logger.warn(`⚠️ Errore Fetching [${provider}] per ${id}: ${error.message}`);
                Cache.setRaw(provider, id, [], EMPTY_FETCH_TTL);
                return [];
            }
        });
    }
};

const CONFIG = {
  INDEXER_URL: process.env.INDEXER_URL || "", 
  CINEMETA_URL: "https://v3-cinemeta.strem.io",
  KITSU_URL: "https://anime-kitsu.strem.fun", 
  REAL_SIZE_FILTER: 80 * 1024 * 1024,
  MAX_RESULTS: 70,
  TIMEOUTS: {
    TMDB: 2000,
    SCRAPER: 4000,          
    REMOTE_INDEXER: 1500,   
    LOCAL_DB: 1500, 
    DB_QUERY: 2000,         
    DEBRID: 8000,           
    PACK_RESOLVER: 3000,    
    EXTERNAL: 8000          
  }
};


function buildTrackerMagnet(hash, displayName = null) {
    const cleanHash = String(hash || '').toUpperCase().trim();
    const params = [`xt=urn:btih:${cleanHash}`];
    const dn = String(displayName || '').trim();
    if (dn) params.push(`dn=${encodeURIComponent(dn)}`);
    for (const tracker of TRACKERS) params.push(`tr=${encodeURIComponent(tracker)}`);
    return `magnet:?${params.join('&')}`;
}

const REGEX_YEAR = /(19|20)\d{2}/;
const REGEX_QUALITY_FILTER = {
    "4K": /\b(?:2160p|4k|uhd|ultra[-.\s]?hd|2160i)\b/i,
    "1080p": /\b(?:1080p|1080i|fhd|full[-.\s]?hd|blu[-.\s]?ray|bd[-.\s]?rip)\b/i,
    "720p": /\b(?:720p|720i|hd[-.\s]?rip|hd)\b/i,
    "SD": /\b(?:480p|576p|sd|dvd|dvd[-.\s]?rip|dvd[-.\s]?scr|cd)\b/i
};

const REGEX_STRONG_ITA = /\b(ITA|ITALIAN|ITALIANO)\b/i;
const REGEX_CONTEXT_IT = /\b(AUDIO|LINGUA|LANG|VO|AC-?3|AAC|MP3|DDP|DTS|TRUEHD)\W+(IT)\b/i;
const REGEX_ISOLATED_IT = /(?:^|[_\-.])(IT)(?:$|[_\-.])/;
const REGEX_MULTI_ITA = /\b(MULTI|DUAL|TRIPLE).*(ITA|ITALIAN)\b/i;
const REGEX_TRUSTED_GROUPS = /\b(iDN_CreW|CORSARO|MUX|WMS|TRIDIM|SPEEDVIDEO|EAGLE|TRL|MEA|LUX|DNA|LEST|GHIZZO|USAbit|Bric|Dtone|Gaiage|BlackBit|Pantry|Vics|Papeete|Lidri|MirCrew)\b/i;
const REGEX_FALSE_IT = /\b(10BIT|BIT|WIT|HIT|FIT|KIT|SIT|LIT|PIT)\b/i;
const REGEX_SUB_ONLY = /\b(SUB|SUBS|SUBBED|SOTTOTITOLI|VOST|VOSTIT)\s*[:.\-_]?\s*(ITA|IT|ITALIAN)\b/i;
const REGEX_AUDIO_CONFIRM = /\b(AUDIO|AC3|AAC|DTS|MD|LD|DDP|MP3|LINGUA)[\s.\-_]+(ITA|IT)\b/i;

const languageMapping = {
  'english': '🇬🇧 ENG',
  'japanese': '🇯🇵 JPN',
  'italian': '🇮🇹 ITA',
  'french': '🇫🇷 FRA',
  'german': '🇩🇪 GER',
  'spanish': '🇪🇸 ESP',
  'russian': '🇷🇺 RUS',
  'multi audio': '🌍 MULTI'
};

function normalizeLanguageName(lang) {
    const value = String(lang || '').trim().toLowerCase();
    if (!value) return null;
    const aliasMap = {
        'ita': 'Italian', 'it': 'Italian', 'italian': 'Italian', 'italiano': 'Italian',
        'eng': 'English', 'en': 'English', 'english': 'English',
        'jpn': 'Japanese', 'jp': 'Japanese', 'ja': 'Japanese', 'japanese': 'Japanese',
        'fra': 'French', 'fre': 'French', 'fr': 'French', 'french': 'French',
        'ger': 'German', 'deu': 'German', 'de': 'German', 'german': 'German',
        'esp': 'Spanish', 'spa': 'Spanish', 'es': 'Spanish', 'spanish': 'Spanish',
        'rus': 'Russian', 'ru': 'Russian', 'russian': 'Russian',
        'multi': 'Multi', 'multi audio': 'Multi', 'dual audio': 'Dual Audio', 'dual': 'Dual Audio'
    };
    return aliasMap[value] || (value.charAt(0).toUpperCase() + value.slice(1));
}

function parseTitleDetails(filename) {
    if (!filename) return { quality: 'SD', tags: '', languages: [], rawLanguages: [], cleanTitle: '' };
    const cacheKey = String(filename);
    const cached = parsedTitleCache.get(cacheKey);
    if (cached) return cached;

    let result;
    try {
        const info = ptt.parse(cacheKey);
        const codec = info.codec ? info.codec.toUpperCase() : '';
        const audio = info.audio ? info.audio.toUpperCase() : '';
        const source = info.source ? info.source.toUpperCase() : '';

        const rawLanguages = Array.isArray(info.languages)
            ? Array.from(new Set(info.languages.map(normalizeLanguageName).filter(Boolean)))
            : [];

        const displayLanguages = rawLanguages.map(l => languageMapping[l.toLowerCase()] || l.substring(0, 3).toUpperCase());

        result = {
            quality: info.resolution || 'SD',
            tags: [source, codec, audio].filter(Boolean).join(' '),
            languages: displayLanguages,
            rawLanguages,
            cleanTitle: info.title || ''
        };
    } catch (e) {
        result = { quality: 'SD', tags: '', languages: [], rawLanguages: [], cleanTitle: '' };
    }

    parsedTitleCache.set(cacheKey, result);
    return result;
}

function stripVisualPrefixes(str) {
    if (!str) return '';
    return String(str).replace(/^[^a-zA-Z0-9]+/, '').replace(/[\u{1F300}-\u{1FAFF}]|[\u{2600}-\u{26FF}]|[\u{2700}-\u{27BF}]/gu, '').trim();
}

function normalizeSearchText(value) {
    const cacheKey = String(value || '');
    const cached = normalizedTextCache.get(cacheKey);
    if (cached !== undefined) return cached;
    const normalized = cacheKey.toLowerCase().replace(/[^\p{L}\p{N}\s.-]/gu, ' ').replace(/[\._\-]+/g, ' ').replace(/\s+/g, ' ').trim();
    normalizedTextCache.set(cacheKey, normalized);
    return normalized;
}

function isItalianByTitleMatch(title, italianMovieTitle = null) {
    if (!title || !italianMovieTitle) return false;
    const normalizedTorrentTitle = normalizeSearchText(title);
    const italianWords = normalizeSearchText(italianMovieTitle).split(' ')
        .filter(word => word.length > 2)
        .filter(word => !['del', 'al', 'dal', 'nel', 'sul', 'un', 'il', 'lo', 'la', 'gli', 'le', 'con', 'per', 'che', 'non'].includes(word));

    if (italianWords.length === 0) return false;
    const matchingWords = italianWords.filter(word => normalizedTorrentTitle.includes(word));
    return (matchingWords.length / italianWords.length) > 0.6;
}

function isTrustedSource(source, provider = null) {
    const stripPrefix = (str) => stripVisualPrefixes(str || '').toLowerCase();
    const s = stripPrefix(source);
    const p = stripPrefix(provider);

    if (/\bcustom\b/i.test(s) || /\bcustom\b/i.test(p)) return true;
    if (/corsaro/i.test(s) || /corsaro/i.test(p)) return true;

    const mainSource = s.split('(')[0].trim();
    const mainProvider = p.split('(')[0].trim();

    if (/^torrentio$/i.test(mainSource) || /^torrentio$/i.test(mainProvider)) return true;
    return false;
}

function getLanguageInfo(title, italianMovieTitle = null, source = null, parsedInfo = null) {
    if (!title) return { icon: '', isItalian: false, isMaybeItalian: false, isMulti: false, displayLabel: '', detectedLanguages: [], confidence: 0 };

    const cacheKey = `${String(title)}|${String(italianMovieTitle || '')}|${String(source || '')}`;
    const cached = languageInfoCache.get(cacheKey);
    if (cached) return cached;

    const detectedLanguages = [];
    const pushLanguage = (lang) => {
        const normalized = normalizeLanguageName(lang);
        if (normalized && !detectedLanguages.includes(normalized)) detectedLanguages.push(normalized);
    };

    if (parsedInfo?.rawLanguages?.length > 0) {
        parsedInfo.rawLanguages.forEach(pushLanguage);
    } else {
        if (/(ita|italian|italiano)/i.test(title)) pushLanguage('Italian');
        if (/(eng|english)/i.test(title) && !/(eng|english)[.\s\-_]?sub/i.test(title)) pushLanguage('English');
        if (/(multi)/i.test(title) && !/(multi)[.\s\-_]?sub/i.test(title)) pushLanguage('Multi');
        if (/(dual)/i.test(title) && !/(dual)[.\s\-_]?sub/i.test(title)) pushLanguage('Dual Audio');
        if (/(jpn|japanese)/i.test(title)) pushLanguage('Japanese');
        if (/(fra|french)/i.test(title)) pushLanguage('French');
        if (/(ger|german)/i.test(title)) pushLanguage('German');
        if (/(esp|spanish)/i.test(title)) pushLanguage('Spanish');
    }

    const subOnly = REGEX_SUB_ONLY.test(title);
    const explicitIta = /(ita|italian|italiano)/i.test(title);
    const audioConfirmedIta = REGEX_AUDIO_CONFIRM.test(title) || REGEX_CONTEXT_IT.test(title) || /(?:dub(?:bed)?|audio|lang|lingua|doppiat[oa])(?:[\s.\-_:/-]+)(?:it|ita|italian|italiano)/i.test(title);
    const multiIta = REGEX_MULTI_ITA.test(title);
    const isolatedIt = REGEX_ISOLATED_IT.test(title) && !REGEX_FALSE_IT.test(title);
    const trustedGroup = REGEX_TRUSTED_GROUPS.test(title);
    const titleMatched = italianMovieTitle ? isItalianByTitleMatch(title, italianMovieTitle) : false;
    const trustedSource = !!(source && isTrustedSource(source, null));

    let hasIta = detectedLanguages.includes('Italian');
    const hasEng = detectedLanguages.includes('English');
    const hasMulti = detectedLanguages.includes('Multi') || detectedLanguages.includes('Dual Audio');

    let confidence = 0;
    if (hasIta) confidence = Math.max(confidence, subOnly ? 4 : 9);
    if (explicitIta) confidence = Math.max(confidence, subOnly ? 4 : 8);
    if (audioConfirmedIta) confidence = Math.max(confidence, 9);
    if (multiIta) confidence = Math.max(confidence, 7);
    if (trustedGroup) confidence = Math.max(confidence, subOnly ? 4 : 6);
    if (isolatedIt) confidence = Math.max(confidence, 4);
    if (titleMatched) confidence = Math.max(confidence, 5);
    if (trustedSource) confidence = Math.max(confidence, 5);
    if (hasMulti && (explicitIta || audioConfirmedIta || trustedGroup || trustedSource || titleMatched)) confidence = Math.max(confidence, 7);

    if (subOnly && !audioConfirmedIta && !multiIta && !trustedGroup && !trustedSource && !titleMatched) confidence = Math.min(confidence, 2);

    hasIta = confidence >= 5;
    const isMaybeItalian = confidence >= 3;

    let result;
    if (hasIta && hasEng) result = { icon: '🇮🇹 🇬🇧', isItalian: true, isMaybeItalian, isMulti: true, displayLabel: '🇮🇹 🇬🇧', detectedLanguages, confidence };
    else if (hasIta) result = { icon: '🇮🇹', isItalian: true, isMaybeItalian, isMulti: hasMulti, displayLabel: '🇮🇹', detectedLanguages, confidence };
    else if (hasMulti && isMaybeItalian) result = { icon: '🇮🇹 🌈', isItalian: false, isMaybeItalian: true, isMulti: true, displayLabel: '🇮🇹 🌈', detectedLanguages, confidence };
    else if (hasMulti) result = { icon: '🌈', isItalian: false, isMaybeItalian, isMulti: true, displayLabel: '🌈 MULTI', detectedLanguages, confidence };
    else if (hasEng) result = { icon: '🇬🇧', isItalian: false, isMaybeItalian, isMulti: false, displayLabel: '🇬🇧', detectedLanguages, confidence };
    else if (detectedLanguages.length > 0) result = { icon: '🌐', isItalian: false, isMaybeItalian, isMulti: false, displayLabel: '🌐', detectedLanguages, confidence };
    else result = { icon: '', isItalian: false, isMaybeItalian, isMulti: false, displayLabel: '', detectedLanguages, confidence };

    languageInfoCache.set(cacheKey, result);
    return result;
}

function formatLanguageLabel(languageInfo, fallbackLanguages = []) {
    if (languageInfo?.isItalian && languageInfo?.isMulti) return '🇮🇹/🌍 MULTI';
    if (languageInfo?.isItalian) return '🇮🇹 ITA';
    if (languageInfo?.isMulti) return '🌍 MULTI';
    if (languageInfo?.displayLabel === '🇬🇧') return '🇬🇧 ENG';
    if (languageInfo?.displayLabel) return languageInfo.displayLabel;
    return (fallbackLanguages && fallbackLanguages.length > 0) ? fallbackLanguages.join('/') : '🇬🇧/Unknown';
}

function isSeasonPack(title) {
    if (!title) return false;
    const lowerTitle = String(title).toLowerCase();
    if (/s\d{1,2}e\d{1,2}/i.test(lowerTitle)) return false;

    const packPatterns = [
        /stagion[ei]\s*\d+\s*[-–—]\s*\d+/i, /season\s*\d+\s*[-–—]\s*\d+/i, /s\d+\s*[-–—]\s*s?\d+/i,
        /completa/i, /complete/i, /integrale/i, /collection/i, /\bpack\b/i,
        /stagion[ei]\s*\d+/i, /season\s*\d+/i, /\.s\d{1,2}\./i, /\.s\d{1,2}$/i,
        /\bs\d{1,2}(?!e)\b/i, /\bs\d{1,2}\./i, /\btutta\b/i
    ];
    return packPatterns.some(pattern => pattern.test(lowerTitle));
}

function isGoodShortQueryMatch(torrentTitle, searchQuery) {
    const cleanedSearchQuery = normalizeSearchText(searchQuery).replace(/\s\(\d{4}\)$/, '').trim();
    if (cleanedSearchQuery.length > 8 || cleanedSearchQuery.length < 2) return true;
    const normalizedTorrentTitle = normalizeSearchText(torrentTitle);
    const searchWords = new Set(cleanedSearchQuery.split(' ').filter(Boolean));
    for (const word of searchWords) {
        const wordRegex = new RegExp(`\\b${word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
        if (!wordRegex.test(normalizedTorrentTitle)) return false;
    }
    return true;
}

function chooseBestPackTitle(item, resolvedPackName = null, siblingStreams = []) {
    const sameHashStreams = siblingStreams.filter(stream => (stream.hash || stream.infoHash || '').toLowerCase() === (item.hash || item.infoHash || '').toLowerCase());
    const torrentioStream = sameHashStreams.find(stream => (stream.source || stream.name || '').includes('Torrentio') && String(stream.title || '').includes('📁'));
    if (torrentioStream) {
        const clean = stripVisualPrefixes(String(torrentioStream.title || '').split('\n')[0] || '');
        if (clean && clean.length > 5) return { title: clean, source: 'Torrentio' };
    }
    const mediafusionStream = sameHashStreams.find(stream => (stream.source || stream.name || '').includes('MediaFusion') && String(stream.title || '').includes('┈➤'));
    if (mediafusionStream) {
        const clean = stripVisualPrefixes(String(mediafusionStream.title || '').split('┈➤')[0].replace('📂', '').trim());
        if (clean && clean.length > 5) return { title: clean, source: 'MediaFusion' };
    }
    const scraperTitle = stripVisualPrefixes(item.title || '');
    if (scraperTitle && scraperTitle.length > 5 && !/^Season \d+$/i.test(scraperTitle) && !/^Stagione \d+$/i.test(scraperTitle)) return { title: scraperTitle, source: 'Scraper' };
    if (resolvedPackName && resolvedPackName.length > 5) return { title: stripVisualPrefixes(resolvedPackName), source: 'Debrid' };
    return { title: scraperTitle || stripVisualPrefixes(resolvedPackName) || item.title || 'Unknown Pack', source: 'Fallback' };
}

function shouldUpdatePackTitle(currentTitle, nextTitle) {
    const curr = stripVisualPrefixes(currentTitle || '').toLowerCase();
    const next = stripVisualPrefixes(nextTitle || '').toLowerCase();
    if (!next || curr === next) return !!currentTitle && currentTitle !== nextTitle;
    if (!/ita|multi/.test(next)) return false;
    if (!/ita|multi/.test(curr)) return true;
    const hasSeasonInfo = /s\d+|season|stagion|complete|episod/i.test(curr);
    const isGenericRd = /^[\w\s]+\s*\[\d{4}[-–]\d{4}\]$/.test(stripVisualPrefixes(currentTitle || ''));
    if (hasSeasonInfo && !isGenericRd) return false;
    return true;
}

function base32ToHex(base32) {
    const base32chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
    let bits = "", hex = "";
    for (let i = 0; i < base32.length; i++) bits += base32chars.indexOf(base32.charAt(i).toUpperCase()).toString(2).padStart(5, '0');
    for (let i = 0; i + 4 <= bits.length; i += 4) hex += parseInt(bits.substr(i, 4), 2).toString(16);
    return hex;
}

function extractInfoHash(magnet) {
    if (!magnet) return null;
    const match = magnet.match(/btih:([A-Fa-f0-9]{40}|[A-Za-z2-7]{32})/i);
    if (!match) return null;
    const hash = match[1];
    return hash.length === 32 ? base32ToHex(hash).toUpperCase() : hash.toUpperCase();
}

function estimateVisualSize(knownSize, title, isSeries, isPack, infoHash) {
    const safeTitle = (title || "video").toLowerCase();
    const is4K = /2160p|4k|uhd|ultra[-.\s]?hd/i.test(safeTitle);
    const is1080 = /1080p|1080i|fhd|full[-.\s]?hd|blu[-.\s]?ray/i.test(safeTitle);
    const is720 = /720p|720i|hd[-.\s]?rip|hd/i.test(safeTitle);

    if (knownSize && knownSize > 0) {
        let isSane = true;
        const sizeInGB = knownSize / (1024 * 1024 * 1024);
        if (!isPack) {
            if (isSeries) {
                if (is4K && sizeInGB > 15) isSane = false;
                else if (is1080 && sizeInGB > 6) isSane = false;
                else if (is720 && sizeInGB > 3) isSane = false;
                else if (!is4K && !is1080 && !is720 && sizeInGB > 1.5) isSane = false;
            } else {
                if (is4K && sizeInGB > 100) isSane = false; 
                else if (is1080 && sizeInGB > 40) isSane = false; 
                else if (is720 && sizeInGB > 12) isSane = false;
                else if (!is4K && !is1080 && !is720 && sizeInGB > 5) isSane = false;
            }
        }
        if (isSane) return knownSize;
    }

    let seedStr = infoHash || safeTitle;
    let hashVal = 0;
    for (let i = 0; i < seedStr.length; i++) hashVal = (Math.imul(31, hashVal) + seedStr.charCodeAt(i)) | 0;
    hashVal = Math.abs(hashVal);

    const seededRandom = () => {
        hashVal = (Math.imul(1664525, hashVal) + 1013904223) | 0;
        return (Math.abs(hashVal) % 100000) / 100000;
    };

    let baseSize = 0;
    if (isSeries) {
        if (is4K) baseSize = 1.8 * 1024**3 + (seededRandom() * 4.7 * 1024**3);
        else if (is1080) baseSize = 800 * 1024**2 + (seededRandom() * 2.4 * 1024**3);
        else if (is720) baseSize = 300 * 1024**2 + (seededRandom() * 900 * 1024**2);
        else baseSize = 150 * 1024**2 + (seededRandom() * 450 * 1024**2);
    } else {
        if (is4K) baseSize = 12 * 1024**3 + (seededRandom() * 53 * 1024**3);
        else if (is1080) baseSize = 1.8 * 1024**3 + (seededRandom() * 12.2 * 1024**3);
        else if (is720) baseSize = 800 * 1024**2 + (seededRandom() * 3.2 * 1024**3);
        else baseSize = 700 * 1024**2 + (seededRandom() * 1.1 * 1024**3);
    }
    return Math.floor(baseSize + Math.floor(seededRandom() * 1024 * 1024 * 5));
}

function estimateSeeders(knownSeeders, infoHash) {
    if (knownSeeders && knownSeeders > 0) return knownSeeders;
    let seedStr = infoHash || "seeders_fallback", hashVal = 0;
    for (let i = 0; i < seedStr.length; i++) hashVal = (Math.imul(31, hashVal) + seedStr.charCodeAt(i)) | 0;
    return (Math.abs(hashVal) % 60) + 8;
}

const LIMITERS = {
  scraper: new Bottleneck({ maxConcurrent: 40, minTime: 10 }),
  remoteIndexer: new Bottleneck({ maxConcurrent: 8, minTime: 25 }),
  externalAddons: new Bottleneck({ maxConcurrent: 10, minTime: 20 }),
  metadata: new Bottleneck({ maxConcurrent: 6, minTime: 50 }),
  rdResolve: new Bottleneck({ maxConcurrent: 15, minTime: 180 }),
  adResolve: new Bottleneck({ maxConcurrent: 10, minTime: 220 }),
  tbResolve: new Bottleneck({ maxConcurrent: 8, minTime: 250 }),
  lazyPlay: new Bottleneck({ maxConcurrent: 20, minTime: 30 }),
  lazyWarmup: new Bottleneck({ maxConcurrent: 3, minTime: 350 }),
  cloudBuild: new Bottleneck({ maxConcurrent: 4, minTime: 250 }),
  webVix: new Bottleneck({ maxConcurrent: 6, minTime: 25 }),
  webGhd: new Bottleneck({ maxConcurrent: 4, minTime: 40 }),
  webGs: new Bottleneck({ maxConcurrent: 4, minTime: 40 }),
  webAw: new Bottleneck({ maxConcurrent: 4, minTime: 40 }),
  webGf: new Bottleneck({ maxConcurrent: 4, minTime: 40 }),
  packResolver: new Bottleneck({ maxConcurrent: 1, minTime: 2000 }),
  bgPackJobs: new Bottleneck({ maxConcurrent: 2, minTime: 25 }),
};
LIMITERS.rd = LIMITERS.rdResolve;
LIMITERS.ad = LIMITERS.adResolve;
LIMITERS.tb = LIMITERS.tbResolve;


function getLimiterStats() {
    const stats = {};
    for (const [name, limiter] of Object.entries(LIMITERS || {})) {
        if (!limiter || typeof limiter.counts !== 'function') continue;
        try { stats[name] = limiter.counts(); } catch (_) {}
    }
    return stats;
}

function getStatsSnapshot() {
    return {
        status: 'ok',
        startedAt: new Date(runtimeMetrics.startedAt).toISOString(),
        uptimeSec: Math.round((Date.now() - runtimeMetrics.startedAt) / 1000),
        inflight: {
            sharedFetch: sharedFetchInflight.size,
            streams: streamInflight.size,
            metadata: metadataInflight.size,
            cloudBuild: cloudBuildInflight.size
        },
        cache: {
            stream: getCacheSnapshot(runtimeMetrics.cache.stream),
            metadata: getCacheSnapshot(runtimeMetrics.cache.metadata),
            lazy: getCacheSnapshot(runtimeMetrics.cache.lazy),
            cloud: getCacheSnapshot(runtimeMetrics.cache.cloud),
            raw: getCacheSnapshot(runtimeMetrics.cache.raw),
            streamIndex: Cache.getStreamCacheIndexStats(),
            keys: {
                user: myCache.keys().length,
                raw: rawCache.keys().length,
                cloud: cloudBuildCache.keys().length
            }
        },
        counters: runtimeMetrics.counters,
        timers: runtimeMetrics.timers,
        providers: runtimeMetrics.providers,
        limiters: getLimiterStats()
    };
}

function extractSeasonEpisodeFromFilename(filename, defaultSeason = 1) {
    const name = String(filename || '');
    let match = name.match(/\bS(\d{1,2})E(\d{1,3})\b/i);
    if (match) return { season: parseInt(match[1], 10), episode: parseInt(match[2], 10) };
    match = name.match(/\b(\d{1,2})x(\d{1,3})\b/i);
    if (match) return { season: parseInt(match[1], 10), episode: parseInt(match[2], 10) };
    match = name.match(/\bE(?:P(?:ISODE)?)?\s*0?(\d{1,3})\b/i);
    if (match) return { season: defaultSeason, episode: parseInt(match[1], 10) };
    return null;
}

function parseSize(sizeText) {
  if (!sizeText) return 0;
  if (typeof sizeText === 'number') return sizeText;
  const str = sizeText.toString();
  let scale = 1;
  if (str.match(/TB/i)) scale = 1024 * 1024 * 1024 * 1024;
  else if (str.match(/GB/i)) scale = 1024 * 1024 * 1024;
  else if (str.match(/MB/i)) scale = 1024 * 1024;
  else if (str.match(/KB/i) || str.match(/kB/i)) scale = 1024;
  else if (str.match(/B/i) && !str.match(/GB|MB|KB|TB/i)) scale = 1;
  const cleanStr = str.replace(/,/g, '.').replace(/[^\d.]/g, '');
  const num = parseFloat(cleanStr);
  return isNaN(num) ? 0 : Math.floor(num * scale);
}

function extractSeeders(title) {
  const seedersMatch = title.match(/(?:👤|👥)\s*(\d+)/);
  return seedersMatch && parseInt(seedersMatch[1]) || 0;
}

function extractSize(title) {
  const sizeMatch = title.match(/(?:💾|🧲|📦)\s*([\d.,]+\s*\w+)/i);
  return sizeMatch && parseSize(sizeMatch[1]) || 0;
}

function extractProvider(title) {
  const match = title.match(/\[([A-Z]{2,3})\]/);
  return match?.[1] || "P2P";
}

function getKnownCacheBoolean(item) {
  if (item?._dbCachedRd === true || item?._dbCachedRd === false) return item._dbCachedRd;
  if (item?.cached_rd === true || item?.cached_rd === false) return Boolean(item.cached_rd);
  return undefined;
}

function getKnownCacheState(item) {
  const rawState = typeof item?._rdCacheState === 'string'
    ? item._rdCacheState
    : (typeof item?.rdCacheState === 'string' ? item.rdCacheState : '');
  const normalizedState = rawState.trim().toLowerCase();
  if (normalizedState === 'cached' || normalizedState === 'uncached' || normalizedState === 'unknown' || normalizedState === 'probing') {
    return normalizedState;
  }

  const booleanState = getKnownCacheBoolean(item);
  if (booleanState === true) return 'cached';
  if (booleanState === false) return 'uncached';
  return undefined;
}

function mergeDuplicateSignals(preferredItem, alternateItem) {
  const merged = { ...preferredItem };

  const mergedCacheState = getKnownCacheState(preferredItem) || getKnownCacheState(alternateItem);
  if (mergedCacheState) {
    merged._rdCacheState = mergedCacheState;
    merged.rdCacheState = mergedCacheState;
    if (mergedCacheState === 'cached' || mergedCacheState === 'uncached') {
      const cacheBool = mergedCacheState === 'cached';
      merged._dbCachedRd = cacheBool;
      merged.cached_rd = cacheBool;
    }
  }

  if (!merged._dbLastCachedCheck && alternateItem?._dbLastCachedCheck) merged._dbLastCachedCheck = alternateItem._dbLastCachedCheck;
  if (!merged._dbNextCachedCheck && alternateItem?._dbNextCachedCheck) merged._dbNextCachedCheck = alternateItem._dbNextCachedCheck;
  if ((merged._dbFailures === undefined || merged._dbFailures === null) && alternateItem?._dbFailures !== undefined && alternateItem?._dbFailures !== null) {
    merged._dbFailures = alternateItem._dbFailures;
  }

  if ((merged.fileIdx === undefined || merged.fileIdx === null) && alternateItem?.fileIdx !== undefined && alternateItem?.fileIdx !== null) {
    merged.fileIdx = alternateItem.fileIdx;
  }
  if ((!merged._size || merged._size <= 0) && (alternateItem?._size > 0 || alternateItem?.sizeBytes > 0)) {
    merged._size = alternateItem._size || alternateItem.sizeBytes;
  }
  if ((!merged.sizeBytes || merged.sizeBytes <= 0) && (alternateItem?.sizeBytes > 0 || alternateItem?._size > 0)) {
    merged.sizeBytes = alternateItem.sizeBytes || alternateItem._size;
  }
  if (!merged._tbCached && alternateItem?._tbCached) merged._tbCached = true;
  if (!merged._isPack && alternateItem?._isPack) merged._isPack = true;

  return merged;
}


function deduplicateResults(results) {
  const grouped = new Map();

  const normalizeFileIdxValue = (value) => {
    if (value === undefined || value === null || value === '') return null;
    const parsed = parseInt(value, 10);
    return Number.isInteger(parsed) && parsed >= 0 ? parsed : null;
  };

  const getEpisodeContext = (item) => {
    const directSeason = parseInt(item?.season, 10);
    const directEpisode = parseInt(item?.episode, 10);
    if (Number.isInteger(directSeason) && Number.isInteger(directEpisode) && directEpisode > 0) {
      return { season: directSeason, episode: directEpisode };
    }
    return extractSeasonEpisodeFromFilename(item?.title || '', 1);
  };

  const getResolutionScore = (title) => {
    const t = String(title || '').toLowerCase();
    if (REGEX_QUALITY_FILTER["4K"].test(t)) return 4000;
    if (REGEX_QUALITY_FILTER["1080p"].test(t)) return 3000;
    if (REGEX_QUALITY_FILTER["720p"].test(t)) return 2000;
    return 1000;
  };

  const buildDedupeKey = (hash, item) => {
    const fileIdx = normalizeFileIdxValue(item?.fileIdx);
    if (fileIdx !== null) return `${hash}:${fileIdx}`;
    const ep = getEpisodeContext(item);
    if (ep && Number.isInteger(ep.season) && Number.isInteger(ep.episode)) return `${hash}:s${ep.season}e${ep.episode}`;
    if (item?._isPack || isSeasonPack(item?.title)) return `${hash}:pack`;
    return `${hash}:base`;
  };

  const scoreResult = (item) => {
    const title = item?.title || '';
    const source = item?.source || item?.provider || null;
    const parsed = parseTitleDetails(title);
    const langInfo = getLanguageInfo(title, null, source, parsed);
    const sizeBytes = parseSize(item._size || item.sizeBytes || item.size);
    const seeders = parseInt(item.seeders, 10) || 0;
    const fileIdx = normalizeFileIdxValue(item.fileIdx);
    const episodeContext = getEpisodeContext(item);
    const providerTrusted = source && isTrustedSource(source, null);

    let score = 0;
    if (langInfo.isItalian) score += 100000;
    else if (langInfo.isMaybeItalian) score += 35000;
    if (langInfo.isMulti) score += 7000;
    if (REGEX_AUDIO_CONFIRM.test(title)) score += 18000;
    if (REGEX_STRONG_ITA.test(title)) score += 12000;
    if (REGEX_MULTI_ITA.test(title)) score += 9000;
    if (REGEX_TRUSTED_GROUPS.test(title)) score += 8000;
    if (providerTrusted) score += 6000;
    if (fileIdx !== null) score += 4500;
    if (episodeContext) score += 2800;
    if (item._isPack || isSeasonPack(title)) score += 1800;
    if (/(web[-.\s]?dl|blu[-.\s]?ray|remux|uhd|hevc|x265|x264|ddp|truehd|dts)/i.test(title)) score += 2200;
    if (/cam|hdcam|ts|telesync|screener|scr/i.test(title)) score -= 12000;
    if (langInfo.isSubOnly) score -= 14000;
    score += getResolutionScore(title);
    score += Math.min(seeders, 500) * 12;
    score += Math.min(Math.floor(sizeBytes / (512 * 1024 * 1024)), 800);
    score += Math.min(title.length, 400);
    return score;
  };

  for (const item of results) {
    if (!item?.magnet) continue;
    const rawHash = item.infoHash || item.hash || extractInfoHash(item.magnet);
    const finalHash = rawHash ? rawHash.toUpperCase() : null;
    if (!finalHash || finalHash.length !== 40) continue;

    item.hash = finalHash;
    item.infoHash = finalHash;
    item.fileIdx = normalizeFileIdxValue(item.fileIdx);
    item._size = parseSize(item._size || item.sizeBytes || item.size);
    item.seeders = parseInt(item.seeders, 10) || 0;
    item._dedupeScore = scoreResult(item);

    const dedupeKey = buildDedupeKey(finalHash, item);
    const existing = grouped.get(dedupeKey);
    if (!existing) {
      grouped.set(dedupeKey, item);
      continue;
    }

    const mergedCurrent = mergeDuplicateSignals(item, existing);
    const mergedExisting = mergeDuplicateSignals(existing, item);

    const existingScore = mergedExisting._dedupeScore || 0;
    if (mergedCurrent._dedupeScore > existingScore) {
      grouped.set(dedupeKey, mergedCurrent);
      continue;
    }
    if (mergedCurrent._dedupeScore === existingScore) {
      const existingSeeders = parseInt(mergedExisting.seeders, 10) || 0;
      if (mergedCurrent.seeders > existingSeeders) {
        grouped.set(dedupeKey, mergedCurrent);
        continue;
      }
      const existingSize = parseSize(mergedExisting._size || mergedExisting.sizeBytes || mergedExisting.size);
      const currentSize = parseSize(mergedCurrent._size || mergedCurrent.sizeBytes || mergedCurrent.size);
      if (currentSize > existingSize) {
        grouped.set(dedupeKey, mergedCurrent);
        continue;
      }
      const existingTitleLen = String(mergedExisting.title || '').length;
      const currentTitleLen = String(mergedCurrent.title || '').length;
      if (currentTitleLen > existingTitleLen) {
        grouped.set(dedupeKey, mergedCurrent);
        continue;
      }
    }

    grouped.set(dedupeKey, mergedExisting);
  }
  const deduped = Array.from(grouped.values());
  incrementMetric('dedupe.input', Array.isArray(results) ? results.length : 0);
  incrementMetric('dedupe.output', deduped.length);
  incrementMetric('dedupe.removed', Math.max(0, (Array.isArray(results) ? results.length : 0) - deduped.length));
  return deduped;
}

function filterByQualityLimit(results, limit) {
    if (!limit || limit === 0 || limit === "0") return results;
    const limitNum = parseInt(limit);
    if (isNaN(limitNum)) return results;
    const counts = { "4K": 0, "1080p": 0, "720p": 0, "SD": 0 };
    const filtered = [];
    for (const item of results) {
        const t = (item.title || "").toLowerCase();
        let q = "SD";
        if (REGEX_QUALITY_FILTER["4K"].test(t)) q = "4K";
        else if (REGEX_QUALITY_FILTER["1080p"].test(t)) q = "1080p";
        else if (REGEX_QUALITY_FILTER["720p"].test(t)) q = "720p";
        if (counts[q] < limitNum) { filtered.push(item); counts[q]++; }
    }
    return filtered;
}

function isSafeForItalian(item) {
  if (!item || !item.title) return false;
  const parsedInfo = parseTitleDetails(item.title);
  const langInfo = getLanguageInfo(item.title, null, item.source || item.provider || null, parsedInfo);
  return !!(langInfo.isItalian || (langInfo.confidence || 0) >= 4 || langInfo.isMaybeItalian);
}

function validateStreamRequest(type, id) {
  const validTypes = ['movie', 'series', 'anime']; 
  if (!validTypes.includes(type)) throw new Error(`Tipo non valido: ${type}`);
  const cleanIdToCheck = id.replace('ai-recs:', '');
  const idPattern = /^(tt\d+|\d+|tmdb:\d+|kitsu:\d+)(:\d+)?(:\d+)?$/;
  if (!idPattern.test(cleanIdToCheck) && !idPattern.test(id)) throw new Error(`Formato ID non valido: ${id}`);
  return true;
}

async function withTimeout(promise, ms, operation = 'Operation') {
  let timer;
  const timeoutPromise = new Promise((_, reject) => { timer = setTimeout(() => { reject(new Error(`TIMEOUT: ${operation} exceeded ${ms}ms`)); }, ms); });
  try {
      const result = await Promise.race([promise, timeoutPromise]);
      clearTimeout(timer);
      return result;
  } catch (error) {
      clearTimeout(timer);
      throw error;
  }
}

function decodeConfigBase64(configStr) {
  const normalized = String(configStr || "").trim().replace(/-/g, "+").replace(/_/g, "/");
  const padding = normalized.length % 4 === 0 ? "" : "=".repeat(4 - (normalized.length % 4));
  return Buffer.from(normalized + padding, "base64").toString("utf8");
}

function getConfig(configStr) {
  try {
    if (!configStr || typeof configStr !== "string") return {};
    if (configStr.length > MAX_CONFIG_LENGTH) throw new Error(`Config troppo grande (${configStr.length})`);
    const parsed = JSON.parse(decodeConfigBase64(configStr));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Config non valida");

    const config = { ...parsed };
    config.filters = (config.filters && typeof config.filters === 'object' && !Array.isArray(config.filters)) ? { ...config.filters } : {};

    const aliasPairs = [
      ['enableStreamingCommunity', 'enableVix'],
      ['streamingCommunityLast', 'vixLast']
    ];
    for (const [primaryKey, legacyKey] of aliasPairs) {
      const primaryValue = config.filters[primaryKey];
      const legacyValue = config.filters[legacyKey];
      if (primaryValue !== undefined && legacyValue === undefined) config.filters[legacyKey] = primaryValue;
      if (legacyValue !== undefined && primaryValue === undefined) config.filters[primaryKey] = legacyValue;
    }

    const allowedServices = new Set(['rd', 'ad', 'tb', 'p2p', 'web']);
    if (config.service && !allowedServices.has(String(config.service).toLowerCase())) config.service = 'rd';

    const numericFilterKeys = ['maxPerQuality', 'maxSizeGB', 'instantDebridTop', 'warmupTop'];
    for (const key of numericFilterKeys) {
      if (config.filters[key] !== undefined && config.filters[key] !== null && config.filters[key] !== '') {
        const value = parseInt(config.filters[key], 10);
        if (Number.isNaN(value)) delete config.filters[key];
        else config.filters[key] = value;
      }
    }

    const booleanFilterKeys = ['enableVix', 'enableStreamingCommunity', 'enableGhd', 'enableGs', 'enableAnimeWorld', 'enableGf', 'enableP2P', 'showFake', 'dbOnly', 'allowEng', 'no4k', 'no1080', 'no720', 'noScr', 'noCam', 'enableTrailers', 'vixLast', 'streamingCommunityLast'];
    for (const key of booleanFilterKeys) {
      if (config.filters[key] !== undefined) config.filters[key] = !!config.filters[key];
    }

    if (config.filters.language) {
      const normalizedLanguage = String(config.filters.language).toLowerCase();
      config.filters.language = ['ita', 'eng', 'all'].includes(normalizedLanguage) ? normalizedLanguage : (config.filters.allowEng ? 'all' : 'ita');
    }

    return config;
  } catch (err) {
    logger.error(`Errore parsing config: ${err.message}`);
    return {};
  }
}

module.exports = {
  logger, Cache, LIMITERS, CONFIG, ADMIN_PASS, MAX_CONFIG_LENGTH, EMPTY_STREAM_TTL, METADATA_CACHE_TTL,
  streamInflight, metadataInflight, cloudBuildInflight,
  REGEX_YEAR, REGEX_QUALITY_FILTER, REGEX_STRONG_ITA, REGEX_CONTEXT_IT, REGEX_ISOLATED_IT, REGEX_MULTI_ITA, REGEX_TRUSTED_GROUPS, REGEX_FALSE_IT, REGEX_SUB_ONLY, REGEX_AUDIO_CONFIRM,
  languageMapping, normalizeLanguageName, parseTitleDetails, stripVisualPrefixes, normalizeSearchText, isItalianByTitleMatch, isTrustedSource, getLanguageInfo, formatLanguageLabel, isSeasonPack, isGoodShortQueryMatch, chooseBestPackTitle, shouldUpdatePackTitle, base32ToHex, extractInfoHash, estimateVisualSize, estimateSeeders,
  extractSeasonEpisodeFromFilename, parseSize, extractSeeders, extractSize, extractProvider, deduplicateResults, filterByQualityLimit, isSafeForItalian, validateStreamRequest, withTimeout,
  safeCompare, withSharedPromise, decodeConfigBase64, getConfig, TRACKERS, buildTrackerMagnet,
  incrementMetric, recordDuration, recordProviderMetric, getStatsSnapshot
};
