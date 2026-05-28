'use strict';

/**
 * providers/utils/cf_native_solver.js
 *
 * Native (pure-Node) Cloudflare challenge layer for Leviathan.
 *
 * WHY
 * ---
 * `cloudflare_bypass.js` already orchestrates Scrapling + curl_cffi via
 * spawned Python children. Each spawn costs ~150-500ms cold and goes through
 * a queue. For sites where we have a fresh cf_clearance cookie cached, we
 * shouldn't spawn anything at all - we should just send the cookie directly.
 * For the simpler IUAM ("Just a moment...") math challenge we can solve it
 * in-process via Node's built-in `vm` module without external help.
 *
 * This module provides three primitives that cloudflare_bypass.js layers on
 * top of its existing chain:
 *
 *   1. ClearancePool - in-memory + disk-persisted store of CF clearance
 *      cookies + UA, keyed by host. 25-minute TTL. Hits avoid all bypass
 *      work entirely.
 *
 *   2. solveIuamChallenge(html, url, opts) - if the response is the legacy
 *      "I'm Under Attack Mode" challenge, parse + eval the math via vm and
 *      submit the answer. Returns a cookie jar on success. Modern Turnstile
 *      challenges are detected and refused (caller falls back to Scrapling).
 *
 *   3. HostMemory - per-host LRU of which strategy worked last and which
 *      ones have failed N times in cooldown, so we skip dead ends.
 *
 * PUBLIC API
 *   const cf = require('./cf_native_solver');
 *   const bundle = await cf.acquireClearance(url, { hintCookies });
 *   // bundle: { cookies: {...}, userAgent, strategy, expiresAt }
 *
 *   const cookieHeader = cf.cookieHeaderForUrl(url);
 *
 *   const native = await cf.tryNativeBypass(url, { providerName });
 *   // returns null when not handled, otherwise { html, url, status, cookies }
 *
 * ENV
 *   CF_NATIVE_DISK_PATH   default ~/.leviathan/cf_clearance.json (or /tmp)
 *   CF_NATIVE_TTL_MS      default 1500000 (25 min)
 *   CF_NATIVE_DISABLE_DISK  '1' to skip disk persistence
 *   CF_NATIVE_IUAM_TIMEOUT_MS  default 12000
 *
 * NOTE: this file is intentionally dependency-free (only built-in Node
 * modules) so it can ship from day one without touching package.json.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const { URL } = require('url');

// ---------------------------------------------------------------------------
// Config

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

const DEFAULT_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

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
  return CF_CHALLENGE_MARKERS.some((r) => r.test(body));
}

function isIuamChallengeBody(body) {
  if (!body) return false;
  // IUAM has the jschl_vc form; Turnstile has the cf-turnstile-response div.
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

// ---------------------------------------------------------------------------
// Disk persistence (best-effort, never blocks)

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
      // Log to stderr so it shows up in `docker logs` but don't crash.
      try {
        process.stderr.write(`[cf_native_solver] disk flush failed: ${err && err.message}\n`);
      } catch (_) { /* ignore */ }
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

// ---------------------------------------------------------------------------
// ClearancePool

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

  put(host, bundle) {
    if (!host || !bundle) return;
    const expiresAt = Date.now() + CLEARANCE_TTL_MS;
    this._byHost[host] = {
      cookies: bundle.cookies || {},
      userAgent: bundle.userAgent || DEFAULT_UA,
      strategy: bundle.strategy || 'unknown',
      acquiredAt: Date.now(),
      expiresAt,
      finalUrl: bundle.finalUrl || null,
    };
    // LRU-style eviction by oldest acquiredAt
    const hosts = Object.keys(this._byHost);
    if (hosts.length > MAX_HOSTS) {
      hosts
        .map((h) => [h, this._byHost[h].acquiredAt || 0])
        .sort((a, b) => a[1] - b[1])
        .slice(0, hosts.length - MAX_HOSTS)
        .forEach(([h]) => { delete this._byHost[h]; });
    }
    flushToDiskSoon(this._byHost);
  }

  invalidate(host) {
    if (!host) return;
    if (host in this._byHost) {
      delete this._byHost[host];
      flushToDiskSoon(this._byHost);
    }
  }

  cookieHeaderForUrl(url) {
    const host = hostOf(url);
    const bundle = this.get(host);
    if (!bundle || !bundle.cookies) return '';
    return Object.entries(bundle.cookies)
      .filter(([k, v]) => k && v != null)
      .map(([k, v]) => `${k}=${v}`)
      .join('; ');
  }

  stats() {
    return {
      hosts: Object.keys(this._byHost).length,
      diskPath: DISK_PATH,
      ttlMs: CLEARANCE_TTL_MS,
    };
  }
}

const _pool = new ClearancePool();

// ---------------------------------------------------------------------------
// HostMemory

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

// ---------------------------------------------------------------------------
// HTTP helpers (native, no axios required for this layer)

async function httpRequest(targetUrl, {
  method = 'GET',
  headers = {},
  cookieHeader = '',
  body = null,
  timeoutMs = IUAM_TIMEOUT_MS,
  followRedirects = true,
  maxRedirects = 5,
} = {}) {
  // Use the global fetch if available (Node 18+), fall back to https.request.
  if (typeof fetch === 'function') {
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    const timeoutId = controller
      ? setTimeout(() => controller.abort(), timeoutMs)
      : null;
    try {
      const finalHeaders = { ...headers };
      if (cookieHeader) finalHeaders.Cookie = cookieHeader;
      const res = await fetch(targetUrl, {
        method,
        headers: finalHeaders,
        body: body || undefined,
        redirect: followRedirects ? 'follow' : 'manual',
        signal: controller ? controller.signal : undefined,
      });
      const text = await res.text();
      const respHeaders = {};
      const setCookies = [];
      res.headers.forEach((value, key) => {
        respHeaders[key.toLowerCase()] = value;
        if (key.toLowerCase() === 'set-cookie') setCookies.push(value);
      });
      // fetch concatenates multiple Set-Cookie into one - try to split.
      const rawSetCookie = respHeaders['set-cookie'] || '';
      const splitCookies = rawSetCookie ? rawSetCookie.split(/,(?=\s*[^;,\s]+=)/g) : setCookies;
      return {
        status: res.status,
        url: res.url,
        headers: respHeaders,
        body: text,
        setCookies: splitCookies,
      };
    } finally {
      if (timeoutId) clearTimeout(timeoutId);
    }
  }
  throw new Error('cf_native_solver: fetch() non disponibile (richiede Node 18+)');
}

function parseSetCookieValue(rawCookie) {
  // Extract just the name=value part (drop attributes).
  if (!rawCookie) return null;
  const first = rawCookie.split(';')[0].trim();
  const eq = first.indexOf('=');
  if (eq <= 0) return null;
  return [first.slice(0, eq).trim(), first.slice(eq + 1).trim()];
}

function mergeSetCookies(jar, setCookies) {
  if (!Array.isArray(setCookies)) return jar;
  for (const raw of setCookies) {
    const parsed = parseSetCookieValue(raw);
    if (parsed) jar[parsed[0]] = parsed[1];
  }
  return jar;
}

// ---------------------------------------------------------------------------
// IUAM solver (legacy "Just a moment..." challenge)

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
  // jschl_vc
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
  // Cloudflare ships the IUAM math inside a setTimeout(function(){ ... }, 4000)
  // block. We can capture a slice of the script that contains the math
  // assignments and run it in a tightly sandboxed vm to compute the answer.
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

  // Sandboxed vm: no require, no process, only a fake `t` (innerHTML of an
  // element CF reads from - the document hostname). We feed it the hostname.
  const hostname = (() => { try { return new URL(url).hostname; } catch (_) { return ''; } })();

  let answer;
  try {
    const sandbox = {
      // Cloudflare reads `t` as the innerHTML of the `a` tag with the hostname.
      // We expose just enough scaffolding for the script to run without window.
      t: { innerHTML: hostname },
      a: { value: 0 },
      // The script only uses arithmetic; no fetch/timer needed.
    };
    const context = vm.createContext(sandbox, { codeGeneration: { strings: false, wasm: false } });
    // Wrap the snippet in code that captures the final value through a
    // synthetic `a.value = <expr>;` continuation. The original script ends
    // with `a.value = parseInt(<varname>.<key>, 10) + t.length;`. We
    // re-emit that tail by parsing the variable name.
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

  // CF expects ~4s of think-time before answering. Configurable via env.
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

  const jar = {};
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

// ---------------------------------------------------------------------------
// Cached pass-through bypass

/**
 * If we have a fresh clearance bundle for this URL's host, try to fetch
 * directly using it. Returns null when nothing in cache or when the
 * cached cookies didn't work (forces caller to fall back to the heavier
 * Scrapling/curl_cffi chain).
 */
async function tryCachedBypass(url, options = {}) {
  const host = hostOf(url);
  const bundle = _pool.get(host);
  if (!bundle) return null;

  const cookieHeader = Object.entries(bundle.cookies || {})
    .map(([k, v]) => `${k}=${v}`)
    .join('; ');
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
    // Cached cookies no longer work - drop the bundle so the next try refreshes.
    _pool.invalidate(host);
    _memory.noteFailure(host, 'native:cached');
    return null;
  } catch (_) {
    _memory.noteFailure(host, 'native:cached');
    return null;
  }
}

/**
 * Try to solve the challenge in-process via the native IUAM solver.
 * Returns null if the page doesn't look like a solvable IUAM challenge
 * (e.g. Turnstile). On success, updates the ClearancePool.
 */
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
    _pool.put(host, {
      cookies: result.cookies || {},
      userAgent: options.userAgent || DEFAULT_UA,
      strategy: 'native:iuam',
      finalUrl: result.finalUrl,
    });
    _memory.noteSuccess(host, 'native:iuam');
    return {
      html: result.body,
      url: result.finalUrl,
      status: result.status,
      cookies: result.cookies,
      userAgent: options.userAgent || DEFAULT_UA,
      strategy: 'native:iuam',
    };
  } catch (err) {
    _memory.noteFailure(host, 'native:iuam');
    return null;
  }
}

/**
 * High-level: combine cached bypass + (optionally) a fresh fetch + IUAM solver.
 * Returns the same shape as the Scrapling/curl_cffi result so the existing
 * cloudflare_bypass.js chain can drop us in.
 */
async function tryNativeBypass(url, options = {}) {
  // 1) Cached clearance
  const cached = await tryCachedBypass(url, options);
  if (cached) return cached;

  // 2) Fresh fetch + IUAM solve (only useful if the server sent us an IUAM
  // page; otherwise let the Python helpers take over)
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

  // Lucky pass - no challenge at all.
  if (firstResponse.status >= 200 && firstResponse.status < 400 && !isChallengeBody(firstResponse.body)) {
    return {
      html: firstResponse.body,
      url: firstResponse.url,
      status: firstResponse.status,
      cookies: mergeSetCookies({}, firstResponse.setCookies),
      userAgent: options.userAgent || DEFAULT_UA,
      strategy: 'native:direct',
    };
  }

  // Turnstile -> only the Python helpers can solve it (real browser).
  if (isTurnstileBody(firstResponse.body)) return null;

  // IUAM math challenge -> attempt in-process solve.
  if (isIuamChallengeBody(firstResponse.body)) {
    return tryNativeIuamBypass(url, firstResponse.body, options);
  }

  return null;
}

// ---------------------------------------------------------------------------
// Persist learned clearance from an external bypass (call this after a
// Scrapling/curl_cffi/FlareSolverr success so the next request hits cache).

function rememberClearance(url, { cookies, userAgent, strategy = 'external' } = {}) {
  const host = hostOf(url);
  if (!host || !cookies || typeof cookies !== 'object') return;
  const has = Object.keys(cookies).some((k) => /^cf_clearance|^__cf|^cf_chl/i.test(k));
  if (!has) return; // Only persist if we actually got the CF clearance cookie.
  _pool.put(host, { cookies, userAgent: userAgent || DEFAULT_UA, strategy });
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

// One-line stderr banner on first import so it's visible in docker logs.
try {
  process.stderr.write(
    `[cf_native_solver] online disk=${DISK_PATH || 'off'} ttl=${CLEARANCE_TTL_MS}ms `
    + `hosts_cached=${stats().hosts}\n`
  );
} catch (_) { /* ignore */ }

module.exports = {
  // High-level pipeline
  tryNativeBypass,
  tryCachedBypass,
  tryNativeIuamBypass,
  // Learning
  rememberClearance,
  // Inspectors
  isChallengeHtml,
  cookieHeaderForUrl,
  getBundle,
  invalidate,
  stats,
  // Internals exposed for tests
  _ClearancePool: ClearancePool,
  _HostMemory: HostMemory,
};
