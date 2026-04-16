'use strict';

const { hasExplicitSeasonMarker } = require('./title_parser');

function isAnimeMetaContext(meta = {}, type = '') {
  return Boolean(meta?.kitsu_id || meta?.isAnime || String(type || '').toLowerCase() === 'anime');
}

function getEpisodeParseOptions(meta = {}, type = '') {
  return { anime: isAnimeMetaContext(meta, type) };
}

function shouldIgnoreAnimeSeason(meta = {}, type = '', title = '') {
  return isAnimeMetaContext(meta, type) && !hasExplicitSeasonMarker(title);
}

function mapKitsuEpisodePosition(parsedKitsu, fallbackKitsuMeta) {
  const requestedEpisode = Number(parsedKitsu?.episode || 0) || 0;
  const mappedSeason = Number(fallbackKitsuMeta?.season || parsedKitsu?.season || 1) || 1;
  const baseEpisode = Number(fallbackKitsuMeta?.episode || 1) || 1;

  if (!(requestedEpisode > 0)) {
    return {
      mappedSeason,
      mappedEpisode: 0,
      requestedEpisode: 0
    };
  }

  return {
    mappedSeason,
    mappedEpisode: baseEpisode + requestedEpisode - 1,
    requestedEpisode
  };
}

module.exports = {
  isAnimeMetaContext,
  getEpisodeParseOptions,
  shouldIgnoreAnimeSeason,
  mapKitsuEpisodePosition
};
