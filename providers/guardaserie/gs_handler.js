const axios = require('axios');
const cheerio = require('cheerio');

// --- COSTANTI E CONFIGURAZIONE ---
const GS_DOMAIN = "https://guardaserietv.skin";
const TMDB_KEY = "5bae8d11f2a7bc7a95c6d040a31d2163";

function getTargetDomain(config) {
    if (config && config.mediaflow && config.mediaflow.gsUrl && config.mediaflow.gsUrl.length > 3) {
        return `https://${config.mediaflow.gsUrl.replace(/^https?:\/\//, '').replace(/\/$/, '')}`;
    }
    return GS_DOMAIN;
}

// --- PROFILI BROWSER PER STEALTH ESTREMO ---
const BROWSER_PROFILES = [
    {
        ua: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        sec_ch_ua: '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"'
    },
    {
        ua: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36 Edg/124.0.0.0",
        sec_ch_ua: '"Chromium";v="124", "Microsoft Edge";v="124", "Not-A.Brand";v="99"'
    },
    {
        ua: "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:125.0) Gecko/20100101 Firefox/125.0",
        sec_ch_ua: null
    }
];

function getStealthHeaders(referer) {
    const profile = BROWSER_PROFILES[Math.floor(Math.random() * BROWSER_PROFILES.length)];
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
        proxy: false
    });
}

// --- HELPER: TMDB E KITSU (Tradotti dal Python) ---

async function getTmdbFromImdb(imdbId, client) {
    if (!imdbId || !imdbId.startsWith("tt")) return imdbId;
    
    // Metodo 1: API (Veloce)
    try {
        const url = `https://api.themoviedb.org/3/find/${imdbId}?api_key=${TMDB_KEY}&external_source=imdb_id`;
        const response = await client.get(url, { timeout: 5000 });
        const data = response.data;
        if (data.movie_results && data.movie_results.length > 0) return data.movie_results[0].id.toString();
        if (data.tv_results && data.tv_results.length > 0) return data.tv_results[0].id.toString();
    } catch (e) {
        console.debug(`GS [TMDB] API fallita per ${imdbId}: ${e.message}`);
    }

    // Metodo 2: Fallback Scraping
    try {
        const urlMovie = `https://www.themoviedb.org/movie/${imdbId}`;
        const respMovie = await client.get(urlMovie, { timeout: 10000 });
        const finalUrlM = respMovie.request?.res ? respMovie.request.res.responseUrl : respMovie.config.url;
        let match = finalUrlM.match(/\/movie\/(\d+)/);
        if (match) return match[1];

        const urlTv = `https://www.themoviedb.org/tv/${imdbId}`;
        const respTv = await client.get(urlTv, { timeout: 10000 });
        const finalUrlTv = respTv.request?.res ? respTv.request.res.responseUrl : respTv.config.url;
        match = finalUrlTv.match(/\/tv\/(\d+)/);
        if (match) return match[1];
    } catch (e) {
        console.error(`GS [TMDB] Errore conversione ID per ${imdbId}: ${e.message}`);
    }
    return null;
}

async function getKitsuInfo(kitsuId, client) {
    try {
        const url = `https://kitsu.io/api/edge/anime/${kitsuId}`;
        const response = await client.get(url, { timeout: 5000 });
        const attr = response.data.data.attributes;
        const title = attr.titles.en || attr.titles.en_jp || attr.canonicalTitle;
        const date = attr.startDate ? attr.startDate.substring(0, 4) : "";
        return { title, date };
    } catch (e) {
        return { title: null, date: null };
    }
}

async function getMediaInfo(tmdbId, type, client) {
    try {
        const url = `https://api.themoviedb.org/3/${type}/${tmdbId}?api_key=${TMDB_KEY}&language=it-IT`;
        const response = await client.get(url, { timeout: 5000 });
        const data = response.data;
        
        if (type === 'movie') {
            return { title: data.title, date: data.release_date ? data.release_date.substring(0, 4) : '' };
        } else {
            return { title: data.name, date: data.first_air_date ? data.first_air_date.substring(0, 4) : '' };
        }
    } catch (e) {
        console.error(`GS [TMDB] Errore recupero info media per ${tmdbId}: ${e.message}`);
    }
    return { title: null, date: null };
}

// --- UTILS: STRINGHE E DECRIPTAZIONE ---
function slugify(value) {
    return value.toString().toLowerCase().trim()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '');
}

function wrapMfp(videoUrl, referer, origin, mfpUrl, mfpPass) {
    if (!mfpUrl || !videoUrl) return videoUrl;
    const proxyEndpoint = `${mfpUrl.replace(/\/+$/, '')}/proxy/hls/manifest.m3u8`;
    const params = new URLSearchParams();
    params.append('d', videoUrl);
    params.append('h_Referer', referer);
    params.append('h_Origin', origin);
    params.append('h_User-Agent', getStealthHeaders()['User-Agent']);
    if (mfpPass) params.append('api_password', mfpPass);
    return `${proxyEndpoint}?${params.toString()}`;
}

function unpackDeanEdwards(html, regexPattern) {
    try {
        const packedMatch = html.match(/eval\(function\(p,a,c,k,e,?[rd]?\).*?\}\('(.*?)',\s*(\d+),\s*(\d+),\s*'([^']+)'\.split\('\|'\).*?\)\)/s);
        if (!packedMatch) return null;

        let [_, p, a, c, k] = packedMatch;
        a = parseInt(a);
        c = parseInt(c);
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
        
    } catch (e) { }
    return null;
}

// --- ESTRATTORI (CON WORKER SUPERVIDEO) ---

async function extractSupervideo(url, client) {
    try {
        url = url.startsWith("//") ? `https:${url}` : url;
        const urlObj = new URL(url);
        
        const id = urlObj.pathname.split('/').pop().replace(/\.html|embed-|\/k\//gi, '');
        const targetUrl = `${urlObj.origin}/e/${id}`;
        
        const customHeaders = { 
            'Referer': `${urlObj.origin}/`, 
            'Origin': urlObj.origin,
            'User-Agent': getStealthHeaders()['User-Agent']
        };

        const fetchWorker = async (target) => {
            const workerUrl = `https://still-mode-fd28.quelladiprova96.workers.dev/?url=${encodeURIComponent(target)}`;
            const res = await client.get(workerUrl, { headers: customHeaders, timeout: 10000 });
            return res.data;
        };

        let html = await fetchWorker(targetUrl);
        if (!html || typeof html !== 'string') return null;

        if (html.includes('watched as embed only')) {
            html = await fetchWorker(`${urlObj.origin}/e${urlObj.pathname}`);
        }

        const m3u8Regex = /(https?:\/\/[^\s"']+\.m3u8[^\s"']*)/i;
        
        const unpacked = unpackDeanEdwards(html, m3u8Regex);
        if (unpacked) return unpacked;
        
        const rawMatch = html.match(m3u8Regex);
        if (rawMatch) return rawMatch[1];

    } catch (e) { console.error(`GS [Supervideo] Error: ${e.message}`); }
    return null;
}

async function extractDropload(url, client) {
    try {
        url = url.startsWith("//") ? `https:${url}` : url.replace("/e/", "/").replace("/d/", "/");
        const res = await client.get(url, { headers: getStealthHeaders(), timeout: 6000 });
        const html = res.data;
        
        const dlRegex = /sources:\s*\[\s*\{\s*file\s*:\s*["'](https?:\/\/[^"']+)["']/;
        const linkMatch = html.match(dlRegex);
        if (linkMatch) return linkMatch[1];
        
        const unpacked = unpackDeanEdwards(html, dlRegex);
        if (unpacked) return unpacked;
    } catch (e) { console.error(`GS [Dropload] Error: ${e.message}`); }
    return null;
}

async function extractMixdrop(url, client) {
    try {
        url = url.startsWith("//") ? `https:${url}` : url;
        const res = await client.get(url, { headers: getStealthHeaders(), timeout: 6000 });
        const html = res.data;
        
        const mixdropRegex = /(?:MDCore|Core|wurl)\s*(?:\.wurl)?\s*=\s*["']([^"']+)["']/;
        const linkMatch = html.match(mixdropRegex);
        if (linkMatch) return linkMatch[1].startsWith("//") ? `https:${linkMatch[1]}` : linkMatch[1];
        
        const unpackedHtml = unpackDeanEdwards(html);
        if (unpackedHtml) {
            const unpackedMatch = unpackedHtml.match(mixdropRegex);
            if (unpackedMatch) return unpackedMatch[1].startsWith("//") ? `https:${unpackedMatch[1]}` : unpackedMatch[1];
        }
    } catch (e) { console.error(`GS [MixDrop] Error: ${e.message}`); }
    return null;
}

// --- CONTROLLO CONCORRENZA E RICERCA ---

async function processHoster(videoLink, client, cleanTitle, mfpUrl, mfpPass) {
    let mediaUrl = null, hostName = "Sconosciuto", priority = 9;
    const vLinkLower = videoLink.toLowerCase();
    
    if (vLinkLower.includes("supervideo")) {
        hostName = "Supervideo"; priority = 1; mediaUrl = await extractSupervideo(videoLink, client);
    } else if (vLinkLower.includes("dropload")) {
        hostName = "Dropload"; priority = 2; mediaUrl = await extractDropload(videoLink, client);
    } else if (vLinkLower.includes("mixdrop")) {
        hostName = "MixDrop"; priority = 3; mediaUrl = await extractMixdrop(videoLink, client);
    } else {
        return null;
    }

    if (mediaUrl) {
        try {
            const parsedUrl = new URL(videoLink);
            const origin = `${parsedUrl.protocol}//${parsedUrl.host}`;
            const finalUrl = wrapMfp(mediaUrl, videoLink, origin, mfpUrl, mfpPass);
            return {
                url: finalUrl,
                name: `🍿 GS | ${hostName}`,
                title: `${cleanTitle}\n☁️ ${hostName} • 🇮🇹 ITA`,
                behaviorHints: {},
                _priority: priority
            };
        } catch (e) { return null; }
    }
    return null;
}

async function checkCandidatePage(candUrl, cleanId, client) {
    try {
        const candRes = await client.get(candUrl, { headers: getStealthHeaders(), timeout: 6000 });
        if (candRes.status === 200) {
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
    const $ = cheerio.load(html);
    const links = new Set();
    const epRegex = new RegExp(`\\b${season}x(?:${episode.toString().padStart(2, '0')}|${episode})\\b`, 'i');
    
    $('*').contents().filter((_, el) => el.type === 'text' && epRegex.test(el.data)).each((_, el) => {
        let parent = $(el).parent();
        for (let i = 0; i < 3; i++) {
            if (!parent || parent.length === 0) break;
            
            parent.find('[data-link]').each((_, tag) => links.add($(tag).attr('data-link')));
            parent.find('a[href]').each((_, tag) => {
                const href = $(tag).attr('href').toLowerCase();
                if (href.includes('supervideo') || href.includes('dropload') || href.includes('mixdrop')) {
                    links.add($(tag).attr('href'));
                }
            });
            parent = parent.parent();
        }
    });
    return Array.from(links);
}

// --- ENTRY POINT PRINCIPALE ---

async function searchGuardaserie(meta, config) {
    if (!meta || !meta.isSeries) return []; 
    if (!config.filters || !config.filters.enableGs) return [];

    const targetDomain = getTargetDomain(config);
    const client = createClient();
    const mfpUrl = config.mediaflow ? config.mediaflow.url : null;
    const mfpPsw = config.mediaflow ? config.mediaflow.pass : null;
    
    const cleanId = meta.imdb_id;
    const season = parseInt(meta.season);
    const episode = parseInt(meta.episode);

    console.log(`GS >>> Inizio estrazione per: ${cleanId}:${season}:${episode}`);

    try {
        let showName = meta.title || "";
        
        // INTEGRAZIONE TMDB: Cerchiamo il titolo localizzato in Italiano
        if (cleanId.startsWith("tt")) {
            const tmdbId = await getTmdbFromImdb(cleanId, client);
            if (tmdbId) {
                const mediaInfo = await getMediaInfo(tmdbId, 'tv', client);
                if (mediaInfo && mediaInfo.title) {
                    showName = mediaInfo.title;
                    console.log(`GS [TMDB] Titolo italiano recuperato: ${showName}`);
                }
            }
        }
        
        // Fallback Cinemeta se TMDB fallisce
        if (!showName || showName === meta.title) {
            try {
                const metaRes = await axios.get(`https://v3-cinemeta.strem.io/meta/series/${cleanId}.json`, { timeout: 4000 });
                if (metaRes.data && metaRes.data.meta && metaRes.data.meta.name) {
                    showName = metaRes.data.meta.name;
                }
            } catch (e) {}
        }

        const cleanTitle = showName ? `${showName} S${season.toString().padStart(2, '0')}E${episode.toString().padStart(2, '0')}` : `S${season.toString().padStart(2, '0')}E${episode.toString().padStart(2, '0')}`;
        let pageUrl = null;
        let pageHtml = null;

        // --- URL GUESSING SUPER VELOCE ---
        if (showName) {
            const slug = slugify(showName);
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
                console.log(`GS URL Guessing Riuscito: ${pageUrl}`);
            }
        }

        // --- RICERCA INTERNA ASINCRONA ---
        if (!pageUrl) {
            const searchUrl = `${targetDomain}/index.php?do=search&subaction=search&story=${encodeURIComponent(showName || cleanId)}`;
            const response = await client.get(searchUrl, { headers: getStealthHeaders(`${targetDomain}/`), timeout: 8000 });
            
            if (response.status === 200) {
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
                        console.log(`GS Pagina Serie Trovata da Ricerca: ${pageUrl}`);
                    }
                }
            }
        }

        if (!pageUrl || !pageHtml) {
            console.error(`GS FATAL: Nessuna pagina valida trovata per ${cleanId}`);
            return [];
        }

        // Estrazione Link Hoster
        let videoLinks = [];
        const regexMatch = new RegExp(`data-num="${season}x(?:${episode}|${episode.toString().padStart(2, '0')})"`, 'i').exec(pageHtml);
        
        if (regexMatch) {
            const mirrorsStart = pageHtml.indexOf('<div class="mirrors">', regexMatch.index);
            if (mirrorsStart !== -1) {
                const mirrorsEnd = pageHtml.indexOf('</div>', mirrorsStart);
                const block = pageHtml.substring(mirrorsStart, mirrorsEnd);
                const blockMatches = [...block.matchAll(/data-link="([^"]+)"/g)];
                videoLinks = blockMatches.map(m => m[1]);
            }
        }

        if (videoLinks.length === 0) {
            console.log("GS Regex veloce fallita. Avvio ricerca DOM avanzata...");
            videoLinks = extractLinksAdvanced(pageHtml, season, episode);
        }

        videoLinks = [...new Set(videoLinks)];

        if (videoLinks.length === 0) {
            console.warn(`GS FATAL: Nessun link trovato per S${season.toString().padStart(2, '0')}E${episode.toString().padStart(2, '0')}`);
            return [];
        }

        console.log(`GS Trovati ${videoLinks.length} link hoster. Avvio elaborazione asincrona sicura...`);

        const results = [];
        for (let i = 0; i < videoLinks.length; i += 5) {
            const chunk = videoLinks.slice(i, i + 5);
            const chunkPromises = chunk.map(link => processHoster(link, client, cleanTitle, mfpUrl, mfpPsw));
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

        console.log(`GS <<< Fine. Estratti ${streams.length} flussi univoci.`);
        return streams;

    } catch (e) {
        console.error(`GS Eccezione Critica: ${e.message}`);
        return [];
    }
}

module.exports = { searchGuardaserie };

