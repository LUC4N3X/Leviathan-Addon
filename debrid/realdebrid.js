const axios = require("axios");
const https = require("https");

const RD_API_BASE = "https://api.real-debrid.com/rest/1.0";
const RD_TIMEOUT = 30000; // 30 Secondi timeout
const MAX_POLL = 30;      // Più tentativi di attesa (per file grossi/conversioni)
const POLL_DELAY = 1000;  // 1 secondo tra i check

// HTTP AGENT per ottimizzare le performance delle richieste
const httpsAgent = new https.Agent({ 
    keepAlive: true, 
    maxSockets: 64, 
    keepAliveMsecs: 30000 
});

const rdClient = axios.create({
    baseURL: RD_API_BASE,
    timeout: RD_TIMEOUT,
    httpsAgent: httpsAgent,
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
});

/* =========================================================================
   HELPER E STATI
   ========================================================================= */

function sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
}

function isVideo(path) {
    return /\.(mkv|mp4|avi|mov|wmv|flv|webm|m4v|ts|m2ts|mpg|mpeg)$/i.test(path);
}

// Stati di Real-Debrid normalizzati
const Status = {
    ERROR: (s) => ['error', 'magnet_error'].includes(s),
    WAITING_SELECTION: (s) => s === 'waiting_files_selection',
    DOWNLOADING: (s) => ['downloading', 'uploading', 'queued'].includes(s),
    READY: (s) => ['downloaded', 'dead'].includes(s),
};

/* =========================================================================
   MATCHING LEVIATHAN (Fix Episodi Sbagliati & Supporto FileIdx)
   ========================================================================= */
function matchFile(files, season, episode, fileIdx) {
    if (!files || files.length === 0) return null;

    // 1. Filtra solo video e rimuovi sample/trailer
    const videoFiles = files.filter(f => isVideo(f.path) && !/sample|trailer|featurette/i.test(f.path));
    if (videoFiles.length === 0) return null;
    
    // 2. PRIORITÀ ASSOLUTA: Se abbiamo un fileIdx numerico valido dal DB, usiamo quello bypassando le regex
    if (fileIdx !== undefined && fileIdx !== null && String(fileIdx) !== "-1") {
        const exactMatch = videoFiles.find(v => String(v.id) === String(fileIdx));
        if (exactMatch) return exactMatch.id;
    }

    // CASO A: FILM (Nessuna Stagione/Episodio) -> Prendi il file più grande (Main Movie)
    if (!season && !episode) {
        return videoFiles.sort((a,b) => b.bytes - a.bytes)[0].id;
    }

    // CASO B: SERIE TV & ANIME
    const s = parseInt(season);
    const e = parseInt(episode);
    
    // Regex rigorose (dalla più precisa alla più generica)
    const strictRegex = [
        new RegExp(`\\bs0?${s}\\s*e0?${e}\\b`, "i"), // S01E01
        new RegExp(`\\b${s}x0?${e}\\b`, "i"), // 1x01
        new RegExp(`(?:Stagione|Season)\\s*0?${s}.*?(?:Episodio|Episode|Ep)\\s*0?${e}\\b`, "i"), // Stagione 1 Episodio 1
        new RegExp(`\\b(?:ep|episode|e)\\s*0*${e}\\b`, "i") // Numerazione assoluta (Anime)
    ];

    // 1. Cerca match esatto
    for (const rx of strictRegex) {
        const found = videoFiles.find(v => rx.test(v.path));
        if (found) return found.id;
    }

    // 2. Logic "Single File Safety": Se c'è UN SOLO file video
    if (videoFiles.length === 1) {
        return videoFiles[0].id;
    }

    // 3. Fallback "Smart Match" per Pack complessi
    const looseMatch = videoFiles.find(v => {
        let pathLower = v.path.toLowerCase();
        
        // 🔥 FONDAMENTALE: Rimuoviamo i tag audio/video che causano i falsi positivi (es. 5.1 per Ep 1)
        pathLower = pathLower.replace(/5\.1|7\.1|2\.0|h264|x264|h265|x265/gi, "");

        const hasSeason = new RegExp(`\\b(?:season|stagione|s)0?${s}\\b`, 'i').test(pathLower);
        const hasEpisode = new RegExp(`(?:ep|e)?[\\s\\_\\-]*\\b0?${e}\\b`).test(pathLower);
        
        return hasSeason && hasEpisode;
    });

    if (looseMatch) return looseMatch.id;

    // Se fallisce tutto, ritorna null (meglio errore che episodio sbagliato)
    return null; 
}

/* =========================================================================
   RICHIESTA HTTP ROBUSTA (Anti-Ban & Retry con Log)
   ========================================================================= */
async function rdRequest(method, endpoint, token, data = null) {
    let attempt = 0;
    const maxAttempts = 3;

    while (attempt < maxAttempts) {
        try {
            const config = {
                method,
                url: endpoint,
                headers: { Authorization: `Bearer ${token}` },
                data
            };
            const res = await rdClient(config);
            return res.data;
        } catch (e) {
            const st = e.response?.status;
            
            // Errori Fatali (Non riprovare)
            if (st === 401 || st === 403) {
                console.error(`[RD AUTH] Token invalido o scaduto.`);
                return null;
            }
            if (st === 404) return null; // Risorsa non trovata
            
            // Errori Temporanei (Riprova con backoff)
            if (st === 429 || st >= 500 || e.code === 'ECONNABORTED') {
                const isRateLimit = st === 429;
                const waitTime = isRateLimit ? (2000 + (attempt * 1000)) : 1000;
                
                if (isRateLimit) console.warn(`[RD 429] Rate Limit Hit. Pausa tattica di ${waitTime}ms...`);
                
                await sleep(waitTime);
                attempt++;
                continue;
            }

            // Errore sconosciuto
            console.error(`[RD ERROR] ${endpoint} -> ${e.message}`);
            return null;
        }
    }
    return null;
}

/* =========================================================================
   CORE MODULE
   ========================================================================= */
const RD = {

    deleteTorrent: async (token, id) => {
        try {
            await rdRequest("DELETE", `/torrents/delete/${id}`, token);
        } catch {}
    },

    /**
     * LEVIATHAN CACHE CHECK (Ottimizzato)
     */
    checkCacheLeviathan: async (token, magnet, hash) => {
        let torrentId = null;
        try {
            const body = new URLSearchParams();
            body.append("magnet", magnet);
            
            const add = await rdRequest("POST", "/torrents/addMagnet", token, body);
            if (!add?.id) return { cached: false, hash };
            torrentId = add.id;

            let info = await rdRequest("GET", `/torrents/info/${torrentId}`, token);
            if (!info) {
                await RD.deleteTorrent(token, torrentId);
                return { cached: false, hash };
            }

            if (Status.WAITING_SELECTION(info.status)) {
                const sel = new URLSearchParams();
                sel.append("files", "all");
                await rdRequest("POST", `/torrents/selectFiles/${torrentId}`, token, sel);
                info = await rdRequest("GET", `/torrents/info/${torrentId}`, token);
            }

            const isCached = Status.READY(info.status);
            
            let mainFile = null;
            if (info?.files) {
                 const videoFiles = info.files.filter(f => isVideo(f.path)).sort((a, b) => b.bytes - a.bytes);
                 if (videoFiles.length > 0) mainFile = videoFiles[0];
            }

            await RD.deleteTorrent(token, torrentId);

            return {
                hash,
                cached: isCached,
                filename: mainFile ? (mainFile.path.split('/').pop()) : null,
                filesize: mainFile ? mainFile.bytes : null
            };

        } catch (e) {
            if (torrentId) await RD.deleteTorrent(token, torrentId);
            return { cached: false, hash, error: e.message };
        }
    },

    /**
     * GET STREAM LINK (Engine Principale - Patchato)
     */
    getStreamLink: async (token, magnet, season = null, episode = null, fileIdx = undefined) => {
        let torrentId = null;
        let requiresDelete = true; 

        try {
            /* 1️⃣ CHECK INTELLIGENTE ESISTENTE */
            const activeTorrents = await rdRequest("GET", "/torrents", token);
            const magnetHashMatch = magnet.match(/btih:([a-zA-Z0-9]+)/i);
            const targetHash = magnetHashMatch ? magnetHashMatch[1].toLowerCase() : null;

            let existing = null;
            if (targetHash && Array.isArray(activeTorrents)) {
                existing = activeTorrents.find(t => t.hash.toLowerCase() === targetHash && !Status.ERROR(t.status));
            }

            if (existing) {
                torrentId = existing.id;
                requiresDelete = false; 
            } else {
                const body = new URLSearchParams();
                body.append("magnet", magnet);
                const add = await rdRequest("POST", "/torrents/addMagnet", token, body);
                
                if (!add?.id) throw new Error("Magnet add failed");
                torrentId = add.id;
            }

            /* 2️⃣ POLLING */
            let info = await rdRequest("GET", `/torrents/info/${torrentId}`, token);
            let pollCount = 0;
            while (info && info.status === 'magnet_conversion' && pollCount < 5) {
                await sleep(1000);
                info = await rdRequest("GET", `/torrents/info/${torrentId}`, token);
                pollCount++;
            }

            if (!info) throw new Error("Info retrieval failed");

            /* 3️⃣ SELEZIONE FILE (Matching Blindato) */
            if (Status.WAITING_SELECTION(info.status)) {
                let fileId = "all";
                
                // USIAMO IL MATCH FILE AGGIORNATO (ora accetta fileIdx)
                if (info.files) {
                    const m = matchFile(info.files, season, episode, fileIdx);
                    if (m) fileId = m;
                    else if (season && episode) {
                        // Se cerco un episodio e non lo trovo, seleziono 'all' per cacheare tutto il pack
                        fileId = "all";
                    }
                }

                const sel = new URLSearchParams();
                sel.append("files", fileId);
                await rdRequest("POST", `/torrents/selectFiles/${torrentId}`, token, sel);

                for (let i = 0; i < MAX_POLL; i++) {
                    await sleep(POLL_DELAY);
                    info = await rdRequest("GET", `/torrents/info/${torrentId}`, token);
                    if (Status.READY(info?.status)) break;
                    if (Status.DOWNLOADING(info?.status) && info.progress === 100) break; 
                }
            }

            /* 4️⃣ VERIFICA FINALE */
            if (!Status.READY(info.status)) {
                if (requiresDelete) await RD.deleteTorrent(token, torrentId);
                return null;
            }

            /* 5️⃣ IDENTIFICAZIONE LINK TARGET */
            // Usiamo di nuovo matchFile per trovare il link esatto tra quelli pronti
            const targetFileId = matchFile(info.files, season, episode, fileIdx);
            let targetLink = null;

            if (targetFileId) {
                const selectedFiles = info.files.filter(f => f.selected === 1);
                const linkIndex = selectedFiles.findIndex(f => f.id === targetFileId);
                if (linkIndex !== -1 && info.links[linkIndex]) {
                    targetLink = info.links[linkIndex];
                }
            }
            
            // Fallback: se non trovo il file specifico (e non ho chiesto S/E), prendo il primo
            if (!targetLink && (!season && !episode) && info.links.length > 0) {
                targetLink = info.links[0];
            }

            if (!targetLink) throw new Error("No link found or Series Mismatch");

            /* 6️⃣ UNRESTRICT */
            const uBody = new URLSearchParams();
            uBody.append("link", targetLink);
            const unrestrict = await rdRequest("POST", "/unrestrict/link", token, uBody);

            /* 🧹 CLEANUP */
            if (requiresDelete) await RD.deleteTorrent(token, torrentId);

            if (!unrestrict?.download) return null;

            return {
                type: "ready",
                url: unrestrict.download,
                filename: unrestrict.filename,
                size: unrestrict.filesize
            };

        } catch (e) {
            if (torrentId && requiresDelete) await RD.deleteTorrent(token, torrentId);
            return null;
        }
    },

    /**
     * CONTROLLO DISPONIBILITÀ ISTANTANEA 
     */
    checkInstantAvailability: async (token, hashes) => {
        try {
            return await rdRequest("GET", `/torrents/instantAvailability/${hashes.join("/")}`, token) || {};
        } catch { return {}; }
    }
};

module.exports = RD;
