(() => {
    'use strict';

    const MAGNET_RE = /magnet:\?xt=urn:btih:[^\s"'<>]+/gi;
    const INFO_HASH_RE = /urn:btih:([a-f0-9]{40}|[a-z2-7]{32})/i;
    const APP_ID = 'leviathan-companion-app';
    const BUTTON_ID = 'leviathan-companion-button';
    const MODAL_ID = 'leviathan-companion-modal';
    const STYLE_ID = 'leviathan-companion-style';
    const TMDB_POSTER_BASE = 'https://image.tmdb.org/t/p/w185';

    let observerStarted = false;
    let lastMagnetCount = -1;
    let sessionAdminPass = '';
    const state = {
        addonBaseUrl: '',
        magnet: '',
        title: '',
        sourceTitle: '',
        provider: '',
        type: 'movie',
        season: '',
        episode: '',
        imdbId: '',
        tmdbId: '',
        scanRd: true,
        apiKey: '',
        candidates: [],
        status: '',
        statusKind: 'idle'
    };

    function escapeHtml(value) {
        return String(value ?? '').replace(/[&<>"]/g, (char) => ({
            '&': '&amp;',
            '<': '&lt;',
            '>': '&gt;',
            '"': '&quot;'
        }[char]));
    }

    function normalizeBaseUrl(value) {
        return String(value || '').trim().replace(/\/+$/, '');
    }

    function extractHash(magnet) {
        const match = String(magnet || '').match(INFO_HASH_RE);
        return match ? match[1].toUpperCase() : null;
    }

    function uniqueByHash(magnets) {
        const seen = new Set();
        const out = [];
        for (const magnet of magnets) {
            const normalized = String(magnet || '').trim();
            const hash = extractHash(normalized) || normalized;
            const key = hash.toUpperCase();
            if (!normalized || seen.has(key)) continue;
            seen.add(key);
            out.push(normalized);
        }
        return out;
    }

    function getHtmlMagnets() {
        const html = String(document.documentElement?.innerHTML || '');
        return html.match(MAGNET_RE) || [];
    }

    function findMagnets() {
        const hrefMagnets = [...document.querySelectorAll('a[href]')]
            .map((node) => node.getAttribute('href') || node.href || '')
            .filter((href) => /^magnet:\?/i.test(href));
        const bodyMagnets = String(document.body?.innerText || '').match(MAGNET_RE) || [];
        return uniqueByHash([...hrefMagnets, ...bodyMagnets, ...getHtmlMagnets()]);
    }

    function getUrlTitleGuess() {
        try {
            const url = new URL(location.href);
            const values = [url.searchParams.get('name'), url.searchParams.get('title'), url.searchParams.get('q')].filter(Boolean);
            if (values[0]) return decodeURIComponent(values[0]);
        } catch (_) {}
        return '';
    }

    function extractTitleFromMagnet(magnet) {
        try {
            const params = new URLSearchParams(String(magnet || '').replace(/^magnet:\?/i, ''));
            const dn = params.get('dn');
            if (dn) return dn.trim();
        } catch (_) {}
        return getUrlTitleGuess() || document.querySelector('h1')?.textContent?.trim() || document.title || extractHash(magnet) || 'Manual contribution';
    }

    function cleanReleaseTitle(value) {
        let title = String(value || '')
            .replace(/^risultato[.:\s-]*/i, '')
            .replace(/\.[a-z0-9]{2,5}$/i, ' ')
            .replace(/[._+]+/g, ' ')
            .replace(/\[[^\]]*\]|\([^)]*\)/g, ' ')
            .replace(/\bS\d{1,2}E\d{1,3}\b/ig, ' ')
            .replace(/\b\d{1,2}x\d{1,3}\b/ig, ' ')
            .replace(/\b(?:2160p|1080p|720p|480p|4k|uhd|hdr10?|dv|dolby\s*vision|web[- ]?dl|webrip|bluray|blu[- ]?ray|bdrip|hdtv|dvdrip|remux|x264|x265|h264|h265|hevc|avc|aac|ac3|dts|ddp?5?\.?1|ita|eng|fre|french|multi|sub(?:bed)?|proper|repack|extended|unrated|internal|cyber|dr4g|mircrew|rarbg|tgx|torrentgalaxy)\b/ig, ' ')
            .replace(/\b(?:19|20)\d{2}\b/g, ' ')
            .replace(/[-–—|].*$/, ' ')
            .replace(/\s+/g, ' ')
            .trim();
        return title || String(value || '').trim();
    }

    function extractSeasonEpisode(value) {
        const raw = String(value || '');
        const direct = raw.match(/S(\d{1,2})E(\d{1,3})/i) || raw.match(/(\d{1,2})x(\d{1,3})/i);
        if (!direct) return { season: '', episode: '' };
        return { season: String(Number(direct[1])), episode: String(Number(direct[2])) };
    }

    function detectSourceProvider() {
        const host = String(location.hostname || '').replace(/^www\./i, '').toLowerCase();
        const title = String(document.title || '').toLowerCase();
        const haystack = `${host} ${title}`;
        if (/bt4g|b\d+gprx|downloadtorrentfile/.test(haystack)) return 'BT4G';
        if (/1337x/.test(haystack)) return '1337x';
        if (/rarbg/.test(haystack)) return 'RARBG';
        if (/torrentgalaxy|tgx/.test(haystack)) return 'TorrentGalaxy';
        if (/ilcorsaronero|corsaro/.test(haystack)) return 'ilCorSaRoNeRo';
        if (/thepiratebay|piratebay/.test(haystack)) return 'ThePirateBay';
        const first = host.split('.')[0];
        return first ? first.replace(/[^a-z0-9_-]+/gi, '').slice(0, 32) || 'LEVIATHAN_COMPANION' : 'LEVIATHAN_COMPANION';
    }


    function isTorrentLikePage(magnets = null) {
        const foundMagnets = Array.isArray(magnets) ? magnets : findMagnets();
        if (foundMagnets.length > 0) return true;

        const host = String(location.hostname || '').replace(/^www\./i, '').toLowerCase();
        const path = String(location.pathname || '').toLowerCase();
        const title = String(document.title || '').toLowerCase();
        const url = String(location.href || '').toLowerCase();
        const text = String(document.body?.innerText || '').slice(0, 18000).toLowerCase();
        const haystack = `${host} ${path} ${title} ${url}`;

        const knownTorrentHost = /(?:^|\.)(?:1337x|bt4g|btdig|bitsearch|torrentgalaxy|tgx|torrentdownloads|torrentdownload|downloadtorrentfile|limetorrents|torlock|magnetdl|eztv|yts|nyaa|rarbg|rutracker|kickasstorrents|ilcorsaronero|corsaronero|thepiratebay|piratebay|snowfl|zooqle)(?:\.|$)/i.test(host)
            || /b\d+gprx|1337x|torrent|magnet|bt4g|btdig|ilcorsaronero|corsaro|piratebay/i.test(host);

        const torrentRoute = /(?:^|\/)(?:torrent|magnet|download|scarica|details?|movie|serie|search)(?:\/|$)/i.test(path)
            || /(?:\?|&)(?:dn|xt|infohash|hash|magnet|torrent|name)=/i.test(url);

        const torrentTextSignals = [
            'magnet',
            'link magnetico',
            'download torrent',
            'torrent file',
            'scarica torrent',
            'seeders',
            'leechers',
            'seminatrici',
            'sanguisughe',
            'infohash',
            'hash torrent',
            'download tramite torrent'
        ];
        const signalCount = torrentTextSignals.reduce((count, token) => count + (text.includes(token) ? 1 : 0), 0);

        return knownTorrentHost && (torrentRoute || signalCount >= 1);
    }

    async function getStored(keys) {
        if (typeof chrome === 'undefined' || !chrome.storage?.sync) return {};
        return chrome.storage.sync.get(keys);
    }

    async function setStored(values) {
        if (typeof chrome === 'undefined' || !chrome.storage?.sync) return;
        await chrome.storage.sync.set(values);
    }

    function ensureStyles() {
        if (document.getElementById(STYLE_ID)) return;
        const style = document.createElement('style');
        style.id = STYLE_ID;
        style.textContent = `
            #${APP_ID}, #${APP_ID} * { box-sizing: border-box; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
            #${APP_ID} { position: fixed; inset: auto 18px 18px auto; z-index: 2147483646; color: #eef8ff; }
            #${BUTTON_ID} {
                display:flex; align-items:center; gap:10px; border:1px solid rgba(94,234,212,.42);
                border-radius:999px; padding:12px 15px; color:#f8fbff;
                background:linear-gradient(135deg, rgba(5,25,45,.98), rgba(9,82,104,.96) 52%, rgba(7,89,133,.98));
                box-shadow:0 18px 55px rgba(0,0,0,.45), 0 0 0 1px rgba(255,255,255,.08) inset, 0 0 28px rgba(20,184,166,.18);
                cursor:pointer; font-weight:900; letter-spacing:.01em; backdrop-filter: blur(18px);
                transition: transform .16s ease, box-shadow .16s ease, border-color .16s ease;
            }
            #${BUTTON_ID}:hover { transform: translateY(-2px); border-color:rgba(125,211,252,.78); box-shadow:0 24px 70px rgba(0,0,0,.55), 0 0 38px rgba(14,165,233,.26); }
            .levi-dot { width:11px; height:11px; border-radius:999px; background:#22c55e; box-shadow:0 0 20px #22c55e; }
            .levi-count { font-size:12px; padding:3px 8px; border-radius:999px; background:rgba(255,255,255,.14); color:#e0f2fe; }

            #${MODAL_ID} {
                position:fixed; inset:0; z-index:2147483647; display:flex; align-items:center; justify-content:center; padding:18px;
                background:
                    radial-gradient(circle at 14% 12%, rgba(56,189,248,.26), transparent 34%),
                    radial-gradient(circle at 85% 78%, rgba(20,184,166,.18), transparent 32%),
                    linear-gradient(180deg, rgba(2,6,23,.82), rgba(0,0,0,.74));
                backdrop-filter: blur(12px) saturate(1.1);
            }
            .levi-shell {
                width:min(1120px, calc(100vw - 24px));
                height:min(92vh, 850px);
                min-height:560px;
                display:flex; flex-direction:column; overflow:hidden;
                border:1px solid rgba(125,211,252,.28); border-radius:30px;
                background:
                    linear-gradient(180deg, rgba(3,20,36,.98), rgba(4,10,24,.98) 42%, rgba(2,6,23,.98)),
                    radial-gradient(circle at 25% 0%, rgba(14,165,233,.2), transparent 45%);
                box-shadow:0 34px 120px rgba(0,0,0,.68), 0 0 0 1px rgba(255,255,255,.07) inset, 0 0 80px rgba(14,165,233,.12);
                position:relative;
            }
            .levi-shell:before {
                content:""; position:absolute; inset:0; pointer-events:none; opacity:.38;
                background:
                    linear-gradient(120deg, transparent 0 30%, rgba(125,211,252,.08) 31%, transparent 33% 100%),
                    radial-gradient(circle at 50% -16%, rgba(255,255,255,.15), transparent 28%);
                animation: levi-current 7s ease-in-out infinite alternate;
            }
            @keyframes levi-current { from { transform: translate3d(-8px,0,0); } to { transform: translate3d(10px,0,0); } }

            .levi-header {
                flex:0 0 auto; position:relative; z-index:1;
                display:flex; align-items:center; justify-content:space-between; gap:18px;
                padding:20px 24px 18px; border-bottom:1px solid rgba(148,163,184,.16);
                background:
                    linear-gradient(135deg, rgba(12,74,110,.52), rgba(15,23,42,.28)),
                    radial-gradient(circle at 8% 10%, rgba(45,212,191,.24), transparent 34%);
            }
            .levi-brand { display:flex; align-items:center; gap:15px; min-width:0; }
            .levi-logo-wrap {
                width:58px; height:58px; border-radius:20px; display:grid; place-items:center;
                background:linear-gradient(135deg, rgba(14,165,233,.2), rgba(20,184,166,.16));
                box-shadow:0 0 26px rgba(14,165,233,.2), 0 1px 0 rgba(255,255,255,.1) inset;
                border:1px solid rgba(125,211,252,.22); overflow:hidden; flex:0 0 auto;
            }
            .levi-logo { width:66px; height:66px; object-fit:cover; transform:scale(1.08); }
            .levi-title { font-size:25px; font-weight:1000; line-height:1.04; margin:0 0 7px; letter-spacing:.01em; color:#f8fbff; text-shadow:0 0 24px rgba(56,189,248,.18); }
            .levi-subtitle { color:#b8d7ea; font-size:13px; line-height:1.35; max-width:760px; }
            .levi-close { border:0; color:#e0f2fe; background:rgba(255,255,255,.09); border-radius:16px; width:44px; height:44px; cursor:pointer; font-size:26px; font-weight:900; flex:0 0 auto; }
            .levi-close:hover { background:rgba(248,113,113,.16); color:#fff; }

            .levi-body {
                flex:1 1 auto; min-height:0; position:relative; z-index:1;
                display:grid; grid-template-columns: minmax(0, 1.02fr) minmax(360px, .98fr);
                gap:16px; padding:18px 20px; overflow:auto; scrollbar-width:thin; scrollbar-color:rgba(125,211,252,.55) rgba(15,23,42,.5);
            }
            .levi-body::-webkit-scrollbar, .levi-candidates::-webkit-scrollbar, .levi-textarea::-webkit-scrollbar { width:9px; height:9px; }
            .levi-body::-webkit-scrollbar-thumb, .levi-candidates::-webkit-scrollbar-thumb, .levi-textarea::-webkit-scrollbar-thumb { background:rgba(125,211,252,.45); border-radius:999px; }
            .levi-body::-webkit-scrollbar-track, .levi-candidates::-webkit-scrollbar-track, .levi-textarea::-webkit-scrollbar-track { background:rgba(15,23,42,.55); border-radius:999px; }
            .levi-column { display:flex; flex-direction:column; gap:16px; min-width:0; }
            .levi-card {
                border:1px solid rgba(148,163,184,.17); border-radius:24px;
                background:linear-gradient(180deg, rgba(15,23,42,.72), rgba(2,6,23,.56));
                box-shadow:0 1px 0 rgba(255,255,255,.06) inset, 0 20px 50px rgba(0,0,0,.13);
                padding:16px;
            }
            .levi-card.highlight { border-color:rgba(56,189,248,.3); background:linear-gradient(180deg, rgba(8,47,73,.72), rgba(2,6,23,.62)); }
            .levi-card h3 { margin:0 0 12px; font-size:13px; text-transform:uppercase; letter-spacing:.11em; color:#93c5fd; display:flex; align-items:center; gap:8px; }
            .levi-card h3 span { color:#5eead4; }

            .levi-field { display:flex; flex-direction:column; gap:7px; margin-bottom:12px; }
            .levi-field label { font-size:12px; color:#c4d9ed; font-weight:800; }
            .levi-input, .levi-select, .levi-textarea {
                width:100%; border:1px solid rgba(148,163,184,.25); border-radius:16px; padding:12px 13px;
                color:#f8fafc; background:rgba(2,6,23,.66); outline:none; font-weight:650;
                box-shadow:0 1px 0 rgba(255,255,255,.04) inset;
            }
            .levi-select { appearance:auto; }
            .levi-textarea { min-height:82px; max-height:130px; resize:vertical; font-family:ui-monospace, SFMono-Regular, Menlo, monospace; font-size:12px; line-height:1.35; }
            .levi-input:focus, .levi-select:focus, .levi-textarea:focus { border-color:rgba(56,189,248,.75); box-shadow:0 0 0 3px rgba(56,189,248,.14), 0 0 28px rgba(14,165,233,.12); }
            .levi-grid2 { display:grid; grid-template-columns:1fr 1fr; gap:12px; }
            .levi-grid3 { display:grid; grid-template-columns:1fr 1fr 1fr; gap:12px; }

            .levi-actions { display:flex; flex-wrap:wrap; gap:10px; align-items:center; }
            .levi-btn {
                border:0; border-radius:16px; padding:12px 15px; color:#fff;
                background:linear-gradient(135deg,#0284c7,#0f766e);
                font-weight:950; cursor:pointer; box-shadow:0 12px 34px rgba(2,132,199,.24);
                transition: transform .14s ease, filter .14s ease, box-shadow .14s ease;
            }
            .levi-btn:hover { transform:translateY(-1px); filter:brightness(1.08); box-shadow:0 16px 44px rgba(2,132,199,.32); }
            .levi-btn.secondary { background:rgba(255,255,255,.1); color:#dbeafe; box-shadow:none; border:1px solid rgba(148,163,184,.18); }
            .levi-btn.big { padding:14px 18px; border-radius:18px; font-size:15px; min-width:190px; background:linear-gradient(135deg,#06b6d4,#0f766e 55%,#115e59); }
            .levi-btn:disabled { opacity:.55; cursor:not-allowed; }
            .levi-chipline { display:flex; flex-wrap:wrap; gap:8px; margin-top:10px; }
            .levi-chip { border:1px solid rgba(125,211,252,.26); background:rgba(14,165,233,.12); color:#d6f6ff; padding:6px 10px; border-radius:999px; font-size:12px; font-weight:850; }

            .levi-candidates { display:flex; flex-direction:column; gap:10px; max-height:520px; overflow:auto; padding-right:4px; }
            .levi-candidate {
                display:grid; grid-template-columns:62px 1fr auto; gap:12px; align-items:center;
                border:1px solid rgba(148,163,184,.14); border-radius:20px; padding:10px;
                background:rgba(2,6,23,.44); cursor:pointer; transition: border .15s ease, transform .15s ease, background .15s ease;
            }
            .levi-candidate:hover, .levi-candidate.selected { border-color:rgba(56,189,248,.7); background:rgba(14,165,233,.13); transform: translateY(-1px); }
            .levi-poster { width:62px; height:90px; border-radius:14px; object-fit:cover; background:linear-gradient(135deg, rgba(14,165,233,.2), rgba(20,184,166,.16)); display:flex; align-items:center; justify-content:center; color:#7dd3fc; font-weight:1000; }
            .levi-candidate-title { font-weight:1000; color:#f8fafc; margin-bottom:4px; }
            .levi-candidate-meta { color:#bdd7ec; font-size:12px; margin-bottom:5px; }
            .levi-overview { color:#90aebe; font-size:12px; line-height:1.3; display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical; overflow:hidden; }
            .levi-score { padding:6px 9px; border-radius:999px; background:rgba(34,197,94,.12); color:#bbf7d0; font-size:12px; font-weight:1000; white-space:nowrap; }

            .levi-help { color:#91adbf; font-size:12px; line-height:1.38; }
            .levi-switch { display:flex; align-items:center; gap:9px; color:#dbeafe; font-size:13px; font-weight:800; margin-bottom:12px; }
            .levi-switch input { width:18px; height:18px; accent-color:#0ea5e9; }

            .levi-footer {
                flex:0 0 auto; position:relative; z-index:2; display:grid; grid-template-columns:auto 1fr; gap:14px; align-items:center;
                padding:14px 20px 16px; border-top:1px solid rgba(148,163,184,.16);
                background:linear-gradient(180deg, rgba(2,6,23,.72), rgba(2,6,23,.98));
                box-shadow:0 -18px 40px rgba(0,0,0,.28);
            }
            .levi-status { padding:12px 14px; border-radius:17px; font-size:13px; line-height:1.35; white-space:pre-line; border:1px solid rgba(148,163,184,.14); background:rgba(15,23,42,.72); color:#dbeafe; max-height:90px; overflow:auto; }
            .levi-status.ok { border-color:rgba(34,197,94,.35); background:rgba(22,101,52,.14); color:#dcfce7; }
            .levi-status.error { border-color:rgba(248,113,113,.4); background:rgba(127,29,29,.18); color:#fee2e2; }
            .levi-status.warn { border-color:rgba(251,191,36,.35); background:rgba(113,63,18,.16); color:#fef3c7; }

            @media (max-width: 920px) {
                #${MODAL_ID} { padding:8px; align-items:stretch; }
                .levi-shell { width:100%; height:calc(100vh - 16px); min-height:0; border-radius:22px; }
                .levi-body { grid-template-columns:1fr; padding:14px; }
                .levi-grid2, .levi-grid3 { grid-template-columns:1fr; }
                .levi-header { padding:16px; }
                .levi-logo-wrap { width:48px; height:48px; border-radius:16px; }
                .levi-logo { width:56px; height:56px; }
                .levi-title { font-size:21px; }
                .levi-footer { grid-template-columns:1fr; }
                .levi-btn.big { width:100%; }
            }
        `;
        document.documentElement.appendChild(style);
    }

    function setStatus(text, kind = 'idle') {
        state.status = text;
        state.statusKind = kind;
        const node = document.querySelector('#levi-status');
        if (node) {
            node.className = `levi-status ${kind}`;
            node.textContent = text;
        }
    }

    function getMagnetsForUi() {
        const magnets = findMagnets();
        if (state.magnet && !magnets.some((magnet) => extractHash(magnet) === extractHash(state.magnet))) return [state.magnet, ...magnets];
        return magnets;
    }

    function hydrateStateFromPage() {
        const magnets = findMagnets();
        if (!state.magnet && magnets[0]) state.magnet = magnets[0];
        const sourceTitle = getUrlTitleGuess() || document.querySelector('h1')?.textContent?.trim() || document.title || '';
        state.sourceTitle = sourceTitle;
        state.provider = detectSourceProvider();
        if (!state.title) state.title = cleanReleaseTitle(extractTitleFromMagnet(state.magnet) || sourceTitle);
        const se = extractSeasonEpisode(extractTitleFromMagnet(state.magnet) || sourceTitle);
        if (se.season || se.episode) {
            state.type = 'series';
            state.season = state.season || se.season;
            state.episode = state.episode || se.episode;
        }
    }

    async function hydrateStoredState() {
        const stored = await getStored(['leviathanAddonBaseUrl', 'leviathanLastType', 'leviathanScanRd']);
        state.addonBaseUrl = stored.leviathanAddonBaseUrl || state.addonBaseUrl || '';
        state.type = stored.leviathanLastType || state.type || 'movie';
        state.scanRd = stored.leviathanScanRd !== false;
    }

    function candidatePoster(candidate) {
        return candidate.posterPath ? `${TMDB_POSTER_BASE}${candidate.posterPath}` : '';
    }

    function renderCandidate(candidate, index) {
        const selected = state.imdbId && candidate.imdbId === state.imdbId;
        const poster = candidatePoster(candidate);
        return `
            <div class="levi-candidate ${selected ? 'selected' : ''}" data-candidate-index="${index}">
                ${poster ? `<img class="levi-poster" src="${escapeHtml(poster)}" alt="poster">` : '<div class="levi-poster">IMDb</div>'}
                <div>
                    <div class="levi-candidate-title">${escapeHtml(candidate.title || 'Senza titolo')}</div>
                    <div class="levi-candidate-meta">${escapeHtml(candidate.imdbId || 'IMDb n/d')} • ${escapeHtml(candidate.type || '')}${candidate.year ? ` • ${escapeHtml(candidate.year)}` : ''}${candidate.tmdbId ? ` • TMDB ${escapeHtml(candidate.tmdbId)}` : ''}</div>
                    <div class="levi-overview">${escapeHtml(candidate.overview || candidate.originalTitle || 'Clicca per usare questo ID nel contributo.')}</div>
                </div>
                <div class="levi-score">${Math.round(Number(candidate.score || 0))}</div>
            </div>`;
    }

    function renderModal() {
        ensureStyles();
        hydrateStateFromPage();
        document.getElementById(MODAL_ID)?.remove();

        const magnets = getMagnetsForUi();
        const logoUrl = (typeof chrome !== 'undefined' && chrome.runtime?.getURL) ? chrome.runtime.getURL('icons/icon128.png') : '';
        const selectedHash = extractHash(state.magnet);
        const modal = document.createElement('div');
        modal.id = MODAL_ID;
        modal.innerHTML = `
            <div class="levi-shell">
                <div class="levi-header">
                    <div class="levi-brand">
                        <div class="levi-logo-wrap">${logoUrl ? `<img class="levi-logo" src="${escapeHtml(logoUrl)}" alt="Leviathan">` : '🐙'}</div>
                        <div>
                            <h2 class="levi-title">Leviathan Companion</h2>
                            <div class="levi-subtitle">Import magnet con identità IMDb/TMDB assistita, scan RD immediato e riepilogo sempre visibile. Design più ordinato, meno caccia manuale agli ID.</div>
                            <div class="levi-chipline">
                                <span class="levi-chip">🧲 ${magnets.length} magnet rilevati</span>
                                <span class="levi-chip">🌊 Fonte: ${escapeHtml(state.provider || 'pagina')}</span>
                                <span class="levi-chip">🛰️ ${escapeHtml(location.hostname || 'sito corrente')}</span>
                            </div>
                        </div>
                    </div>
                    <button class="levi-close" id="levi-close" title="Chiudi">×</button>
                </div>

                <div class="levi-body">
                    <div class="levi-column">
                        <div class="levi-card highlight">
                            <h3><span>01</span> Connessione</h3>
                            <div class="levi-grid2">
                                <div class="levi-field">
                                    <label>URL base Leviathan</label>
                                    <input class="levi-input" id="levi-base-url" placeholder="https://tuodominio.com" value="${escapeHtml(state.addonBaseUrl)}">
                                </div>
                                <div class="levi-field">
                                    <label>ADMIN_PASS</label>
                                    <input class="levi-input" id="levi-admin-pass" type="password" placeholder="Non viene salvata" value="${escapeHtml(sessionAdminPass)}">
                                </div>
                            </div>
                            <div class="levi-help">L'URL viene salvato nel browser. La password resta solo nella pagina corrente.</div>
                        </div>

                        <div class="levi-card">
                            <h3><span>02</span> Magnet e titolo</h3>
                            <div class="levi-field">
                                <label>Magnet rilevato</label>
                                <select class="levi-select" id="levi-magnet-select">
                                    ${magnets.length ? magnets.map((magnet, index) => `<option value="${index}" ${extractHash(magnet) === selectedHash ? 'selected' : ''}>${escapeHtml(`${extractHash(magnet) || 'magnet'} — ${extractTitleFromMagnet(magnet).slice(0, 82)}`)}</option>`).join('') : '<option value="manual">Nessun magnet diretto: incolla sotto</option>'}
                                </select>
                            </div>
                            <div class="levi-field">
                                <label>Magnet manuale</label>
                                <textarea class="levi-textarea" id="levi-manual-magnet" placeholder="magnet:?xt=urn:btih:...">${escapeHtml(state.magnet)}</textarea>
                            </div>
                            <div class="levi-actions">
                                <button class="levi-btn secondary" id="levi-refresh-magnets">↻ Rileggi pagina</button>
                                <button class="levi-btn secondary" id="levi-title-from-magnet">✨ Titolo dal magnet</button>
                            </div>
                        </div>

                        <div class="levi-card">
                            <h3><span>03</span> Identità IMDb assistita</h3>
                            <div class="levi-field">
                                <label>Titolo da cercare</label>
                                <input class="levi-input" id="levi-title-input" value="${escapeHtml(state.title)}" placeholder="Es. Scream 7">
                            </div>
                            <div class="levi-grid3">
                                <div class="levi-field">
                                    <label>Tipo</label>
                                    <select class="levi-select" id="levi-type">
                                        <option value="movie" ${state.type === 'movie' ? 'selected' : ''}>Film</option>
                                        <option value="series" ${state.type === 'series' ? 'selected' : ''}>Serie / episodio</option>
                                    </select>
                                </div>
                                <div class="levi-field">
                                    <label>Stagione</label>
                                    <input class="levi-input" id="levi-season" inputmode="numeric" value="${escapeHtml(state.season)}" placeholder="opzionale">
                                </div>
                                <div class="levi-field">
                                    <label>Episodio</label>
                                    <input class="levi-input" id="levi-episode" inputmode="numeric" value="${escapeHtml(state.episode)}" placeholder="opzionale">
                                </div>
                            </div>
                            <div class="levi-grid2">
                                <div class="levi-field">
                                    <label>IMDb ID selezionato</label>
                                    <input class="levi-input" id="levi-imdb-id" value="${escapeHtml(state.imdbId)}" placeholder="tt1234567 oppure lascia vuoto">
                                </div>
                                <div class="levi-field">
                                    <label>TMDB ID</label>
                                    <input class="levi-input" id="levi-tmdb-id" value="${escapeHtml(state.tmdbId)}" placeholder="auto">
                                </div>
                            </div>
                            <div class="levi-actions">
                                <button class="levi-btn" id="levi-search-imdb">🔎 Cerca candidati</button>
                                <button class="levi-btn secondary" id="levi-clear-imdb">Pulisci ID</button>
                            </div>
                            <div class="levi-help" style="margin-top:10px;">Clicca un candidato a destra: IMDb/TMDB si compilano da soli. Se lasci vuoto, Leviathan fa auto-match prudente.</div>
                        </div>
                    </div>

                    <div class="levi-column">
                        <div class="levi-card highlight">
                            <h3><span>04</span> Candidati trovati</h3>
                            <div class="levi-candidates" id="levi-candidates">
                                ${state.candidates.length ? state.candidates.map(renderCandidate).join('') : '<div class="levi-help">Premi “Cerca candidati”: vedrai poster, anno, tipo e IMDb. Scegli quello giusto con un click.</div>'}
                            </div>
                        </div>

                        <div class="levi-card">
                            <h3><span>05</span> RD scan</h3>
                            <label class="levi-switch"><input type="checkbox" id="levi-scan-rd" ${state.scanRd ? 'checked' : ''}> Scannerizza subito Real-Debrid e mostra se è cached</label>
                            <div class="levi-field">
                                <label>API key RD opzionale</label>
                                <input class="levi-input" id="levi-rd-key" type="password" value="${escapeHtml(state.apiKey)}" placeholder="Lascia vuoto se hai RD_SCAN_TOKEN/RD_API_KEY sulla VPS">
                            </div>
                            <div class="levi-help">Se RD conferma cached, Leviathan lo forza nel DB visibile e invalida la cache per farlo apparire subito.</div>
                        </div>

                        <div class="levi-card">
                            <h3><span>06</span> Riepilogo rapido</h3>
                            <div class="levi-help" id="levi-summary-box">${escapeHtml(buildSummaryText())}</div>
                            <div class="levi-actions" style="margin-top:12px;">
                                <button class="levi-btn secondary" id="levi-copy-summary">Copia riepilogo</button>
                            </div>
                        </div>
                    </div>
                </div>

                <div class="levi-footer">
                    <button class="levi-btn big" id="levi-send">🚀 Invia a Leviathan</button>
                    <div id="levi-status" class="levi-status ${escapeHtml(state.statusKind)}">${escapeHtml(state.status || 'Pronto. Scegli un IMDb oppure invia e lascia decidere Leviathan.')}</div>
                </div>
            </div>`;
        document.documentElement.appendChild(modal);
        wireModalEvents();
    }

    function readInputs() {
        state.addonBaseUrl = normalizeBaseUrl(document.querySelector('#levi-base-url')?.value || state.addonBaseUrl);
        sessionAdminPass = String(document.querySelector('#levi-admin-pass')?.value || sessionAdminPass).trim();
        state.magnet = String(document.querySelector('#levi-manual-magnet')?.value || state.magnet).trim();
        state.title = String(document.querySelector('#levi-title-input')?.value || state.title).trim();
        state.type = String(document.querySelector('#levi-type')?.value || state.type || 'movie');
        state.season = String(document.querySelector('#levi-season')?.value || '').trim();
        state.episode = String(document.querySelector('#levi-episode')?.value || '').trim();
        state.imdbId = String(document.querySelector('#levi-imdb-id')?.value || '').trim().toLowerCase();
        state.tmdbId = String(document.querySelector('#levi-tmdb-id')?.value || '').trim();
        state.scanRd = document.querySelector('#levi-scan-rd')?.checked !== false;
        state.apiKey = String(document.querySelector('#levi-rd-key')?.value || '').trim();
    }

    function updateSummary() {
        const box = document.querySelector('#levi-summary-box');
        if (box) box.textContent = buildSummaryText();
    }

    function buildSummaryText() {
        const hash = extractHash(state.magnet) || 'nessun hash';
        return [
            `Fonte: ${state.provider || detectSourceProvider()}`,
            `Titolo: ${state.title || cleanReleaseTitle(extractTitleFromMagnet(state.magnet))}`,
            `Tipo: ${state.type}${state.type === 'series' && (state.season || state.episode) ? ` S${state.season || '?'}E${state.episode || '?'}` : ''}`,
            `IMDb: ${state.imdbId || 'auto-match backend'}`,
            `Hash: ${hash}`,
            `RD scan: ${state.scanRd ? 'sì' : 'no'}`
        ].join('\n');
    }

    async function persistSafeSettings() {
        await setStored({
            leviathanAddonBaseUrl: state.addonBaseUrl,
            leviathanLastType: state.type,
            leviathanScanRd: state.scanRd
        });
    }

    function validateConnection() {
        if (!/^https?:\/\//i.test(state.addonBaseUrl)) throw new Error('Inserisci URL base Leviathan valido: deve iniziare con http:// o https://');
        if (!sessionAdminPass) throw new Error('Inserisci ADMIN_PASS. Non viene salvata.');
    }

    function validateMagnet() {
        if (!/^magnet:\?xt=urn:btih:/i.test(state.magnet)) throw new Error('Magnet mancante o non valido. Incolla un magnet completo.');
    }

    async function searchCandidates() {
        readInputs();
        validateConnection();
        await persistSafeSettings();
        setStatus('Sto cercando candidati TMDB/IMDb tramite Leviathan...', 'warn');

        const result = await chrome.runtime.sendMessage({
            type: 'LEVIATHAN_IDENTITY_SEARCH',
            addonBaseUrl: state.addonBaseUrl,
            adminPass: sessionAdminPass,
            payload: {
                title: state.title || extractTitleFromMagnet(state.magnet),
                sourceTitle: state.sourceTitle || document.title || '',
                type: state.type
            }
        });

        if (!result?.ok) throw new Error(result?.error || 'Ricerca IMDb fallita. Puoi comunque inviare e lasciare auto-match al backend.');
        state.candidates = Array.isArray(result.data?.candidates) ? result.data.candidates : [];
        if (state.candidates.length === 0) {
            setStatus(`Nessun candidato forte trovato per “${state.title}”. Puoi inserire IMDb a mano o inviare senza ID.`, 'warn');
        } else {
            const best = state.candidates[0];
            setStatus(`Trovati ${state.candidates.length} candidati. Migliore: ${best.title || 'n/d'} ${best.year || ''} (${best.imdbId || 'IMDb n/d'}).`, 'ok');
        }
        renderModal();
    }

    function buildPayload() {
        const season = Number.parseInt(state.season || '', 10);
        const episode = Number.parseInt(state.episode || '', 10);
        return {
            magnet: state.magnet,
            title: state.title || extractTitleFromMagnet(state.magnet),
            sourceTitle: state.sourceTitle || document.title || '',
            provider: state.provider || detectSourceProvider(),
            sourceUrl: location.href,
            imdbId: /^tt\d+$/i.test(state.imdbId) ? state.imdbId : null,
            tmdbId: state.tmdbId || null,
            type: state.type,
            season: Number.isInteger(season) && season > 0 ? season : null,
            episode: Number.isInteger(episode) && episode > 0 ? episode : null,
            scanRd: state.scanRd,
            service: state.scanRd ? 'rd' : null,
            apiKey: state.apiKey || null
        };
    }

    async function sendContribution() {
        readInputs();
        validateConnection();
        validateMagnet();
        await persistSafeSettings();
        setStatus('Invio a Leviathan in corso... se RD è attivo controllo subito la cache.', 'warn');

        const result = await chrome.runtime.sendMessage({
            type: 'LEVIATHAN_MANUAL_IMPORT',
            addonBaseUrl: state.addonBaseUrl,
            adminPass: sessionAdminPass,
            payload: buildPayload()
        });

        if (!result?.ok) throw new Error(result?.error || 'Invio a Leviathan fallito.');
        const data = result.data || {};
        const hash = data?.payload?.hash || extractHash(state.magnet) || 'ok';
        const match = data?.summary?.identityMatch;
        const rd = data?.summary?.rdScan;
        const lines = [`✅ Contributo inviato. Hash: ${hash}`];
        if (state.imdbId) lines.push(`IMDb scelto: ${state.imdbId}${state.tmdbId ? ` / TMDB ${state.tmdbId}` : ''}`);
        else if (match?.matched) lines.push(`Match automatico: ${match.imdbId} / TMDB ${match.tmdbId}`);
        else if (match?.reason) lines.push(`Match automatico: ${match.reason}`);
        if (rd?.skipped) lines.push(`RD scan: saltato (${rd.reason})`);
        else if (rd) {
            lines.push(`RD scan: ${rd.cached ? '⚡ cached' : rd.state || 'non cached'}${rd.fileTitle ? ` - ${rd.fileTitle}` : ''}`);
            if (rd.visibleDb?.visible === true) lines.push(`DB visibile: sì (${rd.visibleDb.visibleCount} risultati)`);
        }
        setStatus(lines.join('\n'), 'ok');
    }

    function wireModalEvents() {
        const close = document.querySelector('#levi-close');
        close?.addEventListener('click', () => document.getElementById(MODAL_ID)?.remove());

        document.querySelector('#levi-magnet-select')?.addEventListener('change', (event) => {
            const magnets = getMagnetsForUi();
            const index = Number.parseInt(event.target.value, 10);
            if (Number.isInteger(index) && magnets[index]) {
                state.magnet = magnets[index];
                state.title = cleanReleaseTitle(extractTitleFromMagnet(state.magnet));
                const se = extractSeasonEpisode(extractTitleFromMagnet(state.magnet));
                if (se.season || se.episode) {
                    state.type = 'series';
                    state.season = se.season;
                    state.episode = se.episode;
                }
                renderModal();
            }
        });

        const inputIds = ['#levi-base-url', '#levi-admin-pass', '#levi-manual-magnet', '#levi-title-input', '#levi-type', '#levi-season', '#levi-episode', '#levi-imdb-id', '#levi-tmdb-id', '#levi-scan-rd', '#levi-rd-key'];
        inputIds.forEach((selector) => {
            document.querySelector(selector)?.addEventListener('input', () => { readInputs(); updateSummary(); });
            document.querySelector(selector)?.addEventListener('change', () => { readInputs(); updateSummary(); });
        });

        document.querySelector('#levi-refresh-magnets')?.addEventListener('click', () => {
            state.magnet = findMagnets()[0] || state.magnet;
            renderModal();
        });

        document.querySelector('#levi-title-from-magnet')?.addEventListener('click', () => {
            readInputs();
            state.title = cleanReleaseTitle(extractTitleFromMagnet(state.magnet));
            const se = extractSeasonEpisode(extractTitleFromMagnet(state.magnet));
            if (se.season || se.episode) {
                state.type = 'series';
                state.season = se.season;
                state.episode = se.episode;
            }
            renderModal();
        });

        document.querySelector('#levi-search-imdb')?.addEventListener('click', async () => {
            try { await searchCandidates(); } catch (error) { setStatus(`Errore ricerca IMDb: ${error.message}`, 'error'); }
        });

        document.querySelector('#levi-clear-imdb')?.addEventListener('click', () => {
            state.imdbId = '';
            state.tmdbId = '';
            renderModal();
        });

        document.querySelector('#levi-send')?.addEventListener('click', async () => {
            try { await sendContribution(); } catch (error) { setStatus(`Errore invio: ${error.message}`, 'error'); }
        });

        document.querySelector('#levi-copy-summary')?.addEventListener('click', async () => {
            readInputs();
            const summary = buildSummaryText();
            try {
                await navigator.clipboard.writeText(summary);
                setStatus('Riepilogo copiato negli appunti.', 'ok');
            } catch (_) {
                setStatus(summary, 'warn');
            }
        });

        document.querySelectorAll('[data-candidate-index]').forEach((node) => {
            node.addEventListener('click', () => {
                const index = Number.parseInt(node.getAttribute('data-candidate-index') || '', 10);
                const candidate = state.candidates[index];
                if (!candidate) return;
                state.imdbId = candidate.imdbId || '';
                state.tmdbId = candidate.tmdbId || '';
                state.type = candidate.type || state.type;
                state.title = candidate.title || state.title;
                setStatus(`Selezionato: ${candidate.title || 'n/d'} — ${candidate.imdbId || 'IMDb n/d'}${candidate.tmdbId ? ` / TMDB ${candidate.tmdbId}` : ''}`, 'ok');
                renderModal();
            });
        });
    }

    async function openModal() {
        await hydrateStoredState();
        hydrateStateFromPage();
        renderModal();
    }

    function renderFloatingButton() {
        const magnets = findMagnets();
        const shouldShow = isTorrentLikePage(magnets);
        const existingApp = document.getElementById(APP_ID);

        if (!shouldShow) {
            existingApp?.remove();
            lastMagnetCount = 0;
            return;
        }

        ensureStyles();
        let app = existingApp;
        if (!app) {
            app = document.createElement('div');
            app.id = APP_ID;
            const button = document.createElement('button');
            button.id = BUTTON_ID;
            button.addEventListener('click', openModal);
            app.appendChild(button);
            document.documentElement.appendChild(app);
        }

        const button = document.getElementById(BUTTON_ID);
        if (button) {
            button.innerHTML = `<span class="levi-dot"></span><span>Leviathan Companion</span><span class="levi-count">${magnets.length ? `${magnets.length} magnet` : 'torrent'}</span>`;
            button.title = magnets.length ? 'Apri import assistito Leviathan' : 'Apri Leviathan Companion su pagina torrent';
        }
        lastMagnetCount = magnets.length;
    }

    function startObserver() {
        if (observerStarted || !document.body) return;
        observerStarted = true;
        const observer = new MutationObserver(() => {
            const count = findMagnets().length;
            const appVisible = Boolean(document.getElementById(APP_ID));
            const shouldShow = isTorrentLikePage();
            if (count !== lastMagnetCount || appVisible !== shouldShow) renderFloatingButton();
        });
        observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['href'] });
    }

    renderFloatingButton();
    startObserver();
})();
