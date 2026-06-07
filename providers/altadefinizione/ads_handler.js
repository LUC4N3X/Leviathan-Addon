'use strict';

const axios = require('axios');
const { HTTP_AGENT, HTTPS_AGENT } = require('../../core/utils/http');
const tmdbHelper = require('../../core/utils/tmdb_helper');
const { SingleFlight, TtlLruCache } = require('../utils/provider_runtime');
const { withProviderHealth } = require('../utils/provider_health');
const { normalizeStreams } = require('../utils/stream_normalizer');
const {
    buildWebStream,
    dedupeStreamsByUrl,
    normalizeQuality,
    normalizeRemoteUrl,
    pickBetterQuality,
    probePlaylistIntelligence,
    decorateStreamWithPlaylistIntelligence,
    qualityRank
} = require('../extractors/common');
const { extractFromUrl, resolveExtractorDefinition } = require('../extractors/registry');
const { extractEmbedCandidates } = require('../extractors/semantic_candidate_extractor');
const { createMediaflowGateway, getMediaflowBase } = require('../../core/proxy/mediaflow_gateway');
const { getProviderDomain } = require('../utils/provider_domain_registry');

const PROVIDER_ID = 'altadefinizione';
const PROVIDER_LABEL = 'AltadefinizioneStreaming';
const PROVIDER_CODE = 'ADS';
const BASE_URL = String(process.env.ALTADEFINIZIONE_BASE_URL || getProviderDomain('altadefinizione', 'https://altadefinizionestreaming.com')).replace(/\/+$/, '');
const USER_AGENT = String(process.env.ALTADEFINIZIONE_USER_AGENT || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Safari/537.36');
const TIMEOUT_MS = Math.max(5000, Number.parseInt(process.env.ALTADEFINIZIONE_TIMEOUT_MS || '12000', 10) || 12000);
const STREAM_TTL_MS = Math.max(60_000, Number.parseInt(process.env.ALTADEFINIZIONE_STREAM_TTL_MS || String(10 * 60 * 1000), 10) || 10 * 60 * 1000);
const JSON_TTL_MS = Math.max(60_000, Number.parseInt(process.env.ALTADEFINIZIONE_JSON_TTL_MS || String(30 * 60 * 1000), 10) || 30 * 60 * 1000);
const MAX_SOURCES = Math.max(1, Math.min(8, Number.parseInt(process.env.ALTADEFINIZIONE_MAX_SOURCES || '4', 10) || 4));
const DEBUG = /^(1|true|yes|on)$/i.test(String(process.env.ALTADEFINIZIONE_DEBUG || '0'));
const KRAKEN_FIRST = /^(1|true|yes|on)$/i.test(String(process.env.ALTADEFINIZIONE_KRAKEN_FIRST || '1'));
const KRAKEN_EXTRACTOR_PATH = String(process.env.ALTADEFINIZIONE_KRAKEN_EXTRACTOR_PATH || process.env.KRAKEN_EXTRACTOR_PATH || '/extractor/video.m3u8').trim() || '/extractor/video.m3u8';

const http = axios.create({
    timeout: TIMEOUT_MS,
    httpAgent: HTTP_AGENT,
    httpsAgent: HTTPS_AGENT,
    maxRedirects: 5,
    decompress: true,
    proxy: false,
    validateStatus: (status) => status >= 200 && status < 400,
    headers: {
        'User-Agent': USER_AGENT,
        Accept: 'application/json,text/plain,*/*',
        'Accept-Language': 'it-IT,it;q=0.9,en-US;q=0.8,en;q=0.7',
        Referer: `${BASE_URL}/`
    }
});

const cache = {
    json: new TtlLruCache({ name: 'altadefinizione:json', ttlMs: JSON_TTL_MS, staleTtlMs: JSON_TTL_MS, max: 800, cloneValues: true }),
    streams: new TtlLruCache({ name: 'altadefinizione:streams', ttlMs: STREAM_TTL_MS, staleTtlMs: STREAM_TTL_MS, max: 1600, cloneValues: true })
};

const singleFlight = new SingleFlight('altadefinizione');

function log(message, meta = null) {
    if (!DEBUG) return;
    const suffix = meta ? ` ${JSON.stringify(meta)}` : '';
    console.log(`[Altadefinizione] ${message}${suffix}`);
}

function responseData(response) {
    return response?.data && typeof response.data === 'object' ? response.data : null;
}

function originOf(value, fallback = BASE_URL) {
    try { return new URL(String(value || fallback)).origin; } catch (_) { return fallback; }
}

function headersFor(url, referer = BASE_URL) {
    return {
        'User-Agent': USER_AGENT,
        Accept: '*/*',
        'Accept-Language': 'it-IT,it;q=0.9,en-US;q=0.8,en;q=0.7',
        Referer: referer || `${BASE_URL}/`,
        Origin: originOf(referer || url, BASE_URL)
    };
}

function isDirectHls(url) {
    return /\.m3u8(?:$|[?#])/i.test(String(url || ''));
}

function isDirectVideo(url) {
    return /\.(?:mp4|mkv|webm)(?:$|[?#])/i.test(String(url || ''));
}

function getKrakenGateway(config = {}) {
    const gateway = createMediaflowGateway(config);
    return gateway.isConfigured ? gateway : null;
}

function getSourceLanguageLabel(source = {}, playlistIntel = null) {
    const audio = Array.isArray(playlistIntel?.audioLanguages) ? playlistIntel.audioLanguages.map((item) => String(item).toLowerCase()) : [];
    const text = `${source.language || ''} ${source.lang || ''} ${source.provider || ''} ${source.extractor || ''} ${source.title || ''}`;
    const inferred = audioLanguagesFromText(text);
    if (audio.length) return languageLabelForAudioLanguages([...(inferred.length ? inferred : ['ita']), ...audio]);
    if (inferred.length) return languageLabelForAudioLanguages(inferred);
    return 'ITA';
}

function normalizeAudioLanguage(value) {
    const clean = String(value || '').trim().toLowerCase();
    if (!clean) return '';
    if (/^(?:it|ita|italian|italiano)$/.test(clean)) return 'ita';
    if (/^(?:en|eng|english|inglese)$/.test(clean)) return 'eng';
    if (/^(?:ja|jp|jpn|jap|japanese|giapponese)$/.test(clean)) return 'jpn';
    if (/^(?:fr|fra|fre|french|francese)$/.test(clean)) return 'fra';
    if (/^(?:es|esp|spa|spanish|spagnolo)$/.test(clean)) return 'spa';
    if (/^(?:de|deu|ger|german|tedesco)$/.test(clean)) return 'deu';
    if (/^(?:und|unknown|sconosciuto)$/.test(clean)) return 'und';
    return clean.slice(0, 12);
}

function audioLanguagesFromText(...values) {
    const text = values.map((value) => String(value || '')).join(' ');
    const out = [];
    const push = (lang) => {
        const normalized = normalizeAudioLanguage(lang);
        if (normalized && !out.includes(normalized)) out.push(normalized);
    };

    const isSubOnly = /\b(?:sub\s*ita|vost(?:it)?|sottotitoli?\s*ita)\b/i.test(text)
        && !/\b(?:dub\s*ita|audio\s*ita|ita\s*(?:dub|audio)|doppiat[oa])\b/i.test(text);
    const multiAudio = /\b(?:multi(?:[\s._-]*audio)?|dual[\s._-]*audio)\b/i.test(text)
        && !/\b(?:multi[\s._-]*sub|multisub|sub[\s._-]*multi)\b/i.test(text);

    if (multiAudio) {
        push('ita');
        push('eng');
    }
    if (!isSubOnly && /🇮🇹|\b(?:ita|it|italiano|italian)\b/i.test(text)) push('ita');
    if (/🇬🇧|\b(?:eng|en|inglese|english)\b/i.test(text)) push('eng');
    if (/🇯🇵|\b(?:jpn|jp|jap|ja|giapponese|japanese)\b/i.test(text)) push('jpn');
    if (/🇫🇷|\b(?:fra|fre|fr|francese|french)\b/i.test(text)) push('fra');
    if (/🇪🇸|\b(?:spa|esp|es|spagnolo|spanish)\b/i.test(text)) push('spa');
    if (/🇩🇪|\b(?:deu|ger|de|tedesco|german)\b/i.test(text)) push('deu');
    return out;
}

function languageLabelForAudioLanguages(languages = []) {
    const labels = {
        ita: 'ITA',
        eng: 'ENG',
        jpn: 'JPN',
        fra: 'FRA',
        spa: 'SPA',
        deu: 'DEU',
        und: 'UND'
    };
    const unique = [];
    for (const item of Array.isArray(languages) ? languages : [languages]) {
        const normalized = normalizeAudioLanguage(item);
        if (normalized && !unique.includes(normalized)) unique.push(normalized);
    }
    if (!unique.length) return 'ITA';
    if (unique.includes('ita')) {
        const ordered = ['ita', ...unique.filter((lang) => lang !== 'ita')];
        return ordered.length > 1 ? `MULTI ${ordered.map((lang) => labels[lang] || lang.toUpperCase()).join('/')}` : 'ITA';
    }
    if (unique.length > 1) return `MULTI ${unique.map((lang) => labels[lang] || lang.toUpperCase()).join('/')}`;
    return labels[unique[0]] || unique[0].toUpperCase();
}

function audioLanguagesForLabel(label = '') {
    const fromText = audioLanguagesFromText(label);
    if (fromText.length) return fromText;
    const clean = String(label || '').trim().toUpperCase();
    if (!clean) return ['ita'];
    if (/\bMULTI\b/.test(clean)) return ['ita', 'eng'];
    if (/\bITA\b/.test(clean)) return ['ita'];
    if (/\bENG\b/.test(clean)) return ['eng'];
    if (/\bUND\b|UNKNOWN|SCONOSCIUT/.test(clean)) return ['und'];
    return ['ita'];
}

function languageSortRank(stream = {}) {
    const meta = stream?.behaviorHints?.vortexMeta || {};
    const text = [stream.title, stream.name, meta.language, ...(Array.isArray(meta.audioLanguages) ? meta.audioLanguages : [])].filter(Boolean).join(' ');
    if (/\bmulti\b/i.test(text)) return 1;
    if (/🇮🇹|\b(?:ita|it|italiano|italian)\b/i.test(text)) return 0;
    if (/\bund\b|unknown|sconosciut/i.test(text)) return 2;
    return 3;
}

async function fetchJson(url, { ttlMs = JSON_TTL_MS } = {}) {
    const cached = cache.json.get(url);
    if (cached) return cached;

    return singleFlight.do(`json:${url}`, async () => {
        const second = cache.json.get(url);
        if (second) return second;
        const response = await http.get(url, { headers: headersFor(url, `${BASE_URL}/`) });
        const data = responseData(response);
        if (data) cache.json.set(url, data, ttlMs, ttlMs);
        return data;
    });
}

function normalizeImdbId(value) {
    const match = String(value || '').match(/tt\d{5,12}/i);
    return match ? match[0].toLowerCase() : null;
}

function normalizeProviderType(value) {
    const type = String(value || '').trim().toLowerCase();
    return type === 'movie' || type === 'film' ? 'movie' : 'tv';
}

function parsePositiveInt(...values) {
    for (const value of values) {
        const parsed = Number.parseInt(String(value ?? '').trim(), 10);
        if (Number.isInteger(parsed) && parsed > 0) return parsed;
    }
    return null;
}

function extractTmdbId(value) {
    const raw = String(value || '').trim();
    const match = raw.match(/(?:tmdb:)?(?:movie:|tv:|series:)?(\d+)/i);
    return match?.[1] || null;
}

function buildPlayerSourcesEndpoint({ tmdbId, type, season = 1, episode = 1 }) {
    const cleanTmdbId = extractTmdbId(tmdbId);
    if (!cleanTmdbId) return null;
    const providerType = normalizeProviderType(type);
    if (providerType === 'movie') return `${BASE_URL}/api/player-sources/movie/${cleanTmdbId}`;
    return `${BASE_URL}/api/player-sources/tv/${cleanTmdbId}/${Number(season) || 1}/${Number(episode) || 1}`;
}

function buildDownloadEndpoint({ tmdbId, type }) {
    const cleanTmdbId = extractTmdbId(tmdbId);
    if (!cleanTmdbId) return null;
    return normalizeProviderType(type) === 'movie'
        ? `${BASE_URL}/api/download/${cleanTmdbId}`
        : `${BASE_URL}/api/download-episodes/${cleanTmdbId}`;
}

function isBlockedSource(source = {}) {
    const text = `${source.provider || ''} ${source.url || ''}`;
    return /vixsrc\.to|vixsrc/i.test(text);
}

function isCdnSource(source = {}, url = '') {
    const text = String(source.provider || source.name || source.label || '').toLowerCase();
    return /\bcdn\b/.test(text) || isDirectHls(url) || isDirectVideo(url);
}

function sourceExtractorLabel(source = {}) {
    const url = String(source.url || '');
    const def = resolveExtractorDefinition(url);
    if (def?.label) return def.label;
    if (isCdnSource(source, url)) return 'CDN';
    const text = String(source.provider || source.name || source.label || '').trim();
    return text ? text.replace(/\s+/g, ' ') : 'Direct';
}

function sourcePriority(source = {}) {
    const url = String(source.url || '');
    const def = resolveExtractorDefinition(url);
    if (def?.priority != null) return 30 + def.priority;
    if (isCdnSource(source, url)) return 10;
    return 80;
}

function shouldExposeLazyFallback() {
    return false;
}

function collectPlayableSources({ payload = {} } = {}) {
    const out = [];
    const seen = new Set();
    const add = (source = {}) => {
        if (isBlockedSource(source)) return;
        const url = normalizeRemoteUrl(source.url, BASE_URL);
        if (!url || seen.has(url)) return;
        const extractor = sourceExtractorLabel({ ...source, url });
        seen.add(url);
        out.push({
            url,
            extractor,
            provider: source.provider || extractor,
            quality: normalizeQuality(source.quality || source.label || source.name || 'Unknown'),
            priority: sourcePriority({ ...source, url, extractor })
        });
    };

    for (const source of Array.isArray(payload?.sources) ? payload.sources : []) add(source);

    for (const semanticCandidate of extractEmbedCandidates(payload, { baseUrl: BASE_URL, maxCandidates: MAX_SOURCES })) {
        add({
            url: semanticCandidate.url,
            provider: semanticCandidate.label,
            quality: 'Unknown'
        });
    }

    return out.sort((a, b) => (a.priority - b.priority) || (qualityRank(b.quality) - qualityRank(a.quality)));
}

async function resolveDownloadToHoster(url, client = http) {
    const downloadUrl = normalizeRemoteUrl(url, BASE_URL);
    if (!downloadUrl) return null;
    const target = `${downloadUrl}${downloadUrl.includes('?') ? '&' : '?'}go=1`;
    try {
        const response = await client.get(target, {
            maxRedirects: 5,
            headers: headersFor(target, `${BASE_URL}/`),
            validateStatus: () => true
        });
        const finalUrl = normalizeRemoteUrl(response?.request?.res?.responseUrl || response?.request?._redirectable?._currentUrl || response?.config?.url || '', BASE_URL);
        if (finalUrl && resolveExtractorDefinition(finalUrl)) return finalUrl.replace(/\?download$/i, '');
    } catch (_) {}
    return null;
}

async function collectDownloadSources({ tmdbId, type, season, episode }) {
    const endpoint = buildDownloadEndpoint({ tmdbId, type });
    if (!endpoint) return [];
    const payload = await fetchJson(endpoint).catch(() => null);
    if (!payload?.available) return [];

    let downloadUrl = payload.url || null;
    if (normalizeProviderType(type) !== 'movie') {
        const episodes = Array.isArray(payload.episodes) ? payload.episodes : [];
        const match = episodes.find((item) => Number(item?.season) === Number(season) && Number(item?.episode) === Number(episode));
        downloadUrl = match?.url || null;
    }

    const hosterUrl = await resolveDownloadToHoster(downloadUrl);
    if (!hosterUrl) return [];
    const def = resolveExtractorDefinition(hosterUrl);
    return [{
        url: hosterUrl,
        extractor: def?.label || sourceExtractorLabel({ url: hosterUrl }),
        provider: def?.label || 'Hoster',
        quality: 'Unknown',
        priority: 30 + (def?.priority ?? 9)
    }];
}

function buildKrakenResolvedStream(source, def = null, { title, config = {}, pageUrl = BASE_URL, playlistIntel = null, via = 'kraken-first' } = {}) {
    const gateway = getKrakenGateway(config);
    if (!gateway) return null;

    const host = def?.label || source.extractor || sourceExtractorLabel(source) || 'CDN';
    const requestHeaders = headersFor(source.url, pageUrl);
    const label = host || 'Web';
    let url = null;
    let kind = 'extractor';

    if (isDirectHls(source.url)) {
        url = gateway.buildProxyUrl(source.url, requestHeaders, { isHls: true });
        kind = 'hls-proxy';
    } else if (isDirectVideo(source.url)) {
        url = gateway.buildProxyUrl(source.url, requestHeaders, { isHls: false });
        kind = 'direct-proxy';
    } else {
        url = gateway.buildExtractorUrl(source.url, label, {
            extractorPath: KRAKEN_EXTRACTOR_PATH,
            redirectStream: true,
            headers: requestHeaders
        });
        kind = 'extractor';
    }

    if (!url || url === source.url) return null;

    const languageLabel = getSourceLanguageLabel(source, playlistIntel);
    const quality = pickBetterQuality(playlistIntel?.quality || 'Unknown', source.quality || 'Unknown');
    const audioLanguages = audioLanguagesForLabel(languageLabel);

    const stream = buildWebStream({
        name: `${PROVIDER_LABEL} | ${label} Kraken`,
        title: `${title}\n${label} ${languageLabel}`,
        url,
        extractor: label,
        provider: PROVIDER_LABEL,
        providerCode: PROVIDER_CODE,
        quality,
        headers: null,
        mediaflowUrl: getMediaflowBase(config),
        extraBehaviorHints: {
            bingeWatching: true,
            vortexMeta: {
                via,
                resolver: 'kraken',
                streamKind: kind,
                language: languageLabel,
                audioLanguages,
                sourceUrl: source.url,
                sourceProvider: source.provider || label
            }
        },
        extra: { _priority: source.priority ?? def?.priority ?? 9, _italian: languageLabel === 'ITA' }
    });

    return decorateStreamWithPlaylistIntelligence(stream, playlistIntel);
}

function buildMediaflowFallbackStream(source, def, { title, config = {}, pageUrl = BASE_URL } = {}) {
    return buildKrakenResolvedStream(source, def, { title, config, pageUrl, via: 'kraken-fallback' });
}

async function resolveSourceToStream(source, { title, reqHost, pageUrl = BASE_URL, signal = null, config = {}, extract = extractFromUrl } = {}) {
    const def = resolveExtractorDefinition(source.url);
    let sourcePlaylistIntel = null;
    if (isDirectHls(source.url)) {
        sourcePlaylistIntel = await probePlaylistIntelligence(http, source.url, {
            headers: headersFor(source.url, pageUrl),
            timeout: Number.parseInt(process.env.ALTADEFINIZIONE_PLAYLIST_TIMEOUT_MS || '5000', 10) || 5000,
            signal
        }).catch(() => null);
    }

    if (KRAKEN_FIRST) {
        const krakenStream = buildKrakenResolvedStream(source, def, { title, config, pageUrl, playlistIntel: sourcePlaylistIntel, via: 'kraken-first' });
        if (krakenStream) return krakenStream;
    }

    if (def) {
        const extracted = await extract(source.url, {
            client: http,
            userAgent: USER_AGENT,
            requestReferer: pageUrl,
            referer: pageUrl
        }).catch(() => null);

        if (!extracted?.url) {
            log('skip unresolved local hoster; trying kraken fallback', {
                extractor: source.extractor || def.label,
                host: (() => { try { return new URL(source.url).hostname; } catch (_) { return ''; } })()
            });
            const mediaflowFallback = buildMediaflowFallbackStream(source, def, { title, config, pageUrl });
            if (mediaflowFallback) return mediaflowFallback;
            if (!shouldExposeLazyFallback(source, def)) return null;
            return null;
        }

        let quality = pickBetterQuality(extracted.quality || 'Unknown', source.quality || 'Unknown');
        let playlistIntel = null;
        if (isDirectHls(extracted.url)) {
            playlistIntel = await probePlaylistIntelligence(http, extracted.url, {
                headers: extracted.headers || headersFor(extracted.url, source.url),
                timeout: Number.parseInt(process.env.ALTADEFINIZIONE_PLAYLIST_TIMEOUT_MS || '5000', 10) || 5000,
                signal
            }).catch(() => null);
            quality = pickBetterQuality(playlistIntel?.quality || 'Unknown', quality);
        }

        const languageLabel = getSourceLanguageLabel(source, playlistIntel);
        let stream = buildWebStream({
            name: `${PROVIDER_LABEL} | ${extracted.name || source.extractor || def.label}`,
            title: `${title}\n${extracted.name || source.extractor || def.label} ${languageLabel}`,
            url: extracted.url,
            extractor: extracted.name || source.extractor || def.label,
            provider: PROVIDER_LABEL,
            providerCode: PROVIDER_CODE,
            quality,
            headers: extracted.headers || headersFor(extracted.url, source.url),
            extraBehaviorHints: {
                vortexMeta: {
                    language: languageLabel,
                    audioLanguages: audioLanguagesForLabel(languageLabel),
                    via: 'local-extractor',
                    sourceUrl: source.url
                }
            },
            extra: { _priority: source.priority ?? extracted.priority ?? def.priority ?? 9, _italian: languageLabel === 'ITA' }
        });
        stream = decorateStreamWithPlaylistIntelligence(stream, playlistIntel);
        return stream;
    }

    let playlistIntel = sourcePlaylistIntel;
    if (!playlistIntel && isDirectHls(source.url)) {
        playlistIntel = await probePlaylistIntelligence(http, source.url, {
            headers: headersFor(source.url, pageUrl),
            timeout: Number.parseInt(process.env.ALTADEFINIZIONE_PLAYLIST_TIMEOUT_MS || '5000', 10) || 5000,
            signal
        }).catch(() => null);
    }

    const krakenDirect = buildKrakenResolvedStream(source, null, { title, config, pageUrl, playlistIntel, via: 'kraken-direct' });
    if (krakenDirect) return krakenDirect;

    const languageLabel = getSourceLanguageLabel(source, playlistIntel);
    let stream = buildWebStream({
        name: `${PROVIDER_LABEL} | ${source.extractor || 'Direct'}`,
        title: `${title}\n${source.extractor || 'Direct'} ${languageLabel}`,
        url: source.url,
        extractor: source.extractor || 'Direct',
        provider: PROVIDER_LABEL,
        providerCode: PROVIDER_CODE,
        quality: pickBetterQuality(playlistIntel?.quality || 'Unknown', source.quality || 'Unknown'),
        headers: headersFor(source.url, pageUrl),
        extraBehaviorHints: {
            vortexMeta: {
                language: languageLabel,
                audioLanguages: audioLanguagesForLabel(languageLabel),
                via: 'direct',
                sourceUrl: source.url
            }
        },
        extra: { _priority: source.priority ?? 80, _italian: languageLabel === 'ITA' }
    });
    stream = decorateStreamWithPlaylistIntelligence(stream, playlistIntel);
    return stream;
}

async function resolveMedia(meta = {}, finalId = null, config = {}) {
    const type = normalizeProviderType(meta.type || (meta.isSeries ? 'tv' : 'movie'));
    const season = parsePositiveInt(meta.season, meta.s, String(finalId || '').split(':')[1]) || 1;
    const episode = parsePositiveInt(meta.episode, meta.e, String(finalId || '').split(':')[2]) || 1;
    const explicitTmdbId = extractTmdbId(meta.tmdb_id || meta.tmdbId || meta.tmdb || (/^\d+$/.test(String(finalId || '')) ? finalId : ''));
    const imdbId = normalizeImdbId(meta.imdb_id || meta.imdbId || meta.imdb || meta.id || finalId);

    if (explicitTmdbId) {
        const info = await tmdbHelper.getMediaInfoFull(explicitTmdbId, type, {
            language: 'it-IT',
            userKey: config?.tmdbApiKey || config?.tmdbKey || null
        }).catch(() => null);
        const resolvedImdbId = normalizeImdbId(info?.imdbId || info?.imdb_id || imdbId)
            || await tmdbHelper.getImdbFromTmdb(explicitTmdbId, type, {
                userKey: config?.tmdbApiKey || config?.tmdbKey || null
            }).catch(() => null);
        return {
            tmdbId: explicitTmdbId,
            imdbId: normalizeImdbId(resolvedImdbId),
            type,
            season,
            episode,
            title: info?.title || info?.name || meta.title || meta.name || (type === 'movie' ? 'Film' : 'Serie')
        };
    }

    const resolved = await tmdbHelper.resolveFromMeta({ ...meta, id: finalId || meta.id }, {
        type,
        language: 'it-IT',
        userKey: config?.tmdbApiKey || config?.tmdbKey || null
    }).catch(() => null);

    if (!resolved?.tmdbId && !resolved?.tmdb_id) return null;
    return {
        tmdbId: String(resolved.tmdbId || resolved.tmdb_id),
        imdbId: normalizeImdbId(resolved.imdbId || resolved.imdb_id || imdbId),
        type,
        season,
        episode,
        title: resolved.title || resolved.name || meta.title || meta.name || (type === 'movie' ? 'Film' : 'Serie')
    };
}

function streamCacheKey(media = {}) {
    return `${media.type}:${media.tmdbId}:${media.season || 0}:${media.episode || 0}`;
}

async function searchAltadefinizioneImpl(originalId, finalId, meta = {}, config = {}, reqHost = null) {
    if (config?.filters && config.filters.enableCc !== true && config.filters.enableAltadefinizione !== true) return [];

    const media = await resolveMedia(meta, finalId || originalId, config);
    if (!media?.tmdbId) return [];

    const cacheKey = `streams:${streamCacheKey(media)}`;
    const cached = cache.streams.get(cacheKey);
    if (cached) return cached;

    const endpoint = buildPlayerSourcesEndpoint(media);
    if (!endpoint) return [];

    const payload = await fetchJson(endpoint).catch((error) => {
        log('player source fetch failed', { error: error?.message || String(error), endpoint });
        return null;
    });

    const apiSources = collectPlayableSources({ payload });
    const downloadSources = await collectDownloadSources(media).catch(() => []);
    const sources = Array.from(new Map([...apiSources, ...downloadSources]
        .sort((a, b) => (a.priority ?? 99) - (b.priority ?? 99))
        .map((source) => [source.url, source]))
        .values())
        .slice(0, MAX_SOURCES);

    if (!sources.length) {
        cache.streams.set(cacheKey, [], 60_000, 60_000);
        return [];
    }

    const displayTitle = media.type === 'movie'
        ? media.title
        : `${media.title} S${String(media.season).padStart(2, '0')}E${String(media.episode).padStart(2, '0')}`;
    const streams = (await Promise.all(sources.map((source) => resolveSourceToStream(source, {
        title: displayTitle,
        reqHost,
        pageUrl: endpoint,
        config
    }).catch(() => null))))
        .filter(Boolean)
        .sort((a, b) =>
            (languageSortRank(a) - languageSortRank(b))
            || ((a._priority ?? 99) - (b._priority ?? 99))
            || (qualityRank(b.quality) - qualityRank(a.quality))
        );

    const normalized = normalizeStreams(dedupeStreamsByUrl(streams).map((stream) => {
        delete stream._priority;
        delete stream._italian;
        return stream;
    }), {
        provider: PROVIDER_ID,
        providerLabel: PROVIDER_LABEL,
        providerCode: PROVIDER_CODE,
        sort: false,
        debug: DEBUG
    });

    cache.streams.set(cacheKey, normalized, normalized.length ? STREAM_TTL_MS : 60_000, normalized.length ? STREAM_TTL_MS : 60_000);
    return normalized;
}

async function searchAltadefinizione(originalId, finalId, meta = {}, config = {}, reqHost = null) {
    return withProviderHealth(PROVIDER_ID, () => searchAltadefinizioneImpl(originalId, finalId, meta, config, reqHost), {
        timeoutMs: Math.max(15_000, TIMEOUT_MS + 5000),
        swallowErrors: true,
        fallbackValue: []
    });
}

module.exports = {
    searchAltadefinizione,
    searchAltadefinizioneStreaming: searchAltadefinizione,
    __private: {
        buildKrakenResolvedStream,
        buildPlayerSourcesEndpoint,
        collectPlayableSources,
        normalizeImdbId,
        resolveDownloadToHoster,
        resolveSourceToStream,
        audioLanguagesForLabel,
        getSourceLanguageLabel,
        resolveMedia,
        shouldExposeLazyFallback,
        sourceExtractorLabel
    }
};
