require('dotenv').config();

const { logger } = require('./utils_runtime');
const { validateAndNormalizeConfig } = require('./config/schema');

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
        return validateAndNormalizeConfig(parsed);
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
