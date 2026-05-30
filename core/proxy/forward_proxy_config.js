'use strict';

const FORWARD_PROXY_CONFIG_ERROR = 'FORWARD_PROXY_CONFIG_ERROR';
const DISABLED_VALUE_PATTERN = /^(?:0|false|off|no)$/i;

function createForwardProxyConfigError(message, context = 'forward_proxy') {
    const error = new Error(`[${context}] ${message}`);
    error.code = FORWARD_PROXY_CONFIG_ERROR;
    return error;
}

function isDisabledForwardProxyValue(value) {
    return DISABLED_VALUE_PATTERN.test(String(value || '').trim());
}

function validateHttpUrl(value, label, context) {
    let parsed;
    try {
        parsed = new URL(value);
    } catch (_) {
        throw createForwardProxyConfigError(`${label} must be a valid HTTP(S) URL`, context);
    }
    if (!/^https?:$/i.test(parsed.protocol)) {
        throw createForwardProxyConfigError(`${label} must use HTTP(S)`, context);
    }
    return parsed;
}

function normalizeForwardProxyBase(value, context = 'forward_proxy') {
    const raw = String(value || '').trim();
    if (!raw || isDisabledForwardProxyValue(raw)) return '';

    const validationUrl = raw.includes('{url}')
        ? raw.replace('{url}', encodeURIComponent('https://target.example/'))
        : raw;
    validateHttpUrl(validationUrl, 'FORWARD_PROXY', context);
    return raw;
}

function getForwardProxyBase(options = {}) {
    const hasOverride = Object.prototype.hasOwnProperty.call(options, 'base');
    return normalizeForwardProxyBase(
        hasOverride ? options.base : process.env.FORWARD_PROXY,
        options.context || 'forward_proxy'
    );
}

function requireForwardProxyBase(context = 'forward_proxy', options = {}) {
    const base = getForwardProxyBase({ ...options, context });
    if (!base) {
        throw createForwardProxyConfigError('FORWARD_PROXY is required', context);
    }
    return base;
}

function normalizeTargetUrl(targetUrl, context) {
    return validateHttpUrl(String(targetUrl || '').trim(), 'target URL', context).toString();
}

function appendQueryParams(rawUrl, params = {}) {
    const parsed = new URL(rawUrl);
    for (const [name, value] of Object.entries(params || {})) {
        if (!name || value === undefined || value === null || value === '') continue;
        parsed.searchParams.set(String(name), String(value));
    }
    return parsed.toString();
}

function buildForwardProxyUrl(targetUrl, options = {}) {
    const context = options.context || 'forward_proxy';
    const normalizedTarget = normalizeTargetUrl(targetUrl, context);
    const hasBaseOverride = Object.prototype.hasOwnProperty.call(options, 'base');
    const base = requireForwardProxyBase(context, hasBaseOverride ? { base: options.base } : {});
    const encodedTarget = encodeURIComponent(normalizedTarget);
    let out;

    if (base.includes('{url}')) {
        out = base.replace('{url}', encodedTarget);
    } else if (/[?&][^=]+=$/.test(base)) {
        out = `${base}${encodedTarget}`;
    } else {
        const parsed = new URL(base);
        parsed.searchParams.set(String(options.urlParam || 'url'), normalizedTarget);
        out = parsed.toString();
    }

    return appendQueryParams(out, options.params);
}

module.exports = {
    FORWARD_PROXY_CONFIG_ERROR,
    buildForwardProxyUrl,
    createForwardProxyConfigError,
    getForwardProxyBase,
    isDisabledForwardProxyValue,
    normalizeForwardProxyBase,
    requireForwardProxyBase
};
