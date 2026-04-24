const axios = require('axios');
const cheerio = require('cheerio');
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

const GS_DOMAIN = 'https://guardoserie.garden';
const TMDB_KEY = '5bae8d11f2a7bc7a95c6d040a31d2163';
const BROWSER_PROFILES = GUARDA_SERIE_BROWSER_PROFILES;

function getTargetDomain() {
    return GS_DOMAIN;
}

function getStealthHeaders(referer) {
    const profile = pickRandomProfile(BROWSER_PROFILES);
    const headers = {
        'User-Agent': profile.ua,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
        'Accept-Language': 'it-IT,it;q=0.9,en-US;q=0.8,en;q=0.7',
        'Referer': referer || `${GS_DOMAIN}/`
    };
    if (profile.sec_ch_ua) headers['sec-ch-ua'] = profile.sec_ch_ua;
    return headers;
}

function createClient() {
    return axios.create({
        timeout: 12000,
        httpAgent: false,
        httpsAgent: false,
        proxy: false,
        maxRedirects: 5,
        validateStatus: (status) => status >= 200 && status < 400
    });
}

function normalizeText(value) {
    return String(value || '')
        .normalize('NFKD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .replace(/&amp;/g, '&')
        .replace(/[^a-z0-9]+/g, ' ')
        .replace(/\b(the|a|an|un|una|il|lo|la|gli|le|di|de|del|della|serie|stagione|season|episodio|episode)\b/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function slugify(value) {
    return String(value || '')
        .normalize('NFKD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '');
}

async function resolveExtractedQuality(client, extracted) {
    let quality = normalizeQuality(extracted?.quality || 'Unknown');
    if (!/\.m3u8($|\?)/i.test(String(extracted?.url || ''))) return quality;

    try {
        const probed = await probePlaylistQuality(client, extracted.url, {
            headers: extracted?.headers || {},
            timeout: 5000
        });
        quality = pickBetterQuality(probed || 'Unknown', quality);
    } catch (_) {}

    return quality;
}

function normalizeTitleScore(candidate, title, originalTitle) {
    const cand = normalizeText(candidate);
    const primary = normalizeText(title);
    const secondary = normalizeText(originalTitle);
    if (!cand) return 0;
    if (cand === primary || (secondary && cand === secondary)) return 3;
    if ((primary && (cand.includes(primary) || primary.includes(cand))) || (secondary && (cand.includes(secondary) || secondary.includes(cand)))) return 2;
    const candTokens = new Set(cand.split(' ').filter(Boolean));
    const titleTokens = Array.from(new Set(`${primary} ${secondary}`.trim().split(' ').filter(Boolean)));
    if (titleTokens.length === 0) return 0;
    let hits = 0;
    for (const token of titleTokens) {
        if (candTokens.has(token)) hits += 1;
    }
    const ratio = hits / titleTokens.length;
    if (ratio >= 0.75) return 2;
    if (ratio >= 0.45) return 1;
    return 0;
}

async function getTmdbIdFromImdb(imdbId, type, client) {
    if (!/^tt\d+$/i.test(String(imdbId || '').trim())) return null;
    try {
        const url = `https://api.themoviedb.org/3/find/${encodeURIComponent(imdbId)}?api_key=${TMDB_KEY}&external_source=imdb_id`;
        const response = await client.get(url, { timeout: 5000 });
        if (type === 'tv' || type === 'series') {
            const id = response.data?.tv_results?.[0]?.id;
            return id ? String(id) : null;
        }
        const id = response.data?.movie_results?.[0]?.id;
        return id ? String(id) : null;
    } catch (_) {
        return null;
    }
}

function resolveMetaTmdbId(meta) {
    const direct = String(meta?.tmdb_id || meta?.tmdbId || '').trim();
    if (/^\d+$/.test(direct)) return direct;

    const metaId = String(meta?.id || '').trim();
    const match = metaId.match(/^tmdb:(\d+)/i);
    return match ? match[1] : null;
}

async function getShowInfo(meta, client) {
    const type = meta?.isSeries ? 'tv' : 'movie';
    const directTmdbId = resolveMetaTmdbId(meta);
    const tmdbId = directTmdbId || await getTmdbIdFromImdb(meta?.imdb_id, type, client);
    if (!tmdbId) return null;

    try {
        const url = `https://api.themoviedb.org/3/${type === 'tv' ? 'tv' : 'movie'}/${tmdbId}?api_key=${TMDB_KEY}&language=it-IT`;
        const response = await client.get(url, { timeout: 5000 });
        const data = response.data;
        if (!data) return null;
        return {
            tmdbId,
            title: data.name || data.title || meta?.title || null,
            originalTitle: data.original_name || data.original_title || null,
            year: String(data.first_air_date || data.release_date || '').slice(0, 4) || null
        };
    } catch (_) {
        return null;
    }
}

function extractSearchResultsFromHtml(html, baseUrl) {
    const $ = cheerio.load(String(html || ''));
    const results = [];
    const seen = new Set();

    const pushResult = (href, text) => {
        if (!href) return;
        let absolute = null;
        try {
            absolute = new URL(href, baseUrl).toString();
        } catch (_) {
            return;
        }
        if (seen.has(absolute)) return;
        seen.add(absolute);
        results.push({ url: absolute, title: String(text || '').trim() || absolute });
    };

    $('a[href]').each((_, element) => {
        const anchor = $(element);
        const href = anchor.attr('href');
        if (!href || !/\/(serie|episodio)\//i.test(href)) return;
        const text = anchor.attr('title') || anchor.text() || '';
        pushResult(href, text);
    });

    return results;
}

async function searchProvider(query, client) {
    const baseUrl = getTargetDomain();
    const searchUrl = `${baseUrl}/wp-admin/admin-ajax.php`;
    const body = `s=${encodeURIComponent(query)}&action=searchwp_live_search&swpengine=default&swpquery=${encodeURIComponent(query)}`;

    try {
        const ajaxRes = await client.post(searchUrl, body, {
            headers: {
                ...getStealthHeaders(`${baseUrl}/`),
                'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
                'Origin': baseUrl,
                'X-Requested-With': 'XMLHttpRequest'
            }
        });
        const ajaxResults = extractSearchResultsFromHtml(ajaxRes.data, baseUrl);
        if (ajaxResults.length > 0) return ajaxResults;
    } catch (_) {}

    try {
        const fallbackRes = await client.get(`${baseUrl}/?s=${encodeURIComponent(query)}`, {
            headers: getStealthHeaders(`${baseUrl}/`)
        });
        return extractSearchResultsFromHtml(fallbackRes.data, baseUrl);
    } catch (_) {
        return [];
    }
}

async function tryFetchPageHtml(url, client) {
    try {
        const res = await client.get(url, { headers: getStealthHeaders(`${getTargetDomain()}/`) });
        return typeof res.data === 'string' ? res.data : null;
    } catch (_) {
        return null;
    }
}

function htmlMatchesTitle(html, title, originalTitle) {
    const raw = String(html || '');
    const candidates = [
        raw.match(/<meta[^>]*property=["']og:title["'][^>]*content=["']([^"']+)["']/i)?.[1],
        raw.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]
    ].filter(Boolean);
    for (const candidate of candidates) {
        if (normalizeTitleScore(candidate, title, originalTitle) >= 2) return true;
    }
    return false;
}

async function guessUrlFromSlug(title, originalTitle, client) {
    const baseUrl = getTargetDomain();
    const slugs = Array.from(new Set([
        slugify(title),
        slugify(originalTitle)
    ].filter(Boolean)));

    const candidates = [];
    for (const slug of slugs) {
        candidates.push(`${baseUrl}/serie/${slug}/`);
        candidates.push(`${baseUrl}/${slug}/`);
        candidates.push(`${baseUrl}/serietv/${slug}/`);
    }

    for (const url of candidates) {
        const html = await tryFetchPageHtml(url, client);
        if (html && htmlMatchesTitle(html, title, originalTitle)) return { url, html };
    }

    return null;
}

function extractEpisodeUrlFromSeriesPage(pageHtml, season, episode) {
    const raw = String(pageHtml || '');
    const seasonIndex = Number.parseInt(String(season || ''), 10) - 1;
    const episodeIndex = Number.parseInt(String(episode || ''), 10) - 1;
    if (!Number.isInteger(seasonIndex) || !Number.isInteger(episodeIndex) || seasonIndex < 0 || episodeIndex < 0) {
        return null;
    }

    const seasonBlocks = raw.split(/class=['"]les-content['"]/i);
    if (seasonBlocks.length > seasonIndex + 1) {
        const targetSeasonBlock = seasonBlocks[seasonIndex + 1];
        const blockEnd = targetSeasonBlock.indexOf('</div>');
        const cleanBlock = blockEnd !== -1 ? targetSeasonBlock.substring(0, blockEnd) : targetSeasonBlock;
        const episodeRegex = /<a[^>]+href=['"]([^'"]+)['"][^>]*>/g;
        const episodes = [];
        let match;
        while ((match = episodeRegex.exec(cleanBlock)) !== null) {
            if (match[1] && /\/episodio\//i.test(match[1])) episodes.push(match[1]);
        }
        if (episodes.length > episodeIndex) return episodes[episodeIndex];
    }

    const explicitRegex = new RegExp(`https?:\\/\\/[^"'\\s]+\\/episodio\\/[^"'\\s]*stagione-${season}-episodio-${episode}[^"'\\s]*`, 'i');
    const explicitMatch = raw.match(explicitRegex);
    return explicitMatch?.[0] || null;
}

function normalizePlayerLink(link) {
    if (!link) return null;
    let normalized = String(link).trim().replace(/&amp;/g, '&').replace(/\\\//g, '/');
    if (!normalized || normalized.startsWith('data:')) return null;
    if (normalized.startsWith('//')) normalized = `https:${normalized}`;
    else if (normalized.startsWith('/')) normalized = `${getTargetDomain()}${normalized}`;
    else if (!/^https?:\/\//i.test(normalized) && /(loadm|mixdrop|m1xdrop|mxcontent)/i.test(normalized)) normalized = `https://${normalized.replace(/^\/+/, '')}`;
    return /^https?:\/\//i.test(normalized) ? normalized : null;
}

function extractPlayerLinksFromHtml(html) {
    const raw = String(html || '');
    const links = new Set();
    const iframeTags = raw.match(/<iframe\b[^>]*>/ig) || [];

    for (const tag of iframeTags) {
        const attrRegex = /\b(?:data-src|src)\s*=\s*(['"])(.*?)\1/ig;
        let attrMatch;
        while ((attrMatch = attrRegex.exec(tag)) !== null) {
            const candidate = normalizePlayerLink(attrMatch[2]);
            if (candidate) links.add(candidate);
        }
    }

    const directRegexes = [
        new RegExp(HOSTER_DIRECT_LINK_PATTERN, 'ig'),
        new RegExp(HOSTER_ESCAPED_DIRECT_LINK_PATTERN, 'ig')
    ];

    for (const regex of directRegexes) {
        const matches = raw.match(regex) || [];
        for (const match of matches) {
            const candidate = normalizePlayerLink(match);
            if (candidate) links.add(candidate);
        }
    }

    return Array.from(links);
}

async function processHoster(videoLink, client, cleanTitle) {
    if (!videoLink) return null;
    const providerHeaders = getStealthHeaders(`${getTargetDomain()}/`);
    const extracted = await extractFromUrl(videoLink, {
        client,
        userAgent: providerHeaders['User-Agent'],
        requestReferer: getTargetDomain()
    });
    if (!extracted?.url) return null;
    const quality = await resolveExtractedQuality(client, extracted);

    return buildWebStream({
        name: `🍿 GuardoSerie | ${extracted.name}`,
        title: `${cleanTitle}
☁️ ${extracted.name} • 🇮🇹 ITA`,
        url: extracted.url,
        extractor: extracted.name,
        provider: 'GuardoSerie',
        providerCode: 'GS',
        quality,
        headers: extracted.headers,
        extra: {
            _priority: extracted.priority ?? 9
        }
    });
}

async function searchGuardaserie(meta, config) {
    if (!meta?.isSeries) return [];
    if (!config?.filters?.enableGs) return [];

    const season = Number.parseInt(String(meta?.season || ''), 10);
    const episode = Number.parseInt(String(meta?.episode || ''), 10);
    if (!Number.isInteger(season) || season < 1 || !Number.isInteger(episode) || episode < 1) return [];

    const client = createClient();
    const showInfo = await getShowInfo(meta, client);
    const showName = showInfo?.title || meta?.title || null;
    const originalTitle = showInfo?.originalTitle || null;
    const targetYear = showInfo?.year || null;
    if (!showName) return [];

    let allResults = [];
    const queries = Array.from(new Set([showName, originalTitle].filter(Boolean)));
    for (const query of queries) {
        const results = await searchProvider(query, client);
        allResults.push(...results);
    }

    allResults = Array.from(new Map(allResults.map((item) => [item.url, item])).values());
    allResults.sort((a, b) => normalizeTitleScore(b.title, showName, originalTitle) - normalizeTitleScore(a.title, showName, originalTitle));

    let target = null;
    let bestLoose = null;
    let bestLooseScore = 0;

    for (const result of allResults.slice(0, 10)) {
        const titleScore = normalizeTitleScore(result.title, showName, originalTitle);
        if (titleScore < 1) continue;

        const html = await tryFetchPageHtml(result.url, client);
        if (!html) continue;

        const yearCandidates = [
            html.match(/release-year\/(\d{4})/i)?.[1],
            html.match(/\b(19\d{2}|20\d{2})\b/)?.[1]
        ].filter(Boolean);
        const foundYear = yearCandidates[0] || null;

        if (targetYear && foundYear) {
            const diff = Math.abs(Number(foundYear) - Number(targetYear));
            const allowedDiff = titleScore >= 2 ? 10 : 1;
            if (diff <= allowedDiff) {
                target = { url: result.url, html };
                break;
            }
        } else if (titleScore >= bestLooseScore) {
            bestLooseScore = titleScore;
            bestLoose = { url: result.url, html };
            if (titleScore >= 2) break;
        }
    }

    if (!target && bestLoose) target = bestLoose;
    if (!target) target = await guessUrlFromSlug(showName, originalTitle, client);
    if (!target?.url) return [];

    let episodeUrl = extractEpisodeUrlFromSeriesPage(target.html, season, episode);
    if (!episodeUrl) {
        const refreshedHtml = await tryFetchPageHtml(target.url, client);
        episodeUrl = extractEpisodeUrlFromSeriesPage(refreshedHtml, season, episode);
    }
    if (!episodeUrl) return [];

    const absoluteEpisodeUrl = new URL(episodeUrl, getTargetDomain()).toString();
    const finalHtml = await tryFetchPageHtml(absoluteEpisodeUrl, client);
    if (!finalHtml) return [];

    const playerLinks = Array.from(new Set(extractPlayerLinksFromHtml(finalHtml)));
    if (playerLinks.length === 0) return [];

    const cleanTitle = `${showName} S${String(season).padStart(2, '0')}E${String(episode).padStart(2, '0')}`;
    const processed = await Promise.allSettled(playerLinks.slice(0, 8).map((link) => processHoster(link, client, cleanTitle)));
    const results = processed
        .filter((entry) => entry.status === 'fulfilled' && entry.value)
        .map((entry) => entry.value)
        .sort((a, b) => {
            const qualityDelta = qualityRank(b.quality) - qualityRank(a.quality);
            if (qualityDelta !== 0) return qualityDelta;
            return (a._priority || 9) - (b._priority || 9);
        });

    const streams = [];
    const seen = new Set();
    for (const stream of results) {
        if (!stream?.url || seen.has(stream.url)) continue;
        seen.add(stream.url);
        delete stream._priority;
        streams.push(stream);
    }

    return streams;
}

module.exports = { searchGuardaserie, searchGuardoSerie: searchGuardaserie };
