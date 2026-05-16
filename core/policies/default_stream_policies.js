'use strict';

const DEFAULT_STREAM_POLICIES = [
    {
        id: 'torrentio_bad_release_guard',
        description: 'Nasconde solo payload chiaramente non riproducibili/spazzatura; WEB-DL e WEBRip restano validi.',
        enabled: true,
        action: 'hide',
        severity: 'high',
        expression: 'regex("(^|[\\\\s._\\\\-\\\\[\\\\]\\\\(\\\\)])(sample|trailer|promo|preview|screens?|proof|nfo|cover|poster|thumbs?|extras?|featurette|making[\\\\s._-]?of|behind[\\\\s._-]?the[\\\\s._-]?scenes|commentary|password|passw(or)?d|keygen|crack|patch|setup|installer|readme|virus|malware)($|[\\\\s._\\\\-\\\\[\\\\]\\\\(\\\\)])", "i")'
    },
    {
        id: 'strict_italian_negative_guard',
        description: 'Quando la config è ITA strict, segnala stream chiaramente ENG senza prova ITA.',
        enabled: true,
        action: 'hide',
        severity: 'medium',
        onlyWhen: 'itaStrict',
        expression: 'language("eng") && !language("ita") && !language("multi")'
    },
    {
        id: 'low_quality_cam_penalty',
        description: 'Penalizza CAM/TS senza rimuovere, utile quando non ci sono alternative.',
        enabled: true,
        action: 'penalize',
        penalty: 250000,
        severity: 'low',
        expression: 'quality in ["cam", "hdcam", "ts", "telesync", "telecine"]'
    },
    {
        id: 'unsafe_lazy_precache_skip',
        description: 'Policy di audit: evidenzia stream lazy/non-http che non devono essere precacheati.',
        enabled: true,
        action: 'audit',
        severity: 'info',
        expression: 'lazy || magnet || !http'
    }
];

module.exports = {
    DEFAULT_STREAM_POLICIES
};

