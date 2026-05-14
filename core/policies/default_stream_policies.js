'use strict';

const DEFAULT_STREAM_POLICIES = [
    {
        id: 'rd_removed_webdl_guard',
        description: 'RD ha rimosso molti WEB/WEB-DL: in audit/enforce marca o nasconde WEB non verificati.',
        enabled: true,
        action: 'hide',
        severity: 'high',
        expression: '(service == "rd" || debrid == "rd") && !cached && !savedCloud && quality in ["web", "webdl", "webrip"]'
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
