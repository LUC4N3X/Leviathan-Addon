const path = require('path');
const axios = require('axios');
const cheerio = require('cheerio');
const https = require('https');
const tmdbHelper = require('../../core/utils/tmdb_helper');
const {
    buildMediaflowUrl,
    buildWebStream,
    extractSizeText,
    normalizeQuality,
    pickBetterQuality,
    probePlaylistQuality,
    qualityRank
} = require('../extractors/common');
const {
    extractFromUrl,
    HOSTER_DIRECT_LINK_PATTERN,
    resolveExtractorDefinition
} = require('../extractors/registry');
const {
    CircuitBreaker,
    PersistentJsonCache,
    resilientCall
} = require('../extractors/resilience');

const CONFIG = {
    CACHE: {
        FILE: path.join(__dirname, '..', 'config', 'guardahd_cache.json'),
        TTL: 43200000,
        STALE_TTL: 86400000,
        MAX_ENTRIES: 512,
        SAVE_DEBOUNCE_MS: 1200
    },
    SCRAPER: {
        MAX_CONCURRENT_EMBEDS: 15,
        TIMEOUT: 15000,
        BASE_URL: 'https://guardahd.stream',
        RETRIES: 2
    }
};

const getRandomUserAgent = () => {
    const uas = [
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:123.0) Gecko/20100101 Firefox/123.0',
        'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    ];
    return uas[Math.floor(Math.random() * uas.length)];
};

const httpsAgent = new https.Agent({
    rejectUnauthorized: false,
    keepAlive: true,
    maxSockets: 100,
    maxFreeSockets: 20,
    timeout: 30000
});

const httpClient = axios.create({
    timeout: CONFIG.SCRAPER.TIMEOUT,
    httpsAgent,
    validateStatus: (status) => status >= 200 && status < 400
});

const RETRYABLE_STATUSES = new Set([403, 408, 425, 429, 500, 502, 503, 504]);
const requestBreaker = new CircuitBreaker({
    failureThreshold: 4,
    recoveryTimeoutMs: 20000,
    halfOpenMaxCalls: 1
});

function getRequestDomain(url) {
    try {
        return new URL(url).hostname.toLowerCase();
    } catch (_) {
        return 'guardahd';
    }
}

async function fetchSmart(url, options = {}) {
    const requestConfig = {
        url,
        method: 'GET',
        headers: {
            'User-Agent': getRandomUserAgent(),
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
            'Referer': CONFIG.SCRAPER.BASE_URL,
            ...options.headers
        },
        ...options
    };

    return requestBreaker.run(getRequestDomain(url), async () => resilientCall(
        async () => httpClient(requestConfig),
        {
            attempts: Math.max(1, CONFIG.SCRAPER.RETRIES + 1),
            shouldRetry: ({ error, status }) => (
                status != null
                    ? RETRYABLE_STATUSES.has(Number(status))
                    : Boolean(error)
            )
        }
    ));
}

const REGEX = {
    Q_4K: /4k|2160p|uhd/i,
    Q_1080: /1080p|fullhd|fhd/i,
    Q_720: /720p|hd/i,
    Q_480: /480p|sd/i
};

class AsyncSemaphore {
    #max; #active; #queue;
    constructor(max) { this.#max = max; this.#active = 0; this.#queue = []; }
    async acquire() {
        if (this.#active < this.#max) { this.#active++; return; }
        return new Promise(resolve => this.#queue.push(resolve));
    }
    release() {
        this.#active--;
        if (this.#queue.length > 0) { this.#active++; this.#queue.shift()(); }
    }
}
const embedSemaphore = new AsyncSemaphore(CONFIG.SCRAPER.MAX_CONCURRENT_EMBEDS);

const normalizeUrl = (url) => {
    const normalized = String(url || '')
        .trim()
        .replace(/&amp;/g, '&')
        .replace(/\\u002F/gi, '/')
        .replace(/\\u0026/gi, '&')
        .replace(/\\\//g, '/');
    return normalized.startsWith('//') ? `https:${normalized}` : normalized;
};
const parseQuality = (text) => {
    if (!text) return "Unknown";
    if (REGEX.Q_4K.test(text)) return "4K";
    if (REGEX.Q_1080.test(text)) return "1080p";
    if (REGEX.Q_720.test(text)) return "720p";
    if (REGEX.Q_480.test(text)) return "480p";
    return "Unknown";
};

const generateRichDescription = (title, quality = 'Unknown', size = 'N/A', hoster = '') => {
    const sizeTag = size !== 'N/A' ? `💾 ${size} • ` : '';
    const hosterTag = hoster ? ` [${hoster}]` : '';
    return `🎬 ${title}${hosterTag}\n${sizeTag}📺 ${quality} • 🇮🇹 ITA\n⚡ GuardaHD`;
};

const cacheManager = new PersistentJsonCache({
    file: CONFIG.CACHE.FILE,
    ttlMs: CONFIG.CACHE.TTL,
    staleTtlMs: CONFIG.CACHE.STALE_TTL - CONFIG.CACHE.TTL,
    maxEntries: CONFIG.CACHE.MAX_ENTRIES,
    saveDebounceMs: CONFIG.CACHE.SAVE_DEBOUNCE_MS
});

const directLinkRegex = new RegExp(HOSTER_DIRECT_LINK_PATTERN, 'ig');

async function resolveStreamQuality(streamUrl, headers, fallback = 'Unknown') {
    const baseQuality = normalizeQuality(fallback);
    if (!/\.m3u8($|\?)/i.test(String(streamUrl || ''))) return baseQuality;

    try {
        const probed = await probePlaylistQuality(httpClient, streamUrl, {
            headers: headers || {},
            timeout: 6000
        });
        return pickBetterQuality(probed || 'Unknown', baseQuality);
    } catch (_) {
        return baseQuality;
    }
}


async function fetchTmdbMovieByImdb(imdbId) {
    const meta = await tmdbHelper.getTmdbMetaFromImdb(imdbId, { mediaHint: 'movie', language: 'it-IT' }).catch(() => null);
    if (!meta?.tmdb_id) return null;
    return {
        id: meta.tmdb_id,
        title: meta.title,
        original_title: meta.original_title,
        release_date: meta.date || (meta.year ? `${meta.year}-01-01` : '')
    };
}

async function fetchTmdbMovieById(tmdbId) {
    const clean = String(tmdbId || '').trim();
    if (!/^\d+$/.test(clean)) return null;
    return tmdbHelper.fetchTmdbJson(`/movie/${encodeURIComponent(clean)}`, {
        params: { language: 'it-IT' },
        cacheTtlMs: 30 * 60 * 1000
    }).catch(() => null);
}

async function fetchMovieImdbIdFromTmdb(tmdbId) {
    return tmdbHelper.getImdbFromTmdb(tmdbId, 'movie').catch(() => null);
}

function resolveTmdbMovieId(meta) {
    const direct = String(meta?.tmdb_id || meta?.tmdbId || '').trim();
    if (/^\d+$/.test(direct)) return direct;
    const metaId = String(meta?.id || '').trim();
    const match = metaId.match(/^tmdb:(\d+)/i);
    return match ? match[1] : null;
}

async function resolveMovieIdentity(meta) {
    if (!meta || meta.isSeries) return null;

    const explicitImdb = /^tt\d+$/i.test(String(meta?.imdb_id || '').trim()) ? String(meta.imdb_id).trim() : null;
    const explicitTmdb = resolveTmdbMovieId(meta);

    if (explicitImdb) {
        const tmdbMovie = await fetchTmdbMovieByImdb(explicitImdb);
        return {
            imdbId: explicitImdb,
            tmdbId: tmdbMovie?.id ? String(tmdbMovie.id) : explicitTmdb,
            title: tmdbMovie?.title ? (tmdbMovie.release_date ? `${tmdbMovie.title} (${String(tmdbMovie.release_date).slice(0, 4)})` : tmdbMovie.title) : (meta?.title || 'Film HD'),
            cacheKey: `imdb:${explicitImdb}`
        };
    }

    if (explicitTmdb) {
        const [tmdbMovie, imdbId] = await Promise.all([
            fetchTmdbMovieById(explicitTmdb),
            fetchMovieImdbIdFromTmdb(explicitTmdb)
        ]);
        if (!imdbId) return null;
        return {
            imdbId,
            tmdbId: explicitTmdb,
            title: tmdbMovie?.title ? (tmdbMovie.release_date ? `${tmdbMovie.title} (${String(tmdbMovie.release_date).slice(0, 4)})` : tmdbMovie.title) : (meta?.title || 'Film HD'),
            cacheKey: `tmdb:${explicitTmdb}`
        };
    }

    return null;
}

class GuardaHDScraper {
    #config;

    constructor(config) { this.#config = config; }

    async #getTmdbTitle(identity) {
        return identity?.title || 'Film HD';
    }

    async #scrapeEmbedUrls(imdbId) {
        if (!/^tt\d+$/i.test(String(imdbId || '').trim())) return [];
        try {
            const res = await fetchSmart(`${CONFIG.SCRAPER.BASE_URL}/set-movie-a/${imdbId}`);
            const $ = cheerio.load(res.data);
            const embedDict = new Map();

            const registerLink = (rawLink) => {
                const link = normalizeUrl(String(rawLink || '').replace(/&amp;/g, '&'));
                if (!/^https?:/i.test(link)) return;
                const definition = resolveExtractorDefinition(link);
                if (!definition) return;
                if (!embedDict.has(definition.key)) embedDict.set(definition.key, link);
            };

            $('li[data-link]').each((_, el) => registerLink($(el).attr('data-link')));
            $('iframe[src]').each((_, el) => registerLink($(el).attr('src')));
            $('a[href], source[src]').each((_, el) => registerLink($(el).attr('href') || $(el).attr('src')));

            const directMatches = String(res.data || '').match(directLinkRegex) || [];
            directMatches.forEach(registerLink);

            return Array.from(embedDict.values());
        } catch {
            return [];
        }
    }

    async #processSingleEmbed(url, title) {
        await embedSemaphore.acquire();
        try {
            const normalizedUrl = normalizeUrl(String(url || '').replace(/&amp;/g, '&'));
            const definition = resolveExtractorDefinition(normalizedUrl);

            if (definition?.key === 'mixdrop' && this.#config?.mediaflow?.url) {
                const embedUrl = normalizedUrl.replace('/f/', '/e/');
                let quality = 'Unknown';
                let size = 'N/A';

                try {
                    const response = await fetchSmart(embedUrl.replace('/e/', '/f/'), {
                        headers: {
                            Referer: `${new URL(embedUrl).origin}/`
                        }
                    });
                    const fileHtml = typeof response?.data === 'string' ? response.data : '';
                    if (fileHtml) {
                        quality = parseQuality(fileHtml);
                        size = extractSizeText(fileHtml);
                    }
                } catch {}

                const mediaflowUrl = buildMediaflowUrl(this.#config, embedUrl, 'extractor', 'Mixdrop');
                if (!mediaflowUrl) return [];

                return [
                    buildWebStream({
                        name: '🦁 GHD\n⚡ MixDrop',
                        title: generateRichDescription(title, quality, size, 'MixDrop'),
                        url: mediaflowUrl,
                        extractor: 'MixDrop',
                        provider: 'GuardaHD',
                        providerCode: 'GHD',
                        quality,
                        headers: null,
                        extraBehaviorHints: {
                            bingeWatching: true
                        },
                        extra: {
                            _priority: definition.priority ?? 3
                        }
                    })
                ];
            }

            const extracted = await extractFromUrl(url, {
                client: httpClient,
                userAgent: getRandomUserAgent(),
                requestReferer: CONFIG.SCRAPER.BASE_URL,
                referer: CONFIG.SCRAPER.BASE_URL
            });
            if (!extracted?.url) return [];

            const playbackHeaders = extracted.headers || null;
            const quality = await resolveStreamQuality(
                extracted.url,
                playbackHeaders,
                parseQuality(`${extracted.quality || ''} ${url}`)
            );
            return [
                buildWebStream({
                    name: `🦁 GHD\n⚡ ${extracted.name}`,
                    title: generateRichDescription(title, quality, extracted.size || 'N/A', extracted.name),
                    url: extracted.url,
                    extractor: extracted.name,
                    provider: 'GuardaHD',
                    providerCode: 'GHD',
                    quality,
                    headers: extracted.headers,
                    extraBehaviorHints: {
                        bingeWatching: true
                    },
                    extra: {
                        _priority: extracted.priority ?? 9
                    }
                })
            ];
        } catch {
            return [];
        } finally {
            embedSemaphore.release();
        }
    }

    async getStreams(meta) {
        if (!meta || meta.isSeries) return [];

        const identity = await resolveMovieIdentity(meta);
        if (!identity?.imdbId) return [];

        let embedUrls = [];
        let officialTitle = meta?.title || identity.title || 'Film HD';
        const cacheKey = identity.cacheKey || `imdb:${identity.imdbId}`;

        const { data: cached, isStale } = await cacheManager.get(cacheKey);

            if (cached) {
            embedUrls = Array.isArray(cached.embeds) ? cached.embeds : [];
            officialTitle = cached.title || officialTitle;

            if (isStale) {
                Promise.all([this.#scrapeEmbedUrls(identity.imdbId), this.#getTmdbTitle(identity)])
                    .then(([urls, title]) => {
                        if (urls.length > 0) cacheManager.set(cacheKey, { embeds: urls, title });
                    })
                    .catch(() => {});
            }
        } else {
            [embedUrls, officialTitle] = await Promise.all([
                this.#scrapeEmbedUrls(identity.imdbId),
                this.#getTmdbTitle(identity)
            ]);
            if (embedUrls.length > 0) await cacheManager.set(cacheKey, { embeds: embedUrls, title: officialTitle });
        }

        if (embedUrls.length === 0) return [];

        const rawStreams = (await Promise.allSettled(embedUrls.map((url) => this.#processSingleEmbed(url, officialTitle))))
            .filter((res) => res.status === 'fulfilled')
            .flatMap((res) => res.value);

        return Array.from(new Map(rawStreams.map((stream) => [stream.url, stream])).values())
            .sort((a, b) => {
                const qualityDelta = qualityRank(b.quality) - qualityRank(a.quality);
                if (qualityDelta !== 0) return qualityDelta;
                return (a._priority ?? 9) - (b._priority ?? 9);
            })
            .map(({ _priority, ...stream }) => stream);
    }
}

async function searchGuardaHD(meta, config) {
    return new GuardaHDScraper(config).getStreams(meta);
}

module.exports = { searchGuardaHD };
