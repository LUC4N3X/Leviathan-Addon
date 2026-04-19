const { Pool } = require('pg');
const trackerRegistry = require('./tracker_registry');
const normalizers = require('./db/normalizers');
const { ensureDatabaseOptimizations } = require('./db/schema');
const { createTorrentRepository } = require('./db/torrent_repository');
const { createSharedStreamCacheRepository } = require('./db/shared_stream_cache_repository');

let pool = null;
let databaseOptimizationsPromise = null;
let notificationClient = null;
let notificationReconnectPromise = null;
let notificationReconnectTimer = null;
const notificationHandlers = new Map();
const subscribedChannels = new Set();

const DB_POOL_MAX = normalizers.clampInt(process.env.DB_POOL_MAX, 40, 5, 120);
const DB_POOL_IDLE_TIMEOUT_MS = normalizers.clampInt(process.env.DB_POOL_IDLE_TIMEOUT_MS, 30000, 5000, 120000);
const DB_POOL_CONNECT_TIMEOUT_MS = normalizers.clampInt(process.env.DB_POOL_CONNECT_TIMEOUT_MS, 5000, 1000, 30000);
const DB_STATEMENT_TIMEOUT_MS = normalizers.clampInt(process.env.DB_STATEMENT_TIMEOUT_MS, 15000, 1000, 120000);
const DB_QUERY_TIMEOUT_MS = normalizers.clampInt(process.env.DB_QUERY_TIMEOUT_MS, 20000, 1000, 120000);
const DB_LOCK_TIMEOUT_MS = normalizers.clampInt(process.env.DB_LOCK_TIMEOUT_MS, 5000, 250, 60000);
const DB_IDLE_TX_TIMEOUT_MS = normalizers.clampInt(process.env.DB_IDLE_TX_TIMEOUT_MS, 15000, 1000, 120000);
const DB_NOTIFICATION_RECONNECT_DELAY_MS = normalizers.clampInt(process.env.DB_NOTIFICATION_RECONNECT_DELAY_MS, 2000, 250, 30000);

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

function assertNotificationChannel(channel) {
  const normalized = String(channel || '').trim().toLowerCase();
  if (!/^[a-z0-9_]+$/.test(normalized)) throw new Error(`Invalid notification channel: ${channel}`);
  return normalized;
}

function releaseNotificationClient(client, error = null) {
  if (!client || client.__leviReleased === true) return;
  client.__leviReleased = true;
  try {
    client.release(error || undefined);
  } catch (_) {}
}

function clearNotificationReconnectTimer() {
  if (!notificationReconnectTimer) return;
  clearTimeout(notificationReconnectTimer);
  notificationReconnectTimer = null;
}

function scheduleNotificationReconnect(reason = 'unknown') {
  if (!pool || subscribedChannels.size === 0) return;
  if (notificationClient || notificationReconnectPromise || notificationReconnectTimer) return;

  notificationReconnectTimer = setTimeout(() => {
    notificationReconnectTimer = null;
    notificationReconnectPromise = ensureNotificationClient()
      .catch((error) => {
        console.warn(`⚠️ DB notification reconnect failed (${reason}): ${error.message}`);
        scheduleNotificationReconnect('retry');
        return null;
      })
      .finally(() => {
        notificationReconnectPromise = null;
      });
  }, DB_NOTIFICATION_RECONNECT_DELAY_MS);

  if (typeof notificationReconnectTimer.unref === 'function') {
    notificationReconnectTimer.unref();
  }
}

function handleNotificationClientLoss(client, reason) {
  if (notificationClient === client) notificationClient = null;
  releaseNotificationClient(client, reason instanceof Error ? reason : new Error(String(reason || 'notification_client_lost')));
  scheduleNotificationReconnect(reason instanceof Error ? reason.message : String(reason || 'lost'));
}

async function ensureNotificationClient() {
  if (!pool) throw new Error('Pool not initialized');
  if (notificationClient) return notificationClient;
  if (notificationReconnectPromise) return notificationReconnectPromise;

  notificationReconnectPromise = (async () => {
    clearNotificationReconnectTimer();

    const client = await pool.connect();
    client.__leviReleased = false;
    notificationClient = client;

    client.on('notification', (message) => {
      const channel = String(message?.channel || '').trim().toLowerCase();
      const handlers = notificationHandlers.get(channel);
      if (!handlers || handlers.size === 0) return;

      let payload = null;
      try {
        payload = message?.payload ? JSON.parse(message.payload) : null;
      } catch (_) {
        payload = { raw: message?.payload || null };
      }

      for (const handler of handlers) {
        try {
          handler(payload);
        } catch (error) {
          console.warn(`⚠️ Notification handler failed on ${channel}: ${error.message}`);
        }
      }
    });

    client.on('error', (error) => {
      console.warn(`⚠️ DB notification client error: ${error.message}`);
      handleNotificationClientLoss(client, error);
    });

    client.on('end', () => {
      console.warn('⚠️ DB notification client ended.');
      handleNotificationClientLoss(client, 'end');
    });

    try {
      for (const channel of subscribedChannels) {
        await client.query(`LISTEN ${channel}`);
      }
    } catch (error) {
      if (notificationClient === client) notificationClient = null;
      releaseNotificationClient(client, error);
      throw error;
    }

    return client;
  })().finally(() => {
    notificationReconnectPromise = null;
  });

  return notificationReconnectPromise;
}

async function subscribeNotifications(channel, handler) {
  const normalizedChannel = assertNotificationChannel(channel);
  if (typeof handler !== 'function') throw new Error('Notification handler must be a function');

  let handlers = notificationHandlers.get(normalizedChannel);
  if (!handlers) {
    handlers = new Set();
    notificationHandlers.set(normalizedChannel, handlers);
  }
  handlers.add(handler);
  subscribedChannels.add(normalizedChannel);

  const client = await ensureNotificationClient();
  await client.query(`LISTEN ${normalizedChannel}`);

  return async () => {
    const currentHandlers = notificationHandlers.get(normalizedChannel);
    if (currentHandlers) {
      currentHandlers.delete(handler);
      if (currentHandlers.size === 0) notificationHandlers.delete(normalizedChannel);
    }

    if (!notificationHandlers.has(normalizedChannel)) {
      subscribedChannels.delete(normalizedChannel);
      if (notificationClient) {
        try {
          await notificationClient.query(`UNLISTEN ${normalizedChannel}`);
        } catch (_) {}
      }
    }
  };
}

async function publishNotification(channel, payload = {}) {
  const normalizedChannel = assertNotificationChannel(channel);
  if (!pool) throw new Error('Pool not initialized');
  await pool.query('SELECT pg_notify($1, $2)', [normalizedChannel, JSON.stringify(payload || {})]);
  return true;
}

async function shutdownDatabase() {
  trackerRegistry.shutdownTrackerRegistry();
  if (!pool) return;

  const currentPool = pool;
  pool = null;
  databaseOptimizationsPromise = null;
  notificationHandlers.clear();
  subscribedChannels.clear();
  clearNotificationReconnectTimer();
  notificationReconnectPromise = null;
  if (notificationClient) {
    releaseNotificationClient(notificationClient, new Error('shutdown'));
    notificationClient = null;
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

const sharedDependencies = {
  getPool: () => pool,
  withClient,
  runInTransaction,
  awaitDatabaseOptimizations,
  subscribeNotifications,
  publishNotification,
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
  subscribeNotifications,
  publishNotification,
  ...torrentRepository,
  ...sharedStreamCacheRepository,
  updateTrackers: trackerRegistry.updateTrackers,
  getActiveTrackers: trackerRegistry.getActiveTrackers,
  buildMagnet: trackerRegistry.buildMagnet,
  initTrackerRegistry: trackerRegistry.initTrackerRegistry,
  shutdownTrackerRegistry: trackerRegistry.shutdownTrackerRegistry
};
