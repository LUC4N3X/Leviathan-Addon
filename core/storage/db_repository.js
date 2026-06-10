const { Pool } = require('pg');
const trackerRegistry = require('./tracker_registry');
const normalizers = require('./db/normalizers');
const { ensureDatabaseOptimizations } = require('./db/schema');
const { createTorrentRepository } = require('./db/torrent_repository');
const { createSharedStreamCacheRepository } = require('./db/shared_stream_cache_repository');
const { createCacheRepository } = require('./db/cache_repository');

let pool = null;
let databaseOptimizationsPromise = null;
let databaseShuttingDown = false;

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
  const ssl = sslEnabled ? { rejectUnauthorized: false } : false;

  const baseConfig = {
    ssl,
    statement_timeout: DB_STATEMENT_TIMEOUT_MS,
    query_timeout: DB_QUERY_TIMEOUT_MS,
    lock_timeout: DB_LOCK_TIMEOUT_MS,
    idle_in_transaction_session_timeout: DB_IDLE_TX_TIMEOUT_MS
  };

  if (process.env.DATABASE_URL) {
    return {
      ...baseConfig,
      connectionString: process.env.DATABASE_URL
    };
  }

  return {
    ...baseConfig,
    host: config.host || process.env.DB_HOST || 'localhost',
    port: normalizers.clampInt(config.port || process.env.DB_PORT, 5432, 1, 65535),
    database: config.database || process.env.DB_NAME || 'torrent_library',
    user: config.user || process.env.DB_USER || 'postgres',
    password: config.password || process.env.DB_PASSWORD
  };
}

function describePoolTarget(poolConfig) {
  if (poolConfig.connectionString) return 'DATABASE_URL';
  return `${poolConfig.host}:${poolConfig.port}/${poolConfig.database}`;
}

function scheduleDatabaseOptimizations() {
  if (!pool || databaseShuttingDown) return null;
  if (databaseOptimizationsPromise) return databaseOptimizationsPromise;

  databaseOptimizationsPromise = ensureDatabaseOptimizations(pool)
    .catch((error) => {
      databaseOptimizationsPromise = null;
      throw error;
    })
    .finally(() => {
      if (!pool || databaseShuttingDown) {
        databaseOptimizationsPromise = null;
      }
    });

  return databaseOptimizationsPromise;
}

function initDatabase(config = {}) {
  if (pool) return pool;

  databaseShuttingDown = false;

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

  console.log(`✅ DB Pool inizializzato (${describePoolTarget(poolConfig)})`);
  return pool;
}

async function awaitDatabaseOptimizations() {
  if (!pool || databaseShuttingDown) return false;

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

  if (!/^[a-z0-9_]+$/.test(normalized)) {
    throw new Error(`Invalid notification channel: ${channel}`);
  }

  return normalized;
}

function quoteNotificationChannel(channel) {
  return `"${String(channel).replace(/"/g, '""')}"`;
}

function parseNotificationPayload(message) {
  if (!message?.payload) return null;

  try {
    return JSON.parse(message.payload);
  } catch (_) {
    return { raw: message.payload };
  }
}

function stringifyNotificationPayload(payload) {
  const serialized = JSON.stringify(payload ?? {});
  return serialized === undefined ? '{}' : serialized;
}

function releaseNotificationClient(client, error = null) {
  if (!client || client.__leviReleased === true) return;

  client.__leviReleased = true;

  if (client.__leviListeningChannels) {
    client.__leviListeningChannels.clear();
  }

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
  if (databaseShuttingDown || !pool || subscribedChannels.size === 0) return;
  if (notificationClient || notificationReconnectPromise || notificationReconnectTimer) return;

  const reconnectReason = reason instanceof Error ? reason.message : String(reason || 'unknown');

  notificationReconnectTimer = setTimeout(() => {
    notificationReconnectTimer = null;

    ensureNotificationClient().catch((error) => {
      console.warn(`⚠️ DB notification reconnect failed (${reconnectReason}): ${error.message}`);
      scheduleNotificationReconnect('retry');
    });
  }, DB_NOTIFICATION_RECONNECT_DELAY_MS);

  if (typeof notificationReconnectTimer.unref === 'function') {
    notificationReconnectTimer.unref();
  }
}

function handleNotificationClientLoss(client, reason) {
  if (notificationClient === client) {
    notificationClient = null;
  }

  const error = reason instanceof Error
    ? reason
    : new Error(String(reason || 'notification_client_lost'));

  releaseNotificationClient(client, error);
  scheduleNotificationReconnect(error.message);
}

function attachNotificationClientListeners(client) {
  client.on('notification', (message) => {
    const channel = String(message?.channel || '').trim().toLowerCase();
    const handlers = notificationHandlers.get(channel);

    if (!handlers || handlers.size === 0) return;

    const payload = parseNotificationPayload(message);

    for (const handler of [...handlers]) {
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
}

async function listenNotificationChannel(client, channel) {
  if (!client || client.__leviReleased === true) {
    throw new Error('Notification client is not available');
  }

  if (!client.__leviListeningChannels) {
    client.__leviListeningChannels = new Set();
  }

  if (client.__leviListeningChannels.has(channel)) {
    return false;
  }

  await client.query(`LISTEN ${quoteNotificationChannel(channel)}`);
  client.__leviListeningChannels.add(channel);

  return true;
}

async function unlistenNotificationChannel(client, channel) {
  if (!client || client.__leviReleased === true) return false;

  if (!client.__leviListeningChannels) {
    client.__leviListeningChannels = new Set();
  }

  if (!client.__leviListeningChannels.has(channel)) {
    return false;
  }

  await client.query(`UNLISTEN ${quoteNotificationChannel(channel)}`);
  client.__leviListeningChannels.delete(channel);

  return true;
}

function removeNotificationHandler(channel, handler) {
  const handlers = notificationHandlers.get(channel);

  if (handlers) {
    handlers.delete(handler);

    if (handlers.size === 0) {
      notificationHandlers.delete(channel);
    }
  }

  if (!notificationHandlers.has(channel)) {
    subscribedChannels.delete(channel);
    return true;
  }

  return false;
}

async function ensureNotificationClient() {
  if (!pool || databaseShuttingDown) {
    throw new Error('Pool not initialized');
  }

  if (notificationClient && notificationClient.__leviReleased !== true) {
    return notificationClient;
  }

  if (notificationReconnectPromise) {
    return notificationReconnectPromise;
  }

  const pendingConnection = (async () => {
    clearNotificationReconnectTimer();

    const client = await pool.connect();

    client.__leviReleased = false;
    client.__leviListeningChannels = new Set();

    attachNotificationClientListeners(client);

    if (databaseShuttingDown || !pool) {
      releaseNotificationClient(client, new Error('shutdown'));
      throw new Error('Pool not initialized');
    }

    try {
      for (const channel of [...subscribedChannels]) {
        await listenNotificationChannel(client, channel);
      }
    } catch (error) {
      releaseNotificationClient(client, error);
      throw error;
    }

    notificationClient = client;
    return client;
  })();

  notificationReconnectPromise = pendingConnection;

  try {
    return await pendingConnection;
  } finally {
    if (notificationReconnectPromise === pendingConnection) {
      notificationReconnectPromise = null;
    }
  }
}

async function subscribeNotifications(channel, handler) {
  const normalizedChannel = assertNotificationChannel(channel);

  if (typeof handler !== 'function') {
    throw new Error('Notification handler must be a function');
  }

  let handlers = notificationHandlers.get(normalizedChannel);

  if (!handlers) {
    handlers = new Set();
    notificationHandlers.set(normalizedChannel, handlers);
  }

  handlers.add(handler);
  subscribedChannels.add(normalizedChannel);

  try {
    const client = await ensureNotificationClient();
    await listenNotificationChannel(client, normalizedChannel);
  } catch (error) {
    removeNotificationHandler(normalizedChannel, handler);
    throw error;
  }

  let unsubscribed = false;

  return async () => {
    if (unsubscribed) return;

    unsubscribed = true;

    const shouldUnlisten = removeNotificationHandler(normalizedChannel, handler);

    if (shouldUnlisten && notificationClient) {
      try {
        await unlistenNotificationChannel(notificationClient, normalizedChannel);
      } catch (_) {}
    }
  };
}

async function publishNotification(channel, payload = {}) {
  const normalizedChannel = assertNotificationChannel(channel);

  if (!pool || databaseShuttingDown) {
    throw new Error('Pool not initialized');
  }

  await pool.query('SELECT pg_notify($1, $2)', [
    normalizedChannel,
    stringifyNotificationPayload(payload)
  ]);

  return true;
}

async function shutdownDatabase() {
  trackerRegistry.shutdownTrackerRegistry();

  if (!pool) return;

  databaseShuttingDown = true;

  const currentPool = pool;
  pool = null;

  databaseOptimizationsPromise = null;
  notificationReconnectPromise = null;

  notificationHandlers.clear();
  subscribedChannels.clear();
  clearNotificationReconnectTimer();

  if (notificationClient) {
    releaseNotificationClient(notificationClient, new Error('shutdown'));
    notificationClient = null;
  }

  await currentPool.end();
}

async function withClient(fn) {
  if (!pool || databaseShuttingDown) {
    throw new Error('Pool not initialized');
  }

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
  if (!pool || databaseShuttingDown) {
    throw new Error('Pool not initialized');
  }

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
const cacheRepository = createCacheRepository(sharedDependencies);

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
  ...cacheRepository,
  updateTrackers: trackerRegistry.updateTrackers,
  getActiveTrackers: trackerRegistry.getActiveTrackers,
  buildMagnet: trackerRegistry.buildMagnet,
  initTrackerRegistry: trackerRegistry.initTrackerRegistry,
  shutdownTrackerRegistry: trackerRegistry.shutdownTrackerRegistry
};
