function getManifest() {
    return {
        id: "org.corsaro.brain.v2",
        version: "3.1.0",
        name: "Leviathan",
        description: "Motore di ricerca parallelo ad alte prestazioni per film e serie. Integra provider web italiani, scraper torrent multi-source, cache intelligente, supporto Debrid RD/TorBox e Debrid Saved Cloud opzionale: riconosce i file già salvati nel cloud personale Real-Debrid/TorBox, li mostra nella lista stream senza duplicati e li evidenzia con badge dedicato. Include routing intelligente, filtri lingua/qualità, gestione anime/Kitsu e formatter avanzato per stream 4K/HDR, WEB, BluRay e release italiane.",
        logo: "https://i.ibb.co/p914YMh/logo.png",
        resources: ["catalog", "stream"],
        types: ["movie", "series"],
        catalogs: [],
        behaviorHints: {
            configurable: true,
            configurationRequired: false
        },

        stremioAddonsConfig: {
            issuer: "https://stremio-addons.net",
            signature: "eyJhbGciOiJkaXIiLCJlbmMiOiJBMTI4Q0JDLUhTMjU2In0..guRYCFSZxJ-zbESKkZicTg.R-jeN-fyn1-6JWfMqJREy66fhEopTajTGkAKoDmwimetqMzI8zRhFoHYOckwb6KncfR4XK1g_8h9u7gYq2LFdvF5Lwm2Hr3iLcpO5vygwbSpIX7DmtV9fzKh0Z-Fe5l0.5Uy2bL0SyUSZ0mPlOSeiaA"
        }
    };
}

module.exports = { getManifest };
