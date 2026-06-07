'use strict';

const MANIFEST_ID = 'org.corsaro.brain.v2';
const MANIFEST_VERSION = '3.2.0';
const ADDON_NAME = 'Leviathan';
const LOGO_URL = 'https://i.ibb.co/5W2Ps39z/leviathan-logo-stremio-safe-max-transparent-1.png';
const SUPPORTED_TYPES = ['movie', 'series', 'anime'];
const STREAM_ID_PREFIXES = ['tt', 'tmdb:', 'kitsu:'];

const DESCRIPTION = [
    'Leviathan è un protocollo di aggregazione Italy-first per Stremio, progettato per unire torrent intelligence, web extraction, routing adattivo, cache condivisa e presentazione premium dei risultati.',
    'Supporta film, serie e anime con Real-Debrid, TorBox, Saved Cloud opzionale con dedupe, modalità P2P, filtri ITA/ENG/Hybrid, provider web italiani, anime/Kitsu intelligence e formatter avanzato per release 4K/HDR, WEB, BluRay e italiane.'
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
