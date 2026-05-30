# RD Probe Coordinator Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Coordinate Real-Debrid availability probes so foreground checks win over background work, duplicate token-scoped probes are reused, and the personal auditor stores only shared soft hints.

**Architecture:** Add a local priority coordinator around the canonical `realdebrid_probe.js` execution path. Keep account confirmation token-scoped, route live/view/backfill/auditor checks through the same engine, and map personal-auditor results to soft DB states.

**Tech Stack:** Node.js CommonJS, `node:test`, existing RD limiter, magnet lock, PostgreSQL repository.

---

### Task 1: Local RD Probe Coordinator

**Files:**
- Create: `core/debrid/rd/probe/rd_probe_coordinator.js`
- Create: `tests/rd_probe_coordinator.test.js`

- [ ] **Step 1: Write failing coordinator tests**

Cover same-key coalescing, token isolation, recent reuse, foreground priority, and low-priority queue saturation:

```js
const coordinator = createRdProbeCoordinator({ concurrency: 1, maxQueue: 1, recentTtlMs: 1000 });
const result = await coordinator.schedule({
  token: 'user-a',
  hash: 'a'.repeat(40),
  priority: 'foreground',
  execute: async () => ({ hash: 'a'.repeat(40), cached: true })
});
assert.equal(result.cached, true);
```

- [ ] **Step 2: Run tests and verify RED**

Run: `node --test tests/rd_probe_coordinator.test.js`

Expected: FAIL because `rd_probe_coordinator.js` does not exist.

- [ ] **Step 3: Implement the coordinator**

Create a focused CommonJS module exporting `createRdProbeCoordinator`, singleton `scheduleRdProbe`, `getRdProbeCoordinatorStatus`, and `resetRdProbeCoordinatorForTests`.

Core behavior:

```js
function buildProbeKey({ token, hash, context = {} }) {
  return [
    tokenFingerprint(token),
    normalizeHash(hash),
    Number(context.season || context._probeSeason || 0) || 0,
    Number(context.episode || context._probeEpisode || 0) || 0,
    normalizeFileIndex(context.fileIdx ?? context.file_index ?? context.rd_file_index)
  ].join(':');
}
```

Queue ordering uses `foreground > view_scan > backfill > auditor`. Same-key work returns the in-flight promise. Recent non-deferred outcomes are cloned and reused. When the queue is full, low-priority work resolves to a deferred `probing` result rather than throwing or becoming negative.

- [ ] **Step 4: Run coordinator tests and verify GREEN**

Run: `node --test tests/rd_probe_coordinator.test.js`

Expected: PASS.

### Task 2: Canonical Probe Integration

**Files:**
- Modify: `core/debrid/rd/probe/realdebrid_probe.js`
- Test: `tests/rd_probe_coordinator.test.js`

- [ ] **Step 1: Add failing wrapper tests**

Verify that `inspectSingleHash`, `inspectSingleHashFast`, and background backfill submit the expected priority to an injected coordinator schedule function:

```js
const result = await coordinator.schedule({
  token,
  hash,
  context,
  priority: 'backfill',
  execute: () => performAvailabilityProbe(hash, magnet, token, { fast: false, backgroundDelete: false, context })
});
```

- [ ] **Step 2: Run tests and verify RED**

Run: `node --test tests/rd_probe_coordinator.test.js`

Expected: FAIL because canonical wrappers do not schedule through the coordinator.

- [ ] **Step 3: Route canonical wrappers through coordinator**

Keep `performAvailabilityProbe()` as the raw implementation. Add a scheduled wrapper:

```js
function scheduleAvailabilityProbe(infoHash, magnet, token, options = {}) {
  return scheduleRdProbe({
    token,
    hash: infoHash,
    context: options.context || {},
    priority: options.priority || (options.fast ? 'view_scan' : 'foreground'),
    execute: () => performAvailabilityProbe(infoHash, magnet, token, options)
  });
}
```

Use `foreground` for exact visible probes, `view_scan` for fast view work, and `backfill` for deferred background work. Preserve current file-selection, cleanup, and projection logic.

- [ ] **Step 4: Run focused tests and verify GREEN**

Run: `node --test tests/rd_probe_coordinator.test.js tests/rd_cache_oracle.test.js tests/debrid_availability_file_level.test.js`

Expected: PASS.

### Task 3: Personal Auditor Uses Canonical Probe

**Files:**
- Modify: `core/debrid/rd/audit/realdebrid_auditor.js`
- Create: `tests/rd_auditor_coordinator.test.js`

- [ ] **Step 1: Write failing auditor tests**

Test result mapping independently:

```js
assert.deepEqual(mapAuditorProbeResult({ cached: true, file_index: 7 }), {
  state: 'likely_cached',
  cached: null,
  rd_file_index: 7,
  failures: 0,
  next_hours: 168,
  reason: 'personal_scan_cached_hint'
});
```

Also verify terminal, deferred, and inconclusive outcomes remain soft.

- [ ] **Step 2: Run tests and verify RED**

Run: `node --test tests/rd_auditor_coordinator.test.js`

Expected: FAIL because the mapping helper is not exported and the auditor still uses direct Axios calls.

- [ ] **Step 3: Replace direct Axios probing**

Remove the private Axios client and direct add/select/info/delete sequence. Use:

```js
const outcome = await RealDebridProbe.inspectSingleHash(hash, buildMagnet(hash), token, {}, {
  priority: 'auditor'
});
```

Map personal-token observations to shared soft states:

```js
if (result.cached === true) return { state: 'likely_cached', cached: null, failures: 0, next_hours: RD_CACHED_RECHECK_HOURS };
if (result.deferred === true) return { state: 'probing', cached: null, failures: 1, next_hours: 12 };
if (isTerminalStatus(result.rd_status)) return { state: 'likely_uncached', cached: null, failures: 1, next_hours: 12 };
return { state: 'likely_uncached', cached: null, failures: 1, next_hours: 12 };
```

Persist file metadata and pack rows when available. Export `__private.mapAuditorProbeResult` for focused tests.

- [ ] **Step 4: Run auditor tests and verify GREEN**

Run: `node --test tests/rd_auditor_coordinator.test.js tests/rd_cache_oracle.test.js`

Expected: PASS.

### Task 4: Observability

**Files:**
- Modify: `core/debrid/rd/audit/realdebrid_auditor.js`
- Modify: `core/observability/mission_control.js`
- Test: `tests/mission_control.test.js`

- [ ] **Step 1: Write failing telemetry assertion**

Extend the mission-control test:

```js
assert.equal(payload.debrid.probeCoordinator.queued.foreground, 0);
```

- [ ] **Step 2: Run test and verify RED**

Run: `node --test tests/mission_control.test.js`

Expected: FAIL because `probeCoordinator` is missing.

- [ ] **Step 3: Expose coordinator status**

Import `getRdProbeCoordinatorStatus()` in mission control and include it under `debrid.probeCoordinator`. Include the same snapshot inside auditor status for `/api/rd-scanner-status`.

- [ ] **Step 4: Run test and verify GREEN**

Run: `node --test tests/mission_control.test.js tests/rd_probe_coordinator.test.js`

Expected: PASS.

### Task 5: Regression Verification

**Files:**
- Test: `tests/*.test.js`

- [ ] **Step 1: Run focused RD suite**

Run:

```powershell
node --test tests/rd_probe_coordinator.test.js tests/rd_auditor_coordinator.test.js tests/rd_cache_oracle.test.js tests/rd_status_guard.test.js tests/debrid_availability_file_level.test.js tests/debrid_global_cache_check.test.js tests/debrid_resilience.test.js tests/mission_control.test.js
```

Expected: PASS.

- [ ] **Step 2: Run lint**

Run: `npm run lint`

Expected: PASS.

- [ ] **Step 3: Run full suite**

Run: `npm test`

Expected: PASS.

- [ ] **Step 4: Record repository limitation**

This workspace has no `.git` directory. Do not attempt commits; report that source changes and verification were completed without commit creation.
