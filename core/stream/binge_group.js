function normalizeBingePart(value, fallback = 'x') {
    const normalized = String(value || '')
        .normalize('NFKD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[|]+/g, ' ')
        .replace(/[^a-z0-9+._-]+/gi, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 48);
    return normalized || fallback;
}

function buildQualityCompatibleBingeGroup({ service, quality, details = {}, infoHash, releaseGroup, language }) {
    const hdr = Array.isArray(details.dynamicRange) && details.dynamicRange.length
        ? details.dynamicRange.join('+')
        : (/hdr|dolby\s*vision|\bdv\b/i.test(String(details.tags || '')) ? 'HDR' : 'SDR');
    const codec = details.videoCodec || details.codec || '';
    const audio = [details.audioCodec || details.audio, details.audioChannels].filter(Boolean).join('-');
    const group = releaseGroup || details.releaseGroup || (infoHash ? `hash-${String(infoHash).slice(0, 12)}` : 'nohash');
    return [
        'Leviathan',
        normalizeBingePart(service, 'svc'),
        normalizeBingePart(quality, 'q'),
        normalizeBingePart(hdr, 'sdr'),
        normalizeBingePart(codec, 'codec'),
        normalizeBingePart(audio, 'audio'),
        normalizeBingePart(language, 'lang'),
        normalizeBingePart(group, 'group')
    ].join('|');
}

module.exports = {
    buildQualityCompatibleBingeGroup,
    normalizeBingePart
};
