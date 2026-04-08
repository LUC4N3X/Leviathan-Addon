require('dotenv').config();

const NodeCache = require('node-cache');

const { logger, incrementMetric, registerCacheAccess, registerCacheSet } = require('./utils_runtime');
const { withSharedPromise } = require('./utils_common');

const myCache = new NodeCache({ stdTTL: 1800, checkperiod: 120, maxKeys: 5000 });
const rawCache = new NodeCache({ stdTTL: 43200, checkperiod: 600, maxKeys: 15000 });
const cloudBuildCache = new NodeCache({ stdTTL: 900, checkperiod: 60, maxKeys: 5000 });
const cloudBuildInflight = new Map();
const sharedFetchInflight = new Map();
const streamInflight = new Map();
const metadataInflight = new Map();

const EMPTY_FETCH_TTL = Math.max(parseInt(process.env.EMPTY_FETCH_TTL || '90', 10) || 90, 15);
const EMPTY_STREAM_TTL = Math.max(parseInt(process.env.EMPTY_STREAM_TTL || '60', 10) || 60, 15);
const STREAM_STALE_GRACE_TTL = Math.max(parseInt(process.env.STREAM_STALE_GRACE_TTL || '180', 10) || 180, 30);
const METADATA_CACHE_TTL = Math.max(parseInt(process.env.METADATA_CACHE_TTL || '1800', 10) || 1800, 60);
const VERBOSE_CACHE_LOGS = String(process.env.VERBOSE_CACHE_LOGS || 'false').toLowerCase() === 'true';

const streamCacheTags = new Map();
const streamCacheKeysByHash = new Map();
const streamCacheKeysByImdb = new Map();

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
    const deletedPrimary = myCache.del(getStreamCacheStorageKey(normalizedKey));
    rawCache.del(getStreamShadowStorageKey(normalizedKey));
    return deletedPrimary;
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
    getCachedMagnets: async (key) => myCache.get(`magnets:${key}`) || null,
    cacheMagnets: async (key, value, ttl = 3600) => { myCache.set(`magnets:${key}`, value, ttl); },
    getCachedStream: async (key) => {
        const normalizedKey = String(key || '').trim();
        const data = myCache.get(getStreamCacheStorageKey(normalizedKey));
        registerCacheAccess('stream', !!data);
        if (data && VERBOSE_CACHE_LOGS) logger.info(`⚡ CACHE HIT (USER): ${key}`);
        else unregisterStreamCacheKey(normalizedKey);
        return data || null;
    },
    cacheStream: async (key, value, ttl = 1800, tags = {}) => {
        const normalizedKey = String(key || '').trim();
        registerCacheSet('stream');
        registerStreamCacheKey(normalizedKey, tags);
        myCache.set(getStreamCacheStorageKey(normalizedKey), value, ttl);
        rawCache.set(getStreamShadowStorageKey(normalizedKey), {
            value,
            freshUntil: Date.now() + (Math.max(1, Number(ttl) || 1) * 1000)
        }, Math.max(ttl + STREAM_STALE_GRACE_TTL, STREAM_STALE_GRACE_TTL));
    },
    getStaleStream: async (key) => {
        const normalizedKey = String(key || '').trim();
        const shadow = rawCache.get(getStreamShadowStorageKey(normalizedKey)) || null;
        if (!shadow || typeof shadow !== 'object' || !('value' in shadow)) return null;
        return shadow.value || null;
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
    getLazyLink: async (key) => {
        const data = myCache.get(`lazy:${key}`) || null;
        registerCacheAccess('lazy', !!data);
        return data;
    },
    cacheLazyLink: async (key, value, ttl = 120) => {
        registerCacheSet('lazy');
        myCache.set(`lazy:${key}`, value, ttl);
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
    cacheDbTorrents: async (key, value, ttl = 30) => {
        registerCacheSet('dbLookup');
        rawCache.set(getDbLookupStorageKey(key), Array.isArray(value) ? value : [], ttl);
    },
    invalidateDbTorrents: async (key, reason = 'db_update') => {
        const normalizedKey = String(key || '').trim();
        if (!normalizedKey) return { deleted: 0, key: null };
        const deleted = rawCache.del(getDbLookupStorageKey(normalizedKey));
        if (deleted > 0) {
            incrementMetric('cache.db.invalidations');
            logger.info(`[CACHE] DB lookup invalidation | reason=${reason} | key=${normalizedKey}`);
        }
        return { deleted, key: normalizedKey };
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
        cachedEntries: myCache.keys().filter((key) => String(key).startsWith('stream:')).length,
        staleEntries: rawCache.keys().filter((key) => String(key).startsWith('stream_shadow:')).length,
        dbLookupEntries: rawCache.keys().filter((key) => String(key).startsWith('dblookup:')).length
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

module.exports = {
    Cache,
    myCache,
    rawCache,
    cloudBuildCache,
    cloudBuildInflight,
    sharedFetchInflight,
    streamInflight,
    metadataInflight,
    EMPTY_FETCH_TTL,
    EMPTY_STREAM_TTL,
    STREAM_STALE_GRACE_TTL,
    METADATA_CACHE_TTL,
    VERBOSE_CACHE_LOGS
};
