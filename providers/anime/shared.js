'use strict';

const crypto = require('crypto');

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36';
const FETCH_TIMEOUT = 10000;
const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;
const DEFAULT_HTTP_TTL = 5 * 60 * 1000;
const DEFAULT_HTTP_STALE_TTL = 6 * 60 * 60 * 1000;
const DEFAULT_NEGATIVE_TTL = 45 * 1000;
const DEFAULT_RETRY_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);

function now() {
    return Date.now();
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms || 0)));
}

function stableHash(value) {
    return crypto.createHash('sha1').update(String(value || '')).digest('hex').slice(0, 16);
}

class TtlLruCache {
    constructor({ ttlMs = DEFAULT_HTTP_TTL, staleTtlMs = 0, max = 1000, name = 'cache' } = {}) {
        this.ttlMs = Math.max(0, ttlMs || 0);
        this.staleTtlMs = Math.max(0, staleTtlMs || 0);
        this.max = Math.max(1, max || 1);
        this.name = name;
        this.map = new Map();
        this.hits = 0;
        this.staleHits = 0;
        this.misses = 0;
        this.sets = 0;
        this.deletes = 0;
    }

    _touch(key, entry) {
        this.map.delete(key);
        this.map.set(key, entry);
    }

    _evict() {
        while (this.map.size > this.max) {
            const oldest = this.map.keys().next().value;
            this.map.delete(oldest);
            this.deletes += 1;
        }
    }

    getEntry(key, { allowStale = false } = {}) {
        if (!key) {
            this.misses += 1;
            return undefined;
        }

        const entry = this.map.get(key);
        if (!entry) {
            this.misses += 1;
            return undefined;
        }

        const t = now();
        if (entry.expiresAt > t) {
            this.hits += 1;
            this._touch(key, entry);
            return entry;
        }

        const staleUntil = entry.staleUntil || entry.expiresAt;
        if (allowStale && staleUntil > t) {
            this.staleHits += 1;
            this._touch(key, entry);
            return entry;
        }

        this.map.delete(key);
        this.deletes += 1;
        this.misses += 1;
        return undefined;
    }

    get(key) {
        return this.getEntry(key)?.value;
    }

    getStale(key) {
        return this.getEntry(key, { allowStale: true })?.value;
    }

    peek(key) {
        return this.map.get(key)?.value;
    }

    set(key, value, ttlMs = this.ttlMs, staleTtlMs = this.staleTtlMs) {
        if (!key) return value;
        const expiresAt = now() + Math.max(0, ttlMs || 0);
        const staleUntil = expiresAt + Math.max(0, staleTtlMs || 0);
        if (this.map.has(key)) this.map.delete(key);
        this.map.set(key, { value, createdAt: now(), expiresAt, staleUntil });
        this.sets += 1;
        this._evict();
        return value;
    }

    hasFresh(key) {
        const entry = this.map.get(key);
        return Boolean(entry && entry.expiresAt > now());
    }

    delete(key) {
        const ok = this.map.delete(key);
        if (ok) this.deletes += 1;
        return ok;
    }

    clear() {
        this.map.clear();
    }

    prune() {
        const t = now();
        let removed = 0;
        for (const [key, entry] of this.map.entries()) {
            const staleUntil = entry.staleUntil || entry.expiresAt;
            if (staleUntil <= t) {
                this.map.delete(key);
                removed += 1;
            }
        }
        this.deletes += removed;
        return removed;
    }

    stats() {
        return {
            name: this.name,
            size: this.map.size,
            max: this.max,
            hits: this.hits,
            staleHits: this.staleHits,
            misses: this.misses,
            sets: this.sets,
            deletes: this.deletes
        };
    }
}

class SingleFlight {
    constructor(name = 'singleflight') {
        this.name = name;
        this.map = new Map();
        this.shared = 0;
        this.started = 0;
    }

    do(key, fn) {
        if (!key || typeof fn !== 'function') return Promise.resolve().then(fn);
        const running = this.map.get(key);
        if (running) {
            this.shared += 1;
            return running;
        }
        this.started += 1;
        const task = Promise.resolve()
            .then(fn)
            .finally(() => this.map.delete(key));
        this.map.set(key, task);
        return task;
    }

    stats() {
        return {
            name: this.name,
            inflight: this.map.size,
            shared: this.shared,
            started: this.started
        };
    }
}

class OriginLimiter {
    constructor({ defaultLimit = 6 } = {}) {
        this.defaultLimit = Math.max(1, defaultLimit || 1);
        this.origins = new Map();
    }

    _origin(input) {
        try {
            return new URL(String(input)).origin;
        } catch (_) {
            return String(input || 'default');
        }
    }

    async run(input, fn, limit = this.defaultLimit) {
        const origin = this._origin(input);
        const state = this.origins.get(origin) || { active: 0, queue: [], limit: Math.max(1, limit || this.defaultLimit) };
        state.limit = Math.max(1, limit || state.limit || this.defaultLimit);
        this.origins.set(origin, state);

        if (state.active >= state.limit) {
            await new Promise((resolve) => state.queue.push(resolve));
        }

        state.active += 1;
        try {
            return await fn();
        } finally {
            state.active -= 1;
            const next = state.queue.shift();
            if (next) next();
        }
    }

    stats() {
        const out = {};
        for (const [origin, state] of this.origins.entries()) {
            out[origin] = { active: state.active, queued: state.queue.length, limit: state.limit };
        }
        return out;
    }
}

class CircuitBreaker {
    constructor({ failureThreshold = 4, cooldownMs = 45 * 1000, halfOpenAfterMs = 20 * 1000 } = {}) {
        this.failureThreshold = Math.max(1, failureThreshold || 1);
        this.cooldownMs = Math.max(1000, cooldownMs || 1000);
        this.halfOpenAfterMs = Math.max(1000, halfOpenAfterMs || 1000);
        this.map = new Map();
    }

    _state(key) {
        const safeKey = key || 'default';
        let state = this.map.get(safeKey);
        if (!state) {
            state = { failures: 0, openedAt: 0, lastFailureAt: 0, halfOpen: false };
            this.map.set(safeKey, state);
        }
        return state;
    }

    isOpen(key) {
        const state = this._state(key);
        if (!state.openedAt) return false;
        const age = now() - state.openedAt;
        if (age >= this.cooldownMs) {
            state.openedAt = 0;
            state.failures = Math.max(0, this.failureThreshold - 1);
            state.halfOpen = false;
            return false;
        }
        if (!state.halfOpen && age >= this.halfOpenAfterMs) {
            state.halfOpen = true;
            return false;
        }
        return !state.halfOpen;
    }

    success(key) {
        const state = this._state(key);
        state.failures = 0;
        state.openedAt = 0;
        state.lastFailureAt = 0;
        state.halfOpen = false;
    }

    failure(key) {
        const state = this._state(key);
        state.failures += 1;
        state.lastFailureAt = now();
        if (state.failures >= this.failureThreshold) {
            state.openedAt = now();
            state.halfOpen = false;
        }
    }

    stats() {
        const out = {};
        for (const [key, state] of this.map.entries()) {
            out[key] = { ...state, open: this.isOpen(key) };
        }
        return out;
    }
}

const caches = {
    http: new TtlLruCache({ name: 'http', ttlMs: DEFAULT_HTTP_TTL, staleTtlMs: DEFAULT_HTTP_STALE_TTL, max: 2500 }),
    negative: new TtlLruCache({ name: 'negative', ttlMs: DEFAULT_NEGATIVE_TTL, staleTtlMs: 0, max: 1000 }),
    inflight: new SingleFlight('http'),
    limiter: new OriginLimiter({ defaultLimit: 6 }),
    breaker: new CircuitBreaker()
};

function getCached(map, key) {
    if (!map) return undefined;
    if (typeof map.get === 'function' && !(map instanceof Map)) return map.get(key);
    const entry = map.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= now()) {
        map.delete(key);
        return undefined;
    }
    return entry.value;
}

function setCached(map, key, value, ttlMs) {
    if (!map || !key) return value;
    if (typeof map.set === 'function' && !(map instanceof Map)) return map.set(key, value, ttlMs);
    map.set(key, { value, expiresAt: now() + Math.max(0, ttlMs || 0) });
    return value;
}

function uniqueStrings(values = []) {
    const seen = new Set();
    const output = [];
    for (const value of Array.isArray(values) ? values : [values]) {
        const text = String(value || '').replace(/\s+/g, ' ').trim();
        const key = stripDiacritics(text).toLowerCase();
        if (!text || seen.has(key)) continue;
        seen.add(key);
        output.push(text);
    }
    return output;
}

function flattenUnique(...values) {
    const out = [];
    const walk = (value) => {
        if (Array.isArray(value)) {
            for (const item of value) walk(item);
            return;
        }
        if (value && typeof value === 'object') {
            for (const item of Object.values(value)) walk(item);
            return;
        }
        out.push(value);
    };
    values.forEach(walk);
    return uniqueStrings(out);
}

function parsePositiveInt(value) {
    const parsed = Number.parseInt(String(value || '').replace(/^0+(?=\d)/, ''), 10);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function normalizeRequestedEpisode(value) {
    return parsePositiveInt(value) || 1;
}

function normalizeRequestedSeason(value) {
    const parsed = Number.parseInt(String(value || ''), 10);
    return Number.isInteger(parsed) && parsed >= 0 ? parsed : null;
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

function decodeHtml(value) {
    return String(value || '')
        .replace(/&amp;/gi, '&')
        .replace(/&quot;/gi, '"')
        .replace(/&#039;|&apos;/gi, "'")
        .replace(/&lt;/gi, '<')
        .replace(/&gt;/gi, '>')
        .replace(/&nbsp;/gi, ' ')
        .replace(/&#(\d+);/g, (_, code) => {
            try { return String.fromCodePoint(Number.parseInt(code, 10)); } catch (_) { return _; }
        });
}

function stripDiacritics(value) {
    return String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

function normalizeSpaces(value) {
    return String(value || '').replace(/\s+/g, ' ').trim();
}

function normalizeTitleForSearch(value) {
    return normalizeSpaces(stripDiacritics(decodeHtml(value))
        .replace(/[’`´]/g, "'")
        .replace(/[–—]/g, '-')
        .replace(/½/g, '1/2')
        .replace(/[\[\]{}]/g, ' ')
        .replace(/\((?:19|20)\d{2}\)/g, ' ')
        .replace(/\b(?:1080p|720p|2160p|4k|hdr|webrip|web-dl|bluray|bdrip|x264|x265|hevc|ita|sub\s*ita|dubbed|doppiat[oa])\b/gi, ' ')
        .replace(/\b(?:season|stagione|serie|cour|part|episode|episodio|ep\.?|ova|oad)\s*\d+\b/gi, ' ')
        .replace(/\s*[-:|/]\s*$/g, ''));
}

function buildTitleVariants(values = []) {
    const out = [];
    for (const raw of uniqueStrings(values)) {
        const title = decodeHtml(raw);
        const normalized = normalizeTitleForSearch(title);
        const noYear = normalized.replace(/\b(19|20)\d{2}\b/g, ' ').replace(/\s+/g, ' ').trim();
        const colonHead = normalized.includes(':') ? normalized.split(':')[0].trim() : null;
        const dashHead = normalized.includes(' - ') ? normalized.split(' - ')[0].trim() : null;
        const slashParts = normalized.split(/\s*\/\s*/g).filter((part) => part.length > 2);
        const parenless = normalized.replace(/\([^)]{1,80}\)/g, ' ').replace(/\s+/g, ' ').trim();
        out.push(title, normalized, noYear, colonHead, dashHead, parenless, ...slashParts);
    }
    return uniqueStrings(out.filter(Boolean));
}

function tokenSet(value) {
    const normalized = normalizeTitleForSearch(value).toLowerCase();
    return new Set(normalized.split(/[^a-z0-9]+/i).filter((token) => token.length > 1));
}

function titleSimilarity(a, b) {
    const leftText = normalizeTitleForSearch(a).toLowerCase();
    const rightText = normalizeTitleForSearch(b).toLowerCase();
    if (!leftText || !rightText) return 0;
    if (leftText === rightText) return 1;
    if (leftText.includes(rightText) || rightText.includes(leftText)) return 0.9;

    const left = tokenSet(leftText);
    const right = tokenSet(rightText);
    if (!left.size || !right.size) return 0;

    let intersection = 0;
    for (const token of left) if (right.has(token)) intersection += 1;
    const dice = (2 * intersection) / (left.size + right.size);
    const lengthPenalty = Math.min(leftText.length, rightText.length) / Math.max(leftText.length, rightText.length);
    return Math.max(0, Math.min(1, dice * 0.8 + lengthPenalty * 0.2));
}

function detectAudioLanguage(value) {
    const text = String(value || '').toLowerCase();
    const hasIta = /\b(?:ita|italian[oa]?|italiano|doppiat[oa])\b/.test(text);
    const hasSubIta = /\b(?:sub\s*ita|subbed\s*ita|sottotitoli?\s*ita)\b/.test(text);
    const hasEng = /\b(?:eng|english|inglese)\b/.test(text);
    if (hasIta && hasSubIta) return 'ITA+SUB';
    if (hasIta) return 'ITA';
    if (hasSubIta) return 'SUB ITA';
    if (hasEng) return 'ENG';
    return null;
}

async function fetchWithTimeout(url, options = {}, timeoutMs = FETCH_TIMEOUT) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(new Error(`Timeout ${timeoutMs}ms`)), Math.max(1, timeoutMs || FETCH_TIMEOUT));
    try {
        return await fetch(url, { ...options, signal: controller.signal });
    } finally {
        clearTimeout(timeout);
    }
}

function shouldRetryStatus(status, retryStatuses = DEFAULT_RETRY_STATUSES) {
    return retryStatuses instanceof Set ? retryStatuses.has(status) : new Set(retryStatuses || []).has(status);
}

function bodyFingerprint(body) {
    if (body === undefined || body === null) return '';
    if (typeof body === 'string') return stableHash(body);
    try { return stableHash(JSON.stringify(body)); } catch (_) { return stableHash(String(body)); }
}

async function readResponse(response, as, maxBytes = DEFAULT_MAX_BYTES) {
    const contentLength = Number.parseInt(response.headers.get('content-length') || '', 10);
    if (Number.isInteger(contentLength) && contentLength > maxBytes) {
        throw new Error(`Response too large: ${contentLength} bytes`);
    }

    const text = await response.text();
    if (Buffer.byteLength(text, 'utf8') > maxBytes) {
        throw new Error(`Response too large after read: ${Buffer.byteLength(text, 'utf8')} bytes`);
    }

    if (as === 'json') {
        if (!text.trim()) return null;
        try {
            return JSON.parse(text);
        } catch (error) {
            throw new Error(`Invalid JSON: ${error.message}`);
        }
    }

    if (as === 'buffer') return Buffer.from(text);
    return text;
}

async function fetchResource(url, options = {}) {
    const {
        ttlMs = 0,
        staleTtlMs = DEFAULT_HTTP_STALE_TTL,
        negativeTtlMs = DEFAULT_NEGATIVE_TTL,
        cacheKey = url,
        as = 'text',
        method = 'GET',
        headers = {},
        body = undefined,
        timeoutMs = FETCH_TIMEOUT,
        retries = 2,
        retryStatuses = DEFAULT_RETRY_STATUSES,
        maxBytes = DEFAULT_MAX_BYTES,
        useCache = true,
        useStaleOnError = true,
        useLimiter = true,
        perOriginLimit = 6,
        circuitKey = null,
        accept = null
    } = options;

    const upperMethod = String(method || 'GET').toUpperCase();
    const key = `${as}:${upperMethod}:${cacheKey}:${bodyFingerprint(body)}`;
    const breakerKey = circuitKey || (() => {
        try { return new URL(url).origin; } catch (_) { return 'fetch'; }
    })();

    if (useCache && ttlMs > 0) {
        const cachedEntry = caches.http.getEntry(key, { allowStale: true });
        if (cachedEntry?.expiresAt > now()) return cachedEntry.value;
        if (cachedEntry?.value !== undefined && options.staleWhileRevalidate !== false) {
            caches.inflight.do(`http-revalidate:${key}`, async () => {
                try {
                    await fetchResource(url, {
                        ...options,
                        useStaleOnError: true,
                        staleWhileRevalidate: false
                    });
                } catch (_) {}
            }).catch(() => {});
            return cachedEntry.value;
        }
        const negative = caches.negative.get(key);
        if (negative !== undefined) return negative;
    }

    return caches.inflight.do(`http:${key}`, async () => {
        if (useCache && ttlMs > 0) {
            const cached = caches.http.get(key);
            if (cached !== undefined) return cached;
        }

        if (caches.breaker.isOpen(breakerKey)) {
            const stale = useCache && useStaleOnError ? caches.http.getStale(key) : undefined;
            if (stale !== undefined) return stale;
            throw new Error(`Circuit open for ${breakerKey}`);
        }

        let lastError = null;
        const attempts = Math.max(1, (Number.parseInt(retries, 10) || 0) + 1);

        for (let attempt = 0; attempt < attempts; attempt += 1) {
            try {
                const run = async () => {
                    const response = await fetchWithTimeout(url, {
                        method: upperMethod,
                        headers: {
                            'user-agent': USER_AGENT,
                            'accept-language': 'it-IT,it;q=0.9,en-US;q=0.8,en;q=0.7',
                            'accept-encoding': 'gzip, deflate, br',
                            accept: accept || (as === 'json' ? 'application/json, text/plain, */*' : 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'),
                            ...headers
                        },
                        body,
                        redirect: 'follow'
                    }, timeoutMs);

                    if (!response.ok) {
                        const error = new Error(`HTTP ${response.status} ${response.statusText} for ${url}`);
                        error.status = response.status;
                        error.retryable = shouldRetryStatus(response.status, retryStatuses);
                        throw error;
                    }

                    return readResponse(response, as, maxBytes);
                };

                const payload = useLimiter ? await caches.limiter.run(url, run, perOriginLimit) : await run();
                caches.breaker.success(breakerKey);
                if (useCache && ttlMs > 0) caches.http.set(key, payload, ttlMs, staleTtlMs);
                return payload;
            } catch (error) {
                lastError = error;
                const retryable = error?.name === 'AbortError' || error?.retryable || /timeout|network|fetch failed|ECONNRESET|ETIMEDOUT/i.test(String(error?.message || ''));
                if (!retryable || attempt >= attempts - 1) break;
                const delay = Math.min(2500, 180 * Math.pow(2, attempt)) + Math.floor(Math.random() * 120);
                await sleep(delay);
            }
        }

        caches.breaker.failure(breakerKey);
        const stale = useCache && useStaleOnError ? caches.http.getStale(key) : undefined;
        if (stale !== undefined) return stale;

        if (useCache && ttlMs > 0 && lastError?.status && [404, 410].includes(lastError.status)) {
            caches.negative.set(key, null, negativeTtlMs, 0);
            return null;
        }

        throw lastError || new Error(`Fetch failed for ${url}`);
    });
}

async function mapLimit(values, limit, mapper) {
    if (!Array.isArray(values) || values.length === 0) return [];
    const concurrency = Math.max(1, Math.min(limit || 1, values.length));
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

function getCacheStats() {
    return {
        http: caches.http.stats(),
        negative: caches.negative.stats(),
        inflight: caches.inflight.stats(),
        limiter: caches.limiter.stats(),
        breaker: caches.breaker.stats()
    };
}

function clearSharedCaches() {
    caches.http.clear();
    caches.negative.clear();
}

module.exports = {
    USER_AGENT,
    FETCH_TIMEOUT,
    DEFAULT_MAX_BYTES,
    TtlLruCache,
    SingleFlight,
    OriginLimiter,
    CircuitBreaker,
    caches,
    uniqueStrings,
    flattenUnique,
    parsePositiveInt,
    normalizeRequestedEpisode,
    normalizeRequestedSeason,
    toAbsoluteUrl,
    decodeHtml,
    stripDiacritics,
    normalizeSpaces,
    normalizeTitleForSearch,
    buildTitleVariants,
    titleSimilarity,
    detectAudioLanguage,
    fetchWithTimeout,
    fetchResource,
    getCached,
    setCached,
    mapLimit,
    sleep,
    stableHash,
    getCacheStats,
    clearSharedCaches
};
