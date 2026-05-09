'use strict';

const { normalizeSearchText } = require('../utils/text');

function dedupeQueries(rawQueries = []) {
    const seen = new Set();
    const deduped = [];
    for (const query of Array.isArray(rawQueries) ? rawQueries : []) {
        const key = normalizeSearchText(query);
        if (!key || seen.has(key)) continue;
        seen.add(key);
        deduped.push(query);
    }
    return deduped;
}

function isSeriesMeta(meta = {}) {
    return Boolean(meta?.isSeries || Number(meta?.season || 0) > 0 || Number(meta?.episode || 0) > 0);
}

function isSeasonPackQuery(query = '', meta = {}) {
    const season = Number(meta?.season || 0);
    if (!season) return false;
    const text = String(query || '');
    const sToken = String(season).padStart(2, '0');
    return new RegExp(`\bS${sToken}\b`, 'i').test(text)
        || new RegExp(`\bS${season}\b`, 'i').test(text)
        || new RegExp(`\b(?:season|stagione)\s*${season}\b`, 'i').test(text)
        || /\b(?:pack|batch|complete|completa)\b/i.test(text);
}

function isExactEpisodeQuery(query = '', meta = {}) {
    const season = Number(meta?.season || 0);
    const episode = Number(meta?.episode || 0);
    if (!season || !episode) return false;
    const text = String(query || '');
    const sToken = String(season).padStart(2, '0');
    const eToken = String(episode).padStart(2, '0');
    return new RegExp(`\bS${sToken}E${eToken}\b`, 'i').test(text)
        || new RegExp(`\b${season}x${eToken}\b`, 'i').test(text)
        || new RegExp(`\b(?:episode|episodio|ep)\s*${episode}\b`, 'i').test(text);
}

function prioritizeSeriesQueries(queries, meta, langMode, limit) {
    const list = dedupeQueries(queries);
    if (!isSeriesMeta(meta)) return list.slice(0, limit);

    const exact = list.filter((query) => isExactEpisodeQuery(query, meta));
    const packs = list.filter((query) => isSeasonPackQuery(query, meta) && !isExactEpisodeQuery(query, meta));
    const titleOnly = list.filter((query) => !exact.includes(query) && !packs.includes(query));

    // Per le serie non basta cercare solo SxxExx: molte release ITA buone sono pack Sxx.
    // Interlacciamo quindi exact episode + season pack, senza aumentare troppo il costo.
    const ordered = [];
    const push = (items, count) => {
        for (const item of items.slice(0, count)) {
            if (!ordered.includes(item)) ordered.push(item);
        }
    };

    push(exact, langMode === 'ita' ? 2 : 3);
    push(packs, langMode === 'ita' ? 2 : 3);
    push(titleOnly, limit);
    push(list, limit);

    return ordered.slice(0, limit);
}

function selectFocusedQueries(queries, meta, langMode) {
    const list = dedupeQueries(queries);
    if (isSeriesMeta(meta)) return prioritizeSeriesQueries(list, meta, langMode, langMode === 'eng' ? 5 : 4);

    if (langMode === 'eng') {
        const noIta = list.filter((q) => !/\b(?:ita|multi)\b/i.test(q));
        const yearQueries = noIta.filter((q) => meta?.year && new RegExp(`\b${meta.year}\b`).test(q));
        const plainQueries = noIta.filter((q) => !/\b(?:19|20)\d{2}\b/.test(q));
        return [...new Set([...yearQueries, ...plainQueries, ...noIta])].slice(0, 4);
    }
    if (langMode === 'all') return list.slice(0, 5);
    return list.slice(0, 3);
}

function selectBroadQueries(queries, langMode, meta = {}) {
    const list = dedupeQueries(queries);
    if (isSeriesMeta(meta)) return prioritizeSeriesQueries(list, meta, langMode, langMode === 'all' ? 8 : 6);
    if (langMode === 'all') return list.slice(0, 8);
    if (langMode === 'eng') return list.slice(0, 6);
    return list.slice(0, 5);
}

function createSearchPlan({ meta, langMode, dbOnlyMode, rawQueries = [] }) {
    const focusedQueries = selectFocusedQueries(rawQueries, meta, langMode);
    const broadQueries = selectBroadQueries(rawQueries, langMode, meta);

    const phases = [{
        key: 'fast',
        kind: 'fast',
        querySubset: [],
        stopOnSatisfied: true
    }];

    if (!dbOnlyMode) {
        phases.push({
            key: 'focused_scrape',
            kind: 'scrape',
            querySubset: focusedQueries,
            stopOnSatisfied: true
        });
        if (broadQueries.length > focusedQueries.length) {
            phases.push({
                key: 'broad_scrape',
                kind: 'scrape',
                querySubset: broadQueries,
                stopOnSatisfied: true
            });
        }
    }

    return {
        phases,
        focusedQueries,
        broadQueries,
        dedupedQueries: dedupeQueries(rawQueries)
    };
}

function evaluatePoolSatisfaction(assessment = {}, meta = {}) {
    const strongCount = Number(assessment.strongCount || 0);
    const exactEpisodeCount = Number(assessment.exactEpisodeCount || 0);
    const seasonPackCount = Number(assessment.seasonPackCount || 0);
    const total = Number(assessment.total || 0);

    if (total <= 0) {
        return { satisfied: false, tier: 'empty', reason: 'no_results' };
    }

    if (meta?.isSeries) {
        if (exactEpisodeCount >= 2) return { satisfied: true, tier: 'excellent', reason: 'exact_episode_depth' };
        if (exactEpisodeCount >= 1 && strongCount >= 1) return { satisfied: true, tier: 'single_exact', reason: 'single_exact_episode' };
        if (exactEpisodeCount >= 1 && total >= 1) return { satisfied: true, tier: 'minimal_exact', reason: 'exact_episode_present' };
        if (seasonPackCount >= 2 && strongCount >= 2) return { satisfied: true, tier: 'pack_backfill', reason: 'pack_depth' };
        if (seasonPackCount >= 1 && strongCount >= 1) return { satisfied: true, tier: 'single_pack', reason: 'single_season_pack' };
        return { satisfied: false, tier: 'weak', reason: 'series_needs_exact_episode' };
    }

    if (strongCount >= 2) return { satisfied: true, tier: 'strong', reason: 'strong_movie_pool' };
    if (strongCount >= 1 && total >= 3) return { satisfied: true, tier: 'ok', reason: 'sufficient_movie_pool' };
    return { satisfied: false, tier: 'weak', reason: 'movie_pool_too_thin' };
}

module.exports = {
    createSearchPlan,
    evaluatePoolSatisfaction,
    dedupeQueries,
    selectFocusedQueries,
    selectBroadQueries,
    prioritizeSeriesQueries
};
