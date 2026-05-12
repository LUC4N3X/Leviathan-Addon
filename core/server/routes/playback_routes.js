'use strict';

const { getRequestOrigin } = require('../../utils/url');
const RD = require('../../debrid/clients/realdebrid_client');
const TB = require('../../debrid/clients/torbox_client');
const { registerLazyExtractionRoute } = require('../../../providers/extractors/lazy_extraction');
const { buildContentProxyUrlFromRequest, shouldProxyContentUrl } = require('../../proxy/content_proxy_engine');
const TorrentInfoLedger = require('../../torrent/torrent_info_ledger');

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
        if (!targetUrl || !(config.mediaflow && config.mediaflow.proxyDebrid && config.mediaflow.url)) return targetUrl;
        try {
            const mfpBase = config.mediaflow.url.replace(/\/$/, '');
            let finalUrl = `${mfpBase}/proxy/stream?d=${encodeURIComponent(targetUrl)}`;
            if (config.mediaflow.pass) finalUrl += `&api_password=${encodeURIComponent(config.mediaflow.pass)}`;
            return finalUrl;
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
            const apiKey = requestedService === 'tb'
                ? (config.key || config.tb || config.torbox || config.rd)
                : (config.key || config.rd);
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

            const streamData = await LIMITERS.lazyPlay.schedule(() =>
                resolveLazyStreamData(requestedService, apiKey, item, { season: item.season, episode: item.episode })
            );

            if (streamData && streamData.url) {
                const finalUrl = buildFinalPlaybackUrl(req, conf, streamData.url, config, {
                    source: requestedService,
                    debrid: true,
                    filename: streamData.filename || playbackMeta?.title || item.title
                });
                await Cache.cacheLazyLink(lazyCacheKey, { ...streamData, rawUrl: streamData.url, url: streamData.url }, 180);
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
            const apiKey = requestedService === 'tb'
                ? (config.key || config.tb || config.torbox || config.rd)
                : (config.key || config.rd || config.realdebrid);
            if (!apiKey) return res.status(400).send('API Key mancante.');

            const cacheKey = `saved:${requestedService}:${torrentId}:${fileId}`;
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

            const streamData = requestedService === 'tb'
                ? await LIMITERS.lazyPlay.schedule(() => TB.resolveSavedTorrentFile(apiKey, torrentId, fileId, req.ip || null))
                : await LIMITERS.lazyPlay.schedule(() => RD.resolveSavedTorrentFile(apiKey, torrentId, fileId));

            if (!streamData?.url) {
                incrementMetric('savedCloudPlay.empty');
                return res.status(404).send('File cloud salvato non più disponibile o non selezionato.');
            }

            const finalUrl = buildFinalPlaybackUrl(req, conf, streamData.url, config, {
                source: requestedService,
                debrid: true,
                filename: streamData.filename || streamData.fileName || ''
            });

            await Cache.cacheLazyLink(cacheKey, { ...streamData, rawUrl: streamData.url, url: streamData.url }, 180);
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

    app.get('/:conf/add_to_cloud/:hash', async (req, res) => {
        const { conf, hash } = req.params;
        try {
            const config = getConfig(conf);
            const service = String(config.service || '').toLowerCase();
            const apiKey = service === 'tb'
                ? (config.key || config.tb || config.torbox || config.rd)
                : service === 'rd'
                    ? (config.key || config.rd)
                    : null;
            if (!['rd', 'tb'].includes(service)) return res.status(400).send('Servizio Debrid non supportato.');
            if (!apiKey) return res.status(400).send('API Key mancante.');
            const buildKey = getBuildKey(service, hash, apiKey);
            const recentBuild = await Cache.getCloudBuild(buildKey);
            const isRecent = recentBuild && (Date.now() - Number(recentBuild.queuedAt || 0) < 120000) && ['queued', 'submitted'].includes(recentBuild.status);
            if (isRecent) logger.info(`📥 [CACHE BUILDER] Già in coda ${hash} su ${service.toUpperCase()} - salto duplicato`);
            else {
                logger.info(`📥 [CACHE BUILDER] Richiesta aggiunta hash ${hash} su ${service.toUpperCase()}`);
                await queueCloudBuild(service, hash, apiKey);
            }
            res.redirect(`${getRequestOrigin(req)}/confirmed.mp4`);
        } catch (err) {
            logger.error(`Errore Cache Builder: ${err.message}`);
            res.status(500).send(`Errore durante l'aggiunta al cloud: ${err.message}`);
        }
    });
}

module.exports = { registerPlaybackRoutes };
