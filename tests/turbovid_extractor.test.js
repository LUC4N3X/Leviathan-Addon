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


test('TurboVid extractor clicks Proceed-to-video with page cookies before proxying the real HLS', async () => {
    const playerUrl = 'https://turbovid.me/gs9b1wvoqch1';
    const hlsUrl = 'https://turbovidhls.com/hls/gs9b1wvoqch1/master.m3u8';
    const formHtml = `
        <script src="https://turbovid.me/js/jquery.cookie.js"></script>
        <script>$.cookie('file_id', '21947', { expires: 10 }); $.cookie('aff', '4', { expires: 10 });</script>
        <Form method="POST" action='/gs9b1wvoqch1'>
          <input type="hidden" name="op" value="download1">
          <input type="hidden" name="usr_login" value="">
          <input type="hidden" name="id" value="gs9b1wvoqch1">
          <input type="hidden" name="fname" value="I.misteri.Di.Brokenwood.1x02.La.Volpe.E.L.Uva.ITA.DTTRip.x264-UBi.mkv">
          <input type="hidden" name="hash" value="1780343225-2c20bda8f5146a72038cea503edcbcaf">
          <button type="submit" name="imhuman" value="Proceed to video" id="btn_download">
            <span id="countdown_str">Wait <span id="cxc">5</span> seconds</span>
            Proceed to video
          </button>
        </Form>`;
    const client = new FakeClient({
        [`GET ${playerUrl}`]: { status: 200, data: formHtml },
        [`POST ${playerUrl}`]: (_url, body, options) => {
            assert.match(body, /op=download1/);
            assert.match(body, /id=gs9b1wvoqch1/);
            assert.match(body, /imhuman=Proceed\+to\+video/);
            assert.match(options.headers.Cookie, /file_id=21947/);
            assert.match(options.headers.Cookie, /aff=4/);
            return { status: 200, data: `<script>const streamUrl = '${hlsUrl}';</script>` };
        },
        [`GET ${hlsUrl}`]: { status: 200, data: '#EXTM3U' }
    });

    const result = await extractTurbovid(playerUrl, { client, proceedWaitMs: 0 });

    assert.equal(result.url, hlsUrl);
    assert.match(result.headers.Cookie, /file_id=21947/);
});



test('TurboVid extractor accepts Proceed-to-video MP4 CDN links for direct proxy playback', async () => {
    const playerUrl = 'https://turbovid.me/wfhp99er11ln';
    const mp4Url = 'https://tu01.host-cdn.net/v/04/00004/hogu7zkqffwp_n/n.mp4?t=token&s=1780351264&e=43200&v=4301319&sp=250&i=0.0';
    const formHtml = `
        <script>$.cookie('file_id', '21960', { expires: 10 }); $.cookie('aff', '4', { expires: 10 });</script>
        <form method="POST" action="/wfhp99er11ln">
          <input type="hidden" name="op" value="download1">
          <input type="hidden" name="id" value="wfhp99er11ln">
          <button type="submit" name="imhuman" value="Proceed to video">Proceed to video</button>
        </form>`;
    const client = new FakeClient({
        [`GET ${playerUrl}`]: { status: 200, data: formHtml },
        [`POST ${playerUrl}`]: (_url, body, options) => {
            assert.match(body, /op=download1/);
            assert.match(options.headers.Cookie, /file_id=21960/);
            return { status: 200, data: `<script>const streamUrl = '${mp4Url}';</script>` };
        }
    });

    const result = await extractTurbovid(playerUrl, { client, proceedWaitMs: 0 });

    assert.equal(result.url, mp4Url);
    assert.equal(result.kind, 'mp4');
    assert.equal(result.quality, 'HD');
    assert.match(result.headers.Cookie, /file_id=21960/);
});

test('Eurostreaming proxies locally resolved TurboVid MP4 directly through Kraken stream endpoint', async () => {
    const previousLocalFirst = process.env.EUROSTREAMING_TURBOVID_LOCAL_PROXY_FIRST;
    process.env.EUROSTREAMING_TURBOVID_LOCAL_PROXY_FIRST = 'true';

    try {
        const playerUrl = 'https://turbovid.me/wfhp99er11ln';
        const mp4Url = 'https://tu01.host-cdn.net/v/04/00004/hogu7zkqffwp_n/n.mp4?t=token&s=1780351264&e=43200&v=4301319&sp=250&i=0.0';
        const client = new FakeClient({
            [`GET ${playerUrl}`]: { status: 200, data: `<form method="POST" action="/wfhp99er11ln"><input name="op" value="download1"><button name="imhuman" value="Proceed to video">Proceed to video</button></form>` },
            [`POST ${playerUrl}`]: { status: 200, data: `<script>const streamUrl = '${mp4Url}';</script>` }
        });

        const stream = await esPrivate.buildHostStream(
            { host: 'turbovid', label: 'TurboVid', href: playerUrl },
            {
                client,
                config: { mediaflow: { url: 'https://kraken.test', pass: 'secret' } },
                title: 'I misteri di Brokenwood — S01E02',
                language: 'ITA',
                options: { baseUrl: 'https://eurostreaming.test', proceedWaitMs: 0 }
            }
        );

        assert.ok(stream);
        assert.match(stream.url, /^https:\/\/kraken\.test\/proxy\/stream\?/);
        assert.match(stream.url, /(?:\?|&)d=https%3A%2F%2Ftu01\.host-cdn\.net%2F/);
        assert.doesNotMatch(stream.url, /\/extractor\/video\.m3u8/i);
        assert.equal(stream.behaviorHints?.vortexMeta?.via, 'turbovid-local-mfp-stream');
    } finally {
        if (previousLocalFirst === undefined) delete process.env.EUROSTREAMING_TURBOVID_LOCAL_PROXY_FIRST;
        else process.env.EUROSTREAMING_TURBOVID_LOCAL_PROXY_FIRST = previousLocalFirst;
    }
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

test('Eurostreaming delegates TurboVid playback to Kraken video extractor', async () => {
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
        assert.match(stream.url, /^https:\/\/kraken\.test\/extractor\/video\?/);
        assert.match(stream.url, /(?:\?|&)host=TurboVidPlay(?:&|$)/);
        assert.match(stream.url, /(?:\?|&)d=https%3A%2F%2Fturbovid\.me%2Fw3lup4ug0ps7(?:&|$)/);
        assert.match(stream.url, /(?:\?|&)redirect_stream=true(?:&|$)/);
        assert.match(stream.url, /(?:\?|&)h_referer=https%3A%2F%2Fturbovid\.me%2F(?:&|$)/);
        assert.equal(stream.behaviorHints?.vortexMeta?.streamKind, 'video');
        assert.equal(stream.behaviorHints?.vortexMeta?.via, 'turbovid-kraken-extractor');
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
