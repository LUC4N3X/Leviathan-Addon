(() => {
    'use strict';

    const DEFAULT_TIMEOUT_MS = 18000;

    function normalizeBaseUrl(value) {
        return String(value || '').trim().replace(/\/+$/, '');
    }

    function buildAdminUrl(baseUrl, path) {
        const normalized = normalizeBaseUrl(baseUrl);
        if (!/^https?:\/\//i.test(normalized)) {
            throw new Error('URL Leviathan non valido. Deve iniziare con http:// o https://');
        }
        return `${normalized}${path}`;
    }

    async function readJsonResponse(response) {
        const text = await response.text();
        if (!text) return {};
        try {
            return JSON.parse(text);
        } catch (_) {
            return { message: text };
        }
    }

    async function requestLeviathan({ addonBaseUrl, adminPass, path, payload, method = 'POST', timeoutMs = DEFAULT_TIMEOUT_MS }) {
        const adminToken = String(adminPass || '').trim();
        if (!adminToken) throw new Error('ADMIN_PASS mancante.');

        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), Number(timeoutMs) || DEFAULT_TIMEOUT_MS);
        try {
            const response = await fetch(buildAdminUrl(addonBaseUrl, path), {
                method,
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${adminToken}`
                },
                body: method === 'GET' || method === 'HEAD' ? undefined : JSON.stringify(payload || {}),
                signal: controller.signal
            });

            const data = method === 'HEAD' ? {} : await readJsonResponse(response);
            if (!response.ok || data.success === false) {
                const err = new Error(data.error || data.message || `HTTP ${response.status}`);
                err.status = response.status;
                err.data = data;
                throw err;
            }
            return data;
        } catch (error) {
            if (error?.name === 'AbortError') {
                throw new Error(`Timeout Leviathan dopo ${Math.round((Number(timeoutMs) || DEFAULT_TIMEOUT_MS) / 1000)}s.`);
            }
            throw error;
        } finally {
            clearTimeout(timeout);
        }
    }

    async function healthCheck(message) {
        try {
            const data = await requestLeviathan({
                addonBaseUrl: message.addonBaseUrl,
                adminPass: message.adminPass,
                path: '/admin/health',
                method: 'GET',
                timeoutMs: 9000
            });
            return { ok: true, data, mode: 'admin-health' };
        } catch (firstError) {
            if (![404, 405].includes(Number(firstError?.status))) {
                throw firstError;
            }
            const data = await requestLeviathan({
                addonBaseUrl: message.addonBaseUrl,
                adminPass: message.adminPass,
                path: '/admin/manual-import/identity-candidates',
                payload: { title: 'Leviathan Health Probe', type: 'movie', limit: 1 },
                timeoutMs: 9000
            });
            return { ok: true, data, mode: 'identity-probe', warning: 'Endpoint /admin/health non presente: connessione verificata tramite identity-candidates.' };
        }
    }

    chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
        const supported = new Set([
            'LEVIATHAN_MANUAL_IMPORT',
            'LEVIATHAN_IDENTITY_SEARCH',
            'LEVIATHAN_HEALTH_CHECK',
            'LEVIATHAN_DRY_RUN',
            'LEVIATHAN_CACHE_CHECK'
        ]);
        if (!message || !supported.has(message.type)) return false;

        (async () => {
            try {
                if (message.type === 'LEVIATHAN_HEALTH_CHECK') {
                    sendResponse(await healthCheck(message));
                    return;
                }

                const pathByType = {
                    LEVIATHAN_IDENTITY_SEARCH: '/admin/manual-import/identity-candidates',
                    LEVIATHAN_MANUAL_IMPORT: '/admin/manual-import',
                    LEVIATHAN_DRY_RUN: '/admin/manual-import/dry-run',
                    LEVIATHAN_CACHE_CHECK: '/admin/manual-import/cache-check'
                };

                const data = await requestLeviathan({
                    addonBaseUrl: message.addonBaseUrl,
                    adminPass: message.adminPass,
                    path: pathByType[message.type],
                    payload: message.payload,
                    timeoutMs: message.type === 'LEVIATHAN_MANUAL_IMPORT' ? 30000 : DEFAULT_TIMEOUT_MS
                });
                sendResponse({ ok: true, data });
            } catch (error) {
                sendResponse({ ok: false, error: error?.message || String(error), status: error?.status || null, data: error?.data || null });
            }
        })();

        return true;
    });
})();
