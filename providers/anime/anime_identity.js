'use strict';

const kitsuProvider = require('../animeworld/kitsu_provider');
const tmdbHelper = require('../../core/utils/tmdb_helper');
const providerUtils = require('./provider_utils');

const {
    uniqueStrings: utilsUniqueStrings,
    flattenUnique: utilsFlattenUnique,
    parsePositiveInt,
    normalizeRequestedEpisode,
    normalizeRequestedSeason,
    resolveLookupRequest,
    fetchMappingPayload,
    buildAnimeProviderContext,
    mapLimitSettled,
    normalizeTitleForSearch,
    scoreTitleMatch,
    TtlLruCache
} = providerUtils;

const DEFAULT_PROVIDER_NAME = 'AnimeIdentity';
const DEFAULT_LANGUAGE = 'it-IT';
const DEFAULT_CONTEXT_TTL_MS = 10 * 60 * 1000;
const DEFAULT_CONTEXT_STALE_MS = 60 * 60 * 1000;
const DEFAULT_CONTEXT_CACHE_MAX = 1200;
const DEFAULT_TMBD_TIMEOUT_MS = 2600;
const DEFAULT_KITSU_TIMEOUT_MS = 1800;
const DEFAULT_MAPPING_TIMEOUT_MS = 2400;
const MAX_TITLE_VARIANTS = 42;
const MAX_RAW_TITLES = 80;
const JAPANESE_CHAR_RE = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff]/;

class LocalTtlLruCache {
    constructor({ max = 500, ttlMs = 600000, staleMs = 0 } = {}) {
        this.max = Math.max(1, max | 0);
        this.ttlMs = Math.max(1, ttlMs | 0);
        this.staleMs = Math.max(0, staleMs | 0);
        this.map = new Map();
    }

    getStale(key) {
        const item = this.map.get(key);
        if (!item) return null;
        const now = Date.now();
        const hardExpiresAt = item.expiresAt + item.staleMs;
        if (hardExpiresAt <= now) {
            this.map.delete(key);
            return null;
        }
        this.map.delete(key);
        this.map.set(key, item);
        return { value: item.value, fresh: item.expiresAt > now, meta: item.meta || null };
    }

    get(key) {
        const item = this.getStale(key);
        return item && item.fresh ? item.value : undefined;
    }

    set(key, value, ttlMs = this.ttlMs, staleMs = this.staleMs, meta = null) {
        if (!key) return value;
        if (this.map.has(key)) this.map.delete(key);
        this.map.set(key, {
            value,
            meta,
            expiresAt: Date.now() + Math.max(1, ttlMs | 0),
            staleMs: Math.max(0, staleMs | 0)
        });
        while (this.map.size > this.max) {
            const oldest = this.map.keys().next().value;
            this.map.delete(oldest);
        }
        return value;
    }

    clear() {
        this.map.clear();
    }

    stats() {
        return { size: this.map.size, max: this.max, ttlMs: this.ttlMs, staleMs: this.staleMs };
    }
}

const ContextCacheClass = typeof TtlLruCache === 'function' ? TtlLruCache : LocalTtlLruCache;
const contextCache = new ContextCacheClass({
    max: DEFAULT_CONTEXT_CACHE_MAX,
    ttlMs: DEFAULT_CONTEXT_TTL_MS,
    staleMs: DEFAULT_CONTEXT_STALE_MS
});

function uniqueStrings(values = []) {
    if (typeof utilsUniqueStrings === 'function') return utilsUniqueStrings(values);
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

function flattenUnique(values = []) {
    if (typeof utilsFlattenUnique === 'function') return utilsFlattenUnique(values);
    const out = [];
    const visit = (value) => {
        if (Array.isArray(value)) {
            for (const item of value) visit(item);
            return;
        }
        if (value && typeof value === 'object') {
            for (const item of Object.values(value)) visit(item);
            return;
        }
        if (value !== null && value !== undefined) out.push(value);
    };
    visit(values);
    return uniqueStrings(out);
}

function asArray(value) {
    if (Array.isArray(value)) return value;
    if (value === null || value === undefined) return [];
    return [value];
}

function safeString(value) {
    return String(value === null || value === undefined ? '' : value).trim();
}

function decodeHtmlEntities(value) {
    return safeString(value)
        .replace(/&amp;/gi, '&')
        .replace(/&quot;/gi, '"')
        .replace(/&#039;|&apos;/gi, "'")
        .replace(/&lt;/gi, '<')
        .replace(/&gt;/gi, '>')
        .replace(/&nbsp;/gi, ' ')
        .replace(/&#x([0-9a-f]+);/gi, (_, hex) => {
            const code = Number.parseInt(hex, 16);
            return Number.isFinite(code) ? String.fromCodePoint(code) : '';
        })
        .replace(/&#(\d+);/g, (_, num) => {
            const code = Number.parseInt(num, 10);
            return Number.isFinite(code) ? String.fromCodePoint(code) : '';
        });
}

function decodeTitle(value) {
    return decodeHtmlEntities(value)
        .normalize('NFKC')
        .replace(/[\u2010-\u2015]/g, '-')
        .replace(/[\u2018\u2019\u201A\u201B`´]/g, "'")
        .replace(/[\u201C\u201D\u201E\u201F]/g, '"')
        .replace(/[\u00A0\u2000-\u200B\u202F\u205F\u3000]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function stripDiacritics(value) {
    return decodeTitle(value)
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .normalize('NFKC')
        .trim();
}

function extractImdbId(value) {
    const match = safeString(value).match(/\btt\d{5,}\b/i);
    return match ? match[0].toLowerCase() : null;
}

function extractTmdbId(value) {
    const raw = safeString(value);
    if (!raw) return null;
    const tagged = raw.match(/^tmdb(?::(?:movie|tv|series|show))?:(\d+)/i)
        || raw.match(/^tmdb:(?:movie|tv|series|show):(\d+)/i)
        || raw.match(/\btmdb(?:Id)?[=:](\d+)\b/i);
    if (tagged) return tagged[1];
    const path = raw.match(/themoviedb\.org\/(?:movie|tv)\/(\d+)/i);
    if (path) return path[1];
    return /^\d+$/.test(raw) ? raw : null;
}

function extractKitsuId(value) {
    const raw = safeString(value);
    if (!raw) return null;
    const tagged = raw.match(/^kitsu(?::(?:anime|manga|series))?:(\d+)/i)
        || raw.match(/\banime-kitsu:(\d+)\b/i)
        || raw.match(/kitsu\.io\/anime\/(\d+)/i)
        || raw.match(/\bkitsu(?:Id)?[=:](\d+)\b/i);
    return tagged ? tagged[1] : null;
}

function extractMalId(value) {
    const raw = safeString(value);
    const match = raw.match(/myanimelist\.net\/anime\/(\d+)/i)
        || raw.match(/\bmal(?:Id)?[=:](\d+)\b/i)
        || raw.match(/^mal:(\d+)$/i);
    return match ? match[1] : null;
}

function extractAnilistId(value) {
    const raw = safeString(value);
    const match = raw.match(/anilist\.co\/anime\/(\d+)/i)
        || raw.match(/\banilist(?:Id)?[=:](\d+)\b/i)
        || raw.match(/^anilist:(\d+)$/i);
    return match ? match[1] : null;
}

function extractYear(value) {
    const raw = safeString(value);
    const match = raw.match(/\b(19|20)\d{2}\b/);
    return match ? Number.parseInt(match[0], 10) : null;
}

function inferTmdbMediaType(value, meta = {}) {
    const raw = safeString(value).toLowerCase();
    if (/tmdb:(movie):/i.test(raw) || /themoviedb\.org\/movie\//i.test(raw)) return 'movie';
    if (/tmdb:(tv|series|show):/i.test(raw) || /themoviedb\.org\/tv\//i.test(raw)) return 'tv';
    if (meta?.isSeries === false || meta?.type === 'movie' || meta?.mediaType === 'movie') return 'movie';
    return 'tv';
}

function collectDeepTitleValues(value, depth = 0) {
    if (depth > 4 || value === null || value === undefined) return [];
    if (typeof value === 'string' || typeof value === 'number') return [value];
    if (Array.isArray(value)) return value.flatMap(item => collectDeepTitleValues(item, depth + 1));
    if (typeof value === 'object') {
        const preferredKeys = [
            'it', 'it_it', 'ita', 'italian',
            'en', 'en_us', 'en_jp', 'english',
            'ja', 'ja_jp', 'jp', 'japanese',
            'romaji', 'canonical', 'canonicalTitle', 'original', 'originalTitle',
            'native', 'nativeTitle', 'localized', 'title', 'name', 'value'
        ];
        const out = [];
        for (const key of preferredKeys) {
            if (Object.prototype.hasOwnProperty.call(value, key)) out.push(...collectDeepTitleValues(value[key], depth + 1));
        }
        return out;
    }
    return [];
}

function collectArray(value) {
    return Array.isArray(value) ? value : [];
}

function collectMetaTitles(meta = {}) {
    const nestedTitleObjects = [
        meta?.titles,
        meta?.aliases,
        meta?.aka_titles,
        meta?.alternativeTitles,
        meta?.synonyms,
        meta?.translations,
        meta?.externalTitles,
        meta?.anime?.titles,
        meta?.data?.attributes?.titles,
        meta?.data?.attributes?.abbreviatedTitles
    ];

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
        meta?.japaneseTitle,
        meta?.releaseInfo,
        ...nestedTitleObjects.flatMap(collectDeepTitleValues)
    ].map(decodeTitle)).slice(0, MAX_RAW_TITLES);
}

function collectMappingTitles(payload = {}) {
    const titleSources = [
        payload?.mappings?.titles,
        payload?.mapping?.titles,
        payload?.titles,
        payload?.anime?.titles,
        payload?.data?.titles,
        payload?.data?.attributes?.titles,
        payload?.mappings?.aliases,
        payload?.mapping?.aliases,
        payload?.aliases,
        payload?.data?.attributes?.abbreviatedTitles
    ];

    const output = [
        payload?.title,
        payload?.name,
        payload?.canonicalTitle,
        payload?.mappings?.title,
        payload?.mappings?.name,
        payload?.mapping?.title,
        payload?.mapping?.name,
        payload?.anime?.title,
        payload?.anime?.canonicalTitle,
        payload?.data?.attributes?.canonicalTitle,
        ...titleSources.flatMap(collectDeepTitleValues)
    ];

    return uniqueStrings(output.map(decodeTitle)).slice(0, MAX_RAW_TITLES);
}

function splitTitleIntoAliases(title) {
    const raw = decodeTitle(title);
    if (!raw) return [];
    const out = [raw];

    const withoutYear = raw.replace(/\s*[\[(](?:19|20)\d{2}(?:[–-](?:19|20)?\d{0,4})?[\])]\s*/g, ' ').replace(/\s+/g, ' ').trim();
    if (withoutYear && withoutYear !== raw) out.push(withoutYear);

    const parenthetical = [...raw.matchAll(/[\[(]([^\])]{2,80})[\])]/g)].map(match => match[1]);
    out.push(...parenthetical);

    for (const delimiter of [' / ', ' | ', ' aka ', ' AKA ', ' — ', ' – ']) {
        if (raw.includes(delimiter)) out.push(...raw.split(delimiter));
    }

    const slashLoose = raw.split(/\s*\/\s*/).filter(part => part.length >= 2 && part.length <= 90);
    if (slashLoose.length > 1) out.push(...slashLoose);

    if (raw.includes(':')) {
        const [head, ...tail] = raw.split(':');
        const rest = tail.join(':').trim();
        if (head.trim().length >= 2) out.push(head.trim());
        if (rest.length >= 2) out.push(rest);
    }

    return uniqueStrings(out.map(decodeTitle));
}

function normalizeSearchTitle(value) {
    let text = decodeTitle(value)
        .replace('½', '1/2')
        .replace(/[’`]/g, "'")
        .replace(/\s+-\s+-\s+/g, ' ')
        .replace(/\b(?:season|stagione|cour|part|parte|episode|episodio|episodi|ep\.?|ova|ona|special)\s*\d+\b/gi, ' ')
        .replace(/\b(?:s\d{1,2}e\d{1,3}|s\d{1,2}|e\d{1,3})\b/gi, ' ')
        .replace(/\b(?:sub\s*ita|ita|italian|dub(?:bed)?|doppiat[oa]|multi|dual\s*audio|eng|jap|jpn)\b/gi, ' ')
        .replace(/\b(?:1080p|720p|2160p|4k|web[-\s]?dl|webrip|bluray|bdrip|hdtv)\b/gi, ' ')
        .replace(/[{}\[\]]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();

    if (typeof normalizeTitleForSearch === 'function') {
        try {
            const normalized = normalizeTitleForSearch(text);
            if (normalized) text = normalized;
        } catch (_) {}
    }

    return decodeTitle(text);
}

function simplifyTitleKey(value) {
    return stripDiacritics(normalizeSearchTitle(value))
        .toLowerCase()
        .replace(/&/g, ' and ')
        .replace(/[^a-z0-9\u3040-\u30ff\u3400-\u9fff]+/gi, ' ')
        .replace(/\b(the|a|an|il|lo|la|i|gli|le|un|una|uno|di|de|del|della|and|e)\b/gi, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function scoreSearchVariant(title, index = 0) {
    const value = decodeTitle(title);
    if (!value) return -999;
    const compact = normalizeSearchTitle(value);
    const key = simplifyTitleKey(value);
    if (!compact || key.length < 2) return -999;

    let score = 100 - Math.min(index, 25);
    if (value === compact) score += 8;
    if (JAPANESE_CHAR_RE.test(value)) score -= 4;
    if (/\b(?:stagione|episodio|episode|season|sub ita|dub|1080p|720p)\b/i.test(value)) score -= 14;
    if (/^[a-z0-9 ':-]{2,80}$/i.test(stripDiacritics(value))) score += 4;
    if (compact.length >= 3 && compact.length <= 48) score += 8;
    if (compact.length > 90) score -= 20;
    if (/^[0-9]+$/.test(key)) score -= 80;
    return score;
}

function buildSearchTitleVariants(titles = []) {
    const expanded = [];
    for (const title of uniqueStrings(titles.map(decodeTitle))) {
        if (!title) continue;
        expanded.push(title);
        expanded.push(...splitTitleIntoAliases(title));

        let kitsuNormalized = null;
        try {
            if (typeof kitsuProvider.normalizeTitle === 'function') kitsuNormalized = kitsuProvider.normalizeTitle(title);
        } catch (_) {}
        if (kitsuNormalized) expanded.push(kitsuNormalized);

        const compact = normalizeSearchTitle(title);
        const noAccent = stripDiacritics(compact);
        const noYear = compact.replace(/\s*[\[(]?(?:19|20)\d{2}[\])]?$\s*/g, '').trim();
        expanded.push(compact, noAccent, noYear);

        const aliases = splitTitleIntoAliases(compact);
        expanded.push(...aliases);
        for (const alias of aliases) expanded.push(stripDiacritics(alias));
    }

    const unique = uniqueStrings(expanded.map(normalizeSearchTitle).filter(Boolean));
    return unique
        .map((title, index) => ({ title, score: scoreSearchVariant(title, index), key: simplifyTitleKey(title) }))
        .filter(item => item.score > -50 && item.key.length >= 2)
        .sort((a, b) => b.score - a.score || a.title.length - b.title.length)
        .filter((item, index, arr) => arr.findIndex(other => other.key === item.key) === index)
        .slice(0, MAX_TITLE_VARIANTS)
        .map(item => item.title);
}

function buildIdCandidates(meta = {}, ...ids) {
    const nested = [
        meta?.external_ids,
        meta?.externalIds,
        meta?.ids,
        meta?.mappings?.ids,
        meta?.mapping?.ids,
        meta?.links,
        meta?.urls
    ];

    return uniqueStrings([
        ...ids,
        meta?.requestedId,
        meta?.originalId,
        meta?.finalId,
        meta?.stremioId,
        meta?.videoId,
        meta?.id,
        meta?.imdb_id,
        meta?.imdbId,
        meta?.imdb,
        meta?.tmdb_id,
        meta?.tmdbId,
        meta?.tmdb,
        meta?.kitsu_id ? `kitsu:${meta.kitsu_id}` : null,
        meta?.kitsuId ? `kitsu:${meta.kitsuId}` : null,
        meta?.kitsu ? `kitsu:${meta.kitsu}` : null,
        meta?.mal_id ? `mal:${meta.mal_id}` : null,
        meta?.malId ? `mal:${meta.malId}` : null,
        meta?.anilist_id ? `anilist:${meta.anilist_id}` : null,
        meta?.anilistId ? `anilist:${meta.anilistId}` : null,
        ...nested.flatMap(flattenUnique)
    ]);
}

function getAnimeLikelihood(meta = {}, ...ids) {
    const candidateIds = uniqueStrings([...ids, ...buildIdCandidates(meta)]);
    const titles = collectMetaTitles(meta);
    const genres = uniqueStrings([
        ...asArray(meta?.genres),
        ...asArray(meta?.genre),
        ...asArray(meta?.categories),
        ...asArray(meta?.tags)
    ]).join(' | ').toLowerCase();
    const type = safeString(meta?.type || meta?.kind || meta?.mediaType || meta?.contentType).toLowerCase();
    const lang = safeString(meta?.original_language || meta?.originalLanguage || meta?.language || meta?.lang).toLowerCase();
    const countries = uniqueStrings([
        ...asArray(meta?.origin_country),
        ...asArray(meta?.originCountry),
        ...asArray(meta?.countries),
        meta?.country
    ]).join('|').toLowerCase();
    const haystack = uniqueStrings([...candidateIds, ...titles, genres, type, lang, countries]).join(' | ');

    let score = 0;
    const reasons = [];
    const add = (points, reason) => {
        score += points;
        reasons.push(reason);
    };

    if (candidateIds.some(extractKitsuId)) add(6, 'kitsu-id');
    if (candidateIds.some(extractMalId)) add(4, 'mal-id');
    if (candidateIds.some(extractAnilistId)) add(4, 'anilist-id');
    if (/\banime\b|anime-kitsu|kitsu:/i.test(haystack)) add(4, 'anime-token');
    if (/\b(manga|shounen|shonen|seinen|shojo|shoujo|josei|isekai|mecha)\b/i.test(haystack)) add(3, 'anime-genre-token');
    if (/\b(animation|animazione)\b/i.test(genres) || /\banimation\b/i.test(type)) add(1, 'animation');
    if (/^(ja|jp|jpn|japanese)$/i.test(lang) || /\b(jp|japan|japanese|giappone|giapponese)\b/i.test(countries)) add(2, 'japanese-origin');
    if (titles.some(title => JAPANESE_CHAR_RE.test(title))) add(2, 'japanese-title');

    const confidence = score >= 7 ? 'high' : score >= 4 ? 'medium' : score >= 2 ? 'low' : 'none';
    return {
        score,
        confidence,
        reasons: uniqueStrings(reasons),
        isAnime: score >= 4 || candidateIds.some(extractKitsuId)
    };
}

function looksLikeAnimeMeta(meta = {}, ...ids) {
    return getAnimeLikelihood(meta, ...ids).isAnime;
}

function parseEpisodeObject(source = {}) {
    const raw = source || {};
    const season = parsePositiveInt(
        raw.season || raw.seasonNumber || raw.season_number || raw.tmdbSeason || raw.tmdb_season || raw.s
    );
    const episode = parsePositiveInt(
        raw.episode || raw.episodeNumber || raw.episode_number || raw.tmdbEpisode || raw.tmdb_episode || raw.e
    );
    const absolute = parsePositiveInt(
        raw.rawEpisodeNumber || raw.raw_episode_number || raw.rawEpisode || raw.absoluteEpisode || raw.absolute_episode || raw.abs
    );
    return { season, episode, absolute };
}

function parseMappingIds(payload = {}) {
    const ids = payload?.mappings?.ids || payload?.mapping?.ids || payload?.ids || payload?.external_ids || {};
    const tmdbEpisode = payload?.mappings?.tmdb_episode
        || payload?.mappings?.tmdbEpisode
        || payload?.mapping?.tmdb_episode
        || payload?.mapping?.tmdbEpisode
        || payload?.tmdb_episode
        || payload?.tmdbEpisode
        || payload?.episode
        || payload?.data?.episode
        || null;

    const episodeInfo = parseEpisodeObject(tmdbEpisode || {});
    const tmdbRaw = ids.tmdb || payload?.tmdbId || payload?.tmdb_id || payload?.tmdb;
    const imdbRaw = ids.imdb || payload?.imdbId || payload?.imdb_id || payload?.imdb;
    const kitsuRaw = ids.kitsu || payload?.kitsuId || payload?.kitsu_id || payload?.kitsu;
    const malRaw = ids.mal || ids.myanimelist || payload?.malId || payload?.mal_id;
    const anilistRaw = ids.anilist || payload?.anilistId || payload?.anilist_id;

    return {
        imdbId: extractImdbId(imdbRaw),
        tmdbId: extractTmdbId(tmdbRaw),
        tmdbType: inferTmdbMediaType(tmdbRaw, payload),
        kitsuId: extractKitsuId(kitsuRaw) || safeString(kitsuRaw).match(/^\d+$/)?.[0] || null,
        malId: extractMalId(malRaw) || safeString(malRaw).match(/^\d+$/)?.[0] || null,
        anilistId: extractAnilistId(anilistRaw) || safeString(anilistRaw).match(/^\d+$/)?.[0] || null,
        mappedSeason: episodeInfo.season,
        mappedEpisode: episodeInfo.episode,
        rawEpisodeNumber: episodeInfo.absolute
    };
}

function mergeContexts(primary = {}, secondary = {}) {
    return {
        ...secondary,
        ...primary,
        rawTitles: uniqueStrings([
            ...(Array.isArray(primary?.rawTitles) ? primary.rawTitles : []),
            ...(Array.isArray(secondary?.rawTitles) ? secondary.rawTitles : [])
        ]).slice(0, MAX_RAW_TITLES),
        searchTitles: uniqueStrings([
            ...(Array.isArray(primary?.searchTitles) ? primary.searchTitles : []),
            ...(Array.isArray(secondary?.searchTitles) ? secondary.searchTitles : [])
        ]).slice(0, MAX_TITLE_VARIANTS),
        identitySources: uniqueStrings([
            ...(Array.isArray(primary?.identitySources) ? primary.identitySources : []),
            ...(Array.isArray(secondary?.identitySources) ? secondary.identitySources : [])
        ])
    };
}

function withTimeout(promise, timeoutMs, fallback = null) {
    if (!timeoutMs || timeoutMs <= 0) return promise;
    let timer = null;
    return Promise.race([
        promise,
        new Promise(resolve => {
            timer = setTimeout(() => resolve(fallback), timeoutMs);
        })
    ]).finally(() => {
        if (timer) clearTimeout(timer);
    });
}

async function safeAsync(label, fn, fallback = null) {
    try {
        return await fn();
    } catch (error) {
        if (process.env.LEVIATHAN_DEBUG_IDENTITY === '1') {
            console.error(`[AnimeIdentity] ${label} failed:`, error?.message || error);
        }
        return fallback;
    }
}

async function buildKitsuContext(candidateIds = [], meta = {}, options = {}) {
    const candidates = uniqueStrings([
        ...candidateIds,
        meta?.kitsu_id ? `kitsu:${meta.kitsu_id}` : null,
        meta?.kitsuId ? `kitsu:${meta.kitsuId}` : null,
        meta?.kitsu ? `kitsu:${meta.kitsu}` : null
    ]);

    const explicitKitsu = candidates.filter(candidate => extractKitsuId(candidate));
    const ordered = uniqueStrings([...explicitKitsu, ...candidates]);
    const timeoutMs = options.kitsuTimeoutMs || DEFAULT_KITSU_TIMEOUT_MS;

    for (const candidate of ordered) {
        const context = await withTimeout(safeAsync('kitsu-context', async () => {
            if (typeof kitsuProvider.parseKitsuId === 'function') {
                const parsed = kitsuProvider.parseKitsuId(candidate);
                if (!parsed?.kitsuId && explicitKitsu.includes(candidate)) return null;
            }
            if (typeof kitsuProvider.buildSearchContext !== 'function') return null;
            return await kitsuProvider.buildSearchContext(candidate, meta);
        }), timeoutMs, null);
        if (context) return context;
    }

    return null;
}

function buildProviderContext(meta = {}, config = {}, options = {}) {
    const base = typeof buildAnimeProviderContext === 'function' ? buildAnimeProviderContext(meta) : {};
    const langFilter = safeString(config?.filters?.language || config?.language || options.languageFilter).toLowerCase();
    const candidateIds = buildIdCandidates(meta);

    return {
        ...base,
        imdbId: extractImdbId(base?.imdbId || meta?.imdb_id || meta?.imdbId || meta?.imdb || candidateIds.find(extractImdbId)) || null,
        tmdbId: extractTmdbId(base?.tmdbId || meta?.tmdb_id || meta?.tmdbId || meta?.tmdb || candidateIds.find(extractTmdbId)) || null,
        kitsuId: extractKitsuId(base?.kitsuId || meta?.kitsu_id || meta?.kitsuId || meta?.kitsu || candidateIds.find(extractKitsuId)) || null,
        easyCatalogsLangIt: config?.filters?.language === 'ita'
            || config?.filters?.language === 'it'
            || config?.filters?.easyCatalogsLangIt
            || config?.easyCatalogsLangIt
            || ['it', 'ita', 'italian', 'italiano'].includes(langFilter),
        mappingLanguage: options.mappingLanguage || config?.filters?.mappingLanguage || config?.mappingLanguage || (['it', 'ita', 'italian', 'italiano'].includes(langFilter) ? 'it' : null),
        mappingTimeoutMs: options.mappingTimeoutMs || DEFAULT_MAPPING_TIMEOUT_MS,
        mappingRetries: options.mappingRetries ?? 2,
        mappingApiBases: options.mappingApiBases || options.mappingMirrors || config?.mappingApiBases || config?.mappingMirrors || null
    };
}

async function fetchBestMapping(candidateIds = [], meta = {}, config = {}, options = {}) {
    const providerContext = buildProviderContext(meta, config, options);
    const season = normalizeRequestedSeason(options.season ?? meta?.season);
    const episode = normalizeRequestedEpisode(options.episode ?? meta?.episode);
    const explicitKitsu = providerContext.kitsuId ? [`kitsu:${providerContext.kitsuId}`] : [];
    const attempts = [];

    for (const candidate of uniqueStrings([...explicitKitsu, ...candidateIds])) {
        const lookup = resolveLookupRequest(candidate, season, episode, providerContext);
        if (lookup?.provider && lookup?.externalId) attempts.push(lookup);
    }

    const contextLookup = resolveLookupRequest('', season, episode, providerContext);
    if (contextLookup?.provider && contextLookup?.externalId) attempts.push(contextLookup);

    const seen = new Set();
    const ordered = [];
    for (const lookup of attempts) {
        const key = `${lookup.provider}:${lookup.externalId}:${lookup.season ?? 'na'}:${lookup.episode ?? 'na'}`;
        if (seen.has(key)) continue;
        seen.add(key);
        ordered.push(lookup);
    }

    for (const lookup of ordered) {
        const payload = await withTimeout(safeAsync('mapping', async () => {
            return await fetchMappingPayload(lookup, providerContext, options.mappingApiBase || providerContext.mappingApiBases);
        }), providerContext.mappingTimeoutMs, null);
        if (payload) {
            return {
                lookup,
                payload,
                ids: parseMappingIds(payload),
                titles: collectMappingTitles(payload),
                providerContext
            };
        }
    }

    return null;
}

async function resolveTmdbMetadataFromIds(ids = {}, meta = {}, options = {}) {
    const language = options.language || DEFAULT_LANGUAGE;
    const mediaType = options.mediaType || ids.tmdbType || (meta?.isSeries === false ? 'movie' : 'tv');
    const timeoutMs = options.tmdbTimeoutMs || DEFAULT_TMBD_TIMEOUT_MS;

    return await withTimeout(safeAsync('tmdb-metadata', async () => {
        if (ids.tmdbId && typeof tmdbHelper.getMediaInfoFull === 'function') {
            return await tmdbHelper.getMediaInfoFull(ids.tmdbId, mediaType, { language });
        }
        if (ids.imdbId && typeof tmdbHelper.getTmdbMetaFromImdb === 'function') {
            return await tmdbHelper.getTmdbMetaFromImdb(ids.imdbId, { mediaHint: mediaType, language });
        }
        return null;
    }), timeoutMs, null);
}

function buildEpisodeCandidates({ mappedIds = {}, kitsuContext = {}, season = null, episode = null, meta = {} } = {}) {
    const requested = normalizeRequestedEpisode(episode ?? meta?.episode ?? kitsuContext?.requestedEpisode);
    const seasonNumber = mappedIds.mappedSeason
        || normalizeRequestedSeason(season ?? meta?.season ?? kitsuContext?.seasonNumber);
    const candidates = uniqueStrings([
        mappedIds.rawEpisodeNumber,
        mappedIds.mappedEpisode,
        requested,
        kitsuContext?.absoluteEpisode,
        kitsuContext?.episodeNumber,
        meta?.episodeNumber,
        meta?.episode
    ].map(value => {
        const parsed = parsePositiveInt(value);
        return parsed ? String(parsed) : null;
    })).map(Number);

    return {
        seasonNumber,
        requestedEpisode: mappedIds.rawEpisodeNumber || mappedIds.mappedEpisode || requested,
        tmdbEpisode: mappedIds.mappedEpisode || null,
        absoluteEpisode: mappedIds.rawEpisodeNumber || kitsuContext?.absoluteEpisode || null,
        episodeCandidates: candidates
    };
}

function buildIdentityCacheKey({ requestId, originalId, finalId, meta, config, season, episode, providerName, language }) {
    const ids = buildIdCandidates(meta, requestId, originalId, finalId).slice(0, 12).join('|');
    const titles = collectMetaTitles(meta).slice(0, 8).join('|');
    const lang = language || config?.filters?.language || config?.language || '';
    return [providerName, ids, titles, season ?? meta?.season ?? '', episode ?? meta?.episode ?? '', lang].join('::');
}

function buildIdentityDiagnostics(context) {
    return {
        providerName: context.providerName,
        isAnime: context.isAnime,
        animeScore: context.animeScore,
        animeConfidence: context.animeConfidence,
        identitySources: context.identitySources,
        kitsuId: context.kitsuId,
        imdbId: context.imdbId,
        tmdbId: context.tmdbId,
        title: context.title,
        year: context.year,
        seasonNumber: context.seasonNumber,
        requestedEpisode: context.requestedEpisode,
        rawTitleCount: context.rawTitles?.length || 0,
        searchTitleCount: context.searchTitles?.length || 0
    };
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
    mappingApiBases = undefined,
    mappingMirrors = undefined,
    language = DEFAULT_LANGUAGE,
    disableCache = false,
    cacheTtlMs = DEFAULT_CONTEXT_TTL_MS,
    cacheStaleMs = DEFAULT_CONTEXT_STALE_MS,
    debug = false,
    kitsuTimeoutMs = DEFAULT_KITSU_TIMEOUT_MS,
    mappingTimeoutMs = DEFAULT_MAPPING_TIMEOUT_MS,
    tmdbTimeoutMs = DEFAULT_TMBD_TIMEOUT_MS
} = {}) {
    const cacheKey = buildIdentityCacheKey({ requestId, originalId, finalId, meta, config, season, episode, providerName, language });
    if (!disableCache) {
        const cached = typeof contextCache.getStale === 'function' ? contextCache.getStale(cacheKey) : null;
        if (cached?.fresh) return cached.value;
    }

    const candidateIds = buildIdCandidates(meta, requestId, originalId, finalId);
    const animeLikelihood = getAnimeLikelihood(meta, ...candidateIds);
    const mappingOptions = {
        season,
        episode,
        mappingApiBase,
        mappingApiBases: mappingApiBases || mappingMirrors,
        language,
        mappingLanguage: config?.filters?.language === 'ita' || config?.filters?.language === 'it' ? 'it' : undefined,
        kitsuTimeoutMs,
        mappingTimeoutMs,
        tmdbTimeoutMs
    };

    const [resolvedKitsuContext, mapping] = await Promise.all([
        buildKitsuContext(candidateIds, meta, { kitsuTimeoutMs }),
        fetchBestMapping(candidateIds, meta, config, mappingOptions)
    ]);

    const mappedIds = mapping?.ids || {};

    let kitsuContext = resolvedKitsuContext;
    if (!kitsuContext?.kitsuId) {
        const discoveredKitsuId = mappedIds.kitsuId
            || candidateIds.map(extractKitsuId).find(Boolean)
            || null;
        if (discoveredKitsuId) {
            const enrichedKitsuContext = await buildKitsuContext([`kitsu:${discoveredKitsuId}`], meta, { kitsuTimeoutMs });
            if (enrichedKitsuContext?.kitsuId) {
                kitsuContext = kitsuContext
                    ? mergeContexts(enrichedKitsuContext, kitsuContext)
                    : enrichedKitsuContext;
            }
        }
    }
    const metadata = await resolveTmdbMetadataFromIds(mappedIds, meta, {
        language,
        mediaType: mappedIds.tmdbType || (meta?.isSeries === false ? 'movie' : 'tv'),
        tmdbTimeoutMs
    });

    const rawTitles = uniqueStrings([
        ...(Array.isArray(kitsuContext?.rawTitles) ? kitsuContext.rawTitles : []),
        ...(Array.isArray(kitsuContext?.searchTitles) ? kitsuContext.searchTitles : []),
        ...collectMetaTitles(meta),
        ...collectMappingTitles(mapping?.payload),
        metadata?.title,
        metadata?.name,
        metadata?.original_title,
        metadata?.original_name,
        metadata?.canonicalTitle
    ].map(decodeTitle)).slice(0, MAX_RAW_TITLES);

    const searchTitles = buildSearchTitleVariants(rawTitles);
    const episodeInfo = buildEpisodeCandidates({ mappedIds, kitsuContext, season, episode, meta });
    const idsFromCandidates = {
        imdbId: candidateIds.map(extractImdbId).find(Boolean) || null,
        tmdbId: candidateIds.map(extractTmdbId).find(Boolean) || null,
        kitsuId: candidateIds.map(extractKitsuId).find(Boolean) || null,
        malId: candidateIds.map(extractMalId).find(Boolean) || null,
        anilistId: candidateIds.map(extractAnilistId).find(Boolean) || null
    };

    const identitySources = [];
    if (kitsuContext) identitySources.push('kitsu');
    if (mapping) identitySources.push(`mapping:${mapping.lookup?.provider || 'unknown'}`);
    if (metadata) identitySources.push('tmdb');
    if (candidateIds.length) identitySources.push('stremio-id');

    const context = {
        providerName,
        isAnime: animeLikelihood.isAnime || Boolean(kitsuContext?.kitsuId || mappedIds.kitsuId || mapping?.lookup?.provider === 'kitsu'),
        animeScore: animeLikelihood.score + (kitsuContext ? 3 : 0) + (mappedIds.kitsuId ? 3 : 0),
        animeConfidence: animeLikelihood.confidence,
        animeReasons: animeLikelihood.reasons,
        identitySources: uniqueStrings(identitySources),
        kitsuId: kitsuContext?.kitsuId || mappedIds.kitsuId || idsFromCandidates.kitsuId || null,
        imdbId: mappedIds.imdbId || idsFromCandidates.imdbId || null,
        tmdbId: mappedIds.tmdbId || idsFromCandidates.tmdbId || null,
        malId: mappedIds.malId || idsFromCandidates.malId || null,
        anilistId: mappedIds.anilistId || idsFromCandidates.anilistId || null,
        mappedIds,
        mappingPayload: mapping?.payload || null,
        mappingLookup: mapping?.lookup || null,
        rawTitles,
        searchTitles,
        normalizedTitleKeys: uniqueStrings(searchTitles.map(simplifyTitleKey)).slice(0, MAX_TITLE_VARIANTS),
        title: searchTitles[0] || rawTitles[0] || null,
        originalTitle: metadata?.original_title || metadata?.original_name || meta?.originalTitle || meta?.original_title || null,
        date: kitsuContext?.date || metadata?.date || metadata?.release_date || metadata?.first_air_date || meta?.released || meta?.releaseDate || null,
        year: extractYear(kitsuContext?.year || metadata?.year || metadata?.release_date || metadata?.first_air_date || meta?.year || meta?.releaseInfo || ''),
        seasonNumber: episodeInfo.seasonNumber,
        requestedEpisode: episodeInfo.requestedEpisode,
        tmdbEpisode: episodeInfo.tmdbEpisode,
        absoluteEpisode: episodeInfo.absoluteEpisode,
        episodeCandidates: episodeInfo.episodeCandidates,
        isMovie: typeof meta?.isSeries === 'boolean'
            ? !meta.isSeries
            : Boolean(kitsuContext?.isMovie || meta?.type === 'movie' || mappedIds.tmdbType === 'movie'),
        metadata,
        candidateIds
    };

    const merged = mergeContexts(context, kitsuContext || {});
    merged.debug = debug ? buildIdentityDiagnostics(merged) : undefined;

    if (!disableCache) {
        if (typeof contextCache.set === 'function') contextCache.set(cacheKey, merged, cacheTtlMs, cacheStaleMs, { providerName });
    }

    return merged;
}

function pickBestTitleMatch(candidateTitle, contextOrTitles = {}, options = {}) {
    const titles = Array.isArray(contextOrTitles)
        ? contextOrTitles
        : Array.isArray(contextOrTitles?.searchTitles)
            ? contextOrTitles.searchTitles
            : [];
    if (!candidateTitle || !titles.length) return { score: 0, title: null, matchedTitle: null };

    let best = { score: 0, title: candidateTitle, matchedTitle: null };
    for (const title of titles) {
        let score = 0;
        if (typeof scoreTitleMatch === 'function') {
            try {
                score = scoreTitleMatch(candidateTitle, title);
            } catch (_) {}
        }
        if (!score) {
            const a = simplifyTitleKey(candidateTitle);
            const b = simplifyTitleKey(title);
            if (a && b) {
                if (a === b) score = 1;
                else if (a.includes(b) || b.includes(a)) score = Math.min(a.length, b.length) / Math.max(a.length, b.length);
                else {
                    const setA = new Set(a.split(' ').filter(Boolean));
                    const setB = new Set(b.split(' ').filter(Boolean));
                    const shared = [...setA].filter(token => setB.has(token)).length;
                    score = shared / Math.max(setA.size, setB.size, 1);
                }
            }
        }
        if (score > best.score) best = { score, title: candidateTitle, matchedTitle: title };
    }

    const minScore = options.minScore ?? 0.62;
    return { ...best, accepted: best.score >= minScore };
}

function filterAndRankTitleCandidates(candidates = [], context = {}, options = {}) {
    return uniqueStrings(candidates.map(decodeTitle))
        .map(title => pickBestTitleMatch(title, context, options))
        .filter(item => item.accepted)
        .sort((a, b) => b.score - a.score);
}

function getAnimeIdentityStats() {
    return {
        contextCache: typeof contextCache.stats === 'function' ? contextCache.stats() : { size: contextCache.map?.size || 0 }
    };
}

function clearAnimeIdentityCache() {
    if (typeof contextCache.clear === 'function') contextCache.clear();
}

module.exports = {
    collectMetaTitles,
    collectMappingTitles,
    buildSearchTitleVariants,
    buildAnimeSearchContextForProvider,
    parseMappingIds,
    looksLikeAnimeMeta,
    getAnimeLikelihood,
    pickBestTitleMatch,
    filterAndRankTitleCandidates,
    normalizeSearchTitle,
    simplifyTitleKey,
    splitTitleIntoAliases,
    buildIdCandidates,
    buildKitsuContext,
    fetchBestMapping,
    resolveTmdbMetadataFromIds,
    extractImdbId,
    extractTmdbId,
    extractKitsuId,
    extractMalId,
    extractAnilistId,
    extractYear,
    getAnimeIdentityStats,
    clearAnimeIdentityCache
};

