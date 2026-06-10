'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const { URL } = require('url');
const { cfRedisStore } = require('./cf_redis_store');
const antibotSignatures = require('./antibot_signatures');

const DISK_PATH = (() => {
  if (process.env.CF_NATIVE_DISABLE_DISK === '1') return null;
  const explicit = (process.env.CF_NATIVE_DISK_PATH || '').trim();
  if (explicit) return explicit;
  const home = process.env.HOME || os.tmpdir();
  return path.join(home, '.leviathan', 'cf_clearance.json');
})();

const CLEARANCE_TTL_MS = Math.max(60_000, Number(process.env.CF_NATIVE_TTL_MS) || 25 * 60 * 1000);
const IUAM_TIMEOUT_MS = Math.max(2000, Number(process.env.CF_NATIVE_IUAM_TIMEOUT_MS) || 12_000);
const HOST_FAIL_THRESHOLD = Math.max(1, Number(process.env.CF_NATIVE_HOST_FAIL_THRESHOLD) || 3);
const HOST_FAIL_COOLDOWN_MS = Math.max(30_000, Number(process.env.CF_NATIVE_HOST_FAIL_COOLDOWN_MS) || 5 * 60 * 1000);
const MAX_HOSTS = Math.max(32, Number(process.env.CF_NATIVE_MAX_HOSTS) || 256);
const CLEARANCE_EGRESS_KEY = String(
  process.env.CF_CLEARANCE_EGRESS_KEY
  || process.env.PROVIDER_EGRESS_KEY
  || process.env.OUTBOUND_PROXY_ID
  || process.env.HTTPS_PROXY
  || process.env.HTTP_PROXY
  || 'direct'
).trim() || 'direct';
const REDIS_NATIVE_TTL_SECONDS = Math.max(60, Math.floor(CLEARANCE_TTL_MS / 1000));

const DEFAULT_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36';

const CF_CHALLENGE_MARKERS = [
  /just a moment/i,
  /checking your browser/i,
  /cf-browser-verification/i,
  /__cf_chl_opt/i,
  /cf-chl-widget/i,
  /challenge-platform/i,
  /turnstile/i,
];

const IUAM_MARKERS = [
  /jschl[_-]vc/i,
  /jschl[_-]answer/i,
  /\bk\d+ \s*=\s*\{/i,
  /name="pass"\s+value=/i,
];

const TURNSTILE_MARKERS = [
  /turnstile\.cloudflare\.com/i,
  /cf-turnstile-response/i,
  /cdn-cgi\/challenge-platform\/h\/[bg]\/orchestrate/i,
];

function isChallengeBody(body) {
  if (!body) return false;
  if (CF_CHALLENGE_MARKERS.some((r) => r.test(body))) return true;
  return antibotSignatures.bodyHasCloudflareChallenge(body);
}

function isIuamChallengeBody(body) {
  if (!body) return false;
  const turnstile = TURNSTILE_MARKERS.some((r) => r.test(body));
  if (turnstile) return false;
  const iuam = IUAM_MARKERS.filter((r) => r.test(body)).length;
  return iuam >= 2;
}

function isTurnstileBody(body) {
  if (!body) return false;
  return TURNSTILE_MARKERS.some((r) => r.test(body));
}

function hostOf(value) {
  try {
    return new URL(value).host.toLowerCase();
  } catch (_) {
    return '';
  }
}

function originOf(value) {
  try {
    const u = new URL(value);
    return `${u.protocol}//${u.host}`;
  } catch (_) {
    return null;
  }
}

let diskPending = null;
function flushToDiskSoon(state) {
  if (!DISK_PATH || diskPending) return;
  diskPending = setTimeout(() => {
    diskPending = null;
    try {
      fs.mkdirSync(path.dirname(DISK_PATH), { recursive: true });
      const tmp = `${DISK_PATH}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(state), 'utf8');
      fs.renameSync(tmp, DISK_PATH);
    } catch (err) {
      try {
        process.stderr.write(`[cf_native_solver] disk flush failed: ${err && err.message}\n`);
      } catch (_) {}
    }
  }, 100);
  if (diskPending.unref) diskPending.unref();
}

function loadFromDisk() {
  if (!DISK_PATH) return {};
  try {
    if (!fs.existsSync(DISK_PATH)) return {};
    const raw = fs.readFileSync(DISK_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return {};
    const now = Date.now();
    const filtered = {};
    let kept = 0;
    for (const [host, bundle] of Object.entries(parsed)) {
      if (!bundle || typeof bundle !== 'object') continue;
      const expiresAt = Number(bundle.expiresAt || 0);
      if (expiresAt > now) {
        filtered[host] = bundle;
        kept += 1;
      }
    }
    if (kept > 0) {
      process.stderr.write(`[cf_native_solver] loaded ${kept} clearance bundles from ${DISK_PATH}\n`);
    }
    return filtered;
  } catch (_) {
    return {};
  }
}

class ClearancePool {
  constructor() {
    this._byHost = loadFromDisk();
  }

  get(host) {
    if (!host) return null;
    const bundle = this._byHost[host];
    if (!bundle) return null;
    if (Number(bundle.expiresAt || 0) <= Date.now()) {
      delete this._byHost[host];
      flushToDiskSoon(this._byHost);
      return null;
    }
    return bundle;
  }

  async getShared(host, options = {}) {
    const local = this.get(host);
    if (local) return local;
    if (!host) return null;
    try {
      const bundle = await cfRedisStore.getNativeClearance({
        host,
        egressKey: options.egressKey || CLEARANCE_EGRESS_KEY
      });
      if (!bundle || Number(bundle.expiresAt || 0) <= Date.now()) return null;
      this._byHost[host] = { ...bundle };
      flushToDiskSoon(this._byHost);
      return this._byHost[host];
    } catch (_) {
      return null;
    }
  }

  put(host, bundle) {
    if (!host || !bundle) return;
    const expiresAt = Date.now() + CLEARANCE_TTL_MS;
    this._byHost[host] = {
      cookies: normalizeCookieObject(bundle.cookies || {}),
      userAgent: bundle.userAgent || DEFAULT_UA,
      strategy: bundle.strategy || 'unknown',
      acquiredAt: Date.now(),
      expiresAt,
      finalUrl: bundle.finalUrl || null,
      egressKey: bundle.egressKey || CLEARANCE_EGRESS_KEY,
    };
    const hosts = Object.keys(this._byHost);
    if (hosts.length > MAX_HOSTS) {
      hosts
        .map((h) => [h, this._byHost[h].acquiredAt || 0])
        .sort((a, b) => a[1] - b[1])
        .slice(0, hosts.length - MAX_HOSTS)
        .forEach(([h]) => { delete this._byHost[h]; });
    }
    flushToDiskSoon(this._byHost);
    cfRedisStore.saveNativeClearance({
      host,
      egressKey: this._byHost[host].egressKey || CLEARANCE_EGRESS_KEY,
      bundle: this._byHost[host],
      ttlSeconds: REDIS_NATIVE_TTL_SECONDS
    }).catch(() => {});
  }

  invalidate(host, options = {}) {
    if (!host) return;
    if (host in this._byHost) {
      delete this._byHost[host];
      flushToDiskSoon(this._byHost);
    }
    cfRedisStore.deleteNativeClearance({
      host,
      egressKey: options.egressKey || CLEARANCE_EGRESS_KEY
    }).catch(() => {});
  }

  cookieHeaderForUrl(url) {
    const host = hostOf(url);
    const bundle = this.get(host);
    if (!bundle || !bundle.cookies) return '';
    return cookiesToHeader(bundle.cookies);
  }

  stats() {
    return {
      hosts: Object.keys(this._byHost).length,
      diskPath: DISK_PATH,
      ttlMs: CLEARANCE_TTL_MS,
      redisEnabled: cfRedisStore.isNativeEnabled(),
      egressKey: CLEARANCE_EGRESS_KEY,
    };
  }
}

const _pool = new ClearancePool();

class HostMemory {
  constructor() {
    this._byHost = new Map();
  }

  _get(host) {
    let entry = this._byHost.get(host);
    if (!entry) {
      entry = { failures: Object.create(null), lastGood: null, lastFailureAt: 0 };
      this._byHost.set(host, entry);
    } else {
      this._byHost.delete(host);
      this._byHost.set(host, entry);
    }
    return entry;
  }

  noteSuccess(host, strategy) {
    if (!host) return;
    const entry = this._get(host);
    entry.lastGood = strategy || null;
    entry.failures[strategy || ''] = 0;
    this._trim();
  }

  noteFailure(host, strategy) {
    if (!host) return;
    const entry = this._get(host);
    entry.failures[strategy || ''] = (entry.failures[strategy || ''] || 0) + 1;
    entry.lastFailureAt = Date.now();
    this._trim();
  }

  isStrategyCooled(host, strategy) {
    const entry = this._byHost.get(host);
    if (!entry) return false;
    const count = entry.failures[strategy || ''] || 0;
    if (count < HOST_FAIL_THRESHOLD) return false;
    return (Date.now() - (entry.lastFailureAt || 0)) < HOST_FAIL_COOLDOWN_MS;
  }

  lastGood(host) {
    const entry = this._byHost.get(host);
    return entry ? entry.lastGood : null;
  }

  _trim() {
    while (this._byHost.size > MAX_HOSTS) {
      const firstKey = this._byHost.keys().next().value;
      this._byHost.delete(firstKey);
    }
  }
}

const _memory = new HostMemory();

async function httpRequest(targetUrl, {
  method = 'GET',
  headers = {},
  cookieHeader = '',
  body = null,
  timeoutMs = IUAM_TIMEOUT_MS,
  followRedirects = true,
  maxRedirects = 5,
} = {}) {
  if (typeof fetch !== 'function') {
    throw new Error('cf_native_solver: fetch() non disponibile (richiede Node 18+)');
  }

  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  const timeoutId = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;

  if (timeoutId?.unref) timeoutId.unref();

  try {
    const finalHeaders = { ...headers };
    const normalizedCookieHeader = cookiesToHeader(cookieHeader);
    if (normalizedCookieHeader) finalHeaders.Cookie = normalizedCookieHeader;

    const res = await fetch(targetUrl, {
      method,
      headers: finalHeaders,
      body: body == null ? undefined : body,
      redirect: followRedirects ? 'follow' : 'manual',
      signal: controller ? controller.signal : undefined,
    });

    const text = await res.text();
    const respHeaders = {};
    const setCookies = [];

    if (typeof res.headers.getSetCookie === 'function') {
      try {
        setCookies.push(...res.headers.getSetCookie().filter(Boolean).map(String));
      } catch (_) {}
    }

    res.headers.forEach((value, key) => {
      const normalizedKey = key.toLowerCase();
      respHeaders[normalizedKey] = value;
      if (normalizedKey === 'set-cookie' && !setCookies.length) {
        setCookies.push(...splitSetCookieHeader(value));
      }
    });

    if (!setCookies.length && respHeaders['set-cookie']) {
      setCookies.push(...splitSetCookieHeader(respHeaders['set-cookie']));
    }

    return {
      status: res.status,
      url: res.url,
      headers: respHeaders,
      body: text,
      setCookies,
    };
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

function splitSetCookieHeader(value) {
  const raw = String(value || '').trim();
  if (!raw) return [];
  return raw.split(/,(?=\s*[^;,\s]+=)/g).map((item) => item.trim()).filter(Boolean);
}

function parseSetCookieValue(rawCookie) {
  if (!rawCookie) return null;
  if (typeof rawCookie === 'object') {
    const name = rawCookie.name || rawCookie.key;
    const value = rawCookie.value ?? rawCookie.val;
    if (!name || value == null) return null;
    return [String(name).trim(), String(value)];
  }
  const first = String(rawCookie).split(';')[0].trim();
  const eq = first.indexOf('=');
  if (eq <= 0) return null;
  return [first.slice(0, eq).trim(), first.slice(eq + 1).trim()];
}

function mergeSetCookies(jar, setCookies) {
  const target = jar && typeof jar === 'object' ? jar : {};
  if (!Array.isArray(setCookies)) return target;
  for (const raw of setCookies) {
    const parsed = parseSetCookieValue(raw);
    if (parsed && parsed[0]) target[parsed[0]] = parsed[1];
  }
  return target;
}

function cookieHeaderToObject(cookieHeader) {
  if (!cookieHeader) return {};
  if (typeof cookieHeader === 'object' && !Array.isArray(cookieHeader)) return { ...cookieHeader };

  const out = {};
  const items = Array.isArray(cookieHeader) ? cookieHeader : String(cookieHeader).split(';');

  for (const item of items) {
    const parsed = parseSetCookieValue(item);
    if (parsed && parsed[0]) out[parsed[0]] = parsed[1];
  }

  return out;
}

function normalizeCookieObject(cookies) {
  if (!cookies) return {};
  if (Array.isArray(cookies)) return mergeSetCookies({}, cookies);
  if (typeof cookies === 'string') return cookieHeaderToObject(cookies);
  if (typeof cookies === 'object') {
    const out = {};
    for (const [key, value] of Object.entries(cookies)) {
      if (key && value != null) out[key] = String(value);
    }
    return out;
  }
  return {};
}

function cookiesToHeader(cookies) {
  return Object.entries(normalizeCookieObject(cookies))
    .filter(([key, value]) => key && value != null)
    .map(([key, value]) => `${key}=${value}`)
    .join('; ');
}

function mergeCookieSources(...sources) {
  const out = {};
  for (const source of sources) {
    Object.assign(out, normalizeCookieObject(source));
  }
  return out;
}

function _decodeHtmlEntities(s) {
  if (!s) return '';
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function _extractFormFields(html) {
  const vcMatch = html.match(/name="jschl_vc"\s+value="([^"]+)"/i);
  const passMatch = html.match(/name="pass"\s+value="([^"]+)"/i);
  const actionMatch = html.match(/id="challenge-form"[^>]*action="([^"]+)"/i);
  if (!vcMatch || !passMatch || !actionMatch) return null;
  return {
    jschl_vc: vcMatch[1],
    pass: _decodeHtmlEntities(passMatch[1]),
    action: _decodeHtmlEntities(actionMatch[1]),
  };
}

function _extractChallengeScript(html) {
  const setTimeoutMatch = html.match(/setTimeout\(function\(\){\s*(var\s+[\s\S]+?)\s*a\.value\s*=/);
  if (!setTimeoutMatch) return null;
  return setTimeoutMatch[1];
}

async function solveIuamChallenge(html, url, options = {}) {
  if (!isIuamChallengeBody(html)) return null;

  const form = _extractFormFields(html);
  if (!form) return null;
  const challengeScript = _extractChallengeScript(html);
  if (!challengeScript) return null;

  const hostname = (() => { try { return new URL(url).hostname; } catch (_) { return ''; } })();

  let answer;
  try {
    const sandbox = {
      t: { innerHTML: hostname },
      a: { value: 0 },
    };
    const context = vm.createContext(sandbox, { codeGeneration: { strings: false, wasm: false } });
    const baseVarMatch = challengeScript.match(/var\s+([a-zA-Z_$][\w$]*)\s*=\s*\{"([^"]+)"\s*:/);
    if (!baseVarMatch) return null;
    const baseVar = baseVarMatch[1];
    const baseKey = baseVarMatch[2];
    const fullScript = `${challengeScript}\n;a.value = parseInt(${baseVar}.${baseKey}, 10) + t.innerHTML.length;`;
    const script = new vm.Script(fullScript, { timeout: 1500 });
    script.runInContext(context, { timeout: 1500 });
    answer = sandbox.a && sandbox.a.value;
  } catch (err) {
    return { solved: false, reason: `iuam-vm-error: ${err && err.message}` };
  }

  if (typeof answer !== 'number' || !isFinite(answer)) {
    return { solved: false, reason: 'iuam-answer-nan' };
  }

  const thinkMs = Math.max(0, Number(process.env.CF_NATIVE_IUAM_THINK_MS) || 4000);
  if (thinkMs > 0) await new Promise((r) => setTimeout(r, thinkMs));

  const submitUrl = new URL(form.action, url);
  submitUrl.searchParams.set('jschl_vc', form.jschl_vc);
  submitUrl.searchParams.set('pass', form.pass);
  submitUrl.searchParams.set('jschl_answer', String(answer));

  const submitHeaders = {
    'User-Agent': options.userAgent || DEFAULT_UA,
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'it-IT,it;q=0.9,en-US;q=0.8,en;q=0.7',
    'Referer': url,
  };

  const response = await httpRequest(submitUrl.toString(), {
    method: 'GET',
    headers: submitHeaders,
    cookieHeader: options.cookieHeader || '',
    timeoutMs: IUAM_TIMEOUT_MS,
  });

  const jar = cookieHeaderToObject(options.cookieHeader || '');
  mergeSetCookies(jar, response.setCookies);
  const stillChallenge = isChallengeBody(response.body);
  return {
    solved: !stillChallenge,
    status: response.status,
    finalUrl: response.url,
    body: response.body,
    cookies: jar,
    reason: stillChallenge ? 'iuam-rejected' : 'ok',
  };
}

async function tryCachedBypass(url, options = {}) {
  const host = hostOf(url);
  const bundle = _pool.get(host) || await _pool.getShared(host, options);
  if (!bundle) return null;

  const cookieHeader = cookiesToHeader(bundle.cookies || {});
  if (!cookieHeader) return null;

  try {
    const response = await httpRequest(url, {
      method: options.method || 'GET',
      headers: {
        'User-Agent': bundle.userAgent || DEFAULT_UA,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'it-IT,it;q=0.9,en-US;q=0.8,en;q=0.7',
        'Referer': originOf(url) ? `${originOf(url)}/` : '',
        ...(options.extraHeaders || {}),
      },
      cookieHeader,
      timeoutMs: options.timeoutMs || 6000,
    });
    if (response.status >= 200 && response.status < 400 && !isChallengeBody(response.body)) {
      _memory.noteSuccess(host, 'native:cached');
      return {
        html: response.body,
        url: response.url,
        status: response.status,
        cookies: { ...bundle.cookies, ...mergeSetCookies({}, response.setCookies) },
        userAgent: bundle.userAgent || DEFAULT_UA,
        strategy: 'native:cached',
      };
    }
    _pool.invalidate(host);
    _memory.noteFailure(host, 'native:cached');
    return null;
  } catch (_) {
    _memory.noteFailure(host, 'native:cached');
    return null;
  }
}

async function tryNativeIuamBypass(url, html, options = {}) {
  const host = hostOf(url);
  if (_memory.isStrategyCooled(host, 'native:iuam')) return null;
  if (!isIuamChallengeBody(html)) return null;
  try {
    const result = await solveIuamChallenge(html, url, options);
    if (!result || !result.solved) {
      _memory.noteFailure(host, 'native:iuam');
      return null;
    }
    const resultCookies = normalizeCookieObject(result.cookies || {});
    if (Object.keys(resultCookies).length) {
      _pool.put(host, {
        cookies: resultCookies,
        userAgent: options.userAgent || DEFAULT_UA,
        strategy: 'native:iuam',
        finalUrl: result.finalUrl,
      });
    }
    _memory.noteSuccess(host, 'native:iuam');
    return {
      html: result.body,
      url: result.finalUrl,
      status: result.status,
      cookies: normalizeCookieObject(result.cookies || {}),
      userAgent: options.userAgent || DEFAULT_UA,
      strategy: 'native:iuam',
    };
  } catch (err) {
    _memory.noteFailure(host, 'native:iuam');
    return null;
  }
}

async function tryNativeBypass(url, options = {}) {
  const cached = await tryCachedBypass(url, options);
  if (cached) return cached;

  let firstResponse;
  try {
    firstResponse = await httpRequest(url, {
      method: 'GET',
      headers: {
        'User-Agent': options.userAgent || DEFAULT_UA,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'it-IT,it;q=0.9,en-US;q=0.8,en;q=0.7',
        'Referer': originOf(url) ? `${originOf(url)}/` : '',
        ...(options.extraHeaders || {}),
      },
      cookieHeader: options.cookieHeader || '',
      timeoutMs: options.timeoutMs || 5000,
    });
  } catch (_) {
    return null;
  }

  if (firstResponse.status >= 200 && firstResponse.status < 400 && !isChallengeBody(firstResponse.body)) {
    return {
      html: firstResponse.body,
      url: firstResponse.url,
      status: firstResponse.status,
      cookies: mergeCookieSources(options.cookieHeader || '', firstResponse.setCookies || []),
      userAgent: options.userAgent || DEFAULT_UA,
      strategy: 'native:direct',
    };
  }

  if (isTurnstileBody(firstResponse.body)) return null;

  if (isIuamChallengeBody(firstResponse.body)) {
    const challengeCookies = mergeCookieSources(options.cookieHeader || '', firstResponse.setCookies || []);
    return tryNativeIuamBypass(url, firstResponse.body, {
      ...options,
      cookieHeader: cookiesToHeader(challengeCookies),
    });
  }

  return null;
}

function rememberClearance(url, { cookies, userAgent, strategy = 'external' } = {}) {
  const host = hostOf(url);
  const normalizedCookies = normalizeCookieObject(cookies);
  if (!host || !Object.keys(normalizedCookies).length) return;
  const has = Object.keys(normalizedCookies).some((key) => /^cf_clearance|^__cf|^cf_chl/i.test(key));
  if (!has) return;
  _pool.put(host, {
    cookies: normalizedCookies,
    userAgent: userAgent || DEFAULT_UA,
    strategy,
    egressKey: process.env.CF_CLEARANCE_EGRESS_KEY || process.env.PROVIDER_EGRESS_KEY || CLEARANCE_EGRESS_KEY
  });
}

function isChallengeHtml(body) {
  return isChallengeBody(body);
}

function cookieHeaderForUrl(url) {
  return _pool.cookieHeaderForUrl(url);
}

function getBundle(url) {
  return _pool.get(hostOf(url));
}

function invalidate(url) {
  _pool.invalidate(hostOf(url));
}

function stats() {
  return _pool.stats();
}

try {
  process.stderr.write(
    `[cf_native_solver] online disk=${DISK_PATH || 'off'} ttl=${CLEARANCE_TTL_MS}ms `
    + `hosts_cached=${stats().hosts}\n`
  );
} catch (_) {}

module.exports = {
  tryNativeBypass,
  tryCachedBypass,
  tryNativeIuamBypass,
  rememberClearance,
  isChallengeHtml,
  cookieHeaderForUrl,
  getBundle,
  invalidate,
  stats,
  _ClearancePool: ClearancePool,
  _HostMemory: HostMemory,
};
