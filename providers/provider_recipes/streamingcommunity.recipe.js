'use strict';

const { webProviderRecipe } = require('./_shared');

module.exports = webProviderRecipe({
    id: 'streamingcommunity',
    key: 'streamingCommunity',
    name: 'StreamingCommunity',
    aliases: ['StreamingCommunity', 'Vix', 'webVix'],
    tags: ['movie', 'series', 'web', 'lazy-extraction'],
    selectors: {
        resultItems: '[data-provider-result], .movie-card, .series-card, .result-item, article',
        title: '[data-title], .title, .name, h2, h3',
        href: 'a@href',
        year: '.year, .date, [data-year]',
        quality: '.quality, [data-quality]',
        language: '.language, [data-language]'
    },
    recovery: {
        enabled: true,
        triggerOn: ['selector_miss', 'layout_changed'],
        strategy: 'anchor-candidate-scoring',
        minScore: 0.62,
        maxCandidates: 8,
        allowDomains: ['same-origin'],
        denyPatterns: ['/login', '/register', '/privacy', '/cookie', '/dmca', '/category', '/tag', '/search']
    },
    parsing: {
        titleCleaner: 'standardMovieTitle',
        episodePolicy: 'strict-season-episode-or-movie',
        languagePolicy: 'ita-preferred',
        resolverPolicy: 'lazy-vix-direct-first'
    },
    fallback: [
        { id: 'direct-slug', stopOnHit: true },
        { id: 'site-search', stopOnHit: true },
        { id: 'provider-cache', stopOnHit: false }
    ],
    timeouts: { searchMs: 16000, detailMs: 12000, resolveMs: 16000 },
    reliability: { initial: 'good', decayOn: ['selector_miss', 'slow_resolve'] }
});
