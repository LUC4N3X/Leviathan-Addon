const Redis = require("ioredis");

// LOG DI DEBUG ALL'AVVIO
console.log(`\n🔌 [REDIS INIT] Tentativo connessione a: ${process.env.REDIS_HOST}`);
console.log(`🔑 [REDIS INIT] Password configurata: ${process.env.REDIS_PASS ? 'SÌ (Lunghezza: ' + process.env.REDIS_PASS.length + ')' : 'NO'}`);

// --- CONNESSIONE AL CLUSTER REMOTO (VPS A) ---
const redis = new Redis({
    host: process.env.REDIS_HOST,      // IP VPS A
    port: process.env.REDIS_PORT || 6379,
    password: process.env.REDIS_PASS,  
    family: 4,                         // Forza IPv4
    maxRetriesPerRequest: null,
    retryStrategy: function(times) {
        return Math.min(times * 50, 2000);
    }
});

redis.on("error", (err) => {
    if (err.message.includes("WRONGPASS")) {
        console.error("❌ [REDIS ERROR] Password Rifiutata! Controlla .env su VPS A e docker-compose su VPS B.");
    } else if (err.message.includes("ECONNREFUSED")) {
        console.error("❌ [REDIS ERROR] Connessione Rifiutata! Controlla IP e Firewall su VPS A.");
    } else {
        console.error("⚠️ [REDIS ERROR]", err.message);
    }
});

redis.on("connect", () => {
    console.log("✅ [REDIS] Connesso con successo al Database Remoto!");
});

// TEMPI DI MEMORIA (TTL)
const TTL_MAGNETS = 60 * 60 * 48; // 48 Ore (Cache Scraping)
const TTL_STREAM = 60 * 20;       // 20 Minuti (Cache Link Utente)

// CHIAVI
const keyMagnets = (type, id) => `magnets:${type}:${id}`;
const keyStream = (hash, type, id) => `stream:${hash}:${type}:${id}`;

module.exports = {
    // --- MAGNETI (GLOBAL) ---
    async getCachedMagnets(type, id) {
        try {
            const data = await redis.get(keyMagnets(type, id));
            return data ? JSON.parse(data) : null;
        } catch (e) { return null; }
    },

    async cacheMagnets(type, id, magnets) {
        if (!magnets || magnets.length === 0) return;
        const minimized = magnets.map(m => ({
            title: m.title,
            magnet: m.magnet,
            size: m.size || m.sizeBytes, 
            seeders: m.seeders || 0,
            source: m.source,
            hash: m.hash
        }));
        await redis.setex(keyMagnets(type, id), TTL_MAGNETS, JSON.stringify(minimized));
    },

    // --- STREAM (USER SPECIFIC) ---
    async getCachedStream(confHash, type, id) {
        try {
            const data = await redis.get(keyStream(confHash, type, id));
            return data ? JSON.parse(data) : null;
        } catch (e) { return null; }
    },

    async cacheStream(confHash, type, id, streamResult) {
        if (!streamResult || !streamResult.streams || streamResult.streams.length === 0) return;
        if (streamResult.streams[0].name === "⛔") return; // Non cachare errori
        await redis.setex(keyStream(confHash, type, id), TTL_STREAM, JSON.stringify(streamResult));
    },

    // --- ADMIN ---
    async listKeys() {
        const magnetKeys = await redis.keys("magnets:*");
        const streamKeys = await redis.keys("stream:*");
        let results = [];
        const getDetails = async (keys, typeLabel) => {
            for (const key of keys) {
                const ttl = await redis.ttl(key);
                const parts = key.split(":");
                const id = parts[parts.length - 1]; 
                results.push({ key, type: typeLabel, id, ttl });
            }
        };
        await getDetails(magnetKeys, "🧲 Magnets");
        await getDetails(streamKeys, "🚀 Stream");
        return results;
    },

    async deleteKey(key) { return await redis.del(key); },
    async flushAll() { return await redis.flushall(); }
};
