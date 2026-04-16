const { Pool } = require('pg');
const trackerRegistry = require('./tracker_registry');
const normalizers = require('./db/normalizers');
const { ensureDatabaseOptimizations } = require('./db/schema');
const { createTorrentRepository } = require('./db/torrent_repository');
const { createSharedStreamCacheRepository } = require('./db/shared_stream_cache_repository');

let pool = null;
let databaseOptimizationsPromise = null;
let cacheEventListenerClient = null;
let cacheEventReconnectTimer = null;
const cacheEventHandlers = new Set();
const CACHE_EVENT_CHANNEL = /^[a-zA-Z0-9_]+$/.test(String(process.env.CACHE_EVENT_CHANNEL || 'leviathan_cache_events'))
  ? String(process.env.CACHE_EVENT_CHANNEL || 'leviathan_cache_events')
  : 'leviathan_cache_events';

const DB_POOL_MAX = normalizers.clampInt(process.env.DB_POOL_MAX, 40, 5, 120);
const DB_POOL_IDLE_TIMEOUT_MS = normalizers.clampInt(process.env.DB_POOL_IDLE_TIMEOUT_MS, 30000, 5000, 120000);
const DB_POOL_CONNECT_TIMEOUT_MS = normalizers.clampInt(process.env.DB_POOL_CONNECT_TIMEOUT_MS, 5000, 1000, 30000);

function buildPoolConfig(config = {}) {
  const sslEnabled = normalizers.normalizeBooleanEnv(process.env.DB_SSL, false);
  const sslConfig = sslEnabled ? { rejectUnauthorized: false } : false;

  if (process.env.DATABASE_URL) {
    return {
      connectionString: process.env.DATABASE_URL,
      ssl: sslConfig
    };
  }

  return {
    host: config.host || process.env.DB_HOST || 'localhost',
    port: normalizers.clampInt(config.port || process.env.DB_PORT, 5432, 1, 65535),
    database: config.database || process.env.DB_NAME || 'torrent_library',
    user: config.user || process.env.DB_USER || 'postgres',
    password: config.password || process.env.DB_PASSWORD,
    ssl: sslConfig
  };
}

function scheduleDatabaseOptimizations() {
  if (!pool) return null;
  if (databaseOptimizationsPromise) return databaseOptimizationsPromise;

  databaseOptimizationsPromise = ensureDatabaseOptimizations(pool)
    .catch((error) => {
      databaseOptimizationsPromise = null;
      throw error;
    })
    .finally(() => {
      if (!pool) databaseOptimizationsPromise = null;
    });

  return databaseOptimizationsPromise;
}

function initDatabase(config = {}) {
  if (pool) return pool;

  const poolConfig = buildPoolConfig(config);
  pool = new Pool({
    ...poolConfig,
    max: DB_POOL_MAX,
    idleTimeoutMillis: DB_POOL_IDLE_TIMEOUT_MS,
    connectionTimeoutMillis: DB_POOL_CONNECT_TIMEOUT_MS,
    allowExitOnIdle: true
  });

  pool.on('error', (error) => {
    console.error(`❌ Unexpected idle client error: ${error.message}`);
  });

  trackerRegistry.initTrackerRegistry();

  scheduleDatabaseOptimizations()?.catch((error) => {
    console.warn(`⚠️ DB optimization bootstrap failed: ${error.message}`);
  });

  console.log(`✅ DB Pool inizializzato (${poolConfig.host || 'DATABASE_URL'})`);
  return pool;
}

async function awaitDatabaseOptimizations() {
  if (!pool) return false;

  try {
    await scheduleDatabaseOptimizations();
    return true;
  } catch (error) {
    console.warn(`⚠️ DB optimization await failed: ${error.message}`);
    return false;
  }
}

async function shutdownDatabase() {
  trackerRegistry.shutdownTrackerRegistry();
  if (!pool) return;

  const currentPool = pool;
  pool = null;
  databaseOptimizationsPromise = null;
  if (cacheEventReconnectTimer) {
    clearTimeout(cacheEventReconnectTimer);
    cacheEventReconnectTimer = null;
  }
  if (cacheEventListenerClient) {
    try {
      await cacheEventListenerClient.query(`UNLISTEN ${CACHE_EVENT_CHANNEL}`);
    } catch (_) {}
    try { cacheEventListenerClient.release(); } catch (_) {}
    cacheEventListenerClient = null;
  }
  await currentPool.end();
}

async function withClient(fn) {
  if (!pool) throw new Error('Pool not initialized');
  const client = await pool.connect();
  try {
    return await fn(client);
  } finally {
    client.release();
  }
}

async function runInTransaction(fn) {
  return withClient(async (client) => {
    await client.query('BEGIN');
    try {
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      try {
        await client.query('ROLLBACK');
      } catch (_) {}
      throw error;
    }
  });
}

async function healthCheck() {
  if (!pool) throw new Error('Pool not initialized');
  await pool.query('SELECT 1');
  return true;
}

function scheduleCacheEventReconnect() {
  if (cacheEventReconnectTimer || cacheEventHandlers.size === 0) return;
  cacheEventReconnectTimer = setTimeout(() => {
    cacheEventReconnectTimer = null;
    ensureCacheEventListener().catch(() => {});
  }, 1500);
  cacheEventReconnectTimer.unref?.();
}

async function ensureCacheEventListener() {
  if (!pool || cacheEventHandlers.size === 0) return false;
  if (cacheEventListenerClient) return true;

  const client = await pool.connect();
  cacheEventListenerClient = client;

  client.on('notification', (message) => {
    if (message.channel !== CACHE_EVENT_CHANNEL) return;
    let payload = null;
    try {
      payload = JSON.parse(String(message.payload || '{}'));
    } catch (_) {
      return;
    }
    for (const handler of cacheEventHandlers) {
      try {
        handler(payload);
      } catch (_) {}
    }
  });

  const reset = () => {
    if (cacheEventListenerClient === client) cacheEventListenerClient = null;
    try { client.release(); } catch (_) {}
    scheduleCacheEventReconnect();
  };

  client.on('error', reset);
  client.on('end', reset);
  await client.query(`LISTEN ${CACHE_EVENT_CHANNEL}`);
  return true;
}

function subscribeCacheEvents(handler) {
  if (typeof handler !== 'function') return () => {};
  cacheEventHandlers.add(handler);
  ensureCacheEventListener().catch(() => {
    scheduleCacheEventReconnect();
  });
  return () => {
    cacheEventHandlers.delete(handler);
  };
}

async function publishCacheEvent(event = {}) {
  if (!pool) return false;
  const payload = JSON.stringify(event);
  if (!payload || payload.length > 7800) return false;
  try {
    await pool.query('SELECT pg_notify($1, $2)', [CACHE_EVENT_CHANNEL, payload]);
    return true;
  } catch (_) {
    return false;
  }
}

const sharedDependencies = {
  getPool: () => pool,
  withClient,
  runInTransaction,
  awaitDatabaseOptimizations,
  trackerRegistry,
  normalizers
};

const torrentRepository = createTorrentRepository(sharedDependencies);
const sharedStreamCacheRepository = createSharedStreamCacheRepository(sharedDependencies);

module.exports = {
  initDatabase,
  shutdownDatabase,
  getPool: () => pool,
  withClient,
  healthCheck,
  subscribeCacheEvents,
  publishCacheEvent,
  ...torrentRepository,
  ...sharedStreamCacheRepository,
  updateTrackers: trackerRegistry.updateTrackers,
  getActiveTrackers: trackerRegistry.getActiveTrackers,
  buildMagnet: trackerRegistry.buildMagnet,
  initTrackerRegistry: trackerRegistry.initTrackerRegistry,
  shutdownTrackerRegistry: trackerRegistry.shutdownTrackerRegistry
};
