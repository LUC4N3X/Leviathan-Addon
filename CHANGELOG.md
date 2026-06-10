Changelog

This file is managed by Release Please.

"3.2.0" (https://github.com/LUC4N3X/stremio-leviathan-addon/compare/v3.0.0...v3.1.0) - 2026-04-18

Added

- Added a more advanced resilience layer for protected and unstable providers.
- Added improved provider fallback logic between direct requests, proxy forwarding, external resolvers and cached results.
- Added better detection for blocked pages, challenge pages, invalid HTML responses, expired redirects and temporary provider failures.
- Added provider-specific extraction improvements for CB01, Eurostreaming, MaxStream, UPROT and related hosters.
- Added improved hoster normalization for embedded links, redirected pages and alternative streaming mirrors.
- Added improved stream metadata handling with cleaner titles, quality labels, language hints and provider labels.
- Added stronger duplicate filtering across providers, hosters, cached results and external sources.
- Added better safeguards to avoid returning broken, empty, duplicated or misleading stream results.
- Added improved TorBox integration.
- Added improved Real-Debrid integration.
- Added better cached-result handling for Debrid-based streams.
- Added clearer stream separation between provider streams, TorBox streams, Real-Debrid streams and P2P results.
- Added updated release automation files for Release Please.
- Added automatic release PR merge workflow.

Provider Improvements

- Improved CB01 provider handling with better page parsing, link discovery and fallback extraction.
- Improved CB01 stream detection for pages using intermediate redirect layers before reaching the final hoster.
- Improved CB01 compatibility with MaxStream, MixDrop and other embedded hosters.
- Improved MaxStream extraction flow with better URL cleanup, embed detection and fallback handling.
- Improved UPROT handling with stronger support for protected pages and unstable embed responses.
- Improved Eurostreaming extraction with better support for redirect pages, embedded hosters and multi-step link flows.
- Improved Eurostreaming hoster detection for MaxStream, MixDrop, DeltaBit and related mirrors.
- Improved provider reliability when pages return partial HTML, temporary errors, expired redirects or unexpected redirects.
- Improved stream quality selection to prefer cleaner and higher-quality results when available.
- Improved Italian stream detection and labeling, including clearer "ITA" and "SUB-ITA" handling.
- Improved error isolation so a broken provider does not break the full Stremio stream response.
- Improved timeout handling for slow, unstable or temporarily blocked providers.
- Improved request compatibility for providers that are sensitive to missing browser-like metadata.

TorBox Improvements

- Improved TorBox stream resolution and cached-result handling.
- Improved TorBox result filtering to prefer verified and actually cached results.
- Improved TorBox ranking so stronger, cleaner and more relevant streams appear first.
- Improved TorBox metadata normalization for title, season, episode, quality, size and source name.
- Improved TorBox episode matching to reduce wrong-episode results in series.
- Improved TorBox handling for movies, single episodes and pack-based results.
- Improved TorBox stream labels to make cached results easier to recognize inside Stremio.
- Improved TorBox fallback behavior when a cached result is unavailable, incomplete or not suitable for playback.
- Improved TorBox result cleanup to hide weak, unknown, duplicated or misleading entries.
- Improved TorBox response speed by reducing unnecessary checks and avoiding slow paths when possible.
- Improved TorBox integration with the internal stream ranking and deduplication system.
- Improved TorBox handling when external sources return too many noisy results.
- Improved TorBox behavior when cached sources are present but not immediately playable.
- Improved TorBox compatibility with the addon’s Debrid/P2P result separation.

Real-Debrid Improvements

- Improved Real-Debrid stream handling and cached-result selection.
- Improved Real-Debrid audit logic for checking cached and uncached torrent states.
- Improved Real-Debrid result filtering to prefer cached, playable and relevant streams.
- Improved Real-Debrid ranking to prioritize better quality, better matches and cleaner filenames.
- Improved Real-Debrid metadata normalization for title, season, episode, quality, size and release information.
- Improved Real-Debrid episode matching to reduce wrong file selection in packs and multi-episode results.
- Improved Real-Debrid stream labels to make cached Debrid results clearer in Stremio.
- Improved Real-Debrid fallback behavior when cached results are missing or incomplete.
- Improved Real-Debrid cleanup to hide "download", "unknown", duplicated or low-value entries.
- Improved Real-Debrid handling for cached Torrentio-derived results.
- Improved Real-Debrid compatibility with background cache checks and internal stream ranking.
- Improved Real-Debrid response stability when external sources return inconsistent metadata.
- Improved Real-Debrid behavior when only a limited number of valid cached results are available.
- Improved separation between Real-Debrid, TorBox and pure P2P results.

Stream Ranking and Filtering

- Improved stream ordering across providers, TorBox, Real-Debrid and P2P sources.
- Improved quality detection for "4K", "2160p", "1080p", "720p", "WEB-DL", "BluRay", "HDR", "DV" and related tags.
- Improved source cleanup to reduce noisy filenames and unclear labels.
- Improved Italian-language filtering and result prioritization.
- Improved handling of subtitle-only results by labeling them more clearly.
- Improved duplicate detection across same infohash, same hoster, same title and same resolved stream.
- Improved filtering of low-quality, unknown, incomplete or misleading results.
- Improved final Stremio stream list readability.

Changed

- Reworked provider fallback logic to be more tolerant when a source temporarily fails.
- Reworked protected-provider handling to avoid treating challenge pages as valid empty responses.
- Reworked stream generation to better separate provider results from hoster resolver results.
- Reworked Debrid stream handling to better separate TorBox, Real-Debrid and P2P results.
- Reworked TorBox cached-result selection.
- Reworked Real-Debrid cached-result selection.
- Reworked MaxStream and UPROT flows to reduce false negatives.
- Reworked Eurostreaming parsing to better handle changed page structures and redirect chains.
- Reworked CB01 parsing to better support multiple source layouts.
- Updated "manifest.js".
- Updated "package.json" and "package-lock.json".
- Updated GitHub Actions release workflow setup.
- Updated CodeQL workflow configuration.
- Reworked Release Please configuration and manifest files.

Fixed

- Fixed cases where CB01 returned no streams even when valid hoster links were present.
- Fixed cases where MaxStream links were detected but not correctly normalized before extraction.
- Fixed cases where Eurostreaming links were skipped because of intermediate redirect pages.
- Fixed cases where protected provider pages were treated as valid empty pages instead of blocked or challenged responses.
- Fixed duplicate or misleading stream entries caused by repeated hoster mirrors.
- Fixed unstable behavior when a provider returned incomplete HTML or unexpected redirects.
- Fixed several provider parsing edge cases that could cause missing results.
- Fixed inconsistent quality labels on extracted streams.
- Fixed stream titles that were too noisy, incomplete or unclear.
- Fixed TorBox results showing weak, unknown or duplicated entries.
- Fixed TorBox results appearing when they were not strong enough or not properly matched.
- Fixed Real-Debrid results showing "download", "unknown" or low-value entries.
- Fixed Real-Debrid cached results being mixed too aggressively with other stream sources.
- Fixed cases where Debrid results could appear with unclear labels.
- Fixed wrong or weak episode matching in some Debrid and pack-based results.
- Fixed several release automation and dependency metadata inconsistencies.

Dependencies

- Bumped "express" from "4.22.1" to "5.2.1".
- Bumped "p-limit" from "3.1.0" to "7.3.0".
- Bumped "helmet" from "7.2.0" to "8.1.0".
- Bumped "dotenv" from "16.6.1" to "17.4.2".
- Bumped "parse-torrent-title" from "1.4.0" to "2.1.0".
- Bumped "express-rate-limit" from "7.5.1" to "8.3.2".

Maintenance

- Cleaned up old Release Please workflow files.
- Restored updated Release Please configuration.
- Refreshed project metadata and dependency lockfile.
- Consolidated multiple provider, Debrid and stream-ranking improvements into the "3.1.0" release.
- Improved changelog readability by grouping raw commit changes into meaningful release sections.

Important Notes

- This release includes several major dependency upgrades.
- "express" was upgraded from v4 to v5, so route handling, middleware behavior and error handling should be tested carefully.
- "p-limit" was upgraded from v3 to v7, so import style and runtime compatibility should be verified.
- Several provider improvements are designed to increase reliability when sources change layout, return redirects or temporarily fail.
- TorBox and Real-Debrid results now have cleaner separation, better ranking and stronger filtering.
- Some provider, hoster and Debrid behavior may still depend on the availability and stability of the original source websites, cached results and external services.
- Future releases should use clearer conventional commit messages to generate more accurate changelog entries automatically.
