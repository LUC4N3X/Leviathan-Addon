const crypto = require('crypto');

function safeJson(value) {
  try { return JSON.stringify(value ?? null); } catch (_) { return 'null'; }
}

function safeInt(value, fallback = 0) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function sanitize(value, limit = 512) {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text ? text.slice(0, limit) : null;
}

function hashUrl(value) {
  if (!value) return null;
  try {
    const parsed = new URL(String(value));
    return crypto.createHash('sha256').update(`${parsed.protocol}//${parsed.host}${parsed.pathname}`).digest('hex');
  } catch (_) {
    return crypto.createHash('sha256').update(String(value)).digest('hex');
  }
}

function createTrackProbeRepository({ getPool, withClient, awaitDatabaseOptimizations, normalizers }) {
  const { normalizeInfoHash, normalizeFileIndexNorm } = normalizers;

  async function getTrackProbeCache(cacheKey) {
    if (!getPool() || !cacheKey) return null;
    await awaitDatabaseOptimizations();

    try {
      return await withClient(async (client) => {
        const result = await client.query(
          `SELECT cache_key, service, info_hash_norm, file_index_norm, file_size, filename, status,
                  tracks_json, normalized_json, score_patch_json, error_code, attempts, expires_at,
                  created_at, updated_at
             FROM track_probe_cache
            WHERE cache_key = $1
              AND expires_at > NOW()
            LIMIT 1`,
          [cacheKey]
        );
        return result.rows[0] || null;
      });
    } catch (error) {
      console.error(`❌ DB Error getTrackProbeCache: ${error.message}`);
      return null;
    }
  }

  async function upsertTrackProbeCache(entry = {}) {
    if (!getPool() || !entry.cacheKey) return { ok: false, reason: 'db_not_initialized' };
    await awaitDatabaseOptimizations();

    const status = sanitize(entry.status || 'error', 32) || 'error';
    const ttlSeconds = Math.max(60, safeInt(entry.ttlSeconds, 21600));
    const attempts = Math.max(1, safeInt(entry.attempts, 1));
    const infoHash = normalizeInfoHash(entry.infoHash || entry.info_hash || entry.info_hash_norm);
    const fileIndexNorm = normalizeFileIndexNorm(entry.fileIdx ?? entry.fileIndex ?? entry.file_index ?? entry.file_index_norm);
    const service = sanitize(entry.service || 'unknown', 24) || 'unknown';
    const fileSize = safeInt(entry.fileSize ?? entry.size, 0);
    const filename = sanitize(entry.filename, 512);
    const urlHash = sanitize(entry.urlHash || hashUrl(entry.url), 80);
    const errorCode = sanitize(entry.errorCode || entry.error_code, 80);

    try {
      await withClient(async (client) => client.query(
        `INSERT INTO track_probe_cache (
           cache_key, service, info_hash, info_hash_norm, file_index, file_index_norm, file_size,
           filename, url_hash, status, tracks_json, normalized_json, score_patch_json, error_code,
           attempts, expires_at, created_at, updated_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12::jsonb,$13::jsonb,$14,$15,NOW() + ($16::int * INTERVAL '1 second'),NOW(),NOW())
         ON CONFLICT (cache_key) DO UPDATE SET
           service = EXCLUDED.service,
           info_hash = COALESCE(EXCLUDED.info_hash, track_probe_cache.info_hash),
           info_hash_norm = COALESCE(EXCLUDED.info_hash_norm, track_probe_cache.info_hash_norm),
           file_index = CASE WHEN EXCLUDED.file_index_norm >= 0 THEN EXCLUDED.file_index ELSE track_probe_cache.file_index END,
           file_index_norm = CASE WHEN EXCLUDED.file_index_norm >= 0 THEN EXCLUDED.file_index_norm ELSE track_probe_cache.file_index_norm END,
           file_size = GREATEST(COALESCE(EXCLUDED.file_size, 0), COALESCE(track_probe_cache.file_size, 0)),
           filename = COALESCE(EXCLUDED.filename, track_probe_cache.filename),
           url_hash = COALESCE(EXCLUDED.url_hash, track_probe_cache.url_hash),
           status = EXCLUDED.status,
           tracks_json = EXCLUDED.tracks_json,
           normalized_json = EXCLUDED.normalized_json,
           score_patch_json = EXCLUDED.score_patch_json,
           error_code = EXCLUDED.error_code,
           attempts = GREATEST(COALESCE(track_probe_cache.attempts, 0) + 1, EXCLUDED.attempts),
           expires_at = EXCLUDED.expires_at,
           updated_at = NOW()`,
        [
          entry.cacheKey,
          service,
          infoHash,
          infoHash,
          fileIndexNorm >= 0 ? fileIndexNorm : null,
          fileIndexNorm,
          fileSize > 0 ? fileSize : null,
          filename,
          urlHash,
          status,
          safeJson(entry.tracks || []),
          safeJson(entry.normalized || null),
          safeJson(entry.scorePatch || null),
          errorCode,
          attempts,
          ttlSeconds
        ]
      ));
      return { ok: true };
    } catch (error) {
      console.error(`❌ DB Error upsertTrackProbeCache: ${error.message}`);
      return { ok: false, error: error.message };
    }
  }

  async function deleteExpiredTrackProbeCache() {
    if (!getPool()) return { deleted: 0 };
    await awaitDatabaseOptimizations();

    try {
      return await withClient(async (client) => {
        const result = await client.query(`DELETE FROM track_probe_cache WHERE expires_at IS NOT NULL AND expires_at < NOW()`);
        return { deleted: Number(result.rowCount || 0) };
      });
    } catch (error) {
      console.error(`❌ DB Error deleteExpiredTrackProbeCache: ${error.message}`);
      return { deleted: 0, error: error.message };
    }
  }

  return {
    getTrackProbeCache,
    upsertTrackProbeCache,
    deleteExpiredTrackProbeCache
  };
}

module.exports = {
  createTrackProbeRepository
};
