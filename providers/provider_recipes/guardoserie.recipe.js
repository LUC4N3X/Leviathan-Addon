'use strict';

const { webProviderRecipe } = require('./_shared');

module.exports = webProviderRecipe({
    id: 'guardoserie',
    key: 'guardaSerie',
    name: 'GuardoSerie',
    aliases: ['GuardaSerie', 'GuardoSerie', 'webGs'],
    tags: ['series', 'web', 'direct-first', 'episode-aware', 'lazy-extraction'],
    selectors: {
        resultItems: '[data-provider-result], .series-card, .episode-card, .result-item, article',
        title: '[data-title], .title, .name, h2, h3',
        href: 'a@href',
        year: '.year, .date, [data-year]',
        quality: '.quality, [data-quality]',
        language: '.language, [data-language]'
    },
    parsing: {
        titleCleaner: 'standardSeriesTitle',
        episodePolicy: 'strict-season-episode-or-pack',
        languagePolicy: 'ita-preferred',
        resolverPolicy: 'lazy-direct-first'
    },
    antiBot: {
        mode: 'direct-first',
        proxy: 'disabled-by-default',
        sessionReuse: true
    },
    fallback: [
        { id: 'direct-slug', stopOnHit: true },
        { id: 'ajax-search', stopOnHit: true },
        { id: 'site-search', stopOnHit: true },
        { id: 'provider-cache', stopOnHit: false }
    ],
    timeouts: { searchMs: 8000, detailMs: 10000, resolveMs: 12000 },
    reliability: { initial: 'good', decayOn: ['selector_miss', 'wrong_episode', 'slow_resolve'] }
});
