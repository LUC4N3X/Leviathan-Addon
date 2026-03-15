const { Pool } = require('pg');
const axios = require('axios');

console.log('📂 Caricamento modulo db-helper (PRO)...');

const TRACKERS_URL = 'https://raw.githubusercontent.com/ngosang/trackerslist/master/trackers_best.txt';
const TRACKER_REFRESH_MS = 6 * 60 * 60 * 1000;
const DEFAULT_TRACKERS = [
  'udp://tracker.opentrackr.org:1337/announce',
  'udp://open.demonoid.ch:6969/announce',
  'udp://open.demonii.com:1337/announce',
  'udp://tracker.torrent.eu.org:451/announce',
  'udp://tracker.therarbg.to:6969/announce',
  'udp://opentracker.i2p.rocks:6969/announce'
];

let ACTIVE_TRACKERS = [...DEFAULT_TRACKERS];
let trackerRefreshHandle = null;
let pool = null;

function normalizeTrackerList(raw) {
  if (typeof raw !== 'string') return [];
  return [...new Set(
    raw
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('#') && /^https?:\/\//i.test(line) === false ? /^udp:\/\//i.test(line) || /^wss?:\/\//i.test(line) || /^https?:\/\//i.test(line) : true)
  )];
}

async function updateTrackers() {
  try {
    const response = await axios.get(TRACKERS_URL, {
      timeout: 5000,
      responseType: 'text',
      headers: { 'User-Agent': 'stremio-addon-db-helper/1.0' }
    });

    const list = normalizeTrackerList(response.data);
    if (list.length > 0) {
      ACTIVE_TRACKERS = list;
      console.log(`✅ Trackers aggiornati: ${ACTIVE_TRACKERS.length} attivi.`);
    } else {
      console.warn('⚠️ Lista tracker remota vuota/non valida, mantengo fallback.');
    }
  } catch (e) {
    console.warn(`⚠️ Errore update tracker (uso fallback): ${e.message}`);
  }
}

function startTrackerRefresh() {
  if (trackerRefreshHandle) return;
  updateTrackers();
  trackerRefreshHandle = setInterval(updateTrackers, TRACKER_REFRESH_MS);
  if (typeof trackerRefreshHandle.unref === 'function') {
    trackerRefreshHandle.unref();
  }
}

startTrackerRefresh();

function getActiveTrackers() {
  return [...ACTIVE_TRACKERS];
}

function normalizeBooleanEnv(value, fallback = false) {
  if (typeof value === 'boolean') return value;
  if (typeof value !== 'string') return fallback;
  const normalized = value.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return fallback;
}

function toNullableInt(value) {
  if (value === null || value === undefined || value === '') return null;
  const num = Number(value);
  return Number.isInteger(num) ? num : null;
}

function toSafeNumber(value, fallback = 0) {
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
}

function normalizeInfoHash(infoHash) {
  if (!infoHash) return null;
  const normalized = String(infoHash).trim().toLowerCase();
  return /^[a-f0-9]{40}$/.test(normalized) ? normalized : null;
}

function sanitizeText(value, fallback = '') {
  if (value === null || value === undefined) return fallback;
  return String(value).trim();
}

function buildPoolConfig(config = {}) {
  const sslEnabled = normalizeBooleanEnv(process.env.DB_SSL, false);
  const sslConfig = sslEnabled ? { rejectUnauthorized: false } : false;

  if (process.env.DATABASE_URL) {
    return {
      connectionString: process.env.DATABASE_URL,
      ssl: sslConfig
    };
  }

  return {
    host: config.host || process.env.DB_HOST || 'localhost',
    port: Number(config.port || process.env.DB_PORT || 5432),
    database: config.database || process.env.DB_NAME || 'torrent_library',
    user: config.user || process.env.DB_USER || 'postgres',
    password: config.password || process.env.DB_PASSWORD,
    ssl: sslConfig
  };
}

function initDatabase(config = {}) {
  if (pool) {
    console.log('♻️ DB Pool già inizializzato.');
    return pool;
  }

  const poolConfig = buildPoolConfig(config);

  pool = new Pool({
    ...poolConfig,
    max: 40,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000,
    allowExitOnIdle: true
  });

  pool.on('error', (err) => {
    console.error(`❌ Unexpected idle client error: ${err.message}`);
  });

  console.log(`✅ DB Pool Inizializzato (Target: ${poolConfig.host || 'Cloud'})`);
  return pool;
}

async function shutdownDatabase() {
  if (!pool) return;
  const currentPool = pool;
  pool = null;
  await currentPool.end();
}

const KNOWN_PROVIDERS = [
  'ilCorSaRoNeRo', 'Corsaro', '1337x', '1337X', 'TorrentGalaxy', 'TGX', 'GalaxyRG',
  'RARBG', 'Rarbg', 'EZTV', 'Eztv', 'YTS', 'YIFY', 'MagnetDL', 'TorLock',
  'PirateBay', 'TPB', 'ThePirateBay', 'Nyaa', 'RuTracker', 'SolidTorrents'
];

function extractOriginalProvider(text) {
  if (!text) return null;
  const content = String(text);
  const iconPatterns = [/🔍\s*([^\n]+)/, /🔗\s*([^\n]+)/, /🔎\s*([^\n]+)/];
  for (const pattern of iconPatterns) {
    const match = content.match(pattern);
    if (match && match[1]) return match[1].trim();
  }
  const lowerText = content.toLowerCase();
  for (const provider of KNOWN_PROVIDERS) {
    if (lowerText.includes(provider.toLowerCase())) return provider;
  }
  return null;
}

function buildMagnet(infoHash, trackers = ACTIVE_TRACKERS) {
  const hash = normalizeInfoHash(infoHash);
  if (!hash) return null;
  const trackerParams = trackers
    .map((tracker) => tracker && `tr=${encodeURIComponent(tracker)}`)
    .filter(Boolean)
    .join('&');
  return `magnet:?xt=urn:btih:${hash}${trackerParams ? `&${trackerParams}` : ''}`;
}

async function getTorrents(imdbId, season, episode) {
  if (!pool || !imdbId) return [];

  const client = await pool.connect();
  try {
    const normalizedSeason = toNullableInt(season);
    const normalizedEpisode = toNullableInt(episode);
    const isSeriesEpisode = normalizedSeason !== null && normalizedSeason > 0 && normalizedEpisode !== null && normalizedEpisode > 0;

    const selectFields = `
      SELECT DISTINCT ON (TRIM(t.info_hash), COALESCE(t.file_index, -1))
        t.title,
        TRIM(t.info_hash) AS info_hash,
        t.size,
        t.seeders,
        t.provider,
        t.file_index
      FROM files f
      JOIN torrents t ON LOWER(TRIM(f.info_hash)) = LOWER(TRIM(t.info_hash))
    `;

    let query;
    let params;

    if (isSeriesEpisode) {
      query = `
        ${selectFields}
        WHERE f.imdb_id = $1
          AND f.imdb_season = $2
          AND f.imdb_episode = $3
        ORDER BY TRIM(t.info_hash), COALESCE(t.file_index, -1), COALESCE(t.seeders, 0) DESC, COALESCE(t.size, 0) DESC
      `;
      params = [imdbId, normalizedSeason, normalizedEpisode];
    } else {
      query = `
        ${selectFields}
        WHERE f.imdb_id = $1
          AND (f.imdb_season IS NULL OR f.imdb_season = 0)
        ORDER BY TRIM(t.info_hash), COALESCE(t.file_index, -1), COALESCE(t.seeders, 0) DESC, COALESCE(t.size, 0) DESC
      `;
      params = [imdbId];
    }

    const res = await client.query(query, params);

    return res.rows.map((row) => {
      const infoHash = normalizeInfoHash(row.info_hash);
      return {
        title: sanitizeText(row.title),
        info_hash: infoHash,
        size: toSafeNumber(row.size, 0),
        seeders: toSafeNumber(row.seeders, 0),
        provider: sanitizeText(row.provider, 'Unknown'),
        magnet: buildMagnet(infoHash),
        file_index: toNullableInt(row.file_index)
      };
    }).filter((row) => row.info_hash);
  } catch (e) {
    console.error(`❌ DB Read Error (${imdbId}): ${e.message}`);
    return [];
  } finally {
    client.release();
  }
}

async function insertTorrent(meta, torrent) {
  if (!pool) return false;

  const cleanHash = normalizeInfoHash(torrent?.info_hash);
  if (!cleanHash) return false;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const seeders = Math.max(0, toSafeNumber(torrent.seeders, 0));
    const size = Math.max(0, toSafeNumber(torrent.size, 0));
    const fileIndex = toNullableInt(torrent.file_index ?? torrent.fileIdx);
    const title = sanitizeText(torrent.title, cleanHash);

    let providerName = sanitizeText(torrent.provider);
    const extracted = extractOriginalProvider(title);

    if (extracted) {
      providerName = extracted;
    } else if (!providerName || providerName === 'Torrentio' || providerName === 'P2P') {
      providerName = 'External';
    }

    const queryTorrent = `
      INSERT INTO torrents (info_hash, provider, title, size, seeders, file_index)
      VALUES ($1, $2, $3, $4, $5, $6)
      ON CONFLICT (info_hash) DO UPDATE SET
        provider = COALESCE(NULLIF(EXCLUDED.provider, ''), torrents.provider),
        title = CASE
          WHEN torrents.title IS NULL OR torrents.title = '' THEN EXCLUDED.title
          WHEN LENGTH(EXCLUDED.title) > LENGTH(torrents.title) THEN EXCLUDED.title
          ELSE torrents.title
        END,
        size = GREATEST(COALESCE(torrents.size, 0), COALESCE(EXCLUDED.size, 0)),
        seeders = GREATEST(COALESCE(torrents.seeders, 0), COALESCE(EXCLUDED.seeders, 0)),
        file_index = COALESCE(EXCLUDED.file_index, torrents.file_index)
      RETURNING (xmax = 0) AS inserted;
    `;

    const torrentRes = await client.query(queryTorrent, [cleanHash, providerName, title, size, seeders, fileIndex]);

    const s = meta?.type === 'movie' ? null : toNullableInt(meta?.season);
    const e = meta?.type === 'movie' ? null : toNullableInt(meta?.episode);
    const imdbId = sanitizeText(meta?.imdb_id);

    if (!imdbId) {
      throw new Error('meta.imdb_id mancante');
    }

    const queryFile = `
      INSERT INTO files (info_hash, imdb_id, imdb_season, imdb_episode, title)
      VALUES ($1, $2, $3, $4, $5)
      ON CONFLICT DO NOTHING;
    `;

    await client.query(queryFile, [cleanHash, imdbId, s, e, title]);

    await client.query('COMMIT');

    return Boolean(torrentRes.rows?.[0]?.inserted);
  } catch (e) {
    await client.query('ROLLBACK');
    console.error(`❌ DB Save Error: ${e.message}`);
    return false;
  } finally {
    client.release();
  }
}

async function updateRdCacheStatus(cacheResults) {
  if (!pool || !Array.isArray(cacheResults) || cacheResults.length === 0) return 0;

  const normalizedRows = cacheResults
    .map((entry) => ({
      hash: normalizeInfoHash(entry?.hash),
      cached: Boolean(entry?.cached)
    }))
    .filter((entry) => entry.hash);

  if (normalizedRows.length === 0) return 0;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const values = [];
    const placeholders = normalizedRows.map((row, index) => {
      const base = index * 2;
      values.push(row.hash, row.cached);
      return `($${base + 1}, $${base + 2})`;
    }).join(', ');

    const query = `
      UPDATE torrents AS t
      SET cached_rd = v.cached,
          last_cached_check = NOW()
      FROM (VALUES ${placeholders}) AS v(info_hash, cached)
      WHERE LOWER(TRIM(t.info_hash)) = v.info_hash
    `;

    const result = await client.query(query, values);
    await client.query('COMMIT');
    return result.rowCount || 0;
  } catch (e) {
    await client.query('ROLLBACK');
    console.error(`❌ DB Error updateCache: ${e.message}`);
    return 0;
  } finally {
    client.release();
  }
}

async function healthCheck() {
  if (!pool) throw new Error('Pool not initialized');
  await pool.query('SELECT 1');
  return true;
}

module.exports = {
  initDatabase,
  shutdownDatabase,
  healthCheck,
  getTorrents,
  insertTorrent,
  updateRdCacheStatus,
  updateTrackers,
  getActiveTrackers,
  buildMagnet
};
