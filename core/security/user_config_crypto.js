'use strict';

const crypto = require('crypto');
const zlib = require('zlib');
const { promisify } = require('util');

const CONFIG_TOKEN_PREFIX = 'lcfg1_';
const CONFIG_CRYPTO_VERSION = 1;
const USER_CONFIG_ENCRYPTION_ENABLED = false;
const USER_CONFIG_ENCRYPTION_SECRET = '34e14289c3d6642f9a1f2c08065b600a4d7c9a517492e1fd99e2de60c005a9a5';
const USER_CONFIG_AAD = 'leviathan-stremio-config';
const gzipAsync = promisify(zlib.gzip);
const gunzipAsync = promisify(zlib.gunzip);

function getEncryptionKey() {
    return crypto.createHash('sha256').update(USER_CONFIG_ENCRYPTION_SECRET).digest();
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
   
    return encodePlainConfigObject(config);
}

async function encryptConfigObjectLegacy(config) {
    const json = JSON.stringify(normalizeConfigObject(config));
    const compressed = await gzipAsync(Buffer.from(json, 'utf8'), { level: 6 });
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', getEncryptionKey(), iv);
    cipher.setAAD(Buffer.from(USER_CONFIG_AAD, 'utf8'));
    const encrypted = Buffer.concat([cipher.update(compressed), cipher.final()]);
    const tag = cipher.getAuthTag();
    return `${CONFIG_TOKEN_PREFIX}${toBase64Url(Buffer.concat([Buffer.from([CONFIG_CRYPTO_VERSION]), iv, tag, encrypted]))}`;
}

function decryptConfigToken(token) {
    if (!isEncryptedConfigToken(token)) return null;
    const packed = fromBase64Url(String(token).slice(CONFIG_TOKEN_PREFIX.length));
    if (packed.length < 1 + 12 + 16 + 1) throw new Error('Token configurazione cifrato troppo corto');
    const version = packed.readUInt8(0);
    if (version !== CONFIG_CRYPTO_VERSION) throw new Error(`Versione token configurazione non supportata (${version})`);

    const iv = packed.subarray(1, 13);
    const tag = packed.subarray(13, 29);
    const encrypted = packed.subarray(29);
    const decipher = crypto.createDecipheriv('aes-256-gcm', getEncryptionKey(), iv);
    decipher.setAAD(Buffer.from(USER_CONFIG_AAD, 'utf8'));
    decipher.setAuthTag(tag);
    const compressed = Buffer.concat([decipher.update(encrypted), decipher.final()]);
    const json = zlib.gunzipSync(compressed).toString('utf8');
    return json;
}

function buildManifestPathForToken(token) {
    return `/${String(token || '').trim()}/manifest.json`;
}

function buildManifestPathForConfig(config) {
    return buildManifestPathForToken(encodePlainConfigObject(config));
}

module.exports = {
    CONFIG_TOKEN_PREFIX,
    USER_CONFIG_ENCRYPTION_ENABLED,
    isEncryptedConfigToken,
    encodePlainConfigObject,
    encryptConfigObject,
    encryptConfigObjectLegacy,
    decryptConfigToken,
    buildManifestPathForToken,
    buildManifestPathForConfig,
    gunzipAsync
};
