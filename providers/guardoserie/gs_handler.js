'use strict';
// GuardoSerie handler v6: Leviathan ProviderShield architecture.
// CF/session/HTTP guard logic lives in providers/utils/.

const cheerio = require('cheerio');
const path    = require('path');

const tmdbHelper        = require('../../core/utils/tmdb_helper');
const animeIdentity     = require('../anime/anime_identity');
const kitsuProvider     = require('../animeworld/kitsu_provider');
const animeProviderUtils = require('../anime/provider_utils');
const browserProfiles   = require('../../core/browser_profiles');
const { pickRandomProfile } = browserProfiles;
const {
  buildWebStream,
  normalizeQuality,
  pickBetterQuality,
  probePlaylistQuality,
  qualityRank
} = require('../extractors/common');
const {
  extractFromUrl,
  HOSTER_DIRECT_LINK_PATTERN,
  HOSTER_ESCAPED_DIRECT_LINK_PATTERN
} = require('../extractors/registry');
const { isCanceledError } = require('../utils/bypass');
const { createProviderHttpGuard, envFlag, envFlagNotFalse } = require('../utils/provider_http_guard');

const INITIAL_GS_DOMAIN      = 'https://guardoserie.run';
const PROVIDER_NAME          = 'guardoserie';
const BROWSER_PROFILES       = browserProfiles.GUARDO_SERIE_BROWSER_PROFILES || browserProfiles.GUARDA_SERIE_BROWSER_PROFILES || [];

const TTL_SEARCH             = 1000 * 60 * 30;
const TTL_EPISODE            = 1000 * 60 * 30;
const TTL_SERIES             = 1000 * 60 * 60 * 6;
const CF_SESSION_TTL         = 1000 * 60 * 60 * 6;
const PROVIDER_BUDGET_MS     = Math.max(25000, parseInt(process.env.GS_PROVIDER_BUDGET_MS || process.env.GUARDOSERIE_PROVIDER_BUDGET_MS || '55000', 10) || 55000);
const GLOBAL_TIMEOUT_MS      = Math.min(
  PROVIDER_BUDGET_MS,
  Math.max(30000, parseInt(process.env.GS_INTERNAL_TIMEOUT || String(PROVIDER_BUDGET_MS), 10) || PROVIDER_BUDGET_MS)
);
const SEARCH_QUERY_TIMEOUT_MS = Math.max(8000, parseInt(process.env.GS_SEARCH_TIMEOUT || '12000', 10) || 12000);
const DIRECT_FETCH_TIMEOUT_MS = Math.max(2500, parseInt(process.env.GS_DIRECT_FETCH_TIMEOUT || '4200', 10) || 4200);
const FLARE_WARMUP_TIMEOUT_MS = Math.min(
  Math.max(12000, parseInt(process.env.GS_FLARE_WARMUP_TIMEOUT_MS || '24000', 10) || 24000),
  Math.max(15000, GLOBAL_TIMEOUT_MS - 12000)
);

const DEBUG_GS              = envFlag('GUARDOSERIE_DEBUG', false);
const DEBUG_CF              = DEBUG_GS || envFlag('GUARDOSERIE_DEBUG_CF', envFlag('PROVIDER_SHIELD_DEBUG_CF', true)) || envFlag('FLARESOLVERR_DEBUG', false);
const GS_SKIP_AJAX_AFTER_FALLBACK_HIT = envFlagNotFalse('GS_SKIP_AJAX_AFTER_FALLBACK_HIT', true) && envFlagNotFalse('GUARDOSERIE_SKIP_AJAX_AFTER_FALLBACK_HIT', true);
const GS_FAST_SLUG_FIRST           = envFlagNotFalse('GS_FAST_SLUG_FIRST', true) && envFlagNotFalse('GUARDOSERIE_FAST_SLUG_FIRST', true);

const COMPILED_DIRECT_REGEX  = new RegExp(HOSTER_DIRECT_LINK_PATTERN, 'ig');
const COMPILED_ESCAPED_REGEX = new RegExp(HOSTER_ESCAPED_DIRECT_LINK_PATTERN, 'ig');

function gsDebug(message, meta = null) {
  if (!DEBUG_GS && !DEBUG_CF) return;
  const suffix = meta ? ` ${JSON.stringify(meta)}` : '';
  console.log(`[GuardoSerie:debug] ${message}${suffix}`);
}

function gsInfo(message, meta = null) {
  if (!DEBUG_GS && !DEBUG_CF) return;
  const suffix = meta ? ` ${JSON.stringify(meta)}` : '';
  console.log(`[GuardoSerie][Shield] ${message}${suffix}`);
}

const gsHttp = createProviderHttpGuard({
  providerName: PROVIDER_NAME,
  logPrefix: 'GS-SHIELD',
  initialBaseUrl: INITIAL_GS_DOMAIN,
  sessionFile: path.join(process.cwd(), `cf-session-${PROVIDER_NAME}.json`),
  domainFile: path.join(process.cwd(), `${PROVIDER_NAME}-domain.json`),
  profiles: BROWSER_PROFILES,
  pickProfile: pickRandomProfile,
  isCanceledError,
  debug: DEBUG_GS,
  debugCf: DEBUG_CF,
  sessionTtlMs: CF_SESSION_TTL,
  directFetchTimeoutMs: DIRECT_FETCH_TIMEOUT_MS,
  searchTimeoutMs: SEARCH_QUERY_TIMEOUT_MS,
  clearanceTimeoutMs: FLARE_WARMUP_TIMEOUT_MS,
  refreshDomainOnStart: envFlag('GS_REFRESH_DOMAIN_ON_START', false) || envFlag('GUARDOSERIE_REFRESH_DOMAIN_ON_START', false),
  domainProbeTimeoutMs: Math.max(1200, parseInt(process.env.GS_DOMAIN_PROBE_TIMEOUT_MS || '2500', 10) || 2500),
  targetUrlClearance: envFlagNotFalse('GS_FLARE_TARGET_URL', true) && envFlagNotFalse('GUARDOSERIE_FLARE_TARGET_URL', true),
  homepageFallback: envFlag('GS_FLARE_HOMEPAGE_FALLBACK', false) || envFlag('GUARDOSERIE_FLARE_HOMEPAGE_FALLBACK', false),
  clearanceCooldownMs: Math.max(3000, parseInt(process.env.GS_FLARE_CLEARANCE_COOLDOWN_MS || '8000', 10) || 8000),
  flareEndpoint: process.env.FLARESOLVERR_URL
});

const lightClient = gsHttp.lightClient;
const smartFetch = (...args) => gsHttp.smartFetch(...args);
const refreshTargetDomain = (...args) => gsHttp.refreshTargetDomain(...args);
const buildGsUrl = pathname => gsHttp.buildProviderUrl(pathname);
const getTargetDomain = () => gsHttp.getCurrentBaseUrl();
const normalizeBaseUrl = value => gsHttp.normalizeBaseUrl(value);
const isAbortLikeError = error => gsHttp.isAbortLikeError(error);

const IT_STOPWORDS = /\b(the|a|an|un|una|il|lo|la|gli|le|di|de|del|della|degli|delle|dei|alle|nei|nelle|negli|serie|stagione|season|episodio|episode)\b/g;

function normalizeText(val) {
  return String(val || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/&amp;/g, '&')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(IT_STOPWORDS, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function slugify(val) {
  return String(val || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function normalizeTitleScore(candidate, title, originalTitle) {
  const cand      = normalizeText(candidate);
  const primary   = normalizeText(title);
  const secondary = normalizeText(originalTitle);
  if (!cand) return 0;
  if (cand === primary || (secondary && cand === secondary)) return 3;
  if (
    (primary   && (cand.includes(primary)   || primary.includes(cand))) ||
    (secondary && (cand.includes(secondary) || secondary.includes(cand)))
  ) return 2;

  const candTokens  = new Set(cand.split(' ').filter(Boolean));
  const titleTokens = Array.from(new Set(`${primary} ${secondary}`.trim().split(' ').filter(Boolean)));
  if (!titleTokens.length) return 0;

  let hits = 0;
  for (const token of titleTokens) if (candTokens.has(token)) hits++;
  const ratio = hits / titleTokens.length;
  return ratio >= 0.75 ? 2 : ratio >= 0.45 ? 1 : 0;
}

function uniqueCleanStrings(values = [], max = 12) {
  const out  = [];
  const seen = new Set();
  for (const value of values || []) {
    const text = String(value || '').replace(/&amp;/gi, '&').replace(/\s+/g, ' ').trim();
    if (!text || text.length < 2) continue;
    const key = normalizeText(text);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(text);
    if (out.length >= max) break;
  }
  return out;
}

function isUsableGsTitleForSearch(value) {
  const text = String(value || '').trim();
  if (!text || text.length < 2) return false;
  // Avoid accidental date/year-only values becoming /serie/2016-07-15/ candidates.
  if (/^\d{4}(-\d{2}-\d{2})?$/.test(text)) return false;
  if (/^\d+$/.test(text)) return false;
  if (!/[a-zA-Z]/.test(text)) return false;
  return true;
}

function normalizeTitleScoreMany(candidate, titles = []) {
  let best = 0;
  for (const title of uniqueCleanStrings(titles, 16)) {
    best = Math.max(best, normalizeTitleScore(candidate, title, null));
    if (best >= 3) break;
  }
  return best;
}

async function buildSharedAnimeContext(meta = {}, config = {}, season = null, episode = null) {
  try {
    const context = await animeIdentity.buildAnimeSearchContextForProvider({
      requestId:  meta?.requestedId || meta?.id || meta?.imdb_id || meta?.tmdb_id || null,
      originalId: meta?.originalId || null,
      finalId:    meta?.id || meta?.imdb_id || meta?.tmdb_id || null,
      meta,
      config,
      season,
      episode,
      providerName: 'GuardoSerie'
    });
    if (context?.isAnime || context?.searchTitles?.length || context?.rawTitles?.length) return context;
  } catch (error) {
    console.warn('[GuardoSerie] shared anime context failed:', error.message);
  }
  return null;
}

function getKitsuRequestFromMeta(meta = {}) {
  const candidates = uniqueCleanStrings([
    meta?.requestedId,
    meta?.originalId,
    meta?.sourceId,
    meta?.source_id,
    meta?.stremioId,
    meta?.stremio_id,
    meta?.canonicalId,
    meta?.canonical_id,
    meta?.id,
    meta?.kitsu_id,
    meta?.kitsuId,
    meta?.kitsu
  ], 40);

  for (const candidate of candidates) {
    const parsed = kitsuProvider.parseKitsuId(candidate);
    if (parsed?.kitsuId) return { requestId: candidate, parsed };
  }

  for (const value of [meta?.kitsu_id, meta?.kitsuId, meta?.kitsu]) {
    const text = String(value || '').trim();
    if (/^\d+$/.test(text)) return { requestId: `kitsu:${text}`, parsed: { kitsuId: text, seasonNumber: null, episodeNumber: null } };
  }

  return null;
}

function buildGsKitsuProviderContext(meta = {}, config = {}, kitsuInfo = null, episodeNumber = 1) {
  const providerContext = animeProviderUtils.buildAnimeProviderContext({
    ...meta,
    id:      kitsuInfo?.requestId || meta?.id || meta?.requestedId || null,
    kitsuId: kitsuInfo?.parsed?.kitsuId || meta?.kitsuId || meta?.kitsu_id || meta?.kitsu || null,
    episode: episodeNumber
  });
  providerContext.mappingLanguage  = 'it';
  providerContext.italianOnly      = true;
  providerContext.onlyItalian      = true;
  providerContext.mappingTimeoutMs = 6000;
  providerContext.mappingRetries   = 2;

  if (Array.isArray(config?.mappingApiBases))          providerContext.mappingApiBases = config.mappingApiBases;
  if (Array.isArray(config?.mappingMirrors))           providerContext.mappingApiBases = config.mappingMirrors;
  if (Array.isArray(config?.filters?.mappingApiBases)) providerContext.mappingApiBases = config.filters.mappingApiBases;
  if (Array.isArray(config?.filters?.mappingMirrors))  providerContext.mappingApiBases = config.filters.mappingMirrors;

  return providerContext;
}

async function fetchStrictKitsuMapping(meta = {}, config = {}, kitsuInfo = null, requestedEpisode = 1) {
  const kitsuId = kitsuInfo?.parsed?.kitsuId;
  if (!kitsuId) return null;
  const episodeNumber   = parseInt(requestedEpisode, 10) || kitsuInfo?.parsed?.episodeNumber || parseInt(meta?.episode, 10) || 1;
  const providerContext = buildGsKitsuProviderContext(meta, config, kitsuInfo, episodeNumber);
  const lookup = {
    provider:    'kitsu',
    externalId:  String(kitsuId),
    season:      null,
    episode:     episodeNumber,
    contentType: 'anime'
  };
  try {
    return await animeProviderUtils.fetchMappingPayload(lookup, providerContext);
  } catch (error) {
    console.warn('[GuardoSerie][KITSU] mapping failed:', error.message);
    return null;
  }
}

function resolveStrictKitsuEpisodeForGs(mappingPayload, fallbackEpisode) {
  const requested    = parseInt(fallbackEpisode, 10) || 1;
  const fromKitsu    = parseInt(mappingPayload?.kitsu?.episode, 10);
  const fromRequested = parseInt(mappingPayload?.requested?.episode, 10);
  if (Number.isInteger(fromKitsu)    && fromKitsu > 0    && fromKitsu === requested)    return fromKitsu;
  if (Number.isInteger(fromRequested) && fromRequested > 0 && fromRequested === requested) return fromRequested;
  return requested;
}

function extractGsMappingEntries(mappingPayload) {
  const mappings = mappingPayload?.mappings || mappingPayload?.mapping || {};
  const raw      = mappings.guardoserie || mappings.guardoSerie || mappings.guardaserie || mappings.gs || null;
  const list     = Array.isArray(raw) ? raw : raw ? [raw] : [];
  const out      = [];

  for (const entry of list) {
    const value = typeof entry === 'string'
      ? entry
      : entry && typeof entry === 'object'
        ? entry.path || entry.url || entry.href || entry.watchPath || entry.playPath || null
        : null;
    if (!value) continue;
    try {
      out.push(/^https?:\/\//i.test(String(value)) ? String(value) : buildGsUrl(String(value)));
    } catch (_) {}
  }

  return Array.from(new Set(out.filter(Boolean)));
}

async function buildStrictKitsuAnimeContext(meta = {}, config = {}, season = null, episode = null) {
  const kitsuInfo = getKitsuRequestFromMeta(meta);
  if (!kitsuInfo?.parsed?.kitsuId) return null;

  const requestedEpisode = kitsuInfo.parsed.episodeNumber || parseInt(episode, 10) || parseInt(meta?.episode, 10) || 1;
  const requestId        = kitsuInfo.requestId || `kitsu:${kitsuInfo.parsed.kitsuId}:${requestedEpisode}`;
  let context            = null;

  try {
    context = await kitsuProvider.buildSearchContext(requestId, { ...meta, season, episode: requestedEpisode });
  } catch (error) {
    console.warn('[GuardoSerie][KITSU] context failed:', error.message);
  }

  const mappingPayload = await fetchStrictKitsuMapping(meta, config, kitsuInfo, requestedEpisode);
  const strictEpisode  = resolveStrictKitsuEpisodeForGs(mappingPayload, requestedEpisode);
  const rawTitles      = uniqueCleanStrings([
    ...(Array.isArray(context?.rawTitles)    ? context.rawTitles    : []),
    ...(Array.isArray(context?.searchTitles) ? context.searchTitles : []),
    ...(Array.isArray(context?.info?.titles) ? context.info.titles  : []),
    context?.info?.canonicalTitle,
    context?.title,
    meta?.title,
    meta?.name,
    meta?.originalTitle,
    meta?.canonicalTitle,
    meta?.seriesTitle
  ], 24);

  const searchTitles = uniqueCleanStrings([
    ...kitsuProvider.buildTitleVariants(rawTitles),
    ...rawTitles
  ], 24);

  return {
    ...(context || {}),
    isAnime:           true,
    strictKitsu:       true,
    kitsuId:           String(kitsuInfo.parsed.kitsuId),
    rawTitles,
    searchTitles,
    title:             searchTitles[0] || rawTitles[0] || meta?.title || null,
    seasonNumber:      parseInt(context?.seasonNumber, 10) || parseInt(season, 10) || parseInt(meta?.season, 10) || 1,
    requestedEpisode:  strictEpisode,
    episodeCandidates: [strictEpisode],
    mappingPayload,
    mappingUrls:       extractGsMappingEntries(mappingPayload),
    tmdbId:            null,
    imdbId:            null,
    mappedIds:         null,
    identitySources:   ['kitsu', mappingPayload ? 'mapping:kitsu' : null].filter(Boolean)
  };
}

function normalizeStreamUrl(url) {
  try {
    const u = new URL(url);
    ['utm_source', 'utm_medium', 'utm_campaign'].forEach(k => u.searchParams.delete(k));
    return u.toString();
  } catch (_) { return String(url || ''); }
}

function getStreamPriority(stream) {
  return Number.isFinite(stream?.extra?._priority) ? stream.extra._priority : 9;
}

function isLikelyPlayerUrl(url) {
  return /(mixdrop|m1xdrop|voe|loadm|rpmshare|rpmplay|maxstream|supervideo|dood|streamtape|vixsrc|vixcloud|filemoon|dropload|dr0pstream|mxcontent)/i.test(url);
}

function extractSearchResultsFromHtml(html, baseUrl) {
  if (!html) return [];
  const $       = cheerio.load(String(html));
  const results = [];
  const seen    = new Set();

  $('a[href]').each((_, el) => {
    const href = $(el).attr('href');
    if (!href || !/(\/serie\/|\/episodio\/)/i.test(href)) return;
    try {
      const absolute = new URL(href, baseUrl).toString();
      if (!seen.has(absolute)) {
        seen.add(absolute);
        results.push({
          url:   absolute,
          title: String($(el).attr('title') || $(el).text() || '').trim() || absolute
        });
      }
    } catch (_) {}
  });

  return results;
}

async function searchProviderSequential(query, signal) {
  const startedAt = Date.now();
  const baseUrl     = await refreshTargetDomain(signal);
  const ajaxUrl     = `${baseUrl}/wp-admin/admin-ajax.php`;
  const ajaxBody    = `s=${encodeURIComponent(query)}&action=searchwp_live_search&swpengine=default&swpquery=${encodeURIComponent(query)}`;
  const fallbackUrl = `${baseUrl}/?s=${encodeURIComponent(query)}`;

  const fetchFallback = () => smartFetch(fallbackUrl, {
    ttl: TTL_SEARCH,
    signal,
    allowFlareSolverr: true,
    timeoutMs: SEARCH_QUERY_TIMEOUT_MS
  }).catch((e) => {
    if (isAbortLikeError(e)) throw e;
    gsDebug('fallback search failed', { query, error: e?.message || String(e) });
    return '';
  });

  const fetchAjax = () => smartFetch(ajaxUrl, {
    isPost: true,
    body: ajaxBody,
    ttl: TTL_SEARCH,
    signal,
    allowFlareSolverr: true,
    timeoutMs: SEARCH_QUERY_TIMEOUT_MS
  }).catch((e) => {
    if (isAbortLikeError(e)) throw e;
    gsDebug('ajax search failed', { query, error: e?.message || String(e) });
    return '';
  });

  // ProviderShield fast path: try the normal WordPress search page first.
  // If it already gives usable links, skip the AJAX endpoint: fewer CF trips, lower latency.
  const fallbackHtml = await fetchFallback();
  const fallbackResults = extractSearchResultsFromHtml(fallbackHtml, baseUrl);
  let ajaxHtml = '';

  if (!GS_SKIP_AJAX_AFTER_FALLBACK_HIT || fallbackResults.length === 0) {
    ajaxHtml = await fetchAjax();
  }

  const ajaxResults = ajaxHtml ? extractSearchResultsFromHtml(ajaxHtml, baseUrl) : [];
  const results = [...fallbackResults, ...ajaxResults];

  const unique = Array.from(new Map(results.map(item => [item.url, item])).values());
  gsDebug('search query done', {
    query,
    fallbackResults: fallbackResults.length,
    ajaxResults: ajaxResults.length,
    results: unique.length,
    skippedAjax: GS_SKIP_AJAX_AFTER_FALLBACK_HIT && fallbackResults.length > 0,
    ms: Date.now() - startedAt
  });
  return unique;
}

function createTimeoutSignal(parentSignal, timeoutMs) {
  const controller = new AbortController();

  if (parentSignal?.aborted) {
    controller.abort(parentSignal.reason ?? 'parent aborted');
    return { signal: controller.signal, clear: () => {} };
  }

  const abortFromParent = () => {
    if (!controller.signal.aborted) controller.abort(parentSignal?.reason ?? 'parent aborted');
  };

  if (parentSignal) parentSignal.addEventListener('abort', abortFromParent, { once: true });

  const timer = setTimeout(() => {
    if (!controller.signal.aborted) controller.abort('timeout');
  }, timeoutMs);

  if (timer?.unref) timer.unref();

  return {
    signal: controller.signal,
    clear:  () => {
      clearTimeout(timer);
      if (parentSignal) parentSignal.removeEventListener('abort', abortFromParent);
    }
  };
}

async function searchProviderWithTimeout(query, signal, timeoutMs = SEARCH_QUERY_TIMEOUT_MS) {
  // Keep every single query bounded. The old wide clearance budget was the reason GS reached Leviathan's 65s watchdog.
  const clearanceBudgetMs = Math.min(GLOBAL_TIMEOUT_MS - 12000, FLARE_WARMUP_TIMEOUT_MS + DIRECT_FETCH_TIMEOUT_MS + 5000);
  const effectiveTimeoutMs = Math.max(timeoutMs, Math.max(18000, clearanceBudgetMs));
  const needsClearanceWindow = !gsHttp.isSessionFresh();

  const scoped = createTimeoutSignal(signal, effectiveTimeoutMs);
  try {
    gsDebug('search query start', { query, timeoutMs: effectiveTimeoutMs, needsClearanceWindow });
    return await searchProviderSequential(query, scoped.signal);
  } catch (e) {
    if (isAbortLikeError(e) || scoped.signal.aborted) {
      gsDebug('search query aborted', { query, timeoutMs: effectiveTimeoutMs, needsClearanceWindow, error: e?.message || String(e) });
      return [];
    }
    gsDebug('search query failed', { query, error: e?.message || String(e) });
    return [];
  } finally {
    scoped.clear();
  }
}

async function searchProviderParallel(queries, signal) {
  const uniqueQueries = Array.from(new Set(queries.filter(Boolean))).slice(0, 3);
  if (!uniqueQueries.length) return [];
  const results = await asyncPool(2, uniqueQueries, q => searchProviderWithTimeout(q, signal));
  return results.flat().filter(Boolean);
}

function extractEpisodeUrlFromSeriesPage(pageHtml, season, episode, options = {}) {
  const raw = String(pageHtml || '');
  if (!raw) return null;

  const targetSeason  = parseInt(season, 10);
  const targetEpisode = parseInt(episode, 10);
  if (
    !Number.isInteger(targetSeason)  || !Number.isInteger(targetEpisode) ||
    targetSeason < 1                 || targetEpisode < 1
  ) return null;

  const $ = cheerio.load(raw);

  const readSeasonNumber = text => {
    const match = String(text || '').match(/\b(?:stagione|season)\s*-?\s*(\d+)\b/i);
    return match ? parseInt(match[1], 10) : null;
  };

  const readEpisodeNumber = text => {
    const s     = String(text || '');
    const match =
      s.match(/\b(?:episodio|episode|ep)\s*-?\s*(\d+)\b/i) ||
      s.match(/\bs\d{1,2}e(\d{1,3})\b/i) ||
      s.match(/\b\d{1,2}x(\d{1,3})\b/i);
    return match ? parseInt(match[1], 10) : null;
  };

  const findEpisodeInBlock = block => {
    const links = $(block).find('.les-content a[href*="/episodio/"], a[href*="/episodio/"]').toArray();
    for (const el of links) {
      const href  = $(el).attr('href') || '';
      const epNum = readEpisodeNumber(`${$(el).text()} ${href}`);
      if (epNum === targetEpisode) return href || null;
    }
    if (options?.strictEpisode) return null;
    return links.length >= targetEpisode ? ($(links[targetEpisode - 1]).attr('href') || null) : null;
  };

  const seasonBlocks = $('.tvseason').toArray();
  for (const block of seasonBlocks) {
    const seasonNum = readSeasonNumber($(block).find('.les-title').first().text());
    if (seasonNum !== targetSeason) continue;
    const href = findEpisodeInBlock(block);
    if (href) return href;
  }

  if (seasonBlocks.length >= targetSeason) {
    const href = options?.strictEpisode ? null : findEpisodeInBlock(seasonBlocks[targetSeason - 1]);
    if (href) return href;
  }

  let matchedHref = null;
  $('a[href*="/episodio/"]').each((_, el) => {
    const href      = $(el).attr('href') || '';
    const text      = `${$(el).text()} ${href}`;
    const seasonNum = readSeasonNumber(text);
    const epNum     = readEpisodeNumber(text);
    if (seasonNum === targetSeason && epNum === targetEpisode) {
      matchedHref = href;
      return false;
    }
  });

  if (matchedHref) return matchedHref;

  const directEpisodeRegexes = [
    new RegExp(`/episodio/[^"'\\s<>]*stagione-0?${targetSeason}-episodio-0?${targetEpisode}(?=[/?#"'\\s<>]|$)`, 'i'),
    new RegExp(`/episodio/[^"'\\s<>]*s0?${targetSeason}e0?${targetEpisode}(?=[/?#"'\\s<>]|$)`, 'i'),
    new RegExp(`/episodio/[^"'\\s<>]*${targetSeason}x${targetEpisode}(?=[/?#"'\\s<>]|$)`, 'i')
  ];

  for (const re of directEpisodeRegexes) {
    const match = raw.match(re);
    if (match?.[0]) return match[0];
  }

  const sIdx = targetSeason  - 1;
  const eIdx = targetEpisode - 1;
  if (sIdx < 0 || eIdx < 0) return null;

  const legacySeasonBlocks = $('.les-content, [class*="season-"], [class*="stagione-"]');
  if (!options?.strictEpisode && legacySeasonBlocks.length > sIdx) {
    const block    = legacySeasonBlocks.eq(sIdx);
    const episodes = block.find('a[href*="/episodio/"]');
    if (episodes.length > eIdx) return episodes.eq(eIdx).attr('href') || null;
  }

  return null;
}

function extractPlayerLinksFromHtml(html) {
  const raw     = String(html || '');
  const links   = new Set();
  const baseUrl = normalizeBaseUrl(getTargetDomain()) || INITIAL_GS_DOMAIN;

  const normalize = link => {
    let n = String(link).trim().replace(/&amp;/g, '&').replace(/\\\//g, '/');
    if (!n || n.startsWith('data:')) return null;
    if (n.startsWith('//')) return `https:${n}`;
    if (n.startsWith('/'))  return `${baseUrl}${n}`;
    if (!/^https?:\/\//i.test(n) && /(loadm|mixdrop|m1xdrop|mxcontent)/i.test(n)) {
      return `https://${n.replace(/^\/+/, '')}`;
    }
    return /^https?:\/\//i.test(n) ? n : null;
  };

  const iframeTags = raw.match(/<iframe\b[^>]*>/ig) || [];
  for (const tag of iframeTags) {
    const attrRegex = /\b(?:data-src|src)\s*=\s*(['"])(.*?)\1/ig;
    let m;
    while ((m = attrRegex.exec(tag)) !== null) {
      const c = normalize(m[2]);
      if (c && isLikelyPlayerUrl(c)) links.add(c);
    }
  }

  for (const regex of [COMPILED_DIRECT_REGEX, COMPILED_ESCAPED_REGEX]) {
    regex.lastIndex = 0;
    for (const m of raw.match(regex) || []) {
      const c = normalize(m);
      if (c && isLikelyPlayerUrl(c)) links.add(c);
    }
  }

  return Array.from(links);
}

async function asyncPool(limit, items, asyncFn) {
  if (!items.length) return [];
  const results = new Array(items.length);
  const queue   = items.map((item, i) => ({ item, i }));
  const running = new Set();

  async function runNext() {
    if (!queue.length) return;
    const { item, i } = queue.shift();
    const p = Promise.resolve()
      .then(() => asyncFn(item))
      .catch(e => { if (!isAbortLikeError(e)) return null; throw e; })
      .then(result => { results[i] = result; running.delete(p); return runNext(); });
    running.add(p);
    return p;
  }

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, runNext));
  return results;
}

async function searchGuardaserie(meta, config) {
  if (!meta?.isSeries || !config?.filters?.enableGs) return [];

  const kitsuInfo = getKitsuRequestFromMeta(meta);
  let season      = parseInt(meta?.season, 10);
  let episode     = parseInt(meta?.episode, 10) || kitsuInfo?.parsed?.episodeNumber || 1;

  if ((!season || season < 1) && kitsuInfo?.parsed?.kitsuId) season = kitsuInfo.parsed.seasonNumber || 1;
  if (!season || season < 1 || !episode || episode < 1) return [];

  const controller = new AbortController();
  const timer      = setTimeout(() => controller.abort(), GLOBAL_TIMEOUT_MS);

  try {
    return await _searchGuardaserie(meta, config, season, episode, controller.signal);
  } catch (e) {
    gsDebug('provider failed', { error: e?.message || String(e) });
    return [];
  } finally {
    clearTimeout(timer);
  }
}

async function tryFastSlugTargets(expectedTitles = [], targetYear = null, signal = null) {
  if (!GS_FAST_SLUG_FIRST) return [];
  const candidates = [];
  const seen = new Set();

  for (const title of uniqueCleanStrings(expectedTitles, 8).filter(isUsableGsTitleForSearch)) {
    const slug = slugify(title);
    if (!slug) continue;
    for (const p of [`/serie/${slug}/`]) {
      const url = buildGsUrl(p);
      if (seen.has(url)) continue;
      seen.add(url);
      candidates.push(url);
    }
  }

  const out = [];
  gsDebug('fast slug start', { candidates: candidates.slice(0, 3) });
  for (const url of candidates.slice(0, 3)) {
    try {
      const html = await smartFetch(url, { ttl: TTL_SERIES, signal, allowFlareSolverr: true, timeoutMs: Math.min(DIRECT_FETCH_TIMEOUT_MS, 4200) });
      if (!html) continue;

      const pageTitle = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || '';
      const titleScore = normalizeTitleScoreMany(pageTitle, expectedTitles);
      if (titleScore < 2) continue;

      const foundYear =
        html.match(/release-year\/(\d{4})/i)?.[1] ||
        html.match(/\b(19\d{2}|20\d{2})\b/)?.[1] ||
        null;

      if (targetYear && foundYear && Math.abs(Number(foundYear) - Number(targetYear)) > 3) continue;
      out.push({ url, html, title: pageTitle || url, mapped: true, fastSlug: true, score: titleScore });
      if (titleScore >= 3) break;
    } catch (e) {
      if (isAbortLikeError(e) && signal?.aborted) throw e;
      gsDebug('fast slug candidate failed', { url, error: e?.message || String(e) });
    }
  }

  if (out.length) gsInfo('fast slug matched', { count: out.length, first: out[0].url });
  return out;
}

async function _searchGuardaserie(meta, config, season, episode, signal) {
  const providerStartedAt = Date.now();
  gsDebug('provider start', { title: meta?.title || meta?.name, season, episode, budgetMs: GLOBAL_TIMEOUT_MS, shieldEndpoint: gsHttp.getEndpoint() });
  await refreshTargetDomain(signal);
  gsDebug('domain ready', { base: getTargetDomain(), ms: Date.now() - providerStartedAt, probed: gsHttp.isDomainProbeEnabled() });
  if (signal?.aborted) return [];

  const strictKitsuContext = await buildStrictKitsuAnimeContext(meta, config, season, episode);
  const animeContext       = strictKitsuContext || await buildSharedAnimeContext(meta, config, season, episode);
  gsDebug('identity ready', { isAnime: Boolean(animeContext?.isAnime), strictKitsu: Boolean(animeContext?.strictKitsu), ms: Date.now() - providerStartedAt });
  const strictKitsu        = Boolean(animeContext?.strictKitsu);

  if (animeContext?.isAnime) {
    const mappedSeason  = parseInt(animeContext.seasonNumber, 10);
    const mappedEpisode = parseInt(animeContext.requestedEpisode, 10);
    if (mappedSeason > 0)  season  = mappedSeason;
    if (mappedEpisode > 0) episode = mappedEpisode;
  }

  let tmdbId = strictKitsu ? null : (meta?.tmdb_id || meta?.tmdbId || animeContext?.tmdbId || animeContext?.mappedIds?.tmdbId || null);

  if (!strictKitsu && !tmdbId && (meta?.imdb_id || animeContext?.imdbId)) {
    const resolved = await tmdbHelper.getTmdbFromImdb(meta.imdb_id || animeContext.imdbId, { mediaHint: 'tv' }).catch(() => null);
    if (resolved) tmdbId = resolved;
  }

  let showName     = strictKitsu ? (animeContext?.title || meta?.title || meta?.name || null) : (meta?.title || animeContext?.title || null);
  let originalTitle = animeContext?.rawTitles?.find(title => normalizeText(title) !== normalizeText(showName)) || null;
  let targetYear   = animeContext?.year || null;

  if (tmdbId) {
    const tmdbMeta = await tmdbHelper.getMediaInfoFull(tmdbId, 'tv', { language: 'it-IT' }).catch(() => null);
    if (tmdbMeta) {
      showName      = tmdbMeta.title         || showName;
      originalTitle = tmdbMeta.original_title || originalTitle || null;
      targetYear    = tmdbMeta.year          || targetYear    || null;
    }
  }

  const expectedTitles = uniqueCleanStrings([
    showName,
    originalTitle,
    ...(Array.isArray(animeContext?.searchTitles) ? animeContext.searchTitles : []),
    ...(Array.isArray(animeContext?.rawTitles)    ? animeContext.rawTitles    : []),
    meta?.name,
    meta?.originalTitle,
    meta?.canonicalTitle,
    meta?.seriesTitle
  ], 18).filter(isUsableGsTitleForSearch).slice(0, 14);

  showName = showName || expectedTitles[0] || null;
  if (!showName) return [];

  const queries       = uniqueCleanStrings(expectedTitles, animeContext?.isAnime ? 8 : 4);
  const mappedResults = (Array.isArray(animeContext?.mappingUrls) ? animeContext.mappingUrls : [])
    .map(url => ({ url, title: showName || url, mapped: true }));
  const fastSlugResults = await tryFastSlugTargets(expectedTitles, targetYear, signal);
  gsDebug('fast slug done', { results: fastSlugResults.length, ms: Date.now() - providerStartedAt });
  let allResults = [...mappedResults, ...fastSlugResults];

  // If direct slug hit already found the right series page, keep search as fallback only.
  // This keeps the common fast path cheap: cached/session URL fetch first, heavier search second.
  if (!fastSlugResults.length) {
    allResults.push(...await searchProviderParallel(queries, signal));
    gsDebug('search fallback done', { totalResults: allResults.length, ms: Date.now() - providerStartedAt });
  }

  allResults     = Array.from(new Map(allResults.map(i => [i.url, i])).values());

  const seriesResults  = allResults.filter(r => /\/serie\//i.test(r.url));
  const episodeResults = allResults.filter(r => /\/episodio\//i.test(r.url));
  allResults = strictKitsu && seriesResults.length ? seriesResults : [...seriesResults, ...episodeResults];

  allResults.sort((a, b) =>
    normalizeTitleScoreMany(b.title, expectedTitles) -
    normalizeTitleScoreMany(a.title, expectedTitles)
  );

  let target = null, bestLoose = null;

  for (const result of allResults) {
    const titleScore = normalizeTitleScoreMany(result.title, expectedTitles);
    if (titleScore < 1) continue;

    const html = result.html || await smartFetch(result.url, { ttl: TTL_SERIES, signal, allowFlareSolverr: true, timeoutMs: DIRECT_FETCH_TIMEOUT_MS });
    if (!html) continue;

    const foundYear =
      html.match(/release-year\/(\d{4})/i)?.[1] ||
      html.match(/\b(19\d{2}|20\d{2})\b/)?.[1]  ||
      null;

    if (targetYear && foundYear) {
      const allowedYearDelta = titleScore >= 3 ? 3 : 1;
      if (Math.abs(Number(foundYear) - Number(targetYear)) <= allowedYearDelta) {
        target = { url: result.url, html };
        break;
      }
    } else if (titleScore >= (bestLoose?.score || 0)) {
      bestLoose = { url: result.url, html, score: titleScore };
      if (titleScore >= 2) break;
    }
  }

  if (!target && bestLoose) target = bestLoose;

  if (!target) {
    const slugs = uniqueCleanStrings(expectedTitles, 3).map(slugify).filter(Boolean);
    outer: for (const slug of slugs) {
      for (const p of [`/serie/${slug}/`, `/${slug}/`, `/serietv/${slug}/`]) {
        const url  = buildGsUrl(p);
        const html = await smartFetch(url, { ttl: TTL_SERIES, signal, allowFlareSolverr: true, timeoutMs: Math.min(DIRECT_FETCH_TIMEOUT_MS, 4200) });
        if (html) {
          const pageTitle = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1];
          if (normalizeTitleScoreMany(pageTitle, expectedTitles) >= 2) {
            target = { url, html };
            break outer;
          }
        }
      }
    }
  }

  if (!target?.url) return [];

  const episodeUrl    = extractEpisodeUrlFromSeriesPage(target.html, season, episode, { strictEpisode: strictKitsu });
  if (!episodeUrl) return [];

  const absoluteEpUrl = new URL(episodeUrl, getTargetDomain()).toString();
  const finalHtml     = await smartFetch(absoluteEpUrl, { ttl: TTL_EPISODE, signal, allowFlareSolverr: true, timeoutMs: DIRECT_FETCH_TIMEOUT_MS });
  const playerLinks   = Array.from(new Set(extractPlayerLinksFromHtml(finalHtml))).slice(0, 5);
  if (!playerLinks.length) return [];

  const cleanTitle = `${showName} S${String(season).padStart(2, '0')}E${String(episode).padStart(2, '0')}`;
  const sessionUA  = gsHttp.getSession()?.userAgent || pickRandomProfile(BROWSER_PROFILES)?.ua || pickRandomProfile(BROWSER_PROFILES)?.userAgent;

  const processedResults = await asyncPool(2, playerLinks, async link => {
    try {
      const extracted = await extractFromUrl(link, {
        client:         lightClient,
        userAgent:      sessionUA,
        requestReferer: getTargetDomain()
      });
      if (!extracted?.url) return null;

      let quality = normalizeQuality(extracted?.quality || 'Unknown');
      if (/\.m3u8($|\?)/i.test(String(extracted.url))) {
        try {
          const probed = await probePlaylistQuality(lightClient, extracted.url, {
            headers: extracted.headers || {},
            timeout: 5000,
            signal
          });
          quality = pickBetterQuality(probed || 'Unknown', quality);
        } catch (_) {}
      }

      return buildWebStream({
        name:         `GuardoSerie | ${extracted.name}`,
        title:        `${cleanTitle}\n ${extracted.name}  ITA`,
        url:          extracted.url,
        extractor:    extracted.name,
        provider:     'GuardoSerie',
        providerCode: 'GS',
        quality,
        headers:      extracted.headers,
        extra:        { _priority: extracted.priority ?? 9 }
      });
    } catch (_) { return null; }
  });

  return processedResults
    .filter(Boolean)
    .sort((a, b) => {
      const qDelta = qualityRank(b.quality) - qualityRank(a.quality);
      return qDelta !== 0 ? qDelta : getStreamPriority(a) - getStreamPriority(b);
    })
    .filter((s, i, arr) => {
      const key = normalizeStreamUrl(s.url);
      return arr.findIndex(x => normalizeStreamUrl(x.url) === key) === i;
    })
    .map(s => {
      if (s.extra) delete s.extra._priority;
      delete s._priority;
      return s;
    });
}

module.exports = { searchGuardaserie, searchGuardoSerie: searchGuardaserie };

