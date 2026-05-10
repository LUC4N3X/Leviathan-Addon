const crypto = require('crypto');

function safeCompare(secretA, secretB) {
    const a = Buffer.from(String(secretA || ''));
    const b = Buffer.from(String(secretB || ''));
    if (a.length === 0 || b.length === 0 || a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
}

function getPositiveInt(value, fallback = 0) {
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function evictOldestSharedPromises(map, maxEntries) {
    const max = getPositiveInt(maxEntries, 0);
    if (!max || !map || map.size < max) return 0;

    let evicted = 0;
    while (map.size >= max) {
        const oldestKey = map.keys().next().value;
        if (oldestKey === undefined) break;
        map.delete(oldestKey);
        evicted += 1;
    }
    return evicted;
}

async function withSharedPromise(map, key, factory, options = {}) {
    if (map.has(key)) return map.get(key);
    const evicted = evictOldestSharedPromises(map, options.maxEntries);
    if (evicted > 0 && typeof options.onEvict === 'function') {
        try { options.onEvict(evicted); } catch (_) {}
    }

    const task = Promise.resolve().then(factory).finally(() => {
        if (map.get(key) === task) map.delete(key);
    });
    map.set(key, task);
    return task;
}

module.exports = {
    evictOldestSharedPromises,
    safeCompare,
    withSharedPromise
};
