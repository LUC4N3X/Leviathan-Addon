'use strict';

const crypto = require('crypto');

function envBool(name, fallback) {
    const raw = process.env[name];
    if (raw === undefined || raw === null || raw === '') return fallback;
    return /^(?:1|true|yes|on)$/i.test(String(raw).trim());
}

const CONFIG_ENCRYPTION_ENABLED = envBool('USER_CONFIG_ENCRYPTION_ENABLED', true);
const CONFIG_ENCRYPTION_PREFIX = 'enc:v1:';
const FALLBACK_SECRET = 'leviathan-local-dev-config-secret-change-me';

function base64UrlEncode(bufferOrString) {
    const buffer = Buffer.isBuffer(bufferOrString) ? bufferOrString : Buffer.from(String(bufferOrString || ''), 'utf8');
    return buffer.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function base64UrlDecode(value) {
    const normalized = String(value || '').trim().replace(/-/g, '+').replace(/_/g, '/');
    const padding = normalized.length % 4 === 0 ? '' : '='.repeat(4 - (normalized.length % 4));
    return Buffer.from(normalized + padding, 'base64');
}

function getSecretMaterial() {
    return String(
        process.env.CONFIG_ENCRYPTION_SECRET
        || process.env.USER_CONFIG_ENCRYPTION_SECRET
        || process.env.LEVIATHAN_CONFIG_SECRET
        || process.env.ADMIN_PASS
        || process.env.TELEMETRY_PASS
        || process.env.LEVIATHAN_SECRET
        || FALLBACK_SECRET
    );
}

function getKey() {
    return crypto.createHash('sha256').update(getSecretMaterial()).digest();
}

function encryptText(plainText) {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', getKey(), iv);
    const ciphertext = Buffer.concat([cipher.update(String(plainText || ''), 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return `${CONFIG_ENCRYPTION_PREFIX}${base64UrlEncode(iv)}.${base64UrlEncode(tag)}.${base64UrlEncode(ciphertext)}`;
}

function decryptText(encoded) {
    const value = String(encoded || '').trim();
    if (!value.startsWith(CONFIG_ENCRYPTION_PREFIX)) throw new Error('Encrypted config prefix non valido');
    const body = value.slice(CONFIG_ENCRYPTION_PREFIX.length);
    const parts = body.split('.');
    if (parts.length !== 3) throw new Error('Encrypted config payload non valido');
    const [ivPart, tagPart, cipherPart] = parts;
    const decipher = crypto.createDecipheriv('aes-256-gcm', getKey(), base64UrlDecode(ivPart));
    decipher.setAuthTag(base64UrlDecode(tagPart));
    const plain = Buffer.concat([decipher.update(base64UrlDecode(cipherPart)), decipher.final()]);
    return plain.toString('utf8');
}

function encodeConfigObject(config = {}) {
    const json = JSON.stringify(config && typeof config === 'object' && !Array.isArray(config) ? config : {});
    if (CONFIG_ENCRYPTION_ENABLED) return encryptText(json);
    return base64UrlEncode(json);
}

function decodeConfigSegment(configStr) {
    const raw = String(configStr || '').trim();
    if (raw.startsWith(CONFIG_ENCRYPTION_PREFIX)) return decryptText(raw);
    return base64UrlDecode(raw).toString('utf8');
}

function isEncryptedConfigSegment(value) {
    return String(value || '').trim().startsWith(CONFIG_ENCRYPTION_PREFIX);
}

function getConfigSecurityStatus() {
    const secretFromEnv = Boolean(
        process.env.CONFIG_ENCRYPTION_SECRET
        || process.env.USER_CONFIG_ENCRYPTION_SECRET
        || process.env.LEVIATHAN_CONFIG_SECRET
        || process.env.ADMIN_PASS
        || process.env.TELEMETRY_PASS
        || process.env.LEVIATHAN_SECRET
    );
    return {
        encryptionEnabled: CONFIG_ENCRYPTION_ENABLED,
        prefix: CONFIG_ENCRYPTION_PREFIX.replace(/:$/, ''),
        algorithm: 'aes-256-gcm',
        secretFromEnv,
        fallbackSecret: !secretFromEnv
    };
}

module.exports = {
    CONFIG_ENCRYPTION_ENABLED,
    CONFIG_ENCRYPTION_PREFIX,
    encodeConfigObject,
    decodeConfigSegment,
    isEncryptedConfigSegment,
    getConfigSecurityStatus,
    base64UrlEncode,
    base64UrlDecode
};
