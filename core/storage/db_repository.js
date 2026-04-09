const { Pool } = require('pg');
const trackerRegistry = require('./tracker_registry');

console.log('ðŸ“‚ Caricamento modulo storage/db_helper (PRO)...');

let pool = null;
let databaseOptimizationsPromise = null;
const DB_POOL_MAX = Math.max(10, Math.min(120, parseInt(process.env.DB_POOL_MAX || '40', 10) || 40));
const DB_POOL_IDLE_TIMEOUT_MS = Math.max(5000, Math.min(120000, parseInt(process.env.DB_POOL_IDLE_TIMEOUT_MS || '30000', 10) || 30000));
const DB_POOL_CONNECT_TIMEOUT_MS = Math.max(1000, Math.min(30000, parseInt(process.env.DB_POOL_CONNECT_TIMEOUT_MS || '5000', 10) || 5000));

const KNOWN_PROVIDERS = [
  'ilCorSaRoNeRo', 'Corsaro', '1337x', '1337X', 'TorrentGalaxy', 'TGX', 'GalaxyRG',
  'RARBG', 'Rarbg', 'EZTV', 'Eztv', 'YTS', 'YIFY', 'MagnetDL', 'TorLock',
  'PirateBay', 'TPB', 'ThePirateBay', 'Nyaa', 'RuTracker', 'SolidTorrents'
];

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
  const iconPatterns = [/ðŸ”\s*([^\n]+)/, /ðŸ”—\s*([^\n]+)/, /ðŸ”Ž\s*([^\n]+)/];
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
  if (pool) {
    console.log('â™»ï¸ DB Pool giÃ  inizializzato.');
    return pool;
  }

  const poolConfig = buildPoolConfig(config);
  pool = new Pool({
    ...poolConfig,
    max: DB_POOL_MAX,
    idleTimeoutMillis: DB_POOL_IDLE_TIMEOUT_MS,
    connectionTimeoutMillis: DB_POOL_CONNECT_TIMEOUT_MS,
    allowExitOnIdle: true
  });

  pool.on('error', (err) => {
    console.error(`âŒ Unexpected idle client error: ${err.message}`);
  });

  trackerRegistry.initTrackerRegistry();
  if (!databaseOptimizationsPromise) {
    databaseOptimizationsPromise = ensureDatabaseOptimizations()
      .catch((error) => {
        console.warn(`âš ï¸ DB optimization bootstrap failed: ${error.message}`);
        throw error;
      })
      .finally(() => {
        if (!pool) databaseOptimizationsPromise = null;
      });
  }
  console.log(`âœ… DB Pool Inizializzato (Target: ${poolConfig.host || 'Cloud'})`);
  return pool;
}

async function awaitDatabaseOptimizations() {
  if (!pool) return false;
  if (!databaseOptimizationsPromise) {
    databaseOptimizationsPromise = ensureDatabaseOptimizations()
      .catch((error) => {
        console.warn(`âš ï¸ DB optimization bootstrap failed: ${error.message}`);
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
    console.warn(`âš ï¸ DB optimization await failed: ${error.message}`);
    return false;
  }
}

async function ensureDatabaseOptimizations() {
  if (!pool) return;

  const statements = [
    `ALTER TABLE torrents ADD COLUMN IF NOT EXISTS info_hash_norm TEXT`,
    `ALTER TABLE files ADD COLUMN IF NOT EXISTS info_hash_norm TEXT`,
    `ALTER TABLE torrents ADD COLUMN IF NOT EXISTS cached_rd BOOLEAN`,
    `ALTER TABLE torrents ADD COLUMN IF NOT EXISTS rd_cache_state TEXT`,
    `ALTER TABLE torrents ALTER COLUMN cached_rd DROP DEFAULT`,
    `ALTER TABLE torrents ADD COLUMN IF NOT EXISTS rd_file_index INTEGER`,
    `ALTER TABLE torrents ADD COLUMN IF NOT EXISTS rd_file_size BIGINT`,
    `ALTER TABLE torrents ADD COLUMN IF NOT EXISTS last_cached_check TIMESTAMPTZ`,
    `ALTER TABLE torrents ADD COLUMN IF NOT EXISTS next_cached_check TIMESTAMPTZ`,
    `ALTER TABLE torrents ADD COLUMN IF NOT EXISTS cache_check_failures INTEGER DEFAULT 0`,
    `UPDATE torrents SET info_hash_norm = LOWER(TRIM(info_hash)) WHERE info_hash IS NOT NULL AND (info_hash_norm IS NULL OR info_hash_norm <> LOWER(TRIM(info_hash)))`,
    `UPDATE files SET info_hash_norm = LOWER(TRIM(info_hash)) WHERE info_hash IS NOT NULL AND (info_hash_norm IS NULL OR info_hash_norm <> LOWER(TRIM(info_hash)))`,
    `CREATE INDEX IF NOT EXISTS idx_torrents_info_hash_norm_file_idx ON torrents (info_hash_norm, COALESCE(file_index, -1))`,
    `CREATE INDEX IF NOT EXISTS idx_torrents_cached_rd ON torrents (cached_rd, next_cached_check NULLS FIRST)`,
    `CREATE INDEX IF NOT EXISTS idx_torrents_rd_cache_state ON torrents (rd_cache_state, next_cached_check NULLS FIRST)`,
    `CREATE INDEX IF NOT EXISTS idx_torrents_rd_scan_queue ON torrents (next_cached_check NULLS FIRST, last_cached_check NULLS FIRST)`,
    `CREATE INDEX IF NOT EXISTS idx_files_info_hash_norm ON files (info_hash_norm)`,
    `CREATE INDEX IF NOT EXISTS idx_files_lookup_episode ON files (imdb_id, imdb_season, imdb_episode, info_hash_norm)`,
    `CREATE INDEX IF NOT EXISTS idx_files_lookup_movie ON files (imdb_id, info_hash_norm) WHERE imdb_season IS NULL OR imdb_season = 0`,
    `UPDATE torrents SET next_cached_check = TIMESTAMPTZ '9999-12-31 00:00:00+00' WHERE cached_rd IS TRUE AND (next_cached_check IS NULL OR next_cached_check < TIMESTAMPTZ '9999-12-31 00:00:00+00')`
  ];

  for (const sql of statements) {
    try {
      await pool.query(sql);
    } catch (error) {
      console.warn(`âš ï¸ DB optimization skipped: ${error.message}`);
    }
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

async function getTorrents(imdbId, season, episode) {
  if (!pool || !imdbId) return [];
  await awaitDatabaseOptimizations();

  try {
    return await withClient(async (client) => {
      const normalizedSeason = toNullableInt(season);
      const normalizedEpisode = toNullableInt(episode);
      const isSeriesEpisode = normalizedSeason !== null && normalizedSeason > 0 && normalizedEpisode !== null && normalizedEpisode > 0;

      const selectFields = `
        SELECT DISTINCT ON (COALESCE(t.info_hash_norm, LOWER(TRIM(t.info_hash))), COALESCE(t.file_index, -1))
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
          t.cache_check_failures
        FROM files f
        JOIN torrents t ON COALESCE(f.info_hash_norm, LOWER(TRIM(f.info_hash))) = COALESCE(t.info_hash_norm, LOWER(TRIM(t.info_hash)))
      `;

      let query;
      let params;

      if (isSeriesEpisode) {
        query = `
          ${selectFields}
          WHERE f.imdb_id = $1
            AND f.imdb_season = $2
            AND f.imdb_episode = $3
          ORDER BY COALESCE(t.info_hash_norm, LOWER(TRIM(t.info_hash))), COALESCE(t.file_index, -1), COALESCE(t.seeders, 0) DESC, COALESCE(t.size, 0) DESC
        `;
        params = [imdbId, normalizedSeason, normalizedEpisode];
      } else {
        query = `
          ${selectFields}
          WHERE f.imdb_id = $1
            AND (f.imdb_season IS NULL OR f.imdb_season = 0)
          ORDER BY COALESCE(t.info_hash_norm, LOWER(TRIM(t.info_hash))), COALESCE(t.file_index, -1), COALESCE(t.seeders, 0) DESC, COALESCE(t.size, 0) DESC
        `;
        params = [imdbId];
      }

      const res = await client.query(query, params);
      return res.rows
        .map((row) => {
          const infoHash = normalizeInfoHash(row.info_hash);
          return {
            title: sanitizeText(row.title),
            info_hash: infoHash,
            size: toSafeNumber(row.size, 0),
            seeders: toSafeNumber(row.seeders, 0),
            provider: sanitizeText(row.provider, 'Unknown'),
            magnet: trackerRegistry.buildMagnet(infoHash),
            file_index: toNullableInt(row.file_index),
            cached_rd: row.cached_rd === null || row.cached_rd === undefined ? null : Boolean(row.cached_rd),
            rd_cache_state: normalizeRdCacheState(row.rd_cache_state),
            rd_file_index: toNullableInt(row.rd_file_index),
            rd_file_size: toSafeNumber(row.rd_file_size, 0),
            last_cached_check: row.last_cached_check || null,
            next_cached_check: row.next_cached_check || null,
            cache_check_failures: toSafeNumber(row.cache_check_failures, 0)
          };
        })
        .filter((row) => row.info_hash);
    });
  } catch (error) {
    console.error(`âŒ DB Read Error (${imdbId}): ${error.message}`);
    return [];
  }
}

async function upsertTorrentRow(client, { infoHash, providerName, title, size, seeders, fileIndex }) {
  const normalizedHashExpr = `COALESCE(info_hash_norm, LOWER(TRIM(info_hash)))`;
  const sameHashWhere = `${normalizedHashExpr} = $1`;
  const exactFileWhere = `(
    COALESCE(file_index, -1) = COALESCE($2, -1)
    OR ($2 IS NULL AND (file_index IS NULL OR file_index = 0))
  )`;

  const params = [infoHash, fileIndex, providerName, title, size, seeders];

  const exactUpdateQuery = `
    UPDATE torrents
    SET provider = COALESCE(NULLIF($3, ''), provider),
        title = CASE
          WHEN title IS NULL OR title = '' THEN $4
          WHEN LENGTH($4) > LENGTH(title) THEN $4
          ELSE title
        END,
        size = GREATEST(COALESCE(size, 0), $5),
        seeders = GREATEST(COALESCE(seeders, 0), $6),
        file_index = COALESCE($2, file_index),
        info_hash_norm = $1
    WHERE ${sameHashWhere}
      AND ${exactFileWhere}
    RETURNING 1
  `;

  const exactUpdated = await client.query(exactUpdateQuery, params);
  if (exactUpdated.rowCount > 0) return false;

  const sameHashRow = await client.query(
    `
      SELECT info_hash, file_index
      FROM torrents
      WHERE ${sameHashWhere}
      LIMIT 1
      FOR UPDATE
    `,
    [infoHash]
  );

  if (sameHashRow.rowCount > 0) {
    await client.query(
      `
        UPDATE torrents
        SET provider = COALESCE(NULLIF($2, ''), provider),
            title = CASE
              WHEN title IS NULL OR title = '' THEN $3
              WHEN LENGTH($3) > LENGTH(title) THEN $3
              ELSE title
            END,
            size = GREATEST(COALESCE(size, 0), $4),
            seeders = GREATEST(COALESCE(seeders, 0), $5),
            file_index = COALESCE(file_index, $6),
            info_hash_norm = $1
        WHERE ${sameHashWhere}
      `,
      [infoHash, providerName, title, size, seeders, fileIndex]
    );
    return false;
  }

  await client.query(
    `
      INSERT INTO torrents (info_hash, info_hash_norm, provider, title, size, seeders, file_index)
      VALUES ($1, $1, $2, $3, $4, $5, $6)
    `,
    [infoHash, providerName, title, size, seeders, fileIndex]
  );
  return true;
}

async function insertTorrent(meta, torrent) {
  if (!pool) return false;

  const cleanHash = normalizeInfoHash(torrent?.info_hash || torrent?.infoHash);
  if (!cleanHash) return false;

  try {
    return await withClient(async (client) => {
      await client.query('BEGIN');
      try {
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

        const inserted = await upsertTorrentRow(client, {
          infoHash: cleanHash,
          providerName,
          title,
          size,
          seeders,
          fileIndex
        });

        const normalizedMeta = meta && typeof meta === 'object'
          ? meta
          : {
              imdb_id: torrent?.imdb_id || torrent?.imdbId,
              season: torrent?.season ?? torrent?.imdb_season,
              episode: torrent?.episode ?? torrent?.imdb_episode,
              type: torrent?.type || 'movie'
            };

        const s = normalizedMeta?.type === 'movie' ? null : toNullableInt(normalizedMeta?.season);
        const e = normalizedMeta?.type === 'movie' ? null : toNullableInt(normalizedMeta?.episode);
        const imdbId = sanitizeText(normalizedMeta?.imdb_id || normalizedMeta?.imdbId);
        if (!imdbId) throw new Error('meta.imdb_id mancante');

        await client.query(
          `
            INSERT INTO files (info_hash, info_hash_norm, imdb_id, imdb_season, imdb_episode, title)
            VALUES ($1, $1, $2, $3, $4, $5)
            ON CONFLICT DO NOTHING
          `,
          [cleanHash, imdbId, s, e, title]
        );

        await client.query('COMMIT');
        return inserted;
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
    });
  } catch (error) {
    console.error(`âŒ DB Save Error: ${error.message}`);
    return false;
  }
}

async function ensureTorrentRecord(torrent) {
  if (!pool) return false;

  const cleanHash = normalizeInfoHash(torrent?.info_hash || torrent?.infoHash || torrent?.hash);
  if (!cleanHash) return false;

  try {
    return await withClient(async (client) => {
      await client.query('BEGIN');
      try {
        const seeders = Math.max(0, toSafeNumber(torrent?.seeders, 0));
        const size = Math.max(0, toSafeNumber(torrent?.size, 0));
        const fileIndex = toNullableInt(torrent?.file_index ?? torrent?.fileIdx);
        const title = sanitizeText(torrent?.title, cleanHash);

        let providerName = sanitizeText(torrent?.provider);
        const extracted = extractOriginalProvider(title);
        if (extracted) {
          providerName = extracted;
        } else if (!providerName || providerName === 'Torrentio' || providerName === 'P2P') {
          providerName = 'External';
        }

        const inserted = await upsertTorrentRow(client, {
          infoHash: cleanHash,
          providerName,
          title,
          size,
          seeders,
          fileIndex
        });

        await client.query('COMMIT');
        return inserted;
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
    });
  } catch (error) {
    console.error(`❌ DB Error ensureTorrentRecord: ${error.message}`);
    return false;
  }
}

async function getRdScanBatch(limit = 5) {
  if (!pool) return [];
  await awaitDatabaseOptimizations();

  const normalizedLimit = Math.max(1, Math.min(250, toSafeNumber(limit, 5)));

  try {
    return await withClient(async (client) => {
      const query = `
        SELECT DISTINCT ON (COALESCE(t.info_hash_norm, LOWER(TRIM(t.info_hash))))
          TRIM(t.info_hash) AS info_hash,
          t.title,
          t.file_index,
          t.seeders,
          t.size,
          t.cached_rd,
          t.rd_cache_state,
          t.rd_file_index,
          t.last_cached_check,
          t.next_cached_check,
          t.cache_check_failures
        FROM torrents t
        WHERE t.info_hash IS NOT NULL
          AND COALESCE(t.info_hash_norm, LOWER(TRIM(t.info_hash))) IS NOT NULL
          AND (
            t.last_cached_check IS NULL
            OR t.next_cached_check IS NULL
            OR t.next_cached_check <= NOW()
          )
        ORDER BY
          COALESCE(t.info_hash_norm, LOWER(TRIM(t.info_hash))),
          CASE WHEN t.last_cached_check IS NULL THEN 0 ELSE 1 END ASC,
          t.next_cached_check NULLS FIRST,
          t.last_cached_check NULLS FIRST,
          COALESCE(t.seeders, 0) DESC,
          COALESCE(t.size, 0) DESC,
          COALESCE(t.file_index, -1) ASC
        LIMIT $1
      `;

      const res = await client.query(query, [normalizedLimit]);
      return res.rows
        .map((row) => ({
          hash: normalizeInfoHash(row.info_hash),
          title: sanitizeText(row.title),
          file_index: toNullableInt(row.file_index),
          seeders: toSafeNumber(row.seeders, 0),
          size: toSafeNumber(row.size, 0),
          cached_rd: row.cached_rd === null || row.cached_rd === undefined ? null : Boolean(row.cached_rd),
          rd_cache_state: normalizeRdCacheState(row.rd_cache_state),
          rd_file_index: toNullableInt(row.rd_file_index),
          last_cached_check: row.last_cached_check || null,
          next_cached_check: row.next_cached_check || null,
          cache_check_failures: toSafeNumber(row.cache_check_failures, 0)
        }))
        .filter((row) => row.hash);
    });
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
    .filter(Boolean))]
    .slice(0, 500);

  if (normalizedHashes.length === 0) return [];

  try {
    return await withClient(async (client) => {
      const query = `
        SELECT DISTINCT ON (COALESCE(t.info_hash_norm, LOWER(TRIM(t.info_hash))))
          TRIM(t.info_hash) AS info_hash,
          t.title,
          t.provider,
          t.seeders,
          t.size,
          t.file_index,
          t.cached_rd,
          t.rd_cache_state,
          t.rd_file_index,
          t.rd_file_size,
          t.last_cached_check,
          t.next_cached_check,
          t.cache_check_failures
        FROM torrents t
        WHERE COALESCE(t.info_hash_norm, LOWER(TRIM(t.info_hash))) = ANY($1::text[])
        ORDER BY
          COALESCE(t.info_hash_norm, LOWER(TRIM(t.info_hash))),
          CASE COALESCE(t.rd_cache_state, '')
            WHEN 'cached' THEN 0
            WHEN 'likely_cached' THEN 1
            WHEN 'probing' THEN 2
            WHEN 'likely_uncached' THEN 3
            WHEN 'uncached_terminal' THEN 4
            ELSE CASE
              WHEN t.cached_rd IS TRUE THEN 0
              WHEN t.cached_rd IS FALSE THEN 3
              ELSE 5
            END
          END ASC,
          t.last_cached_check DESC NULLS LAST,
          t.next_cached_check DESC NULLS LAST,
          COALESCE(t.rd_file_size, t.size, 0) DESC,
          COALESCE(t.seeders, 0) DESC,
          COALESCE(t.file_index, -1) ASC
      `;

      const res = await client.query(query, [normalizedHashes]);
      return (res.rows || [])
        .map((row) => ({
          hash: normalizeInfoHash(row.info_hash),
          title: sanitizeText(row.title),
          provider: sanitizeText(row.provider),
          seeders: toSafeNumber(row.seeders, 0),
          size: toSafeNumber(row.size, 0),
          file_index: toNullableInt(row.file_index),
          cached_rd: row.cached_rd === null || row.cached_rd === undefined ? null : Boolean(row.cached_rd),
          rd_cache_state: normalizeRdCacheState(row.rd_cache_state),
          rd_file_index: toNullableInt(row.rd_file_index),
          rd_file_size: toSafeNumber(row.rd_file_size, 0),
          last_cached_check: row.last_cached_check || null,
          next_cached_check: row.next_cached_check || null,
          cache_check_failures: toSafeNumber(row.cache_check_failures, 0)
        }))
        .filter((row) => row.hash);
    });
  } catch (error) {
    console.error(`❌ DB Error getRdCacheStatusByHashes: ${error.message}`);
    return [];
  }
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
        rd_file_index: toNullableInt(entry?.rd_file_index),
        rd_file_size: entry?.rd_file_size === null || entry?.rd_file_size === undefined ? null : toSafeNumber(entry?.rd_file_size, 0),
        failures: Math.max(0, toSafeNumber(entry?.failures, 0)),
        next_hours: nextHours,
        permanent
      };
    })
    .filter((entry) => entry.hash);

  if (normalizedRows.length === 0) return 0;

  try {
    return await withClient(async (client) => {
      await client.query('BEGIN');
      try {
        const values = [];
        const placeholders = normalizedRows
          .map((row, index) => {
            const base = index * 8;
            values.push(row.hash, row.cached, row.rd_cache_state, row.rd_file_index, row.rd_file_size, row.failures, row.next_hours, row.permanent);
            return `($${base + 1}::text, $${base + 2}::boolean, $${base + 3}::text, $${base + 4}::integer, $${base + 5}::bigint, $${base + 6}::integer, $${base + 7}::integer, $${base + 8}::boolean)`;
          })
          .join(', ');

        const query = `
          UPDATE torrents AS t
          SET rd_cache_state = CASE
                WHEN v.rd_cache_state IS NULL OR v.rd_cache_state = '' THEN t.rd_cache_state
                ELSE v.rd_cache_state
              END,
              cached_rd = CASE
                WHEN v.rd_cache_state = 'cached' THEN TRUE
                WHEN v.rd_cache_state = 'uncached_terminal' THEN FALSE
                WHEN v.rd_cache_state IN ('likely_cached', 'probing', 'likely_uncached', 'unknown') THEN NULL
                WHEN v.cached IS NULL THEN t.cached_rd
                ELSE v.cached
              END,
              rd_file_index = CASE
                WHEN v.rd_file_index IS NULL OR v.rd_file_index < 0 THEN t.rd_file_index
                ELSE v.rd_file_index
              END,
              rd_file_size = CASE
                WHEN v.rd_file_size IS NULL OR v.rd_file_size <= 0 THEN t.rd_file_size
                ELSE v.rd_file_size
                END,
                cache_check_failures = GREATEST(0, COALESCE(v.failures, 0)),
                last_cached_check = NOW(),
                next_cached_check = CASE
                  WHEN COALESCE(v.permanent, FALSE) IS TRUE THEN TIMESTAMPTZ '9999-12-31 00:00:00+00'
                  ELSE NOW() + make_interval(hours => GREATEST(1, COALESCE(v.next_hours, 12)))
                END
          FROM (VALUES ${placeholders}) AS v(info_hash, cached, rd_cache_state, rd_file_index, rd_file_size, failures, next_hours, permanent)
          WHERE COALESCE(t.info_hash_norm, LOWER(TRIM(t.info_hash))) = v.info_hash
        `;

        const result = await client.query(query, values);
        await client.query('COMMIT');
        return result.rowCount || 0;
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
    .slice(0, Math.max(1, Math.min(100, toSafeNumber(options.limit, 30))));

  if (normalizedHashes.length === 0) return { requested: 0, updated: 0 };

  const priorityMinutes = Math.max(0, Math.min(24 * 60, toSafeNumber(options.priorityMinutes, 5)));

  try {
    return await withClient(async (client) => {
      const values = [];
      const placeholders = normalizedHashes
        .map((hash, index) => {
          values.push(hash, priorityMinutes);
          const base = index * 2;
          return `($${base + 1}::text, $${base + 2}::integer)`;
        })
        .join(', ');

      const query = `
        UPDATE torrents AS t
        SET next_cached_check = NOW() - make_interval(mins => GREATEST(0, v.priority_minutes)),
            cache_check_failures = CASE
              WHEN COALESCE(t.cached_rd, FALSE) IS TRUE THEN COALESCE(t.cache_check_failures, 0)
              ELSE LEAST(COALESCE(t.cache_check_failures, 0), 1)
            END
        FROM (VALUES ${placeholders}) AS v(info_hash, priority_minutes)
        WHERE COALESCE(t.info_hash_norm, LOWER(TRIM(t.info_hash))) = v.info_hash
          AND COALESCE(t.cached_rd, FALSE) IS NOT TRUE
      `;

      const result = await client.query(query, values);
      return { requested: normalizedHashes.length, updated: Number(result.rowCount || 0) };
    });
  } catch (error) {
    console.error(`❌ DB Error prioritizeRdHashes: ${error.message}`);
    return { requested: normalizedHashes.length, updated: 0, error: error.message };
  }
}


async function normalizePendingRdCacheState(options = {}) {
  if (!pool) return { applied: false, updated: 0, reason: 'pool_missing' };
  const schemaReady = await awaitDatabaseOptimizations();
  if (!schemaReady) return { applied: false, updated: 0, reason: 'schema_not_ready' };

  const chunkSize = Math.max(500, Math.min(50000, toSafeNumber(options.chunkSize, 10000)));
  const lockKey = 884421337;
  let lockAcquired = false;

  try {
    return await withClient(async (client) => {
      const lockRes = await client.query('SELECT pg_try_advisory_lock($1) AS locked', [lockKey]);
      lockAcquired = Boolean(lockRes.rows?.[0]?.locked);
      if (!lockAcquired) {
        return { applied: false, updated: 0, reason: 'lock_not_acquired' };
      }

      let totalUpdated = 0;
      await client.query(`
        ALTER TABLE torrents
        ALTER COLUMN cached_rd DROP DEFAULT
      `);

      while (true) {
        const updateRes = await client.query(`
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
              next_cached_check = NULL
          FROM target
          WHERE t.ctid = target.ctid
        `, [chunkSize]);

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
  getRdScanBatch,
  insertTorrent,
  ensureTorrentRecord,
  getRdCacheStatusByHashes,
  updateRdCacheStatus,
  getRdScanProgress,
  prioritizeRdHashes,
  normalizePendingRdCacheState,
  updateTrackers: trackerRegistry.updateTrackers,
  getActiveTrackers: trackerRegistry.getActiveTrackers,
  buildMagnet: trackerRegistry.buildMagnet,
  initTrackerRegistry: trackerRegistry.initTrackerRegistry,
  shutdownTrackerRegistry: trackerRegistry.shutdownTrackerRegistry
};
