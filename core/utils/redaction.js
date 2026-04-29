'use strict';

const CONFIG_ROUTE_CHILDREN = new Set(['manifest.json', 'configure', 'catalog', 'stream']);
const SENSITIVE_QUERY_KEYS = /(?:^|[_-])(?:key|api_key|apikey|token|secret|password|pass|auth|authorization|conf|config|tmdb|rd|tb|torbox|debrid|mediaflow)(?:$|[_-])/i;
const SENSITIVE_OBJECT_KEYS = /^(?:authorization|proxy-authorization|cookie|set-cookie|key|apiKey|api_key|token|accessToken|refreshToken|secret|password|pass|conf|config|rawConf|userConfStr|rd|tb|torbox|realdebrid|real_debrid|debrid|tmdb|mediaflow)$/i;

function splitPathAndQuery(value) {
  const raw = String(value || '');
  const queryIndex = raw.indexOf('?');
  if (queryIndex === -1) return { pathname: raw, query: '' };
  return {
    pathname: raw.slice(0, queryIndex),
    query: raw.slice(queryIndex + 1)
  };
}

function decodeBase64UrlSegment(segment) {
  try {
    const normalized = String(segment || '').replace(/-/g, '+').replace(/_/g, '/');
    const padding = normalized.length % 4 === 0 ? '' : '='.repeat(4 - (normalized.length % 4));
    return Buffer.from(normalized + padding, 'base64').toString('utf8');
  } catch (_) {
    return '';
  }
}

function isLikelyEncodedConfigSegment(segment) {
  const raw = String(segment || '').trim();
  if (raw.length < 12 || !/^[A-Za-z0-9_-]+={0,2}$/.test(raw)) return false;

  const decoded = decodeBase64UrlSegment(raw).trim();
  if (decoded.startsWith('{') && decoded.endsWith('}') && /"(?:key|service|filters|rd|torbox|tmdb|mediaflow)"/i.test(decoded)) {
    return true;
  }

  return raw.length >= 80;
}

function sanitizeQueryString(query) {
  if (!query) return '';

  return String(query)
    .split('&')
    .map((part) => {
      if (!part) return part;
      const separatorIndex = part.indexOf('=');
      const rawKey = separatorIndex === -1 ? part : part.slice(0, separatorIndex);
      let key = rawKey;
      try {
        key = decodeURIComponent(rawKey.replace(/\+/g, ' '));
      } catch (_) {}
      if (!SENSITIVE_QUERY_KEYS.test(key)) return part;
      return `${rawKey}=[REDACTED]`;
    })
    .join('&');
}

function sanitizeRequestPath(value) {
  const { pathname, query } = splitPathAndQuery(value);
  const parts = String(pathname || '').split('/');

  if (
    parts.length > 2
    && parts[1]
    && CONFIG_ROUTE_CHILDREN.has(String(parts[2] || '').toLowerCase())
    && isLikelyEncodedConfigSegment(parts[1])
  ) {
    parts[1] = ':conf';
  }

  const sanitizedQuery = sanitizeQueryString(query);
  return sanitizedQuery ? `${parts.join('/')}?${sanitizedQuery}` : parts.join('/');
}

function redactSensitiveString(value) {
  return String(value || '')
    .replace(/\/[A-Za-z0-9_-]{80,}(\/(?:manifest\.json|configure|catalog|stream)\b)/gi, '/:conf$1')
    .replace(/(authorization\s*[:=]\s*bearer\s+)[^\s'",}]+/gi, '$1[REDACTED]')
    .replace(/((?:api[_-]?key|token|secret|password|pass|tmdb|rd|tb|torbox|debrid|conf|config)\s*[=:]\s*)[^\s&'",}]+/gi, '$1[REDACTED]')
    .replace(/("(?:key|apiKey|api_key|token|secret|password|pass|conf|config|tmdb|rd|tb|torbox|debrid)"\s*:\s*")[^"]*(")/gi, '$1[REDACTED]$2');
}

function redactSensitiveValue(key, value, seen = new WeakSet()) {
  if (SENSITIVE_OBJECT_KEYS.test(String(key || ''))) return '[REDACTED]';
  if (typeof value === 'string') {
    return String(key || '').toLowerCase() === 'path'
      ? sanitizeRequestPath(value)
      : redactSensitiveString(value);
  }
  if (Array.isArray(value)) return value.map((entry) => redactSensitiveValue('', entry, seen));
  if (!value || typeof value !== 'object') return value;
  if (seen.has(value)) return '[Circular]';

  seen.add(value);
  const output = {};
  for (const [entryKey, entryValue] of Object.entries(value)) {
    output[entryKey] = redactSensitiveValue(entryKey, entryValue, seen);
  }
  seen.delete(value);
  return output;
}

function redactLogInfo(info) {
  if (!info || typeof info !== 'object') return info;
  for (const key of Object.keys(info)) {
    info[key] = redactSensitiveValue(key, info[key]);
  }
  return info;
}

module.exports = {
  sanitizeRequestPath,
  redactSensitiveString,
  redactSensitiveValue,
  redactLogInfo
};
