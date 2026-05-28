function isKitsuRequestId(value) {
    const raw = String(value || '').replace(/^ai-recs:/i, '').trim();
    return /^kitsu(?::|_)?\d+/i.test(raw);
}

function shouldAutoEnableAnimeUnityForKitsu(filters = {}, id = '') {
    if (!filters || Object.prototype.hasOwnProperty.call(filters, 'enableAnimeUnity')) return false;
    return isKitsuRequestId(id);
}

function applyAnimeUnityKitsuBackCompat(config = {}, id = '') {
    const filters = config?.filters || {};
    if (!shouldAutoEnableAnimeUnityForKitsu(filters, id)) {
        return { config, autoAnimeUnity: false };
    }

    return {
        config: {
            ...config,
            filters: {
                ...filters,
                enableAnimeUnity: true,
                __autoAnimeUnityKitsu: true
            }
        },
        autoAnimeUnity: true
    };
}

module.exports = {
    applyAnimeUnityKitsuBackCompat,
    isKitsuRequestId,
    shouldAutoEnableAnimeUnityForKitsu
};
