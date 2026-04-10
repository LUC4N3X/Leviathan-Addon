const { Pool } = require('pg');
const trackerRegistry = require('./tracker_registry');

let pool = null;
let databaseOptimizationsPromise = null;

const DB_POOL_MAX = clampInt(process.env.DB_POOL_MAX, 40, 5, 120);
const DB_POOL_IDLE_TIMEOUT_MS = clampInt(process.env.DB_POOL_IDLE_TIMEOUT_MS, 30000, 5000, 120000);
const DB_POOL_CONNECT_TIMEOUT_MS = clampInt(process.env.DB_POOL_CONNECT_TIMEOUT_MS, 5000, 1000, 30000);

const KNOWN_PROVIDERS = [
  'ilCorSaRoNeRo', 'Corsaro', '1337x', '1337X', 'TorrentGalaxy', 'TGX', 'GalaxyRG',
  'RARBG', 'Rarbg', 'EZTV', 'Eztv', 'YTS', 'YIFY', 'MagnetDL', 'TorLock',
  'PirateBay', 'TPB', 'ThePirateBay', 'Nyaa', 'RuTracker', 'SolidTorrents'
];

function clampInt(value, fallback, min, max) {
  const parsed = Number.parseInt(value, 10);
  const normalized = Number.isFinite(parsed) ? parsed : fallback;
  return Math.max(min, Math.min(max, normalized));
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

function sanitizeText(value, fallback = '') {
  if (value === null || value === undefined) return fallback;
  return String(value).trim();
}

function normalizeInfoHash(infoHash) {
  if (!infoHash) return null;
  const normalized = String(infoHash).trim().toLowerCase();
  return /^[a-f0-9]{40}$/.test(normalized) ? normalized : null;
}

function normalizeImdbId(value) {
  const normalized = String(value || '').trim().toLowerCase();
  return /^tt\d+$/.test(normalized) ? normalized : null;
}

function normalizeFileIndex(value) {
  const parsed = toNullableInt(value);
  return parsed !== null && parsed >= 0 ? parsed : null;
}

function normalizeFileIndexNorm(value) {
  const parsed = normalizeFileIndex(value);
  return parsed === null ? -1 : parsed;
}

function normalizeRdCacheState(value) {
  const normalized = sanitizeText(value).toLowerCase();
  if (['cached', 'likely_cached', 'probing', 'likely_uncached', 'uncached_terminal', 'unknown'].includes(normalized)) {
    return normalized;
  }
  return null;
}

function deriveStoredCacheState(entry) {
  const explicitState = normalizeRdCacheState(entry?.state || entry?.rd_cache_state);
  if (explicitState) return explicitState;
  if (entry?.cached === true) return 'cached';
  if (entry?.cached === false) return 'uncached_terminal';
  return null;
}

function deriveCachedBooleanFromState(state, cachedValue) {
  if (typeof cachedValue === 'boolean') return cachedValue;
  if (state === 'cached') return true;
  if (state === 'uncached_terminal') return false;
  return null;
}

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
  if (pool) return pool;

  const poolConfig = buildPoolConfig(config);
  pool = new Pool({
    ...poolConfig,
    max: DB_POOL_MAX,
    idleTimeoutMillis: DB_POOL_IDLE_TIMEOUT_MS,
    connectionTimeoutMillis: DB_POOL_CONNECT_TIMEOUT_MS,
    allowExitOnIdle: true
  });

  pool.on('error', (err) => {
    console.error(`❌ Unexpected idle client error: ${err.message}`);
  });

  trackerRegistry.initTrackerRegistry();

  if (!databaseOptimizationsPromise) {
    databaseOptimizationsPromise = ensureDatabaseOptimizations()
      .catch((error) => {
        console.warn(`⚠️ DB optimization bootstrap failed: ${error.message}`);
        throw error;
      })
      .finally(() => {
        if (!pool) databaseOptimizationsPromise = null;
      });
  }

  console.log(`✅ DB Pool inizializzato (${poolConfig.host || 'DATABASE_URL'})`);
  return pool;
}

async function awaitDatabaseOptimizations() {
  if (!pool) return false;
  if (!databaseOptimizationsPromise) {
    databaseOptimizationsPromise = ensureDatabaseOptimizations()
      .catch((error) => {
        console.warn(`⚠️ DB optimization await failed: ${error.message}`);
        throw error;
      })
      .finally(() => {
        if (!pool) databaseOptimizationsPromise = null;
      });
  }

  try {
    await databaseOptimizationsPromise;
    return true;
  } catch (error) {
    console.warn(`⚠️ DB optimization await failed: ${error.message}`);
    return false;
  }
}

async function ensureDatabaseOptimizations() {
  if (!pool) return;

  const statements = [
    `CREATE TABLE IF NOT EXISTS torrents (
      info_hash TEXT NOT NULL,
      info_hash_norm TEXT,
      file_index INTEGER,
      file_index_norm INTEGER DEFAULT -1,
      provider TEXT,
      title TEXT,
      size BIGINT DEFAULT 0,
      seeders INTEGER DEFAULT 0,
      cached_rd BOOLEAN,
      rd_cache_state TEXT,
      rd_file_index INTEGER,
      rd_file_size BIGINT,
      last_cached_check TIMESTAMPTZ,
      next_cached_check TIMESTAMPTZ,
      cache_check_failures INTEGER DEFAULT 0,
      tb_cached BOOLEAN,
      tb_file_id INTEGER,
      tb_file_size BIGINT,
      tb_last_cached_check TIMESTAMPTZ,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )`,
    `CREATE TABLE IF NOT EXISTS files (
      info_hash TEXT NOT NULL,
      info_hash_norm TEXT,
      file_index INTEGER,
      file_index_norm INTEGER DEFAULT -1,
      imdb_id TEXT NOT NULL,
      imdb_season INTEGER,
      imdb_episode INTEGER,
      title TEXT,
      size BIGINT DEFAULT 0,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )`,
    `CREATE TABLE IF NOT EXISTS pack_files (
      pack_hash TEXT NOT NULL,
      pack_hash_norm TEXT,
      file_index INTEGER,
      file_index_norm INTEGER DEFAULT -1,
      imdb_id TEXT,
      imdb_season INTEGER,
      imdb_episode INTEGER,
      file_path TEXT,
      file_title TEXT,
      file_size BIGINT DEFAULT 0,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )`,
    `ALTER TABLE torrents ADD COLUMN IF NOT EXISTS info_hash_norm TEXT`,
    `ALTER TABLE torrents ADD COLUMN IF NOT EXISTS file_index INTEGER`,
    `ALTER TABLE torrents ADD COLUMN IF NOT EXISTS file_index_norm INTEGER DEFAULT -1`,
    `ALTER TABLE torrents ADD COLUMN IF NOT EXISTS cached_rd BOOLEAN`,
    `ALTER TABLE torrents ADD COLUMN IF NOT EXISTS rd_cache_state TEXT`,
    `ALTER TABLE torrents ADD COLUMN IF NOT EXISTS rd_file_index INTEGER`,
    `ALTER TABLE torrents ADD COLUMN IF NOT EXISTS rd_file_size BIGINT`,
    `ALTER TABLE torrents ADD COLUMN IF NOT EXISTS last_cached_check TIMESTAMPTZ`,
    `ALTER TABLE torrents ADD COLUMN IF NOT EXISTS next_cached_check TIMESTAMPTZ`,
    `ALTER TABLE torrents ADD COLUMN IF NOT EXISTS cache_check_failures INTEGER DEFAULT 0`,
    `ALTER TABLE torrents ADD COLUMN IF NOT EXISTS tb_cached BOOLEAN`,
    `ALTER TABLE torrents ADD COLUMN IF NOT EXISTS tb_file_id INTEGER`,
    `ALTER TABLE torrents ADD COLUMN IF NOT EXISTS tb_file_size BIGINT`,
    `ALTER TABLE torrents ADD COLUMN IF NOT EXISTS tb_last_cached_check TIMESTAMPTZ`,
    `ALTER TABLE torrents ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT NOW()`,
    `ALTER TABLE torrents ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW()`,

    `ALTER TABLE files ADD COLUMN IF NOT EXISTS info_hash_norm TEXT`,
    `ALTER TABLE files ADD COLUMN IF NOT EXISTS file_index INTEGER`,
    `ALTER TABLE files ADD COLUMN IF NOT EXISTS file_index_norm INTEGER DEFAULT -1`,
    `ALTER TABLE files ADD COLUMN IF NOT EXISTS title TEXT`,
    `ALTER TABLE files ADD COLUMN IF NOT EXISTS size BIGINT DEFAULT 0`,
    `ALTER TABLE files ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT NOW()`,
    `ALTER TABLE files ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW()`,

    `ALTER TABLE pack_files ADD COLUMN IF NOT EXISTS pack_hash_norm TEXT`,
    `ALTER TABLE pack_files ADD COLUMN IF NOT EXISTS file_index INTEGER`,
    `ALTER TABLE pack_files ADD COLUMN IF NOT EXISTS file_index_norm INTEGER DEFAULT -1`,
    `ALTER TABLE pack_files ADD COLUMN IF NOT EXISTS imdb_id TEXT`,
    `ALTER TABLE pack_files ADD COLUMN IF NOT EXISTS imdb_season INTEGER`,
    `ALTER TABLE pack_files ADD COLUMN IF NOT EXISTS imdb_episode INTEGER`,
    `ALTER TABLE pack_files ADD COLUMN IF NOT EXISTS file_path TEXT`,
    `ALTER TABLE pack_files ADD COLUMN IF NOT EXISTS file_title TEXT`,
    `ALTER TABLE pack_files ADD COLUMN IF NOT EXISTS file_size BIGINT DEFAULT 0`,
    `ALTER TABLE pack_files ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT NOW()`,
    `ALTER TABLE pack_files ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW()`,

    `UPDATE torrents SET info_hash_norm = LOWER(TRIM(info_hash)) WHERE info_hash IS NOT NULL AND (info_hash_norm IS NULL OR info_hash_norm <> LOWER(TRIM(info_hash)))`,
    `UPDATE torrents SET file_index_norm = COALESCE(file_index, -1) WHERE file_index_norm IS DISTINCT FROM COALESCE(file_index, -1)`,
    `UPDATE files SET info_hash_norm = LOWER(TRIM(info_hash)) WHERE info_hash IS NOT NULL AND (info_hash_norm IS NULL OR info_hash_norm <> LOWER(TRIM(info_hash)))`,
    `UPDATE files SET file_index_norm = COALESCE(file_index, -1) WHERE file_index_norm IS DISTINCT FROM COALESCE(file_index, -1)`,
    `UPDATE pack_files SET pack_hash_norm = LOWER(TRIM(pack_hash)) WHERE pack_hash IS NOT NULL AND (pack_hash_norm IS NULL OR pack_hash_norm <> LOWER(TRIM(pack_hash)))`,
    `UPDATE pack_files SET file_index_norm = COALESCE(file_index, -1) WHERE file_index_norm IS DISTINCT FROM COALESCE(file_index, -1)`,

    `CREATE INDEX IF NOT EXISTS idx_torrents_info_hash_norm ON torrents (info_hash_norm)`,
    `CREATE INDEX IF NOT EXISTS idx_torrents_lookup_hash_file ON torrents (info_hash_norm, file_index_norm)`,
    `CREATE INDEX IF NOT EXISTS idx_torrents_rd_scan_queue ON torrents (next_cached_check NULLS FIRST, last_cached_check NULLS FIRST)`,
    `CREATE INDEX IF NOT EXISTS idx_torrents_rd_cache_state ON torrents (rd_cache_state, next_cached_check NULLS FIRST)`,
    `CREATE INDEX IF NOT EXISTS idx_torrents_tb_cache_state ON torrents (tb_cached, tb_last_cached_check NULLS FIRST)`,

    `CREATE INDEX IF NOT EXISTS idx_files_lookup_episode ON files (imdb_id, imdb_season, imdb_episode, info_hash_norm, file_index_norm)`,
    `CREATE INDEX IF NOT EXISTS idx_files_lookup_movie ON files (imdb_id, info_hash_norm, file_index_norm)`,
    `CREATE INDEX IF NOT EXISTS idx_files_info_hash_norm ON files (info_hash_norm, file_index_norm)`,

    `CREATE INDEX IF NOT EXISTS idx_pack_files_hash ON pack_files (pack_hash_norm, file_index_norm)`,
    `CREATE INDEX IF NOT EXISTS idx_pack_files_series_lookup ON pack_files (pack_hash_norm, imdb_season, imdb_episode, file_index_norm)`
  ];

  for (const sql of statements) {
    try {
      await pool.query(sql);
    } catch (error) {
      console.warn(`⚠️ DB optimization skipped: ${error.message}`);
    }
  }

  await deduplicateTableByKey('torrents', 'info_hash_norm', 'file_index_norm');
  await deduplicateTableByKey('files', 'info_hash_norm', 'file_index_norm');
  await deduplicateTableByKey('pack_files', 'pack_hash_norm', 'file_index_norm');

  const uniqueStatements = [
    `CREATE UNIQUE INDEX IF NOT EXISTS uq_torrents_hash_file_idx_norm ON torrents (info_hash_norm, file_index_norm)`,
    `CREATE UNIQUE INDEX IF NOT EXISTS uq_files_hash_file_idx_norm ON files (info_hash_norm, file_index_norm)`,
    `CREATE UNIQUE INDEX IF NOT EXISTS uq_pack_files_hash_file_idx_norm ON pack_files (pack_hash_norm, file_index_norm)`
  ];

  for (const sql of uniqueStatements) {
    try {
      await pool.query(sql);
    } catch (error) {
      console.warn(`⚠️ DB unique optimization skipped: ${error.message}`);
    }
  }

  try {
    await pool.query(`UPDATE torrents SET next_cached_check = TIMESTAMPTZ '9999-12-31 00:00:00+00' WHERE cached_rd IS TRUE AND (next_cached_check IS NULL OR next_cached_check < TIMESTAMPTZ '9999-12-31 00:00:00+00')`);
  } catch (error) {
    console.warn(`⚠️ DB optimization skipped: ${error.message}`);
  }
}

async function deduplicateTableByKey(tableName, hashColumn, fileIndexNormColumn) {
  if (!pool) return;
  const scoreExpr = tableName === 'pack_files'
    ? 'COALESCE(file_size, 0)'
    : tableName === 'files'
      ? 'COALESCE(size, 0)'
      : 'COALESCE(size, 0) + (COALESCE(seeders, 0) * 1024)';
  const sql = `
    WITH ranked AS (
      SELECT ctid,
             ROW_NUMBER() OVER (
               PARTITION BY ${hashColumn}, ${fileIndexNormColumn}
               ORDER BY
                 COALESCE(updated_at, created_at, NOW()) DESC,
                 ${scoreExpr} DESC
             ) AS rn
      FROM ${tableName}
      WHERE ${hashColumn} IS NOT NULL
    )
    DELETE FROM ${tableName} t
    USING ranked r
    WHERE t.ctid = r.ctid
      AND r.rn > 1
  `;
  try {
    await pool.query(sql);
  } catch (error) {
    console.warn(`⚠️ DB dedupe skipped (${tableName}): ${error.message}`);
  }
}

async function shutdownDatabase() {
  trackerRegistry.shutdownTrackerRegistry();
  if (!pool) return;
  const currentPool = pool;
  pool = null;
  databaseOptimizationsPromise = null;
  await currentPool.end();
}

async function withClient(fn) {
  if (!pool) throw new Error('Pool not initialized');
  const client = await pool.connect();
  try {
    return await fn(client);
  } finally {
    client.release();
  }
}

function normalizeProviderName(providerName, title) {
  const extracted = extractOriginalProvider(title);
  if (extracted) return extracted;
  const normalized = sanitizeText(providerName);
  if (!normalized || normalized === 'Torrentio' || normalized === 'P2P') return 'External';
  return normalized;
}

function normalizeTorrentRow(row) {
  const infoHash = normalizeInfoHash(row?.info_hash);
  if (!infoHash) return null;
  return {
    title: sanitizeText(row.title, infoHash),
    info_hash: infoHash,
    size: toSafeNumber(row.size, 0),
    seeders: toSafeNumber(row.seeders, 0),
    provider: sanitizeText(row.provider, 'Unknown'),
    magnet: trackerRegistry.buildMagnet(infoHash),
    file_index: normalizeFileIndex(row.file_index),
    cached_rd: row.cached_rd === null || row.cached_rd === undefined ? null : Boolean(row.cached_rd),
    rd_cache_state: normalizeRdCacheState(row.rd_cache_state),
    rd_file_index: normalizeFileIndex(row.rd_file_index),
    rd_file_size: toSafeNumber(row.rd_file_size, 0),
    last_cached_check: row.last_cached_check || null,
    next_cached_check: row.next_cached_check || null,
    cache_check_failures: toSafeNumber(row.cache_check_failures, 0),
    tb_cached: row.tb_cached === null || row.tb_cached === undefined ? null : Boolean(row.tb_cached),
    tb_file_id: normalizeFileIndex(row.tb_file_id),
    tb_file_size: toSafeNumber(row.tb_file_size, 0)
  };
}

async function getTorrents(imdbId, season, episode) {
  if (!pool) return [];
  await awaitDatabaseOptimizations();

  const normalizedImdb = normalizeImdbId(imdbId);
  if (!normalizedImdb) return [];

  const normalizedSeason = toNullableInt(season);
  const normalizedEpisode = toNullableInt(episode);
  const isSeriesEpisode = normalizedSeason !== null && normalizedSeason > 0 && normalizedEpisode !== null && normalizedEpisode > 0;

  const params = isSeriesEpisode
    ? [normalizedImdb, normalizedSeason, normalizedEpisode]
    : [normalizedImdb];

  const query = isSeriesEpisode
    ? `
      WITH matched_files AS (
        SELECT DISTINCT info_hash_norm, file_index_norm
        FROM files
        WHERE imdb_id = $1
          AND imdb_season = $2
          AND imdb_episode = $3
      )
      SELECT DISTINCT ON (t.info_hash_norm, t.file_index_norm)
        t.title,
        TRIM(t.info_hash) AS info_hash,
        t.size,
        t.seeders,
        t.provider,
        t.file_index,
        t.cached_rd,
        t.rd_cache_state,
        t.rd_file_index,
        t.rd_file_size,
        t.last_cached_check,
        t.next_cached_check,
        t.cache_check_failures,
        t.tb_cached,
        t.tb_file_id,
        t.tb_file_size
      FROM matched_files f
      JOIN torrents t
        ON t.info_hash_norm = f.info_hash_norm
       AND (
         f.file_index_norm = -1
         OR t.file_index_norm = f.file_index_norm
       )
      ORDER BY
        t.info_hash_norm,
        t.file_index_norm,
        CASE WHEN t.cached_rd IS TRUE THEN 1 ELSE 0 END DESC,
        COALESCE(t.seeders, 0) DESC,
        COALESCE(t.size, 0) DESC
    `
    : `
      WITH matched_files AS (
        SELECT DISTINCT info_hash_norm, file_index_norm
        FROM files
        WHERE imdb_id = $1
          AND (imdb_season IS NULL OR imdb_season = 0)
      )
      SELECT DISTINCT ON (t.info_hash_norm, t.file_index_norm)
        t.title,
        TRIM(t.info_hash) AS info_hash,
        t.size,
        t.seeders,
        t.provider,
        t.file_index,
        t.cached_rd,
        t.rd_cache_state,
        t.rd_file_index,
        t.rd_file_size,
        t.last_cached_check,
        t.next_cached_check,
        t.cache_check_failures,
        t.tb_cached,
        t.tb_file_id,
        t.tb_file_size
      FROM matched_files f
      JOIN torrents t
        ON t.info_hash_norm = f.info_hash_norm
       AND (
         f.file_index_norm = -1
         OR t.file_index_norm = f.file_index_norm
       )
      ORDER BY
        t.info_hash_norm,
        t.file_index_norm,
        CASE WHEN t.cached_rd IS TRUE THEN 1 ELSE 0 END DESC,
        COALESCE(t.seeders, 0) DESC,
        COALESCE(t.size, 0) DESC
    `;

  try {
    return await withClient(async (client) => {
      const res = await client.query(query, params);
      return res.rows.map(normalizeTorrentRow).filter(Boolean);
    });
  } catch (error) {
    console.error(`❌ DB Read Error (${normalizedImdb}): ${error.message}`);
    return [];
  }
}

async function upsertTorrentRow(client, torrent) {
  const infoHash = normalizeInfoHash(torrent?.infoHash || torrent?.info_hash || torrent?.hash);
  if (!infoHash) return false;

  const fileIndex = normalizeFileIndex(torrent?.fileIndex ?? torrent?.file_index ?? torrent?.fileIdx);
  const fileIndexNorm = normalizeFileIndexNorm(fileIndex);
  const providerName = normalizeProviderName(torrent?.provider || torrent?.providerName, torrent?.title);
  const title = sanitizeText(torrent?.title, infoHash);
  const size = Math.max(0, toSafeNumber(torrent?.size, 0));
  const seeders = Math.max(0, toSafeNumber(torrent?.seeders, 0));

  const updateRes = await client.query(
    `
      UPDATE torrents
      SET provider = COALESCE(NULLIF($3, ''), provider),
          title = CASE
            WHEN title IS NULL OR title = '' THEN $4
            WHEN LENGTH($4) > LENGTH(title) THEN $4
            ELSE title
          END,
          size = GREATEST(COALESCE(size, 0), $5),
          seeders = GREATEST(COALESCE(seeders, 0), $6),
          file_index = CASE
            WHEN $2 = -1 THEN file_index
            ELSE $2
          END,
          file_index_norm = $2,
          info_hash = COALESCE(NULLIF(info_hash, ''), $1),
          info_hash_norm = $1,
          updated_at = NOW()
      WHERE info_hash_norm = $1
        AND file_index_norm = $2
      RETURNING 1
    `,
    [infoHash, fileIndexNorm, providerName, title, size, seeders]
  );

  if (updateRes.rowCount > 0) return false;

  await client.query(
    `
      INSERT INTO torrents (
        info_hash,
        info_hash_norm,
        file_index,
        file_index_norm,
        provider,
        title,
        size,
        seeders,
        created_at,
        updated_at
      )
      VALUES ($1, $1, $2, $3, $4, $5, $6, $7, NOW(), NOW())
      ON CONFLICT DO NOTHING
    `,
    [infoHash, fileIndex, fileIndexNorm, providerName, title, size, seeders]
  );

  return true;
}

async function upsertFileMappingRow(client, mapping) {
  const infoHash = normalizeInfoHash(mapping?.infoHash || mapping?.info_hash || mapping?.hash);
  const imdbId = normalizeImdbId(mapping?.imdb_id || mapping?.imdbId);
  if (!infoHash || !imdbId) return false;

  const fileIndex = normalizeFileIndex(mapping?.file_index ?? mapping?.fileIdx);
  const fileIndexNorm = normalizeFileIndexNorm(fileIndex);
  const imdbSeason = toNullableInt(mapping?.imdb_season ?? mapping?.season);
  const imdbEpisode = toNullableInt(mapping?.imdb_episode ?? mapping?.episode);
  const title = sanitizeText(mapping?.title, '');
  const size = Math.max(0, toSafeNumber(mapping?.size, 0));

  const updateRes = await client.query(
    `
      UPDATE files
      SET imdb_id = $3,
          imdb_season = $4,
          imdb_episode = $5,
          title = CASE
            WHEN COALESCE(title, '') = '' THEN $6
            WHEN LENGTH($6) > LENGTH(title) THEN $6
            ELSE title
          END,
          size = GREATEST(COALESCE(size, 0), $7),
          file_index = CASE
            WHEN $2 = -1 THEN file_index
            ELSE $2
          END,
          file_index_norm = $2,
          info_hash = COALESCE(NULLIF(info_hash, ''), $1),
          info_hash_norm = $1,
          updated_at = NOW()
      WHERE info_hash_norm = $1
        AND file_index_norm = $2
      RETURNING 1
    `,
    [infoHash, fileIndexNorm, imdbId, imdbSeason, imdbEpisode, title, size]
  );

  if (updateRes.rowCount > 0) return false;

  await client.query(
    `
      INSERT INTO files (
        info_hash,
        info_hash_norm,
        file_index,
        file_index_norm,
        imdb_id,
        imdb_season,
        imdb_episode,
        title,
        size,
        created_at,
        updated_at
      )
      VALUES ($1, $1, $2, $3, $4, $5, $6, $7, $8, NOW(), NOW())
      ON CONFLICT DO NOTHING
    `,
    [infoHash, fileIndex, fileIndexNorm, imdbId, imdbSeason, imdbEpisode, title, size]
  );

  return true;
}

async function upsertPackFileRow(client, file) {
  const packHash = normalizeInfoHash(file?.pack_hash || file?.packHash || file?.info_hash || file?.infoHash || file?.hash);
  if (!packHash) return false;

  const fileIndex = normalizeFileIndex(file?.file_index ?? file?.fileIdx ?? file?.index);
  const fileIndexNorm = normalizeFileIndexNorm(fileIndex);
  const imdbId = normalizeImdbId(file?.imdb_id || file?.imdbId);
  const imdbSeason = toNullableInt(file?.imdb_season ?? file?.season);
  const imdbEpisode = toNullableInt(file?.imdb_episode ?? file?.episode);
  const filePath = sanitizeText(file?.file_path || file?.path);
  const fileTitle = sanitizeText(file?.file_title || file?.title || (filePath ? filePath.split('/').pop() : ''), '');
  const fileSize = Math.max(0, toSafeNumber(file?.file_size ?? file?.size, 0));

  const updateRes = await client.query(
    `
      UPDATE pack_files
      SET imdb_id = COALESCE($3, imdb_id),
          imdb_season = COALESCE($4, imdb_season),
          imdb_episode = COALESCE($5, imdb_episode),
          file_path = CASE
            WHEN COALESCE(file_path, '') = '' THEN $6
            ELSE file_path
          END,
          file_title = CASE
            WHEN COALESCE(file_title, '') = '' THEN $7
            WHEN LENGTH($7) > LENGTH(file_title) THEN $7
            ELSE file_title
          END,
          file_size = GREATEST(COALESCE(file_size, 0), $8),
          file_index = CASE
            WHEN $2 = -1 THEN file_index
            ELSE $2
          END,
          file_index_norm = $2,
          pack_hash = COALESCE(NULLIF(pack_hash, ''), $1),
          pack_hash_norm = $1,
          updated_at = NOW()
      WHERE pack_hash_norm = $1
        AND file_index_norm = $2
      RETURNING 1
    `,
    [packHash, fileIndexNorm, imdbId, imdbSeason, imdbEpisode, filePath, fileTitle, fileSize]
  );

  if (updateRes.rowCount > 0) return false;

  await client.query(
    `
      INSERT INTO pack_files (
        pack_hash,
        pack_hash_norm,
        file_index,
        file_index_norm,
        imdb_id,
        imdb_season,
        imdb_episode,
        file_path,
        file_title,
        file_size,
        created_at,
        updated_at
      )
      VALUES ($1, $1, $2, $3, $4, $5, $6, $7, $8, $9, NOW(), NOW())
      ON CONFLICT DO NOTHING
    `,
    [packHash, fileIndex, fileIndexNorm, imdbId, imdbSeason, imdbEpisode, filePath, fileTitle, fileSize]
  );

  return true;
}

function normalizeMeta(meta, torrent = {}) {
  const fallbackType = sanitizeText(meta?.type || torrent?.type, 'movie') || 'movie';
  const imdbId = normalizeImdbId(meta?.imdb_id || meta?.imdbId || torrent?.imdb_id || torrent?.imdbId);
  const season = fallbackType === 'movie' ? null : toNullableInt(meta?.season ?? torrent?.season ?? torrent?.imdb_season);
  const episode = fallbackType === 'movie' ? null : toNullableInt(meta?.episode ?? torrent?.episode ?? torrent?.imdb_episode);
  return { imdbId, season, episode, type: fallbackType };
}

async function insertTorrent(meta, torrent) {
  if (!pool) return false;
  await awaitDatabaseOptimizations();

  const normalizedMeta = normalizeMeta(meta, torrent);
  const infoHash = normalizeInfoHash(torrent?.info_hash || torrent?.infoHash || torrent?.hash);
  if (!infoHash || !normalizedMeta.imdbId) return false;

  try {
    return await withClient(async (client) => {
      await client.query('BEGIN');
      try {
        const inserted = await upsertTorrentRow(client, torrent);
        await upsertFileMappingRow(client, {
          info_hash: infoHash,
          file_index: torrent?.file_index ?? torrent?.fileIdx,
          imdb_id: normalizedMeta.imdbId,
          imdb_season: normalizedMeta.season,
          imdb_episode: normalizedMeta.episode,
          title: torrent?.title,
          size: torrent?.size
        });
        await client.query('COMMIT');
        return inserted;
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
    });
  } catch (error) {
    console.error(`❌ DB Save Error: ${error.message}`);
    return false;
  }
}

async function insertTorrentsBatch(meta, torrents) {
  if (!pool || !Array.isArray(torrents) || torrents.length === 0) return { inserted: 0, processed: 0 };
  await awaitDatabaseOptimizations();

  const normalizedMeta = normalizeMeta(meta, torrents[0] || {});
  if (!normalizedMeta.imdbId) return { inserted: 0, processed: 0 };

  const items = torrents
    .map((torrent) => ({
      infoHash: normalizeInfoHash(torrent?.info_hash || torrent?.infoHash || torrent?.hash),
      torrent
    }))
    .filter((entry) => entry.infoHash);

  if (items.length === 0) return { inserted: 0, processed: 0 };

  try {
    return await withClient(async (client) => {
      let inserted = 0;
      await client.query('BEGIN');
      try {
        for (const entry of items) {
          const wasInserted = await upsertTorrentRow(client, entry.torrent);
          if (wasInserted) inserted += 1;
          await upsertFileMappingRow(client, {
            info_hash: entry.infoHash,
            file_index: entry.torrent?.file_index ?? entry.torrent?.fileIdx,
            imdb_id: normalizedMeta.imdbId,
            imdb_season: normalizedMeta.season,
            imdb_episode: normalizedMeta.episode,
            title: entry.torrent?.title,
            size: entry.torrent?.size
          });
        }
        await client.query('COMMIT');
        return { inserted, processed: items.length };
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
    });
  } catch (error) {
    console.error(`❌ DB Batch Save Error: ${error.message}`);
    return { inserted: 0, processed: 0, error: error.message };
  }
}

async function ensureTorrentRecord(torrent) {
  if (!pool) return false;
  await awaitDatabaseOptimizations();

  const cleanHash = normalizeInfoHash(torrent?.info_hash || torrent?.infoHash || torrent?.hash);
  if (!cleanHash) return false;

  try {
    return await withClient(async (client) => {
      await client.query('BEGIN');
      try {
        const inserted = await upsertTorrentRow(client, {
          ...torrent,
          info_hash: cleanHash
        });
        await client.query('COMMIT');
        return inserted;
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
    });
  } catch (error) {
    console.error(`❌ DB ensureTorrentRecord Error: ${error.message}`);
    return false;
  }
}

async function updateTorrentTitle(infoHash, title) {
  if (!pool) return false;
  await awaitDatabaseOptimizations();

  const hash = normalizeInfoHash(infoHash);
  const safeTitle = sanitizeText(title);
  if (!hash || !safeTitle) return false;

  try {
    const result = await pool.query(
      `
        UPDATE torrents
        SET title = CASE
              WHEN title IS NULL OR title = '' THEN $2
              WHEN LENGTH($2) > LENGTH(title) THEN $2
              ELSE title
            END,
            updated_at = NOW()
        WHERE info_hash_norm = $1
      `,
      [hash, safeTitle]
    );
    return result.rowCount > 0;
  } catch (error) {
    console.error(`❌ DB updateTorrentTitle Error: ${error.message}`);
    return false;
  }
}

async function insertEpisodeFiles(entries) {
  if (!pool || !Array.isArray(entries) || entries.length === 0) return { inserted: 0, processed: 0 };
  await awaitDatabaseOptimizations();

  const normalized = entries
    .map((entry) => ({
      info_hash: normalizeInfoHash(entry?.info_hash || entry?.infoHash || entry?.hash),
      file_index: normalizeFileIndex(entry?.file_index ?? entry?.fileIdx),
      imdb_id: normalizeImdbId(entry?.imdb_id || entry?.imdbId),
      imdb_season: toNullableInt(entry?.imdb_season ?? entry?.season),
      imdb_episode: toNullableInt(entry?.imdb_episode ?? entry?.episode),
      title: sanitizeText(entry?.title),
      size: Math.max(0, toSafeNumber(entry?.size, 0))
    }))
    .filter((entry) => entry.info_hash && entry.imdb_id);

  if (normalized.length === 0) return { inserted: 0, processed: 0 };

  try {
    return await withClient(async (client) => {
      let inserted = 0;
      await client.query('BEGIN');
      try {
        for (const entry of normalized) {
          const wasInserted = await upsertFileMappingRow(client, entry);
          if (wasInserted) inserted += 1;
        }
        await client.query('COMMIT');
        return { inserted, processed: normalized.length };
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
    });
  } catch (error) {
    console.error(`❌ DB Error insertEpisodeFiles: ${error.message}`);
    return { inserted: 0, processed: 0, error: error.message };
  }
}

async function insertPackFiles(entries) {
  if (!pool || !Array.isArray(entries) || entries.length === 0) return { inserted: 0, processed: 0 };
  await awaitDatabaseOptimizations();

  const normalized = entries
    .map((entry) => ({
      pack_hash: normalizeInfoHash(entry?.pack_hash || entry?.packHash || entry?.info_hash || entry?.infoHash || entry?.hash),
      file_index: normalizeFileIndex(entry?.file_index ?? entry?.fileIdx ?? entry?.index),
      imdb_id: normalizeImdbId(entry?.imdb_id || entry?.imdbId),
      imdb_season: toNullableInt(entry?.imdb_season ?? entry?.season),
      imdb_episode: toNullableInt(entry?.imdb_episode ?? entry?.episode),
      file_path: sanitizeText(entry?.file_path || entry?.path),
      file_title: sanitizeText(entry?.file_title || entry?.title),
      file_size: Math.max(0, toSafeNumber(entry?.file_size ?? entry?.size, 0))
    }))
    .filter((entry) => entry.pack_hash);

  if (normalized.length === 0) return { inserted: 0, processed: 0 };

  try {
    return await withClient(async (client) => {
      let inserted = 0;
      await client.query('BEGIN');
      try {
        for (const entry of normalized) {
          const wasInserted = await upsertPackFileRow(client, entry);
          if (wasInserted) inserted += 1;
        }
        await client.query('COMMIT');
        return { inserted, processed: normalized.length };
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
    });
  } catch (error) {
    console.error(`❌ DB Error insertPackFiles: ${error.message}`);
    return { inserted: 0, processed: 0, error: error.message };
  }
}

async function getEpisodeFileMappings(imdbId, season = null, episode = null) {
  if (!pool) return [];
  await awaitDatabaseOptimizations();

  const normalizedImdb = normalizeImdbId(imdbId);
  if (!normalizedImdb) return [];

  const normalizedSeason = toNullableInt(season);
  const normalizedEpisode = toNullableInt(episode);
  const params = [normalizedImdb];

  let query = `
        SELECT DISTINCT ON (info_hash_norm)
          info_hash_norm AS hash,
          file_index,
          title,
          size,
          imdb_season,
          imdb_episode
        FROM files
        WHERE imdb_id = $1
  `;

  if (normalizedSeason !== null) {
    params.push(normalizedSeason);
    query += ` AND COALESCE(imdb_season, 0) = $${params.length}`;
  }

  if (normalizedEpisode !== null) {
    params.push(normalizedEpisode);
    query += ` AND COALESCE(imdb_episode, 0) = $${params.length}`;
  }

  query += `
        ORDER BY
          info_hash_norm,
          COALESCE(size, 0) DESC,
          file_index_norm ASC
  `;

  try {
    const res = await pool.query(query, params);
    return (res.rows || []).map((row) => ({
      hash: normalizeInfoHash(row.hash),
      file_index: normalizeFileIndex(row.file_index),
      title: sanitizeText(row.title),
      size: toSafeNumber(row.size, 0),
      imdb_season: toNullableInt(row.imdb_season),
      imdb_episode: toNullableInt(row.imdb_episode)
    })).filter((row) => row.hash && row.file_index !== null);
  } catch (error) {
    console.error(`❌ DB Error getEpisodeFileMappings: ${error.message}`);
    return [];
  }
}

async function getPackFiles(infoHash, limit = 50) {
  if (!pool) return [];
  await awaitDatabaseOptimizations();

  const hash = normalizeInfoHash(infoHash);
  if (!hash) return [];

  try {
    const res = await pool.query(
      `
        SELECT
          pack_hash AS info_hash,
          file_index,
          file_path,
          file_title,
          file_size,
          imdb_id,
          imdb_season,
          imdb_episode
        FROM pack_files
        WHERE pack_hash_norm = $1
        ORDER BY
          CASE WHEN imdb_episode IS NOT NULL THEN 0 ELSE 1 END,
          COALESCE(imdb_season, 0),
          COALESCE(imdb_episode, 0),
          COALESCE(file_size, 0) DESC,
          file_index_norm ASC
        LIMIT $2
      `,
      [hash, clampInt(limit, 50, 1, 500)]
    );
    return res.rows || [];
  } catch (error) {
    console.error(`❌ DB Error getPackFiles: ${error.message}`);
    return [];
  }
}

async function getSeriesPackFiles(infoHash) {
  if (!pool) return [];
  await awaitDatabaseOptimizations();

  const hash = normalizeInfoHash(infoHash);
  if (!hash) return [];

  try {
    const res = await pool.query(
      `
        SELECT
          pack_hash AS info_hash,
          file_index,
          file_path,
          file_title,
          file_size,
          imdb_id,
          imdb_season,
          imdb_episode
        FROM pack_files
        WHERE pack_hash_norm = $1
          AND imdb_episode IS NOT NULL
        ORDER BY
          COALESCE(imdb_season, 0),
          COALESCE(imdb_episode, 0),
          COALESCE(file_size, 0) DESC,
          file_index_norm ASC
      `,
      [hash]
    );
    return res.rows || [];
  } catch (error) {
    console.error(`❌ DB Error getSeriesPackFiles: ${error.message}`);
    return [];
  }
}

async function getRdScanBatch(limit = 5) {
  if (!pool) return [];
  await awaitDatabaseOptimizations();

  const batchLimit = clampInt(limit, 5, 1, 50);

  try {
    const res = await pool.query(
      `
        WITH ranked AS (
          SELECT
            info_hash_norm AS hash,
            title,
            rd_cache_state,
            cached_rd,
            next_cached_check,
            last_cached_check,
            cache_check_failures,
            ROW_NUMBER() OVER (
              PARTITION BY info_hash_norm
              ORDER BY
                COALESCE(next_cached_check, TIMESTAMPTZ '1970-01-01 00:00:00+00') ASC,
                COALESCE(last_cached_check, TIMESTAMPTZ '1970-01-01 00:00:00+00') ASC,
                COALESCE(cache_check_failures, 0) ASC
            ) AS rn
          FROM torrents
          WHERE info_hash_norm IS NOT NULL
            AND (
              cached_rd IS DISTINCT FROM TRUE
              OR rd_cache_state IS DISTINCT FROM 'cached'
            )
            AND (
              next_cached_check IS NULL
              OR next_cached_check <= NOW()
            )
        )
        SELECT hash, title, rd_cache_state, cached_rd, next_cached_check, last_cached_check, cache_check_failures
        FROM ranked
        WHERE rn = 1
        LIMIT $1
      `,
      [batchLimit]
    );
    return (res.rows || []).map((row) => ({
      hash: normalizeInfoHash(row.hash),
      title: sanitizeText(row.title),
      rd_cache_state: normalizeRdCacheState(row.rd_cache_state),
      cached_rd: row.cached_rd === null || row.cached_rd === undefined ? null : Boolean(row.cached_rd),
      next_cached_check: row.next_cached_check || null,
      last_cached_check: row.last_cached_check || null,
      cache_check_failures: toSafeNumber(row.cache_check_failures, 0)
    })).filter((row) => row.hash);
  } catch (error) {
    console.error(`❌ DB Error getRdScanBatch: ${error.message}`);
    return [];
  }
}

async function getRdCacheStatusByHashes(hashes) {
  if (!pool) return [];
  await awaitDatabaseOptimizations();

  const normalizedHashes = [...new Set((Array.isArray(hashes) ? hashes : [])
    .map((hash) => normalizeInfoHash(hash))
    .filter(Boolean))];

  if (normalizedHashes.length === 0) return [];

  try {
    return await withClient(async (client) => {
      const res = await client.query(
        `
          SELECT DISTINCT ON (info_hash_norm)
            info_hash_norm AS hash,
            cached_rd,
            rd_cache_state,
            rd_file_index,
            rd_file_size,
            size,
            last_cached_check,
            next_cached_check,
            cache_check_failures
          FROM torrents
          WHERE info_hash_norm = ANY($1::text[])
          ORDER BY
            info_hash_norm,
            CASE
              WHEN cached_rd IS TRUE THEN 4
              WHEN rd_cache_state = 'cached' THEN 3
              WHEN rd_cache_state IN ('likely_cached', 'probing') THEN 2
              WHEN rd_cache_state IN ('likely_uncached', 'uncached_terminal') THEN 1
              ELSE 0
            END DESC,
            COALESCE(rd_file_size, size, 0) DESC,
            COALESCE(last_cached_check, TIMESTAMPTZ '1970-01-01 00:00:00+00') DESC
        `,
        [normalizedHashes]
      );
      return (res.rows || []).map((row) => ({
        hash: normalizeInfoHash(row.hash),
        cached_rd: row.cached_rd === null || row.cached_rd === undefined ? null : Boolean(row.cached_rd),
        rd_cache_state: normalizeRdCacheState(row.rd_cache_state),
        rd_file_index: normalizeFileIndex(row.rd_file_index),
        rd_file_size: toSafeNumber(row.rd_file_size, 0),
        size: toSafeNumber(row.size, 0),
        last_cached_check: row.last_cached_check || null,
        next_cached_check: row.next_cached_check || null,
        cache_check_failures: toSafeNumber(row.cache_check_failures, 0)
      })).filter((row) => row.hash);
    });
  } catch (error) {
    console.error(`❌ DB Error getRdCacheStatusByHashes: ${error.message}`);
    return [];
  }
}

async function getRdCachedAvailability(hashes) {
  const rows = await getRdCacheStatusByHashes(hashes);
  const mapped = {};
  for (const row of rows) {
    if (!row?.hash) continue;
    if (row.cached_rd === true || row.cached_rd === false) {
      mapped[row.hash] = row.cached_rd;
    } else if (row.rd_cache_state === 'cached') {
      mapped[row.hash] = true;
    } else if (row.rd_cache_state === 'uncached_terminal') {
      mapped[row.hash] = false;
    }
  }
  return mapped;
}

async function updateRdCacheStatus(cacheResults) {
  if (!pool || !Array.isArray(cacheResults) || cacheResults.length === 0) return 0;
  await awaitDatabaseOptimizations();

  const normalizedRows = cacheResults
    .map((entry) => {
      const hasCached = typeof entry?.cached === 'boolean';
      const permanent = hasCached && entry.cached === true && entry?.permanent !== false;
      const nextHours = permanent
        ? null
        : Math.max(1, Math.min(24 * 365 * 10, toSafeNumber(entry?.next_hours, hasCached ? (entry.cached ? 24 * 30 : 24 * 7) : 12)));
      const state = deriveStoredCacheState(entry);
      const cached = deriveCachedBooleanFromState(state, hasCached ? entry.cached : null);
      return {
        hash: normalizeInfoHash(entry?.hash),
        cached,
        rd_cache_state: state,
        rd_file_index: normalizeFileIndex(entry?.rd_file_index ?? entry?.file_id),
        rd_file_size: entry?.rd_file_size === null || entry?.rd_file_size === undefined ? toNullableInt(entry?.file_size) : toSafeNumber(entry?.rd_file_size, 0),
        failures: Math.max(0, toSafeNumber(entry?.failures, 0)),
        next_hours: nextHours,
        permanent,
        title: sanitizeText(entry?.torrent_title || entry?.title),
        size: Math.max(0, toSafeNumber(entry?.size, 0))
      };
    })
    .filter((entry) => entry.hash);

  if (normalizedRows.length === 0) return 0;

  try {
    return await withClient(async (client) => {
      let updated = 0;
      await client.query('BEGIN');
      try {
        for (const row of normalizedRows) {
          const result = await client.query(
            `
              UPDATE torrents
              SET rd_cache_state = CASE
                    WHEN $3::text IS NULL OR $3::text = '' THEN rd_cache_state
                    ELSE $3::text
                  END,
                  cached_rd = CASE
                    WHEN $3::text = 'cached' THEN TRUE
                    WHEN $3::text = 'uncached_terminal' THEN FALSE
                    WHEN $3::text IN ('likely_cached', 'probing', 'likely_uncached', 'unknown') THEN NULL
                    WHEN $2::boolean IS NULL THEN cached_rd
                    ELSE $2::boolean
                  END,
                  rd_file_index = CASE
                    WHEN $4::integer IS NULL OR $4::integer < 0 THEN rd_file_index
                    ELSE $4::integer
                  END,
                  rd_file_size = CASE
                    WHEN $5::bigint IS NULL OR $5::bigint <= 0 THEN rd_file_size
                    ELSE $5::bigint
                  END,
                  title = CASE
                    WHEN $8::text = '' THEN title
                    WHEN title IS NULL OR title = '' THEN $8::text
                    WHEN LENGTH($8::text) > LENGTH(title) THEN $8::text
                    ELSE title
                  END,
                  size = CASE
                    WHEN $9::bigint <= 0 THEN size
                    ELSE GREATEST(COALESCE(size, 0), $9::bigint)
                  END,
                  cache_check_failures = GREATEST(0, COALESCE($6::integer, 0)),
                  last_cached_check = NOW(),
                  next_cached_check = CASE
                    WHEN COALESCE($7::boolean, FALSE) IS TRUE THEN TIMESTAMPTZ '9999-12-31 00:00:00+00'
                    ELSE NOW() + make_interval(hours => GREATEST(1, COALESCE($10::integer, 12)))
                  END,
                  updated_at = NOW()
              WHERE info_hash_norm = $1
                AND (
                  $4::integer IS NULL
                  OR file_index_norm = COALESCE($4::integer, -1)
                  OR file_index = $4::integer
                )
            `,
            [row.hash, row.cached, row.rd_cache_state, row.rd_file_index, row.rd_file_size, row.failures, row.permanent, row.title, row.size, row.next_hours]
          );
          updated += Number(result.rowCount || 0);
        }
        await client.query('COMMIT');
        return updated;
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
    });
  } catch (error) {
    console.error(`❌ DB Error updateCache: ${error.message}`);
    return 0;
  }
}

async function updateTbCacheStatus(updates) {
  if (!pool || !Array.isArray(updates) || updates.length === 0) return 0;
  await awaitDatabaseOptimizations();

  const rows = updates
    .map((entry) => ({
      hash: normalizeInfoHash(entry?.hash),
      cached: typeof entry?.cached === 'boolean' ? entry.cached : null,
      fileId: normalizeFileIndex(entry?.file_id),
      fileSize: entry?.file_size === null || entry?.file_size === undefined ? null : toSafeNumber(entry?.file_size, 0),
      title: sanitizeText(entry?.torrent_title || entry?.title),
      size: Math.max(0, toSafeNumber(entry?.size, 0))
    }))
    .filter((entry) => entry.hash);

  if (rows.length === 0) return 0;

  try {
    return await withClient(async (client) => {
      let updated = 0;
      await client.query('BEGIN');
      try {
        for (const row of rows) {
          const result = await client.query(
            `
              UPDATE torrents
              SET tb_cached = COALESCE($2, tb_cached),
                  tb_file_id = CASE
                    WHEN $3 IS NULL OR $3 < 0 THEN tb_file_id
                    ELSE $3
                  END,
                  tb_file_size = CASE
                    WHEN $4 IS NULL OR $4 <= 0 THEN tb_file_size
                    ELSE $4
                  END,
                  title = CASE
                    WHEN $5 = '' THEN title
                    WHEN title IS NULL OR title = '' THEN $5
                    WHEN LENGTH($5) > LENGTH(title) THEN $5
                    ELSE title
                  END,
                  size = CASE
                    WHEN $6 <= 0 THEN size
                    ELSE GREATEST(COALESCE(size, 0), $6)
                  END,
                  tb_last_cached_check = NOW(),
                  updated_at = NOW()
              WHERE info_hash_norm = $1
            `,
            [row.hash, row.cached, row.fileId, row.fileSize, row.title, row.size]
          );
          updated += Number(result.rowCount || 0);
        }
        await client.query('COMMIT');
        return updated;
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
    });
  } catch (error) {
    console.error(`❌ DB Error updateTbCacheStatus: ${error.message}`);
    return 0;
  }
}

async function getRdScanProgress() {
  if (!pool) return null;
  await awaitDatabaseOptimizations();

  try {
    const res = await pool.query(`
      SELECT
        COUNT(*) FILTER (WHERE info_hash IS NOT NULL) AS total_with_hash,
        COUNT(*) FILTER (WHERE info_hash IS NOT NULL AND last_cached_check IS NULL) AS pending_first_scan,
        COUNT(*) FILTER (WHERE info_hash IS NOT NULL AND last_cached_check IS NOT NULL) AS already_scanned,
        COUNT(*) FILTER (WHERE info_hash IS NOT NULL AND last_cached_check IS NOT NULL AND cached_rd IS TRUE) AS cached_true,
        COUNT(*) FILTER (WHERE info_hash IS NOT NULL AND last_cached_check IS NOT NULL AND cached_rd IS FALSE) AS cached_false,
        COUNT(*) FILTER (WHERE info_hash IS NOT NULL AND next_cached_check IS NOT NULL AND next_cached_check <= NOW()) AS due_now
      FROM torrents
    `);
    return res.rows?.[0] || null;
  } catch (error) {
    console.error(`❌ DB Error getRdScanProgress: ${error.message}`);
    return null;
  }
}

async function prioritizeRdHashes(hashes, options = {}) {
  if (!pool) return { requested: 0, updated: 0 };
  await awaitDatabaseOptimizations();

  const normalizedHashes = [...new Set((Array.isArray(hashes) ? hashes : [])
    .map((hash) => normalizeInfoHash(hash))
    .filter(Boolean))]
    .slice(0, clampInt(options.limit, 30, 1, 100));

  if (normalizedHashes.length === 0) return { requested: 0, updated: 0 };

  const priorityMinutes = clampInt(options.priorityMinutes, 5, 0, 24 * 60);

  try {
    const result = await pool.query(
      `
        UPDATE torrents
        SET next_cached_check = NOW() - make_interval(mins => $2),
            cache_check_failures = CASE
              WHEN COALESCE(cached_rd, FALSE) IS TRUE THEN COALESCE(cache_check_failures, 0)
              ELSE LEAST(COALESCE(cache_check_failures, 0), 1)
            END,
            updated_at = NOW()
        WHERE info_hash_norm = ANY($1::text[])
          AND COALESCE(cached_rd, FALSE) IS NOT TRUE
      `,
      [normalizedHashes, priorityMinutes]
    );
    return { requested: normalizedHashes.length, updated: Number(result.rowCount || 0) };
  } catch (error) {
    console.error(`❌ DB Error prioritizeRdHashes: ${error.message}`);
    return { requested: normalizedHashes.length, updated: 0, error: error.message };
  }
}

async function normalizePendingRdCacheState(options = {}) {
  if (!pool) return { applied: false, updated: 0, reason: 'pool_missing' };
  const schemaReady = await awaitDatabaseOptimizations();
  if (!schemaReady) return { applied: false, updated: 0, reason: 'schema_not_ready' };

  const chunkSize = clampInt(options.chunkSize, 10000, 500, 50000);
  const lockKey = 884421337;
  let lockAcquired = false;

  try {
    return await withClient(async (client) => {
      const lockRes = await client.query('SELECT pg_try_advisory_lock($1) AS locked', [lockKey]);
      lockAcquired = Boolean(lockRes.rows?.[0]?.locked);
      if (!lockAcquired) return { applied: false, updated: 0, reason: 'lock_not_acquired' };

      let totalUpdated = 0;

      while (true) {
        const updateRes = await client.query(
          `
            WITH target AS (
              SELECT ctid
              FROM torrents
              WHERE info_hash IS NOT NULL
                AND last_cached_check IS NULL
                AND (
                  cached_rd IS NOT NULL
                  OR rd_cache_state IS NOT NULL
                  OR rd_file_index IS NOT NULL
                  OR rd_file_size IS NOT NULL
                  OR COALESCE(cache_check_failures, 0) <> 0
                  OR next_cached_check IS NOT NULL
                )
              LIMIT $1
            )
            UPDATE torrents AS t
            SET cached_rd = NULL,
                rd_cache_state = NULL,
                rd_file_index = NULL,
                rd_file_size = NULL,
                cache_check_failures = 0,
                next_cached_check = NULL,
                updated_at = NOW()
            FROM target
            WHERE t.ctid = target.ctid
          `,
          [chunkSize]
        );

        const changed = Number(updateRes.rowCount || 0);
        totalUpdated += changed;
        if (changed === 0) break;
      }

      return { applied: true, updated: totalUpdated, reason: 'normalized' };
    });
  } catch (error) {
    console.error(`❌ DB Error normalizePendingRdCacheState: ${error.message}`);
    return { applied: false, updated: 0, reason: error.message };
  } finally {
    if (lockAcquired) {
      try {
        await pool.query('SELECT pg_advisory_unlock($1)', [lockKey]);
      } catch (_) {}
    }
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
  getPool: () => pool,
  withClient,
  healthCheck,
  getTorrents,
  getEpisodeFileMappings,
  getPackFiles,
  getSeriesPackFiles,
  getRdScanBatch,
  insertTorrent,
  insertTorrentsBatch,
  insertEpisodeFiles,
  insertPackFiles,
  updateTorrentTitle,
  ensureTorrentRecord,
  getRdCacheStatusByHashes,
  getRdCachedAvailability,
  updateRdCacheStatus,
  updateTbCacheStatus,
  getRdScanProgress,
  prioritizeRdHashes,
  normalizePendingRdCacheState,
  updateTrackers: trackerRegistry.updateTrackers,
  getActiveTrackers: trackerRegistry.getActiveTrackers,
  buildMagnet: trackerRegistry.buildMagnet,
  initTrackerRegistry: trackerRegistry.initTrackerRegistry,
  shutdownTrackerRegistry: trackerRegistry.shutdownTrackerRegistry
};
