(() => {
    'use strict';

    const MAGNET_RE = /magnet:\?xt=urn:btih:[^\s"'<>]+/gi;
    const INFO_HASH_RE = /urn:btih:([a-f0-9]{40}|[a-z2-7]{32})/i;
    const IMDB_RE = /tt\d{6,10}/i;
    const APP_ID = 'leviathan-companion-app';
    const BUTTON_ID = 'leviathan-companion-button';
    const MODAL_ID = 'leviathan-companion-modal';
    const STYLE_ID = 'leviathan-companion-style';
    const TMDB_POSTER_BASE = 'https://image.tmdb.org/t/p/w185';

    let observerStarted = false;
    let lastMagnetSignature = '';
    let scanTimer = null;
    let identityTimer = null;
    let sessionAdminPass = '';

    const state = {
        addonBaseUrl: '',
        magnet: '',
        title: '',
        year: '',
        sourceTitle: '',
        provider: '',
        providerHost: '',
        type: 'movie',
        season: '',
        episode: '',
        imdbId: '',
        tmdbId: '',
        cacheMode: 'rd',
        rdApiKey: '',
        tbApiKey: '',
        candidates: [],
        status: '',
        statusKind: 'idle',
        explainText: '',
        selectedAnalysis: null,
        pageInfo: null
    };

    const PROVIDERS = [
        { label: 'BT4G', host: /(?:^|\.)(?:bt4g|bt4gprx|btdig|btdiggg|b4g|downloadtorrentfile)(?:\.|$)/i, text: /\b(?:bt4g|bt4gprx|btdig|btdiggg|b4gprx|downloadtorrentfile)\b/i },
        { label: '1337x', host: /(?:^|\.)(?:1337x|1377x|x1337x|1337xx)(?:\.|$)/i, text: /\b(?:1337x|1377x|x1337x|1337xx)\b/i },
        { label: 'TorrentGalaxy', host: /(?:^|\.)(?:torrentgalaxy|tgx)(?:\.|$)/i, text: /\b(?:torrentgalaxy|tgx)\b/i },
        { label: 'MagnetDL', host: /(?:^|\.)magnetdl(?:\.|$)/i, text: /\bmagnetdl\b/i },
        { label: 'BitSearch', host: /(?:^|\.)bitsearch(?:\.|$)/i, text: /\bbitsearch\b/i },
        { label: 'ilCorSaRoNeRo', host: /(?:^|\.)(?:ilcorsaronero|corsaronero|corsaro)(?:\.|$)/i, text: /\b(?:ilcorsaronero|corsaro nero|corsaronero)\b/i },
        { label: 'ThePirateBay', host: /(?:^|\.)(?:thepiratebay|piratebay|tpb)(?:\.|$)/i, text: /\b(?:the pirate bay|thepiratebay|piratebay|tpb)\b/i },
        { label: 'LimeTorrents', host: /(?:^|\.)limetorrents(?:\.|$)/i, text: /\blimetorrents\b/i },
        { label: 'TorLock', host: /(?:^|\.)torlock(?:\.|$)/i, text: /\btorlock\b/i },
        { label: 'YTS', host: /(?:^|\.)(?:yts|yify)(?:\.|$)/i, text: /\b(?:yts|yify)\b/i },
        { label: 'Nyaa', host: /(?:^|\.)nyaa(?:\.|$)/i, text: /\bnyaa\b/i },
        { label: 'EZTV', host: /(?:^|\.)eztv(?:\.|$)/i, text: /\beztv\b/i },
        { label: 'RARBG', host: /(?:^|\.)rarbg(?:\.|$)/i, text: /\brarbg\b/i },
        { label: 'TorrentDownloads', host: /(?:^|\.)(?:torrentdownloads|torrentdownload)(?:\.|$)/i, text: /\btorrentdownloads?\b/i },
        { label: 'KickassTorrents', host: /(?:^|\.)(?:kickasstorrents|kickass|kat)(?:\.|$)/i, text: /\b(?:kickasstorrents|kickass|kat)\b/i }
    ];

    const RELEASE_TOKENS = [
        '2160p','1080p','720p','576p','540p','480p','4k','uhd','hdr','hdr10','hdr10plus','dv','dolby vision',
        'web-dl','webdl','web rip','webrip','bluray','blu-ray','bdrip','brrip','hdtv','dvdrip','remux','cam','ts','tc','r5',
        'x264','x265','h264','h265','hevc','avc','av1','vp9','xvid','divx','aac','ac3','eac3','dts','ddp','dd5.1','7.1','5.1','atmos',
        'ita','italian','eng','english','multi','multi audio','subita','sub ita','subbed','subs','proper','repack','extended','unrated','internal',
        'complete','season','stagione','pack','collection','trilogy','duology','readnfo','limited','retail','rerip',
        'rarbg','tgx','torrentgalaxy','yts','yify','eztv','ettv','ntg','framestor','flux','megalodon','mircrew','dr4g','cyber','pirates','badquality'
    ];

    function escapeHtml(value) {
        return String(value ?? '').replace(/[&<>"']/g, (char) => ({
            '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;'
        }[char]));
    }

    function normalizeBaseUrl(value) {
        return String(value || '').trim().replace(/\/+$/, '');
    }

    function extractHash(magnet) {
        const match = String(magnet || '').match(INFO_HASH_RE);
        return match ? match[1].toUpperCase() : null;
    }

    function safeDecode(value) {
        try { return decodeURIComponent(String(value || '').replace(/\+/g, ' ')); }
        catch (_) { return String(value || '').replace(/\+/g, ' '); }
    }

    function parseMagnetParams(magnet) {
        const out = {};
        try {
            const params = new URLSearchParams(String(magnet || '').replace(/^magnet:\?/i, ''));
            out.dn = params.get('dn') || '';
            out.tr = params.getAll('tr') || [];
            out.xt = params.get('xt') || '';
        } catch (_) {}
        return out;
    }

    function uniqueByHash(items) {
        const seen = new Set();
        const out = [];
        for (const item of items) {
            const magnet = String(item?.magnet || item || '').trim();
            if (!magnet) continue;
            const hash = extractHash(magnet) || magnet;
            const key = hash.toUpperCase();
            if (seen.has(key)) continue;
            seen.add(key);
            out.push(typeof item === 'string' ? { magnet } : { ...item, magnet });
        }
        return out;
    }

    function getMeta(names) {
        for (const name of names) {
            const node = document.querySelector(`meta[property="${name}"], meta[name="${name}"]`);
            const value = node?.getAttribute('content');
            if (value) return value.trim();
        }
        return '';
    }

    function cleanSiteNoise(value) {
        return String(value || '')
            .replace(/\s*[|•·]\s*(?:download|torrent|magnet|bt4g|1337x|torrentgalaxy|magnetdl|ilcorsaronero|thepiratebay).*$/i, '')
            .replace(/\s+-\s+(?:download|torrent|magnet|bt4g|1337x|torrentgalaxy|magnetdl|ilcorsaronero|thepiratebay).*$/i, '')
            .replace(/\b(?:download|scarica|torrent|magnet link|free|watch online)\b/ig, ' ')
            .replace(/\s+/g, ' ')
            .trim();
    }

    function normalizeHostCandidate(value = '') {
        const raw = String(value || '').trim();
        if (!raw) return '';
        try {
            return new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`).hostname.replace(/^www\./i, '').toLowerCase();
        } catch (_) {
            return raw.replace(/^www\./i, '').split('/')[0].toLowerCase();
        }
    }

    function detectProviderFromHost(value = '') {
        const host = normalizeHostCandidate(value);
        if (!host) return '';
        for (const provider of PROVIDERS) {
            provider.host.lastIndex = 0;
            if (provider.host.test(host)) return provider.label;
        }
        return '';
    }

    function detectProviderFromText(value = '') {
        const text = String(value || '').toLowerCase();
        if (!text) return '';
        for (const provider of PROVIDERS) {
            provider.text.lastIndex = 0;
            if (provider.text.test(text)) return provider.label;
        }
        return '';
    }

    function cleanProviderLabel(value) {
        const raw = String(value || '').trim();
        const knownFromHost = detectProviderFromHost(raw);
        if (knownFromHost) return knownFromHost;
        const knownFromText = detectProviderFromText(raw);
        if (knownFromText) return knownFromText;
        const cleaned = raw
            .replace(/^www\./i, '')
            .replace(/\.(?:com|org|net|to|it|io|is|mx|st|se|ru|watch|run)$/i, '')
            .replace(/(?:[-_\s]*(?:mirror|proxy|unblock|official|new|site|torrent|magnet|download|www)\b)+/ig, '')
            .replace(/[^a-z0-9]+/ig, ' ')
            .trim()
            .replace(/\s+/g, ' ');
        if (!cleaned) return 'LEVIATHAN_COMPANION';
        return cleaned.split(' ').map((part) => part ? part[0].toUpperCase() + part.slice(1).toLowerCase() : '').join('');
    }

    function detectSourceProvider() {
        const host = normalizeHostCandidate(location.hostname || location.href || '');
        const canonicalHost = normalizeHostCandidate(document.querySelector('link[rel="canonical"]')?.href || '');
        const hostProvider = detectProviderFromHost(host) || detectProviderFromHost(canonicalHost);
        if (hostProvider) return hostProvider;

        const site = getMeta(['og:site_name', 'application-name']) || '';
        const title = String(document.title || '').toLowerCase();
        const url = String(location.href || '').toLowerCase();
        const textProvider = detectProviderFromText(`${site} ${title} ${url}`);
        if (textProvider) return textProvider;

        return cleanProviderLabel(site || host.split('.')[0] || 'LEVIATHAN_COMPANION');
    }

    function readJsonLd() {
        const blocks = [...document.querySelectorAll('script[type="application/ld+json"]')];
        for (const block of blocks) {
            try {
                const parsed = JSON.parse(block.textContent || '{}');
                const list = Array.isArray(parsed) ? parsed : [parsed];
                const flat = list.flatMap((item) => Array.isArray(item?.['@graph']) ? item['@graph'] : [item]);
                const useful = flat.find((item) => item && (item.name || item.headline || item.alternateName));
                if (useful) return useful;
            } catch (_) {}
        }
        return null;
    }

    function getPageInfo() {
        const jsonLd = readJsonLd();
        const host = String(location.hostname || '').replace(/^www\./i, '').toLowerCase();
        const provider = detectSourceProvider();
        const h1 = document.querySelector('h1')?.textContent?.trim() || '';
        const ogTitle = getMeta(['og:title', 'twitter:title']);
        const rawTitle = cleanSiteNoise(h1 || ogTitle || jsonLd?.name || jsonLd?.headline || document.title || '');
        const text = String(document.body?.innerText || '').slice(0, 25000);
        const imdbMatch = String(location.href + ' ' + text).match(IMDB_RE);
        const canonical = document.querySelector('link[rel="canonical"]')?.href || location.href;
        return {
            provider,
            host,
            sourceUrl: location.href,
            canonical,
            rawTitle,
            h1,
            ogTitle,
            jsonLdName: jsonLd?.name || jsonLd?.headline || '',
            imdbId: imdbMatch ? imdbMatch[0].toLowerCase() : '',
            hasStructuredData: Boolean(jsonLd)
        };
    }

    function getNearestTorrentContainer(anchor) {
        if (!anchor) return null;
        return anchor.closest('tr, li, article, .torrent, .result, .results, .item, .card, .table-list, .list-entry, .search-result, .torrent-list, .col-12, div') || anchor.parentElement;
    }

    function findMagnets(options = {}) {
        const deep = options.deep === true;
        const anchors = [...document.querySelectorAll('a[href]')]
            .filter((node) => /^magnet:\?/i.test(node.getAttribute('href') || node.href || ''));
        const items = anchors.map((anchor) => {
            const container = getNearestTorrentContainer(anchor);
            return {
                magnet: anchor.getAttribute('href') || anchor.href || '',
                anchorText: anchor.textContent || anchor.getAttribute('title') || '',
                context: String(container?.innerText || anchor.textContent || '').slice(0, 3500),
                container
            };
        });

        if (deep) {
            const textMagnets = String(document.body?.innerText || '').match(MAGNET_RE) || [];
            const htmlMagnets = String(document.documentElement?.innerHTML || '').match(MAGNET_RE) || [];
            for (const magnet of [...textMagnets, ...htmlMagnets]) items.push({ magnet, context: '', anchorText: '' });
        }
        return uniqueByHash(items);
    }

    function getUrlTitleGuess() {
        try {
            const url = new URL(location.href);
            const values = ['name', 'title', 'q', 'query', 'search', 's'].map((key) => url.searchParams.get(key)).filter(Boolean);
            if (values[0]) return safeDecode(values[0]);
            const path = safeDecode(url.pathname.split('/').filter(Boolean).pop() || '');
            return path.replace(/[-_]+/g, ' ');
        } catch (_) { return ''; }
    }

    function extractTitleFromMagnet(magnet) {
        const params = parseMagnetParams(magnet);
        return params.dn ? safeDecode(params.dn).trim() : '';
    }

    function chooseContextTitle(item, pageInfo) {
        const magnetTitle = extractTitleFromMagnet(item?.magnet);
        if (magnetTitle) return magnetTitle;
        const candidates = [];
        const anchorText = cleanSiteNoise(item?.anchorText || '');
        if (anchorText && !/^magnet$/i.test(anchorText)) candidates.push(anchorText);
        const lines = String(item?.context || '').split('\n').map((line) => cleanSiteNoise(line)).filter(Boolean);
        for (const line of lines.slice(0, 10)) {
            if (/^(magnet|download|scarica|comments?|seeders?|leechers?|size|date|uploader)$/i.test(line)) continue;
            if (line.length < 4 || line.length > 180) continue;
            if (/^\d+$/.test(line)) continue;
            candidates.push(line);
        }
        candidates.push(getUrlTitleGuess(), pageInfo?.rawTitle, document.title);
        return candidates.find(Boolean) || extractHash(item?.magnet) || 'Manual contribution';
    }

    function normalizeReleaseString(value) {
        return String(value || '')
            .replace(/%20/g, ' ')
            .replace(/[._+]+/g, ' ')
            .replace(/[\[\]{}]/g, ' ')
            .replace(/[()]/g, ' ')
            .replace(/\s+/g, ' ')
            .trim();
    }

    function extractYear(raw) {
        const matches = [...String(raw || '').matchAll(/(?:^|[\s.(_\[-])((?:19|20)\d{2})(?:[\s.)_\]-]|$)/g)].map((m) => Number(m[1]));
        const now = new Date().getFullYear() + 2;
        const year = matches.find((value) => value >= 1900 && value <= now);
        return year ? String(year) : '';
    }

    function detectResolution(raw) {
        const text = String(raw || '').toLowerCase();
        if (/\b(?:2160p|4k|uhd)\b/.test(text)) return '2160p / 4K';
        if (/\b1080p\b/.test(text)) return '1080p';
        if (/\b720p\b/.test(text)) return '720p';
        if (/\b576p\b/.test(text)) return '576p';
        if (/\b480p\b/.test(text)) return '480p';
        if (/\b(?:cam|ts|hdcam)\b/.test(text)) return 'CAM/TS';
        return '';
    }

    function detectLanguages(raw) {
        const text = ` ${String(raw || '').toLowerCase()} `;
        const langs = [];
        if (/\b(?:ita|italian|italiano|iTALiAN)\b/i.test(text)) langs.push('ITA');
        if (/\b(?:eng|english|inglese)\b/i.test(text)) langs.push('ENG');
        if (/\b(?:multi|multi audio|multiaudio|dual audio|dual)\b/i.test(text)) langs.push('MULTI');
        if (/\b(?:subita|sub ita|subs? ita|italian subs?)\b/i.test(text)) langs.push('SUB ITA');
        if (/\b(?:french|fre|truefrench)\b/i.test(text)) langs.push('FRE');
        if (/\b(?:spanish|spa|esp)\b/i.test(text)) langs.push('SPA');
        return [...new Set(langs)];
    }

    function detectCodec(raw) {
        const text = String(raw || '').toLowerCase();
        const codecs = [];
        if (/\b(?:x265|h\.?265|hevc)\b/.test(text)) codecs.push('x265/HEVC');
        if (/\b(?:x264|h\.?264|avc)\b/.test(text)) codecs.push('x264/AVC');
        if (/\bav1\b/.test(text)) codecs.push('AV1');
        if (/\bvp9\b/.test(text)) codecs.push('VP9');
        if (/\bxvid\b/.test(text)) codecs.push('XviD');
        return codecs.join(' + ');
    }

    function detectSource(raw) {
        const text = String(raw || '').toLowerCase();
        if (/\bremux\b/.test(text)) return 'REMUX';
        if (/\b(?:web-dl|webdl)\b/.test(text)) return 'WEB-DL';
        if (/\bwebrip\b/.test(text)) return 'WEBRip';
        if (/\b(?:blu-ray|bluray|bdrip|brrip)\b/.test(text)) return 'BluRay';
        if (/\bhdtv\b/.test(text)) return 'HDTV';
        if (/\bdvdrip\b/.test(text)) return 'DVDRip';
        if (/\b(?:cam|hdcam|ts|telesync)\b/.test(text)) return 'CAM/TS';
        return '';
    }

    function parseSize(raw) {
        const text = String(raw || '').replace(/,/g, '.');
        const matches = [...text.matchAll(/(\d+(?:\.\d+)?)\s*(TiB|TB|GiB|GB|MiB|MB)\b/ig)];
        if (!matches.length) return { label: '', mb: null };
        const m = matches[0];
        const n = Number(m[1]);
        const unit = m[2].toUpperCase();
        const mb = unit.includes('T') ? n * 1024 * 1024 : unit.includes('G') ? n * 1024 : n;
        return { label: `${m[1]} ${m[2]}`, mb: Number.isFinite(mb) ? Math.round(mb) : null };
    }

    function parseSeedLeech(item) {
        const container = item?.container;
        const pickNumber = (node) => {
            const text = String(node?.textContent || '').replace(/,/g, '').trim();
            const match = text.match(/\d+/);
            return match ? Number(match[0]) : null;
        };
        let seed = null;
        let leech = null;
        if (container) {
            const seedNode = container.querySelector('.seeds, .seed, .seeders, [class*="seed"], td.coll-2');
            const leechNode = container.querySelector('.leeches, .leech, .leechers, [class*="leech"], td.coll-3');
            seed = pickNumber(seedNode);
            leech = pickNumber(leechNode);

            if ((seed == null || leech == null) && container.matches('tr')) {
                const cells = [...container.querySelectorAll('td')].map((td) => String(td.textContent || '').trim()).filter(Boolean);
                const numericCells = cells.map((text) => text.replace(/,/g, '').match(/^\d+$/)?.[0]).filter(Boolean).map(Number);
                if (numericCells.length >= 2) {
                    if (seed == null) seed = numericCells[numericCells.length - 2];
                    if (leech == null) leech = numericCells[numericCells.length - 1];
                }
            }
        }
        const context = String(item?.context || '').replace(/,/g, '');
        const seedMatch = context.match(/(?:seeders?|seeds?|seed|se)\s*[:：-]?\s*(\d+)/i);
        const leechMatch = context.match(/(?:leechers?|leeches?|leech|le)\s*[:：-]?\s*(\d+)/i);
        if (seed == null && seedMatch) seed = Number(seedMatch[1]);
        if (leech == null && leechMatch) leech = Number(leechMatch[1]);
        return { seed: Number.isFinite(seed) ? seed : null, leech: Number.isFinite(leech) ? leech : null };
    }

    function extractSeasonEpisode(value) {
        const raw = String(value || '');
        const direct = raw.match(/S(\d{1,2})\s*E(\d{1,3})/i) || raw.match(/(\d{1,2})x(\d{1,3})/i);
        if (!direct) return { season: '', episode: '' };
        return { season: String(Number(direct[1])), episode: String(Number(direct[2])) };
    }

    function detectSinglePack(raw, context) {
        const text = `${raw || ''} ${context || ''}`.toLowerCase();
        const hasEpisode = /s\d{1,2}\s*e\d{1,3}|\d{1,2}x\d{1,3}/i.test(text);
        const hasSeasonOnly = /\bs\d{1,2}\b(?!\s*e\d{1,3})|season\s*\d{1,2}|stagione\s*\d{1,2}/i.test(text) && !hasEpisode;
        const packWords = /\b(?:complete|completa|season pack|full season|stagione completa|pack|collection|collezione|saga|trilogy|duology|boxset|episodes?|episodi)\b/i.test(text);
        if (hasEpisode) return { kind: 'single', label: 'Single episodio', reason: 'Rilevato pattern SxxEyy / x' };
        if (hasSeasonOnly || packWords) return { kind: 'pack', label: 'Pack / stagione', reason: hasSeasonOnly ? 'Stagione senza episodio specifico' : 'Parole chiave da pack/collection' };
        return { kind: 'single', label: 'Single file probabile', reason: 'Nessun segnale pack forte' };
    }

    function cleanReleaseTitle(value) {
        let title = normalizeReleaseString(value)
            .replace(/^risultato[.:\s-]*/i, '')
            .replace(/\bS\d{1,2}\s*E\d{1,3}\b/ig, ' ')
            .replace(/\b\d{1,2}x\d{1,3}\b/ig, ' ')
            .replace(/\b(?:19|20)\d{2}\b/g, ' ');

        for (const token of RELEASE_TOKENS) {
            const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s*[-. ]?\\s*');
            title = title.replace(new RegExp(`\\b${escaped}\\b`, 'ig'), ' ');
        }
        title = title
            .replace(/\b(?:www|com|org|net|to|it)\b/ig, ' ')
            .replace(/\b(?:AAC\d|DDP?\d|DTSHD|MA)\b/ig, ' ')
            .replace(/[-–—|].*$/, ' ')
            .replace(/\s+/g, ' ')
            .trim();
        return title || normalizeReleaseString(value).slice(0, 90) || 'Manual contribution';
    }

    function resolutionScore(resolution) {
        if (/2160|4K/i.test(resolution)) return 500;
        if (/1080/i.test(resolution)) return 350;
        if (/720/i.test(resolution)) return 220;
        if (/576|480/i.test(resolution)) return 120;
        if (/CAM|TS/i.test(resolution)) return -150;
        return 0;
    }

    function scoreRelease(info) {
        let score = 0;
        score += resolutionScore(info.resolution);
        if (info.languages.includes('ITA')) score += 180;
        if (info.languages.includes('MULTI')) score += 70;
        if (info.languages.includes('SUB ITA')) score += 25;
        if (info.seed != null) score += Math.min(160, Math.max(0, info.seed) * 2);
        if (/single/i.test(info.packLabel)) score += 30;
        if (/cam|ts/i.test(info.source)) score -= 140;
        if (/x265|hevc|av1/i.test(info.codec)) score += 35;
        return Math.round(score);
    }

    function analyzeMagnetItem(item, pageInfo = getPageInfo()) {
        const rawTitle = chooseContextTitle(item, pageInfo);
        const combined = `${rawTitle} ${item?.context || ''}`;
        const year = extractYear(combined);
        const se = extractSeasonEpisode(combined);
        const size = parseSize(combined);
        const sl = parseSeedLeech(item);
        const pack = detectSinglePack(rawTitle, item?.context);
        const pageHostProvider = detectProviderFromHost(pageInfo?.host || location.hostname || '');
        const rowProvider = detectProviderFromText(`${item?.anchorText || ''} ${item?.context || ''} ${item?.magnet || ''}`);
        const pageProvider = cleanProviderLabel(pageInfo?.provider || detectSourceProvider());
        const provider = cleanProviderLabel(pageHostProvider || rowProvider || pageProvider);
        const info = {
            magnet: item?.magnet || '',
            hash: extractHash(item?.magnet) || '',
            provider,
            providerHost: pageInfo?.host || String(location.hostname || ''),
            rawTitle,
            cleanTitle: cleanReleaseTitle(rawTitle),
            year,
            resolution: detectResolution(combined),
            languages: detectLanguages(combined),
            codec: detectCodec(combined),
            source: detectSource(combined),
            sizeLabel: size.label,
            sizeMb: size.mb,
            seed: sl.seed,
            leech: sl.leech,
            packKind: pack.kind,
            packLabel: pack.label,
            packReason: pack.reason,
            season: se.season,
            episode: se.episode,
            pageTitle: pageInfo?.rawTitle || '',
            sourceUrl: location.href
        };
        info.score = scoreRelease(info);
        return info;
    }

    function getAnalyzedMagnets(deep = true) {
        const pageInfo = getPageInfo();
        const analyses = findMagnets({ deep }).map((item) => analyzeMagnetItem(item, pageInfo));
        analyses.sort((a, b) => b.score - a.score);
        return analyses;
    }

    function magnetSignature() {
        return findMagnets({ deep: false }).map((item) => extractHash(item.magnet) || item.magnet.slice(0, 80)).join('|');
    }

    function isTorrentLikePage(magnets = null) {
        const found = Array.isArray(magnets) ? magnets : findMagnets({ deep: false });
        if (found.length > 0) return true;
        const host = String(location.hostname || '').replace(/^www\./i, '').toLowerCase();
        const path = String(location.pathname || '').toLowerCase();
        const title = String(document.title || '').toLowerCase();
        const text = String(document.body?.innerText || '').slice(0, 12000).toLowerCase();
        const knownTorrentHost = Boolean(detectProviderFromHost(host)) || /torrent|magnet|bt4g|1337x|btdig|corsaro|piratebay/i.test(host);
        const torrentRoute = /(?:^|\/)(?:torrent|magnet|download|scarica|details?|search)(?:\/|$)/i.test(path);
        const signalCount = ['magnet', 'download torrent', 'seeders', 'leechers', 'infohash', 'hash torrent', 'torrent file'].reduce((count, token) => count + (text.includes(token) ? 1 : 0), 0);
        return knownTorrentHost && (torrentRoute || signalCount >= 1 || /torrent|magnet/.test(title));
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
            #${APP_ID}, #${APP_ID} *, #${MODAL_ID}, #${MODAL_ID} * { box-sizing:border-box; font-family: Outfit, Rajdhani, Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
            #${APP_ID} { position:fixed; inset:auto 18px 18px auto; z-index:2147483646; color:#e0f7fa; }
            #${BUTTON_ID} {
                display:flex; align-items:center; gap:10px; border:1px solid rgba(0,242,255,.45); border-radius:999px; padding:12px 16px;
                color:#e0f7fa; background:linear-gradient(135deg, rgba(0,2,5,.96), rgba(0,69,124,.94) 48%, rgba(112,0,255,.52));
                box-shadow:0 18px 55px rgba(0,0,0,.55), inset 0 0 18px rgba(0,242,255,.08), 0 0 24px rgba(0,242,255,.2);
                cursor:pointer; font-weight:900; letter-spacing:.04em; backdrop-filter:blur(18px); transition:transform .16s ease, box-shadow .16s ease, border-color .16s ease;
            }
            #${BUTTON_ID}:hover { transform:translateY(-2px) scale(1.01); border-color:rgba(0,242,255,.9); box-shadow:0 24px 70px rgba(0,0,0,.62), 0 0 38px rgba(0,242,255,.34); }
            .levi-dot { width:11px; height:11px; border-radius:999px; background:#00ff9d; box-shadow:0 0 20px #00ff9d; animation:levi-pulse 1.8s ease-in-out infinite; }
            .levi-count { font-size:12px; padding:3px 8px; border-radius:999px; background:rgba(0,242,255,.13); border:1px solid rgba(0,242,255,.25); color:#e0f7fa; }
            @keyframes levi-pulse { 0%,100%{opacity:.75; transform:scale(.92)} 50%{opacity:1; transform:scale(1.08)} }

            #${MODAL_ID} {
                position:fixed; inset:0; z-index:2147483647; display:flex; align-items:center; justify-content:center; padding:18px;
                color:#e0f7fa; background:radial-gradient(circle at 50% 8%, rgba(0,242,255,.11), rgba(112,0,255,.06) 32%, transparent 58%), radial-gradient(circle at 20% 80%, rgba(0,242,255,.08), transparent 40%), radial-gradient(circle at 80% 70%, rgba(112,0,255,.08), transparent 42%), linear-gradient(180deg, rgba(0,2,5,.9), rgba(0,0,0,.82));
                backdrop-filter:blur(13px) saturate(1.15);
            }
            .levi-shell {
                width:min(1220px, calc(100vw - 20px)); height:min(94vh, 910px); min-height:610px; display:flex; flex-direction:column; overflow:hidden; position:relative;
                border:1px solid rgba(0,242,255,.28); border-radius:28px; background:linear-gradient(160deg, rgba(2,12,20,.94), rgba(0,0,0,.98));
                box-shadow:0 34px 130px rgba(0,0,0,.72), inset 0 0 22px rgba(0,242,255,.06), 0 0 70px rgba(0,242,255,.11);
            }
            .levi-shell::before { content:""; position:absolute; inset:0; pointer-events:none; opacity:.28; background-image:linear-gradient(rgba(0,242,255,.07) 1px, transparent 1px), linear-gradient(90deg, rgba(0,242,255,.07) 1px, transparent 1px); background-size:48px 48px; mask-image:radial-gradient(circle at center, black, transparent 86%); }
            .levi-shell::after { content:""; position:absolute; inset:-30% -20%; pointer-events:none; background:linear-gradient(110deg, transparent 0 42%, rgba(0,242,255,.07) 47%, transparent 53% 100%); animation:levi-current 6s ease-in-out infinite alternate; }
            @keyframes levi-current { from{transform:translate3d(-22px,0,0)} to{transform:translate3d(26px,0,0)} }

            .levi-header { flex:0 0 auto; position:relative; z-index:1; display:flex; align-items:center; justify-content:space-between; gap:18px; padding:19px 24px; border-bottom:1px solid rgba(0,242,255,.22); background:linear-gradient(135deg, rgba(0,69,124,.44), rgba(0,0,0,.2)), radial-gradient(circle at 8% 0%, rgba(0,242,255,.18), transparent 40%); }
            .levi-brand { display:flex; align-items:center; gap:16px; min-width:0; }
            .levi-logo-wrap { width:62px; height:62px; flex:0 0 auto; display:grid; place-items:center; border-radius:50%; border:2px solid rgba(0,242,255,.78); background:radial-gradient(circle at 50% 42%, rgba(8,34,46,.98), rgba(0,8,16,.98) 62%, rgba(0,3,8,1)); box-shadow:0 0 24px rgba(0,242,255,.32), inset 0 0 30px rgba(112,0,255,.16); overflow:hidden; }
            .levi-logo { width:70px; height:70px; object-fit:cover; transform:scale(1.08); filter:drop-shadow(0 0 12px rgba(0,242,255,.2)); }
            .levi-title { font-family:Rajdhani, Outfit, sans-serif; margin:0; font-size:28px; line-height:1; font-weight:1000; letter-spacing:.02em; text-transform:uppercase; background:linear-gradient(180deg, #fff 0%, #00f2ff 45%, #7000ff 100%); -webkit-background-clip:text; -webkit-text-fill-color:transparent; filter:drop-shadow(0 0 14px rgba(0,242,255,.28)); }
            .levi-subtitle { color:#8baac2; font-size:13px; line-height:1.35; margin-top:6px; max-width:820px; }
            .levi-close { border:1px solid rgba(0,242,255,.18); color:#e0f7fa; background:rgba(0,242,255,.07); border-radius:16px; width:44px; height:44px; cursor:pointer; font-size:26px; font-weight:900; }
            .levi-close:hover { background:rgba(255,51,102,.16); color:#fff; border-color:rgba(255,51,102,.36); }

            .levi-body { flex:1 1 auto; min-height:0; position:relative; z-index:1; display:grid; grid-template-columns:minmax(0,1fr) minmax(380px,.9fr); gap:16px; padding:18px 20px; overflow:auto; scrollbar-width:thin; scrollbar-color:rgba(0,242,255,.65) rgba(0,0,0,.35); }
            .levi-body::-webkit-scrollbar, .levi-list::-webkit-scrollbar, .levi-status::-webkit-scrollbar { width:9px; height:9px; }
            .levi-body::-webkit-scrollbar-thumb, .levi-list::-webkit-scrollbar-thumb, .levi-status::-webkit-scrollbar-thumb { background:#00f2ff; border-radius:999px; box-shadow:0 0 10px rgba(0,242,255,.3); }
            .levi-body::-webkit-scrollbar-track, .levi-list::-webkit-scrollbar-track, .levi-status::-webkit-scrollbar-track { background:rgba(0,0,0,.36); }
            .levi-column { display:flex; flex-direction:column; gap:16px; min-width:0; }
            .levi-card { border:1px solid rgba(0,242,255,.18); border-radius:22px; background:linear-gradient(180deg, rgba(0,242,255,.055), rgba(0,0,0,.36)); box-shadow:0 15px 40px rgba(0,0,0,.28), inset 0 0 20px rgba(0,242,255,.035); padding:16px; position:relative; overflow:hidden; }
            .levi-card.highlight { border-color:rgba(0,242,255,.32); background:linear-gradient(180deg, rgba(0,69,124,.22), rgba(0,0,0,.42)); }
            .levi-card h3 { margin:0 0 13px; font-family:Rajdhani, Outfit, sans-serif; font-size:16px; text-transform:uppercase; letter-spacing:.11em; color:#fff; display:flex; align-items:center; gap:8px; text-shadow:0 0 10px rgba(0,242,255,.2); }
            .levi-card h3 span { color:#00f2ff; }
            .levi-grid2 { display:grid; grid-template-columns:1fr 1fr; gap:12px; }
            .levi-grid3 { display:grid; grid-template-columns:1fr 1fr 1fr; gap:12px; }
            .levi-field { display:flex; flex-direction:column; gap:7px; margin-bottom:12px; }
            .levi-field label { font-size:12px; color:#8baac2; font-weight:900; text-transform:uppercase; letter-spacing:.04em; }
            .levi-input, .levi-select, .levi-textarea { width:100%; border:1px solid rgba(0,242,255,.2); border-radius:14px; padding:12px 13px; color:#e0f7fa; background-color:#02060a; background-image:linear-gradient(rgba(0,242,255,.05) 1px, transparent 1px), linear-gradient(90deg, rgba(0,242,255,.05) 1px, transparent 1px); background-size:20px 20px; outline:none; font-weight:750; box-shadow:inset 0 0 18px rgba(0,0,0,.5); }
            .levi-select { appearance:auto; }
            .levi-textarea { min-height:84px; max-height:160px; resize:vertical; font-family:JetBrains Mono, ui-monospace, SFMono-Regular, Menlo, monospace; font-size:12px; line-height:1.35; }
            .levi-input:focus, .levi-select:focus, .levi-textarea:focus { border-color:#00f2ff; color:#fff; box-shadow:0 0 15px rgba(0,242,255,.12), inset 0 0 28px rgba(0,242,255,.05); }
            .levi-help { color:#8baac2; font-size:12px; line-height:1.4; }
            .levi-actions { display:flex; flex-wrap:wrap; gap:10px; align-items:center; }
            .levi-btn { border:1px solid rgba(0,242,255,.28); border-radius:15px; padding:11px 14px; color:#fff; background:linear-gradient(135deg, rgba(0,242,255,.16), rgba(112,0,255,.18)); font-weight:950; cursor:pointer; box-shadow:0 0 14px rgba(0,242,255,.12); transition:transform .14s ease, filter .14s ease, box-shadow .14s ease; }
            .levi-btn:hover { transform:translateY(-1px); filter:brightness(1.1); box-shadow:0 0 22px rgba(0,242,255,.22); }
            .levi-btn.primary { background:linear-gradient(135deg, #00a6d6, #00457c 50%, #7000ff); border-color:rgba(0,242,255,.52); }
            .levi-btn.secondary { background:rgba(255,255,255,.075); color:#d8f8ff; box-shadow:none; }
            .levi-btn.big { padding:14px 18px; border-radius:18px; font-size:15px; min-width:205px; }
            .levi-btn:disabled { opacity:.55; cursor:not-allowed; }
            .levi-tabs { display:grid; grid-template-columns:repeat(4,1fr); gap:8px; padding:8px; border-radius:18px; background:rgba(0,0,0,.4); box-shadow:inset 0 0 12px rgba(0,0,0,.35); }
            .levi-tab { text-align:center; padding:12px 8px; cursor:pointer; border-radius:14px; border:1px solid transparent; color:#8baac2; font-family:Rajdhani, Outfit, sans-serif; font-weight:900; letter-spacing:.06em; background:transparent; }
            .levi-tab.active { background:linear-gradient(135deg, rgba(0,242,255,.15), rgba(112,0,255,.15)); border-color:#00f2ff; color:#fff; box-shadow:0 0 13px rgba(0,242,255,.18), inset 0 0 10px rgba(0,242,255,.08); }
            .levi-chipline { display:flex; flex-wrap:wrap; gap:8px; margin-top:10px; }
            .levi-chip { border:1px solid rgba(0,242,255,.26); background:rgba(0,242,255,.09); color:#d6faff; padding:6px 10px; border-radius:999px; font-size:12px; font-weight:900; }
            .levi-chip.gold { border-color:rgba(255,204,0,.38); color:#fff3b0; background:rgba(255,204,0,.11); }
            .levi-chip.bad { border-color:rgba(255,51,102,.35); color:#ffd7e0; background:rgba(255,51,102,.1); }
            .levi-list { display:flex; flex-direction:column; gap:10px; max-height:410px; overflow:auto; padding-right:4px; }
            .levi-release { border:1px solid rgba(0,242,255,.14); border-radius:19px; padding:12px; background:rgba(2,6,23,.48); cursor:pointer; transition:border .15s ease, transform .15s ease, background .15s ease; }
            .levi-release:hover, .levi-release.selected { border-color:#00f2ff; background:rgba(0,242,255,.12); transform:translateY(-1px); }
            .levi-release-top { display:flex; justify-content:space-between; gap:10px; align-items:flex-start; }
            .levi-release-title { font-weight:1000; color:#fff; line-height:1.2; word-break:break-word; }
            .levi-score { padding:6px 9px; border-radius:999px; background:rgba(0,255,157,.12); color:#bbf7d0; font-size:12px; font-weight:1000; white-space:nowrap; border:1px solid rgba(0,255,157,.24); }
            .levi-mini { color:#8baac2; font-size:12px; margin-top:5px; }
            .levi-candidate { display:grid; grid-template-columns:58px 1fr auto; gap:11px; align-items:center; border:1px solid rgba(0,242,255,.14); border-radius:18px; padding:9px; background:rgba(2,6,23,.46); cursor:pointer; transition:border .15s ease, transform .15s ease, background .15s ease; }
            .levi-candidate:hover, .levi-candidate.selected { border-color:#00f2ff; background:rgba(0,242,255,.12); transform:translateY(-1px); }
            .levi-poster { width:58px; height:84px; border-radius:13px; object-fit:cover; background:linear-gradient(135deg, rgba(0,242,255,.16), rgba(112,0,255,.12)); display:flex; align-items:center; justify-content:center; color:#00f2ff; font-weight:1000; border:1px solid rgba(0,242,255,.16); }
            .levi-candidate-title { font-weight:1000; color:#fff; margin-bottom:4px; }
            .levi-candidate-meta { color:#b8d7ea; font-size:12px; margin-bottom:5px; }
            .levi-overview { color:#8baac2; font-size:12px; line-height:1.3; display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical; overflow:hidden; }
            .levi-footer { flex:0 0 auto; position:relative; z-index:2; display:grid; grid-template-columns:auto auto 1fr; gap:12px; align-items:center; padding:14px 20px 16px; border-top:1px solid rgba(0,242,255,.18); background:linear-gradient(180deg, rgba(2,6,23,.72), rgba(2,6,23,.98)); box-shadow:0 -18px 40px rgba(0,0,0,.3); }
            .levi-status { padding:12px 14px; border-radius:16px; font-size:13px; line-height:1.35; white-space:pre-line; border:1px solid rgba(0,242,255,.14); background:rgba(15,23,42,.74); color:#dbeafe; max-height:96px; overflow:auto; }
            .levi-status.ok { border-color:rgba(0,255,157,.35); background:rgba(0,255,157,.1); color:#dcfce7; }
            .levi-status.error { border-color:rgba(255,51,102,.42); background:rgba(255,51,102,.12); color:#fee2e2; }
            .levi-status.warn { border-color:rgba(255,204,0,.4); background:rgba(255,204,0,.12); color:#fef3c7; }
            .levi-kv { display:grid; grid-template-columns:120px 1fr; gap:6px 10px; font-size:12px; color:#8baac2; }
            .levi-kv b { color:#e0f7fa; }
            @media (max-width:960px) { #${MODAL_ID}{padding:8px; align-items:stretch}.levi-shell{width:100%; height:calc(100vh - 16px); min-height:0; border-radius:22px}.levi-body{grid-template-columns:1fr; padding:14px}.levi-grid2,.levi-grid3{grid-template-columns:1fr}.levi-footer{grid-template-columns:1fr}.levi-btn.big{width:100%}.levi-tabs{grid-template-columns:1fr 1fr}.levi-header{padding:15px}.levi-title{font-size:22px}.levi-logo-wrap{width:50px;height:50px}.levi-logo{width:58px;height:58px} }
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

    function hydrateStateFromPage() {
        const pageInfo = getPageInfo();
        state.pageInfo = pageInfo;
        state.provider = cleanProviderLabel(pageInfo.provider);
        state.providerHost = pageInfo.host;
        state.sourceTitle = pageInfo.rawTitle || document.title || '';
        if (pageInfo.imdbId && !state.imdbId) state.imdbId = pageInfo.imdbId;

        const analyses = getAnalyzedMagnets(true);
        if (!state.magnet && analyses[0]) state.magnet = analyses[0].magnet;
        const selected = analyses.find((info) => extractHash(info.magnet) === extractHash(state.magnet)) || analyses[0] || null;
        if (selected) applyAnalysisToState(selected, { preserveIds: true, preserveTitle: Boolean(state.title) });
        else if (!state.title) state.title = cleanReleaseTitle(pageInfo.rawTitle || getUrlTitleGuess() || document.title || '');
    }

    function applyAnalysisToState(analysis, options = {}) {
        state.selectedAnalysis = analysis;
        state.magnet = analysis.magnet || state.magnet;
        state.provider = analysis.provider || state.provider;
        state.providerHost = analysis.providerHost || state.providerHost;
        if (!options.preserveTitle) state.title = analysis.cleanTitle || state.title;
        state.year = analysis.year || state.year || '';
        if (analysis.season || analysis.episode) {
            state.type = 'series';
            state.season = analysis.season || state.season;
            state.episode = analysis.episode || state.episode;
        }
        if (!options.preserveIds && state.pageInfo?.imdbId) state.imdbId = state.pageInfo.imdbId;
    }

    async function hydrateStoredState() {
        const stored = await getStored(['leviathanAddonBaseUrl', 'leviathanLastType', 'leviathanCacheMode']);
        state.addonBaseUrl = stored.leviathanAddonBaseUrl || state.addonBaseUrl || '';
        state.type = stored.leviathanLastType || state.type || 'movie';
        state.cacheMode = stored.leviathanCacheMode || state.cacheMode || 'rd';
    }

    function candidatePoster(candidate) {
        return candidate.posterPath ? `${TMDB_POSTER_BASE}${candidate.posterPath}` : (candidate.poster || candidate.posterUrl || '');
    }

    function titleSimilarity(a, b) {
        const na = cleanReleaseTitle(a).toLowerCase().split(/\s+/).filter(Boolean);
        const nb = cleanReleaseTitle(b).toLowerCase().split(/\s+/).filter(Boolean);
        if (!na.length || !nb.length) return 0;
        const setB = new Set(nb);
        const hit = na.filter((part) => setB.has(part)).length;
        return Math.round((hit / Math.max(na.length, nb.length)) * 100);
    }

    function explainCandidate(candidate) {
        const sim = titleSimilarity(state.title, candidate.title || candidate.originalTitle || '');
        const bits = [];
        if (sim >= 75) bits.push('titolo molto vicino');
        else if (sim >= 45) bits.push('titolo parziale');
        else bits.push('titolo debole');
        if (state.year && candidate.year && String(candidate.year) === String(state.year)) bits.push('anno identico');
        else if (state.year && candidate.year) bits.push(`anno diverso: release ${state.year}, candidato ${candidate.year}`);
        if (candidate.type === state.type) bits.push('tipo corretto');
        else bits.push(`tipo da verificare: ${candidate.type || 'n/d'}`);
        return bits.join(' • ');
    }

    function renderCandidate(candidate, index) {
        const selected = state.imdbId && candidate.imdbId === state.imdbId;
        const poster = candidatePoster(candidate);
        const explain = explainCandidate(candidate);
        return `
            <div class="levi-candidate ${selected ? 'selected' : ''}" data-candidate-index="${index}">
                ${poster ? `<img class="levi-poster" src="${escapeHtml(poster)}" alt="poster">` : '<div class="levi-poster">IMDb</div>'}
                <div>
                    <div class="levi-candidate-title">${escapeHtml(candidate.title || 'Senza titolo')}</div>
                    <div class="levi-candidate-meta">${escapeHtml(candidate.imdbId || 'IMDb n/d')} • ${escapeHtml(candidate.type || '')}${candidate.year ? ` • ${escapeHtml(candidate.year)}` : ''}${candidate.tmdbId ? ` • TMDB ${escapeHtml(candidate.tmdbId)}` : ''}</div>
                    <div class="levi-overview">${escapeHtml(explain || candidate.overview || 'Clicca per usare questo ID nel contributo.')}</div>
                </div>
                <div class="levi-score">${Math.round(Number(candidate.score || titleSimilarity(state.title, candidate.title || '') || 0))}</div>
            </div>`;
    }

    function renderRelease(info, index) {
        const selected = extractHash(info.magnet) === extractHash(state.magnet);
        const chips = [
            info.provider,
            info.year || 'anno n/d',
            info.resolution || 'res n/d',
            info.languages.length ? info.languages.join('/') : 'lingua n/d',
            info.codec || 'codec n/d',
            info.sizeLabel || 'size n/d',
            info.seed != null ? `S ${info.seed}` : 'seed n/d',
            info.leech != null ? `L ${info.leech}` : 'leech n/d',
            info.packLabel
        ];
        return `
            <div class="levi-release ${selected ? 'selected' : ''}" data-release-index="${index}">
                <div class="levi-release-top">
                    <div>
                        <div class="levi-release-title">${escapeHtml(info.cleanTitle)}</div>
                        <div class="levi-mini">${escapeHtml(info.rawTitle)}</div>
                    </div>
                    <div class="levi-score">${info.score}</div>
                </div>
                <div class="levi-chipline">${chips.map((chip) => `<span class="levi-chip ${/n\/d/i.test(chip) ? 'bad' : ''}">${escapeHtml(chip)}</span>`).join('')}</div>
            </div>`;
    }

    function renderFacts(info) {
        if (!info) return '<div class="levi-help">Nessun magnet selezionato.</div>';
        const facts = [
            ['Provider', `${info.provider}${info.providerHost ? ` (${info.providerHost})` : ''}`],
            ['Titolo pulito', info.cleanTitle],
            ['Anno', info.year || 'n/d'],
            ['Risoluzione', info.resolution || 'n/d'],
            ['Lingua', info.languages.length ? info.languages.join(', ') : 'n/d'],
            ['Codec', info.codec || 'n/d'],
            ['Dimensione', info.sizeLabel || 'n/d'],
            ['Seed/Leech', `${info.seed ?? 'n/d'} / ${info.leech ?? 'n/d'}`],
            ['Tipo file', `${info.packLabel} — ${info.packReason}`],
            ['Hash', info.hash || 'n/d']
        ];
        return `<div class="levi-kv">${facts.map(([k, v]) => `<span>${escapeHtml(k)}</span><b>${escapeHtml(v)}</b>`).join('')}</div>`;
    }

    function cacheModeLabel(mode = state.cacheMode) {
        if (mode === 'none') return 'Nessuno';
        if (mode === 'rd') return 'Real-Debrid';
        if (mode === 'tb') return 'TorBox';
        if (mode === 'both') return 'RD + TorBox';
        return mode;
    }

    function formatCacheScanLine(label, scan) {
        if (!scan) return null;
        if (scan.skipped) {
            const reason = scan.reason || 'disabled';
            if (reason === 'missing_torbox_token') return `${label}: saltato — API key assente, import salvato comunque`;
            return `${label}: saltato (${reason})`;
        }
        if (scan.state === 'error') return `${label}: errore scan non bloccante — ${scan.error || 'dettaglio non disponibile'}`;
        return `${label}: ${scan.cached ? '⚡ cached' : (scan.state || 'non cached')}${scan.fileTitle ? ` - ${scan.fileTitle}` : ''}`;
    }

    function buildSummaryText() {
        const info = state.selectedAnalysis;
        const hash = extractHash(state.magnet) || 'nessun hash';
        return [
            `Provider: ${state.provider || detectSourceProvider()}`,
            `Titolo pulito: ${state.title || info?.cleanTitle || cleanReleaseTitle(extractTitleFromMagnet(state.magnet))}`,
            `Anno: ${state.year || info?.year || 'n/d'}`,
            `Release: ${info?.resolution || 'res n/d'} • ${info?.languages?.join('/') || 'lingua n/d'} • ${info?.codec || 'codec n/d'} • ${info?.sizeLabel || 'size n/d'}`,
            `Seed/Leech: ${info?.seed ?? 'n/d'} / ${info?.leech ?? 'n/d'}`,
            `Tipo file: ${info?.packLabel || 'n/d'}`,
            `Tipo contenuto: ${state.type}${state.type === 'series' && (state.season || state.episode) ? ` S${state.season || '?'}E${state.episode || '?'}` : ''}`,
            `IMDb: ${state.imdbId || 'auto-match backend'}`,
            `Hash: ${hash}`,
            `Cache mode: ${cacheModeLabel()}`
        ].join('\n');
    }

    function localExplainText() {
        const info = state.selectedAnalysis;
        const warnings = [];
        if (!info?.year) warnings.push('anno non rilevato');
        if (!info?.resolution) warnings.push('risoluzione non rilevata');
        if (!info?.languages?.length) warnings.push('lingua non rilevata');
        if (state.type === 'movie' && (info?.season || info?.episode)) warnings.push('release sembra episodio ma tipo impostato Film');
        if (state.type === 'series' && !state.season && !info?.season) warnings.push('serie senza stagione rilevata');
        const match = state.imdbId
            ? `IMDb forzato manualmente: ${state.imdbId}${state.tmdbId ? ` / TMDB ${state.tmdbId}` : ''}.`
            : state.candidates[0]
                ? `Miglior candidato attuale: ${state.candidates[0].title || 'n/d'} (${state.candidates[0].imdbId || 'IMDb n/d'}) — ${explainCandidate(state.candidates[0])}.`
                : 'Nessun candidato scelto: Leviathan farà auto-match prudente backend.';
        return [
            '🧠 EXPLAIN IMPORT LOCALE',
            `Provider pulito: ${state.provider || 'n/d'}${state.providerHost ? ` da ${state.providerHost}` : ''}`,
            `Titolo grezzo: ${info?.rawTitle || 'n/d'}`,
            `Titolo pulito: ${state.title || info?.cleanTitle || 'n/d'}`,
            `Anno/Risoluzione/Lingua/Codec: ${state.year || info?.year || 'n/d'} • ${info?.resolution || 'n/d'} • ${info?.languages?.join('/') || 'n/d'} • ${info?.codec || 'n/d'}`,
            `Dimensione/Seed/Leech: ${info?.sizeLabel || 'n/d'} • ${info?.seed ?? 'n/d'} • ${info?.leech ?? 'n/d'}`,
            `Single/Pack: ${info?.packLabel || 'n/d'} (${info?.packReason || 'n/d'})`,
            match,
            `Cache richiesta: ${cacheModeLabel()}`,
            warnings.length ? `⚠️ Warning: ${warnings.join(' • ')}` : '✅ Nessun warning locale forte.'
        ].join('\n');
    }

    async function persistSafeSettings() {
        await setStored({
            leviathanAddonBaseUrl: state.addonBaseUrl,
            leviathanLastType: state.type,
            leviathanCacheMode: state.cacheMode
        });
    }

    function validateConnection() {
        if (!/^https?:\/\//i.test(state.addonBaseUrl)) throw new Error('Inserisci URL base Leviathan valido: deve iniziare con http:// o https://');
        if (!sessionAdminPass) throw new Error('Inserisci ADMIN_PASS. Non viene salvata.');
    }

    function validateMagnet() {
        if (!/^magnet:\?xt=urn:btih:/i.test(state.magnet)) throw new Error('Magnet mancante o non valido. Incolla un magnet completo.');
    }

    function readInputs() {
        state.addonBaseUrl = normalizeBaseUrl(document.querySelector('#levi-base-url')?.value || state.addonBaseUrl);
        sessionAdminPass = String(document.querySelector('#levi-admin-pass')?.value || sessionAdminPass).trim();
        state.title = String(document.querySelector('#levi-title-input')?.value || state.title).trim();
        state.year = String(document.querySelector('#levi-year-input')?.value || state.year || '').trim();
        state.type = String(document.querySelector('#levi-type')?.value || state.type || 'movie');
        state.season = String(document.querySelector('#levi-season')?.value || '').trim();
        state.episode = String(document.querySelector('#levi-episode')?.value || '').trim();
        state.imdbId = String(document.querySelector('#levi-imdb-id')?.value || '').trim().toLowerCase();
        state.tmdbId = String(document.querySelector('#levi-tmdb-id')?.value || '').trim();
        state.cacheMode = document.querySelector('.levi-tab.active')?.dataset.cacheMode || state.cacheMode || 'rd';
        state.rdApiKey = String(document.querySelector('#levi-rd-key')?.value || '').trim();
        state.tbApiKey = String(document.querySelector('#levi-tb-key')?.value || '').trim();
        state.provider = String(document.querySelector('#levi-provider')?.value || state.provider || '').trim();
        const manualMagnet = String(document.querySelector('#levi-manual-magnet')?.value || state.magnet).trim();
        if (manualMagnet) {
            state.magnet = manualMagnet;
            const existing = getAnalyzedMagnets(true).find((info) => extractHash(info.magnet) === extractHash(manualMagnet));
            if (existing) state.selectedAnalysis = existing;
        }
    }

    function updateSummary() {
        const box = document.querySelector('#levi-summary-box');
        if (box) box.textContent = buildSummaryText();
        const facts = document.querySelector('#levi-facts');
        if (facts) facts.innerHTML = renderFacts(state.selectedAnalysis);
    }

    function buildPayload() {
        const season = Number.parseInt(state.season || '', 10);
        const episode = Number.parseInt(state.episode || '', 10);
        const info = state.selectedAnalysis;
        return {
            magnet: state.magnet,
            title: state.title || info?.cleanTitle || extractTitleFromMagnet(state.magnet),
            year: state.year || info?.year || null,
            sourceTitle: state.sourceTitle || document.title || '',
            provider: cleanProviderLabel(state.provider || detectSourceProvider()),
            sourceProvider: cleanProviderLabel(state.provider || detectSourceProvider()),
            sourceHost: state.providerHost || String(location.hostname || ''),
            sourceUrl: location.href,
            imdbId: /^tt\d+$/i.test(state.imdbId) ? state.imdbId : null,
            tmdbId: state.tmdbId || null,
            type: state.type,
            season: Number.isInteger(season) && season > 0 ? season : (info?.season ? Number(info.season) : null),
            episode: Number.isInteger(episode) && episode > 0 ? episode : (info?.episode ? Number(info.episode) : null),
            cacheMode: state.cacheMode,
            service: state.cacheMode === 'both' ? 'both' : (state.cacheMode === 'tb' ? 'tb' : (state.cacheMode === 'rd' ? 'rd' : null)),
            scanRd: state.cacheMode === 'rd' || state.cacheMode === 'both',
            scanTb: state.cacheMode === 'tb' || state.cacheMode === 'both',
            apiKey: state.rdApiKey || null,
            rdApiKey: state.rdApiKey || null,
            torboxApiKey: state.tbApiKey || null,
            releaseInfo: info ? {
                rawTitle: info.rawTitle,
                cleanTitle: info.cleanTitle,
                year: info.year,
                resolution: info.resolution,
                languages: info.languages,
                codec: info.codec,
                source: info.source,
                sizeLabel: info.sizeLabel,
                sizeMb: info.sizeMb,
                seed: info.seed,
                leech: info.leech,
                packKind: info.packKind,
                packLabel: info.packLabel,
                packReason: info.packReason,
                score: info.score,
                hash: info.hash
            } : null,
            pageInfo: state.pageInfo || getPageInfo(),
            explainClient: localExplainText()
        };
    }

    async function searchCandidates(auto = false) {
        readInputs();
        validateConnection();
        await persistSafeSettings();
        setStatus(auto ? 'Auto ricerca IMDb/TMDB in corso...' : 'Sto cercando candidati TMDB/IMDb tramite Leviathan...', 'warn');
        const result = await chrome.runtime.sendMessage({
            type: 'LEVIATHAN_IDENTITY_SEARCH',
            addonBaseUrl: state.addonBaseUrl,
            adminPass: sessionAdminPass,
            payload: {
                title: state.title || state.selectedAnalysis?.cleanTitle || extractTitleFromMagnet(state.magnet),
                year: state.year || state.selectedAnalysis?.year || null,
                sourceTitle: state.sourceTitle || document.title || '',
                type: state.type,
                releaseInfo: state.selectedAnalysis || null,
                pageInfo: state.pageInfo || getPageInfo()
            }
        });
        if (!result?.ok) throw new Error(result?.error || 'Ricerca IMDb fallita. Puoi comunque inviare e lasciare auto-match al backend.');
        state.candidates = Array.isArray(result.data?.candidates) ? result.data.candidates : [];
        if (!state.imdbId && state.candidates[0]?.imdbId && Number(state.candidates[0].score || 0) >= 92) {
            state.imdbId = state.candidates[0].imdbId;
            state.tmdbId = state.candidates[0].tmdbId || '';
        }
        if (state.candidates.length === 0) setStatus(`Nessun candidato forte trovato per “${state.title}”. Puoi inserire IMDb a mano o inviare senza ID.`, 'warn');
        else setStatus(`Trovati ${state.candidates.length} candidati. Migliore: ${state.candidates[0].title || 'n/d'} ${state.candidates[0].year || ''} (${state.candidates[0].imdbId || 'IMDb n/d'}).`, 'ok');
        renderModal(false);
    }

    async function testConnection() {
        readInputs();
        validateConnection();
        await persistSafeSettings();
        setStatus('Test connessione Leviathan in corso...', 'warn');
        const result = await chrome.runtime.sendMessage({
            type: 'LEVIATHAN_HEALTH_CHECK',
            addonBaseUrl: state.addonBaseUrl,
            adminPass: sessionAdminPass
        });
        if (!result?.ok) throw new Error(result?.error || 'Leviathan non raggiungibile.');
        const data = result.data || {};
        const lines = ['✅ Leviathan raggiungibile.'];
        if (result.warning) lines.push(result.warning);
        if (data.version) lines.push(`Versione: ${data.version}`);
        if (data.mode) lines.push(`Mode: ${data.mode}`);
        if (data.db || data.database) lines.push(`DB: ${data.db || data.database}`);
        setStatus(lines.join('\n'), result.warning ? 'warn' : 'ok');
    }

    async function explainImport() {
        readInputs();
        validateConnection();
        validateMagnet();
        await persistSafeSettings();
        const local = localExplainText();
        setStatus('Genero Explain Import / Match...', 'warn');
        const result = await chrome.runtime.sendMessage({
            type: 'LEVIATHAN_DRY_RUN',
            addonBaseUrl: state.addonBaseUrl,
            adminPass: sessionAdminPass,
            payload: buildPayload()
        });
        if (!result?.ok) {
            state.explainText = `${local}\n\nℹ️ Dry-run backend non disponibile: ${result?.error || 'endpoint assente'}`;
            setStatus(state.explainText, 'warn');
            return;
        }
        const data = result.data || {};
        state.explainText = data.explain || data.message || JSON.stringify(data, null, 2);
        setStatus(state.explainText, 'ok');
    }

    async function sendContribution() {
        readInputs();
        validateConnection();
        validateMagnet();
        await persistSafeSettings();
        setStatus(`Invio a Leviathan in corso... Cache mode: ${cacheModeLabel()}.`, 'warn');
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
        const rd = data?.summary?.rdScan || data?.summary?.cacheScan;
        const tb = data?.summary?.tbScan || data?.summary?.torboxScan;
        const lines = [`✅ Contributo inviato. Hash: ${hash}`];
        if (state.imdbId) lines.push(`IMDb scelto: ${state.imdbId}${state.tmdbId ? ` / TMDB ${state.tmdbId}` : ''}`);
        else if (match?.matched) lines.push(`Match automatico: ${match.imdbId} / TMDB ${match.tmdbId}`);
        else if (match?.reason) lines.push(`Match automatico: ${match.reason}`);
        const rdLine = formatCacheScanLine('RD', rd);
        const tbLine = formatCacheScanLine('TorBox', tb);
        if (rdLine) lines.push(rdLine);
        if (tbLine) lines.push(tbLine);
        setStatus(lines.join('\n'), 'ok');
    }

    function renderModal(autoHydrate = true) {
        ensureStyles();
        if (autoHydrate) hydrateStateFromPage();
        document.getElementById(MODAL_ID)?.remove();
        const analyses = getAnalyzedMagnets(true);
        if (!state.selectedAnalysis && analyses[0]) applyAnalysisToState(analyses[0], { preserveIds: true });
        const selectedHash = extractHash(state.magnet);
        const selectedAnalysis = analyses.find((info) => extractHash(info.magnet) === selectedHash) || state.selectedAnalysis || analyses[0] || null;
        if (selectedAnalysis) state.selectedAnalysis = selectedAnalysis;
        const logoUrl = (typeof chrome !== 'undefined' && chrome.runtime?.getURL) ? chrome.runtime.getURL('icons/icon128.png') : '';
        const pageInfo = state.pageInfo || getPageInfo();
        const modal = document.createElement('div');
        modal.id = MODAL_ID;
        modal.innerHTML = `
            <div class="levi-shell">
                <div class="levi-header">
                    <div class="levi-brand">
                        <div class="levi-logo-wrap">${logoUrl ? `<img class="levi-logo" src="${escapeHtml(logoUrl)}" alt="Leviathan">` : '🌊'}</div>
                        <div>
                            <h2 class="levi-title">LEVIATHAN COMPANION PRO</h2>
                            <div class="levi-subtitle">Sonar magnet intelligente: provider pulito, titolo, anno, qualità, lingua, codec, size, seed/leech, single-pack, IMDb e cache RD/TorBox.</div>
                        </div>
                    </div>
                    <button class="levi-close" id="levi-close" title="Chiudi">×</button>
                </div>

                <div class="levi-body">
                    <div class="levi-column">
                        <div class="levi-card highlight">
                            <h3><span>01</span> Sonar pagina / provider</h3>
                            <div class="levi-grid2">
                                <div class="levi-field"><label>Provider pulito</label><input class="levi-input" id="levi-provider" value="${escapeHtml(state.provider || pageInfo.provider)}"></div>
                                <div class="levi-field"><label>Host rilevato</label><input class="levi-input" value="${escapeHtml(pageInfo.host)}" readonly></div>
                            </div>
                            <div class="levi-chipline">
                                <span class="levi-chip">${escapeHtml(analyses.length)} magnet</span>
                                <span class="levi-chip ${pageInfo.imdbId ? 'gold' : ''}">IMDb pagina: ${escapeHtml(pageInfo.imdbId || 'n/d')}</span>
                                <span class="levi-chip">JSON-LD: ${pageInfo.hasStructuredData ? 'sì' : 'no'}</span>
                            </div>
                        </div>

                        <div class="levi-card">
                            <h3><span>02</span> Magnet Intelligence</h3>
                            <div class="levi-list" id="levi-release-list">
                                ${analyses.length ? analyses.map(renderRelease).join('') : '<div class="levi-help">Nessun magnet trovato. Incolla un magnet manualmente sotto.</div>'}
                            </div>
                            <div class="levi-field" style="margin-top:12px;"><label>Magnet selezionato / manuale</label><textarea class="levi-textarea" id="levi-manual-magnet" spellcheck="false">${escapeHtml(state.magnet || '')}</textarea></div>
                            <div class="levi-actions">
                                <button class="levi-btn secondary" id="levi-refresh-magnets">↻ Rileggi pagina</button>
                                <button class="levi-btn secondary" id="levi-title-from-magnet">✨ Usa analisi migliore</button>
                            </div>
                        </div>

                        <div class="levi-card">
                            <h3><span>03</span> Dettagli rilevati</h3>
                            <div id="levi-facts">${renderFacts(selectedAnalysis)}</div>
                        </div>

                        <div class="levi-card">
                            <h3><span>04</span> IMDb Assistant</h3>
                            <div class="levi-grid2">
                                <div class="levi-field"><label>Titolo pulito</label><input class="levi-input" id="levi-title-input" value="${escapeHtml(state.title || selectedAnalysis?.cleanTitle || '')}" placeholder="Es. Scream"></div>
                                <div class="levi-field"><label>Anno</label><input class="levi-input" id="levi-year-input" value="${escapeHtml(state.year || selectedAnalysis?.year || '')}" placeholder="Es. 2026"></div>
                            </div>
                            <div class="levi-grid3">
                                <div class="levi-field"><label>Tipo</label><select class="levi-select" id="levi-type"><option value="movie" ${state.type === 'movie' ? 'selected' : ''}>Film</option><option value="series" ${state.type === 'series' ? 'selected' : ''}>Serie / episodio</option></select></div>
                                <div class="levi-field"><label>Stagione</label><input class="levi-input" id="levi-season" inputmode="numeric" value="${escapeHtml(state.season)}" placeholder="auto"></div>
                                <div class="levi-field"><label>Episodio</label><input class="levi-input" id="levi-episode" inputmode="numeric" value="${escapeHtml(state.episode)}" placeholder="auto"></div>
                            </div>
                            <div class="levi-grid2">
                                <div class="levi-field"><label>IMDb ID</label><input class="levi-input" id="levi-imdb-id" value="${escapeHtml(state.imdbId)}" placeholder="tt1234567 oppure auto"></div>
                                <div class="levi-field"><label>TMDB ID</label><input class="levi-input" id="levi-tmdb-id" value="${escapeHtml(state.tmdbId)}" placeholder="auto"></div>
                            </div>
                            <div class="levi-actions">
                                <button class="levi-btn" id="levi-search-imdb">🔎 Cerca candidati</button>
                                <button class="levi-btn secondary" id="levi-clear-imdb">Pulisci ID</button>
                            </div>
                        </div>
                    </div>

                    <div class="levi-column">
                        <div class="levi-card highlight">
                            <h3><span>05</span> Candidati IMDb/TMDB</h3>
                            <div class="levi-list" id="levi-candidates">
                                ${state.candidates.length ? state.candidates.map(renderCandidate).join('') : '<div class="levi-help">Premi “Cerca candidati”. L’assistente confronta titolo, anno e tipo; se trova un match fortissimo può precompilare IMDb.</div>'}
                            </div>
                        </div>

                        <div class="levi-card">
                            <h3><span>06</span> RD + TorBox mode</h3>
                            <div class="levi-tabs" id="levi-cache-tabs">
                                ${['none','rd','tb','both'].map((mode) => `<button class="levi-tab ${state.cacheMode === mode ? 'active' : ''}" data-cache-mode="${mode}">${escapeHtml(cacheModeLabel(mode))}</button>`).join('')}
                            </div>
                            <div class="levi-grid2" style="margin-top:12px;">
                                <div class="levi-field"><label>API key RD opzionale</label><input class="levi-input" id="levi-rd-key" type="password" value="${escapeHtml(state.rdApiKey)}" placeholder="usa env VPS se vuoto"></div>
                                <div class="levi-field"><label>API key TorBox opzionale</label><input class="levi-input" id="levi-tb-key" type="password" value="${escapeHtml(state.tbApiKey)}" placeholder="usa env VPS se vuoto"></div>
                            </div>
                            <div class="levi-help">TorBox è opzionale e non bloccante: se manca la API key, Leviathan salva comunque il magnet/file e salta solo lo scan TorBox.</div>
                        </div>

                        <div class="levi-card">
                            <h3><span>07</span> Test / Explain</h3>
                            <div class="levi-grid2">
                                <div class="levi-field"><label>URL base Leviathan</label><input class="levi-input" id="levi-base-url" value="${escapeHtml(state.addonBaseUrl)}" placeholder="https://tuo-addon.example"></div>
                                <div class="levi-field"><label>ADMIN_PASS</label><input class="levi-input" id="levi-admin-pass" type="password" value="${escapeHtml(sessionAdminPass)}" placeholder="non viene salvata"></div>
                            </div>
                            <div class="levi-actions">
                                <button class="levi-btn secondary" id="levi-test-connection">🔌 Test connessione</button>
                                <button class="levi-btn secondary" id="levi-explain">🧠 Explain Import / Match</button>
                            </div>
                        </div>

                        <div class="levi-card">
                            <h3><span>08</span> Riepilogo rapido</h3>
                            <div class="levi-help" id="levi-summary-box" style="white-space:pre-line;">${escapeHtml(buildSummaryText())}</div>
                            <div class="levi-actions" style="margin-top:12px;"><button class="levi-btn secondary" id="levi-copy-summary">Copia riepilogo</button></div>
                        </div>
                    </div>
                </div>

                <div class="levi-footer">
                    <button class="levi-btn big primary" id="levi-send">🚀 Invia a Leviathan</button>
                    <button class="levi-btn big secondary" id="levi-auto-imdb">⚡ Auto IMDb</button>
                    <div id="levi-status" class="levi-status ${escapeHtml(state.statusKind)}">${escapeHtml(state.status || 'Pronto. Seleziona il magnet migliore, verifica IMDb, scegli RD/TorBox e invia.')}</div>
                </div>
            </div>`;
        document.documentElement.appendChild(modal);
        wireModalEvents(analyses);
    }

    function wireModalEvents(analyses) {
        document.querySelector('#levi-close')?.addEventListener('click', () => document.getElementById(MODAL_ID)?.remove());

        document.querySelectorAll('[data-release-index]').forEach((node) => {
            node.addEventListener('click', () => {
                const index = Number.parseInt(node.getAttribute('data-release-index') || '', 10);
                const info = analyses[index];
                if (!info) return;
                applyAnalysisToState(info, { preserveIds: true, preserveTitle: false });
                setStatus(`Selezionato magnet: ${info.cleanTitle}\n${info.resolution || 'res n/d'} • ${info.languages.join('/') || 'lingua n/d'} • ${info.seed ?? 'seed n/d'} seed • ${info.packLabel}`, 'ok');
                renderModal(false);
            });
        });

        const inputIds = ['#levi-base-url', '#levi-admin-pass', '#levi-manual-magnet', '#levi-title-input', '#levi-year-input', '#levi-type', '#levi-season', '#levi-episode', '#levi-imdb-id', '#levi-tmdb-id', '#levi-rd-key', '#levi-tb-key', '#levi-provider'];
        inputIds.forEach((selector) => {
            document.querySelector(selector)?.addEventListener('input', () => {
                readInputs();
                updateSummary();
                if (selector === '#levi-title-input' || selector === '#levi-year-input' || selector === '#levi-type') {
                    clearTimeout(identityTimer);
                    identityTimer = setTimeout(() => {
                        if (state.addonBaseUrl && sessionAdminPass && state.title.length >= 3) searchCandidates(true).catch(() => {});
                    }, 950);
                }
            });
            document.querySelector(selector)?.addEventListener('change', () => { readInputs(); updateSummary(); });
        });

        document.querySelectorAll('[data-cache-mode]').forEach((node) => {
            node.addEventListener('click', () => {
                document.querySelectorAll('[data-cache-mode]').forEach((el) => el.classList.remove('active'));
                node.classList.add('active');
                readInputs();
                updateSummary();
            });
        });

        document.querySelector('#levi-refresh-magnets')?.addEventListener('click', () => {
            state.selectedAnalysis = null;
            const best = getAnalyzedMagnets(true)[0];
            if (best) applyAnalysisToState(best, { preserveIds: true });
            renderModal(false);
        });

        document.querySelector('#levi-title-from-magnet')?.addEventListener('click', () => {
            const best = state.selectedAnalysis || getAnalyzedMagnets(true)[0];
            if (best) applyAnalysisToState(best, { preserveIds: true, preserveTitle: false });
            renderModal(false);
        });

        document.querySelector('#levi-search-imdb')?.addEventListener('click', async () => {
            try { await searchCandidates(false); } catch (error) { setStatus(`Errore ricerca IMDb: ${error.message}`, 'error'); }
        });

        document.querySelector('#levi-auto-imdb')?.addEventListener('click', async () => {
            try { await searchCandidates(false); } catch (error) { setStatus(`Errore Auto IMDb: ${error.message}`, 'error'); }
        });

        document.querySelector('#levi-clear-imdb')?.addEventListener('click', () => {
            state.imdbId = ''; state.tmdbId = ''; renderModal(false);
        });

        document.querySelector('#levi-test-connection')?.addEventListener('click', async () => {
            try { await testConnection(); } catch (error) { setStatus(`Errore test: ${error.message}`, 'error'); }
        });

        document.querySelector('#levi-explain')?.addEventListener('click', async () => {
            try { await explainImport(); } catch (error) { setStatus(`${localExplainText()}\n\nErrore explain backend: ${error.message}`, 'warn'); }
        });

        document.querySelector('#levi-send')?.addEventListener('click', async () => {
            try { await sendContribution(); } catch (error) { setStatus(`Errore invio: ${error.message}`, 'error'); }
        });

        document.querySelector('#levi-copy-summary')?.addEventListener('click', async () => {
            readInputs();
            const summary = buildSummaryText();
            try { await navigator.clipboard.writeText(summary); setStatus('Riepilogo copiato negli appunti.', 'ok'); }
            catch (_) { setStatus(summary, 'warn'); }
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
                state.year = candidate.year || state.year;
                setStatus(`Selezionato: ${candidate.title || 'n/d'} — ${candidate.imdbId || 'IMDb n/d'}${candidate.tmdbId ? ` / TMDB ${candidate.tmdbId}` : ''}\n${explainCandidate(candidate)}`, 'ok');
                renderModal(false);
            });
        });
    }

    async function openModal() {
        await hydrateStoredState();
        hydrateStateFromPage();
        renderModal(false);
    }

    function renderFloatingButton() {
        const magnets = findMagnets({ deep: false });
        const shouldShow = isTorrentLikePage(magnets);
        const existingApp = document.getElementById(APP_ID);
        if (!shouldShow) {
            existingApp?.remove();
            lastMagnetSignature = '';
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
        const provider = detectSourceProvider();
        const button = document.getElementById(BUTTON_ID);
        if (button) {
            button.innerHTML = `<span class="levi-dot"></span><span>Leviathan Companion</span><span class="levi-count">${escapeHtml(provider)} • ${magnets.length ? `${magnets.length} magnet` : 'torrent'}</span>`;
            button.title = magnets.length ? 'Apri import assistito Leviathan' : 'Apri Leviathan Companion su pagina torrent';
        }
        lastMagnetSignature = magnetSignature();
    }

    function scheduleRenderFloatingButton() {
        clearTimeout(scanTimer);
        scanTimer = setTimeout(() => {
            const sig = magnetSignature();
            const appVisible = Boolean(document.getElementById(APP_ID));
            const shouldShow = isTorrentLikePage();
            if (sig !== lastMagnetSignature || appVisible !== shouldShow) renderFloatingButton();
        }, 450);
    }

    function startObserver() {
        if (observerStarted || !document.body) return;
        observerStarted = true;
        const observer = new MutationObserver(scheduleRenderFloatingButton);
        observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['href'] });
    }

    renderFloatingButton();
    startObserver();
})();
