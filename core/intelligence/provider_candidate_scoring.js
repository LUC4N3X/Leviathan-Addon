'use strict';

const STOPWORDS = new Set([
    'the', 'a', 'an', 'and', 'or', 'of', 'in', 'on', 'for', 'to', 'con', 'di', 'de', 'del', 'della', 'il', 'lo', 'la', 'i', 'gli', 'le',
    'un', 'una', 'serie', 'film', 'streaming', 'cb01', 'guarda', 'guardare', 'download', 'ita', 'sub', 'hd'
]);

function normalizeText(value = '') {
    return String(value || '')
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/&amp;/gi, '&')
        .replace(/[^a-z0-9]+/gi, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .toLowerCase();
}

function tokenize(value = '') {
    const normalized = normalizeText(value);
    if (!normalized) return [];
    return normalized
        .split(' ')
        .map((token) => token.trim())
        .filter((token) => token && token.length > 1 && !STOPWORDS.has(token));
}

function unique(values = []) {
    const out = [];
    const seen = new Set();
    for (const value of values) {
        const text = String(value || '').trim();
        if (!text) continue;
        const key = text.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(text);
    }
    return out;
}

function tokenSimilarity(a = '', b = '') {
    const left = new Set(tokenize(a));
    const right = new Set(tokenize(b));
    if (!left.size || !right.size) return 0;

    let intersection = 0;
    for (const token of left) if (right.has(token)) intersection += 1;
    const union = new Set([...left, ...right]).size;
    return union > 0 ? intersection / union : 0;
}

function includesNormalized(haystack = '', needle = '') {
    const left = normalizeText(haystack);
    const right = normalizeText(needle);
    return Boolean(left && right && (left.includes(right) || right.includes(left)));
}

function getExpectedTitle(context = {}) {
    return String(context.title || context.name || context.query || context.searchTitle || context.originalTitle || '').trim();
}

function getExpectedYear(context = {}) {
    const value = context.year || context.releaseYear || context.movieYear;
    const year = String(value || '').match(/(?:19|20)\d{2}/)?.[0] || '';
    return year;
}

function getSeasonEpisode(context = {}) {
    const season = Number.parseInt(context.season ?? context.s, 10);
    const episode = Number.parseInt(context.episode ?? context.e, 10);
    return {
        season: Number.isFinite(season) && season > 0 ? season : null,
        episode: Number.isFinite(episode) && episode > 0 ? episode : null
    };
}

function hasSeasonEpisode(text = '', season = null, episode = null) {
    if (!season || !episode) return false;
    const value = String(text || '');
    const s = String(season).padStart(2, '0');
    const e = String(episode).padStart(2, '0');
    const patterns = [
        new RegExp(`\\bs${s}e${e}\\b`, 'i'),
        new RegExp(`\\b${season}x${episode}\\b`, 'i'),
        new RegExp(`\\bstagione\\s*${season}\\b[\\s\\S]{0,80}\\bepisodio\\s*${episode}\\b`, 'i'),
        new RegExp(`\\bseason\\s*${season}\\b[\\s\\S]{0,80}\\bepisode\\s*${episode}\\b`, 'i')
    ];
    return patterns.some((pattern) => pattern.test(value));
}

function isSameOrigin(candidateUrl = '', baseUrl = '') {
    if (!candidateUrl || !baseUrl) return false;
    try {
        const candidate = new URL(candidateUrl, baseUrl);
        const base = new URL(baseUrl);
        return candidate.hostname.replace(/^www\./i, '') === base.hostname.replace(/^www\./i, '');
    } catch (_) {
        return false;
    }
}

function clamp01(value) {
    if (!Number.isFinite(value)) return 0;
    return Math.max(0, Math.min(1, value));
}

function allExpectedTokensPresent(searchable = '', expectedTitle = '') {
    const expected = tokenize(expectedTitle);
    if (!expected.length) return false;
    const present = new Set(tokenize(searchable));
    return expected.every((token) => present.has(token));
}

function scoreProviderCandidate(candidate = {}, context = {}, recipe = {}) {
    const expectedTitle = getExpectedTitle(context);
    const expectedYear = getExpectedYear(context);
    const { season, episode } = getSeasonEpisode(context);
    const baseUrl = recipe.baseUrl || recipe.baseUrls?.[0] || '';
    const title = String(candidate.title || candidate.text || '').trim();
    const href = String(candidate.href || candidate.url || '').trim();
    const searchable = unique([title, candidate.rawText, candidate.ancestorText, href]).join(' ');

    let score = 0;
    const reasons = [];

    const similarity = expectedTitle ? tokenSimilarity(searchable, expectedTitle) : 0;
    if (similarity > 0) {
        score += similarity * 0.46;
        reasons.push(`title_similarity:${similarity.toFixed(2)}`);
    }

    if (expectedTitle && includesNormalized(searchable, expectedTitle)) {
        score += 0.14;
        reasons.push('title_contains_query');
    }

    if (expectedTitle && allExpectedTokensPresent(searchable, expectedTitle)) {
        score += 0.13;
        reasons.push('all_title_tokens_present');
    }

    if (expectedTitle && normalizeText(title).startsWith(normalizeText(expectedTitle))) {
        score += 0.06;
        reasons.push('title_prefix_match');
    }

    if (expectedYear && new RegExp(`\\b${expectedYear}\\b`).test(searchable)) {
        score += 0.12;
        reasons.push('year_match');
    }

    if (season && episode) {
        if (hasSeasonEpisode(searchable, season, episode)) {
            score += 0.18;
            reasons.push('episode_match');
        } else if (/\bs\d{1,2}e\d{1,2}\b|\b\d{1,2}x\d{1,2}\b/i.test(searchable)) {
            score -= 0.16;
            reasons.push('episode_mismatch_penalty');
        }
    }

    if (isSameOrigin(href, baseUrl)) {
        score += 0.07;
        reasons.push('same_origin');
    }

    if (candidate.structuralHint) {
        score += 0.05;
        reasons.push(`structure:${candidate.structuralHint}`);
    }

    if (!title || title.length < 3) {
        score -= 0.16;
        reasons.push('weak_title_penalty');
    }

    if (/\b(login|register|privacy|cookie|dmca|contatt|contact|category|tag|genre|account|wp-admin)\b/i.test(`${title} ${href}`)) {
        score -= 0.2;
        reasons.push('navigation_penalty');
    }

    if (/\b(trailer|teaser|clip|news|recensione|review)\b/i.test(title) && !/\b(trailer|teaser)\b/i.test(expectedTitle)) {
        score -= 0.12;
        reasons.push('non_primary_content_penalty');
    }

    if (/^(#|javascript:|mailto:|tel:)/i.test(href)) {
        score -= 0.5;
        reasons.push('unsafe_href_penalty');
    }

    const normalizedScore = clamp01(score);
    return {
        score: normalizedScore,
        reasons,
        expectedTitle,
        expectedYear,
        season,
        episode
    };
}

module.exports = {
    getExpectedTitle,
    getExpectedYear,
    getSeasonEpisode,
    hasSeasonEpisode,
    includesNormalized,
    normalizeText,
    scoreProviderCandidate,
    tokenSimilarity,
    tokenize
};
