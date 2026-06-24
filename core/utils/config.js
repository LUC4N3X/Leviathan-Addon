const { logger } = require('./runtime');
const { TinyLruCache } = require('./tiny_lru_cache');
const {
    ADMIN_PASS,
    MAX_CONFIG_LENGTH,
    decodeConfigBase64,
    validateConfig
} = require('../config/schema');

const CONFIG_CACHE = new TinyLruCache({
    max: Math.max(64, Number.parseInt(process.env.CONFIG_PARSE_CACHE_MAX || '4096', 10) || 4096),
    ttlMs: Math.max(60_000, Number.parseInt(process.env.CONFIG_PARSE_CACHE_TTL_MS || String(30 * 60 * 1000), 10) || (30 * 60 * 1000))
});

function cloneConfigValue(value) {
    if (!value || typeof value !== 'object') return {};
    try {
        if (typeof structuredClone === 'function') return structuredClone(value);
    } catch (_) {}
    try {
        return JSON.parse(JSON.stringify(value));
    } catch (_) {
        return { ...value };
    }
}

function getConfig(configStr) {
    try {
        if (!configStr || typeof configStr !== 'string') return {};
        if (configStr.length > MAX_CONFIG_LENGTH) throw new Error(`Config troppo grande (${configStr.length})`);
        const cached = CONFIG_CACHE.get(configStr);
        if (cached) return cloneConfigValue(cached);
        const parsed = JSON.parse(decodeConfigBase64(configStr));
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Config non valida');
        const validated = validateConfig(parsed);
        CONFIG_CACHE.set(configStr, validated);
        return cloneConfigValue(validated);
    } catch (err) {
        logger.error(`Errore parsing config: ${err.message}`);
        return {};
    }
}

module.exports = {
    ADMIN_PASS,
    MAX_CONFIG_LENGTH,
    decodeConfigBase64,
    getConfig
};
