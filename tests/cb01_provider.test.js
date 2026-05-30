'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { __private } = require('../providers/cb01/cb01_handler');

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

test('CB01 normalizes bare domains and query strings safely', () => {
    assert.equal(__private.normalizeBaseUrl('cb01.bar/'), 'https://cb01.bar');
    assert.equal(__private.normalizeBaseUrl('https://cb01.bar/path'), 'https://cb01.bar');
    assert.equal(__private.buildSearchQuery("L'uomo & il mare: città"), 's=L%27uomo+%26+il+mare%3A+citta');
});

test('CB01 resolves relative card and episode links', () => {
    const cards = __private.extractCardCandidates(`
        <div class="card-content">
          <h3 class="card-title"><a href="/film/test-film-2024/">Test Film</a></h3>
          <span style="color:#ccc">2024</span>
        </div>
    `, 'https://cb01.bar');

    assert.equal(cards.length, 1);
    assert.equal(cards[0].href, 'https://cb01.bar/film/test-film-2024/');

    const anchors = __private.findStandardEpisodeLinks(`
        <p>01×2 – <a href="/goto/maxstream">MaxStream</a> – <a href="https://mixdrop.example/e/abc">MixDrop</a></p>
    `, 1, 2, 'https://cb01.bar');

    assert.equal(anchors.length, 2);
    assert.equal(anchors[0].href, 'https://cb01.bar/goto/maxstream');
});

test('CB01 challenge detection catches anti-bot pages', () => {
    assert.equal(__private.isChallengePage('<title>Just a moment...</title><script>cf-chl</script>'), true);
    assert.equal(__private.isChallengePage('<html><body>normal page</body></html>'), false);
});

test('CB01 builds forward fetch URLs from the single FORWARD_PROXY env', () => {
    withEnvironment({
        FORWARD_PROXY: 'https://proxy.example/forward?url=',
        CB01_FORWARD_PROXY: 'https://legacy.example/forward?url=',
        FORWARDPROXY: 'https://legacy-alias.example/forward?url='
    }, () => {
        assert.equal(
            __private.buildCbForwardProxyUrl('https://cb01.example/search?q=one&lang=it'),
            'https://proxy.example/forward?url=https%3A%2F%2Fcb01.example%2Fsearch%3Fq%3Done%26lang%3Dit'
        );
    });
});
