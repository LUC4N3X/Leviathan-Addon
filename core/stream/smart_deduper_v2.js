'use strict';

const crypto = require('crypto');
const {
    normalizeText,
    detectResolution,
    detectQuality,
    detectEncode,
    detectLanguage,
    detectService,
    detectCacheState,
    getSizeBytes
} = require('../policies/stream_expression');

function envFlag(name, fallback = true) {
    const raw = process.env[name];
    if (raw === undefined || raw === null || raw === '') return fallback;
    return /^(1|true|yes|y|on)$/i.test(String(raw).trim());
}

function normalizeMode(value) {
    const mode = String(value || '').trim().toLowerCase();
    if (['off', 'disabled', '0', 'false'].includes(mode)) return 'off';
    if (['audit', 'dry', 'dryrun', 'dry-run'].includes(mode)) return 'audit';
    if (['aggressive', 'max'].includes(mode)) return 'aggressive';
    return 'conservative';
}

function extractInfoHash(item = {}) {
    const values = [
        item.infoHash,
        item.infohash,
        item.info_hash,
        item.hash,
        item.btih,
        item.magnet,
        item.magnetLink,
        item.url,
        item.behaviorHints?.infoHash,
        item.behaviorHints?.hash
    ].filter(Boolean);

    for (const raw of values) {
        const text = String(raw || '');
        const direct = text.match(/\b([a-f0-9]{40})\b/i);
        if (direct) return direct[1].toUpperCase();
        const btih = text.match(/btih:([a-f0-9]{40})/i);
        if (btih) return btih[1].toUpperCase();
    }
    return '';
}

function extractFileIdx(item = {}) {
    const values = [
        item.fileIdx,
        item.fileIndex,
        item.file_index,
        item.rd_file_index,
        item.behaviorHints?.fileIdx,
        item.behaviorHints?.fileIndex,
        item.episodeFileHint?.fileIdx,
        item.episodeFileHint?.fileIndex,
        item._episodeFileHint?.fileIdx,
        item._episodeFileHint?.fileIndex
    ];
    for (const value of values) {
        const n = Number(value);
        if (Number.isInteger(n) && n >= 0) return n;
    }
    return null;
}

function extractFilename(item = {}) {
    return normalizeText([
        item.filename,
        item.fileName,
        item.file_title,
        item.file_name,
        item.title,
        item.name,
        item.behaviorHints?.filename,
        item.episodeFileHint?.fileName,
        item._episodeFileHint?.fileName
    ].filter(Boolean).join(' '))
        .replace(/\b(mkv|mp4|avi|mov|wmv|webm|m4v|ts|m2ts)\b/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function getSizeBucket(item = {}, bucketMb = 128) {
    const bytes = getSizeBytes(item);
    if (!Number.isFinite(bytes) || bytes <= 0) return '';
    return String(Math.max(1, Math.round(bytes / (bucketMb * 1024 * 1024))));
}

function getEpisodeScope(meta = {}) {
    const season = Number(meta?.season || 0) || 0;
    const episode = Number(meta?.episode || 0) || 0;
    if (season > 0 && episode > 0) return `s${season}e${episode}`;
    return '';
}

function isSeries(meta = {}, item = {}) {
    return Boolean(meta?.isSeries || meta?.season || meta?.episode || item.season || item.episode);
}

function sha(value) {
    return crypto.createHash('sha1').update(String(value || '')).digest('hex').slice(0, 20);
}

function buildSmartKey(item = {}, options = {}) {
    const meta = options.meta || {};
    const filename = extractFilename(item);
    if (filename.length < 10) return '';

    const resolution = detectResolution(item);
    const quality = detectQuality(item);
    const encode = detectEncode(item);
    const languages = detectLanguage(item).join('+') || 'unknown';
    const service = detectService(item) || 'unknown';
    const sizeBucket = getSizeBucket(item, Number(process.env.LEVIATHAN_SMART_DEDUPE_V2_BUCKET_MB || 128) || 128);
    const episodeScope = isSeries(meta, item) ? getEpisodeScope(meta) : 'movie';

    // Conservative: never merge by title alone.
    if (!resolution || !sizeBucket) return '';
    if (isSeries(meta, item) && !episodeScope) return '';

    const signature = [
        episodeScope,
        filename,
        resolution,
        quality || 'q?',
        encode || 'enc?',
        languages,
        service,
        sizeBucket
    ].join('|');

    return `smartV2:${sha(signature)}`;
}

function buildKeys(item = {}, options = {}) {
    const meta = options.meta || {};
    const hash = extractInfoHash(item);
    const fileIdx = extractFileIdx(item);
    const series = isSeries(meta, item);
    const keys = [];

    if (hash) {
        if (!series) {
            keys.push(`hash:${hash}`);
        } else if (fileIdx !== null) {
            keys.push(`hashFile:${hash}:${fileIdx}`);
        } else {
            const ep = getEpisodeScope(meta);
            if (ep) keys.push(`hashEpisode:${hash}:${ep}`);
        }
    }

    const smart = buildSmartKey(item, options);
    if (smart) keys.push(smart);

    return [...new Set(keys)];
}

function cachePriority(item = {}) {
    const state = detectCacheState(item);
    if (item.isSavedCloud || item._savedCloud || item.savedCloud) return 90;
    if (state === 'cached') return 80;
    if (state === 'likely_cached') return 60;
    if (state === 'probing') return 35;
    if (state === 'unknown') return 25;
    if (state === 'uncached') return 10;
    return 20;
}

function servicePriority(item = {}) {
    const service = detectService(item);
    if (service === 'rd' || service === 'tb') return 50;
    const text = normalizeText([item.source, item.provider, item.externalAddon, item.externalGroup].filter(Boolean).join(' '));
    if (/torrentio/.test(text)) return 40;
    if (/mediafusion/.test(text)) return 35;
    if (/db|database|leviathan/.test(text)) return 30;
    return 20;
}

function scoreItem(item = {}) {
    const seeders = Number(item.seeders ?? item.seeds ?? item.peers ?? 0) || 0;
    const fileIdx = extractFileIdx(item) !== null ? 10000 : 0;
    const explicit = Number(item._compositeScore ?? item._score ?? item.score ?? 0) || 0;
    const size = Math.min(5000, Math.floor((getSizeBytes(item) || 0) / (1024 * 1024 * 1024)) * 10);
    return explicit + cachePriority(item) * 100000 + servicePriority(item) * 1000 + fileIdx + Math.min(seeders, 5000) + size;
}

function collectSources(group = []) {
    const seen = new Set();
    const out = [];
    for (const item of group) {
        for (const value of [item.source, item.provider, item.externalAddon, item.externalGroup]) {
            const text = String(value || '').trim();
            const key = text.toLowerCase();
            if (text && !seen.has(key)) {
                seen.add(key);
                out.push(text.slice(0, 64));
            }
        }
    }
    return out;
}

function chooseWinner(group = []) {
    return [...group].sort((a, b) => scoreItem(b) - scoreItem(a))[0] || group[0];
}

function annotateWinner(winner, group, key) {
    if (!winner || group.length <= 1) return winner;
    const sources = collectSources(group);
    winner._smartDedupeV2 = true;
    winner._smartDedupeV2Key = key;
    winner._smartDedupeV2MergedCount = Math.max(Number(winner._smartDedupeV2MergedCount || 1) || 1, group.length);
    winner._smartDedupeV2Sources = sources;
    winner._dedupeMergedCount = Math.max(Number(winner._dedupeMergedCount || 1) || 1, group.length);
    winner._dedupeMergedSources = [...new Set([...(winner._dedupeMergedSources || []), ...sources])];
    winner._smartDedupeV2BestCacheState = group
        .map(detectCacheState)
        .sort((a, b) => cachePriority({ cacheState: b }) - cachePriority({ cacheState: a }))[0] || detectCacheState(winner);
    return winner;
}

function applySmartDeduperV2(items = [], options = {}) {
    const list = Array.isArray(items) ? items : [];
    const mode = envFlag('LEVIATHAN_SMART_DEDUPE_V2_ENABLED', true)
        ? normalizeMode(options.mode || process.env.LEVIATHAN_SMART_DEDUPE_V2_MODE || 'conservative')
        : 'off';

    const stats = {
        mode,
        input: list.length,
        output: list.length,
        groups: 0,
        merged: 0,
        auditOnly: mode === 'audit'
    };

    if (mode === 'off' || list.length < 2) return { items: list, stats };

    const keyToItems = new Map();
    const itemToKeys = new Map();

    list.forEach((item) => {
        const keys = buildKeys(item, options);
        itemToKeys.set(item, keys);
        keys.forEach((key) => {
            if (!keyToItems.has(key)) keyToItems.set(key, []);
            keyToItems.get(key).push(item);
        });
    });

    const consumed = new Set();
    const out = [];

    for (const item of list) {
        if (consumed.has(item)) continue;
        const keys = itemToKeys.get(item) || [];
        let group = [item];
        let selectedKey = keys[0] || '';

        for (const key of keys) {
            const members = keyToItems.get(key) || [];
            if (members.length > group.length) {
                group = members;
                selectedKey = key;
            }
        }

        if (group.length <= 1) {
            out.push(item);
            continue;
        }

        stats.groups += 1;
        stats.merged += group.length - 1;

        const winner = annotateWinner(chooseWinner(group), group, selectedKey);

        if (mode === 'audit') {
            group.forEach((member) => {
                member._smartDedupeV2Audit = {
                    key: selectedKey,
                    groupSize: group.length,
                    wouldKeep: member === winner
                };
                out.push(member);
            });
            continue;
        }

        group.forEach((member) => {
            if (member !== winner) {
                member._filterExplainReason = `smart_dedupe_v2:${selectedKey.split(':')[0]}`;
                if (options.explain && typeof options.explain.remove === 'function') {
                    options.explain.remove('smartDedupeV2', member, member._filterExplainReason, {
                        key: selectedKey,
                        winner: winner.title || winner.name || winner.filename
                    });
                }
            }
            consumed.add(member);
        });
        out.push(winner);
    }

    stats.output = out.length;

    if (options.logger && typeof options.logger.info === 'function' && stats.merged > 0) {
        options.logger.info(`[SMART DEDUPE V2] mode=${mode} input=${stats.input} output=${stats.output} groups=${stats.groups} merged=${stats.merged}`);
    }

    return { items: out, stats };
}

module.exports = {
    applySmartDeduperV2,
    buildKeys,
    buildSmartKey,
    scoreItem
};
