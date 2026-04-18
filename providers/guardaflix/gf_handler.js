const axios = require('axios');
const cheerio = require('cheerio');
const https = require('https');
const { URL } = require('url');
const { buildWebStream } = require('../extractors/common');
const { extractFromUrl } = require('../extractors/registry');

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

    buildStreamFromExtractor(extracted, mediaTitle, isSub) {
        const langTag = isSub ? "[SUB]" : "[ITA]";
        const finalTitle = `${cleanTitle(mediaTitle) || 'Stream'} ${langTag}`;
        const originalHeaders = extracted?.headers || null;
        let streamName = '🍿 GuardaFlix';
        let streamUrl = extracted.url;
        let modeLabel = 'Direct';
        let headers = originalHeaders;

        if (this.config?.mediaflow?.url && extracted?.name === 'LoadM' && originalHeaders?.Referer && originalHeaders?.Origin) {
            logDebug("Applicazione MediaFlow Proxy allo stream LoadM.");
            const mfp = this.config.mediaflow.url.replace(/\/$/, '');
            const pass = this.config.mediaflow.pass ? `&api_password=${encodeURIComponent(this.config.mediaflow.pass)}` : '';
            streamUrl = `${mfp}/proxy/hls/manifest.m3u8?d=${encodeURIComponent(streamUrl)}${pass}&h_Referer=${encodeURIComponent(originalHeaders.Referer)}&h_Origin=${encodeURIComponent(originalHeaders.Origin)}`;
            streamName = '🍿 GuardaFlix [MFP]';
            modeLabel = 'Proxy';
            headers = null;
        }

        return buildWebStream({
            name: streamName,
            title: `▶️ ${finalTitle}
🔄 ${extracted.name} (${modeLabel})`,
            url: streamUrl,
            extractor: extracted.name,
            provider: 'GuardaFlix',
            providerCode: 'GF',
            quality: extracted.quality || 'Unknown',
            headers
        });
    }

    async processIframe(src, pageUrl, mediaTitle, isSub, depth = 0) {
        logDebug(`Processo iframe (Depth: ${depth}): ${src}`);
        if (depth > 2 || !src) return [];

        try {
            const absoluteSrc = new URL(src, pageUrl).href;
            const extracted = await extractFromUrl(absoluteSrc, {
                client: httpClient,
                userAgent: USER_AGENT,
                requestReferer: pageUrl,
                fetchers: [
                    (targetUrl, headers) => fetchWithGot(targetUrl, headers)
                ]
            });

            if (extracted?.url) {
                logDebug(`Extractor condiviso risolto: ${extracted.name}`);
                return [this.buildStreamFromExtractor(extracted, mediaTitle, isSub)];
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
