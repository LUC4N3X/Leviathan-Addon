const { hasExplicitSeasonMarker } = require('./title_parser');

function isAnimeMeta(meta = {}, type = '') {
  const normalizedType = String(type || meta?.type || '').toLowerCase();
  return Boolean(meta?.kitsu_id || meta?.isAnime || normalizedType === 'anime');
}

function getEpisodeParseOptions(meta = {}, type = '') {
  return { anime: isAnimeMeta(meta, type) };
}

function shouldIgnoreAnimeSeason(meta = {}, typeOrTitle = '', maybeTitle = '') {
  const treatSecondArgAsTitle = maybeTitle === '' && typeof typeOrTitle === 'string' && !['anime', 'movie', 'series', 'tv'].includes(String(typeOrTitle || '').toLowerCase());
  const type = treatSecondArgAsTitle ? '' : typeOrTitle;
  const title = treatSecondArgAsTitle ? typeOrTitle : maybeTitle;
  return isAnimeMeta(meta, type) && !hasExplicitSeasonMarker(title);
}

module.exports = {
  isAnimeMeta,
  getEpisodeParseOptions,
  shouldIgnoreAnimeSeason
};
