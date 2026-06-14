'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { __private } = require('../providers/guardahd/ghd_handler');

test('GuardaHD keeps DeltaBit redirectors and supported direct hosters from page HTML', () => {
    const html = `
        <a href="https://safego.cc/redirect/abc">DeltaBit</a>
        <a href="https://clicka.cc/adelta/xyz">DeltaBit Mirror</a>
        <iframe src="https://deltabit.co/e/file123"></iframe>
        <a href="https://loadm.cam/e/load123">LoadM</a>
        <a href="https://supervideo.tv/e/super123">SuperVideo</a>
        <a href="https://streamtape.com/e/tape123">StreamTape</a>
        <a href="https://uqload.io/embed-uq123.html">Uqload</a>
        <a href="https://dhcplay.com/e/hg123">StreamHG</a>
        <a href="https://mixdrop.co/e/mix123">MixDrop</a>
    `;

    const urls = __private.extractEmbedUrlsFromHtml(html, 'https://guardahd.stream/set-movie-a/tt1234567');

    assert.ok(urls.includes('https://safego.cc/redirect/abc'));
    assert.ok(urls.includes('https://clicka.cc/adelta/xyz'));
    assert.ok(urls.includes('https://deltabit.co/e/file123'));
    assert.ok(urls.includes('https://loadm.cam/e/load123'));
    assert.ok(urls.includes('https://supervideo.tv/e/super123'));
    assert.ok(urls.includes('https://streamtape.com/e/tape123'));
    assert.ok(urls.includes('https://uqload.io/embed-uq123.html'));
    assert.ok(urls.includes('https://dhcplay.com/e/hg123'));
    assert.ok(urls.includes('https://mixdrop.co/e/mix123'));
    assert.equal(__private.hosterFromUrl('https://safego.cc/redirect/abc'), 'deltabit');
    assert.equal(__private.hosterFromUrl('https://clicka.cc/adelta/xyz'), 'deltabit');
});
