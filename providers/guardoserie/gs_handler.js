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
const DEBUG              = process.env.GS_DEBUG === '1';

const TTL_SEARCH     = 1000 * 60 * 30;
const TTL_EPISODE    = 1000 * 60 * 30;
const TTL_SERIES     = 1000 * 60 * 60 * 6;
const CF_SESSION_TTL = 1000 * 60 * 60 * 6;

const GLOBAL_TIMEOUT_MS = 25000;

const agentOptions = {
  keepAlive: true,
  maxSockets: 250,
  maxFreeSockets: 100,
  timeout: 30000,
  keepAliveMsecs: 30000
};
const httpsAgent = new https.Agent(agentOptions);
const httpAgent  = new http.Agent(agentOptions);

let currentGsDomain = INITIAL_GS_DOMAIN;

const requestCache   = new Map();
const pendingRequests = new Map();
const activeBypasses  = new Map();

function getTargetDomain() { return currentGsDomain; }

function loadSession() {
  if (!fs.existsSync(SESSION_FILE)) return {};
  try {
    const data = JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8'));
    if (data?.userAgent) {
      if (data.url) {
        try {
          const u = new URL(data.url);
          currentGsDomain = `${u.protocol}//${u.host}`;
        } catch (_) {}
      }
      return data;
    }
  } catch (_) {}
  return {};
}

function saveSession(sessionData) {
  try {
    fs.writeFileSync(SESSION_FILE, JSON.stringify(sessionData, null, 2));
  } catch (e) {
  }
}

let activeSession = loadSession();

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

  cookiesArr.forEach(c => {
    const primary = c.split(';')[0];
    const parts = primary.split('=');
    if (parts.length >= 2) cookieMap.set(parts[0].trim(), parts.slice(1).join('=').trim());
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

async function getClearance(url, provider = PROVIDER_NAME, options = {}) {
  if (activeBypasses.has(provider)) {
    return activeBypasses.get(provider);
  }

  const bypassPromise = (async () => {
    const MAX_RETRIES = 2;
    let lastErr;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      if (attempt > 0) {
        const delay = 1500 * (2 ** (attempt - 1));
        await new Promise(r => setTimeout(r, delay));
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
          headers: { 'Content-Type': 'application/json' }
        });

        if (response.data?.status === 'ok') {
          const solution = response.data.solution;
          const cookies     = solution.cookies.map(c => `${c.name}=${c.value}`).join('; ');
          const cf_clearance = solution.cookies.find(c => c.name === 'cf_clearance')?.value || null;

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

          if (solution.url && solution.url !== url) {
            try {
              const u = new URL(solution.url);
              currentGsDomain = `${u.protocol}//${u.host}`;
            } catch (_) {}
          }

          return data;
        }
        lastErr = new Error(response.data?.message || 'Invalid');
      } catch (e) {
        lastErr = e;
      }
    }

    activeBypasses.delete(provider);
    return null;
  })();

  bypassPromise.finally(() => activeBypasses.delete(provider));
  activeBypasses.set(provider, bypassPromise);
  return bypassPromise;
}

async function executeSmartFetch(url, isPost = false, body = null) {
  if (activeSession && activeSession.cookies && activeSession.userAgent) {
    try {
      const reqOptions = {
        method: isPost ? 'POST' : 'GET',
        url,
        headers: {
          'User-Agent': activeSession.userAgent,
          'Cookie':     activeSession.cookies,
          'Referer':    getTargetDomain(),
          'Accept':     'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8'
        },
        timeout: 15000,
        httpAgent,
        httpsAgent,
        validateStatus: () => true
      };
      if (isPost && body) {
        reqOptions.data = body;
        reqOptions.headers['Content-Type'] = 'application/x-www-form-urlencoded';
      }

      const res  = await axios(reqOptions);
      const html = typeof res.data === 'string' ? res.data : JSON.stringify(res.data || {});

      if (res.status !== 403 && res.status !== 503 && !looksLikeChallenge(html)) {
        if (res.headers && res.headers['set-cookie']) {
          activeSession.cookies = updateCookies(activeSession.cookies, res.headers['set-cookie']);
          activeSession.timestamp = Date.now();
          saveSession(activeSession);
        }
        return html;
      }
      activeSession = {};
    } catch (e) {
    }
  }

  const session = await getClearance(url, PROVIDER_NAME, { method: isPost ? 'POST' : 'GET', body });
  return session?.response || null;
}

async function smartFetch(url, { isPost = false, body = null, ttl = TTL_SEARCH } = {}) {
  const cacheKey = `${isPost ? 'POST' : 'GET'}:${url}:${body || ''}`;

  const cached = requestCache.get(cacheKey);
  if (cached) {
    if (Date.now() < cached.expires) return cached.data;
    if (cached.stale && Date.now() < cached.stale && !pendingRequests.has(cacheKey)) {
      setImmediate(() => smartFetch(url, { isPost, body, ttl }));
      return cached.data;
    }
    requestCache.delete(cacheKey);
  }

  if (pendingRequests.has(cacheKey)) return pendingRequests.get(cacheKey);

  const fetchPromise = executeSmartFetch(url, isPost, body)
    .then(html => {
      if (html) {
        requestCache.set(cacheKey, {
          data:    html,
          expires: Date.now() + ttl,
          stale:   Date.now() + ttl * 2
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
  const cand      = normalizeText(candidate);
  const primary   = normalizeText(title);
  const secondary = normalizeText(originalTitle);
  if (!cand) return 0;
  if (cand === primary || (secondary && cand === secondary)) return 3;
  if (
    (primary   && (cand.includes(primary)    || primary.includes(cand)))   ||
    (secondary && (cand.includes(secondary)  || secondary.includes(cand)))
  ) return 2;

  const candTokens  = new Set(cand.split(' ').filter(Boolean));
  const titleTokens = Array.from(new Set(`${primary} ${secondary}`.trim().split(' ').filter(Boolean)));
  if (!titleTokens.length) return 0;

  let hits = 0;
  for (const token of titleTokens) if (candTokens.has(token)) hits++;
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
      const absolute = new URL(href, baseUrl).toString();
      if (!seen.has(absolute)) {
        seen.add(absolute);
        results.push({
          url:   absolute,
          title: String($(el).attr('title') || $(el).text() || '').trim() || absolute
        });
      }
    } catch (_) {}
  });

  return results;
}

async function searchProviderSequential(query) {
  const baseUrl = getTargetDomain();

  const ajaxUrl  = `${baseUrl}/wp-admin/admin-ajax.php`;
  const ajaxBody = `s=${encodeURIComponent(query)}&action=searchwp_live_search&swpengine=default&swpquery=${encodeURIComponent(query)}`;
  const ajaxHtml = await smartFetch(ajaxUrl, { isPost: true, body: ajaxBody, ttl: TTL_SEARCH });
  const ajaxResults = extractSearchResultsFromHtml(ajaxHtml, baseUrl);

  if (ajaxResults.length > 0) return ajaxResults;

  const fallbackUrl  = `${baseUrl}/?s=${encodeURIComponent(query)}`;
  const fallbackHtml = await smartFetch(fallbackUrl, { ttl: TTL_SEARCH });
  return extractSearchResultsFromHtml(fallbackHtml, baseUrl);
}

function extractEpisodeUrlFromSeriesPage(pageHtml, season, episode) {
  if (!pageHtml) return null;
  const sIdx = parseInt(season,  10) - 1;
  const eIdx = parseInt(episode, 10) - 1;
  if (sIdx < 0 || eIdx < 0) return null;

  const $ = cheerio.load(String(pageHtml));

  const seasonBlocks = $('.les-content, [class*="season-"], [class*="stagione-"]');

  if (seasonBlocks.length > sIdx) {
    const block    = seasonBlocks.eq(sIdx);
    const episodes = block.find('a[href*="/episodio/"]');
    if (episodes.length > eIdx) {
      return episodes.eq(eIdx).attr('href') || null;
    }
  }

  const explicit = new RegExp(
    `https?:\\/\\/[^"'\\s]+\\/episodio\\/[^"'\\s]*stagione-${season}-episodio-${episode}[^"'\\s]*`,
    'i'
  );
  return pageHtml.match(explicit)?.[0] || null;
}

function extractPlayerLinksFromHtml(html) {
  const raw    = String(html || '');
  const links  = new Set();
  const baseUrl = getTargetDomain();

  const normalize = (link) => {
    let n = String(link).trim().replace(/&amp;/g, '&').replace(/\\\//g, '/');
    if (!n || n.startsWith('data:')) return null;
    if (n.startsWith('//'))          return `https:${n}`;
    if (n.startsWith('/'))           return `${baseUrl}${n}`;
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
      if (c) links.add(c);
    }
  }

  const directRegexes = [
    new RegExp(HOSTER_DIRECT_LINK_PATTERN,         'ig'),
    new RegExp(HOSTER_ESCAPED_DIRECT_LINK_PATTERN, 'ig')
  ];
  for (const regex of directRegexes) {
    for (const m of raw.match(regex) || []) {
      const c = normalize(m);
      if (c) links.add(c);
    }
  }

  return Array.from(links);
}

async function asyncPool(limit, items, asyncFn) {
  if (!items.length) return [];

  const results  = new Array(items.length);
  const queue    = items.map((item, i) => ({ item, i }));
  const running  = new Set();

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

  const season  = parseInt(meta?.season,  10);
  const episode = parseInt(meta?.episode, 10);
  if (!season || season < 1 || !episode || episode < 1) return [];

  return Promise.race([
    _searchGuardaserie(meta, config, season, episode),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error('GS_TIMEOUT')), GLOBAL_TIMEOUT_MS)
    )
  ]).catch(e => {
    return [];
  });
}

async function _searchGuardaserie(meta, config, season, episode) {
  const bench     = [];
  const benchStart = Date.now();
  const mark = (step, extra = {}) => {
    if (DEBUG) bench.push({ step, t: Date.now() - benchStart, ...extra });
  };

  const lightClient = axios.create({ timeout: 10000, httpsAgent, httpAgent });
  let tmdbId = meta?.tmdb_id || meta?.tmdbId || null;

  if (!tmdbId && meta?.imdb_id) {
    try {
      const url = `https://api.themoviedb.org/3/find/${encodeURIComponent(meta.imdb_id)}?api_key=${TMDB_KEY}&external_source=imdb_id`;
      const res = await lightClient.get(url);
      tmdbId = res.data?.tv_results?.[0]?.id;
    } catch (_) {}
  }

  let showName = meta?.title, originalTitle = null, targetYear = null;
  if (tmdbId) {
    try {
      const res = await lightClient.get(
        `https://api.themoviedb.org/3/tv/${tmdbId}?api_key=${TMDB_KEY}&language=it-IT`
      );
      showName      = res.data.name || res.data.title || showName;
      originalTitle = res.data.original_name || res.data.original_title || null;
      targetYear    = String(res.data.first_air_date || '').slice(0, 4) || null;
    } catch (_) {}
  }
  mark('tmdb_info', { tmdbId, showName });
  if (!showName) return [];

  const queries = Array.from(new Set([showName, originalTitle].filter(Boolean)));
  let allResults = [];

  for (const q of queries) {
    const res = await searchProviderSequential(q);
    allResults.push(...res);
  }
  mark('search_completed', { resultsFound: allResults.length });

  allResults = Array.from(new Map(allResults.map(i => [i.url, i])).values());
  allResults.sort((a, b) =>
    normalizeTitleScore(b.title, showName, originalTitle) -
    normalizeTitleScore(a.title, showName, originalTitle)
  );

  let target   = null;
  let bestLoose = null;

  for (const result of allResults) {
    const titleScore = normalizeTitleScore(result.title, showName, originalTitle);
    if (titleScore < 1) continue;

    const html = await smartFetch(result.url, { ttl: TTL_SERIES });
    if (!html) continue;

    const foundYear =
      html.match(/release-year\/(\d{4})/i)?.[1] ||
      html.match(/\b(19\d{2}|20\d{2})\b/)?.[1] ||
      null;

    if (targetYear && foundYear) {
      if (Math.abs(Number(foundYear) - Number(targetYear)) <= (titleScore >= 2 ? 10 : 1)) {
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
        const url  = `${getTargetDomain()}${p}`;
        const html = await smartFetch(url, { ttl: TTL_SERIES });
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

  mark('target_resolved', { found: !!target?.url });
  if (!target?.url) return [];

  const episodeUrl = extractEpisodeUrlFromSeriesPage(target.html, season, episode);
  if (!episodeUrl) return [];

  const absoluteEpUrl = new URL(episodeUrl, getTargetDomain()).toString();
  const finalHtml     = await smartFetch(absoluteEpUrl, { ttl: TTL_EPISODE });
  mark('episode_fetched');

  const playerLinks = Array.from(new Set(extractPlayerLinksFromHtml(finalHtml))).slice(0, 8);
  mark('players_extracted', { count: playerLinks.length });
  if (!playerLinks.length) return [];

  const cleanTitle = `${showName} S${String(season).padStart(2, '0')}E${String(episode).padStart(2, '0')}`;

  const processedResults = await asyncPool(3, playerLinks, async (link) => {
    try {
      const userAgent = activeSession.userAgent || pickRandomProfile(BROWSER_PROFILES).ua;
      const extracted = await extractFromUrl(link, {
        client:          lightClient,
        userAgent,
        requestReferer:  getTargetDomain()
      });
      if (!extracted?.url) return null;

      let quality = normalizeQuality(extracted?.quality || 'Unknown');
      if (/\.m3u8($|\?)/i.test(String(extracted.url))) {
        try {
          const probed = await probePlaylistQuality(lightClient, extracted.url, {
            headers: extracted.headers || {},
            timeout: 5000
          });
          quality = pickBetterQuality(probed || 'Unknown', quality);
        } catch (_) {}
      }

      return buildWebStream({
        name:      `GuardoSerie | ${extracted.name}`,
        title:     `${cleanTitle}\n ${extracted.name}  ITA`,
        url:       extracted.url,
        extractor: extracted.name,
        provider:  'GuardoSerie',
        providerCode: 'GS',
        quality,
        headers:   extracted.headers,
        extra:     { _priority: extracted.priority ?? 9 }
      });
    } catch (_) {
      return null;
    }
  });

  const validStreams = processedResults.filter(Boolean);
  mark('extraction_completed', { streams: validStreams.length });

  return validStreams
    .sort((a, b) => {
      const qDelta = qualityRank(b.quality) - qualityRank(a.quality);
      return qDelta !== 0 ? qDelta : (a._priority || 9) - (b._priority || 9);
    })
    .filter((s, i, arr) => arr.findIndex(x => x.url === s.url) === i)
    .map(s => { delete s._priority; return s; });
}

module.exports = { searchGuardaserie, searchGuardoSerie: searchGuardaserie };
