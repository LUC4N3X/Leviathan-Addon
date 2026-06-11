'use strict';

const SOURCE_ALIAS_ENTRIES = [
  [/\b(?:il\s*)?corsaro(?:\s*nero)?\b/i, 'ilCorSaRoNeRo'],
  [/\btorrentgalaxy\b|\btgx\b/i, 'TGx'],
  [/\b1337x?\b/i, '1337x'],
  [/\bthe\s*pirate\s*bay\b|\btpb\b/i, 'TPB'],
  [/\byts\b|\byify\b/i, 'YTS'],
  [/\brarbg\b/i, 'RARBG']
];

const SERVICE_LABELS = Object.freeze({
  rd: '[RD',
  realdebrid: '[RD',
  'real-debrid': '[RD',
  real_debrid: '[RD',
  tb: '[TB',
  torbox: '[TB',
  p2p: '[P2P',
  torrent: '[P2P',
  torrents: '[P2P',
  web: '[WEB',
  http: '[WEB',
  https: '[WEB'
});

const EXTENSION_RE = /\.[a-z0-9]{2,5}(?:[?#].*)?$/i;
const URL_RE = /^https?:\/\//i;
const TECH_HINT_RE = /(BluRay|WEB(?:-DL|Rip)?|HDR|HDR10|DV|Dolby\s*Vision|HEVC|H\.?26[45]|x26[45]|10bit|AAC|AC3|EAC3|Atmos|DDP?|TrueHD|DTS(?:-HD)?|Remux|BDRip|WEBCap)/i;
const SAVED_CLOUD_RE = /(?:saved\s*cloud|cloud\s*salvato|debrid\s*cloud|rd\s*cloud|tb\s*cloud|real[-\s]?debrid|torbox)/i;
const TORBOX_RE = /\btb\b|torbox/i;
const REAL_DEBRID_RE = /\brd\b|real[-\s]?debrid/i;

function normalizeBoolean(value) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value === 1;
  if (typeof value !== 'string') return false;

  const normalized = value.trim().toLowerCase();
  return ['true', '1', 'yes', 'y', 'on', 'enabled'].includes(normalized);
}

function compactSpaces(value) {
  return String(value || '')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function normalizeServiceKey(service) {
  return compactSpaces(service || 'p2p')
    .toLowerCase()
    .replace(/\s+/g, '-');
}

function normalizeSourceName(source) {
  let displaySource = compactSpaces(source || 'Unknown Indexer');

  if (SAVED_CLOUD_RE.test(displaySource)) {
    if (TORBOX_RE.test(displaySource)) return 'TorBox';
    if (REAL_DEBRID_RE.test(displaySource)) return 'Real-Debrid';
    return 'Real-Debrid';
  }

  for (const [pattern, replacement] of SOURCE_ALIAS_ENTRIES) {
    if (pattern.test(displaySource)) {
      displaySource = replacement;
      break;
    }
  }

  return displaySource || 'Unknown Indexer';
}

function cleanBracketNoise(value) {
  return compactSpaces(String(value || '').replace(/\[[^\]]+\]/g, ' '));
}

function preserveUsefulParentheses(value) {
  return compactSpaces(
    String(value || '').replace(
      /\(([^)]*?(BluRay|WEB|HDR|HDR10|HEVC|H\.?265|H\.?264|x265|x264|10bit|AAC|AC3|EAC3|Atmos|DDP?|DV|Dolby\s*Vision|Remux)[^)]*?)\)/gi,
      '($1)'
    )
  );
}

function shouldForceExtension(name, forceExtension, techText) {
  if (!forceExtension) return false;
  if (!name || EXTENSION_RE.test(name)) return false;
  if (URL_RE.test(name)) return false;
  return TECH_HINT_RE.test(String(techText || name || ''));
}

function cleanFileNameForDisplay(filename, options = {}) {
  const { forceExtension = false, techInfo = '' } = options;

  let name = compactSpaces(filename);
  if (!name) return forceExtension ? 'Unknown.mkv' : 'Unknown';

  name = cleanBracketNoise(name);
  name = preserveUsefulParentheses(name);

  if (shouldForceExtension(name, forceExtension, `${techInfo} ${name}`)) {
    name += '.mkv';
  }

  return name;
}

function getCacheBadge(cacheState, cached) {
  const normalized = compactSpaces(cacheState).toLowerCase();

  if (normalized === 'cached') return '⚡';
  if (normalized === 'likely_cached') return '⏳';
  if (normalized === 'uncached') return '⏳';
  if (normalized === 'likely_uncached') return '⏳';
  if (normalized === 'uncached_terminal') return '☁️';
  if (normalized === 'probing') return '⏳';
  if (normalized === 'unknown') return '⏳';

  return cached ? '⚡' : '⏳';
}

function formatStreamName({
  addonName,
  service,
  cached,
  cacheState,
  quality,
  hasError = false,
  savedCloud = false
} = {}) {
  const serviceKey = normalizeServiceKey(service);
  const serviceLabel = SERVICE_LABELS[serviceKey] || '[P2P';
  const badge = savedCloud ? '☁️' : getCacheBadge(cacheState, cached);
  const safeAddonName = compactSpaces(addonName || 'Leviathan');
  const safeQuality = compactSpaces(quality || '');
  const errorBadge = hasError ? ' ⚠️' : '';

  return `${serviceLabel}${badge}] ${safeAddonName}${safeQuality ? ` ${safeQuality}` : ''}${errorBadge}`;
}

function normalizeSeeders(seeders) {
  if (seeders === undefined || seeders === null || seeders === '') return '-';

  const value = Number(seeders);
  if (Number.isFinite(value)) return Math.max(0, value);

  return compactSpaces(seeders) || '-';
}

function uniqueAdjacentRows(rows = []) {
  const out = [];

  for (const row of rows) {
    const clean = compactSpaces(row);
    if (!clean) continue;
    if (out[out.length - 1] === clean) continue;
    out.push(clean);
  }

  return out;
}

function formatStreamTitle({
  title,
  size,
  language,
  source,
  seeders,
  episodeTitle,
  infoHash,
  techInfo,
  providerLine,
  sourceIcon = '🔎',
  forceExtension = false
} = {}) {
  const baseTitle = title || episodeTitle || infoHash || 'Unknown';
  const rowTech = compactSpaces(techInfo || '');
  const displayTitle = cleanFileNameForDisplay(baseTitle, {
    forceExtension: Boolean(forceExtension) && TECH_HINT_RE.test(String(techInfo || baseTitle || '')),
    techInfo
  });
  const displaySize = compactSpaces(size || 'Unknown');
  const displaySeeders = normalizeSeeders(seeders);
  const displayLang = compactSpaces(language || '🌍');
  const displaySource = normalizeSourceName(source);
  const safeSourceIcon = compactSpaces(sourceIcon || '🔎');
  const rowInfo = `💾 ${displaySize} • 👤 ${displaySeeders} • ${displayLang}`;
  const rowTitle = `📁 ${displayTitle}`;
  const rowProvider = compactSpaces(providerLine || '');
  const rowSource = `${safeSourceIcon} ${displaySource}`;

  return uniqueAdjacentRows([
    rowTech,
    rowInfo,
    rowTitle,
    rowProvider,
    rowSource
  ]).join('\n');
}

function isAIOStreamsEnabled(config) {
  return normalizeBoolean(
    config?.aiostreams_mode ??
    config?.aioStreamsMode ??
    config?.aiostreamsMode ??
    config?.aio_streams_mode ??
    config?.aiostreams_enabled
  );
}

module.exports = {
  formatStreamName,
  formatStreamTitle,
  isAIOStreamsEnabled,
  cleanFileNameForDisplay,
  normalizeSourceName
};
