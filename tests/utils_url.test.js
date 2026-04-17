'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  getRequestClientIp,
  getRequestOrigin,
  isPrivateIp,
  isSafeRemoteUrl,
  parseForwardedProto,
  sanitizeHostHeader
} = require('../core/utils_url');

test('parseForwardedProto keeps only safe forwarded protocol values', () => {
  assert.equal(parseForwardedProto('https, http', 'http'), 'https');
  assert.equal(parseForwardedProto('ftp', 'http'), 'http');
});

test('sanitizeHostHeader rejects host header injection and keeps valid hosts', () => {
  assert.equal(sanitizeHostHeader('example.com:7000'), 'example.com:7000');
  assert.equal(sanitizeHostHeader('127.0.0.1:7000'), '127.0.0.1:7000');
  assert.equal(sanitizeHostHeader('example.com\r\nX-Test: 1'), null);
  assert.equal(sanitizeHostHeader('evil.com/path'), null);
});

test('getRequestOrigin prefers a sanitized request origin', () => {
  const req = {
    protocol: 'http',
    headers: { 'x-forwarded-proto': 'https, http', host: 'addon.example.com' },
    get(name) {
      return this.headers[name.toLowerCase()];
    }
  };

  assert.equal(getRequestOrigin(req), 'https://addon.example.com');
});

test('getRequestClientIp prefers req.ip and falls back to x-forwarded-for', () => {
  assert.equal(getRequestClientIp({ ip: '::1', headers: { 'x-forwarded-for': '8.8.8.8' } }), '::1');
  assert.equal(getRequestClientIp({ headers: { 'x-forwarded-for': '8.8.8.8, 1.1.1.1' } }), '8.8.8.8');
});

test('isPrivateIp detects common private and loopback addresses', () => {
  assert.equal(isPrivateIp('127.0.0.1'), true);
  assert.equal(isPrivateIp('10.0.0.8'), true);
  assert.equal(isPrivateIp('172.16.1.8'), true);
  assert.equal(isPrivateIp('192.168.1.2'), true);
  assert.equal(isPrivateIp('8.8.8.8'), false);
  assert.equal(isPrivateIp('::1'), true);
});

test('isSafeRemoteUrl allows public http(s) and blocks local/private targets', () => {
  assert.equal(isSafeRemoteUrl('https://example.com/video.m3u8'), true);
  assert.equal(isSafeRemoteUrl('http://127.0.0.1/admin'), false);
  assert.equal(isSafeRemoteUrl('http://[::1]/admin'), false);
  assert.equal(isSafeRemoteUrl('http://localhost/internal'), false);
  assert.equal(isSafeRemoteUrl('file:///etc/passwd'), false);
});
