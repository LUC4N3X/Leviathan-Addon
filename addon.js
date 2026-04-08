require('dotenv').config();
const express = require("express");
const cors = require("cors");
const compression = require('compression');
const path = require("path");
const axios = require("axios");
const crypto = require("crypto");
const rateLimit = require("express-rate-limit");

const dbHelper = require("./core/storage/db_repository");
const { getManifest } = require("./manifest");
const { handleVixSynthetic } = require("./providers/streamingcommunity/vix_proxy");

const {
    logger, Cache, LIMITERS, CONFIG, ADMIN_PASS, cloudBuildInflight,
    safeCompare, getConfig, validateStreamRequest, withTimeout, buildTrackerMagnet,
    getStatsSnapshot, recordDuration, recordProviderMetric, incrementMetric
} = require("./core/utils");

const { generateStream, resolveLazyStreamData } = require("./core/stream_generator");

let rdCacheScannerBoot = { enabled: false, started: false, reason: 'disabled' };
let getRdCacheScannerStatus = () => ({ ...rdCacheScannerBoot });

dbHelper.initDatabase();

if (String(process.env.RD_CACHE_SCANNER_ENABLED || '').toLowerCase() === 'true') {
    try {
        const { startRdCacheScanner, getRdCacheScannerStatus: workerStatusGetter } = require('./core/workers/rd_cache_scanner');
        rdCacheScannerBoot = startRdCacheScanner({
            dbHelper,
            logger,
            onBatchUpdated: async ({ hashes }) => {
                if (Array.isArray(hashes) && hashes.length > 0) {
                    await Cache.invalidateStreamsByHashes(hashes, 'rd_scanner_batch');
                }
            }
        });
        if (typeof workerStatusGetter === 'function') getRdCacheScannerStatus = workerStatusGetter;
    } catch (err) {
        rdCacheScannerBoot = { enabled: true, started: false, reason: err.message || 'boot_error' };
        logger.error(`[RD SCANNER] Boot fallito: ${err.message}`);
    }
}

const app = express();
app.set('trust proxy', 1);
const RATE_LIMIT_WINDOW_MS = Math.max(60 * 1000, parseInt(process.env.RATE_LIMIT_WINDOW_MS || String(15 * 60 * 1000), 10) || (15 * 60 * 1000));
const RATE_LIMIT_MAX = Math.max(50, parseInt(process.env.RATE_LIMIT_MAX || "350", 10) || 350);

app.use(compression({
  filter: (req, res) => {
    if (req.headers['x-no-compression']) return false;
    return compression.filter(req, res);
  },
  level: 6
}));

const limiter = rateLimit({
    windowMs: RATE_LIMIT_WINDOW_MS,
    max: RATE_LIMIT_MAX,
    standardHeaders: true,
    legacyHeaders: false,
    message: "Troppe richieste da questo IP, riprova più tardi."
});
app.use(limiter);

app.use(cors());
app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  next();
});
app.use(express.json({ limit: process.env.JSON_LIMIT || "64kb" }));
app.use(express.urlencoded({ extended: false, limit: process.env.URLENCODED_LIMIT || "32kb" }));
app.use(express.static(path.join(__dirname, "public")));

function getBuildKey(service, hash, apiKey) {
    const tokenSig = crypto.createHash("sha1").update(String(apiKey || "")).digest("hex").slice(0, 12);
    return `${String(service || "").toLowerCase()}:${String(hash || "").toUpperCase()}:${tokenSig}`;
}

function getServiceResolverLimiter(service) {
    const normalized = String(service || '').toLowerCase();
    if (normalized === 'ad') return LIMITERS.adResolve;
    if (normalized === 'tb') return LIMITERS.tbResolve;
    return LIMITERS.rdResolve;
}

function getDbLookupCacheKey(meta) {
    const imdbId = String(meta?.imdb_id || '').trim().toLowerCase();
    if (!/^tt\d+$/.test(imdbId)) return null;
    const season = Number(meta?.season || 0) || 0;
    const episode = Number(meta?.episode || 0) || 0;
    return `${imdbId}:${season}:${episode}`;
}

function cloneManifest(manifest) {
    if (!manifest || typeof manifest !== 'object') return manifest;
    if (typeof structuredClone === 'function') return structuredClone(manifest);
    return JSON.parse(JSON.stringify(manifest));
}

function getCacheHealthStatus() {
    if (!Cache || typeof Cache !== 'object') return 'unavailable';
    const requiredMethods = ['getCloudBuild', 'setCloudBuild', 'getLazyLink', 'cacheLazyLink'];
    const missing = requiredMethods.filter((method) => typeof Cache[method] !== 'function');
    if (missing.length > 0) return `degraded (missing:${missing.join(',')})`;
    if (typeof Cache.getStreamCacheIndexStats === 'function') {
        try {
            const stats = Cache.getStreamCacheIndexStats();
            if (stats && typeof stats === 'object') return 'ok';
        } catch (err) {
            return `degraded (${err.message})`;
        }
    }
    return 'ok';
}

async function markPlayableResultAsCached(dbHelper, service, item, streamData, logger, meta = null) {
    const normalizedService = String(service || '').toLowerCase();
    if (!dbHelper || typeof dbHelper.updateRdCacheStatus !== 'function') return false;
    if (!item?.hash) return false;
    if (!['rd', 'ad'].includes(normalizedService)) return false;

    const rawFileIndex = streamData?.rd_file_index ?? streamData?.file_index ?? streamData?.fileIdx ?? item?.fileIdx;
    const rawFileSize = streamData?.rd_file_size ?? streamData?.file_size ?? streamData?.filesize ?? streamData?.size ?? null;
    const parsedFileIndex = Number(rawFileIndex);
    const parsedFileSize = Number(rawFileSize);
    const resolvedTitle = streamData?.filename || item?.title || String(item.hash);

    try {
        if ((!meta?.imdb_id) && typeof dbHelper.ensureTorrentRecord === 'function') {
            await dbHelper.ensureTorrentRecord({
                info_hash: item.hash,
                title: resolvedTitle,
                size: Number.isFinite(parsedFileSize) && parsedFileSize > 0 ? parsedFileSize : Number(item?._size || item?.sizeBytes || 0),
                seeders: Number(item?.seeders || 0) || 0,
                provider: item?.source || normalizedService.toUpperCase(),
                file_index: Number.isInteger(parsedFileIndex) && parsedFileIndex >= 0 ? parsedFileIndex : (item?.fileIdx !== undefined ? item.fileIdx : undefined)
            });
        }
        if (meta?.imdb_id && typeof dbHelper.insertTorrent === 'function') {
            await dbHelper.insertTorrent(meta, {
                info_hash: item.hash,
                title: resolvedTitle,
                size: Number.isFinite(parsedFileSize) && parsedFileSize > 0 ? parsedFileSize : 0,
                seeders: Number(item?.seeders || 0) || 0,
                provider: item?.source || normalizedService.toUpperCase(),
                file_index: Number.isInteger(parsedFileIndex) && parsedFileIndex >= 0 ? parsedFileIndex : (item?.fileIdx !== undefined ? item.fileIdx : undefined)
            });
        }

        const updated = await dbHelper.updateRdCacheStatus([{
            hash: item.hash,
            cached: true,
            rd_file_index: Number.isInteger(parsedFileIndex) && parsedFileIndex >= 0 ? parsedFileIndex : null,
            rd_file_size: Number.isFinite(parsedFileSize) && parsedFileSize > 0 ? parsedFileSize : null,
            failures: 0,
            permanent: true
        }]);
        if (updated > 0) {
            await Cache.invalidateStreamsByHashes([item.hash], 'lazy_play_cached');
            if (meta?.imdb_id) await Cache.invalidateStreamsByImdb(meta.imdb_id, 'lazy_play_cached');
            const dbLookupKey = getDbLookupCacheKey(meta);
            if (dbLookupKey) await Cache.invalidateDbTorrents(dbLookupKey, 'lazy_play_cached');
            logger.info(`[LAZY PLAY] Stato cache aggiornato a CACHED | service=${normalizedService} | hash=${item.hash} | fileIdx=${Number.isInteger(parsedFileIndex) && parsedFileIndex >= 0 ? parsedFileIndex : 'n/a'} | updated=${updated}`);
            return true;
        }
    } catch (err) {
        logger.warn(`[LAZY PLAY] Impossibile aggiornare stato cache | service=${normalizedService} | hash=${item.hash} | error=${err.message}`);
    }

    return false;
}

async function queueCloudBuild(service, hash, apiKey) {
    const buildKey = getBuildKey(service, hash, apiKey);
    const existingPromise = cloudBuildInflight.get(buildKey);
    if (existingPromise) return existingPromise;

    const task = (async () => {
        const startedAt = Date.now();
        const magnet = buildTrackerMagnet(hash);
        await Cache.setCloudBuild(buildKey, { status: 'queued', service, hash: String(hash || '').toUpperCase(), queuedAt: Date.now() }, 900);

        await LIMITERS.cloudBuild.schedule(async () => {
            if (service === 'rd') {
                await axios.post("https://api.real-debrid.com/rest/1.0/torrents/addMagnet", `magnet=${encodeURIComponent(magnet)}`, { headers: { "Authorization": `Bearer ${apiKey}`, "Content-Type": "application/x-www-form-urlencoded" } });
            } else if (service === 'ad') {
                await axios.get("https://api.alldebrid.com/v4/magnet/upload", { params: { agent: "leviathan", apikey: apiKey, magnet } });
            } else if (service === 'tb') {
                const body = new URLSearchParams(); body.append('magnet', magnet); body.append('seed', '1'); body.append('allow_zip', 'false');
                await axios.post("https://api.torbox.app/v1/api/torrents/createtorrent", body.toString(), { headers: { "Authorization": `Bearer ${apiKey}`, "Content-Type": "application/x-www-form-urlencoded" } });
            }
        });

        await Cache.setCloudBuild(buildKey, { status: 'submitted', service, hash: String(hash || '').toUpperCase(), queuedAt: Date.now() }, 900);
        recordDuration('cloudBuild.total', Date.now() - startedAt);
        recordProviderMetric(`cloudBuild.${service}`, true, Date.now() - startedAt);
        return { ok: true, duplicate: false };
    })().catch(async (err) => {
        const status = err?.response?.status, body = err?.response?.data;
        const msg = typeof body === 'string' ? body : JSON.stringify(body || {});
        if (status === 409 || /already|duplicate|exists|same magnet|in progress/i.test(`${err.message} ${msg}`)) {
            await Cache.setCloudBuild(buildKey, { status: 'submitted', service, hash: String(hash || '').toUpperCase(), queuedAt: Date.now(), duplicate: true }, 900);
            recordProviderMetric(`cloudBuild.${service}`, true, 0, { error: 'duplicate' });
            return { ok: true, duplicate: true };
        }
        await Cache.setCloudBuild(buildKey, { status: 'error', service, hash: String(hash || '').toUpperCase(), queuedAt: Date.now(), error: err.message }, 120);
        recordProviderMetric(`cloudBuild.${service}`, false, 0, { error: err.message });
        throw err;
    }).finally(() => cloudBuildInflight.delete(buildKey));

    cloudBuildInflight.set(buildKey, task);
    return task;
}

app.get("/api/stats", (req, res) => res.json(getStatsSnapshot()));
app.get("/api/rd-scanner-status", (req, res) => res.json(getRdCacheScannerStatus()));
app.get("/api/rd-scanner-dashboard", async (req, res) => {
    let progress = null;
    try {
        if (typeof dbHelper.getRdScanProgress === 'function') progress = await dbHelper.getRdScanProgress();
    } catch (err) {
        progress = { error: err.message };
    }

    res.json({
        status: 'ok',
        timestamp: new Date().toISOString(),
        scanner: getRdCacheScannerStatus(),
        progress,
        runtime: getStatsSnapshot(),
        streamCache: typeof Cache.getStreamCacheIndexStats === 'function' ? Cache.getStreamCacheIndexStats() : null
    });
});
app.get("/favicon.ico", (req, res) => res.status(204).end());

app.get("/:conf/play_lazy/:service/:hash/:fileIdx", async (req, res) => {
    const { conf, service, hash, fileIdx } = req.params;
    const { s, e, imdb } = req.query;
    const startedAt = Date.now();
    logger.info(`[LAZY PLAY] Service: ${service} | Hash: ${hash} | Idx: ${fileIdx} | S${s}E${e}`);
    try {
        const config = getConfig(conf);
        const apiKey = config.key || config.rd;
        if (!apiKey) return res.status(400).send("API Key mancante.");
        const magnet = buildTrackerMagnet(hash);
        const item = { title: `Unknown Video (${hash})`, hash: String(hash || '').toUpperCase(), season: parseInt(s, 10) || 0, episode: parseInt(e, 10) || 0, fileIdx: parseInt(fileIdx, 10) === -1 ? undefined : parseInt(fileIdx, 10), magnet };
        const lazyCacheKey = `${service}:${item.hash}:${item.season || 0}:${item.episode || 0}:${item.fileIdx !== undefined ? item.fileIdx : -1}`;
        const cachedPlaybackMeta = await Cache.getLazyMeta(lazyCacheKey);
        const playbackMeta = imdb ? {
            imdb_id: String(imdb),
            season: item.season || 0,
            episode: item.episode || 0,
            type: (item.season || 0) > 0 || (item.episode || 0) > 0 ? 'series' : 'movie',
            title: cachedPlaybackMeta?.title || item.title,
            source: cachedPlaybackMeta?.source || null,
            seeders: Number(cachedPlaybackMeta?.seeders || 0) || 0,
            size: Number(cachedPlaybackMeta?.size || 0) || 0
        } : (cachedPlaybackMeta?.imdb_id ? {
            imdb_id: String(cachedPlaybackMeta.imdb_id),
            season: item.season || cachedPlaybackMeta.season || 0,
            episode: item.episode || cachedPlaybackMeta.episode || 0,
            type: cachedPlaybackMeta.type || ((item.season || 0) > 0 || (item.episode || 0) > 0 ? 'series' : 'movie'),
            title: cachedPlaybackMeta.title || item.title,
            source: cachedPlaybackMeta.source || null,
            seeders: Number(cachedPlaybackMeta?.seeders || 0) || 0,
            size: Number(cachedPlaybackMeta?.size || 0) || 0
        } : null);
        if (playbackMeta?.title) item.title = playbackMeta.title;
        if (playbackMeta?.source) item.source = playbackMeta.source;
        if (Number(playbackMeta?.seeders || 0) > 0) item.seeders = Number(playbackMeta.seeders);
        if (Number(playbackMeta?.size || 0) > 0) {
            item._size = Number(playbackMeta.size);
            item.sizeBytes = Number(playbackMeta.size);
        }
        const cachedLazy = await Cache.getLazyLink(lazyCacheKey);
        if (cachedLazy && cachedLazy.url) {
            await markPlayableResultAsCached(dbHelper, service, item, cachedLazy, logger, playbackMeta);
            incrementMetric('lazyPlay.cacheHit');
            recordDuration('lazyPlay.total', Date.now() - startedAt);
            return res.redirect(cachedLazy.url);
        }

        const streamData = await LIMITERS.lazyPlay.schedule(() =>
            resolveLazyStreamData(service, apiKey, item, { season: item.season, episode: item.episode })
        );

        if (streamData && streamData.url) {
            await Cache.cacheLazyLink(lazyCacheKey, streamData, 180);
            await markPlayableResultAsCached(dbHelper, service, item, streamData, logger, playbackMeta);
            incrementMetric('lazyPlay.success');
            recordDuration('lazyPlay.total', Date.now() - startedAt);
            recordProviderMetric(`lazy.${service}`, true, Date.now() - startedAt);
            if (config.mediaflow && config.mediaflow.proxyDebrid && config.mediaflow.url) {
                try {
                    const mfpBase = config.mediaflow.url.replace(/\/$/, '');
                    let finalUrl = `${mfpBase}/proxy/stream?d=${encodeURIComponent(streamData.url)}`;
                    if (config.mediaflow.pass) finalUrl += `&api_password=${config.mediaflow.pass}`;
                    return res.redirect(finalUrl);
                } catch (e) {}
            }
            return res.redirect(streamData.url);
        }
        incrementMetric('lazyPlay.redirectToCloud');
        recordDuration('lazyPlay.total', Date.now() - startedAt);
        const protocol = req.headers['x-forwarded-proto'] || req.protocol;
        return res.redirect(`${protocol}://${req.get('host')}/${conf}/add_to_cloud/${hash}`);
    } catch (err) {
        recordDuration('lazyPlay.total', Date.now() - startedAt);
        recordProviderMetric(`lazy.${service}`, false, Date.now() - startedAt, { error: err.message, timeout: /timeout/i.test(String(err?.message || '')) });
        logger.error(`Error Lazy Play: ${err.message}`);
        res.status(500).send("Errore nel recupero del link: " + err.message);
    }
});

app.get("/:conf/play_tb/:hash", async (req, res) => {
    const { conf, hash } = req.params; const { s, e, f } = req.query; 
    res.redirect(`/${conf}/play_lazy/tb/${hash}/${f || -1}?s=${s}&e=${e}`);
});

app.get("/:conf/add_to_cloud/:hash", async (req, res) => {
    const { conf, hash } = req.params;
    try {
        const config = getConfig(conf), apiKey = config.key || config.rd, service = String(config.service || 'rd').toLowerCase();
        if (!apiKey) return res.status(400).send("API Key mancante.");
        const buildKey = getBuildKey(service, hash, apiKey), recentBuild = await Cache.getCloudBuild(buildKey);
        const isRecent = recentBuild && (Date.now() - Number(recentBuild.queuedAt || 0) < 120000) && ['queued', 'submitted'].includes(recentBuild.status);
        if (isRecent) logger.info(`📥 [CACHE BUILDER] Già in coda ${hash} su ${service.toUpperCase()} - salto duplicato`);
        else { logger.info(`📥 [CACHE BUILDER] Richiesta aggiunta hash ${hash} su ${service.toUpperCase()}`); await queueCloudBuild(service, hash, apiKey); }
        res.redirect(`${req.headers['x-forwarded-proto'] || req.protocol}://${req.get('host')}/confirmed.mp4`);
    } catch (err) { logger.error(`Errore Cache Builder: ${err.message}`); res.status(500).send("Errore durante l'aggiunta al cloud: " + err.message); }
});

const authMiddleware = (req, res, next) => {
    if (!ADMIN_PASS) return res.status(503).json({ error: "Admin disabilitato: configura ADMIN_PASS nell'ambiente" });
    const rawAuthHeader = String(req.headers['authorization'] || '').trim();
    if (safeCompare(rawAuthHeader.toLowerCase().startsWith('bearer ') ? rawAuthHeader.slice(7).trim() : rawAuthHeader, ADMIN_PASS)) return next();
    return res.status(403).json({ error: "Password errata" });
};
app.get("/admin/keys", authMiddleware, async (req, res) => { res.json(await Cache.listKeys()); });
app.delete("/admin/key", authMiddleware, async (req, res) => { req.query.key ? (await Cache.deleteKey(req.query.key), res.json({ success: true })) : res.json({ error: "Key mancante" }); });
app.post("/admin/flush", authMiddleware, async (req, res) => { await Cache.flushAll(); res.json({ success: true }); });

app.get("/health", async (req, res) => {
  const checks = { status: "ok", timestamp: new Date().toISOString(), services: {} };
  try { if (dbHelper.healthCheck) await withTimeout(dbHelper.healthCheck(), 1000, "DB Health"); checks.services.database = "ok (Write-Only)"; }
  catch (err) { checks.services.database = "down"; checks.status = "degraded"; logger.error("Health Check DB Fail", { error: err.message }); }
  try {
    if (!CONFIG.INDEXER_URL) checks.services.indexer = "disabled";
    else { await withTimeout(axios.get(`${CONFIG.INDEXER_URL}/health`, { timeout: 1000 }), 1000, "Indexer Health"); checks.services.indexer = "ok"; }
  } catch (err) { checks.services.indexer = "down"; checks.status = "degraded"; }
  checks.services.cache = getCacheHealthStatus();
  if (String(checks.services.cache).startsWith('degraded')) checks.status = 'degraded';
  res.status(checks.status === "ok" ? 200 : 503).json(checks);
});

app.get("/", (req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));
app.get("/:conf/configure", (req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));
app.get("/configure", (req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));
app.get("/rd-scanner", (req, res) => res.sendFile(path.join(__dirname, "public", "rd-scanner.html")));
app.get("/manifest.json", (req, res) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.json(getManifest());
});

app.get("/:conf/manifest.json", (req, res) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    const manifest = cloneManifest(getManifest());
    try {
        const config = getConfig(req.params.conf), filters = config.filters || {}, langMode = filters.language || (filters.allowEng ? "all" : "ita");
        const flag = langMode === "ita"
            ? " 🇮🇹"
            : (langMode === "eng" ? " 🇬🇧" : " 🇮🇹🇬🇧");
        const appName = "LEVIATHAN";

        if ((config.service === 'rd' && config.key) || config.rd) {
            manifest.name = `${appName}${flag} 🔱 RD`;
            manifest.id += ".rd";
        } else if ((config.service === 'tb' && config.key) || config.torbox) {
            manifest.name = `${appName}${flag} 🔱 TB`;
            manifest.id += ".tb";
        } else if ((config.service === 'ad' && config.key) || config.alldebrid) {
            manifest.name = `${appName}${flag} 🔱 AD`;
            manifest.id += ".ad";
        } else if (filters.enableP2P === true) {
            manifest.name = `${appName}${flag} 🦈 P2P`;
            manifest.id += ".p2p";
            manifest.description += " | P2P Mode (IP Visible)";
        } else {
            manifest.name = `${appName}${flag} ⛵ Web`;
            manifest.id += ".web";
        }
    } catch (e) { console.error("Errore personalizzazione manifest:", e); }
    res.json(manifest);
});

app.get("/:conf/catalog/:type/:id/:extra?.json", async (req, res) => { res.setHeader("Access-Control-Allow-Origin", "*"); res.json({metas:[]}); });
app.get("/vixsynthetic.m3u8", handleVixSynthetic);

app.get("/:conf/stream/:type/:id.json", async (req, res) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0");
    res.setHeader("Pragma", "no-cache");
    res.setHeader("Expires", "0");
    try {
        validateStreamRequest(req.params.type, req.params.id.replace('.json', ''));
        res.json(await generateStream(req.params.type, req.params.id.replace(".json", ""), getConfig(req.params.conf), req.params.conf, `${req.headers['x-forwarded-proto'] || req.protocol}://${req.get('host')}`));
    } catch (err) { logger.error('Validazione/Stream Fallito', { error: err.message, params: req.params }); return res.status(400).json({ streams: [] }); }
});

const PORT = process.env.PORT || 7000;
const server = app.listen(PORT, () => {
    console.log(`[BOOT] Leviathan (God Tier) attivo su porta interna ${PORT}`);
    console.log(`-----------------------------------------------------`);
    console.log(`[MODE] FULL LAZY`);
    console.log(`[SERIES] Full Lazy Mode`);
    console.log(`[INDEXER] URL: ${CONFIG.INDEXER_URL}`);
    console.log(`[METADATA] TMDB Primary`);
    console.log(`[DB WRITE] Locale`);
    console.log(`[DB READ] Locale attiva`);
    console.log(`[SPETTRO] Modulo Attivo`);
    console.log(`[SIZE LIMITER] Modulo Attivo`);
    console.log(`[GUARDA HD] Modulo integrato e pronto`);
    console.log(`[GUARDA SERIE] Modulo integrato e pronto`);
    console.log(`[ANIMEWORLD] Modulo integrato e pronto`); 
    console.log(`[GUARDAFLIX] Modulo integrato`);
    console.log(`[WEBSTREAMR] Fallback attivo`);
    console.log(`[TRAILER] Attivabile da config`);
    console.log(`📦 TORBOX: ADVANCED SMART CACHE`);
    console.log(`[PARSER] Enhanced`); 
    console.log(`[P2P] Handler attivo`);
    console.log(`[CORE] Optimized for High Reliability`);
    console.log(`[CACHE] Global raw + user level active`);
    console.log(`[SCRAPERS] Fallback scrapers ready`);
    console.log(`-----------------------------------------------------`);
});

function gracefulShutdown(signal) {
    logger.info(`[SHUTDOWN] Ricevuto ${signal}, chiusura server in corso...`);
    server.close(() => { logger.info("[SHUTDOWN] Server HTTP chiuso correttamente."); process.exit(0); });
    setTimeout(() => { logger.error("[SHUTDOWN] Shutdown forzato per timeout."); process.exit(1); }, 10000).unref();
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('unhandledRejection', (reason) => { logger.error('Unhandled Promise Rejection', { reason: reason instanceof Error ? reason.message : String(reason) }); });
process.on('uncaughtException', (error) => {
    logger.error('Uncaught Exception', { error: error.message, stack: error.stack });
    setTimeout(() => process.exit(1), 250).unref();
});
