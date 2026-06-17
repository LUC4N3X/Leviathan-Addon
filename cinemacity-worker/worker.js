const DEFAULT_ORIGIN = 'https://cinemacity.cc';
const DEFAULT_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';
const FETCH_TIMEOUT_MS = 20000;

function normalizeOrigin(value) {
  const raw = String(value || '').trim().replace(/\/+$/, '');
  if (!raw) return DEFAULT_ORIGIN;
  if (!/^https?:\/\//i.test(raw)) return `https://${raw}`;
  return raw;
}

function buildTargetUrl(request, env) {
  const origin = normalizeOrigin(env && env.CINEMACITY_ORIGIN);
  const incoming = new URL(request.url);
  return `${origin}${incoming.pathname}${incoming.search}`;
}

function buildForwardHeaders(env) {
  const origin = normalizeOrigin(env && env.CINEMACITY_ORIGIN);
  const headers = new Headers();
  headers.set('User-Agent', (env && env.CINEMACITY_USER_AGENT) || DEFAULT_USER_AGENT);
  headers.set('Referer', `${origin}/`);
  headers.set('Origin', origin);
  headers.set('Accept', 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8');
  headers.set('Accept-Language', 'it-IT,it;q=0.9,en-US;q=0.8,en;q=0.7');
  headers.set('Upgrade-Insecure-Requests', '1');
  const cookie = env && (env.CINEMACITY_COOKIE || env.CF_CLEARANCE);
  if (cookie) headers.set('Cookie', String(cookie));
  return headers;
}

function isAuthorized(request, env) {
  const expected = env && env.PROXY_SECRET ? String(env.PROXY_SECRET).trim() : '';
  if (!expected) return true;
  const url = new URL(request.url);
  const provided = request.headers.get('x-proxy-secret') || url.searchParams.get('secret') || '';
  return provided === expected;
}

export default {
  async fetch(request, env) {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return new Response('Method Not Allowed', { status: 405 });
    }
    if (!isAuthorized(request, env)) {
      return new Response('Forbidden', { status: 403 });
    }

    const target = buildTargetUrl(request, env);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

    try {
      const upstream = await fetch(target, {
        method: request.method,
        headers: buildForwardHeaders(env),
        redirect: 'follow',
        signal: controller.signal,
        cf: { cacheTtl: 0, cacheEverything: false }
      });

      const headers = new Headers(upstream.headers);
      headers.set('Access-Control-Allow-Origin', '*');
      headers.set('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
      headers.delete('set-cookie');
      headers.delete('content-security-policy');
      headers.delete('content-security-policy-report-only');

      return new Response(request.method === 'HEAD' ? null : upstream.body, {
        status: upstream.status,
        statusText: upstream.statusText,
        headers
      });
    } catch (error) {
      const message = error && error.message ? error.message : 'unknown error';
      return new Response(`Upstream fetch failed: ${message}`, { status: 502 });
    } finally {
      clearTimeout(timer);
    }
  }
};
