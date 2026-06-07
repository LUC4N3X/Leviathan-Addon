'use strict';

const { isCloudflareChallenge, requestWithImpitRotating } = require('./bypass');
const { runCurlCffiBypass } = require('./cloudflare_bypass');

const RETRYABLE_STATUSES = new Set([403, 408, 425, 429, 500, 502, 503, 504, 520, 521, 522, 523, 524]);

function responseText(value) {
  if (typeof value === 'string') return value;
  if (Buffer.isBuffer(value)) return value.toString('utf8');
  if (value == null) return '';
  try { return JSON.stringify(value); } catch (_) { return String(value || ''); }
}

function normalizeHeaders(headers = {}) {
  const out = {};
  for (const [key, value] of Object.entries(headers || {})) {
    out[String(key).toLowerCase()] = value;
  }
  return out;
}

function statusOf(response) {
  const value = Number(response?.statusCode ?? response?.status ?? response?.code ?? 0);
  return Number.isFinite(value) ? value : 0;
}

function dataOf(response) {
  return responseText(response?.data ?? response?.body ?? response?.html ?? response?.response ?? '');
}

function urlOf(response, fallbackUrl) {
  return response?.url || response?.request?.res?.responseUrl || response?.config?.url || fallbackUrl;
}

function isBlockedResponse(response, options = {}) {
  if (!response) return false;
  if (typeof options.isBlockedResponse === 'function') return Boolean(options.isBlockedResponse(response));
  const status = statusOf(response);
  const body = dataOf(response);
  const headers = response?.headers || {};
  if (isCloudflareChallenge(body, status, headers)) return true;
  return RETRYABLE_STATUSES.has(status) && /cloudflare|just a moment|checking your browser|cf-chl|challenge/i.test(body);
}

function shouldTryFallback(response, options = {}) {
  if (!response) return true;
  if (isBlockedResponse(response, options)) return true;
  return RETRYABLE_STATUSES.has(statusOf(response));
}

function isUsableResponse(response, options = {}) {
  if (!response) return false;
  const validateStatus = typeof options.validateStatus === 'function'
    ? options.validateStatus
    : status => status >= 200 && status < 400;
  return validateStatus(statusOf(response)) && !isBlockedResponse(response, options);
}

function toAxiosLikeResponse(response, via, fallbackUrl) {
  const status = statusOf(response) || (via === 'flaresolverr' ? 200 : 0);
  const data = dataOf(response);
  return {
    data,
    body: data,
    status,
    statusCode: status,
    headers: normalizeHeaders(response?.headers || response?.responseHeaders || {}),
    request: { res: { responseUrl: urlOf(response, fallbackUrl) } },
    config: { url: fallbackUrl },
    url: urlOf(response, fallbackUrl),
    via
  };
}

function normalizeCurlCffiResponse(result, fallbackUrl) {
  if (!result) return null;
  const status = Number(result.code || result.statusCode || result.solutionResponseStatus || result.status || 0) || 0;
  const html = responseText(result.html ?? result.response ?? result.solutionResponse ?? result.data ?? '');
  return {
    status,
    statusCode: status,
    data: html,
    body: html,
    headers: result.headers || result.responseHeaders || {},
    url: result.url || result.finalUrl || result.solvedUrl || result.solutionResponseUrl || fallbackUrl,
    challengeDetected: result.challengeDetected === true
  };
}

async function runDirectLayer(url, options = {}) {
  const client = options.directClient || options.client || options.lightClient;
  if (!client) return null;
  const method = String(options.method || 'GET').toUpperCase();
  const requestOptions = {
    ...options.directOptions,
    headers: options.headers || {},
    timeout: options.directTimeout || options.timeout,
    signal: options.signal,
    responseType: options.responseType || 'text',
    validateStatus: status => status >= 200 && status < 600
  };

  if (method === 'GET' && typeof client.get === 'function') return client.get(url, requestOptions);
  if (typeof client.request === 'function') {
    return client.request({
      ...requestOptions,
      url,
      method,
      data: method === 'GET' || method === 'HEAD' ? undefined : options.body ?? options.data
    });
  }
  return null;
}

async function runImpitLayer(url, options = {}) {
  const runner = options.impitRunner || requestWithImpitRotating;
  if (typeof runner !== 'function') return null;
  return runner(url, {
    method: options.method || 'GET',
    headers: options.headers || {},
    timeout: options.impitTimeout || options.timeout,
    signal: options.signal,
    responseType: options.responseType || 'text',
    innerRetry: options.impitInnerRetry || { limit: 0 },
    maxBrowserAttempts: options.impitMaxBrowserAttempts || options.maxBrowserAttempts || 1,
    totalTimeoutMs: options.impitTotalTimeoutMs,
    retryOnStatuses: options.retryOnStatuses || Array.from(RETRYABLE_STATUSES),
    retryOnChallenge: options.retryOnChallenge !== false,
    http3: options.impitHttp3,
    browserFallbacks: options.impitBrowserFallbacks || options.browserFallbacks,
    ignoreTlsErrors: options.ignoreTlsErrors,
    proxyUrl: options.proxyUrl,
    fingerprint: options.fingerprint
  });
}

async function runCurlCffiLayer(url, options = {}) {
  const runner = options.curlCffiRunner || runCurlCffiBypass;
  if (typeof runner !== 'function') return null;
  const result = await runner(url, options.providerName || 'provider', {
    headers: options.headers || {},
    referer: options.referer || options.headers?.Referer || options.headers?.referer || '',
    timeout: options.curlCffiTimeout || options.timeout,
    retries: options.curlCffiRetries ?? options.retries ?? 0,
    retryBackoffMs: options.curlCffiRetryBackoffMs || 0,
    warmupOrigin: options.curlCffiWarmupOrigin,
    browserHeaders: options.curlCffiBrowserHeaders,
    impersonate: options.curlCffiImpersonate || options.impersonate || 'auto',
    signalsJson: options.signalsJson || null,
    coalesceKey: options.curlCffiCoalesceKey || `${options.providerName || 'provider'}:curl_cffi:${url}`,
    envPrefix: options.envPrefix
  });
  return normalizeCurlCffiResponse(result, url);
}

async function runFlareSolverrLayer(url, options = {}) {
  const runner = options.flareSolverrRunner || options.flareRunner || options.shieldRunner;
  if (typeof runner !== 'function') return null;
  const result = await runner(url, {
    ...options,
    allowFlareSolverr: options.allowFlareSolverr !== false,
    allowCurlCffi: false
  });
  if (typeof result === 'string' || Buffer.isBuffer(result)) {
    return { status: 200, statusCode: 200, data: responseText(result), body: responseText(result), headers: {}, url };
  }
  return result;
}

async function tryLayer(name, url, options, runner) {
  try {
    const response = await runner(url, options);
    return response ? toAxiosLikeResponse(response, name, url) : null;
  } catch (error) {
    if (options.signal?.aborted) throw error;
    if (typeof options.onLayerError === 'function') options.onLayerError(name, error, url);
    return null;
  }
}

async function fetchLayeredText(url, options = {}) {
  const allowDirect = options.allowDirect !== false;
  const allowImpit = options.allowImpit !== false;
  const allowCurlCffi = options.allowCurlCffi !== false;
  const allowFlareSolverr = options.allowFlareSolverr !== false;
  let lastResponse = null;

  const layers = [
    allowDirect && ['direct', runDirectLayer],
    allowImpit && ['impit', runImpitLayer],
    allowCurlCffi && ['curl_cffi', runCurlCffiLayer],
    allowFlareSolverr && ['flaresolverr', runFlareSolverrLayer]
  ].filter(Boolean);

  for (const [name, runner] of layers) {
    if (lastResponse && !shouldTryFallback(lastResponse, options)) break;
    const response = await tryLayer(name, url, options, runner);
    if (!response) continue;
    lastResponse = response;
    if (isUsableResponse(response, options)) return response;
  }

  return lastResponse;
}

function createLayeredFetchClient(defaults = {}) {
  return {
    async get(url, options = {}) {
      return fetchLayeredText(url, { ...defaults, ...options, method: 'GET' });
    },
    async request(options = {}) {
      const url = options.url || options.href;
      return fetchLayeredText(url, { ...defaults, ...options, method: options.method || 'GET' });
    }
  };
}

module.exports = {
  createLayeredFetchClient,
  fetchLayeredText,
  isUsableResponse,
  shouldTryFallback,
  toAxiosLikeResponse
};
