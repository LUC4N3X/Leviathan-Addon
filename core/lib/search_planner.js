'use strict';

const { normalizeSearchText } = require('../utils_text');

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

function selectFocusedQueries(queries, meta, langMode) {
    const list = dedupeQueries(queries);
    if (langMode === 'eng') {
        const noIta = list.filter((q) => !/\b(?:ita|multi)\b/i.test(q));
        const yearQueries = noIta.filter((q) => meta?.year && new RegExp(`\\b${meta.year}\\b`).test(q));
        const plainQueries = noIta.filter((q) => !/\b(?:19|20)\d{2}\b/.test(q));
        return [...new Set([...yearQueries, ...plainQueries, ...noIta])].slice(0, 4);
    }
    if (langMode === 'all') return list.slice(0, 5);
    return list.slice(0, 3);
}

function selectBroadQueries(queries, langMode) {
    const list = dedupeQueries(queries);
    if (langMode === 'all') return list.slice(0, 8);
    if (langMode === 'eng') return list.slice(0, 6);
    return list.slice(0, 5);
}

function createSearchPlan({ meta, langMode, dbOnlyMode, rawQueries = [] }) {
    const focusedQueries = selectFocusedQueries(rawQueries, meta, langMode);
    const broadQueries = selectBroadQueries(rawQueries, langMode);

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
        if (exactEpisodeCount >= 1 && strongCount >= 2) return { satisfied: true, tier: 'strong', reason: 'exact_episode_plus_strength' };
        if (exactEpisodeCount === 0 && seasonPackCount >= 2 && strongCount >= 2) return { satisfied: true, tier: 'pack_backfill' , reason: 'pack_depth' };
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
    selectBroadQueries
};
