const SHARED_STREAM_CACHE_COLUMNS = [
  'cache_key',
  'payload_b64',
  'encoding',
  'expires_at',
  'stale_until',
  'imdb_id',
  'imdb_season',
  'imdb_episode',
  'hashes',
  'content_date',
  'freshness_bucket',
  'confidence_score',
  'result_count',
  'cached_count',
  'best_quality',
  'source_mix',
  'policy_version',
  'hit_count',
  'updated_at'
].join(', ');

function createSharedStreamCacheRepository({
  getPool,
  withClient,
  awaitDatabaseOptimizations,
  normalizers
}) {
  const {
    clampInt,
    sanitizeText,
    normalizeImdbId,
    normalizeUniqueInfoHashes,
    normalizeUniqueTextList,
    toDateOrNull
  } = normalizers;

  function normalizeEpisodeFields(imdbId, season, episode) {
    const normalizedImdb = normalizeImdbId(imdbId);
    const parsedSeason = Number.isInteger(Number(season)) ? Number(season) : null;
    const parsedEpisode = Number.isInteger(Number(episode)) ? Number(episode) : null;
    if (!normalizedImdb || !Number.isInteger(parsedSeason) || parsedSeason <= 0 || !Number.isInteger(parsedEpisode) || parsedEpisode <= 0) {
      return { imdbId: normalizedImdb, season: null, episode: null };
    }
    return { imdbId: normalizedImdb, season: parsedSeason, episode: parsedEpisode };
  }

  async function getSharedStreamCache(cacheKey, options = {}) {
    if (!getPool() || !cacheKey) return null;
    await awaitDatabaseOptimizations();

    try {
      return await withClient(async (client) => {
        const touchHit = options?.touchHit !== false;
        const query = touchHit
          ? `
            UPDATE shared_stream_cache
            SET hit_count = COALESCE(hit_count, 0) + 1,
                updated_at = NOW()
            WHERE cache_key = $1
              AND stale_until >= NOW()
            RETURNING ${SHARED_STREAM_CACHE_COLUMNS}
          `
          : `
            SELECT ${SHARED_STREAM_CACHE_COLUMNS}
            FROM shared_stream_cache
            WHERE cache_key = $1
              AND stale_until >= NOW()
            LIMIT 1
          `;
        const res = await client.query(query, [String(cacheKey)]);
        return res.rows[0] || null;
      });
    } catch (error) {
      console.error(`❌ DB Error getSharedStreamCache: ${error.message}`);
      return null;
    }
  }

  async function touchSharedStreamCacheHit(cacheKey) {
    if (!getPool() || !cacheKey) return false;
    await awaitDatabaseOptimizations();

    try {
      await withClient((client) => client.query(
        `
          UPDATE shared_stream_cache
          SET hit_count = COALESCE(hit_count, 0) + 1,
              updated_at = NOW()
          WHERE cache_key = $1
            AND stale_until >= NOW()
        `,
        [String(cacheKey)]
      ));
      return true;
    } catch (error) {
      console.error(`❌ DB Error touchSharedStreamCacheHit: ${error.message}`);
      return false;
    }
  }

  async function setSharedStreamCache(entry) {
    if (!getPool() || !entry?.cache_key || !entry?.payload_b64) return false;
    await awaitDatabaseOptimizations();

    const cacheKey = String(entry.cache_key);
    const encoding = sanitizeText(entry.encoding, 'identity') || 'identity';
    const episodeFields = normalizeEpisodeFields(entry.imdb_id, entry.imdb_season, entry.imdb_episode);
    const imdbId = episodeFields.imdbId;
    const hashes = normalizeUniqueInfoHashes(entry.hashes);
    const contentDate = toDateOrNull(entry.content_date);
    const freshnessBucket = sanitizeText(entry.freshness_bucket).toLowerCase();
    const confidenceScore = clampInt(entry.confidence_score, 0, 0, 100);
    const resultCount = clampInt(entry.result_count, 0, 0, 1000);
    const cachedCount = clampInt(entry.cached_count, 0, 0, 1000);
    const bestQuality = sanitizeText(entry.best_quality) || null;
    const sourceMix = normalizeUniqueTextList(entry.source_mix, 8);
    const policyVersion = clampInt(entry.policy_version, 1, 1, 1000);
    const expiresAt = toDateOrNull(entry.expires_at);
    const staleUntil = toDateOrNull(entry.stale_until);
    if (!expiresAt || !staleUntil) return false;

    try {
      await withClient(async (client) => {
        await client.query(
          `
            INSERT INTO shared_stream_cache (
              cache_key,
              payload_b64,
              encoding,
              expires_at,
              stale_until,
              imdb_id,
              imdb_season,
              imdb_episode,
              hashes,
              content_date,
              freshness_bucket,
              confidence_score,
              result_count,
              cached_count,
              best_quality,
              source_mix,
              policy_version,
              hit_count,
              created_at,
              updated_at
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::TEXT[], $10, $11, $12, $13, $14, $15, $16::TEXT[], $17, 0, NOW(), NOW())
            ON CONFLICT (cache_key)
            DO UPDATE SET
              payload_b64 = EXCLUDED.payload_b64,
              encoding = EXCLUDED.encoding,
              expires_at = EXCLUDED.expires_at,
              stale_until = EXCLUDED.stale_until,
              imdb_id = EXCLUDED.imdb_id,
              imdb_season = EXCLUDED.imdb_season,
              imdb_episode = EXCLUDED.imdb_episode,
              hashes = EXCLUDED.hashes,
              content_date = EXCLUDED.content_date,
              freshness_bucket = EXCLUDED.freshness_bucket,
              confidence_score = EXCLUDED.confidence_score,
              result_count = EXCLUDED.result_count,
              cached_count = EXCLUDED.cached_count,
              best_quality = EXCLUDED.best_quality,
              source_mix = EXCLUDED.source_mix,
              policy_version = EXCLUDED.policy_version,
              updated_at = NOW()
          `,
          [
            cacheKey,
            entry.payload_b64,
            encoding,
            expiresAt,
            staleUntil,
            imdbId,
            episodeFields.season,
            episodeFields.episode,
            hashes,
            contentDate,
            freshnessBucket || null,
            confidenceScore,
            resultCount,
            cachedCount,
            bestQuality,
            sourceMix,
            policyVersion
          ]
        );
      });
      return true;
    } catch (error) {
      console.error(`❌ DB Error setSharedStreamCache: ${error.message}`);
      return false;
    }
  }

  async function deleteSharedStreamCacheByHashes(hashes) {
    if (!getPool()) return 0;
    await awaitDatabaseOptimizations();

    const normalized = normalizeUniqueInfoHashes(hashes);
    if (normalized.length === 0) return 0;

    try {
      const res = await withClient((client) => client.query(
        `DELETE FROM shared_stream_cache WHERE hashes && $1::TEXT[]`,
        [normalized]
      ));
      return res.rowCount || 0;
    } catch (error) {
      console.error(`❌ DB Error deleteSharedStreamCacheByHashes: ${error.message}`);
      return 0;
    }
  }

  async function deleteSharedStreamCacheByImdb(imdbId) {
    if (!getPool()) return 0;
    await awaitDatabaseOptimizations();

    const normalizedImdb = normalizeImdbId(imdbId);
    if (!normalizedImdb) return 0;

    try {
      const res = await withClient((client) => client.query(
        `DELETE FROM shared_stream_cache WHERE imdb_id = $1`,
        [normalizedImdb]
      ));
      return res.rowCount || 0;
    } catch (error) {
      console.error(`❌ DB Error deleteSharedStreamCacheByImdb: ${error.message}`);
      return 0;
    }
  }

  async function deleteSharedStreamCacheByEpisode(imdbId, season, episode) {
    if (!getPool()) return 0;
    await awaitDatabaseOptimizations();

    const episodeFields = normalizeEpisodeFields(imdbId, season, episode);
    if (!episodeFields.imdbId || episodeFields.season === null || episodeFields.episode === null) return 0;

    try {
      const res = await withClient((client) => client.query(
        `
          DELETE FROM shared_stream_cache
          WHERE imdb_id = $1
            AND imdb_season = $2
            AND imdb_episode = $3
        `,
        [episodeFields.imdbId, episodeFields.season, episodeFields.episode]
      ));
      return res.rowCount || 0;
    } catch (error) {
      console.error(`❌ DB Error deleteSharedStreamCacheByEpisode: ${error.message}`);
      return 0;
    }
  }

  async function cleanupExpiredSharedStreamCache(options = {}) {
    if (!getPool()) return 0;
    await awaitDatabaseOptimizations();

    const limit = clampInt(options.limit, 5000, 100, 50000);

    try {
      const res = await withClient((client) => client.query(
        `
          WITH doomed AS (
            SELECT ctid
            FROM shared_stream_cache
            WHERE stale_until < NOW()
            ORDER BY stale_until ASC
            LIMIT $1
          )
          DELETE FROM shared_stream_cache s
          USING doomed d
          WHERE s.ctid = d.ctid
        `,
        [limit]
      ));
      return res.rowCount || 0;
    } catch (error) {
      console.error(`❌ DB Error cleanupExpiredSharedStreamCache: ${error.message}`);
      return 0;
    }
  }

  async function vacuumAnalyzeSharedStreamCache() {
    const pool = getPool();
    if (!pool) return false;
    await awaitDatabaseOptimizations();

    let client = null;
    try {
      client = await pool.connect();
      await client.query('VACUUM (ANALYZE) shared_stream_cache');
      return true;
    } catch (error) {
      console.error(`❌ DB Error vacuumAnalyzeSharedStreamCache: ${error.message}`);
      try {
        if (client) await client.query('ANALYZE shared_stream_cache');
        return false;
      } catch (_) {
        return false;
      }
    } finally {
      if (client) client.release();
    }
  }

  return {
    getSharedStreamCache,
    touchSharedStreamCacheHit,
    setSharedStreamCache,
    deleteSharedStreamCacheByHashes,
    deleteSharedStreamCacheByImdb,
    deleteSharedStreamCacheByEpisode,
    cleanupExpiredSharedStreamCache,
    vacuumAnalyzeSharedStreamCache
  };
}

module.exports = {
  createSharedStreamCacheRepository
};
