'use strict';

const axios = require('axios');
const crypto = require('crypto');

const RD = require('../../debrid/rd/clients/realdebrid_client');

function createAppServices({
    Cache,
    LIMITERS,
    cloudBuildInflight,
    buildTrackerMagnet,
    dbHelper,
    logger,
    recordDuration,
    recordProviderMetric
}) {
    function getBuildKey(service, hash, apiKey) {
        const tokenSig = crypto.createHash('sha1').update(String(apiKey || '')).digest('hex').slice(0, 12);
        return `${String(service || '').toLowerCase()}:${String(hash || '').toUpperCase()}:${tokenSig}`;
    }

    function getServiceResolverLimiter(service) {
        const normalized = String(service || '').toLowerCase();
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

    async function markPlayableResultAsCached(service, item, streamData, meta = null) {
        const normalizedService = String(service || '').toLowerCase();
        if (!item?.hash) return false;
        if (!['rd', 'tb'].includes(normalizedService)) return false;

        const isTb = normalizedService === 'tb';
        const scopedIdentity = meta?.imdb_id ? {
            imdb_id: meta.imdb_id,
            imdb_season: Number(meta?.season) > 0 ? Number(meta.season) : null,
            imdb_episode: Number(meta?.episode) > 0 ? Number(meta.episode) : null
        } : {};
        const updateFn = isTb ? dbHelper?.updateTbCacheStatus : dbHelper?.updateRdCacheStatus;
        if (!dbHelper || typeof updateFn !== 'function') return false;

        const requestedItemFileIndex = item?.fileIdx;
        const firstPresent = (...values) => values.find((value) => value !== null && value !== undefined && value !== '');
        const streamResolvedFileIndex = isTb
            ? firstPresent(streamData?.tb_file_id, streamData?.file_id, streamData?.file_index, streamData?.fileIdx)
            : firstPresent(streamData?.rd_file_index, streamData?.file_id, streamData?.file_index, streamData?.fileIdx);
        const rawFileIndex = isTb
            ? firstPresent(streamResolvedFileIndex, requestedItemFileIndex)
            : firstPresent(streamResolvedFileIndex, requestedItemFileIndex);
        const rawFileSize = streamData?.rd_file_size ?? streamData?.tb_file_size ?? streamData?.file_size ?? streamData?.filesize ?? streamData?.size ?? item?._size ?? item?.sizeBytes ?? null;
        const parsedFileIndex = rawFileIndex === null || rawFileIndex === undefined || rawFileIndex === ''
            ? NaN
            : Number(rawFileIndex);
        const parsedFileSize = Number(rawFileSize);
        const resolvedTitle = streamData?.filename || item?.title || String(item.hash);
        const parsedRequestedFileIndex = requestedItemFileIndex === null || requestedItemFileIndex === undefined || requestedItemFileIndex === ''
            ? NaN
            : Number(requestedItemFileIndex);
        const parsedStreamFileIndex = streamData?.tb_file_id === null || streamData?.tb_file_id === undefined || streamData?.tb_file_id === ''
            ? NaN
            : Number(streamData.tb_file_id);
        if (isTb && Number.isInteger(parsedRequestedFileIndex) && parsedRequestedFileIndex >= 0 && Number.isInteger(parsedStreamFileIndex) && parsedStreamFileIndex >= 0 && parsedRequestedFileIndex !== parsedStreamFileIndex) {
            logger.warn(`[LAZY PLAY] TorBox fileIdx mismatch corrected with resolved file | hash=${item.hash} | requested=${parsedRequestedFileIndex} | resolved=${parsedStreamFileIndex}`);
        }

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
                    size: Number.isFinite(parsedFileSize) && parsedFileSize > 0 ? parsedFileSize : Number(item?._size || item?.sizeBytes || 0),
                    seeders: Number(item?.seeders || 0) || 0,
                    provider: item?.source || normalizedService.toUpperCase(),
                    file_index: Number.isInteger(parsedFileIndex) && parsedFileIndex >= 0 ? parsedFileIndex : (item?.fileIdx !== undefined ? item.fileIdx : undefined)
                });
            }

            const updated = await updateFn([isTb
                ? {
                    hash: item.hash,
                    cached: true,
                    tb_file_id: Number.isInteger(parsedFileIndex) && parsedFileIndex >= 0 ? parsedFileIndex : null,
                    tb_file_size: Number.isFinite(parsedFileSize) && parsedFileSize > 0 ? parsedFileSize : null,
                    failures: 0,
                    permanent: true,
                    ...scopedIdentity
                }
                : {
                    hash: item.hash,
                    state: 'cached',
                    cached: true,
                    rd_file_index: Number.isInteger(parsedFileIndex) && parsedFileIndex >= 0 ? parsedFileIndex : null,
                    rd_file_size: Number.isFinite(parsedFileSize) && parsedFileSize > 0 ? parsedFileSize : null,
                    failures: 0,
                    permanent: true,
                    ...scopedIdentity
                }
            ]);
            if (updated > 0) {
                await Cache.invalidateStreamsByHashes([item.hash], 'lazy_play_cached');
                if (meta?.imdb_id && Number.isInteger(meta?.season) && meta.season > 0 && Number.isInteger(meta?.episode) && meta.episode > 0 && typeof Cache.invalidateStreamsByEpisode === 'function') await Cache.invalidateStreamsByEpisode({ imdbId: meta.imdb_id, season: meta.season, episode: meta.episode }, 'lazy_play_cached');
                else if (meta?.imdb_id) await Cache.invalidateStreamsByImdb(meta.imdb_id, 'lazy_play_cached');
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


    async function markPlayableResultAsUnavailable(service, item, meta = null, reason = 'lazy_miss') {
        const normalizedService = String(service || '').toLowerCase();
        if (!item?.hash) return false;
        if (!['rd', 'tb'].includes(normalizedService)) return false;

        const isTb = normalizedService === 'tb';
        const scopedIdentity = meta?.imdb_id ? {
            imdb_id: meta.imdb_id,
            imdb_season: Number(meta?.season) > 0 ? Number(meta.season) : null,
            imdb_episode: Number(meta?.episode) > 0 ? Number(meta.episode) : null
        } : {};
        const updateFn = isTb ? dbHelper?.updateTbCacheStatus : dbHelper?.updateRdCacheStatus;
        if (!dbHelper || typeof updateFn !== 'function') return false;

        try {
            const updated = await updateFn([isTb
                ? {
                    hash: item.hash,
                    cached: false,
                    failures: 1,
                    ...scopedIdentity
                }
                : {
                    hash: item.hash,
                    state: 'likely_uncached',
                    cached: null,
                    failures: Math.max(1, Number(item?._dbFailures || 0) + 1),
                    next_hours: 4,
                    ...scopedIdentity
                }
            ]);

            await Cache.invalidateStreamsByHashes([item.hash], reason);
            if (meta?.imdb_id && Number.isInteger(meta?.season) && meta.season > 0 && Number.isInteger(meta?.episode) && meta.episode > 0 && typeof Cache.invalidateStreamsByEpisode === 'function') await Cache.invalidateStreamsByEpisode({ imdbId: meta.imdb_id, season: meta.season, episode: meta.episode }, reason);
            else if (meta?.imdb_id) await Cache.invalidateStreamsByImdb(meta.imdb_id, reason);
            const dbLookupKey = getDbLookupCacheKey(meta);
            if (dbLookupKey) await Cache.invalidateDbTorrents(dbLookupKey, reason);

            logger.info(`[LAZY PLAY] Stato cache corretto a MISS | service=${normalizedService} | hash=${item.hash} | state=${isTb ? 'uncached' : 'likely_uncached'} | updated=${updated} | reason=${reason}`);
            return Number(updated || 0) > 0;
        } catch (err) {
            logger.warn(`[LAZY PLAY] Impossibile correggere stato cache MISS | service=${normalizedService} | hash=${item.hash} | error=${err.message}`);
            return false;
        }
    }

    async function queueCloudBuild(service, hash, apiKey, options = {}) {
        const buildKey = getBuildKey(service, hash, apiKey);
        const existingPromise = cloudBuildInflight.get(buildKey);
        if (existingPromise) return existingPromise;

        const task = (async () => {
            const startedAt = Date.now();
            const providedMagnet = String(options?.magnet || '').trim();
            const magnet = /^magnet:\?/i.test(providedMagnet) ? providedMagnet : buildTrackerMagnet(hash);
            await Cache.setCloudBuild(buildKey, { status: 'queued', service, hash: String(hash || '').toUpperCase(), queuedAt: Date.now(), magnetSource: providedMagnet ? 'external_context' : 'tracker_registry' }, 900);

            await LIMITERS.cloudBuild.schedule(async () => {
                if (service === 'rd') {
                    const rdBuild = await RD.prepareTorrentForCloud(apiKey, magnet, {
                        selectAll: true,
                        poll: true,
                        pollAttempts: 3,
                        pollDelayMs: 900
                    });

                    if (!rdBuild) throw new Error('RD cloud build failed');

                    const rdState = rdBuild.ready ? 'cached' : 'probing';
                    if (dbHelper && typeof dbHelper.updateRdCacheStatus === 'function') {
                        try {
                            await dbHelper.updateRdCacheStatus([{
                                hash,
                                state: rdState,
                                cached: rdBuild.ready ? true : null,
                                rd_file_index: Number.isInteger(rdBuild.selectedFileId) ? rdBuild.selectedFileId : null,
                                rd_file_size: Number.isFinite(Number(rdBuild.selectedFileSize)) && Number(rdBuild.selectedFileSize) > 0 ? Number(rdBuild.selectedFileSize) : null,
                                failures: 0,
                                next_hours: rdBuild.ready ? (24 * 30) : 4,
                                permanent: rdBuild.ready === true
                            }]);
                        } catch (dbErr) {
                            logger.warn(`[CACHE BUILDER] Persistenza stato RD fallita | hash=${hash} | error=${dbErr.message}`);
                        }
                    }

                    if (Cache && typeof Cache.invalidateStreamsByHashes === 'function') {
                        try {
                            await Cache.invalidateStreamsByHashes([hash], rdBuild.ready ? 'cloud_build_cached' : 'cloud_build_probing');
                        } catch (_) {}
                    }
                } else if (service === 'tb') {
                    const body = new URLSearchParams();
                    body.append('magnet', magnet);
                    body.append('seed', '1');
                    body.append('allow_zip', 'false');
                    await axios.post('https://api.torbox.app/v1/api/torrents/createtorrent', body.toString(), { headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/x-www-form-urlencoded' } });
                } else {
                    throw new Error(`Unsupported debrid service: ${service}`);
                }
            });

            await Cache.setCloudBuild(buildKey, { status: 'submitted', service, hash: String(hash || '').toUpperCase(), queuedAt: Date.now() }, 900);
            recordDuration('cloudBuild.total', Date.now() - startedAt);
            recordProviderMetric(`cloudBuild.${service}`, true, Date.now() - startedAt);
            return { ok: true, duplicate: false };
        })().catch(async (err) => {
            const status = err?.response?.status;
            const body = err?.response?.data;
            const msg = typeof body === 'string' ? body : JSON.stringify(body || {});
            if (status === 409 || /already|duplicate|exists|same magnet|in progress/i.test(`${err.message} ${msg}`)) {
                await Cache.setCloudBuild(buildKey, { status: 'submitted', service, hash: String(hash || '').toUpperCase(), queuedAt: Date.now(), duplicate: true }, 900);
                recordProviderMetric(`cloudBuild.${service}`, true, 0, { error: 'duplicate' });
                return { ok: true, duplicate: true };
            }
            await Cache.setCloudBuild(buildKey, { status: 'error', service, hash: String(hash || '').toUpperCase(), queuedAt: Date.now(), error: err.message }, service === 'rd' ? 900 : 120);
            if (service === 'rd' && dbHelper && typeof dbHelper.updateRdCacheStatus === 'function') {
                try {
                    await dbHelper.updateRdCacheStatus([{
                        hash,
                        state: 'likely_uncached',
                        cached: null,
                        failures: 1,
                        next_hours: status === 429 ? 24 : 4
                    }]);
                    if (Cache && typeof Cache.invalidateStreamsByHashes === 'function') await Cache.invalidateStreamsByHashes([hash], 'cloud_build_failed');
                    logger.info(`[CACHE BUILDER] RD miss persisted | hash=${hash} | state=likely_uncached | reason=${status || err.message}`);
                } catch (dbErr) {
                    logger.warn(`[CACHE BUILDER] Persistenza errore RD fallita | hash=${hash} | error=${dbErr.message}`);
                }
            }
            recordProviderMetric(`cloudBuild.${service}`, false, 0, { error: err.message });
            throw err;
        }).finally(() => cloudBuildInflight.delete(buildKey));

        cloudBuildInflight.set(buildKey, task);
        return task;
    }

    return {
        getBuildKey,
        getServiceResolverLimiter,
        getDbLookupCacheKey,
        cloneManifest,
        getCacheHealthStatus,
        markPlayableResultAsCached,
        markPlayableResultAsUnavailable,
        queueCloudBuild
    };
}

module.exports = { createAppServices };
