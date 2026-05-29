const { formatStreamSelector, formatBytes } = require('../lib/stream_formatter');
const ptt = require('parse-torrent-title');

const DEFAULT_TRACKER_LIMIT = parsePositiveInt(process.env.LEVI_P2P_TRACKER_LIMIT, 24);
const P2P_LOGS_ENABLED = String(process.env.LEVI_P2P_LOGS ?? '1').trim() !== '0';

const BEST_TRACKERS = [
  'udp://tracker.opentrackr.org:1337/announce',
  'udp://open.stealth.si:80/announce',
  'udp://open.demonii.com:1337/announce',
  'udp://exodus.desync.com:6969/announce',
  'udp://tracker.torrent.eu.org:451/announce',
  'udp://tracker-udp.gbitt.info:80/announce',
  'udp://retracker.lanta.me:2710/announce',
  'udp://tracker.dler.org:6969/announce',
  'udp://t.overflow.biz:6969/announce',
  'udp://explodie.org:6969/announce',
  'udp://evan.im:6969/announce',
  'udp://tracker.alaskantf.com:6969/announce',
  'udp://tracker.theoks.net:6969/announce',
  'udp://tracker.srv00.com:6969/announce',
  'udp://tracker.fnix.net:6969/announce',
  'udp://ns575949.ip-51-222-82.net:6969/announce',
  'udp://tracker.filemail.com:6969/announce',
  'udp://bittorrent-tracker.e-n-c-r-y-p-t.net:1337/announce',
  'https://tracker.pmman.tech:443/announce',
  'https://tracker.zhuqiy.com:443/announce'
];

const ANIME_TRACKERS = [
  'http://nyaa.tracker.wf:7777/announce',
  'http://anidex.moe:6969/announce',
  'http://tracker.anirena.com:80/announce',
  'udp://tracker.uw0.xyz:6969/announce',
  'http://share.camoe.cn:8080/announce',
  'http://t.nyaatracker.com:80/announce'
];

function log(level, message) {
  if (!P2P_LOGS_ENABLED) return;
  const writer = level === 'warn' ? console.warn : console.log;
  writer(message);
}

function parsePositiveInt(value, fallback = null) {
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function base32ToHex(base32) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  let hex = '';
  const input = String(base32 || '').replace(/=+$/g, '').toUpperCase();

  for (let i = 0; i < input.length; i += 1) {
    const idx = alphabet.indexOf(input[i]);
    if (idx === -1) return null;
    bits += idx.toString(2).padStart(5, '0');
  }

  for (let i = 0; i + 4 <= bits.length; i += 4) {
    hex += Number.parseInt(bits.slice(i, i + 4), 2).toString(16);
  }

  return hex;
}

function normalizeHash(raw) {
  if (!raw) return null;

  const value = String(raw).trim();

  if (/^[a-f0-9]{40}$/i.test(value)) {
    return value.toUpperCase();
  }

  if (/^[a-z2-7]{32}$/i.test(value)) {
    const hex = base32ToHex(value);
    return hex && /^[a-f0-9]{40}$/i.test(hex) ? hex.toUpperCase() : null;
  }

  return null;
}

function decodeSafe(value) {
  const text = String(value || '').trim();
  if (!text) return '';

  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

function extractHash(item) {
  const direct = normalizeHash(item?.hash) ||
    normalizeHash(item?.infoHash) ||
    normalizeHash(item?.info_hash) ||
    normalizeHash(item?.btih);

  if (direct) return direct;

  const magnet = decodeSafe(item?.magnet || item?.magnetLink || item?.url || '');
  const match = magnet.match(/(?:xt=urn:btih:|btih:)([A-Fa-f0-9]{40}|[A-Za-z2-7]{32})/i);

  return match ? normalizeHash(match[1]) : null;
}

function normalizeTracker(rawTracker) {
  let tracker = decodeSafe(rawTracker);

  if (tracker.startsWith('tracker:')) {
    tracker = tracker.slice('tracker:'.length);
  }

  tracker = tracker.replace(/\s+/g, '').trim();

  if (!/^(udp|http|https):\/\//i.test(tracker)) return null;
  if (tracker.length > 500) return null;

  return tracker;
}

function toList(value) {
  if (Array.isArray(value)) return value;

  if (typeof value === 'string') {
    return value
      .split(/[\n,|]+/g)
      .map((entry) => entry.trim())
      .filter(Boolean);
  }

  return [];
}

function extractTrackersFromMagnet(magnet) {
  const raw = String(magnet || '');
  if (!raw) return [];

  const trackers = [];
  const regex = /[?&]tr=([^&]+)/gi;
  let match;

  while ((match = regex.exec(raw)) !== null) {
    const tracker = normalizeTracker(match[1]);
    if (tracker) trackers.push(tracker);
  }

  return trackers;
}

function extractTrackersFromSources(sources) {
  return toList(sources)
    .filter((source) => String(source || '').trim().toLowerCase().startsWith('tracker:'))
    .map(normalizeTracker)
    .filter(Boolean);
}

function extractItemTrackers(item) {
  return [
    ...toList(item?.trackers),
    ...toList(item?.tracker),
    ...toList(item?.announce),
    ...toList(item?.announces),
    ...extractTrackersFromSources(item?.sources),
    ...extractTrackersFromMagnet(item?.magnet || item?.magnetLink || '')
  ];
}

function uniqueTrackers(list) {
  const seen = new Set();
  const out = [];

  for (const tracker of list) {
    const clean = normalizeTracker(tracker);
    if (!clean) continue;

    const key = clean.toLowerCase();
    if (seen.has(key)) continue;

    seen.add(key);
    out.push(clean);
  }

  return out;
}

function parseSafeTitle(rawTitle) {
  const original = String(rawTitle || 'Unknown Video').trim() || 'Unknown Video';

  try {
    const parsed = ptt.parse(original);
    if (parsed?.title && String(parsed.title).trim().length > 2) {
      return String(parsed.title).trim();
    }
  } catch {

  }

  return original;
}

function cleanFilename(value) {
  return String(value || 'video')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .substring(0, 180) || 'video';
}

function parseSizeValue(value) {
  if (value === undefined || value === null || value === '') return 0;

  if (typeof value === 'number' && Number.isFinite(value)) {
    return value > 0 ? Math.floor(value) : 0;
  }

  const text = String(value).trim();
  const numeric = Number(text);

  if (Number.isFinite(numeric) && numeric > 0) {
    return Math.floor(numeric);
  }

  const match = text.match(/(\d+(?:[.,]\d+)?)\s*(tib|tb|gib|gb|mib|mb)\b/i);
  if (!match) return 0;

  const amount = Number.parseFloat(match[1].replace(',', '.'));
  if (!Number.isFinite(amount) || amount <= 0) return 0;

  const unit = match[2].toLowerCase();

  if (unit === 'tib' || unit === 'tb') return Math.floor(amount * 1024 ** 4);
  if (unit === 'gib' || unit === 'gb') return Math.floor(amount * 1024 ** 3);
  if (unit === 'mib' || unit === 'mb') return Math.floor(amount * 1024 ** 2);

  return 0;
}

function getRealSize(item) {
  const directCandidates = [
    item?._size,
    item?.sizeBytes,
    item?.mainFileSize,
    item?.fileSize,
    item?.size,
    item?.length,
    item?.bytes
  ];

  for (const candidate of directCandidates) {
    const parsed = parseSizeValue(candidate);
    if (parsed > 100 * 1024 * 1024) return parsed;
  }

  const title = String(item?.title || item?.filename || '').toLowerCase();
  let size = parseSizeValue(title);

  if (size < 200 * 1024 * 1024) {
    if (/2160p|4k|uhd/i.test(title)) size = 12.5 * 1024 ** 3;
    else if (/1080p/i.test(title)) size = 2.6 * 1024 ** 3;
    else if (/720p/i.test(title)) size = 1.3 * 1024 ** 3;
    else size = 2.2 * 1024 ** 3;
  }

  const isPack = item?._isPack === true || item?.isPack === true || /complete|season|s\d{1,2}\b.*pack/i.test(title);
  const is4k = /2160p|4k|uhd/i.test(title);
  const maxAllowed = isPack ? 250 * 1024 ** 3 : is4k ? 35 * 1024 ** 3 : 18 * 1024 ** 3;

  if (size > maxAllowed) {
    size = isPack ? maxAllowed : is4k ? 12.5 * 1024 ** 3 : 2.6 * 1024 ** 3;
    log('warn', '[P2P SIZE FIX] Dimensione fuori scala, applico fallback realistico.');
  }

  return Math.floor(size);
}

function isLikelyAnimeItem(item) {
  const haystack = [
    item?.type,
    item?.category,
    item?.source,
    item?.provider,
    item?.title,
    item?.filename
  ].map((value) => String(value || '').toLowerCase()).join(' ');

  return /\banime\b|nyaa|anidex|kitsu|mal\b|anirena/.test(haystack);
}

function getTrackerLimit(config) {
  const configured = parsePositiveInt(config?.p2pTrackerLimit, null) ||
    parsePositiveInt(config?.trackerLimit, null) ||
    DEFAULT_TRACKER_LIMIT;

  return Math.max(4, Math.min(configured || 24, 64));
}

function buildSources(item, hash, config = {}) {
  const itemTrackers = extractItemTrackers(item);
  const extraTrackers = isLikelyAnimeItem(item) ? ANIME_TRACKERS : [];
  const trackerLimit = getTrackerLimit(config);
  const trackers = uniqueTrackers([...itemTrackers, ...extraTrackers, ...BEST_TRACKERS]).slice(0, trackerLimit);
  const sources = trackers.map((tracker) => `tracker:${tracker}`);

  if (hash) {
    sources.push(`dht:${hash}`);
  }

  return sources;
}

function computeFileIdx(item) {
  const raw = item?.fileIdx ?? item?.fileIndex ?? item?.file_index ?? item?.index;

  if (raw === undefined || raw === null || raw === '') return undefined;

  const num = Number.parseInt(raw, 10);

  return Number.isInteger(num) && num >= 0 ? num : undefined;
}

function getSeeders(item) {
  return Math.max(0, Number.parseInt(item?.seeders ?? item?.seeds ?? item?.seed, 10) || 0);
}

function getDisplaySource(item) {
  return String(item?.source || item?.provider || 'P2P').trim() || 'P2P';
}

function formatP2PStream(item, config = {}) {
  const rawTitle = String(item?.title || item?.filename || '').trim();
  log('info', `[P2P START] "${rawTitle.substring(0, 68)}..." | Seeders: ${getSeeders(item)}`);

  const hash = extractHash(item);
  if (!hash) {
    log('warn', '[P2P DROP] Hash non valido, stream scartato.');
    return null;
  }

  const displaySize = getRealSize(item);
  const safeTitle = parseSafeTitle(rawTitle || item?.filename);
  const fileIdx = computeFileIdx(item);
  const sources = buildSources(item, hash, config);
  const seeders = getSeeders(item);
  const isPack = item?._isPack === true || item?.isPack === true;

  const { name, title, bingeGroup } = formatStreamSelector(
    rawTitle || safeTitle,
    getDisplaySource(item),
    displaySize,
    seeders,
    'P2P',
    config,
    hash,
    false,
    isPack
  );

  const streamObj = {
    name,
    title,
    infoHash: hash,
    sources,
    behaviorHints: {
      filename: cleanFilename(item?.filename || safeTitle || rawTitle || 'video'),
      videoSize: displaySize,
      bingeGroup,
      bingieGroup: bingeGroup,
      p2p: true
    }
  };

  if (fileIdx !== undefined) {
    streamObj.fileIdx = fileIdx;
  }

  log('info', `[P2P OK] Hash: ${hash.toLowerCase()} | Size: ${formatBytes(displaySize)} | fileIdx=${fileIdx ?? 'auto'} | trackers=${sources.filter((source) => source.startsWith('tracker:')).length}`);

  if (seeders === 0) {
    log('warn', '[P2P WARN] 0 seeders rilevati. Lo stream puo impiegare molto o non partire.');
  }

  return streamObj;
}

module.exports = {
  formatP2PStream,
  normalizeHash,
  extractHash,
  extractTrackersFromMagnet,
  buildSources,
  getRealSize,
  computeFileIdx
};
