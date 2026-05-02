'use strict';

const axios = require('axios');
const { HTTP_AGENT, HTTPS_AGENT } = require('./http');
const {
    SingleFlight,
    TTLCache,
    resilientCall
} = require('../../providers/extractors/resilience');

const TMDB_KEY = String(process.env.TMDB_API_KEY || '5bae8d11f2a7bc7a95c6d040a31d2163').trim();
const TMDB_API_BASE = 'https://api.themoviedb.org/3';
const TMDB_WEB_BASE = 'https://www.themoviedb.org';

const TMDB_TIMEOUT_MS = 7000;
const TMDB_WEB_TIMEOUT_MS = 10000;
const REQUEST_RETRIES = 3;
const RETRYABLE_STATUSES = [408, 425, 429, 500, 502, 503, 504];

const CACHE_TTL_IMDB_TO_TMDB_MS = 6 * 60 * 60 * 1000;
const CACHE_TTL_TMDB_TO_IMDB_MS = 6 * 60 * 60 * 1000;
const CACHE_TTL_MEDIA_INFO_MS = 30 * 60 * 1000;
const CACHE_TTL_TMDB_RAW_MS = 15 * 60 * 1000;
const NEGATIVE_CACHE_TTL_MS = 5 * 60 * 1000;

const IMDB_RE = /^tt\d+$/i;
const TMDB_NUMERIC_RE = /^\d+$/;
const YEAR_RE = /^(\d{4})/;
const CANONICAL_TMDB_RE = /href=["']https?:\/\/www\.themoviedb\.org\/(movie|tv)\/(\d+)["']/i;
const PATH_TMDB_RE = /\/(movie|tv)\/(\d+)/i;

const tmdbHttp = axios.create({
    baseURL: TMDB_API_BASE,
    timeout: TMDB_TIMEOUT_MS,
    httpAgent: HTTP_AGENT,
    httpsAgent: HTTPS_AGENT,
    maxRedirects: 5,
    validateStatus: () => true,
    proxy: false
});

const tmdbWebHttp = axios.create({
    timeout: TMDB_WEB_TIMEOUT_MS,
    httpAgent: HTTP_AGENT,
    httpsAgent: HTTPS_AGENT,
    maxRedirects: 5,
    validateStatus: () => true,
    proxy: false,
    headers: {
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36',
        accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'accept-language': 'it-IT,it;q=0.9,en-US;q=0.8,en;q=0.7'
    }
});

const imdbToTmdbCache = new TTLCache({
    maxSize: 4096,
    ttlMs: CACHE_TTL_IMDB_TO_TMDB_MS,
    negativeTtlMs: NEGATIVE_CACHE_TTL_MS,
    cloneValues: true
});

const tmdbToImdbCache = new TTLCache({
    maxSize: 4096,
    ttlMs: CACHE_TTL_TMDB_TO_IMDB_MS,
    negativeTtlMs: NEGATIVE_CACHE_TTL_MS,
    cloneValues: true
});

const mediaInfoCache = new TTLCache({
    maxSize: 4096,
    ttlMs: CACHE_TTL_MEDIA_INFO_MS,
    negativeTtlMs: NEGATIVE_CACHE_TTL_MS,
    cloneValues: true
});

const tmdbRawCache = new TTLCache({
    maxSize: 2048,
    ttlMs: CACHE_TTL_TMDB_RAW_MS,
    negativeTtlMs: NEGATIVE_CACHE_TTL_MS,
    cloneValues: true
});

const tmdbFetchSingleFlight = new SingleFlight();
const tmdbFindSingleFlight = new SingleFlight();

function normMediaType(value) {
    const type = String(value || '').trim().toLowerCase();
    if (!type) return null;
    if (type === 'movie' || type === 'film') return 'movie';
    if (type === 'tv' || type === 'series' || type === 'serie' || type === 'show') return 'tv';
    return type;
}

function safeTmdbKey(userKey = null) {
    const key = String(userKey || '').trim();
    return key.length > 8 ? key : TMDB_KEY;
}

function normalizeImdbId(value) {
    const raw = String(value || '').trim();
    const parts = raw.split(':');
    const id = String(parts[0] || '').trim().toLowerCase();
    if (!IMDB_RE.test(id)) return null;

    const season = parts[1] != null && parts[1] !== '' ? Number.parseInt(parts[1], 10) : null;
    const episode = parts[2] != null && parts[2] !== '' ? Number.parseInt(parts[2], 10) : null;

    return {
        id,
        season: Number.isFinite(season) && season > 0 ? season : null,
        episode: Number.isFinite(episode) && episode > 0 ? episode : null,
        toString() {
            return this.season != null ? `${this.id}:${this.season}:${this.episode || ''}` : this.id;
        }
    };
}

function normalizeTmdbId(value) {
    const raw = String(value || '').trim();
    const clean = raw
        .replace(/^tmdb:(?:movie|tv|series):/i, '')
        .replace(/^tmdb:/i, '')
        .replace(/^tmdb[/-](?:movie|tv|series)[/-]/i, '');

    const parts = clean.split(':');
    const id = String(parts[0] || '').trim();
    if (!TMDB_NUMERIC_RE.test(id)) return null;

    const season = parts[1] != null && parts[1] !== '' ? Number.parseInt(parts[1], 10) : null;
    const episode = parts[2] != null && parts[2] !== '' ? Number.parseInt(parts[2], 10) : null;

    return {
        id: Number.parseInt(id, 10),
        season: Number.isFinite(season) && season > 0 ? season : null,
        episode: Number.isFinite(episode) && episode > 0 ? episode : null,
        toString() {
            return this.season != null ? `${this.id}:${this.season}:${this.episode || ''}` : String(this.id);
        }
    };
}

function getCacheEntry(cache, key) {
    const entry = cache.getEntry(key);
    if (!entry) return { hit: false, value: null };
    return { hit: true, value: entry.value };
}

function buildRawCacheKey(path, params = {}) {
    const cleanParams = Object.entries(params || {})
        .filter(([, value]) => value != null && value !== '')
        .filter(([key]) => key !== 'api_key')
        .sort(([a], [b]) => a.localeCompare(b));
    const query = new URLSearchParams(cleanParams).toString();
    return query ? `${path}?${query}` : path;
}

function getAxiosFinalUrl(response) {
    return String(
        response?.request?.res?.responseUrl
        || response?.request?._redirectable?._currentUrl
        || response?.config?.url
        || ''
    );
}

async function fetchTmdbJson(path, {
    params = {},
    userKey = null,
    cacheTtlMs = CACHE_TTL_TMDB_RAW_MS,
    timeoutMs = TMDB_TIMEOUT_MS
} = {}) {
    const finalParams = {
        api_key: safeTmdbKey(userKey),
        ...Object.fromEntries(Object.entries(params || {}).filter(([, value]) => value != null && value !== ''))
    };
    const cacheKey = buildRawCacheKey(path, finalParams);
    const cached = getCacheEntry(tmdbRawCache, cacheKey);
    if (cached.hit) return cached.value;

    return tmdbFetchSingleFlight.do(cacheKey, async () => {
        const secondCached = getCacheEntry(tmdbRawCache, cacheKey);
        if (secondCached.hit) return secondCached.value;

        const response = await resilientCall(
            () => tmdbHttp.get(path, {
                params: finalParams,
                timeout: timeoutMs
            }),
            {
                attempts: REQUEST_RETRIES,
                retryableStatuses: RETRYABLE_STATUSES
            }
        );

        if (response.status !== 200) {
            tmdbRawCache.setNegative(cacheKey, { ttlMs: NEGATIVE_CACHE_TTL_MS });
            return null;
        }

        const data = response.data || null;
        tmdbRawCache.set(cacheKey, data, { ttlMs: cacheTtlMs });
        return data;
    });
}

async function scrapeTmdbFallbackFind(imdbId, mediaHint = null) {
    const hint = normMediaType(mediaHint) || 'movie';
    const checks = hint === 'tv'
        ? [['tv', `${TMDB_WEB_BASE}/tv/${imdbId}`], ['movie', `${TMDB_WEB_BASE}/movie/${imdbId}`]]
        : [['movie', `${TMDB_WEB_BASE}/movie/${imdbId}`], ['tv', `${TMDB_WEB_BASE}/tv/${imdbId}`]];

    for (const [, url] of checks) {
        try {
            const response = await resilientCall(
                () => tmdbWebHttp.get(url, { timeout: TMDB_WEB_TIMEOUT_MS }),
                { attempts: 2, retryableStatuses: RETRYABLE_STATUSES }
            );

            const finalUrl = getAxiosFinalUrl(response);
            const pathMatch = PATH_TMDB_RE.exec(finalUrl);
            if (response.status === 200 && pathMatch?.[1] && pathMatch?.[2]) {
                return { id: Number.parseInt(pathMatch[2], 10), type: pathMatch[1] };
            }

            const html = String(response.data || '');
            const canonicalMatch = CANONICAL_TMDB_RE.exec(html);
            if (canonicalMatch?.[1] && canonicalMatch?.[2]) {
                return { id: Number.parseInt(canonicalMatch[2], 10), type: canonicalMatch[1] };
            }
        } catch (_) {}
    }

    return null;
}

function manualImdbToTmdbOverride(imdb) {
    const overrides = new Map([
        ['tt13207736:2', { id: 225634, season: 1 }],
        ['tt13207736:3', { id: 286801, season: 1 }]
    ]);

    return overrides.get(`${imdb.id}:${imdb.season || ''}`) || null;
}

async function getTmdbIdObjFromImdbId(imdbId, {
    mediaHint = null,
    userKey = null
} = {}) {
    const imdb = normalizeImdbId(imdbId);
    if (!imdb) return null;

    const manual = manualImdbToTmdbOverride(imdb);
    if (manual) {
        return {
            id: manual.id,
            type: 'tv',
            season: manual.season,
            episode: imdb.episode
        };
    }

    const hint = normMediaType(mediaHint) || (imdb.season != null ? 'tv' : 'movie');
    const cacheKey = `${imdb.toString()}|${hint}|${safeTmdbKey(userKey) === TMDB_KEY ? 'default' : 'custom'}`;
    const cached = getCacheEntry(imdbToTmdbCache, cacheKey);
    if (cached.hit) return cached.value;

    return tmdbFindSingleFlight.do(cacheKey, async () => {
        const secondCached = getCacheEntry(imdbToTmdbCache, cacheKey);
        if (secondCached.hit) return secondCached.value;

        let selected = null;

        const data = await fetchTmdbJson(`/find/${encodeURIComponent(imdb.id)}`, {
            params: { external_source: 'imdb_id' },
            userKey
        }).catch(() => null);

        const movie = Array.isArray(data?.movie_results) ? data.movie_results[0] : null;
        const tv = Array.isArray(data?.tv_results) ? data.tv_results[0] : null;

        if (hint === 'tv') {
            if (tv?.id) selected = { id: Number(tv.id), type: 'tv' };
            else if (movie?.id) selected = { id: Number(movie.id), type: 'movie' };
        } else if (movie?.id) {
            selected = { id: Number(movie.id), type: 'movie' };
        } else if (tv?.id) {
            selected = { id: Number(tv.id), type: 'tv' };
        }

        if (!selected) selected = await scrapeTmdbFallbackFind(imdb.id, hint);

        if (!selected?.id) {
            imdbToTmdbCache.setNegative(cacheKey, { ttlMs: NEGATIVE_CACHE_TTL_MS });
            return null;
        }

        const result = {
            id: selected.id,
            type: selected.type,
            season: selected.type === 'tv' ? imdb.season : null,
            episode: selected.type === 'tv' ? imdb.episode : null
        };
        imdbToTmdbCache.set(cacheKey, result, { ttlMs: CACHE_TTL_IMDB_TO_TMDB_MS });
        return result;
    });
}

async function getTmdbFromImdb(imdbId, options = {}) {
    const tmdb = await getTmdbIdObjFromImdbId(imdbId, options);
    return tmdb?.id ? String(tmdb.id) : null;
}

async function getImdbFromTmdb(tmdbId, mediaType, {
    userKey = null
} = {}) {
    const type = normMediaType(mediaType);
    if (type !== 'movie' && type !== 'tv') return null;

    const tmdb = normalizeTmdbId(tmdbId);
    if (!tmdb) return null;

    const cacheKey = `${type}:${tmdb.id}|${safeTmdbKey(userKey) === TMDB_KEY ? 'default' : 'custom'}`;
    const cached = getCacheEntry(tmdbToImdbCache, cacheKey);
    if (cached.hit) return cached.value;

    const data = await fetchTmdbJson(`/${type}/${tmdb.id}/external_ids`, { userKey }).catch(() => null);
    const imdb = String(data?.imdb_id || '').trim().toLowerCase();

    if (IMDB_RE.test(imdb)) {
        tmdbToImdbCache.set(cacheKey, imdb, { ttlMs: CACHE_TTL_TMDB_TO_IMDB_MS });
        return imdb;
    }

    tmdbToImdbCache.setNegative(cacheKey, { ttlMs: NEGATIVE_CACHE_TTL_MS });
    return null;
}

async function getMediaInfoFull(tmdbId, mediaType, {
    language = 'it-IT',
    userKey = null,
    appendToResponse = 'external_ids'
} = {}) {
    const type = normMediaType(mediaType);
    if (type !== 'movie' && type !== 'tv') return null;

    const tmdb = normalizeTmdbId(tmdbId);
    if (!tmdb) return null;

    const cacheKey = `${type}:${tmdb.id}:${language}:${tmdb.season || ''}:${tmdb.episode || ''}:${appendToResponse || ''}`;
    const cached = getCacheEntry(mediaInfoCache, cacheKey);
    if (cached.hit) return cached.value;

    const data = await fetchTmdbJson(`/${type}/${tmdb.id}`, {
        params: {
            language,
            append_to_response: appendToResponse
        },
        userKey,
        cacheTtlMs: CACHE_TTL_MEDIA_INFO_MS
    }).catch(() => null);

    if (!data?.id) {
        mediaInfoCache.setNegative(cacheKey, { ttlMs: NEGATIVE_CACHE_TTL_MS });
        return null;
    }

    const title = type === 'movie'
        ? (data.title || data.original_title || null)
        : (data.name || data.original_name || null);
    const originalTitle = type === 'movie'
        ? (data.original_title || title)
        : (data.original_name || title);
    const date = type === 'movie'
        ? String(data.release_date || '')
        : String(data.first_air_date || '');
    const year = YEAR_RE.exec(date)?.[1] || null;
    const imdbId = String(data?.external_ids?.imdb_id || data?.imdb_id || '').trim().toLowerCase();

    const result = {
        tmdb_id: String(data.id || tmdb.id),
        tmdbId: String(data.id || tmdb.id),
        type,
        title,
        original_title: originalTitle,
        originalTitle,
        year,
        date: date || null,
        season: type === 'tv' ? tmdb.season : null,
        episode: type === 'tv' ? tmdb.episode : null,
        imdb_id: IMDB_RE.test(imdbId) ? imdbId : null,
        imdbId: IMDB_RE.test(imdbId) ? imdbId : null,
        vote_average: data.vote_average ?? null,
        vote_count: data.vote_count ?? null,
        popularity: data.popularity ?? null,
        overview: data.overview || null,
        original_language: data.original_language || null,
        origin_country: data.origin_country || data.production_countries || null
    };

    mediaInfoCache.set(cacheKey, result, { ttlMs: CACHE_TTL_MEDIA_INFO_MS });
    return result;
}

async function getMediaInfo(tmdbId, mediaType, options = {}) {
    const meta = await getMediaInfoFull(tmdbId, mediaType, options);
    return meta ? [meta.title || null, meta.year || null] : [null, null];
}

async function getTmdbMetaFromImdb(imdbId, {
    mediaHint = null,
    language = 'it-IT',
    userKey = null
} = {}) {
    const tmdb = await getTmdbIdObjFromImdbId(imdbId, { mediaHint, userKey });
    if (!tmdb?.id) return null;

    const type = normMediaType(mediaHint) || tmdb.type || (tmdb.season != null ? 'tv' : 'movie');
    const meta = await getMediaInfoFull(`${tmdb.id}${tmdb.season != null ? `:${tmdb.season}:${tmdb.episode || ''}` : ''}`, type, {
        language,
        userKey
    });
    if (!meta) return null;

    const imdb = normalizeImdbId(imdbId);
    return {
        ...meta,
        tmdb_id: String(tmdb.id),
        tmdbId: String(tmdb.id),
        imdb_id: imdb?.id || meta.imdb_id || null,
        imdbId: imdb?.id || meta.imdbId || null,
        season: type === 'tv' ? imdb?.season ?? tmdb.season ?? null : null,
        episode: type === 'tv' ? imdb?.episode ?? tmdb.episode ?? null : null,
        season_episode: imdb?.season && imdb?.episode ? `S${String(imdb.season).padStart(2, '0')}E${String(imdb.episode).padStart(2, '0')}` : undefined
    };
}

async function resolveFromMeta(meta = {}, {
    type = null,
    language = 'it-IT',
    userKey = null
} = {}) {
    const mediaType = normMediaType(type || meta.type || (meta.isSeries ? 'tv' : 'movie')) || 'movie';
    const explicitTmdb = normalizeTmdbId(meta.tmdb_id || meta.tmdbId || meta.tmdb || meta.id);
    if (explicitTmdb) {
        return getMediaInfoFull(explicitTmdb.toString(), mediaType, { language, userKey });
    }

    const imdbCandidate = meta.imdb_id || meta.imdbId || (IMDB_RE.test(String(meta.id || '')) ? meta.id : null);
    if (imdbCandidate) {
        return getTmdbMetaFromImdb(imdbCandidate, { mediaHint: mediaType, language, userKey });
    }

    return null;
}

function clearTmdbHelperCache() {
    imdbToTmdbCache.clear();
    tmdbToImdbCache.clear();
    mediaInfoCache.clear();
    tmdbRawCache.clear();
}

module.exports = {
    TMDB_KEY,
    TMDB_API_BASE,
    TMDB_WEB_BASE,
    normalizeImdbId,
    normalizeTmdbId,
    normMediaType,
    fetchTmdbJson,
    getTmdbIdObjFromImdbId,
    getTmdbFromImdb,
    getImdbFromTmdb,
    getMediaInfo,
    getMediaInfoFull,
    getTmdbMetaFromImdb,
    resolveFromMeta,
    clearTmdbHelperCache
};
