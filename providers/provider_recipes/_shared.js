'use strict';

function webProviderRecipe(input = {}) {
    return {
        version: 1,
        enabled: true,
        mode: 'direct-first',
        headers: {
            userAgentProfile: 'chrome-desktop',
            refererPolicy: 'origin',
            static: {
                accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                'accept-language': 'it-IT,it;q=0.9,en-US;q=0.6,en;q=0.5'
            }
        },
        search: {
            method: 'GET',
            path: '',
            buildQuery: ({ title, year }) => ({ title, year })
        },
        selectors: {
            resultItems: '',
            title: '',
            href: 'a@href',
            year: '',
            quality: '',
            language: ''
        },
        parsing: {
            titleCleaner: 'standardMovieTitle',
            episodePolicy: 'strict',
            languagePolicy: 'ita-preferred',
            resultLimit: 40
        },
        fallback: [
            { id: 'direct-slug', stopOnHit: true },
            { id: 'site-search', stopOnHit: true },
            { id: 'provider-cache', stopOnHit: false }
        ],
        timeouts: {
            searchMs: 8000,
            detailMs: 9000,
            resolveMs: 12000
        },
        antiBot: {
            mode: 'direct-first',
            proxy: 'only-on-block',
            sessionReuse: true
        },
        reliability: {
            initial: 'good',
            decayOn: ['403', '429', 'timeout', 'selector_miss']
        },
        ...input
    };
}

module.exports = {
    webProviderRecipe
};
