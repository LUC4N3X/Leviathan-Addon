'use strict';

const DEFAULT_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const DEFAULT_ACCEPT_LANGUAGE = 'it-IT,it;q=0.9,en-US;q=0.8,en;q=0.7';
const DEFAULT_HLS_ACCEPT = 'application/vnd.apple.mpegurl,application/x-mpegURL,*/*';
const DEFAULT_ACCEPT = '*/*';
const MAX_HEADER_VALUE_LENGTH = 4096;
const LOG_THROTTLE_MS = 60 * 1000;

const HEADER_NAME_RE = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const HEADER_VALUE_CONTROL_RE = /[\r\n\0]/;
const TRUTHY_RE = /^(1|true|yes|y|on)$/i;

const HOP_BY_HOP_HEADERS = new Set([
  'host',
  'connection',
  'content-length',
  'transfer-encoding',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'upgrade',
  'forwarded',
  'x-forwarded-for',
  'x-forwarded-host',
  'x-forwarded-proto',
  'cf-connecting-ip',
  'true-client-ip',
  'x-real-ip'
]);

const CANONICAL_HEADER_NAMES = new Map([
  ['accept', 'Accept'],
  ['accept-encoding', 'Accept-Encoding'],
  ['accept-language', 'Accept-Language'],
  ['authorization', 'Authorization'],
  ['cache-control', 'Cache-Control'],
  ['content-type', 'Content-Type'],
  ['cookie', 'Cookie'],
  ['origin', 'Origin'],
  ['pragma', 'Pragma'],
  ['range', 'Range'],
  ['referer', 'Referer'],
  ['referrer', 'Referer'],
  ['user-agent', 'User-Agent'],
  ['x-requested-with', 'X-Requested-With']
]);

const PROXY_ROUTE_HINTS = [
  '/ccproxy/',
  '/proxy/',
  '/proxy/stream',
  '/proxy/hls/',
  '/extractor/video',
  '/extractor/',
  '/hls?',
  '/lazy_extract/',
  '/vixsynthetic.m3u8',
  '/play_rd/',
  '/play_tb/'
];

const lastLogByKey = new Map();

function safeString(value) {
  if (value == null) return '';

  if (Array.isArray(value)) {
    return value
      .filter((entry) => entry != null && entry !== '')
      .map((entry) => String(entry).trim())
      .filter(Boolean)
      .join(', ');
  }

  return String(value).trim();
}

function safeDecodeURIComponent(value) {
  try {
    return decodeURIComponent(String(value || ''));
  } catch (_) {
    return String(value || '');
  }
}

function uniq(values = []) {
  return Array.from(new Set(values.filter(Boolean)));
}

function canonicalHeaderName(name) {
  const raw = String(name || '').trim();
  if (!raw || !HEADER_NAME_RE.test(raw)) return '';

  const lower = raw.toLowerCase();
  if (CANONICAL_HEADER_NAMES.has(lower)) return CANONICAL_HEADER_NAMES.get(lower);

  return lower
    .split('-')
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join('-');
}

function isValidHttpUrl(value) {
  try {
    const parsed = new URL(String(value || ''));
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch (_) {
    return false;
  }
}

function normalizeUrl(value, base = null) {
  try {
    if (!value) return null;

    const raw = String(value).trim();
    if (!raw) return null;
    if (raw.startsWith('//')) return new URL(`https:${raw}`).toString();
    if (/^https?:\/\//i.test(raw)) return new URL(raw).toString();
    if (base) return new URL(raw, base).toString();

    return null;
  } catch (_) {
    return null;
  }
}

function getOrigin(value, fallback = '') {
  try {
    return new URL(String(value || '')).origin;
  } catch (_) {
    return fallback;
  }
}

function isHlsUrl(value, contentType = '') {
  return /mpegurl|x-mpegurl|application\/vnd\.apple\.mpegurl/i.test(String(contentType || ''))
    || /\.m3u8(?:$|[?#])/i.test(String(value || ''));
}

function getHeader(headers, name) {
  const target = String(name || '').toLowerCase();

  for (const [key, value] of Object.entries(headers || {})) {
    const lower = String(key || '').toLowerCase();

    if (lower === target && value != null && value !== '') {
      return safeString(value);
    }

    if (target === 'referer' && lower === 'referrer' && value != null && value !== '') {
      return safeString(value);
    }
  }

  return '';
}

function normalizeRangeHeader(value, options = {}) {
  if (options.allowRange === false) return null;
  return /^bytes=\d*-\d*(?:,\d*-\d*)*$/i.test(value) ? value : null;
}

function normalizeHeaderValue(name, value, options = {}) {
  const canonical = canonicalHeaderName(name);
  const text = safeString(value);

  if (!canonical || !text) return null;
  if (text.length > MAX_HEADER_VALUE_LENGTH) return null;
  if (HEADER_VALUE_CONTROL_RE.test(text)) return null;

  if (canonical === 'Range') {
    return normalizeRangeHeader(text, options);
  }

  if (canonical === 'Referer') {
    return normalizeUrl(text) || null;
  }

  if (canonical === 'Origin') {
    return getOrigin(text, '') || null;
  }

  if (canonical === 'Authorization') {
    return options.allowAuthorization === false ? null : text;
  }

  if (canonical === 'Accept-Encoding') {
    return options.forceIdentityEncoding === false ? text : 'identity';
  }

  return text;
}

function setHeader(out, name, value, state) {
  const canonical = canonicalHeaderName(name);
  if (!canonical || value == null || value === '') return false;

  const text = safeString(value);
  if (!text) return false;

  if (Object.prototype.hasOwnProperty.call(out, canonical) && out[canonical] !== text) {
    state.duplicated.push(canonical);
  }

  if (out[canonical] !== text) {
    out[canonical] = text;
    state.normalized = true;
  }

  return true;
}

function normalizeProxyHeaders(headers = {}, options = {}) {
  const out = {};
  const state = {
    dropped: [],
    duplicated: [],
    normalized: false
  };

  for (const [rawKey, rawValue] of Object.entries(headers || {})) {
    const lower = String(rawKey || '').trim().toLowerCase();

    if (!lower || HOP_BY_HOP_HEADERS.has(lower)) {
      if (lower) state.dropped.push(lower);
      continue;
    }

    const canonical = canonicalHeaderName(rawKey);
    const value = normalizeHeaderValue(canonical, rawValue, options);

    if (!canonical || !value) {
      state.dropped.push(lower || String(rawKey || ''));
      continue;
    }

    if (Object.prototype.hasOwnProperty.call(out, canonical)) {
      state.duplicated.push(canonical);
    }

    if (canonical !== rawKey || value !== safeString(rawValue)) {
      state.normalized = true;
    }

    out[canonical] = value;
  }

  const targetUrl = normalizeUrl(options.targetUrl || '');

  if (targetUrl) {
    const targetOrigin = getOrigin(targetUrl, '');

    if (!out.Referer && options.fillReferer !== false) {
      setHeader(out, 'Referer', normalizeUrl(options.referer || `${targetOrigin}/`) || `${targetOrigin}/`, state);
    }

    if (!out.Origin && options.fillOrigin !== false) {
      setHeader(out, 'Origin', getOrigin(out.Referer, targetOrigin) || targetOrigin, state);
    }

    if (!out.Accept) {
      setHeader(out, 'Accept', options.accept || (isHlsUrl(targetUrl, options.contentType) ? DEFAULT_HLS_ACCEPT : DEFAULT_ACCEPT), state);
    }
  }

  if (!out['User-Agent'] && options.fillUserAgent !== false) {
    setHeader(out, 'User-Agent', options.userAgent || DEFAULT_USER_AGENT, state);
  }

  if (!out['Accept-Language'] && options.fillAcceptLanguage !== false) {
    setHeader(out, 'Accept-Language', options.acceptLanguage || DEFAULT_ACCEPT_LANGUAGE, state);
  }

  if (options.forceIdentityEncoding !== false && out['Accept-Encoding'] !== 'identity') {
    setHeader(out, 'Accept-Encoding', 'identity', state);
  }

  return {
    headers: out,
    changed: state.normalized || state.dropped.length > 0 || state.duplicated.length > 0,
    dropped: state.dropped,
    duplicated: uniq(state.duplicated)
  };
}

function moveBasicAuthFromUrl(targetUrl, headers = {}) {
  const normalized = normalizeUrl(targetUrl);
  const nextHeaders = { ...(headers || {}) };

  if (!normalized) {
    return { url: targetUrl, headers: nextHeaders, moved: false };
  }

  try {
    const parsed = new URL(normalized);

    if (!parsed.username && !parsed.password) {
      return { url: normalized, headers: nextHeaders, moved: false };
    }

    const username = safeDecodeURIComponent(parsed.username);
    const password = safeDecodeURIComponent(parsed.password);

    parsed.username = '';
    parsed.password = '';

    if (!getHeader(nextHeaders, 'authorization')) {
      nextHeaders.Authorization = `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;
    }

    return {
      url: parsed.toString(),
      headers: nextHeaders,
      moved: true
    };
  } catch (_) {
    return { url: targetUrl, headers: nextHeaders, moved: false };
  }
}

function sameOrigin(first, second) {
  const a = normalizeUrl(first);
  const b = normalizeUrl(second);
  if (!a || !b) return false;
  return getOrigin(a) === getOrigin(b);
}

function pathLooksProxy(pathname, normalizedUrl) {
  return PROXY_ROUTE_HINTS.some((hint) => pathname.startsWith(hint) || normalizedUrl.includes(hint));
}

function isAlreadyProxiedUrl(targetUrl, options = {}) {
  const normalized = normalizeUrl(targetUrl);
  if (!normalized) return false;

  try {
    const parsed = new URL(normalized);
    const pathname = parsed.pathname || '/';
    const looksProxy = pathLooksProxy(pathname, normalized);

    if (pathname.startsWith('/lazy_extract/')) return true;

    const addonBase = normalizeUrl(options.addonBase || options.reqHost || '');
    if (addonBase && sameOrigin(normalized, addonBase) && looksProxy) return true;

    const mediaflowUrl = normalizeUrl(options.mediaflowUrl || '');
    if (mediaflowUrl && sameOrigin(normalized, mediaflowUrl)) return true;

    const host = parsed.hostname.toLowerCase();
    return (host.includes('mediaflow') || host.includes('krakenproxy')) && looksProxy;
  } catch (_) {
    return false;
  }
}

function shouldProxyUrl(targetUrl, options = {}) {
  const normalized = normalizeUrl(targetUrl);

  if (!normalized || !isValidHttpUrl(normalized)) {
    return { proxy: false, reason: 'invalid_url' };
  }

  if (isAlreadyProxiedUrl(normalized, options)) {
    return { proxy: false, reason: 'already_proxied' };
  }

  const service = String(options.service || options.provider || '').toLowerCase();

  if (/^(?:rd|realdebrid|real-debrid|tb|torbox|torrent|debrid)$/i.test(service)) {
    return { proxy: false, reason: 'debrid_or_torrent_service' };
  }

  return { proxy: true, reason: 'web_stream' };
}

function prepareProxyTarget(targetUrl, headers = {}, options = {}) {
  const authMoved = moveBasicAuthFromUrl(targetUrl, headers || {});
  const decision = shouldProxyUrl(authMoved.url, options);
  const normalized = normalizeProxyHeaders(authMoved.headers, {
    ...options,
    targetUrl: authMoved.url
  });

  return {
    url: normalizeUrl(authMoved.url) || authMoved.url,
    headers: normalized.headers,
    shouldProxy: decision.proxy,
    reason: decision.reason,
    changed: authMoved.moved || normalized.changed,
    basicAuthMoved: authMoved.moved,
    dropped: normalized.dropped,
    duplicated: normalized.duplicated,
    headerCount: Object.keys(normalized.headers || {}).length
  };
}

function redactedHost(targetUrl) {
  try {
    return new URL(String(targetUrl || '')).hostname.replace(/^www\./i, '');
  } catch (_) {
    return 'unknown';
  }
}

function proxyHeaderLogLine(result, targetUrl, prefix = '[PROXY HEADERS]') {
  const parts = [
    prefix,
    `normalized=${Boolean(result?.changed)}`,
    `host=${redactedHost(targetUrl)}`,
    `headers=${Number(result?.headerCount || 0)}`
  ];

  if (result?.basicAuthMoved) parts.push('basicAuthMoved=true');
  if (result?.reason) parts.push(`reason=${result.reason}`);
  if (Array.isArray(result?.dropped) && result.dropped.length) parts.push(`dropped=${result.dropped.length}`);
  if (Array.isArray(result?.duplicated) && result.duplicated.length) parts.push(`deduped=${result.duplicated.join(',')}`);

  return parts.join(' ');
}

function getLogThrottleKey(result, targetUrl) {
  return [
    redactedHost(targetUrl),
    result?.reason || 'ok',
    result?.basicAuthMoved ? 'auth' : 'noauth',
    result?.changed ? 'changed' : 'same'
  ].join(':');
}

function writeLog(logger, line) {
  if (logger && typeof logger.info === 'function') {
    logger.info(line);
    return true;
  }

  if (logger && typeof logger.log === 'function') {
    logger.log(line);
    return true;
  }

  return false;
}

function maybeLogProxyHeaderDecision(result, targetUrl, { logger = console, prefix = '[PROXY HEADERS]', force = false } = {}) {
  if (!result) return false;
  if (!force && !result.changed && result.reason !== 'already_proxied') return false;

  const key = getLogThrottleKey(result, targetUrl);
  const now = Date.now();
  const last = lastLogByKey.get(key) || 0;

  if (!force && now - last < LOG_THROTTLE_MS) {
    return false;
  }

  lastLogByKey.set(key, now);
  return writeLog(logger, proxyHeaderLogLine(result, targetUrl, prefix));
}

module.exports = {
  DEFAULT_USER_AGENT,
  DEFAULT_ACCEPT_LANGUAGE,
  canonicalHeaderName,
  getHeader,
  isAlreadyProxiedUrl,
  isHlsUrl,
  moveBasicAuthFromUrl,
  normalizeProxyHeaders,
  prepareProxyTarget,
  proxyHeaderLogLine,
  shouldProxyUrl,
  maybeLogProxyHeaderDecision
};
