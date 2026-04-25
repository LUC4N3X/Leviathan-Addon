'use strict';

function createMetadataResolutionTools(deps = {}) {
  const { getMetadata, buildExternalAddonRequestId } = deps;

  async function resolveMetadata(finalId, type, config) {
    return getMetadata(finalId, type, config);
  }

  return {
    getMetadata: resolveMetadata,
    buildExternalAddonRequestId
  };
}

module.exports = { createMetadataResolutionTools };
