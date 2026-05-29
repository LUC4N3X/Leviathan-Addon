'use strict';

const axios = require('axios');

const URLS = {
    FRIBB: 'https://raw.githubusercontent.com/Fribb/anime-lists/master/anime-list-full.json',
    THEBEAST: 'https://raw.githubusercontent.com/TheBeastLT/stremio-kitsu-anime/master/static/data/imdb_mapping.json',
    KITSU_API: 'https://kitsu.io/api/edge/anime'
};

function parsePositiveInt(value, fallback = null) {
    const parsed = Number.parseInt(value, 10);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function parseEnvInt(name, fallback) {
    return parsePositiveInt(process.env[name], fallback);
}

const CACHE_DURATION = parseEnvInt('LEVI_KITSU_CACHE_TTL_MS', 1000 * 60 * 60 * 24);
const HTTP_TIMEOUT = parseEnvInt('LEVI_KITSU_HTTP_TIMEOUT_MS', 20000);
const LIVE_TIMEOUT = parseEnvInt('LEVI_KITSU_LIVE_TIMEOUT_MS', 3500);
const LOG_ENABLED = String(process.env.LEVI_KITSU_LOGS || 'true').toLowerCase() !== 'false';

const http = axios.create({
    timeout: HTTP_TIMEOUT,
    headers: {
        accept: 'application/json',
        'user-agent': 'Leviathan-Stremio-Addon/1.0 (+kitsu-mapping)'
    },
    validateStatus: status => status >= 200 && status < 300,
    transitional: {
        clarifyTimeoutError: true
    }
});

let mappingCache = {
    map: new Map(),
    lastFetch: 0,
    lastSuccessAt: null,
    isLoaded: false,
    isLoading: false,
    lastError: null,
    sources: {
        fribb: 0,
        thebeastlt: 0,
        live: 0
    }
};

let mappingCachePromise = null;

function log(...args) {
    if (LOG_ENABLED) console.log(...args);
}

function warn(...args) {
    if (LOG_ENABLED) console.warn(...args);
}

function uniqueStrings(values = []) {
    const seen = new Set();
    const output = [];

    for (const value of values.flat()) {
        const text = String(value || '').trim();
        const key = text.toLowerCase();
        if (!text || seen.has(key)) continue;
        seen.add(key);
        output.push(text);
    }

    return output;
}

function parseKitsuIdentifier(rawValue) {
    const value = String(rawValue || '').trim();
    if (!value) return null;

    if (/^\d+$/.test(value)) {
        return {
            raw: `kitsu:${value}`,
            kitsuId: value,
            season: 1,
            episode: null,
            isEpisode: false
        };
    }

    const parts = value.split(':').map(part => String(part || '').trim());
    if (parts.length < 2 || parts[0].toLowerCase() !== 'kitsu' || !/^\d+$/.test(parts[1])) {
        return null;
    }

    let season = 1;
    let episode = null;

    if (parts.length === 3) {
        episode = parsePositiveInt(parts[2], null);
    } else if (parts.length >= 4) {
        season = parsePositiveInt(parts[2], 1);
        episode = parsePositiveInt(parts[3], null);
    }

    return {
        raw: value,
        kitsuId: parts[1],
        season,
        episode,
        isEpisode: Number.isInteger(episode) && episode > 0
    };
}

function normalizeType(kitsuType) {
    const type = String(kitsuType || '').trim().toLowerCase();
    return type === 'movie' || type === 'film' ? 'movie' : 'series';
}

function normalizeImdbId(value) {
    const text = String(value || '').trim();
    if (!text) return '';
    if (/^tt\d+$/i.test(text)) return text.toLowerCase();
    const numeric = text.match(/\d+/)?.[0];
    return numeric ? `tt${numeric}` : text;
}

function buildTitleVariants(attributes = {}) {
    return uniqueStrings([
        attributes?.canonicalTitle,
        attributes?.titles?.en,
        attributes?.titles?.en_us,
        attributes?.titles?.en_jp,
        attributes?.titles?.ja_jp,
        ...(Array.isArray(attributes?.abbreviatedTitles) ? attributes.abbreviatedTitles : [])
    ]);
}

function getBeastEntries(rawData) {
    if (Array.isArray(rawData)) return rawData;
    if (rawData && Array.isArray(rawData.data)) return rawData.data;
    if (rawData && Array.isArray(rawData.entries)) return rawData.entries;

    if (rawData && typeof rawData === 'object') {
        return Object.entries(rawData).map(([kitsuId, entry]) => ({
            kitsu_id: kitsuId,
            ...(entry && typeof entry === 'object' ? entry : {})
        }));
    }

    return [];
}

function mergeEntry(previous = {}, next = {}) {
    const titles = uniqueStrings([
        previous.titles,
        previous.aliases,
        next.titles,
        next.aliases
    ]);

    const source = uniqueStrings([
        previous.source,
        next.source
    ]).join('+');

    return {
        kitsuId: String(next.kitsuId || previous.kitsuId || '').trim(),
        imdb_id: normalizeImdbId(next.imdb_id || previous.imdb_id),
        type: next.type || previous.type || 'series',
        season: parsePositiveInt(next.season, parsePositiveInt(previous.season, 1)),
        episode: parsePositiveInt(next.episode, parsePositiveInt(previous.episode, 1)),
        titles,
        aliases: titles,
        year: String(next.year || previous.year || '').match(/^\d{4}$/)?.[0] || '',
        subtype: String(next.subtype || previous.subtype || ''),
        episode_count: parsePositiveInt(next.episode_count, parsePositiveInt(previous.episode_count, null)),
        source: source || next.source || previous.source || 'unknown'
    };
}

function putEntry(targetMap, kitsuId, entry) {
    const key = String(kitsuId || entry?.kitsuId || '').trim();
    if (!key || !entry?.imdb_id) return false;

    targetMap.set(key, mergeEntry(targetMap.get(key), {
        ...entry,
        kitsuId: key
    }));

    return true;
}

function buildFribbEntry(item = {}) {
    const kitsuId = String(item.kitsu_id || item.kitsuId || '').trim();
    const imdbId = normalizeImdbId(item.imdb_id || item.imdbId || item.imdb);
    if (!kitsuId || !imdbId) return null;

    const titles = uniqueStrings([
        item.title,
        item.title_english,
        item.title_japanese,
        item.name,
        ...(Array.isArray(item.synonyms) ? item.synonyms : [])
    ]);

    return {
        kitsuId,
        imdb_id: imdbId,
        type: normalizeType(item.type || item.subtype || 'TV'),
        season: 1,
        episode: 1,
        titles,
        aliases: titles,
        year: String(item.year || '').match(/^\d{4}$/)?.[0] || '',
        subtype: String(item.subtype || item.type || ''),
        episode_count: parsePositiveInt(item.episodeCount || item.episodes || null, null),
        source: 'fribb'
    };
}

function buildTheBeastEntry(rawEntry = {}) {
    const kitsuId = String(rawEntry.kitsu_id || rawEntry.kitsuId || rawEntry.id || '').trim();
    const imdbId = normalizeImdbId(rawEntry.imdb_id || rawEntry.imdbId || rawEntry.imdb);
    if (!kitsuId || !imdbId) return null;

    const titles = uniqueStrings([
        rawEntry.title,
        rawEntry.name,
        rawEntry.canonicalTitle,
        rawEntry.originalTitle,
        ...(Array.isArray(rawEntry.titles) ? rawEntry.titles : []),
        ...(Array.isArray(rawEntry.aliases) ? rawEntry.aliases : [])
    ]);

    return {
        kitsuId,
        imdb_id: imdbId,
        type: normalizeType(rawEntry.type || rawEntry.subtype || 'TV'),
        season: parsePositiveInt(rawEntry.fromSeason ?? rawEntry.season ?? rawEntry.startSeason, 1),
        episode: parsePositiveInt(rawEntry.fromEpisode ?? rawEntry.episode ?? rawEntry.startEpisode, 1),
        titles,
        aliases: titles,
        year: String(rawEntry.year || '').match(/^\d{4}$/)?.[0] || '',
        subtype: String(rawEntry.subtype || rawEntry.type || ''),
        episode_count: parsePositiveInt(rawEntry.episodeCount ?? rawEntry.episodes ?? null, null),
        source: 'thebeastlt'
    };
}

function shouldRefreshCache() {
    return !mappingCache.isLoaded || Date.now() - mappingCache.lastFetch >= CACHE_DURATION;
}

function refreshCacheInBackground() {
    if (!mappingCache.isLoaded || mappingCache.isLoading || !shouldRefreshCache()) return;

    updateCache().catch(error => {
        mappingCache.lastError = error.message;
        warn('⚠️ [KITSU] Background cache refresh failed:', error.message);
    });
}

async function updateCache(options = {}) {
    const force = options.force === true;
    const now = Date.now();

    if (!force && mappingCache.isLoaded && now - mappingCache.lastFetch < CACHE_DURATION) {
        return mappingCache;
    }

    if (mappingCache.isLoading && mappingCachePromise) {
        return mappingCachePromise;
    }

    mappingCache.isLoading = true;
    log('🐉 [KITSU] Avvio download database mapping...');

    mappingCachePromise = (async () => {
        const tempMap = new Map();
        const sources = {
            fribb: 0,
            thebeastlt: 0,
            live: mappingCache.sources.live || 0
        };

        let successfulSources = 0;
        let lastError = null;

        const [fribbRes, beastRes] = await Promise.allSettled([
            http.get(URLS.FRIBB),
            http.get(URLS.THEBEAST)
        ]);

        if (fribbRes.status === 'fulfilled' && Array.isArray(fribbRes.value.data)) {
            successfulSources += 1;

            for (const item of fribbRes.value.data) {
                const entry = buildFribbEntry(item);
                if (putEntry(tempMap, entry?.kitsuId, entry)) sources.fribb += 1;
            }
        } else if (fribbRes.status === 'rejected') {
            lastError = `fribb: ${fribbRes.reason?.message || 'unknown_error'}`;
            warn('⚠️ [KITSU] Fribb mapping non disponibile:', fribbRes.reason?.message || fribbRes.reason);
        }

        if (beastRes.status === 'fulfilled' && beastRes.value.data) {
            successfulSources += 1;

            const entries = getBeastEntries(beastRes.value.data);
            for (const rawEntry of entries) {
                const entry = buildTheBeastEntry(rawEntry);
                if (putEntry(tempMap, entry?.kitsuId, entry)) sources.thebeastlt += 1;
            }
        } else if (beastRes.status === 'rejected') {
            lastError = `thebeastlt: ${beastRes.reason?.message || 'unknown_error'}`;
            warn('⚠️ [KITSU] TheBeastLT mapping non disponibile:', beastRes.reason?.message || beastRes.reason);
        }

        if (successfulSources > 0 && tempMap.size > 0) {
            mappingCache.map = tempMap;
            mappingCache.lastFetch = Date.now();
            mappingCache.lastSuccessAt = new Date().toISOString();
            mappingCache.isLoaded = true;
            mappingCache.lastError = null;
            mappingCache.sources = sources;

            log(`🐉 [KITSU] Cache rigenerata. Totale anime: ${tempMap.size} | Fribb: ${sources.fribb} | TheBeastLT: ${sources.thebeastlt}`);
            return mappingCache;
        }

        mappingCache.lastError = lastError || 'no_valid_mapping_entries';

        if (mappingCache.isLoaded) {
            warn('⚠️ [KITSU] Refresh fallito, mantengo la cache precedente.');
            return mappingCache;
        }

        throw new Error(mappingCache.lastError);
    })();

    try {
        return await mappingCachePromise;
    } finally {
        mappingCache.isLoading = false;
        mappingCachePromise = null;
    }
}

async function fetchKitsuLive(kitsuID) {
    try {
        const parsedIdentifier = parseKitsuIdentifier(kitsuID);
        const normalizedId = parsedIdentifier?.kitsuId || String(kitsuID || '').trim();
        if (!normalizedId) return null;

        const url = `${URLS.KITSU_API}/${normalizedId}?include=mappings`;
        const res = await http.get(url, { timeout: LIVE_TIMEOUT });

        const data = res.data?.data;
        const included = Array.isArray(res.data?.included) ? res.data.included : [];

        if (!data || included.length === 0) return null;

        const imdbMapping = included.find(mapping => {
            const site = String(mapping?.attributes?.externalSite || '').toLowerCase();
            return mapping?.type === 'mappings' && site === 'imdb';
        });

        const imdbId = normalizeImdbId(imdbMapping?.attributes?.externalId);
        if (!imdbId) return null;

        const attributes = data.attributes || {};
        const titles = buildTitleVariants(attributes);
        const startDate = String(attributes.startDate || '');

        return {
            kitsuId: normalizedId,
            imdb_id: imdbId,
            type: normalizeType(attributes.subtype || 'TV'),
            season: 1,
            episode: 1,
            titles,
            aliases: titles,
            year: /^\d{4}/.test(startDate) ? startDate.slice(0, 4) : '',
            subtype: String(attributes.subtype || ''),
            episode_count: parsePositiveInt(attributes.episodeCount, null),
            source: 'kitsu-live'
        };
    } catch (error) {
        mappingCache.lastError = error.message;
        return null;
    }
}

function buildResult(entry, parsedIdentifier) {
    const requestedSeason = parsedIdentifier?.isEpisode
        ? parsePositiveInt(parsedIdentifier.season, 1)
        : null;

    const requestedEpisode = parsedIdentifier?.isEpisode
        ? parsePositiveInt(parsedIdentifier.episode, null)
        : null;

    return {
        imdbID: entry.imdb_id,
        kitsuId: parsedIdentifier?.kitsuId || entry.kitsuId || '',
        season: requestedSeason || parsePositiveInt(entry.season, 1),
        episode: requestedEpisode || parsePositiveInt(entry.episode, 1),
        type: entry.type || 'series',
        titles: uniqueStrings(entry.titles || entry.aliases || []),
        aliases: uniqueStrings(entry.aliases || entry.titles || []),
        year: entry.year || '',
        subtype: entry.subtype || '',
        episodeCount: parsePositiveInt(entry.episode_count, null),
        source: entry.source || 'unknown'
    };
}

async function kitsuHandler(kitsuID) {
    const parsedIdentifier = parseKitsuIdentifier(kitsuID);
    if (!parsedIdentifier?.kitsuId) return null;

    const strID = parsedIdentifier.kitsuId;

    if (!mappingCache.isLoaded) {
        try {
            await updateCache();
        } catch (error) {
            warn('⚠️ [KITSU] Cache iniziale non disponibile, provo live fallback:', error.message);
        }
    } else {
        refreshCacheInBackground();
    }

    let entry = mappingCache.map.get(strID);

    if (!entry) {
        entry = await fetchKitsuLive(strID);

        if (entry) {
            mappingCache.map.set(strID, entry);
            mappingCache.sources.live = (mappingCache.sources.live || 0) + 1;
        }
    }

    if (!entry) return null;

    return buildResult(entry, parsedIdentifier);
}

function getCacheStats() {
    return {
        loaded: mappingCache.isLoaded,
        loading: mappingCache.isLoading,
        size: mappingCache.map.size,
        lastFetch: mappingCache.lastFetch,
        lastSuccessAt: mappingCache.lastSuccessAt,
        lastError: mappingCache.lastError,
        sources: { ...mappingCache.sources }
    };
}

setImmediate(() => {
    updateCache().catch(error => {
        mappingCache.lastError = error.message;
        warn('⚠️ [KITSU] Preload cache fallito:', error.message);
    });
});

module.exports = kitsuHandler;
module.exports.kitsuHandler = kitsuHandler;
module.exports.parseKitsuIdentifier = parseKitsuIdentifier;
module.exports.updateCache = updateCache;
module.exports.getCacheStats = getCacheStats;
