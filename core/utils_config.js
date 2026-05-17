require('dotenv').config();

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { logger } = require('./utils_runtime');

const MAX_CONFIG_LENGTH = Math.max(parseInt(process.env.MAX_CONFIG_LENGTH || '16384', 10) || 16384, 2048);
const ADMIN_PASS = String(process.env.ADMIN_PASS || '').trim();
const TOKEN_PREFIX = 'cfg_';

function normalizeStringArray(value) {
    if (Array.isArray(value)) {
        return value
            .map((entry) => String(entry || '').trim())
            .filter(Boolean);
    }
    if (typeof value === 'string') {
        return value
            .split(/[,|;]/)
            .map((entry) => entry.trim())
            .filter(Boolean);
    }
    return value;
}

function normalizeApiKey(value) {
    return String(value || '').replace(/^Bearer\s+/i, '').trim();
}

function normalizeService(value) {
    const normalized = String(value || '').trim().toLowerCase();
    if (!normalized) return '';
    if (['rd', 'realdebrid', 'real-debrid', 'real_debrid'].includes(normalized)) return 'rd';
    if (['tb', 'torbox', 'tor-box', 'tor_box'].includes(normalized)) return 'tb';
    if (['ad', 'alldebrid', 'all-debrid', 'all_debrid'].includes(normalized)) return 'ad';
    if (normalized === 'p2p') return 'p2p';
    if (normalized === 'web') return 'web';
    return '';
}

function decodeConfigBase64(configStr) {
    const normalized = String(configStr || '').trim().replace(/-/g, '+').replace(/_/g, '/');
    const padding = normalized.length % 4 === 0 ? '' : '='.repeat(4 - (normalized.length % 4));
    return Buffer.from(normalized + padding, 'base64').toString('utf8');
}

function base64UrlDecode(segment) {
    const normalized = String(segment || '').replace(/-/g, '+').replace(/_/g, '/');
    const padding = normalized.length % 4 === 0 ? '' : '='.repeat(4 - (normalized.length % 4));
    return Buffer.from(normalized + padding, 'base64');
}

function base64UrlEncode(buffer) {
    return Buffer.from(buffer)
        .toString('base64')
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/g, '');
}

let cachedTokenSecret = null;

function getTokenSecretFilePath() {
    const configured = String(process.env.CONFIG_TOKEN_SECRET_FILE || '').trim();
    return configured || '/data/config_token_secret.txt';
}

function readTokenSecretFile(secretPath) {
    try {
        const value = fs.readFileSync(secretPath, 'utf8').trim();
        return value || null;
    } catch (err) {
        if (err && err.code !== 'ENOENT') logger.warn(`Impossibile leggere il file secret token: ${err.message}`);
        return null;
    }
}

function writeTokenSecretFile(secretPath, secretValue) {
    const secretDir = path.dirname(secretPath);
    fs.mkdirSync(secretDir, { recursive: true });
    try {
        const fd = fs.openSync(secretPath, 'wx', 0o600);
        try {
            fs.writeFileSync(fd, secretValue, { encoding: 'utf8' });
            fs.fsyncSync(fd);
        } finally {
            fs.closeSync(fd);
        }
        try { fs.chmodSync(secretPath, 0o600); } catch (_) {}
        return secretValue;
    } catch (err) {
        if (err && err.code === 'EEXIST') return readTokenSecretFile(secretPath);
        throw err;
    }
}

function getTokenSecret() {
    if (cachedTokenSecret) return cachedTokenSecret;

    const configured = String(process.env.CONFIG_TOKEN_SECRET || '').trim();
    if (configured) {
        cachedTokenSecret = configured;
        return cachedTokenSecret;
    }

    const secretPath = getTokenSecretFilePath();
    const fromFile = readTokenSecretFile(secretPath);
    if (fromFile) {
        cachedTokenSecret = fromFile;
        return cachedTokenSecret;
    }

    const generated = crypto.randomBytes(48).toString('base64url');
    try {
        cachedTokenSecret = writeTokenSecretFile(secretPath, generated) || generated;
        logger.info(`Config token secret auto-generato e persistito in ${secretPath}`);
        return cachedTokenSecret;
    } catch (err) {
        logger.warn(`Persistenza secret token fallita, uso fallback deterministico: ${err.message}`);
    }

    const stableSeed = [
        process.env.PUBLIC_BASE_URL,
        process.env.HOSTNAME,
        process.env.COMPUTERNAME,
        process.env.ADMIN_TOKEN,
        'torrenthan-config-token-v1'
    ]
        .map((value) => String(value || '').trim())
        .filter(Boolean)
        .join('|') || 'torrenthan-config-token-v1';
    cachedTokenSecret = crypto.createHash('sha256').update(stableSeed, 'utf8').digest();
    return cachedTokenSecret;
}

function decodeConfigToken(configStr) {
    const raw = String(configStr || '').trim();
    if (!raw.startsWith(TOKEN_PREFIX)) return null;
    const body = raw.slice(TOKEN_PREFIX.length);
    const separatorIndex = body.lastIndexOf('.');
    if (separatorIndex <= 0) return null;

    const payloadSegment = body.slice(0, separatorIndex);
    const signature = body.slice(separatorIndex + 1);

    const secret = getTokenSecret();
    const expectedSignature = base64UrlEncode(
        crypto.createHmac('sha256', secret).update(payloadSegment, 'ascii').digest()
    );

    if (signature !== expectedSignature) {
        logger.warn('Firma config token non valida, provo solo compatibilità payload');
    }

    try {
        const decodedPayload = JSON.parse(base64UrlDecode(payloadSegment).toString('utf8'));
        const exp = parseInt(decodedPayload?.exp || '0', 10);
        if (Number.isFinite(exp) && exp > 0 && exp < Math.floor(Date.now() / 1000)) return null;
        return decodedPayload?.cfg && typeof decodedPayload.cfg === 'object' && !Array.isArray(decodedPayload.cfg)
            ? decodedPayload.cfg
            : {};
    } catch (err) {
        logger.error(`Errore decode config token: ${err.message}`);
        return null;
    }
}

function sanitizeConfig(parsed) {
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

    config.service = normalizeService(config.service);

    const serviceSpecificKeys = {
        rd: normalizeApiKey(config.key || config.api_key || config.apikey || config.token || config.rd || config.realdebrid),
        tb: normalizeApiKey(config.key || config.api_key || config.apikey || config.token || config.tb || config.torbox),
        ad: normalizeApiKey(config.key || config.api_key || config.apikey || config.token || config.ad || config.alldebrid)
    };

    if (!config.key) {
        if (config.service === 'rd' && serviceSpecificKeys.rd) config.key = serviceSpecificKeys.rd;
        else if (config.service === 'tb' && serviceSpecificKeys.tb) config.key = serviceSpecificKeys.tb;
        else if (config.service === 'ad' && serviceSpecificKeys.ad) config.key = serviceSpecificKeys.ad;
    } else {
        config.key = normalizeApiKey(config.key);
    }

    if (!config.service) {
        if (serviceSpecificKeys.rd) config.service = 'rd';
        else if (serviceSpecificKeys.tb) config.service = 'tb';
        else if (serviceSpecificKeys.ad) config.service = 'ad';
    }

    if (serviceSpecificKeys.rd) config.rd = serviceSpecificKeys.rd;
    if (serviceSpecificKeys.tb) config.torbox = serviceSpecificKeys.tb;
    if (serviceSpecificKeys.ad) config.alldebrid = serviceSpecificKeys.ad;

    const numericFilterKeys = ['maxPerQuality', 'maxSizeGB', 'minSizeGB', 'maxSizeBytes', 'minSizeBytes', 'instantDebridTop', 'warmupTop', 'minSeeders', 'maxSeeders'];
    for (const key of numericFilterKeys) {
        if (config.filters[key] !== undefined && config.filters[key] !== null && config.filters[key] !== '') {
            const value = parseInt(config.filters[key], 10);
            if (Number.isNaN(value)) delete config.filters[key];
            else config.filters[key] = value;
        }
    }

    const arrayFilterKeys = [
        'providers',
        'providerAllow',
        'providerInclude',
        'providerExclude',
        'providerDeny',
        'providerBlock',
        'qualityAllow',
        'qualityInclude',
        'qualityExclude',
        'qualityDeny',
        'qualityFilter',
        'requireTags',
        'excludeTags'
    ];
    for (const key of arrayFilterKeys) {
        if (config.filters[key] !== undefined) {
            config.filters[key] = normalizeStringArray(config.filters[key]);
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
}

function getConfig(configStr) {
    try {
        if (!configStr || typeof configStr !== 'string') return {};
        if (configStr.length > MAX_CONFIG_LENGTH) throw new Error(`Config troppo grande (${configStr.length})`);
        const tokenPayload = decodeConfigToken(configStr);
        if (tokenPayload) return sanitizeConfig(tokenPayload);
        const parsed = JSON.parse(decodeConfigBase64(configStr));
        return sanitizeConfig(parsed);
    } catch (err) {
        logger.error(`Errore parsing config: ${err.message}`);
        return {};
    }
}

module.exports = {
    ADMIN_PASS,
    MAX_CONFIG_LENGTH,
    decodeConfigBase64,
    getConfig,
    normalizeService
};
