const axios = require("axios");
const crypto = require("crypto");

const { fetchExternalAddonsFlat } = require("./nexus-bridge");
const PackResolver = require("./pack_intelligence");
const aioFormatter = require("./lib/pulse_formatter.cjs");
const TbCache = require("../debrid/tb_cache.js");
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
const RD = require("../debrid/realdebrid");
const TB = require("../debrid/torbox");
const dbHelper = require("./storage/db_repository"); 
const { buildMagnet: buildTrackerMagnet } = require("./storage/tracker_registry");
const { createDebridAvailabilityTools } = require("./stream/debrid_availability");
const { createWebProviderTools } = require("./stream/web_providers");
const SavedCloud = require("./stream/debrid_saved_cloud");
const sourceHealth = require("./lib/source_health");
const { createSearchPlan, evaluatePoolSatisfaction } = require("./lib/search_planner");
const { shouldSkipRecentWork } = require('./recent_work');
const { buildSharedStreamCachePolicy, buildSharedReadContext, shouldUseSharedStreamEntry } = require('./lib/shared_stream_policy');
const { getSourceModeFlags, shouldUseTorrentPipeline } = require('./config/source_mode');
const { runFilterStage, runSortStage } = require('./lib/result_stage_pipeline');
const { buildSeriesContext, matchesCandidateTitle } = require('./matching/episode_matcher');
const { dedupeByInfoHash, getFolderSizeBytes: getDedupeFolderSizeBytes } = require('./stream/infohash_deduper');
const { preserveRdStatusList } = require('./stream/rd_status_guard');
const { applyResolutionOrderingGuard } = require('./stream/resolution_ordering_guard');
const { hasFolderSizeSeasonPackSignal } = require('./matching/season_pack_inspector');
const SCRAPER_MODULES = [ require("../providers/engines") ];

const {
  logger, Cache, LIMITERS, CONFIG, REGEX_QUALITY_FILTER, REGEX_SUB_ONLY, REGEX_AUDIO_CONFIRM, REGEX_YEAR, EMPTY_STREAM_TTL, METADATA_CACHE_TTL,
  getLanguageInfo, parseTitleDetails, formatLanguageLabel, isSeasonPack, isGoodShortQueryMatch, chooseBestPackTitle, shouldUpdatePackTitle,
  extractSeasonEpisodeFromFilename, deduplicateResults, filterByQualityLimit, extractInfoHash,
  withTimeout, normalizeSearchText, extractSeeders, extractSize, streamInflight, metadataInflight, withSharedPromise,
  incrementMetric, recordDuration, recordProviderMetric
} = require("./utils");

const { parseKitsuIdentifier } = kitsuHandler;

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

function buildQualityCompatibleBingeGroup({ service, quality, details = {}, infoHash, releaseGroup, language }) {
    const hdr = Array.isArray(details.dynamicRange) && details.dynamicRange.length
        ? details.dynamicRange.join('+')
        : (/hdr|dolby\s*vision|\bdv\b/i.test(String(details.tags || '')) ? 'HDR' : 'SDR');
    const codec = details.videoCodec || details.codec || '';
    const audio = [details.audioCodec || details.audio, details.audioChannels].filter(Boolean).join('-');
    const group = releaseGroup || details.releaseGroup || (infoHash ? `hash-${String(infoHash).slice(0, 12)}` : 'nohash');
    return [
        'Leviathan',
        normalizeBingePart(service, 'svc'),
        normalizeBingePart(quality, 'q'),
        normalizeBingePart(hdr, 'sdr'),
        normalizeBingePart(codec, 'codec'),
        normalizeBingePart(audio, 'audio'),
        normalizeBingePart(language, 'lang'),
        normalizeBingePart(group, 'group')
    ].join('|');
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

function isAnimeMetaContext(meta = {}, type = '') {
    return Boolean(meta?.kitsu_id || meta?.isAnime || String(type || '').toLowerCase() === 'anime');
}

function getEpisodeParseOptions(meta = {}, type = '') {
    return { anime: isAnimeMetaContext(meta, type) };
}

function getEffectiveSearchLanguageMode(filters = {}, meta = {}, type = '') {
    const explicit = String(filters?.language || '').toLowerCase();
    if (explicit === 'ita' || explicit === 'eng' || explicit === 'all') return explicit;

    const metaMode = String(meta?.langMode || meta?.languageMode || meta?.language || '').toLowerCase();
    if (metaMode === 'ita' || metaMode === 'eng' || metaMode === 'all') return metaMode;

    if (filters?.allowEng) return 'all';
    return 'ita';
}

function hasExplicitSeasonMarker(text = '') {
    return /\b(?:S(?:EASON)?\s*0?\d{1,2}|\d{1,2}x\d{1,3}|STAGIONE\s*0?\d{1,2}|(?:1ST|2ND|3RD|4TH)\s+SEASON)\b/i.test(String(text || ''));
}

function shouldIgnoreAnimeSeason(meta = {}, type = '', title = '') {
    return isAnimeMetaContext(meta, type) && !hasExplicitSeasonMarker(title);
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

    // AIOStreams-style pack signal: if folderSize is much larger than the selected
    // video file size, this is a multi-file/season-pack even when the visible title
    // looks like a single episode. This is important for correct fileIdx handling.
    if (hasFolderSizeSeasonPackSignal(item)) return true;

    if (isExactRequestedEpisodeItem(item, meta, type)) return false;

    const hasFlag = Boolean(item?._isPack || item?.potentialPack || item?.packTitle || isSeasonPack(item?.title || ''));
    if (!hasFlag && !hasStrictSeasonPackCue(item, meta, type)) return false;
    return hasStrictSeasonPackCue(item, meta, type);
}

function mapKitsuEpisodePosition(parsedKitsu, fallbackKitsuMeta) {
    const requestedEpisode = Number(parsedKitsu?.episode || 0) || 0;
    const mappedSeason = Number(fallbackKitsuMeta?.season || parsedKitsu?.season || 1) || 1;
    const baseEpisode = Number(fallbackKitsuMeta?.episode || 1) || 1;

    if (!(requestedEpisode > 0)) {
        return {
            mappedSeason,
            mappedEpisode: 0,
            requestedEpisode: 0
        };
    }

    return {
        mappedSeason,
        mappedEpisode: baseEpisode + requestedEpisode - 1,
        requestedEpisode
    };
}

function buildExternalAddonRequestId(type, finalId, meta = {}) {
    const cleanType = String(type || '').toLowerCase() === 'anime' ? 'series' : String(type || '').toLowerCase();
    if (cleanType === 'series' && meta?.imdb_id && Number(meta?.season) > 0 && Number(meta?.episode) > 0) {
        return `${meta.imdb_id}:${Number(meta.season)}:${Number(meta.episode)}`;
    }
    if (cleanType === 'movie' && meta?.imdb_id) return meta.imdb_id;
    if (cleanType === 'series' && String(finalId || '').startsWith('tmdb:') && Number(meta?.season) > 0 && Number(meta?.episode) > 0) {
        return `${String(finalId)}:${Number(meta.season)}:${Number(meta.episode)}`;
    }
    return finalId;
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
    });
}

function getExternalLanguageAudit(item = {}) {
    const info = item?._externalLanguageInfo && typeof item._externalLanguageInfo === 'object'
        ? item._externalLanguageInfo
        : (item?.languageInfo && typeof item.languageInfo === 'object' ? item.languageInfo : {});
    const confidence = Number(item?._externalLanguageConfidence ?? info.confidence ?? 0) || 0;
    const hasItalianAudio = Boolean(item?._externalHasItalianAudio || info.hasAudioItalian);
    const hasItalianSubs = Boolean(item?._externalHasItalianSubs || info.hasSubItalian);
    const hasNegativeLanguage = Boolean(info.hasNegativeLanguage);
    const isItalian = Boolean(item?._externalIsItalian || info.isItalian || hasItalianAudio);
    return { info, confidence, hasItalianAudio, hasItalianSubs, hasNegativeLanguage, isItalian };
}

function isExternalStrictItalianCandidate(item = {}) {
    const audit = getExternalLanguageAudit(item);
    if (audit.hasItalianAudio) return true;
    if (audit.isItalian && audit.confidence >= 20 && !audit.hasNegativeLanguage && !audit.hasItalianSubs) return true;
    return false;
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
    const list = Array.isArray(items) ? items : [];
    if (list.length === 0) {
        return { shouldScrape: true, reason: 'no_fast_results', strongCount: 0, exactEpisodeCount: 0, seasonPackCount: 0, total: 0 };
    }

    const effectiveLangMode = langMode;
    let strongCount = 0;
    let exactEpisodeCount = 0;
    let seasonPackCount = 0;

    for (const item of list) {
        const title = String(item?.title || '');
        const source = String(item?.source || '');
        const sizeBytes = Number(item?._size || item?.sizeBytes || 0);
        const seeders = parseInt(item?.seeders, 10) || 0;
        const parsedFastEpisode = meta?.isSeries ? extractSeasonEpisodeFromFilename(title, meta.season || 1, getEpisodeParseOptions(meta)) : null;
        const isPack = isConfidentSeasonPackItem(item, meta, '');
        const langOk = keepLanguageCandidateForMode(item, meta, effectiveLangMode);
        const hasQualitySignal = /\b(?:2160p|4k|uhd|1080p|fhd|720p|web[-.\s]?dl|blu[-.\s]?ray|remux|hevc|x265|x264)\b/i.test(title);
        const hasWeight = hasQualitySignal || sizeBytes >= (meta?.isSeries ? 250 : 700) * 1024 * 1024 || seeders > 0;

        let exactEpisode = false;
        if (meta?.isSeries) {
            const parsed = parsedFastEpisode;
            exactEpisode = Boolean(parsed && !parsed?.isRange && parsed.episode === meta.episode && (parsed.season === meta.season || meta?.kitsu_id));
            if (exactEpisode) exactEpisodeCount += 1;
            const hasSeasonCue = new RegExp(`(?:s|season|stagione)\\s*0?${meta.season}(?!\\d)`, 'i').test(title);
            if (!exactEpisode && isPack && (hasSeasonCue || Boolean(parsed?.isRange || parsed?.isBatch) || (meta?.kitsu_id && /\b(?:batch|pack|complete|collection|全集|合集)\b/i.test(title)))) seasonPackCount += 1;
        }

        let strength = 0;
        if (langOk) strength += 1;
        if (hasWeight) strength += 1;
        if (!meta?.isSeries || exactEpisode || isPack) strength += 1;
        if (seeders > 0) strength += 1;

        if (strength >= (meta?.isSeries ? 3 : 2)) strongCount += 1;
    }

    const minimumStrong = meta?.isSeries ? 2 : 1;
    const shouldScrape = strongCount < minimumStrong || (meta?.isSeries && exactEpisodeCount === 0 && seasonPackCount === 0);
    const reason = shouldScrape
        ? (list.length === 0
            ? 'no_fast_results'
            : (meta?.isSeries && exactEpisodeCount === 0 && seasonPackCount === 0)
                ? 'no_exact_episode_or_pack'
                : `weak_fast_pool_${strongCount}_of_${minimumStrong}`)
        : 'fast_pool_ok';

    return { shouldScrape, reason, strongCount, exactEpisodeCount, seasonPackCount, total: list.length };
}


function getSeriesDbFallbackLimit(filters = {}) {
    const raw = filters.seriesDbFallbackLimit ?? process.env.SERIES_DB_FALLBACK_LIMIT ?? '10';
    return Math.max(0, Math.min(40, parseInt(raw, 10) || 10));
}

function shouldAllowSeriesDbFastPath(filters = {}) {
    const value = filters.seriesDbFastPath ?? process.env.SERIES_DB_FAST_PATH;
    return String(value || '0') === '1';
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
        return [...dbList, ...networkList];
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
const BACKGROUND_DB_SAVE_DEDUP_MS = Math.max(1000, Math.min(120000, parseInt(process.env.BACKGROUND_DB_SAVE_DEDUP_MS || '15000', 10) || 15000));
const LAZY_WARMUP_LOAD_THRESHOLD = Math.max(1, Math.min(200, parseInt(process.env.LAZY_WARMUP_LOAD_THRESHOLD || '14', 10) || 14));
const TITLE_SEARCH_HOT_TTL_MS = Math.max(5000, Math.min(5 * 60 * 1000, parseInt(process.env.TITLE_SEARCH_HOT_TTL_MS || '45000', 10) || 45000));
const VALIDATED_FILE_SET_TTL_MS = Math.max(30 * 1000, Math.min(60 * 60 * 1000, parseInt(process.env.VALIDATED_FILE_SET_TTL_MS || String(20 * 60 * 1000), 10) || 20 * 60 * 1000));
const TIMED_CACHE_MAX_ENTRIES = Math.max(200, Math.min(10000, parseInt(process.env.TIMED_CACHE_MAX_ENTRIES || '3000', 10) || 3000));
const TIMED_CACHE_SWEEP_INTERVAL_MS = Math.max(1000, Math.min(60 * 1000, parseInt(process.env.TIMED_CACHE_SWEEP_INTERVAL_MS || '5000', 10) || 5000));
const BACKGROUND_DB_SAVE_QUEUE_MAX = Math.max(10, Math.min(1000, parseInt(process.env.BACKGROUND_DB_SAVE_QUEUE_MAX || '120', 10) || 120));
const PACK_RESOLUTION_QUEUE_MAX = Math.max(10, Math.min(1000, parseInt(process.env.PACK_RESOLUTION_QUEUE_MAX || '80', 10) || 80));
const timedCacheSweepState = new Map();

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
    return String(
        config?.ranking?.sortMode ||
        config?.sortMode ||
        config?.sort ||
        config?.filters?.sort ||
        'balanced'
    ).toLowerCase();
}

function applyPremiumRankingPolicy(results, meta, config) {
    const list = Array.isArray(results) ? results : [];

    // If the user explicitly selected resolution/size ordering from index.html,
    // never let the diversity policy pull a lower-resolution/low-bitrate item
    // above stronger matches. Diversity is useful only in balanced mode.
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

function getFinalStreamResolutionTier(stream = {}) {
    const text = getFinalStreamSortText(stream).toLowerCase();
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

    return list
        .map((stream, index) => ({
            stream,
            index,
            cacheTier: getFinalStreamCacheTier(stream),
            resolutionTier: getFinalStreamResolutionTier(stream),
            sizeBytes: parseFinalStreamSizeBytes(stream)
        }))
        .sort((a, b) => {
            if (sortMode === 'resolution') {
                // Modalità scelta dall'utente in index.html: ordine risoluzione rigido.
                // A parità di risoluzione resta sopra lo stream con stato cache migliore.
                const resDelta = b.resolutionTier - a.resolutionTier;
                if (resDelta !== 0) return resDelta;
                if (a.cacheTier !== b.cacheTier) return a.cacheTier - b.cacheTier;
                return a.index - b.index;
            }

            // In balanced/size manteniamo la protezione cache: ⚡ confermati sopra, ⏳ dubbi sotto.
            if (a.cacheTier !== b.cacheTier) return a.cacheTier - b.cacheTier;

            if (sortMode === 'size') {
                const sizeDelta = b.sizeBytes - a.sizeBytes;
                if (sizeDelta !== 0) return sizeDelta;
            }
            return a.index - b.index;
        })
        .map((entry) => entry.stream);
}

function getMetaDbLookupKey(meta) {
    const imdbId = String(meta?.imdb_id || '').trim().toLowerCase();
    if (!/^tt\d+$/.test(imdbId)) return null;
    const season = Number(meta?.season || 0) || 0;
    const episode = Number(meta?.episode || 0) || 0;
    return `${imdbId}:${season}:${episode}`;
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

function applyConfiguredTorrentFilters(items, filters = {}) {
    const list = Array.isArray(items) ? items : [];
    if (!filters || Object.keys(filters).length === 0) return list;
    return applyTorrentResultFilters(list, filters);
}

function applyConfiguredStreamFilters(streams, filters = {}) {
    const list = Array.isArray(streams) ? streams : [];
    if (!filters || Object.keys(filters).length === 0) return list;
    return list.filter(stream => !shouldDropByConfiguredQuality(`${stream?.title || ''} ${stream?.name || ''}`, filters, { treatGenericHdAs720: true }));
}

async function normalizeCandidateResults(items, meta = {}) {
    const trackerPass = enrichTorrentItems(Array.isArray(items) ? items : []);
    if (trackerPass.stats.enriched > 0) {
        logger.info(`[TRACKER] enriched=${trackerPass.stats.enriched}/${trackerPass.stats.total} trackersAdded=${trackerPass.stats.trackersAdded} maxPerMagnet=${trackerPass.stats.maxTrackers}`);
    }

    let normalized = deduplicateResults(trackerPass.results);
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
    const effectiveLangMode = langMode;
    return (item) => {
        if (!item?.magnet && !getExternalDirectUrl(item)) return false;

        const source = String(item.source || '').toLowerCase();
        const title = String(item.title || '');
        const lowerTitle = title.toLowerCase();
        const isPack = isConfidentSeasonPackItem(item, meta, type);

        if (source.includes('comet') || source.includes('stremthru')) return false;

        if (!keepLanguageCandidateForMode(item, meta, effectiveLangMode)) return false;

        const metaYear = parseInt(meta.year, 10);
        if (!Number.isNaN(metaYear)) {
            const fileYearMatch = title.match(REGEX_YEAR);
            if (fileYearMatch && Math.abs(parseInt(fileYearMatch[0], 10) - metaYear) > 1) return false;
        }

        if (!meta.isSeries) {
            const shortQueries = [meta.title, meta.originalTitle]
                .filter(Boolean)
                .map(normalizeSearchText)
                .filter(q => q.length >= 2 && q.length <= 8);
            if (shortQueries.length > 0 && !shortQueries.some(q => isGoodShortQueryMatch(title, q))) return false;
        }

        if (meta.isSeries) {
            if (!passesSeriesEpisodeGuard(item, meta, type)) return false;
            if (!hasStrongSeriesTitleMatch(title, meta)) return false;

            const season = meta.season;
            const episode = meta.episode;
            const parsedEpisode = extractSeasonEpisodeFromFilename(title, season || 1, getEpisodeParseOptions(meta, type));

            if (isAnimeMetaContext(meta, type) && parsedEpisode && !parsedEpisode?.isRange && parsedEpisode.episode === episode && (parsedEpisode.season === season || shouldIgnoreAnimeSeason(meta, type, title))) {
                return true;
            }
            if (isAnimeMetaContext(meta, type) && (isPack || parsedEpisode?.isRange || parsedEpisode?.isBatch)) {
                item._isPack = true;
                return true;
            }

            const wrongSeasonRegex = /(?:s|stagione|season)\s*0?(\d+)(?!\d)/gi;
            let match;
            const ignoreAnimeSeasonCheck = shouldIgnoreAnimeSeason(meta, type, title);
            while ((match = wrongSeasonRegex.exec(lowerTitle)) !== null) {
                if (parseInt(match[1], 10) !== season && !ignoreAnimeSeasonCheck) return false;
            }

            const xMatch = lowerTitle.match(/(\d+)x(\d+)/i);
            if (xMatch) return (parseInt(xMatch[1], 10) === season || ignoreAnimeSeasonCheck) && parseInt(xMatch[2], 10) === episode;

            const hasRightSeason = new RegExp(`(?:s|stagione|season|^)\\s*0?${season}(?!\\d)`, 'i').test(lowerTitle);
            const hasRightEpisode = new RegExp(`(?:e|x|ep|episode|^)\\s*0?${episode}(?!\\d)`, 'i').test(lowerTitle);

            if (hasRightSeason && hasRightEpisode) return true;
            if (hasRightSeason && (isSeasonPack(lowerTitle) || !/(?:e|x|ep|episode)\s*0?\d+/i.test(lowerTitle))) {
                item._isPack = true;
                return true;
            }
            return false;
        }

        if (/\b(?:S\d{2}|SEASON|STAGIONE)\b/i.test(title) || /\b\d{1,2}x\d{1,2}\b/.test(title)) return false;

        const cleanFile = lowerTitle.replace(/[\.\_\-\(\)\[\]]/g, ' ').replace(/\s{2,}/g, ' ').trim();
        const checkMatch = (strToCheck) => {
            if (!strToCheck) return false;
            const searchKeyword = strToCheck.replace(/^(the|a|an|il|lo|la|i|gli|le)\s+/i, '').trim();
            if (searchKeyword === 'rip') return /^(the\s+|il\s+)?rip\b/i.test(cleanFile);
            if (!isGoodShortQueryMatch(cleanFile, searchKeyword)) return false;
            return searchKeyword.length <= 3
                ? new RegExp(`\\b${searchKeyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(cleanFile)
                : cleanFile.includes(searchKeyword);
        };

        if (checkMatch(String(meta.title || '').toLowerCase().replace(/[\.\_\-\(\)\[\]]/g, ' ').replace(/\s{2,}/g, ' ').trim())) return true;
        if (checkMatch(String(meta.title || '').split(/ - |: /)[0].toLowerCase().trim())) return true;
        if (checkMatch(String(meta.originalTitle || '').toLowerCase().trim())) return true;
        if (smartMatch(meta.title, title, meta.isSeries, meta.season, meta.episode)) return true;

        return false;
    };
}

async function resolveTorboxRankedList(rankedList, apiKey) {
    const sourceRanked = Array.isArray(rankedList) ? [...rankedList] : [];
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
            const hash = String(item?.hash || '').toLowerCase();
            const result = cacheResults?.[hash];
            if (result && result.cached === true) {
                item._tbCached = true;
                if (result.file_size) {
                    item._size = result.file_size;
                    item.sizeBytes = result.file_size;
                }
                if (result.file_id !== undefined && result.file_id !== null) item.fileIdx = result.file_id;
                verifiedList.push(item);
            }
        }

        usedWindow = candidates.length;
        if (verifiedList.length >= Math.min(12, CONFIG.MAX_RESULTS) || checkLimit === progressiveWindows[progressiveWindows.length - 1]) break;
    }

    logger.info(`📦 [TB CLEANUP] Finestra usata: ${usedWindow} -> Rimasti: ${verifiedList.length}`);

    const remainingItems = sourceRanked.slice(usedWindow);
    if (remainingItems.length > 0) TbCache.enrichCacheBackground(remainingItems, apiKey, dbHelper);

    return verifiedList;
}

function getServiceDisplayName(service) {
    const normalized = String(service || '').toLowerCase();
    if (normalized === 'rd') return 'realdebrid';
    if (normalized === 'tb') return 'torbox';
    if (normalized === 'web') return 'web';
    return 'p2p';
}

function buildPlayableStream({ service, item, streamUrl, displayTitle, parseTitle, sizeBytes, seeders, config, meta, isLazy = false, isPack = false }) {
    const normalizedService = String(service || '').toLowerCase();
    const isAIOActive = aioFormatter.isAIOStreamsEnabled(config);
    const baseParseTitle = parseTitle || item?.title || displayTitle || '';
    const details = parseTitleDetails(baseParseTitle);
    const languageInfo = getLanguageInfo(baseParseTitle, meta?.title, item?.source, details);
    const quality = details.qualityLabel && details.qualityLabel !== 'Other'
        ? details.qualityLabel
        : detectQualityLabel(baseParseTitle, details.quality || 'SD');
    const serviceLabel = normalizedService === 'tb' ? 'TB' : normalizedService.toUpperCase();
    const availabilityState = getRdAvailabilityState(normalizedService, item, meta);
    const isSavedCloudStream = Boolean(item?.isSavedCloud || item?._savedCloud || item?.savedCloud);
    const formatterSource = item?.source;

    if (isAIOActive) {
        return {
            name: aioFormatter.formatStreamName({ addonName: "Leviathan", service: getServiceDisplayName(normalizedService), cached: availabilityState === 'cached', cacheState: availabilityState, quality, savedCloud: isSavedCloudStream }),
            title: aioFormatter.formatStreamTitle({
                title: displayTitle,
                size: Number(sizeBytes) > 0 ? formatBytes(sizeBytes) : 'Unknown',
                language: formatLanguageLabel(languageInfo, details.languages, getEffectiveLangMode(config, meta)),
                source: formatterSource,
                seeders,
                infoHash: item?.hash,
                techInfo: `🎞️ ${quality} ${details.tags}`.trim(),
                providerLine: undefined,
                sourceIcon: '🔎'
            }),
            url: streamUrl,
            infoHash: item?.hash,
            fileIdx: getResolvedFileIdx(item),
            folderSize: getObservedFolderSizeBytes(item) || undefined,
            behaviorHints: {
                notWebReady: false,
                bingieGroup: buildQualityCompatibleBingeGroup({ service: serviceLabel, quality, details, infoHash: item?.hash, releaseGroup: item?.releaseGroup || item?.group, language: formatLanguageLabel(languageInfo, details.languages, getEffectiveLangMode(config, meta)) }),
                infoHash: item?.hash,
                fileIdx: getResolvedFileIdx(item),
                folderSize: getObservedFolderSizeBytes(item) || undefined,
                filename: item?.episodeFileHint?.fileName || item?._episodeFileHint?.fileName || item?.filename || undefined,
                cacheState: availabilityState,
                rdCacheState: availabilityState
            },
            cacheState: availabilityState,
            rdCacheState: availabilityState
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
        forceMovie: !hasSeriesContext,
        savedCloud: isSavedCloudStream,
        isSavedCloud: isSavedCloudStream,
        savedCloudService: serviceLabel
    };
    const safeIsPack = Boolean(hasSeriesContext && isPack);
    const { name, title, bingeGroup } = formatStreamSelector(parseTitle || item?.title || displayTitle, formatterSource, sizeBytes, seeders, serviceLabel, selectorConfig, item?.hash, isLazy, safeIsPack, availabilityState);
    return {
        name,
        title,
        url: streamUrl,
        infoHash: item?.hash,
        fileIdx: getResolvedFileIdx(item),
        folderSize: getObservedFolderSizeBytes(item) || undefined,
        behaviorHints: {
            notWebReady: false,
            bingieGroup: bingeGroup,
            infoHash: item?.hash,
            fileIdx: getResolvedFileIdx(item),
            folderSize: getObservedFolderSizeBytes(item) || undefined,
            filename: item?.episodeFileHint?.fileName || item?._episodeFileHint?.fileName || item?.filename || undefined,
            cacheState: availabilityState,
            rdCacheState: availabilityState
        },
        cacheState: availabilityState,
        rdCacheState: availabilityState
    };
}

function getLanguageSignals(title, metaTitle, sourceName) {
    return getTitleDiagnostics(title, metaTitle, sourceName);
}

function keepItalianCandidate(title, sourceName, metaTitle) {
    const signals = getLanguageSignals(title, metaTitle, sourceName);

    if ((signals.explicitEng || signals.explicitOther) && !signals.explicitIta) return false;
    if (signals.explicitMulti && !signals.explicitIta) return false;

    if (signals.langInfo.isItalian || (signals.langInfo.confidence || 0) >= 4 || signals.langInfo.isMaybeItalian) {
        return true;
    }

    if (REGEX_SUB_ONLY.test(title) && !REGEX_AUDIO_CONFIRM.test(title)) {
        const strippedTitle = String(title || '').replace(REGEX_SUB_ONLY, ' ');
        const strippedSignals = getLanguageSignals(strippedTitle, metaTitle, sourceName);

        if ((strippedSignals.explicitEng || strippedSignals.explicitOther) && !strippedSignals.explicitIta) return false;
        if (strippedSignals.explicitMulti && !strippedSignals.explicitIta) return false;

        return strippedSignals.langInfo.isItalian
            || (strippedSignals.langInfo.confidence || 0) >= 4
            || strippedSignals.langInfo.isMaybeItalian;
    }

    return false;
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
                    await Cache.cacheLazyLink(lazyCacheKey, streamData, 180);
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

async function resolvePackWithBestEffort(item, config, meta, siblingStreams = []) {
    if (!item || !item.hash) return null;
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
            if (status === 404) logger.info(`[PACK] Resolver miss for ${item.hash}: ${err.message}`);
            else logger.warn(`[PACK] Resolver error for ${item.hash}: ${err.message}`);
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
                        originalLanguage: tmdbData.original_language || null
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
  });
}

function saveResultsToDbBackground(meta, results, config = null, type = null) {
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

                    if (isGuaranteedCachedExternal(item)) {
                        if (!guaranteedSet.has(infoHash)) {
                            guaranteedSet.add(infoHash);
                            guaranteedCachedUpdates.push({
                                hash: infoHash,
                                state: 'cached',
                                cached: true,
                                rd_file_size: Number(item?._size || item?.sizeBytes || 0) > 0 ? Number(item._size || item.sizeBytes) : null,
                                failures: 0,
                                next_hours: 168,
                                permanent: false
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

                if (metaCacheKey && (savedCount > 0 || mappedCount > 0 || processedCount > 0 || guaranteedCachedUpdates.length > 0)) await Cache.invalidateDbTorrents(metaCacheKey, 'db_save');
                resolvePackNamesInBackground(meta, results, config, effectiveType);
            });
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
                streamUrl: directUrl,
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
        if (service === 'rd') streamData = await RD.getStreamLink(apiKey, item.magnet, runtimeItem.season, runtimeItem.episode, item.fileIdx);

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
            streamUrl: streamData.url,
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

function generateLazyStream(item, config, meta, reqHost, userConfStr, isLazy = false) {
    const service = getNormalizedDebridService(config);
    if (!service) return null;
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
            streamUrl: directUrl,
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

    const imdbParam = meta?.imdb_id ? `&imdb=${encodeURIComponent(meta.imdb_id)}` : '';
    const lazyUrl = `${reqHost}/${userConfStr}/play_lazy/${service}/${item.hash}/${(item.fileIdx !== undefined && !isNaN(item.fileIdx)) ? item.fileIdx : -1}?s=${meta.season || 0}&e=${meta.episode || 0}${imdbParam}`;
    const lazyCacheKey = `${service}:${item.hash}:${meta.season || 0}:${meta.episode || 0}:${(item.fileIdx !== undefined && !isNaN(item.fileIdx)) ? item.fileIdx : -1}`;
    Cache.cacheLazyMeta(lazyCacheKey, {
        imdb_id: meta?.imdb_id || null,
        season: meta?.season || 0,
        episode: meta?.episode || 0,
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
            let providerName = (t.provider || 'P2P').replace(/LeviathanDB/i, '').replace(/[()]/g, '').trim() || 'P2P';
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
                fileIdx: t.file_index !== undefined ? parseInt(t.file_index) : undefined,
                _sourceGroup: 'db',
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

async function fetchExternalResults(type, requestId, config, meta = {}, langMode = 'ita') {
    logger.info(`[EXTERNAL] Start Parallel Fetch...`);
    try {
        const onlyItalian = langMode === 'ita';
        const isSeriesQuery = String(type || '').toLowerCase() === 'series' || Boolean(meta?.isSeries || Number(meta?.season || 0) > 0 || Number(meta?.episode || 0) > 0);
        const externalResults = await withTimeout(
            fetchExternalAddonsFlat(type, requestId, { userConfig: config, onlyItalian, languageMode: langMode }).then(items => items.map(i => {
                const rawTitle = i.title || i.filename;
                const title = isSeriesQuery ? rawTitle : stripMoviePackLabel(rawTitle);
                let finalSeeders = parseInt(i.seeders, 10) || (title ? extractSeeders(title) : 0);
                let finalSize = i.mainFileSize || (title ? extractSize(title) : 0);
                const directUrl = getExternalDirectUrl(i);
                const magnetOrDirect = i.magnetLink || directUrl || null;
                const hash = i.infoHash || extractInfoHash(i.magnetLink) || extractInfoHash(directUrl);
                const externalLanguageOk = Boolean(i.isItalian || i.hasItalianAudio || i.languageInfo?.isItalian || i.languageInfo?.hasAudioItalian);
                if (onlyItalian && i.externalAddon === 'torrentio_mirror' && !externalLanguageOk) return null;
                const trustedTorrentioDirect = Boolean(directUrl && i.externalAddon === 'torrentio_mirror' && (!onlyItalian || externalLanguageOk));
                const mediaFusionRdCached = Boolean(
                    (i._mediafusionRdChecked === true || i._nexusBridgeRdChecked === true || i._externalRdChecked === true) &&
                    (i.rdCacheState === 'cached' || i.cacheState === 'cached' || i.cached_rd === true || i._dbCachedRd === true)
                );
                const rdCached = Boolean(mediaFusionRdCached || trustedTorrentioDirect);
                const rdState = rdCached ? 'cached' : 'unknown';
                const rdCachedBool = rdCached ? true : null;
                const externalPack = isConfidentSeasonPackItem({
                    ...i,
                    title,
                    filename: i.filename || i.file_title,
                    packTitle: i.packTitle || '',
                    potentialPack: i.potentialPack
                }, meta, type);
                return {
                    title: title,
                    magnet: magnetOrDirect,
                    directUrl,
                    url: directUrl || null,
                    _externalDirectUrl: directUrl || null,
                    externalDirectUrl: directUrl || null,
                    size: i.size || (finalSize > 0 ? formatBytes(finalSize) : null),
                    sizeBytes: finalSize,
                    folderSize: i.folderSize || i.folder_size || i.behaviorHints?.folderSize || undefined,
                    seeders: finalSeeders,
                    source: i.externalProvider || String(i.source || '').replace(/\[EXT\]\s*/, ''),
                    hash,
                    infoHash: hash,
                    fileIdx: i.fileIdx,
                    episodeFileHint: i.episodeFileHint || i._episodeFileHint || null,
                    _episodeFileHint: i._episodeFileHint || i.episodeFileHint || null,
                    _packValidated: i._packValidated === true,
                    isExternal: true,
                    _sourceGroup: 'external',
                    externalAddon: i.externalAddon || null,
                    externalGroup: i.externalGroup || null,
                    _preferTorrentioSeries: Boolean(isSeriesQuery && (String(i.externalGroup || '').toLowerCase() === 'torrentio' || String(i.externalAddon || '').toLowerCase().startsWith('torrentio'))),
                    _externalLanguageInfo: i.languageInfo || null,
                    _externalIsItalian: Boolean(i.isItalian || i.languageInfo?.isItalian || (trustedTorrentioDirect && externalLanguageOk)),
                    _externalHasItalianAudio: Boolean(i.hasItalianAudio || i.languageInfo?.hasAudioItalian || (trustedTorrentioDirect && externalLanguageOk)),
                    _externalHasItalianSubs: Boolean(i.hasItalianSubs || i.languageInfo?.hasSubItalian),
                    _externalLanguageConfidence: Number(i.languageInfo?.confidence || 0) || (externalLanguageOk ? 95 : 0),
                    potentialPack: Boolean(isSeriesQuery && externalPack),
                    packTitle: (isSeriesQuery && externalPack) ? (i.packTitle || '') : '',
                    _isPack: Boolean(isSeriesQuery && externalPack),
                    _rdCacheState: rdState,
                    rdCacheState: rdState,
                    _dbCachedRd: rdCachedBool,
                    cached_rd: rdCachedBool,
                    _mediafusionRdChecked: Boolean(i._mediafusionRdChecked),
                    _nexusBridgeRdChecked: Boolean(i._nexusBridgeRdChecked || trustedTorrentioDirect),
                    _externalRdChecked: Boolean(i._externalRdChecked || trustedTorrentioDirect)
                };
            }).filter(Boolean)),
            CONFIG.TIMEOUTS.EXTERNAL, 'External Addons'
        );
        if (externalResults && externalResults.length > 0) {
            logger.info(`[EXTERNAL] Trovati ${externalResults.length} risultati`);
            return externalResults;
        } else {
            logger.info(`[EXTERNAL] Nessun risultato trovato.`);
            return [];
        }
    } catch (err) { logger.warn('External Addons fallito/timeout', { error: err.message }); return []; }
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

                    const externalRequestId = buildExternalAddonRequestId(type, finalId, meta);
                    const externalConfigSig = crypto.createHash("sha1").update(JSON.stringify({ service: config?.service || "", rd: config?.rd || config?.realdebrid || "", tb: config?.tb || config?.torbox || "", key: config?.key || "" })).digest("hex").slice(0, 12);
                    const externalCacheKey = `${type}:${externalRequestId}:${langMode}:${externalConfigSig}`;
                    const externalPromise = disableLiveSources && !flags.useProviderCachedOnly
                        ? Promise.resolve([])
                        : Cache.fetchWithCache('ExternalAddons', externalCacheKey, 43200, () =>
                            scheduleRequestTask('provider-fast', `external:${externalCacheKey}`, () =>
                                guardedProviderCall(
                                    'ExternalAddons',
                                    LIMITERS.externalAddons,
                                    CONFIG.TIMEOUTS.EXTERNAL,
                                    () => fetchExternalResults(type, externalRequestId, config, meta, langMode),
                                    { meta }
                                )
                            , { group: 'provider-fast' })
                        , providerCacheOptions);

                    const [remoteSettled, externalSettled] = await Promise.allSettled([remotePromise, externalPromise]);
                    const remoteResults = remoteSettled.status === 'fulfilled' ? remoteSettled.value : [];
                    const externalResults = externalSettled.status === 'fulfilled' ? externalSettled.value : [];
                    logger.info(`[STATS] Remote: ${remoteResults.length} | External: ${externalResults.length}`);

                    cleanResults = await normalizeCandidateResults([...cleanResults, ...remoteResults, ...externalResults].filter(aggressiveFilter), meta);
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
                    cleanResults = await normalizeCandidateResults([...cleanResults, ...scrapedResultsRaw.filter(aggressiveFilter)], meta);
                    cleanResults = applyConfiguredTorrentFilters(cleanResults, config.filters || {});
                    logger.info(`[STATS SCRAPER] phase=${phase.key} total=${cleanResults.length} added=${scrapedResultsRaw.length}`);
                }

                assessmentPool = await normalizeCandidateResults([...seedResults, ...cleanResults].filter(aggressiveFilter), meta);
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
    });
}

async function generateStream(type, id, config, userConfStr, reqHost) {
  const backCompat = applyAnimeUnityKitsuBackCompat(config, id);
  config = backCompat.config;

  const configuredDebridService = getNormalizedDebridService(config);
  const debridApiKey = getConfiguredDebridKey(config, configuredDebridService);
  const hasDebridKey = Boolean(debridApiKey);
  const filters = config?.filters || {};
  const sourceModeFlags = getSourceModeFlags(filters);
  const isWebEnabled = Boolean(filters && (isStreamingCommunityEnabled(filters) || filters.enableGhd || filters.enableGs || filters.enableAnimeWorld || filters.enableAnimeUnity || filters.enableAnimeSaturn || filters.enableGf || filters.enableCc));
  const isP2PEnabled = filters.enableP2P === true;
  const torrentPipelineEnabled = shouldUseTorrentPipeline({
      filters,
      hasDebridKey,
      isP2PEnabled
  });

  if (!hasDebridKey && !isWebEnabled && !isP2PEnabled) return { streams: [{ name: 'CONFIG', title: 'Inserisci API Key, attiva P2P o attiva una sorgente Web' }] };

  const hashInput = backCompat.autoAnimeUnity ? `${userConfStr || 'no-conf'}|autoAnimeUnityKitsu=v2` : (userConfStr || 'no-conf');
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

  return withSharedPromise(streamInflight, inflightKey, async () => {
      if (!sourceModeFlags.liveOnlyMode) {
          const cachedAgain = await Cache.getCachedStream(cacheKey, { allowShared: false });
          if (cachedAgain) return cachedAgain;
      }

      const generationStartedAt = Date.now();
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

      const meta = await LIMITERS.metadata.schedule(() => getMetadata(finalId, type, config));
      if (!meta) return { streams: [] };

      const sharedReadContext = buildSharedReadContext(meta);
      if (sourceModeFlags.useSharedCache) {
          const sharedCachedResult = await Cache.getCachedStream(cacheKey, {
              allowLocal: false,
              allowShared: true,
              sharedEntryEvaluator: (row) => shouldUseSharedStreamEntry(row, sharedReadContext, { allowStale: false })
          });
          if (sharedCachedResult) {
              incrementMetric('stream.generate.sharedPolicyHit');
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
              return sharedStaleResult;
          }
      }

      logger.info(`[SPEED] Start search for: ${meta.title} | sourceMode=${sourceModeFlags.sourceMode}`);

      const tmdbIdLookup = meta.tmdb_id || (meta.kitsu_id ? null : (await imdbToTmdb(meta.imdb_id, userTmdbKey))?.tmdbId);
      const dbOnlyMode = sourceModeFlags.dbOnlyMode;
      const langMode = getEffectiveSearchLanguageMode(filters, meta, type);
      const allowItalianWebProviders = langMode !== 'eng';
      const aggressiveFilter = createAggressiveResultFilter(meta, type, langMode);

      const localDbResults = (sourceModeFlags.useLocalDb && torrentPipelineEnabled) ? await fetchLocalDbResults(meta) : [];
      let localDbFastPool = [];
      let localDbSatisfaction = { satisfied: false, reason: 'no_db_results' };
      if (localDbResults.length > 0) {
          localDbFastPool = applyConfiguredTorrentFilters(
              await normalizeCandidateResults(localDbResults.filter(aggressiveFilter), meta),
              filters
          );
          const localDbAssessment = assessFastResultQuality(localDbFastPool, meta, langMode, config);
          localDbSatisfaction = evaluatePoolSatisfaction(localDbAssessment, meta);
          logger.info(`[DB READ] Trovati ${localDbFastPool.length}/${localDbResults.length} torrent dal DB locale | satisfied=${localDbSatisfaction.satisfied} reason=${localDbSatisfaction.reason}`);
      }

      const allowSeriesDbFastPath = !meta?.isSeries || shouldAllowSeriesDbFastPath(filters);
      const useLocalDbFastPath = localDbFastPool.length > 0 && localDbSatisfaction.satisfied && !sourceModeFlags.liveOnlyMode && allowSeriesDbFastPath;
      if (useLocalDbFastPath) {
          logger.info(`[DB FAST-PATH] Uso DB locale, skip Remote/External | results=${localDbFastPool.length} reason=${localDbSatisfaction.reason}`);
      } else if (meta?.isSeries && localDbFastPool.length > 0 && localDbSatisfaction.satisfied) {
          logger.info(`[DB FAST-PATH] serie: skip disattivato, provo prima gruppi network/Torrentio | dbResults=${localDbFastPool.length} reason=${localDbSatisfaction.reason}`);
      }

      const networkResults = torrentPipelineEnabled && !useLocalDbFastPath
          ? await fetchTitleCandidatePool({
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
              seedResults: localDbFastPool.length > 0 ? localDbFastPool : localDbResults
          })
          : [];

      let cleanResults = [];
      let rankedList = [];
      if (torrentPipelineEnabled) {
          const dbMergePool = localDbFastPool.length > 0 ? localDbFastPool : localDbResults;
          const groupedMergePool = useLocalDbFastPath
              ? localDbFastPool
              : buildGroupedFallbackCandidatePool({
                  localDbPool: dbMergePool,
                  networkResults,
                  meta,
                  langMode,
                  config,
                  filters
              });
          cleanResults = useLocalDbFastPath
              ? localDbFastPool
              : await normalizeCandidateResults(groupedMergePool.filter(aggressiveFilter), meta);
          cleanResults = runFilterStage(cleanResults, meta, filters, {
              applyPackKnowledge,
              applyConfiguredTorrentFilters
          });

          const seedHealthPass = applySeedHealthRanking(cleanResults);
          for (const line of getSeedHealthLogSamples(cleanResults, 3)) logger.info(line);
          if (seedHealthPass.stats.total > 0) {
              logger.info(`[RANK] seedHealth summary healthy=${seedHealthPass.stats.healthy} weak=${seedHealthPass.stats.weak} dead=${seedHealthPass.stats.dead} unknown=${seedHealthPass.stats.unknown} protected=${seedHealthPass.stats.protected} kept=${seedHealthPass.stats.kept}/${seedHealthPass.stats.total} strict=${seedHealthPass.stats.strict} dropped=${seedHealthPass.stats.dropped}`);
          }
          cleanResults = seedHealthPass.results;
          logger.info(`[TORRENT PIPELINE] Pool finale filtrato: ${cleanResults.length} risultati.`);

          if (!sourceModeFlags.dbOnlyMode && !sourceModeFlags.cacheOnlyMode && networkResults.length > 0) saveResultsToDbBackground(meta, cleanResults, config, type);

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
          if (filters.maxPerQuality) rankedList = preserveRdStatusList(rankedList, filterByQualityLimit(rankedList, filters.maxPerQuality), { logger, stage: 'max-per-quality' });
          if (configuredDebridService === 'rd' && hasDebridKey && typeof applyRdDisplayPriority === 'function') {
              const beforeRdDisplayPriority = rankedList;
              rankedList = preserveRdStatusList(beforeRdDisplayPriority, applyRdDisplayPriority(rankedList, config, meta), { logger, stage: 'rd-display-priority' });
          }

          if (configuredDebridService === 'tb' && hasDebridKey) {
              const beforeTorboxResolve = rankedList;
              rankedList = preserveRdStatusList(beforeTorboxResolve, await resolveTorboxRankedList(rankedList, debridApiKey), { logger, stage: 'tb-resolve' });
          }

          rankedList = preserveRdStatusList(rankedList, applyResolutionOrderingGuard(rankedList, { logger, meta, sortMode: getConfiguredSortMode(config) }), { logger, stage: 'resolution-guard' });
      } else {
          logger.info(`[TORRENT PIPELINE] Disabled for ${meta.title} (solo provider web attivi, nessuna key debrid e P2P off)`);
      }

      const finalRanked = rankedList.slice(0, CONFIG.MAX_RESULTS);
      let debridStreams = [];
      let p2pStreams = [];

      if (finalRanked.length > 0 && hasDebridKey) {
          const TOP_LIMIT = Math.max(0, Math.min(10, parseInt(filters?.instantDebridTop ?? process.env.INSTANT_DEBRID_TOP ?? '0', 10) || 0));
          const serviceLimiter = getServiceResolverLimiter(configuredDebridService);
          const resolverConfig = { ...config, service: configuredDebridService, rawConf: userConfStr };
          const immediatePromises = finalRanked.slice(0, TOP_LIMIT).map((item) => {
              const runtimeItem = createRuntimeItem(item, meta);
              return serviceLimiter.schedule(() => resolveDebridLink(resolverConfig, runtimeItem, filters?.showFake, reqHost, meta));
          });
          const lazyCandidates = finalRanked.slice(TOP_LIMIT).map((item) => createRuntimeItem(item, meta));
          const lazyStreams = lazyCandidates
              .map((item) => generateLazyStream(item, resolverConfig, meta, reqHost, userConfStr, true))
              .filter(Boolean);
          const resolvedInstant = (await Promise.allSettled(immediatePromises)).flatMap((result) => result.status === 'fulfilled' && result.value ? [result.value] : []);
          debridStreams = [...resolvedInstant, ...lazyStreams];
          warmupLazyStreamsInBackground(resolverConfig, lazyCandidates, meta);
      } else if (finalRanked.length > 0 && isP2PEnabled) {
          logger.info(`[P2P MODE] Generating direct streams for ${meta.title}`);
          p2pStreams = finalRanked.map((item) => P2P.formatP2PStream(item, config));
          debridStreams = p2pStreams;
      }

      debridStreams = await attachSavedCloudStreams({
          debridStreams,
          finalRanked,
          config: { ...config, service: configuredDebridService, rawConf: userConfStr },
          meta,
          type,
          reqHost,
          userConfStr,
          debridApiKey,
          configuredDebridService
      });

      const rawWebBuckets = await fetchWebProviderBuckets({
          type,
          originalId: id,
          finalId,
          meta,
          config,
          reqHost,
          allowItalianWebProviders,
          dbOnlyMode,
          sourceModeFlags
      });

      const formattedWebBuckets = formatWebProviderBuckets(rawWebBuckets, meta, config);
      const webStreams = Object.values(formattedWebBuckets || {}).flatMap((bucket) => Array.isArray(bucket) ? bucket : []);
      const webBucketNames = Object.entries(formattedWebBuckets || {})
          .filter(([, bucket]) => Array.isArray(bucket) && bucket.length > 0)
          .map(([bucketName]) => bucketName);

      let finalStreams = mergeFinalStreams(debridStreams, formattedWebBuckets, filters, meta);
      finalStreams = applyConfiguredStreamFilters(finalStreams, filters);
      const infoHashStreamDedupe = dedupeByInfoHash(finalStreams, getDedupeContext(meta, { stage: 'streams' }));
      if (infoHashStreamDedupe.removed > 0) {
          logger.info(`[DEDUPE INFOHASH] stream removed=${infoHashStreamDedupe.removed} kept=${infoHashStreamDedupe.results.length} title="${String(meta?.title || '').slice(0, 80)}" s=${meta?.season || '-'} e=${meta?.episode || '-'}`);
      }
      finalStreams = infoHashStreamDedupe.results;
      finalStreams = applyFinalStreamUserSort(finalStreams, config);

      const resultObjPlaceholder = { streams: finalStreams };
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
      const isAnimeUnityKitsuRequest = Boolean(filters.enableAnimeUnity === true && meta?.kitsu_id);
      const emptyAnimeUnityLocalTtl = finalStreams.length === 0 && isAnimeUnityKitsuRequest
          ? Math.min(Math.max(1, Number(cachePolicyBase.localTtl || EMPTY_STREAM_TTL) || EMPTY_STREAM_TTL), 30)
          : cachePolicyBase.localTtl;
      const isGsOnlyWebRequest = cacheScope === 'webonly' && enabledWebProvidersCount === 1 && filters.enableGs === true;
      const emptyGsOnlyLocalTtl = finalStreams.length === 0 && isGsOnlyWebRequest
          ? Math.min(Math.max(1, Number(emptyAnimeUnityLocalTtl || EMPTY_STREAM_TTL) || EMPTY_STREAM_TTL), 5)
          : emptyAnimeUnityLocalTtl;
      const cachePolicy = {
          ...cachePolicyBase,
          allowSharedWrite: sourceModeFlags.useSharedCache ? cachePolicyBase.allowSharedWrite : false,
          sharedTtl: sourceModeFlags.useSharedCache ? cachePolicyBase.sharedTtl : 0,
          localTtl: sourceModeFlags.liveOnlyMode ? 0 : emptyGsOnlyLocalTtl,
          staleGraceTtl: sourceModeFlags.liveOnlyMode ? 0 : cachePolicyBase.staleGraceTtl
      };

      const clientCache = buildClientCacheMetadata(cachePolicy, finalStreams.length);
      const resultObj = {
          ...resultObjPlaceholder,
          cacheMaxAge: clientCache.cacheMaxAge,
          staleRevalidate: clientCache.staleRevalidate,
          staleError: clientCache.staleError
      };

      if (!sourceModeFlags.liveOnlyMode) {
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
      }

      recordDuration('stream.generate.total', Date.now() - generationStartedAt);
      incrementMetric(finalStreams.length > 0 ? 'stream.generate.nonEmpty' : 'stream.generate.empty');
      logger.info(`[CACHE] SAVED: ${cacheKey} (mode=${sourceModeFlags.sourceMode}, local=${cachePolicy.localTtl}s, shared=${cachePolicy.allowSharedWrite ? cachePolicy.sharedTtl : 0}s, bucket=${cachePolicy.freshnessBucket}, confidence=${cachePolicy.confidenceScore}, streams=${finalStreams.length})`);

      return resultObj;
  });
}

module.exports = { generateStream, getMetadata, resolveDebridLink, resolveLazyStreamData, RD, TB };

