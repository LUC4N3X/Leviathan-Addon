'use strict';

const { evaluateExpression } = require('../policies/stream_expression');

const recentPrecache = new Map();

const DEFAULT_SELECTOR = 'cached && http && !lazy && rank <= 1';
const DEFAULT_USER_AGENT = 'Mozilla/5.0';
const SENSITIVE_QUERY_KEYS = new Set([
    'token',
    'apikey',
    'api_key',
    'access_token',
    'auth',
    'key',
    'signature',
    'sig',
    'expires',
    'expire',
    'policy',
    'credential'
]);

function envFlag(name, fallback = false) {
    const raw = process.env[name];
    if (raw === undefined || raw === null || raw === '') return fallback;
    return /^(1|true|yes|y|on)$/i.test(String(raw).trim());
}

function boundedInt(value, fallback, min, max) {
    const parsed = Number.parseInt(String(value ?? ''), 10);
    const safe = Number.isFinite(parsed) ? parsed : fallback;
    return Math.max(min, Math.min(max, safe));
}

function log(logger, level, message) {
    if (logger && typeof logger[level] === 'function') logger[level](message);
}

function cleanup(now = Date.now()) {
    for (const [key, expiresAt] of recentPrecache.entries()) {
        if (!expiresAt || expiresAt <= now) recentPrecache.delete(key);
    }

    while (recentPrecache.size > 1000) {
        recentPrecache.delete(recentPrecache.keys().next().value);
    }
}

function getUrl(item = {}) {
    if (!item || typeof item !== 'object') return '';
    return String(item.url || item.externalDirectUrl || item.directUrl || item.streamUrl || '').trim();
}

function isPrivateHostname(hostname = '') {
    const host = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '');
    if (!host) return true;
    if (host === 'localhost' || host.endsWith('.localhost')) return true;
    if (host === '0.0.0.0' || host === '::' || host === '::1') return true;
    if (/^127\./.test(host)) return true;
    if (/^10\./.test(host)) return true;
    if (/^192\.168\./.test(host)) return true;
    if (/^169\.254\./.test(host)) return true;
    if (/^172\.(1[6-9]|2\d|3[0-1])\./.test(host)) return true;
    if (/^(fc|fd)[0-9a-f]{2}:/i.test(host)) return true;
    if (/^fe80:/i.test(host)) return true;
    return false;
}

function isSafeUrl(url) {
    const raw = String(url || '').trim();
    if (!raw || /magnet:/i.test(raw) || /\/play_lazy\//i.test(raw)) return false;

    try {
        const parsed = new URL(raw);
        if (!['http:', 'https:'].includes(parsed.protocol)) return false;
        if (!parsed.hostname || isPrivateHostname(parsed.hostname)) return false;
        return true;
    } catch (_) {
        return false;
    }
}

function getDedupeKey(url) {
    const raw = String(url || '').trim();
    if (!raw) return '';

    try {
        const parsed = new URL(raw);
        for (const key of [...parsed.searchParams.keys()]) {
            if (SENSITIVE_QUERY_KEYS.has(String(key).toLowerCase())) parsed.searchParams.set(key, 'redacted');
        }
        return parsed.toString().slice(0, 500);
    } catch (_) {
        return raw.replace(/([?&])([^=&#]+)=([^&#]*)/g, (match, prefix, key) => {
            return SENSITIVE_QUERY_KEYS.has(String(key).toLowerCase()) ? `${prefix}${key}=redacted` : match;
        }).slice(0, 500);
    }
}

function buildHeaders(userAgent, extra = {}) {
    return {
        'user-agent': userAgent || process.env.RUST_SHIELD_USER_AGENT || DEFAULT_USER_AGENT,
        'accept': '*/*',
        ...extra
    };
}

async function fetchOnce(fetchImpl, url, init) {
    if (typeof fetchImpl !== 'function') throw new Error('fetch_unavailable');
    return fetchImpl(url, init);
}

async function pingUrl(url, timeoutMs, logger, options = {}) {
    const fetchImpl = options.fetchImpl || globalThis.fetch;
    if (typeof fetchImpl !== 'function') return { ok: false, status: 0, error: 'fetch_unavailable' };
    if (typeof AbortController !== 'function') return { ok: false, status: 0, error: 'abort_controller_unavailable' };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    if (typeof timer.unref === 'function') timer.unref();

    const common = {
        redirect: 'follow',
        signal: controller.signal,
        headers: buildHeaders(options.userAgent)
    };

    try {
        let response = await fetchOnce(fetchImpl, url, {
            ...common,
            method: 'HEAD'
        });

        if ([405, 403, 404].includes(Number(response.status))) {
            response = await fetchOnce(fetchImpl, url, {
                ...common,
                method: 'GET',
                headers: buildHeaders(options.userAgent, { range: 'bytes=0-0' })
            });
        }

        const status = Number(response.status || 0);
        return { ok: status >= 200 && status < 500, status };
    } catch (error) {
        const message = error?.name === 'AbortError' ? 'timeout' : (error?.message || String(error));
        log(logger, 'debug', `[PRECACHE] ping failed | ${message}`);
        return { ok: false, status: 0, error: message };
    } finally {
        clearTimeout(timer);
    }
}

function resolveSelector(options = {}) {
    const raw = String(
        options.selector ||
        options.config?.filters?.precacheSelector ||
        process.env.LEVIATHAN_PRECACHE_SELECTOR ||
        DEFAULT_SELECTOR
    ).trim();

    return raw || DEFAULT_SELECTOR;
}

function shouldSelectItem(selector, item, meta, rank, logger) {
    try {
        return Boolean(evaluateExpression(selector, item, meta, { rank, logger }));
    } catch (error) {
        log(logger, 'debug', `[PRECACHE] selector failed | ${error?.message || String(error)}`);
        return false;
    }
}

function queueSelectedStreamPrecache(items = [], options = {}) {
    if (!envFlag('LEVIATHAN_PRECACHE_SELECTOR_ENABLED', false)) return { queued: 0, reason: 'disabled' };

    const list = Array.isArray(items) ? items : [];
    if (!list.length) return { queued: 0, reason: 'empty' };

    const logger = options.logger;
    const selector = resolveSelector(options);
    const max = boundedInt(
        options.config?.filters?.precacheMaxPerRequest ?? process.env.LEVIATHAN_PRECACHE_MAX_PER_REQUEST,
        1,
        0,
        5
    );

    if (max <= 0) return { queued: 0, reason: 'max_zero' };

    const timeoutMs = boundedInt(process.env.LEVIATHAN_PRECACHE_TIMEOUT_MS, 1200, 250, 5000);
    const ttlMs = boundedInt(process.env.LEVIATHAN_PRECACHE_DEDUPE_TTL_MS, 180000, 30_000, 900_000);
    const now = Date.now();

    cleanup(now);

    const selected = [];
    for (let index = 0; index < list.length && selected.length < max; index += 1) {
        const item = list[index];
        const rank = index + 1;
        const url = getUrl(item);
        if (!isSafeUrl(url)) continue;
        if (!shouldSelectItem(selector, item, options.meta || {}, rank, logger)) continue;

        const key = getDedupeKey(url);
        if (!key || recentPrecache.has(key)) continue;

        recentPrecache.set(key, now + ttlMs);
        selected.push({ url, rank });
    }

    if (!selected.length) return { queued: 0, reason: 'no_match' };

    const delay = boundedInt(process.env.LEVIATHAN_PRECACHE_DELAY_MS, 120, 0, 2000);
    const timer = setTimeout(() => {
        Promise.allSettled(selected.map(async ({ url, rank }) => {
            const started = Date.now();
            const result = await pingUrl(url, timeoutMs, logger, {
                fetchImpl: options.fetchImpl,
                userAgent: options.userAgent
            });
            log(logger, 'info', `[PRECACHE] rank=${rank} status=${result.status} ok=${result.ok} ms=${Date.now() - started}`);
        })).catch(error => {
            log(logger, 'debug', `[PRECACHE] batch failed | ${error?.message || String(error)}`);
        });
    }, delay);

    if (typeof timer.unref === 'function') timer.unref();
    log(logger, 'info', `[PRECACHE] queued=${selected.length} selector="${selector.slice(0, 120)}"`);

    return { queued: selected.length, reason: 'queued' };
}

module.exports = {
    queueSelectedStreamPrecache
};
