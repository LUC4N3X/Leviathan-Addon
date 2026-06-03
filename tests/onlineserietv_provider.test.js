'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { __private } = require('../providers/onlineserietv/onlineserietv_handler');

function withEnvironment(values, fn) {
    const previous = {};
    for (const [name, value] of Object.entries(values)) {
        previous[name] = process.env[name];
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
    }
    try {
        return fn();
    } finally {
        for (const [name, value] of Object.entries(previous)) {
            if (value === undefined) delete process.env[name];
            else process.env[name] = value;
        }
    }
}

test('OnlineSerieTV builds the SearchWP admin-ajax URL like MammaMia', () => {
    assert.equal(__private.cleanShowName("Marvel's Daredevil"), 'Marvel s Daredevil');
    const url = __private.buildSearchUrl('https://onlineserietv.lol', 'Breaking Bad');
    assert.ok(url.startsWith('https://onlineserietv.lol/wp-admin/admin-ajax.php?'));
    assert.ok(url.includes('action=searchwp_live_search'));
    assert.ok(url.includes('s=Breaking%20Bad'));
    assert.ok(url.includes('swpquery=Breaking%20Bad'));
    assert.ok(url.includes('origin_id=50141'));
});

test('OnlineSerieTV ranks film/serietv candidates and resolves relative hrefs', () => {
    const html = `
        <a href="https://onlineserietv.lol/serietv/breaking-bad/">Breaking Bad</a>
        <a href="/film/qualche-film-2019/">Qualche Film</a>
        <a href="https://onlineserietv.lol/serietv/altro/">Altro Show</a>
    `;
    const anchors = __private.collectAnchors(html, 'https://onlineserietv.lol');
    assert.equal(anchors.length, 3);
    assert.equal(anchors[1].href, 'https://onlineserietv.lol/film/qualche-film-2019/');

    const series = __private.rankCandidates(anchors, 'series', 'Breaking Bad');
    assert.equal(series[0].href, 'https://onlineserietv.lol/serietv/breaking-bad/');
    assert.ok(series[0].score >= series[1].score);

    const movies = __private.rankCandidates(anchors, 'movie', 'Qualche Film');
    assert.equal(movies.length, 1);
    assert.equal(movies[0].href, 'https://onlineserietv.lol/film/qualche-film-2019/');
});

test('OnlineSerieTV extracts the uprot/msf link for the requested episode', () => {
    const seriesPage = `
        <div>Anno: <i>2008</i></div>
        <div>01x01 <a href="https://uprot.net/msf/AAAA">MaxStream</a></div>
        <div>01x02 <a href="https://uprot.net/msf/BBBB">MaxStream</a></div>
        <div>02x05 <a href="https://uprot.net/msf/CCCC">MaxStream</a></div>
    `;
    assert.equal(__private.extractPageYear(seriesPage), 2008);
    assert.equal(__private.extractSeriesUprot(seriesPage, 1, 2), 'https://uprot.net/msf/BBBB');
    assert.equal(__private.extractSeriesUprot(seriesPage, 2, 5), 'https://uprot.net/msf/CCCC');
    assert.equal(__private.extractSeriesUprot(seriesPage, 9, 9), null);

    const moviePage = '<div>Anno: <i>1999</i></div> <a href="https://uprot.net/msf/MOVIE?x=1">play</a>';
    assert.equal(__private.extractMovieUprot(moviePage), 'https://uprot.net/msf/MOVIE?x=1');
});

test('OnlineSerieTV year matching is exact-first with a small tolerance', () => {
    assert.equal(__private.yearAccepted(2008, 2008), true);
    assert.equal(__private.yearAccepted(2008, 2009), true); // default tolerance 1
    assert.equal(__private.yearAccepted(2008, 2011), false);
    assert.equal(__private.yearAccepted(null, 2008), true); // lenient when page year missing
    assert.equal(__private.yearAccepted(2008, null), true); // lenient when meta year missing
});

test('OnlineSerieTV builds forward fetch URLs from the single FORWARD_PROXY env (like CB01)', () => {
    withEnvironment({ FORWARD_PROXY: 'https://proxy.example/forward?url=' }, () => {
        assert.equal(__private.getOstForwardProxy(), 'https://proxy.example/forward?url=');
        const forwarded = __private.buildOstForwardProxyUrl('https://onlineserietv.lol/serietv/show/?x=1&y=2');
        assert.ok(forwarded.startsWith('https://proxy.example/forward?url='));
        assert.ok(/onlineserietv\.lol/.test(decodeURIComponent(forwarded)));
    });
    withEnvironment({ FORWARD_PROXY: '0' }, () => {
        assert.equal(__private.getOstForwardProxy(), '');
    });
});

test('OnlineSerieTV is registered as a web provider gated by enableOnlineserietv', () => {
    const reg = require('../providers/extractors/provider_registry');
    const def = reg.getWebProviderDefinition('onlineserietv');
    assert.ok(def, 'definition present');
    assert.equal(def.recipeId, 'onlineserietv');
    assert.equal(def.limiterKey, 'webOnlineserietv');
    assert.equal(def.isEnabled({ filters: { enableOnlineserietv: true } }), true);
    assert.equal(def.isEnabled({ filters: {} }), false);
    assert.equal(typeof def.run, 'function');
});
