const { logger } = require('./runtime');
const { isEncryptedConfigSegment } = require('../security/config_crypto');
const {
    ADMIN_PASS,
    MAX_CONFIG_LENGTH,
    decodeConfigBase64,
    validateConfig
} = require('../config/schema');

function getConfig(configStr) {
    try {
        if (!configStr || typeof configStr !== 'string') return {};
        const maxLength = isEncryptedConfigSegment(configStr) ? Math.ceil(MAX_CONFIG_LENGTH * 2.5) : MAX_CONFIG_LENGTH;
        if (configStr.length > maxLength) throw new Error(`Config troppo grande (${configStr.length})`);
        const parsed = JSON.parse(decodeConfigBase64(configStr));
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Config non valida');
        return validateConfig(parsed);
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
