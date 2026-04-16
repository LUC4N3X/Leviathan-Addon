'use strict';

const REGEX_TITLE_PUNCTUATION = /[\[\]{}()]/g;
const REGEX_TITLE_SPACING = /[._:+\-]+/g;
const REGEX_TITLE_NOISE = /\b(?:2160p|1080p|720p|480p|x264|x265|h264|h265|hevc|hdr10\+?|hdr|dv|dolby\s*vision|web[- ]?dl|webrip|bluray|brrip|dvdrip|remux|proper|repack|nf|amzn|dsnp|atvp|ita|italian|italiano|eng|english|multi|dual|audio|sub|subs|subbed|vostfr|subita)\b/g;

function normalizeText(value) {
  return String(value || '').trim();
}

function stripAccents(value) {
  return normalizeText(value).normalize('NFKD').replace(/[\u0300-\u036f]/g, '');
}

function normalizeLooseTitle(value, options = {}) {
  const keepYear = options.keepYear === true;
  let normalized = stripAccents(value)
    .toLowerCase()
    .replace(REGEX_TITLE_PUNCTUATION, ' ')
    .replace(REGEX_TITLE_SPACING, ' ')
    .replace(REGEX_TITLE_NOISE, ' ');

  if (!keepYear) normalized = normalized.replace(/\b(?:19|20)\d{2}\b/g, ' ');

  return normalized.replace(/\s+/g, ' ').trim();
}

function tokenizeTitle(value, options = {}) {
  const minTokenLength = Number.isInteger(options.minTokenLength) ? options.minTokenLength : 2;
  const keepYear = options.keepYear === true;
  const keepNumbers = options.keepNumbers === true;
  const normalized = normalizeLooseTitle(value, { keepYear });
  if (!normalized) return [];

  return normalized
    .split(' ')
    .filter((token) => token.length >= minTokenLength)
    .filter((token) => keepNumbers || !/^\d+$/.test(token));
}

function hasExplicitSeasonMarker(text = '') {
  return /\b(?:S\d{1,2}E\d{1,3}|S(?:EASON)?\s*0?\d{1,2}|\d{1,2}x\d{1,3}|STAGIONE\s*0?\d{1,2}|(?:1ST|2ND|3RD|4TH)\s+SEASON)\b/i.test(String(text || ''));
}

function extractEpisodeContext(identifier = '') {
  if (!identifier || typeof identifier !== 'string') return {};
  const parts = identifier.split(':');
  if (parts.length < 3) return {};

  let season = null;
  let episode = null;

  if (parts[0].toLowerCase() === 'kitsu' && /^\d+$/.test(parts[1])) {
    season = parts.length >= 4 ? parseInt(parts[2], 10) : 1;
    episode = parseInt(parts[parts.length >= 4 ? 3 : 2], 10);
  } else {
    season = parseInt(parts[1], 10);
    episode = parseInt(parts[2], 10);
  }

  return {
    season: Number.isInteger(season) ? season : undefined,
    episode: Number.isInteger(episode) ? episode : undefined
  };
}

module.exports = {
  normalizeLooseTitle,
  tokenizeTitle,
  hasExplicitSeasonMarker,
  extractEpisodeContext
};
