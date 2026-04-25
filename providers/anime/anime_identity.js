'use strict';

const kitsuProvider = require('../animeworld/kitsu_provider');
const tmdbHelper = require('../../core/utils/tmdb_helper');
const {
    uniqueStrings,
    parsePositiveInt,
    normalizeRequestedEpisode,
    normalizeRequestedSeason,
    resolveLookupRequest,
    fetchMappingPayload,
    buildAnimeProviderContext
} = require('./provider_utils');

const DEFAULT_PROVIDER_NAME = 'AnimeIdentity';
const DEFAULT_LANGUAGE = 'it-IT';

function decodeTitle(value) {
    return String(value || '')
        .replace(/&amp;/gi, '&')
        .replace(/&quot;/gi, '"')
        .replace(/&#039;|&apos;/gi, "'")
        .replace(/&lt;/gi, '<')
        .replace(/&gt;/gi, '>')
        .replace(/\u2013|\u2014/g, '-')
        .replace(/\s+/g, ' ')
        .trim();
}

function extractImdbId(value) {
    const match = String(value || '').match(/\btt\d{5,}\b/i);
    return match ? match[0].toLowerCase() : null;
}

function extractTmdbId(value) {
    const raw = String(value || '').trim();
    const tagged = raw.match(/^tmdb:(\d+)/i);
    if (tagged) return tagged[1];
    const path = raw.match(/themoviedb\.org\/(?:movie|tv)\/(\d+)/i);
    if (path) return path[1];
    return /^\d+$/.test(raw) ? raw : null;
}

function extractKitsuId(value) {
    const raw = String(value || '').trim();
    const tagged = raw.match(/^kitsu:(\d+)/i);
    if (tagged) return tagged[1];
    return null;
}

function extractYear(value) {
    const match = String(value || '').match(/\b(19|20)\d{2}\b/);
    return match ? Number.parseInt(match[0], 10) : null;
}

function collectArray(value) {
    return Array.isArray(value) ? value : [];
}

function collectMetaTitles(meta = {}) {
    return uniqueStrings([
        meta?.title,
        meta?.name,
        meta?.originalTitle,
        meta?.original_title,
        meta?.originalName,
        meta?.original_name,
        meta?.canonicalTitle,
        meta?.seriesTitle,
        meta?.englishTitle,
        meta?.romajiTitle,
        meta?.nativeTitle,
        ...collectArray(meta?.titles),
        ...collectArray(meta?.aliases),
        ...collectArray(meta?.aka_titles),
        ...collectArray(meta?.alternativeTitles),
        ...collectArray(meta?.synonyms)
    ].map(decodeTitle));
}

function collectMappingTitles(payload = {}) {
    const titles = payload?.mappings?.titles || payload?.titles || payload?.anime?.titles || payload?.data?.titles || null;
    const attrTitles = payload?.data?.attributes?.titles || null;
    const output = [];

    if (titles && typeof titles === 'object' && !Array.isArray(titles)) {
        output.push(
            titles.it,
            titles.en,
            titles.en_us,
            titles.en_jp,
            titles.ja_jp,
            titles.romaji,
            titles.canonical,
            titles.canonicalTitle,
            titles.original,
            titles.native
        );
    }

    if (Array.isArray(titles)) output.push(...titles);

    if (attrTitles && typeof attrTitles === 'object') {
        output.push(attrTitles.en, attrTitles.en_us, attrTitles.en_jp, attrTitles.ja_jp);
    }

    output.push(
        payload?.title,
        payload?.name,
        payload?.canonicalTitle,
        payload?.mappings?.title,
        payload?.mappings?.name,
        payload?.anime?.title,
        payload?.anime?.canonicalTitle,
        payload?.data?.attributes?.canonicalTitle,
        ...(Array.isArray(payload?.data?.attributes?.abbreviatedTitles) ? payload.data.attributes.abbreviatedTitles : []),
        ...(Array.isArray(payload?.mappings?.aliases) ? payload.mappings.aliases : []),
        ...(Array.isArray(payload?.aliases) ? payload.aliases : [])
    );

    return uniqueStrings(output.map(decodeTitle));
}

function buildIdCandidates(meta = {}, ...ids) {
    return uniqueStrings([
        ...ids,
        meta?.requestedId,
        meta?.originalId,
        meta?.id,
        meta?.imdb_id,
        meta?.imdbId,
        meta?.tmdb_id,
        meta?.tmdbId,
        meta?.kitsu_id ? `kitsu:${meta.kitsu_id}` : null,
        meta?.kitsuId ? `kitsu:${meta.kitsuId}` : null
    ]);
}

function looksLikeAnimeMeta(meta = {}, ...ids) {
    const directType = String(meta?.type || meta?.kind || meta?.mediaType || '').toLowerCase();
    if (/(^|[^a-z])(anime|animation)([^a-z]|$)/i.test(directType)) return true;

    const genres = Array.isArray(meta?.genres) ? meta.genres : [];
    if (genres.some((v) => /(anime|animation|animazione)/i.test(String(v)))) return true;

    const haystack = uniqueStrings([
        ...ids,
        meta?.id,
        meta?.requestedId,
        meta?.originalId,
        meta?.kitsu_id,
        meta?.kitsuId,
        ...collectMetaTitles(meta)
    ]).join(' | ').toLowerCase();

    return /(anime-kitsu|kitsu:|\banime\b|\banimazione\b)/i.test(haystack);
}

function normalizeSearchTitle(value) {
    return decodeTitle(value)
        .replace('½', '1/2')
        .replace(/[’`]/g, "'")
        .replace(/\s+-\s+-\s+/g, ' ')
        .replace(/\b(?:season|stagione|episode|episodio|ep\.?)\s*\d+\b/gi, ' ')
        .replace(/\b(?:sub\s*ita|ita|dub(?:bed)?|doppiat[oa])\b/gi, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function buildSearchTitleVariants(titles = []) {
    const out = [];
    for (const title of uniqueStrings(titles.map(decodeTitle))) {
        if (!title) continue;
        let normalized = title;
        try {
            normalized = kitsuProvider.normalizeTitle(title);
        } catch (_) {}

        const compact = normalizeSearchTitle(title);
        const normalizedCompact = normalizeSearchTitle(normalized);
        const withoutYear = compact.replace(/\s*\((19|20)\d{2}\)\s*/g, ' ').replace(/\s+/g, ' ').trim();
        const beforeColon = compact.includes(':') ? compact.split(':')[0].trim() : null;

        out.push(title, normalized, compact, normalizedCompact, withoutYear, beforeColon);
    }
    return uniqueStrings(out.filter(Boolean));
}

function parseMappingIds(payload = {}) {
    const ids = payload?.mappings?.ids || payload?.ids || payload?.mapping?.ids || {};
    const tmdbEpisode = payload?.mappings?.tmdb_episode
        || payload?.mappings?.tmdbEpisode
        || payload?.tmdb_episode
        || payload?.tmdbEpisode
        || payload?.mapping?.tmdb_episode
        || null;

    const mappedSeason = parsePositiveInt(
        tmdbEpisode?.season || tmdbEpisode?.seasonNumber || tmdbEpisode?.season_number
    );
    const mappedEpisode = parsePositiveInt(
        tmdbEpisode?.episode || tmdbEpisode?.episodeNumber || tmdbEpisode?.episode_number
    );
    const rawEpisodeNumber = parsePositiveInt(
        tmdbEpisode?.rawEpisodeNumber || tmdbEpisode?.raw_episode_number || tmdbEpisode?.rawEpisode
    );

    return {
        imdbId: extractImdbId(ids.imdb || payload?.imdbId || payload?.imdb_id),
        tmdbId: extractTmdbId(ids.tmdb || payload?.tmdbId || payload?.tmdb_id),
        kitsuId: extractKitsuId(ids.kitsu || payload?.kitsuId || payload?.kitsu_id) || String(ids.kitsu || payload?.kitsuId || payload?.kitsu_id || '').match(/^\d+$/)?.[0] || null,
        mappedSeason,
        mappedEpisode,
        rawEpisodeNumber
    };
}

function mergeContexts(primary = {}, secondary = {}) {
    return {
        ...secondary,
        ...primary,
        rawTitles: uniqueStrings([
            ...(Array.isArray(primary?.rawTitles) ? primary.rawTitles : []),
            ...(Array.isArray(secondary?.rawTitles) ? secondary.rawTitles : [])
        ]),
        searchTitles: uniqueStrings([
            ...(Array.isArray(primary?.searchTitles) ? primary.searchTitles : []),
            ...(Array.isArray(secondary?.searchTitles) ? secondary.searchTitles : [])
        ])
    };
}

async function buildKitsuContext(candidateIds = [], meta = {}) {
    const candidates = uniqueStrings([
        ...candidateIds,
        meta?.kitsu_id ? `kitsu:${meta.kitsu_id}` : null,
        meta?.kitsuId ? `kitsu:${meta.kitsuId}` : null
    ]);

    for (const candidate of candidates) {
        try {
            const parsed = kitsuProvider.parseKitsuId(candidate);
            if (!parsed?.kitsuId) continue;
            const context = await kitsuProvider.buildSearchContext(candidate, meta);
            if (context) return context;
        } catch (_) {}
    }

    try {
        return await kitsuProvider.buildSearchContext(candidates[0] || meta?.id || '', meta);
    } catch (_) {
        return null;
    }
}

async function fetchBestMapping(candidateIds = [], meta = {}, config = {}, options = {}) {
    const providerContext = {
        ...buildAnimeProviderContext(meta),
        imdbId: extractImdbId(meta?.imdb_id || meta?.imdbId) || null,
        tmdbId: extractTmdbId(meta?.tmdb_id || meta?.tmdbId) || null,
        kitsuId: extractKitsuId(meta?.kitsu_id || meta?.kitsuId ? `kitsu:${meta?.kitsu_id || meta?.kitsuId}` : '') || null,
        easyCatalogsLangIt: config?.filters?.language === 'ita' || config?.filters?.easyCatalogsLangIt,
        mappingLanguage: options.mappingLanguage || (config?.filters?.language === 'ita' ? 'it' : null)
    };

    const season = normalizeRequestedSeason(options.season ?? meta?.season);
    const episode = normalizeRequestedEpisode(options.episode ?? meta?.episode);
    const attempts = [];

    for (const candidate of uniqueStrings(candidateIds)) {
        const lookup = resolveLookupRequest(candidate, season, episode, providerContext);
        if (lookup?.provider && lookup?.externalId) attempts.push(lookup);
    }

    const contextLookup = resolveLookupRequest('', season, episode, providerContext);
    if (contextLookup?.provider && contextLookup?.externalId) attempts.push(contextLookup);

    const seen = new Set();
    for (const lookup of attempts) {
        const key = `${lookup.provider}:${lookup.externalId}:${lookup.season ?? ''}:${lookup.episode ?? ''}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const payload = await fetchMappingPayload(lookup, providerContext, options.mappingApiBase);
        if (payload) return { lookup, payload, ids: parseMappingIds(payload), titles: collectMappingTitles(payload) };
    }

    return null;
}

async function resolveTmdbMetadataFromIds(ids = {}, meta = {}, options = {}) {
    const language = options.language || DEFAULT_LANGUAGE;
    const mediaType = options.mediaType || (meta?.isSeries === false ? 'movie' : 'tv');
    try {
        if (ids.tmdbId) {
            return await tmdbHelper.getMediaInfoFull(ids.tmdbId, mediaType, { language });
        }
        if (ids.imdbId) {
            return await tmdbHelper.getTmdbMetaFromImdb(ids.imdbId, { mediaHint: mediaType, language });
        }
    } catch (_) {}
    return null;
}

async function buildAnimeSearchContextForProvider({
    requestId = null,
    originalId = null,
    finalId = null,
    meta = {},
    config = {},
    season = null,
    episode = null,
    providerName = DEFAULT_PROVIDER_NAME,
    mappingApiBase = undefined,
    language = DEFAULT_LANGUAGE
} = {}) {
    const candidateIds = buildIdCandidates(meta, requestId, originalId, finalId);
    const animeLikely = looksLikeAnimeMeta(meta, ...candidateIds);
    const kitsuContext = await buildKitsuContext(candidateIds, meta);

    const mapping = await fetchBestMapping(candidateIds, meta, config, {
        season,
        episode,
        mappingApiBase,
        language
    });

    const mappedIds = mapping?.ids || {};
    const metadata = await resolveTmdbMetadataFromIds(mappedIds, meta, {
        language,
        mediaType: meta?.isSeries === false ? 'movie' : 'tv'
    });

    const rawTitles = uniqueStrings([
        ...(Array.isArray(kitsuContext?.rawTitles) ? kitsuContext.rawTitles : []),
        ...(Array.isArray(kitsuContext?.searchTitles) ? kitsuContext.searchTitles : []),
        ...collectMetaTitles(meta),
        ...collectMappingTitles(mapping?.payload),
        metadata?.title,
        metadata?.name,
        metadata?.original_title,
        metadata?.original_name
    ].map(decodeTitle));

    const searchTitles = buildSearchTitleVariants(rawTitles);
    const requestedEpisode = mappedIds.rawEpisodeNumber
        || mappedIds.mappedEpisode
        || normalizeRequestedEpisode(kitsuContext?.requestedEpisode ?? episode ?? meta?.episode);
    const seasonNumber = mappedIds.mappedSeason
        || normalizeRequestedSeason(kitsuContext?.seasonNumber ?? season ?? meta?.season);

    const context = {
        providerName,
        isAnime: animeLikely || Boolean(kitsuContext?.kitsuId || mappedIds.kitsuId || mapping?.lookup?.provider === 'kitsu'),
        kitsuId: kitsuContext?.kitsuId || mappedIds.kitsuId || extractKitsuId(candidateIds.find((id) => /^kitsu:/i.test(String(id || '')))) || null,
        imdbId: mappedIds.imdbId || candidateIds.map(extractImdbId).find(Boolean) || null,
        tmdbId: mappedIds.tmdbId || candidateIds.map(extractTmdbId).find(Boolean) || null,
        mappedIds,
        mappingPayload: mapping?.payload || null,
        mappingLookup: mapping?.lookup || null,
        rawTitles,
        searchTitles,
        title: searchTitles[0] || rawTitles[0] || null,
        date: kitsuContext?.date || metadata?.date || metadata?.release_date || metadata?.first_air_date || null,
        year: extractYear(kitsuContext?.year || metadata?.year || metadata?.release_date || metadata?.first_air_date || meta?.year || meta?.releaseInfo || ''),
        seasonNumber,
        requestedEpisode,
        isMovie: typeof meta?.isSeries === 'boolean'
            ? !meta.isSeries
            : Boolean(kitsuContext?.isMovie)
    };

    return mergeContexts(context, kitsuContext || {});
}

module.exports = {
    collectMetaTitles,
    buildSearchTitleVariants,
    buildAnimeSearchContextForProvider,
    parseMappingIds,
    looksLikeAnimeMeta,
    extractImdbId,
    extractTmdbId,
    extractKitsuId,
    extractYear
};
