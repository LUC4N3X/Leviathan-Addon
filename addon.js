require('dotenv').config();
const express = require("express");
const cors = require("cors");
const compression = require('compression');
const path = require("path");
const axios = require("axios");
const crypto = require("crypto");
const Bottleneck = require("bottleneck");
const rateLimit = require("express-rate-limit");
const winston = require('winston');
const NodeCache = require("node-cache");
const ptt = require('parse-torrent-title'); 
const http = require("http");
const https = require("https");

const DEFAULT_HTTP_TIMEOUT = Math.max(parseInt(process.env.HTTP_TIMEOUT_MS || "10000", 10) || 10000, 1000);
const HTTP_AGENT = new http.Agent({ keepAlive: true, maxSockets: 128, maxFreeSockets: 32 });
const HTTPS_AGENT = new https.Agent({ keepAlive: true, maxSockets: 128, maxFreeSockets: 32 });

axios.defaults.timeout = DEFAULT_HTTP_TIMEOUT;
axios.defaults.httpAgent = HTTP_AGENT;
axios.defaults.httpsAgent = HTTPS_AGENT;

const { fetchExternalAddonsFlat } = require("./external-addons");
const PackResolver = require("./leviathan-pack-resolver");
const aioFormatter = require("./aiostreams-formatter.cjs");
const { searchWebStreamr } = require("./webstreamr_handler");

const TbCache = require("./debrid/tb_cache.js");

const { formatStreamSelector, cleanFilename, formatBytes } = require("./formatter");

const P2P = require("./p2p_handler");

const { getTrailerStreams } = require("./trailerProvider"); 

const { searchVix } = require("./vix/vix_handler");
const { searchGuardaHD } = require("./guardahd/ghd_handler"); 
const { searchGuardaserie } = require("./guardaserie/gs_handler"); 
const { searchAnimeWorld } = require("./animeworld/aw_handler"); 
const { searchGuardaFlix } = require("./guardaflix/gf_handler"); 

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
}

const { handleVixSynthetic } = require("./vix/vix_proxy");
const { generateSmartQueries } = require("./ai_query");
const { smartMatch } = require("./smart_parser");
const { rankAndFilterResults } = require("./ranking");
const { tmdbToImdb, imdbToTmdb, getTmdbAltTitles } = require("./id_converter");
const RD = require("./debrid/realdebrid");
const AD = require("./debrid/alldebrid");
const TB = require("./debrid/torbox");
const dbHelper = require("./db-helper"); 
const { getManifest } = require("./manifest");

dbHelper.initDatabase();

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
        'ita': 'Italian',
        'it': 'Italian',
        'italian': 'Italian',
        'italiano': 'Italian',
        'eng': 'English',
        'en': 'English',
        'english': 'English',
        'jpn': 'Japanese',
        'jp': 'Japanese',
        'ja': 'Japanese',
        'japanese': 'Japanese',
        'fra': 'French',
        'fre': 'French',
        'fr': 'French',
        'french': 'French',
        'ger': 'German',
        'deu': 'German',
        'de': 'German',
        'german': 'German',
        'esp': 'Spanish',
        'spa': 'Spanish',
        'es': 'Spanish',
        'spanish': 'Spanish',
        'rus': 'Russian',
        'ru': 'Russian',
        'russian': 'Russian',
        'multi': 'Multi',
        'multi audio': 'Multi',
        'dual audio': 'Dual Audio',
        'dual': 'Dual Audio'
    };
    return aliasMap[value] || (value.charAt(0).toUpperCase() + value.slice(1));
}

function parseTitleDetails(filename) {
    if (!filename) {
        return { quality: 'SD', tags: '', languages: [], rawLanguages: [], cleanTitle: '' };
    }
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
    return String(str)
        .replace(/^[^a-zA-Z0-9]+/, '')
        .replace(/[\u{1F300}-\u{1FAFF}]|[\u{2600}-\u{26FF}]|[\u{2700}-\u{27BF}]/gu, '')
        .trim();
}

function normalizeSearchText(value) {
    return String(value || '')
        .toLowerCase()
        .replace(/[^\p{L}\p{N}\s.-]/gu, ' ')
        .replace(/[\._\-]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function isItalianByTitleMatch(title, italianMovieTitle = null) {
    if (!title || !italianMovieTitle) return false;
    const normalizedTorrentTitle = normalizeSearchText(title);
    const italianWords = normalizeSearchText(italianMovieTitle)
        .split(' ')
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
    if (!title) {
        return { icon: '', isItalian: false, isMulti: false, displayLabel: '', detectedLanguages: [] };
    }

    const detectedLanguages = [];
    const pushLanguage = (lang) => {
        const normalized = normalizeLanguageName(lang);
        if (normalized && !detectedLanguages.includes(normalized)) {
            detectedLanguages.push(normalized);
        }
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

    if (!hasIta && (REGEX_TRUSTED_GROUPS.test(title) || REGEX_STRONG_ITA.test(title) || REGEX_MULTI_ITA.test(title) || REGEX_CONTEXT_IT.test(title))) {
        hasIta = true;
    }
    if (!hasIta && REGEX_ISOLATED_IT.test(title) && !REGEX_FALSE_IT.test(title)) {
        hasIta = true;
    }
    if (!hasIta && italianMovieTitle) {
        hasIta = isItalianByTitleMatch(title, italianMovieTitle);
    }
    if (source && isTrustedSource(source, null)) {
        hasIta = true;
    }

    if (hasIta && hasEng) {
        return { icon: '🇮🇹 🇬🇧', isItalian: true, isMulti: true, displayLabel: '🇮🇹 🇬🇧', detectedLanguages };
    }
    if (hasIta) {
        return { icon: '🇮🇹', isItalian: true, isMulti: hasMulti, displayLabel: '🇮🇹', detectedLanguages };
    }
    if (hasMulti) {
        return { icon: '🌈', isItalian: false, isMulti: true, displayLabel: '🌈 MULTI', detectedLanguages };
    }
    if (hasEng) {
        return { icon: '🇬🇧', isItalian: false, isMulti: false, displayLabel: '🇬🇧', detectedLanguages };
    }
    if (detectedLanguages.length > 0) {
        return { icon: '🌐', isItalian: false, isMulti: false, displayLabel: '🌐', detectedLanguages };
    }
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
        /stagion[ei]\s*\d+\s*[-–—]\s*\d+/i,
        /season\s*\d+\s*[-–—]\s*\d+/i,
        /s\d+\s*[-–—]\s*s?\d+/i,
        /completa/i,
        /complete/i,
        /integrale/i,
        /collection/i,
        /\bpack\b/i,
        /stagion[ei]\s*\d+/i,
        /season\s*\d+/i,
        /\.s\d{1,2}\./i,
        /\.s\d{1,2}$/i,
        /\bs\d{1,2}(?!e)\b/i,
        /\bs\d{1,2}\./i,
        /\btutta\b/i
    ];

    return packPatterns.some(pattern => pattern.test(lowerTitle));
}

function isGoodShortQueryMatch(torrentTitle, searchQuery) {
    const cleanedSearchQuery = normalizeSearchText(searchQuery).replace(/\s\(\d{4}\)$/, '').trim();

    if (cleanedSearchQuery.length > 8 || cleanedSearchQuery.length < 2) {
        return true;
    }

    const normalizedTorrentTitle = normalizeSearchText(torrentTitle);
    const searchWords = new Set(cleanedSearchQuery.split(' ').filter(Boolean));

    for (const word of searchWords) {
        const wordRegex = new RegExp(`\\b${word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
        if (!wordRegex.test(normalizedTorrentTitle)) {
            return false;
        }
    }

    return true;
}

function chooseBestPackTitle(item, resolvedPackName = null, siblingStreams = []) {
    const sameHashStreams = siblingStreams.filter(stream =>
        (stream.hash || stream.infoHash || '').toLowerCase() === (item.hash || item.infoHash || '').toLowerCase()
    );

    const torrentioStream = sameHashStreams.find(stream =>
        (stream.source || stream.name || '').includes('Torrentio') && String(stream.title || '').includes('📁')
    );
    if (torrentioStream) {
        const firstLine = String(torrentioStream.title || '').split('\n')[0] || '';
        const clean = stripVisualPrefixes(firstLine);
        if (clean && clean.length > 5) return { title: clean, source: 'Torrentio' };
    }

    const mediafusionStream = sameHashStreams.find(stream =>
        (stream.source || stream.name || '').includes('MediaFusion') && String(stream.title || '').includes('┈➤')
    );
    if (mediafusionStream) {
        const packPart = String(mediafusionStream.title || '').split('┈➤')[0].replace('📂', '').trim();
        const clean = stripVisualPrefixes(packPart);
        if (clean && clean.length > 5) return { title: clean, source: 'MediaFusion' };
    }

    const scraperTitle = stripVisualPrefixes(item.title || '');
    if (scraperTitle && scraperTitle.length > 5 && !/^Season \d+$/i.test(scraperTitle) && !/^Stagione \d+$/i.test(scraperTitle)) {
        return { title: scraperTitle, source: 'Scraper' };
    }

    if (resolvedPackName && resolvedPackName.length > 5) {
        return { title: stripVisualPrefixes(resolvedPackName), source: 'Debrid' };
    }

    return { title: scraperTitle || stripVisualPrefixes(resolvedPackName) || item.title || 'Unknown Pack', source: 'Fallback' };
}

function shouldUpdatePackTitle(currentTitle, nextTitle) {
    const curr = stripVisualPrefixes(currentTitle || '').toLowerCase();
    const next = stripVisualPrefixes(nextTitle || '').toLowerCase();

    if (!next || curr === next) {
        return !!currentTitle && currentTitle !== nextTitle;
    }
    if (!/ita|multi/.test(next)) return false;
    if (!/ita|multi/.test(curr)) return true;

    const hasSeasonInfo = /s\d+|season|stagion|complete|episod/i.test(curr);
    const isGenericRd = /^[\w\s]+\s*\[\d{4}[-–]\d{4}\]$/.test(stripVisualPrefixes(currentTitle || ''));
    if (hasSeasonInfo && !isGenericRd) return false;

    return true;
}

function base32ToHex(base32) {
    const base32chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
    let bits = "";
    let hex = "";
    for (let i = 0; i < base32.length; i++) {
        const val = base32chars.indexOf(base32.charAt(i).toUpperCase());
        bits += val.toString(2).padStart(5, '0');
    }
    for (let i = 0; i + 4 <= bits.length; i += 4) {
        const chunk = bits.substr(i, 4);
        hex += parseInt(chunk, 2).toString(16);
    }
    return hex;
}

function extractInfoHash(magnet) {
    if (!magnet) return null;
    const match = magnet.match(/btih:([A-Fa-f0-9]{40}|[A-Za-z2-7]{32})/i);
    if (!match) return null;
    const hash = match[1];
    if (hash.length === 32) {
        return base32ToHex(hash).toUpperCase();
    }
    return hash.toUpperCase();
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
    for (let i = 0; i < seedStr.length; i++) {
        hashVal = (Math.imul(31, hashVal) + seedStr.charCodeAt(i)) | 0;
    }
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

    const fineNoise = Math.floor(seededRandom() * 1024 * 1024 * 5); 
    return Math.floor(baseSize + fineNoise);
}

function estimateSeeders(knownSeeders, infoHash) {
    if (knownSeeders && knownSeeders > 0) return knownSeeders;
    let seedStr = infoHash || "seeders_fallback";
    let hashVal = 0;
    for (let i = 0; i < seedStr.length; i++) {
        hashVal = (Math.imul(31, hashVal) + seedStr.charCodeAt(i)) | 0;
    }
    return (Math.abs(hashVal) % 60) + 8;
}

const LIMITERS = {
  scraper: new Bottleneck({ maxConcurrent: 40, minTime: 10 }),
  rd: new Bottleneck({ maxConcurrent: 15, minTime: 200 }),
  packResolver: new Bottleneck({ maxConcurrent: 1, minTime: 2000 }),
  bgPackJobs: new Bottleneck({ maxConcurrent: 2, minTime: 25 }),
};

async function resolvePackWithBestEffort(item, config, meta, siblingStreams = []) {
    if (!item || !item.hash) return null;

    const resolverCalls = [];
    const resolverContext = {
        item,
        config,
        meta,
        siblingStreams,
        dbHelper,
        logger,
        RD,
        TB
    };

    if (PackResolver && typeof PackResolver.resolvePackData === 'function') {
        resolverCalls.push(() => PackResolver.resolvePackData(resolverContext));
    }
    if (PackResolver && typeof PackResolver.resolvePack === 'function') {
        resolverCalls.push(() => PackResolver.resolvePack(resolverContext));
    }
    if (PackResolver && typeof PackResolver.resolve === 'function') {
        resolverCalls.push(() => PackResolver.resolve(resolverContext));
        resolverCalls.push(() => PackResolver.resolve(item, config, meta));
    }
    if (PackResolver && typeof PackResolver.getPackData === 'function') {
        resolverCalls.push(() => PackResolver.getPackData(item.hash, config, meta));
    }

    for (const call of resolverCalls) {
        try {
            const resolved = await LIMITERS.packResolver.schedule(() => Promise.resolve(call()));
            if (!resolved) continue;

            const packName = resolved.filename || resolved.packName || resolved.pack_name || resolved.title || resolved.name || null;
            const files = Array.isArray(resolved.files) ? resolved.files : (Array.isArray(resolved.videoFiles) ? resolved.videoFiles : []);
            const bestTitleData = chooseBestPackTitle(item, packName, siblingStreams);

            return {
                title: bestTitleData.title,
                titleSource: bestTitleData.source,
                packName,
                files,
                raw: resolved
            };
        } catch (err) {
            logger.warn(`⚠️ [PACK] Resolver error for ${item.hash}: ${err.message}`);
        }
    }

    return null;
}

function extractSeasonEpisodeFromFilename(filename, defaultSeason = 1) {
    const name = String(filename || '');
    let match = name.match(/\bS(\d{1,2})E(\d{1,3})\b/i);
    if (match) {
        return { season: parseInt(match[1], 10), episode: parseInt(match[2], 10) };
    }

    match = name.match(/\b(\d{1,2})x(\d{1,3})\b/i);
    if (match) {
        return { season: parseInt(match[1], 10), episode: parseInt(match[2], 10) };
    }

    match = name.match(/\bE(?:P(?:ISODE)?)?\s*0?(\d{1,3})\b/i);
    if (match) {
        return { season: defaultSeason, episode: parseInt(match[1], 10) };
    }

    return null;
}

async function persistPackResolution(meta, item, resolved) {
    if (!resolved || !dbHelper) return;

    const infoHash = item.hash || item.infoHash;
    if (!infoHash) return;

    try {
        if (resolved.title && resolved.title !== item.title && shouldUpdatePackTitle(item.title, resolved.title)) {
            if (typeof dbHelper.updateTorrentTitle === 'function') {
                await dbHelper.updateTorrentTitle(infoHash, resolved.title);
            }
        }
    } catch (err) {
        logger.warn(`⚠️ [PACK] updateTorrentTitle failed for ${infoHash}: ${err.message}`);
    }

    const files = Array.isArray(resolved.files) ? resolved.files : [];
    if (files.length === 0) return;

    const seasonFallback = Number(meta?.season) > 0 ? Number(meta.season) : 1;
    const episodeFiles = [];
    const packFiles = [];

    for (const file of files) {
        const filePath = file.path || file.filename || file.name || '';
        const fileSize = Number(file.bytes || file.size || file.file_size || 0);
        if (!filePath || fileSize < 50 * 1024 * 1024) continue;

        const fileIndexRaw = file.id ?? file.file_index ?? file.index ?? file.fileIdx;
        const fileIndex = fileIndexRaw !== undefined && fileIndexRaw !== null ? parseInt(fileIndexRaw, 10) : undefined;
        const filename = filePath.split('/').pop();
        const parsedEpisode = extractSeasonEpisodeFromFilename(filename, seasonFallback);

        if (parsedEpisode && Number.isInteger(fileIndex)) {
            episodeFiles.push({
                info_hash: infoHash,
                file_index: fileIndex,
                title: filename,
                size: fileSize,
                imdb_id: meta?.imdb_id || null,
                imdb_season: parsedEpisode.season,
                imdb_episode: parsedEpisode.episode
            });
        } else if (Number.isInteger(fileIndex)) {
            packFiles.push({
                info_hash: infoHash,
                file_index: fileIndex,
                file_title: filename,
                size: fileSize,
                imdb_id: meta?.imdb_id || null,
                title: resolved.title || item.title
            });
        }
    }

    try {
        if (episodeFiles.length > 0 && typeof dbHelper.insertEpisodeFiles === 'function') {
            await dbHelper.insertEpisodeFiles(episodeFiles);
        }
    } catch (err) {
        logger.warn(`⚠️ [PACK] insertEpisodeFiles failed for ${infoHash}: ${err.message}`);
    }

    try {
        if (packFiles.length > 0 && typeof dbHelper.insertPackFiles === 'function') {
            await dbHelper.insertPackFiles(packFiles);
        }
    } catch (err) {
        logger.warn(`⚠️ [PACK] insertPackFiles failed for ${infoHash}: ${err.message}`);
    }
}

function resolvePackNamesInBackground(meta, results, config) {
    if (!meta || !config || !Array.isArray(results) || results.length === 0) return;
    const hasResolvableService = !!(
        (config.service === 'rd' && (config.key || config.rd)) ||
        (config.service === 'tb' && (config.key || config.rd || config.torbox || config.tb))
    );
    if (!hasResolvableService) return;

    const packCandidates = results.filter(item => item && (item._isPack || isSeasonPack(item.title)));
    if (packCandidates.length === 0) return;

    LIMITERS.bgPackJobs.schedule(async () => {
        for (const item of packCandidates) {
            try {
                const resolved = await resolvePackWithBestEffort(item, config, meta, results);
                if (resolved) {
                    await persistPackResolution(meta, item, resolved);
                }
            } catch (err) {
                logger.warn(`⚠️ [PACK] Background processing failed for ${item.hash || item.infoHash}: ${err.message}`);
            }
        }
    }).catch(err => {
        logger.warn(`⚠️ [PACK] Background queue failed: ${err.message}`);
    });
}



const SCRAPER_MODULES = [ require("./engines") ];

const app = express();
app.set('trust proxy', 1);

app.use(compression({
  filter: (req, res) => {
    if (req.headers['x-no-compression']) return false;
    return compression.filter(req, res);
  },
  level: 6
}));

const limiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 350,
    standardHeaders: true,
    legacyHeaders: false,
    message: "Troppe richieste da questo IP, riprova più tardi."
});
app.use(limiter);

app.use(cors());
app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  next();
});
app.use(express.json({ limit: process.env.JSON_LIMIT || "64kb" }));
app.use(express.urlencoded({ extended: false, limit: process.env.URLENCODED_LIMIT || "32kb" }));
app.use(express.static(path.join(__dirname, "public")));

function parseSize(sizeText) {
  if (!sizeText) return 0;
  if (typeof sizeText === 'number') return sizeText;
  
  const str = sizeText.toString();
  let scale = 1;
  
  if (str.match(/TB/i)) {
    scale = 1024 * 1024 * 1024 * 1024;
  } else if (str.match(/GB/i)) {
    scale = 1024 * 1024 * 1024;
  } else if (str.match(/MB/i)) {
    scale = 1024 * 1024;
  } else if (str.match(/KB/i) || str.match(/kB/i)) {
    scale = 1024;
  } else if (str.match(/B/i) && !str.match(/GB|MB|KB|TB/i)) {
    scale = 1;
  }
  
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

    if (!existing || currentSeeders > existingSeeders) {
      hashMap.set(finalHash, item);
    }
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
        if (counts[q] < limitNum) {
            filtered.push(item);
            counts[q]++;
        }
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
  if (!validTypes.includes(type)) {
    throw new Error(`Tipo non valido: ${type}`);
  }
  const cleanIdToCheck = id.replace('ai-recs:', '');
  const idPattern = /^(tt\d+|\d+|tmdb:\d+|kitsu:\d+)(:\d+)?(:\d+)?$/;
  if (!idPattern.test(cleanIdToCheck) && !idPattern.test(id)) {
    throw new Error(`Formato ID non valido: ${id}`);
  }
  return true;
}

async function withTimeout(promise, ms, operation = 'Operation') {
  let timer;
  const timeoutPromise = new Promise((_, reject) => {
      timer = setTimeout(() => { reject(new Error(`TIMEOUT: ${operation} exceeded ${ms}ms`)); }, ms);
  });
  try {
      const result = await Promise.race([promise, timeoutPromise]);
      clearTimeout(timer);
      return result;
  } catch (error) {
      clearTimeout(timer);
      throw error;
  }
}

function applyWebFormatter(streamList, sourceName, meta, config) {
    if (!streamList || !Array.isArray(streamList)) return [];
    
    return streamList.map(stream => {
        let quality = "HD";
        const upperName = (stream.name || "").toUpperCase();
        
        if (upperName.includes("4K") || upperName.includes("2160P")) quality = "4K";
        else if (upperName.includes("1080P") || upperName.includes("FHD")) quality = "1080p";
        else if (upperName.includes("720P")) quality = "720p";
        else if (upperName.includes("SD") || upperName.includes("480P")) quality = "SD";

        let fileTitle = meta.title; 
        let rawTitleToCheck = (stream.title || "").toUpperCase(); 

        if (stream.title) {
            let rawLines = stream.title.split('\n');
            let rawTitle = rawLines[0]; 
            let cleanRaw = rawTitle.replace(/[🎬⚡🌪️⛩️🍿🦁🎥🌐]/g, '').trim();
            if (cleanRaw.length > 2) {
                fileTitle = cleanRaw;
            }
        }

        let langTag = "ITA"; 
        let providerIcon = "🌐"; 

        const sLower = sourceName.toLowerCase();
        
        if (sLower.includes("animeworld")) {
            providerIcon = "⛩️"; 
            if (rawTitleToCheck.includes("JPN") || rawTitleToCheck.includes("SUB") || rawTitleToCheck.includes("VOST")) {
                langTag = "JPN"; 
            } else {
                langTag = "ITA"; 
            }
        } else if (sLower.includes("streamingcommunity")) {
            providerIcon = "🌪️"; 
        } else if (sLower.includes("guardaserie")) {
            providerIcon = "🍿"; 
        } else if (sLower.includes("guardahd")) {
            providerIcon = "🦁"; 
        } else if (sLower.includes("guardaflix")) {
            providerIcon = "🎥";
        }

        const fakeFilename = `${fileTitle} ${quality} ${langTag} WEB-DL AAC`;

        const formatted = formatStreamSelector(
            fakeFilename, sourceName, 0, null, "WEB", config, null, false, false
        );

        let cleanTitle = formatted.title;
        cleanTitle = cleanTitle.replace(/🦑/g, "⛵");
        cleanTitle = cleanTitle.replace(/🦈/g, providerIcon);
        cleanTitle = cleanTitle.replace(/🧲\s*\d+(\.\d+)?\s*(GB|MB)/gi, "☁️ Web Stream");

        let cleanName = formatted.name;
        cleanName = cleanName.replace(/🦑/g, "⛵").replace(/🦈/g, providerIcon);

        return {
            name: cleanName,
            title: cleanTitle,
            url: stream.url,
            behaviorHints: stream.behaviorHints || { 
                notWebReady: false, 
                bingieGroup: `Leviathan|${quality}|Web|${sourceName}` 
            }
        };
    });
}

async function fetchTmdbMeta(tmdbId, type, userApiKey) {
    if (!tmdbId) return null;
    const apiKey = (userApiKey && userApiKey.length > 1) ? userApiKey : (process.env.TMDB_API_KEY || "4b9dfb8b1c9f1720b5cd1d7efea1d845");
    const endpoint = type === 'series' || type === 'tv' ? 'tv' : 'movie';
    const url = `https://api.themoviedb.org/3/${endpoint}/${tmdbId}?api_key=${apiKey}&language=it-IT`;
    try {
        const { data } = await axios.get(url, { timeout: CONFIG.TIMEOUTS.TMDB });
        return data;
    } catch (e) {
        logger.warn(`TMDB Meta Fetch Error for ${tmdbId}: ${e.message}`);
        return null;
    }
}

async function getMetadata(id, type, config = {}) {
  const userTmdbKey = String(config?.tmdb || '');
  const metadataCacheKey = `${type}:${id}:${userTmdbKey}`;
  const cachedMeta = await Cache.getMetadata(metadataCacheKey);
  if (cachedMeta) {
    logger.info(`⚡ META CACHE HIT: ${metadataCacheKey}`);
    return cachedMeta;
  }

  return withSharedPromise(metadataInflight, metadataCacheKey, async () => {
    const secondCacheHit = await Cache.getMetadata(metadataCacheKey);
    if (secondCacheHit) return secondCacheHit;

    let finalMeta = null;

    try {
      if (type === 'anime' || id.toString().startsWith('kitsu:')) {
          let kitsuId = id.toString();
          let episode = 0;

          if (kitsuId.includes(':')) {
              const parts = kitsuId.split(':');
              kitsuId = parts[1];
              if (parts.length > 2) {
                  episode = parseInt(parts[2]);
              }
          }

          const kitsuUrl = `${CONFIG.KITSU_URL}/meta/anime/kitsu:${kitsuId}.json`;
          logger.info(`⛩️ [META] Fetching Kitsu (Direct): ${kitsuUrl}`);

          try {
              const { data } = await axios.get(kitsuUrl, { timeout: CONFIG.TIMEOUTS.TMDB });
              if (data && data.meta) {
                  const kMeta = data.meta;
                  const year = kMeta.year ? kMeta.year.split("–")[0] : (kMeta.releaseInfo ? kMeta.releaseInfo.substring(0, 4) : "");

                  finalMeta = {
                      title: kMeta.name,
                      originalTitle: kMeta.name,
                      year: year,
                      imdb_id: kMeta.imdb_id || null,
                      kitsu_id: kitsuId,
                      isSeries: true,
                      season: 1,
                      episode: episode
                  };
              }
          } catch (e) {
              logger.warn(`⚠️ Errore Metadata Kitsu: ${e.message} - Fallback sconsigliato ma tentiamo clean`);
          }
      }

      if (!finalMeta) {
        const allowedTypes = ["movie", "series"];
        const cleanType = (type === 'anime') ? 'series' : type;

        if (!allowedTypes.includes(cleanType)) return null;

        let imdbId = id;
        let season = 0;
        let episode = 0;

        if (cleanType === "series" && id.includes(":")) {
            const parts = id.split(":");
            imdbId = parts[0];
            season = parseInt(parts[1]);
            episode = parseInt(parts[2]);
        }

        const cleanId = imdbId.match(/^(tt\d+|\d+)$/i)?.[0] || imdbId;
        if (!cleanId) return null;

        try {
            const { tmdbId } = await imdbToTmdb(cleanId, userTmdbKey);

            if (tmdbId) {
                const tmdbData = await fetchTmdbMeta(tmdbId, cleanType, userTmdbKey);
                if (tmdbData) {
                    const title = tmdbData.title || tmdbData.name;
                    const originalTitle = tmdbData.original_title || tmdbData.original_name;
                    const releaseDate = tmdbData.release_date || tmdbData.first_air_date;
                    const year = releaseDate ? releaseDate.split("-")[0] : "";
                    logger.info(`✅ [META] Usato TMDB (UserKey: ${!!userTmdbKey}): ${title} (${year}) [ID: ${tmdbId}] Orig: ${originalTitle}`);
                    finalMeta = {
                        title: title,
                        originalTitle: originalTitle,
                        year: year,
                        imdb_id: cleanId,
                        tmdb_id: tmdbId,
                        isSeries: cleanType === "series",
                        season: season,
                        episode: episode
                    };
                }
            }
        } catch (err) {
            logger.warn(`⚠️ Errore Metadata TMDB, fallback a Cinemeta: ${err.message}`);
        }

        if (!finalMeta) {
          logger.info(`ℹ️ [META] Fallback a Cinemeta per ${cleanId}`);
          const { data: cData } = await axios.get(`${CONFIG.CINEMETA_URL}/meta/${cleanType}/${cleanId}.json`, { timeout: CONFIG.TIMEOUTS.TMDB }).catch(() => ({ data: {} }));

          finalMeta = cData?.meta ? {
            title: cData.meta.name,
            originalTitle: cData.meta.name,
            year: cData.meta.year?.split("–")[0],
            imdb_id: cleanId,
            isSeries: cleanType === "series",
            season: season,
            episode: episode
          } : null;
        }
      }
    } catch (err) {
      logger.error(`Errore getMetadata Critical: ${err.message}`);
      finalMeta = null;
    }

    if (finalMeta) {
      await Cache.cacheMetadata(metadataCacheKey, finalMeta, METADATA_CACHE_TTL);
    }
    return finalMeta;
  });
}

function saveResultsToDbBackground(meta, results, config = null) {
    if (!results || results.length === 0) return;
    (async () => {
        let savedCount = 0;
        for (const item of results) {
            const torrentObj = {
                info_hash: item.hash || item.infoHash,
                title: item.title,
                size: item._size || item.sizeBytes || 0,
                seeders: item.seeders || 0,
                provider: item.source || 'External',
                file_index: item.fileIdx !== undefined ? item.fileIdx : undefined,
                is_pack: item._isPack || isSeasonPack(item.title)
            };
            if (!torrentObj.info_hash) continue;
            const success = await dbHelper.insertTorrent(meta, torrentObj);
            if (success) savedCount++;
        }
        if (savedCount > 0) {
            console.log(`💾 [AUTO-LEARN] Salvati ${savedCount} nuovi torrent nel DB per ${meta.imdb_id}`);
        }
        resolvePackNamesInBackground(meta, results, config);
    })().catch(err => console.error("❌ Errore background save:", err.message));
}

async function resolveDebridLink(config, item, showFake, reqHost, meta) {
    try {
        const service = config.service || 'rd';
        const apiKey = config.key || config.rd;
        if (!apiKey) return null;

        const isAIOActive = aioFormatter.isAIOStreamsEnabled(config);

        let displayTitle = item.title;
        let isPack = item._isPack || isSeasonPack(item.title);
        const isSeries = (meta?.season > 0 || meta?.episode > 0);

        if (isAIOActive && isPack && isSeries && meta) {
             const s = meta.season < 10 ? `0${meta.season}` : meta.season;
             const e = meta.episode < 10 ? `0${meta.episode}` : meta.episode;
             displayTitle = `${meta.title} S${s}E${e}`;
        }

        const details = parseTitleDetails(item.title);
        const titleLanguage = getLanguageInfo(item.title, meta?.title, item.source, details);

        if (service === 'tb') {
            if (item._tbCached) {
                let realSize = item._size || item.sizeBytes || 0;
                realSize = estimateVisualSize(realSize, item.title, isSeries, isPack, item.hash);
                const finalSeeders = estimateSeeders(item.seeders, item.hash);
                const fIdx = (item.fileIdx !== undefined && !isNaN(item.fileIdx)) ? item.fileIdx : -1;
                const proxyUrl = `${reqHost}/${config.rawConf}/play_tb/${item.hash}?s=${item.season || 0}&e=${item.episode || 0}&f=${fIdx}`;

                if (isAIOActive) {
                    let quality = details.quality || "SD";
                    if (/4k|2160p/i.test(item.title)) quality = "4K"; 
                    
                    return {
                        name: aioFormatter.formatStreamName({
                            service: 'torbox',
                            cached: true,
                            quality: quality
                        }),
                        title: aioFormatter.formatStreamTitle({
                            title: displayTitle,
                            size: formatBytes(realSize),
                            language: formatLanguageLabel(titleLanguage, details.languages),
                            source: item.source,
                            seeders: finalSeeders,
                            infoHash: item.hash, 
                            techInfo: `🎞️ ${quality} ${details.tags}`
                        }),
                        url: proxyUrl,
                        infoHash: item.hash,
                        behaviorHints: { notWebReady: false, bingieGroup: `Leviathan|${quality}|TB|${item.hash}` }
                    };
                } else {
                    const { name, title, bingeGroup } = formatStreamSelector(
                        item.title, item.source, realSize, finalSeeders, "TB", config, item.hash, false, item._isPack
                    );
                    return { name, title, url: proxyUrl, behaviorHints: { notWebReady: false, bingieGroup: bingeGroup } };
                }
            } else { return null; }
        }

        let streamData = null;
        if (service === 'rd') streamData = await RD.getStreamLink(apiKey, item.magnet, item.season, item.episode, item.fileIdx);
        else if (service === 'ad') streamData = await AD.getStreamLink(apiKey, item.magnet, item.season, item.episode, item.fileIdx);

        if (!streamData || (streamData.type === "ready" && streamData.size < CONFIG.REAL_SIZE_FILTER)) return null;

        let finalSize = streamData.size || item._size || item.sizeBytes || 0;
        finalSize = estimateVisualSize(finalSize, streamData.filename || item.title, isSeries, isPack, item.hash);

        const finalSeeders = estimateSeeders(item.seeders, item.hash);
        const fileDetails = parseTitleDetails(streamData.filename || item.title);
        const fileLanguage = getLanguageInfo(streamData.filename || item.title, meta?.title, item.source, fileDetails);

        if (isAIOActive) {
             let quality = fileDetails.quality || "SD";
             if (/4k|2160p/i.test(item.title)) quality = "4K"; 
             
             let fullService = 'p2p';
             if (service === 'rd') fullService = 'realdebrid';
             if (service === 'ad') fullService = 'alldebrid';
             if (service === 'tb') fullService = 'torbox';

             return {
                name: aioFormatter.formatStreamName({
                    service: fullService,
                    cached: true,
                    quality: quality
                }),
                title: aioFormatter.formatStreamTitle({
                    title: displayTitle,
                    size: formatBytes(finalSize),
                    language: formatLanguageLabel(fileLanguage, fileDetails.languages),
                    source: item.source,
                    seeders: finalSeeders,
                    infoHash: item.hash,
                    techInfo: `🎞️ ${quality} ${fileDetails.tags}`
                }),
                url: streamData.url,
                infoHash: item.hash,
                behaviorHints: { notWebReady: false, bingieGroup: `Leviathan|${quality}|${service}|${item.hash}` }
            };
        } else {
            const serviceTag = service.toUpperCase();
            const { name, title, bingeGroup } = formatStreamSelector(
                streamData.filename || item.title, item.source, finalSize, finalSeeders, serviceTag, config, item.hash, false, item._isPack
            );
            return { name, title, url: streamData.url, behaviorHints: { notWebReady: false, bingieGroup: bingeGroup } };
        }
    } catch (e) {
        if (showFake) return { name: `[P2P ⚠️]`, title: `${item.title}\n⚠️ Cache Assente`, url: item.magnet, behaviorHints: { notWebReady: true } };
        return null;
    }
}

function generateLazyStream(item, config, meta, reqHost, userConfStr, isLazy = false) {
    const service = config.service || 'rd';
    const serviceTag = service.toUpperCase();
    const isAIOActive = aioFormatter.isAIOStreamsEnabled(config); 
    const isPack = item._isPack || isSeasonPack(item.title);
    const isSeries = (meta.season > 0 || meta.episode > 0);

    let displayTitle = item.title;
    let realSize = item._size || item.sizeBytes || 0;
    
    if (isAIOActive) {
        if (isPack && isSeries) realSize = 0; 
        if (isPack && isSeries) {
            const s = meta.season < 10 ? `0${meta.season}` : meta.season;
            const e = meta.episode < 10 ? `0${meta.episode}` : meta.episode;
            displayTitle = `${meta.title} S${s}E${e}`;
        }
    }

    realSize = estimateVisualSize(realSize, displayTitle, isSeries, isPack, item.hash);
    const finalSeeders = estimateSeeders(item.seeders, item.hash);

    if (isAIOActive) {
        const details = parseTitleDetails(item.title);
        const lazyLanguage = getLanguageInfo(item.title, meta?.title, item.source, details);
        let quality = details.quality || "SD";
        
        if (/4k|2160p/i.test(item.title)) quality = "4K";
        
        let fullService = 'p2p';
        if (service === 'rd') fullService = 'realdebrid';
        if (service === 'ad') fullService = 'alldebrid';
        if (service === 'tb') fullService = 'torbox';

        const nameStr = aioFormatter.formatStreamName({
            addonName: "Leviathan", 
            service: fullService,
            cached: true,
            quality: quality
        });

        const titleStr = aioFormatter.formatStreamTitle({
            title: displayTitle, 
            size: formatBytes(realSize),
            language: formatLanguageLabel(lazyLanguage, details.languages), 
            source: item.source,
            seeders: finalSeeders,
            infoHash: item.hash,
            techInfo: `🎞️ ${quality} ${details.tags}`
        });

        const fileIdxParam = (item.fileIdx !== undefined && !isNaN(item.fileIdx)) ? item.fileIdx : -1;
        const lazyUrl = `${reqHost}/${userConfStr}/play_lazy/${service}/${item.hash}/${fileIdxParam}?s=${meta.season || 0}&e=${meta.episode || 0}`;

        return {
            name: nameStr,
            title: titleStr,
            url: lazyUrl,
            infoHash: item.hash,
            behaviorHints: { 
                notWebReady: false, 
                bingieGroup: `Leviathan|${quality}|${service}|${item.hash}` 
            }
        };
    } 
    else {
        const { name, title, bingeGroup } = formatStreamSelector(
            item.title, item.source, realSize, finalSeeders, serviceTag, config, item.hash, isLazy, item._isPack 
        );
        const fileIdxParam = (item.fileIdx !== undefined && !isNaN(item.fileIdx)) ? item.fileIdx : -1;
        const lazyUrl = `${reqHost}/${userConfStr}/play_lazy/${service}/${item.hash}/${fileIdxParam}?s=${meta.season || 0}&e=${meta.episode || 0}`;
        return {
            name,
            title,
            url: lazyUrl,
            infoHash: item.hash,
            behaviorHints: { notWebReady: false, bingieGroup: bingeGroup }
        };
    }
}

async function queryRemoteIndexer(tmdbId, type, season = null, episode = null, config) { 
    if (!CONFIG.INDEXER_URL) return [];
    try {
        logger.info(`🌐 [REMOTE] Query VPS: ${CONFIG.INDEXER_URL} | ID: ${tmdbId} S:${season} E:${episode}`);
        let url = `${CONFIG.INDEXER_URL}/api/get/${tmdbId}`;
        if (season) url += `?season=${season}`;
        if (episode) url += `&episode=${episode}`;
        const { data } = await axios.get(url, { timeout: CONFIG.TIMEOUTS.REMOTE_INDEXER });
        if (!data || !data.torrents || !Array.isArray(data.torrents)) return [];
        
        const mapped = data.torrents.map(t => {
            let magnet = t.magnet || `magnet:?xt=urn:btih:${t.info_hash}&dn=${encodeURIComponent(t.title)}`;
            if(!magnet.includes("tr=")) {
               magnet += "&tr=udp%3A%2F%2Ftracker.opentrackr.org%3A1337%2Fannounce&tr=udp%3A%2F%2Fopen.demonii.com%3A1337%2Fannounce";
            }
            let providerName = t.provider || 'P2P';
            providerName = providerName.replace(/LeviathanDB/i, '').replace(/[()]/g, '').trim();
            if(!providerName) providerName = 'P2P';
            const finalHash = t.info_hash ? t.info_hash.toUpperCase() : extractInfoHash(magnet);
            return {
                title: t.title,
                magnet: magnet,
                hash: finalHash,
                infoHash: finalHash,
                size: "💾 DB",
                sizeBytes: parseInt(t.size),
                seeders: parseInt(t.seeders, 10) || 0,
                source: providerName,
                fileIdx: t.file_index !== undefined ? parseInt(t.file_index) : undefined,
                _isPack: isSeasonPack(t.title)
            };
        });

        const langMode = config && config.filters ? (config.filters.language || (config.filters.allowEng ? "all" : "ita")) : "ita";
        
        return mapped.filter(item => {
             const parsedInfo = parseTitleDetails(item.title);
             const langInfo = getLanguageInfo(item.title, null, item.source, parsedInfo);

             if (langMode === 'ita') {
                 if (!langInfo.isItalian) return false;
             } else if (langMode === 'eng') {
                 if (langInfo.isItalian) return false;
             }
             return true;
        });
    } catch (e) {
        logger.error("Err Remote Indexer:", { error: e.message });
        return [];
    }
}

async function fetchExternalResults(type, finalId, config) {
    logger.info(`🌐 [EXTERNAL] Start Parallel Fetch...`);
    try {
        const externalResults = await withTimeout(
            fetchExternalAddonsFlat(type, finalId, { userConfig: config }).then(items => {
                return items.map(i => {
                    const title = i.title || i.filename;
                    let finalSeeders = parseInt(i.seeders, 10) || 0;
                    if (!finalSeeders && title) finalSeeders = extractSeeders(title);
                    
                    let finalSize = i.mainFileSize;
                    if ((!finalSize || finalSize === 0) && title) finalSize = extractSize(title);
                    
                    let displaySize = i.size;
                    if (!displaySize && finalSize > 0) displaySize = formatBytes(finalSize);

                    return {
                        title: title,
                        magnet: i.magnetLink,
                        size: displaySize,             
                        sizeBytes: finalSize,
                        seeders: finalSeeders,
                        source: i.externalProvider || i.source.replace(/\[EXT\]\s*/, ''),
                        hash: i.infoHash || extractInfoHash(i.magnetLink),
                        infoHash: i.infoHash || extractInfoHash(i.magnetLink),
                        fileIdx: i.fileIdx,
                        isExternal: true,
                        _isPack: isSeasonPack(title)
                    };
                });
            }),
            CONFIG.TIMEOUTS.EXTERNAL,
            'External Addons'
        );
        if (externalResults && externalResults.length > 0) {
            logger.info(`✅ [EXTERNAL] Trovati ${externalResults.length} risultati`);
            return externalResults;
        } else {
            logger.info(`❌ [EXTERNAL] Nessun risultato trovato.`);
            return [];
        }
    } catch (err) {
        logger.warn('External Addons fallito/timeout', { error: err.message });
        return [];
    }
}

async function generateStream(type, id, config, userConfStr, reqHost) {
  const hasDebridKey = (config.key && config.key.length > 0) || (config.rd && config.rd.length > 0);
  const isWebEnabled = config.filters && (config.filters.enableVix || config.filters.enableGhd || config.filters.enableGs || config.filters.enableAnimeWorld || config.filters.enableGf);
  
  const isP2PEnabled = config.filters && config.filters.enableP2P === true;

  if (!hasDebridKey && !isWebEnabled && !isP2PEnabled) {
      return { streams: [{ name: "⚠️ CONFIG", title: "Inserisci API Key, Attiva P2P o Attiva WebStream" }] };
  }
  
  const configHash = crypto.createHash('md5').update(userConfStr || 'no-conf').digest('hex');
  const cacheKey = `${type}:${id}:${configHash}`;
  
  const cachedResult = await Cache.getCachedStream(cacheKey);
  if (cachedResult) return cachedResult;

  return withSharedPromise(streamInflight, `stream:${cacheKey}`, async () => {
  const cachedAgain = await Cache.getCachedStream(cacheKey);
  if (cachedAgain) return cachedAgain;

  const userTmdbKey = config.tmdb; 
  let finalId = id.replace('ai-recs:', '');
  
  if (finalId.startsWith("tmdb:")) {
      try {
          const parts = finalId.split(":");
          const imdbId = await tmdbToImdb(parts[1], type, userTmdbKey);
          if (imdbId) {
              if (type === "series" && parts.length >= 4) finalId = `${imdbId}:${parts[2]}:${parts[3]}`;
              else finalId = imdbId;
          }
      } catch (err) {}
  }

  const meta = await getMetadata(finalId, type, config);
  if (!meta) return { streams: [] };

  logger.info(`🚀 [SPEED] Start search for: ${meta.title}`);
  
  const tmdbIdLookup = meta.tmdb_id || (meta.kitsu_id ? null : (await imdbToTmdb(meta.imdb_id, userTmdbKey))?.tmdbId);
  const dbOnlyMode = config.filters?.dbOnly === true; 
  const langMode = config.filters?.language || (config.filters?.allowEng ? "all" : "ita");

  const aggressiveFilter = (item) => {
      if (!item?.magnet) return false;
      const source = (item.source || "").toLowerCase();
      if (source.includes("comet") || source.includes("stremthru")) return false;

      const t = item.title; 
      const tLower = t.toLowerCase();
      
      const parsedLangInfo = getLanguageInfo(t, meta.title, item.source, parseTitleDetails(t));

      if (langMode === "ita") {
           if (!parsedLangInfo.isItalian) return false;

           const looksLikeSubOnly = REGEX_SUB_ONLY.test(t);
           const hasConfirmedAudio = REGEX_AUDIO_CONFIRM.test(t);
           if (looksLikeSubOnly && !hasConfirmedAudio) {
               const cleanTitleNoSub = t.replace(REGEX_SUB_ONLY, "");
               const langWithoutSub = getLanguageInfo(cleanTitleNoSub, meta.title, item.source, parseTitleDetails(cleanTitleNoSub));
               if (!langWithoutSub.isItalian) return false;
           }
      }
      else if (langMode === "eng") {
           if (parsedLangInfo.isItalian) return false;
      }
      
      const metaYear = parseInt(meta.year);
      if (metaYear === 2025 && /frankenstein/i.test(meta.title)) {
           if (!item.title.includes("2025")) return false;
      }

      if (!isNaN(metaYear)) {
           const fileYearMatch = item.title.match(REGEX_YEAR);
           if (fileYearMatch) {
               const fileYear = parseInt(fileYearMatch[0]);
               if (Math.abs(fileYear - metaYear) > 1) return false; 
           }
      }

      if (!meta.isSeries) {
          const shortQueries = [meta.title, meta.originalTitle]
              .filter(Boolean)
              .map(q => normalizeSearchText(q))
              .filter(q => q.length >= 2 && q.length <= 8);

          if (shortQueries.length > 0) {
              const matchedShortQuery = shortQueries.some(q => isGoodShortQueryMatch(item.title, q));
              if (!matchedShortQuery) return false;
          }
      }

      if (meta.isSeries) {
          const s = meta.season;
          const e = meta.episode;
          
          if (meta.kitsu_id || type === 'anime') {
              const absoluteEpRegex = new RegExp(`(?:^|\\s|[.\\-_\\[\\(])(?:e|ep|episode)?\\s*0*${e}(?:$|\\s|[.\\-_\\]\\)]|v\\d)`, 'i');
              if (absoluteEpRegex.test(tLower)) return true;
          }

          const wrongSeasonRegex = /(?:s|stagione|season)\s*0?(\d+)(?!\d)/gi;
          let match;
          while ((match = wrongSeasonRegex.exec(tLower)) !== null) {
              const foundSeason = parseInt(match[1]);
              if (foundSeason !== s && !meta.kitsu_id) return false; 
          }

          const xMatch = tLower.match(/(\d+)x(\d+)/i);
          if (xMatch) {
              if (parseInt(xMatch[1]) !== s && !meta.kitsu_id) return false;
              if (parseInt(xMatch[2]) !== e) return false;
              return true;
          }

          const hasRightSeason = new RegExp(`(?:s|stagione|season|^)\\s*0?${s}(?!\\d)`, 'i').test(tLower);
          const hasRightEpisode = new RegExp(`(?:e|x|ep|episode|^)\\s*0?${e}(?!\\d)`, 'i').test(tLower);
          
          const hasAnyEpisodeTag = /(?:e|x|ep|episode)\s*0?\d+/i.test(tLower);
          const isExplicitPack = isSeasonPack(tLower);
          
          if (hasRightSeason && hasRightEpisode) return true;
          
          if (hasRightSeason && (isExplicitPack || !hasAnyEpisodeTag)) {
              item._isPack = true; 
              return true;
          }
          return false;
      } else {
          if (/\b(?:S\d{2}|SEASON|STAGIONE)\b/i.test(t)) return false;
          if (/\b\d{1,2}x\d{1,2}\b/.test(t)) return false;
      }

      const cleanFile = tLower.replace(/[\.\_\-\(\)\[\]]/g, " ").replace(/\s{2,}/g, " ").trim();
      const cleanMeta = meta.title.toLowerCase().replace(/[\.\_\-\(\)\[\]]/g, " ").replace(/\s{2,}/g, " ").trim();
      const metaTitleShort = meta.title.split(/ - |: /)[0].toLowerCase().trim();
      const metaOriginal = (meta.originalTitle || "").toLowerCase().trim();

      const checkMatch = (strToCheck) => {
          if (!strToCheck) return false;
          let searchKeyword = strToCheck.replace(/^(the|a|an|il|lo|la|i|gli|le)\s+/i, "").trim();
          if (searchKeyword === "rip") {
               const strictStartRegex = /^(the\s+|il\s+)?rip\b/i;
               return strictStartRegex.test(cleanFile);
          }
          if (!isGoodShortQueryMatch(cleanFile, searchKeyword)) return false;
          if (searchKeyword.length <= 3) {
              const escaped = searchKeyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
              const regexShort = new RegExp(`\\b${escaped}\\b`, 'i');
              return regexShort.test(cleanFile);
          }
          return cleanFile.includes(searchKeyword);
      };

      if (checkMatch(cleanMeta)) return true;          
      if (checkMatch(metaTitleShort)) return true;  
      if (checkMatch(metaOriginal)) return true;      
      if (smartMatch(meta.title, item.title, meta.isSeries, meta.season, meta.episode)) return true;
      
      return false;
  };

  const remotePromise = Cache.fetchWithCache('RemoteIndexer', `${type}:${tmdbIdLookup || finalId}:${meta.season}:${meta.episode}`, 43200, () =>
      withTimeout(
          queryRemoteIndexer(tmdbIdLookup, type, meta.season, meta.episode, config),
          CONFIG.TIMEOUTS.REMOTE_INDEXER,
          'Remote Indexer'
      )
  );

  let externalPromise = Promise.resolve([]);
  if (!dbOnlyMode) {
      externalPromise = Cache.fetchWithCache('ExternalAddons', `${type}:${finalId}`, 43200, () =>
          fetchExternalResults(type, finalId, config)
      );
  }

  const [remoteResults, externalResults] = await Promise.all([
      remotePromise, 
      externalPromise
  ]);
  
  logger.info(`📊 [STATS] Remote: ${remoteResults.length} | External: ${externalResults.length}`);

  let fastResults = [...remoteResults, ...externalResults].filter(aggressiveFilter);
  let cleanResults = deduplicateResults(fastResults);
  let validFastCount = cleanResults.length;
  logger.info(`⚡ [FAST CHECK] Trovati ${validFastCount} risultati validi da fonti veloci (Remote+External).`);

  if (validFastCount === 0 && !dbOnlyMode) {
      logger.info(`⚠️ [FALLBACK] 0 risultati utili da Indexer/External. Avvio Scrapers in background...`);
      let dynamicTitles = [];
      try {
          if (tmdbIdLookup) dynamicTitles = await getTmdbAltTitles(tmdbIdLookup, type, userTmdbKey);
      } catch (e) {}
      
      const allowEngScraper = (langMode === "all" || langMode === "eng");
      const queries = generateSmartQueries(meta, dynamicTitles, allowEngScraper);
      
      if (queries.length > 0) {
          const allScraperTasks = [];
          queries.forEach(q => {
              SCRAPER_MODULES.forEach(scraper => {
                  if (scraper.searchMagnet) {
                      const searchOptions = { allowEng: allowEngScraper };
                      allScraperTasks.push(
                          LIMITERS.scraper.schedule(() => 
                              withTimeout(
                                  scraper.searchMagnet(q, meta.year, type, finalId, searchOptions),
                                  CONFIG.TIMEOUTS.SCRAPER,
                                  `Scraper ${scraper.name || 'Module'}`
                              ).catch(err => {
                                  logger.warn(`Scraper Timeout/Error: ${err.message}`);
                                  return [];
                              })
                          )
                      );
                  }
              });
          });
          
          const scrapedResultsRaw = await Promise.all(allScraperTasks).then(results => results.flat());
          const scrapedResultsFiltered = scrapedResultsRaw.filter(aggressiveFilter);
          
          cleanResults = deduplicateResults([...cleanResults, ...scrapedResultsFiltered]);
          validFastCount = cleanResults.length;
          
          logger.info(`📊 [STATS SCRAPER] Trovati e filtrati ${validFastCount} risultati aggiuntivi dagli Scraper.`);
      }
  }

  if (!dbOnlyMode) {
      saveResultsToDbBackground(meta, cleanResults, config);
  }

  if (config.filters) {
      cleanResults = cleanResults.filter(item => {
          const t = (item.title || "").toLowerCase();
          if (config.filters.maxSizeGB && config.filters.maxSizeGB > 0) {
              const maxBytes = config.filters.maxSizeGB * 1024 * 1024 * 1024;
              const itemSize = item._size || item.sizeBytes || 0;
              if (itemSize > 0 && itemSize > maxBytes) return false;
          }
          if (config.filters.no4k && REGEX_QUALITY_FILTER["4K"].test(t)) return false;
          if (config.filters.no1080 && REGEX_QUALITY_FILTER["1080p"].test(t)) return false;
          if (config.filters.no720 && REGEX_QUALITY_FILTER["720p"].test(t)) return false;
          if (config.filters.noScr) {
                if (REGEX_QUALITY_FILTER["SD"].test(t)) return false;
                if (/\b(?:cam|hdcam|ts|telesync|screener|scr)\b/i.test(t)) return false;
          }
          if (config.filters.noCam && /\b(?:cam|hdcam|ts|telesync|screener|scr)\b/i.test(t)) return false;
          return true;
      });
  }

  let rankedList = rankAndFilterResults(cleanResults, meta, config);
  const sortMode = config.sort || (config.filters && config.filters.sort) || 'balanced';
  
  if (sortMode !== 'balanced') {
      rankedList.sort((a, b) => {
          const sizeA = a._size || a.sizeBytes || 0;
          const sizeB = b._size || b.sizeBytes || 0;
          if (sortMode === 'size') return sizeB - sizeA;
          if (sortMode === 'resolution') {
              const getResScore = (title) => {
                  const t = title.toLowerCase();
                  if (/2160p|4k|uhd/.test(t)) return 40;
                  if (/1080p|fhd/.test(t)) return 30;
                  if (/720p|hd/.test(t)) return 20;
                  return 10;
              };
              const scoreA = getResScore(a.title);
              const scoreB = getResScore(b.title);
              if (scoreA !== scoreB) return scoreB - scoreA;
              return sizeB - sizeA;
          }
          return 0;
      });
  }

  if (config.filters && config.filters.maxPerQuality) {
      rankedList = filterByQualityLimit(rankedList, config.filters.maxPerQuality);
  }

  if (config.service === 'tb' && hasDebridKey) {
      const apiKey = config.key || config.rd; 
      const checkLimit = 30; 
      const candidates = rankedList.slice(0, checkLimit);
      const remainingItems = rankedList.slice(checkLimit);

      if (candidates.length > 0) {
          logger.info(`📦 [TB CHECK] Scansiono ${candidates.length} torrent alla ricerca di file video reali...`);
          
          const cacheResults = await TbCache.checkCacheSync(candidates, apiKey, dbHelper, checkLimit);
          const verifiedList = [];

          for (const item of candidates) {
              const hash = item.hash.toLowerCase();
              const result = cacheResults[hash];
              if (result && result.cached === true) {
                  item._tbCached = true;
                  if (result.file_size) {
                      item._size = result.file_size;
                  }
                  if (result.file_id !== undefined && result.file_id !== null) {
                      item.fileIdx = result.file_id;
                  }
                  verifiedList.push(item);
              }
          }

          logger.info(`📦 [TB CLEANUP] Iniziali: ${candidates.length} -> Rimasti: ${verifiedList.length}`);
          rankedList = verifiedList;
          if (remainingItems.length > 0) {
              TbCache.enrichCacheBackground(remainingItems, apiKey, dbHelper);
          }
      } else {
          rankedList = [];
      }
  }

  let finalRanked = rankedList.slice(0, CONFIG.MAX_RESULTS);
  const ranked = finalRanked;

  let debridStreams = [];
  
  if (ranked.length > 0 && hasDebridKey) {
      const TOP_LIMIT = Math.max(0, Math.min(10, parseInt(config.filters?.instantDebridTop ?? process.env.INSTANT_DEBRID_TOP ?? '0', 10) || 0)); 
      
      const topItems = ranked.slice(0, TOP_LIMIT);
      const lazyItems = ranked.slice(TOP_LIMIT);

      const immediatePromises = topItems.map(item => {
          item.season = meta.season;
          item.episode = meta.episode;
          config.rawConf = userConfStr; 
          return LIMITERS.rd.schedule(() => resolveDebridLink(config, item, config.filters?.showFake, reqHost, meta));
      });

      const lazyStreams = lazyItems.map(item =>
          generateLazyStream(item, config, meta, reqHost, userConfStr, true)
      );

      const resolvedInstant = (await Promise.all(immediatePromises)).filter(Boolean);
      debridStreams = [...resolvedInstant, ...lazyStreams];
  } 
  else if (ranked.length > 0 && isP2PEnabled) {
      logger.info(`⚡ [P2P MODE] Generating direct streams for ${meta.title}`);
      debridStreams = ranked.map(item => P2P.formatP2PStream(item, config));
  }

  let rawVix = [], formattedGhd = [], formattedGs = [], formattedVix = [], formattedAw = [], formattedGf = [];

  if (!dbOnlyMode) {
       const rawId = `${type}:${finalId}:${meta.season || 0}:${meta.episode || 0}`;

       const vixPromise = Cache.fetchWithCache('Vix', rawId, 43200, () => searchVix(meta, config, reqHost));
       
       let ghdPromise = Promise.resolve([]);
       if (config.filters && config.filters.enableGhd) {
           ghdPromise = Cache.fetchWithCache('GuardaHD', rawId, 43200, () => searchGuardaHD(meta, config));
       }

       let gsPromise = Promise.resolve([]);
       if (config.filters && config.filters.enableGs) {
           gsPromise = Cache.fetchWithCache('GuardaSerie', rawId, 43200, () => searchGuardaserie(meta, config));
       }

       let awPromise = Promise.resolve([]);
       if (config.filters && config.filters.enableAnimeWorld) {
           awPromise = Cache.fetchWithCache('AnimeWorld', rawId, 43200, () => searchAnimeWorld(id, meta, config));
       }

       let gfPromise = Promise.resolve([]);
       if (config.filters && config.filters.enableGf) {
           gfPromise = Cache.fetchWithCache('GuardaFlix', rawId, 43200, () => searchGuardaFlix(meta, config));
       }

       [rawVix, formattedGhd, formattedGs, formattedAw, formattedGf] = await Promise.all([vixPromise, ghdPromise, gsPromise, awPromise, gfPromise]);
       
       if (aioFormatter && aioFormatter.isAIOStreamsEnabled(config)) {
           const applyAioStyle = (streamList, sourceName) => {
               if (!streamList || !Array.isArray(streamList)) return;
               streamList.forEach((stream, index) => {
                   let quality = "HD";
                   let qIcon = "📺";
                   let textToCheck = (stream.title + " " + (stream.name || "")).toUpperCase();
                   textToCheck = textToCheck
                       .replace("GUARDAHD", "")
                       .replace("STREAMINGCOMMUNITY", "")
                       .replace("LEVIATHAN", "")
                       .replace("VIX", "")
                       .replace("GUARDAFLIX", "");
                   const regex4k = /\b(4K|2160P|UHD)\b/;
                   const regex1080 = /\b(1080P|FHD|FULLHD)\b/;
                   const regex720 = /\b(720P|HD)\b/;
                   const regexSD = /\b(480P|SD)\b/;
                   if (regex4k.test(textToCheck)) { quality = "4K"; qIcon = "🔥"; }
                   else if (regex1080.test(textToCheck)) { quality = "1080p"; qIcon = "🔥"; }
                   else if (regex720.test(textToCheck)) { quality = "720p"; qIcon = "🔥"; }
                   else if (regexSD.test(textToCheck)) { quality = "SD"; qIcon = "🔥"; }
                   else { quality = "WebStreams"; }
                   
                   if (sourceName.includes("StreamingCommunity") || sourceName.includes("Vix")) {
                       if (quality === "SD" && !regexSD.test(textToCheck)) {
                           quality = "1080p"; qIcon = "🔥";
                       }
                   }
                   const techStr = `🎞️ ${quality} ${qIcon}`;
                   stream.name = aioFormatter.formatStreamName({
                       service: "web", 
                       cached: true,
                       quality: quality
                   });
                   stream.title = aioFormatter.formatStreamTitle({
                       title: meta.title,  
                       size: "Web",        
                       language: "🇮🇹 ITA",
                       source: sourceName, 
                       seeders: null,
                       techInfo: techStr 
                   });
                   if (!stream.behaviorHints) stream.behaviorHints = {};
                   stream.behaviorHints.bingieGroup = `Leviathan|${quality}|Web|${sourceName.replace(/\W/g,'')}`;
               });
           };
           if (typeof rawVix !== 'undefined') applyAioStyle(rawVix, "StreamingCommunity");
           if (typeof formattedGhd !== 'undefined') applyAioStyle(formattedGhd, "GuardaHD");
           if (typeof formattedGs !== 'undefined') applyAioStyle(formattedGs, "GuardaSerie");
           if (typeof formattedGf !== 'undefined') applyAioStyle(formattedGf, "GuardaFlix");
           
           if (typeof formattedAw !== 'undefined' && formattedAw.length > 0) {
               formattedAw.forEach(stream => {
                   stream.name = aioFormatter.formatStreamName({ service: "web", cached: true, quality: "HD" });
                   stream.title = aioFormatter.formatStreamTitle({
                       title: meta.title, 
                       size: "Web", 
                       language: "🇯🇵 JPN/ITA", 
                       source: "AnimeWorld", 
                       techInfo: "⛩️ Anime"
                   });
                   if (!stream.behaviorHints) stream.behaviorHints = {};
                   stream.behaviorHints.bingieGroup = `Leviathan|HD|Web|AnimeWorld`;
               });
           }
           formattedVix = rawVix; 
       } else {
           if (rawVix && rawVix.length > 0) 
               formattedVix = applyWebFormatter(rawVix, "StreamingCommunity", meta, config);
           
           if (formattedGhd && formattedGhd.length > 0) 
               formattedGhd = applyWebFormatter(formattedGhd, "GuardaHD", meta, config);
           
           if (formattedGs && formattedGs.length > 0) 
               formattedGs = applyWebFormatter(formattedGs, "GuardaSerie", meta, config);
           
           if (formattedAw && formattedAw.length > 0) 
               formattedAw = applyWebFormatter(formattedAw, "AnimeWorld", meta, config);

           if (formattedGf && formattedGf.length > 0) 
               formattedGf = applyWebFormatter(formattedGf, "GuardaFlix", meta, config);
       }
  }

  let finalStreams = [];
  if (config.filters && config.filters.vixLast === true) {
      finalStreams = [...debridStreams, ...formattedGhd, ...formattedGs, ...formattedAw, ...formattedGf, ...formattedVix];
  } else {
      finalStreams = [...formattedGhd, ...formattedGs, ...formattedAw, ...formattedGf, ...formattedVix, ...debridStreams];
  }

  if (config.filters) {
      finalStreams = finalStreams.filter(stream => {
          const checkStr = (stream.title + " " + (stream.name || "")).toUpperCase();
          if (config.filters.no720) {
              if (checkStr.includes("720P")) return false;
              const isGenericHD = /\bHD\b/.test(checkStr) && !/1080|2160|4K|FHD|UHD/.test(checkStr);
              if (isGenericHD) return false;
          }
          if (config.filters.no4k && (checkStr.includes("4K") || checkStr.includes("2160P") || checkStr.includes("UHD"))) return false;
          if (config.filters.no1080 && (checkStr.includes("1080P") || checkStr.includes("FHD") || checkStr.includes("FULLHD"))) return false;
          if ((config.filters.noScr || config.filters.noCam) && /CAM|SCR|TS|TELESYNC|HDCAM/.test(checkStr)) return false;
          return true;
      });
  }

  if (finalStreams.length === 0) {
      logger.info(`⚠️ [FALLBACK] Nessun risultato trovato (P2P/Web Locali). Attivo WebStreamr...`);
      const webStreamrResults = await searchWebStreamr(type, finalId);
      if (webStreamrResults.length > 0) {
           finalStreams.push(...webStreamrResults);
           logger.info(`🕷️ [WEBSTREAMR] Aggiunti ${webStreamrResults.length} stream di fallback.`);
      } else {
           logger.info(`❌ [WEBSTREAMR] Nessun risultato trovato.`);
      }
  }

  if (config.filters && config.filters.enableTrailers) {
      try {
         if (meta && meta.title) {
             const trailerStreams = await getTrailerStreams(
                 type,
                 meta.imdb_id,
                 meta.title,
                 meta.season,
                 meta.tmdb_id,
                 'it-IT'
             );
             if (trailerStreams && trailerStreams.length > 0) {
                 finalStreams.unshift(...trailerStreams);
                 logger.info(`🎬 [TRAILER] Aggiunto trailer in testa per: ${meta.title}`);
             }
         }
      } catch (err) {
         logger.warn(`⚠️ Errore recupero Trailer: ${err.message}`);
      }
  }
  
  const resultObj = { streams: finalStreams };
  const streamTtl = finalStreams.length > 0 ? 1800 : EMPTY_STREAM_TTL;
  await Cache.cacheStream(cacheKey, resultObj, streamTtl);
  logger.info(`💾 SAVED TO CACHE: ${cacheKey} (ttl=${streamTtl}s, streams=${finalStreams.length})`);
  return resultObj;
  });
}

app.get("/api/stats", (req, res) => res.json({ status: "ok" }));
app.get("/favicon.ico", (req, res) => res.status(204).end());

app.get("/:conf/play_lazy/:service/:hash/:fileIdx", async (req, res) => {
    const { conf, service, hash, fileIdx } = req.params;
    const { s, e } = req.query; 
    logger.info(`▶️ [LAZY PLAY] Service: ${service} | Hash: ${hash} | Idx: ${fileIdx} | S${s}E${e}`);
    try {
        const config = getConfig(conf);
        const apiKey = config.key || config.rd;
        if (!apiKey) return res.status(400).send("API Key mancante.");
        const trackers = [
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
        const trackerStr = trackers.map(tr => `&tr=${tr}`).join(""); 
        const magnet = `magnet:?xt=urn:btih:${hash}${trackerStr}`;
        const item = {
            title: `Unknown Video (${hash})`,
            hash: hash,
            season: parseInt(s) || 0,
            episode: parseInt(e) || 0,
            fileIdx: parseInt(fileIdx) === -1 ? undefined : parseInt(fileIdx),
            magnet: magnet 
        };
        const lazyCacheKey = `${service}:${item.hash}:${item.season || 0}:${item.episode || 0}:${item.fileIdx !== undefined ? item.fileIdx : -1}`;
        const cachedLazy = await Cache.getLazyLink(lazyCacheKey);
        if (cachedLazy && cachedLazy.url) {
            return res.redirect(cachedLazy.url);
        }

        let streamData = null;
        if (service === 'tb') {
             const tbFileIdx = item.fileIdx !== undefined ? String(item.fileIdx) : undefined;
             const tbS = String(item.season);
             const tbE = String(item.episode);
             streamData = await TB.getStreamLink(apiKey, item.magnet, tbS, tbE, item.hash, tbFileIdx);
        }
        else if (service === 'rd') {
            streamData = await LIMITERS.rd.schedule(() => RD.getStreamLink(apiKey, item.magnet, item.season, item.episode, item.fileIdx));
        }
        else if (service === 'ad') {
            const safeFileIdx = item.fileIdx !== undefined ? item.fileIdx : 0;
            streamData = await LIMITERS.rd.schedule(() => AD.getStreamLink(apiKey, item.magnet, item.season, item.episode, safeFileIdx));
        }
        if (streamData && streamData.url) {
            await Cache.cacheLazyLink(lazyCacheKey, streamData, 180);
            if (config.mediaflow && config.mediaflow.proxyDebrid && config.mediaflow.url) {
                try {
                    const mfpBase = config.mediaflow.url.replace(/\/$/, '');
                    let finalUrl = `${mfpBase}/proxy/stream?d=${encodeURIComponent(streamData.url)}`;
                    if (config.mediaflow.pass) finalUrl += `&api_password=${config.mediaflow.pass}`;
                    return res.redirect(finalUrl);
                } catch (e) {}
            }
            return res.redirect(streamData.url);
        } 
        const protocol = req.headers['x-forwarded-proto'] || req.protocol;
        const host = `${protocol}://${req.get('host')}`;
        const addToCloudUrl = `${host}/${conf}/add_to_cloud/${hash}`;
        return res.redirect(addToCloudUrl);
    } catch (err) {
        logger.error(`Error Lazy Play: ${err.message}`);
        res.status(500).send("Errore nel recupero del link: " + err.message);
    }
});

app.get("/:conf/play_tb/:hash", async (req, res) => {
    const { conf, hash } = req.params;
    const { s, e, f } = req.query; 
    res.redirect(`/${conf}/play_lazy/tb/${hash}/${f || -1}?s=${s}&e=${e}`);
});

app.get("/:conf/add_to_cloud/:hash", async (req, res) => {
    const { conf, hash } = req.params;
    try {
        const config = getConfig(conf);
        const apiKey = config.key || config.rd;
        const service = String(config.service || 'rd').toLowerCase();
        if (!apiKey) return res.status(400).send("API Key mancante.");

        const buildKey = getBuildKey(service, hash, apiKey);
        const recentBuild = await Cache.getCloudBuild(buildKey);
        const now = Date.now();
        const isRecent = recentBuild && (now - Number(recentBuild.queuedAt || 0) < 120000) && ['queued', 'submitted'].includes(recentBuild.status);

        if (isRecent) {
            logger.info(`📥 [CACHE BUILDER] Già in coda ${hash} su ${service.toUpperCase()} - salto duplicato`);
        } else {
            logger.info(`📥 [CACHE BUILDER] Richiesta aggiunta hash ${hash} su ${service.toUpperCase()}`);
            await queueCloudBuild(service, hash, apiKey);
        }

        const protocol = req.headers['x-forwarded-proto'] || req.protocol;
        const host = `${protocol}://${req.get('host')}`;
        const feedbackVideoUrl = `${host}/confirmed.mp4`;
        res.redirect(feedbackVideoUrl);
    } catch (err) {
        logger.error(`Errore Cache Builder: ${err.message}`);
        res.status(500).send("Errore durante l'aggiunta al cloud: " + err.message);
    }
});

const authMiddleware = (req, res, next) => {
    if (!ADMIN_PASS) {
        logger.warn("Tentativo di accesso admin con ADMIN_PASS non configurata");
        return res.status(503).json({ error: "Admin disabilitato: configura ADMIN_PASS nell'ambiente" });
    }

    const rawAuthHeader = String(req.headers['authorization'] || '').trim();
    const authHeader = rawAuthHeader.toLowerCase().startsWith('bearer ')
        ? rawAuthHeader.slice(7).trim()
        : rawAuthHeader;

    if (safeCompare(authHeader, ADMIN_PASS)) return next();
    return res.status(403).json({ error: "Password errata" });
};
app.get("/admin/keys", authMiddleware, async (req, res) => { res.json(await Cache.listKeys()); });
app.delete("/admin/key", authMiddleware, async (req, res) => {
  const { key } = req.query;
  if (key) { await Cache.deleteKey(key); res.json({ success: true }); } 
  else res.json({ error: "Key mancante" });
});
app.post("/admin/flush", authMiddleware, async (req, res) => {
  await Cache.flushAll();
  res.json({ success: true });
});

app.get("/health", async (req, res) => {
  const checks = { status: "ok", timestamp: new Date().toISOString(), services: {} };
  try {
    if (dbHelper.healthCheck) await withTimeout(dbHelper.healthCheck(), 1000, "DB Health");
    checks.services.database = "ok (Write-Only)";
  } catch (err) {
    checks.services.database = "down";
    checks.status = "degraded";
    logger.error("Health Check DB Fail", { error: err.message });
  }
  try {
    if (!CONFIG.INDEXER_URL) {
      checks.services.indexer = "disabled";
    } else {
      await withTimeout(axios.get(`${CONFIG.INDEXER_URL}/health`, { timeout: 1000 }), 1000, "Indexer Health");
      checks.services.indexer = "ok";
    }
  } catch (err) {
    checks.services.indexer = "down";
    checks.status = "degraded";
  }
  checks.services.cache = myCache.keys().length > 0 ? "active" : "empty";
  res.status(checks.status === "ok" ? 200 : 503).json(checks);
});

app.get("/", (req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));
app.get("/:conf/configure", (req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));
app.get("/configure", (req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));
app.get("/manifest.json", (req, res) => { res.setHeader("Access-Control-Allow-Origin", "*"); res.json(getManifest()); });

app.get("/:conf/manifest.json", (req, res) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    const manifest = getManifest();
    try {
        const { conf } = req.params;
        const config = getConfig(conf);
        
        const filters = config.filters || {};
        const langMode = filters.language || (filters.allowEng ? "all" : "ita");

        let flag = "";
        if (langMode === "ita") {
            flag = " 🇮🇹";        
        } else if (langMode === "eng") {
            flag = " 🇬🇧";        
        } else {
            flag = " 🇮🇹🇬🇧";      
        }

        const appName = "L E V I A T H A N";

        const hasRDKey = (config.service === 'rd' && config.key) || config.rd;
        const hasTBKey = (config.service === 'tb' && config.key) || config.torbox;
        const hasADKey = (config.service === 'ad' && config.key) || config.alldebrid;
        const isP2P = filters.enableP2P === true;

        if (hasRDKey) {
            manifest.name = `${appName}${flag} 🔱 RD`;
            manifest.id += ".rd"; 
        } 
        else if (hasTBKey) {
            manifest.name = `${appName}${flag} 🔱 TB`;
            manifest.id += ".tb";
        } 
        else if (hasADKey) {
            manifest.name = `${appName}${flag} 🐚 AD`;
            manifest.id += ".ad";
        }
        else if (isP2P) {
            manifest.name = `${appName}${flag} 🦈 P2P`;
            manifest.id += ".p2p";
            manifest.description += " | ⚠️ P2P Mode (IP Visible)";
        }
        else {
            manifest.name = `${appName}${flag} ⛵ Web`;
            manifest.id += ".web";
        }

    } catch (e) {
        console.error("Errore personalizzazione manifest:", e);
    }
    res.json(manifest);
});
app.get("/:conf/catalog/:type/:id/:extra?.json", async (req, res) => { res.setHeader("Access-Control-Allow-Origin", "*"); res.json({metas:[]}); });
app.get("/vixsynthetic.m3u8", handleVixSynthetic);

app.get("/:conf/stream/:type/:id.json", async (req, res) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    try {
        validateStreamRequest(req.params.type, req.params.id.replace('.json', ''));
        const { conf, type, id } = req.params;
        const cleanId = id.replace(".json", "");
        const protocol = req.headers['x-forwarded-proto'] || req.protocol;
        const host = `${protocol}://${req.get('host')}`;
        const result = await generateStream(type, cleanId, getConfig(conf), conf, host);
        res.json(result);
    } catch (err) {
        logger.error('Validazione/Stream Fallito', { error: err.message, params: req.params });
        return res.status(400).json({ streams: [] });
    }
});

function getBuildKey(service, hash, apiKey) {
    const tokenSig = crypto.createHash("sha1").update(String(apiKey || "")).digest("hex").slice(0, 12);
    return `${String(service || "").toLowerCase()}:${String(hash || "").toUpperCase()}:${tokenSig}`;
}

function buildTrackerMagnet(hash) {
    const trackers = [
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
    const trackerStr = trackers.map(tr => `&tr=${encodeURIComponent(tr)}`).join("");
    return `magnet:?xt=urn:btih:${String(hash || "").toUpperCase()}${trackerStr}`;
}

async function queueCloudBuild(service, hash, apiKey) {
    const buildKey = getBuildKey(service, hash, apiKey);
    const existingPromise = cloudBuildInflight.get(buildKey);
    if (existingPromise) return existingPromise;

    const task = (async () => {
        const magnet = buildTrackerMagnet(hash);
        await Cache.setCloudBuild(buildKey, { status: 'queued', service, hash: String(hash || '').toUpperCase(), queuedAt: Date.now() }, 900);

        if (service === 'rd') {
            await axios.post("https://api.real-debrid.com/rest/1.0/torrents/addMagnet", `magnet=${encodeURIComponent(magnet)}`, {
                headers: { "Authorization": `Bearer ${apiKey}`, "Content-Type": "application/x-www-form-urlencoded" }
            });
        } else if (service === 'ad') {
            await axios.get("https://api.alldebrid.com/v4/magnet/upload", {
                params: { agent: "leviathan", apikey: apiKey, magnet }
            });
        } else if (service === 'tb') {
            const body = new URLSearchParams();
            body.append('magnet', magnet);
            body.append('seed', '1');
            body.append('allow_zip', 'false');
            await axios.post("https://api.torbox.app/v1/api/torrents/createtorrent", body.toString(), {
                headers: { "Authorization": `Bearer ${apiKey}`, "Content-Type": "application/x-www-form-urlencoded" }
            });
        }

        await Cache.setCloudBuild(buildKey, { status: 'submitted', service, hash: String(hash || '').toUpperCase(), queuedAt: Date.now() }, 900);
        return { ok: true, duplicate: false };
    })().catch(async (err) => {
        const status = err?.response?.status;
        const body = err?.response?.data;
        const msg = typeof body === 'string' ? body : JSON.stringify(body || {});
        const duplicateLike = status === 409 || /already|duplicate|exists|same magnet|in progress/i.test(`${err.message} ${msg}`);
        if (duplicateLike) {
            await Cache.setCloudBuild(buildKey, { status: 'submitted', service, hash: String(hash || '').toUpperCase(), queuedAt: Date.now(), duplicate: true }, 900);
            return { ok: true, duplicate: true };
        }
        await Cache.setCloudBuild(buildKey, { status: 'error', service, hash: String(hash || '').toUpperCase(), queuedAt: Date.now(), error: err.message }, 120);
        throw err;
    }).finally(() => {
        cloudBuildInflight.delete(buildKey);
    });

    cloudBuildInflight.set(buildKey, task);
    return task;
}

function decodeConfigBase64(configStr) {
  const normalized = String(configStr || "")
    .trim()
    .replace(/-/g, "+")
    .replace(/_/g, "/");
  const padding = normalized.length % 4 === 0 ? "" : "=".repeat(4 - (normalized.length % 4));
  return Buffer.from(normalized + padding, "base64").toString("utf8");
}

function getConfig(configStr) {
  try {
    if (!configStr || typeof configStr !== "string") return {};
    if (configStr.length > MAX_CONFIG_LENGTH) {
      throw new Error(`Config troppo grande (${configStr.length})`);
    }
    const parsed = JSON.parse(decodeConfigBase64(configStr));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("Config non valida");
    }
    return parsed;
  } catch (err) {
    logger.error(`Errore parsing config: ${err.message}`);
    return {};
  }
}

const PORT = process.env.PORT || 7000;
const PUBLIC_IP = process.env.PUBLIC_IP || "127.0.0.1";
const PUBLIC_PORT = process.env.PUBLIC_PORT || PORT;

const server = app.listen(PORT, () => {
    console.log(`🚀 Leviathan (God Tier) attivo su porta interna ${PORT}`);
    console.log(`-----------------------------------------------------`);
    console.log(`⚡ MODE: FULL LAZY`);
    console.log(`🎬 SERIES: Full Lazy Mode`);
    console.log(`📡 INDEXER URL: ${CONFIG.INDEXER_URL}`);
    console.log(`🎬 METADATA: TMDB Primary`);
    console.log(`💾 SCRITTURA: DB Locale`);
    console.log(`❌ LETTURA DB LOCALE: DISABILITATA`);
    console.log(`👁️ SPETTRO VISIVO: Modulo Attivo`);
    console.log(`⚖️ SIZE LIMITER: Modulo Attivo`);
    console.log(`🦁 GUARDA HD: Modulo Integrato e Pronto`);
    console.log(`🛡️ GUARDA SERIE: Modulo Integrato e Pronto`);
    console.log(`⛩️ ANIMEWORLD: Modulo Integrato e Pronto`); 
    console.log(`🎥 GUARDA FLIX: Modulo Integrato`);
    console.log(`🕷️ WEBSTREAMR: Fallback Attivo`);
    console.log(`🎬 TRAILER: Attivabile da Config`);
    console.log(`📦 TORBOX: ADVANCED SMART CACHE`);
    console.log(`📝 PARSER: ENHANCED`); 
    console.log(`⚡ P2P: HANDLER ATTIVO`);
    console.log(`🦑 LEVIATHAN CORE: Optimized for High Reliability`);
    console.log(`🌍 LAYERED CACHING: GLOBAL RAW + USER LEVEL ACTIVE`);
    console.log(`⚡ SCRAPERS: Fallback Scrapers Ready!`);
    console.log(`-----------------------------------------------------`);
});


function gracefulShutdown(signal) {
    logger.info(`🛑 Ricevuto ${signal}, chiusura server in corso...`);
    server.close(() => {
        logger.info("✅ Server HTTP chiuso correttamente.");
        process.exit(0);
    });

    setTimeout(() => {
        logger.error("⏱️ Shutdown forzato per timeout.");
        process.exit(1);
    }, 10000).unref();
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

process.on('unhandledRejection', (reason) => {
    logger.error('Unhandled Promise Rejection', { reason: reason instanceof Error ? reason.message : String(reason) });
});

process.on('uncaughtException', (error) => {
    logger.error('Uncaught Exception', { error: error.message, stack: error.stack });
});
