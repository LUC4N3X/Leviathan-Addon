/**
 * Leviathan Edge Gateway - Cloudflare Worker
 *
 * Ruolo: front-door leggero per manifest/config/assets/catalog/meta/stream metadata.
 * NON è un FlareSolverr, NON fa scraping provider, NON deve proxyare segmenti HLS.
 * Non riscrive l'URL di installazione generato da index.html/smartphone.js.
 */

const DEFAULT_TIMEOUT_MS = 25000;
const DEFAULT_STREAM_TIMEOUT_MS = 35000;
const MAX_PREFETCH_BODY_BYTES = 2048;
const DEFAULT_STALE_SECONDS = 21600; // 6h di fallback solo per risposte leggere già cacheate.
const MAX_CACHE_SECONDS = 604800;

function envBool(env, name, fallback = false) {
  const raw = env?.[name];
  if (raw === undefined || raw === null || raw === '') return fallback;
  return /^(1|true|yes|y|on)$/i.test(String(raw).trim());
}

function envInt(env, name, fallback, min, max) {
  const parsed = Number.parseInt(String(env?.[name] ?? ''), 10);
  const safe = Number.isFinite(parsed) ? parsed : fallback;
  return Math.max(min, Math.min(max, safe));
}

function normalizeOrigin(origin) {
  const value = String(origin || '').trim().replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(value)) return '';
  return value;
}

function buildOriginUrl(request, env) {
  const origin = normalizeOrigin(env.ORIGIN_URL || env.LEVIATHAN_ORIGIN_URL);
  if (!origin) throw new Error('ORIGIN_URL missing');
  const incoming = new URL(request.url);
  return new URL(`${incoming.pathname}${incoming.search}`, origin);
}

function isAssetPath(pathname) {
  return /\.(?:png|jpg|jpeg|webp|gif|svg|ico|css|js|mp4|txt|map|woff2?)$/i.test(pathname)
    || pathname.startsWith('/images/')
    || pathname.startsWith('/public/')
    || pathname.startsWith('/static/');
}

function isManifestPath(pathname) {
  return pathname === '/manifest.json' || /\/manifest\.json$/i.test(pathname);
}

function isConfigurePath(pathname) {
  if (pathname === '/' || pathname === '/configure' || pathname === '/configure/') return true;
  const parts = pathname.split('/').filter(Boolean);
  return parts.length === 1 && parts[0].length > 10 && !parts[0].endsWith('.json');
}

function isCatalogPath(pathname) {
  return /\/catalog\/(movie|series|anime|tv|other)\/[^/]+\.json$/i.test(pathname);
}

function isMetaPath(pathname) {
  return /\/meta\/(movie|series|anime|tv|other)\/[^/]+\.json$/i.test(pathname);
}

function isSubtitlesPath(pathname) {
  return /\/subtitles\/(movie|series|anime|tv)\/[^/]+\.json$/i.test(pathname);
}

function isStreamPath(pathname) {
  return /\/stream\/(movie|series|anime|tv)\/.+\.json$/i.test(pathname);
}

function isLightStremioJson(pathname) {
  return isManifestPath(pathname)
    || isConfigurePath(pathname)
    || isCatalogPath(pathname)
    || isMetaPath(pathname)
    || isSubtitlesPath(pathname)
    || isStreamPath(pathname);
}

function isPlaybackProxyPath(pathname) {
  return pathname === '/vixsynthetic.m3u8'
    || pathname.startsWith('/ccproxy/')
    || pathname.startsWith('/proxy/')
    || pathname.startsWith('/mfp/')
    || pathname.startsWith('/mediaflow/')
    || pathname.startsWith('/extractor/')
    || pathname.includes('.m3u8')
    || pathname.includes('.ts')
    || pathname.includes('.m4s')
    || pathname.includes('.mpd')
    || pathname.includes('.vtt');
}

function cacheSecondsFor(pathname, env) {
  if (isAssetPath(pathname)) return envInt(env, 'EDGE_CACHE_ASSETS_SECONDS', 86400, 0, MAX_CACHE_SECONDS);
  if (isManifestPath(pathname)) return envInt(env, 'EDGE_CACHE_MANIFEST_SECONDS', 3600, 0, 86400);
  if (isConfigurePath(pathname)) return envInt(env, 'EDGE_CACHE_CONFIGURE_SECONDS', 600, 0, 86400);
  if (isCatalogPath(pathname)) return envInt(env, 'EDGE_CACHE_CATALOG_SECONDS', 300, 0, 3600);
  if (isMetaPath(pathname)) return envInt(env, 'EDGE_CACHE_META_SECONDS', 900, 0, 86400);
  if (isSubtitlesPath(pathname)) return envInt(env, 'EDGE_CACHE_SUBTITLES_SECONDS', 900, 0, 86400);
  // Stream metadata può contenere config/token nel path: default prudente a 0.
  if (isStreamPath(pathname)) return envInt(env, 'EDGE_CACHE_STREAM_SECONDS', 0, 0, 120);
  return 0;
}

function staleSecondsFor(pathname, env, cacheSeconds) {
  if (!envBool(env, 'EDGE_STALE_FALLBACK_ENABLED', true)) return 0;
  if (!isLightStremioJson(pathname) && !isAssetPath(pathname)) return 0;
  const fallback = Math.max(cacheSeconds, DEFAULT_STALE_SECONDS);
  return envInt(env, 'EDGE_STALE_FALLBACK_SECONDS', fallback, 0, MAX_CACHE_SECONDS);
}

function buildForwardHeaders(request, env) {
  const incoming = new URL(request.url);
  const headers = new Headers(request.headers);
  headers.set('x-leviathan-edge', '1');
  headers.set('x-forwarded-host', incoming.host);
  headers.set('x-forwarded-proto', incoming.protocol.replace(':', ''));
  headers.set('x-leviathan-edge-path', incoming.pathname);
  if (env.EDGE_SECRET) headers.set(env.EDGE_SECRET_HEADER || 'x-leviathan-edge-secret', env.EDGE_SECRET);
  headers.delete('cf-connecting-o2o');
  return headers;
}

function timeoutSignal(ms) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort('edge_timeout'), ms);
  return { signal: controller.signal, cancel: () => clearTimeout(timer) };
}

function cleanResponseHeaders(response, cacheSeconds, pathname) {
  const headers = new Headers(response.headers);
  headers.set('access-control-allow-origin', '*');
  headers.set('x-leviathan-edge-gateway', '1');
  headers.delete('server');
  headers.delete('x-powered-by');
  if (cacheSeconds > 0 && response.ok) {
    headers.set('cache-control', `public, max-age=${cacheSeconds}, stale-while-revalidate=60`);
  } else if (isStreamPath(pathname)) {
    headers.set('cache-control', 'no-store');
  }
  return headers;
}

function fallbackResponse(error, pathname) {
  const isManifest = isManifestPath(pathname);
  const body = isManifest
    ? { id: 'org.stremio.leviathan.edge.fallback', version: '0.0.0', name: 'Leviathan Edge', description: 'Origin temporaneamente non disponibile.', resources: [], types: [] }
    : { ok: false, status: 'origin_unavailable', error: String(error?.message || error || 'fetch_failed') };
  return new Response(JSON.stringify(body), {
    status: isManifest ? 200 : 503,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'access-control-allow-origin': '*',
      'x-leviathan-edge-gateway': '1',
      'x-leviathan-edge-fallback': '1'
    }
  });
}

function parseStreamHint(pathname) {
  const match = pathname.match(/\/stream\/(movie|series|anime|tv)\/([^/]+)\.json$/i);
  if (!match) return null;
  const type = match[1].toLowerCase() === 'tv' ? 'series' : match[1].toLowerCase();
  return { type, id: decodeURIComponent(match[2]) };
}

async function sendPrewarmHint(request, env) {
  if (!envBool(env, 'EDGE_PREWARM_HINTS_ENABLED', true)) return;
  if (!env.EDGE_SECRET) return;
  const incoming = new URL(request.url);
  const hint = parseStreamHint(incoming.pathname);
  if (!hint) return;

  const origin = normalizeOrigin(env.ORIGIN_URL || env.LEVIATHAN_ORIGIN_URL);
  if (!origin) return;
  const body = JSON.stringify({ ...hint, reason: 'edge-stream-request', priority: 65 });
  if (body.length > MAX_PREFETCH_BODY_BYTES) return;

  const endpoint = new URL('/internal/edge/prewarm', origin);
  const timeout = timeoutSignal(envInt(env, 'EDGE_PREWARM_TIMEOUT_MS', 1200, 250, 5000));
  try {
    await fetch(endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        [env.EDGE_SECRET_HEADER || 'x-leviathan-edge-secret']: env.EDGE_SECRET,
        'x-leviathan-edge': '1'
      },
      body,
      signal: timeout.signal
    });
  } catch (_) {
    // Hint best-effort: mai rompere la risposta Stremio per la coda.
  } finally {
    timeout.cancel();
  }
}

function buildCacheKeys(originUrl, pathname, request, env) {
  const cacheVersion = String(env.EDGE_CACHE_VERSION || 'v1');
  const base = originUrl.toString();
  const saltHeaders = [];
  // Evita collisioni quando un client usa header che possono cambiare la risposta.
  if (request.headers.has('accept-language')) saltHeaders.push(`al=${request.headers.get('accept-language')}`);
  const suffix = saltHeaders.length ? `#${saltHeaders.join('&')}` : '';
  return {
    fresh: new Request(`https://leviathan.edge.cache/${cacheVersion}/fresh/${encodeURIComponent(base + suffix)}`, { method: 'GET' }),
    stale: new Request(`https://leviathan.edge.cache/${cacheVersion}/stale/${encodeURIComponent(base + suffix)}`, { method: 'GET' })
  };
}

async function cachePutSafe(ctx, cache, key, response, seconds, marker) {
  if (!seconds || seconds <= 0 || !response.ok) return;
  const headers = new Headers(response.headers);
  headers.set('cache-control', `public, max-age=${seconds}`);
  headers.set('x-leviathan-edge-cache-layer', marker);
  const cachedResponse = new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers
  });
  ctx.waitUntil(cache.put(key, cachedResponse).catch(() => {}));
}

async function fetchOrigin(request, env, originUrl, pathname) {
  const method = request.method.toUpperCase();
  const timeoutMs = isStreamPath(pathname)
    ? envInt(env, 'EDGE_STREAM_TIMEOUT_MS', DEFAULT_STREAM_TIMEOUT_MS, 1000, 55000)
    : envInt(env, 'EDGE_ORIGIN_TIMEOUT_MS', DEFAULT_TIMEOUT_MS, 1000, 55000);
  const timeout = timeoutSignal(timeoutMs);
  try {
    const forwarded = new Request(originUrl.toString(), {
      method,
      headers: buildForwardHeaders(request, env),
      body: method === 'GET' || method === 'HEAD' ? undefined : request.body,
      redirect: 'manual',
      signal: timeout.signal
    });
    return await fetch(forwarded);
  } finally {
    timeout.cancel();
  }
}

async function fetchWithCache(request, env, ctx, originUrl, pathname) {
  const cacheSeconds = cacheSecondsFor(pathname, env);
  const staleSeconds = staleSecondsFor(pathname, env, cacheSeconds);
  const method = request.method.toUpperCase();
  const canCache = method === 'GET'
    && cacheSeconds > 0
    && !request.headers.has('authorization')
    && !request.headers.has('range')
    && !request.headers.has('cookie');
  const cache = caches.default;
  const keys = buildCacheKeys(originUrl, pathname, request, env);

  if (canCache) {
    const cached = await cache.match(keys.fresh);
    if (cached) {
      const headers = new Headers(cached.headers);
      headers.set('x-leviathan-edge-cache', 'HIT');
      return new Response(cached.body, { status: cached.status, statusText: cached.statusText, headers });
    }
  }

  let response;
  try {
    response = await fetchOrigin(request, env, originUrl, pathname);
  } catch (error) {
    if (canCache && staleSeconds > 0) {
      const stale = await cache.match(keys.stale);
      if (stale) {
        const headers = new Headers(stale.headers);
        headers.set('x-leviathan-edge-cache', 'STALE');
        headers.set('x-leviathan-edge-stale', '1');
        return new Response(stale.body, { status: stale.status, statusText: stale.statusText, headers });
      }
    }
    return fallbackResponse(error, pathname);
  }

  const headers = cleanResponseHeaders(response, cacheSeconds, pathname);
  headers.set('x-leviathan-edge-cache', canCache ? 'MISS' : 'BYPASS');
  const out = new Response(response.body, { status: response.status, statusText: response.statusText, headers });

  if (canCache && response.ok) {
    cachePutSafe(ctx, cache, keys.fresh, out.clone(), cacheSeconds, 'fresh');
    if (staleSeconds > cacheSeconds) cachePutSafe(ctx, cache, keys.stale, out.clone(), staleSeconds, 'stale');
  }
  return out;
}

function directOriginRedirect(originUrl) {
  return Response.redirect(originUrl.toString(), 307);
}

export default {
  async fetch(request, env, ctx) {
    const incoming = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: {
          'access-control-allow-origin': '*',
          'access-control-allow-methods': 'GET,HEAD,POST,OPTIONS',
          'access-control-allow-headers': 'content-type,authorization,range,if-none-match,if-modified-since',
          'access-control-max-age': '86400'
        }
      });
    }

    if (!['GET', 'HEAD', 'POST'].includes(request.method.toUpperCase())) {
      return new Response('Method Not Allowed', { status: 405, headers: { allow: 'GET, HEAD, POST, OPTIONS' } });
    }

    let originUrl;
    try {
      originUrl = buildOriginUrl(request, env);
    } catch (error) {
      return fallbackResponse(error, incoming.pathname);
    }

    // Non tocchiamo la generazione URL installazione in index.html/smartphone.js.
    // Il Worker accelera/forwarda la pagina, ma non riscrive link o manifest URL.

    if (isPlaybackProxyPath(incoming.pathname) && !envBool(env, 'EDGE_PROXY_PLAYBACK', false)) {
      return directOriginRedirect(originUrl);
    }

    if (isStreamPath(incoming.pathname)) {
      ctx.waitUntil(sendPrewarmHint(request, env));
    }

    return fetchWithCache(request, env, ctx, originUrl, incoming.pathname);
  }
};
