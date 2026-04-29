const util = require('util');
const winston = require('winston');
const { getRequestContext } = require('../request_context');
const { redactLogInfo, sanitizeRequestPath } = require('./redaction');

function enrichWithRequestContext(info) {
    const context = getRequestContext();
    if (context?.requestId && !info.requestId) info.requestId = context.requestId;
    if (context?.method && !info.method) info.method = context.method;
    if (context?.path && !info.path) info.path = sanitizeRequestPath(context.path);
    return info;
}


const CONSOLE_LEVELS = {
    log: 'info',
    info: 'info',
    warn: 'warn',
    error: 'error',
    debug: 'debug',
    trace: 'debug'
};
const CONSOLE_BRIDGE_FLAG = Symbol.for('leviathan.consoleBridgeInstalled');
const CONSOLE_ORIGINALS_FLAG = Symbol.for('leviathan.consoleOriginals');

function formatConsoleArgs(args) {
    return util.formatWithOptions({ colors: false, depth: 6, breakLength: 120 }, ...args);
}

function installConsoleBridge(targetLogger = logger) {
    if (!targetLogger || globalThis[CONSOLE_BRIDGE_FLAG]) return false;

    const originals = {};
    for (const method of Object.keys(CONSOLE_LEVELS)) {
        const original = console[method];
        originals[method] = typeof original === 'function' ? original.bind(console) : null;
        console[method] = (...args) => {
            const level = CONSOLE_LEVELS[method] || 'info';
            const message = formatConsoleArgs(args);
            targetLogger.log({ level, message, source: 'console' });
        };
    }
    globalThis[CONSOLE_ORIGINALS_FLAG] = originals;
    globalThis[CONSOLE_BRIDGE_FLAG] = true;
    return true;
}

function serializeExtraFields(info) {
    const reserved = new Set(['level', 'message', 'timestamp', 'requestId', 'method', 'path']);
    const extras = Object.entries(info)
        .filter(([key]) => !reserved.has(key))
        .reduce((acc, [key, value]) => {
            acc[key] = value;
            return acc;
        }, {});
    return Object.keys(extras).length > 0 ? ` ${JSON.stringify(extras)}` : '';
}

const logger = winston.createLogger({
    level: process.env.LOG_LEVEL || 'debug',
    format: winston.format.combine(
        winston.format((info) => enrichWithRequestContext(info))(),
        winston.format((info) => redactLogInfo(info))(),
        winston.format.timestamp(),
        winston.format.json()
    ),
    transports: [
        new winston.transports.File({ filename: 'error.log', level: 'error' }),
        new winston.transports.File({ filename: 'combined.log' }),
        new winston.transports.Console({
            format: winston.format.combine(
                winston.format((info) => enrichWithRequestContext(info))(),
                winston.format((info) => redactLogInfo(info))(),
                winston.format.timestamp(),
                winston.format.printf((info) => {
                    const reqPart = info.requestId ? ` [req:${info.requestId}]` : '';
                    const routePart = info.method && info.path ? ` ${info.method} ${info.path}` : '';
                    return `${info.timestamp} ${info.level}:${reqPart}${routePart} ${info.message}${serializeExtraFields(info)}`;
                })
            )
        })
    ]
});

const runtimeMetrics = {
    startedAt: Date.now(),
    counters: Object.create(null),
    timers: Object.create(null),
    providers: Object.create(null),
    cache: {
        stream: { hit: 0, miss: 0, set: 0 },
        metadata: { hit: 0, miss: 0, set: 0 },
        lazy: { hit: 0, miss: 0, set: 0 },
        cloud: { hit: 0, miss: 0, set: 0 },
        raw: { hit: 0, miss: 0, set: 0 },
        dbLookup: { hit: 0, miss: 0, set: 0 }
    }
};

function incrementMetric(name, value = 1) {
    runtimeMetrics.counters[name] = (runtimeMetrics.counters[name] || 0) + value;
}

function recordDuration(name, ms) {
    if (!Number.isFinite(ms) || ms < 0) return;
    const bucket = runtimeMetrics.timers[name] || { count: 0, totalMs: 0, minMs: Number.POSITIVE_INFINITY, maxMs: 0, avgMs: 0 };
    bucket.count += 1;
    bucket.totalMs += ms;
    bucket.minMs = Math.min(bucket.minMs, ms);
    bucket.maxMs = Math.max(bucket.maxMs, ms);
    bucket.avgMs = Math.round((bucket.totalMs / bucket.count) * 100) / 100;
    runtimeMetrics.timers[name] = bucket;
}

function recordProviderMetric(provider, ok, ms = null, extra = null) {
    const key = String(provider || 'unknown');
    const bucket = runtimeMetrics.providers[key] || { calls: 0, ok: 0, fail: 0, timeout: 0, totalMs: 0, avgMs: 0, lastError: null, lastSeenAt: null };
    bucket.calls += 1;
    if (ok) bucket.ok += 1;
    else bucket.fail += 1;
    if (Number.isFinite(ms) && ms >= 0) {
        bucket.totalMs += ms;
        bucket.avgMs = Math.round((bucket.totalMs / bucket.calls) * 100) / 100;
    }
    if (extra && extra.timeout) bucket.timeout += 1;
    if (extra && extra.error) bucket.lastError = String(extra.error).slice(0, 300);
    bucket.lastSeenAt = new Date().toISOString();
    runtimeMetrics.providers[key] = bucket;
}

function registerCacheAccess(section, hit) {
    const bucket = runtimeMetrics.cache[section];
    if (!bucket) return;
    if (hit) bucket.hit += 1;
    else bucket.miss += 1;
}

function registerCacheSet(section) {
    const bucket = runtimeMetrics.cache[section];
    if (!bucket) return;
    bucket.set += 1;
}

function getCacheSnapshot(bucket) {
    const hits = Number(bucket?.hit || 0);
    const misses = Number(bucket?.miss || 0);
    const total = hits + misses;
    return {
        hit: hits,
        miss: misses,
        set: Number(bucket?.set || 0),
        hitRate: total > 0 ? Math.round((hits / total) * 10000) / 100 : 0
    };
}

module.exports = {
    logger,
    installConsoleBridge,
    runtimeMetrics,
    incrementMetric,
    recordDuration,
    recordProviderMetric,
    registerCacheAccess,
    registerCacheSet,
    getCacheSnapshot
};
