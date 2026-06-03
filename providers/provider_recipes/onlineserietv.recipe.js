'use strict';

const { webProviderRecipe } = require('./_shared');

module.exports = webProviderRecipe({
    id: 'onlineserietv',
    key: 'onlineserietv',
    name: 'OnlineSerieTV',
    aliases: ['OnlineSerieTV', 'OnlineSerieTv', 'webOnlineserietv', 'ost', 'onlineserietv'],
    tags: ['movie', 'series', 'web', 'mfp', 'forward-proxy', 'uprot', 'maxstream', 'searchwp'],
    selectors: {
        resultItems: 'a[href]',
        title: 'a',
        href: 'a@href',
        year: '',
        quality: '',
        language: ''
    },
    parsing: {
        titleCleaner: 'standardSeriesTitle',
        episodePolicy: 'strict-season-episode',
        languagePolicy: 'ita-only',
        resolverPolicy: 'mfp-uprot-maxstream-first'
    },
    antiBot: {
        mode: 'challenge-detect-only',
        proxy: 'forward-proxy-for-origin',
        sessionReuse: true
    },
    fallback: [
        { id: 'searchwp-live-search', stopOnHit: true },
        { id: 'movie-search', stopOnHit: true },
        { id: 'series-episode-search', stopOnHit: true }
    ],
    timeouts: { searchMs: 12000, detailMs: 12000, resolveMs: 14000 },
    reliability: { initial: 'experimental', decayOn: ['selector_miss', 'wrong_episode', 'uprot_missing_state', 'cloudflare_block'] }
});
