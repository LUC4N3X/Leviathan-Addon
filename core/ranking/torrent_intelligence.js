'use strict';

let parseTorrentTitle = null;
try {
  parseTorrentTitle = require('parse-torrent-title');
} catch (_) {
  parseTorrentTitle = null;
}

let releaseSignals = null;
try {
  releaseSignals = require('../lib/release_signal_engine');
} catch (_) {
  releaseSignals = null;
}

const QUALITY_SCORE = Object.freeze({
  remux: 34,
  bluray: 28,
  webdl: 24,
  webrip: 18,
  hdtv: 10,
  dvdrip: 4,
  cam: -80,
  unknown: 0
});

const RESOLUTION_SCORE = Object.freeze({
  '2160p': 30,
  '1080p': 22,
  '720p': 12,
  '480p': 3,
  unknown: 0
});

const LANGUAGE_SCORE = Object.freeze({
  ita: 30,
  multi_ita: 24,
  eng: 8,
  neutral: 0,
  other: -18,
  sub_only: -35
});

function firstText(...values) {
  for (const value of values) {
    const text = String(value ?? '').trim();
    if (text) return text;
  }
  return '';
}

function normalizeText(value = '') {
  return String(value || '')
    .normalize('NFKC')
    .replace(/[._+]+/g, ' ')
    .replace(/[-:()[\]{}]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function parseTitle(title = '') {
  if (!parseTorrentTitle) return null;
  try {
    const parsed = typeof parseTorrentTitle === 'function'
      ? parseTorrentTitle(title)
      : (typeof parseTorrentTitle.parse === 'function' ? parseTorrentTitle.parse(title) : null);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch (_) {
    return null;
  }
}

function detectResolution(text = '', parsed = null) {
  const direct = String(parsed?.resolution || parsed?.quality || '').toLowerCase();
  const raw = `${direct} ${text}`.toLowerCase();
  if (/\b(?:2160p|4k|uhd)\b/.test(raw)) return '2160p';
  if (/\b(?:1080p|1080i|fhd|full\s*hd)\b/.test(raw)) return '1080p';
  if (/\b(?:720p|hd)\b/.test(raw)) return '720p';
  if (/\b(?:576p|480p|sd)\b/.test(raw)) return '480p';
  return 'unknown';
}

function detectQuality(text = '', parsed = null) {
  const raw = `${parsed?.source || ''} ${parsed?.quality || ''} ${text}`.toLowerCase();
  if (/\b(?:cam|hdcam|ts|telesync|telecine|camrip|dvdscr|screener|scr)\b/.test(raw)) return 'cam';
  if (/\b(?:remux)\b/.test(raw)) return 'remux';
  if (/\b(?:blu\s*ray|bluray|bdrip|brrip|bdremux)\b/.test(raw)) return 'bluray';
  if (/\b(?:web\s*dl|web-dl|webdl|dlrip)\b/.test(raw)) return 'webdl';
  if (/\b(?:webrip|web\s*rip)\b/.test(raw)) return 'webrip';
  if (/\b(?:hdtv|pdtv|dsr)\b/.test(raw)) return 'hdtv';
  if (/\b(?:dvd\s*rip|dvdrip)\b/.test(raw)) return 'dvdrip';
  return 'unknown';
}

function detectCodec(text = '') {
  const raw = text.toLowerCase();
  if (/\b(?:av1)\b/.test(raw)) return 'av1';
  if (/\b(?:x265|h265|hevc)\b/.test(raw)) return 'x265';
  if (/\b(?:x264|h264|avc)\b/.test(raw)) return 'x264';
  return 'unknown';
}

function detectHdr(text = '') {
  const raw = text.toLowerCase();
  if (/\b(?:dolby\s*vision|dv)\b/.test(raw)) return 'dv';
  if (/\bhdr10\+\b/.test(raw)) return 'hdr10+';
  if (/\bhdr10\b/.test(raw)) return 'hdr10';
  if (/\bhdr\b/.test(raw)) return 'hdr';
  return 'none';
}

function detectAudio(text = '') {
  const raw = text.toLowerCase();
  if (/\b(?:truehd|atmos)\b/.test(raw)) return 'lossless_atmos';
  if (/\b(?:dts[-\s]?hd|dts)\b/.test(raw)) return 'dts';
  if (/\b(?:eac3|ddp|dd\+)\b/.test(raw)) return 'eac3';
  if (/\bac3\b/.test(raw)) return 'ac3';
  if (/\baac\b/.test(raw)) return 'aac';
  return 'unknown';
}

const NON_AUDIO_LANGUAGE_TOKENS = new Set(['multi subs']);
const MULTI_AUDIO_TOKENS = new Set(['multi audio', 'dual audio']);

function refineLanguageBucket(base, parsed) {
  const langs = Array.isArray(parsed?.languages) ? parsed.languages : [];
  if (langs.length === 0 || base === 'sub_only') return base;
  const audioLangs = langs.filter((lang) => !NON_AUDIO_LANGUAGE_TOKENS.has(lang) && !MULTI_AUDIO_TOKENS.has(lang));
  const hasMultiAudio = langs.some((lang) => MULTI_AUDIO_TOKENS.has(lang));
  const hasIta = audioLangs.includes('italian');
  const foreign = audioLangs.filter((lang) => lang !== 'italian');
  if (hasIta) {
    if (hasMultiAudio || foreign.length > 0 || base === 'multi_ita') return 'multi_ita';
    return 'ita';
  }
  if (base !== 'neutral') return base;
  if (audioLangs.includes('english')) return 'eng';
  if (foreign.length > 0) return 'other';
  return base;
}

function detectLanguageBucket(text = '', item = {}, parsed = null) {
  const explicit = firstText(item.language, item.lang, Array.isArray(item.languages) ? item.languages.join(' ') : '', item.behaviorHints?.language);
  const raw = `${explicit} ${text}`;
  let bucket = 'neutral';
  if (/\b(?:sub\s*ita|subita|ita\s*sub|subs?\s*ita)\b/i.test(raw) && !/\b(?:audio\s*ita|ita\s*(?:ac3|aac|eac3|ddp|dts|truehd)|italian(?:o)?\s*audio)\b/i.test(raw)) bucket = 'sub_only';
  else if (/\b(?:ita|italiano|italian|audio\s*ita|true\s*ita)\b/i.test(raw) && /\b(?:multi|dual|eng|english)\b/i.test(raw)) bucket = 'multi_ita';
  else if (/\b(?:ita|italiano|italian|audio\s*ita|true\s*ita)\b/i.test(raw)) bucket = 'ita';
  else if (/\b(?:eng|english|audio\s*eng)\b/i.test(raw)) bucket = 'eng';
  else if (/\b(?:french|german|spanish|latino|russian|rus|hindi|korean|japanese|vostfr)\b/i.test(raw)) bucket = 'other';
  return refineLanguageBucket(bucket, parsed);
}

function detectPack(text = '', item = {}, parsed = null) {
  const raw = `${text} ${item?._isSeasonPack ? 'season_pack' : ''} ${item?._isMultiSeasonPack ? 'multi_season' : ''}`.toLowerCase();
  if (/\b(?:complete\s+series|serie\s+completa|s\d{1,2}\s*[-+]\s*s\d{1,2})\b/.test(raw)) return 'multiSeason';
  if (/\b(?:season\s*pack|stagione\s*completa|complete\s+season|s\d{1,2})\b/.test(raw)) return 'season';
  if (parsed?.anthology === true) return 'multiSeason';
  if (/\bpack\b/.test(raw)) return 'season';
  return 'single';
}

function extractEpisode(text = '', parsed = null) {
  const raw = String(text || '');
  if (parsed?.season && parsed?.episode) return { season: Number(parsed.season), episode: Number(parsed.episode), source: 'parser' };
  let match = raw.match(/\bS(?:eason)?\s*0*(\d{1,2})\s*[-_. ]*E(?:pisode)?\s*0*(\d{1,3})\b/i);
  if (match) return { season: Number(match[1]), episode: Number(match[2]), source: 'sxe' };
  match = raw.match(/\b(\d{1,2})x(\d{1,3})\b/i);
  if (match) return { season: Number(match[1]), episode: Number(match[2]), source: 'x' };
  match = raw.match(/\b(?:episode|episodio|ep)\s*0*(\d{1,3})\b/i);
  if (match) return { season: null, episode: Number(match[1]), source: 'ep' };
  return null;
}

function compareEpisode(meta = {}, episodeHint = null) {
  if (!episodeHint) return 'unknown';
  const wantedEpisode = Number(meta?.episode || 0) || null;
  const wantedSeason = Number(meta?.season || 0) || null;
  if (!wantedEpisode) return 'not_required';
  if (episodeHint.episode !== wantedEpisode) return 'mismatch';
  if (wantedSeason && episodeHint.season && episodeHint.season !== wantedSeason) return 'mismatch';
  return episodeHint.season ? 'exact' : 'episode_only';
}

function getSourceProof(item = {}) {
  if (item?._dbCachedRd === true || item?.cached_rd === true || item?._tbCached === true || item?.isSavedCloud === true || item?._savedCloud === true) return 'debrid_cached';
  if (item?._externalSnapshot === true || item?._fromExternalSnapshot === true) return 'snapshot';
  if (item?._dedupeMergedCount >= 3 || item?._dedupeEvidence?.mergedCount >= 3) return 'multi_source';
  return 'single_source';
}

function evaluateTorrentIntelligence(item = {}, meta = {}, options = {}) {
  const text = normalizeText(firstText(
    item.title,
    item.name,
    item.filename,
    item.fileTitle,
    item.behaviorHints?.filename,
    item.description
  ));
  let parsed = parseTitle(text);
  if (!parsed && releaseSignals && typeof releaseSignals.extractReleaseSignals === 'function') {
    parsed = releaseSignals.extractReleaseSignals(text);
  }
  const resolution = detectResolution(text, parsed);
  const quality = detectQuality(text, parsed);
  const codec = detectCodec(text);
  const hdr = detectHdr(text);
  const audio = detectAudio(text);
  const language = detectLanguageBucket(text, item, parsed);
  const pack = detectPack(text, item, parsed);
  const episodeHint = extractEpisode(text, parsed);
  const episodeMatch = compareEpisode(meta, episodeHint);
  const sourceProof = getSourceProof(item);

  let score = 0;
  const reasons = [];
  const add = (value, reason) => {
    score += value;
    if (value) reasons.push(`${value >= 0 ? '+' : ''}${value} ${reason}`);
  };

  add(RESOLUTION_SCORE[resolution] || 0, `resolution=${resolution}`);
  add(QUALITY_SCORE[quality] || 0, `quality=${quality}`);
  add(LANGUAGE_SCORE[language] || 0, `language=${language}`);

  if (codec === 'av1') add(4, 'codec=av1');
  else if (codec === 'x265') add(6, 'codec=x265');
  else if (codec === 'x264') add(3, 'codec=x264');

  if (hdr === 'dv' || hdr === 'hdr10+') add(5, `hdr=${hdr}`);
  else if (hdr === 'hdr10' || hdr === 'hdr') add(3, `hdr=${hdr}`);

  if (audio === 'lossless_atmos') add(6, `audio=${audio}`);
  else if (audio !== 'unknown') add(3, `audio=${audio}`);

  if (episodeMatch === 'exact') add(26, 'episode=exact');
  else if (episodeMatch === 'episode_only') add(14, 'episode=number_only');
  else if (episodeMatch === 'mismatch') add(-120, 'episode=mismatch');

  if (pack === 'season' && meta?.isSeries) add(8, 'pack=season');
  else if (pack === 'multiSeason') add(-18, 'pack=multiSeason');

  if (sourceProof === 'debrid_cached') add(24, 'proof=debrid_cached');
  else if (sourceProof === 'multi_source') add(12, 'proof=multi_source');
  else if (sourceProof === 'snapshot') add(7, 'proof=snapshot');

  if (/\b(?:sample|trailer|extras?|behind\s*the\s*scenes)\b/i.test(text)) add(-100, 'trash=sample_extra');
  if (text.length < 8) add(-25, 'title=too_short');

  const weight = Math.max(0, Math.min(5, Number(options.weight ?? options.ranking?.torrentIntelligenceWeight ?? 1) || 1));
  const weightedScore = Math.round(score * weight);

  return {
    score: weightedScore,
    rawScore: score,
    weight,
    parsed,
    features: {
      resolution,
      quality,
      codec,
      hdr,
      audio,
      language,
      languages: Array.isArray(parsed?.languages) ? parsed.languages : [],
      dubbed: parsed?.dubbed === true,
      bitDepth: parsed?.bitDepth || null,
      threeD: parsed?.threeD || null,
      complete: parsed?.complete === true,
      pack,
      episodeMatch,
      episodeHint,
      sourceProof
    },
    reasons,
    text: reasons.join(' | ')
  };
}

module.exports = {
  detectAudio,
  detectCodec,
  detectHdr,
  detectLanguageBucket,
  detectPack,
  detectQuality,
  detectResolution,
  evaluateTorrentIntelligence,
  extractEpisode,
  parseTitle
};
