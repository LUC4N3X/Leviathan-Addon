'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const registry = require('../core/storage/tracker_registry');
registry.shutdownTrackerRegistry();

const HASH = '0123456789abcdef0123456789abcdef01234567';

function extractTrackersFromMagnet(magnet) {
  const out = [];
  const regex = /[?&]tr=([^&]+)/gi;
  let match;
  while ((match = regex.exec(String(magnet || ''))) !== null) {
    try {
      out.push(decodeURIComponent(match[1]));
    } catch (_) {}
  }
  return out;
}

test('CORE_TRACKERS is a non-empty, valid, deduped baseline', () => {
  assert.ok(Array.isArray(registry.CORE_TRACKERS));
  assert.ok(registry.CORE_TRACKERS.length >= 10);
  for (const tracker of registry.CORE_TRACKERS) assert.ok(registry.isValidTracker(tracker), `invalid: ${tracker}`);
  assert.equal(new Set(registry.CORE_TRACKERS.map((t) => t.toLowerCase())).size, registry.CORE_TRACKERS.length);
  assert.deepEqual(registry.DEFAULT_TRACKERS, [...registry.CORE_TRACKERS]);
});

test('isValidTracker accepts udp/http/https/ws/wss and rejects junk', () => {
  assert.ok(registry.isValidTracker('udp://tracker.x:1337/announce'));
  assert.ok(registry.isValidTracker('https://tracker.x/announce'));
  assert.ok(registry.isValidTracker('wss://tracker.x:443/announce'));
  assert.ok(!registry.isValidTracker('not-a-tracker'));
  assert.ok(!registry.isValidTracker('ftp://tracker.x/announce'));
  assert.ok(!registry.isValidTracker(''));
  assert.ok(!registry.isValidTracker(null));
});

test('dedupeTrackers drops invalid entries and case-insensitive duplicates, preserving order', () => {
  const result = registry.dedupeTrackers([
    'udp://A.tracker:1/announce',
    'garbage',
    'udp://a.tracker:1/announce',
    '   udp://b.tracker:2/announce   ',
    42,
    null
  ]);
  assert.deepEqual(result, ['udp://A.tracker:1/announce', 'udp://b.tracker:2/announce']);
});

test('normalizeTrackerList parses a raw list, skipping comments/blanks/invalid + dedupe', () => {
  const raw = '# header\n\nudp://t.one:1/announce\nbad-line\nudp://t.one:1/announce\nhttps://t.two/announce\n';
  assert.deepEqual(registry.normalizeTrackerList(raw), ['udp://t.one:1/announce', 'https://t.two/announce']);
  assert.deepEqual(registry.normalizeTrackerList(null), []);
});

test('mergeTrackerSources keeps CORE first, unions fetched lists, dedupes and caps', () => {
  const core = ['udp://core.a:1/announce', 'udp://core.b:2/announce'];
  const fetched = [
    ['udp://CORE.A:1/announce', 'udp://extra.c:3/announce'],
    ['udp://extra.d:4/announce']
  ];
  const merged = registry.mergeTrackerSources(core, fetched, 10);
  assert.deepEqual(merged, [
    'udp://core.a:1/announce',
    'udp://core.b:2/announce',
    'udp://extra.c:3/announce',
    'udp://extra.d:4/announce'
  ]);

  const capped = registry.mergeTrackerSources(core, fetched, 3);
  assert.equal(capped.length, 3);
  assert.equal(capped[0], 'udp://core.a:1/announce');
});

test('buildMagnet returns null for an invalid info hash', () => {
  assert.equal(registry.buildMagnet('not-a-hash'), null);
  assert.equal(registry.buildMagnet(''), null);
  assert.equal(registry.buildMagnet(null), null);
});

test('buildMagnet with an empty tracker list still embeds the active pool', () => {
  const magnet = registry.buildMagnet(HASH, []);
  assert.match(magnet, new RegExp(`^magnet:\\?xt=urn:btih:${HASH}&tr=`));
  assert.ok(extractTrackersFromMagnet(magnet).length > 0);
});

test('buildMagnet keeps caller-supplied trackers first and respects the per-magnet cap', () => {
  const custom = 'udp://my.custom.tracker:7000/announce';
  const magnet = registry.buildMagnet(HASH, [custom]);
  const trackers = extractTrackersFromMagnet(magnet);
  assert.equal(trackers[0], custom);
  assert.ok(trackers.length <= registry.getTrackerStats().magnetMaxTrackers);
});

test('buildMagnet never exceeds the per-magnet cap even with many custom trackers', () => {
  const many = Array.from({ length: 200 }, (_, i) => `udp://flood${i}.tracker:1/announce`);
  const trackers = extractTrackersFromMagnet(registry.buildMagnet(HASH, many));
  const cap = registry.getTrackerStats().magnetMaxTrackers;
  assert.ok(trackers.length <= cap, `${trackers.length} > ${cap}`);
});

test('getActiveTrackers returns a defensive copy', () => {
  const a = registry.getActiveTrackers();
  a.push('udp://mutation.attempt:1/announce');
  assert.ok(!registry.getActiveTrackers().includes('udp://mutation.attempt:1/announce'));
});

test('updateTrackers (injected fetcher) never degrades below the curated CORE baseline', async () => {
  await registry.updateTrackers({
    fetchImpl: async () => ({ data: 'udp://injected.one:1/announce\nudp://injected.two:2/announce' }),
    sources: ['mock://a', 'mock://b']
  });
  const active = registry.getActiveTrackers();
  for (const core of registry.CORE_TRACKERS) {
    assert.ok(active.includes(core), `active pool lost core tracker ${core}`);
  }
  assert.ok(active.length >= registry.CORE_TRACKERS.length);
});

test('updateTrackers (all sources fail) keeps the curated CORE baseline', async () => {
  await registry.updateTrackers({
    fetchImpl: async () => { throw new Error('network down'); },
    sources: ['mock://a']
  });
  const active = registry.getActiveTrackers();
  for (const core of registry.CORE_TRACKERS) {
    assert.ok(active.includes(core), `active pool lost core tracker ${core}`);
  }
  assert.equal(registry.getTrackerStats().lastRefreshOk, false);
});

test('updateTrackers preserves previously discovered trackers across a later failed refresh', async () => {
  const discovered = 'udp://discovered.during.success:6969/announce';
  await registry.updateTrackers({
    fetchImpl: async () => ({ data: discovered }),
    sources: ['mock://ok']
  });
  assert.ok(registry.getActiveTrackers().includes(discovered));

  await registry.updateTrackers({
    fetchImpl: async () => { throw new Error('outage'); },
    sources: ['mock://down']
  });
  assert.ok(registry.getActiveTrackers().includes(discovered));
  assert.equal(registry.getTrackerStats().lastRefreshOk, false);
});

test('updateTrackers keeps discovered trackers even across a later successful refresh', async () => {
  const discovered = 'udp://sticky.discovered:6969/announce';
  await registry.updateTrackers({
    fetchImpl: async () => ({ data: discovered }),
    sources: ['mock://ok']
  });
  assert.ok(registry.getActiveTrackers().includes(discovered));

  await registry.updateTrackers({
    fetchImpl: async () => ({ data: 'udp://fresh.upstream:1/announce' }),
    sources: ['mock://ok2']
  });
  const active = registry.getActiveTrackers();
  assert.ok(active.includes('udp://fresh.upstream:1/announce'));
  assert.ok(active.includes(discovered));
});
