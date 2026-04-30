const axios = require('axios');

const ANILIST_URL = 'https://graphql.anilist.co';
const CACHE_TTL_MS = 1000 * 60 * 60 * 6;

const cache = new Map();
const inflight = new Map();

function parsePositiveInt(value, fallback = null) {
    const parsed = parseInt(value, 10);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function uniqueStrings(values = []) {
    const seen = new Set();
    const output = [];
    for (const value of values) {
        const text = String(value || '').trim();
        const key = text.toLowerCase();
        if (!text || seen.has(key)) continue;
        seen.add(key);
        output.push(text);
    }
    return output;
}

function normalizeTitle(value) {
    return String(value || '')
        .toLowerCase()
        .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
        .replace(/&/g, ' and ')
        .replace(/[^a-z0-9\s]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function tokenize(value) {
    return normalizeTitle(value).split(/\s+/).filter(Boolean);
}

function overlapRatio(left, right) {
    const a = new Set(tokenize(left));
    const b = new Set(tokenize(right));
    if (!a.size || !b.size) return 0;
    let hits = 0;
    for (const token of a) {
        if (b.has(token)) hits += 1;
    }
    return hits / Math.max(a.size, 1);
}

function normalizeAniListMedia(media = {}) {
    const titles = uniqueStrings([
        media?.title?.romaji,
        media?.title?.english,
        media?.title?.native,
        ...(Array.isArray(media?.synonyms) ? media.synonyms : [])
    ]);

    return {
        anilistId: parsePositiveInt(media?.id, null),
        malId: parsePositiveInt(media?.idMal, null),
        titles,
        aliases: titles,
        format: String(media?.format || '').toUpperCase(),
        year: String(media?.startDate?.year || media?.seasonYear || '').trim(),
        episodeCount: parsePositiveInt(media?.episodes, null),
        status: String(media?.status || '').toUpperCase(),
        season: String(media?.season || '').toUpperCase(),
        description: String(media?.description || '').trim()
    };
}

function scoreAniListCandidate(media = {}, expected = {}) {
    const normalized = normalizeAniListMedia(media);
    const titles = Array.isArray(expected?.titles) ? expected.titles : [];
    const expectedYear = parsePositiveInt(expected?.year, null);
    const expectedSubtype = String(expected?.subtype || '').toUpperCase();

    let titleScore = 0;
    for (const wanted of titles) {
        for (const candidate of normalized.titles) {
            titleScore = Math.max(titleScore, overlapRatio(wanted, candidate));
            if (normalizeTitle(wanted) === normalizeTitle(candidate)) titleScore = Math.max(titleScore, 1);
        }
    }

    let score = titleScore * 100;

    const candidateYear = parsePositiveInt(normalized.year, null);
    if (expectedYear && candidateYear) {
        const delta = Math.abs(expectedYear - candidateYear);
        if (delta === 0) score += 16;
        else if (delta === 1) score += 8;
        else if (delta >= 3) score -= 18;
    }

    if (expectedSubtype) {
        const format = normalized.format;
        if (expectedSubtype === 'MOVIE' && format === 'MOVIE') score += 14;
        if (expectedSubtype === 'TV' && (format === 'TV' || format === 'TV_SHORT')) score += 12;
        if (expectedSubtype === 'ONA' && format === 'ONA') score += 10;
        if (expectedSubtype === 'OVA' && format === 'OVA') score += 10;
    }

    return { score, normalized };
}

async function postAniList(query, variables = {}) {
    const { data } = await axios.post(
        ANILIST_URL,
        { query, variables },
        {
            timeout: 4500,
            headers: {
                'Content-Type': 'application/json',
                'Accept': 'application/json'
            }
        }
    );
    return data?.data || null;
}

function withCache(key, producer) {
    const now = Date.now();
    const cached = cache.get(key);
    if (cached && (now - cached.ts) < CACHE_TTL_MS) return Promise.resolve(cached.value);
    if (inflight.has(key)) return inflight.get(key);

    const promise = (async () => {
        try {
            const value = await producer();
            cache.set(key, { ts: now, value });
            return value;
        } finally {
            inflight.delete(key);
        }
    })();

    inflight.set(key, promise);
    return promise;
}

async function fetchByAniListId(anilistId) {
    const id = parsePositiveInt(anilistId, null);
    if (!id) return null;
    return withCache(`id:${id}`, async () => {
        const query = `query ($id: Int) {
            Media(id: $id, type: ANIME) {
                id
                idMal
                title { romaji english native }
                synonyms
                format
                episodes
                status
                season
                seasonYear
                startDate { year month day }
                description(asHtml: false)
            }
        }`;
        const data = await postAniList(query, { id });
        return data?.Media ? normalizeAniListMedia(data.Media) : null;
    });
}

async function fetchByMalId(malId) {
    const id = parsePositiveInt(malId, null);
    if (!id) return null;
    return withCache(`mal:${id}`, async () => {
        const query = `query ($idMal: Int) {
            Media(idMal: $idMal, type: ANIME) {
                id
                idMal
                title { romaji english native }
                synonyms
                format
                episodes
                status
                season
                seasonYear
                startDate { year month day }
                description(asHtml: false)
            }
        }`;
        const data = await postAniList(query, { idMal: id });
        return data?.Media ? normalizeAniListMedia(data.Media) : null;
    });
}

async function searchByTitle(title, year) {
    const cleanTitle = String(title || '').trim();
    if (!cleanTitle) return [];
    const key = `search:${normalizeTitle(cleanTitle)}:${parsePositiveInt(year, 0) || 0}`;
    return withCache(key, async () => {
        const query = `query ($search: String, $seasonYear: Int) {
            Page(page: 1, perPage: 6) {
                media(search: $search, type: ANIME, sort: SEARCH_MATCH, seasonYear: $seasonYear) {
                    id
                    idMal
                    title { romaji english native }
                    synonyms
                    format
                    episodes
                    status
                    season
                    seasonYear
                    startDate { year month day }
                    description(asHtml: false)
                }
            }
        }`;
        let data = await postAniList(query, { search: cleanTitle, seasonYear: parsePositiveInt(year, null) });
        let media = Array.isArray(data?.Page?.media) ? data.Page.media : [];
        if (!media.length) {
            data = await postAniList(query, { search: cleanTitle, seasonYear: null });
            media = Array.isArray(data?.Page?.media) ? data.Page.media : [];
        }
        return media.map(normalizeAniListMedia);
    });
}

async function resolveAniListAnime(input = {}) {
    const anilistId = parsePositiveInt(input?.anilistId, null);
    const malId = parsePositiveInt(input?.malId, null);
    const titles = uniqueStrings(Array.isArray(input?.titles) ? input.titles : []);
    const year = parsePositiveInt(input?.year, null);
    const subtype = String(input?.subtype || '').trim();

    if (anilistId) {
        const direct = await fetchByAniListId(anilistId).catch(() => null);
        if (direct) return direct;
    }

    if (malId) {
        const direct = await fetchByMalId(malId).catch(() => null);
        if (direct) return direct;
    }

    let best = null;
    let bestScore = -Infinity;
    const searchTitles = titles.length ? titles : [input?.title].filter(Boolean);

    for (const title of searchTitles.slice(0, 4)) {
        const results = await searchByTitle(title, year).catch(() => []);
        for (const media of results) {
            const { score, normalized } = scoreAniListCandidate(media, { titles: searchTitles, year, subtype });
            if (score > bestScore) {
                best = normalized;
                bestScore = score;
            }
        }
        if (bestScore >= 110) break;
    }

    return bestScore >= 48 ? best : null;
}

module.exports = {
    resolveAniListAnime
};
