'use strict';

function createCachingPersistenceTools(deps = {}) {
  const {
    saveResultsToDbBackground,
    buildClientCacheMetadata,
    buildSharedStreamCachePolicy,
    buildSharedReadContext,
    shouldUseSharedStreamEntry,
    Cache,
    incrementMetric
  } = deps;

  async function persistResults(meta, cleanResults, config) {
    return saveResultsToDbBackground(meta, cleanResults, config);
  }

  async function getSharedCachedResult(cacheKey, meta, evaluatorOptions = { allowStale: false }) {
    const sharedReadContext = buildSharedReadContext(meta);
    const result = evaluatorOptions.allowStale
      ? await Cache.getStaleStream(cacheKey, {
        allowLocal: false,
        allowShared: true,
        sharedEntryEvaluator: (row) => shouldUseSharedStreamEntry(row, sharedReadContext, { allowStale: true })
      })
      : await Cache.getCachedStream(cacheKey, {
        allowLocal: false,
        allowShared: true,
        sharedEntryEvaluator: (row) => shouldUseSharedStreamEntry(row, sharedReadContext, { allowStale: false })
      });
    if (result) incrementMetric(evaluatorOptions.allowStale ? 'stream.generate.sharedPolicyStaleHit' : 'stream.generate.sharedPolicyHit');
    return result;
  }

  return {
    persistResults,
    buildClientCacheMetadata,
    buildSharedStreamCachePolicy,
    getSharedCachedResult
  };
}

module.exports = { createCachingPersistenceTools };
