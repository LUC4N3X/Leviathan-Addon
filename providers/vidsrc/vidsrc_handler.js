'use strict';

const tmdbHelper = require('../../core/utils/tmdb_helper');
const { SingleFlight, TtlLruCache } = require('../utils/provider_runtime');
const { withProviderHealth } = require('../utils/provider_health');
const { normalizeStreams } = require('../utils/stream_normalizer');
const { buildWebStream, normalizeQuality } = require('../extractors/common');
const { createMediaflowGateway } = require('../../core/proxy/mediaflow_gateway');

const PROVIDER_ID = 'vidsrc';
const PROVIDER_LABEL = 'VidSrc';
const PROVIDER_CODE = 'VSR';

// VidSrc is an international embed source: the extraction is delegated entirely
// to Kraken (via /extractor/video). We keep the integration ITA-first by asking
// VidSrc for the Italian track (`ds_lang=it`) and tagging the resulting stream
// as Italian audio, consistent with the rest of Leviathan.
const DEFAULT_DS_LANG = 'it';

/** Read a boolean-ish env var, returning `fallback` when unset/empty. */
function envFlag(name, fallback = false) {
    const value = process.env[name];
    if (value === undefined || value === null || value === '') return fallback;
    return /^(1|true|yes|on)$/i.test(String(value).trim());
}

/** Parse a positive integer, clamping to `fallback` when invalid or below `minimum`. */
function positiveInt(value, fallback, minimum = 1) {
    const parsed = Number.parseInt(value, 10);
    if (!Number.isFinite(parsed) || parsed < minimum) return fallback;
    return parsed;
}

/** Normalise a value into a scheme-qualified origin URL without trailing slash, or null. */
function normalizeBaseUrl(value) {
    const raw = String(value || '').trim();
    if (!raw) return null;
    try {
        const parsed = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
        parsed.hash = '';
        parsed.search = '';
        return parsed.toString().replace(/\/+$/, '');
    } catch (_) {
        return null;
    }
}

// vidsrc.cc serves the cloudnestra /rcp/ iframe in static HTML (vidsrc.ru does not);
// the Kraken extractor additionally falls back across known embed mirrors.
const EMBED_BASE = normalizeBaseUrl(process.env.VIDSRC_EMBED_BASE || 'https://vidsrc.cc') || 'https://vidsrc.cc';
const DS_LANG = String(process.env.VIDSRC_DS_LANG || DEFAULT_DS_LANG).trim() || DEFAULT_DS_LANG;
const STREAM_TTL_MS = positiveInt(process.env.VIDSRC_STREAM_TTL_MS, 10 * 60 * 1000, 60_000);
const STALE_STREAM_TTL_MS = Math.max(STREAM_TTL_MS, positiveInt(process.env.VIDSRC_STALE_STREAM_TTL_MS, 45 * 60 * 1000, STREAM_TTL_MS));
const EMPTY_TTL_MS = positiveInt(process.env.VIDSRC_EMPTY_TTL_MS, 60_000, 15_000);
const DEBUG = envFlag('VIDSRC_DEBUG', false);

const cache = {
    streams: new TtlLruCache({
        name: 'vidsrc:streams',
        ttlMs: STREAM_TTL_MS,
        staleTtlMs: STALE_STREAM_TTL_MS,
        max: 2500,
        cloneValues: true,
        sweepIntervalOps: 50
    })
};

const singleFlight = new SingleFlight('vidsrc');

/** Debug logger gated by VIDSRC_DEBUG. */
function log(message, meta = null) {
    if (!DEBUG) return;
    const suffix = meta ? ` ${JSON.stringify(meta)}` : '';
    console.log(`[VidSrc] ${message}${suffix}`);
}

/** Extract the first positive integer found in a value, or null. */
function parsePositiveNumber(value) {
    if (value === null || value === undefined || value === '') return null;
    const match = String(value).match(/\d+/);
    if (!match) return null;
    const parsed = Number.parseInt(match[0], 10);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

/** Heuristically decide whether the request targets a TV series/episode. */
function isSeriesRequest(meta = {}) {
    const type = String(meta.type || '').toLowerCase();
    const idHaystack = String(meta.id || meta.imdb_id || meta.imdbId || meta.stremioId || '');
    return meta.isSeries === true
        || type === 'series'
        || type === 'tv'
        || Boolean(meta.season || meta.episode || meta.seasonNumber || meta.episodeNumber)
        || /tt\d{5,12}:\d+:\d+/i.test(idHaystack);
}

/** Pull season/episode out of a packed Stremio id (e.g. ttID:1:2). */
function episodeFromPackedId(value) {
    const match = String(value || '').match(/tt\d{5,12}:(\d{1,3}):(\d{1,4})/i)
        || String(value || '').match(/:(\d{1,3}):(\d{1,4})(?:$|[^\d])/);
    if (!match) return { season: null, episode: null };
    return {
        season: parsePositiveNumber(match[1]),
        episode: parsePositiveNumber(match[2])
    };
}

/** Resolve {season, episode, valid} from explicit fields or a packed id. */
function normalizeEpisodeInfo(meta = {}) {
    const packed = episodeFromPackedId(meta.id || meta.stremioId || meta.imdb_id || meta.imdbId);
    const season = parsePositiveNumber(meta.season ?? meta.seasonNumber) || packed.season;
    const episode = parsePositiveNumber(meta.episode ?? meta.episodeNumber) || packed.episode;
    return {
        season,
        episode,
        valid: Number.isInteger(season) && season > 0 && Number.isInteger(episode) && episode > 0
    };
}

/** Resolve a TMDB id from meta, falling back to a TMDB lookup (vidsrc is TMDB-first). */
async function resolveTmdbId(meta = {}, config = {}) {
    const direct = tmdbHelper.normalizeTmdbId(meta.tmdb_id || meta.tmdbId || meta.tmdb);
    if (direct) return String(direct);

    const mediaType = isSeriesRequest(meta) ? 'tv' : 'movie';
    const userKey = config?.tmdbApiKey || config?.tmdb?.apiKey || null;
    const resolved = await tmdbHelper.resolveFromMeta(meta, { type: mediaType, userKey }).catch(() => null);
    const tmdbId = tmdbHelper.normalizeTmdbId(resolved?.tmdb_id || resolved?.tmdbId);
    return tmdbId ? String(tmdbId) : null;
}

/** Build the vidsrc embed URL (ITA-first via ds_lang) for a movie or episode. */
function buildEmbedUrl(tmdbId, { series = false, season = null, episode = null } = {}) {
    const base = EMBED_BASE;
    const path = series
        ? `/embed/tv/${tmdbId}/${season}/${episode}`
        : `/embed/movie/${tmdbId}`;
    const query = DS_LANG ? `?ds_lang=${encodeURIComponent(DS_LANG)}` : '';
    return `${base}${path}${query}`;
}

/** Extract a 4-digit release year from meta, or null. */
function extractYear(meta = {}) {
    const match = String(meta.year || meta.releaseYear || meta.released || '').match(/\b(19\d{2}|20\d{2})\b/);
    return match ? match[1] : null;
}

/** Build the human-readable title shown in the stream (adds SxxExx or year). */
function buildDisplayTitle(meta = {}, { series = false, season = null, episode = null } = {}) {
    const base = String(meta.title || meta.name || meta.originalTitle || PROVIDER_LABEL).trim();
    if (series) return `${base} S${String(season).padStart(2, '0')}E${String(episode).padStart(2, '0')}`;
    const year = extractYear(meta);
    return year ? `${base} (${year})` : base;
}

/** Compose the two-line stream subtitle, tagging the ITA audio track. */
function buildStreamTitle(displayTitle) {
    return [displayTitle, `${PROVIDER_LABEL} ITA`].filter(Boolean).join('\n');
}

/** Build the per-content cache key (movie vs season/episode). */
function createContentKey(tmdbId, { series = false, season = null, episode = null } = {}) {
    return `${tmdbId || 'unknown'}:${series ? `s${season}e${episode}` : 'movie'}`;
}

/** Core search: resolve TMDB, build the embed, and return a Kraken-proxied ITA stream (cached). */
async function searchVidsrcImpl(meta = {}, config = {}, reqHost = null) {
    if (!config?.filters?.enableVidsrc) return [];

    // Extraction is performed entirely on Kraken; without a configured Kraken /
    // MediaFlow endpoint there is nothing this provider can do.
    const gateway = createMediaflowGateway(config);
    if (!gateway.isConfigured) {
        log('kraken endpoint not configured, skipping');
        return [];
    }

    const tmdbId = await resolveTmdbId(meta, config);
    if (!tmdbId) {
        log('tmdb id not resolved', { title: meta.title || meta.name, type: meta.type });
        return [];
    }

    const series = isSeriesRequest(meta);
    const episodeInfo = series ? normalizeEpisodeInfo(meta) : { season: null, episode: null, valid: true };
    if (series && !episodeInfo.valid) {
        log('series request without valid season/episode', { id: meta.id, season: meta.season, episode: meta.episode });
        return [];
    }

    const season = series ? episodeInfo.season : null;
    const episode = series ? episodeInfo.episode : null;
    const contentKey = createContentKey(tmdbId, { series, season, episode });
    const cacheKey = `streams:${contentKey}`;
    const cachedFresh = cache.streams.get(cacheKey);
    if (cachedFresh) return cachedFresh;

    return singleFlight.do(cacheKey, async () => {
        const second = cache.streams.get(cacheKey);
        if (second) return second;

        const embedUrl = buildEmbedUrl(tmdbId, { series, season, episode });
        // Hand the whole extraction to Kraken: host=VidSrc selects the Kraken
        // VidSrc extractor, which resolves the embed -> cloudnestra -> HLS chain.
        const krakenUrl = gateway.buildExtractorUrl(embedUrl, PROVIDER_LABEL, {
            extractorPath: '/extractor/video.m3u8',
            redirectStream: true
        });

        if (!krakenUrl || krakenUrl === embedUrl) {
            log('failed to build kraken extractor url', { embedUrl });
            return [];
        }

        const displayTitle = buildDisplayTitle(meta, { series, season, episode });
        const stream = buildWebStream({
            name: `${PROVIDER_LABEL} | Kraken`,
            title: buildStreamTitle(displayTitle),
            url: krakenUrl,
            extractor: PROVIDER_LABEL,
            provider: PROVIDER_LABEL,
            providerCode: PROVIDER_CODE,
            quality: normalizeQuality('Unknown'),
            extraBehaviorHints: {
                vortexMeta: {
                    providerId: PROVIDER_ID,
                    providerCode: PROVIDER_CODE,
                    tmdbId,
                    contentKey,
                    sourceUrl: embedUrl,
                    extractionRuntime: 'kraken',
                    series,
                    season: series ? season : undefined,
                    episode: series ? episode : undefined,
                    language: 'ita',
                    audioLanguages: ['ita']
                }
            },
            extra: {
                audioLanguages: ['ita']
            }
        });

        const streams = normalizeStreams([stream], {
            provider: PROVIDER_ID,
            providerLabel: PROVIDER_LABEL,
            providerCode: PROVIDER_CODE,
            sort: false,
            debug: DEBUG
        });

        const ttl = streams.length ? STREAM_TTL_MS : EMPTY_TTL_MS;
        const staleTtl = streams.length ? STALE_STREAM_TTL_MS : EMPTY_TTL_MS;
        cache.streams.set(cacheKey, streams, ttl, staleTtl, { contentKey, tmdbId, series, season, episode });
        return streams;
    });
}

/** Public entry point: run the VidSrc search under provider health/timeout guards. */
async function searchVidsrc(meta = {}, config = {}, reqHost = null) {
    // Internal guard timeout (fires first). Kept distinct from VIDSRC_PROVIDER_TIMEOUT,
    // which the provider registry uses only for the outer orchestrator minimum.
    return withProviderHealth(PROVIDER_ID, () => searchVidsrcImpl(meta, config, reqHost), {
        timeoutMs: positiveInt(process.env.VIDSRC_INTERNAL_TIMEOUT, 22_000, 8_000),
        swallowErrors: true,
        fallbackValue: []
    });
}

module.exports = {
    searchVidsrc,
    buildEmbedUrl,
    resolveTmdbId,
    isSeriesRequest,
    normalizeEpisodeInfo
};
