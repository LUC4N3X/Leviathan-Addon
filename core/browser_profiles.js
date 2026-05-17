'use strict';

const CANONICAL_BROWSER_PROFILES = Object.freeze([
    Object.freeze({
        name: 'chrome-windows',
        family: 'chrome',
        platform: 'windows',
        mobile: false,
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36',
        secChUa: '"Chromium";v="136", "Google Chrome";v="136", "Not-A.Brand";v="99"',
        secChUaMobile: '?0',
        secChUaPlatform: '"Windows"',
        acceptLanguage: 'it-IT,it;q=0.9,en-US;q=0.8,en;q=0.7',
        acceptDocument: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
        extraHeaders: Object.freeze({
            'Sec-Fetch-Dest': 'document',
            'Sec-Fetch-Mode': 'navigate',
            'Sec-Fetch-Site': 'none',
            'Sec-Fetch-User': '?1',
            'Cache-Control': 'no-cache',
            Pragma: 'no-cache',
            Connection: 'keep-alive',
            'Upgrade-Insecure-Requests': '1'
        })
    }),
    Object.freeze({
        name: 'chrome-mac',
        family: 'chrome',
        platform: 'macos',
        mobile: false,
        userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36',
        secChUa: '"Google Chrome";v="136", "Not:A-Brand";v="8", "Chromium";v="136"',
        secChUaMobile: '?0',
        secChUaPlatform: '"macOS"',
        acceptLanguage: 'it-IT,it;q=0.9,en;q=0.8',
        acceptDocument: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
        extraHeaders: Object.freeze({
            'Sec-Fetch-Dest': 'document',
            'Sec-Fetch-Mode': 'navigate',
            'Sec-Fetch-Site': 'none',
            'Sec-Fetch-User': '?1',
            Connection: 'keep-alive',
            'Upgrade-Insecure-Requests': '1'
        })
    }),
    Object.freeze({
        name: 'firefox-windows',
        family: 'firefox',
        platform: 'windows',
        mobile: false,
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:136.0) Gecko/20100101 Firefox/136.0',
        secChUa: null,
        secChUaMobile: null,
        secChUaPlatform: null,
        acceptLanguage: 'it-IT,it;q=0.8,en-US;q=0.5,en;q=0.3',
        acceptDocument: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
        extraHeaders: Object.freeze({
            'Sec-Fetch-Dest': 'document',
            'Sec-Fetch-Mode': 'navigate',
            'Sec-Fetch-Site': 'none',
            'Sec-Fetch-User': '?1',
            DNT: '1',
            Connection: 'keep-alive',
            'Upgrade-Insecure-Requests': '1'
        })
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
        acceptDocument: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        extraHeaders: Object.freeze({
            'Sec-Fetch-Dest': 'document',
            'Sec-Fetch-Mode': 'navigate',
            'Sec-Fetch-Site': 'none',
            Connection: 'keep-alive',
            'Upgrade-Insecure-Requests': '1'
        })
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
        acceptDocument: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        extraHeaders: Object.freeze({
            'Sec-Fetch-Dest': 'document',
            'Sec-Fetch-Mode': 'navigate',
            'Sec-Fetch-Site': 'none',
            Connection: 'keep-alive',
            'Upgrade-Insecure-Requests': '1'
        })
    }),
    Object.freeze({
        name: 'chrome-android',
        family: 'chrome',
        platform: 'android',
        mobile: true,
        userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.7103.113 Mobile Safari/537.36',
        secChUa: '"Chromium";v="136", "Google Chrome";v="136", "Not-A.Brand";v="99"',
        secChUaMobile: '?1',
        secChUaPlatform: '"Android"',
        acceptLanguage: 'it-IT,it;q=0.9,en-US;q=0.8',
        acceptDocument: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
        extraHeaders: Object.freeze({
            'Sec-Fetch-Dest': 'document',
            'Sec-Fetch-Mode': 'navigate',
            'Sec-Fetch-Site': 'none',
            'Sec-Fetch-User': '?1',
            Connection: 'keep-alive',
            'Upgrade-Insecure-Requests': '1'
        })
    }),
    Object.freeze({
        name: 'edge-windows',
        family: 'edge',
        platform: 'windows',
        mobile: false,
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36 Edg/136.0.0.0',
        secChUa: '"Chromium";v="136", "Microsoft Edge";v="136", "Not-A.Brand";v="99"',
        secChUaMobile: '?0',
        secChUaPlatform: '"Windows"',
        acceptLanguage: 'it-IT,it;q=0.9,en-US;q=0.8,en;q=0.7',
        acceptDocument: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
        extraHeaders: Object.freeze({
            'Sec-Fetch-Dest': 'document',
            'Sec-Fetch-Mode': 'navigate',
            'Sec-Fetch-Site': 'none',
            'Sec-Fetch-User': '?1',
            Connection: 'keep-alive',
            'Upgrade-Insecure-Requests': '1'
        })
    })
]);

function createLegacyProfile(profile) {
    return {
        name: profile.name,
        userAgent: profile.userAgent,
        secChUa: profile.secChUa,
        secChUaMobile: profile.secChUaMobile,
        secChUaPlatform: profile.secChUaPlatform,
        secFetchDest: profile.extraHeaders['Sec-Fetch-Dest'] || 'document',
        secFetchMode: profile.extraHeaders['Sec-Fetch-Mode'] || 'navigate',
        secFetchSite: profile.extraHeaders['Sec-Fetch-Site'] || 'none',
        secFetchUser: profile.extraHeaders['Sec-Fetch-User'] || '?1',
        acceptLanguage: profile.acceptLanguage,
        accept: profile.acceptDocument
    };
}

function createEngineProfile(profile) {
    return {
        name: profile.name,
        userAgent: profile.userAgent,
        headers: {
            Accept: profile.acceptDocument,
            'Accept-Language': profile.acceptLanguage,
            ...profile.extraHeaders
        }
    };
}

function createGuardaserieProfile(profile) {
    return {
        ua: profile.userAgent,
        sec_ch_ua: profile.secChUa
    };
}

const LEGACY_BROWSER_PROFILES = Object.freeze(CANONICAL_BROWSER_PROFILES.map(createLegacyProfile));
const ENGINE_BROWSER_PROFILES = Object.freeze(CANONICAL_BROWSER_PROFILES
    .filter((profile) => ['safari', 'chrome', 'firefox'].includes(profile.family))
    .map(createEngineProfile));
const GUARDA_SERIE_BROWSER_PROFILES = Object.freeze(CANONICAL_BROWSER_PROFILES
    .filter((profile) => profile.name === 'chrome-windows' || profile.name === 'edge-windows' || profile.name === 'firefox-windows')
    .map(createGuardaserieProfile));

function pickRandomProfile(profiles) {
    if (!Array.isArray(profiles) || profiles.length === 0) return null;
    return profiles[Math.floor(Math.random() * profiles.length)];
}

module.exports = {
    CANONICAL_BROWSER_PROFILES,
    LEGACY_BROWSER_PROFILES,
    ENGINE_BROWSER_PROFILES,
    GUARDA_SERIE_BROWSER_PROFILES,
    pickRandomProfile
};
