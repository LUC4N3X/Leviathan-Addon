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

## ☁️ Debrid Saved Cloud Layer

<table align="center">
<tr>
<td align="center" width="100%">

### Real-Debrid + TorBox · opzionale · dedupe globale · formatter coerente

<p align="center">
Il <b>Debrid Saved Cloud Layer</b> è una nuova estensione interna della pipeline Leviathan. Quando attivata, controlla i file già presenti nel cloud personale dell’utente su <b>Real-Debrid</b> o <b>TorBox</b> e li confronta con il contenuto richiesto in Stremio.
</p>

<p align="center">
Non è un nuovo scraper esterno, non aggiunge AllDebrid, Premiumize o DebridLink, e non cambia la filosofia del progetto. Rimane tutto concentrato su <b>RD</b> e <b>TorBox</b>, usando la stessa configurazione debrid già scelta dall’utente.
</p>

<br>

<table align="center">
<tr><th>Componente</th><th>Comportamento</th></tr>
<tr><td align="center"><b>Servizi supportati</b></td><td align="center">Solo <b>Real-Debrid</b> e <b>TorBox</b>.</td></tr>
<tr><td align="center"><b>Attivazione</b></td><td align="center">Opzionale dal configuratore desktop e mobile.</td></tr>
<tr><td align="center"><b>Risultati nuovi</b></td><td align="center">Aggiunge stream cloud solo se non sono già presenti nella lista.</td></tr>
<tr><td align="center"><b>Duplicati</b></td><td align="center">Mai aggiunti. Se il file cloud esiste già come torrent normale, viene solo marcato come cloud salvato.</td></tr>
<tr><td align="center"><b>Playback</b></td><td align="center">Usa route dedicate e sicure, senza cancellare torrent e senza aggiungere magnet duplicati.</td></tr>
<tr><td align="center"><b>Formatter</b></td><td align="center">Gli stream cloud usano la <b>nuvola</b> come icona principale: <code>☁️ RD</code> / <code>☁️ TB</code>.</td></tr>
</table>

<br>

<p align="center">
  <img src="https://img.shields.io/badge/SAVED_CLOUD-RD_%2B_TORBOX-00eaff?style=for-the-badge&labelColor=061018" />
  <img src="https://img.shields.io/badge/DEDUPLICATION-ALWAYS_ON-7c3aed?style=for-the-badge&labelColor=061018" />
  <img src="https://img.shields.io/badge/FORMATTER-CLOUD_BADGE-2ee6a6?style=for-the-badge&labelColor=061018" />
</p>

</td>
</tr>
</table>

</div>

---

<div align="center">

## ☁️ Come funziona il Cloud Salvato

</div>

Quando l’utente apre un film, una serie o un anime, Leviathan esegue prima la pipeline normale: metadati, remote indexer, provider esterni, Torrentio/bridge, ranking, filtri, cache e formatter. Dopo questa fase, se la feature è attiva, entra il layer cloud.

Il layer cloud legge i torrent/file già salvati nel servizio debrid configurato e prova a capire se uno di quei file corrisponde al contenuto richiesto. La corrispondenza non è cieca: viene controllato il titolo, l’anno, la stagione, l’episodio, la natura del contenuto e i filtri utente.

### Regole principali

| Regola | Descrizione |
|---|---|
| **Solo RD/TorBox** | La feature resta concentrata su Real-Debrid e TorBox. Nessun altro debrid viene introdotto. |
| **Opt-in** | Di base l’utente decide se attivarla. Non viene forzata. |
| **Dedupe globale** | I duplicati non vengono mai mostrati, neanche in modalità `always`. |
| **Upgrade dei duplicati** | Se un torrent già trovato da Leviathan è anche nel cloud dell’utente, non viene duplicato: viene marcato come `☁️ CLOUD SALVATO`. |
| **Filtri rispettati** | Lingua, qualità, tipo contenuto e matching episodio restano coerenti con la configurazione. |
| **No delete** | La route cloud non cancella torrent dall’account dell’utente. |
| **No magnet doppio** | I file già salvati non vengono riaggiunti come magnet temporanei. |
| **Formatter pulito** | Per gli stream cloud la nuvola sostituisce il fulmine: `☁️ RD` / `☁️ TB`. |

### Perché è utile

Se l’utente ha già un file salvato nel proprio cloud Real-Debrid o TorBox, Leviathan può riconoscerlo e renderlo immediatamente visibile nella lista stream. Questo è utile soprattutto quando:

- il file cloud è già pronto e non richiede nuova selezione;
- il risultato normale esiste, ma l’utente vuole sapere che è già salvato nel proprio cloud;
- il risultato cloud non è presente nei torrent normali e può diventare uno stream aggiuntivo utile;
- il provider esterno è lento, instabile o non trova abbastanza risultati;
- l’utente usa Leviathan come pannello unico per torrent, web provider e cloud debrid.

---

<div align="center">

## 🎛️ Modalità Debrid Cloud

</div>

La configurazione supporta quattro modalità operative.

| Modalità | Comportamento |
|---|---|
| `off` | Cloud salvato disattivato. Nessuna scansione RD/TorBox cloud. |
| `smart` | Modalità consigliata. Aggiunge o marca solo risultati utili, puliti e coerenti. |
| `fallback` | Usa il cloud solo quando Leviathan trova pochi risultati o la pipeline principale non è abbastanza ricca. |
| `always` | Prova sempre a controllare il cloud, ma i duplicati restano esclusi in ogni caso. |

> **Nota importante:** `always` non significa “mostra tutto”.  
> Significa “controlla sempre il cloud”. La regola anti-duplicati resta obbligatoria e non può essere disattivata, perché mostrare due volte lo stesso hash renderebbe la lista inutile.

Esempio configurazione interna:

```json
{
  "service": "rd",
  "filters": {
    "enableSavedCloud": true,
    "savedCloudMode": "smart",
    "savedCloudMax": 6
  }
}
```

---

<div align="center">

## 🧹 Dedupe: nessun duplicato, mai

</div>

La deduplicazione è una regola globale. Leviathan confronta gli hash/infoHash già presenti nella lista stream con quelli trovati nel cloud salvato.

Se il cloud contiene un file nuovo, non presente tra gli stream già generati, Leviathan può aggiungerlo come risultato cloud.

Se invece il cloud contiene lo stesso hash di uno stream già presente, Leviathan non crea una seconda voce. In quel caso aggiorna lo stream esistente aggiungendo il badge cloud.

### Esempio pratico

| Situazione | Risultato |
|---|---|
| Torrent trovato da Torrentio e non presente nel cloud | Rimane normale: `⚡ RD` se cached. |
| Torrent trovato da Torrentio e presente anche nel cloud RD | Non viene duplicato. Diventa `☁️ RD` con label `CLOUD SALVATO • RD`. |
| File presente nel cloud RD ma non trovato dai torrent normali | Viene aggiunto come nuovo stream cloud. |
| File cloud non corrispondente a titolo/anno/episodio | Viene scartato. |
| File cloud in lingua non ammessa dai filtri | Viene scartato. |

Questo comportamento mantiene la lista pulita: l’utente vede più informazioni, ma non più caos.

---

<div align="center">

## 🎨 Formatter Cloud

</div>

Il formatter è stato aggiornato per rendere i file cloud immediatamente riconoscibili e coerenti con il resto dell’interfaccia Leviathan.

### Stream normale cached

```txt
⚡ RD
LEVIATHAN

▶️ Titolo
1080p • WEB • H264
🇮🇹 / 🇬🇧 • audio • size • source
```

### Stream già salvato nel cloud RD

```txt
☁️ RD
LEVIATHAN

☁️ CLOUD SALVATO • RD
▶️ Titolo
1080p • WEB • H264
🇮🇹 / 🇬🇧 • audio • size • source
```

### Stream già salvato nel cloud TorBox

```txt
☁️ TB
LEVIATHAN

☁️ CLOUD SALVATO • TB
▶️ Titolo
1080p • WEB • H264
🇮🇹 / 🇬🇧 • audio • size • source
```

Il cloud salvato usa la nuvola come icona primaria. Non viene più sommato male al fulmine: se uno stream è cloud, la priorità visiva è `☁️`, non `⚡`.

---

<div align="center">

## 🧪 Matching Cloud: film, serie e anime

</div>

Il Saved Cloud Layer non mostra semplicemente tutto quello che trova nel cloud. Ogni candidato viene filtrato e validato.

### Film

Per i film vengono controllati:

- compatibilità titolo;
- anno quando disponibile;
- esclusione di sample, trailer, extra e file troppo piccoli;
- scelta del file video principale in caso di torrent multi-file;
- rispetto dei filtri lingua e qualità.

### Serie TV

Per le serie vengono controllati:

- titolo serie;
- stagione richiesta;
- episodio richiesto;
- pattern `SxxExx`, `1x02`, `E02` e varianti;
- prevenzione di episodi sbagliati o pack non coerenti;
- esclusione di risultati ambigui se non abbastanza sicuri.

### Anime

Per gli anime il layer resta prudente:

- supporta l’episodio assoluto quando utile;
- tiene conto del contesto anime/Kitsu già usato da Leviathan;
- evita di attivare logiche anime sui film normali;
- non forza match deboli solo perché il titolo è simile;
- applica gli stessi filtri lingua per evitare falsi ITA quando il file è solo JP/ENG.

---

<div align="center">

## 📱 Desktop e Smartphone

</div>

La feature è disponibile sia nel configuratore desktop sia nel configuratore mobile.

### Desktop

Nel configuratore principale è disponibile il toggle:

```txt
☁️ Debrid Cloud
```

Da qui l’utente può attivare la scansione dei file salvati e scegliere la modalità operativa.

### Smartphone

Anche `public/smartphone.js` è stato aggiornato. La configurazione mobile include:

- toggle `Debrid Cloud`;
- modalità `SMART`, `FALLBACK`, `ALWAYS`;
- campo `savedCloudMax`;
- protezione per abilitarlo solo quando il servizio è `rd` o `tb` e la API key è presente;
- avviso quando l’utente prova a combinare cloud e P2P in modo non coerente.

Questo evita che da smartphone venga generata una configurazione incompleta o diversa da quella desktop.

---

<div align="center">

## 🛣️ Route Cloud sicure

</div>

Il playback dei file cloud usa route dedicate, separate dalle route standard di risoluzione magnet.

```txt
/:conf/play_saved_cloud/rd/...
/:conf/play_saved_cloud/tb/...
```

Questa separazione serve a proteggere l’account dell’utente:

- non viene cancellato nessun torrent salvato;
- non viene aggiunto un magnet duplicato;
- il link viene risolto quando serve;
- il comportamento resta separato dai torrent temporanei della pipeline standard;
- MediaFlow/proxy possono continuare a essere applicati dal layer di delivery quando configurati.

---

<div align="center">

## 🧾 Log e Debug Saved Cloud

</div>

La feature include log diagnostici dedicati per capire subito se il cloud è attivo, se viene saltato, quanti torrent legge e quanti risultati vengono aggiunti o marcati come duplicati cloud.

Comando consigliato:

```bash
docker compose logs -f | grep -E "SAVED CLOUD|play_saved_cloud|CLOUD SALVATO"
```

Log principali:

| Log | Significato |
|---|---|
| `[SAVED CLOUD] gate` | Dice se la feature è attiva, quale servizio usa, modalità, API key presente, stream già esistenti e limite massimo. |
| `[SAVED CLOUD] skip` | Spiega perché il layer non parte: toggle spento, mode off, key mancante, servizio non supportato, fallback non necessario. |
| `[SAVED CLOUD] lookup start/done` | Inizio/fine scansione cloud. |
| `[SAVED CLOUD] RD scan start/list response/scan done` | Diagnostica specifica Real-Debrid. |
| `[SAVED CLOUD] TB scan start/list response/scan done` | Diagnostica specifica TorBox. |
| `[SAVED CLOUD] duplicate upgrade` | Uno o più stream già esistenti sono stati riconosciuti come presenti nel cloud e marcati con badge `☁️`. |
| `[SAVED CLOUD] added=...` | Numero di stream cloud nuovi aggiunti alla lista. |
| `[SAVED CLOUD] added=0 duplicateAnnotated>0` | Nessun duplicato aggiunto, ma stream già presenti marcati come cloud salvato. |

Esempio utile:

```txt
[SAVED CLOUD] RD scan done | found=0 scanned=90 duplicate_list_hash=3 list_title_no_match=87
[SAVED CLOUD] duplicate upgrade | cloudDuplicates=3 annotated=3
```

Questo significa che Real-Debrid conteneva tre file già salvati, ma Leviathan li aveva già trovati nella pipeline normale. Non vengono mostrati due volte: gli stream esistenti vengono marcati con `☁️ CLOUD SALVATO • RD`.

---

<div align="center">

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
<td align="center" width="33%"><b>☁️ RD/TorBox Saved Cloud</b><br><sub>Mostra e marca i file già salvati nel cloud personale dell’utente.</sub></td>
<td align="center" width="33%"><b>🧹 Cloud Dedupe Globale</b><br><sub>Nessun duplicato viene mostrato, nemmeno in modalità ALWAYS.</sub></td>
<td align="center" width="33%"><b>🎨 Cloud Formatter</b><br><sub>Gli stream cloud usano la nuvola come badge principale: <code>☁️ RD</code> / <code>☁️ TB</code>.</sub></td>
</tr>
<tr>
<td align="center" width="33%"><b>📱 Mobile Config Sync</b><br><sub>Il configuratore smartphone supporta toggle, modalità e limite Cloud.</sub></td>
<td align="center" width="33%"><b>🛣️ Safe Cloud Routes</b><br><sub>Playback cloud separato da magnet temporanei, senza cancellazioni.</sub></td>
<td align="center" width="33%"><b>🧾 Saved Cloud Debug</b><br><sub>Log dedicati per capire gate, skip, scan, duplicate upgrade e risultati aggiunti.</sub></td>
</tr>
<tr>
<td align="center" width="33%"><b>🚀 Core Refactoring</b><br><sub>Motore riorganizzato per maggiore stabilità, leggibilità e tenuta sotto carico.</sub></td>
<td align="center" width="33%"><b>🌐 Web Provider Routing</b><br><sub>Gestione coordinata di StreamingCommunity, GuardaHD, GuardoSerie, AnimeWorld, GuardaFlix e CinemaCity.</sub></td>
<td align="center" width="33%"><b>🎨 Polymorphic Formatter</b><br><sub>Rendering più pulito, gerarchico e leggibile dentro Stremio.</sub></td>
</tr>
<tr>
<td align="center" width="33%"><b>🗣️ Tri-Scope Language Control</b><br><sub>Modalità dedicate per ITA, ENG e Hybrid.</sub></td>
<td align="center" width="33%"><b>🌪️ VIX Hybrid Module</b><br><sub>Integrazione con sorgenti web ad avvio rapido.</sub></td>
<td align="center" width="33%"><b>👻 Ghost Proxy Compatibility</b><br><sub>Supporto MediaFlow e ambienti proxy-based.</sub></td>
</tr>
<tr>
<td align="center" width="33%"><b>📡 Direct Swarm Protocol</b><br><sub>Riproduzione P2P diretta per scenari senza debrid.</sub></td>
<td align="center" width="33%"><b>🧬 Semantic Matching</b><br><sub>Riduzione dei falsi positivi e ranking più credibile.</sub></td>
<td align="center" width="33%"><b>⚙️ Hybrid Delivery Logic</b><br><sub>Passaggio intelligente tra percorso torrent e web quando serve.</sub></td>
</tr>
<tr>
<td align="center" width="33%"><b>🛰️ Adaptive Shared Cache</b><br><sub>Policy dinamica che modula TTL, riuso e scrittura in base a volatilità e stabilità reale del contenuto.</sub></td>
<td align="center" width="33%"><b>🛡️ Fresh Release Protection</b><br><sub>I contenuti appena usciti non vengono “congelati” prematuramente con risultati deboli o incompleti.</sub></td>
<td align="center" width="33%"><b>🎯 Confidence-Weighted Reuse</b><br><sub>La cache pesa qualità, concordanza delle fonti, exact match e solidità del risultato prima di condividere globalmente.</sub></td>
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
