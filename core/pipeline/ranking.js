'use strict';

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
    let rankedList = rankAndFilterResults(cleanResults, meta, config);
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
