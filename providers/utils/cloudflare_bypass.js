'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { buildCookieHeaderFromSession, mergeCookieHeaders, cookieHeaderToObjects } = require('./cf_clearance_manager');

let cfNativeSolver = null;
try {
  
  cfNativeSolver = require('./cf_native_solver');
} catch (err) {
  try {
    process.stderr.write(`[cloudflare_bypass] cf_native_solver unavailable: ${err && err.message}\n`);
  } catch (_) {}
  cfNativeSolver = null;
}

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
    ignored = {'path', 'domain', 'expires', 'max-age', 'secure', 'httponly', 'samesite', 'priority', 'partitioned'}
    for raw in str(cookie_header).split(';'):
        if '=' not in raw:
            continue
        name, value = raw.strip().split('=', 1)
        name = name.strip()
        if not name or name.lower() in ignored:
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
    main()`;

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

function shortHash(value) {
  return crypto.createHash('sha1').update(String(value || '')).digest('hex').slice(0, 12);
}

function buildCurlCffiCoalesceKey(providerName, method, url, body = '') {
  const bodyKey = body ? `:${shortHash(body)}` : '';
  return `${providerName || 'provider'}:curl_cffi:${String(method || 'GET').toUpperCase()}:${String(url || '')}${bodyKey}`;
}

function getHeaderValue(headers = {}, name = '') {
  if (!headers || typeof headers !== 'object') return '';
  const wanted = String(name || '').toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (String(key).toLowerCase() === wanted) return value == null ? '' : String(value);
  }
  return '';
}

function setHeaderValue(headers = {}, name = '', value = '') {
  if (!headers || typeof headers !== 'object' || !name || value == null || value === '') return headers;
  const wanted = String(name).toLowerCase();
  for (const key of Object.keys(headers)) {
    if (String(key).toLowerCase() === wanted) {
      headers[key] = String(value);
      return headers;
    }
  }
  headers[name] = String(value);
  return headers;
}

function normalizeCurlCookieItems(value = [], url = null) {
  const out = [];
  const seen = new Set();
  const targetHost = hostOf(url);
  const push = (item = {}) => {
    const name = String(item.name || item.key || '').trim();
    const rawValue = item.value ?? item.val;
    if (!name || rawValue == null) return;
    const normalized = {
      name,
      value: String(rawValue),
      path: item.path || '/'
    };
    const domain = item.domain || item.host || targetHost;
    if (domain) normalized.domain = String(domain).replace(/^\./, '');
    if (item.secure != null) normalized.secure = Boolean(item.secure);
    if (item.expires != null) normalized.expires = item.expires;
    const key = `${normalized.name}\u0000${normalized.domain || ''}\u0000${normalized.path || ''}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(normalized);
  };

  if (Array.isArray(value)) {
    for (const item of value) push(item);
  } else if (value && typeof value === 'object') {
    for (const [name, cookieValue] of Object.entries(value)) {
      if (cookieValue && typeof cookieValue === 'object') push({ name, ...cookieValue });
      else push({ name, value: cookieValue });
    }
  }
  return out;
}

function cookieItemsFromSession(session = {}, url = null) {
  if (!session) return [];
  try {
    const items = cookieHeaderToObjects(session, url || session.solvedUrl || session.url || null);
    return normalizeCurlCookieItems(items, url || session.solvedUrl || session.url || null);
  } catch (_) {
    const header = buildCookieHeaderFromSession(session, url || session.solvedUrl || session.url || null) || session.cookies || '';
    try { return normalizeCurlCookieItems(cookieHeaderToObjects(header, url || session.solvedUrl || session.url || null), url); }
    catch (__) { return []; }
  }
}

function cookieHeaderFromCurlItems(items = []) {
  const pairs = [];
  const seen = new Set();
  for (const item of items || []) {
    const name = String(item?.name || '').trim();
    const value = item?.value;
    if (!name || value == null || seen.has(name)) continue;
    seen.add(name);
    pairs.push(`${name}=${value}`);
  }
  return pairs.join('; ');
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

function isBlockedStatus(status, headers = null) {
  const code = Number(status || 0);
  if (!BLOCKED_STATUSES.has(code)) return false;
  if (headers == null) return true;
  return hasCfResponseHeaders(headers);
}

function hasCfResponseHeaders(headers = {}) {
  if (!headers || typeof headers !== 'object') return false;
  for (const [key, value] of Object.entries(headers)) {
    const k = String(key).toLowerCase();
    if (k === 'cf-ray' || k === 'cf-cache-status') return true;
    if (k === 'server' && String(value).toLowerCase().includes('cloudflare')) return true;
  }
  return false;
}

function isCloudflareChallenge(body, status, headers = null) {
  const code = Number(status);
  const text = safeString(body);

  if (/just a moment|checking your browser|cloudflare ray id|cf-browser-verification/i.test(text)
    || /enable javascript and cookies|<div id=["']cf-wrapper["']|cf-chl-widget|__cf_chl_opt|cf\.challenge\.orchestrate/i.test(text)
    || (/challenge-platform|_cf_chl_opt|cf_clearance/i.test(text) && text.length < 20000)) {
    return true;
  }

  if ([403, 429, 503].includes(code)) {
    if (headers == null) return true;
    return hasCfResponseHeaders(headers);
  }

  return false;
}

function isBlockedBody(body, status = 200, headers = null) {
  const text = safeString(body);
  if (!text) return false;
  return isCloudflareChallenge(text, Number(status || 200), headers);
}

function isBlockedError(error) {
  const headers = error?.response?.headers || error?.headers || null;
  const status = Number(error?.response?.status || error?.status || error?.statusCode || 0);
  if (isBlockedStatus(status, headers)) return true;

  const body = error?.response?.data || error?.body || '';
  if (body && isBlockedBody(body, status || 200, headers)) return true;

  const code = String(error?.code || '').toUpperCase();
  const msg = String(error?.message || error || '').toLowerCase();
  if (NETWORK_BLOCK_CODES.has(code)) return true;
  return /(?:timeout|timed out|socket hang up|cloudflare|captcha|challenge|forbidden|too many requests|econnreset|econnaborted)/i.test(msg);
}

function shouldUseCloudflareBypass({ url, baseUrl, status = 0, body = '', headers = null, error = null, allowOnNetworkError = true } = {}) {
  if (!url || !isSameSiteUrl(url, baseUrl) || !isHtmlLikeUrl(url)) return false;
  const resolvedHeaders = headers || error?.response?.headers || error?.headers || null;
  if (isBlockedStatus(status, resolvedHeaders)) return true;
  if (isBlockedBody(body, status || 200, resolvedHeaders)) return true;
  if (error && allowOnNetworkError && isBlockedError(error)) return true;
  return false;
}

function isUsefulHtml(value, status = 200, headers = null) {
  const text = safeString(value).trim();
  if (!text || text.length < 32) return false;
  if (isCloudflareChallenge(text, status, headers)) return false;
  if (/turnstile\.cloudflare\.com|cf-chl-widget|__cf_chl_opt|cf\.challenge\.orchestrate/i.test(text)) return false;
  return /<html[\s>]|<!doctype\s+html|<body[\s>]/i.test(text) || text.length >= 200;
}

function createBypassQueue(options = {}) {
  const label = String(options.label || 'scrapling').trim() || 'scrapling';
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
      return Promise.reject(new Error(`${label}_queue_full:${providerName}:${waiting.length}/${maxQueue}:${url}`));
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
        reject(new Error(`${label}_queue_timeout:${providerName}:${queueTimeoutMs}`));
      }, queueTimeoutMs);
      if (entry.timeoutId?.unref) entry.timeoutId.unref();
      waiting.push(entry);
    });
  }

  return {
    acquire,
    state: () => ({ label, active, queued: waiting.length, maxConcurrent, maxQueue, queueTimeoutMs })
  };
}

const CURL_CFFI_DEFAULTS = Object.freeze({
  maxConcurrent: 4,
  maxQueue: 40,
  queueTimeoutMs: 20_000,
  timeoutMs: 15_000,
  impersonate: 'auto',
  retries: 1,
  retryBackoffMs: 250,
  warmupOrigin: true,
  browserHeaders: true,
  acceptLanguage: 'it-IT,it;q=0.9,en-US;q=0.8,en;q=0.7',
  beforeFlare: true,
  beforeFlareTimeoutMs: 6500
});

const defaultScraplingQueue = createBypassQueue({ label: 'scrapling' });
const defaultCurlCffiQueue = createBypassQueue({
  label: 'curl_cffi',
  maxConcurrent: envNumber('CURL_CFFI_MAX_CONCURRENT', CURL_CFFI_DEFAULTS.maxConcurrent, 1, 24),
  maxQueue: envNumber('CURL_CFFI_MAX_QUEUE', CURL_CFFI_DEFAULTS.maxQueue, 0, 1000),
  queueTimeoutMs: envNumber('CURL_CFFI_QUEUE_TIMEOUT_MS', CURL_CFFI_DEFAULTS.queueTimeoutMs, 1000)
});
const activeScraplingBypasses = new Map();
const activeCurlCffiBypasses = new Map();
const DEFAULT_CURL_CFFI_SCRIPT = path.join(__dirname, 'cf_curl_cffi.py');

function resolvePythonExecutable(preferredEnv = 'SCRAPLING_PYTHON') {
  const explicit = String(process.env[preferredEnv] || process.env.SCRAPLING_PYTHON || process.env.PYTHON_BIN || '').trim();
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
    const requestBody = options.body ?? options.data;
    if (method) args.push('--method', method);
    if (requestBody != null) args.push('--data', String(requestBody));
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

function isUsableCurlCffiProxyUrl(value) {
  const clean = String(value || '').trim();
  if (!clean) return false;
  try {
    const parsed = new URL(clean);
    const protocol = parsed.protocol.toLowerCase();
    if (!['http:', 'https:', 'socks4:', 'socks4a:', 'socks5:', 'socks5h:'].includes(protocol)) return false;
    if (parsed.search || (parsed.pathname && parsed.pathname !== '/')) return false;
    return Boolean(parsed.hostname);
  } catch (_) {
    return false;
  }
}

function firstUsableCurlCffiProxy(values = []) {
  for (const value of values) {
    const clean = String(value || '').trim();
    if (clean && isUsableCurlCffiProxyUrl(clean)) return clean;
  }
  return '';
}

function resolveCurlCffiProxy(providerName = 'provider', options = {}) {
  const envPrefix = envPrefixFor(providerName, options.envPrefix);
  return firstUsableCurlCffiProxy([
    options.proxy,
    process.env[`${envPrefix}_CURL_CFFI_PROXY`],
    process.env.CURL_CFFI_PROXY,
    process.env.CF_CURL_CFFI_PROXY,
    process.env.HTTPS_PROXY,
    process.env.HTTP_PROXY,
    process.env.https_proxy,
    process.env.http_proxy
  ]);
}

function resolveCurlCffiScriptPath(options = {}) {
  const explicit = String(options.scriptPath || process.env.CURL_CFFI_SCRIPT_PATH || '').trim();
  if (explicit) return path.isAbsolute(explicit) ? explicit : path.resolve(process.cwd(), explicit);
  return DEFAULT_CURL_CFFI_SCRIPT;
}

function execCurlCffiBypass(url, providerName = 'provider', options = {}) {
  return new Promise((resolve, reject) => {
    const scriptPath = resolveCurlCffiScriptPath(options);
    try {
      if (!fs.existsSync(scriptPath)) return reject(new Error(`curl_cffi_script_missing:${scriptPath}`));
    } catch (error) {
      return reject(error);
    }

    const method = String(options.method || (options.isPost ? 'POST' : 'GET')).toUpperCase();
    const envPrefix = envPrefixFor(providerName, options.envPrefix);
    const timeout = Math.max(1000, Number(options.timeout || options.timeoutMs || process.env[`${envPrefix}_CURL_CFFI_TIMEOUT_MS`] || process.env.CURL_CFFI_TIMEOUT_MS || CURL_CFFI_DEFAULTS.timeoutMs) || CURL_CFFI_DEFAULTS.timeoutMs);
    const retries = Math.max(0, Math.min(5, Number(options.retries ?? process.env[`${envPrefix}_CURL_CFFI_RETRIES`] ?? process.env.CURL_CFFI_RETRIES ?? CURL_CFFI_DEFAULTS.retries) || 0));
    const retryBackoffMs = Math.max(0, Math.min(5000, Number(options.retryBackoffMs ?? process.env[`${envPrefix}_CURL_CFFI_RETRY_BACKOFF_MS`] ?? process.env.CURL_CFFI_RETRY_BACKOFF_MS ?? CURL_CFFI_DEFAULTS.retryBackoffMs) || 0));
    const warmupOrigin = options.warmupOrigin ?? envFlagNotFalse(`${envPrefix}_CURL_CFFI_WARMUP_ORIGIN`, envFlagNotFalse('CURL_CFFI_WARMUP_ORIGIN', CURL_CFFI_DEFAULTS.warmupOrigin));
    const browserHeaders = options.browserHeaders ?? envFlagNotFalse(`${envPrefix}_CURL_CFFI_BROWSER_HEADERS`, envFlagNotFalse('CURL_CFFI_BROWSER_HEADERS', CURL_CFFI_DEFAULTS.browserHeaders));
    const acceptLanguage = String(options.acceptLanguage || process.env[`${envPrefix}_CURL_CFFI_ACCEPT_LANGUAGE`] || process.env.CURL_CFFI_ACCEPT_LANGUAGE || CURL_CFFI_DEFAULTS.acceptLanguage).trim();
    const args = [
      scriptPath,
      String(url),
      '--timeout', String(timeout),
      '--impersonate', String(options.impersonate || process.env[`${envPrefix}_CURL_CFFI_IMPERSONATE`] || process.env.CURL_CFFI_IMPERSONATE || CURL_CFFI_DEFAULTS.impersonate),
      '--retries', String(retries),
      '--retry-backoff', String(retryBackoffMs)
    ];
    const requestBody = options.body ?? options.data;
    if (method) args.push('--method', method);
    if (requestBody != null) args.push('--data', String(requestBody));
    if (options.headers) args.push('--headers', JSON.stringify(options.headers));
    if (options.cookiesJson) args.push('--cookies-json', JSON.stringify(options.cookiesJson));
    if (options.signalsJson || options.signals) args.push('--signals-json', JSON.stringify(options.signalsJson || options.signals));
    if (options.profileState === false) args.push('--no-profile-state');
    if (options.profileStatePath) args.push('--profile-state-path', String(options.profileStatePath));
    if (acceptLanguage) args.push('--accept-language', acceptLanguage);
    if (options.referer) args.push('--referer', String(options.referer));
    args.push(warmupOrigin ? '--warmup-origin' : '--no-warmup-origin');
    args.push(browserHeaders ? '--browser-headers' : '--no-browser-headers');
    const proxy = resolveCurlCffiProxy(providerName, options);
    if (proxy) args.push('--proxy', proxy);
    if (options.insecure || envFlag('CURL_CFFI_INSECURE', false)) args.push('--insecure');

    const child = spawn(resolvePythonExecutable('CURL_CFFI_PYTHON'), args, {
      windowsHide: true,
      env: { ...process.env, PYTHONUNBUFFERED: '1' }
    });
    let stdout = '';
    let stderr = '';
    let killedByTimeout = false;
    const killTimer = setTimeout(() => {
      killedByTimeout = true;
      try { child.kill('SIGKILL'); } catch (_) {}
    }, Math.max(timeout + 1000, timeout * (retries + 1) + 3000));
    if (killTimer?.unref) killTimer.unref();

    child.stdout.on('data', chunk => { stdout += chunk.toString(); });
    child.stderr.on('data', chunk => { stderr += chunk.toString(); });
    child.on('error', error => {
      clearTimeout(killTimer);
      reject(error);
    });
    child.on('close', code => {
      clearTimeout(killTimer);
      const payload = parseJsonFromStdout(stdout);
      if (payload?.status === 'ok') return resolve(payload);
      if (payload?.status === 'error') return reject(new Error(payload.message || 'curl_cffi_error'));
      if (killedByTimeout) return reject(new Error(`curl_cffi_timeout:${timeout}`));
      if (code !== 0) return reject(new Error(stderr.trim() || `curl_cffi_exit_${code}`));
      return reject(new Error('curl_cffi_invalid_output'));
    });
  });
}

async function runCurlCffiBypass(url, providerName = 'provider', options = {}) {
  const queue = options.queue || defaultCurlCffiQueue;
  const key = String(options.coalesceKey || providerName || 'provider');
  if (activeCurlCffiBypasses.has(key)) return activeCurlCffiBypasses.get(key);

  const promise = (async () => {
    const release = await queue.acquire(providerName, url);
    try {
      const runner = typeof options.runner === 'function' ? options.runner : execCurlCffiBypass;
      return await runner(url, providerName, options);
    } finally {
      release();
    }
  })().finally(() => {
    activeCurlCffiBypasses.delete(key);
  });

  activeCurlCffiBypasses.set(key, promise);
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

function cookieObjectMapFromCookies(cookies = null, url = null) {
  const out = {};
  const push = cookie => {
    const normalized = normalizeCookieObject(cookie);
    if (normalized?.name && normalized.value != null) out[normalized.name] = normalized.value;
  };

  if (!cookies) return out;

  if (typeof cookies === 'string') {
    try {
      for (const item of cookieHeaderToObjects(cookies, url)) push(item);
    } catch (_) {
      for (const item of String(cookies).split(';')) push(item);
    }
    return out;
  }

  if (Array.isArray(cookies)) {
    for (const item of cookies) push(item);
    return out;
  }

  if (typeof cookies === 'object') {
    if (cookies.cookies || cookies.cookieJar) {
      try {
        for (const item of cookieHeaderToObjects(cookies, url)) push(item);
        return out;
      } catch (_) {}
    }

    for (const [name, value] of Object.entries(cookies)) {
      if (value && typeof value === 'object') push({ name, ...value });
      else push({ name, value });
    }
  }

  return out;
}

function cookieHeaderFromCookieMap(cookies = {}) {
  return Object.entries(cookies || {})
    .filter(([name, value]) => name && value != null)
    .map(([name, value]) => `${name}=${value}`)
    .join('; ');
}

function normalizeScraplingResult(result = {}, providerName = 'provider', fallbackUrl = null) {
  const solvedUrl = String(result.url || result.solvedUrl || fallbackUrl || '').trim();
  const baseUrl = normalizeOrigin(solvedUrl) || normalizeOrigin(fallbackUrl) || null;
  const rawCookies = Array.isArray(result.cookies)
    ? result.cookies
    : (result.cookies && typeof result.cookies === 'object'
      ? Object.entries(result.cookies).map(([name, value]) => (value && typeof value === 'object' ? { name, ...value } : { name, value }))
      : []);
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

function normalizeCurlCffiResult(result = {}, providerName = 'provider', fallbackUrl = null) {
  const session = normalizeScraplingResult(result, providerName, fallbackUrl);
  session.scrapling = false;
  session.curlCffi = true;
  session.source = 'curl_cffi';
  session.impersonate = result.impersonate || process.env.CURL_CFFI_IMPERSONATE || CURL_CFFI_DEFAULTS.impersonate;
  session.impersonateChain = Array.isArray(result.impersonateChain) ? result.impersonateChain : [];
  session.elapsedMs = Number(result.elapsedMs || 0) || 0;
  session.challengeDetected = Boolean(result.challengeDetected);
  session.challengeReason = result.challengeReason || '';
  session.profileScore = result.profileScore;
  session.profileStats = result.profileStats || null;
  session.httpVersionMode = result.httpVersionMode || '';
  session.inputSignals = result.inputSignals || null;
  session.attempts = Array.isArray(result.attempts) ? result.attempts : [];
  if (result.cookieHeader) {
    session.cookies = session.cookies
      ? mergeCookieHeaders(session.cookies, result.cookieHeader)
      : String(result.cookieHeader);
  }
  if (result.headers && typeof result.headers === 'object') session.responseHeaders = result.headers;
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
  const curlCffiEnabled = options.curlCffiEnabled ?? envFlag(`${envPrefix}_CURL_CFFI_ENABLED`, envFlag('CURL_CFFI_ENABLED', true));
  const curlCffiImpersonate = String(options.curlCffiImpersonate || process.env[`${envPrefix}_CURL_CFFI_IMPERSONATE`] || process.env.CURL_CFFI_IMPERSONATE || CURL_CFFI_DEFAULTS.impersonate);
  const curlCffiRetries = envNumber(`${envPrefix}_CURL_CFFI_RETRIES`, envNumber('CURL_CFFI_RETRIES', CURL_CFFI_DEFAULTS.retries, 0, 5), 0, 5);
  const curlCffiRetryBackoffMs = envNumber(`${envPrefix}_CURL_CFFI_RETRY_BACKOFF_MS`, envNumber('CURL_CFFI_RETRY_BACKOFF_MS', CURL_CFFI_DEFAULTS.retryBackoffMs, 0, 5000), 0, 5000);
  const curlCffiWarmupOrigin = envFlagNotFalse(`${envPrefix}_CURL_CFFI_WARMUP_ORIGIN`, envFlagNotFalse('CURL_CFFI_WARMUP_ORIGIN', CURL_CFFI_DEFAULTS.warmupOrigin));
  const curlCffiBrowserHeaders = envFlagNotFalse(`${envPrefix}_CURL_CFFI_BROWSER_HEADERS`, envFlagNotFalse('CURL_CFFI_BROWSER_HEADERS', CURL_CFFI_DEFAULTS.browserHeaders));
  const curlCffiAcceptLanguage = String(process.env[`${envPrefix}_CURL_CFFI_ACCEPT_LANGUAGE`] || process.env.CURL_CFFI_ACCEPT_LANGUAGE || options.acceptLanguage || CURL_CFFI_DEFAULTS.acceptLanguage);
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
    useRustShieldForSession,
    curlCffiBeforeFlare: options.curlCffiBeforeFlare ?? envFlagNotFalse(`${envPrefix}_CURL_CFFI_BEFORE_FLARE`, envFlagNotFalse('CURL_CFFI_BEFORE_FLARE', CURL_CFFI_DEFAULTS.beforeFlare)),
    curlCffiBeforeFlareTimeoutMs: options.curlCffiBeforeFlareTimeoutMs || envNumber(`${envPrefix}_CURL_CFFI_BEFORE_FLARE_TIMEOUT_MS`, envNumber('CURL_CFFI_BEFORE_FLARE_TIMEOUT_MS', CURL_CFFI_DEFAULTS.beforeFlareTimeoutMs, 1000, 15000), 1000, 15000),
    curlCffiPreClearance: async (targetUrl, preOptions = {}) => {
      if (!shouldAttemptCurlCffi(targetUrl, preOptions)) return null;
      return runCurlCffi(targetUrl, {
        ...preOptions,
        method: 'GET',
        isPost: false,
        body: null,
        timeoutMs: preOptions.timeoutMs || preOptions.timeout || envNumber(`${envPrefix}_CURL_CFFI_BEFORE_FLARE_TIMEOUT_MS`, envNumber('CURL_CFFI_BEFORE_FLARE_TIMEOUT_MS', CURL_CFFI_DEFAULTS.beforeFlareTimeoutMs, 1000, 15000), 1000, 15000),
        headers: preOptions.headers || {},
        allowFlareSolverr: false,
        allowScrapling: false,
        allowCurlCffi: true,
        curlCffiCoalesceKey: preOptions.curlCffiCoalesceKey || preOptions.sharedKey || `${providerName}:pre-flare`
      });
    }
  });

  function debug(message, meta = null) {
    if (logger?.debug) logger.debug(message, meta);
    else if (options.debug || options.debugCf) console.log(`[${envPrefix}-BYPASS:debug] ${message}${meta ? ` ${JSON.stringify(meta)}` : ''}`);
  }

  function warn(message, meta = null) {
    if (logger?.warn) logger.warn(message, meta);
    else if (options.debug || options.debugCf) console.warn(`[${envPrefix}-BYPASS] ${message}${meta ? ` ${JSON.stringify(meta)}` : ''}`);
  }

  function rememberNativeClearance(url, session, strategy) {
    if (!cfNativeSolver || !session?.cookies) return;
    const cookies = cookieObjectMapFromCookies(session.cookies, session.solvedUrl || url);
    if (!Object.keys(cookies).length) return;
    try {
      cfNativeSolver.rememberClearance(session.solvedUrl || url, {
        cookies,
        userAgent: session.userAgent,
        strategy
      });
    } catch (_) {}
  }

  function importNativeSession(native, url) {
    if (!native?.userAgent || !native.cookies || typeof guard.importSession !== 'function') return;
    const cookies = cookieObjectMapFromCookies(native.cookies, native.url || url);
    const cookieHeader = cookieHeaderFromCookieMap(cookies);
    if (!cookieHeader) return;
    try {
      guard.importSession({
        userAgent: native.userAgent,
        cookies: cookieHeader,
        solvedUrl: native.url || url
      }, native.url || url);
    } catch (_) {}
  }

  function isGuardSessionFreshForUrl(targetUrl) {
    const session = typeof guard.getSession === 'function' ? guard.getSession() : null;
    if (typeof guard.isSessionFreshForUrl === 'function') {
      try { return Boolean(guard.isSessionFreshForUrl(session, targetUrl)); } catch (_) {}
    }
    if (typeof guard.isSessionFresh === 'function') {
      if (session) {
        try { if (guard.isSessionFresh(session)) return true; } catch (_) {}
      }
      try { return Boolean(guard.isSessionFresh(targetUrl)); } catch (_) {}
    }
    return false;
  }

  async function hydrateCurlCffiSession(url, reason = 'curl-cffi-seed') {
    if (typeof guard.hydrateSessionForUrl !== 'function') return false;
    try {
      return await guard.hydrateSessionForUrl(url, reason);
    } catch (error) {
      debug('curl_cffi redis/session hydrate skipped', { url, error: error?.message || String(error) });
      return false;
    }
  }

  function buildCurlCffiSeed(url, fetchOptions = {}) {
    const headers = { ...(fetchOptions.headers || {}) };
    const session = typeof guard.getSession === 'function' ? guard.getSession() : null;
    const sessionFresh = session && (
      typeof guard.isSessionFreshForUrl === 'function'
        ? guard.isSessionFreshForUrl(session, url || session.solvedUrl || session.url || baseUrl)
        : (typeof guard.isSessionFresh === 'function' ? guard.isSessionFresh(session) : true)
    );
    const cookieItems = [];

    if (sessionFresh) {
      const sessionCookieItems = cookieItemsFromSession(session, url || session.solvedUrl || session.url || baseUrl);
      cookieItems.push(...sessionCookieItems);
      const sessionCookie = cookieHeaderFromCurlItems(sessionCookieItems)
        || buildCookieHeaderFromSession(session, url || session.solvedUrl || session.url || baseUrl)
        || session.cookies
        || '';
      if (sessionCookie) {
        const existingCookie = getHeaderValue(headers, 'cookie');
        setHeaderValue(headers, 'Cookie', existingCookie ? mergeCookieHeaders(existingCookie, sessionCookie) : sessionCookie);
      }
      const sessionUa = session.userAgent || session.ua || '';
      if (sessionUa && !getHeaderValue(headers, 'user-agent')) setHeaderValue(headers, 'User-Agent', sessionUa);
      if (sessionCookie || sessionUa || sessionCookieItems.length) {
        debug('curl_cffi seeded from shared session', {
          url,
          hasCookie: Boolean(sessionCookie || sessionCookieItems.length),
          cookieCount: sessionCookieItems.length || undefined,
          hasUserAgent: Boolean(sessionUa),
          source: session.source || session.solver || (session.curlCffi ? 'curl_cffi' : 'flaresolverr')
        });
      }
    }

    return { headers, cookiesJson: cookieItems.length ? cookieItems : null };
  }

  function shouldAttemptCurlCffi(url, fetchOptions = {}) {
    if (!curlCffiEnabled || fetchOptions.allowCurlCffi === false) return false;
    if (!isSameSiteUrl(url, baseUrl) || !isHtmlLikeUrl(url)) return false;
    return true;
  }

  async function runCurlCffi(url, fetchOptions = {}) {
    const method = String(fetchOptions.method || (fetchOptions.isPost ? 'POST' : 'GET')).toUpperCase();
    await hydrateCurlCffiSession(url, fetchOptions.reason ? `curl-cffi-${fetchOptions.reason}` : 'curl-cffi-seed');
    const curlCffiSeed = buildCurlCffiSeed(url, fetchOptions);
    const rawResult = await runCurlCffiBypass(url, providerName, {
      ...fetchOptions,
      method,
      body: fetchOptions.body ?? fetchOptions.data ?? null,
      timeout: fetchOptions.curlCffiTimeoutMs || fetchOptions.timeoutMs || fetchOptions.timeout,
      headers: curlCffiSeed.headers,
      cookiesJson: curlCffiSeed.cookiesJson,
      impersonate: fetchOptions.impersonate || fetchOptions.curlCffiImpersonate || curlCffiImpersonate,
      proxy: fetchOptions.proxy || fetchOptions.curlCffiProxy || null,
      retries: fetchOptions.curlCffiRetries ?? curlCffiRetries,
      retryBackoffMs: fetchOptions.curlCffiRetryBackoffMs ?? curlCffiRetryBackoffMs,
      warmupOrigin: fetchOptions.curlCffiWarmupOrigin ?? curlCffiWarmupOrigin,
      browserHeaders: fetchOptions.curlCffiBrowserHeaders ?? curlCffiBrowserHeaders,
      acceptLanguage: fetchOptions.acceptLanguage || fetchOptions.curlCffiAcceptLanguage || curlCffiAcceptLanguage,
      referer: fetchOptions.referer || fetchOptions.headers?.Referer || fetchOptions.headers?.referer || '',
      signalsJson: fetchOptions.signalsJson || fetchOptions.signals || null,
      profileState: fetchOptions.profileState,
      profileStatePath: fetchOptions.profileStatePath || null,
      runner: options.curlCffiRunner,
      queue: options.curlCffiQueue,
      coalesceKey: fetchOptions.curlCffiCoalesceKey || buildCurlCffiCoalesceKey(providerName, method, url, fetchOptions.body ?? fetchOptions.data ?? ''),
      envPrefix
    });
    return normalizeCurlCffiResult(rawResult, providerName, url);
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
      body: fetchOptions.body ?? fetchOptions.data ?? null,
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
    const body = fetchOptions.body ?? fetchOptions.data ?? null;
    const timeoutMs = fetchOptions.timeoutMs || fetchOptions.timeout || guard.directFetchTimeoutMs;
    const allowFlareSolverr = fetchOptions.allowFlareSolverr !== false;
    const ttl = fetchOptions.ttl || 10 * 60 * 1000;

    if (!isPost && cfNativeSolver && fetchOptions.skipNativeBypass !== true) {
      try {
        const native = await cfNativeSolver.tryNativeBypass(url, {
          userAgent: fetchOptions.userAgent || getHeaderValue(fetchOptions.headers || {}, 'user-agent'),
          cookieHeader: fetchOptions.cookieHeader || getHeaderValue(fetchOptions.headers || {}, 'cookie'),
          extraHeaders: fetchOptions.headers || {},
          timeoutMs: Math.min(timeoutMs || 6000, 8000)
        });
        if (native && isUsefulHtml(native.html, native.status)) {
          debug('cf_native_solver hit', {
            url,
            strategy: native.strategy,
            status: native.status,
            bytes: String(native.html || '').length
          });
          importNativeSession(native, url);
          return native.html;
        }
      } catch (err) {
        debug('cf_native_solver error (ignored)', { url, error: err && err.message });
      }
    }

    if (shouldAttemptCurlCffi(url, fetchOptions)) {
      try {
        const session = await runCurlCffi(url, {
          ...fetchOptions,
          isPost,
          body,
          method: isPost ? 'POST' : 'GET',
          timeoutMs
        });
        if (session?.userAgent && session.cookies && typeof guard.importSession === 'function') {
          guard.importSession(session, session.solvedUrl || url);
        }
        rememberNativeClearance(url, session, 'curl_cffi');
        if (isUsefulHtml(session?.response, session?.solutionResponseStatus, session?.responseHeaders || null)) {
          debug('curl_cffi response html used', {
            url,
            status: session.solutionResponseStatus,
            bytes: String(session.response || '').length,
            elapsedMs: session.elapsedMs || undefined
          });
          return session.response;
        }
        debug('curl_cffi did not return usable html, escalating', {
          url,
          status: session?.solutionResponseStatus || 0,
          bytes: String(session?.response || '').length
        });
      } catch (error) {
        warn('curl_cffi first-pass failed', { providerName, url, error: error?.message || String(error) });
      }
    }

    if (shouldAttemptScrapling(url, { ...fetchOptions, allowFlareSolverr })) {
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
        rememberNativeClearance(url, session, 'scrapling');
        if (isUsefulHtml(session?.response, session?.solutionResponseStatus)) {
          debug('scrapling response html used', { url, bytes: String(session.response || '').length });
          return session.response;
        }
        debug('scrapling did not return usable html, escalating', {
          url,
          status: session?.solutionResponseStatus || 0,
          bytes: String(session?.response || '').length
        });
      } catch (error) {
        warn('scrapling fallback failed', { providerName, url, error: error?.message || String(error) });
      }
    }

    if (fetchOptions.skipGuard !== true && typeof guard.smartFetch === 'function') {
      const html = await guard.smartFetch(url, {
        ...fetchOptions,
        isPost,
        body,
        ttl,
        allowFlareSolverr,
        timeoutMs
      });
      return html || null;
    }

    return null;
  }

  async function fetchAxiosLike(url, fetchOptions = {}) {
    const html = await fetchHtml(url, fetchOptions);
    if (!html) return null;
    return toAxiosLikeResponse({ url, html, via: fetchOptions.via || 'provider-shield' });
  }

  async function ensureReady(reason = 'request', ensureOptions = {}) {
    const targetUrl = ensureOptions.url || ensureOptions.triggerUrl || baseUrl;
    if (!targetUrl) return false;
    if (isGuardSessionFreshForUrl(targetUrl) && !ensureOptions.force) return true;

    const html = await fetchHtml(targetUrl, {
      ...ensureOptions,
      ttl: ensureOptions.ttl || 60_000,
      reason
    });
    if (html || isGuardSessionFreshForUrl(targetUrl)) return true;

    if (typeof guard.ensureClearance !== 'function') return false;
    const session = await guard.ensureClearance(targetUrl, ensureOptions);
    return Boolean(session || isGuardSessionFreshForUrl(targetUrl));
  }

  function getState() {
    const impitState = typeof guard.getImpitShieldState === 'function' ? guard.getImpitShieldState() : {};
    return {
      ...impitState,
      enabled,
      providerName,
      baseUrl,
      curlCffiEnabled,
      curlCffiImpersonate,
      curlCffiRetries,
      curlCffiRetryBackoffMs,
      curlCffiWarmupOrigin,
      curlCffiBrowserHeaders,
      curlCffi: defaultCurlCffiQueue.state(),
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
    runCurlCffi,
    runScrapling,
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
  buildCurlCffiCoalesceKey,
  runCurlCffiBypass,
  runScraplingBypass,
  normalizeCurlCffiResult,
  normalizeScraplingResult,
  shouldUseCloudflareBypass,
  hasCfResponseHeaders,
  isBlockedStatus,
  isBlockedBody,
  isBlockedError,
  isCloudflareChallenge,
  isSameSiteUrl,
  isHtmlLikeUrl,
  isUsefulHtml,
  toAxiosLikeResponse,
  envFlag,
  envFlagNotFalse,
  envNumber
};
