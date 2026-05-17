'use strict';

const { evaluateExpression } = require('../policies/stream_expression');

const recentPrecache = new Map();

function envFlag(name, fallback = false) {
    const raw = process.env[name];
    if (raw === undefined || raw === null || raw === '') return fallback;
    return /^(1|true|yes|y|on)$/i.test(String(raw).trim());
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
    return String(item.url || item.externalDirectUrl || item.directUrl || item.streamUrl || '').trim();
}

function isSafeUrl(url) {
    if (!/^https?:\/\//i.test(url)) return false;
    if (/\/play_lazy\//i.test(url)) return false;
    if (/magnet:/i.test(url)) return false;
    return true;
}

function getDedupeKey(url) {
    return String(url || '').replace(/[?&](token|apikey|api_key|access_token|auth|key)=[^&]+/gi, '$1=redacted').slice(0, 500);
}

async function pingUrl(url, timeoutMs, logger) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    if (typeof timer.unref === 'function') timer.unref();

    try {
        let res = await fetch(url, {
            method: 'HEAD',
            redirect: 'follow',
            signal: controller.signal,
            headers: {
                'user-agent': process.env.RUST_SHIELD_USER_AGENT || 'Mozilla/5.0',
                'accept': '*/*'
            }
        });

        if ([405, 403, 404].includes(res.status)) {
            res = await fetch(url, {
                method: 'GET',
                redirect: 'follow',
                signal: controller.signal,
                headers: {
                    'range': 'bytes=0-0',
                    'user-agent': process.env.RUST_SHIELD_USER_AGENT || 'Mozilla/5.0',
                    'accept': '*/*'
                }
            });
        }

        return { ok: res.status >= 200 && res.status < 500, status: res.status };
    } catch (error) {
        if (logger && typeof logger.debug === 'function') logger.debug(`[PRECACHE] ping failed | ${error.message}`);
        return { ok: false, status: 0, error: error.message };
    } finally {
        clearTimeout(timer);
    }
}

function queueSelectedStreamPrecache(items = [], options = {}) {
    if (!envFlag('LEVIATHAN_PRECACHE_SELECTOR_ENABLED', false)) return { queued: 0, reason: 'disabled' };

    const list = Array.isArray(items) ? items : [];
    if (list.length === 0) return { queued: 0, reason: 'empty' };

    const logger = options.logger;
    const selector = String(
        options.selector ||
        options.config?.filters?.precacheSelector ||
        process.env.LEVIATHAN_PRECACHE_SELECTOR ||
        'cached && http && !lazy && rank <= 1'
    ).trim();

    const max = Math.max(0, Math.min(5, parseInt(
        options.config?.filters?.precacheMaxPerRequest ??
        process.env.LEVIATHAN_PRECACHE_MAX_PER_REQUEST ??
        '1',
        10
    ) || 1));

    if (max <= 0) return { queued: 0, reason: 'max_zero' };

    const timeoutMs = Math.max(250, Math.min(5000, parseInt(process.env.LEVIATHAN_PRECACHE_TIMEOUT_MS || '1200', 10) || 1200));
    const ttlMs = Math.max(30_000, Math.min(900_000, parseInt(process.env.LEVIATHAN_PRECACHE_DEDUPE_TTL_MS || '180000', 10) || 180000));

    cleanup();

    const selected = [];
    for (let i = 0; i < list.length && selected.length < max; i += 1) {
        const item = list[i];
        const url = getUrl(item);
        if (!isSafeUrl(url)) continue;
        if (!evaluateExpression(selector, item, options.meta || {}, { rank: i + 1, logger })) continue;

        const key = getDedupeKey(url);
        if (recentPrecache.has(key)) continue;
        recentPrecache.set(key, Date.now() + ttlMs);
        selected.push({ item, url, rank: i + 1 });
    }

    if (selected.length === 0) return { queued: 0, reason: 'no_match' };

    const delay = Math.max(0, Math.min(2000, parseInt(process.env.LEVIATHAN_PRECACHE_DELAY_MS || '120', 10) || 120));
    const timer = setTimeout(() => {
        selected.forEach(async ({ url, rank }) => {
            const started = Date.now();
            const result = await pingUrl(url, timeoutMs, logger);
            if (logger && typeof logger.info === 'function') {
                logger.info(`[PRECACHE] rank=${rank} status=${result.status} ok=${result.ok} ms=${Date.now() - started}`);
            }
        });
    }, delay);
    if (typeof timer.unref === 'function') timer.unref();

    if (logger && typeof logger.info === 'function') {
        logger.info(`[PRECACHE] queued=${selected.length} selector="${selector.slice(0, 120)}"`);
    }

    return { queued: selected.length, reason: 'queued' };
}

module.exports = {
    queueSelectedStreamPrecache
};
