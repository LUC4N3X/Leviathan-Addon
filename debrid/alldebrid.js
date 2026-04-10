const axios = require("axios");
const AD_BASE = "https://api.alldebrid.com/v4";
const AGENT = "CorsaroBrain"; // AllDebrid richiede un agent

// --- Helper Match File (Copia della logica di RD) ---
function matchFile(files, season, episode) {
    if (!files || !season || !episode) return null;
    const s = parseInt(season);
    const e = parseInt(episode);
    const sStr = s.toString().padStart(2, '0'); // "01"
    
    // Filtro video
    const videoFiles = files.filter(f => /\.(mkv|mp4|avi|mov|wmv|flv|webm)$/i.test(f.n) && !/sample/i.test(f.n));
    if (videoFiles.length === 0) return null;

    // Regex Priority
    const regexStandard = new RegExp(`S0*${s}.*?E0*${e}\\b`, 'i');
    const regexX = new RegExp(`\\b${s}x0*${e}\\b`, 'i');
    const compactNum = `${s}${e.toString().padStart(2,'0')}`; 
    const regexCompact = new RegExp(`(^|\\D)${compactNum}(\\D|$)`);
    
    let found = videoFiles.find(f => regexStandard.test(f.n));
    if (!found) found = videoFiles.find(f => regexX.test(f.n));
    if (!found && s < 100) found = videoFiles.find(f => regexCompact.test(f.n));

    // Ritorna l'intero oggetto file (AD usa indici o ID specifici, qui ritorniamo il file per estrarre il link)
    return found;
}

const AD = {
    getStreamLink: async (key, magnet, season = null, episode = null) => {
        try {
            // 1. Upload Magnet
            const uploadUrl = `${AD_BASE}/magnet/upload?agent=${AGENT}&apikey=${key}&magnets[]=${encodeURIComponent(magnet)}`;
            const upRes = await axios.get(uploadUrl);
            
            if (upRes.data.status !== 'success') return null;
            const magnetData = upRes.data.data.magnets[0];
            const magnetId = magnetData.id;

            // Se è già pronto ("Ready"), bene. Altrimenti per lo streaming istantaneo falliamo (AD richiede tempo se non è cached)
            // Nota: AD spesso ritorna "Ready" subito se è in cache.
            
            // 2. Ottieni Status & File List
            const statusUrl = `${AD_BASE}/magnet/status?agent=${AGENT}&apikey=${key}&id=${magnetId}`;
            const stRes = await axios.get(statusUrl);
            const info = stRes.data.data.magnets; // È un oggetto o array

            if (!info || info.status !== 'Ready') {
                // Pulizia se non pronto (opzionale)
                await axios.get(`${AD_BASE}/magnet/delete?agent=${AGENT}&apikey=${key}&id=${magnetId}`);
                return null;
            }

            // 3. Selezione File
            let selectedFile = null;
            if (season && episode && info.links) {
                // Mappa formato AD (n: filename, l: link)
                // info.links struttura varia, spesso è un array di oggetti { filename, link, size }
                selectedFile = matchFile(info.links, season, episode);
            }

            // Fallback: file più grande
            if (!selectedFile && info.links) {
                 selectedFile = info.links.sort((a, b) => b.size - a.size)[0];
            }

            if (!selectedFile || !selectedFile.link) return null;

            // 4. Unlock Link (Unrestrict)
            const unlockUrl = `${AD_BASE}/link/unlock?agent=${AGENT}&apikey=${key}&link=${encodeURIComponent(selectedFile.link)}`;
            const unRes = await axios.get(unlockUrl);

            if (unRes.data.status === 'success') {
                const resolvedSize = Number(unRes?.data?.data?.filesize) || Number(selectedFile?.size) || 0;
                return {
                    type: 'ready',
                    url: unRes.data.data.link,
                    filename: unRes.data.data.filename,
                    size: resolvedSize,
                    file_size: resolvedSize || null
                };
            }
            return null;

        } catch (e) {
            console.error("AD Error:", e.message);
            return null;
        }
    }
};

module.exports = AD;
