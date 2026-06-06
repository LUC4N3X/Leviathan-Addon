'use strict';

const http2 = require('http2');
const tls = require('tls');
const zlib = require('zlib');
const { URL } = require('url');

const DEFAULT_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36';

const CHROME_H2_SETTINGS = {
  headerTableSize: 65536,
  enablePush: false,
  maxConcurrentStreams: 1000,
  initialWindowSize: 6291456,
  maxFrameSize: 16384,
  maxHeaderListSize: 262144
};

const CHROME_TLS_OPTIONS = {
  ciphers: [
    'TLS_AES_128_GCM_SHA256',
    'TLS_AES_256_GCM_SHA384',
    'TLS_CHACHA20_POLY1305_SHA256',
    'ECDHE-ECDSA-AES128-GCM-SHA256',
    'ECDHE-RSA-AES128-GCM-SHA256',
    'ECDHE-ECDSA-AES256-GCM-SHA384',
    'ECDHE-RSA-AES256-GCM-SHA384'
  ].join(':'),
  ecdhCurve: 'X25519:prime256v1:secp384r1',
  minVersion: 'TLSv1.2',
  ALPNProtocols: ['h2', 'http/1.1']
};

class H2ReplayPool {
  constructor({ maxSize = 50, ttlMs = 5 * 60 * 1000 } = {}) {
    this.pool = new Map();
    this.maxSize = Math.max(1, Number(maxSize) || 50);
    this.ttlMs = Math.max(1000, Number(ttlMs) || 5 * 60 * 1000);
    this.cleanupInterval = setInterval(() => this.evict(), Math.min(this.ttlMs, 60_000));
    if (this.cleanupInterval?.unref) this.cleanupInterval.unref();
  }

  get(origin) {
    const entry = this.pool.get(origin);
    if (!entry) return null;
    if (Date.now() > entry.expiresAt || entry.session.closed || entry.session.destroyed) {
      this.delete(origin);
      return null;
    }
    this.pool.delete(origin);
    this.pool.set(origin, entry);
    return entry.session;
  }

  set(origin, session) {
    if (this.pool.size >= this.maxSize) {
      const oldest = this.pool.keys().next().value;
      if (oldest) this.delete(oldest);
    }
    this.pool.set(origin, {
      session,
      expiresAt: Date.now() + this.ttlMs
    });
  }

  delete(origin) {
    const entry = this.pool.get(origin);
    if (!entry) return;
    this.pool.delete(origin);
    try { entry.session.destroy(); } catch (_) {}
  }

  evict() {
    const now = Date.now();
    for (const [origin, entry] of this.pool.entries()) {
      if (now > entry.expiresAt || entry.session.closed || entry.session.destroyed) {
        this.delete(origin);
      }
    }
  }

  closeAll() {
    if (this.cleanupInterval) clearInterval(this.cleanupInterval);
    this.cleanupInterval = null;
    for (const origin of Array.from(this.pool.keys())) this.delete(origin);
  }

  state() {
    return {
      size: this.pool.size,
      maxSize: this.maxSize,
      ttlMs: this.ttlMs
    };
  }
}

const defaultPool = new H2ReplayPool();

function createH2ReplayPool(options = {}) {
  return new H2ReplayPool(options);
}

function normalizeSetCookies(value) {
  if (!value) return [];
  return (Array.isArray(value) ? value : [value]).map(String).filter(Boolean);
}

function safeHeaderName(name) {
  const key = String(name || '').trim().toLowerCase();
  if (!key || key.startsWith(':')) return null;
  if (['connection', 'host', 'http2-settings', 'keep-alive', 'proxy-connection', 'te', 'transfer-encoding', 'upgrade'].includes(key)) {
    return null;
  }
  return key;
}

function mergeExtraHeaders(base, extraHeaders = {}) {
  if (!extraHeaders || typeof extraHeaders !== 'object') return base;
  for (const [name, value] of Object.entries(extraHeaders)) {
    const key = safeHeaderName(name);
    if (!key || value == null || value === '') continue;
    base[key] = String(value);
  }
  return base;
}

function getOrigin(targetUrl) {
  const target = new URL(targetUrl);
  if (target.protocol !== 'https:' && target.protocol !== 'http:') {
    throw new Error(`h2_replay_unsupported_protocol:${target.protocol}`);
  }
  return target.origin;
}

function getH2Session(origin, pool = defaultPool) {
  const cached = pool.get(origin);
  if (cached) return cached;

  const originUrl = new URL(origin);
  const connectOptions = {
    settings: CHROME_H2_SETTINGS
  };

  if (originUrl.protocol === 'https:') {
    connectOptions.createConnection = (_authority, opts) => {
      Object.assign(opts, CHROME_TLS_OPTIONS, { servername: originUrl.hostname });
      return tls.connect(opts);
    };
  }

  const session = http2.connect(origin, connectOptions);
  session.on('error', () => pool.delete(origin));
  session.on('goaway', () => pool.delete(origin));
  session.on('close', () => pool.delete(origin));
  pool.set(origin, session);
  return session;
}

function decodeBody(buffer, encoding = '') {
  const enc = String(encoding || '').toLowerCase().trim();
  if (!buffer || !buffer.length) return '';
  if (enc === 'br') return zlib.brotliDecompressSync(buffer).toString('utf8');
  if (enc === 'gzip' || enc === 'x-gzip') return zlib.gunzipSync(buffer).toString('utf8');
  if (enc === 'deflate') {
    try { return zlib.inflateSync(buffer).toString('utf8'); }
    catch (_) { return zlib.inflateRawSync(buffer).toString('utf8'); }
  }
  return buffer.toString('utf8');
}

function buildRequestHeaders(target, options = {}) {
  const headers = {
    ':method': String(options.method || 'GET').toUpperCase(),
    ':path': target.pathname + target.search,
    ':authority': target.host,
    ':scheme': target.protocol.replace(':', ''),
    'user-agent': options.userAgent || DEFAULT_UA,
    'accept': options.accept || 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    'accept-encoding': 'gzip, deflate, br',
    'accept-language': options.acceptLanguage || 'en-US,en;q=0.9'
  };
  if (options.cookieHeader) headers.cookie = String(options.cookieHeader);
  if (options.referer) headers.referer = String(options.referer);
  return mergeExtraHeaders(headers, options.headers || options.extraHeaders || {});
}

async function h2ReplayRequest(targetUrl, options = {}) {
  const target = new URL(targetUrl);
  const origin = getOrigin(target.toString());
  const pool = options.pool || defaultPool;
  const maxRedirects = Math.max(0, Math.min(5, Number(options.maxRedirects ?? 3) || 0));
  const timeoutMs = Math.max(250, Number(options.timeoutMs || options.timeout || 1200) || 1200);
  const maxBodyBytes = Math.max(1024, Number(options.maxBodyBytes || 2 * 1024 * 1024) || 2 * 1024 * 1024);

  const result = await new Promise((resolve, reject) => {
    const session = getH2Session(origin, pool);
    const body = options.body ?? options.data ?? null;
    const req = session.request(buildRequestHeaders(target, options), { endStream: body == null });
    const chunks = [];
    let received = 0;
    let respHeaders = {};
    let settled = false;

    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(value);
    };

    const timer = setTimeout(() => {
      try { req.close(http2.constants.NGHTTP2_CANCEL); } catch (_) {}
      finish(reject, new Error(`h2_replay_timeout:${timeoutMs}`));
    }, timeoutMs);
    if (timer?.unref) timer.unref();

    req.on('response', (headers) => {
      respHeaders = headers || {};
    });

    req.on('data', (chunk) => {
      if (settled) return;
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      received += buffer.length;
      if (received > maxBodyBytes) {
        try { req.close(http2.constants.NGHTTP2_CANCEL); } catch (_) {}
        finish(reject, new Error(`h2_replay_body_too_large:${maxBodyBytes}`));
        return;
      }
      chunks.push(buffer);
    });

    req.on('end', () => {
      try {
        const buffer = Buffer.concat(chunks);
        const bodyText = decodeBody(buffer, respHeaders['content-encoding']);
        finish(resolve, {
          status: Number(respHeaders[':status'] || 0),
          url: target.toString(),
          headers: respHeaders,
          setCookies: normalizeSetCookies(respHeaders['set-cookie']),
          body: bodyText
        });
      } catch (error) {
        finish(reject, error);
      }
    });

    req.on('error', (error) => finish(reject, error));
    req.setTimeout(timeoutMs, () => {
      try { req.close(http2.constants.NGHTTP2_CANCEL); } catch (_) {}
      finish(reject, new Error(`h2_replay_timeout:${timeoutMs}`));
    });

    if (body != null) req.end(body);
    else req.end();
  });

  if (
    [301, 302, 303, 307, 308].includes(result.status)
    && result.headers?.location
    && maxRedirects > 0
  ) {
    const nextUrl = new URL(String(result.headers.location), target);
    if (nextUrl.origin === origin || options.followCrossOrigin === true) {
      return h2ReplayRequest(nextUrl.toString(), {
        ...options,
        method: result.status === 303 ? 'GET' : options.method,
        body: result.status === 303 ? null : options.body,
        data: result.status === 303 ? null : options.data,
        maxRedirects: maxRedirects - 1,
        referer: options.referer || target.toString()
      });
    }
  }

  return result;
}

function h2ReplayKeepAlive(origin, options = {}) {
  const pool = options.pool || defaultPool;
  const session = pool.get(origin);
  if (!session || session.closed || session.destroyed) return false;
  try {
    session.ping((error) => {
      if (error) pool.delete(origin);
    });
    return true;
  } catch (_) {
    pool.delete(origin);
    return false;
  }
}

module.exports = {
  DEFAULT_UA,
  H2ReplayPool,
  createH2ReplayPool,
  h2ReplayRequest,
  h2ReplayKeepAlive,
  h2ReplayPool: defaultPool
};
