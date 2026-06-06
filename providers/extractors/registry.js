'use strict';

const {
    extractDeltabit,
    extractDropload,
    extractDoodstream,
    extractLoadm,
    extractMixdrop,
    extractMaxstream,
    extractStreamtape,
    extractSupervideo,
    extractUpstream,
    extractUprot,
    extractUqload,
    extractVidoza,
    extractVixcloud,
    extractVidxgo,
    isDeltabitUrl,
    isDroploadUrl,
    isDoodstreamUrl,
    isLoadmUrl,
    isMixdropUrl,
    isMaxstreamUrl,
    isStreamtapeUrl,
    isSupervideoUrl,
    isUpstreamUrl,
    isUprotUrl,
    isUqloadUrl,
    isVidozaUrl,
    isVixcloudUrl,
    isVidxgoUrl,
    extractStreamhg,
    isStreamhgUrl,
    extractTurbovid,
    isTurbovidUrl,
    extractVoe,
    isVoeUrl,
    extractVidguard,
    isVidguardUrl
} = require('./hosters');
const { isBridgeResolverCandidate, resolveBridgeUrl } = require('./bridge_resolver');

const HOSTER_DIRECT_LINK_PATTERN = String.raw`https?:\/\/(?:www\.)?(?:supervideo|vixcloud|(?:v\.)?vidxgo|dropload|dr0pstream|dood(?:stream)?\.(?:com|to|watch|so|pm|wf|sh|la|ws|re|yt)|ds2play\.com|doodcdn\.(?:com|co)|d0o0d\.(?:com|to|watch|so|pm|wf|sh|la|ws|re|yt)|mixdrop|mixdrp|m1xdrop|miiixdrop|mxdrop|mxcontent|md[3bfyz][a-z0-9]*|loadm(?:\.cam)?|deltabit|safego|clicka|uprot\.net|maxstream\.video|stayonline\.pro|maxstream|upstream|uqload|streamtape|vidoza|dhcplay|vibuxer|turbovid\.me|turboviplay\.com|emturbovid\.com|tuborstb\.co|javggvideo\.xyz|stbturbo\.xyz|turbovidhls\.com|voe\.sx|voe\.to|voe-unblock\.com|v-o-e-unblock\.com|listeamed\.net|vidguard[^/\s"'<>]*)[^"'<\s]+`;
const HOSTER_ESCAPED_DIRECT_LINK_PATTERN = String.raw`https?:\\\/\\\/(?:www\\.)?(?:supervideo|vixcloud|(?:v\.)?vidxgo|dropload|dr0pstream|dood(?:stream)?\.(?:com|to|watch|so|pm|wf|sh|la|ws|re|yt)|ds2play\.com|doodcdn\.(?:com|co)|d0o0d\.(?:com|to|watch|so|pm|wf|sh|la|ws|re|yt)|mixdrop|mixdrp|m1xdrop|miiixdrop|mxdrop|mxcontent|md[3bfyz][a-z0-9]*|loadm(?:\\.cam)?|deltabit|safego|clicka|uprot\\.net|maxstream\\.video|stayonline\\.pro|maxstream|upstream|uqload|streamtape|vidoza|dhcplay|vibuxer|turbovid\.me|turboviplay\.com|emturbovid\.com|tuborstb\.co|javggvideo\.xyz|stbturbo\.xyz|turbovidhls\.com|voe\.sx|voe\.to|voe-unblock\.com|v-o-e-unblock\.com|listeamed\.net|vidguard[^/\s"'<>]*)[^"'<\s]+`;

const HOSTER_DEFINITIONS = [
    {
        key: 'supervideo',
        label: 'SuperVideo',
        matches: isSupervideoUrl,
        extract: extractSupervideo,
        priority: 0
    },
    {
        key: 'maxstream',
        label: 'MaxStream',
        matches: isMaxstreamUrl,
        extract: extractMaxstream,
        priority: 0
    },
    {
        key: 'uprot',
        label: 'Uprot',
        matches: isUprotUrl,
        extract: extractUprot,
        priority: 0
    },
    {
        key: 'vidxgo',
        label: 'VidxGo',
        matches: isVidxgoUrl,
        extract: extractVidxgo,
        priority: 0
    },
    {
        key: 'streamhg',
        label: 'StreamHG',
        matches: isStreamhgUrl,
        extract: extractStreamhg,
        priority: 1,
        noLazy: true
    },
    {
        key: 'turbovid',
        label: 'TurboVid',
        matches: isTurbovidUrl,
        extract: extractTurbovid,
        priority: 3
    },
    {
        key: 'deltabit',
        label: 'DeltaBit',
        matches: isDeltabitUrl,
        extract: extractDeltabit,
        priority: 1
    },
    {
        key: 'vixcloud',
        label: 'VixCloud',
        matches: isVixcloudUrl,
        extract: extractVixcloud,
        priority: 1
    },
    {
        key: 'dropload',
        label: 'DropLoad',
        matches: isDroploadUrl,
        extract: extractDropload,
        priority: 2,
        noLazy: true
    },
    {
        key: 'doodstream',
        label: 'DoodStream',
        matches: isDoodstreamUrl,
        aliases: [
            'doodstream.com',
            'dood.to',
            'dood.watch',
            'dood.la',
            'dood.ws',
            'dood.pm',
            'ds2play.com',
            'doodcdn.com'
        ],
        serverNames: ['doodstream', 'dood'],
        extract: extractDoodstream,
        priority: 3
    },
    {
        key: 'voe',
        label: 'VOE',
        matches: isVoeUrl,
        aliases: [
            'voe.sx',
            'voe.to',
            'voe-unblock.com',
            'v-o-e-unblock.com',
            'smoki.cc',
            'kinoger.ru'
        ],
        serverNames: ['voe', 'voesx', 'v-o-e'],
        extract: extractVoe,
        priority: 2
    },
    {
        key: 'vidguard',
        label: 'VidGuard',
        matches: isVidguardUrl,
        aliases: [
            'listeamed.net',
            'vidguard.to',
            'vidguard.net',
            'vidguard.pro',
            'vgfplay.com',
            'vgembed.com'
        ],
        serverNames: ['vidguard', 'listeamed'],
        extract: extractVidguard,
        priority: 2
    },
    {
        key: 'mixdrop',
        label: 'MixDrop',
        matches: isMixdropUrl,
        aliases: [
            'mixdrop.co',
            'mixdrop.bz',
            'mixdrop.ag',
            'mixdrop.ch',
            'mixdrop.to',
            'mixdrop.cv',
            'mixdrop.club',
            'mxdrop.to',
            'm1xdrop.net',
            'miiixdrop.net',
            'mxcontent.net'
        ],
        rotatingDomains: [/^md[3bfyz][a-z0-9]*\.[a-z0-9.-]+$/i],
        serverNames: ['mixdrop', 'mixdrp', 'm1xdrop', 'miiixdrop', 'mxdrop'],
        extract: extractMixdrop,
        priority: 3
    },
    {
        key: 'loadm',
        label: 'LoadM',
        matches: isLoadmUrl,
        extract: extractLoadm,
        priority: 4
    },
    {
        key: 'upstream',
        label: 'Upstream',
        matches: isUpstreamUrl,
        extract: extractUpstream,
        priority: 5
    },
    {
        key: 'uqload',
        label: 'Uqload',
        matches: isUqloadUrl,
        extract: extractUqload,
        priority: 6
    },
    {
        key: 'streamtape',
        label: 'StreamTape',
        matches: isStreamtapeUrl,
        extract: extractStreamtape,
        priority: 7
    },
    {
        key: 'vidoza',
        label: 'Vidoza',
        matches: isVidozaUrl,
        extract: extractVidoza,
        priority: 8
    }
];

const SORTED_HOSTER_DEFINITIONS = HOSTER_DEFINITIONS
    .map((definition, index) => ({ ...definition, order: index }))
    .sort((a, b) => {
        const byPriority = Number(a.priority || 0) - Number(b.priority || 0);
        if (byPriority !== 0) return byPriority;
        return a.order - b.order;
    });

function decodeHtmlEntities(value) {
    return String(value || '')
        .replace(/&amp;/gi, '&')
        .replace(/&#38;/g, '&')
        .replace(/&#038;/g, '&')
        .replace(/&quot;/gi, '"')
        .replace(/&#34;/g, '"')
        .replace(/&#034;/g, '"')
        .replace(/&apos;/gi, "'")
        .replace(/&#39;/g, "'")
        .replace(/&#039;/g, "'")
        .replace(/&lt;/gi, '<')
        .replace(/&gt;/gi, '>');
}

function decodeCommonEscapes(value) {
    return String(value || '')
        .replace(/\\u0026/gi, '&')
        .replace(/\\u003d/gi, '=')
        .replace(/\\u003f/gi, '?')
        .replace(/\\u002f/gi, '/')
        .replace(/\\u003a/gi, ':')
        .replace(/\\u002e/gi, '.')
        .replace(/\\x26/gi, '&')
        .replace(/\\x3d/gi, '=')
        .replace(/\\x3f/gi, '?')
        .replace(/\\x2f/gi, '/')
        .replace(/\\x3a/gi, ':')
        .replace(/\\x2e/gi, '.')
        .replace(/\\\//g, '/');
}

function safeDecodeUri(value) {
    const input = String(value || '');
    try {
        const decoded = decodeURI(input);
        if (decoded && decoded !== input) return decoded;
    } catch (_) {
        return input;
    }
    return input;
}

function cleanUrlBoundary(value) {
    return String(value || '')
        .trim()
        .replace(/^[`"'([{<]+/g, '')
        .replace(/[`"'\])}>;,]+$/g, '');
}

function normalizeHosterUrl(value) {
    let normalized = cleanUrlBoundary(value);
    normalized = decodeHtmlEntities(normalized);
    normalized = decodeCommonEscapes(normalized);
    normalized = safeDecodeUri(normalized);
    normalized = cleanUrlBoundary(normalized);

    if (normalized.startsWith('//')) {
        normalized = `https:${normalized}`;
    }

    return normalized;
}

function uniqueValues(values) {
    return [...new Set(values.filter(Boolean))];
}

function buildUrlCandidates(url) {
    const raw = String(url || '').trim();
    const normalized = normalizeHosterUrl(raw);
    const decodedRaw = safeDecodeUri(raw);
    const decodedNormalized = safeDecodeUri(normalized);

    return uniqueValues([
        raw,
        normalized,
        decodedRaw,
        decodedNormalized,
        normalizeHosterUrl(decodedRaw),
        normalizeHosterUrl(decodedNormalized)
    ]);
}

function getUrlHost(value) {
    try {
        return new URL(normalizeHosterUrl(value)).hostname.toLowerCase().replace(/^www\./i, '');
    } catch (_) {
        return '';
    }
}

function normalizeAliasHost(value) {
    const raw = String(value || '').trim().toLowerCase().replace(/^www\./i, '');
    if (!raw) return '';
    try {
        return new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`).hostname.toLowerCase().replace(/^www\./i, '');
    } catch (_) {
        return raw.replace(/^https?:\/\//i, '').split('/')[0].replace(/^www\./i, '');
    }
}

function hostMatchesAlias(host, alias) {
    const candidate = String(host || '').toLowerCase().replace(/^www\./i, '');
    const wanted = normalizeAliasHost(alias);
    return Boolean(candidate && wanted && (candidate === wanted || candidate.endsWith(`.${wanted}`)));
}

function serverNameMatches(definition, candidate) {
    const text = String(candidate || '').toLowerCase();
    const host = getUrlHost(candidate);
    return (definition.serverNames || []).some((name) => {
        const needle = String(name || '').toLowerCase();
        return needle && (host.includes(needle) || text.includes(needle));
    });
}

function definitionMatchesCandidate(definition, candidate) {
    try {
        if (definition.matches(candidate)) return true;
    } catch (_) {}

    const host = getUrlHost(candidate);
    if (host && (definition.aliases || []).some((alias) => hostMatchesAlias(host, alias))) return true;
    if (host && (definition.rotatingDomains || []).some((pattern) => pattern.test(host))) return true;
    return serverNameMatches(definition, candidate);
}

function isDirectMediaUrl(value) {
    return /^https?:\/\//i.test(String(value || '')) && /(?:\.m3u8|\.mp4|\/hls\/|\/playlist\/|\/master\.m3u8)(?:$|[?#/])/i.test(String(value || ''));
}

function isValidExtractedUrl(value) {
    const url = normalizeHosterUrl(value);
    return /^https?:\/\//i.test(url);
}

function getExtractedUrl(extracted) {
    if (typeof extracted === 'string') return extracted;
    if (!extracted || typeof extracted !== 'object') return null;

    return extracted.url
        || extracted.file
        || extracted.src
        || extracted.hls
        || extracted.stream
        || extracted.streamUrl
        || extracted.video
        || extracted.videoUrl
        || null;
}

function normalizeExtractedResult(extracted) {
    const url = getExtractedUrl(extracted);
    if (!url || !isValidExtractedUrl(url)) return null;

    if (typeof extracted === 'string') {
        return { url: normalizeHosterUrl(url) };
    }

    return {
        ...extracted,
        url: normalizeHosterUrl(url)
    };
}

function resolveExtractorEntry(url) {
    const candidates = buildUrlCandidates(url);

    for (const candidate of candidates) {
        for (const definition of SORTED_HOSTER_DEFINITIONS) {
            if (definitionMatchesCandidate(definition, candidate)) {
                return {
                    definition,
                    url: candidate
                };
            }
        }
    }

    return null;
}

function resolveExtractorDefinition(url) {
    return resolveExtractorEntry(url)?.definition || null;
}

function getExtractorDefinitionByKey(key) {
    const normalizedKey = String(key || '').trim().toLowerCase();
    if (!normalizedKey) return null;

    return HOSTER_DEFINITIONS.find((definition) => definition.key === normalizedKey) || null;
}

function listSupportedHosters() {
    return HOSTER_DEFINITIONS.map((definition) => ({
        key: definition.key,
        label: definition.label,
        priority: definition.priority
    }));
}

async function extractFromUrl(url, options = {}) {
    let entry = resolveExtractorEntry(url);
    let bridgedUrl = null;

    if (!entry && options.bridgeResolver !== false && isBridgeResolverCandidate(url)) {
        bridgedUrl = await resolveBridgeUrl(url, options);
        if (bridgedUrl) entry = resolveExtractorEntry(bridgedUrl);
        if (!entry && isDirectMediaUrl(bridgedUrl)) {
            return {
                url: normalizeHosterUrl(bridgedUrl),
                key: 'bridge',
                extractor: 'Bridge',
                name: 'Bridge',
                priority: 9,
                bridgeSourceUrl: normalizeHosterUrl(url)
            };
        }
    }

    if (!entry) return null;

    const { definition, url: normalizedUrl } = entry;

    try {
        const extracted = await definition.extract(normalizedUrl, options);
        const normalized = normalizeExtractedResult(extracted);
        if (!normalized?.url) return null;

        return {
            ...normalized,
            key: definition.key,
            extractor: normalized.extractor || definition.label,
            name: normalized.name || definition.label,
            priority: normalized.priority ?? definition.priority,
            ...(bridgedUrl ? { bridgeSourceUrl: normalizeHosterUrl(url) } : {})
        };
    } catch (error) {
        if (options.throwOnExtractorError || options.throwOnError) {
            throw error;
        }

        const logger = options.logger || options.log;
        if (logger?.warn) {
            logger.warn(`[ExtractorRegistry] ${definition.label} failed: ${error.message || error}`);
        }

        return null;
    }
}

module.exports = {
    HOSTER_DEFINITIONS,
    HOSTER_DIRECT_LINK_PATTERN,
    HOSTER_ESCAPED_DIRECT_LINK_PATTERN,
    resolveExtractorDefinition,
    getExtractorDefinitionByKey,
    listSupportedHosters,
    isBridgeResolverCandidate,
    extractFromUrl
};
