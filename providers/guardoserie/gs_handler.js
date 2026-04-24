'use strict';

const axios = require('axios');
const cheerio = require('cheerio');
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { GUARDA_SERIE_BROWSER_PROFILES, pickRandomProfile } = require('../../core/browser_profiles');
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
const BROWSER_PROFILES   = GUARDA_SERIE_BROWSER_PROFILES;
const FLARESOLVERR_URL   = process.env.FLARESOLVERR_URL || 'http://127.0.0.1:8191/v1';
const PROVIDER_NAME      = 'guardoserie';
const SESSION_FILE       = path.join(process.cwd(), `cf-session-${PROVIDER_NAME}.json`);
const DOMAIN_FILE        = path.join(process.cwd(), `${PROVIDER_NAME}-domain.json`);
const DOMAIN_REFRESH_TTL = 1000 * 60 * 20;
const DOMAIN_TIMEOUT_MS  = 8000;

const TTL_SEARCH      = 1000 * 60 * 30;
const TTL_EPISODE     = 1000 * 60 * 30;
const TTL_SERIES      = 1000 * 60 * 60 * 6;
const CF_SESSION_TTL  = 1000 * 60 * 60 * 6;
const GLOBAL_TIMEOUT_MS = 25000;
const SEARCH_QUERY_TIMEOUT_MS = 12000;
const MAX_CACHE_ITEMS = 500;

const agentOptions = {
  keepAlive: true,
  maxSockets: 250,
  maxFreeSockets: 100,
  timeout: 30000,
  keepAliveMsecs: 30000
};
const httpsAgent = new https.Agent(agentOptions);
const httpAgent  = new http.Agent(agentOptions);

const lightClient = axios.create({
  timeout: 10000,
  httpAgent,
  httpsAgent,
  validateStatus: status => status >= 200 && status < 500,
  headers: {
    'Accept-Language': 'it-IT,it;q=0.9,en-US;q=0.8,en;q=0.7'
  }
});

function normalizeBaseUrl(value) {
  try {
    const u = new URL(String(value || '').trim());
    return `${u.protocol}//${u.host}`;
  } catch (_) {
    return null;
  }
}

function loadStoredDomain() {
  try {
    if (!fs.existsSync(DOMAIN_FILE)) return null;

    const data = JSON.parse(fs.readFileSync(DOMAIN_FILE, 'utf8'));
    const base = normalizeBaseUrl(data?.baseUrl);

    if (!base) return null;

    return base;
  } catch (_) {
    return null;
  }
}

function saveStoredDomain(baseUrl) {
  const normalized = normalizeBaseUrl(baseUrl);
  if (!normalized) return;

  try {
    fs.writeFileSync(DOMAIN_FILE, JSON.stringify({
      baseUrl: normalized,
      updatedAt: Date.now()
    }, null, 2));
  } catch (_) {}
}

let currentGsDomain = loadStoredDomain() || INITIAL_GS_DOMAIN;
let lastDomainRefresh = 0;
let domainRefreshPromise = null;
let activeSession = {};

const requestCache   = new Map();
const pendingRequests = new Map();
const activeBypasses  = new Map();

setInterval(() => {
  const now = Date.now();
  for (const [key, val] of requestCache.entries()) {
    if (now > val.stale) requestCache.delete(key);
  }
}, 600000).unref();

function getTargetDomain() { return currentGsDomain; }

function getAxiosFinalUrl(res) {
  return (
    res?.request?.res?.responseUrl ||
    res?.request?._redirectable?._currentUrl ||
    res?.config?.url ||
    null
  );
}

function updateCurrentDomainFromUrl(url) {
  const nextBase = normalizeBaseUrl(url);
  if (!nextBase) return false;

  if (nextBase !== currentGsDomain) {
    currentGsDomain = nextBase;
    saveStoredDomain(nextBase);

    if (activeSession?.url) {
      activeSession.url = nextBase;
      activeSession.timestamp = Date.now();
      saveSession(activeSession);
    }

    return true;
  }

  return false;
}

async function resolveRedirectDomain(startBase, signal = null) {
  const base = normalizeBaseUrl(startBase);
  if (!base) return null;

  try {
    const res = await lightClient.get(base, {
      timeout: DOMAIN_TIMEOUT_MS,
      maxRedirects: 8,
      signal,
      validateStatus: status => status >= 200 && status < 500,
      headers: {
        'User-Agent': activeSession?.userAgent || pickRandomProfile(BROWSER_PROFILES).ua,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'it-IT,it;q=0.9,en-US;q=0.8,en;q=0.7',
        'Cache-Control': 'no-cache',
        'Pragma': 'no-cache'
      }
    });

    const finalUrl = getAxiosFinalUrl(res);
    const finalBase = normalizeBaseUrl(finalUrl);

    if (finalBase) return finalBase;

    return base;
  } catch (_) {
    return null;
  }
}

async function refreshTargetDomain(signal = null, { force = false } = {}) {
  const now = Date.now();

  if (!force && now - lastDomainRefresh < DOMAIN_REFRESH_TTL) {
    return currentGsDomain;
  }

  if (domainRefreshPromise) {
    return domainRefreshPromise;
  }

  domainRefreshPromise = (async () => {
    lastDomainRefresh = Date.now();

    const candidates = Array.from(new Set([
      currentGsDomain,
      loadStoredDomain(),
      INITIAL_GS_DOMAIN
    ].filter(Boolean)));

    for (const candidate of candidates) {
      const resolved = await resolveRedirectDomain(candidate, signal);

      if (resolved) {
        updateCurrentDomainFromUrl(resolved);
        return currentGsDomain;
      }
    }

    return currentGsDomain;
  })()
    .finally(() => {
      domainRefreshPromise = null;
    });

  return domainRefreshPromise;
}

function buildGsUrl(pathname) {
  const base = getTargetDomain();
  const cleanPath = String(pathname || '').startsWith('/')
    ? pathname
    : `/${pathname}`;

  return `${base}${cleanPath}`;
}

function isSessionFresh(session) {
  return !!(
    session &&
    session.cookies &&
    session.userAgent &&
    session.timestamp &&
    Date.now() - session.timestamp < CF_SESSION_TTL
  );
}

function loadSession() {
  if (!fs.existsSync(SESSION_FILE)) return {};
  try {
    const data = JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8'));
    if (data?.userAgent) {
      if (data.url) {
        updateCurrentDomainFromUrl(data.url);
      }
      return data;
    }
  } catch (_) {}
  return {};
}

function saveSession(sessionData) {
  try {
    fs.writeFileSync(SESSION_FILE, JSON.stringify(sessionData, null, 2));
  } catch (e) {}
}

activeSession = loadSession();

function clearSession() {
  activeSession = {};
  try { fs.unlinkSync(SESSION_FILE); } catch (_) {}
}

function updateCookies(existing, setCookieHeader) {
  if (!setCookieHeader) return existing;
  const cookiesArr = Array.isArray(setCookieHeader) ? setCookieHeader : [setCookieHeader];
  const cookieMap = new Map();

  if (existing) {
    existing.split(';').forEach(c => {
      const parts = c.split('=');
      if (parts.length >= 2) cookieMap.set(parts[0].trim(), parts.slice(1).join('=').trim());
    });
  }

  const ignoreKeys = new Set(['path', 'domain', 'expires', 'max-age', 'secure', 'httponly', 'samesite']);
  
  cookiesArr.forEach(c => {
    const primary = c.split(';')[0];
    const parts = primary.split('=');
    if (parts.length >= 2) {
      const key = parts[0].trim();
      if (!ignoreKeys.has(key.toLowerCase())) {
        cookieMap.set(key, parts.slice(1).join('=').trim());
      }
    }
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
];

function looksLikeChallenge(html) {
  if (!html) return false;
  const s = String(html);
  return CF_CHALLENGE_PATTERNS.some(re => re.test(s));
}

function isCanceledError(e) {
  return axios.isCancel(e) || e?.code === 'ERR_CANCELED';
}

async function getClearance(url, provider = PROVIDER_NAME, options = {}) {
  if (activeBypasses.has(provider)) {
    return activeBypasses.get(provider);
  }

  const bypassPromise = (async () => {
    const MAX_RETRIES = 2;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      if (attempt > 0) {
        await new Promise(r => setTimeout(r, 1500 * (2 ** (attempt - 1))));
      }

      try {
        const payload = {
          cmd: options.method === 'POST' ? 'request.post' : 'request.get',
          url,
          maxTimeout: 90000,
          session: `session_${provider}`
        };
        if (options.method === 'POST' && options.body) payload.postData = options.body;

        const response = await axios.post(FLARESOLVERR_URL, payload, {
          timeout: 100000,
          signal: options.signal,
          headers: { 'Content-Type': 'application/json' }
        });

        if (response.data?.status === 'ok') {
          const solution = response.data?.solution || {};
          const solutionCookies = Array.isArray(solution?.cookies) ? solution.cookies : [];
          const cookies = solutionCookies.map(c => `${c.name}=${c.value}`).join('; ');
          const cf_clearance = solutionCookies.find(c => c.name === 'cf_clearance')?.value || null;

          const data = {
            userAgent: solution.userAgent,
            cookies,
            cf_clearance,
            url: solution.url,
            response: solution.response,
            timestamp: Date.now()
          };

          activeSession = data;
          saveSession(data);

          if (solution.url) {
            updateCurrentDomainFromUrl(solution.url);
          }

          return data;
        }
      } catch (e) {
        if (isCanceledError(e)) throw e;
      }
    }

    activeBypasses.delete(provider);
    return null;
  })();

  bypassPromise.finally(() => activeBypasses.delete(provider)).catch(() => {});
  activeBypasses.set(provider, bypassPromise);
  return bypassPromise;
}

async function executeSmartFetch(url, isPost = false, body = null, signal = null) {
  if (isSessionFresh(activeSession)) {
    try {
      const reqOptions = {
        method: isPost ? 'POST' : 'GET',
        url,
        headers: {
          'User-Agent': activeSession.userAgent,
          'Cookie': activeSession.cookies,
          'Referer': getTargetDomain(),
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
          'Accept-Language': 'it-IT,it;q=0.9,en-US;q=0.8,en;q=0.7',
          'Sec-Fetch-Dest': 'document',
          'Sec-Fetch-Mode': 'navigate',
          'Sec-Fetch-Site': 'same-origin',
          'Upgrade-Insecure-Requests': '1'
        },
        timeout: 15000,
        httpAgent,
        httpsAgent,
        validateStatus: () => true,
        signal
      };
      
      if (isPost && body) {
        reqOptions.data = body;
        reqOptions.headers['Content-Type'] = 'application/x-www-form-urlencoded';
      }

      const res = await axios(reqOptions);
      updateCurrentDomainFromUrl(getAxiosFinalUrl(res));

      const html = typeof res.data === 'string' ? res.data : JSON.stringify(res.data || {});

      if (res.status === 403 || res.status === 503 || looksLikeChallenge(html)) {
        clearSession();
      } else {
        if (res.headers && res.headers['set-cookie']) {
          activeSession.cookies = updateCookies(activeSession.cookies, res.headers['set-cookie']);
          activeSession.timestamp = Date.now();
          saveSession(activeSession);
        }
        return html;
      }
    } catch (e) {
      if (isCanceledError(e)) throw e;
    }
  }

  const session = await getClearance(url, PROVIDER_NAME, { method: isPost ? 'POST' : 'GET', body, signal });
  return session?.response || null;
}

async function smartFetch(url, { isPost = false, body = null, ttl = TTL_SEARCH, signal = null } = {}) {
  const cacheKey = `${isPost ? 'POST' : 'GET'}:${url}:${body || ''}`;

  const cached = requestCache.get(cacheKey);
  if (cached) {
    const now = Date.now();
    requestCache.delete(cacheKey);
    requestCache.set(cacheKey, cached);

    if (now < cached.expires) return cached.data;
    if (cached.stale && now < cached.stale && !pendingRequests.has(cacheKey)) {
      setImmediate(() => {
        smartFetch(url, { isPost, body, ttl, signal }).catch(() => {});
      });
      return cached.data;
    }
    requestCache.delete(cacheKey);
  }

  if (pendingRequests.has(cacheKey)) return pendingRequests.get(cacheKey);

  const fetchPromise = executeSmartFetch(url, isPost, body, signal)
    .then(html => {
      if (html) {
        if (requestCache.size >= MAX_CACHE_ITEMS) {
          const oldestKey = requestCache.keys().next().value;
          if (oldestKey) requestCache.delete(oldestKey);
        }
        requestCache.set(cacheKey, {
          data: html,
          expires: Date.now() + ttl,
          stale: Date.now() + ttl * 2
        });
      }
      return html;
    })
    .finally(() => pendingRequests.delete(cacheKey));

  pendingRequests.set(cacheKey, fetchPromise);
  return fetchPromise;
}

const IT_STOPWORDS = /\b(the|a|an|un|una|il|lo|la|gli|le|di|de|del|della|degli|delle|dei|alle|nei|nelle|negli|serie|stagione|season|episodio|episode)\b/g;

function normalizeText(val) {
  return String(val || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/&amp;/g, '&')
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
  const cand = normalizeText(candidate);
  const primary = normalizeText(title);
  const secondary = normalizeText(originalTitle);
  if (!cand) return 0;
  if (cand === primary || (secondary && cand === secondary)) return 3;
  if (
    (primary && (cand.includes(primary) || primary.includes(cand))) ||
    (secondary && (cand.includes(secondary) || secondary.includes(cand)))
  ) return 2;

  const candTokens = new Set(cand.split(' ').filter(Boolean));
  const titleTokens = Array.from(new Set(`${primary} ${secondary}`.trim().split(' ').filter(Boolean)));
  if (!titleTokens.length) return 0;

  let hits = 0;
  for (const token of titleTokens) if (candTokens.has(token)) hits++;
  const ratio = hits / titleTokens.length;
  return ratio >= 0.75 ? 2 : ratio >= 0.45 ? 1 : 0;
}

function normalizeStreamUrl(url) {
  try {
    const u = new URL(url);
    ['utm_source', 'utm_medium', 'utm_campaign'].forEach(k => u.searchParams.delete(k));
    return u.toString();
  } catch (_) {
    return String(url || '');
  }
}

function getStreamPriority(stream) {
  return Number.isFinite(stream?.extra?._priority)
    ? stream.extra._priority
    : 9;
}

function isLikelyPlayerUrl(url) {
  return /(mixdrop|m1xdrop|voe|loadm|rpmshare|rpmplay|maxstream|supervideo|dood|streamtape|vixsrc|vixcloud|filemoon|dropload|dr0pstream|mxcontent)/i.test(url);
}

function extractSearchResultsFromHtml(html, baseUrl) {
  if (!html) return [];
  const $ = cheerio.load(String(html));
  const results = [];
  const seen = new Set();

  $('a[href]').each((_, el) => {
    const href = $(el).attr('href');
    if (!href || !/(\/serie\/|\/episodio\/)/i.test(href)) return;
    try {
      const absolute = new URL(href, baseUrl).toString();
      if (!seen.has(absolute)) {
        seen.add(absolute);
        results.push({
          url: absolute,
          title: String($(el).attr('title') || $(el).text() || '').trim() || absolute
        });
      }
    } catch (_) {}
  });

  return results;
}

async function searchProviderSequential(query, signal) {
  const baseUrl = await refreshTargetDomain(signal);

  const ajaxUrl = `${baseUrl}/wp-admin/admin-ajax.php`;
  const ajaxBody = `s=${encodeURIComponent(query)}&action=searchwp_live_search&swpengine=default&swpquery=${encodeURIComponent(query)}`;
  const ajaxHtml = await smartFetch(ajaxUrl, { isPost: true, body: ajaxBody, ttl: TTL_SEARCH, signal });
  const ajaxResults = extractSearchResultsFromHtml(ajaxHtml, baseUrl);

  if (ajaxResults.length > 0) return ajaxResults;

  const fallbackUrl = `${baseUrl}/?s=${encodeURIComponent(query)}`;
  const fallbackHtml = await smartFetch(fallbackUrl, { ttl: TTL_SEARCH, signal });
  return extractSearchResultsFromHtml(fallbackHtml, baseUrl);
}

function createTimeoutSignal(parentSignal, timeoutMs) {
  const controller = new AbortController();

  if (parentSignal?.aborted) {
    controller.abort(parentSignal.reason);
    return { signal: controller.signal, clear: () => {} };
  }

  const abortFromParent = () => {
    if (!controller.signal.aborted) controller.abort(parentSignal?.reason);
  };

  if (parentSignal) {
    parentSignal.addEventListener('abort', abortFromParent, { once: true });
  }

  const timer = setTimeout(() => {
    if (!controller.signal.aborted) controller.abort();
  }, timeoutMs);

  if (timer?.unref) timer.unref();

  return {
    signal: controller.signal,
    clear: () => {
      clearTimeout(timer);
      if (parentSignal) parentSignal.removeEventListener('abort', abortFromParent);
    }
  };
}

async function searchProviderWithTimeout(query, signal, timeoutMs = SEARCH_QUERY_TIMEOUT_MS) {
  const scoped = createTimeoutSignal(signal, timeoutMs);

  try {
    return await searchProviderSequential(query, scoped.signal);
  } catch (e) {
    if (isCanceledError(e) || scoped.signal.aborted) return [];
    return [];
  } finally {
    scoped.clear();
  }
}

async function searchProviderParallel(queries, signal) {
  const uniqueQueries = Array.from(new Set(queries.filter(Boolean)));
  if (!uniqueQueries.length) return [];

  const results = await Promise.all(
    uniqueQueries.map(q => searchProviderWithTimeout(q, signal))
  );

  return results.flat();
}

function extractEpisodeUrlFromSeriesPage(pageHtml, season, episode) {
  const raw = String(pageHtml || '');
  if (!raw) return null;

  const targetSeason = parseInt(season, 10);
  const targetEpisode = parseInt(episode, 10);
  if (!Number.isInteger(targetSeason) || !Number.isInteger(targetEpisode) || targetSeason < 1 || targetEpisode < 1) {
    return null;
  }

  const $ = cheerio.load(raw);
  const readSeasonNumber = text => {
    const match = String(text || '').match(/\b(?:stagione|season)\s*-?\s*(\d+)\b/i);
    return match ? parseInt(match[1], 10) : null;
  };
  const readEpisodeNumber = text => {
    const s = String(text || '');
    const match =
      s.match(/\b(?:episodio|episode|ep)\s*-?\s*(\d+)\b/i) ||
      s.match(/\bs\d{1,2}e(\d{1,3})\b/i) ||
      s.match(/\b\d{1,2}x(\d{1,3})\b/i);
    return match ? parseInt(match[1], 10) : null;
  };
  const findEpisodeInBlock = block => {
    const links = $(block).find('.les-content a[href*="/episodio/"], a[href*="/episodio/"]').toArray();

    for (const el of links) {
      const href = $(el).attr('href') || '';
      const epNum = readEpisodeNumber(`${$(el).text()} ${href}`);
      if (epNum === targetEpisode) return href || null;
    }

    return links.length >= targetEpisode ? ($(links[targetEpisode - 1]).attr('href') || null) : null;
  };

  const seasonBlocks = $('.tvseason').toArray();
  for (const block of seasonBlocks) {
    const seasonNum = readSeasonNumber($(block).find('.les-title').first().text());
    if (seasonNum !== targetSeason) continue;

    const href = findEpisodeInBlock(block);
    if (href) return href;
  }

  if (seasonBlocks.length >= targetSeason) {
    const href = findEpisodeInBlock(seasonBlocks[targetSeason - 1]);
    if (href) return href;
  }

  let matchedHref = null;
  $('a[href*="/episodio/"]').each((_, el) => {
    const href = $(el).attr('href') || '';
    const text = `${$(el).text()} ${href}`;
    const seasonNum = readSeasonNumber(text);
    const epNum = readEpisodeNumber(text);
    if (seasonNum === targetSeason && epNum === targetEpisode) {
      matchedHref = href;
      return false;
    }
  });

  if (matchedHref) return matchedHref;

  const directEpisodeRegexes = [
    new RegExp(`/episodio/[^"'\\s<>]*stagione-0?${targetSeason}-episodio-0?${targetEpisode}(?=[/?#"'\\s<>]|$)`, 'i'),
    new RegExp(`/episodio/[^"'\\s<>]*s0?${targetSeason}e0?${targetEpisode}(?=[/?#"'\\s<>]|$)`, 'i'),
    new RegExp(`/episodio/[^"'\\s<>]*${targetSeason}x${targetEpisode}(?=[/?#"'\\s<>]|$)`, 'i')
  ];

  for (const re of directEpisodeRegexes) {
    const match = raw.match(re);
    if (match?.[0]) return match[0];
  }

  const sIdx = targetSeason - 1;
  const eIdx = targetEpisode - 1;
  if (sIdx < 0 || eIdx < 0) return null;

  const legacySeasonBlocks = $('.les-content, [class*="season-"], [class*="stagione-"]');

  if (legacySeasonBlocks.length > sIdx) {
    const block = legacySeasonBlocks.eq(sIdx);
    const episodes = block.find('a[href*="/episodio/"]');
    if (episodes.length > eIdx) {
      return episodes.eq(eIdx).attr('href') || null;
    }
  }

  return null;
}

function extractPlayerLinksFromHtml(html) {
  const raw = String(html || '');
  const links = new Set();
  const baseUrl = normalizeBaseUrl(getTargetDomain()) || INITIAL_GS_DOMAIN;

  const normalize = (link) => {
    let n = String(link).trim().replace(/&amp;/g, '&').replace(/\\\//g, '/');
    if (!n || n.startsWith('data:')) return null;
    if (n.startsWith('//')) return `https:${n}`;
    if (n.startsWith('/')) return `${baseUrl}${n}`;
    if (!/^https?:\/\//i.test(n) && /(loadm|mixdrop|m1xdrop|mxcontent)/i.test(n)) {
      return `https://${n.replace(/^\/+/, '')}`;
    }
    return /^https?:\/\//i.test(n) ? n : null;
  };

  const iframeTags = raw.match(/<iframe\b[^>]*>/ig) || [];
  for (const tag of iframeTags) {
    const attrRegex = /\b(?:data-src|src)\s*=\s*(['"])(.*?)\1/ig;
    let m;
    while ((m = attrRegex.exec(tag)) !== null) {
      const c = normalize(m[2]);
      if (c && isLikelyPlayerUrl(c)) links.add(c);
    }
  }

  const directRegexes = [
    new RegExp(HOSTER_DIRECT_LINK_PATTERN, 'ig'),
    new RegExp(HOSTER_ESCAPED_DIRECT_LINK_PATTERN, 'ig')
  ];
  for (const regex of directRegexes) {
    for (const m of raw.match(regex) || []) {
      const c = normalize(m);
      if (c && isLikelyPlayerUrl(c)) links.add(c);
    }
  }

  return Array.from(links);
}

async function asyncPool(limit, items, asyncFn) {
  if (!items.length) return [];

  const results = new Array(items.length);
  const queue = items.map((item, i) => ({ item, i }));
  const running = new Set();

  async function runNext() {
    if (!queue.length) return;
    const { item, i } = queue.shift();
    const p = Promise.resolve()
      .then(() => asyncFn(item))
      .catch(() => null)
      .then(result => {
        results[i] = result;
        running.delete(p);
        return runNext();
      });
    running.add(p);
    return p;
  }

  const workers = Array.from({ length: Math.min(limit, items.length) }, runNext);
  await Promise.all(workers);
  return results;
}

async function searchGuardaserie(meta, config) {
  if (!meta?.isSeries || !config?.filters?.enableGs) return [];

  const season = parseInt(meta?.season, 10);
  const episode = parseInt(meta?.episode, 10);
  if (!season || season < 1 || !episode || episode < 1) return [];

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), GLOBAL_TIMEOUT_MS);

  try {
    return await _searchGuardaserie(meta, config, season, episode, controller.signal);
  } catch (_) {
    return [];
  } finally {
    clearTimeout(timer);
  }
}

async function _searchGuardaserie(meta, config, season, episode, signal) {
  await refreshTargetDomain(signal);

  let tmdbId = meta?.tmdb_id || meta?.tmdbId || null;

  if (!tmdbId && meta?.imdb_id) {
    try {
      const url = `https://api.themoviedb.org/3/find/${encodeURIComponent(meta.imdb_id)}?api_key=${TMDB_KEY}&external_source=imdb_id`;
      const res = await lightClient.get(url, { signal });
      tmdbId = res.data?.tv_results?.[0]?.id;
    } catch (_) {}
  }

  let showName = meta?.title, originalTitle = null, targetYear = null;
  if (tmdbId) {
    try {
      const res = await lightClient.get(
        `https://api.themoviedb.org/3/tv/${tmdbId}?api_key=${TMDB_KEY}&language=it-IT`,
        { signal }
      );
      showName = res.data.name || res.data.title || showName;
      originalTitle = res.data.original_name || res.data.original_title || null;
      targetYear = String(res.data.first_air_date || '').slice(0, 4) || null;
    } catch (_) {}
  }
  
  if (!showName) return [];

  const queries = Array.from(new Set([showName, originalTitle].filter(Boolean)));
  let allResults = await searchProviderParallel(queries, signal);

  allResults = Array.from(new Map(allResults.map(i => [i.url, i])).values());
  
  const seriesResults = allResults.filter(r => /\/serie\//i.test(r.url));
  const episodeResults = allResults.filter(r => /\/episodio\//i.test(r.url));
  allResults = [...seriesResults, ...episodeResults];

  allResults.sort((a, b) =>
    normalizeTitleScore(b.title, showName, originalTitle) -
    normalizeTitleScore(a.title, showName, originalTitle)
  );

  let target = null;
  let bestLoose = null;

  for (const result of allResults) {
    const titleScore = normalizeTitleScore(result.title, showName, originalTitle);
    if (titleScore < 1) continue;

    const html = await smartFetch(result.url, { ttl: TTL_SERIES, signal });
    if (!html) continue;

    const foundYear =
      html.match(/release-year\/(\d{4})/i)?.[1] ||
      html.match(/\b(19\d{2}|20\d{2})\b/)?.[1] ||
      null;

    if (targetYear && foundYear) {
      const allowedYearDelta = titleScore >= 3 ? 3 : 1;
      if (Math.abs(Number(foundYear) - Number(targetYear)) <= allowedYearDelta) {
        target = { url: result.url, html };
        break;
      }
    } else if (titleScore >= (bestLoose?.score || 0)) {
      bestLoose = { url: result.url, html, score: titleScore };
      if (titleScore >= 2) break;
    }
  }

  if (!target && bestLoose) target = bestLoose;

  if (!target) {
    const slugs = Array.from(new Set([slugify(showName), slugify(originalTitle)].filter(Boolean)));
    outer: for (const slug of slugs) {
      for (const p of [`/serie/${slug}/`, `/${slug}/`, `/serietv/${slug}/`]) {
        const url = buildGsUrl(p);
        const html = await smartFetch(url, { ttl: TTL_SERIES, signal });
        if (html) {
          const pageTitle = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1];
          if (normalizeTitleScore(pageTitle, showName, originalTitle) >= 2) {
            target = { url, html };
            break outer;
          }
        }
      }
    }
  }

  if (!target?.url) return [];

  const episodeUrl = extractEpisodeUrlFromSeriesPage(target.html, season, episode);
  if (!episodeUrl) return [];

  const absoluteEpUrl = new URL(episodeUrl, getTargetDomain()).toString();
  const finalHtml = await smartFetch(absoluteEpUrl, { ttl: TTL_EPISODE, signal });
  
  const playerLinks = Array.from(new Set(extractPlayerLinksFromHtml(finalHtml))).slice(0, 8);
  if (!playerLinks.length) return [];

  const cleanTitle = `${showName} S${String(season).padStart(2, '0')}E${String(episode).padStart(2, '0')}`;

  const processedResults = await asyncPool(3, playerLinks, async (link) => {
    try {
      const userAgent = activeSession.userAgent || pickRandomProfile(BROWSER_PROFILES).ua;
      const extracted = await extractFromUrl(link, {
        client: lightClient,
        userAgent,
        requestReferer: getTargetDomain()
      });
      if (!extracted?.url) return null;

      let quality = normalizeQuality(extracted?.quality || 'Unknown');
      if (/\.m3u8($|\?)/i.test(String(extracted.url))) {
        try {
          const probed = await probePlaylistQuality(lightClient, extracted.url, {
            headers: extracted.headers || {},
            timeout: 5000,
            signal
          });
          quality = pickBetterQuality(probed || 'Unknown', quality);
        } catch (_) {}
      }

      return buildWebStream({
        name: `GuardoSerie | ${extracted.name}`,
        title: `${cleanTitle}\n ${extracted.name}  ITA`,
        url: extracted.url,
        extractor: extracted.name,
        provider: 'GuardoSerie',
        providerCode: 'GS',
        quality,
        headers: extracted.headers,
        extra: { _priority: extracted.priority ?? 9 }
      });
    } catch (_) {
      return null;
    }
  });

  const validStreams = processedResults.filter(Boolean);

  return validStreams
    .sort((a, b) => {
      const qDelta = qualityRank(b.quality) - qualityRank(a.quality);
      return qDelta !== 0 ? qDelta : getStreamPriority(a) - getStreamPriority(b);
    })
    .filter((s, i, arr) => {
      const key = normalizeStreamUrl(s.url);
      return arr.findIndex(x => normalizeStreamUrl(x.url) === key) === i;
    })
    .map(s => {
      if (s.extra) delete s.extra._priority;
      delete s._priority;
      return s;
    });
}

module.exports = { searchGuardaserie, searchGuardoSerie: searchGuardaserie };
