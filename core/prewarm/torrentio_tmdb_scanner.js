'use strict';

const axios = require('axios');
const { fetchTorrentioFlat } = require('../nexus-bridge/torrentio');

const HARDCODED_TMDB_API_KEY = '5bae8d11f2a7bc7a95c6d040a31d2163';
const HARDCODED_TORRENTIO_SCAN = Object.freeze({
    enabled: true,
    leaderOnly: true,
    language: 'it-IT',
    region: 'IT',
    startDelayMs: 25 * 1000,
    catalogIntervalMs: 24 * 3600 * 1000,
    workerIntervalMs: 2500,
    retrySeconds: 1800,
    refreshSeconds: 7 * 24 * 3600,
    maxAttempts: 12,
    requestTimeoutMs: 15000,
    torrentioTimeoutMs: 12000,
    moviePages: 30,
    seriesPages: 10,
    movieEndpoints: ['popular', 'top_rated', 'now_playing', 'upcoming'],
    seriesEndpoints: ['popular', 'top_rated', 'on_the_air', 'airing_today'],
    seriesMode: 'episodes',
    maxSeasonsPerSeries: 10,
    maxEpisodesPerSeries: 90,
    pageDelayMs: 1000,
    itemDelayMs: 80,
    priority: 20,
    onlyItalian: true,
    minimumItalianConfidence: 35,
    externalSnapshotTtlSeconds: 30 * 24 * 3600,
    enabledAddons: ['torrentio_main', 'torrentio_mirror'],
    options: '',
    saveEmptyCompleted: true
});

function clampInt(value, fallback, min, max) {
    const parsed = parseInt(value, 10);
    const normalized = Number.isFinite(parsed) ? parsed : fallback;
    return Math.max(min, Math.min(max, normalized));
}

function clampFloat(value, fallback, min, max) {
    const parsed = Number(value);
    const normalized = Number.isFinite(parsed) ? parsed : fallback;
    return Math.max(min, Math.min(max, normalized));
}

function readBoolean(value, fallback = false) {
    if (typeof value === 'boolean') return value;
    const normalized = String(value ?? '').trim().toLowerCase();
    if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
    if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
    return fallback;
}

function splitList(value, fallback = '') {
    return String(value || fallback)
        .split(',')
        .map((item) => item.trim().toLowerCase())
        .filter(Boolean);
}

function nowIso() {
    return new Date().toISOString();
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

function normalizeImdbId(value) {
    const normalized = String(value || '').trim().toLowerCase();
    return /^tt\d+$/.test(normalized) ? normalized : '';
}

function normalizeInfoHash(value) {
    const normalized = String(value || '').trim().toLowerCase();
    return /^[a-f0-9]{40}$/.test(normalized) ? normalized : '';
}

function normalizeMediaId(mediaType, imdbId, season = null, episode = null) {
    const cleanImdb = normalizeImdbId(imdbId);
    if (!cleanImdb) return '';
    if (mediaType === 'series') {
        const s = Number(season || 0);
        const e = Number(episode || 0);
        if (Number.isInteger(s) && s > 0 && Number.isInteger(e) && e > 0) return `${cleanImdb}:${s}:${e}`;
    }
    return cleanImdb;
}

function parseMediaId(value = '') {
    const parts = String(value || '').trim().toLowerCase().split(':');
    const imdbId = normalizeImdbId(parts[0]);
    const season = Number.parseInt(parts[1], 10);
    const episode = Number.parseInt(parts[2], 10);
    return {
        imdbId,
        season: Number.isInteger(season) && season > 0 ? season : null,
        episode: Number.isInteger(episode) && episode > 0 ? episode : null
    };
}

function validMovieEndpoint(value) {
    const clean = String(value || '').trim().toLowerCase();
    return ['popular', 'top_rated', 'now_playing', 'upcoming'].includes(clean) ? clean : '';
}

function validSeriesEndpoint(value) {
    const clean = String(value || '').trim().toLowerCase();
    return ['popular', 'top_rated', 'on_the_air', 'airing_today'].includes(clean) ? clean : '';
}

function createScannerConfig() {
    return {
        ...HARDCODED_TORRENTIO_SCAN,
        tmdbApiKey: HARDCODED_TMDB_API_KEY,
        movieEndpoints: HARDCODED_TORRENTIO_SCAN.movieEndpoints.map(validMovieEndpoint).filter(Boolean),
        seriesEndpoints: HARDCODED_TORRENTIO_SCAN.seriesEndpoints.map(validSeriesEndpoint).filter(Boolean),
        enabledAddons: [...HARDCODED_TORRENTIO_SCAN.enabledAddons]
    };
}

function buildBackgroundUserConfig() {
    const service = String(process.env.TORRENTIO_SCAN_SERVICE || process.env.DEBRID_SERVICE || 'rd').trim().toLowerCase();
    if (service === 'tb') {
        const key = String(process.env.TORRENTIO_SCAN_TB_API_KEY || process.env.TORBOX_API_KEY || process.env.TB_API_KEY || '').trim();
        return key ? { service: 'tb', tb: key, torbox: key, key } : { service: 'tb' };
    }
    const key = String(process.env.TORRENTIO_SCAN_RD_API_KEY || process.env.REALDEBRID_API_KEY || process.env.RD_API_KEY || '').trim();
    return key ? { service: 'rd', rd: key, realdebrid: key, key } : { service: 'rd' };
}

function sanitizePayloadForDb(item = {}) {
    const payload = { ...item };
    for (const key of ['url', 'directUrl', 'externalDirectUrl', '_externalDirectUrl', '_torrentioPlayableUrl', 'externalPlayableUrl']) {
        if (payload[key] && /^https?:\/\//i.test(String(payload[key]))) payload[key] = '__redacted_runtime_url__';
    }
    return payload;
}

function createTorrentRow(item = {}, meta = {}, type = 'movie') {
    const infoHash = normalizeInfoHash(item.hash || item.infoHash || item.info_hash);
    if (!infoHash) return null;
    return {
        info_hash: infoHash,
        title: item.title || item.name || item.filename || item.file_title || infoHash,
        size: item._size || item.sizeBytes || item.mainFileSize || item.fileSize || item.file_size || item.size || 0,
        seeders: item.seeders || 0,
        provider: item.source || item.externalProvider || item.provider || 'Torrentio',
        torrent_id: item.torrentId || item.torrent_id || item.id || undefined,
        type,
        trackers: item.trackers || item.sources || undefined,
        languages: item.languages || item.language || item.audio || item._languages || undefined,
        resolution: item.resolution || item.quality || undefined,
        quality: item.quality || item.sourceQuality || item.quality_tag || undefined,
        codec: item.codec || item.codec_tag || item.videoCodec || item.encode || undefined,
        hdr: item.hdr || item.hdr_tag || item.visualTag || item.visualTags || undefined,
        audio: item.audio || item.audio_tag || item.audioTag || item.audioTags || undefined,
        releaseGroup: item.releaseGroup || item.release_group || item.group || item.uploader || undefined,
        filename: item.filename || item.fileName || item.file_name || item.file_title || item.behaviorHints?.filename || undefined,
        fileName: item.fileName || item.filename || item.file_name || item.file_title || undefined,
        folderSize: item.folderSize || item.folder_size || item.totalPackSize || item.packSize || item.behaviorHints?.folderSize || undefined,
        behaviorHints: item.behaviorHints || undefined,
        episodeFileHint: item.episodeFileHint || item._episodeFileHint || undefined,
        season: meta?.season || item.season || item.imdb_season || undefined,
        episode: meta?.episode || item.episode || item.imdb_episode || undefined,
        isSeries: type === 'series',
        file_index: item.fileIdx !== undefined ? item.fileIdx : (item.fileIndex !== undefined ? item.fileIndex : item.file_index)
    };
}

function createScannerStats() {
    return {
        enabled: 0,
        started: 0,
        runningCatalog: 0,
        runningWorker: 0,
        catalogScans: 0,
        tmdbPages: 0,
        tmdbItems: 0,
        moviesSeen: 0,
        seriesSeen: 0,
        queuedMovies: 0,
        queuedSeriesRoots: 0,
        queuedEpisodes: 0,
        jobsClaimed: 0,
        jobsCompleted: 0,
        jobsFailed: 0,
        torrentioRequests: 0,
        torrentioResults: 0,
        dbTorrentsProcessed: 0,
        dbTorrentsInserted: 0,
        dbMappings: 0,
        dbSnapshotsProcessed: 0,
        dbSnapshotsUpserted: 0,
        emptyResults: 0,
        skippedNoImdb: 0,
        enqueueFailed: 0,
        lastCatalogStartedAt: null,
        lastCatalogFinishedAt: null,
        lastWorkerAt: null,
        lastError: ''
    };
}

function createTorrentioTmdbScanner({ dbHelper, logger, normalizeExternalCandidateForPipeline }) {
    const config = createScannerConfig();
    const stats = createScannerStats();
    stats.enabled = config.enabled ? 1 : 0;

    let stopRequested = false;
    let catalogTimer = null;
    let workerTimer = null;
    let manualCatalogPromise = null;
    let workerLoopPromise = null;

    function logInfo(message) {
        if (logger && typeof logger.info === 'function') logger.info(message);
        else console.log(message);
    }

    function logWarn(message) {
        if (logger && typeof logger.warn === 'function') logger.warn(message);
        else console.warn(message);
    }

    function pool() {
        return dbHelper && typeof dbHelper.getPool === 'function' ? dbHelper.getPool() : null;
    }

    async function query(sql, params = []) {
        const currentPool = pool();
        if (!currentPool) throw new Error('database pool not initialized');
        return currentPool.query(sql, params);
    }

    let queueSchemaPromise = null;

    async function ensureQueueSchema() {
        if (queueSchemaPromise) return queueSchemaPromise;
        queueSchemaPromise = (async () => {
            await query(`CREATE TABLE IF NOT EXISTS torrentio_tmdb_scan_queue (
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
            )`);

            const alterStatements = [
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
                `ALTER TABLE torrentio_tmdb_scan_queue ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW()`
            ];

            for (const sql of alterStatements) {
                await query(sql);
            }

            await query(`CREATE UNIQUE INDEX IF NOT EXISTS uq_torrentio_tmdb_scan_queue_job_key ON torrentio_tmdb_scan_queue (job_key)`);
            await query(`CREATE INDEX IF NOT EXISTS idx_torrentio_tmdb_scan_queue_next ON torrentio_tmdb_scan_queue (state, not_before, priority DESC, updated_at ASC)`);
            await query(`CREATE INDEX IF NOT EXISTS idx_torrentio_tmdb_scan_queue_media ON torrentio_tmdb_scan_queue (media_type, imdb_id, imdb_season, imdb_episode)`);
            await query(`CREATE INDEX IF NOT EXISTS idx_torrentio_tmdb_scan_queue_tmdb ON torrentio_tmdb_scan_queue (tmdb_id, tmdb_endpoint)`);
        })().catch((error) => {
            queueSchemaPromise = null;
            throw error;
        });
        return queueSchemaPromise;
    }

    async function enqueueJob(job = {}) {
        await ensureQueueSchema();
        const imdbId = normalizeImdbId(job.imdbId || job.imdb_id);
        if (!imdbId) {
            stats.skippedNoImdb += 1;
            return false;
        }
        const mediaType = job.mediaType === 'series' ? 'series' : 'movie';
        const season = Number.isInteger(Number(job.season)) && Number(job.season) > 0 ? Number(job.season) : null;
        const episode = Number.isInteger(Number(job.episode)) && Number(job.episode) > 0 ? Number(job.episode) : null;
        const mediaId = normalizeMediaId(mediaType, imdbId, season, episode);
        if (!mediaId) return false;
        const options = String(job.options ?? config.options ?? '').trim();
        const jobKey = `${mediaType}:${mediaId}:${options}`;
        const priority = clampInt(job.priority, config.priority, 0, 100);
        try {
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
                    not_before = CASE
                      WHEN torrentio_tmdb_scan_queue.state <> 'running' AND torrentio_tmdb_scan_queue.not_before <= NOW() THEN LEAST(torrentio_tmdb_scan_queue.not_before, EXCLUDED.not_before)
                      ELSE torrentio_tmdb_scan_queue.not_before
                    END,
                    updated_at = NOW()
                `,
                [jobKey, mediaType, mediaId, imdbId, season, episode, job.tmdbId || null, job.tmdbEndpoint || '', options, priority]
            );
            return true;
        } catch (error) {
            stats.enqueueFailed += 1;
            stats.lastError = error.message;
            logWarn(`[TORRENTIO TMDB SCAN] enqueue failed ${mediaType}/${mediaId}: ${error.message}`);
            return false;
        }
    }

    async function claimJob() {
        await ensureQueueSchema();
        const res = await query(
            `
              WITH next_job AS (
                SELECT job_key
                FROM torrentio_tmdb_scan_queue
                WHERE state IN ('queued', 'failed')
                  AND not_before <= NOW()
                  AND attempts < $1
                ORDER BY priority DESC, updated_at ASC
                LIMIT 1
                FOR UPDATE SKIP LOCKED
              )
              UPDATE torrentio_tmdb_scan_queue q
              SET state = 'running',
                  attempts = q.attempts + 1,
                  not_before = NOW() + make_interval(secs => $2),
                  updated_at = NOW()
              FROM next_job
              WHERE q.job_key = next_job.job_key
              RETURNING q.*
            `,
            [config.maxAttempts, config.retrySeconds]
        );
        return res.rows?.[0] || null;
    }

    async function completeJob(jobKey, resultCount, savedCount) {
        await query(
            `
              UPDATE torrentio_tmdb_scan_queue
              SET state = 'completed',
                  last_error = '',
                  last_result_count = $2,
                  last_saved_count = $3,
                  not_before = NOW() + make_interval(secs => $4),
                  updated_at = NOW()
              WHERE job_key = $1
            `,
            [jobKey, resultCount, savedCount, config.refreshSeconds]
        );
    }

    async function failJob(jobKey, error) {
        await query(
            `
              UPDATE torrentio_tmdb_scan_queue
              SET state = 'failed',
                  last_error = $2,
                  not_before = NOW() + make_interval(secs => $3),
                  updated_at = NOW()
              WHERE job_key = $1
            `,
            [jobKey, String(error || '').slice(0, 500), config.retrySeconds]
        );
    }

    async function tmdbGet(path, params = {}) {
        if (!config.tmdbApiKey) return {};
        const response = await axios.get(`https://api.themoviedb.org/3${path}`, {
            params: {
                api_key: config.tmdbApiKey,
                language: config.language,
                ...params
            },
            timeout: config.requestTimeoutMs,
            validateStatus: (status) => status >= 200 && status < 300
        });
        return response.data && typeof response.data === 'object' ? response.data : {};
    }

    async function tmdbPageItems(mediaKind, endpoint, page) {
        const path = `/${mediaKind}/${endpoint}`;
        const params = { page };
        if (mediaKind === 'movie') params.region = config.region;
        const data = await tmdbGet(path, params);
        const results = Array.isArray(data.results) ? data.results.filter((item) => item && typeof item === 'object') : [];
        stats.tmdbPages += 1;
        stats.tmdbItems += results.length;
        return results;
    }

    async function movieImdbId(tmdbId) {
        const data = await tmdbGet(`/movie/${tmdbId}`, { append_to_response: 'external_ids' });
        const fromRoot = normalizeImdbId(data.imdb_id);
        if (fromRoot) return fromRoot;
        return normalizeImdbId(data.external_ids?.imdb_id);
    }

    async function seriesDetails(tmdbId) {
        const data = await tmdbGet(`/tv/${tmdbId}`, { append_to_response: 'external_ids' });
        const imdbId = normalizeImdbId(data.external_ids?.imdb_id || data.imdb_id);
        if (!imdbId) return { imdbId: '', seasons: [] };
        let seasons = Array.isArray(data.seasons) ? data.seasons
            .map((season) => ({
                season: Number.parseInt(season?.season_number, 10),
                episodes: Number.parseInt(season?.episode_count, 10)
            }))
            .filter((season) => Number.isInteger(season.season) && season.season > 0 && Number.isInteger(season.episodes) && season.episodes > 0)
            .sort((left, right) => left.season - right.season) : [];
        if (config.maxSeasonsPerSeries > 0) seasons = seasons.slice(0, config.maxSeasonsPerSeries);
        return { imdbId, seasons };
    }

    async function scanMovies() {
        const seen = new Set();
        for (const endpoint of config.movieEndpoints) {
            for (let page = 1; page <= config.moviePages && !stopRequested; page += 1) {
                const items = await tmdbPageItems('movie', endpoint, page);
                if (!items.length) break;
                for (const item of items) {
                    const tmdbId = Number.parseInt(item.id, 10);
                    if (!Number.isInteger(tmdbId) || tmdbId <= 0 || seen.has(tmdbId)) continue;
                    seen.add(tmdbId);
                    stats.moviesSeen += 1;
                    try {
                        const imdbId = await movieImdbId(tmdbId);
                        if (!imdbId) {
                            stats.skippedNoImdb += 1;
                        } else if (await enqueueJob({ mediaType: 'movie', imdbId, tmdbId, tmdbEndpoint: endpoint, priority: config.priority })) {
                            stats.queuedMovies += 1;
                        }
                    } catch (error) {
                        stats.lastError = `movie:${tmdbId}:${error.message}`;
                        logWarn(`[TORRENTIO TMDB SCAN] movie tmdb=${tmdbId} skipped: ${error.message}`);
                    }
                    if (config.itemDelayMs) await sleep(config.itemDelayMs);
                }
                if (config.pageDelayMs) await sleep(config.pageDelayMs);
            }
        }
    }

    async function scanSeries() {
        const seen = new Set();
        const enqueueRoots = ['root', 'both', 'all'].includes(config.seriesMode);
        const enqueueEpisodes = ['episodes', 'both', 'all'].includes(config.seriesMode);
        for (const endpoint of config.seriesEndpoints) {
            for (let page = 1; page <= config.seriesPages && !stopRequested; page += 1) {
                const items = await tmdbPageItems('tv', endpoint, page);
                if (!items.length) break;
                for (const item of items) {
                    const tmdbId = Number.parseInt(item.id, 10);
                    if (!Number.isInteger(tmdbId) || tmdbId <= 0 || seen.has(tmdbId)) continue;
                    seen.add(tmdbId);
                    stats.seriesSeen += 1;
                    try {
                        const details = await seriesDetails(tmdbId);
                        if (!details.imdbId) {
                            stats.skippedNoImdb += 1;
                            continue;
                        }
                        if (enqueueRoots && await enqueueJob({ mediaType: 'series', imdbId: details.imdbId, tmdbId, tmdbEndpoint: endpoint, priority: config.priority })) {
                            stats.queuedSeriesRoots += 1;
                        }
                        if (enqueueEpisodes) {
                            let queuedForSeries = 0;
                            for (const season of details.seasons) {
                                for (let episode = 1; episode <= season.episodes; episode += 1) {
                                    if (config.maxEpisodesPerSeries > 0 && queuedForSeries >= config.maxEpisodesPerSeries) break;
                                    const ok = await enqueueJob({
                                        mediaType: 'series',
                                        imdbId: details.imdbId,
                                        season: season.season,
                                        episode,
                                        tmdbId,
                                        tmdbEndpoint: endpoint,
                                        priority: Math.max(0, config.priority - 2)
                                    });
                                    if (ok) stats.queuedEpisodes += 1;
                                    queuedForSeries += 1;
                                    if (config.itemDelayMs) await sleep(config.itemDelayMs);
                                }
                                if (config.maxEpisodesPerSeries > 0 && queuedForSeries >= config.maxEpisodesPerSeries) break;
                            }
                        }
                    } catch (error) {
                        stats.lastError = `series:${tmdbId}:${error.message}`;
                        logWarn(`[TORRENTIO TMDB SCAN] series tmdb=${tmdbId} skipped: ${error.message}`);
                    }
                    if (config.itemDelayMs) await sleep(config.itemDelayMs);
                }
                if (config.pageDelayMs) await sleep(config.pageDelayMs);
            }
        }
    }

    async function runCatalogScan(reason = 'scheduled') {
        if (!config.enabled || !config.tmdbApiKey) return getStatus();
        if (stats.runningCatalog) return getStatus();
        stats.runningCatalog = 1;
        stats.lastCatalogStartedAt = nowIso();
        logInfo(`[TORRENTIO TMDB SCAN] catalog scan started reason=${reason} moviePages=${config.moviePages} seriesPages=${config.seriesPages}`);
        try {
            if (config.moviePages > 0) await scanMovies();
            if (config.seriesPages > 0) await scanSeries();
            stats.catalogScans += 1;
            stats.lastError = '';
        } catch (error) {
            stats.lastError = error.message;
            logWarn(`[TORRENTIO TMDB SCAN] catalog scan failed: ${error.message}`);
        } finally {
            stats.runningCatalog = 0;
            stats.lastCatalogFinishedAt = nowIso();
            logInfo(`[TORRENTIO TMDB SCAN] catalog scan finished queuedMovies=${stats.queuedMovies} queuedEpisodes=${stats.queuedEpisodes} errors=${stats.enqueueFailed}`);
        }
        return getStatus();
    }

    async function saveTorrentioResults(job, normalizedItems) {
        const type = String(job.media_type || '').toLowerCase() === 'series' ? 'series' : 'movie';
        const parsed = parseMediaId(job.media_id);
        const meta = {
            imdb_id: normalizeImdbId(job.imdb_id || parsed.imdbId),
            type,
            contentType: type,
            isSeries: type === 'series',
            season: Number.isInteger(Number(job.imdb_season)) && Number(job.imdb_season) > 0 ? Number(job.imdb_season) : parsed.season,
            episode: Number.isInteger(Number(job.imdb_episode)) && Number(job.imdb_episode) > 0 ? Number(job.imdb_episode) : parsed.episode
        };

        const pipelineItems = [];
        for (const item of normalizedItems) {
            const enriched = {
                ...item,
                _externalIdMatched: true,
                _externalBatch: 'tmdb-background-scan',
                externalGroup: item.externalGroup || 'torrentio',
                externalAddon: item.externalAddon || 'torrentio_main'
            };
            const normalized = typeof normalizeExternalCandidateForPipeline === 'function'
                ? normalizeExternalCandidateForPipeline(enriched, {
                    type,
                    meta,
                    langMode: config.onlyItalian ? 'ita' : 'all',
                    config: { service: buildBackgroundUserConfig().service }
                })
                : enriched;
            if (normalized) {
                const languageInfo = normalized.languageInfo && typeof normalized.languageInfo === 'object' ? normalized.languageInfo : {};
                const subOnly = Boolean(languageInfo.hasSubItalian && !languageInfo.hasAudioItalian);
                pipelineItems.push({
                    ...normalized,
                    isItalian: true,
                    hasItalianAudio: !subOnly,
                    hasItalianSubs: Boolean(languageInfo.hasSubItalian),
                    languages: ['Italian'],
                    language: 'ita',
                    audio: subOnly ? '🇮🇹 SUB-ITA' : '🇮🇹 ITA',
                    languageInfo: {
                        ...languageInfo,
                        isItalian: true,
                        hasAudioItalian: !subOnly,
                        hasSubItalian: Boolean(languageInfo.hasSubItalian),
                        displayLabel: subOnly ? '🇮🇹 SUB-ITA' : '🇮🇹',
                        detectedLanguages: ['Italian'],
                        confidence: Math.max(Number(languageInfo.confidence || 0) || 0, subOnly ? 36 : 98),
                        reason: languageInfo.reason && languageInfo.reason !== 'none' ? `forced_ita_scan|${languageInfo.reason}` : 'forced_ita_scan'
                    },
                    payload_json: undefined
                });
            }
        }

        const torrentRows = pipelineItems.map((item) => createTorrentRow(item, meta, type)).filter(Boolean);
        const snapshotRows = pipelineItems.map((item) => sanitizePayloadForDb({
            ...item,
            isExternal: true,
            _sourceGroup: 'external',
            externalGroup: item.externalGroup || 'torrentio',
            externalAddon: item.externalAddon || 'torrentio_main'
        }));

        let processed = 0;
        let inserted = 0;
        let mapped = 0;
        let snapshotProcessed = 0;
        let snapshotUpserted = 0;

        if (torrentRows.length > 0 && typeof dbHelper.insertTorrentsBatch === 'function') {
            const outcome = await dbHelper.insertTorrentsBatch(meta, torrentRows);
            processed = Number(outcome?.processed || 0);
            inserted = Number(outcome?.inserted || 0);
            mapped = Number(outcome?.mapped || 0);
        }

        if (snapshotRows.length > 0 && typeof dbHelper.upsertExternalStreamSnapshots === 'function') {
            const outcome = await dbHelper.upsertExternalStreamSnapshots(meta, snapshotRows, {
                type,
                ttlSeconds: config.externalSnapshotTtlSeconds
            });
            snapshotProcessed = Number(outcome?.processed || 0);
            snapshotUpserted = Number(outcome?.upserted || 0);
        }

        stats.dbTorrentsProcessed += processed;
        stats.dbTorrentsInserted += inserted;
        stats.dbMappings += mapped;
        stats.dbSnapshotsProcessed += snapshotProcessed;
        stats.dbSnapshotsUpserted += snapshotUpserted;

        return { meta, processed, inserted, mapped, snapshotProcessed, snapshotUpserted, saved: processed + snapshotProcessed };
    }

    async function processJob(job) {
        const type = String(job.media_type || '').toLowerCase() === 'series' ? 'series' : 'movie';
        const mediaId = String(job.media_id || '').trim();
        const userConfig = buildBackgroundUserConfig();
        stats.jobsClaimed += 1;
        stats.torrentioRequests += 1;

        const results = await Promise.race([
            fetchTorrentioFlat(type, mediaId, {
                enabledAddons: config.enabledAddons,
                onlyItalian: config.onlyItalian,
                languageMode: config.onlyItalian ? 'ita' : 'all',
                minimumItalianConfidence: config.minimumItalianConfidence,
                userConfig
            }),
            new Promise((_, reject) => setTimeout(() => reject(new Error('torrentio scan timeout')), config.torrentioTimeoutMs))
        ]);

        const clean = Array.isArray(results) ? results.filter(Boolean) : [];
        stats.torrentioResults += clean.length;
        if (clean.length === 0) stats.emptyResults += 1;

        const saveOutcome = clean.length > 0 ? await saveTorrentioResults(job, clean) : { saved: 0 };
        if (clean.length > 0 || config.saveEmptyCompleted) {
            await completeJob(job.job_key, clean.length, saveOutcome.saved || 0);
            stats.jobsCompleted += 1;
        } else {
            await failJob(job.job_key, 'empty torrentio response');
            stats.jobsFailed += 1;
        }

        stats.lastWorkerAt = nowIso();
        logInfo(`[TORRENTIO TMDB SCAN] saved type=${type} id=${mediaId} results=${clean.length} dbProcessed=${saveOutcome.processed || 0} snapshots=${saveOutcome.snapshotProcessed || 0}`);
    }

    async function runWorkerTick() {
        if (!config.enabled || stats.runningWorker) return;
        stats.runningWorker = 1;
        try {
            const job = await claimJob();
            if (job) await processJob(job);
        } catch (error) {
            stats.lastError = error.message;
            logWarn(`[TORRENTIO TMDB SCAN] worker failed: ${error.message}`);
        } finally {
            stats.runningWorker = 0;
        }
    }

    async function workerLoop() {
        while (!stopRequested) {
            await runWorkerTick();
            await sleep(config.workerIntervalMs);
        }
    }

    function scheduleCatalogLoop() {
        const firstDelay = config.startDelayMs;
        catalogTimer = setTimeout(() => {
            if (stopRequested) return;
            runCatalogScan('startup').catch(() => {});
            catalogTimer = setInterval(() => {
                runCatalogScan('scheduled').catch(() => {});
            }, config.catalogIntervalMs);
            if (typeof catalogTimer.unref === 'function') catalogTimer.unref();
        }, firstDelay);
        if (typeof catalogTimer.unref === 'function') catalogTimer.unref();
    }

    function start({ leader = true } = {}) {
        if (!config.enabled) {
            logInfo('[TORRENTIO TMDB SCAN] disabled by TORRENTIO_SCAN_ENABLED=false');
            return false;
        }
        if (config.leaderOnly && !leader) {
            logInfo('[TORRENTIO TMDB SCAN] skipped on non-leader worker');
            return false;
        }
        if (!config.tmdbApiKey) {
            stats.lastError = 'TMDB_API_KEY missing';
            logWarn('[TORRENTIO TMDB SCAN] TMDB_API_KEY missing: scanner not started');
            return false;
        }
        if (!pool()) {
            stats.lastError = 'database pool not initialized';
            logWarn('[TORRENTIO TMDB SCAN] database pool missing: scanner not started');
            return false;
        }
        if (stats.started) return true;
        stopRequested = false;
        stats.started = 1;
        ensureQueueSchema()
            .then(() => {
                if (stopRequested) return;
                scheduleCatalogLoop();
                workerLoopPromise = workerLoop().catch((error) => {
                    stats.lastError = error.message;
                    logWarn(`[TORRENTIO TMDB SCAN] worker loop stopped: ${error.message}`);
                });
                logInfo(`[TORRENTIO TMDB SCAN] started interval=${Math.round(config.catalogIntervalMs / 1000)}s worker=${Math.round(config.workerIntervalMs)}ms onlyItalian=${config.onlyItalian}`);
            })
            .catch((error) => {
                stats.started = 0;
                stats.lastError = error.message;
                logWarn(`[TORRENTIO TMDB SCAN] schema bootstrap failed: ${error.message}`);
            });
        return true;
    }

    async function stop() {
        stopRequested = true;
        if (catalogTimer) {
            clearTimeout(catalogTimer);
            clearInterval(catalogTimer);
            catalogTimer = null;
        }
        if (workerTimer) {
            clearInterval(workerTimer);
            workerTimer = null;
        }
        if (workerLoopPromise) {
            await Promise.race([workerLoopPromise, sleep(1500)]).catch(() => {});
            workerLoopPromise = null;
        }
        stats.started = 0;
    }

    async function trigger(reason = 'manual') {
        if (manualCatalogPromise) return false;
        manualCatalogPromise = runCatalogScan(reason).finally(() => {
            manualCatalogPromise = null;
        });
        return true;
    }

    async function queueStatus() {
        try {
            await ensureQueueSchema();
            const res = await query(
                `
                  SELECT state, COUNT(*)::bigint AS total
                  FROM torrentio_tmdb_scan_queue
                  GROUP BY state
                `
            );
            return Object.fromEntries((res.rows || []).map((row) => [String(row.state || 'unknown'), Number(row.total || 0)]));
        } catch (error) {
            return { error: error.message };
        }
    }

    async function getStatus() {
        return {
            ok: true,
            timestamp: nowIso(),
            config: {
                enabled: config.enabled,
                tmdbConfigured: Boolean(config.tmdbApiKey),
                moviePages: config.moviePages,
                seriesPages: config.seriesPages,
                movieEndpoints: config.movieEndpoints,
                seriesEndpoints: config.seriesEndpoints,
                seriesMode: config.seriesMode,
                onlyItalian: config.onlyItalian,
                enabledAddons: config.enabledAddons,
                refreshSeconds: config.refreshSeconds,
                retrySeconds: config.retrySeconds
            },
            stats: { ...stats },
            queue: await queueStatus()
        };
    }

    return {
        start,
        stop,
        trigger,
        getStatus,
        enqueueJob,
        ensureQueueSchema,
        runCatalogScan
    };
}

module.exports = {
    createTorrentioTmdbScanner
};
