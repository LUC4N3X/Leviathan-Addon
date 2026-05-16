'use strict';

const { DEFAULT_STREAM_POLICIES } = require('./default_stream_policies');
const { evaluateExpression, buildStreamExpressionContext } = require('./stream_expression');

function isEnvEnabled(name, fallback = true) {
    const raw = process.env[name];
    if (raw === undefined || raw === null || raw === '') return fallback;
    return /^(1|true|yes|y|on)$/i.test(String(raw).trim());
}

function getLanguageMode(filters = {}) {
    return String(filters.language || (filters.allowEng ? 'all' : 'ita')).trim().toLowerCase();
}

function isPolicyInScope(policy, ctx, filters) {
    if (!policy?.enabled) return false;
    if (policy.onlyWhen === 'itaStrict') {
        const mode = getLanguageMode(filters);
        if (mode !== 'ita' && mode !== 'italian' && mode !== 'strict_ita') return false;
    }
    if (Array.isArray(policy.types) && policy.types.length) {
        const type = String(ctx.meta?.type || ctx.meta?.requestType || (ctx.isSeries ? 'series' : 'movie')).toLowerCase();
        if (!policy.types.map((v) => String(v).toLowerCase()).includes(type)) return false;
    }
    return true;
}

function normalizeMode(mode) {
    const text = String(mode || '').trim().toLowerCase();
    if (['off', 'disabled', '0', 'false'].includes(text)) return 'off';
    if (['enforce', 'hide', 'block', 'on', 'true', '1'].includes(text)) return 'enforce';
    if (['penalty', 'penalize'].includes(text)) return 'penalty';
    return 'audit';
}

function loadPolicies(filters = {}) {
    const custom = Array.isArray(filters.streamPolicies) ? filters.streamPolicies : [];
    return [...DEFAULT_STREAM_POLICIES, ...custom].filter(Boolean);
}

function annotate(item, policy, mode) {
    const entry = {
        id: policy.id || 'policy',
        action: policy.action || 'audit',
        severity: policy.severity || 'info',
        mode
    };
    const current = Array.isArray(item._streamPolicyMatches) ? item._streamPolicyMatches : [];
    item._streamPolicyMatches = [...current, entry];
    item._policyAudit = true;
}

function applyStreamPolicies(items = [], options = {}) {
    const list = Array.isArray(items) ? items : [];
    const filters = options.filters || {};
    const logger = options.logger;
    const explain = options.explain;
    const mode = isEnvEnabled('LEVIATHAN_STREAM_POLICY_ENABLED', true)
        ? normalizeMode(options.mode || filters.streamPolicyMode || process.env.LEVIATHAN_STREAM_POLICY_MODE || 'audit')
        : 'off';

    const stats = {
        mode,
        input: list.length,
        output: list.length,
        matched: 0,
        removed: 0,
        penalized: 0,
        byPolicy: {}
    };

    if (mode === 'off') return { items: list, stats };

    const policies = loadPolicies(filters);
    const out = [];

    list.forEach((item, index) => {
        let remove = false;
        let removeReason = '';
        const ctx = buildStreamExpressionContext(item, options.meta || {}, { rank: index + 1 });
        const matchedPolicies = [];

        for (const policy of policies) {
            if (!isPolicyInScope(policy, ctx, filters)) continue;
            const matched = evaluateExpression(policy.expression, ctx, options.meta || {}, { logger });
            if (!matched) continue;

            matchedPolicies.push(policy);
            stats.matched += 1;
            stats.byPolicy[policy.id] = (stats.byPolicy[policy.id] || 0) + 1;
            annotate(item, policy, mode);

            const action = String(policy.action || 'audit').toLowerCase();
            if (mode === 'enforce' && action === 'hide') {
                remove = true;
                removeReason = `policy:${policy.id}`;
                break;
            }

            if ((mode === 'enforce' || mode === 'penalty') && action === 'penalize') {
                const penalty = Math.max(0, Number(policy.penalty || 0) || 0);
                item._policyPenalty = Math.max(Number(item._policyPenalty || 0) || 0, penalty);
                item._score = typeof item._score === 'number' ? item._score - penalty : item._score;
                item._compositeScore = typeof item._compositeScore === 'number' ? item._compositeScore - penalty : item._compositeScore;
                stats.penalized += 1;
            }
        }

        if (remove) {
            item._filterExplainReason = removeReason;
            stats.removed += 1;
            if (explain && typeof explain.remove === 'function') {
                explain.remove('streamPolicy', item, removeReason, {
                    policies: matchedPolicies.map((p) => p.id)
                });
            }
            return;
        }

        out.push(item);
    });

    stats.output = out.length;

    if (logger && typeof logger.info === 'function' && (stats.removed > 0 || stats.matched > 0)) {
        logger.info(`[POLICY] mode=${mode} input=${stats.input} output=${stats.output} matched=${stats.matched} removed=${stats.removed} penalized=${stats.penalized}`);
    }

    return { items: out, stats };
}

module.exports = {
    applyStreamPolicies,
    loadPolicies
};
