function basicParseTitle(title) {
  const source = String(title || '');
  const cleaned = source
    .replace(/\.(?:mkv|mp4|avi|iso|wmv|ts|flv|mov|m2ts|m4v|mpg|mpeg)$/i, '')
    .replace(/[._]+/g, ' ')
    .trim();

  const titlePart = cleaned
    .replace(/\b(?:2160p|1440p|1080p|1080i|720p|480p|x264|x265|h264|h265|hevc|av1|bluray|blu-ray|bdrip|brrip|webrip|web-dl|hdtv|ddp|aac|ac3|dts|truehd|atmos|dv|dovi|hdr10\+?|remux)\b.*$/i, '')
    .trim();

  const resolution = source.match(/\b(2160p|1440p|1080p|1080i|720p|480p)\b/i)?.[1] || '';
  const codec = source.match(/\b(x265|x264|h265|h264|hevc|av1|vvc|h266)\b/i)?.[1] || '';
  const group = source.match(/[-_]\s?([a-zA-Z0-9@.]+)$/)?.[1] || '';
  const channels = source.match(/\b([1-7][ .][01])\b/i)?.[1]?.replace(' ', '.') || '';
  const hdr = [];
  if (/\b(?:dv|dovi|dolby\s*vision)\b/i.test(source)) hdr.push('DV');
  if (/\b(?:hdr10\+|hdr10plus)\b/i.test(source)) hdr.push('HDR10+');
  else if (/\bhdr\b/i.test(source)) hdr.push('HDR');

  return {
    title: titlePart || cleaned,
    resolution,
    codec,
    group,
    channels,
    hdr,
    source: /\b(?:bluray|blu-ray|bd)\b/i.test(source)
      ? 'BluRay'
      : (/\b(?:web-dl|webrip|web|hdtv)\b/i.test(source) ? 'WEB' : ''),
    remux: /\bremux\b/i.test(source),
    audio: source.match(/\b(?:ddp|aac|ac3|dts|truehd|opus|flac|pcm|lpcm|mp3)\b/i)?.[0] || '',
  };
}

function loadTitleParser() {
  try {
    return require('parse-torrent-title');
  } catch (_error) {
    return { parse: basicParseTitle };
  }
}

const titleParser = loadTitleParser();

const UNITS = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
const LANG_SEP = ' / ';
const DEFAULT_SERVICE_TAG = 'RD';
const DEFAULT_SOURCE_LABEL = 'P2P';
const TITLE_PARSE_CACHE_LIMIT = 1200;
const EXTRACT_CACHE_LIMIT = 1200;

const TITLE_PARSE_CACHE = new Map();
const EXTRACT_CACHE = new Map();

const LANG_FLAGS = [
  { id: 'ita', flag: '🇮🇹', label: 'ITA', regex: /\b(?:ita|italian|italiano|it)\b/i, priority: 100 },
  { id: 'eng', flag: '🇬🇧', label: 'ENG', regex: /\b(?:eng|english|en)\b/i, priority: 80 },
  { id: 'jpn', flag: '🇯🇵', label: 'JPN', regex: /\b(?:jap|jpn|japanese|jp)\b/i, priority: 70 },
  { id: 'fra', flag: '🇫🇷', label: 'FRA', regex: /\b(?:fra|french|fre|fr)\b/i, priority: 60 },
  { id: 'deu', flag: '🇩🇪', label: 'DEU', regex: /\b(?:ger|german|deu|de|deutsch)\b/i, priority: 60 },
  { id: 'esp', flag: '🇪🇸', label: 'ESP', regex: /\b(?:spa|spanish|esp|es|español)\b/i, priority: 60 },
  { id: 'rus', flag: '🇷🇺', label: 'RUS', regex: /\b(?:rus|russian|ru)\b/i, priority: 50 },
  { id: 'por', flag: '🇵🇹', label: 'POR', regex: /\b(?:por|portuguese|pt|br)\b/i, priority: 50 },
  { id: 'ukr', flag: '🇺🇦', label: 'UKR', regex: /\b(?:ukr|ukrainian)\b/i, priority: 50 },
  { id: 'kor', flag: '🇰🇷', label: 'KOR', regex: /\b(?:kor|korean)\b/i, priority: 50 },
  { id: 'chi', flag: '🇨🇳', label: 'CHI', regex: /\b(?:chi|chinese|mandarin)\b/i, priority: 50 },
  { id: 'hin', flag: '🇮🇳', label: 'HIN', regex: /\b(?:hin|hindi)\b/i, priority: 40 },
];

const REGEX_EXTRA = {
  contextIt: /\b(?:ac-?3|aac|mp3|ddp|dts|truehd|audio|lingua)\W+(?:it|ita|italiano)\b/i,
  dualAudio: /\bdual[\s._-]*audio\b/i,
  multiAudio: /\b(?:multi[\s._-]*audio|multi)\b/i,
  seasonPack: /\b(?:season|stagione|complete|complete season|full season|tutta)\s*(\d{1,2})\b/i,
  completeSeries: /\b(?:complete\s+series|serie\s+completa|full\s+series)\b/i,
  quality4k: /\b(?:2160p|4k|uhd)\b/i,
  quality1440: /\b(?:1440p|2k|qhd)\b/i,
  quality1080: /\b(?:1080p|1080i|fhd)\b/i,
  quality720: /\b(?:720p|hd)\b/i,
  cam: /\b(?:cam|hdcam|ts|telesync|tc|telecine|scr|screener)\b/i,
  remux: /\bremux\b/i,
  bluray: /\b(?:bluray|blu-ray|bd(?:rip)?|brrip)\b/i,
  web: /\b(?:web[- .]?dl|webrip|web|hdtv)\b/i,
  imax: /\bimax\b/i,
  atmos: /\b(?:atmos)\b/i,
  dtsx: /\b(?:dts\s?x|dts:x)\b/i,
  dtshdma: /\b(?:dts\s?hd\s?ma|dts\s?ma)\b/i,
  dtshdhra: /\b(?:dts\s?hd\s?hra)\b/i,
  dtshd: /\b(?:dts\s?hd)\b/i,
  truehd: /\b(?:truehd|thd)\b/i,
  dts: /\b(?:dts)\b/i,
  ddp: /\b(?:ddp|eac3|e\s?ac3|dd\+|ddplus|digital\s?plus)\b/i,
  ac3: /\b(?:ac3|ac\s?3|dd|dolby\s?digital)\b/i,
  aac: /\b(?:aac)\b/i,
  opus: /\b(?:opus)\b/i,
  flac: /\b(?:flac)\b/i,
  lpcm: /\b(?:pcm|lpcm)\b/i,
  mp3: /\b(?:mp3)\b/i,
  dv: /\b(?:dv|dovi|dolby\s*vision)\b/i,
  hdr10plus: /\b(?:hdr10\+|hdr10plus)\b/i,
  hdr: /\b(?:hdr|hdr10|uhd\s*hdr)\b/i,
  channels: /\b([1-7][ .][01])\b/i,
  providerAmazon: /\bAMZN\b/i,
  providerNetflix: /\bNF\b/i,
  providerDisney: /\bDSNP\b/i,
  providerHbo: /\bHMAX\b/i,
  providerApple: /\bAPTV\b/i,
  providerHulu: /\bHULU\b/i,
  providerPrime: /\bPRME\b/i,
  providerParamount: /\bPMTP\b/i,
  providerPeacock: /\bPCKK\b/i,
  providerCrunchyroll: /\bCRTC\b/i,
  providerAnimePlex: /\bANPX\b/i,
  providerStarz: /\bSTZ\b/i,
  providerDiscovery: /\bDSCV\b/i,
};

const QUALITY_ICONS = {
  '8k': '🪐',
  '4k': '🔥',
  '2160p': '🔥',
  '1440p': '🖥️',
  '1080p': '👑',
  '720p': '⚡',
  '480p': '📼',
  dvd: '💿',
  sd: '📼',
  cam: '💩',
  scr: '👀',
};

const GROUP_BLACKLIST = new Set([
  'mkv', 'mp4', 'avi', 'wmv', 'iso', 'flv', 'mov', 'ts', 'm2ts',
  'h264', 'h265', 'x264', 'x265', 'hevc', 'av1', 'divx', 'xvid', 'mpeg', 'avc', 'vp9', 'vvc',
  '4k', '2160p', '1080p', '1080i', '720p', '576p', '480p', 'sd', 'hd', 'uhd', 'fhd', 'qhd',
  'aac', 'ac3', 'mp3', 'dts', 'dtshd', 'dts-ma', 'truehd', 'atmos', 'ddp', 'dd', 'flac', 'opus', 'pcm', 'stereo', '5.1', '7.1', '2.0', 'dual', 'audio',
  'bluray', 'bd', 'bdrip', 'brrip', 'web', 'web-dl', 'webrip', 'hdtv', 'tvrip', 'dvd', 'dvdrip', 'scr', 'screener', 'cam', 'tc', 'telesync', 'remux',
  'ita', 'eng', 'jpn', 'jpa', 'chn', 'kor', 'rus', 'spa', 'fre', 'ger', 'fra', 'deu', 'esp', 'por', 'multi', 'multisub', 'sub', 'dub', 'ita-eng', 'eng-ita',
  'repack', 'proper', 'internal', 'readnfo', 'extended', 'cut', 'director', 'unrated', 'complete', 'season', 'episode', 'series', 'ep', 's01', 'e01'
]);

const SERVICE_ICON_BY_TAG = {
  RD: '🐬',
  TB: '⚓',
};

const DISPLAY_SOURCE_MAP = [
  { regex: /1337/i, value: '1337x' },
  { regex: /corsaro/i, value: 'ilCorSaRoNeRo' },
  { regex: /knaben/i, value: 'Knaben' },
  { regex: /comet|stremthru/i, value: 'StremThru' },
  { regex: /nyaa|erai-raws|subsplease|horriblesubs|judas|moozzi2|ember/i, value: 'Nyaa' },
  { regex: /yts|yify/i, value: 'YTS' },
  { regex: /eztv/i, value: 'EZTV' },
  { regex: /rarbg/i, value: 'RARBG' },
];

const PROVIDER_LABELS = [
  [REGEX_EXTRA.providerAmazon, 'Amazon'],
  [REGEX_EXTRA.providerNetflix, 'Netflix'],
  [REGEX_EXTRA.providerDisney, 'Disney+'],
  [REGEX_EXTRA.providerHbo, 'HBO Max'],
  [REGEX_EXTRA.providerApple, 'Apple TV+'],
  [REGEX_EXTRA.providerHulu, 'Hulu'],
  [REGEX_EXTRA.providerPrime, 'Prime'],
  [REGEX_EXTRA.providerParamount, 'Paramount+'],
  [REGEX_EXTRA.providerPeacock, 'Peacock'],
  [REGEX_EXTRA.providerCrunchyroll, 'Crunchyroll'],
  [REGEX_EXTRA.providerAnimePlex, 'Anime Plex'],
  [REGEX_EXTRA.providerStarz, 'Starz'],
  [REGEX_EXTRA.providerDiscovery, 'Discovery+'],
];

const STYLIZED_MAPS = {
  bold: {
    nums: { '0': '𝟬', '1': '𝟭', '2': '𝟮', '3': '𝟯', '4': '𝟰', '5': '𝟱', '6': '𝟲', '7': '𝟳', '8': '𝟴', '9': '𝟵' },
    chars: {
      A: '𝗔', B: '𝗕', C: '𝗖', D: '𝗗', E: '𝗘', F: '𝗙', G: '𝗚', H: '𝗛', I: '𝗜', J: '𝗝', K: '𝗞', L: '𝗟', M: '𝗠', N: '𝗡', O: '𝗢', P: '𝗣', Q: '𝗤', R: '𝗥', S: '𝗦', T: '𝗧', U: '𝗨', V: '𝗩', W: '𝗪', X: '𝗫', Y: '𝗬', Z: '𝗭',
      a: '𝗮', b: '𝗯', c: '𝗰', d: '𝗱', e: '𝗲', f: '𝗳', g: '𝗴', h: '𝗵', i: '𝗶', j: '𝗷', k: '𝗸', l: '𝗹', m: '𝗺', n: '𝗻', o: '𝗼', p: '𝗽', q: '𝗾', r: '𝗿', s: '𝘀', t: '𝘁', u: '𝘂', v: '𝘃', w: '𝘄', x: '𝘅', y: '𝘆', z: '𝘇',
    },
  },
  small: {
    nums: { '0': '0', '1': '1', '2': '2', '3': '3', '4': '4', '5': '5', '6': '6', '7': '7', '8': '8', '9': '9' },
    chars: {
      A: 'ᴀ', B: 'ʙ', C: 'ᴄ', D: 'ᴅ', E: 'ᴇ', F: 'ꜰ', G: 'ɢ', H: 'ʜ', I: 'ɪ', J: 'ᴊ', K: 'ᴋ', L: 'ʟ', M: 'ᴍ', N: 'ɴ', O: 'ᴏ', P: 'ᴘ', Q: 'ǫ', R: 'ʀ', S: 'ꜱ', T: 'ᴛ', U: 'ᴜ', V: 'ᴠ', W: 'ᴡ', X: 'x', Y: 'ʏ', Z: 'ᴢ',
      a: 'ᴀ', b: 'ʙ', c: 'ᴄ', d: 'ᴅ', e: 'ᴇ', f: 'ꜰ', g: 'ɢ', h: 'ʜ', i: 'ɪ', j: 'ᴊ', k: 'ᴋ', l: 'ʟ', m: 'ᴍ', n: 'ɴ', o: 'ᴏ', p: 'ᴘ', q: 'ǫ', r: 'ʀ', s: 'ꜱ', t: 'ᴛ', u: 'ᴜ', v: 'ᴠ', w: 'ᴡ', x: 'x', y: 'ʏ', z: 'ᴢ',
    },
  },
};

function getCached(map, key) {
  if (!map.has(key)) return null;
  const value = map.get(key);
  map.delete(key);
  map.set(key, value);
  return value;
}

function setCached(map, key, value, limit) {
  if (map.has(key)) map.delete(key);
  map.set(key, value);
  if (map.size > limit) {
    const oldestKey = map.keys().next().value;
    map.delete(oldestKey);
  }
  return value;
}

function safeString(value) {
  if (value === null || value === undefined) return '';
  return String(value);
}

function normalizeSpaces(value) {
  return safeString(value).replace(/[\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function stripExtension(value) {
  return safeString(value).replace(/\.(?:mkv|mp4|avi|iso|wmv|ts|flv|mov|m2ts|m4v|mpg|mpeg)$/i, '');
}

function compactTitleForRegex(value) {
  return safeString(value).toUpperCase().replace(/[.\-_[\]()]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function uniqueBy(items, getKey) {
  const seen = new Set();
  const results = [];
  for (const item of items) {
    const key = getKey(item);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    results.push(item);
  }
  return results;
}

function resolveFormatterLangMode(config = {}) {
  const explicit = safeString(config?.filters?.language || config?.language).toLowerCase().trim();
  if (explicit === 'eng' || explicit === 'ita' || explicit === 'all') return explicit;
  if (explicit === 'ita-eng') return 'all';
  if (config?.filters?.allowEng === true || config?.allowEng === true) return 'all';
  return 'ita';
}

function getDisplayLanguageForMode(lang, config = {}) {
  const langMode = resolveFormatterLangMode(config);
  if (langMode === 'eng') return '🇬🇧';
  const normalized = safeString(lang).trim();
  return normalized || '🇬🇧';
}

function normalizeServiceTag(serviceTag) {
  const normalized = safeString(serviceTag).toUpperCase().trim();
  return normalized || DEFAULT_SERVICE_TAG;
}

function isDebridService(serviceTag) {
  return ['RD', 'TB'].includes(normalizeServiceTag(serviceTag));
}

function normalizeCacheState(cacheState, serviceTag) {
  const normalized = safeString(cacheState).toLowerCase().trim();
  if (normalized === 'cached') return 'cached';
  if (normalized === 'likely_cached') return 'likely_cached';
  if (normalized === 'uncached') return 'likely_uncached';
  if (normalized === 'likely_uncached') return 'likely_uncached';
  if (normalized === 'uncached_terminal') return 'uncached_terminal';
  if (normalized === 'probing') return 'probing';
  if (normalized === 'unknown') return 'unknown';
  if (!isDebridService(serviceTag)) return 'unknown';
  return 'unknown';
}

function getCacheIcon(cacheState) {
  if (cacheState === 'cached' || cacheState === 'likely_cached') return '⚡';
  if (cacheState === 'uncached_terminal') return '☁️';
  if (cacheState === 'probing') return '🔄';
  if (cacheState === 'likely_uncached') return '⏳';
  return '⏳';
}

function getStatusIcon(cacheState, serviceTag) {
  if (normalizeServiceTag(serviceTag) === 'WEB') return '🌊';
  return getCacheIcon(cacheState);
}

function deterministicHash(value) {
  const text = safeString(value);
  let hash = 0;
  for (let i = 0; i < text.length; i += 1) {
    hash = text.charCodeAt(i) + ((hash << 5) - hash);
    hash |= 0;
  }
  return Math.abs(hash);
}

function formatBytes(bytes) {
  const value = Number(bytes);
  if (!Number.isFinite(value) || value <= 0) return '0 B';
  const unitIndex = Math.min(Math.floor(Math.log(value) / Math.log(1024)), UNITS.length - 1);
  const size = value / Math.pow(1024, unitIndex);
  const decimals = unitIndex === 0 ? 0 : 2;
  return `${size.toFixed(decimals)} ${UNITS[unitIndex]}`;
}

function pseudoSizeFromTitle(title, quality) {
  const seed = deterministicHash(title);
  let gb = 1;
  if (/4k|2160/i.test(quality)) gb = 12 + (seed % 1000) / 100;
  else if (/1440/i.test(quality)) gb = 5 + (seed % 500) / 100;
  else if (/1080/i.test(quality)) gb = 1.8 + (seed % 270) / 100;
  else if (/720/i.test(quality)) gb = 0.9 + (seed % 180) / 100;
  else gb = 0.6 + (seed % 80) / 100;
  return `${gb.toFixed(2)} GB`;
}

function parseTitleCached(title) {
  const key = normalizeSpaces(title);
  const cached = getCached(TITLE_PARSE_CACHE, key);
  if (cached) return cached;

  let parsed;
  try {
    parsed = titleParser.parse(key);
  } catch (_error) {
    parsed = { title: key };
  }

  if (!parsed || typeof parsed !== 'object') parsed = { title: key };
  return setCached(TITLE_PARSE_CACHE, key, parsed, TITLE_PARSE_CACHE_LIMIT);
}

function cleanFilename(filename) {
  const original = normalizeSpaces(filename);
  if (!original) return '';

  let clean = original;
  const parsed = parseTitleCached(original);
  if (parsed && parsed.title) clean = normalizeSpaces(parsed.title);

  if (!clean) clean = normalizeSpaces(stripExtension(original).replace(/[._]+/g, ' '));

  if (/Fratelli demolitori/i.test(clean) && /The Wrecking Crew/i.test(clean)) {
    return 'Fratelli demolitori';
  }

  if (/\s+-\s+/.test(clean)) {
    const [firstChunk] = clean.split(/\s+-\s+/);
    if (firstChunk && firstChunk.trim().length > 2) clean = firstChunk.trim();
  }

  const words = clean.split(/\s+/).filter(Boolean);
  if (words.length >= 2 && words.length % 2 === 0) {
    const mid = words.length / 2;
    const left = words.slice(0, mid).join(' ');
    const right = words.slice(mid).join(' ');
    if (left.toLowerCase() === right.toLowerCase()) return left;
  }

  return clean.trim();
}

function getEpisodeTag(filename, config = {}) {
  const explicitSeason = Number(config.season);
  const explicitEpisode = Number(config.episode);
  if (Number.isInteger(explicitSeason) && explicitSeason > 0 && Number.isInteger(explicitEpisode) && explicitEpisode > 0) {
    return `🍿 S${String(explicitSeason).padStart(2, '0')}E${String(explicitEpisode).padStart(2, '0')}`;
  }

  const text = safeString(filename).toLowerCase();
  if (!text) return '';

  const multiEpisode = text.match(/s(\d{1,2})[ex](\d{1,3})\s*-\s*(?:[ex]?(\d{1,3}))/i) || text.match(/(\d{1,2})x(\d{1,3})\s*-\s*(\d{1,3})/i);
  if (multiEpisode) {
    const season = multiEpisode[1].padStart(2, '0');
    const start = multiEpisode[2].padStart(2, '0');
    const end = multiEpisode[3].padStart(2, '0');
    return `🍿 S${season} E${start}-${end}`;
  }

  const animeBatch = text.match(/(?:ep|eps|episode|^|\s)\[?(\d{1,3})\s*-\s*(\d{1,3})\]?(?:\s|$)/i);
  if (animeBatch && Number(animeBatch[1]) < 1900) {
    return `🍿 Ep ${animeBatch[1].padStart(2, '0')}-${animeBatch[2].padStart(2, '0')}`;
  }

  const sxe = text.match(/s(\d{1,2})[ex](\d{1,3})/i);
  if (sxe) return `🍿 S${sxe[1].padStart(2, '0')}E${sxe[2].padStart(2, '0')}`;

  const classic = text.match(/(\d{1,2})x(\d{1,3})/i);
  if (classic) return `🍿 S${classic[1].padStart(2, '0')}E${classic[2].padStart(2, '0')}`;

  const seasonPack = text.match(REGEX_EXTRA.seasonPack);
  if (seasonPack) return `🍿 S${seasonPack[1].padStart(2, '0')}`;

  const seasonOnly = text.match(/s(\d{1,2})\b/i);
  if (seasonOnly) return `🍿 S${seasonOnly[1].padStart(2, '0')}`;

  if (REGEX_EXTRA.completeSeries.test(text)) return '🍿 Complete Series';
  return '';
}

function toStylized(text, type = 'std') {
  if (!text) return '';
  const input = safeString(text);
  if (type === 'spaced') {
    return input.split('').map((char) => {
      const map = STYLIZED_MAPS.bold;
      const converted = /[0-9]/.test(char) ? map.nums[char] : map.chars[char];
      return `${converted || char} `;
    }).join('').trim();
  }

  const map = STYLIZED_MAPS[type] || STYLIZED_MAPS.bold;
  return input.split('').map((char) => {
    if (/[0-9]/.test(char)) return map.nums[char] || char;
    return map.chars[char] || char;
  }).join('');
}

function normalizeReleaseGroup(group) {
  const normalized = normalizeSpaces(group).replace(/^[-_\[\].\s]+|[-_\[\].\s]+$/g, '');
  if (!normalized) return '';
  const lower = normalized.toLowerCase();
  if (normalized.length < 2 || normalized.length > 25) return '';
  if (GROUP_BLACKLIST.has(lower)) return '';
  if (/^\d+$/.test(normalized)) return '';
  return normalized;
}

function deriveReleaseGroup(title, info) {
  const cleanTitle = normalizeSpaces(stripExtension(title));

  const candidates = [
    safeString(title).match(/^\[([a-zA-Z0-9_\-.\s]+)\]/)?.[1],
    info.group,
    cleanTitle.match(/[-_]\s?([a-zA-Z0-9@.]+)$/)?.[1],
    cleanTitle.match(/\[([a-zA-Z0-9_\-.\s]+)\]$/)?.[1],
  ].filter(Boolean);

  const tokens = cleanTitle.split(/[\s.]+/).filter(Boolean);
  if (tokens.length) candidates.push(tokens[tokens.length - 1]);

  let fallback = '';
  for (const candidate of candidates) {
    const normalized = normalizeReleaseGroup(candidate);
    if (normalized) {
      if (/^[a-f0-9]{8}$/i.test(normalized)) {
        if (!fallback) fallback = normalized;
        continue;
      }
      return normalized;
    }
  }
  return fallback;
}

function deriveQuality(info, upperTitle) {
  let quality = 'SD';
  let qDetails = 'SD';

  if (info.resolution) {
    const res = safeString(info.resolution).toUpperCase();
    if (res === '2160P') quality = '4K';
    else if (res === '4320P') quality = '8K';
    else quality = res;
    qDetails = quality;
  } else if (REGEX_EXTRA.quality4k.test(upperTitle)) {
    quality = '4K';
    qDetails = '4K';
  } else if (REGEX_EXTRA.quality1440.test(upperTitle)) {
    quality = '1440p';
    qDetails = '1440p';
  } else if (REGEX_EXTRA.quality1080.test(upperTitle)) {
    quality = '1080p';
    qDetails = '1080p';
  } else if (REGEX_EXTRA.quality720.test(upperTitle)) {
    quality = '720p';
    qDetails = '720p';
  }

  const source = safeString(info.source);
  if (REGEX_EXTRA.cam.test(upperTitle) || REGEX_EXTRA.cam.test(source)) {
    quality = 'CAM';
    qDetails = 'CAM';
  }

  const qIcon = QUALITY_ICONS[quality.toLowerCase()] || (quality.includes('4K') ? '🔥' : '📺');
  return { quality, qDetails, qIcon };
}

function deriveVideoTags(info, upperTitle) {
  const tags = [];
  const cleanTags = [];

  const sourceText = `${safeString(info.source)} ${upperTitle}`;
  const addTag = (icon, label, cleanLabel = label) => {
    if (!cleanLabel) return;
    if (cleanTags.includes(cleanLabel)) return;
    tags.push(`${icon} ${toStylized(label)}`);
    cleanTags.push(cleanLabel);
  };

  const isRemux = Boolean(info.remux) || REGEX_EXTRA.remux.test(sourceText);
  const isBluRay = REGEX_EXTRA.bluray.test(sourceText);
  const isWeb = REGEX_EXTRA.web.test(sourceText);

  if (isRemux) addTag('💎', 'REMUX', 'Remux');
  else if (isBluRay) addTag('💿', 'BluRay', 'BluRay');
  else if (isWeb) addTag('☁️', 'WEB', 'WEB');
  else addTag('🎞️', 'RIP', 'Rip');

  if (REGEX_EXTRA.imax.test(sourceText)) addTag('📏', 'IMAX', 'IMAX');

  if (info.codec) {
    const codec = safeString(info.codec).toUpperCase();
    let icon = '📼';
    let label = codec;
    if (/AV1/.test(codec)) {
      icon = '🪐';
      label = 'AV1';
    } else if (/VVC|H266/.test(codec)) {
      icon = '⚡';
      label = 'VVC';
    } else if (/265|HEVC/.test(codec)) {
      icon = '⚙️';
    }
    addTag(icon, label, label);
  }

  const hdrText = `${upperTitle} ${safeString(info.hdr)}`;
  const isDV = REGEX_EXTRA.dv.test(hdrText);
  const isHDR10Plus = REGEX_EXTRA.hdr10plus.test(hdrText);
  const isHDR = REGEX_EXTRA.hdr.test(hdrText);

  if (isDV && (isHDR || isHDR10Plus)) addTag('👁️', 'DV+HDR', 'DV+HDR');
  else if (isDV) addTag('👁️', 'DV', 'DV');
  else if (isHDR10Plus) addTag('🔥', 'HDR10+', 'HDR10+');
  else if (isHDR) addTag('🔥', 'HDR', 'HDR');

  return { videoTags: tags, cleanTags };
}

function deriveLanguages(title, source) {
  const titleText = safeString(title);
  const sourceText = safeString(source);
  const text = `${titleText} ${sourceText}`;
  const lowerText = text.toLowerCase();

  const animeScene = /nyaa|erai-raws|subsplease|horriblesubs|judas|moozzi2|ember/i.test(text);
  const animeItalianJapaneseDefault = /(?:nyaa|erai-raws)/i.test(text);
  const animeEnglishDefault = /subsplease|horriblesubs|judas|moozzi2|ember/i.test(text);

  const italianHint = /(?:ita|italian|italiano|vostit|sub[-. _]?ita|softsub[-. _]?ita|multi[-. _]?ita)/i.test(text)
    || REGEX_EXTRA.contextIt.test(text);
  const englishHint = /(?:eng|english|sub[-. _]?eng|softsub[-. _]?eng)/i.test(text);
  const japaneseHint = /(?:jap|jpn|japanese|jp|raw)/i.test(text);
  const multiHint = REGEX_EXTRA.multiAudio.test(lowerText) || REGEX_EXTRA.dualAudio.test(lowerText);

  const matches = LANG_FLAGS.filter((lang) => lang.regex.test(text));
  const unique = uniqueBy(matches.sort((a, b) => b.priority - a.priority), (item) => item.id);

  if (animeItalianJapaneseDefault) {
    if (englishHint && !italianHint && !japaneseHint && !multiHint) return '🇬🇧';
    return ['🇮🇹', '🇯🇵'].join(LANG_SEP);
  }

  if (animeScene) {
    const flags = [];
    if (italianHint) flags.push('🇮🇹');

    const explicitJapanese = unique.some((item) => item.id === 'jpn') || japaneseHint;
    const explicitEnglish = unique.some((item) => item.id === 'eng') || englishHint;

    if (explicitJapanese) flags.push('🇯🇵');
    if (explicitEnglish && !italianHint && !explicitJapanese) flags.push('🇬🇧');

    if (!flags.length) flags.push(animeEnglishDefault ? '🇬🇧' : '🇯🇵');

    const deduped = uniqueBy(flags, (flag) => flag);
    if (deduped.length) return deduped.join(LANG_SEP);
  }

  if (unique.length === 1) return unique[0].flag;
  if (unique.length > 1 && unique.length <= 3) return unique.map((item) => item.flag).join(LANG_SEP);
  if (unique.length > 3) return `${unique[0].flag}${LANG_SEP}🌐`;

  if (multiHint) return '🌐';
  if (italianHint || /corsaro/i.test(sourceText)) return '🇮🇹';

  return '🇬🇧';
}

function deriveAudio(info, upperTitle, quality, cleanTags) {
  let audioChannels = '';
  const channelMatch = upperTitle.match(REGEX_EXTRA.channels);
  if (channelMatch) audioChannels = channelMatch[1].replace(' ', '.');
  else if (info.channels) audioChannels = safeString(info.channels);

  if (audioChannels.includes('7.1')) audioChannels = '7.1';
  else if (audioChannels.includes('5.1')) audioChannels = '5.1';
  else if (audioChannels.includes('2.0')) audioChannels = '2.0';
  else if (audioChannels.includes('1.0')) audioChannels = '1.0';

  let foundCodec = '';
  if (REGEX_EXTRA.atmos.test(upperTitle)) foundCodec = 'ATMOS';
  else if (REGEX_EXTRA.dtsx.test(upperTitle)) foundCodec = 'DTS:X';
  else if (REGEX_EXTRA.dtshdma.test(upperTitle)) foundCodec = 'DTS-HD MA';
  else if (REGEX_EXTRA.dtshdhra.test(upperTitle)) foundCodec = 'DTS-HD HRA';
  else if (REGEX_EXTRA.dtshd.test(upperTitle)) foundCodec = 'DTS-HD';
  else if (REGEX_EXTRA.truehd.test(upperTitle)) foundCodec = 'TrueHD';
  else if (REGEX_EXTRA.dts.test(upperTitle)) foundCodec = 'DTS';
  else if (REGEX_EXTRA.ddp.test(upperTitle)) foundCodec = 'DDP';
  else if (REGEX_EXTRA.ac3.test(upperTitle)) foundCodec = 'AC3';
  else if (REGEX_EXTRA.aac.test(upperTitle)) foundCodec = 'AAC';
  else if (REGEX_EXTRA.opus.test(upperTitle)) foundCodec = 'OPUS';
  else if (REGEX_EXTRA.flac.test(upperTitle)) foundCodec = 'FLAC';
  else if (REGEX_EXTRA.lpcm.test(upperTitle)) foundCodec = 'LPCM';
  else if (REGEX_EXTRA.mp3.test(upperTitle)) foundCodec = 'MP3';
  else if (info.audio) foundCodec = safeString(info.audio).toUpperCase();

  if (!foundCodec) {
    if (cleanTags.includes('WEB')) foundCodec = 'AAC';
    else if (cleanTags.includes('BluRay') || /4k|1080/i.test(quality)) foundCodec = 'AC3';
  }

  let audioTag = '';
  if (foundCodec === 'ATMOS') {
    if (REGEX_EXTRA.truehd.test(upperTitle)) audioTag = 'Atmos TrueHD';
    else if (REGEX_EXTRA.ddp.test(upperTitle)) audioTag = 'Atmos DDP';
    else audioTag = 'Dolby Atmos';
  } else if (foundCodec === 'DDP') audioTag = 'Dolby DDP';
  else if (foundCodec === 'AC3') audioTag = 'Dolby Digital';
  else if (foundCodec) audioTag = foundCodec;
  else if (audioChannels.includes('5.1') || audioChannels.includes('7.1')) audioTag = 'Surround';
  else if (audioChannels.includes('2.0')) audioTag = 'Stereo';
  else audioTag = 'AAC';

  return { codec: foundCodec || safeString(info.codec).toUpperCase(), audioTag, audioChannels };
}

function extractProviderLabel(fileTitle) {
  const upper = safeString(fileTitle).toUpperCase();
  for (const [regex, label] of PROVIDER_LABELS) {
    if (regex.test(upper)) return label;
  }
  return '';
}

function normalizeDisplaySource(source) {
  const raw = normalizeSpaces(source);
  if (!raw) return '✨ MediaFusion';
  for (const entry of DISPLAY_SOURCE_MAP) {
    if (entry.regex.test(raw)) return entry.value;
  }
  const normalized = raw.replace(/MediaFusion|Torrentio|Fallback/gi, '').trim();
  return normalized || '✨ MediaFusion';
}

function stripEpisodeFromCleanName(cleanName) {
  return normalizeSpaces(cleanName.replace(/\s+(?:S\d+(?:E\d+)?\b.*|\d+x\d+\b.*|(?:Season|Stagione)\s*\d+\b.*)$/i, ''));
}

function buildBingeGroup(quality, rawInfo, serviceTag, infoHash) {
  const hdrPart = Array.isArray(rawInfo?.hdr)
    ? rawInfo.hdr.join('')
    : safeString(rawInfo?.hdr || '');
  return `Leviathan|${quality}|${hdrPart}|${serviceTag}|${infoHash || 'no-hash'}`;
}

function createStyleParams(fileTitle, source, size, seeders, serviceTag, config, infoHash, isLazy, isPackItem, cacheState = 'unknown') {
  const extracted = extractStreamInfo(fileTitle, source, config);
  const displayLang = getDisplayLanguageForMode(extracted.lang, config);
  const normalizedServiceTag = normalizeServiceTag(serviceTag);
  const normalizedCacheState = normalizeCacheState(cacheState, normalizedServiceTag);
  const cacheIcon = getStatusIcon(normalizedCacheState, normalizedServiceTag);
  const serviceIconTitle = SERVICE_ICON_BY_TAG[normalizedServiceTag] || '🦈';
  const qIcon = SERVICE_ICON_BY_TAG[normalizedServiceTag] || extracted.qIcon;
  const numericSize = Number(size) || 0;
  const sizeString = numericSize > 0 ? formatBytes(numericSize) : 'Unknown';
  const cleanedName = stripEpisodeFromCleanName(extracted.cleanName);
  const explicitType = safeString(config?.mediaType || config?.type || config?.stremioType).toLowerCase();
  const explicitMovieContext = config?.forceMovie === true || config?.isSeries === false || explicitType === 'movie' || explicitType === 'film';
  const hasSeriesContext = !explicitMovieContext && (
    config?.isSeries === true ||
    explicitType === 'series' ||
    explicitType === 'anime' ||
    Number(config?.season || 0) > 0 ||
    Number(config?.episode || 0) > 0
  );
  const baseEpTag = hasSeriesContext ? getEpisodeTag(fileTitle, config) : '';
  const safePackItem = Boolean(isPackItem && hasSeriesContext);
  const styledPack = toStylized('Season Pack', 'small');
  const epTag = safePackItem
    ? (baseEpTag ? `${baseEpTag}  ✦  📦 ${styledPack}` : '📦 ꜱᴇᴀꜱᴏɴ ᴘᴀᴄᴋ')
    : baseEpTag;
  const displaySource = normalizeDisplaySource(source || DEFAULT_SOURCE_LABEL);
  const seedersValue = seeders === null || seeders === undefined || Number.isNaN(Number(seeders)) ? null : Number(seeders);
  const seedersStr = seedersValue !== null ? `👥 ${seedersValue}` : '';
  const isCached = normalizedCacheState === 'cached';

  const baseParams = {
    ...extracted,
    rawLang: extracted.lang,
    lang: displayLang,
    fileTitle: safeString(fileTitle),
    source: safeString(source) || DEFAULT_SOURCE_LABEL,
    displaySource,
    size: numericSize,
    sizeString,
    sizeStr: `🧲 ${sizeString}`,
    seeders: seedersValue,
    seedersStr,
    qIcon,
    serviceTag: normalizedServiceTag,
    serviceIconTitle,
    cleanName: cleanedName,
    epTag,
    sourceLine: `${serviceIconTitle} [${normalizedServiceTag}] ${displaySource}`,
    audioInfo: [extracted.audioTag, extracted.audioChannels].filter(Boolean).join(' ┃ '),
    bingeGroup: buildBingeGroup(extracted.quality, extracted.rawInfo, normalizedServiceTag, infoHash),
    providerLabel: extractProviderLabel(fileTitle),
    isLazy: Boolean(isLazy),
    isPackItem: safePackItem,
    cacheState: normalizedCacheState,
    cacheIcon,
    isCached,
    compactLang: compactLanguageLabel(displayLang),
    primarySourceTag: getPrimarySourceTag(extracted.cleanTags),
    config,
  };

  const visualScore = computeVisualScore(baseParams);
  return {
    ...baseParams,
    visualScore,
    scoreTier: scoreTier(visualScore),
    scoreBadge: scoreBadge(visualScore),
    premiumTags: buildPremiumTags(baseParams, Number(config?.premiumTagLimit) > 0 ? Number(config.premiumTagLimit) : 4),
    headlineParts: buildHeadlineParts(baseParams),
  };
}

function joinNonEmpty(parts, separator = ' · ') {
  return parts.filter((value) => Boolean(normalizeSpaces(value))).join(separator);
}

function removeEmoji(text) {
  return safeString(text).replace(/[\u{1F300}-\u{1F6FF}\u{1F900}-\u{1F9FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}]/gu, '').trim();
}

function compactLanguageLabel(lang) {
  const original = safeString(lang).trim();
  if (!original) return '🇬🇧';

  const existingFlags = uniqueBy(original.match(/[\u{1F1E6}-\u{1F1FF}]{2}/gu) || [], (flag) => flag);
  if (existingFlags.length === 1) return existingFlags[0];
  if (existingFlags.length > 1 && existingFlags.length <= 3) return existingFlags.join(LANG_SEP);
  if (existingFlags.length > 3) return `${existingFlags[0]}${LANG_SEP}🌐`;

  const text = removeEmoji(original).replace(/\s*\/\s*/g, '/').replace(/\s+/g, ' ').trim();
  const matches = LANG_FLAGS.filter((entry) => entry.regex.test(text));
  const unique = uniqueBy(matches.sort((a, b) => b.priority - a.priority), (item) => item.id);

  if (/\b(?:ita|italian|italiano|vostit|sub[-. _]?ita|softsub[-. _]?ita)\b/i.test(text) && /\b(?:jap|jpn|japanese|jp|raw)\b/i.test(text)) {
    return ['🇮🇹', '🇯🇵'].join(LANG_SEP);
  }

  if (unique.length === 1) return unique[0].flag;
  if (unique.length > 1 && unique.length <= 3) return unique.map((item) => item.flag).join(LANG_SEP);
  if (unique.length > 3) return `${unique[0].flag}${LANG_SEP}🌐`;

  if (/multi|dual/i.test(text)) return '🌐';
  if (/ita|italian|italiano/i.test(text)) return '🇮🇹';
  if (/jap|jpn|japanese|jp|vostit|sub[-. _]?ita|softsub[-. _]?ita|raw/i.test(text)) return '🇯🇵';
  return '🇬🇧';
}

function getPrimarySourceTag(cleanTags) {
  if (cleanTags.includes('Remux')) return 'Remux';
  if (cleanTags.includes('BluRay')) return 'BluRay';
  if (cleanTags.includes('WEB')) return 'WEB';
  if (cleanTags.includes('Rip')) return 'Rip';
  return '';
}

function qualityScore(quality) {
  const normalized = safeString(quality).toUpperCase();
  if (normalized === '8K') return 100;
  if (normalized === '4K' || normalized === '2160P') return 92;
  if (normalized === '1440P') return 78;
  if (normalized === '1080P') return 66;
  if (normalized === '720P') return 48;
  if (normalized === 'CAM') return 8;
  if (normalized === 'SD') return 18;
  return 28;
}

function audioScore(audioTag, channels) {
  const text = `${safeString(audioTag)} ${safeString(channels)}`.toUpperCase();
  let score = 0;
  if (/ATMOS TRUEHD/.test(text)) score += 24;
  else if (/ATMOS DDP|DOLBY ATMOS/.test(text)) score += 20;
  else if (/DTS:X/.test(text)) score += 19;
  else if (/DTS-HD MA/.test(text)) score += 17;
  else if (/TRUEHD/.test(text)) score += 16;
  else if (/DTS-HD HRA|DTS-HD/.test(text)) score += 14;
  else if (/DTS/.test(text)) score += 12;
  else if (/DDP/.test(text)) score += 10;
  else if (/DOLBY DIGITAL|AC3/.test(text)) score += 8;
  else if (/AAC|STEREO/.test(text)) score += 5;

  if (/7\.1/.test(text)) score += 8;
  else if (/5\.1/.test(text)) score += 5;
  else if (/2\.0/.test(text)) score += 2;

  return score;
}

function visualTagScore(cleanTags) {
  const tags = new Set((cleanTags || []).map((tag) => safeString(tag)));
  let score = 0;
  if (tags.has('Remux')) score += 24;
  else if (tags.has('BluRay')) score += 18;
  else if (tags.has('WEB')) score += 12;
  else if (tags.has('Rip')) score += 6;

  if (tags.has('DV+HDR')) score += 18;
  else if (tags.has('DV')) score += 14;
  else if (tags.has('HDR10+')) score += 12;
  else if (tags.has('HDR')) score += 9;

  if (tags.has('IMAX')) score += 4;
  if (tags.has('AV1')) score += 4;
  if (tags.has('VVC')) score += 5;
  return score;
}

function providerScore(displaySource) {
  const src = safeString(displaySource).toLowerCase();
  if (/stremthru|torrentio|mediafusion/.test(src)) return 4;
  if (/1337x|knaben|corsaro/.test(src)) return 3;
  return 2;
}

function sizeScore(sizeBytes, quality) {
  const size = Number(sizeBytes) || 0;
  if (size <= 0) return 0;
  const gb = size / (1024 ** 3);
  if (/4k|2160/i.test(quality)) {
    if (gb >= 40) return 12;
    if (gb >= 20) return 8;
    if (gb >= 8) return 5;
    return 1;
  }
  if (/1080/i.test(quality)) {
    if (gb >= 20) return 10;
    if (gb >= 8) return 7;
    if (gb >= 3) return 4;
    return 1;
  }
  if (/720/i.test(quality)) {
    if (gb >= 4) return 6;
    if (gb >= 2) return 4;
    return 1;
  }
  return gb >= 1 ? 2 : 0;
}

function seederScore(seeders) {
  const value = Number(seeders);
  if (!Number.isFinite(value) || value <= 0) return 0;
  if (value >= 200) return 12;
  if (value >= 100) return 10;
  if (value >= 50) return 8;
  if (value >= 20) return 6;
  if (value >= 10) return 4;
  return 2;
}

function computeVisualScore(params) {
  let score = 0;
  score += qualityScore(params.quality);
  score += visualTagScore(params.cleanTags);
  score += audioScore(params.audioTag, params.audioChannels);
  score += providerScore(params.displaySource);
  score += sizeScore(params.size, params.quality);
  score += seederScore(params.seeders);
  if (params.isCached) score += 10;
  if (params.releaseGroup) score += 3;
  return Math.max(1, Math.min(99, score));
}

function scoreTier(score) {
  if (score >= 90) return 'S+';
  if (score >= 82) return 'S';
  if (score >= 72) return 'A';
  if (score >= 60) return 'B';
  if (score >= 45) return 'C';
  return 'D';
}

function scoreBadge(score) {
  const tier = scoreTier(score);
  if (tier === 'S+') return `🏆 ${tier}${score}`;
  if (tier === 'S') return `🥇 ${tier}${score}`;
  if (tier === 'A') return `🥈 ${tier}${score}`;
  if (tier === 'B') return `🥉 ${tier}${score}`;
  if (tier === 'C') return `📦 ${tier}${score}`;
  return `🧪 ${tier}${score}`;
}

function buildPremiumTags(params, maxItems = 4) {
  const tags = [];
  tags.push(params.quality);
  const primarySource = getPrimarySourceTag(params.cleanTags);
  if (primarySource) tags.push(primarySource);
  for (const tag of params.cleanTags) {
    if (tags.length >= maxItems) break;
    if (tag === primarySource || tag === params.quality) continue;
    if (/^(WEB|Rip)$/.test(tag) && primarySource === tag) continue;
    tags.push(tag);
  }
  return uniqueBy(tags, (item) => item.toLowerCase()).slice(0, maxItems);
}

function buildHeadlineParts(params) {
  const parts = [];
  parts.push(params.cleanName);
  if (params.epTag) parts.push(params.epTag);
  return parts.filter(Boolean);
}

function styleComplex(p) {
  const isCached = p.isCached;
  const statusIcon = p.cacheIcon;
  let res = 'SD';
  if (/2160|4k/i.test(p.quality)) res = '4K';
  else if (/1440/i.test(p.quality)) res = 'QHD';
  else if (/1080/i.test(p.quality)) res = 'HD';

  const sizePart = p.sizeString ? ` │ ⛁ ${p.sizeString}` : '';
  const seedPart = !isCached && p.seeders !== null ? ` · ⇋ ${p.seeders}` : '';
  const name = `${statusIcon} ${res}${sizePart}${seedPart}`;

  const line1 = `☰ ${joinNonEmpty([p.lang, p.audioTag, p.audioChannels])}`;
  const line2 = `☲ ${joinNonEmpty([p.quality, p.codec, p.cleanTags.join(' · ')])}`;

  const line3Parts = ['Leviathan'];
  if (p.releaseGroup) line3Parts.push(p.releaseGroup);
  if (p.providerLabel) line3Parts.push(p.providerLabel);
  if (isCached) line3Parts.push(`[${p.serviceTag}]`);
  const line3 = `☵ ${line3Parts.join(' · ')}`;

  const line4 = `☶ ${joinNonEmpty([p.cleanName, p.epTag])}`;
  return { name, title: [line1, line2, line3, line4].join('\n') };
}

function styleAndroidTV(p) {
  const qDisp = p.quality.replace(/2160p/i, '4K').replace(/1440p/i, '2K');
  const compact = Boolean(p.config?.androidCompact) || String(p.config?.formatter || '').toLowerCase() === 'android_compact';
  const hdrTag = p.cleanTags.find((tag) => /DV\+HDR|DV|HDR10\+|HDR/i.test(tag)) || '';
  const audioShort = joinNonEmpty([p.audioTag.replace(/^Dolby\s+/i, ''), p.audioChannels], ' ');
  const name = compact
    ? [p.scoreBadge, qDisp, hdrTag, p.serviceTag].filter(Boolean).join(' • ')
    : [qDisp, hdrTag, p.serviceTag].filter(Boolean).join(' | ');

  const lines = compact
    ? [
        `🎬 ${joinNonEmpty(p.headlineParts, ' ')}`,
        joinNonEmpty([p.primarySourceTag || p.displaySource, audioShort || p.codec, p.compactLang, p.sizeString], ' • '),
        p.seeders !== null ? `📡 ${p.seeders} seeders` : `⚙️ ${p.displaySource}`,
      ].filter(Boolean)
    : [
        `🎬 ${joinNonEmpty(p.headlineParts, ' ')}`,
        joinNonEmpty([p.scoreBadge, qDisp, hdrTag, p.codec], ' • '),
        audioShort ? `🎧 ${audioShort}` : '',
        `⚙️ ${p.displaySource}`,
        p.compactLang,
        p.fileTitle,
      ].filter(Boolean);

  return { name, title: lines.join('\n') };
}

function stylePicture(p) {
  const isCached = p.isCached;
  const cacheIcon = p.cacheIcon;
  const features = [];
  if (p.quality === '4K') features.push('UHD');
  if (p.cleanTags.some((tag) => /HDR|DV/i.test(tag))) features.push('HDR');
  if (/atmos/i.test(p.audioTag)) features.push('ATMOS');
  const name = `${cacheIcon} ${features.join(' ')} ${p.quality}`.trim();

  let typeText = 'Web-DL';
  if (p.cleanTags.some((tag) => /Remux/i.test(tag))) typeText = 'Blu-ray Remux';
  else if (p.cleanTags.some((tag) => /BluRay/i.test(tag))) typeText = 'Blu-ray';

  const hdrTags = p.cleanTags.filter((tag) => /HDR|DV|10\+/i.test(tag)).join(' | ');
  const lines = [
    `🎬 ${joinNonEmpty([p.cleanName, p.epTag], ' ')}`,
    `✨ ${p.quality}${hdrTags ? ` 🔆 ${hdrTags}` : ''}`,
    `🎧 ${p.audioTag}${p.audioChannels ? ` 🔊 ${p.audioChannels}` : ''}`,
    `💿 ${typeText}`,
    `📦 ${p.sizeString}`,
    `🏷️ ${typeText} T1${p.releaseGroup ? ` (${p.releaseGroup})` : ''}`,
    `⚡ Comet ${p.serviceTag}`,
  ];
  return { name, title: lines.join('\n') };
}

function styleLeviathan(p) {
  const cleanAudio = removeEmoji(p.audioTag) || p.audioTag;
  const statusIcon = p.cacheIcon;
  const brandName = toStylized('LEVIATHAN', 'small');
  const serviceStyled = toStylized(p.serviceTag, 'bold');
  const name = `${statusIcon} ${serviceStyled} 🦑 ${brandName}`;

  const techSpecs = uniqueBy([p.quality, ...p.cleanTags].filter(Boolean), (item) => item.toLowerCase());
  const techLine = techSpecs.map((item) => toStylized(item, 'small')).join(' • ');
  const lines = [
    `▶️ ${toStylized(p.cleanName, 'bold')} ${p.epTag}`.trim(),
    techLine ? `🔱 ${techLine}` : '',
    `🗣️ ${p.lang}  |  🫧 ${joinNonEmpty([cleanAudio, p.audioChannels], ' ')}`,
    `🧲 ${p.sizeString}${p.seedersStr ? `  |  ${p.seedersStr}` : ''}`,
    `${p.serviceIconTitle} ${p.displaySource}${p.releaseGroup ? ` | 🏷️ ${toStylized(p.releaseGroup, 'small')}` : ''}`,
  ].filter(Boolean);
  return { name, title: lines.join('\n') };
}

function styleLeviathanTwo(p) {
  const levText = toStylized('LEVIATHAN', 'small');
  const name = `🦑 ${levText} ${p.serviceIconTitle} │ ${p.quality}`;
  const lines = [
    `🎬 ${toStylized(p.cleanName, 'bold')}`,
    `📦 ${p.sizeString} │ ${joinNonEmpty([p.codec, p.videoTags.filter((item) => !item.includes(p.codec)).join(' ')])}`,
    `🔊 ${joinNonEmpty([p.audioTag, p.audioChannels], ' ')} • ${p.lang}`,
    `🔗 ${p.sourceLine}${p.seedersStr ? ` ${p.seedersStr}` : ''}`,
  ];
  return { name, title: lines.join('\n') };
}

function styleFra(p) {
  const qShort = p.quality === '1080p' ? 'FHD' : (p.quality === '4K' ? '4K' : 'HD');
  const lines = [
    `📄 ❯ ${p.fileTitle}`,
    `🌎 ❯ ${joinNonEmpty([p.lang, p.audioTag])}`,
    `✨ ❯ ${p.serviceTag} • ${p.displaySource}`,
    `🔥 ❯ ${joinNonEmpty([p.quality, p.cleanTags.join(' • ')])}`,
    `💾 ❯ ${p.sizeString}${p.seeders !== null ? ` / 👥 ❯ ${p.seeders}` : ''}`,
  ];
  return { name: `⚡️ Leviathan ${qShort}`, title: lines.join('\n') };
}

function styleDav(p) {
  const header = p.quality === '4K' ? '🎥 4K UHD' : (p.quality === '1080p' ? '📀 FHD' : '💿 HD');
  const lines = [
    `📺 ${joinNonEmpty([p.cleanName, p.epTag], ' ')}`,
    `🎧 ${joinNonEmpty([p.audioTag, p.audioChannels], ' ')} | 🎞️ ${p.codec}`,
    `🗣️ ${p.lang} | 📦 ${p.sizeString}`,
    `⏱️ ${p.seeders !== null ? p.seeders : '?'} Seeds | 🏷️ ${p.displaySource}`,
    `${p.serviceIconTitle} Leviathan 📡 ${p.serviceTag}`,
    `📂 ${p.fileTitle}`,
  ];
  return { name: `${header} ${p.codec}`.trim(), title: lines.join('\n') };
}

function styleAnd(p) {
  const cachedIcon = p.cacheIcon;
  const lines = [
    `${p.quality} ${cachedIcon}`,
    '─ ─ ─ ─ ─ ─ ─ ─ ─ ─',
    `Lingue: ${p.lang}`,
    `Specifiche: ${p.quality} | 📺 ${p.cleanTags.join(' ')} | 🔊 ${p.audioTag}`,
    '─ ─ ─ ─ ─ ─ ─ ─ ─ ─',
    `📂 ${p.sizeString} | ☁️ ${p.serviceTag} | 🛰️ Leviathan`,
  ];
  return { name: `🎬 ${joinNonEmpty([p.cleanName, p.epTag], ' ')}`, title: lines.join('\n') };
}

function styleLad(p) {
  const lines = [
    `🎟️ ${p.cleanName}`,
    `📜 ${p.epTag || 'Movie'}`,
    `🎥 ${joinNonEmpty([p.quality, `🎞️ ${p.codec}`, `🎧 ${p.audioTag}`], ' ')}`,
    `📦 ${p.sizeString} • 🔗 Leviathan`,
    `🌐 ${p.lang}`,
  ];
  return { name: `🖥️ ${p.quality} ${p.serviceTag}`, title: lines.join('\n') };
}

function stylePri(p) {
  const resIcon = p.quality === '4K' ? '4K🔥UHD' : (p.quality === '1080p' ? 'FHD🚀1080p' : 'HD💿720p');
  const lines = [
    `🎬 ${joinNonEmpty([p.cleanName, p.epTag], ' ')}`,
    p.cleanTags.join(' '),
    `🎧 ${p.audioTag} | 🔊 ${p.audioChannels} | 🗣️ ${p.lang}`,
    `📁 ${p.sizeString} | 🏷️ ${p.displaySource}`,
    `📄 ▶️ ${p.fileTitle} ◀️`,
  ].filter(Boolean);
  return { name: `[${p.serviceTag}]⚡️☁️\n${resIcon}\n[Leviathan]`, title: lines.join('\n') };
}

function styleComet(p) {
  const techStack = [p.codec, ...p.cleanTags].filter(Boolean).join(' • ');
  const lines = [
    `📄 ${p.fileTitle}`,
    `📹 ${techStack || 'Video'} | ${p.audioTag}`,
    `⭐ ${p.displaySource}`,
    `💾 ${p.sizeString} ${p.seeders !== null ? `👥 ${p.seeders}` : '🔎 Leviathan'}`,
    `🌍 ${p.lang}`,
  ];
  return { name: `[${p.serviceTag} ⚡]\nLeviathan\n${p.quality}`, title: lines.join('\n') };
}

function styleStremioIta(p) {
  const isCached = p.isCached;
  const statusIcon = p.cacheIcon;
  const langText = compactLanguageLabel(p.lang);
  const qualIcon = p.cleanTags.some((tag) => /bluray|web|hdr|dv/i.test(tag)) || p.quality === '4K' ? '🔥' : '📀';
  const lines = [
    `📄 ❯ ${p.fileTitle}`,
    `🌎 ❯ ${langText}`,
    `${p.cacheIcon} ❯ ${p.serviceTag} • ${p.displaySource}`,
    `${qualIcon} ❯ ${joinNonEmpty([p.quality, p.cleanTags.join(' • ')])}`,
    `💾 ❯ ${p.sizeString}${!isCached && p.seeders !== null ? ` / 👥 ❯ ${p.seeders}` : ''}`,
  ];
  const audioLine = joinNonEmpty([p.audioTag, p.audioChannels], ' • ');
  if (audioLine) lines.push(`🔉 ❯ ${audioLine}`);
  return { name: `${statusIcon} Leviathan ${p.qDetails}`, title: lines.join('\n') };
}

function styleTorrentio(p) {
  let cleanLang = p.lang.replace(/[\u{1F1E6}-\u{1F1FF}]{2}/gu, '').trim();
  if (!cleanLang.replace(/[^a-zA-Z]/g, '')) cleanLang = p.lang;
  const lines = [
    `📄 ${p.fileTitle}`,
    `📦 ${p.sizeString}${p.seeders !== null ? ` 👤 ${p.seeders}` : ''}`,
    `🔍 ${p.displaySource}`,
    `🔊 ${cleanLang}`,
  ];
  return { name: `[${p.serviceTag}]\n${p.quality}`, title: lines.join('\n') };
}

function styleVertical(p) {
  const cacheLabel = p.cacheIcon;
  const type = p.cleanTags.some((tag) => /Remux/i.test(tag)) ? 'Remux' : 'WEB-DL';
  const lines = [
    `🍿 ${p.cleanName}`,
    `📼 ${type}${p.cleanTags[0] ? ` • ${p.cleanTags[0]}` : ''}`,
    `⚙️ ${p.codec}`,
    `🔊 ${p.audioTag}${p.audioChannels ? ` (${p.audioChannels})` : ''}`,
    `💬 ${p.lang}`,
    `🧲 ${p.sizeString}`,
  ];
  return { name: `🦑 Leviathan ${p.quality} ${cacheLabel}`, title: lines.join('\n') };
}

function stylePremium(p) {
  const statusIcon = p.cacheIcon;
  const techLine = joinNonEmpty([p.scoreBadge, ...p.premiumTags], ' • ');
  const audioLine = joinNonEmpty([p.audioTag, p.audioChannels, p.compactLang], ' • ');
  const providerLine = joinNonEmpty([`${statusIcon} ${p.serviceTag}`, p.displaySource, p.releaseGroup ? `Grp ${p.releaseGroup}` : ''], ' • ');
  const sizeLine = joinNonEmpty([p.sizeString, p.seeders !== null ? `${p.seeders} seeders` : '', p.primarySourceTag], ' • ');
  const titleLines = [
    `🎬 ${joinNonEmpty(p.headlineParts, ' ')}`,
    techLine ? `🏷️ ${techLine}` : '',
    audioLine ? `🎧 ${audioLine}` : '',
    sizeLine ? `📦 ${sizeLine}` : '',
    providerLine ? `🛰️ ${providerLine}` : '',
  ].filter(Boolean);

  return {
    name: `${p.scoreBadge} ${p.quality} ${statusIcon} ${p.serviceTag}`.trim(),
    title: titleLines.join('\n'),
  };
}

function styleAndroidCompact(p) {
  const hdrTag = p.cleanTags.find((tag) => /DV\+HDR|DV|HDR10\+|HDR/i.test(tag)) || '';
  const techBits = joinNonEmpty([p.quality, hdrTag, p.audioChannels || p.audioTag, p.compactLang], ' • ');
  const lowerProvider = p.primarySourceTag || p.displaySource;
  const lines = [
    `🎬 ${joinNonEmpty(p.headlineParts, ' ')}`,
    joinNonEmpty([p.scoreBadge, techBits], ' • '),
    joinNonEmpty([lowerProvider, p.sizeString, p.seeders !== null ? `${p.seeders}👤` : `${p.serviceTag}`], ' • '),
  ].filter(Boolean);

  return {
    name: `${p.quality} • ${p.serviceTag} • ${p.scoreTier}`,
    title: lines.join('\n'),
  };
}

function styleCustom(p, template) {
  if (!template) return styleLeviathan(p);
  const vars = {
    '{title}': p.cleanName,
    '{originalTitle}': p.fileTitle,
    '{ep}': p.epTag || '',
    '{quality}': p.quality,
    '{quality_bold}': toStylized(p.quality, 'bold'),
    '{size}': p.sizeString,
    '{source}': p.displaySource,
    '{service}': p.serviceTag,
    '{lang}': p.lang,
    '{audio}': p.audioInfo,
    '{seeders}': p.seedersStr,
    '{codec}': p.codec,
    '{group}': p.releaseGroup,
    '{n}': '\n',
  };
  let output = safeString(template);
  for (const [key, value] of Object.entries(vars)) {
    output = output.replace(new RegExp(key.replace(/[{}]/g, '\\$&'), 'g'), value);
  }
  output = output.replace(/\\n/g, '\n');
  return { name: `Leviathan ${p.quality}`, title: output };
}

const STYLE_BUILDERS = {
  complex: styleComplex,
  android: styleAndroidTV,
  android_compact: styleAndroidCompact,
  premium: stylePremium,
  elite: stylePremium,
  picture: stylePicture,
  leviathan: styleLeviathan,
  lev2: styleLeviathanTwo,
  fra: styleFra,
  dav: styleDav,
  and: styleAnd,
  lad: styleLad,
  pri: stylePri,
  comet: styleComet,
  stremio_ita: styleStremioIta,
  torrentio: styleTorrentio,
  vertical: styleVertical,
  custom: (params, config) => styleCustom(params, config.customTemplate || ''),
};

function extractStreamInfo(title, source, config = {}) {
  const cacheKey = JSON.stringify([title, source, config.season, config.episode]);
  const cached = getCached(EXTRACT_CACHE, cacheKey);
  if (cached) return cached;

  const rawTitle = normalizeSpaces(title);
  const parsed = parseTitleCached(rawTitle);
  const upperTitle = compactTitleForRegex(rawTitle);

  const { quality, qDetails, qIcon } = deriveQuality(parsed, upperTitle);
  const { videoTags, cleanTags } = deriveVideoTags(parsed, upperTitle);
  const parsedLanguageContext = [
    source,
    rawTitle,
    parsed?.language,
    parsed?.lang,
    parsed?.audio_lang,
    parsed?.audioLanguage,
    parsed?.subtitles,
    parsed?.subs,
    Array.isArray(parsed?.languages) ? parsed.languages.join(' ') : parsed?.languages,
    Array.isArray(parsed?.subtitleLanguages) ? parsed.subtitleLanguages.join(' ') : parsed?.subtitleLanguages,
  ].filter(Boolean).join(' ');
  const lang = deriveLanguages(rawTitle, parsedLanguageContext);
  const { codec, audioTag, audioChannels } = deriveAudio(parsed, upperTitle, quality, cleanTags);
  const releaseGroup = deriveReleaseGroup(rawTitle, parsed);
  const cleanName = cleanFilename(rawTitle);
  const epTag = getEpisodeTag(rawTitle, config);

  const result = {
    quality,
    qDetails,
    qIcon,
    videoTags,
    cleanTags,
    lang,
    codec,
    audioTag,
    audioChannels,
    rawInfo: parsed,
    releaseGroup,
    cleanName,
    epTag,
  };

  return setCached(EXTRACT_CACHE, cacheKey, result, EXTRACT_CACHE_LIMIT);
}

function formatStreamSelector(fileTitle, source, size, seeders, serviceTag = DEFAULT_SERVICE_TAG, config = {}, infoHash = null, isLazy = false, isPackItem = false, cacheState = 'unknown') {
  const params = createStyleParams(fileTitle, source, size, seeders, serviceTag, config, infoHash, isLazy, isPackItem, cacheState);
  const styleName = safeString(config.formatter || 'leviathan').toLowerCase();
  const builder = STYLE_BUILDERS[styleName] || STYLE_BUILDERS.leviathan;
  const result = builder(params, config);
  result.bingeGroup = params.bingeGroup;
  result.score = params.visualScore;
  result.scoreTier = params.scoreTier;
  return result;
}

module.exports = {
  formatStreamSelector,
  cleanFilename,
  formatBytes,
  extractStreamInfo,
  getEpisodeTag,
};
