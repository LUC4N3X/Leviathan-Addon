const crypto = require('crypto');

function safeInt(value, fallback = 0) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function safeJson(value) {
  if (!value) return null;
  try { return JSON.stringify(value); } catch (_) { return null; }
}

function makeKey(parts = []) {
  return crypto.createHash('sha1').update(parts.map((part) => String(part ?? '')).join('|')).digest('hex');
}

function createCacheRepository({ getPool, withClient, awaitDatabaseOptimizations, normalizers }) {
  const { normalizeInfoHash, normalizeFileIndexNorm, normalizeImdbId, sanitizeText } = normalizers;

  async function recordTorrentRankHistory(meta = {}, rankedItems = [], options = {}) {
    if (!getPool() || !Array.isArray(rankedItems) || rankedItems.length === 0) return { inserted: 0, processed: 0 };
    await awaitDatabaseOptimizations();

    const limit = Math.max(1, Math.min(100, safeInt(options.limit, 40)));
    const mediaId = sanitizeText(meta.id || meta.imdb_id || meta.imdb || meta.tmdb_id || meta.title).slice(0, 120) || null;
    const imdbId = normalizeImdbId(meta.imdb_id || meta.imdb);
    const season = meta.season === undefined || meta.season === null ? null : safeInt(meta.season, null);
    const episode = meta.episode === undefined || meta.episode === null ? null : safeInt(meta.episode, null);
    const rows = rankedItems.slice(0, limit).map((item, index) => {
      const hash = normalizeInfoHash(item.infoHash || item.info_hash || item.hash);
      if (!hash) return null;
      const fileIndexNorm = normalizeFileIndexNorm(item.fileIdx ?? item.fileIndex ?? item.file_index);
      return {
        rankKey: makeKey([mediaId, imdbId, season ?? -1, episode ?? -1, hash, fileIndexNorm, index, Date.now()]),
        mediaId,
        imdbId,
        season,
        episode,
        hash,
        fileIndexNorm,
        score: safeInt(item._score ?? item._leviathanScore, 0),
        rankPosition: index + 1,
        cacheState: sanitizeText(item._rdCacheState || item.rdCacheState || item.cacheState || (item._dbCachedRd ? 'cached' : '')).slice(0, 64) || null,
        quality: sanitizeText(item.quality || item.resolution || item.quality_tag).slice(0, 80) || null,
        provider: sanitizeText(item.provider || item.source || item.externalProvider || item.externalAddon).slice(0, 120) || null,
        reasons: Array.isArray(item._reasons) ? item._reasons.slice(0, 40).map((x) => String(x).slice(0, 80)) : [],
        payload: {
          title: item.title || item.name || item.filename || null,
          leviathanScore: item._leviathanScore || null,
          torrentIntelligence: item._rankMeta?.torrentIntelligence || item._leviathanScoreProfile?.torrentIntelligence || null,
          explain: item._leviathanExplain || null
        }
      };
    }).filter(Boolean);

    if (rows.length === 0) return { inserted: 0, processed: 0 };

    return withClient(async (client) => {
      let inserted = 0;
      for (const row of rows) {
        const res = await client.query(
          `INSERT INTO torrent_rank_history (
             rank_key, media_id, imdb_id, imdb_season, imdb_episode, info_hash_norm, file_index_norm,
             score, rank_position, cache_state, quality, provider, reasons, payload_json, created_at
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::jsonb,NOW())
           ON CONFLICT (rank_key) DO NOTHING`,
          [
            row.rankKey, row.mediaId, row.imdbId, row.season, row.episode, row.hash, row.fileIndexNorm,
            row.score, row.rankPosition, row.cacheState, row.quality, row.provider, row.reasons,
            safeJson(row.payload)
          ]
        );
        inserted += Number(res.rowCount || 0);
      }
      return { inserted, processed: rows.length };
    }).catch((error) => {
      console.error(`❌ DB Error recordTorrentRankHistory: ${error.message}`);
      return { inserted: 0, processed: rows.length, error: error.message };
    });
  }

  async function getPostgresCacheOverview() {
    if (!getPool()) return null;
    await awaitDatabaseOptimizations();

    try {
      return await withClient(async (client) => {
        const [torrentRows, streamRows, debridRows, savedRows, rankRows, maintenanceRows] = await Promise.all([
          client.query(`SELECT COUNT(*)::bigint AS total, COUNT(*) FILTER (WHERE last_seen_at >= NOW() - INTERVAL '24 hours')::bigint AS seen_24h, COUNT(*) FILTER (WHERE cached_rd IS TRUE OR tb_cached IS TRUE)::bigint AS cached FROM torrents`),
          client.query(`SELECT COUNT(*)::bigint AS total, COUNT(*) FILTER (WHERE expires_at > NOW())::bigint AS fresh, COALESCE(SUM(hit_count),0)::bigint AS hits FROM shared_stream_cache`),
          client.query(`SELECT service, state, cached, COUNT(*)::bigint AS total FROM debrid_availability_cache WHERE expires_at > NOW() GROUP BY service, state, cached ORDER BY service, total DESC LIMIT 50`),
          client.query(`SELECT service, COUNT(*)::bigint AS total, COUNT(*) FILTER (WHERE expires_at > NOW())::bigint AS fresh, MAX(last_seen_at) AS last_seen_at FROM debrid_account_snapshots GROUP BY service ORDER BY service`),
          client.query(`SELECT COUNT(*)::bigint AS total, MAX(created_at) AS latest FROM torrent_rank_history WHERE created_at >= NOW() - INTERVAL '30 days'`),
          client.query(`SELECT * FROM cache_maintenance_history ORDER BY started_at DESC LIMIT 5`)
        ]);

        return {
          torrents: torrentRows.rows[0] || {},
          sharedStreamCache: streamRows.rows[0] || {},
          debridAvailability: debridRows.rows || [],
          savedCloudSnapshots: savedRows.rows || [],
          rankHistory: rankRows.rows[0] || {},
          maintenance: maintenanceRows.rows || []
        };
      });
    } catch (error) {
      console.error(`❌ DB Error getPostgresCacheOverview: ${error.message}`);
      return { error: error.message };
    }
  }

  async function runCacheMaintenance(options = {}) {
    if (!getPool()) return { ok: false, reason: 'db_not_initialized' };
    await awaitDatabaseOptimizations();

    const runId = makeKey(['maintenance', process.pid, Date.now(), Math.random()]);
    const historyTtlDays = Math.max(1, Math.min(365, safeInt(options.historyTtlDays || process.env.POSTGRES_HISTORY_TTL_DAYS, 30)));

    try {
      return await withClient(async (client) => {
        await client.query(`INSERT INTO cache_maintenance_history (run_id, started_at, status) VALUES ($1, NOW(), 'running') ON CONFLICT (run_id) DO NOTHING`, [runId]);

        const deletedShared = await client.query(`DELETE FROM shared_stream_cache WHERE stale_until IS NOT NULL AND stale_until < NOW()`);
        const deletedExternal = await client.query(`DELETE FROM external_stream_snapshots WHERE expires_at IS NOT NULL AND expires_at < NOW()`);
        const deletedAvailability = await client.query(`DELETE FROM debrid_availability_cache WHERE expires_at IS NOT NULL AND expires_at < NOW()`);
        const deletedLinks = await client.query(`DELETE FROM debrid_resolved_link_cache WHERE expires_at IS NOT NULL AND expires_at < NOW()`);
        const deletedCloud = await client.query(`DELETE FROM debrid_account_snapshots WHERE expires_at IS NOT NULL AND expires_at < NOW()`);
        const deletedRank = await client.query(`DELETE FROM torrent_rank_history WHERE created_at < NOW() - ($1::int * INTERVAL '1 day')`, [historyTtlDays]);

        const payload = {
          historyTtlDays,
          deleted: {
            sharedStreamCache: deletedShared.rowCount || 0,
            externalSnapshots: deletedExternal.rowCount || 0,
            debridAvailability: deletedAvailability.rowCount || 0,
            debridLinks: deletedLinks.rowCount || 0,
            savedCloudSnapshots: deletedCloud.rowCount || 0,
            rankHistory: deletedRank.rowCount || 0
          }
        };

        await client.query(
          `UPDATE cache_maintenance_history
           SET finished_at = NOW(), status = 'ok', deleted_shared_stream_cache = $2, deleted_external_snapshots = $3,
               deleted_debrid_availability = $4, deleted_debrid_links = $5, deleted_saved_cloud_snapshots = $6,
               deleted_rank_history = $7, payload_json = $8::jsonb
           WHERE run_id = $1`,
          [runId, payload.deleted.sharedStreamCache, payload.deleted.externalSnapshots, payload.deleted.debridAvailability,
            payload.deleted.debridLinks, payload.deleted.savedCloudSnapshots, payload.deleted.rankHistory, safeJson(payload)]
        );

        return { ok: true, runId, ...payload };
      });
    } catch (error) {
      try {
        await withClient((client) => client.query(
          `UPDATE cache_maintenance_history SET finished_at = NOW(), status = 'error', error = $2 WHERE run_id = $1`,
          [runId, error.message]
        ));
      } catch (_) {}
      console.error(`❌ DB Error runCacheMaintenance: ${error.message}`);
      return { ok: false, runId, error: error.message };
    }
  }

  return {
    getPostgresCacheOverview,
    recordTorrentRankHistory,
    runCacheMaintenance
  };
}

module.exports = {
  createCacheRepository
};
