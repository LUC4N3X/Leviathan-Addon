const axios = require('axios');
const { tokenizeTitle, parseSeasonEpisode, extractSeasonFromText } = require('./canonical/title_parser');
const { isAnimeMeta } = require('./canonical/anime_rules');

const DEBUG_MODE = process.env.DEBUG_MODE === 'true';
const VIDEO_EXTENSIONS = /\.(mkv|mp4|avi|mov|wmv|flv|webm|m4v|ts|m2ts|mpg|mpeg|iso)$/i;
const MIN_VIDEO_BYTES = 25 * 1024 * 1024;
const RD_SCAN_DELAY_MS = Math.max(0, parseInt(process.env.PACK_RD_SCAN_DELAY_MS || '250', 10) || 250);
const MEMORY_TTL_MS = Math.max(30_000, parseInt(process.env.PACK_RESOLVER_TTL_MS || String(10 * 60 * 1000), 10) || 10 * 60 * 1000);
const NEGATIVE_CACHE_TTL_MS = Math.max(15_000, parseInt(process.env.PACK_RESOLVER_NEGATIVE_TTL_MS || String(2 * 60 * 1000), 10) || 2 * 60 * 1000);
const RD_INFO_RETRY_ATTEMPTS = Math.max(2, parseInt(process.env.PACK_RD_INFO_RETRY_ATTEMPTS || '4', 10) || 4);
const RD_INFO_RETRY_DELAY_MS = Math.max(250, parseInt(process.env.PACK_RD_INFO_RETRY_DELAY_MS || '900', 10) || 900);
const TB_INFO_RETRY_ATTEMPTS = Math.max(2, parseInt(process.env.PACK_TB_INFO_RETRY_ATTEMPTS || '4', 10) || 4);
const TB_INFO_RETRY_DELAY_MS = Math.max(500, parseInt(process.env.PACK_TB_INFO_RETRY_DELAY_MS || '1200', 10) || 1200);
const MAX_MEMORY_ENTRIES = Math.max(50, parseInt(process.env.PACK_RESOLVER_CACHE_SIZE || '500', 10) || 500);
const DB_MOVIE_FILE_LIMIT = Math.max(10, parseInt(process.env.PACK_DB_MOVIE_LIMIT || '30', 10) || 30);
const DB_SERIES_FILE_LIMIT = Math.max(25, parseInt(process.env.PACK_DB_SERIES_LIMIT || '400', 10) || 400);

class RequestQueue {
    constructor(concurrency = 1) {
        this.concurrency = Math.max(1, concurrency);
        this.running = 0;
        this.queue = [];
    }

    add(task) {
        return new Promise((resolve, reject) => {
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

const rdQueue = new RequestQueue(1);
const pendingScans = new Map();
const memoryCache = new Map();


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

function scoreMovieFile(file, titles, year) {
    const name = fileName(file.path).toLowerCase();
    let score = 0;
    for (const title of titles) {
        const tokens = tokenizeTitle(title);
        if (tokens.length === 0) continue;
        let matched = 0;
        for (const token of tokens) if (name.includes(token)) matched += 1;
        score = Math.max(score, matched * 15 + Math.round((matched / tokens.length) * 80));
    }
    if (year && new RegExp(`(?:^|[^\d])${year}(?:[^\d]|$)`).test(name)) score += 18;
    if (/sample|trailer|extras?|featurette|behind\s*the\s*scenes/i.test(name)) score -= 80;
    if (/2160p|4k|uhd/i.test(name)) score += 12;
    else if (/1080p|fhd/i.test(name)) score += 8;
    else if (/720p/i.test(name)) score += 4;
    score += Math.min(Math.floor((file.bytes || 0) / (700 * 1024 * 1024)), 18);
    return score;
}

function pickMovieFile(videoFiles, titles, year) {
    if (!Array.isArray(videoFiles) || videoFiles.length === 0) return null;
    if (videoFiles.length === 1) return videoFiles[0];
    let best = null;
    let bestScore = -Infinity;
    for (const file of videoFiles) {
        const score = scoreMovieFile(file, titles, year);
        if (score > bestScore) {
            bestScore = score;
            best = file;
        }
    }
    return bestScore >= 30 ? best : videoFiles.sort((a, b) => (b.bytes || 0) - (a.bytes || 0))[0];
}

function collectSeriesMatches(videoFiles, meta, item) {
    const targetSeason = Number(meta?.season || item?.season || 1) || 1;
    const targetEpisode = Number(meta?.episode || item?.episode || 0) || 0;
    const seasonFromTitle = extractSeasonFromText(item?.title || meta?.title || '');
    const seasonFallback = seasonFromTitle || targetSeason || 1;
    const parseOptions = { anime: isAnimeMeta(meta) };
    const matches = [];
    for (const file of videoFiles) {
        const name = fileName(file.path);
        const parsed = parseSeasonEpisode(name, seasonFallback, parseOptions);
        if (!parsed) continue;
        if (parsed.season !== targetSeason) continue;
        matches.push({ file, parsed });
    }
    matches.sort((a, b) => {
        const episodeDelta = Math.abs((a.parsed.episode || 0) - targetEpisode) - Math.abs((b.parsed.episode || 0) - targetEpisode);
        if (episodeDelta !== 0) return episodeDelta;
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
            params: { hash: infoHash.toUpperCase(), format: 'object', list_files: true },
            timeout: 12000
        });
        const cacheData = cacheResponse?.data?.data;
        if (cacheData && typeof cacheData === 'object') {
            const hashKey = Object.keys(cacheData).find(key => key.toLowerCase() === infoHash.toLowerCase());
            const files = cacheData?.[hashKey]?.files;
            if (Array.isArray(files) && files.length > 0) {
                return {
                    service: 'tb',
                    infoHash,
                    torrentId: 'cached',
                    files: mapRawFiles(files),
                    packName: null
                };
            }
        }
    } catch (err) {}

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

async function scanPackFiles(infoHash, config) {
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
            if (resolvedService === 'tb') {
                if (!tb) throw new Error('TB_KEY_MISSING');
                result = await fetchFilesFromTorbox(normalizedHash, tb);
            } else {
                if (!rd) throw new Error('RD_KEY_MISSING');
                result = await rdQueue.add(() => fetchFilesFromRealDebrid(normalizedHash, rd));
            }
            const payload = {
                infoHash: normalizedHash,
                service: result.service,
                torrentId: result.torrentId,
                files: filterVideoFiles(result.files),
                packName: result.packName || null,
                scannedAt: Date.now()
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
        episode: best.parsed.episode,
        season: best.parsed.season,
        totalPackSize: packData.files.reduce((sum, file) => sum + (file.bytes || 0), 0)
    };
}

function buildMovieResolution(packData, context) {
    const titles = uniqueTitles(context.meta, context.item);
    const year = Number(context.meta?.year || context.item?.year || 0) || null;
    const best = pickMovieFile(packData.files, titles, year);
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
        packData = await scanPackFiles(infoHash, context.config);
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
    parseSeasonEpisode
};
