async function ensureDatabaseOptimizations(pool) {
  if (!pool) return;

  const statements = [
    `CREATE TABLE IF NOT EXISTS torrents (
      info_hash TEXT NOT NULL,
      info_hash_norm TEXT,
      file_index INTEGER,
      file_index_norm INTEGER DEFAULT -1,
      provider TEXT,
      torrent_id TEXT,
      type TEXT,
      title TEXT,
      size BIGINT DEFAULT 0,
      seeders INTEGER DEFAULT 0,
      upload_date TIMESTAMPTZ,
      trackers TEXT,
      languages TEXT,
      resolution TEXT,
      quality_tag TEXT,
      codec_tag TEXT,
      hdr_tag TEXT,
      audio_tag TEXT,
      release_group TEXT,
      smart_dedupe_key TEXT,
      folder_size BIGINT DEFAULT 0,
      first_seen_at TIMESTAMPTZ DEFAULT NOW(),
      last_seen_at TIMESTAMPTZ DEFAULT NOW(),
      seen_count INTEGER DEFAULT 1,
      max_seeders INTEGER DEFAULT 0,
      cached_rd BOOLEAN,
      rd_cache_state TEXT,
      rd_file_index INTEGER,
      rd_file_size BIGINT,
      last_cached_check TIMESTAMPTZ,
      next_cached_check TIMESTAMPTZ,
      cache_check_failures INTEGER DEFAULT 0,
      tb_cached BOOLEAN,
      tb_cache_state TEXT,
      tb_cache_confidence NUMERIC(5,2) DEFAULT 0,
      tb_cache_match_reason TEXT,
      tb_next_cached_check TIMESTAMPTZ,
      tb_cache_check_failures INTEGER DEFAULT 0,
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
,
    `CREATE TABLE IF NOT EXISTS external_stream_snapshots (
      snapshot_key TEXT PRIMARY KEY,
      imdb_id TEXT NOT NULL,
      imdb_season INTEGER,
      imdb_episode INTEGER,
      type TEXT,
      info_hash TEXT,
      info_hash_norm TEXT,
      file_index INTEGER,
      file_index_norm INTEGER DEFAULT -1,
      addon TEXT,
      addon_group TEXT,
      provider TEXT,
      title TEXT,
      quality TEXT,
      languages TEXT,
      seeders INTEGER DEFAULT 0,
      size BIGINT DEFAULT 0,
      rd_state TEXT,
      cached BOOLEAN,
      payload_json JSONB NOT NULL,
      first_seen_at TIMESTAMPTZ DEFAULT NOW(),
      last_seen_at TIMESTAMPTZ DEFAULT NOW(),
      seen_count INTEGER DEFAULT 1,
      expires_at TIMESTAMPTZ NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )`,
    `CREATE TABLE IF NOT EXISTS debrid_availability_cache (
      cache_key TEXT PRIMARY KEY,
      service TEXT NOT NULL,
      info_hash TEXT NOT NULL,
      info_hash_norm TEXT NOT NULL,
      file_index INTEGER,
      file_index_norm INTEGER DEFAULT -1,
      media_id TEXT,
      imdb_id TEXT,
      imdb_season INTEGER,
      imdb_episode INTEGER,
      proof_level TEXT,
      payload_json JSONB NOT NULL,
      state TEXT,
      cached BOOLEAN,
      expires_at TIMESTAMPTZ NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )`,
    `CREATE TABLE IF NOT EXISTS debrid_cache_check_markers (
      marker_key TEXT PRIMARY KEY,
      service TEXT NOT NULL,
      user_hash TEXT,
      media_id TEXT NOT NULL,
      expires_at TIMESTAMPTZ NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )`,
    `ALTER TABLE torrents ADD COLUMN IF NOT EXISTS info_hash_norm TEXT`,
    `ALTER TABLE torrents ADD COLUMN IF NOT EXISTS file_index INTEGER`,
    `ALTER TABLE torrents ADD COLUMN IF NOT EXISTS file_index_norm INTEGER DEFAULT -1`,
    `ALTER TABLE torrents ADD COLUMN IF NOT EXISTS torrent_id TEXT`,
    `ALTER TABLE torrents ADD COLUMN IF NOT EXISTS type TEXT`,
    `ALTER TABLE torrents ADD COLUMN IF NOT EXISTS upload_date TIMESTAMPTZ`,
    `ALTER TABLE torrents ADD COLUMN IF NOT EXISTS trackers TEXT`,
    `ALTER TABLE torrents ADD COLUMN IF NOT EXISTS languages TEXT`,
    `ALTER TABLE torrents ADD COLUMN IF NOT EXISTS resolution TEXT`,
    `ALTER TABLE torrents ADD COLUMN IF NOT EXISTS quality_tag TEXT`,
    `ALTER TABLE torrents ADD COLUMN IF NOT EXISTS codec_tag TEXT`,
    `ALTER TABLE torrents ADD COLUMN IF NOT EXISTS hdr_tag TEXT`,
    `ALTER TABLE torrents ADD COLUMN IF NOT EXISTS audio_tag TEXT`,
    `ALTER TABLE torrents ADD COLUMN IF NOT EXISTS release_group TEXT`,
    `ALTER TABLE torrents ADD COLUMN IF NOT EXISTS smart_dedupe_key TEXT`,
    `ALTER TABLE torrents ADD COLUMN IF NOT EXISTS folder_size BIGINT DEFAULT 0`,
    `ALTER TABLE torrents ADD COLUMN IF NOT EXISTS first_seen_at TIMESTAMPTZ DEFAULT NOW()`,
    `ALTER TABLE torrents ADD COLUMN IF NOT EXISTS last_seen_at TIMESTAMPTZ DEFAULT NOW()`,
    `ALTER TABLE torrents ADD COLUMN IF NOT EXISTS seen_count INTEGER DEFAULT 1`,
    `ALTER TABLE torrents ADD COLUMN IF NOT EXISTS max_seeders INTEGER DEFAULT 0`,
    `ALTER TABLE torrents ADD COLUMN IF NOT EXISTS cached_rd BOOLEAN`,
    `ALTER TABLE torrents ADD COLUMN IF NOT EXISTS rd_cache_state TEXT`,
    `ALTER TABLE torrents ADD COLUMN IF NOT EXISTS rd_file_index INTEGER`,
    `ALTER TABLE torrents ADD COLUMN IF NOT EXISTS rd_file_size BIGINT`,
    `ALTER TABLE torrents ADD COLUMN IF NOT EXISTS last_cached_check TIMESTAMPTZ`,
    `ALTER TABLE torrents ADD COLUMN IF NOT EXISTS next_cached_check TIMESTAMPTZ`,
    `ALTER TABLE torrents ADD COLUMN IF NOT EXISTS cache_check_failures INTEGER DEFAULT 0`,
    `ALTER TABLE torrents ADD COLUMN IF NOT EXISTS tb_cached BOOLEAN`,
    `ALTER TABLE torrents ADD COLUMN IF NOT EXISTS tb_cache_state TEXT`,
    `ALTER TABLE torrents ADD COLUMN IF NOT EXISTS tb_cache_confidence NUMERIC(5,2) DEFAULT 0`,
    `ALTER TABLE torrents ADD COLUMN IF NOT EXISTS tb_cache_match_reason TEXT`,
    `ALTER TABLE torrents ADD COLUMN IF NOT EXISTS tb_next_cached_check TIMESTAMPTZ`,
    `ALTER TABLE torrents ADD COLUMN IF NOT EXISTS tb_cache_check_failures INTEGER DEFAULT 0`,
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

    `ALTER TABLE debrid_availability_cache ADD COLUMN IF NOT EXISTS service TEXT`,
    `ALTER TABLE debrid_availability_cache ADD COLUMN IF NOT EXISTS info_hash TEXT`,
    `ALTER TABLE debrid_availability_cache ADD COLUMN IF NOT EXISTS info_hash_norm TEXT`,
    `ALTER TABLE debrid_availability_cache ADD COLUMN IF NOT EXISTS file_index INTEGER`,
    `ALTER TABLE debrid_availability_cache ADD COLUMN IF NOT EXISTS file_index_norm INTEGER DEFAULT -1`,

    `ALTER TABLE external_stream_snapshots ADD COLUMN IF NOT EXISTS imdb_id TEXT`,
    `ALTER TABLE external_stream_snapshots ADD COLUMN IF NOT EXISTS imdb_season INTEGER`,
    `ALTER TABLE external_stream_snapshots ADD COLUMN IF NOT EXISTS imdb_episode INTEGER`,
    `ALTER TABLE external_stream_snapshots ADD COLUMN IF NOT EXISTS type TEXT`,
    `ALTER TABLE external_stream_snapshots ADD COLUMN IF NOT EXISTS info_hash TEXT`,
    `ALTER TABLE external_stream_snapshots ADD COLUMN IF NOT EXISTS info_hash_norm TEXT`,
    `ALTER TABLE external_stream_snapshots ADD COLUMN IF NOT EXISTS file_index INTEGER`,
    `ALTER TABLE external_stream_snapshots ADD COLUMN IF NOT EXISTS file_index_norm INTEGER DEFAULT -1`,
    `ALTER TABLE external_stream_snapshots ADD COLUMN IF NOT EXISTS addon TEXT`,
    `ALTER TABLE external_stream_snapshots ADD COLUMN IF NOT EXISTS addon_group TEXT`,
    `ALTER TABLE external_stream_snapshots ADD COLUMN IF NOT EXISTS provider TEXT`,
    `ALTER TABLE external_stream_snapshots ADD COLUMN IF NOT EXISTS title TEXT`,
    `ALTER TABLE external_stream_snapshots ADD COLUMN IF NOT EXISTS quality TEXT`,
    `ALTER TABLE external_stream_snapshots ADD COLUMN IF NOT EXISTS languages TEXT`,
    `ALTER TABLE external_stream_snapshots ADD COLUMN IF NOT EXISTS seeders INTEGER DEFAULT 0`,
    `ALTER TABLE external_stream_snapshots ADD COLUMN IF NOT EXISTS size BIGINT DEFAULT 0`,
    `ALTER TABLE external_stream_snapshots ADD COLUMN IF NOT EXISTS rd_state TEXT`,
    `ALTER TABLE external_stream_snapshots ADD COLUMN IF NOT EXISTS cached BOOLEAN`,
    `ALTER TABLE external_stream_snapshots ADD COLUMN IF NOT EXISTS payload_json JSONB`,
    `ALTER TABLE external_stream_snapshots ADD COLUMN IF NOT EXISTS first_seen_at TIMESTAMPTZ DEFAULT NOW()`,
    `ALTER TABLE external_stream_snapshots ADD COLUMN IF NOT EXISTS last_seen_at TIMESTAMPTZ DEFAULT NOW()`,
    `ALTER TABLE external_stream_snapshots ADD COLUMN IF NOT EXISTS seen_count INTEGER DEFAULT 1`,
    `ALTER TABLE external_stream_snapshots ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ`,
    `ALTER TABLE external_stream_snapshots ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT NOW()`,
    `ALTER TABLE external_stream_snapshots ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW()`,
    `ALTER TABLE debrid_availability_cache ADD COLUMN IF NOT EXISTS media_id TEXT`,
    `ALTER TABLE debrid_availability_cache ADD COLUMN IF NOT EXISTS imdb_id TEXT`,
    `ALTER TABLE debrid_availability_cache ADD COLUMN IF NOT EXISTS imdb_season INTEGER`,
    `ALTER TABLE debrid_availability_cache ADD COLUMN IF NOT EXISTS imdb_episode INTEGER`,
    `ALTER TABLE debrid_availability_cache ADD COLUMN IF NOT EXISTS proof_level TEXT`,
    `ALTER TABLE debrid_availability_cache ADD COLUMN IF NOT EXISTS payload_json JSONB`,
    `ALTER TABLE debrid_availability_cache ADD COLUMN IF NOT EXISTS state TEXT`,
    `ALTER TABLE debrid_availability_cache ADD COLUMN IF NOT EXISTS cached BOOLEAN`,
    `ALTER TABLE debrid_availability_cache ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ`,
    `ALTER TABLE debrid_availability_cache ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT NOW()`,
    `ALTER TABLE debrid_availability_cache ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW()`,

    `ALTER TABLE debrid_cache_check_markers ADD COLUMN IF NOT EXISTS service TEXT`,
    `ALTER TABLE debrid_cache_check_markers ADD COLUMN IF NOT EXISTS user_hash TEXT`,
    `ALTER TABLE debrid_cache_check_markers ADD COLUMN IF NOT EXISTS media_id TEXT`,
    `ALTER TABLE debrid_cache_check_markers ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ`,
    `ALTER TABLE debrid_cache_check_markers ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT NOW()`,
    `ALTER TABLE debrid_cache_check_markers ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW()`,

    `UPDATE torrents SET info_hash_norm = LOWER(TRIM(info_hash)) WHERE info_hash IS NOT NULL AND (info_hash_norm IS NULL OR info_hash_norm <> LOWER(TRIM(info_hash)))`,
    `UPDATE torrents SET file_index_norm = COALESCE(file_index, -1) WHERE file_index_norm IS DISTINCT FROM COALESCE(file_index, -1)`,
    `UPDATE torrents SET tb_cache_state = CASE
      WHEN tb_cache_state IN ('cached_verified','likely_cached','uncertain','queued','uncached','error') THEN tb_cache_state
      WHEN tb_cached IS TRUE THEN 'cached_verified'
      WHEN tb_cached IS FALSE THEN 'uncached'
      ELSE tb_cache_state
    END WHERE tb_cache_state IS NULL OR tb_cache_state NOT IN ('cached_verified','likely_cached','uncertain','queued','uncached','error')`,
    `UPDATE torrents SET tb_next_cached_check = COALESCE(tb_next_cached_check, tb_last_cached_check + make_interval(hours => CASE WHEN tb_cached IS TRUE THEN 24 ELSE 6 END)) WHERE tb_last_cached_check IS NOT NULL AND tb_next_cached_check IS NULL`,
    `UPDATE torrents SET first_seen_at = COALESCE(first_seen_at, created_at, updated_at, NOW()), last_seen_at = COALESCE(last_seen_at, updated_at, created_at, NOW()), seen_count = GREATEST(COALESCE(seen_count, 1), 1), max_seeders = GREATEST(COALESCE(max_seeders, 0), COALESCE(seeders, 0))`,
    `UPDATE files SET info_hash_norm = LOWER(TRIM(info_hash)) WHERE info_hash IS NOT NULL AND (info_hash_norm IS NULL OR info_hash_norm <> LOWER(TRIM(info_hash)))`,
    `UPDATE files SET file_index_norm = COALESCE(file_index, -1) WHERE file_index_norm IS DISTINCT FROM COALESCE(file_index, -1)`,
    `UPDATE pack_files SET pack_hash_norm = LOWER(TRIM(pack_hash)) WHERE pack_hash IS NOT NULL AND (pack_hash_norm IS NULL OR pack_hash_norm <> LOWER(TRIM(pack_hash)))`,
    `UPDATE pack_files SET file_index_norm = COALESCE(file_index, -1) WHERE file_index_norm IS DISTINCT FROM COALESCE(file_index, -1)`,
    `UPDATE episode_file_overrides SET info_hash_norm = LOWER(TRIM(info_hash)) WHERE info_hash IS NOT NULL AND (info_hash_norm IS NULL OR info_hash_norm <> LOWER(TRIM(info_hash)))`,
    `UPDATE external_stream_snapshots SET info_hash_norm = LOWER(TRIM(info_hash)) WHERE info_hash IS NOT NULL AND (info_hash_norm IS NULL OR info_hash_norm <> LOWER(TRIM(info_hash)))`,
    `UPDATE external_stream_snapshots SET file_index_norm = COALESCE(file_index, -1) WHERE file_index_norm IS DISTINCT FROM COALESCE(file_index, -1)`,
    `UPDATE debrid_availability_cache SET info_hash_norm = LOWER(TRIM(info_hash)) WHERE info_hash IS NOT NULL AND (info_hash_norm IS NULL OR info_hash_norm <> LOWER(TRIM(info_hash)))`,
    `UPDATE debrid_availability_cache SET file_index_norm = COALESCE(file_index, -1) WHERE file_index_norm IS DISTINCT FROM COALESCE(file_index, -1)`,

    `CREATE INDEX IF NOT EXISTS idx_torrents_info_hash_norm ON torrents (info_hash_norm)`,
    `CREATE INDEX IF NOT EXISTS idx_torrents_lookup_hash_file ON torrents (info_hash_norm, file_index_norm)`,
    `CREATE INDEX IF NOT EXISTS idx_torrents_rd_scan_queue ON torrents (next_cached_check NULLS FIRST, last_cached_check NULLS FIRST)`,
    `CREATE INDEX IF NOT EXISTS idx_torrents_rd_cache_state ON torrents (rd_cache_state, next_cached_check NULLS FIRST)`,
    `CREATE INDEX IF NOT EXISTS idx_torrents_tb_cache_state ON torrents (tb_cache_state, tb_next_cached_check NULLS FIRST)`,
    `CREATE INDEX IF NOT EXISTS idx_torrents_tb_cached_legacy ON torrents (tb_cached, tb_last_cached_check NULLS FIRST)`,
    `CREATE INDEX IF NOT EXISTS idx_torrents_tb_recheck ON torrents (tb_next_cached_check NULLS FIRST, tb_last_cached_check NULLS FIRST)`,
    `CREATE INDEX IF NOT EXISTS idx_torrents_seeders_upload ON torrents (seeders DESC, upload_date DESC NULLS LAST)`,
    `CREATE INDEX IF NOT EXISTS idx_torrents_smart_dedupe ON torrents (smart_dedupe_key) WHERE smart_dedupe_key IS NOT NULL`,
    `CREATE INDEX IF NOT EXISTS idx_torrents_seen_health ON torrents (last_seen_at DESC NULLS LAST, max_seeders DESC, seen_count DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_torrents_release_group ON torrents (release_group) WHERE release_group IS NOT NULL`,
    `CREATE INDEX IF NOT EXISTS idx_torrents_resolution_seeders ON torrents (resolution, seeders DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_torrents_type_provider ON torrents (type, provider)`,

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
    `CREATE INDEX IF NOT EXISTS idx_shared_stream_cache_hashes ON shared_stream_cache USING GIN (hashes)`,
    `CREATE INDEX IF NOT EXISTS idx_external_snapshots_media ON external_stream_snapshots (imdb_id, imdb_season, imdb_episode, expires_at DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_external_snapshots_hash ON external_stream_snapshots (info_hash_norm, file_index_norm)`,
    `CREATE INDEX IF NOT EXISTS idx_external_snapshots_source ON external_stream_snapshots (addon_group, addon, provider, last_seen_at DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_external_snapshots_expires ON external_stream_snapshots (expires_at)`,
    `CREATE INDEX IF NOT EXISTS idx_debrid_availability_expires ON debrid_availability_cache (expires_at)`,
    `CREATE INDEX IF NOT EXISTS idx_debrid_availability_hash_file ON debrid_availability_cache (service, info_hash_norm, file_index_norm)`,
    `CREATE INDEX IF NOT EXISTS idx_debrid_availability_media_file ON debrid_availability_cache (service, media_id, info_hash_norm, file_index_norm, expires_at)`,
    `CREATE INDEX IF NOT EXISTS idx_debrid_availability_episode ON debrid_availability_cache (service, imdb_id, imdb_season, imdb_episode, info_hash_norm, file_index_norm, expires_at)`,
    `CREATE INDEX IF NOT EXISTS idx_debrid_availability_state ON debrid_availability_cache (service, state, expires_at)`,
    `CREATE INDEX IF NOT EXISTS idx_debrid_check_markers_lookup ON debrid_cache_check_markers (service, user_hash, media_id, expires_at)`,
    `CREATE INDEX IF NOT EXISTS idx_debrid_check_markers_expires ON debrid_cache_check_markers (expires_at)`
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
    await pool.query(`DELETE FROM external_stream_snapshots WHERE expires_at IS NOT NULL AND expires_at < NOW()`);
    await pool.query(`DELETE FROM debrid_availability_cache WHERE expires_at IS NOT NULL AND expires_at < NOW()`);
    await pool.query(`DELETE FROM debrid_cache_check_markers WHERE expires_at IS NOT NULL AND expires_at < NOW()`);
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
      : 'COALESCE(size, 0) + (GREATEST(COALESCE(seeders, 0), COALESCE(max_seeders, 0)) * 1024) + (COALESCE(seen_count, 0) * 256)';

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
