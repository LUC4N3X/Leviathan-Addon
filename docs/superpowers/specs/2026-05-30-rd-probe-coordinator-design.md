# RD Probe Coordinator Design

Date: 2026-05-30

## Context

Real-Debrid documents `/torrents/instantAvailability/{hash}`, but the API can return error code `37` (`Disabled endpoint`). Leviathan already avoids depending on that endpoint in its main flow. It infers availability through:

1. `POST /torrents/addMagnet`
2. `GET /torrents/info/{id}`
3. `POST /torrents/selectFiles/{id}` when required
4. `GET /torrents/info/{id}` and bounded polling
5. `DELETE /torrents/delete/{id}`

The existing fallback is sound, but the work is split across foreground checks, the RD view scanner, deferred backfill, and the personal-token RD auditor. The first three paths use `realdebrid_probe.js`; the auditor has a separate Axios implementation. This creates duplicated behavior and lets background work bypass the existing per-token limiter and magnet lock.

The deployment has two distinct trust scopes:

- A personal RD API token performs catalogue background scans.
- Stremio users provide their own RD tokens.

A result collected with the personal scanner token is useful shared evidence, but it must not be treated as a user-token confirmation. Leviathan must continue verifying RD before returning an RD-ready stream.

Reference: [Real-Debrid API documentation](https://api.real-debrid.com/)

## Goals

- Preserve the current user-visible safety guarantee: RD-ready output is verified before delivery.
- Increase foreground responsiveness for visible Stremio results.
- Improve background scan throughput without increasing avoidable RD traffic.
- Reuse recent probe evidence and coalesce duplicate work.
- Keep series and season-pack file-level precision.
- Route background auditor calls through the same limiter, lock, retry, and cleanup behavior as live probes.
- Expose enough metrics to understand reuse, queueing, deferral, and rate limiting.

## Non-Goals

- Do not reintroduce dependency on `/torrents/instantAvailability/{hash}`.
- Do not mark another user's RD result as confirmed solely because the personal token saw it.
- Do not require Redis or a distributed queue in this iteration.
- Do not change playback resolution semantics or weaken episode matching.
- Do not perform unrelated refactors of the debrid clients or database schema.

## Architecture

### Canonical Probe Engine

`core/debrid/rd/probe/realdebrid_probe.js` remains the canonical implementation for RD availability checks. It owns the add-magnet, inspect, select-files, bounded-poll, delete, and result-projection sequence.

The personal auditor must call this engine instead of maintaining a second Axios-based probe implementation.

### Local Probe Coordinator

Add a local RD probe coordinator under `core/debrid/rd/probe/`. It wraps execution of the canonical probe engine and provides:

- priority scheduling;
- in-flight promise coalescing;
- recent-result reuse;
- per-token isolation;
- queue bounds;
- metrics and status reporting.

The coordination key is:

```text
tokenFingerprint + hash + season + episode + fileIdx
```

The key deliberately includes the token fingerprint. Work from the personal scanner and work from a Stremio user's token can reuse implementation and scheduling infrastructure without sharing account-bound confirmation.

### Priority Classes

Priority order:

1. `foreground`: visible results requested during stream generation.
2. `view_scan`: post-response scan for unknown or soft-state visible results.
3. `backfill`: deferred follow-up after a fast probe.
4. `auditor`: personal-token catalogue scan.

Lower-priority jobs already waiting in the queue yield to newer foreground work. Running work is not interrupted.

### Shared Hint Boundary

The personal-token auditor continues persisting hash knowledge into the shared DB. These persisted rows are shared hints used for ranking, candidate ordering, and scan prioritization.

For non-personal user requests:

- personal-auditor positives are interpreted as `likely_cached` until user-token confirmation;
- foreground or view-scan verification with the user's token can promote the item to `cached`;
- series and packs require exact episode-file proof before promotion to `cached`;
- terminal or transient handling must not turn uncertain personal-token evidence into a hard user-token claim.

The current DB rows are shared and do not encode the token that produced each observation. To keep this iteration migration-free, the auditor persists only soft shared states:

| Personal auditor probe result | Shared DB state | Shared `cached` boolean |
| --- | --- | --- |
| verified positive | `likely_cached` | `null` |
| terminal negative | `likely_uncached` | `null` |
| transient, timeout, rate limit, or inconclusive | `probing` | `null` |

The auditor may still persist file metadata and pack-file hints for later user-token verification. Foreground checks, view scans, and playback resolution keep their existing stronger update paths.

## Data Flow

### Foreground Stream Request

1. Existing DB and availability overlays hydrate ranked candidates.
2. Shared personal-auditor positives can improve ordering as `likely_cached`.
3. Visible unknown candidates enter the coordinator as `foreground`.
4. The coordinator reuses a recent result only when the token-scoped key matches.
5. Otherwise it performs the canonical probe.
6. Confirmed results update DB state, file-level availability cache, episode mappings, and stream-cache invalidations.
7. Non-conclusive results remain `probing` or `likely_uncached` and can enter deferred backfill.

### RD View Scanner

1. The view scanner keeps its candidate scoring and page-level dedupe.
2. Selected candidates enter the coordinator as `view_scan`.
3. The coordinator prevents duplicate token-scoped work already running or recently completed.
4. Persisted changes invalidate affected stream and raw-page caches as today.

### Deferred Backfill

1. Deferred fast probes enter the coordinator as `backfill`.
2. Existing DB checks remain in place to skip already-known hashes.
3. The coordinator deduplicates queued and in-flight work.
4. Completed results persist through the same existing DB and pack-file paths.

### Personal-Token Auditor

1. The auditor selects due hashes from `getRdScanBatch()`.
2. It builds a tracker magnet and submits a slow canonical probe with `auditor` priority.
3. The canonical engine handles limiter, lock, file selection, polling, and cleanup.
4. The auditor maps the probe result into the soft shared-state DB update shape.
5. Personal-auditor evidence remains shared ranking evidence, not a user-token bypass.

## State Semantics

Existing states remain authoritative:

| State | Meaning |
| --- | --- |
| `cached` | Verified with sufficient proof for the current request. |
| `likely_cached` | Useful positive hint without sufficient current-request proof. |
| `probing` | Check is queued, deferred, transiently blocked, or still in progress. |
| `likely_uncached` | Non-terminal negative evidence. |
| `uncached_terminal` | Terminal negative evidence with existing protection rules applied. |
| `unknown` | No usable evidence. |

Rules:

- Shared auditor positives may rank highly but must remain soft for another user's token.
- A transient error, timeout, limiter pause, queue saturation, HTTP `429`, or HTTP `5xx` maps to `probing`, never to a hard negative.
- A season-pack hash alone is insufficient for `cached`; exact file evidence is required for the requested episode.
- Existing direct playback resolution can persist a verified hit as `cached`.

## Error Handling

- Preserve bounded retries and `Retry-After` handling from `rd_rate_limiter.js`.
- Preserve magnet cleanup after success, failure, and deferral.
- Preserve token isolation in limiter keys and coordination keys.
- Reject or defer excess low-priority queue work as `probing`.
- Allow foreground work to enter ahead of pending background work.
- Keep the auditor loop alive after individual probe failures.
- Record the last auditor outcome and coordinator status for operational visibility.

## Observability

Expose coordinator status alongside existing scanner telemetry:

- queued jobs by priority;
- running jobs;
- in-flight keys;
- recent-result hits;
- in-flight coalesced hits;
- deferred jobs;
- dropped low-priority jobs;
- completed jobs;
- transient failures;
- limiter stats already exposed by `rd_rate_limiter.js`.

Add concise logs for reuse, coalescing, deferment, and auditor outcomes. Logs must not include RD tokens.

## Testing

Add focused tests for:

1. Two concurrent requests with the same token-scoped key execute one canonical probe.
2. Two different tokens do not share confirmed probe results.
3. Foreground jobs run before queued auditor jobs.
4. Recent token-scoped results are reused within TTL.
5. Queue saturation defers low-priority work without producing a hard negative.
6. A transient failure and HTTP `429` remain `probing`.
7. A personal-auditor positive is treated as shared soft evidence for another user's request.
8. A series pack without an exact episode-file hint remains `likely_cached`.
9. The auditor submits work through the coordinator rather than direct Axios calls.
10. Existing RD oracle, file-level availability, resilience, and stream-cache tests remain green.

## Acceptance Criteria

- No user receives an RD-ready stream solely because the personal scanner token confirmed the hash.
- All personal auditor availability probes use the canonical probe engine and existing limiter/lock path.
- Concurrent duplicate probes for one token-scoped key are coalesced.
- Visible foreground checks are not starved by auditor backlog.
- Series and packs retain exact episode-file safeguards.
- Transient RD pressure degrades to soft state rather than false negative.
- Existing test suite passes with new coordinator coverage.

## Rollout

Implement the coordinator as a local in-process layer first. This is enough for the current architecture and keeps the change reviewable. A Redis or DB-backed distributed coordinator can be added later if multiple API replicas create measurable duplicate traffic.
