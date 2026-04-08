require('dotenv').config();

const { logger } = require('./utils_runtime');

const MAX_CONFIG_LENGTH = Math.max(parseInt(process.env.MAX_CONFIG_LENGTH || '16384', 10) || 16384, 2048);
const ADMIN_PASS = String(process.env.ADMIN_PASS || '').trim();

function decodeConfigBase64(configStr) {
    const normalized = String(configStr || '').trim().replace(/-/g, '+').replace(/_/g, '/');
    const padding = normalized.length % 4 === 0 ? '' : '='.repeat(4 - (normalized.length % 4));
    return Buffer.from(normalized + padding, 'base64').toString('utf8');
}

function getConfig(configStr) {
    try {
        if (!configStr || typeof configStr !== 'string') return {};
        if (configStr.length > MAX_CONFIG_LENGTH) throw new Error(`Config troppo grande (${configStr.length})`);
        const parsed = JSON.parse(decodeConfigBase64(configStr));
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Config non valida');

        const config = { ...parsed };
        config.filters = (config.filters && typeof config.filters === 'object' && !Array.isArray(config.filters)) ? { ...config.filters } : {};

        const aliasPairs = [
            ['enableStreamingCommunity', 'enableVix'],
            ['streamingCommunityLast', 'vixLast']
        ];
        for (const [primaryKey, legacyKey] of aliasPairs) {
            const primaryValue = config.filters[primaryKey];
            const legacyValue = config.filters[legacyKey];
            if (primaryValue !== undefined && legacyValue === undefined) config.filters[legacyKey] = primaryValue;
            if (legacyValue !== undefined && primaryValue === undefined) config.filters[primaryKey] = legacyValue;
        }

        const allowedServices = new Set(['rd', 'ad', 'tb', 'p2p', 'web']);
        if (config.service && !allowedServices.has(String(config.service).toLowerCase())) config.service = 'rd';

        const numericFilterKeys = ['maxPerQuality', 'maxSizeGB', 'instantDebridTop', 'warmupTop'];
        for (const key of numericFilterKeys) {
            if (config.filters[key] !== undefined && config.filters[key] !== null && config.filters[key] !== '') {
                const value = parseInt(config.filters[key], 10);
                if (Number.isNaN(value)) delete config.filters[key];
                else config.filters[key] = value;
            }
        }

        const booleanFilterKeys = ['enableVix', 'enableStreamingCommunity', 'enableGhd', 'enableGs', 'enableAnimeWorld', 'enableGf', 'enableP2P', 'showFake', 'dbOnly', 'allowEng', 'no4k', 'no1080', 'no720', 'noScr', 'noCam', 'enableTrailers', 'vixLast', 'streamingCommunityLast'];
        for (const key of booleanFilterKeys) {
            if (config.filters[key] !== undefined) config.filters[key] = !!config.filters[key];
        }

        if (config.filters.language) {
            const normalizedLanguage = String(config.filters.language).toLowerCase();
            config.filters.language = ['ita', 'eng', 'all'].includes(normalizedLanguage) ? normalizedLanguage : (config.filters.allowEng ? 'all' : 'ita');
        }

        return config;
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
