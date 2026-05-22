const axios = require("axios");
const crypto = require("crypto");

const { fetchExternalAddonsFlat } = require("./nexus-bridge");
const PackResolver = require("./pack_intelligence");
const aioFormatter = require("./lib/pulse_formatter.cjs");
const TorboxAvailabilityCache = require("./debrid/tb/availability/torbox_availability_cache");
const { TB_CACHE_STATES, normalizeTbCacheState, toRdCacheState, isTbVerified, shortTorboxHash } = require("./debrid/tb/availability/torbox_cache_state");
const { scheduleKeyed } = require('./utils/limits');
const { scheduleRequestTask } = require('./server/request_queue');
const { formatStreamSelector, formatBytes } = require("./lib/stream_formatter");
const { applyTorrentResultFilters } = require("./lib/torrent_result_filters");
const P2P = require("./handlers/p2p_handler");
const { generateSmartQueries, smartMatch } = require("./media_intelligence");
const { rankAndFilterResults } = require("./lib/result_ranker");
const { applySeedHealthRanking, getSeedHealthLogSamples } = require("./lib/seed_health_ranker");
const { applySootioPriorityPolicy } = require("./lib/sootio_priority_policy");
const { enrichTorrentItems } = require("./lib/tracker_enricher");
const { tmdbToImdb, imdbToTmdb, getTmdbAltTitles } = require("./media_identity_resolver");
const tmdbHelper = require("./utils/tmdb_helper");
const kitsuHandler = require("./handlers/kitsu_handler");
const RD = require("./debrid/rd/clients/realdebrid_client");
const TB = require("./debrid/tb/clients/torbox_client");
const dbHelper = require("./storage/db_repository"); 
const { buildMagnet: buildTrackerMagnet } = require("./storage/tracker_registry");
const { createDebridAvailabilityTools } = require("./debrid/availability/debrid_availability");
const { createWebProviderTools } = require("./stream/web_providers");
const SavedCloud = require("./debrid/saved_cloud/debrid_saved_cloud");
const sourceHealth = require("./lib/source_health");
const { createSearchPlan, evaluatePoolSatisfaction } = require("./lib/search_planner");
const { createStreamTrace } = require("./lib/stream_trace");
const { createLanguageFilterTools } = require("./pipeline/language_filter");
const { shouldSkipRecentWork } = require('./recent_work');
const { buildSharedStreamCachePolicy, buildSharedReadContext, shouldUseSharedStreamEntry } = require('./lib/shared_stream_policy');
const { getSourceModeFlags, hasWebProvidersEnabled, shouldUseTorrentPipeline } = require('./config/source_mode');
const {
  isAnimeMetaContext,
  getEpisodeParseOptions,
  shouldIgnoreAnimeSeason,
  mapKitsuEpisodePosition
} = require('./canonical/anime_rules');
const { shouldKeepStrictItalianCandidate, hasStrictItalianEvidence } = require('./canonical/language_guard');
const { runFilterStage, runSortStage } = require('./lib/result_stage_pipeline');
const { buildSeriesContext, matchesCandidateTitle, hasWrongExplicitEpisodeMarker } = require('./matching/episode_matcher');
const { dedupeByInfoHash, getFolderSizeBytes: getDedupeFolderSizeBytes } = require('./stream/infohash_deduper');
const {
  streamRequestQueue,
  buildTorrentioStreamRequestKey,
  normalizeTorrentioBingeGroup,
  sortTorrentioStyleStreams,
  getTorrentioSortMeta,
  buildTorrentioLayeredCachePolicy,
  normalizeTorrentioSources
} = require('./stream/torrentio_stream_core');
const { preserveRdStatusList } = require('./debrid/rd/guards/rd_status_guard');
const { applyResolutionOrderingGuard } = require('./debrid/guards/resolution_ordering_guard');
const { enqueueRdViewScan } = require('./debrid/rd/audit/rd_view_scanner');
const { hasFolderSizeSeasonPackSignal } = require('./matching/season_pack_inspector');
const { buildContentProxyUrlFromBase, shouldProxyContentUrl } = require('./proxy/content_proxy_engine');
const TorrentInfoLedger = require('./torrent/torrent_info_ledger');
const SCRAPER_MODULES = [ require("../providers/engines") ];

const {
  logger, Cache, LIMITERS, CONFIG, REGEX_QUALITY_FILTER, REGEX_SUB_ONLY, REGEX_AUDIO_CONFIRM, REGEX_YEAR, EMPTY_STREAM_TTL, METADATA_CACHE_TTL,
  getLanguageInfo, parseTitleDetails, formatLanguageLabel, isSeasonPack, isGoodShortQueryMatch, chooseBestPackTitle, shouldUpdatePackTitle,
  extractSeasonEpisodeFromFilename, deduplicateResults, filterByQualityLimit, extractInfoHash,
  withTimeout, normalizeSearchText, extractSeeders, extractSize, streamInflight, metadataInflight, withSharedPromise,
  incrementMetric, recordDuration, recordProviderMetric
} = require("./utils");

const { parseKitsuIdentifier } = kitsuHandler;

const languageFilterTools = createLanguageFilterTools({
  logger,
  REGEX_YEAR,
  normalizeSearchText,
  isGoodShortQueryMatch,
  isSeasonPack,
  extractSeasonEpisodeFromFilename,
  smartMatch,
  isAnimeMetaContext,
  shouldIgnoreAnimeSeason,
  getEpisodeParseOptions,
  getExternalDirectUrl,
  keepLanguageCandidateForMode,
  isConfidentSeasonPackItem,
  passesSeriesEpisodeGuard,
  hasStrongSeriesTitleMatch
});

const STREMIO_CACHE_MAX_AGE_DEFAULT = Math.max(60, parseInt(process.env.STREMIO_CACHE_MAX_AGE || '300', 10) || 300);
const STREMIO_STALE_REVALIDATE_DEFAULT = Math.max(STREMIO_CACHE_MAX_AGE_DEFAULT, parseInt(process.env.STREMIO_STALE_REVALIDATE || '600', 10) || 600);
const STREMIO_STALE_ERROR_DEFAULT = Math.max(STREMIO_STALE_REVALIDATE_DEFAULT, parseInt(process.env.STREMIO_STALE_ERROR || '1200', 10) || 1200);

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
    if (!shouldAutoEnableAnimeUnityForKitsu(filters, id)) {
        return { config, autoAnimeUnity: false };
    }

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

function buildClientCacheMetadata(cachePolicy = {}, streamCount = 0) {
    const policyLocalTtl = Math.max(0, Number(cachePolicy?.localTtl || 0) || 0);
    const policyStaleGrace = Math.max(0, Number(cachePolicy?.staleGraceTtl || 0) || 0);
    const baseMaxAge = streamCount > 0
        ? Math.min(STREMIO_CACHE_MAX_AGE_DEFAULT, Math.max(120, policyLocalTtl || STREMIO_CACHE_MAX_AGE_DEFAULT))
        : Math.min(120, Math.max(30, Math.min(policyLocalTtl || 60, 120)));
    const staleRevalidate = Math.max(baseMaxAge, policyStaleGrace, streamCount > 0 ? STREMIO_STALE_REVALIDATE_DEFAULT : Math.max(60, Math.floor(STREMIO_STALE_REVALIDATE_DEFAULT / 2)));
    const staleError = Math.max(staleRevalidate, streamCount > 0 ? STREMIO_STALE_ERROR_DEFAULT : Math.max(120, Math.floor(STREMIO_STALE_ERROR_DEFAULT / 2)));

    return {
        cacheMaxAge: baseMaxAge,
        staleRevalidate,
        staleError
    };
}

function normalizeBingePart(value, fallback = 'x') {
    const normalized = String(value || '')
        .normalize('NFKD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[|]+/g, ' ')
        .replace(/[^a-z0-9+._-]+/gi, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 48);
    return normalized || fallback;
}

function buildQualityCompatibleBingeGroup({ service, quality, details = {}, infoHash, releaseGroup, language, fileIdx = null }) {
    const hdr = Array.isArray(details.dynamicRange) && details.dynamicRange.length
        ? details.dynamicRange.join('+')
        : (/hdr|dolby\s*vision|\bdv\b/i.test(String(details.tags || '')) ? 'HDR' : 'SDR');
    const codec = details.videoCodec || details.codec || '';
    const audio = [details.audioCodec || details.audio, details.audioChannels].filter(Boolean).join('-');
    const group = releaseGroup || details.releaseGroup || (infoHash ? `hash-${String(infoHash).slice(0, 12)}` : 'nohash');
    return normalizeTorrentioBingeGroup({ service, quality, hdr, codec, audio, language, group, infoHash, fileIdx });
}

function getServiceResolverLimiter(service) {
    const normalized = String(service || '').toLowerCase();
    if (normalized === 'tb') return LIMITERS.tbResolve;
    return LIMITERS.rdResolve;
}

function getNormalizedDebridService(configOrService) {
    const raw = typeof configOrService === 'object' && configOrService !== null
        ? configOrService.service
        : configOrService;
    const normalized = String(raw || '').toLowerCase();
    return normalized === 'rd' || normalized === 'tb' ? normalized : null;
}

function getConfiguredDebridKey(config, service = getNormalizedDebridService(config)) {
    if (service === 'tb') return config?.key || config?.tb || config?.torbox || config?.rd || null;
    if (service === 'rd') return config?.key || config?.rd || config?.realdebrid || null;
    return null;
}

function parseBoundedInt(value, fallback, min, max) {
    const parsed = parseInt(value, 10);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.max(min, Math.min(max, parsed));
}

function isTruthyConfigValue(value) {
    return /^(1|true|yes|on)$/i.test(String(value || '').trim());
}

function isWebDebugEnabled() {
    return isTruthyConfigValue(process.env.WEB_PROVIDER_DEBUG) || isTruthyConfigValue(process.env.CB01_DEBUG);
}

function streamWebDebug(message, payload = null) {
    if (!isWebDebugEnabled()) return;
    if (payload && typeof payload === 'object') {
        try { logger.info(`[STREAM WEB:debug] ${message} ${JSON.stringify(payload)}`); }
        catch (_) { logger.info(`[STREAM WEB:debug] ${message}`); }
    } else {
        logger.info(`[STREAM WEB:debug] ${message}`);
    }
}

function shouldAllowRdLazyStreams(filters = {}) {
    return isTruthyConfigValue(filters.enableRdLazyStreams ?? process.env.RD_LAZY_STREAMS ?? 'false');
}

function shouldEnforceRdPlayableOnly(filters = {}) {
    const explicit = filters.rdPlayableOnly
        ?? filters.rdStrictPlayableOnly
        ?? process.env.RD_PLAYABLE_ONLY
        ?? process.env.RD_STRICT_PLAYABLE_ONLY;
    if (explicit === undefined || explicit === null || String(explicit).trim() === '') return true;
    return isTruthyConfigValue(explicit);
}

const RD_DIRECT_RESOLVE_MAX_RESULTS = 32;
const RD_PLAYABLE_DEEP_DB_SCAN_MAX_RESULTS = 48;

function getRdDirectResolveLimit(filters = {}, rankedCount = 0) {
    const hardMax = Math.max(1, Math.min(CONFIG.MAX_RESULTS || 12, RD_DIRECT_RESOLVE_MAX_RESULTS));
    const configured = filters.rdDirectMaxResults ?? process.env.RD_DIRECT_MAX_RESULTS ?? RD_DIRECT_RESOLVE_MAX_RESULTS;
    return Math.min(Math.max(0, rankedCount), parseBoundedInt(configured, hardMax, 1, hardMax));
}

function getRdPlayableDeepDbScanLimit(filters = {}, rankedCount = 0) {
    const hardMax = Math.max(1, Math.min(CONFIG.MAX_RESULTS || 70, RD_PLAYABLE_DEEP_DB_SCAN_MAX_RESULTS));
    const configured = filters.rdPlayableDeepDbScanMaxResults
        ?? filters.rdDeepDbScanMaxResults
        ?? process.env.RD_PLAYABLE_DEEP_DB_SCAN_MAX_RESULTS
        ?? process.env.RD_DEEP_DB_SCAN_MAX_RESULTS
        ?? RD_PLAYABLE_DEEP_DB_SCAN_MAX_RESULTS;
    return Math.min(Math.max(0, rankedCount), parseBoundedInt(configured, hardMax, 1, hardMax));
}

function shouldShowRdDownloadToDebrid(filters = {}) {
    const explicit = filters.allowRdDownloadToDebridRows ?? process.env.RD_ALLOW_DOWNLOAD_TO_DEBRID_ROWS;
    if (explicit !== undefined && explicit !== null && String(explicit).trim() !== '') return isTruthyConfigValue(explicit);
    return false;
}

function shouldShowRdUnknownRows(filters = {}) {
    const explicit = filters.allowRdUnknownRows ?? process.env.RD_ALLOW_UNKNOWN_ROWS;
    if (explicit !== undefined && explicit !== null && String(explicit).trim() !== '') return isTruthyConfigValue(explicit);
    return false;
}

function getRdCandidateState(item = {}) {
    return String(item?._rdCacheState || item?.rdCacheState || item?.cacheState || item?.rd_cache_state || '').toLowerCase().trim();
}

function isRdUnknownCandidate(item = {}) {
    const state = getRdCandidateState(item);
    return !state || state === 'unknown';
}

function shouldHideRdUnreadyCandidate(item = {}, filters = {}) {
    if (isTorrentioRdDownloadCandidate(item) && !shouldShowRdDownloadToDebrid(filters)) return true;
    if (isRdUnknownCandidate(item) && !shouldShowRdUnknownRows(filters)) return true;
    return false;
}

function isKnownRdUnavailableCandidate(item = {}) {
    const state = getRdCandidateState(item);
    if (state === 'likely_uncached' || state === 'uncached' || state === 'uncached_terminal') return true;
    if (item?._dbCachedRd === false || item?.cached_rd === false) return true;
    return false;
}

function getRdVerifiedDbFallbackLimit(filters = {}, fallback = CONFIG.MAX_RESULTS || 12) {
    const hardMax = Math.max(1, Math.min(CONFIG.MAX_RESULTS || 12, 20));
    const configured = filters.rdVerifiedDbFallbackMaxResults ?? process.env.RD_VERIFIED_DB_FALLBACK_MAX_RESULTS ?? String(fallback || hardMax);
    return parseBoundedInt(configured, hardMax, 1, hardMax);
}

function isRdVerifiedDbFallbackCandidate(item = {}) {
    if (!item || !getCandidateInfoHash(item)) return false;
    if (isKnownRdUnavailableCandidate(item)) return false;

    const group = String(item?._sourceGroup || item?.sourceGroup || '').toLowerCase();
    const dbBacked = Boolean(
        isMovieDbPrimaryCandidate(item) ||
        item?._localDb === true ||
        item?._remoteDb === true ||
        item?._myDb === true ||
        item?._dbPrimary === true ||
        group === 'db' ||
        group === 'remote_db' ||
        group === 'local_db' ||
        group === 'external_snapshot' ||
        item?._externalSnapshot === true ||
        item?._fromExternalSnapshot === true
    );
    if (!dbBacked) return false;

    const state = String(item?._rdCacheState || item?.rdCacheState || item?.cacheState || item?.rd_cache_state || '').toLowerCase().trim();
    return Boolean(
        item?._dbCachedRd === true ||
        item?.cached_rd === true ||
        state === 'cached' ||
        state === 'rd_cached' ||
        state === 'instant' ||
        state === 'instant_available'
    );
}

function base64UrlEncodeText(value = '') {
    const text = String(value || '').trim();
    if (!text) return '';
    return Buffer.from(text, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function compactMagnetForCloudBuild(item = {}) {
    const candidates = [item?.magnetLink, item?.magnet, item?.url, item?.directUrl];
    const rawMagnet = candidates.map((value) => String(value || '').trim()).find((value) => /^magnet:\?/i.test(value));
    const hash = getCandidateInfoHash(item) || extractInfoHash(rawMagnet || '');
    if (!hash) return rawMagnet || '';
    const title = String(item?.title || item?.filename || item?.file_title || '').trim();
    const params = [`xt=urn:btih:${String(hash).toUpperCase()}`];
    if (title) params.push(`dn=${encodeURIComponent(title.slice(0, 180))}`);
    const trackers = [];
    if (rawMagnet) {
        try {
            const query = rawMagnet.replace(/^magnet:\?/i, '');
            const parsed = new URLSearchParams(query);
            for (const tr of parsed.getAll('tr')) {
                const tracker = String(tr || '').trim();
                if (tracker && !trackers.includes(tracker)) trackers.push(tracker);
                if (trackers.length >= 8) break;
            }
        } catch (_) {}
    }
    for (const tracker of trackers) params.push(`tr=${encodeURIComponent(tracker)}`);
    return `magnet:?${params.join('&')}`;
}

function getRdDownloadFallbackTarget(filters = {}, fallback = CONFIG.MAX_RESULTS || 12) {
    const hardMax = Math.max(1, Math.min(CONFIG.MAX_RESULTS || 12, 20));
    const configured = filters.rdDownloadFallbackMaxResults ?? process.env.RD_DOWNLOAD_FALLBACK_MAX_RESULTS ?? String(fallback || hardMax);
    return parseBoundedInt(configured, hardMax, 1, hardMax);
}

function uniqueTextList(values = []) {
    const seen = new Set();
    const output = [];

    for (const value of values) {
        const text = String(value || '').trim();
        const key = text.toLowerCase();
        if (!text || seen.has(key)) continue;
        seen.add(key);
        output.push(text);
    }

    return output;
}

function getEffectiveSearchLanguageMode(filters = {}, meta = {}, type = '') {
    return languageFilterTools.getEffectiveSearchLanguageMode(filters, meta, type);
}

function getSeriesEpisodeContext(meta = {}) {
    const season = Number.isInteger(meta?.season) ? meta.season : parseInt(meta?.season, 10);
    const episode = Number.isInteger(meta?.episode) ? meta.episode : parseInt(meta?.episode, 10);
    const isSeries = Boolean(meta?.isSeries || (Number.isFinite(season) && Number.isFinite(episode)));
    return {
        isSeries,
        season: Number.isFinite(season) && season > 0 ? season : 1,
        episode: Number.isFinite(episode) && episode > 0 ? episode : null
    };
}

function buildLeviathanSeriesGuardContext(meta = {}, type = '') {
    const ctx = getSeriesEpisodeContext(meta);
    if (!ctx.isSeries || !(ctx.episode > 0)) return null;
    const aliases = uniqueTextList([
        meta.title,
        meta.name,
        meta.originalTitle,
        meta.original_title,
        meta.originalName,
        meta.original_name,
        meta.aka_titles,
        meta.aliases,
        meta.altTitles,
        meta.titles
    ]);
    return buildSeriesContext({
        cinemetaTitle: meta.title || meta.name || aliases[0] || '',
        aliases,
        season: ctx.season,
        episode: ctx.episode,
        search: `${meta.title || meta.name || ''} S${String(ctx.season).padStart(2, '0')}E${String(ctx.episode).padStart(2, '0')}`
    });
}

function passesSeriesEpisodeGuard(item = {}, meta = {}, type = '') {
    const ctx = buildLeviathanSeriesGuardContext(meta, type);
    if (!ctx) return true;
    const ok = matchesCandidateTitle(item, ctx, { allowSeasonPack: true });
    if (!ok) {
        item._seriesGuardRejected = true;
        item._seriesGuardReason = 'title_or_episode_mismatch';
    }
    return ok;
}

function collectCandidatePackTexts(item = {}) {
    return uniqueTextList([
        item.title,
        item.filename,
        item.file_title,
        item.websiteTitle,
        item.rawDescription,
        item.packTitle,
        item.name
    ]);
}

function parseCandidateEpisodeText(text, meta = {}, type = '') {
    const ctx = getSeriesEpisodeContext(meta);
    return extractSeasonEpisodeFromFilename(String(text || ''), ctx.season || 1, getEpisodeParseOptions(meta, type));
}

function isExactRequestedEpisodeItem(item = {}, meta = {}, type = '') {
    const ctx = getSeriesEpisodeContext(meta);
    if (!ctx.isSeries || !ctx.episode) return false;

    for (const text of collectCandidatePackTexts(item)) {
        const parsed = parseCandidateEpisodeText(text, meta, type);
        if (!parsed || parsed.isRange || parsed.isBatch) continue;
        const seasonOk = parsed.season === ctx.season || shouldIgnoreAnimeSeason(meta, type, text);
        if (seasonOk && parsed.episode === ctx.episode) return true;
    }

    return false;
}

function hasStrictSeasonPackCue(item = {}, meta = {}, type = '') {
    const texts = collectCandidatePackTexts(item);
    if (texts.length === 0) return false;

    for (const text of texts) {
        const parsed = parseCandidateEpisodeText(text, meta, type);
        if (parsed?.isRange || parsed?.isBatch) return true;
    }

    const joined = texts.join(' ');
    if (/\bS\d{1,2}E\d{1,3}\s*(?:-|~|to|a)\s*(?:E)?\d{1,3}\b/i.test(joined)) return true;
    if (/\b\d{1,2}x\d{1,3}\s*(?:-|~|to|a)\s*(?:\d{1,2}x)?\d{1,3}\b/i.test(joined)) return true;
    if (/\b(?:episodes?|episodi?)\s*\d{1,3}\s*(?:-|~|to|a)\s*\d{1,3}\b/i.test(joined)) return true;
    if (/\b(?:batch|complete|completa|full|integrale|collection|raccolta|全集|合集)\b/i.test(joined)) return true;

    const hasSingleEpisodeCue = /\bS\d{1,2}E\d{1,3}\b/i.test(joined) || /\b\d{1,2}x\d{1,3}\b/i.test(joined);
    if (hasSingleEpisodeCue) return false;

    const ctx = getSeriesEpisodeContext(meta);
    const season = ctx.season || 1;
    if (new RegExp(`\\b(?:season|stagione)\\s*0?${season}(?!\\d)`, 'i').test(joined)) return true;
    if (new RegExp(`\\bS0?${season}(?!\\s*E|\\d)`, 'i').test(joined)) return true;

    return false;
}

function isConfidentSeasonPackItem(item = {}, meta = {}, type = '') {
    const ctx = getSeriesEpisodeContext(meta);
    if (!ctx.isSeries) return false;

    if (hasFolderSizeSeasonPackSignal(item)) return true;

    if (isExactRequestedEpisodeItem(item, meta, type)) return false;

    const hasFlag = Boolean(item?._isPack || item?.potentialPack || item?.packTitle || isSeasonPack(item?.title || ''));
    if (!hasFlag && !hasStrictSeasonPackCue(item, meta, type)) return false;
    return hasStrictSeasonPackCue(item, meta, type);
}

function buildExternalAddonRequestIds(type, finalId, meta = {}) {
    const cleanType = String(type || '').toLowerCase() === 'anime' ? 'series' : String(type || '').toLowerCase();
    const rawFinalId = String(finalId || '').replace(/\.json$/i, '').trim();
    const imdbId = String(meta?.imdb_id || '').trim();
    const tmdbId = String(meta?.tmdb_id || '').trim();
    const kitsuId = String(meta?.kitsu_id || '').trim();
    const season = Number(meta?.season || 0);
    const episode = Number(meta?.episode || 0);
    const ids = [];
    const add = (value) => {
        const id = String(value || '').replace(/\.json$/i, '').trim();
        if (id && !ids.includes(id)) ids.push(id);
    };

    if (cleanType === 'series' && season > 0 && episode > 0) {
        const withEpisode = (base) => `${base}:${season}:${episode}`;
        if (imdbId) add(withEpisode(imdbId));
        if (rawFinalId) add(rawFinalId.includes(`:${season}:${episode}`) ? rawFinalId : withEpisode(rawFinalId));
        if (tmdbId) add(withEpisode(`tmdb:${tmdbId}`));
        if (kitsuId) add(kitsuId.includes(`:${season}:${episode}`) ? kitsuId : withEpisode(kitsuId));
        return ids.slice(0, 4);
    }

    if (cleanType === 'movie') {
        if (imdbId) add(imdbId);
        if (rawFinalId) add(rawFinalId);
        if (tmdbId) add(`tmdb:${tmdbId}`);
        return ids.slice(0, 3);
    }

    add(rawFinalId);
    if (imdbId) add(imdbId);
    if (tmdbId) add(`tmdb:${tmdbId}`);
    return ids.slice(0, 3);
}

function buildExternalAddonRequestId(type, finalId, meta = {}) {
    return buildExternalAddonRequestIds(type, finalId, meta)[0] || finalId;
}

function isAnimeTmdbMetadata(tmdbData = {}, type = '') {
    if (String(type || '').toLowerCase() !== 'series') return false;

    const originalLanguage = String(tmdbData?.original_language || '').toLowerCase();
    const genres = Array.isArray(tmdbData?.genres) ? tmdbData.genres : [];
    const genreNames = genres.map((genre) => String(genre?.name || '').toLowerCase());
    const genreIds = genres.map((genre) => Number(genre?.id)).filter(Number.isFinite);
    const originCountries = [
        ...(Array.isArray(tmdbData?.origin_country) ? tmdbData.origin_country : []),
        ...(Array.isArray(tmdbData?.production_countries) ? tmdbData.production_countries.map((country) => country?.iso_3166_1) : []),
        ...(Array.isArray(tmdbData?.networks) ? tmdbData.networks.map((network) => network?.origin_country) : [])
    ]
        .map((value) => String(value || '').toUpperCase())
        .filter(Boolean);

    const japaneseProduction = originalLanguage === 'ja' || originCountries.includes('JP');
    const animated = genreIds.includes(16) || genreNames.some((name) => name.includes('anim'));

    return japaneseProduction && animated;
}

function getLazyCacheKey(service, item, meta) {
    return `${service}:${item.hash}:${meta?.season || item.season || 0}:${meta?.episode || item.episode || 0}:${item.fileIdx !== undefined && item.fileIdx !== null ? item.fileIdx : -1}`;
}

function getLazyResolveInflightKey(service, apiKey, item, meta) {
    const tokenSig = crypto.createHash('sha1').update(String(apiKey || '')).digest('hex').slice(0, 12);
    return `${String(service || 'rd').toLowerCase()}:${tokenSig}:${item.hash}:${meta?.season || item.season || 0}:${meta?.episode || item.episode || 0}:${item.fileIdx !== undefined && item.fileIdx !== null ? item.fileIdx : -1}`;
}

function maybeBuildContentProxyUrl(baseUrl, rawConf, targetUrl, config = {}, options = {}) {
    if (!shouldProxyContentUrl(config, { targetUrl, ...options })) return targetUrl;
    return buildContentProxyUrlFromBase(baseUrl, rawConf, targetUrl, {
        source: options.source || 'debrid',
        filename: options.filename || options.fileName || '',
        headers: options.headers || options.requestHeaders || {},
        ttlSeconds: options.ttlSeconds
    }) || targetUrl;
}

async function hydrateTorrentCandidatesFromLedger(items, meta = {}, stage = 'pipeline') {
    const hydrated = await TorrentInfoLedger.hydrateCandidatesWithLedger(items, meta, {
        dbHelper,
        logger,
        rememberValidatedFileSet
    });
    if (hydrated !== items && Array.isArray(hydrated)) {
        logger.info(`[TORRENT LEDGER] hydrate stage=${stage} in=${Array.isArray(items) ? items.length : 0} out=${hydrated.length}`);
    }
    return hydrated;
}

function getProviderBreakerState(providerName) {
    return sourceHealth.getCircuitState(providerName);
}

function getProviderCircuitState(providerName) {
    return sourceHealth.getCircuitState(providerName);
}

function recordProviderSuccess(providerName, meta = {}) {
    return sourceHealth.recordSuccess(providerName, meta);
}

function recordProviderFailure(providerName, meta = {}) {
    return sourceHealth.recordFailure(providerName, meta);
}

async function resolveLazyStreamData(service, apiKey, item, meta) {
    if (!apiKey || !item?.hash) return null;
    const normalizedService = getNormalizedDebridService(service);
    if (!normalizedService) return null;
    const resolverLimiter = getServiceResolverLimiter(normalizedService);
    const inflightKey = getLazyResolveInflightKey(normalizedService, apiKey, item, meta);

    return withSharedPromise(lazyResolveInflight, `lazy:${inflightKey}`, async () => {
        if (normalizedService === 'tb') {
            return resolverLimiter.schedule(() =>
                TB.getStreamLink(
                    apiKey,
                    item.magnet,
                    String(meta?.season || item.season || 0),
                    String(meta?.episode || item.episode || 0),
                    item.hash,
                    item.fileIdx !== undefined && item.fileIdx !== null ? String(item.fileIdx) : undefined
                )
            );
        }
        return resolverLimiter.schedule(() =>
            RD.getStreamLink(
                apiKey,
                item.magnet,
                meta?.season || item.season || 0,
                meta?.episode || item.episode || 0,
                item.fileIdx
            )
        );
    }, boundedSharedPromiseOptions(LAZY_RESOLVE_INFLIGHT_MAX_ENTRIES, 'lazyResolve.inflight.evicted'));
}

function isTorrentioExternalItem(item = {}) {
    const addon = String(item?.externalAddon || item?._externalAddon || '').toLowerCase();
    const group = String(item?.externalGroup || item?._externalGroup || item?._sourceGroup || '').toLowerCase();
    return group === 'torrentio' || addon.startsWith('torrentio');
}

function isMediaFusionExternalItem(item = {}) {
    const addon = String(item?.externalAddon || item?._externalAddon || '').toLowerCase();
    const group = String(item?.externalGroup || item?._externalGroup || item?._sourceGroup || '').toLowerCase();
    const source = String(item?.source || item?.provider || '').toLowerCase();
    return group === 'mediafusion' || addon === 'mediafusion' || source.includes('mediafusion');
}

function collectTorrentioItalianEvidenceText(item = {}) {
    const info = item?._externalLanguageInfo && typeof item._externalLanguageInfo === 'object'
        ? item._externalLanguageInfo
        : (item?.languageInfo && typeof item.languageInfo === 'object' ? item.languageInfo : {});
    const values = [
        item?.title, item?.name, item?.filename, item?.file_title, item?.packTitle,
        item?.source, item?.provider, item?.externalProvider, item?.externalAddon, item?.externalGroup,
        item?.releaseGroup, item?.language, item?.languages, item?.rawDescription,
        info?.displayLabel, info?.reason, info?.language, info?.languages, info?.detectedLanguages
    ];
    return values.flatMap((value) => Array.isArray(value) ? value : [value]).filter(Boolean).join(' ');
}

function hasLooseItalianToken(value = '') {
    const text = String(value || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, ' ');
    return /(?:🇮🇹|\b(?:ITA|ITALIAN|ITALIANO|ITALIANA)\b|(?:^|[^A-Z0-9])IT(?:[^A-Z0-9]|$))/i.test(text);
}

function hasEnglishLanguageToken(value = '') {
    const text = String(value || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, ' ');
    return /(?:🇬🇧|🇺🇸|\b(?:ENG|ENGLISH)\b|(?:^|[^A-Z0-9])EN(?:[^A-Z0-9]|$))/i.test(text);
}

function hasTorrentioLooseItalianEvidence(item = {}) {
    if (!isTorrentioExternalItem(item)) return false;
    if (String(item?.externalAddon || '').toLowerCase() === 'torrentio_mirror') return true;
    return hasLooseItalianToken(collectTorrentioItalianEvidenceText(item));
}

function getExternalLanguageAudit(item = {}) {
    const info = item?._externalLanguageInfo && typeof item._externalLanguageInfo === 'object'
        ? item._externalLanguageInfo
        : (item?.languageInfo && typeof item.languageInfo === 'object' ? item.languageInfo : {});
    const torrentioLooseItalian = hasTorrentioLooseItalianEvidence(item);
    const confidence = Math.max(Number(item?._externalLanguageConfidence ?? info.confidence ?? 0) || 0, torrentioLooseItalian ? 98 : 0);
    const hasItalianAudio = Boolean(item?._externalHasItalianAudio || info.hasAudioItalian || torrentioLooseItalian);
    const hasItalianSubs = Boolean(item?._externalHasItalianSubs || info.hasSubItalian);
    const hasNegativeLanguage = Boolean(info.hasNegativeLanguage);
    const isItalian = Boolean(item?._externalIsItalian || info.isItalian || hasItalianAudio || torrentioLooseItalian);
    return { info, confidence, hasItalianAudio, hasItalianSubs, hasNegativeLanguage, isItalian, torrentioLooseItalian };
}

function isExternalStrictItalianCandidate(item = {}) {
    const audit = getExternalLanguageAudit(item);

    if (audit.hasItalianAudio) return true;

    const title = item?.title || item?.name || item?.filename || item?.file_title || '';
    const source = [item?.source, item?.provider, item?.externalProvider, item?.externalAddon, item?.releaseGroup].filter(Boolean).join(' ');
    return hasStrictItalianEvidence(title, source);
}

function keepLanguageCandidateForMode(item, meta = {}, langMode = 'ita') {
    const title = String(item?.title || '');
    const source = item?.source;
    if (langMode === 'eng') return keepEnglishCandidate(title, source, meta?.title);
    if (langMode === 'all') return keepAllCandidate(title, source, meta?.title);
    if (item?.isExternal && isExternalStrictItalianCandidate(item)) return true;
    return keepItalianCandidate(title, source, meta?.title);
}

function assessFastResultQuality(items, meta, langMode, config) {
    return languageFilterTools.assessFastResultQuality(items, meta, langMode, config);
}

function getSeriesDbFallbackLimit(filters = {}) {
    const raw = filters.seriesDbFallbackLimit ?? process.env.SERIES_DB_FALLBACK_LIMIT ?? '10';
    return Math.max(0, Math.min(40, parseInt(raw, 10) || 10));
}

function getMovieDbFallbackLimit(filters = {}, service = null) {
    const normalizedService = String(service || '').toLowerCase();
    const defaultLimit = normalizedService === 'rd' && shouldEnforceRdPlayableOnly(filters) ? '24' : '12';
    const raw = filters.movieDbFallbackLimit ?? process.env.MOVIE_DB_FALLBACK_LIMIT ?? defaultLimit;
    return Math.max(0, Math.min(50, parseInt(raw, 10) || parseInt(defaultLimit, 10) || 12));
}

function getMovieDbSnapshotRescueLimit(filters = {}, service = null) {
    const normalizedService = String(service || '').toLowerCase();
    if (normalizedService !== 'rd' && process.env.MOVIE_DB_SNAPSHOT_RESCUE_ALL_SERVICES !== 'true') return 0;
    const defaultLimit = normalizedService === 'rd' && shouldEnforceRdPlayableOnly(filters) ? '24' : '8';
    const raw = filters.movieDbSnapshotRescueLimit ?? process.env.MOVIE_DB_SNAPSHOT_RESCUE_LIMIT ?? defaultLimit;
    return Math.max(0, Math.min(50, parseInt(raw, 10) || parseInt(defaultLimit, 10) || 8));
}

function shouldUseDbSnapshotRescueItem(item = {}) {
    if (!item || isMovieDbPrimaryCandidate(item)) return false;
    const group = String(item?._sourceGroup || item?.sourceGroup || '').toLowerCase();
    const isSnapshot = item?._externalSnapshot === true || item?._fromExternalSnapshot === true || group === 'external_snapshot' || item?._snapshot === true;
    if (!isSnapshot) return false;
    const state = String(item?._rdCacheState || item?.rdCacheState || item?.cacheState || '').toLowerCase();
    if (state === 'uncached_terminal' || state === 'likely_uncached') return false;
    if (item?._dbCachedRd === false || item?.cached_rd === false) return false;
    const seeders = parseInt(item?.seeders, 10) || 0;
    const hasTrustedState = state === 'cached' || state === 'likely_cached' || item?._dbCachedRd === true || item?.cached_rd === true || item?._mediafusionRdAuthority === true || item?._torrentioRdAuthority === true;
    return hasTrustedState || seeders >= Number(process.env.MOVIE_DB_SNAPSHOT_RESCUE_MIN_SEEDERS || 3);
}

function isLocalDbCandidate(item = {}) {
    return Boolean(
        item?._localDb === true ||
        item?._sourceGroup === 'local_db' ||
        item?._dbEpisodeMapping === true ||
        item?._dbLastCachedCheck ||
        item?._dbNextCachedCheck ||
        item?._dbProvider ||
        item?._rdStalePositive === true
    );
}

function isMovieTypeForDbPriority(type = 'movie', meta = {}) {
    return String(type || '').toLowerCase() === 'movie'
        && !meta?.isSeries
        && !(Number(meta?.season || 0) > 0 || Number(meta?.episode || 0) > 0);
}

function isMovieDbPrimaryCandidate(item = {}) {
    const group = String(item?._sourceGroup || item?.sourceGroup || '').toLowerCase();
    if (item?._externalSnapshot === true || item?._fromExternalSnapshot === true || group === 'external_snapshot') return false;
    return Boolean(
        item?._dbPrimary === true ||
        item?._myDb === true ||
        item?._remoteDb === true ||
        isLocalDbCandidate(item) ||
        group === 'db' ||
        group === 'remote_db' ||
        group === 'local_db'
    );
}

function markMovieDbPrimaryCandidate(item = {}, group = 'remote_db') {
    if (!item || typeof item !== 'object') return item;
    return {
        ...item,
        _remoteDb: group === 'remote_db' || item?._remoteDb === true,
        _myDb: true,
        _dbPrimary: true,
        _sourceGroup: item?._sourceGroup || group,
        _fallbackGroup: item?._fallbackGroup || 'db_primary'
    };
}

function getMovieExternalFillLimit(filters = {}, dbPrimaryCount = 0) {
    const raw = filters.movieExternalFillWhenDbLimit ?? process.env.MOVIE_EXTERNAL_FILL_WHEN_DB_LIMIT ?? '2';
    const parsed = parseInt(raw, 10);
    const base = Number.isFinite(parsed) ? Math.max(0, Math.min(20, parsed)) : 2;
    if (dbPrimaryCount <= 0) return 9999;
    return Math.min(base, Math.max(0, dbPrimaryCount - 1));
}

function getMovieDbVerifiedSkipExternalMin(filters = {}, service = null) {
    const normalizedService = String(service || '').toLowerCase();
    const raw = normalizedService === 'tb'
        ? (filters.tbDbVerifiedSkipExternalMin ?? process.env.TB_DB_VERIFIED_SKIP_EXTERNAL_MIN ?? process.env.TORBOX_DB_VERIFIED_SKIP_EXTERNAL_MIN ?? '1')
        : (filters.movieDbVerifiedSkipExternalMin ?? process.env.MOVIE_DB_VERIFIED_SKIP_EXTERNAL_MIN ?? '3');
    const parsed = parseInt(raw, 10);
    const fallback = normalizedService === 'tb' ? 1 : 3;
    return Number.isFinite(parsed) ? Math.max(1, Math.min(20, parsed)) : fallback;
}

function getTorboxDbCoverageSkipExternalMin(filters = {}) {
    const raw = filters.tbDbCoverageSkipExternalMin ?? process.env.TB_DB_COVERAGE_SKIP_EXTERNAL_MIN ?? process.env.TORBOX_DB_COVERAGE_SKIP_EXTERNAL_MIN ?? '3';
    const parsed = parseInt(raw, 10);
    return Number.isFinite(parsed) ? Math.max(1, Math.min(30, parsed)) : 3;
}

function getTorboxDbFastPathMin(filters = {}) {
    const raw = filters.tbDbFastPathMin ?? process.env.TB_DB_FAST_PATH_MIN ?? process.env.TORBOX_DB_FAST_PATH_MIN ?? '3';
    const parsed = parseInt(raw, 10);
    return Number.isFinite(parsed) ? Math.max(1, Math.min(30, parsed)) : 3;
}

function shouldTorboxSkipExternalOnDbCoverage(filters = {}) {
    const value = filters.tbSkipExternalOnDbCoverage ?? process.env.TB_SKIP_EXTERNAL_ON_DB_COVERAGE ?? process.env.TORBOX_SKIP_EXTERNAL_ON_DB_COVERAGE;
    if (value !== undefined && value !== null && String(value).trim() !== '') return isTruthyConfigValue(value);
    return true;
}

function getMovieDbExternalBypassMin(filters = {}) {
    const raw = filters.movieDbExternalBypassMin ?? process.env.MOVIE_DB_EXTERNAL_BYPASS_MIN ?? '8';
    const parsed = parseInt(raw, 10);
    return Number.isFinite(parsed) ? Math.max(1, Math.min(30, parsed)) : 8;
}

function getMovieDbExternalBypassMinForService(filters = {}, service = null) {
    const normalizedService = String(service || '').toLowerCase();
    if (normalizedService === 'tb') return getTorboxDbCoverageSkipExternalMin(filters);
    if (normalizedService === 'rd') {
        const raw = filters.movieDbExternalBypassMinRd ?? process.env.MOVIE_DB_EXTERNAL_BYPASS_MIN_RD ?? '12';
        const parsed = parseInt(raw, 10);
        return Number.isFinite(parsed) ? Math.max(1, Math.min(30, parsed)) : 12;
    }
    return getMovieDbExternalBypassMin(filters);
}

function shouldBypassMovieExternalLive({ verifiedDbCount = 0, dbCandidateCount = 0, filters = {}, service = null, flags = {} } = {}) {
    if (flags?.useProviderCachedOnly) return false;

    const normalizedService = String(service || '').toLowerCase();
    const verifiedMin = getMovieDbVerifiedSkipExternalMin(filters, normalizedService);
    const bypassMin = getMovieDbExternalBypassMinForService(filters, normalizedService);

    if (normalizedService === 'tb') {
        // TorBox fa comunque checkcached/live resolve sulla ranked list: se il DB ha copertura,
        // evitiamo di far vincere subito Torrentio/MediaFusion/Meteor live.
        if (shouldTorboxSkipExternalOnDbCoverage(filters) && dbCandidateCount >= bypassMin) return true;
        return verifiedDbCount >= verifiedMin && dbCandidateCount >= bypassMin;
    }

    if (verifiedDbCount < verifiedMin) return false;

    if (normalizedService === 'rd') return dbCandidateCount >= bypassMin;

    return true;
}

function isMovieDbVerifiedCandidate(item = {}) {
    if (!isMovieDbPrimaryCandidate(item)) return false;
    const state = String(item?._rdCacheState || item?.rdCacheState || item?.cacheState || item?.rd_cache_state || '').toLowerCase();
    return Boolean(
        item?._dbCachedRd === true ||
        item?.cached_rd === true ||
        state === 'cached' ||
        state === 'rd_cached' ||
        state === 'instant' ||
        state === 'instant_available'
    );
}

function countMovieDbVerifiedCandidates(items = []) {
    const seen = new Set();
    let count = 0;
    for (const item of Array.isArray(items) ? items : []) {
        if (!isMovieDbVerifiedCandidate(item)) continue;
        const hash = getCandidateInfoHash(item) || `${String(item?.title || '').toLowerCase()}|${String(item?.source || '').toLowerCase()}`;
        const key = `${hash}:${Number.isInteger(item?.fileIdx) ? item.fileIdx : -1}`;
        if (seen.has(key)) continue;
        seen.add(key);
        count += 1;
    }
    return count;
}

function countDbCoverageCandidates(items = []) {
    const seen = new Set();
    let count = 0;
    for (const item of Array.isArray(items) ? items : []) {
        if (!shouldUseDbCoverageItem(item)) continue;
        const hash = getCandidateInfoHash(item) || `${String(item?.title || '').toLowerCase()}|${String(item?.source || item?.externalProvider || '').toLowerCase()}`;
        const key = `${hash}:${Number.isInteger(item?.fileIdx) ? item.fileIdx : -1}`;
        if (seen.has(key)) continue;
        seen.add(key);
        count += 1;
    }
    return count;
}

function hasEnoughMovieVerifiedDbResults(items = [], filters = {}, service = null) {
    const normalizedService = String(service || '').toLowerCase();
    if (normalizedService === 'tb') {
        return countDbCoverageCandidates(items) >= getTorboxDbFastPathMin(filters)
            || countMovieDbVerifiedCandidates(items) >= getMovieDbVerifiedSkipExternalMin(filters, normalizedService);
    }
    const min = getMovieDbVerifiedSkipExternalMin(filters, normalizedService);
    return countMovieDbVerifiedCandidates(items) >= min;
}

function getCandidateInfoHash(item = {}) {
    const raw = String(item?.hash || item?.infoHash || item?.info_hash || '').trim().toUpperCase();
    if (/^[A-F0-9]{40}$/.test(raw)) return raw;
    return extractInfoHash(item?.magnet || item?.url || item?.directUrl || '') || null;
}

function getDbCoverageScore(item = {}) {
    const state = String(item?._rdCacheState || item?.rdCacheState || item?.cacheState || '').toLowerCase();
    const stateScore = state === 'cached' ? 1_000_000
        : state === 'likely_cached' ? 750_000
            : state === 'probing' ? 450_000
                : state === 'unknown' ? 250_000
                    : state === 'likely_uncached' ? 100_000
                        : 0;
    const seeders = Math.max(0, parseInt(item?.seeders, 10) || 0);
    const size = Number(item?._size || item?.sizeBytes || 0) || 0;
    return stateScore + Math.min(5000, seeders) * 100 + Math.min(5000, Math.floor(size / (1024 * 1024)));
}

function shouldUseDbCoverageItem(item = {}) {
    const state = String(item?._rdCacheState || item?.rdCacheState || item?.cacheState || '').toLowerCase();
    if (state === 'uncached_terminal' || state === 'likely_uncached') return false;
    if (item?._dbCachedRd === false || item?.cached_rd === false) return false;
    return getDbCoverageScore(item) > 0;
}

function preserveMovieLocalDbCoverage(rankedList = [], localDbPool = [], meta = {}, filters = {}, config = {}) {
    const isSeries = Boolean(meta?.isSeries || Number(meta?.season || 0) > 0 || Number(meta?.episode || 0) > 0);
    if (isSeries) return rankedList;

    const service = getNormalizedDebridService(config || {});
    const limit = getMovieDbFallbackLimit(filters, service);
    const snapshotLimit = getMovieDbSnapshotRescueLimit(filters, service);
    const list = Array.isArray(rankedList) ? rankedList : [];
    const sourcePool = Array.isArray(localDbPool) ? localDbPool : [];
    const dbPool = sourcePool.filter((item) => isMovieDbPrimaryCandidate(item) && shouldUseDbCoverageItem(item));
    const snapshotPool = snapshotLimit > 0
        ? sourcePool.filter(shouldUseDbSnapshotRescueItem)
        : [];

    let output = list;
    const existingHashes = new Set(output.map(getCandidateInfoHash).filter(Boolean));

    if (limit > 0 && dbPool.length > 0) {
        const currentDbCount = output.filter(isMovieDbPrimaryCandidate).length;
        const wanted = Math.max(0, Math.min(limit, dbPool.length) - currentDbCount);
        if (wanted > 0) {
            const additions = dbPool
                .filter((item) => {
                    const hash = getCandidateInfoHash(item);
                    return hash && !existingHashes.has(hash);
                })
                .sort((a, b) => getDbCoverageScore(b) - getDbCoverageScore(a))
                .slice(0, wanted)
                .map((item) => ({ ...item, _myDb: true, _dbPrimary: true, _sourceGroup: item?._sourceGroup || 'local_db' }));

            for (const item of additions) {
                const hash = getCandidateInfoHash(item);
                if (hash) existingHashes.add(hash);
            }
            if (additions.length > 0) {
                logger.info(`[DB COVERAGE] movie db-primary fallback added=${additions.length} current=${currentDbCount} limit=${limit} dbPool=${dbPool.length}`);
                output = [...output, ...additions];
            }
        }
    }

    if (snapshotLimit > 0 && snapshotPool.length > 0) {
        const currentSnapshotCount = output.filter((item) => item?._fromExternalSnapshot === true || item?._externalSnapshot === true || String(item?._sourceGroup || '').toLowerCase() === 'external_snapshot').length;
        const wanted = Math.max(0, Math.min(snapshotLimit, snapshotPool.length) - currentSnapshotCount);
        if (wanted > 0) {
            const additions = snapshotPool
                .filter((item) => {
                    const hash = getCandidateInfoHash(item);
                    return hash && !existingHashes.has(hash);
                })
                .sort((a, b) => getDbCoverageScore(b) - getDbCoverageScore(a))
                .slice(0, wanted)
                .map((item) => ({
                    ...item,
                    _fromExternalSnapshot: true,
                    _externalSnapshot: true,
                    _sourceGroup: item?._sourceGroup || 'external_snapshot',
                    _fallbackGroup: item?._fallbackGroup || 'db_snapshot_rescue'
                }));

            if (additions.length > 0) {
                logger.info(`[DB COVERAGE] movie snapshot rescue added=${additions.length} current=${currentSnapshotCount} limit=${snapshotLimit} snapshotPool=${snapshotPool.length} service=${service || 'n/a'}`);
                output = [...output, ...additions];
            }
        }
    }

    return output;
}

function shouldAllowSeriesDbFastPath(filters = {}, service = null) {
    const value = filters.seriesDbFastPath ?? process.env.SERIES_DB_FAST_PATH;
    if (value !== undefined && value !== null && String(value).trim() !== '') return isTruthyConfigValue(value);
    return String(service || '').toLowerCase() === 'tb';
}

function markFallbackGroup(items = [], group = 'fallback') {
    return (Array.isArray(items) ? items : []).map((item) => ({
        ...item,
        _fallbackGroup: group,
        _sourceGroup: item?._sourceGroup || group
    }));
}

function buildGroupedFallbackCandidatePool({ localDbPool = [], networkResults = [], meta = {}, langMode = 'ita', config = {}, filters = {} }) {
    const dbList = Array.isArray(localDbPool) ? localDbPool : [];
    const networkList = Array.isArray(networkResults) ? networkResults : [];
    const isSeries = Boolean(meta?.isSeries || Number(meta?.season || 0) > 0 || Number(meta?.episode || 0) > 0);

    if (!isSeries) {
        const primaryFromDb = dbList.filter(isMovieDbPrimaryCandidate);
        const snapshotFill = dbList.filter((item) => !isMovieDbPrimaryCandidate(item));
        const primaryFromNetwork = networkList.filter(isMovieDbPrimaryCandidate);
        const externalFromNetwork = networkList.filter((item) => !isMovieDbPrimaryCandidate(item));
        const dbPrimary = [...primaryFromDb, ...primaryFromNetwork];

        if (dbPrimary.length > 0) {
            const fillPool = [...snapshotFill, ...externalFromNetwork];
            const fillLimit = getMovieExternalFillLimit(filters, dbPrimary.length);
            const rdAuthorityFillMaxRaw = filters.rdTorrentioAuthorityFillMax ?? process.env.RD_TORRENTIO_AUTHORITY_FILL_MAX ?? '12';
            const rdAuthorityFillMax = Math.max(0, Math.min(30, parseInt(rdAuthorityFillMaxRaw, 10) || 12));
            const isRdService = getNormalizedDebridService(config) === 'rd';
            const authorityFill = isRdService
                ? fillPool.filter(isTorrentioRdAuthorityCandidate).slice(0, rdAuthorityFillMax)
                : [];
            const regularFill = fillPool.slice(0, fillLimit);
            const seenFill = new Set();
            const externalFill = [];
            for (const item of [...authorityFill, ...regularFill]) {
                const hash = getCandidateInfoHash(item) || String(item?.title || item?.name || '').toLowerCase();
                const fileIdx = Number.isInteger(Number(item?.fileIdx)) ? Number(item.fileIdx) : -1;
                const key = `${hash || externalFill.length}:${fileIdx}`;
                if (seenFill.has(key)) continue;
                seenFill.add(key);
                externalFill.push(item);
            }
            logger.info(`[GROUP FALLBACK] movie DB-primary wins | dbPrimary=${dbPrimary.length} local=${primaryFromDb.length} remote=${primaryFromNetwork.length} externalFill=${externalFill.length}/${fillPool.length}${isRdService ? ` rdAuthority=${authorityFill.length}` : ''}`);
            return [
                ...markFallbackGroup(dbPrimary, 'db_primary'),
                ...markFallbackGroup(externalFill, 'external_fill')
            ];
        }

        logger.info(`[GROUP FALLBACK] movie no DB-primary | snapshots=${snapshotFill.length} external=${externalFromNetwork.length}`);
        return [...snapshotFill, ...externalFromNetwork];
    }

    const networkAssessment = assessFastResultQuality(networkList, meta, langMode, config);
    const networkSatisfaction = evaluatePoolSatisfaction(networkAssessment, meta);
    const dbLimit = getSeriesDbFallbackLimit(filters);
    const networkIsPrimarySatisfied = networkSatisfaction.satisfied && Number(networkAssessment.exactEpisodeCount || 0) >= 1;

    if (networkIsPrimarySatisfied) {
        const dbFallback = dbLimit > 0 ? dbList.slice(0, dbLimit) : [];
        logger.info(`[GROUP FALLBACK] series network primary satisfied=${networkSatisfaction.reason} exact=${networkAssessment.exactEpisodeCount} strong=${networkAssessment.strongCount} | dbFallback=${dbFallback.length}/${dbList.length}`);
        return [
            ...markFallbackGroup(networkList, 'network_primary'),
            ...markFallbackGroup(dbFallback, 'db_fallback')
        ];
    }

    logger.info(`[GROUP FALLBACK] series network not enough reason=${networkSatisfaction.reason} exact=${networkAssessment.exactEpisodeCount} strong=${networkAssessment.strongCount} -> include full DB fallback=${dbList.length}`);
    return [
        ...markFallbackGroup(networkList, 'network_primary'),
        ...markFallbackGroup(dbList, 'db_full_fallback')
    ];
}

function getEffectiveLangMode(config, meta = {}, type = '') {
    return getEffectiveSearchLanguageMode(config?.filters || {}, meta, type);
}

const TITLE_SIGNAL_CACHE = new Map();
const MAX_TITLE_SIGNAL_CACHE = 4000;
const lazyResolveInflight = new Map();
const backgroundDbSaveInflight = new Map();
const titleSearchInflight = new Map();
const titleSearchHotCache = new Map();
const validatedFileSetCache = new Map();
const recentBackgroundDbSaves = new Map();
const recentPackResolutionJobs = new Map();
const STREAM_STALE_LOAD_THRESHOLD = Math.max(1, Math.min(200, parseInt(process.env.STREAM_STALE_LOAD_THRESHOLD || '18', 10) || 18));
const STREAM_INFLIGHT_MAX_ENTRIES = Math.max(256, Math.min(20000, parseInt(process.env.STREAM_INFLIGHT_MAX_ENTRIES || '4096', 10) || 4096));
const METADATA_INFLIGHT_MAX_ENTRIES = Math.max(128, Math.min(10000, parseInt(process.env.METADATA_INFLIGHT_MAX_ENTRIES || '2048', 10) || 2048));
const LAZY_RESOLVE_INFLIGHT_MAX_ENTRIES = Math.max(128, Math.min(10000, parseInt(process.env.LAZY_RESOLVE_INFLIGHT_MAX_ENTRIES || '2048', 10) || 2048));
const TITLE_SEARCH_INFLIGHT_MAX_ENTRIES = Math.max(128, Math.min(10000, parseInt(process.env.TITLE_SEARCH_INFLIGHT_MAX_ENTRIES || '2048', 10) || 2048));
const BACKGROUND_DB_SAVE_INFLIGHT_MAX_ENTRIES = Math.max(64, Math.min(5000, parseInt(process.env.BACKGROUND_DB_SAVE_INFLIGHT_MAX_ENTRIES || '512', 10) || 512));
const BACKGROUND_DB_SAVE_DEDUP_MS = Math.max(1000, Math.min(120000, parseInt(process.env.BACKGROUND_DB_SAVE_DEDUP_MS || '15000', 10) || 15000));
const LAZY_WARMUP_LOAD_THRESHOLD = Math.max(1, Math.min(200, parseInt(process.env.LAZY_WARMUP_LOAD_THRESHOLD || '14', 10) || 14));
const TITLE_SEARCH_HOT_TTL_MS = Math.max(5000, Math.min(5 * 60 * 1000, parseInt(process.env.TITLE_SEARCH_HOT_TTL_MS || '45000', 10) || 45000));
const VALIDATED_FILE_SET_TTL_MS = Math.max(30 * 1000, Math.min(60 * 60 * 1000, parseInt(process.env.VALIDATED_FILE_SET_TTL_MS || String(20 * 60 * 1000), 10) || 20 * 60 * 1000));
const TIMED_CACHE_MAX_ENTRIES = Math.max(200, Math.min(10000, parseInt(process.env.TIMED_CACHE_MAX_ENTRIES || '3000', 10) || 3000));
const TIMED_CACHE_SWEEP_INTERVAL_MS = Math.max(1000, Math.min(60 * 1000, parseInt(process.env.TIMED_CACHE_SWEEP_INTERVAL_MS || '5000', 10) || 5000));
const BACKGROUND_DB_SAVE_QUEUE_MAX = Math.max(10, Math.min(1000, parseInt(process.env.BACKGROUND_DB_SAVE_QUEUE_MAX || '120', 10) || 120));
const PACK_RESOLUTION_QUEUE_MAX = Math.max(10, Math.min(1000, parseInt(process.env.PACK_RESOLUTION_QUEUE_MAX || '80', 10) || 80));
const TORRENTIO_EXACT_ACCEPT_ALL = String(process.env.EXT_TORRENTIO_EXACT_ACCEPT_ALL || 'true').toLowerCase() !== 'false';
const TORRENTIO_EXACT_ACCEPT_MAX = Math.max(1, Math.min(50, parseInt(process.env.EXT_TORRENTIO_EXACT_ACCEPT_MAX || '24', 10) || 24));

function shouldAcceptAllTorrentioExact(config = {}, key = '') {
    if (key && Object.prototype.hasOwnProperty.call(config?.filters || {}, key)) return false;
    return TORRENTIO_EXACT_ACCEPT_ALL;
}
const PACK_RESOLVER_HTTP_COOLDOWN_MS = Math.max(5000, Math.min(10 * 60 * 1000, parseInt(process.env.PACK_RESOLVER_HTTP_COOLDOWN_MS || '60000', 10) || 60000));
const recentPackResolverHttpFailures = new Map();
const timedCacheSweepState = new Map();

function boundedSharedPromiseOptions(maxEntries, metricName) {
    return {
        maxEntries,
        onEvict: (count) => {
            if (count > 0) incrementMetric(metricName, count);
        }
    };
}

function getTimedCacheState(map) {
    let state = timedCacheSweepState.get(map);
    if (!state) {
        state = { nextSweepAt: 0 };
        timedCacheSweepState.set(map, state);
    }
    return state;
}

function trimTimedCacheSize(map, maxEntries = TIMED_CACHE_MAX_ENTRIES) {
    while (map.size > maxEntries) {
        const oldestKey = map.keys().next().value;
        if (oldestKey === undefined) break;
        map.delete(oldestKey);
    }
}

function cleanupTimedCache(map, maxEntries = TIMED_CACHE_MAX_ENTRIES, options = {}) {
    if (!(map instanceof Map)) return;
    if (map.size === 0) {
        timedCacheSweepState.delete(map);
        return;
    }
    const now = Date.now();
    const state = getTimedCacheState(map);
    const overCapacity = map.size > maxEntries;
    if (options.force !== true && !overCapacity && now < state.nextSweepAt) return;

    state.nextSweepAt = now + TIMED_CACHE_SWEEP_INTERVAL_MS;

    for (const [key, entry] of map) {
        if (!entry || Number(entry.expiresAt || 0) <= now) map.delete(key);
    }

    trimTimedCacheSize(map, maxEntries);
}

function getTimedCacheValue(map, key) {
    cleanupTimedCache(map);
    const entry = map.get(key);
    if (!entry) return null;
    if (Number(entry.expiresAt || 0) <= Date.now()) {
        map.delete(key);
        return null;
    }
    return entry.value;
}

function setTimedCacheValue(map, key, value, ttlMs, maxEntries = TIMED_CACHE_MAX_ENTRIES) {
    if (!(map instanceof Map) || !key || ttlMs <= 0) return value;
    cleanupTimedCache(map, maxEntries);
    map.set(key, { value, expiresAt: Date.now() + ttlMs });
    trimTimedCacheSize(map, maxEntries);
    return value;
}

function isQueueOverflowError(error) {
    if (!error) return false;
    if (error.code === 'QUEUE_OVERFLOW') return true;
    const message = String(error.message || error);
    return /dropped by bottleneck|queue overflow|highwater/i.test(message);
}

function buildTitleSearchPipelineKey(meta, type, langMode, dbOnlyMode = false, filters = {}) {
    const normalizeArray = (value) => Array.isArray(value)
        ? value.map((entry) => String(entry || '').trim().toLowerCase()).filter(Boolean).sort()
        : [];
    const titles = [meta?.title, meta?.originalTitle, meta?.name]
        .filter(Boolean)
        .map((value) => normalizeSearchText(value))
        .filter(Boolean)
        .slice(0, 6)
        .sort();
    const payload = {
        type: String(type || '').toLowerCase(),
        langMode: String(langMode || '').toLowerCase(),
        dbOnly: dbOnlyMode === true,
        year: Number(meta?.year || 0) || 0,
        season: Number(meta?.season || 0) || 0,
        episode: Number(meta?.episode || 0) || 0,
        filters: {
            sourceMode: String(filters?.sourceMode || (dbOnlyMode ? 'dbOnly' : 'balanced')).toLowerCase(),
            no4k: filters?.no4k === true,
            no1080: filters?.no1080 === true,
            no720: filters?.no720 === true,
            noScr: filters?.noScr === true,
            noCam: filters?.noCam === true,
            maxSizeGB: Number(filters?.maxSizeGB || 0) || 0,
            minSizeGB: Number(filters?.minSizeGB || 0) || 0,
            maxSizeBytes: Number(filters?.maxSizeBytes || 0) || 0,
            minSizeBytes: Number(filters?.minSizeBytes || 0) || 0,
            minSeeders: Number(filters?.minSeeders || 0) || 0,
            maxSeeders: Number(filters?.maxSeeders || 0) || 0,
            providers: normalizeArray(filters?.providers),
            providerAllow: normalizeArray(filters?.providerAllow),
            providerInclude: normalizeArray(filters?.providerInclude),
            providerExclude: normalizeArray(filters?.providerExclude),
            providerDeny: normalizeArray(filters?.providerDeny),
            providerBlock: normalizeArray(filters?.providerBlock),
            qualityAllow: normalizeArray(filters?.qualityAllow),
            qualityInclude: normalizeArray(filters?.qualityInclude),
            qualityExclude: normalizeArray(filters?.qualityExclude),
            qualityDeny: normalizeArray(filters?.qualityDeny),
            qualityFilter: normalizeArray(filters?.qualityFilter),
            requireTags: normalizeArray(filters?.requireTags),
            excludeTags: normalizeArray(filters?.excludeTags),
            sizeFilter: Array.isArray(filters?.sizeFilter)
                ? filters.sizeFilter.map((entry) => String(entry || '').trim().toLowerCase()).filter(Boolean)
                : (filters?.sizeFilter && typeof filters.sizeFilter === 'object'
                    ? {
                        min: String(filters.sizeFilter.min || filters.sizeFilter.from || filters.sizeFilter.gte || '').trim().toLowerCase(),
                        max: String(filters.sizeFilter.max || filters.sizeFilter.to || filters.sizeFilter.lte || '').trim().toLowerCase()
                    }
                    : String(filters?.sizeFilter || '').trim().toLowerCase())
        },
        titles
    };
    return crypto.createHash('sha1').update(JSON.stringify(payload)).digest('hex').slice(0, 20);
}

function buildValidatedFileSetKey(item, meta) {
    const hash = extractInfoHash(item?.hash || item?.infoHash || '');
    if (!hash) return null;
    const season = Number(meta?.season || item?.season || 0) || 0;
    const episode = Number(meta?.episode || item?.episode || 0) || 0;
    const mediaType = meta?.isSeries || season > 0 || episode > 0 ? 'series' : 'movie';
    return `${hash}:${mediaType}:${season}:${episode}`;
}

function getValidatedFileSet(item, meta) {
    const key = buildValidatedFileSetKey(item, meta);
    if (!key) return null;
    return getTimedCacheValue(validatedFileSetCache, key);
}

function rememberValidatedFileSet(item, meta, payload) {
    const key = buildValidatedFileSetKey(item, meta);
    if (!key || !payload || typeof payload !== 'object') return;
    setTimedCacheValue(validatedFileSetCache, key, payload, VALIDATED_FILE_SET_TTL_MS);
}

function detectCodecBucket(text) {
    const raw = String(text || '').toLowerCase();
    if (/\b(?:av1)\b/.test(raw)) return 'av1';
    if (/\b(?:x265|h265|hevc)\b/.test(raw)) return 'hevc';
    if (/\b(?:x264|h264|avc)\b/.test(raw)) return 'avc';
    return 'other';
}

function detectQualityBucket(text) {
    const raw = String(text || '').toLowerCase();
    if (/\b(?:2160p|4k|uhd)\b/.test(raw)) return '4k';
    if (/\b(?:1080p|fhd|full[-.\s]?hd)\b/.test(raw)) return '1080p';
    if (/\b(?:720p|hd)\b/.test(raw)) return '720p';
    return 'sd';
}

function detectReleaseGroupKey(item) {
    const title = String(item?.title || '');
    const source = String(item?.source || item?.provider || '');
    const fromSuffix = title.match(/-(\w{2,20})$/i);
    if (fromSuffix && fromSuffix[1]) return fromSuffix[1].toLowerCase();
    const fromBracket = title.match(/\[(\w{2,20})\]/i);
    if (fromBracket && fromBracket[1]) return fromBracket[1].toLowerCase();
    const trusted = `${title} ${source}`.match(/\b(?:mircrew|corsaro|lux|wms|dn[a4]?|idn_crew|speedvideo|rarbg|yts|yify|qxr|tgx|galaxyrg|framestor|epsilon|ntb|ctrlhd|flux|playweb)\b/i);
    return trusted && trusted[0] ? trusted[0].toLowerCase() : 'generic';
}

function buildDiversityPolicy(config = {}) {
    const filters = config?.filters || {};
    return {
        enabled: filters.disablePremiumDiversity !== true,
        maxPerCodec: Math.max(1, Math.min(6, parseInt(filters.maxPerCodec || process.env.PREMIUM_MAX_PER_CODEC || '3', 10) || 3)),
        maxPerReleaseGroup: Math.max(1, Math.min(5, parseInt(filters.maxPerReleaseGroup || process.env.PREMIUM_MAX_PER_RELEASE_GROUP || '2', 10) || 2)),
        maxPerQuality: Math.max(1, Math.min(8, parseInt(filters.maxPerQualityBucket || filters.maxPerQuality || process.env.PREMIUM_MAX_PER_QUALITY || '4', 10) || 4))
    };
}

function applyPackKnowledge(items, meta) {
    return (Array.isArray(items) ? items : []).map((item) => {
        if (!item) return item;
        const known = getValidatedFileSet(item, meta);
        if (!known) return item;

        const rawFileIndex = known?.raw?.fileIndex ?? known?.raw?.fileIdx;
        const resolvedFileIndex = rawFileIndex === null || rawFileIndex === undefined || rawFileIndex === ''
            ? null
            : (Number.isInteger(Number(rawFileIndex)) ? Number(rawFileIndex) : null);

        if ((item.fileIdx === undefined || item.fileIdx === null) && resolvedFileIndex !== null) item.fileIdx = resolvedFileIndex;
        if (known.title && shouldUpdatePackTitle(item.title, known.title)) item.title = known.title;
        item._packValidated = true;
        item._packTitleSource = known.titleSource || 'validated';
        return item;
    });
}

function getConfiguredSortMode(config = {}) {
    const raw = String(
        config?.ranking?.sortMode ||
        config?.sortMode ||
        config?.sort ||
        config?.filters?.sortMode ||
        config?.filters?.sortBy ||
        config?.filters?.order ||
        config?.filters?.sort ||
        'balanced'
    ).trim().toLowerCase();
    if (['resolution', 'res', 'quality', 'qualita', 'qualità', 'risoluzione'].includes(raw)) return 'resolution';
    if (['size', 'bitrate', 'peso'].includes(raw)) return 'size';
    return 'balanced';
}

function applyPremiumRankingPolicy(results, meta, config) {
    const list = Array.isArray(results) ? results : [];

    const sortMode = getConfiguredSortMode(config);
    if (sortMode === 'resolution' || sortMode === 'size') return list;

    const policy = buildDiversityPolicy(config);
    if (!policy.enabled || list.length <= 2) return list;

    const codecCounts = new Map();
    const groupCounts = new Map();
    const qualityCounts = new Map();
    const selected = [];
    const overflow = [];

    for (const item of list) {
        const title = String(item?.title || '');
        const codec = detectCodecBucket(title);
        const group = detectReleaseGroupKey(item);
        const quality = detectQualityBucket(title);
        const mustKeep = item?._packValidated === true
            || item?._tbCached === true
            || item?._dbCachedRd === true
            || item?.cached_rd === true
            || (meta?.isSeries && Number.isInteger(item?.fileIdx));

        const codecCount = codecCounts.get(codec) || 0;
        const groupCount = groupCounts.get(group) || 0;
        const qualityCount = qualityCounts.get(quality) || 0;
        const overPolicy = codecCount >= policy.maxPerCodec || groupCount >= policy.maxPerReleaseGroup || qualityCount >= policy.maxPerQuality;

        if (!overPolicy || mustKeep) {
            selected.push(item);
            codecCounts.set(codec, codecCount + 1);
            groupCounts.set(group, groupCount + 1);
            qualityCounts.set(quality, qualityCount + 1);
        } else {
            overflow.push(item);
        }
    }

    return [...selected, ...overflow];
}

function getFinalStreamSortText(stream = {}) {
    return String([
        stream?.name,
        stream?.title,
        stream?.description,
        stream?.behaviorHints?.filename,
        stream?.behaviorHints?.bingeGroup,
        stream?.behaviorHints?.vortexMeta?.quality
    ].filter(Boolean).join(' '));
}

function normalizeResolutionSortText(value = '') {
    return String(value || '')
        .normalize('NFKC')
        .replace(/[ᴋＫ]/g, 'k')
        .replace(/[ᴘＰ]/g, 'p')
        .toLowerCase();
}

function getFinalStreamResolutionTier(stream = {}) {
    const text = normalizeResolutionSortText(getFinalStreamSortText(stream));
    if (/\b(?:4320p|8k)\b/.test(text)) return 5;
    if (/\b(?:2160p|4k|uhd)\b/.test(text)) return 4;
    if (/\b(?:1440p|2k|qhd)\b/.test(text)) return 3.5;
    if (/\b(?:1080p|1080i|fhd|full[-.\s]?hd)\b/.test(text)) return 3;
    if (/\b(?:720p|hd)\b/.test(text)) return 2;
    if (/\b(?:576p|480p|sd)\b/.test(text)) return 1;
    return 0;
}

function parseFinalStreamSizeBytes(stream = {}) {
    const text = getFinalStreamSortText(stream);
    const match = text.match(/(\d+(?:[.,]\d+)?)\s*(tib|tb|gib|gb|mib|mb)\b/i);
    if (!match) return 0;
    const value = parseFloat(String(match[1]).replace(',', '.'));
    if (!Number.isFinite(value) || value <= 0) return 0;
    const unit = match[2].toLowerCase();
    if (unit === 'tib' || unit === 'tb') return value * 1024 * 1024 * 1024 * 1024;
    if (unit === 'gib' || unit === 'gb') return value * 1024 * 1024 * 1024;
    return value * 1024 * 1024;
}

function getFinalStreamCacheState(stream = {}) {
    const raw = stream?.cacheState || stream?.rdCacheState || stream?.behaviorHints?.cacheState || stream?.behaviorHints?.rdCacheState || '';
    const normalized = String(raw || '').trim().toLowerCase();
    if (normalized) return normalized;
    const visibleText = `${stream?.name || ''}
${stream?.title || ''}`;
    if (/⚡/.test(visibleText) && /\b(RD|TB)\b/i.test(visibleText)) return 'cached';
    if (/☁️/.test(visibleText) && /\b(RD|TB)\b/i.test(visibleText)) return 'uncached_terminal';
    if (/⏳/.test(visibleText) && /\b(RD|TB)\b/i.test(visibleText)) return 'probing';
    return 'unknown';
}

function getFinalStreamCacheTier(stream = {}) {
    const state = getFinalStreamCacheState(stream);
    if (state === 'cached') return 0;
    if (state === 'likely_cached' || state === 'probing' || state === 'unknown') return 1;
    if (state === 'likely_uncached') return 2;
    if (state === 'uncached_terminal') return 3;
    return 1;
}

function applyFinalStreamUserSort(streams = [], config = {}) {
    const list = Array.isArray(streams) ? streams : [];
    const sortMode = getConfiguredSortMode(config);
    const sorted = sortTorrentioStyleStreams(list, { sortMode });

    if (sortMode === 'resolution' || sortMode === 'size' || sortMode === 'quality') {
        const top = sorted.slice(0, 5).map((stream, index) => {
            const meta = getTorrentioSortMeta(stream, index);
            return `${meta.qualityTier}:${meta.seeders}:${Math.round(meta.sizeBytes / (1024 ** 3))}GB:${String(stream?.title || stream?.name || '').replace(/\s+/g, ' ').slice(0, 45)}`;
        });
        logger.info(`[FINAL SORT] torrentio-style mode=${sortMode} count=${sorted.length} top=${top.join(' | ')}`);
    }

    return sorted;
}

function getMetaDbLookupKey(meta) {
    const imdbId = String(meta?.imdb_id || '').trim().toLowerCase();
    if (!/^tt\d+$/.test(imdbId)) return null;
    const season = Number(meta?.season || 0) || 0;
    const episode = Number(meta?.episode || 0) || 0;
    return `${imdbId}:${season}:${episode}`;
}

async function invalidateStreamCacheForDbSave(meta, reason = 'db_save', scheduleDelayed = true) {
    const imdbId = String(meta?.imdb_id || '').trim().toLowerCase();
    if (!/^tt\d+$/.test(imdbId)) return null;

    const season = Number(meta?.season || 0) || 0;
    const episode = Number(meta?.episode || 0) || 0;
    const isEpisode = season > 0 && episode > 0;

    const outcome = isEpisode && typeof Cache.invalidateStreamsByEpisode === 'function'
        ? await Cache.invalidateStreamsByEpisode({ imdbId, season, episode }, reason)
        : await Cache.invalidateStreamsByImdb(imdbId, reason);

    if (scheduleDelayed) {
        const timer = setTimeout(() => {
            invalidateStreamCacheForDbSave(meta, `${reason}_delayed`, false).catch(() => {});
        }, 2500);
        if (typeof timer.unref === 'function') timer.unref();
    }

    return outcome;
}

const {
    fetchLocalDbResults,
    propagateRdKnownStatesByHash,
    hydrateRdDbStatesByHash,
    reprioritizeRdRankedList,
    getRdAvailabilityState,
    isGuaranteedCachedExternal,
    applyRdDisplayPriority,
    persistResolvedDebridAvailability
} = createDebridAvailabilityTools({
    Cache,
    logger,
    LIMITERS,
    CONFIG,
    incrementMetric,
    isSeasonPack,
    getMetaDbLookupKey
});

const {
    fetchWebProviderBuckets,
    formatWebProviderBuckets,
    mergeFinalStreams,
    isStreamingCommunityEnabled,
    isStreamingCommunityLastEnabled
} = createWebProviderTools({
    Cache,
    LIMITERS,
    CONFIG,
    guardedProviderCall
});

function normalizeResultHash(item = {}) {
    const raw = String(item?.hash || item?.infoHash || '').trim();
    if (/^[a-f0-9]{40}$/i.test(raw)) return raw.toUpperCase();
    return extractInfoHash(raw || item?.magnet || item?.url || item?.directUrl || '');
}

function buildResultsSignature(results) {
    const tokens = [...new Set((Array.isArray(results) ? results : [])
        .map((item) => {
            const hash = normalizeResultHash(item);
            if (!hash) return null;
            const fileIdx = Number.isInteger(item?.fileIdx) ? item.fileIdx : -1;
            return `${hash}:${fileIdx}`;
        })
        .filter(Boolean))]
        .sort()
        .slice(0, 80);

    if (tokens.length === 0) return null;
    return crypto.createHash('sha1').update(tokens.join('|')).digest('hex').slice(0, 20);
}

function setTitleSignalCache(cacheKey, value) {
    if (TITLE_SIGNAL_CACHE.size >= MAX_TITLE_SIGNAL_CACHE) {
        const firstKey = TITLE_SIGNAL_CACHE.keys().next().value;
        if (firstKey !== undefined) TITLE_SIGNAL_CACHE.delete(firstKey);
    }
    TITLE_SIGNAL_CACHE.set(cacheKey, value);
    return value;
}

function getTitleSignalCacheKey(title, metaTitle, sourceName) {
    return crypto.createHash('sha1')
        .update(JSON.stringify([String(title || ''), String(metaTitle || ''), String(sourceName || '')]))
        .digest('hex');
}

function getTitleDiagnostics(title, metaTitle, sourceName) {
    const safeTitle = String(title || '');
    const safeMetaTitle = String(metaTitle || '');
    const safeSource = String(sourceName || '');
    const cacheKey = getTitleSignalCacheKey(safeTitle, safeMetaTitle, safeSource);
    const cached = TITLE_SIGNAL_CACHE.get(cacheKey);
    if (cached) return cached;

    const parsed = parseTitleDetails(safeTitle);
    const langInfo = getLanguageInfo(safeTitle, safeMetaTitle, safeSource, parsed);
    const detected = new Set(Array.isArray(langInfo?.detectedLanguages) ? langInfo.detectedLanguages.map(v => String(v)) : []);
    const upper = safeTitle.toUpperCase();

    return setTitleSignalCache(cacheKey, {
        parsed,
        langInfo,
        normalizedTitle: normalizeSearchText(safeTitle),
        normalizedMeta: normalizeSearchText(safeMetaTitle),
        explicitEng: detected.has('English') || /\b(?:ENG|ENGLISH)\b/i.test(upper),
        explicitIta: detected.has('Italian') || langInfo?.isItalian || (langInfo?.confidence || 0) >= 5 || /\b(?:ITA|ITALIANO|ITALIAN)\b/i.test(upper),
        explicitMulti: !!langInfo?.isMulti || /\b(?:MULTI|DUAL[\s.-]?AUDIO)\b/i.test(upper),
        explicitOther: /\b(?:FRENCH|GERMAN|SPANISH|ESP|LATINO|RUS|RUSSIAN|JPN|JAP|VOSTFR|POLISH|PORTUGUESE|PT-BR|HINDI|KOREAN|CHINESE|ARABIC|TURKISH)\b/i.test(upper),
        neutralScene: /\b(?:WEB[-.\s]?DL|WEBRIP|BLU[-.\s]?RAY|REMUX|BDRIP|2160P|1080P|720P|X265|X264|HEVC|DDP|DTS|TRUEHD|AAC)\b/i.test(upper)
    });
}

function createRuntimeItem(item, meta) {
    return {
        ...item,
        season: meta?.season ?? item?.season ?? 0,
        episode: meta?.episode ?? item?.episode ?? 0
    };
}

function getExternalDirectUrl(item = {}) {
    const candidates = [
        item?._externalDirectUrl,
        item?.externalDirectUrl,
        item?.directUrl,
        item?.url,
        item?.isExternal ? item?.magnet : null
    ];

    for (const value of candidates) {
        const text = String(value || '').trim();
        if (/^https?:\/\//i.test(text)) return text;
    }

    return null;
}

function isLeviathanCloudBuilderUrl(value = '') {
    const text = String(value || '').trim();
    if (!/^https?:\/\//i.test(text)) return false;
    try {
        const url = new URL(text);
        return /\/(?:[^/]+\/)?add_to_cloud\//i.test(url.pathname);
    } catch {
        return /\/add_to_cloud\//i.test(text);
    }
}

function getTorrentioPassthroughUrl(item = {}) {
    if (process.env.RD_TORRENTIO_PASSTHROUGH === 'false') return null;
    if (!isTorrentioExternalItem(item)) return null;
    if (hasTorrentioRdDownloadMarker(item)) return null;
    const candidates = [
        item?._torrentioPlayableUrl,
        item?.externalPlayableUrl,
        item?._externalOriginalUrl,
        item?._externalDirectUrl,
        item?.externalDirectUrl,
        item?.directUrl,
        item?.url
    ];

    for (const value of candidates) {
        const text = String(value || '').trim();
        if (!/^https?:\/\//i.test(text)) continue;
        if (isLeviathanCloudBuilderUrl(text)) continue;
        return text;
    }

    return null;
}

function getMediaFusionPassthroughUrl(item = {}) {
    if (process.env.RD_MEDIAFUSION_PASSTHROUGH === 'false') return null;
    if (!isMediaFusionExternalItem(item)) return null;
    if (process.env.MEDIAFUSION_TRUST_NATIVE_RD_URLS === 'false') return null;
    const candidates = [
        item?._mediafusionPlayableUrl,
        item?.externalPlayableUrl,
        item?._externalOriginalUrl,
        item?._externalDirectUrl,
        item?.externalDirectUrl,
        item?.directUrl,
        item?.url
    ];

    for (const value of candidates) {
        const text = String(value || '').trim();
        if (!/^https?:\/\//i.test(text)) continue;
        if (isLeviathanCloudBuilderUrl(text)) continue;
        return text;
    }

    return null;
}

function annotateMediaFusionPassthroughStream(stream, item = {}, passthroughUrl = '') {
    if (!stream) return stream;
    stream.behaviorHints = {
        ...(stream.behaviorHints || {}),
        mediafusionPassthrough: true,
        externalAddon: item?.externalAddon || item?._externalAddon || undefined,
        externalProvider: item?.externalProvider || undefined,
        cacheState: stream.behaviorHints?.cacheState || stream.cacheState || 'cached',
        rdCacheState: stream.behaviorHints?.rdCacheState || stream.rdCacheState || 'cached'
    };
    stream.cacheState = stream.cacheState || 'cached';
    stream.rdCacheState = stream.rdCacheState || 'cached';
    stream._mediafusionPassthrough = true;
    stream._mediafusionPlayableUrl = passthroughUrl || undefined;
    return stream;
}

function annotateTorrentioPassthroughStream(stream, item = {}, passthroughUrl = '') {
    if (!stream) return stream;
    stream.behaviorHints = {
        ...(stream.behaviorHints || {}),
        torrentioPassthrough: true,
        externalAddon: item?.externalAddon || item?._externalAddon || undefined,
        externalProvider: item?.externalProvider || undefined,
        cacheState: stream.behaviorHints?.cacheState || stream.cacheState || 'cached',
        rdCacheState: stream.behaviorHints?.rdCacheState || stream.rdCacheState || 'cached'
    };
    stream.cacheState = stream.cacheState || 'cached';
    stream.rdCacheState = stream.rdCacheState || 'cached';
    stream._torrentioPassthrough = true;
    stream._torrentioPlayableUrl = passthroughUrl || undefined;
    return stream;
}

function isSparseEpisodeOnlyTitle(value = '') {
    const text = String(value || '')
        .replace(/\.(?:mkv|mp4|avi|mov|wmv)$/i, '')
        .replace(/[._-]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    if (!text) return true;
    return /^(?:s\d{1,2}\s*e\d{1,3}|\d{1,2}\s*x\s*\d{1,3}|e(?:p(?:isode)?)?\s*\d{1,3})$/i.test(text);
}

function hasUsefulReleaseSignals(value = '') {
    return /\b(?:2160p|4k|uhd|1080p|720p|bluray|blu[-.\s]?ray|bdrip|brrip|web[-.\s]?dl|webrip|hdtv|x265|x264|h265|h264|hevc|ita|italian|eng|english|multi|dual)\b/i.test(String(value || ''));
}

function getPreferredFormatterTitle(item = {}, fallback = '') {
    return String(item?._formatterTitle || item?.formatterTitle || item?._externalFormatterTitle || fallback || item?.title || '').trim();
}

function choosePlayableParseTitle(item = {}, candidate = '') {
    const rawCandidate = String(candidate || '').trim();
    const formatterTitle = getPreferredFormatterTitle(item, rawCandidate);
    if (!rawCandidate) return formatterTitle;
    if (isSparseEpisodeOnlyTitle(rawCandidate) && formatterTitle) return formatterTitle;
    if (!hasUsefulReleaseSignals(rawCandidate) && hasUsefulReleaseSignals(formatterTitle)) return `${rawCandidate} ${formatterTitle}`.trim();
    return rawCandidate;
}

function appendExternalLanguageSignalsForFormatter(title = '', item = {}) {
    const output = String(title || '').trim();
    if (!output || !item?.isExternal) return output;

    const languageInfo = item?._externalLanguageInfo && typeof item._externalLanguageInfo === 'object'
        ? item._externalLanguageInfo
        : (item?.languageInfo && typeof item.languageInfo === 'object' ? item.languageInfo : {});
    const evidenceText = [
        item?._formatterTitle,
        item?.formatterTitle,
        item?._externalFormatterTitle,
        item?.rawDescription,
        item?.websiteTitle,
        item?.filename,
        item?.file_title,
        item?.name,
        item?.language,
        Array.isArray(item?.languages) ? item.languages.join(' ') : item?.languages,
        item?.audio,
        languageInfo?.displayLabel,
        languageInfo?.reason,
        Array.isArray(languageInfo?.detectedLanguages) ? languageInfo.detectedLanguages.join(' ') : languageInfo?.detectedLanguages
    ].filter(Boolean).join(' ');

    const tokens = [];
    if (item?._externalHasItalianAudio || item?._externalIsItalian || item?.hasItalianAudio || item?.isItalian || languageInfo?.hasAudioItalian || languageInfo?.isItalian || hasLooseItalianToken(evidenceText)) {
        tokens.push('ITA');
    }
    if (languageInfo?.hasEnglish || hasEnglishLanguageToken(evidenceText)) tokens.push('ENG');
    if (/\b(?:MULTI|DUAL[\s.-]?AUDIO)\b/i.test(evidenceText)) tokens.push('MULTI');

    const missing = tokens.filter((token) => !new RegExp(`(?:^|[^A-Z0-9])${token}(?:[^A-Z0-9]|$)`, 'i').test(output));
    return missing.length ? `${output} ${missing.join(' ')}` : output;
}

function getObservedSizeBytes(...values) {
    for (const value of values) {
        const parsed = Number(value);
        if (Number.isFinite(parsed) && parsed > 0) return parsed;
    }
    return 0;
}

function getObservedFolderSizeBytes(item = {}) {
    return getDedupeFolderSizeBytes(item);
}

function getResolvedFileIdx(item = {}) {
    const candidates = [
        item?.fileIdx,
        item?.fileIndex,
        item?.file_index,
        item?.rd_file_index,
        item?.tb_file_id,
        item?.episodeFileHint?.fileIdx,
        item?.episodeFileHint?.fileIndex,
        item?._episodeFileHint?.fileIdx,
        item?._episodeFileHint?.fileIndex
    ];
    for (const value of candidates) {
        const parsed = Number(value);
        if (Number.isInteger(parsed) && parsed >= 0) return parsed;
    }
    return null;
}

function getDedupeContext(meta = {}, extra = {}) {
    const isSeries = Boolean(meta?.isSeries || Number(meta?.season || 0) > 0 || Number(meta?.episode || 0) > 0);
    return {
        ...extra,
        meta,
        isSeries,
        season: Number(meta?.season || 0) || 0,
        episode: Number(meta?.episode || 0) || 0
    };
}

function getObservedSeederCount(...values) {
    for (const value of values) {
        const parsed = Number.parseInt(value, 10);
        if (Number.isFinite(parsed) && parsed > 0) return parsed;
    }
    return null;
}

function pad2(value) {
    const num = parseInt(value, 10) || 0;
    return num < 10 ? `0${num}` : `${num}`;
}

function getEpisodeDisplayTitle(meta, fallbackTitle) {
    if (!meta?.title || !(meta?.season > 0 || meta?.episode > 0)) return fallbackTitle;
    return `${meta.title} S${pad2(meta.season)}E${pad2(meta.episode)}`;
}

function detectQualityLabel(text, fallback = 'SD') {
    const upper = String(text || '').toUpperCase();
    if (/\b(?:4K|2160P|UHD)\b/.test(upper)) return '4K';
    if (/\b(?:1080P|FHD|FULLHD)\b/.test(upper)) return '1080p';
    if (/\b(?:720P|HD)\b/.test(upper)) return '720p';
    if (/\b(?:480P|SD)\b/.test(upper)) return 'SD';
    return fallback || 'SD';
}

const QUALITY_CAM_REGEX = /\b(?:cam|hdcam|ts|telesync|screener|scr)\b/i;

function getQualityFilterSignals(text, options = {}) {
    const raw = String(text || '');
    const lower = raw.toLowerCase();
    const upper = raw.toUpperCase();
    const has4k = REGEX_QUALITY_FILTER["4K"].test(lower);
    const has1080 = REGEX_QUALITY_FILTER["1080p"].test(lower);
    const has720 = REGEX_QUALITY_FILTER["720p"].test(lower)
        || Boolean(options.treatGenericHdAs720 && /\bHD\b/.test(upper) && !/\b(?:1080P|2160P|4K|FHD|UHD|FULLHD)\b/.test(upper));
    const hasSd = REGEX_QUALITY_FILTER["SD"].test(lower);
    const hasCam = QUALITY_CAM_REGEX.test(raw);
    return { has4k, has1080, has720, hasSd, hasCam };
}

function shouldDropByConfiguredQuality(text, filters = {}, options = {}) {
    const quality = getQualityFilterSignals(text, options);
    if (filters.no4k && quality.has4k) return true;
    if (filters.no1080 && quality.has1080) return true;
    if (filters.no720 && quality.has720) return true;
    if (filters.noScr && (quality.hasSd || quality.hasCam)) return true;
    if (filters.noCam && quality.hasCam) return true;
    return false;
}

function getConfiguredQualityFilterText(item = {}) {
    return [
        item?.title,
        item?.name,
        item?.filename,
        item?.fileName,
        item?.file_title,
        item?.rawDescription,
        item?.quality,
        item?.resolution,
        item?._releaseDetails?.quality,
        item?._releaseDetails?.qualityLabel,
        item?.behaviorHints?.filename,
        item?.behaviorHints?.videoResolution,
        item?.behaviorHints?.bingeGroup
    ].filter(Boolean).join(' ');
}

function isBlockedByUserQualityFilters(item = {}, filters = {}) {
    return shouldDropByConfiguredQuality(getConfiguredQualityFilterText(item), filters, { treatGenericHdAs720: true });
}

function getTorrentioTrustDedupeKey(item = {}) {
    const hash = String(item?.hash || item?.infoHash || '').trim().toLowerCase();
    const fileIdx = Number.isInteger(Number(item?.fileIdx)) ? Number(item.fileIdx) : -1;
    const direct = String(item?.directUrl || item?.url || item?._externalDirectUrl || '').trim().toLowerCase();
    const title = String(item?.title || item?.name || item?.filename || '').trim().toLowerCase();
    const source = String(item?.source || item?.provider || item?.externalProvider || item?.externalAddon || item?._externalRequestId || '').trim().toLowerCase();
    if (shouldForceKeepTorrentioIt(item)) {
        return ['torrentio-force', hash || 'nohash', fileIdx, direct || 'nodirect', title || 'notitle', source || 'nosource'].join(':');
    }
    if (hash) return `${hash}:${fileIdx}`;
    if (direct) return direct;
    return title;
}

function shouldForceKeepTorrentioIt(item = {}) {
    return Boolean(item?._torrentioLooseItForceKeep || item?._torrentioExactGuard);
}

function mergeForcedTorrentioItItems(filtered = [], original = [], filters = {}) {
    const output = Array.isArray(filtered) ? [...filtered] : [];
    const seen = new Set(output.map(getTorrentioTrustDedupeKey).filter(Boolean));
    for (const item of Array.isArray(original) ? original : []) {
        if (!shouldForceKeepTorrentioIt(item)) continue;
        if (isBlockedByUserQualityFilters(item, filters)) continue;
        const key = getTorrentioTrustDedupeKey(item);
        if (!key || seen.has(key)) continue;
        seen.add(key);
        output.push(item);
    }
    return output;
}

function applyConfiguredTorrentFilters(items, filters = {}) {
    const list = Array.isArray(items) ? items : [];
    if (!filters || Object.keys(filters).length === 0) return list;
    const filtered = applyTorrentResultFilters(list, filters);
    return mergeForcedTorrentioItItems(filtered, list, filters);
}

function applyConfiguredStreamFilters(streams, filters = {}) {
    const list = Array.isArray(streams) ? streams : [];
    if (!filters || Object.keys(filters).length === 0) return list;
    return list.filter(stream => !isBlockedByUserQualityFilters(stream, filters));
}

async function normalizeCandidateResults(items, meta = {}) {
    const trackerPass = enrichTorrentItems(Array.isArray(items) ? items : []);
    if (trackerPass.stats.enriched > 0) {
        logger.info(`[TRACKER] enriched=${trackerPass.stats.enriched}/${trackerPass.stats.total} trackersAdded=${trackerPass.stats.trackersAdded} maxPerMagnet=${trackerPass.stats.maxTrackers}`);
    }

    let normalized = deduplicateResults(trackerPass.results, meta);
    const beforeForceMergeCount = normalized.length;
    normalized = mergeForcedTorrentioItItems(normalized, trackerPass.results);
    if (normalized.length > beforeForceMergeCount) {
        logger.info(`[EXTERNAL GUARD] Torrentio IT restore after generic dedupe | added=${normalized.length - beforeForceMergeCount} total=${normalized.length}`);
    }
    normalized = propagateRdKnownStatesByHash(normalized, meta);
    normalized = await hydrateRdDbStatesByHash(normalized, meta);
    return normalized;
}

function escapeRegExpLocal(value) {
    return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function tokenizeSeriesTitle(value) {
    return normalizeSearchText(value)
        .replace(/\b(?:2160p|1080p|720p|480p|4k|uhd|hdr|hdr10|dv|dolby\s*vision|hevc|x265|x264|h265|h264|bluray|blu\s*ray|brrip|bdrip|web\s*dl|webrip|web|hdtv|remux|proper|repack|rerip|internal|extended|uncut|remastered|aac|ac3|eac3|ddp\d*\.?\d*|dts|truehd|atmos|ita|eng|multi|sub|subs|vostfr|dubbed|dual|audio)\b/gi, ' ')
        .replace(/\b(?:19\d{2}|20\d{2})\b/g, ' ')
        .split(/\s+/)
        .filter(token => token && token.length >= 2);
}

function extractPrimarySeriesTitle(value) {
    const raw = normalizeSearchText(value)
        .replace(/[\[\]\(\){}]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    if (!raw) return '';

    const cutPatterns = [
        /\bs\d{1,2}\s*e\d{1,3}\b/i,
        /\b\d{1,2}x\d{1,3}\b/i,
        /\bseason\s*\d{1,2}\b/i,
        /\bstagione\s*\d{1,2}\b/i,
        /\bepisode\s*\d{1,3}\b/i,
        /\bepisodio\s*\d{1,3}\b/i,
        /\bep\.?\s*\d{1,3}\b/i,
        /\bcomplete\b/i,
        /\bcompleta\b/i,
        /\bpack\b/i
    ];

    let cutIndex = raw.length;
    for (const pattern of cutPatterns) {
        const match = raw.match(pattern);
        if (match && typeof match.index === 'number' && match.index < cutIndex) cutIndex = match.index;
    }

    return raw
        .slice(0, cutIndex)
        .replace(/\b(?:19\d{2}|20\d{2})\b/g, ' ')
        .replace(/\b(?:proper|repack|rerip|internal|extended|uncut|remastered)\b/gi, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function hasStrongSeriesTitleMatch(title, meta) {
    const candidatePrimary = extractPrimarySeriesTitle(title);
    const candidateTokens = tokenizeSeriesTitle(candidatePrimary);
    if (candidateTokens.length === 0) return false;

    const allowedExtraTokens = new Set(['us', 'uk', 'it']);
    const variants = [meta?.title, meta?.originalTitle, meta?.name]
        .filter(Boolean)
        .map(value => normalizeSearchText(value))
        .filter(Boolean);

    for (const variant of variants) {
        const variantPrimary = extractPrimarySeriesTitle(variant) || normalizeSearchText(variant).trim();
        const targetTokens = tokenizeSeriesTitle(variantPrimary);
        if (targetTokens.length === 0) continue;

        const candidateSet = new Set(candidateTokens);
        if (targetTokens.some(token => !candidateSet.has(token))) continue;

        const extras = candidateTokens.filter(token => !targetTokens.includes(token) && !allowedExtraTokens.has(token));
        const exactPhrase = new RegExp(`(?:^|\\b)${escapeRegExpLocal(variantPrimary)}(?:\\b|$)`, 'i').test(candidatePrimary);

        if (targetTokens.length === 1) {
            if (candidateTokens.length === 1 && extras.length === 0) return true;
            if (exactPhrase && extras.length === 0) return true;
            continue;
        }

        if (exactPhrase && extras.length <= 1) return true;
        if (extras.length === 0) return true;
    }

    return false;
}

function createAggressiveResultFilter(meta, type, langMode) {
    return languageFilterTools.createAggressiveResultFilter(meta, type, langMode);
}

function isSeriesTorrentContext(meta = {}, type = 'series') {
    return String(type || '').toLowerCase() === 'series' || Boolean(meta?.isSeries || Number(meta?.season || 0) > 0 || Number(meta?.episode || 0) > 0);
}

function hasTrustedItalianEvidenceForTorrentPack(item = {}, meta = {}, langMode = 'ita') {
    if (langMode !== 'ita') return true;
    if (isExternalStrictItalianCandidate(item)) return true;

    const title = item?.title || item?.name || item?.filename || item?.file_title || '';
    const source = [item?.source, item?.provider, item?.externalProvider, item?.externalAddon, item?.releaseGroup, item?.language, item?.languages].filter(Boolean).join(' ');
    if (hasStrictItalianEvidence(title, source)) return true;

    if (item?._torrentioExactGuard === true || item?._sourceGroup === 'external') return true;
    return false;
}

function shouldBypassAggressiveFilterForTrustedSeriesPack(item = {}, aggressiveFilter, { meta = {}, type = 'series', langMode = 'ita' } = {}) {
    if (!item || !isSeriesTorrentContext(meta, type)) return false;
    if (item?._torrentioExactGuard === true) return true;

    const title = String(item?.title || item?.name || item?.filename || item?.file_title || '');
    if (!title) return false;
    if (!hasStrongSeriesTitleMatch(title, meta)) return false;
    if (!hasTrustedItalianEvidenceForTorrentPack(item, meta, langMode)) return false;

    const season = Number(meta?.season || 0) || 0;
    const episode = Number(meta?.episode || 0) || 0;
    if (season > 0 && hasWrongExplicitEpisodeMarker(title, { season, episode }) && !shouldIgnoreAnimeSeason(meta, type, title)) return false;

    return Boolean(item?._isPack || item?.potentialPack || isConfidentSeasonPackItem(item, meta, type) || hasRequestedSeasonCue(item, meta, type));
}

function keepAfterAggressiveFilter(item = {}, aggressiveFilter, context = {}) {
    if (shouldForceKeepTorrentioIt(item)) return true;
    if (typeof aggressiveFilter !== 'function') return true;
    if (aggressiveFilter(item)) return true;
    return shouldBypassAggressiveFilterForTrustedSeriesPack(item, aggressiveFilter, context);
}

function filterWithTorrentPackTrust(items = [], aggressiveFilter, context = {}) {
    return (Array.isArray(items) ? items : []).filter((item) => keepAfterAggressiveFilter(item, aggressiveFilter, context));
}

function summarizeTorboxCacheStates(items = []) {
    const counts = {
        cached_verified: 0,
        likely_cached: 0,
        uncertain: 0,
        queued: 0,
        uncached: 0,
        error: 0
    };
    for (const item of items) {
        const state = normalizeTbCacheState(item?._tbCacheStateRaw || item?.tb_cache_state || item?.tbCacheStateRaw || item?._tbCacheState || item?.tbCacheState);
        counts[state] = (counts[state] || 0) + 1;
    }
    return counts;
}

function applyTorboxCacheResultToItem(item, result = {}) {
    const state = normalizeTbCacheState(
        result?.state || result?.cache_state || result?.tb_cache_state || (result?.cached === true ? TB_CACHE_STATES.CACHED_VERIFIED : (result?.cached === false ? TB_CACHE_STATES.UNCACHED : TB_CACHE_STATES.UNCERTAIN))
    );
    const rdState = toRdCacheState(state);

    item._tbLiveChecked = true;
    item._tbCacheStateRaw = state;
    item.tbCacheStateRaw = state;
    item.tb_cache_state = state;
    item._tbCacheState = rdState;
    item.tbCacheState = rdState;
    item._tbCacheConfidence = Number(result?.confidence || 0) || 0;
    item._tbCacheMatchReason = result?.match_reason || null;

    if (isTbVerified(state)) {
        item._tbCached = true;
        item.tbCached = true;
        item.tb_cached = true;
        if (result.file_size) {
            item._size = result.file_size;
            item.sizeBytes = result.file_size;
        }
        if (result.file_id !== undefined && result.file_id !== null) {
            item.fileIdx = result.file_id;
            item.tb_file_id = result.file_id;
        }
        if (result.file_title) item.file_title = result.file_title;
    } else {
        item._tbCached = false;
        item.tbCached = false;
        item.tb_cached = false;
    }

    return state;
}

async function resolveTorboxRankedList(rankedList, apiKey) {
    const sourceRanked = Array.isArray(rankedList) ? [...rankedList] : [];
    const progressiveWindows = [30, 60, 90];
    let verifiedList = [];
    let usedWindow = 0;

    for (const checkLimit of progressiveWindows) {
        const candidates = sourceRanked.slice(0, checkLimit);
        if (candidates.length === 0) break;

        logger.info(`[torbox.cache.check.start] window=${candidates.length} sample=${candidates.slice(0, 3).map((item) => shortTorboxHash(item?.hash)).join(',')}`);
        const cacheResults = await LIMITERS.tbResolve.schedule(() => TorboxAvailabilityCache.checkCacheSync(candidates, apiKey, dbHelper, checkLimit));
        verifiedList = [];

        for (const item of candidates) {
            const hash = String(item?.hash || '').toLowerCase();
            const result = cacheResults?.[hash] || { state: TB_CACHE_STATES.UNCACHED, cached: false };
            const state = applyTorboxCacheResultToItem(item, result);
            if (isTbVerified(state)) {
                verifiedList.push(item);
            }
        }

        const counts = summarizeTorboxCacheStates(candidates);
        logger.info(`[torbox.cache.check.result] window=${candidates.length} verified=${counts.cached_verified} likely=${counts.likely_cached} uncertain=${counts.uncertain} queued=${counts.queued} uncached=${counts.uncached} error=${counts.error}`);
        if (verifiedList.length > 0) {
            const topReason = verifiedList.slice(0, 3).map((item) => `${shortTorboxHash(item?.hash)}:${item?._tbCacheMatchReason || 'cached_verified'}`).join(',');
            logger.info(`[torbox.rank.reason] kept=${verifiedList.length} reason=cached_verified_only sample=${topReason}`);
        }

        usedWindow = candidates.length;
        if (verifiedList.length >= Math.min(12, CONFIG.MAX_RESULTS) || checkLimit === progressiveWindows[progressiveWindows.length - 1]) break;
    }

    logger.info(`📦 [TB CLEANUP] Finestra usata: ${usedWindow} -> Rimasti: ${verifiedList.length}`);

    const remainingItems = sourceRanked.slice(usedWindow);
    if (remainingItems.length > 0) TorboxAvailabilityCache.enrichCacheBackground(remainingItems, apiKey, dbHelper);

    return verifiedList;
}

function getServiceDisplayName(service) {
    const normalized = String(service || '').toLowerCase();
    if (normalized === 'rd') return 'realdebrid';
    if (normalized === 'tb') return 'torbox';
    if (normalized === 'web') return 'web';
    return 'p2p';
}

const STREAM_BAD_AUX_FILE_REGEX = /(?:^|[\s._\-\[\]()])(?:sample|trailer|promo|preview|screens?|proof|nfo|cover|poster|thumbs?|extras?|featurette|making[\s._-]?of|behind[\s._-]?the[\s._-]?scenes|commentary)(?:$|[\s._\-\[\]()])/i;
const STREAM_BAD_ARCHIVE_REGEX = /\.(?:rar|zip|7z|tar|gz|bz2|xz|nfo|txt|jpg|jpeg|png|gif|webp|srt|sub|idx|ass|ssa)(?:$|[?&#\s])/i;
const STREAM_BAD_PAYLOAD_REGEX = /(?:^|[\s._\-\[\]()])(?:password|passw(?:or)?d|keygen|crack|patch|setup|installer|readme|virus|malware)(?:$|[\s._\-\[\]()])/i;
const STREAM_LOW_QUALITY_CAPTURE_REGEX = /\b(?:camrip|hdcam|cam|telesync|telecine|dvdscr|bdscr|screener)\b/i;
const BLOCK_LOW_QUALITY_CAPTURE_RELEASES = /^(1|true|yes|y|on)$/i.test(String(process.env.LEVIATHAN_BLOCK_LOW_QUALITY_RELEASES || 'false'));

function buildStreamGuardText(item = {}, parseTitle = '', displayTitle = '') {
    return [
        parseTitle,
        displayTitle,
        item?.title,
        item?.filename,
        item?.fileName,
        item?.file_title,
        item?.releaseName,
        item?.name,
        item?.url,
        item?.behaviorHints?.filename,
        item?.episodeFileHint?.fileName,
        item?._episodeFileHint?.fileName
    ]
        .filter(Boolean)
        .map((value) => String(value))
        .join(' ');
}

function getTorrentioStyleBadReleaseReason(item = {}, parseTitle = '', displayTitle = '') {
    const text = buildStreamGuardText(item, parseTitle, displayTitle);
    if (!text) return '';

    if (STREAM_BAD_AUX_FILE_REGEX.test(text)) return 'auxiliary_file';
    if (STREAM_BAD_ARCHIVE_REGEX.test(text)) return 'non_video_payload';
    if (STREAM_BAD_PAYLOAD_REGEX.test(text)) return 'unsafe_payload';
    if (BLOCK_LOW_QUALITY_CAPTURE_RELEASES && STREAM_LOW_QUALITY_CAPTURE_REGEX.test(text)) return 'low_quality_capture';
    return '';
}

function shouldBlockTorrentioStyleBadRelease(item = {}, parseTitle = '', displayTitle = '') {
    return Boolean(getTorrentioStyleBadReleaseReason(item, parseTitle, displayTitle));
}

function logBlockedTorrentioStyleBadRelease(item = {}, parseTitle = '', displayTitle = '', stage = 'build-stream') {
    const reason = getTorrentioStyleBadReleaseReason(item, parseTitle, displayTitle) || 'bad_release';
    const text = buildStreamGuardText(item, parseTitle, displayTitle)
        .replace(/[\r\n\t]+/g, ' ')
        .replace(/\s{2,}/g, ' ')
        .trim()
        .slice(0, 140);
    logger.info(`[STREAM BLOCKED] skip | reason=torrentio_bad_release:${reason} stage=${stage} hash=${item?.hash || 'n/a'} fileIdx=${getResolvedFileIdx(item) ?? 'n/a'} title="${text || 'n/a'}"`);
}

function buildPlayableStream({ service, item, streamUrl, displayTitle, parseTitle, sizeBytes, seeders, config, meta, isLazy = false, isPack = false }) {
    const normalizedService = String(service || '').toLowerCase();
    const isAIOActive = aioFormatter.isAIOStreamsEnabled(config);
    const baseParseTitle = appendExternalLanguageSignalsForFormatter(choosePlayableParseTitle(item, parseTitle || item?.title || displayTitle || ''), item);

    if (shouldBlockTorrentioStyleBadRelease(item, baseParseTitle, displayTitle)) {
        logBlockedTorrentioStyleBadRelease(item, baseParseTitle, displayTitle, isLazy ? 'lazy-stream' : 'direct-stream');
        return null;
    }

    const details = parseTitleDetails(baseParseTitle);
    const languageInfo = getLanguageInfo(baseParseTitle, meta?.title, item?.source, details);
    const quality = details.qualityLabel && details.qualityLabel !== 'Other'
        ? details.qualityLabel
        : detectQualityLabel(baseParseTitle, details.quality || 'SD');
    const serviceLabel = normalizedService === 'tb' ? 'TB' : normalizedService.toUpperCase();
    const availabilityState = getRdAvailabilityState(normalizedService, item, meta);
    const isSavedCloudStream = Boolean(item?.isSavedCloud || item?._savedCloud || item?.savedCloud);
    const formatterSource = item?.source;
    const displayLanguage = formatLanguageLabel(languageInfo, details.languages, getEffectiveLangMode(config, meta));
    const resolvedFileIdx = getResolvedFileIdx(item);
    const resolvedSizeBytes = getObservedSizeBytes(sizeBytes, item?._size, item?.sizeBytes, item?.size, item?.file_size, item?.rd_file_size, item?.tb_file_size);
    const streamSources = normalizeTorrentioSources(item);
    const qualityCompatibleBingeGroup = buildQualityCompatibleBingeGroup({ service: serviceLabel, quality, details, infoHash: item?.hash, releaseGroup: item?.releaseGroup || item?.group, language: displayLanguage, fileIdx: resolvedFileIdx });
    const rankExplainText = item?._leviathanExplainText || item?._leviathanExplain?.text || (Array.isArray(item?._leviathanScoreExplain) ? item._leviathanScoreExplain.join(' | ') : undefined);
    const rankScore = Number.isFinite(Number(item?._leviathanScore))
        ? Number(item._leviathanScore)
        : (Number.isFinite(Number(item?._score)) ? Number(item._score) : undefined);

    if (isAIOActive) {
        return {
            name: aioFormatter.formatStreamName({ addonName: "Leviathan", service: getServiceDisplayName(normalizedService), cached: availabilityState === 'cached', cacheState: availabilityState, quality, savedCloud: isSavedCloudStream }),
            title: aioFormatter.formatStreamTitle({
                title: displayTitle,
                size: Number(sizeBytes) > 0 ? formatBytes(sizeBytes) : 'Unknown',
                language: displayLanguage,
                source: formatterSource,
                seeders,
                infoHash: item?.hash,
                techInfo: `🎞️ ${quality} ${details.tags}`.trim(),
                providerLine: undefined,
                sourceIcon: '🔎'
            }),
            url: streamUrl,
            infoHash: item?.hash,
            fileIdx: resolvedFileIdx,
            folderSize: getObservedFolderSizeBytes(item) || undefined,
            sizeBytes: resolvedSizeBytes || undefined,
            seeders: Number(seeders || item?.seeders || 0) || 0,
            sources: streamSources.length ? streamSources : undefined,
            behaviorHints: {
                notWebReady: false,
                bingeGroup: qualityCompatibleBingeGroup,
                bingieGroup: qualityCompatibleBingeGroup,
                infoHash: item?.hash,
                fileIdx: resolvedFileIdx,
                folderSize: getObservedFolderSizeBytes(item) || undefined,
                seeders: Number(seeders || item?.seeders || 0) || 0,
                sizeBytes: resolvedSizeBytes || undefined,
                fileSize: resolvedSizeBytes || undefined,
                torrentioFileLevel: Boolean(resolvedFileIdx !== null || item?.filename || item?.episodeFileHint?.fileName || item?._episodeFileHint?.fileName),
                filename: item?.episodeFileHint?.fileName || item?._episodeFileHint?.fileName || item?.filename || undefined,
                cacheState: availabilityState,
                rdCacheState: availabilityState,
                rankExplain: rankExplainText,
                rankScore,
                torrentioLooseItForceKeep: Boolean(item?._torrentioLooseItForceKeep),
                torrentioExactGuard: Boolean(item?._torrentioExactGuard)
            },
            cacheState: availabilityState,
            rdCacheState: availabilityState,
            _torrentioLooseItForceKeep: Boolean(item?._torrentioLooseItForceKeep),
            _torrentioExactGuard: Boolean(item?._torrentioExactGuard)
        };
    }

    const hasSeriesContext = Boolean(meta?.isSeries || Number(meta?.season || 0) > 0 || Number(meta?.episode || 0) > 0);
    const selectorConfig = {
        ...config,
        season: hasSeriesContext ? Number(meta?.season || 0) : 0,
        episode: hasSeriesContext ? Number(meta?.episode || 0) : 0,
        mediaType: hasSeriesContext ? 'series' : 'movie',
        type: hasSeriesContext ? 'series' : 'movie',
        isSeries: hasSeriesContext,
        title: meta?.title || meta?.name || '',
        originalTitle: meta?.originalTitle || meta?.originalName || '',
        forceMovie: !hasSeriesContext,
        savedCloud: isSavedCloudStream,
        isSavedCloud: isSavedCloudStream,
        savedCloudService: serviceLabel
    };
    const safeIsPack = Boolean(hasSeriesContext && isPack);
    const { name, title, bingeGroup } = formatStreamSelector(baseParseTitle, formatterSource, sizeBytes, seeders, serviceLabel, selectorConfig, item?.hash, isLazy, safeIsPack, availabilityState);
    return {
        name,
        title,
        url: streamUrl,
        infoHash: item?.hash,
        fileIdx: resolvedFileIdx,
        folderSize: getObservedFolderSizeBytes(item) || undefined,
        sizeBytes: resolvedSizeBytes || undefined,
        seeders: Number(seeders || item?.seeders || 0) || 0,
        sources: streamSources.length ? streamSources : undefined,
        behaviorHints: {
            notWebReady: false,
            bingeGroup,
            bingieGroup: bingeGroup,
            infoHash: item?.hash,
            fileIdx: resolvedFileIdx,
            folderSize: getObservedFolderSizeBytes(item) || undefined,
            sources: streamSources.length ? streamSources : undefined,
            seeders: Number(seeders || item?.seeders || 0) || 0,
            sizeBytes: resolvedSizeBytes || undefined,
            fileSize: resolvedSizeBytes || undefined,
            torrentioFileLevel: Boolean(resolvedFileIdx !== null || item?.filename || item?.episodeFileHint?.fileName || item?._episodeFileHint?.fileName),
            filename: item?.episodeFileHint?.fileName || item?._episodeFileHint?.fileName || item?.filename || undefined,
            cacheState: availabilityState,
            rdCacheState: availabilityState,
            rankExplain: rankExplainText,
            rankScore,
            torrentioLooseItForceKeep: Boolean(item?._torrentioLooseItForceKeep),
            torrentioExactGuard: Boolean(item?._torrentioExactGuard)
        },
        cacheState: availabilityState,
        rdCacheState: availabilityState,
        _torrentioLooseItForceKeep: Boolean(item?._torrentioLooseItForceKeep),
        _torrentioExactGuard: Boolean(item?._torrentioExactGuard)
    };
}

function getLanguageSignals(title, metaTitle, sourceName) {
    return getTitleDiagnostics(title, metaTitle, sourceName);
}

function keepItalianCandidate(title, sourceName, metaTitle) {
    return shouldKeepStrictItalianCandidate(title, sourceName);
}

function keepEnglishCandidate(title, sourceName, metaTitle) {
    const signals = getLanguageSignals(title, metaTitle, sourceName);
    const rawTitle = String(title || '');
    const normalizedTitle = normalizeSearchText(rawTitle);
    const normalizedMeta = normalizeSearchText(metaTitle || '');
    const titleYearMatch = rawTitle.match(REGEX_YEAR);
    const metaYearMatch = String(metaTitle || '').match(REGEX_YEAR);
    const yearMatches = !metaYearMatch || !titleYearMatch || titleYearMatch[0] === metaYearMatch[0];

    if (signals.explicitEng) return true;
    if (signals.explicitOther && !signals.explicitEng) return false;
    if (REGEX_SUB_ONLY.test(rawTitle) && !signals.explicitEng) return false;
    if (signals.explicitIta && !signals.explicitEng) return false;
    if (signals.explicitMulti && !signals.explicitEng) return false;

    if (signals.neutralScene && yearMatches) return true;
    if (normalizedMeta && normalizedTitle.includes(normalizedMeta) && yearMatches) return true;

    return !signals.explicitOther && !signals.explicitIta && !signals.explicitMulti && yearMatches;
}

function keepAllCandidate(title, sourceName, metaTitle) {
    const signals = getLanguageSignals(title, metaTitle, sourceName);
    const rawTitle = String(title || '');
    if (keepItalianCandidate(rawTitle, sourceName, metaTitle)) return true;
    if (signals.explicitMulti) return true;
    if (keepEnglishCandidate(rawTitle, sourceName, metaTitle)) return true;
    if (signals.explicitOther && !signals.explicitEng) return false;
    return !REGEX_SUB_ONLY.test(rawTitle);
}

function getSourceConsensusRankBonus(item = {}) {
    const direct = String(item?._rankMeta?.sourceConsensus || '').toLowerCase();
    if (direct === 'strong_consensus') return 9000;
    if (direct === 'consensus') return 5500;
    if (direct === 'mirror') return 2500;

    const sources = new Set();
    const push = (value) => {
        const normalized = String(value || '').trim().toLowerCase();
        if (!normalized || /^(unknown|n\/a|null|undefined)$/.test(normalized)) return;
        sources.add(normalized);
    };
    push(item.source);
    push(item.provider);
    push(item.externalAddon);
    for (const source of Array.isArray(item._dedupeMergedSources) ? item._dedupeMergedSources : []) push(source);
    for (const source of Array.isArray(item._dedupeEvidence?.sources) ? item._dedupeEvidence.sources : []) push(source);

    const mergedCount = Number(item?._dedupeMergedCount || item?._dedupeEvidence?.mergedCount || 0) || 0;
    if (sources.size >= 3 || mergedCount >= 4) return 9000;
    if (sources.size >= 2 || mergedCount >= 3) return 5500;
    if (mergedCount >= 2) return 2500;
    return 0;
}

function getCompositeRankScore(item, meta, config) {
    const title = String(item?.title || '');
    const source = item?.source || item?.provider || null;
    const diagnostics = getTitleDiagnostics(title, meta?.title, source);
    const langInfo = diagnostics.langInfo;
    const sizeBytes = Number(item?._size || item?.sizeBytes || 0);
    const seeders = parseInt(item?.seeders, 10) || 0;
    const explicitFileIdx = item?.fileIdx !== undefined && item?.fileIdx !== null;
    const isPack = isConfidentSeasonPackItem(item, meta, '');
    const epData = meta?.isSeries ? extractSeasonEpisodeFromFilename(title, meta?.season || 1, getEpisodeParseOptions(meta)) : null;

    const langMode = getEffectiveLangMode(config, meta);
    let score = 0;

    if (langMode === 'eng') {
        if (diagnostics.explicitEng) score += 190000;
        else if (keepEnglishCandidate(title, source, meta?.title)) score += 90000;
        if (diagnostics.explicitIta && !diagnostics.explicitEng) score -= 220000;
        else if (diagnostics.explicitIta && diagnostics.explicitEng) score -= 12000;
        if (diagnostics.explicitMulti && !diagnostics.explicitEng) score -= 70000;
        else if (diagnostics.explicitMulti && diagnostics.explicitEng) score += 16000;
        if (diagnostics.explicitOther && !diagnostics.explicitEng) score -= 120000;
    } else if (langMode === 'all') {
        if (diagnostics.explicitIta || langInfo.isItalian) score += 180000;
        else if (diagnostics.explicitEng) score += 150000;
        else if (diagnostics.explicitMulti) score += 120000;
        else if (keepAllCandidate(title, source, meta?.title)) score += 70000;
        if (diagnostics.explicitOther && !diagnostics.explicitEng && !diagnostics.explicitIta && !diagnostics.explicitMulti) score -= 90000;
    } else {
        if (langInfo.isItalian) score += 200000;
        else if (langInfo.isMaybeItalian) score += 70000;
        if (langInfo.isMulti) score += 12000;
    }

    if (REGEX_AUDIO_CONFIRM.test(title)) score += 22000;
    if (/\b(web[-.\s]?dl|blu[-.\s]?ray|remux|uhd|hevc|x265|x264|ddp|truehd|dts)\b/i.test(title)) score += 14000;
    if (/\b(4k|2160p|uhd)\b/i.test(title)) score += 9000;
    else if (/\b(1080p|fhd|full[-.\s]?hd)\b/i.test(title)) score += 7000;
    else if (/\b(720p|hd[-.\s]?rip|hdtv|hd)\b/i.test(title)) score += 4000;
    if (/\b(cam|hdcam|ts|telesync|screener|scr)\b/i.test(title)) score -= 30000;
    if (langInfo.isSubOnly) score -= 25000;
    if (explicitFileIdx) score += 7000;
    if (source && /mircrew|corsaro|lux|wms|dn[a4]?|idn_crew|speedvideo/i.test(String(source))) score += 6000;
    if (title && /mircrew|corsaro|lux|wms|dn[a4]?|idn_crew|speedvideo/i.test(title)) score += 5000;
    score += getSourceConsensusRankBonus(item);
    if (meta?.isSeries) {
        if (epData && epData.episode === meta.episode && (epData.season === meta.season || meta?.kitsu_id)) score += 24000;
        else if (isPack && new RegExp(`(?:s|season|stagione)\\s*0?${meta.season}(?!\\d)`, 'i').test(title)) score += 9000;
        else if (epData && epData.episode !== meta.episode) score -= 18000;
    }
    if (!meta?.isSeries && /\b(?:S\d{2}|SEASON|STAGIONE|\d+x\d+)\b/i.test(title)) score -= 18000;
    if (item?._packValidated) score += 15000;
    score += Math.min(seeders, 500) * 18;
    score += Math.min(Math.floor(sizeBytes / (700 * 1024 * 1024)), 1200);
    score += Math.min(title.length, 300);
    if (meta?.isSeries && item?._preferTorrentioSeries === true) score += 250000;
    if (String(config?.service || '').toLowerCase() === 'tb' && item?._tbCached) score += 15000;
    return score;
}

function rerankCompositeResults(results, meta, config, sortMode) {
    const ranked = Array.isArray(results) ? [...results] : [];
    sortMode = getConfiguredSortMode(config);
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

async function guardedProviderCall(providerName, limiter, timeoutMs, factory, meta = {}) {
    const startedAt = Date.now();
    const circuit = getProviderCircuitState(providerName);
    if (circuit.status === 'open') {
        recordDuration(`provider.${providerName}`, 0);
        recordProviderMetric(providerName, false, 0, { breaker: 'open', retryInMs: circuit.retryInMs });
        logger.warn(`[${providerName}] skipped by source health gate for ${circuit.retryInMs}ms`);
        return [];
    }

    try {
        const safeLimiter = limiter && typeof limiter.schedule === 'function'
            ? limiter
            : { schedule: (task) => Promise.resolve().then(task) };
        if (!limiter || typeof limiter.schedule !== 'function') {
            logger.warn(`[${providerName}] limiter missing, using inline fallback`);
        }
        const result = await safeLimiter.schedule(() => withTimeout(Promise.resolve().then(factory), timeoutMs, providerName));
        const duration = Date.now() - startedAt;
        const normalized = Array.isArray(result) ? result : (result ? [result] : []);
        const exactHit = meta?.meta?.isSeries
            ? normalized.some((item) => {
                const parsed = extractSeasonEpisodeFromFilename(String(item?.title || ''), meta?.meta?.season || 1, getEpisodeParseOptions(meta?.meta));
                return parsed && parsed.episode === meta?.meta?.episode && (parsed.season === meta?.meta?.season || meta?.meta?.kitsu_id);
            })
            : normalized.length > 0;
        const packHit = meta?.meta?.isSeries
            ? normalized.some((item) => Boolean(item?._isPack || isSeasonPack(item?.title || '')))
            : false;

        recordProviderSuccess(providerName, { ms: duration, empty: normalized.length === 0, exactHit, packHit });
        recordDuration(`provider.${providerName}`, duration);
        recordProviderMetric(providerName, true, duration, { breaker: circuit.status, results: normalized.length });
        return normalized;
    } catch (err) {
        const duration = Date.now() - startedAt;
        const isTimeout = /timeout/i.test(String(err?.message || ''));
        const state = recordProviderFailure(providerName, { ms: duration, timeout: isTimeout, error: err?.message || err });
        recordDuration(`provider.${providerName}`, duration);
        recordProviderMetric(providerName, false, duration, {
            timeout: isTimeout,
            error: err?.message || err,
            breaker: state.status,
            consecutiveFailures: state.consecutiveFailures,
            score: state.score
        });
        logger.warn(`[${providerName}] failed: ${err.message}${state.status === 'open' ? ' | source disabled temporarily' : ''}`);
        return [];
    }
}

function warmupLazyStreamsInBackground(config, items, meta) {
    const service = getNormalizedDebridService(config);
    const apiKey = getConfiguredDebridKey(config, service);
    if (!apiKey || !Array.isArray(items) || items.length === 0) return;
    const maxWarmups = Math.max(0, Math.min(4, parseInt(config?.filters?.warmupTop ?? process.env.LAZY_WARMUP_TOP ?? '2', 10) || 0));
    if (maxWarmups <= 0) return;
    if (streamInflight.size >= LAZY_WARMUP_LOAD_THRESHOLD) {
        incrementMetric('lazyWarmup.skippedLoad', Math.min(items.length, maxWarmups));
        logger.info(`[LAZY WARMUP] Skip sotto carico | inflight=${streamInflight.size} | threshold=${LAZY_WARMUP_LOAD_THRESHOLD}`);
        return;
    }

    items.slice(0, maxWarmups).forEach(item => {
        LIMITERS.lazyWarmup.schedule(async () => {
            const lazyCacheKey = getLazyCacheKey(service, item, meta);
            const cached = await Cache.getLazyLink(lazyCacheKey);
            if (cached?.url) return;
            const startedAt = Date.now();
            try {
                const streamData = await resolveLazyStreamData(service, apiKey, item, meta);
                if (streamData?.url) {
                    await Cache.cacheLazyLink(lazyCacheKey, streamData, 10800);
                    incrementMetric('lazyWarmup.success');
                }
                recordProviderMetric(`warmup.${service}`, true, Date.now() - startedAt);
            } catch (err) {
                incrementMetric('lazyWarmup.fail');
                recordProviderMetric(`warmup.${service}`, false, Date.now() - startedAt, { timeout: /timeout/i.test(String(err?.message || '')), error: err?.message || err });
            }
        }).catch(err => {
            if (isQueueOverflowError(err)) {
                incrementMetric('lazyWarmup.droppedQueue');
                logger.info(`[LAZY WARMUP] Drop per backlog | service=${service} | hash=${item?.hash || item?.infoHash || 'n/a'}`);
                return;
            }
            logger.warn(`[WARMUP] Queue error: ${err.message}`);
        });
    });
}

function getPackResolverFailureKey(item = {}, config = {}, meta = {}) {
    const service = getNormalizedDebridService(config) || 'unknown';
    const hash = String(item?.hash || item?.infoHash || '').toUpperCase();
    return `${service}:${hash}:${Number(meta?.season || item?.season || 0) || 0}:${Number(meta?.episode || item?.episode || 0) || 0}`;
}

function markPackResolverHttpCooldown(key, status) {
    if (!key) return;
    recentPackResolverHttpFailures.set(key, { until: Date.now() + PACK_RESOLVER_HTTP_COOLDOWN_MS, status });
    cleanupTimedCache(recentPackResolverHttpFailures, TIMED_CACHE_MAX_ENTRIES);
}

function isPackResolverHttpCooldownActive(key) {
    const entry = key ? recentPackResolverHttpFailures.get(key) : null;
    if (!entry) return false;
    if (Date.now() > Number(entry.until || 0)) {
        recentPackResolverHttpFailures.delete(key);
        return false;
    }
    return true;
}

async function resolvePackWithBestEffort(item, config, meta, siblingStreams = []) {
    if (!item || !item.hash) return null;
    const failureKey = getPackResolverFailureKey(item, config, meta);
    if (isPackResolverHttpCooldownActive(failureKey)) {
        incrementMetric('pack.resolverSkippedHttpCooldown');
        return null;
    }
    const cachedResolved = getValidatedFileSet(item, meta);
    if (cachedResolved) {
        logger.info(`[PACK CACHE] Hit per ${item.hash} S${meta?.season || 0}E${meta?.episode || 0}`);
        return cachedResolved;
    }
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
            const payload = { title: bestTitleData.title, titleSource: bestTitleData.source, packName, files, raw: resolved };
            if (files.length > 0 || Number.isInteger(Number(resolved?.fileIndex ?? resolved?.fileIdx))) {
                rememberValidatedFileSet(item, meta, payload);
            }
            return payload;
        } catch (err) {
            const status = Number(err?.response?.status || err?.status || 0) || null;
            if (status === 404) {
                logger.info(`[PACK] Resolver miss for ${item.hash}: ${err.message}`);
            } else if (status === 429 || status === 451) {
                markPackResolverHttpCooldown(failureKey, status);
                logger.warn(`[PACK] Resolver cooldown for ${item.hash}: http_${status} ${Math.round(PACK_RESOLVER_HTTP_COOLDOWN_MS / 1000)}s`);
                break;
            } else {
                logger.warn(`[PACK] Resolver error for ${item.hash}: ${err.message}`);
            }
        }
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
    } catch (err) { logger.warn(`[PACK] updateTorrentTitle failed for ${infoHash}: ${err.message}`); }

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
        const parsedEpisode = extractSeasonEpisodeFromFilename(filename, seasonFallback, getEpisodeParseOptions(meta));

        if (parsedEpisode && Number.isInteger(fileIndex)) {
            episodeFiles.push({ info_hash: infoHash, file_index: fileIndex, title: filename, size: fileSize, imdb_id: meta?.imdb_id || null, imdb_season: parsedEpisode.season, imdb_episode: parsedEpisode.episode });
            packFiles.push({
                info_hash: infoHash,
                file_index: fileIndex,
                file_path: filePath,
                file_title: filename,
                file_size: fileSize,
                imdb_id: meta?.imdb_id || null,
                imdb_season: parsedEpisode.season,
                imdb_episode: parsedEpisode.episode
            });
        } else if (Number.isInteger(fileIndex)) {
            packFiles.push({
                info_hash: infoHash,
                file_index: fileIndex,
                file_path: filePath,
                file_title: filename,
                file_size: fileSize,
                imdb_id: meta?.imdb_id || null,
                title: resolved.title || item.title
            });
        }
    }

    try { if (episodeFiles.length > 0 && typeof dbHelper.insertEpisodeFiles === 'function') await dbHelper.insertEpisodeFiles(episodeFiles); }
    catch (err) { logger.warn(`[PACK] insertEpisodeFiles failed for ${infoHash}: ${err.message}`); }
    try { if (packFiles.length > 0 && typeof dbHelper.insertPackFiles === 'function') await dbHelper.insertPackFiles(packFiles); }
    catch (err) { logger.warn(`[PACK] insertPackFiles failed for ${infoHash}: ${err.message}`); }
    rememberValidatedFileSet(item, meta, resolved);
}

function resolvePackNamesInBackground(meta, results, config, type = null) {
    if (!meta || !meta.isSeries || !config || !Array.isArray(results) || results.length === 0) return;
    const effectiveType = String(type || meta?.type || meta?.contentType || (meta?.isSeries || meta?.season || meta?.episode ? 'series' : 'movie')).toLowerCase();
    const hasResolvableService = !!((config.service === 'rd' && (config.key || config.rd)) || (config.service === 'tb' && (config.key || config.rd || config.torbox || config.tb)));
    if (!hasResolvableService) return;
    const packCandidates = results.filter(item => item && isConfidentSeasonPackItem(item, meta, effectiveType));
    if (packCandidates.length === 0) return;

    LIMITERS.bgPackJobs.schedule(async () => {
        for (const item of packCandidates) {
            const packKey = `${String(item?.hash || item?.infoHash || '').toLowerCase()}:${Number(meta?.season || 0)}:${Number(meta?.episode || 0)}`;
            if (!packKey || shouldSkipRecentWork(recentPackResolutionJobs, packKey, BACKGROUND_DB_SAVE_DEDUP_MS * 2)) continue;
            try {
                await scheduleKeyed(
                    'pack-resolution',
                    packKey,
                    async () => {
                        const resolved = await resolvePackWithBestEffort(item, config, meta, results);
                        if (resolved) await persistPackResolution(meta, item, resolved);
                    },
                    { maxGroupPending: PACK_RESOLUTION_QUEUE_MAX }
                );
            } catch (err) {
                if (isQueueOverflowError(err)) {
                    incrementMetric('pack.backgroundDropped');
                    logger.info(`[PACK] Background drop per backlog | hash=${item?.hash || item?.infoHash || 'n/a'}`);
                    continue;
                }
                logger.warn(`[PACK] Background processing failed for ${item.hash || item.infoHash}: ${err.message}`);
            }
        }
    }).catch(err => {
        if (isQueueOverflowError(err)) {
            incrementMetric('pack.backgroundDropped');
            logger.info(`[PACK] Background queue drop | candidates=${packCandidates.length}`);
            return;
        }
        logger.warn(`[PACK] Background queue failed: ${err.message}`);
    });
}

async function fetchTmdbMeta(tmdbId, type, userApiKey) {
    if (!tmdbId) return null;
    const endpoint = type === 'series' || type === 'tv' ? 'tv' : 'movie';
    try {
        return await tmdbHelper.fetchTmdbJson(`/${endpoint}/${tmdbId}`, {
            params: { language: 'it-IT' },
            userKey: userApiKey,
            timeoutMs: CONFIG.TIMEOUTS.TMDB
        });
    } catch (e) {
        logger.warn(`TMDB Meta Fetch Error for ${tmdbId}: ${e.message}`);
        return null;
    }
}

async function fetchTmdbEpisodeMeta(tmdbId, season, episode, userApiKey) {
    if (!tmdbId || !(season > 0) || !(episode > 0)) return null;
    try {
        return await tmdbHelper.fetchTmdbJson(`/tv/${tmdbId}/season/${season}/episode/${episode}`, {
            params: { language: 'it-IT' },
            userKey: userApiKey,
            timeoutMs: CONFIG.TIMEOUTS.TMDB
        });
    } catch (e) {
        logger.warn(`TMDB Episode Meta Fetch Error for ${tmdbId} S${season}E${episode}: ${e.message}`);
        return null;
    }
}

async function getMetadata(id, type, config = {}) {
  const userTmdbKey = String(config?.tmdb || '');
  const metadataCacheKey = `${type}:${id}:${userTmdbKey}`;
  const cachedMeta = await Cache.getMetadata(metadataCacheKey);
  if (cachedMeta) { logger.info(`[META CACHE HIT] ${metadataCacheKey}`); return cachedMeta; }

  return withSharedPromise(metadataInflight, metadataCacheKey, async () => {
    const secondCacheHit = await Cache.getMetadata(metadataCacheKey);
    if (secondCacheHit) return secondCacheHit;
    let finalMeta = null;

    try {
      if (type === 'anime' || id.toString().startsWith('kitsu:')) {
          const parsedKitsu = parseKitsuIdentifier(id);
          const kitsuId = parsedKitsu?.kitsuId || String(id || '').trim();
          const season = parsedKitsu?.season || 1;
          const episode = parsedKitsu?.episode || 0;
          const fallbackKitsuMeta = kitsuId ? await kitsuHandler(kitsuId).catch(() => null) : null;
          const mappedKitsu = mapKitsuEpisodePosition(parsedKitsu, fallbackKitsuMeta);

          if (kitsuId) {
              const kitsuUrl = `${CONFIG.KITSU_URL}/meta/anime/kitsu:${kitsuId}.json`;
              logger.info(`⛩️ [META] Fetching Kitsu (Direct): ${kitsuUrl}`);
              try {
                  const { data } = await axios.get(kitsuUrl, { timeout: CONFIG.TIMEOUTS.TMDB });
                  if (data && data.meta) {
                      const kMeta = data.meta;
                      const titles = uniqueTextList([
                          kMeta.name,
                          kMeta.originalName,
                          ...(Array.isArray(kMeta.alternativeTitles) ? kMeta.alternativeTitles : []),
                          ...(Array.isArray(fallbackKitsuMeta?.titles) ? fallbackKitsuMeta.titles : []),
                          ...(Array.isArray(fallbackKitsuMeta?.aliases) ? fallbackKitsuMeta.aliases : [])
                      ]);
                      const subtype = String(kMeta.type || fallbackKitsuMeta?.subtype || fallbackKitsuMeta?.type || '').toLowerCase();
                      const isSeries = fallbackKitsuMeta?.type
                          ? fallbackKitsuMeta.type === 'series'
                          : !/\b(movie|film)\b/i.test(subtype);
                      const year = String(kMeta.year || kMeta.releaseInfo || fallbackKitsuMeta?.year || '').match(/\b(19|20)\d{2}\b/)?.[0] || '';
                      const primaryTitle = titles[0] || kMeta.name || kMeta.originalName || `Kitsu ${kitsuId}`;
                      const originalTitle = kMeta.originalName || titles[1] || primaryTitle;
                      const aliases = uniqueTextList([
                          ...titles.slice(1),
                          ...(Array.isArray(fallbackKitsuMeta?.aliases) ? fallbackKitsuMeta.aliases : [])
                      ]);

                      finalMeta = {
                          title: primaryTitle,
                          originalTitle,
                          year,
                          imdb_id: kMeta.imdb_id || fallbackKitsuMeta?.imdbID || null,
                          kitsu_id: kitsuId,
                          isSeries,
                          season: isSeries ? mappedKitsu.mappedSeason : 0,
                          episode: isSeries ? mappedKitsu.mappedEpisode : 0,
                          requested_kitsu_episode: isSeries ? mappedKitsu.requestedEpisode : 0,
                          releaseInfo: kMeta.releaseInfo || null,
                          aka_titles: aliases,
                          aliases,
                          titles,
                          isAnime: true,
                          subtype: kMeta.type || fallbackKitsuMeta?.subtype || '',
                          episodeCount: fallbackKitsuMeta?.episodeCount || null
                      };
                  }
              } catch (e) { logger.warn(`[META] Errore Kitsu: ${e.message} - fallback tentato`); }
          }

          if (!finalMeta && fallbackKitsuMeta) {
              const titles = uniqueTextList(fallbackKitsuMeta.titles || fallbackKitsuMeta.aliases || []);
              const primaryTitle = titles[0] || `Kitsu ${kitsuId}`;
              const aliases = uniqueTextList([
                  ...titles.slice(1),
                  ...(Array.isArray(fallbackKitsuMeta.aliases) ? fallbackKitsuMeta.aliases : [])
              ]);
              finalMeta = {
                  title: primaryTitle,
                  originalTitle: titles[1] || primaryTitle,
                  year: fallbackKitsuMeta.year || '',
                  imdb_id: fallbackKitsuMeta.imdbID || null,
                  kitsu_id: kitsuId,
                  isSeries: fallbackKitsuMeta.type !== 'movie',
                  season: fallbackKitsuMeta.type !== 'movie' ? mappedKitsu.mappedSeason : 0,
                  episode: fallbackKitsuMeta.type !== 'movie' ? mappedKitsu.mappedEpisode : 0,
                  requested_kitsu_episode: fallbackKitsuMeta.type !== 'movie' ? mappedKitsu.requestedEpisode : 0,
                  aka_titles: aliases,
                  aliases,
                  titles,
                  isAnime: true,
                  subtype: fallbackKitsuMeta.subtype || '',
                  episodeCount: fallbackKitsuMeta.episodeCount || null
              };
          }
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
                    const isAnime = isAnimeTmdbMetadata(tmdbData, cleanType);
                    const episodeData = cleanType === "series" && season > 0 && episode > 0
                        ? await fetchTmdbEpisodeMeta(tmdbId, season, episode, userTmdbKey)
                        : null;
                    const seasonInfo = Array.isArray(tmdbData.seasons)
                        ? tmdbData.seasons.find((entry) => Number(entry?.season_number) === Number(season))
                        : null;
                    finalMeta = {
                        title: tmdbData.title || tmdbData.name,
                        originalTitle: tmdbData.original_title || tmdbData.original_name,
                        year: (tmdbData.release_date || tmdbData.first_air_date) ? (tmdbData.release_date || tmdbData.first_air_date).split("-")[0] : "",
                        imdb_id: cleanId,
                        tmdb_id: tmdbId,
                        isSeries: cleanType === "series",
                        isAnime,
                        season: season,
                        episode: episode,
                        releaseDate: tmdbData.release_date || null,
                        firstAirDate: tmdbData.first_air_date || null,
                        episodeAirDate: episodeData?.air_date || null,
                        releaseInfo: tmdbData.release_date || tmdbData.first_air_date || null,
                        originalLanguage: tmdbData.original_language || null,
                        seasonEpisodeCount: Number(seasonInfo?.episode_count || 0) || null,
                        episodesInSeason: Number(seasonInfo?.episode_count || 0) || null,
                        numberOfEpisodes: Number(tmdbData.number_of_episodes || 0) || null,
                        numberOfSeasons: Number(tmdbData.number_of_seasons || 0) || null
                    };
                    logger.info(`[META] Usato TMDB (UserKey: ${!!userTmdbKey}): ${finalMeta.title} (${finalMeta.year}) [ID: ${tmdbId}] Orig: ${finalMeta.originalTitle}`);
                }
            }
        } catch (err) { logger.warn(`[META] Errore TMDB, fallback a Cinemeta: ${err.message}`); }

        if (!finalMeta) {
          logger.info(`[META] Fallback a Cinemeta per ${cleanId}`);
          const { data: cData } = await axios.get(`${CONFIG.CINEMETA_URL}/meta/${cleanType}/${cleanId}.json`, { timeout: CONFIG.TIMEOUTS.TMDB }).catch(() => ({ data: {} }));
          finalMeta = cData?.meta ? {
            title: cData.meta.name,
            originalTitle: cData.meta.name,
            year: String(cData.meta.year || "").split(/[–-]/)[0],
            imdb_id: cleanId,
            isSeries: cleanType === "series",
            season: season,
            episode: episode,
            releaseInfo: cData.meta.releaseInfo || null
          } : null;
        }
      }
    } catch (err) { logger.error(`Errore getMetadata Critical: ${err.message}`); finalMeta = null; }

    if (finalMeta) await Cache.cacheMetadata(metadataCacheKey, finalMeta, METADATA_CACHE_TTL);
    return finalMeta;
  }, boundedSharedPromiseOptions(METADATA_INFLIGHT_MAX_ENTRIES, 'metadata.inflight.evicted'));
}

function saveResultsToDbBackground(meta, results, config = null, type = null, options = {}) {
    const effectiveType = String(type || meta?.type || meta?.contentType || (meta?.isSeries || meta?.season || meta?.episode ? 'series' : 'movie')).toLowerCase();
    if (!results || results.length === 0) return;
    const metaCacheKey = getMetaDbLookupKey(meta);
    const resultsSignature = buildResultsSignature(results);
    const saveKey = `${metaCacheKey || meta?.imdb_id || 'n/a'}:${resultsSignature || 'empty'}`;
    if (shouldSkipRecentWork(recentBackgroundDbSaves, saveKey, BACKGROUND_DB_SAVE_DEDUP_MS)) {
        incrementMetric('dbSave.skippedRecent');
        return;
    }

    const queueKey = metaCacheKey || meta?.imdb_id || resultsSignature || 'background';

    scheduleKeyed(
        'db-save',
        queueKey,
        async () => {
            return withSharedPromise(backgroundDbSaveInflight, `db_save:${saveKey}`, async () => {
                let savedCount = 0;
                let mappedCount = 0;
                let processedCount = 0;
                const prioritizedHashes = [];
                const prioritizedSet = new Set();
                const guaranteedCachedUpdates = [];
                const guaranteedSet = new Set();
                const torrentRows = [];
                const externalSnapshotRows = [];
                const ledgerPackFiles = [];

                for (const item of results) {
                    const infoHash = item.hash || item.infoHash;
                    if (!infoHash) continue;

                    const torrentObj = {
                        info_hash: infoHash,
                        title: item.title,
                        size: item._size || item.sizeBytes || item.fileSize || item.file_size || 0,
                        seeders: item.seeders || 0,
                        provider: item.source || 'External',
                        torrent_id: item.torrentId || item.torrent_id || item.id || undefined,
                        type: meta?.isAnime ? 'anime' : effectiveType,
                        upload_date: item.uploadDate || item.upload_date || item.publishedAt || item.published_at || item.date || undefined,
                        trackers: item.trackers || item.sources || undefined,
                        languages: item.languages || item.language || item.langs || item._languages || undefined,
                        resolution: item.resolution || item.quality || item.qualityResolution || undefined,
                        quality: item.quality || item.sourceQuality || item.quality_tag || undefined,
                        codec: item.codec || item.codec_tag || item.videoCodec || item.encode || undefined,
                        hdr: item.hdr || item.hdr_tag || item.visualTag || item.visualTags || undefined,
                        audio: item.audio || item.audio_tag || item.audioTag || item.audioTags || undefined,
                        releaseGroup: item.releaseGroup || item.release_group || item.group || item.uploader || undefined,
                        filename: item.filename || item.fileName || item.file_name || item.file_title || item.behaviorHints?.filename || item._episodeFileHint?.fileName || item.episodeFileHint?.fileName || undefined,
                        fileName: item.fileName || item.filename || item.file_name || item.file_title || undefined,
                        folderSize: item.folderSize || item.folder_size || item.totalPackSize || item.packSize || item.behaviorHints?.folderSize || undefined,
                        behaviorHints: item.behaviorHints || undefined,
                        episodeFileHint: item.episodeFileHint || item._episodeFileHint || undefined,
                        season: meta?.season || item.season || item.imdb_season || undefined,
                        episode: meta?.episode || item.episode || item.imdb_episode || undefined,
                        isSeries: Boolean(meta?.isSeries),
                        file_index: item.fileIdx !== undefined ? item.fileIdx : (item.fileIndex !== undefined ? item.fileIndex : item.file_index),
                        is_pack: Boolean(meta?.isSeries && isConfidentSeasonPackItem(item, meta, effectiveType))
                    };

                    torrentRows.push(torrentObj);
                    if (item?.isExternal === true || item?.externalAddon || item?.externalGroup || item?._externalSnapshot === true || item?._sourceGroup === 'external') {
                        externalSnapshotRows.push(item);
                    }

                    const learnedFileIdx = getResolvedFileIdx(item);
                    if (meta?.isSeries && learnedFileIdx !== null) {
                        const learnedHint = item.episodeFileHint || item._episodeFileHint || {};
                        ledgerPackFiles.push({
                            info_hash: infoHash,
                            file_index: learnedFileIdx,
                            file_path: learnedHint.filePath || learnedHint.path || item.filename || item.file_title || item.title,
                            file_title: learnedHint.fileName || learnedHint.fileTitle || item.filename || item.file_title || item.title,
                            file_size: getObservedSizeBytes(learnedHint.fileSize, learnedHint.size, item._size, item.sizeBytes, item.fileSize, item.file_size),
                            imdb_id: meta?.imdb_id || null,
                            imdb_season: meta?.season || item.season || item.imdb_season || null,
                            imdb_episode: meta?.episode || item.episode || item.imdb_episode || null
                        });
                    }

                    if (isGuaranteedCachedExternal(item)) {
                        if (!guaranteedSet.has(infoHash)) {
                            guaranteedSet.add(infoHash);
                            guaranteedCachedUpdates.push({
                                hash: infoHash,
                                state: 'cached',
                                cached: true,
                                rd_file_index: getResolvedFileIdx(item),
                                rd_file_size: Number(item?._size || item?.sizeBytes || 0) > 0 ? Number(item._size || item.sizeBytes) : null,
                                failures: 0,
                                next_hours: 168,
                                permanent: false,
                                imdb_id: meta?.imdb_id || null,
                                imdb_season: meta?.season || null,
                                imdb_episode: meta?.episode || null
                            });
                        }
                        continue;
                    }

                    if (
                        String(config?.service || 'rd').toLowerCase() === 'rd' &&
                        prioritizedHashes.length < 18 &&
                        getRdAvailabilityState('rd', item, meta) === 'unknown' &&
                        !prioritizedSet.has(infoHash)
                    ) {
                        prioritizedSet.add(infoHash);
                        prioritizedHashes.push(infoHash);
                    }
                }

                if (torrentRows.length > 0) {
                    if (typeof dbHelper.insertTorrentsBatch === 'function' && meta?.imdb_id) {
                        const outcome = await dbHelper.insertTorrentsBatch(meta, torrentRows);
                        savedCount = Number(outcome?.inserted || 0);
                        mappedCount = Number(outcome?.mapped || 0);
                        processedCount = Number(outcome?.processed || 0);
                    } else {
                        for (const torrentObj of torrentRows) {
                            const success = await dbHelper.insertTorrent(meta, torrentObj);
                            if (success) savedCount += 1;
                        }
                        processedCount = torrentRows.length;
                    }
                }

                if (externalSnapshotRows.length > 0 && typeof dbHelper.upsertExternalStreamSnapshots === 'function') {
                    const snapshotOutcome = await dbHelper.upsertExternalStreamSnapshots(meta, externalSnapshotRows, {
                        type: effectiveType,
                        ttlSeconds: config?.filters?.externalSnapshotTtl || process.env.EXTERNAL_SNAPSHOT_TTL || undefined
                    });
                    if (Number(snapshotOutcome?.processed || 0) > 0) {
                        logger.info(`[EXTERNAL SNAPSHOT] processed=${snapshotOutcome.processed} upserted=${snapshotOutcome.upserted || 0} imdb=${meta?.imdb_id || 'n/a'}`);
                    }
                }

                if (ledgerPackFiles.length > 0 && typeof dbHelper.insertPackFiles === 'function') {
                    const ledgerOutcome = await dbHelper.insertPackFiles(ledgerPackFiles);
                    if (Number(ledgerOutcome?.processed || 0) > 0) {
                        logger.info(`[TORRENT LEDGER] pack/file hints processed=${ledgerOutcome.processed} inserted=${ledgerOutcome.inserted || 0} imdb=${meta?.imdb_id || 'n/a'}`);
                    }
                }

                if (savedCount > 0 || mappedCount > 0) {
                    logger.info(`[AUTO-LEARN] Salvati ${savedCount} nuovi torrent, ${mappedCount} mapping nel DB per ${meta?.imdb_id || 'n/a'}`);
                }

                if (guaranteedCachedUpdates.length > 0 && typeof dbHelper.updateRdCacheStatus === 'function') {
                    await dbHelper.updateRdCacheStatus(guaranteedCachedUpdates);
                    await Cache.invalidateStreamsByHashes(guaranteedCachedUpdates.map((entry) => entry.hash), 'external_cached_seed');
                    logger.info(`[RD AVAILABILITY] Marked guaranteed external results as cached | imdb=${meta?.imdb_id || 'n/a'} | hashes=${guaranteedCachedUpdates.length}`);
                }

                if (prioritizedHashes.length > 0 && typeof dbHelper.prioritizeRdHashes === 'function') {
                    const outcome = await dbHelper.prioritizeRdHashes(prioritizedHashes, {
                        limit: 18,
                        priorityMinutes: 5
                    });
                    logger.info(`[RD PRIORITY] reason=db_save | imdb=${meta?.imdb_id || 'n/a'} | hashes=${prioritizedHashes.length} | updated=${outcome?.updated || 0}`);
                }

                const dbLookupChanged = savedCount > 0 || mappedCount > 0 || processedCount > 0 || guaranteedCachedUpdates.length > 0;
                if (metaCacheKey && dbLookupChanged) await Cache.invalidateDbTorrents(metaCacheKey, 'db_save');

                const streamRefreshNeeded = savedCount > 0
                    || mappedCount > 0
                    || guaranteedCachedUpdates.length > 0
                    || (options?.invalidateStreamCache === true && processedCount > 0);
                if (streamRefreshNeeded) await invalidateStreamCacheForDbSave(meta, 'db_save');
                resolvePackNamesInBackground(meta, results, config, effectiveType);
            }, boundedSharedPromiseOptions(BACKGROUND_DB_SAVE_INFLIGHT_MAX_ENTRIES, 'dbSave.inflight.evicted'));
        },
        { maxGroupPending: BACKGROUND_DB_SAVE_QUEUE_MAX }
    ).catch(err => {
        if (isQueueOverflowError(err)) {
            incrementMetric('dbSave.droppedQueue');
            logger.info(`[AUTO-LEARN] Background save drop per backlog | imdb=${meta?.imdb_id || 'n/a'}`);
            return;
        }
        console.error('[AUTO-LEARN] Errore background save:', err.message);
    });
}

function collectExistingTorrentHashes(items = [], streams = []) {
    const hashes = new Set();
    const add = (value) => {
        const text = String(value || '').trim().toLowerCase();
        if (text) hashes.add(text);
    };
    for (const item of Array.isArray(items) ? items : []) {
        add(item?.hash);
        add(item?.infoHash);
        add(extractInfoHash(item?.magnet));
        add(extractInfoHash(item?.url));
        add(extractInfoHash(item?.directUrl));
    }
    for (const stream of Array.isArray(streams) ? streams : []) {
        add(stream?.infoHash);
        add(extractInfoHash(stream?.url));
        add(extractInfoHash(stream?.title));
    }
    return hashes;
}

function getStreamPrimaryHash(stream = {}) {
    const candidates = [
        stream?.infoHash,
        extractInfoHash(stream?.url),
        extractInfoHash(stream?.title),
        extractInfoHash(stream?.name)
    ];
    for (const value of candidates) {
        const text = String(value || '').trim().toLowerCase();
        if (text) return text;
    }
    return '';
}

function addSavedCloudBadgeToStream(stream = {}, serviceLabel = 'RD') {
    const currentName = String(stream?.name || '');
    const currentTitle = String(stream?.title || '');

    let nextName = currentName
        .replace(/☁️\s*CLOUD\s*SALVATO\s*•?\s*(?:RD|TB)?/gi, '')
        .replace(/CLOUD\s*SALVATO\s*•?\s*(?:RD|TB)?/gi, '')
        .replace(/💾/g, '')
        .replace(/⚡/, '☁️')
        .replace(/☁️\s*☁️/g, '☁️')
        .replace(/\s{2,}/g, ' ')
        .trim();

    if (!/☁️/.test(nextName)) {
        const cleanBase = currentName.replace(/⚡/g, '').replace(/💾/g, '').replace(/\s{2,}/g, ' ').trim();
        nextName = cleanBase ? `☁️ ${cleanBase}` : `☁️ ${serviceLabel} LEVIATHAN`;
    }

    const nextTitle = currentTitle
        .split(/\r?\n/)
        .filter((line) => !/CLOUD\s*SALVATO/i.test(line))
        .join('\n')
        .replace(/💾/g, '')
        .trim();

    return {
        ...stream,
        name: nextName,
        title: nextTitle || currentTitle,
        savedCloudDuplicate: true,
        isSavedCloudDuplicate: true,
        behaviorHints: {
            ...(stream?.behaviorHints || {}),
            savedCloud: true,
            savedCloudDuplicate: true
        }
    };
}

function annotateSavedCloudDuplicateStreams(streams = [], duplicateMarkers = [], service = 'rd') {
    const serviceLabel = String(service || '').toLowerCase() === 'tb' ? 'TB' : 'RD';
    const duplicateHashes = new Set((Array.isArray(duplicateMarkers) ? duplicateMarkers : [])
        .map((item) => String(item?.hash || item?.infoHash || '').trim().toLowerCase())
        .filter(Boolean));
    if (!duplicateHashes.size || !Array.isArray(streams) || streams.length === 0) {
        return { streams, annotated: 0 };
    }

    let annotated = 0;
    const out = streams.map((stream) => {
        const hash = getStreamPrimaryHash(stream);
        if (!hash || !duplicateHashes.has(hash)) return stream;
        annotated += 1;
        return addSavedCloudBadgeToStream(stream, serviceLabel);
    });
    return { streams: out, annotated };
}

function shouldAttachSavedCloud(filters = {}, debridStreams = []) {
    if (filters?.enableSavedCloud !== true) return false;
    const mode = SavedCloud.getMode(filters);
    if (mode === 'off') return false;
    if (mode === 'fallback') {
        const threshold = Math.max(1, Math.min(4, SavedCloud.getLimit(filters)));
        return (Array.isArray(debridStreams) ? debridStreams.length : 0) < threshold;
    }
    return true;
}

function generateSavedCloudStream(item, config, meta, reqHost, userConfStr) {
    const service = String(item?.service || getNormalizedDebridService(config) || '').toLowerCase();
    if (!['rd', 'tb'].includes(service)) return null;
    if (!item?.torrentId || item?.fileId === null || item?.fileId === undefined) return null;
    const runtimeItem = createRuntimeItem({
        ...item,
        _rdCacheState: 'cached',
        rdCacheState: 'cached',
        _dbCachedRd: true,
        cached_rd: true,
        _tbCached: service === 'tb',
        isSavedCloud: true,
        _savedCloud: true
    }, meta);
    const imdbParam = meta?.imdb_id ? `?imdb=${encodeURIComponent(meta.imdb_id)}` : '';
    const streamUrl = `${reqHost}/${userConfStr}/play_saved_cloud/${service}/${encodeURIComponent(item.torrentId)}/${encodeURIComponent(item.fileId)}${imdbParam}`;
    const parseTitle = item.fileTitle || item.filename || item.title;
    const displayTitle = item.title || parseTitle;
    const sizeBytes = getObservedSizeBytes(item._size, item.sizeBytes, item.size);
    const isPack = Boolean(meta?.isSeries && isConfidentSeasonPackItem(runtimeItem, meta, ''));
    return buildPlayableStream({
        service,
        item: runtimeItem,
        streamUrl,
        displayTitle,
        parseTitle,
        sizeBytes,
        seeders: null,
        config,
        meta,
        isLazy: false,
        isPack
    });
}

function savedCloudKeyFingerprint(value) {
    const raw = String(value || '');
    if (!raw) return 'empty';
    return crypto.createHash('sha1').update(raw).digest('hex').slice(0, 12);
}

function savedCloudShortMeta(meta = {}) {
    return `title="${String(meta?.title || meta?.name || 'n/a').replace(/[\r\n\t]+/g, ' ').slice(0, 80)}" imdb=${meta?.imdb_id || meta?.imdb || 'n/a'} tmdb=${meta?.tmdb_id || meta?.id || 'n/a'} s=${meta?.season || 0} e=${meta?.episode || 0}`;
}

async function attachSavedCloudStreams({ debridStreams, finalRanked, config, meta, type, reqHost, userConfStr, debridApiKey, configuredDebridService }) {
    const filters = config?.filters || {};
    const mode = SavedCloud.getMode(filters);
    const normalizedService = String(configuredDebridService || '').toLowerCase();
    const enabled = filters?.enableSavedCloud === true;
    const streamCount = Array.isArray(debridStreams) ? debridStreams.length : 0;
    const rankedCount = Array.isArray(finalRanked) ? finalRanked.length : 0;
    const max = SavedCloud.getLimit(filters || {});
    const fallbackThreshold = Math.max(1, Math.min(4, max));
    const serviceOk = ['rd', 'tb'].includes(normalizedService);
    const hasKey = Boolean(debridApiKey);

    logger.info(`[SAVED CLOUD] gate | enabled=${enabled} rawEnabled=${String(filters?.enableSavedCloud)} mode=${mode} service=${normalizedService || 'n/a'} serviceOk=${serviceOk} hasKey=${hasKey} keyfp=${savedCloudKeyFingerprint(debridApiKey)} streams=${streamCount} ranked=${rankedCount} max=${max} threshold=${fallbackThreshold} type=${type || 'n/a'} ${savedCloudShortMeta(meta)}`);

    if (enabled !== true) {
        logger.info('[SAVED CLOUD] skip | reason=toggle_disabled_or_missing_config');
        return debridStreams;
    }
    if (mode === 'off') {
        logger.info('[SAVED CLOUD] skip | reason=mode_off');
        return debridStreams;
    }
    if (!hasKey) {
        logger.info('[SAVED CLOUD] skip | reason=missing_debrid_api_key');
        return debridStreams;
    }
    if (!serviceOk) {
        logger.info(`[SAVED CLOUD] skip | reason=unsupported_service service=${normalizedService || 'n/a'} expected=rd_or_tb`);
        return debridStreams;
    }
    if (mode === 'fallback' && streamCount >= fallbackThreshold) {
        logger.info(`[SAVED CLOUD] skip | reason=fallback_not_needed streams=${streamCount} threshold=${fallbackThreshold}`);
        return debridStreams;
    }

    const existingHashes = collectExistingTorrentHashes(finalRanked, debridStreams);
    let outputStreams = Array.isArray(debridStreams) ? debridStreams : [];
    logger.info(`[SAVED CLOUD] lookup start | service=${normalizedService.toUpperCase()} mode=${mode} existingHashes=${existingHashes.size} max=${max}`);

    const dupStartedAt = Date.now();
    const duplicateMarkers = await SavedCloud.findSavedCloudDuplicateHashes({
        service: normalizedService,
        apiKey: debridApiKey,
        meta,
        type,
        filters,
        existingHashes,
        logger
    });
    const duplicateAnnotation = annotateSavedCloudDuplicateStreams(outputStreams, duplicateMarkers, normalizedService);
    outputStreams = duplicateAnnotation.streams;
    logger.info(`[SAVED CLOUD] duplicate upgrade | cloudDuplicates=${Array.isArray(duplicateMarkers) ? duplicateMarkers.length : 0} annotated=${duplicateAnnotation.annotated} ms=${Date.now() - dupStartedAt}`);

    const startedAt = Date.now();
    const items = await SavedCloud.findSavedCloudItems({
        service: normalizedService,
        apiKey: debridApiKey,
        meta,
        type,
        filters,
        max,
        existingHashes,
        logger
    });

    logger.info(`[SAVED CLOUD] lookup done | service=${normalizedService.toUpperCase()} rawItems=${Array.isArray(items) ? items.length : 0} ms=${Date.now() - startedAt}`);

    if (!Array.isArray(items) || items.length === 0) {
        logger.info(`[SAVED CLOUD] added=0 | reason=no_new_candidates_after_cloud_scan duplicateAnnotated=${duplicateAnnotation.annotated}`);
        return outputStreams;
    }

    const langMode = getEffectiveLangMode(config, meta, type);
    const filtered = [];
    const seen = new Set(Array.from(existingHashes));
    const drop = {
        duplicate_hash: 0,
        language: 0,
        quality: 0,
        invalid_stream: 0
    };

    for (const item of items) {
        const hash = String(item?.hash || item?.infoHash || '').toLowerCase();
        const label = `${item?.title || ''} ${item?.filename || ''}`.trim();

        if (hash && seen.has(hash)) {
            drop.duplicate_hash++;
            logger.info(`[SAVED CLOUD] drop | reason=duplicate_hash hash=${hash.slice(0, 12)} title="${label.replace(/[\r\n\t]+/g, ' ').slice(0, 90)}"`);
            continue;
        }
        if (!keepLanguageCandidateForMode(item, meta, langMode)) {
            drop.language++;
            logger.info(`[SAVED CLOUD] drop | reason=language_filter langMode=${langMode} title="${label.replace(/[\r\n\t]+/g, ' ').slice(0, 90)}"`);
            continue;
        }
        if (shouldDropByConfiguredQuality(label, filters || {}, { treatGenericHdAs720: true })) {
            drop.quality++;
            logger.info(`[SAVED CLOUD] drop | reason=quality_filter title="${label.replace(/[\r\n\t]+/g, ' ').slice(0, 90)}"`);
            continue;
        }

        if (hash) seen.add(hash);
        filtered.push(item);
        logger.info(`[SAVED CLOUD] keep | service=${normalizedService.toUpperCase()} hash=${hash ? hash.slice(0, 12) : 'n/a'} torrentId=${item?.torrentId || 'n/a'} fileId=${item?.fileId ?? item?.fileIdx ?? 'n/a'} title="${label.replace(/[\r\n\t]+/g, ' ').slice(0, 90)}"`);

        if (filtered.length >= max) break;
    }

    const savedStreams = filtered
        .map((item) => {
            const stream = generateSavedCloudStream(item, config, meta, reqHost, userConfStr);
            if (!stream) {
                drop.invalid_stream++;
                logger.info(`[SAVED CLOUD] drop | reason=stream_generation_failed torrentId=${item?.torrentId || 'n/a'} fileId=${item?.fileId ?? item?.fileIdx ?? 'n/a'}`);
            }
            return stream;
        })
        .filter(Boolean);

    logger.info(`[SAVED CLOUD] summary | added=${savedStreams.length} raw=${items.length} kept=${filtered.length} duplicate=${drop.duplicate_hash} language=${drop.language} quality=${drop.quality} invalid=${drop.invalid_stream} finalStreams=${outputStreams.length + savedStreams.length} mode=${mode} service=${normalizedService.toUpperCase()} imdb=${meta?.imdb_id || 'n/a'}`);

    if (savedStreams.length > 0) {
        logger.info(`[SAVED CLOUD] Aggiunti ${savedStreams.length} stream ${String(normalizedService).toUpperCase()} salvati | mode=${mode} | imdb=${meta?.imdb_id || 'n/a'}`);
    }
    return [...outputStreams, ...savedStreams];
}

async function resolveDebridLink(config, item, showFake, reqHost, meta) {
    try {
        const service = getNormalizedDebridService(config);
        const apiKey = getConfiguredDebridKey(config, service);
        if (!service || !apiKey) return null;

        const isSeries = Boolean(meta?.isSeries || Number(meta?.season || 0) > 0 || Number(meta?.episode || 0) > 0);
        const isPack = isSeries && isConfidentSeasonPackItem(item, meta, '');
        const displayTitle = (aioFormatter.isAIOStreamsEnabled(config) && isPack && isSeries && meta) ? getEpisodeDisplayTitle(meta, item.title) : item.title;
        const runtimeItem = createRuntimeItem(item, meta);
        const rawConf = config?.rawConf || '';
        const torrentioPassthroughUrl = service === 'rd' ? getTorrentioPassthroughUrl(runtimeItem) : null;
        if (torrentioPassthroughUrl) {
            const realSize = getObservedSizeBytes(runtimeItem._size, runtimeItem.sizeBytes);
            const finalSeeders = getObservedSeederCount(runtimeItem.seeders);
            runtimeItem._rdCacheState = 'cached';
            runtimeItem.rdCacheState = 'cached';
            runtimeItem.cacheState = 'cached';
            runtimeItem._dbCachedRd = true;
            runtimeItem.cached_rd = true;
            runtimeItem._torrentioRdAuthority = true;
            runtimeItem._torrentioCached = true;
            runtimeItem._torrentioRdDirect = true;
            runtimeItem._rdProof = runtimeItem._rdProof || 'torrentio_passthrough_url';
            logger.info(`[TORRENTIO PASSTHROUGH] playable url preserved hash=${runtimeItem.hash || runtimeItem.infoHash || 'n/a'} fileIdx=${getResolvedFileIdx(runtimeItem) ?? 'n/a'} addon=${runtimeItem.externalAddon || 'torrentio'} source=${runtimeItem.externalProvider || runtimeItem.source || 'n/a'}`);
            return annotateTorrentioPassthroughStream(buildPlayableStream({
                service,
                item: runtimeItem,
                streamUrl: torrentioPassthroughUrl,
                displayTitle,
                parseTitle: runtimeItem.title,
                sizeBytes: realSize,
                seeders: finalSeeders,
                config,
                meta,
                isPack
            }), runtimeItem, torrentioPassthroughUrl);
        }

        const mediaFusionPassthroughUrl = service === 'rd' ? getMediaFusionPassthroughUrl(runtimeItem) : null;
        if (mediaFusionPassthroughUrl) {
            const realSize = getObservedSizeBytes(runtimeItem._size, runtimeItem.sizeBytes);
            const finalSeeders = getObservedSeederCount(runtimeItem.seeders);
            runtimeItem._rdCacheState = 'cached';
            runtimeItem.rdCacheState = 'cached';
            runtimeItem.cacheState = 'cached';
            runtimeItem._dbCachedRd = true;
            runtimeItem.cached_rd = true;
            runtimeItem._mediafusionRdAuthority = true;
            runtimeItem._mediafusionRdChecked = true;
            runtimeItem._nexusBridgeRdChecked = true;
            runtimeItem._externalRdChecked = true;
            runtimeItem._rdProof = runtimeItem._rdProof || 'mediafusion_passthrough_url';
            logger.info(`[MEDIAFUSION PASSTHROUGH] playable url preserved hash=${runtimeItem.hash || runtimeItem.infoHash || 'n/a'} fileIdx=${getResolvedFileIdx(runtimeItem) ?? 'n/a'} source=${runtimeItem.externalProvider || runtimeItem.source || 'n/a'}`);
            return annotateMediaFusionPassthroughStream(buildPlayableStream({
                service,
                item: runtimeItem,
                streamUrl: mediaFusionPassthroughUrl,
                displayTitle,
                parseTitle: runtimeItem.title,
                sizeBytes: realSize,
                seeders: finalSeeders,
                config,
                meta,
                isPack
            }), runtimeItem, mediaFusionPassthroughUrl);
        }

        const directUrl = getExternalDirectUrl(runtimeItem);
        if (directUrl) {
            const realSize = getObservedSizeBytes(runtimeItem._size, runtimeItem.sizeBytes);
            const finalSeeders = getObservedSeederCount(runtimeItem.seeders);
            runtimeItem._rdCacheState = 'cached';
            runtimeItem.rdCacheState = 'cached';
            runtimeItem._dbCachedRd = true;
            runtimeItem.cached_rd = true;
            return buildPlayableStream({
                service,
                item: runtimeItem,
                streamUrl: maybeBuildContentProxyUrl(reqHost, rawConf, directUrl, config, {
                    source: 'external_direct',
                    direct: true,
                    filename: runtimeItem.filename || runtimeItem.file_title || displayTitle || runtimeItem.title,
                    headers: runtimeItem.behaviorHints?.proxyHeaders?.request || runtimeItem.proxyHeaders?.request || runtimeItem.headers || {}
                }),
                displayTitle,
                parseTitle: runtimeItem.title,
                sizeBytes: realSize,
                seeders: finalSeeders,
                config,
                meta,
                isPack
            });
        }

        if (service === 'tb') {
            if (!item._tbCached) return null;
            const realSize = getObservedSizeBytes(item._size, item.sizeBytes);
            const finalSeeders = getObservedSeederCount(item.seeders);
            if (realSize > 0) {
                runtimeItem._size = realSize;
                runtimeItem.sizeBytes = realSize;
            }
            const proxyUrl = `${reqHost}/${rawConf}/play_tb/${item.hash}?s=${runtimeItem.season || 0}&e=${runtimeItem.episode || 0}&f=${(item.fileIdx !== undefined && !isNaN(item.fileIdx)) ? item.fileIdx : -1}`;
            return buildPlayableStream({
                service: 'tb',
                item: runtimeItem,
                streamUrl: proxyUrl,
                displayTitle,
                parseTitle: item.title,
                sizeBytes: realSize,
                seeders: finalSeeders,
                config,
                meta,
                isPack
            });
        }

        let streamData = null;
        if (service === 'rd') {
            streamData = await RD.getStreamLink(apiKey, item.magnet, runtimeItem.season, runtimeItem.episode, item.fileIdx, {
                validateDownloadUrl: shouldEnforceRdPlayableOnly(config?.filters || {}),
                probeReason: 'stream_list_preflight'
            });
        }

        const resolvedSize = getObservedSizeBytes(
            streamData?.rd_file_size,
            streamData?.file_size,
            streamData?.filesize,
            streamData?.size,
            item?._size,
            item?.sizeBytes
        );
        if (!streamData || (streamData.type === "ready" && resolvedSize > 0 && resolvedSize < CONFIG.REAL_SIZE_FILTER)) return null;

        const parseTitle = streamData.filename || item.title;
        const finalSize = resolvedSize;
        const finalSeeders = getObservedSeederCount(item.seeders);
        runtimeItem._rdCacheState = 'cached';
        runtimeItem.rdCacheState = 'cached';
        runtimeItem._dbCachedRd = true;
        runtimeItem.cached_rd = true;
        if (finalSize > 0) {
            runtimeItem._size = finalSize;
            runtimeItem.sizeBytes = finalSize;
        }
        await persistResolvedDebridAvailability(meta, runtimeItem, streamData, service, 'direct_resolve');
        TorrentInfoLedger.recordResolvedFileIndex({
            meta,
            item: runtimeItem,
            streamData,
            service,
            dbHelper,
            logger,
            reason: 'direct_resolve'
        }).catch(() => {});
        const resolvedFileIndexRaw = streamData?.rd_file_index ?? streamData?.tb_file_id ?? streamData?.file_id ?? streamData?.file_index ?? streamData?.fileIdx;
        const resolvedFileIndex = resolvedFileIndexRaw === null || resolvedFileIndexRaw === undefined || resolvedFileIndexRaw === ''
            ? null
            : (Number.isInteger(Number(resolvedFileIndexRaw)) ? Number(resolvedFileIndexRaw) : null);
        rememberValidatedFileSet(runtimeItem, meta, {
            title: displayTitle || parseTitle || item.title,
            titleSource: 'direct_resolve',
            packName: parseTitle || item.title || null,
            files: [],
            raw: {
                title: displayTitle || parseTitle || item.title,
                filename: parseTitle || item.title || null,
                packName: parseTitle || item.title || null,
                fileIndex: resolvedFileIndex ?? runtimeItem.fileIdx,
                fileIdx: resolvedFileIndex ?? runtimeItem.fileIdx,
                fileName: parseTitle || item.title || null,
                fileSize: finalSize || null,
                size: finalSize || null,
                source: service,
                totalPackSize: finalSize || null
            }
        });

        return buildPlayableStream({
            service,
            item: runtimeItem,
            streamUrl: maybeBuildContentProxyUrl(reqHost, rawConf, streamData.url, config, {
                source: service,
                debrid: true,
                filename: parseTitle || displayTitle || runtimeItem.title
            }),
            displayTitle,
            parseTitle,
            sizeBytes: finalSize,
            seeders: finalSeeders,
            config,
            meta,
            isPack
        });
    } catch (e) {
        if (showFake) {
            return {
                name: `[P2P WARNING]`,
                title: `${item.title}\n⚠️ Cache Assente`,
                url: item.magnet,
                behaviorHints: { notWebReady: true }
            };
        }
        return null;
    }
}

function getPositiveInteger(value, fallback = 0) {
    const parsed = Number(value);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function getLazyPlaybackEpisodeContext(item = {}, meta = {}) {
    const titleText = String(item?.fileName || item?.filename || item?.file_title || item?.title || '');
    const parsed = meta?.isSeries || Number(meta?.season || 0) > 0 || Number(meta?.episode || 0) > 0
        ? extractSeasonEpisodeFromFilename(titleText, getPositiveInteger(item?.season, getPositiveInteger(meta?.season, 1)), getEpisodeParseOptions(meta))
        : null;
    const season = getPositiveInteger(item?.season, getPositiveInteger(parsed?.season, getPositiveInteger(meta?.season, 0)));
    const episode = getPositiveInteger(item?.episode, getPositiveInteger(parsed?.episode, getPositiveInteger(meta?.episode, 0)));
    return { season, episode };
}

function generateRdDownloadToDebridStream(item, config, meta, reqHost, userConfStr) {
    const service = getNormalizedDebridService(config);
    if (service !== 'rd' || !item?.hash) return null;

    const isSeries = Boolean(meta?.isSeries || Number(meta?.season || 0) > 0 || Number(meta?.episode || 0) > 0);
    const isPack = isSeries && isConfidentSeasonPackItem(item, meta, '');
    const runtimeItem = createRuntimeItem({
        ...item,
        _rdCacheState: isTorrentioRdAuthorityCandidate(item) ? 'likely_cached' : 'unknown',
        rdCacheState: isTorrentioRdAuthorityCandidate(item) ? 'likely_cached' : 'unknown',
        cacheState: isTorrentioRdAuthorityCandidate(item) ? 'likely_cached' : 'unknown',
        _dbCachedRd: null,
        cached_rd: null,
        _torrentioRdAuthority: Boolean(item?._torrentioRdAuthority),
        _torrentioCached: Boolean(item?._torrentioCached),
        _rdProof: item?._rdProof,
        source: `${item?.source || 'Torrent'} · ${isTorrentioRdAuthorityCandidate(item) ? 'RD cached candidate' : 'RD download'}`
    }, meta);

    let displayTitle = item.title;
    if (aioFormatter.isAIOStreamsEnabled(config) && isPack && isSeries) {
        displayTitle = getEpisodeDisplayTitle(meta, item.title);
    }

    const realSize = getObservedSizeBytes(item._size, item.sizeBytes);
    const finalSeeders = getObservedSeederCount(item.seeders);
    const playbackContext = getLazyPlaybackEpisodeContext(item, meta);
    const query = new URLSearchParams();
    query.set('rd_download', '1');
    query.set('s', String(playbackContext.season || 0));
    query.set('e', String(playbackContext.episode || 0));
    if (Number.isInteger(Number(item.fileIdx)) && Number(item.fileIdx) >= 0) query.set('f', String(Number(item.fileIdx)));
    if (meta?.imdb_id) query.set('imdb', String(meta.imdb_id));
    const compactMagnet = compactMagnetForCloudBuild(item);
    const encodedMagnet = base64UrlEncodeText(compactMagnet);
    if (encodedMagnet && encodedMagnet.length < 4096) query.set('m', encodedMagnet);
    const streamUrl = `${reqHost}/${userConfStr}/add_to_cloud/${item.hash}?${query.toString()}`;

    const stream = buildPlayableStream({
        service: 'rd',
        item: runtimeItem,
        streamUrl,
        displayTitle,
        parseTitle: item.title,
        sizeBytes: realSize,
        seeders: finalSeeders,
        config,
        meta,
        isLazy: false,
        isPack
    });

    if (!stream) return null;
    const note = isTorrentioRdAuthorityCandidate(item)
        ? '⏳ Torrentio RD cached • se non parte, aggiungi al cloud e aggiorna'
        : '⬇️ RD download • aggiungi al cloud, poi aggiorna';
    stream.title = `${stream.title || displayTitle || item.title}
${note}`;
    stream.cacheState = 'download';
    stream.rdCacheState = 'download';
    stream.behaviorHints = {
        ...(stream.behaviorHints || {}),
        cacheState: 'download',
        rdCacheState: 'download',
        notWebReady: false,
        rdDownloadToDebrid: true
    };
    return stream;
}

function generateLazyStream(item, config, meta, reqHost, userConfStr, isLazy = false, options = {}) {
    const service = getNormalizedDebridService(config);
    if (!service) return null;
    if (service === 'rd' && !options?.allowRdVerifiedDbFallback && !shouldAllowRdLazyStreams(config?.filters || {})) return null;
    const isSeries = Boolean(meta?.isSeries || Number(meta?.season || 0) > 0 || Number(meta?.episode || 0) > 0);
    const isPack = isSeries && isConfidentSeasonPackItem(item, meta, '');
    const runtimeItem = createRuntimeItem(item, meta);

    let displayTitle = item.title;
    let realSize = getObservedSizeBytes(item._size, item.sizeBytes);

    if (aioFormatter.isAIOStreamsEnabled(config) && isPack && isSeries) {
        realSize = 0;
        displayTitle = getEpisodeDisplayTitle(meta, item.title);
    }

    const finalSeeders = getObservedSeederCount(item.seeders);
    const directUrl = getExternalDirectUrl(runtimeItem);
    if (directUrl) {
        runtimeItem._rdCacheState = 'cached';
        runtimeItem.rdCacheState = 'cached';
        runtimeItem._dbCachedRd = true;
        runtimeItem.cached_rd = true;
        return buildPlayableStream({
            service,
            item: runtimeItem,
            streamUrl: maybeBuildContentProxyUrl(reqHost, userConfStr, directUrl, config, {
                source: 'external_direct',
                direct: true,
                filename: runtimeItem.filename || runtimeItem.file_title || displayTitle || runtimeItem.title,
                headers: runtimeItem.behaviorHints?.proxyHeaders?.request || runtimeItem.proxyHeaders?.request || runtimeItem.headers || {}
            }),
            displayTitle,
            parseTitle: item.title,
            sizeBytes: realSize,
            seeders: finalSeeders,
            config,
            meta,
            isLazy: false,
            isPack
        });
    }

    if (!item.hash) return null;

    const playbackContext = getLazyPlaybackEpisodeContext(item, meta);
    const playbackSeason = playbackContext.season || 0;
    const playbackEpisode = playbackContext.episode || 0;
    const playbackFileIdx = (item.fileIdx !== undefined && !isNaN(item.fileIdx)) ? item.fileIdx : -1;
    const imdbParam = meta?.imdb_id ? `&imdb=${encodeURIComponent(meta.imdb_id)}` : '';
    const lazyUrl = `${reqHost}/${userConfStr}/play_lazy/${service}/${item.hash}/${playbackFileIdx}?s=${playbackSeason}&e=${playbackEpisode}${imdbParam}`;
    const lazyCacheKey = `${service}:${item.hash}:${playbackSeason}:${playbackEpisode}:${playbackFileIdx}`;
    Cache.cacheLazyMeta(lazyCacheKey, {
        imdb_id: meta?.imdb_id || null,
        season: playbackSeason,
        episode: playbackEpisode,
        type: isSeries ? 'series' : 'movie',
        title: item?.title || displayTitle || null,
        source: item?.source || null,
        seeders: finalSeeders,
        size: realSize > 0 ? realSize : 0,
        fileIdx: (item.fileIdx !== undefined && !isNaN(item.fileIdx)) ? item.fileIdx : -1,
        folderSize: getObservedFolderSizeBytes(item) || 0
    }, 43200).catch(() => {});

    return buildPlayableStream({
        service,
        item: runtimeItem,
        streamUrl: lazyUrl,
        displayTitle,
        parseTitle: item.title,
        sizeBytes: realSize,
        seeders: finalSeeders,
        config,
        meta,
        isLazy,
        isPack
    });
}

function buildRdVerifiedDbFallbackStreams({
    finalRanked = [],
    resolvedInstant = [],
    existingStreams = [],
    rdDirectOnly = false,
    filters = {},
    resolverConfig = {},
    meta = {},
    reqHost = '',
    userConfStr = ''
} = {}) {
    if (!rdDirectOnly) return [];
    if (getNormalizedDebridService(resolverConfig) !== 'rd') return [];

    const resolved = Array.isArray(resolvedInstant) ? resolvedInstant : [];
    const existing = Array.isArray(existingStreams) ? existingStreams : [];
    const target = getRdVerifiedDbFallbackLimit(filters, CONFIG.MAX_RESULTS || 12);
    const remaining = Math.max(0, target - resolved.length - existing.length);
    if (remaining <= 0) return [];

    const occupiedHashes = collectExistingTorrentHashes([], [
        ...resolved,
        ...existing
    ]);
    const seen = new Set(occupiedHashes);
    const candidates = [];

    for (const item of Array.isArray(finalRanked) ? finalRanked : []) {
        if (!isRdVerifiedDbFallbackCandidate(item)) continue;
        const hash = String(getCandidateInfoHash(item) || '').toLowerCase();
        if (!hash || seen.has(hash)) continue;
        seen.add(hash);
        candidates.push(item);
        if (candidates.length >= remaining) break;
    }

    return candidates
        .map((item) => generateLazyStream(item, resolverConfig, meta, reqHost, userConfStr, true, { allowRdVerifiedDbFallback: true }))
        .filter(Boolean)
        .map((stream) => ({
            ...stream,
            behaviorHints: {
                ...(stream.behaviorHints || {}),
                rdVerifiedDbFallback: true
            }
        }));
}

function stripMoviePackLabel(title) {
    return String(title || '')
        .replace(/\s*📦\s*(?:SEASON\s*)?PACK\b/ig, '')
        .replace(/\bSEASON\s+PACK\b/ig, '')
        .replace(/\bSTAGIONE\s+PACK\b/ig, '')
        .replace(/\s{2,}/g, ' ')
        .trim();
}

async function queryRemoteIndexer(tmdbId, type, season = null, episode = null, config, meta = {}) { 
    if (!CONFIG.INDEXER_URL || !tmdbId) return [];
    try {
        logger.info(`[REMOTE] Query VPS: ${CONFIG.INDEXER_URL} | ID: ${tmdbId} S:${season} E:${episode}`);
        let url = `${CONFIG.INDEXER_URL}/api/get/${tmdbId}`;
        if (season) url += `?season=${season}`;
        if (episode) url += `&episode=${episode}`;
        const { data } = await axios.get(url, { timeout: CONFIG.TIMEOUTS.REMOTE_INDEXER });
        if (!data || !data.torrents || !Array.isArray(data.torrents)) return [];
        
        const isSeriesQuery = String(type || '').toLowerCase() === 'series' || Boolean(season || episode || meta?.isSeries);
        const mapped = data.torrents.map(t => {
            const safeDbTitle = isSeriesQuery ? t.title : stripMoviePackLabel(t.title);
            let magnet = t.magnet || buildTrackerMagnet(t.info_hash, safeDbTitle || t.title);
            if (!String(magnet).includes("tr=")) magnet = buildTrackerMagnet(t.info_hash, safeDbTitle || t.title);
            let providerName = cleanTorrentioProviderLabel(t.provider || 'P2P') || 'P2P';
            const finalHash = t.info_hash ? t.info_hash.toUpperCase() : extractInfoHash(magnet);
            return {
                title: safeDbTitle || t.title,
                magnet: magnet,
                hash: finalHash,
                infoHash: finalHash,
                size: "DB Cache",
                sizeBytes: parseInt(t.size),
                folderSize: Number(t.folder_size || t.folderSize || t.total_size || 0) || undefined,
                seeders: parseInt(t.seeders, 10) || 0,
                source: providerName,
                provider: providerName,
                fileIdx: t.file_index !== undefined ? parseInt(t.file_index) : undefined,
                _sourceGroup: 'remote_db',
                _remoteDb: true,
                _myDb: true,
                _dbPrimary: true,
                _rdCacheState: t.rd_cache_state || t.rdCacheState || t.cacheState || undefined,
                rdCacheState: t.rd_cache_state || t.rdCacheState || t.cacheState || undefined,
                _dbCachedRd: t.cached_rd === true ? true : (t.cached_rd === false ? false : undefined),
                cached_rd: t.cached_rd === true ? true : (t.cached_rd === false ? false : undefined),
                _isPack: Boolean(isSeriesQuery && isConfidentSeasonPackItem({ title: safeDbTitle || t.title, sizeBytes: parseInt(t.size), folderSize: Number(t.folder_size || t.folderSize || t.total_size || 0) || undefined }, meta, type))
            };
        });

        const langMode = getEffectiveSearchLanguageMode(config?.filters || {}, meta, type);
        return mapped.filter(item => {
             const title = item.title || '';
             if (langMode === 'ita') return keepItalianCandidate(title, item.source, meta?.title);
             if (langMode === 'eng') return keepEnglishCandidate(title, item.source, meta?.title);
             return keepAllCandidate(title, item.source, meta?.title);
        });
    } catch (e) { logger.error("Err Remote Indexer:", { error: e.message }); return []; }
}

function cleanTorrentioProviderLabel(value = '') {
    const raw = String(value || '').replace(/\[EXT\]\s*/gi, '').replace(/LeviathanDB/gi, '').replace(/[()]/g, '').trim();
    if (!raw) return '';
    const cleaned = raw
        .replace(/^Torrentio\s*(?:·|:|-|\/)?\s*/i, '')
        .replace(/^Torrentio\s+/i, '')
        .trim();
    return cleaned || raw;
}

function getExternalSourceLabel(item = {}) {
    const addon = String(item.externalAddon || '').toLowerCase();
    const group = String(item.externalGroup || '').toLowerCase();
    const provider = String(item.externalProvider || '').trim();
    const fallback = String(item.source || '').replace(/\[EXT\]\s*/, '').trim();

    if (group === 'torrentio' || addon.startsWith('torrentio')) return cleanTorrentioProviderLabel(provider || fallback) || 'Torrentio';
    if (group === 'mediafusion' || addon === 'mediafusion') return provider ? `MediaFusion · ${provider}` : 'MediaFusion';
    return provider || fallback || 'External';
}

function normalizeExternalTextValue(value = '') {
    return String(value || '').replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function pickExternalPipelineTitle(item = {}, meta = {}) {
    const rawTitle = normalizeExternalTextValue(item.title || item.filename || item.file_title || item.name || '');
    const candidates = [
        rawTitle,
        item.websiteTitle,
        item.filename,
        item.file_title,
        item.name,
        item.rawDescription,
        item.packTitle
    ].map(normalizeExternalTextValue).filter(Boolean);

    const metaTitle = normalizeSearchText(meta?.title || meta?.name || '');
    const richByTitle = metaTitle
        ? candidates.find((candidate) => normalizeSearchText(candidate).includes(metaTitle) && hasUsefulReleaseSignals(candidate))
        : null;
    const richBySignals = candidates.find((candidate) => candidate.length > 8 && hasUsefulReleaseSignals(candidate));
    const rich = richByTitle || richBySignals || candidates.find((candidate) => candidate.length > 8) || rawTitle;

    return isSparseEpisodeOnlyTitle(rawTitle) && rich ? rich : (rawTitle || rich || '');
}

function buildExternalFormatterTitle(item = {}, title = '', { externalLanguageOk = false } = {}) {
    const parts = [title];
    const signalText = [
        item.rawDescription,
        item.websiteTitle,
        item.filename,
        item.file_title,
        item.name,
        item.quality,
        item.resolution,
        item.quality_tag,
        item.techTags,
        item.audio,
        item.audio_tag,
        item.language,
        Array.isArray(item.languages) ? item.languages.join(' ') : item.languages,
        item.languageInfo?.displayLabel,
        item.languageInfo?.reason,
        Array.isArray(item.languageInfo?.detectedLanguages) ? item.languageInfo.detectedLanguages.join(' ') : item.languageInfo?.detectedLanguages
    ].map(normalizeExternalTextValue).filter(Boolean).join(' ');

    const joinedTitle = parts.join(' ');
    const titleNeedsSignals = isSparseEpisodeOnlyTitle(title)
        || !hasUsefulReleaseSignals(title)
        || !/\b(?:2160p|4k|uhd|1080p|720p|480p)\b/i.test(joinedTitle)
        || (externalLanguageOk && !/\b(?:ITA|ITALIAN|ITALIANO|IT)\b/i.test(joinedTitle));
    if (signalText && titleNeedsSignals) parts.push(signalText);
    if (!/\b(?:2160p|4k|uhd|1080p|720p|480p)\b/i.test(parts.join(' ')) && item.quality) parts.push(item.quality);
    if (item.techTags) parts.push(item.techTags);
    if (externalLanguageOk && !/\b(?:ITA|ITALIAN|ITALIANO|IT)\b/i.test(parts.join(' '))) parts.push('ITA');
    if (/\b(?:ENG|ENGLISH)\b/i.test(signalText) && !/\b(?:ENG|ENGLISH)\b/i.test(parts.join(' '))) parts.push('ENG');

    return [...new Set(parts.map(normalizeExternalTextValue).filter(Boolean))].join(' ');
}

function collectTorrentioRdAuthorityText(item = {}) {
    const hints = item?.behaviorHints && typeof item.behaviorHints === 'object' ? item.behaviorHints : {};
    const values = [
        item?.title, item?.name, item?.filename, item?.file_title, item?.websiteTitle, item?.rawDescription,
        item?.description, item?.source, item?.provider, item?.externalProvider, item?.externalAddon, item?.externalGroup,
        item?.cacheState, item?.rdCacheState, item?._rdCacheState, item?.cachedStatus, item?.debridStatus, item?.availability,
        hints.cacheState, hints.rdCacheState, hints.cached, hints.filename, hints.bingeGroup, hints.infoHash
    ];
    return values.flatMap((value) => Array.isArray(value) ? value : [value]).filter(Boolean).join(' ');
}

function hasTorrentioRdDownloadMarker(item = {}) {
    const text = collectTorrentioRdAuthorityText(item);
    return /(?:⬇️|\bRD\s*download\b|\bdownload\s+to\s+debrid\b|\baggiungi\s+al\s+cloud\b|\badd\s+to\s+cloud\b)/i.test(text);
}

function hasTorrentioRdCachedMarker(item = {}) {
    const text = collectTorrentioRdAuthorityText(item);
    if (!text) return false;
    if (item?._dbCachedRd === true || item?.cached_rd === true || item?.isCached === true || item?.cached === true) return true;
    if (/^(?:cached|rd_cached|instant|instant_available)$/i.test(String(item?._rdCacheState || item?.rdCacheState || item?.cacheState || '').trim())) return true;
    return /(?:⚡|\bRD\s*\+\b|\bRD\+\b|\bReal[-\s]?Debrid\s*(?:cached|instant|ready)\b|\binstant(?:ly)?\s*(?:available|ready)\b|\bcached\b)/i.test(text);
}

function getTorrentioRdAuthority(item = {}, { service = null, onlyItalian = false, externalLanguageOk = false, directUrl = null } = {}) {
    if (String(service || '').toLowerCase() !== 'rd') return { trusted: false, direct: false, reason: '' };
    if (!isTorrentioExternalItem(item)) return { trusted: false, direct: false, reason: '' };
    if (onlyItalian && !externalLanguageOk) return { trusted: false, direct: false, reason: 'language_rejected' };

    const hasDirect = /^https?:\/\//i.test(String(directUrl || '').trim());
    if (hasDirect) return { trusted: true, direct: true, reason: 'torrentio_passthrough_url' };
    if (hasTorrentioRdDownloadMarker(item)) return { trusted: false, direct: false, reason: 'torrentio_download_marker' };
    if (hasTorrentioRdCachedMarker(item)) return { trusted: true, direct: false, reason: 'torrentio_cached_marker' };
    return { trusted: false, direct: false, reason: '' };
}

function isTorrentioRdAuthorityCandidate(item = {}) {
    return Boolean(
        item?._torrentioRdAuthority === true ||
        item?._torrentioCached === true ||
        item?._rdProof === 'torrentio_direct_url' ||
        item?._rdProof === 'torrentio_passthrough_url' ||
        item?._rdProof === 'torrentio_cached_marker' ||
        (isTorrentioExternalItem(item) && (item?._dbCachedRd === true || item?.cached_rd === true || item?.rdCacheState === 'cached' || item?._rdCacheState === 'cached'))
    );
}

function isTorrentioRdDownloadCandidate(item = {}) {
    const state = String(item?._rdCacheState || item?.rdCacheState || item?.cacheState || item?.rd_cache_state || '').toLowerCase().trim();
    const proof = String(item?._rdProof || '').toLowerCase().trim();

    // IMPORTANTE: un risultato Torrentio puo nascere come "download", ma poi essere
    // promosso dal DB/availability overlay a RD cached. In quel caso NON va piu
    // escluso dal direct resolve quando RD_ALLOW_DOWNLOAD_TO_DEBRID_ROWS=false.
    // Era la causa dei casi con torrentioAuthority=3/0: candidati considerati
    // autorevoli, ma mai tentati perche ancora marcati come download.
    const hasCachedAuthority = Boolean(
        item?._dbCachedRd === true ||
        item?.cached_rd === true ||
        item?.isCached === true ||
        item?.cached === true ||
        item?._torrentioRdAuthority === true ||
        item?._torrentioCached === true ||
        proof === 'torrentio_cached_marker' ||
        proof === 'torrentio_direct_url' ||
        proof === 'torrentio_passthrough_url' ||
        state === 'cached' ||
        state === 'rd_cached' ||
        state === 'instant' ||
        state === 'instant_available' ||
        state === 'likely_cached'
    );
    if (hasCachedAuthority) return false;

    return Boolean(
        item?._torrentioRdDownload === true ||
        proof === 'torrentio_download_marker' ||
        state === 'download' ||
        (isTorrentioExternalItem(item) && hasTorrentioRdDownloadMarker(item))
    );
}

function normalizeExternalCandidateForPipeline(item, { type, meta = {}, langMode = 'ita', config = {} } = {}) {
    if (!item) return null;
    const onlyItalian = langMode === 'ita';
    const isSeriesQuery = String(type || '').toLowerCase() === 'series' || Boolean(meta?.isSeries || Number(meta?.season || 0) > 0 || Number(meta?.episode || 0) > 0);
    const rawTitle = pickExternalPipelineTitle(item, meta);
    const title = isSeriesQuery ? rawTitle : stripMoviePackLabel(rawTitle);
    const finalSeeders = parseInt(item.seeders, 10) || (title ? extractSeeders(title) : 0);
    const finalSize = item.mainFileSize || item.sizeBytes || (title ? extractSize(title) : 0);
    const rawDirectUrl = getExternalDirectUrl(item);
    const isTorrentio = isTorrentioExternalItem(item);
    const isMediaFusion = isMediaFusionExternalItem(item);
    const torrentioDownloadMarker = isTorrentio && hasTorrentioRdDownloadMarker(item);
    const directUrl = torrentioDownloadMarker ? null : rawDirectUrl;
    const magnetOrDirect = item.magnetLink || item.magnet || directUrl || null;
    const hash = item.infoHash || item.hash || extractInfoHash(item.magnetLink) || extractInfoHash(item.magnet) || extractInfoHash(directUrl || rawDirectUrl);
    const currentDebridService = getNormalizedDebridService(config);
    const mediaFusionPassthroughUrl = currentDebridService === 'rd' ? getMediaFusionPassthroughUrl(item) : null;
    const torrentioLooseItalian = hasTorrentioLooseItalianEvidence(item);
    const externalLanguageOk = Boolean(item.isItalian || item.hasItalianAudio || item.languageInfo?.isItalian || item.languageInfo?.hasAudioItalian || torrentioLooseItalian);
    if (onlyItalian && isTorrentio && !externalLanguageOk) return null;

    const torrentioRdAuthority = torrentioDownloadMarker ? { trusted: false, direct: false, reason: 'torrentio_download_marker' } : getTorrentioRdAuthority(item, {
        service: currentDebridService,
        onlyItalian,
        externalLanguageOk,
        directUrl
    });
    const mediaFusionRdCached = Boolean(
        (mediaFusionPassthroughUrl && isMediaFusion) ||
        (item._mediafusionRdChecked === true || item._mediafusionRdAuthority === true || item._nexusBridgeRdChecked === true || item._externalRdChecked === true) &&
        (item.rdCacheState === 'cached' || item.cacheState === 'cached' || item.cached_rd === true || item._dbCachedRd === true)
    );
    const rdCached = Boolean(mediaFusionRdCached || torrentioRdAuthority.trusted);
    const rdState = rdCached ? 'cached' : (torrentioDownloadMarker ? 'download' : 'unknown');
    const rdCachedBool = rdCached ? true : null;
    const externalPack = isConfidentSeasonPackItem({
        ...item,
        title,
        filename: item.filename || item.file_title,
        packTitle: item.packTitle || '',
        potentialPack: item.potentialPack
    }, meta, type);

    const formatterTitle = buildExternalFormatterTitle(item, title, { externalLanguageOk });

    return {
        title,
        _formatterTitle: formatterTitle || title,
        formatterTitle: formatterTitle || title,
        _externalFormatterTitle: formatterTitle || title,
        magnet: magnetOrDirect,
        directUrl,
        url: directUrl || null,
        _externalDirectUrl: directUrl || null,
        externalDirectUrl: directUrl || null,
        externalPlayableUrl: getTorrentioPassthroughUrl(item) || mediaFusionPassthroughUrl || directUrl || null,
        _torrentioPlayableUrl: getTorrentioPassthroughUrl(item) || null,
        _mediafusionPlayableUrl: mediaFusionPassthroughUrl || item._mediafusionPlayableUrl || null,
        _torrentioPassthrough: Boolean(isTorrentio && getTorrentioPassthroughUrl(item)),
        _mediafusionPassthrough: Boolean(isMediaFusion && mediaFusionPassthroughUrl),
        _externalOriginalUrl: item._externalOriginalUrl || item.url || directUrl || null,
        size: item.size || (finalSize > 0 ? formatBytes(finalSize) : null),
        sizeBytes: finalSize,
        rawDescription: item.rawDescription || null,
        filename: item.filename || item.file_title || null,
        file_title: item.file_title || item.filename || null,
        quality: item.quality || item.resolution || null,
        resolution: item.resolution || item.quality || null,
        techTags: item.techTags || null,
        languages: item.languages || item.language || item.languageInfo?.detectedLanguages || undefined,
        audio: item.audio || item.audio_tag || item.languageInfo?.displayLabel || undefined,
        folderSize: item.folderSize || item.folder_size || item.behaviorHints?.folderSize || undefined,
        seeders: finalSeeders,
        source: getExternalSourceLabel(item),
        hash,
        infoHash: hash,
        fileIdx: item.fileIdx,
        episodeFileHint: item.episodeFileHint || item._episodeFileHint || null,
        _episodeFileHint: item._episodeFileHint || item.episodeFileHint || null,
        _packValidated: item._packValidated === true,
        isExternal: true,
        _sourceGroup: 'external',
        externalAddon: item.externalAddon || null,
        externalGroup: item.externalGroup || null,
        _preferTorrentioSeries: Boolean(isSeriesQuery && isTorrentio),
        _externalLanguageInfo: item.languageInfo || (torrentioLooseItalian ? {
            isItalian: true,
            hasAudioItalian: true,
            hasSubItalian: Boolean(item.hasItalianSubs),
            hasNegativeLanguage: false,
            confidence: 98,
            reason: 'torrentio_loose_it_token'
        } : null),
        _externalRequestId: item._externalRequestId || null,
        _externalIdMatched: item._externalIdMatched === true,
        _externalBatch: item._externalBatch || null,
        _externalIsItalian: Boolean(item.isItalian || item.languageInfo?.isItalian || externalLanguageOk || (torrentioRdAuthority.direct && externalLanguageOk)),
        _externalHasItalianAudio: Boolean(item.hasItalianAudio || item.languageInfo?.hasAudioItalian || externalLanguageOk || (torrentioRdAuthority.direct && externalLanguageOk)),
        _externalHasItalianSubs: Boolean(item.hasItalianSubs || item.languageInfo?.hasSubItalian),
        _externalLanguageConfidence: Math.max(Number(item.languageInfo?.confidence || 0) || 0, externalLanguageOk ? 98 : 0),
        _torrentioLooseItalian: Boolean(torrentioLooseItalian),
        _torrentioLooseItForceKeep: Boolean(isTorrentio && externalLanguageOk && item._externalIdMatched === true),
        _torrentioRdAuthority: Boolean(torrentioRdAuthority.trusted),
        _torrentioCached: Boolean(torrentioRdAuthority.trusted),
        _torrentioRdDirect: Boolean(torrentioRdAuthority.direct),
        _torrentioRdDownload: Boolean(torrentioDownloadMarker),
        _rdProof: torrentioDownloadMarker ? 'torrentio_download_marker' : (torrentioRdAuthority.trusted ? torrentioRdAuthority.reason : (mediaFusionPassthroughUrl ? 'mediafusion_passthrough_url' : undefined)),
        _mediafusionRdAuthority: Boolean(mediaFusionRdCached),
        potentialPack: Boolean(isSeriesQuery && externalPack),
        packTitle: (isSeriesQuery && externalPack) ? (item.packTitle || '') : '',
        _isPack: Boolean(isSeriesQuery && externalPack),
        _rdCacheState: rdState,
        rdCacheState: rdState,
        _dbCachedRd: rdCachedBool,
        cached_rd: rdCachedBool,
        _mediafusionRdChecked: Boolean(item._mediafusionRdChecked || mediaFusionRdCached),
        _nexusBridgeRdChecked: Boolean(item._nexusBridgeRdChecked || torrentioRdAuthority.trusted || torrentioDownloadMarker || mediaFusionRdCached),
        _externalRdChecked: Boolean(item._externalRdChecked || torrentioRdAuthority.trusted || torrentioDownloadMarker || mediaFusionRdCached)
    };
}

function dedupeExternalCandidates(items = []) {
    const bestByKey = new Map();
    for (const item of Array.isArray(items) ? items : []) {
        if (!item) continue;
        const hash = String(item.hash || item.infoHash || '').toLowerCase();
        const fileIdx = Number.isInteger(item.fileIdx) ? item.fileIdx : -1;
        const direct = String(item.directUrl || item.url || item._externalDirectUrl || '').trim();
        const title = String(item.title || '').trim().toLowerCase();
        const key = shouldForceKeepTorrentioIt(item) ? getTorrentioTrustDedupeKey(item) : (hash ? `${hash}:${fileIdx}` : `${title}|${direct}`);
        const existing = bestByKey.get(key);
        if (!existing) {
            bestByKey.set(key, item);
            continue;
        }
        const existingScore = (existing.cached_rd === true ? 100000 : 0) + Number(existing.seeders || 0) + Number(existing.sizeBytes || 0) / 1e12;
        const itemScore = (item.cached_rd === true ? 100000 : 0) + Number(item.seeders || 0) + Number(item.sizeBytes || 0) / 1e12;
        bestByKey.set(key, itemScore > existingScore ? { ...existing, ...item } : { ...item, ...existing });
    }
    return [...bestByKey.values()];
}

function getTorrentioExactMovieGuardMin(config = {}) {
    const raw = config?.filters?.torrentioExactMovieMin ?? process.env.EXT_TORRENTIO_EXACT_MOVIE_MIN ?? '2';
    const parsed = parseInt(raw, 10);
    return Number.isFinite(parsed) ? Math.max(0, Math.min(8, parsed)) : 2;
}

function isTorrentioExactExternalCandidate(item = {}) {
    const addon = String(item.externalAddon || '').toLowerCase();
    const group = String(item.externalGroup || '').toLowerCase();
    return Boolean(item?.isExternal && item?._externalIdMatched && (group === 'torrentio' || addon.startsWith('torrentio')));
}

function getPlayableExternalTarget(item = {}) {
    return item?.magnet || item?.magnetLink || getExternalDirectUrl(item) || item?.directUrl || item?._externalDirectUrl || item?.url || item?.hash || item?.infoHash || null;
}

function getExternalGuardScore(item = {}) {
    const title = String(item?.title || '');
    const size = Number(item?._size || item?.sizeBytes || item?.mainFileSize || 0) || 0;
    const seeders = parseInt(item?.seeders, 10) || 0;
    const cached = item?.cached_rd === true || item?._dbCachedRd === true || item?.rdCacheState === 'cached' ? 1000000 : 0;
    const quality = /\b(?:2160p|4k|uhd)\b/i.test(title) ? 50000
        : /\b(?:1080p|fhd)\b/i.test(title) ? 25000
            : /\b720p\b/i.test(title) ? 10000
                : 0;
    const providerBonus = /\b(?:rarbg|1337x|thepiratebay|cyber|v3sp4)\b/i.test([item?.source, item?.externalProvider, item?.releaseGroup].filter(Boolean).join(' ')) ? 2500 : 0;
    return cached + quality + providerBonus + seeders + (size / 1e12);
}

function shouldProtectTorrentioExactMovieCandidate(item = {}, meta = {}, type = 'movie', langMode = 'ita') {
    if (String(type || '').toLowerCase() === 'series' || meta?.isSeries) return false;
    if (!isTorrentioExactExternalCandidate(item)) return false;
    if (!getPlayableExternalTarget(item)) return false;

    if (langMode === 'ita' && !isExternalStrictItalianCandidate(item)) return false;
    if (langMode === 'eng' && !keepEnglishCandidate(item.title || '', item.source || item.externalProvider || '', meta?.title)) return false;
    if (langMode === 'all' && !keepAllCandidate(item.title || '', item.source || item.externalProvider || '', meta?.title)) return false;

    const title = String(item?.title || '');
    if (/\b(?:S\d{2}|SEASON|STAGIONE)\b/i.test(title) || /\b\d{1,2}x\d{1,2}\b/.test(title)) return false;

    const metaYear = parseInt(meta?.year, 10);
    if (!Number.isNaN(metaYear)) {
        const fileYearMatch = title.match(REGEX_YEAR);
        if (fileYearMatch && Math.abs(parseInt(fileYearMatch[0], 10) - metaYear) > 1) return false;
    }

    return true;
}

function getTorrentioExactSeriesGuardMin(config = {}) {
    const raw = config?.filters?.torrentioExactSeriesMin ?? process.env.EXT_TORRENTIO_EXACT_SERIES_MIN ?? '2';
    const parsed = parseInt(raw, 10);
    return Number.isFinite(parsed) ? Math.max(0, Math.min(8, parsed)) : 2;
}

function hasRequestedSeasonCue(item = {}, meta = {}, type = 'series') {
    const season = Number(meta?.season || 0) || 0;
    if (season <= 0) return false;
    const texts = collectCandidatePackTexts(item);
    for (const text of texts) {
        const parsed = parseCandidateEpisodeText(text, meta, type);
        if (parsed?.season && parsed.season !== season && !shouldIgnoreAnimeSeason(meta, type, text)) return false;
        if (parsed?.isRange || parsed?.isBatch) return true;
        if (parsed?.season === season && !parsed?.episode) return true;
    }
    const joined = texts.join(' ');
    if (new RegExp(`\\bS0?${season}(?!\\s*E|\\d)`, 'i').test(joined)) return true;
    if (new RegExp(`\\b(?:season|stagione)\\s*0?${season}(?!\\d)`, 'i').test(joined)) return true;
    return false;
}

function shouldProtectTorrentioExactSeriesCandidate(item = {}, meta = {}, type = 'series', langMode = 'ita') {
    const isSeries = String(type || '').toLowerCase() === 'series' || meta?.isSeries || Number(meta?.season || 0) > 0 || Number(meta?.episode || 0) > 0;
    if (!isSeries) return false;
    if (!isTorrentioExactExternalCandidate(item)) return false;
    if (!getPlayableExternalTarget(item)) return false;

    if (langMode === 'ita' && !isExternalStrictItalianCandidate(item)) return false;
    if (langMode === 'eng' && !keepEnglishCandidate(item.title || '', item.source || item.externalProvider || '', meta?.title)) return false;
    if (langMode === 'all' && !keepAllCandidate(item.title || '', item.source || item.externalProvider || '', meta?.title)) return false;

    const title = String(item?.title || '');

    const season = Number(meta?.season || 0) || 0;
    const episode = Number(meta?.episode || 0) || 0;
    const parsed = parseCandidateEpisodeText(title, meta, type);

    if (parsed && parsed.season && season > 0 && parsed.season !== season && !shouldIgnoreAnimeSeason(meta, type, title)) return false;
    if (hasWrongExplicitEpisodeMarker(title, { season, episode }) && !shouldIgnoreAnimeSeason(meta, type, title)) return false;
    if (parsed && !parsed.isRange && !parsed.isBatch && episode > 0 && parsed.episode === episode && (parsed.season === season || shouldIgnoreAnimeSeason(meta, type, title))) return true;

    if (isConfidentSeasonPackItem(item, meta, type)) return true;
    if (hasRequestedSeasonCue(item, meta, type)) return true;

    return true;
}

function markTorrentioLooseItForceKeep(item = {}, meta = {}, type = 'series') {
    return {
        ...item,
        _torrentioExactGuard: true,
        _torrentioLooseItForceKeep: true,
        _packValidated: item?._packValidated === true || Boolean(isConfidentSeasonPackItem(item, meta, type) || hasRequestedSeasonCue(item, meta, type)),
        potentialPack: item?.potentialPack === true || Boolean(isConfidentSeasonPackItem(item, meta, type) || hasRequestedSeasonCue(item, meta, type))
    };
}

function protectTorrentioExactSeriesMinimum(items = [], aggressiveFilter, { meta = {}, type = 'series', langMode = 'ita', config = {} } = {}) {
    const list = Array.isArray(items) ? items : [];
    const base = list.filter(aggressiveFilter);
    const isSeries = String(type || '').toLowerCase() === 'series' || meta?.isSeries || Number(meta?.season || 0) > 0 || Number(meta?.episode || 0) > 0;
    const minWanted = getTorrentioExactSeriesGuardMin(config);
    if (!isSeries) return base;

    const seen = new Set(base.map(getTorrentioTrustDedupeKey).filter(Boolean));
    const currentTorrentio = base.filter(isTorrentioExactExternalCandidate).length;
    const candidates = list
        .filter((item) => shouldProtectTorrentioExactSeriesCandidate(item, meta, type, langMode))
        .sort((a, b) => getExternalGuardScore(b) - getExternalGuardScore(a));

    const acceptAll = shouldAcceptAllTorrentioExact(config, 'torrentioExactSeriesMin');
    const wantedCount = acceptAll
        ? Math.min(TORRENTIO_EXACT_ACCEPT_MAX, candidates.length)
        : Math.max(0, minWanted - currentTorrentio);

    if (wantedCount <= 0) return base;

    const additions = [];
    for (const item of candidates) {
        const key = getTorrentioTrustDedupeKey(item);
        if (!key || seen.has(key)) continue;
        seen.add(key);
        additions.push(markTorrentioLooseItForceKeep(item, meta, type));
        if (additions.length >= wantedCount) break;
    }

    if (additions.length > 0) {
        logger.info(`[EXTERNAL GUARD] Torrentio exact-id IT force-keep series | kept=${currentTorrentio} added=${additions.length} candidates=${candidates.length} mode=${acceptAll ? 'all' : 'minimum'} target=${acceptAll ? TORRENTIO_EXACT_ACCEPT_MAX : minWanted}`);
    } else if (list.filter(isTorrentioExactExternalCandidate).length > base.filter(isTorrentioExactExternalCandidate).length && currentTorrentio < minWanted) {
        const exactTotal = list.filter(isTorrentioExactExternalCandidate).length;
        const langRejected = list.filter((item) => isTorrentioExactExternalCandidate(item) && langMode === 'ita' && !isExternalStrictItalianCandidate(item)).length;
        logger.info(`[EXTERNAL GUARD] Torrentio exact-id IT force-keep series | kept=${currentTorrentio} added=0 candidates=${exactTotal} langRejected=${langRejected}`);
    }

    return additions.length > 0 ? [...base, ...additions] : base;
}

function protectTorrentioExactMinimum(items = [], aggressiveFilter, { meta = {}, type = 'movie', langMode = 'ita', config = {} } = {}) {
    const isSeries = String(type || '').toLowerCase() === 'series' || meta?.isSeries || Number(meta?.season || 0) > 0 || Number(meta?.episode || 0) > 0;
    if (isSeries) return protectTorrentioExactSeriesMinimum(items, aggressiveFilter, { meta, type, langMode, config });
    return protectTorrentioExactMovieMinimum(items, aggressiveFilter, { meta, type, langMode, config });
}

function protectTorrentioExactMovieMinimum(items = [], aggressiveFilter, { meta = {}, type = 'movie', langMode = 'ita', config = {} } = {}) {
    const list = Array.isArray(items) ? items : [];
    const base = list.filter(aggressiveFilter);
    const minWanted = getTorrentioExactMovieGuardMin(config);
    if (String(type || '').toLowerCase() === 'series' || meta?.isSeries) return base;

    const seen = new Set(base.map(getTorrentioTrustDedupeKey).filter(Boolean));
    const currentTorrentio = base.filter(isTorrentioExactExternalCandidate).length;
    const candidates = list
        .filter((item) => shouldProtectTorrentioExactMovieCandidate(item, meta, type, langMode))
        .sort((a, b) => getExternalGuardScore(b) - getExternalGuardScore(a));

    const acceptAll = shouldAcceptAllTorrentioExact(config, 'torrentioExactMovieMin');
    const wantedCount = acceptAll
        ? Math.min(TORRENTIO_EXACT_ACCEPT_MAX, candidates.length)
        : Math.max(0, minWanted - currentTorrentio);

    if (wantedCount <= 0) return base;

    const additions = [];
    for (const item of candidates) {
        const key = getTorrentioTrustDedupeKey(item);
        if (!key || seen.has(key)) continue;
        seen.add(key);
        additions.push({ ...item, _torrentioExactGuard: true, _torrentioLooseItForceKeep: true });
        if (additions.length >= wantedCount) break;
    }

    if (additions.length > 0) {
        logger.info(`[EXTERNAL GUARD] Torrentio exact-id IT force-keep movie | kept=${currentTorrentio} added=${additions.length} candidates=${candidates.length} mode=${acceptAll ? 'all' : 'minimum'} target=${acceptAll ? TORRENTIO_EXACT_ACCEPT_MAX : minWanted}`);
    }

    return additions.length > 0 ? [...base, ...additions] : base;
}

async function fetchExternalResults(type, requestId, config, meta = {}, langMode = 'ita') {
    const requestIds = [...new Set((Array.isArray(requestId) ? requestId : [requestId]).map((id) => String(id || '').trim()).filter(Boolean))];
    if (requestIds.length === 0) return [];
    logger.info(`[EXTERNAL] Start Parallel Fetch ids=${requestIds.join(',')}`);

    const onlyItalian = langMode === 'ita';
    const normalizeBatch = (settled, label) => {
        const mapped = [];
        for (const result of settled) {
            const value = result.status === 'fulfilled' ? result.value : { id: 'unknown', items: [], error: result.reason };
            if (value.error) logger.info(`[EXTERNAL] ${label} id=${value.id} failed: ${value.error?.message || value.error}`);
            logger.info(`[EXTERNAL] ${label} id=${value.id} raw=${value.items.length}`);
            mapped.push(...value.items
                .map((item) => normalizeExternalCandidateForPipeline({
                    ...item,
                    _externalRequestId: value.id,
                    _externalIdMatched: true,
                    _externalBatch: label
                }, { type, meta, langMode, config }))
                .filter(Boolean));
        }
        const deduped = dedupeExternalCandidates(mapped);
        if (getNormalizedDebridService(config) === 'rd') {
            const authority = deduped.filter(isTorrentioRdAuthorityCandidate);
            if (authority.length > 0) {
                const direct = authority.filter((item) => item?._torrentioRdDirect === true || getTorrentioPassthroughUrl(item) || getExternalDirectUrl(item)).length;
                const passthrough = authority.filter((item) => getTorrentioPassthroughUrl(item)).length;
                const marker = authority.length - direct;
                logger.info(`[TORRENTIO RD AUTH] trusted cached imported=${authority.length} direct=${direct} passthrough=${passthrough} marker=${marker} batch=${label}`);
            }
        }
        return deduped;
    };

    const runBatch = (enabledAddons, label, idsForBatch = requestIds) => {
        const batchIds = [...new Set((Array.isArray(idsForBatch) ? idsForBatch : [idsForBatch]).map((id) => String(id || '').trim()).filter(Boolean))];
        const tasks = batchIds.map((id) => fetchExternalAddonsFlat(type, id, {
            userConfig: config,
            onlyItalian,
            languageMode: langMode,
            enabledAddons,
            meteorLimit: 2
        })
            .then((items) => ({ id, items: Array.isArray(items) ? items : [] }))
            .catch((error) => ({ id, items: [], error })));
        return Promise.allSettled(tasks).then((settled) => normalizeBatch(settled, label));
    };

    const selectMeteorRequestIds = () => {
        const maxIds = Math.max(1, Math.min(2, Number(process.env.METEOR_REQUEST_ID_LIMIT || 1) || 1));
        const imdbIds = requestIds.filter((id) => /^tt\d+(?::\d+:\d+)?$/i.test(id));
        const nonTmdbIds = requestIds.filter((id) => !/^tmdb:/i.test(id));
        return [...new Set([...imdbIds, ...nonTmdbIds, ...requestIds])].slice(0, maxIds);
    };

    const meteorRequestIds = selectMeteorRequestIds();
    const meteorSupplementLimit = Math.max(1, Math.min(2, Number(process.env.METEOR_SUPPLEMENT_LIMIT || 2) || 2));
    const meteorSupplementTimeout = Math.max(700, Math.min(
        Math.max(CONFIG.TIMEOUTS.EXTERNAL || 0, 2500),
        Number(process.env.EXT_METEOR_SUPPLEMENT_TIMEOUT || 1800) || 1800
    ));
    const meteorJoinTimeout = Math.max(250, Math.min(
        meteorSupplementTimeout,
        Number(process.env.EXT_METEOR_FAST_JOIN_TIMEOUT || 900) || 900
    ));

    const pickMeteorSupplement = (items = [], base = []) => {
        const existing = new Set((Array.isArray(base) ? base : []).map((item) => `${String(item.hash || item.infoHash || '').toLowerCase()}:${Number.isInteger(item.fileIdx) ? item.fileIdx : -1}`));
        return dedupeExternalCandidates(Array.isArray(items) ? items : [])
            .filter((item) => {
                if (!item || item.externalAddon !== 'meteor') return false;
                const key = `${String(item.hash || item.infoHash || '').toLowerCase()}:${Number.isInteger(item.fileIdx) ? item.fileIdx : -1}`;
                return key !== ':-1' && !existing.has(key);
            })
            .sort((a, b) => {
                const aScore = (a.cached_rd === true ? 100000 : 0) + Number(a.seeders || 0) + Number(a.sizeBytes || 0) / 1e12;
                const bScore = (b.cached_rd === true ? 100000 : 0) + Number(b.seeders || 0) + Number(b.sizeBytes || 0) / 1e12;
                return bScore - aScore;
            })
            .slice(0, meteorSupplementLimit);
    };

    try {
        const meteorSupplementPromise = meteorRequestIds.length === 0
            ? Promise.resolve([])
            : withTimeout(
                runBatch(['meteor'], 'Meteor', meteorRequestIds),
                meteorSupplementTimeout,
                'Meteor External Supplement'
            ).catch((error) => {
                logger.info(`[EXTERNAL] Meteor supplement skipped: ${error?.message || error}`);
                return [];
            });

        const readMeteorForSupplement = (stageLabel) => withTimeout(
            meteorSupplementPromise,
            meteorJoinTimeout,
            'Meteor Supplement Fast Join'
        ).catch((error) => {
            logger.info(`[EXTERNAL] Meteor supplement ${stageLabel} fast skip after ${meteorJoinTimeout}ms: ${error?.message || error}`);
            return [];
        });

        const withMeteorSupplement = async (baseResults, stageLabel) => {
            const base = Array.isArray(baseResults) ? baseResults : [];
            const meteorRaw = await readMeteorForSupplement(stageLabel);
            const meteorPicked = pickMeteorSupplement(meteorRaw, base);
            if (meteorPicked.length > 0) {
                const merged = dedupeExternalCandidates([...base, ...meteorPicked]);
                logger.info(`[EXTERNAL] Meteor supplement ${stageLabel} +${meteorPicked.length}/${meteorRaw.length} -> total=${merged.length}`);
                return merged;
            }
            logger.info(`[EXTERNAL] Meteor supplement ${stageLabel} +0/${Array.isArray(meteorRaw) ? meteorRaw.length : 0}`);
            return base;
        };

        const torrentioResults = await withTimeout(
            runBatch(['torrentio_main', 'torrentio_mirror'], 'Torrentio'),
            Math.max(CONFIG.TIMEOUTS.EXTERNAL, 4500),
            'Torrentio External Addons'
        );

        if (torrentioResults.length > 0) {
            logger.info(`[EXTERNAL] Torrentio aggregate=${torrentioResults.length} ids=${requestIds.length} -> MediaFusion SKIP`);
            const supplemented = await withMeteorSupplement(torrentioResults, 'with Torrentio');
            logger.info(`[EXTERNAL] Trovati ${supplemented.length} risultati ids=${requestIds.length}`);
            return supplemented;
        }

        logger.info(`[EXTERNAL] Torrentio aggregate=0 ids=${requestIds.length} -> MediaFusion RUN`);
        const mediaFusionResults = await withTimeout(
            runBatch(['mediafusion'], 'MediaFusion'),
            Math.max(CONFIG.TIMEOUTS.EXTERNAL, 4500),
            'MediaFusion External Addons'
        );

        if (mediaFusionResults.length > 0) {
            const supplemented = await withMeteorSupplement(mediaFusionResults, 'with MediaFusion');
            logger.info(`[EXTERNAL] Trovati ${supplemented.length} risultati ids=${requestIds.length}`);
            return supplemented;
        }

        logger.info(`[EXTERNAL] MediaFusion aggregate=0 ids=${requestIds.length} -> Meteor ONLY`);
        const meteorResults = await meteorSupplementPromise;

        if (meteorResults.length > 0) {
            const meteorPicked = pickMeteorSupplement(meteorResults, []);
            logger.info(`[EXTERNAL] Meteor only ${meteorPicked.length}/${meteorResults.length}`);
            logger.info(`[EXTERNAL] Trovati ${meteorPicked.length} risultati ids=${requestIds.length}`);
            return meteorPicked;
        }

        logger.info(`[EXTERNAL] Nessun risultato trovato ids=${requestIds.length}`);
        return [];
    } catch (err) {
        logger.warn('External Addons fallito/timeout', { error: err.message });
        return [];
    }
}

async function fetchExternalSnapshotResults(meta = {}, type = 'movie', langMode = 'ita', config = {}) {
    if (!dbHelper || typeof dbHelper.getExternalStreamSnapshots !== 'function' || !meta?.imdb_id) return [];
    try {
        const rows = await dbHelper.getExternalStreamSnapshots(meta, {
            type,
            limit: config?.filters?.externalSnapshotLimit || process.env.EXTERNAL_SNAPSHOT_READ_LIMIT || 80
        });
        const normalized = (Array.isArray(rows) ? rows : [])
            .map((item) => normalizeExternalCandidateForPipeline({
                ...item,
                _externalSnapshot: true,
                _fromExternalSnapshot: true,
                _externalIdMatched: item?._externalIdMatched !== false,
                _externalBatch: item?._externalBatch || 'SnapshotDB'
            }, { type, meta, langMode }))
            .filter(Boolean)
            .map((item) => ({
                ...item,
                _externalSnapshot: true,
                _fromExternalSnapshot: true,
                _sourceGroup: item._sourceGroup || 'external_snapshot'
            }));
        if (normalized.length > 0) {
            logger.info(`[EXTERNAL SNAPSHOT] DB hit | imdb=${meta.imdb_id} s=${meta?.season || '-'} e=${meta?.episode || '-'} results=${normalized.length}`);
        }
        return dedupeExternalCandidates(normalized);
    } catch (error) {
        logger.warn(`[EXTERNAL SNAPSHOT] read failed | imdb=${meta?.imdb_id || 'n/a'} | error=${error.message}`);
        return [];
    }
}

async function fetchTitleCandidatePool({ type, finalId, tmdbIdLookup, meta, config, dbOnlyMode, sourceModeFlags = null, torrentPipelineEnabled = true, langMode, aggressiveFilter, userTmdbKey, seedResults = [] }) {
    if (torrentPipelineEnabled !== true) {
        logger.info(`[TORRENT PIPELINE] Skipped title search for ${meta?.title || finalId} (web-only mode)`);
        return [];
    }

    const flags = sourceModeFlags || getSourceModeFlags(config?.filters || {});
    const disableLiveSources = flags.useLiveSources !== true;
    const titleKey = buildTitleSearchPipelineKey(meta, type, langMode, disableLiveSources, {
        ...(config?.filters || {}),
        sourceMode: flags.sourceMode
    });
    const hotCached = getTimedCacheValue(titleSearchHotCache, titleKey);
    if (hotCached) {
        logger.info(`[TITLE-QUEUE] Hot cache hit | key=${titleKey} | results=${hotCached.length}`);
        return hotCached;
    }

    return withSharedPromise(titleSearchInflight, `title_search:${titleKey}`, async () => {
        const cachedAgain = getTimedCacheValue(titleSearchHotCache, titleKey);
        if (cachedAgain) return cachedAgain;

        return scheduleRequestTask('title-search', titleKey, async () => {
            let dynamicTitles = [];
            try {
                if (tmdbIdLookup) dynamicTitles = await getTmdbAltTitles(tmdbIdLookup, type, userTmdbKey);
            } catch (_) {}

            const allowEngScraper = (langMode === 'all' || langMode === 'eng');
            const rawQueries = generateSmartQueries({ ...meta, langMode }, dynamicTitles, langMode);
            const plan = createSearchPlan({ meta, langMode, dbOnlyMode: disableLiveSources, rawQueries });
            const scraperTimeout = langMode === 'eng'
                ? Math.max(CONFIG.TIMEOUTS.SCRAPER || 4000, 12000)
                : langMode === 'all'
                    ? Math.max(CONFIG.TIMEOUTS.SCRAPER || 4000, 10000)
                    : (CONFIG.TIMEOUTS.SCRAPER || 4000);
            const providerCacheOptions = {
                cacheOnly: flags.useProviderCachedOnly === true,
                bypassCache: flags.bypassProviderCache === true,
                emptyTtl: 3600,
                errorTtl: Math.min(300, 3600)
            };

            let cleanResults = [];
            let assessmentPool = Array.isArray(seedResults) ? [...seedResults] : [];
            let lastAssessment = { shouldScrape: true, reason: 'init', strongCount: 0, exactEpisodeCount: 0, seasonPackCount: 0, total: assessmentPool.length };

            for (const phase of plan.phases) {
                incrementMetric(`search.phase.${phase.key}.calls`);

                if (phase.kind === 'fast') {
                    const remoteCacheKey = `${type}:${tmdbIdLookup || finalId}:${meta.season}:${meta.episode}`;
                    const remotePromise = Cache.fetchWithCache('RemoteIndexer', remoteCacheKey, 43200, () =>
                        scheduleRequestTask('provider-fast', `remote:${remoteCacheKey}`, () =>
                            guardedProviderCall(
                                'RemoteIndexer',
                                LIMITERS.remoteIndexer,
                                CONFIG.TIMEOUTS.REMOTE_INDEXER,
                                () => queryRemoteIndexer(tmdbIdLookup, type, meta.season, meta.episode, config, meta),
                                { meta }
                            )
                        , { group: 'provider-fast' })
                    , providerCacheOptions);

                    const externalRequestIds = buildExternalAddonRequestIds(type, finalId, meta);
                    const externalConfigSig = crypto.createHash("sha1").update(JSON.stringify({ service: config?.service || "", rd: config?.rd || config?.realdebrid || "", tb: config?.tb || config?.torbox || "", key: config?.key || "" })).digest("hex").slice(0, 12);
                    const externalCacheKey = `${type}:${externalRequestIds.join(',')}:${langMode}:${externalConfigSig}:torrentioItTrustV16TbDbFirst`;
                    const createExternalPromise = () => disableLiveSources && !flags.useProviderCachedOnly
                        ? Promise.resolve([])
                        : Cache.fetchWithCache('ExternalAddons', externalCacheKey, 43200, () =>
                            scheduleRequestTask('provider-fast', `external:${externalCacheKey}`, () =>
                                guardedProviderCall(
                                    'ExternalAddons',
                                    LIMITERS.externalAddons,
                                    Math.max(CONFIG.TIMEOUTS.EXTERNAL, 4500),
                                    () => fetchExternalResults(type, externalRequestIds, config, meta, langMode),
                                    { meta }
                                )
                            , { group: 'provider-fast' })
                        , providerCacheOptions);

                    let remoteResults = [];
                    let externalResults = [];
                    const isMovieDbPriorityRequest = isMovieTypeForDbPriority(type, meta);

                    if (isMovieDbPriorityRequest) {
                        const remoteSettled = await Promise.allSettled([remotePromise]);
                        remoteResults = (remoteSettled[0]?.status === 'fulfilled' ? remoteSettled[0].value : [])
                            .map((item) => markMovieDbPrimaryCandidate(item, 'remote_db'));
                        const hydratedRemoteForDecision = await hydrateTorrentCandidatesFromLedger(remoteResults, meta, 'remote-pre-external-skip');
                        if (Array.isArray(hydratedRemoteForDecision)) remoteResults = hydratedRemoteForDecision.map((item) => markMovieDbPrimaryCandidate(item, 'remote_db'));

                        const decisionPool = [
                            ...(Array.isArray(seedResults) ? seedResults : []),
                            ...remoteResults
                        ];
                        const verifiedDbCount = countMovieDbVerifiedCandidates(decisionPool);
                        const dbCandidateCount = dedupeByInfoHash(decisionPool, getDedupeContext(meta, { stage: 'external-skip-decision' }))?.results?.length || decisionPool.length;
                        const verifiedMin = getMovieDbVerifiedSkipExternalMin(config?.filters || {}, config?.service);

                        if (shouldBypassMovieExternalLive({
                            verifiedDbCount,
                            dbCandidateCount,
                            filters: config?.filters || {},
                            service: config?.service,
                            flags
                        })) {
                            logger.info(`[EXTERNAL] movie DB verified=${verifiedDbCount} >= ${verifiedMin} dbPool=${dbCandidateCount}/${getMovieDbExternalBypassMinForService(config?.filters || {}, config?.service)} service=${config?.service || 'n/a'} -> skip Torrentio/MediaFusion/Meteor live`);
                            externalResults = [];
                        } else {
                            const externalSettled = await Promise.allSettled([createExternalPromise()]);
                            externalResults = externalSettled[0]?.status === 'fulfilled' ? externalSettled[0].value : [];
                            logger.info(`[EXTERNAL] movie DB verified=${verifiedDbCount}/${verifiedMin} dbPool=${dbCandidateCount}/${getMovieDbExternalBypassMinForService(config?.filters || {}, config?.service)} service=${config?.service || 'n/a'} -> Torrentio/MediaFusion/Meteor live allowed`);
                        }
                    } else {
                        const externalPromise = createExternalPromise();
                        const [remoteSettled, externalSettled] = await Promise.allSettled([remotePromise, externalPromise]);
                        remoteResults = remoteSettled.status === 'fulfilled' ? remoteSettled.value : [];
                        externalResults = externalSettled.status === 'fulfilled' ? externalSettled.value : [];
                    }

                    logger.info(`[STATS] Remote: ${remoteResults.length} | External: ${externalResults.length} ids=${externalRequestIds.join(',')}`);

                    if (!flags.dbOnlyMode && !flags.cacheOnlyMode && externalResults.length > 0) {
                        saveResultsToDbBackground(meta, externalResults, config, type, { invalidateStreamCache: assessmentPool.length === 0 });
                        logger.info(`[AUTO-LEARN] External early-save queued | count=${externalResults.length} ids=${externalRequestIds.join(',')}`);
                    }

                    const fastRemoteResults = filterWithTorrentPackTrust(remoteResults, aggressiveFilter, { meta, type, langMode });
                    const fastExternalResults = protectTorrentioExactMinimum(externalResults, aggressiveFilter, { meta, type, langMode, config });
                    cleanResults = await normalizeCandidateResults([...cleanResults, ...fastRemoteResults, ...fastExternalResults], meta);
                    cleanResults = applyConfiguredTorrentFilters(cleanResults, config.filters || {});
                } else if (phase.kind === 'scrape' && phase.querySubset.length > 0 && flags.useLiveSources) {
                    logger.info(`[SCRAPER PLAN] phase=${phase.key} lang=${langMode} queries=${phase.querySubset.length} timeout=${scraperTimeout}ms | titleKey=${titleKey}`);
                    const scraperNames = sourceHealth.sortNamesByPriority(SCRAPER_MODULES.map((scraper) => scraper?.name || 'ScraperModule'));
                    const sortedScrapers = [...SCRAPER_MODULES].sort((a, b) => {
                        const aIdx = scraperNames.indexOf(a?.name || 'ScraperModule');
                        const bIdx = scraperNames.indexOf(b?.name || 'ScraperModule');
                        return (aIdx === -1 ? 999 : aIdx) - (bIdx === -1 ? 999 : bIdx);
                    });

                    const allScraperTasks = [];
                    phase.querySubset.forEach((q) => sortedScrapers.forEach((scraper) => {
                        if (!scraper.searchMagnet) return;
                        const providerName = scraper.name || 'ScraperModule';
                        const requestScopeKey = `${providerName}:${q}`;
                        allScraperTasks.push(
                            scheduleRequestTask('scrape', requestScopeKey, () =>
                                guardedProviderCall(
                                    providerName,
                                    LIMITERS.scraper,
                                    scraperTimeout,
                                    () => scraper.searchMagnet(q, meta.year, type, buildExternalAddonRequestId(type, finalId, meta), { langMode, allowEng: allowEngScraper, isAnime: isAnimeMetaContext(meta, type) }),
                                    { meta }
                                )
                            , { group: 'scrape' })
                        );
                    }));

                    const scrapedResultsRaw = (await Promise.allSettled(allScraperTasks))
                        .flatMap((result) => result.status === 'fulfilled' ? result.value : []);
                    cleanResults = await normalizeCandidateResults([...cleanResults, ...filterWithTorrentPackTrust(scrapedResultsRaw, aggressiveFilter, { meta, type, langMode })], meta);
                    cleanResults = applyConfiguredTorrentFilters(cleanResults, config.filters || {});
                    logger.info(`[STATS SCRAPER] phase=${phase.key} total=${cleanResults.length} added=${scrapedResultsRaw.length}`);
                }

                assessmentPool = await normalizeCandidateResults(filterWithTorrentPackTrust([...seedResults, ...cleanResults], aggressiveFilter, { meta, type, langMode }), meta);
                assessmentPool = applyConfiguredTorrentFilters(assessmentPool, config.filters || {});
                lastAssessment = assessFastResultQuality(assessmentPool, meta, langMode, config);
                const satisfaction = evaluatePoolSatisfaction(lastAssessment, meta);
                incrementMetric(`search.phase.${phase.key}.results`, cleanResults.length);
                logger.info(`[SEARCH PLAN] phase=${phase.key} total=${lastAssessment.total} strong=${lastAssessment.strongCount} exact=${lastAssessment.exactEpisodeCount} pack=${lastAssessment.seasonPackCount} satisfied=${satisfaction.satisfied} reason=${satisfaction.reason}`);

                if (phase.stopOnSatisfied && satisfaction.satisfied) {
                    incrementMetric(`search.phase.${phase.key}.stopped`);
                    break;
                }
            }

            if (!disableLiveSources && lastAssessment.shouldScrape && cleanResults.length === 0 && plan.broadQueries.length === 0) {
                logger.info(`[SEARCH PLAN] exhausted with no results | reason=${lastAssessment.reason}`);
            }

            return setTimedCacheValue(titleSearchHotCache, titleKey, cleanResults, TITLE_SEARCH_HOT_TTL_MS);
        }, { group: 'title-search' });
    }, boundedSharedPromiseOptions(TITLE_SEARCH_INFLIGHT_MAX_ENTRIES, 'titleSearch.inflight.evicted'));
}

function parseRdViewPageFromId(type, rawId, meta = {}, context = {}) {
  const raw = String(rawId || context?.requestPage?.id || '').replace(/\.json$/i, '').replace(/^ai-recs:/i, '').trim();
  const match = raw.match(/^(kitsu:\d+|tmdb:\d+|tt\d+|\d+)(?::(\d+))?(?::(\d+))?$/i);
  const seasonFromId = match?.[2] ? Number.parseInt(match[2], 10) : null;
  const episodeFromId = match?.[3] ? Number.parseInt(match[3], 10) : null;
  const isKitsuCompact = match && String(match[1] || '').toLowerCase().startsWith('kitsu:') && seasonFromId && !episodeFromId;

  const season = Number.isInteger(seasonFromId) && seasonFromId > 0 && Number.isInteger(episodeFromId) && episodeFromId > 0
      ? seasonFromId
      : (isKitsuCompact ? 1 : (Number(meta?.season || 0) || null));
  const episode = Number.isInteger(episodeFromId) && episodeFromId > 0
      ? episodeFromId
      : (isKitsuCompact ? seasonFromId : (Number(meta?.episode || 0) || null));

  return {
      type: String(type || context?.requestPage?.type || '').toLowerCase() || null,
      id: raw || String(context?.requestPage?.id || '').trim() || null,
      source: context?.requestPage?.source || context?.rdViewScanKind || 'visible_request',
      from: context?.requestPage?.from || null,
      imdb_id: meta?.imdb_id || (/^tt\d+$/i.test(match?.[1] || '') ? match[1] : null),
      tmdb_id: meta?.tmdb_id || (String(match?.[1] || '').toLowerCase().startsWith('tmdb:') ? match[1].split(':')[1] : null),
      kitsu_id: meta?.kitsu_id || (String(match?.[1] || '').toLowerCase().startsWith('kitsu:') ? match[1] : null),
      season,
      episode,
      title: meta?.title || meta?.name || null
  };
}

async function generateStream(type, id, config, userConfStr, reqHost, runtimeContext = {}) {
  const backCompat = applyAnimeUnityKitsuBackCompat(config, id);
  config = backCompat.config;

  const configuredDebridService = getNormalizedDebridService(config);
  const debridApiKey = getConfiguredDebridKey(config, configuredDebridService);
  const hasDebridKey = Boolean(debridApiKey);
  const filters = config?.filters || {};
  const sourceModeFlags = getSourceModeFlags(filters);
  const isWebEnabled = hasWebProvidersEnabled(filters);
  const isP2PEnabled = filters.enableP2P === true;
  const torrentPipelineEnabled = shouldUseTorrentPipeline({
      filters,
      hasDebridKey,
      isP2PEnabled
  });

  if (!hasDebridKey && !isWebEnabled && !isP2PEnabled) return { streams: [{ name: 'CONFIG', title: 'Inserisci API Key, attiva P2P o attiva una sorgente Web' }] };

  const streamCacheVersionParts = [];
  if (torrentPipelineEnabled) streamCacheVersionParts.push('torrentioItPreserve=v24|movieDbPriorityVerifiedSkip=v3|tbDbFirst=v1|rdDirectNoLazy=v2|rdDownloadFallback=v1|torrentioRdNativeConfig=v2|torrentioCoreClean=v1');
  // Bust stale web-provider stream lists generated by the temporary MaxStream
  // .m3u8 route. This prevents Stremio/VLC from receiving old cached
  // /extractor/video.m3u8 URLs after the compatibility rollback.
  if (isWebEnabled) streamCacheVersionParts.push('webProviderMfpRoute=mfpExtractorHeadersV5|cb01DebugHooks=v2|cb01DomainCache=v1|cb01UprotFallbackGuard=v2|uprotRealBootstrap=v5|uprotMseiDecode=v1|uprotAliasCaptcha=v1|uprotMammaMiaManualState=v1');
  const baseHashInput = backCompat.autoAnimeUnity ? `${userConfStr || 'no-conf'}|autoAnimeUnityKitsu=v2` : (userConfStr || 'no-conf');
  const hashInput = streamCacheVersionParts.length > 0 ? `${baseHashInput}|${streamCacheVersionParts.join('|')}` : baseHashInput;
  const configHash = crypto.createHash('md5').update(hashInput).digest('hex');
  const cacheScope = torrentPipelineEnabled ? 'torrent' : 'webonly';
  const cacheKey = `${type}:${id}:${configHash}:${cacheScope}`;
  const inflightKey = `stream:${cacheKey}`;

  if (!sourceModeFlags.liveOnlyMode) {
      const localCachedResult = await Cache.getCachedStream(cacheKey, { allowShared: false });
      if (localCachedResult) return localCachedResult;
  }

  const hadConcurrentInflight = streamInflight.has(inflightKey);
  if (!sourceModeFlags.liveOnlyMode && hadConcurrentInflight) {
      const localStaleResult = await Cache.getStaleStream(cacheKey, { allowShared: false });
      if (localStaleResult) {
          incrementMetric('stream.generate.staleWhileRefresh');
          if (streamInflight.size >= STREAM_STALE_LOAD_THRESHOLD) incrementMetric('stream.generate.staleLoadShield');
          return localStaleResult;
      }
  }

  const namedQueueKey = buildTorrentioStreamRequestKey({ type, id });

  return streamRequestQueue.wrap(namedQueueKey, () => withSharedPromise(streamInflight, inflightKey, async () => {
      if (!sourceModeFlags.liveOnlyMode) {
          const cachedAgain = await Cache.getCachedStream(cacheKey, { allowShared: false });
          if (cachedAgain) return cachedAgain;
      }

      const generationStartedAt = Date.now();
      const trace = createStreamTrace({
          type,
          id,
          sourceMode: sourceModeFlags.sourceMode,
          service: configuredDebridService,
          cacheScope
      }, { logger });
      incrementMetric('stream.generate.calls');

      const userTmdbKey = config.tmdb;
      let finalId = id.replace('ai-recs:', '');

      if (finalId.startsWith('tmdb:')) {
          try {
              const parts = finalId.split(':');
              const imdbId = await tmdbToImdb(parts[1], type, userTmdbKey);
              if (imdbId) finalId = (type === 'series' && parts.length >= 4) ? `${imdbId}:${parts[2]}:${parts[3]}` : imdbId;
          } catch (err) {}
      }

      const meta = await trace.time('metadata', () => LIMITERS.metadata.schedule(() => getMetadata(finalId, type, config)), (value) => ({
          title: value?.title || value?.name || '',
          imdb: value?.imdb_id || '',
          season: value?.season || '',
          episode: value?.episode || ''
      }));
      if (!meta) {
          trace.finish({ streams: 0, error: 'metadata_missing' });
          return { streams: [] };
      }
      if (runtimeContext && typeof runtimeContext === 'object') runtimeContext.generatedMeta = meta;

      const sharedReadContext = buildSharedReadContext(meta);
      if (sourceModeFlags.useSharedCache) {
          const sharedCachedResult = await Cache.getCachedStream(cacheKey, {
              allowLocal: false,
              allowShared: true,
              sharedEntryEvaluator: (row) => shouldUseSharedStreamEntry(row, sharedReadContext, { allowStale: false })
          });
          if (sharedCachedResult) {
              incrementMetric('stream.generate.sharedPolicyHit');
              trace.finish({ streams: sharedCachedResult?.streams?.length || 0, cache: 'shared-hit' });
              return sharedCachedResult;
          }
      }

      if (sourceModeFlags.useSharedCache && hadConcurrentInflight) {
          const sharedStaleResult = await Cache.getStaleStream(cacheKey, {
              allowLocal: false,
              allowShared: true,
              sharedEntryEvaluator: (row) => shouldUseSharedStreamEntry(row, sharedReadContext, { allowStale: true })
          });
          if (sharedStaleResult) {
              incrementMetric('stream.generate.staleWhileRefresh');
              incrementMetric('stream.generate.sharedPolicyStaleHit');
              if (streamInflight.size >= STREAM_STALE_LOAD_THRESHOLD) incrementMetric('stream.generate.staleLoadShield');
              trace.finish({ streams: sharedStaleResult?.streams?.length || 0, cache: 'shared-stale' });
              return sharedStaleResult;
          }
      }

      logger.info(`[SPEED] Start search for: ${meta.title} | sourceMode=${sourceModeFlags.sourceMode}`);

      const tmdbIdLookupPromise = (async () => {
          if (meta.tmdb_id) return meta.tmdb_id;
          if (meta.kitsu_id) return null;
          try {
              return (await imdbToTmdb(meta.imdb_id, userTmdbKey))?.tmdbId || null;
          } catch (_) {
              return null;
          }
      })();
      const dbOnlyMode = sourceModeFlags.dbOnlyMode;
      const langMode = getEffectiveSearchLanguageMode(filters, meta, type);
      const allowItalianWebProviders = langMode !== 'eng';
      const aggressiveFilter = createAggressiveResultFilter(meta, type, langMode);

      const localDbEnabled = sourceModeFlags.useLocalDb && torrentPipelineEnabled;
      const localDbResults = await trace.time('local-db', () => localDbEnabled ? fetchLocalDbResults(meta) : [], (items) => ({
          enabled: localDbEnabled,
          results: Array.isArray(items) ? items.length : 0
      }));
      for (const item of Array.isArray(localDbResults) ? localDbResults : []) {
          if (!item) continue;
          item._localDb = true;
          item._myDb = true;
          item._dbPrimary = true;
          item._sourceGroup = item._sourceGroup || 'local_db';
      }

      const externalSnapshotResults = await trace.time('external-snapshots', () => (
          localDbEnabled && !sourceModeFlags.liveOnlyMode
              ? fetchExternalSnapshotResults(meta, type, langMode, config)
              : []
      ), (items) => ({
          enabled: localDbEnabled && !sourceModeFlags.liveOnlyMode,
          results: Array.isArray(items) ? items.length : 0
      }));
      const dbSeedResults = [...(Array.isArray(localDbResults) ? localDbResults : []), ...(Array.isArray(externalSnapshotResults) ? externalSnapshotResults : [])];
      const isMovieDbPriorityPolicy = isMovieTypeForDbPriority(type, meta);

      let localDbFastPool = [];
      let localDbPrimaryFastPool = [];
      let localDbSatisfaction = { satisfied: false, reason: 'no_db_results' };
      if (dbSeedResults.length > 0) {
          localDbFastPool = applyConfiguredTorrentFilters(
              await normalizeCandidateResults(filterWithTorrentPackTrust(dbSeedResults, aggressiveFilter, { meta, type, langMode }), meta),
              filters
          );
          const torboxDbFirst = configuredDebridService === 'tb' && hasDebridKey;
          localDbPrimaryFastPool = isMovieDbPriorityPolicy && !torboxDbFirst
              ? localDbFastPool.filter(isMovieDbPrimaryCandidate)
              : localDbFastPool;
          const localDbAssessmentPool = isMovieDbPriorityPolicy && !torboxDbFirst ? localDbPrimaryFastPool : localDbFastPool;
          const localDbAssessment = assessFastResultQuality(localDbAssessmentPool, meta, langMode, config);
          localDbSatisfaction = evaluatePoolSatisfaction(localDbAssessment, meta);
          const localVerified = isMovieDbPriorityPolicy ? countMovieDbVerifiedCandidates(localDbPrimaryFastPool) : 0;
          logger.info(`[DB READ] Trovati ${localDbFastPool.length}/${dbSeedResults.length} torrent/snapshot dal DB locale | torrents=${localDbResults.length} snapshots=${externalSnapshotResults.length} primary=${localDbPrimaryFastPool.length} verified=${localVerified} satisfied=${localDbSatisfaction.satisfied} reason=${localDbSatisfaction.reason}`);
          if (isMovieDbPriorityPolicy && localDbPrimaryFastPool.length === 0 && externalSnapshotResults.length > 0) {
              logger.info(`[DB FAST-PATH] movie snapshot-only ignored | snapshots=${externalSnapshotResults.length} -> Remote/Torrentio live required`);
          }
      }

      const allowSeriesDbFastPath = !meta?.isSeries || shouldAllowSeriesDbFastPath(filters, configuredDebridService);
      const torboxDbFirst = configuredDebridService === 'tb' && hasDebridKey;
      const fastPathPool = isMovieDbPriorityPolicy && !torboxDbFirst ? localDbPrimaryFastPool : localDbFastPool;
      const movieVerifiedEnoughForFastPath = !isMovieDbPriorityPolicy || hasEnoughMovieVerifiedDbResults(fastPathPool, filters, configuredDebridService);
      const useLocalDbFastPath = fastPathPool.length > 0 && localDbSatisfaction.satisfied && movieVerifiedEnoughForFastPath && !sourceModeFlags.liveOnlyMode && allowSeriesDbFastPath;
      if (useLocalDbFastPath) {
          logger.info(`[DB FAST-PATH] Uso DB proprietario verificato, skip Remote/Torrentio/External | results=${fastPathPool.length} verified=${countMovieDbVerifiedCandidates(fastPathPool)} allDbRows=${localDbFastPool.length} reason=${localDbSatisfaction.reason}`);
      } else if (isMovieDbPriorityPolicy && fastPathPool.length > 0 && localDbSatisfaction.satisfied) {
          logger.info(`[DB FAST-PATH] movie DB primary non abbastanza verificato | primary=${fastPathPool.length} verified=${countMovieDbVerifiedCandidates(fastPathPool)}/${getMovieDbVerifiedSkipExternalMin(filters, configuredDebridService)} -> Remote/Torrentio consentiti`);
      } else if (meta?.isSeries && localDbFastPool.length > 0 && localDbSatisfaction.satisfied) {
          logger.info(`[DB FAST-PATH] serie: skip disattivato, provo prima gruppi network/Torrentio | dbResults=${localDbFastPool.length} reason=${localDbSatisfaction.reason}`);
      }

      const shouldFetchNetworkResults = torrentPipelineEnabled && !useLocalDbFastPath;
      const tmdbIdLookup = await tmdbIdLookupPromise;
      let networkResults = await trace.time('network-candidates', () => shouldFetchNetworkResults
          ? fetchTitleCandidatePool({
              type,
              finalId,
              tmdbIdLookup,
              meta,
              config,
              dbOnlyMode,
              sourceModeFlags,
              torrentPipelineEnabled,
              langMode,
              aggressiveFilter,
              userTmdbKey,
              seedResults: localDbFastPool.length > 0 ? localDbFastPool : dbSeedResults
          })
          : [], (items) => ({
              enabled: shouldFetchNetworkResults,
              results: Array.isArray(items) ? items.length : 0
          }));
      networkResults = await trace.time('torrent-ledger-hydrate', () => hydrateTorrentCandidatesFromLedger(networkResults, meta, 'network'), (items) => ({
          results: Array.isArray(items) ? items.length : 0
      }));

      let cleanResults = [];
      let rankedList = [];
      if (torrentPipelineEnabled) {
          const dbMergePool = localDbFastPool.length > 0 ? localDbFastPool : dbSeedResults;
          const groupedMergePool = useLocalDbFastPath
              ? fastPathPool
              : buildGroupedFallbackCandidatePool({
                  localDbPool: dbMergePool,
                  networkResults,
                  meta,
                  langMode,
                  config,
                  filters
              });
          cleanResults = useLocalDbFastPath
              ? fastPathPool
              : await normalizeCandidateResults(filterWithTorrentPackTrust(groupedMergePool, aggressiveFilter, { meta, type, langMode }), meta);
          cleanResults = runFilterStage(cleanResults, meta, filters, {
              applyPackKnowledge,
              applyConfiguredTorrentFilters
          });
          trace.stage('torrent-filter', {
              db: localDbResults.length,
              snapshots: externalSnapshotResults.length,
              network: networkResults.length,
              pool: groupedMergePool.length,
              results: cleanResults.length,
              fastPath: useLocalDbFastPath
          });

          const seedHealthPass = applySeedHealthRanking(cleanResults);
          for (const line of getSeedHealthLogSamples(cleanResults, 3)) logger.info(line);
          if (seedHealthPass.stats.total > 0) {
              logger.info(`[RANK] seedHealth summary healthy=${seedHealthPass.stats.healthy} weak=${seedHealthPass.stats.weak} dead=${seedHealthPass.stats.dead} unknown=${seedHealthPass.stats.unknown} protected=${seedHealthPass.stats.protected} kept=${seedHealthPass.stats.kept}/${seedHealthPass.stats.total} strict=${seedHealthPass.stats.strict} dropped=${seedHealthPass.stats.dropped}`);
          }
          cleanResults = seedHealthPass.results;
          trace.stage('seed-health', {
              in: seedHealthPass.stats.total,
              kept: seedHealthPass.stats.kept,
              dropped: seedHealthPass.stats.dropped,
              healthy: seedHealthPass.stats.healthy,
              weak: seedHealthPass.stats.weak,
              dead: seedHealthPass.stats.dead
          });
          logger.info(`[TORRENT PIPELINE] Pool finale filtrato: ${cleanResults.length} risultati.`);

          if (!sourceModeFlags.dbOnlyMode && !sourceModeFlags.cacheOnlyMode && networkResults.length > 0) saveResultsToDbBackground(meta, cleanResults, config, type, { invalidateStreamCache: localDbResults.length === 0 });

          rankedList = runSortStage(cleanResults, meta, config, {
              rankAndFilterResults,
              rerankCompositeResults,
              applyPremiumRankingPolicy,
              filterByQualityLimit
          });

          rankedList = await reprioritizeRdRankedList(rankedList, meta, config, hasDebridKey);
          rankedList = applyPremiumRankingPolicy(rankedList, meta, config);
          rankedList = applySootioPriorityPolicy(rankedList, meta, config);
          const beforeInfoHashDedupe = rankedList;
          const infoHashRankDedupe = dedupeByInfoHash(rankedList, getDedupeContext(meta, { stage: 'ranked' }));
          if (infoHashRankDedupe.removed > 0) {
              logger.info(`[DEDUPE INFOHASH] ranked removed=${infoHashRankDedupe.removed} kept=${infoHashRankDedupe.results.length} title="${String(meta?.title || '').slice(0, 80)}" s=${meta?.season || '-'} e=${meta?.episode || '-'}`);
          }
          rankedList = preserveRdStatusList(beforeInfoHashDedupe, infoHashRankDedupe.results, { logger, stage: 'ranked-dedupe' });
          const movieDbPrimaryCoveragePool = [
              ...(localDbFastPool.length > 0 ? localDbFastPool : dbSeedResults),
              ...(Array.isArray(networkResults) ? networkResults.filter(isMovieDbPrimaryCandidate) : [])
          ];
          rankedList = preserveMovieLocalDbCoverage(rankedList, movieDbPrimaryCoveragePool, meta, filters, config);
          trace.stage('ranked-dedupe', {
              in: beforeInfoHashDedupe.length,
              kept: rankedList.length,
              removed: infoHashRankDedupe.removed,
              groups: infoHashRankDedupe.groups
          });
          if (filters.maxPerQuality) rankedList = preserveRdStatusList(rankedList, filterByQualityLimit(rankedList, filters.maxPerQuality), { logger, stage: 'max-per-quality' });
          if (configuredDebridService === 'rd' && hasDebridKey && typeof applyRdDisplayPriority === 'function') {
              const beforeRdDisplayPriority = rankedList;
              const rdPriorityConfig = shouldEnforceRdPlayableOnly(filters)
                  ? {
                      ...config,
                      filters: {
                          ...(config?.filters || {}),
                          ...filters,
                          // In playable-only mode every candidate is preflighted with RD before it is shown.
                          // Therefore we should not hide DB/snapshot/download/unknown rows too early: try them,
                          // keep only the ones that resolve to a real playable RD link.
                          rdHideDubiousWhenSafe: false
                      }
                  }
                  : config;
              rankedList = preserveRdStatusList(beforeRdDisplayPriority, applyRdDisplayPriority(rankedList, rdPriorityConfig, meta), { logger, stage: 'rd-display-priority' });
          }

          if (configuredDebridService === 'tb' && hasDebridKey) {
              const beforeTorboxResolve = rankedList;
              rankedList = preserveRdStatusList(beforeTorboxResolve, await resolveTorboxRankedList(rankedList, debridApiKey), { logger, stage: 'tb-resolve' });
          }

          rankedList = preserveRdStatusList(rankedList, applyResolutionOrderingGuard(rankedList, { logger, meta, sortMode: getConfiguredSortMode(config) }), { logger, stage: 'resolution-guard' });
      } else {
          logger.info(`[TORRENT PIPELINE] Disabled for ${meta.title} (solo provider web attivi, nessuna key debrid e P2P off)`);
      }

      const rdPlayableOnlyForFinalRanked = configuredDebridService === 'rd' && hasDebridKey && shouldEnforceRdPlayableOnly(filters);
      const finalRankedLimit = rdPlayableOnlyForFinalRanked
          ? Math.max(CONFIG.MAX_RESULTS || 12, getRdPlayableDeepDbScanLimit(filters, rankedList.length))
          : CONFIG.MAX_RESULTS;
      const finalRanked = rankedList.slice(0, finalRankedLimit);
      if (rdPlayableOnlyForFinalRanked && finalRanked.length > CONFIG.MAX_RESULTS) {
          logger.info(`[RD DEEP DB] playable-only scan window expanded ${CONFIG.MAX_RESULTS}->${finalRanked.length} ranked=${rankedList.length}`);
      }
      let debridStreams = [];
      let p2pStreams = [];
      const debridStageStartedAt = Date.now();

      if (finalRanked.length > 0 && hasDebridKey) {
          const rdPlayableOnly = configuredDebridService === 'rd' && shouldEnforceRdPlayableOnly(filters);
          const rdDirectOnly = configuredDebridService === 'rd' && (rdPlayableOnly || !shouldAllowRdLazyStreams(filters));
          const TOP_LIMIT = rdDirectOnly
              ? getRdDirectResolveLimit(filters, finalRanked.length)
              : Math.max(0, Math.min(10, parseInt(filters?.instantDebridTop ?? process.env.INSTANT_DEBRID_TOP ?? '0', 10) || 0));
          const serviceLimiter = getServiceResolverLimiter(configuredDebridService);
          const resolverConfig = { ...config, service: configuredDebridService, rawConf: userConfStr };
          const showRdDownloadRows = shouldShowRdDownloadToDebrid(filters);
          const showRdUnknownRows = shouldShowRdUnknownRows(filters);
          const rdVisibleRanked = configuredDebridService === 'rd'
              ? (rdPlayableOnly
                  ? finalRanked.filter((item) => !isKnownRdUnavailableCandidate(item))
                  : finalRanked.filter((item) => !shouldHideRdUnreadyCandidate(item, filters)))
              : finalRanked;
          const rdAuthorityRanked = rdDirectOnly
              ? [
                  ...rdVisibleRanked.filter(isTorrentioRdAuthorityCandidate),
                  ...rdVisibleRanked.filter((item) => !isTorrentioRdAuthorityCandidate(item) && !isTorrentioRdDownloadCandidate(item)),
                  ...rdVisibleRanked.filter(isTorrentioRdDownloadCandidate)
              ]
              : rdVisibleRanked;
          if (configuredDebridService === 'rd') {
              const hiddenUnready = finalRanked.length - rdVisibleRanked.length;
              if (hiddenUnready > 0) logger.info(`[RD DISPLAY] hidden download/unknown rows=${hiddenUnready} downloadRows=${showRdDownloadRows} unknownRows=${showRdUnknownRows}`);
          }
          const immediatePool = rdDirectOnly
              ? (rdPlayableOnly
                  ? rdAuthorityRanked.filter((item) => !isKnownRdUnavailableCandidate(item))
                  : rdAuthorityRanked.filter((item) => showRdDownloadRows || !isTorrentioRdDownloadCandidate(item)))
              : rdAuthorityRanked;
          const immediateCandidates = immediatePool.slice(0, TOP_LIMIT);
          const immediatePromises = immediateCandidates.map((item) => {
              const runtimeItem = createRuntimeItem(item, meta);
              return serviceLimiter.schedule(async () => {
                  const stream = await resolveDebridLink(resolverConfig, runtimeItem, filters?.showFake, reqHost, meta);
                  if (rdDirectOnly && !stream) {
                      const hash = String(runtimeItem?.hash || runtimeItem?.infoHash || extractInfoHash(runtimeItem?.magnet || '') || 'n/a');
                      const state = String(runtimeItem?._rdCacheState || runtimeItem?.rdCacheState || runtimeItem?.cacheState || 'unknown');
                      logger.info(`[RD DIRECT] miss hash=${hash.slice(0, 12)} state=${state} fileIdx=${runtimeItem?.fileIdx ?? 'n/a'} title="${String(runtimeItem?.title || '').replace(/[\r\n\t]+/g, ' ').slice(0, 90)}"`);
                  }
                  return stream;
              });
          });
          const lazyCandidates = rdDirectOnly ? [] : rdAuthorityRanked.slice(TOP_LIMIT).map((item) => createRuntimeItem(item, meta));
          const lazyStreams = lazyCandidates
              .map((item) => generateLazyStream(item, resolverConfig, meta, reqHost, userConfStr, true))
              .filter(Boolean);
          const resolvedInstant = (await Promise.allSettled(immediatePromises)).flatMap((result) => result.status === 'fulfilled' && result.value ? [result.value] : []);
          let rdDownloadFallbackStreams = [];
          if (rdDirectOnly && showRdDownloadRows && !rdPlayableOnly) {
              const resolvedHashes = collectExistingTorrentHashes([], resolvedInstant);
              const downloadTarget = getRdDownloadFallbackTarget(filters, CONFIG.MAX_RESULTS || 12);
              const downloadLimit = Math.max(0, downloadTarget - resolvedInstant.length);
              const explicitDownload = rdAuthorityRanked.filter(isTorrentioRdDownloadCandidate);
              const softFallback = rdAuthorityRanked.filter((item) => !isTorrentioRdDownloadCandidate(item));
              rdDownloadFallbackStreams = [...explicitDownload, ...softFallback]
                  .filter((item) => !resolvedHashes.has(String(item?.hash || item?.infoHash || extractInfoHash(item?.magnet) || '').toLowerCase()))
                  .filter((item) => !isKnownRdUnavailableCandidate(item))
                  .slice(0, downloadLimit)
                  .map((item) => generateRdDownloadToDebridStream(item, resolverConfig, meta, reqHost, userConfStr))
                  .filter(Boolean);
          }
          const rdVerifiedDbFallbackStreams = (rdDirectOnly && !rdPlayableOnly)
              ? buildRdVerifiedDbFallbackStreams({
                  finalRanked: rdAuthorityRanked,
                  resolvedInstant,
                  existingStreams: rdDownloadFallbackStreams,
                  rdDirectOnly,
                  filters,
                  resolverConfig,
                  meta,
                  reqHost,
                  userConfStr
              })
              : [];
          if (rdVerifiedDbFallbackStreams.length > 0) {
              logger.info(`[RD DB FALLBACK] verified DB fallback streams=${rdVerifiedDbFallbackStreams.length} reason=rd_direct_fill resolved=${resolvedInstant.length}`);
          }
          debridStreams = rdPlayableOnly
              ? resolvedInstant
              : [...resolvedInstant, ...lazyStreams, ...rdDownloadFallbackStreams, ...rdVerifiedDbFallbackStreams];
          if (rdDirectOnly) {
              const rdAuthorityTotal = finalRanked.filter(isTorrentioRdAuthorityCandidate).length;
              const rdAuthorityAttempted = immediateCandidates.filter(isTorrentioRdAuthorityCandidate).length;
              logger.info(`[RD DIRECT] playableOnly=${rdPlayableOnly} | candidates=${finalRanked.length} visible=${rdVisibleRanked.length} resolvePool=${immediatePool.length} resolved=${resolvedInstant.length} shown=${debridStreams.length} attempted=${immediateCandidates.length}/${TOP_LIMIT} downloadFallback=${rdDownloadFallbackStreams.length} dbVerifiedFallback=${rdVerifiedDbFallbackStreams.length} suppressed=${Math.max(0, rdVisibleRanked.length - immediateCandidates.length)} torrentioAuthority=${rdAuthorityTotal}/${rdAuthorityAttempted}`);
          } else {
              warmupLazyStreamsInBackground(resolverConfig, lazyCandidates, meta);
          }
      } else if (finalRanked.length > 0 && isP2PEnabled) {
          logger.info(`[P2P MODE] Generating direct streams for ${meta.title}`);
          p2pStreams = finalRanked.map((item) => P2P.formatP2PStream(item, config));
          debridStreams = p2pStreams;
      }
      trace.stage('debrid-streams', {
          ranked: finalRanked.length,
          streams: debridStreams.length,
          p2p: p2pStreams.length,
          instantTop: filters?.instantDebridTop ?? process.env.INSTANT_DEBRID_TOP ?? 0
      }, Date.now() - debridStageStartedAt);

      debridStreams = await trace.time('saved-cloud', () => attachSavedCloudStreams({
          debridStreams,
          finalRanked,
          config: { ...config, service: configuredDebridService, rawConf: userConfStr },
          meta,
          type,
          reqHost,
          userConfStr,
          debridApiKey,
          configuredDebridService
      }), (items) => ({ streams: Array.isArray(items) ? items.length : 0 }));

      const rawWebBuckets = await trace.time('web-providers', () => fetchWebProviderBuckets({
          type,
          originalId: id,
          finalId,
          meta,
          config,
          reqHost,
          allowItalianWebProviders,
          dbOnlyMode,
          sourceModeFlags
      }), (buckets) => ({
          buckets: Object.keys(buckets || {}).length,
          streams: Object.values(buckets || {}).reduce((sum, bucket) => sum + (Array.isArray(bucket) ? bucket.length : 0), 0)
      }));

      streamWebDebug('raw web buckets fetched', {
          title: meta?.title || meta?.name || '',
          type,
          id,
          sourceMode: sourceModeFlags?.sourceMode,
          torrentPipelineEnabled,
          isWebEnabled,
          enabled: {
              sc: isStreamingCommunityEnabled(filters),
              ghd: filters.enableGhd === true,
              gs: filters.enableGs === true,
              gstv: filters.enableGstv === true,
              es: filters.enableEs === true,
              cb01: filters.enableCb01 === true,
              aw: filters.enableAnimeWorld === true,
              au: filters.enableAnimeUnity === true,
              as: filters.enableAnimeSaturn === true,
              gf: filters.enableGf === true,
              cc: filters.enableCc === true
          },
          buckets: Object.fromEntries(Object.entries(rawWebBuckets || {}).map(([key, bucket]) => [key, Array.isArray(bucket) ? bucket.length : 0]))
      });

      const formattedWebBuckets = formatWebProviderBuckets(rawWebBuckets, meta, config);
      const webStreams = Object.values(formattedWebBuckets || {}).flatMap((bucket) => Array.isArray(bucket) ? bucket : []);
      const webBucketNames = Object.entries(formattedWebBuckets || {})
          .filter(([, bucket]) => Array.isArray(bucket) && bucket.length > 0)
          .map(([bucketName]) => bucketName);

      streamWebDebug('formatted web buckets', {
          buckets: Object.fromEntries(Object.entries(formattedWebBuckets || {}).map(([key, bucket]) => [key, Array.isArray(bucket) ? bucket.length : 0])),
          activeBuckets: webBucketNames,
          webStreams: webStreams.length
      });

      let finalStreams = mergeFinalStreams(debridStreams, formattedWebBuckets, filters, meta);
      finalStreams = applyConfiguredStreamFilters(finalStreams, filters);
      const infoHashStreamDedupe = dedupeByInfoHash(finalStreams, getDedupeContext(meta, { stage: 'streams' }));
      if (infoHashStreamDedupe.removed > 0) {
          logger.info(`[DEDUPE INFOHASH] stream removed=${infoHashStreamDedupe.removed} kept=${infoHashStreamDedupe.results.length} title="${String(meta?.title || '').slice(0, 80)}" s=${meta?.season || '-'} e=${meta?.episode || '-'}`);
      }
      finalStreams = infoHashStreamDedupe.results;
      finalStreams = applyFinalStreamUserSort(finalStreams, config);
      trace.stage('final-merge', {
          debrid: debridStreams.length,
          web: webStreams.length,
          webBuckets: webBucketNames.length,
          removed: infoHashStreamDedupe.removed,
          streams: finalStreams.length
      });

      const resultObjPlaceholder = { streams: finalStreams };
      const enabledWebProvidersCount = [
          isStreamingCommunityEnabled(filters),
          filters.enableGhd,
          filters.enableGs,
          filters.enableGstv,
          filters.enableEs,
          filters.enableCb01,
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
      const isAnimeUnityKitsuRequest = Boolean(filters.enableAnimeUnity === true && meta?.kitsu_id);
      const emptyAnimeUnityLocalTtl = finalStreams.length === 0 && isAnimeUnityKitsuRequest
          ? Math.min(Math.max(1, Number(cachePolicyBase.localTtl || EMPTY_STREAM_TTL) || EMPTY_STREAM_TTL), 30)
          : cachePolicyBase.localTtl;
      const isGsOnlyWebRequest = cacheScope === 'webonly' && enabledWebProvidersCount === 1 && (filters.enableGs === true || filters.enableGstv === true);
      const emptyGsOnlyLocalTtl = finalStreams.length === 0 && isGsOnlyWebRequest
          ? Math.min(Math.max(1, Number(emptyAnimeUnityLocalTtl || EMPTY_STREAM_TTL) || EMPTY_STREAM_TTL), 5)
          : emptyAnimeUnityLocalTtl;
      const isEurostreamingOnlyWebRequest = cacheScope === 'webonly' && enabledWebProvidersCount === 1 && filters.enableEs === true;
      const emptyEurostreamingOnlyLocalTtl = finalStreams.length === 0 && isEurostreamingOnlyWebRequest
          ? Math.min(Math.max(1, Number(emptyGsOnlyLocalTtl || EMPTY_STREAM_TTL) || EMPTY_STREAM_TTL), 15)
          : emptyGsOnlyLocalTtl;
      const isCb01OnlyWebRequest = cacheScope === 'webonly' && enabledWebProvidersCount === 1 && filters.enableCb01 === true;
      const emptyCb01OnlyLocalTtl = finalStreams.length === 0 && isCb01OnlyWebRequest
          ? Math.min(Math.max(1, Number(emptyEurostreamingOnlyLocalTtl || EMPTY_STREAM_TTL) || EMPTY_STREAM_TTL), 20)
          : emptyEurostreamingOnlyLocalTtl;
      const cachePolicy = buildTorrentioLayeredCachePolicy({
          ...cachePolicyBase,
          allowSharedWrite: sourceModeFlags.useSharedCache ? cachePolicyBase.allowSharedWrite : false,
          sharedTtl: sourceModeFlags.useSharedCache ? cachePolicyBase.sharedTtl : 0,
          localTtl: sourceModeFlags.liveOnlyMode ? 0 : emptyCb01OnlyLocalTtl,
          staleGraceTtl: sourceModeFlags.liveOnlyMode ? 0 : cachePolicyBase.staleGraceTtl
      }, {
          finalStreams,
          torrentPipelineEnabled,
          cacheScope,
          sourceModeFlags
      });

      const clientCache = buildClientCacheMetadata(cachePolicy, finalStreams.length);
      const resultObj = {
          ...resultObjPlaceholder,
          cacheMaxAge: clientCache.cacheMaxAge,
          staleRevalidate: clientCache.staleRevalidate,
          staleError: clientCache.staleError
      };

      if (!sourceModeFlags.liveOnlyMode) {
          await trace.time('cache-write', () => Cache.cacheStream(cacheKey, resultObj, cachePolicy.localTtl || (finalStreams.length > 0 ? 7200 : EMPTY_STREAM_TTL), {
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
          }), {
              localTtl: cachePolicy.localTtl || (finalStreams.length > 0 ? 7200 : EMPTY_STREAM_TTL),
              sharedTtl: cachePolicy.allowSharedWrite ? cachePolicy.sharedTtl : 0,
              shared: cachePolicy.allowSharedWrite === true
          });
      }

      if (configuredDebridService === 'rd' && hasDebridKey && torrentPipelineEnabled && finalRanked.length > 0) {
          try {
              enqueueRdViewScan({
                  items: finalRanked,
                  meta,
                  requestPage: parseRdViewPageFromId(type, id, meta, runtimeContext),
                  priority: runtimeContext?.rdViewScanPriority || 'normal',
                  kind: runtimeContext?.rdViewScanKind || 'visible',
                  config: { ...config, service: configuredDebridService },
                  apiKey: debridApiKey,
                  Cache,
                  logger,
                  getRdAvailabilityState,
                  maxScan: runtimeContext?.rdViewScanKind === 'warmup' ? 8 : 14
              });
          } catch (err) {
              logger.warn(`[RD VIEW SCAN] enqueue failed: ${err.message}`);
          }
      }

      recordDuration('stream.generate.total', Date.now() - generationStartedAt);
      incrementMetric(finalStreams.length > 0 ? 'stream.generate.nonEmpty' : 'stream.generate.empty');
      logger.info(`[CACHE] SAVED: ${cacheKey} (mode=${sourceModeFlags.sourceMode}, local=${cachePolicy.localTtl}s, shared=${cachePolicy.allowSharedWrite ? cachePolicy.sharedTtl : 0}s, bucket=${cachePolicy.freshnessBucket}, confidence=${cachePolicy.confidenceScore}, streams=${finalStreams.length})`);
      trace.finish({
          title: meta?.title || meta?.name || '',
          streams: finalStreams.length,
          ranked: finalRanked.length,
          clean: cleanResults.length,
          web: webStreams.length,
          cache: 'write'
      });

      return resultObj;
  }, boundedSharedPromiseOptions(STREAM_INFLIGHT_MAX_ENTRIES, 'stream.inflight.evicted')));
}

module.exports = {
    generateStream,
    getMetadata,
    resolveDebridLink,
    resolveLazyStreamData,
    RD,
    TB,
    buildExternalAddonRequestIds,
    buildExternalAddonRequestId,
    normalizeExternalCandidateForPipeline,
    getExternalSourceLabel,
    protectTorrentioExactMovieMinimum,
    protectTorrentioExactSeriesMinimum,
    protectTorrentioExactMinimum,
    __private: {
        buildRdVerifiedDbFallbackStreams,
        isRdVerifiedDbFallbackCandidate
    }
};

