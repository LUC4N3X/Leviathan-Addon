const axios = require('axios');
const cheerio = require('cheerio');
const { wrapper } = require('axios-cookiejar-support');
const { CookieJar } = require('tough-cookie');
const crypto = require('crypto');

const jar = new CookieJar();

// --- CONFIGURAZIONE ---
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

function getTargetDomain(config) {
    let domain = "guardaserietv.asia"; 
    if (config && config.mediaflow && config.mediaflow.gsUrl && config.mediaflow.gsUrl.length > 3) {
        domain = config.mediaflow.gsUrl;
    }
    domain = domain.replace(/^https?:\/\//, '').replace(/\/$/, '');
    return `https://${domain}`;
}

function createClient(targetDomain) {
    const config = {
        jar,
        withCredentials: true,
        headers: {
            'User-Agent': UA,
            'Origin': targetDomain,
            'Referer': `${targetDomain}/`
        },
        timeout: 6000 // TIMEOUT RIDOTTO A 6 SECONDI PER VELOCITÀ
    };
    const instance = axios.create(config);
    return wrapper(instance);
}

// --- HELPER: GENERATORE DESCRIZIONI ---
function generateRichDescription(meta, provider, quality = "HD") {
    const lines = [];
    let episodeInfo = "";
    if (meta.season && meta.episode) {
        episodeInfo = `S${meta.season} E${meta.episode}`;
    }
    lines.push(`🎬 ${meta.title || "Episodio"} ${episodeInfo}`);
    lines.push(`🇮🇹 ITA • 🔊 AAC`);
    lines.push(`🎞️ ${quality} • ⚡ Fast`);
    lines.push(`☁️ ${provider} • 🍿 GuardaSerie`);
    return lines.join("\n");
}

// --- HELPER: UNPACKER ---
function detectAndUnpack(html) {
    try {
        const regex = /eval\(function\(p,a,c,k,e,d\).*?return p\}\('(.*?)',(\d+),(\d+),'(.*?)'\.split\('\|'\)/;
        const match = html.match(regex);
        if (!match) return null;

        let [_, p, a, c, k] = match;
        a = parseInt(a);
        c = parseInt(c);
        k = k.split('|');

        const e = (n) => (n < a ? '' : e(parseInt(n / a))) + ((n = n % a) > 35 ? String.fromCharCode(n + 29) : n.toString(36));
        
        const dict = {};
        for (let i = 0; i < c; i++) dict[e(i)] = k[i] || e(i);

        return p.replace(/\b\w+\b/g, (w) => dict[w] || w);
    } catch (e) { return null; }
}

// --- PROVIDER 1: DROPLOAD ---
async function extractDropload(client, dlUrl, referer, mfpUrl, mfpPsw, meta) {
    try {
        const response = await client.get(dlUrl, {
            headers: { 'User-Agent': UA, 'Referer': referer },
            timeout: 5000 // Fail fast
        });
        
        let html = response.data;
        let streamUrl = null;

        const fileRegex = /file\s*:\s*["']([^"']+)["']/;
        let m = html.match(fileRegex);
        if (m) streamUrl = m[1];

        if (!streamUrl) {
            const unpacked = detectAndUnpack(html);
            if (unpacked) {
                m = unpacked.match(fileRegex);
                if (m) streamUrl = m[1];
            }
        }

        if (streamUrl) {
            return {
                name: `🍿 GuardaSerie\n📦 Dropload`,
                title: generateRichDescription(meta, "Dropload", "FHD"),
                url: streamUrl,
                behaviorHints: {
                    notWebReady: false,
                    bingieGroup: "guardaserie-dropload",
                    proxyHeaders: {
                        request: { "Referer": dlUrl, "User-Agent": UA }
                    }
                }
            };
        }
    } catch (e) {}
    return null;
}

// --- PROVIDER 2: LOADM ---
const KEY = Buffer.from('kiemtienmua911ca', 'utf-8');
const IV = Buffer.from('1234567890oiuytr', 'utf-8');

async function extractLoadM(client, playerUrl, referer, mfpUrl, mfpPsw, meta) {
    try {
        const parts = playerUrl.split('#');
        const id = parts[1];
        if (!id) return null;

        const playerDomain = new URL(playerUrl).origin;
        const apiUrl = `${playerDomain}/api/v1/video`;

        const response = await client.get(apiUrl, {
            headers: { 'Referer': playerUrl, 'User-Agent': UA },
            params: { id, w: '2560', h: '1440', r: referer },
            responseType: 'text',
            timeout: 5000 // Fail fast
        });

        const hexData = response.data;
        const cleanHex = hexData.replace(/[^0-9a-fA-F]/g, '');
        if (!cleanHex) return null;

        const encryptedBytes = Buffer.from(cleanHex, 'hex');
        const decipher = crypto.createDecipheriv('aes-128-cbc', KEY, IV);
        decipher.setAutoPadding(false);

        let decrypted = Buffer.concat([decipher.update(encryptedBytes), decipher.final()]);
        const padLen = decrypted[decrypted.length - 1];
        if (padLen >= 1 && padLen <= 16) decrypted = decrypted.subarray(0, decrypted.length - padLen);

        const data = JSON.parse(decrypted.toString('utf-8'));
        const hls = data['cf'];
        
        if (hls) {
            let finalUrl = hls;
            if (mfpUrl) {
                const proxyBase = mfpUrl.replace(/\/+$/, '');
                const params = new URLSearchParams();
                params.append('d', hls);
                if (mfpPsw) params.append('api_password', mfpPsw);
                params.append('h_Referer', playerUrl);
                params.append('h_User-Agent', UA);
                finalUrl = `${proxyBase}/proxy/hls/manifest.m3u8?${params.toString()}`;
            }

            return {
                name: `🍿 GuardaSerie\n⚡ LoadM`,
                title: generateRichDescription(meta, "LoadM", "HD"),
                url: finalUrl,
                behaviorHints: {
                    notWebReady: false,
                    bingieGroup: "guardaserie-loadm",
                    proxyHeaders: { request: { "Referer": playerUrl } }
                }
            };
        }
    } catch (e) { return null; }
    return null;
}

// --- RICERCA ---
async function searchGuardoserie(client, targetDomain, query, imdbId) {
    if (imdbId && imdbId.startsWith('tt')) {
        try {
            const searchUrl = `${targetDomain}/?story=${imdbId}&do=search&subaction=search`;
            const res = await client.get(searchUrl);
            const $ = cheerio.load(res.data);
            let href = null;
            $('.mlnh-2 h2 a, .mlnew h2 a, .movie-item a').each((_, el) => {
                if (!href) href = $(el).attr('href');
            });
            if (href) return href;
        } catch (e) {}
    }

    try {
        const simpleSearchUrl = `${targetDomain}/?s=${encodeURIComponent(query)}`;
        const res = await client.get(simpleSearchUrl);
        const $ = cheerio.load(res.data);
        const candidates = [];
        $('.mlnh-2 h2 a, .mlnew h2 a').each((_, el) => {
            const href = $(el).attr('href');
            const text = $(el).text().trim();
            if (href && text) candidates.push({ href, text });
        });
        const match = candidates.find(c => {
            const t = c.text.toLowerCase().replace(/[^a-z0-9]/g, '');
            const q = query.toLowerCase().replace(/[^a-z0-9]/g, '');
            return t.includes(q) || q.includes(t);
        });
        return match ? match.href : null;
    } catch (e) { return null; }
}

// --- CORE: RISOLUZIONE OTTIMIZZATA ---
async function resolvePageStream(client, pageUrl, mfpUrl, mfpPsw, meta) {
    const streams = [];
    const { season, episode } = meta;

    try {
        const res = await client.get(pageUrl);
        const $ = cheerio.load(res.data);
        const links = new Set();
        let foundSpecific = false;

        if (season && episode) {
            // TENTATIVO 1: ID SPECIFICO
            const ids = [
                `serie-${season}_${episode}`, 
                `serie-${season}_0${episode}`,
                `serie-${parseInt(season)}_${parseInt(episode)}`
            ];
            
            for (const id of ids) {
                const targetEl = $(`#${id}`);
                if (targetEl.length > 0) {
                    foundSpecific = true;
                    const direct = targetEl.attr('data-link') || targetEl.attr('href');
                    if (direct && direct.length > 5) links.add(direct);
                    
                    const parentLi = targetEl.closest('li');
                    parentLi.find('[data-link]').each((_, el) => {
                        const l = $(el).attr('data-link');
                        if(l) links.add(l);
                    });
                }
            }
        }

        // TENTATIVO 2: FALLBACK (Se non abbiamo trovato nulla con gli ID)
        if (links.size === 0) {
            $('iframe').each((_, el) => links.add($(el).attr('src') || $(el).attr('data-src')));
            $('[data-link]').each((_, el) => links.add($(el).attr('data-link')));
        }

        // --- OTTIMIZZAZIONE VELOCITA' ---
        // Convertiamo il Set in Array e prendiamo SOLO I PRIMI 6.
        // Se non è nei primi 6, probabilmente è spazzatura o troppo in fondo.
        // Questo evita di fare 30 richieste HTTP per una sola pagina.
        const candidates = Array.from(links)
            .filter(l => l && (l.includes('dropload') || l.includes('loadm')))
            .slice(0, 6); // <--- LIMITE MASSIMO DI ANALISI

        const processingPromises = candidates.map(async (link) => {
            if (link.startsWith('//')) link = 'https:' + link;
            if (link.startsWith('/')) link = new URL(link, pageUrl).href;

            if (link.includes('dropload')) {
                return await extractDropload(client, link, pageUrl, mfpUrl, mfpPsw, meta);
            } else if (link.includes('loadm')) {
                return await extractLoadM(client, link, pageUrl, mfpUrl, mfpPsw, meta);
            }
            return null;
        });

        const results = await Promise.allSettled(processingPromises);
        
        // --- DEDUPLICAZIONE ---
        const uniqueKeys = new Set();
        results.forEach(res => {
            if (res.status === 'fulfilled' && res.value) {
                const stream = res.value;
                const uniqueKey = `${stream.name}|${stream.title}`;
                if (!uniqueKeys.has(uniqueKey)) {
                    uniqueKeys.add(uniqueKey);
                    streams.push(stream);
                }
            }
        });

    } catch (e) {
        console.error(`[GS] Resolve error: ${e.message}`);
    }
    return streams;
}

// --- ENTRY POINT ---
async function searchGuardaserie(meta, config) {
    if (!meta || !meta.isSeries) return []; 
    if (!config.filters || !config.filters.enableGs) return [];

    const targetDomain = getTargetDomain(config);
    const client = createClient(targetDomain);
    const mfpUrl = config.mediaflow ? config.mediaflow.url : null;
    const mfpPsw = config.mediaflow ? config.mediaflow.pass : null;

    try {
        const seriesUrl = await searchGuardoserie(client, targetDomain, meta.title, meta.imdb_id);
        if (!seriesUrl) return [];

        return await resolvePageStream(client, seriesUrl, mfpUrl, mfpPsw, meta);

    } catch (e) {
        console.error(`🍿️ [GS] Critical: ${e.message}`);
        return [];
    }
}

module.exports = { searchGuardaserie };
