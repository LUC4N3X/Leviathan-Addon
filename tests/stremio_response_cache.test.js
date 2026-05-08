'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const RUNTIME_PATH = '../core/utils/runtime';

const runtimeResolved = require.resolve(RUNTIME_PATH);
require.cache[runtimeResolved] = {
    id: runtimeResolved,
    filename: runtimeResolved,
    loaded: true,
    exports: {
        logger: {
            info() {},
            warn() {},
            error() {}
        },
        incrementMetric() {},
        registerCacheAccess() {},
        registerCacheSet() {}
    }
};

const {
    applyStremioStreamCacheHeaders,
    buildStremioPayloadEtag,
    maybeSendNotModified
} = require('../core/server/routes/stremio_routes');

function createResponse() {
    const headers = new Map();
    return {
        statusCode: 200,
        ended: false,
        setHeader(key, value) {
            headers.set(String(key).toLowerCase(), value);
        },
        removeHeader(key) {
            headers.delete(String(key).toLowerCase());
        },
        getHeader(key) {
            return headers.get(String(key).toLowerCase());
        },
        status(code) {
            this.statusCode = code;
            return this;
        },
        end() {
            this.ended = true;
            return this;
        }
    };
}

test.after(() => {
    delete process.env.STREMIO_ETAG_ENABLED;
    delete require.cache[runtimeResolved];
});

test.afterEach(() => {
    delete process.env.STREMIO_ETAG_ENABLED;
});

test('stream cache headers keep ETag disabled by default', () => {
    delete process.env.STREMIO_ETAG_ENABLED;
    const res = createResponse();

    applyStremioStreamCacheHeaders(res, { streams: [{ name: 'RD' }], cacheMaxAge: 120 });

    assert.equal(res.getHeader('etag'), undefined);
});

test('stream cache headers can attach a stable weak ETag without exposing config', () => {
    process.env.STREMIO_ETAG_ENABLED = 'true';
    const payload = { streams: [{ name: 'RD', title: 'Example 1080p' }], cacheMaxAge: 120 };
    const res = createResponse();

    applyStremioStreamCacheHeaders(res, payload);

    assert.equal(res.getHeader('etag'), buildStremioPayloadEtag(payload));
    assert.match(res.getHeader('etag'), /^W\/"[a-f0-9]{24}"$/);
    delete process.env.STREMIO_ETAG_ENABLED;
});

test('maybeSendNotModified returns 304 when client ETag matches', () => {
    process.env.STREMIO_ETAG_ENABLED = 'true';
    const payload = { streams: [{ name: 'RD', title: 'Example 1080p' }], cacheMaxAge: 120 };
    const etag = buildStremioPayloadEtag(payload);
    const req = { headers: { 'if-none-match': etag } };
    const res = createResponse();

    const matched = maybeSendNotModified(req, res, payload);

    assert.equal(matched, true);
    assert.equal(res.statusCode, 304);
    assert.equal(res.ended, true);
    delete process.env.STREMIO_ETAG_ENABLED;
});

test('maybeSendNotModified ignores no-store payloads', () => {
    process.env.STREMIO_ETAG_ENABLED = 'true';
    const payload = { streams: [{ name: 'RD', title: 'Example 1080p' }], cacheMaxAge: 0 };
    const etag = buildStremioPayloadEtag(payload);
    const req = { headers: { 'if-none-match': etag } };
    const res = createResponse();

    const matched = maybeSendNotModified(req, res, payload);

    assert.equal(matched, false);
    assert.equal(res.statusCode, 200);
    assert.equal(res.ended, false);
});
