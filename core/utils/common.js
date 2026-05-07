const crypto = require('crypto');

function safeCompare(secretA, secretB) {
    const a = Buffer.from(String(secretA || ''));
    const b = Buffer.from(String(secretB || ''));
    if (a.length === 0 || b.length === 0 || a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
}

async function withSharedPromise(map, key, factory) {
    if (map.has(key)) return map.get(key);
    const task = Promise.resolve().then(factory).finally(() => {
        map.delete(key);
    });
    map.set(key, task);
    return task;
}

module.exports = {
    safeCompare,
    withSharedPromise
};
