'use strict';

const { applySeedHealthRanking, getSeedHealthLogSamples } = require('../lib/seed_health_ranker');

function createRankingTools(deps = {}) {
  const {
    logger,
    rankAndFilterResults,
    filterByQualityLimit,
    applyPackKnowledge,
    rerankCompositeResults,
    applyPremiumRankingPolicy,
    reprioritizeRdRankedList,
    resolveTorboxRankedList
  } = deps;

  async function rankResults(cleanResults, meta, config, hasDebridKey, configuredDebridService, debridApiKey) {
    const seedHealthPass = applySeedHealthRanking(cleanResults);
    for (const line of getSeedHealthLogSamples(cleanResults, 3)) logger?.info?.(line);
    logger?.info?.(`[RANK] seedHealth summary healthy=${seedHealthPass.stats.healthy} weak=${seedHealthPass.stats.weak} dead=${seedHealthPass.stats.dead} unknown=${seedHealthPass.stats.unknown} protected=${seedHealthPass.stats.protected} kept=${seedHealthPass.stats.kept}/${seedHealthPass.stats.total} strict=${seedHealthPass.stats.strict} dropped=${seedHealthPass.stats.dropped}`);

    let rankedList = rankAndFilterResults(seedHealthPass.results, meta, config);
    const sortMode = config.sort || config.filters?.sort || 'balanced';
    rankedList = rerankCompositeResults(rankedList, meta, config, sortMode);
    rankedList = applyPremiumRankingPolicy(rankedList, meta, config);

    if (config.filters?.maxPerQuality) rankedList = filterByQualityLimit(rankedList, config.filters.maxPerQuality);

    rankedList = await reprioritizeRdRankedList(rankedList, meta, config, hasDebridKey);
    rankedList = applyPremiumRankingPolicy(rankedList, meta, config);

    if (configuredDebridService === 'tb' && hasDebridKey) {
      rankedList = await resolveTorboxRankedList(rankedList, debridApiKey);
    }

    logger.info(`[RANK] Final ranked list: ${rankedList.length}`);
    return rankedList;
  }

  return {
    applyPackKnowledge,
    rankResults
  };
}

module.exports = { createRankingTools };
