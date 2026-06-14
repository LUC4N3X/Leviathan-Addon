'use strict';

const MANIFEST_ID = 'org.corsaro.brain.v2';
const MANIFEST_VERSION = '3.2.0';
const ADDON_NAME = 'Leviathan';
const LOGO_URL = 'https://i.ibb.co/YTKfXc1z/logo.png';
const SUPPORTED_TYPES = ['movie', 'series', 'anime'];
const STREAM_ID_PREFIXES = ['tt', 'tmdb:', 'kitsu:'];

const DESCRIPTION = [
    'Leviathan is an Italy-first aggregation protocol for Stremio, engineered to unify torrent intelligence, web extraction, adaptive routing, shared caching and premium result presentation into a single streamlined experience.',
    'It supports movies, series and anime with Real-Debrid, TorBox, optional Saved Cloud with deduplication, P2P mode, ITA/ENG/Hybrid filters, Italian web providers, anime/Kitsu intelligence and an advanced release formatter for 4K/HDR, WEB, BluRay and Italian releases.'
].join(' ');

function getManifest() {
    return {
        id: MANIFEST_ID,
        version: MANIFEST_VERSION,
        name: ADDON_NAME,
        description: DESCRIPTION,
        logo: LOGO_URL,
        resources: [
            {
                name: 'stream',
                types: [...SUPPORTED_TYPES],
                idPrefixes: [...STREAM_ID_PREFIXES]
            }
        ],
        types: [...SUPPORTED_TYPES],
        idPrefixes: [...STREAM_ID_PREFIXES],
        catalogs: [],
        behaviorHints: {
            adult: false,
            configurable: true,
            configurationRequired: false
        },
        stremioAddonsConfig: {
            issuer: 'https://stremio-addons.net',
            signature: 'eyJhbGciOiJkaXIiLCJlbmMiOiJBMTI4Q0JDLUhTMjU2In0..guRYCFSZxJ-zbESKkZicTg.R-jeN-fyn1-6JWfMqJREy66fhEopTajTGkAKoDmwimetqMzI8zRhFoHYOckwb6KncfR4XK1g_8h9u7gYq2LFdvF5Lwm2Hr3iLcpO5vygwbSpIX7DmtV9fzKh0Z-Fe5l0.5Uy2bL0SyUSZ0mPlOSeiaA'
        }
    };
}

module.exports = { getManifest };
