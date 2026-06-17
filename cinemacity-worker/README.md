# CinemaCity Proxy Worker

Reverse-proxy Cloudflare Worker che sta davanti a `cinemacity.cc`.

Serve a recuperare la sitemap (`news_pages.xml`) e le pagine dei contenuti aggirando il blocco Cloudflare (il `403` che si vede quando si fa la richiesta diretta). Inoltra la richiesta all'origine con header da browser e restituisce la risposta.

Lo scopo e' smettere di dipendere da proxy di terzi: con il tuo Worker su un tuo account Cloudflare hai il controllo dell'host che alimenta CinemaCity.

## Deploy

```bash
cd cinemacity-worker
cp wrangler.toml.example wrangler.toml
# opzionale: imposta CINEMACITY_COOKIE e/o PROXY_SECRET in [vars]
npx wrangler deploy
```

Wrangler stampa l'URL pubblico, es. `https://cinemacity-proxy.tuo-account.workers.dev`.

## Collegamento a Leviathan

Nel `.env` di Leviathan imposta l'host (solo host, senza `https://`):

```env
CINEMACITY_WORKER_HOST=cinemacity-proxy.tuo-account.workers.dev
```

In alternativa puoi usare `CC_WORKER_HOST`: i due nomi sono equivalenti, `CINEMACITY_WORKER_HOST` ha priorita'. Se non imposti nessuno dei due, CinemaCity usa l'host di fallback codificato in base64 nel provider (`cc.realbestia.com`).

Se proteggi il Worker con `PROXY_SECRET`, imposta lo stesso valore in `CINEMACITY_PROXY_SECRET` nel `.env` di Leviathan: il provider lo invia come header `x-proxy-secret` ad ogni richiesta verso il Worker.

```env
CINEMACITY_PROXY_SECRET=lo-stesso-valore-di-PROXY_SECRET
```

## Variabili del Worker

- `CINEMACITY_ORIGIN` — origine da proxare (default `https://cinemacity.cc`).
- `CINEMACITY_USER_AGENT` — User-Agent inviato all'origine.
- `CINEMACITY_COOKIE` — cookie opzionale (es. `cf_clearance=...`) se l'origine richiede una clearance.
- `PROXY_SECRET` — se valorizzato, il Worker accetta solo richieste con header `x-proxy-secret` uguale. Lascia vuoto per un proxy aperto.

## Note

- Il Worker inoltra solo `GET`/`HEAD` e risponde alle preflight `OPTIONS`.
- Non fa cache lato edge (`cacheTtl: 0`) per restituire sempre la sitemap aggiornata.
- Rimuove `set-cookie` e gli header CSP dell'origine.
