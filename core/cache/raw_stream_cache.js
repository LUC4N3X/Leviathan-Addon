'use strict';

const crypto = require('crypto');
const zlib = require('zlib');
const { promisify } = require('util');
const NodeCache = require('node-cache');
const {
    logger: defaultLogger,
    incrementMetric,
    registerCacheAccess,
    registerCacheSet
} = require('../utils/runtime');

const RAW_STREAM_CACHE_ENABLED = true;
const RAW_STREAM_CACHE_TTL_SECONDS = 900;
const RAW_STREAM_CACHE_COMPRESS = true;
const RAW_STREAM_CACHE_MAX_BYTES = 500000;
const RAW_STREAM_CACHE_MAX_KEYS = 12000;
const RAW_STREAM_CACHE_CODEC = 'deflate';
const RAW_STREAM_CACHE_VERSION = 'raw-stream-v2';

const deflateAsync = promisify(zlib.deflate);
const inflateAsync = promisify(zlib.inflate);

const rawStreamCache = new NodeCache({
    stdTTL: RAW_STREAM_CACHE_TTL_SECONDS,
    checkperiod: 60,
    maxKeys: RAW_STREAM_CACHE_MAX_KEYS,
    useClones: false,
    deleteOnExpire: true
});

const rawStreamCacheIndexByLabel = new Map();

function sha256(value) {
    return crypto.createHash('sha256').update(String(value || '')).digest('hex');
}

function normalizeIdPart(value) {
    return String(value || '')
        .trim()
        .replace(/\.json$/i, '')
        .replace(/[^a-z0-9:._-]+/gi, '_')
        .slice(0, 180) || 'unknown';
}

function buildRawStreamCacheKey(type, id, userConfStr) {
    const normalizedType = normalizeIdPart(type).toLowerCase();
    const normalizedId = normalizeIdPart(id);
    const confHash = sha256(userConfStr || 'no-conf').slice(0, 24);
    return `${RAW_STREAM_CACHE_VERSION}:${normalizedType}:${normalizedId}:${confHash}`;
}

function buildRawStreamCacheLabel(type, id) {
    return `${normalizeIdPart(type).toLowerCase()}:${normalizeIdPart(id)}`;
}

function indexRawStreamCacheKey(label, key) {
    if (!label || !key) return;
    let keys = rawStreamCacheIndexByLabel.get(label);
    if (!keys) {
        keys = new Set();
        rawStreamCacheIndexByLabel.set(label, keys);
    }
    keys.add(key);
}

function unindexRawStreamCacheKey(label, key) {
    if (!label || !key) return;
    const keys = rawStreamCacheIndexByLabel.get(label);
    if (!keys) return;
    keys.delete(key);
    if (keys.size === 0) rawStreamCacheIndexByLabel.delete(label);
}

function unindexRawStreamCacheEntry(key, entry) {
    if (!key || !entry || typeof entry !== 'object') return;
    unindexRawStreamCacheKey(entry.label, key);
}

rawStreamCache.on('expired', unindexRawStreamCacheEntry);
rawStreamCache.on('del', unindexRawStreamCacheEntry);

function compactAge(ms) {
    const seconds = Math.max(0, Math.floor(Number(ms || 0) / 1000));
    if (seconds < 60) return `${seconds}s`;
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m`;
    return `${Math.floor(minutes / 60)}h${minutes % 60 ? ` ${minutes % 60}m` : ''}`;
}

function shouldCachePayload(payload) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return { ok: false, reason: 'invalid_payload' };
    if (!Array.isArray(payload.streams)) return { ok: false, reason: 'missing_streams' };
    if (payload.streams.length === 0) return { ok: false, reason: 'empty' };
    return { ok: true };
}

async function encodePayload(payload) {
    const json = JSON.stringify(payload);
    const rawBuffer = Buffer.from(json, 'utf8');
    if (rawBuffer.length > RAW_STREAM_CACHE_MAX_BYTES) {
        return { skipped: true, reason: 'too_large', bytes: rawBuffer.length };
    }

    if (!RAW_STREAM_CACHE_COMPRESS) {
        return {
            entry: {
                compressed: false,
                encoding: 'identity',
                payload: rawBuffer,
                rawBytes: rawBuffer.length,
                storedBytes: rawBuffer.length,
                createdAt: Date.now()
            }
        };
    }

    const compressed = await deflateAsync(rawBuffer, { level: 6 });
    const stored = Buffer.isBuffer(compressed) ? compressed : Buffer.from(compressed);
    if (stored.length > RAW_STREAM_CACHE_MAX_BYTES) {
        return { skipped: true, reason: 'too_large_compressed', bytes: stored.length };
    }

    return {
        entry: {
            compressed: true,
            encoding: RAW_STREAM_CACHE_CODEC,
            payload: stored,
            rawBytes: rawBuffer.length,
            storedBytes: stored.length,
            createdAt: Date.now()
        }
    };
}

async function decodeEntry(entry) {
    if (!entry || !Buffer.isBuffer(entry.payload)) return null;
    const buffer = entry.compressed ? await inflateAsync(entry.payload) : entry.payload;
    return JSON.parse(Buffer.from(buffer).toString('utf8'));
}

async function getRawStreamCache(type, id, userConfStr, options = {}) {
    if (!RAW_STREAM_CACHE_ENABLED) return null;
    const log = options.logger || defaultLogger;
    const key = buildRawStreamCacheKey(type, id, userConfStr);
    const label = buildRawStreamCacheLabel(type, id);
    const entry = rawStreamCache.get(key);

    if (!entry) {
        registerCacheAccess('raw', false);
        incrementMetric('rawStreamCache.miss');
        return null;
    }

    try {
        const payload = await decodeEntry(entry);
        if (!payload || typeof payload !== 'object') throw new Error('decoded payload non valido');
        registerCacheAccess('raw', true);
        incrementMetric('rawStreamCache.hit');
        log.info(`[RAW CACHE] hit key=${label} compressed=${entry.compressed === true} age=${compactAge(Date.now() - Number(entry.createdAt || Date.now()))}`);
        return payload;
    } catch (error) {
        rawStreamCache.del(key);
        unindexRawStreamCacheKey(label, key);
        registerCacheAccess('raw', false);
        incrementMetric('rawStreamCache.decodeError');
        log.warn(`[RAW CACHE] drop key=${label} reason=decode_error error=${error.message}`);
        return null;
    }
}

async function setRawStreamCache(type, id, userConfStr, payload, options = {}) {
    if (!RAW_STREAM_CACHE_ENABLED) return false;
    const log = options.logger || defaultLogger;
    const label = buildRawStreamCacheLabel(type, id);
    const cacheable = shouldCachePayload(payload);
    if (!cacheable.ok) {
        incrementMetric(`rawStreamCache.skip.${cacheable.reason}`);
        log.info(`[RAW CACHE] skip reason=${cacheable.reason} key=${label}`);
        return false;
    }

    try {
        const encoded = await encodePayload(payload);
        if (encoded.skipped) {
            incrementMetric(`rawStreamCache.skip.${encoded.reason}`);
            log.info(`[RAW CACHE] skip reason=${encoded.reason} bytes=${encoded.bytes} key=${label}`);
            return false;
        }

        const key = buildRawStreamCacheKey(type, id, userConfStr);
        const entry = {
            ...encoded.entry,
            label
        };
        rawStreamCache.set(key, entry, RAW_STREAM_CACHE_TTL_SECONDS);
        indexRawStreamCacheKey(label, key);
        registerCacheSet('raw');
        incrementMetric('rawStreamCache.set');
        log.info(`[RAW CACHE] saved key=${label} compressed=${entry.compressed === true} bytes=${entry.rawBytes}->${entry.storedBytes} ttl=${RAW_STREAM_CACHE_TTL_SECONDS}s`);
        return true;
    } catch (error) {
        incrementMetric('rawStreamCache.setError');
        log.warn(`[RAW CACHE] skip reason=encode_error key=${label} error=${error.message}`);
        return false;
    }
}

function flushRawStreamCache() {
    rawStreamCache.flushAll();
    rawStreamCacheIndexByLabel.clear();
}

function invalidateRawStreamCacheByPage(type, id, options = {}) {
    if (!RAW_STREAM_CACHE_ENABLED) return { invalidated: 0, label: buildRawStreamCacheLabel(type, id) };
    const log = options.logger || defaultLogger;
    const reason = options.reason || 'manual';
    const label = buildRawStreamCacheLabel(type, id);
    const keys = rawStreamCacheIndexByLabel.get(label);
    if (!keys || keys.size === 0) return { invalidated: 0, label };

    let invalidated = 0;
    for (const key of Array.from(keys)) {
        const deleted = rawStreamCache.del(key);
        invalidated += Number(deleted || 0);
    }
    rawStreamCacheIndexByLabel.delete(label);
    incrementMetric('rawStreamCache.invalidateByPage');
    log.info(`[RAW CACHE] invalidated key=${label} reason=${reason} entries=${invalidated}`);
    return { invalidated, label };
}

function getRawStreamCacheStats() {
    const indexedKeys = Array.from(rawStreamCacheIndexByLabel.values())
        .reduce((count, keys) => count + (keys?.size || 0), 0);
    return {
        enabled: RAW_STREAM_CACHE_ENABLED,
        ttlSeconds: RAW_STREAM_CACHE_TTL_SECONDS,
        compressed: RAW_STREAM_CACHE_COMPRESS,
        codec: RAW_STREAM_CACHE_CODEC,
        maxBytes: RAW_STREAM_CACHE_MAX_BYTES,
        keys: rawStreamCache.keys().length,
        indexedPages: rawStreamCacheIndexByLabel.size,
        indexedKeys
    };
}

module.exports = {
    RAW_STREAM_CACHE_ENABLED,
    RAW_STREAM_CACHE_TTL_SECONDS,
    RAW_STREAM_CACHE_COMPRESS,
    RAW_STREAM_CACHE_MAX_BYTES,
    buildRawStreamCacheKey,
    buildRawStreamCacheLabel,
    getRawStreamCache,
    setRawStreamCache,
    flushRawStreamCache,
    invalidateRawStreamCacheByPage,
    getRawStreamCacheStats
};
