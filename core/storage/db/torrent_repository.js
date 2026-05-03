function createTorrentRepository({
  getPool,
  withClient,
  runInTransaction,
  awaitDatabaseOptimizations,
  trackerRegistry,
  normalizers
}) {
  const {
    clampInt,
    toNullableInt,
    toSafeNumber,
    sanitizeText,
    normalizeInfoHash,
    normalizeUniqueInfoHashes,
    normalizeImdbId,
    normalizeFileIndex,
    normalizeFileIndexNorm,
    normalizeRdCacheState,
    deriveStoredCacheState,
    deriveCachedBooleanFromState,
    extractOriginalProvider
  } = normalizers;


  // Leviathan RD cache policy: valori fissati in codice, non dipendono da .env.
  // ⚡ cached confermato viene ricontrollato ogni 7 giorni; i vecchi permanenti 9999 vengono sempre re-queued al boot.
  const RD_CACHED_RECHECK_HOURS = 168;
  const RD_REVALIDATE_PERMANENT_ON_BOOT = true;

  function normalizeProviderName(providerName, title) {
    const extracted = extractOriginalProvider(title);
    if (extracted) return extracted;
    const normalized = sanitizeText(providerName);
    if (!normalized || normalized === 'Torrentio' || normalized === 'P2P') return 'External';
    return normalized;
  }

  function normalizeEpisodeIdentity(entry) {
    const imdbId = normalizeImdbId(entry?.imdb_id || entry?.imdbId);
    const imdbSeason = toNullableInt(entry?.imdb_season ?? entry?.season);
    const imdbEpisode = toNullableInt(entry?.imdb_episode ?? entry?.episode);
    const isEpisode = Boolean(imdbId && imdbSeason !== null && imdbSeason > 0 && imdbEpisode !== null && imdbEpisode > 0);
    return { imdbId, imdbSeason, imdbEpisode, isEpisode };
  }

  async function upsertEpisodeScopedOverrideRow(client, entry) {
    const hash = normalizeInfoHash(entry?.hash || entry?.info_hash || entry?.infoHash);
    const identity = normalizeEpisodeIdentity(entry);
    if (!hash || !identity.isEpisode) return false;

    const rdFileIndex = normalizeFileIndex(entry?.rd_file_index);
    const rdFileSize = entry?.rd_file_size === null || entry?.rd_file_size === undefined ? null : toSafeNumber(entry?.rd_file_size, 0);
    const tbFileId = normalizeFileIndex(entry?.tb_file_id ?? entry?.file_id);
    const tbFileSize = entry?.tb_file_size === null || entry?.tb_file_size === undefined ? null : toSafeNumber(entry?.tb_file_size, 0);

    await client.query(
      `
        INSERT INTO episode_file_overrides (
          info_hash,
          info_hash_norm,
          imdb_id,
          imdb_season,
          imdb_episode,
          rd_file_index,
          rd_file_size,
          tb_file_id,
          tb_file_size,
          created_at,
          updated_at
        )
        VALUES ($1, $1, $2, $3, $4, $5, $6, $7, $8, NOW(), NOW())
        ON CONFLICT (info_hash_norm, imdb_id, imdb_season, imdb_episode)
        DO UPDATE SET
          rd_file_index = CASE
            WHEN EXCLUDED.rd_file_index IS NULL OR EXCLUDED.rd_file_index < 0 THEN episode_file_overrides.rd_file_index
            ELSE EXCLUDED.rd_file_index
          END,
          rd_file_size = CASE
            WHEN EXCLUDED.rd_file_size IS NULL OR EXCLUDED.rd_file_size <= 0 THEN episode_file_overrides.rd_file_size
            ELSE EXCLUDED.rd_file_size
          END,
          tb_file_id = CASE
            WHEN EXCLUDED.tb_file_id IS NULL OR EXCLUDED.tb_file_id < 0 THEN episode_file_overrides.tb_file_id
            ELSE EXCLUDED.tb_file_id
          END,
          tb_file_size = CASE
            WHEN EXCLUDED.tb_file_size IS NULL OR EXCLUDED.tb_file_size <= 0 THEN episode_file_overrides.tb_file_size
            ELSE EXCLUDED.tb_file_size
          END,
          updated_at = NOW()
      `,
      [hash, identity.imdbId, identity.imdbSeason, identity.imdbEpisode, rdFileIndex, rdFileSize, tbFileId, tbFileSize]
    );

    return true;
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
      matched_file_index: normalizeFileIndex(row.matched_file_index),
      matched_file_title: sanitizeText(row.matched_file_title),
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
    const pool = getPool();
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
        WITH episode_matches AS (
          SELECT
            info_hash_norm AS hash_norm,
            file_index AS matched_file_index,
            file_index_norm AS matched_file_index_norm,
            title AS matched_file_title,
            size AS matched_file_size,
            1 AS source_rank
          FROM files
          WHERE imdb_id = $1
            AND imdb_season = $2
            AND imdb_episode = $3

          UNION ALL

          SELECT
            pack_hash_norm AS hash_norm,
            file_index AS matched_file_index,
            file_index_norm AS matched_file_index_norm,
            COALESCE(NULLIF(file_title, ''), NULLIF(file_path, ''), pack_hash_norm) AS matched_file_title,
            file_size AS matched_file_size,
            2 AS source_rank
          FROM pack_files
          WHERE imdb_id = $1
            AND imdb_season = $2
            AND imdb_episode = $3
        ),
        dedup_matches AS (
          SELECT DISTINCT ON (hash_norm, matched_file_index_norm)
            hash_norm,
            matched_file_index,
            matched_file_index_norm,
            matched_file_title,
            matched_file_size,
            source_rank
          FROM episode_matches
          WHERE hash_norm IS NOT NULL
          ORDER BY
            hash_norm,
            matched_file_index_norm,
            source_rank ASC,
            COALESCE(matched_file_size, 0) DESC,
            LENGTH(COALESCE(matched_file_title, '')) DESC
        ),
        episode_overrides AS (
          SELECT
            info_hash_norm AS hash_norm,
            rd_file_index,
            rd_file_size,
            tb_file_id,
            tb_file_size
          FROM episode_file_overrides
          WHERE imdb_id = $1
            AND imdb_season = $2
            AND imdb_episode = $3
        )
        SELECT DISTINCT ON (t.info_hash_norm, COALESCE(m.matched_file_index_norm, t.file_index_norm))
          t.title,
          TRIM(t.info_hash) AS info_hash,
          t.size,
          t.seeders,
          t.provider,
          COALESCE(m.matched_file_index, t.file_index) AS file_index,
          m.matched_file_index,
          m.matched_file_title,
          t.cached_rd,
          t.rd_cache_state,
          COALESCE(o.rd_file_index, t.rd_file_index) AS rd_file_index,
          COALESCE(o.rd_file_size, t.rd_file_size) AS rd_file_size,
          t.last_cached_check,
          t.next_cached_check,
          t.cache_check_failures,
          t.tb_cached,
          COALESCE(o.tb_file_id, t.tb_file_id) AS tb_file_id,
          COALESCE(o.tb_file_size, t.tb_file_size) AS tb_file_size
        FROM dedup_matches m
        JOIN torrents t
          ON t.info_hash_norm = m.hash_norm
        LEFT JOIN episode_overrides o
          ON o.hash_norm = t.info_hash_norm
        ORDER BY
          t.info_hash_norm,
          COALESCE(m.matched_file_index_norm, t.file_index_norm),
          CASE WHEN COALESCE(o.rd_file_index, t.rd_file_index) IS NOT NULL THEN 1 ELSE 0 END DESC,
          CASE WHEN t.cached_rd IS TRUE THEN 1 ELSE 0 END DESC,
          COALESCE(t.seeders, 0) DESC,
          COALESCE(m.matched_file_size, t.rd_file_size, t.size, 0) DESC
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
          NULL::INTEGER AS matched_file_index,
          NULL::TEXT AS matched_file_title,
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

    const insertRes = await client.query(
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
        RETURNING 1
      `,
      [infoHash, fileIndex, fileIndexNorm, providerName, title, size, seeders]
    );

    return insertRes.rowCount > 0;
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

    const sameIdentityUpdateRes = await client.query(
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
          AND imdb_id = $3
          AND imdb_season IS NOT DISTINCT FROM $4
          AND imdb_episode IS NOT DISTINCT FROM $5
        RETURNING 1
      `,
      [infoHash, fileIndexNorm, imdbId, imdbSeason, imdbEpisode, title, size]
    );

    if (sameIdentityUpdateRes.rowCount > 0) return false;

    const changedIdentityUpdateRes = await client.query(
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

    if (changedIdentityUpdateRes.rowCount > 0) return true;

    const insertRes = await client.query(
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
        RETURNING 1
      `,
      [infoHash, fileIndex, fileIndexNorm, imdbId, imdbSeason, imdbEpisode, title, size]
    );

    return insertRes.rowCount > 0;
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

    const insertRes = await client.query(
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
        RETURNING 1
      `,
      [packHash, fileIndex, fileIndexNorm, imdbId, imdbSeason, imdbEpisode, filePath, fileTitle, fileSize]
    );

    return insertRes.rowCount > 0;
  }

  function normalizeMeta(meta, torrent = {}) {
    const fallbackType = sanitizeText(meta?.type || torrent?.type, 'movie') || 'movie';
    const imdbId = normalizeImdbId(meta?.imdb_id || meta?.imdbId || torrent?.imdb_id || torrent?.imdbId);
    const season = fallbackType === 'movie' ? null : toNullableInt(meta?.season ?? torrent?.season ?? torrent?.imdb_season);
    const episode = fallbackType === 'movie' ? null : toNullableInt(meta?.episode ?? torrent?.episode ?? torrent?.imdb_episode);
    return { imdbId, season, episode, type: fallbackType };
  }

  async function insertTorrent(meta, torrent) {
    if (!getPool()) return false;
    await awaitDatabaseOptimizations();

    const normalizedMeta = normalizeMeta(meta, torrent);
    const infoHash = normalizeInfoHash(torrent?.info_hash || torrent?.infoHash || torrent?.hash);
    if (!infoHash || !normalizedMeta.imdbId) return false;

    try {
      return await runInTransaction(async (client) => {
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
        return inserted;
      });
    } catch (error) {
      console.error(`❌ DB Save Error: ${error.message}`);
      return false;
    }
  }

  async function insertTorrentsBatch(meta, torrents) {
    if (!getPool() || !Array.isArray(torrents) || torrents.length === 0) return { inserted: 0, processed: 0 };
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
      return await runInTransaction(async (client) => {
        let inserted = 0;
        let mapped = 0;

        for (const entry of items) {
          const wasInserted = await upsertTorrentRow(client, entry.torrent);
          if (wasInserted) inserted += 1;
          const wasMapped = await upsertFileMappingRow(client, {
            info_hash: entry.infoHash,
            file_index: entry.torrent?.file_index ?? entry.torrent?.fileIdx,
            imdb_id: normalizedMeta.imdbId,
            imdb_season: normalizedMeta.season,
            imdb_episode: normalizedMeta.episode,
            title: entry.torrent?.title,
            size: entry.torrent?.size
          });
          if (wasMapped) mapped += 1;
        }

        return { inserted, mapped, processed: items.length };
      });
    } catch (error) {
      console.error(`❌ DB Batch Save Error: ${error.message}`);
      return { inserted: 0, processed: 0, error: error.message };
    }
  }

  async function ensureTorrentRecord(torrent) {
    if (!getPool()) return false;
    await awaitDatabaseOptimizations();

    const cleanHash = normalizeInfoHash(torrent?.info_hash || torrent?.infoHash || torrent?.hash);
    if (!cleanHash) return false;

    try {
      return await runInTransaction((client) => upsertTorrentRow(client, {
        ...torrent,
        info_hash: cleanHash
      }));
    } catch (error) {
      console.error(`❌ DB ensureTorrentRecord Error: ${error.message}`);
      return false;
    }
  }

  async function updateTorrentTitle(infoHash, title) {
    const pool = getPool();
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
    if (!getPool() || !Array.isArray(entries) || entries.length === 0) return { inserted: 0, processed: 0 };
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
      return await runInTransaction(async (client) => {
        let inserted = 0;

        for (const entry of normalized) {
          const wasInserted = await upsertFileMappingRow(client, entry);
          if (wasInserted) inserted += 1;
        }

        return { inserted, processed: normalized.length };
      });
    } catch (error) {
      console.error(`❌ DB Error insertEpisodeFiles: ${error.message}`);
      return { inserted: 0, processed: 0, error: error.message };
    }
  }

  async function insertPackFiles(entries) {
    if (!getPool() || !Array.isArray(entries) || entries.length === 0) return { inserted: 0, processed: 0 };
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
      return await runInTransaction(async (client) => {
        let inserted = 0;

        for (const entry of normalized) {
          const wasInserted = await upsertPackFileRow(client, entry);
          if (wasInserted) inserted += 1;
        }

        return { inserted, processed: normalized.length };
      });
    } catch (error) {
      console.error(`❌ DB Error insertPackFiles: ${error.message}`);
      return { inserted: 0, processed: 0, error: error.message };
    }
  }

  async function getPackFiles(infoHash, limit = 50) {
    const pool = getPool();
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
    const pool = getPool();
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
    const pool = getPool();
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
    if (!getPool()) return [];
    await awaitDatabaseOptimizations();

    const normalizedHashes = normalizeUniqueInfoHashes(hashes);
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
      const nextCheckTs = row.next_cached_check ? Date.parse(String(row.next_cached_check)) : NaN;
      const duePositiveRecheck = (row.cached_rd === true || row.rd_cache_state === 'cached') && Number.isFinite(nextCheckTs) && nextCheckTs <= Date.now() + 15000;
      if (duePositiveRecheck) continue;
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
    if (!getPool() || !Array.isArray(cacheResults) || cacheResults.length === 0) return 0;
    await awaitDatabaseOptimizations();

    const normalizedRows = cacheResults
      .map((entry) => {
        const hasCached = typeof entry?.cached === 'boolean';
        const state = deriveStoredCacheState(entry);
        const permanent = hasCached && entry.cached === true && entry?.permanent === true && entry?.trustedPermanent === true;
        const defaultNextHours = state === 'cached'
          ? RD_CACHED_RECHECK_HOURS
          : (hasCached ? (entry.cached ? RD_CACHED_RECHECK_HOURS : 24 * 7) : 12);
        const nextHours = permanent
          ? null
          : Math.max(1, Math.min(24 * 365 * 10, toSafeNumber(entry?.next_hours, defaultNextHours)));
        const cached = deriveCachedBooleanFromState(state, hasCached ? entry.cached : null);
        const identity = normalizeEpisodeIdentity(entry);
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
          size: Math.max(0, toSafeNumber(entry?.size, 0)),
          imdb_id: identity.imdbId,
          imdb_season: identity.imdbSeason,
          imdb_episode: identity.imdbEpisode,
          episode_scoped: identity.isEpisode
        };
      })
      .filter((entry) => entry.hash);

    if (normalizedRows.length === 0) return 0;

    try {
      return await runInTransaction(async (client) => {
        let updated = 0;

        for (const row of normalizedRows) {
          if (row.episode_scoped && Number.isInteger(row.rd_file_index) && row.rd_file_index >= 0) {
            await upsertEpisodeScopedOverrideRow(client, {
              hash: row.hash,
              imdb_id: row.imdb_id,
              imdb_season: row.imdb_season,
              imdb_episode: row.imdb_episode,
              rd_file_index: row.rd_file_index,
              rd_file_size: row.rd_file_size
            });
          }

          const globalRdFileIndex = row.episode_scoped ? null : row.rd_file_index;
          const globalRdFileSize = row.episode_scoped ? null : row.rd_file_size;

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
            `,
            [row.hash, row.cached, row.rd_cache_state, globalRdFileIndex, globalRdFileSize, row.failures, row.permanent, row.title, row.size, row.next_hours]
          );
          updated += Number(result.rowCount || 0);
        }

        return updated;
      });
    } catch (error) {
      console.error(`❌ DB Error updateCache: ${error.message}`);
      return 0;
    }
  }

  async function updateTbCacheStatus(updates) {
    if (!getPool() || !Array.isArray(updates) || updates.length === 0) return 0;
    await awaitDatabaseOptimizations();

    const rows = updates
      .map((entry) => {
        const identity = normalizeEpisodeIdentity(entry);
        return {
          hash: normalizeInfoHash(entry?.hash),
          cached: typeof entry?.cached === 'boolean' ? entry.cached : null,
          fileId: normalizeFileIndex(entry?.tb_file_id ?? entry?.file_id),
          fileSize: entry?.tb_file_size === null || entry?.tb_file_size === undefined
            ? (entry?.file_size === null || entry?.file_size === undefined ? null : toSafeNumber(entry?.file_size, 0))
            : toSafeNumber(entry?.tb_file_size, 0),
          title: sanitizeText(entry?.torrent_title || entry?.title),
          size: Math.max(0, toSafeNumber(entry?.size, 0)),
          imdb_id: identity.imdbId,
          imdb_season: identity.imdbSeason,
          imdb_episode: identity.imdbEpisode,
          episode_scoped: identity.isEpisode
        };
      })
      .filter((entry) => entry.hash);

    if (rows.length === 0) return 0;

    try {
      return await runInTransaction(async (client) => {
        let updated = 0;

        for (const row of rows) {
          if (row.episode_scoped && Number.isInteger(row.fileId) && row.fileId >= 0) {
            await upsertEpisodeScopedOverrideRow(client, {
              hash: row.hash,
              imdb_id: row.imdb_id,
              imdb_season: row.imdb_season,
              imdb_episode: row.imdb_episode,
              tb_file_id: row.fileId,
              tb_file_size: row.fileSize
            });
          }

          const globalFileId = row.episode_scoped ? null : row.fileId;
          const globalFileSize = row.episode_scoped ? null : row.fileSize;

          const result = await client.query(
            `
              UPDATE torrents
              SET tb_cached = COALESCE($2::boolean, tb_cached),
                  tb_file_id = CASE
                    WHEN $3::integer IS NULL OR $3::integer < 0 THEN tb_file_id
                    ELSE $3::integer
                  END,
                  tb_file_size = CASE
                    WHEN $4::bigint IS NULL OR $4::bigint <= 0 THEN tb_file_size
                    ELSE $4::bigint
                  END,
                  title = CASE
                    WHEN $5::text = '' THEN title
                    WHEN title IS NULL OR title = '' THEN $5::text
                    WHEN LENGTH($5::text) > LENGTH(title) THEN $5::text
                    ELSE title
                  END,
                  size = CASE
                    WHEN $6::bigint <= 0 THEN size
                    ELSE GREATEST(COALESCE(size, 0), $6::bigint)
                  END,
                  tb_last_cached_check = NOW(),
                  updated_at = NOW()
              WHERE info_hash_norm = $1
            `,
            [row.hash, row.cached, globalFileId, globalFileSize, row.title, row.size]
          );
          updated += Number(result.rowCount || 0);
        }

        return updated;
      });
    } catch (error) {
      console.error(`❌ DB Error updateTbCacheStatus: ${error.message}`);
      return 0;
    }
  }

  async function getRdScanProgress() {
    const pool = getPool();
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
    const pool = getPool();
    if (!pool) return { requested: 0, updated: 0 };
    await awaitDatabaseOptimizations();

    const normalizedHashes = normalizeUniqueInfoHashes(hashes)
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
    if (!getPool()) return { applied: false, updated: 0, reason: 'pool_missing' };
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

        let requeuedPermanent = 0;
        if (RD_REVALIDATE_PERMANENT_ON_BOOT) {
          while (true) {
            const requeueRes = await client.query(
              `
                WITH target AS (
                  SELECT ctid
                  FROM torrents
                  WHERE info_hash_norm IS NOT NULL
                    AND cached_rd IS TRUE
                    AND rd_cache_state = 'cached'
                    AND next_cached_check >= TIMESTAMPTZ '9999-01-01 00:00:00+00'
                  LIMIT $1
                )
                UPDATE torrents AS t
                SET next_cached_check = NOW() - make_interval(mins => 1),
                    updated_at = NOW()
                FROM target
                WHERE t.ctid = target.ctid
              `,
              [chunkSize]
            );
            const changed = Number(requeueRes.rowCount || 0);
            requeuedPermanent += changed;
            totalUpdated += changed;
            if (changed === 0) break;
          }
        }

        return { applied: true, updated: totalUpdated, requeuedPermanent, reason: 'normalized' };
      });
    } catch (error) {
      console.error(`❌ DB Error normalizePendingRdCacheState: ${error.message}`);
      return { applied: false, updated: 0, reason: error.message };
    } finally {
      const pool = getPool();
      if (lockAcquired && pool) {
        try {
          await pool.query('SELECT pg_advisory_unlock($1)', [lockKey]);
        } catch (_) {}
      }
    }
  }

  return {
    getTorrents,
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
    normalizePendingRdCacheState
  };
}

module.exports = {
  createTorrentRepository
};
