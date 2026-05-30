'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const RdViewScanner = require('../core/debrid/rd/audit/rd_view_scanner');

test('view scanner dedupe keys stay isolated across RD user tokens', () => {
  const item = {
    hash: '0123456789abcdef0123456789abcdef01234567',
    fileIdx: 4
  };

  const first = RdViewScanner.__private.buildViewScanKey('rd', item, 'token-a');
  const second = RdViewScanner.__private.buildViewScanKey('rd', item, 'token-b');

  assert.notEqual(first, second);
});

test('view scanner keeps deferred probe outcomes in probing state', () => {
  const result = RdViewScanner.__private.mapProbeResultToState({
    cached: false,
    deferred: true,
    state: 'probing',
    error: 'timeout'
  });

  assert.equal(result.state, 'probing');
  assert.equal(result.cached, null);
});
