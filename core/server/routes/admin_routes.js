'use strict';

const runtimeState = require('../../runtime_state');
const tmdbHelper = require('../../utils/tmdb_helper');
const RealDebridProbe = require('../../debrid/probe/realdebrid_probe');
const { parseSeasonEpisode } = require('../../pack_intelligence');
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


function deriveManualProvider(rawProvider, sourceUrl, sourceTitle) {
    const raw = String(rawProvider || '').trim();
    const generic = !raw || /^(manual|leviathan_companion|companion|unknown|n\/a)$/i.test(raw);
    const sourceText = `${sourceUrl || ''} ${sourceTitle || ''}`.toLowerCase();
    let host = '';
    try { host = new URL(String(sourceUrl || '')).hostname.replace(/^www\./i, '').toLowerCase(); } catch (_) {}
    const haystack = `${host} ${sourceText}`;
    if (/bt4g|b\d+gprx|downloadtorrentfile/.test(haystack)) return 'BT4G';
    if (/1337x/.test(haystack)) return '1337x';
    if (/rarbg/.test(haystack)) return 'RARBG';
    if (/torrentgalaxy|tgx/.test(haystack)) return 'TorrentGalaxy';
    if (/thepiratebay|piratebay/.test(haystack)) return 'ThePirateBay';
    if (!generic) return raw.slice(0, 64);
    if (host) return host.split('.')[0].replace(/[^a-z0-9_-]+/gi, '').slice(0, 32) || 'MANUAL';
    return 'MANUAL';
}

function normalizeManualImportPayload(body = {}) {
    let torrentMeta = null;
    const magnet = parseMagnetInput(body.magnet || body.magnetUri || body.magnetURI || body.magnet_url || body.magnetUrl || '');
    const torrentSource = body.torrent || body.torrentB64 || body.torrentBase64 || body.torrentFile || body.torrent_file || null;
    if (torrentSource) torrentMeta = parseTorrentInput(torrentSource);

    const rawTitle = String(body.title || '').trim() || magnet?.title || torrentMeta?.title || '';
    const sourceUrl = String(body.sourceUrl || body.source_url || '').trim() || null;
    const sourceTitle = String(body.sourceTitle || body.source_title || body.pageTitle || body.page_title || '').trim() || null;
    const parsedFromTitle = rawTitle ? parseSeasonEpisode(rawTitle, 1, { anime: body.isAnime === true || body.anime === true }) : null;
    const imdbId = String(body.imdbId || body.imdb_id || '').trim().toLowerCase();
    const season = Number.isInteger(Number(body.season)) && Number(body.season) > 0 ? Number(body.season) : (parsedFromTitle?.season || null);
    const episode = Number.isInteger(Number(body.episode)) && Number(body.episode) > 0 ? Number(body.episode) : (parsedFromTitle?.episode || null);
    const requestedFileIndex = Number.isInteger(Number(body.fileIdx ?? body.file_index)) && Number(body.fileIdx ?? body.file_index) >= 0
        ? Number(body.fileIdx ?? body.file_index)
        : null;
    const inferredType = String(body.type || (season || episode ? 'series' : 'movie')).trim().toLowerCase();
    const hash = normalizeHash(body.hash || body.infoHash || body.info_hash) || magnet?.infoHash || torrentMeta?.infoHash || null;
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
        : (Number(torrentMeta?.totalSize || 0) || 0);
    const service = ['rd', 'tb'].includes(String(body.service || '').trim().toLowerCase()) ? String(body.service).trim().toLowerCase() : null;

    return {
        hash,
        magnet: magnet?.magnet || String(body.magnet || body.magnetUri || body.magnetURI || '').trim() || null,
        title: rawTitle || hash,
        sourceTitle,
        sourceUrl,
        scanRd: body.scanRd !== false && body.scan_rd !== false,
        provider: deriveManualProvider(body.provider || body.source, sourceUrl, sourceTitle),
        imdbId: /^tt\d+$/.test(imdbId) ? imdbId : null,
        type: inferredType,
        season,
        episode,
        fileIndex: autoFileIndex,
        size,
        service,
        apiKey: String(body.apiKey || body.api_key || '').trim() || null,
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
    return String(payload.apiKey || process.env.RD_SCAN_TOKEN || process.env.RD_API_KEY || process.env.REALDEBRID_API_KEY || '').trim();
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
        const fallbackTorrentRow = { ...torrentRow, file_index: null, fileIndex: null, fileIdx: null };
        if (typeof dbHelper.ensureTorrentRecord === 'function') {
            outcome.fallbackEnsured = await dbHelper.ensureTorrentRecord(fallbackTorrentRow);
        }
        if (typeof dbHelper.insertTorrent === 'function') {
            outcome.fallbackMapped = await dbHelper.insertTorrent(mediaMeta, fallbackTorrentRow);
        }
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
            packFilesInserted: 0,
            cacheInvalidated: null,
            dbLookupInvalidated: null,
            rdScan: null,
            cloudBuildQueued: false
        };

        try {
            summary.identityMatch = await resolveManualImportIdentity(payload, logger);

            summary.ensured = await dbHelper.ensureTorrentRecord({
                info_hash: payload.hash,
                title: payload.title,
                provider: payload.provider,
                size: payload.size,
                file_index: payload.fileIndex,
                magnet: payload.magnet || undefined
            });

            if (payload.imdbId) {
                summary.mapped = await dbHelper.insertTorrent({
                    imdb_id: payload.imdbId,
                    type: payload.type,
                    season: payload.season,
                    episode: payload.episode
                }, {
                    info_hash: payload.hash,
                    title: payload.title,
                    provider: payload.provider,
                    size: payload.size,
                    file_index: payload.fileIndex,
                    magnet: payload.magnet || undefined,
                    is_pack: payload.packFiles.length > 1
                });

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

            summary.rdScan = await scanManualImportWithRd(payload, { Cache, dbHelper, logger });
            summary.dbLookupInvalidated = summary.rdScan?.cacheInvalidated?.dbLookup || summary.dbLookupInvalidated;

            if (payload.service && payload.apiKey && typeof queueCloudBuild === 'function') {
                await queueCloudBuild(payload.service, payload.hash, payload.apiKey);
                summary.cloudBuildQueued = true;
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

            return res.json({ success: true, payload: {
                ...payload,
                torrentMeta: payload.torrentMeta ? {
                    title: payload.torrentMeta.title,
                    totalSize: payload.torrentMeta.totalSize,
                    files: payload.torrentMeta.files
                } : null
            }, summary });
        } catch (error) {
            logger.error('[ADMIN] Manual import failed', { error: error.message, hash: payload.hash, imdbId: payload.imdbId, importSource: payload.importSource });
            return res.status(500).json({ success: false, error: error.message, payload, summary });
        }
    });
}

module.exports = { registerAdminRoutes };
