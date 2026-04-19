'use strict';

const express = require('express');
const cors = require('cors');
const compression = require('compression');
const rateLimit = require('express-rate-limit');
const helmet = require('helmet');
const zlib = require('zlib');
const { requestContextMiddleware } = require('../request_context');
const { incrementMetric, recordDuration } = require('../utils/runtime');
const runtimeState = require('../runtime_state');

const SMART_COMPRESSION_THRESHOLD = Math.max(512, parseInt(process.env.SMART_COMPRESSION_THRESHOLD || '1024', 10) || 1024);
const GENERAL_COMPRESSION_LEVEL = Math.max(1, Math.min(9, parseInt(process.env.HTTP_GZIP_LEVEL || '4', 10) || 4));
const GENERAL_COMPRESSION_THRESHOLD = Math.max(0, parseInt(process.env.HTTP_COMPRESSION_THRESHOLD || '1024', 10) || 1024);
const BROTLI_QUALITY = Math.max(1, Math.min(11, parseInt(process.env.HTTP_BROTLI_QUALITY || '4', 10) || 4));
const SMART_COMPRESSION_MIN_RATIO = Math.max(0.7, Math.min(0.99, Number(process.env.SMART_COMPRESSION_MIN_RATIO || '0.98') || 0.98));

function appendVary(existing, value) {
    const current = String(existing || '').trim();
    if (!current) return value;
    const values = current.split(',').map((item) => item.trim().toLowerCase()).filter(Boolean);
    if (values.includes(String(value || '').toLowerCase())) return current;
    return `${current}, ${value}`;
}

function shouldUseSmartCompression(req) {
    const method = String(req?.method || 'GET').toUpperCase();
    if (method === 'HEAD') return false;
    const pathname = String(req?.path || req?.originalUrl || '').split('?')[0];
    return pathname === '/metrics'
        || pathname === '/health'
        || pathname.startsWith('/api/')
        || pathname.endsWith('.json');
}

function chooseContentEncoding(req) {
    const header = String(req?.headers?.['accept-encoding'] || '').toLowerCase();
    if (header.includes('br')) return 'br';
    if (header.includes('gzip')) return 'gzip';
    return null;
}

function maybeSendCompressed(req, res, originalSend, body, fallbackContentType = null) {
    if (res.headersSent) return false;
    if (req.headers['x-no-compression']) return false;
    if (req.headers.range) return false;
    if (!shouldUseSmartCompression(req)) return false;
    if (res.getHeader('Content-Encoding')) return false;

    const contentType = String(res.getHeader('Content-Type') || fallbackContentType || '').toLowerCase();
    const isJson = contentType.includes('application/json');
    const isPromText = req.path === '/metrics' || contentType.startsWith('text/plain');
    if (!isJson && !isPromText) return false;

    const rawBuffer = Buffer.isBuffer(body) ? body : Buffer.from(String(body || ''), 'utf8');
    if (rawBuffer.length < SMART_COMPRESSION_THRESHOLD) return false;

    const encoding = chooseContentEncoding(req);
    if (!encoding) return false;

    let compressed = null;
    try {
        if (encoding === 'br') {
            compressed = zlib.brotliCompressSync(rawBuffer, {
                params: { [zlib.constants.BROTLI_PARAM_QUALITY]: BROTLI_QUALITY }
            });
        } else if (encoding === 'gzip') {
            compressed = zlib.gzipSync(rawBuffer, { level: GENERAL_COMPRESSION_LEVEL });
        }
    } catch (_) {
        return false;
    }

    if (!compressed || compressed.length >= Math.floor(rawBuffer.length * SMART_COMPRESSION_MIN_RATIO)) return false;

    res.setHeader('Vary', appendVary(res.getHeader('Vary'), 'Accept-Encoding'));
    res.setHeader('Content-Encoding', encoding);
    res.setHeader('Content-Length', String(compressed.length));
    if (fallbackContentType && !res.getHeader('Content-Type')) {
        res.setHeader('Content-Type', fallbackContentType);
    }
    originalSend(compressed);
    incrementMetric(`http.compression.${encoding}`);
    return true;
}

function resolveTrustProxySetting() {
    const raw = String(process.env.TRUST_PROXY || '').trim();
    if (!raw) return 1;
    if (/^(?:false|0|off|no)$/i.test(raw)) return false;
    if (/^(?:true|1|on|yes)$/i.test(raw)) return true;
    if (/^\d+$/.test(raw)) return parseInt(raw, 10);
    return raw;
}

function smartResponseCompressionMiddleware(req, res, next) {
    const originalSend = res.send.bind(res);
    const originalJson = res.json.bind(res);

    res.json = function smartJson(payload) {
        if (res.headersSent) return originalJson(payload);
        let serialized = null;
        try {
            serialized = Buffer.from(JSON.stringify(payload), 'utf8');
        } catch (_) {
            return originalJson(payload);
        }

        if (!res.getHeader('Content-Type')) {
            res.setHeader('Content-Type', 'application/json; charset=utf-8');
        }
        if (maybeSendCompressed(req, res, originalSend, serialized, 'application/json; charset=utf-8')) return res;
        return originalSend(serialized);
    };

    res.send = function smartSend(body) {
        if (res.headersSent) return originalSend(body);
        if (Buffer.isBuffer(body) || typeof body === 'string') {
            if (maybeSendCompressed(req, res, originalSend, body)) return res;
        }
        return originalSend(body);
    };

    next();
}

function applyCommonMiddleware(app, { staticDir }) {
    app.set('trust proxy', resolveTrustProxySetting());

    const RATE_LIMIT_WINDOW_MS = Math.max(60 * 1000, parseInt(process.env.RATE_LIMIT_WINDOW_MS || String(15 * 60 * 1000), 10) || (15 * 60 * 1000));
    const RATE_LIMIT_MAX = Math.max(50, parseInt(process.env.RATE_LIMIT_MAX || '350', 10) || 350);

    app.use(requestContextMiddleware);
    app.use((req, res, next) => {
        const startedAt = Date.now();
        runtimeState.beginRequest();
        incrementMetric('http.requests.total');

        if (runtimeState.shouldRejectNewRequests() && !['/health', '/metrics'].includes(req.path) && !String(req.path || '').startsWith('/admin/runtime')) {
            runtimeState.endRequest();
            res.setHeader('Retry-After', '5');
            return res.status(503).json({
                status: 'draining',
                reason: runtimeState.getSnapshot()?.lifecycle?.shutdownReason || 'shutdown',
                requestId: req.requestId || null
            });
        }

        res.on('finish', () => {
            const duration = Date.now() - startedAt;
            runtimeState.endRequest();
            recordDuration('http.request.total', duration);
            recordDuration(`http.request.${String(req.method || 'get').toLowerCase()}`, duration);
            incrementMetric(`http.status.${res.statusCode}`);
            if (res.statusCode >= 500) incrementMetric('http.errors.5xx');
            else if (res.statusCode >= 400) incrementMetric('http.errors.4xx');
        });
        next();
    });

    app.use(smartResponseCompressionMiddleware);
    app.use(compression({
        filter: (req, res) => {
            if (req.headers['x-no-compression']) return false;
            if (shouldUseSmartCompression(req)) return false;
            return compression.filter(req, res);
        },
        level: GENERAL_COMPRESSION_LEVEL,
        threshold: GENERAL_COMPRESSION_THRESHOLD
    }));

    const limiter = rateLimit({
        windowMs: RATE_LIMIT_WINDOW_MS,
        max: RATE_LIMIT_MAX,
        standardHeaders: true,
        legacyHeaders: false,
        message: 'Troppe richieste da questo IP, riprova più tardi.'
    });

    app.use(limiter);
    app.use(cors());
    app.use(helmet({
        contentSecurityPolicy: false,
        crossOriginEmbedderPolicy: false,
        crossOriginResourcePolicy: false,
        hsts: process.env.NODE_ENV === 'production'
    }));
    app.use((req, res, next) => {
        res.setHeader('Referrer-Policy', 'no-referrer');
        next();
    });
    app.use(express.json({ limit: process.env.JSON_LIMIT || '64kb' }));
    app.use(express.urlencoded({ extended: false, limit: process.env.URLENCODED_LIMIT || '32kb' }));
    app.use(express.static(staticDir));
}

module.exports = { applyCommonMiddleware };
