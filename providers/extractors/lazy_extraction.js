'use strict';

const crypto = require('crypto');
const axios = require('axios');
const { buildWebStream, normalizeQuality } = require('./common');
const { extractFromUrl, resolveExtractorDefinition } = require('./registry');
const { classifyProviderError, formatProviderError } = require('../utils/provider_errors');
const { probePlaylistIntelligence } = require('../utils/playlist_intelligence');

const TOKEN_VERSION = 1;
const DEFAULT_TTL_MS = Math.max(60_000, Number.parseInt(process.env.LAZY_EXTRACT_TTL_MS || String(6 * 60 * 60 * 1000), 10) || (6 * 60 * 60 * 1000));
const MAX_URL_LEN = 4096;

function envFlag(name, fallback = false) {
    const value = process.env[name];
    if (value === undefined || value === null || value === '') return fallback;
    return /^(1|true|yes|on)$/i.test(String(value).trim());
}

function isLazyExtractionEnabled(provider = '') {
    const key = String(provider || '').replace(/[^A-Z0-9]+/gi, '_').toUpperCase();
    if (process.env[`${key}_LAZY_EXTRACTION`] !== undefined) return envFlag(`${key}_LAZY_EXTRACTION`, true);
    return envFlag('PROVIDER_LAZY_EXTRACTION', true);
}

function base64url(input) {
    return Buffer.from(input).toString('base64url');
}

function fromBase64url(input) {
    return Buffer.from(String(input || ''), 'base64url').toString('utf8');
}

function getSecret() {
    return String(process.env.LAZY_EXTRACT_SECRET || process.env.ADMIN_PASS || process.env.LEVI_NODE_ID || 'leviathan-local-lazy-secret');
}

function signPayload(payload) {
    return crypto.createHmac('sha256', getSecret()).update(payload).digest('base64url');
}

function safeJsonParse(text) {
    try { return JSON.parse(text); } catch (_) { return null; }
}

function normalizeHeaders(headers = {}) {
    const out = {};
    if (!headers || typeof headers !== 'object' || Array.isArray(headers)) return out;
    for (const [key, value] of Object.entries(headers)) {
        if (value === undefined || value === null || value === '') continue;
        const name = String(key || '').trim();
        if (!name || /^cookie$/i.test(name)) continue;
        out[name] = String(value);
    }
    return out;
}

function encodeLazyExtractionToken(payload = {}) {
    const normalized = {
        v: TOKEN_VERSION,
        iat: Date.now(),
        exp: Date.now() + DEFAULT_TTL_MS,
        url: String(payload.url || '').slice(0, MAX_URL_LEN),
        provider: String(payload.provider || 'web'),
        providerCode: String(payload.providerCode || payload.provider || 'WEB'),
        extractor: String(payload.extractor || payload.name || 'Hoster'),
        title: String(payload.title || ''),
        quality: normalizeQuality(payload.quality || 'Unknown'),
        referer: String(payload.referer || payload.requestReferer || ''),
        headers: normalizeHeaders(payload.headers || {})
    };
    const body = base64url(JSON.stringify(normalized));
    const sig = signPayload(body);
    return `${body}.${sig}`;
}

function decodeLazyExtractionToken(token) {
    const [body, sig] = String(token || '').split('.');
    if (!body || !sig) throw new Error('lazy_token_malformed');
    const expected = signPayload(body);
    const a = Buffer.from(sig);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) throw new Error('lazy_token_bad_signature');
    const payload = safeJsonParse(fromBase64url(body));
    if (!payload || payload.v !== TOKEN_VERSION) throw new Error('lazy_token_bad_payload');
    if (Number(payload.exp || 0) < Date.now()) throw new Error('lazy_token_expired');
    if (!/^https?:\/\//i.test(String(payload.url || ''))) throw new Error('lazy_token_bad_url');
    return payload;
}

function makeLazyUrl(reqHost, token) {
    const base = String(reqHost || '').replace(/\/+$/, '');
    if (base) return `${base}/lazy_extract/${encodeURIComponent(token)}`;
    return `/lazy_extract/${encodeURIComponent(token)}`;
}

function hostLabel(url, fallback = 'Hoster') {
    try {
        const host = new URL(String(url || '')).hostname.replace(/^www\./i, '').toLowerCase();
        const first = host.split('.')[0] || host;
        return first ? first.charAt(0).toUpperCase() + first.slice(1) : fallback;
    } catch (_) {
        return fallback;
    }
}

function buildLazyExtractorStream({
    embedUrl,
    reqHost,
    provider = 'Web',
    providerCode = 'WEB',
    title = 'Lazy extraction',
    name = null,
    quality = 'Unknown',
    referer = '',
    headers = {},
    extraBehaviorHints = {},
    extra = {}
} = {}) {
    if (!embedUrl || !isLazyExtractionEnabled(provider)) return null;
    const definition = resolveExtractorDefinition(embedUrl);
    if (!definition) return null;
    const extractorName = name || definition.label || hostLabel(embedUrl);
    const token = encodeLazyExtractionToken({
        url: embedUrl,
        provider,
        providerCode,
        extractor: extractorName,
        title,
        quality,
        referer,
        headers
    });
    const url = makeLazyUrl(reqHost, token);
    return buildWebStream({
        name: `${provider} | ${extractorName} Lazy`,
        title: `${title}\n⚡ Lazy extraction • ${extractorName}`,
        url,
        extractor: `${extractorName} Lazy`,
        provider,
        providerCode,
        quality,
        headers: null,
        notWebReady: false,
        extraBehaviorHints: {
            ...extraBehaviorHints,
            lazyExtraction: true,
            vortexMeta: {
                ...(extraBehaviorHints?.vortexMeta || {}),
                lazyExtraction: true,
                lazyHoster: extractorName,
                lazySourceUrl: embedUrl
            }
        },
        extra: {
            ...extra,
            _priority: extra._priority ?? definition.priority ?? 9
        }
    });
}

async function resolveLazyExtractionToken(token, options = {}) {
    const payload = decodeLazyExtractionToken(token);
    const started = Date.now();
    const headers = normalizeHeaders({
        Referer: payload.referer,
        ...(payload.headers || {})
    });
    const client = options.client || axios.create({
        timeout: Number.parseInt(process.env.LAZY_EXTRACT_TIMEOUT_MS || '12000', 10) || 12000,
        maxRedirects: 5,
        decompress: true,
        proxy: false,
        validateStatus: (status) => status >= 200 && status < 400
    });
    try {
        const extracted = await extractFromUrl(payload.url, {
            client,
            userAgent: headers['User-Agent'] || headers['user-agent'] || process.env.LAZY_EXTRACT_USER_AGENT,
            requestReferer: headers.Referer || headers.referer || payload.referer,
            referer: headers.Referer || headers.referer || payload.referer
        });
        const items = Array.isArray(extracted) ? extracted : (extracted ? [extracted] : []);
        const playable = items.find((item) => item?.url) || null;
        if (!playable?.url) {
            const error = new Error('lazy_extractor_empty');
            error.statusCode = 404;
            throw error;
        }

        let intelligence = null;
        if (/\.m3u8(?:$|[?#])/i.test(String(playable.url || ''))) {
            intelligence = await probePlaylistIntelligence(client, playable.url, {
                headers: playable.headers || headers,
                timeout: Number.parseInt(process.env.LAZY_EXTRACT_PLAYLIST_TIMEOUT_MS || '5000', 10) || 5000
            }).catch(() => null);
        }

        return {
            ok: true,
            url: playable.url,
            headers: playable.headers || {},
            quality: intelligence?.quality || playable.quality || payload.quality || 'Unknown',
            audioLanguages: intelligence?.audioLanguages || [],
            subtitleLanguages: intelligence?.subtitleLanguages || [],
            provider: payload.provider,
            extractor: playable.extractor || playable.name || payload.extractor,
            ms: Date.now() - started
        };
    } catch (error) {
        const classified = classifyProviderError(error);
        error.lazyExtraction = {
            provider: payload.provider,
            extractor: payload.extractor,
            classified,
            line: formatProviderError(payload.provider, error, { classified, url: payload.url, ms: Date.now() - started })
        };
        throw error;
    }
}

function registerLazyExtractionRoute(app, { logger = console } = {}) {
    app.get('/lazy_extract/:token', async (req, res) => {
        const started = Date.now();
        try {
            const result = await resolveLazyExtractionToken(req.params.token);
            if (process.env.LAZY_EXTRACT_DEBUG === '1') {
                logger.info?.(`[LAZY EXTRACT] ok provider=${result.provider} extractor=${result.extractor} quality=${result.quality} ms=${Date.now() - started}`);
            }
            res.set('Cache-Control', 'private, max-age=120');
            return res.redirect(302, result.url);
        } catch (error) {
            const line = error?.lazyExtraction?.line || formatProviderError('lazy_extract', error, { ms: Date.now() - started });
            logger.warn?.(line);
            return res.status(Number(error.statusCode || error.status || 502)).send('Lazy extraction non riuscita: link hoster non risolto o scaduto.');
        }
    });
}

module.exports = {
    buildLazyExtractorStream,
    decodeLazyExtractionToken,
    encodeLazyExtractionToken,
    isLazyExtractionEnabled,
    registerLazyExtractionRoute,
    resolveLazyExtractionToken
};
