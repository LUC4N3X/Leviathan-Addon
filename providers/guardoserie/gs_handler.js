'use strict';

const cheerio = require('cheerio');
const path    = require('path');

const tmdbHelper        = require('../../core/utils/tmdb_helper');
const animeIdentity     = require('../anime/anime_identity');
const kitsuProvider     = require('../animeworld/kitsu_provider');
const animeProviderUtils = require('../anime/provider_utils');
const browserProfiles   = require('../../core/security/browser_profiles');
const { pickRandomProfile } = browserProfiles;
const {
  buildWebStream,
  normalizeQuality,
  pickBetterQuality,
  probePlaylistQuality,
  probePlaylistIntelligence,
  decorateStreamWithPlaylistIntelligence,
  qualityRank
} = require('../extractors/common');
const {
  extractFromUrl,
  HOSTER_DIRECT_LINK_PATTERN,
  HOSTER_ESCAPED_DIRECT_LINK_PATTERN,
  resolveExtractorDefinition
} = require('../extractors/registry');
const { isCanceledError, isCloudflareChallenge, requestWithImpitRotating } = require('../utils/bypass');
const { withProviderHealth } = require('../utils/provider_health');
const { normalizeStreams } = require('../utils/stream_normalizer');
const { buildLazyExtractorStream } = require('../extractors/lazy_extraction');
const { extractResilientEmbeds } = require('../extractors/semantic_candidate_extractor');
const { createCloudflareBypass, envFlag } = require('../utils/cloudflare_bypass');

const INITIAL_GS_DOMAIN      = 'https://guardoserie.watch';
const GS_MOVIE_LIST_PATH     = '/guarda-film-streaming-ita/';
const PROVIDER_NAME          = 'guardoserie';
const BROWSER_PROFILES       = browserProfiles.GUARDO_SERIE_BROWSER_PROFILES || browserProfiles.GUARDA_SERIE_BROWSER_PROFILES || [];

const TTL_SEARCH             = 1000 * 60 * 30;
const TTL_EPISODE            = 1000 * 60 * 30;
const TTL_MOVIE              = 1000 * 60 * 30;
const TTL_SERIES             = 1000 * 60 * 60 * 6;
const CF_SESSION_TTL         = 1000 * 60 * 60 * 6;
const PROVIDER_BUDGET_MS     = 15000;
const GLOBAL_TIMEOUT_MS      = PROVIDER_BUDGET_MS;
const SEARCH_QUERY_TIMEOUT_MS = 5000;

const GS_TOP_SPEED = Object.freeze({
  flareEndpoint: process.env.FLARESOLVERR_URL || 'http://flaresolverr:8191/v1',
  directFetchTimeoutMs: 3000,
  sessionTimeoutFloorMs: 2600,
  postClearanceReplayTimeoutMs: 6500,
  clearSessionOnTransportFailure: false,
  useRustShieldForSession: false,
  flareWarmupTimeoutMs: 24000,
  flareClearanceCooldownMs: 8000,
  flareProviderFailureCooldownMs: 8000,
  flareProviderFailureCooldownMaxMs: 30000,
  flareEndpointFailureCooldownMs: 15000,
  flareRetryCount: 1,
  flareRetryBackoffMs: 900,
  backgroundRetryMs: 8000,
  backgroundForceStartup: false,
  backgroundIgnoreProviderCooldown: true,
  staleSessionEmergencyClearance: true,
  staleSessionEmergencyCooldownMs: 0,
  clearanceBridgeMode: true,
  enableImpitFallback: true,
  backgroundClearanceEnabled: envFlag('GUARDOSERIE_FLARE_ENABLED', true),
  backgroundPrimeHome: false,
  backgroundTitlePrime: true,
  backgroundRefreshMs: 600_000,
  backgroundRefreshEarlyMs: 1_200_000,
  backgroundPrimeTimeoutMs: 2200,
  backgroundTitlePrimeMax: 8,
  prewarmStartDelayMs: 0,
  prewarmWaitMs: 250,
  requestClearanceWaitMs: 18000,
  hotpathFlareFallback: false,
  backgroundStaticPrime: false,
  movieFastSlugMax: 6,
  seriesFastSlugMax: 12,
  movieMaxVerifyCandidates: 2,
  movieHardBudgetMs: 12_000,
  searchFastTimeoutMs: 5500,
  parallelSearchQueries: 3,
  fastSlugConcurrency: 4,
  impitMaxAttempts: 2,
  impitTotalExtraMs: 900,
  impitHttp3: true
});

const DIRECT_FETCH_TIMEOUT_MS = GS_TOP_SPEED.directFetchTimeoutMs;
const GS_IMPIT_MAX_ATTEMPTS = GS_TOP_SPEED.impitMaxAttempts;
const GS_IMPIT_TOTAL_EXTRA_MS = GS_TOP_SPEED.impitTotalExtraMs;
const GS_IMPIT_HTTP3 = GS_TOP_SPEED.impitHttp3;
const GS_ENABLE_IMPIT_FALLBACK = GS_TOP_SPEED.enableImpitFallback;
const GS_PREFER_IMPIT = GS_ENABLE_IMPIT_FALLBACK;
const GS_CLEARANCE_BRIDGE_MODE = GS_TOP_SPEED.clearanceBridgeMode;
const GS_IMPIT_BROWSER_FALLBACKS = Object.freeze(['chrome142', 'chrome136', 'chrome131', 'firefox144', 'firefox135', 'chrome125']);
const GS_EXTRACTOR_DIRECT_TIMEOUT_MS = 3200;
const GS_EXTRACTOR_IMPIT_TIMEOUT_MS = 1800;
const GS_BACKGROUND_CLEARANCE_ENABLED = GS_TOP_SPEED.backgroundClearanceEnabled;
const GS_BACKGROUND_PRIME_HOME = GS_TOP_SPEED.backgroundPrimeHome;
const GS_BACKGROUND_TITLE_PRIME = GS_TOP_SPEED.backgroundTitlePrime;
const GS_BACKGROUND_REFRESH_MS = GS_TOP_SPEED.backgroundRefreshMs;
const GS_BACKGROUND_REFRESH_EARLY_MS = GS_TOP_SPEED.backgroundRefreshEarlyMs;
const GS_BACKGROUND_PRIME_TIMEOUT_MS = GS_TOP_SPEED.backgroundPrimeTimeoutMs;
const GS_BACKGROUND_TITLE_PRIME_MAX = GS_TOP_SPEED.backgroundTitlePrimeMax;
const GS_PREWARM_START_DELAY_MS = GS_TOP_SPEED.prewarmStartDelayMs;
const GS_PREWARM_WAIT_MS = GS_TOP_SPEED.prewarmWaitMs;
const FLARE_WARMUP_TIMEOUT_MS = Math.max(
  12000,
  Math.min(
    60000,
    Number.parseInt(process.env.GUARDOSERIE_FLARE_TIMEOUT_MS || '40000', 10) || 40000
  )
);
const GS_REQUEST_CLEARANCE_WAIT_MS = Math.max(
  GS_PREWARM_WAIT_MS,
  Math.min(
    FLARE_WARMUP_TIMEOUT_MS + DIRECT_FETCH_TIMEOUT_MS + 1500,
    Math.max(6000, GS_TOP_SPEED.requestClearanceWaitMs)
  )
);

const DEBUG_GS              = envFlag('GUARDOSERIE_DEBUG', false);
const DEBUG_CF              = DEBUG_GS || envFlag('GUARDOSERIE_DEBUG_CF', envFlag('PROVIDER_SHIELD_DEBUG_CF', true)) || envFlag('FLARESOLVERR_DEBUG', false);
const GS_FLARE_PROVIDER_FAILURE_COOLDOWN_MS = GS_TOP_SPEED.flareProviderFailureCooldownMs;
const GS_FLARE_PROVIDER_FAILURE_COOLDOWN_MAX_MS = Math.max(GS_FLARE_PROVIDER_FAILURE_COOLDOWN_MS, GS_TOP_SPEED.flareProviderFailureCooldownMaxMs);
const GS_FLARE_ENDPOINT_FAILURE_COOLDOWN_MS = GS_TOP_SPEED.flareEndpointFailureCooldownMs;
const GS_FLARE_RETRY_COUNT = Math.max(0, Math.min(2, GS_TOP_SPEED.flareRetryCount));
const GS_FLARE_RETRY_BACKOFF_MS = Math.max(150, Math.min(3000, GS_TOP_SPEED.flareRetryBackoffMs));
const GS_BACKGROUND_RETRY_MS = Math.max(5000, Math.min(60000, GS_TOP_SPEED.backgroundRetryMs));
const GS_BACKGROUND_FORCE_STARTUP = GS_TOP_SPEED.backgroundForceStartup;
const GS_BACKGROUND_IGNORE_PROVIDER_COOLDOWN = GS_TOP_SPEED.backgroundIgnoreProviderCooldown;
const GS_SKIP_AJAX_AFTER_FALLBACK_HIT = true;
const GS_FAST_SLUG_FIRST           = true;
// TOP speed mode: background daemon owns FlareSolverr; hot Stremio requests stay Axios/session-only by default.
const GS_HOTPATH_FLARE_FALLBACK      = GS_TOP_SPEED.hotpathFlareFallback;
const GS_BACKGROUND_STATIC_PRIME     = GS_TOP_SPEED.backgroundStaticPrime;
const GS_MOVIE_FAST_SLUG_MAX         = GS_TOP_SPEED.movieFastSlugMax;
const GS_SERIES_FAST_SLUG_MAX        = GS_TOP_SPEED.seriesFastSlugMax;
const GS_MOVIE_MAX_VERIFY_CANDIDATES = GS_TOP_SPEED.movieMaxVerifyCandidates;
const GS_MOVIE_HARD_BUDGET_MS        = GS_TOP_SPEED.movieHardBudgetMs;
const GS_SEARCH_FAST_TIMEOUT_MS      = GS_TOP_SPEED.searchFastTimeoutMs;
const GS_PARALLEL_SEARCH_QUERIES     = GS_TOP_SPEED.parallelSearchQueries;
const GS_FAST_SLUG_CONCURRENCY       = GS_TOP_SPEED.fastSlugConcurrency;

const COMPILED_DIRECT_REGEX  = new RegExp(HOSTER_DIRECT_LINK_PATTERN, 'ig');
const COMPILED_ESCAPED_REGEX = new RegExp(HOSTER_ESCAPED_DIRECT_LINK_PATTERN, 'ig');

const GS_WP_SITEMAP_TTL_MS   = 45 * 60 * 1000;
const GS_WP_REST_TIMEOUT_MS  = 3200;
const GS_WP_SITEMAP_INDEX    = `${INITIAL_GS_DOMAIN}/wp-sitemap.xml`;
const gsSitemapCache = { fetchedAt: 0, entries: null };

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

const gsShield = createCloudflareBypass({
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
  sessionTimeoutFloorMs: GS_TOP_SPEED.sessionTimeoutFloorMs,
  postClearanceReplayTimeoutMs: Math.max(
    GS_TOP_SPEED.sessionTimeoutFloorMs,
    Math.min(12000, GS_TOP_SPEED.postClearanceReplayTimeoutMs)
  ),
  clearSessionOnTransportFailure: GS_TOP_SPEED.clearSessionOnTransportFailure,
  useRustShieldForSession: GS_TOP_SPEED.useRustShieldForSession,
  emergencyClearanceAfterSessionFailure: GS_TOP_SPEED.staleSessionEmergencyClearance,
  emergencyClearanceMinIntervalMs: GS_TOP_SPEED.staleSessionEmergencyCooldownMs,
  searchTimeoutMs: SEARCH_QUERY_TIMEOUT_MS,
  clearanceTimeoutMs: FLARE_WARMUP_TIMEOUT_MS,
  refreshDomainOnStart: true,
  domainProbeTimeoutMs: 2500,
  targetUrlClearance: true,
  originClearance: true,
  targetFallbackAfterOrigin: true,
  clearanceForce: false,
  homepageFallback: false,
  clearanceCooldownMs: Math.max(3000, GS_TOP_SPEED.flareClearanceCooldownMs),
  endpointFailureCooldownMs: GS_FLARE_ENDPOINT_FAILURE_COOLDOWN_MS,
  providerFailureCooldownMs: GS_FLARE_PROVIDER_FAILURE_COOLDOWN_MS,
  providerFailureCooldownMaxMs: GS_FLARE_PROVIDER_FAILURE_COOLDOWN_MAX_MS,
  flareRetryCount: GS_FLARE_RETRY_COUNT,
  flareRetryBackoffMs: GS_FLARE_RETRY_BACKOFF_MS,
  flareEndpoint: GS_TOP_SPEED.flareEndpoint,
  clearanceBridgeMode: GS_CLEARANCE_BRIDGE_MODE,
  preferImpit: GS_PREFER_IMPIT,
  impitTurbo: true,
  impitMaxAttempts: GS_IMPIT_MAX_ATTEMPTS,
  impitTotalExtraMs: GS_IMPIT_TOTAL_EXTRA_MS,
  impitHttp3: GS_IMPIT_HTTP3,
  impitSessionFastPath: true,
  impitAfterSessionChallenge: true,
  impitBrowserFallbacks: GS_IMPIT_BROWSER_FALLBACKS,
  impitChallengeStatuses: [403, 408, 425, 429, 500, 502, 503, 504, 520, 521, 522, 523, 524]
});

const gsHttp = gsShield.guard;
const lightClient = gsHttp.lightClient;
const smartFetch = (...args) => gsShield.fetchHtml(...args);
gsInfo('HTTP Shield active', gsShield.getState?.());
const refreshTargetDomain = (...args) => gsHttp.refreshTargetDomain(...args);
const buildGsUrl = pathname => gsHttp.buildProviderUrl(pathname);
const getTargetDomain = () => gsHttp.getCurrentBaseUrl();
const normalizeBaseUrl = value => gsHttp.normalizeBaseUrl(value);
const isAbortLikeError = error => gsHttp.isAbortLikeError(error);

function allowHotPathClearance() {
  if (GS_HOTPATH_FLARE_FALLBACK) return true;
  if (!GS_BACKGROUND_CLEARANCE_ENABLED) return false;
  return !gsHttp.getEndpoint();
}

function shouldForceGsClearanceNow(reason = 'request') {
  if (!GS_BACKGROUND_CLEARANCE_ENABLED || !gsHttp.getEndpoint()) return false;
  if (gsHttp.isSessionFresh()) return false;
  return isGsRequestClearanceGate(reason) || /(?:startup|daemon|retry|prime|movie|series)/i.test(String(reason || ''));
}

const gsExtractorClient = {
  async get(url, options = {}) {
    const headers = options.headers || {};
    const rawTimeout = Number(options.timeout || DIRECT_FETCH_TIMEOUT_MS) || DIRECT_FETCH_TIMEOUT_MS;
    const directTimeout = Math.max(1200, Math.min(rawTimeout, GS_EXTRACTOR_DIRECT_TIMEOUT_MS));
    const validateStatus = typeof options.validateStatus === 'function'
      ? options.validateStatus
      : status => status >= 200 && status < 400;

    const directOptions = {
      ...options,
      headers,
      timeout: directTimeout,
      responseType: options.responseType || 'text',
      validateStatus: status => status >= 200 && status < 600
    };

    let directResponse = null;
    let directError = null;
    try {
      directResponse = await lightClient.get(url, directOptions);
      const directData = typeof directResponse.data === 'string' ? directResponse.data : String(directResponse.data || '');
      const isBlocked = isCloudflareChallenge(directData, directResponse.status) || [403, 408, 425, 429, 500, 502, 503, 504, 520, 521, 522, 523, 524].includes(Number(directResponse.status));
      if (validateStatus(directResponse.status) && !isBlocked) return directResponse;
      gsDebug('extractor direct blocked', { url, status: directResponse.status, bytes: directData.length });
    } catch (error) {
      if (isAbortLikeError(error) && options.signal?.aborted) throw error;
      directError = error;
      gsDebug('extractor direct fallback', { url, error: error?.code || error?.message || String(error), timeout: directTimeout });
    }

    const directStatus = Number(directResponse?.status || directError?.response?.status || 0);
    const allowImpitFallback = !directError || ['ERR_BAD_REQUEST', 'ERR_BAD_RESPONSE'].includes(String(directError?.code || '')) || [403, 408, 425, 429, 500, 502, 503, 504, 520, 521, 522, 523, 524].includes(directStatus);

    if (allowImpitFallback) {
      try {
        const impitTimeout = Math.max(1000, Math.min(rawTimeout, GS_EXTRACTOR_IMPIT_TIMEOUT_MS));
        const response = await requestWithImpitRotating(url, {
          method: 'GET',
          headers,
          timeout: impitTimeout,
          signal: options.signal,
          responseType: options.responseType || 'text',
          innerRetry: { limit: 0 },
          maxBrowserAttempts: 1,
          totalTimeoutMs: impitTimeout + 250,
          retryOnStatuses: [403, 408, 425, 429, 500, 502, 503, 504, 520, 521, 522, 523, 524],
          retryOnChallenge: true,
          http3: GS_IMPIT_HTTP3,
          browserFallbacks: GS_IMPIT_BROWSER_FALLBACKS,
          ignoreTlsErrors: true,
          fingerprint: {
            userAgent: headers['User-Agent'] || headers['user-agent'] || gsHttp.getSession()?.userAgent
          }
        });

        if (response && validateStatus(response.statusCode)) {
          return {
            data: response.data,
            status: response.statusCode,
            statusCode: response.statusCode,
            headers: response.headers || {},
            request: { res: { responseUrl: response.url || url } },
            config: { url }
          };
        }
      } catch (error) {
        if (isAbortLikeError(error) && options.signal?.aborted) throw error;
        gsDebug('extractor impit rescue failed', { url, error: error?.code || error?.message || String(error), timeout: GS_EXTRACTOR_IMPIT_TIMEOUT_MS });
      }
    }

    if (directResponse && validateStatus(directResponse.status)) return directResponse;
    if (directError) throw directError;
    return directResponse || lightClient.get(url, options);
  }
};
let gsClearanceWarmupPromise = null;
let gsBackgroundInterval = null;
let gsBackgroundRetryTimer = null;

function getGsSessionAgeMs() {
  const ts = Number(gsHttp.getSession()?.timestamp || 0);
  return ts > 0 ? Date.now() - ts : Number.POSITIVE_INFINITY;
}

function shouldForceRefreshGsClearance() {
  if (!gsHttp.isSessionFresh()) return true;
  return getGsSessionAgeMs() >= Math.max(60_000, CF_SESSION_TTL - GS_BACKGROUND_REFRESH_EARLY_MS);
}

function scheduleGsClearanceRetry(reason = 'retry', delayMs = GS_BACKGROUND_RETRY_MS) {
  if (!GS_BACKGROUND_CLEARANCE_ENABLED || !gsHttp.getEndpoint() || gsHttp.isSessionFresh() || gsBackgroundRetryTimer) return null;
  gsBackgroundRetryTimer = setTimeout(() => {
    gsBackgroundRetryTimer = null;
    warmupGsClearanceInBackground(reason, {
      force: true,
      primeHome: true,
      ignoreProviderCooldown: GS_BACKGROUND_IGNORE_PROVIDER_COOLDOWN,
      retry: true
    });
  }, Math.max(1000, Number(delayMs) || GS_BACKGROUND_RETRY_MS));
  if (gsBackgroundRetryTimer?.unref) gsBackgroundRetryTimer.unref();
  gsDebug('background clearance retry scheduled', { reason, delayMs: Math.max(1000, Number(delayMs) || GS_BACKGROUND_RETRY_MS) });
  return gsBackgroundRetryTimer;
}

function warmupGsClearanceInBackground(reason = 'startup', options = {}) {
  const force = Boolean(options.force);
  const primeHome = options.primeHome !== false && GS_BACKGROUND_PRIME_HOME;
  const hasEndpoint = Boolean(gsHttp.getEndpoint());

  if (!GS_BACKGROUND_CLEARANCE_ENABLED && !force) return null;
  if (!force && !primeHome && gsHttp.isSessionFresh()) return null;
  if (gsClearanceWarmupPromise) return gsClearanceWarmupPromise;

  const startedAt = Date.now();
  const url       = buildGsUrl('/');
  const sessionFreshAtStart = gsHttp.isSessionFresh();
  const forceSolveNow = force || !sessionFreshAtStart || shouldForceGsClearanceNow(reason);
  const ignoreProviderCooldown = Boolean(options.ignoreProviderCooldown) || (forceSolveNow && GS_BACKGROUND_IGNORE_PROVIDER_COOLDOWN);
  gsDebug('background clearance start', { reason, url, force, forceSolve: forceSolveNow, primeHome, hasEndpoint, sessionFresh: sessionFreshAtStart, ignoreProviderCooldown });

  gsClearanceWarmupPromise = (async () => {
    let sessionReady = gsHttp.isSessionFresh();
    const forceSolve = forceSolveNow || !sessionReady;

    if (hasEndpoint && forceSolve) {
      const session = await gsHttp.ensureClearance(url, { force: true, ignoreProviderCooldown });
      sessionReady = Boolean(session && gsHttp.isSessionFresh());
    }

    let homeReady = false;
    if (primeHome || !sessionReady) {
      const html = await smartFetch(url, {
        ttl: TTL_SERIES,
        allowFlareSolverr: false,
        timeoutMs: sessionReady ? GS_BACKGROUND_PRIME_TIMEOUT_MS : DIRECT_FETCH_TIMEOUT_MS
      });
      homeReady = Boolean(html);
      sessionReady = sessionReady || gsHttp.isSessionFresh();
    }

    if (sessionReady || homeReady) primeGsStaticPagesInBackground(`${reason}-static-prime`);
    const ok = Boolean(sessionReady || homeReady);
    gsDebug('background clearance done', { reason, ok, sessionReady, homeReady, freshSession: gsHttp.isSessionFresh(), ageMs: getGsSessionAgeMs(), ms: Date.now() - startedAt });
    if (!ok && options.retry !== false) scheduleGsClearanceRetry(`${reason}-retry`);
    return ok;
  })().catch(error => {
    if (!isAbortLikeError(error)) gsDebug('background clearance failed', { reason, error: error?.message || String(error), ms: Date.now() - startedAt });
    if (options.retry !== false) scheduleGsClearanceRetry(`${reason}-retry`);
    return false;
  }).finally(() => {
    gsClearanceWarmupPromise = null;
  });

  return gsClearanceWarmupPromise;
}

function isGsRequestClearanceGate(reason = '') {
  return /^(?:request|movie|series|episode|stream)/i.test(String(reason || ''));
}

async function waitForGsClearancePrewarm(reason = 'request') {
  if (!GS_BACKGROUND_CLEARANCE_ENABLED) return gsHttp.isSessionFresh();
  if (gsHttp.isSessionFresh() || !gsHttp.getEndpoint()) {
    return gsHttp.isSessionFresh();
  }

  const startedAt = Date.now();
  const requestGate = isGsRequestClearanceGate(reason);
  const waitMs = requestGate
    ? Math.max(GS_PREWARM_WAIT_MS, GS_REQUEST_CLEARANCE_WAIT_MS)
    : GS_PREWARM_WAIT_MS;

  if (waitMs <= 0) return gsHttp.isSessionFresh();

  const warmup = warmupGsClearanceInBackground(reason, {
    primeHome: true,
    force: shouldForceGsClearanceNow(reason),
    ignoreProviderCooldown: GS_BACKGROUND_IGNORE_PROVIDER_COOLDOWN,
    retry: true
  });
  if (!warmup) return gsHttp.isSessionFresh();

  let timer = null;
  const timeout = new Promise(resolve => {
    timer = setTimeout(() => resolve('__timeout__'), waitMs);
    if (timer?.unref) timer.unref();
  });

  const result = await Promise.race([warmup, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });

  const fresh = gsHttp.isSessionFresh();
  if (result === '__timeout__') {
    gsDebug('prewarm wait timeout', { reason, freshSession: fresh, waitMs, requestGate, ms: Date.now() - startedAt });
  } else {
    gsDebug('prewarm wait done', { reason, ok: Boolean(result), freshSession: fresh, waitMs, requestGate, ms: Date.now() - startedAt });
  }
  return fresh;
}

function scheduleGsClearanceWarmup(reason = 'startup', delayMs = GS_PREWARM_START_DELAY_MS, options = {}) {
  if (!GS_BACKGROUND_CLEARANCE_ENABLED && !options.force) return null;
  const timer = setTimeout(() => {
    warmupGsClearanceInBackground(reason, options);
  }, Math.max(0, Number(delayMs) || 0));
  if (timer?.unref) timer.unref();
  return timer;
}

function extractWpSitemapLocs(xml) {
  return [...String(xml || '').matchAll(/<loc>([^<]+)<\/loc>/gi)]
    .map(m => String(m[1] || '').trim())
    .filter(Boolean);
}

function titleFromGsSlug(url) {
  try {
    const parts = new URL(url).pathname.split('/').filter(Boolean);
    const slug = decodeURIComponent(parts[parts.length - 1] || '');
    return slug
      .replace(/-stagione-\d+.*$/i, '')
      .replace(/-ep(?:isodio|isode)?\d+/i, '')
      .replace(/-\d+x\d+/i, '')
      .replace(/-\d+$/i, '')
      .replace(/-/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  } catch (_) { return ''; }
}

async function fetchGsWpSitemapEntries() {
  const now = Date.now();
  if (Array.isArray(gsSitemapCache.entries) && (now - gsSitemapCache.fetchedAt) < GS_WP_SITEMAP_TTL_MS) {
    return gsSitemapCache.entries;
  }

  try {
    const baseUrl = getTargetDomain();
    const sitemapIndexUrl = baseUrl.replace(/\/+$/, '') + '/wp-sitemap.xml';
    const indexXml = await smartFetch(sitemapIndexUrl, {
      ttl: GS_WP_SITEMAP_TTL_MS,
      allowFlareSolverr: false,
      timeoutMs: GS_WP_REST_TIMEOUT_MS
    }).catch(() => null);

    if (!indexXml || typeof indexXml !== 'string') return gsSitemapCache.entries || [];

    const subUrls = extractWpSitemapLocs(indexXml).filter(u => /wp-sitemap-posts/i.test(u));
    if (!subUrls.length) return gsSitemapCache.entries || [];

    const subXmls = await Promise.all(
      subUrls.slice(0, 3).map(u =>
        smartFetch(u, { ttl: GS_WP_SITEMAP_TTL_MS, allowFlareSolverr: false, timeoutMs: GS_WP_REST_TIMEOUT_MS }).catch(() => null)
      )
    );

    const baseDomain = new URL(baseUrl).hostname.replace(/^www\./, '');
    const entries = subXmls
      .filter(Boolean)
      .flatMap(xml => extractWpSitemapLocs(xml))
      .filter(u => {
        try { return new URL(u).hostname.replace(/^www\./, '') === baseDomain; } catch (_) { return false; }
      });

    if (entries.length > 0) {
      gsSitemapCache.entries = entries;
      gsSitemapCache.fetchedAt = Date.now();
    }
    return gsSitemapCache.entries || [];
  } catch (_) {
    return gsSitemapCache.entries || [];
  }
}

async function searchGsSitemapCandidates(expectedTitles) {
  try {
    const entries = await fetchGsWpSitemapEntries();
    if (!entries.length) return [];
    return entries
      .map(url => ({ url, title: titleFromGsSlug(url) }))
      .filter(c => c.title && normalizeTitleScoreMany(c.title, expectedTitles) > 0);
  } catch (_) { return []; }
}

async function searchGsViaRestApi(query, signal) {
  try {
    const baseUrl = getTargetDomain();
    const encodedQuery = encodeURIComponent(query);
    const restUrls = [
      `${baseUrl}/wp-json/wp/v2/search?search=${encodedQuery}&per_page=10&type=post&_fields=link,title`,
      `${baseUrl}/?rest_route=/wp/v2/search&search=${encodedQuery}&per_page=10&type=post&_fields=link,title`
    ];

    for (const restUrl of restUrls) {
      const raw = await smartFetch(restUrl, {
        ttl: TTL_SEARCH,
        signal,
        allowFlareSolverr: false,
        timeoutMs: GS_WP_REST_TIMEOUT_MS
      }).catch(() => null);
      if (!raw || typeof raw !== 'string') continue;
      try {
        const data = JSON.parse(raw);
        if (!Array.isArray(data)) continue;
        const results = data
          .filter(item => item?.link)
          .map(item => ({
            url: String(item.link),
            title: String(item.title?.rendered || item.title || '')
          }));
        if (results.length > 0) return results;
      } catch (_) {}
    }
    return [];
  } catch (_) { return []; }
}

function startGsBackgroundClearanceDaemon() {
  if (!GS_BACKGROUND_CLEARANCE_ENABLED || gsBackgroundInterval) return;

  scheduleGsClearanceWarmup('startup', GS_PREWARM_START_DELAY_MS, {
    primeHome: true,
    force: GS_BACKGROUND_FORCE_STARTUP,
    ignoreProviderCooldown: GS_BACKGROUND_IGNORE_PROVIDER_COOLDOWN,
    retry: true
  });

  gsBackgroundInterval = setInterval(() => {
    warmupGsClearanceInBackground('daemon', {
      force: shouldForceRefreshGsClearance(),
      primeHome: true,
      ignoreProviderCooldown: GS_BACKGROUND_IGNORE_PROVIDER_COOLDOWN,
      retry: true
    });
  }, GS_BACKGROUND_REFRESH_MS);
  if (gsBackgroundInterval?.unref) gsBackgroundInterval.unref();

  gsInfo('background clearance daemon active', {
    refreshMs: GS_BACKGROUND_REFRESH_MS,
    earlyRefreshMs: GS_BACKGROUND_REFRESH_EARLY_MS,
    primeHome: GS_BACKGROUND_PRIME_HOME,
    titlePrime: GS_BACKGROUND_TITLE_PRIME,
    prewarmWaitMs: GS_PREWARM_WAIT_MS,
    requestWaitMs: GS_REQUEST_CLEARANCE_WAIT_MS,
    retryMs: GS_BACKGROUND_RETRY_MS,
    providerFailureCooldownMs: GS_FLARE_PROVIDER_FAILURE_COOLDOWN_MS,
    providerFailureCooldownMaxMs: GS_FLARE_PROVIDER_FAILURE_COOLDOWN_MAX_MS,
    forceStartup: GS_BACKGROUND_FORCE_STARTUP
  });
}

function buildFastSlugTargetCandidates(expectedTitles = [], mediaType = 'series', maxTitles = 10) {
  const candidates = [];
  const seen = new Set();
  const pushPath = pathname => {
    const url = buildGsUrl(pathname);
    if (seen.has(url)) return;
    seen.add(url);
    candidates.push(url);
  };

  const titles = expandGsTitleAliases(expectedTitles, maxTitles);
  if (mediaType === 'movie') {
    const slugs = [];
    const seenSlug = new Set();
    for (const title of titles.slice(0, 8)) {
      for (const slug of slugifyGsMovieVariants(title)) {
        if (!slug || seenSlug.has(slug)) continue;
        seenSlug.add(slug);
        slugs.push(slug);
      }
    }


    for (const slug of slugs) pushPath(`/${slug}/`);
    for (const slug of slugs) pushPath(`/guarda-${slug}-streaming-ita/`);
    for (const slug of slugs.slice(0, 3)) pushPath(`/film/${slug}/`);
    for (const slug of slugs.slice(0, 2)) pushPath(`/movie/${slug}/`);
    return candidates.slice(0, 28);
  }

  for (const title of titles) {
    const slug = slugify(title);
    if (!slug) continue;
    for (const p of [`/serie/${slug}/`, `/serietv/${slug}/`, `/${slug}/`]) pushPath(p);
  }
  return candidates;
}

function allowExactGsSlugClearance(mediaType = 'series') {
  if (allowHotPathClearance()) return true;
  return ['series', 'movie'].includes(String(mediaType || '').toLowerCase()) && Boolean(gsHttp.getEndpoint()) && !gsHttp.isSessionFresh();
}

function primeGsUrlsInBackground(urls = [], options = {}) {
  if (!GS_BACKGROUND_TITLE_PRIME) return;
  const unique = Array.from(new Set((urls || []).filter(Boolean))).slice(0, options.max || GS_BACKGROUND_TITLE_PRIME_MAX);
  if (!unique.length) return;

  const ttl = options.ttl || TTL_SERIES;
  const reason = options.reason || 'title-prime';
  setImmediate(async () => {
    const startedAt = Date.now();
    let ok = 0;
    try {
      const rustWarmup = await gsHttp.warmupRustShield(unique, {
        timeoutMs: Math.min(GS_BACKGROUND_PRIME_TIMEOUT_MS, 1800),
        cacheTtlMs: ttl,
        staleTtlMs: ttl * 2,
        concurrency: Math.min(4, unique.length)
      });
      if (rustWarmup?.warmed || rustWarmup?.blocked) {
        gsDebug('background rust prime done', {
          reason,
          urls: unique.length,
          warmed: rustWarmup.warmed || 0,
          blocked: rustWarmup.blocked || 0,
          sessionBridge: Boolean(rustWarmup.sessionBridge),
          groups: rustWarmup.groups || 0,
          ms: rustWarmup.ms
        });
      }
    } catch (error) {
      if (!isAbortLikeError(error)) gsDebug('background rust prime failed', { reason, error: error?.message || String(error) });
    }
    for (const url of unique) {
      try {
        const html = await smartFetch(url, {
          ttl,
          allowFlareSolverr: false,
          timeoutMs: GS_BACKGROUND_PRIME_TIMEOUT_MS
        });
        if (html) ok += 1;
      } catch (error) {
        if (!isAbortLikeError(error)) gsDebug('background url prime failed', { reason, url, error: error?.message || String(error) });
      }
    }
    gsDebug('background url prime done', { reason, urls: unique.length, ok, ms: Date.now() - startedAt });
  });
}

function primeGsStaticPagesInBackground(reason = 'startup-static-prime') {
  if (!GS_BACKGROUND_STATIC_PRIME) return;
  primeGsUrlsInBackground([
    buildGsUrl('/'),
    buildGsUrl(GS_MOVIE_LIST_PATH),
    buildGsUrl('/film/'),
    buildGsUrl('/serie/'),
    buildGsUrl('/serietv/')
  ], {
    ttl: TTL_SEARCH,
    reason,
    max: 5
  });
}

startGsBackgroundClearanceDaemon();
scheduleGsClearanceWarmup('startup-static-after-clearance', Math.max(600, GS_PREWARM_START_DELAY_MS + 600), {
  primeHome: true,
  force: GS_BACKGROUND_FORCE_STARTUP,
  ignoreProviderCooldown: GS_BACKGROUND_IGNORE_PROVIDER_COOLDOWN,
  retry: true
});
primeGsStaticPagesInBackground('startup-static-prime');

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
    .replace(/[\u2018\u2019'`Â´]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function slugifyGsMovieVariants(val) {
  const raw = String(val || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/&amp;/g, '&')
    .trim();
  const variants = new Set();

  const compactApostrophe = raw.replace(/[\u2018\u2019'`Â´]/g, '');
  const hyphenApostrophe  = raw.replace(/[\u2018\u2019'`Â´]/g, '-');
  for (const value of [compactApostrophe, hyphenApostrophe, raw]) {
    const slug = value.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    if (slug) variants.add(slug);
  }

  const firstPart = raw.split(/\s[-â€“â€”:]\s/)[0]?.trim();
  if (firstPart && firstPart.length >= 3) {
    const firstSlug = slugify(firstPart);
    if (firstSlug) variants.add(firstSlug);
  }

  return Array.from(variants).filter(Boolean);
}

function extractYearValue(value) {
  const match = String(value || '').match(/\b(19\d{2}|20\d{2})\b/);
  return match ? parseInt(match[1], 10) : null;
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
  if (/^\d{4}(-\d{2}-\d{2})?$/.test(text)) return false;
  if (/^\d+$/.test(text)) return false;
  if (!/[a-zA-Z]/.test(text)) return false;
  return true;
}

function buildGsTitleAliases(value) {
  const raw = String(value || '').replace(/&amp;/gi, '&').replace(/\s+/g, ' ').trim();
  if (!raw) return [];
  const aliases = new Set([raw]);
  const plain = raw
    .replace(/\s*\((?:19|20)\d{2}\)\s*$/i, '')
    .replace(/\s*\[(?:19|20)\d{2}\]\s*$/i, '')
    .replace(/\s+(?:us|u\.?s\.?|usa|uk|u\.?k\.?|gb|jp|japan|kr|korea|anime|tv|serie|series)\s*$/i, '')
    .replace(/\s*[-â€“â€”:]\s*(?:us|u\.?s\.?|usa|uk|u\.?k\.?|hbo|max|netflix|prime|amazon|disney\+?)\s*$/i, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (plain && plain.length >= 2) aliases.add(plain);
  const withoutArticle = plain.replace(/^(?:the|a|an|il|lo|la|gli|le|un|una)\s+/i, '').trim();
  if (withoutArticle && withoutArticle.length >= 2) aliases.add(withoutArticle);
  return Array.from(aliases).filter(isUsableGsTitleForSearch);
}

function expandGsTitleAliases(values = [], max = 18) {
  const out = [];
  const seen = new Set();
  for (const value of values || []) {
    for (const alias of buildGsTitleAliases(value)) {
      const key = normalizeText(alias);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      out.push(alias);
      if (out.length >= max) return out;
    }
  }
  return out;
}

function normalizeTitleScoreMany(candidate, titles = []) {
  let best = 0;
  for (const title of uniqueCleanStrings(titles, 16)) {
    best = Math.max(best, normalizeTitleScore(candidate, title, null));
    if (best >= 3) break;
  }
  return best;
}

function hasExplicitAnimeSignal(meta = {}) {
  const type = String(meta?.type || meta?.kind || meta?.mediaType || meta?.contentType || '').toLowerCase();
  if (type === 'anime' || meta?.isAnime === true || meta?.anime === true || meta?.tmdbAnimeCandidate === true) return true;
  if (meta?.kitsu_id || meta?.kitsuId || meta?.kitsu) return true;

  return uniqueCleanStrings([
    meta?.requestedId,
    meta?.originalId,
    meta?.sourceId,
    meta?.source_id,
    meta?.stremioId,
    meta?.stremio_id,
    meta?.canonicalId,
    meta?.canonical_id,
    meta?.id
  ], 32).some(value => /^(?:kitsu|anime-kitsu):/i.test(String(value || '').trim()));
}

function canTrySharedAnimeContext(meta = {}) {
  if (!meta || meta?.isSeries === false) return false;
  const type = String(meta?.type || meta?.kind || meta?.mediaType || meta?.contentType || '').toLowerCase();
  if (type === 'movie') return false;
  return hasExplicitAnimeSignal(meta);
}

async function buildSharedAnimeContext(meta = {}, config = {}, season = null, episode = null) {
  if (!canTrySharedAnimeContext(meta)) return null;

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

function isLoadmPlayerUrl(url) {
  return /(?:^|\/\/|[./-])loadm(?:\.cam)?(?:[/:?#]|$)/i.test(String(url || ''));
}

function pickPreferredPlayerLinks(links = [], options = {}) {
  const max = Math.max(1, parseInt(options.max || 5, 10) || 5);
  const unique = Array.from(new Set((links || []).filter(Boolean)));
  const loadm = unique.filter(isLoadmPlayerUrl);


  if (options.preferLoadm !== false && loadm.length) return loadm.slice(0, max);
  return unique.slice(0, max);
}

function resolveGsMediaType(meta = {}) {
  const type = String(meta?.type || meta?.kind || meta?.mediaType || meta?.contentType || '').toLowerCase();
  if (
    meta?.isSeries === true ||
    type === 'series' || type === 'tv' || type === 'show' ||
    Number(meta?.season || 0) > 0 || Number(meta?.episode || 0) > 0
  ) return 'series';

  if (meta?.isSeries === false || type === 'movie' || type === 'film') return 'movie';


  return 'movie';
}

function isExcludedGsPath(pathname = '') {
  const p = String(pathname || '').toLowerCase();
  return (
    !p || p === '/' ||
    /\.(?:jpg|jpeg|png|webp|gif|svg|css|js|ico|json|xml|txt|mp4|m3u8)(?:$|[?#])/i.test(p) ||
    /^\/(?:wp-|wp\/|feed\/|comments\/|privacy|cookie|dmca|contatti|richieste|disclaimer|login|register|account|author\/|tag\/|tags\/|category\/|categorie\/|genre\/|genres\/|release-year\/|anno\/|cast\/|actors?\/|page\/|search\/)/i.test(p)
  );
}

function isLikelyGsContentHref(href, baseUrl) {
  const raw = String(href || '').trim();
  if (!raw || /^(?:#|javascript:|mailto:|tel:)/i.test(raw)) return false;
  if (/\/(?:serie|episodio)\//i.test(raw)) return true;

  try {
    const absolute = new URL(raw, baseUrl);
    const base = new URL(baseUrl);
    if (absolute.hostname.replace(/^www\./i, '') !== base.hostname.replace(/^www\./i, '')) return false;
    if (isExcludedGsPath(absolute.pathname)) return false;

    const parts = absolute.pathname.replace(/^\/+|\/+$/g, '').split('/').filter(Boolean);
    if (parts.length === 1) return parts[0].length >= 3;
    if (parts.length === 2 && /^(?:movie|film)$/i.test(parts[0])) return parts[1].length >= 3;
    return false;
  } catch (_) {
    return false;
  }
}

function isLikelyGsMovieUrl(url) {
  try {
    const parsed = new URL(String(url || ''), getTargetDomain());
    if (/\/(?:serie|episodio)\//i.test(parsed.pathname)) return false;
    return isLikelyGsContentHref(parsed.toString(), getTargetDomain());
  } catch (_) {
    return false;
  }
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
    if (!isLikelyGsContentHref(href, baseUrl)) return;
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
  const hotPathTimeout = Math.min(SEARCH_QUERY_TIMEOUT_MS, GS_SEARCH_FAST_TIMEOUT_MS);
  const allowClearance = allowHotPathClearance();

  const fetchFallback = () => smartFetch(fallbackUrl, {
    ttl: TTL_SEARCH,
    signal,
    allowFlareSolverr: allowClearance,
    timeoutMs: hotPathTimeout
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
    allowFlareSolverr: allowClearance,
    timeoutMs: hotPathTimeout
  }).catch((e) => {
    if (isAbortLikeError(e)) throw e;
    gsDebug('ajax search failed', { query, error: e?.message || String(e) });
    return '';
  });

  const [fallbackHtml, ajaxHtml, restResults] = await Promise.all([
    fetchFallback(),
    fetchAjax(),
    searchGsViaRestApi(query, signal).catch(() => [])
  ]);

  const fallbackResults = extractSearchResultsFromHtml(fallbackHtml, baseUrl);
  const ajaxResults = ajaxHtml ? extractSearchResultsFromHtml(ajaxHtml, baseUrl) : [];
  const results = [...fallbackResults, ...ajaxResults, ...restResults];

  const unique = Array.from(new Map(results.map(item => [item.url, item])).values());
  gsDebug('search query done', {
    query,
    fallbackResults: fallbackResults.length,
    ajaxResults: ajaxResults.length,
    restResults: restResults.length,
    results: unique.length,
    parallel: true,
    timeoutMs: hotPathTimeout,
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
  const clearanceBudgetMs = Math.min(GLOBAL_TIMEOUT_MS - 12000, FLARE_WARMUP_TIMEOUT_MS + DIRECT_FETCH_TIMEOUT_MS + 5000);
  const hotPathNoFlare = !allowHotPathClearance();
  const effectiveTimeoutMs = hotPathNoFlare
    ? Math.max(3500, Math.min(timeoutMs, GS_SEARCH_FAST_TIMEOUT_MS))
    : Math.max(timeoutMs, Math.max(18000, clearanceBudgetMs));
  const needsClearanceWindow = !gsHttp.isSessionFresh() && !hotPathNoFlare;

  const scoped = createTimeoutSignal(signal, effectiveTimeoutMs);
  try {
    gsDebug('search query start', { query, timeoutMs: effectiveTimeoutMs, needsClearanceWindow, hotPathNoFlare });
    return await searchProviderSequential(query, scoped.signal);
  } catch (e) {
    if (isAbortLikeError(e) || scoped.signal.aborted) {
      gsDebug('search query aborted', { query, timeoutMs: effectiveTimeoutMs, needsClearanceWindow, hotPathNoFlare, error: e?.message || String(e) });
      return [];
    }
    gsDebug('search query failed', { query, error: e?.message || String(e) });
    return [];
  } finally {
    scoped.clear();
  }
}

async function searchProviderParallel(queries, signal) {
  const uniqueQueries = Array.from(new Set(queries.filter(Boolean))).slice(0, GS_PARALLEL_SEARCH_QUERIES);
  if (!uniqueQueries.length) return [];
  // EasyStreams launches title/original-title searches together. We keep a small cap to avoid flooding GS.
  const results = await Promise.all(uniqueQueries.map(q => searchProviderWithTimeout(q, signal)));
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

  for (const semanticUrl of extractResilientEmbeds(raw, { baseUrl, maxCandidates: 32 })) {
    const c = normalize(semanticUrl);
    if (c && isLikelyPlayerUrl(c)) links.add(c);
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

async function buildGsStreamsFromPlayerLinks(playerLinks = [], options = {}) {
  const cleanTitle = options.cleanTitle || 'GuardoSerie';
  const signal = options.signal;
  const reqHost = options.reqHost || null;
  const sessionUA = gsHttp.getSession()?.userAgent || pickRandomProfile(BROWSER_PROFILES)?.ua || pickRandomProfile(BROWSER_PROFILES)?.userAgent;

  const processedResults = await asyncPool(2, playerLinks, async link => {
    try {
      const extracted = await extractFromUrl(link, {
        client:         gsExtractorClient,
        userAgent:      sessionUA,
        requestReferer: getTargetDomain(),
        fetchers: [
          (targetUrl, headers) => gsExtractorClient.get(targetUrl, {
            headers,
            timeout: Math.max(DIRECT_FETCH_TIMEOUT_MS, 5000),
            responseType: 'text'
          }).then(response => response.data)
        ]
      });

      if (!extracted?.url) {
        const def = resolveExtractorDefinition(link);
        return def ? buildLazyExtractorStream({
          embedUrl:      link,
          reqHost,
          provider:      'GuardoSerie',
          providerCode:  'GS',
          title:         cleanTitle,
          name:          def.label,
          quality:       'Unknown',
          referer:       getTargetDomain(),
          extra:         { _priority: def.priority ?? 9 }
        }) : null;
      }

      let quality = normalizeQuality(extracted?.quality || 'Unknown');
      let playlistIntel = null;
      if (/\.m3u8($|\?)/i.test(String(extracted.url))) {
        try {
          playlistIntel = await probePlaylistIntelligence(gsExtractorClient, extracted.url, {
            headers: extracted.headers || {},
            timeout: 5000,
            signal
          });
          quality = pickBetterQuality(playlistIntel?.quality || 'Unknown', quality);
        } catch (_) {}
      }

      let stream = buildWebStream({
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
      stream = decorateStreamWithPlaylistIntelligence(stream, playlistIntel);
      return stream;
    } catch (_) {
      const def = resolveExtractorDefinition(link);
      return def ? buildLazyExtractorStream({
        embedUrl:      link,
        reqHost,
        provider:      'GuardoSerie',
        providerCode:  'GS',
        title:         cleanTitle,
        name:          def.label,
        referer:       getTargetDomain(),
        extra:         { _priority: def.priority ?? 9 }
      }) : null;
    }
  });

  return normalizeStreams(processedResults
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
    }), {
      provider: 'guardoserie',
      providerLabel: 'GuardoSerie',
      providerCode: 'GS',
      sort: false,
      debug: DEBUG_GS
    });
}

function getGsPageTitle(html) {
  const $ = cheerio.load(String(html || ''));
  return String(
    $('h1').first().text() ||
    $('.entry-title, .post-title, .title, .name, .sheader .data h1, .data h1').first().text() ||
    $('meta[property="og:title"]').attr('content') ||
    $('meta[name="twitter:title"]').attr('content') ||
    $('title').first().text() ||
    ''
  ).replace(/\s*[-|]\s*Guardaserie.*$/i, '').replace(/\s+/g, ' ').trim();
}

function isGenericGsShellPage(html, pageTitle = '') {
  const titleKey = normalizeText(pageTitle || getGsPageTitle(html));
  if (!titleKey) return false;
  if (/^(?:guardaserie|guarda serie e film streaming completo|film streaming|serie tv)$/i.test(titleKey)) return true;
  const raw = String(html || '');
  const playerCount = extractPlayerLinksFromHtml(raw).length;
  const contentHints = /(?:loadm|mixdrop|voe|player|embed|iframe|trailer|streaming)/i.test(raw);
  return playerCount === 0 && !contentHints && titleKey.length <= 40 && /guardaserie|film streaming|serie tv/i.test(pageTitle || raw.slice(0, 600));
}

function readGsPageYear(html) {
  const raw = String(html || '');
  return (
    raw.match(/release-year\/(\d{4})/i)?.[1] ||
    raw.match(/(?:anno|year|release)[^0-9]{0,24}(19\d{2}|20\d{2})/i)?.[1] ||
    raw.match(/\b(19\d{2}|20\d{2})\b/)?.[1] ||
    null
  );
}

function isYearCompatibleForGs(candidateYear, targetYear, titleScore = 0) {
  if (!targetYear || !candidateYear) return true;
  const delta = Math.abs(Number(candidateYear) - Number(targetYear));
  const allowed = titleScore >= 3 ? 3 : 1;
  return Number.isFinite(delta) && delta <= allowed;
}

async function buildGsMovieSearchContext(meta = {}, signal = null) {
  let tmdbId = meta?.tmdb_id || meta?.tmdbId || null;
  if (!tmdbId && meta?.imdb_id) {
    const resolved = await tmdbHelper.getTmdbFromImdb(meta.imdb_id, { mediaHint: 'movie' }).catch(() => null);
    if (resolved) tmdbId = resolved;
  }

  let movieName = meta?.title || meta?.name || meta?.originalTitle || null;
  let originalTitle = meta?.originalTitle || meta?.canonicalTitle || null;
  let targetYear = extractYearValue(meta?.year || meta?.releaseYear || meta?.released || null);

  if (tmdbId && !signal?.aborted) {
    const tmdbMeta = await tmdbHelper.getMediaInfoFull(tmdbId, 'movie', { language: 'it-IT' }).catch(() => null);
    if (tmdbMeta) {
      movieName = tmdbMeta.title || movieName;
      originalTitle = tmdbMeta.original_title || originalTitle || null;
      targetYear = extractYearValue(tmdbMeta.year) || targetYear || null;
    }
  }

  const expectedTitles = expandGsTitleAliases([
    movieName,
    originalTitle,
    meta?.name,
    meta?.originalTitle,
    meta?.canonicalTitle,
    meta?.englishTitle,
    meta?.localizedTitle
  ], 18).slice(0, 14);

  return {
    movieName: movieName || expectedTitles[0] || null,
    originalTitle,
    targetYear,
    expectedTitles
  };
}

async function findGsTargetPage(expectedTitles = [], targetYear = null, signal = null, options = {}) {
  const mediaType = options.mediaType || 'series';
  const targetYearNumber = extractYearValue(targetYear);
  const startedAt = Date.now();
  const queries = uniqueCleanStrings(expectedTitles, mediaType === 'movie' ? 5 : 4);
  const fastSlugResults = await tryFastSlugTargets(expectedTitles, targetYear, signal, { mediaType });
  gsDebug(`${mediaType} fast slug done`, { results: fastSlugResults.length, ms: Date.now() - startedAt });

  let allResults = [...(options.mappedResults || []), ...fastSlugResults];
  if (!fastSlugResults.length) {
    const [searchResults, sitemapResults] = await Promise.all([
      searchProviderParallel(queries, signal),
      searchGsSitemapCandidates(expectedTitles).catch(() => [])
    ]);
    allResults.push(...searchResults, ...sitemapResults);
    gsDebug(`${mediaType} search fallback done`, { totalResults: allResults.length, search: searchResults.length, sitemap: sitemapResults.length, ms: Date.now() - startedAt });
  }

  allResults = Array.from(new Map(allResults.map(i => [i.url, i])).values());

  if (mediaType === 'movie') {
    const movieResults = allResults.filter(result => isLikelyGsMovieUrl(result.url));
    allResults = movieResults.length ? movieResults : allResults.filter(result => !/\/(?:serie|episodio)\//i.test(String(result.url || '')));
  } else {
    const seriesResults = allResults.filter(r => /\/(?:serie|serietv)\//i.test(r.url));
    const episodeResults = allResults.filter(r => /\/episodio\//i.test(r.url));
    const rootSlugResults = allResults.filter(r => r.fastSlug && !/\/(?:movie|film|guarda-|episodio)\//i.test(r.url));
    allResults = options.strictSeriesOnly && seriesResults.length ? seriesResults : [...seriesResults, ...episodeResults, ...rootSlugResults];
  }

  allResults.sort((a, b) =>
    normalizeTitleScoreMany(b.title, expectedTitles) -
    normalizeTitleScoreMany(a.title, expectedTitles)
  );

  let target = null;
  let bestLoose = null;

  for (const result of allResults.slice(0, mediaType === 'movie' ? GS_MOVIE_MAX_VERIFY_CANDIDATES : allResults.length)) {
    const titleScore = normalizeTitleScoreMany(result.title, expectedTitles);
    if (titleScore < 1) continue;

    const html = result.html || await smartFetch(result.url, {
      ttl: mediaType === 'movie' ? TTL_MOVIE : TTL_SERIES,
      signal,
      allowFlareSolverr: allowExactGsSlugClearance(mediaType),
      timeoutMs: DIRECT_FETCH_TIMEOUT_MS
    });
    if (!html) continue;

    const pageTitle = getGsPageTitle(html) || result.title;
    if (isGenericGsShellPage(html, pageTitle)) continue;
    const pageScore = Math.max(titleScore, normalizeTitleScoreMany(pageTitle, expectedTitles));
    const foundYear = readGsPageYear(html);

    if (targetYearNumber && foundYear) {
      if (isYearCompatibleForGs(foundYear, targetYearNumber, pageScore)) {
        target = { url: result.url, html, score: pageScore, title: pageTitle };
        break;
      }
    } else if (pageScore >= (bestLoose?.score || 0)) {
      bestLoose = { url: result.url, html, score: pageScore, title: pageTitle };
      if (pageScore >= 2) break;
    }
  }

  return target || bestLoose || null;
}

async function searchGuardaserieImpl(meta, config, reqHost = null) {
  if (!config?.filters?.enableGs) return [];

  const mediaType = resolveGsMediaType(meta);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), GLOBAL_TIMEOUT_MS);

  try {
    if (mediaType === 'series') {
      const kitsuInfo = getKitsuRequestFromMeta(meta);
      let season      = parseInt(meta?.season, 10);
      let episode     = parseInt(meta?.episode, 10) || kitsuInfo?.parsed?.episodeNumber || 1;

      if ((!season || season < 1) && kitsuInfo?.parsed?.kitsuId) season = kitsuInfo.parsed.seasonNumber || 1;
      if (!season || season < 1 || !episode || episode < 1) return [];

      return await _searchGuardaserie(meta, config, season, episode, controller.signal, reqHost);
    }

    return await _searchGuardaserieMovie(meta, config, controller.signal, reqHost);
  } catch (e) {
    gsDebug('provider failed', { mediaType, error: e?.message || String(e) });
    return [];
  } finally {
    clearTimeout(timer);
  }
}

function buildDirectEpisodeSlugCandidates(expectedTitles = [], season, episode) {
  const candidates = [];
  const seen = new Set();
  const s = parseInt(season, 10);
  const e = parseInt(episode, 10);
  if (!s || !e) return candidates;
  for (const title of expandGsTitleAliases(expectedTitles, 12)) {
    const slug = slugify(title);
    if (!slug) continue;
    for (const suffix of [
      `${slug}-stagione-${s}-episodio-${e}`,
      `${slug}-stagione-${s}-episodio-${String(e).padStart(2, '0')}`,
      `${slug}-s${String(s).padStart(2, '0')}e${String(e).padStart(2, '0')}`
    ]) {
      for (const pathname of [`/episodio/${suffix}`, `/episodio/${suffix}/`]) {
        const url = buildGsUrl(pathname);
        if (seen.has(url)) continue;
        seen.add(url);
        candidates.push(url);
      }
    }
  }
  return candidates.slice(0, 18);
}

async function tryFastSlugTargets(expectedTitles = [], targetYear = null, signal = null, options = {}) {
  if (!GS_FAST_SLUG_FIRST) return [];
  const mediaType = options.mediaType || 'series';
  const targetYearNumber = extractYearValue(targetYear);
  const candidates = buildFastSlugTargetCandidates(expectedTitles, mediaType, 10);
  const maxCandidates = mediaType === 'movie' ? GS_MOVIE_FAST_SLUG_MAX : GS_SERIES_FAST_SLUG_MAX;
  const startedAt = Date.now();
  const selectedCandidates = candidates.slice(0, maxCandidates);

  gsDebug(`${mediaType} fast slug start`, {
    candidates: selectedCandidates.slice(0, Math.min(maxCandidates, 6)),
    parallel: true,
    concurrency: GS_FAST_SLUG_CONCURRENCY,
    hotFlare: allowHotPathClearance()
  });

  const verifyCandidate = async (url) => {
    if (signal?.aborted) return null;
    if (mediaType === 'movie' && Date.now() - startedAt > GS_MOVIE_HARD_BUDGET_MS) return null;

    try {
      const html = await smartFetch(url, {
        ttl: mediaType === 'movie' ? TTL_MOVIE : TTL_SERIES,
        signal,
        allowFlareSolverr: allowExactGsSlugClearance(mediaType),
        timeoutMs: Math.min(DIRECT_FETCH_TIMEOUT_MS, mediaType === 'movie' ? 2800 : 3600)
      });
      if (!html) return null;

      const pageTitle = getGsPageTitle(html);
      if (isGenericGsShellPage(html, pageTitle)) {
        gsDebug(`${mediaType} fast slug generic shell rejected`, { url, pageTitle, bytes: String(html || '').length });
        return null;
      }

      const titleScore = normalizeTitleScoreMany(pageTitle, expectedTitles);
      if (titleScore < 2) return null;

      const foundYear = readGsPageYear(html);
      if (targetYearNumber && foundYear && !isYearCompatibleForGs(foundYear, targetYearNumber, titleScore)) return null;

      const links = extractPlayerLinksFromHtml(html).length;
      return { url, html, title: pageTitle || url, mapped: true, fastSlug: true, score: titleScore, links };
    } catch (e) {
      if (isAbortLikeError(e) && signal?.aborted) throw e;
      gsDebug(`${mediaType} fast slug candidate failed`, { url, error: e?.message || String(e) });
      return null;
    }
  };

  const verified = await asyncPool(
    Math.max(1, Math.min(GS_FAST_SLUG_CONCURRENCY, selectedCandidates.length)),
    selectedCandidates,
    verifyCandidate
  );

  const out = verified.filter(Boolean).sort((a, b) => {
    const scoreDelta = (b.score || 0) - (a.score || 0);
    if (scoreDelta !== 0) return scoreDelta;
    return (b.links || 0) - (a.links || 0);
  });

  if (out.length) gsInfo(`${mediaType} fast slug matched`, { count: out.length, first: out[0].url, ms: Date.now() - startedAt });
  return out;
}

async function _searchGuardaserie(meta, config, season, episode, signal, reqHost = null) {
  const providerStartedAt = Date.now();
  gsDebug('provider start', { title: meta?.title || meta?.name, season, episode, budgetMs: GLOBAL_TIMEOUT_MS, shieldEndpoint: gsHttp.getEndpoint() });
  await refreshTargetDomain(signal);
  await waitForGsClearancePrewarm('request');
  gsDebug('domain ready', { base: getTargetDomain(), sessionFresh: gsHttp.isSessionFresh(), ms: Date.now() - providerStartedAt, probed: gsHttp.isDomainProbeEnabled() });
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

  const expectedTitles = expandGsTitleAliases([
    showName,
    originalTitle,
    ...(Array.isArray(animeContext?.searchTitles) ? animeContext.searchTitles : []),
    ...(Array.isArray(animeContext?.rawTitles)    ? animeContext.rawTitles    : []),
    meta?.name,
    meta?.originalTitle,
    meta?.canonicalTitle,
    meta?.seriesTitle
  ], 18).slice(0, 14);

  gsDebug('title candidates ready', { titles: expectedTitles.slice(0, 8) });
  primeGsUrlsInBackground(buildFastSlugTargetCandidates(expectedTitles, 'series', 6), {
    ttl: TTL_SERIES,
    reason: 'series-title-prime'
  });

  showName = showName || expectedTitles[0] || null;
  if (!showName) return [];

  const mappedResults = (Array.isArray(animeContext?.mappingUrls) ? animeContext.mappingUrls : [])
    .map(url => ({ url, title: showName || url, mapped: true }));
  let target = await findGsTargetPage(expectedTitles, targetYear, signal, {
    mediaType: 'series',
    mappedResults,
    strictSeriesOnly: strictKitsu
  });

  if (!target) {
    const slugs = uniqueCleanStrings(expectedTitles, 3).map(slugify).filter(Boolean);
    outer: for (const slug of slugs) {
      for (const p of [`/serie/${slug}/`, `/serietv/${slug}/`, `/${slug}/`]) {
        const url  = buildGsUrl(p);
        const html = await smartFetch(url, { ttl: TTL_SERIES, signal, allowFlareSolverr: allowExactGsSlugClearance('series'), timeoutMs: Math.min(DIRECT_FETCH_TIMEOUT_MS, 4200) });
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

  let episodeUrl    = extractEpisodeUrlFromSeriesPage(target.html, season, episode, { strictEpisode: strictKitsu });
  let absoluteEpUrl = episodeUrl ? new URL(episodeUrl, getTargetDomain()).toString() : null;
  let finalHtml     = absoluteEpUrl ? await smartFetch(absoluteEpUrl, { ttl: TTL_EPISODE, signal, allowFlareSolverr: allowExactGsSlugClearance('series'), timeoutMs: DIRECT_FETCH_TIMEOUT_MS }) : '';
  let playerLinks   = pickPreferredPlayerLinks(extractPlayerLinksFromHtml(finalHtml), { preferLoadm: true, max: 5 });

  if (!playerLinks.length) {
    const directCandidates = buildDirectEpisodeSlugCandidates(expectedTitles, season, episode);
    primeGsUrlsInBackground(directCandidates, {
      ttl: TTL_EPISODE,
      reason: 'episode-slug-prime',
      max: Math.min(GS_BACKGROUND_TITLE_PRIME_MAX, 8)
    });
    for (const directUrl of directCandidates) {
      if (signal?.aborted) return [];
      try {
        const directHtml = await smartFetch(directUrl, { ttl: TTL_EPISODE, signal, allowFlareSolverr: allowExactGsSlugClearance('series'), timeoutMs: Math.min(DIRECT_FETCH_TIMEOUT_MS, 4200) });
        const directLinks = pickPreferredPlayerLinks(extractPlayerLinksFromHtml(directHtml), { preferLoadm: true, max: 5 });
        if (directLinks.length) {
          episodeUrl = directUrl;
          absoluteEpUrl = directUrl;
          finalHtml = directHtml;
          playerLinks = directLinks;
          gsDebug('direct episode slug accepted', { url: directUrl, links: directLinks.length });
          break;
        }
        gsDebug('direct episode slug rejected', { url: directUrl, links: directLinks.length });
      } catch (e) {
        if (isAbortLikeError(e) && signal?.aborted) throw e;
        gsDebug('direct episode slug failed', { url: directUrl, error: e?.message || String(e) });
      }
    }
  }

  if (!playerLinks.length) return [];

  const cleanTitle = `${showName} S${String(season).padStart(2, '0')}E${String(episode).padStart(2, '0')}`;
  return buildGsStreamsFromPlayerLinks(playerLinks, { cleanTitle, signal, reqHost });
}

async function _searchGuardaserieMovie(meta, config, signal, reqHost = null) {
  const providerStartedAt = Date.now();
  gsDebug('movie provider start', { title: meta?.title || meta?.name, budgetMs: GLOBAL_TIMEOUT_MS, shieldEndpoint: gsHttp.getEndpoint() });
  await refreshTargetDomain(signal);
  await waitForGsClearancePrewarm('request');
  gsDebug('movie domain ready', { base: getTargetDomain(), sessionFresh: gsHttp.isSessionFresh(), ms: Date.now() - providerStartedAt, probed: gsHttp.isDomainProbeEnabled() });
  if (signal?.aborted) return [];

  const movieContext = await buildGsMovieSearchContext(meta, signal);
  const expectedTitles = movieContext.expectedTitles || [];
  const movieName = movieContext.movieName || expectedTitles[0] || null;
  const targetYear = movieContext.targetYear || null;

  gsDebug('movie title candidates ready', { titles: expectedTitles.slice(0, 8), year: targetYear });
  primeGsUrlsInBackground(buildFastSlugTargetCandidates(expectedTitles, 'movie', 8), {
    ttl: TTL_MOVIE,
    reason: 'movie-title-prime',
    max: Math.max(GS_BACKGROUND_TITLE_PRIME_MAX, GS_MOVIE_FAST_SLUG_MAX)
  });
  if (!movieName || !expectedTitles.length) return [];

  let target = await findGsTargetPage(expectedTitles, targetYear, signal, { mediaType: 'movie' });

  if (!target) {
    const slugs = uniqueCleanStrings(expectedTitles, 4).map(slugify).filter(Boolean);
    outer: for (const slug of slugs) {
      for (const p of [`/${slug}/`, `/movie/${slug}/`, `/film/${slug}/`, `/guarda-${slug}-streaming-ita/`]) {
        const url = buildGsUrl(p);
        const html = await smartFetch(url, { ttl: TTL_MOVIE, signal, allowFlareSolverr: allowExactGsSlugClearance('movie'), timeoutMs: Math.min(DIRECT_FETCH_TIMEOUT_MS, 4200) });
        if (html) {
          const pageTitle = getGsPageTitle(html);
          if (!isGenericGsShellPage(html, pageTitle) && normalizeTitleScoreMany(pageTitle, expectedTitles) >= 2) {
            target = { url, html };
            break outer;
          }
        }
      }
    }
  }

  if (!target?.url || !target?.html) return [];

  const playerLinks = pickPreferredPlayerLinks(extractPlayerLinksFromHtml(target.html), { preferLoadm: true, max: 5 });
  gsDebug('movie player links extracted', {
    url: target.url,
    links: playerLinks.length,
    loadm: playerLinks.filter(isLoadmPlayerUrl).length,
    ms: Date.now() - providerStartedAt
  });

  if (!playerLinks.length) return [];

  const cleanYear = extractYearValue(targetYear);
  const cleanTitle = cleanYear ? `${movieName} (${cleanYear})` : movieName;
  return buildGsStreamsFromPlayerLinks(playerLinks, { cleanTitle, signal, reqHost });
}

async function searchGuardaserie(meta, config, reqHost = null) {
  return withProviderHealth('guardoserie', () => searchGuardaserieImpl(meta, config, reqHost), {
    swallowErrors: true,
    fallbackValue: []
  });
}

module.exports = { searchGuardaserie, searchGuardoSerie: searchGuardaserie };
