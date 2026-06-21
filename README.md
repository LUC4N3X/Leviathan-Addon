<div align="center">

  <a href="https://leviathanaddon.dpdns.org" target="_blank">
    <img src="public/logo.png" alt="Leviathan Logo" width="132" />
  </a>

  <h1>LEVIATHAN</h1>

  <p>
    <strong>ITA-first / ENG-ready stream intelligence layer for Stremio</strong>
  </p>

  <p>
    <a href="https://leviathanaddon.dpdns.org" target="_blank">
      <img alt="Install Leviathan" src="https://img.shields.io/badge/Install-Leviathan-00E7FF?style=for-the-badge&labelColor=07111F" />
    </a>
    <img alt="Stremio Addon" src="https://img.shields.io/badge/Stremio-Native_Addon-7C3AED?style=for-the-badge&labelColor=07111F" />
    <img alt="RD TorBox" src="https://img.shields.io/badge/RD_/_TorBox-Cloud_Aware-2EE6A6?style=for-the-badge&labelColor=07111F" />
    <img alt="Kraken Ready" src="https://img.shields.io/badge/Kraken-Runtime_Ready-93A8FF?style=for-the-badge&labelColor=07111F" />
  </p>

  <p>
    <b>Leviathan searches, normalizes, ranks, deduplicates, and formats streams through a clean Stremio pipeline.</b><br>
    Built around semantic matching, ITA-first ranking, saved-cloud awareness, anime logic, adaptive cache, and runtime handoff.
  </p>

  <sub>
    Semantic Core · ITA-first · RD/TorBox Cloud · Kitsu-aware Anime · Async Track Intelligence · Kraken Runtime
  </sub>

</div>

---

## Overview

Leviathan is not a simple scraper and not a simple source list. It is an aggregation engine designed to return cleaner Stremio results with less noise, fewer duplicates, and stronger matching.

It combines torrent engines, web providers, anime sources, saved-cloud checks, runtime routing, and formatting rules into one controlled pipeline.

```text
Stremio request
→ metadata normalization
→ torrent / provider / cloud discovery
→ semantic matching
→ deduplication
→ ranking
→ formatter
→ clean stream output
```

---

## Core Features

| Layer | Purpose |
| --- | --- |
| **Semantic Core** | Matches title, year, season, episode, anime context, release patterns, language, and quality signals. |
| **ITA-first Ranking** | Prioritizes real Italian results while keeping ENG / Hybrid fallback available. |
| **Saved Cloud Layer** | Detects files already present in the user's Real-Debrid or TorBox cloud and avoids duplicate output. |
| **Async Track Intelligence** | Reads real MKV/MP4 audio, subtitle, and codec metadata when direct files are available, then caches the result. |
| **Adaptive Cache** | Handles fresh and stable releases differently instead of blindly freezing weak results. |
| **Kitsu-aware Anime Logic** | Improves anime matching across seasons, absolute episodes, alternative titles, and provider-specific numbering. |
| **Kraken Runtime** | Delegates fragile playback, hoster, bridge, and runtime paths when needed. |

---

## Why It Feels Different

Leviathan does not just add more results. It tries to understand which results are actually useful.

- **Cleaner matching**: similar titles are not enough; context matters.
- **Better language control**: ITA, MULTI, SUB-ITA, ENG, and ambiguous releases are handled separately.
- **Less duplication**: the same content found through multiple layers is collapsed or marked clearly.
- **Smarter cloud handling**: saved RD/TorBox files are integrated without polluting the list.
- **More precise formatting**: the formatter keeps output readable while using stronger metadata when available.

---

## Stream Intelligence

Leviathan ranks streams using a mix of filename analysis, provider signals, debrid/cloud availability, quality detection, and optional track probing.

When a direct MKV/MP4 file is available, the async track layer can verify real media details such as:

```text
Audio:      ITA / ENG / JPN
Subtitles:  ITA / ENG
Video:      HEVC / AVC / AV1
Audio:      AAC / AC3 / EAC3 / DTS
Channels:   stereo / 5.1 / 7.1
```

The stream endpoint stays fast: track probing runs in the background, stores results in cache, and improves future requests without blocking the current response.

---

## Saved Cloud Layer

The Saved Cloud Layer checks files already available in the user's own Real-Debrid or TorBox cloud.

It can work in three modes:

| Mode | Behavior |
| --- | --- |
| **smart** | Uses cloud matches only when they genuinely improve the result. |
| **fallback** | Uses cloud mainly when the main pipeline is weak or empty. |
| **always** | Always checks cloud while still avoiding duplicate output. |

Cloud streams can be marked as:

```text
☁️ RD
☁️ TB
```

Dedicated playback routes may be used for saved-cloud files:

```text
/play_saved_cloud/rd/...
/play_saved_cloud/tb/...
```

---

## Anime Intelligence

Leviathan includes anime-specific matching to reduce season, episode, absolute-numbering, and title-collision issues.

Useful cases include long-running anime, specials, alternative titles, mixed numbering, and provider-specific episode formats.

Supported anime-oriented sources and flows include:

- AnimeWorld
- AnimeUnity
- AnimeSaturn
- Nyaa
- SubsPlease
- Kitsu-aware eligibility

---

## Kraken Runtime

Kraken is the recommended companion runtime for advanced flows.

It can be used for fragile routes involving redirects, embeds, required headers, hoster extraction, MediaFlow-compatible handoff, and remote/local runtime execution.

Typical configuration:

```env
KRAKEN_URL=https://your-kraken-instance.example
KRAKEN_API_PASSWORD=your_password
FORWARD_PROXY=https://your-kraken-instance.example/forward
```

Leviathan remains focused on discovery, ranking, deduplication, and formatting; Kraken handles runtime-sensitive paths when enabled.

---

## Provider Map

| Area | Sources |
| --- | --- |
| **Cloud / Bridges** | Real-Debrid, TorBox, Torrentio, MediaFusion |
| **Web Providers** | StreamingCommunity, GuardaHD, GuardoSerie, GuardaFlix, Eurostreaming, ToonItalia, OnlineSerieTV |
| **Anime** | AnimeWorld, AnimeUnity, AnimeSaturn, Nyaa, SubsPlease |
| **Torrent Engines** | Il Corsaro Nero, Knaben, TPB mirror, 1337x, BitSearch, LimeTorrents, RARBG, UIndex |
| **Hosters** | VixCloud/VixSrc, VOE, VidGuard/listeamed, MixDrop, SuperVideo, StreamTape, UpStream, Uqload, Vidoza, Dropload, LoadM, DeltaBit, MaxStream/UPROT |

Providers are not blindly enabled in every context. Anime sources, movie-oriented sources, fallback bridges, and experimental providers are scoped to the request type and current configuration.

---

## Deployment

<div align="center">
  <img src="https://img.shields.io/badge/Docker-Ready-2496ED?style=for-the-badge&logo=docker&logoColor=white" />
  <img src="https://img.shields.io/badge/Stremio-Addon-7C3AED?style=for-the-badge&logo=stremio&logoColor=white" />
</div>

```bash
git clone https://github.com/LUC4N3X/stremio-leviathan-addon
cd stremio-leviathan-addon
docker compose up -d --build
```

Local endpoint:

```text
http://localhost:7000
```

Recommended setup:

- start with the default configuration;
- enable ITA-first when Italian results are the priority;
- use Hybrid mode only when ENG fallback is useful;
- connect Real-Debrid or TorBox for saved-cloud discovery;
- enable Kraken only for advanced provider/runtime flows;
- avoid enabling every experimental provider unless testing.

---

## Important Files

<details>
<summary><b>Core Pipeline</b></summary>

- `core/stream_generator.js`
- `core/lib/stream_formatter.js`
- `core/ranking/quality_intelligence.js`
- `core/ranking/torrent_intelligence.js`
- `core/intelligence/track_intelligence.js`
- `core/cache/raw_stream_cache.js`

</details>

<details>
<summary><b>Cloud / Debrid</b></summary>

- `core/stream/debrid_saved_cloud.js`
- `debrid/realdebrid.js`
- `debrid/torbox.js`
- `core/server/routes/playback_routes.js`

</details>

<details>
<summary><b>Providers / Bridges</b></summary>

- `providers/engines.js`
- `providers/extractors/provider_registry.js`
- `core/nexus-bridge/torrentio.js`
- `core/nexus-bridge/mediafusion.js`
- `providers/extractors/hosters/`

</details>

<details>
<summary><b>Configurators</b></summary>

- `public/index.html`
- `public/smartphone.js`
- `core/config/schema.js`

</details>

---

## Self-Hosting Note

> [!IMPORTANT]
> Leviathan can be self-hosted, but the public instance may have operational advantages not included in the repository, such as warm caches, tuned infrastructure, database history, and live-instance configuration.

The repository is useful for study, development, and personal deployment. Self-hosted instances may require more provider configuration, more live fetching, and more operational care.

---

## Legal & Usage Notice

> [!IMPORTANT]
> Leviathan is a technical framework for aggregation, parsing, normalization, ranking, formatting, and routing. It does not host, store, sell, or distribute media content.

Use of the project, configured providers, external services, bridges, resolvers, cloud layers, and companion components is entirely the responsibility of the end user.

Anyone who installs, modifies, distributes, or uses Leviathan must comply with applicable laws, third-party rights, provider terms, licenses, and connected-service rules.

The Saved Cloud Layer only recognizes items already present in the Real-Debrid or TorBox accounts configured by the user.

<sub>This notice does not constitute legal advice.</sub>

---

<div align="center">

  <img src="https://capsule-render.vercel.app/api?type=waving&color=0:07111F,25:00E7FF,50:7C3AED,75:00BFFF,100:07111F&height=96&section=header&text=Credits&fontSize=38&fontColor=FFFFFF&animation=fadeIn&fontAlignY=36" width="100%" alt="Credits" />

  <a href="https://github.com/LUC4N3X" target="_blank">
    <img src="https://i.ibb.co/BK2VQxGH/github-circle-transparent.png" width="142" alt="LUC4N3X" />
  </a>

  <br>

  <img src="https://capsule-render.vercel.app/api?type=transparent&height=54&section=header&text=%E2%9C%A6%20L%20U%20C%204%20N%203%20X%20%E2%9C%A6&fontSize=29&fontColor=FFFFFF&animation=fadeIn&fontAlignY=50" width="72%" alt="LUC4N3X" />

  <h3>Founder · Core Architect · Lead Engineering</h3>

  <p>
    <b>Concept, architecture, identity, and technical direction of Leviathan.</b><br>
    Aggregation pipeline, protocol design, module integration, runtime strategy, and project evolution.
  </p>

  <img src="https://img.shields.io/badge/Protocol-Creator-00E7FF?style=for-the-badge&labelColor=07111F" />
  <img src="https://img.shields.io/badge/Core-Engineering-FFFFFF?style=for-the-badge&labelColor=07111F&color=FFFFFF" />
  <img src="https://img.shields.io/badge/Stremio-Ecosystem-7CF29C?style=for-the-badge&labelColor=07111F" />

  <br><br>

  <p>
    Special thanks to <b>MammaMia</b> and <b>MediaFlow Proxy</b> for open-source ideas and technical references that helped shape parts of Leviathan's provider and runtime strategy.
  </p>

  <b>Not a simple addon. Not a simple scraper.</b><br>
  <sub>A focused stream intelligence layer built for cleaner Stremio output.</sub>

  <br><br>

  <img src="https://capsule-render.vercel.app/api?type=waving&color=0:07111F,25:00E7FF,50:7C3AED,75:00BFFF,100:07111F&height=82&section=footer&animation=fadeIn" width="100%" alt="Credits footer" />

</div>
