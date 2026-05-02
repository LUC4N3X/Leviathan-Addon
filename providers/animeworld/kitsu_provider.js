'use strict';

const {
    TtlLruCache,
    SingleFlight,
    uniqueStrings,
    flattenUnique,
    parsePositiveInt,
    normalizeRequestedEpisode,
    normalizeRequestedSeason,
    decodeHtml,
    normalizeSpaces,
    normalizeTitleForSearch,
    buildTitleVariants,
    titleSimilarity,
    fetchResource,
    getCacheStats: getSharedCacheStats
} = require('../anime/shared');

const KITSU_API_BASE = 'https://kitsu.io/api/edge';
const TIMEOUT = 9000;
const INFO_TTL = 12 * 60 * 60 * 1000;
const INFO_STALE_TTL = 10 * 24 * 60 * 60 * 1000;
const SEARCH_TTL = 6 * 60 * 60 * 1000;
const SEARCH_STALE_TTL = 3 * 24 * 60 * 60 * 1000;

const infoCache = new TtlLruCache({ name: 'kitsu-info', ttlMs: INFO_TTL, staleTtlMs: INFO_STALE_TTL, max: 5000 });
const searchCache = new TtlLruCache({ name: 'kitsu-search', ttlMs: SEARCH_TTL, staleTtlMs: SEARCH_STALE_TTL, max: 1500 });
const inflight = new SingleFlight('kitsu-provider');

function extractYear(value) {
    const match = String(value || '').match(/\b(19|20)\d{2}\b/);
    return match ? match[0] : null;
}

function numberOrNull(value) {
    const parsed = Number.parseInt(String(value || ''), 10);
    return Number.isInteger(parsed) ? parsed : null;
}

function collectMetaTitles(meta = {}) {
    return uniqueStrings(flattenUnique(
        meta?.title,
        meta?.name,
        meta?.originalTitle,
        meta?.original_title,
        meta?.originalName,
        meta?.original_name,
        meta?.canonicalTitle,
        meta?.englishTitle,
        meta?.romajiTitle,
        meta?.nativeTitle,
        meta?.seriesTitle,
        meta?.titles,
        meta?.aliases,
        meta?.aka_titles,
        meta?.alternativeTitles,
        meta?.synonyms,
        meta?.mappings?.titles
    ).map(decodeHtml));
}

function collectKitsuTitles(attributes = {}) {
    const titles = attributes?.titles || {};
    return uniqueStrings(flattenUnique(
        titles.en,
        titles.en_us,
        titles.en_jp,
        titles.ja_jp,
        titles.en_cn,
        titles.zh_cn,
        attributes?.canonicalTitle,
        attributes?.abbreviatedTitles,
        attributes?.slug
    ).map(decodeHtml));
}

function getCover(attributes = {}) {
    const poster = attributes?.posterImage || {};
    const cover = attributes?.coverImage || {};
    return poster.original || poster.large || poster.medium || cover.original || cover.large || null;
}

function parseEpisodeToken(value) {
    const text = String(value || '').trim().toLowerCase();
    const explicit = text.match(/(?:^|[^a-z])e(?:p(?:isode)?)?\s*0*(\d{1,4})(?:$|[^a-z])/i);
    if (explicit) return parsePositiveInt(explicit[1]);
    return parsePositiveInt(text);
}

function parseSeasonToken(value) {
    const text = String(value || '').trim().toLowerCase();
    const explicit = text.match(/(?:^|[^a-z])s(?:eason|tagione)?\s*0*(\d{1,3})(?:$|[^a-z])/i);
    if (explicit) return normalizeRequestedSeason(explicit[1]);
    const parsed = Number.parseInt(text, 10);
    return Number.isInteger(parsed) && parsed >= 0 ? parsed : null;
}

function extractNumericKitsuId(value) {
    const raw = String(value || '').trim();
    const url = raw.match(/kitsu\.io\/(?:api\/edge\/)?anime\/(\d+)/i);
    if (url) return url[1];
    const tagged = raw.match(/(?:^|[^a-z])kitsu(?::|-|_)?(?:anime:?)?(\d+)/i);
    if (tagged) return tagged[1];
    const animeKitsu = raw.match(/anime-kitsu[:_-]?(\d+)/i);
    if (animeKitsu) return animeKitsu[1];
    return null;
}

function normalizeGenericTitle(title) {
    return normalizeSpaces(decodeHtml(title)
        .replace(/½/g, '1/2')
        .replace(/[’`´]/g, "'")
        .replace(/[–—]/g, '-')
        .replace(/\s+-\s+-\s+/g, ' ')
        .replace(/\bShippuuden\b/gi, 'Shippuden')
        .replace(/\bSaison\b/gi, 'Season')
        .replace(/\bStagione\b/gi, 'Season'));
}

function buildItalianAnimeAlias(title) {
    const exactMap = new Map([
        ['Demon Slayer: Kimetsu no Yaiba - The Movie: Infinity Castle', 'Demon Slayer: Kimetsu no Yaiba Infinity Castle'],
        ['Attack on Titan: The Final Season - Final Chapters Part 2', "L'attacco dei Giganti: L'ultimo attacco"],
        ['Ore dake Level Up na Ken', 'Solo Leveling'],
        ['Lupin the Third: The Woman Called Fujiko Mine', 'Lupin III - La donna chiamata Fujiko Mine'],
        ['Slam Dunk: Roar!! Basket Man Spiriy', 'Slam Dunk: Hoero Basketman-damashii! Hanamichi to Rukawa no Atsuki Natsu'],
        ['Parasyte: The Maxim', 'Kiseijuu'],
        ['Attack on Titan OAD', "L'attacco dei Giganti: Il taccuino di Ilse"],
        ['Fullmetal Alchemist: Brotherhood', 'Fullmetal Alchemist Brotherhood'],
        ["JoJo's Bizarre Adventure (2012)", 'Le Bizzarre Avventure di JoJo'],
        ["JoJo's Bizarre Adventure: Stardust Crusaders", 'Le Bizzarre Avventure di JoJo: Stardust Crusaders'],
        ["Cat's Eye (2025)", 'Occhi di gatto (2025)'],
        ['Ranma ½ (2024) Season 2', 'Ranma 1/2 (2024) 2'],
        ['Link Click Season 2', 'Link Click 2'],
        ['Nichijou - My Ordinary Life', 'Nichijou'],
        ['Case Closed Movie 01: The Time Bombed Skyscraper', 'Detective Conan Movie 01: Fino alla fine del tempo'],
        ['My Hero Academia Final Season', 'Boku no Hero Academia: Final Season'],
        ['Jujutsu Kaisen: The Culling Game Part 1', 'Jujutsu Kaisen 3: The Culling Game Part 1'],
        ["Hell's Paradise Season 2", 'Jigokuraku 2'],
        ['[Oshi no Ko]', 'Oshi no Ko'],
        ['Record of Ragnarok II', 'Record of Ragnarok 2'],
        ['Magical Circle', 'Mahoujin Guru Guru'],
        ['One Piece', 'One Piece'],
        ['Detective Conan', 'Detective Conan'],
        ['Case Closed', 'Detective Conan']
    ]);

    const normalized = normalizeGenericTitle(title);
    if (exactMap.has(normalized)) return exactMap.get(normalized);

    let out = normalized;
    const genericMap = [
        [/\bAttack on Titan\b/gi, "L'attacco dei Giganti"],
        [/\bCase Closed\b/gi, 'Detective Conan'],
        [/\bMy Hero Academia\b/gi, 'Boku no Hero Academia'],
        [/\bDemon Slayer\b/gi, 'Kimetsu no Yaiba'],
        [/\bHell's Paradise\b/gi, 'Jigokuraku']
    ];

    for (const [pattern, replacement] of genericMap) out = out.replace(pattern, replacement);
    return normalizeSpaces(out);
}

function buildProviderTitleVariants(titles = []) {
    const seeded = [];
    for (const title of uniqueStrings(titles)) {
        const generic = normalizeGenericTitle(title);
        const alias = buildItalianAnimeAlias(generic);
        const noSeasonWord = generic.replace(/\bSeason\s+(\d+)\b/gi, '$1').replace(/\s+/g, ' ').trim();
        const noBrackets = generic.replace(/[\[\]]/g, '').replace(/\s+/g, ' ').trim();
        const clean = normalizeTitleForSearch(generic);
        seeded.push(alias, title, generic, noSeasonWord, noBrackets, clean);
    }
    return buildTitleVariants(seeded);
}

function parseKitsuData(payload = {}, sourceId = null) {
    const data = payload?.data && !Array.isArray(payload.data) ? payload.data : payload;
    const attributes = data?.attributes || {};
    const titles = collectKitsuTitles(attributes);
    const startDate = attributes?.startDate || null;
    const endDate = attributes?.endDate || null;
    const subtype = attributes?.subtype || null;
    const status = attributes?.status || null;
    const episodeCount = Number.isInteger(attributes?.episodeCount)
        ? attributes.episodeCount
        : Number.parseInt(String(attributes?.episodeCount || ''), 10) || null;
    const episodeLength = Number.parseInt(String(attributes?.episodeLength || ''), 10) || null;

    return {
        kitsuId: String(data?.id || sourceId || '').trim() || null,
        title: titles[0] || attributes?.canonicalTitle || null,
        canonicalTitle: attributes?.canonicalTitle || null,
        titles,
        searchTitles: buildProviderTitleVariants(titles),
        slug: attributes?.slug || null,
        synopsis: attributes?.synopsis || null,
        description: attributes?.description || attributes?.synopsis || null,
        date: startDate,
        startDate,
        endDate,
        year: extractYear(startDate),
        subtype,
        status,
        ageRating: attributes?.ageRating || null,
        ageRatingGuide: attributes?.ageRatingGuide || null,
        averageRating: attributes?.averageRating ? Number(attributes.averageRating) : null,
        ratingRank: numberOrNull(attributes?.ratingRank),
        popularityRank: numberOrNull(attributes?.popularityRank),
        episodeCount,
        episodeLength,
        poster: getCover(attributes),
        isMovie: String(subtype || '').toLowerCase() === 'movie' || episodeCount === 1,
        raw: payload
    };
}

class KitsuProvider {
    async getAnimeInfo(kitsuId) {
        const parsed = this.parseKitsuId(String(kitsuId || '').trim());
        const normalizedId = parsed?.kitsuId || extractNumericKitsuId(kitsuId) || (/^\d+$/.test(String(kitsuId || '').trim()) ? String(kitsuId).trim() : null);
        if (!normalizedId) return null;

        const cacheKey = `info:${normalizedId}`;
        const cached = infoCache.get(cacheKey);
        if (cached !== undefined) return cached;

        return inflight.do(cacheKey, async () => {
            const cachedAgain = infoCache.get(cacheKey);
            if (cachedAgain !== undefined) return cachedAgain;

            try {
                const payload = await fetchResource(`${KITSU_API_BASE}/anime/${encodeURIComponent(normalizedId)}`, {
                    as: 'json',
                    ttlMs: INFO_TTL,
                    staleTtlMs: INFO_STALE_TTL,
                    timeoutMs: TIMEOUT,
                    cacheKey: `kitsu-api:anime:${normalizedId}`,
                    accept: 'application/vnd.api+json, application/json;q=0.9, */*;q=0.8',
                    circuitKey: 'https://kitsu.io'
                });
                const info = payload?.data ? parseKitsuData(payload, normalizedId) : null;
                return infoCache.set(cacheKey, info, INFO_TTL, INFO_STALE_TTL);
            } catch (error) {
                console.error(`Error fetching Kitsu info for ID ${normalizedId}:`, error.message);
                const stale = infoCache.getStale(cacheKey);
                return stale !== undefined ? stale : null;
            }
        });
    }

    async searchAnimeByTitle(title, options = {}) {
        const query = normalizeTitleForSearch(title);
        if (!query || query.length < 2) return [];

        const limit = Math.max(1, Math.min(Number.parseInt(options.limit || 8, 10) || 8, 20));
        const cacheKey = `search:${query.toLowerCase()}:limit=${limit}`;
        const cached = searchCache.get(cacheKey);
        if (cached !== undefined) return cached;

        return inflight.do(cacheKey, async () => {
            try {
                const url = `${KITSU_API_BASE}/anime?filter[text]=${encodeURIComponent(query)}&page[limit]=${limit}`;
                const payload = await fetchResource(url, {
                    as: 'json',
                    ttlMs: SEARCH_TTL,
                    staleTtlMs: SEARCH_STALE_TTL,
                    timeoutMs: TIMEOUT,
                    cacheKey: `kitsu-api:search:${query}:limit=${limit}`,
                    accept: 'application/vnd.api+json, application/json;q=0.9, */*;q=0.8',
                    circuitKey: 'https://kitsu.io'
                });

                const results = Array.isArray(payload?.data)
                    ? payload.data.map((item) => parseKitsuData(item)).filter(Boolean)
                    : [];

                const scored = results
                    .map((item) => ({
                        ...item,
                        matchScore: Math.max(...[...(item.titles || []), ...(item.searchTitles || [])].map((candidate) => titleSimilarity(query, candidate)), 0)
                    }))
                    .sort((a, b) => b.matchScore - a.matchScore);

                return searchCache.set(cacheKey, scored, SEARCH_TTL, SEARCH_STALE_TTL);
            } catch (error) {
                console.error(`Error searching Kitsu title "${query}":`, error.message);
                const stale = searchCache.getStale(cacheKey);
                return stale !== undefined ? stale : [];
            }
        });
    }

    async resolveBestByTitle(titles = [], options = {}) {
        const candidates = buildProviderTitleVariants(titles).slice(0, Math.max(1, options.maxQueries || 6));
        let best = null;

        for (const title of candidates) {
            const results = await this.searchAnimeByTitle(title, { limit: options.limit || 8 });
            const localBest = results[0] || null;
            if (!localBest) continue;
            if (!best || (localBest.matchScore || 0) > (best.matchScore || 0)) best = localBest;
            if ((best.matchScore || 0) >= (options.acceptScore || 0.88)) break;
        }

        return best && (best.matchScore || 0) >= (options.minScore || 0.62) ? best : null;
    }

    parseKitsuId(kitsuIdString) {
        const raw = String(kitsuIdString || '').trim();
        if (!raw) return null;

        const fromUrl = raw.match(/kitsu\.io\/(?:api\/edge\/)?anime\/(\d+)(?:[^\d].*)?$/i);
        if (fromUrl) {
            return { kitsuId: fromUrl[1], seasonNumber: null, episodeNumber: null, isMovie: null, source: 'url' };
        }

        const cleaned = raw
            .replace(/^anime-kitsu[:_-]?/i, 'kitsu:')
            .replace(/^kitsu_anime[:_-]?/i, 'kitsu:')
            .replace(/^kitsu\/anime\//i, 'kitsu:')
            .replace(/^kitsu:anime:/i, 'kitsu:');

        if (/^\d+$/.test(cleaned)) {
            return { kitsuId: cleaned, seasonNumber: null, episodeNumber: null, isMovie: null, source: 'numeric' };
        }

        const parts = cleaned.split(':').map((part) => String(part || '').trim()).filter(Boolean);
        if (parts.length < 2 || parts[0].toLowerCase() !== 'kitsu' || !/^\d+$/.test(parts[1])) return null;

        const kitsuId = parts[1];
        let seasonNumber = null;
        let episodeNumber = null;

        if (parts.length === 3) {
            episodeNumber = parseEpisodeToken(parts[2]);
        } else if (parts.length >= 4) {
            seasonNumber = parseSeasonToken(parts[2]);
            episodeNumber = parseEpisodeToken(parts[3]);
        }

        return {
            kitsuId,
            seasonNumber,
            episodeNumber,
            isMovie: episodeNumber ? false : null,
            source: 'tagged'
        };
    }

    normalizeTitle(title) {
        const variants = buildProviderTitleVariants([title]);
        return variants[0] || normalizeGenericTitle(title);
    }

    buildTitleVariants(titles = []) {
        return buildProviderTitleVariants(Array.isArray(titles) ? titles : [titles]);
    }

    async buildSearchContext(requestId, meta = {}) {
        const candidates = uniqueStrings(flattenUnique(requestId, meta?.id, meta?.requestedId, meta?.originalId, meta?.kitsu_id, meta?.kitsuId));
        let parsed = null;

        for (const candidate of candidates) {
            parsed = this.parseKitsuId(candidate);
            if (parsed?.kitsuId) break;
        }

        const metaTitles = collectMetaTitles(meta);
        let info = parsed?.kitsuId ? await this.getAnimeInfo(parsed.kitsuId) : null;

        if (!info && metaTitles.length) {
            info = await this.resolveBestByTitle(metaTitles, { minScore: 0.67, acceptScore: 0.9, maxQueries: 6, limit: 8 });
            if (info?.kitsuId) parsed = { kitsuId: info.kitsuId, seasonNumber: null, episodeNumber: null, isMovie: info.isMovie, source: 'search' };
        }

        const rawTitles = uniqueStrings(flattenUnique(info?.titles, info?.canonicalTitle, info?.title, metaTitles).map(decodeHtml));
        const searchTitles = buildProviderTitleVariants(rawTitles);
        const requestedEpisode = Number.isInteger(parsed?.episodeNumber) && parsed.episodeNumber > 0
            ? parsed.episodeNumber
            : normalizeRequestedEpisode(meta?.episode || meta?.episodeNumber);
        const requestedSeason = Number.isInteger(parsed?.seasonNumber) && parsed.seasonNumber >= 0
            ? parsed.seasonNumber
            : normalizeRequestedSeason(meta?.season || meta?.seasonNumber);
        const metaSeriesFlag = typeof meta?.isSeries === 'boolean' ? meta.isSeries : null;
        const subtype = String(info?.subtype || '').toLowerCase();
        const isMovie = typeof metaSeriesFlag === 'boolean'
            ? !metaSeriesFlag
            : Boolean(parsed?.isMovie === true || info?.isMovie || subtype === 'movie');

        return {
            kitsuId: parsed?.kitsuId || info?.kitsuId || null,
            info,
            rawTitles,
            searchTitles,
            title: searchTitles[0] || rawTitles[0] || null,
            date: info?.date || meta?.date || meta?.release_date || meta?.first_air_date || null,
            year: extractYear(info?.date || meta?.year || meta?.releaseInfo || meta?.date || ''),
            seasonNumber: requestedSeason,
            requestedEpisode,
            episodeNumber: requestedEpisode,
            isMovie,
            confidence: info?.matchScore || (parsed?.kitsuId ? 1 : 0),
            source: parsed?.source || (info?.matchScore ? 'search' : 'meta')
        };
    }

    extractYear(value) {
        return extractYear(value);
    }

    getCacheStats() {
        return {
            info: infoCache.stats(),
            search: searchCache.stats(),
            inflight: inflight.stats(),
            shared: getSharedCacheStats()
        };
    }

    clearCaches() {
        infoCache.clear();
        searchCache.clear();
    }
}

module.exports = new KitsuProvider();
