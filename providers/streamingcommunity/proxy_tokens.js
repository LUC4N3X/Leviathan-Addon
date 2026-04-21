'use strict';

const crypto = require('crypto');

const HEADER_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const TOKEN_TTL_MS = 2 * 60 * 60 * 1000;
const HEADER_SWEEP_INTERVAL_MS = 60 * 1000;
const MAX_HEADER_CACHE_ENTRIES = 2048;
const MAX_HEADER_NAME_LENGTH = 128;
const MAX_HEADER_VALUE_LENGTH = 4096;
const MAX_URL_LENGTH = 8192;
const MAX_REFERER_LENGTH = 2048;
const DEFAULT_SECRET = 'leviathan-proxy-v2-local-secret';
const TOKEN_VERSION = 2;

const headerCache = new Map();
const stableIndex = new Map();
let headerCounter = 0;
let nextSweepAt = 0;

function now() {
    return Date.now();
}

function shouldSweep(ts = now()) {
    return ts >= nextSweepAt;
}

function scheduleSweep(ts = now()) {
    nextSweepAt = ts + HEADER_SWEEP_INTERVAL_MS;
}

function cleanup(ts = now()) {
    if (!shouldSweep(ts)) return;
    scheduleSweep(ts);
    for (const [id, entry] of headerCache.entries()) {
        if (!entry || Number(entry.expiresAt || 0) <= ts) {
            headerCache.delete(id);
            if (entry && entry.stableKey) {
                const indexedId = stableIndex.get(entry.stableKey);
                if (indexedId === id) stableIndex.delete(entry.stableKey);
            }
        }
    }
    if (headerCache.size <= MAX_HEADER_CACHE_ENTRIES) return;
    const victims = [...headerCache.entries()]
        .sort((a, b) => Number(a[1]?.expiresAt || 0) - Number(b[1]?.expiresAt || 0))
        .slice(0, Math.max(0, headerCache.size - MAX_HEADER_CACHE_ENTRIES));
    for (const [id, entry] of victims) {
        headerCache.delete(id);
        if (entry && entry.stableKey) {
            const indexedId = stableIndex.get(entry.stableKey);
            if (indexedId === id) stableIndex.delete(entry.stableKey);
        }
    }
}

function base64urlEncodeUtf8(value) {
    return Buffer.from(String(value || ''), 'utf8').toString('base64url');
}

function base64urlDecodeUtf8(value) {
    return Buffer.from(String(value || ''), 'base64url').toString('utf8');
}

function getSecret() {
    return String(
        process.env.PROXY_TOKEN_SECRET
        || process.env.ADDON_SECRET
        || process.env.JWT_SECRET
        || DEFAULT_SECRET
    );
}

function sign(data) {
    return crypto
        .createHmac('sha256', getSecret())
        .update(String(data || ''))
        .digest('base64url');
}

function safeString(value, maxLength) {
    const text = String(value == null ? '' : value).trim();
    if (!text) return '';
    return text.slice(0, maxLength);
}

function normalizeUrl(value) {
    const raw = safeString(value, MAX_URL_LENGTH);
    if (!raw) return '';
    try {
        const parsed = new URL(raw);
        if (!/^https?:$/i.test(parsed.protocol)) return '';
        return parsed.toString();
    } catch {
        return '';
    }
}

function normalizeReferer(value) {
    const raw = safeString(value, MAX_REFERER_LENGTH);
    if (!raw) return null;
    try {
        const parsed = new URL(raw);
        if (!/^https?:$/i.test(parsed.protocol)) return null;
        return parsed.toString();
    } catch {
        return null;
    }
}

function normalizeHeaders(headers = {}) {
    const out = {};
    for (const [key, value] of Object.entries(headers || {})) {
        if (value == null) continue;
        const normalizedKey = safeString(key, MAX_HEADER_NAME_LENGTH);
        if (!normalizedKey) continue;
        const normalizedValue = safeString(value, MAX_HEADER_VALUE_LENGTH);
        if (!normalizedValue) continue;
        out[normalizedKey] = normalizedValue;
    }
    return out;
}

function stableHeaderKey(headers = {}) {
    const normalized = normalizeHeaders(headers);
    const sorted = Object.keys(normalized)
        .sort((a, b) => a.localeCompare(b))
        .reduce((acc, key) => {
            acc[key] = normalized[key];
            return acc;
        }, {});
    return JSON.stringify(sorted);
}

function nextHeaderId() {
    headerCounter += 1;
    return headerCounter.toString(36);
}

function registerHeaders(headers = {}, ttlMs = HEADER_CACHE_TTL_MS) {
    const ts = now();
    cleanup(ts);
    const normalized = normalizeHeaders(headers);
    const stableKey = stableHeaderKey(normalized);
    if (stableKey === '{}') return null;

    const existingId = stableIndex.get(stableKey);
    if (existingId) {
        const existing = headerCache.get(existingId);
        if (existing && Number(existing.expiresAt || 0) > ts) {
            existing.expiresAt = ts + Math.max(1000, Number(ttlMs || HEADER_CACHE_TTL_MS));
            return existingId;
        }
        stableIndex.delete(stableKey);
        headerCache.delete(existingId);
    }

    const id = nextHeaderId();
    headerCache.set(id, {
        stableKey,
        headers: normalized,
        expiresAt: ts + Math.max(1000, Number(ttlMs || HEADER_CACHE_TTL_MS))
    });
    stableIndex.set(stableKey, id);
    return id;
}

function lookupHeaders(id) {
    if (!id) return null;
    const entry = headerCache.get(String(id));
    if (!entry) return null;
    if (Number(entry.expiresAt || 0) <= now()) {
        headerCache.delete(String(id));
        if (entry.stableKey) {
            const indexedId = stableIndex.get(entry.stableKey);
            if (indexedId === String(id)) stableIndex.delete(entry.stableKey);
        }
        return null;
    }
    return { ...entry.headers };
}

function buildPayload(targetUrl, options = {}) {
    const url = normalizeUrl(targetUrl);
    if (!url) return null;

    const referer = normalizeReferer(options.referer || '');
    const headers = normalizeHeaders(options.headers || {});
    const headerId = registerHeaders(headers, options.ttlMs || HEADER_CACHE_TTL_MS);
    const expiresAt = now() + Math.max(1000, Number(options.tokenTtlMs || TOKEN_TTL_MS));

    return {
        v: TOKEN_VERSION,
        u: url,
        r: referer,
        h: headerId,
        e: expiresAt,
        n: crypto.randomBytes(6).toString('base64url')
    };
}

function encodeSignedPayload(payload) {
    const body = base64urlEncodeUtf8(JSON.stringify(payload));
    const signature = sign(body);
    return `${body}.${signature}`;
}

function encodeLegacyPayload(payload) {
    return base64urlEncodeUtf8(JSON.stringify({
        u: payload.u,
        r: payload.r,
        h: payload.h,
        e: payload.e,
        n: payload.n
    }));
}

function makeProxyToken(targetUrl, options = {}) {
    const payload = buildPayload(targetUrl, options);
    if (!payload) return null;
    if (options.legacy === true) return encodeLegacyPayload(payload);
    return encodeSignedPayload(payload);
}

function decodeSignedToken(token) {
    const [body, signature] = String(token || '').split('.');
    if (!body || !signature) return null;
    if (sign(body) !== signature) return null;
    const parsed = JSON.parse(base64urlDecodeUtf8(body));
    return parsed && typeof parsed === 'object' ? parsed : null;
}

function decodeLegacyToken(token) {
    const parsed = JSON.parse(base64urlDecodeUtf8(token));
    return parsed && typeof parsed === 'object' ? parsed : null;
}

function normalizeDecodedPayload(parsed) {
    if (!parsed || typeof parsed !== 'object') return null;
    const expiresAt = Number(parsed.e || 0) || 0;
    if (expiresAt > 0 && expiresAt < now()) return null;

    const url = normalizeUrl(parsed.u || '');
    if (!url) return null;

    const referer = parsed.r ? normalizeReferer(parsed.r) : null;
    const headerId = parsed.h ? String(parsed.h) : null;

    return {
        url,
        referer,
        headers: lookupHeaders(headerId) || null,
        headerId,
        expiresAt,
        version: Number(parsed.v || 1) || 1
    };
}

function decodeProxyToken(token) {
    if (!token) return null;
    try {
        const parsed = String(token).includes('.')
            ? decodeSignedToken(token)
            : decodeLegacyToken(token);
        return normalizeDecodedPayload(parsed);
    } catch {
        return null;
    }
}

module.exports = {
    HEADER_CACHE_TTL_MS,
    TOKEN_TTL_MS,
    decodeProxyToken,
    lookupHeaders,
    makeProxyToken,
    normalizeHeaders,
    registerHeaders,
    stableHeaderKey
};
