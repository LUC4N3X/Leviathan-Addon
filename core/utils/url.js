'use strict';

const net = require('net');

function normalizeBracketedHost(value) {
    return String(value || '').trim().replace(/^\[/, '').replace(/\]$/, '');
}

function parseForwardedProto(value, fallback = 'https') {
    const candidate = String(value || '').split(',')[0].trim().toLowerCase();
    if (candidate === 'http' || candidate === 'https') return candidate;
    return fallback;
}

function sanitizeHostHeader(value) {
    const raw = String(value || '').trim();
    if (!raw) return null;
    if (/[\r\n\t\s]/.test(raw)) return null;
    if (/[\\/@?#]/.test(raw)) return null;

    try {
        const parsed = new URL(`http://${raw}`);
        if (!parsed.hostname || parsed.username || parsed.password) return null;
        const hostname = parsed.hostname.replace(/\.$/, '');
        const port = parsed.port ? `:${parsed.port}` : '';
        return net.isIPv6(hostname) ? `[${hostname}]${port}` : `${hostname}${port}`;
    } catch {
        return null;
    }
}

function normalizeOriginCandidate(value) {
    try {
        const parsed = new URL(String(value || '').trim());
        if (!/^https?:$/.test(parsed.protocol)) return null;
        if (!parsed.hostname || parsed.username || parsed.password) return null;
        return `${parsed.protocol}//${parsed.host}`;
    } catch {
        return null;
    }
}

function getRequestOrigin(req, { fallbackOrigin = 'https://localhost' } = {}) {
    const envOrigin = normalizeOriginCandidate(process.env.PUBLIC_BASE_URL)
        || normalizeOriginCandidate(process.env.ADDON_URL);
    if (envOrigin) return envOrigin;

    const fallback = normalizeOriginCandidate(fallbackOrigin) || 'https://localhost';
    const host = sanitizeHostHeader(req?.get ? req.get('host') : req?.headers?.host);
    if (!host) return fallback;

    const fallbackProto = String(req?.protocol || '').toLowerCase() === 'http' ? 'http' : 'https';
    const protocol = parseForwardedProto(req?.headers?.['x-forwarded-proto'], fallbackProto);
    return `${protocol}://${host}`;
}

function getRequestClientIp(req) {
    const direct = String(req?.ip || '').trim();
    if (direct) return direct;
    const forwarded = String(req?.headers?.['x-forwarded-for'] || '').split(',')[0].trim();
    return forwarded || 'unknown';
}

function isPrivateIpv4(value) {
    const octets = String(value || '').split('.').map((part) => parseInt(part, 10));
    if (octets.length !== 4 || octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;

    const [a, b] = octets;
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && (b === 168 || b === 0)) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
    if (a === 198 && (b === 18 || b === 19)) return true;
    return false;
}

function isPrivateIpv6(value) {
    const normalized = normalizeBracketedHost(value).toLowerCase();
    if (!normalized) return false;
    if (normalized === '::1' || normalized === '::') return true;
    if (normalized.startsWith('fe80:')) return true;
    if (normalized.startsWith('fc') || normalized.startsWith('fd')) return true;

    if (normalized.startsWith('::ffff:')) {
        const mapped = normalized.slice(7);
        if (net.isIP(mapped) === 4) return isPrivateIpv4(mapped);
    }
    return false;
}

function isPrivateIp(value) {
    const host = normalizeBracketedHost(value);
    const family = net.isIP(host);
    if (family === 4) return isPrivateIpv4(host);
    if (family === 6) return isPrivateIpv6(host);
    return false;
}

function isLocalHostname(value) {
    const host = normalizeBracketedHost(value).toLowerCase().replace(/\.$/, '');
    return host === 'localhost'
        || host.endsWith('.localhost')
        || host.endsWith('.local')
        || host.endsWith('.internal');
}

function isSafeRemoteUrl(value, { allowPrivate = false } = {}) {
    try {
        const parsed = new URL(String(value || '').trim());
        if (!/^https?:$/.test(parsed.protocol)) return false;
        if (parsed.username || parsed.password) return false;
        const hostname = normalizeBracketedHost(parsed.hostname);
        if (!hostname) return false;
        if (!allowPrivate && (isLocalHostname(hostname) || isPrivateIp(hostname))) return false;
        return true;
    } catch {
        return false;
    }
}

module.exports = {
    getRequestClientIp,
    getRequestOrigin,
    isLocalHostname,
    isPrivateIp,
    isSafeRemoteUrl,
    normalizeOriginCandidate,
    parseForwardedProto,
    sanitizeHostHeader
};
