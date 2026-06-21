'use strict';

const DEFAULT_DB_FIRST_REAL_MIN = 5;

function toBool(value) {
    if (value === true) return true;
    if (value === false) return false;
    const text = String(value ?? '').trim().toLowerCase();
    if (!text) return null;
    if (['1', 'true', 'yes', 'y', 'on', 'cached', 'verified', 'cached_verified'].includes(text)) return true;
    if (['0', 'false', 'no', 'n', 'off', 'uncached', 'likely_uncached', 'uncached_terminal'].includes(text)) return false;
    return null;
}

function readInt(value, fallback = 0) {
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) ? parsed : fallback;
}

function readNumber(value, fallback = 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
}

function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
}

function getCandidateHash(item = {}) {
    const raw = String(item?.hash || item?.infoHash || item?.info_hash || '').trim().toUpperCase();
    if (/^[A-F0-9]{40}$/.test(raw)) return raw;
    const magnet = String(item?.magnet || item?.magnetLink || item?.url || item?.directUrl || item?._externalDirectUrl || '').trim();
    const match = magnet.match(/btih:([A-Fa-f0-9]{40})/i);
    return match ? match[1].toUpperCase() : null;
}

function getCandidateFileIdx(item = {}) {
    const values = [
        item?.fileIdx,
        item?.fileIndex,
        item?.file_index,
        item?.rd_file_index,
        item?.tb_file_id,
        item?.episodeFileHint?.fileIdx,
        item?.episodeFileHint?.fileIndex,
        item?._episodeFileHint?.fileIdx,
        item?._episodeFileHint?.fileIndex
    ];
    for (const value of values) {
        const parsed = Number(value);
        if (Number.isInteger(parsed) && parsed >= 0) return parsed;
    }
    return -1;
}

function getCandidateKey(item = {}) {
    const hash = getCandidateHash(item);
    if (hash) return `${hash}:${getCandidateFileIdx(item)}`;
    const title = String(item?.title || item?.name || item?.filename || item?.file_title || '').trim().toLowerCase();
    const source = String(item?.source || item?.externalProvider || item?.externalAddon || item?._sourceGroup || '').trim().toLowerCase();
    return title ? `${title}:${source}:${getCandidateFileIdx(item)}` : null;
}

function getEvidenceText(item = {}) {
    const languageInfo = item?.languageInfo || item?._externalLanguageInfo || {};
    return [
        item?.title,
        item?.name,
        item?.filename,
        item?.file_title,
        item?.formatterTitle,
        item?._formatterTitle,
        item?.rawDescription,
        item?.source,
        item?.provider,
        item?.externalProvider,
        item?.externalAddon,
        item?.externalGroup,
        item?.releaseGroup,
        item?.language,
        Array.isArray(item?.languages) ? item.languages.join(' ') : item?.languages,
        item?.audio,
        languageInfo?.displayLabel,
        languageInfo?.reason,
        Array.isArray(languageInfo?.detectedLanguages) ? languageInfo.detectedLanguages.join(' ') : languageInfo.detectedLanguages
    ]
        .filter(Boolean)
        .map((value) => String(value))
        .join(' ');
}

function isDbCandidate(item = {}) {
    const group = String(item?._sourceGroup || item?.sourceGroup || '').toLowerCase();
    return Boolean(
        item?._dbPrimary === true ||
        item?._myDb === true ||
        item?._localDb === true ||
        item?._remoteDb === true ||
        item?._dbEpisodeMapping === true ||
        item?._dbLastCachedCheck ||
        item?._dbNextCachedCheck ||
        item?._dbProvider ||
        group === 'db' ||
        group === 'remote_db' ||
        group === 'local_db'
    );
}

function isExternalCandidate(item = {}) {
    const group = String(item?._sourceGroup || item?.sourceGroup || item?.externalGroup || '').toLowerCase();
    return Boolean(
        item?.isExternal === true ||
        group === 'external' ||
        group === 'torrentio' ||
        group === 'mediafusion' ||
        group === 'meteor' ||
        item?.externalAddon ||
        item?.externalProvider
    );
}

function getResolutionScore(item = {}) {
    const text = getEvidenceText(item);
    if (/\b(?:4320p|8k)\b/i.test(text)) return 900;
    if (/\b(?:2160p|4k|uhd)\b/i.test(text)) return 800;
    if (/\b(?:1440p|2k|qhd)\b/i.test(text)) return 650;
    if (/\b1080p\b/i.test(text)) return 550;
    if (/\b720p\b/i.test(text)) return 350;
    if (/\b(?:480p|576p|sd)\b/i.test(text)) return 120;
    return 0;
}

function getKnownCacheState(item = {}, service = '') {
    const normalizedService = String(service || '').toLowerCase();
    const rdState = String(item?._rdCacheState || item?.rdCacheState || item?.cacheState || item?.rd_cache_state || '').toLowerCase().trim();
    const tbStateRaw = String(item?._tbCacheStateRaw || item?.tb_cache_state || item?.tbCacheStateRaw || '').toLowerCase().trim();
    const tbState = String(item?._tbCacheState || item?.tbCacheState || '').toLowerCase().trim();

    if (normalizedService === 'tb') {
        if (item?._tbCached === true || item?.tbCached === true || item?.tb_cached === true || tbStateRaw === 'cached_verified' || tbState === 'cached') return 'cached';
        if (item?._tbCached === false || item?.tbCached === false || item?.tb_cached === false || tbStateRaw === 'uncached' || tbState === 'uncached' || tbState === 'likely_uncached') return 'uncached';
        if (tbStateRaw === 'queued') return 'queued';
        if (tbStateRaw === 'error') return 'error';
    }

    if (item?._dbCachedRd === true || item?.cached_rd === true || rdState === 'cached' || rdState === 'rd_cached' || rdState === 'instant' || rdState === 'instant_available') return 'cached';
    if (item?._dbCachedRd === false || item?.cached_rd === false || rdState === 'uncached' || rdState === 'likely_uncached' || rdState === 'uncached_terminal') return 'uncached';
    if (rdState === 'download') return 'download';
    if (rdState === 'probing' || rdState === 'likely_cached') return 'likely_cached';
    return 'unknown';
}

function isCachedCandidate(item = {}, service = '') {
    return getKnownCacheState(item, service) === 'cached';
}

function isKnownUncachedCandidate(item = {}, service = '') {
    const state = getKnownCacheState(item, service);
    return state === 'uncached' || state === 'error';
}

function hasPositiveItalianEvidence(item = {}) {
    const info = item?.languageInfo || item?._externalLanguageInfo || {};
    if (item?.hasItalianAudio === true || item?.isItalian === true || item?._externalHasItalianAudio === true || item?._externalIsItalian === true) return true;
    if (info?.hasAudioItalian === true || info?.isItalian === true) return true;
    const text = getEvidenceText(item);
    if (/\b(?:ita|italian|italiano|audio\s*ita|italian\s*audio)\b/i.test(text) && !/\b(?:sub[\s._-]*ita|subbed|subs?|subtitle|sottotitoli)\b/i.test(text)) return true;
    if (/\b(?:multi|dual[\s._-]*audio)\b/i.test(text)) return true;
    return false;
}

function hasOnlyForeignEvidence(item = {}) {
    const info = item?.languageInfo || item?._externalLanguageInfo || {};
    if (info?.hasNegativeLanguage === true && !hasPositiveItalianEvidence(item)) return true;
    const text = getEvidenceText(item);
    if (/\b(?:eng(?:lish)?|spa(?:nish)?|latino|fre(?:nch)?|ger(?:man)?|deu|rus|jpn|japanese|kor|hindi)\b/i.test(text) && !hasPositiveItalianEvidence(item)) return true;
    return false;
}

function getItalianConfidence(item = {}, langMode = 'ita') {
    if (langMode !== 'ita') return 100;
    if (item?._torrentioFlagOnlyItalianRejected === true) return 0;

    const info = item?.languageInfo || item?._externalLanguageInfo || {};
    const explicit = readNumber(item?._externalLanguageConfidence, NaN);
    if (Number.isFinite(explicit) && explicit > 0) return clamp(explicit, 0, 100);

    const infoConfidence = readNumber(info?.confidence, NaN);
    if ((info?.hasAudioItalian === true || info?.isItalian === true) && Number.isFinite(infoConfidence)) return clamp(infoConfidence, 60, 100);
    if (item?.hasItalianAudio === true || item?._externalHasItalianAudio === true) return 98;
    if (item?.isItalian === true || item?._externalIsItalian === true) return 90;
    if (hasPositiveItalianEvidence(item)) return 82;
    if (hasOnlyForeignEvidence(item)) return 0;
    if (isDbCandidate(item)) return 55;
    return isExternalCandidate(item) ? 15 : 35;
}

function isLikelyFakeItalian(item = {}, langMode = 'ita', callbacks = {}) {
    if (langMode !== 'ita') return false;
    if (item?._torrentioFlagOnlyItalianRejected === true) return true;

    if (typeof callbacks.keepLanguageCandidateForMode === 'function' && isExternalCandidate(item) && !isDbCandidate(item)) {
        try {
            if (callbacks.keepLanguageCandidateForMode(item) === false) return true;
        } catch (_) {}
    }

    const confidence = getItalianConfidence(item, langMode);
    if (confidence <= 0) return true;
    if (hasOnlyForeignEvidence(item) && confidence < 70) return true;
    if (isExternalCandidate(item) && !isDbCandidate(item) && confidence < 45) return true;
    return false;
}

function scoreCandidate(item = {}, context = {}) {
    const service = context.service || '';
    const langMode = context.langMode || 'ita';
    const cacheState = getKnownCacheState(item, service);
    const cached = cacheState === 'cached';
    const db = isDbCandidate(item);
    const external = isExternalCandidate(item);
    const seeders = Math.max(0, readInt(item?.seeders, 0));
    const size = Math.max(0, readNumber(item?._size || item?.sizeBytes || item?.mainFileSize || item?.folderSize, 0));
    const languageConfidence = getItalianConfidence(item, langMode);
    const fakeItalian = isLikelyFakeItalian(item, langMode, context);
    const unavailable = isKnownUncachedCandidate(item, service);

    let score = 0;
    if (db) score += 6000;
    if (cached) score += 5000;
    if (cacheState === 'likely_cached') score += 1800;
    if (cacheState === 'download') score -= 900;
    if (external) score -= 350;
    score += languageConfidence * 28;
    score += getResolutionScore(item);
    score += Math.min(1200, seeders * 18);
    score += Math.min(1000, Math.floor(size / (1024 * 1024 * 1024)) * 8);
    if (item?._torrentioRdAuthority === true || item?._mediafusionRdAuthority === true) score += 900;
    if (item?._tbExternalRescue === true) score -= 120;
    if (fakeItalian) score -= 20000;
    if (unavailable) score -= 20000;

    return Math.round(score);
}

function annotateCandidate(item = {}, context = {}) {
    const service = context.service || '';
    const langMode = context.langMode || 'ita';
    const cacheState = getKnownCacheState(item, service);
    const languageConfidence = getItalianConfidence(item, langMode);
    const fakeItalian = isLikelyFakeItalian(item, langMode, context);
    const db = isDbCandidate(item);
    const external = isExternalCandidate(item);
    const real = db && (cacheState === 'cached' || cacheState === 'likely_cached' || (!isKnownUncachedCandidate(item, service) && getCandidateHash(item)));

    item._torrentHealth = {
        stage: context.stage || 'ranked',
        key: getCandidateKey(item),
        hash: getCandidateHash(item),
        fileIdx: getCandidateFileIdx(item),
        sourceClass: db ? 'db' : (external ? 'external' : 'native'),
        cacheState,
        cached: cacheState === 'cached',
        languageConfidence,
        fakeItalian,
        dbReal: Boolean(real),
        score: 0
    };
    item._torrentHealthLanguageConfidence = languageConfidence;
    item._torrentHealthCacheState = cacheState;
    item._torrentHealthSourceClass = item._torrentHealth.sourceClass;
    item._torrentHealthFakeItalian = fakeItalian;
    item._torrentHealthScore = scoreCandidate(item, context);
    item._torrentHealth.score = item._torrentHealthScore;
    return item;
}

function countRealDbCandidates(items = [], context = {}) {
    const seen = new Set();
    let count = 0;
    for (const item of Array.isArray(items) ? items : []) {
        if (!item || !isDbCandidate(item)) continue;
        const cacheState = getKnownCacheState(item, context.service || '');
        if (isKnownUncachedCandidate(item, context.service || '')) continue;
        if (String(context.service || '').toLowerCase() === 'tb' && cacheState !== 'cached') continue;
        const key = getCandidateKey(item);
        if (!key || seen.has(key)) continue;
        seen.add(key);
        count += 1;
    }
    return count;
}

function shouldDropByHealth(item = {}, context = {}) {
    const service = String(context.service || '').toLowerCase();
    const langMode = context.langMode || 'ita';
    const strictCache = context.strictCache === true || (service === 'tb' && context.strictTorboxCache !== false);

    if (isLikelyFakeItalian(item, langMode, context)) return 'fake_italian';
    if (isKnownUncachedCandidate(item, service)) return 'uncached';
    if (strictCache && service === 'tb' && !isCachedCandidate(item, service)) return 'tb_not_verified';
    return '';
}

function applyDbFirstPolicy(items = [], context = {}) {
    const service = String(context.service || '').toLowerCase();

    // External addons (Torrentio/MediaFusion/Meteor) are the most reliable source of
    // Real-Debrid cached torrents. The DB-first precedence is a TorBox-oriented policy
    // (see TORBOX_DB_FIRST_REAL_MIN): applied to RD it strips exactly the external
    // results that RD is able to resolve, which is why RD returns almost nothing while
    // TB is fine. For RD we keep (prioritize) external candidates so the RD direct
    // resolver can turn them into playable streams. Opt out with RD_EXTERNAL_ADDON_PRIORITY=0.
    if (service === 'rd' && toBool(process.env.RD_EXTERNAL_ADDON_PRIORITY ?? '1') !== false) {
        return { results: items, dbReal: countRealDbCandidates(items, context), externalDropped: 0 };
    }

    const dbFirstMin = readInt(context.dbFirstMin ?? process.env.TORRENT_HEALTH_DB_FIRST_MIN, DEFAULT_DB_FIRST_REAL_MIN);
    if (dbFirstMin <= 0) return { results: items, dbReal: 0, externalDropped: 0 };

    const dbReal = countRealDbCandidates(items, context);
    if (dbReal < dbFirstMin) return { results: items, dbReal, externalDropped: 0 };

    const results = [];
    let externalDropped = 0;
    for (const item of items) {
        if (isExternalCandidate(item) && !isDbCandidate(item)) {
            externalDropped += 1;
            continue;
        }
        results.push(item);
    }
    return { results, dbReal, externalDropped };
}

function applyTorrentHealthEngine(items = [], context = {}) {
    const source = Array.isArray(items) ? items.filter(Boolean) : [];
    const stats = {
        stage: context.stage || 'ranked',
        in: source.length,
        annotated: 0,
        droppedFakeItalian: 0,
        droppedUncached: 0,
        droppedTbUnverified: 0,
        droppedExternalByDbFirst: 0,
        dbReal: 0,
        out: 0
    };

    const annotated = source.map((item) => {
        stats.annotated += 1;
        return annotateCandidate(item, context);
    });

    const filtered = [];
    for (const item of annotated) {
        const dropReason = shouldDropByHealth(item, context);
        if (dropReason === 'fake_italian') {
            stats.droppedFakeItalian += 1;
            continue;
        }
        if (dropReason === 'uncached') {
            stats.droppedUncached += 1;
            continue;
        }
        if (dropReason === 'tb_not_verified') {
            stats.droppedTbUnverified += 1;
            continue;
        }
        filtered.push(item);
    }

    const dbFirst = applyDbFirstPolicy(filtered, context);
    stats.dbReal = dbFirst.dbReal;
    stats.droppedExternalByDbFirst = dbFirst.externalDropped;

    const withOrder = dbFirst.results.map((item, index) => ({ item, index }));
    if (context.sort !== false) {
        withOrder.sort((a, b) => {
            const diff = readNumber(b.item?._torrentHealthScore, 0) - readNumber(a.item?._torrentHealthScore, 0);
            return diff || a.index - b.index;
        });
    }

    const results = withOrder.map(({ item }) => item);
    stats.out = results.length;
    return { results, stats };
}

function buildHealthLogLine(stats = {}) {
    return `[TORRENT HEALTH] stage=${stats.stage || 'ranked'} in=${stats.in || 0} out=${stats.out || 0} dbReal=${stats.dbReal || 0} fakeItalian=${stats.droppedFakeItalian || 0} uncached=${stats.droppedUncached || 0} tbUnverified=${stats.droppedTbUnverified || 0} dbFirstExternalDrop=${stats.droppedExternalByDbFirst || 0}`;
}

async function persistTorrentHealthSnapshot(items = [], context = {}) {
    const dbHelper = context.dbHelper;
    if (!dbHelper || !Array.isArray(items) || items.length === 0) return 0;

    const service = String(context.service || '').toLowerCase();
    const meta = context.meta || {};
    const imdb_id = meta?.imdb_id || null;
    const imdb_season = Number.isInteger(Number(meta?.season)) && Number(meta.season) > 0 ? Number(meta.season) : null;
    const imdb_episode = Number.isInteger(Number(meta?.episode)) && Number(meta.episode) > 0 ? Number(meta.episode) : null;

    if (service === 'tb' && typeof dbHelper.updateTbCacheStatus === 'function') {
        const rows = items
            .map((item) => {
                const hash = getCandidateHash(item);
                if (!hash || item?._tbLiveChecked !== true) return null;
                return {
                    hash,
                    cached: item?._tbCached === true,
                    tb_cache_state: item?._tbCacheStateRaw || (item?._tbCached === true ? 'cached_verified' : 'uncached'),
                    confidence: item?._tbCacheConfidence || undefined,
                    match_reason: item?._tbCacheMatchReason || undefined,
                    tb_file_id: getCandidateFileIdx(item) >= 0 ? getCandidateFileIdx(item) : undefined,
                    tb_file_size: readNumber(item?._size || item?.sizeBytes, 0) || undefined,
                    title: item?.file_title || item?.filename || item?.title || null,
                    imdb_id,
                    imdb_season,
                    imdb_episode
                };
            })
            .filter(Boolean);
        if (rows.length === 0) return 0;
        return dbHelper.updateTbCacheStatus(rows);
    }

    if (service === 'rd' && typeof dbHelper.updateRdCacheStatus === 'function') {
        const rows = items
            .map((item) => {
                const hash = getCandidateHash(item);
                if (!hash) return null;
                const state = getKnownCacheState(item, service);
                if (!['cached', 'uncached'].includes(state)) return null;
                return {
                    hash,
                    cached: state === 'cached',
                    state: state === 'cached' ? 'cached' : 'likely_uncached',
                    rd_file_index: getCandidateFileIdx(item) >= 0 ? getCandidateFileIdx(item) : undefined,
                    rd_file_size: readNumber(item?._size || item?.sizeBytes, 0) || undefined,
                    title: item?.file_title || item?.filename || item?.title || null,
                    failures: state === 'cached' ? 0 : 1,
                    next_hours: state === 'cached' ? 168 : 24,
                    imdb_id,
                    imdb_season,
                    imdb_episode
                };
            })
            .filter(Boolean);
        if (rows.length === 0) return 0;
        return dbHelper.updateRdCacheStatus(rows);
    }

    return 0;
}

module.exports = {
    DEFAULT_DB_FIRST_REAL_MIN,
    applyTorrentHealthEngine,
    buildHealthLogLine,
    countRealDbCandidates,
    getCandidateHash,
    getCandidateKey,
    getKnownCacheState,
    getItalianConfidence,
    isCachedCandidate,
    isDbCandidate,
    isExternalCandidate,
    isLikelyFakeItalian,
    persistTorrentHealthSnapshot,
    scoreCandidate
};
