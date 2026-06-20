'use strict';

const IMPIT_BROWSER_VERSIONS = Object.freeze({
    chrome: Object.freeze([142]),
    firefox: Object.freeze([144]),
    okhttp: Object.freeze([3, 4, 5])
});

function ceilingFromImpitVersions(versions) {
    const out = {};
    for (const [prefix, list] of Object.entries(versions || {})) {
        if (!Array.isArray(list) || !list.length) continue;
        out[prefix] = list.reduce((max, value) => (Number(value) > max ? Number(value) : max), 0);
    }
    if (out.chrome != null && out.edge == null) out.edge = out.chrome;
    return out;
}

const DERIVED_CEILING = ceilingFromImpitVersions(IMPIT_BROWSER_VERSIONS);

const IMPIT_CEILING = Object.freeze({
    chrome: DERIVED_CEILING.chrome,
    edge: DERIVED_CEILING.edge,
    firefox: DERIVED_CEILING.firefox
});

function majorFromMatch(value, regex) {
    const match = String(value || '').match(regex);
    if (!match) return null;
    const parsed = Number.parseInt(match[1], 10);
    return Number.isFinite(parsed) ? parsed : null;
}

function chromeMajorFromUA(userAgent) {
    return majorFromMatch(userAgent, /Chrome\/(\d+)/i);
}

function edgeMajorFromUA(userAgent) {
    return majorFromMatch(userAgent, /Edg(?:[A-Za-z]+)?\/(\d+)/i);
}

function firefoxMajorFromUA(userAgent) {
    return majorFromMatch(userAgent, /Firefox\/(\d+)/i);
}

function classifyFamily(userAgent) {
    const ua = String(userAgent || '');
    if (/Firefox\/\d+/i.test(ua)) return 'firefox';
    if (/Edg(?:[A-Za-z]+)?\/\d+/i.test(ua)) return 'edge';
    if (/Chrome\/\d+/i.test(ua)) return 'chrome';
    return 'other';
}

function evaluateUserAgent(userAgent, ceiling = IMPIT_CEILING) {
    const ua = String(userAgent || '');
    const family = classifyFamily(ua);
    const violations = [];

    if (family === 'firefox') {
        const major = firefoxMajorFromUA(ua);
        if (major !== ceiling.firefox) {
            violations.push({ family, expected: ceiling.firefox, found: major, userAgent: ua });
        }
    } else if (family === 'edge') {
        const chromeMajor = chromeMajorFromUA(ua);
        const edgeMajor = edgeMajorFromUA(ua);
        if (chromeMajor !== ceiling.chrome) {
            violations.push({ family: 'edge:chrome', expected: ceiling.chrome, found: chromeMajor, userAgent: ua });
        }
        if (edgeMajor !== ceiling.edge) {
            violations.push({ family, expected: ceiling.edge, found: edgeMajor, userAgent: ua });
        }
    } else if (family === 'chrome') {
        const major = chromeMajorFromUA(ua);
        if (major !== ceiling.chrome) {
            violations.push({ family, expected: ceiling.chrome, found: major, userAgent: ua });
        }
    }

    return { family, ok: violations.length === 0, violations };
}

function evaluateUserAgents(userAgents, ceiling = IMPIT_CEILING) {
    const violations = [];
    for (const ua of userAgents || []) {
        const result = evaluateUserAgent(ua, ceiling);
        if (!result.ok) violations.push(...result.violations);
    }
    return { ok: violations.length === 0, violations };
}

module.exports = {
    IMPIT_BROWSER_VERSIONS,
    IMPIT_CEILING,
    ceilingFromImpitVersions,
    chromeMajorFromUA,
    edgeMajorFromUA,
    firefoxMajorFromUA,
    classifyFamily,
    evaluateUserAgent,
    evaluateUserAgents
};
