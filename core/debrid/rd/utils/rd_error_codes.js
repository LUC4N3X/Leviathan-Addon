'use strict';

const RD_ERROR_CODES = {
    SLOW_DOWN: 5,
    BAD_TOKEN: 8,
    PERMISSION_DENIED: 9,
    INVALID_LOGIN: 12,
    INVALID_PASSWORD: 13,
    ACCOUNT_LOCKED: 14,
    ACCOUNT_NOT_ACTIVATED: 15,
    TOO_MANY_ACTIVE_DOWNLOADS: 21,
    IP_NOT_ALLOWED: 22,
    TRAFFIC_EXHAUSTED: 23,
    UPLOAD_TOO_BIG: 26,
    FILE_NOT_ALLOWED: 28,
    TORRENT_TOO_BIG: 29,
    TORRENT_FILE_INVALID: 30,
    TOO_MANY_REQUESTS: 34,
    INFRINGING_FILE: 35,
    FAIR_USAGE_LIMIT: 36
};

const TERMINAL_UNCACHED_ERROR_CODES = new Set([
    RD_ERROR_CODES.FILE_NOT_ALLOWED,
    RD_ERROR_CODES.TORRENT_TOO_BIG,
    RD_ERROR_CODES.TORRENT_FILE_INVALID,
    RD_ERROR_CODES.INFRINGING_FILE
]);

const AUTH_ERROR_CODES = new Set([
    RD_ERROR_CODES.BAD_TOKEN,
    RD_ERROR_CODES.PERMISSION_DENIED,
    RD_ERROR_CODES.INVALID_LOGIN,
    RD_ERROR_CODES.INVALID_PASSWORD,
    RD_ERROR_CODES.ACCOUNT_LOCKED,
    RD_ERROR_CODES.ACCOUNT_NOT_ACTIVATED
]);

const RATE_LIMIT_ERROR_CODES = new Set([
    RD_ERROR_CODES.SLOW_DOWN,
    RD_ERROR_CODES.TOO_MANY_ACTIVE_DOWNLOADS,
    RD_ERROR_CODES.TRAFFIC_EXHAUSTED,
    RD_ERROR_CODES.TOO_MANY_REQUESTS,
    RD_ERROR_CODES.FAIR_USAGE_LIMIT
]);

function extractRdErrorCode(body) {
    if (!body || typeof body !== 'object') return null;
    const raw = body.error_code ?? body.errorCode ?? body.code;
    if (!/^\d+$/.test(String(raw ?? '').trim())) return null;
    const parsed = Number(raw);
    return Number.isInteger(parsed) ? parsed : null;
}

function classifyRdErrorCode(code) {
    if (!Number.isInteger(code)) return 'unknown';
    if (TERMINAL_UNCACHED_ERROR_CODES.has(code)) return 'terminal_uncached';
    if (AUTH_ERROR_CODES.has(code)) return 'auth';
    if (RATE_LIMIT_ERROR_CODES.has(code)) return 'rate_limit';
    return 'unknown';
}

module.exports = {
    RD_ERROR_CODES,
    TERMINAL_UNCACHED_ERROR_CODES,
    AUTH_ERROR_CODES,
    RATE_LIMIT_ERROR_CODES,
    extractRdErrorCode,
    classifyRdErrorCode
};
