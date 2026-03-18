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

const Cache = {
    getCachedMagnets: async (key) => { return myCache.get(`magnets:${key}`) || null; },
    cacheMagnets: async (key, value, ttl = 3600) => { myCache.set(`magnets:${key}`, value, ttl); },
    getCachedStream: async (key) => {
        const data = myCache.get(`stream:${key}`);
        if (data) logger.info(`⚡ CACHE HIT (USER): ${key}`);
        return data || null;
    },
    cacheStream: async (key, value, ttl = 1800) => { myCache.set(`stream:${key}`, value, ttl); },
    getMetadata: async (key) => myCache.get(`meta:${key}`) || null,
    cacheMetadata: async (key, value, ttl = METADATA_CACHE_TTL) => { myCache.set(`meta:${key}`, value, ttl); },
    getLazyLink: async (key) => myCache.get(`lazy:${key}`) || null,
    cacheLazyLink: async (key, value, ttl = 120) => { myCache.set(`lazy:${key}`, value, ttl); },
    getCloudBuild: async (key) => cloudBuildCache.get(`cloud:${key}`) || null,
    setCloudBuild: async (key, value, ttl = 900) => { cloudBuildCache.set(`cloud:${key}`, value, ttl); },
    listKeys: async () => myCache.keys(),
    deleteKey: async (key) => myCache.del(key),
    flushAll: async () => { myCache.flushAll(); rawCache.flushAll(); },

    getRaw: (provider, id) => {
        const data = rawCache.get(`raw:${provider}:${id}`);
        if (data) logger.info(`🌍 GLOBAL CACHE HIT [${provider}]: ${id}`);
        return data || null;
    },
    setRaw: (provider, id, value, ttl = 43200) => {
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
    try {
        const info = ptt.parse(filename);
        const codec = info.codec ? info.codec.toUpperCase() : '';
        const audio = info.audio ? info.audio.toUpperCase() : '';
        const source = info.source ? info.source.toUpperCase() : '';

        const rawLanguages = Array.isArray(info.languages)
            ? Array.from(new Set(info.languages.map(normalizeLanguageName).filter(Boolean)))
            : [];

        const displayLanguages = rawLanguages.map(l => languageMapping[l.toLowerCase()] || l.substring(0, 3).toUpperCase());

        return {
            quality: info.resolution || 'SD',
            tags: [source, codec, audio].filter(Boolean).join(' '),
            languages: displayLanguages,
            rawLanguages,
            cleanTitle: info.title || ''
        };
    } catch (e) {
        return { quality: 'SD', tags: '', languages: [], rawLanguages: [], cleanTitle: '' };
    }
}

function stripVisualPrefixes(str) {
    if (!str) return '';
    return String(str).replace(/^[^a-zA-Z0-9]+/, '').replace(/[\u{1F300}-\u{1FAFF}]|[\u{2600}-\u{26FF}]|[\u{2700}-\u{27BF}]/gu, '').trim();
}

function normalizeSearchText(value) {
    return String(value || '').toLowerCase().replace(/[^\p{L}\p{N}\s.-]/gu, ' ').replace(/[\._\-]+/g, ' ').replace(/\s+/g, ' ').trim();
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
    if (!title) return { icon: '', isItalian: false, isMulti: false, displayLabel: '', detectedLanguages: [] };

    const detectedLanguages = [];
    const pushLanguage = (lang) => {
        const normalized = normalizeLanguageName(lang);
        if (normalized && !detectedLanguages.includes(normalized)) detectedLanguages.push(normalized);
    };

    if (parsedInfo?.rawLanguages?.length > 0) {
        parsedInfo.rawLanguages.forEach(pushLanguage);
    } else {
        if (/\b(ita|italian|italiano)\b/i.test(title) && !REGEX_SUB_ONLY.test(title)) pushLanguage('Italian');
        if (/\b(eng|english)\b/i.test(title) && !/\b(eng|english)[.\s\-_]?sub/i.test(title)) pushLanguage('English');
        if (/\b(multi)\b/i.test(title) && !/\b(multi)[.\s\-_]?sub/i.test(title)) pushLanguage('Multi');
        if (/\b(dual)\b/i.test(title) && !/\b(dual)[.\s\-_]?sub/i.test(title)) pushLanguage('Dual Audio');
        if (/\b(jpn|japanese)\b/i.test(title)) pushLanguage('Japanese');
        if (/\b(fra|french)\b/i.test(title)) pushLanguage('French');
        if (/\b(ger|german)\b/i.test(title)) pushLanguage('German');
        if (/\b(esp|spanish)\b/i.test(title)) pushLanguage('Spanish');
    }

    let hasIta = detectedLanguages.includes('Italian');
    const hasEng = detectedLanguages.includes('English');
    const hasMulti = detectedLanguages.includes('Multi') || detectedLanguages.includes('Dual Audio');

    if (!hasIta && (REGEX_TRUSTED_GROUPS.test(title) || REGEX_STRONG_ITA.test(title) || REGEX_MULTI_ITA.test(title) || REGEX_CONTEXT_IT.test(title))) hasIta = true;
    if (!hasIta && REGEX_ISOLATED_IT.test(title) && !REGEX_FALSE_IT.test(title)) hasIta = true;
    if (!hasIta && italianMovieTitle) hasIta = isItalianByTitleMatch(title, italianMovieTitle);
    if (source && isTrustedSource(source, null)) hasIta = true;

    if (hasIta && hasEng) return { icon: '🇮🇹 🇬🇧', isItalian: true, isMulti: true, displayLabel: '🇮🇹 🇬🇧', detectedLanguages };
    if (hasIta) return { icon: '🇮🇹', isItalian: true, isMulti: hasMulti, displayLabel: '🇮🇹', detectedLanguages };
    if (hasMulti) return { icon: '🌈', isItalian: false, isMulti: true, displayLabel: '🌈 MULTI', detectedLanguages };
    if (hasEng) return { icon: '🇬🇧', isItalian: false, isMulti: false, displayLabel: '🇬🇧', detectedLanguages };
    if (detectedLanguages.length > 0) return { icon: '🌐', isItalian: false, isMulti: false, displayLabel: '🌐', detectedLanguages };
    return { icon: '', isItalian: false, isMulti: false, displayLabel: '', detectedLanguages };
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
  rd: new Bottleneck({ maxConcurrent: 15, minTime: 200 }),
  packResolver: new Bottleneck({ maxConcurrent: 1, minTime: 2000 }),
  bgPackJobs: new Bottleneck({ maxConcurrent: 2, minTime: 25 }),
};

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

function deduplicateResults(results) {
  const hashMap = new Map();
  for (const item of results) {
    if (!item?.magnet) continue;
    const rawHash = item.infoHash || item.hash || extractInfoHash(item.magnet);
    const finalHash = rawHash ? rawHash.toUpperCase() : null;
    if (!finalHash || finalHash.length !== 40) continue;
    
    item.hash = finalHash;
    item.infoHash = finalHash;
    item._size = parseSize(item.sizeBytes || item.size);

    const currentSeeders = parseInt(item.seeders, 10) || 0;
    item.seeders = currentSeeders;

    const existing = hashMap.get(finalHash);
    const existingSeeders = existing ? (parseInt(existing.seeders, 10) || 0) : -1;

    if (!existing || currentSeeders > existingSeeders) hashMap.set(finalHash, item);
  }
  return Array.from(hashMap.values());
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
  return !!langInfo.isItalian;
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
    return parsed;
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
  safeCompare, withSharedPromise, decodeConfigBase64, getConfig
};
