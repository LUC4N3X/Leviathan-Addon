(() => {
    'use strict';

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

    async function postToLeviathan({ addonBaseUrl, adminPass, path, payload }) {
        const adminToken = String(adminPass || '').trim();
        if (!adminToken) throw new Error('ADMIN_PASS mancante.');

        const response = await fetch(buildAdminUrl(addonBaseUrl, path), {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${adminToken}`
            },
            body: JSON.stringify(payload || {})
        });

        const data = await readJsonResponse(response);
        if (!response.ok || data.success === false) {
            throw new Error(data.error || data.message || `HTTP ${response.status}`);
        }
        return data;
    }

    chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
        if (!message || !['LEVIATHAN_MANUAL_IMPORT', 'LEVIATHAN_IDENTITY_SEARCH'].includes(message.type)) return false;

        (async () => {
            try {
                const path = message.type === 'LEVIATHAN_IDENTITY_SEARCH'
                    ? '/admin/manual-import/identity-candidates'
                    : '/admin/manual-import';
                const data = await postToLeviathan({
                    addonBaseUrl: message.addonBaseUrl,
                    adminPass: message.adminPass,
                    path,
                    payload: message.payload
                });
                sendResponse({ ok: true, data });
            } catch (error) {
                sendResponse({ ok: false, error: error?.message || String(error) });
            }
        })();

        return true;
    });
})();
