const axios = require('axios');
const cheerio = require('cheerio');
const crypto = require('crypto');
const { GUARDA_SERIE_BROWSER_PROFILES, pickRandomProfile } = require('../../core/browser_profiles');

const GS_DOMAIN = 'https://guardoserie.team';
const TMDB_KEY = '5bae8d11f2a7bc7a95c6d040a31d2163';
const LOADM_KEY = Buffer.from('kiemtienmua911ca');
const LOADM_IV = Buffer.from('1234567890oiuytr');
const MIXDROP_REGEX = /mixdrop|m1xdrop|mxcontent/i;
const LOADM_REGEX = /loadm/i;
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
        /https?:\/\/(?:www\.)?(?:loadm|mixdrop|m1xdrop|mxcontent)[^"'<\s]+/ig,
        /https?:\\\/\\\/(?:www\\.)?(?:loadm|mixdrop|m1xdrop|mxcontent)[^"'<\s]+/ig
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

function decryptLoadmPayload(hexText) {
    const cleanedHex = String(hexText || '').replace(/[^0-9a-fA-F]/g, '');
    if (!cleanedHex) return null;

    const encryptedBytes = Buffer.from(cleanedHex, 'hex');
    const decipher = crypto.createDecipheriv('aes-128-cbc', LOADM_KEY, LOADM_IV);
    decipher.setAutoPadding(true);

    let decrypted = decipher.update(encryptedBytes);
    decrypted = Buffer.concat([decrypted, decipher.final()]);

    const plainText = decrypted.toString('utf8').trim();
    const lastBraceIndex = plainText.lastIndexOf('}');
    const cleanJson = lastBraceIndex !== -1 ? plainText.slice(0, lastBraceIndex + 1) : plainText;
    return JSON.parse(cleanJson);
}

async function extractLoadm(playerUrl, client) {
    try {
        const absolute = normalizePlayerLink(playerUrl);
        if (!absolute) return null;
        const parsed = new URL(absolute);
        const videoId = parsed.hash?.replace(/^#/, '').trim()
            || parsed.pathname.split('/e/').pop()?.trim()
            || parsed.searchParams.get('id')
            || parsed.searchParams.get('v');
        if (!videoId) return null;

        const apiUrl = `${parsed.origin}/api/v1/video?id=${encodeURIComponent(videoId)}&w=2560&h=1440&r=${encodeURIComponent(getTargetDomain())}`;
        const response = await client.get(apiUrl, {
            headers: {
                'User-Agent': getStealthHeaders()['User-Agent'],
                'Referer': `${parsed.origin}/`,
                'X-Requested-With': 'XMLHttpRequest',
                'Accept': 'application/json, text/plain, */*'
            },
            responseType: 'text'
        });

        const payload = decryptLoadmPayload(typeof response.data === 'string' ? response.data : String(response.data || ''));
        const streamUrl = payload?.source || payload?.cf || null;
        if (!streamUrl) return null;

        return {
            url: streamUrl,
            headers: {
                Referer: `${parsed.origin}/`,
                Origin: parsed.origin
            },
            name: 'LoadM',
            priority: 0
        };
    } catch (_) {
        return null;
    }
}

function unpackDeanEdwards(html) {
    if (!html || typeof html !== 'string') return null;
    try {
        const packedMatch = html.match(/eval\(function\(p,a,c,k,e,?[rd]?\).*?\}\('(.*?)',\s*(\d+),\s*(\d+),\s*'([^']+)'\.split\('\|'\).*?\)\)/s);
        if (!packedMatch) return null;

        let [_, p, a, c, k] = packedMatch;
        a = parseInt(a, 10);
        c = parseInt(c, 10);
        k = k.split('|');

        const e = (n) => {
            const alphabet = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';
            if (n === 0) return alphabet[0];
            let res = '';
            while (n > 0) {
                res = alphabet[n % a] + res;
                n = Math.floor(n / a);
            }
            return res;
        };

        let unpacked = p;
        for (let i = c - 1; i >= 0; i -= 1) {
            if (!k[i]) continue;
            unpacked = unpacked.replace(new RegExp(`\\b${e(i)}\\b`, 'g'), k[i]);
        }
        return unpacked;
    } catch (_) {
        return null;
    }
}

async function extractMixdrop(url, client) {
    try {
        const absolute = normalizePlayerLink(url);
        if (!absolute) return null;
        const res = await client.get(absolute, { headers: getStealthHeaders(`${new URL(absolute).origin}/`) });
        const html = typeof res.data === 'string' ? res.data : '';
        const regex = /(?:MDCore|Core|wurl)\s*(?:\.wurl)?\s*=\s*["']([^"']+)["']/;

        let linkMatch = html.match(regex);
        if (!linkMatch) {
            const unpacked = unpackDeanEdwards(html);
            linkMatch = unpacked ? unpacked.match(regex) : null;
        }
        if (!linkMatch?.[1]) return null;

        const finalUrl = linkMatch[1].startsWith('//') ? `https:${linkMatch[1]}` : linkMatch[1];
        return {
            url: finalUrl,
            headers: {
                Referer: 'https://m1xdrop.net/',
                Origin: 'https://m1xdrop.net'
            },
            name: 'MixDrop',
            priority: 1
        };
    } catch (_) {
        return null;
    }
}

async function processHoster(videoLink, client, cleanTitle) {
    if (!videoLink) return null;
    const lower = String(videoLink).toLowerCase();

    const extracted = LOADM_REGEX.test(lower)
        ? await extractLoadm(videoLink, client)
        : MIXDROP_REGEX.test(lower)
            ? await extractMixdrop(videoLink, client)
            : null;

    if (!extracted?.url) return null;

    return {
        url: extracted.url,
        name: `🍿 GuardoSerie | ${extracted.name}`,
        title: `${cleanTitle}
☁️ ${extracted.name} • 🇮🇹 ITA`,
        extractor: extracted.name,
        behaviorHints: {
            ...(extracted.headers ? { proxyHeaders: { request: extracted.headers } } : {}),
            extractor: extracted.name
        },
        _priority: extracted.priority ?? 9
    };
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
        .sort((a, b) => (a._priority || 9) - (b._priority || 9));

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
