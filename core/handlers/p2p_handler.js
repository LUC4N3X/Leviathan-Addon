const { formatStreamSelector, formatBytes } = require('../lib/stream_formatter');
const ptt = require('parse-torrent-title');

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
    hex += parseInt(bits.slice(i, i + 4), 2).toString(16);
  }

  return hex;
}

function normalizeHash(raw) {
  if (!raw) return null;
  const value = String(raw).trim();
  if (/^[a-f0-9]{40}$/i.test(value)) return value.toUpperCase();
  if (/^[a-z2-7]{32}$/i.test(value)) {
    const hex = base32ToHex(value);
    return hex && /^[a-f0-9]{40}$/i.test(hex) ? hex.toUpperCase() : null;
  }
  return null;
}

function extractHash(item) {
  const direct = normalizeHash(item?.hash) || normalizeHash(item?.infoHash);
  if (direct) return direct;

  const magnet = String(item?.magnet || item?.magnetLink || '');
  const match = magnet.match(/btih:([A-Fa-f0-9]{40}|[A-Za-z2-7]{32})/i);
  return match ? normalizeHash(match[1]) : null;
}

function extractTrackersFromMagnet(magnet) {
  if (!magnet) return [];
  const trackers = [];
  const regex = /[?&]tr=([^&]+)/gi;
  let match;
  while ((match = regex.exec(magnet)) !== null) {
    try {
      const decoded = decodeURIComponent(match[1]).trim();
      if (/^(udp|http|https):\/\//i.test(decoded)) trackers.push(decoded);
    } catch {

    }
  }
  return trackers;
}

function uniqueTrackers(list) {
  const seen = new Set();
  const out = [];
  for (const tracker of list) {
    const clean = String(tracker || '').trim();
    const key = clean.toLowerCase();
    if (!clean || seen.has(key)) continue;
    seen.add(key);
    out.push(clean);
  }
  return out;
}

function parseSafeTitle(rawTitle) {
  const original = String(rawTitle || 'Unknown Video');
  try {
    const parsed = ptt.parse(original);
    if (parsed?.title && parsed.title.length > 2) return parsed.title;
  } catch {

  }
  return original;
}

function getRealSize(item) {
  if (Number(item?._size) > 100 * 1024 * 1024) return Math.floor(Number(item._size));
  if (Number(item?.sizeBytes) > 100 * 1024 * 1024) return Math.floor(Number(item.sizeBytes));
  if (Number(item?.mainFileSize) > 100 * 1024 * 1024) return Math.floor(Number(item.mainFileSize));

  const title = String(item?.title || '').toLowerCase();
  let size = 0;

  const match = title.match(/(\d+(?:\.\d+)?)\s*(tb|gb|mb)/i);
  if (match) {
    const value = parseFloat(match[1]);
    const unit = match[2].toLowerCase();
    if (unit === 'tb') size = value * 1024 ** 4;
    else if (unit === 'gb') size = value * 1024 ** 3;
    else size = value * 1024 ** 2;
  }

  if (size < 200 * 1024 * 1024) {
    if (/2160p|4k|uhd/i.test(title)) size = 12.5 * 1024 ** 3;
    else if (/1080p/i.test(title)) size = 2.6 * 1024 ** 3;
    else if (/720p/i.test(title)) size = 1.3 * 1024 ** 3;
    else size = 2.2 * 1024 ** 3;
  }

  const maxAllowed = /2160p|4k|uhd/i.test(title) ? 35 * 1024 ** 3 : 12 * 1024 ** 3;
  if (size > maxAllowed) {
    size = /2160p|4k|uhd/i.test(title) ? 12.5 * 1024 ** 3 : 2.6 * 1024 ** 3;
    console.warn('[P2P SIZE FIX] Dimensione fuori scala, applico fallback realistico.');
  }

  return Math.floor(size);
}

function buildSources(item, hash) {
  const fromMagnet = extractTrackersFromMagnet(item?.magnet || item?.magnetLink || '');
  const trackers = uniqueTrackers([...fromMagnet, ...BEST_TRACKERS]).slice(0, 24);
  const sources = trackers.map((tracker) => `tracker:${tracker}`);
  if (hash) sources.push(`dht:${hash}`);
  return sources;
}

function computeFileIdx(item) {
  if (item?.fileIdx === undefined || item?.fileIdx === null || item?.fileIdx === '') return undefined;
  const num = Number.parseInt(item.fileIdx, 10);
  return Number.isInteger(num) && num >= 0 ? num : undefined;
}

module.exports = {
  formatP2PStream(item, config) {
    console.log(`[P2P START] "${String(item?.title || '').substring(0, 68)}..." | Seeders: ${item?.seeders || 0}`);

    const hash = extractHash(item);
    if (!hash) {
      console.warn('[P2P DROP] Hash non valido, stream scartato.');
      return null;
    }

    const displaySize = getRealSize(item);
    const safeTitle = parseSafeTitle(item?.title);
    const fileIdx = computeFileIdx(item);
    const sources = buildSources(item, hash);

    const { name, title, bingeGroup } = formatStreamSelector(
      item?.title || safeTitle,
      item?.source || 'P2P',
      displaySize,
      Number.parseInt(item?.seeders, 10) || 0,
      'P2P',
      config,
      hash,
      false,
      item?._isPack || false
    );

    const streamObj = {
      name,
      title,
      infoHash: hash,
      sources,
      behaviorHints: {
        filename: String(item?.filename || safeTitle || item?.title || 'video').substring(0, 180),
        videoSize: displaySize,
        bingeGroup,
        bingieGroup: bingeGroup
      }
    };

    if (fileIdx !== undefined) {
      streamObj.fileIdx = fileIdx;
    }

    console.log(`[P2P OK] Hash: ${hash.toLowerCase()} | Size: ${formatBytes(displaySize)} | fileIdx=${fileIdx ?? 'auto'} | trackers=${sources.filter((s) => s.startsWith('tracker:')).length}`);

    if ((Number.parseInt(item?.seeders, 10) || 0) === 0) {
      console.warn('[P2P WARN] 0 seeders rilevati. Lo stream puo impiegare molto o non partire.');
    }

    return streamObj;
  }
};
