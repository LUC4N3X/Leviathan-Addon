<div align="center">

  <a href="https://leviathanaddon.dpdns.org" target="_blank">
    <img src="https://i.ibb.co/xSm1phHP/Chat-GPT-Image-31-mag-2026-14-39-32-1.png" alt="Leviathan Logo" width="188" />
  </a>

  <br>

  <img src="https://capsule-render.vercel.app/api?type=waving&color=0:070B13,18:081A2E,34:00D9FF,52:1E90FF,68:7C3AED,84:00CFFF,100:070B13&height=72&section=header&reversal=false&animation=fadeIn" width="56%" alt="Leviathan sea wave" />

  <br>

  <img src="https://capsule-render.vercel.app/api?type=transparent&height=92&section=header&text=LEVIATHAN&fontSize=74&fontColor=00E7FF&animation=fadeIn&fontAlignY=42&desc=ITA-first%20%2F%20ENG-ready%20Stremio%20Aggregation%20Engine&descSize=18&descAlignY=78&descColor=A8F7FF" alt="Leviathan" width="100%" />

  <p>
    <img alt="Stremio Native" src="https://img.shields.io/badge/Stremio-Native%20Addon-7C3AED?style=for-the-badge&logo=stremio&logoColor=ffffff&labelColor=07111F" />
  </p>

  <h3>🔱 High-performance stream intelligence layer for Stremio</h3>

  <p>
    <b>Leviathan unifica torrent engine, web providers, anime mapping e cloud RD/TorBox</b><br>
    in una pipeline pulita, rapida e deduplicata, progettata per dare priorità ai risultati <b>ITA</b><br>
    mantenendo supporto <b>ENG</b> quando serve.
  </p>

  <p>
    <a href="https://leviathanaddon.dpdns.org" target="_blank">
      <img alt="Install Leviathan" src="https://img.shields.io/badge/Install-Leviathan-00E7FF?style=for-the-badge&logo=stremio&logoColor=ffffff&labelColor=07111F" />
    </a>
    <img alt="Status" src="https://img.shields.io/badge/Status-Operational-2EE6A6?style=for-the-badge&logo=githubactions&logoColor=081018&labelColor=07111F" />
    <img alt="Runtime" src="https://img.shields.io/badge/Runtime-Kraken_Ready-7C3AED?style=for-the-badge&logo=dependabot&logoColor=white&labelColor=07111F" />
    <img alt="Language" src="https://img.shields.io/badge/Language-ITA_%2F_ENG-A8BFFF?style=for-the-badge&labelColor=07111F" />
  </p>

  <table align="center" width="94%">
    <tr>
      <td align="center" width="25%">
        <b>🧠 Semantic Core</b><br>
        <sub>Matching avanzato, ranking intelligente e filtri anti-rumore.</sub>
      </td>
      <td align="center" width="25%">
        <b>🇮🇹 ITA-First Logic</b><br>
        <sub>Priorità ai risultati italiani reali, con fallback ENG controllato.</sub>
      </td>
      <td align="center" width="25%">
        <b>☁️ Debrid Cloud</b><br>
        <sub>Riconoscimento RD/TorBox senza doppioni inutili.</sub>
      </td>
      <td align="center" width="25%">
        <b>🌊 Hybrid Network</b><br>
        <sub>Torrent, web provider, anime source e Kraken in un unico flusso.</sub>
      </td>
    </tr>
  </table>

  <p>
    <sub>
      ⚡ Instant setup &nbsp;•&nbsp;
      🛰️ Adaptive cache &nbsp;•&nbsp;
      🧬 Anime/Kitsu aware &nbsp;•&nbsp;
      🛡️ Provider hardening &nbsp;•&nbsp;
      💎 Clean Stremio output
    </sub>
  </p>

  <img src="https://capsule-render.vercel.app/api?type=rect&color=0:070B13,35:00E7FF,50:7C3AED,65:00BFFF,100:070B13&height=2&section=footer" width="46%" alt="divider" />

</div>

---

## ⚖️ Legal & Usage Notice

> [!IMPORTANT]
> **Leviathan è un framework tecnico di aggregazione, parsing, normalizzazione e routing. Non ospita, non archivia, non vende e non distribuisce contenuti multimediali.**

L'uso di Leviathan, dei provider configurati, dei servizi esterni, dei bridge, dei resolver, dei layer cloud e di eventuali componenti companion avviene sotto la piena responsabilità dell'utente finale. Chi installa, modifica, distribuisce o utilizza il progetto deve assicurarsi di operare nel rispetto delle leggi applicabili, dei diritti di terzi, delle licenze, dei termini di servizio dei provider coinvolti e delle regole dei servizi collegati.

Il progetto è pubblicato per finalità tecniche, educative e di ricerca: studio di architetture di aggregazione, interoperabilità tra client e servizi, parsing, ranking, formatting, cache policy, resilienza operativa e delivery logic. Leviathan non concede accesso a contenuti, non crea licenze su materiale di terzi, non autorizza usi impropri e non trasferisce alcuna responsabilità legale dagli utenti ai maintainer.

Il **Saved Cloud Layer** si limita a leggere e riconoscere elementi già presenti negli account Real-Debrid o TorBox configurati dall'utente. I componenti di routing, risoluzione hoster, challenge handling e runtime companion devono essere usati solo in contesti consentiti, autorizzati e conformi ai termini dei servizi interessati.

**In sintesi:** Leviathan fornisce un motore software; l'utente resta responsabile di cosa configura, quali fonti abilita, quali servizi collega e come utilizza i risultati ottenuti.

<sub>Usando, distribuendo o modificando questo repository, l'utente riconosce e accetta integralmente tali condizioni. Questa nota non costituisce consulenza legale.</sub>

---

## Executive Overview

> **Leviathan non è un semplice addon.**
> È un layer operativo progettato per aggregare, filtrare, ordinare e presentare risultati con una logica più vicina a un protocollo che a uno scraper tradizionale.

Il progetto nasce per offrire una base tecnica capace di unire **sorgenti torrent**, **provider web**, **moduli ibridi** e un **Saved Cloud Layer** opzionale per **Real-Debrid** e **TorBox**. Leviathan riduce il rumore nei risultati, migliora il matching semantico, mantiene una latenza percepita aggressiva, applica **cache intelligence adattiva** e restituisce output leggibili e pronti all'uso in ambiente Stremio.

La logica cloud non sostituisce la pipeline principale: la potenzia. Se l'utente ha già un file salvato nel proprio cloud RD/TorBox, Leviathan può riconoscerlo, marcarlo visivamente e, quando non è già presente tra i risultati normali, aggiungerlo come stream dedicato senza creare duplicati.

---

## Release Highlights

<div align="center">

<table align="center">
<tr>
<td align="center" width="33%"><b>☁️ RD/TorBox Saved Cloud</b><br><sub>Layer opzionale che riconosce i file già salvati, marca i duplicati e usa <code>☁️ RD</code> / <code>☁️ TB</code>.</sub></td>
<td align="center" width="33%"><b>🚀 Core Refactoring</b><br><sub>Motore riorganizzato per maggiore stabilità, leggibilità e tenuta sotto carico.</sub></td>
<td align="center" width="33%"><b>🌐 Web Provider Routing</b><br><sub>Gestione coordinata di StreamingCommunity, Altadefinizione, GuardaHD, GuardoSerie, Eurostreaming, ToonItalia, OnlineSerieTV, AnimeWorld, AnimeUnity, AnimeSaturn e GuardaFlix.</sub></td>
</tr>
<tr>
<td align="center" width="33%"><b>🎨 Polymorphic Formatter</b><br><sub>Rendering più pulito, gerarchico e leggibile dentro Stremio.</sub></td>
<td align="center" width="33%"><b>🗣️ Tri-Scope Language Control</b><br><sub>Modalità dedicate per ITA, ENG e Hybrid.</sub></td>
<td align="center" width="33%"><b>🛰️ Adaptive Shared Cache</b><br><sub>TTL e riuso modulati su volatilità, qualità e confidence reale.</sub></td>
</tr>
<tr>
<td align="center" width="33%"><b>📡 Direct Swarm Protocol</b><br><sub>Riproduzione P2P diretta per scenari senza debrid.</sub></td>
<td align="center" width="33%"><b>🧬 Semantic Matching</b><br><sub>Riduzione dei falsi positivi e ranking più credibile.</sub></td>
<td align="center" width="33%"><b>⚙️ Hybrid Delivery Logic</b><br><sub>Passaggio intelligente tra percorso torrent e web quando serve.</sub></td>
</tr>
</table>

</div>

---

## 🛡️ Redis-backed Cloudflare Session Store

Leviathan può condividere clearance Cloudflare, cookie jar e fingerprint browser tra processo API, worker e istanze multiple tramite Redis. Quando un provider richiede FlareSolverr, il primo processo che incontra la challenge acquisisce un lock Redis temporaneo; gli altri aspettano la sessione condivisa invece di aprire solve duplicati.

Questo riduce solve ripetuti, carico Chromium, timeout e rischio di ban su deploy con `CLUSTER_WORKERS`, container API+worker o più istanze dietro lo stesso Redis. Il disco locale resta fallback automatico: se Redis non è disponibile, Leviathan continua a usare il comportamento precedente.

Quando una sessione FlareSolverr valida è già disponibile, anche la first-pass `curl_cffi` viene seedata con gli stessi cookie, cookie jar e User-Agent prima di provare il fetch. In pratica: FlareSolverr risolve una volta, poi `curl_cffi` può riutilizzare quella clearance leggera sui tentativi successivi.

Variabili principali:

```env
CF_REDIS_SESSION_ENABLED=true
CF_REDIS_NATIVE_ENABLED=true
CF_REDIS_LOCK_ENABLED=true
CF_REDIS_SESSION_TTL_SECONDS=21600
CF_REDIS_NATIVE_TTL_SECONDS=1500
CF_REDIS_LOCK_TTL_MS=45000
CF_REDIS_LOCK_WAIT_MS=52000
```

> [!NOTE]
> Il `docker-compose.yml` usa Redis come cache volatile. Per mantenere le clearance anche dopo un riavvio del container Redis, abilita persistenza Redis/AOF oppure conserva il fallback su disco.

---

## ☁️ Debrid Saved Cloud

<div align="center">

### `RD/TorBox cloud-aware · opzionale · zero duplicati`

</div>

Il **Debrid Saved Cloud** è un layer opzionale che controlla i file già salvati nel cloud personale dell'utente su **Real-Debrid** o **TorBox** e li integra nella lista stream di Leviathan senza creare doppioni.

La pipeline normale resta invariata: Leviathan cerca prima torrent, cache, provider esterni e risultati web. Dopo il ranking, se il Cloud è attivo, confronta i file salvati con titolo, anno, stagione, episodio, anime/episodio assoluto e filtri lingua/qualità.

<div align="center">

| Funzione | Comportamento |
|:---|:---|
| **Servizi** | Solo **Real-Debrid** e **TorBox** |
| **Attivazione** | Toggle dedicato su configuratore desktop e `smartphone.js` |
| **Modalità** | `smart`, `fallback`, `always` — in `always` il cloud viene controllato sempre, i duplicati restano esclusi |
| **Dedupe** | Lo stesso hash non viene mai mostrato due volte. Se un torrent normale è anche nel cloud, viene solo marcato |
| **Formatter** | Gli stream cloud usano `☁️ RD` / `☁️ TB` e label `CLOUD SALVATO` |
| **Playback** | Route dedicate `/play_saved_cloud/rd/...` e `/play_saved_cloud/tb/...` |
| **Debug** | Log `[SAVED CLOUD]` per gate, skip, scan, duplicate upgrade e stream aggiunti |

<br>

<img src="https://img.shields.io/badge/SAVED_CLOUD-RD_+_TORBOX-00eaff?style=for-the-badge&labelColor=061018" />
<img src="https://img.shields.io/badge/DEDUPLICATION-ALWAYS_ON-7c3aed?style=for-the-badge&labelColor=061018" />
<img src="https://img.shields.io/badge/FORMATTER-CLOUD_AWARE-2ee6a6?style=for-the-badge&labelColor=061018" />

</div>

---

## 🈶 Anime & Kitsu Intelligence

<div align="center">

### `Mapping anime-first · Kitsu-aware · collision control`

</div>

**Leviathan** integra una logica dedicata per contenuti **anime** e flussi **Kitsu-based**, con una pipeline costruita per ridurre mismatch tra **stagioni**, **episodi assoluti**, **numerazione reale** e titoli ambigui.

Questo permette al protocollo di trattare meglio serie come **One Piece**, **Jujutsu Kaisen** e altri anime con naming complesso, distinguendo in modo più credibile tra **anime canonico**, **live action**, release pack, stagioni esplicite e risultati semanticamente simili ma sbagliati.

La logica combina **matching anime-first**, **contesto Kitsu**, **controllo stagione/episodio**, **query più intelligenti** e **ranking anti-collisione**. Il layer anime è allineato ai provider realmente registrati nel codice: **AnimeWorld**, **AnimeUnity**, **AnimeSaturn**, più gli engine torrent anime **Nyaa** e **SubsPlease**.

<div align="center">

<br>

<img src="https://img.shields.io/badge/KITSU-AWARE-00eaff?style=for-the-badge&labelColor=061018" />
<img src="https://img.shields.io/badge/ANIME-FIRST_MATCHING-7c3aed?style=for-the-badge&labelColor=061018" />
<img src="https://img.shields.io/badge/EPISODE-COLLISION_CONTROL-ff5a7a?style=for-the-badge&labelColor=061018" />

</div>

---

## 🧠 Adaptive Cache Intelligence

<div align="center">

### `Volatility-Aware Shared Cache Policy`

</div>

La cache di **Leviathan** non lavora come un semplice contenitore con TTL fissi. Il protocollo valuta **età del contenuto**, **solidità del matching**, **qualità effettiva dei risultati**, **concordanza tra fonti** e **rischio di congelare uno stato ancora instabile**.

Un contenuto appena uscito non viene trattato come una release ormai assestata: la policy può accorciare il riuso, limitare la scrittura condivisa, favorire micro-cache locali, oppure promuovere in shared solo risultati veramente forti. L'obiettivo è evitare che output ancora acerbi diventino "verità globale" troppo presto.

<div align="center">

| Volatility Bucket | Logica Operativa | Obiettivo |
|:---|:---|:---|
| **ULTRA_FRESH** | Riuso minimo, shared molto prudente, niente congelamento di risultati deboli | Proteggere release appena uscite |
| **FRESH** | TTL corti, revalidation frequente, scrittura condivisa solo con segnali credibili | Evitare output incompleti o instabili |
| **SETTLING** | Riuso controllato, peso crescente alla qualità reale del risultato | Accompagnare la fase di assestamento |
| **STABLE** | Shared cache aggressiva, stale reuse più utile, TTL estesi | Massimizzare velocità e continuità |

<br>

<img src="https://img.shields.io/badge/CACHE-VOLATILITY_AWARE-00eaff?style=for-the-badge&labelColor=061018" />
<img src="https://img.shields.io/badge/TTL-CONFIDENCE_WEIGHTED-7c3aed?style=for-the-badge&labelColor=061018" />
<img src="https://img.shields.io/badge/FRESH_RELEASES-PROTECTED-ff5a7a?style=for-the-badge&labelColor=061018" />

</div>

La decisione finale non dipende solo dal tempo: dipende da **confidence score**, **exact episode match**, **qualità migliore trovata**, **presenza di stream già affidabili**, **validazione pack** e penalizzazione dei risultati più fragili. In questo modo la cache diventa parte attiva del motore di ranking, non un semplice strato passivo.

---

## 🔱 Protocol Core

<div align="center">

### `Un solo blocco operativo, più layer sincronizzati`

</div>

**Leviathan** concentra la propria logica in una pipeline unica che combina **validazione semantica Italy-First**, **routing a latenza adattiva**, **resilienza contro challenge e nodi degradati**, **fusione intelligente dei metadati**, **shared cache volatility-aware**, **delivery ibrido torrent + web** e **Saved Cloud Awareness** per RD/TorBox.

In pratica il protocollo analizza pattern come `MULTI`, `SUB-ITA`, `AC3` e `DTS`, distingue release realmente italiane da risultati ambigui, riduce i falsi positivi e ordina le sorgenti con priorità più sensate per l'utente finale. Sul piano operativo decide dinamicamente quali provider meritano la corsia veloce e quali richiedono una scansione più profonda.

A livello infrastrutturale integra **WAF handling**, **identity rotation**, **failover automatici**, **magnet enrichment**, un layer ibrido con **StreamingCommunity**, **Altadefinizione**, **GuardaHD**, **GuardoSerie**, **Eurostreaming**, **AnimeWorld**, **AnimeUnity**, **AnimeSaturn** e **GuardaFlix**, e un layer cloud opzionale senza duplicati.

Il blocco viene completato da **Debrid Ghost Shell** per scenari proxy-based, **Polymorphic Formatter Engine** per una resa visiva superiore, **Linguistic Scope Control** per ITA / ENG / Hybrid, **Trailer Bridge** per le anteprime contestuali e **Direct Swarm Access** per la riproduzione P2P pura.

<div align="center">

<br>

<img src="https://img.shields.io/badge/ITALIAN_SEMANTICS-STRICT-00eaff?style=for-the-badge&labelColor=061018" />
<img src="https://img.shields.io/badge/HYBRID_DELIVERY-TORRENT_+_WEB-7c3aed?style=for-the-badge&labelColor=061018" />
<img src="https://img.shields.io/badge/SAVED_CLOUD-RD_+_TB-2ee6a6?style=for-the-badge&labelColor=061018" />
<img src="https://img.shields.io/badge/ADAPTIVE_LATENCY-ROUTING-00c2ff?style=for-the-badge&labelColor=061018" />

<br><br>

<img src="https://img.shields.io/badge/FAILOVER-AUTOMATIC-ff335f?style=flat-square&labelColor=0d1117" />
<img src="https://img.shields.io/badge/WAF-RESILIENCE-ff9f1a?style=flat-square&labelColor=0d1117" />
<img src="https://img.shields.io/badge/FORMATTER-POLYMORPHIC-2ee6a6?style=flat-square&labelColor=0d1117" />
<img src="https://img.shields.io/badge/LANGUAGE-ITA_|_ENG_|_HYBRID-00eaff?style=flat-square&labelColor=0d1117" />

</div>

---

## 🌐 Leviathan Network Map

<div align="center">

### `Cloud · Web Providers · Torrent Engines · Hoster Extractors`

Leviathan usa più layer sincronizzati, ma la logica è semplice:  
**prima normalizza la richiesta, poi cerca le sorgenti migliori, deduplica i risultati e li consegna a Stremio con ranking pulito.**

<br>

<img src="https://img.shields.io/badge/CLOUD-RD_/_TORBOX-00E7FF?style=for-the-badge&labelColor=07111F" />
<img src="https://img.shields.io/badge/WEB-ITALIAN_PROVIDERS-2EE6A6?style=for-the-badge&labelColor=07111F" />
<img src="https://img.shields.io/badge/TORRENT-ITA_+_GLOBAL-7C3AED?style=for-the-badge&labelColor=07111F" />
<img src="https://img.shields.io/badge/RUNTIME-KRAKEN_READY-FF5A7A?style=for-the-badge&labelColor=07111F" />


</div>

---

### 🧭 Web Provider Expansion

<div align="center">

`ToonItalia · OnlineSerieTV · Moflix POC · bridge-first resolving`

</div>

Leviathan integra un layer provider modulare pensato per separare in modo chiaro **discovery**, **mirror extraction**, **hoster resolution** e **playback delivery**. I provider web non vengono trattati come semplici scraper: ogni modulo può avere policy, timeout, fallback, runtime e parser dedicati.

Oltre ai provider principali, il protocollo include moduli specializzati per sorgenti come **ToonItalia** e **OnlineSerieTV**, con flussi orientati a link hoster, episodi serie, server multipli, SearchWP, pagine ponte e resolver esterni. I provider sperimentali restano isolati e controllabili da configurazione, così possono essere testati senza compromettere la stabilità della pipeline principale.

<div align="center">

| Provider | Scope | Routing | Stato |
|:---:|:---|:---|:---:|
| **ToonItalia** | Anime, cartoon, pagine web | VOE · MaxStream · LoadM/RPM | 🟢 Optional |
| **OnlineSerieTV** | Serie TV ITA | SearchWP · Kraken Forward · UPROT/MaxStream | 🧪 Experimental |
| **Moflix POC** | TMDB-based fallback | Server discovery · extractor registry | 🧪 Disabled by default |
| **Bridge Resolver** | Pagine ponte / embed intermedi | URL normalization · hoster handoff | 🟢 Optional |

</div>

> [!NOTE]
> I provider sperimentali sono pensati come fallback controllati. Leviathan non li usa per sostituire la pipeline principale, ma per aumentare copertura quando torrent, cloud o provider stabili non sono sufficienti.

---

### 🦑 Kraken Runtime

<div align="center">

`Leviathan-native companion · provider hardening · forward transport · hoster orchestration`

</div>

**Kraken** è il runtime companion consigliato per Leviathan. Non è un proxy generico: centralizza i percorsi più delicati dei provider web e degli hoster quando entrano in gioco redirect, embed intermedi, sessioni, challenge, captcha, header richiesti o compatibilità MediaFlow.

È particolarmente utile per i flussi **MaxStream / UPROT**, **VOE**, **VidGuard/listeamed** e per provider che richiedono un trasporto più vicino a un browser reale. In questo modo Leviathan resta concentrato su ricerca, ranking, dedupe, formatter e configurazione, mentre Kraken gestisce la parte operativa più fragile.

<div align="center">

| Runtime | Scope | Configurazione | Stato |
|:---:|:---:|:---:|:---:|
| **Kraken Companion Runtime** | 🔱 Leviathan-native | `KRAKEN_URL` + `KRAKEN_API_PASSWORD` | 🟢 Recommended |
| **Kraken Forward** | Provider origin fetch | `FORWARD_PROXY` / forward endpoint | 🟢 Recommended |
| **MediaFlow-compatible Bridge** | Playback/runtime handoff | Proxy HLS/stream compatible | 🟢 Optional |

<br>

<img src="https://img.shields.io/badge/MAXSTREAM_/_UPROT-CHALLENGE_SOLVE-7C3AED?style=for-the-badge&labelColor=07111F" />
<img src="https://img.shields.io/badge/VOE_/_VIDGUARD-RUNTIME_READY-00E7FF?style=for-the-badge&labelColor=07111F" />
<img src="https://img.shields.io/badge/MEDIAFLOW-COMPATIBLE_BRIDGE-2EE6A6?style=for-the-badge&labelColor=07111F" />
<img src="https://img.shields.io/badge/CORE-ISOLATION-00E7FF?style=for-the-badge&labelColor=07111F" />

</div>

> [!NOTE]
> In self-hosting Kraken è fortemente raccomandato per replicare il comportamento più completo dell'ecosistema Leviathan. Senza Kraken alcuni provider possono continuare a funzionare, ma gli hoster più complessi possono risultare meno affidabili.

---

### 🧬 Kraken Forward Strategy

<div align="center">

`Chrome-like fetching · forward proxy · safer provider transport`

</div>

Per alcuni provider non è sufficiente usare una richiesta HTTP tradizionale o forzare FlareSolverr. Leviathan può delegare il fetch delle pagine più delicate a **Kraken Forward**, ottenendo un comportamento più adatto ai provider che richiedono fingerprint, cookie, redirect, header coerenti o sessioni riutilizzabili.

Questa strategia è particolarmente utile per flussi come **OnlineSerieTV**, dove il percorso più corretto non è sempre browser automation, ma una richiesta forward con comportamento più vicino a `curl_cffi` / Chrome impersonation, lasciando FlareSolverr come fallback mirato e non come soluzione forzata.

<div align="center">

| Strategia | Uso consigliato |
|:---|:---|
| **Direct fetch** | Provider semplici o pagine statiche |
| **Kraken Forward** | Provider con blocchi, fingerprint o SearchWP fragile |
| **FlareSolverr** | Challenge Cloudflare reali dove Chromium è utile |
| **Extractor Runtime** | Hoster finali con embed, token, captcha o HLS fragile |

</div>

> [!IMPORTANT]
> FlareSolverr non è sempre la risposta migliore. Quando un provider blocca Chromium o ignora header custom, il percorso più affidabile può essere Kraken Forward / curl_cffi-like transport.

---

### ☁️ Cloud & Bridge Layer

<div align="center">

| Layer | Componenti | Attivazione | Stato |
|:---:|:---|:---|:---:|
| **Saved Cloud** | Real-Debrid Saved Cloud · TorBox Saved Cloud | `enableSavedCloud` + token utente | 🟢 |
| **Nexus Bridge** | Torrentio · MediaFusion | Bridge esterno opzionale · `only_when_torrentio_zero_v3` | 🟢 |

</div>

---

### 🇮🇹 Web Provider Layer

<div align="center">

| Categoria | Provider | Attivazione |
|:---:|:---|:---|
| **Web ITA** | StreamingCommunity · Altadefinizione · GuardaHD · GuardoSerie · Eurostreaming · ToonItalia · OnlineSerieTV | `enableStreamingCommunity` · `enableAltadefinizione` · `enableGhd` · `enableGs` · `enableEurostreaming` · `enableToonItalia` · `enableOnlineserietv` |
| **Movie ITA** | GuardaFlix | `enableGf` |
| **Anime ITA** | AnimeWorld · AnimeUnity · AnimeSaturn | `enableAnimeWorld` · `enableAnimeUnity` · `enableAnimeSaturn` |
| **Experimental / Fallback** | Moflix POC · Bridge Resolver | `enableMoflix` · provider-controlled fallback |

</div>

> **Policy veloce:** gli anime provider partono solo su richieste anime/Kitsu compatibili; GuardaFlix resta su film; Eurostreaming, ToonItalia e OnlineSerieTV lavorano come provider web ITA con routing hoster dedicato; i moduli sperimentali restano opt-in o fallback controllati.

---

### 🌐 Torrent Engine Layer

<div align="center">

| Categoria | Engine | Note |
|:---:|:---|:---|
| **ITA Fast Lane** | Il Corsaro Nero | Priorità alta per release italiane |
| **Global Search** | Knaben · The Pirate Bay · TPB Mirror · 1337x · BitSearch · LimeTorrents · RARBG · UIndex | Ricerca globale con filtri qualità, lingua e anti-rumore |
| **Anime Torrent** | Nyaa · SubsPlease | Attivi solo in contesto anime |

</div>

---

### 🔌 Hoster Extractor Layer

<div align="center">

| Gruppo | Extractor | Ruolo |
|:---:|:---|:---|
| **Player Web** | VixCloud · VixSrc/Vix aliases | Risoluzione StreamingCommunity / player compatibili |
| **VOE Family** | VOE · voe.sx · alias compatibili | Estrazione HLS/MP4 da embed VOE e provider compatibili |
| **VidGuard Family** | VidGuard · listeamed · vembed · bembed · vgfplay | Resolver usato da AnimeWorld e provider con embed listeamed |
| **Hoster Standard** | MixDrop · MixDrop aliases · SuperVideo · StreamTape · UpStream · Uqload · Vidoza · Dropload · LoadM | Resolver hoster usati dai provider web |
| **Eurostreaming / Web ITA** | DeltaBit · MixDrop · MaxStream / UPROT | Routing dedicato da Safego/Clicka e pagine ponte verso hoster finali |
| **Bridge Resolver** | Pagine ponte · iframe · data-link · data-url | Normalizza URL intermedi prima dell'extractor finale |
| **Kraken Assisted** | MaxStream / UPROT · VOE · VidGuard | Delega captcha/challenge, headers, proxy HLS e bridge MediaFlow-compatible |

</div>

<div align="center">

```text
Provider web
→ bridge resolver
→ hoster detection
→ extractor locale o Kraken
→ stream Stremio pulito
```

</div>

---

### 📑 Provider Policy Notes

<div align="center">

| Policy | Comportamento |
|:---|:---|
| **Anime eligibility** | AnimeWorld, AnimeUnity e AnimeSaturn partono solo su richieste anime/Kitsu compatibili |
| **AnimeUnity legacy auto** | Se l'URL installato è vecchio e manca il toggle, AnimeUnity può auto-attivarsi su Kitsu esplicito |
| **MediaFusion gate** | MediaFusion parte solo quando Torrentio non restituisce risultati reali |
| **MediaFusion RD check** | Il check cache Real-Debrid viene applicato a MediaFusion; Torrentio può restare più diretto |
| **GuardaFlix scope** | GuardaFlix viene usato per i film e non forza percorsi serie |
| **Eurostreaming scope** | Eurostreaming viene usato come provider web ITA per serie, con routing hoster dedicato |
| **ToonItalia scope** | ToonItalia è opzionale e lavora su pagine anime/cartoon con handoff verso VOE, MaxStream e LoadM/RPM |
| **OnlineSerieTV scope** | OnlineSerieTV è sperimentale, serie-oriented e preferisce SearchWP + Kraken Forward per il fetch origin |
| **Moflix POC** | Moflix resta disattivato di default e può essere usato come fallback TMDB-based controllato |
| **Bridge resolver** | Le pagine ponte vengono risolte prima del registry hoster per ridurre link non supportati |
| **Kraken recommended** | Kraken è raccomandato per provider/hoster avanzati, soprattutto MaxStream / UPROT, VOE, VidGuard e percorsi con challenge |

</div>

---


## 🐳 Deployment Protocol

<div align="center">

[![Docker](https://img.shields.io/badge/Docker-Ready-2496ED?style=for-the-badge&logo=docker&logoColor=white)](https://www.docker.com/)
[![Stremio Addon](https://img.shields.io/badge/Stremio-Addon-7cf29c?style=for-the-badge&logo=stremio&logoColor=081018)](https://www.stremio.com/)

</div>

### Standard Bootstrap

```bash
git clone https://github.com/LUC4N3X/stremio-leviathan-addon
cd stremio-leviathan-addon
docker compose up -d --build
```

### Local Endpoint

```
http://localhost:7000
```

---

## 🧩 Core File Atlas

<div align="center">

### `Operational map of the most important Leviathan files`

Una vista più leggibile dei file chiave del progetto:  
**cosa fanno, dove stanno e quale layer controllano davvero.**

<br>

<img src="https://img.shields.io/badge/SAVED_CLOUD-RD_/_TORBOX-00E7FF?style=for-the-badge&labelColor=07111F" />
<img src="https://img.shields.io/badge/PROVIDERS-WEB_+_ANIME-2EE6A6?style=for-the-badge&labelColor=07111F" />
<img src="https://img.shields.io/badge/TORRENT-ENGINES-7C3AED?style=for-the-badge&labelColor=07111F" />
<img src="https://img.shields.io/badge/HOSTERS-RUNTIME_FLOW-FF5A7A?style=for-the-badge&labelColor=07111F" />

</div>

---

## ☁️ Saved Cloud Layer

<div align="center">

### `RD/TorBox recognition · cloud playback · formatter awareness · UI config`

</div>

<table align="center" width="100%">
<tr>
<td valign="top" width="50%">

### 🔎 Cloud Intelligence

- `core/stream/debrid_saved_cloud.js`  
  Scanner e matching dei file cloud **RD/TorBox**.

- `debrid/realdebrid.js`  
  Supporto lettura e risoluzione cloud **Real-Debrid**.

- `debrid/torbox.js`  
  Supporto lettura e risoluzione cloud **TorBox**.

- `core/config/schema.js`  
  Normalizzazione di `enableSavedCloud`, `savedCloudMode`, `savedCloudMax`.

</td>
<td valign="top" width="50%">

### 🚀 Stream Delivery & UI

- `core/stream_generator.js`  
  Innesta il layer cloud nella pipeline stream e gestisce dedupe/annotazione.

- `core/server/routes/playback_routes.js`  
  Route sicure per la riproduzione cloud salvata.

- `core/lib/stream_formatter.js`  
  Formatter principale con badge `☁️` per gli stream cloud salvati.

- `core/lib/pulse_formatter.cjs`  
  Formatter AIO/Pulse aggiornato per riconoscere il cloud salvato.

- `public/index.html`  
  Configuratore desktop aggiornato.

- `public/smartphone.js`  
  Configuratore mobile aggiornato.

</td>
</tr>
</table>

<div align="center">

<sub>Il Saved Cloud Layer legge, riconosce, formatta e consegna in playback i file già presenti negli account RD/TorBox dell'utente.</sub>

</div>

---

## 🌐 Provider & Runtime Layer

<div align="center">

### `Web providers · anime providers · bridges · torrent engines · hoster resolvers`

</div>

<table align="center" width="100%">
<tr>
<td valign="top" width="50%">

### 🧭 Provider Orchestration

- `providers/extractors/provider_registry.js`  
  Registry centrale dei provider web/anime e gestione timeout minimi.

- `core/nexus-bridge/torrentio.js`  
  Bridge **Torrentio** main/mirror.

- `core/nexus-bridge/mediafusion.js`  
  Bridge **MediaFusion** con gate RD/cache.

- `providers/engines.js`  
  Engine torrent: **Corsaro, Knaben, TPB, TPB Mirror, 1337x, BitSearch, LimeTorrents, RARBG, UIndex, Nyaa, SubsPlease**.

</td>
<td valign="top" width="50%">

### 🇮🇹 Web Provider Modules

- `providers/streamingcommunity/vix_handler.js`  
  Provider **StreamingCommunity / Vix**.

- `providers/altadefinizione/ads_handler.js`  
  Provider **Altadefinizione**.

- `providers/guardahd/ghd_handler.js`  
  Provider **GuardaHD**.

- `providers/guardoserie/gs_handler.js`  
  Provider **GuardoSerie**.

- `providers/guardaflix/gf_handler.js`  
  Provider **GuardaFlix**.

- `providers/eurostreaming/es_handler.js`  
  Provider **Eurostreaming** con routing **Safego/Clicka** e hoster **DeltaBit / MixDrop / MaxStream**.

- `providers/toonitalia/toonitalia_handler.js`  
  Provider **ToonItalia** con handoff verso **VOE / MaxStream / LoadM-RPM**.

- `providers/onlineserietv/onlineserietv_handler.js`  
  Provider **OnlineSerieTV** con SearchWP, Kraken Forward e routing **UPROT / MaxStream**.

- `providers/moflix/moflix_handler.js`  
  POC **Moflix** disattivata di default, utile come fallback sperimentale TMDB-based.

</td>
</tr>
<tr>
<td valign="top" width="50%">

### 🈶 Anime & Specialized Sources

- `providers/animeworld/aw_handler.js`  
  Provider **AnimeWorld** con supporto **Kitsu/anime**, API episode info e handoff verso **VidGuard/listeamed** quando disponibile.

- `providers/animeunity/au_handler.js`  
  Provider **AnimeUnity**.

- `providers/animesaturn/as_handler.js`  
  Provider **AnimeSaturn**.

</td>
<td valign="top" width="50%">

### 🔌 Hoster Resolution Runtime

- `providers/extractors/hosters/`  
  Resolver hoster: **VixCloud, VOE, VidGuard/listeamed, MixDrop + aliases, SuperVideo, StreamTape, UpStream, Uqload, Vidoza, Dropload, LoadM, DeltaBit, MaxStream/UPROT**.

- `providers/extractors/bridge_resolver.js`  
  Resolver intermedio per pagine ponte, iframe, redirect e URL hoster non esposti direttamente.

</td>
</tr>
</table>

<div align="center">

<sub>Questo layer è il cuore operativo che coordina discovery, bridge, provider web, anime sources, torrent engines e risoluzione hoster.</sub>

</div>

---

## ⚠️ Self-Hosting Reality Check

> [!IMPORTANT]
> **Leviathan può essere self-hostato, ma è importante capire cosa significa.**

L'istanza pubblica del progetto non si limita al solo codice del repository. Parte dell'esperienza reale dipende anche da una componente dati e da una struttura operativa che **non è inclusa** nel repository open-source.

**Cosa non è incluso nel repo:**
- Il database della istanza pubblica
- Eventuali cache pre-costruite lato server
- L'infrastruttura dati privata usata per ottimizzare i risultati
- I vantaggi di warm cache, storico e tuning della versione live

In self-hosting, Leviathan deve lavorare in modo più grezzo: più scraping live, meno dati già pronti, più dipendenza dalla qualità della rete, della VPS e delle sorgenti raggiungibili. L'esperienza resta valida per studio e sviluppo, ma non replica il comportamento ottimizzato della live instance.

Il **Saved Cloud Layer** resta comunque utile anche in self-hosting, perché dipende dal cloud personale RD/TorBox dell'utente.

<div align="center">

| Scenario | Consiglio |
|:---|:---:|
| Vuoi usare Leviathan al meglio | **Usa l'istanza pubblica** |
| Vuoi studiare o modificare il codice | **Self-hosting ok** |
| Vuoi le stesse performance della live instance | **No** |
| Vuoi il database della versione pubblica | **Non è incluso** |
| Vuoi vedere i file già salvati nel tuo RD/TorBox | **Attiva Debrid Cloud** |

</div>

---

## 🜂 Support the Protocol

<div align="center">

<img src="https://capsule-render.vercel.app/api?type=rect&color=0:060d18,50:00d8ff,100:060d18&height=1&section=header" width="60%" />

<br>

Leviathan è un progetto open-source costruito con attenzione a qualità del risultato, continuità evolutiva e identità tecnica. Puoi sostenerlo in due modi.

<br>

<table align="center">
<tr>
<td align="center" width="50%">

### 💠 Core Support

Supporto diretto allo sviluppo, alla manutenzione e all'evoluzione del progetto.

<br>

<a href="https://ko-fi.com/luc4n3x" target="_blank">
  <img src="https://img.shields.io/badge/Support-Leviathan-ff5f5f?style=for-the-badge&logo=ko-fi&logoColor=white&labelColor=0d1117" />
</a>

<br><br>

<a href="https://ko-fi.com/luc4n3x" target="_blank">
  <img src="https://capsule-render.vercel.app/api?type=rounded&color=0:ff7b7b,100:ff4d6d&height=74&section=header&text=Core%20Support%20via%20Ko-fi&fontSize=26&fontColor=ffffff&animation=fadeIn&fontAlignY=55" alt="Support Leviathan on Ko-fi" />
</a>

</td>
<td align="center" width="50%">

### ⭐ Visibility Signal

Una valutazione positiva aumenta autorevolezza, fiducia e visibilità del protocollo.

<br>

<a href="https://stremio-addons.net/addons/leviathan" target="_blank">
  <img src="https://img.shields.io/badge/Rate-Leviathan-2ea043?style=for-the-badge&logo=github&logoColor=white&labelColor=0d1117" />
</a>

<br><br>

<a href="https://stremio-addons.net/addons/leviathan" target="_blank">
  <img src="https://capsule-render.vercel.app/api?type=rounded&color=0:34d399,100:16a34a&height=74&section=header&text=Leave%20a%20Star%20•%20Boost%20the%20Protocol&fontSize=24&fontColor=ffffff&animation=fadeIn&fontAlignY=55" alt="Boost the Protocol" />
</a>

</td>
</tr>
</table>

<sub>Ogni contributo, piccolo o grande, aiuta Leviathan a restare veloce, solido e in continua evoluzione.</sub>

</div>

---

<div align="center">

<img src="https://capsule-render.vercel.app/api?type=waving&color=0:0d1117,100:00E0FF&height=120&section=header&text=Credits&fontSize=38&fontColor=ffffff&animation=fadeIn&fontAlignY=38" width="100%" />

<br>

<a href="https://github.com/LUC4N3X">
  <img src="https://i.ibb.co/BK2VQxGH/github-circle-transparent.png" width="190" style="border-radius:50%; box-shadow: 0 0 24px rgba(0, 224, 255, 0.35);" alt="LUC4N3X" />
</a>

<br><br>

## ✦ L U C 4 N 3 X ✦

### Founder · Core Architect · Lead Engineering

<p>Ideazione, architettura, design del protocollo, integrazione dei moduli core, pipeline di aggregazione, identità del progetto e direzione evolutiva del sistema.</p>

<br>

<img src="https://img.shields.io/badge/Protocol-Creator-00eaff?style=for-the-badge&labelColor=0d1117" />
<img src="https://img.shields.io/badge/Core-Engineering-ffffff?style=for-the-badge&labelColor=0d1117&color=ffffff" />
<img src="https://img.shields.io/badge/Stremio-Ecosystem-7cf29c?style=for-the-badge&labelColor=0d1117" />

<br><br>

### Special Thanks

<table align="center" width="88%">
<tr>
<td align="center" width="50%">
<a href="https://github.com/UrloMythus/MammaMia" target="_blank"><b>MammaMia</b></a><br>
<sub>Thanks to the MammaMia project for openly sharing provider-flow ideas and logic patterns that helped inform parts of Leviathan's provider strategy.</sub>
</td>
<td align="center" width="50%">
<a href="https://github.com/mhdzumair/mediaflow-proxy" target="_blank"><b>MediaFlow Proxy</b></a><br>
<sub>Thanks to MediaFlow Proxy for its extractor ecosystem and media-routing concepts, used as a valuable technical reference while shaping Leviathan's runtime integrations.</sub>
</td>
</tr>
</table>

<br>

<sub>Open-source references matter. Leviathan remains independently designed, maintained and evolved under its own protocol identity.</sub>

<br><br>

<sub>Not a simple addon. Not a simple scraper. An operational layer built to push Stremio beyond default behavior.</sub>

<br>

<img src="https://capsule-render.vercel.app/api?type=waving&color=0:00E0FF,100:0d1117&height=100&section=footer" width="100%" />

</div>
