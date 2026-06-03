'use strict';

const { webProviderRecipe } = require('./_shared');

module.exports = webProviderRecipe({
    id: 'onlineserietv',
    key: 'onlineserietv',
    name: 'OnlineSerieTV',

    aliases: [
        'OnlineSerieTV',
        'OnlineSerieTv',
        'onlineserietv',
        'webOnlineserietv',
        'ost'
    ],

    tags: [
        'series',
        'movie',
        'web',
        'italian',
        'searchwp',
        'forward-proxy',
        'mfp',
        'uprot',
        'maxstream'
    ],

    selectors: {
        resultItems: 'a[href]',
        title: 'a',
        href: 'a@href',
        year: null,
        quality: null,
        language: null
    },

    parsing: {
        titleCleaner: 'standardSeriesTitle',
        episodePolicy: 'strict-season-episode',
        languagePolicy: 'ita-only',
        resolverPolicy: 'prefer-mfp-uprot-maxstream'
    },

    antiBot: {
        mode: 'detect-and-forward',
        proxy: 'kraken-forward-origin',
        sessionReuse: true,
        challengeAware: true
    },

    fallback: [
        {
            id: 'searchwp-live-search',
            stopOnHit: true
        },
        {
            id: 'series-detail-search',
            stopOnHit: true
        },
        {
            id: 'series-episode-search',
            stopOnHit: true
        },
        {
            id: 'movie-search',
            stopOnHit: true
        }
    ],

    timeouts: {
        searchMs: 12000,
        detailMs: 12000,
        resolveMs: 14000
    },

    reliability: {
        initial: 'experimental',
        decayOn: [
            'selector_miss',
            'title_mismatch',
            'wrong_episode',
            'empty_searchwp_response',
            'uprot_missing_state',
            'cloudflare_block',
            'resolver_timeout'
        ]
    }
});
