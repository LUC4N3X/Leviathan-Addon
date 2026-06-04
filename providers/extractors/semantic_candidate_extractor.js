'use strict';

const {
    HOSTER_DIRECT_LINK_PATTERN,
    HOSTER_ESCAPED_DIRECT_LINK_PATTERN,
    resolveExtractorDefinition
} = require('./registry');

const DEFAULT_MAX_HTML_LENGTH = 600_000;
const DEFAULT_MAX_BLOCK_LENGTH = 35_000;
const DEFAULT_MAX_CANDIDATES = 40;
const DEFAULT_MAX_BASE64_PAYLOADS = 10;
const DEFAULT_MAX_CHARCODE_PAYLOADS = 12;
const DEFAULT_MIN_URL_LENGTH = 8;

const ATTR_URL_RE = /\b(?:href|src|data-src|data-lazy-src|data-link|data-url|data-video|data-embed|value)\s*=\s*(["'])(.*?)\1/gis;
const JSONISH_URL_RE = /["']?(?:file|src|source|sources|url|hls|playlist|video_url|videoUrl|stream_url|streamUrl|embed|iframe|player|link)["']?\s*[:=]\s*(["'])(.*?)\1/gis;
const IFRAME_TAG_RE = /<iframe\b[^>]*(?:src|data-src|data-lazy-src)\s*=\s*(["'])(.*?)\1[^>]*>/gis;
const URL_WIDE_RE = /(?:https?:\\?\/\\?\/|https?:\/\/|\/\/)[^\s"'<>`]+/gi;
const BASE64_RE = /(?:atob\(\s*|["'=:,\[]\s*)([A-Za-z0-9+/=]{32,})["')\],;\s]/g;
const CHARCODE_ARRAY_RE = /(?:String\.fromCharCode\s*\(|\[)\s*((?:\d{1,3}\s*,\s*){7,}\d{1,3})\s*[)\]]/g;
const CONCAT_PAIR_RE = /(["'])((?:\\.|[^"'\\])*?)\1\s*[+.]\s*(["'])((?:\\.|[^"'\\])*?)\3/g;
const CONCAT_HINT_RE = /["'][^"']*["']\s*[+.]\s*["']/;
const DECODE_SIGNAL_RE = /(?:https?:|\/\/|embed|iframe|player|\.m3u8|\.mp4)/i;

const HOSTER_PATTERN_PREFIX = String.raw`https?:\/\/(?:www\.)?`;
const SCHEMELESS_HOSTER_RE = HOSTER_DIRECT_LINK_PATTERN.startsWith(HOSTER_PATTERN_PREFIX)
    ? new RegExp(`(?:^|[^\\w@/.])((?:www\\.)?${HOSTER_DIRECT_LINK_PATTERN.slice(HOSTER_PATTERN_PREFIX.length)})`, 'gi')
    : null;

const SOURCE_SCORES = {
    iframe: 45,
    attribute: 34,
    jsonish: 30,
    direct: 26,
    escaped: 24,
    schemeless: 22,
    charcode: 20,
    base64: 18,
    concat: 16,
    wide: 12,
    block: 8
};

function clampInt(value, fallback, min, max) {
    const n = Number.parseInt(String(value ?? ''), 10);
    if (!Number.isFinite(n)) return fallback;
    return Math.max(min, Math.min(max, n));
}

function safeText(value) {
    if (typeof value === 'string') return value;
    if (Buffer.isBuffer(value)) return value.toString('utf8');
    if (value == null) return '';
    try { return JSON.stringify(value); } catch (_) { return String(value || ''); }
}

function decodeHtmlEntities(value) {
    return String(value || '')
        .replace(/&amp;|&#038;|&#38;/gi, '&')
        .replace(/&quot;|&#034;|&#34;/gi, '"')
        .replace(/&#039;|&#39;|&apos;/gi, "'")
        .replace(/&lt;|&#060;|&#60;/gi, '<')
        .replace(/&gt;|&#062;|&#62;/gi, '>')
        .replace(/&#x([0-9a-f]+);/gi, (match, hex) => {
            try { return String.fromCodePoint(Number.parseInt(hex, 16)); } catch (_) { return match; }
        })
        .replace(/&#(\d+);/g, (match, dec) => {
            try { return String.fromCodePoint(Number.parseInt(dec, 10)); } catch (_) { return match; }
        });
}

function normalizeEscapedText(value) {
    let out = decodeHtmlEntities(String(value || ''));
    let previous = null;

    for (let index = 0; index < 4; index += 1) {
        if (out === previous) break;
        previous = out;
        out = out
            .replace(/\\u0026/gi, '&')
            .replace(/\\u003d/gi, '=')
            .replace(/\\u003f/gi, '?')
            .replace(/\\u003a/gi, ':')
            .replace(/\\u002f/gi, '/')
            .replace(/\\x26/gi, '&')
            .replace(/\\x3d/gi, '=')
            .replace(/\\x3f/gi, '?')
            .replace(/\\x3a/gi, ':')
            .replace(/\\x2f/gi, '/')
            .replace(/\\u([0-9a-f]{4})/gi, (match, hex) => {
                try { return String.fromCharCode(Number.parseInt(hex, 16)); } catch (_) { return match; }
            })
            .replace(/\\x([0-9a-f]{2})/gi, (match, hex) => {
                try { return String.fromCharCode(Number.parseInt(hex, 16)); } catch (_) { return match; }
            })
            .replace(/\\\//g, '/')
            .replace(/\\\\\//g, '/')
            .replace(/\u0000/g, '')
            .replace(/%(?:25)+/g, '%');

        if (/%[0-9a-f]{2}/i.test(out)) {
            try {
                const decoded = decodeURIComponent(out);
                if (decoded && decoded !== out && /(?:https?:|\/\/|\.m3u8|\.mp4|embed|iframe|player)/i.test(decoded)) {
                    out = decoded;
                }
            } catch (_) {}
        }
    }

    return out;
}

function sanitizeHtml(value, maxHtmlLength = DEFAULT_MAX_HTML_LENGTH) {
    const text = normalizeEscapedText(safeText(value));
    return text
        .slice(0, Math.max(1, maxHtmlLength))
        .replace(/<!--[\s\S]*?-->/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function calculateShannonEntropy(value) {
    const str = String(value || '');
    if (!str) return 0;

    const frequencies = new Map();
    for (let index = 0; index < str.length; index += 1) {
        const char = str[index];
        frequencies.set(char, (frequencies.get(char) || 0) + 1);
    }

    let entropy = 0;
    for (const count of frequencies.values()) {
        const p = count / str.length;
        entropy -= p * Math.log2(p);
    }
    return entropy;
}

function normalizeCandidateUrl(rawUrl, baseUrl = null) {
    let value = normalizeEscapedText(String(rawUrl || '')).trim();
    if (!value || value.length < DEFAULT_MIN_URL_LENGTH) return null;

    value = value
        .replace(/^[\s"'({\[]+|[\s"')},\];.]+$/g, '')
        .replace(/\\/g, '')
        .replace(/&amp;/gi, '&');

    if (!value || /^(?:javascript|data|mailto):/i.test(value)) return null;

    try {
        if (value.startsWith('//')) return new URL(`https:${value}`).toString();
        if (/^https?:\/\//i.test(value)) return new URL(value).toString();
        if (baseUrl && /^\//.test(value)) return new URL(value, baseUrl).toString();
    } catch (_) {
        return null;
    }

    return null;
}

function addCandidate(rawUrl, baseUrl, sink, source, contextBoost = 0, index = -1) {
    const url = normalizeCandidateUrl(rawUrl, baseUrl);
    if (!url) return false;

    const definition = resolveExtractorDefinition(url);
    if (!definition) return false;

    const key = url.toLowerCase();
    const current = sink.get(key) || {
        url,
        key: definition.key,
        label: definition.label,
        priority: definition.priority ?? 0,
        score: 0,
        sources: [],
        firstIndex: index >= 0 ? index : Number.MAX_SAFE_INTEGER
    };

    current.score += (SOURCE_SCORES[source] || 6) + contextBoost;
    current.firstIndex = Math.min(current.firstIndex, index >= 0 ? index : current.firstIndex);
    if (!current.sources.includes(source)) current.sources.push(source);
    sink.set(key, current);
    return true;
}

function extractUrlsWithRegex(text, regex, baseUrl, sink, source, contextBoost = 0) {
    const sourceText = String(text || '');
    regex.lastIndex = 0;
    let match;
    while ((match = regex.exec(sourceText)) !== null) {
        const raw = match[2] || match[1] || match[0];
        addCandidate(raw, baseUrl, sink, source, contextBoost, match.index);
    }
}

function extractSchemelessHosterUrls(text, baseUrl, sink, contextBoost = 0) {
    if (!SCHEMELESS_HOSTER_RE) return;
    const sourceText = String(text || '');
    SCHEMELESS_HOSTER_RE.lastIndex = 0;
    let match;
    while ((match = SCHEMELESS_HOSTER_RE.exec(sourceText)) !== null) {
        const hostPath = match[1];
        if (!hostPath) continue;
        addCandidate(`https://${hostPath}`, baseUrl, sink, 'schemeless', contextBoost, match.index);
    }
}

function maybeExtractRedirectTargets(candidateUrl, baseUrl, sink, source) {
    let parsed;
    try { parsed = new URL(candidateUrl); } catch (_) { return; }

    for (const [, value] of parsed.searchParams.entries()) {
        const decoded = normalizeEscapedText(value);
        if (/https?:\/\//i.test(decoded)) addCandidate(decoded, baseUrl, sink, source, 5);
    }
}

function decodeBase64Payloads(text, limit = DEFAULT_MAX_BASE64_PAYLOADS) {
    const out = [];
    const source = String(text || '');
    BASE64_RE.lastIndex = 0;

    let match;
    while ((match = BASE64_RE.exec(source)) !== null && out.length < limit) {
        const payload = match[1];
        if (!payload || payload.length > 40_000) continue;
        try {
            const decoded = Buffer.from(payload, 'base64').toString('utf8');
            if (DECODE_SIGNAL_RE.test(decoded)) out.push(decoded);
        } catch (_) {}
    }

    return out;
}

function decodeCharCodeArrays(text, limit = DEFAULT_MAX_CHARCODE_PAYLOADS) {
    const out = [];
    const source = String(text || '');
    CHARCODE_ARRAY_RE.lastIndex = 0;

    let match;
    while ((match = CHARCODE_ARRAY_RE.exec(source)) !== null && out.length < limit) {
        const codes = match[1].split(',').map((part) => Number.parseInt(part.trim(), 10));
        if (codes.length < 8 || codes.some((code) => !Number.isFinite(code) || code < 9 || code > 0x10ffff)) continue;
        let decoded = '';
        try { decoded = String.fromCharCode(...codes); } catch (_) { continue; }
        if (DECODE_SIGNAL_RE.test(decoded)) out.push(decoded);
    }

    return out;
}

function joinConcatenatedStrings(text, passes = 6) {
    let out = String(text || '');
    let previous = null;
    for (let index = 0; index < passes; index += 1) {
        if (out === previous) break;
        previous = out;
        CONCAT_PAIR_RE.lastIndex = 0;
        out = out.replace(CONCAT_PAIR_RE, (match, q1, a, q2, b) => `"${a}${b}"`);
    }
    return out;
}

function splitSignalBlocks(html, maxBlockLength = DEFAULT_MAX_BLOCK_LENGTH) {
    const blocks = String(html || '').split(/<\/script>|<\/iframe>|<\/div>|<\/article>|<\/li>|<\/tr>|<br\s*\/?>/i);
    return blocks
        .map((block) => String(block || '').trim().slice(0, maxBlockLength))
        .filter((block) => block.length >= 20 && /(?:https?:|\\u00|\\x|embed|iframe|player|src|href|data-)/i.test(block));
}

function extractEmbedCandidates(rawHtml, options = {}) {
    const baseUrl = options.baseUrl || options.pageUrl || null;
    const maxHtmlLength = clampInt(options.maxHtmlLength, DEFAULT_MAX_HTML_LENGTH, 20_000, 2_000_000);
    const maxBlockLength = clampInt(options.maxBlockLength, DEFAULT_MAX_BLOCK_LENGTH, 2_000, 120_000);
    const maxCandidates = clampInt(options.maxCandidates, DEFAULT_MAX_CANDIDATES, 1, 200);
    const maxBase64Payloads = clampInt(options.maxBase64Payloads, DEFAULT_MAX_BASE64_PAYLOADS, 0, 50);

    const html = sanitizeHtml(rawHtml, maxHtmlLength);
    if (!html) return [];

    const candidates = new Map();

    extractUrlsWithRegex(html, IFRAME_TAG_RE, baseUrl, candidates, 'iframe', 5);
    extractUrlsWithRegex(html, ATTR_URL_RE, baseUrl, candidates, 'attribute');
    extractUrlsWithRegex(html, JSONISH_URL_RE, baseUrl, candidates, 'jsonish');
    extractUrlsWithRegex(html, new RegExp(HOSTER_DIRECT_LINK_PATTERN, 'ig'), baseUrl, candidates, 'direct');
    extractUrlsWithRegex(html, new RegExp(HOSTER_ESCAPED_DIRECT_LINK_PATTERN, 'ig'), baseUrl, candidates, 'escaped');
    extractUrlsWithRegex(html, URL_WIDE_RE, baseUrl, candidates, 'wide');
    extractSchemelessHosterUrls(html, baseUrl, candidates);

    for (const decoded of decodeBase64Payloads(html, maxBase64Payloads)) {
        extractUrlsWithRegex(decoded, URL_WIDE_RE, baseUrl, candidates, 'base64');
        extractUrlsWithRegex(decoded, new RegExp(HOSTER_DIRECT_LINK_PATTERN, 'ig'), baseUrl, candidates, 'base64', 8);
        extractSchemelessHosterUrls(decoded, baseUrl, candidates, 4);
    }

    for (const decoded of decodeCharCodeArrays(html)) {
        extractUrlsWithRegex(decoded, URL_WIDE_RE, baseUrl, candidates, 'charcode');
        extractUrlsWithRegex(decoded, new RegExp(HOSTER_DIRECT_LINK_PATTERN, 'ig'), baseUrl, candidates, 'charcode', 6);
        extractSchemelessHosterUrls(decoded, baseUrl, candidates, 4);
    }

    if (CONCAT_HINT_RE.test(html)) {
        const joined = joinConcatenatedStrings(html);
        if (joined !== html) {
            extractUrlsWithRegex(joined, new RegExp(HOSTER_DIRECT_LINK_PATTERN, 'ig'), baseUrl, candidates, 'concat', 4);
            extractUrlsWithRegex(joined, URL_WIDE_RE, baseUrl, candidates, 'concat');
            extractSchemelessHosterUrls(joined, baseUrl, candidates, 2);
        }
    }

    for (const block of splitSignalBlocks(html, maxBlockLength)) {
        const entropy = calculateShannonEntropy(block);
        const entropyBoost = entropy >= 4.2 ? 10 : entropy >= 3.2 ? 4 : 0;
        extractUrlsWithRegex(block, URL_WIDE_RE, baseUrl, candidates, 'block', entropyBoost);
    }

    for (const candidate of [...candidates.values()]) {
        maybeExtractRedirectTargets(candidate.url, baseUrl, candidates, 'redirect');
    }

    return [...candidates.values()]
        .sort((a, b) => {
            const scoreDiff = b.score - a.score;
            if (scoreDiff) return scoreDiff;
            const priorityDiff = (a.priority ?? 999) - (b.priority ?? 999);
            if (priorityDiff) return priorityDiff;
            return a.firstIndex - b.firstIndex;
        })
        .slice(0, maxCandidates);
}

function extractResilientEmbeds(rawHtml, options = {}) {
    return extractEmbedCandidates(rawHtml, options).map((candidate) => candidate.url);
}

module.exports = {
    extractEmbedCandidates,
    extractResilientEmbeds,
    normalizeCandidateUrl,
    normalizeEscapedText,
    calculateShannonEntropy
};
