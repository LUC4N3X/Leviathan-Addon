const zlib = require('zlib');
const { randomUUID } = require('crypto');
const { promisify } = require('util');
const NodeCache = require('node-cache');

const dbHelper = require('../storage/db_repository');
const { createInvalidationBus } = require('../cache/invalidation_bus');
const { logger, incrementMetric, registerCacheAccess, registerCacheSet } = require('./runtime');
const { withSharedPromise } = require('./common');
const RawStreamCache = require('../cache/raw_stream_cache');

const myCache = new NodeCache({
    stdTTL: 1800,
    checkperiod: Math.max(15, parseInt(process.env.STREAM_CACHE_CHECKPERIOD || '60', 10) || 60),
    maxKeys: Math.max(5000, parseInt(process.env.STREAM_CACHE_MAX_KEYS || '20000', 10) || 20000),
    useClones: false,
    deleteOnExpire: true
});
const rawCache = new NodeCache({
    stdTTL: 43200,
    checkperiod: Math.max(60, parseInt(process.env.RAW_CACHE_CHECKPERIOD || '300', 10) || 300),
    maxKeys: Math.max(15000, parseInt(process.env.RAW_CACHE_MAX_KEYS || '30000', 10) || 30000),
    useClones: false,
    deleteOnExpire: true
});
const cloudBuildCache = new NodeCache({
    stdTTL: 900,
    checkperiod: Math.max(15, parseInt(process.env.CLOUD_BUILD_CACHE_CHECKPERIOD || '60', 10) || 60),
    maxKeys: Math.max(5000, parseInt(process.env.CLOUD_BUILD_CACHE_MAX_KEYS || '10000', 10) || 10000),
    useClones: false,
    deleteOnExpire: true
});
const cloudBuildInflight = new Map();
const sharedFetchInflight = new Map();
const streamInflight = new Map();
const metadataInflight = new Map();

const RAW_PROVIDER_CACHE_TTL = Math.max(parseInt(process.env.RAW_PROVIDER_CACHE_TTL || '43200', 10) || 43200, 60);
const EMPTY_FETCH_TTL = Math.max(parseInt(process.env.EMPTY_FETCH_TTL || process.env.RAW_PROVIDER_EMPTY_TTL || '90', 10) || 90, 15);
const EMPTY_STREAM_TTL = Math.max(parseInt(process.env.EMPTY_STREAM_TTL || '60', 10) || 60, 15);
const STREAM_STALE_GRACE_TTL = Math.max(parseInt(process.env.STREAM_STALE_GRACE_TTL || '180', 10) || 180, 30);
const METADATA_CACHE_TTL = Math.max(parseInt(process.env.METADATA_CACHE_TTL || '1800', 10) || 1800, 60);
const RESOLVED_URL_TTL = Math.max(parseInt(process.env.RESOLVED_URL_TTL || process.env.LAZY_LINK_TTL || '180', 10) || 180, 30);
const EMPTY_RESOLVED_URL_TTL = Math.max(parseInt(process.env.EMPTY_RESOLVED_URL_TTL || '60', 10) || 60, 15);
const AVAILABILITY_CACHE_TTL = Math.max(parseInt(process.env.AVAILABILITY_CACHE_TTL || '900', 10) || 900, 30);
const EMPTY_AVAILABILITY_TTL = Math.max(parseInt(process.env.EMPTY_AVAILABILITY_TTL || '120', 10) || 120, 15);
const DB_LOOKUP_CACHE_TTL = Math.max(parseInt(process.env.DB_LOOKUP_CACHE_TTL || '30', 10) || 30, 5);
const VERBOSE_CACHE_LOGS = String(process.env.VERBOSE_CACHE_LOGS || 'false').toLowerCase() === 'true';
const SHARED_STREAM_CACHE_ENABLED = String(process.env.SHARED_STREAM_CACHE_ENABLED || 'true').toLowerCase() !== 'false';
const SHARED_STREAM_CACHE_MAX_BYTES = Math.max(4096, parseInt(process.env.SHARED_STREAM_CACHE_MAX_BYTES || String(1024 * 1024 * 2), 10) || (1024 * 1024 * 2));
const SHARED_STREAM_CACHE_WRITE_CONCURRENCY = Math.max(1, parseInt(process.env.SHARED_STREAM_CACHE_WRITE_CONCURRENCY || '2', 10) || 2);
const SHARED_STREAM_CACHE_NODE_ID = String(process.env.LEVI_NODE_ID || randomUUID());
const SHARED_STREAM_CACHE_PROCESS_ID = process.pid;
const brotliCompressAsync = promisify(zlib.brotliCompress);
const gzipAsync = promisify(zlib.gzip);
const brotliDecompressAsync = promisify(zlib.brotliDecompress);
const gunzipAsync = promisify(zlib.gunzip);
const zstdCompressAsync = typeof zlib.zstdCompress === 'function' ? promisify(zlib.zstdCompress) : null;
const zstdDecompressAsync = typeof zlib.zstdDecompress === 'function' ? promisify(zlib.zstdDecompress) : null;

function resolveSharedStreamCodec(requestedCodec) {
    const normalized = String(requestedCodec || '').trim().toLowerCase();
    const effective = normalized || 'auto';
    if (effective === 'auto') {
        if (zstdCompressAsync) return 'zstd';
        return 'brotli';
    }
    if (effective === 'zstd' && zstdCompressAsync) return 'zstd';
    if (effective === 'brotli') return 'brotli';
    if (effective === 'gzip') return 'gzip';
    if (effective === 'identity' || effective === 'none') return 'identity';
    return zstdCompressAsync ? 'zstd' : 'brotli';
}

const SHARED_STREAM_CACHE_CODEC = resolveSharedStreamCodec(process.env.SHARED_STREAM_CACHE_CODEC);

const streamCacheTags = new Map();
const streamCacheKeysByHash = new Map();
const streamCacheKeysByImdb = new Map();
const streamCacheKeysByEpisode = new Map();
const invalidationBus = createInvalidationBus();
const CACHE_INVALIDATION_CHANNEL = String(process.env.CACHE_INVALIDATION_CHANNEL || 'leviathan_cache_events').toLowerCase();
const sharedStreamPersistInflight = new Map();
const sharedStreamWriteQueue = [];
let sharedStreamWriteActive = 0;

function runSharedStreamWriteQueue() {
    while (sharedStreamWriteActive < SHARED_STREAM_CACHE_WRITE_CONCURRENCY && sharedStreamWriteQueue.length > 0) {
        const nextTask = sharedStreamWriteQueue.shift();
        if (typeof nextTask !== 'function') continue;
        sharedStreamWriteActive += 1;
        Promise.resolve()
            .then(nextTask)
            .catch(() => {})
            .finally(() => {
                sharedStreamWriteActive = Math.max(0, sharedStreamWriteActive - 1);
                runSharedStreamWriteQueue();
            });
    }
}

function enqueueSharedStreamWrite(task) {
    return new Promise((resolve, reject) => {
        sharedStreamWriteQueue.push(async () => {
            try {
                resolve(await task());
            } catch (error) {
                reject(error);
            }
        });
        runSharedStreamWriteQueue();
    });
}
let invalidationSyncStarted = false;
let invalidationSyncStop = null;

function getStreamCacheStorageKey(key) {
    return `stream:${String(key || '').trim()}`;
}

function getStreamShadowStorageKey(key) {
    return `stream_shadow:${String(key || '').trim()}`;
}

function getDbLookupStorageKey(key) {
    return `dblookup:${String(key || '').trim()}`;
}

function normalizeHashTag(hash) {
    const normalized = String(hash || '').trim().toUpperCase();
    return /^[A-F0-9]{40}$/.test(normalized) ? normalized : null;
}

function normalizeImdbTag(imdbId) {
    const normalized = String(imdbId || '').trim().toLowerCase();
    return /^tt\d+$/.test(normalized) ? normalized : null;
}

function normalizeEpisodeTag(imdbOrPayload, seasonValue = null, episodeValue = null) {
    const imdbId = typeof imdbOrPayload === 'object' && imdbOrPayload !== null ? imdbOrPayload.imdbId : imdbOrPayload;
    const season = typeof imdbOrPayload === 'object' && imdbOrPayload !== null ? imdbOrPayload.season : seasonValue;
    const episode = typeof imdbOrPayload === 'object' && imdbOrPayload !== null ? imdbOrPayload.episode : episodeValue;
    const normalizedImdb = normalizeImdbTag(imdbId);
    const parsedSeason = Number.isInteger(Number(season)) ? Number(season) : null;
    const parsedEpisode = Number.isInteger(Number(episode)) ? Number(episode) : null;
    if (!normalizedImdb || !Number.isInteger(parsedSeason) || parsedSeason <= 0 || !Number.isInteger(parsedEpisode) || parsedEpisode <= 0) return null;
    return `${normalizedImdb}:${parsedSeason}:${parsedEpisode}`;
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
    if (tags.episodeLocator) removeTaggedCacheKey(streamCacheKeysByEpisode, tags.episodeLocator, normalizedKey);
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
    const episodeLocator = normalizeEpisodeTag(tags?.episodeLocator || {
        imdbId,
        season: tags?.imdbSeason,
        episode: tags?.imdbEpisode
    });

    streamCacheTags.set(normalizedKey, { hashes: uniqueHashes, imdbId, episodeLocator });
    for (const hash of uniqueHashes) addTaggedCacheKey(streamCacheKeysByHash, hash, normalizedKey);
    if (imdbId) addTaggedCacheKey(streamCacheKeysByImdb, imdbId, normalizedKey);
    if (episodeLocator) addTaggedCacheKey(streamCacheKeysByEpisode, episodeLocator, normalizedKey);
}

function deleteStreamCacheKey(cacheKey) {
    const normalizedKey = String(cacheKey || '').trim();
    if (!normalizedKey) return 0;
    unregisterStreamCacheKey(normalizedKey);
    const deletedPrimary = myCache.del(getStreamCacheStorageKey(normalizedKey));
    rawCache.del(getStreamShadowStorageKey(normalizedKey));
    return deletedPrimary;
}

function extractManagedStreamCacheKey(storageKey, prefix) {
    const raw = String(storageKey || '');
    if (!raw.startsWith(prefix)) return null;
    const normalized = raw.slice(prefix.length).trim();
    return normalized || null;
}

function maybeUnregisterExpiredStreamCacheKey(cacheKey) {
    const normalizedKey = String(cacheKey || '').trim();
    if (!normalizedKey) return;
    if (myCache.get(getStreamCacheStorageKey(normalizedKey)) !== undefined) return;
    if (rawCache.get(getStreamShadowStorageKey(normalizedKey)) !== undefined) return;
    unregisterStreamCacheKey(normalizedKey);
}

myCache.on('expired', (storageKey) => {
    const cacheKey = extractManagedStreamCacheKey(storageKey, 'stream:');
    if (!cacheKey) return;
    maybeUnregisterExpiredStreamCacheKey(cacheKey);
});

rawCache.on('expired', (storageKey) => {
    const cacheKey = extractManagedStreamCacheKey(storageKey, 'stream_shadow:');
    if (!cacheKey) return;
    maybeUnregisterExpiredStreamCacheKey(cacheKey);
});

function collectTaggedStreamKeys(indexMap, tags) {
    const keys = new Set();
    for (const tag of tags) {
        const bucket = indexMap.get(tag);
        if (!bucket) continue;
        for (const cacheKey of bucket) keys.add(cacheKey);
    }
    return keys;
}

function supportsSharedStreamCache() {
    return SHARED_STREAM_CACHE_ENABLED
        && dbHelper
        && typeof dbHelper.getSharedStreamCache === 'function'
        && typeof dbHelper.setSharedStreamCache === 'function';
}

function writeLocalStreamCache(normalizedKey, value, ttl, tags = {}) {
    registerCacheSet('stream');
    registerStreamCacheKey(normalizedKey, tags);
    myCache.set(getStreamCacheStorageKey(normalizedKey), value, ttl);
    rawCache.set(getStreamShadowStorageKey(normalizedKey), {
        value,
        freshUntil: Date.now() + (Math.max(1, Number(ttl) || 1) * 1000)
    }, Math.max(ttl + STREAM_STALE_GRACE_TTL, STREAM_STALE_GRACE_TTL));
}

async function encodeSharedPayload(value) {
    const json = JSON.stringify(value);
    const source = Buffer.from(json, 'utf8');
    if (source.length > SHARED_STREAM_CACHE_MAX_BYTES) return null;

    let encoding = 'identity';
    let payload = source;

    if (SHARED_STREAM_CACHE_CODEC === 'zstd' && zstdCompressAsync) {
        payload = await zstdCompressAsync(source);
        payload = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
        encoding = 'zstd';
    } else if (SHARED_STREAM_CACHE_CODEC === 'brotli') {
        payload = await brotliCompressAsync(source, {
            params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 4 }
        });
        payload = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
        encoding = 'brotli';
    } else if (SHARED_STREAM_CACHE_CODEC === 'gzip') {
        payload = await gzipAsync(source, { level: 5 });
        payload = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
        encoding = 'gzip';
    }

    if (!payload || payload.length > SHARED_STREAM_CACHE_MAX_BYTES) return null;
    return { payload_b64: payload.toString('base64'), encoding };
}

async function decodeSharedPayload(row) {
    if (!row?.payload_b64) return null;
    try {
        const buffer = Buffer.from(String(row.payload_b64), 'base64');
        let decoded = buffer;
        const encoding = String(row.encoding || 'identity').toLowerCase();
        if (encoding === 'zstd' && zstdDecompressAsync) decoded = await zstdDecompressAsync(buffer);
        else if (encoding === 'brotli') decoded = await brotliDecompressAsync(buffer);
        else if (encoding === 'gzip') decoded = await gunzipAsync(buffer);
        const normalized = Buffer.isBuffer(decoded) ? decoded : Buffer.from(decoded);
        return JSON.parse(normalized.toString('utf8'));
    } catch (error) {
        logger.warn(`[CACHE] Shared stream decode failed: ${error.message}`);
        return null;
    }
}

async function hydrateLocalFromSharedCache(key, row, options = {}) {
    const normalizedKey = String(key || '').trim();
    if (!normalizedKey || !row) return null;
    const value = await decodeSharedPayload(row);
    if (!value) return null;

    const expiresAtMs = Date.parse(row.expires_at);
    const staleUntilMs = Date.parse(row.stale_until);
    const now = Date.now();
    const isFresh = Number.isFinite(expiresAtMs) ? expiresAtMs > now : false;
    const isStaleValid = Number.isFinite(staleUntilMs) ? staleUntilMs > now : isFresh;
    if (!isFresh && !isStaleValid) return null;

    const ttlSeconds = isFresh
        ? Math.max(1, Math.ceil((expiresAtMs - now) / 1000))
        : EMPTY_STREAM_TTL;
    writeLocalStreamCache(normalizedKey, value, ttlSeconds, {
        imdbId: row.imdb_id || null,
        imdbSeason: row.imdb_season,
        imdbEpisode: row.imdb_episode,
        episodeLocator: { imdbId: row.imdb_id || null, season: row.imdb_season, episode: row.imdb_episode },
        hashes: Array.isArray(row.hashes) ? row.hashes : []
    });

    if (options.onlyFresh && !isFresh) return null;
    return value;
}


function invalidateDbTorrentsLocal(key) {
    const normalizedKey = String(key || '').trim();
    if (!normalizedKey) return { deleted: 0, key: null };
    const deleted = rawCache.del(getDbLookupStorageKey(normalizedKey));
    return { deleted, key: normalizedKey };
}

function invalidateStreamsByHashesLocal(hashes) {
    const normalizedHashes = [...new Set((Array.isArray(hashes) ? hashes : [])
        .map(normalizeHashTag)
        .filter(Boolean))];
    if (normalizedHashes.length === 0) return { invalidated: 0, hashes: 0, deleted: 0 };

    const keys = collectTaggedStreamKeys(streamCacheKeysByHash, normalizedHashes);
    let deleted = 0;
    for (const cacheKey of keys) deleted += deleteStreamCacheKey(cacheKey);
    return { invalidated: keys.size, hashes: normalizedHashes.length, deleted, normalizedHashes };
}

function invalidateStreamsByImdbLocal(imdbId) {
    const normalizedImdb = normalizeImdbTag(imdbId);
    if (!normalizedImdb) return { invalidated: 0, imdbId: null, deleted: 0 };

    const keys = collectTaggedStreamKeys(streamCacheKeysByImdb, [normalizedImdb]);
    let deleted = 0;
    for (const cacheKey of keys) deleted += deleteStreamCacheKey(cacheKey);
    return { invalidated: keys.size, imdbId: normalizedImdb, deleted };
}

function invalidateStreamsByEpisodeLocal(episodePayload) {
    const normalizedEpisode = normalizeEpisodeTag(episodePayload);
    if (!normalizedEpisode) return { invalidated: 0, episode: null, deleted: 0 };

    const keys = collectTaggedStreamKeys(streamCacheKeysByEpisode, [normalizedEpisode]);
    let deleted = 0;
    for (const cacheKey of keys) deleted += deleteStreamCacheKey(cacheKey);
    return { invalidated: keys.size, episode: normalizedEpisode, deleted };
}

async function publishInvalidation(payload) {
    invalidationBus.emit('invalidate', payload);
    if (!dbHelper || typeof dbHelper.publishNotification !== 'function') return false;
    try {
        await dbHelper.publishNotification(CACHE_INVALIDATION_CHANNEL, payload);
        return true;
    } catch (error) {
        logger.warn(`[CACHE] Notification publish failed: ${error.message}`);
        return false;
    }
}

function persistSharedStreamCacheInBackground(normalizedKey, value, tags = {}, sharedPolicy = {}) {
    if (!normalizedKey || !supportsSharedStreamCache()) return false;

    const existing = sharedStreamPersistInflight.get(normalizedKey);
    if (existing) return true;

    const task = enqueueSharedStreamWrite(async () => {
        const encoded = await encodeSharedPayload(value);
        if (!encoded) {
            incrementMetric('cache.stream.sharedSkipped');
            return false;
        }

        const staleGraceTtl = Math.max(0, Number(sharedPolicy.staleGraceTtl || STREAM_STALE_GRACE_TTL) || STREAM_STALE_GRACE_TTL);
        const sharedTtl = Math.max(0, Number(sharedPolicy.sharedTtl || 0) || 0);
        const expiresAt = new Date(Date.now() + (sharedTtl * 1000));
        const staleUntil = new Date(expiresAt.getTime() + (staleGraceTtl * 1000));

        const persisted = await dbHelper.setSharedStreamCache({
            cache_key: normalizedKey,
            payload_b64: encoded.payload_b64,
            encoding: encoded.encoding,
            expires_at: expiresAt,
            stale_until: staleUntil,
            imdb_id: tags?.imdbId || null,
            imdb_season: Number.isInteger(Number(tags?.imdbSeason)) ? Number(tags.imdbSeason) : null,
            imdb_episode: Number.isInteger(Number(tags?.imdbEpisode)) ? Number(tags.imdbEpisode) : null,
            hashes: Array.isArray(tags?.hashes) ? tags.hashes : [],
            content_date: sharedPolicy.contentDateIso || null,
            freshness_bucket: sharedPolicy.freshnessBucket || null,
            confidence_score: sharedPolicy.confidenceScore,
            result_count: sharedPolicy.streamCount,
            cached_count: sharedPolicy.cachedCount,
            best_quality: sharedPolicy.bestQuality || null,
            source_mix: Array.isArray(sharedPolicy.sourceMix) ? sharedPolicy.sourceMix : [],
            policy_version: sharedPolicy.version || null
        });

        if (persisted) incrementMetric('cache.stream.sharedSet');
        return persisted;
    });

    sharedStreamPersistInflight.set(normalizedKey, task);
    task.catch((error) => {
        logger.warn(`[CACHE] Shared stream cache write failed | key=${normalizedKey} | error=${error.message}`);
    }).finally(() => {
        sharedStreamPersistInflight.delete(normalizedKey);
    });
    incrementMetric('cache.stream.sharedQueued');
    return true;
}

async function applyRemoteInvalidation(payload = {}) {
    const scope = String(payload?.scope || '').trim();
    if (!scope) return;
    const samePid = payload?.originPid && Number(payload.originPid) === SHARED_STREAM_CACHE_PROCESS_ID;
    const sameNode = payload?.originNodeId && String(payload.originNodeId) === SHARED_STREAM_CACHE_NODE_ID;
    if (samePid && sameNode) return;

    if (scope === 'dblookup') {
        const outcome = invalidateDbTorrentsLocal(payload.key);
        if (outcome.deleted > 0) incrementMetric('cache.sync.remoteInvalidations');
        return;
    }

    if (scope === 'hashes') {
        const outcome = invalidateStreamsByHashesLocal(payload.hashes);
        if (outcome.invalidated > 0) incrementMetric('cache.sync.remoteInvalidations');
        return;
    }

    if (scope === 'imdb') {
        const outcome = invalidateStreamsByImdbLocal(payload.imdbId);
        if (outcome.invalidated > 0) incrementMetric('cache.sync.remoteInvalidations');
        return;
    }

    if (scope === 'episode') {
        const outcome = invalidateStreamsByEpisodeLocal(payload.episode);
        if (outcome.invalidated > 0) incrementMetric('cache.sync.remoteInvalidations');
    }
}

async function startInvalidationSync() {
    if (invalidationSyncStarted) return true;
    invalidationSyncStarted = true;
    if (!dbHelper || typeof dbHelper.subscribeNotifications !== 'function') return true;

    invalidationSyncStop = await dbHelper.subscribeNotifications(CACHE_INVALIDATION_CHANNEL, (payload) => {
        applyRemoteInvalidation(payload).catch((error) => {
            logger.warn(`[CACHE] Remote invalidation failed: ${error.message}`);
        });
    });
    return true;
}

async function stopInvalidationSync() {
    if (typeof invalidationSyncStop === 'function') {
        await invalidationSyncStop();
    }
    invalidationSyncStop = null;
    invalidationSyncStarted = false;
}

const Cache = {
    getCachedMagnets: async (key) => myCache.get(`magnets:${key}`) || null,
    cacheMagnets: async (key, value, ttl = 3600) => { myCache.set(`magnets:${key}`, value, ttl); },
    getCachedStream: async (key, options = {}) => {
        const normalizedKey = String(key || '').trim();
        const allowLocal = options?.allowLocal !== false;
        const allowShared = options?.allowShared !== false;
        const evaluator = typeof options?.sharedEntryEvaluator === 'function' ? options.sharedEntryEvaluator : null;

        if (allowLocal) {
            const data = myCache.get(getStreamCacheStorageKey(normalizedKey));
            if (data) {
                registerCacheAccess('stream', true);
                if (VERBOSE_CACHE_LOGS) logger.info(`⚡ CACHE HIT (USER): ${key}`);
                return data;
            }
            unregisterStreamCacheKey(normalizedKey);
        }

        if (!allowShared || !supportsSharedStreamCache()) {
            registerCacheAccess('stream', false);
            return null;
        }

        try {
            const sharedRow = await dbHelper.getSharedStreamCache(normalizedKey, { touchHit: false });
            const hydrated = await hydrateLocalFromSharedCache(normalizedKey, sharedRow, { onlyFresh: true });
            if (hydrated && evaluator && evaluator(sharedRow, hydrated) !== true) {
                incrementMetric('cache.stream.sharedRejected');
                registerCacheAccess('stream', false);
                return null;
            }
            registerCacheAccess('stream', !!hydrated);
            if (hydrated) {
                incrementMetric('cache.stream.sharedHits');
                if (typeof dbHelper.touchSharedStreamCacheHit === 'function') {
                    try { await dbHelper.touchSharedStreamCacheHit(normalizedKey); } catch (_) {}
                }
            }
            return hydrated;
        } catch (error) {
            registerCacheAccess('stream', false);
            logger.warn(`[CACHE] Shared stream cache lookup failed | key=${normalizedKey} | error=${error.message}`);
            return null;
        }
    },
    cacheStream: async (key, value, ttl = 1800, tags = {}, options = {}) => {
        const normalizedKey = String(key || '').trim();
        const sharedPolicy = options?.sharedPolicy || {};
        const localTtl = Math.max(1, Number(sharedPolicy.localTtl || ttl) || 1);
        writeLocalStreamCache(normalizedKey, value, localTtl, tags);

        const sharedTtl = Math.max(0, Number(sharedPolicy.sharedTtl || 0) || 0);
        if (!supportsSharedStreamCache() || sharedPolicy.allowSharedWrite === false || sharedTtl <= 0) {
            if (supportsSharedStreamCache()) incrementMetric('cache.stream.sharedSkipped');
            return;
        }

        persistSharedStreamCacheInBackground(normalizedKey, value, tags, {
            ...sharedPolicy,
            sharedTtl
        });
    },
    getStaleStream: async (key, options = {}) => {
        const normalizedKey = String(key || '').trim();
        const allowLocal = options?.allowLocal !== false;
        const allowShared = options?.allowShared !== false;
        const evaluator = typeof options?.sharedEntryEvaluator === 'function' ? options.sharedEntryEvaluator : null;

        if (allowLocal) {
            const shadow = rawCache.get(getStreamShadowStorageKey(normalizedKey)) || null;
            if (shadow && typeof shadow === 'object' && 'value' in shadow) return shadow.value || null;
        }

        if (!allowShared || !supportsSharedStreamCache()) return null;
        try {
            const sharedRow = await dbHelper.getSharedStreamCache(normalizedKey, { touchHit: false });
            const hydrated = await hydrateLocalFromSharedCache(normalizedKey, sharedRow, { onlyFresh: false });
            if (hydrated && evaluator && evaluator(sharedRow, hydrated) !== true) {
                incrementMetric('cache.stream.sharedStaleRejected');
                return null;
            }
            if (hydrated) {
                incrementMetric('cache.stream.sharedStaleHits');
                if (typeof dbHelper.touchSharedStreamCacheHit === 'function') {
                    try { await dbHelper.touchSharedStreamCacheHit(normalizedKey); } catch (_) {}
                }
            }
            return hydrated;
        } catch (_) {
            return null;
        }
    },
    getMetadata: async (key) => {
        const data = myCache.get(`meta:${key}`) || null;
        registerCacheAccess('metadata', !!data);
        return data;
    },
    cacheMetadata: async (key, value, ttl = METADATA_CACHE_TTL) => {
        registerCacheSet('metadata');
        myCache.set(`meta:${key}`, value, ttl);
    },
    getResolvedUrl: async (key) => {
        const data = myCache.get(`resolved:${key}`) || null;
        registerCacheAccess('lazy', !!data);
        return data;
    },
    cacheResolvedUrl: async (key, value, ttl = RESOLVED_URL_TTL) => {
        registerCacheSet('lazy');
        const effectiveTtl = value ? ttl : Math.min(ttl, EMPTY_RESOLVED_URL_TTL);
        myCache.set(`resolved:${key}`, value, effectiveTtl);
    },
    getLazyLink: async (key) => Cache.getResolvedUrl(key),
    cacheLazyLink: async (key, value, ttl = RESOLVED_URL_TTL) => Cache.cacheResolvedUrl(key, value, ttl),
    getAvailability: async (key) => {
        const data = myCache.get(`availability:${key}`) || null;
        registerCacheAccess('raw', !!data);
        return data;
    },
    cacheAvailability: async (key, value, ttl = AVAILABILITY_CACHE_TTL) => {
        registerCacheSet('raw');
        const normalizedValue = value && typeof value === 'object' ? value : (value ? { value } : null);
        const effectiveTtl = normalizedValue ? ttl : Math.min(ttl, EMPTY_AVAILABILITY_TTL);
        myCache.set(`availability:${key}`, normalizedValue, effectiveTtl);
    },
    getLazyMeta: async (key) => {
        const data = myCache.get(`lazy_meta:${key}`) || null;
        registerCacheAccess('lazy', !!data);
        return data;
    },
    cacheLazyMeta: async (key, value, ttl = 43200) => {
        registerCacheSet('lazy');
        myCache.set(`lazy_meta:${key}`, value, ttl);
    },
    getDbTorrents: async (key) => {
        const data = rawCache.get(getDbLookupStorageKey(key));
        const hit = data !== undefined;
        registerCacheAccess('dbLookup', hit);
        return hit ? data : null;
    },
    cacheDbTorrents: async (key, value, ttl = DB_LOOKUP_CACHE_TTL) => {
        registerCacheSet('dbLookup');
        rawCache.set(getDbLookupStorageKey(key), Array.isArray(value) ? value : [], ttl);
    },
    invalidateDbTorrents: async (key, reason = 'db_update') => {
        const outcome = invalidateDbTorrentsLocal(key);
        if (outcome.deleted > 0) {
            incrementMetric('cache.db.invalidations');
            logger.info(`[CACHE] DB lookup invalidation | reason=${reason} | key=${outcome.key}`);
        }
        await publishInvalidation({ scope: 'dblookup', key: outcome.key, reason, originPid: process.pid, originNodeId: SHARED_STREAM_CACHE_NODE_ID, ts: Date.now() });
        return outcome;
    },
    getCloudBuild: async (key) => {
        const data = cloudBuildCache.get(`cloud:${key}`) || null;
        registerCacheAccess('cloud', !!data);
        return data;
    },
    setCloudBuild: async (key, value, ttl = 900) => {
        registerCacheSet('cloud');
        cloudBuildCache.set(`cloud:${key}`, value, ttl);
    },
    startInvalidationSync,
    stopInvalidationSync,
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
        sharedStreamPersistInflight.clear();
        sharedStreamWriteQueue.length = 0;
        sharedStreamWriteActive = 0;
        streamCacheTags.clear();
        streamCacheKeysByHash.clear();
        streamCacheKeysByImdb.clear();
        streamCacheKeysByEpisode.clear();
    },
    invalidateStreamsByHashes: async (hashes, reason = 'hash_update') => {
        const localOutcome = invalidateStreamsByHashesLocal(hashes);
        if ((localOutcome.normalizedHashes || []).length === 0) return { invalidated: 0, hashes: 0, deleted: 0, sharedDeleted: 0 };

        let sharedDeleted = 0;
        if (supportsSharedStreamCache() && typeof dbHelper.deleteSharedStreamCacheByHashes === 'function') {
            try {
                sharedDeleted = await dbHelper.deleteSharedStreamCacheByHashes(localOutcome.normalizedHashes);
            } catch (_) {}
        }

        if (localOutcome.invalidated > 0 || sharedDeleted > 0) {
            incrementMetric('cache.stream.invalidations');
            incrementMetric('cache.stream.invalidatedKeys', localOutcome.invalidated + sharedDeleted);
            logger.info(`[CACHE] Stream invalidation by hash | reason=${reason} | hashes=${localOutcome.hashes} | keys=${localOutcome.invalidated} | shared=${sharedDeleted}`);
        }

        await publishInvalidation({ scope: 'hashes', hashes: localOutcome.normalizedHashes, reason, originPid: process.pid, originNodeId: SHARED_STREAM_CACHE_NODE_ID, ts: Date.now() });
        return { invalidated: localOutcome.invalidated, hashes: localOutcome.hashes, deleted: localOutcome.deleted, sharedDeleted };
    },
    invalidateStreamsByImdb: async (imdbId, reason = 'imdb_update') => {
        const localOutcome = invalidateStreamsByImdbLocal(imdbId);
        if (!localOutcome.imdbId) return { invalidated: 0, imdbId: null, deleted: 0, sharedDeleted: 0 };

        let sharedDeleted = 0;
        if (supportsSharedStreamCache() && typeof dbHelper.deleteSharedStreamCacheByImdb === 'function') {
            try {
                sharedDeleted = await dbHelper.deleteSharedStreamCacheByImdb(localOutcome.imdbId);
            } catch (_) {}
        }

        if (localOutcome.invalidated > 0 || sharedDeleted > 0) {
            incrementMetric('cache.stream.invalidations');
            incrementMetric('cache.stream.invalidatedKeys', localOutcome.invalidated + sharedDeleted);
            logger.info(`[CACHE] Stream invalidation by imdb | reason=${reason} | imdb=${localOutcome.imdbId} | keys=${localOutcome.invalidated} | shared=${sharedDeleted}`);
        }

        await publishInvalidation({ scope: 'imdb', imdbId: localOutcome.imdbId, reason, originPid: process.pid, originNodeId: SHARED_STREAM_CACHE_NODE_ID, ts: Date.now() });
        return { invalidated: localOutcome.invalidated, imdbId: localOutcome.imdbId, deleted: localOutcome.deleted, sharedDeleted };
    },
    invalidateStreamsByEpisode: async (episodePayload, reason = 'episode_update') => {
        const localOutcome = invalidateStreamsByEpisodeLocal(episodePayload);
        if (!localOutcome.episode) return { invalidated: 0, episode: null, deleted: 0, sharedDeleted: 0 };

        let sharedDeleted = 0;
        if (supportsSharedStreamCache() && typeof dbHelper.deleteSharedStreamCacheByEpisode === 'function') {
            const [imdbId, season, episode] = localOutcome.episode.split(':');
            try {
                sharedDeleted = await dbHelper.deleteSharedStreamCacheByEpisode(imdbId, Number(season), Number(episode));
            } catch (_) {}
        }

        if (localOutcome.invalidated > 0 || sharedDeleted > 0) {
            incrementMetric('cache.stream.invalidations');
            incrementMetric('cache.stream.invalidatedKeys', localOutcome.invalidated + sharedDeleted);
            logger.info(`[CACHE] Stream invalidation by episode | reason=${reason} | episode=${localOutcome.episode} | keys=${localOutcome.invalidated} | shared=${sharedDeleted}`);
        }

        await publishInvalidation({ scope: 'episode', episode: localOutcome.episode, reason, originPid: process.pid, originNodeId: SHARED_STREAM_CACHE_NODE_ID, ts: Date.now() });
        return { invalidated: localOutcome.invalidated, episode: localOutcome.episode, deleted: localOutcome.deleted, sharedDeleted };
    },
    getStreamCacheIndexStats: () => ({
        trackedKeys: streamCacheTags.size,
        hashBuckets: streamCacheKeysByHash.size,
        imdbBuckets: streamCacheKeysByImdb.size,
        episodeBuckets: streamCacheKeysByEpisode.size,
        cachedEntries: myCache.keys().filter((key) => String(key).startsWith('stream:')).length,
        staleEntries: rawCache.keys().filter((key) => String(key).startsWith('stream_shadow:')).length,
        dbLookupEntries: rawCache.keys().filter((key) => String(key).startsWith('dblookup:')).length,
        sharedEnabled: supportsSharedStreamCache(),
        rawStream: RawStreamCache.stats()
    }),
    getRaw: (provider, id) => {
        const data = rawCache.get(`raw:${provider}:${id}`);
        registerCacheAccess('raw', !!data);
        if (data && VERBOSE_CACHE_LOGS) logger.info(`🌍 GLOBAL CACHE HIT [${provider}]: ${id}`);
        return data || null;
    },
    setRaw: (provider, id, value, ttl = 43200) => {
        registerCacheSet('raw');
        rawCache.set(`raw:${provider}:${id}`, value, ttl);
        if (VERBOSE_CACHE_LOGS) logger.info(`💾 GLOBAL CACHE SET [${provider}]: ${id}`);
    },
    fetchWithCache: async (provider, id, ttl = RAW_PROVIDER_CACHE_TTL, fetcherFunc, options = {}) => {
        const cacheOnly = options?.cacheOnly === true;
        const bypassCache = options?.bypassCache === true;
        const emptyTtl = Math.max(1, Number(options?.emptyTtl || EMPTY_FETCH_TTL) || EMPTY_FETCH_TTL);
        const errorTtl = Math.max(1, Number(options?.errorTtl || Math.min(emptyTtl, EMPTY_FETCH_TTL)) || Math.min(emptyTtl, EMPTY_FETCH_TTL));
        const effectiveTtl = Math.max(1, Number(ttl || RAW_PROVIDER_CACHE_TTL) || RAW_PROVIDER_CACHE_TTL);

        if (!bypassCache) {
            const cached = Cache.getRaw(provider, id);
            if (cached !== null) return cached;
            if (cacheOnly) return [];
        }

        const inflightKey = `${provider}:${id}`;
        return withSharedPromise(sharedFetchInflight, inflightKey, async () => {
            if (!bypassCache) {
                const secondCacheHit = Cache.getRaw(provider, id);
                if (secondCacheHit !== null) return secondCacheHit;
                if (cacheOnly) return [];
            }

            try {
                const freshData = await fetcherFunc();
                const normalized = Array.isArray(freshData) ? freshData : (freshData ? [freshData] : []);
                Cache.setRaw(provider, id, normalized, normalized.length > 0 ? effectiveTtl : emptyTtl);
                return normalized;
            } catch (error) {
                logger.warn(`⚠️ Errore Fetching [${provider}] per ${id}: ${error.message}`);
                Cache.setRaw(provider, id, [], errorTtl);
                return [];
            }
        });
    }
};

module.exports = {
    Cache,
    myCache,
    rawCache,
    cloudBuildCache,
    cloudBuildInflight,
    sharedFetchInflight,
    streamInflight,
    metadataInflight,
    RAW_PROVIDER_CACHE_TTL,
    EMPTY_FETCH_TTL,
    EMPTY_STREAM_TTL,
    STREAM_STALE_GRACE_TTL,
    METADATA_CACHE_TTL,
    RESOLVED_URL_TTL,
    EMPTY_RESOLVED_URL_TTL,
    AVAILABILITY_CACHE_TTL,
    EMPTY_AVAILABILITY_TTL,
    DB_LOOKUP_CACHE_TTL,
    VERBOSE_CACHE_LOGS
};
