'use strict';

function createProviderFetchTools(deps = {}) {
  const {
    logger,
    CONFIG,
    Cache,
    LIMITERS,
    withTimeout,
    buildTitleSearchPipelineKey,
    getTimedCacheValue,
    setTimedCacheValue,
    titleSearchHotCache,
    titleSearchInflight,
    TITLE_SEARCH_HOT_TTL_MS,
    scheduleKeyed,
    createSearchPlan,
    evaluatePoolSatisfaction,
    sourceHealth,
    SCRAPER_MODULES,
    queryRemoteIndexer,
    fetchExternalResults,
    normalizeCandidateResults,
    applyConfiguredTorrentFilters,
    assessFastResultQuality,
    getTmdbAltTitles,
    generateSmartQueries,
    incrementMetric,
    guardedProviderCall,
    isAnimeMetaContext,
    buildExternalAddonRequestId
  } = deps;

  async function fetchTitleCandidatePool({ type, finalId, tmdbIdLookup, meta, config, dbOnlyMode, langMode, aggressiveFilter, userTmdbKey, seedResults = [] }) {
    const titleKey = buildTitleSearchPipelineKey(meta, type, langMode, dbOnlyMode, config?.filters || {});
    const hotCached = getTimedCacheValue(titleSearchHotCache, titleKey);
    if (hotCached) {
      logger.info(`[TITLE-QUEUE] Hot cache hit | key=${titleKey} | results=${hotCached.length}`);
      return hotCached;
    }

    return deps.withSharedPromise(titleSearchInflight, `title_search:${titleKey}`, async () => {
      const cachedAgain = getTimedCacheValue(titleSearchHotCache, titleKey);
      if (cachedAgain) return cachedAgain;

      return scheduleKeyed('title-search', titleKey, async () => {
        let dynamicTitles = [];
        try {
          if (tmdbIdLookup) dynamicTitles = await getTmdbAltTitles(tmdbIdLookup, type, userTmdbKey);
        } catch (_) {}

        const allowEngScraper = langMode === 'all' || langMode === 'eng';
        const rawQueries = generateSmartQueries({ ...meta, langMode }, dynamicTitles, langMode);
        const plan = createSearchPlan({ meta, langMode, dbOnlyMode, rawQueries });
        const scraperTimeout = langMode === 'eng'
          ? Math.max(CONFIG.TIMEOUTS.SCRAPER || 4000, 12000)
          : langMode === 'all'
            ? Math.max(CONFIG.TIMEOUTS.SCRAPER || 4000, 10000)
            : (CONFIG.TIMEOUTS.SCRAPER || 4000);
        const providerCacheOptions = {
          emptyTtl: 3600,
          errorTtl: 300
        };

        let cleanResults = [];
        let assessmentPool = Array.isArray(seedResults) ? [...seedResults] : [];
        let lastAssessment = { shouldScrape: true, reason: 'init', strongCount: 0, exactEpisodeCount: 0, seasonPackCount: 0, total: assessmentPool.length };

        for (const phase of plan.phases) {
          incrementMetric(`search.phase.${phase.key}.calls`);

          if (phase.kind === 'fast') {
            const remotePromise = Cache.fetchWithCache('RemoteIndexer', `${type}:${tmdbIdLookup || finalId}:${meta.season}:${meta.episode}`, 43200, () =>
              guardedProviderCall(
                'RemoteIndexer',
                LIMITERS.remoteIndexer,
                CONFIG.TIMEOUTS.REMOTE_INDEXER,
                () => queryRemoteIndexer(tmdbIdLookup, type, meta.season, meta.episode, config, meta),
                { meta }
              )
            , providerCacheOptions);

            const externalRequestId = buildExternalAddonRequestId(type, finalId, meta);
            const externalCacheKey = `${type}:${externalRequestId}:${langMode}`;
            const externalPromise = dbOnlyMode
              ? Promise.resolve([])
              : Cache.fetchWithCache('ExternalAddons', externalCacheKey, 43200, () =>
                guardedProviderCall(
                  'ExternalAddons',
                  LIMITERS.externalAddons,
                  CONFIG.TIMEOUTS.EXTERNAL,
                  () => fetchExternalResults(type, externalRequestId, config, meta, langMode),
                  { meta }
                )
              , providerCacheOptions);

            const [remoteSettled, externalSettled] = await Promise.allSettled([remotePromise, externalPromise]);
            const remoteResults = remoteSettled.status === 'fulfilled' ? remoteSettled.value : [];
            const externalResults = externalSettled.status === 'fulfilled' ? externalSettled.value : [];
            logger.info(`[STATS] Remote: ${remoteResults.length} | External: ${externalResults.length}`);

            cleanResults = await normalizeCandidateResults([...cleanResults, ...remoteResults, ...externalResults].filter(aggressiveFilter));
            cleanResults = applyConfiguredTorrentFilters(cleanResults, config.filters || {});
          } else if (phase.kind === 'scrape' && phase.querySubset.length > 0 && !dbOnlyMode) {
            logger.info(`[SCRAPER PLAN] phase=${phase.key} lang=${langMode} queries=${phase.querySubset.length} timeout=${scraperTimeout}ms | titleKey=${titleKey}`);
            const scraperNames = sourceHealth.sortNamesByPriority(SCRAPER_MODULES.map((scraper) => scraper?.name || 'ScraperModule'));
            const sortedScrapers = [...SCRAPER_MODULES].sort((a, b) => {
              const aIdx = scraperNames.indexOf(a?.name || 'ScraperModule');
              const bIdx = scraperNames.indexOf(b?.name || 'ScraperModule');
              return (aIdx === -1 ? 999 : aIdx) - (bIdx === -1 ? 999 : bIdx);
            });

            const allScraperTasks = [];
            phase.querySubset.forEach((query) => sortedScrapers.forEach((scraper) => {
              if (!scraper.searchMagnet) return;
              const providerName = scraper.name || 'ScraperModule';
              allScraperTasks.push(
                guardedProviderCall(
                  providerName,
                  LIMITERS.scraper,
                  scraperTimeout,
                  () => scraper.searchMagnet(query, meta.year, type, buildExternalAddonRequestId(type, finalId, meta), { langMode, allowEng: allowEngScraper, isAnime: isAnimeMetaContext(meta, type) }),
                  { meta }
                )
              );
            }));

            const scrapedResultsRaw = (await Promise.allSettled(allScraperTasks))
              .flatMap((result) => result.status === 'fulfilled' ? result.value : []);
            cleanResults = await normalizeCandidateResults([...cleanResults, ...scrapedResultsRaw.filter(aggressiveFilter)]);
            cleanResults = applyConfiguredTorrentFilters(cleanResults, config.filters || {});
            logger.info(`[STATS SCRAPER] phase=${phase.key} total=${cleanResults.length} added=${scrapedResultsRaw.length}`);
          }

          assessmentPool = await normalizeCandidateResults([...seedResults, ...cleanResults].filter(aggressiveFilter));
          assessmentPool = applyConfiguredTorrentFilters(assessmentPool, config.filters || {});
          lastAssessment = assessFastResultQuality(assessmentPool, meta, langMode, config);
          const satisfaction = evaluatePoolSatisfaction(lastAssessment, meta);
          incrementMetric(`search.phase.${phase.key}.results`, cleanResults.length);
          logger.info(`[SEARCH PLAN] phase=${phase.key} total=${lastAssessment.total} strong=${lastAssessment.strongCount} exact=${lastAssessment.exactEpisodeCount} pack=${lastAssessment.seasonPackCount} satisfied=${satisfaction.satisfied} reason=${satisfaction.reason}`);

          if (phase.stopOnSatisfied && satisfaction.satisfied) {
            incrementMetric(`search.phase.${phase.key}.stopped`);
            break;
          }
        }

        if (!dbOnlyMode && lastAssessment.shouldScrape && cleanResults.length === 0 && plan.broadQueries.length === 0) {
          logger.info(`[SEARCH PLAN] exhausted with no results | reason=${lastAssessment.reason}`);
        }

        return setTimedCacheValue(titleSearchHotCache, titleKey, cleanResults, TITLE_SEARCH_HOT_TTL_MS);
      });
    });
  }

  return {
    fetchTitleCandidatePool
  };
}

module.exports = { createProviderFetchTools };
