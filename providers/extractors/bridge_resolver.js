'use strict';

const { isSafeRemoteUrl } = require('../../core/utils/url');
const { DEFAULT_USER_AGENT, fetchText, normalizeEscapedText } = require('./hosters/shared');
const { normalizeRemoteUrl } = require('./common');

const DEFAULT_BRIDGE_DOMAINS = Object.freeze([
    'mysync.mov',
    'sync.icu',
    'syncstream.mov',
    'cuevana.biz',
    'cuevana.pro'
]);

const BRIDGE_URL_PATTERNS = Object.freeze([
    /window\.location\.replace\(\s*["']([^"']+)["']\s*\)/i,
    /window\.location\.href\s*=\s*["']([^"']+)["']/i,
    /location\.href\s*=\s*["']([^"']+)["']/i,
    /location\.replace\(\s*["']([^"']+)["']\s*\)/i,
    /<meta\b[^>]+http-equiv=["']?refresh["']?[^>]+content=["'][^"']*url=([^"'>\s]+)["']/i,
    /<iframe\b[^>]+src=["']([^"']+)["']/i,
    /<a\b[^>]+href=["']([^"']+)["'][^>]*(?:continue|proceed|watch|play|stream|server)/i,
    /(?:data-url|data-link|data-href)=["']([^"']+)["']/i
]);

function envFlag(name, fallback = false) {
    const raw = process.env[name];
    if (raw === undefined || raw === null || raw === '') return fallback;
    if (/^(?:1|true|yes|on)$/i.test(String(raw).trim())) return true;
    if (/^(?:0|false|no|off)$/i.test(String(raw).trim())) return false;
    return fallback;
}

function envList(name) {
    return String(process.env[name] || '')
        .split(/[\s,;|]+/)
        .map((value) => value.trim().toLowerCase().replace(/^www\./, ''))
        .filter(Boolean);
}

function normalizeHostname(value) {
    try {
        return new URL(String(value || '')).hostname.toLowerCase().replace(/^www\./, '');
    } catch (_) {
        return '';
    }
}

function configuredBridgeDomains() {
    const extra = envList('BRIDGE_RESOLVER_DOMAINS');
    const disabled = new Set(envList('BRIDGE_RESOLVER_DISABLED_DOMAINS'));
    return [...new Set([...DEFAULT_BRIDGE_DOMAINS, ...extra])].filter((domain) => !disabled.has(domain));
}

function isAllowedBridgeHost(hostname) {
    const host = String(hostname || '').toLowerCase().replace(/^www\./, '');
    if (!host) return false;
    return configuredBridgeDomains().some((domain) => host === domain || host.endsWith(`.${domain}`));
}

function isBridgeResolverEnabled() {
    return envFlag('BRIDGE_RESOLVER_ENABLED', true);
}

function isBridgeResolverCandidate(url) {
    if (!isBridgeResolverEnabled()) return false;
    if (!isSafeRemoteUrl(url)) return false;
    return isAllowedBridgeHost(normalizeHostname(url));
}

function normalizeBridgeCandidate(value, baseUrl) {
    const raw = normalizeEscapedText(value || '')
        .replace(/^['"`]+|['"`;,)\]}\s]+$/g, '')
        .trim();
    if (!raw || /^(?:javascript|data|mailto):/i.test(raw)) return null;
    const normalized = normalizeRemoteUrl(raw, baseUrl);
    if (!normalized || !isSafeRemoteUrl(normalized)) return null;
    try {
        const source = new URL(baseUrl);
        const target = new URL(normalized);
        if (source.href === target.href) return null;
        if (source.hostname.toLowerCase() === target.hostname.toLowerCase() && source.pathname === target.pathname) return null;
    } catch (_) {}
    return normalized;
}

function extractBridgeTarget(html, baseUrl) {
    const searchSpace = normalizeEscapedText(html || '');
    for (const pattern of BRIDGE_URL_PATTERNS) {
        const match = searchSpace.match(pattern);
        const candidate = normalizeBridgeCandidate(match?.[1], baseUrl);
        if (candidate) return candidate;
    }
    return null;
}

async function resolveBridgeUrl(url, options = {}) {
    const input = String(url || '').trim();
    if (!isBridgeResolverCandidate(input)) return null;

    const client = options.client;
    if (!client || typeof client.get !== 'function') return null;

    const timeout = Number.parseInt(options.bridgeTimeoutMs || process.env.BRIDGE_RESOLVER_TIMEOUT_MS || '4500', 10) || 4500;
    const userAgent = options.userAgent || DEFAULT_USER_AGENT;
    const logger = options.logger || options.log;

    const headers = {
        'User-Agent': userAgent,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'it-IT,it;q=0.9,en-US;q=0.8,en;q=0.7',
        'Referer': options.referer || options.requestReferer || `${new URL(input).origin}/`
    };

    try {
        const { status, text, response } = await fetchText(client, input, { headers, timeout });
        const finalUrl = String(response?.request?.res?.responseUrl || response?.config?.url || '').trim();
        if (finalUrl && finalUrl !== input && isSafeRemoteUrl(finalUrl) && !isBridgeResolverCandidate(finalUrl)) {
            if (logger?.debug) logger.debug(`[BridgeResolver] redirect ${input} -> ${finalUrl}`);
            return finalUrl;
        }

        if (status < 200 || status >= 400 || !text) return null;
        const target = extractBridgeTarget(text, finalUrl || input);
        if (target && !isBridgeResolverCandidate(target)) {
            if (logger?.debug) logger.debug(`[BridgeResolver] html ${input} -> ${target}`);
            return target;
        }
        return target || null;
    } catch (error) {
        if (logger?.warn && envFlag('BRIDGE_RESOLVER_DEBUG', false)) {
            logger.warn(`[BridgeResolver] failed ${input}: ${error.message || error}`);
        }
        return null;
    }
}

module.exports = {
    DEFAULT_BRIDGE_DOMAINS,
    extractBridgeTarget,
    isBridgeResolverCandidate,
    resolveBridgeUrl
};
