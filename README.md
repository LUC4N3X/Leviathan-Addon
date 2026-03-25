<div align="center">

<img src="https://i.ibb.co/MbmdvP6/file-0000000018387243a2da8535139f6423.png"
     alt="Leviathan Logo"
     width="220"
     style="border-radius: 28px; filter: drop-shadow(0 0 32px rgba(0, 234, 255, 0.35));" />

<br><br>

<h1 style="
  margin: 0;
  font-size: 5.6rem;
  line-height: 0.95;
  letter-spacing: -4px;
  font-weight: 900;
  text-transform: uppercase;
  font-family: Segoe UI, Roboto, Helvetica, Arial, sans-serif;
  background: linear-gradient(180deg, #ffffff 0%, #c8fbff 35%, #00eaff 100%);
  -webkit-background-clip: text;
  -webkit-text-fill-color: transparent;
  filter: drop-shadow(0 10px 24px rgba(0, 234, 255, 0.25));
">
LEVIATHAN
</h1>

<p style="
  margin-top: 12px;
  font-size: 1.15rem;
  letter-spacing: 2px;
  color: #9fefff;
  text-transform: uppercase;
">
Protocollo di aggregazione ad alte prestazioni
</p>

<p style="
  max-width: 860px;
  margin: 18px auto 0 auto;
  font-size: 1.05rem;
  line-height: 1.8;
  color: #c7d6e2;
">
<b>Leviathan</b> è un motore <b>Italy-First</b> per Stremio, progettato per aggregare sorgenti torrent e web
con un approccio orientato a <b>precisione semantica</b>, <b>bassa latenza</b> e <b>resilienza operativa</b>.
Un’architettura costruita per restituire risultati puliti, coerenti e immediatamente utilizzabili.
</p>

<br>

<p align="center">
  <img src="https://img.shields.io/badge/Node.js-v18_LTS-339933?style=for-the-badge&logo=nodedotjs&logoColor=white" />
  <img src="https://img.shields.io/badge/Architecture-HyperMode-7c3aed?style=for-the-badge&logo=dependabot&logoColor=white" />
  <img src="https://img.shields.io/badge/Status-Operational-00eaff?style=for-the-badge&logo=githubactions&logoColor=081018" />
</p>

<p align="center">
  <img src="https://img.shields.io/badge/RealDebrid-Native-a5bdf8?style=for-the-badge&logoColor=black" />
  <img src="https://img.shields.io/badge/TorBox-Ready-7A4EE3?style=for-the-badge" />
  <img src="https://img.shields.io/badge/P2P-Direct_Swarm-ff0055?style=for-the-badge&logo=qbittorrent&logoColor=white" />
</p>

<p align="center">
  <img src="https://img.shields.io/badge/Adaptive-Latency_Scaling-111827?style=flat-square&labelColor=0b1220&color=00eaff" />
  <img src="https://img.shields.io/badge/Challenge-Handling-111827?style=flat-square&labelColor=0b1220&color=00eaff" />
  <img src="https://img.shields.io/badge/Magnet-Fusion_Engine-111827?style=flat-square&labelColor=0b1220&color=00eaff" />
  <img src="https://img.shields.io/badge/Language-ITA%20%7C%20ENG-111827?style=flat-square&labelColor=0b1220&color=00eaff" />
</p>

<br>

<a href="https://leviathanaddon.dpdns.org" target="_blank">
  <img src="public/button5.svg" width="340" alt="Installa Leviathan" />
</a>

<br><br>

<img src="https://capsule-render.vercel.app/api?type=rect&color=0:061018,100:00E0FF&height=2&section=header" width="72%" />

</div>

---

## ⚡ Executive Overview

> **Leviathan non è uno scraper tradizionale.**  
> È un layer di aggregazione progettato per operare in ambienti eterogenei, distinguendo priorità,
> qualità e pertinenza attraverso una pipeline costruita per essere veloce, stabile e selettiva.

L’obiettivo del progetto è semplice: offrire una base tecnica capace di fondere **sorgenti P2P**, **moduli web**
e **routing intelligente**, restituendo un output ordinato, leggibile e orientato all’uso reale.

### Pillars of the Protocol

- **Precision First** — validazione aggressiva dei risultati per ridurre rumore e mismatch.
- **Latency Aware** — timeout, priorità e fallback costruiti in base al tipo di sorgente.
- **Hybrid Delivery** — fusione di torrent, webstreams e provider dedicati in un unico flusso.
- **Operational Resilience** — gestione challenge, rotazione identità e failover automatici.
- **Stremio-Centric UX** — formatter, label e presentazione risultati pensati per uso immediato.

---

## 🔥 Release Highlights

### 2.7 Core Evolution

- 🚀 **Core Refactoring**  
  Motore riorganizzato per migliorare stabilità, concorrenza e leggibilità architetturale.

- 🌐 **WebStreams Auto-Failover**  
  Attivazione automatica delle sorgenti web quando il layer P2P non restituisce risultati validi.

- 🎨 **Polymorphic Formatter Engine**  
  Output visivo personalizzabile tramite preset o sintassi custom.

- 🗣️ **Tri-Scope Language Control**  
  Modalità dedicate per **ITA**, **ENG** o **Hybrid**.

- 🌪️ **VIX Hybrid Module**  
  Integrazione diretta con moduli web ad avvio rapido.

- 👻 **Ghost Proxy Compatibility**  
  Supporto nativo a MediaFlow per routing protetto e ambienti condivisi.

- 📡 **Direct Swarm Protocol**  
  Riproduzione P2P diretta con approccio ottimizzato per streaming sequenziale.

---

## 🔱 Core Capabilities

### 1. 🇮🇹 ITA-Strict Validation Protocol

Leviathan applica una validazione semantica dei risultati, non una semplice ricerca testuale.

**Obiettivi del layer:**
- riconoscere pattern utili come `MULTI`, `SUB-ITA`, `AC3`, `DTS`
- escludere release sporche, fake o di bassa affidabilità
- ridurre i falsi positivi su titoli italiani e release ibride

**Risultato:** dataset più pulito, ordinato e coerente con il profilo linguistico selezionato.

---

### 2. ⚡ Adaptive Latency Architecture

Ogni sorgente viene trattata in base al proprio profilo operativo.

- **Fast Lane** — per endpoint leggeri, API JSON e indici ottimizzati
- **Deep Scan** — per portali HTML complessi, mirror instabili o ambienti più lenti
- **Timeout Strategy** — bilanciamento tra velocità percepita e completezza dei risultati

Il motore non spreca cicli: prioritizza, osserva e reagisce.

---

### 3. 🛡️ Challenge Handling & Network Resilience

Leviathan include un layer dedicato alla continuità operativa in presenza di protezioni perimetrali.

- gestione challenge lato web
- rotazione controllata delle fingerprint HTTP
- esclusione intelligente dei nodi degradati
- fallback automatici senza interrompere la pipeline

L’obiettivo non è forzare l’ecosistema, ma mantenere il protocollo stabile sotto carico reale.

---

### 4. 🧬 Metadata Fusion & Smart Parsing

Il motore non si limita a raccogliere risultati: li interpreta.

- normalizzazione di formati Stagione/Episodio (`S01E01`, `1x01`, varianti miste)
- fusione metadati per ordinamento e leggibilità
- arricchimento dei magnet per migliorare aggancio peer e consistenza del playback

Questo layer è essenziale per trasformare dati grezzi in stream utilizzabili.

---

### 5. 🌪️ VIX Hybrid Layer

Leviathan include un modulo ibrido dedicato a sorgenti web ad avvio rapido.

**Funzioni principali:**
- estrazione diretta di flussi HLS
- fallback immediato quando il layer torrent non è sufficiente
- avvio quasi istantaneo senza dipendenza dal seed state

Un ponte tra velocità del web e flessibilità dell’ecosistema Stremio.

---

### 6. 🦁 GuardaHD Integration Layer

Modulo web dedicato a contenuti ITA-first.

- estrazione diretta di stream HLS / MP4 dai player embedded
- validazione lingua/audio in linea con il profilo richiesto
- risoluzione multi-player
- priorità alta nel web fallback chain

Pensato per fornire una seconda linea rapida, coerente e pulita.

---

### 7. 🍿 GuardaSerie Integration Layer

Sorgente specializzata per il dominio Serie TV.

- resolver nativo Stagione/Episodio
- estrazione stream web diretta
- filtro linguistico rigido
- comportamento ottimizzato per cataloghi seriali ITA

Una corsia preferenziale per episodi e cataloghi episodici.

---

### 8. 👻 Debrid Ghost Shell

Compatibilità con infrastrutture proxy-based per scenari multi-utente o routing dedicato.

- masking del traffico verso servizi esterni
- supporto a configurazioni shared-account
- mitigazione dei problemi legati a IP binding e throttling di rete

Questo layer estende la flessibilità operativa del protocollo.

---

### 9. 🕷️ WebStreams Auto-Failover

Leviathan non si blocca su un singolo paradigma di erogazione.

Se la scansione torrent non produce risultati validi:
1. rileva il fallimento utile
2. attiva la catena web
3. restituisce alternative immediate senza interrompere l’esperienza

**Default:** attivo  
**Behavior:** configurabile

---

### 10. 🎨 Polymorphic Formatter Engine

La presentazione dei risultati è parte dell’architettura, non un dettaglio.

- preset grafici multipli
- sintassi custom
- label leggibili e orientate alla scelta rapida
- output disegnato per integrarsi bene nel contesto Stremio

Il formatter trasforma il risultato tecnico in un’esperienza visiva coerente.

---

### 11. 🗣️ Linguistic Scope Control

Tre perimetri di ricerca distinti:

- **ITA Strict** — solo risultati italiani o semanticamente compatibili
- **ENG** — output internazionale senza filtro italiano
- **Hybrid** — priorità ITA con estensione controllata ENG

Questa logica consente di adattare Leviathan a contesti diversi senza snaturare il motore.

---

### 12. 🎬 Trailer Bridge

Recupero rapido di contenuti preview tramite metadati del titolo selezionato.

- integrazione con trailer esterni
- mapping contestuale
- accesso immediato alla preview

---

### 13. 📡 Direct Swarm Access

Leviathan supporta anche un percorso di riproduzione P2P diretto.

- download sequenziale ottimizzato per playback
- supporto DHT / PEX
- maggiore flessibilità in ambienti senza debrid

Un’opzione pensata per chi vuole il controllo completo del layer P2P.

---

## 🌐 Network Matrix

| Target Engine | Region | Mode | Priority | Status |
| :-- | :--: | :--: | :--: | :--: |
| **StreamingCommunity** | 🇮🇹 ITA | HLS Stream | Ultra | 🟢 |
| **GuardaHD** | 🇮🇹 ITA | HLS / MP4 | High | 🟢 |
| **GuardaSerie** | 🇮🇹 ITA | HLS / MP4 | High | 🟢 |
| **Il Corsaro Nero** | 🇮🇹 ITA | Torrent Fast Lane | High | 🟢 |
| **Knaben** | 🌍 GLB | API JSON | High | 🟢 |
| **The Pirate Bay** | 🌍 GLB | API JSON | High | 🟢 |
| **UIndex** | 🌍 GLB | Hybrid Aggregator | Medium | 🟢 |
| **SolidTorrents** | 🌍 GLB | Hybrid Aggregator | Medium | 🟢 |
| **Nyaa** | 🇯🇵 JPN | Deep Scan | Medium | 🟢 |
| **TorrentGalaxy** | 🌍 GLB | Deep Scan | Medium | 🟢 |
| **BitSearch** | 🌍 GLB | Deep Scan | Medium | 🟢 |
| **LimeTorrents** | 🌍 GLB | Deep Scan | Medium | 🟢 |
| **Torrentz2** | 🌍 GLB | Deep Scan | Medium | 🟢 |
| **RARBG Mirrors** | 🌍 GLB | Mirror Cluster | Medium | 🟢 |
| **1337x** | 🌍 GLB | Protected HTML | Medium | 🟢 |

---

# 🐳 Deployment Protocol

<div align="center">

### Leviathan Standalone · Standard Bootstrap Sequence

[![Docker](https://img.shields.io/badge/Docker-Ready-2496ED?style=for-the-badge&logo=docker&logoColor=white)](https://www.docker.com/)
[![Stremio Addon](https://img.shields.io/badge/Stremio-Addon-7cf29c?style=for-the-badge&logo=stremio&logoColor=081018)](https://www.stremio.com/)

</div>

<br>

> [!IMPORTANT]
> **Self-hosting mode**  
> Eseguendo Leviathan in locale opererai in modalità standalone.  
> Eventuali componenti proprietarie o dataset lato istanza pubblica non fanno parte del repository open-source.

### Bootstrap

```bash
git clone https://github.com/LUC4N3X/stremio-leviathan-addon
cd stremio-leviathan-addon
docker compose up -d --build
