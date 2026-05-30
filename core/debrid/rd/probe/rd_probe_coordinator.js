'use strict';

const crypto = require('crypto');

const PRIORITIES = Object.freeze({
  auditor: 10,
  backfill: 30,
  view_scan: 60,
  foreground: 100
});

function clampInteger(value, fallback, min, max) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, parsed));
}

function normalizeHash(hash) {
  return String(hash || '').trim().toLowerCase();
}

function tokenFingerprint(token) {
  return crypto
    .createHash('sha256')
    .update(String(token || ''))
    .digest('hex')
    .slice(0, 18);
}

function normalizeNumber(value) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

function normalizeFileIndex(value) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 'auto';
}

function getContextValue(context, ...keys) {
  for (const key of keys) {
    if (context[key] !== undefined && context[key] !== null) {
      return context[key];
    }
  }
  return undefined;
}

function buildProbeKey({ token, hash, context = {} }) {
  const season = normalizeNumber(getContextValue(context, 'season', '_probeSeason'));
  const episode = normalizeNumber(getContextValue(context, 'episode', '_probeEpisode'));
  const fileIdx = normalizeFileIndex(getContextValue(
    context,
    'fileIdx',
    'file_idx',
    'rd_file_index',
    '_probeFileIdx'
  ));

  return [
    tokenFingerprint(token),
    normalizeHash(hash),
    season,
    episode,
    fileIdx
  ].join(':');
}

function normalizePriority(priority) {
  return Object.hasOwn(PRIORITIES, priority) ? priority : 'backfill';
}

function buildDeferredResult(hash, error = 'coordinator_deferred') {
  return {
    hash: normalizeHash(hash),
    cached: false,
    deferred: true,
    state: 'probing',
    rd_status: 'unknown',
    error
  };
}

function cloneResult(result) {
  if (!result || typeof result !== 'object') {
    return result;
  }
  return JSON.parse(JSON.stringify(result));
}

function createMetrics() {
  return {
    scheduled: 0,
    started: 0,
    completed: 0,
    coalescedHits: 0,
    recentHits: 0,
    deferred: 0,
    droppedLowPriority: 0,
    transientFailures: 0
  };
}

function createRdProbeCoordinator(options = {}) {
  const concurrency = clampInteger(
    options.concurrency ?? process.env.RD_PROBE_COORDINATOR_CONCURRENCY,
    4,
    1,
    25
  );
  const maxQueue = clampInteger(
    options.maxQueue ?? process.env.RD_PROBE_COORDINATOR_MAX_QUEUE,
    300,
    1,
    5000
  );
  const recentTtlMs = clampInteger(
    options.recentTtlMs ?? process.env.RD_PROBE_COORDINATOR_RECENT_TTL_MS,
    35_000,
    1,
    300_000
  );
  const maxRecent = clampInteger(
    options.maxRecent ?? process.env.RD_PROBE_COORDINATOR_MAX_RECENT,
    2500,
    1,
    10_000
  );

  const queue = [];
  const pendingByKey = new Map();
  const recentByKey = new Map();
  let metrics = createMetrics();
  let running = 0;
  let sequence = 0;

  function pruneRecent(now = Date.now()) {
    for (const [key, entry] of recentByKey.entries()) {
      if (entry.expiresAt <= now) {
        recentByKey.delete(key);
      }
    }
    while (recentByKey.size > maxRecent) {
      const oldestKey = recentByKey.keys().next().value;
      recentByKey.delete(oldestKey);
    }
  }

  function remember(key, result) {
    if (!result || typeof result !== 'object' || result.deferred === true) {
      return;
    }
    recentByKey.delete(key);
    recentByKey.set(key, {
      expiresAt: Date.now() + recentTtlMs,
      result: cloneResult(result)
    });
    pruneRecent();
  }

  function settleDeferred(job, error) {
    if (pendingByKey.get(job.key) === job) {
      pendingByKey.delete(job.key);
    }
    metrics.deferred += 1;
    metrics.droppedLowPriority += 1;
    job.resolve(buildDeferredResult(job.hash, error));
  }

  function findEvictionCandidate(priorityValue) {
    let candidateIndex = -1;
    for (let index = 0; index < queue.length; index += 1) {
      if (queue[index].priorityValue >= priorityValue) {
        continue;
      }
      if (
        candidateIndex === -1
        || queue[index].priorityValue < queue[candidateIndex].priorityValue
      ) {
        candidateIndex = index;
      }
    }
    return candidateIndex;
  }

  function drain() {
    while (running < concurrency && queue.length > 0) {
      const job = queue.shift();
      running += 1;
      metrics.started += 1;

      Promise.resolve()
        .then(job.execute)
        .then((result) => {
          metrics.completed += 1;
          if (result && result.deferred === true) {
            metrics.deferred += 1;
          } else {
            remember(job.key, result);
          }
          job.resolve(result);
        })
        .catch((error) => {
          metrics.completed += 1;
          metrics.deferred += 1;
          metrics.transientFailures += 1;
          job.resolve(buildDeferredResult(
            job.hash,
            error && error.message ? error.message : 'coordinator_execution_failed'
          ));
        })
        .finally(() => {
          running -= 1;
          if (pendingByKey.get(job.key) === job) {
            pendingByKey.delete(job.key);
          }
          drain();
        });
    }
  }

  function schedule({
    token,
    hash,
    context = {},
    priority = 'backfill',
    execute
  }) {
    if (typeof execute !== 'function') {
      return Promise.reject(new TypeError('RD probe coordinator requires an execute function'));
    }

    pruneRecent();
    const key = buildProbeKey({ token, hash, context });
    const recent = recentByKey.get(key);
    if (recent) {
      metrics.recentHits += 1;
      return Promise.resolve(cloneResult(recent.result));
    }

    const pending = pendingByKey.get(key);
    if (pending) {
      metrics.coalescedHits += 1;
      return pending.promise;
    }

    const normalizedPriority = normalizePriority(priority);
    const priorityValue = PRIORITIES[normalizedPriority];
    let resolveJob;
    const promise = new Promise((resolve) => {
      resolveJob = resolve;
    });
    const job = {
      key,
      hash,
      priority: normalizedPriority,
      priorityValue,
      sequence: sequence += 1,
      execute,
      resolve: resolveJob,
      promise
    };

    if (queue.length >= maxQueue) {
      const evictionIndex = findEvictionCandidate(priorityValue);
      if (evictionIndex === -1) {
        metrics.scheduled += 1;
        settleDeferred(job, 'coordinator_queue_full');
        return promise;
      }
      const [evictedJob] = queue.splice(evictionIndex, 1);
      settleDeferred(evictedJob, 'coordinator_queue_preempted');
    }

    metrics.scheduled += 1;
    pendingByKey.set(key, job);
    queue.push(job);
    queue.sort((left, right) => (
      right.priorityValue - left.priorityValue
      || left.sequence - right.sequence
    ));
    drain();
    return promise;
  }

  function status() {
    const queued = {
      foreground: 0,
      view_scan: 0,
      backfill: 0,
      auditor: 0,
      total: queue.length
    };
    for (const job of queue) {
      queued[job.priority] += 1;
    }

    pruneRecent();
    return {
      concurrency,
      maxQueue,
      running,
      queued,
      inflightKeys: pendingByKey.size,
      recentEntries: recentByKey.size,
      metrics: { ...metrics }
    };
  }

  function reset() {
    for (const job of queue.splice(0, queue.length)) {
      settleDeferred(job, 'coordinator_reset');
    }
    pendingByKey.clear();
    recentByKey.clear();
    metrics = createMetrics();
  }

  return {
    schedule,
    status,
    reset
  };
}

let defaultCoordinator = createRdProbeCoordinator();

function scheduleRdProbe(options) {
  return defaultCoordinator.schedule(options);
}

function getRdProbeCoordinatorStatus() {
  return defaultCoordinator.status();
}

function resetRdProbeCoordinatorForTests(options = {}) {
  defaultCoordinator.reset();
  defaultCoordinator = createRdProbeCoordinator(options);
  return defaultCoordinator;
}

module.exports = {
  PRIORITIES,
  buildDeferredResult,
  buildProbeKey,
  createRdProbeCoordinator,
  getRdProbeCoordinatorStatus,
  resetRdProbeCoordinatorForTests,
  scheduleRdProbe,
  tokenFingerprint
};
