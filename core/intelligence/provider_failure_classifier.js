'use strict';

const { detectAntibot } = require('../../providers/utils/antibot_signatures');

const LEGACY_ANTIBOT_RE = /cloudflare|cf-chl|captcha|attention required|verify you are human|just a moment|access denied|ddos-guard|checking your browser/i;
const HTML_BODY_RE = /<!doctype\s+html|<html[\s>]|<body[\s>]|<a\s|<article\s|<main\s|<div\s/i;
const SEARCHABLE_LINK_RE = /<a\s[^>]*href\s*=/gi;
const ARTICLE_RE = /<article\b/gi;

const MAX_DETECT_BODY_CHARS = 512 * 1024;

function toSafeString(value = '') {
    if (typeof value === 'string') return value;
    if (Buffer.isBuffer(value)) return value.toString('utf8');

    if (value instanceof ArrayBuffer) {
        return Buffer.from(value).toString('utf8');
    }

    if (ArrayBuffer.isView(value)) {
        return Buffer.from(value.buffer, value.byteOffset, value.byteLength).toString('utf8');
    }

    if (value === null || typeof value === 'undefined') return '';

    if (typeof value === 'object') {
        try {
            return JSON.stringify(value);
        } catch (_) {
            return '';
        }
    }

    return String(value);
}

function cleanToken(value = '') {
    return String(value || '')
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9_-]+/g, '_')
        .replace(/^_+|_+$/g, '');
}

function isKnownVendor(vendor = '') {
    const value = cleanToken(vendor);
    return Boolean(value && value !== 'none' && value !== 'unknown');
}

function getStatus(errorOrResponse = null) {
    const candidates = [
        errorOrResponse?.status,
        errorOrResponse?.statusCode,
        errorOrResponse?.response?.status,
        errorOrResponse?.response?.statusCode,
        errorOrResponse?.data?.status,
        errorOrResponse?.data?.statusCode
    ];

    for (const candidate of candidates) {
        const status = Number(candidate);
        if (Number.isFinite(status) && status > 0) return status;
    }

    return 0;
}

function getHeaders(source = null) {
    return (
        source?.headers
        || source?.response?.headers
        || source?.data?.headers
        || null
    );
}

function normalizeHeaders(headers = null) {
    if (!headers || typeof headers !== 'object') return null;

    const normalized = {};

    for (const [key, value] of Object.entries(headers)) {
        if (!key) continue;

        const normalizedKey = String(key).toLowerCase();

        if (Array.isArray(value)) {
            normalized[normalizedKey] = value.map((item) => String(item)).join(', ');
        } else if (typeof value !== 'undefined' && value !== null) {
            normalized[normalizedKey] = String(value);
        }
    }

    return normalized;
}

function getBody(response = null) {
    const value = (
        response?.data
        ?? response?.body
        ?? response?.text
        ?? response?.content
        ?? response?.html
        ?? response?.response?.data
        ?? response?.response?.body
        ?? response?.response?.text
        ?? response
    );

    return toSafeString(value);
}

function safeDetectAntibot(body = '', status = 0, headers = null) {
    const text = toSafeString(body).slice(0, MAX_DETECT_BODY_CHARS);

    try {
        const detection = detectAntibot(text, status, headers) || {};

        return {
            blocked: Boolean(detection.blocked),
            vendor: detection.vendor || 'none',
            kind: detection.kind || 'unknown',
            reason: detection.reason || detection.signature || null,
            confidence: detection.confidence ?? null
        };
    } catch (error) {
        return {
            blocked: false,
            vendor: 'none',
            kind: 'unknown',
            reason: `detector_error:${error?.message || 'unknown'}`,
            confidence: null
        };
    }
}

function isMeaningfulAntibotDetection(detection = null) {
    if (!detection?.blocked) return false;

    const vendor = cleanToken(detection.vendor);
    const kind = cleanToken(detection.kind);

    return (
        vendor === 'cloudflare'
        || vendor === 'ddos_guard'
        || vendor === 'datadome'
        || vendor === 'imperva'
        || vendor === 'akamai'
        || kind === 'waf'
        || kind === 'turnstile'
        || kind === 'managed_challenge'
        || kind === 'captcha'
        || kind === 'challenge'
        || kind === 'browser_check'
        || isKnownVendor(vendor)
    );
}

function getAntibotInfo(body = '', status = 0, headers = null) {
    const text = toSafeString(body);
    const legacyBlocked = LEGACY_ANTIBOT_RE.test(text);
    const detection = safeDetectAntibot(text, status, headers);
    const detectedBlocked = isMeaningfulAntibotDetection(detection);
    const blocked = Boolean(legacyBlocked || detectedBlocked);

    const vendor = isKnownVendor(detection.vendor) ? cleanToken(detection.vendor) : 'unknown';
    const kind = cleanToken(detection.kind) || 'unknown';

    return {
        blocked,
        legacyBlocked,
        detection,
        vendor,
        kind,
        reason: blocked && vendor !== 'unknown' ? `antibot_${vendor}` : 'anti_bot_blocked',
        details: blocked
            ? {
                vendor,
                kind,
                legacy: legacyBlocked,
                detectorReason: detection.reason || null,
                confidence: detection.confidence
            }
            : undefined
    };
}

function hasAntiBotBody(body = '') {
    const info = getAntibotInfo(body, 0, null);
    return info.blocked;
}

function hasHtmlBody(body = '') {
    return HTML_BODY_RE.test(toSafeString(body));
}

function hasSearchableLinks(body = '') {
    const html = toSafeString(body);
    const anchors = (html.match(SEARCHABLE_LINK_RE) || []).length;
    const articles = (html.match(ARTICLE_RE) || []).length;

    return anchors >= 3 || articles >= 1;
}

function isTimeout(error = null) {
    const code = String(error?.code || error?.cause?.code || '').toUpperCase();
    const name = String(error?.name || '').toUpperCase();
    const message = String(error?.message || error || '');

    return (
        code === 'ETIMEDOUT'
        || code === 'ECONNABORTED'
        || code === 'UND_ERR_CONNECT_TIMEOUT'
        || code === 'UND_ERR_HEADERS_TIMEOUT'
        || code === 'ERR_SOCKET_CONNECTION_TIMEOUT'
        || name === 'ABORTERROR'
        || /timeout|timed\s*out|aborted/i.test(message)
    );
}

function isNetworkError(error = null) {
    const code = String(error?.code || error?.cause?.code || '').toUpperCase();

    return [
        'ECONNRESET',
        'ENOTFOUND',
        'EAI_AGAIN',
        'ECONNREFUSED',
        'EHOSTUNREACH',
        'ENETUNREACH',
        'UND_ERR_SOCKET',
        'UND_ERR_CONNECT_TIMEOUT'
    ].includes(code);
}

function getResultCount(rawResults = []) {
    if (Array.isArray(rawResults)) return rawResults.length;
    if (rawResults instanceof Map || rawResults instanceof Set) return rawResults.size;
    if (rawResults && typeof rawResults === 'object' && Number.isFinite(Number(rawResults.length))) {
        return Number(rawResults.length);
    }
    return rawResults ? 1 : 0;
}

function normalizeFailureType(type = '') {
    const value = cleanToken(type);

    if (!value) return 'unknown';

    if ([
        '403',
        '401',
        'blocked_cf',
        'cloudflare_block',
        'cloudflare_blocked',
        'captcha',
        'challenge',
        'antibot',
        'anti_bot',
        'anti_bot_blocked'
    ].includes(value)) {
        return 'blocked';
    }

    if (['429', 'rate_limited', 'ratelimited', 'too_many_requests'].includes(value)) {
        return 'rate_limited';
    }

    if (['408', 'timeout', 'request_timeout', 'connect_timeout', 'headers_timeout'].includes(value)) {
        return 'timeout';
    }

    if (['404', 'not_found', 'missing'].includes(value)) {
        return 'not_found';
    }

    if (['500', '502', '503', '504', 'upstream', 'upstream_error', 'server_error'].includes(value)) {
        return 'upstream_error';
    }

    if (['selector_miss', 'layout_changed'].includes(value)) {
        return value;
    }

    if (['empty', 'empty_result', 'empty_results', 'no_results'].includes(value)) {
        return 'empty_results';
    }

    return value || 'unknown';
}

function makeBlockedFailure({
    status = 0,
    isError = false,
    antibotInfo = null
} = {}) {
    const reason = status === 403
        ? 'http_403_blocked'
        : status === 401 && !antibotInfo?.blocked
            ? 'http_401_unauthorized'
            : antibotInfo?.reason || 'anti_bot_blocked';

    return {
        type: 'blocked',
        reason,
        status,
        recoverable: false,
        canFallback: true,
        isError,
        details: antibotInfo?.details
    };
}

function classifyProviderFailure({
    error = null,
    response = null,
    rawResults = [],
    recipe = {},
    context = {},
    request = null
} = {}) {
    const status = getStatus(error) || getStatus(response);
    const body = getBody(response || error?.response || null);
    const headers = normalizeHeaders(getHeaders(response) || getHeaders(error));
    const antibotInfo = getAntibotInfo(body, status, headers);
    const count = getResultCount(rawResults);

    if (count > 0) {
        return {
            type: 'ok',
            reason: 'results_found',
            status,
            recoverable: false,
            canFallback: false,
            isError: false,
            details: { count }
        };
    }

    if (error) {
        if (isTimeout(error) || status === 408) {
            return {
                type: 'timeout',
                reason: 'request_timeout',
                status,
                recoverable: false,
                canFallback: true,
                isError: true
            };
        }

        if (status === 403 || status === 401 || antibotInfo.blocked) {
            return makeBlockedFailure({
                status,
                isError: true,
                antibotInfo
            });
        }

        if (status === 429) {
            return {
                type: 'rate_limited',
                reason: 'rate_limited',
                status,
                recoverable: false,
                canFallback: true,
                isError: true
            };
        }

        if (status === 404) {
            return {
                type: 'not_found',
                reason: 'http_404',
                status,
                recoverable: false,
                canFallback: true,
                isError: true
            };
        }

        if (status >= 500) {
            return {
                type: 'upstream_error',
                reason: `http_${status}`,
                status,
                recoverable: false,
                canFallback: true,
                isError: true
            };
        }

        if (isNetworkError(error)) {
            return {
                type: 'network_error',
                reason: cleanToken(error.code || error?.cause?.code || 'network_error'),
                status,
                recoverable: false,
                canFallback: true,
                isError: true
            };
        }

        return {
            type: 'parse_error',
            reason: error?.message || String(error),
            status,
            recoverable: false,
            canFallback: true,
            isError: true
        };
    }

    if (status === 408) {
        return {
            type: 'timeout',
            reason: 'request_timeout',
            status,
            recoverable: false,
            canFallback: true,
            isError: false
        };
    }

    if (status === 403 || status === 401 || antibotInfo.blocked) {
        return makeBlockedFailure({
            status,
            isError: false,
            antibotInfo
        });
    }

    if (status === 429) {
        return {
            type: 'rate_limited',
            reason: 'rate_limited',
            status,
            recoverable: false,
            canFallback: true,
            isError: false
        };
    }

    if (status === 404) {
        return {
            type: 'not_found',
            reason: 'http_404',
            status,
            recoverable: false,
            canFallback: true,
            isError: false
        };
    }

    if (status >= 500) {
        return {
            type: 'upstream_error',
            reason: `http_${status}`,
            status,
            recoverable: false,
            canFallback: true,
            isError: false
        };
    }

    if (hasHtmlBody(body) && hasSearchableLinks(body)) {
        return {
            type: 'selector_miss',
            reason: 'selector_miss',
            status,
            recoverable: true,
            canFallback: true,
            isError: false,
            details: {
                htmlBytes: body.length,
                recipeId: recipe.id || null,
                searchUrl: request?.url || null,
                queryTitle: context.title || context.name || null
            }
        };
    }

    if (hasHtmlBody(body)) {
        return {
            type: 'empty_results',
            reason: 'empty_results',
            status,
            recoverable: false,
            canFallback: true,
            isError: false,
            details: {
                htmlBytes: body.length
            }
        };
    }

    return {
        type: 'empty_results',
        reason: 'empty_results',
        status,
        recoverable: false,
        canFallback: true,
        isError: false
    };
}

module.exports = {
    classifyProviderFailure,
    getBody,
    getStatus,
    hasAntiBotBody,
    hasHtmlBody,
    normalizeFailureType
};
