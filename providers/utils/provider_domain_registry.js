'use strict';

const fs = require('fs');
const net = require('net');
const path = require('path');
const { normalizeProviderId } = require('../engine/provider_result_normalizer');

const DEFAULT_PROVIDER_DOMAINS = Object.freeze({
    animeunity: Object.freeze(['https://www.animeunity.so']),
    animesaturn: Object.freeze(['https://www.animesaturn.cx']),
    animeworld: Object.freeze(['https://www.animeworld.ac']),
    cb01: Object.freeze(['https://cb01uno.pics', 'https://cb01uno.pics']),
    eurostreaming: Object.freeze(['https://eurostream.ing']),
    guardaflix: Object.freeze(['https://guardaplay.xyz']),
    guardahd: Object.freeze(['https://guardahd.stream']),
    guardoserie: Object.freeze(['https://guardoserie.living']),
    streamingcommunity: Object.freeze(['https://vixsrc.to']),
    toonitalia: Object.freeze([
        'https://toonitalia.xyz',
        'https://toonitalia.org',
        'https://toonitalia.co',
        'https://toonitalia.fun'
    ])
});

const PROVIDER_ALIASES = Object.freeze({
    anime_world: 'animeworld',
    animeunitytv: 'animeunity',
    as: 'animesaturn',
    aw: 'animeworld',
    au: 'animeunity',
    es: 'eurostreaming',
    gf: 'guardaflix',
    ghd: 'guardahd',
    gs: 'guardoserie',
    ti: 'toonitalia',
    vix: 'streamingcommunity',
    vixsrc: 'streamingcommunity',
    webaw: 'animeworld',
    webvix: 'streamingcommunity'
});

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

let defaultRegistry = null;
let defaultAutoRefreshStarted = false;

function asArray(value) {
    if (!value) return [];
    return Array.isArray(value) ? value : [value];
}

function uniqueList(values = []) {
    const out = [];
    const seen = new Set();
    for (const value of asArray(values)) {
        const text = String(value || '').trim();
        if (!text) continue;
        const key = text.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(text);
    }
    return out;
}

function knownProviderId(value) {
    const normalized = normalizeProviderId(value).replace(/[_-]/g, '');
    const aliasKey = normalizeProviderId(value);
    const id = PROVIDER_ALIASES[aliasKey] || PROVIDER_ALIASES[normalized] || normalized;
    return Object.prototype.hasOwnProperty.call(DEFAULT_PROVIDER_DOMAINS, id) ? id : '';
}

function hasIpv4Prefix(hostname, prefix) {
    return hostname === prefix.replace(/\.$/, '') || hostname.startsWith(prefix);
}

function isPrivateHostname(hostname = '') {
    const host = String(hostname || '').trim().toLowerCase().replace(/^\[|\]$/g, '');
    if (!host) return true;
    if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) return true;
    if (host === '::' || host.startsWith('::ffff:')) return true;

    const ipVersion = net.isIP(host);
    if (ipVersion === 4) {
        const parts = host.split('.').map((part) => Number.parseInt(part, 10));
        if (parts[0] === 10 || parts[0] === 127 || parts[0] === 0) return true;
        if (parts[0] === 169 && parts[1] === 254) return true;
        if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;
        if (parts[0] === 192 && parts[1] === 168) return true;
        return false;
    }
    if (ipVersion === 6) {
        return host === '::1' || host.startsWith('fc') || host.startsWith('fd') || host.startsWith('fe80:');
    }

    return hasIpv4Prefix(host, '10.')
        || hasIpv4Prefix(host, '127.')
        || hasIpv4Prefix(host, '0.')
        || host.startsWith('169.254.')
        || host.startsWith('192.168.');
}

function ensureProtocol(value) {
    const raw = String(value || '').trim();
    if (!raw) return '';
    if (/^[a-z][a-z0-9+.-]*:/i.test(raw)) return raw;
    if (/^[a-z0-9.-]+(?::\d+)?(?:\/.*)?$/i.test(raw) && raw.includes('.')) return `https://${raw}`;
    return raw;
}

function normalizeProviderDomain(value) {
    try {
        const parsed = new URL(ensureProtocol(value));
        if (!['http:', 'https:'].includes(parsed.protocol)) return null;
        if (parsed.username || parsed.password) return null;
        if (isPrivateHostname(parsed.hostname)) return null;
        return parsed.origin.replace(/\/+$/, '');
    } catch (_) {
        return null;
    }
}

function normalizeManifestEntry(value) {
    if (!value) return [];
    if (typeof value === 'string' || Array.isArray(value)) return asArray(value);
    if (typeof value !== 'object') return [];
    return asArray(
        value.url
        || value.baseUrl
        || value.baseURL
        || value.baseUrls
        || value.baseURLs
        || value.domain
        || value.domains
    );
}

function manifestContainer(rawManifest = {}) {
    if (!rawManifest || typeof rawManifest !== 'object') return {};
    return rawManifest.domains
        || rawManifest.providerDomains
        || rawManifest.providers
        || rawManifest;
}

function normalizeProviderDomainManifest(rawManifest = {}) {
    const domains = {};
    const source = manifestContainer(rawManifest);
    for (const [rawProviderId, entry] of Object.entries(source || {})) {
        const providerId = knownProviderId(rawProviderId);
        if (!providerId) continue;

        const normalizedDomains = uniqueList(
            normalizeManifestEntry(entry).map(normalizeProviderDomain).filter(Boolean)
        );
        if (normalizedDomains.length > 0) domains[providerId] = normalizedDomains;
    }
    return { domains };
}

function safeManifestSourceUrl(value) {
    try {
        const parsed = new URL(String(value || '').trim());
        if (parsed.protocol !== 'https:') return null;
        if (parsed.username || parsed.password) return null;
        if (isPrivateHostname(parsed.hostname)) return null;
        return parsed.toString();
    } catch (_) {
        return null;
    }
}

function responseHeader(response, name) {
    const headers = response?.headers;
    if (!headers) return '';
    if (typeof headers.get === 'function') return headers.get(name) || headers.get(name.toLowerCase()) || '';
    return headers[name] || headers[name.toLowerCase()] || '';
}

async function responseJson(response) {
    if (typeof response?.json === 'function') return response.json();
    if (typeof response?.text === 'function') return JSON.parse(await response.text());
    if (typeof response?.body === 'string') return JSON.parse(response.body);
    return response;
}

async function fetchManifestJson(sourceUrl, fetcher, maxRedirects = 5) {
    let currentUrl = safeManifestSourceUrl(sourceUrl);
    if (!currentUrl) throw new Error('invalid provider domain manifest url');
    if (typeof fetcher !== 'function') throw new Error('provider domain manifest fetcher is unavailable');

    for (let redirectCount = 0; redirectCount <= maxRedirects; redirectCount += 1) {
        const response = await fetcher(currentUrl, {
            method: 'GET',
            redirect: 'manual',
            headers: { accept: 'application/json,text/plain;q=0.8,*/*;q=0.5' }
        });
        const status = Number(response?.status || 0);
        if (REDIRECT_STATUSES.has(status)) {
            const location = responseHeader(response, 'location');
            const nextUrl = safeManifestSourceUrl(new URL(location, currentUrl).toString());
            if (!nextUrl) throw new Error('provider domain manifest redirected to an unsafe url');
            currentUrl = nextUrl;
            continue;
        }
        if (status < 200 || status >= 300) throw new Error(`provider domain manifest returned status ${status}`);
        return responseJson(response);
    }

    throw new Error('provider domain manifest redirected too many times');
}

function readManifestFile(cachePath) {
    const filePath = String(cachePath || '').trim();
    if (!filePath) return null;
    try {
        if (!fs.existsSync(filePath)) return null;
        return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch (_) {
        return null;
    }
}

function writeManifestFile(cachePath, manifest) {
    const filePath = String(cachePath || '').trim();
    if (!filePath) return;
    try {
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(filePath, JSON.stringify({ ...manifest, updatedAt: new Date().toISOString() }, null, 2));
    } catch (_) {
        // Cache persistence is best-effort; keep the in-memory manifest usable.
    }
}

function envManifest() {
    const raw = String(process.env.PROVIDER_DOMAIN_OVERRIDES || process.env.PROVIDER_DOMAINS || '').trim();
    if (!raw) return null;
    try {
        return JSON.parse(raw);
    } catch (_) {
        return null;
    }
}

function createProviderDomainRegistry(options = {}) {
    let fetcher = options.fetcher || (typeof fetch === 'function' ? fetch.bind(globalThis) : null);
    const cachePath = options.cachePath || process.env.PROVIDER_DOMAIN_CACHE_PATH || '';
    const cacheTtlMs = Math.max(30_000, Number.parseInt(String(options.cacheTtlMs || process.env.PROVIDER_DOMAIN_CACHE_TTL_MS || 15 * 60_000), 10) || 15 * 60_000);
    const now = typeof options.now === 'function' ? options.now : () => Date.now();
    let lastRefreshAt = 0;
    let manifest = normalizeProviderDomainManifest(
        options.initialManifest
        || options.domains
        || envManifest()
        || readManifestFile(cachePath)
        || {}
    );

    function setFetcher(nextFetcher) {
        fetcher = nextFetcher;
    }

    function setManifest(nextManifest) {
        manifest = normalizeProviderDomainManifest(nextManifest || {});
        lastRefreshAt = now();
        return manifest;
    }

    function getAll(providerId, fallbackDomains = []) {
        const id = knownProviderId(providerId);
        const defaults = id ? DEFAULT_PROVIDER_DOMAINS[id] || [] : [];
        const overrides = id ? manifest.domains[id] || [] : [];
        return uniqueList([...overrides, ...asArray(fallbackDomains), ...defaults].map(normalizeProviderDomain).filter(Boolean));
    }

    function get(providerId, fallback = '') {
        return getAll(providerId, fallback ? [fallback] : [])[0] || '';
    }

    async function refresh({ sourceUrl = options.sourceUrl || process.env.PROVIDER_DOMAIN_MANIFEST_URL || process.env.PROVIDER_DOMAINS_URL || '', force = false } = {}) {
        const ageMs = now() - lastRefreshAt;
        if (!force && lastRefreshAt && ageMs < cacheTtlMs) return { ...manifest, refreshed: false, cached: true };

        try {
            const rawManifest = await fetchManifestJson(sourceUrl, fetcher);
            const nextManifest = normalizeProviderDomainManifest(rawManifest);
            if (Object.keys(nextManifest.domains).length > 0) {
                manifest = nextManifest;
                lastRefreshAt = now();
                writeManifestFile(cachePath, manifest);
            }
            return { ...manifest, refreshed: true, cached: false };
        } catch (error) {
            return { ...manifest, refreshed: false, cached: true, error };
        }
    }

    return {
        get,
        getAll,
        refresh,
        setFetcher,
        setManifest
    };
}

function envFlag(name, fallback = false) {
    const raw = process.env[name];
    if (raw === undefined || raw === null || raw === '') return fallback;
    if (/^(1|true|yes|y|on)$/i.test(String(raw).trim())) return true;
    if (/^(0|false|no|n|off)$/i.test(String(raw).trim())) return false;
    return fallback;
}

function envRefreshIntervalMs() {
    const value = Number.parseInt(String(process.env.PROVIDER_DOMAIN_REFRESH_INTERVAL_MS || ''), 10);
    if (!Number.isFinite(value) || value <= 0) return 0;
    return Math.max(60_000, value);
}

function envManifestSourceUrl() {
    return process.env.PROVIDER_DOMAIN_MANIFEST_URL || process.env.PROVIDER_DOMAINS_URL || '';
}

function startDefaultAutoRefresh(registry) {
    if (defaultAutoRefreshStarted) return;
    if (envFlag('PROVIDER_DOMAIN_AUTO_REFRESH', true) === false) return;

    const sourceUrl = safeManifestSourceUrl(envManifestSourceUrl());
    if (!sourceUrl) return;

    defaultAutoRefreshStarted = true;
    const refresh = () => {
        registry.refresh({ sourceUrl, force: true }).then((result) => {
            if (result?.error && envFlag('PROVIDER_DOMAIN_DEBUG', false)) {
                console.warn(`[ProviderDomains] refresh failed: ${result.error.message || result.error}`);
            }
        }).catch((error) => {
            if (envFlag('PROVIDER_DOMAIN_DEBUG', false)) console.warn(`[ProviderDomains] refresh failed: ${error.message || error}`);
        });
    };

    const bootTimer = setTimeout(refresh, 0);
    if (typeof bootTimer.unref === 'function') bootTimer.unref();

    const intervalMs = envRefreshIntervalMs();
    if (intervalMs > 0) {
        const interval = setInterval(refresh, intervalMs);
        if (typeof interval.unref === 'function') interval.unref();
    }
}

function defaultProviderDomainRegistry() {
    if (!defaultRegistry) {
        defaultRegistry = createProviderDomainRegistry();
        startDefaultAutoRefresh(defaultRegistry);
    }
    return defaultRegistry;
}

function getProviderDomain(providerId, fallback = '') {
    return defaultProviderDomainRegistry().get(providerId, fallback);
}

function getProviderDomains(providerId, fallbackDomains = []) {
    return defaultProviderDomainRegistry().getAll(providerId, fallbackDomains);
}

function refreshProviderDomainRegistry(options = {}) {
    return defaultProviderDomainRegistry().refresh(options);
}

function resetProviderDomainRegistryForTests(initialManifest = null) {
    defaultAutoRefreshStarted = false;
    defaultRegistry = initialManifest ? createProviderDomainRegistry({ initialManifest }) : null;
}

module.exports = {
    DEFAULT_PROVIDER_DOMAINS,
    createProviderDomainRegistry,
    getProviderDomain,
    getProviderDomains,
    knownProviderId,
    normalizeProviderDomain,
    normalizeProviderDomainManifest,
    refreshProviderDomainRegistry,
    resetProviderDomainRegistryForTests,
    safeManifestSourceUrl
};
