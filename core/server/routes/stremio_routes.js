'use strict';

const path = require('path');
const crypto = require('crypto');
const { incrementMetric } = require('../../utils/runtime');
const { getRawStreamCache, setRawStreamCache } = require('../../cache/raw_stream_cache');
const { streamRequestCoalescer, buildRequestCoalescingKey } = require('../../cache/request_coalescer');
const { getRequestClientIp, getRequestOrigin } = require('../../utils/url');
const { prepareUprotManualChallenge, submitUprotManualChallenge } = require('../../../providers/extractors/hosters/uprot');

const RECENT_STREAM_HINT_TTL_MS = 10 * 60 * 1000;
const RECENT_STREAM_HINT_LIMIT = 256;
const BINGE_WARMUP_DEDUPE_TTL_MS = 10 * 60 * 1000;
const BINGE_WARMUP_DEDUPE_LIMIT = 512;
const recentSeriesStreamHints = new Map();
const recentBingeWarmups = new Map();

function cleanupRecentStreamHints(now = Date.now()) {
    for (const [key, entry] of recentSeriesStreamHints.entries()) {
        if (!entry || Number(entry.expiresAt || 0) <= now) recentSeriesStreamHints.delete(key);
    }
    while (recentSeriesStreamHints.size > RECENT_STREAM_HINT_LIMIT) {
        const oldestKey = recentSeriesStreamHints.keys().next().value;
        if (oldestKey === undefined) break;
        recentSeriesStreamHints.delete(oldestKey);
    }
}

function cleanupRecentBingeWarmups(now = Date.now()) {
    for (const [key, expiresAt] of recentBingeWarmups.entries()) {
        if (!expiresAt || Number(expiresAt) <= now) recentBingeWarmups.delete(key);
    }
    while (recentBingeWarmups.size > BINGE_WARMUP_DEDUPE_LIMIT) {
        const oldestKey = recentBingeWarmups.keys().next().value;
        if (oldestKey === undefined) break;
        recentBingeWarmups.delete(oldestKey);
    }
}

function getStreamHintKey(conf, req) {
    const clientIp = getRequestClientIp(req);
    return `${String(conf || '').trim()}:${clientIp}`;
}

function extractSeriesBaseId(rawId) {
    const cleanId = String(rawId || '').replace(/^ai-recs:/i, '').trim();
    const kitsuMatch = cleanId.match(/^(kitsu:\d+)(?::\d+){0,2}$/i);
    if (kitsuMatch) return kitsuMatch[1];
    const tmdbMatch = cleanId.match(/^(tmdb:\d+)(?::\d+){0,2}$/i);
    if (tmdbMatch) return tmdbMatch[1];
    const imdbMatch = cleanId.match(/^(tt\d+|\d+)(?::\d+){0,2}$/i);
    if (imdbMatch) return imdbMatch[1];
    return null;
}

function parseEpisodeLocator(rawId) {
    const cleanId = String(rawId || '').replace(/^ai-recs:/i, '').trim();
    const baseMatch = cleanId.match(/^(kitsu:\d+|tmdb:\d+|tt\d+|\d+)(?::(\d+))?(?::(\d+))?$/i);
    if (!baseMatch) return null;

    const baseId = baseMatch[1];
    const first = baseMatch[2] ? parseInt(baseMatch[2], 10) : null;
    const second = baseMatch[3] ? parseInt(baseMatch[3], 10) : null;

    if (Number.isInteger(first) && first > 0 && Number.isInteger(second) && second > 0) {
        return { baseId, season: first, episode: second, compactMode: false };
    }

    if (String(baseId).toLowerCase().startsWith('kitsu:') && Number.isInteger(first) && first > 0) {
        return { baseId, season: 1, episode: first, compactMode: true };
    }

    return null;
}

function buildEpisodeId(locator, season, episode) {
    if (!locator?.baseId || !Number.isInteger(season) || !Number.isInteger(episode) || season <= 0 || episode <= 0) return null;
    if (locator.compactMode && season === 1 && String(locator.baseId).toLowerCase().startsWith('kitsu:')) {
        return `${locator.baseId}:${episode}`;
    }
    return `${locator.baseId}:${season}:${episode}`;
}

function getWarmupMaxEpisode(meta = {}, locator = {}) {
    const seasonMax = Number(meta?.seasonEpisodeCount || meta?.episodesInSeason || 0) || 0;
    if (seasonMax > 0 && !locator?.compactMode) return seasonMax;

    const totalMax = Number(meta?.episodeCount || meta?.numberOfEpisodes || 0) || 0;
    if (totalMax > 0 && (locator?.compactMode || meta?.kitsu_id || meta?.isAnime)) return totalMax;
    return 0;
}

function getConfigFingerprint(conf) {
    const raw = String(conf || '').trim();
    if (!raw) return null;
    return crypto.createHash('sha256').update(raw).digest('hex').slice(0, 12);
}

function rememberSeriesHint(conf, req, type, rawId) {
    const normalizedType = String(type || '').toLowerCase();
    if (normalizedType !== 'series' && normalizedType !== 'anime') return;

    const baseId = extractSeriesBaseId(rawId);
    if (!baseId) return;

    cleanupRecentStreamHints();
    recentSeriesStreamHints.set(getStreamHintKey(conf, req), {
        baseId,
        expiresAt: Date.now() + RECENT_STREAM_HINT_TTL_MS
    });
}

function recoverSeriesIdFromHint(conf, req, type, rawId) {
    const normalizedType = String(type || '').toLowerCase();
    if (normalizedType !== 'series' && normalizedType !== 'anime') return null;

    const placeholder = String(rawId || '').replace(/^ai-recs:/i, '').trim();
    const match = placeholder.match(/^(?:undefined|null|nan)(?::(\d+))?(?::(\d+))?$/i);
    if (!match) return null;

    cleanupRecentStreamHints();
    const hint = recentSeriesStreamHints.get(getStreamHintKey(conf, req));
    if (!hint?.baseId) return null;

    const first = parseInt(match[1], 10);
    const second = parseInt(match[2], 10);

    if (Number.isInteger(first) && first > 0 && Number.isInteger(second) && second > 0) {
        if (String(hint.baseId || '').toLowerCase().startsWith('kitsu:')) {
            return first === 1 ? `${hint.baseId}:${second}` : `${hint.baseId}:${first}:${second}`;
        }
        return `${hint.baseId}:${first}:${second}`;
    }
    if (Number.isInteger(first) && first > 0) {
        return `${hint.baseId}:${first}`;
    }
    return hint.baseId;
}

function isStremioEtagEnabled() {
    const normalized = String(process.env.STREMIO_ETAG_ENABLED || '').trim().toLowerCase();
    return ['1', 'true', 'yes', 'y', 'on'].includes(normalized);
}

function buildStremioPayloadEtag(payload) {
    const stable = JSON.stringify(payload || {}, Object.keys(payload || {}).sort());
    const hash = crypto.createHash('sha256').update(stable).digest('hex').slice(0, 24);
    return `W/"${hash}"`;
}

function maybeSendNotModified(req, res, payload) {
    if (!isStremioEtagEnabled()) return false;
    const cacheMaxAge = Math.max(0, Number(payload?.cacheMaxAge || 0) || 0);
    if (cacheMaxAge <= 0) return false;
    const etag = buildStremioPayloadEtag(payload);
    const clientEtag = String(req?.headers?.['if-none-match'] || '').trim();
    if (clientEtag !== etag) return false;
    res.status(304).end();
    return true;
}

function applyStremioStreamCacheHeaders(res, payload) {
    const cacheMaxAge = Math.max(0, Number(payload?.cacheMaxAge || 0) || 0);
    const staleRevalidate = Math.max(0, Number(payload?.staleRevalidate || 0) || 0);
    const staleError = Math.max(0, Number(payload?.staleError || 0) || 0);

    res.setHeader('Access-Control-Allow-Origin', '*');
    if (cacheMaxAge <= 0) {
        res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
        res.setHeader('Pragma', 'no-cache');
        res.setHeader('Expires', '0');
        return;
    }

    res.removeHeader('Pragma');
    res.removeHeader('Expires');
    res.setHeader(
        'Cache-Control',
        `public, max-age=${cacheMaxAge}, stale-while-revalidate=${staleRevalidate}, stale-if-error=${staleError}`
    );
    if (isStremioEtagEnabled()) {
        res.setHeader('ETag', buildStremioPayloadEtag(payload));
    } else {
        res.removeHeader('ETag');
    }
}

function queueBingePredictionWarmup({
    req,
    logger,
    generateStream,
    Cache,
    type,
    requestId,
    userConf,
    userConfStr,
    reqHost,
    streamInflight,
    lastResult,
    meta
}) {
    const normalizedType = String(type || '').toLowerCase();
    if (normalizedType !== 'series' && normalizedType !== 'anime') return;
    if (!lastResult || !Array.isArray(lastResult.streams) || lastResult.streams.length === 0) return;

    const filters = userConf?.filters || {};
    if (filters.bingeWarmup === false) return;

    const cachedEvidence = lastResult.streams.some((stream) => {
        const title = String(stream?.title || stream?.name || '').toLowerCase();
        return title.includes('cached') || title.includes('⚡') || title.includes('instant');
    });
    if (!cachedEvidence && lastResult.streams.length < 2) {
        incrementMetric('bingeWarmup.skippedLowConfidence');
        return;
    }

    const aheadCount = Math.max(0, Math.min(2, parseInt(filters.bingeWarmupAhead ?? process.env.BINGE_WARMUP_AHEAD ?? '2', 10) || 0));
    if (aheadCount <= 0) return;

    const inflightSize = streamInflight?.size || 0;
    const maxInflight = Math.max(1, Math.min(64, parseInt(process.env.BINGE_WARMUP_MAX_INFLIGHT || '8', 10) || 8));
    if (inflightSize >= maxInflight) {
        incrementMetric('bingeWarmup.skippedLoad');
        logger.info(`[BINGE] Skip warmup sotto carico | inflight=${inflightSize} | threshold=${maxInflight}`);
        return;
    }

    const locator = parseEpisodeLocator(requestId);
    if (!locator?.baseId || !Number.isInteger(locator.episode) || locator.episode <= 0) return;

    const maxEpisode = getWarmupMaxEpisode(meta, locator);
    if (maxEpisode > 0 && locator.episode >= maxEpisode) {
        incrementMetric('bingeWarmup.skippedEndOfSeason');
        logger.info(`[BINGE] Skip warmup fine stagione | id=${requestId} | episode=${locator.episode}/${maxEpisode}`);
        return;
    }

    cleanupRecentBingeWarmups();
    const clientScope = getStreamHintKey(userConfStr, req);
    const targets = [];
    for (let offset = 1; offset <= aheadCount; offset += 1) {
        if (maxEpisode > 0 && locator.episode + offset > maxEpisode) continue;
        const nextId = buildEpisodeId(locator, locator.season, locator.episode + offset);
        if (!nextId) continue;

        const cacheKey = `${normalizedType}:${nextId}:${String(userConfStr || '').trim()}`;
        const dedupeKey = `${clientScope}:${normalizedType}:${nextId}`;
        if (recentBingeWarmups.has(dedupeKey)) continue;
        if (streamInflight?.has?.(cacheKey)) {
            incrementMetric('bingeWarmup.skippedInflight');
            continue;
        }

        const cachedCandidate = Cache && typeof Cache.getCachedStream === 'function'
            ? Cache.getCachedStream(cacheKey, { allowLocal: true, allowShared: true }).catch(() => null)
            : Promise.resolve(null);
        targets.push({ nextId, dedupeKey, cacheKey, cachedCandidate });
    }

    if (targets.length === 0) return;

    const timer = setTimeout(() => {
        targets.forEach(async ({ nextId, dedupeKey, cachedCandidate }) => {
            recentBingeWarmups.set(dedupeKey, Date.now() + BINGE_WARMUP_DEDUPE_TTL_MS);
            try {
                const cached = await cachedCandidate;
                if (cached && Array.isArray(cached.streams) && cached.streams.length > 0) {
                    incrementMetric('bingeWarmup.skippedCached');
                    return;
                }

                incrementMetric('bingeWarmup.queued');
                const result = await generateStream(normalizedType, nextId, userConf, userConfStr, reqHost, {
                    rdViewScanPriority: 'low',
                    rdViewScanKind: 'warmup',
                    requestPage: {
                        type: normalizedType,
                        id: nextId,
                        source: 'binge_warmup',
                        from: requestId
                    }
                });
                const count = Array.isArray(result?.streams) ? result.streams.length : 0;
                incrementMetric(count > 0 ? 'bingeWarmup.success' : 'bingeWarmup.empty');
                logger.info(`[BINGE] Warmup completato | from=${requestId} | target=${nextId} | streams=${count}`);
            } catch (error) {
                recentBingeWarmups.delete(dedupeKey);
                incrementMetric('bingeWarmup.fail');
                logger.warn(`[BINGE] Warmup fallito | from=${requestId} | target=${nextId} | error=${error.message}`);
            }
        });
    }, 150);
    if (typeof timer.unref === 'function') timer.unref();
}


function buildStreamRouteCoalescingKey(type, requestId, conf) {
    return buildRequestCoalescingKey([
        'stremio-stream',
        String(type || '').toLowerCase(),
        String(requestId || '').replace(/\.json$/i, ''),
        getConfigFingerprint(conf) || 'no-conf'
    ]);
}

function isStreamRequestCoalescingLogEnabled() {
    return /^(1|true|yes|y|on)$/i.test(String(process.env.STREAM_REQUEST_COALESCING_LOGS || '').trim());
}

function registerStremioRoutes(app, {
    publicDir,
    getManifest,
    handleVixSynthetic,
    cloneManifest,
    getConfig,
    validateStreamRequest,
    generateStream,
    logger,
    streamInflight,
    Cache
}) {
    function sendConfigurePage(req, res) {
        res.setHeader('Cache-Control', 'no-store, max-age=0');
        res.setHeader('Pragma', 'no-cache');
        return res.sendFile(path.join(publicDir, 'index.html'));
    }

    app.get('/', sendConfigurePage);
    app.get('/:conf/configure', sendConfigurePage);
    app.get('/configure', sendConfigurePage);
    app.get('/rd-scanner', (req, res) => {
        res.setHeader('Cache-Control', 'no-store, max-age=0');
        res.setHeader('Pragma', 'no-cache');
        return res.sendFile(path.join(publicDir, 'rd-scanner.html'));
    });

    app.get('/uprot', async (req, res) => {
        res.setHeader('Cache-Control', 'no-store, max-age=0');
        res.setHeader('Pragma', 'no-cache');
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        try {
            const result = await prepareUprotManualChallenge({
                ...(req.query?.url ? { uprotBootstrapUrl: String(req.query.url) } : {})
            });
            return res.status(result.ok ? 200 : 502).send(result.html);
        } catch (error) {
            logger?.warn?.(`[UPROT] manual setup page failed | error=${error.message}`);
            return res.status(500).send(`<pre>Uprot setup failed: ${String(error.message || error)}</pre>`);
        }
    });

    app.post('/uprot', async (req, res) => {
        res.setHeader('Cache-Control', 'no-store, max-age=0');
        res.setHeader('Pragma', 'no-cache');
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        try {
            const result = await submitUprotManualChallenge({
                token: req.body?.token,
                captcha: req.body?.captcha || req.body?.user_input
            });
            return res.status(result.ok ? 200 : 400).send(result.html);
        } catch (error) {
            logger?.warn?.(`[UPROT] manual setup submit failed | error=${error.message}`);
            return res.status(500).send(`<pre>Uprot submit failed: ${String(error.message || error)}</pre>`);
        }
    });

    app.get('/manifest.json', (req, res) => {
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.json(getManifest());
    });

    app.get('/:conf/manifest.json', (req, res) => {
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        const manifest = cloneManifest(getManifest());
        try {
            const config = getConfig(req.params.conf);
            const filters = config.filters || {};
            const langMode = filters.language || (filters.allowEng ? 'all' : 'ita');
            const flag = langMode === 'ita'
                ? ' 🇮🇹'
                : (langMode === 'eng' ? ' 🇬🇧' : ' 🇮🇹🇬🇧');
            const appName = 'LEVIATHAN';

            if ((config.service === 'rd' && config.key) || config.rd) {
                manifest.name = `${appName}${flag} 🔱 RD`;
                manifest.id += '.rd';
            } else if ((config.service === 'tb' && config.key) || config.torbox) {
                manifest.name = `${appName}${flag} 🔱 TB`;
                manifest.id += '.tb';
            } else if (filters.enableP2P === true) {
                manifest.name = `${appName}${flag} 🦈 P2P`;
                manifest.id += '.p2p';
                manifest.description += ' | P2P Mode (IP Visible)';
            } else {
                manifest.name = `${appName}${flag} ⛵ Web`;
                manifest.id += '.web';
            }
        } catch (e) {
            console.error('Errore personalizzazione manifest:', e);
        }
        res.json(manifest);
    });

    app.get('/:conf/catalog/:type/:id{/:extra}.json', async (req, res) => {
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.json({ metas: [] });
    });

    app.get('/vixsynthetic.m3u8', handleVixSynthetic);

    app.get('/:conf', (req, res, next) => {
        const conf = String(req.params.conf || '').trim();
        if (conf.length > 10 && !/^(?:api|admin|health|readyz|livez|metrics|manifest\.json|favicon\.ico|rd-scanner)$/i.test(conf)) {
            return sendConfigurePage(req, res);
        }
        return next();
    });

    app.get('/:conf/stream/:type/:id.json', async (req, res) => {
        try {
            let requestId = req.params.id.replace('.json', '');
            const recoveredId = recoverSeriesIdFromHint(req.params.conf, req, req.params.type, requestId);
            if (recoveredId && recoveredId !== requestId) {
                logger.warn(`[STREAM ID RECOVERY] ${requestId} -> ${recoveredId}`);
                requestId = recoveredId;
            }

            validateStreamRequest(req.params.type, requestId);
            rememberSeriesHint(req.params.conf, req, req.params.type, requestId);

            const userConf = getConfig(req.params.conf);
            const reqHost = getRequestOrigin(req);
            const cachedResult = await getRawStreamCache(req.params.type, requestId, req.params.conf, { logger });
            if (cachedResult) {
                if (maybeSendNotModified(req, res, cachedResult)) return;
                applyStremioStreamCacheHeaders(res, cachedResult);
                return res.json(cachedResult);
            }

            const runtimeContext = {
                rdViewScanPriority: 'high',
                rdViewScanKind: 'visible',
                requestPage: {
                    type: req.params.type,
                    id: requestId,
                    source: 'visible_request'
                }
            };

            const coalescingKey = buildStreamRouteCoalescingKey(req.params.type, requestId, req.params.conf);
            const coalesced = await streamRequestCoalescer.runDetailed(coalescingKey, async () => {
                const generated = await generateStream(
                    req.params.type,
                    requestId,
                    userConf,
                    req.params.conf,
                    reqHost,
                    runtimeContext
                );
                await setRawStreamCache(req.params.type, requestId, req.params.conf, generated, { logger }).catch(() => false);
                return generated;
            }, {
                readCached: () => getRawStreamCache(req.params.type, requestId, req.params.conf, { logger }),
                resultTtlSeconds: Math.max(15, Math.min(300, parseInt(process.env.STREAM_REQUEST_RESULT_TTL_SECONDS || '90', 10) || 90)),
                shouldStoreResult: (value) => value && typeof value === 'object' && Array.isArray(value.streams),
                logger
            });

            const result = coalesced.value || { streams: [], cacheMaxAge: 30, staleRevalidate: 60, staleError: 120 };
            if (isStreamRequestCoalescingLogEnabled()) {
                logger.info(`[CACHE LOCK] stream origin=${coalesced.origin} worker=${coalesced.didRunWorker === true} waitMs=${coalesced.waitedMs || 0} key=${coalescingKey}`);
            }
            if (maybeSendNotModified(req, res, result)) return;
            applyStremioStreamCacheHeaders(res, result);
            if (coalesced.didRunWorker === true) {
                queueBingePredictionWarmup({
                    req,
                    logger,
                    generateStream,
                    Cache,
                    type: req.params.type,
                    requestId,
                    userConf,
                    userConfStr: req.params.conf,
                    reqHost,
                    streamInflight,
                    lastResult: result,
                    meta: runtimeContext.generatedMeta
                });
            }
            res.json(result);
        } catch (err) {
            logger.error('Validazione/Stream Fallito', {
                error: err.message,
                type: req.params.type,
                id: req.params.id,
                confHash: getConfigFingerprint(req.params.conf)
            });
            const fallback = { streams: [], cacheMaxAge: 30, staleRevalidate: 60, staleError: 120 };
            applyStremioStreamCacheHeaders(res, fallback);
            return res.status(400).json(fallback);
        }
    });
}

module.exports = { registerStremioRoutes, applyStremioStreamCacheHeaders, buildStremioPayloadEtag, maybeSendNotModified };
