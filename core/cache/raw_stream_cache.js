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
const RAW_STREAM_CACHE_VERSION = 'raw-stream-v1';

const deflateAsync = promisify(zlib.deflate);
const inflateAsync = promisify(zlib.inflate);

const rawStreamCache = new NodeCache({
    stdTTL: RAW_STREAM_CACHE_TTL_SECONDS,
    checkperiod: 60,
    maxKeys: RAW_STREAM_CACHE_MAX_KEYS,
    useClones: false,
    deleteOnExpire: true
});

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
        rawStreamCache.set(key, encoded.entry, RAW_STREAM_CACHE_TTL_SECONDS);
        registerCacheSet('raw');
        incrementMetric('rawStreamCache.set');
        log.info(`[RAW CACHE] saved key=${label} compressed=${encoded.entry.compressed === true} bytes=${encoded.entry.rawBytes}->${encoded.entry.storedBytes} ttl=${RAW_STREAM_CACHE_TTL_SECONDS}s`);
        return true;
    } catch (error) {
        incrementMetric('rawStreamCache.setError');
        log.warn(`[RAW CACHE] skip reason=encode_error key=${label} error=${error.message}`);
        return false;
    }
}

function flushRawStreamCache() {
    rawStreamCache.flushAll();
}

function getRawStreamCacheStats() {
    return {
        enabled: RAW_STREAM_CACHE_ENABLED,
        ttlSeconds: RAW_STREAM_CACHE_TTL_SECONDS,
        compressed: RAW_STREAM_CACHE_COMPRESS,
        codec: RAW_STREAM_CACHE_CODEC,
        maxBytes: RAW_STREAM_CACHE_MAX_BYTES,
        keys: rawStreamCache.keys().length
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
    getRawStreamCacheStats
};
