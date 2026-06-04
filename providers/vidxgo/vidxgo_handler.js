'use strict';

const axios = require('axios');
const { HTTP_AGENT, HTTPS_AGENT } = require('../../core/utils/http');
const tmdbHelper = require('../../core/utils/tmdb_helper');
const animeIdentity = require('../anime/anime_identity');
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

function envFlag(name, fallback = false) {
    const value = process.env[name];
    if (value === undefined || value === null || value === '') return fallback;
    return /^(1|true|yes|on)$/i.test(String(value).trim());
}

function positiveInt(value, fallback, minimum = 1) {
    const parsed = Number.parseInt(value, 10);
    if (!Number.isFinite(parsed) || parsed < minimum) return fallback;
    return parsed;
}

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

function uniq(values = []) {
    const out = [];
    for (const value of values) {
        const clean = String(value || '').trim();
        if (clean && !out.includes(clean)) out.push(clean);
    }
    return out;
}

function splitList(value) {
    if (Array.isArray(value)) return value.flatMap((item) => splitList(item));
    return String(value || '')
        .split(/[\n,|]+/g)
        .map((item) => item.trim())
        .filter(Boolean);
}

const PLAYER_BASE = normalizeBaseUrl(process.env.VIDXGO_PLAYER_BASE || 'https://v.vidxgo.co') || 'https://v.vidxgo.co';
const TIMEOUT_MS = positiveInt(process.env.VIDXGO_TIMEOUT_MS, 12_000, 5_000);
const PLAYLIST_TIMEOUT_MS = positiveInt(process.env.VIDXGO_PLAYLIST_TIMEOUT_MS, 5_000, 2_500);
const STREAM_TTL_MS = positiveInt(process.env.VIDXGO_STREAM_TTL_MS, 10 * 60 * 1000, 60_000);
const STALE_STREAM_TTL_MS = Math.max(
    STREAM_TTL_MS,
    positiveInt(process.env.VIDXGO_STALE_STREAM_TTL_MS, 45 * 60 * 1000, STREAM_TTL_MS)
);
const EMPTY_TTL_MS = positiveInt(process.env.VIDXGO_EMPTY_TTL_MS, 60_000, 15_000);
const BASE_HEALTH_TTL_MS = positiveInt(process.env.VIDXGO_BASE_HEALTH_TTL_MS, 6 * 60 * 60 * 1000, 60_000);
const MAX_PLAYER_ATTEMPTS = positiveInt(process.env.VIDXGO_MAX_PLAYER_ATTEMPTS, 2, 1);
const STALE_ON_ERROR = envFlag('VIDXGO_STALE_ON_ERROR', true);
const KITSU_LOOKUP = envFlag('VIDXGO_KITSU_LOOKUP', true);
const KITSU_TITLE_FALLBACK = envFlag('VIDXGO_KITSU_TITLE_FALLBACK', true);
const KITSU_DEFAULT_SEASON = envFlag('VIDXGO_KITSU_DEFAULT_SEASON', true);
const KITSU_CONTEXT_TTL_MS = positiveInt(process.env.VIDXGO_KITSU_CONTEXT_TTL_MS, 6 * 60 * 60 * 1000, 60_000);
const KITSU_CONTEXT_STALE_TTL_MS = positiveInt(process.env.VIDXGO_KITSU_CONTEXT_STALE_TTL_MS, 3 * 24 * 60 * 60 * 1000, KITSU_CONTEXT_TTL_MS);
const KITSU_LOOKUP_TIMEOUT_MS = positiveInt(process.env.VIDXGO_KITSU_LOOKUP_TIMEOUT_MS, 3200, 800);
const KITSU_MAPPING_TIMEOUT_MS = positiveInt(process.env.VIDXGO_KITSU_MAPPING_TIMEOUT_MS, 2600, 800);
const KITSU_TMDB_TIMEOUT_MS = positiveInt(process.env.VIDXGO_KITSU_TMDB_TIMEOUT_MS, 2600, 800);
const DEBUG = envFlag('VIDXGO_DEBUG', false);
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
    streams: new TtlLruCache({
        name: 'vidxgo:streams',
        ttlMs: STREAM_TTL_MS,
        staleTtlMs: STALE_STREAM_TTL_MS,
        max: 2500,
        cloneValues: true,
        sweepIntervalOps: 50
    }),
    baseHealth: new TtlLruCache({
        name: 'vidxgo:base-health',
        ttlMs: BASE_HEALTH_TTL_MS,
        staleTtlMs: BASE_HEALTH_TTL_MS,
        max: 200,
        cloneValues: false
    }),
    kitsuContext: new TtlLruCache({
        name: 'vidxgo:kitsu-context',
        ttlMs: KITSU_CONTEXT_TTL_MS,
        staleTtlMs: KITSU_CONTEXT_STALE_TTL_MS,
        max: 1500,
        cloneValues: true,
        sweepIntervalOps: 50
    })
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
    const idHaystack = String(meta.id || meta.imdb_id || meta.imdbId || meta.stremioId || meta.videoId || meta.kitsuId || meta.kitsu || '');
    return meta.isSeries === true
        || type === 'series'
        || type === 'tv'
        || type === 'anime'
        || Boolean(meta.season || meta.episode || meta.seasonNumber || meta.episodeNumber)
        || /tt\d{5,12}:\d+:\d+/i.test(idHaystack)
        || /(?:^|[^a-z])kitsu(?::|\/|_|-)(?:anime(?::|\/|_|-))?\d+(?::\d+){1,2}/i.test(idHaystack)
        || /(?:^|[^a-z])(?:mal|myanimelist|anilist)(?::|\/|_|-)\d+(?::\d+){1,2}/i.test(idHaystack);
}

function parsePositiveNumber(value) {
    if (value === null || value === undefined || value === '') return null;
    const match = String(value).match(/\d+/);
    if (!match) return null;
    const parsed = Number.parseInt(match[0], 10);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function episodeFromPackedId(value) {
    const text = String(value || '').trim();
    const imdb = text.match(/tt\d{5,12}:(\d{1,3}):(\d{1,4})/i);
    if (imdb) {
        return {
            provider: 'imdb',
            season: parsePositiveNumber(imdb[1]),
            episode: parsePositiveNumber(imdb[2]),
            absolute: null
        };
    }

    const provider = text.match(/(?:^|[^a-z])((?:kitsu(?::|\/|_|-)(?:anime(?::|\/|_|-))?)|mal|myanimelist|anilist)(?:\d|:|\/|_|-)+/i);
    if (!provider) return null;

    const tail = text.slice(provider.index || 0).replace(/^[^a-z0-9]*/i, '');
    const parts = tail.split(/[:/_-]+/g).filter(Boolean);
    const normalizedProvider = String(parts[0] || '').toLowerCase() === 'myanimelist' ? 'mal' : String(parts[0] || '').toLowerCase();
    const numericParts = parts.filter((part) => /^\d{1,8}$/.test(part));
    if (numericParts.length < 2) return null;

    if (numericParts.length >= 3) {
        return {
            provider: normalizedProvider || 'external',
            season: parsePositiveNumber(numericParts[1]),
            episode: parsePositiveNumber(numericParts[2]),
            absolute: parsePositiveNumber(numericParts[2])
        };
    }

    return {
        provider: normalizedProvider || 'external',
        season: null,
        episode: parsePositiveNumber(numericParts[1]),
        absolute: parsePositiveNumber(numericParts[1])
    };
}

function firstPositive(...values) {
    for (const value of values) {
        const parsed = parsePositiveNumber(value);
        if (parsed) return parsed;
    }
    return null;
}

function normalizeEpisodeInfo(meta = {}, identityContext = null) {
    const directSeason = parsePositiveNumber(meta.season ?? meta.seasonNumber ?? meta.s);
    const directEpisode = parsePositiveNumber(meta.episode ?? meta.episodeNumber ?? meta.e);
    const packed = episodeFromPackedId(meta.id)
        || episodeFromPackedId(meta.stremioId)
        || episodeFromPackedId(meta.videoId)
        || episodeFromPackedId(meta.imdb_id)
        || episodeFromPackedId(meta.imdbId)
        || episodeFromPackedId(meta.kitsuId ? `kitsu:${meta.kitsuId}:${meta.episode || ''}` : null)
        || episodeFromPackedId(meta.kitsu ? `kitsu:${meta.kitsu}:${meta.episode || ''}` : null);

    const mappedSeason = firstPositive(
        identityContext?.mappedIds?.mappedSeason,
        identityContext?.seasonNumber,
        identityContext?.tmdbEpisode?.season,
        identityContext?.metadata?.season
    );
    const mappedEpisode = firstPositive(
        identityContext?.mappedIds?.mappedEpisode,
        identityContext?.tmdbEpisode?.episode,
        identityContext?.requestedEpisode,
        identityContext?.episodeNumber,
        identityContext?.metadata?.episode
    );

    let season = directSeason || mappedSeason || packed?.season || null;
    const episode = directEpisode || mappedEpisode || packed?.episode || null;

    if (!season && episode && KITSU_DEFAULT_SEASON && packed?.provider === 'kitsu') {
        season = 1;
    }

    const result = {
        season,
        episode,
        valid: Number.isInteger(season) && season > 0 && Number.isInteger(episode) && episode > 0
    };
    const absoluteEpisode = packed?.absolute || identityContext?.absoluteEpisode || null;
    if (absoluteEpisode) result.absoluteEpisode = absoluteEpisode;
    return result;
}

function collectTitleCandidates(meta = {}) {
    const values = [
        meta.title,
        meta.name,
        meta.originalTitle,
        meta.original_title,
        meta.canonicalTitle,
        meta.englishTitle,
        meta.romajiTitle,
        meta.nativeTitle,
        meta.seriesTitle
    ];
    return uniq(values.map((value) => String(value || '').trim()).filter(Boolean));
}

function hasExternalAnimeId(meta = {}) {
    const values = [
        meta.id,
        meta.stremioId,
        meta.videoId,
        meta.kitsu,
        meta.kitsuId,
        meta.kitsu_id,
        meta.mal,
        meta.malId,
        meta.mal_id,
        meta.anilist,
        meta.anilistId,
        meta.anilist_id,
        meta?.ids?.kitsu,
        meta?.ids?.mal,
        meta?.ids?.myanimelist,
        meta?.ids?.anilist,
        meta?.externalIds?.kitsu,
        meta?.externalIds?.mal,
        meta?.externalIds?.myanimelist,
        meta?.externalIds?.anilist
    ];
    return values.some((value) => /(?:^|[^a-z])(?:kitsu|anime-kitsu|mal|myanimelist|anilist)(?::|\/|_|-|Id|=)?\d+/i.test(String(value || '')));
}

function shouldUseKitsu(meta = {}, config = {}) {
    if (!KITSU_LOOKUP) return false;
    if (config?.vidxgo?.kitsuLookup === false) return false;
    if (config?.vidxgo?.kitsuLookup === true) return true;
    if (hasExternalAnimeId(meta)) return true;

    let likelihood = null;
    try {
        if (typeof animeIdentity.getAnimeLikelihood === 'function') likelihood = animeIdentity.getAnimeLikelihood(meta);
    } catch (_) {}
    if (likelihood?.isAnime || Number(likelihood?.score || 0) >= 2) return true;

    return KITSU_TITLE_FALLBACK && !imdbFromMeta(meta) && collectTitleCandidates(meta).length > 0;
}

function buildKitsuCacheKey(meta = {}, config = {}) {
    const ids = uniq([
        meta.id,
        meta.stremioId,
        meta.videoId,
        meta.kitsu,
        meta.kitsuId,
        meta.kitsu_id,
        meta.mal,
        meta.malId,
        meta.anilist,
        meta.anilistId
    ].map((value) => String(value || '').trim()).filter(Boolean)).slice(0, 8).join('|');
    const titles = collectTitleCandidates(meta).slice(0, 5).join('|');
    const language = config?.filters?.language || config?.language || '';
    return `kitsu:${ids}:${titles}:${meta.season || meta.seasonNumber || ''}:${meta.episode || meta.episodeNumber || ''}:${language}`.toLowerCase();
}

function buildKitsuRequestId(meta = {}) {
    return String(
        meta.id
        || meta.stremioId
        || meta.videoId
        || (meta.kitsuId ? `kitsu:${meta.kitsuId}:${meta.episode || ''}` : '')
        || (meta.kitsu ? `kitsu:${meta.kitsu}:${meta.episode || ''}` : '')
        || meta.malId
        || meta.anilistId
        || collectTitleCandidates(meta)[0]
        || ''
    ).trim() || null;
}

async function buildKitsuVidxgoContext(meta = {}, config = {}) {
    if (!shouldUseKitsu(meta, config)) return null;

    const cacheKey = buildKitsuCacheKey(meta, config);
    const cached = cache.kitsuContext.get(cacheKey);
    if (cached !== undefined) return cached;

    return singleFlight.do(cacheKey, async () => {
        const cachedAgain = cache.kitsuContext.get(cacheKey);
        if (cachedAgain !== undefined) return cachedAgain;

        const requestId = buildKitsuRequestId(meta);
        try {
            const context = await animeIdentity.buildAnimeSearchContextForProvider({
                requestId,
                originalId: meta.originalId || meta.id || null,
                finalId: meta.finalId || meta.stremioId || null,
                meta,
                config,
                season: meta.season ?? meta.seasonNumber ?? null,
                episode: meta.episode ?? meta.episodeNumber ?? episodeFromPackedId(requestId)?.episode ?? null,
                providerName: PROVIDER_ID,
                language: 'it-IT',
                mappingLanguage: 'it',
                kitsuTimeoutMs: KITSU_LOOKUP_TIMEOUT_MS,
                mappingTimeoutMs: KITSU_MAPPING_TIMEOUT_MS,
                tmdbTimeoutMs: KITSU_TMDB_TIMEOUT_MS,
                debug: DEBUG
            });

            const useful = context && (context.kitsuId || context.imdbId || context.tmdbId || context.isAnime) ? context : null;
            return cache.kitsuContext.set(cacheKey, useful, KITSU_CONTEXT_TTL_MS, KITSU_CONTEXT_STALE_TTL_MS, {
                requestId,
                source: useful?.identitySources || []
            });
        } catch (error) {
            log('kitsu context failed', { error: error?.message || String(error), requestId });
            const stale = cache.kitsuContext.get(cacheKey, { allowStale: true });
            return stale !== undefined ? stale : null;
        }
    });
}

async function enrichKitsuMapping(context = null, meta = {}, config = {}) {
    if (!context?.kitsuId || context?.imdbId) return context;
    if (typeof animeIdentity.fetchBestMapping !== 'function') return context;

    const mapping = await animeIdentity.fetchBestMapping([`kitsu:${context.kitsuId}`], meta, config, {
        season: context.seasonNumber ?? meta.season ?? meta.seasonNumber ?? null,
        episode: context.requestedEpisode ?? meta.episode ?? meta.episodeNumber ?? null,
        language: 'it-IT',
        mappingLanguage: 'it',
        mappingTimeoutMs: KITSU_MAPPING_TIMEOUT_MS,
        tmdbTimeoutMs: KITSU_TMDB_TIMEOUT_MS
    }).catch((error) => {
        log('kitsu mapping failed', { kitsuId: context.kitsuId, error: error?.message || String(error) });
        return null;
    });

    if (!mapping?.ids) return context;
    return {
        ...context,
        mappedIds: { ...(context.mappedIds || {}), ...(mapping.ids || {}) },
        mappingPayload: mapping.payload || context.mappingPayload || null,
        mappingLookup: mapping.lookup || context.mappingLookup || null,
        imdbId: context.imdbId || mapping.ids.imdbId || null,
        tmdbId: context.tmdbId || mapping.ids.tmdbId || null,
        seasonNumber: context.seasonNumber || mapping.ids.mappedSeason || null,
        requestedEpisode: mapping.ids.mappedEpisode || mapping.ids.rawEpisodeNumber || context.requestedEpisode || null,
        identitySources: uniq([...(context.identitySources || []), `mapping:${mapping.lookup?.provider || 'kitsu'}`])
    };
}

async function imdbFromIdentityContext(context = {}, meta = {}) {
    const direct = normalizeImdbId(context?.imdbId || context?.mappedIds?.imdbId || context?.metadata?.imdb_id);
    if (direct) return direct;

    const tmdbId = context?.tmdbId || context?.mappedIds?.tmdbId || context?.metadata?.tmdbId || context?.metadata?.tmdb_id;
    if (!tmdbId) return null;
    const mediaType = context?.mappedIds?.tmdbType || context?.metadata?.type || (context?.isMovie || meta?.type === 'movie' ? 'movie' : 'tv');
    const imdb = await tmdbHelper.getImdbFromTmdb(tmdbId, mediaType).catch(() => null);
    return normalizeImdbId(imdb);
}

async function resolveContentIdentity(meta = {}, config = {}) {
    const direct = imdbFromMeta(meta);
    if (direct) return { imdbId: direct, source: 'imdb', animeContext: null };

    const mediaType = isSeriesRequest(meta) ? 'tv' : 'movie';
    const resolved = await tmdbHelper.resolveFromMeta(meta, { type: mediaType }).catch(() => null);
    const tmdbImdb = normalizeImdbId(resolved?.imdb_id || resolved?.imdbId);
    if (tmdbImdb) return { imdbId: tmdbImdb, source: 'tmdb', animeContext: null, tmdbMeta: resolved };

    let animeContext = await buildKitsuVidxgoContext(meta, config);
    animeContext = await enrichKitsuMapping(animeContext, meta, config);
    const kitsuImdb = await imdbFromIdentityContext(animeContext, meta);
    if (kitsuImdb) {
        return { imdbId: kitsuImdb, source: 'kitsu', animeContext };
    }

    return { imdbId: null, source: animeContext ? 'kitsu-miss' : 'unresolved', animeContext };
}

async function resolveImdbId(meta = {}, config = {}) {
    const identity = await resolveContentIdentity(meta, config);
    return identity.imdbId;
}

function buildPlayerUrl(imdbId, { series = false, season = null, episode = null, base = PLAYER_BASE } = {}) {
    const numeric = normalizeImdbId(imdbId)?.replace(/^tt/i, '');
    const playerBase = normalizeBaseUrl(base) || PLAYER_BASE;
    if (!numeric) return null;
    if (series) {
        if (!Number.isInteger(season) || !Number.isInteger(episode)) return null;
        return `${playerBase}/${numeric}/${season}/${episode}`;
    }
    return `${playerBase}/${numeric}`;
}

function getConfiguredPlayerBases(config = {}) {
    const explicit = [
        config?.vidxgo?.playerBase,
        config?.vidxgo?.baseUrl,
        config?.vidxgo?.playerUrl,
        ...splitList(config?.vidxgo?.playerBases),
        ...splitList(process.env.VIDXGO_PLAYER_BASES),
        PLAYER_BASE
    ];
    return uniq(explicit.map(normalizeBaseUrl).filter(Boolean));
}

function orderPlayerBases(bases, contextKey = 'global') {
    const scoped = cache.baseHealth.get(`base:${contextKey}`);
    const global = cache.baseHealth.get('base:global');
    return uniq([scoped, global, ...bases].filter(Boolean));
}

function rememberWorkingBase(base, contextKey = 'global') {
    const clean = normalizeBaseUrl(base);
    if (!clean) return;
    cache.baseHealth.set(`base:${contextKey}`, clean, BASE_HEALTH_TTL_MS, BASE_HEALTH_TTL_MS);
    cache.baseHealth.set('base:global', clean, BASE_HEALTH_TTL_MS, BASE_HEALTH_TTL_MS);
}

function buildPlayerCandidates(imdbId, { series = false, season = null, episode = null } = {}, config = {}) {
    const contextKey = `${normalizeImdbId(imdbId) || 'unknown'}:${series ? 'series' : 'movie'}`;
    return orderPlayerBases(getConfiguredPlayerBases(config), contextKey)
        .map((base) => ({
            base,
            url: buildPlayerUrl(imdbId, { series, season, episode, base })
        }))
        .filter((candidate) => candidate.url)
        .slice(0, Math.max(1, MAX_PLAYER_ATTEMPTS));
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

function createContentKey(imdbId, { series = false, season = null, episode = null } = {}) {
    return `${normalizeImdbId(imdbId) || 'unknown'}:${series ? `s${season}e${episode}` : 'movie'}`;
}

function buildStreamTitle(displayTitle, extractedName, quality) {
    const lines = [displayTitle, `${extractedName || PROVIDER_LABEL} ITA`];
    const normalizedQuality = normalizeQuality(quality || 'Unknown');
    if (normalizedQuality !== 'Unknown') lines.push(`Auto quality: ${normalizedQuality}`);
    return lines.filter(Boolean).join('\n');
}

async function resolvePlayerStream(playerUrl, displayTitle, {
    signal,
    contentKey = null,
    series = false,
    season = null,
    episode = null,
    imdbId = null,
    playerBase = PLAYER_BASE,
    identitySource = null,
    animeContext = null
} = {}) {
    const refererBase = normalizeBaseUrl(playerBase) || PLAYER_BASE;
    const extracted = await extractFromUrl(playerUrl, {
        client: http,
        userAgent: USER_AGENT,
        requestReferer: `${refererBase}/`,
        referer: `${refererBase}/`,
        pageUrl: playerUrl,
        playlistTimeoutMs: PLAYLIST_TIMEOUT_MS,
        fetchers: [
            (targetUrl, headers) => http.get(targetUrl, {
                headers,
                timeout: TIMEOUT_MS,
                responseType: 'text',
                signal
            }).then((response) => responseText(response))
        ]
    }).catch((error) => {
        log('extractor failed', { url: playerUrl, error: error?.message || String(error) });
        return null;
    });

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
        title: buildStreamTitle(displayTitle, extracted.name, quality),
        url: extracted.url,
        extractor: extracted.name || PROVIDER_LABEL,
        provider: PROVIDER_LABEL,
        providerCode: PROVIDER_CODE,
        quality,
        headers: extracted.headers,
        extraBehaviorHints: {
            vortexMeta: {
                providerId: PROVIDER_ID,
                providerCode: PROVIDER_CODE,
                imdbId: normalizeImdbId(imdbId),
                contentKey,
                playerUrl,
                sourceUrl: playerUrl,
                identitySource,
                kitsuId: animeContext?.kitsuId || animeContext?.mappedIds?.kitsuId || undefined,
                tmdbId: animeContext?.tmdbId || animeContext?.mappedIds?.tmdbId || undefined,
                mappingSource: animeContext?.mappingLookup?.provider || undefined,
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

    stream = decorateStreamWithPlaylistIntelligence(stream, playlistIntel);
    stream.vxg = {
        contentKey,
        playerUrl,
        identitySource,
        kitsuId: animeContext?.kitsuId || animeContext?.mappedIds?.kitsuId || null,
        tmdbId: animeContext?.tmdbId || animeContext?.mappedIds?.tmdbId || null,
        resolvedAt: new Date().toISOString(),
        staleCapable: STALE_ON_ERROR
    };
    return stream;
}

async function resolveFirstPlayerStream(candidates, displayTitle, context = {}) {
    let lastError = null;
    for (const candidate of candidates) {
        try {
            const stream = await resolvePlayerStream(candidate.url, displayTitle, { ...context, playerBase: candidate.base });
            if (stream?.url) {
                rememberWorkingBase(candidate.base, context.contentKey);
                return { stream, candidate };
            }
            log('candidate empty', { url: candidate.url });
        } catch (error) {
            lastError = error;
            log('candidate failed', { url: candidate.url, error: error?.message || String(error) });
        }
    }
    if (lastError) throw lastError;
    return null;
}

function buildResolvedMeta(meta = {}, identity = {}) {
    const animeContext = identity?.animeContext || {};
    const metadata = identity?.tmdbMeta || animeContext?.metadata || {};
    return {
        ...meta,
        title: meta.title || meta.name || animeContext.title || metadata.title || metadata.name || PROVIDER_LABEL,
        name: meta.name || meta.title || animeContext.title || metadata.name || metadata.title || null,
        originalTitle: meta.originalTitle || meta.original_title || animeContext.originalTitle || metadata.originalTitle || metadata.original_title || null,
        year: meta.year || animeContext.year || metadata.year || extractYear(animeContext.date || metadata.date || '')
    };
}

async function searchVidxgoImpl(meta = {}, config = {}, reqHost = null) {
    if (!config?.filters?.enableVidxgo) return [];

    const identity = await resolveContentIdentity(meta, config);
    const imdbId = identity.imdbId;
    if (!imdbId) {
        log('imdb id not resolved', {
            title: meta.title || meta.name,
            type: meta.type,
            source: identity.source,
            kitsuId: identity.animeContext?.kitsuId || null
        });
        return [];
    }

    const animeContext = identity.animeContext || null;
    const episodeInfo = normalizeEpisodeInfo(meta, animeContext);
    const series = isSeriesRequest(meta) || (animeContext?.isMovie === false && Boolean(episodeInfo.episode));
    if (series && !episodeInfo.valid) {
        log('series request without valid season/episode', {
            id: meta.id || meta.stremioId || meta.imdb_id || meta.imdbId || meta.kitsuId || meta.kitsu,
            season: meta.season,
            episode: meta.episode,
            kitsuId: animeContext?.kitsuId || null,
            mappedSeason: animeContext?.mappedIds?.mappedSeason || animeContext?.seasonNumber || null,
            mappedEpisode: animeContext?.mappedIds?.mappedEpisode || animeContext?.requestedEpisode || null
        });
        return [];
    }

    const season = series ? episodeInfo.season : null;
    const episode = series ? episodeInfo.episode : null;
    const resolvedMeta = buildResolvedMeta(meta, identity);
    const contentKey = createContentKey(imdbId, { series, season, episode });
    const cacheKey = `streams:${contentKey}`;
    const cachedFresh = cache.streams.get(cacheKey);
    if (cachedFresh) return cachedFresh;

    const staleEntry = STALE_ON_ERROR ? cache.streams.getEntry(cacheKey, { allowStale: true }) : null;
    const staleFallback = staleEntry?.isStale ? staleEntry.value : null;

    return singleFlight.do(cacheKey, async () => {
        const secondFresh = cache.streams.get(cacheKey);
        if (secondFresh) return secondFresh;

        const secondStaleEntry = STALE_ON_ERROR ? cache.streams.getEntry(cacheKey, { allowStale: true }) : null;
        const secondStale = secondStaleEntry?.isStale ? secondStaleEntry.value : staleFallback;
        const candidates = buildPlayerCandidates(imdbId, { series, season, episode }, config);
        if (!candidates.length) return secondStale || [];

        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), Math.max(TIMEOUT_MS + PLAYLIST_TIMEOUT_MS + 3000, 15_000));

        try {
            const displayTitle = buildDisplayTitle(resolvedMeta, { series, season, episode });
            const resolved = await resolveFirstPlayerStream(candidates, displayTitle, {
                signal: controller.signal,
                contentKey,
                series,
                season,
                episode,
                imdbId,
                identitySource: identity.source,
                animeContext
            });
            const streams = normalizeStreams(resolved?.stream ? [resolved.stream] : [], {
                provider: PROVIDER_ID,
                providerLabel: PROVIDER_LABEL,
                providerCode: PROVIDER_CODE,
                sort: false,
                debug: DEBUG
            });

            const ttl = streams.length ? STREAM_TTL_MS : EMPTY_TTL_MS;
            const staleTtl = streams.length ? STALE_STREAM_TTL_MS : EMPTY_TTL_MS;
            cache.streams.set(cacheKey, streams, ttl, staleTtl, {
                contentKey,
                imdbId,
                series,
                season,
                episode,
                playerBase: resolved?.candidate?.base || null,
                candidateCount: candidates.length,
                identitySource: identity.source,
                kitsuId: animeContext?.kitsuId || animeContext?.mappedIds?.kitsuId || null,
                tmdbId: animeContext?.tmdbId || animeContext?.mappedIds?.tmdbId || null
            });
            return streams;
        } catch (error) {
            log('provider failed', { error: error?.message || String(error), cacheKey, stale: Boolean(secondStale) });
            return secondStale || [];
        } finally {
            clearTimeout(timer);
        }
    });
}

async function searchVidxgo(meta = {}, config = {}, reqHost = null) {
    return withProviderHealth(PROVIDER_ID, () => searchVidxgoImpl(meta, config, reqHost), {
        timeoutMs: Math.max(15_000, TIMEOUT_MS + PLAYLIST_TIMEOUT_MS + 5000),
        swallowErrors: true,
        fallbackValue: []
    });
}

module.exports = {
    searchVidxgo,
    searchVidxGo: searchVidxgo,
    buildPlayerUrl,
    buildPlayerCandidates,
    resolveImdbId,
    resolveContentIdentity,
    buildKitsuVidxgoContext,
    shouldUseKitsu,
    isSeriesRequest,
    normalizeEpisodeInfo,
    normalizeImdbId
};
