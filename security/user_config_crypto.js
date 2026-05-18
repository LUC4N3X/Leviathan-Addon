'use strict';

const crypto = require('crypto');
const zlib = require('zlib');
const { promisify } = require('util');

const CONFIG_TOKEN_PREFIX = 'lcfg1_';
const CONFIG_CRYPTO_VERSION = 1;
const USER_CONFIG_AAD = 'leviathan-stremio-config';
const gzipAsync = promisify(zlib.gzip);
const gunzipAsync = promisify(zlib.gunzip);

// Solo per leggere eventuali token lcfg1_ generati da vecchie build.
// I nuovi token NON usano mai questo valore: serve USER_CONFIG_SECRET/CONFIG_SECRET in ENV.
const LEGACY_CONFIG_DECRYPTION_SECRET = '34e14289c3d6642f9a1f2c08065b600a4d7c9a517492e1fd99e2de60c005a9a5';

function getConfiguredSecret() {
    return String(
        process.env.USER_CONFIG_SECRET ||
        process.env.CONFIG_SECRET ||
        process.env.USER_CONFIG_ENCRYPTION_SECRET ||
        ''
    ).trim();
}

function isUserConfigEncryptionEnabled() {
    return getConfiguredSecret().length >= 16;
}

function getEncryptionKey(secret = getConfiguredSecret()) {
    const normalizedSecret = String(secret || '').trim();
    if (normalizedSecret.length < 16) {
        throw new Error('USER_CONFIG_SECRET mancante o troppo corto: usa almeno 32 caratteri casuali');
    }
    return crypto.createHash('sha256').update(normalizedSecret).digest();
}

function toBase64Url(buffer) {
    return Buffer.from(buffer).toString('base64url');
}

function fromBase64Url(value) {
    return Buffer.from(String(value || ''), 'base64url');
}

function isEncryptedConfigToken(value) {
    return String(value || '').startsWith(CONFIG_TOKEN_PREFIX);
}

function normalizeConfigObject(config) {
    return config && typeof config === 'object' && !Array.isArray(config) ? config : {};
}

function encodePlainConfigObject(config) {
    const json = JSON.stringify(normalizeConfigObject(config));
    return toBase64Url(Buffer.from(json, 'utf8'));
}

async function encryptConfigObject(config) {
    if (!isUserConfigEncryptionEnabled()) return encodePlainConfigObject(config);

    const json = JSON.stringify(normalizeConfigObject(config));
    const compressed = await gzipAsync(Buffer.from(json, 'utf8'), { level: 6 });
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', getEncryptionKey(), iv);
    cipher.setAAD(Buffer.from(USER_CONFIG_AAD, 'utf8'));
    const encrypted = Buffer.concat([cipher.update(compressed), cipher.final()]);
    const tag = cipher.getAuthTag();
    return `${CONFIG_TOKEN_PREFIX}${toBase64Url(Buffer.concat([Buffer.from([CONFIG_CRYPTO_VERSION]), iv, tag, encrypted]))}`;
}

// Compatibilità API interna: il vecchio nome ora punta alla cifratura reale quando ENV è configurato.
async function encryptConfigObjectLegacy(config) {
    return encryptConfigObject(config);
}

function unpackEncryptedToken(token) {
    const packed = fromBase64Url(String(token).slice(CONFIG_TOKEN_PREFIX.length));
    if (packed.length < 1 + 12 + 16 + 1) throw new Error('Token configurazione cifrato troppo corto');
    const version = packed.readUInt8(0);
    if (version !== CONFIG_CRYPTO_VERSION) throw new Error(`Versione token configurazione non supportata (${version})`);

    return {
        iv: packed.subarray(1, 13),
        tag: packed.subarray(13, 29),
        encrypted: packed.subarray(29)
    };
}

function decryptPackedToken(packedToken, secret) {
    const decipher = crypto.createDecipheriv('aes-256-gcm', getEncryptionKey(secret), packedToken.iv);
    decipher.setAAD(Buffer.from(USER_CONFIG_AAD, 'utf8'));
    decipher.setAuthTag(packedToken.tag);
    const compressed = Buffer.concat([decipher.update(packedToken.encrypted), decipher.final()]);
    return zlib.gunzipSync(compressed).toString('utf8');
}

function decryptConfigToken(token) {
    if (!isEncryptedConfigToken(token)) return null;

    const packedToken = unpackEncryptedToken(token);
    const configuredSecret = getConfiguredSecret();
    const secretsToTry = [];
    if (configuredSecret) secretsToTry.push(configuredSecret);
    if (configuredSecret !== LEGACY_CONFIG_DECRYPTION_SECRET) secretsToTry.push(LEGACY_CONFIG_DECRYPTION_SECRET);

    let lastError = null;
    for (const secret of secretsToTry) {
        try {
            return decryptPackedToken(packedToken, secret);
        } catch (error) {
            lastError = error;
        }
    }

    if (!configuredSecret) {
        throw new Error('USER_CONFIG_SECRET mancante: impossibile decifrare il token configurazione');
    }
    throw lastError || new Error('Token configurazione non decifrabile');
}

function buildManifestPathForToken(token) {
    return `/${String(token || '').trim()}/manifest.json`;
}

async function buildManifestPathForConfig(config) {
    return buildManifestPathForToken(await encryptConfigObject(config));
}

module.exports = {
    CONFIG_TOKEN_PREFIX,
    get USER_CONFIG_ENCRYPTION_ENABLED() { return isUserConfigEncryptionEnabled(); },
    isUserConfigEncryptionEnabled,
    isEncryptedConfigToken,
    encodePlainConfigObject,
    encryptConfigObject,
    encryptConfigObjectLegacy,
    decryptConfigToken,
    buildManifestPathForToken,
    buildManifestPathForConfig,
    gunzipAsync
};
