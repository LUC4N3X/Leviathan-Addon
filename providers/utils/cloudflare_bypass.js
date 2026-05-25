'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

let providerHttpGuardFactory = null;

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

const SCRAPLING_PYTHON = String.raw`
import argparse
import json
import sys
import time
from urllib.parse import urlparse

def emit(payload, code=0):
    print(json.dumps(payload, ensure_ascii=False))
    sys.exit(code)

def cookie_header_to_scrapling(cookie_header, url):
    cookies = []
    if not cookie_header:
        return cookies
    host = urlparse(url).hostname or ''
    domain = host if host.startswith('.') else ('.' + host if host else '')
    for raw in str(cookie_header).split(';'):
        if '=' not in raw:
            continue
        name, value = raw.strip().split('=', 1)
        if not name:
            continue
        item = {'name': name, 'value': value, 'path': '/'}
        if domain:
            item['domain'] = domain
        cookies.append(item)
    return cookies

def serialize_cookies(value):
    if not value:
        return []
    if isinstance(value, list):
        return value
    if isinstance(value, dict):
        out = []
        for name, cookie_value in value.items():
            if isinstance(cookie_value, dict):
                item = dict(cookie_value)
                item.setdefault('name', name)
                out.append(item)
            else:
                out.append({'name': name, 'value': str(cookie_value)})
        return out
    try:
        return list(value)
    except Exception:
        return []

def main():
    parser = argparse.ArgumentParser(description='Embedded Scrapling Cloudflare bypass')
    parser.add_argument('url')
    parser.add_argument('--method', default='GET')
    parser.add_argument('--data')
    parser.add_argument('--headers')
    parser.add_argument('--timeout', type=int, default=60000)
    parser.add_argument('--wait-until', default='domcontentloaded')
    args = parser.parse_args()

    try:
        from scrapling.fetchers import StealthyFetcher
    except Exception as exc:
        emit({'status': 'error', 'message': 'scrapling_not_available: ' + str(exc)}, 1)

    headers = {}
    if args.headers:
        try:
            headers = json.loads(args.headers)
        except Exception:
            headers = {}

    user_agent = headers.pop('User-Agent', None) or headers.pop('user-agent', None)
    cookie_header = headers.pop('Cookie', None) or headers.pop('cookie', None)
    cookies = cookie_header_to_scrapling(cookie_header, args.url)

    fetch_kwargs = {
        'headless': True,
        'solve_cloudflare': True,
        'wait_until': args.wait_until,
        'timeout': args.timeout,
        'extra_headers': headers,
        'cookies': cookies,
    }
    if user_agent:
        fetch_kwargs['useragent'] = user_agent

    try:
        if str(args.method or 'GET').upper() == 'POST':
            response = StealthyFetcher.fetch(args.url, method='POST', body=args.data, **fetch_kwargs)
        else:
            response = StealthyFetcher.fetch(args.url, **fetch_kwargs)
        time.sleep(1)
        request_headers = getattr(response, 'request_headers', None) or {}
        ua = request_headers.get('user-agent') or request_headers.get('User-Agent') or user_agent or ''
        emit({
            'status': 'ok',
            'code': getattr(response, 'status', 200),
            'url': str(getattr(response, 'url', args.url)),
            'html': getattr(response, 'html_content', '') or getattr(response, 'text', '') or '',
            'headers': dict(getattr(response, 'headers', {}) or {}),
            'cookies': serialize_cookies(getattr(response, 'cookies', [])),
            'userAgent': ua,
            'requestHeaders': request_headers
        })
    except Exception as exc:
        emit({'status': 'error', 'message': str(exc)}, 1)

if __name__ == '__main__':
    main()
`;

function envNumber(name, fallback, min = 0, max = Number.POSITIVE_INFINITY) {
  const parsed = Number.parseInt(String(process.env[name] || ''), 10);
  if (!Number.isFinite(parsed) || parsed < min) return fallback;
  return Math.min(parsed, max);
}

function envFlag(name, fallback = false) {
  const raw = process.env[name];
  if (raw == null || raw === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(raw).trim().toLowerCase());
}

function envFlagNotFalse(name, fallback = true) {
  const raw = process.env[name];
  if (raw == null || raw === '') return fallback;
  return !['0', 'false', 'no', 'off'].includes(String(raw).trim().toLowerCase());
}

function getProviderHttpGuardFactory() {
  if (!providerHttpGuardFactory) {
    ({ createProviderHttpGuard: providerHttpGuardFactory } = require('./provider_http_guard'));
  }
  return providerHttpGuardFactory;
}

function safeString(value) {
  if (value == null) return '';
  if (Buffer.isBuffer(value)) return value.toString('utf8');
  if (typeof value === 'string') return value;
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

function normalizeProviderName(value) {
  return String(value || 'provider').trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'provider';
}

function envPrefixFor(providerName, explicit = null) {
  return String(explicit || normalizeProviderName(providerName)).toUpperCase().replace(/[^A-Z0-9]+/g, '_');
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

function isCloudflareChallenge(body, status) {
  if ([403, 429, 503].includes(Number(status))) return true;
  const text = safeString(body);
  return (
    /just a moment|checking your browser|cloudflare ray id|cf-browser-verification/i.test(text)
    || /enable javascript and cookies|<div id=["']cf-wrapper["']|cf-chl-widget|__cf_chl_opt|cf\.challenge\.orchestrate/i.test(text)
    || (/challenge-platform|_cf_chl_opt|cf_clearance/i.test(text) && text.length < 20000)
  );
}

function isBlockedBody(body, status = 200) {
  const text = safeString(body);
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

function shouldUseCloudflareBypass({ url, baseUrl, status = 0, body = '', error = null, allowOnNetworkError = true } = {}) {
  if (!url || !isSameSiteUrl(url, baseUrl) || !isHtmlLikeUrl(url)) return false;
  if (isBlockedStatus(status)) return true;
  if (isBlockedBody(body, status || 200)) return true;
  if (error && allowOnNetworkError && isBlockedError(error)) return true;
  return false;
}

function isUsefulHtml(value, status = 200) {
  const text = safeString(value).trim();
  if (!text || text.length < 32) return false;
  if (isCloudflareChallenge(text, status)) return false;
  if (/turnstile\.cloudflare\.com|cf-chl-widget|__cf_chl_opt|cf\.challenge\.orchestrate/i.test(text)) return false;
  return /<html[\s>]|<!doctype\s+html|<body[\s>]/i.test(text) || text.length >= 200;
}

function createBypassQueue(options = {}) {
  const maxConcurrent = Math.max(1, Number(options.maxConcurrent || envNumber('SCRAPLING_MAX_CONCURRENT', 2, 1, 12)) || 2);
  const maxQueue = Math.max(0, Number(options.maxQueue ?? envNumber('SCRAPLING_MAX_QUEUE', 20, 0, 1000)) || 0);
  const queueTimeoutMs = Math.max(1000, Number(options.queueTimeoutMs || envNumber('SCRAPLING_QUEUE_TIMEOUT_MS', 60_000, 1000)) || 60_000);
  const waiting = [];
  let active = 0;

  function releaseOnce() {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      active = Math.max(0, active - 1);
      drain();
    };
  }

  function drain() {
    while (active < maxConcurrent && waiting.length) {
      const entry = waiting.shift();
      if (!entry || entry.done) continue;
      entry.done = true;
      clearTimeout(entry.timeoutId);
      active += 1;
      entry.resolve(releaseOnce());
    }
  }

  function acquire(providerName, url) {
    if (active < maxConcurrent) {
      active += 1;
      return Promise.resolve(releaseOnce());
    }

    if (waiting.length >= maxQueue) {
      return Promise.reject(new Error(`scrapling_queue_full:${providerName}:${waiting.length}/${maxQueue}:${url}`));
    }

    return new Promise((resolve, reject) => {
      const entry = {
        providerName,
        url,
        done: false,
        resolve,
        reject,
        timeoutId: null
      };
      entry.timeoutId = setTimeout(() => {
        if (entry.done) return;
        entry.done = true;
        const index = waiting.indexOf(entry);
        if (index >= 0) waiting.splice(index, 1);
        reject(new Error(`scrapling_queue_timeout:${providerName}:${queueTimeoutMs}`));
      }, queueTimeoutMs);
      if (entry.timeoutId?.unref) entry.timeoutId.unref();
      waiting.push(entry);
    });
  }

  return {
    acquire,
    state: () => ({ active, queued: waiting.length, maxConcurrent, maxQueue, queueTimeoutMs })
  };
}

const defaultScraplingQueue = createBypassQueue();
const activeScraplingBypasses = new Map();

function resolvePythonExecutable() {
  const explicit = String(process.env.SCRAPLING_PYTHON || process.env.PYTHON_BIN || '').trim();
  if (explicit) return explicit;
  const venvPython = path.join(process.cwd(), '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
  try { if (fs.existsSync(venvPython)) return venvPython; } catch (_) {}
  return process.platform === 'win32' ? 'python' : 'python3';
}

function parseJsonFromStdout(stdout) {
  const raw = String(stdout || '').trim();
  if (!raw) return null;
  try { return JSON.parse(raw); } catch (_) {}
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try { return JSON.parse(raw.slice(start, end + 1)); } catch (_) {}
  }
  return null;
}

function execScraplingBypass(url, providerName = 'provider', options = {}) {
  return new Promise((resolve, reject) => {
    const method = String(options.method || (options.isPost ? 'POST' : 'GET')).toUpperCase();
    const timeout = Math.max(5000, Number(options.timeout || options.timeoutMs || process.env.SCRAPLING_TIMEOUT_MS || 60_000) || 60_000);
    const args = [
      '-c',
      SCRAPLING_PYTHON,
      String(url),
      '--timeout', String(timeout),
      '--wait-until', String(options.waitUntil || process.env.SCRAPLING_WAIT_UNTIL || 'domcontentloaded')
    ];
    if (method) args.push('--method', method);
    if (options.body || options.data) args.push('--data', String(options.body || options.data));
    if (options.headers) args.push('--headers', JSON.stringify(options.headers));

    const child = spawn(resolvePythonExecutable(), args, { windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk.toString(); });
    child.stderr.on('data', chunk => { stderr += chunk.toString(); });
    child.on('error', reject);
    child.on('close', code => {
      const payload = parseJsonFromStdout(stdout);
      if (payload?.status === 'ok') return resolve(payload);
      if (payload?.status === 'error') return reject(new Error(payload.message || 'scrapling_error'));
      if (code !== 0) return reject(new Error(stderr.trim() || `scrapling_exit_${code}`));
      return reject(new Error('scrapling_invalid_output'));
    });
  });
}

async function runScraplingBypass(url, providerName = 'provider', options = {}) {
  const queue = options.queue || defaultScraplingQueue;
  const key = String(options.coalesceKey || providerName || 'provider');
  if (activeScraplingBypasses.has(key)) return activeScraplingBypasses.get(key);

  const promise = (async () => {
    const release = await queue.acquire(providerName, url);
    try {
      const runner = typeof options.runner === 'function' ? options.runner : execScraplingBypass;
      return await runner(url, providerName, options);
    } finally {
      release();
    }
  })().finally(() => {
    activeScraplingBypasses.delete(key);
  });

  activeScraplingBypasses.set(key, promise);
  return promise;
}

function normalizeCookieObject(cookie) {
  if (!cookie) return null;
  if (typeof cookie === 'string') {
    const clean = cookie.trim().split(';')[0];
    const index = clean.indexOf('=');
    if (index <= 0) return null;
    return { name: clean.slice(0, index).trim(), value: clean.slice(index + 1).trim() };
  }
  if (typeof cookie !== 'object') return null;
  const name = cookie.name || cookie.key;
  const value = cookie.value ?? cookie.val;
  if (!name || value == null) return null;
  return {
    name: String(name),
    value: String(value),
    domain: cookie.domain || cookie.host || null,
    path: cookie.path || '/'
  };
}

function normalizeScraplingResult(result = {}, providerName = 'provider', fallbackUrl = null) {
  const solvedUrl = String(result.url || result.solvedUrl || fallbackUrl || '').trim();
  const baseUrl = normalizeOrigin(solvedUrl) || normalizeOrigin(fallbackUrl) || null;
  const rawCookies = Array.isArray(result.cookies) ? result.cookies : [];
  const cookies = [];
  const cookieDomains = [];
  const seenCookies = new Set();
  const seenDomains = new Set();

  for (const rawCookie of rawCookies) {
    const cookie = normalizeCookieObject(rawCookie);
    if (!cookie) continue;
    const key = cookie.name;
    if (seenCookies.has(key)) continue;
    seenCookies.add(key);
    cookies.push(`${cookie.name}=${cookie.value}`);
    if (cookie.domain && !seenDomains.has(cookie.domain)) {
      seenDomains.add(cookie.domain);
      cookieDomains.push(cookie.domain);
    }
  }

  const cookieHeader = cookies.join('; ');
  const session = {
    providerName,
    userAgent: result.userAgent || result.ua || result.requestHeaders?.['user-agent'] || result.requestHeaders?.['User-Agent'] || '',
    cookies: cookieHeader,
    url: baseUrl,
    solvedUrl,
    response: result.html || result.response || '',
    solutionResponse: result.html || result.response || '',
    solutionResponseUrl: solvedUrl,
    solutionResponseStatus: Number(result.code || result.statusCode || result.status || 200) || 200,
    cookieDomains,
    requestHeaders: result.requestHeaders || {},
    timestamp: Number(result.timestamp || Date.now()),
    scrapling: true
  };

  const cfCookie = rawCookies.map(normalizeCookieObject).find(cookie => cookie?.name === 'cf_clearance');
  if (cfCookie) session.cf_clearance = cfCookie.value;
  return session;
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

function createCloudflareBypass(options = {}) {
  const providerName = normalizeProviderName(options.providerName || options.provider || 'provider');
  const envPrefix = envPrefixFor(providerName, options.envPrefix);
  const baseUrl = normalizeOrigin(options.baseUrl || options.initialBaseUrl) || options.baseUrl || options.initialBaseUrl;
  const enabled = options.enabled ?? envFlag(`${envPrefix}_CF_FALLBACK`, true);
  const scraplingEnabled = options.scraplingEnabled ?? envFlag(`${envPrefix}_SCRAPLING_ENABLED`, envFlag('SCRAPLING_ENABLED', false));
  const useRustShield = options.useRustShield ?? envFlag(`${envPrefix}_RUST_SHIELD`, true);
  const useRustShieldForSession = options.useRustShieldForSession ?? useRustShield;
  const logger = options.logger || null;
  const guard = options.guard || getProviderHttpGuardFactory()({
    ...options,
    providerName,
    logPrefix: options.logPrefix || `${envPrefix}-SHIELD`,
    initialBaseUrl: baseUrl,
    directFetchTimeoutMs: options.directFetchTimeoutMs || envNumber(`${envPrefix}_DIRECT_FETCH_TIMEOUT`, 4200, 1500),
    searchTimeoutMs: options.searchTimeoutMs || envNumber(`${envPrefix}_SEARCH_TIMEOUT`, 12000, 3000),
    clearanceTimeoutMs: options.clearanceTimeoutMs || envNumber(`${envPrefix}_FLARE_TIMEOUT`, envNumber('GS_FLARE_WARMUP_TIMEOUT_MS', 24000, 12000), 12000),
    refreshDomainOnStart: options.refreshDomainOnStart ?? false,
    targetUrlClearance: options.targetUrlClearance ?? true,
    homepageFallback: options.homepageFallback ?? envFlag(`${envPrefix}_FLARE_HOMEPAGE_FALLBACK`, false),
    debug: options.debug ?? envFlag(`${envPrefix}_DEBUG`, false),
    debugCf: options.debugCf ?? envFlag(`${envPrefix}_DEBUG_CF`, envFlag('PROVIDER_SHIELD_DEBUG_CF', true)),
    maxCacheItems: options.maxCacheItems || 300,
    useRustShield,
    useRustShieldForSession
  });

  function debug(message, meta = null) {
    if (logger?.debug) logger.debug(message, meta);
    else if (options.debug || options.debugCf) console.log(`[${envPrefix}-BYPASS:debug] ${message}${meta ? ` ${JSON.stringify(meta)}` : ''}`);
  }

  function warn(message, meta = null) {
    if (logger?.warn) logger.warn(message, meta);
    else if (options.debug || options.debugCf) console.warn(`[${envPrefix}-BYPASS] ${message}${meta ? ` ${JSON.stringify(meta)}` : ''}`);
  }

  function shouldAttemptScrapling(url, fetchOptions = {}) {
    if (!scraplingEnabled || fetchOptions.allowScrapling === false) return false;
    if (fetchOptions.allowFlareSolverr === false && fetchOptions.allowScrapling !== true) return false;
    if (!isSameSiteUrl(url, baseUrl) || !isHtmlLikeUrl(url)) return false;
    return true;
  }

  async function runScrapling(url, fetchOptions = {}) {
    const method = String(fetchOptions.method || (fetchOptions.isPost ? 'POST' : 'GET')).toUpperCase();
    const rawResult = await runScraplingBypass(url, providerName, {
      ...fetchOptions,
      method,
      body: fetchOptions.body || fetchOptions.data || null,
      timeout: fetchOptions.scraplingTimeoutMs || fetchOptions.timeoutMs || fetchOptions.timeout,
      headers: fetchOptions.headers || {},
      runner: options.scraplingRunner,
      queue: options.scraplingQueue,
      coalesceKey: fetchOptions.scraplingCoalesceKey || providerName
    });
    return normalizeScraplingResult(rawResult, providerName, url);
  }

  async function fetchHtml(url, fetchOptions = {}) {
    if (!enabled) return null;
    const isPost = Boolean(fetchOptions.isPost || fetchOptions.method === 'POST');
    const body = fetchOptions.body || fetchOptions.data || null;
    const timeoutMs = fetchOptions.timeoutMs || fetchOptions.timeout || guard.directFetchTimeoutMs;
    const allowFlareSolverr = fetchOptions.allowFlareSolverr !== false;
    const ttl = fetchOptions.ttl || 10 * 60 * 1000;

    let html = null;
    if (fetchOptions.skipGuard !== true && typeof guard.smartFetch === 'function') {
      html = await guard.smartFetch(url, {
        ...fetchOptions,
        isPost,
        body,
        ttl,
        allowFlareSolverr,
        timeoutMs
      });
      if (html) return html;
    }

    if (!shouldAttemptScrapling(url, { ...fetchOptions, allowFlareSolverr })) return null;

    try {
      const session = await runScrapling(url, {
        ...fetchOptions,
        isPost,
        body,
        method: isPost ? 'POST' : 'GET',
        timeoutMs
      });
      if (session?.userAgent && session.cookies && typeof guard.importSession === 'function') {
        guard.importSession(session, session.solvedUrl || url);
      }
      if (isUsefulHtml(session?.response, session?.solutionResponseStatus)) {
        debug('scrapling response html used', { url, bytes: String(session.response || '').length });
        return session.response;
      }
      if (typeof guard.smartFetch !== 'function') return null;
      const replay = await guard.smartFetch(url, {
        ...fetchOptions,
        isPost,
        body,
        ttl,
        allowFlareSolverr: false,
        timeoutMs
      });
      return replay || null;
    } catch (error) {
      warn('scrapling fallback failed', { providerName, url, error: error?.message || String(error) });
      return null;
    }
  }

  async function fetchAxiosLike(url, fetchOptions = {}) {
    const html = await fetchHtml(url, fetchOptions);
    if (!html) return null;
    return toAxiosLikeResponse({ url, html, via: fetchOptions.via || 'provider-shield' });
  }

  async function ensureReady(reason = 'request', ensureOptions = {}) {
    const targetUrl = ensureOptions.url || ensureOptions.triggerUrl || baseUrl;
    if (!targetUrl || typeof guard.ensureClearance !== 'function') return false;
    if (guard.isSessionFresh?.(targetUrl) && !ensureOptions.force) return true;
    const session = await guard.ensureClearance(targetUrl, ensureOptions);
    if (session || guard.isSessionFresh?.(targetUrl)) return true;
    if (!shouldAttemptScrapling(targetUrl, { allowScrapling: ensureOptions.allowScrapling, allowFlareSolverr: ensureOptions.allowFlareSolverr ?? true })) return false;
    const html = await fetchHtml(targetUrl, { ...ensureOptions, ttl: ensureOptions.ttl || 60_000, reason });
    return Boolean(html || guard.isSessionFresh?.(targetUrl));
  }

  function getState() {
    const impitState = typeof guard.getImpitShieldState === 'function' ? guard.getImpitShieldState() : {};
    return {
      ...impitState,
      enabled,
      providerName,
      baseUrl,
      scraplingEnabled,
      scrapling: defaultScraplingQueue.state(),
      centralBypass: true
    };
  }

  return {
    enabled,
    baseUrl,
    providerName,
    envPrefix,
    guard,
    fetchHtml,
    smartFetch: fetchHtml,
    fetchAxiosLike,
    ensureReady,
    shouldUseShield: params => enabled && shouldUseCloudflareBypass({ baseUrl, ...params }),
    shouldUseCloudflareBypass: params => enabled && shouldUseCloudflareBypass({ baseUrl, ...params }),
    isBlockedStatus,
    isBlockedBody,
    isBlockedError,
    isSameSiteUrl: url => isSameSiteUrl(url, baseUrl),
    isHtmlLikeUrl,
    toAxiosLikeResponse,
    getState
  };
}

function createBlockedFallbackGuard(options = {}) {
  return createCloudflareBypass(options);
}

module.exports = {
  createCloudflareBypass,
  createBlockedFallbackGuard,
  createBypassQueue,
  runScraplingBypass,
  normalizeScraplingResult,
  shouldUseCloudflareBypass,
  isBlockedStatus,
  isBlockedBody,
  isBlockedError,
  isSameSiteUrl,
  isHtmlLikeUrl,
  isUsefulHtml,
  toAxiosLikeResponse,
  envFlag,
  envFlagNotFalse,
  envNumber
};
