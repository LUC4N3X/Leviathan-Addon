const axios = require("axios");
const crypto = require("crypto");

const { fetchExternalAddonsFlat } = require("./nexus-bridge");
const PackResolver = require("./pack_intelligence");
const aioFormatter = require("./lib/pulse_formatter.cjs");
const { searchWebStreamr } = require("../webstreamr_handler");
const TbCache = require("../debrid/tb_cache.js");
const { formatStreamSelector, formatBytes } = require("./lib/stream_formatter");
const P2P = require("../p2p_handler");
const { searchVix } = require("../vix/vix_handler");
const { searchGuardaHD } = require("../guardahd/ghd_handler"); 
const { searchGuardaserie } = require("../guardaserie/gs_handler"); 
const { searchAnimeWorld } = require("../animeworld/aw_handler"); 
const { searchGuardaFlix } = require("../guardaflix/gf_handler"); 
const { generateSmartQueries, smartMatch } = require("./media_intelligence");
const { rankAndFilterResults } = require("./lib/result_ranker");
const { tmdbToImdb, imdbToTmdb, getTmdbAltTitles } = require("./media_identity_resolver");
const RD = require("../debrid/realdebrid");
const AD = require("../debrid/alldebrid");
const TB = require("../debrid/torbox");
const dbHelper = require("./storage/db_repository"); 
const { buildMagnet: buildTrackerMagnet } = require("./storage/tracker_registry");
const SCRAPER_MODULES = [ require("../engines") ];

const {
  logger, Cache, LIMITERS, CONFIG, REGEX_QUALITY_FILTER, REGEX_SUB_ONLY, REGEX_AUDIO_CONFIRM, REGEX_YEAR, EMPTY_STREAM_TTL, METADATA_CACHE_TTL,
  getLanguageInfo, parseTitleDetails, formatLanguageLabel, isSeasonPack, isGoodShortQueryMatch, chooseBestPackTitle, shouldUpdatePackTitle,
  extractSeasonEpisodeFromFilename, estimateVisualSize, estimateSeeders, deduplicateResults, filterByQualityLimit, extractInfoHash,
  withTimeout, normalizeSearchText, extractSeeders, extractSize, streamInflight, metadataInflight, withSharedPromise,
  incrementMetric, recordDuration, recordProviderMetric
} = require("./utils");

function getServiceResolverLimiter(service) {
    const normalized = String(service || '').toLowerCase();
    if (normalized === 'ad') return LIMITERS.adResolve;
    if (normalized === 'tb') return LIMITERS.tbResolve;
    return LIMITERS.rdResolve;
}

function getLazyCacheKey(service, item, meta) {
    return `${service}:${item.hash}:${meta?.season || item.season || 0}:${meta?.episode || item.episode || 0}:${item.fileIdx !== undefined && item.fileIdx !== null ? item.fileIdx : -1}`;
}

function getCompositeRankScore(item, meta, config) {
    const title = String(item?.title || '');
    const source = item?.source || item?.provider || null;
    const parsed = parseTitleDetails(title);
    const langInfo = getLanguageInfo(title, meta?.title, source, parsed);
    const sizeBytes = Number(item?._size || item?.sizeBytes || 0);
    const seeders = parseInt(item?.seeders, 10) || 0;
    const explicitFileIdx = item?.fileIdx !== undefined && item?.fileIdx !== null;
    const isPack = !!(item?._isPack || isSeasonPack(title));
    const epData = meta?.isSeries ? extractSeasonEpisodeFromFilename(title, meta?.season || 1) : null;

    let score = 0;
    if (langInfo.isItalian) score += 200000;
    else if (langInfo.isMaybeItalian) score += 70000;
    if (langInfo.isMulti) score += 12000;
    if (REGEX_AUDIO_CONFIRM.test(title)) score += 22000;
    if (/(web[-.\s]?dl|blu[-.\s]?ray|remux|uhd|hevc|x265|x264|ddp|truehd|dts)/i.test(title)) score += 14000;
    if (/(4k|2160p|uhd)/i.test(title)) score += 9000;
    else if (/(1080p|fhd|full[-.\s]?hd)/i.test(title)) score += 7000;
    else if (/(720p|hd[-.\s]?rip|hdtv|hd)/i.test(title)) score += 4000;
    if (/(cam|hdcam|ts|telesync|screener|scr)/i.test(title)) score -= 30000;
    if (langInfo.isSubOnly) score -= 25000;
    if (explicitFileIdx) score += 7000;
    if (source && /mircrew|corsaro|lux|wms|dn[a4]?|idn_crew|speedvideo/i.test(String(source))) score += 6000;
    if (title && /mircrew|corsaro|lux|wms|dn[a4]?|idn_crew|speedvideo/i.test(title)) score += 5000;
    if (meta?.isSeries) {
        if (epData && epData.season === meta.season && epData.episode === meta.episode) score += 24000;
        else if (isPack && new RegExp(`(?:s|season|stagione)\s*0?${meta.season}(?!\d)`, 'i').test(title)) score += 9000;
        else if (epData && epData.episode !== meta.episode) score -= 18000;
    }
    if (!meta?.isSeries && /(?:S\d{2}|SEASON|STAGIONE|\d+x\d+)/i.test(title)) score -= 18000;
    score += Math.min(seeders, 500) * 18;
    score += Math.min(Math.floor(sizeBytes / (700 * 1024 * 1024)), 1200);
    score += Math.min(title.length, 300);
    if (String(config?.service || '').toLowerCase() === 'tb' && item?._tbCached) score += 15000;
    return score;
}

function rerankCompositeResults(results, meta, config, sortMode) {
    const ranked = Array.isArray(results) ? [...results] : [];
    ranked.forEach(item => { item._compositeScore = getCompositeRankScore(item, meta, config); });
    ranked.sort((a, b) => {
        const scoreDelta = (b._compositeScore || 0) - (a._compositeScore || 0);
        const sizeA = a._size || a.sizeBytes || 0;
        const sizeB = b._size || b.sizeBytes || 0;
        if (sortMode === 'size' && sizeB !== sizeA) return sizeB - sizeA || scoreDelta;
        if (sortMode === 'resolution') {
            const getResScore = (t) => /2160p|4k|uhd/i.test(t) ? 40 : /1080p|fhd/i.test(t) ? 30 : /720p|hd/i.test(t) ? 20 : 10;
            const resDelta = getResScore(b.title || '') - getResScore(a.title || '');
            if (resDelta !== 0) return resDelta || scoreDelta;
        }
        if (scoreDelta !== 0) return scoreDelta;
        const seedDelta = (parseInt(b.seeders, 10) || 0) - (parseInt(a.seeders, 10) || 0);
        if (seedDelta !== 0) return seedDelta;
        return sizeB - sizeA;
    });
    return ranked;
}

async function guardedProviderCall(providerName, limiter, timeoutMs, factory) {
    const startedAt = Date.now();
    try {
        const result = await limiter.schedule(() => withTimeout(Promise.resolve().then(factory), timeoutMs, providerName));
        const duration = Date.now() - startedAt;
        recordDuration(`provider.${providerName}`, duration);
        recordProviderMetric(providerName, true, duration);
        return Array.isArray(result) ? result : (result ? [result] : []);
    } catch (err) {
        const duration = Date.now() - startedAt;
        const isTimeout = /timeout/i.test(String(err?.message || ''));
        recordDuration(`provider.${providerName}`, duration);
        recordProviderMetric(providerName, false, duration, { timeout: isTimeout, error: err?.message || err });
        logger.warn(`⚠️ [${providerName}] failed: ${err.message}`);
        return [];
    }
}

function warmupLazyStreamsInBackground(config, items, meta) {
    const service = String(config?.service || 'rd').toLowerCase();
    const apiKey = config?.key || config?.rd;
    if (!apiKey || !Array.isArray(items) || items.length === 0) return;
    const maxWarmups = Math.max(0, Math.min(4, parseInt(config?.filters?.warmupTop ?? process.env.LAZY_WARMUP_TOP ?? '2', 10) || 0));
    if (maxWarmups <= 0) return;

    const resolverLimiter = getServiceResolverLimiter(service);
    items.slice(0, maxWarmups).forEach(item => {
        LIMITERS.lazyWarmup.schedule(async () => {
            const lazyCacheKey = getLazyCacheKey(service, item, meta);
            const cached = await Cache.getLazyLink(lazyCacheKey);
            if (cached?.url) return;
            const startedAt = Date.now();
            try {
                let streamData = null;
                if (service === 'tb') {
                    streamData = await resolverLimiter.schedule(() => TB.getStreamLink(apiKey, item.magnet, String(meta?.season || item.season || 0), String(meta?.episode || item.episode || 0), item.hash, item.fileIdx !== undefined && item.fileIdx !== null ? String(item.fileIdx) : undefined));
                } else if (service === 'ad') {
                    streamData = await resolverLimiter.schedule(() => AD.getStreamLink(apiKey, item.magnet, meta?.season || item.season || 0, meta?.episode || item.episode || 0, item.fileIdx !== undefined && item.fileIdx !== null ? item.fileIdx : 0));
                } else {
                    streamData = await resolverLimiter.schedule(() => RD.getStreamLink(apiKey, item.magnet, meta?.season || item.season || 0, meta?.episode || item.episode || 0, item.fileIdx));
                }
                if (streamData?.url) {
                    await Cache.cacheLazyLink(lazyCacheKey, streamData, 180);
                    incrementMetric('lazyWarmup.success');
                }
                recordProviderMetric(`warmup.${service}`, true, Date.now() - startedAt);
            } catch (err) {
                incrementMetric('lazyWarmup.fail');
                recordProviderMetric(`warmup.${service}`, false, Date.now() - startedAt, { timeout: /timeout/i.test(String(err?.message || '')), error: err?.message || err });
            }
        }).catch(err => logger.warn(`⚠️ [WARMUP] Queue error: ${err.message}`));
    });
}

async function resolvePackWithBestEffort(item, config, meta, siblingStreams = []) {
    if (!item || !item.hash) return null;
    const resolverCalls = [];
    const resolverContext = { item, config, meta, siblingStreams, dbHelper, logger, RD, TB };

    if (PackResolver && typeof PackResolver.resolvePackData === 'function') resolverCalls.push(() => PackResolver.resolvePackData(resolverContext));
    if (PackResolver && typeof PackResolver.resolvePack === 'function') resolverCalls.push(() => PackResolver.resolvePack(resolverContext));
    if (PackResolver && typeof PackResolver.resolve === 'function') {
        resolverCalls.push(() => PackResolver.resolve(resolverContext));
        resolverCalls.push(() => PackResolver.resolve(item, config, meta));
    }
    if (PackResolver && typeof PackResolver.getPackData === 'function') resolverCalls.push(() => PackResolver.getPackData(item.hash, config, meta));

    for (const call of resolverCalls) {
        try {
            const resolved = await LIMITERS.packResolver.schedule(() => Promise.resolve(call()));
            if (!resolved) continue;
            const packName = resolved.filename || resolved.packName || resolved.pack_name || resolved.title || resolved.name || null;
            const files = Array.isArray(resolved.files) ? resolved.files : (Array.isArray(resolved.videoFiles) ? resolved.videoFiles : []);
            const bestTitleData = chooseBestPackTitle(item, packName, siblingStreams);
            return { title: bestTitleData.title, titleSource: bestTitleData.source, packName, files, raw: resolved };
        } catch (err) { logger.warn(`⚠️ [PACK] Resolver error for ${item.hash}: ${err.message}`); }
    }
    return null;
}

async function persistPackResolution(meta, item, resolved) {
    if (!resolved || !dbHelper) return;
    const infoHash = item.hash || item.infoHash;
    if (!infoHash) return;
    try {
        if (resolved.title && resolved.title !== item.title && shouldUpdatePackTitle(item.title, resolved.title)) {
            if (typeof dbHelper.updateTorrentTitle === 'function') await dbHelper.updateTorrentTitle(infoHash, resolved.title);
        }
    } catch (err) { logger.warn(`⚠️ [PACK] updateTorrentTitle failed for ${infoHash}: ${err.message}`); }

    const files = Array.isArray(resolved.files) ? resolved.files : [];
    if (files.length === 0) return;
    const seasonFallback = Number(meta?.season) > 0 ? Number(meta.season) : 1;
    const episodeFiles = [];
    const packFiles = [];

    for (const file of files) {
        const filePath = file.path || file.filename || file.name || '';
        const fileSize = Number(file.bytes || file.size || file.file_size || 0);
        if (!filePath || fileSize < 50 * 1024 * 1024) continue;
        const fileIndexRaw = file.id ?? file.file_index ?? file.index ?? file.fileIdx;
        const fileIndex = fileIndexRaw !== undefined && fileIndexRaw !== null ? parseInt(fileIndexRaw, 10) : undefined;
        const filename = filePath.split('/').pop();
        const parsedEpisode = extractSeasonEpisodeFromFilename(filename, seasonFallback);

        if (parsedEpisode && Number.isInteger(fileIndex)) {
            episodeFiles.push({ info_hash: infoHash, file_index: fileIndex, title: filename, size: fileSize, imdb_id: meta?.imdb_id || null, imdb_season: parsedEpisode.season, imdb_episode: parsedEpisode.episode });
        } else if (Number.isInteger(fileIndex)) {
            packFiles.push({ info_hash: infoHash, file_index: fileIndex, file_title: filename, size: fileSize, imdb_id: meta?.imdb_id || null, title: resolved.title || item.title });
        }
    }

    try { if (episodeFiles.length > 0 && typeof dbHelper.insertEpisodeFiles === 'function') await dbHelper.insertEpisodeFiles(episodeFiles); }
    catch (err) { logger.warn(`⚠️ [PACK] insertEpisodeFiles failed for ${infoHash}: ${err.message}`); }
    try { if (packFiles.length > 0 && typeof dbHelper.insertPackFiles === 'function') await dbHelper.insertPackFiles(packFiles); }
    catch (err) { logger.warn(`⚠️ [PACK] insertPackFiles failed for ${infoHash}: ${err.message}`); }
}

function resolvePackNamesInBackground(meta, results, config) {
    if (!meta || !config || !Array.isArray(results) || results.length === 0) return;
    const hasResolvableService = !!((config.service === 'rd' && (config.key || config.rd)) || (config.service === 'tb' && (config.key || config.rd || config.torbox || config.tb)));
    if (!hasResolvableService) return;
    const packCandidates = results.filter(item => item && (item._isPack || isSeasonPack(item.title)));
    if (packCandidates.length === 0) return;

    LIMITERS.bgPackJobs.schedule(async () => {
        for (const item of packCandidates) {
            try {
                const resolved = await resolvePackWithBestEffort(item, config, meta, results);
                if (resolved) await persistPackResolution(meta, item, resolved);
            } catch (err) { logger.warn(`⚠️ [PACK] Background processing failed for ${item.hash || item.infoHash}: ${err.message}`); }
        }
    }).catch(err => { logger.warn(`⚠️ [PACK] Background queue failed: ${err.message}`); });
}

function applyWebFormatter(streamList, sourceName, meta, config) {
    if (!streamList || !Array.isArray(streamList)) return [];
    return streamList.map(stream => {
        let quality = "HD";
        const upperName = (stream.name || "").toUpperCase();
        if (upperName.includes("4K") || upperName.includes("2160P")) quality = "4K";
        else if (upperName.includes("1080P") || upperName.includes("FHD")) quality = "1080p";
        else if (upperName.includes("720P")) quality = "720p";
        else if (upperName.includes("SD") || upperName.includes("480P")) quality = "SD";

        let fileTitle = meta.title; 
        let rawTitleToCheck = (stream.title || "").toUpperCase(); 
        if (stream.title) {
            let cleanRaw = stream.title.split('\n')[0].replace(/[🎬⚡🌪️⛩️🍿🦁🎥🌐]/g, '').trim();
            if (cleanRaw.length > 2) fileTitle = cleanRaw;
        }

        let langTag = "ITA", providerIcon = "🌐"; 
        const sLower = sourceName.toLowerCase();
        if (sLower.includes("animeworld")) {
            providerIcon = "⛩️"; 
            if (rawTitleToCheck.includes("JPN") || rawTitleToCheck.includes("SUB") || rawTitleToCheck.includes("VOST")) langTag = "JPN"; 
            else langTag = "ITA"; 
        } else if (sLower.includes("streamingcommunity")) providerIcon = "🌪️"; 
        else if (sLower.includes("guardaserie")) providerIcon = "🍿"; 
        else if (sLower.includes("guardahd")) providerIcon = "🦁"; 
        else if (sLower.includes("guardaflix")) providerIcon = "🎥";

        const formatted = formatStreamSelector(`${fileTitle} ${quality} ${langTag} WEB-DL AAC`, sourceName, 0, null, "WEB", config, null, false, false);
        let cleanTitle = formatted.title.replace(/🦑/g, "⛵").replace(/🦈/g, providerIcon).replace(/🧲\s*\d+(\.\d+)?\s*(GB|MB)/gi, "☁️ Web Stream");
        return {
            name: formatted.name.replace(/🦑/g, "⛵").replace(/🦈/g, providerIcon),
            title: cleanTitle, url: stream.url,
            behaviorHints: stream.behaviorHints || { notWebReady: false, bingieGroup: `Leviathan|${quality}|Web|${sourceName}` }
        };
    });
}

async function fetchTmdbMeta(tmdbId, type, userApiKey) {
    if (!tmdbId) return null;
    const apiKey = (userApiKey && userApiKey.length > 1) ? userApiKey : (process.env.TMDB_API_KEY || "4b9dfb8b1c9f1720b5cd1d7efea1d845");
    const url = `https://api.themoviedb.org/3/${type === 'series' || type === 'tv' ? 'tv' : 'movie'}/${tmdbId}?api_key=${apiKey}&language=it-IT`;
    try { const { data } = await axios.get(url, { timeout: CONFIG.TIMEOUTS.TMDB }); return data; }
    catch (e) { logger.warn(`TMDB Meta Fetch Error for ${tmdbId}: ${e.message}`); return null; }
}

async function getMetadata(id, type, config = {}) {
  const userTmdbKey = String(config?.tmdb || '');
  const metadataCacheKey = `${type}:${id}:${userTmdbKey}`;
  const cachedMeta = await Cache.getMetadata(metadataCacheKey);
  if (cachedMeta) { logger.info(`⚡ META CACHE HIT: ${metadataCacheKey}`); return cachedMeta; }

  return withSharedPromise(metadataInflight, metadataCacheKey, async () => {
    const secondCacheHit = await Cache.getMetadata(metadataCacheKey);
    if (secondCacheHit) return secondCacheHit;
    let finalMeta = null;

    try {
      if (type === 'anime' || id.toString().startsWith('kitsu:')) {
          let kitsuId = id.toString(), episode = 0;
          if (kitsuId.includes(':')) {
              const parts = kitsuId.split(':'); kitsuId = parts[1];
              if (parts.length > 2) episode = parseInt(parts[2]);
          }
          const kitsuUrl = `${CONFIG.KITSU_URL}/meta/anime/kitsu:${kitsuId}.json`;
          logger.info(`⛩️ [META] Fetching Kitsu (Direct): ${kitsuUrl}`);
          try {
              const { data } = await axios.get(kitsuUrl, { timeout: CONFIG.TIMEOUTS.TMDB });
              if (data && data.meta) {
                  const kMeta = data.meta;
                  finalMeta = { title: kMeta.name, originalTitle: kMeta.name, year: kMeta.year ? kMeta.year.split("–")[0] : (kMeta.releaseInfo ? kMeta.releaseInfo.substring(0, 4) : ""), imdb_id: kMeta.imdb_id || null, kitsu_id: kitsuId, isSeries: true, season: 1, episode: episode };
              }
          } catch (e) { logger.warn(`⚠️ Errore Metadata Kitsu: ${e.message} - Fallback sconsigliato ma tentiamo clean`); }
      }

      if (!finalMeta) {
        const cleanType = (type === 'anime') ? 'series' : type;
        if (!["movie", "series"].includes(cleanType)) return null;
        let imdbId = id, season = 0, episode = 0;
        if (cleanType === "series" && id.includes(":")) {
            const parts = id.split(":"); imdbId = parts[0]; season = parseInt(parts[1]); episode = parseInt(parts[2]);
        }
        const cleanId = imdbId.match(/^(tt\d+|\d+)$/i)?.[0] || imdbId;
        if (!cleanId) return null;

        try {
            const { tmdbId } = await imdbToTmdb(cleanId, userTmdbKey);
            if (tmdbId) {
                const tmdbData = await fetchTmdbMeta(tmdbId, cleanType, userTmdbKey);
                if (tmdbData) {
                    finalMeta = { title: tmdbData.title || tmdbData.name, originalTitle: tmdbData.original_title || tmdbData.original_name, year: (tmdbData.release_date || tmdbData.first_air_date) ? (tmdbData.release_date || tmdbData.first_air_date).split("-")[0] : "", imdb_id: cleanId, tmdb_id: tmdbId, isSeries: cleanType === "series", season: season, episode: episode };
                    logger.info(`✅ [META] Usato TMDB (UserKey: ${!!userTmdbKey}): ${finalMeta.title} (${finalMeta.year}) [ID: ${tmdbId}] Orig: ${finalMeta.originalTitle}`);
                }
            }
        } catch (err) { logger.warn(`⚠️ Errore Metadata TMDB, fallback a Cinemeta: ${err.message}`); }

        if (!finalMeta) {
          logger.info(`ℹ️ [META] Fallback a Cinemeta per ${cleanId}`);
          const { data: cData } = await axios.get(`${CONFIG.CINEMETA_URL}/meta/${cleanType}/${cleanId}.json`, { timeout: CONFIG.TIMEOUTS.TMDB }).catch(() => ({ data: {} }));
          finalMeta = cData?.meta ? { title: cData.meta.name, originalTitle: cData.meta.name, year: cData.meta.year?.split("–")[0], imdb_id: cleanId, isSeries: cleanType === "series", season: season, episode: episode } : null;
        }
      }
    } catch (err) { logger.error(`Errore getMetadata Critical: ${err.message}`); finalMeta = null; }

    if (finalMeta) await Cache.cacheMetadata(metadataCacheKey, finalMeta, METADATA_CACHE_TTL);
    return finalMeta;
  });
}

function saveResultsToDbBackground(meta, results, config = null) {
    if (!results || results.length === 0) return;
    (async () => {
        let savedCount = 0;
        for (const item of results) {
            const torrentObj = { info_hash: item.hash || item.infoHash, title: item.title, size: item._size || item.sizeBytes || 0, seeders: item.seeders || 0, provider: item.source || 'External', file_index: item.fileIdx !== undefined ? item.fileIdx : undefined, is_pack: item._isPack || isSeasonPack(item.title) };
            if (!torrentObj.info_hash) continue;
            const success = await dbHelper.insertTorrent(meta, torrentObj);
            if (success) savedCount++;
        }
        if (savedCount > 0) console.log(`💾 [AUTO-LEARN] Salvati ${savedCount} nuovi torrent nel DB per ${meta.imdb_id}`);
        resolvePackNamesInBackground(meta, results, config);
    })().catch(err => console.error("❌ Errore background save:", err.message));
}

async function resolveDebridLink(config, item, showFake, reqHost, meta) {
    try {
        const service = config.service || 'rd', apiKey = config.key || config.rd;
        if (!apiKey) return null;
        const isAIOActive = aioFormatter.isAIOStreamsEnabled(config);
        let displayTitle = item.title;
        let isPack = item._isPack || isSeasonPack(item.title);
        const isSeries = (meta?.season > 0 || meta?.episode > 0);

        if (isAIOActive && isPack && isSeries && meta) {
             const s = meta.season < 10 ? `0${meta.season}` : meta.season, e = meta.episode < 10 ? `0${meta.episode}` : meta.episode;
             displayTitle = `${meta.title} S${s}E${e}`;
        }

        const details = parseTitleDetails(item.title);
        const titleLanguage = getLanguageInfo(item.title, meta?.title, item.source, details);

        if (service === 'tb') {
            if (item._tbCached) {
                let realSize = estimateVisualSize(item._size || item.sizeBytes || 0, item.title, isSeries, isPack, item.hash);
                const finalSeeders = estimateSeeders(item.seeders, item.hash);
                const proxyUrl = `${reqHost}/${config.rawConf}/play_tb/${item.hash}?s=${item.season || 0}&e=${item.episode || 0}&f=${(item.fileIdx !== undefined && !isNaN(item.fileIdx)) ? item.fileIdx : -1}`;

                if (isAIOActive) {
                    let quality = /4k|2160p/i.test(item.title) ? "4K" : details.quality || "SD"; 
                    return {
                        name: aioFormatter.formatStreamName({ service: 'torbox', cached: true, quality: quality }),
                        title: aioFormatter.formatStreamTitle({ title: displayTitle, size: formatBytes(realSize), language: formatLanguageLabel(titleLanguage, details.languages), source: item.source, seeders: finalSeeders, infoHash: item.hash, techInfo: `🎞️ ${quality} ${details.tags}` }),
                        url: proxyUrl, infoHash: item.hash, behaviorHints: { notWebReady: false, bingieGroup: `Leviathan|${quality}|TB|${item.hash}` }
                    };
                } else {
                    const { name, title, bingeGroup } = formatStreamSelector(item.title, item.source, realSize, finalSeeders, "TB", config, item.hash, false, item._isPack);
                    return { name, title, url: proxyUrl, behaviorHints: { notWebReady: false, bingieGroup: bingeGroup } };
                }
            } else { return null; }
        }

        let streamData = null;
        if (service === 'rd') streamData = await RD.getStreamLink(apiKey, item.magnet, item.season, item.episode, item.fileIdx);
        else if (service === 'ad') streamData = await AD.getStreamLink(apiKey, item.magnet, item.season, item.episode, item.fileIdx);

        if (!streamData || (streamData.type === "ready" && streamData.size < CONFIG.REAL_SIZE_FILTER)) return null;

        const finalSize = estimateVisualSize(streamData.size || item._size || item.sizeBytes || 0, streamData.filename || item.title, isSeries, isPack, item.hash);
        const finalSeeders = estimateSeeders(item.seeders, item.hash);
        const fileDetails = parseTitleDetails(streamData.filename || item.title);
        const fileLanguage = getLanguageInfo(streamData.filename || item.title, meta?.title, item.source, fileDetails);

        if (isAIOActive) {
             let quality = /4k|2160p/i.test(item.title) ? "4K" : fileDetails.quality || "SD"; 
             let fullService = service === 'rd' ? 'realdebrid' : service === 'ad' ? 'alldebrid' : service === 'tb' ? 'torbox' : 'p2p';
             return {
                name: aioFormatter.formatStreamName({ service: fullService, cached: true, quality: quality }),
                title: aioFormatter.formatStreamTitle({ title: displayTitle, size: formatBytes(finalSize), language: formatLanguageLabel(fileLanguage, fileDetails.languages), source: item.source, seeders: finalSeeders, infoHash: item.hash, techInfo: `🎞️ ${quality} ${fileDetails.tags}` }),
                url: streamData.url, infoHash: item.hash, behaviorHints: { notWebReady: false, bingieGroup: `Leviathan|${quality}|${service}|${item.hash}` }
            };
        } else {
            const { name, title, bingeGroup } = formatStreamSelector(streamData.filename || item.title, item.source, finalSize, finalSeeders, service.toUpperCase(), config, item.hash, false, item._isPack);
            return { name, title, url: streamData.url, behaviorHints: { notWebReady: false, bingieGroup: bingeGroup } };
        }
    } catch (e) {
        if (showFake) return { name: `[P2P ⚠️]`, title: `${item.title}\n⚠️ Cache Assente`, url: item.magnet, behaviorHints: { notWebReady: true } };
        return null;
    }
}

function generateLazyStream(item, config, meta, reqHost, userConfStr, isLazy = false) {
    const service = config.service || 'rd';
    const isAIOActive = aioFormatter.isAIOStreamsEnabled(config); 
    const isPack = item._isPack || isSeasonPack(item.title);
    const isSeries = (meta.season > 0 || meta.episode > 0);

    let displayTitle = item.title, realSize = item._size || item.sizeBytes || 0;
    
    if (isAIOActive && isPack && isSeries) {
        realSize = 0; 
        displayTitle = `${meta.title} S${meta.season < 10 ? `0${meta.season}` : meta.season}E${meta.episode < 10 ? `0${meta.episode}` : meta.episode}`;
    }

    realSize = estimateVisualSize(realSize, displayTitle, isSeries, isPack, item.hash);
    const finalSeeders = estimateSeeders(item.seeders, item.hash);
    const lazyUrl = `${reqHost}/${userConfStr}/play_lazy/${service}/${item.hash}/${(item.fileIdx !== undefined && !isNaN(item.fileIdx)) ? item.fileIdx : -1}?s=${meta.season || 0}&e=${meta.episode || 0}`;

    if (isAIOActive) {
        const details = parseTitleDetails(item.title);
        const lazyLanguage = getLanguageInfo(item.title, meta?.title, item.source, details);
        let quality = /4k|2160p/i.test(item.title) ? "4K" : details.quality || "SD";
        let fullService = service === 'rd' ? 'realdebrid' : service === 'ad' ? 'alldebrid' : service === 'tb' ? 'torbox' : 'p2p';

        return {
            name: aioFormatter.formatStreamName({ addonName: "Leviathan", service: fullService, cached: true, quality: quality }),
            title: aioFormatter.formatStreamTitle({ title: displayTitle, size: formatBytes(realSize), language: formatLanguageLabel(lazyLanguage, details.languages), source: item.source, seeders: finalSeeders, infoHash: item.hash, techInfo: `🎞️ ${quality} ${details.tags}` }),
            url: lazyUrl, infoHash: item.hash, behaviorHints: { notWebReady: false, bingieGroup: `Leviathan|${quality}|${service}|${item.hash}` }
        };
    } else {
        const { name, title, bingeGroup } = formatStreamSelector(item.title, item.source, realSize, finalSeeders, service.toUpperCase(), config, item.hash, isLazy, item._isPack);
        return { name, title, url: lazyUrl, infoHash: item.hash, behaviorHints: { notWebReady: false, bingieGroup: bingeGroup } };
    }
}

async function queryRemoteIndexer(tmdbId, type, season = null, episode = null, config, italianMovieTitle = null) { 
    if (!CONFIG.INDEXER_URL) return [];
    try {
        logger.info(`🌐 [REMOTE] Query VPS: ${CONFIG.INDEXER_URL} | ID: ${tmdbId} S:${season} E:${episode}`);
        let url = `${CONFIG.INDEXER_URL}/api/get/${tmdbId}`;
        if (season) url += `?season=${season}`;
        if (episode) url += `&episode=${episode}`;
        const { data } = await axios.get(url, { timeout: CONFIG.TIMEOUTS.REMOTE_INDEXER });
        if (!data || !data.torrents || !Array.isArray(data.torrents)) return [];
        
        const mapped = data.torrents.map(t => {
            let magnet = t.magnet || buildTrackerMagnet(t.info_hash, t.title);
            if (!String(magnet).includes("tr=")) magnet = buildTrackerMagnet(t.info_hash, t.title);
            let providerName = (t.provider || 'P2P').replace(/LeviathanDB/i, '').replace(/[()]/g, '').trim() || 'P2P';
            const finalHash = t.info_hash ? t.info_hash.toUpperCase() : extractInfoHash(magnet);
            return { title: t.title, magnet: magnet, hash: finalHash, infoHash: finalHash, size: "💾 DB", sizeBytes: parseInt(t.size), seeders: parseInt(t.seeders, 10) || 0, source: providerName, fileIdx: t.file_index !== undefined ? parseInt(t.file_index) : undefined, _isPack: isSeasonPack(t.title) };
        });

        const langMode = config && config.filters ? (config.filters.language || (config.filters.allowEng ? "all" : "ita")) : "ita";
        return mapped.filter(item => {
             const title = item.title || '';
             const langInfo = getLanguageInfo(title, italianMovieTitle, item.source, parseTitleDetails(title));
             if (langMode === 'ita') {
                 if (langInfo.isItalian || (langInfo.confidence || 0) >= 4 || langInfo.isMaybeItalian) return true;
                 if (REGEX_SUB_ONLY.test(title) && !REGEX_AUDIO_CONFIRM.test(title)) {
                     const stripped = title.replace(REGEX_SUB_ONLY, ' ');
                     const strippedInfo = getLanguageInfo(stripped, italianMovieTitle, item.source, parseTitleDetails(stripped));
                     return strippedInfo.isItalian || (strippedInfo.confidence || 0) >= 4 || strippedInfo.isMaybeItalian;
                 }
                 return false;
             }
             if (langMode === 'eng') return !langInfo.isItalian || (langInfo.confidence || 0) < 5;
             return true;
        });
    } catch (e) { logger.error("Err Remote Indexer:", { error: e.message }); return []; }
}

async function fetchExternalResults(type, finalId, config) {
    logger.info(`🌐 [EXTERNAL] Start Parallel Fetch...`);
    try {
        const externalResults = await withTimeout(
            fetchExternalAddonsFlat(type, finalId, { userConfig: config }).then(items => items.map(i => {
                const title = i.title || i.filename;
                let finalSeeders = parseInt(i.seeders, 10) || (title ? extractSeeders(title) : 0);
                let finalSize = i.mainFileSize || (title ? extractSize(title) : 0);
                return { title: title, magnet: i.magnetLink, size: i.size || (finalSize > 0 ? formatBytes(finalSize) : null), sizeBytes: finalSize, seeders: finalSeeders, source: i.externalProvider || i.source.replace(/\[EXT\]\s*/, ''), hash: i.infoHash || extractInfoHash(i.magnetLink), infoHash: i.infoHash || extractInfoHash(i.magnetLink), fileIdx: i.fileIdx, isExternal: true, _isPack: isSeasonPack(title) };
            })),
            CONFIG.TIMEOUTS.EXTERNAL, 'External Addons'
        );
        if (externalResults && externalResults.length > 0) {
            logger.info(`✅ [EXTERNAL] Trovati ${externalResults.length} risultati`);
            return externalResults;
        } else {
            logger.info(`❌ [EXTERNAL] Nessun risultato trovato.`);
            return [];
        }
    } catch (err) { logger.warn('External Addons fallito/timeout', { error: err.message }); return []; }
}

async function generateStream(type, id, config, userConfStr, reqHost) {
  const hasDebridKey = (config.key && config.key.length > 0) || (config.rd && config.rd.length > 0);
  const isWebEnabled = config.filters && (config.filters.enableVix || config.filters.enableGhd || config.filters.enableGs || config.filters.enableAnimeWorld || config.filters.enableGf);
  const isP2PEnabled = config.filters && config.filters.enableP2P === true;

  if (!hasDebridKey && !isWebEnabled && !isP2PEnabled) return { streams: [{ name: "⚠️ CONFIG", title: "Inserisci API Key, Attiva P2P o Attiva WebStream" }] };
  
  const configHash = crypto.createHash('md5').update(userConfStr || 'no-conf').digest('hex');
  const cacheKey = `${type}:${id}:${configHash}`;
  
  const cachedResult = await Cache.getCachedStream(cacheKey);
  if (cachedResult) return cachedResult;

  return withSharedPromise(streamInflight, `stream:${cacheKey}`, async () => {
  const cachedAgain = await Cache.getCachedStream(cacheKey);
  if (cachedAgain) return cachedAgain;

  const generationStartedAt = Date.now();
  incrementMetric('stream.generate.calls');
  const userTmdbKey = config.tmdb; 
  let finalId = id.replace('ai-recs:', '');
  
  if (finalId.startsWith("tmdb:")) {
      try {
          const parts = finalId.split(":");
          const imdbId = await tmdbToImdb(parts[1], type, userTmdbKey);
          if (imdbId) finalId = (type === "series" && parts.length >= 4) ? `${imdbId}:${parts[2]}:${parts[3]}` : imdbId;
      } catch (err) {}
  }

  const meta = await LIMITERS.metadata.schedule(() => getMetadata(finalId, type, config));
  if (!meta) return { streams: [] };

  logger.info(`🚀 [SPEED] Start search for: ${meta.title}`);
  
  const tmdbIdLookup = meta.tmdb_id || (meta.kitsu_id ? null : (await imdbToTmdb(meta.imdb_id, userTmdbKey))?.tmdbId);
  const dbOnlyMode = config.filters?.dbOnly === true; 
  const langMode = config.filters?.language || (config.filters?.allowEng ? "all" : "ita");

  const keepItalianCandidate = (title, sourceName) => {
      const langInfo = getLanguageInfo(title, meta.title, sourceName, parseTitleDetails(title));
      if (langInfo.isItalian || (langInfo.confidence || 0) >= 4 || langInfo.isMaybeItalian) return true;
      if (REGEX_SUB_ONLY.test(title) && !REGEX_AUDIO_CONFIRM.test(title)) {
          const strippedTitle = title.replace(REGEX_SUB_ONLY, ' ');
          const strippedInfo = getLanguageInfo(strippedTitle, meta.title, sourceName, parseTitleDetails(strippedTitle));
          return strippedInfo.isItalian || (strippedInfo.confidence || 0) >= 4 || strippedInfo.isMaybeItalian;
      }
      return false;
  };

  const aggressiveFilter = (item) => {
      if (!item?.magnet) return false;
      const source = (item.source || "").toLowerCase(), t = item.title, tLower = t.toLowerCase();
      if (source.includes("comet") || source.includes("stremthru")) return false;

      const parsedLangInfo = getLanguageInfo(t, meta.title, item.source, parseTitleDetails(t));
      if (langMode === "ita") {
           if (!keepItalianCandidate(t, item.source)) return false;
      } else if (langMode === "eng" && parsedLangInfo.isItalian && (parsedLangInfo.confidence || 0) >= 5) return false;
      
      const metaYear = parseInt(meta.year);
      if (metaYear === 2025 && /frankenstein/i.test(meta.title) && !item.title.includes("2025")) return false;
      if (!isNaN(metaYear)) {
           const fileYearMatch = item.title.match(REGEX_YEAR);
           if (fileYearMatch && Math.abs(parseInt(fileYearMatch[0]) - metaYear) > 1) return false; 
      }

      if (!meta.isSeries) {
          const shortQueries = [meta.title, meta.originalTitle].filter(Boolean).map(normalizeSearchText).filter(q => q.length >= 2 && q.length <= 8);
          if (shortQueries.length > 0 && !shortQueries.some(q => isGoodShortQueryMatch(item.title, q))) return false;
      }

      if (meta.isSeries) {
          const s = meta.season, e = meta.episode;
          if ((meta.kitsu_id || type === 'anime') && new RegExp(`(?:^|\\s|[.\\-_\\[\\(])(?:e|ep|episode)?\\s*0*${e}(?:$|\\s|[.\\-_\\]\\)]|v\\d)`, 'i').test(tLower)) return true;

          const wrongSeasonRegex = /(?:s|stagione|season)\s*0?(\d+)(?!\d)/gi;
          let match;
          while ((match = wrongSeasonRegex.exec(tLower)) !== null) if (parseInt(match[1]) !== s && !meta.kitsu_id) return false;

          const xMatch = tLower.match(/(\d+)x(\d+)/i);
          if (xMatch) return (parseInt(xMatch[1]) === s || meta.kitsu_id) && parseInt(xMatch[2]) === e;

          const hasRightSeason = new RegExp(`(?:s|stagione|season|^)\\s*0?${s}(?!\\d)`, 'i').test(tLower);
          const hasRightEpisode = new RegExp(`(?:e|x|ep|episode|^)\\s*0?${e}(?!\\d)`, 'i').test(tLower);
          
          if (hasRightSeason && hasRightEpisode) return true;
          if (hasRightSeason && (isSeasonPack(tLower) || !/(?:e|x|ep|episode)\s*0?\d+/i.test(tLower))) { item._isPack = true; return true; }
          return false;
      } else if (/\b(?:S\d{2}|SEASON|STAGIONE)\b/i.test(t) || /\b\d{1,2}x\d{1,2}\b/.test(t)) return false;

      const cleanFile = tLower.replace(/[\.\_\-\(\)\[\]]/g, " ").replace(/\s{2,}/g, " ").trim();
      const checkMatch = (strToCheck) => {
          if (!strToCheck) return false;
          let searchKeyword = strToCheck.replace(/^(the|a|an|il|lo|la|i|gli|le)\s+/i, "").trim();
          if (searchKeyword === "rip") return /^(the\s+|il\s+)?rip\b/i.test(cleanFile);
          if (!isGoodShortQueryMatch(cleanFile, searchKeyword)) return false;
          return searchKeyword.length <= 3 ? new RegExp(`\\b${searchKeyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(cleanFile) : cleanFile.includes(searchKeyword);
      };

      if (checkMatch(meta.title.toLowerCase().replace(/[\.\_\-\(\)\[\]]/g, " ").replace(/\s{2,}/g, " ").trim())) return true;          
      if (checkMatch(meta.title.split(/ - |: /)[0].toLowerCase().trim())) return true;  
      if (checkMatch((meta.originalTitle || "").toLowerCase().trim())) return true;      
      if (smartMatch(meta.title, item.title, meta.isSeries, meta.season, meta.episode)) return true;
      return false;
  };

  const remotePromise = Cache.fetchWithCache('RemoteIndexer', `${type}:${tmdbIdLookup || finalId}:${meta.season}:${meta.episode}`, 43200, () =>
      guardedProviderCall('RemoteIndexer', LIMITERS.remoteIndexer, CONFIG.TIMEOUTS.REMOTE_INDEXER, () => queryRemoteIndexer(tmdbIdLookup, type, meta.season, meta.episode, config, meta.title))
  );

  let externalPromise = Promise.resolve([]);
  if (!dbOnlyMode) externalPromise = Cache.fetchWithCache('ExternalAddons', `${type}:${finalId}`, 43200, () => guardedProviderCall('ExternalAddons', LIMITERS.externalAddons, CONFIG.TIMEOUTS.EXTERNAL, () => fetchExternalResults(type, finalId, config)));

  const [remoteSettled, externalSettled] = await Promise.allSettled([remotePromise, externalPromise]);
  const remoteResults = remoteSettled.status === 'fulfilled' ? remoteSettled.value : [];
  const externalResults = externalSettled.status === 'fulfilled' ? externalSettled.value : [];
  logger.info(`📊 [STATS] Remote: ${remoteResults.length} | External: ${externalResults.length}`);

  let fastResults = [...remoteResults, ...externalResults].filter(aggressiveFilter);
  let cleanResults = deduplicateResults(fastResults);
  let validFastCount = cleanResults.length;
  logger.info(`⚡ [FAST CHECK] Trovati ${validFastCount} risultati validi da fonti veloci (Remote+External).`);

  if (validFastCount === 0 && !dbOnlyMode) {
      logger.info(`⚠️ [FALLBACK] 0 risultati utili da Indexer/External. Avvio Scrapers in background...`);
      let dynamicTitles = [];
      try { if (tmdbIdLookup) dynamicTitles = await getTmdbAltTitles(tmdbIdLookup, type, userTmdbKey); } catch (e) {}
      
      const allowEngScraper = (langMode === "all" || langMode === "eng");
      const queries = generateSmartQueries(meta, dynamicTitles, allowEngScraper);
      
      if (queries.length > 0) {
          const allScraperTasks = [];
          queries.forEach(q => SCRAPER_MODULES.forEach(scraper => {
              if (scraper.searchMagnet) {
                  allScraperTasks.push(LIMITERS.scraper.schedule(() => 
                      withTimeout(scraper.searchMagnet(q, meta.year, type, finalId, { allowEng: allowEngScraper }), CONFIG.TIMEOUTS.SCRAPER, `Scraper ${scraper.name || 'Module'}`)
                      .catch(err => { logger.warn(`Scraper Timeout/Error: ${err.message}`); return []; })
                  ));
              }
          }));
          const scrapedResultsRaw = (await Promise.allSettled(allScraperTasks)).flatMap(result => result.status === 'fulfilled' ? result.value : []);
          cleanResults = deduplicateResults([...cleanResults, ...scrapedResultsRaw.filter(aggressiveFilter)]);
          validFastCount = cleanResults.length;
          logger.info(`📊 [STATS SCRAPER] Trovati e filtrati ${validFastCount} risultati aggiuntivi dagli Scraper.`);
      }
  }

  if (!dbOnlyMode) saveResultsToDbBackground(meta, cleanResults, config);

  if (config.filters) {
      cleanResults = cleanResults.filter(item => {
          const t = (item.title || "").toLowerCase();
          if (config.filters.maxSizeGB && config.filters.maxSizeGB > 0 && (item._size || item.sizeBytes || 0) > config.filters.maxSizeGB * 1024 * 1024 * 1024) return false;
          if (config.filters.no4k && REGEX_QUALITY_FILTER["4K"].test(t)) return false;
          if (config.filters.no1080 && REGEX_QUALITY_FILTER["1080p"].test(t)) return false;
          if (config.filters.no720 && REGEX_QUALITY_FILTER["720p"].test(t)) return false;
          if (config.filters.noScr && (REGEX_QUALITY_FILTER["SD"].test(t) || /\b(?:cam|hdcam|ts|telesync|screener|scr)\b/i.test(t))) return false;
          if (config.filters.noCam && /\b(?:cam|hdcam|ts|telesync|screener|scr)\b/i.test(t)) return false;
          return true;
      });
  }

  let rankedList = rankAndFilterResults(cleanResults, meta, config);
  const sortMode = config.sort || (config.filters && config.filters.sort) || 'balanced';
  rankedList = rerankCompositeResults(rankedList, meta, config, sortMode);

  if (config.filters && config.filters.maxPerQuality) rankedList = filterByQualityLimit(rankedList, config.filters.maxPerQuality);

  if (config.service === 'tb' && hasDebridKey) {
      const apiKey = config.key || config.rd;
      const sourceRanked = [...rankedList];
      const progressiveWindows = [30, 60, 90];
      let verifiedList = [];
      let usedWindow = 0;

      for (const checkLimit of progressiveWindows) {
          const candidates = sourceRanked.slice(0, checkLimit);
          if (candidates.length === 0) break;
          logger.info(`📦 [TB CHECK] Scansiono ${candidates.length} torrent alla ricerca di file video reali...`);
          const cacheResults = await LIMITERS.tbResolve.schedule(() => TbCache.checkCacheSync(candidates, apiKey, dbHelper, checkLimit));
          verifiedList = [];
          for (const item of candidates) {
              const hash = item.hash.toLowerCase();
              const result = cacheResults[hash];
              if (result && result.cached === true) {
                  item._tbCached = true;
                  if (result.file_size) item._size = result.file_size;
                  if (result.file_id !== undefined && result.file_id !== null) item.fileIdx = result.file_id;
                  verifiedList.push(item);
              }
          }
          usedWindow = candidates.length;
          if (verifiedList.length >= Math.min(12, CONFIG.MAX_RESULTS) || checkLimit === progressiveWindows[progressiveWindows.length - 1]) break;
      }

      logger.info(`📦 [TB CLEANUP] Finestra usata: ${usedWindow} -> Rimasti: ${verifiedList.length}`);
      rankedList = verifiedList;
      const remainingItems = sourceRanked.slice(usedWindow);
      if (remainingItems.length > 0) TbCache.enrichCacheBackground(remainingItems, apiKey, dbHelper);
  }

  let finalRanked = rankedList.slice(0, CONFIG.MAX_RESULTS);
  let debridStreams = [];
  
  if (finalRanked.length > 0 && hasDebridKey) {
      const TOP_LIMIT = Math.max(0, Math.min(10, parseInt(config.filters?.instantDebridTop ?? process.env.INSTANT_DEBRID_TOP ?? '0', 10) || 0));
      const serviceLimiter = getServiceResolverLimiter(config.service);
      const immediatePromises = finalRanked.slice(0, TOP_LIMIT).map(item => {
          item.season = meta.season;
          item.episode = meta.episode;
          config.rawConf = userConfStr;
          return serviceLimiter.schedule(() => resolveDebridLink(config, item, config.filters?.showFake, reqHost, meta));
      });
      const lazyCandidates = finalRanked.slice(TOP_LIMIT).map(item => {
          item.season = meta.season;
          item.episode = meta.episode;
          return item;
      });
      const lazyStreams = lazyCandidates.map(item => generateLazyStream(item, config, meta, reqHost, userConfStr, true));
      const resolvedInstant = (await Promise.allSettled(immediatePromises)).flatMap(result => result.status === 'fulfilled' && result.value ? [result.value] : []);
      debridStreams = [...resolvedInstant, ...lazyStreams];
      warmupLazyStreamsInBackground(config, lazyCandidates, meta);
  }
  else if (finalRanked.length > 0 && isP2PEnabled) {
      logger.info(`⚡ [P2P MODE] Generating direct streams for ${meta.title}`);
      debridStreams = finalRanked.map(item => P2P.formatP2PStream(item, config));
  }

  let rawVix = [], formattedGhd = [], formattedGs = [], formattedVix = [], formattedAw = [], formattedGf = [];

  if (!dbOnlyMode) {
       const rawId = `${type}:${finalId}:${meta.season || 0}:${meta.episode || 0}`;
       let vixPromise = Promise.resolve([]);
       let ghdPromise = Promise.resolve([]), gsPromise = Promise.resolve([]), awPromise = Promise.resolve([]), gfPromise = Promise.resolve([]);
       if (config.filters?.enableVix) vixPromise = Cache.fetchWithCache('Vix', rawId, 43200, () => guardedProviderCall('Vix', LIMITERS.webVix, CONFIG.TIMEOUTS.SCRAPER, () => searchVix(meta, config, reqHost)));
       if (config.filters?.enableGhd) ghdPromise = Cache.fetchWithCache('GuardaHD', rawId, 43200, () => guardedProviderCall('GuardaHD', LIMITERS.webGhd, CONFIG.TIMEOUTS.SCRAPER, () => searchGuardaHD(meta, config)));
       if (config.filters?.enableGs) gsPromise = Cache.fetchWithCache('GuardaSerie', rawId, 43200, () => guardedProviderCall('GuardaSerie', LIMITERS.webGs, CONFIG.TIMEOUTS.SCRAPER, () => searchGuardaserie(meta, config)));
       if (config.filters?.enableAnimeWorld) awPromise = Cache.fetchWithCache('AnimeWorld', rawId, 43200, () => guardedProviderCall('AnimeWorld', LIMITERS.webAw, CONFIG.TIMEOUTS.SCRAPER, () => searchAnimeWorld(id, meta, config)));
       if (config.filters?.enableGf) gfPromise = Cache.fetchWithCache('GuardaFlix', rawId, 43200, () => guardedProviderCall('GuardaFlix', LIMITERS.webGf, CONFIG.TIMEOUTS.SCRAPER, () => searchGuardaFlix(meta, config)));

       const webSettled = await Promise.allSettled([vixPromise, ghdPromise, gsPromise, awPromise, gfPromise]);
       rawVix = webSettled[0].status === 'fulfilled' ? webSettled[0].value : [];
       formattedGhd = webSettled[1].status === 'fulfilled' ? webSettled[1].value : [];
       formattedGs = webSettled[2].status === 'fulfilled' ? webSettled[2].value : [];
       formattedAw = webSettled[3].status === 'fulfilled' ? webSettled[3].value : [];
       formattedGf = webSettled[4].status === 'fulfilled' ? webSettled[4].value : [];
       
       if (aioFormatter && aioFormatter.isAIOStreamsEnabled(config)) {
           const applyAioStyle = (streamList, sourceName) => {
               if (!streamList || !Array.isArray(streamList)) return;
               streamList.forEach((stream) => {
                   let quality = "HD", qIcon = "📺", textToCheck = (stream.title + " " + (stream.name || "")).toUpperCase().replace(/GUARDAHD|STREAMINGCOMMUNITY|LEVIATHAN|VIX|GUARDAFLIX/g, "");
                   if (/\b(4K|2160P|UHD)\b/.test(textToCheck)) { quality = "4K"; qIcon = "🔥"; }
                   else if (/\b(1080P|FHD|FULLHD)\b/.test(textToCheck)) { quality = "1080p"; qIcon = "🔥"; }
                   else if (/\b(720P|HD)\b/.test(textToCheck)) { quality = "720p"; qIcon = "🔥"; }
                   else if (/\b(480P|SD)\b/.test(textToCheck)) { quality = "SD"; qIcon = "🔥"; }
                   else { quality = "WebStreams"; }
                   if (sourceName.includes("StreamingCommunity") || sourceName.includes("Vix")) {
                       if (quality === "SD" && !/\b(480P|SD)\b/.test(textToCheck)) { quality = "1080p"; qIcon = "🔥"; }
                   }
                   stream.name = aioFormatter.formatStreamName({ service: "web", cached: true, quality: quality });
                   stream.title = aioFormatter.formatStreamTitle({ title: meta.title, size: "Web", language: "🇮🇹 ITA", source: sourceName, seeders: null, techInfo: `🎞️ ${quality} ${qIcon}` });
                   if (!stream.behaviorHints) stream.behaviorHints = {};
                   stream.behaviorHints.bingieGroup = `Leviathan|${quality}|Web|${sourceName.replace(/\W/g,'')}`;
               });
           };
           if (typeof rawVix !== 'undefined') applyAioStyle(rawVix, "StreamingCommunity");
           if (typeof formattedGhd !== 'undefined') applyAioStyle(formattedGhd, "GuardaHD");
           if (typeof formattedGs !== 'undefined') applyAioStyle(formattedGs, "GuardaSerie");
           if (typeof formattedGf !== 'undefined') applyAioStyle(formattedGf, "GuardaFlix");
           if (typeof formattedAw !== 'undefined' && formattedAw.length > 0) {
               formattedAw.forEach(stream => {
                   stream.name = aioFormatter.formatStreamName({ service: "web", cached: true, quality: "HD" });
                   stream.title = aioFormatter.formatStreamTitle({ title: meta.title, size: "Web", language: "🇯🇵 JPN/ITA", source: "AnimeWorld", techInfo: "⛩️ Anime" });
                   if (!stream.behaviorHints) stream.behaviorHints = {};
                   stream.behaviorHints.bingieGroup = `Leviathan|HD|Web|AnimeWorld`;
               });
           }
           formattedVix = rawVix; 
       } else {
           if (rawVix && rawVix.length > 0) formattedVix = applyWebFormatter(rawVix, "StreamingCommunity", meta, config);
           if (formattedGhd && formattedGhd.length > 0) formattedGhd = applyWebFormatter(formattedGhd, "GuardaHD", meta, config);
           if (formattedGs && formattedGs.length > 0) formattedGs = applyWebFormatter(formattedGs, "GuardaSerie", meta, config);
           if (formattedAw && formattedAw.length > 0) formattedAw = applyWebFormatter(formattedAw, "AnimeWorld", meta, config);
           if (formattedGf && formattedGf.length > 0) formattedGf = applyWebFormatter(formattedGf, "GuardaFlix", meta, config);
       }
  }

  let finalStreams = (config.filters && config.filters.vixLast === true) ? [...debridStreams, ...formattedGhd, ...formattedGs, ...formattedAw, ...formattedGf, ...formattedVix] : [...formattedGhd, ...formattedGs, ...formattedAw, ...formattedGf, ...formattedVix, ...debridStreams];

  if (config.filters) {
      finalStreams = finalStreams.filter(stream => {
          const checkStr = (stream.title + " " + (stream.name || "")).toUpperCase();
          if (config.filters.no720 && (checkStr.includes("720P") || (/\bHD\b/.test(checkStr) && !/1080|2160|4K|FHD|UHD/.test(checkStr)))) return false;
          if (config.filters.no4k && (checkStr.includes("4K") || checkStr.includes("2160P") || checkStr.includes("UHD"))) return false;
          if (config.filters.no1080 && (checkStr.includes("1080P") || checkStr.includes("FHD") || checkStr.includes("FULLHD"))) return false;
          if ((config.filters.noScr || config.filters.noCam) && /CAM|SCR|TS|TELESYNC|HDCAM/.test(checkStr)) return false;
          return true;
      });
  }

  if (finalStreams.length === 0) {
      logger.info(`⚠️ [FALLBACK] Nessun risultato trovato (P2P/Web Locali). Attivo WebStreamr...`);
      const webStreamrResults = await searchWebStreamr(type, finalId);
      if (webStreamrResults.length > 0) {
           finalStreams.push(...webStreamrResults);
           logger.info(`🕷️ [WEBSTREAMR] Aggiunti ${webStreamrResults.length} stream di fallback.`);
      } else { logger.info(`❌ [WEBSTREAMR] Nessun risultato trovato.`); }
  }

  
  const resultObj = { streams: finalStreams };
  const streamTtl = finalStreams.length > 0 ? 1800 : EMPTY_STREAM_TTL;
  await Cache.cacheStream(cacheKey, resultObj, streamTtl);
  recordDuration('stream.generate.total', Date.now() - generationStartedAt);
  incrementMetric(finalStreams.length > 0 ? 'stream.generate.nonEmpty' : 'stream.generate.empty');
  logger.info(`💾 SAVED TO CACHE: ${cacheKey} (ttl=${streamTtl}s, streams=${finalStreams.length})`);
  return resultObj;
  });
}

module.exports = { generateStream, getMetadata, resolveDebridLink, RD, AD, TB };
