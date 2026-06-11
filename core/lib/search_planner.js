'use strict';

const { normalizeSearchText } = require('../utils/text');

const DEFAULT_FAST_PHASE = Object.freeze({
  key: 'fast',
  kind: 'fast',
  querySubset: [],
  stopOnSatisfied: true
});

function safeNumber(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function normalizeLangMode(value) {
  const mode = String(value || 'ita').trim().toLowerCase();
  if (mode === 'eng' || mode === 'all' || mode === 'ita') return mode;
  return 'ita';
}

function normalizeLimit(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Math.max(1, Number.isFinite(parsed) ? parsed : fallback);
}

function normalizeQuery(value) {
  return String(value || '').trim();
}

function uniquePush(target, item) {
  if (!item || target.includes(item)) return false;
  target.push(item);
  return true;
}

function dedupeQueries(rawQueries = []) {
  const seen = new Set();
  const deduped = [];

  for (const query of Array.isArray(rawQueries) ? rawQueries : []) {
    const cleanQuery = normalizeQuery(query);
    if (!cleanQuery) continue;

    const key = normalizeSearchText(cleanQuery);
    if (!key || seen.has(key)) continue;

    seen.add(key);
    deduped.push(cleanQuery);
  }

  return deduped;
}

function isSeriesMeta(meta = {}) {
  return Boolean(
    meta?.isSeries ||
    safeNumber(meta?.season, 0) > 0 ||
    safeNumber(meta?.episode, 0) > 0
  );
}

function getSeasonEpisode(meta = {}) {
  return {
    season: safeNumber(meta?.season, 0),
    episode: safeNumber(meta?.episode, 0)
  };
}

function isSeasonPackQuery(query = '', meta = {}) {
  const { season } = getSeasonEpisode(meta);
  if (!season) return false;

  const text = normalizeQuery(query);
  if (!text) return false;

  const sToken = String(season).padStart(2, '0');

  return new RegExp(`\\bS${sToken}\\b`, 'i').test(text)
    || new RegExp(`\\bS${season}\\b`, 'i').test(text)
    || new RegExp(`\\b(?:season|stagione)\\s*0?${season}\\b`, 'i').test(text)
    || /\b(?:pack|batch|complete|completa)\b/i.test(text);
}

function isExactEpisodeQuery(query = '', meta = {}) {
  const { season, episode } = getSeasonEpisode(meta);
  if (!season || !episode) return false;

  const text = normalizeQuery(query);
  if (!text) return false;

  const sToken = String(season).padStart(2, '0');
  const eToken = String(episode).padStart(2, '0');

  return new RegExp(`\\bS${sToken}E${eToken}\\b`, 'i').test(text)
    || new RegExp(`\\bS${season}E${eToken}\\b`, 'i').test(text)
    || new RegExp(`\\bS${sToken}\\s*E${episode}\\b`, 'i').test(text)
    || new RegExp(`\\b${season}x${eToken}\\b`, 'i').test(text)
    || new RegExp(`\\b${season}x${episode}\\b`, 'i').test(text)
    || new RegExp(`\\b(?:episode|episodio|ep)\\s*0?${episode}\\b`, 'i').test(text);
}

function splitSeriesQueries(queries = [], meta = {}) {
  const exact = [];
  const packs = [];
  const titleOnly = [];

  for (const query of queries) {
    if (isExactEpisodeQuery(query, meta)) {
      exact.push(query);
    } else if (isSeasonPackQuery(query, meta)) {
      packs.push(query);
    } else {
      titleOnly.push(query);
    }
  }

  return { exact, packs, titleOnly };
}

function prioritizeSeriesQueries(queries, meta, langMode, limit) {
  const list = dedupeQueries(queries);
  const safeLangMode = normalizeLangMode(langMode);
  const safeLimit = normalizeLimit(limit, safeLangMode === 'eng' ? 5 : 4);

  if (!isSeriesMeta(meta)) return list.slice(0, safeLimit);

  const { exact, packs, titleOnly } = splitSeriesQueries(list, meta);
  const ordered = [];
  const exactBudget = safeLangMode === 'ita' ? 2 : 3;
  const packBudget = safeLangMode === 'ita' ? 2 : 3;

  for (const query of exact.slice(0, exactBudget)) uniquePush(ordered, query);
  for (const query of packs.slice(0, packBudget)) uniquePush(ordered, query);
  for (const query of titleOnly) uniquePush(ordered, query);
  for (const query of list) uniquePush(ordered, query);

  return ordered.slice(0, safeLimit);
}

function selectFocusedQueries(queries, meta, langMode) {
  const list = dedupeQueries(queries);
  const safeLangMode = normalizeLangMode(langMode);

  if (isSeriesMeta(meta)) {
    return prioritizeSeriesQueries(list, meta, safeLangMode, safeLangMode === 'eng' ? 5 : 4);
  }

  if (safeLangMode === 'eng') {
    const noIta = list.filter((query) => !/\b(?:ita|multi)\b/i.test(query));
    const year = safeNumber(meta?.year, 0);
    const yearQueries = year > 0
      ? noIta.filter((query) => new RegExp(`\\b${year}\\b`).test(query))
      : [];
    const plainQueries = noIta.filter((query) => !/\b(?:19|20)\d{2}\b/.test(query));

    return dedupeQueries([...yearQueries, ...plainQueries, ...noIta]).slice(0, 4);
  }

  if (safeLangMode === 'all') {
    return list.slice(0, 5);
  }

  return list.slice(0, 3);
}

function selectBroadQueries(queries, langMode, meta = {}) {
  const list = dedupeQueries(queries);
  const safeLangMode = normalizeLangMode(langMode);

  if (isSeriesMeta(meta)) {
    return prioritizeSeriesQueries(list, meta, safeLangMode, safeLangMode === 'all' ? 8 : 6);
  }

  if (safeLangMode === 'all') return list.slice(0, 8);
  if (safeLangMode === 'eng') return list.slice(0, 6);

  return list.slice(0, 5);
}

function createScrapePhase(key, querySubset) {
  return {
    key,
    kind: 'scrape',
    querySubset,
    stopOnSatisfied: true
  };
}

function createSearchPlan({ meta = {}, langMode = 'ita', dbOnlyMode = false, rawQueries = [] } = {}) {
  const safeLangMode = normalizeLangMode(langMode);
  const dedupedQueries = dedupeQueries(rawQueries);
  const focusedQueries = selectFocusedQueries(dedupedQueries, meta, safeLangMode);
  const broadQueries = selectBroadQueries(dedupedQueries, safeLangMode, meta);
  const phases = [{ ...DEFAULT_FAST_PHASE }];

  if (!dbOnlyMode) {
    phases.push(createScrapePhase('focused_scrape', focusedQueries));

    if (broadQueries.length > focusedQueries.length) {
      phases.push(createScrapePhase('broad_scrape', broadQueries));
    }
  }

  return {
    phases,
    focusedQueries,
    broadQueries,
    dedupedQueries
  };
}

function evaluateSeriesSatisfaction({ strongCount, exactEpisodeCount, seasonPackCount, total }) {
  if (exactEpisodeCount >= 2) {
    return { satisfied: true, tier: 'excellent', reason: 'exact_episode_depth' };
  }

  if (exactEpisodeCount >= 1 && strongCount >= 1) {
    return { satisfied: true, tier: 'single_exact', reason: 'single_exact_episode' };
  }

  if (exactEpisodeCount >= 1 && total >= 1) {
    return { satisfied: true, tier: 'minimal_exact', reason: 'exact_episode_present' };
  }

  if (seasonPackCount >= 2 && strongCount >= 2) {
    return { satisfied: true, tier: 'pack_backfill', reason: 'pack_depth' };
  }

  if (seasonPackCount >= 1 && strongCount >= 1) {
    return { satisfied: true, tier: 'single_pack', reason: 'single_season_pack' };
  }

  return { satisfied: false, tier: 'weak', reason: 'series_needs_exact_episode' };
}

function evaluateMovieSatisfaction({ strongCount, total }) {
  if (strongCount >= 2) {
    return { satisfied: true, tier: 'strong', reason: 'strong_movie_pool' };
  }

  if (strongCount >= 1 && total >= 3) {
    return { satisfied: true, tier: 'ok', reason: 'sufficient_movie_pool' };
  }

  return { satisfied: false, tier: 'weak', reason: 'movie_pool_too_thin' };
}

function evaluatePoolSatisfaction(assessment = {}, meta = {}) {
  const strongCount = safeNumber(assessment.strongCount, 0);
  const exactEpisodeCount = safeNumber(assessment.exactEpisodeCount, 0);
  const seasonPackCount = safeNumber(assessment.seasonPackCount, 0);
  const total = safeNumber(assessment.total, 0);

  if (total <= 0) {
    return { satisfied: false, tier: 'empty', reason: 'no_results' };
  }

  if (isSeriesMeta(meta)) {
    return evaluateSeriesSatisfaction({
      strongCount,
      exactEpisodeCount,
      seasonPackCount,
      total
    });
  }

  return evaluateMovieSatisfaction({
    strongCount,
    total
  });
}

module.exports = {
  createSearchPlan,
  evaluatePoolSatisfaction,
  dedupeQueries,
  selectFocusedQueries,
  selectBroadQueries,
  prioritizeSeriesQueries
};
