'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { __private } = require('../providers/onlineserietv/onlineserietv_handler');

function withEnvironment(overrides, callback) {
    const previousValues = new Map();

    for (const [key, value] of Object.entries(overrides)) {
        previousValues.set(key, process.env[key]);

        if (value === undefined) {
            delete process.env[key];
        } else {
            process.env[key] = value;
        }
    }

    try {
        return callback();
    } finally {
        for (const [key, value] of previousValues.entries()) {
            if (value === undefined) {
                delete process.env[key];
            } else {
                process.env[key] = value;
            }
        }
    }
}

test('OnlineSerieTV builds SearchWP admin-ajax URLs compatible with MammaMia', () => {
    assert.equal(__private.cleanShowName("Marvel's Daredevil"), 'Marvel s Daredevil');

    const searchUrl = __private.buildSearchUrl('https://onlineserietv.lol', 'Breaking Bad');

    assert.ok(searchUrl.startsWith('https://onlineserietv.lol/wp-admin/admin-ajax.php?'));
    assert.ok(searchUrl.includes('action=searchwp_live_search'));
    assert.ok(searchUrl.includes('s=Breaking%20Bad'));
    assert.ok(searchUrl.includes('swpquery=Breaking%20Bad'));
    assert.ok(searchUrl.includes('origin_id=50141'));
});

test('OnlineSerieTV collects anchors, resolves relative URLs, and ranks candidates', () => {
    const html = `
        <a href="https://onlineserietv.lol/serietv/breaking-bad/">Breaking Bad</a>
        <a href="/film/qualche-film-2019/">Qualche Film</a>
        <a href="https://onlineserietv.lol/serietv/altro/">Altro Show</a>
    `;

    const anchors = __private.collectAnchors(html, 'https://onlineserietv.lol');

    assert.equal(anchors.length, 3);
    assert.equal(anchors[1].href, 'https://onlineserietv.lol/film/qualche-film-2019/');

    const seriesCandidates = __private.rankCandidates(anchors, 'series', 'Breaking Bad');

    assert.equal(seriesCandidates[0].href, 'https://onlineserietv.lol/serietv/breaking-bad/');
    assert.ok(seriesCandidates[0].score >= seriesCandidates[1].score);

    const movieCandidates = __private.rankCandidates(anchors, 'movie', 'Qualche Film');

    assert.equal(movieCandidates.length, 1);
    assert.equal(movieCandidates[0].href, 'https://onlineserietv.lol/film/qualche-film-2019/');
});

test('OnlineSerieTV extracts uprot/msf links for the requested series episode', () => {
    const html = `
        <div>Anno: <i>2008</i></div>
        <div>01x01 <a href="https://uprot.net/msf/AAAA">MaxStream</a></div>
        <div>01x02 <a href="https://uprot.net/msf/BBBB">MaxStream</a></div>
        <div>02x05 <a href="https://uprot.net/msf/CCCC">MaxStream</a></div>
    `;

    assert.equal(__private.extractPageYear(html), 2008);
    assert.equal(__private.extractSeriesUprot(html, 1, 2), 'https://uprot.net/msf/BBBB');
    assert.equal(__private.extractSeriesUprot(html, 2, 5), 'https://uprot.net/msf/CCCC');
    assert.equal(__private.extractSeriesUprot(html, 9, 9), null);
});

test('OnlineSerieTV extracts uprot/msf links from movie pages', () => {
    const html = `
        <div>Anno: <i>1999</i></div>
        <a href="https://uprot.net/msf/MOVIE?x=1">play</a>
    `;

    assert.equal(__private.extractPageYear(html), 1999);
    assert.equal(__private.extractMovieUprot(html), 'https://uprot.net/msf/MOVIE?x=1');
});

test('OnlineSerieTV accepts exact years and nearby release years', () => {
    assert.equal(__private.yearAccepted(2008, 2008), true);
    assert.equal(__private.yearAccepted(2008, 2009), true);
    assert.equal(__private.yearAccepted(2008, 2011), false);
    assert.equal(__private.yearAccepted(null, 2008), true);
    assert.equal(__private.yearAccepted(2008, null), true);
});

test('OnlineSerieTV builds forward proxy URLs from FORWARD_PROXY like CB01', () => {
    withEnvironment({ FORWARD_PROXY: 'https://proxy.example/forward?url=' }, () => {
        const sourceUrl = 'https://onlineserietv.lol/serietv/show/?x=1&y=2';
        const forwardedUrl = __private.buildOstForwardProxyUrl(sourceUrl);

        assert.equal(__private.getOstForwardProxy(), 'https://proxy.example/forward?url=');
        assert.ok(forwardedUrl.startsWith('https://proxy.example/forward?url='));
        assert.ok(/onlineserietv\.lol/.test(decodeURIComponent(forwardedUrl)));
    });

    withEnvironment({ FORWARD_PROXY: '0' }, () => {
        assert.equal(__private.getOstForwardProxy(), '');
    });
});

test('OnlineSerieTV is registered as a gated web provider', () => {
    const registry = require('../providers/extractors/provider_registry');
    const definition = registry.getWebProviderDefinition('onlineserietv');

    assert.ok(definition, 'definition present');
    assert.equal(definition.recipeId, 'onlineserietv');
    assert.equal(definition.limiterKey, 'webOnlineserietv');
    assert.equal(definition.isEnabled({ filters: { enableOnlineserietv: true } }), true);
    assert.equal(definition.isEnabled({ filters: {} }), false);
    assert.equal(typeof definition.run, 'function');
});
