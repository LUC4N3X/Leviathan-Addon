'use strict';

const axios = require('axios');
const { HTTP_AGENT, HTTPS_AGENT } = require('../../core/utils/http');
const tmdbHelper = require('../../core/utils/tmdb_helper');
const { SingleFlight, TtlLruCache } = require('../utils/provider_runtime');
const { withProviderHealth } = require('../utils/provider_health');
const { normalizeStreams } = require('../utils/stream_normalizer');
const {
    buildWebStream,
    normalizeQuality,
    pickBetterQuality,
    probePlaylistIntelligence,
    decorateStreamWithPlaylistIntelligence
} = require('../extractors/common');
const { extractFromUrl } = require('../extractors/registry');

const PROVIDER_ID = 'vidxgo';
const PROVIDER_LABEL = 'VidxGo';
const PROVIDER_CODE = 'VXG';

const PLAYER_BASE = String(process.env.VIDXGO_PLAYER_BASE || 'https://v.vidxgo.co').replace(/\/+$/, '');
const TIMEOUT_MS = Math.max(5000, Number.parseInt(process.env.VIDXGO_TIMEOUT_MS || '12000', 10) || 12000);
const PLAYLIST_TIMEOUT_MS = Math.max(2500, Number.parseInt(process.env.VIDXGO_PLAYLIST_TIMEOUT_MS || '5000', 10) || 5000);
const STREAM_TTL_MS = Math.max(60_000, Number.parseInt(process.env.VIDXGO_STREAM_TTL_MS || `${10 * 60 * 1000}`, 10) || 10 * 60 * 1000);
const EMPTY_TTL_MS = Math.max(15_000, Number.parseInt(process.env.VIDXGO_EMPTY_TTL_MS || '60000', 10) || 60000);
const DEBUG = /^(1|true|yes|on)$/i.test(String(process.env.VIDXGO_DEBUG || '0'));
const USER_AGENT = String(process.env.VIDXGO_USER_AGENT || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36');

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
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'it-IT,it;q=0.9,en-US;q=0.8,en;q=0.7'
    }
});

const cache = {
    streams: new TtlLruCache({ name: 'vidxgo:streams', ttlMs: STREAM_TTL_MS, staleTtlMs: STREAM_TTL_MS, max: 2500, cloneValues: true })
};

const singleFlight = new SingleFlight('vidxgo');

function log(message, meta = null) {
    if (!DEBUG) return;
    const suffix = meta ? ` ${JSON.stringify(meta)}` : '';
    console.log(`[VidxGo] ${message}${suffix}`);
}

function responseText(response) {
    if (typeof response?.data === 'string') return response.data;
    if (Buffer.isBuffer(response?.data)) return response.data.toString('utf8');
    if (response?.data == null) return '';
    return String(response.data);
}

function normalizeImdbId(value) {
    const match = String(value || '').match(/tt\d{5,12}/i);
    return match ? match[0].toLowerCase() : null;
}

function imdbFromMeta(meta = {}) {
    for (const value of [meta.imdb_id, meta.imdbId, meta.imdb, meta.id, meta.stremioId]) {
        const imdb = normalizeImdbId(value);
        if (imdb) return imdb;
    }
    return null;
}

function isSeriesRequest(meta = {}) {
    const type = String(meta.type || '').toLowerCase();
    return meta.isSeries === true
        || type === 'series'
        || type === 'tv'
        || Boolean(meta.season || meta.episode)
        || /:\d+:\d+/.test(String(meta.id || meta.imdb_id || ''));
}

async function resolveImdbId(meta = {}) {
    const direct = imdbFromMeta(meta);
    if (direct) return direct;
    const mediaType = isSeriesRequest(meta) ? 'tv' : 'movie';
    const resolved = await tmdbHelper.resolveFromMeta(meta, { type: mediaType }).catch(() => null);
    return normalizeImdbId(resolved?.imdb_id);
}

function buildPlayerUrl(imdbId, { series = false, season = null, episode = null } = {}) {
    const numeric = normalizeImdbId(imdbId)?.replace(/^tt/i, '');
    if (!numeric) return null;
    if (series) {
        if (!Number.isInteger(season) || !Number.isInteger(episode)) return null;
        return `${PLAYER_BASE}/${numeric}/${season}/${episode}`;
    }
    return `${PLAYER_BASE}/${numeric}`;
}

function extractYear(meta = {}) {
    const match = String(meta.year || meta.releaseYear || meta.released || '').match(/\b(19\d{2}|20\d{2})\b/);
    return match ? match[1] : null;
}

function buildDisplayTitle(meta = {}, { series = false, season = null, episode = null } = {}) {
    const base = String(meta.title || meta.name || meta.originalTitle || PROVIDER_LABEL).trim();
    if (series) return `${base} S${String(season).padStart(2, '0')}E${String(episode).padStart(2, '0')}`;
    const year = extractYear(meta);
    return year ? `${base} (${year})` : base;
}

async function resolvePlayerStream(playerUrl, displayTitle, { signal } = {}) {
    const extracted = await extractFromUrl(playerUrl, {
        client: http,
        userAgent: USER_AGENT,
        requestReferer: `${PLAYER_BASE}/`,
        referer: `${PLAYER_BASE}/`,
        pageUrl: playerUrl,
        fetchers: [
            (targetUrl, headers) => http.get(targetUrl, {
                headers,
                timeout: TIMEOUT_MS,
                responseType: 'text'
            }).then((response) => responseText(response))
        ]
    }).catch(() => null);

    if (!extracted?.url) return null;

    let quality = normalizeQuality(extracted.quality || 'Unknown');
    let playlistIntel = null;
    if (/\.m3u8(?:$|[?#])/i.test(String(extracted.url))) {
        playlistIntel = await probePlaylistIntelligence(http, extracted.url, {
            headers: extracted.headers || {},
            timeout: PLAYLIST_TIMEOUT_MS,
            signal
        }).catch(() => null);
        quality = pickBetterQuality(playlistIntel?.quality || 'Unknown', quality);
    }

    let stream = buildWebStream({
        name: `${PROVIDER_LABEL} | ${extracted.name || PROVIDER_LABEL}`,
        title: `${displayTitle}\n${extracted.name || PROVIDER_LABEL} ITA`,
        url: extracted.url,
        extractor: extracted.name || PROVIDER_LABEL,
        provider: PROVIDER_LABEL,
        providerCode: PROVIDER_CODE,
        quality,
        headers: extracted.headers
    });

    return decorateStreamWithPlaylistIntelligence(stream, playlistIntel);
}

async function searchVidxgoImpl(meta = {}, config = {}, reqHost = null) {
    if (!config?.filters?.enableVidxgo) return [];

    const series = isSeriesRequest(meta);
    let season = null;
    let episode = null;
    if (series) {
        season = Number.parseInt(meta.season, 10);
        episode = Number.parseInt(meta.episode, 10);
        if (!Number.isInteger(season) || season < 1 || !Number.isInteger(episode) || episode < 1) return [];
    }

    const imdbId = await resolveImdbId(meta);
    if (!imdbId) {
        log('imdb id not resolved', { title: meta.title || meta.name, type: meta.type });
        return [];
    }

    const cacheKey = `streams:${imdbId}:${series ? `${season}:${episode}` : 'movie'}`;
    const cached = cache.streams.get(cacheKey);
    if (cached) return cached;

    return singleFlight.do(cacheKey, async () => {
        const second = cache.streams.get(cacheKey);
        if (second) return second;

        const playerUrl = buildPlayerUrl(imdbId, { series, season, episode });
        if (!playerUrl) return [];

        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), Math.max(TIMEOUT_MS + 3000, 15000));

        try {
            const displayTitle = buildDisplayTitle(meta, { series, season, episode });
            const stream = await resolvePlayerStream(playerUrl, displayTitle, { signal: controller.signal });
            const streams = normalizeStreams(stream ? [stream] : [], {
                provider: PROVIDER_ID,
                providerLabel: PROVIDER_LABEL,
                providerCode: PROVIDER_CODE,
                sort: false,
                debug: DEBUG
            });
            const ttl = streams.length ? STREAM_TTL_MS : EMPTY_TTL_MS;
            cache.streams.set(cacheKey, streams, ttl, ttl);
            return streams;
        } catch (error) {
            log('provider failed', { error: error?.message || String(error) });
            return [];
        } finally {
            clearTimeout(timer);
        }
    });
}

async function searchVidxgo(meta = {}, config = {}, reqHost = null) {
    return withProviderHealth(PROVIDER_ID, () => searchVidxgoImpl(meta, config, reqHost), {
        timeoutMs: Math.max(15_000, TIMEOUT_MS + 5000),
        swallowErrors: true,
        fallbackValue: []
    });
}

module.exports = {
    searchVidxgo,
    searchVidxGo: searchVidxgo,
    buildPlayerUrl,
    resolveImdbId,
    isSeriesRequest,
    normalizeImdbId
};
