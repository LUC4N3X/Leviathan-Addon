'use strict';

const { TinyLruCache } = require('../utils/tiny_lru_cache');

let ptt = null;
try {
  ptt = require('parse-torrent-title');
} catch (_) {
  ptt = null;
}

let releaseSignals = null;
try {
  releaseSignals = require('../lib/release_signal_engine');
  if (releaseSignals && typeof releaseSignals.bindToTitleParser === 'function') {
    releaseSignals.bindToTitleParser(ptt);
  }
} catch (_) {
  releaseSignals = null;
}

const PARSE_CACHE = new TinyLruCache({
  max: Math.max(1000, Number.parseInt(process.env.RELEASE_PARSE_CACHE_MAX || '8000', 10) || 8000),
  ttlMs: Math.max(60_000, Number.parseInt(process.env.RELEASE_PARSE_CACHE_TTL_MS || String(8 * 60 * 60 * 1000), 10) || (8 * 60 * 60 * 1000))
});

const DETAILS_CACHE = new TinyLruCache({
  max: Math.max(1000, Number.parseInt(process.env.RELEASE_DETAILS_CACHE_MAX || '8000', 10) || 8000),
  ttlMs: Math.max(60_000, Number.parseInt(process.env.RELEASE_DETAILS_CACHE_TTL_MS || String(8 * 60 * 60 * 1000), 10) || (8 * 60 * 60 * 1000))
});

const EMPTY_DETAILS = Object.freeze({
  quality: 'SD',
  qualityLabel: 'SD',
  tags: '',
  languages: [],
  rawLanguages: [],
  cleanTitle: '',
  source: '',
  codec: '',
  videoCodec: '',
  audio: '',
  audioCodec: '',
  audioChannels: '',
  dynamicRange: [],
  container: '',
  releaseGroup: '',
  flags: {},
  season: null,
  episode: null,
  absoluteEpisode: null,
  isPack: false,
  isSeasonPack: false,
  isMultiSeasonPack: false,
  subtitleLanguages: []
});

const LANGUAGE_DISPLAY = Object.freeze({
  italian: '🇮🇹 ITA',
  english: '🇬🇧 ENG',
  japanese: '🇯🇵 JPN',
  french: '🇫🇷 FRA',
  german: '🇩🇪 GER',
  spanish: '🇪🇸 ESP',
  russian: '🇷🇺 RUS',
  portuguese: '🇵🇹 POR',
  multi: '🌍 MULTI',
  'multi audio': '🌍 MULTI',
  'dual audio': '🌍 MULTI'
});

const LANGUAGE_ALIASES = Object.freeze({
  ita: 'italian',
  it: 'italian',
  italian: 'italian',
  italiano: 'italian',
  eng: 'english',
  en: 'english',
  english: 'english',
  jpn: 'japanese',
  jp: 'japanese',
  ja: 'japanese',
  japanese: 'japanese',
  fra: 'french',
  fre: 'french',
  fr: 'french',
  french: 'french',
  ger: 'german',
  deu: 'german',
  de: 'german',
  german: 'german',
  esp: 'spanish',
  spa: 'spanish',
  es: 'spanish',
  spanish: 'spanish',
  rus: 'russian',
  ru: 'russian',
  russian: 'russian',
  por: 'portuguese',
  pt: 'portuguese',
  portuguese: 'portuguese',
  multi: 'multi audio',
  multilang: 'multi audio',
  multilanguage: 'multi audio',
  dual: 'dual audio',
  'dual audio': 'dual audio',
  'multi audio': 'multi audio',
  'multi subs': 'multi subs'
});

const SOURCE_PATTERNS = Object.freeze([
  { regex: /\b(?:br|bd)[-.\s]?remux\b|\bremux\b/i, value: 'REMUX' },
  { regex: /\bblu[-.\s]?ray\b|\bbd[-.\s]?rip\b|\bbrrip\b|\bbdmux\b/i, value: 'BluRay' },
  { regex: /\bweb[-.\s]?dl\b|\bwebdl\b|\bdlrip\b/i, value: 'WEB-DL' },
  { regex: /\bweb[-.\s]?rip\b|\bwebrip\b/i, value: 'WEBRip' },
  { regex: /\bhdtv\b|\bpdtv\b|\bdsr\b/i, value: 'HDTV' },
  { regex: /\bdvd[-.\s]?(?:rip|scr)?\b|\bdvdrip\b/i, value: 'DVDRip' },
  { regex: /\b(?:hd)?cam(?:rip)?\b/i, value: 'CAM' },
  { regex: /\b(?:telesync|telecine|screener|scr|hdts|ts)\b/i, value: 'SCR' }
]);

const VIDEO_CODEC_PATTERNS = Object.freeze([
  { regex: /\b(?:av1)\b/i, value: 'AV1' },
  { regex: /\b(?:x265|h265|h\.265|hevc)\b/i, value: 'HEVC' },
  { regex: /\b(?:x264|h264|h\.264|avc)\b/i, value: 'AVC' },
  { regex: /\b(?:vvc|h266|h\.266)\b/i, value: 'VVC' },
  { regex: /\bxvid\b/i, value: 'XviD' },
  { regex: /\bdivx\b/i, value: 'DivX' }
]);

const AUDIO_CODEC_PATTERNS = Object.freeze([
  { regex: /\btruehd\b/i, value: 'TRUEHD' },
  { regex: /\batmos\b/i, value: 'ATMOS' },
  { regex: /\bdts\s?:\s?x\b|\bdtsx\b/i, value: 'DTS:X' },
  { regex: /\bdts[-.\s]?hd[-.\s]?ma\b|\bdts\s?ma\b/i, value: 'DTS-HD MA' },
  { regex: /\bdts[-.\s]?hd\b/i, value: 'DTS-HD' },
  { regex: /\bdts\b/i, value: 'DTS' },
  { regex: /\be[-.\s]?ac[-.\s]?3\b|\bddp\d*(?:\.\d)?\b|\bdd\+\b/i, value: 'DDP' },
  { regex: /\bac[-.\s]?3\b|\bdolby\s?digital\b/i, value: 'AC3' },
  { regex: /\baac\b/i, value: 'AAC' },
  { regex: /\bopus\b/i, value: 'OPUS' },
  { regex: /\bflac\b/i, value: 'FLAC' },
  { regex: /\bmp3\b/i, value: 'MP3' }
]);

const CONTAINER_PATTERNS = Object.freeze([
  { regex: /\.mkv\b/i, value: 'MKV' },
  { regex: /\.mp4\b/i, value: 'MP4' },
  { regex: /\.avi\b/i, value: 'AVI' },
  { regex: /\.m2ts\b/i, value: 'M2TS' },
  { regex: /\.ts\b/i, value: 'TS' },
  { regex: /\.iso\b/i, value: 'ISO' }
]);

const RELEASE_TOKEN_PATTERN = /\b(?:4320p|2160p|1440p|1080p|1080i|720p|576p|480p|4k|8k|uhd|fhd|x265|x264|h265|h264|h\.265|h\.264|hevc|avc|av1|vvc|hdr10\+?|hdr|dv|dovi|dolby\s?vision|web[-.\s]?dl|web[-.\s]?rip|webdl|webrip|web|bluray|blu[-.\s]?ray|bdremux|bdrip|brrip|bdmux|remux|dvdrip|hdtv|cam|hdcam|telesync|telecine|screener|proper|repack|rerip|extended|unrated|imax|ita|italiano|eng|english|jpn|japanese|multi|dual\s?audio|sub[-.\s]?ita|vostit|aac|ac3|ddp\d*(?:[.\s]?\d)?|eac3|dts|truehd|atmos|opus|flac|mp3|5\.1|7\.1|2\.0|10bit|8bit|complete|completa)\b/gi;

function safeString(value) {
  return String(value ?? '').trim();
}

function normalizeSpaces(value) {
  return safeString(value)
    .normalize('NFKC')
    .replace(/[._+]+/g, ' ')
    .replace(/[‐‑–—―〜～]/g, '-')
    .replace(/\s+/g, ' ')
    .trim();
}

function compactForScan(value) {
  return safeString(value)
    .normalize('NFKC')
    .replace(/[._+]+/g, ' ')
    .replace(/[(){}\[\]|:;]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function stripFalseItalianDomains(value) {
  return safeString(value)
    .replace(/\b(?:tracker|announce|torrent|download|ddl|stream|www)\.[a-z0-9.-]+\.it\b/gi, ' ')
    .replace(/(?:https?:\/\/)?(?:www\.)?[a-z0-9][a-z0-9-]*(?:\.[a-z0-9][a-z0-9-]*)*\.it(?:[\/:?#]|$|[\s_\-\]\)])/gi, ' ')
    .replace(/\b[a-z0-9-]+\.it\b/gi, ' ');
}

function firstPatternValue(text, patterns, fallback = '') {
  for (const entry of patterns) {
    if (entry.regex.test(text)) return entry.value;
  }
  return fallback;
}

function detectSource(parsedSource, text) {
  const parsed = safeString(parsedSource);
  const detected = firstPatternValue(`${parsed} ${text}`, SOURCE_PATTERNS, '');
  return detected || parsed;
}

function pushUnique(list, value) {
  const normalized = normalizeLanguageToken(value);
  if (normalized && !list.includes(normalized)) list.push(normalized);
}

function normalizeLanguageToken(value) {
  const raw = safeString(value).toLowerCase().replace(/[_-]+/g, ' ').replace(/\s+/g, ' ');
  if (!raw) return '';
  return LANGUAGE_ALIASES[raw] || raw;
}

function prettyLanguageName(value) {
  const normalized = normalizeLanguageToken(value);
  if (!normalized) return '';
  if (normalized === 'multi audio') return 'Multi';
  if (normalized === 'dual audio') return 'Dual Audio';
  if (normalized === 'multi subs') return 'Multi subs';
  return normalized.charAt(0).toUpperCase() + normalized.slice(1);
}

function normalizeResolution(value, text) {
  const raw = `${safeString(value)} ${text}`.toLowerCase();
  if (/\b(?:4320p|8k)\b/.test(raw)) return '4320p';
  if (/\b(?:2160p|4k|uhd)\b/.test(raw)) return '2160p';
  if (/\b(?:1440p|2k|qhd)\b/.test(raw)) return '1440p';
  if (/\b(?:1080p|1080i|fhd|full\s?hd)\b/.test(raw)) return '1080p';
  if (/\b720p\b/.test(raw)) return '720p';
  if (/\b(?:576p|480p|sd)\b/.test(raw)) return '480p';
  return '';
}

function detectQuality(resolution, source, text) {
  const raw = `${source} ${text}`.toLowerCase();
  if (/\b(?:cam|hdcam|ts|telesync|telecine|camrip|dvdscr|screener|scr)\b/.test(raw)) return 'CAM';
  if (resolution === '4320p') return '8K';
  if (resolution === '2160p') return '4K';
  if (resolution === '1440p') return '1440p';
  if (resolution === '1080p') return '1080p';
  if (resolution === '720p') return '720p';
  if (resolution === '480p') return '480p';
  return 'SD';
}

function detectHdr(text, parsed = {}) {
  const raw = `${text} ${safeString(parsed.hdr)}`;
  const hdr = [];
  const push = (value) => {
    if (value && !hdr.includes(value)) hdr.push(value);
  };
  if (/\bdolby[-.\s]?vision\b|\bdovi\b|\bDV\b/.test(raw)) push('DV');
  if (/\bhdr10\+\b|\bhdr10plus\b/i.test(raw)) push('HDR10+');
  if (/\bhdr10\b/i.test(raw)) push('HDR10');
  if (/\bhdr\b/i.test(raw)) push('HDR');
  return hdr;
}

function detectChannels(text) {
  const match = safeString(text).match(/\b(?:ddp|eac3|dts|aac|ac3|truehd)?\s*([1-7])[ .](0|1)\b/i);
  if (match) return `${match[1]}.${match[2]}`;
  if (/\bmono\b/i.test(text)) return '1.0';
  if (/\bstereo\b/i.test(text)) return '2.0';
  return '';
}

function detectReleaseGroup(text, parsed = {}) {
  const cleanText = safeString(text).replace(/\.(?:mkv|mp4|avi|iso|wmv|ts|flv|mov|m2ts|m4v|mpg|mpeg)$/i, '');
  const parsedGroup = safeString(parsed.group || parsed.releaseGroup || parsed.release_group);
  const candidates = [
    cleanText.match(/^\[([A-Za-z0-9_. -]{2,25})\]/)?.[1],
    parsedGroup,
    cleanText.match(/-(?!DL\b)([A-Za-z0-9][A-Za-z0-9._-]{1,24})$/i)?.[1],
    cleanText.match(/\[([A-Za-z0-9][A-Za-z0-9._ -]{1,24})\]$/)?.[1]
  ];

  for (const candidate of candidates) {
    const clean = safeString(candidate).replace(/^[-_.\s]+|[-_.\s]+$/g, '');
    if (!clean || clean.length < 2 || clean.length > 25) continue;
    if (/^(mkv|mp4|avi|1080p|720p|2160p|4k|aac|ac3|ddp|dts|x264|x265|hevc|webdl|webrip)$/i.test(clean)) continue;
    if (/\b(?:ita|eng|multi|dual|web[-.]?dl|web[-.]?rip|x26[45]|h26[45]|hevc|aac|ac3|ddp|dts|1080p|720p|2160p)\b/i.test(clean)) continue;
    return clean.toUpperCase();
  }
  return '';
}

function detectFlags(text, signals = {}) {
  const raw = safeString(text);
  return {
    remux: /\b(?:br|bd)?remux\b|\bremux\b/i.test(raw),
    proper: /\bproper\b/i.test(raw),
    repack: /\brepack\b/i.test(raw),
    rerip: /\brerip\b/i.test(raw),
    extended: /\bextended\b/i.test(raw),
    unrated: /\bunrated\b/i.test(raw),
    imax: /\bimax\b/i.test(raw),
    threeD: /\b3d\b/i.test(raw) || Boolean(signals.threeD),
    cam: /\b(?:cam|hdcam|telesync|telecine|ts)\b/i.test(raw),
    screener: /\b(?:scr|screener|dvdscr|bdscr)\b/i.test(raw),
    pack: detectPackType(raw, signals).isPack
  };
}

function detectEpisode(text, parsed = {}) {
  const raw = safeString(text);
  const season = Number.parseInt(parsed.season ?? parsed.seasonNumber, 10);
  const episode = Number.parseInt(parsed.episode ?? parsed.episodeNumber, 10);
  if (Number.isInteger(season) && season > 0 && Number.isInteger(episode) && episode > 0) {
    return { season, episode, absoluteEpisode: null };
  }

  let match = raw.match(/\bS(?:eason)?\s*0*(\d{1,2})\s*[-_. ]*E(?:pisode)?\s*0*(\d{1,3})\b/i);
  if (match) return { season: Number(match[1]), episode: Number(match[2]), absoluteEpisode: null };

  match = raw.match(/\b(\d{1,2})x(\d{1,3})\b/i);
  if (match) return { season: Number(match[1]), episode: Number(match[2]), absoluteEpisode: null };

  match = raw.match(/\b(?:episode|episodio|ep)\s*0*(\d{1,3})\b/i);
  if (match) return { season: null, episode: Number(match[1]), absoluteEpisode: Number(match[1]) };

  match = raw.match(/(?:^|\s)-\s*0*(\d{1,4})(?:v\d+)?(?:\s|$|\[|\()/i);
  if (match && /\[[^\]]+\]|nyaa|anidex|anime|subsplease|erai-raws|horriblesubs/i.test(raw)) {
    return { season: null, episode: Number(match[1]), absoluteEpisode: Number(match[1]) };
  }

  return { season: null, episode: null, absoluteEpisode: null };
}

function detectEpisodeRange(text) {
  const raw = safeString(text);
  let match = raw.match(/\bS\d{1,2}E0*(\d{1,3})\s*(?:-|~|to|a)\s*(?:E)?0*(\d{1,3})\b/i);
  if (match) return { from: Number(match[1]), to: Number(match[2]) };
  match = raw.match(/\b(?:episodes?|episodi?)\s*0*(\d{1,3})\s*(?:-|~|to|a)\s*0*(\d{1,3})\b/i);
  if (match) return { from: Number(match[1]), to: Number(match[2]) };
  return null;
}

function detectPackType(text, signals = {}) {
  const raw = safeString(text).toLowerCase();
  const range = detectEpisodeRange(text);
  const multiSeason = /\b(?:complete\s+series|serie\s+completa|full\s+series|s\d{1,2}\s*(?:-|~|to|a)\s*s\d{1,2}|season\s*\d{1,2}\s*(?:-|~|to|a)\s*\d{1,2}|stagion[ei]\s*\d{1,2}\s*(?:-|~|to|a)\s*\d{1,2})\b/i.test(text);
  const seasonPack = Boolean(range)
    || /\b(?:season|stagion[ei])\s*\d{1,2}\b/i.test(text)
    || /\b(?:complete\s+season|stagione\s+completa|full\s+season|batch|cour|pack|integrale)\b/i.test(text)
    || /\bS\d{1,2}(?!E\d{1,3})\b/i.test(text);
  const anthology = signals.anthology === true || /\b(?:collection|saga|trilogy|duology|anthology|box\s?set)\b/i.test(text);
  const isPack = multiSeason || seasonPack || anthology || signals.complete === true;
  return { isPack, isSeasonPack: seasonPack && !multiSeason, isMultiSeasonPack: multiSeason || anthology, episodeRange: range };
}

function detectLanguages(text, parsed = {}, signals = {}) {
  const scan = stripFalseItalianDomains(text);
  const languages = [];
  const subtitleLanguages = [];

  const push = (value) => pushUnique(languages, value);
  const pushSub = (value) => {
    const normalized = normalizeLanguageToken(value);
    if (normalized && !subtitleLanguages.includes(normalized)) subtitleLanguages.push(normalized);
  };

  const parsedLangs = [];
  if (Array.isArray(parsed.languages)) parsedLangs.push(...parsed.languages);
  if (Array.isArray(parsed.language)) parsedLangs.push(...parsed.language);
  if (parsed.language && !Array.isArray(parsed.language)) parsedLangs.push(parsed.language);
  if (parsed.lang) parsedLangs.push(parsed.lang);
  if (Array.isArray(signals.languages)) parsedLangs.push(...signals.languages);
  parsedLangs.forEach(push);

  if (/\b(?:sub|subs|subbed|softsub|sottotitoli|vost(?:it)?|vostita)\s*[-._ ]*(?:ita|it|italian)|\b(?:ita|it|italian)\s*[-._ ]*(?:sub|subs|subbed)\b/i.test(scan)) {
    pushSub('italian');
    push('multi subs');
  }

  if (/\b(?:multi|multilang(?:uage)?|dual\s*audio|doppio\s*audio)\b/i.test(scan)) push(/\bdual/i.test(scan) ? 'dual audio' : 'multi audio');
  if (/\bITA\b/.test(scan) || /\bitaliano\b/i.test(scan) || /\b(?:audio|lingua|lang|dub|doppiat[oa]|ac-?3|aac|ddp|dts|truehd)\s*[-._: ]*(?:ita|it|italian)\b/i.test(scan) || /\b(?:ita|it|italian)\s*[-._: ]*(?:audio|dub|doppiat[oa]|ac-?3|aac|ddp|dts|truehd)\b/i.test(scan)) push('italian');
  if (/\b(?:eng|english)\b/i.test(scan) && !/\b(?:eng|english)\s*[-._ ]*sub/i.test(scan)) push('english');
  if (/\b(?:jpn|jp|japanese|raw)\b/i.test(scan)) push('japanese');
  if (/\b(?:fra|fre|french)\b/i.test(scan)) push('french');
  if (/\b(?:ger|deu|german)\b/i.test(scan)) push('german');
  if (/\b(?:esp|spa|spanish)\b/i.test(scan)) push('spanish');
  if (/\b(?:rus|russian)\b/i.test(scan)) push('russian');

  return { languages, subtitleLanguages };
}

function cleanTitleFromText(text, parsed = {}) {
  const parsedTitle = normalizeSpaces(parsed.title || parsed.name || '');
  RELEASE_TOKEN_PATTERN.lastIndex = 0;
  const dirtyParsedTitle = parsedTitle && (
    /^\[[^\]]+\]/.test(parsedTitle)
    || /\s+-\s+\d{1,4}(?:v\d+)?(?:\s|$|\[|\()/i.test(parsedTitle)
    || RELEASE_TOKEN_PATTERN.test(parsedTitle)
  );
  RELEASE_TOKEN_PATTERN.lastIndex = 0;
  if (parsedTitle && parsedTitle.length > 1 && !dirtyParsedTitle) return parsedTitle;

  return normalizeSpaces(
    safeString(text)
      .replace(/\.(?:mkv|mp4|avi|iso|wmv|ts|flv|mov|m2ts|m4v|mpg|mpeg)$/i, '')
      .replace(/-\s*[A-Za-z0-9][A-Za-z0-9._-]{1,24}$/i, ' ')
      .replace(/\[[^\]]*(?:subsplease|erai-raws|horriblesubs|judas|ita|eng|1080p|720p|2160p)[^\]]*\]/gi, ' ')
      .replace(RELEASE_TOKEN_PATTERN, ' ')
      .replace(/\b(?:19\d{2}|20\d{2})\b/g, ' ')
      .replace(/\bS\d{1,2}(?:E\d{1,3})?\b/gi, ' ')
      .replace(/\b\d{1,2}x\d{1,3}\b/g, ' ')
      .replace(/\s+-\s+\d{1,4}(?:v\d+)?\b/i, ' ')
      .replace(/[\[\](){}]/g, ' ')
      .replace(/[-_]+$/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
  );
}

function callNativeParser(title) {
  if (!ptt) return {};
  try {
    if (typeof ptt === 'function') {
      const parsed = ptt(title);
      return parsed && typeof parsed === 'object' ? parsed : {};
    }
    if (typeof ptt.parse === 'function') {
      const parsed = ptt.parse(title);
      return parsed && typeof parsed === 'object' ? parsed : {};
    }
  } catch (_) {}
  return {};
}

function parseTitle(title = '') {
  const original = safeString(title);
  if (!original) return { title: '' };
  const cached = PARSE_CACHE.get(original);
  if (cached) return cached;

  const scan = compactForScan(original);
  const parsed = callNativeParser(original);
  const signals = releaseSignals && typeof releaseSignals.extractReleaseSignals === 'function'
    ? releaseSignals.extractReleaseSignals(original)
    : {};
  const source = detectSource(parsed.source, scan);
  const resolution = normalizeResolution(parsed.resolution || parsed.quality, scan);
  const videoCodec = safeString(parsed.codec || parsed.videoCodec || parsed.video_codec).toUpperCase() || firstPatternValue(scan, VIDEO_CODEC_PATTERNS, '');
  const audioCodec = safeString(parsed.audio || parsed.audioCodec || parsed.audio_codec).toUpperCase() || firstPatternValue(scan, AUDIO_CODEC_PATTERNS, '');
  const audioChannels = detectChannels(`${original} ${scan}`);
  const hdr = detectHdr(scan, parsed);
  const { languages, subtitleLanguages } = detectLanguages(scan, parsed, signals);
  const episode = detectEpisode(scan, parsed);
  const pack = detectPackType(scan, signals);
  const flags = detectFlags(scan, signals);
  const releaseGroup = detectReleaseGroup(original, parsed);
  const cleanTitle = cleanTitleFromText(original, parsed);
  const container = firstPatternValue(original, CONTAINER_PATTERNS, '');
  const quality = detectQuality(resolution, source, scan);

  const result = {
    ...parsed,
    title: cleanTitle || normalizeSpaces(parsed.title || original),
    cleanTitle: cleanTitle || normalizeSpaces(parsed.title || original),
    year: parsed.year || scan.match(/\b(19\d{2}|20\d{2})\b/)?.[1] || null,
    season: episode.season,
    episode: episode.episode,
    absoluteEpisode: episode.absoluteEpisode,
    resolution,
    quality,
    source,
    codec: videoCodec,
    videoCodec,
    audio: [audioCodec, audioChannels].filter(Boolean).join(' '),
    audioCodec,
    channels: audioChannels,
    audioChannels,
    hdr,
    dynamicRange: hdr,
    languages,
    subtitleLanguages,
    group: releaseGroup,
    releaseGroup,
    container,
    flags,
    remux: flags.remux,
    dubbed: signals.dubbed === true || /\b(?:dubbed|doppiat[oa])\b/i.test(scan),
    complete: signals.complete === true || pack.isPack,
    anthology: signals.anthology === true || pack.isMultiSeasonPack,
    isPack: pack.isPack,
    isSeasonPack: pack.isSeasonPack,
    isMultiSeasonPack: pack.isMultiSeasonPack,
    episodeRange: pack.episodeRange,
    bitDepth: signals.bitDepth || (/(?:10|12)[-.\s]?bit/i.test(scan) ? '10bit' : null),
    threeD: signals.threeD || (flags.threeD ? '3D' : null)
  };

  return PARSE_CACHE.set(original, result);
}

function parseTitleDetails(title = '') {
  const original = safeString(title);
  if (!original) return { ...EMPTY_DETAILS };
  const cached = DETAILS_CACHE.get(original);
  if (cached) return cached;

  const parsed = parseTitle(original);
  const rawLanguages = (Array.isArray(parsed.languages) ? parsed.languages : [])
    .filter((lang) => lang !== 'multi subs')
    .map(prettyLanguageName)
    .filter(Boolean);
  const languages = (Array.isArray(parsed.languages) ? parsed.languages : [])
    .map((lang) => LANGUAGE_DISPLAY[normalizeLanguageToken(lang)] || prettyLanguageName(lang).slice(0, 3).toUpperCase())
    .filter(Boolean);
  const uniqueRawLanguages = [...new Set(rawLanguages)];
  const uniqueLanguages = [...new Set(languages)];
  const flags = parsed.flags || {};
  const source = safeString(parsed.source);
  const codec = safeString(parsed.videoCodec || parsed.codec);
  const audioCodec = safeString(parsed.audioCodec);
  const audioChannels = safeString(parsed.audioChannels || parsed.channels);
  const audio = [audioCodec, audioChannels].filter(Boolean).join(' ');
  const dynamicRange = Array.isArray(parsed.dynamicRange) ? parsed.dynamicRange : [];
  const tags = [
    source,
    flags.remux && source !== 'REMUX' ? 'REMUX' : '',
    codec,
    audio,
    ...dynamicRange,
    safeString(parsed.container),
    flags.proper ? 'PROPER' : '',
    flags.repack ? 'REPACK' : ''
  ].filter(Boolean).join(' ');

  const details = {
    quality: parsed.quality || 'SD',
    qualityLabel: [parsed.quality || 'SD', ...dynamicRange].filter(Boolean).join(' ').trim() || 'SD',
    tags,
    languages: uniqueLanguages,
    rawLanguages: uniqueRawLanguages,
    cleanTitle: parsed.cleanTitle || parsed.title || '',
    source,
    codec,
    videoCodec: codec,
    audio,
    audioCodec,
    audioChannels,
    dynamicRange,
    container: safeString(parsed.container),
    releaseGroup: safeString(parsed.releaseGroup || parsed.group),
    flags,
    season: parsed.season || null,
    episode: parsed.episode || null,
    absoluteEpisode: parsed.absoluteEpisode || null,
    isPack: parsed.isPack === true,
    isSeasonPack: parsed.isSeasonPack === true,
    isMultiSeasonPack: parsed.isMultiSeasonPack === true,
    subtitleLanguages: Array.isArray(parsed.subtitleLanguages) ? parsed.subtitleLanguages : []
  };

  return DETAILS_CACHE.set(original, details);
}

module.exports = {
  parseTitle,
  parseReleaseTitle: parseTitle,
  parseTitleDetails,
  normalizeLanguageToken,
  prettyLanguageName
};
