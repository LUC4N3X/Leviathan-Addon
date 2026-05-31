'use strict';

const fs = require('fs');
const path = require('path');

function envFlag(name, def) {
    const raw = process.env[name];
    if (raw === undefined || raw === null || raw === '') return def;
    return /^(?:1|true|yes|on|enabled)$/i.test(String(raw).trim());
}

function envInt(name, def, min, max) {
    const parsed = Number.parseInt(String(process.env[name] ?? ''), 10);
    if (!Number.isFinite(parsed)) return def;
    return Math.max(min, Math.min(max, parsed));
}

function envFloat(name, def, min, max) {
    const parsed = Number.parseFloat(String(process.env[name] ?? ''));
    if (!Number.isFinite(parsed)) return def;
    return Math.max(min, Math.min(max, parsed));
}

const ENABLED = envFlag('CC_MEMORY', true) && !envFlag('CC_MEMORY_DISABLED', false);
const POSITIVE_TTL_MS = envInt('CC_MEMORY_POSITIVE_TTL_MS', 14 * 24 * 3600 * 1000, 60 * 1000, 365 * 24 * 3600 * 1000);
const NEGATIVE_TTL_MS = envInt('CC_MEMORY_NEGATIVE_TTL_MS', 6 * 3600 * 1000, 60 * 1000, 30 * 24 * 3600 * 1000);
const HALF_LIFE_MS = envInt('CC_MEMORY_HALF_LIFE_MS', 7 * 24 * 3600 * 1000, 3600 * 1000, 365 * 24 * 3600 * 1000);
const CONFIDENCE_FLOOR = envFloat('CC_MEMORY_CONFIDENCE_FLOOR', 0.45, 0, 0.95);
const MAX_ENTRIES = envInt('CC_MEMORY_MAX_ENTRIES', 5000, 100, 200000);
const MAX_FAILURES = envInt('CC_MEMORY_MAX_FAILURES', 2, 1, 10);
const PERSIST = ENABLED && envFlag('CC_MEMORY_PERSIST', true);
const PERSIST_PATH = String(process.env.CC_MEMORY_PATH || '').trim()
    || path.join(__dirname, '..', 'config', 'cc_resolution_memory.json');
const SAVE_DEBOUNCE_MS = envInt('CC_MEMORY_SAVE_DEBOUNCE_MS', 5000, 250, 600000);

const store = new Map();
let loaded = false;
let dirty = false;
let saveTimer = null;

let clock = () => Date.now();

function normalizeId(id) {
    return String(id || '').trim().toLowerCase();
}

function buildKey(id, type) {
    const normalizedType = String(type || '').trim().toLowerCase() || 'any';
    return `${normalizedType}::${normalizeId(id)}`;
}

function entryTtl(entry) {
    return entry && entry.negative ? NEGATIVE_TTL_MS : POSITIVE_TTL_MS;
}

function isExpired(entry, now) {
    const anchor = (entry && (entry.lastSeen || entry.createdAt)) || 0;
    return now - anchor > entryTtl(entry);
}

function effectiveConfidence(entry, now) {
    const base = Number(entry && entry.confidence) || 0;
    const anchor = (entry && (entry.lastSeen || entry.createdAt)) || now;
    const age = Math.max(0, now - anchor);
    return base * Math.pow(0.5, age / HALF_LIFE_MS);
}

function scoreToConfidence(score, verifiedImdb) {
    if (verifiedImdb) return 0.97;
    const value = Number(score);
    if (!Number.isFinite(value)) return 0.6;
    if (value >= 1000) return 0.9;
    if (value >= 500) return 0.78;
    if (value >= 420) return 0.7;
    if (value >= 250) return 0.6;
    return 0.5;
}

function load() {
    if (loaded) return;
    loaded = true;
    if (!PERSIST) return;
    try {
        if (!fs.existsSync(PERSIST_PATH)) return;
        const data = JSON.parse(fs.readFileSync(PERSIST_PATH, 'utf8'));
        if (!data || !Array.isArray(data.entries)) return;
        const now = clock();
        for (const pair of data.entries) {
            if (!Array.isArray(pair) || pair.length !== 2) continue;
            const [key, entry] = pair;
            if (!key || !entry || typeof entry !== 'object') continue;
            if (isExpired(entry, now)) continue;
            store.set(key, entry);
        }
    } catch (_) {
        
    }
}

function flush() {
    if (!PERSIST || !dirty) return;
    dirty = false;
    try {
        fs.mkdirSync(path.dirname(PERSIST_PATH), { recursive: true });
        const payload = JSON.stringify({ v: 1, savedAt: clock(), entries: [...store.entries()] });
        const tmpPath = `${PERSIST_PATH}.tmp`;
        fs.writeFileSync(tmpPath, payload, { mode: 0o600 });
        fs.renameSync(tmpPath, PERSIST_PATH);
    } catch (_) {
       
    }
}

function scheduleSave() {
    if (!PERSIST) return;
    dirty = true;
    if (saveTimer) return;
    saveTimer = setTimeout(() => {
        saveTimer = null;
        flush();
    }, SAVE_DEBOUNCE_MS);
    if (saveTimer && typeof saveTimer.unref === 'function') saveTimer.unref();
}

function prune() {
    if (store.size <= MAX_ENTRIES) return;
    const ordered = [...store.entries()].sort((a, b) => (a[1].lastSeen || 0) - (b[1].lastSeen || 0));
    const removeCount = store.size - MAX_ENTRIES;
    for (let i = 0; i < removeCount; i++) store.delete(ordered[i][0]);
}

function recall(id, type) {
    if (!ENABLED) return null;
    try {
        load();
        const key = buildKey(id, type);
        const entry = store.get(key);
        if (!entry) return null;

        const now = clock();
        if (isExpired(entry, now)) {
            store.delete(key);
            scheduleSave();
            return null;
        }

        if (entry.negative) {
            return { negative: true, misses: entry.misses || 1 };
        }

        if (!entry.url) return null;

        const confidence = effectiveConfidence(entry, now);
        if (!entry.verifiedImdb && confidence < CONFIDENCE_FLOOR) {
            return null;
        }

        return {
            url: entry.url,
            title: entry.title || '',
            kind: entry.kind || '',
            confidence,
            verifiedImdb: !!entry.verifiedImdb,
            hits: entry.hits || 0
        };
    } catch (_) {
        return null;
    }
}

function remember(id, type, { url, title, kind, score, verifiedImdb } = {}) {
    if (!ENABLED || !url) return;
    try {
        load();
        const key = buildKey(id, type);
        const now = clock();
        const previous = store.get(key);
        const sameUrlPositive = previous && !previous.negative && previous.url === String(url);
        const confidence = scoreToConfidence(score, verifiedImdb);

        store.set(key, {
            negative: false,
            url: String(url),
            title: title ? String(title) : (sameUrlPositive ? previous.title : ''),
            kind: kind || (sameUrlPositive ? previous.kind : '') || '',
            confidence: sameUrlPositive ? Math.max(previous.confidence || 0, confidence) : confidence,
            verifiedImdb: !!verifiedImdb || (sameUrlPositive && !!previous.verifiedImdb),
            createdAt: sameUrlPositive ? (previous.createdAt || now) : now,
            lastSeen: now,
            hits: sameUrlPositive ? (previous.hits || 0) : 0,
            failures: 0
        });
        prune();
        scheduleSave();
    } catch (_) {
       
    }
}

function rememberNegative(id, type) {
    if (!ENABLED) return;
    try {
        load();
        const key = buildKey(id, type);
        const now = clock();
        const previous = store.get(key);
        if (previous && !previous.negative && (previous.verifiedImdb || (previous.failures || 0) < MAX_FAILURES)) {
            return;
        }
        store.set(key, {
            negative: true,
            createdAt: (previous && previous.createdAt) || now,
            lastSeen: now,
            misses: ((previous && previous.misses) || 0) + 1
        });
        prune();
        scheduleSave();
    } catch (_) {
        
    }
}

function reinforce(id, type) {
    if (!ENABLED) return;
    try {
        const entry = store.get(buildKey(id, type));
        if (!entry || entry.negative) return;
        entry.hits = (entry.hits || 0) + 1;
        entry.failures = 0;
        entry.lastSeen = clock();
        entry.confidence = Math.min(0.99, (entry.confidence || 0.6) + 0.02);
        scheduleSave();
    } catch (_) {
        
    }
}

function penalize(id, type) {
    if (!ENABLED) return;
    try {
        const key = buildKey(id, type);
        const entry = store.get(key);
        if (!entry || entry.negative) return;
        entry.failures = (entry.failures || 0) + 1;
        entry.confidence = Math.max(0, (entry.confidence || 0.6) - 0.25);
        entry.lastSeen = clock();
        if (entry.failures >= MAX_FAILURES) {
            store.delete(key);
        }
        scheduleSave();
    } catch (_) {
        
    }
}

function forget(id, type) {
    try {
        if (store.delete(buildKey(id, type))) scheduleSave();
    } catch (_) {
        
    }
}

function stats() {
    let positive = 0;
    let negative = 0;
    let verified = 0;
    for (const entry of store.values()) {
        if (entry.negative) {
            negative += 1;
        } else {
            positive += 1;
            if (entry.verifiedImdb) verified += 1;
        }
    }
    return {
        enabled: ENABLED,
        persist: PERSIST,
        persistPath: PERSIST ? PERSIST_PATH : null,
        size: store.size,
        positive,
        negative,
        verified
    };
}


function __reset() {
    store.clear();
    dirty = false;
    if (saveTimer) {
        clearTimeout(saveTimer);
        saveTimer = null;
    }
}

function __setClock(fn) {
    clock = typeof fn === 'function' ? fn : (() => Date.now());
}

module.exports = {
    recall,
    remember,
    rememberNegative,
    reinforce,
    penalize,
    forget,
    stats,
    flush,
    ENABLED,
    __config: {
        POSITIVE_TTL_MS,
        NEGATIVE_TTL_MS,
        HALF_LIFE_MS,
        CONFIDENCE_FLOOR,
        MAX_ENTRIES,
        MAX_FAILURES
    },
    __reset,
    __setClock,
    __buildKey: buildKey
};
