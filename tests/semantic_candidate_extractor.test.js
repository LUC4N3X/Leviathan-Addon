'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
    extractEmbedCandidates,
    extractResilientEmbeds,
    normalizeEscapedText
} = require('../providers/extractors/semantic_candidate_extractor');

test('semantic extractor finds hoster URLs without relying on HTML structure', () => {
    const html = `
        <section class="completely-new-layout">
            <button data-random="x">Play</button>
            <script>
                window.__payload = { anything: "https:\/\/mixdrop.co\/e\/abc123?x=1&y=2" };
            </script>
            <template>{{ player: 'https://maxstream.video/e/demo456' }}</template>
        </section>
    `;

    const urls = extractResilientEmbeds(html, { maxCandidates: 10 });
    assert.ok(urls.some((url) => /mixdrop\.co\/e\/abc123/i.test(url)));
    assert.ok(urls.some((url) => /maxstream\.video\/e\/demo456/i.test(url)));
});

test('semantic extractor decodes url encoded and base64 payload candidates', () => {
    const encoded = encodeURIComponent('https://uprot.net/embed/abc987');
    const b64 = Buffer.from('<iframe src="https://voe.sx/e/qwerty"></iframe>').toString('base64');
    const html = `<script>const a = "${encoded}"; const b = atob("${b64}");</script>`;

    const candidates = extractEmbedCandidates(html, { maxCandidates: 10 });
    assert.ok(candidates.some((item) => /uprot\.net\/embed\/abc987/i.test(item.url)));
    assert.ok(candidates.some((item) => /voe\.sx\/e\/qwerty/i.test(item.url)));
});

test('normalizeEscapedText handles common escaped URL variants', () => {
    assert.equal(
        normalizeEscapedText('https:\/\/mxcontent.net\/e\/id\u003fdownload\u003d1'),
        'https://mxcontent.net/e/id?download=1'
    );
});

test('semantic extractor recovers scheme-less hoster links', () => {
    const html = `
        <div class="server" data-go="mixdrop.co/e/scheme123">MixDrop</div>
        <span>Guarda su voe.sx/e/abcd anche senza protocollo</span>
    `;

    const urls = extractResilientEmbeds(html, { maxCandidates: 10 });
    assert.ok(urls.some((url) => /^https:\/\/mixdrop\.co\/e\/scheme123/i.test(url)));
    assert.ok(urls.some((url) => /^https:\/\/voe\.sx\/e\/abcd/i.test(url)));
});

test('semantic extractor decodes char-code array URLs', () => {
    const url = 'https://maxstream.video/e/charcode1';
    const codes = Array.from(url).map((char) => char.charCodeAt(0)).join(',');
    const html = `<script>var u = String.fromCharCode(${codes}); play(u);</script>`;

    const urls = extractResilientEmbeds(html, { maxCandidates: 10 });
    assert.ok(urls.some((item) => /maxstream\.video\/e\/charcode1/i.test(item)));
});

test('semantic extractor reassembles concatenated string URLs', () => {
    const html = `<script>var src = "https://mix" + "drop.co/e/" + "concat99";</script>`;

    const urls = extractResilientEmbeds(html, { maxCandidates: 10 });
    assert.ok(urls.some((url) => /mixdrop\.co\/e\/concat99/i.test(url)));
});
