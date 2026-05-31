'use strict';

let cheerio = null;
try {
    cheerio = require('cheerio');
} catch (_) {
    cheerio = null;
}

const { normalizeUrl } = require('../../providers/engine/provider_result_normalizer');
const { getBody } = require('./provider_failure_classifier');
const { scoreProviderCandidate, normalizeText } = require('./provider_candidate_scoring');

const DEFAULT_DENY_PATTERNS = [
    '/login', '/register', '/privacy', '/cookie', '/cookies', '/dmca', '/contact', '/contatti', '/category', '/categorie', '/tag', '/genre',
    '/wp-admin', '/account', '/profile', '/search', '/feed', '/rss', '/terms', '/policy', '/about'
];

const DIRECT_MEDIA_DENY = /(?:magnet:\?|\.m3u8(?:\?|$)|\.mpd(?:\?|$)|\.mp4(?:\?|$)|\.mkv(?:\?|$)|\.avi(?:\?|$)|\.mov(?:\?|$)|\.ts(?:\?|$)|\/embed\/|\/iframe\/|player|streaming|download=)/i;

function asArray(value) {
    if (!value) return [];
    return Array.isArray(value) ? value : [value];
}

function dedupeWhitespace(value = '') {
    return String(value || '').replace(/\s+/g, ' ').trim();
}

function getRecoveryConfig(recipe = {}) {
    const recovery = recipe.recovery || {};
    return {
        enabled: recovery.enabled === true,
        strategy: recovery.strategy || recovery.mode || 'anchor-candidate-scoring',
        triggerOn: asArray(recovery.triggerOn || ['selector_miss', 'layout_changed']),
        minScore: Number.isFinite(Number(recovery.minScore)) ? Number(recovery.minScore) : 0.62,
        maxCandidates: Math.max(1, Number.parseInt(recovery.maxCandidates || 8, 10) || 8),
        allowDomains: asArray(recovery.allowDomains || ['same-origin']),
        denyPatterns: [...DEFAULT_DENY_PATTERNS, ...asArray(recovery.denyPatterns)],
        includeStructuralText: recovery.includeStructuralText !== false
    };
}

function isSameOrigin(url = '', baseUrl = '') {
    if (!url || !baseUrl) return false;
    try {
        const left = new URL(url, baseUrl);
        const right = new URL(baseUrl);
        return left.hostname.replace(/^www\./i, '') === right.hostname.replace(/^www\./i, '');
    } catch (_) {
        return false;
    }
}

function isAllowedDomain(url = '', recipe = {}, config = {}) {
    if (!url) return false;
    const baseUrl = recipe.baseUrl || recipe.baseUrls?.[0] || '';
    if (config.allowDomains.includes('*') || config.allowDomains.includes('any')) return true;
    if (config.allowDomains.includes('same-origin') && isSameOrigin(url, baseUrl)) return true;

    try {
        const hostname = new URL(url, baseUrl).hostname.replace(/^www\./i, '').toLowerCase();
        return config.allowDomains.some((domain) => {
            const clean = String(domain || '').replace(/^https?:\/\//i, '').replace(/^www\./i, '').replace(/\/.*$/, '').toLowerCase();
            return clean && (hostname === clean || hostname.endsWith(`.${clean}`));
        });
    } catch (_) {
        return false;
    }
}

function isDeniedHref(href = '', config = {}) {
    const value = String(href || '').trim();
    if (!value) return true;
    if (/^(#|javascript:|mailto:|tel:)/i.test(value)) return true;
    if (DIRECT_MEDIA_DENY.test(value)) return true;
    return config.denyPatterns.some((pattern) => {
        const text = String(pattern || '').trim();
        if (!text) return false;
        if (text.startsWith('/') && text.endsWith('/') && text.length > 2) {
            try {
                return new RegExp(text.slice(1, -1), 'i').test(value);
            } catch (_) {
                return value.toLowerCase().includes(text.toLowerCase());
            }
        }
        return value.toLowerCase().includes(text.toLowerCase());
    });
}

function getStructuralHint($, link) {
    const closest = link.closest('[data-provider-result], article, .movie-card, .series-card, .result-item, .card, .post, li');
    if (!closest || closest.length === 0) return '';
    const node = closest.get(0);
    if (!node) return '';
    if (node.attribs?.['data-provider-result'] !== undefined) return 'data-provider-result';
    const tag = String(node.tagName || node.name || '').toLowerCase();
    const cls = String(node.attribs?.class || '').trim();
    if (tag === 'article') return 'article';
    if (/movie-card|series-card|result-item|card|post/i.test(cls)) return cls.split(/\s+/).find((part) => /movie-card|series-card|result-item|card|post/i.test(part)) || 'card';
    if (tag === 'li') return 'list-item';
    return tag || '';
}

function extractDomCandidates(html = '', recipe = {}, config = {}) {
    const $ = cheerio.load(String(html || ''));
    const candidates = [];

    $('a[href]').each((_, element) => {
        const link = $(element);
        const rawHref = dedupeWhitespace(link.attr('href') || '');
        if (isDeniedHref(rawHref, config)) return;

        const href = normalizeUrl(rawHref, recipe.baseUrl || recipe.baseUrls?.[0] || '');
        if (!isAllowedDomain(href, recipe, config)) return;

        const text = dedupeWhitespace(link.text() || '');
        const attrTitle = dedupeWhitespace(link.attr('title') || link.attr('aria-label') || link.attr('data-title') || '');
        const closest = link.closest('[data-provider-result], article, .movie-card, .series-card, .result-item, .card, .post, li');
        const heading = dedupeWhitespace(closest.find('h1,h2,h3,h4,.title,.name,[data-title]').first().text() || '');
        const ancestorText = config.includeStructuralText ? dedupeWhitespace(closest.text() || '') : '';
        const title = dedupeWhitespace(attrTitle || heading || text);
        if (!title && !text) return;

        candidates.push({
            title: title || text,
            href,
            rawHref,
            text,
            rawText: dedupeWhitespace([text, attrTitle, heading].filter(Boolean).join(' ')),
            ancestorText: ancestorText.slice(0, 600),
            structuralHint: getStructuralHint($, link)
        });
    });

    return candidates;
}

function extractRegexCandidates(html = '', recipe = {}, config = {}) {
    const candidates = [];
    const baseUrl = recipe.baseUrl || recipe.baseUrls?.[0] || '';
    const regex = /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
    let match;
    while ((match = regex.exec(String(html || ''))) !== null) {
        const rawHref = dedupeWhitespace(match[1] || '');
        if (isDeniedHref(rawHref, config)) continue;
        const href = normalizeUrl(rawHref, baseUrl);
        if (!isAllowedDomain(href, recipe, config)) continue;
        const text = dedupeWhitespace(String(match[2] || '').replace(/<[^>]+>/g, ' '));
        if (!text) continue;
        candidates.push({ title: text, href, rawHref, text, rawText: text, ancestorText: '', structuralHint: 'anchor' });
    }
    return candidates;
}

function dedupeCandidates(candidates = []) {
    const seen = new Set();
    const out = [];
    for (const candidate of candidates) {
        const key = `${normalizeText(candidate.href)}::${normalizeText(candidate.title)}`;
        if (!candidate.href || seen.has(key)) continue;
        seen.add(key);
        out.push(candidate);
    }
    return out;
}

function candidateToResult(candidate = {}, recipe = {}, scoring = {}) {
    return {
        title: candidate.title,
        href: candidate.href,
        url: candidate.href,
        rawTitle: candidate.rawText || candidate.title,
        description: candidate.ancestorText || '',
        recovery: true,
        recoveryUsed: true,
        recoveryScore: Math.round((scoring.score || 0) * 1000) / 1000,
        recoveryReason: scoring.reasons?.join(',') || 'anchor_candidate_scoring',
        recoveryStrategy: recipe.recovery?.strategy || recipe.recovery?.mode || 'anchor-candidate-scoring'
    };
}

function shouldRunRecovery(recipe = {}, failure = null) {
    const config = getRecoveryConfig(recipe);
    if (!config.enabled) return false;
    if (!failure) return true;
    return config.triggerOn.includes(failure.type) || config.triggerOn.includes(failure.reason);
}

function runProviderRecovery({ html = '', response = null, recipe = {}, context = {}, failure = null } = {}) {
    const config = getRecoveryConfig(recipe);
    const body = html || getBody(response);
    const attempt = {
        stage: 'recovery',
        ok: false,
        enabled: config.enabled,
        strategy: config.strategy,
        trigger: failure?.type || failure?.reason || 'unknown',
        count: 0,
        candidateCount: 0,
        minScore: config.minScore
    };

    if (!config.enabled) {
        attempt.reason = 'recovery_disabled';
        return { results: [], attempt };
    }

    if (!shouldRunRecovery(recipe, failure)) {
        attempt.reason = 'trigger_not_allowed';
        return { results: [], attempt };
    }

    if (!body) {
        attempt.reason = 'empty_body';
        return { results: [], attempt };
    }

    const rawCandidates = cheerio
        ? extractDomCandidates(body, recipe, config)
        : extractRegexCandidates(body, recipe, config);
    const candidates = dedupeCandidates(rawCandidates);
    const scored = candidates
        .map((candidate) => ({ candidate, scoring: scoreProviderCandidate(candidate, context, recipe) }))
        .filter((item) => item.scoring.score >= config.minScore)
        .sort((a, b) => b.scoring.score - a.scoring.score)
        .slice(0, config.maxCandidates);

    const results = scored.map((item) => candidateToResult(item.candidate, recipe, item.scoring));
    attempt.ok = results.length > 0;
    attempt.count = results.length;
    attempt.candidateCount = candidates.length;
    attempt.topScore = scored[0] ? Math.round(scored[0].scoring.score * 1000) / 1000 : 0;
    attempt.reason = results.length > 0 ? 'recovery_candidates_found' : 'no_recovery_candidates';

    return { results, attempt };
}

module.exports = {
    getRecoveryConfig,
    runProviderRecovery,
    shouldRunRecovery
};
