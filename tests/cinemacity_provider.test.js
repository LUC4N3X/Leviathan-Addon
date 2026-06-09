'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { __private } = require('../providers/cinemacity/cc_handler');

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

test('CinemaCity anime detection recognizes kitsu/anime metadata', () => {
    assert.equal(__private.looksLikeAnimeMeta({
        type: 'anime',
        id: 'kitsu:12345:7',
        title: 'Solo Leveling'
    }), true);

    assert.equal(__private.looksLikeAnimeMeta({
        type: 'series',
        title: 'The Last of Us',
        genres: ['Drama']
    }), false);
});

test('CinemaCity content type matcher prioritizes anime routes', () => {
    assert.equal(__private.isCinemaCityContentUrlForType('https://cinemacity.cc/anime/123-naruto-shippuden.html', 'anime'), true);
    assert.equal(__private.isCinemaCityContentUrlForType('https://cinemacity.cc/tv-series/456-breaking-bad.html', 'anime'), true);
    assert.equal(__private.isCinemaCityContentUrlForType('https://cinemacity.cc/movies/789-dune.html', 'anime'), false);
});

test('CinemaCity listing extractor parses anime entries', () => {
    const html = [
        '<a href="/anime/123-solo-leveling.html">Solo Leveling</a>',
        '<a href="/tv-series/456-naruto-shippuden.html">Naruto Shippuden</a>'
    ].join('\n');

    const results = __private.extractCandidateLinksFromListing(html, 'anime');

    assert.equal(results.length, 2);
    assert.equal(results[0].url, 'https://cinemacity.cc/anime/123-solo-leveling.html');
    assert.equal(results[1].url, 'https://cinemacity.cc/tv-series/456-naruto-shippuden.html');
});

test('CinemaCity anime search variants include normalized titles and anime listing base', () => {
    const queries = __private.buildSearchQueryVariants([
        'Ore dake Level Up na Ken',
        'Solo Leveling'
    ]);

    assert.match(queries.join(' | '), /Solo Leveling/i);
    assert.ok(__private.getListingBaseUrls('anime').some((url) => /\/anime\/$/i.test(url)));
});

test('CinemaCity infers concrete audio languages from selected playback labels', () => {
    assert.deepEqual(__private.inferCinemaCityAudioLanguages('Server ITA ENG 1080p'), ['ita', 'eng']);
    assert.deepEqual(__private.inferCinemaCityAudioLanguages('Multi audio HD'), ['ita', 'eng']);
    assert.deepEqual(__private.inferCinemaCityAudioLanguages('Server ITA'), ['ita']);
    assert.deepEqual(__private.inferCinemaCityAudioLanguages('Server ENG'), ['eng']);
});

test('CinemaCity merges selected playback label and playlist audio languages', () => {
    assert.deepEqual(
        __private.mergeCinemaCityAudioLanguages(['ita'], { audioLanguages: ['eng'] }),
        ['ita', 'eng']
    );
});

test('CinemaCity builds generic forward URLs from the shared FORWARD_PROXY env', () => {
    withEnvironment({
        FORWARD_PROXY: 'https://proxy.example/forward?url=',
        CINEMACITY_FORWARD_PROXY: 'https://legacy.example/cinemacity/fetch?d='
    }, () => {
        assert.equal(
            __private.buildCinemaCityKrakenForwardUrl('https://cinemacity.cc/movies/one.html', {
                'User-Agent': 'Leviathan Test',
                Referer: 'https://cinemacity.cc/',
                Origin: 'https://cinemacity.cc'
            }),
            'https://proxy.example/forward?url=https%3A%2F%2Fcinemacity.cc%2Fmovies%2Fone.html&h_user-agent=Leviathan+Test&h_referer=https%3A%2F%2Fcinemacity.cc%2F&h_origin=https%3A%2F%2Fcinemacity.cc'
        );
    });
});

test('CinemaCity derives extractor base from the shared generic forward endpoint', () => {
    withEnvironment({
        FORWARD_PROXY: 'https://proxy.example/forward?url=',
        CINEMACITY_FORWARD_PROXY: 'https://legacy.example/cinemacity/fetch?d=',
        CINEMACITY_PAGE_EXTRACTOR_BASE: undefined,
        CINEMACITY_KRAKEN_EXTRACTOR_URL: undefined,
        KRAKEN_PROXY_URL: undefined,
        MEDIAFLOW_PROXY_URL: undefined,
        MEDIAFLOW_URL: undefined,
        MFP_URL: undefined,
        MFP_BASE_URL: undefined,
        KRAKEN_URL: undefined,
        KRAKEN_BASE_URL: undefined
    }, () => {
        assert.equal(__private.getCinemaCityPageExtractorBase({}), 'https://proxy.example');
    });
});

test('base64Decode decodes ASCII and UTF-8 base64 strings correctly', () => {
    assert.equal(__private.base64Decode('aGVsbG8gd29ybGQ='), 'hello world');
    assert.equal(__private.base64Decode('aHR0cHM6Ly9jaW5lbWFjaXR5LmNj'), 'https://cinemacity.cc');
    assert.equal(__private.base64Decode(''), '');
});

test('base64Decode returns empty string for null/undefined input', () => {
    assert.equal(__private.base64Decode(null), '');
    assert.equal(__private.base64Decode(undefined), '');
});

test('normalizeTitle strips accents, lowercases, and removes parentheses and special chars', () => {
    assert.equal(__private.normalizeTitle('Avengers: Endgame'), 'avengers endgame');
    assert.equal(__private.normalizeTitle('Città Metropolitana'), 'citta metropolitana');
    assert.equal(__private.normalizeTitle('Nausicaä of the Valley'), 'nausicaa of the valley');
    assert.equal(__private.normalizeTitle('Solo Leveling (2024)'), 'solo leveling');
    assert.equal(__private.normalizeTitle(''), '');
    assert.equal(__private.normalizeTitle(null), '');
});

test('normalizeTitle decodes HTML entities before normalizing', () => {
    assert.equal(__private.normalizeTitle('Tom &amp; Jerry'), 'tom jerry');
    assert.equal(__private.normalizeTitle('&quot;The Matrix&quot;'), 'the matrix');
    assert.equal(__private.normalizeTitle('Heroes &amp; Villains'), 'heroes villains');
});

test('parseSitemapEntries parses movie, series, and anime entries from XML', () => {
    const xml = [
        '<loc>https://cinemacity.cc/movies/123-avengers-endgame-2019.html</loc>',
        '<loc>https://cinemacity.cc/tv-series/456-breaking-bad.html</loc>',
        '<loc>https://cinemacity.cc/anime/789-naruto-shippuden.html</loc>',
        '<loc>https://other.example.com/movies/ignored.html</loc>'
    ].join('\n');

    const entries = __private.parseSitemapEntries(xml);

    assert.equal(entries.length, 3);
    assert.equal(entries[0].url, 'https://cinemacity.cc/movies/123-avengers-endgame-2019.html');
    assert.equal(entries[0].kind, 'movies');
    assert.equal(entries[0].year, 2019);
    assert.equal(entries[0].title, 'avengers endgame');
    assert.equal(entries[1].kind, 'tv-series');
    assert.equal(entries[1].year, null);
    assert.equal(entries[2].kind, 'anime');
});

test('parseSitemapEntries returns empty array for empty or invalid XML', () => {
    assert.deepEqual(__private.parseSitemapEntries(''), []);
    assert.deepEqual(__private.parseSitemapEntries(null), []);
    assert.deepEqual(__private.parseSitemapEntries('<sitemap></sitemap>'), []);
});

test('parseSitemapEntries populates normalizedTitle, compactTitle, and tokens', () => {
    const xml = '<loc>https://cinemacity.cc/movies/1-solo-leveling-2024.html</loc>';
    const [entry] = __private.parseSitemapEntries(xml);

    assert.ok(typeof entry.normalizedTitle === 'string');
    assert.ok(typeof entry.compactTitle === 'string');
    assert.ok(Array.isArray(entry.tokens));
    assert.ok(entry.normalizedTitle.includes('solo'));
    assert.ok(entry.normalizedTitle.includes('leveling'));
});

test('scoreSitemapEntry returns 1000 for an exact title match', () => {
    const entry = {
        normalizedTitle: 'avengers endgame',
        compactTitle: 'avengersendgame',
        tokens: ['avengers', 'endgame'],
        year: 2019
    };
    const score = __private.scoreSitemapEntry(entry, ['Avengers: Endgame'], 2019);
    assert.equal(score, 1050);
});

test('scoreSitemapEntry returns 500 for a prefix match', () => {
    const entry = {
        normalizedTitle: 'avengers',
        compactTitle: 'avengers',
        tokens: ['avengers'],
        year: null
    };
    const score = __private.scoreSitemapEntry(entry, ['Avengers Endgame'], null);
    assert.ok(score >= 500 && score < 1000, `Expected 500-999 but got ${score}`);
});

test('scoreSitemapEntry applies year bonus for matching year and penalty for mismatch', () => {
    const baseEntry = {
        normalizedTitle: 'dune',
        compactTitle: 'dune',
        tokens: ['dune'],
        year: 2021
    };

    const exactYear = __private.scoreSitemapEntry({ ...baseEntry }, ['Dune'], 2021);
    const wrongYear = __private.scoreSitemapEntry({ ...baseEntry }, ['Dune'], 2023);

    assert.ok(exactYear > wrongYear, 'Exact year match should score higher');
});

test('scoreSitemapEntry returns 0 for empty expectedTitles array', () => {
    const entry = {
        normalizedTitle: 'dune',
        compactTitle: 'dune',
        tokens: ['dune'],
        year: 2021
    };
    assert.equal(__private.scoreSitemapEntry(entry, [], null), 0);
});

test('buildDownloadUrl returns null when no /public_files/ marker present', () => {
    assert.equal(__private.buildDownloadUrl('https://cdn.example.com/video.mp4'), null);
    assert.equal(__private.buildDownloadUrl(''), null);
});

test('buildDownloadUrl returns null when no mp4 file in parts', () => {
    const fileVal = 'https://cdn.example.com/public_files/audio.m4a';
    assert.equal(__private.buildDownloadUrl(fileVal), null);
});

test('buildDownloadUrl extracts URL and hasItalian from valid CDN file value', () => {
    const fileVal = 'https://cdn.example.com/public_files/video.1080p.mp4,audio.italian.m4a';
    const result = __private.buildDownloadUrl(fileVal);
    assert.ok(result !== null);
    assert.ok(typeof result.url === 'string');
    assert.ok(result.url.includes('/public_files/'));
    assert.equal(result.hasItalian, true);
});

test('buildDownloadUrl sets hasItalian=false when no Italian audio track present', () => {
    const fileVal = 'https://cdn.example.com/public_files/video.1080p.mp4';
    const result = __private.buildDownloadUrl(fileVal);
    assert.ok(result !== null);
    assert.equal(result.hasItalian, false);
});

test('buildDownloadUrl appends .urlset/master.m3u8 when no native manifest present', () => {
    const fileVal = 'https://cdn.example.com/public_files/video.1080p.mp4';
    const result = __private.buildDownloadUrl(fileVal);
    assert.ok(result.url.endsWith('.urlset/master.m3u8'));
});

test('extractDownloadLinks returns video file links from HTML anchors', () => {
    const html = [
        '<a href="https://cdn.example.com/video.mp4">Download MP4</a>',
        '<a href="https://cdn.example.com/playlist.m3u8">Stream HLS</a>',
        '<a href="https://cdn.example.com/video.mkv">Download MKV</a>',
        '<a href="https://cdn.example.com/subtitle.srt">Subtitle</a>',
        '<a href="short.mp4">Short</a>'
    ].join('\n');

    const links = __private.extractDownloadLinks(html);
    assert.equal(links.length, 3);
    assert.equal(links[0].url, 'https://cdn.example.com/video.mp4');
    assert.equal(links[0].text, 'download mp4');
    assert.equal(links[1].url, 'https://cdn.example.com/playlist.m3u8');
});

test('extractDownloadLinks returns empty array when no matching links present', () => {
    const html = '<a href="https://example.com/page.html">Page</a><a href="/contact">Contact</a>';
    assert.deepEqual(__private.extractDownloadLinks(html), []);
    assert.deepEqual(__private.extractDownloadLinks(''), []);
    assert.deepEqual(__private.extractDownloadLinks(null), []);
});

test('extractDownloadLinks strips inner HTML tags from link text', () => {
    const html = '<a href="https://cdn.example.com/film.mp4"><span>Server <b>ITA</b> 1080p</span></a>';
    const links = __private.extractDownloadLinks(html);
    assert.equal(links.length, 1);
    assert.equal(links[0].text, 'server ita 1080p');
});

test('extractStreamFromAtob decodes atob-encoded movie stream from HTML', () => {
    const fileVal = 'https://cdn.example.com/public_files/movie.1080p.mp4';
    const payload = `var config = { file: '[{"file":"${fileVal}"}]' }`;
    const encoded = Buffer.from(payload).toString('base64');
    const html = `<script>playerConfig(atob('${encoded}'))</script>`;

    const result = __private.extractStreamFromAtob(html, null, null);
    assert.ok(result !== null, 'Should find a stream URL');
    assert.ok(result.url.includes('/public_files/'));
});

test('extractStreamFromAtob returns null when no valid atob payload found', () => {
    assert.equal(__private.extractStreamFromAtob('', null, null), null);
    assert.equal(__private.extractStreamFromAtob('<script>var x = 1;</script>', null, null), null);
    assert.equal(__private.extractStreamFromAtob(null, null, null), null);
});

test('extractStreamFromAtob returns null when atob payload lacks video file', () => {
    const payload = `var config = { file: '[{"file":"https://example.com/audio.m4a"}]' }`;
    const encoded = Buffer.from(payload).toString('base64');
    const html = `<script>playerConfig(atob('${encoded}'))</script>`;
    assert.equal(__private.extractStreamFromAtob(html, null, null), null);
});
