const { tokenizeTitle: canonicalTokenizeTitle } = require('../canonical/title_parser');
const axios = require('axios');
const crypto = require('crypto');

const DEBUG_MODE = process.env.DEBUG_MODE === 'true';
const VIDEO_EXTENSIONS = /\.(mkv|mp4|avi|mov|wmv|flv|webm|m4v|ts|m2ts|mpg|mpeg|iso)$/i;
const MIN_VIDEO_BYTES = 25 * 1024 * 1024;
const RD_SCAN_DELAY_MS = Math.max(0, parseInt(process.env.PACK_RD_SCAN_DELAY_MS || '2000', 10) || 2000);
const MEMORY_TTL_MS = Math.max(30_000, parseInt(process.env.PACK_RESOLVER_TTL_MS || String(10 * 60 * 1000), 10) || 10 * 60 * 1000);
const NEGATIVE_CACHE_TTL_MS = Math.max(15_000, parseInt(process.env.PACK_RESOLVER_NEGATIVE_TTL_MS || String(2 * 60 * 1000), 10) || 2 * 60 * 1000);
const RD_INFO_RETRY_ATTEMPTS = Math.max(2, parseInt(process.env.PACK_RD_INFO_RETRY_ATTEMPTS || '4', 10) || 4);
const RD_INFO_RETRY_DELAY_MS = Math.max(250, parseInt(process.env.PACK_RD_INFO_RETRY_DELAY_MS || '900', 10) || 900);
const TB_INFO_RETRY_ATTEMPTS = Math.max(2, parseInt(process.env.PACK_TB_INFO_RETRY_ATTEMPTS || '4', 10) || 4);
const TB_INFO_RETRY_DELAY_MS = Math.max(500, parseInt(process.env.PACK_TB_INFO_RETRY_DELAY_MS || '1200', 10) || 1200);
const MAX_MEMORY_ENTRIES = Math.max(50, parseInt(process.env.PACK_RESOLVER_CACHE_SIZE || '500', 10) || 500);
const DB_MOVIE_FILE_LIMIT = Math.max(10, parseInt(process.env.PACK_DB_MOVIE_LIMIT || '30', 10) || 30);
const DB_SERIES_FILE_LIMIT = Math.max(25, parseInt(process.env.PACK_DB_SERIES_LIMIT || '400', 10) || 400);
const PACK_RD_QUEUE_MAX = Math.max(5, parseInt(process.env.PACK_RD_QUEUE_MAX || '200', 10) || 200);


const PUBLIC_TORRENT_CACHE_ENABLED = process.env.PACK_PUBLIC_TORRENT_CACHE !== 'false';
const PUBLIC_TORRENT_CACHE_TIMEOUT_MS = Math.max(2500, parseInt(process.env.PACK_PUBLIC_TORRENT_CACHE_TIMEOUT_MS || '8000', 10) || 8000);
const PUBLIC_TORRENT_CACHE_MAX_BYTES = Math.max(256 * 1024, parseInt(process.env.PACK_PUBLIC_TORRENT_CACHE_MAX_BYTES || String(8 * 1024 * 1024), 10) || 8 * 1024 * 1024);
const PUBLIC_TORRENT_CACHE_SOURCES = Object.freeze([
    { name: 'itorrents', url: (hash) => `https://itorrents.org/torrent/${hash.toUpperCase()}.torrent` },
    { name: 'torrage', url: (hash) => `https://torrage.info/torrent.php?h=${hash.toUpperCase()}` },
    { name: 'btcache', url: (hash) => `https://btcache.me/torrent/${hash.toUpperCase()}` }
]);


const TORBOX_CREATE_TORRENT_IN_PACK_RESOLVER = false;

class RequestQueue {
    constructor(concurrency = 1, maxQueued = 200) {
        this.concurrency = Math.max(1, concurrency);
        this.maxQueued = Math.max(1, maxQueued);
        this.running = 0;
        this.queue = [];
    }

    add(task) {
        return new Promise((resolve, reject) => {
            if ((this.running + this.queue.length) >= this.maxQueued) {
                const err = new Error(`PACK_RD_QUEUE_OVERFLOW max=${this.maxQueued}`);
                err.code = 'PACK_RD_QUEUE_OVERFLOW';
                reject(err);
                return;
            }
            this.queue.push(async () => {
                try {
                    resolve(await task());
                } catch (err) {
                    reject(err);
                }
            });
            this.process();
        });
    }

    async process() {
        if (this.running >= this.concurrency || this.queue.length === 0) return;
        this.running += 1;
        const task = this.queue.shift();
        try {
            await task();
        } finally {
            this.running -= 1;
            if (RD_SCAN_DELAY_MS > 0) await new Promise(r => setTimeout(r, RD_SCAN_DELAY_MS));
            this.process();
        }
    }
}

const rdQueue = new RequestQueue(1, PACK_RD_QUEUE_MAX);
const pendingScans = new Map();
const memoryCache = new Map();

const SEASON_EPISODE_PATTERNS = [
    { pattern: /(?:^|\b)s(\d{1,2})\s*e(\d{1,3})(?:\b|[^\d])/i, extract: m => ({ season: parseInt(m[1], 10), episode: parseInt(m[2], 10) }) },
    { pattern: /(?:^|\b)s(\d{1,2})\s*[-–—]\s*e(?:p)?\.?(\d{1,3})(?!\d)/i, extract: m => ({ season: parseInt(m[1], 10), episode: parseInt(m[2], 10) }) },
    { pattern: /(?:^|\b)s(\d{1,2})\s*[-–—]\s*(\d{1,3})(?!\d)/i, extract: m => ({ season: parseInt(m[1], 10), episode: parseInt(m[2], 10) }) },
    { pattern: /(?:^|\b)(\d{1,2})x(\d{1,3})(?:\b|[^\d])/i, extract: m => ({ season: parseInt(m[1], 10), episode: parseInt(m[2], 10) }) },
    { pattern: /season\s*(\d{1,2}).{0,20}?episode\s*(\d{1,3})/i, extract: m => ({ season: parseInt(m[1], 10), episode: parseInt(m[2], 10) }) },
    { pattern: /stagione\s*(\d{1,2}).{0,20}?episodio\s*(\d{1,3})/i, extract: m => ({ season: parseInt(m[1], 10), episode: parseInt(m[2], 10) }) },
    { pattern: /(?:^|[^a-z])ep?\.?\s*(\d{1,3})(?:[^\d]|$)/i, extract: (m, defaultSeason) => ({ season: defaultSeason, episode: parseInt(m[1], 10) }) },
    { pattern: /[-–—]\s*(\d{1,3})\s*[-–—]/, extract: (m, defaultSeason) => ({ season: defaultSeason, episode: parseInt(m[1], 10) }) }
];

function isAnimeMeta(meta = {}) {
    return Boolean(meta?.kitsu_id || meta?.isAnime);
}

function normalizeAnimeEpisodeText(value) {
    return String(value || '')
        .normalize('NFKC')
        .replace(/[【】「」『』［］（）]/g, ' ')
        .replace(/[‐‑–—―〜～]/g, '-')
        .replace(/[·・]/g, ' ')
        .replace(/第\s*([0-9]{1,2})\s*[期季]/gi, ' season $1 ')
        .replace(/第\s*([0-9]{1,4})\s*[話话]/gi, ' episode $1 ')
        .replace(/\b(?:cour|part|pt)\s*([0-9]{1,2})\b/gi, ' season $1 ')
        .replace(/\s+/g, ' ')
        .trim();
}

function extractAnimeEpisodeRange(filename, defaultSeason = 1) {
    const name = normalizeAnimeEpisodeText(filename);
    const patterns = [
        /\bseason\s*0?(\d{1,2})\s*(?:batch|pack|complete|collection)?\s*0?(\d{1,3})\s*(?:-|~|to|a)\s*0?(\d{1,3})\b/i,
        /\b(?:episodes?|eps?|episode|episodio)\s*0?(\d{1,3})\s*(?:-|~|to|a)\s*0?(\d{1,3})\b/i,
        /\b0?(\d{1,3})\s*(?:-|~|to|a)\s*0?(\d{1,3})\b/i
    ];

    for (const pattern of patterns) {
        const match = name.match(pattern);
        if (!match) continue;
        const hasExplicitSeason = pattern === patterns[0];
        const season = hasExplicitSeason ? parseInt(match[1], 10) : defaultSeason;
        const start = parseInt(match[hasExplicitSeason ? 2 : 1], 10);
        const end = parseInt(match[hasExplicitSeason ? 3 : 2], 10);
        if (!Number.isInteger(start) || !Number.isInteger(end) || start <= 0 || end < start) continue;
        if (start >= 1900 && start <= 2100) continue;
        if (end >= 1900 && end <= 2100) continue;
        const hasBatchCue = /\b(?:batch|complete|collection|pack|season|stagione|episodes?|eps?|cour|全集|合集)\b/i.test(name) || /第\s*\d+\s*[話话]/i.test(String(filename || ''));
        if (!hasBatchCue && end - start > 4) continue;
        return { season, episode: start, rangeStart: start, rangeEnd: end, isRange: true, isBatch: true };
    }

    return null;
}

function parseAnimeEpisode(filename, defaultSeason = 1) {
    const originalValue = String(filename || '');
    const value = normalizeAnimeEpisodeText(originalValue);
    let match = value.match(/\bS(?:EASON)?\s*0?(\d{1,2})\s*[-._ ]+\s*0?(\d{1,4})(?:v\d+)?\b(?!\s*(?:-|~|to|a)\s*0?\d{1,3}\b)/i);
    if (match) return { season: parseInt(match[1], 10), episode: parseInt(match[2], 10) };

    match = value.match(/\b(\d{1,2})(?:ST|ND|RD|TH)\s+SEASON\s*[-._ ]+\s*0?(\d{1,4})(?:v\d+)?\b(?!\s*(?:-|~|to|a)\s*0?\d{1,3}\b)/i);
    if (match) return { season: parseInt(match[1], 10), episode: parseInt(match[2], 10) };

    match = value.match(/\bSEASON\s*0?(\d{1,2}).{0,16}?EP(?:ISODE)?\s*0?(\d{1,4})(?:v\d+)?\b/i);
    if (match) return { season: parseInt(match[1], 10), episode: parseInt(match[2], 10) };

    match = value.match(/\b(?:EP(?:ISODE)?|EPISODIO)\s*0?(\d{1,4})(?:v\d+)?\b(?!\s*(?:-|~|to|a)\s*0?\d{1,3}\b)/i);
    if (match) return { season: defaultSeason, episode: parseInt(match[1], 10) };

    const range = extractAnimeEpisodeRange(originalValue, defaultSeason);
    if (range) return range;

    match = value.match(/(?:^|\s)#?0*([1-9]\d{0,3})(?:v\d+)?(?=$|\s)/i);
    if (match) {
        const episode = parseInt(match[1], 10);
        if (!(episode >= 1900 && episode <= 2100) && ![2160, 1080, 720, 576, 480, 360, 264, 265].includes(episode)) {
            return { season: defaultSeason, episode };
        }
    }

    const genericPattern = /(?:^|[\s._\-\[\(])0*([1-9]\d{0,3})(?:v\d+)?(?=$|[\s._\-\]\)])/ig;
    for (const candidate of value.matchAll(genericPattern)) {
        const episode = parseInt(candidate[1], 10);
        if (!Number.isInteger(episode) || episode <= 0) continue;
        if (episode >= 1900 && episode <= 2100) continue;
        if ([2160, 1080, 720, 576, 480, 360, 264, 265].includes(episode)) continue;
        return { season: defaultSeason, episode };
    }

    return null;
}

function normalizeInfoHash(value) {
    return String(value || '').trim().toLowerCase();
}

function cacheGet(key) {
    const entry = memoryCache.get(key);
    if (!entry) return null;
    if (entry.expiresAt <= Date.now()) {
        memoryCache.delete(key);
        return null;
    }
    entry.lastAccess = Date.now();
    return entry.value;
}

function cacheSet(key, value, ttlMs = MEMORY_TTL_MS) {
    memoryCache.set(key, { value, expiresAt: Date.now() + ttlMs, lastAccess: Date.now() });
    if (memoryCache.size <= MAX_MEMORY_ENTRIES) return;
    const entries = [...memoryCache.entries()].sort((a, b) => a[1].lastAccess - b[1].lastAccess);
    while (entries.length > MAX_MEMORY_ENTRIES) {
        const [oldestKey] = entries.shift();
        memoryCache.delete(oldestKey);
    }
}

function buildCacheKey(infoHash, service) {
    return `${service || 'auto'}:${normalizeInfoHash(infoHash)}`;
}

function buildDbCacheKey(infoHash, isSeries = false) {
    return buildCacheKey(infoHash, isSeries ? 'db-series' : 'db-movie');
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function getErrorStatus(err) {
    const status = Number(err?.response?.status || err?.status || 0);
    return Number.isInteger(status) && status > 0 ? status : null;
}

function isExpectedResolverMissError(err) {
    return getErrorStatus(err) === 404 || err?.expectedMiss === true;
}

function buildNegativePackPayload(infoHash, service, reason, err = null) {
    return {
        infoHash,
        service: service || 'unknown',
        torrentId: null,
        files: [],
        packName: null,
        scannedAt: Date.now(),
        negative: true,
        missReason: reason || 'unavailable',
        errorStatus: getErrorStatus(err)
    };
}

function createExpectedMissError(message, reason = 'unavailable', status = 404) {
    const err = new Error(message || 'PACK_RESOLVER_MISS');
    err.expectedMiss = true;
    err.status = status;
    err.reason = reason;
    return err;
}

function isValidInfoHash(value) {
    return /^[a-f0-9]{40}$/i.test(String(value || '').trim());
}

function getBufferString(value) {
    return Buffer.isBuffer(value) ? value.toString('utf8') : String(value || '');
}

function parseBencodeByteString(buffer, offset) {
    const colonIndex = buffer.indexOf(58, offset);
    if (colonIndex === -1) throw new Error('BT_STRING_LENGTH_MISSING');
    const lenText = buffer.subarray(offset, colonIndex).toString('ascii');
    if (!/^\d+$/.test(lenText)) throw new Error('BT_STRING_LENGTH_INVALID');
    const length = Number.parseInt(lenText, 10);
    const start = colonIndex + 1;
    const end = start + length;
    if (end > buffer.length) throw new Error('BT_STRING_OUT_OF_RANGE');
    return { value: buffer.subarray(start, end), start: offset, end };
}

function decodeBencodeNode(buffer, offset = 0, state = {}) {
    if (!Buffer.isBuffer(buffer) || offset >= buffer.length) throw new Error('BT_EOF');
    const token = buffer[offset];

    if (token === 0x69) { // i
        const end = buffer.indexOf(0x65, offset + 1); // e
        if (end === -1) throw new Error('BT_INTEGER_END_MISSING');
        const raw = buffer.subarray(offset + 1, end).toString('ascii');
        return { value: Number.parseInt(raw, 10), start: offset, end: end + 1 };
    }

    if (token === 0x6c) { // l
        const list = [];
        let cursor = offset + 1;
        while (cursor < buffer.length && buffer[cursor] !== 0x65) {
            const node = decodeBencodeNode(buffer, cursor, state);
            list.push(node.value);
            cursor = node.end;
        }
        if (buffer[cursor] !== 0x65) throw new Error('BT_LIST_END_MISSING');
        return { value: list, start: offset, end: cursor + 1 };
    }

    if (token === 0x64) { // d
        const map = {};
        let cursor = offset + 1;
        while (cursor < buffer.length && buffer[cursor] !== 0x65) {
            const keyNode = parseBencodeByteString(buffer, cursor);
            const key = keyNode.value.toString('utf8');
            cursor = keyNode.end;
            const valueNode = decodeBencodeNode(buffer, cursor, state);
            if (key === 'info') state.infoSlice = buffer.subarray(valueNode.start, valueNode.end);
            map[key] = valueNode.value;
            cursor = valueNode.end;
        }
        if (buffer[cursor] !== 0x65) throw new Error('BT_DICT_END_MISSING');
        return { value: map, start: offset, end: cursor + 1 };
    }

    if (token >= 0x30 && token <= 0x39) return parseBencodeByteString(buffer, offset);
    throw new Error(`BT_UNSUPPORTED_TOKEN_${String.fromCharCode(token)}`);
}

function mapTorrentInfoFiles(infoDict = {}) {
    const multiFiles = Array.isArray(infoDict?.files) ? infoDict.files : null;
    if (multiFiles && multiFiles.length > 0) {
        return multiFiles.map((entry, index) => {
            const rawPath = Array.isArray(entry?.path) ? entry.path : [];
            const pathParts = rawPath.map(getBufferString).filter(Boolean);
            const path = pathParts.join('/');
            return {
                id: index,
                path,
                bytes: Number(entry?.length || 0) || 0,
                selected: 1
            };
        }).filter(file => file.path);
    }

    const singleName = getBufferString(infoDict?.name).trim();
    const singleLength = Number(infoDict?.length || 0) || 0;
    return singleName ? [{ id: 0, path: singleName, bytes: singleLength, selected: 1 }] : [];
}

function parseTorrentMetadata(buffer, expectedInfoHash = null) {
    const state = {};
    const root = decodeBencodeNode(buffer, 0, state).value;
    if (!state.infoSlice) throw new Error('TORRENT_INFO_DICT_MISSING');
    const infoHash = crypto.createHash('sha1').update(state.infoSlice).digest('hex').toLowerCase();
    const expected = normalizeInfoHash(expectedInfoHash);
    if (expected && infoHash !== expected) throw new Error('TORRENT_INFO_HASH_MISMATCH');
    const infoDict = root?.info || {};
    const packName = getBufferString(infoDict?.name).trim() || null;
    return {
        service: 'public-torrent-cache',
        infoHash,
        torrentId: infoHash,
        files: mapTorrentInfoFiles(infoDict),
        packName
    };
}

async function fetchFilesFromPublicTorrentCaches(infoHash, logger = console) {
    const normalizedHash = normalizeInfoHash(infoHash);
    if (!PUBLIC_TORRENT_CACHE_ENABLED || !isValidInfoHash(normalizedHash)) {
        throw createExpectedMissError('PUBLIC_TORRENT_CACHE_DISABLED_OR_INVALID_HASH', 'public_cache_disabled');
    }

    const fetchOne = async (source) => {
        const response = await axios.get(source.url(normalizedHash), {
            responseType: 'arraybuffer',
            timeout: PUBLIC_TORRENT_CACHE_TIMEOUT_MS,
            maxContentLength: PUBLIC_TORRENT_CACHE_MAX_BYTES,
            maxBodyLength: PUBLIC_TORRENT_CACHE_MAX_BYTES,
            maxRedirects: 5,
            headers: {
                'User-Agent': 'Leviathan-PackResolver/3.1 (+torrent-metadata-only)',
                'Accept': 'application/x-bittorrent,application/octet-stream,*/*;q=0.5'
            },
            validateStatus: (status) => status >= 200 && status < 300
        });
        const buffer = Buffer.from(response?.data || []);
        if (buffer.length <= 0 || buffer.length > PUBLIC_TORRENT_CACHE_MAX_BYTES) {
            throw new Error(`${source.name}:PUBLIC_TORRENT_CACHE_BAD_SIZE`);
        }
        const parsed = parseTorrentMetadata(buffer, normalizedHash);
        const files = filterVideoFiles(parsed.files);
        if (files.length <= 0) throw createExpectedMissError(`${source.name}:PUBLIC_TORRENT_CACHE_NO_VIDEO_FILES`, 'public_cache_no_video');
        return { ...parsed, sourceName: source.name, files };
    };

    try {
        const parsed = await Promise.any(PUBLIC_TORRENT_CACHE_SOURCES.map(fetchOne));
        logger?.info?.(`[PACK-PUBLIC] ${parsed.sourceName} hit hash=${normalizedHash.slice(0, 12)} files=${parsed.files.length}`);
        return parsed;
    } catch (aggregateError) {
        const miss = createExpectedMissError('PUBLIC_TORRENT_CACHE_MISS', 'public_cache_miss');
        miss.errors = Array.isArray(aggregateError?.errors)
            ? aggregateError.errors.map((err) => err?.message || String(err))
            : [aggregateError?.message || String(aggregateError)];
        throw miss;
    }
}

function isVideoFile(filename) {
    return VIDEO_EXTENSIONS.test(String(filename || ''));
}

function isSeasonPack(title) {
    const value = String(title || '');
    if (!value) return false;
    if (/(?:\b|[^a-z])s\d{1,2}\s*e\d{1,3}(?:\b|[^\d])/i.test(value)) return false;
    if (/(?:\b|[^\d])\d{1,2}x\d{1,3}(?:\b|[^\d])/i.test(value)) return false;
    return [
        /(?:\b|[^a-z])s\d{1,2}(?!\s*e\d)/i,
        /season\s*\d{1,2}(?!\s*episode)/i,
        /stagione\s*\d{1,2}(?!\s*episodio)/i,
        /\b(?:complete|completa|full|integrale|collection|raccolta)\b/i,
        /\b(?:part|parte|vol|volume)\s*\d+/i,
        /\bpack\b/i
    ].some(re => re.test(value));
}


function isNoiseEpisodeNumber(value) {
    const episode = Number(value);
    return !Number.isInteger(episode) || episode <= 0
        || (episode >= 1900 && episode <= 2100)
        || [2160, 1080, 720, 576, 480, 360, 264, 265].includes(episode);
}

function extractSeriesEpisodeRange(filename, defaultSeason = 1) {
    const value = normalizeAnimeEpisodeText(filename).replace(/[‐‑–—―〜～]/g, '-');
    const patterns = [
        {
            regex: /\bS(?:EASON)?\s*0?(\d{1,2})\s*E(?:P)?\s*0?(\d{1,4})\s*(?:-|~|to|a)\s*(?:S(?:EASON)?\s*0?\d{1,2}\s*)?(?:E(?:P)?\s*)?0?(\d{1,4})\b/i,
            extract: (m) => ({ season: Number(m[1]), start: Number(m[2]), end: Number(m[3]) })
        },
        {
            regex: /\b0?(\d{1,2})x0?(\d{1,4})\s*(?:-|~|to|a)\s*(?:0?\d{1,2}x)?0?(\d{1,4})\b/i,
            extract: (m) => ({ season: Number(m[1]), start: Number(m[2]), end: Number(m[3]) })
        },
        {
            regex: /\b(?:episodes?|episodi?|eps?|ep)\s*0?(\d{1,4})\s*(?:-|~|to|a)\s*0?(\d{1,4})\b/i,
            extract: (m) => ({ season: Number(defaultSeason) || 1, start: Number(m[1]), end: Number(m[2]) })
        }
    ];

    for (const { regex, extract } of patterns) {
        const match = value.match(regex);
        if (!match) continue;
        const parsed = extract(match);
        if (!Number.isInteger(parsed.season) || parsed.season <= 0) continue;
        if (isNoiseEpisodeNumber(parsed.start) || isNoiseEpisodeNumber(parsed.end)) continue;
        if (parsed.end < parsed.start) continue;
        return {
            season: parsed.season,
            episode: parsed.start,
            rangeStart: parsed.start,
            rangeEnd: parsed.end,
            isRange: true,
            isBatch: true
        };
    }

    return null;
}

function parsedSeriesEpisodeCoversTarget(parsed, targetEpisode) {
    if (!parsed || !Number.isInteger(Number(targetEpisode)) || Number(targetEpisode) <= 0) return false;
    const episode = Number(parsed.episode || 0);
    if (episode === Number(targetEpisode)) return true;
    if (parsed.isRange === true) {
        const start = Number(parsed.rangeStart || parsed.episode || 0);
        const end = Number(parsed.rangeEnd || parsed.episode || 0);
        return start > 0 && end >= start && Number(targetEpisode) >= start && Number(targetEpisode) <= end;
    }
    return false;
}

function getSeriesMatchConfidence(parsed, targetEpisode) {
    if (!parsedSeriesEpisodeCoversTarget(parsed, targetEpisode)) return 0;
    if (Number(parsed.episode || 0) === Number(targetEpisode)) return 1;
    if (parsed.isRange === true) return 0.82;
    return 0.5;
}

function parseSeasonEpisode(filename, defaultSeason = 1, options = {}) {
    const explicitRange = extractSeriesEpisodeRange(filename, defaultSeason);
    if (explicitRange) return explicitRange;

    const value = normalizeAnimeEpisodeText(filename);
    for (const { pattern, extract } of SEASON_EPISODE_PATTERNS) {
        const match = value.match(pattern);
        if (match) {
            const parsed = extract(match, defaultSeason);
            if (parsed && Number.isInteger(parsed.season) && Number.isInteger(parsed.episode) && parsed.episode > 0) return parsed;
        }
    }
    if (options?.anime) return parseAnimeEpisode(value, defaultSeason);
    return null;
}

function extractSeasonFromText(title) {
    const value = String(title || '');
    const patterns = [
        /(?:\b|[^a-z])s(\d{1,2})(?!\s*e\d)/i,
        /season\s*(\d{1,2})/i,
        /stagione\s*(\d{1,2})/i
    ];
    for (const pattern of patterns) {
        const match = value.match(pattern);
        if (match) return parseInt(match[1], 10);
    }
    return null;
}

function normalizeName(value) {
    return String(value || '')
        .toLowerCase()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/\[[^\]]*\]|\([^)]*\)|\{[^}]*\}/g, ' ')
        .replace(/\b(2160p|1080p|720p|480p|4k|uhd|hdr|hevc|x265|x264|web[- .]?dl|web[- .]?rip|blu[- .]?ray|brrip|dvdrip|hdtv|remux|ddp\d*\.?\d*|aac\d*|ac3|dts|truehd|atmos|sub(?:bed)?|subs?|vostfr|ita|eng|multi|complete|completa|season|stagione|episode|episodio|ep)\b/gi, ' ')
        .replace(/[^a-z0-9]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function tokenizeTitle(value) {
    return canonicalTokenizeTitle(value, { keepNumbers: true });
}

function uniqueTitles(meta, item) {
    const set = new Set();
    const values = [];
    const push = v => {
        const s = String(v || '').trim();
        if (!s) return;
        const n = normalizeName(s);
        if (!n || set.has(n)) return;
        set.add(n);
        values.push(s);
    };
    push(meta?.title);
    push(meta?.name);
    push(item?.title);
    push(item?.name);
    if (Array.isArray(meta?.aka_titles)) meta.aka_titles.forEach(push);
    if (Array.isArray(meta?.aliases)) meta.aliases.forEach(push);
    if (Array.isArray(meta?.titles)) meta.titles.forEach(push);
    return values;
}

function filePathParts(pathValue) {
    return String(pathValue || '').split('/').filter(Boolean);
}

function fileName(pathValue) {
    const parts = filePathParts(pathValue);
    return parts.length > 0 ? parts[parts.length - 1] : String(pathValue || '');
}

function folderName(pathValue) {
    const parts = filePathParts(pathValue);
    if (parts.length <= 1) return null;
    return parts[0];
}

function getPackName(files, fallbackTitle) {
    const folderCounts = new Map();
    for (const file of files || []) {
        const folder = folderName(file.path || file.name || file.filename);
        if (!folder) continue;
        folderCounts.set(folder, (folderCounts.get(folder) || 0) + 1);
    }
    if (folderCounts.size > 0) {
        return [...folderCounts.entries()].sort((a, b) => b[1] - a[1] || b[0].length - a[0].length)[0][0];
    }
    for (const file of files || []) {
        const name = fileName(file.path || file.name || file.filename);
        if (name) return name;
    }
    return String(fallbackTitle || '').trim() || null;
}

function mapRawFiles(rawFiles) {
    const files = Array.isArray(rawFiles) ? rawFiles : [];
    return files
        .map((file, index) => {
            const pathValue = file.path || file.name || file.filename || file.file_path || '';
            const sizeValue = Number(file.bytes || file.size || file.file_size || 0);
            const idRaw = file.id ?? file.file_index ?? file.index ?? file.fileIdx ?? index;
            const id = Number.isInteger(idRaw) ? idRaw : parseInt(idRaw, 10);
            return {
                id: Number.isInteger(id) ? id : index,
                path: String(pathValue || ''),
                bytes: Number.isFinite(sizeValue) ? sizeValue : 0,
                selected: file.selected ?? 1
            };
        })
        .filter(file => file.path);
}

function hasUsablePackFiles(files) {
    return Array.isArray(files) && files.length > 0;
}

function filterVideoFiles(files) {
    return mapRawFiles(files).filter(file => isVideoFile(file.path) && file.bytes >= MIN_VIDEO_BYTES);
}

function extractYearsFromText(value) {
    const years = [];
    const text = String(value || '');
    for (const match of text.matchAll(/(?:^|[^\d])((?:19|20)\d{2})(?:[^\d]|$)/g)) {
        const year = Number(match[1]);
        if (year >= 1900 && year <= 2100) years.push(year);
    }
    return [...new Set(years)];
}

function romanToNumber(value) {
    const roman = String(value || '').toUpperCase();
    const map = { I: 1, V: 5, X: 10 };
    let total = 0;
    let prev = 0;
    for (let i = roman.length - 1; i >= 0; i--) {
        const current = map[roman[i]] || 0;
        total += current < prev ? -current : current;
        prev = current;
    }
    return total > 0 && total <= 10 ? total : null;
}

function collectMovieNumberSignals(titles = []) {
    const signals = new Set();
    for (const title of titles || []) {
        const text = String(title || '').toLowerCase();
        const numeric = text.match(/(?:^|\b)(?:part|parte|chapter|capitolo|vol(?:ume)?|film)?\s*([2-9])(?:\b|$)/i);
        if (numeric) signals.add(String(Number(numeric[1])));
        const roman = text.match(/(?:^|\b)(?:part|parte|chapter|capitolo|vol(?:ume)?|film)?\s*(ii|iii|iv|v|vi|vii|viii|ix|x)(?:\b|$)/i);
        if (roman) {
            const n = romanToNumber(roman[1]);
            if (n) signals.add(String(n));
        }
    }
    return [...signals];
}

function scoreMovieFile(file, titles, year) {
    const pathValue = String(file?.path || '').toLowerCase();
    const name = fileName(file.path).toLowerCase();
    const fileYears = extractYearsFromText(pathValue);
    const targetYear = Number(year) || null;
    const sequelSignals = collectMovieNumberSignals(titles);
    let score = 0;
    let bestTitleCoverage = 0;

    for (const title of titles) {
        const tokens = tokenizeTitle(title).filter(token => token.length > 1 || /^\d+$/.test(token));
        if (tokens.length === 0) continue;
        let matched = 0;
        for (const token of tokens) if (pathValue.includes(token)) matched += 1;
        const normalizedPhrase = tokens.join(' ');
        const compactPhrase = tokens.join('.');
        const dashPhrase = tokens.join('-');
        if (normalizedPhrase && pathValue.includes(normalizedPhrase)) matched += 2;
        if (compactPhrase && pathValue.includes(compactPhrase)) matched += 1;
        if (dashPhrase && pathValue.includes(dashPhrase)) matched += 1;
        const coverage = matched / Math.max(tokens.length, 1);
        bestTitleCoverage = Math.max(bestTitleCoverage, coverage);
        score = Math.max(score, matched * 15 + Math.round(coverage * 90));
    }

    if (targetYear) {
        if (fileYears.includes(targetYear)) score += 45;
        else if (fileYears.length > 0) {
            const closestDelta = Math.min(...fileYears.map(y => Math.abs(y - targetYear)));
            if (closestDelta <= 1) score += 8;
            else score -= Math.min(65, 22 + closestDelta * 2);
        }
    }

    for (const signal of sequelSignals) {
        const romanSignals = { '2': 'ii', '3': 'iii', '4': 'iv', '5': 'v', '6': 'vi', '7': 'vii', '8': 'viii', '9': 'ix', '10': 'x' };
        const roman = romanSignals[signal];
        if (new RegExp(`(?:^|[^a-z0-9])(?:part|parte|chapter|capitolo|vol(?:ume)?|film)?[ ._-]*${signal}(?:[^a-z0-9]|$)`, 'i').test(pathValue)) score += 14;
        if (roman && new RegExp(`(?:^|[^a-z0-9])(?:part|parte|chapter|capitolo|vol(?:ume)?|film)?[ ._-]*${roman}(?:[^a-z0-9]|$)`, 'i').test(pathValue)) score += 14;
    }

    if (/sample|trailer|extras?|featurette|behind\s*the\s*scenes|bonus|interview|deleted\s*scenes|making\s*of|commentary/i.test(pathValue)) score -= 120;
    if (/disc\s*[2-9]|cd\s*[2-9]/i.test(pathValue)) score -= 14;
    if (/2160p|4k|uhd/i.test(name)) score += 12;
    else if (/1080p|fhd/i.test(name)) score += 8;
    else if (/720p/i.test(name)) score += 4;
    score += Math.min(Math.floor((file.bytes || 0) / (700 * 1024 * 1024)), 18);

    if (bestTitleCoverage < 0.25 && fileYears.length === 0 && (titles || []).length > 0) score -= 25;
    return score;
}

function isMovieCollectionPackName(value) {
    return /\b(?:collection|trilogy|quadrilogy|saga|complete|box\s*set|boxset|anthology|raccolta|collezione|tutti\s+i\s+film)\b/i.test(String(value || ''));
}

function pickMovieFile(videoFiles, titles, year, packName = '') {
    if (!Array.isArray(videoFiles) || videoFiles.length === 0) return null;
    if (videoFiles.length === 1) return videoFiles[0];
    const isCollection = isMovieCollectionPackName(packName) || videoFiles.length >= 3;
    let best = null;
    let bestScore = -Infinity;
    for (const file of videoFiles) {
        const score = scoreMovieFile(file, titles, year);
        if (score > bestScore) {
            bestScore = score;
            best = file;
        }
    }

    if (isCollection) {
        const targetYear = Number(year) || null;
        const bestYears = extractYearsFromText(best?.path || '');
        const yearLooksRight = !targetYear || bestYears.length === 0 || bestYears.includes(targetYear) || bestYears.some(y => Math.abs(y - targetYear) <= 1);
        if (bestScore >= 35 && yearLooksRight) return best;
        const largest = [...videoFiles]
            .filter(file => !/sample|trailer|extras?|bonus|featurette/i.test(String(file.path || '')))
            .sort((a, b) => (b.bytes || 0) - (a.bytes || 0))[0];
        return largest || best;
    }

    return bestScore >= 30 ? best : videoFiles.sort((a, b) => (b.bytes || 0) - (a.bytes || 0))[0];
}

function collectSeriesMatches(videoFiles, meta, item) {
    const targetSeason = Number(meta?.season || item?.season || 1) || 1;
    const targetEpisode = Number(meta?.episode || item?.episode || 0) || 0;
    if (!Number.isInteger(targetEpisode) || targetEpisode <= 0) return [];

    const seasonFromTitle = extractSeasonFromText(item?.title || meta?.title || '');
    const seasonFallback = seasonFromTitle || targetSeason || 1;
    const parseOptions = { anime: isAnimeMeta(meta) };
    const matches = [];
    for (const file of videoFiles) {
        const dbSeason = Number(file.imdb_season || 0);
        const dbEpisode = Number(file.imdb_episode || 0);
        if (dbSeason > 0 || dbEpisode > 0) {
            if (dbSeason === targetSeason && dbEpisode === targetEpisode) {
                matches.push({ file, parsed: { season: dbSeason, episode: dbEpisode }, confidence: 1.05, dbExact: true });
            }
            continue;
        }

        const name = fileName(file.path);
        const parsed = parseSeasonEpisode(name, seasonFallback, parseOptions);
        if (!parsed) continue;
        if (parsed.season !== targetSeason) continue;
        if (!parsedSeriesEpisodeCoversTarget(parsed, targetEpisode)) continue;
        matches.push({ file, parsed, confidence: getSeriesMatchConfidence(parsed, targetEpisode) });
    }
    matches.sort((a, b) => {
        const confidenceDelta = (b.confidence || 0) - (a.confidence || 0);
        if (confidenceDelta !== 0) return confidenceDelta;
        const exactDelta = (Number(b.parsed.episode || 0) === targetEpisode ? 1 : 0) - (Number(a.parsed.episode || 0) === targetEpisode ? 1 : 0);
        if (exactDelta !== 0) return exactDelta;
        const sizeDelta = (b.file.bytes || 0) - (a.file.bytes || 0);
        if (sizeDelta !== 0) return sizeDelta;
        return String(a.file.path).localeCompare(String(b.file.path));
    });
    return matches;
}

function convertDbSeriesFiles(rawFiles) {
    return (Array.isArray(rawFiles) ? rawFiles : [])
        .map(file => ({
            id: Number.isInteger(file.file_index) ? file.file_index : parseInt(file.file_index, 10),
            path: file.title || file.file_title || file.file_path || file.path || '',
            bytes: Number(file.size || file.file_size || file.bytes || 0) || 0,
            imdb_episode: Number(file.imdb_episode || 0) || null,
            imdb_season: Number(file.imdb_season || 0) || null,
            selected: 1
        }))
        .filter(file => Number.isInteger(file.id) && file.path && isVideoFile(file.path));
}

function convertDbPackFiles(rawFiles) {
    return (Array.isArray(rawFiles) ? rawFiles : [])
        .map(file => ({
            id: Number.isInteger(file.file_index) ? file.file_index : parseInt(file.file_index, 10),
            path: file.file_path || file.file_title || file.title || file.path || '',
            bytes: Number(file.file_size || file.size || file.bytes || 0) || 0,
            selected: 1
        }))
        .filter(file => Number.isInteger(file.id) && file.path && isVideoFile(file.path));
}

function getApiKeys(config) {
    const service = String(config?.service || '').toLowerCase();
    return {
        service,
        rd: config?.rd_key || config?.rd || (service === 'rd' ? config?.key : null),
        tb: config?.torbox_key || config?.torbox || config?.tb || (service === 'tb' ? config?.key : null)
    };
}

async function fetchFilesFromRealDebrid(infoHash, rdKey) {
    const baseUrl = 'https://api.real-debrid.com/rest/1.0';
    const headers = { Authorization: `Bearer ${rdKey}` };
    const magnetLink = `magnet:?xt=urn:btih:${infoHash}`;
    const addResponse = await axios.post(
        `${baseUrl}/torrents/addMagnet`,
        `magnet=${encodeURIComponent(magnetLink)}`,
        { headers, timeout: 30000, headers: { ...headers, 'Content-Type': 'application/x-www-form-urlencoded' } }
    );
    const torrentId = addResponse?.data?.id;
    if (!torrentId) throw new Error('RD_ADD_MAGNET_FAILED');
    try {
        let infoData = null;
        let lastError = null;

        for (let attempt = 0; attempt < RD_INFO_RETRY_ATTEMPTS; attempt++) {
            try {
                const infoResponse = await axios.get(`${baseUrl}/torrents/info/${torrentId}`, { headers, timeout: 30000 });
                infoData = infoResponse?.data || null;
                if (hasUsablePackFiles(infoData?.files)) break;
                lastError = null;
            } catch (err) {
                lastError = err;
                if (!isExpectedResolverMissError(err) || attempt >= RD_INFO_RETRY_ATTEMPTS - 1) throw err;
            }

            if (attempt < RD_INFO_RETRY_ATTEMPTS - 1) {
                await sleep(RD_INFO_RETRY_DELAY_MS * (attempt + 1));
            }
        }

        if (!infoData) {
            if (lastError) throw lastError;
            throw createExpectedMissError('RD_INFO_NOT_READY', 'not_ready');
        }
        if (!hasUsablePackFiles(infoData?.files)) {
            throw createExpectedMissError('RD_INFO_FILES_NOT_READY', 'files_not_ready');
        }

        return {
            service: 'rd',
            infoHash,
            torrentId,
            files: mapRawFiles(infoData?.files),
            packName: infoData?.filename || null
        };
    } finally {
        await axios.delete(`${baseUrl}/torrents/delete/${torrentId}`, { headers, timeout: 15000 }).catch(() => {});
    }
}

function extractTorboxCacheEntry(data, infoHash) {
    const normalizedHash = normalizeInfoHash(infoHash);
    if (!data) return null;

    if (Array.isArray(data)) {
        for (const entry of data) {
            const candidates = [entry?.hash, entry?.info_hash, entry?.torrent_hash, entry?.hash_value]
                .map(normalizeInfoHash)
                .filter(Boolean);
            if (candidates.includes(normalizedHash)) return entry;
        }
        return data.find((entry) => Array.isArray(entry?.files) && entry.files.length > 0) || null;
    }

    if (typeof data === 'object') {
        const matchingKey = Object.keys(data).find((key) => normalizeInfoHash(key) === normalizedHash);
        if (matchingKey) return data[matchingKey];
    }

    return null;
}

async function fetchTorboxListEntry(baseUrl, headers, torrentId) {
    let lastError = null;
    let torrent = null;

    for (let attempt = 0; attempt < TB_INFO_RETRY_ATTEMPTS; attempt++) {
        try {
            const infoResponse = await axios.get(`${baseUrl}/torrents/mylist`, { headers, params: { id: torrentId }, timeout: 30000 });
            torrent = Array.isArray(infoResponse?.data?.data)
                ? infoResponse.data.data.find((entry) => String(entry.id) === String(torrentId))
                : null;
            if (torrent && hasUsablePackFiles(torrent?.files)) return torrent;
            lastError = null;
        } catch (err) {
            lastError = err;
            if (!isExpectedResolverMissError(err) || attempt >= TB_INFO_RETRY_ATTEMPTS - 1) throw err;
        }

        if (attempt < TB_INFO_RETRY_ATTEMPTS - 1) {
            await sleep(TB_INFO_RETRY_DELAY_MS * (attempt + 1));
        }
    }

    if (torrent && hasUsablePackFiles(torrent?.files)) return torrent;
    if (lastError) throw lastError;
    throw createExpectedMissError('TB_INFO_FILES_NOT_READY', 'files_not_ready');
}

async function fetchFilesFromTorbox(infoHash, torboxKey) {
    const baseUrl = 'https://api.torbox.app/v1/api';
    const headers = { Authorization: `Bearer ${torboxKey}` };
    try {
        const cacheResponse = await axios.get(`${baseUrl}/torrents/checkcached`, {
            headers,
            params: { hash: infoHash.toUpperCase(), format: 'list', list_files: true },
            timeout: 12000
        });
        const cacheEntry = extractTorboxCacheEntry(cacheResponse?.data?.data, infoHash);
        const files = Array.isArray(cacheEntry?.files) ? cacheEntry.files : null;
        if (Array.isArray(files) && files.length > 0) {
            return {
                service: 'tb',
                infoHash,
                torrentId: cacheEntry?.id || cacheEntry?.torrent_id || 'cached',
                files: mapRawFiles(files),
                packName: cacheEntry?.name || cacheEntry?.torrent_title || null
            };
        }
    } catch (err) {
        throw createExpectedMissError('TB_CHECKCACHED_FAILED', 'tb_checkcached_failed', getErrorStatus(err) || 404);
    }

    if (!TORBOX_CREATE_TORRENT_IN_PACK_RESOLVER) {
        throw createExpectedMissError('TB_NOT_CACHED_OR_NO_FILE_LIST', 'tb_not_cached_no_file_list');
    }

    // Kept unreachable by default on purpose. Automatic stream requests must not create TorBox torrents.
    const magnetLink = `magnet:?xt=urn:btih:${infoHash}`;
    const createResponse = await axios.post(`${baseUrl}/torrents/createtorrent`, { magnet: magnetLink }, { headers, timeout: 30000 });
    const torrentId = createResponse?.data?.data?.torrent_id;
    if (!torrentId) throw new Error('TB_CREATE_TORRENT_FAILED');
    try {
        const torrent = await fetchTorboxListEntry(baseUrl, headers, torrentId);
        return {
            service: 'tb',
            infoHash,
            torrentId,
            files: mapRawFiles(torrent?.files),
            packName: torrent?.name || torrent?.filename || null
        };
    } finally {
        await axios.get(`${baseUrl}/torrents/controltorrent`, { headers, params: { torrent_id: torrentId, operation: 'delete' }, timeout: 15000 }).catch(() => {});
    }
}

async function scanPackFiles(infoHash, config, logger = console) {
    const { service, rd, tb } = getApiKeys(config);
    const normalizedHash = normalizeInfoHash(infoHash);
    if (!normalizedHash) throw new Error('INVALID_INFO_HASH');
    const resolvedService = service === 'tb' || (!rd && tb) ? 'tb' : 'rd';
    const cacheKey = buildCacheKey(normalizedHash, service || (rd ? 'rd' : tb ? 'tb' : 'auto'));
    const cached = cacheGet(cacheKey);
    if (cached) return cached;
    if (pendingScans.has(cacheKey)) return pendingScans.get(cacheKey);

    const task = (async () => {
        try {
            let result;
            let primaryMiss = null;
            try {
                if (resolvedService === 'tb') {
                    if (!tb) throw createExpectedMissError('TB_KEY_MISSING', 'tb_key_missing');
                    result = await fetchFilesFromTorbox(normalizedHash, tb);
                } else {
                    if (!rd) throw createExpectedMissError('RD_KEY_MISSING', 'rd_key_missing');
                    result = await rdQueue.add(() => fetchFilesFromRealDebrid(normalizedHash, rd));
                }
            } catch (err) {
                primaryMiss = err;
                if (!isExpectedResolverMissError(err)) throw err;
                result = await fetchFilesFromPublicTorrentCaches(normalizedHash, logger);
                logger?.info?.(`[PACK-PUBLIC] fallback used after ${resolvedService.toUpperCase()} miss reason=${err?.reason || err?.message || 'unknown'} hash=${normalizedHash.slice(0, 12)}`);
            }
            const payload = {
                infoHash: normalizedHash,
                service: result.service,
                torrentId: result.torrentId,
                files: filterVideoFiles(result.files),
                packName: result.packName || null,
                scannedAt: Date.now(),
                publicFallback: result.service === 'public-torrent-cache',
                primaryMissReason: primaryMiss?.reason || null
            };
            cacheSet(cacheKey, payload);
            return payload;
        } catch (err) {
            if (isExpectedResolverMissError(err)) {
                const negativePayload = buildNegativePackPayload(normalizedHash, resolvedService, err?.reason || 'http_404', err);
                cacheSet(cacheKey, negativePayload, NEGATIVE_CACHE_TTL_MS);
                return negativePayload;
            }
            throw err;
        }
    })();

    pendingScans.set(cacheKey, task);
    try {
        return await task;
    } finally {
        pendingScans.delete(cacheKey);
    }
}

async function loadSeriesFromDb(infoHash, dbHelper) {
    if (!dbHelper) return null;
    try {
        if (typeof dbHelper.getSeriesPackFiles === 'function') {
            const files = await dbHelper.getSeriesPackFiles(infoHash);
            const mapped = convertDbSeriesFiles(files);
            if (mapped.length > 0) {
                return {
                    infoHash,
                    service: 'db',
                    torrentId: 'db',
                    files: mapped,
                    packName: getPackName(mapped, null),
                    scannedAt: Date.now()
                };
            }
        }

        if (typeof dbHelper.getPackFiles !== 'function') return null;
        const raw = await dbHelper.getPackFiles(infoHash, DB_SERIES_FILE_LIMIT);
        const fallbackFiles = convertDbPackFiles(raw?.files || raw);
        return fallbackFiles.length > 0
            ? {
                infoHash,
                service: 'db',
                torrentId: 'db',
                files: fallbackFiles,
                packName: getPackName(fallbackFiles, null),
                scannedAt: Date.now()
            }
            : null;
    } catch (err) {
        return null;
    }
}

async function loadMovieFromDb(infoHash, dbHelper) {
    if (!dbHelper || typeof dbHelper.getPackFiles !== 'function') return null;
    try {
        const raw = await dbHelper.getPackFiles(infoHash.toLowerCase(), DB_MOVIE_FILE_LIMIT);
        const files = convertDbPackFiles(raw?.files || raw);
        return files.length > 0 ? { infoHash, service: 'db', torrentId: 'db', files, packName: getPackName(files, null), scannedAt: Date.now() } : null;
    } catch (err) {
        return null;
    }
}

function normalizeContext(arg1, config, meta) {
    if (arg1 && typeof arg1 === 'object' && (arg1.item || arg1.config || arg1.meta || arg1.dbHelper)) {
        return {
            item: arg1.item || null,
            config: arg1.config || {},
            meta: arg1.meta || {},
            siblingStreams: arg1.siblingStreams || [],
            dbHelper: arg1.dbHelper || null,
            logger: arg1.logger || console
        };
    }
    return {
        item: arg1 || null,
        config: config || {},
        meta: meta || {},
        siblingStreams: [],
        dbHelper: null,
        logger: console
    };
}

function buildSeriesResolution(packData, context) {
    const matches = collectSeriesMatches(packData.files, context.meta, context.item);
    if (matches.length === 0) return null;
    const best = matches[0];
    const packName = packData.packName || getPackName(packData.files, context.item?.title || context.meta?.title);
    return {
        title: packName || fileName(best.file.path),
        filename: packName || fileName(best.file.path),
        packName,
        files: packData.files,
        fileIndex: best.file.id,
        fileIdx: best.file.id,
        fileName: fileName(best.file.path),
        fileSize: best.file.bytes,
        size: best.file.bytes,
        source: packData.service,
        publicFallback: Boolean(packData.publicFallback),
        episode: best.parsed.episode,
        season: best.parsed.season,
        rangeStart: best.parsed.rangeStart || null,
        rangeEnd: best.parsed.rangeEnd || null,
        packConfidence: best.confidence || getSeriesMatchConfidence(best.parsed, Number(context.meta?.episode || context.item?.episode || 0)),
        packEvidenceReason: best.dbExact === true ? 'db_episode_mapping_exact' : (best.parsed.isRange === true ? 'episode_range_contains_target' : 'exact_episode_file'),
        totalPackSize: packData.files.reduce((sum, file) => sum + (file.bytes || 0), 0)
    };
}

function buildMovieResolution(packData, context) {
    const titles = uniqueTitles(context.meta, context.item);
    const year = Number(context.meta?.year || context.item?.year || 0) || null;
    const best = pickMovieFile(packData.files, titles, year, packData.packName || context.item?.title || context.meta?.title || '');
    if (!best) return null;
    const packName = packData.packName || getPackName(packData.files, context.item?.title || context.meta?.title);
    return {
        title: packName || fileName(best.path),
        filename: packName || fileName(best.path),
        packName,
        files: packData.files,
        fileIndex: best.id,
        fileIdx: best.id,
        fileName: fileName(best.path),
        fileSize: best.bytes,
        size: best.bytes,
        source: packData.service,
        publicFallback: Boolean(packData.publicFallback),
        totalPackSize: packData.files.reduce((sum, file) => sum + (file.bytes || 0), 0)
    };
}

async function resolvePackData(arg1, config, meta) {
    const context = normalizeContext(arg1, config, meta);
    const item = context.item || {};
    const infoHash = normalizeInfoHash(item.hash || item.infoHash);
    if (!infoHash) return null;

    const dbCacheKey = buildDbCacheKey(infoHash, Boolean(context.meta?.isSeries));
    let packData = cacheGet(dbCacheKey);
    if (!packData || !Array.isArray(packData.files) || packData.files.length === 0) {
        if (context.meta?.isSeries) packData = await loadSeriesFromDb(infoHash, context.dbHelper);
        else packData = await loadMovieFromDb(infoHash, context.dbHelper);

        if (packData && Array.isArray(packData.files) && packData.files.length > 0) {
            cacheSet(dbCacheKey, packData);
        }
    }

    if (!packData || !Array.isArray(packData.files) || packData.files.length === 0) {
        packData = await scanPackFiles(infoHash, context.config, context.logger);
    }
    if (packData?.negative === true) return null;
    if (!packData || !Array.isArray(packData.files) || packData.files.length === 0) return null;

    const resolved = context.meta?.isSeries ? buildSeriesResolution(packData, context) : buildMovieResolution(packData, context);
    if (DEBUG_MODE && resolved) {
        context.logger?.info?.(`[PACK-INTELLIGENCE] ${infoHash.slice(0, 8)} -> ${resolved.fileName || resolved.filename || resolved.title}`);
    }
    return resolved;
}

async function resolvePack(arg1, config, meta) {
    return resolvePackData(arg1, config, meta);
}

async function resolve(arg1, config, meta) {
    return resolvePackData(arg1, config, meta);
}

async function getPackData(infoHash, config, meta) {
    return resolvePackData({ item: { hash: infoHash, infoHash, title: meta?.title }, config, meta, dbHelper: null });
}

async function resolveSeriesPackFile(infoHash, config, seriesImdbId, season, episode, dbHelper) {
    const resolved = await resolvePackData({
        item: { hash: infoHash, infoHash, title: null },
        config,
        meta: { isSeries: true, imdb_id: seriesImdbId, season, episode, title: null },
        dbHelper
    });
    if (!resolved) return null;
    return {
        fileIndex: resolved.fileIndex,
        fileName: resolved.fileName,
        fileSize: resolved.fileSize,
        totalPackSize: resolved.totalPackSize,
        source: resolved.source
    };
}

async function resolveMoviePackFile(infoHash, config, movieImdbId, targetTitles, year, dbHelper) {
    const resolved = await resolvePackData({
        item: { hash: infoHash, infoHash, title: Array.isArray(targetTitles) ? targetTitles[0] : targetTitles },
        config,
        meta: { isSeries: false, imdb_id: movieImdbId, title: Array.isArray(targetTitles) ? targetTitles[0] : targetTitles, titles: Array.isArray(targetTitles) ? targetTitles : [targetTitles], year },
        dbHelper
    });
    if (!resolved) return null;
    return {
        fileIndex: resolved.fileIndex,
        fileName: resolved.fileName,
        fileSize: resolved.fileSize,
        totalPackSize: resolved.totalPackSize,
        source: resolved.source
    };
}

async function processSeriesPackFiles(files, infoHash, seriesImdbId, targetSeason) {
    const normalized = filterVideoFiles(files);
    return normalized
        .map(file => {
            const parsed = parseSeasonEpisode(fileName(file.path), targetSeason || 1);
            if (!parsed || parsed.season !== targetSeason) return null;
            return {
                info_hash: normalizeInfoHash(infoHash),
                file_index: file.id,
                title: fileName(file.path),
                size: file.bytes,
                imdb_id: seriesImdbId,
                imdb_season: parsed.season,
                imdb_episode: parsed.episode
            };
        })
        .filter(Boolean);
}

module.exports = {
    resolvePackData,
    resolvePack,
    resolve,
    getPackData,
    resolveSeriesPackFile,
    resolveMoviePackFile,
    processSeriesPackFiles,
    isSeasonPack,
    isVideoFile,
    parseSeasonEpisode,
    parsedSeriesEpisodeCoversTarget,
    parseTorrentMetadata,
    fetchFilesFromPublicTorrentCaches
};
