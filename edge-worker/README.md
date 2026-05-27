# Leviathan Edge Gateway

Questo è un Cloudflare Worker opzionale per mettere un gateway leggero davanti a Leviathan.

## Cosa fa

- inoltra richieste Stremio verso la VPS Leviathan;
- cache leggera per manifest/configure/assets;
- aggiunge un secret header verso l'origine;
- manda hint best-effort a `/internal/edge/prewarm` quando vede una richiesta stream;
- evita di proxyare HLS/segmenti video: di default li redirige all'origine.

## Cosa NON fa

- non sostituisce FlareSolverr;
- non risolve challenge Cloudflare dei provider;
- non fa scraping;
- non deve proxyare segmenti `.ts`, `.m4s`, `.m3u8` pesanti.

## Deploy rapido

```bash
cd edge-worker
cp wrangler.toml.example wrangler.toml
# modifica ORIGIN_URL e EDGE_SECRET
npx wrangler deploy
```

Nella `.env` di Leviathan imposta la stessa secret:

```env
LEVIATHAN_EDGE_ENABLED=true
LEVIATHAN_EDGE_SECRET=cambia-questa-secret-lunga
LEVIATHAN_EDGE_ALLOW_DIRECT=true
LEVIATHAN_EDGE_REQUIRE_SECRET=false
LEVIATHAN_EDGE_INTERNAL_ENABLED=true
```

Quando vuoi obbligare il traffico pubblico a passare dall'Edge Gateway:

```env
LEVIATHAN_EDGE_ALLOW_DIRECT=false
LEVIATHAN_EDGE_REQUIRE_SECRET=true
```

Fallo solo dopo aver verificato che l'URL del Worker funziona.

## Modalità consigliata per Leviathan

Il Worker viene usato come acceleratore/gateway, ma **non modifica** `public/index.html` o `public/smartphone.js`: l'URL di installazione resta generato dal codice già esistente.

Cosa viene potenziato dal Worker:

- cache edge per manifest, configure, catalog, meta, subtitles e asset;
- stream metadata forward con prewarm hint verso `leviathan-worker`;
- stale fallback per risposte leggere già viste, utile se la VPS ha un micro-down;
- redirect diretto all'origine per HLS/proxy video, così non consumi richieste Worker sui segmenti;
- secret header verso origin, senza obbligare il traffico diretto se tieni `LEVIATHAN_EDGE_ALLOW_DIRECT=true`.

Configurazione prudente:

```env
LEVIATHAN_EDGE_ALLOW_DIRECT=true
LEVIATHAN_EDGE_REQUIRE_SECRET=false
LEVIATHAN_EDGE_CACHE_STREAM_SECONDS=0
```

Se vuoi una micro-cache anche sugli stream metadata, puoi mettere `EDGE_CACHE_STREAM_SECONDS=10` o `20`, ma non andare alto se usi config personali/token nel path.
