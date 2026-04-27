<div align="center">

<img src="https://i.ibb.co/MbmdvP6/file-0000000018387243a2da8535139f6423.png" alt="Leviathan Logo" width="250" />

# LEVIATHAN

### Italy-First Aggregation Protocol for Stremio

<img src="https://capsule-render.vercel.app/api?type=rect&color=0:0b1220,50:00d8ff,100:0b1220&height=2&section=header" width="82%" />

<p align="center">
  <b>Leviathan</b> è un motore di aggregazione progettato per unire <b>torrent intelligence</b>, <b>web extraction</b>, <b>routing adattivo</b>, <b>Debrid cloud awareness</b> e <b>presentazione premium dei risultati</b> in un’unica pipeline costruita per Stremio.<br>
  L’obiettivo non è soltanto trovare release: è restituire output <b>più puliti</b>, <b>più coerenti</b>, <b>più rapidi</b> e davvero <b>più leggibili</b>.
</p>

<br>

<p align="center">
  <img src="https://img.shields.io/badge/Node.js-20.19--24.x-339933?style=for-the-badge&logo=nodedotjs&logoColor=white" />
  <img src="https://img.shields.io/badge/Architecture-Hypermode-7c3aed?style=for-the-badge&logo=dependabot&logoColor=white" />
  <img src="https://img.shields.io/badge/Status-Operational-00eaff?style=for-the-badge&logo=githubactions&logoColor=081018" />
</p>

<p align="center">
  <img src="https://img.shields.io/badge/RealDebrid-Native-a8bfff?style=for-the-badge" />
  <img src="https://img.shields.io/badge/TorBox-Ready-7A4EE3?style=for-the-badge" />
  <img src="https://img.shields.io/badge/Saved_Cloud-RD_%2B_TorBox-00E7FF?style=for-the-badge" />
  <img src="https://img.shields.io/badge/P2P-Direct_Swarm-ff0055?style=for-the-badge&logo=qbittorrent&logoColor=white" />
</p>

<p align="center">
  <img src="https://img.shields.io/badge/Semantic-Validation-00eaff?style=flat-square&labelColor=061018" />
  <img src="https://img.shields.io/badge/Adaptive-Latency_Routing-00eaff?style=flat-square&labelColor=061018" />
  <img src="https://img.shields.io/badge/Hybrid-Delivery-00eaff?style=flat-square&labelColor=061018" />
  <img src="https://img.shields.io/badge/Shared_Cache-Volatility--Aware-00eaff?style=flat-square&labelColor=061018" />
  <img src="https://img.shields.io/badge/Cloud_Dedupe-Always_On-00eaff?style=flat-square&labelColor=061018" />
  <img src="https://img.shields.io/badge/Language-ITA_%7C_ENG_%7C_Hybrid-00eaff?style=flat-square&labelColor=061018" />
  <img src="https://img.shields.io/badge/Kitsu-Anime_Ready-00eaff?style=flat-square&labelColor=061018" />
</p>

<br>

<a href="https://leviathanaddon.dpdns.org" target="_blank">
  <img alt="Installa Leviathan" src="https://img.shields.io/badge/INSTALLA-LEVIATHAN-00E7FF?style=for-the-badge&labelColor=07111f&color=00E7FF&logo=stremio&logoColor=ffffff" />
</a>

<br>

<p align="center">
  <sub>Instant setup · Public instance · Premium output layer · RD/TorBox Saved Cloud</sub>
</p>

<br>

<table align="center">
<tr>
<td align="center"><b>ENGINE</b><br><code>v3.1</code></td>
<td align="center"><b>MODE</b><br><code>HYBRID</code></td>
<td align="center"><b>SCOPE</b><br><code>ITA-FIRST</code></td>
<td align="center"><b>CLOUD</b><br><code>RD/TB</code></td>
<td align="center"><b>OUTPUT</b><br><code>PREMIUM</code></td>
</tr>
</table>

</div>

---

<div align="center">

## ⚡ Executive Overview

> **Leviathan non è un semplice addon.**  
> È un layer operativo progettato per aggregare, filtrare, ordinare e presentare risultati con una logica più vicina a un protocollo che a uno scraper tradizionale.

<p align="center">
Il progetto nasce per offrire una base tecnica capace di unire <b>sorgenti torrent</b>, <b>provider web</b>, <b>moduli ibridi</b> e, ora, anche un <b>Saved Cloud Layer</b> opzionale per <b>Real-Debrid</b> e <b>TorBox</b>. Leviathan riduce il rumore nei risultati, migliora il matching semantico, mantiene una latenza percepita aggressiva, applica <b>cache intelligence adattiva</b> e restituisce output leggibili e pronti all’uso in ambiente Stremio.
</p>

<p align="center">
La nuova logica cloud non sostituisce la pipeline principale: la potenzia. Se l’utente ha già un file salvato nel proprio cloud RD/TorBox, Leviathan può riconoscerlo, marcarlo visivamente e, quando non è già presente tra i risultati normali, aggiungerlo come stream dedicato senza creare duplicati inutili.
</p>

</div>

---

<div align="center">

<div align="center">

## ☁️ Debrid Saved Cloud

<table align="center">
<tr>
<td align="center" width="100%">

### RD/TorBox cloud-aware · opzionale · zero duplicati

<p align="center">
Il <b>Debrid Saved Cloud</b> è un layer opzionale che controlla i file già salvati nel cloud personale dell’utente su <b>Real-Debrid</b> o <b>TorBox</b> e li integra nella lista stream di Leviathan senza creare doppioni.
</p>

<p align="center">
La pipeline normale resta invariata: Leviathan cerca prima torrent, cache, provider esterni e risultati web. Dopo il ranking, se il Cloud è attivo, confronta i file salvati con titolo, anno, stagione, episodio, anime/episodio assoluto e filtri lingua/qualità.
</p>

<br>

<table align="center">
<tr><th>Funzione</th><th>Comportamento</th></tr>
<tr><td align="center"><b>Servizi</b></td><td align="center">Solo <b>Real-Debrid</b> e <b>TorBox</b>.</td></tr>
<tr><td align="center"><b>Attivazione</b></td><td align="center">Toggle dedicato su configuratore desktop e <code>smartphone.js</code>.</td></tr>
<tr><td align="center"><b>Modalità</b></td><td align="center"><code>smart</code>, <code>fallback</code>, <code>always</code>. In <code>always</code> il cloud viene controllato sempre, ma i duplicati restano esclusi.</td></tr>
<tr><td align="center"><b>Dedupe</b></td><td align="center">Lo stesso hash non viene mai mostrato due volte. Se un torrent normale è anche nel cloud, viene solo marcato come cloud salvato.</td></tr>
<tr><td align="center"><b>Formatter</b></td><td align="center">Gli stream cloud usano la nuvola al posto del fulmine: <code>☁️ RD</code> / <code>☁️ TB</code> e label <code>CLOUD SALVATO</code>.</td></tr>
<tr><td align="center"><b>Playback</b></td><td align="center">Route dedicate <code>/play_saved_cloud/rd/...</code> e <code>/play_saved_cloud/tb/...</code>, senza cancellare torrent e senza aggiungere magnet duplicati.</td></tr>
<tr><td align="center"><b>Debug</b></td><td align="center">Log <code>[SAVED CLOUD]</code> per gate, skip, scan, duplicate upgrade e stream aggiunti.</td></tr>
</table>

<br>

<p align="center">
  <img src="https://img.shields.io/badge/SAVED_CLOUD-RD_%2B_TORBOX-00eaff?style=for-the-badge&labelColor=061018" />
  <img src="https://img.shields.io/badge/DEDUPLICATION-ALWAYS_ON-7c3aed?style=for-the-badge&labelColor=061018" />
  <img src="https://img.shields.io/badge/FORMATTER-%E2%98%81%EF%B8%8F_RD_%7C_%E2%98%81%EF%B8%8F_TB-2ee6a6?style=for-the-badge&labelColor=061018" />
</p>

</td>
</tr>
</table>

</div>

---

## 🈶 Anime & Kitsu Intelligence

<table align="center">
<tr>
<td align="center" width="100%">

### Mapping anime-first · Kitsu-aware · collision control

<p align="center">
<b>Leviathan</b> integra una logica dedicata per contenuti <b>anime</b> e flussi <b>Kitsu-based</b>, con una pipeline costruita per ridurre mismatch tra <b>stagioni</b>, <b>episodi assoluti</b>, <b>numerazione reale</b> e titoli ambigui.
</p>

<p align="center">
Questo permette al protocollo di trattare meglio serie come <b>One Piece</b>, <b>Jujutsu Kaisen</b> e altri anime con naming complesso, distinguendo in modo più credibile tra <b>anime canonico</b>, <b>live action</b>, release pack, stagioni esplicite e risultati semanticamente simili ma sbagliati.
</p>

<p align="center">
La logica combina <b>matching anime-first</b>, <b>contesto Kitsu</b>, <b>controllo stagione/episodio</b>, <b>query più intelligenti</b> e <b>ranking anti-collisione</b>, così da restituire output più coerenti quando il catalogo usa identificatori anime invece dei flussi TV standard.
</p>

<br>

<p align="center">
  <img src="https://img.shields.io/badge/KITSU-AWARE-00eaff?style=for-the-badge&labelColor=061018" />
  <img src="https://img.shields.io/badge/ANIME-FIRST-MATCHING-7c3aed?style=for-the-badge&labelColor=061018" />
  <img src="https://img.shields.io/badge/EPISODE-COLLISION_CONTROL-ff5a7a?style=for-the-badge&labelColor=061018" />
</p>

</td>
</tr>
</table>

</div>

---

<div align="center">

## 🔥 Release Highlights

<table align="center">
<tr>
<td align="center" width="33%"><b>☁️ RD/TorBox Saved Cloud</b><br><sub>Layer opzionale che riconosce i file già salvati, marca i duplicati e usa <code>☁️ RD</code> / <code>☁️ TB</code>.</sub></td>
<td align="center" width="33%"><b>🚀 Core Refactoring</b><br><sub>Motore riorganizzato per maggiore stabilità, leggibilità e tenuta sotto carico.</sub></td>
<td align="center" width="33%"><b>🌐 Web Provider Routing</b><br><sub>Gestione coordinata di StreamingCommunity, GuardaHD, GuardoSerie, AnimeWorld, GuardaFlix e CinemaCity.</sub></td>
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

<div align="center">

## 🧠 Adaptive Cache Intelligence

<table align="center">
<tr>
<td align="center" width="100%">

### Volatility-Aware Shared Cache Policy

<p align="center">
La cache di <b>Leviathan</b> non lavora come un semplice contenitore con TTL fissi. Il protocollo valuta <b>età del contenuto</b>, <b>solidità del matching</b>, <b>qualità effettiva dei risultati</b>, <b>concordanza tra fonti</b> e <b>rischio di congelare uno stato ancora instabile</b>.
</p>

<p align="center">
Questo significa che un contenuto appena uscito non viene trattato come una release ormai assestata: la policy può accorciare il riuso, limitare la scrittura condivisa, favorire micro-cache locali, oppure promuovere in shared solo risultati veramente forti. L’obiettivo è semplice: evitare che output ancora acerbi diventino “verità globale” troppo presto.
</p>

<br>

<table align="center">
<tr><th>Volatility Bucket</th><th>Logica Operativa</th><th>Obiettivo</th></tr>
<tr><td align="center"><b>ULTRA_FRESH</b></td><td align="center">Riuso minimo, shared molto prudente, niente congelamento di risultati deboli.</td><td align="center">Proteggere release appena uscite.</td></tr>
<tr><td align="center"><b>FRESH</b></td><td align="center">TTL corti, revalidation più frequente, scrittura condivisa solo con segnali credibili.</td><td align="center">Evitare output incompleti o instabili.</td></tr>
<tr><td align="center"><b>SETTLING</b></td><td align="center">Riuso controllato, peso crescente alla qualità reale del risultato.</td><td align="center">Accompagnare la fase di assestamento.</td></tr>
<tr><td align="center"><b>STABLE</b></td><td align="center">Shared cache aggressiva, stale reuse più utile, TTL più estesi.</td><td align="center">Massimizzare velocità e continuità.</td></tr>
</table>

<br>

<p align="center">
La decisione finale non dipende solo dal tempo: dipende anche da <b>confidence score</b>, <b>exact episode match</b>, <b>qualità migliore trovata</b>, <b>presenza di stream già affidabili</b>, <b>validazione pack</b> e penalizzazione dei risultati più fragili o rumorosi. In questo modo la cache diventa parte attiva del motore di ranking, non un semplice strato passivo.
</p>

<p align="center">
<b>Tradotto in pratica:</b> Leviathan accelera quando può, ma evita di condividere troppo presto risultati che rischiano di peggiorare l’esperienza globale. Il Saved Cloud Layer si inserisce dopo la pipeline principale e rispetta questa logica: se la cache serve una lista già stabile, il cloud viene valutato in modo coerente con dedupe e annotazione dei risultati esistenti.
</p>

<p align="center">
  <img src="https://img.shields.io/badge/CACHE-VOLATILITY_AWARE-00eaff?style=for-the-badge&labelColor=061018" />
  <img src="https://img.shields.io/badge/TTL-CONFIDENCE_WEIGHTED-7c3aed?style=for-the-badge&labelColor=061018" />
  <img src="https://img.shields.io/badge/FRESH_RELEASES-PROTECTED-ff5a7a?style=for-the-badge&labelColor=061018" />
</p>

</td>
</tr>
</table>

</div>

---

<div align="center">

## 🔱 Protocol Core

<table align="center">
<tr>
<td align="center" width="100%">

### Un solo blocco operativo, più layer sincronizzati

<p align="center">
<b>Leviathan</b> concentra la propria logica in una pipeline unica che combina <b>validazione semantica Italy-First</b>, <b>routing a latenza adattiva</b>, <b>resilienza contro challenge e nodi degradati</b>, <b>fusione intelligente dei metadati</b>, <b>shared cache volatility-aware</b>, <b>delivery ibrido torrent + web</b> e <b>Saved Cloud Awareness</b> per RD/TorBox.
</p>

<p align="center">
In pratica il protocollo analizza pattern come <code>MULTI</code>, <code>SUB-ITA</code>, <code>AC3</code> e <code>DTS</code>, distingue release realmente italiane da risultati ambigui, riduce i falsi positivi e ordina le sorgenti con priorità più sensate per l’utente finale. Sul piano operativo decide dinamicamente quali provider meritano la corsia veloce e quali richiedono una scansione più profonda, bilanciando velocità, qualità del matching e continuità del flusso.
</p>

<p align="center">
A livello infrastrutturale integra <b>WAF handling</b>, <b>identity rotation</b>, <b>failover automatici</b>, <b>magnet enrichment</b>, un layer ibrido con <b>StreamingCommunity</b>, <b>GuardaHD</b> e <b>GuardoSerie</b>, e un layer cloud opzionale che riconosce i file già salvati dall’utente su <b>Real-Debrid</b> o <b>TorBox</b> senza duplicare la lista stream.
</p>

<p align="center">
Il blocco viene completato da <b>Debrid Ghost Shell</b> per scenari proxy-based, <b>Provider Web dedicati</b> per coprire i percorsi diretti, <b>Polymorphic Formatter Engine</b> per una resa visiva superiore, <b>Linguistic Scope Control</b> per gestire ITA / ENG / Hybrid, <b>Trailer Bridge</b> per le anteprime contestuali e <b>Direct Swarm Access</b> per la riproduzione P2P pura.
</p>

<p align="center">
<b>Risultato finale:</b> un sistema coerente progettato per restituire output <b>più puliti</b>, <b>più rapidi</b>, <b>più credibili</b> e molto più <b>leggibili</b>.
</p>

<br>

<p align="center">
  <img src="https://img.shields.io/badge/ITALIAN_SEMANTICS-STRICT-00eaff?style=for-the-badge&labelColor=061018" />
  <img src="https://img.shields.io/badge/HYBRID_DELIVERY-TORRENT_%2B_WEB-7c3aed?style=for-the-badge&labelColor=061018" />
  <img src="https://img.shields.io/badge/SAVED_CLOUD-RD_%2B_TB-2ee6a6?style=for-the-badge&labelColor=061018" />
  <img src="https://img.shields.io/badge/ADAPTIVE_LATENCY-ROUTING-00c2ff?style=for-the-badge&labelColor=061018" />
</p>

<p align="center">
  <img src="https://img.shields.io/badge/FAILOVER-AUTOMATIC-ff335f?style=flat-square&labelColor=0d1117" />
  <img src="https://img.shields.io/badge/WAF-RESILIENCE-ff9f1a?style=flat-square&labelColor=0d1117" />
  <img src="https://img.shields.io/badge/FORMATTER-POLYMORPHIC-2ee6a6?style=flat-square&labelColor=0d1117" />
  <img src="https://img.shields.io/badge/LANGUAGE-ITA_%7C_ENG_%7C_HYBRID-00eaff?style=flat-square&labelColor=0d1117" />
</p>

</td>
</tr>
</table>

</div>

---

<div align="center">

## 🌐 Leviathan Network Nodes

</div>

<table align="center">
<tr><th>Target Engine</th><th>Region</th><th>Mode</th><th>Priority</th><th>Status</th></tr>
<tr><td align="center"><b>Real-Debrid Saved Cloud</b></td><td align="center">👤 USER</td><td align="center">Cloud Library</td><td align="center">Smart</td><td align="center">🟢</td></tr>
<tr><td align="center"><b>TorBox Saved Cloud</b></td><td align="center">👤 USER</td><td align="center">Cloud Library</td><td align="center">Smart</td><td align="center">🟢</td></tr>
<tr><td align="center"><b>StreamingCommunity</b></td><td align="center">🇮🇹 ITA</td><td align="center">HLS Stream</td><td align="center">Ultra</td><td align="center">🟢</td></tr>
<tr><td align="center"><b>GuardaHD</b></td><td align="center">🇮🇹 ITA</td><td align="center">HLS / MP4</td><td align="center">High</td><td align="center">🟢</td></tr>
<tr><td align="center"><b>GuardoSerie</b></td><td align="center">🇮🇹 ITA</td><td align="center">HLS / MP4</td><td align="center">High</td><td align="center">🟢</td></tr>
<tr><td align="center"><b>AnimeWorld</b></td><td align="center">🇮🇹 ITA</td><td align="center">Anime Provider</td><td align="center">High</td><td align="center">🟢</td></tr>
<tr><td align="center"><b>GuardaFlix</b></td><td align="center">🇮🇹 ITA</td><td align="center">Web Provider</td><td align="center">High</td><td align="center">🟢</td></tr>
<tr><td align="center"><b>CinemaCity</b></td><td align="center">🇮🇹 ITA</td><td align="center">Web Provider</td><td align="center">High</td><td align="center">🟢</td></tr>
<tr><td align="center"><b>Il Corsaro Nero</b></td><td align="center">🇮🇹 ITA</td><td align="center">Torrent Fast Lane</td><td align="center">High</td><td align="center">🟢</td></tr>
<tr><td align="center"><b>Knaben</b></td><td align="center">🌍 GLB</td><td align="center">API JSON</td><td align="center">High</td><td align="center">🟢</td></tr>
<tr><td align="center"><b>The Pirate Bay</b></td><td align="center">🌍 GLB</td><td align="center">API JSON</td><td align="center">High</td><td align="center">🟢</td></tr>
<tr><td align="center"><b>UIndex</b></td><td align="center">🌍 GLB</td><td align="center">Hybrid Aggregator</td><td align="center">Medium</td><td align="center">🟢</td></tr>
<tr><td align="center"><b>SolidTorrents</b></td><td align="center">🌍 GLB</td><td align="center">Hybrid Aggregator</td><td align="center">Medium</td><td align="center">🟢</td></tr>
<tr><td align="center"><b>Nyaa</b></td><td align="center">🇯🇵 JPN</td><td align="center">Deep Scan</td><td align="center">Medium</td><td align="center">🟢</td></tr>
<tr><td align="center"><b>TorrentGalaxy</b></td><td align="center">🌍 GLB</td><td align="center">Deep Scan</td><td align="center">Medium</td><td align="center">🟢</td></tr>
<tr><td align="center"><b>BitSearch</b></td><td align="center">🌍 GLB</td><td align="center">Deep Scan</td><td align="center">Medium</td><td align="center">🟢</td></tr>
<tr><td align="center"><b>LimeTorrents</b></td><td align="center">🌍 GLB</td><td align="center">Deep Scan</td><td align="center">Medium</td><td align="center">🟢</td></tr>
<tr><td align="center"><b>Torrentz2</b></td><td align="center">🌍 GLB</td><td align="center">Deep Scan</td><td align="center">Medium</td><td align="center">🟢</td></tr>
<tr><td align="center"><b>RARBG Mirrors</b></td><td align="center">🌍 GLB</td><td align="center">Mirror Cluster</td><td align="center">Medium</td><td align="center">🟢</td></tr>
<tr><td align="center"><b>1337x</b></td><td align="center">🌍 GLB</td><td align="center">Protected HTML</td><td align="center">Medium</td><td align="center">🟢</td></tr>
</table>

---

<div align="center">

# 🐳 Deployment Protocol

### Leviathan Standalone · Bootstrap Sequence

[![Docker](https://img.shields.io/badge/Docker-Ready-2496ED?style=for-the-badge&logo=docker&logoColor=white)](https://www.docker.com/)
[![Stremio Addon](https://img.shields.io/badge/Stremio-Addon-7cf29c?style=for-the-badge&logo=stremio&logoColor=081018)](https://www.stremio.com/)

</div>

<div align="center">

## Standard Bootstrap

</div>

```bash
git clone https://github.com/LUC4N3X/stremio-leviathan-addon
cd stremio-leviathan-addon
docker compose up -d --build
```

<div align="center">

## Local Endpoint

</div>

```txt
http://localhost:7000
```

---

<div align="center">

## 🧩 File principali del Saved Cloud Layer

</div>

| File | Ruolo |
|---|---|
| `core/stream/debrid_saved_cloud.js` | Scanner e matching dei file cloud RD/TorBox. |
| `core/stream_generator.js` | Innesto del layer cloud nella pipeline stream e gestione dedupe/annotazione. |
| `core/server/routes/playback_routes.js` | Route sicure per riproduzione cloud salvata. |
| `core/config/schema.js` | Normalizzazione config `enableSavedCloud`, `savedCloudMode`, `savedCloudMax`. |
| `debrid/realdebrid.js` | Supporto lettura/risoluzione cloud Real-Debrid. |
| `debrid/torbox.js` | Supporto lettura/risoluzione cloud TorBox. |
| `core/lib/stream_formatter.js` | Formatter principale con badge `☁️` per cloud salvato. |
| `core/lib/pulse_formatter.cjs` | Formatter AIO/Pulse aggiornato per riconoscere cloud salvato. |
| `public/index.html` | Configuratore desktop aggiornato. |
| `public/smartphone.js` | Configuratore mobile aggiornato. |

---

<div align="center">

# ⚠️ Self-Hosting Reality Check

> [!IMPORTANT]
> **Leviathan può essere self-hostato, ma bisogna capire bene cosa significa.**

<p align="center">
L’istanza pubblica del progetto non si limita al solo codice del repository. Parte dell’esperienza reale dipende anche da una componente dati e da una struttura operativa che <b>non è inclusa</b> nel repository open-source.
</p>

### Cosa non è incluso

<p align="center">
<b>Il database della istanza pubblica</b><br>
<b>Eventuali cache pre-costruite lato server</b><br>
<b>L’infrastruttura dati privata usata per ottimizzare i risultati</b><br>
<b>I vantaggi di warm cache, storico e tuning della versione live</b>
</p>

<p align="center">
In altre parole: il repository contiene il motore, ma <b>non l’intero ecosistema operativo</b> della deployment pubblica.
</p>

### Cosa significa in pratica

<p align="center">
In self-hosting, Leviathan deve lavorare in modo più grezzo: più scraping live, meno dati già pronti, più dipendenza dalla qualità della rete, della VPS e delle sorgenti raggiungibili. L’esperienza resta valida per studio e sviluppo, ma non replica il comportamento ottimizzato della live instance.
</p>

<p align="center">
Il <b>Saved Cloud Layer</b> resta comunque utile anche in self-hosting perché dipende dal cloud personale RD/TorBox dell’utente. I risultati cloud non sostituiscono la warm cache pubblica, ma possono compensare alcuni casi in cui l’utente ha già file pronti nel proprio account debrid.
</p>

### Conviene self-hostarlo?

<p align="center">
Per studio, sviluppo, debugging o fork: <b>sì</b>.<br>
Per avere l’esperienza migliore da semplice utente finale: <b>no, nella maggior parte dei casi non conviene</b>.
</p>

</div>

<table align="center">
<tr><th>Scenario</th><th>Consiglio</th></tr>
<tr><td align="center">Vuoi usare Leviathan al meglio</td><td align="center"><b>Usa l’istanza pubblica</b></td></tr>
<tr><td align="center">Vuoi studiare o modificare il codice</td><td align="center"><b>Self-hosting ok</b></td></tr>
<tr><td align="center">Vuoi le stesse performance della live instance</td><td align="center"><b>No</b></td></tr>
<tr><td align="center">Vuoi il database della versione pubblica</td><td align="center"><b>Non è incluso</b></td></tr>
<tr><td align="center">Vuoi vedere i file già salvati nel tuo RD/TorBox</td><td align="center"><b>Attiva Debrid Cloud</b></td></tr>
</table>

---

<div align="center">

## ⚖️ Legal Notice

<img src="https://capsule-render.vercel.app/api?type=rect&color=0:0b1220,50:ff9f1a,100:0b1220&height=2&section=header" width="82%" />

<table align="center">
<tr>
<td align="center" width="100%">

### Framework Neutrality · User Responsibility · No Hosted Content

<p align="center">
<b>Leviathan</b> è distribuito esclusivamente come framework di aggregazione, parsing, normalizzazione e delivery logic. Il progetto <b>non ospita</b>, <b>non archivia</b> e <b>non distribuisce</b> contenuti: processa metadati, routing e risultati provenienti da fonti esterne configurate o interrogate dall’utente.
</p>

<p align="center">
Il Saved Cloud Layer non cambia questa natura: si limita a leggere e riconoscere elementi già presenti nell’account Real-Debrid o TorBox configurato dall’utente. Leviathan non fornisce contenuti, non crea licenze, non concede accesso a materiale di terzi e non sostituisce la responsabilità dell’utente nell’uso dei servizi collegati.
</p>

<p align="center">
L’installazione, la configurazione e l’utilizzo del software avvengono sotto la piena responsabilità dell’utente finale. Ogni decisione relativa a provider, ambiente di esecuzione, rete, credenziali, servizi terzi e conformità normativa resta interamente a carico di chi utilizza il progetto.
</p>

<p align="center">
Il repository viene pubblicato per finalità tecniche, educative e di ricerca: architetture di aggregazione, workflow di parsing, ranking, formatting, interoperabilità tra client e provider, studio di resilienza operativa e sperimentazione su pipeline ibride. Qualsiasi uso improprio, illecito o lesivo di diritti di terzi è estraneo al progetto e ricade esclusivamente sull’utilizzatore finale.
</p>

<p align="center">
<b>In sintesi:</b> il codice fornisce un motore; non fornisce contenuti, non concede licenze su contenuti di terzi e non trasferisce alcuna responsabilità legale dagli utenti ai maintainer del progetto.
</p>

<p align="center">
<sub>Usando, distribuendo o modificando questo repository, l’utente riconosce e accetta integralmente tali condizioni.</sub>
</p>

</td>
</tr>
</table>

</div>

---

<div align="center">

## 🜂 Support the Protocol

<img src="https://capsule-render.vercel.app/api?type=rect&color=0:0b1220,50:00d8ff,100:0b1220&height=2&section=header" width="82%" />

<p align="center">
Leviathan è un progetto open-source costruito con attenzione a qualità del risultato, continuità evolutiva e identità tecnica. Se vuoi sostenere il protocollo, puoi farlo in due modi semplici: <b>supporto diretto</b> e <b>visibilità pubblica</b>.
</p>

<br>

<table align="center">
<tr>
<td align="center" width="50%">

### 💠 Core Support

<p align="center">
Supporto diretto allo sviluppo, alla manutenzione e all’evoluzione del progetto.
</p>

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

<p align="center">
Una valutazione positiva aumenta autorevolezza, fiducia e visibilità del protocollo.
</p>

<a href="https://stremio-addons.net/addons/leviathan" target="_blank">
  <img src="https://img.shields.io/badge/Rate-Leviathan-2ea043?style=for-the-badge&logo=github&logoColor=white&labelColor=0d1117" />
</a>

<br><br>

<a href="https://stremio-addons.net/addons/leviathan" target="_blank">
  <img src="https://capsule-render.vercel.app/api?type=rounded&color=0:34d399,100:16a34a&height=74&section=header&text=Leave%20a%20Star%20%E2%80%A2%20Boost%20the%20Protocol&fontSize=24&fontColor=ffffff&animation=fadeIn&fontAlignY=55" alt="Boost the Protocol" />
</a>

</td>
</tr>
</table>

<p align="center">
<sub>Ogni contributo, piccolo o grande, aiuta Leviathan a restare veloce, solido e in continua evoluzione.</sub>
</p>

</div>

---

<div align="center">

# 🧬 Credits

<img src="https://capsule-render.vercel.app/api?type=waving&color=0:0d1117,100:00E0FF&height=130&section=header&text=Credits&fontSize=40&fontColor=ffffff&animation=fadeIn&fontAlignY=35" width="100%" />

<br><br>

<a href="https://github.com/LUC4N3X">
  <img src="https://github.com/LUC4N3X.png" width="140" alt="Project Lead" />
</a>

<br><br>

## ✦ L U C 4 N 3 X ✦

### Founder · Core Architect · Lead Engineering

<p align="center">
Ideazione, architettura, design del protocollo, integrazione dei moduli core, pipeline di aggregazione, identità del progetto e direzione evolutiva del sistema.
</p>

<p align="center">
  <img src="https://img.shields.io/badge/Protocol-Creator-00eaff?style=for-the-badge&labelColor=0d1117" />
  <img src="https://img.shields.io/badge/Core-Engineering-ffffff?style=for-the-badge&labelColor=0d1117&color=ffffff" />
  <img src="https://img.shields.io/badge/Stremio-Ecosystem-7cf29c?style=for-the-badge&labelColor=0d1117" />
</p>

<p align="center">
<sub>Not a simple addon. Not a simple scraper. An operational layer built to push Stremio beyond default behavior.</sub>
</p>

<img src="https://capsule-render.vercel.app/api?type=waving&color=0:00E0FF,100:0d1117&height=100&section=footer" width="100%" />

</div>
