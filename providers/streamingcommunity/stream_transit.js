"use strict";

const crypto = require('crypto');

const MODULE_VERSION = 4;
const TRANSIT_KIND = 'vix-transit';
const SWEEP_INTERVAL_MS = 45 * 1000;
const REQUEST_CONTEXT_TTL_MS = 6 * 60 * 60 * 1000;
const TOKEN_TTL_MS = 2 * 60 * 60 * 1000;
const DEFAULT_MAX_USES = 0;
const MAX_URL_LENGTH = 8192;
const MAX_REFERER_LENGTH = 2048;
const MAX_HEADER_VALUE_LENGTH = 4096;
const MAX_HEADER_COUNT = 64;
const SECRET = String(process.env.PROXY_TOKEN_SECRET || 'dev-only-local-secret-change-me').trim();

const requestContextById = new Map();
const requestKeyToId = new Map();
let lastSweepAt = 0;

function now() {
    return Date.now();
}

function safeClone(value) {
    return value == null ? value : JSON.parse(JSON.stringify(value));
}

function createContextId(prefix = 'ctx') {
    return `${prefix}_${crypto.randomBytes(9).toString('base64url')}`;
}

function sha256(input) {
    return crypto.createHash('sha256').update(String(input || ''), 'utf8').digest('hex');
}

function signEnvelope(body) {
    return crypto.createHmac('sha256', SECRET).update(String(body || ''), 'utf8').digest('base64url');
}

function safeEquals(left, right) {
    const a = Buffer.from(String(left || ''), 'utf8');
    const b = Buffer.from(String(right || ''), 'utf8');
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
}

function maybeSweep(force = false) {
    const ts = now();
    if (!force && ts - lastSweepAt < SWEEP_INTERVAL_MS) return;
    lastSweepAt = ts;

    for (const [id, entry] of requestContextById.entries()) {
        if (!entry || Number(entry.expiresAt || 0) <= ts) {
            requestContextById.delete(id);
            if (entry?.stableKeyHash) requestKeyToId.delete(entry.stableKeyHash);
        }
    }
}

function normalizeRemoteUrl(value, maxLength = MAX_URL_LENGTH) {
    const raw = String(value || '').trim();
    if (!raw || raw.length > maxLength) return null;
    try {
        const parsed = new URL(raw);
        if (!/^https?:$/i.test(parsed.protocol)) return null;
        return parsed.toString();
    } catch {
        return null;
    }
}

function normalizeReferer(value) {
    const raw = String(value || '').trim();
    if (!raw) return null;
    if (raw.length > MAX_REFERER_LENGTH) return null;
    return normalizeRemoteUrl(raw, MAX_REFERER_LENGTH);
}

function normalizeBinding(value) {
    const raw = String(value || '').trim();
    return raw || null;
}

function normalizeTransitKind(value) {
    const raw = String(value || '').trim();
    return raw || TRANSIT_KIND;
}

function normalizeRequestHeaders(headers = {}) {
    const out = {};
    for (const [rawKey, rawValue] of Object.entries(headers || {})) {
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

function stableHeaders(headers = {}) {
    const normalized = normalizeRequestHeaders(headers);
    return Object.keys(normalized)
        .sort((a, b) => a.localeCompare(b))
        .reduce((acc, key) => {
            acc[key] = normalized[key];
            return acc;
        }, {});
}

function buildStableRequestKey(targetUrl, options = {}) {
    return JSON.stringify({
        kind: normalizeTransitKind(options.kind),
        targetUrl: normalizeRemoteUrl(targetUrl),
        referer: normalizeReferer(options.referer),
        headers: stableHeaders(options.headers || {}),
        hostBinding: normalizeBinding(options.hostBinding),
        routeBinding: normalizeBinding(options.routeBinding),
        issuer: normalizeBinding(options.issuer),
        profile: normalizeBinding(options.profile),
        allowInsecureTls: Boolean(options.allowInsecureTls),
        forceHeaders: Boolean(options.forceHeaders)
    });
}

function packToken(payload) {
    const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
    const signature = signEnvelope(`${MODULE_VERSION}.${body}`);
    return `lvt.${MODULE_VERSION}.${body}.${signature}`;
}

function unpackToken(token) {
    const raw = String(token || '').trim();
    const match = raw.match(/^lvt\.(\d+)\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/);
    if (!match) return null;

    const version = Number(match[1] || 0);
    const body = match[2];
    const signature = match[3];
    const expected = signEnvelope(`${version}.${body}`);
    if (!safeEquals(signature, expected)) return null;

    try {
        const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
        if (!payload || typeof payload !== 'object') return null;
        return { version, payload };
    } catch {
        return null;
    }
}

function touchEntry(entry, ttlMs = null) {
    if (!entry) return null;
    entry.touchedAt = now();
    if (ttlMs && Number(ttlMs) > 0) entry.expiresAt = now() + Number(ttlMs);
    return entry;
}

function stashTransitContext(targetUrl, options = {}) {
    maybeSweep();

    const normalizedTargetUrl = normalizeRemoteUrl(targetUrl);
    if (!normalizedTargetUrl) return null;

    const normalizedReferer = normalizeReferer(options.referer);
    const normalizedHeaders = normalizeRequestHeaders(options.headers || {});
    const contextTtlMs = Math.max(1000, Number(options.ttlMs) || REQUEST_CONTEXT_TTL_MS);
    const tokenTtlMs = Math.max(1000, Number(options.tokenTtlMs) || TOKEN_TTL_MS);
    const stableKeyHash = sha256(buildStableRequestKey(normalizedTargetUrl, {
        ...options,
        referer: normalizedReferer,
        headers: normalizedHeaders
    }));

    const existingId = requestKeyToId.get(stableKeyHash);
    if (existingId) {
        const existing = requestContextById.get(existingId);
        if (existing && Number(existing.expiresAt || 0) > now()) {
            existing.targetUrl = normalizedTargetUrl;
            existing.referer = normalizedReferer;
            existing.headers = normalizedHeaders;
            existing.tokenExpiresAt = now() + tokenTtlMs;
            existing.maxUses = Math.max(0, Number(options.maxUses) || existing.maxUses || DEFAULT_MAX_USES);
            touchEntry(existing, contextTtlMs);
            return existing;
        }
    }

    const entry = {
        id: createContextId('req'),
        stableKeyHash,
        kind: normalizeTransitKind(options.kind),
        targetUrl: normalizedTargetUrl,
        referer: normalizedReferer,
        headers: normalizedHeaders,
        hostBinding: normalizeBinding(options.hostBinding),
        routeBinding: normalizeBinding(options.routeBinding),
        issuer: normalizeBinding(options.issuer),
        profile: normalizeBinding(options.profile),
        allowInsecureTls: Boolean(options.allowInsecureTls),
        forceHeaders: Boolean(options.forceHeaders),
        meta: safeClone(options.meta || null),
        createdAt: now(),
        touchedAt: now(),
        expiresAt: now() + contextTtlMs,
        tokenExpiresAt: now() + tokenTtlMs,
        maxUses: Math.max(0, Number(options.maxUses) || DEFAULT_MAX_USES),
        hits: 0
    };

    requestContextById.set(entry.id, entry);
    requestKeyToId.set(stableKeyHash, entry.id);
    return entry;
}

function issueTransitKey(targetUrl, options = {}) {
    const entry = stashTransitContext(targetUrl, options);
    if (!entry) return null;

    return packToken({
        v: MODULE_VERSION,
        typ: 'transit',
        kind: entry.kind,
        cid: entry.id,
        exp: entry.tokenExpiresAt,
        nonce: crypto.randomBytes(5).toString('base64url')
    });
}

function materializeContext(entry, options = {}) {
    if (!entry) return null;
    const ts = now();
    if (Number(entry.expiresAt || 0) <= ts) return null;
    if (Number(entry.tokenExpiresAt || 0) <= ts) return null;

    const expectedKind = normalizeTransitKind(options.kind || entry.kind);
    const expectedHostBinding = normalizeBinding(options.hostBinding);
    const expectedRouteBinding = normalizeBinding(options.routeBinding);

    if (entry.kind && expectedKind && entry.kind !== expectedKind) return null;
    if (entry.hostBinding && expectedHostBinding && entry.hostBinding !== expectedHostBinding) return null;
    if (entry.routeBinding && expectedRouteBinding && entry.routeBinding !== expectedRouteBinding) return null;

    entry.hits += 1;
    touchEntry(entry);
    if (entry.maxUses > 0 && entry.hits > entry.maxUses) return null;

    return {
        url: entry.targetUrl,
        referer: entry.referer,
        headers: safeClone(entry.headers) || null,
        contextId: entry.id,
        expiresAt: entry.tokenExpiresAt,
        kind: entry.kind,
        issuer: entry.issuer,
        profile: entry.profile,
        allowInsecureTls: entry.allowInsecureTls,
        forceHeaders: entry.forceHeaders,
        hits: entry.hits,
        maxUses: entry.maxUses,
        meta: safeClone(entry.meta || null)
    };
}

function resolveTransitKey(token, options = {}) {
    maybeSweep();
    const unpacked = unpackToken(token);
    if (!unpacked?.payload?.cid) return null;

    const entry = requestContextById.get(String(unpacked.payload.cid));
    return materializeContext(entry, options);
}

function revokeTransitKey(tokenOrContextId) {
    const raw = String(tokenOrContextId || '').trim();
    if (!raw) return false;

    const unpacked = unpackToken(raw);
    const contextId = unpacked?.payload?.cid || raw;
    const entry = requestContextById.get(contextId);
    if (!entry) return false;

    requestContextById.delete(contextId);
    if (entry.stableKeyHash) requestKeyToId.delete(entry.stableKeyHash);
    return true;
}

function warmTransitContext(targetUrl, options = {}) {
    return stashTransitContext(targetUrl, options);
}

function getTransitStats() {
    maybeSweep();
    return {
        version: MODULE_VERSION,
        kind: TRANSIT_KIND,
        liveContexts: requestContextById.size,
        sweepIntervalMs: SWEEP_INTERVAL_MS
    };
}

module.exports = {
    MODULE_VERSION,
    TRANSIT_KIND,
    REQUEST_CONTEXT_TTL_MS,
    TOKEN_TTL_MS,
    normalizeRequestHeaders,
    issueTransitKey,
    resolveTransitKey,
    revokeTransitKey,
    warmTransitContext,
    getTransitStats
};
