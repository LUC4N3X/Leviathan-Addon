'use strict';

const { resolveLangMode } = require('../canonical/language_rules');

const DEFAULT_YEAR_REGEX = /(19|20)\d{2}/;
const EMPTY_PARSE_OPTIONS = () => ({});
const ALWAYS_FALSE = () => false;
const ALWAYS_TRUE = () => true;

const QUALITY_SIGNAL_REGEX = /\b(?:2160p|4k|uhd|1080p|fhd|720p|web[-.\s]?dl|blu[-.\s]?ray|remux|hevc|x265|x264)\b/i;
const ANIME_PACK_REGEX = /\b(?:batch|pack|complete|collection|全集|合集)\b/i;
const WRONG_SEASON_REGEX = /(?:s|stagione|season)\s*0?(\d+)(?!\d)/gi;
const SERIES_MARKER_REGEX = /\b(?:S\d{2}|SEASON|STAGIONE)\b/i;
const EPISODE_MARKER_REGEX = /\b\d{1,2}x\d{1,2}\b/;
const TITLE_SEPARATOR_REGEX = / - |: /;
const TITLE_CLEANUP_REGEX = /[._\-()[\]]/g;
const ORIGINAL_TITLE_CLEANUP_REGEX = /[._\-:()[\]]/g;
const SPACES_REGEX = /\s{2,}/g;
const LEADING_ARTICLE_REGEX = /^(the|a|an|il|lo|la|i|gli|le)\s+/i;
const REGEX_ESCAPE = /[.*+?^${}()|[\]\\]/g;

function createLanguageFilterTools(deps = {}) {
  const {
    isAnimeMetaContext,
    shouldIgnoreAnimeSeason,
    getEpisodeParseOptions,
    REGEX_YEAR,
    isSeasonPack,
    normalizeSearchText,
    isGoodShortQueryMatch,
    extractSeasonEpisodeFromFilename,
    smartMatch,
    keepItalianCandidate,
    keepEnglishCandidate,
    keepAllCandidate,
    keepLanguageCandidateForMode,
    isConfidentSeasonPackItem,
    passesSeriesEpisodeGuard,
    hasStrongSeriesTitleMatch,
    getExternalDirectUrl
  } = deps;

  const yearRegex = REGEX_YEAR instanceof RegExp ? REGEX_YEAR : DEFAULT_YEAR_REGEX;
  const getParseOptions = typeof getEpisodeParseOptions === 'function' ? getEpisodeParseOptions : EMPTY_PARSE_OPTIONS;
  const isAnimeContext = typeof isAnimeMetaContext === 'function' ? isAnimeMetaContext : ALWAYS_FALSE;
  const ignoreAnimeSeason = typeof shouldIgnoreAnimeSeason === 'function' ? shouldIgnoreAnimeSeason : ALWAYS_FALSE;
  const hasSeriesTitleMatch = typeof hasStrongSeriesTitleMatch === 'function' ? hasStrongSeriesTitleMatch : ALWAYS_TRUE;

  function getPlayableUrl(item) {
    if (typeof getExternalDirectUrl === 'function') return getExternalDirectUrl(item);
    return item?.directUrl || item?._externalDirectUrl || item?.externalDirectUrl || item?.url;
  }

  function cleanTitle(value, cleanupRegex = TITLE_CLEANUP_REGEX) {
    return String(value || '')
      .toLowerCase()
      .replace(cleanupRegex, ' ')
      .replace(SPACES_REGEX, ' ')
      .trim();
  }

  function splitMainTitle(value) {
    return String(value || '').split(TITLE_SEPARATOR_REGEX)[0].toLowerCase().trim();
  }

  function getParsedEpisode(title, meta, type = '') {
    if (!meta?.isSeries || typeof extractSeasonEpisodeFromFilename !== 'function') return null;
    return extractSeasonEpisodeFromFilename(title, meta.season || 1, getParseOptions(meta, type));
  }

  function getIsPack(item, meta, type, title, parsedEpisode) {
    if (typeof isConfidentSeasonPackItem === 'function') {
      return isConfidentSeasonPackItem(item, meta, type);
    }

    return Boolean(
      item?._isPack ||
      (typeof isSeasonPack === 'function' && isSeasonPack(title)) ||
      parsedEpisode?.isRange ||
      parsedEpisode?.isBatch
    );
  }

  function keepCandidateForMode(item, meta = {}, effectiveLangMode = 'ita') {
    if (typeof keepLanguageCandidateForMode === 'function') {
      return keepLanguageCandidateForMode(item, meta, effectiveLangMode);
    }

    const title = String(item?.title || '');
    const source = item?.source;
    const metaTitle = meta?.title;

    if (effectiveLangMode === 'eng') {
      return typeof keepEnglishCandidate === 'function'
        ? keepEnglishCandidate(title, source, metaTitle)
        : true;
    }

    if (effectiveLangMode === 'all') {
      return typeof keepAllCandidate === 'function'
        ? keepAllCandidate(title, source, metaTitle)
        : true;
    }

    return typeof keepItalianCandidate === 'function'
      ? keepItalianCandidate(title, source, metaTitle)
      : true;
  }

  function getEffectiveSearchLanguageMode(filters = {}, meta = {}, type = '') {
    return resolveLangMode({ filters, meta, type, defaultMode: 'ita' });
  }

  function assessFastResultQuality(items, meta, langMode) {
    const list = Array.isArray(items) ? items : [];

    if (list.length === 0) {
      return {
        shouldScrape: true,
        reason: 'no_fast_results',
        strongCount: 0,
        exactEpisodeCount: 0,
        seasonPackCount: 0,
        total: 0
      };
    }

    const effectiveLangMode = resolveLangMode({ language: langMode, defaultMode: 'ita' });

    let strongCount = 0;
    let exactEpisodeCount = 0;
    let seasonPackCount = 0;

    for (const item of list) {
      const title = String(item?.title || '');
      const sizeBytes = Number(item?._size || item?.sizeBytes || 0);
      const seeders = parseInt(item?.seeders, 10) || 0;
      const parsedEpisode = getParsedEpisode(title, meta);
      const isPack = getIsPack(item, meta, '', title, parsedEpisode);
      const langOk = keepCandidateForMode(item, meta, effectiveLangMode);
      const hasQualitySignal = QUALITY_SIGNAL_REGEX.test(title);
      const minSizeMb = meta?.isSeries ? 250 : 700;
      const hasWeight = hasQualitySignal || sizeBytes >= minSizeMb * 1024 * 1024 || seeders > 0;

      let exactEpisode = false;

      if (meta?.isSeries) {
        exactEpisode = Boolean(
          parsedEpisode &&
          !parsedEpisode?.isRange &&
          parsedEpisode.episode === meta.episode &&
          (parsedEpisode.season === meta.season || meta?.kitsu_id)
        );

        if (exactEpisode) exactEpisodeCount += 1;

        const hasSeasonCue = new RegExp(`(?:s|season|stagione)\\s*0?${meta.season}(?!\\d)`, 'i').test(title);
        const isAnimeBatch = Boolean(meta?.kitsu_id && ANIME_PACK_REGEX.test(title));

        if (
          !exactEpisode &&
          isPack &&
          (hasSeasonCue || Boolean(parsedEpisode?.isRange || parsedEpisode?.isBatch) || isAnimeBatch)
        ) {
          seasonPackCount += 1;
        }
      }

      let strength = 0;

      if (langOk) strength += 1;
      if (hasWeight) strength += 1;
      if (!meta?.isSeries || exactEpisode || isPack) strength += 1;
      if (seeders > 0) strength += 1;

      if (strength >= (meta?.isSeries ? 3 : 2)) strongCount += 1;
    }

    const minimumStrong = meta?.isSeries ? 2 : 1;
    const missingEpisodeOrPack = meta?.isSeries && exactEpisodeCount === 0 && seasonPackCount === 0;
    const shouldScrape = strongCount < minimumStrong || missingEpisodeOrPack;

    const reason = shouldScrape
      ? missingEpisodeOrPack
        ? 'no_exact_episode_or_pack'
        : `weak_fast_pool_${strongCount}_of_${minimumStrong}`
      : 'fast_pool_ok';

    return {
      shouldScrape,
      reason,
      strongCount,
      exactEpisodeCount,
      seasonPackCount,
      total: list.length
    };
  }

  function createAggressiveResultFilter(meta, type, langMode) {
    const effectiveLangMode = resolveLangMode({ language: langMode, defaultMode: 'ita' });

    return (item) => {
      const playableUrl = getPlayableUrl(item);
      if (!item?.magnet && !playableUrl) return false;

      const source = String(item.source || '').toLowerCase();
      const title = String(item.title || '');
      const lowerTitle = title.toLowerCase();
      const parsedEpisode = getParsedEpisode(title, meta, type);
      const isPack = getIsPack(item, meta, type, title, parsedEpisode);

      if (source.includes('comet') || source.includes('stremthru')) return false;
      if (!keepCandidateForMode(item, meta, effectiveLangMode)) return false;
      if (!passesMovieYearGuard(title, meta)) return false;

      if (!meta.isSeries && !passesShortMovieQueryGuard(title, meta)) return false;
      if (meta.isSeries) return passesSeriesGuard(item, meta, type, title, lowerTitle, parsedEpisode, isPack);

      return passesMovieTitleGuard(item, meta, title, lowerTitle);
    };
  }

  function passesMovieYearGuard(title, meta) {
    const metaYear = parseInt(meta.year, 10);
    if (Number.isNaN(metaYear)) return true;

    const fileYearMatch = title.match(yearRegex);
    if (!fileYearMatch) return true;

    return Math.abs(parseInt(fileYearMatch[0], 10) - metaYear) <= 1;
  }

  function passesShortMovieQueryGuard(title, meta) {
    const safeNormalizeSearchText = typeof normalizeSearchText === 'function'
      ? normalizeSearchText
      : cleanTitle;

    const shortQueries = [meta.title, meta.originalTitle]
      .filter(Boolean)
      .map(safeNormalizeSearchText)
      .filter((query) => query.length >= 2 && query.length <= 8);

    if (shortQueries.length === 0) return true;
    if (typeof isGoodShortQueryMatch !== 'function') return true;

    return shortQueries.some((query) => isGoodShortQueryMatch(title, query));
  }

  function passesSeriesGuard(item, meta, type, title, lowerTitle, parsedEpisode, isPack) {
    if (typeof passesSeriesEpisodeGuard === 'function' && !passesSeriesEpisodeGuard(item, meta, type)) {
      return false;
    }

    if (!hasSeriesTitleMatch(title, meta)) return false;

    const season = meta.season;
    const episode = meta.episode;
    const animeContext = isAnimeContext(meta, type);
    const ignoreAnimeSeasonCheck = ignoreAnimeSeason(meta, type, title);

    if (
      animeContext &&
      parsedEpisode &&
      !parsedEpisode?.isRange &&
      parsedEpisode.episode === episode &&
      (parsedEpisode.season === season || ignoreAnimeSeasonCheck)
    ) {
      return true;
    }

    if (animeContext && (isPack || parsedEpisode?.isRange || parsedEpisode?.isBatch)) {
      item._isPack = true;
      return true;
    }

    WRONG_SEASON_REGEX.lastIndex = 0;

    let match;
    while ((match = WRONG_SEASON_REGEX.exec(lowerTitle)) !== null) {
      if (parseInt(match[1], 10) !== season && !ignoreAnimeSeasonCheck) return false;
    }

    const xMatch = lowerTitle.match(/(\d+)x(\d+)/i);

    if (xMatch) {
      return (parseInt(xMatch[1], 10) === season || ignoreAnimeSeasonCheck) &&
        parseInt(xMatch[2], 10) === episode;
    }

    const hasRightSeason = new RegExp(`(?:s|stagione|season|^)\\s*0?${season}(?!\\d)`, 'i').test(lowerTitle);
    const hasRightEpisode = new RegExp(`(?:e|x|ep|episode|^)\\s*0?${episode}(?!\\d)`, 'i').test(lowerTitle);

    if (hasRightSeason && hasRightEpisode) return true;

    if (
      hasRightSeason &&
      ((typeof isSeasonPack === 'function' && isSeasonPack(lowerTitle)) || !/(?:e|x|ep|episode)\s*0?\d+/i.test(lowerTitle))
    ) {
      item._isPack = true;
      return true;
    }

    return false;
  }

  function passesMovieTitleGuard(item, meta, title, lowerTitle) {
    if (SERIES_MARKER_REGEX.test(title) || EPISODE_MARKER_REGEX.test(title)) return false;

    const trustedExternalExactId = Boolean(
      item?._externalIdMatched &&
      (item?.isExternal || item?.externalAddon || item?.externalGroup)
    );

    if (trustedExternalExactId) return true;

    const cleanFile = lowerTitle
      .replace(TITLE_CLEANUP_REGEX, ' ')
      .replace(SPACES_REGEX, ' ')
      .trim();

    const candidates = [
      cleanTitle(meta.title),
      splitMainTitle(meta.title),
      cleanTitle(meta.originalTitle, ORIGINAL_TITLE_CLEANUP_REGEX),
      splitMainTitle(meta.originalTitle)
    ];

    if (candidates.some((candidate) => checkMovieTitleMatch(cleanFile, candidate))) return true;

    if (typeof smartMatch === 'function' && smartMatch(meta.title, title, meta.isSeries, meta.season, meta.episode)) {
      return true;
    }

    if (typeof smartMatch === 'function' && smartMatch(meta.originalTitle, title, meta.isSeries, meta.season, meta.episode)) {
      return true;
    }

    return false;
  }

  function checkMovieTitleMatch(cleanFile, candidate) {
    if (!candidate || typeof isGoodShortQueryMatch !== 'function') return false;

    const searchKeyword = candidate.replace(LEADING_ARTICLE_REGEX, '').trim();

    if (searchKeyword === 'rip') {
      return /^(the\s+|il\s+)?rip\b/i.test(cleanFile);
    }

    if (!isGoodShortQueryMatch(cleanFile, searchKeyword)) return false;

    return searchKeyword.length <= 3
      ? new RegExp(`\\b${searchKeyword.replace(REGEX_ESCAPE, '\\$&')}\\b`, 'i').test(cleanFile)
      : cleanFile.includes(searchKeyword);
  }

  return {
    getEffectiveSearchLanguageMode,
    assessFastResultQuality,
    createAggressiveResultFilter
  };
}

module.exports = { createLanguageFilterTools };
