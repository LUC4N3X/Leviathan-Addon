'use strict';

const { getOrigin, normalizeRemoteUrl } = require('../common');
const {
    DEFAULT_USER_AGENT,
    cleanCandidateUrl,
    fetchText,
    normalizeEscapedText,
    probeStreamQuality,
    responseText
} = require('./shared');

const VOE_DOMAINS = new Set([
    "voe.sx",
    "voe.to",
    "voe-unblock.com",
    "v-o-e-unblock.com",
    "19turanosephantasia.com",
    "20demidistance9elongations.com",
    "30sensualizeexpression.com",
    "321naturelikefurfuroid.com",
    "35volitantplimsoles5.com",
    "449unceremoniousnasoseptal.com",
    "745mingiestblissfully.com",
    "adrianmissionminute.com",
    "alleneconomicmatter.com",
    "antecoxalbobbing1010.com",
    "apinchcaseation.com",
    "audaciousdefaulthouse.com",
    "availedsmallest.com",
    "bigclatterhomesguideservice.com",
    "boonlessbestselling244.com",
    "bradleyviewdoctor.com",
    "brittneystandardwestern.com",
    "brucevotewithin.com",
    "christopheruntilpoint.com",
    "chromotypic.com",
    "chuckle-tube.com",
    "cindyeyefinal.com",
    "counterclockwisejacky.com",
    "crownmakermacaronicism.com",
    "crystaltreatmenteast.com",
    "cyamidpulverulence530.com",
    "diananatureforeign.com",
    "donaldlineelse.com",
    "edwardarriveoften.com",
    "erikcoldperson.com",
    "figeterpiazine.com",
    "fittingcentermondaysunday.com",
    "fraudclatterflyingcar.com",
    "gamoneinterrupted.com",
    "generatesnitrosate.com",
    "goofy-banana.com",
    "graceaddresscommunity.com",
    "greaseball6eventual20.com",
    "guidon40hyporadius9.com",
    "heatherdiscussionwhen.com",
    "housecardsummerbutton.com",
    "jamessoundcost.com",
    "jamiesamewalk.com",
    "jasminetesttry.com",
    "jayservicestuff.com",
    "jennifercertaindevelopment.com",
    "jilliandescribecompany.com",
    "johnalwayssame.com",
    "jonathansociallike.com",
    "josephseveralconcern.com",
    "kathleenmemberhistory.com",
    "kellywhatcould.com",
    "kennethofficialitem.com",
    "kinoger.ru",
    "kristiesoundsimply.com",
    "lancewhosedifficult.com",
    "launchreliantcleaverriver.com",
    "lauradaydo.com",
    "lisatrialidea.com",
    "loriwithinfamily.com",
    "lukecomparetwo.com",
    "lukesitturn.com",
    "mariatheserepublican.com",
    "matriculant401merited.com",
    "maxfinishseveral.com",
    "metagnathtuggers.com",
    "michaelapplysome.com",
    "mikaylaarealike.com",
    "nathanfromsubject.com",
    "nectareousoverelate.com",
    "nonesnanking.com",
    "paulkitchendark.com",
    "realfinanceblogcenter.com",
    "rebeccaneverbase.com",
    "reputationsheriffkennethsand.com",
    "richardsignfish.com",
    "roberteachfinal.com",
    "robertordercharacter.com",
    "robertplacespace.com",
    "sandratableother.com",
    "sandrataxeight.com",
    "scatch176duplicities.com",
    "sethniceletter.com",
    "shannonpersonalcost.com",
    "simpulumlamerop.com",
    "smoki.cc",
    "stevenimaginelittle.com",
    "strawberriesporail.com",
    "telyn610zoanthropy.com",
    "timberwoodanotia.com",
    "toddpartneranimal.com",
    "toxitabellaeatrebates306.com",
    "uptodatefinishconferenceroom.com",
    "valeronevijao.com",
    "walterprettytheir.com",
    "wolfdyslectic.com",
    "yodelswartlike.com"
]);

const VOE_RE = /(?:^|[/.])(?:voe(?:-unblock)?|v-o-e-unblock)\./i;
const BAD_ASSET_RE = /(?:template|background|preview|thumb|poster|sprite|logo|watermark|\/ads\/|advert|promo|trailer|\.(?:jpe?g|png|webp|gif)(?:$|[?#]))/i;
const DIRECT_MEDIA_PATTERNS = [
    /["'](https?:\/\/[^"']+\.m3u8[^"']*)["']/gi,
    /["'](https?:\/\/[^"']+\.mp4[^"']*)["']/gi,
    /(?:hls|source|src|file|mp4)\s*[:=]\s*["']([^"']+(?:\.m3u8|\.mp4)[^"']*)["']/gi
];
const SCRIPT_JSON_RE = /json">\s*\["([^"]+)"\]\s*<\/script>\s*<script\s+src=["']([^"']+)/is;
const LUT_RE = /(\[(?:'\W{2}'[,]?){1,12}\])/s;
const WINDOW_REDIRECT_RE = /window\.location\.href\s*=\s*['"]([^'"]+)['"]/i;
const EMBED_PATH_RE = /^\/(?:e|embed|player)\//i;

function envBool(name, fallback = false) {
    const raw = process.env[name];
    if (raw === undefined || raw === null || raw === '') return fallback;
    return /^(?:1|true|yes|on)$/i.test(String(raw).trim());
}

function hostFromUrl(value) {
    try {
        return new URL(String(value || '')).hostname.toLowerCase().replace(/^www\./i, '');
    } catch (_) {
        return '';
    }
}

function isVoeUrl(url) {
    const host = hostFromUrl(url);
    if (!host) return false;
    if (VOE_RE.test(`.${host}`)) return true;
    if (host.includes('voe')) return true;
    return [...VOE_DOMAINS].some((domain) => host === domain || host.endsWith(`.${domain}`));
}

function normalizeUrl(url, baseUrl = null) {
    return cleanCandidateUrl(url, baseUrl) || normalizeRemoteUrl(url, baseUrl) || '';
}

function isBadAsset(url) {
    return BAD_ASSET_RE.test(String(url || '').toLowerCase());
}

function candidateScore(url) {
    const lower = String(url || '').toLowerCase();
    const kind = lower.includes('.m3u8') ? 4 : lower.includes('.mp4') ? 3 : lower.includes('/hls/') ? 2 : 1;
    const https = lower.startsWith('https://') ? 1 : 0;
    return kind * 10 + https;
}

function pickBest(candidates = []) {
    const seen = new Set();
    const cleaned = [];
    for (const candidate of candidates) {
        const normalized = normalizeUrl(candidate);
        if (!normalized || seen.has(normalized) || isBadAsset(normalized)) continue;
        seen.add(normalized);
        cleaned.push(normalized);
    }
    cleaned.sort((a, b) => candidateScore(b) - candidateScore(a));
    return cleaned[0] || null;
}

function decodeVoePayload(encodedData, luts) {
    try {
        const lut = String(luts || '')
            .slice(2, -2)
            .split("','")
            .map((item) => item.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));

        let text = '';
        for (const char of String(encodedData || '')) {
            let code = char.charCodeAt(0);
            if (code > 64 && code < 91) code = ((code - 52) % 26) + 65;
            else if (code > 96 && code < 123) code = ((code - 84) % 26) + 97;
            text += String.fromCharCode(code);
        }

        for (const token of lut) {
            if (token) text = text.replace(new RegExp(token, 'g'), '');
        }

        const decoded = Buffer.from(text, 'base64').toString('utf8');
        const shifted = [...decoded].map((char) => String.fromCharCode(char.charCodeAt(0) - 3)).join('');
        const jsonText = Buffer.from([...shifted].reverse().join(''), 'base64').toString('utf8');
        return JSON.parse(jsonText);
    } catch (_) {
        return null;
    }
}

function extractMediaCandidates(text, baseUrl) {
    const candidates = [];
    const searchSpace = normalizeEscapedText(text || '');
    for (const pattern of DIRECT_MEDIA_PATTERNS) {
        pattern.lastIndex = 0;
        for (const match of searchSpace.matchAll(pattern)) {
            const candidate = normalizeUrl(match[1] || match[0], baseUrl);
            if (candidate) candidates.push(candidate);
        }
    }
    return candidates;
}

function buildVoeHeaders(pageUrl, userAgent = DEFAULT_USER_AGENT, referer = null) {
    const origin = getOrigin(pageUrl, 'https://voe.sx');
    return {
        'User-Agent': userAgent,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'it-IT,it;q=0.9,en-US;q=0.8,en;q=0.7',
        'Referer': referer || pageUrl,
        'Origin': origin
    };
}

function normalizeVoeEmbedUrl(url) {
    const absolute = normalizeUrl(url);
    if (!absolute || !isVoeUrl(absolute)) return null;
    try {
        const parsed = new URL(absolute);
        if (!EMBED_PATH_RE.test(parsed.pathname)) {
            const parts = parsed.pathname.split('/').filter(Boolean);
            const code = parts.pop();
            if (code) parsed.pathname = `/e/${code}`;
        }
        parsed.hash = '';
        return parsed.toString();
    } catch (_) {
        return absolute;
    }
}

async function fetchVoePage(client, url, headers, options = {}) {
    if (options.fetchText) return options.fetchText(url, headers);
    return fetchText(client, url, {
        headers,
        timeout: Number(options.timeout || 8000)
    });
}

async function extractVoe(url, options = {}) {
    const client = options?.client;
    const inputUrl = normalizeVoeEmbedUrl(url) || normalizeUrl(url);
    if (!inputUrl || !isVoeUrl(inputUrl) || !client || typeof client.get !== 'function') return null;

    const userAgent = options?.userAgent || DEFAULT_USER_AGENT;
    const maxRedirects = Math.max(0, Math.min(4, Number(options?.maxRedirects ?? 3) || 0));
    const allowLocal = options?.allowLocalVoe !== false && envBool('VOE_LOCAL_ENABLED', true);
    if (!allowLocal) return null;

    async function resolve(currentUrl, depth = 0) {
        const pageUrl = depth === 0 ? inputUrl : normalizeUrl(currentUrl, inputUrl);
        if (!pageUrl || !isVoeUrl(pageUrl)) return null;

        const headers = buildVoeHeaders(pageUrl, userAgent, depth === 0 ? options?.referer : inputUrl);
        const { status, text, response } = await fetchVoePage(client, pageUrl, headers, options);

        if (status === 404 && !/\/e\//i.test(pageUrl)) {
            const embedUrl = normalizeVoeEmbedUrl(pageUrl);
            if (embedUrl && embedUrl !== pageUrl && depth < maxRedirects) return resolve(embedUrl, depth + 1);
        }

        const location = response?.headers?.location || response?.headers?.Location;
        if ([301, 302, 303, 307, 308].includes(Number(status)) && location && depth < maxRedirects) {
            return resolve(normalizeUrl(location, pageUrl), depth + 1);
        }

        if (status < 200 || status >= 400 || !text) return null;
        if (/An error occurred during encoding/i.test(text)) return null;

        const redirect = text.match(WINDOW_REDIRECT_RE)?.[1];
        if (redirect && depth < maxRedirects) {
            return resolve(normalizeUrl(redirect, pageUrl), depth + 1);
        }

        const candidates = [];
        const encodedMatch = text.match(SCRIPT_JSON_RE);
        if (encodedMatch) {
            const encodedData = encodedMatch[1];
            const scriptUrl = normalizeUrl(encodedMatch[2], pageUrl);
            if (scriptUrl) {
                const scriptHeaders = buildVoeHeaders(scriptUrl, userAgent, pageUrl);
                const scriptResult = await fetchVoePage(client, scriptUrl, scriptHeaders, { ...options, timeout: Number(options.scriptTimeout || options.timeout || 8000) });
                const luts = scriptResult.text?.match(LUT_RE)?.[1];
                const decoded = luts ? decodeVoePayload(encodedData, luts) : null;
                if (decoded && typeof decoded === 'object') {
                    for (const key of ['hls', 'source', 'mp4', 'file', 'url']) {
                        const value = decoded[key];
                        if (typeof value === 'string' && value.trim()) candidates.push(normalizeUrl(value, pageUrl));
                    }
                }
            }
        }

        candidates.push(...extractMediaCandidates(text, pageUrl));
        const streamUrl = pickBest(candidates);
        if (!streamUrl) return null;

        const playbackHeaders = {
            Referer: `${getOrigin(pageUrl, 'https://voe.sx')}/`,
            Origin: getOrigin(pageUrl, 'https://voe.sx'),
            'User-Agent': userAgent
        };
        const quality = await probeStreamQuality(client, streamUrl, {
            headers: playbackHeaders,
            timeout: Number(options.probeTimeout || 4500),
            fallback: options.quality || 'Unknown'
        });

        return {
            url: streamUrl,
            sourceUrl: pageUrl,
            headers: playbackHeaders,
            extractor: 'VOE',
            name: 'VOE',
            quality,
            priority: 2
        };
    }

    try {
        return await resolve(inputUrl, 0);
    } catch (_) {
        return null;
    }
}

module.exports = {
    VOE_DOMAINS,
    decodeVoePayload,
    extractVoe,
    isVoeUrl,
    normalizeVoeEmbedUrl,
    pickBest
};
