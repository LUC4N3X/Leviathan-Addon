function clampIntLocal(value, fallback, min, max) {
  const parsed = Number.parseInt(value, 10);
  const normalized = Number.isFinite(parsed) ? parsed : fallback;
  return Math.max(min, Math.min(max, normalized));
}

const DB_AUTHORITY_BACKFILL_LIMIT = clampIntLocal(process.env.DB_AUTHORITY_BACKFILL_LIMIT, 50000, 0, 1000000);

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
    `CREATE TABLE IF NOT EXISTS torrentio_tmdb_scan_queue (
      job_key TEXT PRIMARY KEY,
      media_type TEXT NOT NULL,
      media_id TEXT NOT NULL,
      imdb_id TEXT NOT NULL,
      imdb_season INTEGER,
      imdb_episode INTEGER,
      tmdb_id INTEGER,
      tmdb_endpoint TEXT,
      options TEXT DEFAULT '',
      priority INTEGER DEFAULT 50,
      state TEXT NOT NULL DEFAULT 'queued',
      not_before TIMESTAMPTZ DEFAULT NOW(),
      attempts INTEGER DEFAULT 0,
      last_error TEXT DEFAULT '',
      last_result_count INTEGER DEFAULT 0,
      last_saved_count INTEGER DEFAULT 0,
      first_seen_at TIMESTAMPTZ DEFAULT NOW(),
      last_seen_at TIMESTAMPTZ DEFAULT NOW(),
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
    `CREATE TABLE IF NOT EXISTS debrid_resolved_link_cache (
      cache_key TEXT PRIMARY KEY,
      service TEXT NOT NULL,
      token_fp TEXT,
      torrent_id TEXT,
      file_id INTEGER,
      info_hash_norm TEXT,
      media_id TEXT,
      url TEXT NOT NULL,
      filename TEXT,
      file_size BIGINT,
      payload_json JSONB,
      expires_at TIMESTAMPTZ NOT NULL,
      hit_count BIGINT DEFAULT 0,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )`,
    `CREATE TABLE IF NOT EXISTS torrent_items (
      info_hash TEXT NOT NULL,
      info_hash_norm TEXT PRIMARY KEY,
      title_best TEXT,
      title_original TEXT,
      type TEXT,
      size BIGINT DEFAULT 0,
      folder_size BIGINT DEFAULT 0,
      seeders INTEGER DEFAULT 0,
      max_seeders INTEGER DEFAULT 0,
      resolution TEXT,
      quality_tag TEXT,
      codec_tag TEXT,
      hdr_tag TEXT,
      audio_tag TEXT,
      release_group TEXT,
      languages TEXT,
      trackers TEXT,
      smart_dedupe_key TEXT,
      first_seen_at TIMESTAMPTZ DEFAULT NOW(),
      last_seen_at TIMESTAMPTZ DEFAULT NOW(),
      seen_count INTEGER DEFAULT 1,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )`,
    `CREATE TABLE IF NOT EXISTS torrent_files (
      file_key TEXT PRIMARY KEY,
      info_hash TEXT NOT NULL,
      info_hash_norm TEXT NOT NULL,
      file_index INTEGER,
      file_index_norm INTEGER DEFAULT -1,
      rd_file_id INTEGER,
      tb_file_id INTEGER,
      path TEXT,
      leaf_name TEXT,
      size BIGINT DEFAULT 0,
      extension TEXT,
      is_video BOOLEAN,
      video_rank INTEGER DEFAULT 0,
      parsed_season INTEGER,
      parsed_episode INTEGER,
      parsed_absolute_episode INTEGER,
      parsed_year INTEGER,
      path_hash TEXT,
      source TEXT,
      confidence NUMERIC(5,2) DEFAULT 0,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )`,
    `CREATE TABLE IF NOT EXISTS media_file_map (
      map_key TEXT PRIMARY KEY,
      info_hash TEXT NOT NULL,
      info_hash_norm TEXT NOT NULL,
      file_index INTEGER,
      file_index_norm INTEGER DEFAULT -1,
      imdb_id TEXT,
      tmdb_id TEXT,
      kitsu_id TEXT,
      season INTEGER,
      episode INTEGER,
      absolute_episode INTEGER,
      media_type TEXT,
      match_source TEXT,
      match_confidence NUMERIC(5,2) DEFAULT 0,
      match_reason TEXT,
      is_exact BOOLEAN DEFAULT FALSE,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )`,
    `CREATE TABLE IF NOT EXISTS provider_observations (
      observation_key TEXT PRIMARY KEY,
      info_hash TEXT NOT NULL,
      info_hash_norm TEXT NOT NULL,
      file_index INTEGER,
      file_index_norm INTEGER DEFAULT -1,
      provider_group TEXT DEFAULT 'local',
      provider_name TEXT DEFAULT 'unknown',
      addon_name TEXT DEFAULT 'local',
      raw_title TEXT,
      raw_quality TEXT,
      raw_languages TEXT,
      seeders INTEGER DEFAULT 0,
      size BIGINT DEFAULT 0,
      magnet TEXT,
      stream_url TEXT,
      source_priority INTEGER DEFAULT 50,
      first_seen_at TIMESTAMPTZ DEFAULT NOW(),
      last_seen_at TIMESTAMPTZ DEFAULT NOW(),
      seen_count INTEGER DEFAULT 1,
      payload_json JSONB,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )`,
    `CREATE TABLE IF NOT EXISTS debrid_authority (
      authority_key TEXT PRIMARY KEY,
      service TEXT NOT NULL,
      info_hash TEXT NOT NULL,
      info_hash_norm TEXT NOT NULL,
      file_index INTEGER,
      file_index_norm INTEGER DEFAULT -1,
      media_id TEXT,
      imdb_id TEXT,
      season INTEGER,
      episode INTEGER,
      state TEXT NOT NULL,
      cached BOOLEAN,
      proof_level TEXT,
      confidence NUMERIC(5,2) DEFAULT 0,
      service_file_id INTEGER,
      service_file_size BIGINT,
      service_torrent_id TEXT,
      checked_at TIMESTAMPTZ,
      expires_at TIMESTAMPTZ,
      next_check_at TIMESTAMPTZ,
      failure_count INTEGER DEFAULT 0,
      last_error TEXT,
      match_reason TEXT,
      payload_json JSONB,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )`,
    `CREATE TABLE IF NOT EXISTS debrid_check_jobs (
      job_key TEXT PRIMARY KEY,
      service TEXT NOT NULL,
      info_hash TEXT NOT NULL,
      info_hash_norm TEXT NOT NULL,
      file_index INTEGER,
      file_index_norm INTEGER DEFAULT -1,
      media_id TEXT,
      priority INTEGER DEFAULT 50,
      status TEXT DEFAULT 'pending',
      attempts INTEGER DEFAULT 0,
      locked_at TIMESTAMPTZ,
      locked_by TEXT,
      run_after TIMESTAMPTZ DEFAULT NOW(),
      last_error TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )`,
    `CREATE TABLE IF NOT EXISTS legacy_backfill_progress (
      progress_key TEXT PRIMARY KEY,
      processed BIGINT DEFAULT 0,
      done BOOLEAN DEFAULT FALSE,
      last_error TEXT,
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

    `ALTER TABLE torrentio_tmdb_scan_queue ADD COLUMN IF NOT EXISTS job_key TEXT`,
    `ALTER TABLE torrentio_tmdb_scan_queue ADD COLUMN IF NOT EXISTS media_type TEXT`,
    `ALTER TABLE torrentio_tmdb_scan_queue ADD COLUMN IF NOT EXISTS media_id TEXT`,
    `ALTER TABLE torrentio_tmdb_scan_queue ADD COLUMN IF NOT EXISTS imdb_id TEXT`,
    `ALTER TABLE torrentio_tmdb_scan_queue ADD COLUMN IF NOT EXISTS imdb_season INTEGER`,
    `ALTER TABLE torrentio_tmdb_scan_queue ADD COLUMN IF NOT EXISTS imdb_episode INTEGER`,
    `ALTER TABLE torrentio_tmdb_scan_queue ADD COLUMN IF NOT EXISTS tmdb_id INTEGER`,
    `ALTER TABLE torrentio_tmdb_scan_queue ADD COLUMN IF NOT EXISTS tmdb_endpoint TEXT`,
    `ALTER TABLE torrentio_tmdb_scan_queue ADD COLUMN IF NOT EXISTS options TEXT DEFAULT ''`,
    `ALTER TABLE torrentio_tmdb_scan_queue ADD COLUMN IF NOT EXISTS priority INTEGER DEFAULT 50`,
    `ALTER TABLE torrentio_tmdb_scan_queue ADD COLUMN IF NOT EXISTS state TEXT DEFAULT 'queued'`,
    `ALTER TABLE torrentio_tmdb_scan_queue ADD COLUMN IF NOT EXISTS not_before TIMESTAMPTZ DEFAULT NOW()`,
    `ALTER TABLE torrentio_tmdb_scan_queue ADD COLUMN IF NOT EXISTS attempts INTEGER DEFAULT 0`,
    `ALTER TABLE torrentio_tmdb_scan_queue ADD COLUMN IF NOT EXISTS last_error TEXT DEFAULT ''`,
    `ALTER TABLE torrentio_tmdb_scan_queue ADD COLUMN IF NOT EXISTS last_result_count INTEGER DEFAULT 0`,
    `ALTER TABLE torrentio_tmdb_scan_queue ADD COLUMN IF NOT EXISTS last_saved_count INTEGER DEFAULT 0`,
    `ALTER TABLE torrentio_tmdb_scan_queue ADD COLUMN IF NOT EXISTS first_seen_at TIMESTAMPTZ DEFAULT NOW()`,
    `ALTER TABLE torrentio_tmdb_scan_queue ADD COLUMN IF NOT EXISTS last_seen_at TIMESTAMPTZ DEFAULT NOW()`,
    `ALTER TABLE torrentio_tmdb_scan_queue ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT NOW()`,
    `ALTER TABLE torrentio_tmdb_scan_queue ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW()`,
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


    `ALTER TABLE torrent_items ADD COLUMN IF NOT EXISTS title_original TEXT`,
    `ALTER TABLE torrent_items ADD COLUMN IF NOT EXISTS smart_dedupe_key TEXT`,
    `ALTER TABLE torrent_files ADD COLUMN IF NOT EXISTS rd_file_id INTEGER`,
    `ALTER TABLE torrent_files ADD COLUMN IF NOT EXISTS tb_file_id INTEGER`,
    `ALTER TABLE torrent_files ADD COLUMN IF NOT EXISTS parsed_absolute_episode INTEGER`,
    `ALTER TABLE torrent_files ADD COLUMN IF NOT EXISTS parsed_year INTEGER`,
    `ALTER TABLE torrent_files ADD COLUMN IF NOT EXISTS path_hash TEXT`,
    `ALTER TABLE media_file_map ADD COLUMN IF NOT EXISTS tmdb_id TEXT`,
    `ALTER TABLE media_file_map ADD COLUMN IF NOT EXISTS kitsu_id TEXT`,
    `ALTER TABLE media_file_map ADD COLUMN IF NOT EXISTS absolute_episode INTEGER`,
    `ALTER TABLE debrid_authority ADD COLUMN IF NOT EXISTS service_torrent_id TEXT`,
    `ALTER TABLE debrid_authority ADD COLUMN IF NOT EXISTS payload_json JSONB`,
    `ALTER TABLE debrid_check_jobs ADD COLUMN IF NOT EXISTS locked_by TEXT`,
    `ALTER TABLE debrid_resolved_link_cache ADD COLUMN IF NOT EXISTS service TEXT`,
    `ALTER TABLE debrid_resolved_link_cache ADD COLUMN IF NOT EXISTS token_fp TEXT`,
    `ALTER TABLE debrid_resolved_link_cache ADD COLUMN IF NOT EXISTS torrent_id TEXT`,
    `ALTER TABLE debrid_resolved_link_cache ADD COLUMN IF NOT EXISTS file_id INTEGER`,
    `ALTER TABLE debrid_resolved_link_cache ADD COLUMN IF NOT EXISTS info_hash_norm TEXT`,
    `ALTER TABLE debrid_resolved_link_cache ADD COLUMN IF NOT EXISTS media_id TEXT`,
    `ALTER TABLE debrid_resolved_link_cache ADD COLUMN IF NOT EXISTS url TEXT`,
    `ALTER TABLE debrid_resolved_link_cache ADD COLUMN IF NOT EXISTS filename TEXT`,
    `ALTER TABLE debrid_resolved_link_cache ADD COLUMN IF NOT EXISTS file_size BIGINT`,
    `ALTER TABLE debrid_resolved_link_cache ADD COLUMN IF NOT EXISTS payload_json JSONB`,
    `ALTER TABLE debrid_resolved_link_cache ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ`,
    `ALTER TABLE debrid_resolved_link_cache ADD COLUMN IF NOT EXISTS hit_count BIGINT DEFAULT 0`,
    `ALTER TABLE debrid_resolved_link_cache ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT NOW()`,
    `ALTER TABLE debrid_resolved_link_cache ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW()`,

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


    `INSERT INTO torrent_items (
      info_hash,
      info_hash_norm,
      title_best,
      title_original,
      type,
      size,
      folder_size,
      seeders,
      max_seeders,
      resolution,
      quality_tag,
      codec_tag,
      hdr_tag,
      audio_tag,
      release_group,
      languages,
      trackers,
      smart_dedupe_key,
      first_seen_at,
      last_seen_at,
      seen_count,
      created_at,
      updated_at
    )
    SELECT
      s.info_hash_norm,
      s.info_hash_norm,
      s.title,
      s.title,
      s.type,
      COALESCE(s.size, 0),
      COALESCE(s.folder_size, 0),
      COALESCE(s.seeders, 0),
      GREATEST(COALESCE(s.max_seeders, 0), COALESCE(s.seeders, 0)),
      s.resolution,
      s.quality_tag,
      s.codec_tag,
      s.hdr_tag,
      s.audio_tag,
      s.release_group,
      s.languages,
      s.trackers,
      s.smart_dedupe_key,
      COALESCE(s.first_seen_at, s.created_at, NOW()),
      COALESCE(s.last_seen_at, s.updated_at, NOW()),
      GREATEST(COALESCE(s.seen_count, 1), 1),
      COALESCE(s.created_at, NOW()),
      NOW()
    FROM (
      SELECT DISTINCT ON (info_hash_norm) *
      FROM torrents
      WHERE info_hash_norm IS NOT NULL
      ORDER BY info_hash_norm,
        GREATEST(COALESCE(max_seeders, 0), COALESCE(seeders, 0)) DESC,
        COALESCE(folder_size, size, 0) DESC,
        COALESCE(updated_at, created_at, NOW()) DESC
      LIMIT ${DB_AUTHORITY_BACKFILL_LIMIT}
    ) s
    ON CONFLICT (info_hash_norm)
    DO UPDATE SET
      title_best = CASE
        WHEN COALESCE(torrent_items.title_best, '') = '' THEN EXCLUDED.title_best
        WHEN LENGTH(COALESCE(EXCLUDED.title_best, '')) > LENGTH(COALESCE(torrent_items.title_best, '')) THEN EXCLUDED.title_best
        ELSE torrent_items.title_best
      END,
      size = GREATEST(COALESCE(torrent_items.size, 0), COALESCE(EXCLUDED.size, 0)),
      folder_size = GREATEST(COALESCE(torrent_items.folder_size, 0), COALESCE(EXCLUDED.folder_size, 0)),
      seeders = GREATEST(COALESCE(torrent_items.seeders, 0), COALESCE(EXCLUDED.seeders, 0)),
      max_seeders = GREATEST(COALESCE(torrent_items.max_seeders, 0), COALESCE(EXCLUDED.max_seeders, 0)),
      last_seen_at = GREATEST(COALESCE(torrent_items.last_seen_at, EXCLUDED.last_seen_at), COALESCE(EXCLUDED.last_seen_at, torrent_items.last_seen_at)),
      seen_count = GREATEST(COALESCE(torrent_items.seen_count, 1), COALESCE(EXCLUDED.seen_count, 1)),
      updated_at = NOW()`,
    `UPDATE torrent_files
     SET info_hash_norm = LOWER(TRIM(info_hash_norm))
     WHERE info_hash_norm IS NOT NULL
       AND info_hash_norm <> LOWER(TRIM(info_hash_norm))`,
    `UPDATE torrent_files
     SET file_index_norm = COALESCE(file_index_norm, -1)
     WHERE file_index_norm IS NULL`,
    `DELETE FROM torrent_files t
     USING (
       SELECT ctid,
              ROW_NUMBER() OVER (
                PARTITION BY info_hash_norm, file_index_norm
                ORDER BY confidence DESC NULLS LAST,
                         video_rank DESC NULLS LAST,
                         size DESC NULLS LAST,
                         updated_at DESC NULLS LAST,
                         file_key DESC
              ) AS rn
       FROM torrent_files
       WHERE info_hash_norm IS NOT NULL
     ) d
     WHERE t.ctid = d.ctid
       AND d.rn > 1`,
    `CREATE UNIQUE INDEX IF NOT EXISTS uq_torrent_files_hash_file ON torrent_files (info_hash_norm, file_index_norm)`,
    `INSERT INTO torrent_files (
      file_key,
      info_hash,
      info_hash_norm,
      file_index,
      file_index_norm,
      path,
      leaf_name,
      size,
      extension,
      is_video,
      video_rank,
      parsed_season,
      parsed_episode,
      source,
      confidence,
      created_at,
      updated_at
    )
    WITH torrent_file_source AS (
      SELECT pack_hash_norm AS info_hash_norm,
             COALESCE(file_index_norm, -1) AS file_index_norm,
             file_path AS path,
             COALESCE(NULLIF(file_title, ''), NULLIF(regexp_replace(COALESCE(file_path, ''), '^.*/', ''), ''), pack_hash_norm) AS leaf_name,
             file_size AS size,
             LOWER(NULLIF(regexp_replace(COALESCE(file_path, file_title, ''), '^.*\\.', ''), COALESCE(file_path, file_title, ''))) AS extension,
             CASE WHEN COALESCE(file_path, file_title, '') ~* '\\.(mkv|mp4|avi|mov|wmv|flv|webm|m4v|ts|m2ts|mpg|mpeg)$' THEN TRUE ELSE NULL END AS is_video,
             CASE WHEN file_size >= 52428800 THEN 100 WHEN file_size >= 26214400 THEN 75 ELSE 0 END AS video_rank,
             imdb_season AS season,
             imdb_episode AS episode,
             'legacy_pack_files' AS source,
             CASE WHEN imdb_season IS NOT NULL AND imdb_episode IS NOT NULL THEN 0.95 ELSE 0.70 END AS confidence
      FROM pack_files
      WHERE pack_hash_norm IS NOT NULL

      UNION ALL

      SELECT info_hash_norm,
             COALESCE(file_index_norm, -1) AS file_index_norm,
             NULL::text AS path,
             NULLIF(title, '') AS leaf_name,
             size,
             NULL::text AS extension,
             NULL::boolean AS is_video,
             CASE WHEN size >= 52428800 THEN 70 ELSE 0 END AS video_rank,
             imdb_season,
             imdb_episode,
             'legacy_files' AS source,
             CASE WHEN imdb_id IS NOT NULL THEN 0.85 ELSE 0.50 END AS confidence
      FROM files
      WHERE info_hash_norm IS NOT NULL
    ), torrent_file_ranked AS (
      SELECT *,
             ROW_NUMBER() OVER (
               PARTITION BY info_hash_norm, file_index_norm
               ORDER BY confidence DESC NULLS LAST,
                        video_rank DESC NULLS LAST,
                        size DESC NULLS LAST,
                        CASE source WHEN 'legacy_pack_files' THEN 0 ELSE 1 END ASC,
                        leaf_name DESC NULLS LAST
             ) AS rn
      FROM torrent_file_source
      WHERE info_hash_norm IS NOT NULL
    )
    SELECT
      md5(x.info_hash_norm || ':' || x.file_index_norm::text),
      x.info_hash_norm,
      x.info_hash_norm,
      NULLIF(x.file_index_norm, -1),
      x.file_index_norm,
      x.path,
      x.leaf_name,
      COALESCE(x.size, 0),
      x.extension,
      x.is_video,
      x.video_rank,
      x.season,
      x.episode,
      x.source,
      x.confidence,
      NOW(),
      NOW()
    FROM torrent_file_ranked x
    WHERE x.rn = 1
    LIMIT ${DB_AUTHORITY_BACKFILL_LIMIT}
    ON CONFLICT (info_hash_norm, file_index_norm)
    DO UPDATE SET
      path = COALESCE(NULLIF(EXCLUDED.path, ''), torrent_files.path),
      leaf_name = CASE
        WHEN COALESCE(torrent_files.leaf_name, '') = '' THEN EXCLUDED.leaf_name
        WHEN LENGTH(COALESCE(EXCLUDED.leaf_name, '')) > LENGTH(COALESCE(torrent_files.leaf_name, '')) THEN EXCLUDED.leaf_name
        ELSE torrent_files.leaf_name
      END,
      size = GREATEST(COALESCE(torrent_files.size, 0), COALESCE(EXCLUDED.size, 0)),
      extension = COALESCE(EXCLUDED.extension, torrent_files.extension),
      is_video = COALESCE(EXCLUDED.is_video, torrent_files.is_video),
      video_rank = GREATEST(COALESCE(torrent_files.video_rank, 0), COALESCE(EXCLUDED.video_rank, 0)),
      parsed_season = COALESCE(EXCLUDED.parsed_season, torrent_files.parsed_season),
      parsed_episode = COALESCE(EXCLUDED.parsed_episode, torrent_files.parsed_episode),
      confidence = GREATEST(COALESCE(torrent_files.confidence, 0), COALESCE(EXCLUDED.confidence, 0)),
      updated_at = NOW()`,
    `INSERT INTO media_file_map (
      map_key,
      info_hash,
      info_hash_norm,
      file_index,
      file_index_norm,
      imdb_id,
      season,
      episode,
      media_type,
      match_source,
      match_confidence,
      match_reason,
      is_exact,
      created_at,
      updated_at
    )
    SELECT
      md5(x.info_hash_norm || ':' || x.file_index_norm::text || ':' || COALESCE(x.imdb_id, '') || ':' || COALESCE(x.season::text, '-1') || ':' || COALESCE(x.episode::text, '-1') || ':' || x.source),
      x.info_hash_norm,
      x.info_hash_norm,
      NULLIF(x.file_index_norm, -1),
      x.file_index_norm,
      x.imdb_id,
      x.season,
      x.episode,
      CASE WHEN x.season IS NOT NULL AND x.episode IS NOT NULL THEN 'series' ELSE 'movie' END,
      x.source,
      x.confidence,
      x.reason,
      x.is_exact,
      NOW(),
      NOW()
    FROM (
      SELECT info_hash_norm, file_index_norm, imdb_id, imdb_season AS season, imdb_episode AS episode,
             'legacy_files' AS source, 0.90::numeric AS confidence, 'legacy files mapping' AS reason, TRUE AS is_exact
      FROM files
      WHERE info_hash_norm IS NOT NULL AND imdb_id IS NOT NULL
      UNION ALL
      SELECT pack_hash_norm, file_index_norm, imdb_id, imdb_season, imdb_episode,
             'legacy_pack_files', 0.95::numeric, 'legacy pack file mapping', TRUE
      FROM pack_files
      WHERE pack_hash_norm IS NOT NULL AND imdb_id IS NOT NULL
      UNION ALL
      SELECT info_hash_norm, -1, imdb_id, imdb_season, imdb_episode,
             'legacy_episode_overrides', 0.98::numeric, 'episode override service file proof', TRUE
      FROM episode_file_overrides
      WHERE info_hash_norm IS NOT NULL AND imdb_id IS NOT NULL
    ) x
    LIMIT ${DB_AUTHORITY_BACKFILL_LIMIT}
    ON CONFLICT (map_key)
    DO UPDATE SET
      match_confidence = GREATEST(COALESCE(media_file_map.match_confidence, 0), COALESCE(EXCLUDED.match_confidence, 0)),
      is_exact = media_file_map.is_exact OR EXCLUDED.is_exact,
      updated_at = NOW()`,
    `INSERT INTO provider_observations (
      observation_key,
      info_hash,
      info_hash_norm,
      file_index,
      file_index_norm,
      provider_group,
      provider_name,
      addon_name,
      raw_title,
      raw_quality,
      raw_languages,
      seeders,
      size,
      source_priority,
      first_seen_at,
      last_seen_at,
      seen_count,
      payload_json,
      created_at,
      updated_at
    )
    SELECT
      md5(x.info_hash_norm || ':' || x.file_index_norm::text || ':' || x.provider_group || ':' || x.provider_name || ':' || x.addon_name),
      x.info_hash_norm,
      x.info_hash_norm,
      NULLIF(x.file_index_norm, -1),
      x.file_index_norm,
      x.provider_group,
      x.provider_name,
      x.addon_name,
      x.raw_title,
      x.raw_quality,
      x.raw_languages,
      COALESCE(x.seeders, 0),
      COALESCE(x.size, 0),
      x.source_priority,
      COALESCE(x.first_seen_at, NOW()),
      COALESCE(x.last_seen_at, NOW()),
      GREATEST(COALESCE(x.seen_count, 1), 1),
      x.payload_json,
      NOW(),
      NOW()
    FROM (
      SELECT info_hash_norm,
             file_index_norm,
             'local_db' AS provider_group,
             COALESCE(NULLIF(provider, ''), 'unknown') AS provider_name,
             'leviathan' AS addon_name,
             title AS raw_title,
             quality_tag AS raw_quality,
             languages AS raw_languages,
             seeders,
             size,
             10 AS source_priority,
             first_seen_at,
             last_seen_at,
             seen_count,
             NULL::jsonb AS payload_json
      FROM torrents
      WHERE info_hash_norm IS NOT NULL
      UNION ALL
      SELECT info_hash_norm,
             file_index_norm,
             COALESCE(NULLIF(addon_group, ''), 'external') AS provider_group,
             COALESCE(NULLIF(provider, ''), 'external') AS provider_name,
             COALESCE(NULLIF(addon, ''), 'external') AS addon_name,
             title,
             quality,
             languages,
             seeders,
             size,
             30,
             first_seen_at,
             last_seen_at,
             seen_count,
             payload_json
      FROM external_stream_snapshots
      WHERE info_hash_norm IS NOT NULL
    ) x
    LIMIT ${DB_AUTHORITY_BACKFILL_LIMIT}
    ON CONFLICT (observation_key)
    DO UPDATE SET
      raw_title = CASE
        WHEN COALESCE(provider_observations.raw_title, '') = '' THEN EXCLUDED.raw_title
        WHEN LENGTH(COALESCE(EXCLUDED.raw_title, '')) > LENGTH(COALESCE(provider_observations.raw_title, '')) THEN EXCLUDED.raw_title
        ELSE provider_observations.raw_title
      END,
      seeders = GREATEST(COALESCE(provider_observations.seeders, 0), COALESCE(EXCLUDED.seeders, 0)),
      size = GREATEST(COALESCE(provider_observations.size, 0), COALESCE(EXCLUDED.size, 0)),
      last_seen_at = GREATEST(COALESCE(provider_observations.last_seen_at, EXCLUDED.last_seen_at), COALESCE(EXCLUDED.last_seen_at, provider_observations.last_seen_at)),
      seen_count = GREATEST(COALESCE(provider_observations.seen_count, 1), COALESCE(EXCLUDED.seen_count, 1)),
      payload_json = COALESCE(EXCLUDED.payload_json, provider_observations.payload_json),
      updated_at = NOW()`,
    `WITH authority_source AS (
      SELECT 'rd'::text AS service,
             info_hash_norm::text AS info_hash_norm,
             COALESCE(rd_file_index, file_index_norm, -1)::integer AS file_index_norm,
             NULL::text AS media_id,
             NULL::text AS imdb_id,
             NULL::integer AS season,
             NULL::integer AS episode,
             CASE
               WHEN cached_rd IS TRUE OR rd_cache_state = 'cached' THEN 'cached_verified'
               WHEN cached_rd IS FALSE OR rd_cache_state = 'uncached_terminal' THEN 'uncached_terminal'
               WHEN rd_cache_state IN ('likely_cached','probing','likely_uncached','unknown') THEN rd_cache_state
               ELSE 'uncertain'
             END::text AS state,
             CASE
               WHEN cached_rd IS TRUE OR rd_cache_state = 'cached' THEN TRUE
               WHEN cached_rd IS FALSE OR rd_cache_state = 'uncached_terminal' THEN FALSE
               ELSE NULL
             END::boolean AS cached,
             CASE
               WHEN rd_file_index IS NOT NULL AND rd_file_index >= 0 AND (cached_rd IS TRUE OR rd_cache_state = 'cached') THEN 'file_exact'
               WHEN cached_rd IS TRUE OR rd_cache_state = 'cached' THEN 'hash_only'
               WHEN cached_rd IS FALSE OR rd_cache_state = 'uncached_terminal' THEN 'negative_terminal'
               ELSE 'legacy_state'
             END::text AS proof_level,
             CASE WHEN cached_rd IS TRUE OR rd_cache_state = 'cached' THEN 0.80 ELSE 0.45 END::numeric AS confidence,
             rd_file_index::integer AS service_file_id,
             rd_file_size::bigint AS service_file_size,
             last_cached_check::timestamptz AS checked_at,
             COALESCE(next_cached_check, NOW() + INTERVAL '12 hours')::timestamptz AS expires_at,
             COALESCE(next_cached_check, NOW() + INTERVAL '12 hours')::timestamptz AS next_check_at,
             COALESCE(cache_check_failures, 0)::integer AS failure_count,
             'legacy_torrents_rd'::text AS match_reason,
             NULL::jsonb AS payload_json
      FROM torrents
      WHERE info_hash_norm IS NOT NULL AND (cached_rd IS NOT NULL OR rd_cache_state IS NOT NULL)

      UNION ALL

      SELECT 'tb'::text AS service,
             info_hash_norm::text AS info_hash_norm,
             COALESCE(tb_file_id, file_index_norm, -1)::integer AS file_index_norm,
             NULL::text AS media_id,
             NULL::text AS imdb_id,
             NULL::integer AS season,
             NULL::integer AS episode,
             CASE
               WHEN tb_cached IS TRUE OR tb_cache_state = 'cached_verified' THEN 'cached_verified'
               WHEN tb_cached IS FALSE OR tb_cache_state = 'uncached' THEN 'uncached'
               WHEN tb_cache_state IN ('likely_cached','uncertain','queued','error') THEN tb_cache_state
               ELSE 'uncertain'
             END::text AS state,
             CASE
               WHEN tb_cached IS TRUE OR tb_cache_state = 'cached_verified' THEN TRUE
               WHEN tb_cached IS FALSE OR tb_cache_state = 'uncached' THEN FALSE
               ELSE NULL
             END::boolean AS cached,
             CASE
               WHEN tb_file_id IS NOT NULL AND tb_file_id >= 0 AND (tb_cached IS TRUE OR tb_cache_state = 'cached_verified') THEN 'file_exact'
               WHEN tb_cached IS TRUE OR tb_cache_state = 'cached_verified' THEN 'hash_only'
               WHEN tb_cached IS FALSE OR tb_cache_state = 'uncached' THEN 'negative_terminal'
               ELSE 'legacy_state'
             END::text AS proof_level,
             GREATEST(COALESCE(tb_cache_confidence, 0), CASE WHEN tb_cached IS TRUE OR tb_cache_state = 'cached_verified' THEN 0.80 ELSE 0.40 END)::numeric AS confidence,
             tb_file_id::integer AS service_file_id,
             tb_file_size::bigint AS service_file_size,
             tb_last_cached_check::timestamptz AS checked_at,
             COALESCE(tb_next_cached_check, NOW() + INTERVAL '6 hours')::timestamptz AS expires_at,
             COALESCE(tb_next_cached_check, NOW() + INTERVAL '6 hours')::timestamptz AS next_check_at,
             COALESCE(tb_cache_check_failures, 0)::integer AS failure_count,
             COALESCE(NULLIF(tb_cache_match_reason, ''), 'legacy_torrents_tb')::text AS match_reason,
             NULL::jsonb AS payload_json
      FROM torrents
      WHERE info_hash_norm IS NOT NULL AND (tb_cached IS NOT NULL OR tb_cache_state IS NOT NULL)

      UNION ALL

      SELECT 'rd'::text AS service,
             info_hash_norm::text AS info_hash_norm,
             COALESCE(rd_file_index, -1)::integer AS file_index_norm,
             (imdb_id || ':' || imdb_season::text || ':' || imdb_episode::text)::text AS media_id,
             imdb_id::text AS imdb_id,
             imdb_season::integer AS season,
             imdb_episode::integer AS episode,
             'cached_verified'::text AS state,
             TRUE::boolean AS cached,
             'episode_exact'::text AS proof_level,
             0.99::numeric AS confidence,
             rd_file_index::integer AS service_file_id,
             rd_file_size::bigint AS service_file_size,
             updated_at::timestamptz AS checked_at,
             (NOW() + INTERVAL '14 days')::timestamptz AS expires_at,
             (NOW() + INTERVAL '14 days')::timestamptz AS next_check_at,
             0::integer AS failure_count,
             'legacy_episode_override_rd'::text AS match_reason,
             NULL::jsonb AS payload_json
      FROM episode_file_overrides
      WHERE info_hash_norm IS NOT NULL AND rd_file_index IS NOT NULL AND rd_file_index >= 0

      UNION ALL

      SELECT 'tb'::text AS service,
             info_hash_norm::text AS info_hash_norm,
             COALESCE(tb_file_id, -1)::integer AS file_index_norm,
             (imdb_id || ':' || imdb_season::text || ':' || imdb_episode::text)::text AS media_id,
             imdb_id::text AS imdb_id,
             imdb_season::integer AS season,
             imdb_episode::integer AS episode,
             'cached_verified'::text AS state,
             TRUE::boolean AS cached,
             'episode_exact'::text AS proof_level,
             0.99::numeric AS confidence,
             tb_file_id::integer AS service_file_id,
             tb_file_size::bigint AS service_file_size,
             updated_at::timestamptz AS checked_at,
             (NOW() + INTERVAL '3 days')::timestamptz AS expires_at,
             (NOW() + INTERVAL '3 days')::timestamptz AS next_check_at,
             0::integer AS failure_count,
             'legacy_episode_override_tb'::text AS match_reason,
             NULL::jsonb AS payload_json
      FROM episode_file_overrides
      WHERE info_hash_norm IS NOT NULL AND tb_file_id IS NOT NULL AND tb_file_id >= 0

      UNION ALL

      SELECT service::text AS service,
             info_hash_norm::text AS info_hash_norm,
             COALESCE(file_index_norm, -1)::integer AS file_index_norm,
             media_id::text AS media_id,
             imdb_id::text AS imdb_id,
             imdb_season::integer AS season,
             imdb_episode::integer AS episode,
             CASE
               WHEN service = 'rd' AND state = 'cached' THEN 'cached_verified'
               WHEN service = 'rd' AND state IS NULL AND cached IS TRUE THEN 'cached_verified'
               WHEN service = 'tb' AND state = 'cached_verified' THEN 'cached_verified'
               WHEN state IS NOT NULL THEN state
               WHEN cached IS TRUE THEN 'likely_cached'
               WHEN cached IS FALSE THEN 'uncached'
               ELSE 'uncertain'
             END::text AS state,
             cached::boolean AS cached,
             COALESCE(NULLIF(proof_level, ''), 'availability_cache')::text AS proof_level,
             CASE
               WHEN proof_level IN ('episode_exact','file_exact') THEN 0.95
               WHEN cached IS TRUE THEN 0.75
               WHEN cached IS FALSE THEN 0.55
               ELSE 0.40
             END::numeric AS confidence,
             NULL::integer AS service_file_id,
             NULL::bigint AS service_file_size,
             updated_at::timestamptz AS checked_at,
             expires_at::timestamptz AS expires_at,
             COALESCE(expires_at, NOW() + INTERVAL '6 hours')::timestamptz AS next_check_at,
             0::integer AS failure_count,
             'legacy_availability_cache'::text AS match_reason,
             payload_json::jsonb AS payload_json
      FROM debrid_availability_cache
      WHERE info_hash_norm IS NOT NULL AND service IN ('rd','tb')
    ), authority_ranked AS (
      SELECT
        md5(service || ':' || info_hash_norm || ':' || file_index_norm::text || ':' || COALESCE(media_id, '') || ':' || COALESCE(imdb_id, '') || ':' || COALESCE(season::text, '-1') || ':' || COALESCE(episode::text, '-1')) AS authority_key,
        *,
        ROW_NUMBER() OVER (
          PARTITION BY service, info_hash_norm, file_index_norm, COALESCE(media_id, ''), COALESCE(imdb_id, ''), COALESCE(season::text, '-1'), COALESCE(episode::text, '-1')
          ORDER BY
            CASE WHEN proof_level = 'episode_exact' THEN 5 WHEN proof_level = 'file_exact' THEN 4 WHEN state = 'cached_verified' THEN 3 WHEN state IN ('likely_cached','probing') THEN 2 WHEN state IN ('uncached','uncached_terminal') THEN 1 ELSE 0 END DESC,
            confidence DESC,
            checked_at DESC NULLS LAST,
            expires_at DESC NULLS LAST
        ) AS rn
      FROM authority_source
      WHERE info_hash_norm IS NOT NULL
    )
    INSERT INTO debrid_authority (
      authority_key,
      service,
      info_hash,
      info_hash_norm,
      file_index,
      file_index_norm,
      media_id,
      imdb_id,
      season,
      episode,
      state,
      cached,
      proof_level,
      confidence,
      service_file_id,
      service_file_size,
      checked_at,
      expires_at,
      next_check_at,
      failure_count,
      match_reason,
      payload_json,
      created_at,
      updated_at
    )
    SELECT
      authority_key,
      service,
      info_hash_norm,
      info_hash_norm,
      NULLIF(file_index_norm, -1),
      file_index_norm,
      media_id,
      imdb_id,
      season,
      episode,
      state,
      cached,
      proof_level,
      confidence,
      service_file_id,
      service_file_size,
      checked_at,
      expires_at,
      next_check_at,
      failure_count,
      match_reason,
      payload_json,
      NOW(),
      NOW()
    FROM authority_ranked
    WHERE rn = 1
    LIMIT ${DB_AUTHORITY_BACKFILL_LIMIT}
    ON CONFLICT (authority_key)
    DO UPDATE SET
      state = EXCLUDED.state,
      cached = EXCLUDED.cached,
      proof_level = CASE
        WHEN EXCLUDED.proof_level IN ('episode_exact','file_exact') THEN EXCLUDED.proof_level
        ELSE COALESCE(debrid_authority.proof_level, EXCLUDED.proof_level)
      END,
      confidence = GREATEST(COALESCE(debrid_authority.confidence, 0), COALESCE(EXCLUDED.confidence, 0)),
      service_file_id = COALESCE(EXCLUDED.service_file_id, debrid_authority.service_file_id),
      service_file_size = GREATEST(COALESCE(debrid_authority.service_file_size, 0), COALESCE(EXCLUDED.service_file_size, 0)),
      checked_at = GREATEST(COALESCE(debrid_authority.checked_at, EXCLUDED.checked_at), COALESCE(EXCLUDED.checked_at, debrid_authority.checked_at)),
      expires_at = GREATEST(COALESCE(debrid_authority.expires_at, EXCLUDED.expires_at), COALESCE(EXCLUDED.expires_at, debrid_authority.expires_at)),
      next_check_at = COALESCE(EXCLUDED.next_check_at, debrid_authority.next_check_at),
      failure_count = LEAST(GREATEST(COALESCE(debrid_authority.failure_count, 0), COALESCE(EXCLUDED.failure_count, 0)), 9999),
      match_reason = COALESCE(NULLIF(EXCLUDED.match_reason, ''), debrid_authority.match_reason),
      payload_json = COALESCE(EXCLUDED.payload_json, debrid_authority.payload_json),
      updated_at = NOW()`,

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
    `CREATE INDEX IF NOT EXISTS idx_torrentio_tmdb_scan_queue_next ON torrentio_tmdb_scan_queue (state, not_before, priority DESC, updated_at ASC)`,
    `CREATE INDEX IF NOT EXISTS idx_torrentio_tmdb_scan_queue_media ON torrentio_tmdb_scan_queue (media_type, imdb_id, imdb_season, imdb_episode)`,
    `CREATE INDEX IF NOT EXISTS idx_torrentio_tmdb_scan_queue_tmdb ON torrentio_tmdb_scan_queue (tmdb_id, tmdb_endpoint)`,
    `CREATE INDEX IF NOT EXISTS idx_debrid_availability_expires ON debrid_availability_cache (expires_at)`,
    `CREATE INDEX IF NOT EXISTS idx_debrid_availability_hash_file ON debrid_availability_cache (service, info_hash_norm, file_index_norm)`,
    `CREATE INDEX IF NOT EXISTS idx_debrid_availability_media_file ON debrid_availability_cache (service, media_id, info_hash_norm, file_index_norm, expires_at)`,
    `CREATE INDEX IF NOT EXISTS idx_debrid_availability_episode ON debrid_availability_cache (service, imdb_id, imdb_season, imdb_episode, info_hash_norm, file_index_norm, expires_at)`,
    `CREATE INDEX IF NOT EXISTS idx_debrid_availability_state ON debrid_availability_cache (service, state, expires_at)`,

    `CREATE INDEX IF NOT EXISTS idx_torrent_items_seen ON torrent_items (last_seen_at DESC NULLS LAST, max_seeders DESC, seen_count DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_torrent_items_quality ON torrent_items (resolution, quality_tag, max_seeders DESC)`,
    `CREATE UNIQUE INDEX IF NOT EXISTS uq_torrent_files_hash_file ON torrent_files (info_hash_norm, file_index_norm)`,
    `CREATE INDEX IF NOT EXISTS idx_torrent_files_episode ON torrent_files (info_hash_norm, parsed_season, parsed_episode, file_index_norm)`,
    `CREATE INDEX IF NOT EXISTS idx_torrent_files_video ON torrent_files (info_hash_norm, is_video, video_rank DESC, size DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_media_file_map_episode ON media_file_map (imdb_id, season, episode, is_exact DESC, match_confidence DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_media_file_map_hash_file ON media_file_map (info_hash_norm, file_index_norm)`,
    `CREATE INDEX IF NOT EXISTS idx_provider_observations_hash ON provider_observations (info_hash_norm, file_index_norm)`,
    `CREATE INDEX IF NOT EXISTS idx_provider_observations_source ON provider_observations (provider_group, provider_name, addon_name, last_seen_at DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_debrid_authority_hash_file ON debrid_authority (service, info_hash_norm, file_index_norm, expires_at DESC NULLS LAST)`,
    `CREATE INDEX IF NOT EXISTS idx_debrid_authority_media ON debrid_authority (service, imdb_id, season, episode, state, expires_at DESC NULLS LAST)`,
    `CREATE INDEX IF NOT EXISTS idx_debrid_authority_due ON debrid_authority (service, next_check_at NULLS FIRST, failure_count ASC)`,
    `CREATE INDEX IF NOT EXISTS idx_debrid_authority_state ON debrid_authority (service, state, checked_at DESC NULLS LAST)`,
    `CREATE INDEX IF NOT EXISTS idx_debrid_resolved_link_expires ON debrid_resolved_link_cache (expires_at)`,
    `CREATE INDEX IF NOT EXISTS idx_debrid_resolved_link_service_hash ON debrid_resolved_link_cache (service, token_fp, info_hash_norm, file_id, expires_at DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_debrid_resolved_link_saved ON debrid_resolved_link_cache (service, token_fp, torrent_id, file_id, expires_at DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_debrid_check_jobs_due ON debrid_check_jobs (service, status, priority ASC, run_after ASC)`,
    `CREATE INDEX IF NOT EXISTS idx_debrid_check_jobs_hash ON debrid_check_jobs (service, info_hash_norm, file_index_norm)`,
    `CREATE INDEX IF NOT EXISTS idx_debrid_check_markers_lookup ON debrid_cache_check_markers (service, user_hash, media_id, expires_at)`,
    `CREATE INDEX IF NOT EXISTS idx_debrid_check_markers_expires ON debrid_cache_check_markers (expires_at)`
  ];

  for (const sql of statements.filter((statement) => typeof statement === 'string' && statement.trim())) {
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
    await pool.query(`DELETE FROM debrid_resolved_link_cache WHERE expires_at IS NOT NULL AND expires_at < NOW()`);
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
