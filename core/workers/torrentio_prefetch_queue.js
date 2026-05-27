'use strict';

const dbHelper = require('../storage/db_repository');

const RECENT_QUEUE_TTL_MS = Math.max(30_000, parseInt(process.env.TORRENTIO_PREFETCH_RECENT_TTL_MS || String(10 * 60 * 1000), 10) || (10 * 60 * 1000));
const recent = new Map();
let ensurePromise = null;

function envFlag(name, fallback = false) {
  const raw = process.env[name];
  if (raw === undefined || raw === null || raw === '') return fallback;
  return /^(1|true|yes|y|on)$/i.test(String(raw).trim());
}

function shouldDeferLiveScrapeToWorker(config = {}) {
  const filters = config?.filters || {};
  if (filters.deferLiveScrapeToWorker !== undefined) return filters.deferLiveScrapeToWorker === true;
  return envFlag('LEVIATHAN_DEFER_LIVE_SCRAPE_TO_WORKER', false);
}

function normalizeImdbId(value) {
  const normalized = String(value || '').trim().toLowerCase();
  return /^tt\d+$/.test(normalized) ? normalized : '';
}

function normalizeMediaType(value, meta = {}) {
  const type = String(value || '').toLowerCase();
  if (type === 'series' || meta?.isSeries || meta?.season || meta?.episode) return 'series';
  return 'movie';
}

function normalizeMediaId(mediaType, imdbId, season = null, episode = null) {
  if (!imdbId) return '';
  if (mediaType === 'series') {
    const s = Number(season || 0);
    const e = Number(episode || 0);
    if (Number.isInteger(s) && s > 0 && Number.isInteger(e) && e > 0) return `${imdbId}:${s}:${e}`;
    return '';
  }
  return imdbId;
}

function getPool() {
  return typeof dbHelper.getPool === 'function' ? dbHelper.getPool() : null;
}

async function query(sql, params = []) {
  const pool = getPool();
  if (!pool) return null;
  return pool.query(sql, params);
}

async function ensureQueueSchema() {
  if (ensurePromise) return ensurePromise;
  ensurePromise = (async () => {
    await query(`
      CREATE TABLE IF NOT EXISTS torrentio_tmdb_scan_queue (
        job_key TEXT PRIMARY KEY,
        media_type TEXT NOT NULL,
        media_id TEXT NOT NULL,
        imdb_id TEXT NOT NULL,
        imdb_season INTEGER,
        imdb_episode INTEGER,
        tmdb_id INTEGER,
        tmdb_endpoint TEXT DEFAULT '',
        options TEXT DEFAULT '',
        priority INTEGER DEFAULT 50,
        state TEXT DEFAULT 'queued',
        not_before TIMESTAMPTZ DEFAULT NOW(),
        attempts INTEGER DEFAULT 0,
        last_error TEXT DEFAULT '',
        last_result_count INTEGER DEFAULT 0,
        last_saved_count INTEGER DEFAULT 0,
        first_seen_at TIMESTAMPTZ DEFAULT NOW(),
        last_seen_at TIMESTAMPTZ DEFAULT NOW(),
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await query(`CREATE UNIQUE INDEX IF NOT EXISTS uq_torrentio_tmdb_scan_queue_job_key ON torrentio_tmdb_scan_queue (job_key)`);
    await query(`CREATE INDEX IF NOT EXISTS idx_torrentio_tmdb_scan_queue_next ON torrentio_tmdb_scan_queue (state, not_before, priority DESC, updated_at ASC)`);
    await query(`CREATE INDEX IF NOT EXISTS idx_torrentio_tmdb_scan_queue_media ON torrentio_tmdb_scan_queue (media_type, imdb_id, imdb_season, imdb_episode)`);
  })().catch((error) => {
    ensurePromise = null;
    throw error;
  });
  return ensurePromise;
}

function shouldSkipRecent(jobKey) {
  const now = Date.now();
  for (const [key, ts] of recent) {
    if ((now - ts) > RECENT_QUEUE_TTL_MS) recent.delete(key);
  }
  const last = recent.get(jobKey);
  if (last && (now - last) < RECENT_QUEUE_TTL_MS) return true;
  recent.set(jobKey, now);
  return false;
}

async function queueTorrentioPrefetchJob({ type, finalId, meta = {}, tmdbId = null, options = '', priority = 80, reason = 'stream-miss', logger = null } = {}) {
  const imdbId = normalizeImdbId(meta?.imdb_id || finalId || meta?.id);
  const mediaType = normalizeMediaType(type, meta);
  const season = Number.isInteger(Number(meta?.season)) && Number(meta.season) > 0 ? Number(meta.season) : null;
  const episode = Number.isInteger(Number(meta?.episode)) && Number(meta.episode) > 0 ? Number(meta.episode) : null;
  const mediaId = normalizeMediaId(mediaType, imdbId, season, episode);
  if (!imdbId || !mediaId) return { queued: false, reason: 'missing_media_id' };

  const cleanOptions = String(options || '').trim();
  const jobKey = `${mediaType}:${mediaId}:${cleanOptions}`;
  if (shouldSkipRecent(jobKey)) return { queued: false, reason: 'recent', jobKey };

  try {
    if (!getPool()) return { queued: false, reason: 'pool_not_initialized', jobKey };
    await ensureQueueSchema();
    await query(
      `
        INSERT INTO torrentio_tmdb_scan_queue (
          job_key, media_type, media_id, imdb_id, imdb_season, imdb_episode,
          tmdb_id, tmdb_endpoint, options, priority, state, not_before,
          attempts, last_error, first_seen_at, last_seen_at, created_at, updated_at
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'queued', NOW(), 0, '', NOW(), NOW(), NOW(), NOW())
        ON CONFLICT (job_key)
        DO UPDATE SET
          priority = GREATEST(torrentio_tmdb_scan_queue.priority, EXCLUDED.priority),
          last_seen_at = NOW(),
          state = CASE
            WHEN torrentio_tmdb_scan_queue.state <> 'running' AND torrentio_tmdb_scan_queue.not_before <= NOW() THEN 'queued'
            ELSE torrentio_tmdb_scan_queue.state
          END,
          updated_at = NOW()
      `,
      [jobKey, mediaType, mediaId, imdbId, season, episode, tmdbId || null, reason, cleanOptions, Math.max(0, Math.min(100, Number(priority) || 80))]
    );
    if (logger && typeof logger.info === 'function') logger.info(`[WORKER QUEUE] queued Torrentio prefetch ${jobKey} reason=${reason}`);
    return { queued: true, jobKey };
  } catch (error) {
    if (logger && typeof logger.warn === 'function') logger.warn(`[WORKER QUEUE] enqueue failed ${jobKey}: ${error.message}`);
    return { queued: false, reason: error.message, jobKey };
  }
}

module.exports = {
  shouldDeferLiveScrapeToWorker,
  queueTorrentioPrefetchJob
};
