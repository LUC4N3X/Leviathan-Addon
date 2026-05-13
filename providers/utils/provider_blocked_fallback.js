'use strict';

const { createProviderHttpGuard, envFlag } = require('./provider_http_guard');
const { isCloudflareChallenge } = require('./bypass');

const BLOCKED_STATUSES = new Set([403, 429, 503]);
const NETWORK_BLOCK_CODES = new Set([
  'ETIMEDOUT',
  'ECONNRESET',
  'ECONNABORTED',
  'EAI_AGAIN',
  'ENOTFOUND',
  'ERR_SOCKET_CLOSED',
  'ERR_BAD_RESPONSE',
  'ERR_BAD_REQUEST'
]);

function envNumber(name, fallback, min = 0) {
  const parsed = Number.parseInt(String(process.env[name] || ''), 10);
  if (!Number.isFinite(parsed) || parsed < min) return fallback;
  return parsed;
}

function safeText(value) {
  if (Buffer.isBuffer(value)) return value.toString('utf8');
  if (typeof value === 'string') return value;
  if (value == null) return '';
  try { return JSON.stringify(value); } catch (_) { return String(value || ''); }
}

function normalizeOrigin(value) {
  try {
    const u = new URL(String(value || '').trim());
    return `${u.protocol}//${u.host}`;
  } catch (_) {
    return null;
  }
}

function hostOf(value) {
  try { return new URL(String(value || '')).hostname.toLowerCase(); }
  catch (_) { return ''; }
}

function isSameSiteUrl(url, baseUrl) {
  const baseHost = hostOf(baseUrl);
  const targetHost = hostOf(url);
  return Boolean(baseHost && targetHost && (targetHost === baseHost || targetHost.endsWith(`.${baseHost}`)));
}

function isHtmlLikeUrl(url) {
  const clean = String(url || '').split('?')[0].toLowerCase();
  return !/\.(?:m3u8|mpd|mp4|m4v|mkv|avi|mov|webm|ts|m4a|aac|mp3|vtt|srt|ass|jpg|jpeg|png|webp|gif|svg|css|woff2?|ttf|ico)(?:$|[?#])/i.test(clean);
}

function isBlockedStatus(status) {
  return BLOCKED_STATUSES.has(Number(status || 0));
}

function isBlockedBody(body, status = 200) {
  const text = safeText(body);
  if (!text) return false;
  return isCloudflareChallenge(text, Number(status || 200));
}

function isBlockedError(error) {
  const status = Number(error?.response?.status || error?.status || error?.statusCode || 0);
  if (isBlockedStatus(status)) return true;

  const body = error?.response?.data || error?.body || '';
  if (body && isBlockedBody(body, status || 200)) return true;

  const code = String(error?.code || '').toUpperCase();
  const msg = String(error?.message || error || '').toLowerCase();
  if (NETWORK_BLOCK_CODES.has(code)) return true;
  return /(?:timeout|timed out|socket hang up|cloudflare|captcha|challenge|forbidden|too many requests|econnreset|econnaborted)/i.test(msg);
}

function shouldUseShield({ url, baseUrl, status = 0, body = '', error = null, allowOnNetworkError = true } = {}) {
  if (!url || !isSameSiteUrl(url, baseUrl) || !isHtmlLikeUrl(url)) return false;
  if (isBlockedStatus(status)) return true;
  if (isBlockedBody(body, status || 200)) return true;
  if (error && allowOnNetworkError && isBlockedError(error)) return true;
  return false;
}

function toAxiosLikeResponse({ url, html, status = 200, headers = {}, via = 'provider-shield' }) {
  return {
    data: html,
    status,
    statusCode: status,
    headers,
    via,
    config: { url },
    request: { res: { responseUrl: url } }
  };
}

function createBlockedFallbackGuard(options = {}) {
  const providerName = options.providerName || 'provider';
  const envPrefix = String(options.envPrefix || providerName).toUpperCase().replace(/[^A-Z0-9]+/g, '_');
  const baseUrl = normalizeOrigin(options.baseUrl || options.initialBaseUrl) || options.baseUrl || options.initialBaseUrl;
  const enabled = options.enabled ?? envFlag(`${envPrefix}_CF_FALLBACK`, true);
  const useRustShield = options.useRustShield ?? envFlag(`${envPrefix}_RUST_SHIELD`, true);
  const useRustShieldForSession = options.useRustShieldForSession ?? useRustShield;

  const guard = createProviderHttpGuard({
    providerName,
    logPrefix: options.logPrefix || `${envPrefix}-SHIELD`,
    initialBaseUrl: baseUrl,
    directFetchTimeoutMs: options.directFetchTimeoutMs || envNumber(`${envPrefix}_DIRECT_FETCH_TIMEOUT`, 4200, 1500),
    searchTimeoutMs: options.searchTimeoutMs || envNumber(`${envPrefix}_SEARCH_TIMEOUT`, 12000, 3000),
    clearanceTimeoutMs: options.clearanceTimeoutMs || envNumber(`${envPrefix}_FLARE_TIMEOUT`, envNumber('GS_FLARE_WARMUP_TIMEOUT_MS', 24000, 12000), 12000),
    refreshDomainOnStart: false,
    targetUrlClearance: true,
    homepageFallback: envFlag(`${envPrefix}_FLARE_HOMEPAGE_FALLBACK`, false),
    debug: envFlag(`${envPrefix}_DEBUG`, false),
    debugCf: envFlag(`${envPrefix}_DEBUG_CF`, envFlag('PROVIDER_SHIELD_DEBUG_CF', true)),
    fallbackUserAgent: options.fallbackUserAgent,
    profiles: options.profiles || [],
    pickProfile: options.pickProfile,
    challengeDetector: options.challengeDetector,
    sessionTtlMs: options.sessionTtlMs,
    maxCacheItems: options.maxCacheItems || 300,
    rustShieldUrl: options.rustShieldUrl,
    useRustShield,
    useRustShieldForSession
  });

  async function fetchHtml(url, fetchOptions = {}) {
    if (!enabled) return null;
    const html = await guard.smartFetch(url, {
      isPost: Boolean(fetchOptions.isPost || fetchOptions.method === 'POST'),
      body: fetchOptions.body || fetchOptions.data || null,
      ttl: fetchOptions.ttl || 10 * 60 * 1000,
      signal: fetchOptions.signal || null,
      allowFlareSolverr: fetchOptions.allowFlareSolverr !== false,
      timeoutMs: fetchOptions.timeoutMs || fetchOptions.timeout || guard.directFetchTimeoutMs
    });
    return html || null;
  }

  async function fetchAxiosLike(url, fetchOptions = {}) {
    const html = await fetchHtml(url, fetchOptions);
    if (!html) return null;
    return toAxiosLikeResponse({ url, html, via: fetchOptions.via || 'provider-shield' });
  }

  return {
    enabled,
    baseUrl,
    guard,
    fetchHtml,
    fetchAxiosLike,
    shouldUseShield: params => enabled && shouldUseShield({ baseUrl, ...params }),
    isBlockedStatus,
    isBlockedBody,
    isBlockedError,
    isSameSiteUrl: url => isSameSiteUrl(url, baseUrl),
    isHtmlLikeUrl,
    toAxiosLikeResponse
  };
}

module.exports = {
  createBlockedFallbackGuard,
  shouldUseShield,
  isBlockedStatus,
  isBlockedBody,
  isBlockedError,
  isSameSiteUrl,
  isHtmlLikeUrl,
  toAxiosLikeResponse,
  safeText
};
