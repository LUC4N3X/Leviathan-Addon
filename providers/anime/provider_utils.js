'use strict';

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36';
const FETCH_TIMEOUT = 10000;
const DEFAULT_MAPPING_API = 'https://animemapping.realbestia.com';

const caches = {
    http: new Map(),
    mapping: new Map(),
    inflight: new Map()
};

function getCached(map, key) {
    const entry = map.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= Date.now()) {
        map.delete(key);
        return undefined;
    }
    return entry.value;
}

function setCached(map, key, value, ttlMs) {
    map.set(key, { value, expiresAt: Date.now() + ttlMs });
    return value;
}

function uniqueStrings(values = []) {
    const seen = new Set();
    const output = [];
    for (const value of values) {
        const text = String(value || '').trim();
        if (!text || seen.has(text)) continue;
        seen.add(text);
        output.push(text);
    }
    return output;
}

function parsePositiveInt(value) {
    const parsed = Number.parseInt(String(value || ''), 10);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function normalizeRequestedEpisode(value) {
    return parsePositiveInt(value) || 1;
}

function normalizeRequestedSeason(value) {
    const parsed = Number.parseInt(String(value || ''), 10);
    return Number.isInteger(parsed) && parsed >= 0 ? parsed : null;
}

function normalizeConfigBoolean(value) {
    if (value === true) return true;
    const normalized = String(value || '').trim().toLowerCase();
    return ['1', 'true', 'yes', 'on', 'enabled', 'checked'].includes(normalized);
}

function getMappingLanguage(providerContext = null) {
    const explicit = String(providerContext?.mappingLanguage || '').trim().toLowerCase();
    if (explicit === 'it') return 'it';
    return normalizeConfigBoolean(providerContext?.easyCatalogsLangIt) ? 'it' : null;
}

function toAbsoluteUrl(href, base = null) {
    if (!href) return null;
    const trimmed = String(href).trim();
    if (!trimmed) return null;
    if (trimmed.startsWith('//')) return `https:${trimmed}`;
    try {
        return new URL(trimmed, base || undefined).toString();
    } catch (_) {
        return null;
    }
}

async function fetchWithTimeout(url, options = {}, timeoutMs = FETCH_TIMEOUT) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
        return await fetch(url, { ...options, signal: controller.signal });
    } finally {
        clearTimeout(timeout);
    }
}

async function fetchResource(url, options = {}) {
    const {
        ttlMs = 0,
        cacheKey = url,
        as = 'text',
        method = 'GET',
        headers = {},
        body = undefined,
        timeoutMs = FETCH_TIMEOUT
    } = options;

    const key = `${as}:${method}:${cacheKey}:${typeof body === 'string' ? body : ''}`;
    if (ttlMs > 0) {
        const cached = getCached(caches.http, key);
        if (cached !== undefined) return cached;
    }

    const inflightKey = `http:${key}`;
    const running = caches.inflight.get(inflightKey);
    if (running) return running;

    const task = (async () => {
        const response = await fetchWithTimeout(url, {
            method,
            headers: {
                'user-agent': USER_AGENT,
                'accept-language': 'it-IT,it;q=0.9,en-US;q=0.8,en;q=0.7',
                ...headers
            },
            body,
            redirect: 'follow'
        }, timeoutMs);

        if (!response.ok) {
            throw new Error(`HTTP ${response.status} ${response.statusText} for ${url}`);
        }

        const payload = as === 'json' ? await response.json() : await response.text();
        if (ttlMs > 0) setCached(caches.http, key, payload, ttlMs);
        return payload;
    })();

    caches.inflight.set(inflightKey, task);
    try {
        return await task;
    } finally {
        caches.inflight.delete(inflightKey);
    }
}

function parseExplicitRequestId(rawId) {
    const value = String(rawId || '').trim();
    if (!value) return null;

    let match = value.match(/^kitsu:(\d+)(?::(\d+))?(?::(\d+))?$/i);
    if (match) {
        return {
            provider: 'kitsu',
            externalId: match[1],
            seasonFromId: match[3] ? normalizeRequestedSeason(match[2]) : null,
            episodeFromId: match[3]
                ? normalizeRequestedEpisode(match[3])
                : match[2]
                    ? normalizeRequestedEpisode(match[2])
                    : null
        };
    }

    match = value.match(/^imdb:(tt\d+)(?::(\d+))?(?::(\d+))?$/i);
    if (match) {
        return {
            provider: 'imdb',
            externalId: match[1],
            seasonFromId: match[3] ? normalizeRequestedSeason(match[2]) : null,
            episodeFromId: match[3]
                ? normalizeRequestedEpisode(match[3])
                : match[2]
                    ? normalizeRequestedEpisode(match[2])
                    : null
        };
    }

    match = value.match(/^tmdb:(\d+)(?::(\d+))?(?::(\d+))?$/i);
    if (match) {
        return {
            provider: 'tmdb',
            externalId: match[1],
            seasonFromId: match[3] ? normalizeRequestedSeason(match[2]) : null,
            episodeFromId: match[3]
                ? normalizeRequestedEpisode(match[3])
                : match[2]
                    ? normalizeRequestedEpisode(match[2])
                    : null
        };
    }

    match = value.match(/^(tt\d+)$/i);
    if (match) {
        return {
            provider: 'imdb',
            externalId: match[1],
            seasonFromId: null,
            episodeFromId: null
        };
    }

    match = value.match(/^(\d+)$/);
    if (match) {
        return {
            provider: 'tmdb',
            externalId: match[1],
            seasonFromId: null,
            episodeFromId: null
        };
    }

    return null;
}

function resolveLookupRequest(id, season, episode, providerContext = null) {
    let rawId = String(id || '').trim();
    try {
        rawId = decodeURIComponent(rawId);
    } catch (_) {}

    let requestedSeason = normalizeRequestedSeason(season);
    let requestedEpisode = normalizeRequestedEpisode(episode);

    const explicit = parseExplicitRequestId(rawId);
    if (explicit) {
        const explicitSeason = Number.isInteger(explicit.seasonFromId) && explicit.seasonFromId >= 0
            ? explicit.seasonFromId
            : null;

        if (explicit.provider === 'kitsu') {
            requestedSeason = explicitSeason;
        } else if (explicitSeason !== null) {
            requestedSeason = explicitSeason;
        }

        if (Number.isInteger(explicit.episodeFromId) && explicit.episodeFromId > 0) {
            requestedEpisode = explicit.episodeFromId;
        }

        return {
            provider: explicit.provider,
            externalId: explicit.externalId,
            season: requestedSeason,
            episode: requestedEpisode
        };
    }

    const contextKitsu = parsePositiveInt(providerContext?.kitsuId);
    if (contextKitsu) {
        return {
            provider: 'kitsu',
            externalId: String(contextKitsu),
            season: null,
            episode: requestedEpisode
        };
    }

    const contextImdb = /^tt\d+$/i.test(String(providerContext?.imdbId || '').trim())
        ? String(providerContext.imdbId).trim()
        : null;
    if (contextImdb) {
        return {
            provider: 'imdb',
            externalId: contextImdb,
            season: requestedSeason,
            episode: requestedEpisode
        };
    }

    const contextTmdb = /^\d+$/.test(String(providerContext?.tmdbId || '').trim())
        ? String(providerContext.tmdbId).trim()
        : null;
    if (contextTmdb) {
        return {
            provider: 'tmdb',
            externalId: contextTmdb,
            season: requestedSeason,
            episode: requestedEpisode
        };
    }

    return null;
}

async function fetchMappingPayload(lookup, providerContext = null, mappingApiBase = DEFAULT_MAPPING_API) {
    if (!lookup?.provider || !lookup?.externalId) return null;

    const provider = String(lookup.provider || '').trim().toLowerCase();
    const externalId = String(lookup.externalId || '').trim();
    const requestedEpisode = normalizeRequestedEpisode(lookup.episode);
    const requestedSeason = normalizeRequestedSeason(lookup.season);

    if (!['kitsu', 'imdb', 'tmdb'].includes(provider) || !externalId) return null;

    const mappingLanguage = provider === 'kitsu' ? 'it' : getMappingLanguage(providerContext);
    const mappingLanguageToken = mappingLanguage || 'default';
    const cacheKey = `${provider}:${externalId}:s=${requestedSeason ?? 'na'}:ep=${requestedEpisode}:lang=${mappingLanguageToken}`;
    const cached = getCached(caches.mapping, cacheKey);
    if (cached !== undefined) return cached;

    const params = new URLSearchParams();
    params.set('ep', String(requestedEpisode));
    if (Number.isInteger(requestedSeason) && requestedSeason >= 0) params.set('s', String(requestedSeason));
    if (mappingLanguage === 'it') params.set('lang', 'it');

    const url = `${mappingApiBase}/${provider}/${encodeURIComponent(externalId)}?${params.toString()}`;
    try {
        const payload = await fetchResource(url, {
            as: 'json',
            ttlMs: 2 * 60 * 1000,
            cacheKey,
            timeoutMs: FETCH_TIMEOUT
        });
        setCached(caches.mapping, cacheKey, payload, 2 * 60 * 1000);
        return payload;
    } catch (error) {
        console.error('[AnimeProvider] mapping request failed:', error.message);
        return null;
    }
}

function extractTmdbIdFromMappingPayload(mappingPayload) {
    const candidate = mappingPayload?.mappings?.ids?.tmdb
        || mappingPayload?.ids?.tmdb
        || mappingPayload?.tmdbId
        || null;
    const text = String(candidate || '').trim();
    return /^\d+$/.test(text) ? text : null;
}

function buildAnimeProviderContext(meta = {}) {
    return {
        imdbId: meta?.imdb_id || null,
        tmdbId: meta?.tmdb_id || null,
        kitsuId: meta?.kitsu_id || null
    };
}

async function mapLimit(values, limit, mapper) {
    if (!Array.isArray(values) || values.length === 0) return [];
    const concurrency = Math.max(1, Math.min(limit, values.length));
    const output = new Array(values.length);
    let cursor = 0;

    async function worker() {
        while (cursor < values.length) {
            const current = cursor;
            cursor += 1;
            try {
                output[current] = await mapper(values[current], current);
            } catch (error) {
                output[current] = [];
                console.error('[AnimeProvider] task failed:', error.message);
            }
        }
    }

    await Promise.all(Array.from({ length: concurrency }, () => worker()));
    return output;
}

module.exports = {
    USER_AGENT,
    FETCH_TIMEOUT,
    DEFAULT_MAPPING_API,
    uniqueStrings,
    parsePositiveInt,
    normalizeRequestedEpisode,
    normalizeRequestedSeason,
    normalizeConfigBoolean,
    getMappingLanguage,
    toAbsoluteUrl,
    fetchWithTimeout,
    fetchResource,
    parseExplicitRequestId,
    resolveLookupRequest,
    fetchMappingPayload,
    extractTmdbIdFromMappingPayload,
    buildAnimeProviderContext,
    mapLimit
};
