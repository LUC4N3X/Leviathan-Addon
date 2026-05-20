'use strict';

const { webProviderRecipe } = require('./_shared');

module.exports = webProviderRecipe({
    id: 'cb01',
    key: 'cb01',
    name: 'CB01',
    aliases: ['CB01', 'webCb01', 'cb01uno', 'cb01bar'],
    tags: ['movie', 'series', 'web', 'mfp', 'mixdrop', 'maxstream', 'uprot', 'stayonline'],
    selectors: {
        resultItems: 'div.card-content',
        title: 'h3.card-title a',
        href: 'h3.card-title a@href',
        year: 'span[style*=color], .date',
        quality: '.quality',
        language: ''
    },
    parsing: {
        titleCleaner: 'standardSeriesTitle',
        episodePolicy: 'strict-season-episode-with-range-alias',
        languagePolicy: 'ita-only',
        resolverPolicy: 'mfp-stayonline-uprot-first'
    },
    antiBot: {
        mode: 'challenge-detect-only',
        proxy: 'mfp-for-hosters',
        sessionReuse: true
    },
    fallback: [
        { id: 'movie-search', stopOnHit: true },
        { id: 'series-search', stopOnHit: true },
        { id: 'season-range-alias', stopOnHit: true }
    ],
    timeouts: { searchMs: 12000, detailMs: 14000, resolveMs: 14000 },
    reliability: { initial: 'experimental', decayOn: ['selector_miss', 'wrong_episode', 'cloudflare_block', 'stayonline_fail'] }
});
