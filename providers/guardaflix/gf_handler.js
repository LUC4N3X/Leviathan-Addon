const axios = require('axios');
const cheerio = require('cheerio');
const https = require('https');
const { URL } = require('url');
const crypto = require('crypto');

const CONFIG = {
    BASE_URL: 'https://www.guardaplay.space',
    TMDB_API_KEY: "5bae8d11f2a7bc7a95c6d040a31d2163",
    TIMEOUT: 15000
};

const logDebug = (msg, ...args) => {
    console.log(`[GuardaFlix-Debug] ${msg}`, ...args);
};

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const httpsAgent = new https.Agent({ rejectUnauthorized: false, keepAlive: true });
const httpClient = axios.create({ timeout: CONFIG.TIMEOUT, httpsAgent });

const fetchSmart = async (url, options = {}) => {
    return httpClient({
        url,
        method: 'GET',
        headers: {
            'User-Agent': USER_AGENT,
            'Accept': 'application/json, text/plain, */*',
            'Accept-Encoding': 'gzip, deflate, br',
            'Connection': 'keep-alive',
            ...options.headers
        },
        ...options
    });
};

// Integrazione di got-scraping (dallo script gf_handler.js originale) per bypassare TLS/WAF
let gotScrapingInstance = null;
const fetchWithGot = async (targetUrl, customHeaders = {}) => {
    if (!gotScrapingInstance) {
        const module = await import('got-scraping');
        gotScrapingInstance = module.gotScraping;
    }
    const response = await gotScrapingInstance({
        url: targetUrl,
        headers: customHeaders,
        retry: { limit: 2 },
        responseType: 'text'
    });
    return response.body;
};

const REGEX = {
    CLEAN_TITLE: /Guardaflix|GuardaPlay|Film Streaming ITA/gi,
    NON_ALNUM: /[^a-z0-9]+/g
};

const normalizeText = (text) => (text || '').replace(REGEX.NON_ALNUM, '').toLowerCase().trim();
const cleanTitle = (text) => (text || '').replace(REGEX.CLEAN_TITLE, '').trim();
const slugify = (text) => (text || '').toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9\-]+/g, '').replace(/\-+/g, '-').replace(/^-|-$/g, '');


function resolveTmdbMovieId(meta) {
    const direct = String(meta?.tmdb_id || meta?.tmdbId || '').trim();
    if (/^\d+$/.test(direct)) return direct;
    const metaId = String(meta?.id || '').trim();
    const match = metaId.match(/^tmdb:(\d+)/i);
    return match ? match[1] : null;
}

async function fetchMovieByImdb(imdbId) {
    if (!/^tt\d+$/i.test(String(imdbId || '').trim())) return null;
    try {
        const res = await fetchSmart(`https://api.themoviedb.org/3/find/${encodeURIComponent(imdbId)}?api_key=${CONFIG.TMDB_API_KEY}&external_source=imdb_id&language=it-IT`);
        return res.data?.movie_results?.[0] || null;
    } catch {
        return null;
    }
}

async function fetchMovieByTmdb(tmdbId) {
    if (!/^\d+$/.test(String(tmdbId || '').trim())) return null;
    try {
        const res = await fetchSmart(`https://api.themoviedb.org/3/movie/${encodeURIComponent(tmdbId)}?api_key=${CONFIG.TMDB_API_KEY}&language=it-IT`);
        return res.data || null;
    } catch {
        return null;
    }
}

class GuardaFlixScraper {
    constructor(config) {
        this.config = config || {};
        this.AES_KEY = Buffer.from('kiemtienmua911ca');
        this.AES_IV = Buffer.from('1234567890oiuytr');

        logDebug("Inizializzato. Config MFP presente?", !!(this.config?.mediaflow?.url));
    }

    async getTmdbMeta(metaInput) {
        try {
            const explicitImdb = /^tt\d+$/i.test(String(metaInput?.imdb_id || metaInput || '').trim())
                ? String(metaInput?.imdb_id || metaInput).trim()
                : null;
            const explicitTmdb = resolveTmdbMovieId(metaInput);

            let media = null;
            if (explicitImdb) {
                logDebug(`Recupero TMDB meta per IMDb: ${explicitImdb}`);
                media = await fetchMovieByImdb(explicitImdb);
            }
            if (!media && explicitTmdb) {
                logDebug(`Recupero TMDB meta per TMDB: ${explicitTmdb}`);
                media = await fetchMovieByTmdb(explicitTmdb);
            }

            if (!media) {
                logDebug('Nessun risultato TMDB trovato per GuardaFlix');
                return null;
            }

            const meta = {
                title_it: media.title || media.name,
                title_orig: media.original_title || media.original_name,
                year: String(media.release_date || media.first_air_date || '').substring(0, 4),
                tmdb_id: media.id ? String(media.id) : explicitTmdb,
                imdb_id: explicitImdb || null
            };

            logDebug('Meta TMDB trovati:', meta);
            return meta;
        } catch (err) {
            logDebug('Errore getTmdbMeta:', err.message);
            return null;
        }
    }

    scoreCandidate(queryNorm, querySlug, year, href, text) {
        let score = 0;
        const candNorm = normalizeText(text);
        const hrefLower = href.toLowerCase();

        if (queryNorm && candNorm) {
            if (queryNorm === candNorm) score += 4.0;
            else if (candNorm.includes(queryNorm)) score += 2.2;
        }

        const candSlug = slugify(text);
        if (querySlug && (querySlug === candSlug || hrefLower.includes(querySlug))) score += 1.8;
        if (year && (text.includes(year) || hrefLower.includes(year))) score += 0.35;

        return score;
    }

    async searchMovie(title, year) {
        try {
            const queryUrl = `${CONFIG.BASE_URL}/?s=${encodeURIComponent(title)}`;
            logDebug(`Esecuzione ricerca su sito: ${queryUrl}`);
            const res = await fetchSmart(queryUrl);
            const $ = cheerio.load(res.data);

            let bestHref = null, bestScore = -1;
            const queryNorm = normalizeText(title);
            const querySlug = slugify(title);

            $('a[href]').each((_, el) => {
                const href = $(el).attr('href');
                if (!href.toLowerCase().includes('/film/')) return;

                const text = $(el).text().trim() || $(el).attr('title') || $(el).find('img').attr('alt') || '';
                const score = this.scoreCandidate(queryNorm, querySlug, year, href, text);

                if (score > bestScore) {
                    bestScore = score;
                    bestHref = href;
                }
            });

            logDebug(`Miglior candidato trovato: ${bestHref} (Score: ${bestScore})`);

            if (bestHref && bestScore >= 0.65) {
                const finalHref = bestHref.startsWith('http') ? bestHref : new URL(bestHref, CONFIG.BASE_URL).href;
                logDebug(`Candidato accettato: ${finalHref}`);
                return finalHref;
            }
            logDebug("Candidato scartato o non trovato (score < 0.65).");
            return null;
        } catch (err) {
            logDebug("Errore searchMovie:", err.message);
            return null;
        }
    }

    decryptLoadmPayload(hexStr) {
        try {
            const cleanedHex = hexStr.replace(/[^0-9a-fA-F]/g, '');
            if (!cleanedHex) return null;

            const encryptedBytes = Buffer.from(cleanedHex, 'hex');
            const decipher = crypto.createDecipheriv('aes-128-cbc', this.AES_KEY, this.AES_IV);
            decipher.setAutoPadding(true);

            let decrypted = decipher.update(encryptedBytes);
            decrypted = Buffer.concat([decrypted, decipher.final()]);

            const json = JSON.parse(decrypted.toString('utf8'));
            const extracted = json.cf || json.source || null;
            logDebug(`Payload decriptato con successo. Link estratto: ${extracted ? "SI" : "NO"}`);
            return extracted;
        } catch (err) {
            logDebug("Errore decryptLoadmPayload:", err.message);
            return null;
        }
    }

    async extractLoadmAPI(iframeUrl, pageUrl, isSub, mediaTitle) {
        try {
            logDebug(`Inizio estrazione LoadM API per: ${iframeUrl}`);
            let videoId = "";
            const parsedOrigin = new URL(iframeUrl);

            if (iframeUrl.includes('#')) {
                videoId = iframeUrl.split('#').pop().trim();
            } else if (parsedOrigin.pathname.includes('/e/')) {
                videoId = parsedOrigin.pathname.split('/e/').pop().trim();
            } else {
                videoId = (parsedOrigin.searchParams.get('id') || parsedOrigin.searchParams.get('v') || '').trim();
            }

            logDebug(`Video ID estratto: ${videoId}`);
            if (!videoId) return null;

            const baseUrl = parsedOrigin.origin + '/'; // Es: https://loadm.cam/
            const apiUrl = `${baseUrl}api/v1/video`;

            // Usiamo ESATTAMENTE la query string che funziona nel Python
            const params = new URLSearchParams({
                id: videoId,
                w: '2560',
                h: '1440',
                r: pageUrl
            });
            const fullApiUrl = `${apiUrl}?${params.toString()}`;

            logDebug(`Chiamata API LoadM (Stringa esatta): ${fullApiUrl}`);

            let rawPayload;
            try {
                // Tentativo primario con got-scraping per bypass TLS
                const body = await fetchWithGot(fullApiUrl, {
                    'Referer': baseUrl,
                    'User-Agent': USER_AGENT,
                    'Accept': 'application/json, text/plain, */*'
                });
                rawPayload = typeof body === 'string' ? body : JSON.stringify(body);
            } catch (gotErr) {
                logDebug(`GOT fallito, provo Axios. Errore: ${gotErr.message}`);
                // Fallback Axios se got fallisce per altri motivi
                const res = await fetchSmart(fullApiUrl, {
                    headers: { 'Referer': baseUrl }
                });
                if (!res.data) throw new Error("Risposta vuota");
                rawPayload = typeof res.data === 'string' ? res.data : JSON.stringify(res.data);
            }

            logDebug(`Payload ricevuto, lunghezza: ${rawPayload.length}`);

            const m3u8 = this.decryptLoadmPayload(rawPayload);
            if (!m3u8) {
                logDebug("Impossibile estrarre M3U8 dal payload decriptato.");
                return null;
            }

            const langTag = isSub ? "[SUB]" : "[ITA]";
            const finalTitle = `${cleanTitle(mediaTitle) || 'Stream'} ${langTag}`;

            const streamObj = {
                name: "🍿 Guardaflix",
                title: `▶️ ${finalTitle}
🔄 LoadM (Direct)`,
                url: m3u8,
                extractor: 'LoadM',
                behaviorHints: {
                    notWebReady: false,
                    extractor: 'LoadM',
                    proxyHeaders: { request: { "Referer": baseUrl, "Origin": baseUrl.slice(0, -1) } }
                }
            };

            if (this.config?.mediaflow?.url) {
                logDebug("Applicazione MediaFlow Proxy allo stream LoadM.");
                const mfp = this.config.mediaflow.url.replace(/\/$/, '');
                const pass = this.config.mediaflow.pass ? `&api_password=${encodeURIComponent(this.config.mediaflow.pass)}` : '';
                streamObj.url = `${mfp}/proxy/hls/manifest.m3u8?d=${encodeURIComponent(m3u8)}${pass}&h_Referer=${encodeURIComponent(baseUrl)}&h_Origin=${encodeURIComponent(baseUrl.slice(0, -1))}`;
                streamObj.name = "🍿 Guardaflix [MFP]";
            }

            return streamObj;
        } catch (err) {
            const errorData = err.response ? JSON.stringify(err.response.data) : err.message;
            logDebug(`Errore extractLoadmAPI: ${errorData} - HTTP ${err.response?.status}`);
            return null;
        }
    }

    async processIframe(src, pageUrl, mediaTitle, isSub, depth = 0) {
        logDebug(`Processo iframe (Depth: ${depth}): ${src}`);
        if (depth > 2 || !src) return [];

        try {
            const absoluteSrc = new URL(src, pageUrl).href;
            const lowerSrc = absoluteSrc.toLowerCase();

            if (lowerSrc.includes('loadm')) {
                logDebug("Match LoadM trovato! Passo a extractLoadmAPI.");
                const stream = await this.extractLoadmAPI(absoluteSrc, pageUrl, isSub, mediaTitle);
                return stream ? [stream] : [];
            }

            logDebug(`Scansione contenuto iframe: ${absoluteSrc}`);
            const res = await fetchSmart(absoluteSrc, { headers: { 'Referer': pageUrl } });
            const $ = cheerio.load(res.data);
            const nestedStreams = [];

            const nestedIframes = $('iframe[src], iframe[data-src]').map((_, el) => $(el).attr('data-src') || $(el).attr('src')).get();
            logDebug(`Trovati ${nestedIframes.length} iframe annidati.`);

            for (const nestedSrc of nestedIframes) {
                const results = await this.processIframe(nestedSrc, absoluteSrc, mediaTitle, isSub, depth + 1);
                nestedStreams.push(...results);
            }
            return nestedStreams;

        } catch (err) {
            logDebug("Errore processIframe:", err.message);
            return [];
        }
    }

    async resolvePage(pageUrl) {
        try {
            logDebug(`Risoluzione pagina film: ${pageUrl}`);
            const res = await fetchSmart(pageUrl);
            const $ = cheerio.load(res.data);

            const mediaTitle = cleanTitle($('meta[property="og:title"]').attr('content') || $('title').text());
            logDebug(`Titolo media estratto: ${mediaTitle}`);

            const optLangMap = {};
            $('a[href^="#options-"]').each((_, el) => {
                optLangMap[$(el).attr('href').substring(1)] = $(el).text().toLowerCase().includes('sub');
            });

            let defaultIsSub = false;
            $('span[class*="btn"]').each((_, el) => {
                if ($(el).hasClass('active') && $(el).text().toLowerCase().includes('sub')) defaultIsSub = true;
            });

            const jobs = [];
            const optionDivs = $('div[id^="options-"].video.aa-tb');

            if (optionDivs.length > 0) {
                optionDivs.each((_, div) => {
                    const isSub = optLangMap[$(div).attr('id')] ?? defaultIsSub;
                    $(div).find('iframe').each((_, iframe) => {
                        const src = $(iframe).attr('data-src') || $(iframe).attr('src');
                        if (src) jobs.push({ src, isSub });
                    });
                });
            } else {
                $('iframe').each((_, iframe) => {
                    const src = $(iframe).attr('data-src') || $(iframe).attr('src');
                    if (src) jobs.push({ src, isSub: defaultIsSub });
                });
            }

            logDebug(`Lavori iframe estratti dalla pagina: ${jobs.length}`);

            const streams = [];
            const promises = jobs.map(job => this.processIframe(job.src, pageUrl, mediaTitle, job.isSub));
            const results = await Promise.allSettled(promises);

            results.forEach(result => {
                if (result.status === 'fulfilled' && result.value.length > 0) {
                    streams.push(...result.value);
                }
            });

            const deduplicated = Array.from(new Map(streams.map(s => [s.url, s])).values());
            logDebug(`Stream finali dopo deduplicazione: ${deduplicated.length}`);
            return deduplicated;

        } catch (err) {
            logDebug("Errore resolvePage:", err.message);
            return [];
        }
    }

    async getStreams(meta) {
        logDebug('--- Inizio getStreams per GuardaFlix ---');
        if (meta?.isSeries) {
            logDebug('Provider saltato: GuardaFlix viene usato solo per i film.');
            return [];
        }

        const tmdbMeta = await this.getTmdbMeta(meta);
        if (!tmdbMeta) {
            logDebug('Impossibile risolvere metadati TMDB per GuardaFlix.');
            return [];
        }

        const searchCandidates = [tmdbMeta.title_it, tmdbMeta.title_orig].filter(Boolean);
        let pageUrl = null;

        for (const title of searchCandidates) {
            logDebug(`Tentativo di ricerca con titolo: ${title}`);
            pageUrl = await this.searchMovie(title, tmdbMeta.year);
            if (pageUrl) break;
        }

        if (!pageUrl) {
            logDebug("Nessuna pagina utile trovata sul sito. Fine.");
            return [];
        }

        const finalStreams = await this.resolvePage(pageUrl);
        logDebug("--- Fine getStreams per GuardaFlix ---");
        return finalStreams;
    }
}

async function searchGuardaFlix(meta, config) {
    const scraper = new GuardaFlixScraper(config);
    return await scraper.getStreams(meta);
}

module.exports = { searchGuardaFlix };
