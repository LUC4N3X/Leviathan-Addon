'use strict';

const DEFAULT_SAMPLE_LIMIT = 4;
const MAX_SAMPLE_LIMIT = 50;

function safeLogger(logger) {
  const fallback = {
    info: (...args) => console.info(...args),
    warn: (...args) => console.warn(...args),
    debug: (...args) => console.debug(...args)
  };

  if (!logger || typeof logger !== 'object') return fallback;

  return {
    info: typeof logger.info === 'function' ? logger.info.bind(logger) : fallback.info,
    warn: typeof logger.warn === 'function' ? logger.warn.bind(logger) : fallback.warn,
    debug: typeof logger.debug === 'function' ? logger.debug.bind(logger) : fallback.debug
  };
}

function safeString(value, fallback = '') {
  if (value == null) return fallback;
  return String(value);
}

function safeNumber(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function normalizeStage(value, fallback = 'stage') {
  const stage = safeString(value, fallback).trim();
  return stage || fallback;
}

function normalizeReason(value, fallback = 'removed') {
  const reason = safeString(value, fallback).trim();
  return reason || fallback;
}

function normalizeList(list) {
  return Array.isArray(list) ? list : [];
}

function getItemKey(item = {}, index = 0) {
  return String(
    item?._dedupeKey ||
    item?._smartDedupeKey ||
    item?.infoHash ||
    item?.hash ||
    item?.btih ||
    item?.url ||
    item?.title ||
    item?.name ||
    `idx:${index}`
  );
}

function getDisplayName(item = {}) {
  return String(
    item?.title ||
    item?.name ||
    item?.filename ||
    item?.fileName ||
    item?.file_title ||
    item?.url ||
    'unknown'
  )
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 160);
}

function toCount(list) {
  return normalizeList(list).length;
}

function countByReason(entries = []) {
  const map = {};

  for (const entry of normalizeList(entries)) {
    const reason = normalizeReason(entry?.reason, 'unknown');
    map[reason] = (map[reason] || 0) + 1;
  }

  return map;
}

function incrementKeyCount(map, key) {
  map.set(key, (map.get(key) || 0) + 1);
}

function decrementKeyCount(map, key) {
  const count = map.get(key) || 0;
  if (count <= 1) {
    map.delete(key);
    return false;
  }

  map.set(key, count - 1);
  return true;
}

function buildKeyCounts(items = []) {
  const counts = new Map();

  normalizeList(items).forEach((item, index) => {
    incrementKeyCount(counts, getItemKey(item, index));
  });

  return counts;
}

function diffRemoved(before = [], after = [], fallbackReason = 'removed') {
  const afterKeys = buildKeyCounts(after);
  const removed = [];

  normalizeList(before).forEach((item, index) => {
    const key = getItemKey(item, index);

    if (afterKeys.has(key)) {
      decrementKeyCount(afterKeys, key);
      return;
    }

    removed.push({
      key,
      reason: item?._filterExplainReason || item?._removedReason || fallbackReason,
      title: getDisplayName(item)
    });
  });

  return removed;
}

function createBaseEvent(stage, input, output, removed = 0, reasons = {}) {
  return {
    stage: normalizeStage(stage),
    input,
    output,
    removed,
    reasons: reasons || {}
  };
}

function mergeReasonTotals(events = []) {
  const totals = {};

  for (const event of normalizeList(events)) {
    for (const [reason, count] of Object.entries(event?.reasons || {})) {
      totals[reason] = (totals[reason] || 0) + safeNumber(count, 0);
    }
  }

  return totals;
}

function buildReasonSummary(reasonTotals = {}) {
  return Object.entries(reasonTotals)
    .filter(([, count]) => safeNumber(count, 0) > 0)
    .sort((a, b) => b[1] - a[1])
    .map(([reason, count]) => `${reason}:${count}`)
    .join(' ');
}

function shouldLogJson() {
  return String(process.env.LEVIATHAN_FILTER_EXPLAIN_JSON || '0') === '1';
}

function safeJson(value) {
  try {
    return JSON.stringify(value);
  } catch (error) {
    return JSON.stringify({
      error: 'json_serialization_failed',
      message: error?.message || String(error)
    });
  }
}

function normalizeSampleLimit(value) {
  return clamp(Math.floor(safeNumber(value, DEFAULT_SAMPLE_LIMIT)), 0, MAX_SAMPLE_LIMIT);
}

class FilterExplain {
  constructor(options = {}) {
    this.enabled = Boolean(options.enabled);
    this.requestKey = String(options.requestKey || 'unknown');
    this.logger = safeLogger(options.logger);
    this.compact = options.compact !== false;
    this.sampleLimit = normalizeSampleLimit(options.sampleLimit);
    this.startedAt = Date.now();
    this.initialCount = 0;
    this.finalCount = 0;
    this.events = [];
    this.notes = [];
  }

  input(stage, items) {
    if (!this.enabled) return;

    this.initialCount = toCount(items);
    this.events.push(createBaseEvent(stage, this.initialCount, this.initialCount, 0, {}));
  }

  stage(stage, before, after, fallbackReason = 'removed') {
    if (!this.enabled) return;

    const removedEntries = diffRemoved(before, after, normalizeReason(fallbackReason));
    const event = createBaseEvent(
      stage,
      toCount(before),
      toCount(after),
      removedEntries.length,
      countByReason(removedEntries)
    );

    if (!this.compact && this.sampleLimit > 0) {
      event.samples = removedEntries.slice(0, this.sampleLimit);
    }

    this.events.push(event);
  }

  remove(stage, item, reason, details = {}) {
    if (!this.enabled) return;

    const normalizedReason = normalizeReason(reason);
    const event = createBaseEvent(stage, null, null, 1, { [normalizedReason]: 1 });

    if (this.sampleLimit > 0) {
      event.samples = [{
        title: getDisplayName(item),
        ...details
      }];
    }

    this.events.push(event);
  }

  note(stage, payload = {}) {
    if (!this.enabled) return;

    this.notes.push({
      stage: normalizeStage(stage),
      ...(payload && typeof payload === 'object' ? payload : { value: payload })
    });
  }

  buildPayload(items, extra = {}) {
    this.finalCount = toCount(items);

    const removed = Math.max(0, this.initialCount - this.finalCount);
    const reasonTotals = mergeReasonTotals(this.events);
    const stages = this.events
      .filter((event) => event.removed > 0 || normalizeStage(event.stage).endsWith('.input'))
      .map((event) => ({
        stage: event.stage,
        input: event.input,
        output: event.output,
        removed: event.removed,
        reasons: event.reasons,
        samples: event.samples
      }));

    return {
      request: this.requestKey,
      stage: extra.stage || 'pipeline',
      input: this.initialCount,
      kept: this.finalCount,
      removed,
      ms: Date.now() - this.startedAt,
      reasons: reasonTotals,
      stages,
      notes: this.notes
    };
  }

  final(items, extra = {}) {
    if (!this.enabled) return;

    const payload = this.buildPayload(items, extra);
    const reasonSummary = buildReasonSummary(payload.reasons);

    this.logger.info(
      `[EXPLAIN] ${payload.request} ${payload.stage} input=${payload.input} kept=${payload.kept} removed=${payload.removed} ms=${payload.ms}${reasonSummary ? ` | ${reasonSummary}` : ''}`
    );

    if (shouldLogJson()) {
      this.logger.info(`[EXPLAIN:json] ${safeJson(payload)}`);
    }
  }
}

function createFilterExplain(options = {}) {
  return new FilterExplain(options);
}

module.exports = {
  createFilterExplain,
  FilterExplain
};
