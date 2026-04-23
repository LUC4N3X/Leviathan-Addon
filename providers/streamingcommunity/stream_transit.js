"use strict";

const crypto = require('crypto');

const MODULE_VERSION = 7;
const TRANSIT_KIND = 'vix-transit';
const SWEEP_INTERVAL_MS = 45 * 1000;
const REQUEST_CONTEXT_TTL_MS = 6 * 60 * 60 * 1000;
const TOKEN_TTL_MS = 10 * 60 * 1000;
const HLS_TOKEN_TTL_MS = 10 * 60 * 1000;
const SECRET_ROTATION_INTERVAL_MS = 20 * 60 * 1000;
const SECRET_RETENTION_MS = TOKEN_TTL_MS + SECRET_ROTATION_INTERVAL_MS + 60 * 1000;
const DEFAULT_MAX_USES = 0;
const DEFAULT_TOKEN_MAX_USES = 0;
const HLS_TOKEN_MAX_USES = 0;
const MAX_URL_LENGTH = 8192;
const MAX_REFERER_LENGTH = 2048;
const MAX_HEADER_VALUE_LENGTH = 4096;
const MAX_HEADER_COUNT = 64;
const MAX_LIVE_CONTEXTS = 50000;

const BLOCKED_REQUEST_HEADERS = new Set([
    'host',
    'connection',
    'content-length',
    'transfer-encoding',
    'keep-alive',
    'proxy-authenticate',
    'proxy-authorization',
    'te',
    'trailer',
    'upgrade',
    'forwarded',
    'x-forwarded-for',
    'x-forwarded-host',
    'x-forwarded-proto'
]);

const requestContextById = new Map();
const requestKeyToId = new Map();
const tokenStateByJti = new Map();
const activeSecrets = [];
let lastSweepAt = 0;
let lastSecretRotationAt = 0;

bootstrapSecrets();

function now() {
    return Date.now();
}

function toNonNegativeInt(value, fallback) {
    if (value == null || value === '') return fallback;
    const n = Number(value);
    if (!Number.isFinite(n)) return fallback;
    return Math.max(0, Math.floor(n));
}

function safeClone(value) {
    return value == null ? value : JSON.parse(JSON.stringify(value));
}

function createRandomId(prefix = 'id', byteLength = 9) {
    return `${prefix}_${crypto.randomBytes(byteLength).toString('base64url')}`;
}

function sha256(input) {
    return crypto.createHash('sha256').update(String(input || ''), 'utf8').digest('hex');
}

function stableJson(value) {
    if (value == null) return 'null';
    if (typeof value !== 'object') return JSON.stringify(value);
    if (Array.isArray(value)) return `[${value.map((item) => stableJson(item)).join(',')}]`;
    const keys = Object.keys(value).sort((a, b) => a.localeCompare(b));
    return `{${keys.map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
}

function normalizeHostBinding(value) {
    const raw = String(value || '').trim();
    if (!raw) return null;
    try {
        if (/^https?:\/\//i.test(raw)) return new URL(raw).origin;
    } catch {}
    return raw.replace(/\/+$/, '') || null;
}

function normalizeRouteBinding(value) {
    const raw = String(value || '').trim();
    if (!raw) return null;
    if (raw.startsWith('/')) return raw;
    try {
        if (/^https?:\/\//i.test(raw)) return new URL(raw).pathname || '/';
    } catch {}
    return `/${raw.replace(/^\/+/, '')}`;
}

function normalizeBinding(value, kind = 'generic') {
    if (kind === 'host') return normalizeHostBinding(value);
    if (kind === 'route') return normalizeRouteBinding(value);
    const raw = String(value || '').trim();
    return raw || null;
}

function normalizeTransitKind(value) {
    const raw = String(value || '').trim();
    return raw || TRANSIT_KIND;
}

function normalizeRemoteUrl(value, maxLength = MAX_URL_LENGTH) {
    const raw = String(value || '').trim();
    if (!raw || raw.length > maxLength) return null;
    try {
        const parsed = new URL(raw);
        if (!/^https?:$/i.test(parsed.protocol)) return null;
        if (parsed.username || parsed.password) return null;
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

function normalizeRequestHeaders(headers = {}) {
    const out = {};
    let count = 0;
    for (const [rawKey, rawValue] of Object.entries(headers || {})) {
        if (rawValue == null) continue;
        const key = String(rawKey || '').trim().toLowerCase();
        const value = String(rawValue || '').trim();
        if (!key || !value) continue;
        if (BLOCKED_REQUEST_HEADERS.has(key)) continue;
        if (value.length > MAX_HEADER_VALUE_LENGTH) continue;
        out[key] = value;
        count += 1;
        if (count >= MAX_HEADER_COUNT) break;
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

function createSecretRecord() {
    const ts = now();
    return {
        kid: createRandomId('kid', 6),
        value: crypto.randomBytes(32).toString('hex'),
        introducedAt: ts,
        expiresAt: ts + SECRET_RETENTION_MS
    };
}

function bootstrapSecrets() {
    const secret = createSecretRecord();
    activeSecrets.length = 0;
    activeSecrets.push(secret);
    lastSecretRotationAt = now();
}

function getCurrentSecret() {
    if (!activeSecrets.length) bootstrapSecrets();
    return activeSecrets[0];
}

function maybeRotateSecrets(force = false) {
    const ts = now();
    const shouldRotate = force || !activeSecrets.length || (ts - lastSecretRotationAt >= SECRET_ROTATION_INTERVAL_MS);
    if (shouldRotate) {
        activeSecrets.unshift(createSecretRecord());
        lastSecretRotationAt = ts;
    }
    for (let i = activeSecrets.length - 1; i >= 0; i -= 1) {
        const secret = activeSecrets[i];
        if (!secret || Number(secret.expiresAt || 0) <= ts) activeSecrets.splice(i, 1);
    }
    if (!activeSecrets.length) {
        activeSecrets.push(createSecretRecord());
        lastSecretRotationAt = ts;
    }
}

function signEnvelope(body, secretValue) {
    return crypto.createHmac('sha256', secretValue).update(String(body || ''), 'utf8').digest('base64url');
}

function safeEquals(left, right) {
    const a = Buffer.from(String(left || ''), 'utf8');
    const b = Buffer.from(String(right || ''), 'utf8');
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
}

function findSecretByKid(kid) {
    return activeSecrets.find((secret) => secret && secret.kid === kid) || null;
}

function verifyEnvelopeSignature(version, kid, body, signature) {
    maybeRotateSecrets();
    const raw = `${version}.${kid}.${body}`;
    const preferred = findSecretByKid(kid);
    if (preferred) {
        const expected = signEnvelope(raw, preferred.value);
        return safeEquals(signature, expected);
    }
    for (const secret of activeSecrets) {
        const expected = signEnvelope(raw, secret.value);
        if (safeEquals(signature, expected)) return true;
    }
    return false;
}

function buildStableRequestKey(targetUrl, options = {}) {
    return stableJson({
        kind: normalizeTransitKind(options.kind),
        targetUrl: normalizeRemoteUrl(targetUrl),
        referer: normalizeReferer(options.referer),
        headers: stableHeaders(options.headers || {}),
        hostBinding: normalizeBinding(options.hostBinding, 'host'),
        routeBinding: normalizeBinding(options.routeBinding, 'route'),
        issuer: normalizeBinding(options.issuer),
        profile: normalizeBinding(options.profile),
        allowInsecureTls: Boolean(options.allowInsecureTls),
        forceHeaders: Boolean(options.forceHeaders),
        meta: options.meta == null ? null : JSON.parse(stableJson(options.meta))
    });
}

function packToken(payload) {
    maybeRotateSecrets();
    const currentSecret = getCurrentSecret();
    const kid = String(payload.kid || currentSecret.kid);
    const completePayload = { ...payload, kid };
    const body = Buffer.from(JSON.stringify(completePayload), 'utf8').toString('base64url');
    const signature = signEnvelope(`${MODULE_VERSION}.${kid}.${body}`, currentSecret.value);
    return `lvt.${MODULE_VERSION}.${kid}.${body}.${signature}`;
}

function unpackToken(token) {
    const raw = String(token || '').trim();

    const modern = raw.match(/^lvt\.(\d+)\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/);
    if (modern) {
        const version = Number(modern[1] || 0);
        const kid = String(modern[2] || '');
        const body = modern[3];
        const signature = modern[4];
        if (!verifyEnvelopeSignature(version, kid, body, signature)) return null;
        try {
            const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
            if (!payload || typeof payload !== 'object') return null;
            if (String(payload.kid || kid) !== kid) return null;
            return { version, kid, payload };
        } catch {
            return null;
        }
    }

    const legacy = raw.match(/^lvt\.(\d+)\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/);
    if (!legacy) return null;
    const version = Number(legacy[1] || 0);
    const body = legacy[2];
    const signature = legacy[3];
    maybeRotateSecrets();
    for (const secret of activeSecrets) {
        const expected = signEnvelope(`${version}.${body}`, secret.value);
        if (!safeEquals(signature, expected)) continue;
        try {
            const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
            if (!payload || typeof payload !== 'object') return null;
            return { version, kid: null, payload };
        } catch {
            return null;
        }
    }
    return null;
}

function touchEntry(entry, ttlMs = null) {
    if (!entry) return null;
    entry.touchedAt = now();
    if (ttlMs && Number(ttlMs) > 0) entry.expiresAt = now() + Number(ttlMs);
    return entry;
}

function deleteTokensByContextId(contextId) {
    let deleted = 0;
    for (const [jti, state] of tokenStateByJti.entries()) {
        if (state && state.contextId === contextId) {
            tokenStateByJti.delete(jti);
            deleted += 1;
        }
    }
    return deleted;
}

function deleteContextById(contextId) {
    const entry = requestContextById.get(contextId);
    if (!entry) return false;
    requestContextById.delete(contextId);
    if (entry.stableKeyHash) requestKeyToId.delete(entry.stableKeyHash);
    deleteTokensByContextId(contextId);
    return true;
}

function maybeSweep(force = false) {
    const ts = now();
    maybeRotateSecrets(force);
    if (!force && ts - lastSweepAt < SWEEP_INTERVAL_MS) return;
    lastSweepAt = ts;

    for (const [contextId, entry] of requestContextById.entries()) {
        if (!entry || Number(entry.expiresAt || 0) <= ts || Number(entry.tokenExpiresAt || 0) <= ts) {
            deleteContextById(contextId);
        }
    }

    for (const [jti, state] of tokenStateByJti.entries()) {
        if (!state || Number(state.expiresAt || 0) <= ts) tokenStateByJti.delete(jti);
    }
}

function enforceMaxLiveContexts() {
    maybeSweep();
    while (requestContextById.size >= MAX_LIVE_CONTEXTS) {
        const oldestId = requestContextById.keys().next().value;
        if (!oldestId) break;
        deleteContextById(oldestId);
    }
}

function stashTransitContext(targetUrl, options = {}) {
    maybeSweep();

    const normalizedTargetUrl = normalizeRemoteUrl(targetUrl);
    if (!normalizedTargetUrl) return null;

    const normalizedReferer = normalizeReferer(options.referer);
    const normalizedHeaders = normalizeRequestHeaders(options.headers || {});
    const contextTtlMs = Math.max(1000, toNonNegativeInt(options.ttlMs, REQUEST_CONTEXT_TTL_MS));
    const tokenTtlMs = Math.max(1000, toNonNegativeInt(options.tokenTtlMs, TOKEN_TTL_MS));
    const requestedMaxUses = toNonNegativeInt(options.maxUses, DEFAULT_MAX_USES);
    const stableKeyHash = sha256(buildStableRequestKey(normalizedTargetUrl, {
        ...options,
        referer: normalizedReferer,
        headers: normalizedHeaders
    }));

    const existingId = requestKeyToId.get(stableKeyHash);
    if (existingId) {
        const existing = requestContextById.get(existingId);
        if (existing && Number(existing.expiresAt || 0) > now()) {
            existing.kind = normalizeTransitKind(options.kind);
            existing.targetUrl = normalizedTargetUrl;
            existing.referer = normalizedReferer;
            existing.headers = normalizedHeaders;
            existing.hostBinding = normalizeBinding(options.hostBinding, 'host');
            existing.routeBinding = normalizeBinding(options.routeBinding, 'route');
            existing.issuer = normalizeBinding(options.issuer);
            existing.profile = normalizeBinding(options.profile);
            existing.allowInsecureTls = Boolean(options.allowInsecureTls);
            existing.forceHeaders = Boolean(options.forceHeaders);
            existing.meta = safeClone(options.meta || null);
            existing.tokenExpiresAt = now() + tokenTtlMs;
            existing.maxUses = toNonNegativeInt(options.maxUses, existing.maxUses ?? DEFAULT_MAX_USES);
            touchEntry(existing, contextTtlMs);
            return existing;
        }
        requestKeyToId.delete(stableKeyHash);
    }

    enforceMaxLiveContexts();

    const ts = now();
    const entry = {
        id: createRandomId('req', 9),
        stableKeyHash,
        kind: normalizeTransitKind(options.kind),
        targetUrl: normalizedTargetUrl,
        referer: normalizedReferer,
        headers: normalizedHeaders,
        hostBinding: normalizeBinding(options.hostBinding, 'host'),
        routeBinding: normalizeBinding(options.routeBinding, 'route'),
        issuer: normalizeBinding(options.issuer),
        profile: normalizeBinding(options.profile),
        allowInsecureTls: Boolean(options.allowInsecureTls),
        forceHeaders: Boolean(options.forceHeaders),
        meta: safeClone(options.meta || null),
        createdAt: ts,
        touchedAt: ts,
        expiresAt: ts + contextTtlMs,
        tokenExpiresAt: ts + tokenTtlMs,
        maxUses: requestedMaxUses,
        hits: 0
    };

    requestContextById.set(entry.id, entry);
    requestKeyToId.set(stableKeyHash, entry.id);
    return entry;
}

function issueTransitKey(targetUrl, options = {}) {
    const entry = stashTransitContext(targetUrl, options);
    if (!entry) return null;

    const tokenExp = Number(entry.tokenExpiresAt || 0);
    if (!Number.isFinite(tokenExp) || tokenExp <= now()) return null;

    const jti = createRandomId('jti', 8);
    const tokenMaxUses = toNonNegativeInt(options.tokenMaxUses, DEFAULT_TOKEN_MAX_USES);
    const currentSecret = getCurrentSecret();

    tokenStateByJti.set(jti, {
        jti,
        kid: currentSecret.kid,
        contextId: entry.id,
        createdAt: now(),
        expiresAt: tokenExp,
        uses: 0,
        maxUses: tokenMaxUses
    });

    return packToken({
        v: MODULE_VERSION,
        typ: 'transit',
        kind: entry.kind,
        cid: entry.id,
        exp: tokenExp,
        jti,
        kid: currentSecret.kid
    });
}

function issueHlsTransitKey(targetUrl, options = {}) {
    return issueTransitKey(targetUrl, {
        ...options,
        kind: normalizeTransitKind(options.kind || TRANSIT_KIND),
        tokenTtlMs: Math.max(1000, toNonNegativeInt(options.tokenTtlMs, HLS_TOKEN_TTL_MS)),
        tokenMaxUses: toNonNegativeInt(options.tokenMaxUses, HLS_TOKEN_MAX_USES),
        maxUses: toNonNegativeInt(options.maxUses, 0)
    });
}

function materializeContext(entry, options = {}) {
    if (!entry) return null;
    const ts = now();
    if (Number(entry.expiresAt || 0) <= ts) return null;
    if (Number(entry.tokenExpiresAt || 0) <= ts) return null;

    const expectedKind = normalizeTransitKind(options.kind || entry.kind);
    const expectedHostBinding = normalizeBinding(options.hostBinding, 'host');
    const expectedRouteBinding = normalizeBinding(options.routeBinding, 'route');

    if (entry.kind && expectedKind && entry.kind !== expectedKind) return null;
    if (entry.hostBinding && expectedHostBinding && entry.hostBinding !== expectedHostBinding) return null;
    if (entry.routeBinding && expectedRouteBinding && entry.routeBinding !== expectedRouteBinding) return null;
    if (entry.maxUses > 0 && entry.hits >= entry.maxUses) return null;

    entry.hits += 1;
    touchEntry(entry);

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
    if (!unpacked) return null;

    const { version, kid, payload } = unpacked;
    if (!payload?.cid) return null;
    if (payload.typ && payload.typ !== 'transit') return null;

    const contextId = String(payload.cid || '').trim();
    const tokenJti = String(payload.jti || '').trim();
    const tokenExp = Number(payload.exp || 0);

    if (!contextId) return null;
    if (Number.isFinite(tokenExp) && tokenExp > 0 && tokenExp <= now()) return null;

    if (tokenJti) {
        const tokenState = tokenStateByJti.get(tokenJti);
        if (!tokenState) return null;
        if (tokenState.contextId !== contextId) return null;
        if (kid && tokenState.kid && tokenState.kid !== kid) return null;
        if (Number(tokenState.expiresAt || 0) <= now()) {
            tokenStateByJti.delete(tokenJti);
            return null;
        }
        if (tokenState.maxUses > 0 && tokenState.uses >= tokenState.maxUses) return null;
    }

    const entry = requestContextById.get(contextId);
    const materialized = materializeContext(entry, options);
    if (!materialized) return null;

    const effectiveExp = Number.isFinite(tokenExp) && tokenExp > 0
        ? Math.min(tokenExp, Number(entry?.tokenExpiresAt || 0))
        : Number(entry?.tokenExpiresAt || 0);
    if (!Number.isFinite(effectiveExp) || effectiveExp <= now()) return null;

    if (tokenJti) {
        const tokenState = tokenStateByJti.get(tokenJti);
        if (!tokenState) return null;
        tokenState.uses += 1;
        materialized.tokenJti = tokenJti;
        materialized.tokenUses = tokenState.uses;
        materialized.tokenMaxUses = tokenState.maxUses;
        materialized.tokenKid = kid || tokenState.kid || null;
    }

    materialized.expiresAt = effectiveExp;
    return materialized;
}

function revokeTransitKey(tokenOrContextId) {
    const raw = String(tokenOrContextId || '').trim();
    if (!raw) return false;

    const unpacked = unpackToken(raw);
    if (unpacked?.payload?.jti) {
        const tokenJti = String(unpacked.payload.jti);
        const contextId = String(unpacked.payload.cid || '');
        const tokenDeleted = tokenStateByJti.delete(tokenJti);
        const contextDeleted = contextId ? deleteContextById(contextId) : false;
        return tokenDeleted || contextDeleted;
    }

    return deleteContextById(raw);
}

function warmTransitContext(targetUrl, options = {}) {
    return stashTransitContext(targetUrl, options);
}

function buildTransitUrl(baseUrl, routePath, token) {
    const normalizedBase = String(baseUrl || '').trim().replace(/\/+$/, '');
    const normalizedRoute = normalizeRouteBinding(routePath || '/vixsynthetic.m3u8');
    const encodedToken = encodeURIComponent(String(token || '').trim());
    if (!normalizedBase || !encodedToken) return null;
    return `${normalizedBase}${normalizedRoute}?d=${encodedToken}`;
}

function getTransitStats() {
    maybeSweep();
    return {
        version: MODULE_VERSION,
        kind: TRANSIT_KIND,
        liveContexts: requestContextById.size,
        liveTokens: tokenStateByJti.size,
        liveSecrets: activeSecrets.length,
        maxLiveContexts: MAX_LIVE_CONTEXTS,
        sweepIntervalMs: SWEEP_INTERVAL_MS,
        secretRotationIntervalMs: SECRET_ROTATION_INTERVAL_MS,
        tokenTtlMs: TOKEN_TTL_MS,
        hlsTokenTtlMs: HLS_TOKEN_TTL_MS,
        lastSecretRotationAt
    };
}

module.exports = {
    MODULE_VERSION,
    TRANSIT_KIND,
    REQUEST_CONTEXT_TTL_MS,
    TOKEN_TTL_MS,
    HLS_TOKEN_TTL_MS,
    SECRET_ROTATION_INTERVAL_MS,
    DEFAULT_MAX_USES,
    DEFAULT_TOKEN_MAX_USES,
    HLS_TOKEN_MAX_USES,
    MAX_LIVE_CONTEXTS,
    normalizeRequestHeaders,
    issueTransitKey,
    issueHlsTransitKey,
    resolveTransitKey,
    revokeTransitKey,
    warmTransitContext,
    buildTransitUrl,
    getTransitStats
};
