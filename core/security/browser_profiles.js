'use strict';

const ACCEPT_DOCUMENT = 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8';
const ACCEPT_DOCUMENT_CHROMIUM = ACCEPT_DOCUMENT;
const ACCEPT_DOCUMENT_FIREFOX = 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8';
const ACCEPT_DOCUMENT_SAFARI = 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8';
const ACCEPT_JSON = 'application/json, text/plain, */*';
const ACCEPT_SCRIPT = 'application/javascript,text/javascript,*/*;q=0.8';
const ACCEPT_MEDIA = '*/*';
const ACCEPT_HLS = 'application/vnd.apple.mpegurl, application/x-mpegURL, */*';
const ACCEPT_DASH = 'application/dash+xml, */*';

const CANONICAL_BROWSER_PROFILES = Object.freeze([
    Object.freeze({
        name: 'chrome-windows',
        family: 'chrome',
        platform: 'windows',
        mobile: false,
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36',
        secChUa: '"Chromium";v="142", "Google Chrome";v="142", "Not-A.Brand";v="99"',
        secChUaMobile: '?0',
        secChUaPlatform: '"Windows"',
        acceptLanguage: 'it-IT,it;q=0.9,en-US;q=0.8,en;q=0.7',
        acceptDocument: ACCEPT_DOCUMENT_CHROMIUM
    }),
    Object.freeze({
        name: 'chrome-mac',
        family: 'chrome',
        platform: 'macos',
        mobile: false,
        userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36',
        secChUa: '"Google Chrome";v="142", "Not:A-Brand";v="8", "Chromium";v="142"',
        secChUaMobile: '?0',
        secChUaPlatform: '"macOS"',
        acceptLanguage: 'it-IT,it;q=0.9,en;q=0.8',
        acceptDocument: ACCEPT_DOCUMENT_CHROMIUM
    }),
    Object.freeze({
        name: 'firefox-windows',
        family: 'firefox',
        platform: 'windows',
        mobile: false,
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:144.0) Gecko/20100101 Firefox/144.0',
        secChUa: null,
        secChUaMobile: null,
        secChUaPlatform: null,
        acceptLanguage: 'it-IT,it;q=0.8,en-US;q=0.5,en;q=0.3',
        acceptDocument: ACCEPT_DOCUMENT_FIREFOX
    }),
    Object.freeze({
        name: 'safari-mac',
        family: 'safari',
        platform: 'macos',
        mobile: false,
        userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_4_1) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4.1 Safari/605.1.15',
        secChUa: null,
        secChUaMobile: null,
        secChUaPlatform: null,
        acceptLanguage: 'it-IT,it;q=0.9,en-US;q=0.8,en;q=0.7',
        acceptDocument: ACCEPT_DOCUMENT_SAFARI
    }),
    Object.freeze({
        name: 'safari-ios',
        family: 'safari',
        platform: 'ios',
        mobile: true,
        userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1',
        secChUa: null,
        secChUaMobile: null,
        secChUaPlatform: null,
        acceptLanguage: 'it-IT,it;q=0.9,en-US;q=0.8,en;q=0.7',
        acceptDocument: ACCEPT_DOCUMENT_SAFARI
    }),
    Object.freeze({
        name: 'chrome-android',
        family: 'chrome',
        platform: 'android',
        mobile: true,
        userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Mobile Safari/537.36',
        secChUa: '"Chromium";v="142", "Google Chrome";v="142", "Not-A.Brand";v="99"',
        secChUaMobile: '?1',
        secChUaPlatform: '"Android"',
        acceptLanguage: 'it-IT,it;q=0.9,en-US;q=0.8',
        acceptDocument: ACCEPT_DOCUMENT_CHROMIUM
    }),
    Object.freeze({
        name: 'edge-windows',
        family: 'edge',
        platform: 'windows',
        mobile: false,
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36 Edg/142.0.0.0',
        secChUa: '"Chromium";v="142", "Microsoft Edge";v="142", "Not-A.Brand";v="99"',
        secChUaMobile: '?0',
        secChUaPlatform: '"Windows"',
        acceptLanguage: 'it-IT,it;q=0.9,en-US;q=0.8,en;q=0.7',
        acceptDocument: ACCEPT_DOCUMENT_CHROMIUM
    })
]);

function isChromiumProfile(profile) {
    const family = String(profile?.family || '').toLowerCase();
    return family === 'chrome' || family === 'edge';
}

function compactHeaders(headers = {}) {
    const out = {};
    for (const [key, value] of Object.entries(headers || {})) {
        if (value === undefined || value === null || value === '') continue;
        out[key] = value;
    }
    return out;
}

function clientHintHeaders(profile) {
    if (!isChromiumProfile(profile) || !profile?.secChUa) return {};
    return compactHeaders({
        'sec-ch-ua': profile.secChUa,
        'sec-ch-ua-mobile': profile.secChUaMobile,
        'sec-ch-ua-platform': profile.secChUaPlatform
    });
}

function normalizeContext(context = 'document') {
    const value = String(context || 'document').trim().toLowerCase();
    if (['json', 'api', 'ajax', 'xhr', 'fetch'].includes(value)) return 'api';
    if (['media', 'video', 'segment', 'stream'].includes(value)) return 'media';
    if (['playlist', 'hls', 'm3u8'].includes(value)) return 'playlist';
    if (['dash', 'mpd'].includes(value)) return 'dash';
    if (['script', 'js'].includes(value)) return 'script';
    if (['iframe', 'embed', 'player'].includes(value)) return 'embed';
    return 'document';
}

function buildProfileHeaders(profile, context = 'document', extra = {}) {
    const selected = normalizeContext(context);
    const fetchSite = extra['Sec-Fetch-Site'] || extra['sec-fetch-site'] || 'none';
    const headers = {
        'User-Agent': profile.userAgent,
        'Accept-Language': profile.acceptLanguage,
        ...clientHintHeaders(profile)
    };

    if (selected === 'api') {
        Object.assign(headers, {
            Accept: ACCEPT_JSON,
            'Sec-Fetch-Dest': 'empty',
            'Sec-Fetch-Mode': 'cors',
            'Sec-Fetch-Site': fetchSite
        });
    } else if (selected === 'playlist') {
        Object.assign(headers, {
            Accept: ACCEPT_HLS,
            'Sec-Fetch-Dest': 'empty',
            'Sec-Fetch-Mode': 'cors',
            'Sec-Fetch-Site': fetchSite
        });
    } else if (selected === 'dash') {
        Object.assign(headers, {
            Accept: ACCEPT_DASH,
            'Sec-Fetch-Dest': 'empty',
            'Sec-Fetch-Mode': 'cors',
            'Sec-Fetch-Site': fetchSite
        });
    } else if (selected === 'media') {
        Object.assign(headers, {
            Accept: ACCEPT_MEDIA,
            'Sec-Fetch-Dest': 'video',
            'Sec-Fetch-Mode': 'cors',
            'Sec-Fetch-Site': fetchSite
        });
    } else if (selected === 'script') {
        Object.assign(headers, {
            Accept: ACCEPT_SCRIPT,
            'Sec-Fetch-Dest': 'script',
            'Sec-Fetch-Mode': 'no-cors',
            'Sec-Fetch-Site': fetchSite
        });
    } else if (selected === 'embed') {
        Object.assign(headers, {
            Accept: profile.acceptDocument,
            'Sec-Fetch-Dest': 'iframe',
            'Sec-Fetch-Mode': 'navigate',
            'Sec-Fetch-Site': fetchSite,
            'Upgrade-Insecure-Requests': '1'
        });
    } else {
        Object.assign(headers, {
            Accept: profile.acceptDocument,
            'Sec-Fetch-Dest': 'document',
            'Sec-Fetch-Mode': 'navigate',
            'Sec-Fetch-Site': fetchSite,
            'Sec-Fetch-User': '?1',
            'Upgrade-Insecure-Requests': '1'
        });
    }

    return compactHeaders({ ...headers, ...extra });
}

function createLegacyProfile(profile) {
    const documentHeaders = buildProfileHeaders(profile, 'document');
    return {
        name: profile.name,
        userAgent: profile.userAgent,
        family: profile.family,
        platform: profile.platform,
        mobile: profile.mobile,
        secChUa: isChromiumProfile(profile) ? profile.secChUa : null,
        secChUaMobile: isChromiumProfile(profile) ? profile.secChUaMobile : null,
        secChUaPlatform: isChromiumProfile(profile) ? profile.secChUaPlatform : null,
        secFetchDest: documentHeaders['Sec-Fetch-Dest'],
        secFetchMode: documentHeaders['Sec-Fetch-Mode'],
        secFetchSite: documentHeaders['Sec-Fetch-Site'],
        secFetchUser: documentHeaders['Sec-Fetch-User'],
        acceptLanguage: profile.acceptLanguage,
        accept: documentHeaders.Accept,
        headers: documentHeaders,
        requestHeaders: Object.freeze({
            document: buildProfileHeaders(profile, 'document'),
            api: buildProfileHeaders(profile, 'api', { 'Sec-Fetch-Site': 'same-origin' }),
            embed: buildProfileHeaders(profile, 'embed', { 'Sec-Fetch-Site': 'same-origin' }),
            media: buildProfileHeaders(profile, 'media', { 'Sec-Fetch-Site': 'same-origin' }),
            playlist: buildProfileHeaders(profile, 'playlist', { 'Sec-Fetch-Site': 'same-origin' })
        })
    };
}

function createEngineProfile(profile) {
    return {
        name: profile.name,
        userAgent: profile.userAgent,
        family: profile.family,
        platform: profile.platform,
        mobile: profile.mobile,
        headers: buildProfileHeaders(profile, 'document')
    };
}

function createGuardoserieProfile(profile) {
    return {
        ua: profile.userAgent,
        family: profile.family,
        sec_ch_ua: isChromiumProfile(profile) ? profile.secChUa : null,
        sec_ch_ua_mobile: isChromiumProfile(profile) ? profile.secChUaMobile : null,
        sec_ch_ua_platform: isChromiumProfile(profile) ? profile.secChUaPlatform : null
    };
}

const LEGACY_BROWSER_PROFILES = Object.freeze(CANONICAL_BROWSER_PROFILES.map(createLegacyProfile));
const ENGINE_BROWSER_PROFILES = Object.freeze(CANONICAL_BROWSER_PROFILES
    .filter((profile) => ['safari', 'chrome', 'firefox'].includes(profile.family))
    .map(createEngineProfile));
const GUARDO_SERIE_BROWSER_PROFILES = Object.freeze(CANONICAL_BROWSER_PROFILES
    .filter((profile) => profile.name === 'chrome-windows' || profile.name === 'edge-windows' || profile.name === 'firefox-windows')
    .map(createGuardoserieProfile));

function pickRandomProfile(profiles) {
    if (!Array.isArray(profiles) || profiles.length === 0) return null;
    return profiles[Math.floor(Math.random() * profiles.length)];
}

module.exports = {
    ACCEPT_DASH,
    ACCEPT_DOCUMENT,
    ACCEPT_DOCUMENT_CHROMIUM,
    ACCEPT_DOCUMENT_FIREFOX,
    ACCEPT_DOCUMENT_SAFARI,
    ACCEPT_HLS,
    ACCEPT_JSON,
    ACCEPT_MEDIA,
    ACCEPT_SCRIPT,
    CANONICAL_BROWSER_PROFILES,
    LEGACY_BROWSER_PROFILES,
    ENGINE_BROWSER_PROFILES,
    GUARDO_SERIE_BROWSER_PROFILES,
    buildProfileHeaders,
    clientHintHeaders,
    isChromiumProfile,
    normalizeContext,
    pickRandomProfile
};
