'use strict';

const CHALLENGE_BLOCK_STATUSES = new Set([403, 429, 503]);

const CF_STRONG_MARKERS = [
  /just a moment/i,
  /checking your browser before accessing/i,
  /checking if the site connection is secure/i,
  /cloudflare ray id/i,
  /cf-browser-verification/i,
  /cf-chl-widget/i,
  /__cf_chl_opt/i,
  /_cf_chl_opt/i,
  /cf\.challenge\.orchestrate/i,
  /cdn-cgi\/challenge-platform\/h\/[bg]\/orchestrate/i,
  /turnstile\.cloudflare\.com/i,
  /cf-turnstile-response/i,
  /window\._cf_chl_/i,
  /challenges\.cloudflare\.com\/turnstile/i,
];

const CF_WEAK_MARKERS = [
  /challenge-platform/i,
  /cf_clearance/i,
  /cf_chl_/i,
  /cf-challenge/i,
  /challenge-form/i,
];

const HUMAN_VERIFY_MARKERS = [
  /verify you are (?:a )?human/i,
  /verifica di essere umano/i,
  /verifica che (?:sei|tu sia) umano/i,
  /controllo connessione al sito/i,
  /attention required/i,
  /please wait while we verify/i,
  /un momento/i,
  /ray id:/i,
];

const VENDOR_SIGNATURES = [
  {
    vendor: 'datadome',
    bodyMarkers: [/datadome/i, /dd_cookie/i, /geo\.captcha-delivery\.com/i, /captcha-delivery\.com/i],
    headerKeys: ['x-datadome', 'x-dd-b'],
    cookieMarkers: [/datadome=/i],
  },
  {
    vendor: 'perimeterx',
    bodyMarkers: [/perimeterx/i, /_px(?:hd|vid|3)?[=\b]/i, /px-captcha/i, /human challenge/i, /captcha\.px-cdn\.net/i],
    headerKeys: ['x-px', 'x-px-block'],
    cookieMarkers: [/_px[a-z0-9]*=/i],
  },
  {
    vendor: 'akamai',
    bodyMarkers: [/akamai/i, /_abck/i, /bm-verify/i, /reference\s*#\d+\.\w+/i],
    headerKeys: ['x-akamai-transformed', 'akamai-grn'],
    cookieMarkers: [/_abck=/i, /bm_sz=/i],
  },
  {
    vendor: 'incapsula',
    bodyMarkers: [/incapsula/i, /imperva/i, /_incap_/i, /incident id/i, /support id is/i],
    headerKeys: ['x-iinfo', 'x-cdn'],
    presenceHeaderKeys: ['x-cdn'],
    cookieMarkers: [/visid_incap_/i, /incap_ses_/i],
  },
  {
    vendor: 'kasada',
    bodyMarkers: [/kasada/i, /kpsdk/i, /\/149e9513-01fa-4fb0-aad4-566afd725d1b\//i],
    headerKeys: ['x-kpsdk-ct', 'x-kpsdk-cd'],
    cookieMarkers: [/KP_UIDz/i],
  },
  {
    vendor: 'queue-it',
    bodyMarkers: [/queue-it/i, /queue\.it/i, /you are now in line/i],
    headerKeys: ['x-queueit-passed'],
    presenceHeaderKeys: ['x-queueit-passed'],
    cookieMarkers: [/QueueITAccepted/i],
  },
  {
    vendor: 'ddos-guard',
    bodyMarkers: [/ddos-guard/i, /\.well-known\/ddos-guard/i],
    headerKeys: ['x-ddg', 'x-ddos-guard'],
    cookieMarkers: [/__ddg\d?_/i],
  },
  {
    vendor: 'sucuri',
    bodyMarkers: [/sucuri/i, /cloudproxy/i, /access denied - sucuri/i],
    headerKeys: ['x-sucuri-id', 'x-sucuri-cache'],
    cookieMarkers: [/sucuri_cloudproxy_uuid/i],
  },
];

function extraMarkersFromEnv() {
  const raw = String(process.env.ANTIBOT_EXTRA_CHALLENGE_MARKERS || '').trim();
  if (!raw) return [];
  return raw
    .split(/[|\n]/)
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => {
      try { return new RegExp(item, 'i'); } catch (_) { return null; }
    })
    .filter(Boolean);
}

const ENV_EXTRA_MARKERS = extraMarkersFromEnv();

function asText(value) {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  if (Buffer.isBuffer(value)) return value.toString('utf8');
  try { return JSON.stringify(value); } catch (_) { return String(value); }
}

function normalizeHeaderMap(headers) {
  const out = {};
  if (!headers || typeof headers !== 'object') return out;
  for (const [key, value] of Object.entries(headers)) {
    out[String(key).toLowerCase()] = Array.isArray(value) ? value.join('; ') : value;
  }
  return out;
}

function headerString(headers, key) {
  const map = headers && headers.__normalized ? headers : normalizeHeaderMap(headers);
  const value = map[key];
  return value == null ? '' : String(value);
}

function headersHaveCloudflare(headers) {
  const map = normalizeHeaderMap(headers);
  if (map['cf-ray'] || map['cf-cache-status'] || map['cf-mitigated']) return true;
  return String(map.server || '').toLowerCase().includes('cloudflare');
}

function headersIndicateCloudflareChallenge(headers) {
  const map = normalizeHeaderMap(headers);
  const mitigated = String(map['cf-mitigated'] || '').toLowerCase();
  return mitigated.includes('challenge') || mitigated.includes('captcha');
}

function bodyHasCloudflareChallenge(body) {
  const text = asText(body);
  if (!text) return false;
  if (CF_STRONG_MARKERS.some((re) => re.test(text))) return true;
  if (ENV_EXTRA_MARKERS.length && ENV_EXTRA_MARKERS.some((re) => re.test(text))) return true;
  if (text.length < 30000) {
    if (CF_WEAK_MARKERS.some((re) => re.test(text))) return true;
    if (HUMAN_VERIFY_MARKERS.filter((re) => re.test(text)).length >= 1
      && /cloudflare|turnstile|challenge|cf[-_]/i.test(text)) {
      return true;
    }
  }
  return false;
}

function isCloudflareChallenge(body, status, headers = null) {
  const code = Number(status) || 0;
  if (bodyHasCloudflareChallenge(body)) return true;
  if (headers && headersIndicateCloudflareChallenge(headers)) return true;
  if (CHALLENGE_BLOCK_STATUSES.has(code)) {
    if (headers == null) return true;
    return headersHaveCloudflare(headers);
  }
  return false;
}

function detectAntibot(body, status = 0, headers = null) {
  const code = Number(status) || 0;
  const text = asText(body);
  const lower = text.slice(0, 120000).toLowerCase();
  const map = normalizeHeaderMap(headers);
  const cookieJar = `${headerString(map, 'set-cookie')} ${headerString(map, 'cookie')}`;

  if (isCloudflareChallenge(text, code, headers)) {
    const kind = /turnstile|cf-turnstile|challenges\.cloudflare\.com/i.test(text)
      ? 'turnstile'
      : (headersIndicateCloudflareChallenge(headers) ? 'managed_challenge' : 'interactive');
    return { blocked: true, vendor: 'cloudflare', kind, retryable: true, status: code, reason: 'cloudflare_challenge' };
  }

  for (const sig of VENDOR_SIGNATURES) {
    const bodyHit = sig.bodyMarkers.some((re) => re.test(text));
    const presenceHeaderKeys = new Set(sig.presenceHeaderKeys || []);
    const headerHit = sig.headerKeys.some((key) => map[key] != null);
    const blockingHeaderHit = sig.headerKeys.some((key) => map[key] != null && !presenceHeaderKeys.has(key));
    const cookieHit = (sig.cookieMarkers || []).some((re) => re.test(cookieJar));
    if (bodyHit || headerHit || cookieHit) {
      const blocked = bodyHit || blockingHeaderHit || CHALLENGE_BLOCK_STATUSES.has(code);
      return {
        blocked,
        vendor: sig.vendor,
        kind: 'waf',
        retryable: blocked,
        status: code,
        reason: `${sig.vendor}_${bodyHit ? 'body' : headerHit ? 'header' : 'cookie'}`,
      };
    }
  }

  if (code === 429) {
    return { blocked: true, vendor: 'unknown', kind: 'rate_limit', retryable: true, status: code, reason: 'http_429' };
  }
  if ([502, 503, 504, 520, 521, 522, 523, 524].includes(code)) {
    return { blocked: true, vendor: 'unknown', kind: 'temporary_upstream', retryable: true, status: code, reason: 'temporary_http_status' };
  }
  if (code === 403 && /access denied|request blocked|forbidden|bot protection|security check|automated traffic/i.test(lower)) {
    return { blocked: true, vendor: 'unknown', kind: 'waf', retryable: true, status: code, reason: 'generic_waf_body' };
  }
  if (code === 403) {
    return { blocked: true, vendor: 'unknown', kind: 'forbidden', retryable: false, status: code, reason: 'http_403' };
  }

  return { blocked: false, vendor: 'none', kind: 'ok', retryable: false, status: code, reason: 'no_block_detected' };
}

module.exports = {
  CHALLENGE_BLOCK_STATUSES,
  CF_STRONG_MARKERS,
  CF_WEAK_MARKERS,
  HUMAN_VERIFY_MARKERS,
  VENDOR_SIGNATURES,
  asText,
  normalizeHeaderMap,
  headersHaveCloudflare,
  headersIndicateCloudflareChallenge,
  bodyHasCloudflareChallenge,
  isCloudflareChallenge,
  detectAntibot,
};
