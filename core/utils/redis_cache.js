'use strict';

const net = require('net');
const crypto = require('crypto');

function boolEnv(name, fallback = false) {
  const value = process.env[name];
  if (value === undefined || value === null || value === '') return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'y', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'n', 'off'].includes(normalized)) return false;
  return fallback;
}

function intEnv(name, fallback, min, max) {
  const parsed = parseInt(process.env[name] || String(fallback), 10);
  const safe = Number.isFinite(parsed) ? parsed : fallback;
  return Math.max(min, Math.min(max, safe));
}

function parseRedisUrl(rawUrl) {
  const fallback = { host: '127.0.0.1', port: 6379, db: 0, password: null };
  const value = String(rawUrl || '').trim();
  if (!value) return fallback;
  try {
    const parsed = new URL(value);
    return {
      host: parsed.hostname || fallback.host,
      port: Number(parsed.port || fallback.port) || fallback.port,
      db: parsed.pathname && parsed.pathname !== '/' ? Math.max(0, parseInt(parsed.pathname.slice(1), 10) || 0) : 0,
      password: parsed.password ? decodeURIComponent(parsed.password) : null
    };
  } catch (_) {
    const [hostPart, portPart] = value.split(':');
    return {
      ...fallback,
      host: hostPart || fallback.host,
      port: Number(portPart || fallback.port) || fallback.port
    };
  }
}

function encodeCommand(args) {
  const parts = [`*${args.length}\r\n`];
  for (const arg of args) {
    const buf = Buffer.isBuffer(arg) ? arg : Buffer.from(String(arg), 'utf8');
    parts.push(`$${buf.length}\r\n`);
    parts.push(buf);
    parts.push('\r\n');
  }
  return Buffer.concat(parts.map((part) => Buffer.isBuffer(part) ? part : Buffer.from(part)));
}

function findCrlf(buffer, start) {
  for (let index = start; index < buffer.length - 1; index += 1) {
    if (buffer[index] === 13 && buffer[index + 1] === 10) return index;
  }
  return -1;
}

function parseResp(buffer, offset = 0) {
  if (offset >= buffer.length) return null;
  const type = String.fromCharCode(buffer[offset]);

  if (type === '+' || type === '-' || type === ':') {
    const end = findCrlf(buffer, offset + 1);
    if (end === -1) return null;
    const text = buffer.slice(offset + 1, end).toString('utf8');
    if (type === '-') return { value: new Error(text), offset: end + 2, error: true };
    if (type === ':') return { value: Number(text), offset: end + 2 };
    return { value: text, offset: end + 2 };
  }

  if (type === '$') {
    const end = findCrlf(buffer, offset + 1);
    if (end === -1) return null;
    const len = Number(buffer.slice(offset + 1, end).toString('utf8'));
    if (len < 0) return { value: null, offset: end + 2 };
    const start = end + 2;
    const after = start + len;
    if (buffer.length < after + 2) return null;
    return { value: buffer.slice(start, after), offset: after + 2 };
  }

  if (type === '*') {
    const end = findCrlf(buffer, offset + 1);
    if (end === -1) return null;
    const len = Number(buffer.slice(offset + 1, end).toString('utf8'));
    if (len < 0) return { value: null, offset: end + 2 };
    let cursor = end + 2;
    const arr = [];
    for (let index = 0; index < len; index += 1) {
      const parsed = parseResp(buffer, cursor);
      if (!parsed) return null;
      if (parsed.error) return parsed;
      arr.push(parsed.value);
      cursor = parsed.offset;
    }
    return { value: arr, offset: cursor };
  }

  return { value: new Error(`Unsupported Redis RESP type: ${type}`), offset: buffer.length, error: true };
}

class TinyRedisClient {
  constructor({ host, port, password, db, timeoutMs }) {
    this.host = host;
    this.port = port;
    this.password = password;
    this.db = db;
    this.timeoutMs = timeoutMs;
    this.socket = null;
    this.buffer = Buffer.alloc(0);
    this.pending = [];
    this.connecting = null;
    this.authenticated = false;
  }

  async connect() {
    if (this.socket && !this.socket.destroyed) return true;
    if (this.connecting) return this.connecting;

    this.connecting = new Promise((resolve, reject) => {
      const socket = net.createConnection({ host: this.host, port: this.port });
      let settled = false;
      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          socket.destroy(new Error('redis_connect_timeout'));
          reject(new Error('redis_connect_timeout'));
        }
      }, this.timeoutMs);

      socket.setNoDelay(true);
      socket.on('connect', () => {
        clearTimeout(timer);
        if (!settled) {
          settled = true;
          this.socket = socket;
          this.buffer = Buffer.alloc(0);
          this.authenticated = false;
          resolve(true);
        }
      });
      socket.on('data', (chunk) => this._onData(chunk));
      socket.on('error', (error) => this._failAll(error));
      socket.on('close', () => this._failAll(new Error('redis_connection_closed')));
    }).finally(() => {
      this.connecting = null;
    });

    await this.connecting;

    if (!this.authenticated) {
      if (this.password) await this.command('AUTH', this.password);
      if (this.db > 0) await this.command('SELECT', String(this.db));
      this.authenticated = true;
    }

    return true;
  }

  _onData(chunk) {
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk;
    while (this.pending.length > 0) {
      const parsed = parseResp(this.buffer, 0);
      if (!parsed) break;
      this.buffer = parsed.offset >= this.buffer.length ? Buffer.alloc(0) : this.buffer.slice(parsed.offset);
      const request = this.pending.shift();
      clearTimeout(request.timer);
      if (parsed.error) request.reject(parsed.value);
      else request.resolve(parsed.value);
    }
  }

  _failAll(error) {
    if (this.socket && !this.socket.destroyed) {
      try { this.socket.destroy(); } catch (_) {}
    }
    this.socket = null;
    this.authenticated = false;
    this.buffer = Buffer.alloc(0);
    const pending = this.pending.splice(0);
    for (const request of pending) {
      clearTimeout(request.timer);
      request.reject(error || new Error('redis_error'));
    }
  }

  async command(...args) {
    await this.connect();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error('redis_command_timeout'));
        this._failAll(new Error('redis_command_timeout'));
      }, this.timeoutMs);

      this.pending.push({ resolve, reject, timer });
      try {
        this.socket.write(encodeCommand(args));
      } catch (error) {
        clearTimeout(timer);
        this.pending.pop();
        reject(error);
      }
    });
  }
}

function normalizeRedisValue(value) {
  if (Buffer.isBuffer(value)) return value.toString('utf8');
  return value;
}

class RedisCacheFacade {
  constructor() {
    const config = parseRedisUrl(process.env.REDIS_URL || 'redis://redis:6379/0');
    this.enabled = boolEnv('REDIS_ENABLED', false) || boolEnv('REDIS_CACHE_ENABLED', false);
    this.prefix = String(process.env.REDIS_CACHE_PREFIX || 'leviathan:').trim() || 'leviathan:';
    this.maxValueBytes = intEnv('REDIS_CACHE_MAX_VALUE_BYTES', 512 * 1024, 4096, 5 * 1024 * 1024);
    this.timeoutMs = intEnv('REDIS_TIMEOUT_MS', 150, 25, 5000);
    this.cooldownMs = intEnv('REDIS_ERROR_COOLDOWN_MS', 5000, 250, 60000);
    this.disabledUntil = 0;
    this.client = new TinyRedisClient({ ...config, timeoutMs: this.timeoutMs });
  }

  isEnabled() {
    return this.enabled && Date.now() >= this.disabledUntil;
  }

  _namespace(namespace) {
    return String(namespace || 'cache').replace(/[^a-z0-9:_-]+/gi, '_').slice(0, 80) || 'cache';
  }

  key(namespace, key) {
    const ns = this._namespace(namespace);
    let normalized = String(key || '').trim();
    if (!normalized) normalized = 'empty';
    normalized = normalized.replace(/[\r\n\t]+/g, ' ');
    if (normalized.length > 700) {
      normalized = `sha256:${crypto.createHash('sha256').update(normalized).digest('hex')}`;
    }
    return `${this.prefix}${ns}:${normalized}`;
  }

  _onError() {
    this.disabledUntil = Date.now() + this.cooldownMs;
  }

  async ping() {
    if (!this.isEnabled()) return false;
    try {
      const pong = await this.client.command('PING');
      return String(normalizeRedisValue(pong)).toUpperCase() === 'PONG';
    } catch (_) {
      this._onError();
      return false;
    }
  }


  async get(namespace, key) {
    if (!this.isEnabled()) return undefined;
    try {
      const value = await this.client.command('GET', this.key(namespace, key));
      if (value === null || value === undefined) return undefined;
      return normalizeRedisValue(value);
    } catch (_) {
      this._onError();
      return undefined;
    }
  }

  async set(namespace, key, value, ttlSeconds = 300) {
    if (!this.isEnabled()) return false;
    try {
      const ttl = Math.max(1, Math.floor(Number(ttlSeconds) || 1));
      const payload = Buffer.isBuffer(value) ? value : Buffer.from(String(value), 'utf8');
      if (payload.length > this.maxValueBytes) return false;
      await this.client.command('SET', this.key(namespace, key), payload, 'EX', String(ttl));
      return true;
    } catch (_) {
      this._onError();
      return false;
    }
  }

  async setIfAbsent(namespace, key, value, ttlMs = 30000) {
    if (!this.isEnabled()) return false;
    try {
      const safeTtl = Math.max(1, Math.floor(Number(ttlMs) || 1));
      const payload = Buffer.isBuffer(value) ? value : Buffer.from(String(value), 'utf8');
      if (payload.length > 4096) return false;
      const result = await this.client.command('SET', this.key(namespace, key), payload, 'NX', 'PX', String(safeTtl));
      return String(normalizeRedisValue(result) || '').toUpperCase() === 'OK';
    } catch (_) {
      this._onError();
      return false;
    }
  }

  async releaseLock(namespace, key, token) {
    if (!this.isEnabled()) return false;
    try {
      const script = "if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) else return 0 end";
      const released = await this.client.command('EVAL', script, '1', this.key(namespace, key), String(token || ''));
      return Number(released || 0) > 0;
    } catch (_) {
      this._onError();
      return false;
    }
  }

  async getJson(namespace, key) {
    if (!this.isEnabled()) return undefined;
    try {
      const value = await this.client.command('GET', this.key(namespace, key));
      if (value === null || value === undefined) return undefined;
      return JSON.parse(Buffer.isBuffer(value) ? value.toString('utf8') : String(value));
    } catch (_) {
      this._onError();
      return undefined;
    }
  }

  async setJson(namespace, key, value, ttlSeconds = 300) {
    if (!this.isEnabled()) return false;
    try {
      const ttl = Math.max(1, Math.floor(Number(ttlSeconds) || 1));
      const payload = Buffer.from(JSON.stringify(value), 'utf8');
      if (payload.length > this.maxValueBytes) return false;
      await this.client.command('SET', this.key(namespace, key), payload, 'EX', String(ttl));
      return true;
    } catch (_) {
      this._onError();
      return false;
    }
  }

  async del(namespace, key) {
    if (!this.isEnabled()) return 0;
    try {
      const deleted = await this.client.command('DEL', this.key(namespace, key));
      return Number(deleted || 0);
    } catch (_) {
      this._onError();
      return 0;
    }
  }

  async hmget(namespace, key, fields) {
    if (!this.isEnabled()) return [];
    const list = (Array.isArray(fields) ? fields : []).filter((field) => field !== undefined && field !== null);
    if (list.length === 0) return [];
    try {
      const values = await this.client.command('HMGET', this.key(namespace, key), ...list);
      return (Array.isArray(values) ? values : []).map((value) => (value === null || value === undefined ? null : String(normalizeRedisValue(value))));
    } catch (_) {
      this._onError();
      return [];
    }
  }

  async hsetMany(namespace, key, pairs) {
    if (!this.isEnabled()) return false;
    const flat = [];
    for (const [field, value] of Array.isArray(pairs) ? pairs : []) {
      if (field === undefined || field === null) continue;
      flat.push(String(field), String(value));
    }
    if (flat.length === 0) return false;
    try {
      await this.client.command('HSET', this.key(namespace, key), ...flat);
      return true;
    } catch (_) {
      this._onError();
      return false;
    }
  }

  async hdel(namespace, key, fields) {
    if (!this.isEnabled()) return 0;
    const list = (Array.isArray(fields) ? fields : []).filter((field) => field !== undefined && field !== null).map(String);
    if (list.length === 0) return 0;
    try {
      const removed = await this.client.command('HDEL', this.key(namespace, key), ...list);
      return Number(removed || 0);
    } catch (_) {
      this._onError();
      return 0;
    }
  }

  async expire(namespace, key, ttlSeconds) {
    if (!this.isEnabled()) return false;
    try {
      const ttl = Math.max(1, Math.floor(Number(ttlSeconds) || 1));
      await this.client.command('EXPIRE', this.key(namespace, key), String(ttl));
      return true;
    } catch (_) {
      this._onError();
      return false;
    }
  }

  async deleteNamespace(namespace, { maxKeys = 5000 } = {}) {
    if (!this.isEnabled()) return 0;
    const ns = this._namespace(namespace);
    const pattern = `${this.prefix}${ns}:*`;
    let cursor = '0';
    let deleted = 0;
    let scanned = 0;
    try {
      do {
        const result = await this.client.command('SCAN', cursor, 'MATCH', pattern, 'COUNT', '100');
        cursor = Buffer.isBuffer(result?.[0]) ? result[0].toString('utf8') : String(result?.[0] || '0');
        const keys = Array.isArray(result?.[1]) ? result[1].map((item) => Buffer.isBuffer(item) ? item.toString('utf8') : String(item)) : [];
        scanned += keys.length;
        if (keys.length) deleted += Number(await this.client.command('DEL', ...keys) || 0);
        if (scanned >= maxKeys) break;
      } while (cursor !== '0');
      return deleted;
    } catch (_) {
      this._onError();
      return deleted;
    }
  }

  async infoMemory() {
    if (!this.isEnabled()) return null;
    try {
      const raw = await this.client.command('INFO', 'memory');
      const text = Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw || '');
      const out = {};
      for (const line of text.split(/\r?\n/)) {
        const idx = line.indexOf(':');
        if (idx <= 0) continue;
        out[line.slice(0, idx)] = line.slice(idx + 1);
      }
      return out;
    } catch (_) {
      this._onError();
      return null;
    }
  }
}

const redisCache = new RedisCacheFacade();

function writeJsonLater(namespace, key, value, ttlSeconds) {
  if (!redisCache.isEnabled()) return false;
  redisCache.setJson(namespace, key, value, ttlSeconds).catch(() => {});
  return true;
}

module.exports = {
  redisCache,
  writeJsonLater
};
