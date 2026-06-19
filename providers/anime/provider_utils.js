'use strict';

const crypto = require('crypto');

const USER_AGENT = process.env.LEVIATHAN_USER_AGENT
    || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36';

const FETCH_TIMEOUT = positiveInt(process.env.LEVIATHAN_FETCH_TIMEOUT_MS, 10000);
const DEFAULT_MAPPING_API = trimTrailingSlash(process.env.LEVIATHAN_MAPPING_API || 'https://anime.questoleviatanormio.dpdns.org');
const DEFAULT_HTTP_TTL_MS = positiveInt(process.env.LEVIATHAN_HTTP_CACHE_TTL_MS, 5 * 60 * 1000);
const DEFAULT_HTTP_STALE_MS = positiveInt(process.env.LEVIATHAN_HTTP_CACHE_STALE_MS, 60 * 60 * 1000);
const DEFAULT_MAPPING_TTL_MS = positiveInt(process.env.LEVIATHAN_MAPPING_CACHE_TTL_MS, 45 * 60 * 1000);
const DEFAULT_MAPPING_STALE_MS = positiveInt(process.env.LEVIATHAN_MAPPING_CACHE_STALE_MS, 36 * 60 * 60 * 1000);
const DEFAULT_NEGATIVE_TTL_MS = positiveInt(process.env.LEVIATHAN_NEGATIVE_CACHE_TTL_MS, 45 * 1000);
const MAX_HTTP_CACHE = positiveInt(process.env.LEVIATHAN_HTTP_CACHE_MAX, 3000);
const MAX_MAPPING_CACHE = positiveInt(process.env.LEVIATHAN_MAPPING_CACHE_MAX, 10000);
const MAX_INFLIGHT = positiveInt(process.env.LEVIATHAN_INFLIGHT_MAX, 2000);
const MAX_RESPONSE_BYTES = positiveInt(process.env.LEVIATHAN_MAX_RESPONSE_BYTES, 6 * 1024 * 1024);
const DEFAULT_ORIGIN_CONCURRENCY = positiveInt(process.env.LEVIATHAN_ORIGIN_CONCURRENCY, 8);
const CIRCUIT_FAILURE_THRESHOLD = positiveInt(process.env.LEVIATHAN_CIRCUIT_FAILURES, 5);
const CIRCUIT_COOLDOWN_MS = positiveInt(process.env.LEVIATHAN_CIRCUIT_COOLDOWN_MS, 30000);
const CIRCUIT_HALF_OPEN_MAX = positiveInt(process.env.LEVIATHAN_CIRCUIT_HALF_OPEN_MAX, 2);
const DEFAULT_ACCEPT = 'text/html,application/xhtml+xml,application/xml;q=0.9,application/json;q=0.8,*/*;q=0.7';
const DEFAULT_ACCEPT_LANGUAGE = process.env.LEVIATHAN_ACCEPT_LANGUAGE || 'it-IT,it;q=0.9,en-US;q=0.8,en;q=0.7';

function positiveInt(value, fallback) {
    const parsed = Number.parseInt(String(value || ''), 10);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function boundedInt(value, fallback, min, max) {
    const parsed = positiveInt(value, fallback);
    return Math.max(min, Math.min(max, parsed));
}

function nowMs() {
    return Date.now();
}

function trimTrailingSlash(value) {
    return String(value || '').trim().replace(/\/+$/, '');
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, Math.max(0, ms || 0)));
}

function jitter(ms) {
    const base = Math.max(0, ms || 0);
    return Math.round(base * (0.7 + Math.random() * 0.6));
}

function safeDecodeURIComponent(value) {
    let output = String(value || '').trim();
    for (let i = 0; i < 2; i += 1) {
        try {
            const decoded = decodeURIComponent(output);
            if (decoded === output) break;
            output = decoded;
        } catch (_) {
            break;
        }
    }
    return output;
}

function hashValue(value) {
    if (value === undefined || value === null || value === '') return '';
    const input = Buffer.isBuffer(value)
        ? value
        : typeof value === 'string'
            ? value
            : JSON.stringify(value);
    return crypto.createHash('sha1').update(input).digest('hex');
}

function normalizeHeaders(headers = {}) {
    const output = {};
    for (const [key, value] of Object.entries(headers || {})) {
        if (value === undefined || value === null) continue;
        output[String(key).toLowerCase()] = String(value);
    }
    return output;
}

function cacheHeadersFingerprint(headers = {}) {
    const normalized = normalizeHeaders(headers);
    const safe = Object.keys(normalized)
        .filter(key => !['authorization', 'cookie', 'x-api-key', 'x-real-debrid-token'].includes(key))
        .sort()
        .map(key => [key, normalized[key]]);
    return hashValue(safe);
}

function originOf(url) {
    try {
        return new URL(String(url)).origin;
    } catch (_) {
        return 'unknown';
    }
}

class RollingMetrics {
    constructor(name = 'metrics') {
        this.name = name;
        this.startedAt = nowMs();
        this.counters = Object.create(null);
        this.samples = Object.create(null);
    }

    inc(name, by = 1) {
        this.counters[name] = (this.counters[name] || 0) + by;
    }

    sample(name, value) {
        const numeric = Number(value);
        if (!Number.isFinite(numeric)) return;
        const entry = this.samples[name] || { count: 0, min: numeric, max: numeric, sum: 0, avg: 0 };
        entry.count += 1;
        entry.min = Math.min(entry.min, numeric);
        entry.max = Math.max(entry.max, numeric);
        entry.sum += numeric;
        entry.avg = Math.round((entry.sum / entry.count) * 100) / 100;
        this.samples[name] = entry;
    }

    snapshot() {
        return {
            name: this.name,
            uptimeMs: nowMs() - this.startedAt,
            counters: { ...this.counters },
            samples: JSON.parse(JSON.stringify(this.samples))
        };
    }

    clear() {
        this.startedAt = nowMs();
        this.counters = Object.create(null);
        this.samples = Object.create(null);
    }
}

class TtlLruCache {
    constructor({ max = 1000, ttlMs = 600000, staleMs = 0, name = 'cache' } = {}) {
        this.max = Math.max(1, max);
        this.ttlMs = Math.max(1, ttlMs);
        this.staleMs = Math.max(0, staleMs);
        this.name = name;
        this.map = new Map();
        this.lastPruneAt = 0;
        this.metrics = new RollingMetrics(`${name}:cache`);
    }

    get size() {
        return this.map.size;
    }

    getEntry(key, { allowStale = false, touch = true } = {}) {
        if (!key) {
            this.metrics.inc('miss');
            return undefined;
        }

        const entry = this.map.get(key);
        if (!entry) {
            this.metrics.inc('miss');
            return undefined;
        }

        const ts = nowMs();
        if (entry.expiresAt <= ts && (!allowStale || entry.staleUntil <= ts)) {
            this.map.delete(key);
            this.metrics.inc('expired');
            return undefined;
        }

        if (touch) {
            this.map.delete(key);
            this.map.set(key, entry);
        }

        const fresh = entry.expiresAt > ts;
        if (fresh) this.metrics.inc('hit');
        else this.metrics.inc('stale_hit');

        return {
            value: entry.value,
            fresh,
            stale: !fresh && entry.staleUntil > ts,
            expiresAt: entry.expiresAt,
            staleUntil: entry.staleUntil,
            meta: entry.meta || null
        };
    }

    get(key) {
        const entry = this.getEntry(key, { allowStale: false });
        return entry ? entry.value : undefined;
    }

    getStale(key) {
        return this.getEntry(key, { allowStale: true });
    }

    set(key, value, ttlMs = this.ttlMs, staleMs = this.staleMs, meta = null) {
        if (!key) return value;
        const ts = nowMs();
        if (this.map.has(key)) this.map.delete(key);
        this.map.set(key, {
            value,
            meta,
            createdAt: ts,
            expiresAt: ts + Math.max(1, ttlMs),
            staleUntil: ts + Math.max(1, ttlMs) + Math.max(0, staleMs)
        });
        this.metrics.inc('set');
        this.enforceLimit();
        this.pruneExpiredSoft();
        return value;
    }

    delete(key) {
        return this.map.delete(key);
    }

    clear() {
        this.map.clear();
        this.metrics.clear();
    }

    enforceLimit() {
        while (this.map.size > this.max) {
            const oldest = this.map.keys().next().value;
            if (oldest === undefined) break;
            this.map.delete(oldest);
            this.metrics.inc('eviction');
        }
    }

    pruneExpiredSoft() {
        const ts = nowMs();
        if (ts - this.lastPruneAt < 30000) return;
        this.lastPruneAt = ts;
        let scanned = 0;
        for (const [key, entry] of this.map.entries()) {
            if (++scanned > 128) break;
            if (entry.staleUntil <= ts) {
                this.map.delete(key);
                this.metrics.inc('expired_pruned');
            }
        }
    }

    keys(limit = 50) {
        return Array.from(this.map.keys()).slice(0, Math.max(0, limit));
    }

    stats() {
        return {
            name: this.name,
            size: this.map.size,
            max: this.max,
            ttlMs: this.ttlMs,
            staleMs: this.staleMs,
            metrics: this.metrics.snapshot()
        };
    }
}

class SingleFlight {
    constructor(max = 1000) {
        this.max = Math.max(1, max);
        this.map = new Map();
        this.metrics = new RollingMetrics('singleflight');
    }

    run(key, taskFactory) {
        if (!key) return taskFactory();
        const existing = this.map.get(key);
        if (existing) {
            this.metrics.inc('joined');
            return existing;
        }
        if (this.map.size >= this.max) {
            const oldest = this.map.keys().next().value;
            if (oldest !== undefined) this.map.delete(oldest);
            this.metrics.inc('eviction');
        }
        this.metrics.inc('started');
        const task = Promise.resolve().then(taskFactory);
        this.map.set(key, task);
        task.finally(() => this.map.delete(key)).catch(() => {});
        return task;
    }

    stats() {
        return {
            size: this.map.size,
            max: this.max,
            metrics: this.metrics.snapshot()
        };
    }
}

class Semaphore {
    constructor(limit = 8) {
        this.limit = Math.max(1, limit);
        this.active = 0;
        this.queue = [];
        this.metrics = new RollingMetrics('semaphore');
    }

    async run(taskFactory) {
        if (this.active >= this.limit) {
            this.metrics.inc('queued');
            await new Promise(resolve => this.queue.push(resolve));
        }
        this.active += 1;
        this.metrics.inc('started');
        try {
            return await taskFactory();
        } finally {
            this.active -= 1;
            const next = this.queue.shift();
            if (next) next();
        }
    }

    stats() {
        return {
            limit: this.limit,
            active: this.active,
            queued: this.queue.length,
            metrics: this.metrics.snapshot()
        };
    }
}

class OriginLimiter {
    constructor(defaultLimit = DEFAULT_ORIGIN_CONCURRENCY) {
        this.defaultLimit = Math.max(1, defaultLimit);
        this.map = new Map();
    }

    get(url, limit = this.defaultLimit) {
        const origin = originOf(url);
        const key = `${origin}:${Math.max(1, limit)}`;
        let sem = this.map.get(key);
        if (!sem) {
            sem = new Semaphore(limit);
            this.map.set(key, sem);
        }
        return sem;
    }

    run(url, taskFactory, limit = this.defaultLimit) {
        return this.get(url, limit).run(taskFactory);
    }

    clear() {
        this.map.clear();
    }

    stats() {
        const output = {};
        for (const [key, sem] of this.map.entries()) output[key] = sem.stats();
        return output;
    }
}

class CircuitBreaker {
    constructor({ failureThreshold = CIRCUIT_FAILURE_THRESHOLD, cooldownMs = CIRCUIT_COOLDOWN_MS, halfOpenMax = CIRCUIT_HALF_OPEN_MAX } = {}) {
        this.failureThreshold = Math.max(1, failureThreshold);
        this.cooldownMs = Math.max(1000, cooldownMs);
        this.halfOpenMax = Math.max(1, halfOpenMax);
        this.map = new Map();
        this.metrics = new RollingMetrics('circuit');
    }

    get(origin) {
        const key = origin || 'unknown';
        let entry = this.map.get(key);
        if (!entry) {
            entry = { state: 'closed', failures: 0, openedAt: 0, halfOpenInFlight: 0, lastError: null };
            this.map.set(key, entry);
        }
        return entry;
    }

    before(origin) {
        const entry = this.get(origin);
        const ts = nowMs();
        if (entry.state === 'open') {
            if (ts - entry.openedAt >= this.cooldownMs) {
                entry.state = 'half_open';
                entry.halfOpenInFlight = 0;
                this.metrics.inc('half_open');
            } else {
                this.metrics.inc('blocked');
                const waitMs = this.cooldownMs - (ts - entry.openedAt);
                const error = new Error(`Circuit open for ${origin}; retry in ${waitMs}ms`);
                error.code = 'CIRCUIT_OPEN';
                error.retryAfterMs = waitMs;
                throw error;
            }
        }
        if (entry.state === 'half_open') {
            if (entry.halfOpenInFlight >= this.halfOpenMax) {
                this.metrics.inc('half_open_blocked');
                const error = new Error(`Circuit half-open limit reached for ${origin}`);
                error.code = 'CIRCUIT_HALF_OPEN_LIMIT';
                throw error;
            }
            entry.halfOpenInFlight += 1;
        }
    }

    success(origin) {
        const entry = this.get(origin);
        if (entry.state === 'half_open') entry.halfOpenInFlight = Math.max(0, entry.halfOpenInFlight - 1);
        entry.state = 'closed';
        entry.failures = 0;
        entry.lastError = null;
        this.metrics.inc('success');
    }

    failure(origin, error) {
        const entry = this.get(origin);
        if (entry.state === 'half_open') entry.halfOpenInFlight = Math.max(0, entry.halfOpenInFlight - 1);
        entry.failures += 1;
        entry.lastError = String(error?.message || error || 'unknown');
        this.metrics.inc('failure');
        if (entry.failures >= this.failureThreshold || entry.state === 'half_open') {
            entry.state = 'open';
            entry.openedAt = nowMs();
            entry.halfOpenInFlight = 0;
            this.metrics.inc('opened');
        }
    }

    clear(origin = null) {
        if (origin) this.map.delete(origin);
        else this.map.clear();
    }

    stats() {
        const origins = {};
        for (const [origin, entry] of this.map.entries()) origins[origin] = { ...entry };
        return {
            failureThreshold: this.failureThreshold,
            cooldownMs: this.cooldownMs,
            halfOpenMax: this.halfOpenMax,
            origins,
            metrics: this.metrics.snapshot()
        };
    }
}

const caches = {
    http: new TtlLruCache({ name: 'http', max: MAX_HTTP_CACHE, ttlMs: DEFAULT_HTTP_TTL_MS, staleMs: DEFAULT_HTTP_STALE_MS }),
    mapping: new TtlLruCache({ name: 'mapping', max: MAX_MAPPING_CACHE, ttlMs: DEFAULT_MAPPING_TTL_MS, staleMs: DEFAULT_MAPPING_STALE_MS }),
    negative: new TtlLruCache({ name: 'negative', max: MAX_MAPPING_CACHE, ttlMs: DEFAULT_NEGATIVE_TTL_MS, staleMs: 0 }),
    inflight: new SingleFlight(MAX_INFLIGHT),
    originLimiter: new OriginLimiter(DEFAULT_ORIGIN_CONCURRENCY),
    circuitBreaker: new CircuitBreaker()
};

function getCached(map, key, options = {}) {
    if (!map) return undefined;
    if (typeof map.getEntry === 'function') {
        const entry = map.getEntry(key, options);
        return entry ? entry.value : undefined;
    }
    const entry = map.get?.(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= nowMs()) {
        map.delete(key);
        return undefined;
    }
    return entry.value;
}

function setCached(map, key, value, ttlMs, staleMs = 0) {
    if (!map) return value;
    if (map instanceof TtlLruCache) return map.set(key, value, ttlMs, staleMs);
    map.set(key, { value, expiresAt: nowMs() + ttlMs });
    return value;
}

function uniqueStrings(values = []) {
    const seen = new Set();
    const output = [];
    for (const value of values) {
        const text = String(value || '').replace(/\s+/g, ' ').trim();
        const key = text.toLowerCase();
        if (!text || seen.has(key)) continue;
        seen.add(key);
        output.push(text);
    }
    return output;
}

function flattenUnique(values = []) {
    const output = [];
    const seen = new Set();
    for (const value of values.flat(Infinity)) {
        if (value === undefined || value === null || value === '') continue;
        const key = typeof value === 'string' ? value.toLowerCase() : hashValue(value);
        if (seen.has(key)) continue;
        seen.add(key);
        output.push(value);
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

function normalizeRequestedSeason(value) {
    const parsed = Number.parseInt(String(value || ''), 10);
    return Number.isInteger(parsed) && parsed >= 0 ? parsed : null;
}

function normalizeConfigBoolean(value) {
    if (value === true) return true;
    if (value === false || value === null || value === undefined) return false;
    const normalized = String(value).trim().toLowerCase();
    return ['1', 'true', 'yes', 'y', 'on', 'enabled', 'checked', 'si', 'sì'].includes(normalized);
}

function getMappingLanguage(providerContext = null) {
    const explicit = String(providerContext?.mappingLanguage || providerContext?.language || providerContext?.lang || '').trim().toLowerCase();
    if (['it', 'ita', 'italian', 'italiano'].includes(explicit)) return 'it';
    if (normalizeConfigBoolean(providerContext?.easyCatalogsLangIt)) return 'it';
    if (normalizeConfigBoolean(providerContext?.italianOnly)) return 'it';
    if (normalizeConfigBoolean(providerContext?.onlyItalian)) return 'it';
    if (normalizeConfigBoolean(providerContext?.onlyIt)) return 'it';
    return null;
}

function toAbsoluteUrl(href, base = null) {
    if (!href) return null;
    const trimmed = String(href).trim();
    if (!trimmed || trimmed === '#' || trimmed.toLowerCase().startsWith('javascript:')) return null;
    if (trimmed.startsWith('//')) return `https:${trimmed}`;
    try {
        return new URL(trimmed, base || undefined).toString();
    } catch (_) {
        return null;
    }
}

function isRetryableStatus(status) {
    return [408, 425, 429, 500, 502, 503, 504, 522, 523, 524].includes(Number(status));
}

function isHttpNotFoundError(error) {
    const status = Number(error?.status || error?.response?.status || 0);
    if (status === 404) return true;
    return /HTTP\s+404\b/i.test(String(error?.message || error || ''));
}

function isRetryableError(error) {
    const name = String(error?.name || '').toLowerCase();
    const code = String(error?.code || '').toLowerCase();
    const message = String(error?.message || '').toLowerCase();
    return name.includes('abort')
        || code.includes('timeout')
        || code === 'econnreset'
        || code === 'etimedout'
        || code === 'enotfound'
        || code === 'eai_again'
        || code === 'socketerror'
        || message.includes('fetch failed')
        || message.includes('network')
        || message.includes('timeout')
        || message.includes('aborted')
        || message.includes('terminated');
}

function retryAfterMs(headerValue) {
    if (!headerValue) return null;
    const seconds = Number.parseInt(String(headerValue).trim(), 10);
    if (Number.isInteger(seconds) && seconds >= 0) return Math.min(seconds * 1000, 30000);
    const dateMs = Date.parse(String(headerValue));
    if (Number.isFinite(dateMs)) return Math.max(0, Math.min(dateMs - nowMs(), 30000));
    return null;
}

async function fetchWithTimeout(url, options = {}, timeoutMs = FETCH_TIMEOUT, fetchImpl = globalThis.fetch) {
    if (typeof fetchImpl !== 'function') throw new Error('Global fetch is not available; use Node 18+ or pass fetchImpl');
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), Math.max(1, timeoutMs));
    const externalSignal = options.signal;

    function abortFromExternal() {
        try { controller.abort(); } catch (_) {}
    }

    if (externalSignal) {
        if (externalSignal.aborted) controller.abort();
        else externalSignal.addEventListener('abort', abortFromExternal, { once: true });
    }

    try {
        const finalOptions = { ...options, signal: controller.signal };
        return await fetchImpl(url, finalOptions);
    } finally {
        clearTimeout(timeout);
        if (externalSignal) externalSignal.removeEventListener?.('abort', abortFromExternal);
    }
}

async function readResponseBufferLimited(response, maxBytes = MAX_RESPONSE_BYTES) {
    const length = Number.parseInt(response.headers.get('content-length') || '0', 10);
    if (Number.isInteger(length) && length > maxBytes) throw new Error(`Response too large: ${length} bytes`);
    const reader = response.body?.getReader?.();
    if (!reader) {
        const arrayBuffer = await response.arrayBuffer();
        const buffer = Buffer.from(arrayBuffer);
        if (buffer.length > maxBytes) throw new Error(`Response too large: >${maxBytes} bytes`);
        return buffer;
    }
    const chunks = [];
    let total = 0;
    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value) continue;
        total += value.byteLength;
        if (total > maxBytes) {
            try { await reader.cancel(); } catch (_) {}
            throw new Error(`Response too large: >${maxBytes} bytes`);
        }
        chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks);
}

async function readResponsePayload(response, as = 'text', maxBytes = MAX_RESPONSE_BYTES) {
    const buffer = await readResponseBufferLimited(response, maxBytes);
    if (as === 'buffer' || as === 'arraybuffer') return buffer;
    const text = buffer.toString('utf8');
    if (as === 'json') return JSON.parse(text);
    return text;
}

function buildFetchCacheKey({ as, method, cacheKey, body, headers }) {
    return [
        as || 'text',
        String(method || 'GET').toUpperCase(),
        cacheKey,
        hashValue(body),
        cacheHeadersFingerprint(headers)
    ].join(':');
}

async function fetchResource(url, options = {}) {
    const {
        ttlMs = 0,
        staleMs = DEFAULT_HTTP_STALE_MS,
        cacheKey = url,
        as = 'text',
        method = 'GET',
        headers = {},
        body = undefined,
        timeoutMs = FETCH_TIMEOUT,
        retries = 2,
        retryDelayMs = 220,
        maxBytes = MAX_RESPONSE_BYTES,
        allowStaleOnError = true,
        redirect = 'follow',
        forceRefresh = false,
        originConcurrency = DEFAULT_ORIGIN_CONCURRENCY,
        useCircuitBreaker = true,
        useOriginLimiter = true,
        validate = null,
        fetchImpl = globalThis.fetch
    } = options;

    const finalMethod = String(method || 'GET').toUpperCase();
    const finalHeaders = {
        'user-agent': USER_AGENT,
        'accept': as === 'json' ? 'application/json,text/plain;q=0.9,*/*;q=0.8' : DEFAULT_ACCEPT,
        'accept-language': DEFAULT_ACCEPT_LANGUAGE,
        'accept-encoding': 'gzip, deflate, br',
        ...normalizeHeaders(headers)
    };
    const key = buildFetchCacheKey({ as, method: finalMethod, cacheKey, body, headers: finalHeaders });
    const canCache = ttlMs > 0 && ['GET', 'HEAD'].includes(finalMethod);
    const staleEntry = canCache ? caches.http.getStale(key) : undefined;
    if (!forceRefresh && staleEntry?.fresh) return staleEntry.value;
    if (!forceRefresh && staleEntry?.stale && staleEntry.value !== undefined && options.staleWhileRevalidate !== false) {
        caches.inflight.run(`http-revalidate:${key}`, async () => {
            try {
                await fetchResource(url, {
                    ...options,
                    forceRefresh: true,
                    allowStaleOnError: true,
                    staleWhileRevalidate: false
                });
            } catch (_) {}
        }).catch(() => {});
        return staleEntry.value;
    }

    return caches.inflight.run(`http:${key}`, async () => {
        const inFlightEntry = canCache ? caches.http.getStale(key) : undefined;
        if (!forceRefresh && inFlightEntry?.fresh) return inFlightEntry.value;

        const requestOrigin = originOf(url);
        try {
            if (useCircuitBreaker) caches.circuitBreaker.before(requestOrigin);
        } catch (error) {
            if (allowStaleOnError && inFlightEntry?.value !== undefined) return inFlightEntry.value;
            throw error;
        }

        let lastError = null;
        let shouldCountCircuitFailure = false;
        const attempts = Math.max(0, Number.parseInt(String(retries), 10) || 0) + 1;
        const started = nowMs();

        for (let attempt = 0; attempt < attempts; attempt += 1) {
            try {
                const response = await (useOriginLimiter
                    ? caches.originLimiter.run(url, () => fetchWithTimeout(url, { method: finalMethod, headers: finalHeaders, body, redirect }, timeoutMs, fetchImpl), boundedInt(originConcurrency, DEFAULT_ORIGIN_CONCURRENCY, 1, 64))
                    : fetchWithTimeout(url, { method: finalMethod, headers: finalHeaders, body, redirect }, timeoutMs, fetchImpl));

                if (!response.ok) {
                    const retryable = isRetryableStatus(response.status);
                    shouldCountCircuitFailure = retryable || response.status >= 500;
                    lastError = new Error(`HTTP ${response.status} ${response.statusText} for ${url}`);
                    lastError.status = response.status;
                    lastError.retryable = retryable;
                    const delay = retryAfterMs(response.headers.get('retry-after')) || jitter(retryDelayMs * Math.pow(2, attempt));
                    if (retryable && attempt < attempts - 1) {
                        try { await response.body?.cancel?.(); } catch (_) {}
                        await sleep(delay);
                        continue;
                    }
                    throw lastError;
                }

                const payload = await readResponsePayload(response, as, maxBytes);
                if (typeof validate === 'function') {
                    const valid = await validate(payload, response);
                    if (valid === false) throw new Error(`Validation failed for ${url}`);
                }
                if (canCache) caches.http.set(key, payload, ttlMs, staleMs, { url, origin: requestOrigin, as });
                if (useCircuitBreaker) caches.circuitBreaker.success(requestOrigin);
                caches.http.metrics.sample('latency_ms', nowMs() - started);
                return payload;
            } catch (error) {
                lastError = error;
                if (isRetryableError(error)) shouldCountCircuitFailure = true;
                if (attempt < attempts - 1 && (isRetryableError(error) || error?.retryable)) {
                    await sleep(jitter(retryDelayMs * Math.pow(2, attempt)));
                    continue;
                }
                break;
            }
        }

        if (useCircuitBreaker && shouldCountCircuitFailure) caches.circuitBreaker.failure(requestOrigin, lastError);
        if (allowStaleOnError && inFlightEntry?.value !== undefined) return inFlightEntry.value;
        throw lastError || new Error(`Fetch failed for ${url}`);
    });
}

function parseProviderEpisodeTokens(provider, first, second) {
    const season = second ? normalizeRequestedSeason(first) : null;
    const episode = second ? normalizeRequestedEpisode(second) : first ? normalizeRequestedEpisode(first) : null;
    if (provider === 'kitsu' && !second) return { season: null, episode };
    return { season, episode };
}

function extractIdCandidate(rawId) {
    const value = safeDecodeURIComponent(rawId).replace(/[?#].*$/, '').replace(/\.json$/i, '').trim();
    if (!value) return '';
    const exact = value.match(/^(?:kitsu:(?:anime:)?\d+|imdb:tt\d+|tmdb:(?:(?:movie|tv|series):)?\d+|tt\d+|\d+)(?::\d+){0,2}$/i);
    if (exact) return value;
    const embedded = value.match(/(?:kitsu:(?:anime:)?\d+(?::\d+){0,2}|imdb:tt\d+(?::\d+){0,2}|tmdb:(?:(?:movie|tv|series):)?\d+(?::\d+){0,2}|tt\d+(?::\d+){0,2})/i);
    return embedded ? embedded[0] : value.split('/').filter(Boolean).pop() || value;
}

function parseExplicitRequestId(rawId) {
    const value = extractIdCandidate(rawId);
    if (!value) return null;

    let match = value.match(/^kitsu:(?:anime:)?(\d+)(?::(\d+))?(?::(\d+))?$/i);
    if (match) {
        const tokens = parseProviderEpisodeTokens('kitsu', match[2], match[3]);
        return { provider: 'kitsu', externalId: match[1], seasonFromId: tokens.season, episodeFromId: tokens.episode, contentType: 'anime' };
    }

    match = value.match(/^imdb:(tt\d+)(?::(\d+))?(?::(\d+))?$/i);
    if (match) {
        const tokens = parseProviderEpisodeTokens('imdb', match[2], match[3]);
        return { provider: 'imdb', externalId: match[1], seasonFromId: tokens.season, episodeFromId: tokens.episode, contentType: tokens.season !== null ? 'series' : null };
    }

    match = value.match(/^tmdb:(?:(movie|tv|series):)?(\d+)(?::(\d+))?(?::(\d+))?$/i);
    if (match) {
        const tokens = parseProviderEpisodeTokens('tmdb', match[3], match[4]);
        const typeToken = String(match[1] || '').toLowerCase();
        return {
            provider: 'tmdb',
            externalId: match[2],
            seasonFromId: tokens.season,
            episodeFromId: tokens.episode,
            contentType: typeToken === 'movie' ? 'movie' : typeToken ? 'series' : tokens.season !== null ? 'series' : null
        };
    }

    match = value.match(/^(tt\d+)(?::(\d+))?(?::(\d+))?$/i);
    if (match) {
        const tokens = parseProviderEpisodeTokens('imdb', match[2], match[3]);
        return { provider: 'imdb', externalId: match[1], seasonFromId: tokens.season, episodeFromId: tokens.episode, contentType: tokens.season !== null ? 'series' : null };
    }

    match = value.match(/^(\d+)(?::(\d+))?(?::(\d+))?$/);
    if (match) {
        const tokens = parseProviderEpisodeTokens('tmdb', match[2], match[3]);
        return { provider: 'tmdb', externalId: match[1], seasonFromId: tokens.season, episodeFromId: tokens.episode, contentType: tokens.season !== null ? 'series' : null };
    }

    return null;
}

function resolveLookupRequest(id, season, episode, providerContext = null) {
    let requestedSeason = normalizeRequestedSeason(season);
    let requestedEpisode = normalizeRequestedEpisode(episode);
    const explicit = parseExplicitRequestId(id);

    if (explicit) {
        if (Number.isInteger(explicit.seasonFromId) && explicit.seasonFromId >= 0) requestedSeason = explicit.seasonFromId;
        if (Number.isInteger(explicit.episodeFromId) && explicit.episodeFromId > 0) requestedEpisode = explicit.episodeFromId;
        if (explicit.provider === 'kitsu' && !Number.isInteger(explicit.seasonFromId)) requestedSeason = null;
        return { provider: explicit.provider, externalId: explicit.externalId, season: requestedSeason, episode: requestedEpisode, contentType: explicit.contentType || null };
    }

    const contextExplicit = parseExplicitRequestId(providerContext?.id || providerContext?.stremioId || providerContext?.videoId || '');
    if (contextExplicit) {
        if (Number.isInteger(contextExplicit.seasonFromId) && contextExplicit.seasonFromId >= 0) requestedSeason = contextExplicit.seasonFromId;
        if (Number.isInteger(contextExplicit.episodeFromId) && contextExplicit.episodeFromId > 0) requestedEpisode = contextExplicit.episodeFromId;
        return {
            provider: contextExplicit.provider,
            externalId: contextExplicit.externalId,
            season: contextExplicit.provider === 'kitsu' ? null : requestedSeason,
            episode: requestedEpisode,
            contentType: contextExplicit.contentType || null
        };
    }

    const contextKitsu = parsePositiveInt(providerContext?.kitsuId || providerContext?.kitsu_id || providerContext?.kitsu);
    if (contextKitsu) return { provider: 'kitsu', externalId: String(contextKitsu), season: null, episode: requestedEpisode, contentType: 'anime' };

    const contextImdb = /^tt\d+$/i.test(String(providerContext?.imdbId || providerContext?.imdb_id || providerContext?.imdb || '').trim())
        ? String(providerContext?.imdbId || providerContext?.imdb_id || providerContext?.imdb).trim()
        : null;
    if (contextImdb) return { provider: 'imdb', externalId: contextImdb, season: requestedSeason, episode: requestedEpisode, contentType: requestedSeason !== null ? 'series' : null };

    const contextTmdb = /^\d+$/.test(String(providerContext?.tmdbId || providerContext?.tmdb_id || providerContext?.tmdb || '').trim())
        ? String(providerContext?.tmdbId || providerContext?.tmdb_id || providerContext?.tmdb).trim()
        : null;
    if (contextTmdb) return { provider: 'tmdb', externalId: contextTmdb, season: requestedSeason, episode: requestedEpisode, contentType: requestedSeason !== null ? 'series' : null };

    return null;
}

function findDeepId(payload, keys, maxDepth = 5) {
    const wanted = new Set(keys.map(key => String(key).toLowerCase()));
    const seen = new Set();
    const stack = [{ value: payload, depth: 0 }];
    while (stack.length) {
        const { value, depth } = stack.pop();
        if (!value || typeof value !== 'object' || depth > maxDepth || seen.has(value)) continue;
        seen.add(value);
        for (const [key, child] of Object.entries(value)) {
            const normalizedKey = String(key).toLowerCase();
            if (wanted.has(normalizedKey)) {
                const text = String(child || '').trim();
                if (/^\d+$/.test(text)) return text;
            }
            if (child && typeof child === 'object') stack.push({ value: child, depth: depth + 1 });
        }
    }
    return null;
}

function extractTmdbIdFromMappingPayload(mappingPayload) {
    const direct = mappingPayload?.mappings?.ids?.tmdb
        || mappingPayload?.mappings?.tmdb
        || mappingPayload?.ids?.tmdb
        || mappingPayload?.data?.ids?.tmdb
        || mappingPayload?.result?.ids?.tmdb
        || mappingPayload?.tmdbId
        || mappingPayload?.tmdb_id
        || mappingPayload?.tmdb
        || null;
    const text = String(direct || '').trim();
    if (/^\d+$/.test(text)) return text;
    return findDeepId(mappingPayload, ['tmdb', 'tmdbid', 'tmdb_id'], 5);
}

function getMappingApiBases(mappingApiBase = DEFAULT_MAPPING_API, providerContext = null) {
    const values = [];
    if (Array.isArray(mappingApiBase)) values.push(...mappingApiBase);
    else values.push(mappingApiBase);
    if (providerContext?.mappingApiBase) values.push(providerContext.mappingApiBase);
    if (Array.isArray(providerContext?.mappingApiBases)) values.push(...providerContext.mappingApiBases);
    if (process.env.LEVIATHAN_MAPPING_API_MIRRORS) values.push(...process.env.LEVIATHAN_MAPPING_API_MIRRORS.split(','));
    return uniqueStrings(values.map(trimTrailingSlash).filter(Boolean));
}

async function fetchMappingPayload(lookup, providerContext = null, mappingApiBase = DEFAULT_MAPPING_API) {
    if (!lookup?.provider || !lookup?.externalId) return null;

    const provider = String(lookup.provider || '').trim().toLowerCase();
    const externalId = String(lookup.externalId || '').trim();
    const requestedEpisode = normalizeRequestedEpisode(lookup.episode);
    const requestedSeason = normalizeRequestedSeason(lookup.season);
    if (!['kitsu', 'imdb', 'tmdb'].includes(provider) || !externalId) return null;

    const mappingLanguage = provider === 'kitsu' ? 'it' : getMappingLanguage(providerContext);
    const mappingLanguageToken = mappingLanguage || 'default';
    const baseFingerprint = hashValue(getMappingApiBases(mappingApiBase, providerContext).join('|')).slice(0, 12);
    const cacheKey = `${baseFingerprint}:${provider}:${externalId}:s=${requestedSeason ?? 'na'}:ep=${requestedEpisode}:lang=${mappingLanguageToken}`;
    const cached = caches.mapping.getStale(cacheKey);
    if (cached?.fresh) return cached.value;

    const negative = caches.negative.get(cacheKey);
    if (negative !== undefined && !cached?.value) return null;

    return caches.inflight.run(`mapping:${cacheKey}`, async () => {
        const cachedInside = caches.mapping.getStale(cacheKey);
        if (cachedInside?.fresh) return cachedInside.value;

        const params = new URLSearchParams();
        params.set('ep', String(requestedEpisode));
        if (Number.isInteger(requestedSeason) && requestedSeason >= 0) params.set('s', String(requestedSeason));
        if (mappingLanguage === 'it') params.set('lang', 'it');

        const ttlMs = positiveInt(providerContext?.mappingTtlMs, DEFAULT_MAPPING_TTL_MS);
        const staleMs = positiveInt(providerContext?.mappingStaleMs, DEFAULT_MAPPING_STALE_MS);
        const timeoutMs = positiveInt(providerContext?.mappingTimeoutMs, FETCH_TIMEOUT);
        const retries = boundedInt(providerContext?.mappingRetries, 2, 0, 5);
        const bases = getMappingApiBases(mappingApiBase, providerContext);
        let lastError = null;

        for (const base of bases) {
            const url = `${base}/${provider}/${encodeURIComponent(externalId)}?${params.toString()}`;
            try {
                const payload = await fetchResource(url, {
                    as: 'json',
                    ttlMs,
                    staleMs,
                    cacheKey: `${cacheKey}:${base}`,
                    timeoutMs,
                    retries,
                    retryDelayMs: 180,
                    maxBytes: 2 * 1024 * 1024,
                    allowStaleOnError: true,
                    originConcurrency: boundedInt(providerContext?.mappingOriginConcurrency, 6, 1, 32),
                    validate: payload => payload !== null && typeof payload === 'object'
                });
                caches.mapping.set(cacheKey, payload, ttlMs, staleMs, { provider, externalId, base });
                return payload;
            } catch (error) {
                lastError = error;
            }
        }

        if (cached?.value !== undefined) return cached.value;
        if (!lastError || isHttpNotFoundError(lastError)) {
            caches.negative.set(cacheKey, true, DEFAULT_NEGATIVE_TTL_MS, 0);
        }
        if (lastError && !isHttpNotFoundError(lastError)) {
            console.error('[AnimeProvider] mapping request failed:', lastError?.message || 'unknown error');
        } else if (process.env.LEVIATHAN_VERBOSE_MAPPING_MISS === '1') {
            console.warn('[AnimeProvider] mapping miss:', `${provider}/${externalId} ep=${requestedEpisode}`);
        }
        return null;
    });
}

function buildAnimeProviderContext(meta = {}) {
    const parsedId = parseExplicitRequestId(meta?.id || meta?.stremioId || meta?.videoId || '');
    return {
        id: meta?.id || meta?.stremioId || meta?.videoId || null,
        imdbId: meta?.imdb_id || meta?.imdbId || meta?.imdb || (parsedId?.provider === 'imdb' ? parsedId.externalId : null) || null,
        tmdbId: meta?.tmdb_id || meta?.tmdbId || meta?.tmdb || (parsedId?.provider === 'tmdb' ? parsedId.externalId : null) || null,
        kitsuId: meta?.kitsu_id || meta?.kitsuId || meta?.kitsu || (parsedId?.provider === 'kitsu' ? parsedId.externalId : null) || null,
        mappingLanguage: meta?.mappingLanguage || meta?.language || meta?.lang || null,
        easyCatalogsLangIt: meta?.easyCatalogsLangIt,
        italianOnly: meta?.italianOnly,
        onlyItalian: meta?.onlyItalian,
        onlyIt: meta?.onlyIt,
        type: meta?.type || meta?.contentType || parsedId?.contentType || null
    };
}

async function mapLimit(values, limit, mapper) {
    if (!Array.isArray(values) || values.length === 0) return [];
    const concurrency = Math.max(1, Math.min(Number.parseInt(String(limit || 1), 10) || 1, values.length));
    const output = new Array(values.length);
    let cursor = 0;

    async function worker() {
        while (cursor < values.length) {
            const current = cursor;
            cursor += 1;
            try {
                output[current] = await mapper(values[current], current);
            } catch (error) {
                output[current] = [];
                console.error('[AnimeProvider] task failed:', error.message);
            }
        }
    }

    await Promise.all(Array.from({ length: concurrency }, () => worker()));
    return output;
}

async function mapLimitSettled(values, limit, mapper) {
    if (!Array.isArray(values) || values.length === 0) return [];
    return mapLimit(values, limit, async (value, index) => {
        try {
            return { status: 'fulfilled', value: await mapper(value, index), index };
        } catch (error) {
            return { status: 'rejected', reason: error, index };
        }
    });
}

function normalizeTitleForSearch(value) {
    return String(value || '')
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[’']/g, '')
        .replace(/\([^)]*\)/g, ' ')
        .replace(/\[[^\]]*\]/g, ' ')
        .replace(/\b(ita|sub\s*ita|eng|multi|complete|stagione|season|s\d{1,2}|e\d{1,3})\b/gi, ' ')
        .replace(/[^a-z0-9]+/gi, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .toLowerCase();
}

function extractYear(value) {
    const match = String(value || '').match(/(?:^|\D)((?:19|20)\d{2})(?:\D|$)/);
    return match ? Number.parseInt(match[1], 10) : null;
}

function getTitleCandidates(meta = {}) {
    const values = [
        meta.name,
        meta.title,
        meta.originalTitle,
        meta.original_title,
        meta.originalName,
        meta.original_name,
        meta.englishTitle,
        meta.romajiTitle,
        meta.canonicalTitle,
        meta?.titles?.en,
        meta?.titles?.en_jp,
        meta?.titles?.ja_jp,
        meta?.titles?.it,
        ...(Array.isArray(meta.aliases) ? meta.aliases : []),
        ...(Array.isArray(meta.alternative_titles) ? meta.alternative_titles : [])
    ];
    const expanded = [];
    for (const value of values) {
        const text = String(value || '').replace(/\s+/g, ' ').trim();
        if (!text) continue;
        expanded.push(text);
        const noYear = text.replace(/\s*\((?:19|20)\d{2}\)\s*$/, '').trim();
        if (noYear && noYear !== text) expanded.push(noYear);
        const normalized = normalizeTitleForSearch(text);
        if (normalized && normalized !== text.toLowerCase()) expanded.push(normalized);
    }
    return uniqueStrings(expanded);
}

function buildStremioId(provider, externalId, season = null, episode = null) {
    const p = String(provider || '').trim().toLowerCase();
    const id = String(externalId || '').trim();
    if (!p || !id) return null;
    const s = normalizeRequestedSeason(season);
    const e = episode === null || episode === undefined ? null : normalizeRequestedEpisode(episode);
    const prefix = p === 'imdb' && /^tt\d+$/i.test(id) ? id : `${p}:${id}`;
    if (Number.isInteger(s) && Number.isInteger(e)) return `${prefix}:${s}:${e}`;
    if (p === 'kitsu' && Number.isInteger(e)) return `${prefix}:${e}`;
    return prefix;
}

function inferContentTypeFromId(id, fallback = null) {
    const parsed = parseExplicitRequestId(id);
    if (parsed?.contentType) return parsed.contentType;
    if (Number.isInteger(parsed?.seasonFromId)) return 'series';
    return fallback;
}

function normalizeStreamLanguage(value) {
    const text = String(value || '').toLowerCase();
    if (/\b(ita|italian|italiano|dub\s*ita|audio\s*ita|lingua\s*ita)\b/.test(text)) return 'it';
    if (/\b(sub\s*ita|subbed\s*ita|sottotitoli\s*ita)\b/.test(text)) return 'sub-it';
    if (/\b(eng|english|inglese)\b/.test(text)) return 'en';
    return null;
}

function scoreTitleMatch(query, candidate) {
    const q = normalizeTitleForSearch(query);
    const c = normalizeTitleForSearch(candidate);
    if (!q || !c) return 0;
    if (q === c) return 100;
    if (c.includes(q) || q.includes(c)) return 82;
    const qTokens = new Set(q.split(' ').filter(Boolean));
    const cTokens = new Set(c.split(' ').filter(Boolean));
    let overlap = 0;
    for (const token of qTokens) if (cTokens.has(token)) overlap += 1;
    const denom = Math.max(qTokens.size, cTokens.size, 1);
    return Math.round((overlap / denom) * 70);
}

function getCacheStats() {
    return {
        http: caches.http.stats(),
        mapping: caches.mapping.stats(),
        negative: caches.negative.stats(),
        inflight: caches.inflight.stats(),
        originLimiter: caches.originLimiter.stats(),
        circuitBreaker: caches.circuitBreaker.stats()
    };
}

function clearProviderUtilsCaches() {
    caches.http.clear();
    caches.mapping.clear();
    caches.negative.clear();
    caches.originLimiter.clear();
    caches.circuitBreaker.clear();
}

module.exports = {
    USER_AGENT,
    FETCH_TIMEOUT,
    DEFAULT_MAPPING_API,
    DEFAULT_HTTP_TTL_MS,
    DEFAULT_HTTP_STALE_MS,
    DEFAULT_MAPPING_TTL_MS,
    DEFAULT_MAPPING_STALE_MS,
    DEFAULT_NEGATIVE_TTL_MS,
    MAX_HTTP_CACHE,
    MAX_MAPPING_CACHE,
    MAX_INFLIGHT,
    MAX_RESPONSE_BYTES,
    DEFAULT_ORIGIN_CONCURRENCY,
    CIRCUIT_FAILURE_THRESHOLD,
    CIRCUIT_COOLDOWN_MS,
    CIRCUIT_HALF_OPEN_MAX,
    RollingMetrics,
    TtlLruCache,
    SingleFlight,
    Semaphore,
    OriginLimiter,
    CircuitBreaker,
    caches,
    getCached,
    setCached,
    uniqueStrings,
    flattenUnique,
    parsePositiveInt,
    normalizeRequestedEpisode,
    normalizeRequestedSeason,
    normalizeConfigBoolean,
    getMappingLanguage,
    toAbsoluteUrl,
    isRetryableStatus,
    isRetryableError,
    fetchWithTimeout,
    fetchResource,
    parseExplicitRequestId,
    resolveLookupRequest,
    fetchMappingPayload,
    extractTmdbIdFromMappingPayload,
    buildAnimeProviderContext,
    mapLimit,
    mapLimitSettled,
    normalizeTitleForSearch,
    extractYear,
    getTitleCandidates,
    buildStremioId,
    inferContentTypeFromId,
    normalizeStreamLanguage,
    scoreTitleMatch,
    getCacheStats,
    clearProviderUtilsCaches
};
