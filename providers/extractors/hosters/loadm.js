'use strict';

const crypto = require('crypto');
const { getOrigin, normalizeRemoteUrl } = require('../common');

const DEFAULT_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const LOADM_REGEX = /loadm/i;
const LOADM_KEY = Buffer.from('kiemtienmua911ca');
const LOADM_IV = Buffer.from('1234567890oiuytr');

function isLoadmUrl(url) {
    return LOADM_REGEX.test(String(url || ''));
}

function decryptLoadmPayload(rawPayload) {
    const cleanedHex = String(rawPayload || '').replace(/[^0-9a-fA-F]/g, '');
    if (!cleanedHex) return null;

    const encryptedBytes = Buffer.from(cleanedHex, 'hex');
    const decipher = crypto.createDecipheriv('aes-128-cbc', LOADM_KEY, LOADM_IV);
    decipher.setAutoPadding(true);

    let decrypted = decipher.update(encryptedBytes);
    decrypted = Buffer.concat([decrypted, decipher.final()]);

    const plainText = decrypted.toString('utf8').trim();
    const lastBraceIndex = plainText.lastIndexOf('}');
    const normalizedText = lastBraceIndex !== -1 ? plainText.slice(0, lastBraceIndex + 1) : plainText;
    const payload = JSON.parse(normalizedText);

    return payload?.source || payload?.cf || null;
}

function extractVideoId(playerUrl) {
    const parsed = new URL(playerUrl);
    return parsed.hash?.replace(/^#/, '').trim()
        || parsed.pathname.split('/e/').pop()?.trim()
        || parsed.searchParams.get('id')
        || parsed.searchParams.get('v')
        || null;
}

async function fetchLoadmPayload(apiUrl, headers, options = {}) {
    const fetchers = Array.isArray(options?.fetchers) ? options.fetchers.filter(Boolean) : [];

    for (const fetcher of fetchers) {
        try {
            const body = await fetcher(apiUrl, headers);
            if (body) return typeof body === 'string' ? body : JSON.stringify(body);
        } catch (_) {}
    }

    const client = options?.client;
    if (!client || typeof client.get !== 'function') return null;

    const response = await client.get(apiUrl, {
        headers,
        responseType: 'text'
    });
    return typeof response?.data === 'string' ? response.data : JSON.stringify(response?.data || '');
}

async function extractLoadm(url, options = {}) {
    const playerUrl = normalizeRemoteUrl(url);
    if (!playerUrl || !isLoadmUrl(playerUrl)) return null;

    try {
        const videoId = extractVideoId(playerUrl);
        if (!videoId) return null;

        const origin = getOrigin(playerUrl);
        const baseUrl = `${origin}/`;
        const requestReferer = String(options?.requestReferer || options?.pageUrl || options?.referer || baseUrl).trim();
        const query = new URLSearchParams({
            id: videoId,
            w: '2560',
            h: '1440',
            r: requestReferer
        });
        const apiUrl = `${baseUrl}api/v1/video?${query.toString()}`;
        const headers = {
            'User-Agent': options?.userAgent || DEFAULT_USER_AGENT,
            'Referer': baseUrl,
            'X-Requested-With': 'XMLHttpRequest',
            'Accept': 'application/json, text/plain, */*'
        };
        const payload = await fetchLoadmPayload(apiUrl, headers, options);
        const streamUrl = decryptLoadmPayload(payload);
        if (!streamUrl) return null;

        return {
            url: streamUrl,
            headers: {
                Referer: baseUrl,
                Origin: origin
            },
            extractor: 'LoadM',
            name: 'LoadM',
            quality: 'Unknown',
            priority: 0
        };
    } catch (_) {
        return null;
    }
}

module.exports = {
    isLoadmUrl,
    extractLoadm
};
