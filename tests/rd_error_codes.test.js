'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
    extractRdErrorCode,
    classifyRdErrorCode,
    RD_ERROR_CODES
} = require('../core/debrid/rd/utils/rd_error_codes');

test('extractRdErrorCode reads error_code from RD error bodies', () => {
    assert.equal(extractRdErrorCode({ error: 'infringing_file', error_code: 35 }), 35);
    assert.equal(extractRdErrorCode({ error_code: '8' }), 8);
    assert.equal(extractRdErrorCode({ errorCode: 29 }), 29);
    assert.equal(extractRdErrorCode({ code: 22 }), 22);
    assert.equal(extractRdErrorCode(null), null);
    assert.equal(extractRdErrorCode('boom'), null);
    assert.equal(extractRdErrorCode({ error: 'no code' }), null);
});

test('classifyRdErrorCode marks infringing / too-big / invalid as terminal uncached', () => {
    assert.equal(classifyRdErrorCode(RD_ERROR_CODES.INFRINGING_FILE), 'terminal_uncached');
    assert.equal(classifyRdErrorCode(RD_ERROR_CODES.TORRENT_TOO_BIG), 'terminal_uncached');
    assert.equal(classifyRdErrorCode(RD_ERROR_CODES.TORRENT_FILE_INVALID), 'terminal_uncached');
    assert.equal(classifyRdErrorCode(RD_ERROR_CODES.FILE_NOT_ALLOWED), 'terminal_uncached');
});

test('classifyRdErrorCode flags auth and rate-limit codes distinctly', () => {
    assert.equal(classifyRdErrorCode(RD_ERROR_CODES.BAD_TOKEN), 'auth');
    assert.equal(classifyRdErrorCode(RD_ERROR_CODES.PERMISSION_DENIED), 'auth');
    assert.equal(classifyRdErrorCode(RD_ERROR_CODES.TOO_MANY_ACTIVE_DOWNLOADS), 'rate_limit');
    assert.equal(classifyRdErrorCode(RD_ERROR_CODES.FAIR_USAGE_LIMIT), 'rate_limit');
    assert.equal(classifyRdErrorCode(999), 'unknown');
    assert.equal(classifyRdErrorCode(null), 'unknown');
});
