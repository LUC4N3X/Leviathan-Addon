'use strict';

const { detectAntibot } = require('../../providers/utils/antibot_signatures');

const LEGACY_ANTIBOT_RE = /cloudflare|cf-chl|captcha|attention required|verify you are human|just a moment|access denied|ddos-guard|checking your browser/i;

function getStatus(errorOrResponse = null) {
    return Number(
        errorOrResponse?.status
        || errorOrResponse?.statusCode
        || errorOrResponse?.response?.status
        || errorOrResponse?.data?.status
        || 0
    ) || 0;
}

function getHeaders(source = null) {
    return source?.headers || source?.response?.headers || null;
}

function getBody(response = null) {
    const value = response?.data ?? response?.body ?? response?.text ?? response;
    if (typeof value === 'string') return value;
    if (Buffer.isBuffer(value)) return value.toString('utf8');
    return '';
}

function hasAntiBotBody(body = '') {
    const text = String(body || '');
    if (LEGACY_ANTIBOT_RE.test(text)) return true;
    const detection = detectAntibot(text, 0, null);
    return detection.blocked && detection.vendor !== 'none' && detection.vendor !== 'unknown';
}

function hasHtmlBody(body = '') {
    return /<html[\s>]|<body[\s>]|<a\s|<article\s|<main\s|<div\s/i.test(String(body || ''));
}

function hasSearchableLinks(body = '') {
    const html = String(body || '');
    const anchors = (html.match(/<a\s[^>]*href=/gi) || []).length;
    const articles = (html.match(/<article\b/gi) || []).length;
    return anchors >= 3 || articles >= 1;
}

function isTimeout(error = null) {
    const code = String(error?.code || '').toUpperCase();
    const message = String(error?.message || error || '');
    return code === 'ETIMEDOUT' || code === 'ECONNABORTED' || /timeout|timed\s*out/i.test(message);
}

function isNetworkError(error = null) {
    const code = String(error?.code || '').toUpperCase();
    return ['ECONNRESET', 'ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'EHOSTUNREACH', 'ENETUNREACH'].includes(code);
}

function normalizeFailureType(type = '') {
    const value = String(type || '').trim().toLowerCase();
    if (!value) return 'unknown';
    if (['403', 'blocked_cf', 'cloudflare_block', 'captcha'].includes(value)) return 'blocked';
    if (['429', 'rate_limited'].includes(value)) return 'rate_limited';
    if (['timeout', 'request_timeout'].includes(value)) return 'timeout';
    if (['selector_miss', 'layout_changed', 'empty_results', 'empty'].includes(value)) return value === 'empty' ? 'empty_results' : value;
    return value.replace(/[^a-z0-9_-]+/g, '_') || 'unknown';
}

function classifyProviderFailure({ error = null, response = null, rawResults = [], recipe = {}, context = {}, request = null } = {}) {
    const status = getStatus(error) || getStatus(response);
    const body = getBody(response || error?.response || null);
    const headers = getHeaders(response) || getHeaders(error) || {};
    const antibot = detectAntibot(body, status, headers);
    const antiBotBlock = antibot.blocked && (
        antibot.vendor === 'cloudflare'
        || antibot.kind === 'waf'
        || antibot.kind === 'turnstile'
        || antibot.kind === 'managed_challenge'
        || (antibot.vendor !== 'none' && antibot.vendor !== 'unknown')
    ) || hasAntiBotBody(body);
    const blockReason = antiBotBlock && antibot.vendor && antibot.vendor !== 'none' && antibot.vendor !== 'unknown'
        ? `antibot_${antibot.vendor}`
        : 'anti_bot_blocked';
    const blockDetails = antiBotBlock ? { vendor: antibot.vendor, kind: antibot.kind } : undefined;
    const count = Array.isArray(rawResults) ? rawResults.length : (rawResults ? 1 : 0);

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
        if (isTimeout(error)) {
            return { type: 'timeout', reason: 'request_timeout', status, recoverable: false, canFallback: true, isError: true };
        }
        if (status === 403 || status === 401 || antiBotBlock) {
            return { type: 'blocked', reason: status === 403 ? 'http_403_blocked' : (status === 401 && !antiBotBlock ? 'http_401_unauthorized' : blockReason), status, recoverable: false, canFallback: true, isError: true, details: blockDetails };
        }
        if (status === 429) {
            return { type: 'rate_limited', reason: 'rate_limited', status, recoverable: false, canFallback: true, isError: true };
        }
        if (status === 404) {
            return { type: 'not_found', reason: 'http_404', status, recoverable: false, canFallback: true, isError: true };
        }
        if (status >= 500) {
            return { type: 'upstream_error', reason: `http_${status}`, status, recoverable: false, canFallback: true, isError: true };
        }
        if (isNetworkError(error)) {
            return { type: 'network_error', reason: String(error.code || 'network_error').toLowerCase(), status, recoverable: false, canFallback: true, isError: true };
        }
        return { type: 'parse_error', reason: error?.message || String(error), status, recoverable: false, canFallback: true, isError: true };
    }

    if (status === 403 || status === 401 || antiBotBlock) {
        return { type: 'blocked', reason: status === 403 ? 'http_403_blocked' : (status === 401 && !antiBotBlock ? 'http_401_unauthorized' : blockReason), status, recoverable: false, canFallback: true, isError: false, details: blockDetails };
    }
    if (status === 429) return { type: 'rate_limited', reason: 'rate_limited', status, recoverable: false, canFallback: true, isError: false };
    if (status === 404) return { type: 'not_found', reason: 'http_404', status, recoverable: false, canFallback: true, isError: false };
    if (status >= 500) return { type: 'upstream_error', reason: `http_${status}`, status, recoverable: false, canFallback: true, isError: false };

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
        return { type: 'empty_results', reason: 'empty_results', status, recoverable: false, canFallback: true, isError: false, details: { htmlBytes: body.length } };
    }

    return { type: 'empty_results', reason: 'empty_results', status, recoverable: false, canFallback: true, isError: false };
}

module.exports = {
    classifyProviderFailure,
    getBody,
    getStatus,
    hasAntiBotBody,
    hasHtmlBody,
    normalizeFailureType
};
