const axios = require("axios");
const Database = require("better-sqlite3");
const path = require("path");
const fs = require("fs-extra");
const http = require("http");
const https = require("https");

const CONFIG = {
    DEFAULT_TMDB_KEY: "4b9dfb8b1c9f1720b5cd1d7efea1d845",
    TMDB_URL: "https://api.themoviedb.org/3",
    TRAKT_CLIENT_ID: "ad521cf009e68d4304eeb82edf0e5c918055eef47bf38c8d568f6a9d8d6da4d1",
    TRAKT_URL: "https://api.trakt.tv",
    OMDB_KEY: "cbd03c31",
    OMDB_URL: "http://www.omdbapi.com",
    HTTP_TIMEOUT_MS: 4500,
    CACHE_TTL_MS: 1000 * 60 * 60 * 24 * 14,
    NEGATIVE_CACHE_TTL_MS: 1000 * 60 * 60 * 6,
    ALT_TITLES_TTL_MS: 1000 * 60 * 60 * 24 * 7,
    MEMORY_CACHE_MAX: 750,
    MEMORY_NEGATIVE_MAX: 300,
    PRUNE_INTERVAL_MS: 1000 * 60 * 10,
    DEBUG: process.env.IDENTITY_RESOLVER_DEBUG === "1"
};

const httpAgent = new http.Agent({ keepAlive: true, maxSockets: 32 });
const httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 32 });

const getTmdbKey = (userKey) => typeof userKey === "string" && userKey.trim().length > 5 ? userKey.trim() : CONFIG.DEFAULT_TMDB_KEY;
const now = () => Date.now();
const asInt = (value) => {
    if (value === null || value === undefined || value === "") return null;
    const n = Number.parseInt(String(value), 10);
    return Number.isFinite(n) ? n : null;
};
const normalizeType = (value) => {
    const raw = String(value || "").trim().toLowerCase();
    if (!raw) return null;
    if (["movie", "film"].includes(raw)) return "movie";
    if (["series", "show", "tv", "tvshow"].includes(raw)) return "series";
    if (["episode", "ep"].includes(raw)) return "episode";
    return null;
};
const isPositiveNumberString = (value) => /^\d+$/.test(String(value || "").trim());
const clone = (value) => value === undefined ? undefined : JSON.parse(JSON.stringify(value));

const stats = {
    startedAt: new Date().toISOString(),
    resolveCalls: 0,
    altTitleCalls: 0,
    inflightHits: 0,
    cache: { memoryHit: 0, sqliteHit: 0, negativeMemoryHit: 0, negativeSqliteHit: 0, miss: 0, writes: 0, negativeWrites: 0 },
    providers: {},
    prune: { runs: 0, lastRunAt: null },
    memory: { lastIdentitySize: 0, lastNegativeSize: 0 }
};

const providerMetric = (name) => {
    if (!stats.providers[name]) {
        stats.providers[name] = { calls: 0, success: 0, fail: 0, totalMs: 0, avgMs: 0 };
    }
    return stats.providers[name];
};

const recordProvider = (name, ok, ms) => {
    const metric = providerMetric(name);
    metric.calls += 1;
    if (ok) metric.success += 1;
    else metric.fail += 1;
    metric.totalMs += ms;
    metric.avgMs = metric.calls ? Math.round(metric.totalMs / metric.calls) : 0;
};

const log = (level, message, meta) => {
    if (level === "debug" && !CONFIG.DEBUG) return;
    const entry = meta ? `${message} ${JSON.stringify(meta)}` : message;
    if (level === "error") console.error(`[IdentityResolver] ${entry}`);
    else if (level === "warn") console.warn(`[IdentityResolver] ${entry}`);
    else console.log(`[IdentityResolver] ${entry}`);
};

const DATA_DIR = path.join(__dirname, "data");
fs.ensureDirSync(DATA_DIR);
const dbPath = path.join(DATA_DIR, "media_identity_cache.db");
const db = new Database(dbPath);
db.pragma("journal_mode = WAL");
db.pragma("synchronous = NORMAL");
db.exec(`
  CREATE TABLE IF NOT EXISTS identity_cache (
    cache_key TEXT PRIMARY KEY,
    payload TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_identity_expires_at ON identity_cache(expires_at);
  CREATE TABLE IF NOT EXISTS negative_cache (
    cache_key TEXT PRIMARY KEY,
    payload TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_negative_expires_at ON negative_cache(expires_at);
`);

const stmtGetIdentity = db.prepare("SELECT payload, expires_at FROM identity_cache WHERE cache_key = ?");
const stmtSetIdentity = db.prepare("INSERT OR REPLACE INTO identity_cache (cache_key, payload, expires_at, updated_at) VALUES (?, ?, ?, ?)");
const stmtGetNegative = db.prepare("SELECT payload, expires_at FROM negative_cache WHERE cache_key = ?");
const stmtSetNegative = db.prepare("INSERT OR REPLACE INTO negative_cache (cache_key, payload, expires_at, updated_at) VALUES (?, ?, ?, ?)");
const stmtPruneIdentity = db.prepare("DELETE FROM identity_cache WHERE expires_at <= ?");
const stmtPruneNegative = db.prepare("DELETE FROM negative_cache WHERE expires_at <= ?");

let lastPruneAt = 0;

const maybePrune = () => {
    const ts = now();
    if (ts - lastPruneAt < CONFIG.PRUNE_INTERVAL_MS) return;
    lastPruneAt = ts;
    try {
        stmtPruneIdentity.run(ts);
        stmtPruneNegative.run(ts);
        for (const [key, value] of identityMemoryCache.entries()) {
            if (!value || value.expiresAt <= ts) identityMemoryCache.delete(key);
        }
        for (const [key, value] of negativeMemoryCache.entries()) {
            if (!value || value.expiresAt <= ts) negativeMemoryCache.delete(key);
        }
        stats.prune.runs += 1;
        stats.prune.lastRunAt = new Date(ts).toISOString();
        stats.memory.lastIdentitySize = identityMemoryCache.size;
        stats.memory.lastNegativeSize = negativeMemoryCache.size;
    } catch (error) {
        log("warn", "prune_failed", { message: error.message });
    }
};

const identityMemoryCache = new Map();
const negativeMemoryCache = new Map();
const inflight = new Map();

const lruGet = (map, key) => {
    const entry = map.get(key);
    if (!entry) return null;
    if (entry.expiresAt <= now()) {
        map.delete(key);
        return null;
    }
    map.delete(key);
    map.set(key, entry);
    return clone(entry.value);
};

const lruSet = (map, maxSize, key, value, ttlMs) => {
    map.delete(key);
    map.set(key, { value: clone(value), expiresAt: now() + ttlMs });
    while (map.size > maxSize) {
        const firstKey = map.keys().next().value;
        map.delete(firstKey);
    }
};

const getCacheKey = (normalized) => [normalized.kind, normalized.baseId, normalized.typeHint || "", normalized.season ?? "", normalized.episode ?? ""].join("|");
const getBaseAliasKey = (kind, baseId, typeHint = null) => [kind, String(baseId), normalizeType(typeHint) || "", "", ""].join("|");

const safeJsonParse = (payload) => {
    try {
        return JSON.parse(payload);
    } catch {
        return null;
    }
};

const parseEpisodePieces = (pieces) => {
    let season = null;
    let episode = null;
    const rest = pieces.filter(Boolean).map((part) => String(part).trim()).filter(Boolean);
    if (!rest.length) return { season, episode };
    if (rest.length >= 2 && isPositiveNumberString(rest[0]) && isPositiveNumberString(rest[1])) {
        return { season: asInt(rest[0]), episode: asInt(rest[1]) };
    }
    for (const part of rest) {
        const sxe = /^s?(\d{1,3})e(\d{1,3})$/i.exec(part);
        if (sxe) return { season: asInt(sxe[1]), episode: asInt(sxe[2]) };
        const byX = /^(\d{1,3})x(\d{1,3})$/i.exec(part);
        if (byX) return { season: asInt(byX[1]), episode: asInt(byX[2]) };
    }
    return { season, episode };
};

const normalizeLookup = (input, typeHint = null) => {
    if (input === null || input === undefined) throw new Error("Missing id");
    if (typeof input === "number" && Number.isFinite(input)) {
        const baseId = String(Math.trunc(input));
        const normalized = { raw: String(input), kind: "tmdb", baseId, imdb: null, tmdb: asInt(baseId), tvdb: null, trakt: null, season: null, episode: null, typeHint: normalizeType(typeHint) };
        normalized.cacheKey = getCacheKey(normalized);
        return normalized;
    }
    const raw = String(input).trim();
    if (!raw) throw new Error("Empty id");
    const segments = raw.split(":").map((segment) => segment.trim()).filter(Boolean);
    let kind = null;
    let baseCandidate = null;
    let episodePieces = [];
    const prefix = segments[0] ? segments[0].toLowerCase() : "";
    if (["imdb", "tmdb", "tvdb", "trakt"].includes(prefix)) {
        kind = prefix;
        baseCandidate = segments[1] || "";
        episodePieces = segments.slice(2);
    } else {
        baseCandidate = segments[0];
        episodePieces = segments.slice(1);
    }
    if (!kind) {
        if (/^tt\d+$/i.test(baseCandidate)) kind = "imdb";
        else if (/^\d+$/.test(baseCandidate)) kind = "tmdb";
    }
    if (!kind) throw new Error(`Unsupported id format: ${raw}`);
    const cleanBase = kind === "imdb" ? baseCandidate.toLowerCase() : String(asInt(baseCandidate) || "");
    if (!cleanBase) throw new Error(`Invalid id value: ${raw}`);
    const episodeMeta = parseEpisodePieces(episodePieces);
    const normalized = {
        raw,
        kind,
        baseId: cleanBase,
        imdb: kind === "imdb" ? cleanBase : null,
        tmdb: kind === "tmdb" ? asInt(cleanBase) : null,
        tvdb: kind === "tvdb" ? asInt(cleanBase) : null,
        trakt: kind === "trakt" ? asInt(cleanBase) : null,
        season: episodeMeta.season,
        episode: episodeMeta.episode,
        typeHint: normalizeType(typeHint) || (episodeMeta.season && episodeMeta.episode ? "episode" : null)
    };
    normalized.cacheKey = getCacheKey(normalized);
    return normalized;
};

const readSqliteIdentity = (cacheKey) => {
    try {
        const row = stmtGetIdentity.get(cacheKey);
        if (!row) return null;
        if (row.expires_at <= now()) return null;
        const payload = safeJsonParse(row.payload);
        if (!payload) return null;
        stats.cache.sqliteHit += 1;
        return payload;
    } catch (error) {
        log("warn", "sqlite_identity_read_failed", { cacheKey, message: error.message });
        return null;
    }
};

const readSqliteNegative = (cacheKey) => {
    try {
        const row = stmtGetNegative.get(cacheKey);
        if (!row) return null;
        if (row.expires_at <= now()) return null;
        const payload = safeJsonParse(row.payload);
        if (!payload) return null;
        stats.cache.negativeSqliteHit += 1;
        return payload;
    } catch (error) {
        log("warn", "sqlite_negative_read_failed", { cacheKey, message: error.message });
        return null;
    }
};

const writeSqliteIdentity = (cacheKeys, payload, ttlMs) => {
    const ts = now();
    const expiresAt = ts + ttlMs;
    const body = JSON.stringify(payload);
    try {
        const tx = db.transaction((keys) => {
            for (const key of keys) stmtSetIdentity.run(key, body, expiresAt, ts);
        });
        tx(cacheKeys);
        stats.cache.writes += cacheKeys.length;
    } catch (error) {
        log("warn", "sqlite_identity_write_failed", { message: error.message });
    }
};

const writeSqliteNegative = (cacheKey, payload, ttlMs) => {
    const ts = now();
    const expiresAt = ts + ttlMs;
    try {
        stmtSetNegative.run(cacheKey, JSON.stringify(payload), expiresAt, ts);
        stats.cache.negativeWrites += 1;
    } catch (error) {
        log("warn", "sqlite_negative_write_failed", { message: error.message });
    }
};

const getCacheAliases = (normalized, identity) => {
    const aliases = new Set([normalized.cacheKey]);
    if (identity.imdb) {
        aliases.add(getBaseAliasKey("imdb", identity.imdb, identity.type));
        if (identity.season && identity.episode) aliases.add(["imdb", identity.imdb, identity.type || "episode", identity.season, identity.episode].join("|"));
    }
    if (identity.tmdb) {
        aliases.add(getBaseAliasKey("tmdb", identity.tmdb, identity.type === "episode" ? "series" : identity.type));
        if (identity.season && identity.episode) aliases.add(["tmdb", identity.tmdb, identity.type || "episode", identity.season, identity.episode].join("|"));
    }
    if (identity.tvdb) aliases.add(getBaseAliasKey("tvdb", identity.tvdb, identity.type));
    if (identity.trakt) aliases.add(getBaseAliasKey("trakt", identity.trakt, identity.type));
    return [...aliases];
};

const buildBaseIdentity = (normalized) => ({
    imdb: normalized.imdb,
    tmdb: normalized.tmdb,
    tvdb: normalized.tvdb,
    trakt: normalized.trakt,
    slug: null,
    type: normalized.typeHint,
    season: normalized.season,
    episode: normalized.episode,
    showImdb: normalized.kind === "imdb" && normalized.typeHint === "episode" ? normalized.imdb : null,
    showTmdb: normalized.kind === "tmdb" && normalized.typeHint === "episode" ? normalized.tmdb : null,
    showTvdb: normalized.kind === "tvdb" && normalized.typeHint === "episode" ? normalized.tvdb : null,
    showTrakt: normalized.kind === "trakt" && normalized.typeHint === "episode" ? normalized.trakt : null,
    episodeTmdb: null,
    title: null,
    originalTitle: null,
    year: null,
    foundVia: "input",
    sources: [],
    confidence: 0,
    notFound: false
});

const fieldPriorities = {
    imdb: { input: 120, tmdb_ext: 115, tmdb_find: 110, trakt: 95, omdb: 80 },
    tmdb: { input: 120, tmdb_find: 115, trakt: 95 },
    tvdb: { input: 120, tmdb_ext: 115, trakt: 95 },
    trakt: { input: 120, trakt: 115 },
    slug: { trakt: 115 },
    type: { input: 125, tmdb_find: 115, tmdb_ext: 110, trakt: 95, omdb: 85 },
    season: { input: 125, tmdb_find: 115, tmdb_ext: 110 },
    episode: { input: 125, tmdb_find: 115, tmdb_ext: 110 },
    showImdb: { tmdb_ext: 115, trakt: 95 },
    showTmdb: { tmdb_find: 115, tmdb_ext: 110, trakt: 95 },
    showTvdb: { tmdb_ext: 115, trakt: 95 },
    showTrakt: { trakt: 115 },
    episodeTmdb: { tmdb_find: 115, tmdb_ext: 110 },
    title: { tmdb_find: 105, omdb: 90 },
    originalTitle: { tmdb_find: 105 },
    year: { tmdb_find: 100, omdb: 90 }
};

const meaningful = (value) => !(value === null || value === undefined || value === "");

const createScoreState = () => new Map();

const setField = (identity, scoreState, field, value, source) => {
    if (!meaningful(value)) return;
    const priority = (fieldPriorities[field] && fieldPriorities[field][source]) || 0;
    const current = scoreState.get(field);
    if (!current || priority >= current.priority) {
        identity[field] = value;
        scoreState.set(field, { priority, source });
    }
};

const mergeFragment = (identity, scoreState, fragment) => {
    if (!fragment || typeof fragment !== "object") return;
    const source = fragment.source || "unknown";
    const fields = [
        "imdb", "tmdb", "tvdb", "trakt", "slug", "type", "season", "episode",
        "showImdb", "showTmdb", "showTvdb", "showTrakt", "episodeTmdb",
        "title", "originalTitle", "year"
    ];
    for (const field of fields) setField(identity, scoreState, field, fragment[field], source);
    if (!identity.sources.includes(source)) identity.sources.push(source);
};

const finalizeIdentity = (identity, scoreState) => {
    if (identity.type === "episode") {
        if (!identity.showTmdb && identity.tmdb && identity.episodeTmdb && identity.tmdb !== identity.episodeTmdb) identity.showTmdb = identity.tmdb;
        if (!identity.showImdb && identity.imdb && identity.season && identity.episode) identity.showImdb = null;
    }
    const weightedFields = ["imdb", "tmdb", "tvdb", "trakt", "type", "season", "episode", "showTmdb", "episodeTmdb"];
    let confidence = 0;
    for (const field of weightedFields) {
        if (meaningful(identity[field])) confidence += field === "type" ? 8 : 12;
    }
    confidence += Math.min(identity.sources.length * 8, 24);
    identity.confidence = Math.min(confidence, 100);
    const best = [...scoreState.values()].sort((a, b) => b.priority - a.priority)[0];
    identity.foundVia = best ? best.source : identity.foundVia;
    return identity;
};

const timedProvider = async (name, fn) => {
    const start = now();
    try {
        const result = await fn();
        recordProvider(name, !!result, now() - start);
        return result;
    } catch (error) {
        recordProvider(name, false, now() - start);
        log("debug", `${name}_failed`, { message: error.message });
        return null;
    }
};

const tmdbClient = axios.create({
    baseURL: CONFIG.TMDB_URL,
    timeout: CONFIG.HTTP_TIMEOUT_MS,
    httpAgent,
    httpsAgent
});

const traktClient = axios.create({
    baseURL: CONFIG.TRAKT_URL,
    timeout: CONFIG.HTTP_TIMEOUT_MS,
    httpAgent,
    httpsAgent,
    headers: {
        "Content-Type": "application/json",
        "trakt-api-version": "2",
        "trakt-api-key": CONFIG.TRAKT_CLIENT_ID
    }
});

const omdbClient = axios.create({
    baseURL: CONFIG.OMDB_URL,
    timeout: CONFIG.HTTP_TIMEOUT_MS,
    httpAgent,
    httpsAgent
});

const mapTmdbFindResult = (item, source) => {
    if (!item) return null;
    if (source === "movie_results") {
        return {
            source: "tmdb_find",
            tmdb: asInt(item.id),
            type: "movie",
            title: item.title || null,
            originalTitle: item.original_title || null,
            year: item.release_date ? String(item.release_date).slice(0, 4) : null
        };
    }
    if (source === "tv_results") {
        return {
            source: "tmdb_find",
            tmdb: asInt(item.id),
            type: "series",
            title: item.name || null,
            originalTitle: item.original_name || null,
            year: item.first_air_date ? String(item.first_air_date).slice(0, 4) : null
        };
    }
    if (source === "tv_episode_results") {
        const showTmdb = asInt(item.show_id) || null;
        return {
            source: "tmdb_find",
            tmdb: showTmdb || asInt(item.id),
            showTmdb,
            episodeTmdb: asInt(item.id),
            type: "episode",
            season: asInt(item.season_number),
            episode: asInt(item.episode_number),
            title: item.name || null,
            originalTitle: item.name || null,
            year: item.air_date ? String(item.air_date).slice(0, 4) : null
        };
    }
    return null;
};

const searchTmdbByExternal = async (id, source, userKey = null) => {
    const apiKey = getTmdbKey(userKey);
    const { data } = await tmdbClient.get(`/find/${encodeURIComponent(id)}`, { params: { api_key: apiKey, external_source: source } });
    const candidate =
        mapTmdbFindResult(data.movie_results && data.movie_results[0], "movie_results") ||
        mapTmdbFindResult(data.tv_results && data.tv_results[0], "tv_results") ||
        mapTmdbFindResult(data.tv_episode_results && data.tv_episode_results[0], "tv_episode_results");
    if (!candidate) return null;
    if (source === "imdb_id") candidate.imdb = String(id).toLowerCase();
    if (source === "tvdb_id") candidate.tvdb = asInt(id);
    return candidate;
};

const fetchTmdbExternalIds = async (tmdbId, type, userKey = null) => {
    const apiKey = getTmdbKey(userKey);
    const endpoint = type === "series" ? "tv" : "movie";
    const { data } = await tmdbClient.get(`/${endpoint}/${tmdbId}/external_ids`, { params: { api_key: apiKey } });
    return {
        source: "tmdb_ext",
        imdb: data.imdb_id || null,
        tvdb: asInt(data.tvdb_id),
        type
    };
};

const fetchTmdbEpisodeExternalIds = async (showTmdbId, season, episode, userKey = null) => {
    const apiKey = getTmdbKey(userKey);
    const [showRes, episodeRes] = await Promise.allSettled([
        tmdbClient.get(`/tv/${showTmdbId}/external_ids`, { params: { api_key: apiKey } }),
        tmdbClient.get(`/tv/${showTmdbId}/season/${season}/episode/${episode}/external_ids`, { params: { api_key: apiKey } })
    ]);
    const showData = showRes.status === "fulfilled" ? showRes.value.data : null;
    const episodeData = episodeRes.status === "fulfilled" ? episodeRes.value.data : null;
    if (!showData && !episodeData) return null;
    return {
        source: "tmdb_ext",
        type: "episode",
        tmdb: asInt(showTmdbId),
        showTmdb: asInt(showTmdbId),
        season: asInt(season),
        episode: asInt(episode),
        showImdb: showData ? showData.imdb_id || null : null,
        showTvdb: showData ? asInt(showData.tvdb_id) : null,
        imdb: episodeData ? episodeData.imdb_id || null : null,
        tvdb: episodeData ? asInt(episodeData.tvdb_id) : null
    };
};

const getTmdbExternalIdsSmart = async (tmdbId, typeHint = null, userKey = null, season = null, episode = null) => {
    const normalizedType = normalizeType(typeHint);
    if (season && episode) {
        return fetchTmdbEpisodeExternalIds(tmdbId, season, episode, userKey);
    }
    if (normalizedType === "movie" || normalizedType === "series") {
        return fetchTmdbExternalIds(tmdbId, normalizedType, userKey);
    }
    const [movieRes, tvRes] = await Promise.allSettled([
        fetchTmdbExternalIds(tmdbId, "movie", userKey),
        fetchTmdbExternalIds(tmdbId, "series", userKey)
    ]);
    const movieOk = movieRes.status === "fulfilled" ? movieRes.value : null;
    const tvOk = tvRes.status === "fulfilled" ? tvRes.value : null;
    if (movieOk && movieOk.imdb) return movieOk;
    if (tvOk && tvOk.imdb) return tvOk;
    return movieOk || tvOk || null;
};

const searchTrakt = async (id, lookupType = "imdb") => {
    if (!CONFIG.TRAKT_CLIENT_ID) return null;
    const { data } = await traktClient.get(`/search/${lookupType}/${encodeURIComponent(id)}`, { params: { type: "movie,show" } });
    if (!Array.isArray(data) || !data.length) return null;
    const entry = data[0];
    const meta = entry.movie || entry.show;
    if (!meta || !meta.ids) return null;
    return {
        source: "trakt",
        imdb: meta.ids.imdb || null,
        tmdb: asInt(meta.ids.tmdb),
        tvdb: asInt(meta.ids.tvdb),
        trakt: asInt(meta.ids.trakt),
        slug: meta.ids.slug || null,
        type: entry.type === "show" ? "series" : "movie",
        title: meta.title || null,
        year: meta.year ? String(meta.year) : null
    };
};

const searchOmdb = async (imdbId) => {
    if (!CONFIG.OMDB_KEY) return null;
    const { data } = await omdbClient.get("/", { params: { i: imdbId, apikey: CONFIG.OMDB_KEY } });
    if (!data || data.Response !== "True") return null;
    return {
        source: "omdb",
        imdb: data.imdbID || null,
        type: normalizeType(data.Type),
        title: data.Title || null,
        year: data.Year ? String(data.Year).slice(0, 4) : null
    };
};

const getCachedIdentity = (normalized) => {
    const memoryHit = lruGet(identityMemoryCache, normalized.cacheKey);
    if (memoryHit) {
        stats.cache.memoryHit += 1;
        return memoryHit;
    }
    const sqliteHit = readSqliteIdentity(normalized.cacheKey);
    if (sqliteHit) {
        lruSet(identityMemoryCache, CONFIG.MEMORY_CACHE_MAX, normalized.cacheKey, sqliteHit, Math.max(1000, sqliteHit._ttlMs || CONFIG.CACHE_TTL_MS));
        stats.memory.lastIdentitySize = identityMemoryCache.size;
        return sqliteHit;
    }
    return null;
};

const getCachedNegative = (normalized) => {
    const memoryHit = lruGet(negativeMemoryCache, normalized.cacheKey);
    if (memoryHit) {
        stats.cache.negativeMemoryHit += 1;
        return memoryHit;
    }
    const sqliteHit = readSqliteNegative(normalized.cacheKey);
    if (sqliteHit) {
        lruSet(negativeMemoryCache, CONFIG.MEMORY_NEGATIVE_MAX, normalized.cacheKey, sqliteHit, Math.max(1000, sqliteHit._ttlMs || CONFIG.NEGATIVE_CACHE_TTL_MS));
        stats.memory.lastNegativeSize = negativeMemoryCache.size;
        return sqliteHit;
    }
    return null;
};

const persistIdentity = (normalized, identity) => {
    const payload = { ...clone(identity), _ttlMs: CONFIG.CACHE_TTL_MS };
    const aliases = getCacheAliases(normalized, identity);
    writeSqliteIdentity(aliases, payload, CONFIG.CACHE_TTL_MS);
    for (const alias of aliases) lruSet(identityMemoryCache, CONFIG.MEMORY_CACHE_MAX, alias, payload, CONFIG.CACHE_TTL_MS);
    stats.memory.lastIdentitySize = identityMemoryCache.size;
};

const persistNegative = (normalized, payload) => {
    const body = { ...clone(payload), _ttlMs: CONFIG.NEGATIVE_CACHE_TTL_MS };
    writeSqliteNegative(normalized.cacheKey, body, CONFIG.NEGATIVE_CACHE_TTL_MS);
    lruSet(negativeMemoryCache, CONFIG.MEMORY_NEGATIVE_MAX, normalized.cacheKey, body, CONFIG.NEGATIVE_CACHE_TTL_MS);
    stats.memory.lastNegativeSize = negativeMemoryCache.size;
};

const hasUsefulIdentity = (identity) => Boolean(identity && (identity.imdb || identity.tmdb || identity.tvdb || identity.trakt));

const resolveFresh = async (normalized, userKey = null) => {
    const identity = buildBaseIdentity(normalized);
    const scoreState = createScoreState();
    mergeFragment(identity, scoreState, { source: "input", ...identity });

    const primaryLookups = [];
    if (normalized.kind === "imdb") {
        primaryLookups.push(timedProvider("tmdb_find", () => searchTmdbByExternal(normalized.baseId, "imdb_id", userKey)));
        primaryLookups.push(timedProvider("trakt", () => searchTrakt(normalized.baseId, "imdb")));
        primaryLookups.push(timedProvider("omdb", () => searchOmdb(normalized.baseId)));
    } else if (normalized.kind === "tmdb") {
        primaryLookups.push(timedProvider("tmdb_ext", () => getTmdbExternalIdsSmart(normalized.tmdb, normalized.typeHint, userKey, normalized.season, normalized.episode)));
        primaryLookups.push(timedProvider("trakt", () => searchTrakt(normalized.baseId, "tmdb")));
    } else if (normalized.kind === "tvdb") {
        primaryLookups.push(timedProvider("tmdb_find", () => searchTmdbByExternal(normalized.baseId, "tvdb_id", userKey)));
        primaryLookups.push(timedProvider("trakt", () => searchTrakt(normalized.baseId, "tvdb")));
    } else if (normalized.kind === "trakt") {
        primaryLookups.push(timedProvider("trakt", () => searchTrakt(normalized.baseId, "trakt")));
    }

    const settled = await Promise.allSettled(primaryLookups);
    for (const item of settled) {
        if (item.status === "fulfilled" && item.value) mergeFragment(identity, scoreState, item.value);
    }

    const needsTmdbEnrichment = Boolean(identity.tmdb) && (!identity.imdb || !identity.tvdb || !identity.type || (identity.type === "episode" && (!identity.showImdb || !identity.showTvdb)));
    if (needsTmdbEnrichment) {
        const tmdbExt = await timedProvider("tmdb_ext_enrich", () => getTmdbExternalIdsSmart(identity.tmdb, identity.type || normalized.typeHint, userKey, identity.season, identity.episode));
        if (tmdbExt) mergeFragment(identity, scoreState, tmdbExt);
    }

    const shouldRetryTrakt = !identity.trakt && ((identity.imdb && normalized.kind !== "imdb") || (identity.tmdb && normalized.kind !== "tmdb"));
    if (shouldRetryTrakt) {
        const lookupType = identity.imdb ? "imdb" : "tmdb";
        const lookupId = identity.imdb || String(identity.tmdb);
        const retryTrakt = await timedProvider("trakt_enrich", () => searchTrakt(lookupId, lookupType));
        if (retryTrakt) mergeFragment(identity, scoreState, retryTrakt);
    }

    finalizeIdentity(identity, scoreState);
    return identity;
};

async function resolveIds(id, typeHint = null, userKey = null) {
    stats.resolveCalls += 1;
    maybePrune();
    const normalized = normalizeLookup(id, typeHint);

    const cachedIdentity = getCachedIdentity(normalized);
    if (cachedIdentity) return cachedIdentity;

    const cachedNegative = getCachedNegative(normalized);
    if (cachedNegative) return cachedNegative;

    stats.cache.miss += 1;

    const existing = inflight.get(normalized.cacheKey);
    if (existing) {
        stats.inflightHits += 1;
        return clone(await existing);
    }

    const job = (async () => {
        const identity = await resolveFresh(normalized, userKey);
        if (hasUsefulIdentity(identity)) {
            persistIdentity(normalized, identity);
            return identity;
        }
        const negative = {
            ...buildBaseIdentity(normalized),
            type: identity.type || normalized.typeHint,
            foundVia: "negative_cache",
            sources: identity.sources || [],
            confidence: 0,
            notFound: true
        };
        persistNegative(normalized, negative);
        return negative;
    })().finally(() => {
        inflight.delete(normalized.cacheKey);
    });

    inflight.set(normalized.cacheKey, job);
    return clone(await job);
}

async function getTmdbAltTitles(tmdbId, type, userKey = null) {
    stats.altTitleCalls += 1;
    maybePrune();
    const cleanTmdb = asInt(tmdbId);
    const normalizedType = normalizeType(type) === "series" ? "series" : "movie";
    if (!cleanTmdb) return [];
    const cacheKey = `alts|${normalizedType}|${cleanTmdb}`;

    const mem = lruGet(identityMemoryCache, cacheKey);
    if (mem) {
        stats.cache.memoryHit += 1;
        return Array.isArray(mem.titles) ? mem.titles : [];
    }

    const row = readSqliteIdentity(cacheKey);
    if (row && Array.isArray(row.titles)) {
        lruSet(identityMemoryCache, CONFIG.MEMORY_CACHE_MAX, cacheKey, row, Math.max(1000, row._ttlMs || CONFIG.ALT_TITLES_TTL_MS));
        stats.memory.lastIdentitySize = identityMemoryCache.size;
        return row.titles;
    }

    const apiKey = getTmdbKey(userKey);
    const endpoint = normalizedType === "series" ? "tv" : "movie";
    const payload = await timedProvider("tmdb_alt_titles", async () => {
        const { data } = await tmdbClient.get(`/${endpoint}/${cleanTmdb}`, {
            params: { api_key: apiKey, append_to_response: "alternative_titles,translations" }
        });
        const set = new Set();
        const translations = data.translations && Array.isArray(data.translations.translations) ? data.translations.translations : [];
        for (const translation of translations) {
            if (!["IT", "US", "GB"].includes(translation.iso_3166_1)) continue;
            if (translation.data && translation.data.title) set.add(String(translation.data.title).trim());
            if (translation.data && translation.data.name) set.add(String(translation.data.name).trim());
        }
        const alternatives = Array.isArray(data.alternative_titles && data.alternative_titles.titles)
            ? data.alternative_titles.titles
            : Array.isArray(data.alternative_titles && data.alternative_titles.results)
                ? data.alternative_titles.results
                : [];
        for (const entry of alternatives) {
            if (!["IT", "US", "GB"].includes(entry.iso_3166_1)) continue;
            if (entry.title) set.add(String(entry.title).trim());
        }
        if (data.title) set.add(String(data.title).trim());
        if (data.name) set.add(String(data.name).trim());
        if (data.original_title) set.add(String(data.original_title).trim());
        if (data.original_name) set.add(String(data.original_name).trim());
        const titles = [...set].filter(Boolean);
        return { titles, _ttlMs: CONFIG.ALT_TITLES_TTL_MS };
    });

    if (!payload || !Array.isArray(payload.titles)) return [];

    writeSqliteIdentity([cacheKey], payload, CONFIG.ALT_TITLES_TTL_MS);
    lruSet(identityMemoryCache, CONFIG.MEMORY_CACHE_MAX, cacheKey, payload, CONFIG.ALT_TITLES_TTL_MS);
    stats.memory.lastIdentitySize = identityMemoryCache.size;
    return payload.titles;
}

async function tmdbToImdb(tmdbId, type, userKey = null) {
    const ids = await resolveIds(tmdbId, type, userKey);
    if (ids.type === "episode") return ids.imdb || ids.showImdb || null;
    return ids.imdb || null;
}

async function imdbToTmdb(imdbId, userKey = null) {
    const ids = await resolveIds(imdbId, null, userKey);
    return {
        tmdbId: ids.tmdb || ids.showTmdb || ids.episodeTmdb || null,
        type: ids.type || null,
        season: ids.season || null,
        episode: ids.episode || null
    };
}

async function getAllIds(id, userKey = null) {
    return resolveIds(id, null, userKey);
}

function getResolverStats() {
    return {
        ...clone(stats),
        inflightSize: inflight.size,
        memoryIdentityEntries: identityMemoryCache.size,
        memoryNegativeEntries: negativeMemoryCache.size,
        dbPath
    };
}

function resetResolverStats() {
    stats.resolveCalls = 0;
    stats.altTitleCalls = 0;
    stats.inflightHits = 0;
    stats.cache = { memoryHit: 0, sqliteHit: 0, negativeMemoryHit: 0, negativeSqliteHit: 0, miss: 0, writes: 0, negativeWrites: 0 };
    stats.providers = {};
    stats.prune = { runs: 0, lastRunAt: null };
    stats.memory = { lastIdentitySize: identityMemoryCache.size, lastNegativeSize: negativeMemoryCache.size };
}

module.exports = {
    resolveIds,
    tmdbToImdb,
    imdbToTmdb,
    getAllIds,
    getTmdbAltTitles,
    getResolverStats,
    resetResolverStats
};
