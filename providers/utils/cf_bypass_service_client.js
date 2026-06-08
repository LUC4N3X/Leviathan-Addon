'use strict';

const axios = require('axios');
const {
  envNumber,
  makeBypassCacheKey,
  runWithBypassTrafficGuard,
  withBypassRequestCoalescing,
  withBypassResponseCache
} = require('./bypass_traffic_guard');

function splitList(value) {
  if (Array.isArray(value)) return value;
  return String(value || '').split(/[\s,;]+/g);
}

function normalizeBypassEndpoint(value) {
  const raw = String(value || '').trim().replace(/\/+$/, '');
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (!['http:', 'https:'].includes(url.protocol)) return null;
    if (url.pathname === '/v1') url.pathname = '';
    url.search = '';
    url.hash = '';
    return `${url.protocol}//${url.host}${url.pathname.replace(/\/+$/, '')}`;
  } catch (_) {
    return null;
  }
}

function normalizeBypassEndpoints(...values) {
  const out = [];
  const seen = new Set();
  for (const value of values) {
    for (const part of splitList(value)) {
      const endpoint = normalizeBypassEndpoint(part);
      if (!endpoint || seen.has(endpoint)) continue;
      seen.add(endpoint);
      out.push(endpoint);
    }
  }
  return out;
}

function getConfiguredBypassEndpoints(...values) {
  return normalizeBypassEndpoints(
    ...values,
    process.env.CF_BYPASS_URLS,
    process.env.CF_BYPASS_URL,
    process.env.CLOUDFLARE_BYPASS_URLS,
    process.env.CLOUDFLARE_BYPASS_URL,
    process.env.CLOUDFLARE_BYPASS_BASE_URL
  );
}

function cleanHeaders(headers = {}) {
  const out = {};
  for (const [key, value] of Object.entries(headers || {})) {
    if (value == null) continue;
    const lower = String(key).toLowerCase();
    if ([
      'host',
      'content-length',
      'connection',
      'accept-encoding',
      'x-hostname',
      'x-proxy',
      'x-bypass-cache'
    ].includes(lower)) continue;
    out[key] = value;
  }
  return out;
}


function providerNameForGuard(requestOptions = {}) {
  return requestOptions.providerName || requestOptions.provider || requestOptions.hoster || 'cloudflare-bypass';
}

function guardOptionsFor(kind, requestOptions = {}) {
  return {
    kind,
    providerName: providerNameForGuard(requestOptions),
    signal: requestOptions.signal,
    proxy: requestOptions.proxy || requestOptions.proxyUrl || requestOptions.egressKey || 'default',
    minIntervalMs: requestOptions.guardMinIntervalMs,
    maxConcurrency: requestOptions.guardMaxConcurrency,
    maxQueue: requestOptions.guardMaxQueue
  };
}

function cacheTtlFromOptions(requestOptions = {}, envName, fallback = 0) {
  if (Number.isFinite(Number(requestOptions.cacheTtlMs))) return Math.max(0, Number(requestOptions.cacheTtlMs));
  return envNumber(envName, fallback, 0, 24 * 60 * 60 * 1000);
}

function cookieObjectToHeader(cookies = {}) {
  if (!cookies) return '';
  if (typeof cookies === 'string') return cookies;
  if (Array.isArray(cookies)) {
    return cookies
      .map(item => {
        if (!item) return '';
        if (typeof item === 'string') return item.split(';')[0].trim();
        const name = item.name || item.key;
        const value = item.value ?? item.val;
        return name && value != null ? `${name}=${value}` : '';
      })
      .filter(Boolean)
      .join('; ');
  }
  return Object.entries(cookies)
    .map(([name, value]) => {
      if (value == null) return '';
      if (value && typeof value === 'object') return `${name}=${value.value ?? value.val ?? ''}`;
      return `${name}=${value}`;
    })
    .filter(Boolean)
    .join('; ');
}

function cookiesObjectToSetCookieArray(cookies = {}, url = null) {
  const host = (() => {
    try { return new URL(String(url || '')).hostname; } catch (_) { return ''; }
  })();
  if (!cookies) return [];
  if (Array.isArray(cookies)) {
    return cookies.map(item => typeof item === 'string' ? item : cookieObjectToHeader([item])).filter(Boolean);
  }
  if (typeof cookies === 'string') {
    return cookies.split(';').map(x => x.trim()).filter(Boolean);
  }
  return Object.entries(cookies)
    .map(([name, value]) => {
      const cookieValue = value && typeof value === 'object' ? (value.value ?? value.val ?? '') : value;
      if (!name || cookieValue == null) return '';
      const attrs = ['Path=/'];
      if (host) attrs.push(`Domain=${host}`);
      return `${name}=${cookieValue}; ${attrs.join('; ')}`;
    })
    .filter(Boolean);
}

function responseHeaderValue(headers = {}, name = '') {
  const wanted = String(name || '').toLowerCase();
  for (const [key, value] of Object.entries(headers || {})) {
    if (String(key).toLowerCase() === wanted) return value;
  }
  return '';
}

function parseJsonMaybe(value) {
  if (!value || typeof value !== 'string') return value;
  const trimmed = value.trim();
  if (!trimmed || !/^[\[{]/.test(trimmed)) return value;
  try { return JSON.parse(trimmed); } catch (_) { return value; }
}

function buildUrl(base, pathname, query = {}) {
  const url = new URL(pathname, `${base.replace(/\/+$/, '')}/`);
  for (const [key, value] of Object.entries(query || {})) {
    if (value == null || value === '') continue;
    url.searchParams.set(key, String(value));
  }
  return url.toString();
}

function isRetryableBypassError(error) {
  const status = Number(error?.response?.status || error?.status || 0);
  const code = String(error?.code || '').toUpperCase();
  const message = String(error?.message || '').toLowerCase();
  return (
    ['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'ECONNABORTED', 'EAI_AGAIN', 'ENOTFOUND'].includes(code) ||
    code === 'ERR_NETWORK' ||
    message.includes('timeout') ||
    [500, 502, 503, 504, 522, 523, 524].includes(status)
  );
}

function createCloudflareBypassServiceClient(options = {}) {
  const endpoint = normalizeBypassEndpoint(options.endpoint || options.baseUrl || options.url);
  if (!endpoint) throw new Error('missing_cloudflare_bypass_endpoint');
  const httpClient = options.httpClient || axios;
  const defaultRetries = Math.max(1, Math.min(10, Number(options.retries || 5) || 5));

  async function requestWithRetry(fn, { retries = 1, retryBackoffMs = 750 } = {}) {
    let lastError = null;
    const attempts = Math.max(1, Number(retries || 1));
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        return await fn(attempt);
      } catch (error) {
        lastError = error;
        if (attempt >= attempts - 1 || !isRetryableBypassError(error)) break;
        const waitMs = Math.max(100, Math.min(3000, Number(retryBackoffMs || 750))) * (attempt + 1);
        await new Promise(resolve => setTimeout(resolve, waitMs));
      }
    }
    throw lastError;
  }

  async function health({ timeout = 6000, signal = null } = {}) {
    const response = await httpClient.get(buildUrl(endpoint, '/cache/stats'), {
      timeout,
      signal,
      validateStatus: status => status >= 200 && status < 600
    });
    if (response.status >= 400) throw new Error(`health_http_${response.status}`);
    return true;
  }

  async function getCookies(url, requestOptions = {}) {
    const targetUrl = String(url || '').trim();
    if (!targetUrl) throw new Error('missing_target_url');
    const timeout = Math.max(5000, Number(requestOptions.timeout || requestOptions.timeoutMs || 30000));
    const retries = Math.max(1, Math.min(10, Number(requestOptions.retries || defaultRetries) || defaultRetries));
    const proxy = requestOptions.proxy || requestOptions.proxyUrl || null;
    const bypassCookieCache = requestOptions.bypassCache || requestOptions.bypassCookieCache || requestOptions.force || false;
    const coalesceKey = makeBypassCacheKey(`cfbypass:cookies:${endpoint}`, targetUrl, {
      method: 'GET',
      proxy,
      vary: `${retries}:${bypassCookieCache ? 'force' : 'cached'}`
    });
    const cacheTtlMs = bypassCookieCache ? 0 : cacheTtlFromOptions(requestOptions, 'BYPASS_COOKIE_RESPONSE_CACHE_TTL_MS', 30_000);
    const staleMs = Math.max(cacheTtlMs, Number(requestOptions.cacheStaleMs || process.env.BYPASS_COOKIE_RESPONSE_CACHE_STALE_MS || cacheTtlMs * 2) || cacheTtlMs * 2);

    const run = () => runWithBypassTrafficGuard(targetUrl, async () => {
      const response = await requestWithRetry(() => httpClient.get(buildUrl(endpoint, '/cookies', { url: targetUrl, retries, proxy }), {
        timeout,
        signal: requestOptions.signal,
        validateStatus: status => status >= 200 && status < 600,
        headers: { Accept: 'application/json' }
      }), { retries: requestOptions.httpRetries || 1, retryBackoffMs: requestOptions.retryBackoffMs });
      if (response.status >= 400) {
        const detail = response.data?.detail || response.data?.message || response.statusText || `http_${response.status}`;
        const error = new Error(String(detail));
        error.status = response.status;
        error.response = response;
        throw error;
      }
      const payload = parseJsonMaybe(response.data) || {};
      const solution = payload.solution || {};
      const cookies = payload.cookies || solution.cookies || {};
      return {
        cookies,
        cookieHeader: cookieObjectToHeader(cookies),
        setCookie: cookiesObjectToSetCookieArray(cookies, targetUrl),
        userAgent: payload.user_agent || payload.userAgent || solution.userAgent || responseHeaderValue(response.headers, 'x-cf-bypasser-user-agent') || '',
        url: solution.url || payload.url || targetUrl,
        status: solution.status || payload.statusCode || response.status,
        headers: response.headers || {}
      };
    }, guardOptionsFor('solve', requestOptions));

    return withBypassResponseCache(coalesceKey, run, {
      enabled: requestOptions.coalesce !== false,
      ttlMs: cacheTtlMs,
      staleMs
    });
  }

  async function getHtml(url, requestOptions = {}) {
    const targetUrl = String(url || '').trim();
    if (!targetUrl) throw new Error('missing_target_url');
    const timeout = Math.max(5000, Number(requestOptions.timeout || requestOptions.timeoutMs || 30000));
    const retries = Math.max(1, Math.min(10, Number(requestOptions.retries || defaultRetries) || defaultRetries));
    const proxy = requestOptions.proxy || requestOptions.proxyUrl || null;
    const bypassCookieCache = requestOptions.bypassCache || requestOptions.bypassCookieCache || requestOptions.force || false;
    const cacheTtlMs = bypassCookieCache ? 0 : cacheTtlFromOptions(requestOptions, 'BYPASS_HTML_CACHE_TTL_MS', 0);
    const staleMs = Math.max(cacheTtlMs, Number(requestOptions.cacheStaleMs || process.env.BYPASS_HTML_CACHE_STALE_MS || cacheTtlMs * 2) || cacheTtlMs * 2);
    const coalesceKey = makeBypassCacheKey(`cfbypass:html:${endpoint}`, targetUrl, {
      method: 'GET',
      proxy,
      vary: `${retries}:${bypassCookieCache ? 'force' : 'cached'}`
    });

    const run = () => runWithBypassTrafficGuard(targetUrl, async () => {
      const response = await requestWithRetry(() => httpClient.get(buildUrl(endpoint, '/html', { url: targetUrl, retries, proxy, bypassCookieCache }), {
        timeout,
        signal: requestOptions.signal,
        responseType: 'text',
        transformResponse: [data => data],
        validateStatus: status => status >= 200 && status < 600,
        headers: { Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' }
      }), { retries: requestOptions.httpRetries || 1, retryBackoffMs: requestOptions.retryBackoffMs });
      if (response.status >= 400) {
        const error = new Error(`cloudflare_bypass_http_${response.status}`);
        error.status = response.status;
        error.response = response;
        throw error;
      }
      const payload = parseJsonMaybe(response.data);
      const solution = payload && typeof payload === 'object' ? (payload.solution || {}) : {};
      const html = typeof solution.response === 'string'
        ? solution.response
        : (typeof payload === 'string' ? payload : String(response.data || ''));
      return {
        html,
        status: solution.status || response.status,
        headers: response.headers || {},
        userAgent: solution.userAgent || responseHeaderValue(response.headers, 'x-cf-bypasser-user-agent') || '',
        finalUrl: solution.url || responseHeaderValue(response.headers, 'x-cf-bypasser-final-url') || targetUrl,
        cookiesCount: Number(responseHeaderValue(response.headers, 'x-cf-bypasser-cookies') || 0) || 0
      };
    }, guardOptionsFor('service', requestOptions));

    return withBypassResponseCache(coalesceKey, run, {
      enabled: requestOptions.coalesce !== false,
      ttlMs: cacheTtlMs,
      staleMs
    });
  }

  async function mirror(url, requestOptions = {}) {
    const target = new URL(String(url || ''));
    const timeout = Math.max(5000, Number(requestOptions.timeout || requestOptions.timeoutMs || 30000));
    const method = String(requestOptions.method || 'GET').toUpperCase();
    const proxy = requestOptions.proxy || requestOptions.proxyUrl || null;
    const bypassCache = requestOptions.bypassCache || requestOptions.force;
    const cacheTtlMs = method === 'GET' && !bypassCache
      ? cacheTtlFromOptions(requestOptions, 'BYPASS_MIRROR_CACHE_TTL_MS', 30_000)
      : 0;
    const staleMs = Math.max(cacheTtlMs, Number(requestOptions.cacheStaleMs || process.env.BYPASS_MIRROR_CACHE_STALE_MS || cacheTtlMs * 2) || cacheTtlMs * 2);
    const coalesceKey = makeBypassCacheKey(`cfbypass:mirror:${endpoint}`, target.toString(), {
      method,
      proxy,
      body: requestOptions.body ?? requestOptions.data ?? '',
      vary: bypassCache ? 'force' : 'cached'
    });

    const run = () => runWithBypassTrafficGuard(target.toString(), async () => {
      const mirrorUrl = `${endpoint}${target.pathname || '/'}${target.search || ''}`;
      const headers = {
        ...cleanHeaders(requestOptions.headers || {}),
        'x-hostname': target.host
      };
      if (proxy) headers['x-proxy'] = proxy;
      if (bypassCache) headers['x-bypass-cache'] = 'true';
      const response = await requestWithRetry(() => httpClient.request({
        url: mirrorUrl,
        method,
        data: method === 'GET' || method === 'HEAD' ? undefined : requestOptions.body ?? requestOptions.data ?? null,
        headers,
        timeout,
        signal: requestOptions.signal,
        responseType: requestOptions.responseType || 'text',
        transformResponse: [data => data],
        validateStatus: status => status >= 200 && status < 600,
        maxRedirects: 0
      }), { retries: requestOptions.httpRetries || 1, retryBackoffMs: requestOptions.retryBackoffMs });
      return {
        status: response.status,
        statusCode: response.status,
        data: response.data,
        body: response.data,
        headers: response.headers || {},
        url: responseHeaderValue(response.headers, 'x-cf-bypasser-final-url') || url,
        via: 'cloudflare-bypass-service'
      };
    }, guardOptionsFor('service', requestOptions));

    return withBypassResponseCache(coalesceKey, run, {
      enabled: requestOptions.coalesce !== false,
      ttlMs: cacheTtlMs,
      staleMs
    });
  }

  return {
    endpoint,
    health,
    getCookies,
    getHtml,
    mirror
  };
}

module.exports = {
  normalizeBypassEndpoint,
  normalizeBypassEndpoints,
  getConfiguredBypassEndpoints,
  createCloudflareBypassServiceClient,
  cookieObjectToHeader,
  cookiesObjectToSetCookieArray,
  isRetryableBypassError,
  cleanHeaders
};
