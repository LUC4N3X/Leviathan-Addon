'use strict';

const { resolveLangMode } = require('../canonical/language_rules');

function createLanguageFilterTools(deps = {}) {
  const {
    isAnimeMetaContext,
    shouldIgnoreAnimeSeason,
    getEpisodeParseOptions,
    logger,
    REGEX_SUB_ONLY,
    REGEX_AUDIO_CONFIRM,
    REGEX_YEAR,
    isSeasonPack,
    normalizeSearchText,
    isGoodShortQueryMatch,
    extractSeasonEpisodeFromFilename,
    smartMatch,
    keepItalianCandidate,
    keepEnglishCandidate,
    keepAllCandidate,
    hasStrongSeriesTitleMatch
  } = deps;

  function getEffectiveSearchLanguageMode(filters = {}, meta = {}, type = '') {
    return resolveLangMode({ filters, meta, type, defaultMode: 'ita' });
  }

  function assessFastResultQuality(items, meta, langMode) {
    const list = Array.isArray(items) ? items : [];
    if (list.length === 0) {
      return { shouldScrape: true, reason: 'no_fast_results', strongCount: 0, exactEpisodeCount: 0, seasonPackCount: 0, total: 0 };
    }

    const effectiveLangMode = resolveLangMode({ language: langMode, defaultMode: 'ita' });
    let strongCount = 0;
    let exactEpisodeCount = 0;
    let seasonPackCount = 0;

    for (const item of list) {
      const title = String(item?.title || '');
      const source = String(item?.source || '');
      const sizeBytes = Number(item?._size || item?.sizeBytes || 0);
      const seeders = parseInt(item?.seeders, 10) || 0;
      const parsedFastEpisode = meta?.isSeries ? extractSeasonEpisodeFromFilename(title, meta.season || 1, getEpisodeParseOptions(meta)) : null;
      const isPack = Boolean(item?._isPack || isSeasonPack(title) || parsedFastEpisode?.isRange || parsedFastEpisode?.isBatch);
      const langOk = effectiveLangMode === 'eng'
        ? keepEnglishCandidate(title, source, meta?.title)
        : effectiveLangMode === 'all'
          ? keepAllCandidate(title, source, meta?.title)
          : keepItalianCandidate(title, source, meta?.title);
      const hasQualitySignal = /\b(?:2160p|4k|uhd|1080p|fhd|720p|web[-.\s]?dl|blu[-.\s]?ray|remux|hevc|x265|x264)\b/i.test(title);
      const hasWeight = hasQualitySignal || sizeBytes >= (meta?.isSeries ? 250 : 700) * 1024 * 1024 || seeders > 0;

      let exactEpisode = false;
      if (meta?.isSeries) {
        const parsed = parsedFastEpisode;
        exactEpisode = Boolean(parsed && !parsed?.isRange && parsed.episode === meta.episode && (parsed.season === meta.season || meta?.kitsu_id));
        if (exactEpisode) exactEpisodeCount += 1;
        const hasSeasonCue = new RegExp(`(?:s|season|stagione)\\s*0?${meta.season}(?!\\d)`, 'i').test(title);
        if (!exactEpisode && isPack && (hasSeasonCue || Boolean(parsed?.isRange || parsed?.isBatch) || (meta?.kitsu_id && /\b(?:batch|pack|complete|collection|全集|合集)\b/i.test(title)))) seasonPackCount += 1;
      }

      let strength = 0;
      if (langOk) strength += 1;
      if (hasWeight) strength += 1;
      if (!meta?.isSeries || exactEpisode || isPack) strength += 1;
      if (seeders > 0) strength += 1;
      if (strength >= (meta?.isSeries ? 3 : 2)) strongCount += 1;
    }

    const minimumStrong = meta?.isSeries ? 2 : 1;
    const shouldScrape = strongCount < minimumStrong || (meta?.isSeries && exactEpisodeCount === 0 && seasonPackCount === 0);
    const reason = shouldScrape
      ? (list.length === 0
        ? 'no_fast_results'
        : (meta?.isSeries && exactEpisodeCount === 0 && seasonPackCount === 0)
          ? 'no_exact_episode_or_pack'
          : `weak_fast_pool_${strongCount}_of_${minimumStrong}`)
      : 'fast_pool_ok';

    return { shouldScrape, reason, strongCount, exactEpisodeCount, seasonPackCount, total: list.length };
  }

  function createAggressiveResultFilter(meta, type, langMode) {
    const effectiveLangMode = resolveLangMode({ language: langMode, defaultMode: 'ita' });
    return (item) => {
      if (!item?.magnet && !item?.directUrl && !item?._externalDirectUrl && !item?.externalDirectUrl && !item?.url) return false;

      const source = String(item.source || '').toLowerCase();
      const title = String(item.title || '');
      const lowerTitle = title.toLowerCase();
      const parsedFastEpisode = meta?.isSeries ? extractSeasonEpisodeFromFilename(title, meta.season || 1, getEpisodeParseOptions(meta)) : null;
      const isPack = Boolean(item?._isPack || isSeasonPack(title) || parsedFastEpisode?.isRange || parsedFastEpisode?.isBatch);

      if (source.includes('comet') || source.includes('stremthru')) return false;

      if (effectiveLangMode === 'ita') {
        if (!keepItalianCandidate(title, item.source, meta.title)) return false;
      } else if (effectiveLangMode === 'eng') {
        if (!keepEnglishCandidate(title, item.source, meta.title)) return false;
      } else if (!keepAllCandidate(title, item.source, meta.title)) {
        return false;
      }

      const metaYear = parseInt(meta.year, 10);
      if (!Number.isNaN(metaYear)) {
        const fileYearMatch = title.match(REGEX_YEAR);
        if (fileYearMatch && Math.abs(parseInt(fileYearMatch[0], 10) - metaYear) > 1) return false;
      }

      if (!meta.isSeries) {
        const shortQueries = [meta.title, meta.originalTitle]
          .filter(Boolean)
          .map(normalizeSearchText)
          .filter((query) => query.length >= 2 && query.length <= 8);
        if (shortQueries.length > 0 && !shortQueries.some((query) => isGoodShortQueryMatch(title, query))) return false;
      }

      if (meta.isSeries) {
        if (!hasStrongSeriesTitleMatch(title, meta)) return false;

        const season = meta.season;
        const episode = meta.episode;
        const parsedEpisode = extractSeasonEpisodeFromFilename(title, season || 1, getEpisodeParseOptions(meta, type));

        if (isAnimeMetaContext(meta, type) && parsedEpisode && !parsedEpisode?.isRange && parsedEpisode.episode === episode && (parsedEpisode.season === season || shouldIgnoreAnimeSeason(meta, type, title))) {
          return true;
        }
        if (isAnimeMetaContext(meta, type) && (isPack || parsedEpisode?.isRange || parsedEpisode?.isBatch)) {
          item._isPack = true;
          return true;
        }

        const wrongSeasonRegex = /(?:s|stagione|season)\s*0?(\d+)(?!\d)/gi;
        let match;
        const ignoreAnimeSeasonCheck = shouldIgnoreAnimeSeason(meta, type, title);
        while ((match = wrongSeasonRegex.exec(lowerTitle)) !== null) {
          if (parseInt(match[1], 10) !== season && !ignoreAnimeSeasonCheck) return false;
        }

        const xMatch = lowerTitle.match(/(\d+)x(\d+)/i);
        if (xMatch) return (parseInt(xMatch[1], 10) === season || ignoreAnimeSeasonCheck) && parseInt(xMatch[2], 10) === episode;

        const hasRightSeason = new RegExp(`(?:s|stagione|season|^)\\s*0?${season}(?!\\d)`, 'i').test(lowerTitle);
        const hasRightEpisode = new RegExp(`(?:e|x|ep|episode|^)\\s*0?${episode}(?!\\d)`, 'i').test(lowerTitle);

        if (hasRightSeason && hasRightEpisode) return true;
        if (hasRightSeason && (isSeasonPack(lowerTitle) || !/(?:e|x|ep|episode)\s*0?\d+/i.test(lowerTitle))) {
          item._isPack = true;
          return true;
        }
        return false;
      }

      if (/\b(?:S\d{2}|SEASON|STAGIONE)\b/i.test(title) || /\b\d{1,2}x\d{1,2}\b/.test(title)) return false;

      const cleanFile = lowerTitle.replace(/[\._\-\(\)\[\]]/g, ' ').replace(/\s{2,}/g, ' ').trim();
      const checkMatch = (strToCheck) => {
        if (!strToCheck) return false;
        const searchKeyword = strToCheck.replace(/^(the|a|an|il|lo|la|i|gli|le)\s+/i, '').trim();
        if (searchKeyword === 'rip') return /^(the\s+|il\s+)?rip\b/i.test(cleanFile);
        if (!isGoodShortQueryMatch(cleanFile, searchKeyword)) return false;
        return searchKeyword.length <= 3
          ? new RegExp(`\\b${searchKeyword.replace(/[.*+?^${}()|[\\]\\]/g, '\\$&')}\\b`, 'i').test(cleanFile)
          : cleanFile.includes(searchKeyword);
      };

      if (checkMatch(String(meta.title || '').toLowerCase().replace(/[\._\-\(\)\[\]]/g, ' ').replace(/\s{2,}/g, ' ').trim())) return true;
      if (checkMatch(String(meta.title || '').split(/ - |: /)[0].toLowerCase().trim())) return true;
      if (checkMatch(String(meta.originalTitle || '').toLowerCase().trim())) return true;
      if (smartMatch(meta.title, title, meta.isSeries, meta.season, meta.episode)) return true;

      return false;
    };
  }

  return {
    getEffectiveSearchLanguageMode,
    assessFastResultQuality,
    createAggressiveResultFilter
  };
}

module.exports = { createLanguageFilterTools };
