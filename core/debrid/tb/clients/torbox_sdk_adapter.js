const DEFAULT_BASE_URL = 'https://api.torbox.app';
const DEFAULT_API_VERSION = 'v1';
const DEFAULT_TIMEOUT_MS = 20000;

let sdkState = {
  loaded: false,
  available: false,
  TorboxApi: null,
  loadError: null
};

function boolEnv(name, fallback) {
  const raw = process.env[name];
  if (raw == null || raw === '') return fallback;
  return !/^(0|false|no|off)$/i.test(String(raw).trim());
}

function intEnv(name, fallback, min, max) {
  const value = Number.parseInt(process.env[name] || '', 10);
  const safe = Number.isFinite(value) ? value : fallback;
  return Math.max(min, Math.min(max, safe));
}

function redact(value) {
  return String(value || '')
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer <redacted>')
    .replace(/([?&](?:token|api_key|apikey|key)=)[^&\s]+/gi, '$1<redacted>')
    .replace(/((?:token|api_key|apikey|authorization)\s*[:=]\s*)[A-Za-z0-9._~+/=-]+/gi, '$1<redacted>');
}

function sdkEnabled() {
  return boolEnv('TORBOX_SDK_ENABLED', true);
}

function fallbackEnabled() {
  return boolEnv('TORBOX_SDK_FALLBACK_AXIOS', true);
}

function preflightEnabled() {
  return boolEnv('TORBOX_PREFLIGHT_TORRENTINFO', true);
}

function baseUrl() {
  return String(process.env.TORBOX_SDK_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, '');
}

function timeoutMs() {
  return intEnv('TORBOX_SDK_TIMEOUT_MS', DEFAULT_TIMEOUT_MS, 3000, 120000);
}

function loadSdk() {
  if (sdkState.loaded) return sdkState;
  sdkState.loaded = true;
  if (!sdkEnabled()) {
    sdkState.available = false;
    sdkState.loadError = 'disabled';
    return sdkState;
  }
  try {
    const mod = require('@torbox/torbox-api');
    const TorboxApi = mod?.TorboxApi || mod?.default?.TorboxApi || mod?.default;
    if (typeof TorboxApi !== 'function') throw new Error('TorboxApi export not found');
    sdkState.TorboxApi = TorboxApi;
    sdkState.available = true;
    sdkState.loadError = null;
  } catch (error) {
    sdkState.available = false;
    sdkState.loadError = redact(error?.message || String(error));
  }
  return sdkState;
}

function isAvailable() {
  return loadSdk().available;
}

function createClient(key, override = {}) {
  const state = loadSdk();
  if (!state.available) return null;
  return new state.TorboxApi({
    token: String(key || ''),
    baseUrl: override.baseUrl || baseUrl(),
    timeoutMs: override.timeoutMs || timeoutMs(),
    retry: { attempts: 1, delayMs: 0 },
    validation: { responseValidation: false }
  });
}

function toStatus(response) {
  return Number(response?.metadata?.status || response?.status || 0) || 0;
}

function toHeaders(response) {
  return response?.metadata?.headers || response?.headers || {};
}

function addAlias(obj, from, to) {
  if (obj && Object.prototype.hasOwnProperty.call(obj, from) && !Object.prototype.hasOwnProperty.call(obj, to)) {
    obj[to] = obj[from];
  }
}

function normalizePayloadShape(value) {
  if (Array.isArray(value)) return value.map((item) => normalizePayloadShape(item));
  if (!value || typeof value !== 'object') return value;
  const out = { ...value };
  for (const [key, child] of Object.entries(out)) {
    out[key] = normalizePayloadShape(child);
  }
  addAlias(out, 'downloadState', 'download_state');
  addAlias(out, 'createdAt', 'created_at');
  addAlias(out, 'updatedAt', 'updated_at');
  addAlias(out, 'expiresAt', 'expires_at');
  addAlias(out, 'authId', 'auth_id');
  addAlias(out, 'torrentFile', 'torrent_file');
  addAlias(out, 'downloadSpeed', 'download_speed');
  addAlias(out, 'uploadSpeed', 'upload_speed');
  addAlias(out, 'downloadFinished', 'download_finished');
  addAlias(out, 'downloadPresent', 'download_present');
  addAlias(out, 'inactiveCheck', 'inactive_check');
  addAlias(out, 'shortName', 'short_name');
  addAlias(out, 's3Path', 's3_path');
  addAlias(out, 'torrentId', 'torrent_id');
  addAlias(out, 'queuedId', 'queued_id');
  addAlias(out, 'activeLimit', 'active_limit');
  addAlias(out, 'currentActiveDownloads', 'current_active_downloads');
  return out;
}

function toAxiosLike(response, op) {
  const status = toStatus(response) || 200;
  return {
    status,
    data: normalizePayloadShape(response?.data),
    headers: toHeaders(response),
    _sdk: true,
    _op: op || null
  };
}

function sdkError(error, op) {
  const status = Number(error?.metadata?.status || error?.response?.status || error?.status || 0) || null;
  const rawBody = error?.body || error?.raw || error?.metadata?.body || null;
  let parsed = null;
  if (rawBody) {
    try {
      const text = rawBody instanceof ArrayBuffer ? new TextDecoder().decode(rawBody) : String(rawBody);
      parsed = JSON.parse(text);
    } catch (_) {
      parsed = null;
    }
  }
  const message = redact(parsed?.detail || parsed?.error || parsed?.message || error?.message || 'torbox_sdk_error');
  const out = new Error(message);
  out.name = 'TorboxSdkAdapterError';
  out.status = status;
  out.response = {
    status: status || 500,
    data: parsed || { success: false, detail: message, error: message },
    headers: error?.metadata?.headers || {}
  };
  out.code = status ? `HTTP_${status}` : (error?.code || 'TORBOX_SDK_ERROR');
  out.op = op || null;
  return out;
}

function paramsToSdk(params = {}) {
  const out = {};
  for (const [key, value] of Object.entries(params || {})) {
    if (value == null) continue;
    if (key === 'bypass_cache') out.bypassCache = String(value);
    else if (key === 'list_files') out.listFiles = String(value);
    else if (key === 'torrent_id') out.torrentId = String(value);
    else if (key === 'file_id') out.fileId = String(value);
    else if (key === 'zip_link') out.zipLink = String(value);
    else if (key === 'user_ip') out.userIp = String(value);
    else out[key] = String(value);
  }
  return out;
}

function dataToSdk(data = {}) {
  const out = {};
  for (const [key, value] of Object.entries(data || {})) {
    if (value == null) continue;
    if (key === 'allow_zip') out.allowZip = String(value);
    else if (key === 'as_queued') out.asQueued = String(value);
    else if (key === 'torrent_id') out.torrent_id = value;
    else out[key] = value;
  }
  return out;
}

function mapOperation(method, endpoint, key, options = {}) {
  const verb = String(method || '').toUpperCase();
  const path = String(endpoint || '').replace(/\/+$/, '');
  const client = createClient(key, options);
  if (!client) return null;
  const apiVersion = options.apiVersion || DEFAULT_API_VERSION;

  if (verb === 'GET' && path === '/torrents/mylist') {
    const params = paramsToSdk(options.params || {});
    return () => client.torrents.getTorrentList(apiVersion, params, { validation: { responseValidation: false } });
  }

  if (verb === 'GET' && path === '/torrents/checkcached') {
    const params = paramsToSdk(options.params || {});
    return () => client.torrents.getTorrentCachedAvailability(apiVersion, params, { validation: { responseValidation: false } });
  }

  if (verb === 'POST' && path === '/torrents/createtorrent') {
    const body = dataToSdk(options.data || {});
    return () => client.torrents.createTorrent(apiVersion, body, { validation: { responseValidation: false } });
  }

  if (verb === 'GET' && path === '/torrents/requestdl') {
    const params = paramsToSdk(options.params || {});
    return () => client.torrents.requestDownloadLink(apiVersion, params, { validation: { responseValidation: false } });
  }

  if (verb === 'POST' && path === '/torrents/controltorrent') {
    const body = options.data || {};
    return () => client.torrents.controlTorrent(apiVersion, body, { validation: { responseValidation: false } });
  }

  if (verb === 'GET' && path === '/torrents/torrentinfo') {
    const params = paramsToSdk(options.params || {});
    return () => client.torrents.getTorrentInfo(apiVersion, params, { validation: { responseValidation: false } });
  }

  return null;
}

async function request(method, endpoint, key, options = {}) {
  if (!sdkEnabled()) return null;
  const operation = mapOperation(method, endpoint, key, options);
  if (!operation) return null;
  try {
    const response = await operation();
    return toAxiosLike(response, options.op || endpoint);
  } catch (error) {
    throw sdkError(error, options.op || endpoint);
  }
}

async function getUpStatus(options = {}) {
  if (!sdkEnabled()) return null;
  const client = createClient('', options);
  if (!client) return null;
  try {
    const response = await client.general.getUpStatus({ validation: { responseValidation: false } });
    return toAxiosLike(response, 'general.up');
  } catch (error) {
    throw sdkError(error, 'general.up');
  }
}

function extractHash(magnet) {
  const match = String(magnet || '').match(/btih:([a-zA-Z0-9]{32,40})/i);
  return match ? match[1].toLowerCase() : null;
}

function looksVideoFile(file) {
  const name = String(file?.name || file?.shortName || '').toLowerCase();
  const size = Number(file?.size || 0) || 0;
  return /\.(mkv|mp4|avi|mov|wmv|flv|webm|iso|m4v|ts)$/i.test(name) && size >= 8 * 1024 * 1024;
}

async function torrentInfo(key, input = {}, options = {}) {
  if (!sdkEnabled()) return null;
  const client = createClient(key || '', options);
  if (!client) return null;
  const apiVersion = options.apiVersion || DEFAULT_API_VERSION;
  const hash = input.hash || extractHash(input.magnet);
  const body = {};
  if (hash) body.hash = hash;
  if (input.magnet) body.magnet = String(input.magnet);
  if (!body.hash && !body.magnet) return null;
  try {
    const response = await client.torrents.getTorrentInfo1(apiVersion, body, { validation: { responseValidation: false } });
    return toAxiosLike(response, 'torrentinfo');
  } catch (error) {
    throw sdkError(error, 'torrentinfo');
  }
}

async function preflightTorrent(key, magnet, options = {}) {
  if (!preflightEnabled()) return { ok: true, skipped: true, reason: 'disabled' };
  const hash = extractHash(magnet);
  if (!hash && !magnet) return { ok: true, skipped: true, reason: 'missing_input' };
  try {
    const response = await torrentInfo(key, { hash, magnet }, options);
    const data = response?.data?.data || response?.data || null;
    const files = Array.isArray(data?.files) ? data.files : null;
    if (!data || files === null) return { ok: true, skipped: true, reason: 'no_preflight_files', response };
    const videoFiles = files.filter(looksVideoFile);
    if (files.length > 0 && videoFiles.length === 0) {
      return {
        ok: false,
        skipped: false,
        reason: 'no_video_files',
        hash: data.hash || hash || null,
        name: data.name || null,
        files: files.length
      };
    }
    return {
      ok: true,
      skipped: false,
      reason: 'video_files_found',
      hash: data.hash || hash || null,
      name: data.name || null,
      files: files.length,
      videoFiles: videoFiles.length,
      seeds: Number(data.seeds || 0) || 0,
      peers: Number(data.peers || 0) || 0
    };
  } catch (error) {
    if (fallbackEnabled()) return { ok: true, skipped: true, reason: 'preflight_error', error: redact(error?.message || String(error)) };
    throw error;
  }
}

function status() {
  const state = loadSdk();
  return {
    enabled: sdkEnabled(),
    available: state.available,
    fallbackAxios: fallbackEnabled(),
    preflightTorrentInfo: preflightEnabled(),
    baseUrl: baseUrl(),
    timeoutMs: timeoutMs(),
    loadError: state.loadError ? redact(state.loadError) : null
  };
}

function resetForTests() {
  sdkState = {
    loaded: false,
    available: false,
    TorboxApi: null,
    loadError: null
  };
}

module.exports = {
  request,
  getUpStatus,
  torrentInfo,
  preflightTorrent,
  status,
  isAvailable,
  sdkEnabled,
  fallbackEnabled,
  preflightEnabled,
  __private: {
    boolEnv,
    paramsToSdk,
    dataToSdk,
    toAxiosLike,
    normalizePayloadShape,
    sdkError,
    extractHash,
    looksVideoFile,
    redact,
    resetForTests
  }
};
