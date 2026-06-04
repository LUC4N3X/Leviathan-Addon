'use strict';

const axios = require('axios');
const cheerio = require('cheerio');
const { HTTP_AGENT, HTTPS_AGENT } = require('../../core/utils/http');
const tmdbHelper = require('../../core/utils/tmdb_helper');
const { SingleFlight, TtlLruCache } = require('../utils/provider_runtime');
const { withProviderHealth } = require('../utils/provider_health');
const { normalizeStreams } = require('../utils/stream_normalizer');
const { buildLazyExtractorStream } = require('../extractors/lazy_extraction');
const {
    buildWebStream,
    normalizeRemoteUrl,
    normalizeQuality,
    pickBetterQuality,
    probePlaylistIntelligence,
    decorateStreamWithPlaylistIntelligence,
    qualityRank
} = require('../extractors/common');
const {
    extractFromUrl,
    resolveExtractorDefinition,
    HOSTER_DIRECT_LINK_PATTERN,
    HOSTER_ESCAPED_DIRECT_LINK_PATTERN
} = require('../extractors/registry');
const { extractEmbedCandidates } = require('../extractors/semantic_candidate_extractor');

const PROVIDER_ID = 'guardaserietv';
const PROVIDER_LABEL = 'GuardaserieTV';
const PROVIDER_CODE = 'GSTV';
const BASE_URL = String(process.env.GUARDASERIETV_BASE || 'https://guardaserietv.rest').replace(/\/+$/, '');
const FALLBACK_BASE_URLS = String(process.env.GUARDASERIETV_BASES || 'https://guardaserietv.hair,https://guardaserietv.rest')
    .split(',')
    .map((item) => item.trim().replace(/\/+$/, ''))
    .filter(Boolean);
const TIMEOUT_MS = Math.max(5000, Number.parseInt(process.env.GUARDASERIETV_TIMEOUT_MS || '12000', 10) || 12000);
const SEARCH_TTL_MS = Math.max(60_000, Number.parseInt(process.env.GUARDASERIETV_SEARCH_TTL_MS || `${30 * 60 * 1000}`, 10) || 30 * 60 * 1000);
const PAGE_TTL_MS = Math.max(60_000, Number.parseInt(process.env.GUARDASERIETV_PAGE_TTL_MS || `${30 * 60 * 1000}`, 10) || 30 * 60 * 1000);
const STREAM_TTL_MS = Math.max(60_000, Number.parseInt(process.env.GUARDASERIETV_STREAM_TTL_MS || `${10 * 60 * 1000}`, 10) || 10 * 60 * 1000);
const DEBUG = /^(1|true|yes|on)$/i.test(String(process.env.GUARDASERIETV_DEBUG || '0'));
const VIDXGO_ONLY_DEFAULT = !/^(0|false|no|off)$/i.test(String(process.env.GUARDASERIETV_VIDXGO_FIRST || '1'));
const ALLOW_SUPERVIDEO_LAZY = /^(1|true|yes|on)$/i.test(String(process.env.GUARDASERIETV_ALLOW_SUPERVIDEO_LAZY || '0'));
const MAX_SEARCH_RESULTS = Math.max(4, Math.min(40, Number.parseInt(process.env.GUARDASERIETV_MAX_SEARCH_RESULTS || '18', 10) || 18));
const MAX_EMBEDS = Math.max(1, Math.min(8, Number.parseInt(process.env.GUARDASERIETV_MAX_EMBEDS || '4', 10) || 4));
const DIRECT_LINK_RE = new RegExp(HOSTER_DIRECT_LINK_PATTERN, 'ig');
const ESCAPED_DIRECT_LINK_RE = new RegExp(HOSTER_ESCAPED_DIRECT_LINK_PATTERN, 'ig');

const USER_AGENT = String(process.env.GUARDASERIETV_USER_AGENT || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36');

const http = axios.create({
    timeout: TIMEOUT_MS,
    httpAgent: HTTP_AGENT,
    httpsAgent: HTTPS_AGENT,
    maxRedirects: 5,
    decompress: true,
    proxy: false,
    validateStatus: (status) => status >= 200 && status < 400,
    headers: {
        'User-Agent': USER_AGENT,
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'it-IT,it;q=0.9,en-US;q=0.8,en;q=0.7'
    }
});

const cache = {
    search: new TtlLruCache({ name: 'guardaserietv:search', ttlMs: SEARCH_TTL_MS, staleTtlMs: SEARCH_TTL_MS, max: 700, cloneValues: true }),
    page: new TtlLruCache({ name: 'guardaserietv:page', ttlMs: PAGE_TTL_MS, staleTtlMs: PAGE_TTL_MS, max: 1400 }),
    streams: new TtlLruCache({ name: 'guardaserietv:streams', ttlMs: STREAM_TTL_MS, staleTtlMs: STREAM_TTL_MS, max: 2500, cloneValues: true })
};

const singleFlight = new SingleFlight('guardaserietv');

function log(message, meta = null) {
    if (!DEBUG) return;
    const suffix = meta ? ` ${JSON.stringify(meta)}` : '';
    console.log(`[GuardaserieTV] ${message}${suffix}`);
}

function cleanText(value) {
    return String(value || '')
        .replace(/&nbsp;/gi, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function normalizeTitle(value) {
    return cleanText(value)
        .normalize('NFKD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .replace(/\b(?:streaming|streaming\s*ita|completo|serie\s*tv|serietv|stagione|episodi?|ita|hd)\b/g, ' ')
        .replace(/[^a-z0-9]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function slugify(value) {
    return normalizeTitle(value).replace(/\s+/g, '-').replace(/^-+|-+$/g, '');
}

function uniqueStrings(values = [], limit = 14) {
    const out = [];
    const seen = new Set();
    for (const value of values) {
        const text = cleanText(value);
        const key = normalizeTitle(text);
        if (!text || !key || seen.has(key)) continue;
        seen.add(key);
        out.push(text);
        if (out.length >= limit) break;
    }
    return out;
}

function extractYear(value) {
    const match = String(value || '').match(/\b(19\d{2}|20\d{2})\b/);
    return match ? Number(match[1]) : null;
}

function absoluteUrl(raw, base = BASE_URL) {
    return normalizeRemoteUrl(String(raw || '').trim().replace(/&amp;/g, '&').replace(/\\\//g, '/'), base);
}

function originOf(value, fallback = BASE_URL) {
    try {
        return new URL(String(value || fallback)).origin;
    } catch (_) {
        return fallback;
    }
}

function getBaseUrls() {
    const out = [];
    const add = (value) => {
        const clean = String(value || '').trim().replace(/\/+$/, '');
        if (clean && !out.includes(clean)) out.push(clean);
    };
    for (const value of FALLBACK_BASE_URLS) add(value);
    add(BASE_URL);
    return out;
}

function responseText(response) {
    if (typeof response?.data === 'string') return response.data;
    if (Buffer.isBuffer(response?.data)) return response.data.toString('utf8');
    if (response?.data == null) return '';
    return String(response.data || '');
}

function headersFor(url, referer = BASE_URL) {
    const finalReferer = referer || BASE_URL;
    return {
        'User-Agent': USER_AGENT,
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'it-IT,it;q=0.9,en-US;q=0.8,en;q=0.7',
        Referer: finalReferer,
        Origin: originOf(finalReferer, originOf(url, BASE_URL))
    };
}

async function fetchHtml(url, { ttlMs = PAGE_TTL_MS, referer = BASE_URL, signal = null } = {}) {
    const key = `html:${url}`;
    const cached = cache.page.get(key);
    if (cached) return cached;

    return singleFlight.do(key, async () => {
        const second = cache.page.get(key);
        if (second) return second;
        const response = await http.get(url, {
            headers: headersFor(url, referer),
            timeout: TIMEOUT_MS,
            signal
        });
        const html = responseText(response);
        if (html) cache.page.set(key, html, ttlMs, ttlMs);
        return html;
    });
}

function getPageTitle(html) {
    const $ = cheerio.load(String(html || ''));
    return cleanText(
        $('h1').first().text()
        || $('h2').first().text()
        || $('.title, .entry-title, .post-title').first().text()
        || $('meta[property="og:title"]').attr('content')
        || $('title').first().text()
    ).replace(/\s*[-|]\s*Guardaserie.*$/i, '').trim();
}

function scoreTitle(candidateTitle, expectedTitles = []) {
    const candidate = normalizeTitle(candidateTitle);
    if (!candidate) return 0;
    let best = 0;
    for (const expectedTitle of expectedTitles) {
        const expected = normalizeTitle(expectedTitle);
        if (!expected) continue;
        if (candidate === expected) best = Math.max(best, 100);
        else if (candidate.includes(expected) || expected.includes(candidate)) best = Math.max(best, 82);
        else {
            const cParts = new Set(candidate.split(' ').filter(Boolean));
            const eParts = expected.split(' ').filter(Boolean);
            const overlap = eParts.filter((part) => cParts.has(part)).length;
            if (eParts.length) best = Math.max(best, Math.round((overlap / eParts.length) * 70));
        }
    }
    return best;
}

function parseSearchResults(html, expectedTitles = [], baseUrl = BASE_URL, { allowImdbSearch = false } = {}) {
    const $ = cheerio.load(String(html || ''));
    const out = [];
    const seen = new Set();

    $('a[href*="/serietv/"]').each((_, el) => {
        const href = absoluteUrl($(el).attr('href'), baseUrl);
        if (!href || seen.has(href)) return;
        const container = $(el).closest('article, tr, li, .item, .result, .movie, .ml-item, .short, .th-item, .row');
        const title = cleanText(
            $(el).text()
            || container.find('h1,h2,h3,.title,.name').first().text()
            || $(el).attr('title')
            || $(el).find('img').attr('alt')
        );
        const nearbyText = cleanText(container.text() || $(el).parent().text());
        const year = extractYear(nearbyText);
        const score = Math.max(scoreTitle(title || nearbyText, expectedTitles), allowImdbSearch && title && !/\[\s*sub\s*ita\s*\]/i.test(title) ? 75 : 0);
        if (score <= 0 && !title) return;
        seen.add(href);
        out.push({ url: href, title: title || getTitleFromUrl(href), year, score });
    });

    return out
        .sort((a, b) => b.score - a.score)
        .slice(0, MAX_SEARCH_RESULTS);
}

function getTitleFromUrl(url) {
    try {
        const last = new URL(url).pathname.split('/').pop() || '';
        return cleanText(last.replace(/^\d+-/, '').replace(/\.html$/i, '').replace(/[-_]+/g, ' '));
    } catch (_) {
        return '';
    }
}

function buildSearchUrls(query, baseUrl = BASE_URL) {
    const encoded = encodeURIComponent(query).replace(/%20/g, '%20');
    const plus = encodeURIComponent(query).replace(/%20/g, '+');
    return uniqueStrings([
        `${baseUrl}/index.php?do=search&subaction=search&story=${plus}`,
        `${baseUrl}/cerca/${encoded}/`,
        `${baseUrl}/?s=${plus}`
    ], 3);
}

function buildFastCandidateUrls(expectedTitles = []) {
    const out = [];
    const seen = new Set();
    for (const baseUrl of getBaseUrls()) {
        for (const title of expectedTitles.slice(0, 8)) {
            const slug = slugify(title);
            if (!slug) continue;
            for (const candidate of [
                `${baseUrl}/serietv/${slug}-streaming-streaming-ita.html`,
                `${baseUrl}/serietv/${slug}-completo-streaming-ita.html`,
                `${baseUrl}/serietv/${slug}-streaming-ita.html`
            ]) {
                if (seen.has(candidate)) continue;
                seen.add(candidate);
                out.push(candidate);
            }
        }
    }
    return out.slice(0, 24);
}

async function getExpectedTitles(meta = {}) {
    const base = [
        meta.title,
        meta.name,
        meta.originalTitle,
        meta.original_title,
        meta.canonicalTitle,
        meta.englishTitle,
        meta.localizedTitle
    ];

    const resolved = await tmdbHelper.resolveFromMeta(meta, { type: 'tv', language: 'it-IT' }).catch(() => null);
    if (resolved) {
        base.push(resolved.title, resolved.name, resolved.original_title, resolved.originalName, resolved.original_name);
    }

    const english = await tmdbHelper.resolveFromMeta(meta, { type: 'tv', language: 'en-US' }).catch(() => null);
    if (english) {
        base.push(english.title, english.name, english.original_title, english.originalName, english.original_name);
    }

    return uniqueStrings(base, 16);
}


function getMetaImdbId(meta = {}) {
    for (const value of [meta.imdb_id, meta.imdbId, meta.imdb, meta.id]) {
        const imdb = normalizeImdbId(value);
        if (imdb) return imdb;
    }
    return null;
}

async function findSeriesPageByImdb(imdbId, expectedTitles = [], signal = null) {
    const normalized = normalizeImdbId(imdbId);
    if (!normalized) return [];
    const candidates = [];

    for (const baseUrl of getBaseUrls()) {
        const searchUrl = `${baseUrl}/index.php?do=search&subaction=search&story=${encodeURIComponent(normalized)}`;
        try {
            const html = await fetchHtml(searchUrl, { ttlMs: SEARCH_TTL_MS, referer: baseUrl, signal });
            const directMatch = /<div\s+class=["']mlnh-2["'][\s\S]*?<h2>[\s\S]*?<a\s+href=["']([^"']+)["']\s+title=["']([^"']+)["']/i.exec(html);
            if (directMatch && !/\[\s*sub\s*ita\s*\]/i.test(directMatch[2] || '')) {
                const url = absoluteUrl(directMatch[1], baseUrl);
                const title = cleanText(directMatch[2]);
                candidates.push({ url, title, score: Math.max(90, scoreTitle(title, expectedTitles)), year: extractYear(title) });
            }
            candidates.push(...parseSearchResults(html, expectedTitles, baseUrl, { allowImdbSearch: true }));
        } catch (_) {}
    }

    return Array.from(new Map(candidates.filter((item) => item?.url).map((item) => [item.url, item])).values())
        .filter((item) => !/\[\s*sub\s*ita\s*\]/i.test(String(item.title || '')))
        .sort((a, b) => (b.score || 0) - (a.score || 0));
}

async function findSeriesPage(meta = {}, expectedTitles = [], signal = null) {
    const targetYear = extractYear(meta.year || meta.releaseYear || meta.released);
    const candidates = [];

    const imdbCandidates = await findSeriesPageByImdb(getMetaImdbId(meta), expectedTitles, signal);
    candidates.push(...imdbCandidates);

    for (const url of buildFastCandidateUrls(expectedTitles)) {
        try {
            const html = await fetchHtml(url, { ttlMs: PAGE_TTL_MS, signal });
            if (!html || !/Links Streaming|STAGIONE|serietv/i.test(html)) continue;
            const title = getPageTitle(html) || getTitleFromUrl(url);
            const score = scoreTitle(title, expectedTitles);
            if (score > 0) candidates.push({ url, html, title, score, year: extractYear(html) });
        } catch (_) {}
    }

    if (!candidates.some((candidate) => candidate.score >= 82)) {
        const searched = [];
        for (const query of expectedTitles.slice(0, 5)) {
            for (const baseUrl of getBaseUrls()) {
                for (const url of buildSearchUrls(query, baseUrl)) {
                if (searched.includes(url)) continue;
                searched.push(url);
                try {
                    const html = await fetchHtml(url, { ttlMs: SEARCH_TTL_MS, referer: baseUrl, signal });
                    candidates.push(...parseSearchResults(html, expectedTitles, baseUrl));
                } catch (_) {}
                }
            }
        }
    }

    const unique = Array.from(new Map(candidates.map((candidate) => [candidate.url, candidate])).values())
        .filter((candidate) => candidate.score >= 45 || scoreTitle(candidate.title, expectedTitles) >= 45)
        .sort((a, b) => {
            const ay = targetYear && a.year ? Math.abs(a.year - targetYear) : 0;
            const by = targetYear && b.year ? Math.abs(b.year - targetYear) : 0;
            return (b.score - a.score) || (ay - by);
        });

    for (const candidate of unique.slice(0, 6)) {
        try {
            const html = candidate.html || await fetchHtml(candidate.url, { ttlMs: PAGE_TTL_MS, signal });
            const pageTitle = getPageTitle(html) || candidate.title;
            const score = Math.max(candidate.score, scoreTitle(pageTitle, expectedTitles));
            const foundYear = extractYear(html) || candidate.year;
            if (targetYear && foundYear && Math.abs(foundYear - targetYear) > 2 && score < 90) continue;
            if (score < 45) continue;
            return { url: candidate.url, html, title: pageTitle, score, year: foundYear };
        } catch (_) {}
    }

    return null;
}

function normalizeImdbId(value) {
    const match = String(value || '').match(/tt\d{5,12}/i);
    return match ? match[0].toLowerCase() : null;
}

function buildVidxgoUrlFromImdb(imdbId, season, episode) {
    const normalized = normalizeImdbId(imdbId);
    if (!normalized) return null;
    const numeric = normalized.replace(/^tt/i, '');
    if (!numeric) return null;
    return `https://v.vidxgo.co/${numeric}/${Number(season)}/${Number(episode)}`;
}

function extractVidxgoBaseFromHtml(html) {
    const source = String(html || '');
    const directPatterns = [
        /vidxgo-frame["']?\s*\.\s*src\s*=\s*["'](https?:\/\/[^"']+)["']/i,
        /<iframe\b[^>]+src=["'](https?:\/\/[^"']*vidxgo[^"']+)["']/i,
        /(?:https?:)?\/\/v\.vidxgo\.co\/[0-9]+(?:\/\d+\/\d+)?/i,
        /(?:https?:)?\/\/(?:www\.)?vidxgo\.(?:co|com|net|to)\/[^"'<>\s]+/i
    ];

    for (const pattern of directPatterns) {
        const match = source.match(pattern);
        const url = cleanText(match?.[1] || match?.[0]);
        const normalized = absoluteUrl(url.startsWith('//') ? `https:${url}` : url, BASE_URL);
        if (normalized) return normalized;
    }

    const imdbPatterns = [
        /show_imdb\s*=\s*["'](tt\d+)["']/i,
        /data-imdb(?:id)?=["'](tt\d+)["']/i,
        /vidxgo\.co\/["']?\s*\+\s*["'](tt\d+)["']/i,
        /vidxgo[^\n;]+(tt\d+)/i
    ];
    for (const pattern of imdbPatterns) {
        const imdb = normalizeImdbId(source.match(pattern)?.[1]);
        if (imdb) return buildVidxgoUrlFromImdb(imdb, 1, 1)?.replace(/\/1\/1$/, '');
    }
    return null;
}

function buildVidxgoEpisodeLinks(html, meta = {}, season, episode) {
    const urls = [];
    const seen = new Set();
    const add = (url) => {
        const normalized = absoluteUrl(url, BASE_URL);
        if (!normalized || seen.has(normalized)) return;
        seen.add(normalized);
        urls.push({ url: normalized, label: 'VidxGo', priority: -50, synthetic: true });
    };

    const htmlBase = extractVidxgoBaseFromHtml(html);
    if (htmlBase) {
        if (/\/\d+\/\d+\/?(?:[?#].*)?$/i.test(htmlBase)) add(htmlBase);
        else add(`${htmlBase.replace(/\/+$/, '')}/${Number(season)}/${Number(episode)}`);
    }

    for (const value of [meta.imdb_id, meta.imdbId, meta.imdb, meta.id]) {
        const url = buildVidxgoUrlFromImdb(value, season, episode);
        if (url) add(url);
    }

    return urls;
}

function getLinkPriority(href, def) {
    if (/vidx\s*go|vidxgo/i.test(String(href || ''))) return -50;
    if (def?.key === 'vidxgo') return -50;
    if (def?.key === 'supervideo') return 30;
    return def?.priority ?? 9;
}

function getLazyAllowedHosters() {
    const raw = String(process.env.GUARDASERIETV_LAZY_HOSTERS || process.env.GSTV_LAZY_HOSTERS || 'vidxgo').trim();
    return new Set(raw.split(',').map((item) => item.trim().toLowerCase()).filter(Boolean));
}

function shouldExposeLazyFallback(def, link) {
    if (!def?.key) return false;
    const key = String(def.key || '').toLowerCase();
    if (key === 'supervideo' && !ALLOW_SUPERVIDEO_LAZY) return false;
    if (key !== 'vidxgo' && VIDXGO_ONLY_DEFAULT) return false;
    if (/^(1|true|yes|on)$/i.test(String(process.env.GUARDASERIETV_LAZY_ALL_HOSTERS || '0'))) return true;
    return getLazyAllowedHosters().has(key) || /vidx\s*go|vidxgo/i.test(String(link?.url || link?.label || ''));
}

function extractLinksFromBlock(blockHtml, pageUrl) {
    const links = [];
    const seen = new Set();
    const anchorRe = /<a\b[^>]+href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/ig;
    let match;

    while ((match = anchorRe.exec(blockHtml)) !== null) {
        const href = absoluteUrl(match[1], pageUrl);
        if (!href || seen.has(href)) continue;
        const def = resolveExtractorDefinition(href);
        if (!def && !/\.m3u8(?:$|[?#])/i.test(href)) continue;
        const label = cleanText(match[2].replace(/<[^>]+>/g, '')) || def?.label || 'Hoster';
        seen.add(href);
        links.push({ url: href, label, priority: getLinkPriority(href, def) });
    }

    for (const regex of [DIRECT_LINK_RE, ESCAPED_DIRECT_LINK_RE]) {
        regex.lastIndex = 0;
        for (const raw of blockHtml.match(regex) || []) {
            const href = absoluteUrl(raw, pageUrl);
            if (!href || seen.has(href)) continue;
            const def = resolveExtractorDefinition(href);
            if (!def) continue;
            seen.add(href);
            links.push({ url: href, label: def.label, priority: getLinkPriority(href, def) });
        }
    }

    for (const semanticCandidate of extractEmbedCandidates(blockHtml, { baseUrl: pageUrl, maxCandidates: MAX_EMBEDS })) {
        const href = absoluteUrl(semanticCandidate.url, pageUrl);
        if (!href || seen.has(href)) continue;
        const def = resolveExtractorDefinition(href);
        if (!def) continue;
        seen.add(href);
        links.push({ url: href, label: semanticCandidate.label || def.label, priority: getLinkPriority(href, def) });
    }

    return links.sort((a, b) => a.priority - b.priority);
}

function parseEpisodeLinks(html, season, episode, pageUrl) {
    const wanted = `${Number(season)}x${Number(episode)}`;
    const raw = String(html || '')
        .replace(/\r/g, '')
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<\/p>|<\/div>|<\/li>|<\/tr>/gi, '\n$&');
    const episodeRe = /(\d{1,2})\s*x\s*(\d{1,4})\s*(?:[–—-]|:)?\s*([\s\S]*?)(?=\n?\s*\d{1,2}\s*x\s*\d{1,4}\s*(?:[–—-]|:)|\n?\s*STAGIONE\s+\d+|$)/ig;
    const found = [];
    let match;

    while ((match = episodeRe.exec(raw)) !== null) {
        const s = Number.parseInt(match[1], 10);
        const e = Number.parseInt(match[2], 10);
        if (s !== Number(season) || e !== Number(episode)) continue;
        found.push(...extractLinksFromBlock(match[3] || '', pageUrl));
    }

    if (found.length) return found;

    const $ = cheerio.load(String(html || ''));
    const text = cleanText($.root().text());
    if (!new RegExp(`\\b${wanted.replace('x', '\\s*x\\s*')}\\b`, 'i').test(text)) return [];

    const links = [];
    const seen = new Set();
    const pushLink = (href, label = 'Hoster') => {
        if (!href || seen.has(href)) return;
        const def = resolveExtractorDefinition(href);
        if (!def && !/\.m3u8(?:$|[?#])/i.test(href)) return;
        seen.add(href);
        links.push({ url: href, label: label || def?.label || 'Hoster', priority: def?.priority ?? 9 });
    };
    $('a[href]').each((_, el) => {
        const href = absoluteUrl($(el).attr('href'), pageUrl);
        pushLink(href, cleanText($(el).text()));
    });
    for (const semanticCandidate of extractEmbedCandidates(html, { baseUrl: pageUrl, maxCandidates: MAX_EMBEDS })) {
        pushLink(absoluteUrl(semanticCandidate.url, pageUrl), semanticCandidate.label);
    }
    return links.sort((a, b) => a.priority - b.priority).slice(0, MAX_EMBEDS);
}

async function asyncPool(limit, items, worker) {
    const out = [];
    let index = 0;
    async function next() {
        const current = index;
        index += 1;
        if (current >= items.length) return;
        out[current] = await worker(items[current]).catch(() => null);
        await next();
    }
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, next));
    return out;
}

async function buildStreamsFromLinks(links = [], { title, pageUrl, reqHost, signal }) {
    const streams = await asyncPool(Math.min(MAX_EMBEDS, links.length), links.slice(0, MAX_EMBEDS), async (link) => {
        const def = resolveExtractorDefinition(link.url);
        if (VIDXGO_ONLY_DEFAULT && def?.key !== 'vidxgo') {
            log('skip non-vidxgo hoster', { hoster: def?.key || 'direct', url: link.url });
            return null;
        }
        if (!def && /\.m3u8(?:$|[?#])/i.test(link.url)) {
            return buildWebStream({
                name: `${PROVIDER_LABEL} | Direct`,
                title: `${title}\nDirect ITA`,
                url: link.url,
                extractor: 'Direct',
                provider: PROVIDER_LABEL,
                providerCode: PROVIDER_CODE,
                quality: 'Unknown',
                headers: headersFor(link.url, pageUrl),
                extra: { _priority: 0 }
            });
        }
        if (!def) return null;

        const extracted = await extractFromUrl(link.url, {
            client: http,
            userAgent: USER_AGENT,
            requestReferer: pageUrl,
            referer: pageUrl,
            pageUrl,
            fetchers: [
                (targetUrl, headers) => http.get(targetUrl, {
                    headers,
                    timeout: TIMEOUT_MS,
                    responseType: 'text'
                }).then((response) => responseText(response))
            ]
        }).catch(() => null);

        if (!extracted?.url) {
            if (!shouldExposeLazyFallback(def, link)) {
                log('skip unresolved hoster', { hoster: def.key, url: link.url });
                return null;
            }
            return buildLazyExtractorStream({
                embedUrl: link.url,
                reqHost,
                provider: PROVIDER_LABEL,
                providerCode: PROVIDER_CODE,
                title,
                name: def.label || link.label,
                quality: 'Unknown',
                referer: pageUrl,
                headers: headersFor(link.url, pageUrl),
                extra: { _priority: link.priority ?? def.priority ?? 9 }
            });
        }

        let quality = normalizeQuality(extracted.quality || 'Unknown');
        let playlistIntel = null;
        if (/\.m3u8(?:$|[?#])/i.test(String(extracted.url || ''))) {
            playlistIntel = await probePlaylistIntelligence(http, extracted.url, {
                headers: extracted.headers || {},
                timeout: Number.parseInt(process.env.GUARDASERIETV_PLAYLIST_TIMEOUT_MS || '5000', 10) || 5000,
                signal
            }).catch(() => null);
            quality = pickBetterQuality(playlistIntel?.quality || 'Unknown', quality);
        }

        let stream = buildWebStream({
            name: `${PROVIDER_LABEL} | ${extracted.name || def.label}`,
            title: `${title}\n${extracted.name || def.label} ITA`,
            url: extracted.url,
            extractor: extracted.name || def.label,
            provider: PROVIDER_LABEL,
            providerCode: PROVIDER_CODE,
            quality,
            headers: extracted.headers,
            extra: { _priority: link.priority ?? extracted.priority ?? def.priority ?? 9 }
        });
        stream = decorateStreamWithPlaylistIntelligence(stream, playlistIntel);
        return stream;
    });

    return normalizeStreams(streams
        .filter(Boolean)
        .sort((a, b) => {
            const pDelta = (a.extra?._priority ?? 9) - (b.extra?._priority ?? 9);
            const qDelta = qualityRank(b.quality) - qualityRank(a.quality);
            return pDelta || qDelta;
        })
        .filter((stream, index, arr) => arr.findIndex((item) => item.url === stream.url) === index)
        .map((stream) => {
            if (stream.extra) delete stream.extra._priority;
            delete stream._priority;
            return stream;
        }), {
            provider: PROVIDER_ID,
            providerLabel: PROVIDER_LABEL,
            providerCode: PROVIDER_CODE,
            sort: false,
            debug: DEBUG
        });
}

function isSeriesRequest(meta = {}) {
    const type = String(meta.type || '').toLowerCase();
    return meta.isSeries === true || type === 'series' || type === 'tv' || Boolean(meta.season || meta.episode || /:\d+:\d+/.test(String(meta.id || meta.imdb_id || '')));
}

async function searchGuardaserieTvImpl(meta = {}, config = {}, reqHost = null) {
    if (!config?.filters?.enableGstv) return [];
    if (!isSeriesRequest(meta)) return [];

    const season = Number.parseInt(meta.season, 10);
    const episode = Number.parseInt(meta.episode, 10);
    if (!Number.isInteger(season) || season < 1 || !Number.isInteger(episode) || episode < 1) return [];

    const cacheKey = `streams:${meta.imdb_id || meta.imdbId || meta.id || meta.tmdb_id || meta.tmdbId}:${season}:${episode}`;
    const cached = cache.streams.get(cacheKey);
    if (cached) return cached;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.max(TIMEOUT_MS + 3000, 15000));

    try {
        const expectedTitles = await getExpectedTitles(meta);
        if (!expectedTitles.length) return [];
        const page = await findSeriesPage(meta, expectedTitles, controller.signal);
        let pageUrl = page?.url || BASE_URL;
        let pageHtml = page?.html || '';
        let pageTitle = page?.title || expectedTitles[0];
        if (!page?.html || !page?.url) {
            log('series page not found; trying imdb vidxgo direct', { title: expectedTitles[0], season, episode, imdb: getMetaImdbId(meta) });
            pageHtml = '';
            pageUrl = BASE_URL;
        }

        const vidxgoEpisodeLinks = buildVidxgoEpisodeLinks(pageHtml, meta, season, episode);
        const parsedEpisodeLinks = pageHtml ? parseEpisodeLinks(pageHtml, season, episode, pageUrl) : [];
        const episodeLinks = Array.from(new Map([...vidxgoEpisodeLinks, ...parsedEpisodeLinks]
            .sort((a, b) => (a.priority ?? 9) - (b.priority ?? 9))
            .map((link) => [link.url, link]))
            .values())
            .slice(0, MAX_EMBEDS);
        if (!episodeLinks.length) {
            log('episode links not found', { page: pageUrl, season, episode, imdb: getMetaImdbId(meta) });
            cache.streams.set(cacheKey, [], 60_000, 60_000);
            return [];
        }

        const displayTitle = `${pageTitle || expectedTitles[0]} S${String(season).padStart(2, '0')}E${String(episode).padStart(2, '0')}`;
        const streams = await buildStreamsFromLinks(episodeLinks, {
            title: displayTitle,
            pageUrl,
            reqHost,
            signal: controller.signal
        });
        cache.streams.set(cacheKey, streams, streams.length ? STREAM_TTL_MS : 60_000, streams.length ? STREAM_TTL_MS : 60_000);
        return streams;
    } catch (error) {
        log('provider failed', { error: error?.message || String(error) });
        return [];
    } finally {
        clearTimeout(timer);
    }
}

async function searchGuardaserieTv(meta = {}, config = {}, reqHost = null) {
    return withProviderHealth(PROVIDER_ID, () => searchGuardaserieTvImpl(meta, config, reqHost), {
        timeoutMs: Math.max(15_000, TIMEOUT_MS + 5000),
        swallowErrors: true,
        fallbackValue: []
    });
}

module.exports = {
    searchGuardaserieTv,
    searchGuardaserieTV: searchGuardaserieTv,
    searchGuardaserie: searchGuardaserieTv,
    parseEpisodeLinks,
    extractLinksFromBlock,
    buildVidxgoEpisodeLinks,
    extractVidxgoBaseFromHtml,
    findSeriesPageByImdb,
    getBaseUrls
};
