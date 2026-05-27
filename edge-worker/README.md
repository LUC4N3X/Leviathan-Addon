# Leviathan Edge Gateway

Cloudflare Worker opzionale per mettere un **gateway leggero, veloce e controllato** davanti a Leviathan.

L'idea è semplice: la VPS resta il cuore di Leviathan, mentre l'Edge Gateway lavora davanti come primo livello intelligente per richieste leggere, cache, prewarm e protezione dell'origine.

## Perché usarlo

Leviathan può funzionare anche senza Edge Gateway, ma con il Worker davanti guadagna un livello extra:

- risposte più rapide per manifest, configure, catalog, meta, subtitles e asset;
- meno pressione sulla VPS per le richieste ripetitive;
- stale fallback per mantenere vive risposte leggere già viste durante micro-down o riavvii;
- prewarm best-effort quando arriva una richiesta stream;
- secret header verso l'origine, utile per distinguere traffico edge da traffico diretto;
- redirect diretto all'origine per HLS/proxy video, così il Worker non viene bruciato sui segmenti pesanti.

## Istanza pubblica Leviathan

L'**istanza pubblica di Leviathan beneficia già di questa architettura**: cache edge, richieste leggere accelerate, prewarm hint e fallback prudente sono già pensati per lavorare insieme senza cambiare il normale flusso di installazione.

In pratica, chi usa l'istanza pubblica ottiene già i vantaggi del gateway quando il traffico passa dall'Edge Gateway configurato, mentre Leviathan continua a comportarsi come Leviathan: stabile, diretto, modulare e senza magie fragili sopra gli stream video.

## Cosa fa

- inoltra richieste Stremio verso la VPS Leviathan;
- applica cache leggera per manifest, configure, catalog, meta, subtitles e asset;
- aggiunge un secret header verso l'origine;
- manda hint best-effort a `/internal/edge/prewarm` quando vede una richiesta stream;
- usa stale fallback per risposte leggere già viste;
- evita di proxyare HLS/segmenti video: di default li redirige all'origine.

## Cosa NON fa

- non sostituisce FlareSolverr;
- non risolve challenge Cloudflare dei provider;
- non fa scraping;
- non deve proxyare segmenti `.ts`, `.m4s`, `.m3u8` pesanti;
- non cambia `public/index.html` o `public/smartphone.js`;
- non forza l'URL di installazione: resta quello generato dal codice già esistente.

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

Usa il Worker come **acceleratore/gateway**, non come proxy video universale.

Configurazione prudente:

```env
LEVIATHAN_EDGE_ALLOW_DIRECT=true
LEVIATHAN_EDGE_REQUIRE_SECRET=false
LEVIATHAN_EDGE_CACHE_STREAM_SECONDS=0
```

Questa modalità lascia Leviathan libero di rispondere anche direttamente, ma abilita il vantaggio edge quando il traffico passa dal Worker.

Se vuoi chiudere l'origine e accettare solo traffico firmato dal Worker, passa alla modalità più rigida:

```env
LEVIATHAN_EDGE_ALLOW_DIRECT=false
LEVIATHAN_EDGE_REQUIRE_SECRET=true
```

Usala solo dopo aver testato bene il Worker, perché un `EDGE_SECRET` errato o un origin URL sbagliato possono tagliare fuori il traffico pubblico.

## Micro-cache stream metadata

Di default gli stream metadata non vengono cacheati:

```env
LEVIATHAN_EDGE_CACHE_STREAM_SECONDS=0
```

Se vuoi una micro-cache aggressiva ma ancora prudente, puoi usare:

```env
LEVIATHAN_EDGE_CACHE_STREAM_SECONDS=10
# oppure
LEVIATHAN_EDGE_CACHE_STREAM_SECONDS=20
```

Non andare alto se usi configurazioni personali, token o parametri sensibili nel path.

## Regola d'oro

Il Worker deve rendere Leviathan più veloce e più resistente, non più complicato.

- richieste leggere: cache, stale fallback, prewarm;
- richieste video/HLS: redirect diretto all'origine;
- sicurezza: secret header e modalità strict solo quando sei sicuro;
- UX pubblica: l'istanza pubblica beneficia già del gateway senza cambiare il comportamento atteso dagli utenti.
