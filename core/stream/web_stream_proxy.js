'use strict';

const {
    buildContentProxyUrlFromBase,
    shouldProxyContentUrl
} = require('../proxy/content_proxy_engine');
const { buildProxyUrl, getMediaflowBase } = require('../proxy/mediaflow_gateway');

function isHttpUrl(value) {
    return /^https?:\/\//i.test(String(value || '').trim());
}

function isAddonProxyUrl(value) {
    const text = String(value || '');
    return /\/(?:lazy_extract|levi_proxy\/content|proxy\/hls|proxy\/stream)\//i.test(text)
        || /\/(?:lazy_extract|levi_proxy\/content)(?:[/?#]|$)/i.test(text);
}

function isHlsUrl(value) {
    return /\.m3u8(?:$|[?#])/i.test(String(value || '').trim());
}

function firstObject(...values) {
    for (const value of values) {
        if (value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length > 0) return value;
    }
    return {};
}

function getStreamPlaybackHeaders(stream = {}) {
    return firstObject(
        stream?.behaviorHints?.proxyHeaders?.request,
        stream?.proxyHeaders?.request,
        stream?.behaviorHints?.headers,
        stream?.headers,
        stream?.requestHeaders
    );
}

function hasStreamHgSignal(stream = {}) {
    const hints = stream?.behaviorHints || {};
    const meta = hints?.vortexMeta || {};
    const text = [
        stream?.extractor,
        stream?.host,
        stream?.hoster,
        stream?.name,
        stream?.title,
        stream?.provider,
        stream?.source,
        stream?.site,
        stream?.url,
        hints?.extractor,
        hints?.vortexExtractor,
        meta?.extractor,
        meta?.lazyHoster,
        meta?.hoster
    ].filter(Boolean).join(' ');

    return /\b(?:streamhg|dhcplay|vibuxer)\b/i.test(text);
}

function shouldProxyStreamHgStream(stream = {}, context = {}) {
    const url = String(stream?.url || '').trim();
    if (!isHttpUrl(url)) return false;
    if (isAddonProxyUrl(url)) return false;
    if (!hasStreamHgSignal(stream)) return false;

    const baseUrl = String(context?.baseUrl || context?.reqHost || '').replace(/\/+$/, '');
    const rawConf = String(context?.rawConf || context?.userConfStr || '').trim();
    if (!baseUrl || !rawConf) return false;

    return shouldProxyContentUrl(context?.config || {}, {
        targetUrl: url,
        source: 'web_streamhg',
        direct: true
    });
}

function proxyStreamHgStream(stream = {}, context = {}) {
    if (!shouldProxyStreamHgStream(stream, context)) return stream;

    const baseUrl = String(context?.baseUrl || context?.reqHost || '').replace(/\/+$/, '');
    const rawConf = String(context?.rawConf || context?.userConfStr || '').trim();
    const headers = getStreamPlaybackHeaders(stream);
    const mediaflowBase = getMediaflowBase(context?.config || {});
    const mediaflowUrl = mediaflowBase && isHlsUrl(stream.url)
        ? buildProxyUrl(context?.config || {}, stream.url, headers, { isHls: true, allowCookie: false })
        : null;
    const proxiedUrl = (mediaflowUrl && mediaflowUrl !== stream.url)
        ? mediaflowUrl
        : buildContentProxyUrlFromBase(baseUrl, rawConf, stream.url, {
            source: 'web_streamhg',
            filename: stream?.filename || stream?.file_title || stream?.title || 'StreamHG',
            headers,
            ttlSeconds: context?.ttlSeconds || 3 * 60 * 60
        });

    if (!proxiedUrl || proxiedUrl === stream.url) return stream;

    const behaviorHints = {
        ...(stream.behaviorHints || {}),
        contentProxy: true,
        streamhgContentProxy: true,
        streamhgProxyMode: mediaflowUrl && mediaflowUrl === proxiedUrl ? 'mediaflow' : 'content',
        vortexMeta: {
            ...(stream.behaviorHints?.vortexMeta || {}),
            contentProxy: true,
            streamhgContentProxy: true,
            streamhgProxyMode: mediaflowUrl && mediaflowUrl === proxiedUrl ? 'mediaflow' : 'content'
        }
    };

    if (Object.keys(headers || {}).length > 0) {
        behaviorHints.proxyHeaders = behaviorHints.proxyHeaders || {};
        behaviorHints.proxyHeaders.request = headers;
        behaviorHints.headers = headers;
    }

    return {
        ...stream,
        url: proxiedUrl,
        behaviorHints
    };
}

function proxyStreamHgWebBuckets(webBuckets = {}, context = {}) {
    if (!webBuckets || typeof webBuckets !== 'object') return webBuckets;

    const out = {};
    for (const [key, bucket] of Object.entries(webBuckets)) {
        out[key] = Array.isArray(bucket)
            ? bucket.map((stream) => proxyStreamHgStream(stream, context))
            : bucket;
    }
    return out;
}

module.exports = {
    getStreamPlaybackHeaders,
    hasStreamHgSignal,
    proxyStreamHgStream,
    proxyStreamHgWebBuckets,
    shouldProxyStreamHgStream
};
