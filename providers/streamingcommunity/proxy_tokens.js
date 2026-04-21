'use strict';

const crypto = require('crypto');

const HEADER_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const TOKEN_TTL_MS = 2 * 60 * 60 * 1000;
const headerCache = new Map();
let headerCounter = 0;

function now() {
    return Date.now();
}

function cleanup() {
    const ts = now();
    for (const [key, entry] of headerCache.entries()) {
        if (!entry || Number(entry.expiresAt || 0) <= ts) {
            headerCache.delete(key);
        }
    }
}

function normalizeHeaders(headers = {}) {
    const out = {};
    for (const [key, value] of Object.entries(headers || {})) {
        if (value == null) continue;
        const normalizedKey = String(key || '').trim();
        const normalizedValue = String(value || '').trim();
        if (!normalizedKey || !normalizedValue) continue;
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

function registerHeaders(headers = {}, ttlMs = HEADER_CACHE_TTL_MS) {
    cleanup();
    const normalized = normalizeHeaders(headers);
    const stableKey = stableHeaderKey(normalized);
    if (stableKey === '{}') return null;

    for (const [id, entry] of headerCache.entries()) {
        if (entry && entry.stableKey === stableKey && Number(entry.expiresAt || 0) > now()) {
            entry.expiresAt = now() + ttlMs;
            return id;
        }
    }

    headerCounter += 1;
    const id = headerCounter.toString(36);
    headerCache.set(id, {
        stableKey,
        headers: normalized,
        expiresAt: now() + ttlMs
    });
    return id;
}

function lookupHeaders(id) {
    if (!id) return null;
    const entry = headerCache.get(String(id));
    if (!entry) return null;
    if (Number(entry.expiresAt || 0) <= now()) {
        headerCache.delete(String(id));
        return null;
    }
    return { ...entry.headers };
}

function makeProxyToken(targetUrl, options = {}) {
    const url = String(targetUrl || '').trim();
    if (!url) return null;

    const referer = String(options.referer || '').trim() || null;
    const headers = normalizeHeaders(options.headers || {});
    const headerId = registerHeaders(headers, options.ttlMs || HEADER_CACHE_TTL_MS);
    const payload = {
        u: url,
        r: referer,
        h: headerId,
        e: now() + (options.tokenTtlMs || TOKEN_TTL_MS),
        n: crypto.randomBytes(3).toString('base64url')
    };
    return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

function decodeProxyToken(token) {
    if (!token) return null;
    try {
        const json = Buffer.from(String(token), 'base64url').toString('utf8');
        const parsed = JSON.parse(json);
        if (!parsed || typeof parsed !== 'object') return null;
        if (Number(parsed.e || 0) > 0 && Number(parsed.e) < now()) return null;
        const url = String(parsed.u || '').trim();
        if (!url) return null;
        return {
            url,
            referer: parsed.r ? String(parsed.r) : null,
            headers: lookupHeaders(parsed.h) || null,
            headerId: parsed.h ? String(parsed.h) : null,
            expiresAt: Number(parsed.e || 0) || 0
        };
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
    registerHeaders
};
