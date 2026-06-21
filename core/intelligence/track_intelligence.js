const crypto = require('crypto');

const LANG_MAP = new Map([
  ['it', 'ita'], ['ita', 'ita'], ['italian', 'ita'], ['italiano', 'ita'],
  ['en', 'eng'], ['eng', 'eng'], ['english', 'eng'],
  ['ja', 'jpn'], ['jp', 'jpn'], ['jpn', 'jpn'], ['jap', 'jpn'], ['japanese', 'jpn'],
  ['fr', 'fra'], ['fre', 'fra'], ['fra', 'fra'], ['french', 'fra'],
  ['de', 'deu'], ['ger', 'deu'], ['deu', 'deu'], ['german', 'deu'],
  ['es', 'esp'], ['spa', 'esp'], ['esp', 'esp'], ['spanish', 'esp'],
  ['pt', 'por'], ['por', 'por'], ['br', 'por'], ['portuguese', 'por'],
  ['ru', 'rus'], ['rus', 'rus'], ['russian', 'rus'],
  ['ko', 'kor'], ['kor', 'kor'], ['korean', 'kor'],
  ['zh', 'chi'], ['chi', 'chi'], ['zho', 'chi'], ['chinese', 'chi'],
  ['hi', 'hin'], ['hin', 'hin'], ['hindi', 'hin']
]);

const LANG_LABELS = {
  ita: 'ITA', eng: 'ENG', jpn: 'JPN', fra: 'FRA', deu: 'DEU', esp: 'ESP', por: 'POR', rus: 'RUS', kor: 'KOR', chi: 'CHI', hin: 'HIN'
};

const LANG_FLAGS = {
  ita: '🇮🇹', eng: '🇬🇧', jpn: '🇯🇵', fra: '🇫🇷', deu: '🇩🇪', esp: '🇪🇸', por: '🇵🇹', rus: '🇷🇺', kor: '🇰🇷', chi: '🇨🇳', hin: '🇮🇳'
};

const DEFAULT_SUCCESS_TTL_SECONDS = 14 * 24 * 60 * 60;
const DEFAULT_UNSUPPORTED_TTL_SECONDS = 7 * 24 * 60 * 60;
const DEFAULT_ERROR_TTL_SECONDS = 6 * 60 * 60;
const DEFAULT_TIMEOUT_TTL_SECONDS = 2 * 60 * 60;
const DEFAULT_FORBIDDEN_TTL_SECONDS = 24 * 60 * 60;

const MEMORY = new Map();
const INFLIGHT = new Set();
const QUEUE = [];
let active = 0;
let getTracksDataLoader = null;

function boolEnv(name, fallback = false) {
  const raw = process.env[name];
  if (raw === undefined || raw === null || raw === '') return fallback;
  const value = String(raw).trim().toLowerCase();
  if (['1', 'true', 'yes', 'y', 'on'].includes(value)) return true;
  if (['0', 'false', 'no', 'n', 'off'].includes(value)) return false;
  return fallback;
}

function intEnv(name, fallback, min, max) {
  const parsed = Number.parseInt(process.env[name] || String(fallback), 10);
  const safe = Number.isFinite(parsed) ? parsed : fallback;
  return Math.max(min, Math.min(max, safe));
}

function getConfig() {
  return {
    enabled: boolEnv('LEVIATHAN_TRACK_PROBE_ENABLED', true),
    maxConcurrent: intEnv('LEVIATHAN_TRACK_PROBE_CONCURRENCY', 2, 1, 8),
    timeoutMs: intEnv('LEVIATHAN_TRACK_PROBE_TIMEOUT_MS', 5500, 1000, 20000),
    maxBytesLimit: intEnv('LEVIATHAN_TRACK_PROBE_MAX_BYTES', 15000000, 1000000, 80000000),
    memoryLimit: intEnv('LEVIATHAN_TRACK_PROBE_MEMORY_LIMIT', 2000, 100, 20000),
    successTtlSeconds: intEnv('LEVIATHAN_TRACK_PROBE_SUCCESS_TTL_SECONDS', DEFAULT_SUCCESS_TTL_SECONDS, 3600, 60 * 24 * 60 * 60),
    unsupportedTtlSeconds: intEnv('LEVIATHAN_TRACK_PROBE_UNSUPPORTED_TTL_SECONDS', DEFAULT_UNSUPPORTED_TTL_SECONDS, 3600, 60 * 24 * 60 * 60),
    errorTtlSeconds: intEnv('LEVIATHAN_TRACK_PROBE_ERROR_TTL_SECONDS', DEFAULT_ERROR_TTL_SECONDS, 300, 7 * 24 * 60 * 60),
    timeoutTtlSeconds: intEnv('LEVIATHAN_TRACK_PROBE_TIMEOUT_TTL_SECONDS', DEFAULT_TIMEOUT_TTL_SECONDS, 300, 24 * 60 * 60),
    forbiddenTtlSeconds: intEnv('LEVIATHAN_TRACK_PROBE_FORBIDDEN_TTL_SECONDS', DEFAULT_FORBIDDEN_TTL_SECONDS, 3600, 7 * 24 * 60 * 60)
  };
}

function nowMs() {
  return Date.now();
}

function safeString(value) {
  if (value === null || value === undefined) return '';
  return String(value);
}

function normalizeSpaces(value) {
  return safeString(value).replace(/[\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function sha256(value) {
  return crypto.createHash('sha256').update(safeString(value)).digest('hex');
}

function normalizeInfoHash(value) {
  const normalized = safeString(value).trim().toLowerCase();
  return /^[a-f0-9]{40}$/.test(normalized) ? normalized : '';
}

function normalizeFileIdx(value) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : -1;
}

function normalizeSize(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 0;
}

function normalizeService(value) {
  const normalized = safeString(value).trim().toLowerCase();
  if (normalized === 'real-debrid' || normalized === 'realdebrid') return 'rd';
  if (normalized === 'torbox') return 'tb';
  if (['rd', 'tb', 'web', 'external', 'torrentio', 'mediafusion'].includes(normalized)) return normalized;
  return normalized || 'unknown';
}

function stripUrlSecrets(url) {
  try {
    const parsed = new URL(String(url));
    return `${parsed.protocol}//${parsed.host}${parsed.pathname}`;
  } catch (_) {
    return safeString(url).split('?')[0].split('#')[0];
  }
}

function buildTrackProbeKey(input = {}) {
  const service = normalizeService(input.service || input.serviceTag);
  const infoHash = normalizeInfoHash(input.infoHash || input.hash || input.info_hash);
  const fileIdx = normalizeFileIdx(input.fileIdx ?? input.fileIndex ?? input.file_id ?? input.fileId);
  const size = normalizeSize(input.fileSize ?? input.sizeBytes ?? input.size);
  const filename = normalizeSpaces(input.filename || input.fileName || input.title || '').toLowerCase();

  if (infoHash) return `track:v1:${service}:${infoHash}:${fileIdx}:${size || 0}`;

  const cleanUrl = stripUrlSecrets(input.url || input.directUrl || input.streamUrl || '');
  if (!cleanUrl && !filename) return '';
  return `track:v1:${service}:url:${sha256(`${cleanUrl}|${filename}|${size || 0}`)}`;
}

function setMemory(cacheKey, entry, ttlSeconds, config = getConfig()) {
  if (!cacheKey || !entry) return null;
  if (MEMORY.has(cacheKey)) MEMORY.delete(cacheKey);
  MEMORY.set(cacheKey, { ...entry, expiresAt: nowMs() + Math.max(60, ttlSeconds || 60) * 1000 });
  while (MEMORY.size > config.memoryLimit) {
    const firstKey = MEMORY.keys().next().value;
    MEMORY.delete(firstKey);
  }
  return entry;
}

function getMemory(cacheKey) {
  if (!cacheKey || !MEMORY.has(cacheKey)) return null;
  const entry = MEMORY.get(cacheKey);
  if (!entry || entry.expiresAt <= nowMs()) {
    MEMORY.delete(cacheKey);
    return null;
  }
  MEMORY.delete(cacheKey);
  MEMORY.set(cacheKey, entry);
  return entry;
}

function getCachedTrackHintsSync(input = {}) {
  const cacheKey = input.cacheKey || buildTrackProbeKey(input);
  const entry = getMemory(cacheKey);
  if (!entry || entry.status !== 'success' || !entry.normalized) return null;
  return entry.normalized;
}

function normalizeLang(value) {
  const raw = normalizeSpaces(value).toLowerCase();
  if (!raw || raw === 'und' || raw === 'unknown' || raw === 'null') return '';
  if (LANG_MAP.has(raw)) return LANG_MAP.get(raw);
  const letters = raw.replace(/[^a-z]/g, '');
  if (LANG_MAP.has(letters)) return LANG_MAP.get(letters);
  if (letters.length >= 3 && LANG_MAP.has(letters.slice(0, 3))) return LANG_MAP.get(letters.slice(0, 3));
  if (letters.length >= 2 && LANG_MAP.has(letters.slice(0, 2))) return LANG_MAP.get(letters.slice(0, 2));
  return '';
}

function detectLangFromLabel(label = '') {
  const text = normalizeSpaces(label).toLowerCase();
  if (!text) return '';
  const patterns = [
    [/\b(?:ita|italian|italiano|italy)\b/i, 'ita'],
    [/\b(?:eng|english)\b/i, 'eng'],
    [/\b(?:jpn|jap|japanese|japanese)\b/i, 'jpn'],
    [/\b(?:spa|spanish|esp|espanol|español)\b/i, 'esp'],
    [/\b(?:fre|fra|french|francais|français)\b/i, 'fra'],
    [/\b(?:ger|deu|german|deutsch)\b/i, 'deu'],
    [/\b(?:por|portuguese|portugues|brasil)\b/i, 'por'],
    [/\b(?:rus|russian)\b/i, 'rus']
  ];
  for (const [regex, lang] of patterns) {
    if (regex.test(text)) return lang;
  }
  return '';
}

function languageListToFlags(values = []) {
  const flags = [];
  for (const value of values) {
    const lang = normalizeLang(value) || value;
    const flag = LANG_FLAGS[lang];
    if (flag && !flags.includes(flag)) flags.push(flag);
  }
  if (flags.length === 0) return '';
  if (flags.length <= 3) return flags.join(' / ');
  return `${flags[0]} / 🌐`;
}

function languageListToLabels(values = []) {
  const labels = [];
  for (const value of values) {
    const lang = normalizeLang(value) || value;
    const label = LANG_LABELS[lang] || safeString(lang).toUpperCase();
    if (label && !labels.includes(label)) labels.push(label);
  }
  return labels;
}

function normalizeVideoCodec(codec = '', label = '') {
  const text = `${codec} ${label}`.toUpperCase();
  if (/AV1|AOMEDIA/.test(text)) return 'AV1';
  if (/VVC|H\.266|H266|266/.test(text)) return 'VVC';
  if (/HEVC|H\.265|H265|265|MPEGH/.test(text)) return 'HEVC';
  if (/AVC|H\.264|H264|264|MPEG-4 AVC/.test(text)) return 'AVC';
  if (/VP9/.test(text)) return 'VP9';
  if (/VP8/.test(text)) return 'VP8';
  if (/MPEG-2|MPEG2/.test(text)) return 'MPEG2';
  return normalizeSpaces(codec || label).toUpperCase().slice(0, 32);
}

function normalizeAudioCodec(codec = '', label = '') {
  const text = `${codec} ${label}`.toUpperCase();
  if (/TRUEHD/.test(text) && /ATMOS/.test(text)) return 'ATMOS TRUEHD';
  if (/EAC3|E-AC-3|DDP|DD\+|DOLBY DIGITAL PLUS/.test(text) && /ATMOS/.test(text)) return 'ATMOS DDP';
  if (/ATMOS/.test(text)) return 'ATMOS';
  if (/TRUEHD/.test(text)) return 'TRUEHD';
  if (/DTS-HD MA|DTSHDMA|DTS MA/.test(text)) return 'DTS-HD MA';
  if (/DTS-HD HRA|DTSHDHRA/.test(text)) return 'DTS-HD HRA';
  if (/DTS-HD|DTSHD/.test(text)) return 'DTS-HD';
  if (/DTS:X|DTS X/.test(text)) return 'DTS:X';
  if (/\bDTS\b/.test(text)) return 'DTS';
  if (/EAC3|E-AC-3|DDP|DD\+|DOLBY DIGITAL PLUS/.test(text)) return 'DDP';
  if (/AC3|AC-3|DOLBY DIGITAL/.test(text)) return 'AC3';
  if (/AAC/.test(text)) return 'AAC';
  if (/OPUS/.test(text)) return 'OPUS';
  if (/FLAC/.test(text)) return 'FLAC';
  if (/PCM|LPCM/.test(text)) return 'LPCM';
  if (/MP3/.test(text)) return 'MP3';
  return normalizeSpaces(codec || label).toUpperCase().slice(0, 32);
}

function normalizeChannels(label = '') {
  const text = normalizeSpaces(label).toUpperCase();
  const match = text.match(/\b([1-7])(?:[ .]([01]))\b/);
  if (!match) return '';
  return `${match[1]}.${match[2]}`;
}

function unique(values = []) {
  const out = [];
  const seen = new Set();
  for (const value of values) {
    const text = normalizeSpaces(value);
    if (!text) continue;
    const key = text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(text);
  }
  return out;
}

function normalizeTracks(tracks = []) {
  const list = Array.isArray(tracks) ? tracks : [];
  const videoTracks = [];
  const audioTracks = [];
  const subtitleTracks = [];

  for (const track of list) {
    if (!track || typeof track !== 'object') continue;
    const type = normalizeSpaces(track.type).toLowerCase();
    const label = normalizeSpaces(track.label || track.name || track.title || '');
    const codec = normalizeSpaces(track.codec || track.codecId || '');
    const lang = normalizeLang(track.lang || track.language) || detectLangFromLabel(label);
    const item = {
      id: track.id ?? null,
      type,
      lang: lang || null,
      label: label || null,
      codec: codec || null
    };
    if (type === 'video') videoTracks.push(item);
    else if (type === 'audio') audioTracks.push(item);
    else if (type === 'text' || type === 'subtitle' || type === 'subtitles') subtitleTracks.push({ ...item, type: 'text' });
  }

  const audioLanguages = unique(audioTracks.map((track) => track.lang).filter(Boolean));
  const subtitleLanguages = unique(subtitleTracks.map((track) => track.lang).filter(Boolean));
  const firstVideo = videoTracks[0] || null;
  const bestAudio = audioTracks.find((track) => track.lang === 'ita') || audioTracks[0] || null;
  const videoCodec = firstVideo ? normalizeVideoCodec(firstVideo.codec, firstVideo.label) : '';
  const audioCodec = bestAudio ? normalizeAudioCodec(bestAudio.codec, bestAudio.label) : '';
  const audioChannels = bestAudio ? normalizeChannels(bestAudio.label) : '';
  const hasAtmos = audioTracks.some((track) => /ATMOS/i.test(`${track.codec || ''} ${track.label || ''}`));

  const normalized = {
    source: 'probe',
    confidence: list.length > 0 ? 100 : 0,
    videoCodec,
    audioCodec,
    audioChannels,
    audioLanguages,
    subtitleLanguages,
    languageFlags: languageListToFlags(audioLanguages.length ? audioLanguages : subtitleLanguages),
    languageLabels: languageListToLabels(audioLanguages),
    subtitleLabels: languageListToLabels(subtitleLanguages),
    hasItalianAudio: audioLanguages.includes('ita'),
    hasItalianSubtitles: subtitleLanguages.includes('ita'),
    hasMultiAudio: audioLanguages.length > 1,
    hasAtmos,
    tracks: {
      video: videoTracks,
      audio: audioTracks,
      subtitles: subtitleTracks
    }
  };

  normalized.scorePatch = buildScorePatch(normalized);
  return normalized;
}

function buildScorePatch(normalized = {}) {
  let score = 0;
  const reasons = [];
  if (normalized.hasItalianAudio) { score += 35; reasons.push('probe_audio_ita'); }
  if (normalized.hasMultiAudio && normalized.hasItalianAudio) { score += 12; reasons.push('probe_multi_audio_ita'); }
  if (normalized.hasItalianSubtitles) { score += 10; reasons.push('probe_sub_ita'); }
  if (/^(?:AC3|DDP|DTS|DTS-HD|DTS-HD MA|TRUEHD|ATMOS|ATMOS DDP|ATMOS TRUEHD)$/i.test(normalized.audioCodec || '')) { score += 8; reasons.push('probe_audio_quality'); }
  if (normalized.audioChannels === '5.1' || normalized.audioChannels === '7.1') { score += 6; reasons.push('probe_surround'); }
  if (normalized.hasAtmos) { score += 8; reasons.push('probe_atmos'); }
  return { score, reasons };
}

function isProbeableUrl(url, filename = '', service = '') {
  const raw = safeString(url).trim();
  if (!/^https?:\/\//i.test(raw)) return false;
  if (/\/(?:play_lazy|play_saved_cloud|add_to_cloud|configure|manifest|levi_proxy\/content)\//i.test(raw)) return false;
  const clean = stripUrlSecrets(raw).toLowerCase();
  const file = safeString(filename).toLowerCase();
  if (/\.(?:mkv|mp4|m4v)(?:$|[?#])/i.test(clean) || /\.(?:mkv|mp4|m4v)$/i.test(file)) return true;
  return ['rd', 'tb', 'external', 'torrentio', 'mediafusion'].includes(normalizeService(service));
}

function loadGetTracksData() {
  if (getTracksDataLoader) return getTracksDataLoader;
  getTracksDataLoader = Promise.resolve().then(() => {
    const mod = require('get-tracks-data');
    return mod?.default || mod;
  });
  return getTracksDataLoader;
}

function withTimeout(promise, timeoutMs) {
  let timer = null;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('track_probe_timeout')), timeoutMs);
      timer.unref?.();
    })
  ]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

function classifyError(error) {
  const message = safeString(error?.message || error).toLowerCase();
  if (/timeout|aborted|abort/.test(message)) return 'timeout';
  if (/403|401|forbidden|unauthorized|range|content-range/.test(message)) return 'forbidden_or_range';
  if (/unsupported|invalid|parse|format|moov|ebml|not.+mkv|not.+mp4/.test(message)) return 'unsupported';
  return 'network_or_probe_error';
}

function ttlForStatus(status, config, errorCode = '') {
  if (status === 'success') return config.successTtlSeconds;
  if (status === 'unsupported') return config.unsupportedTtlSeconds;
  if (errorCode === 'timeout') return config.timeoutTtlSeconds;
  if (errorCode === 'forbidden_or_range') return config.forbiddenTtlSeconds;
  return config.errorTtlSeconds;
}

function rowToMemoryEntry(row) {
  if (!row) return null;
  return {
    status: row.status || 'unknown',
    normalized: row.normalized_json || null,
    tracks: row.tracks_json || [],
    scorePatch: row.score_patch_json || null,
    errorCode: row.error_code || null
  };
}

function hydrateMemoryFromDb(cacheKey, row, config) {
  const entry = rowToMemoryEntry(row);
  if (!entry) return null;
  const expires = row.expires_at ? new Date(row.expires_at).getTime() : 0;
  const ttlSeconds = expires > nowMs() ? Math.max(60, Math.floor((expires - nowMs()) / 1000)) : 60;
  return setMemory(cacheKey, entry, ttlSeconds, config);
}

function scheduleTrackProbe(input = {}) {
  const config = getConfig();
  if (!config.enabled) return false;

  const cacheKey = input.cacheKey || buildTrackProbeKey(input);
  const service = normalizeService(input.service || input.serviceTag);
  const url = safeString(input.url || input.directUrl || input.streamUrl || '').trim();
  const filename = normalizeSpaces(input.filename || input.fileName || input.fileTitle || input.title || '');

  if (!cacheKey || !url || !isProbeableUrl(url, filename, service)) return false;
  const cached = getMemory(cacheKey);
  if (cached) return false;
  if (INFLIGHT.has(cacheKey)) return false;

  INFLIGHT.add(cacheKey);
  QUEUE.push({ ...input, cacheKey, service, url, filename, config });
  drainQueue();
  return true;
}

function drainQueue() {
  const config = getConfig();
  while (active < config.maxConcurrent && QUEUE.length > 0) {
    const job = QUEUE.shift();
    active += 1;
    setImmediate(() => {
      runTrackProbeJob(job).catch(() => {}).finally(() => {
        active -= 1;
        INFLIGHT.delete(job.cacheKey);
        drainQueue();
      });
    });
  }
}

async function runTrackProbeJob(job) {
  const dbHelper = job.dbHelper || null;
  const logger = job.logger || console;
  const config = job.config || getConfig();

  if (dbHelper && typeof dbHelper.getTrackProbeCache === 'function') {
    const row = await dbHelper.getTrackProbeCache(job.cacheKey);
    if (row) {
      const entry = hydrateMemoryFromDb(job.cacheKey, row, config);
      if (entry) return entry;
    }
  }

  let status = 'error';
  let tracks = [];
  let normalized = null;
  let errorCode = null;

  try {
    const getTracksData = await loadGetTracksData();
    tracks = await withTimeout(getTracksData(job.url, { maxBytesLimit: config.maxBytesLimit }), config.timeoutMs);
    normalized = normalizeTracks(tracks);
    status = normalized && (normalized.tracks.video.length || normalized.tracks.audio.length || normalized.tracks.subtitles.length) ? 'success' : 'unsupported';
  } catch (error) {
    errorCode = classifyError(error);
    status = errorCode === 'unsupported' ? 'unsupported' : 'error';
    if (logger && typeof logger.debug === 'function') {
      logger.debug(`[TRACK PROBE] skip key=${job.cacheKey.slice(0, 24)} status=${status} code=${errorCode}`);
    }
  }

  const ttlSeconds = ttlForStatus(status, config, errorCode);
  const entry = {
    status,
    normalized,
    tracks,
    scorePatch: normalized?.scorePatch || null,
    errorCode
  };
  setMemory(job.cacheKey, entry, ttlSeconds, config);

  if (dbHelper && typeof dbHelper.upsertTrackProbeCache === 'function') {
    await dbHelper.upsertTrackProbeCache({
      cacheKey: job.cacheKey,
      service: job.service,
      infoHash: job.infoHash || job.hash || job.info_hash,
      fileIdx: job.fileIdx ?? job.fileIndex,
      fileSize: job.fileSize ?? job.sizeBytes ?? job.size,
      filename: job.filename,
      url: job.url,
      status,
      tracks,
      normalized,
      scorePatch: normalized?.scorePatch || null,
      errorCode,
      ttlSeconds
    });
  }

  return entry;
}

module.exports = {
  buildTrackProbeKey,
  getCachedTrackHintsSync,
  scheduleTrackProbe,
  normalizeTracks,
  languageListToFlags,
  languageListToLabels
};
