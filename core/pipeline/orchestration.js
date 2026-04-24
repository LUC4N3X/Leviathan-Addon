'use strict';

const { shouldUseTorrentPipeline } = require('../source_mode');


function isKitsuRequestId(value) {
  const raw = String(value || '').replace(/^ai-recs:/i, '').trim();
  return /^kitsu(?::|_)?\d+/i.test(raw);
}

function shouldAutoEnableAnimeUnityForKitsu(filters = {}, id = '') {
  if (!filters || Object.prototype.hasOwnProperty.call(filters, 'enableAnimeUnity')) return false;
  return isKitsuRequestId(id);
}

function applyAnimeUnityKitsuBackCompat(config = {}, id = '') {
  const filters = config?.filters || {};
  if (!shouldAutoEnableAnimeUnityForKitsu(filters, id)) return { config, autoAnimeUnity: false };
  return {
    config: {
      ...config,
      filters: {
        ...filters,
        enableAnimeUnity: true,
        __autoAnimeUnityKitsu: true
      }
    },
    autoAnimeUnity: true
  };
}

function createPipelineOrchestration(deps = {}) {
  const {
    crypto,
    logger,
    Cache,
    LIMITERS,
    CONFIG,
    EMPTY_STREAM_TTL,
    streamInflight,
    withSharedPromise,
    incrementMetric,
    recordDuration,
    buildClientCacheMetadata,
    filterByQualityLimit,
    fetchLocalDbResults,
    fetchWebProviderBuckets,
    formatWebProviderBuckets,
    mergeFinalStreams,
    applyConfiguredStreamFilters,
    normalizeCandidateResults,
    applyConfiguredTorrentFilters,
    fetchTitleCandidatePool,
    getMetadata,
    rankResults,
    applyPackKnowledge,
    generateLazyStream,
    resolveDebridLink,
    warmupLazyStreamsInBackground,
    buildSharedStreamCachePolicy,
    getSharedCachedResult,
    getDebridContext,
    resolveTorboxRankedList,
    getEffectiveSearchLanguageMode,
    createAggressiveResultFilter,
    isStreamingCommunityEnabled,
    isSeasonPack,
    createRuntimeItem,
    getNormalizedDebridService,
    getConfiguredDebridKey,
    resolveTorboxRankedListInternal,
    buildExternalAddonRequestId
  } = deps;

  async function generateStream(type, id, config, userConfStr, reqHost) {
    const backCompat = applyAnimeUnityKitsuBackCompat(config, id);
    config = backCompat.config;
    const filters = config.filters || {};
    const debridContext = getDebridContext(config);
    const configuredDebridService = debridContext.service;
    const debridApiKey = debridContext.apiKey;
    const hasDebridKey = debridContext.hasDebridKey;
    const isWebEnabled = Boolean(
      isStreamingCommunityEnabled(filters)
      || filters.enableGhd
      || filters.enableGs
      || filters.enableAnimeWorld
      || filters.enableAnimeUnity
      || filters.enableAnimeSaturn
      || filters.enableGf
      || filters.enableCc
    );
    const isP2PEnabled = filters.enableP2P === true;
    const torrentPipelineEnabled = shouldUseTorrentPipeline({
      filters,
      hasDebridKey,
      isP2PEnabled
    });

    if (!hasDebridKey && !isWebEnabled && !isP2PEnabled) {
      return { streams: [{ name: 'CONFIG', title: 'Inserisci API Key, attiva P2P o attiva una sorgente Web' }] };
    }

    const hashInput = backCompat.autoAnimeUnity ? `${userConfStr || 'no-conf'}|autoAnimeUnityKitsu=v2` : (userConfStr || 'no-conf');
    const configHash = crypto.createHash('md5').update(hashInput).digest('hex');
    const cacheScope = torrentPipelineEnabled ? 'torrent' : 'webonly';
    const cacheKey = `${type}:${id}:${configHash}:${cacheScope}`;
    const inflightKey = `stream:${cacheKey}`;

    const localCachedResult = await Cache.getCachedStream(cacheKey, { allowShared: false });
    if (localCachedResult) return localCachedResult;

    const hadConcurrentInflight = streamInflight.has(inflightKey);
    if (hadConcurrentInflight) {
      const localStaleResult = await Cache.getStaleStream(cacheKey, { allowShared: false });
      if (localStaleResult) {
        incrementMetric('stream.generate.staleWhileRefresh');
        return localStaleResult;
      }
    }

    return withSharedPromise(streamInflight, inflightKey, async () => {
      const cachedAgain = await Cache.getCachedStream(cacheKey, { allowShared: false });
      if (cachedAgain) return cachedAgain;

      const generationStartedAt = Date.now();
      incrementMetric('stream.generate.calls');

      const userTmdbKey = config.tmdb;
      let finalId = id.replace('ai-recs:', '');
      if (finalId.startsWith('tmdb:')) {
        try {
          const parts = finalId.split(':');
          const imdbId = await deps.tmdbToImdb(parts[1], type, userTmdbKey);
          if (imdbId) finalId = (type === 'series' && parts.length >= 4) ? `${imdbId}:${parts[2]}:${parts[3]}` : imdbId;
        } catch (_) {}
      }

      const meta = await LIMITERS.metadata.schedule(() => getMetadata(finalId, type, config));
      if (!meta) return { streams: [] };

      const sharedCachedResult = await getSharedCachedResult(cacheKey, meta, { allowStale: false });
      if (sharedCachedResult) return sharedCachedResult;

      if (hadConcurrentInflight) {
        const sharedStaleResult = await getSharedCachedResult(cacheKey, meta, { allowStale: true });
        if (sharedStaleResult) {
          incrementMetric('stream.generate.staleWhileRefresh');
          return sharedStaleResult;
        }
      }

      logger.info(`[SPEED] Start search for: ${meta.title}`);
      const localDbResults = torrentPipelineEnabled ? await fetchLocalDbResults(meta) : [];
      if (localDbResults.length > 0) logger.info(`[DB READ] Trovati ${localDbResults.length} torrent dal DB locale.`);

      const tmdbLookup = meta.tmdb_id || (meta.kitsu_id ? null : (await deps.imdbToTmdb(meta.imdb_id, userTmdbKey))?.tmdbId);
      const dbOnlyMode = filters.dbOnly === true;
      const langMode = getEffectiveSearchLanguageMode(filters, meta, type);
      const allowItalianWebProviders = langMode !== 'eng';
      const aggressiveFilter = createAggressiveResultFilter(meta, type, langMode);

      const networkResults = torrentPipelineEnabled
        ? await fetchTitleCandidatePool({
            type,
            finalId,
            tmdbIdLookup: tmdbLookup,
            meta,
            config,
            dbOnlyMode,
            langMode,
            aggressiveFilter,
            userTmdbKey,
            seedResults: localDbResults,
            torrentPipelineEnabled
          })
        : [];

      let cleanResults = [];
      let rankedList = [];
      if (torrentPipelineEnabled) {
        cleanResults = await normalizeCandidateResults([...localDbResults, ...networkResults].filter(aggressiveFilter));
        cleanResults = applyPackKnowledge(cleanResults, meta);
        cleanResults = applyConfiguredTorrentFilters(cleanResults, filters);
        logger.info(`[TORRENT PIPELINE] Pool finale filtrato: ${cleanResults.length} risultati.`);

        if (!dbOnlyMode) await deps.persistResults(meta, cleanResults, config);

        rankedList = await rankResults(cleanResults, meta, config, hasDebridKey, configuredDebridService, debridApiKey);
      } else {
        logger.info(`[TORRENT PIPELINE] Disabled for ${meta.title} (solo provider web attivi, nessuna key debrid e P2P off)`);
      }
      const finalRanked = rankedList.slice(0, CONFIG.MAX_RESULTS);
      let debridStreams = [];
      let p2pStreams = [];

      if (finalRanked.length > 0 && hasDebridKey) {
        const topLimit = Math.max(0, Math.min(10, parseInt(filters?.instantDebridTop ?? process.env.INSTANT_DEBRID_TOP ?? '0', 10) || 0));
        const serviceLimiter = deps.getServiceResolverLimiter(configuredDebridService);
        const resolverConfig = { ...config, service: configuredDebridService, rawConf: userConfStr };
        const immediatePromises = finalRanked.slice(0, topLimit).map((item) => {
          const runtimeItem = createRuntimeItem(item, meta);
          return serviceLimiter.schedule(() => resolveDebridLink(resolverConfig, runtimeItem, filters?.showFake, reqHost, meta));
        });
        const lazyCandidates = finalRanked.slice(topLimit).map((item) => createRuntimeItem(item, meta));
        const lazyStreams = lazyCandidates
          .map((item) => generateLazyStream(item, resolverConfig, meta, reqHost, userConfStr, true))
          .filter(Boolean);
        const resolvedInstant = (await Promise.allSettled(immediatePromises)).flatMap((result) => result.status === 'fulfilled' && result.value ? [result.value] : []);
        debridStreams = [...resolvedInstant, ...lazyStreams];
        warmupLazyStreamsInBackground(resolverConfig, lazyCandidates, meta);
      } else if (finalRanked.length > 0 && isP2PEnabled) {
        logger.info(`[P2P MODE] Generating direct streams for ${meta.title}`);
        p2pStreams = finalRanked.map((item) => deps.P2P.formatP2PStream(item, config));
        debridStreams = p2pStreams;
      }

      const rawWebBuckets = await fetchWebProviderBuckets({
        type,
        originalId: id,
        finalId,
        meta,
        config,
        reqHost,
        allowItalianWebProviders,
        dbOnlyMode
      });

      const formattedWebBuckets = formatWebProviderBuckets(rawWebBuckets, meta, config);
      const webStreams = Object.values(formattedWebBuckets || {}).flatMap((bucket) => Array.isArray(bucket) ? bucket : []);
      const webBucketNames = Object.entries(formattedWebBuckets || {})
        .filter(([, bucket]) => Array.isArray(bucket) && bucket.length > 0)
        .map(([bucketName]) => bucketName);

      let finalStreams = mergeFinalStreams(debridStreams, formattedWebBuckets, filters);
      finalStreams = applyConfiguredStreamFilters(finalStreams, filters);

      const enabledWebProvidersCount = [
        isStreamingCommunityEnabled(filters),
        filters.enableGhd,
        filters.enableGs,
        filters.enableAnimeWorld,
        filters.enableAnimeUnity,
        filters.enableAnimeSaturn,
        filters.enableGf,
        filters.enableCc
      ].filter(Boolean).length;

      const cachePolicyBase = buildSharedStreamCachePolicy(meta, {
        cleanResults,
        rankedResults: finalRanked,
        finalStreams,
        debridStreams: hasDebridKey ? debridStreams : [],
        webStreams,
        p2pStreams,
        webBucketNames,
        enabledWebProvidersCount,
        hasDebridKey,
        isP2PEnabled,
        dbOnlyMode,
        debridService: configuredDebridService
      });
      const isGsOnlyWebRequest = cacheScope === 'webonly' && enabledWebProvidersCount === 1 && filters.enableGs === true;
      const emptyAnimeUnityLocalTtl = finalStreams.length === 0 && filters.enableAnimeUnity === true && meta?.kitsu_id
        ? Math.min(Math.max(1, Number(cachePolicyBase.localTtl || EMPTY_STREAM_TTL) || EMPTY_STREAM_TTL), 30)
        : cachePolicyBase.localTtl;
      const emptyGsOnlyLocalTtl = finalStreams.length === 0 && isGsOnlyWebRequest
        ? Math.min(Math.max(1, Number(emptyAnimeUnityLocalTtl || EMPTY_STREAM_TTL) || EMPTY_STREAM_TTL), 20)
        : emptyAnimeUnityLocalTtl;
      const cachePolicy = {
        ...cachePolicyBase,
        localTtl: emptyGsOnlyLocalTtl
      };

      const clientCache = buildClientCacheMetadata(cachePolicy, finalStreams.length);
      const resultObj = {
        streams: finalStreams,
        cacheMaxAge: clientCache.cacheMaxAge,
        staleRevalidate: clientCache.staleRevalidate,
        staleError: clientCache.staleError
      };

      await Cache.cacheStream(cacheKey, resultObj, cachePolicy.localTtl || (finalStreams.length > 0 ? 1800 : EMPTY_STREAM_TTL), {
        imdbId: meta?.imdb_id || null,
        imdbSeason: Number.isInteger(meta?.season) && meta.season > 0 ? meta.season : null,
        imdbEpisode: Number.isInteger(meta?.episode) && meta.episode > 0 ? meta.episode : null,
        episodeLocator: {
          imdbId: meta?.imdb_id || null,
          season: Number.isInteger(meta?.season) && meta.season > 0 ? meta.season : null,
          episode: Number.isInteger(meta?.episode) && meta.episode > 0 ? meta.episode : null
        },
        hashes: cleanResults.map((item) => item?.hash || item?.infoHash).filter(Boolean)
      }, {
        sharedPolicy: cachePolicy
      });

      recordDuration('stream.generate.total', Date.now() - generationStartedAt);
      incrementMetric(finalStreams.length > 0 ? 'stream.generate.nonEmpty' : 'stream.generate.empty');
      logger.info(`[CACHE] SAVED: ${cacheKey} (local=${cachePolicy.localTtl}s, shared=${cachePolicy.allowSharedWrite ? cachePolicy.sharedTtl : 0}s, bucket=${cachePolicy.freshnessBucket}, confidence=${cachePolicy.confidenceScore}, streams=${finalStreams.length})`);
      return resultObj;
    });
  }

  return { generateStream };
}

module.exports = { createPipelineOrchestration };
