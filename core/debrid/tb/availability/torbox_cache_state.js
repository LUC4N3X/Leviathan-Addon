const crypto = require("crypto");

const TB_CACHE_STATES = Object.freeze({
  CACHED_VERIFIED: "cached_verified",
  LIKELY_CACHED: "likely_cached",
  UNCERTAIN: "uncertain",
  QUEUED: "queued",
  UNCACHED: "uncached",
  ERROR: "error"
});

const STATE_ALIASES = new Map([
  ["cached", TB_CACHE_STATES.CACHED_VERIFIED],
  ["cached_safe", TB_CACHE_STATES.CACHED_VERIFIED],
  ["verified", TB_CACHE_STATES.CACHED_VERIFIED],
  ["cached_verified", TB_CACHE_STATES.CACHED_VERIFIED],
  ["likely", TB_CACHE_STATES.LIKELY_CACHED],
  ["likely_cached", TB_CACHE_STATES.LIKELY_CACHED],
  ["probing", TB_CACHE_STATES.UNCERTAIN],
  ["unknown", TB_CACHE_STATES.UNCERTAIN],
  ["uncertain", TB_CACHE_STATES.UNCERTAIN],
  ["pending", TB_CACHE_STATES.QUEUED],
  ["queued", TB_CACHE_STATES.QUEUED],
  ["downloading", TB_CACHE_STATES.QUEUED],
  ["uncached", TB_CACHE_STATES.UNCACHED],
  ["likely_uncached", TB_CACHE_STATES.UNCACHED],
  ["uncached_terminal", TB_CACHE_STATES.UNCACHED],
  ["not_cached", TB_CACHE_STATES.UNCACHED],
  ["error", TB_CACHE_STATES.ERROR],
  ["timeout", TB_CACHE_STATES.ERROR],
  ["rate_limited", TB_CACHE_STATES.ERROR],
  ["auth_error", TB_CACHE_STATES.ERROR],
  ["server_error", TB_CACHE_STATES.ERROR]
]);

function normalizeTbCacheState(value, fallback = TB_CACHE_STATES.UNCERTAIN) {
  const raw = String(value || "").trim().toLowerCase();
  if (!raw) return fallback;
  return STATE_ALIASES.get(raw) || fallback;
}

function toRdCacheState(value) {
  const state = normalizeTbCacheState(value);
  switch (state) {
    case TB_CACHE_STATES.CACHED_VERIFIED:
      return "cached";
    case TB_CACHE_STATES.LIKELY_CACHED:
      return "likely_cached";
    case TB_CACHE_STATES.QUEUED:
    case TB_CACHE_STATES.UNCERTAIN:
      return "probing";
    case TB_CACHE_STATES.UNCACHED:
      return "likely_uncached";
    case TB_CACHE_STATES.ERROR:
    default:
      return "unknown";
  }
}

function isTbVerified(value) {
  return normalizeTbCacheState(value) === TB_CACHE_STATES.CACHED_VERIFIED;
}

function shouldPersistNegativeTbState(value) {
  return normalizeTbCacheState(value) === TB_CACHE_STATES.UNCACHED;
}

function shortTorboxHash(value) {
  const hash = String(value || "").trim().toLowerCase().replace(/[^a-f0-9]/g, "");
  if (!hash) return "nohash";
  return hash.length <= 12 ? hash : `${hash.slice(0, 6)}…${hash.slice(-4)}`;
}

function tokenFingerprint(value) {
  const token = String(value || "");
  if (!token) return "empty";
  return crypto.createHash("sha256").update(token).digest("hex").slice(0, 10);
}

function redactSecret(value) {
  const raw = String(value || "");
  if (!raw) return raw;
  if (raw.length <= 6) return "***";
  return `${raw.slice(0, 2)}…${raw.slice(-2)}#${tokenFingerprint(raw)}`;
}

function redactSecretsInText(value) {
  const text = String(value || "");
  return text
    .replace(/(token|apikey|api_key|key|authorization)=([^&\s]+)/gi, "$1=<redacted>")
    .replace(/Bearer\s+[A-Za-z0-9._~+/-]+/gi, "Bearer <redacted>");
}

module.exports = {
  TB_CACHE_STATES,
  normalizeTbCacheState,
  toRdCacheState,
  isTbVerified,
  shouldPersistNegativeTbState,
  shortTorboxHash,
  tokenFingerprint,
  redactSecret,
  redactSecretsInText
};
