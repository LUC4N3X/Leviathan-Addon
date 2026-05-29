'use strict';

function cleanupRecentMap(map, ttlMs, maxEntries = 2000) {
    if (!(map instanceof Map) || map.size === 0) return;
    const now = Date.now();
    for (const [key, ts] of map) {
        if ((now - Number(ts || 0)) > ttlMs) map.delete(key);
    }
    while (map.size > maxEntries) {
        const oldestKey = map.keys().next().value;
        if (oldestKey === undefined) break;
        map.delete(oldestKey);
    }
}

function shouldSkipRecentWork(map, key, ttlMs, maxEntries = 2000) {
    if (!key) return false;
    cleanupRecentMap(map, ttlMs, maxEntries);
    const now = Date.now();
    const previous = Number(map.get(key) || 0);
    if (previous > 0 && (now - previous) < ttlMs) return true;
    map.set(key, now);
    return false;
}

module.exports = {
    cleanupRecentMap,
    shouldSkipRecentWork
};
