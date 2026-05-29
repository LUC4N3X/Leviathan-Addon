'use strict';

const packageMeta = require('../../../package.json');
const runtimeState = require('../../runtime_state');
const tmdbHelper = require('../../utils/tmdb_helper');
const RealDebridProbe = require('../../debrid/rd/probe/realdebrid_probe');
const TorboxClient = require('../../debrid/tb/clients/torbox_client');
const { parseSeasonEpisode } = require('../../intelligence/pack_intelligence');
const {
    normalizeHash,
    parseMagnetInput,
    parseTorrentInput,
    inferPackMappings
} = require('../../lib/manual_import_parser');

function normalizeHashes(values) {
    return [...new Set((Array.isArray(values) ? values : [values])
        .map((value) => normalizeHash(value))
        .filter(Boolean))];
}

function normalizeTmdbId(value) {
    const normalized = String(value || '').trim().replace(/^tmdb:(?:movie|tv|series):/i, '').replace(/^tmdb:/i, '');
    return /^\d+$/.test(normalized) ? normalized : null;
}


function readBoolean(value, fallback = false) {
    if (value === true || value === false) return value;
    const normalized = String(value ?? '').trim().toLowerCase();
    if (['1', 'true', 'yes', 'y', 'on'].includes(normalized)) return true;
    if (['0', 'false', 'no', 'n', 'off'].includes(normalized)) return false;
    return fallback;
}

function normalizeCacheMode(body = {}) {
    const raw = String(body.cacheMode || body.cache_mode || body.service || '').trim().toLowerCase();
    if (['none', 'off', 'disabled', 'no'].includes(raw)) return 'none';
    if (['tb', 'torbox', 'tor-box'].includes(raw)) return 'tb';
    if (['both', 'all', 'rd+tb', 'rd_tb', 'rd-tb', 'realdebrid+torbox', 'real-debrid+torbox'].includes(raw)) return 'both';
    if (['rd', 'realdebrid', 'real-debrid'].includes(raw)) return 'rd';

    const wantsRd = readBoolean(body.scanRd ?? body.scan_rd, false);
    const wantsTb = readBoolean(body.scanTb ?? body.scan_tb, false);
    if (wantsRd && wantsTb) return 'both';
    if (wantsTb) return 'tb';
    if (wantsRd) return 'rd';
    return 'rd';
}

function normalizeReleaseInfo(value = {}) {
    const input = value && typeof value === 'object' ? value : {};
    const rawLanguages = Array.isArray(input.languages) ? input.languages : String(input.languages || '').split(/[,|/;]/g);
    const languages = [...new Set(rawLanguages
        .map((item) => String(item || '').trim().toUpperCase())
        .filter(Boolean)
        .slice(0, 8))];
    const seeders = Number.isFinite(Number(input.seed ?? input.seeders)) ? Math.max(0, Number(input.seed ?? input.seeders)) : 0;
    const leechers = Number.isFinite(Number(input.leech ?? input.leechers)) ? Math.max(0, Number(input.leech ?? input.leechers)) : 0;
    const sizeMb = Number.isFinite(Number(input.sizeMb ?? input.size_mb)) && Number(input.sizeMb ?? input.size_mb) > 0
        ? Number(input.sizeMb ?? input.size_mb)
        : null;
    const sizeBytes = Number.isFinite(Number(input.sizeBytes ?? input.size_bytes)) && Number(input.sizeBytes ?? input.size_bytes) > 0
        ? Number(input.sizeBytes ?? input.size_bytes)
        : (sizeMb ? Math.round(sizeMb * 1024 * 1024) : 0);
    return {
        rawTitle: String(input.rawTitle || input.raw_title || '').trim() || null,
        cleanTitle: String(input.cleanTitle || input.clean_title || '').trim() || null,
        year: Number.isInteger(Number(input.year)) ? Number(input.year) : null,
        resolution: String(input.resolution || '').trim() || null,
        languages,
        codec: String(input.codec || input.videoCodec || input.video_codec || '').trim() || null,
        source: String(input.source || input.qualitySource || input.quality_source || '').trim() || null,
        sizeLabel: String(input.sizeLabel || input.size_label || '').trim() || null,
        sizeMb,
        sizeBytes,
        seeders,
        leechers,
        packKind: String(input.packKind || input.pack_kind || '').trim() || null,
        packLabel: String(input.packLabel || input.pack_label || '').trim() || null,
        packReason: String(input.packReason || input.pack_reason || '').trim() || null,
        score: Number.isFinite(Number(input.score)) ? Number(input.score) : null,
        hash: normalizeHash(input.hash || input.infoHash || input.info_hash) || null
    };
}

function normalizeManualPageInfo(value = {}) {
    const input = value && typeof value === 'object' ? value : {};
    return {
        host: String(input.host || input.hostname || '').trim().slice(0, 160) || null,
        title: String(input.title || '').trim().slice(0, 300) || null,
        canonical: String(input.canonical || '').trim().slice(0, 1024) || null,
        imdbIds: Array.isArray(input.imdbIds) ? input.imdbIds.filter((id) => /^tt\d+$/i.test(String(id || ''))).slice(0, 8) : [],
        magnetCount: Number.isInteger(Number(input.magnetCount)) ? Number(input.magnetCount) : null,
        jsonLdTypes: Array.isArray(input.jsonLdTypes) ? input.jsonLdTypes.map((item) => String(item || '').trim()).filter(Boolean).slice(0, 12) : []
    };
}

function cleanManualProviderLabel(value = '') {
    const raw = String(value || '').trim();
    if (!raw) return '';
    return raw
        .replace(/\[[^\]]*\]/g, ' ')
        .replace(/\([^)]*\)/g, ' ')
        .replace(/\b(?:mirror|mirrors?|proxy|proxied|download|torrent|magnet|search|results?|pagina|page|official|unblock(?:ed)?|clone|main|alt|alternative)\b/ig, ' ')
        .replace(/(?:^|\s)[#:/|\\-]+\s*/g, ' ')
        .replace(/\s{2,}/g, ' ')
        .trim();
}

function normalizeManualProviderHost(value = '') {
    const raw = String(value || '').trim();
    if (!raw) return '';
    try {
        return new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`).hostname.replace(/^www\./i, '').toLowerCase();
    } catch (_) {
        return raw.replace(/^www\./i, '').toLowerCase();
    }
}

function normalizePackFileEntries(values = []) {
    return (Array.isArray(values) ? values : []).map((entry) => ({
        file_index: entry?.file_index ?? entry?.fileIdx,
        imdb_id: entry?.imdb_id || entry?.imdbId,
        imdb_season: entry?.imdb_season ?? entry?.season,
        imdb_episode: entry?.imdb_episode ?? entry?.episode,
        file_path: entry?.file_path || entry?.filePath,
        file_title: entry?.file_title || entry?.fileTitle || entry?.title,
        file_size: entry?.file_size || entry?.size
    })).filter((entry) => Number.isInteger(Number(entry.file_index)) && Number(entry.file_index) >= 0);
}

function getLargestPackFileIndex(files = []) {
    const largest = [...files].sort((left, right) => (Number(right?.file_size || 0) || 0) - (Number(left?.file_size || 0) || 0))[0];
    return Number.isInteger(Number(largest?.file_index)) && Number(largest.file_index) >= 0 ? Number(largest.file_index) : null;
}


function deriveManualProvider(rawProvider, sourceUrl, sourceTitle, sourceHost = '') {
    const raw = cleanManualProviderLabel(rawProvider);
    const generic = !raw || /^(manual|leviathan[_\s-]*companion|companion|unknown|n\/a|null|undefined|source|provider)$/i.test(raw);
    const host = normalizeManualProviderHost(sourceHost || sourceUrl);
    const rawLower = raw.toLowerCase();
    const sourceText = `${sourceUrl || ''} ${sourceTitle || ''}`.toLowerCase();

    const providers = [
        ['BT4G', /(?:^|\.)(?:bt4g|bt4gprx|btdig|btdiggg|b4g|b4gprx|downloadtorrentfile)(?:\.|$)/i, /\b(?:bt4g|bt4gprx|btdig|btdiggg|b4gprx|downloadtorrentfile)\b/i],
        ['1337x', /(?:^|\.)(?:1337x|1377x|x1337x|1337xx)(?:\.|$)/i, /\b(?:1337x|1377x|x1337x|1337xx)\b/i],
        ['TorrentGalaxy', /(?:^|\.)(?:torrentgalaxy|tgx)(?:\.|$)/i, /\b(?:torrentgalaxy|tgx)\b/i],
        ['MagnetDL', /(?:^|\.)magnetdl(?:\.|$)/i, /\bmagnetdl\b/i],
        ['IlCorsaroNero', /(?:^|\.)(?:ilcorsaronero|corsaronero|ilcorsaro|corsaro)(?:\.|$)/i, /\b(?:ilcorsaronero|ilcorsaro|corsaro nero|corsaronero)\b/i],
        ['ThePirateBay', /(?:^|\.)(?:thepiratebay|piratebay|tpb)(?:\.|$)/i, /\b(?:the pirate bay|thepiratebay|piratebay|tpb)\b/i],
        ['LimeTorrents', /(?:^|\.)limetorrents(?:\.|$)/i, /\blimetorrents\b/i],
        ['Nyaa', /(?:^|\.)nyaa(?:\.|$)/i, /\bnyaa\b/i],
        ['EZTV', /(?:^|\.)eztv(?:\.|$)/i, /\beztv\b/i],
        ['YTS', /(?:^|\.)(?:yts|yify)(?:\.|$)/i, /\b(?:yts|yify)\b/i],
        ['Torlock', /(?:^|\.)torlock(?:\.|$)/i, /\btorlock\b/i],
        ['TorrentDownloads', /(?:^|\.)(?:torrentdownloads|torrentdownload)(?:\.|$)/i, /\btorrentdownloads?\b/i],
        ['RARBG', /(?:^|\.)rarbg(?:\.|$)/i, /\brarbg\b/i]
    ];

    // The real page host is authoritative. This prevents BT4G pages from being
    // re-labelled as 1337x just because a page title, related result or ad text
    // contains another provider name.
    for (const [label, hostPattern] of providers) {
        if (hostPattern.test(host)) return label;
    }

    // If the extension explicitly sent a known provider, preserve it before
    // scanning noisy page text.
    for (const [label, _hostPattern, textPattern] of providers) {
        if (textPattern.test(rawLower)) return label;
    }

    for (const [label, _hostPattern, textPattern] of providers) {
        if (textPattern.test(sourceText)) return label;
    }

    if (!generic) return raw.slice(0, 64);
    if (host) return cleanManualProviderLabel(host.split('.')[0]).replace(/[^a-z0-9_-]+/gi, '').slice(0, 32) || 'MANUAL';
    return 'MANUAL';
}

function normalizeManualImportPayload(body = {}) {
    let torrentMeta = null;
    const magnet = parseMagnetInput(body.magnet || body.magnetUri || body.magnetURI || body.magnet_url || body.magnetUrl || '');
    const torrentSource = body.torrent || body.torrentB64 || body.torrentBase64 || body.torrentFile || body.torrent_file || null;
    if (torrentSource) torrentMeta = parseTorrentInput(torrentSource);

    const releaseInfo = normalizeReleaseInfo(body.releaseInfo || body.release_info || {});
    const pageInfo = normalizeManualPageInfo(body.pageInfo || body.page_info || {});
    const rawTitle = String(body.title || '').trim() || releaseInfo.rawTitle || releaseInfo.cleanTitle || magnet?.title || torrentMeta?.title || '';
    const sourceUrl = String(body.sourceUrl || body.source_url || pageInfo.canonical || '').trim() || null;
    const sourceTitle = String(body.sourceTitle || body.source_title || body.pageTitle || body.page_title || pageInfo.title || '').trim() || null;
    const sourceHost = String(body.sourceHost || body.source_host || pageInfo.host || '').trim() || null;
    const parsedFromTitle = rawTitle ? parseSeasonEpisode(rawTitle, 1, { anime: body.isAnime === true || body.anime === true }) : null;
    const imdbId = String(body.imdbId || body.imdb_id || '').trim().toLowerCase();
    const season = Number.isInteger(Number(body.season)) && Number(body.season) > 0 ? Number(body.season) : (parsedFromTitle?.season || null);
    const episode = Number.isInteger(Number(body.episode)) && Number(body.episode) > 0 ? Number(body.episode) : (parsedFromTitle?.episode || null);
    const requestedFileIndex = Number.isInteger(Number(body.fileIdx ?? body.file_index)) && Number(body.fileIdx ?? body.file_index) >= 0
        ? Number(body.fileIdx ?? body.file_index)
        : null;
    const inferredType = String(body.type || (season || episode ? 'series' : 'movie')).trim().toLowerCase();
    const hash = normalizeHash(body.hash || body.infoHash || body.info_hash) || releaseInfo.hash || magnet?.infoHash || torrentMeta?.infoHash || null;
    const tmdbId = normalizeTmdbId(body.tmdbId || body.tmdb_id);
    const normalizedPackFiles = normalizePackFileEntries(body.packFiles || body.pack_files || []);
    const inferredPackFiles = normalizedPackFiles.length > 0
        ? normalizedPackFiles
        : inferPackMappings(torrentMeta?.files || [], {
            imdbId,
            type: inferredType,
            season,
            episode,
            isAnime: body.isAnime === true || body.anime === true
        });

    let autoFileIndex = requestedFileIndex;
    if (autoFileIndex === null && season && episode) {
        const mappedFile = inferredPackFiles.find((entry) => Number(entry?.imdb_season) === season && Number(entry?.imdb_episode) === episode);
        if (mappedFile && Number.isInteger(Number(mappedFile.file_index))) autoFileIndex = Number(mappedFile.file_index);
    }
    if (autoFileIndex === null && torrentMeta?.files?.length === 1) autoFileIndex = 0;
    if (autoFileIndex === null) autoFileIndex = getLargestPackFileIndex(inferredPackFiles.length > 0 ? inferredPackFiles : (torrentMeta?.files || []));

    const size = Number.isFinite(Number(body.size)) && Number(body.size) > 0
        ? Number(body.size)
        : (Number(releaseInfo.sizeBytes || 0) || Number(torrentMeta?.totalSize || 0) || 0);
    const cacheMode = normalizeCacheMode(body);
    const scanRd = cacheMode !== 'none' && (cacheMode === 'rd' || cacheMode === 'both') && readBoolean(body.scanRd ?? body.scan_rd, true);
    const scanTb = cacheMode !== 'none' && (cacheMode === 'tb' || cacheMode === 'both') && readBoolean(body.scanTb ?? body.scan_tb, true);
    const serviceRaw = String(body.service || '').trim().toLowerCase();
    const service = ['rd', 'tb', 'both'].includes(serviceRaw) ? serviceRaw : (cacheMode === 'both' ? 'both' : (cacheMode === 'tb' ? 'tb' : (cacheMode === 'rd' ? 'rd' : null)));
    const rdApiKey = String(body.rdApiKey || body.rd_api_key || body.apiKey || body.api_key || '').trim() || null;
    const torboxApiKey = String(body.torboxApiKey || body.torbox_api_key || body.tbApiKey || body.tb_api_key || '').trim() || null;

    return {
        hash,
        magnet: magnet?.magnet || String(body.magnet || body.magnetUri || body.magnetURI || '').trim() || null,
        title: rawTitle || hash,
        sourceTitle,
        sourceUrl,
        sourceHost,
        scanRd,
        scanTb,
        cacheMode,
        provider: deriveManualProvider(body.provider || body.sourceProvider || body.source, sourceUrl, sourceTitle, sourceHost),
        imdbId: /^tt\d+$/.test(imdbId) ? imdbId : null,
        tmdbId,
        type: inferredType,
        season,
        episode,
        year: Number.isInteger(Number(body.year || releaseInfo.year)) ? Number(body.year || releaseInfo.year) : extractYearFromTitle(rawTitle || sourceTitle || ''),
        fileIndex: autoFileIndex,
        size,
        service,
        apiKey: rdApiKey,
        rdApiKey,
        torboxApiKey,
        releaseInfo,
        pageInfo,
        explainClient: String(body.explainClient || body.explain_client || '').trim() || null,
        packFiles: inferredPackFiles,
        torrentMeta,
        importSource: torrentMeta ? 'torrent' : (magnet ? 'magnet' : 'hash')
    };
}



function normalizeManualMediaType(value) {
    const type = String(value || '').trim().toLowerCase();
    if (type === 'series' || type === 'serie' || type === 'tv' || type === 'show') return 'tv';
    if (type === 'movie' || type === 'film') return 'movie';
    return null;
}

function decodeLooseTitle(value) {
    let out = String(value || '').trim();
    for (let i = 0; i < 2; i += 1) {
        try {
            const decoded = decodeURIComponent(out);
            if (decoded === out) break;
            out = decoded;
        } catch (_) {
            break;
        }
    }
    return out;
}

function extractYearFromTitle(value) {
    const match = String(value || '').match(/(?:^|[^0-9])((?:19|20)\d{2})(?:[^0-9]|$)/);
    return match ? Number(match[1]) : null;
}

function cleanManualLookupTitle(value) {
    let title = decodeLooseTitle(value)
        .replace(/\.[a-z0-9]{2,5}$/i, ' ')
        .replace(/[._+]+/g, ' ')
        .replace(/\[[^\]]*\]|\([^)]*\)/g, ' ')
        .replace(/\bS\d{1,2}E\d{1,3}\b/ig, ' ')
        .replace(/\b\d{1,2}x\d{1,3}\b/ig, ' ')
        .replace(/\b(?:2160p|1080p|720p|480p|4k|uhd|hdr10?|dv|dolby\s*vision|web[- ]?dl|webrip|bluray|blu[- ]?ray|bdrip|hdtv|dvdrip|remux|x264|x265|h264|h265|hevc|avc|aac|ac3|dts|ddp?5?\.?1|ita|eng|multi|sub(?:bed)?|proper|repack|extended|unrated|internal)\b/ig, ' ')
        .replace(/\b(?:19|20)\d{2}\b/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();

    title = title.replace(/[-–—|].*$/, '').trim();
    return title.length >= 2 ? title : null;
}

function scoreTmdbManualMatch(result, query, expectedType, year) {
    const mediaType = result?.media_type || expectedType;
    if (expectedType && mediaType && mediaType !== expectedType) return -100;

    const title = String(result?.title || result?.name || result?.original_title || result?.original_name || '').trim();
    if (!title) return -100;

    const normalizedQuery = query.toLowerCase();
    const normalizedTitle = title.toLowerCase();
    let score = 0;
    if (normalizedTitle === normalizedQuery) score += 70;
    else if (normalizedTitle.startsWith(normalizedQuery) || normalizedQuery.startsWith(normalizedTitle)) score += 45;
    else if (normalizedTitle.includes(normalizedQuery) || normalizedQuery.includes(normalizedTitle)) score += 25;

    const date = String(result?.release_date || result?.first_air_date || '');
    const resultYear = extractYearFromTitle(date);
    if (year && resultYear) score += Math.abs(resultYear - year) <= 1 ? 25 : -20;
    if (Number(result?.popularity || 0) > 5) score += 4;
    if (Number(result?.vote_count || 0) > 10) score += 2;
    return score;
}

async function resolveManualImportIdentity(payload, logger = console) {
    if (payload.imdbId) return { matched: false, reason: 'explicit_imdb' };

    const expectedType = normalizeManualMediaType(payload.type) || (payload.season || payload.episode ? 'tv' : 'movie');

    if (payload.tmdbId) {
        const searchTypes = [expectedType];
        for (const searchType of [...new Set(searchTypes)]) {
            try {
                const imdbId = await tmdbHelper.getImdbFromTmdb(payload.tmdbId, searchType);
                if (!/^tt\d+$/i.test(String(imdbId || ''))) continue;

                payload.imdbId = String(imdbId).toLowerCase();
                payload.type = searchType === 'tv' ? 'series' : 'movie';
                return {
                    matched: true,
                    source: 'explicit_tmdb',
                    tmdbId: String(payload.tmdbId),
                    imdbId: payload.imdbId,
                    type: payload.type
                };
            } catch (error) {
                logger.warn?.(`[ADMIN] Manual import TMDB->IMDb failed | tmdb=${payload.tmdbId} | type=${searchType} | error=${error.message}`);
            }
        }
    }

    const candidates = [payload.title, payload.sourceTitle]
        .map(cleanManualLookupTitle)
        .filter(Boolean);
    const uniqueQueries = [...new Set(candidates)];
    if (uniqueQueries.length === 0) return { matched: false, reason: 'no_title' };

    for (const query of uniqueQueries) {
        const year = extractYearFromTitle(payload.title || payload.sourceTitle || '');
        const searchTypes = expectedType === 'tv' ? ['tv', 'movie'] : ['movie', 'tv'];
        for (const searchType of searchTypes) {
            try {
                const data = await tmdbHelper.fetchTmdbJson(`/search/${searchType}`, {
                    params: {
                        query,
                        language: 'it-IT',
                        include_adult: false,
                        ...(year && searchType === 'movie' ? { year } : {}),
                        ...(year && searchType === 'tv' ? { first_air_date_year: year } : {})
                    },
                    cacheTtlMs: 15 * 60 * 1000,
                    timeoutMs: 4500
                });
                const results = Array.isArray(data?.results) ? data.results : [];
                const best = results
                    .map((result) => ({ result, score: scoreTmdbManualMatch({ ...result, media_type: searchType }, query, expectedType, year) }))
                    .sort((left, right) => right.score - left.score)[0];

                if (!best || best.score < 35 || !best.result?.id) continue;
                const imdbId = await tmdbHelper.getImdbFromTmdb(best.result.id, searchType).catch(() => null);
                if (!/^tt\d+$/i.test(String(imdbId || ''))) continue;

                payload.imdbId = String(imdbId).toLowerCase();
                payload.type = searchType === 'tv' ? 'series' : 'movie';
                return {
                    matched: true,
                    source: 'tmdb_search',
                    query,
                    score: best.score,
                    tmdbId: String(best.result.id),
                    imdbId: payload.imdbId,
                    type: payload.type,
                    title: best.result.title || best.result.name || null,
                    year: extractYearFromTitle(best.result.release_date || best.result.first_air_date || '')
                };
            } catch (error) {
                logger.warn?.(`[ADMIN] Manual import TMDB match failed | query=${query} | type=${searchType} | error=${error.message}`);
            }
        }
    }

    return { matched: false, reason: 'no_confident_match', queries: uniqueQueries };
}


async function buildManualImportIdentityCandidates(body = {}, logger = console) {
    const rawTitle = String(body.title || body.query || body.sourceTitle || '').trim();
    const expectedType = normalizeManualMediaType(body.type) || null;
    const year = extractYearFromTitle(rawTitle || body.sourceTitle || '');
    const cleanedTitle = cleanManualLookupTitle(rawTitle) || rawTitle;
    const queries = [...new Set([cleanedTitle, cleanManualLookupTitle(body.sourceTitle || '')].filter(Boolean))];
    if (queries.length === 0) return { candidates: [], reason: 'no_title' };

    const searchTypes = expectedType ? [expectedType] : ['movie', 'tv'];
    const candidateMap = new Map();

    for (const query of queries) {
        for (const searchType of searchTypes) {
            try {
                const data = await tmdbHelper.fetchTmdbJson(`/search/${searchType}`, {
                    params: {
                        query,
                        language: 'it-IT',
                        include_adult: false,
                        ...(year && searchType === 'movie' ? { year } : {}),
                        ...(year && searchType === 'tv' ? { first_air_date_year: year } : {})
                    },
                    cacheTtlMs: 15 * 60 * 1000,
                    timeoutMs: 4500
                });
                const results = Array.isArray(data?.results) ? data.results.slice(0, 8) : [];
                for (const result of results) {
                    const score = scoreTmdbManualMatch({ ...result, media_type: searchType }, query, expectedType, year);
                    if (score < 5 || !result?.id) continue;
                    const key = `${searchType}:${result.id}`;
                    const existing = candidateMap.get(key);
                    if (existing && existing.score >= score) continue;
                    candidateMap.set(key, {
                        tmdbId: String(result.id),
                        imdbId: null,
                        type: searchType === 'tv' ? 'series' : 'movie',
                        tmdbType: searchType,
                        title: result.title || result.name || result.original_title || result.original_name || null,
                        originalTitle: result.original_title || result.original_name || null,
                        year: extractYearFromTitle(result.release_date || result.first_air_date || ''),
                        date: result.release_date || result.first_air_date || null,
                        posterPath: result.poster_path || null,
                        overview: result.overview || null,
                        popularity: Number(result.popularity || 0) || 0,
                        voteCount: Number(result.vote_count || 0) || 0,
                        score,
                        query
                    });
                }
            } catch (error) {
                logger.warn?.(`[ADMIN] Manual import identity candidates failed | query=${query} | type=${searchType} | error=${error.message}`);
            }
        }
    }

    const candidates = [...candidateMap.values()]
        .sort((left, right) => right.score - left.score || right.popularity - left.popularity)
        .slice(0, 8);

    await Promise.all(candidates.map(async (candidate) => {
        try {
            const tmdbType = candidate.tmdbType || (candidate.type === 'series' ? 'tv' : 'movie');
            const imdbId = await tmdbHelper.getImdbFromTmdb(candidate.tmdbId, tmdbType);
            if (/^tt\d+$/i.test(String(imdbId || ''))) candidate.imdbId = String(imdbId).toLowerCase();
        } catch (_) {}
    }));

    return {
        candidates: candidates.filter((candidate) => candidate.imdbId || candidate.tmdbId),
        query: queries[0],
        cleanedTitle,
        expectedType: expectedType || 'auto',
        year: year || null
    };
}

function getManualImportRdToken(payload = {}) {
    return String(payload.rdApiKey || payload.apiKey || process.env.RD_SCAN_TOKEN || process.env.RD_API_KEY || process.env.REALDEBRID_API_KEY || '').trim();
}

function getManualImportTbToken(payload = {}) {
    return String(payload.torboxApiKey || process.env.TORBOX_API_KEY || process.env.TB_API_KEY || '').trim();
}

function getManualImportTbAvailability(payload = {}) {
    const payloadToken = String(payload.torboxApiKey || '').trim();
    const envToken = String(process.env.TORBOX_API_KEY || process.env.TB_API_KEY || '').trim();
    const token = payloadToken || envToken;
    return {
        configured: Boolean(token),
        token,
        source: payloadToken ? 'payload' : (envToken ? 'env' : null)
    };
}

function buildSkippedTorboxScan(reason = 'missing_torbox_token', extra = {}) {
    return {
        skipped: true,
        reason,
        cached: null,
        state: 'skipped',
        importContinued: true,
        nonBlocking: true,
        message: reason === 'missing_torbox_token'
            ? 'TorBox API key assente: import salvato comunque, scan TorBox saltato.'
            : 'Scan TorBox saltato: import salvato comunque.',
        ...extra
    };
}

function buildManualRdState(result = {}) {
    const status = String(result.rd_status || '').trim().toLowerCase();
    if (result.deferred) return { state: 'probing', cached: null, nextHours: 4, failures: 0 };
    if (result.cached === true) return { state: 'cached', cached: true, nextHours: 24 * 30, failures: 0 };
    if (['error', 'magnet_error', 'virus', 'dead'].includes(status)) return { state: 'uncached_terminal', cached: false, nextHours: 24 * 7, failures: 1 };
    if (result.pack_without_episode_hint) return { state: 'likely_cached', cached: null, nextHours: 168, failures: 0 };
    return { state: 'likely_uncached', cached: null, nextHours: 12, failures: 1 };
}

function buildManualImportDbLookupKey(payload = {}) {
    const imdbId = String(payload.imdbId || payload.imdb_id || '').trim().toLowerCase();
    if (!/^tt\d+$/.test(imdbId)) return null;
    const season = Number(payload.season || 0) || 0;
    const episode = Number(payload.episode || 0) || 0;
    return `${imdbId}:${season}:${episode}`;
}

function getPositiveInteger(value) {
    const parsed = Number(value);
    return Number.isInteger(parsed) && parsed >= 0 ? parsed : null;
}

function pickLargestManualRdFile(files = []) {
    return (Array.isArray(files) ? files : [])
        .filter((file) => getPositiveInteger(file?.id ?? file?.file_index ?? file?.fileIdx) !== null)
        .sort((left, right) => (Number(right?.bytes || right?.file_size || 0) || 0) - (Number(left?.bytes || left?.file_size || 0) || 0))[0] || null;
}

function pickManualCachedFileIndex(payload = {}, result = {}) {
    const explicitIndex = getPositiveInteger(result.file_index ?? result.fileIndex ?? result.fileIdx);
    if (explicitIndex !== null) return explicitIndex;

    const episodeHintIndex = getPositiveInteger(result.episodeFileHint?.fileIndex ?? result.episodeFileHint?.fileIdx);
    if (episodeHintIndex !== null) return episodeHintIndex;

    const requestedIndex = getPositiveInteger(payload.fileIndex ?? payload.file_index ?? payload.fileIdx);
    if (requestedIndex !== null) return requestedIndex;

    const isMovie = String(payload.type || '').toLowerCase() === 'movie';
    if (isMovie) {
        const largest = pickLargestManualRdFile(result.files);
        const largestIndex = getPositiveInteger(largest?.id ?? largest?.file_index ?? largest?.fileIdx);
        if (largestIndex !== null) return largestIndex;
    }

    return null;
}

function buildManualCachedTorrentRow(payload = {}, result = {}) {
    const fileIndex = pickManualCachedFileIndex(payload, result);
    const fileSize = Number(result.file_size || result.episodeFileHint?.fileSize || 0) || null;
    const totalSize = Number(result.size || payload.size || 0) || 0;
    return {
        info_hash: payload.hash,
        title: result.torrent_title || result.file_title || payload.title,
        provider: payload.provider || 'MANUAL',
        size: fileSize || totalSize,
        file_index: fileIndex,
        magnet: payload.magnet || undefined,
        is_pack: result.is_pack === true || payload.packFiles?.length > 1
    };
}

async function ensureManualCachedTorrentVisible(payload, result, { dbHelper, logger }) {
    if (!result?.cached || !payload?.hash || !payload?.imdbId || !dbHelper) {
        return { skipped: true, reason: 'not_cached_or_missing_identity' };
    }

    const torrentRow = buildManualCachedTorrentRow(payload, result);
    const resolvedFileIndex = getPositiveInteger(torrentRow.file_index);
    if (resolvedFileIndex !== null) payload.fileIndex = resolvedFileIndex;

    const outcome = {
        ensured: false,
        mapped: false,
        movieGenericMapped: false,
        episodeMapped: false,
        fallbackEnsured: false,
        fallbackMapped: false,
        visible: false,
        visibleCount: 0,
        fileIndex: resolvedFileIndex,
        size: torrentRow.size || null
    };

    const mediaMeta = {
        imdb_id: payload.imdbId,
        type: payload.type,
        season: payload.season,
        episode: payload.episode
    };

    if (typeof dbHelper.ensureTorrentRecord === 'function') {
        outcome.ensured = await dbHelper.ensureTorrentRecord(torrentRow);
    }

    if (typeof dbHelper.insertTorrent === 'function') {
        outcome.mapped = await dbHelper.insertTorrent(mediaMeta, torrentRow);
    }

    if (String(payload.type || '').toLowerCase() === 'movie' && typeof dbHelper.insertEpisodeFiles === 'function') {
        const fallbackTorrentRow = { ...torrentRow, file_index: null, fileIndex: null, fileIdx: null };
        if (typeof dbHelper.ensureTorrentRecord === 'function') {
            outcome.fallbackEnsured = await dbHelper.ensureTorrentRecord(fallbackTorrentRow);
        }
        if (typeof dbHelper.insertTorrent === 'function') {
            outcome.fallbackMapped = await dbHelper.insertTorrent(mediaMeta, fallbackTorrentRow);
        }

        const movieMappings = [{
            info_hash: payload.hash,
            file_index: null,
            imdb_id: payload.imdbId,
            imdb_season: null,
            imdb_episode: null,
            title: result.file_title || result.torrent_title || payload.title,
            size: Number(result.file_size || torrentRow.size || payload.size || 0) || null
        }];
        if (resolvedFileIndex !== null) {
            movieMappings.push({
                ...movieMappings[0],
                file_index: resolvedFileIndex
            });
        }
        const movieInsert = await dbHelper.insertEpisodeFiles(movieMappings);
        outcome.movieGenericMapped = Number(movieInsert?.processed || 0) > 0;
    }

    if (payload.type !== 'movie' && payload.season && payload.episode && resolvedFileIndex !== null && typeof dbHelper.insertEpisodeFiles === 'function') {
        const episodeInsert = await dbHelper.insertEpisodeFiles([{
            info_hash: payload.hash,
            file_index: resolvedFileIndex,
            imdb_id: payload.imdbId,
            imdb_season: payload.season,
            imdb_episode: payload.episode,
            title: result.file_title || payload.title,
            size: Number(result.file_size || torrentRow.size || payload.size || 0) || null
        }]);
        outcome.episodeMapped = Number(episodeInsert?.processed || 0) > 0;
    }

    if (typeof dbHelper.getTorrents === 'function') {
        const rows = await dbHelper.getTorrents(payload.imdbId, payload.season, payload.episode);
        outcome.visibleCount = Array.isArray(rows) ? rows.length : 0;
        outcome.visible = Array.isArray(rows) && rows.some((row) => normalizeHash(row?.info_hash || row?.infoHash || row?.hash) === payload.hash);
    }

    if (!outcome.visible && String(payload.type || '').toLowerCase() === 'movie') {
        if (typeof dbHelper.getTorrents === 'function') {
            const rows = await dbHelper.getTorrents(payload.imdbId, payload.season, payload.episode);
            outcome.visibleCount = Array.isArray(rows) ? rows.length : outcome.visibleCount;
            outcome.visible = Array.isArray(rows) && rows.some((row) => normalizeHash(row?.info_hash || row?.infoHash || row?.hash) === payload.hash);
        }
    }

    logger.info('[ADMIN] Manual import cached torrent forced into visible DB path', {
        hash: payload.hash,
        imdbId: payload.imdbId,
        season: payload.season,
        episode: payload.episode,
        fileIndex: resolvedFileIndex,
        ensured: outcome.ensured,
        mapped: outcome.mapped,
        movieGenericMapped: outcome.movieGenericMapped,
        episodeMapped: outcome.episodeMapped,
        fallbackEnsured: outcome.fallbackEnsured,
        fallbackMapped: outcome.fallbackMapped,
        visible: outcome.visible,
        visibleCount: outcome.visibleCount
    });

    return outcome;
}

async function invalidateManualImportCaches(Cache, payload, reason) {
    if (!Cache) return null;
    const outcomes = {};
    if (typeof Cache.invalidateStreamsByHashes === 'function') outcomes.hash = await Cache.invalidateStreamsByHashes([payload.hash], reason);
    if (payload.imdbId && payload.season && payload.episode && typeof Cache.invalidateStreamsByEpisode === 'function') {
        outcomes.episode = await Cache.invalidateStreamsByEpisode({ imdbId: payload.imdbId, season: payload.season, episode: payload.episode }, reason);
    } else if (payload.imdbId && typeof Cache.invalidateStreamsByImdb === 'function') {
        outcomes.imdb = await Cache.invalidateStreamsByImdb(payload.imdbId, reason);
    }
    const dbLookupKey = buildManualImportDbLookupKey(payload);
    if (dbLookupKey && typeof Cache.invalidateDbTorrents === 'function') {
        outcomes.dbLookup = await Cache.invalidateDbTorrents(dbLookupKey, reason);
    }
    return outcomes;
}

function buildManualTorrentRow(payload = {}, overrides = {}) {
    const release = payload.releaseInfo || {};
    const languages = Array.isArray(release.languages) ? release.languages.join(',') : String(release.languages || '');
    const quality = [release.resolution, release.source].filter(Boolean).join(' ') || release.resolution || null;
    return {
        info_hash: payload.hash,
        title: overrides.title || payload.title,
        provider: payload.provider,
        size: Number(overrides.size ?? payload.size ?? release.sizeBytes ?? 0) || 0,
        file_index: overrides.fileIndex ?? payload.fileIndex,
        magnet: payload.magnet || undefined,
        is_pack: overrides.isPack ?? (payload.packFiles?.length > 1 || /pack|season|complete/i.test(String(release.packKind || release.packLabel || ''))),
        type: payload.type,
        resolution: release.resolution || undefined,
        quality: quality || undefined,
        languages: languages || undefined,
        codec: release.codec || undefined,
        seeders: Number.isFinite(Number(release.seeders)) ? Number(release.seeders) : 0,
        leechers: Number.isFinite(Number(release.leechers)) ? Number(release.leechers) : 0,
        source: release.source || undefined,
        folder_size: Number(release.sizeBytes || payload.size || 0) || 0
    };
}

function serializeManualPayload(payload = {}) {
    return {
        hash: payload.hash,
        title: payload.title,
        provider: payload.provider,
        imdbId: payload.imdbId,
        tmdbId: payload.tmdbId,
        type: payload.type,
        season: payload.season,
        episode: payload.episode,
        year: payload.year || null,
        fileIndex: payload.fileIndex,
        size: payload.size,
        cacheMode: payload.cacheMode,
        scanRd: payload.scanRd,
        scanTb: payload.scanTb,
        service: payload.service,
        importSource: payload.importSource,
        releaseInfo: payload.releaseInfo || null,
        pageInfo: payload.pageInfo || null,
        packFilesCount: Array.isArray(payload.packFiles) ? payload.packFiles.length : 0,
        torrentMeta: payload.torrentMeta ? {
            title: payload.torrentMeta.title,
            totalSize: payload.torrentMeta.totalSize,
            files: payload.torrentMeta.files
        } : null
    };
}

function buildManualImportExplain(payload = {}, identityMatch = null, options = {}) {
    const release = payload.releaseInfo || {};
    const lines = [];
    lines.push('🧠 LEVIATHAN EXPLAIN IMPORT / MATCH');
    lines.push(`Hash: ${payload.hash || 'n/a'}`);
    lines.push(`Provider: ${payload.provider || 'MANUAL'}`);
    lines.push(`Titolo: ${payload.title || 'n/a'}`);
    if (payload.year) lines.push(`Anno: ${payload.year}`);
    lines.push(`Tipo: ${payload.type || 'auto'}${payload.season && payload.episode ? ` S${payload.season}E${payload.episode}` : ''}`);
    if (release.resolution || release.codec || release.languages?.length) {
        lines.push(`Release: ${[release.resolution, release.codec, Array.isArray(release.languages) ? release.languages.join('/') : release.languages].filter(Boolean).join(' · ')}`);
    }
    if (release.sizeLabel || payload.size) lines.push(`Dimensione: ${release.sizeLabel || `${Math.round((payload.size || 0) / 1024 / 1024)} MB`}`);
    if (release.seeders || release.leechers) lines.push(`Seed/Leech: ${release.seeders || 0}/${release.leechers || 0}`);
    if (release.packLabel || release.packKind) lines.push(`Pack: ${release.packLabel || release.packKind}`);

    if (payload.imdbId) {
        lines.push(`IMDb: ${payload.imdbId}${identityMatch?.matched ? ` (${identityMatch.source})` : ' (esplicito/risolto)'}`);
    } else if (identityMatch?.matched) {
        lines.push(`IMDb risolto: ${identityMatch.imdbId || 'n/a'} via ${identityMatch.source || 'auto'} score=${identityMatch.score ?? 'n/a'}`);
    } else {
        lines.push(`IMDb: non confermato (${identityMatch?.reason || 'no_match'})`);
    }

    const actions = [];
    actions.push('ensure torrent record');
    if (payload.imdbId) actions.push('map IMDb/torrent');
    if (payload.type !== 'movie' && payload.season && payload.episode) actions.push('map episode file');
    if (payload.packFiles?.length) actions.push(`insert pack files: ${payload.packFiles.length}`);
    if (payload.scanRd) actions.push('RD live scan');
    if (payload.scanTb) actions.push('TorBox cache check');
    if (payload.service && payload.service !== 'none') actions.push(`cloud build queue: ${payload.service}`);
    lines.push(`Azioni ${options.dryRun ? 'simulate' : 'eseguite'}: ${actions.join(' → ')}`);
    if (payload.explainClient) lines.push(`\nClient explain:\n${payload.explainClient}`);
    return lines.join('\n');
}

async function buildAdminHealthPayload({ Cache, dbHelper }) {
    const runtime = runtimeState.getSnapshot();
    let database = 'unknown';
    try {
        if (dbHelper && typeof dbHelper.healthCheck === 'function') {
            await dbHelper.healthCheck();
            database = 'ok';
        } else {
            database = 'unavailable';
        }
    } catch (error) {
        database = `down:${error.message}`;
    }

    let cache = 'unknown';
    try {
        cache = Cache && typeof Cache.getStreamCacheIndexStats === 'function' ? 'ok' : (Cache ? 'basic' : 'unavailable');
    } catch (error) {
        cache = `degraded:${error.message}`;
    }

    return {
        success: true,
        status: database === 'ok' ? 'ok' : 'degraded',
        mode: 'Leviathan Admin Companion Bridge',
        version: packageMeta.version || 'unknown',
        timestamp: new Date().toISOString(),
        db: database,
        database,
        cache,
        runtime: {
            pid: runtime.pid,
            role: runtime.role,
            uptimeSeconds: runtime.uptimeSeconds,
            lifecycle: runtime.lifecycle,
            cluster: runtime.cluster
        },
        manualImport: {
            enabled: true,
            identityCandidates: true,
            dryRun: true,
            cacheCheck: true,
            bulk: true,
            providers: ['BT4G', '1337x', 'TorrentGalaxy', 'MagnetDL', 'IlCorsaroNero', 'ThePirateBay', 'Nyaa', 'EZTV', 'YTS'],
            debridModes: ['none', 'rd', 'tb', 'both']
        },
        debrid: {
            rdConfigured: Boolean(process.env.RD_SCAN_TOKEN || process.env.RD_API_KEY || process.env.REALDEBRID_API_KEY),
            torboxConfigured: Boolean(process.env.TORBOX_API_KEY || process.env.TB_API_KEY)
        }
    };
}

async function inspectManualImportWithRd(payload, { logger }) {
    if (payload.scanRd === false) return { skipped: true, reason: 'disabled' };
    const token = getManualImportRdToken(payload);
    if (!token) return { skipped: true, reason: 'missing_rd_token' };
    if (!payload.hash) return { skipped: true, reason: 'missing_hash' };
    const magnet = payload.magnet || `magnet:?xt=urn:btih:${payload.hash}`;
    const context = {
        hash: payload.hash,
        magnet,
        title: payload.title,
        source: payload.provider || 'MANUAL',
        fileIdx: payload.fileIndex,
        imdb_id: payload.imdbId || null,
        season: payload.season || null,
        episode: payload.episode || null,
        _probeSeason: payload.season || null,
        _probeEpisode: payload.episode || null
    };
    try {
        const result = await RealDebridProbe.inspectSingleHash(payload.hash, magnet, token, context);
        const rdState = buildManualRdState(result);
        return {
            skipped: false,
            cached: result.cached === true,
            state: rdState.state,
            rdStatus: result.rd_status || null,
            fileIndex: Number.isInteger(Number(result.file_index)) ? Number(result.file_index) : null,
            fileTitle: result.file_title || null,
            fileSize: result.file_size || null,
            pack: result.is_pack === true,
            packWithoutEpisodeHint: result.pack_without_episode_hint === true
        };
    } catch (error) {
        logger.warn?.(`[ADMIN] Manual import RD cache check failed | hash=${payload.hash} | error=${error.message}`);
        return { skipped: false, cached: null, state: 'error', error: error.message };
    }
}

async function scanManualImportWithRd(payload, { Cache, dbHelper, logger }) {
    if (payload.scanRd === false) return { skipped: true, reason: 'disabled' };
    const token = getManualImportRdToken(payload);
    if (!token) return { skipped: true, reason: 'missing_rd_token' };
    if (!payload.hash) return { skipped: true, reason: 'missing_hash' };

    const magnet = payload.magnet || `magnet:?xt=urn:btih:${payload.hash}`;
    const context = {
        hash: payload.hash,
        magnet,
        title: payload.title,
        source: payload.provider || 'MANUAL',
        fileIdx: payload.fileIndex,
        imdb_id: payload.imdbId || null,
        season: payload.season || null,
        episode: payload.episode || null,
        _probeSeason: payload.season || null,
        _probeEpisode: payload.episode || null
    };

    const result = await RealDebridProbe.inspectSingleHash(payload.hash, magnet, token, context);
    const rdState = buildManualRdState(result);
    const visibleDb = await ensureManualCachedTorrentVisible(payload, result, { dbHelper, logger });

    if (dbHelper && typeof dbHelper.updateRdCacheStatus === 'function') {
        await dbHelper.updateRdCacheStatus([{
            hash: payload.hash,
            state: rdState.state,
            cached: rdState.cached,
            torrent_title: result.torrent_title || payload.title || null,
            size: Number(result.size || payload.size || 0) || null,
            file_title: result.file_title || null,
            file_size: Number(result.file_size || 0) || null,
            rd_file_index: Number.isInteger(Number(result.file_index)) && Number(result.file_index) >= 0 ? Number(result.file_index) : (payload.fileIndex ?? null),
            next_hours: rdState.nextHours,
            failures: rdState.failures,
            imdb_id: payload.imdbId || null,
            imdb_season: payload.season || null,
            imdb_episode: payload.episode || null,
            permanent: result.cached === true
        }]);
    }

    if (result.cached && result.is_pack && Array.isArray(result.files) && result.files.length > 0 && dbHelper && typeof dbHelper.insertPackFiles === 'function') {
        const episodeHint = result.episodeFileHint || null;
        const filesToPersist = episodeHint ? [{
            id: episodeHint.fileIndex,
            path: episodeHint.filePath || episodeHint.fileName,
            bytes: episodeHint.fileSize,
            file_title: episodeHint.fileName
        }] : result.files;
        await dbHelper.insertPackFiles(filesToPersist
            .filter((file) => Number.isInteger(Number(file?.id)))
            .map((file) => ({
                pack_hash: payload.hash,
                imdb_id: payload.imdbId || null,
                imdb_season: episodeHint && payload.season ? payload.season : null,
                imdb_episode: episodeHint && payload.episode ? payload.episode : null,
                file_index: Number(file.id),
                file_path: file.path || file.file_title || null,
                file_title: file.file_title || String(file.path || '').split('/').pop() || null,
                file_size: Number(file.bytes || 0) || null
            })));
    }

    const cacheInvalidated = await invalidateManualImportCaches(Cache, payload, result.cached ? 'manual_import_rd_cached' : 'manual_import_rd_scanned');
    logger.info('[ADMIN] Manual import RD scan completed', {
        hash: payload.hash,
        imdbId: payload.imdbId,
        season: payload.season,
        episode: payload.episode,
        cached: result.cached === true,
        state: rdState.state,
        rdStatus: result.rd_status || null,
        visibleDb,
        cacheInvalidated
    });

    return {
        skipped: false,
        cached: result.cached === true,
        state: rdState.state,
        rdStatus: result.rd_status || null,
        fileIndex: Number.isInteger(Number(result.file_index)) ? Number(result.file_index) : null,
        fileTitle: result.file_title || null,
        fileSize: result.file_size || null,
        visibleDb,
        cacheInvalidated,
        pack: result.is_pack === true,
        packWithoutEpisodeHint: result.pack_without_episode_hint === true
    };
}


async function scanManualImportWithTorbox(payload, { Cache, dbHelper, logger }) {
    if (payload.scanTb === false) return buildSkippedTorboxScan('disabled');
    const tbAvailability = getManualImportTbAvailability(payload);
    const token = tbAvailability.token;
    if (!token) {
        logger.info?.('[ADMIN] Manual import TorBox cache check skipped: missing API key, import continues', {
            hash: payload.hash,
            imdbId: payload.imdbId,
            cacheMode: payload.cacheMode,
            service: payload.service
        });
        return buildSkippedTorboxScan('missing_torbox_token', { configured: false });
    }
    if (!payload.hash) return buildSkippedTorboxScan('missing_hash', { configured: tbAvailability.configured });

    try {
        const cachedHashes = await TorboxClient.checkCached(token, [payload.hash]);
        const cached = cachedHashes.map((hash) => String(hash || '').toUpperCase()).includes(String(payload.hash || '').toUpperCase());
        const state = cached ? 'cached' : 'likely_uncached';
        let updated = 0;
        if (dbHelper && typeof dbHelper.updateTbCacheStatus === 'function') {
            updated = await dbHelper.updateTbCacheStatus([{
                hash: payload.hash,
                cached,
                title: payload.title || null,
                torrent_title: payload.title || null,
                size: Number(payload.size || 0) || null,
                imdb_id: payload.imdbId || null,
                imdb_season: payload.season || null,
                imdb_episode: payload.episode || null
            }]);
        }
        const cacheInvalidated = await invalidateManualImportCaches(Cache, payload, cached ? 'manual_import_tb_cached' : 'manual_import_tb_checked');
        logger.info('[ADMIN] Manual import TorBox cache check completed', {
            hash: payload.hash,
            imdbId: payload.imdbId,
            season: payload.season,
            episode: payload.episode,
            cached,
            updated,
            cacheInvalidated
        });
        return { skipped: false, cached, state, updated, cacheInvalidated, configured: true, tokenSource: tbAvailability.source, nonBlocking: true };
    } catch (error) {
        logger.warn?.(`[ADMIN] Manual import TorBox cache check failed but import continues | hash=${payload.hash} | error=${error.message}`);
        return { skipped: false, cached: null, state: 'error', error: error.message, importContinued: true, nonBlocking: true };
    }
}

function registerAdminRoutes(app, {
    Cache,
    ADMIN_PASS,
    safeCompare,
    dbHelper,
    logger,
    queueCloudBuild
}) {
    const authMiddleware = (req, res, next) => {
        res.setHeader('Cache-Control', 'no-store');
        if (!ADMIN_PASS) return res.status(503).json({ error: 'Admin disabilitato: configura ADMIN_PASS nell\'ambiente' });
        const rawAuthHeader = String(req.headers.authorization || '').trim();
        if (safeCompare(rawAuthHeader.toLowerCase().startsWith('bearer ') ? rawAuthHeader.slice(7).trim() : rawAuthHeader, ADMIN_PASS)) {
            return next();
        }
        return res.status(403).json({ error: 'Password errata' });
    };

    app.get('/admin/keys', authMiddleware, async (req, res) => res.json(await Cache.listKeys()));
    app.delete('/admin/key', authMiddleware, async (req, res) => {
        if (!req.query.key) return res.json({ error: 'Key mancante' });
        await Cache.deleteKey(req.query.key);
        return res.json({ success: true });
    });
    app.post('/admin/flush', authMiddleware, async (req, res) => {
        await Cache.flushAll();
        res.json({ success: true });
    });

    app.post('/admin/cache/invalidate', authMiddleware, async (req, res) => {
        const hashes = normalizeHashes(req.body?.hashes || req.body?.hash || []);
        const imdbId = String(req.body?.imdbId || req.body?.imdb_id || '').trim().toLowerCase();
        const season = Number.isInteger(Number(req.body?.season)) ? Number(req.body.season) : null;
        const episode = Number.isInteger(Number(req.body?.episode)) ? Number(req.body.episode) : null;
        const dbKey = String(req.body?.dbLookupKey || '').trim();
        const reason = String(req.body?.reason || 'manual_admin_invalidation').trim();

        const outcomes = {};
        if (hashes.length > 0) outcomes.hashes = await Cache.invalidateStreamsByHashes(hashes, reason);
        if (/^tt\d+$/.test(imdbId) && season > 0 && episode > 0) outcomes.episode = await Cache.invalidateStreamsByEpisode({ imdbId, season, episode }, reason);
        else if (/^tt\d+$/.test(imdbId)) outcomes.imdb = await Cache.invalidateStreamsByImdb(imdbId, reason);
        if (dbKey) outcomes.dbLookup = await Cache.invalidateDbTorrents(dbKey, reason);

        res.json({ success: true, outcomes });
    });

    app.post('/admin/runtime/drain', authMiddleware, async (req, res) => {
        const enableDrain = req.body?.enabled !== false;
        const reason = String(req.body?.reason || 'manual_admin_drain').trim();
        if (enableDrain) runtimeState.markDraining(reason, { rejectNewRequests: req.body?.rejectNewRequests !== false });
        else runtimeState.clearDraining();
        res.json({ success: true, runtime: runtimeState.getSnapshot() });
    });


    app.get('/admin/health', authMiddleware, async (req, res) => {
        try {
            return res.json(await buildAdminHealthPayload({ Cache, dbHelper }));
        } catch (error) {
            logger.error('[ADMIN] Health check failed', { error: error.message });
            return res.status(500).json({ success: false, status: 'error', error: error.message });
        }
    });

    app.post('/admin/manual-import/dry-run', authMiddleware, async (req, res) => {
        let payload;
        try {
            payload = normalizeManualImportPayload(req.body || {});
        } catch (error) {
            return res.status(400).json({ success: false, error: `Dry-run torrent non valido: ${error.message}` });
        }

        if (!payload.hash) {
            return res.status(400).json({ success: false, error: 'Fornisci hash/infoHash, magnet o torrent valido.' });
        }

        try {
            const identityMatch = await resolveManualImportIdentity(payload, logger);
            const explain = buildManualImportExplain(payload, identityMatch, { dryRun: true });
            const tbAvailability = getManualImportTbAvailability(payload);
            return res.json({
                success: true,
                dryRun: true,
                explain,
                payload: serializeManualPayload(payload),
                summary: {
                    identityMatch,
                    wouldEnsureTorrent: true,
                    wouldMapIdentity: Boolean(payload.imdbId),
                    wouldMapEpisode: Boolean(payload.imdbId && payload.type !== 'movie' && payload.season && payload.episode),
                    wouldInsertPackFiles: Array.isArray(payload.packFiles) ? payload.packFiles.length : 0,
                    wouldScanRd: payload.scanRd === true,
                    wouldScanTb: payload.scanTb === true && tbAvailability.configured,
                    torbox: {
                        requested: payload.scanTb === true,
                        configured: tbAvailability.configured,
                        wouldScan: payload.scanTb === true && tbAvailability.configured,
                        skipReason: payload.scanTb === true && !tbAvailability.configured ? 'missing_torbox_token' : null,
                        nonBlocking: true
                    },
                    cacheMode: payload.cacheMode,
                    provider: payload.provider
                }
            });
        } catch (error) {
            logger.error('[ADMIN] Manual import dry-run failed', { error: error.message, hash: payload.hash });
            return res.status(500).json({ success: false, dryRun: true, error: error.message, payload: serializeManualPayload(payload) });
        }
    });

    app.post('/admin/manual-import/cache-check', authMiddleware, async (req, res) => {
        let payload;
        try {
            payload = normalizeManualImportPayload(req.body || {});
        } catch (error) {
            return res.status(400).json({ success: false, error: `Cache check torrent non valido: ${error.message}` });
        }
        if (!payload.hash) return res.status(400).json({ success: false, error: 'Fornisci hash/infoHash, magnet o torrent valido.' });

        const result = { rd: null, torbox: null };
        if (payload.scanRd) result.rd = await inspectManualImportWithRd(payload, { logger });
        if (payload.scanTb) result.torbox = await scanManualImportWithTorbox(payload, { Cache, dbHelper, logger });
        return res.json({ success: true, payload: serializeManualPayload(payload), cache: result });
    });

    app.post('/admin/manual-import/bulk', authMiddleware, async (req, res) => {
        const items = Array.isArray(req.body?.items) ? req.body.items : (Array.isArray(req.body?.magnets) ? req.body.magnets.map((magnet) => ({ magnet })) : []);
        const limit = Math.max(1, Math.min(25, Number(req.body?.limit || items.length || 1) || 1));
        const selected = items.slice(0, limit);
        const results = [];
        for (const item of selected) {
            const fakeReq = { body: item };
            try {
                const payload = normalizeManualImportPayload(fakeReq.body || {});
                if (!payload.hash) {
                    results.push({ success: false, error: 'missing_hash', item: fakeReq.body });
                    continue;
                }
                const identityMatch = await resolveManualImportIdentity(payload, logger);
                const ensured = await dbHelper.ensureTorrentRecord(buildManualTorrentRow(payload));
                let mapped = false;
                if (payload.imdbId) {
                    mapped = await dbHelper.insertTorrent({ imdb_id: payload.imdbId, type: payload.type, season: payload.season, episode: payload.episode }, buildManualTorrentRow(payload));
                    await invalidateManualImportCaches(Cache, payload, 'manual_import_bulk');
                } else {
                    await Cache.invalidateStreamsByHashes([payload.hash], 'manual_import_bulk');
                }
                results.push({ success: true, hash: payload.hash, provider: payload.provider, identityMatch, ensured, mapped });
            } catch (error) {
                results.push({ success: false, error: error.message, item });
            }
        }
        return res.json({ success: true, processed: results.length, results });
    });

    app.post('/admin/manual-import/identity-candidates', authMiddleware, async (req, res) => {
        try {
            const result = await buildManualImportIdentityCandidates(req.body || {}, logger);
            return res.json({ success: true, ...result });
        } catch (error) {
            logger.error('[ADMIN] Manual import identity candidates failed', { error: error.message });
            return res.status(500).json({ success: false, error: error.message, candidates: [] });
        }
    });

    app.post('/admin/manual-import', authMiddleware, async (req, res) => {
        let payload;
        try {
            payload = normalizeManualImportPayload(req.body || {});
        } catch (error) {
            return res.status(400).json({ success: false, error: `Import torrent non valido: ${error.message}` });
        }

        if (!payload.hash) {
            return res.status(400).json({ error: 'Fornisci hash/infoHash, magnet o torrent valido.' });
        }

        const summary = {
            importSource: payload.importSource,
            identityMatch: null,
            ensured: false,
            mapped: false,
            episodeMapped: false,
            movieGenericMapped: false,
            packFilesInserted: 0,
            cacheInvalidated: null,
            dbLookupInvalidated: null,
            rdScan: null,
            tbScan: null,
            cloudBuildQueued: []
        };

        try {
            summary.identityMatch = await resolveManualImportIdentity(payload, logger);

            summary.ensured = await dbHelper.ensureTorrentRecord(buildManualTorrentRow(payload));

            if (payload.imdbId) {
                summary.mapped = await dbHelper.insertTorrent({
                    imdb_id: payload.imdbId,
                    type: payload.type,
                    season: payload.season,
                    episode: payload.episode
                }, buildManualTorrentRow(payload));

                if (payload.type === 'movie') {
                    summary.movieGenericMapped = await dbHelper.insertTorrent({
                        imdb_id: payload.imdbId,
                        type: payload.type,
                        season: null,
                        episode: null
                    }, buildManualTorrentRow(payload, { fileIndex: null }));
                }

                if (payload.type !== 'movie' && payload.season && payload.episode) {
                    const episodeInsert = await dbHelper.insertEpisodeFiles([{
                        info_hash: payload.hash,
                        file_index: payload.fileIndex,
                        imdb_id: payload.imdbId,
                        imdb_season: payload.season,
                        imdb_episode: payload.episode,
                        title: payload.title,
                        size: payload.size
                    }]);
                    summary.episodeMapped = Number(episodeInsert?.processed || 0) > 0;
                }

                if (payload.packFiles.length > 0 && typeof dbHelper.insertPackFiles === 'function') {
                    const packInsert = await dbHelper.insertPackFiles(payload.packFiles.map((entry) => ({
                        pack_hash: payload.hash,
                        file_index: entry?.file_index ?? entry?.fileIdx,
                        imdb_id: entry?.imdb_id || entry?.imdbId || payload.imdbId,
                        imdb_season: entry?.imdb_season ?? entry?.season,
                        imdb_episode: entry?.imdb_episode ?? entry?.episode,
                        file_path: entry?.file_path || entry?.filePath,
                        file_title: entry?.file_title || entry?.fileTitle || entry?.title,
                        file_size: entry?.file_size || entry?.size
                    })));
                    summary.packFilesInserted = Number(packInsert?.processed || 0);
                }

                summary.cacheInvalidated = await invalidateManualImportCaches(Cache, payload, 'manual_import');
                summary.dbLookupInvalidated = summary.cacheInvalidated?.dbLookup || null;
            } else {
                summary.cacheInvalidated = await Cache.invalidateStreamsByHashes([payload.hash], 'manual_import');
            }

            if (payload.scanRd) {
                summary.rdScan = await scanManualImportWithRd(payload, { Cache, dbHelper, logger });
                summary.dbLookupInvalidated = summary.rdScan?.cacheInvalidated?.dbLookup || summary.dbLookupInvalidated;
            } else {
                summary.rdScan = { skipped: true, reason: 'disabled' };
            }

            if (payload.scanTb) {
                summary.tbScan = await scanManualImportWithTorbox(payload, { Cache, dbHelper, logger });
                summary.dbLookupInvalidated = summary.tbScan?.cacheInvalidated?.dbLookup || summary.dbLookupInvalidated;
            } else {
                summary.tbScan = { skipped: true, reason: 'disabled' };
            }

            if (typeof queueCloudBuild === 'function') {
                if ((payload.service === 'rd' || payload.service === 'both') && payload.rdApiKey) {
                    await queueCloudBuild('rd', payload.hash, payload.rdApiKey);
                    summary.cloudBuildQueued.push('rd');
                }
                if ((payload.service === 'tb' || payload.service === 'both') && payload.torboxApiKey) {
                    await queueCloudBuild('tb', payload.hash, payload.torboxApiKey);
                    summary.cloudBuildQueued.push('tb');
                }
            }

            logger.info('[ADMIN] Manual import completed', {
                hash: payload.hash,
                imdbId: payload.imdbId,
                season: payload.season,
                episode: payload.episode,
                service: payload.service,
                importSource: payload.importSource,
                cloudBuildQueued: summary.cloudBuildQueued,
                packFilesInserted: summary.packFilesInserted
            });

            return res.json({ success: true, payload: serializeManualPayload(payload), explain: buildManualImportExplain(payload, summary.identityMatch, { dryRun: false }), summary });
        } catch (error) {
            logger.error('[ADMIN] Manual import failed', { error: error.message, hash: payload.hash, imdbId: payload.imdbId, importSource: payload.importSource });
            return res.status(500).json({ success: false, error: error.message, payload, summary });
        }
    });
}

module.exports = {
    registerAdminRoutes,
    _test: {
        normalizeManualImportPayload,
        resolveManualImportIdentity,
        deriveManualProvider,
        buildManualImportExplain
    }
};
