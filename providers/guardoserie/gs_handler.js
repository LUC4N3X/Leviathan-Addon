'use strict';

const axios = require('axios');
const cheerio = require('cheerio');
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { GUARDO_SERIE_BROWSER_PROFILES, pickRandomProfile } = require('../../core/browser_profiles');
const {
  buildWebStream,
  normalizeQuality,
  pickBetterQuality,
  probePlaylistQuality,
  qualityRank
} = require('../extractors/common');
const {
  extractFromUrl,
  HOSTER_DIRECT_LINK_PATTERN,
  HOSTER_ESCAPED_DIRECT_LINK_PATTERN
} = require('../extractors/registry');

const INITIAL_GS_DOMAIN  = 'https://guardoserie.garden';
const TMDB_KEY           = '5bae8d11f2a7bc7a95c6d040a31d2163';
const BROWSER_PROFILES   = GUARDO_SERIE_BROWSER_PROFILES;
const FLARESOLVERR_URL   = process.env.FLARESOLVERR_URL || 'http://127.0.0.1:8191/v1';
const PROVIDER_NAME      = 'guardoserie';
const SESSION_FILE       = path.join(process.cwd(), `cf-session-${PROVIDER_NAME}.json`);
const DEBUG              = process.env.GS_DEBUG === '1';

const GS_DOMAIN_FALLBACKS = [
  'https://guardoserie.garden',
  'https://guardoserie.quest',
  'https://guardaserie.garden',
];

const TTL_SEARCH     = 1000 * 60 * 30;
const TTL_EPISODE    = 1000 * 60 * 30;
const TTL_SERIES     = 1000 * 60 * 60 * 6;
const CF_SESSION_TTL = 1000 * 60 * 60 * 6;

const TIMEOUT_TMDB        = 8000;
const TIMEOUT_SEARCH      = 12000;
const TIMEOUT_SERIES_PAGE = 12000;
const TIMEOUT_EPISODE_PAGE = 12000;
const TIMEOUT_EXTRACTION  = 18000;
const GLOBAL_TIMEOUT_MS   = 30000; 

const DIRECT_FETCH_TIMEOUT  = 14000;
const CF_BYPASS_TIMEOUT     = 100000;
const MAX_PLAYER_LINKS      = 10;
const ASYNC_POOL_CONCURRENCY = 4;
const CANDIDATE_SCAN_CONCURRENCY = 3;
const MAX_SERIES_CANDIDATES = 8;
const CACHE_MAX_SIZE        = 500;
const SAVE_SESSION_DEBOUNCE = 3000;

const agentOptions = {
  keepAlive:      true,
  maxSockets:     250,
  maxFreeSockets: 100,
  timeout:        30000,
  keepAliveMsecs: 30000
};
const httpsAgent = new https.Agent(agentOptions);
const httpAgent  = new http.Agent(agentOptions);

const lightClient = axios.create({ timeout: 10000, httpsAgent, httpAgent });

let currentGsDomain  = INITIAL_GS_DOMAIN;
let domainFailCount  = 0;

const requestCache    = new Map();
const pendingRequests = new Map();
const activeBypasses  = new Map();

setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of requestCache) {
    if (now > (entry.stale || entry.expires)) requestCache.delete(key);
  }
}, 5 * 60 * 1000).unref();

function evictCacheIfNeeded() {
  if (requestCache.size <= CACHE_MAX_SIZE) return;
  const toDelete = requestCache.size - CACHE_MAX_SIZE;
  let i = 0;
  for (const key of requestCache.keys()) {
    if (i++ >= toDelete) break;
    requestCache.delete(key);
  }
}

function normalizeStreamUrl(url) {
  try {
    const u = new URL(url);

    ['_', 't', 'ts', 'cb', 'nocache'].forEach(k => {
      u.searchParams.delete(k);
    });

    u.hash = '';

    return u.origin + u.pathname + (u.searchParams.toString() ? `?${u.searchParams}` : '');
  } catch (_) {
    return String(url || '');
  }
}

function getTargetDomain() { return currentGsDomain; }

function rotateDomain() {
  domainFailCount++;
  currentGsDomain = GS_DOMAIN_FALLBACKS[domainFailCount % GS_DOMAIN_FALLBACKS.length];
  if (DEBUG) console.log(`[GS] Domain rotated to ${currentGsDomain}`);
}

let _saveTimer   = null;
let _pendingSave = null;

function saveSession(sessionData) {
  _pendingSave = sessionData;
  if (_saveTimer) return;
  _saveTimer = setTimeout(() => {
    _saveTimer = null;
    const data = _pendingSave;
    _pendingSave = null;
    if (!data) return;
    const tmp = SESSION_FILE + '.tmp';
    try {
      fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
      fs.renameSync(tmp, SESSION_FILE);
    } catch (e) {
      if (DEBUG) console.warn('[GS] saveSession error:', e.message);
      try { fs.unlinkSync(tmp); } catch (_) {}
    }
  }, SAVE_SESSION_DEBOUNCE);
}

function invalidateSession() {
  activeSession = {};

  if (_saveTimer) {
    clearTimeout(_saveTimer);
    _saveTimer = null;
  }

  _pendingSave = null;

  try {
    if (fs.existsSync(SESSION_FILE)) fs.unlinkSync(SESSION_FILE);
  } catch (e) {
    if (DEBUG) console.warn('[GS] invalidateSession unlink error:', e.message);
  }
}

function loadSession() {
  if (!fs.existsSync(SESSION_FILE)) return {};
  try {
    const data = JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8'));
    if (!data?.userAgent) return {};
    if (data.url) {
      try {
        const u = new URL(data.url);
        currentGsDomain = `${u.protocol}//${u.host}`;
      } catch (_) {}
    }
    if (data.timestamp && Date.now() - data.timestamp > CF_SESSION_TTL) {
      if (DEBUG) console.log('[GS] Loaded session expired — discarding');
      try { fs.unlinkSync(SESSION_FILE); } catch (_) {}
      return {};
    }
    return data;
  } catch (_) {
    return {};
  }
}

let activeSession = loadSession();

function updateCookies(existing, setCookieHeader) {
  if (!setCookieHeader) return existing;
  const arr      = Array.isArray(setCookieHeader) ? setCookieHeader : [setCookieHeader];
  const cookieMap = new Map();
  if (existing) {
    existing.split(';').forEach(c => {
      const eq = c.indexOf('=');
      if (eq > 0) cookieMap.set(c.slice(0, eq).trim(), c.slice(eq + 1).trim());
    });
  }
  arr.forEach(c => {
    const primary = c.split(';')[0];
    const eq      = primary.indexOf('=');
    if (eq > 0) cookieMap.set(primary.slice(0, eq).trim(), primary.slice(eq + 1).trim());
  });
  return Array.from(cookieMap.entries()).map(([k, v]) => `${k}=${v}`).join('; ');
}

const CF_CHALLENGE_PATTERNS = [
  /just a moment/i,
  /checking your browser/i,
  /enable javascript and cookies/i,
  /<div id=["']cf-wrapper["']/i,
  /cf-chl-widget/i,
  /__cf_chl_opt/i,
  /cf\.challenge\.orchestrate/i,
  /turnstile/i,
  /challenge-platform/i,
];

function looksLikeChallenge(html) {
  if (!html) return false;
  return CF_CHALLENGE_PATTERNS.some(re => re.test(String(html)));
}

function looksLikeBlock(status, html, isPageRequest) {
  if (status === 403 || status === 503) return true;
  if (looksLikeChallenge(html)) return true;
  if (isPageRequest && html && String(html).trim().length < 500) return true;
  return false;
}

async function getClearance(url, provider, options) {
  provider = provider || PROVIDER_NAME;
  options  = options  || {};

  if (activeBypasses.has(provider)) return activeBypasses.get(provider);

  const bypassPromise = (async () => {
    let lastErr;
    for (let attempt = 0; attempt <= 2; attempt++) {
      if (attempt > 0) await new Promise(r => setTimeout(r, 1500 * (2 ** (attempt - 1))));
      try {
        const payload = {
          cmd:        options.method === 'POST' ? 'request.post' : 'request.get',
          url,
          maxTimeout: CF_BYPASS_TIMEOUT,
          session:    `session_${provider}`
        };
        if (options.method === 'POST' && options.body) payload.postData = options.body;

        const res = await axios.post(FLARESOLVERR_URL, payload, {
          timeout: CF_BYPASS_TIMEOUT + 10000,
          headers: { 'Content-Type': 'application/json' }
        });

        if (res.data?.status === 'ok') {
          const sol   = res.data.solution;
          const cookies = sol.cookies.map(c => `${c.name}=${c.value}`).join('; ');
          const data  = {
            userAgent:  sol.userAgent,
            cookies,
            cf_clearance: sol.cookies.find(c => c.name === 'cf_clearance')?.value || null,
            url:        sol.url,
            response:   sol.response,
            timestamp:  Date.now()
          };
          activeSession = data;
          saveSession(data);
          if (sol.url) {
            try {
              const u = new URL(sol.url);
              currentGsDomain = `${u.protocol}//${u.host}`;
              domainFailCount  = 0;
            } catch (_) {}
          }
          if (DEBUG) console.log('[GS] Bypass OK, cf_clearance:', !!data.cf_clearance);
          return data;
        }
        lastErr = new Error(res.data?.message || 'FlareSolverr: invalid response');
      } catch (e) {
        lastErr = e;
      }
      if (DEBUG) console.warn(`[GS] Bypass attempt ${attempt} failed:`, lastErr?.message);
    }
    if (DEBUG) console.error('[GS] All bypass attempts exhausted');
    return null;
  })();

  bypassPromise.finally(() => activeBypasses.delete(provider));
  activeBypasses.set(provider, bypassPromise);
  return bypassPromise;
}

function buildDirectHeaders() {
  const ua = activeSession?.userAgent || pickRandomProfile(BROWSER_PROFILES).ua;
  const h  = {
    'User-Agent':                ua,
    'Accept':                    'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    'Accept-Language':           'it-IT,it;q=0.9,en-US;q=0.8,en;q=0.7',
    'Accept-Encoding':           'gzip, deflate, br',
    'DNT':                       '1',
    'Sec-Fetch-Dest':            'document',
    'Sec-Fetch-Mode':            'navigate',
    'Sec-Fetch-Site':            'same-origin',
    'Sec-Fetch-User':            '?1',
    'Upgrade-Insecure-Requests': '1',
    'Referer':                   getTargetDomain() + '/',
    'Origin':                    getTargetDomain(),
  };
  if (activeSession?.cookies) h['Cookie'] = activeSession.cookies;
  return h;
}

async function executeSmartFetch(url, isPost, body, isPageRequest) {
  const hasSession = !!(
    activeSession?.cookies &&
    activeSession?.userAgent &&
    activeSession?.timestamp &&
    Date.now() - activeSession.timestamp < CF_SESSION_TTL
  );

  if (hasSession) {
    try {
      const headers = buildDirectHeaders();
      if (isPost && body) headers['Content-Type'] = 'application/x-www-form-urlencoded';

      const res  = await axios({
        method: isPost ? 'POST' : 'GET',
        url,
        headers,
        data:           (isPost && body) ? body : undefined,
        timeout:        DIRECT_FETCH_TIMEOUT,
        httpAgent,
        httpsAgent,
        maxRedirects:   5,
        validateStatus: () => true,
        decompress:     true
      });
      const html = typeof res.data === 'string' ? res.data : JSON.stringify(res.data || {});

      if (!looksLikeBlock(res.status, html, isPageRequest)) {
        if (res.headers?.['set-cookie']) {
          activeSession.cookies   = updateCookies(activeSession.cookies, res.headers['set-cookie']);
          activeSession.timestamp = Date.now();
          saveSession(activeSession);
        }
        return html;
      }

      if (DEBUG) console.log(`[GS] Direct blocked (${res.status}) — escalating to FlareSolverr`);
      invalidateSession();
    } catch (e) {
      if (DEBUG) console.warn('[GS] Direct fetch error:', e.message);
    }
  }

  const session = await getClearance(url, PROVIDER_NAME, { method: isPost ? 'POST' : 'GET', body });
  if (!session?.response) {
    rotateDomain();
    const retryUrl     = url.replace(/^https?:\/\/[^/]+/, getTargetDomain());
    const retrySession = await getClearance(retryUrl, PROVIDER_NAME, { method: isPost ? 'POST' : 'GET', body });
    return retrySession?.response || null;
  }
  return session.response;
}

async function _fetchFresh(url, isPost, body, ttl, isPageRequest, cacheKey) {

  const html = await executeSmartFetch(url, isPost, body, isPageRequest);
  if (html) {
    evictCacheIfNeeded();
    requestCache.set(cacheKey, {
      data:    html,
      expires: Date.now() + ttl,
      stale:   Date.now() + ttl * 2
    });
  }
  return html;
}

async function smartFetch(url, {
  isPost = false,
  body = null,
  ttl = TTL_SEARCH,
  isPageRequest = true
} = {}) {
  const cacheKey = `${isPost ? 'POST' : 'GET'}:${url}:${body || ''}`;

  const cached = requestCache.get(cacheKey);
  if (cached) {
    if (Date.now() < cached.expires) return cached.data;

    if (cached.stale && Date.now() < cached.stale && !pendingRequests.has(cacheKey)) {

      const revalPromise = _fetchFresh(url, isPost, body, ttl, isPageRequest, cacheKey)
        .finally(() => pendingRequests.delete(cacheKey));
      pendingRequests.set(cacheKey, revalPromise);
      return cached.data;
    }

    requestCache.delete(cacheKey);
  }

  if (pendingRequests.has(cacheKey)) return pendingRequests.get(cacheKey);

  const promise = _fetchFresh(url, isPost, body, ttl, isPageRequest, cacheKey)
    .finally(() => pendingRequests.delete(cacheKey));
  pendingRequests.set(cacheKey, promise);
  return promise;
}


function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, rej) => setTimeout(() => rej(new Error(`GS timeout: ${label}`)), ms))
  ]);
}


const IT_STOPWORDS = /\b(the|a|an|un|una|il|lo|la|gli|le|di|de|del|della|degli|delle|dei|alle|nei|nelle|negli|serie|stagione|season|episodio|episode)\b/g;

function normalizeText(val) {
  return String(val || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/&amp;/g, '&')
    .replace(/[''`]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(IT_STOPWORDS, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function slugify(val) {
  return String(val || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function normalizeTitleScore(candidate, title, originalTitle) {
  const cand      = normalizeText(candidate);
  const primary   = normalizeText(title);
  const secondary = normalizeText(originalTitle);
  if (!cand || !primary) return 0;
  if (cand === primary || (secondary && cand === secondary)) return 3;
  if (
    primary.includes(cand) || cand.includes(primary) ||
    (secondary && (secondary.includes(cand) || cand.includes(secondary)))
  ) return 2;
  const candTokens  = new Set(cand.split(' ').filter(t => t.length > 1));
  const titleTokens = Array.from(new Set(`${primary} ${secondary}`.trim().split(' ').filter(t => t.length > 1)));
  if (!titleTokens.length) return 0;
  let hits = 0;
  for (const t of titleTokens) if (candTokens.has(t)) hits++;
  const ratio = hits / titleTokens.length;
  return ratio >= 0.75 ? 2 : ratio >= 0.45 ? 1 : 0;
}

function extractSearchResultsFromHtml(html, baseUrl) {
  if (!html) return [];
  const $       = cheerio.load(String(html));
  const results = [];
  const seen    = new Set();
  $('a[href]').each((_, el) => {
    const href = $(el).attr('href');
    if (!href || !/(\/serie\/|\/episodio\/)/i.test(href)) return;
    try {
      const abs = new URL(href, baseUrl).toString();
      if (!seen.has(abs)) {
        seen.add(abs);
        results.push({
          url:   abs,
          title: String($(el).attr('title') || $(el).attr('oldtitle') || $(el).text() || '').trim() || abs
        });
      }
    } catch (_) {}
  });
  return results;
}

function dedupeSearchResults(results = []) {
  const seen = new Set();
  const deduped = [];

  for (const result of results) {
    const url = String(result?.url || '').trim();
    if (!url || seen.has(url)) continue;
    seen.add(url);
    deduped.push(result);
  }

  return deduped;
}

function extractYearFromSeriesHtml($, rawHtml) {
  const candidates = [
    $('[class*="release"], [class*="year"], [class*="anno"], .jt-info').text(),
    $('meta[property="og:description"], meta[name="description"]').attr('content') || '',
    $('[href*="release-year/"]').first().attr('href') || '',
  ];
  for (const text of candidates) {
    const m = text.match(/\b(19\d{2}|20[012]\d)\b/);
    if (m) return m[1];
  }
  const urlMatch = rawHtml.match(/release-year\/(\d{4})/i);
  if (urlMatch) return urlMatch[1];
  // Last resort: only from content-level elements, not the whole page
  const bodyMatch = rawHtml.match(/<(?:p|span|div)[^>]*>\s*(19\d{2}|20[012]\d)\s*<\//i);
  return bodyMatch?.[1] || null;
}

function extractEpisodeUrlFromSeriesPage(pageHtml, season, episode) {
  if (!pageHtml) return null;
  const sIdx = parseInt(season,  10) - 1;
  const eIdx = parseInt(episode, 10) - 1;
  if (sIdx < 0 || eIdx < 0) return null;
  const $ = cheerio.load(String(pageHtml));

  const seasonBlocks = $('.les-content, [class*="season-"], [class*="stagione-"], .tvseason');
  if (seasonBlocks.length > sIdx) {
    const block    = seasonBlocks.eq(sIdx);
    const episodes = block.find('a[href*="/episodio/"]');
    if (episodes.length > eIdx) {
      const href = episodes.eq(eIdx).attr('href');
      if (href) return href;
    }
  }

  const seasonLinks = $('a[href*="/episodio/"]').toArray().filter(el =>
    new RegExp(`stagione-${season}-episodio-`, 'i').test($(el).attr('href') || '')
  );
  if (seasonLinks.length > eIdx) return $(seasonLinks[eIdx]).attr('href') || null;

  const explicit = new RegExp(
    `https?:\\/\\/[^"'\\s]+\\/episodio\\/[^"'\\s]*stagione-${season}-episodio-${episode}[^"'\\s]*`,
    'i'
  );
  return pageHtml.match(explicit)?.[0] || null;
}

function extractPlayerLinksFromHtml(html) {
  const raw     = String(html || '');
  const links   = new Set();
  const baseUrl = getTargetDomain();

  const normalize = (link) => {
    let n = String(link).trim().replace(/&amp;/g, '&').replace(/\\\//g, '/');
    if (!n || n.startsWith('data:')) return null;
    if (n.startsWith('//'))          return `https:${n}`;
    if (n.startsWith('/'))           return `${baseUrl}${n}`;
    if (!/^https?:\/\//i.test(n) && /(loadm|mixdrop|m1xdrop|mxcontent|supervideo|dood|vixcloud)/i.test(n)) {
      return `https://${n.replace(/^\/+/, '')}`;
    }
    return /^https?:\/\//i.test(n) ? n : null;
  };

  for (const tag of (raw.match(/<iframe\b[^>]*>/ig) || [])) {
    const re = /\b(?:data-src|src)\s*=\s*(['"])(.*?)\1/ig;
    let m;
    while ((m = re.exec(tag)) !== null) {
      const c = normalize(m[2]);
      if (c) links.add(c);
    }
  }

  for (const regex of [
    new RegExp(HOSTER_DIRECT_LINK_PATTERN,         'ig'),
    new RegExp(HOSTER_ESCAPED_DIRECT_LINK_PATTERN, 'ig')
  ]) {
    for (const m of (raw.match(regex) || [])) {
      const c = normalize(m);
      if (c) links.add(c);
    }
  }

  for (const lm of (raw.match(/loadm\.cam\/#[a-z0-9]+/ig) || [])) {
    const c = normalize(lm);
    if (c) links.add(c);
  }

  return Array.from(links);
}

function detectStrictQualityHint(value) {
  const text = String(value || '');
  if (!text) return 'Unknown';

  const patterns = [
    { quality: '4K', regex: /(?:^|[^0-9a-z])(4k|2160p|2160|uhd)(?=$|[^0-9a-z])/i },
    { quality: '1440p', regex: /(?:^|[^0-9a-z])(1440p|1440|2k|qhd)(?=$|[^0-9a-z])/i },
    { quality: '1080p', regex: /(?:^|[^0-9a-z])(1080p|1080|fhd|fullhd)(?=$|[^0-9a-z])/i },
    { quality: '720p', regex: /(?:^|[^0-9a-z])(720p|720)(?=$|[^0-9a-z])/i },
    { quality: '576p', regex: /(?:^|[^0-9a-z])(576p|576)(?=$|[^0-9a-z])/i },
    { quality: '480p', regex: /(?:^|[^0-9a-z])(480p|480)(?=$|[^0-9a-z])/i }
  ];

  for (const pattern of patterns) {
    if (pattern.regex.test(text)) return pattern.quality;
  }

  return 'Unknown';
}

function inferContextualQuality(...values) {
  let best = 'Unknown';
  for (const value of values) {
    best = pickBetterQuality(best, detectStrictQualityHint(value));
  }
  return best;
}

async function searchProviderSequential(query) {
  const baseUrl = getTargetDomain();

  const ajaxUrl  = `${baseUrl}/wp-admin/admin-ajax.php`;
  const ajaxBody = `s=${encodeURIComponent(query)}&action=searchwp_live_search&swpengine=default&swpquery=${encodeURIComponent(query)}`;
  const [ajaxSettled, wpSettled] = await Promise.allSettled([
    smartFetch(ajaxUrl, { isPost: true, body: ajaxBody, ttl: TTL_SEARCH, isPageRequest: false }),
    smartFetch(`${baseUrl}/?s=${encodeURIComponent(query)}`, { ttl: TTL_SEARCH })
  ]);

  const ajaxRes = ajaxSettled.status === 'fulfilled'
    ? extractSearchResultsFromHtml(ajaxSettled.value, baseUrl)
    : [];
  const wpRes = wpSettled.status === 'fulfilled'
    ? extractSearchResultsFromHtml(wpSettled.value, baseUrl)
    : [];
  const mergedPrimary = dedupeSearchResults([...ajaxRes, ...wpRes]);
  if (mergedPrimary.length) return mergedPrimary;

  const serieHtml = await smartFetch(`${baseUrl}/serie/?s=${encodeURIComponent(query)}`, { ttl: TTL_SEARCH });
  return extractSearchResultsFromHtml(serieHtml, baseUrl);
}

async function asyncPool(limit, items, asyncFn) {
  if (!items.length) return [];
  const results = new Array(items.length);
  const queue   = items.map((item, i) => ({ item, i }));

  async function runNext() {
    if (!queue.length) return;
    const { item, i } = queue.shift();
    results[i] = await Promise.resolve().then(() => asyncFn(item)).catch(() => null);
    return runNext();
  }

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, runNext));
  return results;
}

async function inspectSeriesCandidate(result, showName, originalTitle, targetYear) {
  if (!/\/serie\//i.test(String(result?.url || ''))) return null;

  const titleScore = normalizeTitleScore(result?.title, showName, originalTitle);
  if (titleScore < 1) return null;

  let html;
  try {
    html = await withTimeout(smartFetch(result.url, { ttl: TTL_SERIES }), TIMEOUT_SERIES_PAGE, 'series_page');
  } catch (_) {
    return null;
  }
  if (!html) return null;

  const $ = cheerio.load(html);
  const foundYear = extractYearFromSeriesHtml($, html);
  const yearDelta = targetYear && foundYear
    ? Math.abs(Number(foundYear) - Number(targetYear))
    : null;
  const exactYear = Number.isFinite(yearDelta)
    ? yearDelta <= (titleScore >= 2 ? 10 : 1)
    : false;

  return {
    url: result.url,
    html,
    titleScore,
    foundYear,
    yearDelta,
    exactYear
  };
}

function selectBestSeriesTarget(candidates = []) {
  const valid = Array.isArray(candidates) ? candidates.filter(Boolean) : [];
  if (valid.length === 0) return null;

  const exactMatches = valid
    .filter((candidate) => candidate.exactYear)
    .sort((a, b) =>
      (b.titleScore - a.titleScore)
      || ((a.yearDelta ?? Number.POSITIVE_INFINITY) - (b.yearDelta ?? Number.POSITIVE_INFINITY))
    );
  if (exactMatches.length > 0) {
    return { url: exactMatches[0].url, html: exactMatches[0].html };
  }

  const bestLoose = [...valid].sort((a, b) => b.titleScore - a.titleScore)[0];
  return bestLoose ? { url: bestLoose.url, html: bestLoose.html } : null;
}

async function searchGuardaserie(meta, config) {
  if (!meta?.isSeries || !config?.filters?.enableGs) return [];
  const season  = parseInt(meta?.season,  10);
  const episode = parseInt(meta?.episode, 10);
  if (!season || season < 1 || !episode || episode < 1) return [];

  return Promise.race([
    _searchGuardaserie(meta, config, season, episode),
    new Promise((_, rej) =>
      setTimeout(() => rej(new Error('GS_GLOBAL_TIMEOUT')), GLOBAL_TIMEOUT_MS)
    )
  ]).catch(e => {
    if (DEBUG) console.warn('[GS] Top-level error:', e.message);
    return [];
  });
}

async function _searchGuardaserie(meta, config, season, episode) {
  const t0   = Date.now();
  const mark = (step, extra) => {
    if (DEBUG) console.log(`[GS] +${Date.now() - t0}ms ${step}`, extra || '');
  };

  let tmdbId = meta?.tmdb_id || meta?.tmdbId || null;

  if (!tmdbId && meta?.imdb_id) {
    try {
      const res = await withTimeout(
        lightClient.get(`https://api.themoviedb.org/3/find/${encodeURIComponent(meta.imdb_id)}?api_key=${TMDB_KEY}&external_source=imdb_id`),
        TIMEOUT_TMDB, 'tmdb/find'
      );
      tmdbId = res.data?.tv_results?.[0]?.id || null;
    } catch (_) {}
  }

  let showName = meta?.title || null, originalTitle = null, targetYear = null;

  if (tmdbId) {
    try {
      const [itRes, enRes] = await withTimeout(
        Promise.allSettled([
          lightClient.get(`https://api.themoviedb.org/3/tv/${tmdbId}?api_key=${TMDB_KEY}&language=it-IT`),
          lightClient.get(`https://api.themoviedb.org/3/tv/${tmdbId}?api_key=${TMDB_KEY}&language=en-US`)
        ]),
        TIMEOUT_TMDB, 'tmdb/tv'
      );
      const itData = itRes.status === 'fulfilled' ? itRes.value.data : {};
      const enData = enRes.status === 'fulfilled' ? enRes.value.data : {};
      showName      = itData.name || itData.title || enData.name || enData.title || showName;
      originalTitle = enData.original_name || enData.original_title || itData.original_name || itData.original_title || null;
      targetYear    = String(itData.first_air_date || enData.first_air_date || '').slice(0, 4) || null;
    } catch (_) {}
  }

  mark('tmdb_info', { tmdbId, showName, originalTitle, targetYear });
  if (!showName) return [];

  const queries = Array.from(new Set([showName, originalTitle].filter(Boolean)));
  let allResults = [];

  const settled = await withTimeout(
    Promise.allSettled(queries.map(q => searchProviderSequential(q))),
    TIMEOUT_SEARCH, 'search'
  ).catch(() => []);

  for (const r of settled) {
    if (r.status === 'fulfilled' && Array.isArray(r.value)) allResults.push(...r.value);
  }
  mark('search_completed', { results: allResults.length });

  allResults = dedupeSearchResults(allResults);
  allResults.sort((a, b) =>
    normalizeTitleScore(b.title, showName, originalTitle) -
    normalizeTitleScore(a.title, showName, originalTitle)
  );

  const scannedCandidates = await asyncPool(
    CANDIDATE_SCAN_CONCURRENCY,
    allResults.slice(0, MAX_SERIES_CANDIDATES),
    (result) => inspectSeriesCandidate(result, showName, originalTitle, targetYear)
  );

  let target = selectBestSeriesTarget(scannedCandidates);

  if (!target) {
    const slugs = Array.from(new Set([slugify(showName), slugify(originalTitle)].filter(Boolean)));
    outer: for (const slug of slugs) {
      for (const p of [`/serie/${slug}/`, `/${slug}/`, `/serietv/${slug}/`, `/serie/${slug}-streaming/`]) {
        const url = `${getTargetDomain()}${p}`;
        let html;
        try {
          html = await withTimeout(smartFetch(url, { ttl: TTL_SERIES }), TIMEOUT_SERIES_PAGE, 'slug_probe');
        } catch (_) { continue; }
        if (!html) continue;
        const pageTitle = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || '';
        if (normalizeTitleScore(pageTitle, showName, originalTitle) >= 2) {
          target = { url, html };
          break outer;
        }
      }
    }
  }

  mark('target_resolved', { found: !!target?.url, url: target?.url });
  if (!target?.url) return [];

  const episodeUrl = extractEpisodeUrlFromSeriesPage(target.html, season, episode);
  if (!episodeUrl) { mark('episode_not_found'); return []; }

  const absoluteEpUrl = new URL(episodeUrl, target.url).toString();

  let finalHtml;
  try {
    finalHtml = await withTimeout(
      smartFetch(absoluteEpUrl, { ttl: TTL_EPISODE }),
      TIMEOUT_EPISODE_PAGE, 'episode_page'
    );
  } catch (_) { return []; }
  if (!finalHtml) return [];
  mark('episode_fetched');

  const playerLinks = Array.from(new Set(extractPlayerLinksFromHtml(finalHtml))).slice(0, MAX_PLAYER_LINKS);
  mark('players_extracted', { count: playerLinks.length });
  if (!playerLinks.length) return [];

  const cleanTitle = `${showName} S${String(season).padStart(2, '0')}E${String(episode).padStart(2, '0')}`;
  const userAgent = activeSession?.userAgent || pickRandomProfile(BROWSER_PROFILES).ua;

  let processedResults;
  try {
    processedResults = await withTimeout(
      asyncPool(ASYNC_POOL_CONCURRENCY, playerLinks, async (link) => {
        try {
          const extracted = await extractFromUrl(link, {
            client:         lightClient,
            userAgent,
            requestReferer: absoluteEpUrl
          });
          if (!extracted?.url) return null;

          const contextualQuality = inferContextualQuality(
            extracted?.quality,
            extracted?.url,
            extracted?.name,
            link,
            absoluteEpUrl
          );
          let quality = pickBetterQuality(
            contextualQuality,
            normalizeQuality(extracted?.quality || 'Unknown')
          );
          if (/\.m3u8($|\?)/i.test(String(extracted.url))) {
            try {
              const probed = await probePlaylistQuality(lightClient, extracted.url, {
                headers: extracted.headers || {},
                timeout: 5000
              });
              quality = pickBetterQuality(contextualQuality, pickBetterQuality(probed || 'Unknown', quality));
            } catch (_) {}
          }

          return buildWebStream({
            name:         `GuardoSerie | ${extracted.name}`,
            title:        `${cleanTitle}\n${extracted.name}  ITA`,
            url:          extracted.url,
            extractor:    extracted.name,
            provider:     'GuardoSerie',
            providerCode: 'GS',
            quality,
            headers:      extracted.headers,
            extra:        { _priority: extracted.priority ?? 9 }
          });
        } catch (_) {
          return null;
        }
      }),
      TIMEOUT_EXTRACTION, 'extraction'
    );
  } catch (_) {
    processedResults = [];
  }

  const validStreams = processedResults.filter(Boolean);
  mark('extraction_completed', { streams: validStreams.length });

  return validStreams
    .sort((a, b) => {
      const qDelta = qualityRank(b.quality) - qualityRank(a.quality);
      return qDelta !== 0 ? qDelta : ((a._priority ?? 9) - (b._priority ?? 9));
    })
    .filter((s, i, arr) => {
      const norm = normalizeStreamUrl(s.url);
      return arr.findIndex(x => normalizeStreamUrl(x.url) === norm) === i;
    })
    .map(s => { delete s._priority; return s; });
}

module.exports = {
  searchGuardaserie,
  searchGuardoSerie: searchGuardaserie,
  searchGuardoserie: searchGuardaserie,
};
