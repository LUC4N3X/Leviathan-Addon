'use strict';

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
const { scoreItem } = require('./smart_deduper_v2');
const { extractInfoHash, extractFileIdx } = require('./infohash_deduper');

const MASK64 = (1n << 64n) - 1n;
const FNV_OFFSET = 14695981039346656037n;
const FNV_PRIME = 1099511628211n;
const VIDEO_EXT = /\b(mkv|mp4|avi|mov|wmv|webm|m4v|ts|m2ts|flv|mpg|mpeg|vob|ogm|divx)\b/g;
const YEAR = /^(?:19|20)\d{2}$/;

const NOISE = new Set([
    '2160p', '1080p', '720p', '576p', '480p', '360p', '4k', 'uhd', 'fhd', 'hd', 'sd', 'hdr', 'hdr10', 'dv', 'dolby', 'vision', 'sdr',
    'x264', 'x265', 'h264', 'h265', 'hevc', 'avc', 'av1', 'vp9', 'xvid', 'divx', '10bit', '8bit', 'bit', 'hi10p',
    'web', 'webdl', 'webrip', 'dl', 'bluray', 'blu', 'ray', 'bdrip', 'brrip', 'bdmux', 'bdremux', 'remux', 'hdtv', 'hdrip',
    'dvdrip', 'dvd', 'cam', 'telesync', 'hdcam', 'scr', 'screener', 'webcap', 'hc',
    'aac', 'ac3', 'eac3', 'dts', 'dtshd', 'truehd', 'atmos', 'dd', 'ddp', 'flac', 'mp3', 'opus', 'stereo', 'mono',
    'ita', 'italian', 'italiano', 'eng', 'english', 'inglese', 'multi', 'multisub', 'sub', 'subs', 'subbed', 'dub', 'dubbed',
    'vost', 'vostit', 'jpn', 'jap', 'japanese', 'lat', 'spa', 'fre', 'ger', 'esp', 'por',
    'repack', 'proper', 'internal', 'limited', 'extended', 'unrated', 'remastered', 'complete', 'readnfo', 'rerip',
    'season', 'episode', 'ep', 'stagione', 'completa', 'full', 'pack', 'parte', 'part',
    'the', 'a', 'an', 'of', 'and', 'to', 'in', 'on', 'il', 'la', 'lo', 'le', 'gli', 'un', 'una', 'di', 'da', 'del',
    'della', 'dei', 'degli', 'delle', 'con', 'per', 'che', 'and'
]);

function envFlag(name, fallback = true) {
    const raw = process.env[name];
    if (raw === undefined || raw === null || raw === '') return fallback;
    return /^(1|true|yes|y|on)$/i.test(String(raw).trim());
}

function envInt(name, fallback) {
    const parsed = parseInt(process.env[name], 10);
    return Number.isFinite(parsed) ? parsed : fallback;
}

function envFloat(name, fallback) {
    const raw = process.env[name];
    if (raw === undefined || raw === null || String(raw).trim() === '') return fallback;
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : fallback;
}

function normalizeMode(value) {
    const mode = String(value || '').trim().toLowerCase();
    if (['off', 'disabled', '0', 'false'].includes(mode)) return 'off';
    if (['audit', 'dry', 'dryrun', 'dry-run'].includes(mode)) return 'audit';
    if (['aggressive', 'max'].includes(mode)) return 'aggressive';
    return 'conservative';
}

function resolveConfig(mode) {
    const aggressive = mode === 'aggressive';
    const bands = Math.max(2, Math.min(16, envInt('LEVIATHAN_PERCEPTUAL_DEDUPE_BANDS', 8)));
    const bucketMb = Math.max(8, envInt('LEVIATHAN_PERCEPTUAL_DEDUPE_BUCKET_MB', 128));
    const maxHamming = Math.max(0, Math.min(16, envInt('LEVIATHAN_PERCEPTUAL_DEDUPE_HAMMING', aggressive ? 6 : 3)));
    const minJaccard = Math.max(0, Math.min(1, envFloat('LEVIATHAN_PERCEPTUAL_DEDUPE_JACCARD', aggressive ? 0.45 : 0.55)));
    const sizeTolerance = Math.max(0, Math.min(8, envInt('LEVIATHAN_PERCEPTUAL_DEDUPE_SIZE_TOLERANCE', aggressive ? 2 : 1)));
    return {
        aggressive,
        bands,
        bandBits: Math.max(2, Math.floor(64 / bands)),
        bucketBytes: bucketMb * 1024 * 1024,
        maxHamming,
        minJaccard,
        sizeTolerance,
        minTokens: aggressive ? 2 : 2,
        maxBucketScan: Math.max(64, envInt('LEVIATHAN_PERCEPTUAL_DEDUPE_MAX_BUCKET', 400))
    };
}

function buildSignatureText(item = {}) {
    return [
        item.filename,
        item.fileName,
        item.file_title,
        item.file_name,
        item.title,
        item.name,
        item.behaviorHints?.filename,
        item.episodeFileHint?.fileName,
        item._episodeFileHint?.fileName
    ].filter(Boolean).join(' ');
}

function tokenize(item) {
    const text = normalizeText(buildSignatureText(item)).replace(VIDEO_EXT, ' ');
    const parts = text.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
    const weights = new Map();
    const tokens = new Set();
    for (const token of parts) {
        if (NOISE.has(token)) continue;
        let weight;
        if (YEAR.test(token)) weight = 4;
        else if (/^\d{1,3}$/.test(token)) weight = 1;
        else if (token.length >= 2) weight = Math.min(3, 1 + Math.floor(token.length / 4));
        else continue;
        tokens.add(token);
        weights.set(token, (weights.get(token) || 0) + weight);
    }
    return { weights, tokens };
}

function hash64(str) {
    let h = FNV_OFFSET;
    for (let i = 0; i < str.length; i += 1) {
        h ^= BigInt(str.charCodeAt(i));
        h = (h * FNV_PRIME) & MASK64;
    }
    return h;
}

function simhash(weights) {
    const acc = new Float64Array(64);
    for (const [token, weight] of weights) {
        const h = hash64(token);
        for (let bit = 0; bit < 64; bit += 1) {
            if ((h >> BigInt(bit)) & 1n) acc[bit] += weight;
            else acc[bit] -= weight;
        }
    }
    let fp = 0n;
    for (let bit = 0; bit < 64; bit += 1) {
        if (acc[bit] > 0) fp |= (1n << BigInt(bit));
    }
    return fp;
}

function hamming(a, b) {
    let x = a ^ b;
    let count = 0;
    while (x) {
        x &= x - 1n;
        count += 1;
    }
    return count;
}

function bandKeys(fp, bands, bandBits) {
    const mask = (1n << BigInt(bandBits)) - 1n;
    const keys = [];
    for (let i = 0; i < bands; i += 1) {
        const part = (fp >> BigInt(i * bandBits)) & mask;
        keys.push(`${i}:${part.toString(16)}`);
    }
    return keys;
}

function jaccard(a, b) {
    if (a.size === 0 || b.size === 0) return 0;
    let intersection = 0;
    const small = a.size <= b.size ? a : b;
    const large = small === a ? b : a;
    for (const token of small) {
        if (large.has(token)) intersection += 1;
    }
    return intersection / (a.size + b.size - intersection);
}

function getEpisodeScope(meta = {}, item = {}) {
    const season = Number(meta?.season ?? item?.season ?? 0) || 0;
    const episode = Number(meta?.episode ?? item?.episode ?? 0) || 0;
    if (season > 0 && episode > 0) return `s${season}e${episode}`;
    return '';
}

function isSeries(meta = {}, item = {}) {
    return Boolean(meta?.isSeries || meta?.season || meta?.episode || item.season || item.episode);
}

function sizeBucket(item, bucketBytes) {
    const bytes = getSizeBytes(item);
    if (!Number.isFinite(bytes) || bytes <= 0) return null;
    return Math.max(1, Math.round(bytes / bucketBytes));
}

function partitionKey(item, meta, cfg) {
    const series = isSeries(meta, item);
    const scope = series ? getEpisodeScope(meta, item) : 'movie';
    if (series && !scope) return '';
    const resolution = detectResolution(item) || 'res?';
    const language = detectLanguage(item).slice().sort().join('+') || 'lang?';
    if (cfg.aggressive) return [scope, resolution, language].join('|');
    const quality = detectQuality(item) || 'q?';
    const encode = detectEncode(item) || 'enc?';
    return [scope, resolution, quality, encode, language].join('|');
}

function isEligible(item) {
    if (!item || typeof item !== 'object') return false;
    if (item._torrentioExactGuard || item._torrentioLooseItForceKeep) return false;
    if (item.behaviorHints?.torrentioExactGuard || item.behaviorHints?.torrentioLooseItForceKeep) return false;
    if (item.isSavedCloud || item._savedCloud || item.savedCloud || item.behaviorHints?.savedCloud) return false;
    return true;
}

function compatibleIdentity(a, b) {
    const ha = extractInfoHash(a);
    const hb = extractInfoHash(b);
    if (ha && hb && ha !== hb) return false;
    const fa = extractFileIdx(a);
    const fb = extractFileIdx(b);
    if (fa !== null && fb !== null && fa !== fb) return false;
    return true;
}

function compatibleSize(a, b, cfg) {
    const ba = sizeBucket(a, cfg.bucketBytes);
    const bb = sizeBucket(b, cfg.bucketBytes);
    if (ba === null || bb === null) return true;
    return Math.abs(ba - bb) <= cfg.sizeTolerance;
}

function collectSources(group) {
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

function chooseWinner(group) {
    return [...group].sort((a, b) => scoreItem(b) - scoreItem(a))[0] || group[0];
}

function annotateWinner(winner, group, distance) {
    if (!winner || group.length <= 1) return winner;
    const sources = collectSources(group);
    winner._perceptualDedupe = true;
    winner._perceptualDedupeDistance = distance;
    winner._perceptualDedupeMergedCount = Math.max(Number(winner._perceptualDedupeMergedCount || 1) || 1, group.length);
    winner._perceptualDedupeSources = sources;
    winner._dedupeMergedCount = Math.max(Number(winner._dedupeMergedCount || 1) || 1, group.length);
    winner._dedupeMergedSources = [...new Set([...(winner._dedupeMergedSources || []), ...sources])];
    winner._perceptualDedupeBestCacheState = group
        .map(detectCacheState)
        .sort((a, b) => cacheRank(b) - cacheRank(a))[0] || detectCacheState(winner);
    return winner;
}

function cacheRank(state) {
    if (state === 'cached') return 5;
    if (state === 'likely_cached') return 4;
    if (state === 'probing') return 3;
    if (state === 'unknown') return 2;
    if (state === 'uncached') return 1;
    return 0;
}

class UnionFind {
    constructor(size) {
        this.parent = Array.from({ length: size }, (_, i) => i);
        this.rank = new Array(size).fill(0);
    }
    find(x) {
        while (this.parent[x] !== x) {
            this.parent[x] = this.parent[this.parent[x]];
            x = this.parent[x];
        }
        return x;
    }
    union(a, b) {
        let ra = this.find(a);
        let rb = this.find(b);
        if (ra === rb) return;
        if (this.rank[ra] < this.rank[rb]) [ra, rb] = [rb, ra];
        this.parent[rb] = ra;
        if (this.rank[ra] === this.rank[rb]) this.rank[ra] += 1;
    }
}

function applyPerceptualDedupe(items = [], options = {}) {
    const list = Array.isArray(items) ? items : [];
    const mode = envFlag('LEVIATHAN_PERCEPTUAL_DEDUPE_ENABLED', true)
        ? normalizeMode(options.mode || process.env.LEVIATHAN_PERCEPTUAL_DEDUPE_MODE || 'conservative')
        : 'off';

    const stats = {
        mode,
        input: list.length,
        output: list.length,
        groups: 0,
        merged: 0,
        candidatePairs: 0,
        confirmedPairs: 0,
        auditOnly: mode === 'audit'
    };

    if (mode === 'off' || list.length < 2) return { items: list, stats };

    const cfg = resolveConfig(mode);
    const meta = options.meta || {};

    const entries = new Array(list.length);
    const partitions = new Map();

    list.forEach((item, idx) => {
        if (!isEligible(item)) {
            entries[idx] = null;
            return;
        }
        const { weights, tokens } = tokenize(item);
        if (tokens.size < cfg.minTokens) {
            entries[idx] = null;
            return;
        }
        const partition = partitionKey(item, meta, cfg);
        if (!partition) {
            entries[idx] = null;
            return;
        }
        const fp = simhash(weights);
        entries[idx] = { idx, fp, tokens, partition };
        if (!partitions.has(partition)) partitions.set(partition, []);
        partitions.get(partition).push(idx);
    });

    const uf = new UnionFind(list.length);
    const seenPairs = new Set();

    for (const indices of partitions.values()) {
        if (indices.length < 2) continue;

        const buckets = new Map();
        for (const idx of indices) {
            const entry = entries[idx];
            for (const key of bandKeys(entry.fp, cfg.bands, cfg.bandBits)) {
                if (!buckets.has(key)) buckets.set(key, []);
                buckets.get(key).push(idx);
            }
        }

        for (const bucket of buckets.values()) {
            if (bucket.length < 2 || bucket.length > cfg.maxBucketScan) continue;
            for (let i = 0; i < bucket.length; i += 1) {
                for (let j = i + 1; j < bucket.length; j += 1) {
                    const a = bucket[i];
                    const b = bucket[j];
                    const pairKey = a < b ? `${a}:${b}` : `${b}:${a}`;
                    if (seenPairs.has(pairKey)) continue;
                    seenPairs.add(pairKey);
                    stats.candidatePairs += 1;

                    const ea = entries[a];
                    const eb = entries[b];
                    const distance = hamming(ea.fp, eb.fp);
                    if (distance > cfg.maxHamming) continue;
                    if (!compatibleIdentity(list[a], list[b])) continue;
                    if (!compatibleSize(list[a], list[b], cfg)) continue;
                    if (jaccard(ea.tokens, eb.tokens) < cfg.minJaccard) continue;

                    stats.confirmedPairs += 1;
                    uf.union(a, b);
                }
            }
        }
    }

    const clusters = new Map();
    list.forEach((item, idx) => {
        if (!entries[idx]) return;
        const root = uf.find(idx);
        if (!clusters.has(root)) clusters.set(root, []);
        clusters.get(root).push(idx);
    });

    const maxDistanceForCluster = (indices) => {
        let best = 0;
        for (let i = 0; i < indices.length; i += 1) {
            for (let j = i + 1; j < indices.length; j += 1) {
                best = Math.max(best, hamming(entries[indices[i]].fp, entries[indices[j]].fp));
            }
        }
        return best;
    };

    const clusterGroups = [...clusters.values()].filter((indices) => indices.length > 1);
    const analyses = [];
    for (const indices of clusterGroups) {
        const group = indices.map((member) => list[member]);
        const winner = chooseWinner(group);
        const droppable = indices.filter((member) => (
            list[member] !== winner
            && compatibleIdentity(list[member], winner)
            && compatibleSize(list[member], winner, cfg)
        ));
        if (droppable.length === 0) continue;
        analyses.push({
            winner,
            winnerIndex: indices.find((member) => list[member] === winner),
            droppable,
            distance: maxDistanceForCluster(indices),
            partition: entries[indices[0]].partition
        });
        stats.groups += 1;
        stats.merged += droppable.length;
    }

    if (mode === 'audit') {
        const auditByIndex = new Map();
        for (const analysis of analyses) {
            const groupSize = analysis.droppable.length + 1;
            auditByIndex.set(analysis.winnerIndex, {
                partition: analysis.partition,
                groupSize,
                distance: analysis.distance,
                wouldKeep: true
            });
            for (const member of analysis.droppable) {
                auditByIndex.set(member, {
                    partition: analysis.partition,
                    groupSize,
                    distance: analysis.distance,
                    wouldKeep: false
                });
            }
        }
        list.forEach((item, idx) => {
            const audit = auditByIndex.get(idx);
            if (audit) item._perceptualDedupeAudit = audit;
        });
        stats.output = list.length;
        if (options.logger && typeof options.logger.info === 'function' && stats.merged > 0) {
            options.logger.info(`[PERCEPTUAL DEDUPE] mode=${mode} input=${stats.input} output=${stats.output} groups=${stats.groups} merged=${stats.merged} pairs=${stats.confirmedPairs}/${stats.candidatePairs}`);
        }
        return { items: list, stats };
    }

    const dropIndices = new Set();
    for (const analysis of analyses) {
        annotateWinner(analysis.winner, [analysis.winner, ...analysis.droppable.map((member) => list[member])], analysis.distance);
        for (const member of analysis.droppable) {
            dropIndices.add(member);
            const loser = list[member];
            loser._filterExplainReason = 'perceptual_dedupe';
            if (options.explain && typeof options.explain.remove === 'function') {
                options.explain.remove('perceptualDedupe', loser, loser._filterExplainReason, {
                    distance: analysis.distance,
                    winner: analysis.winner.title || analysis.winner.name || analysis.winner.filename
                });
            }
        }
    }

    const out = list.filter((_, idx) => !dropIndices.has(idx));
    stats.output = out.length;

    if (options.logger && typeof options.logger.info === 'function' && stats.merged > 0) {
        options.logger.info(`[PERCEPTUAL DEDUPE] mode=${mode} input=${stats.input} output=${stats.output} groups=${stats.groups} merged=${stats.merged} pairs=${stats.confirmedPairs}/${stats.candidatePairs}`);
    }

    return { items: out, stats };
}

module.exports = {
    applyPerceptualDedupe,
    simhash,
    hamming,
    tokenize,
    partitionKey,
    resolveConfig,
    normalizeMode
};
