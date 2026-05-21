const MOBILE_LOGO_URL = "https://i.ibb.co/MbmdvP6/file-0000000018387243a2da8535139f6423.png";
const MOBILE_LOGO_HINTS_ID = "leviathan-mobile-logo-hints";
const MOBILE_LOGO_PRELOAD_ID = "leviathan-mobile-logo-preload";

const MOBILE_PERF = {
    maxDpr: 1.0,
    targetFps: 24,
    lowFxFps: 14,
    keyboardDeltaPx: 110,
    inputIdleMs: 420,
    viewportRaf: 0,
    inputIdleTimer: null
};

function isMobileCoarsePointer() {
    try {
        return window.matchMedia && window.matchMedia('(pointer: coarse)').matches;
    } catch (_) {
        return true;
    }
}

function ensureMobileLogoHints() {
    try {
        if (!document.head) return;
        if (!document.getElementById(MOBILE_LOGO_HINTS_ID)) {
            const frag = document.createDocumentFragment();

            const preconnect = document.createElement("link");
            preconnect.id = MOBILE_LOGO_HINTS_ID;
            preconnect.rel = "preconnect";
            preconnect.href = "https://i.ibb.co";
            preconnect.crossOrigin = "anonymous";
            frag.appendChild(preconnect);

            const dns = document.createElement("link");
            dns.rel = "dns-prefetch";
            dns.href = "https://i.ibb.co";
            frag.appendChild(dns);

            document.head.appendChild(frag);
        }

        if (!document.getElementById(MOBILE_LOGO_PRELOAD_ID)) {
            const preload = document.createElement("link");
            preload.id = MOBILE_LOGO_PRELOAD_ID;
            preload.rel = "preload";
            preload.as = "image";
            preload.href = MOBILE_LOGO_URL;
            preload.setAttribute("fetchpriority", "high");
            document.head.appendChild(preload);
        }
    } catch (_) {}
}

function primeMobileLogo() {
    ensureMobileLogoHints();
    try {
        const img = new Image();
        img.decoding = "async";
        img.fetchPriority = "high";
        img.src = MOBILE_LOGO_URL;
    } catch (_) {}
}

function hydrateMobileLogo() {
    const img = document.querySelector(".logo-image");
    if (!img) return;

    const markLoaded = () => {
        img.classList.add("is-loaded");
        img.removeAttribute("data-loading");
    };

    if ("complete" in img && img.complete) {
        markLoaded();
        return;
    }

    img.setAttribute("data-loading", "1");
    img.addEventListener("load", markLoaded, { once: true });
    img.addEventListener("error", () => img.removeAttribute("data-loading"), { once: true });
}


const MOBILE_BRAND_LOCK_TEXT = "LEVIATHAN";

function lockMobileBrandTitle() {
    try {
        const title = document.querySelector(".m-abyss-title") || document.querySelector(".m-brand-title");
        if (!title) return;

        if (title.textContent !== MOBILE_BRAND_LOCK_TEXT) {
            title.textContent = MOBILE_BRAND_LOCK_TEXT;
        }

        title.classList.add("notranslate");
        title.setAttribute("translate", "no");
        title.setAttribute("lang", "zxx");
        title.setAttribute("aria-label", MOBILE_BRAND_LOCK_TEXT);
        title.setAttribute("data-brand-lock", MOBILE_BRAND_LOCK_TEXT);
        title.setAttribute("data-no-translate", "true");

        const hero = title.closest(".m-abyss-hero, .m-hero");
        if (hero) {
            hero.classList.add("notranslate");
            hero.setAttribute("translate", "no");
            hero.setAttribute("data-no-translate", "true");
        }

        if (window.__leviathanBrandLockObserver) return;

        const observer = new MutationObserver(() => {
            const lockedTitle = document.querySelector("[data-brand-lock]");
            if (lockedTitle && lockedTitle.textContent !== MOBILE_BRAND_LOCK_TEXT) {
                lockedTitle.textContent = MOBILE_BRAND_LOCK_TEXT;
            }
        });
        observer.observe(title, { childList: true, characterData: true, subtree: true });
        window.__leviathanBrandLockObserver = observer;
    } catch (_) {}
}

function applyMobilePerformanceMode() {
    if (!document.body) return;
    try {
        const cores = navigator.hardwareConcurrency || 0;
        const memory = Number(navigator['deviceMemory'] || 0);
        const width = Math.min(window.innerWidth || 390, screen.width || 390);
        const reduceMotion = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
        const coarse = isMobileCoarsePointer();
        const lowFx = reduceMotion || (cores && cores <= 4) || (memory && memory <= 4) || width <= 360;

        document.body.classList.add('m-mf-lite', 'm-mf-plus');
        document.body.classList.toggle('m-lowfx', !!lowFx);
        document.body.classList.toggle('m-touch', !!coarse);
        document.documentElement.style.setProperty('--m-vvh', `${window.innerHeight}px`);
    } catch (_) {
        document.body.classList.add('m-mf-lite', 'm-mf-plus');
    }
}

function isMobileTextField(el = document.activeElement) {
    return !!el?.matches?.(
        'input:not([type]), input[type="text"], input[type="password"], input[type="search"], input[type="email"], input[type="url"], input[type="tel"], input[type="number"], textarea, [contenteditable="true"]'
    );
}

function mById(id) {
    return document.getElementById(id);
}

function mAsElement(value) {
    return value && value.nodeType === 1 ? value : null;
}

function mClosest(value, selector) {
    return mAsElement(value)?.closest?.(selector) || null;
}

function mChecked(id, fallback = false) {
    const el = mById(id);
    return !!(el && "checked" in el ? el.checked : fallback);
}

function mSetChecked(id, value) {
    const el = mById(id);
    if (el && "checked" in el) el.checked = !!value;
    return el;
}

function mValue(id, fallback = "") {
    const el = mById(id);
    return el && "value" in el ? String(el.value ?? "") : fallback;
}

function mSetValue(id, value) {
    const el = mById(id);
    if (el && "value" in el) el.value = value == null ? "" : String(value);
    return el;
}

function mSetDisabled(id, value) {
    const el = mById(id);
    if (el && "disabled" in el) el.disabled = !!value;
    return el;
}

function mSetPlaceholder(id, value) {
    const el = mById(id);
    if (el && "placeholder" in el) el.placeholder = value == null ? "" : String(value);
    return el;
}

function mSetText(id, value) {
    const el = mById(id);
    if (el) el.innerText = value == null ? "" : String(value);
    return el;
}

function mHasClass(id, cls) {
    return !!mById(id)?.classList?.contains(cls);
}

function mAddClass(id, cls) {
    const el = mById(id);
    if (el) el.classList.add(cls);
    return el;
}

function mToggleClass(id, cls, force) {
    const el = mById(id);
    if (el) el.classList.toggle(cls, !!force);
    return el;
}

function mSetStyle(el, prop, value) {
    if (el?.style) el.style[prop] = String(value);
}

function mVibrate(pattern) {
    try {
        if (navigator && typeof navigator.vibrate === 'function') navigator.vibrate(pattern);
    } catch (_) {}
}

const mobileCSS = `
:root {
    --m-bg: #000205;
    --m-bg-deep: #00060c;
    --m-primary: #00f2ff;
    --m-primary-dim: rgba(0, 242, 255, 0.18);
    --m-secondary: #7000ff;
    --m-accent: #7c3aed;
    --m-amber: #22d3ee;
    --m-orange: #0ea5e9;
    --m-cine: #38bdf8;
    --m-kofi: #22d3ee;
    --m-surface: rgba(8, 14, 22, 0.85);
    --m-surface-2: rgba(4, 8, 14, 0.92);
    --m-text: #e0f7fa;
    --m-dim: #7a9ab5;
    --m-faint: rgba(122, 154, 181, 0.55);
    --m-error: #ff3366;
    --m-success: #00ff9d;
    --safe-bottom: env(safe-area-inset-bottom);
    --m-glow: 0 0 15px rgba(0, 242, 255, 0.3);
    --m-glow-strong: 0 0 22px rgba(0, 242, 255, 0.45);
    --m-radius-lg: 22px;
    --m-radius-md: 14px;
    --m-radius-sm: 10px;
}

* { box-sizing: border-box; -webkit-tap-highlight-color: transparent; outline: none; user-select: none; }

* { scrollbar-width: thin; scrollbar-color: rgba(0, 242, 255, 0.4) transparent; }
::-webkit-scrollbar { width: 3px; height: 3px; }
::-webkit-scrollbar-track { background: transparent; }
::-webkit-scrollbar-thumb { background: rgba(0, 242, 255, 0.4); border-radius: 10px; }
::-webkit-scrollbar-thumb:active { background: var(--m-primary); }

body {
    margin: 0;
    background:
        radial-gradient(ellipse at 50% 0%, rgba(0, 242, 255, 0.22) 0%, rgba(0, 220, 255, 0.06) 25%, transparent 55%),
        radial-gradient(ellipse at 50% 110%, rgba(0, 60, 120, 0.35) 0%, rgba(0, 20, 60, 0.15) 40%, transparent 70%),
        radial-gradient(circle at 90% 80%, rgba(112, 0, 255, 0.20) 0%, transparent 42%),
        radial-gradient(circle at 8% 65%, rgba(0, 180, 255, 0.10) 0%, transparent 38%),
        radial-gradient(ellipse at 50% 50%, rgba(0, 30, 80, 0.4) 0%, transparent 80%),
        linear-gradient(180deg, #030e1c 0%, #020810 30%, #010509 60%, #000204 100%);
    font-family: 'Outfit', sans-serif;
    color: var(--m-text);
    width: 100%;
    height: 100%;
    overscroll-behavior: none;
    overflow: hidden;
}

body::after {
    content: " ";
    display: block;
    position: fixed;
    top: 0; left: 0; bottom: 0; right: 0;
    background:
        linear-gradient(rgba(18, 16, 16, 0) 50%, rgba(0, 0, 0, 0.025) 50%),
        linear-gradient(90deg, rgba(255, 0, 0, 0.012), rgba(0, 255, 0, 0.006), rgba(0, 0, 255, 0.012));
    z-index: 0;
    background-size: 100% 3px, 4px 100%;
    pointer-events: none;
    opacity: 0.07;
    mix-blend-mode: normal;
}

body::before {
    content: ''; position: fixed; top: 0; left: 0; width: 100%; height: 100%; z-index: -10;
    background-image:
        linear-gradient(rgba(0, 242, 255, 0.055) 1px, transparent 1px),
        linear-gradient(90deg, rgba(0, 242, 255, 0.055) 1px, transparent 1px);
    background-size: 44px 44px;
    pointer-events: none;
    mask-image: radial-gradient(ellipse at 50% 0%, black 0%, rgba(0,0,0,0.5) 55%, transparent 100%);
    -webkit-mask-image: radial-gradient(ellipse at 50% 0%, black 0%, rgba(0,0,0,0.5) 55%, transparent 100%);
    animation: gridDrift 80s linear infinite;
}
@keyframes gridDrift { from { background-position: 0 0; } to { background-position: 44px 44px; } }

.m-caustic {
    position: fixed; top: 0; left: 0; width: 100%; height: 55%; pointer-events: none; z-index: -8; overflow: hidden;
}
.m-caustic-ray {
    position: absolute; top: -10%; width: 60px; height: 110%;
    background: linear-gradient(180deg, rgba(0,220,255,0.09) 0%, rgba(0,180,255,0.04) 50%, transparent 100%);
    transform-origin: top center;
    border-radius: 50%;
    animation: causticSway var(--ray-dur, 12s) ease-in-out infinite alternate;
    opacity: var(--ray-op, 0.6);
    left: var(--ray-x, 30%);
}
@keyframes causticSway {
    0% { transform: rotate(var(--ray-from, -8deg)) scaleX(1); opacity: var(--ray-op, 0.6); }
    100% { transform: rotate(var(--ray-to, 8deg)) scaleX(1.3); opacity: calc(var(--ray-op, 0.6) * 0.5); }
}

.m-ocean-particles { position: fixed; top: 0; left: 0; width: 100%; height: 100%; pointer-events: none; z-index: -5; overflow: hidden; }
.m-ocean-particle {
    position: absolute; bottom: -10px;
    width: 3px; height: 3px; border-radius: 50%;
    background: radial-gradient(circle, rgba(0, 242, 255, 0.95) 0%, rgba(0, 200, 255, 0.3) 50%, transparent 100%);
    box-shadow: 0 0 8px 2px rgba(0, 242, 255, 0.6), 0 0 20px rgba(0, 220, 255, 0.2);
    opacity: 0;
    animation: oceanFloat 18s linear infinite;
}
@keyframes oceanFloat {
    0% { transform: translate3d(0, 0, 0) scale(0.5); opacity: 0; }
    10% { opacity: 0.9; }
    85% { opacity: 0.4; }
    100% { transform: translate3d(var(--drift, 12px), -110vh, 0) scale(1.4); opacity: 0; }
}

#m-sea-canvas {
    position: fixed; bottom: 0; left: 0; width: 100%;
    pointer-events: none; z-index: -6;
    display: block;
    will-change: transform;
}

#app-container {
    display: flex; flex-direction: column; height: 100dvh; width: 100%; max-width: 100%; position: relative; overflow: hidden;
}

.m-content-wrapper {
    flex: 1; display: flex; flex-direction: column; min-height: 0; position: relative; overflow: hidden; z-index: 5;
}

.m-content {
    flex: 1; overflow-y: auto; overflow-x: hidden;
    padding: 0 14px calc(226px + var(--safe-bottom)) 14px; width: 100%;
    overscroll-behavior: contain;
    scroll-behavior: smooth;
}

.m-hypervisor + .m-hypervisor,
.m-visual-core-v2 + .m-hypervisor,
.m-hypervisor + .m-visual-core-v2 {
    margin-top: 18px;
}

.m-section-head {
    display: none; align-items: center; justify-content: space-between;
    margin: 0 4px 12px 4px;
    padding: 6px 0 6px 12px;
    border-left: 3px solid var(--m-primary);
    box-shadow: -3px 0 10px -2px rgba(0, 242, 255, 0.5);
    position: relative;
}
.m-section-head .sh-titles { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.m-section-head .sh-title {
    font-family: 'Rajdhani', sans-serif; font-size: 0.95rem; font-weight: 800;
    color: #fff; text-transform: uppercase; letter-spacing: 3px;
    text-shadow: 0 0 8px rgba(0, 242, 255, 0.35);
}
.m-section-head .sh-sub {
    font-family: 'Outfit', sans-serif; font-size: 0.62rem; color: var(--m-dim);
    letter-spacing: 1.4px; text-transform: uppercase; opacity: 0.85;
}
.m-section-head .sh-tag {
    font-family: 'Rajdhani', monospace; font-size: 0.55rem; font-weight: 800;
    padding: 3px 7px; border-radius: 4px; letter-spacing: 1.4px;
    color: var(--m-primary); border: 1px solid rgba(0, 242, 255, 0.35);
    background: rgba(0, 242, 255, 0.06); white-space: nowrap;
}
.m-section-head .sh-tag.warn { color: var(--m-amber); border-color: rgba(34, 211, 238, 0.4); background: rgba(34, 211, 238, 0.06); }
.m-section-head .sh-tag.violet { color: var(--m-secondary); border-color: rgba(112, 0, 255, 0.4); background: rgba(112, 0, 255, 0.06); }

.m-ptr {
    position: absolute; top: -70px; left: 0; width: 100%; height: 70px;
    display: flex; align-items: flex-end; justify-content: center;
    padding-bottom: 15px; color: var(--m-primary);
    z-index: 100;
    pointer-events: none; opacity: 0; transition: opacity 0.2s ease-out;
}
.m-ptr-icon {
    font-size: 1.4rem; transition: transform 0.3s cubic-bezier(0.175, 0.885, 0.32, 1.275);
    background: rgba(0, 5, 10, 0.9); padding: 12px; border-radius: 50%; border: 1px solid var(--m-primary);
    box-shadow: 0 0 20px rgba(0, 242, 255, 0.4);
}
.m-ptr.loading .m-ptr-icon { animation: spin 1s linear infinite; border-color: var(--m-accent); }
@keyframes spin { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }

.m-page { display: none; width: 100%; }
.m-page.active { display: block; animation: fadeFast 0.35s ease-out; }
@keyframes fadeFast { from { opacity: 0; transform: translate3d(0, 15px, 0); } to { opacity: 1; transform: translate3d(0, 0, 0); } }

.m-hero {
    text-align: center;
    padding: 24px 8px 22px;
    display: flex;
    flex-direction: column;
    align-items: center;
    width: 100%;
    position: relative;
    overflow: visible;
    z-index: 10;
    isolation: isolate;
}

.m-hero-panel {
    width: 100%;
    max-width: 400px;
    padding: 18px 4px 24px;
    position: relative;
    overflow: visible;
    background: transparent;
    border: 0;
    box-shadow: none;
}

.m-hero-panel::before {
    content: '';
    position: absolute;
    left: 50%;
    top: 26px;
    width: min(420px, 108vw);
    height: 248px;
    transform: translateX(-50%);
    pointer-events: none;
    z-index: -3;
    background:
        radial-gradient(ellipse at 50% 32%, rgba(91, 236, 255, 0.30), rgba(91, 236, 255, 0.12) 30%, rgba(60, 120, 255, 0.07) 54%, transparent 76%),
        radial-gradient(ellipse at 50% 82%, rgba(0, 255, 210, 0.11), transparent 64%);
    filter: blur(20px);
}

.m-hero-panel::after {
    content: '';
    position: absolute;
    left: 50%;
    top: 188px;
    width: min(360px, 92vw);
    height: 106px;
    transform: translateX(-50%);
    pointer-events: none;
    z-index: -2;
    background:
        linear-gradient(90deg, transparent 0%, rgba(115, 245, 255, 0.26) 18%, rgba(109, 94, 255, 0.16) 50%, rgba(115, 245, 255, 0.26) 82%, transparent 100%),
        radial-gradient(ellipse at 50% 0%, rgba(255,255,255,0.13), transparent 58%);
    border-radius: 999px;
    filter: blur(18px);
    opacity: 0.82;
}

.m-hero::before {
    content: '';
    position: absolute;
    left: 50%;
    top: 18px;
    transform: translateX(-50%);
    width: min(330px, 90vw);
    height: 268px;
    background:
        radial-gradient(circle at 50% 36%, rgba(0, 242, 255, 0.22) 0%, rgba(0, 242, 255, 0.08) 28%, rgba(112, 0, 255, 0.06) 54%, transparent 76%);
    filter: blur(22px);
    pointer-events: none;
    z-index: -2;
}

.m-hero::after {
    content: '';
    display: block;
    position: absolute;
    bottom: -2px;
    left: 50%;
    transform: translateX(-50%);
    width: 80%;
    height: 1px;
    background: linear-gradient(90deg, transparent, rgba(0, 242, 255, 0.55), rgba(112, 0, 255, 0.55), transparent);
    box-shadow: 0 0 10px rgba(0, 242, 255, 0.5);
    opacity: 0.85;
}

.logo-container {
    width: 184px;
    height: 184px;
    margin: 0 auto 16px;
    display: flex;
    align-items: center;
    justify-content: center;
    position: relative;
    border-radius: 50%;
    overflow: visible;
    animation: breathe 5.4s ease-in-out infinite;
    will-change: transform;
}

.logo-container::before {
    content: '';
    position: absolute;
    inset: 10px;
    border-radius: 50%;
    background: radial-gradient(circle at 50% 36%, rgba(8, 36, 48, 0.98) 0%, rgba(0, 10, 18, 0.985) 60%, rgba(0, 2, 8, 1) 100%);
    border: 3px solid rgba(0, 242, 255, 0.84);
    box-shadow:
        0 0 0 1px rgba(255,255,255,0.04),
        0 0 18px rgba(0, 242, 255, 0.24),
        0 0 34px rgba(0, 242, 255, 0.12),
        inset 0 0 18px rgba(112, 0, 255, 0.10);
    z-index: 0;
}

.logo-container::after {
    content: '';
    position: absolute;
    inset: -8px;
    border-radius: 50%;
    background: radial-gradient(circle, rgba(0, 242, 255, 0.12) 0%, rgba(0, 242, 255, 0.04) 38%, rgba(112, 0, 255, 0.03) 58%, transparent 78%);
    filter: blur(12px);
    z-index: -1;
    pointer-events: none;
}

.logo-container .m-abyss-crown {
    position: absolute;
    inset: -18px;
    border-radius: 50%;
    pointer-events: none;
    z-index: -2;
    background:
        conic-gradient(from 210deg, transparent 0 16%, rgba(0,242,255,0.18) 22%, transparent 30% 48%, rgba(124,58,237,0.18) 55%, transparent 64% 82%, rgba(45,212,191,0.16) 88%, transparent 100%);
    filter: blur(3px);
    opacity: 0.9;
}

.logo-container .m-abyss-crown::before,
.logo-container .m-abyss-crown::after {
    content: '';
    position: absolute;
    inset: 14px;
    border-radius: 50%;
    border: 1px solid rgba(141, 250, 255, 0.18);
    transform: rotate(-10deg) scaleX(1.22);
    box-shadow: 0 0 18px rgba(0,242,255,0.12);
}

.logo-container .m-abyss-crown::after {
    inset: 30px;
    border-color: rgba(124, 58, 237, 0.17);
    transform: rotate(16deg) scaleX(1.28);
}

@keyframes breathe {
    0%, 100% { transform: scale(1); }
    50% { transform: scale(1.018); }
}

.logo-image {
    width: 108%;
    height: auto;
    max-width: 152px;
    object-fit: contain;
    border-radius: 0;
    transform: translateY(5px) scale(1.03);

    filter: drop-shadow(0 10px 18px rgba(0, 0, 0, 0.42)) drop-shadow(0 0 10px rgba(0, 242, 255, 0.15)) brightness(1.05) saturate(1.05);
    animation: pulseGlow 3.1s ease-in-out infinite alternate;
    will-change: transform, opacity;
    z-index: 2;
    image-rendering: -webkit-optimize-contrast;
    opacity: 0;
    transition: opacity 0.22s ease-out;
}

.logo-image.is-loaded,
.logo-image:not([data-loading]) {
    opacity: 1;
}

@keyframes pulseGlow {
    0%   { transform: translateY(5px)  scale(1.03); }
    100% { transform: translateY(3px)  scale(1.055); }
}

.logo-particles {
    position: absolute;
    top: -20px;
    left: -20px;
    width: 212px;
    height: 212px;
    pointer-events: none;
    z-index: 1;
    overflow: visible;
}

.logo-particle {
    position: absolute;
    background: radial-gradient(circle, rgba(112, 0, 255, 0.82) 0%, rgba(0, 242, 255, 0.46) 44%, transparent 74%);
    border-radius: 50%;
    box-shadow: 0 0 8px rgba(0, 242, 255, 0.12);
    opacity: 0;
    animation: logoFloat 14s linear infinite;
}

@keyframes logoFloat {
    0% { transform: translateY(100%) scale(0.82); opacity: 0; }
    18% { opacity: 0.28; }
    84% { opacity: 0.14; }
    100% { transform: translateY(-100%) scale(1.10); opacity: 0; }
}

.m-brand-title {
    font-family: 'Rajdhani', sans-serif;
    font-size: 3.38rem; font-weight: 900; line-height: 0.88;
    display: inline-block;
    background: linear-gradient(180deg, #ffffff 0%, #9efcff 28%, #1fe6ff 58%, #6783ff 100%);
    -webkit-background-clip: text; -webkit-text-fill-color: transparent;
    margin: 4px 0 0 0; letter-spacing: 0.8px;
    filter: drop-shadow(0 0 14px rgba(0, 242, 255, 0.42)) drop-shadow(0 12px 24px rgba(0,0,0,0.32));
    position: relative; z-index: 10;
    animation: titleGlow 4.5s ease-in-out infinite alternate;
}

@keyframes titleGlow {
    from { opacity: 0.88; }
    to   { opacity: 1; }
}

.m-brand-title::after {
    content: '';
    display: block;
    width: 86%;
    height: 2px;
    margin: 9px auto 0;
    border-radius: 999px;
    background: linear-gradient(90deg, transparent, rgba(141,250,255,0.72), rgba(124,58,237,0.42), transparent);
    box-shadow: 0 0 16px rgba(0,242,255,0.26);
    opacity: 0.72;
}
.m-brand-sub {
    font-family: 'Rajdhani', sans-serif; font-size: 0.79rem; letter-spacing: 4.7px;
    color: var(--m-primary); text-transform: uppercase; margin-top: 8px;
    font-weight: 800; opacity: 0.95; display: flex; align-items: center; justify-content: center;
    width: 100%; text-shadow: 0 0 8px var(--m-primary); white-space: nowrap;
    position: relative; z-index: 10;
}
.m-brand-sub::before, .m-brand-sub::after {
    content: ''; display: block; width: 26px; height: 1px;
    background: linear-gradient(90deg, transparent, var(--m-primary));
    margin: 0 9px; flex-shrink: 0; box-shadow: 0 0 8px var(--m-primary);
}
.m-brand-sub::after { background: linear-gradient(90deg, var(--m-primary), transparent); }

.m-brand-desc {
    font-family: 'Outfit', sans-serif;
    font-size: 0.79rem;
    color: rgba(224,247,250,0.88);
    line-height: 1.45;
    margin-top: 13px;
    margin-bottom: 13px;
    max-width: 330px;
    opacity: 0.95;
    position: relative;
    z-index: 10;
}

.m-hero-badges {
    display: flex;
    flex-wrap: wrap;
    justify-content: center;
    gap: 8px;
    margin-top: 10px;
    margin-bottom: 8px;
    position: relative;
    z-index: 10;
}

.m-hero-badge {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    min-height: 30px;
    padding: 0 12px;
    border-radius: 999px;
    border: 1px solid rgba(125, 227, 255, 0.22);
    background:
        linear-gradient(180deg, rgba(11, 31, 48, 0.64), rgba(5, 15, 26, 0.34)),
        radial-gradient(circle at 50% 0%, rgba(145, 245, 255, 0.13), transparent 62%);
    box-shadow: inset 0 1px 0 rgba(255,255,255,0.05), 0 8px 18px rgba(0,0,0,0.18), 0 0 18px rgba(0,242,255,0.08);
    color: #dffcff;
    font-family: 'Rajdhani', sans-serif;
    font-weight: 800;
    font-size: 0.68rem;
    letter-spacing: 1.25px;
    text-transform: uppercase;
    backdrop-filter: blur(9px);
}

.m-version-tag {
    margin-top: 8px; font-family: 'Rajdhani', monospace; font-size: 0.60rem;
    color: #e0f7fa; opacity: 0.95; letter-spacing: 2px;
    background: rgba(0, 242, 255, 0.08); padding: 4px 11px; border-radius: 20px;
    border: 1px solid rgba(0, 242, 255, 0.28);
    display: inline-flex; align-items: center; gap: 8px;
    transition: all 0.3s ease; cursor: default;
    box-shadow: 0 0 14px rgba(0, 242, 255, 0.12), inset 0 0 8px rgba(0, 242, 255, 0.08);
    position: relative; z-index: 10; overflow: hidden;
    animation: badgePulse 4s ease-in-out infinite;
}
.m-version-tag::before {
    content: ''; position: absolute; top: 0; left: -100%; width: 60%; height: 100%;
    background: linear-gradient(90deg, transparent, rgba(0, 242, 255, 0.35), transparent);
    transform: skewX(-25deg); animation: shimmer 5s linear infinite;
}
@keyframes badgePulse {
    0%, 100% { box-shadow: 0 0 12px rgba(0, 242, 255, 0.12), inset 0 0 8px rgba(0, 242, 255, 0.06); border-color: rgba(0, 242, 255, 0.28); }
    50% { box-shadow: 0 0 22px rgba(0, 242, 255, 0.28), inset 0 0 10px rgba(0, 242, 255, 0.12); border-color: var(--m-primary); }
}
.m-v-dot { width: 6px; height: 6px; background: var(--m-success); border-radius: 50%; box-shadow: 0 0 6px var(--m-success), 0 0 12px rgba(0,255,157,0.5); animation: blinkBase 2s infinite; flex-shrink: 0; }
@keyframes blinkBase { 0%, 100% { opacity: 1; transform: scale(1); } 50% { opacity: 0.45; transform: scale(0.8); } }

.m-cred-deck {
    display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px;
    margin-bottom: 22px; perspective: 1000px;
}
.m-cred-opt {
    position: relative;
    background: linear-gradient(155deg, rgba(15,22,32,0.92), rgba(2,5,10,0.96));
    border: 1px solid rgba(255,255,255,0.08);
    border-radius: 14px;
    padding: 14px 5px 12px;
    text-align: center;
    cursor: pointer;
    transition: all 0.4s cubic-bezier(0.23, 1, 0.32, 1);
    display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 6px;
    overflow: hidden;
    box-shadow: 0 6px 18px rgba(0,0,0,0.55), inset 0 0 0 1px rgba(255,255,255,0.02);
    -webkit-tap-highlight-color: transparent;
}
.m-cred-opt::before {
    content: ''; position: absolute; top: 0; left: 0; width: 100%; height: 2px;
    background: linear-gradient(90deg, transparent, var(--opt-color), transparent);
    box-shadow: 0 0 12px var(--opt-color);
    opacity: 0.28; transition: 0.35s;
}
.m-cred-opt::after {
    content: ''; position: absolute; inset: 0; pointer-events: none;
    background: radial-gradient(ellipse at 50% 0%, var(--opt-glow), transparent 55%);
    opacity: 0; transition: opacity 0.4s ease;
}
.m-cred-icon {
    font-size: 1.5rem; margin-bottom: 2px;
    color: #4a5666;
    filter: drop-shadow(0 0 4px rgba(0,0,0,0.6));
    transition: 0.35s cubic-bezier(0.34, 1.56, 0.64, 1);
}
.m-cred-icon i { font-size: 1em; }
.m-cred-name {
    font-family: 'Rajdhani', sans-serif; font-weight: 800; font-size: 0.78rem;
    letter-spacing: 1.4px; color: #5d6c7e; transition: 0.3s;
}

.m-cred-opt.active {
    background: linear-gradient(155deg, rgba(20,28,40,0.95), rgba(0,0,0,0.98));
    border-color: var(--opt-color);
    transform: translateY(-3px);
    box-shadow: 0 0 24px var(--opt-glow), inset 0 0 14px rgba(0,0,0,0.6), inset 0 1px 0 rgba(255,255,255,0.05);
}
.m-cred-opt.active::before { opacity: 1; height: 3px; }
.m-cred-opt.active::after { opacity: 0.55; }
.m-cred-opt.active .m-cred-icon { transform: scale(1.18); color: var(--opt-color); filter: drop-shadow(0 0 10px var(--opt-color)); }
.m-cred-opt.active .m-cred-name { color: #fff; text-shadow: 0 0 10px var(--opt-color); letter-spacing: 1.6px; }
.m-cred-opt:active { transform: scale(0.97); }

.cred-rd { --opt-color: var(--m-primary); --opt-glow: rgba(0, 242, 255, 0.2); }
.cred-tb { --opt-color: var(--m-accent); --opt-glow: rgba(124, 58, 237, 0.2); }
.cred-p2p { --opt-color: var(--m-amber); --opt-glow: rgba(34, 211, 238, 0.2); }

.m-input-fuselage {
    position: relative; margin-bottom: 20px;
    background: rgba(0,0,0,0.5);
    border: 1px solid rgba(0, 242, 255, 0.12);
    border-radius: var(--m-radius-md);
    padding: 2px;
    transition: 0.3s;
}
.m-input-fuselage:focus-within {
    border-color: var(--m-primary);
    box-shadow: 0 0 18px rgba(0,242,255,0.22), inset 0 0 12px rgba(0,242,255,0.06);
}
.m-input-fuselage.is-p2p { opacity: 0.55; pointer-events: none; filter: grayscale(1); border-style: dashed; }
.m-input-fuselage.is-valid {
    border-color: rgba(0, 255, 157, 0.45);
    box-shadow: 0 0 18px rgba(0, 255, 157, 0.18), inset 0 0 12px rgba(0, 255, 157, 0.05);
}
.m-input-fuselage.is-invalid {
    border-color: rgba(255, 51, 102, 0.45);
    box-shadow: 0 0 18px rgba(255, 51, 102, 0.18), inset 0 0 12px rgba(255, 51, 102, 0.05);
}
.m-input-fuselage.is-checking {
    border-color: rgba(0, 242, 255, 0.4);
    box-shadow: 0 0 18px rgba(0, 242, 255, 0.18), inset 0 0 12px rgba(0, 242, 255, 0.05);
}

.m-if-inner {
    display: flex; align-items: center;
    background: #03070d;
    border-radius: 12px;
    padding: 0 10px;
    height: 52px;
    position: relative;
    overflow: hidden;
}
.m-if-inner::before {
    content: ''; position: absolute; left: 0; top: 0; bottom: 0; width: 2px;
    background: linear-gradient(180deg, transparent, var(--m-primary), transparent);
    opacity: 0; transition: opacity 0.3s;
}
.m-input-fuselage:focus-within .m-if-inner::before { opacity: 1; box-shadow: 0 0 8px var(--m-primary); }
.m-if-icon {
    font-size: 1rem; color: #4a5666; width: 30px; text-align: center;
    transition: 0.3s;
    border-right: 1px solid rgba(255,255,255,0.08);
    padding-right: 10px; margin-right: 10px;
    height: 60%; display: flex; align-items: center; justify-content: center;
}
.m-input-fuselage:focus-within .m-if-icon { color: var(--m-primary); border-right-color: var(--m-primary); filter: drop-shadow(0 0 6px var(--m-primary)); }

.m-if-field {
    flex: 1; background: transparent; border: none; color: #fff;
    font-family: 'Roboto Mono', monospace; font-size: 0.85rem; letter-spacing: 0.5px;
    width: 100%; height: 100%;
}
.m-if-field::placeholder { color: #444; font-family: 'Rajdhani'; letter-spacing: 1px; text-transform: uppercase; }

.m-if-action {
    color: var(--m-dim); cursor: pointer; padding: 8px; border-radius: 6px;
    transition: 0.2s; display: flex; align-items: center; justify-content: center;
}
.m-if-action:hover { color: #fff; background: rgba(255,255,255,0.1); }
.m-if-action:active { transform: scale(0.9); color: var(--m-primary); }

.m-if-label {
    position: absolute; top: -9px; right: 14px;
    background: linear-gradient(180deg, #03060b, #050a12); padding: 1px 9px;
    font-family: 'Rajdhani', sans-serif; font-size: 0.6rem; font-weight: 800;
    color: var(--m-dim); letter-spacing: 1.5px;
    border: 1px solid rgba(0, 242, 255, 0.18); border-radius: 4px;
    z-index: 2; text-transform: uppercase;
    transition: 0.3s;
}
.m-input-fuselage:focus-within .m-if-label {
    color: var(--m-primary); border-color: var(--m-primary);
    box-shadow: 0 0 12px rgba(0,242,255,0.3);
}
.m-if-label.opt { color: var(--m-accent); border-color: rgba(124, 58, 237,0.35); background: linear-gradient(180deg, #07020c, #0a0612); }

.m-get-link {
    font-family: 'Rajdhani'; font-size: 0.65rem; font-weight: 700;
    color: var(--m-primary); text-transform: uppercase; letter-spacing: 1px;
    margin-left: auto; cursor: pointer; padding: 4px 8px;
    border: 1px solid rgba(0,242,255,0.2); border-radius: 4px;
    background: rgba(0,242,255,0.05); transition: 0.3s;
    display: inline-flex; align-items: center; gap: 5px;
}
.m-get-link:hover { background: var(--m-primary); color: #000; box-shadow: 0 0 10px var(--m-primary); }

.m-key-status {
    display: flex; align-items: center; gap: 8px;
    padding: 9px 12px 11px;
    color: var(--m-dim);
    font-family: 'Rajdhani', sans-serif;
    font-size: 0.66rem;
    font-weight: 800;
    letter-spacing: 1.1px;
    text-transform: uppercase;
}
.m-key-status-dot {
    width: 9px; height: 9px; border-radius: 50%;
    background: rgba(122, 154, 181, 0.7);
    box-shadow: 0 0 0 1px rgba(255,255,255,0.04);
    flex: 0 0 auto;
}
.m-key-status.checking { color: var(--m-primary); }
.m-key-status.checking .m-key-status-dot {
    background: var(--m-primary);
    box-shadow: 0 0 10px rgba(0, 242, 255, 0.45);
    animation: mDebridPulse 1.1s ease-in-out infinite;
}
.m-key-status.valid { color: var(--m-success); }
.m-key-status.valid .m-key-status-dot {
    background: var(--m-success);
    box-shadow: 0 0 10px rgba(0, 255, 157, 0.45);
}
.m-key-status.invalid { color: var(--m-error); }
.m-key-status.invalid .m-key-status-dot {
    background: var(--m-error);
    box-shadow: 0 0 10px rgba(255, 51, 102, 0.45);
}
.m-key-status.warning { color: var(--m-amber); }
.m-key-status.warning .m-key-status-dot {
    background: var(--m-amber);
    box-shadow: 0 0 10px rgba(34, 211, 238, 0.4);
}
@keyframes mDebridPulse {
    0%, 100% { transform: scale(1); opacity: 1; }
    50% { transform: scale(1.35); opacity: 0.75; }
}

.m-hypervisor {
    background:
        linear-gradient(165deg, rgba(8, 14, 22, 0.92), rgba(2, 5, 10, 0.97));
    border: 1px solid rgba(0, 242, 255, 0.18);
    border-radius: var(--m-radius-lg); padding: 16px 15px 18px;
    box-shadow:
        0 14px 40px rgba(0,0,0,0.55),
        inset 0 0 24px rgba(0, 242, 255, 0.04),
        inset 0 1px 0 rgba(255,255,255,0.04);
    position: relative; overflow: hidden;
    backdrop-filter: blur(20px); margin-bottom: 18px;
    z-index: 2;
    isolation: isolate;
}

.m-hypervisor::before {
    content: ''; position: absolute; top: 0; left: 0; width: 100%; height: 2px;
    background: linear-gradient(90deg, transparent 0%, var(--m-primary) 25%, var(--m-secondary) 50%, var(--m-primary) 75%, transparent 100%);
    background-size: 200% 100%;
    box-shadow: 0 0 12px var(--m-primary);
    animation: borderFlow 6s linear infinite;
}

.m-hypervisor::after {
    content: ''; position: absolute; inset: 0; pointer-events: none; z-index: -1;
    background-image:
        linear-gradient(rgba(0, 242, 255, 0.04) 1px, transparent 1px),
        linear-gradient(90deg, rgba(0, 242, 255, 0.04) 1px, transparent 1px);
    background-size: 28px 28px;
    mask-image: radial-gradient(ellipse at 50% 0%, black 10%, transparent 80%);
    -webkit-mask-image: radial-gradient(ellipse at 50% 0%, black 10%, transparent 80%);
    opacity: 0.6;
}
@keyframes borderFlow { from { background-position: 200% 0; } to { background-position: -200% 0; } }

.m-hyp-header {
    font-family: 'Rajdhani', sans-serif; font-size: 0.85rem; color: #fff;
    font-weight: 800; letter-spacing: 3px;
    margin-bottom: 14px; display: flex; align-items: center; justify-content: space-between;
    border-bottom: 1px dashed rgba(0, 242, 255, 0.18);
    padding-bottom: 10px; text-transform: uppercase;
    text-shadow: 0 0 6px rgba(0, 242, 255, 0.25);
}
.m-hyp-icon {
    font-size: 1rem; color: var(--m-primary);
    filter: drop-shadow(0 0 8px var(--m-primary));
    background: rgba(0, 242, 255, 0.08); width: 28px; height: 28px;
    display: flex; align-items: center; justify-content: center;
    border-radius: 50%; border: 1px solid rgba(0, 242, 255, 0.25);
}

.m-flux-control {
    display: flex; flex-direction: column; gap: 10px; margin-bottom: 20px;
}
.m-flux-grid {
    display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 8px;
}
.m-flux-opt {
    background: rgba(255,255,255,0.03);
    border: 1px solid rgba(255,255,255,0.1); border-radius: 10px;
    padding: 12px 5px; text-align: center; cursor: pointer;
    transition: all 0.3s cubic-bezier(0.25, 0.8, 0.25, 1);
    display: flex; flex-direction: column; align-items: center; gap: 6px;
    position: relative; overflow: hidden;
}
.m-flux-opt i { font-size: 1.2rem; color: #666; transition: all 0.3s; }
.m-flux-opt span { font-family: 'Rajdhani', sans-serif; font-weight: 700; font-size: 0.75rem; color: #666; transition: all 0.3s; }

.m-flux-opt.active-bal {
    background: rgba(0, 242, 255, 0.05); border-color: var(--m-primary);
    box-shadow: 0 0 15px rgba(0, 242, 255, 0.1), inset 0 0 5px rgba(0, 242, 255, 0.05);
}
.m-flux-opt.active-bal i, .m-flux-opt.active-bal span { color: var(--m-primary); text-shadow: 0 0 8px rgba(0,242,255,0.4); }

.m-flux-opt.active-res {
    background: rgba(112, 0, 255, 0.05); border-color: var(--m-secondary);
    box-shadow: 0 0 15px rgba(112, 0, 255, 0.1), inset 0 0 5px rgba(112, 0, 255, 0.05);
}
.m-flux-opt.active-res i, .m-flux-opt.active-res span { color: var(--m-secondary); text-shadow: 0 0 8px rgba(112,0,255,0.4); }

.m-flux-opt.active-sz {
    background: rgba(14, 165, 233, 0.05); border-color: var(--m-amber);
    box-shadow: 0 0 15px rgba(14, 165, 233, 0.1), inset 0 0 5px rgba(14, 165, 233, 0.05);
}
.m-flux-opt.active-sz i, .m-flux-opt.active-sz span { color: var(--m-amber); text-shadow: 0 0 8px rgba(14, 165, 233,0.4); }

.m-flux-readout {
    background: rgba(0,0,0,0.4); border: 1px solid rgba(255,255,255,0.08);
    border-left: 2px solid #444; border-radius: 0 8px 8px 0;
    padding: 12px; display: flex; gap: 12px; align-items: flex-start;
    transition: all 0.3s; min-height: 60px;
}
.m-fr-icon { font-size: 1.4rem; color: #444; margin-top: 2px; transition: all 0.3s; }
.m-fr-text { display: flex; flex-direction: column; gap: 2px; }
.m-fr-title { font-family: 'Rajdhani'; font-weight: 800; font-size: 0.8rem; color: #fff; text-transform: uppercase; letter-spacing: 1px; }
.m-fr-desc { font-family: 'Outfit'; font-size: 0.7rem; color: #888; line-height: 1.3; }

.m-flux-readout.mode-bal { border-left-color: var(--m-primary); background: linear-gradient(90deg, rgba(0,242,255,0.05), transparent); }
.m-flux-readout.mode-bal .m-fr-icon { color: var(--m-primary); }
.m-flux-readout.mode-res { border-left-color: var(--m-secondary); background: linear-gradient(90deg, rgba(112,0,255,0.05), transparent); }
.m-flux-readout.mode-res .m-fr-icon { color: var(--m-secondary); }
.m-flux-readout.mode-sz { border-left-color: var(--m-amber); background: linear-gradient(90deg, rgba(14, 165, 233,0.05), transparent); }
.m-flux-readout.mode-sz .m-fr-icon { color: var(--m-amber); }

.m-lang-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px; margin-bottom: 15px; }
.m-lang-opt {
    background: rgba(20, 20, 25, 0.6);
    border: 1px solid rgba(255,255,255,0.1); border-radius: 12px;
    padding: 15px 5px; text-align: center; cursor: pointer;
    transition: all 0.3s cubic-bezier(0.25, 0.8, 0.25, 1);
    position: relative; overflow: hidden;
    display: flex; flex-direction: column; align-items: center; gap: 5px;
}
.m-lang-opt i { font-size: 1.2rem; color: #555; transition: all 0.3s; margin-bottom: 2px; }
.m-lang-txt { font-family: 'Rajdhani', sans-serif; font-weight: 800; font-size: 0.8rem; color: #777; transition: color 0.3s; }

.m-lang-opt.active-ita {
    background: rgba(0, 242, 255, 0.08); border-color: var(--m-primary);
    box-shadow: 0 0 15px rgba(0, 242, 255, 0.15);
}
.m-lang-opt.active-ita i, .m-lang-opt.active-ita .m-lang-txt { color: var(--m-primary); filter: drop-shadow(0 0 5px rgba(0,242,255,0.5)); }

.m-lang-opt.active-hyb {
    background: rgba(112, 0, 255, 0.08); border-color: var(--m-secondary);
    box-shadow: 0 0 15px rgba(112, 0, 255, 0.15);
}
.m-lang-opt.active-hyb i, .m-lang-opt.active-hyb .m-lang-txt { color: var(--m-secondary); filter: drop-shadow(0 0 5px rgba(112,0,255,0.5)); }

.m-lang-opt.active-eng {
    background: rgba(56, 189, 248, 0.08); border-color: var(--m-cine);
    box-shadow: 0 0 15px rgba(56, 189, 248, 0.15);
}
.m-lang-opt.active-eng i, .m-lang-opt.active-eng .m-lang-txt { color: var(--m-cine); filter: drop-shadow(0 0 5px rgba(56, 189, 248,0.5)); }

.m-hyp-label { font-size: 0.65rem; color: var(--m-dim); text-transform: uppercase; letter-spacing: 1px; margin-bottom: 8px; font-family: 'Rajdhani'; font-weight: 700; }
.m-hyp-desc { font-size: 0.65rem; color: #666; margin-bottom: 12px; margin-top: -5px; line-height: 1.3; font-family: 'Outfit'; }

.m-chip-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 6px; margin-bottom: 20px; }
.m-qual-chip { font-family: 'Rajdhani'; font-weight: 800; font-size: 0.75rem; text-align: center; padding: 8px 2px; background: rgba(255,255,255,0.03); border-radius: 10px; border: 1px solid rgba(255,255,255,0.1); color: #fff; transition: all 0.2s; cursor: pointer; display: flex; flex-direction: column; align-items: center; justify-content: center; }
.m-qual-chip.excluded { opacity: 0.4; background: rgba(255, 51, 102, 0.1); border-color: rgba(255, 51, 102, 0.3); color: var(--m-error); text-decoration: line-through; }
.m-qual-chip:not(.excluded):active { transform: scale(0.95); }
.mini-tag { font-size: 0.55rem; opacity: 0.7; margin-top: -2px; font-weight: 700; letter-spacing: 1px; color: var(--m-primary); }
.m-qual-chip.excluded .mini-tag { color: var(--m-error); }

.m-sys-grid { display: grid; grid-template-columns: 1fr; gap: 0; background: rgba(0,0,0,0.2); border-radius: 16px; border: 1px solid rgba(255,255,255,0.05); overflow: hidden; margin-bottom: 20px; }
.m-sys-row { display: flex; align-items: center; justify-content: space-between; padding: 12px 15px; border-bottom: 1px solid rgba(255,255,255,0.05); }
.m-sys-row:last-child { border-bottom: none; }
.m-cloud-mode-panel {
    display: none;
    padding: 10px 12px 14px;
    border-bottom: 1px solid rgba(255,255,255,0.05);
    background: linear-gradient(135deg, rgba(0,242,255,0.045), rgba(112,0,255,0.035), rgba(0,0,0,0.08));
}
.m-cloud-mode-panel.show { display: block; animation: fadeFast 0.22s ease-out; }
.m-cloud-mode-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 7px; }
.m-cloud-mode-btn {
    min-height: 48px;
    border: 1px solid rgba(255,255,255,0.10);
    border-radius: 12px;
    background: rgba(0,0,0,0.24);
    color: var(--m-dim);
    font-family: 'Rajdhani', sans-serif;
    font-weight: 900;
    letter-spacing: 0.7px;
    font-size: 0.70rem;
    text-align: center;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 2px;
    transition: all 0.18s ease;
}
.m-cloud-mode-btn span { display: block; font-family: 'Outfit', sans-serif; font-size: 0.54rem; font-weight: 700; letter-spacing: 0; opacity: 0.72; }
.m-cloud-mode-btn.active {
    color: #fff;
    border-color: rgba(0,242,255,0.55);
    background: linear-gradient(135deg, rgba(0,242,255,0.16), rgba(112,0,255,0.12));
    box-shadow: 0 0 14px rgba(0,242,255,0.16), inset 0 0 16px rgba(0,242,255,0.06);
}
.m-cloud-mode-btn:active { transform: scale(0.96); }
.m-cloud-note { margin: 8px 1px 0; color: rgba(224,247,250,0.50); font-family:'Outfit', sans-serif; font-size:0.63rem; line-height:1.3; }
.m-sys-info h4 { margin: 0; font-size: 0.85rem; color: #fff; font-family: 'Rajdhani'; font-weight: 700; display: flex; align-items: center; gap: 5px; }
.m-sys-info p { margin: 2px 0 0; font-size: 0.65rem; color: rgba(255,255,255,0.5); }

.m-reactor-grid {
    display: flex; flex-direction: column; gap: 10px; margin-bottom: 25px;
}

.m-reactor-module {

    background: linear-gradient(180deg, rgba(8, 12, 18, 0.96), rgba(3, 6, 11, 0.97));
    border: 1px solid rgba(255,255,255,0.06);
    border-radius: var(--m-radius-md);
    position: relative;
    overflow: hidden;

    transition: border-color 0.3s ease;
    display: flex;
    align-items: stretch;
    min-height: 78px;
    box-shadow: 0 6px 16px rgba(0,0,0,0.55), inset 0 1px 0 rgba(255,255,255,0.03);
}
.m-reactor-module:active { transform: scale(0.99); }

.m-reactor-core {
    width: 45px;
    flex-shrink: 0;
    background: #0f1219;
    border-right: 1px solid rgba(255,255,255,0.05);
    display: flex;
    align-items: center;
    justify-content: center;
    position: relative;
    z-index: 2;
    transition: background 0.3s ease;
}

.m-core-icon {
    font-size: 1.1rem;

    transition: transform 0.3s cubic-bezier(0.34, 1.56, 0.64, 1);
    filter: drop-shadow(0 0 5px rgba(0,0,0,0.5));
    z-index: 3;
    position: relative;
}

.m-reactor-body {
    flex: 1;
    padding: 8px 12px;
    display: flex;
    flex-direction: column;
    justify-content: center;
    position: relative;
    z-index: 2;
    background: linear-gradient(90deg, rgba(255,255,255,0.01), transparent);
}

.m-reactor-top {
    display: flex; justify-content: space-between; align-items: center; margin-bottom: 2px;
}
.m-reactor-title {
    font-family: 'Rajdhani', sans-serif; font-weight: 800; color: #fff; font-size: 0.95rem;
    letter-spacing: 0.5px; text-shadow: 0 2px 5px rgba(0,0,0,0.5);
}
.m-reactor-desc {
    font-family: 'Outfit', sans-serif; font-size: 0.6rem;
    color: #666;
    line-height: 1.3; margin-bottom: 4px; display: block;
}

.m-tag-row { display: flex; gap: 6px; align-items: center; }
.m-tech-tag {
    font-family: 'Rajdhani', monospace; font-size: 0.5rem; font-weight: 700;
    padding: 2px 5px; border-radius: 4px; border: 1px solid;
    text-transform: uppercase; letter-spacing: 1px; line-height: 1;
}
.tag-noproxy { border-color: #444; color: #777; background: rgba(255,255,255,0.02); }
.tag-mfp { border-color: rgba(0, 242, 255, 0.3); color: var(--m-primary); background: rgba(0, 242, 255, 0.05); }
.tag-kraken { border-color: rgba(34, 211, 238, 0.58); color: #b9f7ff; background: rgba(34, 211, 238, 0.10); box-shadow: 0 0 12px rgba(34, 211, 238, 0.12); }

.m-reactor-module::after {
    content: ''; position: absolute; top: 0; left: 0; width: 100%; height: 100%;
    background: radial-gradient(circle at 0% 50%, var(--glow-color), transparent 70%);
    opacity: 0; transition: opacity 0.5s ease;
    z-index: 0; pointer-events: none;
}
.m-reactor-module.active::after { opacity: 0.25; }

.m-reactor-module.active {
    border-color: var(--border-color);
    box-shadow: 0 0 20px rgba(0,0,0,0.5), inset 0 0 0 1px var(--border-color-dim);
}

.m-reactor-module.active .m-reactor-core {
    background: var(--core-bg);
    border-right-color: var(--border-color);
    box-shadow: 10px 0 30px -5px var(--glow-color);
}

.m-reactor-module.active .m-core-icon {
    transform: scale(1.15);

    filter: drop-shadow(0 0 8px var(--border-color));
}

#mod-vix { --glow-color: rgba(112, 0, 255, 0.8); --border-color: #7000ff; --border-color-dim: rgba(112,0,255,0.3); --core-bg: rgba(112,0,255,0.2); }
#mod-vix .m-core-icon { color: var(--m-secondary); }

#mod-ghd { --glow-color: rgba(0, 242, 255, 0.8); --border-color: #00f2ff; --border-color-dim: rgba(0,242,255,0.3); --core-bg: rgba(0,242,255,0.2); }
#mod-ghd .m-core-icon { color: var(--m-primary); }

#mod-gs { --glow-color: rgba(124, 58, 237, 0.8); --border-color: #7c3aed; --border-color-dim: rgba(124, 58, 237,0.3); --core-bg: rgba(124, 58, 237,0.2); }
#mod-gs .m-core-icon { color: var(--m-accent); }

#mod-aw { --glow-color: rgba(14, 165, 233, 0.8); --border-color: #0ea5e9; --border-color-dim: rgba(14, 165, 233,0.3); --core-bg: rgba(14, 165, 233,0.2); }
#mod-aw .m-core-icon { color: var(--m-orange); }

#mod-as { --glow-color: rgba(34, 211, 238, 0.8); --border-color: #22d3ee; --border-color-dim: rgba(34, 211, 238,0.3); --core-bg: rgba(34, 211, 238,0.2); }
#mod-as .m-core-icon { color: var(--m-amber); }

#mod-gf { --glow-color: rgba(0, 230, 118, 0.8); --border-color: #00e676; --border-color-dim: rgba(0,230,118,0.3); --core-bg: rgba(0,230,118,0.2); }
#mod-gf .m-core-icon { color: #00e676; }

#mod-cc { --glow-color: rgba(56, 189, 248, 0.8); --border-color: #38bdf8; --border-color-dim: rgba(56, 189, 248,0.3); --core-bg: rgba(56, 189, 248,0.2); }
#mod-cc .m-core-icon { color: #38bdf8; }

#mod-es { --glow-color: rgba(45, 212, 191, 0.8); --border-color: #2dd4bf; --border-color-dim: rgba(45, 212, 191,0.3); --core-bg: rgba(45, 212, 191,0.2); }
#mod-es .m-core-icon { color: #2dd4bf; }

.m-reactor-top .m-switch { transform: scale(0.85); transform-origin: right center; }

.m-sc-subpanel {
    display: none;
    background: transparent;
    border: none;
    margin: 8px 0 0 0;
    padding: 0;
    width: 100%;
}
.m-mini-tabs { gap: 6px; }
.m-mini-tab {
    padding: 6px 4px;
    background: rgba(255,255,255,0.03); border: 1px solid rgba(255,255,255,0.1);
    color: #888; letter-spacing: 0.5px;
    font-size: 0.7rem; font-weight: 800;
}
.m-mini-tab.active {
    background: var(--m-secondary); border-color: var(--m-secondary);
    color: #fff; box-shadow: 0 0 10px rgba(112,0,255,0.4);
}

.m-visual-core-v2 {
    margin: 6px 0 22px; position: relative;
    background:
        linear-gradient(180deg, rgba(0, 3, 8, 0.44), rgba(0, 0, 0, 0.20)),
        radial-gradient(ellipse at 50% -18%, rgba(0, 242, 255, 0.13), transparent 54%),
        linear-gradient(165deg, rgba(8, 14, 22, 0.96), rgba(2, 5, 10, 0.985));
    border: 1px solid rgba(0, 242, 255, 0.24);
    border-radius: var(--m-radius-lg); padding: 15px 13px 17px;
    box-shadow:
        0 18px 50px rgba(0,0,0,0.74),
        0 -10px 38px rgba(0,0,0,0.38),
        inset 0 0 26px rgba(0, 242, 255, 0.055),
        inset 0 1px 0 rgba(255,255,255,0.045);
    overflow: hidden;
    min-width: 0;
}
.m-visual-core-v2::before {
    content: ''; position: absolute; top: 0; left: 0; width: 100%; height: 2px;
    background: linear-gradient(90deg, transparent 0%, var(--m-primary) 25%, var(--m-secondary) 50%, var(--m-primary) 75%, transparent 100%);
    background-size: 200% 100%;
    box-shadow: 0 0 12px var(--m-primary);
    animation: borderFlow 6s linear infinite;
}
.m-visual-preview {
    background: linear-gradient(180deg, rgba(5, 12, 20, 0.98), rgba(1, 4, 9, 0.99));
    border: 1px solid rgba(0,242,255,0.28);
    border-radius: var(--m-radius-md);
    padding: 12px; margin-bottom: 15px;
    display: flex; gap: 12px; align-items: flex-start;
    box-shadow: 0 0 32px rgba(0,0,0,0.78), inset 0 0 20px rgba(0, 242, 255, 0.055);
    position: relative; overflow: hidden;
    min-height: 84px; transition: border-color 0.2s;
}
.m-visual-preview::before {
    content: ''; position: absolute; top: 0; left: 0; width: 3px; height: 100%;
    background: linear-gradient(180deg, var(--m-primary), var(--m-secondary));
    box-shadow: 0 0 12px var(--m-primary);
}
.m-visual-preview.glitching { animation: glitch-anim 0.3s cubic-bezier(.25, .46, .45, .94) both; border-color: var(--m-accent); }
.m-visual-preview.glitching .m-vp-icon { background: var(--m-accent); color: #000; }
@keyframes glitch-anim { 0% { transform: translate(0); filter: hue-rotate(0deg); } 20% { transform: translate(-2px, 2px); filter: hue-rotate(90deg); } 40% { transform: translate(2px, -2px); filter: hue-rotate(-90deg); } 60% { transform: translate(-2px, 2px); } 80% { transform: translate(2px, -2px); } 100% { transform: translate(0); filter: hue-rotate(0deg); } }
.m-vp-icon { width: 44px; height: 66px; border-radius: 4px; background: linear-gradient(135deg, #1f2a36, #000); border: 1px solid #333; display: flex; align-items: center; justify-content: center; font-size: 1.1rem; color: #555; flex-shrink: 0; box-shadow: 0 4px 10px rgba(0,0,0,0.5); transition: background 0.2s; }
.m-vp-text { flex: 1; min-width: 0; display: flex; flex-direction: column; justify-content: center; padding-top: 2px; }
.m-vp-title { font-family: 'Rajdhani'; color: #fff; font-size: 0.95rem; margin-bottom: 4px; line-height: 1.2; word-wrap: break-word; font-weight: 800; }
.m-vp-sub { font-family: 'Outfit'; color: #888; font-size: 0.7rem; line-height: 1.4; white-space: pre-wrap; overflow: visible; display: block; }

.m-cortex-grid {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 7px;
    margin-bottom: 20px;
    padding: 0;
    align-items: stretch;
}
.m-cortex-chip {
    background: linear-gradient(180deg, rgba(15, 22, 32, 0.92), rgba(2, 6, 12, 0.96));
    border: 1px solid rgba(0, 242, 255, 0.18);
    border-radius: 12px;
    padding: 8px 3px 7px;
    display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 3px;
    cursor: pointer; position: relative; overflow: hidden;
    transition: transform 0.18s ease, border-color 0.18s ease, box-shadow 0.18s ease, background 0.18s ease;
    clip-path: polygon(0 0, 100% 0, 100% calc(100% - 8px), calc(100% - 8px) 100%, 0 100%);
    box-shadow: 0 4px 12px rgba(0,0,0,0.5), inset 0 1px 0 rgba(255,255,255,0.03);
    min-height: 74px;
    min-width: 0;
}
.m-cortex-chip:active { transform: scale(0.96); }
.m-cortex-chip.active {
    background: linear-gradient(180deg, rgba(0, 242, 255, 0.16), rgba(0, 60, 90, 0.18));
    border-color: var(--m-primary);
    box-shadow: 0 0 18px rgba(0, 242, 255, 0.30), inset 0 0 12px rgba(0, 242, 255, 0.08);
}
.m-cortex-chip.active::after {
    content: ""; position: absolute; bottom: 0; right: 0;
    width: 8px; height: 8px;
    background: var(--m-primary);
    box-shadow: 0 0 10px var(--m-primary), 0 0 18px var(--m-primary);
}
.m-chip-icon {
    font-size: clamp(1rem, 4.5vw, 1.24rem); filter: none; opacity: 1;
    transition: 0.25s cubic-bezier(0.34, 1.56, 0.64, 1);
    text-shadow: 0 0 6px rgba(255,255,255,0.3);
    line-height: 1;
}
.m-chip-icon i { font-size: 1em; }

.m-chip-icon {
    font-family: "Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji", "Rajdhani", sans-serif;
    font-size: clamp(1.38rem, 6vw, 1.85rem);
    filter: drop-shadow(0 0 10px rgba(255,255,255,0.22));
}
.m-vp-icon {
    font-family: "Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji", sans-serif;
    font-size: 1.45rem;
    color: #fff;
}

.m-cortex-chip.active .m-chip-icon { transform: scale(1.12); text-shadow: 0 0 12px var(--m-primary); }
.m-chip-label {
    font-family: "Rajdhani", monospace;
    font-size: clamp(0.54rem, 2.3vw, 0.66rem);
    font-weight: 800;
    color: #fff; text-transform: uppercase; letter-spacing: 0.72px;
    text-shadow: 0 0 4px rgba(0, 242, 255, 0.4); text-align: center;
    line-height: 1.05;
    width: 100%;
    max-width: 100%;
    overflow-wrap: anywhere;
    hyphens: auto;
}
.m-chip-sub {
    font-family: "Outfit", sans-serif;
    font-size: clamp(0.46rem, 1.9vw, 0.5rem);
    color: var(--m-dim); letter-spacing: 0.78px; text-transform: uppercase;
    text-align: center; line-height: 1.1;
    width: 100%;
    max-width: 100%;
    overflow-wrap: anywhere;
}
#msk_custom { grid-column: 1 / -1 !important; min-height: 58px; }
#msk_custom .m-chip-icon { font-size: 1.05rem; }
@media (max-width: 380px) {
    .m-visual-core-v2 { padding-left: 10px; padding-right: 10px; }
    .m-cortex-grid { gap: 6px; }
    .m-cortex-chip { min-height: 68px; padding: 7px 2px 6px; }
    .m-chip-label { letter-spacing: 0.55px; }
    .m-chip-sub { letter-spacing: 0.6px; }
}
@media (max-width: 330px) {
    .m-cortex-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
}
.m-vp-mode { font-family: 'Rajdhani', sans-serif; font-size: 0.58rem; letter-spacing: 1.4px; color: var(--m-primary); margin-bottom: 4px; text-transform: uppercase; font-weight: 800; }

.m-field-group { margin-bottom: 18px; }
.m-field-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 6px; padding: 0 2px; }
.m-field-label { font-family: 'Rajdhani'; font-weight: 700; font-size: 0.7rem; color: var(--m-dim); letter-spacing: 1px; }
.m-field-link { font-family: 'Rajdhani'; font-weight: 700; font-size: 0.65rem; color: var(--m-primary); cursor: pointer; transition: 0.2s; display: flex; align-items: center; gap: 5px; }
.m-input-box { position: relative; width: 100%; }
.m-input-ico { position: absolute; left: 14px; top: 50%; transform: translateY(-50%); color: #555; font-size: 0.9rem; transition: 0.3s; z-index: 2; pointer-events: none; }
.m-input-tech { width: 100%; background: #05080b; border: 1px solid rgba(255,255,255,0.12); border-radius: 10px; padding: 12px 40px 12px 38px; color: #fff; font-family: 'Roboto Mono', monospace; font-size: 16px; transition: all 0.3s; }
.m-input-tech:focus { border-color: var(--m-primary); background: #080c12; box-shadow: 0 0 15px rgba(0,242,255,0.1); }
.m-input-tech:focus ~ .m-input-ico { color: var(--m-primary); }
.m-paste-action { position: absolute; right: 6px; top: 50%; transform: translateY(-50%); width: 30px; height: 30px; border-radius: 6px; background: rgba(255,255,255,0.05); border: 1px solid rgba(255,255,255,0.1); color: var(--m-dim); display: flex; align-items: center; justify-content: center; cursor: pointer; transition: all 0.2s; font-size: 0.8rem; }
.m-paste-action:hover { background: rgba(0,242,255,0.15); color: var(--m-primary); border-color: var(--m-primary); }

.m-ghost-panel { background: #05080b; border: 1px solid rgba(170,0,255,0.2); border-radius: 16px; padding: 15px; margin-top: 10px; position: relative; overflow: hidden; transition: all 0.3s; }
.m-ghost-panel.active { border-color: var(--m-secondary); box-shadow: 0 0 20px rgba(170,0,255,0.1); background: radial-gradient(circle at top right, rgba(170,0,255,0.08), transparent); }
.m-ghost-head { display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px; }
.m-ghost-title { font-family: 'Rajdhani'; font-weight: 800; font-size: 1rem; color: #fff; display: flex; align-items: center; gap: 8px; }
.m-ghost-status { font-family: 'Rajdhani'; font-weight: 700; font-size: 0.65rem; padding: 3px 6px; border-radius: 4px; background: rgba(255,255,255,0.1); color: #666; transition: all 0.3s; }
.m-ghost-panel.active .m-ghost-status { background: var(--m-secondary); color: #000; box-shadow: 0 0 10px var(--m-secondary); }

.m-p2p-module { background: rgba(34, 211, 238, 0.05); border: 1px solid rgba(34, 211, 238, 0.3); border-radius: 16px; padding: 15px; margin-top: 15px; position: relative; overflow: hidden; transition: all 0.3s; }
.m-p2p-module.active { border-color: var(--m-amber); box-shadow: 0 0 20px rgba(34, 211, 238, 0.2); background: radial-gradient(circle at top right, rgba(34, 211, 238, 0.08), transparent); }
.m-p2p-head { display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px; }
.m-p2p-title { font-family: 'Rajdhani'; font-weight: 800; font-size: 1rem; color: var(--m-amber); display: flex; align-items: center; gap: 8px; text-shadow: 0 0 5px rgba(34, 211, 238,0.3); }
.m-p2p-status { font-family: 'Rajdhani'; font-weight: 700; font-size: 0.65rem; padding: 3px 6px; border-radius: 4px; background: rgba(34, 211, 238,0.1); color: var(--m-amber); transition: all 0.3s; border: 1px solid rgba(34, 211, 238,0.2); }
.m-p2p-module.active .m-p2p-status { background: var(--m-amber); color: #000; box-shadow: 0 0 10px var(--m-amber); }

@keyframes pulseWarn { 0%, 100% { opacity: 1; } 50% { opacity: 0.6; } }

.m-status-text { font-size: 0.65rem; padding: 3px 6px; border-radius: 5px; background: rgba(255,255,255,0.12); color: #888; white-space: nowrap; transition: all 0.2s; }
.m-status-text.on { background: rgba(0, 255, 157, 0.2); color: var(--m-success); border: 1px solid rgba(0, 255, 157, 0.35); box-shadow: 0 0 6px rgba(0,255,157,0.25); }

.m-switch { position: relative; width: 44px; height: 24px; flex-shrink: 0; }
.m-switch input { opacity: 0; width: 0; height: 0; }
.m-slider { position: absolute; top: 0; left: 0; right: 0; bottom: 0; background-color: #1c1c1c; border-radius: 34px; transition: .35s; border: 1px solid #555; box-shadow: inset 0 0 5px rgba(0,0,0,0.5); }
.m-slider:before { position: absolute; content: ""; height: 16px; width: 16px; left: 3px; bottom: 3px; background-color: #999; border-radius: 50%; transition: .35s; box-shadow: 0 0 4px rgba(0,0,0,0.3); }
input:checked + .m-slider { background-color: rgba(0,242,255,0.3); border-color: var(--m-primary); box-shadow: inset 0 0 10px rgba(0,242,255,0.4); }
input:checked + .m-slider:before { transform: translateX(20px); background-color: var(--m-primary); box-shadow: 0 0 10px var(--m-primary); }

.m-slider-purple { background-color: #1c1c1c; }
input:checked + .m-slider-purple { background-color: rgba(124, 58, 237, 0.3); border-color: var(--m-accent); box-shadow: inset 0 0 10px rgba(124, 58, 237,0.4); }
input:checked + .m-slider-purple:before { background-color: var(--m-accent); box-shadow: 0 0 10px var(--m-accent); }

.m-slider-aqua { background-color: #1c1c1c; }
input:checked + .m-slider-aqua { background-color: rgba(34, 211, 238, 0.3); border-color: var(--m-amber); box-shadow: inset 0 0 10px rgba(34, 211, 238,0.4); }
input:checked + .m-slider-aqua:before { background-color: var(--m-amber); box-shadow: 0 0 10px var(--m-amber); }

.m-slider-cyan { background-color: #1c1c1c; }
input:checked + .m-slider-cyan { background-color: rgba(56, 189, 248, 0.3); border-color: var(--m-cine); box-shadow: inset 0 0 10px rgba(56, 189, 248,0.4); }
input:checked + .m-slider-cyan:before { background-color: var(--m-cine); box-shadow: 0 0 10px var(--m-cine); }

.m-slider-green { background-color: #1c1c1c; }
input:checked + .m-slider-green { background-color: rgba(0, 230, 118, 0.3); border-color: #00e676; box-shadow: inset 0 0 10px rgba(0,230,118,0.4); }
input:checked + .m-slider-green:before { background-color: #00e676; box-shadow: 0 0 10px #00e676; }

.m-priority-wrapper { max-height: 0; opacity: 0; overflow: hidden; transition: max-height 0.3s ease, opacity 0.3s ease; margin: 0 -10px; }
.m-priority-wrapper.show { max-height: 130px; opacity: 1; margin-top: 15px; padding: 0 10px; }

.m-gate-wrapper { width: 100%; overflow: hidden; max-height: 0; opacity: 0; transition: max-height 0.3s ease, opacity 0.3s ease; }
.m-gate-wrapper.show { max-height: 100px; opacity: 1; margin-top: 5px; margin-bottom: 10px; }
.m-gate-control { display: flex; align-items: center; gap: 12px; background: rgba(0,0,0,0.3); padding: 10px; border-radius: 10px; border: 1px solid rgba(255,255,255,0.05); }
.m-range { -webkit-appearance: none; width: 100%; height: 4px; background: #333; border-radius: 3px; outline: none; }
.m-range::-webkit-slider-thumb { -webkit-appearance: none; width: 16px; height: 16px; border-radius: 50%; background: var(--m-primary); box-shadow: 0 0 10px var(--m-primary); cursor: pointer; border: 2px solid #fff; }
#m-sizeVal::-webkit-slider-thumb { background: var(--m-amber); box-shadow: 0 0 10px var(--m-amber); }
.m-range-desc { font-size: 0.7rem; color: var(--m-dim); margin: 8px 0 0 5px; line-height: 1.4; border-left: 2px solid var(--m-dim); padding-left: 8px; }

.m-row { display: flex; align-items: center; justify-content: space-between; width: 100%; }
.m-label { flex: 1; padding-right: 15px; }
.m-label h4 { margin: 0; display: flex; align-items: center; gap: 8px; font-size: 0.9rem; color: #fff; font-family: 'Rajdhani'; font-weight: 700; }

.m-action-modal {
    position: fixed; top: 0; left: 0; width: 100%; height: 100%;
    background: radial-gradient(circle at 50% 30%, rgba(0, 12, 22, 0.95), rgba(0, 2, 5, 0.98));
    z-index: 200; display: none; flex-direction: column; justify-content: center; align-items: center;
    backdrop-filter: blur(14px); padding: 20px;
    animation: fadeInModal 0.25s ease-out;
}
@keyframes fadeInModal { from { opacity: 0; } to { opacity: 1; } }
.m-action-modal.show { display: flex; }
.m-am-card {
    width: 100%; max-width: 400px;
    background: linear-gradient(160deg, rgba(8, 14, 22, 0.96), rgba(0, 0, 0, 0.98));
    border: 1px solid var(--m-primary); border-radius: var(--m-radius-lg);
    padding: 24px 22px;
    box-shadow:
        0 0 40px rgba(0, 242, 255, 0.22),
        inset 0 0 24px rgba(0, 242, 255, 0.05),
        inset 0 1px 0 rgba(255,255,255,0.05);
    display: flex; flex-direction: column; gap: 18px;
    animation: cardEnter 0.3s cubic-bezier(0.34, 1.56, 0.64, 1);
    position: relative; overflow: hidden;
}
.m-am-card::before {
    content: ''; position: absolute; top: 0; left: 0; right: 0; height: 2px;
    background: linear-gradient(90deg, transparent, var(--m-primary), var(--m-secondary), var(--m-primary), transparent);
    background-size: 200% 100%;
    animation: borderFlow 4s linear infinite;
}
@keyframes cardEnter { from { opacity: 0; transform: translateY(20px) scale(0.96); } to { opacity: 1; transform: translateY(0) scale(1); } }
.m-am-title {
    text-align: center; font-family: 'Rajdhani', sans-serif; font-weight: 900;
    color: #fff; font-size: 1.25rem; letter-spacing: 4px;
    margin: 0;
    text-shadow: 0 0 14px rgba(0, 242, 255, 0.4);
}
.m-am-subtitle {
    text-align: center; color: var(--m-dim); font-size: 0.72rem;
    margin-top: -12px; letter-spacing: 2px; text-transform: uppercase;
}

.m-act-btn {
    padding: 14px; border-radius: var(--m-radius-sm);
    font-family: 'Rajdhani', sans-serif; font-weight: 800; font-size: 0.95rem;
    letter-spacing: 1.5px; text-transform: uppercase;
    cursor: pointer; text-align: center; transition: all 0.2s;
    border: 1px solid transparent; display: flex; align-items: center; justify-content: center; gap: 10px;
}
.m-act-copy {
    background: linear-gradient(90deg, #00f2ff, #00b4ff);
    color: #001018;
    box-shadow: 0 0 22px rgba(0, 242, 255, 0.4), inset 0 1px 0 rgba(255,255,255,0.4);
    text-shadow: 0 1px 0 rgba(255,255,255,0.3);
}
.m-act-copy:active { transform: scale(0.97); box-shadow: 0 0 30px rgba(0, 242, 255, 0.6); }
.m-act-close {
    background: rgba(255,255,255,0.05);
    color: var(--m-dim); margin-top: 0;
    border: 1px solid rgba(255,255,255,0.1);
}
.m-act-close:active { background: rgba(255,255,255,0.1); }

.m-flux-terminal { background: #000; border: 1px solid rgba(0, 242, 255, 0.2); border-left: 3px solid var(--m-primary); border-radius: 12px; overflow: hidden; font-family: 'Consolas', monospace; box-shadow: inset 0 0 20px rgba(0,0,0,0.8); width: 100%; }
.m-flux-header { background: rgba(0, 242, 255, 0.05); padding: 8px 15px; font-size: 0.7rem; color: var(--m-primary); letter-spacing: 1px; font-weight: 700; display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid rgba(0, 242, 255, 0.1); }
.m-flux-input { width: 100%; background: transparent; border: none; color: #fff; padding: 15px; font-size: 0.75rem; resize: none; min-height: 80px; line-height: 1.4; outline: none; font-family: 'Consolas', monospace; white-space: pre-wrap; word-break: break-all; }

.m-credits-section {
    margin: 20px 10px 10px 10px;
    padding: 0;
    background: transparent;
    border: none;
    display: flex;
    flex-direction: column;
    gap: 10px;
}

.m-neural-frame {
    background: rgba(5, 8, 12, 0.8);
    border: 1px solid rgba(255, 255, 255, 0.08);
    border-radius: 16px;
    padding: 15px;
    position: relative;
    overflow: hidden;
    backdrop-filter: blur(10px);
    box-shadow: 0 10px 30px rgba(0,0,0,0.5);
    z-index: 5;
}

.m-neural-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 12px;
    padding-bottom: 8px;
    border-bottom: 1px solid rgba(255,255,255,0.05);
}
.m-nh-title { font-family: 'Rajdhani', sans-serif; font-size: 0.7rem; letter-spacing: 2px; color: var(--m-dim); font-weight: 700; text-transform: uppercase; }
.m-nh-id { font-family: 'Courier New', monospace; font-size: 0.6rem; color: var(--m-primary); opacity: 0.7; }

.m-neural-grid { display: grid; grid-template-columns: 1.8fr 1fr; gap: 10px; }

.m-dev-module {
    background: linear-gradient(135deg, rgba(255,255,255,0.03), rgba(0,0,0,0.2));
    border: 1px solid rgba(255,255,255,0.1);
    border-radius: 12px;
    padding: 10px;
    display: flex;
    align-items: center;
    gap: 10px;
    text-decoration: none;
    transition: all 0.3s ease;
    position: relative;
    overflow: hidden;
}
.m-dev-module:active { transform: scale(0.98); border-color: var(--m-primary); background: rgba(0, 242, 255, 0.05); }

.m-dev-img { width: 36px; height: 36px; border-radius: 8px; border: 1px solid rgba(255,255,255,0.2); object-fit: cover; }
.m-dev-data { display: flex; flex-direction: column; }
.m-dev-role { font-size: 0.5rem; color: var(--m-primary); letter-spacing: 1px; font-weight: 700; text-transform: uppercase; margin-bottom: 2px; }
.m-dev-nick { font-family: 'Rajdhani', sans-serif; font-size: 0.9rem; color: #fff; font-weight: 800; }

.m-support-module {
    background: linear-gradient(135deg, rgba(255, 94, 91, 0.1), rgba(0,0,0,0.2));
    border: 1px solid rgba(255, 94, 91, 0.3);
    border-radius: 12px;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    text-decoration: none;
    transition: all 0.3s ease;
    position: relative;
}
.m-support-module:active { transform: scale(0.98); background: rgba(255, 94, 91, 0.2); box-shadow: 0 0 15px rgba(255, 94, 91, 0.2); }
.m-kofi-ico { font-size: 1.1rem; color: var(--m-kofi); margin-bottom: 4px; animation: heartbeat 1.5s infinite; filter: drop-shadow(0 0 5px var(--m-kofi)); }
.m-support-txt { font-family: 'Rajdhani'; font-weight: 800; font-size: 0.75rem; color: #fff; letter-spacing: 1px; }

.m-star-btn {
    margin-top: 10px;
    background: linear-gradient(90deg, rgba(14, 165, 233, 0.1), rgba(14, 165, 233, 0.05), rgba(14, 165, 233, 0.1));
    border: 1px solid rgba(14, 165, 233, 0.3);
    border-radius: 12px;
    padding: 10px 15px;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 8px;
    text-decoration: none;
    color: var(--m-amber);
    font-family: 'Rajdhani', sans-serif;
    font-weight: 800;
    letter-spacing: 1px;
    font-size: 0.75rem;
    box-shadow: 0 0 10px rgba(14, 165, 233, 0.1);
    transition: all 0.3s ease;
    text-transform: uppercase;
    position: relative;
    overflow: hidden;
}
.m-star-btn:active { transform: scale(0.98); box-shadow: 0 0 20px var(--m-amber); color: #fff; background: var(--m-amber); border-color: var(--m-amber); }
.m-star-btn::before {
    content: ''; position: absolute; top: 0; left: -100%; width: 50%; height: 100%;
    background: linear-gradient(90deg, transparent, rgba(255,255,255,0.4), transparent);
    transform: skewX(-25deg);
    animation: shimmer 4s infinite;
}
@keyframes shimmer { 0% { left: -100%; } 20% { left: 200%; } 100% { left: 200%; } }
.spin-star { animation: pulseStar 2s infinite ease-in-out; text-shadow: 0 0 5px var(--m-amber); font-size: 0.9rem; }
@keyframes pulseStar { 0%, 100% { transform: scale(1); opacity: 1; } 50% { transform: scale(1.1); opacity: 0.7; } }

.m-neural-footer { margin-top: 10px; text-align: center; font-size: 0.6rem; color: rgba(255,255,255,0.2); font-family: monospace; letter-spacing: 2px; }

.m-dock-container {
    position: fixed;
    bottom: 0;
    left: 0;
    width: 100%;
    background:
        linear-gradient(180deg, rgba(3, 6, 10, 0.85) 0%, rgba(0, 2, 5, 0.98) 50%, rgba(0, 0, 2, 1) 100%);
    border-top: 1px solid rgba(0, 242, 255, 0.25);
    box-shadow: 0 -14px 50px rgba(0,0,0,0.95);
    z-index: 9999;
    display: flex; flex-direction: column;
    padding-bottom: calc(10px + env(safe-area-inset-bottom));
    backdrop-filter: blur(24px) saturate(130%);
    touch-action: none;
}

.m-dock-container::before {
    content: ''; position: absolute; top: -1px; left: 0; right: 0;
    height: 2px;
    background: linear-gradient(90deg, transparent 5%, rgba(0, 242, 255, 0.5) 30%, var(--m-secondary) 50%, rgba(0, 242, 255, 0.5) 70%, transparent 95%);
    box-shadow: 0 0 14px var(--m-primary);
}

.m-dock-actions {
    display: flex; gap: 9px; padding: 11px 14px 6px 14px;
    border-bottom: 1px solid rgba(0, 242, 255, 0.08);
}

.m-btn-install {
    flex: 2.5;
    background:
        linear-gradient(90deg, #00f2ff 0%, #00b4ff 50%, #7000ff 110%);
    color: #001018; border: none; border-radius: var(--m-radius-sm); height: 42px;
    font-family: 'Rajdhani', sans-serif; font-size: 0.92rem; font-weight: 900;
    text-transform: uppercase; letter-spacing: 2px;
    display: flex; align-items: center; justify-content: center; gap: 9px;
    box-shadow:
        0 0 22px rgba(0, 242, 255, 0.4),
        0 4px 14px rgba(0, 242, 255, 0.25),
        inset 0 1px 0 rgba(255,255,255,0.35),
        inset 0 -2px 0 rgba(0, 0, 0, 0.2);
    transition: all 0.2s; position: relative; overflow: hidden;
    cursor: pointer;
    text-shadow: 0 1px 0 rgba(255,255,255,0.4);
}
.m-btn-install::before {
    content: ''; position: absolute; top: 0; left: -100%; width: 50%; height: 100%;
    background: linear-gradient(90deg, transparent, rgba(255,255,255,0.55), transparent);
    transform: skewX(-25deg); animation: shimmer 3.5s linear infinite;
}
.m-btn-install:active { transform: scale(0.97); box-shadow: 0 0 30px rgba(0, 242, 255, 0.55); }
.m-btn-install i { font-size: 1rem; }

.m-btn-copy {
    flex: 1;
    background: linear-gradient(180deg, rgba(255,255,255,0.06), rgba(0,0,0,0.4));
    border: 1px solid rgba(0, 242, 255, 0.18);
    color: var(--m-text); border-radius: var(--m-radius-sm); height: 42px;
    display: flex; flex-direction: column; align-items: center; justify-content: center;
    font-family: 'Rajdhani', sans-serif; font-size: 0.6rem; font-weight: 800;
    letter-spacing: 1.5px; cursor: pointer;
    transition: all 0.2s;
    box-shadow: inset 0 0 0 1px rgba(255,255,255,0.03);
}
.m-btn-copy:active {
    background: rgba(0, 242, 255, 0.12);
    border-color: var(--m-primary);
    transform: scale(0.97);
}
.m-btn-copy i { font-size: 0.95rem; margin-bottom: 2px; color: var(--m-primary); filter: drop-shadow(0 0 4px var(--m-primary)); }

.m-dock-nav {
    display: flex; justify-content: space-around; align-items: center;
    padding: 8px 0 2px 0;
}

.m-nav-item {
    display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 4px;
    color: rgba(170, 205, 220, 0.72); width: 64px; transition: all 0.25s cubic-bezier(0.25, 1.5, 0.5, 1);
    position: relative;
    padding: 4px 0;
    cursor: pointer;
}
.m-nav-item i { font-size: 1.05rem; color: rgba(174, 215, 230, 0.76); transition: color 0.2s, filter 0.2s, opacity 0.2s; }
.m-nav-item span { font-size: 0.55rem; font-weight: 800; font-family: 'Rajdhani', sans-serif; letter-spacing: 1.6px; text-transform: uppercase; color: rgba(210, 238, 245, 0.68); text-shadow: 0 0 5px rgba(0, 242, 255, 0.10); }
.m-nav-item:not(.active) { opacity: 0.86; }
.m-nav-item:not(.active):active { color: var(--m-primary); opacity: 1; }

.m-nav-item.active { color: #fff; transform: translateY(-3px); }
.m-nav-item.active i { color: var(--m-primary); filter: drop-shadow(0 0 10px var(--m-primary)); }
.m-nav-item.active span { color: #fff; text-shadow: 0 0 10px rgba(0, 242, 255, 0.48); }
.m-nav-item.active::after {
    content: ''; position: absolute; bottom: -4px;
    width: 22px; height: 2px;
    background: linear-gradient(90deg, transparent, var(--m-primary), transparent);
    border-radius: 2px;
    box-shadow: 0 0 8px var(--m-primary);
}

.m-custom-dash { margin-top: 15px; background: rgba(0, 0, 0, 0.4); border: 1px dashed rgba(0, 242, 255, 0.3); border-radius: 12px; padding: 15px; animation: slideDown 0.3s ease; display: none; }
.m-custom-desc { font-size: 0.75rem; color: var(--m-dim); margin-bottom: 12px; font-family: 'Outfit', sans-serif; line-height: 1.4; border-left: 2px solid var(--m-primary); padding-left: 8px; }
.m-tag-list { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 12px; }
.m-tag-item { font-family: 'Rajdhani', monospace; font-size: 0.7rem; font-weight: 700; background: rgba(255, 255, 255, 0.08); padding: 3px 6px; border-radius: 4px; color: #fff; border: 1px solid rgba(255, 255, 255, 0.1); cursor: default; }

.m-aio-lock { position: absolute; top: 0; left: 0; width: 100%; height: 100%; background: rgba(0, 2, 5, 0.9); z-index: 20; display: none; flex-direction: column; align-items: center; justify-content: center; text-align: center; backdrop-filter: blur(4px); }
.m-aio-lock.active { display: flex; }
.m-lock-icon { font-size: 2rem; color: var(--m-secondary); margin-bottom: 10px; }
.m-lock-text { font-family: 'Rajdhani'; color: #fff; font-weight: 800; font-size: 1.1rem; }
.m-lock-sub { font-size: 0.75rem; color: #888; margin-top: 5px; max-width: 80%; }

@keyframes shakeGlow {
    0%, 100% { transform: translateX(0); border-color: rgba(170,0,255,0.2); box-shadow: none; }
    20% { transform: translateX(-5px); border-color: var(--m-secondary); box-shadow: 0 0 20px var(--m-secondary), inset 0 0 10px var(--m-secondary); }
    40% { transform: translateX(5px); }
    60% { transform: translateX(-5px); }
    80% { transform: translateX(5px); }
}
.m-denied-anim {
    animation: shakeGlow 0.4s cubic-bezier(.36,.07,.19,.97) both;
}

.m-recalc-overlay {
    position: absolute; top:0; left:0; width:100%; height:100%;
    background: rgba(0,0,0,0.7);
    display: flex; align-items: center; justify-content: center;
    z-index: 10; opacity: 0; pointer-events: none;
    transition: opacity 0.2s;
    backdrop-filter: blur(2px);
}
.m-recalc-overlay.visible { opacity: 1; }
.m-recalc-text {
    font-family: 'Rajdhani'; font-weight: 800; color: var(--m-primary);
    letter-spacing: 2px; text-transform: uppercase; font-size: 0.9rem;
    display: flex; align-items: center; gap: 10px;
    text-shadow: 0 0 10px var(--m-primary);
}

.m-toast-container {
    position: fixed; bottom: 120px; left: 50%; transform: translateX(-50%);
    z-index: 999; pointer-events: none; width: 90%; max-width: 300px;
    display: flex; flex-direction: column; gap: 10px;
}
.m-toast {
    background: rgba(5, 10, 15, 0.95);
    border: 1px solid var(--m-primary);
    border-left: 4px solid var(--m-primary);
    box-shadow: 0 5px 20px rgba(0,0,0,0.8);
    color: #fff; padding: 12px 15px; border-radius: 8px;
    font-family: 'Rajdhani'; font-size: 0.9rem; font-weight: 700;
    display: flex; align-items: center; gap: 12px;
    animation: slideUpFade 0.3s ease-out forwards;
    backdrop-filter: blur(5px);
}
.m-toast.warning { border-color: var(--m-amber); border-left-color: var(--m-amber); color: var(--m-amber); }
.m-toast.error { border-color: var(--m-error); border-left-color: var(--m-error); color: var(--m-error); }
.m-toast.success { border-color: var(--m-success); border-left-color: var(--m-success); color: var(--m-success); }
@keyframes slideUpFade {
    from { opacity: 0; transform: translateY(20px); }
    to { opacity: 1; transform: translateY(0); }
}
.m-toast.out { animation: fadeOut 0.3s ease-out forwards; }
@keyframes fadeOut { to { opacity: 0; transform: translateY(-10px); } }

body.m-lowfx::after {
    opacity: 0.18;
}

body.m-lowfx::before {
    opacity: 0.3;
}

body.m-lowfx .m-sea-waves,
body.m-lowfx .m-caustic,
body.m-lowfx .m-ocean-particles {
    display: none;
}

body.m-lowfx #m-sea-canvas {
    display: none;
}

body.m-lowfx .m-hero::after,
body.m-lowfx .logo-particles {
    display: none;
}

body.m-lowfx .logo-container,
body.m-lowfx .logo-image,
body.m-lowfx .m-brand-title,
body.m-lowfx .m-version-tag,
body.m-lowfx .m-version-tag .m-v-dot,
body.m-lowfx .m-btn-install::before,
body.m-lowfx .m-star-btn::before,
body.m-lowfx .m-visual-core-v2::before {
    animation: none !important;
}

body.m-lowfx .m-version-tag::before,
body.m-lowfx .m-btn-install::before,
body.m-lowfx .m-star-btn::before {
    display: none !important;
}

body.m-lowfx .m-brand-title {
    filter: drop-shadow(0 0 8px rgba(0, 242, 255, 0.24));
}

body.m-lowfx .logo-image {
    filter: drop-shadow(0 8px 14px rgba(0,0,0,0.40)) brightness(1.04) saturate(1.04);
}

@media (prefers-reduced-motion: reduce) {
    .m-page.active,
    .m-ptr.loading .m-ptr-icon,
    .logo-container,
    .logo-image,
    .logo-particle,
    .m-v-dot,
    .m-kofi-ico,
    .spin-star,
    .m-star-btn::before,
    .m-hero::after,
    .m-wave,
    .m-wave-crest,
    .m-caustic-ray {
        animation: none !important;
        transition: none !important;
    }

    body::after,
    body::before,
    .logo-particles,
    .m-caustic {
        display: none !important;
    }
}

body.m-page-hidden *, body.m-page-hidden *::before, body.m-page-hidden *::after {
    animation-play-state: paused !important;
}

body.m-typing .m-content, body.m-keyboard-open .m-content {
    scroll-behavior: auto;
}

:root {
    --m-vvh: 100dvh;
    --m-dock-h: 118px;
    --m-card-bg: rgba(8, 17, 29, 0.88);
    --m-card-bg-2: rgba(3, 8, 16, 0.94);
    --m-card-border: rgba(120, 220, 255, 0.15);
    --m-soft-shadow: 0 10px 24px rgba(0, 0, 0, 0.34);
}

html, body {
    min-height: 100%;
    background-color: #020711;
    overscroll-behavior-y: contain;
}

body.m-mf-lite {
    background:
        radial-gradient(ellipse at 50% -10%, rgba(0, 226, 255, 0.20), transparent 42%),
        radial-gradient(circle at 85% 20%, rgba(124, 58, 237, 0.13), transparent 36%),
        radial-gradient(circle at 10% 80%, rgba(0, 180, 255, 0.10), transparent 34%),
        linear-gradient(180deg, #041321 0%, #020a13 46%, #00040a 100%);
}

body.m-mf-lite::after {
    opacity: 0.12;
    mix-blend-mode: normal;
}

body.m-mf-lite::before {
    opacity: 0.26;
    animation-duration: 140s;
    background-size: 56px 56px;
}

input, textarea, [contenteditable="true"] {
    user-select: text !important;
    -webkit-user-select: text !important;
    touch-action: manipulation;
}

button, .m-nav-item, .m-cred-opt, .m-reactor-module, .m-cortex-chip, .m-flux-opt, .m-lang-opt, .m-act-btn, .m-btn-install, .m-btn-copy, .m-if-action, .m-paste-action {
    touch-action: manipulation;
}

#app-container {
    height: var(--m-vvh, 100dvh);
    contain: layout style;
}

.m-content-wrapper {
    height: var(--m-vvh, 100dvh);
}

.m-content {
    padding: 0 13px calc(var(--m-dock-h) + 26px + var(--safe-bottom)) 13px;
    scroll-behavior: auto;
    overscroll-behavior-y: contain;
}

body.m-keyboard-open .m-content {
    padding-bottom: calc(68px + var(--safe-bottom));
}

body.m-keyboard-open .m-dock-container {
    transform: translate3d(0, calc(100% - 58px - var(--safe-bottom)), 0);
    transition: transform 180ms ease, opacity 180ms ease;
    opacity: 0.96;
}

body.m-keyboard-open .m-dock-actions {
    opacity: 0;
    pointer-events: none;
}

body.m-keyboard-open .m-toast-container {
    bottom: calc(70px + var(--safe-bottom));
}

.m-hero {
    padding: 18px 8px 14px;
}

.m-hero::before {
    height: 210px;
    filter: blur(18px);
    opacity: 0.78;
}

.logo-container {
    width: 128px;
    height: 128px;
    margin-bottom: 10px;
    animation-duration: 8s;
}

.logo-container::before {
    inset: 8px;
    border-width: 2px;
    box-shadow: 0 0 18px rgba(0, 242, 255, 0.18), inset 0 0 16px rgba(112, 0, 255, 0.08);
}

.logo-image {
    max-width: 116px;
    animation: none;
    filter: drop-shadow(0 8px 14px rgba(0,0,0,0.42)) brightness(1.05) saturate(1.06);
    will-change: opacity;
}

.logo-particles, .m-caustic {
    opacity: 0.45;
}

.m-brand-title {
    font-size: clamp(2.26rem, 12vw, 2.88rem);
    animation: none;
    filter: drop-shadow(0 0 10px rgba(0, 242, 255, 0.24));
}

.m-brand-sub {
    font-size: 0.68rem;
    letter-spacing: 3.2px;
    text-shadow: 0 0 7px rgba(0, 242, 255, 0.48);
}

.m-brand-desc {
    font-size: 0.72rem;
    max-width: 292px;
    opacity: 0.82;
}

.m-version-tag {
    animation: none;
    background: rgba(0, 242, 255, 0.075);
    box-shadow: inset 0 0 10px rgba(0, 242, 255, 0.06);
}

.m-version-tag::before,
.m-btn-install::before,
.m-star-btn::before,
.m-hypervisor::before,
.m-visual-core-v2::before {
    display: none !important;
}

.m-section-head {
    margin: 4px 2px 10px;
    padding: 8px 0 8px 11px;
    border-left-width: 3px;
    box-shadow: none;
}

.m-section-head .sh-title {
    font-size: 0.88rem;
    letter-spacing: 2px;
}

.m-section-head .sh-sub {
    font-size: 0.60rem;
    letter-spacing: 1px;
}

.m-section-head .sh-tag {
    border-radius: 999px;
    padding: 3px 8px;
    background: rgba(0, 242, 255, 0.08);
}

.m-hypervisor,
.m-visual-core-v2,
.m-ghost-panel,
.m-p2p-module {
    background:
        linear-gradient(145deg, rgba(12, 26, 42, 0.88), rgba(3, 8, 16, 0.95)),
        radial-gradient(circle at 100% 0%, rgba(0, 242, 255, 0.08), transparent 40%);
    border: 1px solid var(--m-card-border);
    border-radius: 20px;
    box-shadow: var(--m-soft-shadow), inset 0 1px 0 rgba(255,255,255,0.04);
    backdrop-filter: none;
    overflow: hidden;
}

.m-hypervisor::after,
.m-visual-core-v2::after {
    opacity: 0.35;
}

.m-hyp-header {
    margin-bottom: 12px;
    padding-bottom: 9px;
    letter-spacing: 2px;
    border-bottom-color: rgba(120, 220, 255, 0.12);
}

.m-hyp-icon {
    width: 26px;
    height: 26px;
    box-shadow: none;
    filter: none;
}

.m-cred-deck,
.m-lang-grid,
.m-flux-grid {
    gap: 8px;
}

.m-cred-opt,
.m-lang-opt,
.m-flux-opt,
.m-cortex-chip,
.m-cloud-mode-btn,
.m-qual-chip {
    background: linear-gradient(180deg, rgba(14, 30, 48, 0.76), rgba(4, 9, 18, 0.94));
    border-color: rgba(120, 220, 255, 0.12);
    border-radius: 15px;
    box-shadow: 0 6px 14px rgba(0,0,0,0.26), inset 0 1px 0 rgba(255,255,255,0.035);
    transition: transform 120ms ease, border-color 120ms ease, background 120ms ease, opacity 120ms ease;
}

.m-cred-opt {
    min-height: 84px;
    padding: 12px 4px 10px;
}

.m-cred-icon {
    font-size: 1.62rem;
    color: inherit;
    filter: none;
}

.m-cred-name {
    font-size: 0.69rem;
    letter-spacing: 1px;
    color: rgba(224, 247, 250, 0.74);
}

.m-cred-opt.active,
.m-lang-opt.active-ita,
.m-lang-opt.active-hyb,
.m-lang-opt.active-eng,
.m-flux-opt.active-bal,
.m-flux-opt.active-res,
.m-flux-opt.active-sz,
.m-cortex-chip.active,
.m-cloud-mode-btn.active {
    transform: translateY(-1px);
    box-shadow: 0 8px 20px rgba(0,0,0,0.34), inset 0 0 14px rgba(0, 242, 255, 0.06);
}

.m-input-fuselage,
.m-input-box {
    margin-bottom: 14px;
}

.m-input-fuselage {
    background: rgba(3, 8, 16, 0.82);
    border-color: rgba(120, 220, 255, 0.13);
    border-radius: 16px;
    box-shadow: none;
}

.m-input-fuselage:focus-within {
    box-shadow: 0 0 0 1px rgba(0, 242, 255, 0.24), 0 10px 24px rgba(0,0,0,0.30);
}

.m-if-inner {
    height: 50px;
    background: rgba(1, 5, 11, 0.74);
    border-radius: 14px;
}

.m-if-field,
.m-input-tech,
.m-flux-input,
#m-customTemplate {
    font-size: 16px !important;
    line-height: 1.25;
    -webkit-text-size-adjust: 100%;
}

.m-get-link {
    border-radius: 999px;
    white-space: nowrap;
}

.m-key-status {
    padding: 8px 11px 10px;
    letter-spacing: 0.8px;
}

.m-reactor-grid {
    gap: 9px;
}

.m-reactor-module {
    min-height: 72px;
    border-radius: 17px;
    background: linear-gradient(140deg, rgba(13, 28, 45, 0.82), rgba(3, 8, 16, 0.96));
    border-color: rgba(120, 220, 255, 0.105);
    box-shadow: 0 7px 18px rgba(0,0,0,0.32), inset 0 1px 0 rgba(255,255,255,0.035);
    transition: border-color 120ms ease, transform 120ms ease;
}

.m-reactor-module::after {
    opacity: 0 !important;
}

.m-reactor-module.active {
    box-shadow: 0 8px 20px rgba(0,0,0,0.36), inset 0 0 0 1px var(--border-color-dim);
}

.m-reactor-core {
    width: 48px;
    background: rgba(255,255,255,0.035);
}

.m-reactor-module.active .m-reactor-core {
    box-shadow: none;
}

.m-reactor-title {
    font-size: clamp(0.82rem, 3.8vw, 0.96rem);
    line-height: 1.05;
    overflow-wrap: anywhere;
}

.m-reactor-desc {
    font-size: 0.62rem;
    color: rgba(224, 247, 250, 0.48);
    line-height: 1.25;
}

.m-tag-row {
    flex-wrap: wrap;
    gap: 5px;
}

.m-tech-tag {
    border-radius: 999px;
    font-size: 0.48rem;
    letter-spacing: 0.75px;
    padding: 3px 6px;
}

.m-mini-tabs {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 6px;
    width: 100%;
}

.m-mini-tab {
    border-radius: 12px;
    min-width: 0;
    text-align: center;
}

.m-visual-preview {
    border-radius: 16px;
    background: linear-gradient(145deg, rgba(10, 22, 36, 0.92), rgba(2, 7, 14, 0.98));
    box-shadow: 0 8px 18px rgba(0,0,0,0.36);
}

.m-cortex-chip {
    clip-path: none;
    min-height: 72px;
}

.m-cortex-chip.active::after {
    border-radius: 999px 0 0 0;
}

.m-chip-icon {
    filter: none;
    text-shadow: none;
}

.m-chip-label {
    letter-spacing: 0.56px;
    text-shadow: none;
}

.m-chip-sub {
    opacity: 0.78;
}

.m-sys-grid {
    border-radius: 18px;
    background: rgba(1, 5, 11, 0.40);
}

.m-sys-row {
    padding: 12px 13px;
}

.m-dock-container {
    background: linear-gradient(180deg, rgba(5, 15, 25, 0.94), rgba(0, 4, 9, 0.99));
    border-top-color: rgba(120, 220, 255, 0.16);
    box-shadow: 0 -8px 24px rgba(0,0,0,0.58);
    backdrop-filter: none;
    padding-bottom: calc(8px + env(safe-area-inset-bottom));
    touch-action: manipulation;
    will-change: transform;
}

.m-dock-container::before {
    height: 1px;
    opacity: 0.65;
    box-shadow: none;
}

.m-dock-actions {
    padding: 9px 12px 5px;
    gap: 8px;
}

.m-btn-install,
.m-btn-copy {
    height: 40px;
    border-radius: 14px;
    box-shadow: 0 6px 16px rgba(0, 180, 255, 0.17);
}

.m-btn-install {
    letter-spacing: 1.4px;
}

.m-dock-nav {
    padding: 7px 0 1px;
}

.m-nav-item {
    width: min(20vw, 68px);
    transition: transform 120ms ease, opacity 120ms ease;
}

.m-nav-item.active {
    transform: translateY(-1px);
}

.m-nav-item i {
    filter: none !important;
}

.m-nav-item span {
    letter-spacing: 1.05px;
}

.m-toast-container {
    bottom: calc(var(--m-dock-h) + 12px + var(--safe-bottom));
}

.m-toast {
    backdrop-filter: none;
    border-radius: 14px;
    box-shadow: 0 8px 22px rgba(0,0,0,0.44);
}

#m-sea-canvas {
    opacity: 0.82;
}

body.m-typing .m-caustic,
body.m-typing .m-ocean-particles,
body.m-typing .logo-particles,
body.m-keyboard-open .m-caustic,
body.m-keyboard-open .m-ocean-particles,
body.m-keyboard-open .logo-particles {
    display: none !important;
}

body.m-typing .logo-container,
body.m-typing .m-v-dot,
body.m-typing .m-ptr.loading .m-ptr-icon,
body.m-typing .m-page.active,
body.m-keyboard-open .logo-container,
body.m-keyboard-open .m-v-dot,
body.m-keyboard-open .m-page.active {
    animation: none !important;
}

body.m-typing .m-hypervisor,
body.m-keyboard-open .m-hypervisor,
body.m-typing .m-visual-core-v2,
body.m-keyboard-open .m-visual-core-v2 {
    box-shadow: 0 7px 16px rgba(0,0,0,0.28), inset 0 1px 0 rgba(255,255,255,0.03);
}

@media (max-width: 370px) {
    .m-content { padding-left: 10px; padding-right: 10px; }
    .m-cred-deck { gap: 6px; }
    .m-cred-name { font-size: 0.62rem; }
    .m-reactor-core { width: 42px; }
    .m-reactor-body { padding: 8px 9px; }
    .m-dock-actions { padding-left: 10px; padding-right: 10px; }
}

@media (prefers-reduced-motion: reduce) {
    *, *::before, *::after {
        animation-duration: 0.001ms !important;
        animation-iteration-count: 1 !important;
        transition-duration: 0.001ms !important;
        scroll-behavior: auto !important;
    }
}

body.m-mf-plus {
    --mf-card: rgba(10, 24, 39, 0.86);
    --mf-card-2: rgba(3, 10, 19, 0.94);
    --mf-line: rgba(125, 232, 255, 0.16);
    --mf-chip: rgba(0, 242, 255, 0.085);
    --mf-chip-2: rgba(124, 58, 237, 0.08);
}

body.m-mf-plus .m-brand-desc,
body.m-mf-plus .m-reactor-desc,
body.m-mf-plus .m-hyp-desc,
body.m-mf-plus .m-sys-info p,
body.m-mf-plus .m-range-desc,
body.m-mf-plus .m-cloud-note {
    text-wrap: balance;
}

body.m-mf-plus .m-section-head {
    border-left: 0;
    padding: 7px 8px;
    border-radius: 16px;
    background: linear-gradient(90deg, rgba(0,242,255,0.075), rgba(124, 58, 237,0.055), transparent);
    border: 1px solid rgba(125,232,255,0.10);
}

body.m-mf-plus .m-section-head .sh-title {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    font-size: 0.86rem;
    letter-spacing: 1.35px;
}

body.m-mf-plus .m-section-head .sh-sub {
    color: rgba(224,247,250,0.62);
}

body.m-mf-plus .m-section-head .sh-tag {
    font-size: 0.54rem;
    border-color: rgba(125,232,255,0.18);
    background: rgba(0, 242, 255, 0.075);
}

body.m-mf-plus .m-hyp-header {
    display: flex;
    align-items: center;
    min-height: 30px;
    color: #f5fdff;
}

body.m-mf-plus .m-hypervisor,
body.m-mf-plus .m-visual-core-v2 {
    background:
        linear-gradient(145deg, var(--mf-card), var(--mf-card-2)),
        radial-gradient(circle at 0 0, rgba(0,242,255,0.08), transparent 38%),
        radial-gradient(circle at 100% 0, rgba(124, 58, 237,0.07), transparent 44%);
}

body.m-mf-plus .m-cred-opt,
body.m-mf-plus .m-lang-opt,
body.m-mf-plus .m-flux-opt,
body.m-mf-plus .m-cortex-chip,
body.m-mf-plus .m-cloud-mode-btn,
body.m-mf-plus .m-qual-chip {
    border-radius: 18px;
    background:
        linear-gradient(180deg, rgba(18, 38, 58, 0.78), rgba(4, 12, 22, 0.95));
    border-color: var(--mf-line);
}

body.m-mf-plus .m-cred-opt::before,
body.m-mf-plus .m-cred-opt::after,
body.m-mf-plus .m-cortex-chip::before {
    display: none !important;
}

body.m-mf-plus .m-cred-icon {
    font-size: 1.74rem;
    line-height: 1;
}

body.m-mf-plus .m-cred-name {
    font-size: 0.64rem;
    letter-spacing: 0.55px;
    white-space: nowrap;
}

body.m-mf-plus .m-reactor-module {
    min-height: 76px;
    border-radius: 19px;
    background:
        linear-gradient(135deg, rgba(13, 33, 53, 0.90), rgba(3, 10, 19, 0.97));
    border-color: var(--mf-line);
}

body.m-mf-plus .m-reactor-module.active {
    border-color: color-mix(in srgb, var(--border-color) 70%, #ffffff 0%);
    background:
        linear-gradient(135deg, rgba(15, 43, 68, 0.95), rgba(3, 10, 19, 0.98));
}

body.m-mf-plus .m-reactor-core {
    width: 50px;
    background: linear-gradient(180deg, rgba(255,255,255,0.055), rgba(0,0,0,0.08));
}

body.m-mf-plus .m-core-icon {
    font-size: 1.05rem;
    opacity: 0.72;
}

body.m-mf-plus .m-reactor-module.active .m-core-icon {
    opacity: 1;
    transform: scale(1.08);
}

body.m-mf-plus .m-reactor-title {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    letter-spacing: 0.2px;
    color: #ffffff;
}

body.m-mf-plus .m-reactor-desc {
    color: rgba(224,247,250,0.56);
}

body.m-mf-plus .m-tech-tag,
body.m-mf-plus .mini-tag,
body.m-mf-plus .m-tag-item {
    border-radius: 999px;
}

body.m-mf-plus .m-tech-tag i {
    margin-right: 2px;
}

body.m-mf-plus .m-cortex-grid {
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 8px;
}

body.m-mf-plus .m-chip-icon {
    font-size: 1.16rem;
    line-height: 1;
}

body.m-mf-plus .m-chip-label {
    font-size: 0.66rem;
}

body.m-mf-plus .m-chip-sub {
    font-size: 0.52rem;
}

body.m-mf-plus .m-flux-readout,
body.m-mf-plus #lang-desc-container,
body.m-mf-plus .m-sys-grid,
body.m-mf-plus .m-input-fuselage,
body.m-mf-plus .m-input-box {
    border-radius: 18px !important;
    border-color: rgba(125,232,255,0.13) !important;
    background: linear-gradient(145deg, rgba(6, 18, 31, 0.72), rgba(1, 7, 14, 0.88)) !important;
}

body.m-mf-plus .m-sys-info h4,
body.m-mf-plus .m-label h4 {
    font-size: 0.82rem;
}

body.m-mf-plus .m-btn-install {
    background: linear-gradient(90deg, #00f2ff 0%, #22d3ee 42%, #8b5cf6 105%);
    gap: 7px;
}

body.m-mf-plus .m-btn-copy {
    gap: 1px;
}

body.m-mf-plus .mf-btn-emoji,
body.m-mf-plus .mf-copy-emoji,
body.m-mf-plus .mf-nav-emoji {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    line-height: 1;
}

body.m-mf-plus .mf-nav-emoji {
    font-size: 1.04rem;
    margin-bottom: -2px;
}

body.m-mf-plus .m-nav-item i {
    display: none;
}

body.m-mf-plus .m-nav-item span {
    font-size: 0.54rem;
    letter-spacing: 0.9px;
}

body.m-mf-plus .m-nav-item.active .mf-nav-emoji {
    filter: drop-shadow(0 0 8px rgba(0,242,255,0.55));
}

body.m-mf-plus .m-dock-container {
    border-top-left-radius: 21px;
    border-top-right-radius: 21px;
}

body.m-mf-plus .m-toast i {
    margin-right: 5px;
}

body.m-keyboard-open.m-mf-plus .mf-nav-emoji,
body.m-typing.m-mf-plus .mf-nav-emoji {
    filter: none !important;
}

body.m-keyboard-open:not(.m-input-active) .m-dock-container {
    transform: translate3d(0, 0, 0) !important;
    opacity: 1 !important;
}

body.m-keyboard-open:not(.m-input-active) .m-dock-actions {
    opacity: 1 !important;
    pointer-events: auto !important;
}

body.m-mf-plus .m-dock-container {
    padding-top: 7px;
    background:
        radial-gradient(ellipse at 50% -25%, rgba(0,242,255,0.18), transparent 54%),
        linear-gradient(180deg, rgba(7, 21, 34, 0.96), rgba(0, 5, 12, 0.995));
    border-top: 1px solid rgba(125,232,255,0.22);
    box-shadow: 0 -12px 30px rgba(0,0,0,0.68), 0 -1px 0 rgba(255,255,255,0.035) inset;
}

body.m-mf-plus .m-dock-actions {
    padding: 10px 12px 6px;
    gap: 9px;
    border-bottom-color: rgba(125,232,255,0.08);
}

body.m-mf-plus .m-btn-install,
body.m-mf-plus .m-btn-copy {
    height: 45px;
    min-height: 45px;
    border-radius: 17px;
    position: relative;
    overflow: hidden;
    transform: translateZ(0);
}

body.m-mf-plus .m-btn-install {
    flex: 2.25;
    color: #00141d;
    background:
        linear-gradient(135deg, rgba(255,255,255,0.96) 0%, rgba(159,246,255,0.96) 18%, #22d3ee 46%, #00a7ff 66%, #8b5cf6 108%);
    border: 1px solid rgba(255,255,255,0.36);
    box-shadow:
        0 9px 22px rgba(0, 213, 255, 0.28),
        0 0 0 1px rgba(0,242,255,0.08),
        inset 0 1px 0 rgba(255,255,255,0.78),
        inset 0 -2px 0 rgba(0,0,0,0.17);
    font-size: 0.98rem;
    letter-spacing: 1.15px;
    text-shadow: 0 1px 0 rgba(255,255,255,0.50);
}

body.m-mf-plus .m-btn-install::after {
    content: "";
    position: absolute;
    inset: 1px;
    border-radius: 16px;
    background: linear-gradient(180deg, rgba(255,255,255,0.36), transparent 44%);
    pointer-events: none;
}

body.m-mf-plus .m-btn-install .mf-btn-emoji {
    width: 24px;
    height: 24px;
    border-radius: 9px;
    background: rgba(255,255,255,0.42);
    box-shadow: inset 0 0 0 1px rgba(255,255,255,0.34), 0 3px 8px rgba(0,0,0,0.13);
    font-size: 1.03rem;
}

body.m-mf-plus .m-btn-install i {
    display: none;
}

body.m-mf-plus .m-btn-copy {
    flex: 1.04;
    color: #dffbff;
    background:
        radial-gradient(circle at 50% 0%, rgba(0,242,255,0.18), transparent 56%),
        linear-gradient(180deg, rgba(18, 34, 50, 0.95), rgba(2, 8, 16, 0.98));
    border: 1px solid rgba(125,232,255,0.30);
    box-shadow:
        0 8px 18px rgba(0,0,0,0.36),
        inset 0 1px 0 rgba(255,255,255,0.08);
    font-size: 0.58rem;
    letter-spacing: 1.1px;
}

body.m-mf-plus .m-btn-copy .mf-copy-emoji {
    font-size: 1.06rem;
    margin-bottom: 0;
    filter: drop-shadow(0 0 7px rgba(0,242,255,0.45));
}

body.m-mf-plus .m-btn-copy i {
    display: none;
}

body.m-mf-plus .m-btn-install:active,
body.m-mf-plus .m-btn-copy:active {
    transform: scale(0.985) translateZ(0);
}

body.m-input-active.m-keyboard-open .m-dock-container {
    transform: translate3d(0, calc(100% - 60px - var(--safe-bottom)), 0);
}

body.m-input-active.m-keyboard-open .m-dock-actions {
    opacity: 0;
    pointer-events: none;
}

@supports not (color: color-mix(in srgb, red, blue)) {
    body.m-mf-plus .m-reactor-module.active { border-color: var(--border-color); }
}

body.m-mf-plus {
    --lc-card-bg: rgba(7, 19, 32, 0.88);
    --lc-card-bg-strong: rgba(3, 10, 19, 0.96);
    --lc-card-line: rgba(134, 232, 255, 0.18);
    --lc-card-line-soft: rgba(134, 232, 255, 0.105);
    --lc-card-glass: rgba(255, 255, 255, 0.035);
    --lc-card-shadow: 0 10px 22px rgba(0, 0, 0, 0.36);
    --lc-card-shadow-soft: 0 6px 15px rgba(0, 0, 0, 0.26);
}

body.m-mf-plus .m-content {
    padding-left: 12px;
    padding-right: 12px;
}

body.m-mf-plus .m-section-head {
    margin: 8px 2px 11px;
    padding: 9px 10px;
    border-radius: 20px;
    background:
        radial-gradient(circle at 0 0, rgba(0,242,255,0.16), transparent 36%),
        linear-gradient(90deg, rgba(10, 29, 47, 0.88), rgba(4, 13, 24, 0.62));
    border: 1px solid var(--lc-card-line-soft);
    box-shadow: 0 6px 16px rgba(0,0,0,0.22), inset 0 1px 0 rgba(255,255,255,0.045);
}

body.m-mf-plus .m-section-head .sh-title {
    font-size: 0.90rem;
    letter-spacing: 1.15px;
    color: #f7fdff;
}

body.m-mf-plus .m-section-head .sh-sub {
    font-size: 0.61rem;
    letter-spacing: 0.75px;
    color: rgba(224,247,250,0.64);
}

body.m-mf-plus .m-section-head .sh-tag {
    min-width: 48px;
    text-align: center;
    color: #00151b;
    background: linear-gradient(135deg, rgba(164,250,255,0.96), rgba(34,211,238,0.92));
    border: 0;
    box-shadow: 0 5px 12px rgba(0, 214, 255, 0.18), inset 0 1px 0 rgba(255,255,255,0.55);
}

body.m-mf-plus .m-section-head .sh-tag.violet {
    color: #fff;
    background: linear-gradient(135deg, rgba(124, 58, 237,0.98), rgba(99,102,241,0.92));
    box-shadow: 0 5px 12px rgba(124, 58, 237,0.16), inset 0 1px 0 rgba(255,255,255,0.18);
}

body.m-mf-plus .m-hypervisor,
body.m-mf-plus .m-visual-core-v2,
body.m-mf-plus .m-ghost-panel,
body.m-mf-plus .m-p2p-module {
    padding: 14px;
    border-radius: 26px;
    border-color: var(--lc-card-line);
    background:
        radial-gradient(circle at 0 0, rgba(0,242,255,0.115), transparent 38%),
        radial-gradient(circle at 100% 0, rgba(124, 58, 237,0.095), transparent 43%),
        linear-gradient(155deg, var(--lc-card-bg), var(--lc-card-bg-strong));
    box-shadow: var(--lc-card-shadow), inset 0 1px 0 rgba(255,255,255,0.05);
}

body.m-mf-plus .m-hyp-header {
    margin: -2px 0 13px;
    padding: 0 0 11px;
    border-bottom: 1px solid rgba(134,232,255,0.13);
    font-size: 0.86rem;
    letter-spacing: 1.45px;
}

body.m-mf-plus .m-hyp-icon {
    width: 30px;
    height: 30px;
    border-radius: 12px;
    background: linear-gradient(135deg, rgba(0,242,255,0.16), rgba(124, 58, 237,0.10));
    border: 1px solid rgba(134,232,255,0.18);
}

body.m-mf-plus .m-cred-deck {
    gap: 9px;
    margin-bottom: 17px;
}

body.m-mf-plus .m-cred-opt {
    min-height: 88px;
    padding: 12px 5px 10px;
    border-radius: 21px;
    background:
        radial-gradient(circle at 50% 0, var(--opt-glow), transparent 54%),
        linear-gradient(180deg, rgba(19, 41, 63, 0.82), rgba(3, 10, 19, 0.96));
    border-color: rgba(134,232,255,0.14);
    box-shadow: var(--lc-card-shadow-soft), inset 0 1px 0 rgba(255,255,255,0.05);
}

body.m-mf-plus .m-cred-opt.active {
    transform: translateY(-1px);
    border-color: var(--opt-color);
    background:
        radial-gradient(circle at 50% 0, var(--opt-glow), transparent 58%),
        linear-gradient(180deg, rgba(24, 52, 77, 0.96), rgba(3, 10, 19, 0.98));
    box-shadow: 0 9px 20px rgba(0,0,0,0.36), 0 0 0 1px var(--opt-glow), inset 0 0 14px rgba(255,255,255,0.035);
}

body.m-mf-plus .m-cred-opt.active::after {
    content: "✓" !important;
    display: flex !important;
    align-items: center;
    justify-content: center;
    position: absolute;
    top: 7px;
    right: 7px;
    inset: auto 7px auto auto;
    width: 20px;
    height: 20px;
    border-radius: 999px;
    color: #00151b;
    background: var(--opt-color);
    font-family: 'Rajdhani', sans-serif;
    font-size: 0.78rem;
    font-weight: 900;
    opacity: 1 !important;
    box-shadow: 0 0 10px var(--opt-glow);
}

body.m-mf-plus .m-cred-icon {
    font-size: 1.90rem;
    transform: translateZ(0);
}

body.m-mf-plus .m-cred-name {
    font-size: 0.63rem;
    letter-spacing: 0.7px;
    color: rgba(244,253,255,0.74);
}

body.m-mf-plus .m-input-fuselage,
body.m-mf-plus .m-input-box {
    border-radius: 22px !important;
    padding: 3px;
    background:
        radial-gradient(circle at 0 0, rgba(0,242,255,0.09), transparent 38%),
        linear-gradient(180deg, rgba(10, 24, 39, 0.86), rgba(2, 8, 16, 0.96)) !important;
    box-shadow: inset 0 1px 0 rgba(255,255,255,0.035), 0 7px 16px rgba(0,0,0,0.25);
}

body.m-mf-plus .m-if-inner,
body.m-mf-plus .m-input-box {
    min-height: 52px;
}

body.m-mf-plus .m-if-label,
body.m-mf-plus .m-field-label {
    border-radius: 999px;
    background: linear-gradient(135deg, rgba(9, 25, 40, 0.98), rgba(4, 12, 22, 0.98));
    border-color: rgba(134,232,255,0.20);
    color: rgba(224,247,250,0.74);
}

body.m-mf-plus .m-key-status {
    margin: 7px 2px 1px;
    border-radius: 16px;
    background: rgba(0,0,0,0.15);
}

body.m-mf-plus .m-reactor-grid {
    display: grid;
    grid-template-columns: 1fr;
    gap: 10px;
    margin-bottom: 18px;
}

body.m-mf-plus .m-reactor-module {
    min-height: 82px;
    border-radius: 23px;
    background:
        radial-gradient(circle at 0 0, rgba(255,255,255,0.045), transparent 40%),
        linear-gradient(145deg, rgba(12, 31, 49, 0.91), rgba(3, 10, 19, 0.98));
    border: 1px solid var(--lc-card-line-soft);
    box-shadow: var(--lc-card-shadow-soft), inset 0 1px 0 rgba(255,255,255,0.045);
}

body.m-mf-plus .m-reactor-module::before {
    content: "";
    position: absolute;
    left: 0;
    top: 12px;
    bottom: 12px;
    width: 4px;
    border-radius: 999px;
    background: var(--border-color, var(--m-primary));
    opacity: 0.34;
    box-shadow: 0 0 12px var(--glow-color, rgba(0,242,255,0.28));
}

body.m-mf-plus .m-reactor-module.active {
    border-color: var(--border-color);
    background:
        radial-gradient(circle at 0 0, var(--glow-color), transparent 45%),
        linear-gradient(145deg, rgba(16, 42, 65, 0.98), rgba(3, 10, 19, 0.99));
    box-shadow: 0 10px 24px rgba(0,0,0,0.42), 0 0 0 1px var(--border-color-dim), inset 0 1px 0 rgba(255,255,255,0.06);
}

body.m-mf-plus .m-reactor-module.active::before {
    opacity: 1;
}

body.m-mf-plus .m-reactor-core {
    width: 54px;
    margin: 11px 0 11px 11px;
    border-radius: 18px;
    border-right: 0;
    background: rgba(255,255,255,0.055);
    box-shadow: inset 0 1px 0 rgba(255,255,255,0.06);
}

body.m-mf-plus .m-reactor-module.active .m-reactor-core {
    background: color-mix(in srgb, var(--border-color) 18%, rgba(255,255,255,0.04));
}

body.m-mf-plus .m-core-icon {
    font-size: 1.18rem;
    opacity: 0.84;
}

body.m-mf-plus .m-reactor-body {
    padding: 10px 12px 10px 10px;
}

body.m-mf-plus .m-reactor-body::after {
    content: "OFF";
    position: absolute;
    right: 11px;
    bottom: 9px;
    padding: 2px 7px;
    border-radius: 999px;
    font-family: 'Rajdhani', sans-serif;
    font-size: 0.53rem;
    font-weight: 900;
    letter-spacing: 0.8px;
    color: rgba(224,247,250,0.42);
    border: 1px solid rgba(255,255,255,0.075);
    background: rgba(255,255,255,0.035);
    pointer-events: none;
}

body.m-mf-plus .m-reactor-module.active .m-reactor-body::after {
    content: "ON";
    color: #00151b;
    border-color: transparent;
    background: var(--border-color);
    box-shadow: 0 0 10px var(--glow-color, rgba(0,242,255,0.24));
}

body.m-mf-plus .m-reactor-top {
    align-items: flex-start;
    gap: 10px;
}

body.m-mf-plus .m-reactor-title {
    max-width: calc(100% - 54px);
    font-size: clamp(0.90rem, 4.05vw, 1.02rem);
    line-height: 1.05;
}

body.m-mf-plus .m-reactor-desc {
    max-width: calc(100% - 42px);
    margin-top: 2px;
    font-size: 0.64rem;
    color: rgba(224,247,250,0.60);
}

body.m-mf-plus .m-tag-row {
    margin-top: 6px;
    padding-right: 38px;
}

body.m-mf-plus .m-tech-tag {
    padding: 4px 8px;
    font-size: 0.50rem;
    background: rgba(255,255,255,0.04);
    box-shadow: inset 0 1px 0 rgba(255,255,255,0.04);
}

body.m-mf-plus .tag-noproxy { border-color: rgba(0,242,255,0.24); color: #97f7ff; }
body.m-mf-plus .tag-mfp { border-color: rgba(34,211,238,0.32); color: #9af6ff; }
body.m-mf-plus .tag-kraken { border-color: rgba(56, 189, 248,0.34); color: #ffc0ca; }

body.m-mf-plus .m-switch {
    width: 48px;
    height: 28px;
}

body.m-mf-plus .m-slider {
    border-radius: 999px;
    border-color: rgba(255,255,255,0.16);
    background:
        radial-gradient(circle at 20% 50%, rgba(255,255,255,0.10), transparent 42%),
        linear-gradient(180deg, rgba(31,35,42,0.98), rgba(12,13,16,0.98));
}

body.m-mf-plus .m-slider:before {
    width: 20px;
    height: 20px;
    left: 3px;
    bottom: 3px;
    background: linear-gradient(180deg, #f4f4f4, #b7b7b7);
}

body.m-mf-plus input:checked + .m-slider:before {
    transform: translateX(20px);
}

body.m-mf-plus .m-lang-grid,
body.m-mf-plus .m-flux-grid,
body.m-mf-plus .m-cortex-grid,
body.m-mf-plus .m-chip-grid,
body.m-mf-plus .m-cloud-mode-grid {
    gap: 9px;
}

body.m-mf-plus .m-lang-opt,
body.m-mf-plus .m-flux-opt,
body.m-mf-plus .m-cortex-chip,
body.m-mf-plus .m-qual-chip,
body.m-mf-plus .m-cloud-mode-btn {
    border-radius: 21px;
    min-height: 64px;
    background:
        radial-gradient(circle at 50% 0, rgba(0,242,255,0.085), transparent 54%),
        linear-gradient(180deg, rgba(16, 35, 55, 0.84), rgba(3, 10, 19, 0.97));
    border-color: rgba(134,232,255,0.14);
    box-shadow: var(--lc-card-shadow-soft), inset 0 1px 0 rgba(255,255,255,0.045);
}

body.m-mf-plus .m-lang-opt.active-ita,
body.m-mf-plus .m-lang-opt.active-hyb,
body.m-mf-plus .m-lang-opt.active-eng,
body.m-mf-plus .m-flux-opt.active-bal,
body.m-mf-plus .m-flux-opt.active-res,
body.m-mf-plus .m-flux-opt.active-sz,
body.m-mf-plus .m-cortex-chip.active,
body.m-mf-plus .m-cloud-mode-btn.active {
    transform: translateY(-1px);
    border-color: rgba(0,242,255,0.48);
    background:
        radial-gradient(circle at 50% 0, rgba(0,242,255,0.18), transparent 58%),
        linear-gradient(180deg, rgba(18, 48, 74, 0.96), rgba(3, 10, 19, 0.98));
}

body.m-mf-plus .m-qual-chip {
    min-height: 62px;
    padding: 9px 4px;
    font-size: 0.78rem;
}

body.m-mf-plus .m-qual-chip:not(.excluded) {
    color: #f7fdff;
}

body.m-mf-plus .m-qual-chip.excluded {
    opacity: 0.72;
    background:
        radial-gradient(circle at 50% 0, rgba(255,51,102,0.12), transparent 55%),
        linear-gradient(180deg, rgba(52, 16, 29, 0.74), rgba(14, 4, 9, 0.94));
    border-color: rgba(255,51,102,0.32);
}

body.m-mf-plus .m-flux-readout,
body.m-mf-plus #lang-desc-container,
body.m-mf-plus .m-sys-grid {
    border-radius: 24px !important;
    padding: 3px;
    background:
        radial-gradient(circle at 0 0, rgba(0,242,255,0.085), transparent 45%),
        linear-gradient(155deg, rgba(7, 19, 32, 0.78), rgba(2, 8, 16, 0.94)) !important;
    box-shadow: var(--lc-card-shadow-soft), inset 0 1px 0 rgba(255,255,255,0.035);
}

body.m-mf-plus .m-sys-grid {
    display: grid;
    gap: 8px;
    padding: 8px;
    border: 1px solid rgba(134,232,255,0.12);
}

body.m-mf-plus .m-sys-row,
body.m-mf-plus .m-row {
    border: 1px solid rgba(134,232,255,0.105) !important;
    border-radius: 21px;
    padding: 13px 14px !important;
    background:
        radial-gradient(circle at 0 0, rgba(0,242,255,0.075), transparent 42%),
        linear-gradient(145deg, rgba(10, 26, 43, 0.78), rgba(3, 10, 19, 0.92));
    box-shadow: inset 0 1px 0 rgba(255,255,255,0.035);
}

body.m-mf-plus .m-sys-info h4,
body.m-mf-plus .m-label h4 {
    gap: 7px;
    font-size: 0.92rem;
    letter-spacing: 0.15px;
}

body.m-mf-plus .m-sys-info p,
body.m-mf-plus .m-label p,
body.m-mf-plus .m-range-desc,
body.m-mf-plus .m-cloud-note {
    color: rgba(224,247,250,0.58) !important;
    line-height: 1.32;
}

body.m-mf-plus .m-status-text {
    border-radius: 999px;
    padding: 3px 8px;
    font-size: 0.60rem;
    letter-spacing: 0.7px;
    background: rgba(255,255,255,0.09);
    border: 1px solid rgba(255,255,255,0.08);
}

body.m-mf-plus .m-status-text.on {
    background: rgba(0, 255, 157, 0.16);
    border-color: rgba(0,255,157,0.28);
    color: var(--m-success);
}

body.m-mf-plus .m-cloud-mode-panel.show {
    margin: -3px 4px 10px;
    padding: 9px 8px 11px;
    border-radius: 22px;
    border: 1px solid rgba(134,232,255,0.10);
    background:
        radial-gradient(circle at 0 0, rgba(0,242,255,0.09), transparent 42%),
        linear-gradient(145deg, rgba(8, 22, 37, 0.74), rgba(2, 8, 16, 0.94));
}

body.m-mf-plus .m-cloud-mode-btn {
    min-height: 58px;
    font-size: 0.74rem;
}

body.m-mf-plus .m-cloud-mode-btn span {
    font-size: 0.55rem;
}

body.m-mf-plus .m-gate-wrapper.show {
    padding: 9px 10px 11px;
    border-radius: 20px;
    border: 1px solid rgba(134,232,255,0.10);
    background: rgba(2, 8, 16, 0.48);
}

body.m-mf-plus .m-gate-control {
    background: transparent;
}

body.m-mf-plus .m-visual-preview {
    border-radius: 22px;
    border-color: rgba(134,232,255,0.18);
    background:
        radial-gradient(circle at 0 0, rgba(0,242,255,0.10), transparent 45%),
        linear-gradient(145deg, rgba(9, 24, 39, 0.93), rgba(2, 8, 16, 0.98));
}

body.m-mf-plus .m-vp-icon {
    width: 50px;
    height: 70px;
    border-radius: 15px;
    background: linear-gradient(145deg, rgba(0,242,255,0.13), rgba(124, 58, 237,0.08), rgba(0,0,0,0.20));
    border-color: rgba(134,232,255,0.16);
}

body.m-mf-plus .m-am-card {
    border-radius: 28px;
    background:
        radial-gradient(circle at 0 0, rgba(0,242,255,0.12), transparent 42%),
        linear-gradient(155deg, rgba(9, 23, 38, 0.98), rgba(1, 5, 12, 0.99));
    border-color: rgba(134,232,255,0.18);
}

body.m-mf-plus .m-act-btn {
    border-radius: 19px;
}

body.m-mf-plus .m-act-copy {
    background: linear-gradient(135deg, #00f2ff, #22d3ee 42%, #8b5cf6 110%);
    color: #00151b;
    border: 1px solid rgba(255,255,255,0.25);
    box-shadow: 0 8px 18px rgba(0, 213, 255, 0.21);
}

body.m-mf-plus .m-toast {
    border-radius: 18px;
}

body.m-lowfx.m-mf-plus .m-hypervisor,
body.m-lowfx.m-mf-plus .m-reactor-module,
body.m-lowfx.m-mf-plus .m-cred-opt,
body.m-lowfx.m-mf-plus .m-sys-row,
body.m-lowfx.m-mf-plus .m-row,
body.m-keyboard-open.m-mf-plus .m-hypervisor,
body.m-keyboard-open.m-mf-plus .m-reactor-module,
body.m-keyboard-open.m-mf-plus .m-cred-opt {
    box-shadow: 0 5px 12px rgba(0,0,0,0.26) !important;
}

@media (max-width: 370px) {
    body.m-mf-plus .m-content { padding-left: 9px; padding-right: 9px; }
    body.m-mf-plus .m-hypervisor { padding: 11px; border-radius: 23px; }
    body.m-mf-plus .m-reactor-core { width: 48px; margin-left: 9px; }
    body.m-mf-plus .m-reactor-title { font-size: 0.88rem; }
    body.m-mf-plus .m-reactor-desc { font-size: 0.60rem; }
    body.m-mf-plus .m-cred-name { font-size: 0.56rem; }
}

@supports not (color: color-mix(in srgb, red, blue)) {
    body.m-mf-plus .m-reactor-module.active .m-reactor-core {
        background: rgba(0,242,255,0.10);
    }
}

body.m-mf-plus .m-switch {
    touch-action: manipulation;
    -webkit-tap-highlight-color: transparent;
    user-select: none;
    transform: translateZ(0);
}

body.m-mf-plus .m-switch input[type="checkbox"] {
    position: absolute !important;
    inset: 0 !important;
    width: 100% !important;
    height: 100% !important;
    margin: 0 !important;
    padding: 0 !important;
    opacity: 0 !important;
    appearance: none;
    -webkit-appearance: none;
    z-index: 4;
    cursor: pointer;
    touch-action: manipulation;
}

body.m-mf-plus .m-slider,
body.m-mf-plus .m-slider:before {
    will-change: transform;
}

body.m-mf-plus input[type="checkbox"]:focus,
body.m-mf-plus input[type="checkbox"]:active {
    outline: none !important;
    box-shadow: none !important;
}

body.m-ui-ready .m-page.active,
body.m-switching .m-page.active {
    animation: none !important;
    opacity: 1 !important;
    transform: translate3d(0, 0, 0) !important;
}

body.m-ui-ready .m-cloud-mode-panel.show,
body.m-switching .m-cloud-mode-panel.show {
    animation: none !important;
}

body.m-switching .m-content {
    scroll-behavior: auto !important;
}

body.m-switching .m-caustic-ray,
body.m-switching .m-ocean-particle,
body.m-switching .logo-particle,
body.m-switching .logo-container,
body.m-switching .logo-image,
body.m-switching .m-version-tag,
body.m-switching .m-hypervisor::before,
body.m-switching .m-visual-core-v2::before,
body.m-switching .m-v-dot,
body.m-switching .m-ptr.loading .m-ptr-icon {
    animation-play-state: paused !important;
}

body.m-switching .m-reactor-module,
body.m-switching .m-reactor-module::after,
body.m-switching .m-reactor-core,
body.m-switching .m-sys-row,
body.m-switching .m-slider,
body.m-switching .m-slider:before,
body.m-switching .m-cloud-mode-btn,
body.m-switching .m-flux-opt,
body.m-switching .m-lang-opt,
body.m-switching .m-cortex-chip,
body.m-switching .m-cred-opt {
    transition-duration: 0.12s !important;
}

body.m-mf-plus .m-page.active,
body.m-mf-plus .m-switch,
body.m-mf-plus .m-slider,
body.m-mf-plus .m-slider:before {
    backface-visibility: hidden;
    -webkit-backface-visibility: hidden;
    transform: translateZ(0);
}

body.m-mf-plus .m-page.active,
body.m-mf-plus .m-switch,
body.m-mf-plus .m-slider {
    contain: paint;
}

body.m-mf-plus input[type="checkbox"],
body.m-mf-plus input[type="radio"],
body.m-mf-plus input[type="range"] {
    touch-action: manipulation;
}



/* Modern SaaS Landing Page / Developer Tool Dashboard refresh */
:root {
    --m-bg: #050816;
    --m-bg-deep: #020617;
    --m-primary: #67e8f9;
    --m-primary-dim: rgba(103, 232, 249, 0.18);
    --m-secondary: #a78bfa;
    --m-accent: #f0abfc;
    --m-amber: #fde68a;
    --m-orange: #fb923c;
    --m-cine: #fb7185;
    --m-kofi: #fb7185;
    --m-surface: rgba(255, 255, 255, 0.105);
    --m-surface-2: rgba(15, 23, 42, 0.64);
    --m-text: #f8fafc;
    --m-dim: rgba(226, 232, 240, 0.72);
    --m-faint: rgba(226, 232, 240, 0.42);
    --m-error: #fb7185;
    --m-success: #86efac;
    --m-glow: 0 18px 70px rgba(99, 102, 241, 0.24);
    --m-glow-strong: 0 22px 92px rgba(34, 211, 238, 0.28);
    --m-radius-lg: 28px;
    --m-radius-md: 18px;
    --m-radius-sm: 12px;
}

body {
    background:
        radial-gradient(circle at 9% 22%, rgba(34, 211, 238, 0.34) 0, transparent 28%),
        radial-gradient(circle at 92% 9%, rgba(168, 85, 247, 0.42) 0, transparent 31%),
        radial-gradient(circle at 86% 72%, rgba(56, 189, 248, 0.34) 0, transparent 35%),
        radial-gradient(circle at 12% 88%, rgba(217, 70, 239, 0.28) 0, transparent 30%),
        linear-gradient(135deg, #020617 0%, #0f172a 38%, #1e1b4b 68%, #082f49 100%);
    color: var(--m-text);
}

body::after {
    opacity: 0.035;
    background:
        linear-gradient(rgba(255, 255, 255, 0) 50%, rgba(255, 255, 255, 0.045) 50%),
        linear-gradient(90deg, rgba(99, 102, 241, 0.035), rgba(34, 211, 238, 0.025), rgba(217, 70, 239, 0.035));
}

body::before {
    opacity: 0.55;
    background-image:
        linear-gradient(rgba(255, 255, 255, 0.055) 1px, transparent 1px),
        linear-gradient(90deg, rgba(255, 255, 255, 0.055) 1px, transparent 1px);
    background-size: 52px 52px;
    mask-image: radial-gradient(ellipse at 50% 0%, black 0%, rgba(0,0,0,0.55) 45%, transparent 85%);
    -webkit-mask-image: radial-gradient(ellipse at 50% 0%, black 0%, rgba(0,0,0,0.55) 45%, transparent 85%);
}

.m-caustic,
.m-ocean-particles,
.logo-particles {
    opacity: 0.26;
    filter: hue-rotate(42deg) saturate(0.85);
}

.m-content {
    padding: 12px 14px calc(226px + var(--safe-bottom)) 14px;
}

.m-saas-hero {
    text-align: left;
    align-items: stretch;
    padding: 14px 4px 18px;
    gap: 14px;
}

.m-saas-hero::before {
    top: 26px;
    width: min(520px, 96vw);
    height: 360px;
    background:
        radial-gradient(circle at 32% 24%, rgba(103, 232, 249, 0.26) 0%, transparent 42%),
        radial-gradient(circle at 78% 34%, rgba(125, 211, 252, 0.24) 0%, transparent 48%),
        radial-gradient(circle at 50% 92%, rgba(167, 139, 250, 0.20) 0%, transparent 54%);
    filter: blur(26px);
}

.m-saas-hero::after {
    bottom: -5px;
    width: 94%;
    opacity: 0.52;
    background: linear-gradient(90deg, transparent, rgba(103, 232, 249, 0.65), rgba(125, 211, 252, 0.55), transparent);
}

.m-saas-topbar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    padding: 10px;
    border: 1px solid rgba(255,255,255,0.15);
    border-radius: 22px;
    background: linear-gradient(135deg, rgba(255,255,255,0.13), rgba(255,255,255,0.055));
    box-shadow: 0 14px 45px rgba(15, 23, 42, 0.28), inset 0 1px 0 rgba(255,255,255,0.16);
    backdrop-filter: blur(22px);
    -webkit-backdrop-filter: blur(22px);
}

.m-saas-brand {
    display: inline-flex;
    align-items: center;
    gap: 10px;
    min-width: 0;
}

.m-saas-logo-wrap {
    width: 42px;
    height: 42px;
    border-radius: 15px;
    display: grid;
    place-items: center;
    overflow: hidden;
    background: linear-gradient(135deg, rgba(103,232,249,0.22), rgba(167,139,250,0.24), rgba(125, 211, 252,0.18));
    border: 1px solid rgba(255,255,255,0.22);
    box-shadow: 0 10px 28px rgba(34, 211, 238, 0.18);
}

.logo-image.m-saas-logo {
    width: 37px;
    max-width: 37px;
    height: 37px;
    object-fit: contain;
    opacity: 1;
    transform: none;
    animation: none;
    filter: drop-shadow(0 8px 16px rgba(0,0,0,0.28));
}

.m-saas-brand-name {
    font-family: 'Rajdhani', sans-serif;
    font-weight: 900;
    color: #fff;
    letter-spacing: 0.6px;
    font-size: 0.98rem;
    line-height: 1;
}

.m-saas-brand-sub {
    font-family: 'Outfit', sans-serif;
    color: rgba(226, 232, 240, 0.62);
    font-size: 0.62rem;
    line-height: 1.1;
    margin-top: 3px;
}

.m-saas-nav-pill {
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 4px;
    border-radius: 999px;
    background: rgba(2, 6, 23, 0.28);
    border: 1px solid rgba(255,255,255,0.12);
    color: rgba(255,255,255,0.74);
    font-family: 'Rajdhani', sans-serif;
    font-size: 0.58rem;
    font-weight: 900;
    letter-spacing: 0.7px;
    text-transform: uppercase;
    white-space: nowrap;
}

.m-saas-nav-pill span {
    padding: 6px 8px;
    border-radius: 999px;
}

.m-saas-nav-pill span:first-child {
    color: #fff;
    background: rgba(255,255,255,0.13);
    box-shadow: inset 0 1px 0 rgba(255,255,255,0.12);
}

.m-saas-hero-grid {
    display: grid;
    grid-template-columns: 1fr;
    gap: 14px;
    position: relative;
    z-index: 2;
}

.m-saas-copy {
    padding: 12px 4px 0;
}

.m-saas-badge {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    width: max-content;
    max-width: 100%;
    padding: 7px 10px;
    border-radius: 999px;
    color: rgba(245, 243, 255, 0.92);
    background: linear-gradient(135deg, rgba(99,102,241,0.24), rgba(34,211,238,0.12));
    border: 1px solid rgba(255,255,255,0.16);
    font-family: 'Rajdhani', sans-serif;
    font-size: 0.68rem;
    font-weight: 900;
    letter-spacing: 0.85px;
    text-transform: uppercase;
    box-shadow: 0 10px 34px rgba(99, 102, 241, 0.18);
}

.m-saas-badge-dot {
    width: 7px;
    height: 7px;
    border-radius: 999px;
    background: var(--m-success);
    box-shadow: 0 0 0 4px rgba(134,239,172,0.12), 0 0 14px rgba(134,239,172,0.7);
    flex: 0 0 auto;
}

.m-saas-hero .m-brand-title {
    margin: 12px 0 0;
    font-size: clamp(2.55rem, 14vw, 4.3rem);
    line-height: 0.88;
    letter-spacing: -1.8px;
    background: linear-gradient(180deg, #fff 0%, #e0f2fe 28%, #bfdbfe 50%, #c4b5fd 76%, #f0abfc 100%);
    -webkit-background-clip: text;
    -webkit-text-fill-color: transparent;
    filter: drop-shadow(0 18px 38px rgba(15, 23, 42, 0.32));
    animation: none;
}

.m-saas-hero .m-brand-title span {
    background: linear-gradient(90deg, #f0abfc 0%, #93c5fd 42%, #67e8f9 100%);
    -webkit-background-clip: text;
    -webkit-text-fill-color: transparent;
}

.m-saas-hero .m-brand-desc {
    max-width: 340px;
    color: rgba(248,250,252,0.76);
    font-size: 0.86rem;
    line-height: 1.42;
    margin: 12px 0 0;
}

.m-saas-actions {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 10px;
    margin-top: 16px;
}

.m-saas-primary,
.m-saas-secondary {
    min-height: 46px;
    border: 0;
    border-radius: 15px;
    color: #fff;
    font-family: 'Rajdhani', sans-serif;
    font-size: 0.78rem;
    font-weight: 900;
    letter-spacing: 0.55px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 8px;
    cursor: pointer;
    touch-action: manipulation;
    -webkit-tap-highlight-color: transparent;
}

.m-saas-primary {
    background: linear-gradient(135deg, #f472b6 0%, #8b5cf6 48%, #22d3ee 100%);
    box-shadow: 0 14px 32px rgba(139, 92, 246, 0.30), inset 0 1px 0 rgba(255,255,255,0.24);
}

.m-saas-secondary {
    background: rgba(255,255,255,0.08);
    border: 1px solid rgba(255,255,255,0.18);
    box-shadow: inset 0 1px 0 rgba(255,255,255,0.12);
    backdrop-filter: blur(16px);
    -webkit-backdrop-filter: blur(16px);
}

.m-saas-primary:active,
.m-saas-secondary:active {
    transform: scale(0.97);
}

.m-saas-code-card {
    border-radius: 24px;
    padding: 14px;
    border: 1px solid rgba(255,255,255,0.17);
    background:
        linear-gradient(135deg, rgba(255,255,255,0.16), rgba(255,255,255,0.055)),
        radial-gradient(circle at 100% 0%, rgba(125, 211, 252, 0.25), transparent 46%),
        radial-gradient(circle at 0% 100%, rgba(34, 211, 238, 0.16), transparent 46%);
    box-shadow: 0 20px 70px rgba(15, 23, 42, 0.34), inset 0 1px 0 rgba(255,255,255,0.16);
    backdrop-filter: blur(24px);
    -webkit-backdrop-filter: blur(24px);
    overflow: hidden;
}

.m-saas-code-tabs {
    display: flex;
    gap: 8px;
    border-bottom: 1px solid rgba(255,255,255,0.12);
    padding-bottom: 9px;
    color: rgba(226,232,240,0.74);
    font-family: 'Rajdhani', sans-serif;
    font-size: 0.72rem;
    font-weight: 900;
}

.m-saas-code-tabs span {
    padding: 4px 8px;
    border-radius: 999px;
}

.m-saas-code-tabs .active {
    color: #fff;
    background: rgba(255,255,255,0.13);
    box-shadow: inset 0 1px 0 rgba(255,255,255,0.13);
}

.m-saas-code-card pre {
    margin: 12px 0 0;
    color: rgba(240, 249, 255, 0.86);
    font-family: 'Roboto Mono', monospace;
    font-size: clamp(0.62rem, 2.8vw, 0.76rem);
    line-height: 1.62;
    white-space: pre-wrap;
    user-select: text;
}

.m-saas-code-card code {
    user-select: text;
}

.m-saas-code-status {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    padding-top: 12px;
    margin-top: 12px;
    border-top: 1px solid rgba(255,255,255,0.10);
    color: rgba(248,250,252,0.76);
    font-family: 'Rajdhani', sans-serif;
    font-size: 0.72rem;
    font-weight: 900;
}

.m-saas-code-status span {
    display: inline-flex;
    align-items: center;
    gap: 7px;
}

.m-saas-code-status i {
    width: 8px;
    height: 8px;
    border-radius: 999px;
    background: var(--m-success);
    box-shadow: 0 0 12px rgba(134,239,172,0.75);
}

.m-saas-metrics {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 8px;
    position: relative;
    z-index: 2;
}

.m-saas-metric {
    min-width: 0;
    padding: 11px 9px;
    border-radius: 18px;
    background: linear-gradient(135deg, rgba(255,255,255,0.13), rgba(255,255,255,0.055));
    border: 1px solid rgba(255,255,255,0.14);
    box-shadow: 0 12px 35px rgba(15,23,42,0.22), inset 0 1px 0 rgba(255,255,255,0.13);
    backdrop-filter: blur(18px);
    -webkit-backdrop-filter: blur(18px);
}

.m-saas-metric span,
.m-saas-metric small {
    display: block;
    color: rgba(226,232,240,0.62);
    font-family: 'Outfit', sans-serif;
    font-size: 0.58rem;
    line-height: 1.1;
}

.m-saas-metric strong {
    display: block;
    margin: 4px 0;
    color: #fff;
    font-family: 'Rajdhani', sans-serif;
    font-weight: 900;
    font-size: 0.94rem;
    letter-spacing: 0.3px;
    white-space: nowrap;
}

.m-section-head {
    padding: 10px 12px;
    border: 1px solid rgba(255,255,255,0.13);
    border-left: 1px solid rgba(255,255,255,0.13);
    border-radius: 18px;
    background: linear-gradient(135deg, rgba(255,255,255,0.10), rgba(255,255,255,0.045));
    box-shadow: 0 12px 42px rgba(15, 23, 42, 0.18), inset 0 1px 0 rgba(255,255,255,0.10);
    backdrop-filter: blur(18px);
    -webkit-backdrop-filter: blur(18px);
}

.m-section-head .sh-title {
    letter-spacing: 1.4px;
    color: #fff;
    text-shadow: none;
}

.m-section-head .sh-sub {
    color: rgba(226,232,240,0.58);
}

.m-section-head .sh-tag {
    color: #fff;
    border-color: rgba(255,255,255,0.16);
    background: rgba(255,255,255,0.08);
}

.m-hypervisor,
.m-visual-core-v2,
.m-flux-readout,
.m-reactor-module,
.m-sys-grid,
.m-visual-preview,
.m-input-fuselage,
.m-cred-opt,
.m-flux-opt,
.m-lang-opt,
.m-qual-chip,
.m-cloud-mode-panel,
.m-cloud-mode-btn,
.m-sc-subpanel,
.m-link-card,
.m-summary-card,
.m-output-card {
    background:
        linear-gradient(135deg, rgba(255,255,255,0.118), rgba(255,255,255,0.045)) !important;
    border-color: rgba(255,255,255,0.14) !important;
    box-shadow: 0 18px 55px rgba(15, 23, 42, 0.24), inset 0 1px 0 rgba(255,255,255,0.12) !important;
    backdrop-filter: blur(22px);
    -webkit-backdrop-filter: blur(22px);
}

.m-hypervisor::before,
.m-visual-core-v2::before {
    background: linear-gradient(90deg, transparent, rgba(103,232,249,0.86), rgba(125, 211, 252,0.78), transparent);
    opacity: 0.88;
}

.m-hypervisor::after {
    opacity: 0.28;
    background-size: 32px 32px;
}

.m-hyp-header {
    border-bottom-color: rgba(255,255,255,0.12);
    color: #fff;
    letter-spacing: 1.7px;
    text-shadow: none;
}

.m-hyp-icon {
    color: #fff;
    background: linear-gradient(135deg, rgba(103,232,249,0.16), rgba(125, 211, 252,0.14));
    border-color: rgba(255,255,255,0.16);
    filter: none;
}

.m-cred-opt,
.m-flux-opt,
.m-lang-opt,
.m-qual-chip,
.m-cloud-mode-btn,
.m-reactor-module {
    border-radius: 16px;
}

.m-cred-opt::before {
    background: linear-gradient(90deg, transparent, rgba(255,255,255,0.85), transparent);
}

.m-cred-opt.active,
.m-flux-opt.active-bal,
.m-flux-opt.active-res,
.m-flux-opt.active-sz,
.m-lang-opt.active-ita,
.m-lang-opt.active-hyb,
.m-lang-opt.active-eng,
.m-cloud-mode-btn.active,
.m-cortex-chip.active {
    background:
        linear-gradient(135deg, rgba(103,232,249,0.20), rgba(167,139,250,0.18), rgba(125, 211, 252,0.13)) !important;
    border-color: rgba(255,255,255,0.28) !important;
    box-shadow: 0 18px 46px rgba(99, 102, 241, 0.24), inset 0 1px 0 rgba(255,255,255,0.22) !important;
}

.m-input-fuselage {
    padding: 1px;
}

.m-input-fuselage:focus-within,
.m-input-fuselage.is-valid,
.m-input-fuselage.is-checking {
    border-color: rgba(103,232,249,0.48) !important;
    box-shadow: 0 0 0 1px rgba(103,232,249,0.14), 0 18px 58px rgba(34,211,238,0.18), inset 0 1px 0 rgba(255,255,255,0.12) !important;
}

.m-input-fuselage.is-invalid {
    border-color: rgba(251,113,133,0.48) !important;
    box-shadow: 0 18px 58px rgba(251,113,133,0.13), inset 0 1px 0 rgba(255,255,255,0.12) !important;
}

.m-if-inner {
    background: rgba(2, 6, 23, 0.32);
    border-radius: 15px;
}

.m-if-field {
    color: #fff;
    user-select: text;
}

.m-if-field::placeholder {
    color: rgba(226,232,240,0.36);
}

.m-if-label {
    background: linear-gradient(135deg, rgba(15,23,42,0.96), rgba(30,41,59,0.88));
    color: rgba(248,250,252,0.76);
    border-color: rgba(255,255,255,0.14);
}

.m-get-link {
    color: #fff;
    border-color: rgba(255,255,255,0.16);
    background: linear-gradient(135deg, rgba(103,232,249,0.13), rgba(125, 211, 252,0.10));
}

.m-key-status {
    color: rgba(226,232,240,0.68);
}

.m-reactor-core {
    background: rgba(2, 6, 23, 0.24);
    border-right-color: rgba(255,255,255,0.10);
}

.m-reactor-body {
    background: linear-gradient(90deg, rgba(255,255,255,0.035), transparent);
}

.m-reactor-desc,
.m-hyp-desc,
.m-sys-info p,
.m-fr-desc,
.m-vp-sub {
    color: rgba(226,232,240,0.62);
}

.m-bottom-nav {
    background:
        linear-gradient(135deg, rgba(15,23,42,0.76), rgba(30,41,59,0.56)),
        radial-gradient(circle at 50% 0%, rgba(103,232,249,0.14), transparent 56%);
    border-top: 1px solid rgba(255,255,255,0.14);
    box-shadow: 0 -18px 60px rgba(15,23,42,0.36), inset 0 1px 0 rgba(255,255,255,0.08);
    backdrop-filter: blur(26px);
    -webkit-backdrop-filter: blur(26px);
}

.m-nav-item.active {
    color: #fff;
    background: linear-gradient(135deg, rgba(103,232,249,0.18), rgba(167,139,250,0.16), rgba(125, 211, 252,0.12));
    box-shadow: inset 0 1px 0 rgba(255,255,255,0.12), 0 10px 28px rgba(99,102,241,0.16);
}

.m-toast {
    background: rgba(15, 23, 42, 0.84);
    border-color: rgba(255,255,255,0.16);
    box-shadow: 0 18px 55px rgba(15,23,42,0.38), inset 0 1px 0 rgba(255,255,255,0.12);
    backdrop-filter: blur(24px);
    -webkit-backdrop-filter: blur(24px);
}

@media (min-width: 620px) {
    .m-saas-hero-grid {
        grid-template-columns: minmax(0, 1fr) minmax(280px, 0.82fr);
        align-items: stretch;
    }

    .m-saas-code-card {
        align-self: end;
    }
}

@media (max-width: 370px) {
    .m-saas-nav-pill span {
        padding: 6px 6px;
    }

    .m-saas-actions {
        grid-template-columns: 1fr;
    }

    .m-saas-metrics {
        grid-template-columns: 1fr;
    }
}

body.m-lowfx .m-saas-code-card,
body.m-lowfx .m-saas-topbar,
body.m-lowfx .m-saas-metric,
body.m-lowfx .m-hypervisor,
body.m-lowfx .m-visual-core-v2 {
    backdrop-filter: none;
    -webkit-backdrop-filter: none;
}



/* Leviathan abyss sovereign refinement: cyan/deep-blue accents, logo hero with sovereign subtitle. */
.m-abyss-hero {
    padding: 24px 10px 18px;
    min-height: auto;
    gap: 8px;
}
.m-abyss-hero::before {
    top: 8px;
    width: min(340px, 92vw);
    height: 260px;
    background:
        radial-gradient(circle at 50% 32%, rgba(34, 211, 238, 0.24) 0%, rgba(14, 165, 233, 0.12) 36%, transparent 70%),
        radial-gradient(circle at 50% 64%, rgba(59, 130, 246, 0.16) 0%, rgba(15, 23, 42, 0.06) 55%, transparent 78%);
    filter: blur(24px);
}
.m-abyss-hero::after {
    width: 62%;
    background: linear-gradient(90deg, transparent, rgba(34, 211, 238, 0.58), rgba(96, 165, 250, 0.42), transparent);
    opacity: 0.72;
}
.m-abyss-logo {
    width: 150px;
    height: 150px;
    margin-bottom: 10px;
    filter: drop-shadow(0 0 22px rgba(34, 211, 238, 0.20));
}
.m-abyss-logo::before {
    border-color: rgba(34, 211, 238, 0.80);
    background:
        radial-gradient(circle at 50% 34%, rgba(10, 44, 64, 0.98) 0%, rgba(4, 16, 29, 0.99) 58%, rgba(0, 3, 10, 1) 100%);
    box-shadow:
        0 0 0 1px rgba(255,255,255,0.045),
        0 0 22px rgba(34, 211, 238, 0.26),
        0 0 46px rgba(14, 165, 233, 0.14),
        inset 0 0 22px rgba(59, 130, 246, 0.12);
}
.m-abyss-logo::after {
    background: radial-gradient(circle, rgba(34, 211, 238, 0.15) 0%, rgba(14, 165, 233, 0.07) 44%, rgba(59, 130, 246, 0.05) 62%, transparent 80%);
}
.m-abyss-logo .logo-image {
    filter:
        hue-rotate(155deg)
        saturate(1.18)
        brightness(1.04)
        contrast(1.05)
        drop-shadow(0 12px 18px rgba(0, 0, 0, 0.48))
        drop-shadow(0 0 12px rgba(34, 211, 238, 0.22));
}
.m-abyss-crown {
    position: absolute;
    inset: 8px;
    border-radius: 50%;
    pointer-events: none;
    z-index: 1;
    background:
        conic-gradient(from 210deg,
            transparent 0 16%,
            rgba(34,211,238,0.34) 17% 19%,
            transparent 20% 42%,
            rgba(96,165,250,0.22) 43% 45%,
            transparent 46% 72%,
            rgba(34,211,238,0.30) 73% 75%,
            transparent 76% 100%);
    opacity: 0.72;
    mask-image: radial-gradient(circle, transparent 0 54%, black 55% 63%, transparent 64%);
    -webkit-mask-image: radial-gradient(circle, transparent 0 54%, black 55% 63%, transparent 64%);
}
.m-abyss-title {
    position: relative;
    display: inline-block;
    font-family: 'Rajdhani', sans-serif;
    font-size: clamp(2.78rem, 15.4vw, 3.88rem);
    font-weight: 900;
    line-height: 0.84;
    margin-top: 0;
    letter-spacing: -0.035em;
    background:
        linear-gradient(180deg, #ffffff 0%, #e9feff 18%, #8ff7ff 43%, #38bdf8 68%, #2563eb 100%);
    -webkit-background-clip: text;
    -webkit-text-fill-color: transparent;
    -webkit-text-stroke: 0.45px rgba(226, 252, 255, 0.20);
    text-shadow:
        0 2px 0 rgba(255,255,255,0.06),
        0 0 16px rgba(34, 211, 238, 0.34),
        0 0 34px rgba(37, 99, 235, 0.18);
    filter:
        drop-shadow(0 12px 22px rgba(0, 0, 0, 0.42))
        drop-shadow(0 0 18px rgba(34, 211, 238, 0.24));
    isolation: isolate;
}
.m-abyss-title::before {
    content: "Leviathan";
    position: absolute;
    inset: 0;
    z-index: -1;
    color: transparent;
    -webkit-text-stroke: 1.5px rgba(34, 211, 238, 0.16);
    filter: blur(5px);
    transform: translateY(2px) scale(1.012);
    opacity: 0.88;
    pointer-events: none;
}
.m-abyss-title::after {
    content: "";
    position: absolute;
    left: 8%;
    right: 8%;
    bottom: -7px;
    height: 2px;
    border-radius: 999px;
    background: linear-gradient(90deg, transparent, rgba(103, 232, 249, 0.74), rgba(96, 165, 250, 0.58), transparent);
    box-shadow: 0 0 14px rgba(34, 211, 238, 0.42);
    opacity: 0.72;
    pointer-events: none;
}
.m-abyss-sub {
    margin-top: 7px;
    font-family: 'Rajdhani', sans-serif;
    font-size: clamp(0.72rem, 3.3vw, 0.92rem);
    font-weight: 900;
    letter-spacing: 3.7px;
    text-transform: uppercase;
    color: #a5f3fc;
    opacity: 0.96;
    text-shadow:
        0 0 10px rgba(34, 211, 238, 0.55),
        0 0 24px rgba(59, 130, 246, 0.28);
}
.m-abyss-sub::before,
.m-abyss-sub::after {
    background: linear-gradient(90deg, transparent, rgba(34, 211, 238, 0.70));
    box-shadow: 0 0 10px rgba(34, 211, 238, 0.45);
}
.m-abyss-sub::after {
    background: linear-gradient(90deg, rgba(34, 211, 238, 0.70), transparent);
}

.m-abyss-version {
    margin-top: 12px;
    padding: 5px 13px 5px 11px;
    border-radius: 999px;
    border: 1px solid rgba(103, 232, 249, 0.30);
    background:
        linear-gradient(135deg, rgba(8, 47, 73, 0.44), rgba(15, 23, 42, 0.34)),
        radial-gradient(circle at 20% 50%, rgba(34, 211, 238, 0.16), transparent 56%);
    color: #dffcff;
    font-family: 'Rajdhani', monospace;
    font-size: 0.64rem;
    font-weight: 900;
    letter-spacing: 2.2px;
    text-transform: uppercase;
    box-shadow:
        0 0 18px rgba(34, 211, 238, 0.14),
        inset 0 0 12px rgba(103, 232, 249, 0.055),
        inset 0 1px 0 rgba(255,255,255,0.10);
    backdrop-filter: blur(16px);
    -webkit-backdrop-filter: blur(16px);
}
.m-abyss-version::before {
    background: linear-gradient(90deg, transparent, rgba(103, 232, 249, 0.38), transparent);
}
.m-abyss-version .m-v-dot {
    width: 6px;
    height: 6px;
    background: #67e8f9;
    box-shadow:
        0 0 8px rgba(103, 232, 249, 0.85),
        0 0 16px rgba(59, 130, 246, 0.38);
}
.m-leviathan-rune,
#msk_leviathan .m-chip-icon,
#m-prev-icon[data-skin="leviathan"] {
    color: #67e8f9 !important;
    text-shadow: 0 0 12px rgba(34, 211, 238, 0.55), 0 0 22px rgba(59, 130, 246, 0.30) !important;
    filter: none !important;
}
#msk_leviathan.active {
    border-color: rgba(34, 211, 238, 0.72) !important;
    background:
        radial-gradient(circle at 50% 0%, rgba(34, 211, 238, 0.20), transparent 62%),
        linear-gradient(180deg, rgba(8, 26, 42, 0.94), rgba(2, 8, 18, 0.98)) !important;
    box-shadow: 0 0 22px rgba(34, 211, 238, 0.26), inset 0 0 14px rgba(34, 211, 238, 0.08) !important;
}

/* Leviathan premium mobile overrides: brand lock, lightweight sea background, logo/title boost, dock nav upgrade. */
.notranslate,
[translate="no"],
[data-no-translate="true"] {
    unicode-bidi: isolate;
}

body {
    background:
        radial-gradient(ellipse at 50% -8%, rgba(93, 244, 255, 0.30) 0%, rgba(0, 160, 220, 0.13) 25%, transparent 52%),
        radial-gradient(ellipse at 50% 112%, rgba(0, 94, 150, 0.42) 0%, rgba(0, 35, 70, 0.22) 42%, transparent 72%),
        radial-gradient(circle at 12% 72%, rgba(0, 190, 255, 0.12) 0%, transparent 34%),
        radial-gradient(circle at 88% 66%, rgba(112, 0, 255, 0.13) 0%, transparent 38%),
        linear-gradient(180deg, #041b2a 0%, #021223 34%, #010914 68%, #000307 100%);
}

body.m-mf-plus {
    background:
        radial-gradient(ellipse at 50% -12%, rgba(34, 211, 238, 0.22) 0%, rgba(14, 165, 233, 0.08) 34%, transparent 64%),
        radial-gradient(circle at 12% 78%, rgba(56, 189, 248, 0.13) 0%, transparent 34%),
        radial-gradient(circle at 88% 72%, rgba(124, 58, 237, 0.11) 0%, transparent 34%),
        linear-gradient(180deg, #02101f 0%, #010813 46%, #000205 100%);
}

body::after {
    background:
        radial-gradient(ellipse at 50% 10%, rgba(185, 255, 255, 0.10) 0%, transparent 38%),
        linear-gradient(180deg, rgba(0, 172, 230, 0.08) 0%, transparent 38%, rgba(0, 0, 0, 0.22) 100%),
        repeating-linear-gradient(180deg, rgba(255, 255, 255, 0.012) 0 1px, transparent 1px 8px);
    background-size: auto;
    opacity: 0.45;
    mix-blend-mode: screen;
}

body::before {
    background-image:
        radial-gradient(ellipse at 50% 105%, rgba(0, 155, 220, 0.18) 0%, transparent 58%),
        linear-gradient(14deg, transparent 0 58%, rgba(0, 242, 255, 0.055) 60%, transparent 66%),
        linear-gradient(-12deg, transparent 0 46%, rgba(56, 189, 248, 0.045) 48%, transparent 56%),
        radial-gradient(circle at 18% 82%, rgba(34, 211, 238, 0.10) 0%, transparent 30%);
    background-size: 100% 100%, 280px 120px, 320px 140px, 100% 100%;
    opacity: 0.72;
    animation: none;
    mask-image: linear-gradient(180deg, rgba(0,0,0,0.9) 0%, rgba(0,0,0,0.75) 58%, rgba(0,0,0,0.95) 100%);
    -webkit-mask-image: linear-gradient(180deg, rgba(0,0,0,0.9) 0%, rgba(0,0,0,0.75) 58%, rgba(0,0,0,0.95) 100%);
}

#app-container::before {
    content: "";
    position: fixed;
    inset: 0;
    pointer-events: none;
    z-index: 0;
    background:
        radial-gradient(ellipse at 50% 14%, rgba(34, 211, 238, 0.13), transparent 42%),
        radial-gradient(ellipse at 50% 112%, rgba(2, 132, 199, 0.18), transparent 48%),
        linear-gradient(180deg, rgba(255,255,255,0.018), transparent 18%, rgba(0,0,0,0.12) 100%);
    opacity: 0.86;
}

#app-container::after {
    content: "";
    position: fixed;
    inset: 0;
    pointer-events: none;
    z-index: 0;
    background-image:
        linear-gradient(rgba(34, 211, 238, 0.07) 1px, transparent 1px),
        linear-gradient(90deg, rgba(34, 211, 238, 0.05) 1px, transparent 1px);
    background-size: 64px 64px;
    opacity: 0.10;
    mask-image: radial-gradient(ellipse at 50% 28%, black 0%, rgba(0,0,0,0.42) 54%, transparent 88%);
    -webkit-mask-image: radial-gradient(ellipse at 50% 28%, black 0%, rgba(0,0,0,0.42) 54%, transparent 88%);
}

body.m-lowfx #app-container::before {
    opacity: 0.55;
}

body.m-lowfx #app-container::after {
    display: none;
}

.m-abyss-logo {
    filter:
        drop-shadow(0 0 24px rgba(34, 211, 238, 0.30))
        drop-shadow(0 0 46px rgba(59, 130, 246, 0.18));
}

.m-abyss-logo::before {
    box-shadow:
        0 0 0 1px rgba(255,255,255,0.08),
        0 0 26px rgba(34, 211, 238, 0.36),
        0 0 58px rgba(14, 165, 233, 0.18),
        0 18px 44px rgba(2, 8, 23, 0.42),
        inset 0 0 24px rgba(59, 130, 246, 0.16),
        inset 0 0 42px rgba(34, 211, 238, 0.06);
}

.m-abyss-logo::after {
    background: radial-gradient(circle, rgba(34, 211, 238, 0.24) 0%, rgba(14, 165, 233, 0.10) 42%, rgba(59, 130, 246, 0.07) 62%, transparent 82%);
}

.m-abyss-logo .logo-image {
    filter:
        saturate(1.24)
        brightness(1.08)
        contrast(1.08)
        drop-shadow(0 13px 20px rgba(0, 0, 0, 0.52))
        drop-shadow(0 0 14px rgba(34, 211, 238, 0.30))
        drop-shadow(0 0 26px rgba(96, 165, 250, 0.16));
}

.m-abyss-logo .logo-particles::before {
    background:
        conic-gradient(from 0deg,
            transparent 0 12%,
            rgba(236,254,255,0.26) 13% 14%,
            rgba(34,211,238,0.46) 16% 19%,
            transparent 20% 38%,
            rgba(96,165,250,0.30) 40% 44%,
            transparent 45% 69%,
            rgba(34,211,238,0.42) 71% 75%,
            rgba(236,254,255,0.18) 76% 77%,
            transparent 78% 100%);
    opacity: 0.88;
}

.m-abyss-title {
    font-size: clamp(2.34rem, 12.6vw, 3.42rem);
    letter-spacing: 0.052em;
    text-transform: uppercase;
    background:
        linear-gradient(180deg, #ffffff 0%, #ecfeff 16%, #9ffbff 36%, #22d3ee 58%, #60a5fa 78%, #a78bfa 100%);
    -webkit-background-clip: text;
    -webkit-text-fill-color: transparent;
    -webkit-text-stroke: 0.55px rgba(236, 254, 255, 0.28);
    text-shadow:
        0 2px 0 rgba(255,255,255,0.08),
        0 0 18px rgba(34, 211, 238, 0.44),
        0 0 40px rgba(37, 99, 235, 0.22);
    filter:
        drop-shadow(0 13px 24px rgba(0, 0, 0, 0.46))
        drop-shadow(0 0 20px rgba(34, 211, 238, 0.30))
        drop-shadow(0 0 36px rgba(96, 165, 250, 0.16));
}

.m-abyss-title::before {
    content: "LEVIATHAN";
}

/* Dock nav upgrade: prettier Setup / Filtri / Net buttons with stronger selected states. */
.m-dock-nav {
    gap: 8px;
    padding: 10px 10px 4px;
}

.m-nav-item {
    width: calc(33.333% - 6px);
    max-width: 106px;
    min-height: 58px;
    gap: 5px;
    padding: 8px 6px 9px;
    border-radius: 18px;
    border: 1px solid rgba(255,255,255,0.08);
    background:
        linear-gradient(180deg, rgba(255,255,255,0.045), rgba(255,255,255,0.01)),
        linear-gradient(180deg, rgba(5, 12, 20, 0.92), rgba(2, 7, 14, 0.98));
    box-shadow:
        inset 0 1px 0 rgba(255,255,255,0.04),
        0 10px 24px rgba(0,0,0,0.26);
    overflow: hidden;
    isolation: isolate;
    transform: translateY(0);
}

.m-nav-item::before {
    content: '';
    position: absolute;
    inset: 0;
    border-radius: inherit;
    background:
        radial-gradient(circle at 50% 0%, rgba(255,255,255,0.10), transparent 46%),
        linear-gradient(180deg, rgba(255,255,255,0.04), transparent 46%);
    opacity: 0.7;
    pointer-events: none;
}

.m-nav-item::after {
    content: '';
    position: absolute;
    left: 18%;
    right: 18%;
    bottom: 5px;
    height: 3px;
    border-radius: 999px;
    background: linear-gradient(90deg, transparent, rgba(103, 232, 249, 0.85), transparent);
    box-shadow: 0 0 12px rgba(34, 211, 238, 0.28);
    opacity: 0;
    transform: scaleX(0.35);
    transition: opacity 0.26s ease, transform 0.26s ease;
    pointer-events: none;
}

.m-nav-item > span:last-child {
    font-size: 0.60rem;
    font-weight: 900;
    letter-spacing: 1.35px;
    color: rgba(219, 241, 247, 0.78);
    text-shadow: none;
}

.m-nav-item .mf-nav-emoji {
    width: 28px;
    height: 28px;
    margin-bottom: 0;
    border-radius: 10px;
    background: linear-gradient(180deg, rgba(255,255,255,0.10), rgba(255,255,255,0.02));
    border: 1px solid rgba(255,255,255,0.08);
    box-shadow:
        inset 0 1px 0 rgba(255,255,255,0.05),
        0 6px 16px rgba(0,0,0,0.22);
    font-size: 1rem;
    transition: transform 0.22s ease, box-shadow 0.22s ease, background 0.22s ease, border-color 0.22s ease;
}

.m-nav-item:not(.active) {
    opacity: 0.94;
}

.m-nav-item:not(.active):active {
    transform: scale(0.98);
    background:
        linear-gradient(180deg, rgba(34, 211, 238, 0.08), rgba(255,255,255,0.015)),
        linear-gradient(180deg, rgba(5, 12, 20, 0.94), rgba(2, 7, 14, 0.99));
    border-color: rgba(103, 232, 249, 0.28);
}

.m-nav-item.active {
    color: #fff;
    transform: translateY(-5px) scale(1.015);
    border-color: rgba(103, 232, 249, 0.40);
    background:
        radial-gradient(circle at 50% 0%, rgba(103, 232, 249, 0.18), transparent 56%),
        linear-gradient(180deg, rgba(12, 28, 42, 0.98), rgba(4, 11, 20, 0.99));
    box-shadow:
        0 16px 34px rgba(0,0,0,0.34),
        0 0 0 1px rgba(103, 232, 249, 0.08),
        inset 0 0 16px rgba(103, 232, 249, 0.08);
}

.m-nav-item.active .mf-nav-emoji {
    transform: translateY(-2px) scale(1.08);
    background: linear-gradient(180deg, rgba(103, 232, 249, 0.28), rgba(59, 130, 246, 0.12));
    border-color: rgba(103, 232, 249, 0.34);
    box-shadow:
        0 10px 20px rgba(0,0,0,0.26),
        0 0 18px rgba(34, 211, 238, 0.22),
        inset 0 1px 0 rgba(255,255,255,0.08);
}

.m-nav-item.active > span:last-child {
    color: #ffffff;
    text-shadow: 0 0 12px rgba(34, 211, 238, 0.22);
}

.m-nav-item.active::after {
    opacity: 1;
    transform: scaleX(1);
}

.m-nav-item:nth-child(1).active {
    border-color: rgba(34, 211, 238, 0.48);
    background:
        radial-gradient(circle at 50% 0%, rgba(34, 211, 238, 0.19), transparent 56%),
        linear-gradient(180deg, rgba(6, 31, 43, 0.98), rgba(3, 11, 18, 0.99));
    box-shadow:
        0 16px 34px rgba(0,0,0,0.34),
        0 0 22px rgba(34, 211, 238, 0.14),
        inset 0 0 16px rgba(34, 211, 238, 0.10);
}

.m-nav-item:nth-child(2).active {
    border-color: rgba(139, 92, 246, 0.48);
    background:
        radial-gradient(circle at 50% 0%, rgba(139, 92, 246, 0.18), transparent 56%),
        linear-gradient(180deg, rgba(18, 17, 43, 0.98), rgba(7, 7, 20, 0.99));
    box-shadow:
        0 16px 34px rgba(0,0,0,0.34),
        0 0 22px rgba(139, 92, 246, 0.14),
        inset 0 0 16px rgba(139, 92, 246, 0.10);
}

.m-nav-item:nth-child(3).active {
    border-color: rgba(56, 189, 248, 0.48);
    background:
        radial-gradient(circle at 50% 0%, rgba(56, 189, 248, 0.18), transparent 56%),
        linear-gradient(180deg, rgba(8, 22, 40, 0.98), rgba(3, 8, 18, 0.99));
    box-shadow:
        0 16px 34px rgba(0,0,0,0.34),
        0 0 22px rgba(56, 189, 248, 0.14),
        inset 0 0 16px rgba(56, 189, 248, 0.10);
}

body.m-mf-plus .m-dock-nav {
    gap: 8px;
    padding: 10px 10px 4px;
}

body.m-mf-plus .m-nav-item {
    min-height: 60px;
}

body.m-mf-plus .mf-nav-emoji {
    font-size: 1.08rem;
    margin-bottom: 0;
}

body.m-mf-plus .m-nav-item > span:last-child {
    font-size: 0.60rem;
    letter-spacing: 1.2px;
}

body.m-mf-plus .m-nav-item.active .mf-nav-emoji {
    filter: drop-shadow(0 0 10px rgba(103,232,249,0.34));
}


/* Final compact dock: smaller install/copy row and smaller selected menu pills. */
.m-content {
    padding-bottom: calc(178px + var(--safe-bottom));
}

.m-dock-container {
    padding-bottom: calc(6px + env(safe-area-inset-bottom));
    box-shadow: 0 -10px 34px rgba(0,0,0,0.86);
}

.m-dock-actions {
    gap: 7px;
    padding: 7px 12px 4px 12px;
}

.m-btn-install {
    height: 36px;
    border-radius: 11px;
    font-size: 0.82rem;
    letter-spacing: 1.45px;
    gap: 7px;
    box-shadow:
        0 0 16px rgba(0, 242, 255, 0.30),
        0 3px 10px rgba(0, 242, 255, 0.18),
        inset 0 1px 0 rgba(255,255,255,0.32),
        inset 0 -1px 0 rgba(0, 0, 0, 0.20);
}

.m-btn-install i,
.m-btn-install .mf-btn-emoji {
    font-size: 0.88rem;
}

.m-btn-copy {
    height: 36px;
    border-radius: 11px;
    font-size: 0.53rem;
    letter-spacing: 1.05px;
}

.m-btn-copy i,
.m-btn-copy .mf-copy-emoji {
    font-size: 0.82rem;
}

.m-dock-nav {
    gap: 6px;
    padding: 6px 10px 3px;
}

.m-nav-item {
    width: calc(33.333% - 5px);
    max-width: 96px;
    min-height: 48px;
    gap: 3px;
    padding: 5px 5px 7px;
    border-radius: 15px;
    box-shadow:
        inset 0 1px 0 rgba(255,255,255,0.035),
        0 7px 16px rgba(0,0,0,0.22);
}

.m-nav-item .mf-nav-emoji {
    width: 23px;
    height: 23px;
    border-radius: 8px;
    font-size: 0.90rem;
    box-shadow:
        inset 0 1px 0 rgba(255,255,255,0.05),
        0 4px 10px rgba(0,0,0,0.18);
}

.m-nav-item > span:last-child {
    font-size: 0.52rem;
    letter-spacing: 1.0px;
}

.m-nav-item.active {
    transform: translateY(-3px) scale(1.01);
    box-shadow:
        0 10px 22px rgba(0,0,0,0.28),
        0 0 0 1px rgba(103, 232, 249, 0.07),
        inset 0 0 12px rgba(103, 232, 249, 0.07);
}

.m-nav-item.active .mf-nav-emoji {
    transform: translateY(-1px) scale(1.04);
    box-shadow:
        0 7px 14px rgba(0,0,0,0.22),
        0 0 13px rgba(34, 211, 238, 0.18),
        inset 0 1px 0 rgba(255,255,255,0.07);
}

.m-nav-item::after {
    bottom: 4px;
    height: 2px;
}

body.m-mf-plus .m-dock-nav {
    gap: 6px;
    padding: 6px 10px 3px;
}

body.m-mf-plus .m-nav-item {
    min-height: 48px;
}

body.m-mf-plus .mf-nav-emoji {
    font-size: 0.92rem;
}

body.m-mf-plus .m-nav-item > span:last-child {
    font-size: 0.52rem;
    letter-spacing: 0.95px;
}

body.m-keyboard-open .m-dock-container,
body.m-typing .m-dock-container {
    padding-bottom: calc(5px + env(safe-area-inset-bottom));
}

body.m-keyboard-open .m-dock-actions,
body.m-typing .m-dock-actions {
    padding-top: 5px;
    padding-bottom: 3px;
}

body.m-keyboard-open .m-nav-item,
body.m-typing .m-nav-item {
    min-height: 42px;
    padding-top: 4px;
    padding-bottom: 5px;
}

body.m-keyboard-open .m-nav-item .mf-nav-emoji,
body.m-typing .m-nav-item .mf-nav-emoji {
    width: 21px;
    height: 21px;
    font-size: 0.82rem;
}


/* Mobile ocean: visible movement, GPU-friendly */
.m-sea-motion {
    position: fixed;
    inset: 0;
    pointer-events: none;
    overflow: hidden;
    z-index: -7;
    opacity: 0.78;
    contain: layout paint;
}
.m-sea-band {
    position: absolute;
    left: -30%;
    width: 160%;
    border-radius: 44%;
    transform: translate3d(0,0,0);
    will-change: transform;
}
.m-sea-band.band-1 {
    top: -5vh;
    height: 22vh;
    background:
        radial-gradient(70px 24px at 70px 100%, rgba(170,245,255,0.30) 67px, transparent 70px) repeat-x,
        linear-gradient(180deg, rgba(125,232,255,0.18), rgba(14,165,233,0.10), transparent);
    background-size: 140px 56px, 100% 100%;
    animation: mSeaSlideA 12s linear infinite, mSeaBobA 7s ease-in-out infinite;
}
.m-sea-band.band-2 {
    top: 13vh;
    height: 26vh;
    opacity: 0.55;
    background:
        radial-gradient(110px 32px at 110px 100%, rgba(75,215,255,0.22) 107px, transparent 110px) repeat-x,
        linear-gradient(180deg, rgba(34,211,238,0.12), rgba(3,60,95,0.07), transparent);
    background-size: 220px 70px, 100% 100%;
    animation: mSeaSlideB 18s linear infinite, mSeaBobB 9s ease-in-out infinite;
}
.m-sea-band.band-3 {
    bottom: -10vh;
    height: 34vh;
    opacity: 0.50;
    background:
        radial-gradient(145px 38px at 145px 0, rgba(5,60,96,0.40) 142px, transparent 145px) repeat-x,
        linear-gradient(0deg, rgba(0,4,12,0.72), rgba(4,45,70,0.12), transparent);
    background-size: 290px 88px, 100% 100%;
    animation: mSeaSlideC 24s linear infinite, mSeaBobC 11s ease-in-out infinite;
}
@keyframes mSeaSlideA {
    from { background-position: 0 0, 0 0; transform: translate3d(0,0,0) scale(1.02); }
    to   { background-position: 140px 0, 0 0; transform: translate3d(-2.2%,0,0) scale(1.04); }
}
@keyframes mSeaSlideB {
    from { background-position: 0 0, 0 0; transform: translate3d(0,0,0) scale(1.03); }
    to   { background-position: -220px 0, 0 0; transform: translate3d(2.0%,0,0) scale(1.05); }
}
@keyframes mSeaSlideC {
    from { background-position: 0 0, 0 0; transform: translate3d(0,0,0) scale(1.02); }
    to   { background-position: -290px 0, 0 0; transform: translate3d(1.6%,0,0) scale(1.04); }
}
@keyframes mSeaBobA { 0%,100% { margin-top: 0; } 50% { margin-top: 1.1vh; } }
@keyframes mSeaBobB { 0%,100% { margin-top: 0; } 50% { margin-top: -1.0vh; } }
@keyframes mSeaBobC { 0%,100% { margin-bottom: 0; } 50% { margin-bottom: -1.2vh; } }
body.m-lowfx .m-sea-motion { opacity: 0.45; }
body.m-lowfx .m-sea-band.band-2 { display: none; }
body.m-typing .m-sea-motion,
body.m-keyboard-open .m-sea-motion { display: none !important; }

/* Leviathan SaaS skin — keeps original layout, upgrades only the visual layer */
:root {
    --m-bg: #020817;
    --m-bg-deep: #01040d;
    --m-primary: #4de7ff;
    --m-primary-dim: rgba(77, 231, 255, 0.18);
    --m-secondary: #8b5cf6;
    --m-accent: #ff7ad9;
    --m-amber: #ffb86b;
    --m-orange: #ff8a3d;
    --m-cine: #38bdf8;
    --m-kofi: #ff7ad9;
    --m-surface: rgba(9, 18, 35, 0.68);
    --m-surface-2: rgba(3, 9, 20, 0.82);
    --m-text: #f6fbff;
    --m-dim: rgba(207, 232, 245, 0.72);
    --m-faint: rgba(207, 232, 245, 0.42);
    --m-glow: 0 18px 60px rgba(77, 231, 255, 0.20);
    --m-glow-strong: 0 24px 90px rgba(139, 92, 246, 0.26);
    --m-radius-lg: 26px;
    --m-radius-md: 18px;
    --m-radius-sm: 12px;
}

body {
    background:
        radial-gradient(circle at 14% 10%, rgba(77, 231, 255, 0.30) 0, transparent 28%),
        radial-gradient(circle at 88% 8%, rgba(139, 92, 246, 0.34) 0, transparent 32%),
        radial-gradient(circle at 18% 82%, rgba(255, 122, 217, 0.16) 0, transparent 31%),
        radial-gradient(circle at 84% 76%, rgba(255, 138, 61, 0.12) 0, transparent 28%),
        radial-gradient(ellipse at 50% 108%, rgba(2, 132, 199, 0.32), transparent 62%),
        linear-gradient(180deg, #06162d 0%, #04101f 36%, #020817 68%, #01030a 100%);
}

body::after {
    opacity: 0.045;
    background:
        linear-gradient(rgba(255,255,255,0) 50%, rgba(255,255,255,0.045) 50%),
        linear-gradient(90deg, rgba(77,231,255,0.035), rgba(139,92,246,0.025), rgba(255,122,217,0.028));
}

body::before {
    opacity: 0.58;
    background-size: 54px 54px;
    background-image:
        linear-gradient(rgba(148, 238, 255, 0.052) 1px, transparent 1px),
        linear-gradient(90deg, rgba(148, 238, 255, 0.052) 1px, transparent 1px);
}

.m-sea-motion { opacity: 0.72; filter: saturate(1.08) hue-rotate(2deg); }
.m-caustic { opacity: 0.85; }
.m-ocean-particles { opacity: 0.55; }

.m-content { padding-top: 4px; }

.m-abyss-hero {
    padding: 25px 10px 22px;
    margin: 8px 0 12px;
}

.m-abyss-hero::before {
    top: 8px;
    width: min(360px, 94vw);
    height: 286px;
    background:
        radial-gradient(circle at 50% 34%, rgba(77, 231, 255, 0.30) 0%, rgba(77, 231, 255, 0.10) 30%, transparent 56%),
        radial-gradient(circle at 36% 54%, rgba(255, 122, 217, 0.13) 0%, transparent 38%),
        radial-gradient(circle at 72% 58%, rgba(139, 92, 246, 0.17) 0%, transparent 42%);
    filter: blur(24px);
}

.m-abyss-hero::after {
    width: min(320px, 86vw);
    background: linear-gradient(90deg, transparent, rgba(77,231,255,0.62), rgba(255,122,217,0.36), rgba(255,184,107,0.32), transparent);
    opacity: 0.86;
}

.m-abyss-logo {
    width: 164px;
    height: 164px;
    margin-bottom: 12px;
}

.m-abyss-logo::before {
    inset: 7px;
    border: 0;
    background:
        linear-gradient(#020817, #020817) padding-box,
        conic-gradient(from 220deg, rgba(77,231,255,0.95), rgba(139,92,246,0.75), rgba(255,122,217,0.60), rgba(255,184,107,0.50), rgba(77,231,255,0.95)) border-box;
    border: 2px solid transparent;
    box-shadow:
        0 22px 70px rgba(0, 0, 0, 0.38),
        0 0 34px rgba(77, 231, 255, 0.22),
        inset 0 1px 0 rgba(255,255,255,0.14),
        inset 0 0 26px rgba(139,92,246,0.10);
}

.m-abyss-logo::after {
    inset: -18px;
    background:
        radial-gradient(circle, rgba(77,231,255,0.20), rgba(139,92,246,0.10) 42%, transparent 72%);
    filter: blur(16px);
}

.m-abyss-logo .logo-image {
    max-width: 146px;
    transform: translateY(4px) scale(1.03);
    filter:
        drop-shadow(0 18px 24px rgba(0, 0, 0, 0.40))
        drop-shadow(0 0 14px rgba(77, 231, 255, 0.25))
        saturate(1.08) brightness(1.04);
}

.m-abyss-crown {
    background: linear-gradient(135deg, rgba(255,184,107,0.95), rgba(255,122,217,0.75));
    box-shadow: 0 0 20px rgba(255,184,107,0.34);
}

.m-abyss-title {
    font-size: clamp(2.72rem, 13.6vw, 3.42rem);
    letter-spacing: 1px;
    background: linear-gradient(180deg, #ffffff 0%, #b9fbff 28%, #4de7ff 56%, #a78bfa 82%, #ff7ad9 100%);
    -webkit-background-clip: text;
    background-clip: text;
    -webkit-text-fill-color: transparent;
    filter: drop-shadow(0 0 15px rgba(77,231,255,0.28));
}

.m-abyss-sub {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: fit-content;
    min-width: min(82vw, 330px);
    max-width: 92vw;
    margin: 10px auto 0;
    padding: 8px 22px;
    border-radius: 999px;
    color: rgba(238, 252, 255, 0.92);
    background: linear-gradient(135deg, rgba(255,255,255,0.11), rgba(255,255,255,0.045));
    border: 1px solid rgba(255,255,255,0.13);
    letter-spacing: 3.6px;
    text-align: center;
    box-shadow: inset 0 1px 0 rgba(255,255,255,0.12), 0 10px 28px rgba(0,0,0,0.20);
    backdrop-filter: blur(14px);
    -webkit-backdrop-filter: blur(14px);
}

.m-abyss-sub::before,
.m-abyss-sub::after { display: none; }

.m-abyss-version {
    color: rgba(246,251,255,0.90);
    background: linear-gradient(135deg, rgba(77,231,255,0.12), rgba(139,92,246,0.10), rgba(255,122,217,0.08));
    border-color: rgba(255,255,255,0.18);
    box-shadow: 0 12px 34px rgba(0,0,0,0.18), inset 0 1px 0 rgba(255,255,255,0.12);
}

.m-section-head {
    margin: 5px 2px 12px;
    padding: 10px 11px;
    border-left: 0;
    border-radius: 18px;
    background: linear-gradient(135deg, rgba(255,255,255,0.105), rgba(255,255,255,0.045));
    border: 1px solid rgba(255,255,255,0.12);
    box-shadow: 0 14px 38px rgba(0,0,0,0.22), inset 0 1px 0 rgba(255,255,255,0.11);
    backdrop-filter: blur(16px);
    -webkit-backdrop-filter: blur(16px);
}

.m-section-head::before {
    content: "";
    position: absolute;
    left: 11px;
    top: 10px;
    bottom: 10px;
    width: 3px;
    border-radius: 20px;
    background: linear-gradient(180deg, var(--m-primary), var(--m-accent), var(--m-orange));
    box-shadow: 0 0 14px rgba(77,231,255,0.34);
}

.m-section-head .sh-titles { padding-left: 9px; }
.m-section-head .sh-title { font-size: 0.98rem; letter-spacing: 2.4px; }
.m-section-head .sh-sub { color: rgba(207,232,245,0.62); }
.m-section-head .sh-tag {
    border-radius: 999px;
    padding: 5px 9px;
    border-color: rgba(255,255,255,0.14);
    background: rgba(255,255,255,0.075);
    color: rgba(246,251,255,0.86);
}

.m-hypervisor,
.m-visual-core-v2 {
    background:
        linear-gradient(145deg, rgba(255,255,255,0.105), rgba(255,255,255,0.040)),
        radial-gradient(circle at 20% 0%, rgba(77,231,255,0.10), transparent 42%),
        radial-gradient(circle at 94% 12%, rgba(139,92,246,0.10), transparent 40%),
        rgba(2, 8, 23, 0.66);
    border-color: rgba(255,255,255,0.13);
    box-shadow:
        0 18px 58px rgba(0,0,0,0.34),
        inset 0 1px 0 rgba(255,255,255,0.13),
        inset 0 0 28px rgba(77,231,255,0.035);
    backdrop-filter: blur(20px);
    -webkit-backdrop-filter: blur(20px);
}

.m-hypervisor::before,
.m-visual-core-v2::before {
    height: 1px;
    background: linear-gradient(90deg, transparent, rgba(77,231,255,0.88), rgba(255,122,217,0.50), rgba(255,184,107,0.38), transparent);
    box-shadow: 0 0 18px rgba(77,231,255,0.34);
}

.m-hyp-header {
    border-bottom-color: rgba(255,255,255,0.11);
    color: rgba(246,251,255,0.96);
    letter-spacing: 2.5px;
}

.m-hyp-icon {
    border-color: rgba(255,255,255,0.15);
    background: linear-gradient(135deg, rgba(77,231,255,0.16), rgba(139,92,246,0.12));
}

.m-cred-opt,
.m-flux-opt,
.m-lang-opt,
.m-cortex-chip,
.m-reactor-module,
.m-cloud-mode-btn,
.m-qual-chip {
    background: linear-gradient(155deg, rgba(255,255,255,0.088), rgba(255,255,255,0.032));
    border-color: rgba(255,255,255,0.12);
    box-shadow: 0 10px 28px rgba(0,0,0,0.22), inset 0 1px 0 rgba(255,255,255,0.08);
}

.m-cred-opt.active,
.m-flux-opt.active-bal,
.m-flux-opt.active-res,
.m-flux-opt.active-sz,
.m-lang-opt.active-ita,
.m-lang-opt.active-hyb,
.m-lang-opt.active-eng,
.m-cortex-chip.active,
.m-cloud-mode-btn.active {
    background: linear-gradient(155deg, rgba(77,231,255,0.15), rgba(139,92,246,0.115), rgba(255,122,217,0.075));
    border-color: rgba(77,231,255,0.48);
    box-shadow: 0 0 26px rgba(77,231,255,0.16), 0 14px 34px rgba(0,0,0,0.25), inset 0 1px 0 rgba(255,255,255,0.13);
}

.m-reactor-module.active {
    box-shadow: 0 0 24px var(--glow-color), 0 13px 32px rgba(0,0,0,0.30), inset 0 1px 0 rgba(255,255,255,0.12);
}

.m-reactor-core {
    background: rgba(255,255,255,0.05);
    border-right-color: rgba(255,255,255,0.10);
}

.m-reactor-title,
.m-cred-name,
.m-chip-label,
.m-vp-title { color: rgba(255,255,255,0.97); }

.m-reactor-desc,
.m-hyp-desc,
.m-vp-sub,
.m-cloud-note { color: rgba(207,232,245,0.58); }

.m-if-inner,
.m-input-tech,
.m-visual-preview,
.m-flux-readout,
.m-sys-grid,
.m-action-modal .m-am-card {
    background: rgba(1, 8, 18, 0.54);
    border-color: rgba(255,255,255,0.12);
    box-shadow: inset 0 1px 0 rgba(255,255,255,0.07), 0 10px 30px rgba(0,0,0,0.20);
}

.m-input-fuselage {
    background: linear-gradient(145deg, rgba(255,255,255,0.07), rgba(255,255,255,0.025));
    border-color: rgba(255,255,255,0.12);
}

.m-input-fuselage:focus-within,
.m-input-box:focus-within .m-input-tech {
    border-color: rgba(77,231,255,0.55);
    box-shadow: 0 0 24px rgba(77,231,255,0.18), inset 0 1px 0 rgba(255,255,255,0.10);
}

.m-tech-tag {
    border-radius: 999px;
    padding: 3px 7px;
    background: rgba(255,255,255,0.055);
}

.tag-noproxy { border-color: rgba(255,184,107,0.34); color: rgba(255,219,171,0.92); }
.tag-mfp { border-color: rgba(77,231,255,0.38); color: rgba(190,249,255,0.95); }
.tag-kraken { border-color: rgba(139,92,246,0.42); color: rgba(220,210,255,0.95); }

.m-dock-container {
    background: linear-gradient(180deg, rgba(1, 6, 16, 0.16), rgba(1, 6, 16, 0.86) 32%, rgba(1, 4, 12, 0.96));
}

.m-dock-actions,
.m-dock-nav {
    background: linear-gradient(135deg, rgba(255,255,255,0.105), rgba(255,255,255,0.050));
    border: 1px solid rgba(255,255,255,0.13);
    box-shadow: 0 18px 48px rgba(0,0,0,0.38), inset 0 1px 0 rgba(255,255,255,0.12);
    backdrop-filter: blur(20px);
    -webkit-backdrop-filter: blur(20px);
}

.m-btn-install {
    background: linear-gradient(135deg, #4de7ff, #8b5cf6 54%, #ff7ad9);
    color: #ffffff;
    box-shadow: 0 13px 34px rgba(77,231,255,0.22), inset 0 1px 0 rgba(255,255,255,0.24);
}

.m-btn-copy {
    background: linear-gradient(135deg, rgba(255,255,255,0.12), rgba(255,255,255,0.052));
    border-color: rgba(255,255,255,0.14);
    color: rgba(246,251,255,0.90);
}

.m-nav-item.active {
    background: linear-gradient(135deg, rgba(77,231,255,0.16), rgba(139,92,246,0.14));
    border-color: rgba(77,231,255,0.25);
    box-shadow: inset 0 1px 0 rgba(255,255,255,0.12), 0 0 18px rgba(77,231,255,0.12);
}

.m-slider:before {
    box-shadow: 0 4px 14px rgba(0,0,0,0.42);
}

@media (max-width: 370px) {
    .m-abyss-logo { width: 150px; height: 150px; }
    .m-abyss-logo .logo-image { max-width: 134px; }
    .m-abyss-title { font-size: 2.72rem; }
    .m-section-head .sh-title { font-size: 0.90rem; letter-spacing: 1.9px; }
}

body.m-lowfx .m-abyss-sub,
body.m-lowfx .m-section-head,
body.m-lowfx .m-hypervisor,
body.m-lowfx .m-visual-core-v2,
body.m-lowfx .m-dock-actions,
body.m-lowfx .m-dock-nav {
    backdrop-filter: none;
    -webkit-backdrop-filter: none;
}


/* Viewport fix: the bottom install dock must reserve real space, not cover the setup cards. */
:root {
    --m-dock-h: 118px;
    --m-dock-gap: 8px;
}

.m-content-wrapper {
    height: var(--m-vvh, 100dvh) !important;
    padding-bottom: calc(var(--m-dock-h) + var(--m-dock-gap)) !important;
    overflow: hidden !important;
}

.m-content {
    min-height: 0 !important;
    padding-bottom: 16px !important;
}

body.m-keyboard-open .m-content-wrapper,
body.m-typing .m-content-wrapper {
    padding-bottom: calc(58px + var(--m-dock-gap)) !important;
}

body.m-keyboard-open .m-content,
body.m-typing .m-content {
    padding-bottom: 12px !important;
}

.m-dock-container {
    transform: translateZ(0);
}

@media (max-height: 740px) {
    .m-hero {
        padding-top: 14px !important;
        padding-bottom: 12px !important;
    }

    .logo-container,
    .m-abyss-logo {
        width: 118px !important;
        height: 118px !important;
        margin-bottom: 8px !important;
    }

    .logo-image,
    .m-abyss-logo .logo-image {
        max-width: 108px !important;
    }

    .m-brand-title,
    .m-abyss-title {
        font-size: clamp(2.12rem, 11vw, 2.62rem) !important;
    }

    .m-brand-sub,
    .m-abyss-sub {
        font-size: 0.62rem !important;
        letter-spacing: 2.6px !important;
    }

    .m-abyss-sub {
        min-width: min(84vw, 304px) !important;
        padding-left: 18px !important;
        padding-right: 18px !important;
    }

    .m-version-tag {
        margin-top: 6px !important;
    }
}


/* Static Marine SaaS Skin: no moving background, stronger ocean identity */
body {
    background:
        radial-gradient(ellipse at 50% -10%, rgba(125, 249, 255, 0.34) 0%, rgba(34, 211, 238, 0.13) 24%, transparent 54%),
        radial-gradient(circle at 14% 16%, rgba(45, 212, 191, 0.22) 0%, transparent 31%),
        radial-gradient(circle at 86% 12%, rgba(59, 130, 246, 0.24) 0%, transparent 34%),
        radial-gradient(circle at 13% 78%, rgba(14, 165, 233, 0.18) 0%, transparent 36%),
        radial-gradient(circle at 88% 76%, rgba(6, 182, 212, 0.16) 0%, transparent 35%),
        radial-gradient(ellipse at 50% 112%, rgba(3, 105, 161, 0.48) 0%, rgba(7, 89, 133, 0.20) 42%, transparent 72%),
        linear-gradient(180deg, #06263a 0%, #03192e 34%, #020b1c 67%, #00040d 100%) !important;
}

body.m-mf-plus {
    background:
        radial-gradient(ellipse at 50% -14%, rgba(125, 249, 255, 0.32) 0%, rgba(34, 211, 238, 0.12) 32%, transparent 64%),
        radial-gradient(circle at 12% 22%, rgba(45, 212, 191, 0.20) 0%, transparent 32%),
        radial-gradient(circle at 88% 18%, rgba(59, 130, 246, 0.22) 0%, transparent 34%),
        radial-gradient(circle at 18% 86%, rgba(14, 165, 233, 0.17) 0%, transparent 34%),
        radial-gradient(circle at 84% 78%, rgba(20, 184, 166, 0.12) 0%, transparent 32%),
        linear-gradient(180deg, #06263a 0%, #03192e 37%, #020b1c 70%, #00040d 100%) !important;
}

body::before {
    animation: none !important;
    opacity: 0.82 !important;
    background-image:
        radial-gradient(ellipse at 50% 107%, rgba(34, 211, 238, 0.22) 0%, transparent 58%),
        radial-gradient(circle at 18% 74%, rgba(103, 232, 249, 0.12) 0 1.5px, transparent 2px),
        radial-gradient(circle at 78% 66%, rgba(186, 230, 253, 0.10) 0 1.5px, transparent 2px),
        linear-gradient(18deg, transparent 0 55%, rgba(125, 249, 255, 0.06) 57%, transparent 62%),
        linear-gradient(-16deg, transparent 0 42%, rgba(45, 212, 191, 0.05) 44%, transparent 51%),
        linear-gradient(rgba(125, 249, 255, 0.040) 1px, transparent 1px),
        linear-gradient(90deg, rgba(125, 249, 255, 0.032) 1px, transparent 1px) !important;
    background-size:
        100% 100%,
        88px 88px,
        116px 116px,
        340px 150px,
        390px 170px,
        58px 58px,
        58px 58px !important;
    background-position:
        center,
        0 0,
        12px 24px,
        center,
        center,
        center,
        center !important;
    mask-image: linear-gradient(180deg, rgba(0,0,0,0.90) 0%, rgba(0,0,0,0.78) 58%, rgba(0,0,0,0.98) 100%) !important;
    -webkit-mask-image: linear-gradient(180deg, rgba(0,0,0,0.90) 0%, rgba(0,0,0,0.78) 58%, rgba(0,0,0,0.98) 100%) !important;
}

body::after {
    animation: none !important;
    opacity: 0.36 !important;
    background:
        radial-gradient(ellipse at 50% 8%, rgba(215, 255, 255, 0.12) 0%, transparent 38%),
        linear-gradient(180deg, rgba(77, 231, 255, 0.09) 0%, transparent 34%, rgba(0, 7, 18, 0.40) 100%),
        repeating-linear-gradient(180deg, rgba(255, 255, 255, 0.012) 0 1px, transparent 1px 10px) !important;
    mix-blend-mode: screen !important;
}

#app-container::before {
    background:
        radial-gradient(ellipse at 50% 12%, rgba(125, 249, 255, 0.15), transparent 42%),
        radial-gradient(ellipse at 50% 112%, rgba(14, 165, 233, 0.24), transparent 48%),
        linear-gradient(180deg, rgba(255,255,255,0.020), transparent 18%, rgba(0,0,0,0.16) 100%) !important;
    opacity: 0.92 !important;
}

#app-container::after {
    background-image:
        linear-gradient(rgba(125, 249, 255, 0.065) 1px, transparent 1px),
        linear-gradient(90deg, rgba(125, 249, 255, 0.045) 1px, transparent 1px) !important;
    background-size: 68px 68px !important;
    opacity: 0.11 !important;
    animation: none !important;
}

.m-sea-motion,
.m-ocean-particles,
#m-sea-canvas {
    display: none !important;
    opacity: 0 !important;
    animation: none !important;
}

.m-caustic {
    opacity: 0.30 !important;
    filter: saturate(1.15) hue-rotate(-8deg) !important;
}

.m-caustic-ray {
    animation: none !important;
    opacity: 0.28 !important;
    background: linear-gradient(180deg, rgba(185,255,255,0.10) 0%, rgba(77,231,255,0.045) 48%, transparent 100%) !important;
}

.m-sea-band,
.m-ocean-particle {
    animation: none !important;
}

.m-abyss-hero::before {
    background:
        radial-gradient(circle at 50% 30%, rgba(125, 249, 255, 0.32) 0%, rgba(45, 212, 191, 0.12) 31%, transparent 58%),
        radial-gradient(circle at 34% 57%, rgba(34, 211, 238, 0.14) 0%, transparent 38%),
        radial-gradient(circle at 72% 58%, rgba(59, 130, 246, 0.16) 0%, transparent 42%) !important;
}

.m-abyss-hero::after {
    background: linear-gradient(90deg, transparent, rgba(125,249,255,0.72), rgba(45,212,191,0.42), rgba(59,130,246,0.34), transparent) !important;
}

.m-abyss-logo::before {
    background:
        linear-gradient(#021426, #020817) padding-box,
        conic-gradient(from 220deg, rgba(125,249,255,0.95), rgba(45,212,191,0.78), rgba(59,130,246,0.66), rgba(14,165,233,0.72), rgba(125,249,255,0.95)) border-box !important;
    box-shadow:
        0 22px 70px rgba(0, 0, 0, 0.42),
        0 0 34px rgba(125, 249, 255, 0.22),
        inset 0 1px 0 rgba(255,255,255,0.14),
        inset 0 0 28px rgba(45,212,191,0.12) !important;
}

.m-abyss-title {
    background: linear-gradient(180deg, #ffffff 0%, #dffcff 18%, #7df9ff 40%, #22d3ee 62%, #38bdf8 82%, #8bdbff 100%) !important;
    -webkit-background-clip: text !important;
    background-clip: text !important;
    -webkit-text-fill-color: transparent !important;
    filter: drop-shadow(0 0 16px rgba(125,249,255,0.30)) drop-shadow(0 12px 24px rgba(0,0,0,0.44)) !important;
}

.m-abyss-sub,
.m-abyss-version,
.m-section-head,
.m-hypervisor,
.m-visual-core-v2,
.m-dock-actions,
.m-dock-nav {
    border-color: rgba(125, 249, 255, 0.16) !important;
    background:
        linear-gradient(145deg, rgba(255,255,255,0.095), rgba(255,255,255,0.036)),
        radial-gradient(circle at 0 0, rgba(45,212,191,0.085), transparent 42%) !important;
}

.m-section-head::before {
    background: linear-gradient(180deg, #7df9ff, #2dd4bf, #38bdf8) !important;
    box-shadow: 0 0 14px rgba(125,249,255,0.36) !important;
}

.m-btn-install {
    background: linear-gradient(135deg, #7df9ff 0%, #2dd4bf 42%, #38bdf8 76%, #8bdbff 100%) !important;
    color: #02111f !important;
    text-shadow: none !important;
}

.m-nav-item.active {
    background: linear-gradient(135deg, rgba(125,249,255,0.17), rgba(45,212,191,0.13), rgba(56,189,248,0.11)) !important;
    border-color: rgba(125,249,255,0.30) !important;
}

body.m-lowfx .m-caustic {
    display: none !important;
}

.m-section-head {
    min-height: 0 !important;
    margin: 16px 2px 12px !important;
    padding: 8px 10px 8px 12px !important;
    border-radius: 17px !important;
    background:
        linear-gradient(135deg, rgba(125,249,255,0.105), rgba(45,212,191,0.060) 46%, rgba(10,26,44,0.54)),
        radial-gradient(circle at 8% 0%, rgba(226,255,255,0.11), transparent 36%) !important;
    border: 1px solid rgba(125,249,255,0.18) !important;
    box-shadow: 0 10px 30px rgba(0,0,0,0.20), inset 0 1px 0 rgba(255,255,255,0.105) !important;
}

.m-section-head::before {
    left: 9px !important;
    top: 11px !important;
    bottom: 11px !important;
    width: 2px !important;
    background: linear-gradient(180deg, #d8ffff, #7df9ff, #2dd4bf, #38bdf8) !important;
    box-shadow: 0 0 12px rgba(125,249,255,0.34) !important;
}

.m-section-head .sh-titles {
    padding-left: 9px !important;
    gap: 1px !important;
}

.m-section-head .sh-title {
    font-size: 0.90rem !important;
    letter-spacing: 2.15px !important;
    color: rgba(248,253,255,0.96) !important;
    text-shadow: 0 0 12px rgba(125,249,255,0.20) !important;
}

.m-section-head .sh-sub {
    font-size: 0.56rem !important;
    letter-spacing: 1.22px !important;
    color: rgba(210,242,249,0.58) !important;
}

.m-section-head .sh-tag {
    padding: 4px 8px !important;
    font-size: 0.54rem !important;
    color: rgba(232,255,255,0.92) !important;
    border-color: rgba(125,249,255,0.20) !important;
    background: linear-gradient(135deg, rgba(125,249,255,0.12), rgba(45,212,191,0.055)) !important;
    box-shadow: inset 0 1px 0 rgba(255,255,255,0.08) !important;
}

.m-hyp-header {
    font-size: 0.83rem !important;
    letter-spacing: 2.35px !important;
    color: rgba(248,253,255,0.96) !important;
    text-shadow: 0 0 10px rgba(125,249,255,0.17) !important;
    border-bottom-color: rgba(125,249,255,0.13) !important;
}

.m-hyp-header .m-hyp-icon {
    background: linear-gradient(135deg, rgba(125,249,255,0.13), rgba(45,212,191,0.070)) !important;
    border-color: rgba(125,249,255,0.23) !important;
}


.m-panel-desc {
    margin: -6px 2px 14px;
    padding: 10px 12px 11px 13px;
    border-radius: 14px;
    background:
        linear-gradient(135deg, rgba(125,249,255,0.075), rgba(45,212,191,0.040) 48%, rgba(2,12,24,0.34)),
        radial-gradient(circle at 0% 0%, rgba(226,255,255,0.08), transparent 34%);
    border: 1px solid rgba(125,249,255,0.13);
    color: rgba(214,244,250,0.72);
    font-family: 'Outfit', sans-serif;
    font-size: 0.68rem;
    line-height: 1.38;
    letter-spacing: 0.18px;
    box-shadow: inset 0 1px 0 rgba(255,255,255,0.055), 0 10px 24px rgba(0,0,0,0.18);
}

.m-panel-desc b {
    color: rgba(248,253,255,0.95);
    font-weight: 800;
}

@media (max-width: 360px) {
    .m-panel-desc { font-size: 0.63rem; padding: 9px 10px; }
}

@media (max-width: 360px) {
    .m-section-head .sh-title { font-size: 0.84rem !important; letter-spacing: 1.7px !important; }
    .m-section-head .sh-sub { font-size: 0.52rem !important; letter-spacing: 0.95px !important; }
    .m-section-head .sh-tag { font-size: 0.50rem !important; padding: 3px 7px !important; }
}


@media (max-width: 370px) {
    .logo-container { width: 164px; height: 164px; }
    .logo-image { max-width: 136px; }
    .m-brand-title { font-size: 3rem; }
    .m-brand-desc { font-size: 0.73rem; max-width: 300px; }
    .m-hero-badge { font-size: 0.62rem; padding: 0 9px; }
}

body.m-mf-plus .m-abyss-hero {
    padding: 26px 14px 22px;
    margin: 4px 0 14px;
    position: relative;
    isolation: isolate;
    overflow: visible;
}

body.m-mf-plus .m-abyss-hero::before {
    top: -6px;
    width: min(440px, 102vw);
    height: 332px;
    background:
        radial-gradient(ellipse at 50% 28%, rgba(77, 231, 255, 0.38) 0%, rgba(34, 211, 238, 0.12) 30%, transparent 56%),
        radial-gradient(circle at 26% 56%, rgba(139, 92, 246, 0.22) 0%, transparent 38%),
        radial-gradient(circle at 76% 60%, rgba(255, 122, 217, 0.16) 0%, transparent 42%);
    filter: blur(34px);
    opacity: 0.95;
}

body.m-mf-plus .m-abyss-hero::after { display: none; }

.m-hero-aurora {
    position: absolute;
    top: 28px;
    left: 50%;
    transform: translateX(-50%);
    width: min(380px, 98vw);
    height: 178px;
    pointer-events: none;
    z-index: -1;
    border-radius: 50%;
    overflow: hidden;
    opacity: 0.78;
    mask-image: radial-gradient(ellipse at 50% 50%, black 0%, black 55%, transparent 85%);
    -webkit-mask-image: radial-gradient(ellipse at 50% 50%, black 0%, black 55%, transparent 85%);
}

.m-aurora-band {
    position: absolute;
    left: -20%;
    width: 140%;
    height: 14px;
    border-radius: 999px;
    filter: blur(13px);
    animation: auroraSwirl 22s ease-in-out infinite;
    transform-origin: 50% 50%;
    will-change: transform;
}

.m-aurora-band.ab-1 {
    top: 22%;
    background: linear-gradient(90deg, transparent 0%, rgba(77, 231, 255, 0.55) 35%, rgba(34, 211, 238, 0.34) 65%, transparent 100%);
    animation-duration: 24s;
}
.m-aurora-band.ab-2 {
    top: 50%;
    background: linear-gradient(90deg, transparent 0%, rgba(139, 92, 246, 0.45) 40%, rgba(255, 122, 217, 0.30) 70%, transparent 100%);
    animation-duration: 28s;
    animation-direction: reverse;
}
.m-aurora-band.ab-3 {
    top: 76%;
    background: linear-gradient(90deg, transparent 0%, rgba(56, 189, 248, 0.40) 38%, rgba(77, 231, 255, 0.34) 62%, transparent 100%);
    animation-duration: 32s;
}

@keyframes auroraSwirl {
    0%   { transform: translateX(-14%) rotate(-1.2deg); }
    50%  { transform: translateX(14%) rotate(1.2deg); }
    100% { transform: translateX(-14%) rotate(-1.2deg); }
}

body.m-lowfx .m-aurora-band { animation: none; }

.m-hero-meta {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 9px;
    margin: 0 auto 14px;
    font-family: 'Rajdhani', sans-serif;
    font-size: 0.6rem;
    font-weight: 800;
    letter-spacing: 2.4px;
    text-transform: uppercase;
    color: rgba(207, 247, 255, 0.78);
    position: relative;
    z-index: 11;
}

.m-hm-status {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 4px 11px 4px 9px;
    border-radius: 999px;
    background:
        linear-gradient(135deg, rgba(16, 185, 129, 0.20), rgba(34, 211, 238, 0.10));
    border: 1px solid rgba(52, 211, 153, 0.34);
    color: #6ee7b7;
    text-shadow: 0 0 8px rgba(52, 211, 153, 0.45);
    box-shadow:
        inset 0 1px 0 rgba(255, 255, 255, 0.10),
        0 4px 14px rgba(16, 185, 129, 0.14);
    backdrop-filter: blur(10px);
    -webkit-backdrop-filter: blur(10px);
}

.m-hm-pulse {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: #34d399;
    box-shadow: 0 0 0 0 rgba(52, 211, 153, 0.55);
    animation: hmPulse 2.4s ease-out infinite;
}

@keyframes hmPulse {
    0%   { box-shadow: 0 0 0 0 rgba(52, 211, 153, 0.55); }
    70%  { box-shadow: 0 0 0 8px rgba(52, 211, 153, 0); }
    100% { box-shadow: 0 0 0 0 rgba(52, 211, 153, 0); }
}

body.m-lowfx .m-hm-pulse { animation: none; }

.m-hm-divider {
    width: 18px;
    height: 1px;
    background: linear-gradient(90deg, transparent, rgba(125, 232, 255, 0.45), transparent);
}

.m-hm-tag {
    color: rgba(229, 250, 255, 0.86);
    letter-spacing: 2.6px;
    text-shadow: 0 0 6px rgba(77, 231, 255, 0.32);
    padding: 4px 11px;
    border-radius: 999px;
    background: linear-gradient(135deg, rgba(125, 232, 255, 0.10), rgba(139, 92, 246, 0.06));
    border: 1px solid rgba(125, 232, 255, 0.18);
    backdrop-filter: blur(10px);
    -webkit-backdrop-filter: blur(10px);
}

body.m-mf-plus .m-abyss-logo {
    width: 172px;
    height: 172px;
    margin-bottom: 14px;
    position: relative;
}

.m-orbit-ring {
    position: absolute;
    border-radius: 50%;
    pointer-events: none;
    z-index: 0;
    border: 1px solid transparent;
    background:
        conic-gradient(from 0deg,
            transparent 0%,
            rgba(77, 231, 255, 0.55) 8%,
            transparent 22% 78%,
            rgba(139, 92, 246, 0.45) 92%,
            transparent 100%) border-box;
    -webkit-mask:
        linear-gradient(#000 0 0) padding-box,
        linear-gradient(#000 0 0);
    -webkit-mask-composite: xor;
            mask-composite: exclude;
    animation: orbitSpin 28s linear infinite;
    opacity: 0.70;
    will-change: transform;
}

.m-orbit-ring.m-orbit-1 { inset: -6px; }

.m-orbit-ring.m-orbit-2 {
    inset: -18px;
    background:
        conic-gradient(from 180deg,
            transparent 0%,
            rgba(255, 122, 217, 0.45) 10%,
            transparent 25% 75%,
            rgba(56, 189, 248, 0.50) 88%,
            transparent 100%) border-box;
    animation-duration: 42s;
    animation-direction: reverse;
    opacity: 0.55;
}

@keyframes orbitSpin {
    to { transform: rotate(360deg); }
}

body.m-lowfx .m-orbit-ring { animation: none; opacity: 0.36; }

body.m-mf-plus .m-abyss-sub {
    margin: 14px auto 0;
    padding: 7px 22px;
    min-width: 0;
    width: auto;
    max-width: 92vw;
    font-size: clamp(0.66rem, 3vw, 0.78rem);
    font-weight: 900;
    letter-spacing: 3.4px;
    border-radius: 999px;
    background:
        linear-gradient(90deg, rgba(77, 231, 255, 0.10), rgba(139, 92, 246, 0.08), rgba(255, 122, 217, 0.10));
    border: 1px solid rgba(125, 232, 255, 0.26);
    color: rgba(229, 252, 255, 0.94);
    backdrop-filter: blur(20px) saturate(150%);
    -webkit-backdrop-filter: blur(20px) saturate(150%);
    box-shadow:
        0 8px 24px rgba(0, 0, 0, 0.30),
        0 0 24px rgba(77, 231, 255, 0.10),
        inset 0 1px 0 rgba(255, 255, 255, 0.14);
    position: relative;
    overflow: hidden;
    z-index: 10;
}

body.m-mf-plus .m-abyss-sub::before {
    content: "";
    display: block;
    position: absolute;
    top: 0;
    left: -60%;
    width: 50%;
    height: 100%;
    background: linear-gradient(90deg, transparent, rgba(255, 255, 255, 0.12), transparent);
    animation: subShimmer 6s ease-in-out infinite;
}

@keyframes subShimmer {
    0%   { left: -60%; }
    55%  { left: 110%; }
    100% { left: 110%; }
}

body.m-lowfx .m-abyss-sub::before { animation: none; }

body.m-mf-plus .m-brand-desc {
    font-family: 'Outfit', sans-serif;
    font-size: 0.84rem;
    line-height: 1.55;
    font-weight: 400;
    margin: 18px auto 16px;
    max-width: 340px;
    color: rgba(229, 250, 255, 0.84);
    text-wrap: balance;
    text-align: center;
}

body.m-mf-plus .m-brand-desc strong {
    color: #b9fbff;
    font-weight: 600;
    text-shadow: 0 0 10px rgba(77, 231, 255, 0.32);
}

body.m-mf-plus .m-hero-badge {
    padding: 0 14px;
    min-height: 34px;
    font-size: 0.68rem;
    letter-spacing: 1.4px;
    border-radius: 999px;
    background:
        linear-gradient(135deg, rgba(19, 38, 56, 0.62), rgba(8, 18, 32, 0.50)),
        radial-gradient(circle at 50% 0%, rgba(125, 232, 255, 0.20), transparent 65%);
    border: 1px solid rgba(125, 232, 255, 0.24);
    box-shadow:
        inset 0 1px 0 rgba(255, 255, 255, 0.10),
        0 6px 16px rgba(0, 0, 0, 0.28),
        0 0 18px rgba(77, 231, 255, 0.10);
    transition: transform 0.25s cubic-bezier(0.34, 1.56, 0.64, 1), box-shadow 0.25s ease;
    color: #e2feff;
}

body.m-mf-plus .m-hero-badge:active {
    transform: scale(0.96);
    box-shadow:
        inset 0 1px 0 rgba(255, 255, 255, 0.12),
        0 4px 10px rgba(0, 0, 0, 0.32),
        0 0 26px rgba(77, 231, 255, 0.20);
}

body.m-mf-plus .m-abyss-version {
    margin-top: 16px;
    padding: 6px 16px 6px 14px;
    border-radius: 999px;
    border: 1px solid rgba(125, 232, 255, 0.28);
    background:
        linear-gradient(135deg, rgba(8, 47, 73, 0.46), rgba(15, 23, 42, 0.34)),
        radial-gradient(circle at 50% 0%, rgba(77, 231, 255, 0.18), transparent 62%);
    color: rgba(229, 252, 255, 0.92);
    font-size: 0.62rem;
    letter-spacing: 2.6px;
    font-weight: 800;
    box-shadow:
        inset 0 1px 0 rgba(255, 255, 255, 0.10),
        0 6px 18px rgba(0, 0, 0, 0.32),
        0 0 22px rgba(77, 231, 255, 0.10);
}

body.m-mf-plus .m-hypervisor,
body.m-mf-plus .m-visual-core-v2,
body.m-mf-plus .m-ghost-panel,
body.m-mf-plus .m-p2p-module {
    padding: 18px 14px 16px;
    border-radius: 24px;
    background:
        radial-gradient(ellipse at 0% 0%, rgba(77, 231, 255, 0.14), transparent 42%),
        radial-gradient(ellipse at 100% 0%, rgba(139, 92, 246, 0.10), transparent 45%),
        linear-gradient(180deg, rgba(11, 24, 42, 0.82), rgba(3, 9, 20, 0.96));
    border: 1px solid rgba(125, 232, 255, 0.16);
    box-shadow:
        0 18px 42px rgba(0, 0, 0, 0.42),
        0 0 0 1px rgba(255, 255, 255, 0.022) inset,
        inset 0 1px 0 rgba(255, 255, 255, 0.06);
    position: relative;
    overflow: hidden;
}

body.m-mf-plus .m-hypervisor::before {
    content: "";
    position: absolute;
    top: 0;
    left: 14%;
    right: 14%;
    height: 2px;
    background: linear-gradient(90deg, transparent, rgba(77, 231, 255, 0.65), rgba(139, 92, 246, 0.55), rgba(255, 122, 217, 0.40), transparent);
    box-shadow: 0 0 14px rgba(77, 231, 255, 0.45);
    opacity: 0.80;
    pointer-events: none;
}

body.m-mf-plus .m-hyp-header {
    margin: 0 0 14px;
    padding: 0 2px 12px;
    border-bottom: 1px solid rgba(125, 232, 255, 0.14);
    font-family: 'Rajdhani', sans-serif;
    font-size: 0.84rem;
    font-weight: 900;
    letter-spacing: 1.6px;
    text-transform: uppercase;
    color: #e6fbff;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    text-shadow: 0 0 12px rgba(77, 231, 255, 0.26);
}

body.m-mf-plus .m-hyp-icon {
    width: 34px;
    height: 34px;
    border-radius: 12px;
    display: flex;
    align-items: center;
    justify-content: center;
    background:
        radial-gradient(circle at 35% 28%, rgba(125, 232, 255, 0.36), rgba(77, 231, 255, 0.14) 60%, rgba(2, 17, 28, 0.40)),
        linear-gradient(135deg, rgba(77, 231, 255, 0.18), rgba(139, 92, 246, 0.10));
    border: 1px solid rgba(125, 232, 255, 0.28);
    color: #6ef0ff;
    font-size: 0.95rem;
    box-shadow:
        inset 0 1px 0 rgba(255, 255, 255, 0.16),
        0 4px 12px rgba(0, 0, 0, 0.28),
        0 0 18px rgba(77, 231, 255, 0.18);
    filter: drop-shadow(0 0 6px rgba(77, 231, 255, 0.32));
}

body.m-mf-plus .m-panel-desc {
    font-family: 'Outfit', sans-serif;
    font-size: 0.76rem;
    line-height: 1.5;
    color: rgba(207, 245, 252, 0.78);
    margin: 0 0 14px;
    text-wrap: balance;
}

body.m-mf-plus .m-panel-desc b,
body.m-mf-plus .m-panel-desc strong {
    color: #b9fbff;
    font-weight: 600;
    text-shadow: 0 0 8px rgba(77, 231, 255, 0.28);
}

body.m-mf-plus .m-section-head {
    margin: 14px 2px 14px;
    padding: 12px 14px 11px;
    border-radius: 18px;
    background:
        radial-gradient(circle at 0% 0%, rgba(77, 231, 255, 0.12), transparent 44%),
        linear-gradient(135deg, rgba(13, 28, 48, 0.78), rgba(4, 12, 24, 0.92));
    border: 1px solid rgba(125, 232, 255, 0.18);
    box-shadow:
        0 10px 26px rgba(0, 0, 0, 0.32),
        inset 0 1px 0 rgba(255, 255, 255, 0.06);
    backdrop-filter: blur(14px);
    -webkit-backdrop-filter: blur(14px);
    position: relative;
    overflow: hidden;
}

body.m-mf-plus .m-section-head::before {
    content: "";
    position: absolute;
    left: 10px;
    top: 10px;
    bottom: 10px;
    width: 3px;
    border-radius: 999px;
    background: linear-gradient(180deg, #6ef0ff 0%, #8b5cf6 60%, #ff7ad9 100%);
    box-shadow: 0 0 12px rgba(77, 231, 255, 0.55);
    opacity: 0.88;
}

body.m-mf-plus .m-section-head .sh-title {
    font-family: 'Rajdhani', sans-serif;
    font-weight: 900;
    letter-spacing: 1.3px;
    text-transform: uppercase;
    color: #e6fbff;
    font-size: 0.84rem;
    text-shadow: 0 0 10px rgba(77, 231, 255, 0.20);
}

body.m-mf-plus .m-section-head .sh-sub {
    font-family: 'Outfit', sans-serif;
    font-size: 0.68rem;
    color: rgba(207, 245, 252, 0.66);
    margin-top: 2px;
    letter-spacing: 0.2px;
    text-transform: none;
    font-weight: 400;
}

body.m-mf-plus .m-section-head .sh-tag {
    border-radius: 999px;
    padding: 3px 9px;
    font-size: 0.58rem;
    letter-spacing: 1.4px;
    font-weight: 900;
    text-transform: uppercase;
    background: linear-gradient(135deg, rgba(77, 231, 255, 0.18), rgba(139, 92, 246, 0.10));
    border: 1px solid rgba(125, 232, 255, 0.28);
    color: #b9fbff;
    text-shadow: 0 0 6px rgba(77, 231, 255, 0.32);
    box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.08);
}

body.m-mf-plus .m-cred-deck {
    gap: 10px;
    margin-bottom: 18px;
}

body.m-mf-plus .m-cred-opt {
    min-height: 92px;
    padding: 14px 6px 12px;
    border-radius: 20px;
    background:
        radial-gradient(circle at 50% -10%, var(--opt-glow, rgba(77, 231, 255, 0.20)), transparent 56%),
        linear-gradient(180deg, rgba(15, 30, 48, 0.86), rgba(3, 10, 20, 0.96));
    border: 1px solid rgba(125, 232, 255, 0.16);
    box-shadow:
        0 10px 22px rgba(0, 0, 0, 0.42),
        inset 0 1px 0 rgba(255, 255, 255, 0.06);
    position: relative;
    overflow: hidden;
    transition: transform 0.25s cubic-bezier(0.34, 1.56, 0.64, 1),
                box-shadow 0.25s ease,
                border-color 0.25s ease;
}

body.m-mf-plus .m-cred-opt::before {
    content: "";
    position: absolute;
    top: 0;
    left: 12%;
    right: 12%;
    height: 2.5px;
    border-radius: 999px;
    background: linear-gradient(90deg, transparent, var(--opt-color, #6ef0ff), transparent);
    box-shadow: 0 0 10px var(--opt-color, rgba(77, 231, 255, 0.55));
    opacity: 0.55;
    transition: opacity 0.25s ease, height 0.25s ease;
}

body.m-mf-plus .m-cred-opt.active {
    transform: translateY(-2px);
    border-color: var(--opt-color, rgba(77, 231, 255, 0.7));
    background:
        radial-gradient(circle at 50% -5%, var(--opt-glow, rgba(77, 231, 255, 0.32)), transparent 62%),
        linear-gradient(180deg, rgba(22, 50, 76, 0.96), rgba(4, 12, 22, 0.98));
    box-shadow:
        0 14px 28px rgba(0, 0, 0, 0.48),
        0 0 0 1px var(--opt-glow, rgba(77, 231, 255, 0.4)),
        0 0 26px var(--opt-glow, rgba(77, 231, 255, 0.18)),
        inset 0 1px 0 rgba(255, 255, 255, 0.10);
}

body.m-mf-plus .m-cred-opt.active::before {
    opacity: 1;
    height: 3px;
}

body.m-mf-plus .m-cred-opt.active::after {
    content: "✓" !important;
    display: flex !important;
    align-items: center;
    justify-content: center;
    position: absolute;
    top: 8px;
    right: 8px;
    inset: auto 8px auto auto;
    width: 22px;
    height: 22px;
    border-radius: 999px;
    color: #00151b;
    background: var(--opt-color, #6ef0ff);
    font-family: 'Rajdhani', sans-serif;
    font-size: 0.82rem;
    font-weight: 900;
    opacity: 1 !important;
    box-shadow: 0 0 12px var(--opt-glow, rgba(77, 231, 255, 0.55));
}

body.m-mf-plus .m-cred-opt:active {
    transform: scale(0.97);
}

body.m-mf-plus .m-cred-icon {
    font-size: 1.95rem;
    transform: translateZ(0);
    filter: drop-shadow(0 4px 8px rgba(0, 0, 0, 0.35));
}

body.m-mf-plus .m-cred-opt.active .m-cred-icon {
    transform: scale(1.16);
    filter: drop-shadow(0 0 12px var(--opt-color, rgba(77, 231, 255, 0.65)));
}

body.m-mf-plus .m-cred-name {
    font-family: 'Rajdhani', sans-serif;
    font-size: 0.62rem;
    font-weight: 800;
    letter-spacing: 0.9px;
    color: rgba(244, 253, 255, 0.78);
    text-transform: uppercase;
}

body.m-mf-plus .m-cred-opt.active .m-cred-name {
    color: #ffffff;
    text-shadow: 0 0 12px var(--opt-color, rgba(77, 231, 255, 0.7));
    letter-spacing: 1.3px;
}

body.m-mf-plus .m-input-fuselage,
body.m-mf-plus .m-input-box {
    border-radius: 20px !important;
    padding: 4px !important;
    background:
        radial-gradient(circle at 0% 0%, rgba(77, 231, 255, 0.10), transparent 42%),
        linear-gradient(180deg, rgba(12, 26, 42, 0.86), rgba(2, 9, 18, 0.96)) !important;
    border: 1px solid rgba(125, 232, 255, 0.16) !important;
    box-shadow:
        inset 0 1px 0 rgba(255, 255, 255, 0.06),
        0 8px 18px rgba(0, 0, 0, 0.32);
    transition: border-color 0.25s ease, box-shadow 0.25s ease;
}

body.m-mf-plus .m-input-fuselage:focus-within {
    border-color: rgba(77, 231, 255, 0.55) !important;
    box-shadow:
        inset 0 1px 0 rgba(255, 255, 255, 0.10),
        0 10px 22px rgba(0, 0, 0, 0.36),
        0 0 26px rgba(77, 231, 255, 0.22);
}

body.m-mf-plus .m-if-inner,
body.m-mf-plus .m-input-box {
    min-height: 54px;
    border-radius: 16px;
}

body.m-mf-plus .m-if-icon {
    color: #6ef0ff;
    border-right-color: rgba(125, 232, 255, 0.14);
    filter: drop-shadow(0 0 6px rgba(77, 231, 255, 0.20));
}

body.m-mf-plus .m-if-label,
body.m-mf-plus .m-field-label {
    border-radius: 999px;
    background: linear-gradient(135deg, rgba(10, 26, 42, 0.98), rgba(4, 12, 22, 0.98));
    border: 1px solid rgba(125, 232, 255, 0.24);
    color: #b9fbff;
    font-family: 'Rajdhani', sans-serif;
    font-weight: 800;
    letter-spacing: 1.2px;
    text-transform: uppercase;
    font-size: 0.62rem;
    padding: 4px 10px;
    text-shadow: 0 0 6px rgba(77, 231, 255, 0.30);
    box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.06);
}

body.m-mf-plus .m-if-label.opt,
body.m-mf-plus .m-field-label.opt {
    color: #f5b5e7;
    border-color: rgba(255, 122, 217, 0.32);
    background: linear-gradient(135deg, rgba(28, 12, 32, 0.98), rgba(16, 6, 22, 0.98));
    text-shadow: 0 0 6px rgba(255, 122, 217, 0.32);
}

body.m-mf-plus .m-if-action,
body.m-mf-plus .m-paste-action {
    border-radius: 12px;
    background: linear-gradient(135deg, rgba(125, 232, 255, 0.10), rgba(139, 92, 246, 0.06));
    border: 1px solid rgba(125, 232, 255, 0.18);
    color: #b9fbff;
}

body.m-mf-plus .m-if-action:active,
body.m-mf-plus .m-paste-action:active {
    transform: scale(0.92);
    background: rgba(77, 231, 255, 0.18);
    color: #ffffff;
}

body.m-mf-plus .m-get-link {
    border-radius: 999px;
    background: linear-gradient(135deg, rgba(125, 232, 255, 0.16), rgba(139, 92, 246, 0.10));
    border: 1px solid rgba(125, 232, 255, 0.30);
    color: #6ef0ff;
    font-family: 'Rajdhani', sans-serif;
    font-weight: 900;
    letter-spacing: 1.4px;
    text-transform: uppercase;
    font-size: 0.60rem;
    padding: 5px 11px;
    box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.08);
    transition: all 0.2s ease;
}

body.m-mf-plus .m-get-link:active {
    background: #6ef0ff;
    color: #001722;
    box-shadow: 0 0 18px rgba(77, 231, 255, 0.55);
}

body.m-mf-plus .m-key-status {
    border-radius: 14px;
    background: linear-gradient(135deg, rgba(12, 26, 42, 0.72), rgba(4, 12, 22, 0.88));
    border: 1px solid rgba(125, 232, 255, 0.12);
    padding: 8px 12px;
    box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.04);
    font-family: 'Outfit', sans-serif;
    font-size: 0.72rem;
}

body.m-mf-plus .m-reactor-module {
    border-radius: 20px;
    background:
        radial-gradient(circle at 0% 0%, rgba(77, 231, 255, 0.10), transparent 42%),
        linear-gradient(180deg, rgba(13, 28, 48, 0.86), rgba(3, 10, 22, 0.95));
    border: 1px solid rgba(125, 232, 255, 0.14);
    box-shadow:
        0 10px 24px rgba(0, 0, 0, 0.40),
        inset 0 1px 0 rgba(255, 255, 255, 0.06);
    position: relative;
    overflow: hidden;
    transition: transform 0.22s cubic-bezier(0.34, 1.56, 0.64, 1), border-color 0.22s ease, box-shadow 0.22s ease;
}

body.m-mf-plus .m-reactor-module::before {
    content: "";
    position: absolute;
    top: 0;
    left: 10%;
    right: 10%;
    height: 2px;
    border-radius: 999px;
    background: linear-gradient(90deg, transparent, rgba(125, 232, 255, 0.55), transparent);
    opacity: 0.45;
    transition: opacity 0.22s ease, background 0.22s ease;
}

body.m-mf-plus .m-reactor-module.active {
    border-color: rgba(77, 231, 255, 0.55);
    background:
        radial-gradient(circle at 50% -10%, rgba(77, 231, 255, 0.22), transparent 58%),
        linear-gradient(180deg, rgba(20, 44, 70, 0.94), rgba(4, 12, 24, 0.98));
    box-shadow:
        0 14px 30px rgba(0, 0, 0, 0.48),
        0 0 0 1px rgba(77, 231, 255, 0.32),
        0 0 28px rgba(77, 231, 255, 0.16),
        inset 0 1px 0 rgba(255, 255, 255, 0.10);
}

body.m-mf-plus .m-reactor-module.active::before {
    opacity: 1;
    background: linear-gradient(90deg, transparent, #6ef0ff, #8b5cf6, transparent);
    box-shadow: 0 0 14px rgba(77, 231, 255, 0.55);
}

body.m-mf-plus .m-reactor-module:active {
    transform: scale(0.985);
}

body.m-mf-plus .m-reactor-core {
    border-radius: 14px;
    background: linear-gradient(135deg, rgba(125, 232, 255, 0.10), rgba(139, 92, 246, 0.06));
    border: 1px solid rgba(125, 232, 255, 0.18);
    box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.08);
}

body.m-mf-plus .m-reactor-module.active .m-reactor-core {
    background:
        radial-gradient(circle at 35% 28%, rgba(125, 232, 255, 0.42), rgba(77, 231, 255, 0.16) 60%, rgba(2, 17, 28, 0.40)),
        linear-gradient(135deg, rgba(125, 232, 255, 0.22), rgba(139, 92, 246, 0.12));
    border-color: rgba(77, 231, 255, 0.45);
    box-shadow:
        inset 0 1px 0 rgba(255, 255, 255, 0.16),
        0 4px 12px rgba(0, 0, 0, 0.28),
        0 0 18px rgba(77, 231, 255, 0.22);
}

body.m-mf-plus .m-reactor-title {
    font-family: 'Rajdhani', sans-serif;
    font-weight: 900;
    letter-spacing: 0.6px;
    color: #e6fbff;
    text-shadow: 0 0 8px rgba(77, 231, 255, 0.18);
}

body.m-mf-plus .m-reactor-desc {
    font-family: 'Outfit', sans-serif;
    font-size: 0.74rem;
    line-height: 1.45;
    color: rgba(207, 245, 252, 0.74);
    text-wrap: balance;
}

body.m-mf-plus .m-dock-nav {
    padding: 8px 6px 4px;
    position: relative;
}

body.m-mf-plus .m-nav-item {
    width: 72px;
    padding: 6px 0 4px;
    position: relative;
    border-radius: 14px;
    transition: transform 0.22s cubic-bezier(0.34, 1.56, 0.64, 1), background 0.22s ease;
}

body.m-mf-plus .m-nav-item.active {
    transform: translateY(-3px);
    background:
        radial-gradient(ellipse at 50% 0%, rgba(77, 231, 255, 0.18), transparent 65%),
        linear-gradient(180deg, rgba(20, 44, 70, 0.50), rgba(4, 12, 22, 0.40));
}

body.m-mf-plus .m-nav-item.active::after {
    content: "";
    position: absolute;
    bottom: -4px;
    left: 50%;
    transform: translateX(-50%);
    width: 28px;
    height: 3px;
    background: linear-gradient(90deg, transparent, #6ef0ff, #8b5cf6, transparent);
    border-radius: 999px;
    box-shadow: 0 0 10px rgba(77, 231, 255, 0.65);
    opacity: 1;
}

body.m-mf-plus .m-nav-item.active .mf-nav-emoji {
    filter: drop-shadow(0 0 10px rgba(77, 231, 255, 0.65));
    transform: scale(1.08);
}

body.m-mf-plus .m-nav-item span {
    font-size: 0.56rem;
    font-weight: 800;
    letter-spacing: 1.4px;
    color: rgba(207, 245, 252, 0.66);
    transition: color 0.22s ease, text-shadow 0.22s ease;
}

body.m-mf-plus .m-nav-item.active span {
    color: #ffffff;
    text-shadow: 0 0 10px rgba(77, 231, 255, 0.55);
}

body.m-mf-plus .m-nav-item .mf-nav-emoji {
    transition: transform 0.22s cubic-bezier(0.34, 1.56, 0.64, 1), filter 0.22s ease;
}

body.m-mf-plus .m-dock-container {
    background:
        radial-gradient(ellipse at 50% -38%, rgba(77, 231, 255, 0.20), transparent 60%),
        linear-gradient(180deg, rgba(2, 8, 20, 0.55) 0%, rgba(1, 4, 12, 0.92) 52%, rgba(0, 1, 4, 0.99) 100%);
    backdrop-filter: blur(28px) saturate(150%);
    -webkit-backdrop-filter: blur(28px) saturate(150%);
    border-top: 1px solid rgba(125, 232, 255, 0.18);
    border-top-left-radius: 26px;
    border-top-right-radius: 26px;
    box-shadow: 0 -18px 50px rgba(0, 0, 0, 0.55);
}

body.m-mf-plus .m-dock-actions.m-dock-actions-fluid {
    background: transparent;
    border-bottom: 0;
    padding: 16px 16px 12px;
    gap: 11px;
    position: relative;
}

body.m-mf-plus .m-dock-actions.m-dock-actions-fluid::after {
    content: "";
    position: absolute;
    left: 16%;
    right: 16%;
    bottom: 4px;
    height: 1px;
    background: linear-gradient(90deg, transparent, rgba(125, 232, 255, 0.18), transparent);
    pointer-events: none;
}

body.m-mf-plus .m-btn-fluid {
    position: relative;
    display: flex !important;
    align-items: center;
    justify-content: flex-start;
    gap: 11px;
    padding: 8px 14px 8px 8px;
    height: 58px;
    min-height: 58px;
    border-radius: 19px;
    overflow: visible;
    isolation: isolate;
    cursor: pointer;
    text-align: left;
    font-family: 'Rajdhani', sans-serif;
    text-transform: none;
    letter-spacing: 0;
    transition: transform 0.18s cubic-bezier(0.34, 1.56, 0.64, 1),
                box-shadow 0.18s ease;
    flex-direction: row;
}

body.m-mf-plus .m-btn-fluid > .m-bf-icon,
body.m-mf-plus .m-btn-fluid > .m-bf-stack {
    position: relative;
    z-index: 2;
}

body.m-mf-plus .m-btn-fluid::after {
    content: "";
    position: absolute;
    inset: 1px;
    border-radius: 18px;
    background: linear-gradient(180deg, rgba(255, 255, 255, 0.24), transparent 50%);
    pointer-events: none;
    z-index: 1;
}

body.m-mf-plus .m-btn-fluid .m-bf-icon {
    flex-shrink: 0;
    width: 42px;
    height: 42px;
    border-radius: 13px;
    display: flex;
    align-items: center;
    justify-content: center;
    line-height: 1;
    font-size: 1.2rem;
    background:
        linear-gradient(135deg, rgba(255, 255, 255, 0.32), rgba(255, 255, 255, 0.08));
    box-shadow:
        inset 0 1px 0 rgba(255, 255, 255, 0.45),
        0 4px 10px rgba(0, 0, 0, 0.20);
}

body.m-mf-plus .m-btn-fluid .m-bf-icon i { display: none; }

body.m-mf-plus .m-btn-fluid .m-bf-stack {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    justify-content: center;
    gap: 1px;
    min-width: 0;
}

body.m-mf-plus .m-btn-fluid .m-bf-label {
    font-weight: 900;
    font-size: 0.98rem;
    letter-spacing: 1.6px;
    text-transform: uppercase;
    line-height: 1.08;
}

body.m-mf-plus .m-btn-fluid .m-bf-sub {
    font-family: 'Outfit', sans-serif;
    font-weight: 500;
    font-size: 0.64rem;
    letter-spacing: 0.4px;
    text-transform: none;
    opacity: 0.80;
    line-height: 1.18;
    white-space: nowrap;
}

body.m-mf-plus .m-btn-fluid:active {
    transform: scale(0.97) translateZ(0);
}

body.m-mf-plus .m-btn-install.m-btn-fluid {
    flex: 1.95;
    color: #001722;
    background:
        linear-gradient(135deg,
            #c8fcff 0%,
            #6ef0ff 22%,
            #22d3ee 50%,
            #00a7ff 78%,
            #8b5cf6 112%);
    border: 1px solid rgba(255, 255, 255, 0.44);
    box-shadow:
        0 12px 30px rgba(0, 213, 255, 0.36),
        inset 0 1px 0 rgba(255, 255, 255, 0.85),
        inset 0 -2px 0 rgba(0, 0, 0, 0.18);
    text-shadow: 0 1px 0 rgba(255, 255, 255, 0.55);
    height: 58px;
    font-size: inherit;
    letter-spacing: 0;
}

body.m-mf-plus .m-btn-install.m-btn-fluid::before {
    content: "";
    position: absolute;
    top: 0;
    left: -120%;
    width: 50%;
    height: 100%;
    background: linear-gradient(90deg, transparent, rgba(255, 255, 255, 0.55), transparent);
    transform: skewX(-22deg);
    animation: shimmer 4.5s linear infinite;
    z-index: 1;
    pointer-events: none;
    border-radius: 19px;
}

body.m-mf-plus .m-btn-install.m-btn-fluid .m-bf-halo {
    position: absolute;
    inset: -10px -8px -16px -8px;
    border-radius: 24px;
    background: radial-gradient(ellipse at 50% 50%, rgba(77, 231, 255, 0.42), rgba(139, 92, 246, 0.18) 55%, transparent 80%);
    filter: blur(16px);
    z-index: -1;
    pointer-events: none;
    opacity: 0.85;
    animation: haloPulse 3.8s ease-in-out infinite;
    will-change: opacity, transform;
}

@keyframes haloPulse {
    0%, 100% { opacity: 0.65; transform: scale(0.98); }
    50%      { opacity: 0.95; transform: scale(1.04); }
}

body.m-lowfx .m-bf-halo { animation: none; opacity: 0.55; }

body.m-mf-plus .m-btn-install.m-btn-fluid .m-bf-icon {
    background:
        radial-gradient(circle at 30% 28%, rgba(255, 255, 255, 0.96), rgba(255, 255, 255, 0.40) 60%, rgba(255, 255, 255, 0.18));
    box-shadow:
        inset 0 1px 0 rgba(255, 255, 255, 0.95),
        inset 0 -2px 0 rgba(0, 0, 0, 0.10),
        0 4px 12px rgba(0, 100, 130, 0.22);
}

body.m-mf-plus .m-btn-install.m-btn-fluid .mf-btn-emoji {
    font-size: 1.18rem;
    filter: drop-shadow(0 1px 1px rgba(0, 0, 0, 0.16));
    width: auto;
    height: auto;
    background: transparent;
    box-shadow: none;
    border-radius: 0;
}

body.m-mf-plus .m-btn-install.m-btn-fluid .m-bf-label {
    color: #001722;
    text-shadow: 0 1px 0 rgba(255, 255, 255, 0.55);
}

body.m-mf-plus .m-btn-install.m-btn-fluid .m-bf-sub {
    color: rgba(0, 23, 34, 0.66);
    opacity: 0.86;
    font-weight: 600;
}

body.m-mf-plus .m-btn-install.m-btn-fluid i { display: none; }

body.m-mf-plus .m-btn-copy.m-btn-fluid {
    flex: 1.05;
    color: #dffbff;
    background:
        radial-gradient(circle at 50% 0%, rgba(77, 231, 255, 0.20), transparent 58%),
        linear-gradient(180deg, rgba(20, 38, 56, 0.78) 0%, rgba(6, 14, 28, 0.86) 100%);
    border: 1px solid rgba(125, 232, 255, 0.36);
    box-shadow:
        0 10px 24px rgba(0, 0, 0, 0.42),
        inset 0 1px 0 rgba(255, 255, 255, 0.10);
    backdrop-filter: blur(22px);
    -webkit-backdrop-filter: blur(22px);
    height: 58px;
    font-size: inherit;
    letter-spacing: 0;
}

body.m-mf-plus .m-btn-copy.m-btn-fluid::after {
    background: linear-gradient(180deg, rgba(255, 255, 255, 0.10), transparent 50%);
}

body.m-mf-plus .m-btn-copy.m-btn-fluid .m-bf-icon {
    background:
        radial-gradient(circle at 35% 28%, rgba(125, 232, 255, 0.46), rgba(77, 231, 255, 0.18) 60%, rgba(2, 17, 28, 0.40));
    box-shadow:
        inset 0 1px 0 rgba(255, 255, 255, 0.20),
        inset 0 0 0 1px rgba(125, 232, 255, 0.26),
        0 4px 12px rgba(0, 0, 0, 0.26);
}

body.m-mf-plus .m-btn-copy.m-btn-fluid .mf-copy-emoji {
    font-size: 1.10rem;
    margin-bottom: 0;
    filter: drop-shadow(0 0 7px rgba(77, 231, 255, 0.48));
    width: auto;
    height: auto;
    background: transparent;
    box-shadow: none;
    border-radius: 0;
}

body.m-mf-plus .m-btn-copy.m-btn-fluid .m-bf-label {
    color: #e0fcff;
    text-shadow: 0 0 8px rgba(77, 231, 255, 0.34);
    font-size: 0.94rem;
}

body.m-mf-plus .m-btn-copy.m-btn-fluid .m-bf-sub {
    color: rgba(207, 247, 255, 0.58);
    font-weight: 500;
}

body.m-mf-plus .m-btn-copy.m-btn-fluid i { display: none; }

body.m-mf-plus .m-action-modal {
    backdrop-filter: blur(18px) saturate(140%);
    -webkit-backdrop-filter: blur(18px) saturate(140%);
    background: radial-gradient(ellipse at 50% 30%, rgba(2, 12, 24, 0.78), rgba(0, 4, 12, 0.92));
}

body.m-mf-plus .m-am-card {
    border-radius: 26px;
    background:
        radial-gradient(ellipse at 0% 0%, rgba(77, 231, 255, 0.14), transparent 42%),
        radial-gradient(ellipse at 100% 0%, rgba(139, 92, 246, 0.10), transparent 45%),
        linear-gradient(180deg, rgba(11, 24, 42, 0.94), rgba(3, 9, 20, 0.98));
    border: 1px solid rgba(125, 232, 255, 0.22);
    box-shadow:
        0 28px 60px rgba(0, 0, 0, 0.62),
        0 0 0 1px rgba(255, 255, 255, 0.03) inset,
        inset 0 1px 0 rgba(255, 255, 255, 0.10);
    position: relative;
    overflow: hidden;
}

body.m-mf-plus .m-am-card::before {
    background: linear-gradient(90deg, transparent, rgba(77, 231, 255, 0.65), rgba(139, 92, 246, 0.55), rgba(255, 122, 217, 0.40), transparent);
    box-shadow: 0 0 14px rgba(77, 231, 255, 0.45);
}

body.m-mf-plus .m-am-title {
    font-family: 'Rajdhani', sans-serif;
    font-weight: 900;
    letter-spacing: 1.8px;
    text-transform: uppercase;
    color: #e6fbff;
    text-shadow: 0 0 12px rgba(77, 231, 255, 0.32);
    font-size: 1rem;
}

body.m-mf-plus .m-am-subtitle {
    font-family: 'Outfit', sans-serif;
    font-size: 0.74rem;
    color: rgba(207, 245, 252, 0.72);
    text-wrap: balance;
}

body.m-mf-plus .m-flux-terminal {
    border-radius: 16px;
    border: 1px solid rgba(125, 232, 255, 0.24);
    border-left: 3px solid #6ef0ff;
    background: linear-gradient(180deg, rgba(0, 4, 12, 0.96), rgba(0, 1, 6, 1));
    box-shadow:
        inset 0 0 22px rgba(0, 0, 0, 0.85),
        0 8px 18px rgba(0, 0, 0, 0.36),
        0 0 18px rgba(77, 231, 255, 0.10);
}

body.m-mf-plus .m-flux-header {
    border-bottom: 1px solid rgba(125, 232, 255, 0.18);
    background: linear-gradient(90deg, rgba(77, 231, 255, 0.08), transparent);
    color: #b9fbff;
    font-family: 'Rajdhani', sans-serif;
    font-weight: 800;
    letter-spacing: 1.6px;
    text-transform: uppercase;
    font-size: 0.66rem;
    padding: 8px 12px;
    text-shadow: 0 0 8px rgba(77, 231, 255, 0.28);
}

body.m-mf-plus .m-flux-input {
    background: transparent;
    color: #6ef0ff;
    font-family: 'Consolas', 'Courier New', monospace;
    font-size: 0.74rem;
    padding: 10px 12px;
    text-shadow: 0 0 6px rgba(77, 231, 255, 0.25);
}

body.m-mf-plus .m-act-btn {
    border-radius: 16px;
    font-family: 'Rajdhani', sans-serif;
    font-weight: 900;
    letter-spacing: 1.6px;
    text-transform: uppercase;
    transition: transform 0.18s cubic-bezier(0.34, 1.56, 0.64, 1), box-shadow 0.18s ease;
    position: relative;
    overflow: hidden;
    border: 1px solid transparent;
}

body.m-mf-plus .m-act-copy {
    background:
        linear-gradient(135deg, #c8fcff 0%, #6ef0ff 28%, #22d3ee 60%, #00a7ff 100%);
    color: #001722;
    border-color: rgba(255, 255, 255, 0.42);
    box-shadow:
        0 12px 28px rgba(0, 213, 255, 0.34),
        inset 0 1px 0 rgba(255, 255, 255, 0.75),
        inset 0 -2px 0 rgba(0, 0, 0, 0.16);
    text-shadow: 0 1px 0 rgba(255, 255, 255, 0.5);
}

body.m-mf-plus .m-act-copy:active {
    transform: scale(0.97);
}

body.m-mf-plus .m-act-close {
    background:
        linear-gradient(180deg, rgba(20, 38, 56, 0.82) 0%, rgba(6, 14, 28, 0.88) 100%);
    color: rgba(207, 245, 252, 0.86);
    border-color: rgba(125, 232, 255, 0.28);
    box-shadow:
        0 8px 18px rgba(0, 0, 0, 0.42),
        inset 0 1px 0 rgba(255, 255, 255, 0.08);
}

body.m-mf-plus .m-act-close:active {
    transform: scale(0.97);
    background: rgba(125, 232, 255, 0.10);
}

body.m-mf-plus .m-toast {
    border-radius: 16px;
    background:
        radial-gradient(circle at 0% 0%, rgba(77, 231, 255, 0.18), transparent 45%),
        linear-gradient(180deg, rgba(11, 24, 42, 0.94), rgba(3, 9, 20, 0.98));
    border: 1px solid rgba(125, 232, 255, 0.30);
    box-shadow:
        0 14px 32px rgba(0, 0, 0, 0.52),
        inset 0 1px 0 rgba(255, 255, 255, 0.10),
        0 0 24px rgba(77, 231, 255, 0.14);
    backdrop-filter: blur(20px);
    -webkit-backdrop-filter: blur(20px);
    color: #e6fbff;
    font-family: 'Outfit', sans-serif;
}

body.m-mf-plus .m-toast.success {
    border-color: rgba(52, 211, 153, 0.45);
    box-shadow:
        0 14px 32px rgba(0, 0, 0, 0.52),
        inset 0 1px 0 rgba(255, 255, 255, 0.10),
        0 0 24px rgba(52, 211, 153, 0.22);
}

body.m-mf-plus .m-toast.error {
    border-color: rgba(255, 99, 132, 0.45);
    box-shadow:
        0 14px 32px rgba(0, 0, 0, 0.52),
        inset 0 1px 0 rgba(255, 255, 255, 0.10),
        0 0 24px rgba(255, 99, 132, 0.22);
}

@media (max-width: 360px) {
    body.m-mf-plus .m-btn-fluid {
        padding: 7px 11px 7px 7px;
        height: 54px;
        min-height: 54px;
        gap: 9px;
    }
    body.m-mf-plus .m-btn-fluid .m-bf-icon {
        width: 38px;
        height: 38px;
        font-size: 1.06rem;
        border-radius: 12px;
    }
    body.m-mf-plus .m-btn-fluid .m-bf-label {
        font-size: 0.88rem;
        letter-spacing: 1.4px;
    }
    body.m-mf-plus .m-btn-fluid .m-bf-sub {
        font-size: 0.60rem;
    }
    body.m-mf-plus .m-btn-install.m-btn-fluid,
    body.m-mf-plus .m-btn-copy.m-btn-fluid { height: 54px; }
    body.m-mf-plus .m-cred-opt { min-height: 84px; padding: 12px 5px 10px; }
    body.m-mf-plus .m-cred-icon { font-size: 1.78rem; }
    body.m-mf-plus .m-cred-name { font-size: 0.58rem; }
    body.m-mf-plus .m-nav-item { width: 64px; }
}

@media (max-width: 320px) {
    body.m-mf-plus .m-btn-fluid .m-bf-sub { display: none; }
    body.m-mf-plus .m-btn-fluid {
        height: 50px;
        min-height: 50px;
    }
    body.m-mf-plus .m-btn-install.m-btn-fluid,
    body.m-mf-plus .m-btn-copy.m-btn-fluid { height: 50px; }
}


/* Copiato da smartphone__9_: strato iniziale hero/logo, senza alterare menu e contenuti sotto */
:root {
    --u-ink-1: rgba(248, 253, 255, 0.98);
    --u-ink-2: rgba(220, 240, 248, 0.82);
    --u-ink-3: rgba(180, 212, 226, 0.62);
    --u-ink-4: rgba(140, 178, 198, 0.46);

    --u-cyan: #7df9ff;
    --u-cyan-soft: #aef6ff;
    --u-teal: #5eead4;
    --u-sky: #38bdf8;
    --u-deep: #0ea5e9;

    --u-glass-1: rgba(255, 255, 255, 0.045);
    --u-glass-2: rgba(255, 255, 255, 0.028);
    --u-glass-edge: rgba(255, 255, 255, 0.085);
    --u-glass-edge-soft: rgba(255, 255, 255, 0.055);

    --u-tint-1: rgba(125, 249, 255, 0.10);
    --u-tint-2: rgba(94, 234, 212, 0.07);
    --u-tint-3: rgba(56, 189, 248, 0.08);

    --u-shadow-ambient: 0 32px 80px -28px rgba(0, 18, 32, 0.72);
    --u-shadow-key:     0 14px 38px -12px rgba(0, 12, 24, 0.58);
    --u-shadow-soft:    0 8px 22px -8px rgba(0, 12, 24, 0.42);
    --u-shadow-lift:    0 20px 48px -16px rgba(0, 24, 42, 0.68);

    --u-r-card: 24px;
    --u-r-chip: 16px;
    --u-r-input: 18px;
    --u-r-pill: 999px;

    --u-blur: blur(28px) saturate(135%);
    --u-blur-strong: blur(40px) saturate(140%);
}

/* ── HERO: refined, less ornamental ── */
.m-hero {
    padding: 22px 8px 18px !important;
}
.m-hero-panel {
    padding: 14px 4px 22px !important;
}
.m-hero-panel::before {
    width: min(440px, 96vw) !important;
    height: 280px !important;
    filter: blur(36px) !important;
    opacity: 0.7 !important;
    background:
        radial-gradient(ellipse at 50% 30%, rgba(125, 249, 255, 0.34), rgba(94, 234, 212, 0.12) 32%, transparent 64%),
        radial-gradient(ellipse at 50% 80%, rgba(56, 189, 248, 0.18), transparent 60%) !important;
}
.m-hero-panel::after {
    display: none !important;
}
.m-hero::before {
    width: min(360px, 92vw) !important;
    height: 280px !important;
    filter: blur(30px) !important;
    background: radial-gradient(circle at 50% 40%, rgba(125, 249, 255, 0.22) 0%, rgba(94, 234, 212, 0.08) 35%, transparent 72%) !important;
}
.m-hero::after {
    height: 1px !important;
    width: 60% !important;
    background: linear-gradient(90deg, transparent, rgba(125, 249, 255, 0.55), transparent) !important;
    box-shadow: 0 0 14px rgba(125, 249, 255, 0.35) !important;
    opacity: 0.7 !important;
}

/* Logo — keep the breathing animation, refine the chrome */
.logo-container {
    width: 156px !important;
    height: 156px !important;
    margin-bottom: 14px !important;
    animation-duration: 7s !important;
}
.logo-container::before {
    inset: 8px !important;
    border: 1.5px solid rgba(125, 249, 255, 0.55) !important;
    background:
        radial-gradient(circle at 50% 35%, rgba(11, 38, 56, 0.96) 0%, rgba(2, 10, 22, 0.99) 65%, rgba(0, 4, 12, 1) 100%) !important;
    box-shadow:
        0 0 0 1px rgba(255, 255, 255, 0.05),
        0 24px 60px -18px rgba(0, 24, 42, 0.85),
        0 0 28px rgba(125, 249, 255, 0.18),
        inset 0 1px 0 rgba(255, 255, 255, 0.10),
        inset 0 0 24px rgba(56, 189, 248, 0.08) !important;
}
.logo-container::after {
    inset: -6px !important;
    background: radial-gradient(circle, rgba(125, 249, 255, 0.14) 0%, rgba(94, 234, 212, 0.05) 38%, transparent 72%) !important;
    filter: blur(14px) !important;
}
.logo-container .m-abyss-crown {
    background:
        conic-gradient(from 220deg,
            transparent 0 14%,
            rgba(125, 249, 255, 0.22) 22%,
            transparent 32% 48%,
            rgba(94, 234, 212, 0.18) 56%,
            transparent 66% 82%,
            rgba(56, 189, 248, 0.20) 90%,
            transparent 100%) !important;
    filter: blur(4px) !important;
    opacity: 0.85 !important;
}
.logo-image {
    filter:
        drop-shadow(0 14px 26px rgba(0, 8, 18, 0.55))
        drop-shadow(0 0 12px rgba(125, 249, 255, 0.18))
        brightness(1.06) saturate(1.04) !important;
}

/* Brand title — refined, less drop-shadow halo */
.m-brand-title,
.m-abyss-title {
    font-size: clamp(2.5rem, 11.5vw, 3.1rem) !important;
    font-weight: 800 !important;
    letter-spacing: -0.5px !important;
    line-height: 0.92 !important;
    background: linear-gradient(180deg, #ffffff 0%, #e8fcff 22%, #7df9ff 52%, #38bdf8 82%, #6ec8f5 100%) !important;
    -webkit-background-clip: text !important;
    background-clip: text !important;
    -webkit-text-fill-color: transparent !important;
    filter: drop-shadow(0 0 18px rgba(125, 249, 255, 0.22)) drop-shadow(0 10px 20px rgba(0, 8, 18, 0.42)) !important;
}
.m-brand-title::after,
.m-abyss-title::after {
    width: 64% !important;
    height: 1.5px !important;
    margin-top: 11px !important;
    background: linear-gradient(90deg, transparent, rgba(125, 249, 255, 0.7), rgba(94, 234, 212, 0.45), transparent) !important;
    box-shadow: 0 0 16px rgba(125, 249, 255, 0.32) !important;
    opacity: 0.78 !important;
}
.m-brand-sub,
.m-abyss-sub {
    font-size: 0.66rem !important;
    letter-spacing: 5.5px !important;
    color: rgba(174, 246, 255, 0.86) !important;
    text-shadow: 0 0 12px rgba(125, 249, 255, 0.4) !important;
    margin-top: 10px !important;
    font-weight: 700 !important;
}
.m-brand-sub::before, .m-brand-sub::after,
.m-abyss-sub::before, .m-abyss-sub::after {
    width: 22px !important;
    box-shadow: 0 0 6px rgba(125, 249, 255, 0.45) !important;
}
.m-brand-desc {
    font-size: 0.76rem !important;
    color: var(--u-ink-2) !important;
    margin-top: 14px !important;
    max-width: 310px !important;
    opacity: 0.92 !important;
    letter-spacing: 0.1px !important;
    line-height: 1.5 !important;
}

/* Hero badges — premium glass pills */
.m-hero-badges { gap: 7px !important; margin-top: 14px !important; }
.m-hero-badge {
    padding: 0 14px !important;
    min-height: 32px !important;
    border-radius: var(--u-r-pill) !important;
    border: 1px solid var(--u-glass-edge) !important;
    background:
        linear-gradient(180deg, rgba(125, 249, 255, 0.06), rgba(56, 189, 248, 0.025)) !important;
    box-shadow:
        inset 0 1px 0 rgba(255, 255, 255, 0.10),
        0 6px 16px -8px rgba(0, 18, 32, 0.45) !important;
    backdrop-filter: var(--u-blur) !important;
    -webkit-backdrop-filter: var(--u-blur) !important;
    color: var(--u-ink-1) !important;
    font-family: 'Outfit', sans-serif !important;
    font-weight: 600 !important;
    font-size: 0.68rem !important;
    letter-spacing: 0.6px !important;
    text-transform: none !important;
}

/* Version tag — quieter, no shimmer */
.m-version-tag,
.m-abyss-version {
    margin-top: 12px !important;
    padding: 5px 14px !important;
    font-size: 0.62rem !important;
    letter-spacing: 1.6px !important;
    background:
        linear-gradient(180deg, rgba(125, 249, 255, 0.08), rgba(56, 189, 248, 0.04)) !important;
    border: 1px solid rgba(125, 249, 255, 0.22) !important;
    border-radius: var(--u-r-pill) !important;
    box-shadow:
        inset 0 1px 0 rgba(255, 255, 255, 0.08),
        0 0 18px -4px rgba(125, 249, 255, 0.20) !important;
    color: var(--u-ink-1) !important;
    animation: none !important;
}
.m-version-tag::before { display: none !important; }

@media (max-width: 340px) {
    .m-brand-title { font-size: 2.6rem !important; }
    .m-brand-desc { font-size: 0.70rem !important; max-width: 280px !important; }
    .logo-container { width: 138px !important; height: 138px !important; }
}

/* ── Sanitize residual neon/uppercase from earlier layers ── */
.m-brand-sub::before, .m-brand-sub::after,
.m-abyss-sub::before, .m-abyss-sub::after {
    background: linear-gradient(90deg, transparent, rgba(125, 249, 255, 0.7)) !important;
}
.m-brand-sub::after, .m-abyss-sub::after {
    background: linear-gradient(90deg, rgba(125, 249, 255, 0.7), transparent) !important;
}

body.m-mf-plus .m-abyss-hero {
    margin: 4px 0 14px !important;
    position: relative !important;
    isolation: isolate !important;
    overflow: visible !important;
}

`;

const mobileHTML = `
<div class="m-caustic" aria-hidden="true">
    <div class="m-caustic-ray" style="--ray-x:8%;--ray-dur:14s;--ray-op:0.55;--ray-from:-12deg;--ray-to:6deg;width:50px;"></div>
    <div class="m-caustic-ray" style="--ray-x:28%;--ray-dur:11s;--ray-op:0.40;--ray-from:-6deg;--ray-to:14deg;width:35px;"></div>
    <div class="m-caustic-ray" style="--ray-x:50%;--ray-dur:16s;--ray-op:0.65;--ray-from:-10deg;--ray-to:8deg;width:65px;"></div>
    <div class="m-caustic-ray" style="--ray-x:68%;--ray-dur:9s;--ray-op:0.35;--ray-from:5deg;--ray-to:-12deg;width:40px;"></div>
    <div class="m-caustic-ray" style="--ray-x:85%;--ray-dur:13s;--ray-op:0.50;--ray-from:8deg;--ray-to:-6deg;width:55px;"></div>
</div>
<div class="m-sea-motion" aria-hidden="true">
    <div class="m-sea-band band-1"></div>
    <div class="m-sea-band band-2"></div>
    <div class="m-sea-band band-3"></div>
</div>
<div class="m-ocean-particles" id="m-ocean-particles" aria-hidden="true"></div>
<div id="app-container">
    <div class="m-content-wrapper">
        <div class="m-ptr" id="m-ptr-indicator"><i class="fas fa-arrow-down m-ptr-icon"></i></div>

        <div class="m-content">
            <div class="m-hero m-abyss-hero notranslate" aria-label="LEVIATHAN Kit" translate="no" data-no-translate="true">
                <div class="m-hero-panel">
                    <div class="logo-container m-abyss-logo">
                        <span class="m-abyss-crown" aria-hidden="true"></span>
                        <img src="${MOBILE_LOGO_URL}" alt="LEVIATHAN Logo" class="logo-image notranslate" translate="no" data-no-translate="true" fetchpriority="high" decoding="sync" loading="eager" width="172" height="172">
                        <div class="logo-particles" aria-hidden="true">
                            <span class="logo-particle" style="left:18%; width:5px; height:5px; animation-delay:0s;"></span>
                            <span class="logo-particle" style="left:38%; width:3px; height:3px; animation-delay:2.4s;"></span>
                            <span class="logo-particle" style="left:63%; width:4px; height:4px; animation-delay:4.1s;"></span>
                            <span class="logo-particle" style="left:78%; width:3px; height:3px; animation-delay:6.2s;"></span>
                        </div>
                    </div>
                    <h1 class="m-brand-title m-abyss-title notranslate" translate="no" lang="zxx" data-brand-lock="LEVIATHAN" data-no-translate="true" aria-label="LEVIATHAN">LEVIATHAN</h1>
                    <div class="m-brand-sub m-abyss-sub">Sovrano degli abissi</div>
                    <div class="m-brand-desc">Cinema, serie TV e anime italiani in una dashboard mobile elegante, luminosa e pulita come acqua profonda.</div>
                    <div class="m-hero-badges">
                        <span class="m-hero-badge">🐬 Real-Debrid</span>
                        <span class="m-hero-badge">🧊 TorBox</span>
                        <span class="m-hero-badge">🦈 P2P</span>
                    </div>
                    <div class="m-version-tag m-abyss-version" aria-label="Versione 3.1.0">
                        <span class="m-v-dot" aria-hidden="true"></span>
                        <span>v3.1.0</span>
                    </div>
                </div>
            </div>

            <div id="page-setup" class="m-page active">

                <div class="m-hypervisor" style="margin-top:10px;">
                    <div class="m-hyp-header">
                        <span>🔑 ACCESSO & SERVIZI</span>
                        <i class="fas fa-fingerprint m-hyp-icon"></i>
                    </div>
                    <p class="m-panel-desc"><b>Configura l'accesso</b> scegliendo Real-Debrid, TorBox o P2P. La verifica live ti conferma subito se la chiave è pronta ✨🔐.</p>

                    <div class="m-cred-deck">
                        <div class="m-cred-opt cred-rd m-srv-btn active" onclick="setMService('rd', this)">
                            <div class="m-cred-icon">🐬</div>
                            <div class="m-cred-name">🐬 REAL-DEBRID</div>
                        </div>
                        <div class="m-cred-opt cred-tb m-srv-btn" onclick="setMService('tb', this)">
                            <div class="m-cred-icon">🧊</div>
                            <div class="m-cred-name">🧊 TORBOX</div>
                        </div>
                        <div class="m-cred-opt cred-p2p m-srv-btn" onclick="setMService('p2p', this)">
                            <div class="m-cred-icon">🦈</div>
                            <div class="m-cred-name">🦈 P2P MODE</div>
                        </div>
                    </div>

                    <div class="m-input-fuselage" id="box-apikey">
                        <div class="m-if-label">🔑 API KEY</div>
                        <div class="m-if-inner">
                            <div class="m-if-icon"><i class="fas fa-key"></i></div>
                            <input type="text" id="m-apiKey" class="m-if-field" placeholder="🔑 INCOLLA KEY..." oninput="handleMobileApiKeyInput()">
                            <div class="m-if-action" onclick="pasteTo('m-apiKey')"><i class="fas fa-paste"></i></div>
                            <div class="m-get-link" onclick="openApiPage()">GET <i class="fas fa-external-link-alt"></i></div>
                        </div>
                        <div class="m-key-status idle" id="m-keyStatus" aria-live="polite" aria-atomic="true">
                            <span class="m-key-status-dot"></span>
                            <span id="m-keyStatusText">🐬 RD / 🧊 TB live check disponibile.</span>
                        </div>
                    </div>

                    <div class="m-input-fuselage tmdb-box" id="box-tmdb">
                        <div class="m-if-label opt">🎬 TMDB OPTIONAL</div>
                        <div class="m-if-inner">
                            <div class="m-if-icon"><i class="fas fa-film"></i></div>
                            <input type="text" id="m-tmdb" class="m-if-field" placeholder="🎬 PERSONAL KEY..." oninput="updateLinkModalContent()">
                            <div class="m-if-action" onclick="pasteTo('m-tmdb')"><i class="fas fa-paste"></i></div>
                            <div class="m-get-link" style="color:var(--m-accent); border-color:var(--m-accent); background:rgba(124, 58, 237,0.05);" onclick="openApiPage('tmdb')">GET <i class="fas fa-external-link-alt"></i></div>
                        </div>
                    </div>

                </div>

                <div class="m-hypervisor">
                     <div class="m-hyp-header">
                        <span>🍿 PROVIDER STREAMS ✨</span>
                        <i class="fas fa-cubes m-hyp-icon"></i>
                    </div>
                    <p class="m-panel-desc"><b>Scegli le sorgenti da attivare</b>: Leviathan unisce cinema, serie e anime italiani in un catalogo pulito, veloce e facile da controllare 🍿📺✨.</p>

                    <div class="m-reactor-grid">

                        <div class="m-reactor-module" id="mod-vix">
                            <div class="m-reactor-core">
                                <i class="fas fa-play-circle m-core-icon"></i>
                            </div>
                            <div class="m-reactor-body">
                                <div class="m-reactor-top">
                                    <span class="m-reactor-title">🍿 StreamingCommunity</span>
                                    <label class="m-switch">
                                        <input type="checkbox" id="m-enableVix" onchange="updateStatus('m-enableVix','st-vix'); toggleModuleStyle('m-enableVix', 'mod-vix');">
                                        <span class="m-slider"></span>
                                    </label>
                                </div>
                                <span class="m-reactor-desc">Film e serie TV in italiano, catalogo ricco e player rapido 🍿.</span>
                                <div class="m-tag-row">
                                    <span class="m-tech-tag tag-noproxy"><i class="fas fa-unlink"></i> NO PROXY</span>
                                </div>

                                <div id="m-sc-options" class="m-sc-subpanel">
                                    <div class="m-mini-tabs">
                                        <div class="m-mini-tab active" id="mq-sc-all" onclick="setScQuality('all')">HYBRID</div>
                                        <div class="m-mini-tab" id="mq-sc-1080" onclick="setScQuality('1080')">1080p</div>
                                        <div class="m-mini-tab" id="mq-sc-720" onclick="setScQuality('720')">720p</div>
                                    </div>
                                </div>
                            </div>
                        </div>

                        <div class="m-reactor-module" id="mod-ghd">
                            <div class="m-reactor-core">
                                <i class="fas fa-film m-core-icon"></i>
                            </div>
                            <div class="m-reactor-body">
                                <div class="m-reactor-top">
                                    <span class="m-reactor-title">🎬 GuardaHD</span>
                                    <label class="m-switch">
                                        <input type="checkbox" id="m-enableGhd" onchange="updateStatus('m-enableGhd','st-ghd'); toggleModuleStyle('m-enableGhd', 'mod-ghd');">
                                        <span class="m-slider"></span>
                                    </label>
                                </div>
                                <span class="m-reactor-desc">Film e serie TV in alta definizione, nuove uscite e schede ordinate 🎬.</span>
                                <div class="m-tag-row">
                                    <span class="m-tech-tag tag-kraken"><i class="fas fa-water"></i> KRAKEN</span>
                                </div>
                            </div>
                        </div>

                        <div class="m-reactor-module" id="mod-gs">
                            <div class="m-reactor-core">
                                <i class="fas fa-tv m-core-icon"></i>
                            </div>
                            <div class="m-reactor-body">
                                <div class="m-reactor-top">
                                    <span class="m-reactor-title">📺 GuardoSerie</span>
                                    <label class="m-switch">
                                        <input type="checkbox" id="m-enableGs" onchange="updateStatus('m-enableGs','st-gs'); toggleModuleStyle('m-enableGs', 'mod-gs');">
                                        <span class="m-slider m-slider-purple"></span>
                                    </label>
                                </div>
                                <span class="m-reactor-desc">Serie TV italiane organizzate per stagioni ed episodi 📺.</span>
                                <div class="m-tag-row">
                                    <span class="m-tech-tag tag-noproxy"><i class="fas fa-unlink"></i> NO PROXY</span>
                                </div>
                            </div>
                        </div>

                        <div class="m-reactor-module" id="mod-gstv">
                            <div class="m-reactor-core">
                                <i class="fas fa-satellite-dish m-core-icon"></i>
                            </div>
                            <div class="m-reactor-body">
                                <div class="m-reactor-top">
                                    <span class="m-reactor-title">📡 GuardaserieTV</span>
                                    <label class="m-switch">
                                        <input type="checkbox" id="m-enableGstv" onchange="updateStatus('m-enableGstv','st-gstv'); toggleModuleStyle('m-enableGstv', 'mod-gstv');">
                                        <span class="m-slider m-slider-aqua"></span>
                                    </label>
                                </div>
                                <span class="m-reactor-desc">Archivio serie TV ordinato, con navigazione semplice per episodio 📚.</span>
                                <div class="m-tag-row">
                                    <span class="m-tech-tag tag-noproxy"><i class="fas fa-unlink"></i> NO PROXY</span>
                                </div>
                            </div>
                        </div>

                        <div class="m-reactor-module" id="mod-es">
                            <div class="m-reactor-core">
                                <i class="fas fa-globe-europe m-core-icon"></i>
                            </div>
                            <div class="m-reactor-body">
                                <div class="m-reactor-top">
                                    <span class="m-reactor-title">🌍 Eurostreaming</span>
                                    <label class="m-switch">
                                        <input type="checkbox" id="m-enableEs" onchange="updateStatus('m-enableEs','st-es'); toggleModuleStyle('m-enableEs', 'mod-es');">
                                        <span class="m-slider m-slider-aqua"></span>
                                    </label>
                                </div>
                                <span class="m-reactor-desc">Portale italiano storico dedicato a serie TV e contenuti aggiornati ⭐.</span>
                                <div class="m-tag-row">
                                    <span class="m-tech-tag tag-kraken"><i class="fas fa-water"></i> KRAKEN</span>
                                </div>
                            </div>
                        </div>

                        <div class="m-reactor-module" id="mod-cb01">
                            <div class="m-reactor-core">
                                <i class="fas fa-film m-core-icon"></i>
                            </div>
                            <div class="m-reactor-body">
                                <div class="m-reactor-top">
                                    <span class="m-reactor-title">🎬 CB01</span>
                                    <label class="m-switch">
                                        <input type="checkbox" id="m-enableCb01" onchange="updateStatus('m-enableCb01','st-cb01'); toggleModuleStyle('m-enableCb01', 'mod-cb01');">
                                        <span class="m-slider m-slider-aqua"></span>
                                    </label>
                                </div>
                                <span class="m-reactor-desc">Ampio catalogo di film e serie TV, tra i riferimenti più noti in Italia 🎞️.</span>
                                <div class="m-tag-row">
                                    <span class="m-tech-tag tag-kraken"><i class="fas fa-water"></i> KRAKEN</span>
                                </div>
                            </div>
                        </div>

                        <div class="m-reactor-module" id="mod-aw">
                            <div class="m-reactor-core">
                                <i class="fas fa-torii-gate m-core-icon"></i>
                            </div>
                            <div class="m-reactor-body">
                                <div class="m-reactor-top">
                                    <span class="m-reactor-title">🐉 AnimeWorld</span>
                                    <label class="m-switch">
                                        <input type="checkbox" id="m-enableAnimeWorld" onchange="updateStatus('m-enableAnimeWorld','st-aw'); toggleModuleStyle('m-enableAnimeWorld', 'mod-aw');">
                                        <span class="m-slider m-slider-aqua"></span>
                                    </label>
                                </div>
                                <span class="m-reactor-desc">Anime sub-ita e doppiati, con schede serie e catalogo ampio 🌸.</span>
                                <div class="m-tag-row">
                                    <span class="m-tech-tag tag-noproxy"><i class="fas fa-unlink"></i> NO PROXY</span>
                                </div>
                            </div>
                        </div>

                        <div class="m-reactor-module" id="mod-au">
                            <div class="m-reactor-core">
                                <i class="fas fa-water m-core-icon"></i>
                            </div>
                            <div class="m-reactor-body">
                                <div class="m-reactor-top">
                                    <span class="m-reactor-title">🌊 AnimeUnity</span>
                                    <label class="m-switch">
                                        <input type="checkbox" id="m-enableAnimeUnity" onchange="updateStatus('m-enableAnimeUnity','st-au'); toggleModuleStyle('m-enableAnimeUnity', 'mod-au');">
                                        <span class="m-slider m-slider-aqua"></span>
                                    </label>
                                </div>
                                <span class="m-reactor-desc">Anime, simulcast e doppiaggi con episodi aggiornati e ordinati 🪄.</span>
                                <div class="m-tag-row">
                                    <span class="m-tech-tag tag-noproxy"><i class="fas fa-unlink"></i> NO PROXY</span>
                                </div>
                            </div>
                        </div>

                        <div class="m-reactor-module" id="mod-as">
                            <div class="m-reactor-core">
                                <i class="fas fa-satellite-dish m-core-icon"></i>
                            </div>
                            <div class="m-reactor-body">
                                <div class="m-reactor-top">
                                    <span class="m-reactor-title">🪐 AnimeSaturn</span>
                                    <label class="m-switch">
                                        <input type="checkbox" id="m-enableAnimeSaturn" onchange="updateStatus('m-enableAnimeSaturn','st-as'); toggleModuleStyle('m-enableAnimeSaturn', 'mod-as');">
                                        <span class="m-slider m-slider-aqua"></span>
                                    </label>
                                </div>
                                <span class="m-reactor-desc">Anime classici e recenti, archivio ampio e consultazione rapida 🪐.</span>
                                <div class="m-tag-row">
                                    <span class="m-tech-tag tag-noproxy"><i class="fas fa-unlink"></i> NO PROXY</span>
                                </div>
                            </div>
                        </div>

                        <div class="m-reactor-module" id="mod-gf">
                            <div class="m-reactor-core">
                                <i class="fas fa-play m-core-icon"></i>
                            </div>
                            <div class="m-reactor-body">
                                <div class="m-reactor-top">
                                    <span class="m-reactor-title">🎞️ GuardaFlix</span>
                                    <label class="m-switch">
                                        <input type="checkbox" id="m-enableGf" onchange="updateStatus('m-enableGf','st-gf'); toggleModuleStyle('m-enableGf', 'mod-gf');">
                                        <span class="m-slider m-slider-green"></span>
                                    </label>
                                </div>
                                <span class="m-reactor-desc">Film in streaming con raccolte per genere e ultime uscite 🎥.</span>
                                <div class="m-tag-row">
                                    <span class="m-tech-tag tag-noproxy"><i class="fas fa-unlink"></i> NO PROXY</span>
                                </div>
                            </div>
                        </div>

                        <div class="m-reactor-module" id="mod-cc">
                            <div class="m-reactor-core">
                                <i class="fas fa-city m-core-icon"></i>
                            </div>
                            <div class="m-reactor-body">
                                <div class="m-reactor-top">
                                    <span class="m-reactor-title">🎟️ CinemaCity</span>
                                    <label class="m-switch">
                                        <input type="checkbox" id="m-enableCc" onchange="updateStatus('m-enableCc','st-cc'); toggleModuleStyle('m-enableCc', 'mod-cc');">
                                        <span class="m-slider"></span>
                                    </label>
                                </div>
                                <span class="m-reactor-desc">Film e serie TV con catalogo aggiornato e navigazione intuitiva 🎟️.</span>
                                <div class="m-tag-row">
                                    <span class="m-tech-tag tag-noproxy"><i class="fas fa-unlink"></i> NO PROXY</span>
                                </div>
                            </div>
                        </div>

                    </div>
                </div>

                <div id="m-priority-panel" class="m-priority-wrapper">
                    <div style="margin-top:5px; padding:15px; border-radius:16px; background:linear-gradient(90deg, rgba(112,0,255,0.1), transparent); border-left:4px solid var(--m-secondary);">
                        <div style="display:flex; justify-content:space-between; align-items:center;">
                            <div>
                                <h5 style="margin:0; font-family:'Rajdhani'; color:#fff;">🚀 PRIORITÀ WEB</h5>
                                <p id="priority-desc" style="margin:5px 0 0; font-size:0.8rem; color:var(--m-dim);">Mostra Web in cima</p>
                            </div>
                            <label class="m-switch">
                                <input type="checkbox" id="m-vixLast" onchange="updatePriorityLabel()">
                                <span class="m-slider" style="border-color:var(--m-secondary)"></span>
                            </label>
                        </div>
                    </div>
                </div>

                <div class="m-credits-section">
                    <div class="m-neural-frame">
                        <div class="m-neural-header">
                            <span class="m-nh-title">/// NEURAL SIGNATURE ///</span>
                            <span class="m-nh-id">ID: L3V-2026</span>
                        </div>

                        <div class="m-neural-grid">
                            <a href="https://github.com/LUC4N3X/stremio-leviathan-addon" target="_blank" class="m-dev-module">
                                <img src="https://i.ibb.co/gLkrjxXT/Whats-App-Image-2026-01-12-at-20-15-37.jpg" alt="Dev" class="m-dev-img">
                                <div class="m-dev-data">
                                    <span class="m-dev-role">ARCHITECT</span>
                                    <span class="m-dev-nick">LUC4N3X</span>
                                </div>
                                <i class="fab fa-github" style="position:absolute; right:10px; top:10px; color:rgba(255,255,255,0.1); font-size:1.5rem;"></i>
                            </a>

                            <a href="https://ko-fi.com/luc4n3x" target="_blank" class="m-support-module">
                                <i class="fas fa-mug-hot m-kofi-ico"></i>
                                <span class="m-support-txt">KO-FI</span>
                            </a>
                        </div>

                        <a href="https://stremio-addons.net/addons/leviathan" target="_blank" class="m-star-btn">
                            <i class="fas fa-star spin-star"></i>
                            <span>LASCIAMI UNA STELLA</span>
                            <i class="fas fa-star spin-star"></i>
                        </a>

                        <div class="m-neural-footer">LEVIATHAN SYSTEM v2.7.0</div>
                    </div>
                </div>
            </div>

            <div id="page-filters" class="m-page">

                <div class="m-hypervisor">
                    <div class="m-hyp-header">
                        <span>⚙️ REGOLE STREAM</span>
                        <i class="fas fa-microchip m-hyp-icon"></i>
                    </div>

                    <p class="m-panel-desc"><b>Controlla cosa mostra Leviathan</b>: ordina per qualità, scegli la lingua, limita i risultati e mantieni la lista pulita anche su smartphone 🎯📱.</p>

                    <div class="m-flux-control">
                        <div class="m-flux-grid">
                            <div class="m-flux-opt active-bal" id="sort-balanced" onclick="setSortMode('balanced')">
                                <i class="fas fa-dragon"></i>
                                <span>🐉 SMART</span>
                            </div>
                            <div class="m-flux-opt" id="sort-resolution" onclick="setSortMode('resolution')">
                                <i class="fas fa-gem"></i>
                                <span>💎 QUALITY</span>
                            </div>
                            <div class="m-flux-opt" id="sort-size" onclick="setSortMode('size')">
                                <i class="fas fa-hdd"></i>
                                <span>💾 SIZE</span>
                            </div>
                        </div>

                        <div class="m-flux-readout mode-bal" id="flux-readout-box">
                            <i class="fas fa-info-circle m-fr-icon" id="flux-icon-display"></i>
                            <div class="m-fr-text">
                                <span class="m-fr-title" id="flux-title-display">STANDARD MODE</span>
                                <span class="m-fr-desc" id="flux-desc-display">L'algoritmo standard di Leviathan ✨. Bilancia perfettamente qualita e velocita ⚡.</span>
                            </div>
                        </div>
                    </div>

                    <div class="m-hyp-header" style="margin-top:25px; border-top:none; padding-top:0; margin-bottom:10px;">
                         <span>🗣️ AUDIO &amp; LINGUA</span>
                         <i class="fas fa-globe-americas m-hyp-icon"></i>
                    </div>

                    <div class="m-lang-grid">
                        <div class="m-lang-opt active-ita" id="lang-ita" onclick="setLangMode('ita')">
                            <i class="fas fa-flag"></i>
                            <span class="m-lang-txt">🇮🇹 ITA</span>
                        </div>
                        <div class="m-lang-opt" id="lang-all" onclick="setLangMode('all')">
                            <i class="fas fa-comments"></i>
                            <span class="m-lang-txt">🇮🇹+🇬🇧</span>
                        </div>
                        <div class="m-lang-opt" id="lang-eng" onclick="setLangMode('eng')">
                            <i class="fas fa-flag-usa"></i>
                            <span class="m-lang-txt">🇬🇧 ENG</span>
                        </div>
                    </div>

                    <div id="lang-desc-container" style="background: rgba(0,0,0,0.2); border-radius: 8px; padding: 10px; margin-bottom: 25px; border-left: 3px solid var(--m-primary);">
                        <p id="lang-description" style="margin:0; font-size: 0.7rem; color: var(--m-dim); line-height: 1.3; font-family:'Outfit';">
                             Cerca solo contenuti in Italiano 🇮🇹. Ignora tutto il resto.
                        </p>
                    </div>

                    <div class="m-hyp-label">📺 Resolution Filter</div>
                    <p class="m-hyp-desc">Tocca per escludere qualità specifiche.</p>

                    <div class="m-chip-grid">
                        <div class="m-qual-chip" id="mq-4k" onclick="toggleFilter('mq-4k')">💎 4K</div>
                        <div class="m-qual-chip" id="mq-1080" onclick="toggleFilter('mq-1080')">🎬 1080p</div>
                        <div class="m-qual-chip" id="mq-720" onclick="toggleFilter('mq-720')">📺 720p <span class="mini-tag">HD</span></div>
                        <div class="m-qual-chip" id="mq-sd" onclick="toggleFilter('mq-sd')">📼 CAM/SD</div>
                    </div>

                    <div class="m-sys-grid">
                        <div class="m-sys-row">
                            <div class="m-sys-info"><h4><i class="fas fa-layer-group" style="color:var(--m-accent)"></i> 🧩 AIO Mode <span class="m-status-text" id="st-aio">OFF</span></h4><p>Formatta per AIOStreams 🧩</p></div>
                            <label class="m-switch"><input type="checkbox" id="m-aioMode" onchange="updateStatus('m-aioMode','st-aio')"><span class="m-slider m-slider-purple"></span></label>
                        </div>
                        <div class="m-sys-row">
                            <div class="m-sys-info"><h4><i class="fas fa-cloud" style="color:var(--m-primary)"></i> ☁️ Debrid Cloud <span class="m-status-text" id="st-savedcloud">OFF</span></h4><p>File salvati RD/TorBox 📦. Duplicati sempre esclusi ✨.</p></div>
                            <label class="m-switch"><input type="checkbox" id="m-enableSavedCloud" onchange="toggleSavedCloud()"><span class="m-slider"></span></label>
                        </div>
                        <div class="m-cloud-mode-panel" id="m-savedCloudPanel">
                            <div class="m-cloud-mode-grid">
                                <div class="m-cloud-mode-btn active" id="m-cloud-smart" onclick="setSavedCloudMode('smart')">SMART<span>utile e pulito ✨</span></div>
                                <div class="m-cloud-mode-btn" id="m-cloud-fallback" onclick="setSavedCloudMode('fallback')">FALLBACK<span>solo se trova poco 🪄</span></div>
                                <div class="m-cloud-mode-btn" id="m-cloud-always" onclick="setSavedCloudMode('always')">ALWAYS<span>sempre no doppioni ✅</span></div>
                            </div>
                            <p class="m-cloud-note">Usa solo Real-Debrid/TorBox configurati ☁️. Anche in ALWAYS, se Leviathan ha gia lo stesso hash/file, il Cloud non viene mostrato ✨.</p>
                        </div>
                    </div>

                    <div class="m-row" style="border:none; padding: 5px 0;">
                        <div class="m-label">
                            <h4><i class="fas fa-compress-arrows-alt" style="color:var(--m-error)"></i> 🚦 Signal Gate <span class="m-status-text" id="st-gate">OFF</span></h4>
                            <p style="font-size:0.65rem; color:var(--m-error);">Filtro qualità • max risultati per risoluzione 🚦</p>
                        </div>
                        <label class="m-switch"><input type="checkbox" id="m-gateActive" onchange="toggleGate()"><span class="m-slider"></span></label>
                    </div>
                    <div id="m-gate-wrapper" class="m-gate-wrapper">
                        <div class="m-gate-control">
                            <span style="font-size:0.8rem; color:#666;">1</span>
                            <input type="range" min="1" max="20" value="3" class="m-range" id="m-gateVal" oninput="updateGateDisplay(this.value)">
                            <span style="font-family:'Rajdhani'; font-weight:800; font-size:1.2rem; color:var(--m-primary); width:30px; text-align:center;" id="m-gate-display">3</span>
                        </div>
                        <p class="m-range-desc">Limita il numero di risultati mostrati per ogni qualita 🎯. Utile per dispositivi lenti 📱.</p>
                    </div>

                    <div class="m-row" style="border:none; padding: 5px 0;">
                        <div class="m-label">
                            <h4><i class="fas fa-weight-hanging" style="color:var(--m-amber)"></i> ⚖️ Size Limit <span class="m-status-text" id="st-size">OFF</span></h4>
                            <p style="font-size:0.65rem; color:var(--m-amber);">Filtro peso massimo • GB ⚖️</p>
                        </div>
                        <label class="m-switch"><input type="checkbox" id="m-sizeActive" onchange="toggleSize()"><span class="m-slider m-slider-aqua"></span></label>
                    </div>
                     <div id="m-size-wrapper" class="m-gate-wrapper">
                        <div class="m-gate-control">
                            <span style="font-size:0.8rem; color:#666;">1GB</span>
                            <input type="range" min="1" max="100" step="1" value="0" class="m-range" id="m-sizeVal" oninput="updateSizeDisplay(this.value)" style="background:linear-gradient(90deg, #ff9900, #333)">
                            <span style="font-family:'Rajdhani'; font-weight:800; font-size:1.1rem; color:var(--m-amber); width:45px; text-align:center;" id="m-size-display">INF</span>
                        </div>
                         <p class="m-range-desc">Nasconde automaticamente tutti i file che superano la dimensione selezionata 📦.</p>
                    </div>

                </div>
            </div>

            <div id="page-network" class="m-page">

                <div class="m-hypervisor">
                    <div class="m-hyp-header">
                        <span>🌐 SERVER & PROXY ✨</span>
                        <i class="fas fa-network-wired m-hyp-icon" style="color:var(--m-secondary); border-color:rgba(112,0,255,0.35); background:rgba(112,0,255,0.08);"></i>
                    </div>
                    <p class="m-panel-desc"><b>Imposta un proxy personalizzato</b> solo quando serve. Altrimenti Leviathan resta sulla configurazione standard, più semplice e pulita 🌊.</p>

                    <div style="padding:0 5px;">
                        <p style="font-size:0.8rem; color:var(--m-dim); margin-bottom:20px; line-height:1.4;">
                            Configura un endpoint proxy solo se ti serve un bridge personalizzato per le sorgenti italiane 🌊. Lascia vuoto per usare la gestione standard di Leviathan ✨.
                        </p>

                        <div class="m-field-group">
                            <div class="m-field-header"><span class="m-field-label">🌐 SERVER URL</span></div>
                            <div class="m-input-box">
                                <i class="fas fa-server m-input-ico"></i>
                                <input type="text" id="m-mfUrl" class="m-input-tech" placeholder="https://tuo-proxy.com" oninput="updateLinkModalContent()">
                                <div class="m-paste-action" onclick="pasteTo('m-mfUrl')"><i class="fas fa-paste"></i></div>
                            </div>
                        </div>

                        <div class="m-field-group">
                            <div class="m-field-header"><span class="m-field-label">🔒 PASSWORD</span></div>
                            <div class="m-input-box">
                                <i class="fas fa-lock m-input-ico"></i>
                                <input type="password" id="m-mfPass" class="m-input-tech" placeholder="********" oninput="updateLinkModalContent()">
                            </div>
                        </div>

                        <div class="m-ghost-panel" id="ghost-zone-box">
                            <div class="m-ghost-head">
                                <div class="m-ghost-title"><i class="fas fa-user-shield"></i> 👻 DEBRID GHOST</div>
                                <div class="m-ghost-status" id="ghost-status-text">VISIBLE</div>
                            </div>
                            <div style="display:flex; justify-content:space-between; align-items:center;">
                                <p style="margin:0; font-size:0.75rem; color:rgba(255,255,255,0.6); max-width:70%;">
                                    Instrada il traffico Debrid attraverso il Proxy configurato.
                                </p>
                                <label class="m-switch">
                                    <input type="checkbox" id="m-proxyDebrid" onchange="updateGhostVisuals(); updateLinkModalContent()">
                                    <span class="m-slider m-slider-purple"></span>
                                </label>
                            </div>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    </div>

    <div class="m-dock-container">
        <div class="m-dock-actions m-dock-actions-fluid">
            <button class="m-btn-install m-btn-fluid" onclick="mobileInstall()">
                <span class="m-bf-halo" aria-hidden="true"></span>
                <span class="m-bf-icon" aria-hidden="true">
                    <span class="mf-btn-emoji">⚡</span><i class="fas fa-download"></i>
                </span>
                <span class="m-bf-stack">
                    <span class="m-bf-label">INSTALLA</span>
                    <span class="m-bf-sub">Apri su Stremio</span>
                </span>
            </button>
            <button class="m-btn-copy m-btn-fluid" onclick="openLinkModal()">
                <span class="m-bf-icon" aria-hidden="true">
                    <span class="mf-copy-emoji">🔗</span><i class="fas fa-link"></i>
                </span>
                <span class="m-bf-stack">
                    <span class="m-bf-label">COPIA</span>
                    <span class="m-bf-sub">Manifest URL</span>
                </span>
            </button>
        </div>
        <div class="m-dock-nav">
            <div class="m-nav-item active" onclick="navTo('setup', this)">
                <span class="mf-nav-emoji">🧩</span><i class="fas fa-sliders-h"></i><span>SETUP</span>
            </div>
            <div class="m-nav-item" onclick="navTo('filters', this)">
                <span class="mf-nav-emoji">🎛️</span><i class="fas fa-filter"></i><span>FILTRI</span>
            </div>
            <div class="m-nav-item" onclick="navTo('network', this)">
                <span class="mf-nav-emoji">🌐</span><i class="fas fa-globe"></i><span>NET</span>
            </div>
        </div>
    </div>

    <div class="m-action-modal" id="m-link-modal">
        <div class="m-am-card">
            <div class="m-am-title">🔗 LINK GENERATO</div>
            <div class="m-am-subtitle">Installa, copia o condividi la configurazione pronta</div>

            <div class="m-flux-terminal">
                <div class="m-flux-header">
                    <span>🌊 OCEAN LINK STREAM</span>
                    <i class="fas fa-network-wired"></i>
                </div>
                <textarea id="m-generatedUrlBox" class="m-flux-input" readonly>/// WAITING FOR DATA ///</textarea>
            </div>

            <div class="m-act-btn m-act-copy" onclick="copyFromModal()">
                <i class="fas fa-copy"></i> 📋 COPIA NEGLI APPUNTI
            </div>

            <div class="m-act-btn m-act-close" onclick="closeLinkModal()">
                ✕ CHIUDI
            </div>
        </div>
    </div>

    <div class="m-toast-container" id="m-toast-area"></div>

</div>
`;

let mCurrentService = 'rd';
let mScQuality = 'all';
let mSortMode = 'balanced';
let mSkin = 'leviathan';
let mLangMode = 'ita';
let mSavedCloudMode = 'smart';
const mDebridValidationState = {
    timer: null,
    requestId: 0,
    status: 'idle',
    resolvedKey: '',
    resolvedService: ''
};

const fluxData = {
    'balanced': {
        title: "🐉 SMART BALANCE",
        desc: "Profilo intelligente: bilancia qualità, seed/cache e velocità.",
        icon: "fa-dragon"
    },
    'resolution': {
        title: "💎 QUALITY FIRST",
        desc: "4K e 1080p sopra: priorità alla qualità visiva.",
        icon: "fa-gem"
    },
    'size': {
        title: "💾 BITRATE HEAVY",
        desc: "Ordina per peso/file: utile per massimo bitrate.",
        icon: "fa-hdd"
    }
};

const langDescriptions = {
    'ita': "🇮🇹 Solo contenuti in Italiano. Ignora tutto il resto.",
    'all': "🇮🇹 Prima Italiano, poi 🇬🇧 Inglese se serve.",
    'eng': "🇬🇧 Solo contenuti in Inglese."
};

function toStylized(text, type = 'std') {
            if (!text) return "";
            text = String(text);
            const maps = {
                'bold': {
                    nums: {'0':'𝟬','1':'𝟭','2':'𝟮','3':'𝟯','4':'𝟰','5':'𝟱','6':'𝟲','7':'𝟳','8':'𝟴','9':'𝟵'},
                    chars: {'A':'𝗔','B':'𝗕','C':'𝗖','D':'𝗗','E':'𝗘','F':'𝗙','G':'𝗚','H':'𝗛','I':'𝗜','J':'𝗝','K':'𝗞','L':'𝗟','M':'𝗠','N':'𝗡','O':'𝗢','P':'𝗣','Q':'𝗤','R':'𝗥','S':'𝗦','T':'𝗧','U':'𝗨','V':'𝗩','W':'𝗪','X':'𝗫','Y':'𝗬','Z':'𝗭','a':'𝗮','b':'𝗯','c':'𝗰','d':'𝗱','e':'𝗲','f':'𝗳','g':'𝗴','h':'𝗵','i':'𝗶','j':'𝗷','k':'𝗸','l':'𝗹','m':'𝗺','n':'𝗻','o':'𝗼','p':'𝗽','q':'𝗾','r':'𝗿','s':'𝘀','t':'𝘁','u':'𝘂','v':'𝘃','w':'ᴡ','x':'𝘅','y':'𝘆','z':'𝘇'}
                },
                'spaced': {

                    nums: {'0':'0','1':'1','2':'2','3':'3','4':'4','5':'5','6':'6','7':'7','8':'8','9':'9'},
                    chars: {'A':'𝗔','B':'𝗕','C':'𝗖','D':'𝗗','E':'𝗘','F':'𝗙','G':'𝗚','H':'𝗛','I':'𝗜','J':'𝗝','K':'𝗞','L':'𝗟','M':'𝗠','N':'𝗡','O':'𝗢','P':'𝗣','Q':'𝗤','R':'𝗥','S':'𝗦','T':'𝗧','U':'𝗨','V':'𝗩','W':'𝗪','X':'𝗫','Y':'𝗬','Z':'𝗭'}
                },
                'small': {
                    nums: {'0':'0','1':'1','2':'2','3':'3','4':'4','5':'5','6':'6','7':'7','8':'8','9':'9'},
                    chars: {'A':'ᴀ','B':'ʙ','C':'ᴄ','D':'ᴅ','E':'ᴇ','F':'ꜰ','G':'ɢ','H':'ʜ','I':'ɪ','J':'ᴊ','K':'ᴋ','L':'ʟ','M':'ᴍ','N':'ɴ','O':'ᴏ','P':'ᴘ','Q':'ǫ','R':'ʀ','S':'ꜱ','T':'ᴛ','U':'ᴜ','V':'ᴠ','W':'ᴡ','X':'x','Y':'ʏ','Z':'ᴢ','a':'ᴀ','b':'ʙ','c':'ᴄ','d':'ᴅ','e':'ᴇ','f':'ꜰ','g':'ɢ','h':'ʜ','i':'ɪ','j':'ᴊ','k':'ᴋ','l':'ʟ','m':'ᴍ','n':'ɴ','o':'ᴏ','p':'ᴘ','q':'ǫ','r':'ʀ','s':'ꜱ','t':'ᴛ','u':'ᴜ','v':'ᴠ','w':'ᴡ','x':'x','y':'ʏ','z':'ᴢ'}
                }
            };
            if (type === 'spaced') {
                return text.split('').map(c => {
                    const map = maps['spaced'];
                    const char = (/[0-9]/.test(c) ? map.nums[c] : map.chars[c]) || c;
                    return char + ' ';
                }).join('').trim();
            }
            const map = maps[type] || maps['bold'];
            return text.split('').map(c => {
                if (/[0-9]/.test(c)) return map.nums[c] || c;
                return map.chars[c] || c;
            }).join('');
        }

function showToast(msg, type = 'info') {
    const container = document.getElementById('m-toast-area');
    if(!container) return;
    const el = document.createElement('div');
    el.className = `m-toast ${type}`;

    let icon = 'fa-info-circle';
    if(type === 'warning') icon = 'fa-exclamation-triangle';
    if(type === 'error') icon = 'fa-bug';
    if(type === 'success') icon = 'fa-check-circle';

    el.innerHTML = `<i class="fas ${icon}"></i> <span>${msg}</span>`;
    container.appendChild(el);

    mVibrate(20);

    setTimeout(() => {
        el.classList.add('out');
        setTimeout(() => el.remove(), 300);
    }, 3000);
}

function triggerPreviewUpdateEffect() {
    const layer = document.getElementById('m-recalc-layer');
    if(!layer) return;

    layer.classList.add('visible');
    setTimeout(() => {
        layer.classList.remove('visible');
    }, 400);
}

const MOBILE_FORMATTER_META = {
    leviathan: { label: 'Leviathan', preview: 'LEVIATHAN', icon: '♆', sub: 'Abyssal' },
    premium: { label: 'Apex Prime', preview: 'APEX PRIME', icon: '👑', sub: 'Flagship' },
    ultra_compact: { label: 'Pulse Compact', preview: 'PULSE COMPACT', icon: '⚡️', sub: 'Dense' },
    tv_compact: { label: 'Neon TV', preview: 'NEON TV', icon: '📺', sub: 'Big Screen' },
    lev2: { label: 'Architect', preview: 'ARCHITECT', icon: '🧬', sub: 'Structured' },
    fra: { label: 'Horizon', preview: 'HORIZON', icon: '⚡️', sub: 'Classic' },
    comet: { label: 'Comet', preview: 'COMET', icon: '☄️', sub: 'Scan' },
    stremio_ita: { label: 'ITA Mod', preview: 'ITA MOD', icon: '🇮🇹', sub: 'Compat' },
    dav: { label: 'Datastream', preview: 'DATASTREAM', icon: '📼', sub: 'Verbose' },
    pri: { label: 'Eclipse', preview: 'ECLIPSE', icon: '👑', sub: 'Prime' },
    and: { label: 'Matrix', preview: 'MATRIX', icon: '🎬', sub: 'Cinema' },
    lad: { label: 'Compact', preview: 'COMPACT', icon: '🎟️', sub: 'Lean' },
    torrentio: { label: 'Torrentio', preview: 'TORRENTIO', icon: '📜', sub: 'Classic' },
    vertical: { label: 'Vertical', preview: 'VERTICAL', icon: '📑', sub: 'Stacked' },
    android: { label: 'Android TV', preview: 'ANDROID TV', icon: '📺', sub: 'Console' },
    picture: { label: 'Picture', preview: 'PICTURE', icon: '🖼️', sub: 'Poster' },
    complex: { label: 'Template', preview: 'TEMPLATE', icon: '🔲', sub: 'Matrix' },
    custom: { label: 'Custom Builder', preview: 'CUSTOM OVERRIDE', icon: '⌨️', sub: 'Manual' }
};

const MOBILE_FORMATTER_ALIASES = {
    default: 'leviathan',
    pro: 'premium',
    cine: 'premium',
    cinema: 'premium',
    ultra: 'ultra_compact',
    ultracompact: 'ultra_compact',
    compact: 'ultra_compact',
    tv: 'tv_compact',
    tvcompact: 'tv_compact',
    android_tv: 'tv_compact'
};

function resolveMobileFormatterSkin(skinId) {
    const raw = String(skinId || 'leviathan').toLowerCase().trim();
    return MOBILE_FORMATTER_ALIASES[raw] || raw;
}

function getMobileFormatterMeta(skinId) {
    const resolved = resolveMobileFormatterSkin(skinId);
    return MOBILE_FORMATTER_META[resolved] || { label: resolved.toUpperCase(), preview: resolved.toUpperCase() };
}

function joinMobilePreviewParts(parts, sep = ' | ') {
    return parts.filter(Boolean).join(sep);
}

function removeMobilePreviewEmoji(value = '') {
    return String(value).replace(/[^A-Za-z0-9\s.\-|+()[\]\/&]/g, '').replace(/\s+/g, ' ').trim();
}

function selectMobileSkin(skinId) {
    skinId = resolveMobileFormatterSkin(skinId);
    const isAIO = mChecked('m-aioMode');

    if (isAIO && skinId !== 'leviathan') {
        const lockOverlay = document.getElementById('m-aio-lock-overlay');
        if (lockOverlay) {
            lockOverlay.classList.remove('m-denied-anim');
            void lockOverlay.offsetWidth;
            lockOverlay.classList.add('m-denied-anim');
        }

        mVibrate([50, 50, 50]);
        showToast("SKIN BLOCCATA DA AIO MODE", "warning");
        return;
    }

    mSkin = skinId;
    document.querySelectorAll('.m-cortex-chip').forEach(b => b.classList.remove('active'));
    const selectedBtn = document.getElementById('msk_' + skinId);
    if(selectedBtn) selectedBtn.classList.add('active');

    const customArea = document.getElementById('m-custom-skin-area');
    if (customArea) customArea.style.display = skinId === 'custom' ? 'block' : 'none';

    const previewBox = document.getElementById('m-preview-box');
    if(previewBox) {
        previewBox.classList.remove('glitching');
        void previewBox.offsetWidth;
        previewBox.classList.add('glitching');
    }
    updateMobilePreview();
    updateLinkModalContent();
    mVibrate(10);
}

function updateMobilePreviewLegacy() {
    return updateMobilePreview();
}

function updateMobilePreview() {
    const skin = resolveMobileFormatterSkin(mSkin);

    let langStr = '🇮🇹 ITA';
    if (mLangMode === 'all') langStr = '🇮🇹 ITA • 🇬🇧 ENG';
    if (mLangMode === 'eng') langStr = '🇬🇧 ENG';

    let serviceTag = 'RD';
    if (mCurrentService === 'tb') serviceTag = 'TB';
    if (mCurrentService === 'p2p') serviceTag = 'P2P';

    let serviceIconTitle = '🦈';
    if (serviceTag === 'RD') serviceIconTitle = '🐬';
    else if (serviceTag === 'TB') serviceIconTitle = '⚓';

    const p = {
        cleanName: 'Dune Parte Due',
        fileTitle: 'Dune.Parte.Due.2024.2160p.ITA.ENG.TrueHD.7.1.x265-Leviathan',
        quality: '4K',
        qDetails: '4K',
        sizeString: '67.81 GB',
        displaySource: 'ilCorSaRoNeRo',
        serviceTag,
        serviceIconTitle,
        lang: langStr,
        audioTag: 'TrueHD Atmos',
        audioChannels: '7.1',
        audioInfo: 'TrueHD Atmos ┃ 7.1',
        codec: 'HEVC',
        videoTags: ['💎 𝗥𝗘𝗠𝗨𝗫', '👁️ 𝗗𝗩+𝗛𝗗𝗥', '⚙️ 𝗛𝗘𝗩𝗖'],
        cleanTags: ['Remux', 'DV+HDR', 'HEVC'],
        seeders: 152,
        seedersStr: '👥 152',
        epTag: '',
        releaseGroup: 'Leviathan',
        sourceLine: `${serviceIconTitle} [${serviceTag}] ilCorSaRoNeRo`,
        providerLabel: 'Netflix',
        streamScore: 94,
        scoreTier: 'S+',
        scoreBadge: '🏆 S+ 94',
        visualMeter: '▰▰▰▰▰',
        featureSummary: '4K • DV+HDR • HEVC • Atmos'
    };

    const isDebrid = ['RD', 'TB'].includes(p.serviceTag);
    const statusIcon = isDebrid ? serviceIconTitle : '☁️';

    const styleLeviathan = () => {
        const serviceIcon = p.serviceTag === 'RD' ? '🐬' : p.serviceTag === 'TB' ? '⚓' : '🦈';
        const stateIcon = isDebrid ? serviceIcon : '⏳';
        const brandName = toStylized('LEVIATHAN', 'small');
        const serviceStyled = toStylized(p.serviceTag, 'bold');
        const techLine = [...new Set([p.quality, ...p.cleanTags].filter(Boolean))]
            .map(t => toStylized(t, 'small'))
            .join(' • ');
        return {
            name: `${stateIcon} ${serviceStyled} ♆ ${brandName}`,
            title: [
                `▶️ ${toStylized(p.cleanName, 'bold')} ${p.epTag}`.trim(),
                techLine ? `🔱 ${techLine}` : '',
                `🗣️ ${p.lang}  |  🫧 ${p.audioTag} ${p.audioChannels}`,
                `🧲 ${p.sizeString}  |  ${p.seedersStr}`,
                `${serviceIcon} ${p.displaySource} | 🏷️ ${toStylized(p.releaseGroup, 'small')}`
            ].filter(Boolean).join('\n')
        };
    };

    const stylePremium = () => ({
        name: `${statusIcon} ${p.quality} ${p.scoreBadge}`,
        title: [
            `🎬 ${toStylized(p.cleanName, 'bold')}`,
            `🏅 ${p.scoreBadge}  ${p.visualMeter}`,
            `🧪 ${[...new Set([p.quality, ...p.cleanTags, p.codec].filter(Boolean))].slice(0, 4).join(' • ')}`,
            `🔊 ${joinMobilePreviewParts([p.audioTag, p.audioChannels, p.lang], ' • ')}`,
            `📦 ${p.sizeString} • ${p.seedersStr}`,
            `${statusIcon} ${p.displaySource} • ${p.releaseGroup} • ${p.serviceTag}`
        ].join('\n')
    });

    const styleUltraCompact = () => ({
        name: joinMobilePreviewParts([statusIcon, p.quality, 'DV+HDR', p.serviceTag, `•${p.scoreTier}`], ' '),
        title: [
            `🎬 ${p.cleanName}`,
            joinMobilePreviewParts([`🔊 ${p.audioTag} ${p.audioChannels}`, removeMobilePreviewEmoji(p.lang), `📦 ${p.sizeString}`], ' • '),
            joinMobilePreviewParts([`🌐 ${p.displaySource}`, p.seedersStr, p.releaseGroup], ' • ')
        ].join('\n')
    });

    const styleTVCompact = () => ({
        name: joinMobilePreviewParts([p.quality, 'DV+HDR', p.serviceTag], ' | '),
        title: [
            `🎞️ ${p.codec}`,
            `🎧 ${p.audioTag} ${p.audioChannels}`,
            `🌐 ${removeMobilePreviewEmoji(p.lang) || p.lang}`,
            `🏅 ${p.scoreBadge}`,
            `📦 ${p.sizeString} • ${p.seedersStr}`,
            `⚙️ ${p.displaySource}`,
            `📂 ${p.fileTitle}`
        ].join('\n')
    });

    const styleLeviathanTwo = () => ({
        name: `♆ ${toStylized('LEVIATHAN', 'small')} ${p.serviceIconTitle} │ ${p.quality}`,
        title: [
            `🎬 ${toStylized(p.cleanName, 'bold')}`,
            `📦 ${p.sizeString} │ ${p.codec} ${p.cleanTags.filter(x => !String(x).includes(p.codec)).join(' ')}`,
            `🔊 ${p.audioTag} ${p.audioChannels} • ${p.lang}`,
            `🔗 ${p.sourceLine} ${p.seedersStr}`
        ].join('\n')
    });

    const styleFra = () => ({
        name: '⚡️ Leviathan 4K',
        title: [
            `📄 ❯ ${p.fileTitle}`,
            `🌎 ❯ ${p.lang} • ${p.audioTag}`,
            `✨ ❯ ${p.serviceTag} • ${p.displaySource}`,
            `🔥 ❯ ${p.quality} • ${p.cleanTags.join(' • ')}`,
            `💾 ❯ ${p.sizeString} / 👥 ❯ ${p.seeders}`
        ].join('\n')
    });

    const styleComet = () => ({
        name: `[${p.serviceTag} ⚡]
Leviathan
${p.quality}`,
        title: [
            `📄 ${p.fileTitle}`,
            `📹 ${joinMobilePreviewParts([p.codec, ...p.cleanTags].filter(Boolean), ' • ')} | ${p.audioTag}`,
            `⭐ ${p.displaySource}`,
            `💾 ${p.sizeString} 👥 ${p.seeders}`,
            `🌍 ${p.lang}`
        ].join('\n')
    });

    const styleStremioIta = () => ({
        name: '⚡️ Leviathan 4K',
        title: [
            `📄 ❯ ${p.fileTitle}`,
            `🌎 ❯ ${String(p.lang || '').replace(/ITA/gi, 'ita').replace(/ENG/gi, 'eng')}`,
            `✨ ❯ ${p.serviceTag} • ${p.displaySource}`,
            `🔥 ❯ ${p.quality} • ${p.cleanTags.join(' • ')}`,
            `💾 ❯ ${p.sizeString}`,
            `🔉 ❯ ${p.audioTag} • ${p.audioChannels}`
        ].join('\n')
    });

    const styleDav = () => ({
        name: '🎥 4K UHD HEVC',
        title: [
            `📺 ${p.cleanName}`,
            `🎧 ${p.audioTag} ${p.audioChannels} | 🎞️ ${p.codec}`,
            `🗣️ ${p.lang} | 📦 ${p.sizeString}`,
            `⏱️ ${p.seeders} Seeds | 🏷️ ${p.displaySource}`,
            `${p.serviceIconTitle} Leviathan 📡 ${p.serviceTag}`,
            `📂 ${p.fileTitle}`
        ].join('\n')
    });

    const stylePri = () => ({
        name: `[${p.serviceTag}]⚡️☁️
4K🔥UHD
[Leviathan]`,
        title: [
            `🎬 ${p.cleanName}`,
            `${p.cleanTags.join(' ')}`,
            `🎧 ${p.audioTag} | 🔊 ${p.audioChannels} | 🗣️ ${p.lang}`,
            `📁 ${p.sizeString} | 🏷️ ${p.displaySource}`,
            `📄 ▶️ ${p.fileTitle} ◀️`
        ].join('\n')
    });

    const styleAnd = () => ({
        name: `🎬 ${p.cleanName}`,
        title: [
            `${p.quality} ${p.serviceTag === 'RD' ? '⚡' : '⏳'}`,
            '─ ─ ─ ─ ─ ─ ─ ─ ─ ─',
            `Lingue: ${p.lang}`,
            `Specifiche: ${p.quality} | 📺 ${p.cleanTags.join(' ')} | 🔊 ${p.audioTag}`,
            '─ ─ ─ ─ ─ ─ ─ ─ ─ ─',
            `📂 ${p.sizeString} | ☁️ ${p.serviceTag} | 🛰️ Leviathan`
        ].join('\n')
    });

    const styleLad = () => ({
        name: `🖥️ ${p.quality} ${p.serviceTag}`,
        title: [
            `🎟️ ${p.cleanName}`,
            `📜 ${p.epTag || 'Movie'}`,
            `🎥 ${p.quality} 🎞️ ${p.codec} 🎧 ${p.audioTag}`,
            `📦 ${p.sizeString} • 🔗 Leviathan`,
            `🌐 ${p.lang}`
        ].join('\n')
    });

    const styleTorrentio = () => ({
        name: `[${p.serviceTag}]
${p.quality}`,
        title: [
            `📄 ${p.fileTitle}`,
            `📦 ${p.sizeString} 👤 ${p.seeders}`,
            `🔍 ${p.displaySource}`,
            `🔊 ${removeMobilePreviewEmoji(p.lang) || p.lang}`
        ].join('\n')
    });

    const styleVertical = () => ({
        name: `♆ Leviathan ${p.quality} ${isDebrid ? '⚡' : '☁️'} Cached`,
        title: [
            `🍿 ${p.cleanName}`,
            `📼 WEB-DL • ${p.cleanTags[0]}`,
            `⚙️ ${p.codec}`,
            `🔊 ${p.audioTag} (${p.audioChannels})`,
            `💬 ${p.lang}`,
            `🧲 ${p.sizeString}`
        ].join('\n')
    });

    const styleComplex = () => ({
        name: `🔲 4K │ ⛁ ${p.sizeString}`,
        title: [
            `☰ ${joinMobilePreviewParts([p.lang, p.audioTag, p.audioChannels], ' · ')}`,
            `☲ ${joinMobilePreviewParts([p.quality, p.codec, p.cleanTags.join(' · ')], ' · ')}`,
            `☵ ${joinMobilePreviewParts(['Leviathan', p.releaseGroup, p.displaySource, `[${p.serviceTag}]`], ' · ')}`,
            `☶ ${joinMobilePreviewParts([p.cleanName, p.epTag], ' · ')}`
        ].join('\n')
    });

    const styleAndroid = () => ({
        name: joinMobilePreviewParts([p.quality, 'DV+HDR', p.serviceTag], ' | '),
        title: [
            `🎞️ ${p.codec}`,
            `🎧 ${p.audioTag} ${p.audioChannels}`,
            `⚙️ ${p.displaySource}`,
            p.lang,
            `📂 ${p.fileTitle}`
        ].join('\n')
    });

    const stylePicture = () => ({
        name: `✅ UHD HDR ATMOS ${p.quality}`,
        title: [
            `🎬 ${p.cleanName}`,
            `✨ ${p.quality} 🔆 DV | HDR`,
            `🎧 ${p.audioTag} 🔊 ${p.audioChannels}`,
            '💿 Blu-ray Remux',
            `📦 ${p.sizeString}`,
            `🏷️ Blu-ray Remux T1 (${p.releaseGroup})`,
            `⚡ Comet ${p.serviceTag}`
        ].join('\n')
    });

    const styleCustom = () => {
        let tpl = mValue('m-customTemplate') || 'Apex {quality} {score_badge} ||| {title}{n}{summary}';
        const vars = {
            '{title}': p.cleanName,
            '{originalTitle}': p.fileTitle,
            '{ep}': p.epTag || '',
            '{quality}': p.quality,
            '{quality_bold}': toStylized(p.quality, 'bold'),
            '{size}': p.sizeString,
            '{source}': p.displaySource,
            '{service}': p.serviceTag,
            '{lang}': p.lang,
            '{audio}': p.audioInfo,
            '{seeders}': p.seedersStr,
            '{score}': String(p.streamScore),
            '{score_badge}': p.scoreBadge,
            '{score_tier}': p.scoreTier,
            '{meter}': p.visualMeter,
            '{summary}': p.featureSummary,
            '{n}': '\n'
        };
        Object.keys(vars).forEach((key) => {
            tpl = tpl.replace(new RegExp(key.replace(/[{}]/g, '\$&'), 'g'), vars[key]);
        });
        if (tpl.includes('|||')) {
            const parts = tpl.split('|||');
            return { name: parts[0].trim(), title: parts[1].trim() };
        }
        return { name: `Leviathan ${p.quality}`, title: tpl };
    };

    const result = ({
        premium: stylePremium,
        ultra_compact: styleUltraCompact,
        tv_compact: styleTVCompact,
        lev2: styleLeviathanTwo,
        fra: styleFra,
        dav: styleDav,
        and: styleAnd,
        lad: styleLad,
        pri: stylePri,
        comet: styleComet,
        stremio_ita: styleStremioIta,
        torrentio: styleTorrentio,
        vertical: styleVertical,
        complex: styleComplex,
        android: styleAndroid,
        picture: stylePicture,
        custom: styleCustom,
        leviathan: styleLeviathan
    }[skin] || styleLeviathan)();

    const meta = getMobileFormatterMeta(skin);
    const modeEl = document.getElementById('m-prev-mode');
    const iconEl = document.getElementById('m-prev-icon');
    const titleEl = document.getElementById('m-prev-title');
    const infoEl = document.getElementById('m-prev-info');

    if (modeEl) modeEl.innerText = meta.preview;
    if (iconEl) iconEl.innerText = meta.icon || '♆';
    if (titleEl) titleEl.innerText = result.name;
    if (infoEl) infoEl.innerText = result.title;
}

function toggleMobileAIOLock() {
    const isAIO = mChecked('m-aioMode');
    const lock = document.getElementById('m-aio-lock-overlay');
    if (!lock) return;
    lock.classList.toggle('active', isAIO);
}

function createLogoParticles() {
    const container = document.getElementById('logoParticles');
    if(!container) return;
    const count = document.body.classList.contains('m-lowfx') ? 0 : 5;
    container.textContent = '';
    for(let i=0; i < count; i++) {
        const p = document.createElement('div');
        p.classList.add('logo-particle');
        const size = Math.random() * 4 + 2;
        p.style.width = `${size}px`; p.style.height = `${size}px`;
        p.style.left = `${Math.random() * 100}%`;
        p.style.animationDuration = `${Math.random() * 10 + 5}s`;
        p.style.animationDelay = `-${Math.random() * 10}s`;
        const sway = Math.random() * 8 - 4;
        p.style.transform = `translateX(${sway}px)`;
        container.appendChild(p);
    }
}

function createOceanParticles() {
    const container = document.getElementById('m-ocean-particles');
    if (container) container.textContent = '';
}

function createSeaCanvas() {
    const canvas = document.getElementById('m-sea-canvas');
    if (canvas) canvas.remove();
}

function initMobileViewportGuard() {
    const root = document.documentElement;
    let blurTimer = 0;
    let stableH = 0;

    const setStableHeight = () => {
        const h = Math.max(320, Math.round(window.innerHeight || document.documentElement.clientHeight || 0));
        if (h) { stableH = h; root.style.setProperty('--m-vvh', `${h}px`); }
    };

    const isTextField = isMobileTextField;

    const openKeyboardMode = () => {
        window.clearTimeout(blurTimer);
        document.body.classList.add('m-input-active', 'm-keyboard-open', 'm-typing');
    };

    const closeKeyboardMode = (force = false) => {
        window.clearTimeout(blurTimer);
        blurTimer = window.setTimeout(() => {
            if (!force && isTextField()) return;
            document.body.classList.remove('m-input-active', 'm-keyboard-open', 'm-typing');
        }, 250);
    };

    setStableHeight();
    window.addEventListener('orientationchange', () => window.setTimeout(setStableHeight, 260), { passive: true });
    if (window.visualViewport) {
        window.visualViewport.addEventListener('resize', () => {
            const vvh = window.visualViewport.height;
            const base = stableH || window.innerHeight;
            if (vvh >= base * 0.8 && document.body.classList.contains('m-keyboard-open')) {
                closeKeyboardMode(true);
            }
        }, { passive: true });
    }

    document.addEventListener('focusin', (event) => {
        if (!isTextField(mAsElement(event.target))) return;
        openKeyboardMode();
    }, { passive: true });

    document.addEventListener('focusout', (event) => {
        if (!isTextField(mAsElement(event.target))) return;
        closeKeyboardMode();
    }, { passive: true });

    document.addEventListener('pointerdown', (event) => {
        const target = mAsElement(event.target);
        if (isMobileTextField(mClosest(target, 'input, textarea, [contenteditable="true"]'))) return;
        if (mClosest(target, '.m-switch, input[type="checkbox"], button, .m-qual-chip, .m-cloud-mode-btn, .m-reactor-module, .m-flux-opt, .m-lang-opt, .m-cortex-chip, .m-cred-opt, .m-act-btn, .m-nav-item, .m-paste-action, .m-if-action, .m-get-link')) return;
        closeKeyboardMode();
    }, { passive: true });
}

function installMobileVisibilityGuard() {
    const sync = () => document.body.classList.toggle('m-page-hidden', document.hidden);
    document.addEventListener('visibilitychange', sync, { passive: true });
    sync();
}

function installMobileInputPerformanceGuard() {
    const isTextInput = isMobileTextField;
    const isToggleInput = (el) => !!el?.matches?.('input[type="checkbox"], input[type="radio"], input[type="range"]');
    const clearTyping = () => {
        if (isTextInput(document.activeElement)) return;
        clearTimeout(MOBILE_PERF.inputIdleTimer);
        document.body.classList.remove('m-typing', 'm-input-active', 'm-keyboard-open');
    };
    const markTyping = () => {
        document.body.classList.add('m-typing');
        clearTimeout(MOBILE_PERF.inputIdleTimer);
        MOBILE_PERF.inputIdleTimer = setTimeout(() => {
            if (!isTextInput(document.activeElement)) document.body.classList.remove('m-typing');
        }, MOBILE_PERF.inputIdleMs);
    };
    document.addEventListener('input', (event) => {
        const target = mAsElement(event.target);
        if (isToggleInput(target)) return clearTyping();
        if (isTextInput(target)) markTyping();
    }, { passive: true });
    document.addEventListener('touchstart', (event) => {
        const action = mClosest(event.target, '.m-if-action, .m-paste-action, .m-get-link, .m-nav-item, .m-btn-install, .m-btn-copy, .m-act-btn');
        if (!action) return;
        action.classList.add('is-touching');
        setTimeout(() => action.classList.remove('is-touching'), 140);
    }, { passive: true });
}

function installMobileNoFlickerGuard() {
    let switchTimer = 0;
    const switchSelector = '.m-switch, input[type="checkbox"], input[type="radio"], input[type="range"]';
    const cleanTyping = () => {
        if (isMobileTextField(document.activeElement)) return;
        clearTimeout(MOBILE_PERF.inputIdleTimer);
        document.body.classList.remove('m-typing', 'm-input-active', 'm-keyboard-open');
    };
    const markSwitching = () => {
        document.body.classList.add('m-switching');
        cleanTyping();
        clearTimeout(switchTimer);
        switchTimer = setTimeout(() => document.body.classList.remove('m-switching'), 360);
    };
    const bind = (type) => document.addEventListener(type, (event) => {
        if (mClosest(event.target, switchSelector)) markSwitching();
    }, { passive: true });
    bind('pointerdown');
    bind('touchstart');
    bind('input');
    bind('change');
    requestAnimationFrame(() => requestAnimationFrame(() => document.body.classList.add('m-ui-ready')));
}

function scheduleMobileAfterPaint(fn) {
    if (typeof requestIdleCallback === 'function') {
        requestIdleCallback(fn, { timeout: 900 });
    } else {
        setTimeout(fn, 80);
    }
}


function syncMobileDockMetrics() {
    try {
        const root = document.documentElement;
        const dock = document.querySelector('.m-dock-container');
        if (!root || !dock) return;
        const rect = dock.getBoundingClientRect();
        const h = Math.max(96, Math.ceil(rect.height || dock.offsetHeight || 118));
        root.style.setProperty('--m-dock-h', `${h}px`);
    } catch (_) {}
}

function installMobileDockMetricsGuard() {
    try {
        syncMobileDockMetrics();
        requestAnimationFrame(syncMobileDockMetrics);
        setTimeout(syncMobileDockMetrics, 250);
        setTimeout(syncMobileDockMetrics, 900);
        window.addEventListener('resize', () => requestAnimationFrame(syncMobileDockMetrics), { passive: true });
        window.addEventListener('orientationchange', () => setTimeout(syncMobileDockMetrics, 220), { passive: true });
        if ('ResizeObserver' in window) {
            const dock = document.querySelector('.m-dock-container');
            if (dock) {
                const ro = new ResizeObserver(() => syncMobileDockMetrics());
                ro.observe(dock);
                window.__leviathanDockMetricsObserver = ro;
            }
        }
    } catch (_) {}
}

function initMobileInterface() {
    if (!document.head || !document.body) return;
    if (window['__leviathanMobileInitialized']) return;
    window['__leviathanMobileInitialized'] = true;

    ensureMobileLogoHints();
    primeMobileLogo();

    let styleSheet = document.getElementById('leviathan-mobile-style');
    if (!styleSheet) {
        styleSheet = document.createElement("style");
        styleSheet.id = 'leviathan-mobile-style';
        styleSheet.textContent = mobileCSS;
        document.head.appendChild(styleSheet);
    }

    if (!document.getElementById('app-container')) document.body.innerHTML = mobileHTML;
    installMobileDockMetricsGuard();
    lockMobileBrandTitle();
    applyMobilePerformanceMode();
    initMobileViewportGuard();
    installMobileVisibilityGuard();
    installMobileInputPerformanceGuard();
    installMobileNoFlickerGuard();
    hydrateMobileLogo();
    initPullToRefresh();
    loadMobileConfig();
    updateMobilePreview();

    scheduleMobileAfterPaint(() => {
        createLogoParticles();
        createOceanParticles();
        createSeaCanvas();
    });
}

function initPullToRefresh() {
    const content = document.querySelector('.m-content');
    const ptr = document.getElementById('m-ptr-indicator');
    const icon = ptr?.querySelector?.('i');
    if (!content || !ptr || !icon) return;

    let startY = 0;
    let pulling = false;
    let threshold = 80;
    let rAF = null;

    content.addEventListener('touchstart', (e) => {
        const touch = e['touches']?.[0];
        if (!touch) return;
        if (content.scrollTop === 0) { startY = touch.pageY; pulling = true; }
    }, {passive: true});

    content.addEventListener('touchmove', (e) => {
        if (!pulling) return;
        const touch = e['touches']?.[0];
        if (!touch) return;
        const currentY = touch.pageY;
        const diff = currentY - startY;

        if (diff > 0 && content.scrollTop <= 0) {
            if (rAF) return;
            rAF = requestAnimationFrame(() => {
                ptr.style.opacity = String(Math.min(diff / 100, 1));
                const move = Math.min(diff * 0.4, 80);
                ptr.style.transform = `translate3d(0, ${move}px, 0)`;
                icon.style.transform = `rotate(${move * 3}deg)`;

                if (diff > threshold) {
                    icon.classList.remove('fa-arrow-down');
                    icon.classList.add('fa-sync-alt');
                } else {
                    icon.classList.remove('fa-sync-alt');
                    icon.classList.add('fa-arrow-down');
                }
                rAF = null;
            });
        }
    }, {passive: true});

    content.addEventListener('touchend', (e) => {
        if (!pulling) return;
        pulling = false;
        const touch = e['changedTouches']?.[0];
        if (!touch) return;
        const currentY = touch.pageY;
        const diff = currentY - startY;

        if (diff > threshold && content.scrollTop <= 0) {
            ptr.classList.add('loading');
            ptr.style.transform = `translate3d(0, 50px, 0)`;
            mVibrate(50);
            setTimeout(() => { location.reload(); }, 500);
        } else {
            ptr.style.transform = '';
            ptr.style.opacity = '0';
        }
        if (rAF) { cancelAnimationFrame(rAF); rAF = null; }
    }, { passive: true });
}

let _navPageCache = null;
let _navItemCache = null;
let _navContentCache = null;
function navTo(pageId, btn) {
    if (!_navPageCache) _navPageCache = Array.from(document.querySelectorAll('.m-page'));
    if (!_navItemCache) _navItemCache = Array.from(document.querySelectorAll('.m-nav-item'));
    if (!_navContentCache) _navContentCache = document.querySelector('.m-content');
    _navPageCache.forEach(p => p.classList.remove('active'));
    _navItemCache.forEach(i => i.classList.remove('active'));
    const target = document.getElementById('page-' + pageId);
    if (target) target.classList.add('active');
    if (btn) btn.classList.add('active');
    if (_navContentCache) _navContentCache.scrollTop = 0;
    mVibrate(10);
}

function clearMobileDebridValidationTimer() {
    if (mDebridValidationState.timer) {
        clearTimeout(mDebridValidationState.timer);
        mDebridValidationState.timer = null;
    }
}

function formatMobileValidationExpiration(value) {
    if (!value) return null;
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) return null;
    return parsed.toLocaleDateString('it-IT', { day: '2-digit', month: '2-digit', year: 'numeric' });
}

function getMobileValidationServiceMeta(service) {
    if (service === 'tb') {
        return { code: 'TB', name: 'TorBox' };
    }
    return { code: 'RD', name: 'Real-Debrid' };
}

function setMobileDebridValidationStatus(status, message, details = null) {
    const statusEl = document.getElementById('m-keyStatus');
    const textEl = document.getElementById('m-keyStatusText');
    const box = document.getElementById('box-apikey');
    if (!statusEl || !textEl || !box) return;

    statusEl.className = `m-key-status ${status}`;
    textEl.innerText = message;
    mDebridValidationState.status = status;

    box.classList.remove('is-valid', 'is-invalid', 'is-checking');
    if (status === 'valid') box.classList.add('is-valid');
    if (status === 'invalid') box.classList.add('is-invalid');
    if (status === 'checking') box.classList.add('is-checking');

    if (details?.titleParts?.length) {
        const parts = details.titleParts.filter(Boolean);
        statusEl.title = parts.join(' | ');
    } else {
        statusEl.removeAttribute('title');
    }
}

async function runMobileDebridValidation(requestId, service, key) {
    try {
        const response = await fetch('/api/debrid/validate', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ service, key })
        });
        const payload = await response.json().catch(() => null);
        if (requestId !== mDebridValidationState.requestId) return;

        mDebridValidationState.resolvedKey = key;
        mDebridValidationState.resolvedService = service;

        if (response.ok && payload?.ok) {
            const meta = getMobileValidationServiceMeta(service);
            const expiration = formatMobileValidationExpiration(payload.expiration);
            let message = `Token ${meta.name} valido.`;
            const titleParts = [meta.name];
            if (service === 'rd' && payload.username) {
                message = `Token RD valido | ${payload.username}`;
                titleParts.push(`Account ${payload.username}`);
            }
            if (service === 'tb' && Number.isFinite(Number(payload.items))) {
                message = `Token TorBox valido | ${Number(payload.items)} item cloud`;
                titleParts.push(`Item cloud ${Number(payload.items)}`);
            }
            if (expiration) {
                message += ` | ${expiration}`;
                titleParts.push(`Scadenza ${expiration}`);
            }
            setMobileDebridValidationStatus('valid', message, { titleParts });
            return;
        }

        const code = String(payload?.code || '').toLowerCase();
        if (code === 'invalid_token') {
            setMobileDebridValidationStatus('invalid', service === 'tb'
                ? 'Token TorBox non valido o scaduto.'
                : 'Token RD non valido o scaduto.');
            return;
        }

        if (code === 'unsupported_service') {
            setMobileDebridValidationStatus('idle', 'Live check disponibile solo per RD e TB.');
            return;
        }

        setMobileDebridValidationStatus('warning', payload?.message || 'Verifica non disponibile.');
    } catch (_) {
        if (requestId !== mDebridValidationState.requestId) return;
        mDebridValidationState.resolvedKey = key;
        mDebridValidationState.resolvedService = service;
        setMobileDebridValidationStatus('warning', 'Verifica non disponibile.');
    }
}

function scheduleMobileDebridValidation(options = {}) {
    const force = options.force === true;
    const key = mValue('m-apiKey').trim();
    const service = String(mCurrentService || '').trim().toLowerCase();

    clearMobileDebridValidationTimer();
    mDebridValidationState.requestId += 1;

    if (service === 'p2p') {
        setMobileDebridValidationStatus('idle', 'P2P attivo: nessuna key richiesta.');
        return;
    }

    if (!['rd', 'tb'].includes(service)) {
        setMobileDebridValidationStatus('idle', 'Live check disponibile solo per RD e TB.');
        return;
    }

    const meta = getMobileValidationServiceMeta(service);

    if (!key) {
        setMobileDebridValidationStatus('idle', `Incolla una key ${meta.code} per la verifica live.`);
        return;
    }

    if (key.length < 8) {
        setMobileDebridValidationStatus('idle', `Completa la key ${meta.code} per la verifica.`);
        return;
    }

    if (
        !force &&
        mDebridValidationState.resolvedService === service &&
        mDebridValidationState.resolvedKey === key &&
        ['valid', 'invalid', 'warning'].includes(mDebridValidationState.status)
    ) {
        return;
    }

    const requestId = mDebridValidationState.requestId;
    setMobileDebridValidationStatus('checking', `Verifica token ${meta.name}...`);
    mDebridValidationState.timer = setTimeout(() => {
        runMobileDebridValidation(requestId, service, key);
    }, 650);
}

function handleMobileApiKeyInput() {
    scheduleMobileDebridValidation();
    updateLinkModalContent();
}

function setMService(srv, btn, keepInput = false) {
    if(mCurrentService === srv && !keepInput) return;
    mCurrentService = srv;
    if (!keepInput) mSetValue('m-apiKey', '');

    document.querySelectorAll('.m-srv-btn').forEach(b => {
        b.classList.remove('active');
    });
    if(btn) {
        btn.classList.add('active');
    }

    const input = document.getElementById('m-apiKey');
    const box = document.getElementById('box-apikey');

    if (input) {
        if (srv === 'p2p') {
            mSetPlaceholder('m-apiKey', "P2P BYPASS MODE");
            mSetDisabled('m-apiKey', true);
            if(box) box.classList.add('is-p2p');
        } else {
            const placeholders = { 'rd': "INCOLLA RD KEY...", 'tb': "INCOLLA TB KEY..." };
            mSetPlaceholder('m-apiKey', placeholders[srv] || "INCOLLA API KEY...");
            mSetDisabled('m-apiKey', false);
            if(box) box.classList.remove('is-p2p');
        }
    }

    updateMobilePreview();
    scheduleMobileDebridValidation({ force: true });
    toggleSavedCloud();
    updateLinkModalContent();
    mVibrate(10);
}

function updateStatus(inputId, statusId) {
    const chk = mChecked(inputId);
    const lbl = document.getElementById(statusId);
    if(lbl) {
        lbl.innerText = chk ? "ON" : "OFF";
        lbl.classList.toggle('on', chk);
    }

    if(inputId === 'm-enableVix') toggleScOptions();
    if(inputId === 'm-aioMode') toggleMobileAIOLock();
    checkWebPriorityVisibility();
    updateLinkModalContent();
    mVibrate(10);
}

function setLangMode(mode) {
    mLangMode = ['ita', 'all', 'eng'].includes(mode) ? mode : 'ita';
    const btnIta = document.getElementById('lang-ita');
    const btnHyb = document.getElementById('lang-all');
    const btnEng = document.getElementById('lang-eng');
    [btnIta, btnHyb, btnEng].forEach(b => {
        if (b) b.className = 'm-lang-opt';
    });
    if(mLangMode === 'ita' && btnIta) btnIta.classList.add('active-ita');
    if(mLangMode === 'all' && btnHyb) btnHyb.classList.add('active-hyb');
    if(mLangMode === 'eng' && btnEng) btnEng.classList.add('active-eng');

    const descEl = document.getElementById('lang-description');
    if(descEl) {
        descEl.style.opacity = '0';
        setTimeout(() => {
            descEl.innerText = langDescriptions[mLangMode] || langDescriptions.ita;
            descEl.style.opacity = '1';
        }, 200);
    }
    updateMobilePreview();
    updateLinkModalContent();
    mVibrate(10);
}

function checkWebPriorityVisibility() {
    const enabled = ['m-enableVix', 'm-enableGhd', 'm-enableGs', 'm-enableGstv', 'm-enableEs', 'm-enableCb01', 'm-enableAnimeWorld', 'm-enableAnimeUnity', 'm-enableAnimeSaturn', 'm-enableGf', 'm-enableCc'].some(id => mChecked(id));
    const panel = document.getElementById('m-priority-panel');
    if (panel) panel.classList.toggle('show', enabled);
}

function updatePriorityLabel() {
    const isLast = mChecked('m-vixLast');
    const desc = document.getElementById('priority-desc');
    if (desc) {
        desc.innerText = isLast ? "Priorita bassa: risultati dopo i torrent" : "Priorita alta: risultati in cima";
        desc.style.color = isLast ? "var(--m-secondary)" : "var(--m-primary)";
    }
    updateLinkModalContent();
    mVibrate([15, 10, 15]);
}

function setSavedCloudMode(mode) {
    const allowed = ['smart', 'fallback', 'always'];
    mSavedCloudMode = allowed.includes(mode) ? mode : 'smart';
    document.querySelectorAll('.m-cloud-mode-btn').forEach(btn => btn.classList.remove('active'));
    const activeBtn = document.getElementById('m-cloud-' + mSavedCloudMode);
    if(activeBtn) activeBtn.classList.add('active');
    updateLinkModalContent();
    mVibrate(8);
}

function toggleSavedCloud() {
    const input = document.getElementById('m-enableSavedCloud');
    const panel = document.getElementById('m-savedCloudPanel');
    const status = document.getElementById('st-savedcloud');
    if(!input || !panel || !status) return;

    const active = mChecked('m-enableSavedCloud');
    panel.classList.toggle('show', active);
    status.innerText = active ? 'ON' : 'OFF';
    status.classList.toggle('on', active);

    if(active && mCurrentService === 'p2p') {
        showToast('Debrid Cloud richiede RD o TorBox, non P2P.', 'warning');
    }

    updateLinkModalContent();
    mVibrate(10);
}

function toggleScOptions() {
    const chk = mChecked('m-enableVix');
    const opts = document.getElementById('m-sc-options');
    if (opts) opts.style.display = chk ? 'block' : 'none';

    const lbl = document.getElementById('st-vix');
    if(lbl) {
        lbl.innerText = chk ? "ON" : "OFF";
        lbl.classList.toggle('on', chk);
    }
    checkWebPriorityVisibility();
}

function toggleGate() {
    const active = mChecked('m-gateActive');
    const wrapper = document.getElementById('m-gate-wrapper');
    const lbl = document.getElementById('st-gate');

    if (wrapper) wrapper.classList.toggle('show', active);
    if(lbl) {
        lbl.innerText = active ? "ON" : "OFF";
        lbl.classList.toggle('on', active);
    }
    if(active) showToast("Signal Gate Attivo: Risultati Limitati", "warning");
    updateLinkModalContent();
    mVibrate(10);
}

function updateGateDisplay(val) {
    mSetText('m-gate-display', val);
    updateLinkModalContent();
}

function toggleSize() {
    const active = mChecked('m-sizeActive');
    const wrapper = document.getElementById('m-size-wrapper');
    const lbl = document.getElementById('st-size');
    const sliderValue = mValue('m-sizeVal', '0');

    if (wrapper) wrapper.classList.toggle('show', active);
    if(lbl) {
        lbl.innerText = active ? "ON" : "OFF";
        lbl.classList.toggle('on', active);
    }
    if(active) {
        updateSizeDisplay(sliderValue);
    } else {
        mSetText('m-size-display', "INF");
    }
    updateLinkModalContent();
    mVibrate(10);
}

function updateSizeDisplay(val) {
    const display = document.getElementById('m-size-display');
    if (display) display.innerText = val == 0 ? "INF" : String(val);
    updateLinkModalContent();
}

function openApiPage(type) {
    if(type === 'tmdb') {
         window.open('https://www.themoviedb.org/settings/api', '_blank');
         return;
    }
    const links = { 'rd': 'https://real-debrid.com/apitoken', 'tb': 'https://torbox.app/settings' };
    if (links[mCurrentService]) window.open(links[mCurrentService], '_blank');
}
function setScQuality(val) {
    mScQuality = val;
    ['all','1080','720'].forEach(q => {
        const el = document.getElementById('mq-sc-'+q);
        if(el) el.classList.remove('active');
    });
    const activeEl = document.getElementById('mq-sc-' + val);
    if(activeEl) activeEl.classList.add('active');
    updateLinkModalContent();
    mVibrate(10);
}

function setSortMode(mode) {
    mSortMode = fluxData[mode] ? mode : 'balanced';
    ['balanced', 'resolution', 'size'].forEach(m => {
        const btn = document.getElementById('sort-' + m);
        const map = {'balanced':'active-bal', 'resolution':'active-res', 'size':'active-sz'};
        if (!btn) return;
        btn.classList.remove('active-bal', 'active-res', 'active-sz');

        if(m === mSortMode) btn.classList.add(map[m]);
    });

    const readout = document.getElementById('flux-readout-box');
    const title = document.getElementById('flux-title-display');
    const desc = document.getElementById('flux-desc-display');
    const icon = document.getElementById('flux-icon-display');

    if (readout) {
        readout.className = "m-flux-readout";
        readout.style.opacity = '0.5';
    }
    setTimeout(() => {
        const data = fluxData[mSortMode] || fluxData.balanced;
        if(readout) {
            if(mSortMode === 'balanced') readout.classList.add('mode-bal');
            if(mSortMode === 'resolution') readout.classList.add('mode-res');
            if(mSortMode === 'size') readout.classList.add('mode-sz');
            readout.style.opacity = '1';
        }

        if (title) title.innerText = data.title;
        if (desc) desc.innerText = data.desc;
        if (icon) icon.className = `fas ${data.icon} m-fr-icon`;
    }, 150);

    updateLinkModalContent();
    mVibrate(10);
}

function updateGhostVisuals() {
    const chk = mChecked('m-proxyDebrid');
    const box = document.getElementById('ghost-zone-box');
    const txt = document.getElementById('ghost-status-text');

    if (box) box.classList.toggle('active', chk);
    if(txt) txt.innerText = chk ? "STEALTH" : "VISIBLE";

    const lbl = document.getElementById('st-ghost');
    if(lbl) {
         lbl.innerText = chk ? "ON" : "OFF";
         lbl.classList.toggle('on', chk);
    }
    mVibrate(15);
}

function toggleModuleStyle(inputId, boxId) {
    const chk = mChecked(inputId);
    const box = document.getElementById(boxId);
    if(box) box.classList.toggle('active', chk);
    updateLinkModalContent();
}

function toggleFilter(id) {
    const el = document.getElementById(id);
    if (!el) return;
    el.classList.toggle('excluded');
    const isExcluded = el.classList.contains('excluded');
    if(isExcluded) {
        mVibrate(20);
        triggerPreviewUpdateEffect();
    }
    updateLinkModalContent();
}

async function pasteTo(id) {
    const input = document.getElementById(id);
    if (!input || ("disabled" in input && input.disabled)) return;

    try {
        const text = await navigator.clipboard.readText();
        mSetValue(id, text);
        input.dispatchEvent(new Event('input', { bubbles: true }));

        if(id === 'm-apiKey') scheduleMobileDebridValidation({ force: true });
        updateLinkModalContent();

        const wrapper = input.closest('.m-if-inner') || input.closest('.m-input-box') || input.parentElement;
        let btn = wrapper?.querySelector?.('.m-if-action') || wrapper?.querySelector?.('.m-paste-action');
        if(btn) {
            const originalHTML = btn.innerHTML;
            btn.innerHTML = '<i class="fas fa-check"></i>';
            setTimeout(() => { btn.innerHTML = originalHTML; }, 900);
        }

        input.focus({ preventScroll: true });
        showToast("INCOLLATO", "success");
    } catch (err) {
        const input = document.getElementById(id);
        if (input) input.focus({ preventScroll: false });
        showToast("APPUNTI BLOCCATI: INCOLLA MANUALMENTE", "warning");
    }
}

const LEVIATHAN_MOBILE_CONFIG_TOKEN_PREFIX = 'lcfg1_';

function decodeMobileBase64UrlToBytes(value) {
    const normalized = String(value || '').trim().replace(/-/g, '+').replace(/_/g, '/');
    const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
    const binary = atob(padded);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
}

function decodeMobileBase64UrlToUtf8(value) {
    return new TextDecoder().decode(decodeMobileBase64UrlToBytes(value));
}

function encodeMobileConfigToPathToken(config) {
    const json = JSON.stringify(config || {});
    const bytes = new TextEncoder().encode(json);
    let binary = '';
    bytes.forEach(byte => { binary += String.fromCharCode(byte); });
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function normalizeMobileConfigPathToken(rawToken) {
    try { return decodeURIComponent(String(rawToken || '').trim()); }
    catch (_) { return String(rawToken || '').trim(); }
}

function extractMobileConfigTokenFromUrlLike(value) {
    const text = normalizeMobileConfigPathToken(value);
    if (!text) return null;

    try {
        const urlText = text.replace(/^stremio:\/\//i, `${window.location.protocol}//`);
        const url = new URL(urlText, window.location.origin);
        const part = url.pathname.split('/').filter(Boolean).find(segment => {
            return segment.length > 10 && !/^(?:configure|manifest\.json)$/i.test(segment);
        });
        if (part) return part;
    } catch (_) {}

    const match = text.match(/\/([^\/?#]{11,})\/(?:manifest\.json|configure)(?:$|[?#])/i)
        || text.match(/^([^\/?#]{11,})$/i);
    return match ? match[1] : null;
}

function getMobileConfigTokenFromLocation() {
    const pathToken = window.location.pathname.split('/').filter(Boolean).find(segment => {
        return segment.length > 10 && !/^(?:configure|manifest\.json)$/i.test(segment);
    });
    if (pathToken) return pathToken;

    const params = new URLSearchParams(window.location.search || '');
    const keys = ['conf', 'config', 'token', 'configToken', 'manifest', 'manifestUrl', 'addon', 'addonUrl', 'url'];
    for (const key of keys) {
        const value = params.get(key);
        const token = extractMobileConfigTokenFromUrlLike(value);
        if (token) return token;
    }

    const hash = String(window.location.hash || '').replace(/^#/, '');
    return extractMobileConfigTokenFromUrlLike(hash);
}

async function fetchMobileConfigForEditor(token) {
    const response = await fetch('/api/config/decode', {
        method: 'POST',
        cache: 'no-store',
        headers: { 'Accept': 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify({ token })
    });
    if (!response.ok) throw new Error(`decode_http_${response.status}`);
    const payload = await response.json();
    if (!payload || payload.ok !== true || !payload.config) throw new Error('decode_bad_payload');
    return payload.config;
}

async function loadMobileConfigFromPathToken(rawToken) {
    const token = normalizeMobileConfigPathToken(rawToken);
    if (!token || token === 'configure' || token === 'manifest.json') return null;

    if (/^lcfg1_/i.test(token)) {
        return fetchMobileConfigForEditor(token);
    }

    try {
        return JSON.parse(decodeMobileBase64UrlToUtf8(token));
    } catch (_) {
        return fetchMobileConfigForEditor(token);
    }
}

async function loadMobileConfig() {
    try {
        const configToken = getMobileConfigTokenFromLocation();
        if (configToken) {
            const config = await loadMobileConfigFromPathToken(configToken);
            if (!config) throw new Error('empty_mobile_config_token');
            if(config.service) {
                const srvMap = {'rd':0, 'tb':1};
                const railBtns = document.querySelectorAll('#page-setup .m-srv-btn');
                if(railBtns.length > 0 && srvMap[config.service] !== undefined) {
                     setMService(config.service, railBtns[srvMap[config.service]], true);
                }
            } else if (config.filters && config.filters.enableP2P) {
                 const railBtns = document.querySelectorAll('#page-setup .m-srv-btn');
                 setMService('p2p', railBtns[2], true);
            }

            if(config.key) mSetValue('m-apiKey', config.key);

            if(config.tmdb) mSetValue('m-tmdb', config.tmdb);
            if(config.aiostreams_mode) mSetChecked('m-aioMode', true);

            if(config.sort) setSortMode(config.sort);
            else setSortMode('balanced');

            if(config.formatter) selectMobileSkin(config.formatter);
            if(config.customTemplate) mSetValue('m-customTemplate', config.customTemplate);

            if(config.mediaflow) {
                mSetValue('m-mfUrl', config.mediaflow.url || "");
                mSetValue('m-mfPass', config.mediaflow.pass || "");
                mSetChecked('m-proxyDebrid', config.mediaflow.proxyDebrid || false);
            }
            if(config.filters) {
                mSetChecked('m-enableVix', config.filters.enableVix || false);
                toggleModuleStyle('m-enableVix', 'mod-vix');

                mSetChecked('m-enableGhd', config.filters.enableGhd || false);
                toggleModuleStyle('m-enableGhd', 'mod-ghd');

                mSetChecked('m-enableGs', config.filters.enableGs || false);
                toggleModuleStyle('m-enableGs', 'mod-gs');

                mSetChecked('m-enableGstv', config.filters.enableGstv || false);
                toggleModuleStyle('m-enableGstv', 'mod-gstv');

                mSetChecked('m-enableEs', config.filters.enableEs || false);
                toggleModuleStyle('m-enableEs', 'mod-es');

                mSetChecked('m-enableCb01', config.filters.enableCb01 || false);
                toggleModuleStyle('m-enableCb01', 'mod-cb01');

                mSetChecked('m-enableAnimeWorld', config.filters.enableAnimeWorld || false);
                toggleModuleStyle('m-enableAnimeWorld', 'mod-aw');

                mSetChecked('m-enableAnimeUnity', config.filters.enableAnimeUnity || false);
                toggleModuleStyle('m-enableAnimeUnity', 'mod-au');

                mSetChecked('m-enableAnimeSaturn', config.filters.enableAnimeSaturn || false);
                toggleModuleStyle('m-enableAnimeSaturn', 'mod-as');

                mSetChecked('m-enableGf', config.filters.enableGf || false);
                toggleModuleStyle('m-enableGf', 'mod-gf');

                mSetChecked('m-enableCc', config.filters.enableCc || false);
                toggleModuleStyle('m-enableCc', 'mod-cc');

                if(config.filters.language) {
                    setLangMode(config.filters.language);
                } else {
                    setLangMode(config.filters.allowEng ? 'all' : 'ita');
                }

                mSetChecked('m-enableSavedCloud', config.filters.enableSavedCloud || false);
                setSavedCloudMode(config.filters.savedCloudMode || 'smart');
                toggleSavedCloud();

                if(config.filters.vixLast) {
                    mSetChecked('m-vixLast', true);
                    updatePriorityLabel();
                }

                const qMap = {'no4k':'mq-4k', 'no1080':'mq-1080', 'no720':'mq-720', 'noScr':'mq-sd'};
                for(let k in qMap) if(config.filters[k]) mAddClass(qMap[k], 'excluded');
                if(config.filters.scQuality) setScQuality(config.filters.scQuality);

                if(config.filters.maxPerQuality && config.filters.maxPerQuality > 0) {
                    const val = config.filters.maxPerQuality;
                    mSetChecked('m-gateActive', true);
                    mSetValue('m-gateVal', val);
                    updateGateDisplay(val);
                    toggleGate();
                } else {
                    mSetChecked('m-gateActive', false);
                    toggleGate();
                }

                if(config.filters.maxSizeGB && config.filters.maxSizeGB > 0) {
                    const valGB = config.filters.maxSizeGB;
                    mSetChecked('m-sizeActive', true);
                    mSetValue('m-sizeVal', valGB);
                    updateSizeDisplay(valGB);
                    toggleSize();
                } else {
                    mSetChecked('m-sizeActive', false);
                    toggleSize();
                }
            }

            updateStatus('m-enableVix', 'st-vix');
            updateStatus('m-enableGhd', 'st-ghd');
            updateStatus('m-enableGs', 'st-gs');
            updateStatus('m-enableGstv', 'st-gstv');
            updateStatus('m-enableEs', 'st-es');
            updateStatus('m-enableCb01', 'st-cb01');
            updateStatus('m-enableAnimeWorld', 'st-aw');
            updateStatus('m-enableAnimeUnity', 'st-au');
            updateStatus('m-enableAnimeSaturn', 'st-as');
            updateStatus('m-enableGf', 'st-gf');
            updateStatus('m-enableCc', 'st-cc');
            updateStatus('m-aioMode', 'st-aio');
            toggleSavedCloud();
            updateGhostVisuals();
            toggleScOptions();
            checkWebPriorityVisibility();
            toggleMobileAIOLock();
            updateMobilePreview();
            scheduleMobileDebridValidation({ force: true });
            updateLinkModalContent();
        }
    } catch(e) { console.log("No config loaded"); }
}

function getMobileConfig() {
    const gateActive = mChecked('m-gateActive');
    const gateVal = parseInt(mValue('m-gateVal', '0'), 10) || 0;
    const sizeActive = mChecked('m-sizeActive');
    const sizeVal = parseInt(mValue('m-sizeVal', '0'), 10) || 0;
    const finalMaxSizeGB = sizeActive ? sizeVal : 0;

    const isP2P = mCurrentService === 'p2p';
    const apiKey = mValue('m-apiKey').trim();
    const webModules = ['m-enableVix', 'm-enableGhd', 'm-enableGs', 'm-enableGstv', 'm-enableEs', 'm-enableCb01', 'm-enableAnimeWorld', 'm-enableAnimeUnity', 'm-enableAnimeSaturn', 'm-enableGf', 'm-enableCc'];
    const webOnlyService = !isP2P && !apiKey && webModules.some(id => mChecked(id));
    const savedCloudEnabled = !isP2P && !!apiKey && ['rd', 'tb'].includes(String(mCurrentService || '').toLowerCase()) && mChecked('m-enableSavedCloud');

    return {
        service: isP2P ? '' : (webOnlyService ? 'web' : mCurrentService),
        key: apiKey,
        tmdb: mValue('m-tmdb').trim(),
        sort: mSortMode,
        formatter: mSkin,
        customTemplate: mValue('m-customTemplate'),
        aiostreams_mode: mChecked('m-aioMode'),
        mediaflow: {
            url: mValue('m-mfUrl').trim().replace(/\/$/, ""),
            pass: mValue('m-mfPass').trim(),
            proxyDebrid: mChecked('m-proxyDebrid')
        },
        filters: {
            language: mLangMode,
            allowEng: (mLangMode === 'all' || mLangMode === 'eng'),
            enableP2P: isP2P,
            no4k: mHasClass('mq-4k', 'excluded'),
            no1080: mHasClass('mq-1080', 'excluded'),
            no720: mHasClass('mq-720', 'excluded'),
            noScr: mHasClass('mq-sd', 'excluded'),
            noCam: mHasClass('mq-sd', 'excluded'),
            enableVix: mChecked('m-enableVix'),
            enableGhd: mChecked('m-enableGhd'),
            enableGs: mChecked('m-enableGs'),
            enableGstv: mChecked('m-enableGstv'),
            enableEs: mChecked('m-enableEs'),
            enableCb01: mChecked('m-enableCb01'),
            enableAnimeWorld: mChecked('m-enableAnimeWorld'),
            enableAnimeUnity: mChecked('m-enableAnimeUnity'),
            enableAnimeSaturn: mChecked('m-enableAnimeSaturn'),
            enableGf: mChecked('m-enableGf'),
            enableCc: mChecked('m-enableCc'),
            enableTrailers: false,
            enableSavedCloud: savedCloudEnabled,
            savedCloudMode: savedCloudEnabled ? mSavedCloudMode : 'off',
            savedCloudMax: 6,
            vixLast: mChecked('m-vixLast'),
            scQuality: mScQuality,
            maxPerQuality: gateActive ? gateVal : 0,
            maxSizeGB: finalMaxSizeGB > 0 ? finalMaxSizeGB : null
        }
    };
}

function getMobileLegacyManifestUrl(config) {
    return `${window.location.host}/${encodeMobileConfigToPathToken(config)}/manifest.json`;
}

async function getMobileManifestUrl(config) {
    return getMobileLegacyManifestUrl(config);
}

let _linkModalTimer = 0;
async function updateLinkModalContent(immediate = false) {
    if (!immediate) {
        clearTimeout(_linkModalTimer);
        _linkModalTimer = setTimeout(() => updateLinkModalContent(true), 120);
        return;
    }
    const box = document.getElementById('m-generatedUrlBox');
    if(!box) return;

    const config = getMobileConfig();
    const isWebEnabled = config.filters.enableVix || config.filters.enableGhd || config.filters.enableGs || config.filters.enableGstv || config.filters.enableEs || config.filters.enableCb01 || config.filters.enableAnimeWorld || config.filters.enableAnimeUnity || config.filters.enableAnimeSaturn || config.filters.enableGf || config.filters.enableCc || config.filters.enableP2P;

    if(!config.key && !isWebEnabled) {
        mSetValue('m-generatedUrlBox', "/// SYSTEM OFFLINE: WAITING FOR CONFIGURATION DATA ///\\n[!] Inserisci API Key o Attiva Sorgenti Web/P2P");
        box.style.color = "var(--m-error)";
        return;
    }

    const manifestUrl = `${window.location.protocol}//${await getMobileManifestUrl(config)}`;
    mSetValue('m-generatedUrlBox', manifestUrl);
    box.style.color = "var(--m-primary)";
}

async function mobileInstall() {
    const config = getMobileConfig();
    const isWebEnabled = config.filters.enableVix || config.filters.enableGhd || config.filters.enableGs || config.filters.enableGstv || config.filters.enableEs || config.filters.enableCb01 || config.filters.enableAnimeWorld || config.filters.enableAnimeUnity || config.filters.enableAnimeSaturn || config.filters.enableGf || config.filters.enableCc || config.filters.enableP2P;
    if(!config.key && !isWebEnabled) {
        showToast("ERRORE: API KEY MANCANTE", "error"); return;
    }
    const manifestUrl = await getMobileManifestUrl(config);
    window.location.href = `stremio://${manifestUrl}`;
}

function openLinkModal() {
    updateLinkModalContent(true);
    const modal = document.getElementById('m-link-modal');
    if (modal) modal.classList.add('show');
    mVibrate(10);
}

function closeLinkModal() {
    const modal = document.getElementById('m-link-modal');
    if (modal) modal.classList.remove('show');
}

async function copyFromModal() {
    const box = document.getElementById('m-generatedUrlBox');
    const textToCopy = box && "value" in box ? String(box.value || "") : "";
    if (!textToCopy) return;

    if (textToCopy.includes("WAITING FOR")) {
        showToast("CONFIGURA PRIMA L'ADDON", "error");
        return;
    }

    try {
        if (navigator.clipboard && navigator.clipboard.writeText) {
            await navigator.clipboard.writeText(textToCopy);
            closeLinkModal();
            showToast("LINK COPIATO NEGLI APPUNTI", "success");
        } else {
            const dummy = document.createElement("textarea");
            document.body.appendChild(dummy);
            dummy.value = textToCopy;
            dummy.select();
            document.execCommand("copy");
            document.body.removeChild(dummy);
            closeLinkModal();
            showToast("LINK COPIATO NEGLI APPUNTI", "success");
        }
    } catch (err) {
        showToast("ERRORE COPIA MANUALE", "error");
    }
}

function exposeMobileInlineHandlers() {
    if (typeof window === 'undefined') return;
    Object.assign(window, {
        navTo,
        selectMobileSkin,
        updateMobilePreview,
        toggleMobileAIOLock,
        setMService,
        handleMobileApiKeyInput,
        scheduleMobileDebridValidation,
        updateStatus,
        setLangMode,
        checkWebPriorityVisibility,
        updatePriorityLabel,
        setSavedCloudMode,
        toggleSavedCloud,
        toggleScOptions,
        toggleGate,
        updateGateDisplay,
        toggleSize,
        updateSizeDisplay,
        openApiPage,
        setScQuality,
        setSortMode,
        updateGhostVisuals,
        toggleModuleStyle,
        toggleFilter,
        pasteTo,
        getMobileConfig,
        getMobileManifestUrl,
        updateLinkModalContent,
        mobileInstall,
        openLinkModal,
        closeLinkModal,
        copyFromModal
    });
}

function startMobileInterfaceWhenReady() {
    exposeMobileInlineHandlers();
    const start = () => initMobileInterface();
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', start, { once: true });
    } else {
        start();
    }
}

startMobileInterfaceWhenReady();




(function ensureMobileMarkupVisible(){
    try {
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', ensureMobileMarkupVisible, { once: true });
            return;
        }
        if (!document.getElementById('app-container')) {
            document.body.innerHTML = mobileHTML;
        }
        document.body.classList.add('m-ui-ready');
    } catch (_) {}
})();

