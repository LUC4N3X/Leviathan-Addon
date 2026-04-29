'use strict';

const zlib = require('zlib');
const { promisify } = require('util');
const NodeCache = require('node-cache');
const { logger, incrementMetric, registerCacheAccess, registerCacheSet } = require('../utils/runtime');

const gzipAsync = promisify(zlib.gzip);
const gunzipAsync = promisify(zlib.gunzip);

function envBool(name, fallback) {
    const raw = process.env[name];
    if (raw === undefined || raw === null || raw === '') return fallback;
    return /^(?:1|true|yes|on)$/i.test(String(raw).trim());
}

function envInt(name, fallback, min, max) {
    const parsed = parseInt(process.env[name] || String(fallback), 10);
    const value = Number.isFinite(parsed) ? parsed : fallback;
    return Math.max(min, Math.min(max, value));
}

// Defaults are intentionally baked into code, so the feature works even with no env.
const STREAM_RAW_CACHE_ENABLED = envBool('STREAM_RAW_CACHE_ENABLED', true);
const STREAM_RAW_CACHE_TTL_SECONDS = envInt('STREAM_RAW_CACHE_TTL_SECONDS', 900, 30, 24 * 3600);
const STREAM_RAW_CACHE_COMPRESS = envBool('STREAM_RAW_CACHE_COMPRESS', true);
const STREAM_RAW_CACHE_MAX_BYTES = envInt('STREAM_RAW_CACHE_MAX_BYTES', 500000, 8192, 10 * 1024 * 1024);
const STREAM_RAW_CACHE_MAX_KEYS = envInt('STREAM_RAW_CACHE_MAX_KEYS', 5000, 128, 100000);
const STREAM_RAW_CACHE_CHECKPERIOD = envInt('STREAM_RAW_CACHE_CHECKPERIOD', 60, 15, 3600);

const rawStreamCache = new NodeCache({
    stdTTL: STREAM_RAW_CACHE_TTL_SECONDS,
    checkperiod: STREAM_RAW_CACHE_CHECKPERIOD,
    maxKeys: STREAM_RAW_CACHE_MAX_KEYS,
    useClones: false,
    deleteOnExpire: true
});

function normalizeKey(key) {
    return String(key || '')
        .trim()
        .replace(/\s+/g, ' ')
        .slice(0, 512);
}

function storageKey(key) {
    return `raw_stream:${normalizeKey(key)}`;
}

function getAgeLabel(createdAt) {
    const ageMs = Math.max(0, Date.now() - Number(createdAt || 0));
    if (ageMs < 60000) return `${Math.floor(ageMs / 1000)}s`;
    if (ageMs < 3600000) return `${Math.floor(ageMs / 60000)}m`;
    return `${Math.floor(ageMs / 3600000)}h`;
}

async function encodePayload(value) {
    const normalized = Array.isArray(value) ? value : [];
    const json = JSON.stringify(normalized);
    const rawBuffer = Buffer.from(json, 'utf8');
    if (rawBuffer.length > STREAM_RAW_CACHE_MAX_BYTES) {
        return { skipped: true, reason: 'too_large', rawBytes: rawBuffer.length };
    }

    if (!STREAM_RAW_CACHE_COMPRESS) {
        return {
            skipped: false,
            entry: {
                encoding: 'identity',
                payload: rawBuffer.toString('base64'),
                rawBytes: rawBuffer.length,
                storedBytes: rawBuffer.length,
                count: normalized.length,
                createdAt: Date.now()
            }
        };
    }

    const compressed = await gzipAsync(rawBuffer, { level: 5 });
    if (!compressed || compressed.length > STREAM_RAW_CACHE_MAX_BYTES) {
        return { skipped: true, reason: 'too_large_compressed', rawBytes: rawBuffer.length, storedBytes: compressed ? compressed.length : 0 };
    }

    return {
        skipped: false,
        entry: {
            encoding: 'gzip',
            payload: compressed.toString('base64'),
            rawBytes: rawBuffer.length,
            storedBytes: compressed.length,
            count: normalized.length,
            createdAt: Date.now()
        }
    };
}

async function decodePayload(entry) {
    if (!entry || !entry.payload) return [];
    const buffer = Buffer.from(String(entry.payload || ''), 'base64');
    const encoding = String(entry.encoding || 'identity').toLowerCase();
    const decoded = encoding === 'gzip' ? await gunzipAsync(buffer) : buffer;
    const parsed = JSON.parse(Buffer.from(decoded).toString('utf8'));
    return Array.isArray(parsed) ? parsed : [];
}

async function get(key) {
    if (!STREAM_RAW_CACHE_ENABLED) return null;
    const normalizedKey = normalizeKey(key);
    if (!normalizedKey) return null;

    const entry = rawStreamCache.get(storageKey(normalizedKey));
    registerCacheAccess('rawStream', !!entry);
    if (!entry) {
        incrementMetric('rawStreamCache.miss');
        return null;
    }

    try {
        const value = await decodePayload(entry);
        incrementMetric('rawStreamCache.hit');
        logger.info(`[RAW CACHE] hit key=${normalizedKey} compressed=${entry.encoding !== 'identity'} age=${getAgeLabel(entry.createdAt)} results=${value.length}`);
        return value;
    } catch (error) {
        rawStreamCache.del(storageKey(normalizedKey));
        incrementMetric('rawStreamCache.decodeError');
        logger.warn(`[RAW CACHE] decode failed key=${normalizedKey} error=${error.message}`);
        return null;
    }
}

async function set(key, value, ttl = STREAM_RAW_CACHE_TTL_SECONDS) {
    if (!STREAM_RAW_CACHE_ENABLED) return false;
    const normalizedKey = normalizeKey(key);
    if (!normalizedKey || !Array.isArray(value)) return false;

    try {
        const encoded = await encodePayload(value);
        if (encoded.skipped) {
            incrementMetric(`rawStreamCache.skip.${encoded.reason}`);
            logger.info(`[RAW CACHE] skip reason=${encoded.reason} key=${normalizedKey} bytes=${encoded.rawBytes || 0} stored=${encoded.storedBytes || 0}`);
            return false;
        }

        const effectiveTtl = Math.max(30, Number(ttl || STREAM_RAW_CACHE_TTL_SECONDS) || STREAM_RAW_CACHE_TTL_SECONDS);
        rawStreamCache.set(storageKey(normalizedKey), encoded.entry, effectiveTtl);
        registerCacheSet('rawStream');
        incrementMetric('rawStreamCache.set');
        logger.info(`[RAW CACHE] set key=${normalizedKey} compressed=${encoded.entry.encoding !== 'identity'} raw=${encoded.entry.rawBytes} stored=${encoded.entry.storedBytes} ttl=${effectiveTtl}s results=${encoded.entry.count}`);
        return true;
    } catch (error) {
        incrementMetric('rawStreamCache.setError');
        logger.warn(`[RAW CACHE] set failed key=${normalizedKey} error=${error.message}`);
        return false;
    }
}

function del(key) {
    const normalizedKey = normalizeKey(key);
    if (!normalizedKey) return 0;
    return rawStreamCache.del(storageKey(normalizedKey));
}

function stats() {
    return {
        enabled: STREAM_RAW_CACHE_ENABLED,
        compress: STREAM_RAW_CACHE_COMPRESS,
        ttlSeconds: STREAM_RAW_CACHE_TTL_SECONDS,
        maxBytes: STREAM_RAW_CACHE_MAX_BYTES,
        keys: rawStreamCache.keys().length,
        maxKeys: STREAM_RAW_CACHE_MAX_KEYS
    };
}

module.exports = {
    STREAM_RAW_CACHE_ENABLED,
    STREAM_RAW_CACHE_TTL_SECONDS,
    STREAM_RAW_CACHE_COMPRESS,
    STREAM_RAW_CACHE_MAX_BYTES,
    get,
    set,
    del,
    stats
};
