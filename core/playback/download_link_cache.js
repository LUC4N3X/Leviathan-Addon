'use strict';

const { normalizeProxyTarget, isAlreadyProxied } = require('../proxy/proxy_header_normalizer');

const DEFAULT_DOWNLOAD_LINK_TTL = Math.max(60, parseInt(process.env.DOWNLOAD_LINK_CACHE_TTL || process.env.RESOLVED_URL_TTL || '3600', 10) || 3600);
const DEFAULT_SAVED_CLOUD_TTL = Math.max(60, parseInt(process.env.SAVED_CLOUD_LINK_CACHE_TTL || process.env.DOWNLOAD_LINK_CACHE_TTL || '3600', 10) || 3600);
const DEFAULT_DIRECT_RESOLVE_TTL = Math.max(60, parseInt(process.env.DIRECT_RESOLVE_LINK_CACHE_TTL || process.env.DOWNLOAD_LINK_CACHE_TTL || '3600', 10) || 3600);

function normalizeHash(hash = '') {
    return String(hash || '').trim().toUpperCase();
}

function normalizeIndex(value) {
    if (value === undefined || value === null || value === '') return -1;
    const parsed = parseInt(value, 10);
    return Number.isFinite(parsed) ? parsed : -1;
}

function buildLazyKey(service, item = {}, meta = {}) {
    const normalizedService = String(service || 'rd').toLowerCase();
    const hash = normalizeHash(item.hash || item.infoHash || item.info_hash);
    const season = Number(meta?.season || item.season || 0) || 0;
    const episode = Number(meta?.episode || item.episode || 0) || 0;
    const fileIdx = normalizeIndex(item.fileIdx !== undefined ? item.fileIdx : item.file_index);
    return `${normalizedService}:${hash}:${season}:${episode}:${fileIdx}`;
}

function buildSavedCloudKey(service, torrentId, fileId) {
    return `saved:${String(service || '').toLowerCase()}:${String(torrentId || '').trim()}:${String(fileId || '').trim()}`;
}

function getTtl(scope = 'lazy') {
    const normalized = String(scope || '').toLowerCase();
    if (normalized === 'saved' || normalized === 'saved_cloud') return DEFAULT_SAVED_CLOUD_TTL;
    if (normalized === 'direct' || normalized === 'instant') return DEFAULT_DIRECT_RESOLVE_TTL;
    return DEFAULT_DOWNLOAD_LINK_TTL;
}

async function get(Cache, key, { logger, incrementMetric, scope = 'lazy' } = {}) {
    if (!Cache || !key) return null;
    const cached = await Cache.getLazyLink(key);
    if (cached?.url) {
        if (typeof incrementMetric === 'function') incrementMetric(`downloadLinkCache.${scope}.hit`);
        logger?.info?.(`[PLAYBACK CACHE] hit scope=${scope} key=${key}`);
        return cached;
    }
    if (typeof incrementMetric === 'function') incrementMetric(`downloadLinkCache.${scope}.miss`);
    return null;
}

async function set(Cache, key, value, { ttl, logger, incrementMetric, scope = 'lazy' } = {}) {
    if (!Cache || !key || !value?.url) return false;
    const effectiveTtl = Math.max(30, Number(ttl || getTtl(scope)) || getTtl(scope));
    await Cache.cacheLazyLink(key, value, effectiveTtl);
    if (typeof incrementMetric === 'function') incrementMetric(`downloadLinkCache.${scope}.set`);
    logger?.info?.(`[PLAYBACK CACHE] set scope=${scope} key=${key} ttl=${effectiveTtl}s`);
    return true;
}

function wrapMediaFlowUrl(config = {}, streamData = {}) {
    if (!streamData?.url) return streamData;
    if (!(config.mediaflow && config.mediaflow.proxyDebrid && config.mediaflow.url)) return streamData;
    try {
        const mfpBase = String(config.mediaflow.url || '').replace(/\/$/, '');
        if (!mfpBase) return streamData;

        const inputHeaders = streamData.headers || streamData?.behaviorHints?.proxyHeaders?.request || {};
        const normalized = normalizeProxyTarget(streamData.url, inputHeaders, { config });
        const targetUrl = normalized.url || streamData.url;

        if (isAlreadyProxied(targetUrl, config)) {
            return {
                ...streamData,
                url: targetUrl,
                headers: normalized.headers,
                _proxyHeadersNormalized: true
            };
        }

        let finalUrl = `${mfpBase}/proxy/stream?d=${encodeURIComponent(targetUrl)}`;
        if (config.mediaflow.pass) finalUrl += `&api_password=${encodeURIComponent(config.mediaflow.pass)}`;
        finalUrl += normalized.headerQuery || '';

        return {
            ...streamData,
            url: finalUrl,
            headers: normalized.headers,
            _wrappedByMediaflow: true,
            _proxyHeadersNormalized: true,
            _proxyHeadersAuthMoved: Boolean(normalized.normalized?.authMoved)
        };
    } catch (_) {
        return streamData;
    }
}

module.exports = {
    DEFAULT_DOWNLOAD_LINK_TTL,
    DEFAULT_SAVED_CLOUD_TTL,
    DEFAULT_DIRECT_RESOLVE_TTL,
    buildLazyKey,
    buildSavedCloudKey,
    getTtl,
    get,
    set,
    wrapMediaFlowUrl
};
