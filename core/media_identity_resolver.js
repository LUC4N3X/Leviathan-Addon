const axios = require("axios");
const http = require("http");
const https = require("https");
const dbRepository = require("./storage/db_repository");

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
    cache: { memoryHit: 0, persistentHit: 0, negativeMemoryHit: 0, negativePersistentHit: 0, miss: 0, writes: 0, negativeWrites: 0 },
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

const IDENTITY_CACHE_TABLE = "media_identity_cache";
const NEGATIVE_CACHE_TABLE = "media_identity_negative_cache";
let persistentSchemaReady = false;
let persistentSchemaPromise = null;
let lastPruneAt = 0;
const identityMemoryCache = new Map();
const negativeMemoryCache = new Map();
const inflight = new Map();

const ensurePersistentStore = async () => {
    if (persistentSchemaReady) return true;
    if (persistentSchemaPromise) return persistentSchemaPromise;
    const pool = dbRepository.getPool ? dbRepository.getPool() : null;
    if (!pool) return false;

    persistentSchemaPromise = (async () => {
        try {
            await pool.query(`
              CREATE TABLE IF NOT EXISTS ${IDENTITY_CACHE_TABLE} (
                cache_key TEXT PRIMARY KEY,
                payload JSONB NOT NULL,
                expires_at TIMESTAMPTZ NOT NULL,
                updated_at TIMESTAMPTZ NOT NULL
              )
            `);
            await pool.query(`CREATE INDEX IF NOT EXISTS idx_${IDENTITY_CACHE_TABLE}_expires_at ON ${IDENTITY_CACHE_TABLE}(expires_at)`);
            await pool.query(`
              CREATE TABLE IF NOT EXISTS ${NEGATIVE_CACHE_TABLE} (
                cache_key TEXT PRIMARY KEY,
                payload JSONB NOT NULL,
                expires_at TIMESTAMPTZ NOT NULL,
                updated_at TIMESTAMPTZ NOT NULL
              )
            `);
            await pool.query(`CREATE INDEX IF NOT EXISTS idx_${NEGATIVE_CACHE_TABLE}_expires_at ON ${NEGATIVE_CACHE_TABLE}(expires_at)`);
            persistentSchemaReady = true;
            return true;
        } catch (error) {
            log("warn", "persistent_schema_failed", { message: error.message });
            return false;
        } finally {
            persistentSchemaPromise = null;
        }
    })();

    return persistentSchemaPromise;
};

const withPersistentStore = async (worker) => {
    const storeReady = await ensurePersistentStore();
    if (!storeReady || typeof dbRepository.withClient !== "function") return null;
    try {
        return await dbRepository.withClient(worker);
    } catch (error) {
        log("warn", "persistent_store_failed", { message: error.message });
        return null;
    }
};

const readPersistentEntry = async (tableName, cacheKey, metricKey, errorLabel) => {
    try {
        const row = await withPersistentStore(async (client) => {
            const res = await client.query(
                `SELECT payload FROM ${tableName} WHERE cache_key = $1 AND expires_at > NOW() LIMIT 1`,
                [cacheKey]
            );
            return res.rows?.[0] || null;
        });
        if (!row) return null;
        const payload = row.payload && typeof row.payload === "object" ? row.payload : safeJsonParse(row.payload);
        if (!payload) return null;
        stats.cache[metricKey] += 1;
        return payload;
    } catch (error) {
        log("warn", errorLabel, { cacheKey, message: error.message });
        return null;
    }
};

const writePersistentEntries = async (tableName, cacheKeys, payload, ttlMs, metricKey, errorLabel) => {
    const keys = Array.isArray(cacheKeys) ? cacheKeys.filter(Boolean) : [];
    if (keys.length === 0) return 0;
    const expiresAt = new Date(now() + ttlMs);
    const updatedAt = new Date();

    try {
        const written = await withPersistentStore(async (client) => {
            await client.query("BEGIN");
            try {
                for (const key of keys) {
                    await client.query(
                        `INSERT INTO ${tableName} (cache_key, payload, expires_at, updated_at)
                         VALUES ($1, $2::jsonb, $3, $4)
                         ON CONFLICT (cache_key)
                         DO UPDATE SET payload = EXCLUDED.payload, expires_at = EXCLUDED.expires_at, updated_at = EXCLUDED.updated_at`,
                        [key, JSON.stringify(payload), expiresAt, updatedAt]
                    );
                }
                await client.query("COMMIT");
                return keys.length;
            } catch (error) {
                await client.query("ROLLBACK");
                throw error;
            }
        });

        const applied = Number(written || 0);
        if (applied > 0) stats.cache[metricKey] += applied;
        return applied;
    } catch (error) {
        log("warn", errorLabel, { message: error.message });
        return 0;
    }
};

const prunePersistentStore = async () => {
    await withPersistentStore(async (client) => {
        await Promise.all([
            client.query(`DELETE FROM ${IDENTITY_CACHE_TABLE} WHERE expires_at <= NOW()`),
            client.query(`DELETE FROM ${NEGATIVE_CACHE_TABLE} WHERE expires_at <= NOW()`)
        ]);
    });
};

const maybePrune = async () => {
    const ts = now();
    if (ts - lastPruneAt < CONFIG.PRUNE_INTERVAL_MS) return;
    lastPruneAt = ts;
    try {
        await prunePersistentStore();
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

const readPersistentIdentity = async (cacheKey) => (
    readPersistentEntry(IDENTITY_CACHE_TABLE, cacheKey, "persistentHit", "persistent_identity_read_failed")
);

const readPersistentNegative = async (cacheKey) => (
    readPersistentEntry(NEGATIVE_CACHE_TABLE, cacheKey, "negativePersistentHit", "persistent_negative_read_failed")
);

const writePersistentIdentity = async (cacheKeys, payload, ttlMs) => (
    writePersistentEntries(IDENTITY_CACHE_TABLE, cacheKeys, payload, ttlMs, "writes", "persistent_identity_write_failed")
);

const writePersistentNegative = async (cacheKey, payload, ttlMs) => (
    writePersistentEntries(NEGATIVE_CACHE_TABLE, [cacheKey], payload, ttlMs, "negativeWrites", "persistent_negative_write_failed")
);

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

const getCachedIdentity = async (normalized) => {
    const memoryHit = lruGet(identityMemoryCache, normalized.cacheKey);
    if (memoryHit) {
        stats.cache.memoryHit += 1;
        return memoryHit;
    }
    const persistentHit = await readPersistentIdentity(normalized.cacheKey);
    if (persistentHit) {
        lruSet(identityMemoryCache, CONFIG.MEMORY_CACHE_MAX, normalized.cacheKey, persistentHit, Math.max(1000, persistentHit._ttlMs || CONFIG.CACHE_TTL_MS));
        stats.memory.lastIdentitySize = identityMemoryCache.size;
        return persistentHit;
    }
    return null;
};

const getCachedNegative = async (normalized) => {
    const memoryHit = lruGet(negativeMemoryCache, normalized.cacheKey);
    if (memoryHit) {
        stats.cache.negativeMemoryHit += 1;
        return memoryHit;
    }
    const persistentHit = await readPersistentNegative(normalized.cacheKey);
    if (persistentHit) {
        lruSet(negativeMemoryCache, CONFIG.MEMORY_NEGATIVE_MAX, normalized.cacheKey, persistentHit, Math.max(1000, persistentHit._ttlMs || CONFIG.NEGATIVE_CACHE_TTL_MS));
        stats.memory.lastNegativeSize = negativeMemoryCache.size;
        return persistentHit;
    }
    return null;
};

const persistIdentity = async (normalized, identity) => {
    const payload = { ...clone(identity), _ttlMs: CONFIG.CACHE_TTL_MS };
    const aliases = getCacheAliases(normalized, identity);
    await writePersistentIdentity(aliases, payload, CONFIG.CACHE_TTL_MS);
    for (const alias of aliases) lruSet(identityMemoryCache, CONFIG.MEMORY_CACHE_MAX, alias, payload, CONFIG.CACHE_TTL_MS);
    stats.memory.lastIdentitySize = identityMemoryCache.size;
};

const persistNegative = async (normalized, payload) => {
    const body = { ...clone(payload), _ttlMs: CONFIG.NEGATIVE_CACHE_TTL_MS };
    await writePersistentNegative(normalized.cacheKey, body, CONFIG.NEGATIVE_CACHE_TTL_MS);
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
    await maybePrune();
    const normalized = normalizeLookup(id, typeHint);

    const cachedIdentity = await getCachedIdentity(normalized);
    if (cachedIdentity) return cachedIdentity;

    const cachedNegative = await getCachedNegative(normalized);
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
            await persistIdentity(normalized, identity);
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
        await persistNegative(normalized, negative);
        return negative;
    })().finally(() => {
        inflight.delete(normalized.cacheKey);
    });

    inflight.set(normalized.cacheKey, job);
    return clone(await job);
}

async function getTmdbAltTitles(tmdbId, type, userKey = null) {
    stats.altTitleCalls += 1;
    await maybePrune();
    const cleanTmdb = asInt(tmdbId);
    const normalizedType = normalizeType(type) === "series" ? "series" : "movie";
    if (!cleanTmdb) return [];
    const cacheKey = `alts|${normalizedType}|${cleanTmdb}`;

    const mem = lruGet(identityMemoryCache, cacheKey);
    if (mem) {
        stats.cache.memoryHit += 1;
        return Array.isArray(mem.titles) ? mem.titles : [];
    }

    const row = await readPersistentIdentity(cacheKey);
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

    await writePersistentIdentity([cacheKey], payload, CONFIG.ALT_TITLES_TTL_MS);
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
        storage: {
            type: "postgres",
            poolReady: Boolean(dbRepository.getPool && dbRepository.getPool()),
            schemaReady: persistentSchemaReady
        }
    };
}

function resetResolverStats() {
    stats.resolveCalls = 0;
    stats.altTitleCalls = 0;
    stats.inflightHits = 0;
    stats.cache = { memoryHit: 0, persistentHit: 0, negativeMemoryHit: 0, negativePersistentHit: 0, miss: 0, writes: 0, negativeWrites: 0 };
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
