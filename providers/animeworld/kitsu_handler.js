'use strict';

const {
  getKitsuAnimeInfo,
  parseKitsuId,
  normalizeTitle
} = require('../anime/provider_utils');

class KitsuProvider {
  async getAnimeInfo(kitsuId) {
    return getKitsuAnimeInfo(kitsuId);
  }

  parseKitsuId(kitsuIdString) {
    return parseKitsuId(kitsuIdString);
  }

  normalizeTitle(title) {
    return normalizeTitle(title);
  }
}

module.exports = new KitsuProvider();
