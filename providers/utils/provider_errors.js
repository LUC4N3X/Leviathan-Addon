'use strict';

function safeText(value, fallback = '') {
    if (value === undefined || value === null) return fallback;
    return String(value);
}

function statusCodeOf(error) {
    const candidates = [
        error?.status,
        error?.statusCode,
        error?.response?.status,
        error?.code
    ];
    for (const value of candidates) {
        const parsed = Number.parseInt(value, 10);
        if (Number.isFinite(parsed) && parsed > 0) return parsed;
    }
    return 0;
}

function headersToText(headers) {
    if (!headers) return '';
    if (typeof headers === 'string') return headers;
    try { return JSON.stringify(headers); } catch (_) { return String(headers || ''); }
}

function compactMessage(error) {
    const message = safeText(error?.message || error?.reason || error?.code || error?.name || error, 'error')
        .replace(/\s+/g, ' ')
        .trim();
    return message.slice(0, 240) || 'error';
}

function isCloudflareLike(text) {
    return /cloudflare|cf-ray|cf_chl|turnstile|just a moment|checking your browser|browser verification|ddos-guard|captcha|challenge/i.test(safeText(text));
}

function classifyProviderError(error) {
    if (!error) {
        return {
            status: 'error',
            reason: 'unknown_error',
            code: 0,
            friendly: 'errore sconosciuto',
            retryable: true
        };
    }

    const code = statusCodeOf(error);
    const message = compactMessage(error);
    const body = safeText(error?.body || error?.data || error?.response?.data || '');
    const headerText = headersToText(error?.headers || error?.response?.headers);
    const combined = `${message}\n${body}\n${headerText}`;

    if (isCloudflareLike(combined) || ([403, 429, 503].includes(code) && isCloudflareLike(headerText || body || message))) {
        return {
            status: 'blocked_cf',
            reason: code ? `cf_${code}` : 'cf_challenge',
            code,
            friendly: 'blocco Cloudflare / challenge anti-bot',
            retryable: true,
            shortMessage: message
        };
    }

    if (code === 403) {
        return { status: 'blocked', reason: 'http_403', code, friendly: 'accesso negato dal sito/hoster', retryable: true, shortMessage: message };
    }
    if (code === 429) {
        return { status: 'rate_limited', reason: 'http_429', code, friendly: 'rate-limit: troppe richieste verso il sito/hoster', retryable: true, shortMessage: message };
    }
    if ([500, 502, 503, 504, 522, 523, 524].includes(code)) {
        return { status: 'error', reason: `http_${code}`, code, friendly: 'server remoto temporaneamente non disponibile', retryable: true, shortMessage: message };
    }
    if (/timeout|timed out|etimedout|aborted|econnreset|socket hang up/i.test(message)) {
        return { status: 'slow', reason: 'timeout', code, friendly: 'timeout o connessione interrotta', retryable: true, shortMessage: message };
    }
    if (/enotfound|eai_again|dns|getaddrinfo/i.test(message)) {
        return { status: 'error', reason: 'dns', code, friendly: 'DNS o dominio non raggiungibile', retryable: true, shortMessage: message };
    }
    if (/invalid url|unsupported protocol|malformed/i.test(message)) {
        return { status: 'error', reason: 'bad_url', code, friendly: 'URL non valido o non supportato', retryable: false, shortMessage: message };
    }

    return {
        status: 'error',
        reason: message.slice(0, 80) || 'error',
        code,
        friendly: 'errore provider/hoster',
        retryable: true,
        shortMessage: message
    };
}

function formatProviderError(provider, error, meta = {}) {
    const classified = meta.classified || classifyProviderError(error);
    const parts = [
        `provider=${safeText(provider || meta.provider || 'unknown')}`,
        `status=${classified.status}`,
        `reason=${classified.reason}`
    ];
    if (classified.code) parts.push(`code=${classified.code}`);
    if (meta.host) parts.push(`host=${meta.host}`);
    if (meta.url) {
        try { parts.push(`urlHost=${new URL(String(meta.url)).hostname}`); } catch (_) {}
    }
    if (meta.ms !== undefined) parts.push(`ms=${meta.ms}`);
    parts.push(`nice=${classified.friendly}`);
    if (classified.shortMessage && process.env.PROVIDER_ERROR_VERBOSE === '1') {
        parts.push(`message=${JSON.stringify(classified.shortMessage)}`);
    }
    return `[PROVIDER ERROR] ${parts.join(' | ')}`;
}

function logProviderError(provider, error, meta = {}) {
    const line = formatProviderError(provider, error, meta);
    const shouldLog = meta.force === true || process.env.PROVIDER_ERROR_DEBUG === '1' || /blocked|rate_limited|slow/.test(line);
    if (shouldLog) console.warn(line);
    return line;
}

module.exports = {
    classifyProviderError,
    compactMessage,
    formatProviderError,
    isCloudflareLike,
    logProviderError,
    statusCodeOf
};
