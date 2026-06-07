'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const dgram = require('node:dgram');

const {
  parseUdpTracker,
  extractUdpTrackersFromMagnet,
  udpScrape,
  enrichItemsWithLiveSeeders,
  isEnabled
} = require('../core/lib/udp_tracker_scraper');

const HASH_A = 'a'.repeat(40);
const HASH_B = 'b'.repeat(40);

test('parseUdpTracker extracts host and port and rejects non-udp', () => {
  assert.deepEqual(parseUdpTracker('udp://tracker.opentrackr.org:1337/announce'), {
    host: 'tracker.opentrackr.org',
    port: 1337
  });
  assert.equal(parseUdpTracker('http://tracker.example/announce'), null);
  assert.equal(parseUdpTracker('udp://no-port/announce'), null);
});

test('extractUdpTrackersFromMagnet returns only udp trackers', () => {
  const magnet = `magnet:?xt=urn:btih:${HASH_A}`
    + `&tr=${encodeURIComponent('udp://t.example:80/announce')}`
    + `&tr=${encodeURIComponent('http://t.example/announce')}`;
  assert.deepEqual(extractUdpTrackersFromMagnet(magnet), ['udp://t.example:80/announce']);
});

test('enrichItemsWithLiveSeeders is a no-op when disabled', async () => {
  assert.equal(isEnabled(), false);
  const items = [{ hash: HASH_A, seeders: 0 }];
  const stats = await enrichItemsWithLiveSeeders(items);
  assert.equal(stats.enabled, false);
  assert.equal(stats.updated, 0);
  assert.equal(items[0].seeders, 0);
});

test('udpScrape speaks BEP-15 against a local mock tracker', async () => {
  const server = dgram.createSocket('udp4');
  const connectionId = Buffer.from('1122334455667788', 'hex');

  server.on('message', (msg, rinfo) => {
    const action = msg.readUInt32BE(8);
    const transactionId = msg.readUInt32BE(12);
    if (action === 0) {
      const resp = Buffer.alloc(16);
      resp.writeUInt32BE(0, 0);
      resp.writeUInt32BE(transactionId, 4);
      connectionId.copy(resp, 8);
      server.send(resp, rinfo.port, rinfo.address);
      return;
    }
    if (action === 2) {
      const hashCount = (msg.length - 16) / 20;
      const resp = Buffer.alloc(8 + hashCount * 12);
      resp.writeUInt32BE(2, 0);
      resp.writeUInt32BE(transactionId, 4);
      for (let i = 0; i < hashCount; i += 1) {
        resp.writeUInt32BE(42 + i, 8 + i * 12);
        resp.writeUInt32BE(0, 8 + i * 12 + 4);
        resp.writeUInt32BE(7, 8 + i * 12 + 8);
      }
      server.send(resp, rinfo.port, rinfo.address);
    }
  });

  await new Promise((resolve) => server.bind(0, '127.0.0.1', resolve));
  const port = server.address().port;

  try {
    const results = await udpScrape(`udp://127.0.0.1:${port}/announce`, [HASH_A, HASH_B], {
      packetTimeoutMs: 1500,
      budgetMs: 3000
    });
    assert.equal(results.get(HASH_A), 42);
    assert.equal(results.get(HASH_B), 43);
  } finally {
    server.close();
  }
});

test('udpScrape resolves empty on an unreachable tracker within budget', async () => {
  const results = await udpScrape('udp://192.0.2.1:1337/announce', [HASH_A], {
    packetTimeoutMs: 300,
    budgetMs: 600
  });
  assert.equal(results.size, 0);
});
