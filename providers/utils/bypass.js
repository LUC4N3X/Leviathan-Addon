'use strict';

const axios = require('axios');

const DEFAULT_FINGERPRINT_POOL = Object.freeze([
    Object.freeze({
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36',
        browserType: 'chrome',
        secChUa: '"Google Chrome";v="135", "Not-A.Brand";v="8", "Chromium";v="135"',
        secChUaPlatform: '"Windows"',
        acceptLanguage: 'it-IT,it;q=0.9,en-US;q=0.8,en;q=0.7'
    }),
    Object.freeze({
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36 Edg/134.0.0.0',
        browserType: 'edge',
        secChUa: '"Microsoft Edge";v="134", "Chromium";v="134", "Not:A-Brand";v="99"',
        secChUaPlatform: '"Windows"',
        acceptLanguage: 'it-IT,it;q=0.9,en;q=0.8'
    }),
    Object.freeze({
        userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36',
        browserType: 'chrome',
        secChUa: '"Google Chrome";v="135", "Not-A.Brand";v="8", "Chromium";v="135"',
        secChUaPlatform: '"macOS"',
        acceptLanguage: 'it-IT,it;q=0.9,en-US;q=0.8,en;q=0.7'
    }),
    Object.freeze({
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:136.0) Gecko/20100101 Firefox/136.0',
        browserType: 'firefox',
        secChUa: null,
        secChUaPlatform: null,
        acceptLanguage: 'it-IT,it;q=0.8,en-US;q=0.5,en;q=0.3'
    }),
    Object.freeze({
        userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36',
        browserType: 'chrome',
        secChUa: '"Google Chrome";v="135", "Not-A.Brand";v="8", "Chromium";v="135"',
        secChUaPlatform: '"Linux"',
        acceptLanguage: 'it-IT,it;q=0.9,en-US;q=0.8,en;q=0.7'
    })
]);

function getRandomFingerprint(pool = DEFAULT_FINGERPRINT_POOL) {
    const items = Array.isArray(pool) && pool.length ? pool : DEFAULT_FINGERPRINT_POOL;
    return items[Math.floor(Math.random() * items.length)];
}

function buildBrowserHeaders(fp = getRandomFingerprint(), extra = {}) {
    const headers = {
        'User-Agent': fp.userAgent,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
        'Accept-Language': fp.acceptLanguage,
        'Accept-Encoding': 'gzip, deflate, br, zstd',
        'Cache-Control': 'no-cache',
        'Pragma': 'no-cache'
    };

    if (fp.browserType !== 'firefox') {
        Object.assign(headers, {
            'sec-ch-ua': fp.secChUa,
            'sec-ch-ua-mobile': '?0',
            'sec-ch-ua-platform': fp.secChUaPlatform,
            'Sec-Fetch-Dest': 'document',
            'Sec-Fetch-Mode': 'navigate',
            'Sec-Fetch-Site': 'none',
            'Sec-Fetch-User': '?1',
            'Upgrade-Insecure-Requests': '1'
        });
    } else {
        Object.assign(headers, {
            'TE': 'trailers'
        });
    }

    return Object.assign(headers, extra);
}

function getGotScrapingHeaderOptions(fp = getRandomFingerprint(), options = {}) {
    const browserName = fp.browserType === 'firefox' ? 'firefox' : 'chrome';
    const osPlatform = (() => {
        if (fp.secChUaPlatform === '"macOS"') return 'macos';
        if (fp.secChUaPlatform === '"Linux"') return 'linux';
        return 'windows';
    })();

    return {
        browsers: [{ name: browserName, minVersion: options.minVersion || 120 }],
        operatingSystems: [osPlatform],
        devices: options.devices || ['desktop'],
        locales: options.locales || ['it-IT', 'en-US']
    };
}

function responseText(data) {
    if (typeof data === 'string') return data;
    if (Buffer.isBuffer(data)) return data.toString('utf8');
    if (data == null) return '';
    try { return JSON.stringify(data); } catch (_) { return String(data); }
}

function isCloudflareChallenge(body, status) {
    if ([403, 429, 503].includes(Number(status))) return true;

    const text = responseText(body);
    return (
        /just a moment|checking your browser|cloudflare ray id|cf-browser-verification/i.test(text)
        || /enable javascript and cookies|<div id=["']cf-wrapper["']|cf-chl-widget|__cf_chl_opt|cf\.challenge\.orchestrate/i.test(text)
        || (/challenge-platform|_cf_chl_opt|cf_clearance/i.test(text) && text.length < 20000)
    );
}

function isCanceledError(error) {
    return axios.isCancel(error) ||
        error?.code === 'ERR_CANCELED' ||
        error?.code === 'ABORT_ERR' ||
        error?.name === 'AbortError';
}

function createDomainCookieJar() {
    const domainCookies = new Map();

    function updateCookiesFromResponse(url, headers = {}) {
        let host;
        try { host = new URL(url).hostname; } catch (_) { return; }

        const setCookie = headers['set-cookie'] || headers['Set-Cookie'];
        if (!setCookie) return;

        const cookies = Array.isArray(setCookie) ? setCookie : [setCookie];
        const jar = new Map();

        for (const oldCookie of domainCookies.get(host) || []) {
            const pair = String(oldCookie).split(';')[0].trim();
            const name = pair.split('=')[0];
            if (name) jar.set(name, pair);
        }

        for (const cookie of cookies) {
            const pair = String(cookie).split(';')[0].trim();
            const name = pair.split('=')[0];
            if (name) jar.set(name, pair);
        }

        domainCookies.set(host, [...jar.values()]);
    }

    function getCookieHeaderForUrl(url, extraCookies = '') {
        let host;
        try { host = new URL(url).hostname; } catch (_) { return extraCookies || null; }

        const jar = domainCookies.get(host) || [];
        const combined = jar.join('; ');
        if (extraCookies && combined) return extraCookies + '; ' + combined;
        return extraCookies || combined || null;
    }

    return {
        updateCookiesFromResponse,
        getCookieHeaderForUrl,
        clear: () => domainCookies.clear()
    };
}

function createGotScrapingLoader({ failSoft = false } = {}) {
    let gotScrapingInstance = null;
    let gotScrapingPromise = null;
    let gotScrapingLoadError = null;

    return async function getGotScraping() {
        if (gotScrapingInstance) return gotScrapingInstance;
        if (failSoft && gotScrapingLoadError) return null;

        if (!gotScrapingPromise) {
            gotScrapingPromise = import('got-scraping')
                .then((mod) => {
                    gotScrapingInstance = mod.gotScraping || mod.default?.gotScraping || mod.default || mod;
                    gotScrapingLoadError = null;
                    return gotScrapingInstance;
                })
                .catch((error) => {
                    gotScrapingPromise = null;
                    gotScrapingLoadError = error;
                    if (failSoft) return null;
                    throw error;
                });
        }

        return gotScrapingPromise;
    };
}

const getGotScraping = createGotScrapingLoader({ failSoft: true });

module.exports = {
    DEFAULT_FINGERPRINT_POOL,
    buildBrowserHeaders,
    createDomainCookieJar,
    createGotScrapingLoader,
    getGotScraping,
    getGotScrapingHeaderOptions,
    getRandomFingerprint,
    isCanceledError,
    isCloudflareChallenge,
    responseText
};
