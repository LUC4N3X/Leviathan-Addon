'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { searchGuardaserieTv, searchGuardaserieTV, parseEpisodeLinks, extractLinksFromBlock, buildVidxgoEpisodeLinks, extractVidxgoBaseFromHtml, getBaseUrls } = require('../providers/guardaserietv/gstv_handler');


test('GuardaserieTV public search exports are callable functions', () => {
    assert.equal(typeof searchGuardaserieTv, 'function');
    assert.equal(typeof searchGuardaserieTV, 'function');
});

test('GuardaserieTV parser extracts the requested season/episode links only', () => {
    const html = `
        <h3>STAGIONE 1</h3>
        <p>1x1 – <a href="https://supervideo.cc/e/super-101">Supervideo</a> <a href="https://v.vidxgo.co/e/vidx-101">VidxGo</a></p>
        <p>1x2 – <a href="https://v.vidxgo.co/e/vidx-102">VidxGo</a></p>
    `;

    const links = parseEpisodeLinks(html, 1, 1, 'https://guardaserietv.rest/serietv/demo-streaming-streaming-ita.html');

    assert.equal(links.length, 2);
    assert.equal(links[0].url, 'https://v.vidxgo.co/e/vidx-101');
    assert.equal(links[0].label, 'VidxGo');
    assert.equal(links[1].url, 'https://supervideo.cc/e/super-101');
});

test('GuardaserieTV block parser recognizes raw escaped VidxGo links', () => {
    const links = extractLinksFromBlock('player: https:\\/\\/v.vidxgo.co\\/e\\/raw123', 'https://guardaserietv.rest/serietv/demo.html');

    assert.equal(links.length, 1);
    assert.equal(links[0].url, 'https://v.vidxgo.co/e/raw123');
    assert.equal(links[0].label, 'VidxGo');
});


test('GuardaserieTV builds Easystreams-style VidxGo episode URL from show_imdb', () => {
    const html = `<script>var show_imdb = 'tt9813792';</script>`;
    const links = buildVidxgoEpisodeLinks(html, {}, 1, 2);

    assert.equal(extractVidxgoBaseFromHtml(html), 'https://v.vidxgo.co/9813792');
    assert.equal(links.length, 1);
    assert.equal(links[0].url, 'https://v.vidxgo.co/9813792/1/2');
    assert.equal(links[0].label, 'VidxGo');
    assert.equal(links[0].priority, -50);
});

test('GuardaserieTV falls back to meta imdb id for VidxGo when page has only SuperVideo links', () => {
    const html = `<p>1x2 – <a href="https://supervideo.cc/v/nmm1hjhygd9k">SuperVideo</a></p>`;
    const links = buildVidxgoEpisodeLinks(html, { imdb_id: 'tt9813792' }, 1, 2);

    assert.equal(links.length, 1);
    assert.equal(links[0].url, 'https://v.vidxgo.co/9813792/1/2');
});


test('GuardaserieTV can synthesize VidxGo episode URL from meta imdb without page html', () => {
    const links = buildVidxgoEpisodeLinks('', { id: 'tt8772296:1:1' }, 1, 1);

    assert.equal(links.length, 1);
    assert.equal(links[0].url, 'https://v.vidxgo.co/8772296/1/1');
});

test('GuardaserieTV default base list includes current Easystreams domain fallback', () => {
    const bases = getBaseUrls();

    assert.ok(bases.includes('https://guardaserietv.hair'));
    assert.ok(bases.includes('https://guardaserietv.rest'));
});
