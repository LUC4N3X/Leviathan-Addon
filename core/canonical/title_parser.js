const REGEX_TITLE_PUNCTUATION = /[\[\]{}()]/g;
const REGEX_TITLE_SPACING = /[._:+\-]+/g;
const REGEX_TITLE_NOISE = /\b(?:2160p|1080p|720p|480p|4k|uhd|x264|x265|h264|h265|hevc|hdr10\+?|hdr|dv|dolby\s*vision|web[- ]?dl|webrip|bluray|blu[- ]?ray|brrip|dvdrip|remux|proper|repack|nf|amzn|dsnp|atvp|ita|italian|italiano|eng|english|multi|dual|audio|sub|subs|subbed|vostfr|subita)\b/g;

const SEASON_EPISODE_PATTERNS = [
  { pattern: /(?:^|\b)s(\d{1,2})\s*e(\d{1,3})(?:\b|[^\d])/i, extract: (m) => ({ season: parseInt(m[1], 10), episode: parseInt(m[2], 10) }) },
  { pattern: /(?:^|\b)(\d{1,2})x(\d{1,3})(?:\b|[^\d])/i, extract: (m) => ({ season: parseInt(m[1], 10), episode: parseInt(m[2], 10) }) },
  { pattern: /season\s*(\d{1,2}).{0,20}?episode\s*(\d{1,3})/i, extract: (m) => ({ season: parseInt(m[1], 10), episode: parseInt(m[2], 10) }) },
  { pattern: /stagione\s*(\d{1,2}).{0,20}?episodio\s*(\d{1,3})/i, extract: (m) => ({ season: parseInt(m[1], 10), episode: parseInt(m[2], 10) }) },
  { pattern: /(?:^|[^a-z])ep?\.?\s*(\d{1,3})(?:[^\d]|$)/i, extract: (m, defaultSeason) => ({ season: defaultSeason, episode: parseInt(m[1], 10) }) }
];

function normalizeText(value) {
  return String(value || '').trim();
}

function stripAccents(value) {
  return normalizeText(value).normalize('NFKD').replace(/[\u0300-\u036f]/g, '');
}

function normalizeLooseTitle(value) {
  return stripAccents(value)
    .toLowerCase()
    .replace(REGEX_TITLE_PUNCTUATION, ' ')
    .replace(REGEX_TITLE_SPACING, ' ')
    .replace(REGEX_TITLE_NOISE, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokenizeTitle(value, options = {}) {
  const normalized = normalizeLooseTitle(value);
  if (!normalized) return [];
  const minTokenLength = Math.max(1, parseInt(options.minTokenLength || 2, 10) || 2);
  return normalized.split(' ').filter((token) => token.length >= minTokenLength);
}

function hasExplicitSeasonMarker(text = '') {
  return /\b(?:S(?:EASON)?\s*0?\d{1,2}(?:\s*E\d{1,3})?|\d{1,2}x\d{1,3}|STAGIONE\s*0?\d{1,2}|(?:1ST|2ND|3RD|4TH)\s+SEASON)\b/i.test(String(text || ''));
}

function parseAnimeEpisode(filename, defaultSeason = 1) {
  const value = String(filename || '');
  let match = value.match(/\bS(?:EASON)?\s*0?(\d{1,2})\s*[-._ ]+\s*0?(\d{1,4})(?:v\d+)?\b/i);
  if (match) return { season: parseInt(match[1], 10), episode: parseInt(match[2], 10) };

  match = value.match(/\b(\d{1,2})(?:ST|ND|RD|TH)\s+SEASON\s*[-._ ]+\s*0?(\d{1,4})(?:v\d+)?\b/i);
  if (match) return { season: parseInt(match[1], 10), episode: parseInt(match[2], 10) };

  match = value.match(/\b(?:EP(?:ISODE)?|EPISODIO)\s*0?(\d{1,4})(?:v\d+)?\b/i);
  if (match) return { season: defaultSeason, episode: parseInt(match[1], 10) };

  const genericPattern = /(?:^|[\s._\-\[(])0*([1-9]\d{0,3})(?:v\d+)?(?=$|[\s._\-\])])/ig;
  for (const candidate of value.matchAll(genericPattern)) {
    const episode = parseInt(candidate[1], 10);
    if (!Number.isInteger(episode) || episode <= 0) continue;
    if (episode >= 1900 && episode <= 2100) continue;
    return { season: defaultSeason, episode };
  }

  return null;
}

function parseSeasonEpisode(filename, defaultSeason = 1, options = {}) {
  const value = String(filename || '');
  for (const { pattern, extract } of SEASON_EPISODE_PATTERNS) {
    const match = value.match(pattern);
    if (match) {
      const parsed = extract(match, defaultSeason);
      if (parsed && Number.isInteger(parsed.season) && Number.isInteger(parsed.episode) && parsed.episode > 0) {
        return parsed;
      }
    }
  }
  if (options?.anime) return parseAnimeEpisode(value, defaultSeason);
  return null;
}

function extractEpisodeContext(title, defaultSeason = 1, options = {}) {
  return parseSeasonEpisode(title, defaultSeason, options);
}

function extractSeasonFromText(title) {
  const value = String(title || '');
  const patterns = [
    /(?:\b|[^a-z])s(\d{1,2})(?!\s*e\d)/i,
    /season\s*(\d{1,2})/i,
    /stagione\s*(\d{1,2})/i
  ];
  for (const pattern of patterns) {
    const match = value.match(pattern);
    if (match) return parseInt(match[1], 10);
  }
  return null;
}

module.exports = {
  normalizeText,
  stripAccents,
  normalizeLooseTitle,
  tokenizeTitle,
  hasExplicitSeasonMarker,
  parseAnimeEpisode,
  parseSeasonEpisode,
  extractEpisodeContext,
  extractSeasonFromText
};
