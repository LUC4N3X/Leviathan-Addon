'use strict';

class TinyLruCache {
  constructor({ max = 1000, ttlMs = 10 * 60 * 1000 } = {}) {
    this.max = Math.max(10, Number(max) || 1000);
    this.ttlMs = Math.max(1000, Number(ttlMs) || 10 * 60 * 1000);
    this.map = new Map();
  }

  get(key) {
    const normalizedKey = String(key);
    const entry = this.map.get(normalizedKey);
    if (!entry) return undefined;
    if (entry.expiresAt <= Date.now()) {
      this.map.delete(normalizedKey);
      return undefined;
    }
    this.map.delete(normalizedKey);
    this.map.set(normalizedKey, entry);
    return entry.value;
  }

  set(key, value, ttlMs = this.ttlMs) {
    const normalizedKey = String(key);
    if (this.map.has(normalizedKey)) this.map.delete(normalizedKey);
    this.map.set(normalizedKey, {
      value,
      expiresAt: Date.now() + Math.max(1000, Number(ttlMs) || this.ttlMs)
    });
    this.prune(false);
    return value;
  }

  delete(key) {
    return this.map.delete(String(key));
  }

  clear() {
    this.map.clear();
  }

  get size() {
    return this.map.size;
  }

  prune(removeExpiredOnly = true) {
    const now = Date.now();
    for (const [key, entry] of this.map.entries()) {
      if (entry.expiresAt <= now) this.map.delete(key);
    }
    if (removeExpiredOnly) return;
    while (this.map.size > this.max) {
      const oldestKey = this.map.keys().next().value;
      if (oldestKey === undefined) break;
      this.map.delete(oldestKey);
    }
  }
}

module.exports = { TinyLruCache };
