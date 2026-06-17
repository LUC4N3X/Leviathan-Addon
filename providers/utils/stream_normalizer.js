'use strict';

const { prepareProxyTarget } = require('../../core/lib/proxy_header_normalizer');

const QUALITY_RANK = Object.freeze({
    Unknown: 0,
    '240p': 240,
    '360p': 360,
    '480p': 480,
    '576p': 576,
    '720p': 720,
    '1080p': 1080,
    '1440p': 1440,
    '4K': 2160
});

const VOLATILE_QUERY_RE = /^(?:token|expires|expire|e|t|sig|signature|hash|h|md5|auth|key|session|download_token|access_token)$/i;

const PROVIDER_ICON = Object.freeze({
    ghd: '🦁',
    guardahd: '🦁',
    'guarda hd': '🦁',
    gf: '🎬',
    guardaflix: '🎬',
    cc: '🎞️',
    ads: '🎞️',
    altadefinizione: '🎞️',
    altadefinizionestreaming: '🎞️',
    gs: '📺',
    guardoserie: '📺',
    'guardo serie': '📺',
    au: '🌀',
    animeunity: '🌀',
    as: '🪐',
    animesaturn: '🪐'
});

const LANGUAGE_LABEL = Object.freeze({
    ita: 'ITA',
    eng: 'ENG',
    jpn: 'JPN',
    fre: 'FRA',
    fra: 'FRA',
    spa: 'SPA',
    ger: 'DEU',
    deu: 'DEU',
    por: 'POR',
    rus: 'RUS',
    kor: 'KOR',
    chi: 'CHI',
    zho: 'CHI'
});

function firstNonEmpty(...values) {
    for (const value of values) {
        const clean = String(value ?? '').trim();
        if (clean) return clean;
    }
    return '';
}

function compactLine(value) {
    return String(value ?? '')
        .replace(/\r/g, '\n')
        .split('\n')
        .map((line) => line.replace(/\s+/g, ' ').trim())
        .find(Boolean) || '';
}

function humanizeProviderName(value) {
    const clean = String(value || '').trim();
    if (!clean) return 'Provider';
    const compact = clean.toLowerCase().replace(/[^a-z0-9]+/g, '');
    if (compact === 'guardahd') return 'GuardaHD';
    if (compact === 'guardaflix') return 'GuardaFlix';
    if (compact === 'altadefinizione' || compact === 'altadefinizionestreaming') return 'AltadefinizioneStreaming';
    if (compact === 'guardoserie') return 'GuardoSerie';
    if (compact === 'animeunity') return 'AnimeUnity';
    if (compact === 'animesaturn') return 'AnimeSaturn';
    return clean;
}

function providerIconFor(value) {
    const raw = String(value || '').trim().toLowerCase();
    const key = raw.replace(/[^a-z0-9]+/g, '');
    return PROVIDER_ICON[raw] || PROVIDER_ICON[key] || '🐉';
}

function cleanLabel(value, fallback = '') {
    const clean = String(value || '')
        .replace(/[\r\n]+/g, ' ')
        .replace(/\s+/g, ' ')
        .replace(/[|•]+$/g, '')
        .trim();
    return clean || fallback;
}

function extractSizeLabel(...values) {
    const text = values.map((value) => String(value || '')).join(' ');
    const match = text.match(/(?:^|\s)(\d+(?:[.,]\d+)?\s?(?:KB|MB|GB|TB))(?:\s|$)/i);
    return match?.[1]?.replace(/\s+/g, '').replace(',', '.').toUpperCase() || '';
}

function parseSizeToBytes(value) {
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) return Math.round(value);
    const text = String(value || '').trim();
    if (!text) return 0;
    const match = text.match(/(\d+(?:[.,]\d+)?)\s*(B|KB|MB|GB|TB)/i);
    if (!match) return 0;
    const amount = Number(String(match[1]).replace(',', '.'));
    if (!Number.isFinite(amount) || amount <= 0) return 0;
    const unit = String(match[2] || '').toUpperCase();
    const factor = unit === 'TB' ? 1024 ** 4
        : unit === 'GB' ? 1024 ** 3
            : unit === 'MB' ? 1024 ** 2
                : unit === 'KB' ? 1024
                    : 1;
    return Math.round(amount * factor);
}

function inferAudioCodec(...values) {
    const text = values.map((value) => String(value || '')).join(' ').toUpperCase();
    if (/TRUEHD/.test(text)) return 'TrueHD';
    if (/DTS[-\s]?HD\s?MA/.test(text)) return 'DTS-HD MA';
    if (/DTS[-\s]?HD/.test(text)) return 'DTS-HD';
    if (/DTS:X|DTSX/.test(text)) return 'DTS:X';
    if (/\bDTS\b/.test(text)) return 'DTS';
    if (/ATMOS/.test(text) && /DDP|E[-\s]?AC3|DD\+/.test(text)) return 'Atmos DDP';
    if (/DDP|E[-\s]?AC3|DD\+|DOLBY\s*DIGITAL\s*PLUS/.test(text)) return 'DDP';
    if (/AC[-\s]?3|DOLBY\s*DIGITAL/.test(text)) return 'AC3';
    if (/AAC/.test(text)) return 'AAC';
    if (/OPUS/.test(text)) return 'OPUS';
    if (/FLAC/.test(text)) return 'FLAC';
    if (/MP3/.test(text)) return 'MP3';
    return '';
}

function inferAudioChannels(...values) {
    const text = values.map((value) => String(value || '')).join(' ');
    const match = text.match(/\b([1-7][ .][01])\b/i);
    return match?.[1]?.replace(' ', '.') || '';
}

function inferLanguagesFromText(...values) {
    const text = values.map((value) => String(value || '')).join(' ').toLowerCase();
    const langs = [];
    const push = (lang) => { if (!langs.includes(lang)) langs.push(lang); };
    if (/\b(?:ita|it|italiano|italian)\b/i.test(text)) push('ita');
    if (/\b(?:eng|en|inglese|english)\b/i.test(text)) push('eng');
    if (/\b(?:jpn|jp|jap|ja|giapponese|japanese)\b/i.test(text)) push('jpn');
    if (/\b(?:fra|fre|fr|francese|french)\b/i.test(text)) push('fra');
    if (/\b(?:spa|es|spagnolo|spanish)\b/i.test(text)) push('spa');
    if (/\b(?:deu|ger|de|tedesco|german)\b/i.test(text)) push('deu');
    return langs;
}

function formatLanguageLabel(languages = [], fallbackValues = []) {
    const merged = [];
    for (const lang of normalizeLanguageList(languages)) {
        if (!merged.includes(lang)) merged.push(lang);
    }
    if (!merged.length) {
        for (const lang of inferLanguagesFromText(...fallbackValues)) {
            if (!merged.includes(lang)) merged.push(lang);
        }
    }
    if (!merged.length) return '';
    const labels = merged.map((lang) => LANGUAGE_LABEL[lang] || String(lang).slice(0, 3).toUpperCase());
    return labels.length > 1 ? `MULTI ${labels.join('/')}` : labels[0];
}

function detectDeliveryMode(stream = {}, finalUrl = '') {
    const hints = stream.behaviorHints || {};
    const meta = hints.vortexMeta || {};
    const url = String(finalUrl || stream.url || '').toLowerCase();
    const extractor = String(stream.extractor || stream.host || hints.extractor || meta.extractor || '').toLowerCase();
    if (hints.lazyExtraction === true || meta.lazyExtraction === true || /\/lazy_extract\//i.test(url)) return 'Lazy';
    if (/\/extractor\/video(?:\.m3u8)?|\/hls\?|\/proxy\/|mediaflow|kraken/i.test(url)) return 'Proxy';
    if (hints.proxyHeaders?.request || hints.headers || stream.headers) return 'Direct+Headers';
    if (hints.notWebReady === true || stream.notWebReady === true) return 'Needs Proxy';
    return 'Direct';
}

function inferDisplayTitle(stream = {}, providerName = '', extractor = '') {
    const hints = stream.behaviorHints || {};
    const meta = hints.vortexMeta || {};
    const candidate = firstNonEmpty(
        meta.mediaTitle,
        meta.title,
        meta.filename,
        stream.filename,
        compactLine(stream.title),
        compactLine(stream.name)
    );
    const clean = cleanLabel(candidate);
    if (!clean) return '';
    const comparable = clean.toLowerCase();
    const provider = String(providerName || '').toLowerCase();
    const hoster = String(extractor || '').toLowerCase();
    if (comparable === provider || comparable === hoster) return '';
    if (comparable.includes('lazy extraction') && comparable.includes(hoster)) return '';
    return clean.length > 140 ? `${clean.slice(0, 137).trim()}...` : clean;
}

function buildUnifiedStreamLabels(stream = {}, {
    providerName = 'Provider',
    providerCode = '',
    extractor = 'Web',
    quality = 'Unknown',
    finalUrl = ''
} = {}) {
    const prettyProvider = humanizeProviderName(providerName);
    const icon = providerIconFor(providerCode || providerName);
    const qualityLabel = normalizeQuality(quality || stream.quality || 'Unknown');
    const extractorLabel = cleanLabel(extractor || stream.extractor || stream.host || 'Web', 'Web')
        .replace(/\s+Lazy$/i, '')
        .trim() || 'Web';
    const hints = stream.behaviorHints || {};
    const meta = hints.vortexMeta || {};
    const audioLanguages = normalizeLanguageList(
        stream.audioLanguages || stream.audio || meta.audioLanguages || meta.audio || []
    );
    const subtitleLanguages = normalizeLanguageList(
        stream.subtitleLanguages || stream.subtitles || meta.subtitleLanguages || meta.subtitles || []
    );
    const languageLabel = formatLanguageLabel(audioLanguages, [stream.title, stream.name, meta.title, meta.filename]);
    const subtitleLabel = subtitleLanguages.length
        ? `Subs ${subtitleLanguages.map((lang) => LANGUAGE_LABEL[lang] || String(lang).slice(0, 3).toUpperCase()).join('/')}`
        : '';
    const deliveryMode = detectDeliveryMode(stream, finalUrl);
    const sizeLabel = firstNonEmpty(meta.size, stream.size, extractSizeLabel(stream.title, stream.name, meta.filename));
    const mediaTitle = inferDisplayTitle(stream, prettyProvider, extractorLabel);
    const secondLineParts = [qualityLabel !== 'Unknown' ? qualityLabel : '', languageLabel].filter(Boolean);

    const name = [
        `${icon} ${prettyProvider}`,
        [qualityLabel !== 'Unknown' ? qualityLabel : '', extractorLabel].filter(Boolean).join(' • ')
    ].filter(Boolean).join('\n');

    const titleLines = [];
    if (mediaTitle) titleLines.push(mediaTitle);
    titleLines.push(`📺 ${secondLineParts.length ? secondLineParts.join(' • ') : qualityLabel}`);
    titleLines.push(`▶️ ${extractorLabel}`);
    titleLines.push(`🛡 ${deliveryMode}`);
    if (subtitleLabel) titleLines.push(`💬 ${subtitleLabel}`);
    if (sizeLabel) titleLines.push(`📦 ${sizeLabel}`);

    return {
        name,
        title: titleLines.filter(Boolean).join('\n')
    };
}

function normalizeQuality(value) {
    const raw = String(value || '').trim().toLowerCase();
    if (!raw || ['unknown', 'auto', 'all', 'null', 'undefined'].includes(raw)) return 'Unknown';
    if (/(?:^|\b)(?:4k|2160p|2160|uhd)(?:\b|$)/i.test(raw)) return '4K';
    if (/(?:^|\b)(?:1440p|1440|2k|qhd)(?:\b|$)/i.test(raw)) return '1440p';
    if (/(?:^|\b)(?:1080p|1080|fullhd|fhd)(?:\b|$)/i.test(raw)) return '1080p';
    if (/(?:^|\b)(?:720p|720|hd)(?:\b|$)/i.test(raw)) return '720p';
    if (/(?:^|\b)(?:576p|576)(?:\b|$)/i.test(raw)) return '576p';
    if (/(?:^|\b)(?:480p|480|sd)(?:\b|$)/i.test(raw)) return '480p';
    if (/(?:^|\b)(?:360p|360)(?:\b|$)/i.test(raw)) return '360p';
    if (/(?:^|\b)(?:240p|240)(?:\b|$)/i.test(raw)) return '240p';
    return String(value || 'Unknown');
}

function qualityRank(value) {
    return QUALITY_RANK[normalizeQuality(value)] || 0;
}

function normalizeProviderKey(value) {
    return String(value || '')
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '') || 'provider';
}

function isPlainObject(value) {
    return value && typeof value === 'object' && !Array.isArray(value);
}

function normalizeLanguageList(value) {
    const source = Array.isArray(value) ? value : (value ? [value] : []);
    const out = [];
    const push = (lang) => {
        const clean = String(lang || '').trim().toLowerCase();
        if (clean && !out.includes(clean)) out.push(clean);
    };

    for (const item of source) {
        const clean = String(item || '').trim().toLowerCase();
        if (!clean) continue;

        const inferred = inferLanguagesFromText(clean);
        if (inferred.length) {
            inferred.forEach(push);
            continue;
        }

        const normalized = clean === 'it' || clean === 'italian' || clean === 'italiano' ? 'ita'
            : clean === 'en' || clean === 'english' || clean === 'inglese' ? 'eng'
                : clean === 'ja' || clean === 'jp' || clean === 'japanese' || clean === 'giapponese' ? 'jpn'
                    : clean.slice(0, 12);
        push(normalized);
    }
    return out;
}

function compactObject(value) {
    const out = {};
    for (const [key, item] of Object.entries(value || {})) {
        if (item === undefined || item === null || item === '') continue;
        out[key] = item;
    }
    return out;
}

function normalizeHeaders(headers = {}) {
    const source = isPlainObject(headers) ? headers : {};
    const out = {};
    for (const [key, value] of Object.entries(source)) {
        if (value === undefined || value === null || value === '') continue;
        const headerName = String(key || '').trim();
        if (!headerName) continue;
        const canonical = headerName
            .split('-')
            .map((part) => part ? part.charAt(0).toUpperCase() + part.slice(1).toLowerCase() : part)
            .join('-');
        out[canonical] = String(value);
    }
    return out;
}

function existingHeaderSource(stream = {}) {
    return normalizeHeaders({
        ...(stream?.behaviorHints?.proxyHeaders?.request || {}),
        ...(stream?.behaviorHints?.headers || {}),
        ...(stream?.headers || {})
    });
}

function canonicalUrlForDedupe(rawUrl) {
    const value = String(rawUrl || '').trim();
    if (!value) return '';
    try {
        const parsed = new URL(value);
        parsed.hash = '';
        parsed.hostname = parsed.hostname.toLowerCase().replace(/^www\./, '');

        const normalizedParams = [];
        for (const [key, val] of parsed.searchParams.entries()) {
            const cleanKey = String(key || '').toLowerCase();
            const cleanVal = VOLATILE_QUERY_RE.test(cleanKey) ? '*' : String(val || '');
            normalizedParams.push([cleanKey, cleanVal]);
        }
        normalizedParams.sort((a, b) => `${a[0]}=${a[1]}`.localeCompare(`${b[0]}=${b[1]}`));
        parsed.search = '';
        for (const [key, val] of normalizedParams) parsed.searchParams.append(key, val);
        return parsed.toString().replace(/\/$/, '');
    } catch (_) {
        return value.replace(/[?#].*$/, '').trim();
    }
}

function hostOf(rawUrl) {
    try {
        return new URL(String(rawUrl || '')).hostname.replace(/^www\./i, '').toLowerCase();
    } catch (_) {
        return '';
    }
}

function streamScore(stream = {}) {
    const priority = Number(stream._priority ?? stream.extra?._priority ?? stream.behaviorHints?.vortexMeta?.priority ?? 9);
    const playableBonus = stream.behaviorHints?.notWebReady === false || stream.notWebReady === false ? 80 : 0;
    const headerBonus = stream.behaviorHints?.proxyHeaders?.request ? 10 : 0;
    return (qualityRank(stream.quality || stream.behaviorHints?.quality || stream.title || stream.name) * 10) + playableBonus + headerBonus - priority;
}

function mergeBehaviorHints(stream = {}, opts = {}, preparedProxy = null) {
    const providerName = opts.providerLabel || stream.provider || stream.source || stream.site || opts.provider || 'Provider';
    const providerCode = opts.providerCode || stream.providerCode || stream.behaviorHints?.vortexProviderCode || providerName;
    let extractor = stream.extractor || stream.host || stream.behaviorHints?.extractor || 'Web';
    const quality = normalizeQuality(stream.quality || stream.behaviorHints?.quality || stream.behaviorHints?.vortexMeta?.quality || 'Unknown');
    const existing = isPlainObject(stream.behaviorHints) ? { ...stream.behaviorHints } : {};

    const hints = {
        ...existing,
        extractor,
        vortexExtractor: existing.vortexExtractor || extractor,
        vortexSource: existing.vortexSource || providerName,
        vortexProviderCode: existing.vortexProviderCode || providerCode,
        vortexMeta: {
            extractor,
            provider: providerName,
            source: providerName,
            site: providerName,
            providerCode,
            quality,
            ...(isPlainObject(existing.vortexMeta) ? existing.vortexMeta : {})
        }
    };

    if (preparedProxy?.headerCount > 0) {
        hints.proxyHeaders = {
            ...(isPlainObject(hints.proxyHeaders) ? hints.proxyHeaders : {}),
            request: preparedProxy.headers
        };
        hints.headers = preparedProxy.headers;
    }

    if (preparedProxy?.basicAuthMoved) {
        hints.proxyHeaderNormalizer = {
            ...(isPlainObject(hints.proxyHeaderNormalizer) ? hints.proxyHeaderNormalizer : {}),
            basicAuthMoved: true
        };
    }

    const titleContext = [
        stream.title,
        stream.name,
        stream.filename,
        hints.vortexMeta?.title,
        hints.vortexMeta?.filename,
        hints.vortexMeta?.mediaTitle
    ];
    const explicitAudioLanguages = normalizeLanguageList(
        stream.audioLanguages || stream.audioLanguagesDetected || stream.audio || hints.vortexMeta?.audioLanguages || hints.vortexMeta?.audio
    );
    const inferredAudioLanguages = inferLanguagesFromText(...titleContext);
    const audioLanguages = explicitAudioLanguages.length ? explicitAudioLanguages : inferredAudioLanguages;
    const subtitleLanguages = normalizeLanguageList(
        stream.subtitleLanguages || stream.subtitles || hints.vortexMeta?.subtitleLanguages || hints.vortexMeta?.subtitles
    );
    if (audioLanguages.length) {
        hints.vortexMeta.audioLanguages = audioLanguages;
        hints.vortexMeta.isMultiAudio = audioLanguages.length > 1;
    }
    if (subtitleLanguages.length) hints.vortexMeta.subtitleLanguages = subtitleLanguages;

    const sizeLabel = firstNonEmpty(
        hints.vortexMeta?.size,
        stream.size,
        stream.sizeLabel,
        extractSizeLabel(...titleContext)
    );
    const sizeBytes = Number(hints.vortexMeta?.sizeBytes || stream.sizeBytes || stream.contentLength || stream.contentLengthBytes || parseSizeToBytes(sizeLabel));
    if (sizeLabel) hints.vortexMeta.size = sizeLabel;
    if (Number.isFinite(sizeBytes) && sizeBytes > 0) hints.vortexMeta.sizeBytes = Math.round(sizeBytes);

    const audioCodec = firstNonEmpty(
        hints.vortexMeta?.audioCodec,
        stream.audioCodec,
        stream.codec,
        inferAudioCodec(...titleContext)
    );
    const audioChannels = firstNonEmpty(
        hints.vortexMeta?.audioChannels,
        stream.audioChannels,
        inferAudioChannels(...titleContext)
    );
    if (audioCodec) hints.vortexMeta.audioCodec = audioCodec;
    if (audioChannels) hints.vortexMeta.audioChannels = audioChannels;

    const displayTitle = inferDisplayTitle({ ...stream, behaviorHints: hints }, providerName, extractor);
    if (displayTitle && !hints.vortexMeta.mediaTitle) hints.vortexMeta.mediaTitle = displayTitle;
    if (displayTitle && !hints.vortexMeta.title) hints.vortexMeta.title = displayTitle;

    if (stream.notWebReady !== undefined && hints.notWebReady === undefined) hints.notWebReady = stream.notWebReady;
    if (hints.vortexMeta && stream.filename && !hints.vortexMeta.filename) hints.vortexMeta.filename = stream.filename;
    return compactObject(hints);
}

function normalizeStream(stream, opts = {}) {
    if (!stream || typeof stream !== 'object') return null;
    const rawUrl = String(stream.url || '').trim();
    if (!rawUrl) return null;

    const providerName = opts.providerLabel || stream.provider || stream.source || stream.site || opts.provider || 'Provider';
    const providerCode = opts.providerCode || stream.providerCode || stream.behaviorHints?.vortexProviderCode || providerName;
    let extractor = stream.extractor || stream.host || stream.behaviorHints?.extractor || 'Web';
    const quality = normalizeQuality(stream.quality || stream.behaviorHints?.quality || stream.behaviorHints?.vortexMeta?.quality || stream.title || stream.name);
    const headers = existingHeaderSource(stream);
    let finalUrl = rawUrl;
    let preparedProxy = null;

    const hasHeaderInput = Object.keys(headers).length > 0;
    const hasBasicAuthInUrl = /^https?:\/\/[^/?#@]+:[^/?#@]+@/i.test(rawUrl);
    if (opts.normalizeHeaders !== false && (hasHeaderInput || hasBasicAuthInUrl)) {
        try {
            preparedProxy = prepareProxyTarget(rawUrl, headers, {
                provider: providerName,
                service: 'web',
                fillReferer: opts.fillReferer === true,
                fillOrigin: opts.fillOrigin === true,
                fillUserAgent: opts.fillUserAgent !== false,
                fillAcceptLanguage: opts.fillAcceptLanguage === true,
                forceIdentityEncoding: opts.forceIdentityEncoding !== false
            });
            finalUrl = preparedProxy.url || rawUrl;
        } catch (_) {
            preparedProxy = { headers, headerCount: Object.keys(headers).length };
        }
    }

    const behaviorHints = mergeBehaviorHints(stream, { ...opts, providerLabel: providerName, providerCode }, preparedProxy);
    const labels = opts.unifiedNaming === false || process.env.STREAM_UNIFIED_NAMING === '0'
        ? {
            name: String(stream.name || `${providerName} | ${quality}`).trim(),
            title: String(stream.title || stream.filename || stream.name || `${providerName} ${quality}`).trim()
        }
        : buildUnifiedStreamLabels({ ...stream, behaviorHints }, {
            providerName,
            providerCode,
            extractor,
            quality,
            finalUrl
        });
    const normalized = {
        ...stream,
        name: labels.name,
        title: labels.title,
        url: finalUrl,
        quality,
        extractor,
        host: stream.host || extractor,
        provider: providerName,
        source: stream.source || providerName,
        site: stream.site || providerName,
        behaviorHints
    };

    if (opts.removePrivateFields !== false) {
        delete normalized._priority;
        delete normalized._hoster;
        delete normalized._fingerprint;
        if (normalized.extra && typeof normalized.extra === 'object') {
            delete normalized.extra._priority;
            delete normalized.extra._hoster;
            if (!Object.keys(normalized.extra).length) delete normalized.extra;
        }
    }

    normalized._normalizerKey = canonicalUrlForDedupe(finalUrl);
    normalized._normalizerHost = hostOf(finalUrl);
    normalized._normalizerScore = streamScore({ ...stream, ...normalized });
    return normalized;
}

function normalizeStreams(streams = [], opts = {}) {
    const providerLabel = opts.providerLabel || opts.provider || 'Provider';
    const before = Array.isArray(streams) ? streams.length : 0;
    const normalized = [];

    for (const stream of Array.isArray(streams) ? streams : []) {
        const item = normalizeStream(stream, opts);
        if (item) normalized.push(item);
    }

    const dedupedMap = new Map();
    for (const stream of normalized) {
        const key = opts.dedupe === false
            ? `${stream._normalizerKey}:${dedupedMap.size}`
            : stream._normalizerKey || canonicalUrlForDedupe(stream.url);
        const existing = dedupedMap.get(key);
        if (!existing || Number(stream._normalizerScore || 0) > Number(existing._normalizerScore || 0)) {
            dedupedMap.set(key, stream);
        }
    }

    let out = Array.from(dedupedMap.values());
    if (opts.sort !== false) {
        out.sort((a, b) => {
            const qualityDelta = qualityRank(b.quality) - qualityRank(a.quality);
            if (qualityDelta !== 0) return qualityDelta;
            const scoreDelta = Number(b._normalizerScore || 0) - Number(a._normalizerScore || 0);
            if (scoreDelta !== 0) return scoreDelta;
            return String(a.title || '').localeCompare(String(b.title || ''));
        });
    }

    out = out.map((stream) => {
        const clean = { ...stream };
        delete clean._normalizerKey;
        delete clean._normalizerHost;
        delete clean._normalizerScore;
        return clean;
    });

    if (opts.debug === true || process.env.STREAM_NORMALIZER_DEBUG === '1') {
        console.log(`[STREAM NORMALIZER] provider=${normalizeProviderKey(providerLabel)} before=${before} after=${out.length} deduped=${Math.max(0, before - out.length)}`);
    }

    return out;
}

module.exports = {
    buildUnifiedStreamLabels,
    canonicalUrlForDedupe,
    normalizeQuality,
    normalizeStream,
    normalizeStreams,
    parseSizeToBytes,
    qualityRank
};
