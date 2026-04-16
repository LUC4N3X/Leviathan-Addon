'use strict';

function createDebridResolutionTools(deps = {}) {
  const {
    resolveLazyStreamData,
    resolveDebridLink,
    generateLazyStream,
    warmupLazyStreamsInBackground,
    getNormalizedDebridService,
    getConfiguredDebridKey
  } = deps;

  function getDebridContext(config = {}) {
    const service = getNormalizedDebridService(config);
    return {
      service,
      apiKey: getConfiguredDebridKey(config, service),
      hasDebridKey: Boolean(service && getConfiguredDebridKey(config, service))
    };
  }

  return {
    getDebridContext,
    resolveLazyStreamData,
    resolveDebridLink,
    generateLazyStream,
    warmupLazyStreamsInBackground
  };
}

module.exports = { createDebridResolutionTools };
