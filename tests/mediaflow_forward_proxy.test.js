'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { buildForwardUrl } = require('../core/proxy/mediaflow_gateway');

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

test('mediaflow forward URL builder reads the shared FORWARD_PROXY env', () => {
  withEnvironment({
    FORWARD_PROXY: 'https://proxy.example/forward?url=',
    MEDIAFLOW_FORWARD_PROXY: 'https://legacy.example/forward?url=',
    FORWARDPROXY: 'https://legacy-alias.example/forward?url='
  }, () => {
    assert.equal(
      buildForwardUrl({}, 'https://target.example/watch?a=1', {
        Referer: 'https://target.example/'
      }),
      'https://proxy.example/forward?url=https%3A%2F%2Ftarget.example%2Fwatch%3Fa%3D1&h_referer=https%3A%2F%2Ftarget.example%2F'
    );
  });
});

test('mediaflow forward URL builder ignores legacy aliases when FORWARD_PROXY is missing', () => {
  withEnvironment({
    FORWARD_PROXY: undefined,
    MEDIAFLOW_FORWARD_PROXY: 'https://legacy.example/forward?url=',
    MFP_FORWARD_PROXY: 'https://legacy-mfp.example/forward?url=',
    KRAKEN_FORWARD_PROXY: 'https://legacy-kraken.example/forward?url=',
    FORWARDPROXY: 'https://legacy-alias.example/forward?url='
  }, () => {
    assert.throws(
      () => buildForwardUrl({}, 'https://target.example/watch'),
      (error) => error.code === 'FORWARD_PROXY_CONFIG_ERROR'
    );
  });
});
