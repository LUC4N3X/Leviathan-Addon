'use strict';

const { webProviderRecipe } = require('./_shared');

module.exports = webProviderRecipe({
    id: 'eurostreaming',
    key: 'eurostreaming',
    name: 'Eurostreaming',
    aliases: ['Eurostreaming', 'webEs'],
    tags: ['series', 'web', 'mfp', 'episode-aware', 'uprot'],
    selectors: {
        resultItems: 'article, .post, .result-item',
        title: '.entry-title, .post-title, h1, h2, h3',
        href: 'a@href',
        year: '.year, .date, [data-year]',
        quality: '.quality, [data-quality]',
        language: '.language, [data-language]'
    },
    parsing: {
        titleCleaner: 'standardSeriesTitle',
        episodePolicy: 'strict-season-episode-or-pack',
        languagePolicy: 'ita-preferred',
        resolverPolicy: 'mfp-uprot-first'
    },
    antiBot: {
        mode: 'flaresolverr-compatible',
        proxy: 'mfp-for-hosters',
        sessionReuse: true
    },
    fallback: [
        { id: 'wp-rest-search', stopOnHit: true },
        { id: 'title-year-match', stopOnHit: true }
    ],
    timeouts: { searchMs: 9000, detailMs: 9000, resolveMs: 12000 },
    reliability: { initial: 'experimental', decayOn: ['selector_miss', 'wrong_episode', 'uprot_missing_state'] }
});
