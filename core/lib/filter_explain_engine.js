'use strict';

function safeLogger(logger) {
    if (logger && typeof logger.info === 'function') return logger;
    return {
        info: (...args) => console.info(...args),
        warn: (...args) => console.warn(...args),
        debug: (...args) => console.debug(...args)
    };
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
    ).replace(/\s+/g, ' ').trim().slice(0, 160);
}

function toCount(list) {
    return Array.isArray(list) ? list.length : 0;
}

function countByReason(entries = []) {
    const map = {};
    for (const entry of entries) {
        const reason = String(entry?.reason || 'unknown');
        map[reason] = (map[reason] || 0) + 1;
    }
    return map;
}

function diffRemoved(before = [], after = [], fallbackReason = 'removed') {
    const afterKeys = new Set((Array.isArray(after) ? after : []).map((item, index) => getItemKey(item, index)));
    const removed = [];
    (Array.isArray(before) ? before : []).forEach((item, index) => {
        const key = getItemKey(item, index);
        if (!afterKeys.has(key)) {
            removed.push({
                key,
                reason: item?._filterExplainReason || item?._removedReason || fallbackReason,
                title: getDisplayName(item)
            });
        }
    });
    return removed;
}

class FilterExplain {
    constructor(options = {}) {
        this.enabled = Boolean(options.enabled);
        this.requestKey = String(options.requestKey || 'unknown');
        this.logger = safeLogger(options.logger);
        this.compact = options.compact !== false;
        this.sampleLimit = Number.isFinite(options.sampleLimit) ? options.sampleLimit : 4;
        this.startedAt = Date.now();
        this.initialCount = 0;
        this.finalCount = 0;
        this.events = [];
        this.notes = [];
    }

    input(stage, items) {
        if (!this.enabled) return;
        this.initialCount = toCount(items);
        this.events.push({
            stage,
            input: this.initialCount,
            output: this.initialCount,
            removed: 0,
            reasons: {}
        });
    }

    stage(stage, before, after, fallbackReason = 'removed') {
        if (!this.enabled) return;
        const removedEntries = diffRemoved(before, after, fallbackReason);
        const event = {
            stage,
            input: toCount(before),
            output: toCount(after),
            removed: removedEntries.length,
            reasons: countByReason(removedEntries)
        };
        if (!this.compact && this.sampleLimit > 0) {
            event.samples = removedEntries.slice(0, this.sampleLimit);
        }
        this.events.push(event);
    }

    remove(stage, item, reason, details = {}) {
        if (!this.enabled) return;
        this.events.push({
            stage,
            input: null,
            output: null,
            removed: 1,
            reasons: { [reason || 'removed']: 1 },
            samples: this.sampleLimit > 0 ? [{ title: getDisplayName(item), ...details }] : undefined
        });
    }

    note(stage, payload = {}) {
        if (!this.enabled) return;
        this.notes.push({ stage, ...payload });
    }

    final(items, extra = {}) {
        if (!this.enabled) return;
        this.finalCount = toCount(items);
        const removed = Math.max(0, this.initialCount - this.finalCount);
        const reasonTotals = {};
        for (const event of this.events) {
            for (const [reason, count] of Object.entries(event.reasons || {})) {
                reasonTotals[reason] = (reasonTotals[reason] || 0) + count;
            }
        }

        const payload = {
            request: this.requestKey,
            stage: extra.stage || 'pipeline',
            input: this.initialCount,
            kept: this.finalCount,
            removed,
            ms: Date.now() - this.startedAt,
            reasons: reasonTotals,
            stages: this.events
                .filter((event) => event.removed > 0 || event.stage.endsWith('.input'))
                .map((event) => ({
                    stage: event.stage,
                    input: event.input,
                    output: event.output,
                    removed: event.removed,
                    reasons: event.reasons,
                    samples: event.samples
                })),
            notes: this.notes
        };

        const reasonSummary = Object.entries(reasonTotals)
            .sort((a, b) => b[1] - a[1])
            .map(([reason, count]) => `${reason}:${count}`)
            .join(' ');

        this.logger.info(`[EXPLAIN] ${payload.request} ${payload.stage} input=${payload.input} kept=${payload.kept} removed=${payload.removed} ms=${payload.ms}${reasonSummary ? ` | ${reasonSummary}` : ''}`);
        if (String(process.env.LEVIATHAN_FILTER_EXPLAIN_JSON || '0') === '1') {
            this.logger.info(`[EXPLAIN:json] ${JSON.stringify(payload)}`);
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
