'use strict';

const crypto = require('crypto');
const { withSharedPromise } = require('../../utils/common');
const { getRequestOrigin } = require('../../utils/url');
const RD = require('../../debrid/rd/clients/realdebrid_client');
const TB = require('../../debrid/tb/clients/torbox_client');
const { registerLazyExtractionRoute } = require('../../../providers/extractors/lazy_extraction');
const { buildContentProxyUrlFromRequest, shouldProxyContentUrl } = require('../../proxy/content_proxy_engine');
const {
    buildProxyUrl: buildMediaflowGatewayProxyUrl,
    getMediaflowBase
} = require('../../proxy/mediaflow_gateway');
const TorrentInfoLedger = require('../../torrent/torrent_info_ledger');

const savedCloudResolveInflight = new Map();

function tokenFingerprint(value) {
    return crypto.createHash('sha256').update(String(value || '')).digest('hex').slice(0, 16);
}

function normalizeHash40(value = '') {
    const raw = String(value || '').trim().toUpperCase().replace(/[^A-F0-9]/g, '');
    return /^[A-F0-9]{40}$/.test(raw) ? raw : null;
}

function buildTbMediaId(meta = {}) {
    const imdb = String(meta?.imdb_id || meta?.imdbId || '').trim().toLowerCase();
    if (!/^tt\d+$/.test(imdb)) return null;
    const season = Number(meta?.season || 0) || 0;
    const episode = Number(meta?.episode || 0) || 0;
    return season > 0 && episode > 0 ? `${imdb}:s${season}:e${episode}` : imdb;
}

function buildTbAvailabilityKeys(hash, fileIdx, meta = {}) {
    const normalizedHash = normalizeHash40(hash);
    if (!normalizedHash) return [];
    const mediaId = buildTbMediaId(meta);
    const normalizedFileIdx = Number.isInteger(Number(fileIdx)) && Number(fileIdx) >= 0 ? Number(fileIdx) : null;
    const baseAuto = `tb:${normalizedHash}:auto`;
    const keys = [];
    if (normalizedFileIdx !== null) keys.push(`tb:${normalizedHash}:${normalizedFileIdx}${mediaId ? `:${mediaId}` : ''}`);
    keys.push(`${baseAuto}${mediaId ? `:${mediaId}` : ''}`);
    if (!mediaId) keys.push(baseAuto);
    return [...new Set(keys)];
}


function normalizeMovieTextForTb(value = '') {
    return String(value || '')
        .toLowerCase()
        .normalize('NFKD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/\.[a-z0-9]{2,4}$/i, ' ')
        .replace(/\b(?:19|20)\d{2}\b/g, ' ')
        .replace(/\b(?:2160p|1080p|720p|480p|4k|uhd|hdr|bluray|bdrip|brrip|web[- ]?dl|webrip|remux|x264|x265|h264|h265|hevc|ita|eng|sub|multi|dual)\b/gi, ' ')
        .replace(/[\[\](){}._:+\-–—]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function tbMovieYears(value = '') {
    const years = [];
    const re = /\b(19\d{2}|20\d{2})\b/g;
    let match;
    while ((match = re.exec(String(value || ''))) !== null) years.push(Number(match[1]));
    return [...new Set(years)];
}

function tbMovieOrdinals(value = '') {
    const text = normalizeMovieTextForTb(value);
    const out = new Set();
    const roman = { i: 1, ii: 2, iii: 3, iv: 4, v: 5, vi: 6, vii: 7, viii: 8, ix: 9, x: 10 };
    const re = /\b(?:chapter|capitolo|part|parte)\s*(\d{1,2}|ii|iii|iv|v|vi|vii|viii|ix|x)\b|(?:^|\s)(\d{1,2}|ii|iii|iv|v|vi|vii|viii|ix|x)(?=\s|$)/gi;
    let match;
    while ((match = re.exec(text)) !== null) {
        const token = String(match[1] || match[2] || '').toLowerCase();
        const n = Number.isInteger(Number(token)) ? Number(token) : roman[token];
        if (Number.isFinite(n) && n > 0 && n <= 20) out.add(n);
    }
    return out;
}

function tbMovieFileTitleLooksCompatible(fileTitle = '', meta = {}) {
    const targetTitles = [meta?.title, meta?.originalTitle, meta?.original_title].filter(Boolean);
    if (!fileTitle || targetTitles.length === 0) return true;
    const targetYear = Number(meta?.year || 0) || 0;
    const years = tbMovieYears(fileTitle);
    if (targetYear > 0 && years.length > 0 && !years.some((year) => Math.abs(year - targetYear) <= 1)) return false;
    const fileKey = normalizeMovieTextForTb(fileTitle);
    const fileOrdinals = tbMovieOrdinals(fileTitle);
    for (const title of targetTitles) {
        const targetKey = normalizeMovieTextForTb(title);
        const targetTokens = targetKey.split(/\s+/).filter((token) => token.length >= 2 && !['the','and','of','il','lo','la','un','una','uno','di','del','della','e'].includes(token));
        if (targetTokens.length === 0) continue;
        const targetOrdinals = tbMovieOrdinals(title);
        if (targetOrdinals.size > 0 && fileOrdinals.size > 0 && ![...targetOrdinals].some((n) => fileOrdinals.has(n))) continue;
        const shared = targetTokens.filter((token) => fileKey.includes(token));
        const required = targetTokens.length <= 2 ? targetTokens.length : Math.ceil(targetTokens.length * 0.55);
        if (shared.length >= Math.max(1, required)) return true;
    }
    return false;
}

function getTbAvailabilityFastPayload(payload = {}, requestedFileIdx = null, meta = {}) {
    const state = String(payload.state || payload.tb_cache_state || payload.cache_state || '').toLowerCase();
    const confidence = Number(payload.confidence || 0) || 0;
    const fileId = parseFileIndex(payload.file_id ?? payload.tb_file_id ?? payload.fileId);
    const requested = parseFileIndex(requestedFileIdx);
    if (state !== 'cached_verified') return null;
    if (!Number.isInteger(fileId)) return null;
    if (confidence < 0.75) return null;
    if (Number.isInteger(requested) && requested !== fileId) return null;
    if (String(meta?.type || '').toLowerCase() === 'movie' && !tbMovieFileTitleLooksCompatible(payload.file_title || payload.filename || '', meta)) return null;
    return {
        fileId,
        confidence,
        fileTitle: payload.file_title || payload.filename || null,
        fileSize: Number(payload.file_size || payload.size || 0) || null,
        matchReason: payload.match_reason || 'availability_cache'
    };
}

async function readTbAvailabilityFastPayload(dbHelper, hash, fileIdx, meta = {}) {
    if (!dbHelper || typeof dbHelper.getDebridAvailabilityCache !== 'function') return null;
    const keys = buildTbAvailabilityKeys(hash, fileIdx, meta);
    if (keys.length === 0) return null;
    try {
        const persisted = await dbHelper.getDebridAvailabilityCache(keys);
        for (const key of keys) {
            const payload = persisted?.[key];
            const fast = getTbAvailabilityFastPayload(payload, fileIdx, meta);
            if (fast) return { ...fast, cacheKey: key };
        }
    } catch (_) {}
    return null;
}

function getResolvedDbTtlSeconds(streamData = {}, fallback = 1800) {
    const explicit = Number(streamData.expires_in || streamData.expiresIn || streamData.ttl || 0) || 0;
    if (explicit > 0) return Math.max(60, Math.min(explicit - 60, 2 * 60 * 60));
    const expiresAt = streamData.expires_at || streamData.expiresAt || null;
    if (expiresAt) {
        const ms = new Date(expiresAt).getTime() - Date.now() - 60000;
        if (Number.isFinite(ms) && ms > 0) return Math.max(60, Math.min(Math.floor(ms / 1000), 2 * 60 * 60));
    }
    return Math.max(300, Math.min(Number(process.env.TB_RESOLVED_LINK_TTL_SECONDS || fallback) || fallback, 2 * 60 * 60));
}

async function getPersistedResolvedLink(dbHelper, cacheKey) {
    if (!dbHelper || typeof dbHelper.getDebridResolvedLinkCache !== 'function') return null;
    try { return await dbHelper.getDebridResolvedLinkCache(cacheKey); } catch (_) { return null; }
}

async function persistResolvedLink(dbHelper, cacheKey, service, tokenFp, streamData, extra = {}) {
    if (!dbHelper || typeof dbHelper.setDebridResolvedLinkCache !== 'function' || !streamData?.url) return;
    try {
        await dbHelper.setDebridResolvedLinkCache({
            cache_key: cacheKey,
            service,
            token_fp: tokenFp,
            torrent_id: extra.torrentId || streamData.torrent_id || null,
            file_id: extra.fileId ?? streamData.file_id ?? streamData.tb_file_id ?? null,
            info_hash: extra.hash || streamData.hash || null,
            media_id: extra.mediaId || null,
            url: streamData.url,
            filename: streamData.filename || streamData.fileName || extra.filename || null,
            file_size: streamData.file_size || streamData.size || extra.fileSize || null,
            payload: { ...streamData, rawUrl: streamData.url, url: streamData.url },
            ttlSeconds: getResolvedDbTtlSeconds(streamData, extra.ttlSeconds || 1800)
        });
    } catch (_) {}
}

function extractInfoHashFromText(value = '') {
    const text = String(value || '');
    const match = text.match(/(?:btih:|\/)([A-Fa-f0-9]{40})(?:[&/?#]|$)/i) || text.match(/\b([A-Fa-f0-9]{40})\b/i);
    return match ? String(match[1]).toUpperCase() : null;
}

function registerPlaybackRoutes(app, {
    Cache,
    LIMITERS,
    getConfig,
    buildTrackerMagnet,
    resolveLazyStreamData,
    logger,
    recordDuration,
    recordProviderMetric,
    incrementMetric,
    markPlayableResultAsCached,
    markPlayableResultAsUnavailable,
    queueCloudBuild,
    getBuildKey,
    dbHelper
}) {
    function maybeProxyResolvedUrl(req, conf, targetUrl, config, options = {}) {
        if (!shouldProxyContentUrl(config, { targetUrl, ...options })) return targetUrl;
        return buildContentProxyUrlFromRequest(req, conf, targetUrl, {
            source: options.source || 'debrid',
            filename: options.filename || '',
            headers: options.headers || {},
            ttlSeconds: options.ttlSeconds
        }) || targetUrl;
    }

    function maybeMediaflowUrl(targetUrl, config) {
        if (!targetUrl || !(config.mediaflow && config.mediaflow.proxyDebrid && getMediaflowBase(config))) return targetUrl;
        try {
            return buildMediaflowGatewayProxyUrl(config, targetUrl, {}, {
                isHls: false,
                allowCookie: false
            }) || targetUrl;
        } catch (_) {
            return targetUrl;
        }
    }

    function preferLeviathanProxy(config = {}) {
        // Safe hardcoded default: keep Mediaflow first when configured. Leviathan content proxy
        // is still used as fallback for direct/web URLs when Mediaflow is not applied.
        const preferMediaflowFirst = config?.contentProxy?.preferMediaflow !== false;
        return !preferMediaflowFirst && shouldProxyContentUrl(config, { targetUrl: 'https://example.invalid/video.mp4', source: 'debrid' });
    }

    function buildFinalPlaybackUrl(req, conf, targetUrl, config, options = {}) {
        if (!targetUrl) return targetUrl;
        if (preferLeviathanProxy(config)) return maybeProxyResolvedUrl(req, conf, targetUrl, config, options);
        const mediaflowUrl = maybeMediaflowUrl(targetUrl, config);
        if (mediaflowUrl !== targetUrl) return mediaflowUrl;
        return maybeProxyResolvedUrl(req, conf, targetUrl, config, options);
    }

    function getDebridApiKey(config = {}, service = '') {
        const normalized = String(service || config?.service || '').toLowerCase();
        if (normalized === 'tb') return config.key || config.tb || config.torbox || config.rd || null;
        if (normalized === 'rd') return config.key || config.rd || config.realdebrid || config.realDebrid || config.real_debrid || null;
        return null;
    }

    function parsePositiveInt(value, fallback = 0) {
        const parsed = Number.parseInt(value, 10);
        return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
    }

    function buildRdDownloadPlaybackContext(req, hash, magnet) {
        const season = parsePositiveInt(req.query?.s, 0);
        const episode = parsePositiveInt(req.query?.e, 0);
        const fileIdx = parseFileIndex(req.query?.f);
        const normalizedHash = String(hash || '').toUpperCase();
        const item = {
            title: `RD Download (${normalizedHash.slice(0, 8)})`,
            hash: normalizedHash,
            season,
            episode,
            fileIdx: Number.isInteger(fileIdx) ? fileIdx : undefined,
            magnet
        };
        const meta = {
            imdb_id: req.query?.imdb ? String(req.query.imdb) : null,
            season,
            episode,
            type: season > 0 || episode > 0 ? 'series' : 'movie',
            title: item.title
        };
        return { item, meta, season, episode, fileIdx };
    }

    async function tryResolveRdDownloadFallback(req, conf, hash, apiKey, config, magnet) {
        if (!/^magnet:\?/i.test(String(magnet || ''))) return null;
        const startedAt = Date.now();
        const { item, meta, season, episode, fileIdx } = buildRdDownloadPlaybackContext(req, hash, magnet);
        const lazyCacheKey = `rd:${item.hash}:${season || 0}:${episode || 0}:${Number.isInteger(fileIdx) ? fileIdx : -1}`;

        try {
            const cachedLazy = await Cache.getLazyLink(lazyCacheKey);
            if (cachedLazy && (cachedLazy.rawUrl || cachedLazy.url)) {
                const cachedTargetUrl = cachedLazy.rawUrl || cachedLazy.url;
                const finalCachedUrl = buildFinalPlaybackUrl(req, conf, cachedTargetUrl, config, {
                    source: 'rd',
                    debrid: true,
                    filename: cachedLazy.filename || cachedLazy.fileName || item.title
                });
                await markPlayableResultAsCached('rd', item, { ...cachedLazy, url: finalCachedUrl, rawUrl: cachedTargetUrl }, meta);
                incrementMetric('rdDownloadFallback.cacheHit');
                recordDuration('rdDownloadFallback.total', Date.now() - startedAt);
                logger.info(`[RD DOWNLOAD PLAY] cache hit | hash=${item.hash} | fileIdx=${item.fileIdx ?? 'n/a'}`);
                return finalCachedUrl;
            }

            const streamData = await LIMITERS.lazyPlay.schedule(() =>
                RD.getStreamLink(apiKey, magnet, season || 0, episode || 0, Number.isInteger(fileIdx) ? fileIdx : null)
            );

            if (!streamData || !streamData.url) {
                await markPlayableResultAsUnavailable?.('rd', item, meta, 'rd_download_fallback_miss');
                incrementMetric('rdDownloadFallback.miss');
                recordDuration('rdDownloadFallback.total', Date.now() - startedAt);
                return null;
            }

            const finalUrl = buildFinalPlaybackUrl(req, conf, streamData.url, config, {
                source: 'rd',
                debrid: true,
                filename: streamData.filename || item.title
            });
            await Cache.cacheLazyLink(lazyCacheKey, { ...streamData, rawUrl: streamData.url, url: streamData.url }, 180);
            await markPlayableResultAsCached('rd', item, { ...streamData, url: finalUrl, rawUrl: streamData.url }, meta);
            TorrentInfoLedger.recordResolvedFileIndex({
                meta,
                item,
                streamData,
                service: 'rd',
                dbHelper,
                logger,
                reason: 'rd_download_fallback_play'
            }).catch(() => {});
            incrementMetric('rdDownloadFallback.success');
            recordDuration('rdDownloadFallback.total', Date.now() - startedAt);
            recordProviderMetric('rdDownloadFallback.rd', true, Date.now() - startedAt);
            logger.info(`[RD DOWNLOAD PLAY] resolved playable URL | hash=${item.hash} | fileIdx=${streamData.file_index ?? streamData.rd_file_index ?? item.fileIdx ?? 'n/a'}`);
            return finalUrl;
        } catch (err) {
            recordDuration('rdDownloadFallback.total', Date.now() - startedAt);
            recordProviderMetric('rdDownloadFallback.rd', false, Date.now() - startedAt, { error: err.message });
            logger.warn(`[RD DOWNLOAD PLAY] resolve failed | hash=${item.hash} | error=${err.message}`);
            return null;
        }
    }

    function parseFileIndex(value) {
        if (value === null || value === undefined || value === '') return NaN;
        const parsed = Number(value);
        return Number.isInteger(parsed) && parsed >= 0 ? parsed : NaN;
    }

    function getStreamDataFileIndex(data = {}) {
        const candidates = [
            data.tb_file_id,
            data.file_id,
            data.file_index,
            data.fileIdx,
            data.rd_file_index
        ];
        for (const candidate of candidates) {
            const parsed = parseFileIndex(candidate);
            if (Number.isInteger(parsed)) return parsed;
        }
        return NaN;
    }

    function isLazyCacheCompatibleWithRequest(cachedLazy, item) {
        const requestedIdx = parseFileIndex(item?.fileIdx);
        if (!Number.isInteger(requestedIdx)) return true;
        const cachedIdx = getStreamDataFileIndex(cachedLazy);
        return !Number.isInteger(cachedIdx) || cachedIdx === requestedIdx;
    }

    registerLazyExtractionRoute(app, { logger });

    app.get('/:conf/play_lazy/:service/:hash/:fileIdx', async (req, res) => {
        const { conf, service, hash, fileIdx } = req.params;
        const { s, e, imdb } = req.query;
        const startedAt = Date.now();
        const requestedService = String(service || '').toLowerCase();
        logger.info(`[LAZY PLAY] Service: ${requestedService} | Hash: ${hash} | Idx: ${fileIdx} | S${s}E${e}`);
        try {
            if (!['rd', 'tb'].includes(requestedService)) return res.status(400).send('Servizio Debrid non supportato.');
            const config = getConfig(conf);
            const apiKey = getDebridApiKey(config, requestedService);
            if (!apiKey) return res.status(400).send('API Key mancante.');
            const magnet = buildTrackerMagnet(hash);
            const item = {
                title: `Unknown Video (${hash})`,
                hash: String(hash || '').toUpperCase(),
                season: parseInt(s, 10) || 0,
                episode: parseInt(e, 10) || 0,
                fileIdx: parseInt(fileIdx, 10) === -1 ? undefined : parseInt(fileIdx, 10),
                magnet
            };
            const lazyCacheKey = `${requestedService}:${item.hash}:${item.season || 0}:${item.episode || 0}:${item.fileIdx !== undefined ? item.fileIdx : -1}`;
            const cachedPlaybackMeta = await Cache.getLazyMeta(lazyCacheKey);
            const playbackMeta = imdb ? {
                imdb_id: String(imdb),
                season: item.season || 0,
                episode: item.episode || 0,
                type: (item.season || 0) > 0 || (item.episode || 0) > 0 ? 'series' : 'movie',
                title: cachedPlaybackMeta?.title || item.title,
                originalTitle: cachedPlaybackMeta?.originalTitle || cachedPlaybackMeta?.original_title || null,
                year: cachedPlaybackMeta?.year || null,
                source: cachedPlaybackMeta?.source || null,
                seeders: Number(cachedPlaybackMeta?.seeders || 0) || 0,
                size: Number(cachedPlaybackMeta?.size || 0) || 0
            } : (cachedPlaybackMeta?.imdb_id ? {
                imdb_id: String(cachedPlaybackMeta.imdb_id),
                season: item.season || cachedPlaybackMeta.season || 0,
                episode: item.episode || cachedPlaybackMeta.episode || 0,
                type: cachedPlaybackMeta.type || ((item.season || 0) > 0 || (item.episode || 0) > 0 ? 'series' : 'movie'),
                title: cachedPlaybackMeta.title || item.title,
                originalTitle: cachedPlaybackMeta.originalTitle || cachedPlaybackMeta.original_title || null,
                year: cachedPlaybackMeta.year || null,
                source: cachedPlaybackMeta.source || null,
                seeders: Number(cachedPlaybackMeta?.seeders || 0) || 0,
                size: Number(cachedPlaybackMeta?.size || 0) || 0
            } : null);
            if (playbackMeta?.title) item.title = playbackMeta.title;
            if (playbackMeta?.source) item.source = playbackMeta.source;
            if (playbackMeta?.year) item.year = playbackMeta.year;
            if (playbackMeta?.originalTitle) item.originalTitle = playbackMeta.originalTitle;
            if (Number(playbackMeta?.seeders || 0) > 0) item.seeders = Number(playbackMeta.seeders);
            if (Number(playbackMeta?.size || 0) > 0) {
                item._size = Number(playbackMeta.size);
                item.sizeBytes = Number(playbackMeta.size);
            }
            const cachedLazy = await Cache.getLazyLink(lazyCacheKey);
            if (cachedLazy && (cachedLazy.rawUrl || cachedLazy.url)) {
                if (isLazyCacheCompatibleWithRequest(cachedLazy, item)) {
                    const cachedTargetUrl = cachedLazy.rawUrl || cachedLazy.url;
                    const finalCachedUrl = buildFinalPlaybackUrl(req, conf, cachedTargetUrl, config, {
                        source: requestedService,
                        debrid: true,
                        filename: cachedLazy.filename || cachedLazy.fileName || cachedPlaybackMeta?.title || item.title
                    });
                    await markPlayableResultAsCached(requestedService, item, { ...cachedLazy, url: finalCachedUrl, rawUrl: cachedTargetUrl }, playbackMeta);
                    incrementMetric('lazyPlay.cacheHit');
                    recordDuration('lazyPlay.total', Date.now() - startedAt);
                    return res.redirect(finalCachedUrl);
                }
                logger.warn(`[LAZY PLAY] Ignoro lazy cache con fileIdx mismatch | service=${requestedService} | hash=${item.hash} | requested=${item.fileIdx ?? 'n/a'} | cached=${getStreamDataFileIndex(cachedLazy)}`);
            }

            const tokenFp = tokenFingerprint(apiKey);
            const persistedLazyKey = `lazy:${requestedService}:${tokenFp}:${item.hash}:${item.season || 0}:${item.episode || 0}:${item.fileIdx !== undefined ? item.fileIdx : -1}:${requestedService === 'tb' ? (req.ip || '') : ''}`;
            const persistedLazy = await getPersistedResolvedLink(dbHelper, persistedLazyKey);
            if (persistedLazy && (persistedLazy.rawUrl || persistedLazy.url) && isLazyCacheCompatibleWithRequest(persistedLazy, item)) {
                const cachedTargetUrl = persistedLazy.rawUrl || persistedLazy.url;
                const finalCachedUrl = buildFinalPlaybackUrl(req, conf, cachedTargetUrl, config, {
                    source: requestedService,
                    debrid: true,
                    filename: persistedLazy.filename || persistedLazy.fileName || cachedPlaybackMeta?.title || item.title
                });
                await Cache.cacheLazyLink(lazyCacheKey, { ...persistedLazy, rawUrl: cachedTargetUrl, url: cachedTargetUrl }, Math.min(getResolvedDbTtlSeconds(persistedLazy), 1800));
                await markPlayableResultAsCached(requestedService, item, { ...persistedLazy, url: finalCachedUrl, rawUrl: cachedTargetUrl }, playbackMeta);
                incrementMetric('lazyPlay.dbResolvedCacheHit');
                recordDuration('lazyPlay.total', Date.now() - startedAt);
                return res.redirect(finalCachedUrl);
            }

            let streamData = null;
            if (requestedService === 'tb') {
                const fastAvailability = await readTbAvailabilityFastPayload(dbHelper, item.hash, item.fileIdx, playbackMeta || { imdb_id: imdb || null, season: item.season, episode: item.episode });
                if (fastAvailability) {
                    streamData = await LIMITERS.lazyPlay.schedule(() => TB.resolveFromAvailability(
                        apiKey,
                        magnet,
                        item.hash,
                        fastAvailability.fileId,
                        item.season || 0,
                        item.episode || 0,
                        req.ip || null,
                        {
                            filename: fastAvailability.fileTitle || item.title,
                            fileTitle: fastAvailability.fileTitle || null,
                            fileSize: fastAvailability.fileSize || null,
                            confidence: fastAvailability.confidence,
                            matchReason: fastAvailability.matchReason,
                            title: playbackMeta?.title || item.title,
                            originalTitle: playbackMeta?.originalTitle || null,
                            year: playbackMeta?.year || null
                        }
                    ));
                    if (streamData?.url) incrementMetric('lazyPlay.tbAvailabilityFastPath');
                }
            }

            if (!streamData) {
                streamData = await LIMITERS.lazyPlay.schedule(() =>
                    resolveLazyStreamData(requestedService, apiKey, item, { ...(playbackMeta || {}), season: item.season, episode: item.episode, title: playbackMeta?.title || item.title, originalTitle: playbackMeta?.originalTitle || item.originalTitle || null, year: playbackMeta?.year || item.year || null })
                );
            }

            if (streamData && streamData.url) {
                const finalUrl = buildFinalPlaybackUrl(req, conf, streamData.url, config, {
                    source: requestedService,
                    debrid: true,
                    filename: streamData.filename || playbackMeta?.title || item.title
                });
                await Cache.cacheLazyLink(lazyCacheKey, { ...streamData, rawUrl: streamData.url, url: streamData.url }, Math.min(getResolvedDbTtlSeconds(streamData), 1800));
                await persistResolvedLink(dbHelper, persistedLazyKey, requestedService, tokenFingerprint(apiKey), streamData, {
                    hash: item.hash,
                    fileId: streamData.file_id ?? streamData.tb_file_id ?? item.fileIdx,
                    filename: streamData.filename || playbackMeta?.title || item.title,
                    fileSize: streamData.file_size || streamData.size || null,
                    mediaId: buildTbMediaId(playbackMeta || { imdb_id: imdb || null, season: item.season, episode: item.episode })
                });
                await markPlayableResultAsCached(requestedService, item, { ...streamData, url: finalUrl, rawUrl: streamData.url }, playbackMeta);
                TorrentInfoLedger.recordResolvedFileIndex({
                    meta: playbackMeta,
                    item,
                    streamData,
                    service: requestedService,
                    dbHelper,
                    logger,
                    reason: 'lazy_play'
                }).catch(() => {});
                incrementMetric('lazyPlay.success');
                recordDuration('lazyPlay.total', Date.now() - startedAt);
                recordProviderMetric(`lazy.${requestedService}`, true, Date.now() - startedAt);
                return res.redirect(finalUrl);
            }
            await markPlayableResultAsUnavailable?.(requestedService, item, playbackMeta, 'lazy_play_miss');
            if (requestedService === 'rd') {
                incrementMetric('lazyPlay.rdNoCloudFallback');
                recordDuration('lazyPlay.total', Date.now() - startedAt);
                logger.info(`[LAZY PLAY] RD miss senza add_to_cloud | hash=${item.hash} | fileIdx=${item.fileIdx ?? 'n/a'} | reason=rd_lazy_disabled`);
                return res.status(404).send('Stream RD non disponibile: Leviathan non aggiunge più automaticamente questo hash al cloud RD. Aggiorna la pagina per vedere solo link RD risolti.');
            }
            incrementMetric('lazyPlay.redirectToCloud');
            recordDuration('lazyPlay.total', Date.now() - startedAt);
            return res.redirect(`${getRequestOrigin(req)}/${conf}/add_to_cloud/${hash}`);
        } catch (err) {
            recordDuration('lazyPlay.total', Date.now() - startedAt);
            recordProviderMetric(`lazy.${requestedService}`, false, Date.now() - startedAt, { error: err.message, timeout: /timeout/i.test(String(err?.message || '')) });
            logger.error(`Error Lazy Play: ${err.message}`);
            res.status(500).send(`Errore nel recupero del link: ${err.message}`);
        }
    });

    app.get('/:conf/play_tb/:hash', async (req, res) => {
        const { conf, hash } = req.params;
        const { s, e, f, imdb } = req.query;
        const query = new URLSearchParams();
        if (s !== undefined) query.set('s', s);
        if (e !== undefined) query.set('e', e);
        if (imdb) query.set('imdb', imdb);
        const suffix = query.toString() ? `?${query.toString()}` : '';
        res.redirect(`/${conf}/play_lazy/tb/${hash}/${f || -1}${suffix}`);
    });

    app.get('/:conf/play_saved_cloud/:service/:torrentId/:fileId', async (req, res) => {
        const { conf, service, torrentId, fileId } = req.params;
        const startedAt = Date.now();
        const requestedService = String(service || '').toLowerCase();
        try {
            if (!['rd', 'tb'].includes(requestedService)) return res.status(400).send('Servizio Debrid non supportato.');
            const config = getConfig(conf);
            const apiKey = getDebridApiKey(config, requestedService);
            if (!apiKey) return res.status(400).send('API Key mancante.');

            const tokenFp = tokenFingerprint(apiKey);
            const savedIpPart = requestedService === 'tb' ? `:${req.ip || ''}` : '';
            const cacheKey = `saved:${requestedService}:${torrentId}:${fileId}`;
            const persistedCacheKey = `saved:${requestedService}:${tokenFp}:${torrentId}:${fileId}${savedIpPart}`;
            const cached = await Cache.getLazyLink(cacheKey);
            if (cached?.rawUrl || cached?.url) {
                const cachedTargetUrl = cached.rawUrl || cached.url;
                const finalCachedUrl = buildFinalPlaybackUrl(req, conf, cachedTargetUrl, config, {
                    source: requestedService,
                    debrid: true,
                    filename: cached.filename || cached.fileName || ''
                });
                incrementMetric('savedCloudPlay.cacheHit');
                recordDuration('savedCloudPlay.total', Date.now() - startedAt);
                return res.redirect(finalCachedUrl);
            }

            const persistedSaved = await getPersistedResolvedLink(dbHelper, persistedCacheKey);
            if (persistedSaved?.rawUrl || persistedSaved?.url) {
                const cachedTargetUrl = persistedSaved.rawUrl || persistedSaved.url;
                const finalCachedUrl = buildFinalPlaybackUrl(req, conf, cachedTargetUrl, config, {
                    source: requestedService,
                    debrid: true,
                    filename: persistedSaved.filename || persistedSaved.fileName || ''
                });
                await Cache.cacheLazyLink(cacheKey, { ...persistedSaved, rawUrl: cachedTargetUrl, url: cachedTargetUrl }, Math.min(getResolvedDbTtlSeconds(persistedSaved), 1800));
                incrementMetric('savedCloudPlay.dbResolvedCacheHit');
                recordDuration('savedCloudPlay.total', Date.now() - startedAt);
                return res.redirect(finalCachedUrl);
            }

            const inflightKey = `saved:${requestedService}:${tokenFp}:${torrentId}:${fileId}${savedIpPart}`;
            const streamData = await withSharedPromise(savedCloudResolveInflight, inflightKey, () => (requestedService === 'tb'
                ? LIMITERS.lazyPlay.schedule(() => TB.resolveSavedTorrentFile(apiKey, torrentId, fileId, req.ip || null))
                : LIMITERS.lazyPlay.schedule(() => RD.resolveSavedTorrentFile(apiKey, torrentId, fileId))
            ), { maxEntries: 2048 });

            if (!streamData?.url) {
                incrementMetric('savedCloudPlay.empty');
                return res.status(404).send('File cloud salvato non più disponibile o non selezionato.');
            }

            const finalUrl = buildFinalPlaybackUrl(req, conf, streamData.url, config, {
                source: requestedService,
                debrid: true,
                filename: streamData.filename || streamData.fileName || ''
            });

            await Cache.cacheLazyLink(cacheKey, { ...streamData, rawUrl: streamData.url, url: streamData.url }, Math.min(getResolvedDbTtlSeconds(streamData), 1800));
            await persistResolvedLink(dbHelper, persistedCacheKey, requestedService, tokenFp, streamData, {
                torrentId,
                fileId,
                filename: streamData.filename || streamData.fileName || '',
                fileSize: streamData.file_size || streamData.size || null,
                mediaId: buildTbMediaId({ imdb_id: req.query.imdb || null, season: Number(req.query.s || 0) || 0, episode: Number(req.query.e || 0) || 0 })
            });
            TorrentInfoLedger.recordResolvedFileIndex({
                meta: { imdb_id: req.query.imdb || null, season: Number(req.query.s || 0) || 0, episode: Number(req.query.e || 0) || 0 },
                item: { hash: streamData.hash || streamData.infoHash || torrentId, fileIdx: fileId, title: streamData.filename || '' },
                streamData,
                service: requestedService,
                dbHelper,
                logger,
                reason: 'saved_cloud_play'
            }).catch(() => {});
            incrementMetric('savedCloudPlay.success');
            recordDuration('savedCloudPlay.total', Date.now() - startedAt);
            recordProviderMetric(`savedCloud.${requestedService}`, true, Date.now() - startedAt);
            return res.redirect(finalUrl);
        } catch (err) {
            recordDuration('savedCloudPlay.total', Date.now() - startedAt);
            recordProviderMetric(`savedCloud.${requestedService}`, false, Date.now() - startedAt, { error: err.message });
            logger.error(`[SAVED CLOUD PLAY] ${requestedService.toUpperCase()} error: ${err.message}`);
            return res.status(500).send(`Errore cloud salvato: ${err.message}`);
        }
    });


    function decodeBase64UrlText(value = '') {
        const text = String(value || '').trim();
        if (!text) return '';
        try {
            const padded = text.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - text.length % 4) % 4);
            return Buffer.from(padded, 'base64').toString('utf8').trim();
        } catch (_) {
            return '';
        }
    }

    function pickRdCloudBuildMagnet(req, hash) {
        const fromEncoded = decodeBase64UrlText(req.query?.m || req.query?.magnet_b64 || '');
        const fromPlain = String(req.query?.magnet || '').trim();
        const rdDownloadRaw = String(req.query?.rd_download || '').trim();
        const rdDownloadDecoded = decodeBase64UrlText(rdDownloadRaw);
        const candidates = [fromEncoded, fromPlain, rdDownloadDecoded, rdDownloadRaw]
            .map((value) => String(value || '').trim())
            .filter((value) => /^magnet:\?/i.test(value));
        const wantedHash = String(hash || '').toUpperCase();
        for (const candidate of candidates) {
            const foundHash = extractInfoHashFromText(candidate);
            if (!wantedHash || !foundHash || String(foundHash).toUpperCase() === wantedHash) return candidate;
        }
        return null;
    }

    app.head('/:conf/add_to_cloud/:hash', async (req, res) => {
        
        res.status(204).end();
    });

    app.get('/:conf/add_to_cloud/:hash', async (req, res) => {
        const { conf, hash } = req.params;
        try {
            const config = getConfig(conf);
            const service = String(config.service || '').toLowerCase();
            const apiKey = getDebridApiKey(config, service);
            if (!['rd', 'tb'].includes(service)) return res.status(400).send('Servizio Debrid non supportato.');
            if (!apiKey) return res.status(400).send('API Key mancante.');

            const isRdDownloadFallbackUrl = service === 'rd' && String(req.query?.rd_download || '').trim();
            const rdFallbackMagnet = isRdDownloadFallbackUrl ? pickRdCloudBuildMagnet(req, hash) : null;
            if (isRdDownloadFallbackUrl && rdFallbackMagnet) {
                const playableUrl = await tryResolveRdDownloadFallback(req, conf, hash, apiKey, config, rdFallbackMagnet);
                if (playableUrl) return res.redirect(playableUrl);
                logger.info(`📥 [CACHE BUILDER] RD fallback non pronto, passo a cloud build | hash=${hash} | magnet=external_context`);
            }

            const buildKey = getBuildKey(service, hash, apiKey);
            const recentBuild = await Cache.getCloudBuild(buildKey);
            const ageMs = recentBuild ? Date.now() - Number(recentBuild.queuedAt || 0) : Infinity;
            const isRecent = recentBuild && ageMs < 120000 && ['queued', 'submitted'].includes(recentBuild.status);
            const isErrorCooldown = recentBuild && ageMs < 600000 && recentBuild.status === 'error';
            if (isRecent) logger.info(`📥 [CACHE BUILDER] Già in coda ${hash} su ${service.toUpperCase()} - salto duplicato`);
            else if (isErrorCooldown) logger.info(`📥 [CACHE BUILDER] cooldown errore attivo ${hash} su ${service.toUpperCase()} - niente retry spam`);
            else {
                const magnet = service === 'rd' ? (rdFallbackMagnet || pickRdCloudBuildMagnet(req, hash)) : null;
                logger.info(`📥 [CACHE BUILDER] Richiesta aggiunta hash ${hash} su ${service.toUpperCase()}${magnet ? ' | magnet=external_context' : ''}`);
                
                
                queueCloudBuild(service, hash, apiKey, { magnet }).catch((error) => {
                    logger.warn(`[CACHE BUILDER] async cloud build failed | service=${service.toUpperCase()} | hash=${hash} | error=${error?.message || error}`);
                });
            }
            res.redirect(`${getRequestOrigin(req)}/confirmed.mp4`);
        } catch (err) {
            logger.error(`Errore Cache Builder: ${err.message}`);
            res.status(500).send(`Errore durante l'aggiunta al cloud: ${err.message}`);
        }
    });
}

module.exports = { registerPlaybackRoutes };
