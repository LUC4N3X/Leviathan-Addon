<div align="center">

<img src="https://i.ibb.co/MbmdvP6/file-0000000018387243a2da8535139f6423.png" alt="Leviathan Logo" width="170" />

# LEVIATHAN

### Italy-First Aggregation Protocol for Stremio

**Torrent intelligence · Web extraction · Debrid cloud awareness · Premium stream output**

<br>

<a href="https://leviathanaddon.dpdns.org" target="_blank">
  <img alt="Installa Leviathan" src="https://img.shields.io/badge/INSTALLA-LEVIATHAN-00E7FF?style=for-the-badge&labelColor=07111f&color=00E7FF&logo=stremio&logoColor=ffffff" />
</a>

<br><br>

<img src="https://img.shields.io/badge/Node.js-20.19--24.x-339933?style=flat-square&logo=nodedotjs&logoColor=white" />
<img src="https://img.shields.io/badge/Mode-Hybrid-7c3aed?style=flat-square" />
<img src="https://img.shields.io/badge/Scope-ITA--First-00eaff?style=flat-square" />
<img src="https://img.shields.io/badge/RD%2FTB-Saved_Cloud-2ee6a6?style=flat-square" />

</div>

---

## 🔱 Cos'è Leviathan

**Leviathan** è un motore di aggregazione per Stremio progettato per unire:

- ricerca torrent;
- provider web italiani;
- bridge esterni opzionali;
- cloud personale Real-Debrid / TorBox;
- routing adattivo;
- cache intelligente;
- output ordinato e leggibile.

L'obiettivo non è solo trovare risultati, ma restituire stream **più puliti**, **più coerenti**, **più rapidi** e più facili da leggere dentro Stremio.

---

## ⚖️ Legal & Usage Notice

> [!IMPORTANT]
> **Leviathan è un framework tecnico di aggregazione, parsing, normalizzazione e routing. Non ospita, non archivia, non vende e non distribuisce contenuti multimediali.**

L'uso di Leviathan, dei provider configurati, dei servizi esterni, dei bridge, dei resolver, dei layer cloud e di eventuali componenti companion avviene sotto la piena responsabilità dell'utente finale.

Chi installa, modifica, distribuisce o utilizza il progetto deve assicurarsi di operare nel rispetto delle leggi applicabili, dei diritti di terzi, delle licenze, dei termini di servizio dei provider coinvolti e delle regole dei servizi collegati.

Il progetto è pubblicato per finalità tecniche, educative e di ricerca: studio di architetture di aggregazione, interoperabilità tra client e servizi, parsing, ranking, formatting, cache policy, resilienza operativa e delivery logic.

Il **Saved Cloud Layer** si limita a leggere e riconoscere elementi già presenti negli account Real-Debrid o TorBox configurati dall'utente.

**In sintesi:** Leviathan fornisce un motore software; l'utente resta responsabile di cosa configura, quali fonti abilita, quali servizi collega e come utilizza i risultati ottenuti.

<sub>Questa nota non costituisce consulenza legale.</sub>

---

## 🚀 Highlights

### ☁️ RD/TorBox Saved Cloud

Layer opzionale che riconosce file già presenti nel cloud personale dell'utente, li marca con `☁️ RD` / `☁️ TB` e impedisce duplicati.

### 🌐 Web Provider Routing

Gestione coordinata di StreamingCommunity, Altadefinizione, GuardaHD, GuardoSerie, Eurostreaming, AnimeWorld, AnimeUnity, AnimeSaturn e GuardaFlix.

### 🎨 Polymorphic Formatter

Rendering più pulito e gerarchico dei risultati, con badge più leggibili e separazione migliore tra sorgente, qualità, lingua e cloud.

### 🛰️ Adaptive Shared Cache

Cache condivisa con TTL modulati su volatilità, freschezza, qualità dei risultati e confidence del matching.

### 🧬 Semantic Matching

Riduzione dei falsi positivi grazie a controlli su titolo, anno, stagione, episodio, anime, release pack e lingua.

### 📡 Direct Swarm Protocol

Supporto alla riproduzione P2P diretta negli scenari senza Debrid.

---

## 🐳 Avvio rapido

```bash
git clone https://github.com/LUC4N3X/stremio-leviathan-addon
cd stremio-leviathan-addon
docker compose up -d --build
```

Endpoint locale:

```txt
http://localhost:7000
```

---

## 🛡️ Redis-backed Cloudflare Session Store

Leviathan può condividere clearance Cloudflare, cookie jar e fingerprint browser tra processo API, worker e più istanze tramite Redis.

Quando un provider richiede FlareSolverr, il primo processo che incontra la challenge acquisisce un lock Redis temporaneo. Gli altri aspettano la sessione condivisa invece di aprire solve duplicati.

Questo riduce:

- solve ripetuti;
- carico Chromium;
- timeout;
- rischio di ban;
- latenza su deploy multi-worker o multi-istanza.

Se Redis non è disponibile, Leviathan usa automaticamente il fallback su disco locale.

```env
CF_REDIS_SESSION_ENABLED=true
CF_REDIS_NATIVE_ENABLED=true
CF_REDIS_LOCK_ENABLED=true
CF_REDIS_SESSION_TTL_SECONDS=21600
CF_REDIS_NATIVE_TTL_SECONDS=1500
CF_REDIS_LOCK_TTL_MS=45000
CF_REDIS_LOCK_WAIT_MS=52000
```

> Nota: se vuoi mantenere le clearance dopo un riavvio del container Redis, abilita persistenza Redis/AOF oppure conserva il fallback su disco.

---

## ☁️ Debrid Saved Cloud

Il **Debrid Saved Cloud** controlla i file già salvati nel cloud personale Real-Debrid o TorBox e li integra nella lista stream senza creare doppioni.

### Comportamento

- **Servizi:** Real-Debrid e TorBox.
- **Attivazione:** toggle dedicato su configuratore desktop e mobile.
- **Modalità:** `smart`, `fallback`, `always`.
- **Dedupe:** lo stesso hash non viene mai mostrato due volte.
- **Formatter:** badge `☁️ RD` / `☁️ TB` e label `CLOUD SALVATO`.
- **Playback:** route dedicate `/play_saved_cloud/rd/...` e `/play_saved_cloud/tb/...`.
- **Debug:** log `[SAVED CLOUD]` per gate, skip, scan, duplicate upgrade e stream aggiunti.

---

## 🈶 Anime & Kitsu Intelligence

Leviathan integra una logica dedicata per contenuti anime e flussi Kitsu-based.

Serve a ridurre mismatch tra:

- stagioni;
- episodi assoluti;
- numerazione reale;
- titoli ambigui;
- anime canonico e live action;
- release pack;
- risultati simili ma sbagliati.

Il layer anime usa matching anime-first, contesto Kitsu, controllo stagione/episodio, query più intelligenti e ranking anti-collisione.

Provider anime supportati:

- AnimeWorld;
- AnimeUnity;
- AnimeSaturn;
- Nyaa;
- SubsPlease.

---

## 🧠 Adaptive Cache Intelligence

La cache di Leviathan non usa solo TTL fissi. Valuta anche:

- età del contenuto;
- solidità del matching;
- qualità dei risultati;
- concordanza tra fonti;
- rischio di congelare risultati instabili;
- presenza di stream già affidabili;
- validazione pack;
- exact episode match.

### Bucket operativi

**ULTRA_FRESH**  
Riuso minimo e shared cache prudente per release appena uscite.

**FRESH**  
TTL corti, revalidation frequente e scrittura condivisa solo con segnali credibili.

**SETTLING**  
Riuso controllato con peso crescente alla qualità reale del risultato.

**STABLE**  
Shared cache più aggressiva, stale reuse utile e TTL estesi.

---

## 🔱 Protocol Core

Leviathan concentra la propria logica in una pipeline unica:

- validazione semantica Italy-First;
- routing a latenza adattiva;
- resilienza contro challenge e nodi degradati;
- fusione intelligente dei metadati;
- shared cache volatility-aware;
- delivery ibrido torrent + web;
- Saved Cloud Awareness per RD/TorBox.

La pipeline analizza pattern come `MULTI`, `SUB-ITA`, `AC3`, `DTS`, distingue release italiane da risultati ambigui e ordina le sorgenti con priorità più sensate per l'utente finale.

---

## 🐙 Kraken Runtime & Provider Reliability

**Kraken** è il runtime companion consigliato per Leviathan.

Non va trattato come proxy generico: è pensato per integrarsi con Leviathan, centralizzare percorsi fragili e rendere più stabile la risoluzione dei flussi dove entrano in gioco redirect, embed intermedi, sessioni, challenge, captcha o compatibilità MediaFlow.

È particolarmente utile per:

- provider web con forwarding o pagine intermedie;
- MaxStream / UPROT;
- captcha e challenge;
- bridge MediaFlow-compatible;
- isolamento del core;
- failover operativo.

> [!NOTE]
> In self-hosting Kraken è fortemente raccomandato per replicare il comportamento più completo dell'ecosistema Leviathan. Senza Kraken alcuni provider possono continuare a funzionare, ma i flussi hoster più complessi possono risultare meno affidabili.

---

## 🌐 Network Nodes

<details>
<summary><strong>Cloud & Bridge</strong></summary>

### Cloud

- **Real-Debrid Saved Cloud**  
  Scope: user.  
  Attivazione: `enableSavedCloud` + RD token.  
  Stato: 🟢

- **TorBox Saved Cloud**  
  Scope: user.  
  Attivazione: `enableSavedCloud` + TorBox token.  
  Stato: 🟢

### Bridge

- **Torrentio**  
  Bridge esterno opzionale.  
  Stato: 🟢

- **MediaFusion**  
  Bridge RD-gated con modalità `only_when_torrentio_zero_v3`.  
  Stato: 🟢

### Runtime

- **Kraken Companion Runtime**  
  Attivazione: `KRAKEN_URL` + `KRAKEN_API_PASSWORD`.  
  Stato: 🟢 Recommended

</details>

<details>
<summary><strong>Web Provider Layer</strong></summary>

- **StreamingCommunity**  
  Scope: ITA.  
  Toggle: `enableVix` / `enableStreamingCommunity`.

- **Altadefinizione**  
  Scope: ITA.  
  Toggle: `enableAltadefinizione` / `enableCc`.

- **GuardaHD**  
  Scope: ITA.  
  Toggle: `enableGhd`.

- **GuardoSerie**  
  Scope: ITA.  
  Toggle: `enableGs`.

- **Eurostreaming**  
  Scope: serie ITA.  
  Toggle: `enableEurostreaming` / `enableEs`.

- **GuardaFlix**  
  Scope: film ITA.  
  Toggle: `enableGf`.

- **AnimeWorld**  
  Scope: anime ITA.  
  Richiede contesto anime/Kitsu.

- **AnimeUnity**  
  Scope: anime ITA.  
  Toggle: `enableAnimeUnity` oppure auto su Kitsu legacy.

- **AnimeSaturn**  
  Scope: anime ITA.  
  Richiede contesto anime/Kitsu.

</details>

<details>
<summary><strong>Torrent Engine Layer</strong></summary>

- **Il Corsaro Nero** — torrent fast lane per release italiane.
- **Knaben** — API JSON con categorie movie/series filtrate.
- **The Pirate Bay** — ApiBay JSON con magnet generati da info hash.
- **TPB Mirror** — mirror HTML fallback.
- **1337x** — protected JSON/HTML con filtri anti-rumore.
- **BitSearch** — API search con hash magnet diretto.
- **LimeTorrents** — deep scan con query variant limitate.
- **RARBG** — mirror cluster con fetch dettaglio e magnet extraction.
- **UIndex** — hybrid aggregator con parsing magnet da risultati HTML.
- **Nyaa** — anime torrent, attivo solo in contesto anime.
- **SubsPlease** — anime release API, attivo solo in contesto anime.

</details>

<details>
<summary><strong>Hoster Extractor Layer</strong></summary>

Gli hoster non sono provider di ricerca autonomi: sono risolutori usati dai provider web quando una pagina restituisce embed, player o link intermedi.

- VixCloud;
- Mixdrop;
- SuperVideo;
- Streamtape;
- UpStream;
- Uqload;
- Vidoza;
- Dropload;
- LoadM;
- DeltaBit;
- MaxStream / UPROT con delega Kraken.

</details>

<details>
<summary><strong>Provider Policy Notes</strong></summary>

- AnimeWorld, AnimeUnity e AnimeSaturn partono solo su richieste anime/Kitsu compatibili.
- AnimeUnity può auto-attivarsi su Kitsu esplicito se l'URL installato è vecchio e manca il toggle.
- MediaFusion parte solo quando Torrentio non restituisce risultati reali.
- Il check cache Real-Debrid viene applicato a MediaFusion; Torrentio può restare più diretto.
- GuardaFlix viene usato per i film e non forza percorsi serie.
- Eurostreaming viene usato come provider web ITA per serie, con routing hoster dedicato.
- Kraken è raccomandato per provider/hoster avanzati, soprattutto MaxStream / UPROT e percorsi con challenge.

</details>

---

## 🧩 File principali

<details>
<summary><strong>Saved Cloud Layer</strong></summary>

- `core/stream/debrid_saved_cloud.js`  
  Scanner e matching dei file cloud RD/TorBox.

- `core/stream_generator.js`  
  Innesto del layer cloud nella pipeline stream e gestione dedupe/annotazione.

- `core/server/routes/playback_routes.js`  
  Route sicure per riproduzione cloud salvata.

- `core/config/schema.js`  
  Normalizzazione config `enableSavedCloud`, `savedCloudMode`, `savedCloudMax`.

- `debrid/realdebrid.js`  
  Supporto lettura/risoluzione cloud Real-Debrid.

- `debrid/torbox.js`  
  Supporto lettura/risoluzione cloud TorBox.

- `core/lib/stream_formatter.js`  
  Formatter principale con badge `☁️` per cloud salvato.

- `core/lib/pulse_formatter.cjs`  
  Formatter AIO/Pulse aggiornato per riconoscere cloud salvato.

- `public/index.html`  
  Configuratore desktop aggiornato.

- `public/smartphone.js`  
  Configuratore mobile aggiornato.

</details>

<details>
<summary><strong>Provider Layer</strong></summary>

- `providers/extractors/provider_registry.js`  
  Registry centrale dei web/anime provider e timeout minimi.

- `providers/streamingcommunity/vix_handler.js`  
  Provider StreamingCommunity / Vix.

- `providers/altadefinizione/ads_handler.js`  
  Provider Altadefinizione.

- `providers/guardahd/ghd_handler.js`  
  Provider GuardaHD.

- `providers/guardoserie/gs_handler.js`  
  Provider GuardoSerie.

- `providers/animeworld/aw_handler.js`  
  Provider AnimeWorld con supporto Kitsu/anime.

- `providers/animeunity/au_handler.js`  
  Provider AnimeUnity.

- `providers/animesaturn/as_handler.js`  
  Provider AnimeSaturn.

- `providers/guardaflix/gf_handler.js`  
  Provider GuardaFlix.

- `providers/eurostreaming/es_handler.js`  
  Provider Eurostreaming con routing Safego/Clicka e hoster DeltaBit, MixDrop e MaxStream.

- `providers/engines.js`  
  Engine torrent: Corsaro, Knaben, Nyaa, SubsPlease, TPB, TPB Mirror, 1337x, BitSearch, LimeTorrents, RARBG e UIndex.

- `core/nexus-bridge/torrentio.js`  
  Bridge Torrentio Main/Mirror.

- `core/nexus-bridge/mediafusion.js`  
  Bridge MediaFusion con gate RD/cache.

- `providers/extractors/hosters/`  
  Resolver hoster.

</details>

---

## ⚠️ Self-Hosting Reality Check

> [!IMPORTANT]
> **Leviathan può essere self-hostato, ma è importante capire cosa significa.**

L'istanza pubblica del progetto non si limita al solo codice del repository. Parte dell'esperienza reale dipende anche da una componente dati e da una struttura operativa che **non è inclusa** nel repository open-source.

Non sono inclusi:

- database della istanza pubblica;
- cache pre-costruite lato server;
- infrastruttura dati privata;
- vantaggi di warm cache, storico e tuning della versione live.

In self-hosting Leviathan lavora in modo più grezzo: più scraping live, meno dati già pronti, più dipendenza dalla qualità della rete, della VPS e delle sorgenti raggiungibili.

Il **Saved Cloud Layer** resta comunque utile anche in self-hosting, perché dipende dal cloud personale RD/TorBox dell'utente.

### Consiglio pratico

- Vuoi usare Leviathan al meglio? Usa l'istanza pubblica.
- Vuoi studiare o modificare il codice? Self-hosting ok.
- Vuoi le stesse performance della live instance? No.
- Vuoi il database della versione pubblica? Non è incluso.
- Vuoi vedere i file salvati nel tuo RD/TorBox? Attiva Debrid Cloud.

---

## 🜂 Support the Protocol

Leviathan è un progetto open-source costruito con attenzione a qualità del risultato, continuità evolutiva e identità tecnica.

Puoi sostenerlo in due modi:

### 💠 Core Support

Supporto diretto allo sviluppo, alla manutenzione e all'evoluzione del progetto.

<a href="https://ko-fi.com/luc4n3x" target="_blank">
  <img src="https://img.shields.io/badge/Support-Leviathan-ff5f5f?style=for-the-badge&logo=ko-fi&logoColor=white&labelColor=0d1117" />
</a>

### ⭐ Visibility Signal

Una valutazione positiva aumenta autorevolezza, fiducia e visibilità del protocollo.

<a href="https://stremio-addons.net/addons/leviathan" target="_blank">
  <img src="https://img.shields.io/badge/Rate-Leviathan-2ea043?style=for-the-badge&logo=github&logoColor=white&labelColor=0d1117" />
</a>

---

<div align="center">

<a href="https://github.com/LUC4N3X">
  <img src="https://i.ibb.co/BK2VQxGH/github-circle-transparent.png" width="150" alt="LUC4N3X" />
</a>

## ✦ L U C 4 N 3 X ✦

### Founder · Core Architect · Lead Engineering

Ideazione, architettura, design del protocollo, integrazione dei moduli core, pipeline di aggregazione, identità del progetto e direzione evolutiva del sistema.

<br>

<img src="https://img.shields.io/badge/Protocol-Creator-00eaff?style=flat-square&labelColor=0d1117" />
<img src="https://img.shields.io/badge/Core-Engineering-ffffff?style=flat-square&labelColor=0d1117&color=ffffff" />
<img src="https://img.shields.io/badge/Stremio-Ecosystem-7cf29c?style=flat-square&labelColor=0d1117" />

<br><br>

<sub>Not a simple addon. Not a simple scraper. An operational layer built to push Stremio beyond default behavior.</sub>

</div>
