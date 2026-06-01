'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { extractFromUrl, resolveExtractorDefinition } = require('../providers/extractors/registry');
const { extractTurbovid, isTurbovidUrl, normalizeTurbovidUrl } = require('../providers/extractors/hosters/turbovid');
const { extractEurostreamingEpisodeBlocks, pickHostLinks, __private: esPrivate } = require('../providers/eurostreaming/es_handler');

class FakeClient {
    constructor(routes = {}) {
        this.routes = routes;
        this.requests = [];
    }

    async get(url, options = {}) {
        this.requests.push({ method: 'GET', url, options });
        const value = this.routes[`GET ${url}`];
        if (value == null) return { status: 404, data: '' };
        return typeof value === 'function' ? value(url, options) : value;
    }

    async post(url, body, options = {}) {
        this.requests.push({ method: 'POST', url, body, options });
        const value = this.routes[`POST ${url}`];
        if (value == null) return { status: 404, data: '' };
        return typeof value === 'function' ? value(url, body, options) : value;
    }
}

test('TurboVid extractor unwraps MediaFlow d= targets and resolves urlPlay to final HLS', async () => {
    const playerUrl = 'https://turbovid.me/w3lup4ug0ps7';
    const endpointUrl = 'https://turbovid.me/player/source?w3lup4ug0ps7';
    const hlsUrl = 'https://turbovidhls.com/hls/w3lup4ug0ps7/master.m3u8';
    const client = new FakeClient({
        [`GET ${playerUrl}`]: { status: 200, data: `<script>urlPlay = '/player/source?w3lup4ug0ps7';</script>` },
        [`GET ${endpointUrl}`]: { status: 200, data: JSON.stringify({ file: hlsUrl }) },
        [`GET ${hlsUrl}`]: { status: 200, data: '#EXTM3U\n#EXT-X-STREAM-INF:RESOLUTION=1920x1080\n1080.m3u8' }
    });

    const wrapped = `https://kraken.test/extractor/video?host=Turbovid&api_password=secret&d=${encodeURIComponent(playerUrl)}&redirect_stream=true`;
    const result = await extractTurbovid(wrapped, { client, userAgent: 'Turbo-UA' });

    assert.equal(result.url, hlsUrl);
    assert.equal(result.extractor, 'TurboVid');
    assert.equal(result.headers.Referer, playerUrl);
    assert.equal(result.headers.Origin, 'https://turbovid.me');
    assert.equal(result.headers['User-Agent'], 'Turbo-UA');
    assert.equal(client.requests[0].url, playerUrl);
});

test('TurboVid extractor supports Proceed-to-video form fallback', async () => {
    const playerUrl = 'https://turbovid.me/formcase';
    const endpointUrl = 'https://turbovid.me/formcase';
    const hlsUrl = 'https://turbovidhls.com/hls/formcase/master.m3u8';
    const client = new FakeClient({
        [`GET ${playerUrl}`]: {
            status: 200,
            data: `<form method="POST"><input type="hidden" name="op" value="download1"><input type="hidden" name="id" value="formcase"><button type="submit" name="imhuman" value="Proceed to video">Proceed to video</button></form>`
        },
        [`POST ${endpointUrl}`]: { status: 200, data: `<script>const videoUrl = '${hlsUrl}';</script>` },
        [`GET ${hlsUrl}`]: { status: 200, data: '#EXTM3U' }
    });

    const result = await extractTurbovid(playerUrl, { client });

    assert.equal(result.url, hlsUrl);
    assert.equal(client.requests.some((request) => request.method === 'POST'), true);
});

test('TurboVid is exposed through the shared extractor registry', async () => {
    const playerUrl = 'https://turbovid.me/abc123';
    const hlsUrl = 'https://turbovidhls.com/hls/abc123/master.m3u8';
    const client = new FakeClient({
        [`GET ${playerUrl}`]: { status: 200, data: `<script>urlPlay='${hlsUrl}'</script>` },
        [`GET ${hlsUrl}`]: { status: 200, data: '#EXTM3U' }
    });

    const definition = resolveExtractorDefinition(playerUrl);
    assert.equal(definition.key, 'turbovid');

    const result = await extractFromUrl(playerUrl, { client });
    assert.equal(result.key, 'turbovid');
    assert.equal(result.url, hlsUrl);
});

test('Eurostreaming classifies SafeGo TurboVid links separately from DeltaBit', () => {
    const links = pickHostLinks('<a href="https://safego.cc/?d=https%3A%2F%2Fturbovid.me%2Fw3lup4ug0ps7">TurboVid</a>');

    assert.equal(links.length, 1);
    assert.equal(links[0].host, 'turbovid');
    assert.equal(links[0].label, 'TurboVid');
    assert.equal(esPrivate.isTurbovidLikeUrl('https://turbovid.me/w3lup4ug0ps7'), true);
    assert.equal(esPrivate.isDeltabitLikeUrl('https://turbovid.me/w3lup4ug0ps7'), false);
});


test('Eurostreaming keeps TurboVid labels even when Clicka uses adelta-style paths', () => {
    const links = pickHostLinks('<a href="https://clicka.cc/adelta/encodedTurboTarget">TurboVid</a>');

    assert.equal(links.length, 1);
    assert.equal(links[0].host, 'turbovid');
});

test('Eurostreaming extracts episode blocks that contain only TurboVid links', () => {
    const blocks = extractEurostreamingEpisodeBlocks('1x02 <a href="https://safego.cc/safe.php?url=abc">TurboVid</a>', 1, 2);

    assert.equal(blocks.length, 1);
    assert.equal(pickHostLinks(blocks[0].html)[0].host, 'turbovid');
});

test('TurboVid URL helpers recognize all known host variants', () => {
    assert.equal(isTurbovidUrl('https://turbovid.me/w3lup4ug0ps7'), true);
    assert.equal(isTurbovidUrl('https://emturbovid.com/embed/abc'), true);
    assert.equal(isTurbovidUrl('https://stbturbo.xyz/abc'), true);
    assert.equal(normalizeTurbovidUrl('https://proxy.test/extractor/video?d=https%3A%2F%2Fturboviplay.com%2Fabc&api_password=x'), 'https://turboviplay.com/abc');
});

test('Eurostreaming sends TurboVid fallback to Kraken TurboVidPlay HLS extractor', async () => {
    const previousLocalFirst = process.env.EUROSTREAMING_TURBOVID_LOCAL_PROXY_FIRST;
    delete process.env.EUROSTREAMING_TURBOVID_MFP_HOST;
    delete process.env.EUROSTREAMING_TURBOVID_MFP_PATH;
    process.env.EUROSTREAMING_TURBOVID_LOCAL_PROXY_FIRST = 'false';

    try {
        const stream = await esPrivate.buildHostStream(
            { host: 'turbovid', label: 'TurboVid', href: 'https://turbovid.me/w3lup4ug0ps7' },
            {
                client: new FakeClient(),
                config: { mediaflow: { url: 'https://kraken.test', pass: 'secret' } },
                title: 'I misteri di Brokenwood — S02E02',
                language: 'ITA',
                options: { baseUrl: 'https://eurostream.ing' }
            }
        );

        assert.ok(stream);
        assert.match(stream.url, /^https:\/\/kraken\.test\/extractor\/video\.m3u8\?/);
        assert.match(stream.url, /(?:\?|&)host=TurboVidPlay(?:&|$)/);
        assert.match(stream.url, /(?:\?|&)d=https%3A%2F%2Fturbovid\.me%2Fw3lup4ug0ps7(?:&|$)/);
        assert.match(stream.url, /(?:\?|&)redirect_stream=true(?:&|$)/);
        assert.match(stream.url, /(?:\?|&)h_referer=https%3A%2F%2Fturbovid\.me%2F(?:&|$)/);
        assert.equal(stream.behaviorHints?.vortexMeta?.streamKind, 'hls');
        assert.equal(stream.behaviorHints?.vortexMeta?.via, 'mfp');
    } finally {
        if (previousLocalFirst === undefined) delete process.env.EUROSTREAMING_TURBOVID_LOCAL_PROXY_FIRST;
        else process.env.EUROSTREAMING_TURBOVID_LOCAL_PROXY_FIRST = previousLocalFirst;
    }
});

test('TurboVid URL helper unwraps url/target/source aliases too', () => {
    assert.equal(
        normalizeTurbovidUrl('https://kraken.test/extractor/video.m3u8?host=TurboVidPlay&url=https%3A%2F%2Fturbovid.me%2Falias&api_password=x'),
        'https://turbovid.me/alias'
    );
    assert.equal(
        normalizeTurbovidUrl('https://proxy.test/path?target=https%3A%2F%2Femturbovid.com%2Fabc&api_password=x'),
        'https://emturbovid.com/abc'
    );
});
