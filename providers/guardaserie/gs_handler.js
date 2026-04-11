const axios = require('axios');
const cheerio = require('cheerio');
const { GUARDA_SERIE_BROWSER_PROFILES, pickRandomProfile } = require('../../core/browser_profiles');

const GS_DOMAIN = "https://guardaserietv.skin";
const TMDB_KEY = "5bae8d11f2a7bc7a95c6d040a31d2163";

const BROWSER_PROFILES = GUARDA_SERIE_BROWSER_PROFILES;

function getTargetDomain() {
    return GS_DOMAIN;
}

function getStealthHeaders(referer) {
    const profile = pickRandomProfile(BROWSER_PROFILES);
    const headers = {
        "User-Agent": profile.ua,
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
        "Referer": referer || `${GS_DOMAIN}/`
    };
    if (profile.sec_ch_ua) headers["sec-ch-ua"] = profile.sec_ch_ua;
    return headers;
}

function createClient() {
    return axios.create({
        timeout: 8000,
        httpAgent: false,
        httpsAgent: false,
        proxy: false,
        validateStatus: status => status >= 200 && status < 400
    });
}

async function getTmdbFromImdb(imdbId, client) {
    if (!imdbId || !imdbId.startsWith("tt")) return imdbId;
    
    try {
        const url = `https://api.themoviedb.org/3/find/${imdbId}?api_key=${TMDB_KEY}&external_source=imdb_id`;
        const response = await client.get(url, { timeout: 5000 });
        const data = response.data;
        if (data?.movie_results?.length > 0) return data.movie_results[0].id.toString();
        if (data?.tv_results?.length > 0) return data.tv_results[0].id.toString();
    } catch (e) {}

    try {
        const urlMovie = `https://www.themoviedb.org/movie/${imdbId}`;
        const respMovie = await client.get(urlMovie, { timeout: 10000 });
        const finalUrlM = respMovie.request?.res?.responseUrl || respMovie.config?.url || "";
        let match = finalUrlM.match(/\/movie\/(\d+)/);
        if (match) return match[1];

        const urlTv = `https://www.themoviedb.org/tv/${imdbId}`;
        const respTv = await client.get(urlTv, { timeout: 10000 });
        const finalUrlTv = respTv.request?.res?.responseUrl || respTv.config?.url || "";
        match = finalUrlTv.match(/\/tv\/(\d+)/);
        if (match) return match[1];
    } catch (e) {}
    
    return null;
}

async function getMediaInfo(tmdbId, type, client) {
    try {
        const url = `https://api.themoviedb.org/3/${type}/${tmdbId}?api_key=${TMDB_KEY}&language=it-IT`;
        const response = await client.get(url, { timeout: 5000 });
        const data = response.data;
        if (!data) return { title: null, date: null };
        
        if (type === 'movie') {
            return { title: data.title, date: data.release_date ? data.release_date.substring(0, 4) : '' };
        } else {
            return { title: data.name, date: data.first_air_date ? data.first_air_date.substring(0, 4) : '' };
        }
    } catch (e) {
        return { title: null, date: null };
    }
}

function slugify(value) {
    if (!value) return "";
    return value.toString().toLowerCase().trim()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '');
}


function unpackDeanEdwards(html, regexPattern) {
    if (!html || typeof html !== 'string') return null;
    try {
        const packedMatch = html.match(/eval\(function\(p,a,c,k,e,?[rd]?\).*?\}\('(.*?)',\s*(\d+),\s*(\d+),\s*'([^']+)'\.split\('\|'\).*?\)\)/s);
        if (!packedMatch) return null;

        let [_, p, a, c, k] = packedMatch;
        a = parseInt(a, 10);
        c = parseInt(c, 10);
        k = k.split('|');

        const e = (n) => {
            const alphabet = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";
            if (n === 0) return alphabet[0];
            let res = "";
            while (n > 0) {
                res = alphabet[n % a] + res;
                n = Math.floor(n / a);
            }
            return res;
        };

        let unpacked = p;
        for (let i = c - 1; i >= 0; i--) {
            if (k[i]) {
                const regex = new RegExp(`\\b${e(i)}\\b`, 'g');
                unpacked = unpacked.replace(regex, k[i]);
            }
        }

        if (!regexPattern) return unpacked;
        const extracted = unpacked.match(regexPattern);
        if (extracted) return extracted[1];
        
    } catch (e) {}
    return null;
}


function deobfuscateSupervideo(htmlText) {
    const MAX_HTML_SIZE = 512000;
    let truncated = htmlText.length > MAX_HTML_SIZE ? htmlText.substring(0, MAX_HTML_SIZE) : htmlText;

    const signals = /eval\(|\\x|atob\(|decode\(|\.m3u8|\.mp4|}\(\s*['"].*?['"]\s*,\s*\d+\s*,\s*\d+\s*,\s*['"](.*?)['"]\s*\.split|}\(\s*['"].*?['"]\s*,\s*\d+\s*,\s*\d+\s*,\s*\[(.*?)\]/;
    if (!signals.test(truncated)) return truncated;

    let layers = [];
    let seen = new Set();

    const append = (chunk) => {
        if (chunk && !seen.has(chunk)) {
            seen.add(chunk);
            layers.push(chunk);
        }
    };

    append(truncated);

    const encodeBase = (cVal, aVal) => {
        if (cVal === 0) return "0";
        const chars = "0123456789abcdefghijklmnopqrstuvwxyz";
        let res = [];
        while (cVal > 0) {
            let digit = cVal % aVal;
            res.push(digit > 35 ? String.fromCharCode(digit + 29) : chars[digit]);
            cVal = Math.floor(cVal / aVal);
        }
        return res.reverse().join('');
    };

    const regexes = [
        /}\(\s*['"](.*?)['"]\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*['"]([^'"]+)['"]\s*\.split/g,
        /}\(\s*['"](.*?)['"]\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*\[([^\]]+)\]/g
    ];

    for (let r = 0; r < regexes.length; r++) {
        let isArray = (r === 1);
        let match;
        while ((match = regexes[r].exec(truncated)) !== null) {
            try {
                let p = match[1], a = parseInt(match[2], 10), c = parseInt(match[3], 10), kRaw = match[4];
                if (a < 2) continue;

                let k = isArray ? kRaw.split(',').map(s => s.trim().replace(/^['"]|['"]$/g, '')) : kRaw.split('|');
                let limit = Math.min(c, k.length, 2048);
                let replacements = {};
                
                for (let i = 0; i < limit; i++) {
                    if (k[i]) replacements[encodeBase(i, a)] = k[i];
                }

                if (Object.keys(replacements).length === 0) continue;

                let orderedTokens = Object.keys(replacements).sort((x, y) => y.length - x.length);
                let tokensPattern = new RegExp("\\b(" + orderedTokens.map(tok => tok.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|') + ")\\b", "g");

                let unpacked = p.replace(tokensPattern, (m) => replacements[m] || m);
                append(unpacked);
            } catch (e) {}
        }
    }

    let combined = layers.join("\n");

    if (combined.includes("\\x")) {
        try {
            append(combined.replace(/\\x([0-9a-fA-F]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16))));
        } catch (e) {}
    }

    const b64Regex = /(?:atob|decode)\s*\(\s*["']([A-Za-z0-9+/=]{16,})["']/g;
    let b64Match;
    while ((b64Match = b64Regex.exec(combined)) !== null) {
        try {
            let decoded = Buffer.from(b64Match[1], 'base64').toString('utf-8');
            if (decoded && (decoded.includes("http") || decoded.includes(".m3u8") || decoded.includes(".mp4"))) {
                append(decoded);
            }
        } catch (e) {}
    }

    const concatRegex = /["'](https?:\/\/[^"']*)["']\s*\+\s*["']([^"']*)["']/gi;
    let concatMatch;
    while ((concatMatch = concatRegex.exec(combined)) !== null) {
        let joined = concatMatch[1] + concatMatch[2];
        if (joined.includes(".m3u8") || joined.includes(".mp4")) {
            append(joined);
        }
    }

    const evalRegex = /eval\s*\(\s*([^)]{1,2000})\s*\)/gi;
    let evalMatch;
    while ((evalMatch = evalRegex.exec(truncated)) !== null) {
        let inner = evalMatch[1].trim().replace(/^['"]|['"]$/g, '');
        if (inner.includes("http") || inner.includes(".m3u8") || inner.includes(".mp4")) {
            append(inner);
        }
    }

    return layers.join("\n");
}

function extractAllMediaUrls(text, baseUrl) {
    const found = [];
    const seen = new Set();

    const normalizeUrl = (candidate) => {
        if (!candidate) return "";
        let url = candidate.replace(/\\\//g, '/').trim().replace(/^['"]|['"]$/g, '');
        if (!url) return "";
        if (url.startsWith("//")) return `https:${url}`;
        if (url.startsWith("/")) return baseUrl ? `${baseUrl}${url}` : url;
        if (!url.startsWith("http") && baseUrl) return `${baseUrl}/${url}`;
        return url;
    };

    const add = (candidate) => {
        let normalized = normalizeUrl(candidate);
        if (normalized && !seen.has(normalized)) {
            seen.add(normalized);
            found.push(normalized);
        }
    };

    const patterns = [
        /sources\s*:\s*\[\s*\{[^}]*?file\s*:\s*["']([^"']+)["']/gi,
        /file\s*:\s*["']((?:https?:)?\/\/[^"']+\.m3u8(?:\?[^"']*)?)["']/gi,
        /src\s*[:=]\s*["']((?:https?:)?\/\/[^"']+\.m3u8(?:\?[^"']*)?)["']/gi,
        /(?:player|video)\.src\s*\(\s*["']([^"']+\.m3u8[^"']*)["']/gi,
        /setup\s*\(\s*\{[^}]*?(?:file|src)\s*:\s*["']([^"']+\.m3u8[^"']*)["']/gis
    ];

    for (const pattern of patterns) {
        let match;
        pattern.lastIndex = 0;
        while ((match = pattern.exec(text)) !== null) {
            add(match[1]);
            if (found.length >= 3) return found;
        }
    }

    const hfsMatch = /(hfs\d+)/i.exec(text);
    const domainMatch = /(serversicuro|securecloud|securevid)\.\w+/i.exec(text);
    if (hfsMatch && domainMatch) {
        const host = `${hfsMatch[1]}.${domainMatch[0]}`;
        const urlsetRegex = /(?<=,)([a-zA-Z0-9_]+)(?=\.urlset)/g;
        let match;
        while ((match = urlsetRegex.exec(text)) !== null) {
            add(`https://${host}/hls/${match[1]},.urlset/master.m3u8`);
            if (found.length >= 3) return found;
        }
    }

    const mp4Regex = /(?:file|src|source)\s*[:=]\s*["']((?:https?:)?\/\/[^"']+\.mp4(?:\?[^"']*)?)["']/ig;
    let mp4Match;
    while ((mp4Match = mp4Regex.exec(text)) !== null) {
        add(mp4Match[1]);
        if (found.length >= 3) return found;
    }

    const globalRegex = /((?:https?:)?\/\/[^\s"'<>]+\.m3u8(?:\?[^\s"'<>]*)?)/ig;
    let globalMatch;
    while ((globalMatch = globalRegex.exec(text)) !== null) {
        add(globalMatch[1]);
        if (found.length >= 3) return found;
    }

    return found;
}

function normalizeEmbedUrl(url) {
    let normalized = url.trim();
    if (normalized.startsWith("//")) normalized = `https:${normalized}`;
    ['/v/', '/f/', '/d/', '/w/'].forEach(old => {
        normalized = normalized.replace(old, '/e/');
    });
    return normalized;
}

async function extractSupervideo(url, client) {
    try {
        const embedUrl = normalizeEmbedUrl(url);
        const urlObj = new URL(embedUrl);
        
        const id = urlObj.pathname.split('/').pop().replace(/\.html|embed-|\/k\//gi, '');
        const targetUrl = `${urlObj.origin}/e/${id}`;
        
        const fp = getStealthHeaders();
        const customHeaders = { 
            'Referer': `${urlObj.origin}/`, 
            'Origin': urlObj.origin,
            'User-Agent': fp['User-Agent'],
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'Upgrade-Insecure-Requests': '1'
        };

        const fetchWorker = async (target) => {
            const workerUrl = `https://still-mode-fd28.quelladiprova96.workers.dev/?url=${encodeURIComponent(target)}`;
            const res = await client.get(workerUrl, { headers: customHeaders, timeout: 12000 });
            return res.data;
        };

        let html = await fetchWorker(targetUrl);
        if (!html || typeof html !== 'string') return null;

        if (html.includes('watched as embed only')) {
            html = await fetchWorker(`${urlObj.origin}/e${urlObj.pathname}`);
        }
        if (!html || typeof html !== 'string') return null;

        const fullText = deobfuscateSupervideo(html);
        const mediaUrls = extractAllMediaUrls(fullText, urlObj.origin);

        if (mediaUrls && mediaUrls.length > 0) {

            return {
                url: mediaUrls[0],
                origin: urlObj.origin,
                userAgent: fp['User-Agent']
            };
        }
    } catch (e) {}
    return null;
}


async function extractDropload(url, client) {
    try {
        url = url.startsWith("//") ? `https:${url}` : url.replace("/e/", "/").replace("/d/", "/");
        const res = await client.get(url, { headers: getStealthHeaders(), timeout: 6000 });
        const html = res.data;
        if (!html || typeof html !== 'string') return null;
        
        const dlRegex = /sources:\s*\[\s*\{\s*file\s*:\s*["'](https?:\/\/[^"']+)["']/;
        const linkMatch = html.match(dlRegex);
        if (linkMatch) return linkMatch[1];
        
        const unpacked = unpackDeanEdwards(html, dlRegex);
        if (unpacked) return unpacked;
    } catch (e) {}
    return null;
}

async function extractMixdrop(url, client) {
    try {
        url = url.startsWith("//") ? `https:${url}` : url;
        const res = await client.get(url, { headers: getStealthHeaders(), timeout: 6000 });
        const html = res.data;
        if (!html || typeof html !== 'string') return null;
        
        const mixdropRegex = /(?:MDCore|Core|wurl)\s*(?:\.wurl)?\s*=\s*["']([^"']+)["']/;
        const linkMatch = html.match(mixdropRegex);
        if (linkMatch) return linkMatch[1].startsWith("//") ? `https:${linkMatch[1]}` : linkMatch[1];
        
        const unpackedHtml = unpackDeanEdwards(html);
        if (unpackedHtml && typeof unpackedHtml === 'string') {
            const unpackedMatch = unpackedHtml.match(mixdropRegex);
            if (unpackedMatch) return unpackedMatch[1].startsWith("//") ? `https:${unpackedMatch[1]}` : unpackedMatch[1];
        }
    } catch (e) {}
    return null;
}

async function processHoster(videoLink, client, cleanTitle) {
    if (!videoLink) return null;
    let mediaUrl = null, hostName = "Sconosciuto", priority = 9, headers = null;
    const vLinkLower = videoLink.toLowerCase();
    
    if (vLinkLower.includes("supervideo")) {
        hostName = "Supervideo"; priority = 1; 
        const svData = await extractSupervideo(videoLink, client);
        if (svData) {
            mediaUrl = svData.url;
            headers = { 
                "Referer": `${svData.origin}/`, 
                "Origin": svData.origin,
                "User-Agent": svData.userAgent
            };
        }
    } else if (vLinkLower.includes("dropload")) {
        hostName = "Dropload"; priority = 2; mediaUrl = await extractDropload(videoLink, client);
    } else if (vLinkLower.includes("mixdrop")) {
        hostName = "MixDrop"; priority = 3; mediaUrl = await extractMixdrop(videoLink, client);
    } else {
        return null;
    }

    if (mediaUrl) {
        return {
            url: mediaUrl,
            name: `🍿 GS | ${hostName}`,
            title: `${cleanTitle}\n☁️ ${hostName} • 🇮🇹 ITA`,
            behaviorHints: headers ? { proxyHeaders: { request: headers } } : {},
            _priority: priority
        };
    }
    return null;
}

async function checkCandidatePage(candUrl, cleanId, client) {
    try {
        const candRes = await client.get(candUrl, { headers: getStealthHeaders(), timeout: 6000 });
        if (candRes.status === 200 && typeof candRes.data === 'string') {
            const html = candRes.data;
            if (html.includes(cleanId) || html.includes("themoviedb.org/tv/") || html.includes('class="mirrors"')) {
                return { url: candUrl, html: html };
            }
        }
    } catch (e) {}
    return null;
}

async function getFirstValidCandidate(tasks) {
    return new Promise((resolve) => {
        let pending = tasks.length;
        let resolved = false;
        if (pending === 0) resolve(null);
        tasks.forEach(task => {
            task.then(res => {
                if (res && res.url && !resolved) {
                    resolved = true;
                    resolve(res);
                } else {
                    pending--;
                    if (pending === 0 && !resolved) resolve(null);
                }
            }).catch(() => {
                pending--;
                if (pending === 0 && !resolved) resolve(null);
            });
        });
    });
}

function extractLinksAdvanced(html, season, episode) {
    if (!html || typeof html !== 'string') return [];
    try {
        const $ = cheerio.load(html);
        const links = new Set();
        const epRegex = new RegExp(`\\b${season}x(?:${episode.toString().padStart(2, '0')}|${episode})\\b`, 'i');
        
        $('*').contents().filter((_, el) => el.type === 'text' && epRegex.test(el.data)).each((_, el) => {
            let parent = $(el).parent();
            for (let i = 0; i < 3; i++) {
                if (!parent || parent.length === 0) break;
                
                parent.find('[data-link]').each((_, tag) => {
                    const dl = $(tag).attr('data-link');
                    if (dl) links.add(dl);
                });
                parent.find('a[href]').each((_, tag) => {
                    const href = $(tag).attr('href');
                    if (href) {
                        const hrefLower = href.toLowerCase();
                        if (hrefLower.includes('supervideo') || hrefLower.includes('dropload') || hrefLower.includes('mixdrop')) {
                            links.add(href);
                        }
                    }
                });
                parent = parent.parent();
            }
        });
        return Array.from(links);
    } catch (e) {
        return [];
    }
}

async function searchGuardaserie(meta, config) {
    if (!meta || !meta.isSeries || !meta.imdb_id) return []; 
    if (!config?.filters?.enableGs) return [];

    const targetDomain = getTargetDomain();
    const client = createClient();
    
    const cleanId = meta.imdb_id;
    const season = parseInt(meta.season, 10);
    const episode = parseInt(meta.episode, 10);

    if (isNaN(season) || isNaN(episode)) return [];

    try {
        let showName = meta.title || "";
        
        if (cleanId.startsWith("tt")) {
            const tmdbId = await getTmdbFromImdb(cleanId, client);
            if (tmdbId) {
                const mediaInfo = await getMediaInfo(tmdbId, 'tv', client);
                if (mediaInfo?.title) {
                    showName = mediaInfo.title;
                }
            }
        }
        
        if (!showName || showName === meta.title) {
            try {
                const metaRes = await axios.get(`https://v3-cinemeta.strem.io/meta/series/${cleanId}.json`, { timeout: 4000 });
                if (metaRes.data?.meta?.name) {
                    showName = metaRes.data.meta.name;
                }
            } catch (e) {}
        }

        const cleanTitle = showName ? `${showName} S${season.toString().padStart(2, '0')}E${episode.toString().padStart(2, '0')}` : `S${season.toString().padStart(2, '0')}E${episode.toString().padStart(2, '0')}`;
        let pageUrl = null;
        let pageHtml = null;

        if (showName) {
            const slug = slugify(showName);
            if (slug) {
                const guesses = [
                    `${targetDomain}/serie/${slug}/`, 
                    `${targetDomain}/${slug}/`, 
                    `${targetDomain}/serietv/${slug}/`
                ];
                const tasks = guesses.map(url => checkCandidatePage(url, cleanId, client));
                const result = await getFirstValidCandidate(tasks);
                if (result) {
                    pageUrl = result.url;
                    pageHtml = result.html;
                }
            }
        }

        if (!pageUrl) {
            const query = encodeURIComponent(showName || cleanId);
            const searchUrl = `${targetDomain}/index.php?do=search&subaction=search&story=${query}`;
            try {
                const response = await client.get(searchUrl, { headers: getStealthHeaders(`${targetDomain}/`), timeout: 8000 });
                if (response.status === 200 && typeof response.data === 'string') {
                    const $ = cheerio.load(response.data);
                    const candidates = [];
                    
                    $('.mlnh-2').each((_, div) => {
                        const aTag = $(div).find('h2 a');
                        const href = aTag.attr('href');
                        const title = aTag.attr('title') || "";
                        if (href && !title.toUpperCase().includes('[SUB ITA]')) {
                            candidates.push(href.startsWith('/') ? `${targetDomain}${href}` : href);
                        }
                    });
                    
                    if (candidates.length > 0) {
                        const tasks = candidates.map(url => checkCandidatePage(url, cleanId, client));
                        const result = await getFirstValidCandidate(tasks);
                        if (result) {
                            pageUrl = result.url;
                            pageHtml = result.html;
                        }
                    }
                }
            } catch (e) {}
        }

        if (!pageUrl || !pageHtml) {
            return [];
        }

        let videoLinks = [];
        const regexMatch = new RegExp(`data-num="${season}x(?:${episode}|${episode.toString().padStart(2, '0')})"`, 'i').exec(pageHtml);
        
        if (regexMatch) {
            const mirrorsStart = pageHtml.indexOf('<div class="mirrors">', regexMatch.index);
            if (mirrorsStart !== -1) {
                const mirrorsEnd = pageHtml.indexOf('</div>', mirrorsStart);
                if (mirrorsEnd !== -1) {
                    const block = pageHtml.substring(mirrorsStart, mirrorsEnd);
                    const blockMatches = [...block.matchAll(/data-link="([^"]+)"/g)];
                    videoLinks = blockMatches.map(m => m[1]);
                }
            }
        }

        if (videoLinks.length === 0) {
            videoLinks = extractLinksAdvanced(pageHtml, season, episode);
        }

        videoLinks = [...new Set(videoLinks.filter(Boolean))];

        if (videoLinks.length === 0) {
            return [];
        }

        const results = [];
        for (let i = 0; i < videoLinks.length; i += 5) {
            const chunk = videoLinks.slice(i, i + 5);
            const chunkPromises = chunk.map(link => processHoster(link, client, cleanTitle));
            const chunkResults = await Promise.allSettled(chunkPromises);
            chunkResults.forEach(res => {
                if (res.status === 'fulfilled' && res.value) results.push(res.value);
            });
        }

        const streams = [];
        const seenUrls = new Set();
        
        results.sort((a, b) => (a._priority || 9) - (b._priority || 9));

        for (const res of results) {
            if (!seenUrls.has(res.url)) {
                seenUrls.add(res.url);
                delete res._priority;
                streams.push(res);
            }
        }

        return streams;

    } catch (e) {
        return [];
    }
}

module.exports = { searchGuardaserie };
