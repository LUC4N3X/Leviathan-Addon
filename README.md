<div align="center">
  <br>
  <img alt="Leviathan Banner" src="https://capsule-render.vercel.app/api?type=waving&color=0:0b1220,50:00d8ff,100:0b1220&height=200&section=header&text=LEVIATHAN&fontSize=72&fontColor=ffffff&animation=fadeIn&fontAlignY=38&desc=Italy-First%20Aggregation%20Protocol%20for%20Stremio&descSize=22&descAlignY=58&descColor=00eaff" width="100%"/>
</div>

<div align="center">
  <p>
    <b>Leviathan</b> non è un addon. È un protocollo operativo che fonde <i>torrent intelligence</i>, <i>web extraction</i>, <i>routing adattivo</i>, <i>debrid cloud awareness</i> e una <i>premium presentation layer</i> in un’unica pipeline costruita per Stremio.<br>
    L’obiettivo non è solo trovare contenuti: è restituire risultati <b>più puliti, più coerenti, più veloci e molto più leggibili</b>.
  </p>

  <br>

  <a href="https://leviathanaddon.dpdns.org" target="_blank">
    <img alt="Installa Leviathan" src="https://img.shields.io/badge/INSTALLA%20ORALEVIA%20THAN-00E7FF?style=for-the-badge&labelColor=081018&color=00E7FF&logo=stremio&logoColor=white&scale=2" width="380" />
  </a>

  <br><br>

  <table>
    <tr>
      <td align="center"><b>ENGINE</b><br><code>v3.1</code></td>
      <td align="center"><b>MODE</b><br><code>HYBRID</code></td>
      <td align="center"><b>SCOPE</b><br><code>ITA‑FIRST</code></td>
      <td align="center"><b>CLOUD</b><br><code>RD / TB</code></td>
      <td align="center"><b>OUTPUT</b><br><code>PREMIUM</code></td>
    </tr>
  </table>

  <br>

  <img src="https://img.shields.io/badge/Node.js-20.19--24.x-339933?style=for-the-badge&logo=nodedotjs&logoColor=white" />
  <img src="https://img.shields.io/badge/Architecture-Hypermode-7c3aed?style=for-the-badge&logo=dependabot&logoColor=white" />
  <img src="https://img.shields.io/badge/Status-Operational-00eaff?style=for-the-badge&logo=githubactions&logoColor=081018" />
  <br>
  <img src="https://img.shields.io/badge/RealDebrid-Native-a8bfff?style=for-the-badge" />
  <img src="https://img.shields.io/badge/TorBox-Ready-7A4EE3?style=for-the-badge" />
  <img src="https://img.shields.io/badge/Saved_Cloud-RD_%2B_TorBox-00E7FF?style=for-the-badge" />
  <img src="https://img.shields.io/badge/P2P-Direct_Swarm-ff0055?style=for-the-badge&logo=qbittorrent&logoColor=white" />
</div>

<div align="center">
  <img src="https://capsule-render.vercel.app/api?type=rect&color=0:0b1220,50:00d8ff,100:0b1220&height=3&section=header" width="70%" />
</div>

<div align="center">

## ⚡ Executive Overview

> **Leviathan è un layer operativo che va oltre il classico scraping.**  
> Integra sourcing torrent, provider web, moduli ibridi e un <b>Saved Cloud Layer</b> opzionale per Real‑Debrid e TorBox. Riduce il rumore, migliora il matching semantico, mantiene una latenza percepita aggressiva, applica una **cache intelligence adattiva** e restituisce risultati ottimizzati per l’ecosistema Stremio.

La logica cloud non sostituisce la pipeline principale: la potenzia. Se l’utente ha già file salvati sul proprio cloud RD/TorBox, Leviathan li riconosce, li marca visivamente e li inserisce come stream dedicati **senza duplicati inutili**.

</div>

<div align="center">
  <img src="https://capsule-render.vercel.app/api?type=rect&color=0:0b1220,50:00d8ff,100:0b1220&height=3&section=header" width="70%" />
</div>

<div align="center">

## ☁️ Debrid Saved Cloud

<table>
<tr>
<td align="center" width="100%">

### RD/TorBox cloud‑aware · opzionale · zero duplicati

<p>
Il <b>Debrid Saved Cloud</b> è un layer opzionale che scansiona i file già salvati nel cloud personale dell’utente su <b>Real‑Debrid</b> o <b>TorBox</b> e li integra nella lista stream di Leviathan senza creare doppioni.
</p>

<p>
La pipeline standard non cambia: Leviathan cerca prima torrent, cache, provider esterni e risultati web. Dopo il ranking, se il Cloud è attivo, i file salvati vengono confrontati per titolo, anno, stagione, episodio, anime/episodio assoluto e filtri lingua/qualità.
</p>

<br>

<table>
<tr><th>Funzione</th><th>Comportamento</th></tr>
<tr><td><b>Servizi</b></td><td>Esclusivamente <b>Real‑Debrid</b> e <b>TorBox</b>.</td></tr>
<tr><td><b>Attivazione</b></td><td>Toggle dedicato su configuratore desktop e <code>smartphone.js</code>.</td></tr>
<tr><td><b>Modalità</b></td><td><code>smart</code>, <code>fallback</code>, <code>always</code>. In <code>always</code> il cloud viene sempre controllato, ma i duplicati restano esclusi.</td></tr>
<tr><td><b>Dedupe</b></td><td>Lo stesso hash non appare mai due volte. Se un torrent normale è anche nel cloud, viene solo marcato come «cloud salvato».</td></tr>
<tr><td><b>Formatter</b></td><td>Stream cloud con nuvola al posto del fulmine: <code>☁️ RD</code> / <code>☁️ TB</code> e label <code>CLOUD SALVATO</code>.</td></tr>
<tr><td><b>Playback</b></td><td>Route dedicate <code>/play_saved_cloud/rd/...</code> e <code>/play_saved_cloud/tb/...</code>, senza cancellare torrent né aggiungere magnet duplicati.</td></tr>
<tr><td><b>Debug</b></td><td>Log <code>[SAVED CLOUD]</code> per gate, skip, scan, duplicate upgrade e stream aggiunti.</td></tr>
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

<div align="center">
  <img src="https://capsule-render.vercel.app/api?type=rect&color=0:0b1220,50:00d8ff,100:0b1220&height=3&section=header" width="70%" />
</div>

<div align="center">

## 🈶 Anime & Kitsu Intelligence

<table>
<tr>
<td align="center" width="100%">

### Mapping anime‑first · Kitsu‑aware · collision control

<p>
<b>Leviathan</b> integra una logica dedicata per contenuti <b>anime</b> e flussi <b>Kitsu‑based</b>, con una pipeline costruita per ridurre mismatch tra <b>stagioni</b>, <b>episodi assoluti</b>, <b>numerazione reale</b> e titoli ambigui.
</p>

<p>
Questo permette di trattare meglio serie come <b>One Piece</b>, <b>Jujutsu Kaisen</b> e altri anime con naming complesso, distinguendo in modo più credibile tra <b>anime canonico</b>, <b>live action</b>, release pack, stagioni esplicite e risultati semanticamente simili ma sbagliati.
</p>

<p>
La logica combina <b>matching anime‑first</b>, <b>contesto Kitsu</b>, <b>controllo stagione/episodio</b>, <b>query più intelligenti</b> e <b>ranking anti‑collisione</b>. Il layer anime è allineato ai provider realmente registrati nel codice: <b>AnimeWorld</b>, <b>AnimeUnity</b>, <b>AnimeSaturn</b>, più gli engine torrent anime <b>Nyaa</b> e <b>SubsPlease</b>.
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

<div align="center">
  <img src="https://capsule-render.vercel.app/api?type=rect&color=0:0b1220,50:00d8ff,100:0b1220&height=3&section=header" width="70%" />
</div>

<div align="center">

## 🔥 Release Highlights

<table>
<tr>
<td width="33%"><b>☁️ RD/TorBox Saved Cloud</b><br><sub>Layer opzionale che riconosce file già salvati, marca i duplicati e usa <code>☁️ RD</code> / <code>☁️ TB</code>.</sub></td>
<td width="33%"><b>🚀 Core Refactoring</b><br><sub>Motore riorganizzato per maggiore stabilità, leggibilità e tenuta sotto carico.</sub></td>
<td width="33%"><b>🌐 Web Provider Routing</b><br><sub>Gestione coordinata di StreamingCommunity, CinemaCity, GuardaHD, GuardoSerie, AnimeWorld, AnimeUnity, AnimeSaturn e GuardaFlix.</sub></td>
</tr>
<tr>
<td width="33%"><b>🎨 Polymorphic Formatter</b><br><sub>Rendering più pulito, gerarchico e leggibile dentro Stremio.</sub></td>
<td width="33%"><b>🗣️ Tri‑Scope Language Control</b><br><sub>Modalità dedicate per ITA, ENG e Hybrid.</sub></td>
<td width="33%"><b>🛰️ Adaptive Shared Cache</b><br><sub>TTL e riuso modulati su volatilità, qualità e confidence reale.</sub></td>
</tr>
<tr>
<td width="33%"><b>📡 Direct Swarm Protocol</b><br><sub>Riproduzione P2P diretta per scenari senza debrid.</sub></td>
<td width="33%"><b>🧬 Semantic Matching</b><br><sub>Riduzione dei falsi positivi e ranking più credibile.</sub></td>
<td width="33%"><b>⚙️ Hybrid Delivery Logic</b><br><sub>Passaggio intelligente tra percorso torrent e web quando serve.</sub></td>
</tr>
</table>

</div>

<div align="center">
  <img src="https://capsule-render.vercel.app/api?type=rect&color=0:0b1220,50:00d8ff,100:0b1220&height=3&section=header" width="70%" />
</div>

<div align="center">

## 🧠 Adaptive Cache Intelligence

<table>
<tr>
<td align="center" width="100%">

### Volatility‑Aware Shared Cache Policy

<p>
La cache di <b>Leviathan</b> non è un semplice contenitore con TTL fissi. Il protocollo valuta <b>età del contenuto</b>, <b>solidità del matching</b>, <b>qualità effettiva dei risultati</b>, <b>concordanza tra fonti</b> e <b>rischio di congelare uno stato ancora instabile</b>.
</p>

<p>
Un contenuto appena uscito non viene trattato come una release assestata: la policy può accorciare il riuso, limitare la scrittura condivisa, favorire micro‑cache locali, oppure promuovere in shared solo risultati veramente forti. L’obiettivo è semplice: evitare che output ancora acerbi diventino “verità globale” troppo presto.
</p>

<br>

<table>
<tr><th>Volatility Bucket</th><th>Logica Operativa</th><th>Obiettivo</th></tr>
<tr><td><b>ULTRA_FRESH</b></td><td>Riuso minimo, shared molto prudente, niente congelamento di risultati deboli.</td><td>Proteggere release appena uscite.</td></tr>
<tr><td><b>FRESH</b></td><td>TTL corti, revalidation più frequente, scrittura condivisa solo con segnali credibili.</td><td>Evitare output incompleti o instabili.</td></tr>
<tr><td><b>SETTLING</b></td><td>Riuso controllato, peso crescente alla qualità reale del risultato.</td><td>Accompagnare la fase di assestamento.</td></tr>
<tr><td><b>STABLE</b></td><td>Shared cache aggressiva, stale reuse più utile, TTL più estesi.</td><td>Massimizzare velocità e continuità.</td></tr>
</table>

<br>

<p>
La decisione finale non dipende solo dal tempo: dipende anche da <b>confidence score</b>, <b>exact episode match</b>, <b>qualità migliore trovata</b>, <b>presenza di stream già affidabili</b>, <b>validazione pack</b> e penalizzazione dei risultati più fragili o rumorosi. In questo modo la cache diventa parte attiva del motore di ranking.
</p>

<p>
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

<div align="center">
  <img src="https://capsule-render.vercel.app/api?type=rect&color=0:0b1220,50:00d8ff,100:0b1220&height=3&section=header" width="70%" />
</div>

<div align="center">

## 🔱 Protocol Core

<table>
<tr>
<td align="center" width="100%">

### Un solo blocco operativo, più layer sincronizzati

<p>
<b>Leviathan</b> concentra la propria logica in una pipeline unica che combina <b>validazione semantica Italy‑First</b>, <b>routing a latenza adattiva</b>, <b>resilienza contro challenge e nodi degradati</b>, <b>fusione intelligente dei metadati</b>, <b>shared cache volatility‑aware</b>, <b>delivery ibrido torrent + web</b> e <b>Saved Cloud Awareness</b> per RD/TorBox.
</p>

<p>
Il protocollo analizza pattern come <code>MULTI</code>, <code>SUB‑ITA</code>, <code>AC3</code> e <code>DTS</code>, distingue release realmente italiane da risultati ambigui, riduce i falsi positivi e ordina le sorgenti con priorità più sensate per l’utente finale. Dinamicamente decide quali provider meritano la corsia veloce e quali richiedono una scansione più profonda, bilanciando velocità, qualità del matching e continuità del flusso.
</p>

<p>
A livello infrastrutturale integra <b>WAF handling</b>, <b>identity rotation</b>, <b>failover automatici</b>, <b>magnet enrichment</b>, un layer ibrido con <b>StreamingCommunity</b>, <b>CinemaCity</b>, <b>GuardaHD</b>, <b>GuardoSerie</b>, <b>AnimeWorld</b>, <b>AnimeUnity</b>, <b>AnimeSaturn</b> e <b>GuardaFlix</b>, e un layer cloud opzionale che riconosce i file già salvati dall’utente su <b>Real‑Debrid</b> o <b>TorBox</b> senza duplicare la lista stream.
</p>

<p>
Il blocco viene completato da <b>Debrid Ghost Shell</b> per scenari proxy‑based, <b>Provider Web dedicati</b> e <b>Anime Provider sincronizzati</b> per coprire i percorsi diretti, <b>Polymorphic Formatter Engine</b> per una resa visiva superiore, <b>Linguistic Scope Control</b> per gestire ITA / ENG / Hybrid, <b>Trailer Bridge</b> per le anteprime contestuali e <b>Direct Swarm Access</b> per la riproduzione P2P pura.
</p>

<p>
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

<div align="center">
  <img src="https://capsule-render.vercel.app/api?type=rect&color=0:0b1220,50:00d8ff,100:0b1220&height=3&section=header" width="70%" />
</div>

<div align="center">

## 🌐 Leviathan Network Nodes

### Provider matrix sincronizzata con il codice attuale

<p>Questa tabella è riallineata ai moduli realmente presenti nel progetto: web provider, anime provider, bridge esterni, torrent engine e hoster extractor.</p>

<br>

<table>
<tr><th>Layer</th><th>Provider</th><th>Scope</th><th>Attivazione</th><th>Stato</th></tr>
<tr><td><b>Cloud</b></td><td><b>Real‑Debrid Saved Cloud</b></td><td>👤 USER</td><td><code>enableSavedCloud</code> + RD token</td><td>🟢</td></tr>
<tr><td><b>Cloud</b></td><td><b>TorBox Saved Cloud</b></td><td>👤 USER</td><td><code>enableSavedCloud</code> + TorBox token</td><td>🟢</td></tr>
<tr><td><b>Nexus Bridge</b></td><td><b>Torrentio Main</b></td><td>🌍 GLB</td><td>Bridge esterno opzionale</td><td>🟢</td></tr>
<tr><td><b>Nexus Bridge</b></td><td><b>Torrentio Mirror</b></td><td>🇮🇹 ITA‑aware</td><td>Mirror preferito quando ha hit ITA reali</td><td>🟢</td></tr>
<tr><td><b>Nexus Bridge</b></td><td><b>MediaFusion</b></td><td>🌍 RD‑gated</td><td><code>only_when_torrentio_zero_v3</code></td><td>🟢</td></tr>
<tr><td><b>Web</b></td><td><b>StreamingCommunity</b></td><td>🇮🇹 ITA</td><td><code>enableVix</code> / <code>enableStreamingCommunity</code></td><td>🟢</td></tr>
<tr><td><b>Web</b></td><td><b>CinemaCity</b></td><td>🇮🇹 ITA</td><td><code>enableCc</code></td><td>🟢</td></tr>
<tr><td><b>Web</b></td><td><b>GuardaHD</b></td><td>🇮🇹 ITA</td><td><code>enableGhd</code></td><td>🟢</td></tr>
<tr><td><b>Web</b></td><td><b>GuardoSerie</b></td><td>🇮🇹 ITA</td><td><code>enableGs</code></td><td>🟢</td></tr>
<tr><td><b>Anime Web</b></td><td><b>AnimeWorld</b></td><td>🇮🇹 Anime</td><td><code>enableAnimeWorld</code> + anime/Kitsu eligible</td><td>🟢</td></tr>
<tr><td><b>Anime Web</b></td><td><b>AnimeUnity</b></td><td>🇮🇹 Anime</td><td><code>enableAnimeUnity</code> oppure auto su Kitsu legacy</td><td>🟢</td></tr>
<tr><td><b>Anime Web</b></td><td><b>AnimeSaturn</b></td><td>🇮🇹 Anime</td><td><code>enableAnimeSaturn</code> + anime/Kitsu eligible</td><td>🟢</td></tr>
<tr><td><b>Web</b></td><td><b>GuardaFlix</b></td><td>🇮🇹 Movie</td><td><code>enableGf</code> solo film</td><td>🟢</td></tr>
</table>

<br>

### 🧲 Torrent Engine Layer

<table>
<tr><th>Engine</th><th>Scope</th><th>Mode</th><th>Note operative</th><th>Stato</th></tr>
<tr><td><b>Il Corsaro Nero</b></td><td>🇮🇹 ITA</td><td>Torrent Fast Lane</td><td>Priorità alta per release italiane</td><td>🟢</td></tr>
<tr><td><b>Knaben</b></td><td>🌍 GLB</td><td>API JSON</td><td>Categorie movie/series filtrate</td><td>🟢</td></tr>
<tr><td><b>The Pirate Bay</b></td><td>🌍 GLB</td><td>ApiBay JSON</td><td>Magnet generati da info hash</td><td>🟢</td></tr>
<tr><td><b>TPB Mirror</b></td><td>🌍 GLB</td><td>Mirror HTML</td><td>Fallback mirror separato</td><td>🟢</td></tr>
<tr><td><b>1337x</b></td><td>🌍 GLB</td><td>Protected JSON/HTML</td><td>Parsing con filtri anti‑rumore</td><td>🟢</td></tr>
<tr><td><b>BitSearch</b></td><td>🌍 GLB</td><td>API Search</td><td>Hash magnet diretto</td><td>🟢</td></tr>
<tr><td><b>LimeTorrents</b></td><td>🌍 GLB</td><td>Deep Scan</td><td>Query variant limitate</td><td>🟢</td></tr>
<tr><td><b>RARBG</b></td><td>🌍 GLB</td><td>Mirror Cluster</td><td>Fetch dettaglio + magnet extraction</td><td>🟢</td></tr>
<tr><td><b>UIndex</b></td><td>🌍 GLB</td><td>Hybrid Aggregator</td><td>Parsing magnet da risultati HTML</td><td>🟢</td></tr>
<tr><td><b>Nyaa</b></td><td>🇯🇵 Anime</td><td>Anime Torrent</td><td>Attivo solo per contesto anime</td><td>🟢</td></tr>
<tr><td><b>SubsPlease</b></td><td>🇯🇵 Anime</td><td>Anime Release API</td><td>Attivo solo per contesto anime</td><td>🟢</td></tr>
</table>

<br>

### ⛵ Hoster Extractor Layer

<p>Gli hoster sotto non sono provider di ricerca autonomi: sono risolutori usati dai provider web quando una pagina restituisce embed, player o link intermedi.</p>

<table>
<tr><th>Extractor</th><th>Ruolo</th><th>Stato</th></tr>
<tr><td><b>VixCloud</b></td><td>Risoluzione StreamingCommunity / player compatibili</td><td>🟢</td></tr>
<tr><td><b>Mixdrop</b></td><td>Hoster resolver</td><td>🟢</td></tr>
<tr><td><b>SuperVideo</b></td><td>Hoster resolver</td><td>🟢</td></tr>
<tr><td><b>Streamtape</b></td><td>Hoster resolver</td><td>🟢</td></tr>
<tr><td><b>UpStream</b></td><td>Hoster resolver</td><td>🟢</td></tr>
<tr><td><b>Uqload</b></td><td>Hoster resolver</td><td>🟢</td></tr>
<tr><td><b>Vidoza</b></td><td>Hoster resolver</td><td>🟢</td></tr>
<tr><td><b>Dropload</b></td><td>Hoster resolver</td><td>🟢</td></tr>
<tr><td><b>LoadM</b></td><td>Hoster resolver</td><td>🟢</td></tr>
</table>

<br>

### 🧭 Provider Policy Notes

<table>
<tr><th>Policy</th><th>Comportamento</th></tr>
<tr><td><b>Anime eligibility</b></td><td>AnimeWorld, AnimeUnity e AnimeSaturn partono solo su richieste anime/Kitsu compatibili.</td></tr>
<tr><td><b>AnimeUnity legacy auto</b></td><td>Se l’URL installato è vecchio e manca il toggle, AnimeUnity può auto‑attivarsi su Kitsu esplicito.</td></tr>
<tr><td><b>MediaFusion gate</b></td><td>MediaFusion parte solo quando Torrentio non restituisce risultati reali, evitando doppioni e latenza inutile.</td></tr>
<tr><td><b>MediaFusion RD check</b></td><td>Il check cache Real‑Debrid viene applicato a MediaFusion; Torrentio può restare più diretto.</td></tr>
<tr><td><b>GuardaFlix scope</b></td><td>GuardaFlix viene usato per i film e non forza percorsi serie.</td></tr>
</table>

</div>

<div align="center">
  <img src="https://capsule-render.vercel.app/api?type=rect&color=0:0b1220,50:00d8ff,100:0b1220&height=3&section=header" width="70%" />
</div>

<div align="center">

# 🐳 Deployment Protocol

### Leviathan Standalone · Bootstrap Sequence

[![Docker](https://img.shields.io/badge/Docker-Ready-2496ED?style=for-the-badge&logo=docker&logoColor=white)](https://www.docker.com/)
[![Stremio Addon](https://img.shields.io/badge/Stremio-Addon-7cf29c?style=for-the-badge&logo=stremio&logoColor=081018)](https://www.stremio.com/)

<br>

## Standard Bootstrap

```bash
git clone https://github.com/LUC4N3X/stremio-leviathan-addon
cd stremio-leviathan-addon
docker compose up -d --build
