'use strict';

const crypto = require('crypto');
const { redisCache } = require('../../core/utils/redis_cache');

const SCHEMA_VERSION = 1;

function boolEnv(name, fallback = false) {
  const raw = process.env[name];
  if (raw == null || raw === '') return fallback;
  return ['1', 'true', 'yes', 'y', 'on'].includes(String(raw).trim().toLowerCase());
}

function intEnv(name, fallback, min, max) {
  const parsed = Number.parseInt(process.env[name] || String(fallback), 10);
  const value = Number.isFinite(parsed) ? parsed : fallback;
  return Math.max(min, Math.min(max, value));
}

function hashPart(value, length = 16) {
  return crypto.createHash('sha256').update(String(value || '')).digest('hex').slice(0, length);
}

function cleanPart(value, fallback = 'unknown', max = 120) {
  const clean = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/[^a-z0-9._:-]+/gi, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, max);
  return clean || fallback;
}

function normalizeOrigin(value) {
  try {
    const parsed = new URL(String(value || '').trim());
    if (!['http:', 'https:'].includes(parsed.protocol)) return null;
    return `${parsed.protocol}//${parsed.host}`;
  } catch (_) {
    return null;
  }
}

function ttlSecondsFromSession(session, sessionTtlMs, fallbackSeconds) {
  const now = Date.now();
  const ttlMs = Math.max(60_000, Number(sessionTtlMs || 0));
  const timestamp = Number(session?.timestamp || 0);
  const expiresAt = Number(session?.expiresAt || 0) || (timestamp ? timestamp + ttlMs : now + ttlMs);
  const seconds = Math.floor((expiresAt - now) / 1000);
  if (Number.isFinite(seconds) && seconds > 0) {
    return Math.max(1, Math.min(seconds, fallbackSeconds));
  }
  return Math.max(1, fallbackSeconds);
}

function stripVolatileSessionFields(session = {}) {
  const out = { ...(session || {}) };
  delete out.solutionResponse;
  delete out.solutionResponseUrl;
  delete out.solutionResponseStatus;
  return out;
}

class CfRedisStore {
  constructor() {
    this.sessionEnabled = boolEnv('CF_REDIS_SESSION_ENABLED', true);
    this.nativeEnabled = boolEnv('CF_REDIS_NATIVE_ENABLED', true);
    this.lockEnabled = boolEnv('CF_REDIS_LOCK_ENABLED', true);
    this.sessionNamespace = process.env.CF_REDIS_SESSION_NAMESPACE || 'cfSession';
    this.nativeNamespace = process.env.CF_REDIS_NATIVE_NAMESPACE || 'cfNative';
    this.lockNamespace = process.env.CF_REDIS_LOCK_NAMESPACE || 'cfLock';
    this.sessionTtlSeconds = intEnv('CF_REDIS_SESSION_TTL_SECONDS', 6 * 60 * 60, 60, 24 * 60 * 60);
    this.nativeTtlSeconds = intEnv('CF_REDIS_NATIVE_TTL_SECONDS', 25 * 60, 60, 6 * 60 * 60);
    this.lockTtlMs = intEnv('CF_REDIS_LOCK_TTL_MS', 45_000, 5_000, 5 * 60_000);
    this.lockPollMs = intEnv('CF_REDIS_LOCK_POLL_MS', 350, 75, 2_500);
  }

  isEnabled() {
    return this.sessionEnabled && redisCache.isEnabled();
  }

  isNativeEnabled() {
    return this.nativeEnabled && redisCache.isEnabled();
  }

  isLockEnabled() {
    return this.lockEnabled && redisCache.isEnabled();
  }

  providerSessionKey({ providerName, url, egressKey = 'direct' } = {}) {
    const origin = normalizeOrigin(url) || String(url || '').trim() || 'unknown-origin';
    return [
      cleanPart(providerName || 'provider'),
      cleanPart(origin),
      `egress_${hashPart(egressKey || 'direct')}`
    ].join(':');
  }

  nativeClearanceKey({ host, egressKey = 'direct' } = {}) {
    return [
      cleanPart(host || 'unknown-host'),
      `egress_${hashPart(egressKey || 'direct')}`
    ].join(':');
  }

  lockKeyForProviderSession(args = {}) {
    return this.providerSessionKey(args);
  }

  async getProviderSession({ providerName, url, egressKey = 'direct', sessionTtlMs = null } = {}) {
    if (!this.isEnabled()) return null;
    const key = this.providerSessionKey({ providerName, url, egressKey });
    const envelope = await redisCache.getJson(this.sessionNamespace, key);
    const session = envelope?.session || envelope;
    if (!session || typeof session !== 'object' || !session.userAgent) return null;
    if (envelope?.schemaVersion && Number(envelope.schemaVersion) !== SCHEMA_VERSION) return null;
    if (session.egressKey && String(session.egressKey) !== String(egressKey || 'direct')) return null;
    const timestamp = Number(session.timestamp || 0);
    const ttlMs = Math.max(60_000, Number(sessionTtlMs || this.sessionTtlSeconds * 1000));
    if (!timestamp || Date.now() - timestamp >= ttlMs) return null;
    return { ...session, redisKey: key, redisHydratedAt: Date.now() };
  }

  async saveProviderSession({ providerName, url, egressKey = 'direct', session, sessionTtlMs = null } = {}) {
    if (!this.isEnabled() || !session?.userAgent) return false;
    const cookieHeader = String(session.cookies || '');
    if (!cookieHeader && !session.cookieJar) return false;
    const normalizedUrl = normalizeOrigin(url || session.url || session.solvedUrl) || url || session.url || session.solvedUrl;
    const key = this.providerSessionKey({ providerName, url: normalizedUrl, egressKey });
    const cleanSession = stripVolatileSessionFields({
      ...session,
      url: normalizeOrigin(session.url || normalizedUrl) || normalizeOrigin(normalizedUrl) || session.url || normalizedUrl,
      timestamp: Number(session.timestamp || 0) || Date.now(),
      egressKey: session.egressKey || egressKey || 'direct'
    });
    const ttl = ttlSecondsFromSession(cleanSession, sessionTtlMs || this.sessionTtlSeconds * 1000, this.sessionTtlSeconds);
    return redisCache.setJson(this.sessionNamespace, key, {
      schemaVersion: SCHEMA_VERSION,
      kind: 'provider-session',
      providerName,
      origin: normalizeOrigin(normalizedUrl),
      egressHash: hashPart(egressKey || 'direct'),
      savedAt: Date.now(),
      session: cleanSession
    }, ttl);
  }

  async deleteProviderSession({ providerName, url, egressKey = 'direct' } = {}) {
    if (!this.isEnabled()) return 0;
    const key = this.providerSessionKey({ providerName, url, egressKey });
    return redisCache.del(this.sessionNamespace, key);
  }

  async getNativeClearance({ host, egressKey = 'direct' } = {}) {
    if (!this.isNativeEnabled()) return null;
    const key = this.nativeClearanceKey({ host, egressKey });
    const envelope = await redisCache.getJson(this.nativeNamespace, key);
    const bundle = envelope?.bundle || envelope;
    if (!bundle || typeof bundle !== 'object') return null;
    if (envelope?.schemaVersion && Number(envelope.schemaVersion) !== SCHEMA_VERSION) return null;
    if (bundle.egressKey && String(bundle.egressKey) !== String(egressKey || 'direct')) return null;
    if (Number(bundle.expiresAt || 0) <= Date.now()) return null;
    return { ...bundle, redisKey: key, redisHydratedAt: Date.now() };
  }

  async saveNativeClearance({ host, egressKey = 'direct', bundle, ttlSeconds = null } = {}) {
    if (!this.isNativeEnabled() || !host || !bundle?.cookies) return false;
    const expiresAt = Number(bundle.expiresAt || 0) || (Date.now() + (ttlSeconds || this.nativeTtlSeconds) * 1000);
    if (expiresAt <= Date.now()) return false;
    const key = this.nativeClearanceKey({ host, egressKey });
    const cleanBundle = {
      ...bundle,
      egressKey: bundle.egressKey || egressKey || 'direct',
      expiresAt
    };
    const ttl = Math.max(1, Math.min(
      Number(ttlSeconds || this.nativeTtlSeconds) || this.nativeTtlSeconds,
      Math.floor((expiresAt - Date.now()) / 1000)
    ));
    return redisCache.setJson(this.nativeNamespace, key, {
      schemaVersion: SCHEMA_VERSION,
      kind: 'native-clearance',
      host: cleanPart(host),
      egressHash: hashPart(egressKey || 'direct'),
      savedAt: Date.now(),
      bundle: cleanBundle
    }, ttl);
  }

  async deleteNativeClearance({ host, egressKey = 'direct' } = {}) {
    if (!this.isNativeEnabled()) return 0;
    const key = this.nativeClearanceKey({ host, egressKey });
    return redisCache.del(this.nativeNamespace, key);
  }

  async acquireLock(key, { ttlMs = this.lockTtlMs, owner = null } = {}) {
    if (!this.isLockEnabled() || !key) return null;
    const token = owner || `${process.pid}:${Date.now()}:${crypto.randomBytes(8).toString('hex')}`;
    const ok = await redisCache.setIfAbsent(this.lockNamespace, key, token, ttlMs);
    return ok ? token : null;
  }

  async releaseLock(key, token) {
    if (!this.isLockEnabled() || !key || !token) return false;
    return redisCache.releaseLock(this.lockNamespace, key, token);
  }

  async waitForProviderSession({ providerName, url, egressKey = 'direct', sessionTtlMs = null, timeoutMs = 30_000, pollMs = this.lockPollMs } = {}) {
    if (!this.isEnabled()) return null;
    const deadline = Date.now() + Math.max(0, Number(timeoutMs) || 0);
    while (Date.now() <= deadline) {
      const session = await this.getProviderSession({ providerName, url, egressKey, sessionTtlMs });
      if (session) return session;
      const sleepMs = Math.min(Math.max(75, Number(pollMs) || this.lockPollMs), Math.max(0, deadline - Date.now()));
      if (!sleepMs) break;
      await new Promise(resolve => setTimeout(resolve, sleepMs));
    }
    return null;
  }

  async waitForNativeClearance({ host, egressKey = 'direct', timeoutMs = 10_000, pollMs = this.lockPollMs } = {}) {
    if (!this.isNativeEnabled()) return null;
    const deadline = Date.now() + Math.max(0, Number(timeoutMs) || 0);
    while (Date.now() <= deadline) {
      const bundle = await this.getNativeClearance({ host, egressKey });
      if (bundle) return bundle;
      const sleepMs = Math.min(Math.max(75, Number(pollMs) || this.lockPollMs), Math.max(0, deadline - Date.now()));
      if (!sleepMs) break;
      await new Promise(resolve => setTimeout(resolve, sleepMs));
    }
    return null;
  }
}

const cfRedisStore = new CfRedisStore();

module.exports = {
  cfRedisStore,
  CfRedisStore,
  normalizeOrigin,
  hashPart,
  SCHEMA_VERSION
};
