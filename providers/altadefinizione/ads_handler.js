'use strict';

const axios = require('axios');
const { HTTP_AGENT, HTTPS_AGENT } = require('../../core/utils/http');
const tmdbHelper = require('../../core/utils/tmdb_helper');
const { SingleFlight, TtlLruCache } = require('../utils/provider_runtime');
const { withProviderHealth } = require('../utils/provider_health');
const { normalizeStreams } = require('../utils/stream_normalizer');
const {
    buildWebStream,
    buildMediaflowUrl,
    dedupeStreamsByUrl,
    normalizeQuality,
    normalizeRemoteUrl,
    pickBetterQuality,
    probePlaylistIntelligence,
    decorateStreamWithPlaylistIntelligence,
    qualityRank
} = require('../extractors/common');
const { extractFromUrl, resolveExtractorDefinition } = require('../extractors/registry');

const PROVIDER_ID = 'altadefinizione';
const PROVIDER_LABEL = 'AltadefinizioneStreaming';
const PROVIDER_CODE = 'ADS';
const BASE_URL = String(process.env.ALTADEFINIZIONE_BASE_URL || 'https://altadefinizionestreaming.com').replace(/\/+$/, '');
const USER_AGENT = String(process.env.ALTADEFINIZIONE_USER_AGENT || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Safari/537.36');
const TIMEOUT_MS = Math.max(5000, Number.parseInt(process.env.ALTADEFINIZIONE_TIMEOUT_MS || '12000', 10) || 12000);
const STREAM_TTL_MS = Math.max(60_000, Number.parseInt(process.env.ALTADEFINIZIONE_STREAM_TTL_MS || String(10 * 60 * 1000), 10) || 10 * 60 * 1000);
const JSON_TTL_MS = Math.max(60_000, Number.parseInt(process.env.ALTADEFINIZIONE_JSON_TTL_MS || String(30 * 60 * 1000), 10) || 30 * 60 * 1000);
const MAX_SOURCES = Math.max(1, Math.min(8, Number.parseInt(process.env.ALTADEFINIZIONE_MAX_SOURCES || '4', 10) || 4));
const DEBUG = /^(1|true|yes|on)$/i.test(String(process.env.ALTADEFINIZIONE_DEBUG || '0'));

const http = axios.create({
    timeout: TIMEOUT_MS,
    httpAgent: HTTP_AGENT,
    httpsAgent: HTTPS_AGENT,
    maxRedirects: 5,
    decompress: true,
    proxy: false,
    validateStatus: (status) => status >= 200 && status < 400,
    headers: {
        'User-Agent': USER_AGENT,
        Accept: 'application/json,text/plain,*/*',
        'Accept-Language': 'it-IT,it;q=0.9,en-US;q=0.8,en;q=0.7',
        Referer: `${BASE_URL}/`
    }
});

const cache = {
    json: new TtlLruCache({ name: 'altadefinizione:json', ttlMs: JSON_TTL_MS, staleTtlMs: JSON_TTL_MS, max: 800, cloneValues: true }),
    streams: new TtlLruCache({ name: 'altadefinizione:streams', ttlMs: STREAM_TTL_MS, staleTtlMs: STREAM_TTL_MS, max: 1600, cloneValues: true })
};

const singleFlight = new SingleFlight('altadefinizione');

function log(message, meta = null) {
    if (!DEBUG) return;
    const suffix = meta ? ` ${JSON.stringify(meta)}` : '';
    console.log(`[Altadefinizione] ${message}${suffix}`);
}

function responseData(response) {
    return response?.data && typeof response.data === 'object' ? response.data : null;
}

function originOf(value, fallback = BASE_URL) {
    try { return new URL(String(value || fallback)).origin; } catch (_) { return fallback; }
}

function headersFor(url, referer = BASE_URL) {
    return {
        'User-Agent': USER_AGENT,
        Accept: '*/*',
        'Accept-Language': 'it-IT,it;q=0.9,en-US;q=0.8,en;q=0.7',
        Referer: referer || `${BASE_URL}/`,
        Origin: originOf(referer || url, BASE_URL)
    };
}

async function fetchJson(url, { ttlMs = JSON_TTL_MS } = {}) {
    const cached = cache.json.get(url);
    if (cached) return cached;

    return singleFlight.do(`json:${url}`, async () => {
        const second = cache.json.get(url);
        if (second) return second;
        const response = await http.get(url, { headers: headersFor(url, `${BASE_URL}/`) });
        const data = responseData(response);
        if (data) cache.json.set(url, data, ttlMs, ttlMs);
        return data;
    });
}

function normalizeImdbId(value) {
    const match = String(value || '').match(/tt\d{5,12}/i);
    return match ? match[0].toLowerCase() : null;
}

function normalizeProviderType(value) {
    const type = String(value || '').trim().toLowerCase();
    return type === 'movie' || type === 'film' ? 'movie' : 'tv';
}

function parsePositiveInt(...values) {
    for (const value of values) {
        const parsed = Number.parseInt(String(value ?? '').trim(), 10);
        if (Number.isInteger(parsed) && parsed > 0) return parsed;
    }
    return null;
}

function extractTmdbId(value) {
    const raw = String(value || '').trim();
    const match = raw.match(/(?:tmdb:)?(?:movie:|tv:|series:)?(\d+)/i);
    return match?.[1] || null;
}

function buildPlayerSourcesEndpoint({ tmdbId, type, season = 1, episode = 1 }) {
    const cleanTmdbId = extractTmdbId(tmdbId);
    if (!cleanTmdbId) return null;
    const providerType = normalizeProviderType(type);
    if (providerType === 'movie') return `${BASE_URL}/api/player-sources/movie/${cleanTmdbId}`;
    return `${BASE_URL}/api/player-sources/tv/${cleanTmdbId}/${Number(season) || 1}/${Number(episode) || 1}`;
}

function buildDownloadEndpoint({ tmdbId, type }) {
    const cleanTmdbId = extractTmdbId(tmdbId);
    if (!cleanTmdbId) return null;
    return normalizeProviderType(type) === 'movie'
        ? `${BASE_URL}/api/download/${cleanTmdbId}`
        : `${BASE_URL}/api/download-episodes/${cleanTmdbId}`;
}

function isVidxgoUrl(url) {
    try {
        const host = new URL(String(url || '')).hostname.replace(/^www\./i, '').toLowerCase();
        return /(?:^|\.)(?:v\.)?vidxgo\.(?:co|com|net|to)$/i.test(host);
    } catch (_) {
        return /vidxgo/i.test(String(url || ''));
    }
}

function isBlockedSource(source = {}) {
    const text = `${source.provider || ''} ${source.url || ''}`;
    return /vixsrc\.to|vixsrc/i.test(text);
}

function sourceExtractorLabel(source = {}) {
    const text = String(source.provider || source.name || source.label || source.url || '').trim();
    const url = String(source.url || '');
    if (/vidx\s*go|vidxgo/i.test(text) || isVidxgoUrl(url)) return 'VidxGo';
    if (/cdn/i.test(text)) return 'CDN';
    const def = resolveExtractorDefinition(url);
    return def?.label || (text ? text.replace(/\s+/g, ' ') : 'Direct');
}

function sourcePriority(source = {}) {
    const extractor = String(source.extractor || sourceExtractorLabel(source)).toLowerCase();
    if (/vidxgo|vidx\s*go/i.test(extractor)) return 0;
    if (/cdn/.test(extractor)) return 20;
    const def = resolveExtractorDefinition(source.url);
    return def?.priority != null ? 30 + def.priority : 80;
}

function shouldExposeLazyFallback() {
    return false;
}

function buildSyntheticVidxgoUrl(imdbId, type, season = 1, episode = 1) {
    const normalized = normalizeImdbId(imdbId);
    if (!normalized) return null;
    const numeric = normalized.replace(/^tt/i, '');
    if (!numeric) return null;
    if (normalizeProviderType(type) === 'movie') return `https://v.vidxgo.co/${numeric}`;
    return `https://v.vidxgo.co/${numeric}/${Number(season) || 1}/${Number(episode) || 1}`;
}

function collectPlayableSources({ payload = {}, imdbId = null, type = 'movie', season = 1, episode = 1 } = {}) {
    const out = [];
    const seen = new Set();
    const add = (source = {}) => {
        if (isBlockedSource(source)) return;
        const url = normalizeRemoteUrl(source.url, BASE_URL);
        if (!url || seen.has(url)) return;
        const extractor = sourceExtractorLabel({ ...source, url });
        seen.add(url);
        out.push({
            url,
            extractor,
            provider: source.provider || extractor,
            quality: normalizeQuality(source.quality || source.label || source.name || 'Unknown'),
            priority: sourcePriority({ ...source, url, extractor })
        });
    };

    for (const source of Array.isArray(payload?.sources) ? payload.sources : []) add(source);

    if (!out.some((source) => source.extractor === 'VidxGo')) {
        const synthetic = buildSyntheticVidxgoUrl(imdbId, type, season, episode);
        if (synthetic) add({ provider: 'VidxGo', url: synthetic, quality: 'Unknown' });
    }

    return out.sort((a, b) => (a.priority - b.priority) || (qualityRank(b.quality) - qualityRank(a.quality)));
}

async function resolveDownloadToHoster(url, client = http) {
    const downloadUrl = normalizeRemoteUrl(url, BASE_URL);
    if (!downloadUrl) return null;
    const target = `${downloadUrl}${downloadUrl.includes('?') ? '&' : '?'}go=1`;
    try {
        const response = await client.get(target, {
            maxRedirects: 5,
            headers: headersFor(target, `${BASE_URL}/`),
            validateStatus: () => true
        });
        const finalUrl = normalizeRemoteUrl(response?.request?.res?.responseUrl || response?.request?._redirectable?._currentUrl || response?.config?.url || '', BASE_URL);
        if (finalUrl && resolveExtractorDefinition(finalUrl)) return finalUrl.replace(/\?download$/i, '');
    } catch (_) {}
    return null;
}

async function collectDownloadSources({ tmdbId, type, season, episode }) {
    const endpoint = buildDownloadEndpoint({ tmdbId, type });
    if (!endpoint) return [];
    const payload = await fetchJson(endpoint).catch(() => null);
    if (!payload?.available) return [];

    let downloadUrl = payload.url || null;
    if (normalizeProviderType(type) !== 'movie') {
        const episodes = Array.isArray(payload.episodes) ? payload.episodes : [];
        const match = episodes.find((item) => Number(item?.season) === Number(season) && Number(item?.episode) === Number(episode));
        downloadUrl = match?.url || null;
    }

    const hosterUrl = await resolveDownloadToHoster(downloadUrl);
    if (!hosterUrl) return [];
    const def = resolveExtractorDefinition(hosterUrl);
    return [{
        url: hosterUrl,
        extractor: def?.label || sourceExtractorLabel({ url: hosterUrl }),
        provider: def?.label || 'Hoster',
        quality: 'Unknown',
        priority: 30 + (def?.priority ?? 9)
    }];
}

function buildMediaflowFallbackStream(source, def, { title, config = {}, pageUrl = BASE_URL } = {}) {
    if (!config?.mediaflow?.url) return null;
    const host = def?.label || source.extractor || source.provider || 'VidxGo';
    const mediaflowUrl = buildMediaflowUrl(config, source.url, 'extractor', host, {
        redirectStream: true,
        headers: headersFor(source.url, pageUrl)
    });
    if (!mediaflowUrl || mediaflowUrl === source.url) return null;

    return buildWebStream({
        name: `${PROVIDER_LABEL} | ${host} MFP`,
        title: `${title}\n${host} ITA`,
        url: mediaflowUrl,
        extractor: host,
        provider: PROVIDER_LABEL,
        providerCode: PROVIDER_CODE,
        quality: source.quality || 'Unknown',
        headers: null,
        mediaflowUrl: config.mediaflow.url,
        extraBehaviorHints: {
            vortexMeta: {
                via: 'altadefinizione-mfp',
                sourceUrl: source.url
            }
        },
        extra: { _priority: source.priority ?? def?.priority ?? 9 }
    });
}

async function resolveSourceToStream(source, { title, reqHost, pageUrl = BASE_URL, signal = null, config = {}, extract = extractFromUrl } = {}) {
    const def = resolveExtractorDefinition(source.url);
    if (def) {
        const extracted = await extract(source.url, {
            client: http,
            userAgent: USER_AGENT,
            requestReferer: pageUrl,
            referer: pageUrl
        }).catch(() => null);

        if (!extracted?.url) {
            log('skip unresolved hoster instead of exposing lazy stream', {
                extractor: source.extractor || def.label,
                host: (() => { try { return new URL(source.url).hostname; } catch (_) { return ''; } })()
            });
            const mediaflowFallback = buildMediaflowFallbackStream(source, def, { title, config, pageUrl });
            if (mediaflowFallback) return mediaflowFallback;
            if (!shouldExposeLazyFallback(source, def)) return null;
            return null;
        }

        let quality = pickBetterQuality(extracted.quality || 'Unknown', source.quality || 'Unknown');
        let playlistIntel = null;
        if (/\.m3u8(?:$|[?#])/i.test(String(extracted.url || ''))) {
            playlistIntel = await probePlaylistIntelligence(http, extracted.url, {
                headers: extracted.headers || headersFor(extracted.url, source.url),
                timeout: Number.parseInt(process.env.ALTADEFINIZIONE_PLAYLIST_TIMEOUT_MS || '5000', 10) || 5000,
                signal
            }).catch(() => null);
            quality = pickBetterQuality(playlistIntel?.quality || 'Unknown', quality);
        }

        let stream = buildWebStream({
            name: `${PROVIDER_LABEL} | ${extracted.name || source.extractor || def.label}`,
            title: `${title}\n${extracted.name || source.extractor || def.label} ITA`,
            url: extracted.url,
            extractor: extracted.name || source.extractor || def.label,
            provider: PROVIDER_LABEL,
            providerCode: PROVIDER_CODE,
            quality,
            headers: extracted.headers || headersFor(extracted.url, source.url),
            extra: { _priority: source.priority ?? extracted.priority ?? def.priority ?? 9 }
        });
        stream = decorateStreamWithPlaylistIntelligence(stream, playlistIntel);
        return stream;
    }

    return buildWebStream({
        name: `${PROVIDER_LABEL} | ${source.extractor || 'Direct'}`,
        title: `${title}\n${source.extractor || 'Direct'} ITA`,
        url: source.url,
        extractor: source.extractor || 'Direct',
        provider: PROVIDER_LABEL,
        providerCode: PROVIDER_CODE,
        quality: source.quality || 'Unknown',
        headers: headersFor(source.url, pageUrl),
        extra: { _priority: source.priority ?? 80 }
    });
}

async function resolveMedia(meta = {}, finalId = null, config = {}) {
    const type = normalizeProviderType(meta.type || (meta.isSeries ? 'tv' : 'movie'));
    const season = parsePositiveInt(meta.season, meta.s, String(finalId || '').split(':')[1]) || 1;
    const episode = parsePositiveInt(meta.episode, meta.e, String(finalId || '').split(':')[2]) || 1;
    const explicitTmdbId = extractTmdbId(meta.tmdb_id || meta.tmdbId || meta.tmdb || (/^\d+$/.test(String(finalId || '')) ? finalId : ''));
    const imdbId = normalizeImdbId(meta.imdb_id || meta.imdbId || meta.imdb || meta.id || finalId);

    if (explicitTmdbId) {
        return {
            tmdbId: explicitTmdbId,
            imdbId,
            type,
            season,
            episode,
            title: meta.title || meta.name || (type === 'movie' ? 'Film' : 'Serie')
        };
    }

    const resolved = await tmdbHelper.resolveFromMeta({ ...meta, id: finalId || meta.id }, {
        type,
        language: 'it-IT',
        userKey: config?.tmdbApiKey || config?.tmdbKey || null
    }).catch(() => null);

    if (!resolved?.tmdbId && !resolved?.tmdb_id) return null;
    return {
        tmdbId: String(resolved.tmdbId || resolved.tmdb_id),
        imdbId: normalizeImdbId(resolved.imdbId || resolved.imdb_id || imdbId),
        type,
        season,
        episode,
        title: resolved.title || resolved.name || meta.title || meta.name || (type === 'movie' ? 'Film' : 'Serie')
    };
}

function streamCacheKey(media = {}) {
    return `${media.type}:${media.tmdbId}:${media.season || 0}:${media.episode || 0}`;
}

async function searchAltadefinizioneImpl(originalId, finalId, meta = {}, config = {}, reqHost = null) {
    if (config?.filters && config.filters.enableCc !== true && config.filters.enableAltadefinizione !== true) return [];

    const media = await resolveMedia(meta, finalId || originalId, config);
    if (!media?.tmdbId) return [];

    const cacheKey = `streams:${streamCacheKey(media)}`;
    const cached = cache.streams.get(cacheKey);
    if (cached) return cached;

    const endpoint = buildPlayerSourcesEndpoint(media);
    if (!endpoint) return [];

    const payload = await fetchJson(endpoint).catch((error) => {
        log('player source fetch failed', { error: error?.message || String(error), endpoint });
        return null;
    });

    const apiSources = collectPlayableSources({
        payload,
        imdbId: media.imdbId,
        type: media.type,
        season: media.season,
        episode: media.episode
    });
    const downloadSources = await collectDownloadSources(media).catch(() => []);
    const sources = Array.from(new Map([...apiSources, ...downloadSources]
        .sort((a, b) => (a.priority ?? 99) - (b.priority ?? 99))
        .map((source) => [source.url, source]))
        .values())
        .slice(0, MAX_SOURCES);

    if (!sources.length) {
        cache.streams.set(cacheKey, [], 60_000, 60_000);
        return [];
    }

    const displayTitle = media.type === 'movie'
        ? media.title
        : `${media.title} S${String(media.season).padStart(2, '0')}E${String(media.episode).padStart(2, '0')}`;
    const streams = (await Promise.all(sources.map((source) => resolveSourceToStream(source, {
        title: displayTitle,
        reqHost,
        pageUrl: endpoint,
        config
    }).catch(() => null))))
        .filter(Boolean)
        .sort((a, b) => (a._priority ?? 99) - (b._priority ?? 99));

    const normalized = normalizeStreams(dedupeStreamsByUrl(streams).map((stream) => {
        delete stream._priority;
        return stream;
    }), {
        provider: PROVIDER_ID,
        providerLabel: PROVIDER_LABEL,
        providerCode: PROVIDER_CODE,
        sort: false,
        debug: DEBUG
    });

    cache.streams.set(cacheKey, normalized, normalized.length ? STREAM_TTL_MS : 60_000, normalized.length ? STREAM_TTL_MS : 60_000);
    return normalized;
}

async function searchAltadefinizione(originalId, finalId, meta = {}, config = {}, reqHost = null) {
    return withProviderHealth(PROVIDER_ID, () => searchAltadefinizioneImpl(originalId, finalId, meta, config, reqHost), {
        timeoutMs: Math.max(15_000, TIMEOUT_MS + 5000),
        swallowErrors: true,
        fallbackValue: []
    });
}

module.exports = {
    searchAltadefinizione,
    searchAltadefinizioneStreaming: searchAltadefinizione,
    __private: {
        buildPlayerSourcesEndpoint,
        buildSyntheticVidxgoUrl,
        collectPlayableSources,
        normalizeImdbId,
        resolveDownloadToHoster,
        resolveSourceToStream,
        resolveMedia,
        shouldExposeLazyFallback,
        sourceExtractorLabel
    }
};
