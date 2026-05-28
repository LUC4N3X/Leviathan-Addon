const TIMED_CACHE_MAX_ENTRIES = Math.max(200, Math.min(10000, parseInt(process.env.TIMED_CACHE_MAX_ENTRIES || '3000', 10) || 3000));
const TIMED_CACHE_SWEEP_INTERVAL_MS = Math.max(1000, Math.min(60 * 1000, parseInt(process.env.TIMED_CACHE_SWEEP_INTERVAL_MS || '5000', 10) || 5000));

const timedCacheSweepState = new Map();

function getTimedCacheState(map) {
    let state = timedCacheSweepState.get(map);
    if (!state) {
        state = { nextSweepAt: 0 };
        timedCacheSweepState.set(map, state);
    }
    return state;
}

function trimTimedCacheSize(map, maxEntries = TIMED_CACHE_MAX_ENTRIES) {
    while (map.size > maxEntries) {
        const oldestKey = map.keys().next().value;
        if (oldestKey === undefined) break;
        map.delete(oldestKey);
    }
}

function cleanupTimedCache(map, maxEntries = TIMED_CACHE_MAX_ENTRIES, options = {}) {
    if (!(map instanceof Map)) return;
    if (map.size === 0) {
        timedCacheSweepState.delete(map);
        return;
    }
    const now = Date.now();
    const state = getTimedCacheState(map);
    const overCapacity = map.size > maxEntries;
    if (options.force !== true && !overCapacity && now < state.nextSweepAt) return;

    state.nextSweepAt = now + TIMED_CACHE_SWEEP_INTERVAL_MS;

    for (const [key, entry] of map) {
        if (!entry || Number(entry.expiresAt || 0) <= now) map.delete(key);
    }

    trimTimedCacheSize(map, maxEntries);
}

function getTimedCacheValue(map, key) {
    cleanupTimedCache(map);
    const entry = map.get(key);
    if (!entry) return null;
    if (Number(entry.expiresAt || 0) <= Date.now()) {
        map.delete(key);
        return null;
    }
    return entry.value;
}

function setTimedCacheValue(map, key, value, ttlMs, maxEntries = TIMED_CACHE_MAX_ENTRIES) {
    if (!(map instanceof Map) || !key || ttlMs <= 0) return value;
    cleanupTimedCache(map, maxEntries);
    map.set(key, { value, expiresAt: Date.now() + ttlMs });
    trimTimedCacheSize(map, maxEntries);
    return value;
}

module.exports = {
    TIMED_CACHE_MAX_ENTRIES,
    cleanupTimedCache,
    getTimedCacheValue,
    setTimedCacheValue
};
