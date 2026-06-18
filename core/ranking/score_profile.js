'use strict';

const { evaluateEpisodeTruth } = require('../matching/episode_truth_engine');
const { getSeedHealth } = require('../lib/seed_health_ranker');
const { evaluateTorrentIntelligence } = require('./torrent_intelligence');
const { evaluateQualityIntelligence } = require('./quality_intelligence');

const DEFAULT_SCORE_PROFILE = Object.freeze({
    resolution: Object.freeze({
        '2160p': 40,
        '4k': 40,
        '1080p': 30,
        '720p': 18,
        '480p': 8,
        sd: 2,
        unknown: 0
    }),
    language: Object.freeze({
        ita: 30,
        multi: 24,
        eng: 12,
        jpn: 8,
        unknown: 0,
        other: -8
    }),
    rdStatus: Object.freeze({
        cached: 35,
        likely_cached: 25,
        unknown: 4,
        probing: 4,
        likely_uncached: -8,
        uncached: -20,
        uncached_terminal: -25
    }),
    seedHealth: Object.freeze({
        healthy: 18,
        seeded: 10,
        weak: -6,
        dead: -18,
        unknown: 0,
        protected: 16
    }),
    providerReliability: Object.freeze({
        excellent: 20,
        good: 12,
        stable: 10,
        unknown: 0,
        unstable: -8,
        degraded: -18
    }),
    episodeTruth: Object.freeze({
        exact_episode: 35,
        season_pack_file_match: 30,
        anime_absolute_episode: 24,
        season_pack_candidate: 20,
        not_required: 8,
        episode_uncertain: -15,
        title_or_episode_uncertain: -28,
        episode_mismatch_risk: -100,
        mismatch: -100
    }),
        source: Object.freeze({
            torrentio: 12,
            animeworld: 10,
        guardahd: 8,
        guardoserie: 6,
        guardaflix: 6,
        animeunity: 6,
        animesaturn: 4,
        db: -4,
        unknown: 0
    }),
    sourceConsensus: Object.freeze({
        strong_consensus: 14,
        consensus: 9,
        mirror: 4,
        none: 0
    }),
    pack: Object.freeze({
        singleFile: 10,
        seasonPack: 6,
        multiSeasonPack: -12,
        unknown: 0
    }),
    torrentIntelligence: Object.freeze({
        enabled: 1
    }),
    qualityIntelligence: Object.freeze({
        enabled: 1
    })
});

function normalizeKey(value, fallback = 'unknown') {
    const raw = String(value || '').trim().toLowerCase();
    return raw || fallback;
}

function firstNonEmpty(...values) {
    for (const value of values) {
        const text = String(value ?? '').trim();
        if (text) return text;
    }
    return '';
}

function mergeProfile(profile = {}) {
    const merged = {};
    for (const key of Object.keys(DEFAULT_SCORE_PROFILE)) {
        merged[key] = {
            ...DEFAULT_SCORE_PROFILE[key],
            ...(profile[key] || {})
        };
    }
    return merged;
}

function detectResolution(item = {}) {
    const direct = firstNonEmpty(item.quality, item.resolution, item.videoQuality, item.behaviorHints?.quality);
    const text = `${direct} ${item.title || ''} ${item.name || ''}`;
    if (/\b(?:2160p|4k|uhd)\b/i.test(text)) return '2160p';
    if (/\b1080p\b/i.test(text)) return '1080p';
    if (/\b720p\b/i.test(text)) return '720p';
    if (/\b(?:480p|sd)\b/i.test(text)) return '480p';
    return 'unknown';
}

function detectLanguage(item = {}) {
    const direct = firstNonEmpty(item.language, item.lang, item.behaviorHints?.language, Array.isArray(item.languages) ? item.languages.join(' ') : '');
    const text = `${direct} ${item.title || ''} ${item.name || ''}`;
    if (/\b(?:ita|italiano|italian|audio\s*ita)\b/i.test(text)) return 'ita';
    if (/\b(?:multi|multilang|dual\s*audio)\b/i.test(text)) return 'multi';
    if (/\b(?:eng|english|audio\s*eng)\b/i.test(text)) return 'eng';
    if (/\b(?:jpn|jap|japanese|audio\s*jpn)\b/i.test(text)) return 'jpn';
    if (/\b(?:french|german|spanish|latino|rus|hindi|kor)\b/i.test(text)) return 'other';
    return 'unknown';
}

function detectRdStatus(item = {}) {
    const raw = firstNonEmpty(item._rdCacheState, item.rdCacheState, item.cacheState, item.behaviorHints?.cacheState);
    const state = normalizeKey(raw);
    if (item._dbCachedRd === true || item.cached_rd === true || item._tbCached === true || item.tb_cached === true) return 'cached';
    if (state === 'cached' || state === 'likely_cached' || state === 'uncached' || state === 'likely_uncached' || state === 'uncached_terminal' || state === 'probing') return state;
    return 'unknown';
}

function detectProviderReliability(item = {}, registry = {}) {
    const provider = normalizeKey(firstNonEmpty(item.providerId, item.provider, item.source, item.sourceName));
    const direct = normalizeKey(item._providerReliability || item.providerReliability || registry[provider]);
    if (direct && direct !== 'unknown') return direct;
    if (/animeworld/.test(provider)) return 'excellent';
    if (/guardahd|guardaflix|animeunity|streamingcommunity/.test(provider)) return 'good';
    if (/guardoserie/.test(provider)) return 'unstable';
    return 'unknown';
}

function detectSource(item = {}) {
    const source = normalizeKey(firstNonEmpty(item.providerId, item.provider, item.source, item.sourceName));
    if (/torrentio/.test(source)) return 'torrentio';
    if (/animeworld/.test(source)) return 'animeworld';
    if (/guardahd/.test(source)) return 'guardahd';
    if (/guardoserie|guardaserie/.test(source)) return 'guardoserie';
    if (/guardaflix/.test(source)) return 'guardaflix';
    if (/animeunity/.test(source)) return 'animeunity';
    if (/animesaturn/.test(source)) return 'animesaturn';
    if (/db|database/.test(source) || item._fromDb === true) return 'db';
    return 'unknown';
}

function normalizeSourceLabel(value) {
    const text = String(value || '').trim();
    if (!text || /^(unknown|n\/a|null|undefined)$/i.test(text)) return '';
    return text.toLowerCase();
}

function collectConsensusSources(item = {}) {
    const out = new Set();
    const push = (value) => {
        const normalized = normalizeSourceLabel(value);
        if (normalized) out.add(normalized);
    };

    push(item.source);
    push(item.provider);
    push(item.providerId);
    push(item.sourceName);
    push(item.externalAddon);
    push(item.behaviorHints?.vortexSource);
    push(item.behaviorHints?.vortexMeta?.provider);
    for (const source of Array.isArray(item._dedupeMergedSources) ? item._dedupeMergedSources : []) push(source);
    for (const source of Array.isArray(item._dedupeEvidence?.sources) ? item._dedupeEvidence.sources : []) push(source);
    return out;
}

function detectSourceConsensus(item = {}) {
    const sourceCount = collectConsensusSources(item).size;
    const mergedCount = Number(item._dedupeMergedCount || item._dedupeEvidence?.mergedCount || 0) || 0;
    if (sourceCount >= 3 || mergedCount >= 4) return 'strong_consensus';
    if (sourceCount >= 2 || mergedCount >= 3) return 'consensus';
    if (mergedCount >= 2) return 'mirror';
    return 'none';
}

function detectPackState(item = {}) {
    const text = `${item.title || ''} ${item.name || ''} ${item.filename || ''}`;
    if (item._isMultiSeasonPack === true || /\b(?:s\d{1,2}\s*[-+]\s*s\d{1,2}|complete\s+series|serie\s+completa)\b/i.test(text)) return 'multiSeasonPack';
    if (item._isSeasonPack === true || item.isSeasonPack === true || /\b(?:season\s*pack|stagione\s*completa|s\d{1,2}\b|pack)\b/i.test(text)) return 'seasonPack';
    if (item.fileIdx !== undefined || item.file_index !== undefined || item.behaviorHints?.filename) return 'singleFile';
    return 'unknown';
}

function addComponent(parts, profile, group, key, label = key) {
    const value = profile[group]?.[key];
    const score = Number.isFinite(Number(value)) ? Number(value) : 0;
    parts.score += score;
    parts.components[group] = { key, score };
    const prefix = score >= 0 ? '+' : '';
    parts.explain.push(`${prefix}${score} ${group}=${label}`);
}

function formatComponentLabel(group, key) {
    const labels = {
        resolution: 'qualità',
        language: 'lingua',
        rdStatus: 'cache',
        seedHealth: 'seed',
        providerReliability: 'provider',
        episodeTruth: 'match',
        source: 'fonte',
        sourceConsensus: 'consenso',
        pack: 'pack',
        torrentIntelligence: 'torrent intelligence',
        qualityIntelligence: 'quality intelligence'
    };
    return `${labels[group] || group}=${key}`;
}

function componentBadge(group, key) {
    if (group === 'rdStatus') {
        if (key === 'cached') return '⚡ cached exact';
        if (key === 'likely_cached') return '🟡 likely cached';
        if (/uncached/.test(key)) return '⌛ uncached';
        return '❔ cache unknown';
    }
    if (group === 'language') {
        if (key === 'ita') return '🇮🇹 ITA';
        if (key === 'multi') return '🌍 MULTI';
        if (key === 'eng') return '🇬🇧 ENG';
        return '🗣️ lingua unknown';
    }
    if (group === 'resolution') {
        if (key === '2160p') return '🎬 2160p/4K';
        if (key === '1080p') return '🎬 1080p';
        if (key === '720p') return '🎬 720p';
        return '🎬 qualità unknown';
    }
    if (group === 'episodeTruth') {
        if (key === 'exact_episode') return '🎯 episodio exact';
        if (key === 'season_pack_file_match') return '📦 file pack exact';
        if (/mismatch|risk|uncertain/.test(key)) return '⚠️ match rischio';
        return '🧭 match ok';
    }
    if (group === 'seedHealth') {
        if (key === 'healthy' || key === 'protected') return '🌱 seed buoni';
        if (key === 'dead') return '🪦 seed morti';
        if (key === 'weak') return '🥀 seed deboli';
    }
    if (group === 'sourceConsensus') {
        if (key === 'strong_consensus') return '🤝 consenso forte';
        if (key === 'consensus') return '🤝 consenso';
    }
    if (group === 'torrentIntelligence') {
        return '🧠 torrent-intel';
    }
    if (group === 'qualityIntelligence') {
        return '🎚️ qualità release';
    }
    return '';
}

function buildBrutalRankExplain({ finalScore = 0, components = {}, episodeTruth = null, item = {}, meta = {} } = {}) {
    const positives = [];
    const negatives = [];
    const badges = [];

    for (const [group, component] of Object.entries(components || {})) {
        if (!component) continue;
        const key = String(component.key || 'unknown');
        const score = Number(component.score || 0) || 0;
        const line = `${score >= 0 ? '+' : ''}${score} ${formatComponentLabel(group, key)}`;
        if (score >= 0) positives.push(line);
        else negatives.push(line);
        const badge = componentBadge(group, key);
        if (badge) badges.push(badge);
    }

    const proof = firstNonEmpty(
        item._rdEpisodeProof?.reason,
        item.rdEpisodeProof?.reason,
        item._episodeFileHint?.reason,
        item.episodeFileHint?.reason,
        episodeTruth?.reason
    );
    const fileIdx = item.fileIdx ?? item.file_index ?? item.behaviorHints?.fileIdx;
    if (fileIdx !== undefined && fileIdx !== null && fileIdx !== '') badges.push(`📁 fileIdx=${fileIdx}`);
    if (item._qualityIntelligence?.badges?.length) badges.push(`🎚️ ${item._qualityIntelligence.badges.slice(0, 4).join(' · ')}`);
    if (item._externalSnapshot === true || item._fromExternalSnapshot === true) badges.push('🧠 snapshot DB');
    if (item._localDb === true || item._fromDb === true) badges.push('🗄️ DB locale');
    if (proof) positives.push(`proof=${proof}`);

    const title = firstNonEmpty(item.title, item.name, item.filename, meta.title, meta.name, 'stream');
    const text = `[RANK EXPLAIN] BRUTALE ${title} | score=${Number(finalScore || 0)} | ${badges.slice(0, 7).join(' · ')} | + ${positives.slice(0, 8).join(' | ')}${negatives.length ? ` | - ${negatives.slice(0, 6).join(' | ')}` : ''}`;

    return {
        title,
        score: Number(finalScore || 0),
        badges,
        positives,
        negatives,
        proof: proof || null,
        text
    };
}


function evaluateLeviathanScore(item = {}, meta = {}, options = {}) {
    const profile = mergeProfile(options.profile || options.scoreProfile || options.ranking?.scoreProfile || {});
    const parts = { score: 0, explain: [], components: {} };

    const resolution = detectResolution(item);
    const language = detectLanguage(item);
    const rdStatus = detectRdStatus(item);
    const seedHealth = item._seedHealth || getSeedHealth(item.seeders).health;
    const providerReliability = detectProviderReliability(item, options.providerReliability || {});
    const source = detectSource(item);
    const sourceConsensus = detectSourceConsensus(item);
    const pack = detectPackState(item);
    const torrentIntelligence = evaluateTorrentIntelligence(item, meta, {
        weight: options?.ranking?.torrentIntelligenceWeight ?? options?.torrentIntelligenceWeight ?? 1
    });
    const qualityIntelligence = item._qualityIntelligence || evaluateQualityIntelligence(item, meta);
    const episodeTruth = item._episodeTruth || evaluateEpisodeTruth(item, meta, { strict: false });
    const episodeTruthType = episodeTruth?.type || 'not_required';

    addComponent(parts, profile, 'resolution', resolution, resolution);
    addComponent(parts, profile, 'language', language, language);
    addComponent(parts, profile, 'rdStatus', rdStatus, rdStatus);
    addComponent(parts, profile, 'seedHealth', seedHealth, seedHealth);
    addComponent(parts, profile, 'providerReliability', providerReliability, providerReliability);
    addComponent(parts, profile, 'episodeTruth', episodeTruthType, episodeTruthType);
    addComponent(parts, profile, 'source', source, source);
    addComponent(parts, profile, 'sourceConsensus', sourceConsensus, sourceConsensus);
    addComponent(parts, profile, 'pack', pack, pack);
    if (options?.ranking?.useQualityIntelligenceRanking !== false && options?.useQualityIntelligenceRanking !== false) {
        const qiScore = Number(qualityIntelligence.score || 0) || 0;
        parts.score += qiScore;
        parts.components.qualityIntelligence = {
            key: qualityIntelligence.releaseSource || 'unknown',
            score: qiScore,
            badges: qualityIntelligence.badges,
            signals: qualityIntelligence
        };
        parts.explain.push(`${qiScore >= 0 ? '+' : ''}${qiScore} qualityIntelligence=${(qualityIntelligence.badges || []).join(',') || 'n/a'}`);
    }
    if (options?.ranking?.useTorrentIntelligenceRanking !== false && options?.useTorrentIntelligenceRanking !== false) {
        const tiScore = Number(torrentIntelligence.score || 0) || 0;
        parts.score += tiScore;
        parts.components.torrentIntelligence = { key: 'enabled', score: tiScore, features: torrentIntelligence.features };
        parts.explain.push(`${tiScore >= 0 ? '+' : ''}${tiScore} torrentIntelligence=${torrentIntelligence.text || 'n/a'}`);
    }

    const brutalExplain = buildBrutalRankExplain({
        finalScore: parts.score,
        components: parts.components,
        episodeTruth,
        item: { ...item, _qualityIntelligence: qualityIntelligence },
        meta
    });

    return {
        finalScore: parts.score,
        explain: parts.explain,
        brutalExplain,
        components: parts.components,
        episodeTruth,
        torrentIntelligence,
        qualityIntelligence
    };
}

function annotateWithLeviathanScore(item = {}, meta = {}, options = {}) {
    const scoreProfile = evaluateLeviathanScore(item, meta, options);
    return {
        ...item,
        _leviathanScore: scoreProfile.finalScore,
        _leviathanScoreExplain: scoreProfile.explain,
        _leviathanExplain: scoreProfile.brutalExplain,
        _leviathanExplainText: scoreProfile.brutalExplain?.text,
        _leviathanScoreProfile: scoreProfile,
        _qualityIntelligence: scoreProfile.qualityIntelligence
    };
}

function compareLeviathanScore(left = {}, right = {}) {
    return (right._leviathanScore || 0) - (left._leviathanScore || 0);
}

function rankWithLeviathanScore(items = [], meta = {}, options = {}) {
    return (Array.isArray(items) ? items : [])
        .map((item) => annotateWithLeviathanScore(item, meta, options))
        .sort(compareLeviathanScore);
}

function formatRankExplain(item = {}) {
    const score = Number(item._leviathanScore || 0);
    if (item._leviathanExplainText) return item._leviathanExplainText;
    const explain = Array.isArray(item._leviathanScoreExplain) ? item._leviathanScoreExplain.join(' | ') : '';
    const title = firstNonEmpty(item.title, item.name, item.provider, item.source);
    return `[RANK EXPLAIN] ${title} | score=${score} | ${explain}`;
}

module.exports = {
    DEFAULT_SCORE_PROFILE,
    annotateWithLeviathanScore,
    buildBrutalRankExplain,
    compareLeviathanScore,
    detectLanguage,
    detectPackState,
    detectProviderReliability,
    detectRdStatus,
    detectResolution,
    detectSource,
    detectSourceConsensus,
    evaluateLeviathanScore,
    evaluateTorrentIntelligence,
    formatRankExplain,
    mergeProfile,
    rankWithLeviathanScore
};
