async function ensureDatabaseOptimizations(pool) {
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
    `CREATE TABLE IF NOT EXISTS episode_file_overrides (
      info_hash TEXT NOT NULL,
      info_hash_norm TEXT,
      imdb_id TEXT NOT NULL,
      imdb_season INTEGER NOT NULL,
      imdb_episode INTEGER NOT NULL,
      rd_file_index INTEGER,
      rd_file_size BIGINT,
      tb_file_id INTEGER,
      tb_file_size BIGINT,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )`,
    `CREATE TABLE IF NOT EXISTS shared_stream_cache (
      cache_key TEXT PRIMARY KEY,
      payload_b64 TEXT NOT NULL,
      encoding TEXT NOT NULL DEFAULT 'identity',
      expires_at TIMESTAMPTZ NOT NULL,
      stale_until TIMESTAMPTZ NOT NULL,
      imdb_id TEXT,
      imdb_season INTEGER,
      imdb_episode INTEGER,
      hashes TEXT[] DEFAULT ARRAY[]::TEXT[],
      content_date TIMESTAMPTZ,
      freshness_bucket TEXT,
      confidence_score INTEGER DEFAULT 0,
      result_count INTEGER DEFAULT 0,
      cached_count INTEGER DEFAULT 0,
      best_quality TEXT,
      source_mix TEXT[] DEFAULT ARRAY[]::TEXT[],
      policy_version INTEGER DEFAULT 1,
      hit_count BIGINT DEFAULT 0,
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

    `ALTER TABLE episode_file_overrides ADD COLUMN IF NOT EXISTS info_hash_norm TEXT`,
    `ALTER TABLE episode_file_overrides ADD COLUMN IF NOT EXISTS imdb_id TEXT`,
    `ALTER TABLE episode_file_overrides ADD COLUMN IF NOT EXISTS imdb_season INTEGER`,
    `ALTER TABLE episode_file_overrides ADD COLUMN IF NOT EXISTS imdb_episode INTEGER`,
    `ALTER TABLE episode_file_overrides ADD COLUMN IF NOT EXISTS rd_file_index INTEGER`,
    `ALTER TABLE episode_file_overrides ADD COLUMN IF NOT EXISTS rd_file_size BIGINT`,
    `ALTER TABLE episode_file_overrides ADD COLUMN IF NOT EXISTS tb_file_id INTEGER`,
    `ALTER TABLE episode_file_overrides ADD COLUMN IF NOT EXISTS tb_file_size BIGINT`,
    `ALTER TABLE episode_file_overrides ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT NOW()`,
    `ALTER TABLE episode_file_overrides ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW()`,

    `ALTER TABLE shared_stream_cache ADD COLUMN IF NOT EXISTS payload_b64 TEXT`,
    `ALTER TABLE shared_stream_cache ADD COLUMN IF NOT EXISTS encoding TEXT NOT NULL DEFAULT 'identity'`,
    `ALTER TABLE shared_stream_cache ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ`,
    `ALTER TABLE shared_stream_cache ADD COLUMN IF NOT EXISTS stale_until TIMESTAMPTZ`,
    `ALTER TABLE shared_stream_cache ADD COLUMN IF NOT EXISTS imdb_id TEXT`,
    `ALTER TABLE shared_stream_cache ADD COLUMN IF NOT EXISTS imdb_season INTEGER`,
    `ALTER TABLE shared_stream_cache ADD COLUMN IF NOT EXISTS imdb_episode INTEGER`,
    `ALTER TABLE shared_stream_cache ADD COLUMN IF NOT EXISTS hashes TEXT[] DEFAULT ARRAY[]::TEXT[]`,
    `ALTER TABLE shared_stream_cache ADD COLUMN IF NOT EXISTS content_date TIMESTAMPTZ`,
    `ALTER TABLE shared_stream_cache ADD COLUMN IF NOT EXISTS freshness_bucket TEXT`,
    `ALTER TABLE shared_stream_cache ADD COLUMN IF NOT EXISTS confidence_score INTEGER DEFAULT 0`,
    `ALTER TABLE shared_stream_cache ADD COLUMN IF NOT EXISTS result_count INTEGER DEFAULT 0`,
    `ALTER TABLE shared_stream_cache ADD COLUMN IF NOT EXISTS cached_count INTEGER DEFAULT 0`,
    `ALTER TABLE shared_stream_cache ADD COLUMN IF NOT EXISTS best_quality TEXT`,
    `ALTER TABLE shared_stream_cache ADD COLUMN IF NOT EXISTS source_mix TEXT[] DEFAULT ARRAY[]::TEXT[]`,
    `ALTER TABLE shared_stream_cache ADD COLUMN IF NOT EXISTS policy_version INTEGER DEFAULT 1`,
    `ALTER TABLE shared_stream_cache ADD COLUMN IF NOT EXISTS hit_count BIGINT DEFAULT 0`,
    `ALTER TABLE shared_stream_cache ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT NOW()`,
    `ALTER TABLE shared_stream_cache ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW()`,

    `UPDATE torrents SET info_hash_norm = LOWER(TRIM(info_hash)) WHERE info_hash IS NOT NULL AND (info_hash_norm IS NULL OR info_hash_norm <> LOWER(TRIM(info_hash)))`,
    `UPDATE torrents SET file_index_norm = COALESCE(file_index, -1) WHERE file_index_norm IS DISTINCT FROM COALESCE(file_index, -1)`,
    `UPDATE files SET info_hash_norm = LOWER(TRIM(info_hash)) WHERE info_hash IS NOT NULL AND (info_hash_norm IS NULL OR info_hash_norm <> LOWER(TRIM(info_hash)))`,
    `UPDATE files SET file_index_norm = COALESCE(file_index, -1) WHERE file_index_norm IS DISTINCT FROM COALESCE(file_index, -1)`,
    `UPDATE pack_files SET pack_hash_norm = LOWER(TRIM(pack_hash)) WHERE pack_hash IS NOT NULL AND (pack_hash_norm IS NULL OR pack_hash_norm <> LOWER(TRIM(pack_hash)))`,
    `UPDATE pack_files SET file_index_norm = COALESCE(file_index, -1) WHERE file_index_norm IS DISTINCT FROM COALESCE(file_index, -1)`,
    `UPDATE episode_file_overrides SET info_hash_norm = LOWER(TRIM(info_hash)) WHERE info_hash IS NOT NULL AND (info_hash_norm IS NULL OR info_hash_norm <> LOWER(TRIM(info_hash)))`,

    `CREATE INDEX IF NOT EXISTS idx_torrents_info_hash_norm ON torrents (info_hash_norm)`,
    `CREATE INDEX IF NOT EXISTS idx_torrents_lookup_hash_file ON torrents (info_hash_norm, file_index_norm)`,
    `CREATE INDEX IF NOT EXISTS idx_torrents_rd_scan_queue ON torrents (next_cached_check NULLS FIRST, last_cached_check NULLS FIRST)`,
    `CREATE INDEX IF NOT EXISTS idx_torrents_rd_cache_state ON torrents (rd_cache_state, next_cached_check NULLS FIRST)`,
    `CREATE INDEX IF NOT EXISTS idx_torrents_tb_cache_state ON torrents (tb_cached, tb_last_cached_check NULLS FIRST)`,

    `CREATE INDEX IF NOT EXISTS idx_files_lookup_episode ON files (imdb_id, imdb_season, imdb_episode, info_hash_norm, file_index_norm)`,
    `CREATE INDEX IF NOT EXISTS idx_files_lookup_movie ON files (imdb_id, info_hash_norm, file_index_norm)`,
    `CREATE INDEX IF NOT EXISTS idx_files_info_hash_norm ON files (info_hash_norm, file_index_norm)`,

    `CREATE INDEX IF NOT EXISTS idx_pack_files_hash ON pack_files (pack_hash_norm, file_index_norm)`,
    `CREATE INDEX IF NOT EXISTS idx_pack_files_series_lookup ON pack_files (pack_hash_norm, imdb_season, imdb_episode, file_index_norm)`,
    `CREATE INDEX IF NOT EXISTS idx_episode_file_overrides_lookup ON episode_file_overrides (info_hash_norm, imdb_id, imdb_season, imdb_episode)`,
    `CREATE INDEX IF NOT EXISTS idx_shared_stream_cache_expires ON shared_stream_cache (expires_at)`,
    `CREATE INDEX IF NOT EXISTS idx_shared_stream_cache_stale_until ON shared_stream_cache (stale_until)`,
    `CREATE INDEX IF NOT EXISTS idx_shared_stream_cache_imdb ON shared_stream_cache (imdb_id)`,
    `CREATE INDEX IF NOT EXISTS idx_shared_stream_cache_imdb_episode ON shared_stream_cache (imdb_id, imdb_season, imdb_episode)`,
    `CREATE INDEX IF NOT EXISTS idx_shared_stream_cache_hashes ON shared_stream_cache USING GIN (hashes)`
  ];

  for (const sql of statements) {
    try {
      await pool.query(sql);
    } catch (error) {
      console.warn(`⚠️ DB optimization skipped: ${error.message}`);
    }
  }

  await deduplicateTableByKey(pool, 'torrents', 'info_hash_norm', 'file_index_norm');
  await deduplicateTableByKey(pool, 'files', 'info_hash_norm', 'file_index_norm');
  await deduplicateTableByKey(pool, 'pack_files', 'pack_hash_norm', 'file_index_norm');

  try {
    await pool.query(`
      WITH ranked AS (
        SELECT ctid,
               ROW_NUMBER() OVER (
                 PARTITION BY info_hash_norm, imdb_id, imdb_season, imdb_episode
                 ORDER BY COALESCE(updated_at, created_at, NOW()) DESC
               ) AS rn
        FROM episode_file_overrides
        WHERE info_hash_norm IS NOT NULL
          AND imdb_id IS NOT NULL
          AND imdb_season IS NOT NULL
          AND imdb_episode IS NOT NULL
      )
      DELETE FROM episode_file_overrides e
      USING ranked r
      WHERE e.ctid = r.ctid
        AND r.rn > 1
    `);
  } catch (error) {
    console.warn(`⚠️ DB dedupe skipped (episode_file_overrides): ${error.message}`);
  }

  const uniqueStatements = [
    `CREATE UNIQUE INDEX IF NOT EXISTS uq_torrents_hash_file_idx_norm ON torrents (info_hash_norm, file_index_norm)`,
    `CREATE UNIQUE INDEX IF NOT EXISTS uq_files_hash_file_idx_norm ON files (info_hash_norm, file_index_norm)`,
    `CREATE UNIQUE INDEX IF NOT EXISTS uq_pack_files_hash_file_idx_norm ON pack_files (pack_hash_norm, file_index_norm)`,
    `CREATE UNIQUE INDEX IF NOT EXISTS uq_episode_file_overrides_identity ON episode_file_overrides (info_hash_norm, imdb_id, imdb_season, imdb_episode)`
  ];

  for (const sql of uniqueStatements) {
    try {
      await pool.query(sql);
    } catch (error) {
      console.warn(`⚠️ DB unique optimization skipped: ${error.message}`);
    }
  }

  try {
    await pool.query(`UPDATE torrents SET next_cached_check = NOW() - make_interval(mins => 1), updated_at = NOW() WHERE cached_rd IS TRUE AND rd_cache_state = 'cached' AND next_cached_check >= TIMESTAMPTZ '9999-01-01 00:00:00+00'`);
    await pool.query(`DELETE FROM shared_stream_cache WHERE stale_until IS NOT NULL AND stale_until < NOW()`);
  } catch (error) {
    console.warn(`⚠️ DB optimization skipped: ${error.message}`);
  }
}

async function deduplicateTableByKey(pool, tableName, hashColumn, fileIndexNormColumn) {
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

module.exports = {
  ensureDatabaseOptimizations
};
