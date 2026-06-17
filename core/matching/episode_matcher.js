'use strict';

const {
    normalizeForMatch,
    hasEpisodeMarker,
    hasSeasonOnlyMarker,
    getCandidateValues
} = require('./series_title_matcher');

const STOPWORDS = new Set([
    'the', 'a', 'an', 'and', 'of', 'with', 'on', 'at', 'in', 'for', 'to', 'from', 'by', 'part', 'chapter',
    'vol', 'volume', 'season', 'episode', 'special', 'series', 'complete', 'collection', 'pack', 'boxset', 'box',
    'set', 'remaster', 'remastered', 'bd', 'br', 'web', 'dl', 'webrip', 'bdrip', 'brrip', 'remux', 'dual',
    'audio', 'dub', 'sub', 'multi', 'hevc', 'avc', 'x264', 'x265', 'h264', 'h265', 'aac', 'opus', 'flac',
    'ac3', 'dts', 'hdr', 'sdr', 'bluray', 'amzn', 'nf', 'us', 'uk', 'it', 'proper', 'repack', 'extended', 'directors', 'cut'
]);

function parseSeasonEpisode(raw) {
    if (!raw) return { season: null, episode: null };
    const text = String(raw || '');

    let match = text.match(/\b[sS]\s*(\d{1,2})\s*[._\-\s]*\s*[eE]\s*(\d{1,3})\b/);
    if (match) return { season: parseInt(match[1], 10), episode: parseInt(match[2], 10) };

    match = text.match(/\b(\d{1,2})\s*[xX]\s*(\d{1,3})\b/);
    if (match) return { season: parseInt(match[1], 10), episode: parseInt(match[2], 10) };

    match = text.match(/season\s*(\d{1,2})\D+ep(?:isode)?\.?\s*(\d{1,3})/i)
        || text.match(/stagione\s*(\d{1,2})\D+episodio\.?\s*(\d{1,3})/i);
    if (match) return { season: parseInt(match[1], 10), episode: parseInt(match[2], 10) };

    match = text.match(/\b[eE]p?\.?\s*(\d{1,3})\b/);
    if (match) return { season: null, episode: parseInt(match[1], 10) };

    return { season: null, episode: null };
}

function parseSeriesQuery(query) {
    const raw = String(query || '');
    const titlePart = raw
        .replace(/\bS\d{1,2}E\d{1,3}\b|\b\d{1,2}x\d{1,3}\b|season\s*\d+\D+ep(?:isode)?\.?\s*\d+/ig, '')
        .trim();
    const { season, episode } = parseSeasonEpisode(raw);
    return { title: titlePart, season, episode };
}

function tokenize(value) {
    return normalizeForMatch(value).split(' ').filter(Boolean);
}

function isYearToken(token) {
    return /^\d{4}$/.test(token) && Number(token) >= 1900 && Number(token) <= 2100;
}

function isResolutionToken(token) {
    return /^(480p|720p|1080p|2160p|4k|uhd|hdr)$/.test(token);
}

function isSeasonEpisodeToken(token) {
    return /^[sS]\d{1,2}[eE]\d{1,3}$/.test(token) || /^[sS]\d{1,2}$/.test(token) || /^\d{1,2}x\d{1,3}$/.test(token);
}

function coreTitleTokens(value) {
    const tokens = tokenize(value);
    const core = [];
    for (const token of tokens) {
        if (isYearToken(token) || isResolutionToken(token) || isSeasonEpisodeToken(token)) break;
        core.push(token);
    }
    return core.length ? core : tokens;
}

function uniqueStrings(values = []) {
    const out = [];
    const seen = new Set();
    for (const value of values.flat(Infinity)) {
        const text = String(value || '').trim();
        if (!text) continue;
        const key = normalizeForMatch(text);
        if (!key || seen.has(key)) continue;
        seen.add(key);
        out.push(text);
    }
    return out;
}

function buildSeriesContext({ search, cinemetaTitle = null, aliases = [], season = null, episode = null } = {}) {
    const parsed = parseSeriesQuery(search || '');
    const resolvedSeason = Number.isFinite(Number(season)) && Number(season) > 0 ? Number(season) : parsed.season;
    const resolvedEpisode = Number.isFinite(Number(episode)) && Number(episode) > 0 ? Number(episode) : parsed.episode;
    const titles = uniqueStrings([cinemetaTitle || parsed.title || '', aliases]);
    const primaryTitle = titles[0] || '';

    return {
        title: primaryTitle,
        normTitle: normalizeForMatch(primaryTitle),
        titles,
        season: resolvedSeason,
        episode: resolvedEpisode,
        queryTokensByTitle: titles.map((title) => tokenize(title)).filter((tokens) => tokens.length > 0)
    };
}

function hasWrongExplicitEpisodeMarker(raw, ctx) {
    if (!raw || !ctx || !Number.isFinite(Number(ctx.episode))) return false;
    const text = String(raw || '');
    const season = Number(ctx.season || 0) || 1;
    const episode = Number(ctx.episode);

    const markers = [];
    let match;
    const patterns = [
        /\b[sS]\s*(\d{1,2})\s*[._\-\s]*\s*[eE]\s*(\d{1,3})\b/g,
        /\b(\d{1,2})\s*[xX]\s*(\d{1,3})\b/g,
        /season\s*(\d{1,2})\D+ep(?:isode)?\.?\s*(\d{1,3})/ig,
        /stagione\s*(\d{1,2})\D+episodio\.?\s*(\d{1,3})/ig
    ];
    for (const rx of patterns) {
        while ((match = rx.exec(text)) !== null) markers.push({ season: Number(match[1]), episode: Number(match[2]) });
    }

    const targetSeason = Number(ctx.season || season);
    return markers.some((marker) => marker.season === targetSeason && marker.episode !== episode);
}

function matchesTokenCoverage(candidateText, ctx) {
    const candidateCore = coreTitleTokens(candidateText);
    if (!candidateCore.length) return true;

    const tokenSets = ctx.queryTokensByTitle && ctx.queryTokensByTitle.length > 0
        ? ctx.queryTokensByTitle
        : [tokenize(ctx.title)];

    for (const queryTokens of tokenSets) {
        if (queryTokens.length === 0) return true;
        let i = 0;
        let j = 0;
        let matched = 0;
        while (i < candidateCore.length && j < queryTokens.length) {
            if (candidateCore[i] === queryTokens[j]) {
                matched += 1;
                i += 1;
                j += 1;
            } else {
                i += 1;
            }
        }

        const coverage = matched / queryTokens.length;
        if ((queryTokens.length <= 3 && coverage < 1) || (queryTokens.length > 3 && coverage < 0.8)) continue;

        const queryTokenSet = new Set(queryTokens);
        const nonStopwordExtras = candidateCore.filter((token) => !queryTokenSet.has(token) && !STOPWORDS.has(token));
        if (queryTokens.length <= 2 && nonStopwordExtras.length > 0) continue;
        if (queryTokens.length <= 3 && nonStopwordExtras.length > 2) continue;
        if (nonStopwordExtras.length <= 8) return true;
    }

    return false;
}

function matchesCandidateTitle(candidate, ctx, opts = {}) {
    if (!candidate || !ctx) return true;
    const values = getCandidateValues(candidate);
    if (values.length === 0) return true;

    const requireEpisode = Number.isFinite(Number(ctx.season)) && Number.isFinite(Number(ctx.episode));
    const allowSeasonPack = opts.allowSeasonPack !== false;

    for (const raw of values) {
        if (!raw) continue;
        const normalized = normalizeForMatch(raw);

        if (requireEpisode) {
            if (hasWrongExplicitEpisodeMarker(raw, ctx)) continue;
            const episodeOk = hasEpisodeMarker(raw, ctx.season, ctx.episode)
                || (allowSeasonPack && hasSeasonOnlyMarker(raw, ctx.season));
            if (!episodeOk) continue;
        }

        if (matchesTokenCoverage(normalized, ctx)) return true;
    }

    return false;
}

module.exports = {
    parseSeasonEpisode,
    parseSeriesQuery,
    buildSeriesContext,
    matchesCandidateTitle,
    hasWrongExplicitEpisodeMarker,
    coreTitleTokens,
    tokenize
};
