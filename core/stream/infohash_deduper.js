'use strict';

const crypto = require('crypto');

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const VIDEO_EXTENSIONS = /\.(mkv|mp4|avi|mov|wmv|flv|webm|m4v|mpg|mpeg|3gp|3g2|m2ts|ts|vob|ogv|ogm|divx|xvid|rm|rmvb|asf|mxf|mka|mks|mk3d|f4v|f4p|f4a|f4b)$/i;
const CACHE_STATE_PRIORITY = {
  uncached_terminal: 0,
  likely_uncached: 1,
  unknown: 2,
  probing: 3,
  likely_cached: 5,
  cached: 6
};

function base32ToHex(value) {
  const input = String(value || '').replace(/=+$/g, '').toUpperCase();
  let bits = '';
  let hex = '';

  for (const char of input) {
    const idx = BASE32_ALPHABET.indexOf(char);
    if (idx === -1) return null;
    bits += idx.toString(2).padStart(5, '0');
  }

  for (let i = 0; i + 4 <= bits.length; i += 4) {
    hex += parseInt(bits.slice(i, i + 4), 2).toString(16);
  }

  return /^[a-f0-9]{40}$/i.test(hex) ? hex.toUpperCase() : null;
}

function normalizeInfoHash(value) {
  if (value === null || value === undefined) return null;
  const raw = String(value || '').trim();
  if (!raw) return null;

  const candidates = [raw];
  if (/%[0-9A-F]{2}/i.test(raw)) {
    try {
      const decoded = decodeURIComponent(raw);
      if (decoded && decoded !== raw) candidates.push(decoded);
    } catch (_) {}
  }

  for (const text of candidates) {
    const btih = text.match(/(?:urn:)?btih:([A-Fa-f0-9]{40}|[A-Za-z2-7]{32})/i);
    if (btih) return normalizeInfoHash(btih[1]);

    const dht = text.match(/^dht:([A-Fa-f0-9]{40}|[A-Za-z2-7]{32})$/i);
    if (dht) return normalizeInfoHash(dht[1]);

    if (/^[A-Fa-f0-9]{40}$/.test(text)) return text.toUpperCase();
    if (/^[A-Za-z2-7]{32}$/.test(text)) return base32ToHex(text);

    const embedded = text.match(/(?:^|[-\/\[\(;&:?=])([A-Fa-f0-9]{40}|[A-Za-z2-7]{32})(?=$|[-\]\)\/:;&?=#])/i);
    if (embedded) return normalizeInfoHash(embedded[1]);
  }

  return null;
}

function normalizeCacheState(value) {
  const state = String(value || '').trim().toLowerCase();
  if (state === 'rd_cached' || state === 'instant' || state === 'instant_available') return 'cached';
  if (state === 'likely' || state === 'maybe_cached') return 'likely_cached';
  if (state === 'uncached' || state === 'not_cached') return 'likely_uncached';
  return Object.prototype.hasOwnProperty.call(CACHE_STATE_PRIORITY, state) ? state : '';
}

function getCacheStatePriority(state) {
  const normalized = normalizeCacheState(state);
  return normalized ? CACHE_STATE_PRIORITY[normalized] : -1;
}

function getKnownCacheState(item = {}) {
  const hints = item?.behaviorHints && typeof item.behaviorHints === 'object' ? item.behaviorHints : {};
  if (
    item?.isSavedCloud ||
    item?._savedCloud ||
    item?.savedCloud ||
    hints.savedCloud ||
    item?._dbCachedRd === true ||
    item?.cached_rd === true ||
    item?.isCached === true ||
    item?._tbCached === true ||
    item?.tbCached === true ||
    item?.tb_cached === true ||
    item?.cached === true ||
    hints.cached === true
  ) return 'cached';
  if (item?.likely_cached === true || hints.likely_cached === true) return 'likely_cached';
  if (item?.probing === true || hints.probing === true) return 'probing';
  const candidates = [
    item?._rdCacheState,
    item?.rdCacheState,
    item?.cacheState,
    item?.rd_status,
    item?.rdStatus,
    hints._rdCacheState,
    hints.rdCacheState,
    hints.cacheState,
    hints.rd_status,
    hints.rdStatus
  ];
  let best = '';
  for (const candidate of candidates) {
    const normalized = normalizeCacheState(candidate);
    if (getCacheStatePriority(normalized) > getCacheStatePriority(best)) best = normalized;
  }
  return best;
}

function bestKnownCacheState(...items) {
  let best = '';
  for (const item of items.flat().filter(Boolean)) {
    const state = getKnownCacheState(item);
    if (getCacheStatePriority(state) > getCacheStatePriority(best)) best = state;
  }
  return best;
}

function pushCandidate(candidates, value) {
  if (value === null || value === undefined) return;
  if (Array.isArray(value)) {
    for (const item of value) pushCandidate(candidates, item);
    return;
  }
  if (typeof value === 'object') {
    pushCandidate(candidates, value.infoHash);
    pushCandidate(candidates, value.infohash);
    pushCandidate(candidates, value.info_hash);
    pushCandidate(candidates, value.hash);
    pushCandidate(candidates, value.btih);
    pushCandidate(candidates, value.magnet);
    pushCandidate(candidates, value.magnetLink);
    pushCandidate(candidates, value.url);
    pushCandidate(candidates, value.sources);
    return;
  }
  const text = String(value || '').trim();
  if (text) candidates.push(text);
}

function extractInfoHash(item = {}) {
  const candidates = [];

  pushCandidate(candidates, item.infoHash);
  pushCandidate(candidates, item.infohash);
  pushCandidate(candidates, item.info_hash);
  pushCandidate(candidates, item.hash);
  pushCandidate(candidates, item.btih);
  pushCandidate(candidates, item.magnet);
  pushCandidate(candidates, item.magnetLink);
  pushCandidate(candidates, item.url);
  pushCandidate(candidates, item.directUrl);
  pushCandidate(candidates, item.externalDirectUrl);
  pushCandidate(candidates, item._externalDirectUrl);
  pushCandidate(candidates, item.sources);
  pushCandidate(candidates, item.behaviorHints?.infoHash);
  pushCandidate(candidates, item.behaviorHints?.infohash);
  pushCandidate(candidates, item.behaviorHints?.info_hash);
  pushCandidate(candidates, item.behaviorHints?.hash);
  pushCandidate(candidates, item.behaviorHints?.btih);
  pushCandidate(candidates, item.behaviorHints?.magnet);
  pushCandidate(candidates, item.behaviorHints?.sources);

  for (const candidate of candidates) {
    const normalized = normalizeInfoHash(candidate);
    if (normalized) return normalized;
  }

  return null;
}

function parseIntegerId(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : null;
}

function extractFileIdx(item = {}) {
  const candidates = [
    item.fileIdx,
    item.fileIndex,
    item.file_index,
    item.rd_file_index,
    item.tb_file_id,
    item.file_id,
    item.behaviorHints?.fileIdx,
    item.behaviorHints?.fileIndex,
    item.behaviorHints?.file_index,
    item.episodeFileHint?.fileIdx,
    item.episodeFileHint?.fileIndex,
    item._episodeFileHint?.fileIdx,
    item._episodeFileHint?.fileIndex
  ];

  for (const value of candidates) {
    const parsed = parseIntegerId(value);
    if (parsed !== null) return parsed;
  }
  return null;
}

function parseBytes(value) {
  if (value === null || value === undefined || value === '') return 0;
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value;
  const text = String(value || '').trim();
  const match = text.match(/(\d+(?:[.,]\d+)?)\s*(B|KB|MB|GB|TB)\b/i);
  if (!match) return 0;
  const amount = Number(String(match[1]).replace(',', '.'));
  if (!Number.isFinite(amount) || amount <= 0) return 0;
  const unit = match[2].toUpperCase();
  const powers = { B: 0, KB: 1, MB: 2, GB: 3, TB: 4 };
  return Math.round(amount * Math.pow(1024, powers[unit] || 0));
}

function getSizeBytes(item = {}) {
  const values = [
    item._size,
    item.sizeBytes,
    item.fileSize,
    item.file_size,
    item.mainFileSize,
    item.size,
    item.behaviorHints?.videoSize
  ];
  for (const value of values) {
    const parsed = typeof value === 'number' ? value : parseBytes(value);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return 0;
}

function getFolderSizeBytes(item = {}) {
  const values = [
    item.folderSize,
    item.folder_size,
    item.totalPackSize,
    item.packSize,
    item.behaviorHints?.folderSize,
    item.behaviorHints?.folder_size
  ];
  for (const value of values) {
    const parsed = typeof value === 'number' ? value : parseBytes(value);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return 0;
}

function isSeriesContext(options = {}) {
  const meta = options.meta || {};
  return Boolean(options.isSeries || meta?.isSeries || Number(meta?.season || 0) > 0 || Number(meta?.episode || 0) > 0);
}

function isForcedTorrentioKeep(item = {}) {
  return Boolean(
    item?._torrentioLooseItForceKeep ||
    item?._torrentioExactGuard ||
    item?.behaviorHints?.torrentioLooseItForceKeep ||
    item?.behaviorHints?.torrentioExactGuard
  );
}

function stripVolatileDisplaySignals(value = '') {
  return String(value || '')
    .replace(/(?:👥|seed(?:er)?s?|seeds?|peers?)\s*[:=]?\s*\d{1,6}/gi, ' ')
    .replace(/\b(?:cached|likely_cached|probing|unknown)\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function stripProviderDisplayLines(value = '') {
  return String(value || '')
    .split(/\r?\n+/)
    .filter((line) => {
      const text = String(line || '').trim();
      if (!text) return false;
      if (/🐬/.test(text)) return false;
      if (/\b(?:source|provider)\s*[:=]/i.test(text)) return false;
      if (/\b(?:1337x|rarbg|thepiratebay|tpb|torrentio|eztv|yts|torrentgalaxy|nyaa|kickass|limetorrents|magnetdl)\b\s*(?:\||-|•)/i.test(text)) return false;
      return true;
    })
    .join(' ');
}

function getForcedTorrentioTitleKey(item = {}) {
  return normalizeSmartToken(stripVolatileDisplaySignals(stripProviderDisplayLines([
    item.title,
    item.name,
    item.filename,
    item.fileName,
    item.file_title,
    item.behaviorHints?.filename
  ].filter(Boolean).join('\n')))).replace(/\s+/g, ' ').trim();
}

function extractDisplayProviderKey(value = '') {
  const text = String(value || '');
  const match = text.match(/🐬\s*([^|\n\r]+)/u);
  return match ? normalizeSmartToken(match[1]).replace(/\s+/g, '') : '';
}

function getForcedTorrentioSourceKey(item = {}) {
  return normalizeSmartToken([
    item.source,
    item.provider,
    item.externalProvider,
    item.externalAddon,
    item.externalGroup,
    item.behaviorHints?.vortexSource,
    item.behaviorHints?.vortexMeta?.provider,
    extractDisplayProviderKey([item.title, item.name, item.filename, item.fileName, item.file_title].filter(Boolean).join('\n'))
  ].filter(Boolean).join(' ')).replace(/\s+/g, '');
}

function getForcedTorrentioMoviePayloadKey(item = {}, options = {}) {
  if (isSeriesContext(options)) return null;

  const titleKey = getForcedTorrentioTitleKey(item);
  const sourceKey = getForcedTorrentioSourceKey(item);
  const sizeBucket = getSizeBucket(item);
  const resolution = extractResolutionTag(item);
  if (titleKey.length < 12 || !sourceKey || !sizeBucket || !resolution) return null;

  return [
    'torrentioMoviePayload',
    sourceKey,
    titleKey,
    sizeBucket,
    resolution,
    extractQualityTag(item) || 'noquality',
    extractEncodeTag(item) || 'noencode'
  ].join(':');
}

function getForcedTorrentioExactKey(item = {}, options = {}) {
  const hash = extractInfoHash(item);
  if (!hash) return null;

  const fileIdx = extractFileIdx(item);
  const isSeries = isSeriesContext(options);
  const episodeKey = isSeries ? getSeasonEpisodeKey(options) : '';
  const scope = isSeries ? `series:${episodeKey || 'unknown'}` : 'movie';

  if (fileIdx !== null) return ['torrentioExactFile', scope, hash, `file:${fileIdx}`].join(':');

  const titleKey = getForcedTorrentioTitleKey(item);

  if (titleKey.length < 8) return null;
  const parts = [
    'torrentioExact',
    scope,
    hash,
    'nofile',
    titleKey || 'notitle',
    getSizeBucket(item) || 'nosize',
    extractResolutionTag(item) || 'nores',
    extractQualityTag(item) || 'noquality',
    extractEncodeTag(item) || 'noencode',
    extractReleaseGroupTag(item) || 'nogroup'
  ];
  return parts.join(':');
}

function getSeasonEpisodeKey(options = {}) {
  const meta = options.meta || {};
  const season = Number(options.season ?? meta?.season ?? 0) || 0;
  const episode = Number(options.episode ?? meta?.episode ?? 0) || 0;
  if (season > 0 && episode > 0) return `${season}:${episode}`;
  return '';
}

function normalizeFileName(value) {
  const text = String(value || '')
    .replace(VIDEO_EXTENSIONS, '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\p{L}\p{N}+]+/gu, '')
    .toLowerCase()
    .trim();
  return text.length >= 8 ? text : '';
}

function extractFilename(item = {}) {
  const candidates = [
    item.filename,
    item.fileName,
    item.file_name,
    item.file_title,
    item.behaviorHints?.filename,
    item.behaviorHints?.fileName,
    item.episodeFileHint?.fileName,
    item.episodeFileHint?.filePath,
    item._episodeFileHint?.fileName,
    item._episodeFileHint?.filePath,
    item.title,
    item.name
  ];

  for (const value of candidates) {
    const normalized = normalizeFileName(value);
    if (normalized) return normalized;
  }
  return '';
}


function normalizeSmartToken(value) {
  return String(value || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/['\u2018\u2019\u02bc`\u00b4]+/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .toLowerCase();
}

function joinedSignalText(item = {}) {
  return [
    item.filename,
    item.fileName,
    item.file_name,
    item.file_title,
    item.title,
    item.name,
    item.torrent_title,
    item.rawTitle,
    item.description,
    item.resolution,
    item.quality,
    item.quality_tag,
    item.codec,
    item.codec_tag,
    item.videoCodec,
    item.encode,
    item.hdr,
    item.hdr_tag,
    item.audio,
    item.audio_tag,
    item.releaseGroup,
    item.release_group,
    item.group,
    item.behaviorHints?.filename,
    item.behaviorHints?.fileName,
    item.behaviorHints?.videoResolution,
    item.behaviorHints?.codec,
    item.behaviorHints?.hdr,
    item.behaviorHints?.audio,
    item.episodeFileHint?.fileName,
    item.episodeFileHint?.filePath,
    item._episodeFileHint?.fileName,
    item._episodeFileHint?.filePath
  ].filter(Boolean).join(' ');
}

function collectLanguageSignalText(item = {}) {
  return [
    item.language,
    item.lang,
    item.audioLanguage,
    item.audio,
    item.audio_tag,
    Array.isArray(item.audioLanguages) ? item.audioLanguages.join(' ') : item.audioLanguages,
    item.behaviorHints?.language,
    item.behaviorHints?.audio,
    item.behaviorHints?.vortexMeta?.language,
    item.behaviorHints?.vortexMeta?.audio,
    Array.isArray(item.behaviorHints?.vortexMeta?.audioLanguages) ? item.behaviorHints.vortexMeta.audioLanguages.join(' ') : item.behaviorHints?.vortexMeta?.audioLanguages,
    item.title,
    item.name
  ].filter(Boolean).join(' ');
}

function extractLanguageVariant(item = {}) {
  const text = collectLanguageSignalText(item);
  if (!text) return '';
  if (/🇮🇹|\b(?:ita|it|italian|italiano|dub\s*ita|doppiat[oa])\b/i.test(text) && !/sub\s*ita|vost(?:it)?/i.test(text)) return 'ita';
  if (/🇯🇵|\b(?:jpn|jp|jap|ja|japanese|giapponese)\b|sub\s*ita|vost(?:it)?|raw/i.test(text)) return 'jpn';
  if (/🇬🇧|🇺🇸|\b(?:eng|en|english|inglese)\b/i.test(text)) return 'eng';
  if (/\b(?:multi|dual\s*audio|multiaudio)\b/i.test(text)) return 'multi';
  return '';
}

function normalizeStoredSmartDedupeKey(item = {}) {
  const value = item.smart_dedupe_key
    || item.smartDedupeKey
    || item._smartDedupeKey
    || item.behaviorHints?.smartDedupeKey
    || item.behaviorHints?.smart_dedupe_key;
  const text = String(value || '').trim();
  return /^smartDetect:[a-f0-9]{12,40}$/i.test(text) ? text : '';
}

function extractResolutionTag(item = {}) {
  const explicit = normalizeSmartToken(item.resolution || item.qualityResolution || item.videoResolution || item.quality_tag || item.behaviorHints?.videoResolution);
  if (/\b(2160p|1080p|720p|576p|480p|360p|4k|uhd)\b/.test(explicit)) return explicit.match(/\b(2160p|1080p|720p|576p|480p|360p|4k|uhd)\b/)[1].replace('4k', '2160p').replace('uhd', '2160p');
  const text = normalizeSmartToken(joinedSignalText(item));
  const match = text.match(/\b(2160p|1080p|720p|576p|480p|360p|4k|uhd)\b/);
  return match ? match[1].replace('4k', '2160p').replace('uhd', '2160p') : '';
}

function extractQualityTag(item = {}) {
  const text = normalizeSmartToken([item.quality, item.quality_tag, item.sourceQuality, joinedSignalText(item)].filter(Boolean).join(' '));
  const match = text.match(/\b(remux|bluray|blu ray|bdrip|webdl|web dl|webrip|hdtv|hdrip|dvdrip|cam|telesync|ts)\b/);
  if (!match) return '';
  return match[1].replace(/\s+/g, '');
}

function extractEncodeTag(item = {}) {
  const text = normalizeSmartToken([item.codec, item.codec_tag, item.videoCodec, item.encode, joinedSignalText(item)].filter(Boolean).join(' '));
  const match = text.match(/\b(av1|x265|h265|hevc|x264|h264|vp9)\b/);
  if (!match) return '';
  const value = match[1];
  if (value === 'h265') return 'x265';
  if (value === 'h264') return 'x264';
  return value;
}

function extractReleaseGroupTag(item = {}) {
  const explicit = normalizeSmartToken(item.releaseGroup || item.release_group || item.group || item.uploader || item.provider);
  if (explicit && explicit.length <= 24) return explicit.replace(/\s+/g, '');
  const raw = String(joinedSignalText(item) || '');
  const match = raw.match(/[-.\s]([A-Za-z0-9]{2,24})\s*(?:\.[A-Za-z0-9]{2,4})?$/);
  return match ? normalizeSmartToken(match[1]).replace(/\s+/g, '') : '';
}

function getSizeBucket(item = {}) {
  const bytes = getSizeBytes(item) || getFolderSizeBytes(item);
  if (!Number.isFinite(bytes) || bytes <= 0) return '';

  return String(Math.max(1, Math.round(bytes / (128 * 1024 * 1024))));
}

function stableSmartSignature(parts) {
  const raw = parts.filter(Boolean).join('|');
  if (!raw) return '';
  return crypto.createHash('sha1').update(raw).digest('hex').slice(0, 20);
}

function buildSmartDedupeKey(item = {}, options = {}) {
  if (String(process.env.LEVIATHAN_SMART_DEDUPE || '1') === '0') return null;

  const filenameKey = extractFilename(item);
  if (!filenameKey || filenameKey.length < 12) return null;

  const resolution = extractResolutionTag(item);
  const quality = extractQualityTag(item);
  const encode = extractEncodeTag(item);
  const releaseGroup = extractReleaseGroupTag(item);
  const sizeBucket = getSizeBucket(item);
  const languageVariant = extractLanguageVariant(item);

  if (!sizeBucket && !resolution && !quality) return null;

  const isSeries = isSeriesContext(options);
  const episodeKey = isSeries ? getSeasonEpisodeKey(options) : '';
  const scope = isSeries ? `series:${episodeKey || 'unknown'}` : 'movie';
  const sig = stableSmartSignature([scope, filenameKey, languageVariant ? `lang:${languageVariant}` : '', sizeBucket, resolution, quality, encode, releaseGroup]);
  return sig ? `smartDetect:${sig}` : null;
}

function buildDedupeKeys(item = {}, options = {}) {
  if (isForcedTorrentioKeep(item)) {
    const hash = extractInfoHash(item);
    const isSeries = isSeriesContext(options);
    const fileIdx = extractFileIdx(item);
    const forcedKey = getForcedTorrentioExactKey(item, options);
    const keys = forcedKey ? [forcedKey] : [];
    const payloadKey = getForcedTorrentioMoviePayloadKey(item, options);
    if (payloadKey) keys.push(payloadKey);
    if (hash && !isSeries) keys.push(`infoHash:${hash}`);
    if (hash && isSeries && fileIdx !== null) keys.push(`infoHashFile:${hash}:${fileIdx}`);
    return [...new Set(keys)];
  }

  const hash = extractInfoHash(item);
  const smartKey = normalizeStoredSmartDedupeKey(item) || buildSmartDedupeKey(item, options);
  if (!hash) return smartKey ? [smartKey] : [];

  const keys = [];
  const isSeries = isSeriesContext(options);
  const fileIdx = extractFileIdx(item);
  const hintIdx = parseIntegerId(item?.episodeFileHint?.fileIdx ?? item?.episodeFileHint?.fileIndex ?? item?._episodeFileHint?.fileIdx ?? item?._episodeFileHint?.fileIndex);
  const episodeKey = getSeasonEpisodeKey(options);
  const filenameKey = extractFilename(item);
  const languageVariant = extractLanguageVariant(item);
  const languageSuffix = languageVariant ? `:lang:${languageVariant}` : '';

  if (!isSeries) {
    // Movie infohashes stay strict, but keep explicit language variants separated
    // when providers expose ITA/JP/ENG versions through the same synthetic host id.
    keys.push(`infoHash:${hash}${languageSuffix}`);
  } else {
    if (fileIdx !== null) keys.push(`infoHashFile:${hash}:${fileIdx}${languageSuffix}`);
    if (hintIdx !== null) keys.push(`infoHashFile:${hash}:${hintIdx}${languageSuffix}`);
    if (fileIdx === null && hintIdx === null && episodeKey) keys.push(`infoHashEpisode:${hash}:${episodeKey}${languageSuffix}`);
    if (fileIdx === null && hintIdx === null && !episodeKey) keys.push(`infoHashNoFile:${hash}${languageSuffix}`);
  }


  if (isSeries && filenameKey && fileIdx === null && hintIdx === null) {
    keys.push(`infoHashFilename:${hash}:${filenameKey}${languageSuffix}`);
  }


  if (smartKey && (!isSeries || (fileIdx === null && hintIdx === null))) {
    keys.push(smartKey);
  }

  return [...new Set(keys)];
}

function cacheTier(item = {}) {
  const state = getKnownCacheState(item);
  const nameTitle = `${item?.name || ''} ${item?.title || ''}`;
  if (item?.isSavedCloud || item?._savedCloud || item?.savedCloud || item?.behaviorHints?.savedCloud) return 7;
  if (/⚡/.test(nameTitle) || state === 'cached') return 6;
  if (state === 'likely_cached') return 5;
  if (state === 'probing') return 2;
  if (state === 'likely_uncached') return 1;
  if (state === 'uncached_terminal') return 0;
  return 3;
}

function isTorrentioLike(item = {}) {
  if (isForcedTorrentioKeep(item)) return true;
  const text = String(`${item?.source || ''} ${item?.provider || ''} ${item?.externalAddon || ''} ${item?.externalGroup || ''} ${item?.name || ''} ${item?.title || ''}`).toLowerCase();
  return /torrentio/.test(text);
}

function isDbLike(item = {}) {
  if (item?._localDb === true || item?._sourceGroup === 'local_db') return true;
  const text = String(`${item?.source || ''} ${item?.provider || ''} ${item?.externalAddon || ''} ${item?.externalGroup || ''} ${item?.name || ''} ${item?.title || ''}`).toLowerCase();
  return /\b(db|database|leviathandb|saved)\b/.test(text);
}

function isManualContributionSourceText(value = '') {
  const text = String(value || '').trim().toLowerCase();
  return /(?:leviathan[_\s-]*companion|manual|bt4g|b\d+gprx|downloadtorrentfile)/i.test(text);
}

function isManualContributionItem(item = {}) {
  const values = [
    item?.source,
    item?.provider,
    item?.providerId,
    item?.sourceName,
    item?.externalAddon,
    item?.externalGroup,
    item?._dbProvider,
    item?.behaviorHints?.vortexSource,
    item?.behaviorHints?.vortexMeta?.provider,
    item?.behaviorHints?.vortexMeta?.source
  ];
  return values.some(isManualContributionSourceText);
}

function normalizeSourceLabel(value) {
  const text = String(value || '').trim();
  if (!text || /^(unknown|n\/a|null|undefined)$/i.test(text)) return '';
  // Manual companion/import sources are intentionally not merged into duplicate labels.
  // If the infoHash already exists from another provider, the manual source must stay hidden.
  if (isManualContributionSourceText(text)) return '';
  return text.slice(0, 48);
}

function pushSourceLabel(labels, seen, value) {
  const normalized = normalizeSourceLabel(value);
  if (!normalized) return;
  const key = normalized.toLowerCase();
  if (seen.has(key)) return;
  seen.add(key);
  labels.push(normalized);
}

function collectSourceLabels(items = []) {
  const labels = [];
  const seen = new Set();
  for (const item of items.flat().filter(Boolean)) {
    pushSourceLabel(labels, seen, item?.source);
    pushSourceLabel(labels, seen, item?.provider);
    pushSourceLabel(labels, seen, item?.providerId);
    pushSourceLabel(labels, seen, item?.sourceName);
    pushSourceLabel(labels, seen, item?.externalAddon);
    pushSourceLabel(labels, seen, item?.externalGroup);
    pushSourceLabel(labels, seen, item?.behaviorHints?.vortexSource);
    pushSourceLabel(labels, seen, item?.behaviorHints?.vortexMeta?.provider);
    pushSourceLabel(labels, seen, item?.behaviorHints?.vortexMeta?.source);
    for (const source of Array.isArray(item?._dedupeMergedSources) ? item._dedupeMergedSources : []) {
      pushSourceLabel(labels, seen, source);
    }
    for (const source of Array.isArray(item?._dedupeEvidence?.sources) ? item._dedupeEvidence.sources : []) {
      pushSourceLabel(labels, seen, source);
    }
  }
  return labels;
}

function collectMergedCount(items = [], fallback = 1) {
  let count = Number(fallback) || 1;
  for (const item of items.flat().filter(Boolean)) {
    const direct = Number(item?._dedupeMergedCount || item?._dedupeEvidence?.mergedCount || 0);
    if (Number.isFinite(direct) && direct > count) count = direct;
  }
  return count;
}

function sourcePriority(item = {}, options = {}) {
  const text = String(`${item?.source || ''} ${item?.provider || ''} ${item?.externalAddon || ''} ${item?.externalGroup || ''} ${item?.name || ''} ${item?.title || ''}`).toLowerCase();
  const isSeries = isSeriesContext(options);
  if (isManualContributionItem(item)) return 1;
  if (isSeries && isTorrentioLike(item)) return 45;
  if (/mediafusion/.test(text)) return 25;
  if (isDbLike(item)) return isSeries ? 5 : 18;
  return 15;
}

function playablePriority(item = {}) {
  const url = String(item?.url || '');
  if (/^https?:\/\//i.test(url) && !/\/play_lazy\//i.test(url)) return 20;
  if (url) return 5;
  return 0;
}

function getSeederCount(item = {}) {
  const explicit = parseInt(item?.seeders ?? item?.peers ?? item?.seeds ?? item?.seedCount ?? '', 10);
  if (Number.isFinite(explicit) && explicit > 0) return explicit;
  const text = `${item?.name || ''}\n${item?.title || ''}`;
  const match = text.match(/(?:👥|seed(?:er)?s?\s*[:=]?|seeds?\s*[:=]?)\s*([0-9]{1,6})/i);
  return match ? parseInt(match[1], 10) || 0 : 0;
}

function choiceScore(item = {}, options = {}) {
  const explicitScore = Number(item?._compositeScore || item?._score || item?._dedupeScore || 0) || 0;
  const fileIdxBonus = extractFileIdx(item) !== null ? 20_000 : 0;
  const packHintBonus = item?.episodeFileHint || item?._episodeFileHint ? 50_000 : 0;
  const folderSignalBonus = getFolderSizeBytes(item) > getSizeBytes(item) * 2 ? 2_500 : 0;
  return cacheTier(item) * 1_000_000
    + sourcePriority(item, options) * 10_000
    + playablePriority(item) * 1_000
    + fileIdxBonus
    + packHintBonus
    + folderSignalBonus
    + Math.min(5000, Math.max(0, getSeederCount(item))) * 5
    + Math.min(5000, Math.floor((getSizeBytes(item) || 0) / (1024 * 1024)))
    + Math.max(-100000, Math.min(100000, explicitScore));
}

function preferItem(next, current, options = {}) {
  const nextScore = choiceScore(next, options);
  const currentScore = choiceScore(current, options);
  if (nextScore !== currentScore) return nextScore > currentScore;
  const nextSize = getSizeBytes(next);
  const currentSize = getSizeBytes(current);
  if (nextSize !== currentSize) return nextSize > currentSize;
  return false;
}

function mergeSignals(winner = {}, losers = [], hash = null, evidence = {}) {
  const out = { ...winner };
  const allLosers = Array.isArray(losers) ? losers : [losers];
  const evidenceItems = [winner, ...allLosers].filter(Boolean);
  const normalizedHash = hash || extractInfoHash(winner) || allLosers.map(extractInfoHash).find(Boolean);
  const bestState = bestKnownCacheState(winner, allLosers);
  const mergedSources = collectSourceLabels(evidenceItems);
  const mergedCount = collectMergedCount(evidenceItems, Number(evidence.groupSize || evidenceItems.length || 1));

  if (normalizedHash) {
    out.infoHash = out.infoHash || normalizedHash;
    out.hash = out.hash || normalizedHash;
  }

  if (mergedSources.length > 0) {
    out._dedupeMergedSources = mergedSources;
  }
  if (mergedCount > 1) {
    out._dedupeMergedCount = mergedCount;
  }
  if (mergedSources.length > 0 || mergedCount > 1 || bestState) {
    out._dedupeEvidence = {
      ...(out._dedupeEvidence || {}),
      sources: mergedSources,
      mergedCount,
      cacheState: bestState || out._dedupeEvidence?.cacheState || undefined
    };
  }

  if (bestState) {
    out._rdCacheState = bestState;
    out.rdCacheState = bestState;
    out.cacheState = bestState;
    if (bestState === 'cached') {
      out.cached = true;
      out.cached_rd = out.cached_rd === false ? out.cached_rd : true;
      out._dbCachedRd = out._dbCachedRd === false ? out._dbCachedRd : true;
    } else if (bestState === 'likely_cached') {
      if (out.cached !== true && out.cached !== false) out.cached = null;
      out.likely_cached = true;
    }
  }

  for (const loser of allLosers) {
    if (!loser) continue;
    if ((out.fileIdx === undefined || out.fileIdx === null || out.fileIdx === -1) && extractFileIdx(loser) !== null) out.fileIdx = extractFileIdx(loser);
    if ((!out.episodeFileHint || typeof out.episodeFileHint !== 'object') && loser?.episodeFileHint) out.episodeFileHint = loser.episodeFileHint;
    if ((!out._episodeFileHint || typeof out._episodeFileHint !== 'object') && loser?._episodeFileHint) out._episodeFileHint = loser._episodeFileHint;
    if (!out.folderSize && loser?.folderSize) out.folderSize = loser.folderSize;
    if (!out.folder_size && loser?.folder_size) out.folder_size = loser.folder_size;
    if (!out.totalPackSize && loser?.totalPackSize) out.totalPackSize = loser.totalPackSize;
    if (!out._rdCacheState && loser?._rdCacheState) out._rdCacheState = loser._rdCacheState;
    if (!out.rdCacheState && loser?.rdCacheState) out.rdCacheState = loser.rdCacheState;
    if (!out.cacheState && loser?.cacheState) out.cacheState = loser.cacheState;
    if (out._dbCachedRd !== true && loser?._dbCachedRd === true) out._dbCachedRd = true;
    if (out.cached_rd !== true && loser?.cached_rd === true) out.cached_rd = true;
    if (out._tbCached !== true && loser?._tbCached === true) out._tbCached = true;
    if (out.tbCached !== true && loser?.tbCached === true) out.tbCached = true;
    if (out.isCached !== true && loser?.isCached === true) out.isCached = true;
    if (out._mediafusionRdChecked !== true && loser?._mediafusionRdChecked === true) out._mediafusionRdChecked = true;
    if (out._mediafusionRdAuthority !== true && loser?._mediafusionRdAuthority === true) out._mediafusionRdAuthority = true;
    if (out._mediafusionPassthrough !== true && loser?._mediafusionPassthrough === true) out._mediafusionPassthrough = true;
    if (out._nexusBridgeRdChecked !== true && loser?._nexusBridgeRdChecked === true) out._nexusBridgeRdChecked = true;
    if (out._externalRdChecked !== true && loser?._externalRdChecked === true) out._externalRdChecked = true;
    if (out._torrentioRdAuthority !== true && loser?._torrentioRdAuthority === true) out._torrentioRdAuthority = true;
    if (out._torrentioCached !== true && loser?._torrentioCached === true) out._torrentioCached = true;
    if (out._torrentioRdDirect !== true && loser?._torrentioRdDirect === true) out._torrentioRdDirect = true;
    if (!out._rdProof && loser?._rdProof) out._rdProof = loser._rdProof;
    if (!out.directUrl && loser?.directUrl) out.directUrl = loser.directUrl;
    if (!out.externalDirectUrl && loser?.externalDirectUrl) out.externalDirectUrl = loser.externalDirectUrl;
    if (!out._externalDirectUrl && loser?._externalDirectUrl) out._externalDirectUrl = loser._externalDirectUrl;
    if (!out.externalPlayableUrl && loser?.externalPlayableUrl) out.externalPlayableUrl = loser.externalPlayableUrl;
    if (!out._torrentioPlayableUrl && loser?._torrentioPlayableUrl) out._torrentioPlayableUrl = loser._torrentioPlayableUrl;
    if (!out._mediafusionPlayableUrl && loser?._mediafusionPlayableUrl) out._mediafusionPlayableUrl = loser._mediafusionPlayableUrl;
    if (!out._externalOriginalUrl && loser?._externalOriginalUrl) out._externalOriginalUrl = loser._externalOriginalUrl;
    if (out._torrentioPassthrough !== true && loser?._torrentioPassthrough === true) out._torrentioPassthrough = true;
    if (!out.url && loser?.url) out.url = loser.url;
    if (out._localDb !== true && (loser?._localDb === true || loser?._sourceGroup === 'local_db')) out._localDb = true;
    if (!out._sourceGroup && loser?._sourceGroup) out._sourceGroup = loser._sourceGroup;
    if (!out._dbProvider && loser?._dbProvider) out._dbProvider = loser._dbProvider;
    const source = loser?.source || loser?.externalAddon || loser?.provider || null;
    if (source) {
      const refreshedSources = collectSourceLabels([out, { source }]);
      if (refreshedSources.length > 0) {
        out._dedupeMergedSources = refreshedSources;
        out._dedupeEvidence = {
          ...(out._dedupeEvidence || {}),
          sources: refreshedSources,
          mergedCount: out._dedupeMergedCount || mergedCount
        };
      }
    }
  }
  return out;
}

class DSU {
  constructor(size) {
    this.parent = Array.from({ length: size }, (_, i) => i);
    this.rank = Array.from({ length: size }, () => 0);
  }
  find(x) {
    if (this.parent[x] !== x) this.parent[x] = this.find(this.parent[x]);
    return this.parent[x];
  }
  union(a, b) {
    let ra = this.find(a);
    let rb = this.find(b);
    if (ra === rb) return;
    if (this.rank[ra] < this.rank[rb]) [ra, rb] = [rb, ra];
    this.parent[rb] = ra;
    if (this.rank[ra] === this.rank[rb]) this.rank[ra] += 1;
  }
}

function dedupeByInfoHash(items = [], options = {}) {
  const list = Array.isArray(items) ? items : [];
  const enabledValue = options.enabled !== undefined ? options.enabled : process.env.INFOHASH_DEDUPE;
  if (String(enabledValue ?? '1') === '0' || list.length < 2) {
    return { results: list, removed: 0, groups: 0, keyGroups: 0 };
  }

  const dsu = new DSU(list.length);
  const keyToFirstIndex = new Map();
  const keysByIndex = new Array(list.length);
  let keyGroups = 0;

  list.forEach((item, idx) => {
    const keys = buildDedupeKeys(item, options);
    keysByIndex[idx] = keys;
    for (const key of keys) {
      const first = keyToFirstIndex.get(key);
      if (first === undefined) {
        keyToFirstIndex.set(key, idx);
      } else {
        dsu.union(first, idx);
        keyGroups += 1;
      }
    }
  });

  const groups = new Map();
  list.forEach((item, idx) => {
    const keys = keysByIndex[idx];
    if (keys.length === 0) {
      groups.set(`single:${idx}`, [idx]);
      return;
    }
    const root = dsu.find(idx);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(idx);
  });

  const resultsWithOriginalIndex = [];
  let removed = 0;
  let duplicateGroups = 0;

  for (const indexes of groups.values()) {
    if (!Array.isArray(indexes) || indexes.length <= 1) {
      resultsWithOriginalIndex.push({ index: indexes[0], item: list[indexes[0]] });
      continue;
    }

    duplicateGroups += 1;
    removed += indexes.length - 1;
    let winnerIndex = indexes[0];
    for (const idx of indexes.slice(1)) {
      if (preferItem(list[idx], list[winnerIndex], options)) winnerIndex = idx;
    }

    const winner = list[winnerIndex];
    const losers = indexes.filter((idx) => idx !== winnerIndex).map((idx) => list[idx]);
    resultsWithOriginalIndex.push({
      index: Math.min(...indexes),
      item: mergeSignals(winner, losers, extractInfoHash(winner), { groupSize: indexes.length })
    });
  }

  resultsWithOriginalIndex.sort((a, b) => a.index - b.index);
  return {
    results: resultsWithOriginalIndex.map((entry) => entry.item),
    removed,
    groups: duplicateGroups,
    keyGroups
  };
}

module.exports = {
  normalizeInfoHash,
  extractInfoHash,
  extractFileIdx,
  getSizeBytes,
  getFolderSizeBytes,
  buildDedupeKeys,
  buildSmartDedupeKey,
  dedupeByInfoHash,
  normalizeSmartToken
};
