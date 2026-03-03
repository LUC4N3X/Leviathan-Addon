const axios = require("axios");
const cheerio = require("cheerio");
const crypto = require("crypto");
const winston = require("winston");

const logger = winston.createLogger({
    level: 'debug',
    format: winston.format.combine(winston.format.timestamp(), winston.format.simple()),
    transports: [new winston.transports.Console()]
});

const GF_DOMAIN = "https://www.guardaplay.pro";
const KEY = Buffer.from('kiemtienmua911ca', 'utf8');
const IV = Buffer.from('1234567890oiuytr', 'utf8');
const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/110.0.0.0 Safari/537.36";

// --- DECRYPTION AES-128-CBC ---
function decryptLoadm(hexStr) {
    try {
        const cleanHex = hexStr.replace(/[^0-9a-fA-F]/g, '');
        if (!cleanHex) return null;
        
        const encryptedBytes = Buffer.from(cleanHex, 'hex');
        const decipher = crypto.createDecipheriv('aes-128-cbc', KEY, IV);
        // Node.js gestisce l'unpadding PKCS7 in automatico se non disabilitato
        let decrypted = decipher.update(encryptedBytes, undefined, 'utf8');
        decrypted += decipher.final('utf8');
        
        return JSON.parse(decrypted);
    } catch (e) {
        logger.error(`[GuardaFlix] Decryption error: ${e.message}`);
        return null;
    }
}

// --- ESTRAZIONE LOADM E COSTRUZIONE MFP ---
async function extractLoadm(playerUrl, referer, mediaTitle, config, isSub = false) {
    const streams = [];
    try {
        let videoId = "";
        let baseUrl = "";

        if (playerUrl.includes("#")) {
            const parts = playerUrl.split("#");
            baseUrl = parts[0];
            videoId = parts[1];
        } else if (playerUrl.includes("/e/")) {
            const parts = playerUrl.split("/e/");
            baseUrl = parts[0] + "/";
            videoId = parts[parts.length - 1];
        } else {
            const parsed = new URL(playerUrl);
            baseUrl = `${parsed.protocol}//${parsed.host}/`;
        }

        if (!videoId) return [];

        const apiUrl = `${baseUrl}api/v1/video`;
        const params = { id: videoId, w: '2560', h: '1440', r: referer };
        const headers = {
            'User-Agent': USER_AGENT,
            'Referer': playerUrl,
            'Origin': baseUrl.replace(/\/$/, '')
        };

        const response = await axios.get(apiUrl, { params, headers, timeout: 8000 });
        const data = decryptLoadm(response.data);
        if (!data) return [];

        const hlsUrl = data.cf;
        const metaTitle = data.title || 'Stream';
        const langTag = isSub ? "[SUB]" : "[ITA]";
        const finalTitle = (mediaTitle ? `${mediaTitle} ${langTag}` : `${metaTitle} ${langTag}`).trim();

        if (hlsUrl) {
            // LOGICA MFP (Richiesta rigorosamente dal tuo script)
            if (config.mediaflow && config.mediaflow.url) {
                try {
                    const mfpBase = config.mediaflow.url.replace(/\/$/, '');
                    const mfpPass = config.mediaflow.pass || '';
                    
                    const proxyTarget = `${mfpBase}/proxy/hls/manifest.m3u8`;
                    const queryParams = new URLSearchParams({
                        d: hlsUrl,
                        api_password: mfpPass,
                        h_Referer: playerUrl,
                        h_Origin: baseUrl.replace(/\/$/, ''),
                        'h_User-Agent': USER_AGENT
                    });

                    const finalUrl = `${proxyTarget}?${queryParams.toString()}`;

                    streams.push({
                        name: "GuardaFlix [MFP]",
                        title: finalTitle,
                        url: finalUrl,
                        behaviorHints: {
                            notWebReady: false,
                            bingieGroup: `Leviathan|HD|Web|GuardaFlix-${isSub ? 'SUB' : 'ITA'}`
                        }
                    });
                } catch (e) {
                    logger.error(`[GuardaFlix] MFP Construction Error: ${e.message}`);
                }
            } else {
                // Fallback senza MFP (potrebbe non funzionare a causa dei CORS di GPlay)
                streams.push({
                    name: "GuardaFlix",
                    title: finalTitle,
                    url: hlsUrl,
                    behaviorHints: {
                        notWebReady: true,
                        proxyHeaders: {
                            request: {
                                "Referer": playerUrl,
                                "User-Agent": USER_AGENT,
                                "Origin": baseUrl.replace(/\/$/, '')
                            }
                        }
                    }
                });
            }
        }
    } catch (e) {
        logger.error(`[GuardaFlix] LoadM Extraction Failed: ${e.message}`);
    }
    return streams;
}

// --- RISOLUZIONE PAGINA (IFRAME & TABS) ---
async function resolvePage(pageUrl, config) {
    const streams = [];
    try {
        const response = await axios.get(pageUrl, { headers: { 'User-Agent': USER_AGENT }, timeout: 8000 });
        const $ = cheerio.load(response.data);
        
        let mediaTitle = "";
        const ogTitle = $('meta[property="og:title"]').attr('content');
        if (ogTitle) {
            mediaTitle = ogTitle;
        } else {
            mediaTitle = $('title').text();
        }
        mediaTitle = mediaTitle.replace(/Guardaflix|GuardaPlay/gi, "").replace(/[-|]/g, "").trim();

        // Mappa lingua basata sulle tab
        const optLangMap = {};
        $('.aa-tbs li a, .video-options ul li a').each((_, el) => {
            const href = $(el).attr('href') || '';
            if (href.startsWith('#options-')) {
                const optId = href.substring(1);
                const serverText = $(el).find('span.server').text().toLowerCase();
                if (serverText.includes('sub')) optLangMap[optId] = true;
                else if (serverText.includes('ita')) optLangMap[optId] = false;
            }
        });

        let defaultIsSub = false;
        $('.video-options .d-flex-ch .btr span.btn.active').each((_, el) => {
            if ($(el).text().toLowerCase().includes('sub')) defaultIsSub = true;
        });

        const optionDivs = $('.video.aa-tb[id^="options-"]');
        let foundStreamsInTabs = false;

        const processIframe = async (src, isSub) => {
            if (!src) return;
            if (src.startsWith('//')) src = 'https:' + src;
            
            if (src.includes('loadm')) {
                const lmStreams = await extractLoadm(src, pageUrl, mediaTitle, config, isSub);
                streams.push(...lmStreams);
                foundStreamsInTabs = true;
            } else if (src.includes('trembed=')) {
                try {
                    const embResp = await axios.get(src, { headers: { 'Referer': pageUrl }, timeout: 5000 });
                    const $emb = cheerio.load(embResp.data);
                    const nestedIframes = $emb('iframe').toArray();
                    for (const nested of nestedIframes) {
                        let nSrc = $emb(nested).attr('data-src') || $emb(nested).attr('src');
                        if (nSrc) {
                            if (nSrc.startsWith('//')) nSrc = 'https:' + nSrc;
                            if (nSrc.includes('loadm')) {
                                const lmStreams = await extractLoadm(nSrc, pageUrl, mediaTitle, config, isSub);
                                streams.push(...lmStreams);
                                foundStreamsInTabs = true;
                            }
                        }
                    }
                } catch (e) {}
            }
        };

        if (optionDivs.length > 0) {
            const tabPromises = optionDivs.toArray().map(async (div) => {
                const divId = $(div).attr('id');
                const isSub = optLangMap[divId] !== undefined ? optLangMap[divId] : defaultIsSub;
                const iframes = $(div).find('iframe').toArray();
                for (const iframe of iframes) {
                    const src = $(iframe).attr('data-src') || $(iframe).attr('src');
                    await processIframe(src, isSub);
                }
            });
            await Promise.all(tabPromises);
        }

        if (!foundStreamsInTabs) {
            const allIframes = $('iframe').toArray();
            for (const iframe of allIframes) {
                const src = $(iframe).attr('data-src') || $(iframe).attr('src');
                if (src && !src.includes("youtube")) {
                    await processIframe(src, defaultIsSub);
                }
            }
        }

    } catch (e) {
        logger.error(`[GuardaFlix] Page Resolve Error: ${e.message}`);
    }
    return streams;
}

// --- RICERCA PRINCIPALE ED EXPORT ---
async function searchGuardaFlix(meta, config) {
    if (meta.isSeries) return []; // Python script filter: a[href*="/film/"]
    
    const streams = [];
    try {
        const query = meta.title;
        const year = meta.year;
        const searchUrl = `${GF_DOMAIN}/?s=${encodeURIComponent(query)}`;
        
        const res = await axios.get(searchUrl, { headers: { 'User-Agent': USER_AGENT }, timeout: 8000 });
        const $ = cheerio.load(res.data);
        
        const candidates = [];
        $('a[href*="/film/"]').each((_, a) => {
            let href = $(a).attr('href');
            const text = $(a).text().trim();
            if (!href || href === "#") return;
            if (href.startsWith('/')) href = GF_DOMAIN + href;
            if (href.endsWith('/film/') || href.endsWith('/film')) return;
            candidates.push({ href, text });
        });

        const queryClean = query.toLowerCase().replace(/[^a-z0-9]/g, '');
        let targetUrl = null;

        // 1. Match Esatto con anno
        for (const cand of candidates) {
            const candTextClean = cand.text.toLowerCase().replace(/[^a-z0-9]/g, '');
            const candHrefLower = cand.href.toLowerCase();
            if (candTextClean.includes(queryClean) || candHrefLower.includes(queryClean)) {
                if (year && (cand.text.includes(year) || cand.href.includes(year))) {
                    targetUrl = cand.href;
                    break;
                }
            }
        }

        // 2. Fallback senza anno
        if (!targetUrl) {
            for (const cand of candidates) {
                const candTextClean = cand.text.toLowerCase().replace(/[^a-z0-9]/g, '');
                const candHrefLower = cand.href.toLowerCase();
                if (candTextClean.includes(queryClean) || candHrefLower.includes(queryClean)) {
                    targetUrl = cand.href;
                    break;
                }
            }
        }
        
        // 3. Ultra Fallback
        if (!targetUrl && candidates.length > 0) targetUrl = candidates[0].href;

        if (targetUrl) {
            const resolvedStreams = await resolvePage(targetUrl, config);
            streams.push(...resolvedStreams);
        }

    } catch (e) {
        logger.error(`[GuardaFlix] Search Error: ${e.message}`);
    }
    return streams;
}

module.exports = { searchGuardaFlix };
