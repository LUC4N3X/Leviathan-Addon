'use strict';

const crypto = require('crypto');

const HLS_URL_RE = /(?:\.m3u8(?:$|[?#])|\/hls\/|\/playlist\/|\/vixsynthetic\.m3u8|\/extractor\/video\.m3u8)/i;
const FILE_EXT_RE = /\.(?:mkv|mp4|avi|mov|webm|m4v|ts|m2ts|mpg|mpeg|flv|wmv|m3u8|mpd)(?:$|[?#])/i;
const SIZE_RE = /(\d+(?:[.,]\d+)?)\s*(tib|tb|gib|gb|mib|mb|kib|kb)\b/i;

function safeString(value) {
  return typeof value === 'string' ? value : value === null || value === undefined ? '' : String(value);
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function compactObject(value) {
  const out = {};
  Object.entries(value || {}).forEach(([key, entry]) => {
    if (entry === undefined || entry === null || entry === '') return;
    if (Number.isNaN(entry)) return;
    out[key] = entry;
  });
  return out;
}

function normalizeSpaces(value) {
  return safeString(value).replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function shaPart(value, length = 12) {
  const text = safeString(value).trim();
  if (!text) return '';
  return crypto.createHash('sha1').update(text).digest('hex').slice(0, length);
}

function cleanGroupPart(value, fallback = '') {
  const out = normalizeSpaces(value)
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9._+-]+/gi, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 56);
  return out || fallback;
}

function parseSizeBytes(value) {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) return Math.floor(value);
  const raw = safeString(value).trim();
  if (!raw) return 0;
  const numeric = Number(raw);
  if (Number.isFinite(numeric) && numeric > 0) return Math.floor(numeric);
  const match = raw.match(SIZE_RE);
  if (!match) return 0;
  const amount = Number.parseFloat(match[1].replace(',', '.'));
  if (!Number.isFinite(amount) || amount <= 0) return 0;
  const unit = match[2].toLowerCase();
  if (unit === 'tib' || unit === 'tb') return Math.floor(amount * 1024 ** 4);
  if (unit === 'gib' || unit === 'gb') return Math.floor(amount * 1024 ** 3);
  if (unit === 'mib' || unit === 'mb') return Math.floor(amount * 1024 ** 2);
  return Math.floor(amount * 1024);
}

function decodePathPart(value) {
  try {
    return decodeURIComponent(value);
  } catch (_) {
    return value;
  }
}

function filenameFromUrl(url) {
  const raw = safeString(url).trim();
  if (!raw) return '';
  try {
    const parsed = new URL(raw);
    const last = parsed.pathname.split('/').filter(Boolean).pop() || '';
    return decodePathPart(last);
  } catch (_) {
    const clean = raw.split(/[?#]/)[0];
    return decodePathPart(clean.split('/').filter(Boolean).pop() || '');
  }
}

function cleanFilename(value) {
  const text = normalizeSpaces(value)
    .replace(/^attachment;?\s*/i, '')
    .replace(/^filename\*?=UTF-8''/i, '')
    .replace(/^filename\*?=/i, '')
    .replace(/^['"]+|['"]+$/g, '')
    .trim();
  if (!text) return '';
  if (FILE_EXT_RE.test(text)) return text.slice(0, 220);
  return text.slice(0, 220);
}

function firstTextLine(stream) {
  const values = [
    stream?.behaviorHints?.filename,
    stream?.filename,
    stream?.fileName,
    stream?.file_title,
    stream?.title,
    stream?.name,
    stream?.description
  ];
  for (const value of values) {
    const text = normalizeSpaces(value);
    if (text) return text;
  }
  return '';
}

function inferFilename(stream = {}, meta = {}, index = 0) {
  const hints = isPlainObject(stream.behaviorHints) ? stream.behaviorHints : {};
  const direct = cleanFilename(hints.filename || stream.filename || stream.fileName || stream.file_title || stream.fileTitle);
  if (direct) return direct;
  const urlFile = cleanFilename(filenameFromUrl(stream.url));
  if (urlFile && FILE_EXT_RE.test(urlFile)) return urlFile;
  const text = firstTextLine(stream);
  if (text) return cleanFilename(text);
  const base = cleanGroupPart(meta?.title || meta?.name || meta?.id || meta?.imdb_id || stream.infoHash || `leviathan-${index + 1}`, `leviathan-${index + 1}`);
  return `${base}.video`;
}

function inferInfoHash(stream = {}, hints = {}) {
  const candidates = [
    stream.infoHash,
    stream.hash,
    stream.infohash,
    hints.infoHash,
    hints.infohash,
    hints.videoHash,
    hints.hash,
    hints.btih
  ];
  for (const value of candidates) {
    const raw = safeString(value).trim().toLowerCase();
    const match = raw.match(/[a-f0-9]{40}/i);
    if (match) return match[0].toLowerCase();
  }
  const magnet = safeString(stream.magnet || stream.magnetLink || hints.magnet || '').trim();
  const match = magnet.match(/btih:([a-f0-9]{40})/i) || magnet.match(/[?&]xt=urn:btih:([a-f0-9]{40})/i);
  return match ? match[1].toLowerCase() : '';
}

function inferFileIdx(stream = {}, hints = {}) {
  const values = [stream.fileIdx, stream.fileIndex, stream.file_index, hints.fileIdx, hints.fileIndex, hints.file_index];
  for (const value of values) {
    const parsed = Number.parseInt(value, 10);
    if (Number.isInteger(parsed) && parsed >= 0) return parsed;
  }
  return null;
}

function inferQuality(text = '') {
  const raw = safeString(text).toLowerCase();
  if (/\b(?:4320p|8k)\b/.test(raw)) return '8K';
  if (/\b(?:2160p|4k|uhd)\b/.test(raw)) return '4K';
  if (/\b1080p\b/.test(raw)) return '1080p';
  if (/\b720p\b/.test(raw)) return '720p';
  if (/\b(?:576p|480p|sd)\b/.test(raw)) return 'SD';
  return 'Auto';
}

function inferService(stream = {}, hints = {}) {
  const text = normalizeSpaces([
    stream.service,
    stream.source,
    stream.provider,
    hints.service,
    hints.vortexSource,
    stream.name,
    stream.title
  ].filter(Boolean).join(' ')).toLowerCase();
  if (/\b(?:real[-\s]?debrid|rd)\b/.test(text)) return 'RD';
  if (/\b(?:torbox|tb)\b/.test(text)) return 'TB';
  if (/\b(?:p2p|torrent)\b/.test(text)) return 'P2P';
  if (/\b(?:web|streamingcommunity|cb01|guardahd|vidxgo|eurostreaming)\b/.test(text)) return 'WEB';
  return 'AUTO';
}

function inferReleaseGroup(filename = '') {
  const clean = safeString(filename).replace(/\.[a-z0-9]{2,5}$/i, ' ');
  const match = clean.match(/-\s*([A-Za-z0-9][A-Za-z0-9._-]{1,40})\s*$/) || clean.match(/[\[(]([A-Za-z0-9][A-Za-z0-9._-]{1,40})[\])]\s*$/);
  if (!match) return '';
  const group = match[1];
  if (/^(ita|eng|multi|sub|subs|aac|ac3|eac3|dts|webrip|webdl|web-dl|bluray|hdtv|dvdrip|bdrip)$/i.test(group)) return '';
  return group;
}

function buildFallbackBingeGroup(stream = {}, meta = {}, index = 0, filename = '', infoHash = '', hints = {}) {
  const existing = normalizeSpaces(hints.bingeGroup || hints.bingieGroup || stream.bingeGroup);
  if (existing) return existing.slice(0, 220);
  const text = firstTextLine(stream);
  const type = cleanGroupPart(meta?.type || meta?.stremioType || 'stream', 'stream');
  const id = cleanGroupPart(meta?.imdb_id || meta?.kitsu_id || meta?.tmdb_id || meta?.id || stream.id || 'unknown', 'unknown');
  const service = inferService(stream, hints);
  const quality = inferQuality(`${filename} ${text}`);
  const release = cleanGroupPart(inferReleaseGroup(filename), 'release');
  const hash = infoHash ? infoHash.slice(0, 12) : shaPart(`${filename}|${text}|${index}`, 12);
  return ['Leviathan', type, id, service, quality, release, hash].map((part) => cleanGroupPart(part, 'x')).join('|').slice(0, 220);
}

function isHlsStream(stream = {}) {
  if (/^hls$/i.test(safeString(stream.type))) return true;
  if (/^hls$/i.test(safeString(stream.streamType))) return true;
  return HLS_URL_RE.test(safeString(stream.url));
}

function normalizeClientCompatibleStream(stream, index = 0, context = {}) {
  if (!isPlainObject(stream)) return stream;
  const out = { ...stream };
  const hints = isPlainObject(stream.behaviorHints) ? { ...stream.behaviorHints } : {};
  const filename = inferFilename(stream, context.meta || {}, index);
  const infoHash = inferInfoHash(stream, hints);
  const fileIdx = inferFileIdx(stream, hints);
  const videoSize = parseSizeBytes(hints.videoSize || hints.sizeBytes || out.videoSize || out.video_size || out.sizeBytes || out.size || out.folderSize || hints.folderSize);
  const bingeGroup = buildFallbackBingeGroup(stream, context.meta || {}, index, filename, infoHash, hints);

  hints.filename = filename;
  hints.bingeGroup = bingeGroup;
  hints.bingieGroup = bingeGroup;

  if (infoHash) {
    out.infoHash = out.infoHash || infoHash;
    hints.infoHash = hints.infoHash || infoHash;
    hints.videoHash = hints.videoHash || infoHash;
  }

  if (fileIdx !== null) {
    out.fileIdx = out.fileIdx === undefined ? fileIdx : out.fileIdx;
    hints.fileIdx = hints.fileIdx === undefined ? fileIdx : hints.fileIdx;
  }

  if (videoSize > 0) hints.videoSize = videoSize;
  if (typeof hints.notWebReady !== 'boolean') hints.notWebReady = Boolean(infoHash && !out.url);
  if (isHlsStream(out) && !out.type) out.type = 'hls';

  out.behaviorHints = compactObject(hints);
  return out;
}

function normalizeClientCompatibleStreams(streams = [], context = {}) {
  if (!Array.isArray(streams)) return [];
  return streams.map((stream, index) => normalizeClientCompatibleStream(stream, index, context));
}

module.exports = {
  normalizeClientCompatibleStream,
  normalizeClientCompatibleStreams,
  __private: {
    parseSizeBytes,
    inferFilename,
    inferInfoHash,
    isHlsStream,
    buildFallbackBingeGroup
  }
};
