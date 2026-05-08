'use strict';

const QUALITY_RULES = [
    ['2160p', /\b(?:2160p|4k|uhd)\b/i],
    ['1080p', /\b(?:1080p|full\s*hd|fhd)\b/i],
    ['720p', /\b(?:720p|\bhd\b)\b/i],
    ['480p', /\b(?:480p|\bsd\b)\b/i]
];

const LANGUAGE_RULES = [
    ['ita', /\b(?:ita|italiano|italian|audio\s*ita)\b/i],
    ['multi', /\b(?:multi|multilang|dual\s*audio)\b/i],
    ['eng', /\b(?:eng|english|audio\s*eng)\b/i],
    ['jpn', /\b(?:jpn|jap|japanese|audio\s*jpn)\b/i]
];

function firstNonEmpty(...values) {
    for (const value of values) {
        const text = String(value ?? '').trim();
        if (text) return text;
    }
    return '';
}

function asArray(value) {
    if (!value) return [];
    return Array.isArray(value) ? value : [value];
}

function pickByRules(text, rules, fallback = '') {
    const raw = String(text || '');
    for (const [value, regex] of rules) {
        if (regex.test(raw)) return value;
    }
    return fallback;
}

function normalizeProviderId(value) {
    return String(value || '')
        .trim()
        .replace(/[^a-z0-9_-]+/gi, '_')
        .replace(/^_+|_+$/g, '')
        .toLowerCase();
}

function normalizeUrl(value, baseUrl = '') {
    const raw = String(value || '').trim();
    if (!raw) return '';
    if (/^https?:\/\//i.test(raw)) return raw;
    if (!baseUrl) return raw;
    try {
        return new URL(raw, baseUrl).toString();
    } catch (_) {
        return raw;
    }
}

function normalizeProviderResult(result = {}, recipe = {}, context = {}) {
    const providerId = normalizeProviderId(recipe.id || result.providerId || result.provider || result.source);
    const providerName = firstNonEmpty(recipe.name, result.providerName, result.sourceName, providerId);
    const title = firstNonEmpty(result.title, result.name, result.label, context.title);
    const searchableText = [
        title,
        result.description,
        result.rawTitle,
        result.quality,
        result.language,
        result.languages,
        result.url,
        result.href
    ].filter(Boolean).join(' ');

    const url = normalizeUrl(firstNonEmpty(result.url, result.href, result.link), recipe.baseUrl || recipe.baseUrls?.[0]);
    const quality = firstNonEmpty(result.quality, pickByRules(searchableText, QUALITY_RULES, ''));
    const language = firstNonEmpty(result.language, pickByRules(searchableText, LANGUAGE_RULES, 'unknown'));
    const languages = asArray(result.languages || language).filter(Boolean);

    return {
        ...result,
        providerId,
        providerName,
        source: firstNonEmpty(result.source, providerName),
        title,
        name: firstNonEmpty(result.name, title),
        url,
        href: firstNonEmpty(result.href, url),
        quality,
        language,
        languages,
        _providerRecipe: recipe.id || providerId,
        _providerPipeline: true
    };
}

function normalizeProviderResults(results = [], recipe = {}, context = {}) {
    return asArray(results)
        .filter((item) => item && typeof item === 'object')
        .map((item) => normalizeProviderResult(item, recipe, context));
}

module.exports = {
    normalizeProviderId,
    normalizeProviderResult,
    normalizeProviderResults,
    normalizeUrl,
    pickByRules
};
