'use strict';

const crypto = require('crypto');

const MODULE_VERSION = 3;
const SWEEP_INTERVAL_MS = 45 * 1000;
const HEADER_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const TOKEN_TTL_MS = 2 * 60 * 60 * 1000;
const DEFAULT_MAX_USES = 0;
const MAX_URL_LENGTH = 8192;
const MAX_REFERER_LENGTH = 2048;
const MAX_HEADER_VALUE_LENGTH = 4096;
const MAX_HEADER_COUNT = 64;
const DEFAULT_SECRET = process.env.PROXY_TOKEN_SECRET || 'dev-only-local-secret-change-me';

const contextById = new Map();
const requestHashToId = new Map();
const headerHashToId = new Map();
const headerContextById = new Map();
let lastSweepAt = 0;

function now() {
    return Date.now();
}

function clone(value) {
    return value ? JSON.parse(JSON.stringify(value)) : value;
}

function maybeSweep(force = false) {
    const ts = now();
    if (!force && ts - lastSweepAt < SWEEP_INTERVAL_MS) return;
    lastSweepAt = ts;

    for (const [id, entry] of contextById.entries()) {
        if (!entry || Number(entry.expiresAt || 0) <= ts) {
            contextById.delete(id);
            if (entry?.stableHash) requestHashToId.delete(entry.stableHash);
        }
    }

    for (const [id, entry] of headerContextById.entries()) {
        if (!entry || Number(entry.expiresAt || 0) <= ts) {
            headerContextById.delete(id);
            if (entry?.stableHash) headerHashToId.delete(entry.stableHash);
        }
    }
}

function createId(prefix = 'ctx') {
    return `${prefix}_${crypto.randomBytes(9).toString('base64url')}`;
}

function sha256(input) {
    return crypto.createHash('sha256').update(String(input || ''), 'utf8').digest('hex');
}

function hmac(input) {
    return crypto.createHmac('sha256', DEFAULT_SECRET).update(String(input || ''), 'utf8').digest('base64url');
}

function safeEquals(a, b) {
    const left = Buffer.from(String(a || ''), 'utf8');
    const right = Buffer.from(String(b || ''), 'utf8');
    if (left.length !== right.length) return false;
    return crypto.timingSafeEqual(left, right);
}

function normalizeUrl(url) {
    const value = String(url || '').trim();
    if (!value || value.length > MAX_URL_LENGTH) return null;
    try {
        const parsed = new URL(value);
        if (!/^https?:$/i.test(parsed.protocol)) return null;
        return parsed.toString();
    } catch {
        return null;
    }
}

function normalizeReferer(referer) {
    const value = String(referer || '').trim();
    if (!value) return null;
    if (value.length > MAX_REFERER_LENGTH) return null;
    return normalizeUrl(value);
}

function normalizeHeaders(headers = {}) {
    const out = {};
    const entries = Object.entries(headers || {});
    for (const [rawKey, rawValue] of entries) {
        if (rawValue == null) continue;
        const key = String(rawKey || '').trim().toLowerCase();
        const value = String(rawValue || '').trim();
        if (!key || !value) continue;
        if (value.length > MAX_HEADER_VALUE_LENGTH) continue;
        out[key] = value;
        if (Object.keys(out).length >= MAX_HEADER_COUNT) break;
    }
    return out;
}

function stableHeaderKey(headers = {}) {
    const normalized = normalizeHeaders(headers);
    const ordered = Object.keys(normalized)
        .sort((a, b) => a.localeCompare(b))
        .reduce((acc, key) => {
            acc[key] = normalized[key];
            return acc;
        }, {});
    return JSON.stringify(ordered);
}

function stableRequestKey(targetUrl, options = {}) {
    return JSON.stringify({
        kind: String(options.kind || 'proxy').trim() || 'proxy',
        target: normalizeUrl(targetUrl),
        referer: normalizeReferer(options.referer),
        headers: JSON.parse(stableHeaderKey(options.headers || {})),
        allowInsecureTls: Boolean(options.allowInsecureTls),
        forceHeaders: Boolean(options.forceHeaders),
        hostBinding: String(options.hostBinding || '').trim() || null,
        routeBinding: String(options.routeBinding || '').trim() || null,
        profile: String(options.profile || '').trim() || null,
        issuer: String(options.issuer || '').trim() || null
    });
}

function packEnvelope(payload) {
    const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
    const signature = hmac(`${MODULE_VERSION}.${body}`);
    return `lt.${MODULE_VERSION}.${body}.${signature}`;
}

function unpackEnvelope(token) {
    const raw = String(token || '').trim();
    const match = raw.match(/^lt\.(\d+)\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/);
    if (!match) return null;

    const version = Number(match[1] || 0);
    const body = match[2];
    const signature = match[3];
    const expected = hmac(`${version}.${body}`);
    if (!safeEquals(signature, expected)) return null;

    try {
        const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
        if (!payload || typeof payload !== 'object') return null;
        return { version, payload };
    } catch {
        return null;
    }
}

function touchEntry(entry, ttlMs) {
    if (!entry) return null;
    entry.touchedAt = now();
    if (ttlMs && Number(ttlMs) > 0) entry.expiresAt = now() + Number(ttlMs);
    return entry;
}

function stashHeaderContext(headers = {}, ttlMs = HEADER_CACHE_TTL_MS) {
    maybeSweep();
    const normalized = normalizeHeaders(headers);
    const stableKey = stableHeaderKey(normalized);
    if (stableKey === '{}') return null;

    const hash = sha256(`hdr:${stableKey}`);
    const existingId = headerHashToId.get(hash);
    if (existingId) {
        const existing = headerContextById.get(existingId);
        if (existing && Number(existing.expiresAt || 0) > now()) {
            touchEntry(existing, ttlMs);
            return existingId;
        }
    }

    const id = createId('hdr');
    headerContextById.set(id, {
        id,
        stableHash: hash,
        headers: normalized,
        createdAt: now(),
        touchedAt: now(),
        expiresAt: now() + Math.max(1000, Number(ttlMs) || HEADER_CACHE_TTL_MS)
    });
    headerHashToId.set(hash, id);
    return id;
}

function readHeaderContext(id) {
    maybeSweep();
    const entry = headerContextById.get(String(id || ''));
    if (!entry) return null;
    if (Number(entry.expiresAt || 0) <= now()) {
        headerContextById.delete(String(id || ''));
        if (entry.stableHash) headerHashToId.delete(entry.stableHash);
        return null;
    }
    touchEntry(entry);
    return { ...entry.headers };
}

function stashRequestContext(targetUrl, options = {}) {
    maybeSweep();

    const normalizedTarget = normalizeUrl(targetUrl);
    if (!normalizedTarget) return null;

    const normalizedHeaders = normalizeHeaders(options.headers || {});
    const normalizedReferer = normalizeReferer(options.referer);
    const ttlMs = Math.max(1000, Number(options.ttlMs) || HEADER_CACHE_TTL_MS);
    const tokenTtlMs = Math.max(1000, Number(options.tokenTtlMs) || TOKEN_TTL_MS);
    const stableHash = sha256(stableRequestKey(normalizedTarget, {
        ...options,
        referer: normalizedReferer,
        headers: normalizedHeaders
    }));

    const existingId = requestHashToId.get(stableHash);
    if (existingId) {
        const existing = contextById.get(existingId);
        if (existing && Number(existing.expiresAt || 0) > now()) {
            existing.targetUrl = normalizedTarget;
            existing.referer = normalizedReferer;
            existing.headers = normalizedHeaders;
            existing.tokenExpiresAt = now() + tokenTtlMs;
            touchEntry(existing, ttlMs);
            return existing;
        }
    }

    const entry = {
        id: createId('req'),
        stableHash,
        kind: String(options.kind || 'proxy').trim() || 'proxy',
        targetUrl: normalizedTarget,
        referer: normalizedReferer,
        headers: normalizedHeaders,
        createdAt: now(),
        touchedAt: now(),
        expiresAt: now() + ttlMs,
        tokenExpiresAt: now() + tokenTtlMs,
        maxUses: Math.max(0, Number(options.maxUses) || DEFAULT_MAX_USES),
        hits: 0,
        allowInsecureTls: Boolean(options.allowInsecureTls),
        forceHeaders: Boolean(options.forceHeaders),
        hostBinding: String(options.hostBinding || '').trim() || null,
        routeBinding: String(options.routeBinding || '').trim() || null,
        issuer: String(options.issuer || '').trim() || null,
        profile: String(options.profile || '').trim() || null,
        meta: clone(options.meta || null)
    };

    contextById.set(entry.id, entry);
    requestHashToId.set(stableHash, entry.id);
    return entry;
}

function issueTransitKey(targetUrl, options = {}) {
    const entry = stashRequestContext(targetUrl, options);
    if (!entry) return null;

    return packEnvelope({
        v: MODULE_VERSION,
        type: 'transit',
        rid: entry.id,
        exp: entry.tokenExpiresAt,
        nonce: crypto.randomBytes(5).toString('base64url')
    });
}

function consumeRequestContext(entry, options = {}) {
    if (!entry) return null;
    if (Number(entry.expiresAt || 0) <= now()) return null;
    if (Number(entry.tokenExpiresAt || 0) <= now()) return null;

    const expectedHost = String(options.hostBinding || '').trim() || null;
    if (entry.hostBinding && expectedHost && entry.hostBinding !== expectedHost) return null;

    const expectedRoute = String(options.routeBinding || '').trim() || null;
    if (entry.routeBinding && expectedRoute && entry.routeBinding !== expectedRoute) return null;

    const expectedKind = String(options.kind || '').trim() || null;
    if (expectedKind && entry.kind && entry.kind !== expectedKind) return null;

    entry.hits += 1;
    touchEntry(entry);
    if (entry.maxUses > 0 && entry.hits > entry.maxUses) return null;

    return {
        url: entry.targetUrl,
        referer: entry.referer,
        headers: clone(entry.headers) || null,
        contextId: entry.id,
        expiresAt: entry.tokenExpiresAt,
        kind: entry.kind,
        issuer: entry.issuer,
        profile: entry.profile,
        allowInsecureTls: entry.allowInsecureTls,
        forceHeaders: entry.forceHeaders,
        hits: entry.hits,
        maxUses: entry.maxUses,
        meta: clone(entry.meta || null)
    };
}

function resolveTransitKey(token, options = {}) {
    maybeSweep();
    const envelope = unpackEnvelope(token);
    if (envelope?.payload?.rid) {
        const entry = contextById.get(String(envelope.payload.rid));
        return consumeRequestContext(entry, options);
    }
    return null;
}

function revokeTransitKey(tokenOrId) {
    const raw = String(tokenOrId || '').trim();
    if (!raw) return false;

    const envelope = unpackEnvelope(raw);
    const id = envelope?.payload?.rid || raw;
    const entry = contextById.get(id);
    if (!entry) return false;

    contextById.delete(id);
    if (entry.stableHash) requestHashToId.delete(entry.stableHash);
    return true;
}

function warmTransitContext(targetUrl, options = {}) {
    return stashRequestContext(targetUrl, options);
}

function getTransitStats() {
    maybeSweep();
    return {
        version: MODULE_VERSION,
        liveRequestContexts: contextById.size,
        liveHeaderContexts: headerContextById.size,
        sweepIntervalMs: SWEEP_INTERVAL_MS
    };
}

function registerHeaders(headers = {}, ttlMs = HEADER_CACHE_TTL_MS) {
    return stashHeaderContext(headers, ttlMs);
}

function lookupHeaders(id) {
    return readHeaderContext(id);
}

function makeProxyToken(targetUrl, options = {}) {
    return issueTransitKey(targetUrl, options);
}

function decodeLegacyToken(token) {
    try {
        const json = Buffer.from(String(token || ''), 'base64url').toString('utf8');
        const parsed = JSON.parse(json);
        if (!parsed || typeof parsed !== 'object') return null;
        if (Number(parsed.e || 0) > 0 && Number(parsed.e) < now()) return null;
        const url = normalizeUrl(parsed.u);
        if (!url) return null;
        return {
            url,
            referer: normalizeReferer(parsed.r),
            headers: readHeaderContext(parsed.h) || null,
            contextId: parsed.h ? String(parsed.h) : null,
            expiresAt: Number(parsed.e || 0) || 0,
            kind: 'legacy'
        };
    } catch {
        return null;
    }
}

function decodeProxyToken(token, options = {}) {
    return resolveTransitKey(token, options) || decodeLegacyToken(token);
}

module.exports = {
    HEADER_CACHE_TTL_MS,
    TOKEN_TTL_MS,
    MODULE_VERSION,
    normalizeHeaders,
    registerHeaders,
    lookupHeaders,
    makeProxyToken,
    decodeProxyToken,
    issueTransitKey,
    resolveTransitKey,
    revokeTransitKey,
    warmTransitContext,
    getTransitStats
};
