'use strict';

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36';
const FETCH_TIMEOUT = 10000;

const caches = {
    http: new Map(),
    inflight: new Map()
};

function getCached(map, key) {
    const entry = map.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= Date.now()) {
        map.delete(key);
        return undefined;
    }
    return entry.value;
}

function setCached(map, key, value, ttlMs) {
    map.set(key, { value, expiresAt: Date.now() + ttlMs });
    return value;
}

function uniqueStrings(values = []) {
    const seen = new Set();
    const output = [];

    for (const value of values) {
        const text = String(value || '').trim();
        const key = text.toLowerCase();
        if (!text || seen.has(key)) continue;
        seen.add(key);
        output.push(text);
    }

    return output;
}

function parsePositiveInt(value) {
    const parsed = Number.parseInt(String(value || ''), 10);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function normalizeRequestedEpisode(value) {
    return parsePositiveInt(value) || 1;
}

function toAbsoluteUrl(href, base = null) {
    if (!href) return null;
    const trimmed = String(href).trim();
    if (!trimmed) return null;
    if (trimmed.startsWith('//')) return `https:${trimmed}`;
    try {
        return new URL(trimmed, base || undefined).toString();
    } catch (_) {
        return null;
    }
}

async function fetchWithTimeout(url, options = {}, timeoutMs = FETCH_TIMEOUT) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
        return await fetch(url, { ...options, signal: controller.signal });
    } finally {
        clearTimeout(timeout);
    }
}

async function fetchResource(url, options = {}) {
    const {
        ttlMs = 0,
        cacheKey = url,
        as = 'text',
        method = 'GET',
        headers = {},
        body = undefined,
        timeoutMs = FETCH_TIMEOUT
    } = options;

    const key = `${as}:${method}:${cacheKey}:${typeof body === 'string' ? body : ''}`;
    if (ttlMs > 0) {
        const cached = getCached(caches.http, key);
        if (cached !== undefined) return cached;
    }

    const inflightKey = `http:${key}`;
    const running = caches.inflight.get(inflightKey);
    if (running) return running;

    const task = (async () => {
        const response = await fetchWithTimeout(url, {
            method,
            headers: {
                'user-agent': USER_AGENT,
                'accept-language': 'it-IT,it;q=0.9,en-US;q=0.8,en;q=0.7',
                ...headers
            },
            body,
            redirect: 'follow'
        }, timeoutMs);

        if (!response.ok) {
            throw new Error(`HTTP ${response.status} ${response.statusText} for ${url}`);
        }

        const payload = as === 'json' ? await response.json() : await response.text();
        if (ttlMs > 0) setCached(caches.http, key, payload, ttlMs);
        return payload;
    })();

    caches.inflight.set(inflightKey, task);
    try {
        return await task;
    } finally {
        caches.inflight.delete(inflightKey);
    }
}

async function mapLimit(values, limit, mapper) {
    if (!Array.isArray(values) || values.length === 0) return [];

    const concurrency = Math.max(1, Math.min(limit, values.length));
    const output = new Array(values.length);
    let cursor = 0;

    async function worker() {
        while (cursor < values.length) {
            const current = cursor;
            cursor += 1;

            try {
                output[current] = await mapper(values[current], current);
            } catch (error) {
                output[current] = null;
                console.error('[AnimeShared] task failed:', error.message);
            }
        }
    }

    await Promise.all(Array.from({ length: concurrency }, () => worker()));
    return output;
}

module.exports = {
    USER_AGENT,
    FETCH_TIMEOUT,
    uniqueStrings,
    parsePositiveInt,
    normalizeRequestedEpisode,
    toAbsoluteUrl,
    fetchWithTimeout,
    fetchResource,
    mapLimit
};
