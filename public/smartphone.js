const MOBILE_LOGO_URL = "https://i.ibb.co/YTKfXc1z/logo.png";
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

        if (!document.getElementById("leviathan-mobile-fonts")) {
            const hasJakarta = Array.from(document.querySelectorAll('link[rel="stylesheet"]'))
                .some((l) => (l.href || "").includes("Plus+Jakarta+Sans"));
            if (!hasJakarta) {
                const fonts = document.createElement("link");
                fonts.id = "leviathan-mobile-fonts";
                fonts.rel = "stylesheet";
                fonts.href = "https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@500;600;700;800&family=Outfit:wght@300;400;500;600;700;800&family=Rajdhani:wght@500;600;700;800&family=JetBrains+Mono:wght@400;700&display=swap";
                document.head.appendChild(fonts);
            }
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
    /* Base Color Palette */
    --bg-dark: #020713;
    --bg-deep: #00030a;
    --text-main: #f0f7ff;
    --text-dim: #9fb4d7;
    --text-faint: rgba(159, 180, 215, 0.4);

    /* Neons & Accents */
    --neon-cyan: #22d3ee;
    --neon-cyan-glow: rgba(34, 211, 238, 0.4);
    --neon-violet: #9b6cff;
    --neon-violet-glow: rgba(155, 108, 255, 0.4);
    --neon-green: #34e6ad;
    --neon-green-glow: rgba(52, 230, 173, 0.4);
    --neon-rose: #fb6573;
    --neon-rose-glow: rgba(251, 101, 115, 0.4);
    --neon-orange: #f59e0b;
    --neon-orange-glow: rgba(245, 158, 11, 0.4);

    /* Semantic Branding */
    --primary: var(--neon-cyan);
    --primary-glow: var(--neon-cyan-glow);
    --secondary: var(--neon-violet);
    --secondary-glow: var(--neon-violet-glow);

    /* Glass Surfaces */
    --glass-card: rgba(10, 20, 38, 0.6);
    --glass-card-hover: rgba(15, 28, 54, 0.7);
    --glass-card-active: rgba(16, 32, 62, 0.85);
    --glass-border: rgba(255, 255, 255, 0.08);
    --glass-border-glow: rgba(34, 211, 238, 0.2);
    --glass-blur: blur(20px);

    /* Corner Radius */
    --radius-lg: 20px;
    --radius-md: 14px;
    --radius-sm: 10px;

    /* Safe Area Inset */
    --safe-bottom: env(safe-area-inset-bottom);
    --safe-top: env(safe-area-inset-top);
}

* {
    box-sizing: border-box;
    -webkit-tap-highlight-color: transparent;
    outline: none;
    user-select: none;
}
* {
    scrollbar-width: thin;
    scrollbar-color: rgba(34, 211, 238, 0.4) transparent;
}
::-webkit-scrollbar {
    width: 4px;
    height: 4px;
}
::-webkit-scrollbar-track {
    background: transparent;
}
::-webkit-scrollbar-thumb {
    background: rgba(34, 211, 238, 0.3);
    border-radius: 10px;
}
::-webkit-scrollbar-thumb:active {
    background: var(--neon-cyan);
}

body {
    margin: 0;
    background: linear-gradient(180deg, rgba(72, 210, 235, 0.15) 0%, rgba(4, 28, 48, 0.9) 25%, #020713 60%, #00030a 100%), #00030a;
    font-family: 'Outfit', sans-serif;
    color: var(--text-main);
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
    background: radial-gradient(circle at 50% 16%, rgba(34, 211, 238, 0.08), transparent 45%),
                radial-gradient(circle at 50% 100%, rgba(155, 108, 255, 0.06), transparent 50%);
    z-index: -2;
    pointer-events: none;
}
body::before {
    content: '';
    position: fixed;
    top: 0; left: 0;
    width: 100%; height: 100%;
    z-index: -3;
    background-image: linear-gradient(rgba(34, 211, 238, 0.012) 1px, transparent 1px),
                      linear-gradient(90deg, rgba(34, 211, 238, 0.012) 1px, transparent 1px);
    background-size: 50px 50px;
    pointer-events: none;
    mask-image: radial-gradient(circle at 50% 25%, black 0%, transparent 80%);
    -webkit-mask-image: radial-gradient(circle at 50% 25%, black 0%, transparent 80%);
}

.m-caustic {
    position: fixed; top: 0; left: 0; width: 100%; height: 50%; pointer-events: none; z-index: -4; overflow: hidden;
}
.m-caustic-ray {
    position: absolute; top: -10%; width: 50px; height: 110%;
    background: linear-gradient(180deg, rgba(34, 211, 238, 0.08) 0%, rgba(155, 108, 255, 0.03) 50%, transparent 100%);
    transform-origin: top center;
    border-radius: 50%;
    animation: causticSway var(--ray-dur, 12s) ease-in-out infinite alternate;
    opacity: var(--ray-op, 0.6);
    left: var(--ray-x, 30%);
    will-change: transform;
}
@keyframes causticSway {
    0% { transform: rotate(var(--ray-from, -8deg)) scaleX(1); }
    100% { transform: rotate(var(--ray-to, 8deg)) scaleX(1.2); }
}

.m-ocean-particles {
    position: fixed; top: 0; left: 0; width: 100%; height: 100%; pointer-events: none; z-index: -5; overflow: hidden;
}
.m-ocean-particle {
    position: absolute; bottom: -10px;
    width: 3px; height: 3px; border-radius: 50%;
    background: radial-gradient(circle, rgba(34, 211, 238, 0.9) 0%, transparent 100%);
    box-shadow: 0 0 8px 1px rgba(34, 211, 238, 0.5);
    opacity: 0;
    animation: oceanFloat 16s linear infinite;
    will-change: transform;
}
@keyframes oceanFloat {
    0% { transform: translate3d(0, 0, 0) scale(0.6); opacity: 0; }
    10% { opacity: 0.8; }
    85% { opacity: 0.3; }
    100% { transform: translate3d(var(--drift, 15px), -105vh, 0) scale(1.3); opacity: 0; }
}

#m-sea-canvas {
    position: fixed; bottom: 0; left: 0; width: 100%;
    pointer-events: none; z-index: -6;
    display: block;
    will-change: transform;
}

#m-sea-webgl {
    position: fixed;
    top: 0; left: 0;
    width: 100vw;
    height: 100vh;
    z-index: -10;
    pointer-events: none;
    opacity: 0;
    transition: opacity 1s cubic-bezier(0.22, 1, 0.36, 1);
    will-change: opacity;
}
#m-sea-webgl.is-ready {
    opacity: 1;
}

#m-sea-css {
    position: fixed;
    top: 0; left: 0;
    width: 100vw;
    height: 100vh;
    z-index: -1;
    pointer-events: none;
    overflow: hidden;
    background: linear-gradient(180deg, #041428 0%, #010814 60%, #00030a 100%);
    opacity: 0;
    transition: opacity 0.5s ease;
}
body.m-sea-fallback #m-sea-css {
    opacity: 1;
}

#m-sea-css::before {
    content: '';
    position: absolute;
    top: 0; left: 0;
    width: 100%; height: 100%;
    background-image: linear-gradient(rgba(34, 211, 238, 0.02) 1px, transparent 1px),
                      linear-gradient(90deg, rgba(34, 211, 238, 0.02) 1px, transparent 1px);
    background-size: 50px 50px;
    pointer-events: none;
    mask-image: radial-gradient(circle at 50% 25%, black 0%, transparent 80%);
    -webkit-mask-image: radial-gradient(circle at 50% 25%, black 0%, transparent 80%);
    z-index: 10;
}
#m-sea-css::after {
    content: '';
    position: absolute;
    top: 0; left: 0; bottom: 0; right: 0;
    background: radial-gradient(circle at 50% 16%, rgba(34, 211, 238, 0.14), transparent 45%),
                radial-gradient(circle at 50% 100%, rgba(155, 108, 255, 0.08), transparent 50%);
    pointer-events: none;
    z-index: 11;
}

.m-seacss-caustic {
    position: absolute;
    top: 0; left: 0;
    width: 100%; height: 100%;
    background: radial-gradient(circle at 50% -20%, rgba(34, 211, 238, 0.28) 0%, rgba(155, 108, 255, 0.12) 40%, transparent 75%);
    animation: cssCausticPulse 8s ease-in-out infinite alternate;
}
@keyframes cssCausticPulse {
    0% { opacity: 0.6; transform: scale(1); }
    100% { opacity: 1; transform: scale(1.1); }
}

.m-seacss-ray {
    position: absolute;
    top: -30%;
    width: 25vw;
    height: 160%;
    background: linear-gradient(180deg, rgba(34, 211, 238, 0.14) 0%, rgba(155, 108, 255, 0.04) 50%, transparent 100%);
    transform-origin: top center;
    filter: blur(25px);
    will-change: transform;
}
.m-seacss-ray.r1 {
    left: 10%;
    animation: cssRaySway1 14s ease-in-out infinite alternate;
}
.m-seacss-ray.r2 {
    left: 45%;
    animation: cssRaySway2 18s ease-in-out infinite alternate;
}
.m-seacss-ray.r3 {
    left: 80%;
    animation: cssRaySway3 22s ease-in-out infinite alternate;
}

@keyframes cssRaySway1 {
    0% { transform: rotate(-10deg) scaleX(0.9); }
    100% { transform: rotate(4deg) scaleX(1.1); }
}
@keyframes cssRaySway2 {
    0% { transform: rotate(-4deg) scaleX(1.15); }
    100% { transform: rotate(10deg) scaleX(0.85); }
}
@keyframes cssRaySway3 {
    0% { transform: rotate(-12deg) scaleX(0.8); }
    100% { transform: rotate(2deg) scaleX(1.1); }
}

.m-seacss-layer {
    position: absolute;
    bottom: 0;
    left: 0;
    width: 200%;
    height: 160px;
    background-repeat: repeat-x;
    background-size: 50% 100%;
    will-change: transform;
}
.m-seacss-swell3 {
    background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 1200 120' preserveAspectRatio='none'%3E%3Cpath d='M0,30 C150,75 350,20 500,55 C650,90 850,35 1000,65 C1150,95 1200,45 1200,45 L1200,120 L0,120 Z' fill='rgba(155, 108, 255, 0.16)'/%3E%3C/svg%3E");
    animation: cssSwell3 20s linear infinite;
    z-index: 1;
    bottom: -5px;
}
.m-seacss-swell2 {
    background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 1200 120' preserveAspectRatio='none'%3E%3Cpath d='M0,50 C180,85 280,30 450,65 C600,100 750,40 950,70 C1100,100 1200,55 1200,55 L1200,120 L0,120 Z' fill='rgba(34, 211, 238, 0.12)'/%3E%3C/svg%3E");
    animation: cssSwell2 14s linear infinite;
    z-index: 2;
    bottom: -15px;
}
.m-seacss-swell1 {
    background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 1200 120' preserveAspectRatio='none'%3E%3Cpath d='M0,70 C200,105 400,55 600,85 C800,115 1000,65 1200,85 L1200,120 L0,120 Z' fill='rgba(4, 20, 40, 0.75)'/%3E%3C/svg%3E");
    animation: cssSwell1 10s linear infinite;
    z-index: 3;
    bottom: -25px;
}

@keyframes cssSwell3 {
    0% { transform: translate3d(0, 0, 0); }
    100% { transform: translate3d(-50%, 0, 0); }
}
@keyframes cssSwell2 {
    0% { transform: translate3d(-50%, 0, 0); }
    100% { transform: translate3d(0, 0, 0); }
}
@keyframes cssSwell1 {
    0% { transform: translate3d(0, 0, 0); }
    100% { transform: translate3d(-50%, 0, 0); }
}

#app-container {
    display: flex;
    flex-direction: column;
    height: 100dvh;
    width: 100%;
    position: relative;
    overflow: hidden;
    z-index: 1;
}
.m-content-wrapper {
    flex: 1;
    display: flex;
    flex-direction: column;
    min-height: 0;
    position: relative;
    overflow: hidden;
    z-index: 5;
}
.m-content {
    flex: 1;
    overflow-y: auto;
    overflow-x: hidden;
    padding: calc(76px + var(--safe-top, 10px)) 14px calc(24px + var(--safe-bottom, 10px)) 14px;
    width: 100%;
    overscroll-behavior: contain;
    scroll-behavior: smooth;
    -webkit-overflow-scrolling: touch;
}

.m-page {
    display: none;
    width: 100%;
}
.m-page.active {
    display: block;
    animation: mPageFade 0.35s cubic-bezier(0.22, 1, 0.36, 1);
}
@keyframes mPageFade {
    from {
        opacity: 0;
        transform: translate3d(0, 10px, 0);
    }
    to {
        opacity: 1;
        transform: translate3d(0, 0, 0);
    }
}

.m-dock-container {
    position: fixed !important;
    left: 50% !important;
    transform: translate3d(-50%, 0, 0) !important;
    top: calc(10px + var(--safe-top, 0px)) !important;
    bottom: auto !important;
    width: auto !important;
    max-width: calc(100% - 24px) !important;
    border-radius: 999px !important;
    border: 1px solid rgba(255, 255, 255, 0.08) !important;
    background: rgba(8, 17, 34, 0.72) !important;
    box-shadow: 0 16px 36px -10px rgba(0, 0, 0, 0.65),
                inset 0 1px 0 rgba(255, 255, 255, 0.08),
                0 0 15px rgba(34, 211, 238, 0.05) !important;
    backdrop-filter: blur(20px) saturate(160%) !important;
    -webkit-backdrop-filter: blur(20px) saturate(160%) !important;
    padding: 0 !important;
    overflow: visible !important;
    z-index: 1000 !important;
    will-change: transform;
}

.m-dock-nav {
    display: flex !important;
    justify-content: center !important;
    align-items: center !important;
    gap: 4px !important;
    padding: 6px 8px !important;
}

.m-nav-item {
    display: flex !important;
    align-items: center !important;
    justify-content: center !important;
    flex-direction: row !important;
    width: auto !important;
    min-height: 40px !important;
    padding: 6px 12px !important;
    border-radius: 999px !important;
    background: transparent !important;
    border: 1px solid transparent !important;
    color: var(--text-dim) !important;
    cursor: pointer !important;
    transition: all 0.28s cubic-bezier(0.22, 1, 0.36, 1) !important;
}

.m-nav-item .mf-nav-emoji {
    font-size: 1.15rem !important;
    margin: 0 !important;
    filter: grayscale(0.1) opacity(0.8) !important;
    transition: filter 0.2s ease, transform 0.2s ease !important;
}

.m-nav-item i {
    display: none !important;
}

.m-nav-item > span:last-child {
    max-width: 0 !important;
    margin-left: 0 !important;
    opacity: 0 !important;
    white-space: nowrap !important;
    overflow: hidden !important;
    color: #fff !important;
    font-family: 'Outfit', sans-serif !important;
    font-weight: 700 !important;
    font-size: 0.72rem !important;
    letter-spacing: 0.5px !important;
    transition: max-width 0.28s cubic-bezier(0.22, 1, 0.36, 1),
                opacity 0.22s ease,
                margin-left 0.22s ease !important;
}

.m-nav-item.active {
    background: linear-gradient(135deg, rgba(34, 211, 238, 0.22) 0%, rgba(155, 108, 255, 0.16) 100%) !important;
    border-color: rgba(34, 211, 238, 0.25) !important;
    color: #fff !important;
    box-shadow: 0 4px 12px -3px rgba(34, 211, 238, 0.2),
                inset 0 1px 0 rgba(255, 255, 255, 0.1) !important;
}

.m-nav-item.active .mf-nav-emoji {
    filter: none !important;
    transform: scale(1.05) !important;
}

.m-nav-item.active > span:last-child {
    max-width: 90px !important;
    opacity: 1 !important;
    margin-left: 8px !important;
}

.m-nav-item:not(.active):active {
    background: rgba(255, 255, 255, 0.05) !important;
    transform: scale(0.96) !important;
}

body.m-lowfx .m-dock-container {
    backdrop-filter: none !important;
    -webkit-backdrop-filter: none !important;
    background: rgba(10, 20, 38, 0.95) !important;
}

.m-hero {
    text-align: center;
    padding: 12px 6px 20px 6px;
    display: flex;
    flex-direction: column;
    align-items: center;
    width: 100%;
    position: relative;
}

.m-hero-panel {
    width: 100%;
    max-width: 400px;
    padding: 15px 4px 20px 4px;
    position: relative;
    background: transparent;
}

.m-hero-panel::before {
    content: '';
    position: absolute;
    left: 50%; top: 10px;
    width: min(350px, 90vw); height: 200px;
    transform: translateX(-50%);
    pointer-events: none;
    z-index: -1;
    background: radial-gradient(circle at 50% 30%, rgba(34, 211, 238, 0.14), rgba(155, 108, 255, 0.08) 40%, transparent 70%);
    filter: blur(20px);
}

.logo-container {
    width: 140px;
    height: 140px;
    margin: 0 auto 12px;
    display: flex;
    align-items: center;
    justify-content: center;
    position: relative;
    border-radius: 50%;
    animation: breathe 6s ease-in-out infinite;
    will-change: transform;
}

.logo-container::before {
    content: '';
    position: absolute;
    inset: 8px;
    border-radius: 50%;
    background: radial-gradient(circle at 50% 30%, #081a2e 0%, #020713 80%);
    border: 2px solid rgba(34, 211, 238, 0.7);
    box-shadow: 0 0 16px rgba(34, 211, 238, 0.24),
                inset 0 0 12px rgba(155, 108, 255, 0.15);
    z-index: 0;
}

.logo-container .m-abyss-crown {
    position: absolute;
    inset: -10px;
    border-radius: 50%;
    pointer-events: none;
    z-index: -1;
    background: conic-gradient(from 180deg, transparent 0 20%, rgba(34,211,238,0.14) 25%, transparent 35% 65%, rgba(155,108,255,0.14) 70%, transparent 80% 100%);
    filter: blur(2px);
    animation: rotateAura 18s linear infinite;
}

@keyframes rotateAura {
    to { transform: rotate(360deg); }
}

.logo-image {
    width: 78%;
    height: auto;
    max-width: 110px;
    object-fit: contain;
    transform: translateY(2px);
    filter: drop-shadow(0 6px 12px rgba(0, 0, 0, 0.5))
            drop-shadow(0 0 6px rgba(34, 211, 238, 0.15));
    animation: logoHover 4s ease-in-out infinite alternate;
    z-index: 2;
    opacity: 0;
    transition: opacity 0.3s ease-out;
}
.logo-image.is-loaded {
    opacity: 1;
}

@keyframes logoHover {
    from { transform: translateY(2px) scale(0.98); }
    to { transform: translateY(0px) scale(1.02); }
}

.logo-particles {
    position: absolute;
    inset: -10px;
    pointer-events: none;
    z-index: 1;
}
.logo-particle {
    position: absolute;
    background: radial-gradient(circle, rgba(34, 211, 238, 0.7) 0%, transparent 70%);
    border-radius: 50%;
    opacity: 0;
    animation: logoFloat 12s linear infinite;
}
@keyframes logoFloat {
    0% { transform: translateY(80%) scale(0.7); opacity: 0; }
    20% { opacity: 0.3; }
    80% { opacity: 0.1; }
    100% { transform: translateY(-80%) scale(1.1); opacity: 0; }
}

.m-brand-title {
    font-family: 'Rajdhani', sans-serif;
    font-size: 3rem;
    font-weight: 900;
    line-height: 0.9;
    background: linear-gradient(180deg, #ffffff 0%, #a5f3fc 30%, #22d3ee 70%, #6366f1 100%);
    -webkit-background-clip: text;
    -webkit-text-fill-color: transparent;
    margin: 6px 0 0 0;
    letter-spacing: 1px;
    filter: drop-shadow(0 0 12px rgba(34, 211, 238, 0.35));
}
.m-brand-title::after {
    content: '';
    display: block;
    width: 60px;
    height: 2px;
    margin: 8px auto 0;
    border-radius: 999px;
    background: linear-gradient(90deg, transparent, var(--neon-cyan), var(--neon-violet), transparent);
    box-shadow: 0 0 8px var(--neon-cyan);
}

.m-brand-sub {
    font-family: 'Rajdhani', sans-serif;
    font-size: 0.76rem;
    letter-spacing: 4px;
    color: var(--neon-cyan);
    text-transform: uppercase;
    margin-top: 8px;
    font-weight: 800;
    text-shadow: 0 0 8px rgba(34, 211, 238, 0.5);
    display: flex;
    align-items: center;
    justify-content: center;
}
.m-brand-sub::before, .m-brand-sub::after {
    content: '';
    display: block;
    width: 16px;
    height: 1px;
    background: linear-gradient(90deg, transparent, var(--neon-cyan));
    margin: 0 8px;
    opacity: 0.7;
}
.m-brand-sub::after {
    background: linear-gradient(90deg, var(--neon-cyan), transparent);
}

.m-brand-desc {
    font-size: 0.78rem;
    color: var(--text-dim);
    line-height: 1.4;
    margin: 10px auto 0 auto;
    max-width: 320px;
    opacity: 0.9;
}

.m-hero-badges {
    display: flex;
    flex-wrap: wrap;
    justify-content: center;
    gap: 6px;
    margin-top: 10px;
}
.m-hero-badge {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    font-family: 'Rajdhani', sans-serif;
    font-weight: 700;
    font-size: 0.64rem;
    letter-spacing: 1px;
    text-transform: uppercase;
    color: #e2f8ff;
    padding: 3px 10px;
    border-radius: 999px;
    border: 1px solid rgba(34, 211, 238, 0.16);
    background: rgba(10, 20, 38, 0.45);
    box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.05),
                0 0 8px rgba(34, 211, 238, 0.04);
}

.m-version-tag {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    margin-top: 10px;
    font-family: 'Rajdhani', monospace;
    font-size: 0.6rem;
    font-weight: 700;
    color: #fff;
    letter-spacing: 1.5px;
    padding: 3px 10px;
    border-radius: 20px;
    border: 1px solid rgba(34, 211, 238, 0.22);
    background: rgba(34, 211, 238, 0.06);
    box-shadow: 0 0 12px rgba(34, 211, 238, 0.08);
}
.m-v-dot {
    width: 5px;
    height: 5px;
    background: var(--neon-green);
    border-radius: 50%;
    box-shadow: 0 0 6px var(--neon-green);
    animation: blinkDot 2s infinite;
}

.m-hypervisor,
.m-visual-core-v2 {
    background: var(--glass-card) !important;
    border: 1px solid var(--glass-border) !important;
    border-radius: 20px !important;
    padding: 16px 16px 20px 16px !important;
    margin-top: 14px;
    position: relative;
    box-shadow: 0 10px 30px -5px rgba(0, 0, 0, 0.5) !important;
    backdrop-filter: var(--glass-blur) !important;
    -webkit-backdrop-filter: var(--glass-blur) !important;
    transition: border-color 0.3s ease, box-shadow 0.3s ease;
}

.m-hypervisor:focus-within,
.m-visual-core-v2:focus-within {
    border-color: rgba(34, 211, 238, 0.18) !important;
    box-shadow: 0 10px 30px -5px rgba(0, 0, 0, 0.5),
                0 0 15px rgba(34, 211, 238, 0.05) !important;
}

.m-hyp-header {
    display: flex !important;
    align-items: center !important;
    justify-content: space-between !important;
    margin-bottom: 8px !important;
    padding-bottom: 6px !important;
    border-bottom: 1px solid rgba(255, 255, 255, 0.05) !important;
}
.m-hyp-header span {
    font-family: 'Rajdhani', sans-serif !important;
    font-weight: 800 !important;
    font-size: 0.95rem !important;
    letter-spacing: 1.5px !important;
    color: #fff !important;
    text-transform: uppercase !important;
}
.m-hyp-icon {
    font-size: 0.85rem !important;
    color: var(--neon-cyan) !important;
}

.m-panel-desc {
    font-size: 0.74rem !important;
    color: var(--text-dim) !important;
    line-height: 1.45 !important;
    margin: 0 0 14px 0 !important;
    opacity: 0.85;
}
.m-panel-desc b {
    color: #fff;
    font-weight: 600;
}

.m-cred-deck {
    display: grid !important;
    grid-template-columns: repeat(3, 1fr) !important;
    gap: 8px !important;
    margin-bottom: 14px !important;
}
.m-cred-opt {
    background: rgba(10, 20, 38, 0.4) !important;
    border: 1px solid rgba(255, 255, 255, 0.06) !important;
    border-radius: 14px !important;
    padding: 12px 4px !important;
    text-align: center !important;
    display: flex !important;
    flex-direction: column !important;
    align-items: center !important;
    justify-content: center !important;
    gap: 4px !important;
    cursor: pointer !important;
    transition: all 0.3s cubic-bezier(0.25, 0.8, 0.25, 1) !important;
    box-shadow: 0 4px 10px rgba(0, 0, 0, 0.3) !important;
}
.m-cred-icon {
    font-size: 1.3rem !important;
    filter: drop-shadow(0 0 4px rgba(0, 0, 0, 0.4)) !important;
    transition: transform 0.3s cubic-bezier(0.175, 0.885, 0.32, 1.275) !important;
}
.m-cred-name {
    font-family: 'Rajdhani', sans-serif !important;
    font-weight: 800 !important;
    font-size: 0.68rem !important;
    letter-spacing: 0.8px !important;
    color: var(--text-dim) !important;
    transition: color 0.3s ease !important;
}

.m-cred-opt.active {
    background: linear-gradient(145deg, rgba(20, 38, 68, 0.6) 0%, rgba(8, 17, 34, 0.8) 100%) !important;
    border-color: var(--opt-color, var(--neon-cyan)) !important;
    transform: translateY(-2px) !important;
    box-shadow: 0 8px 20px -6px rgba(0, 0, 0, 0.5),
                0 0 15px -3px var(--opt-glow, var(--neon-cyan-glow)) !important;
}
.m-cred-opt.active .m-cred-icon {
    transform: scale(1.12) !important;
}
.m-cred-opt.active .m-cred-name {
    color: #fff !important;
    text-shadow: 0 0 8px var(--opt-glow, var(--neon-cyan-glow)) !important;
}
.m-cred-opt:active {
    transform: scale(0.96) !important;
}

.cred-rd { --opt-color: var(--neon-cyan); --opt-glow: var(--neon-cyan-glow); }
.cred-tb { --opt-color: #38bdf8; --opt-glow: rgba(56, 189, 248, 0.4); }
.cred-p2p { --opt-color: var(--neon-violet); --opt-glow: var(--neon-violet-glow); }

.m-input-fuselage {
    margin-bottom: 12px;
}
.m-if-label {
    font-family: 'Rajdhani', sans-serif;
    font-weight: 800;
    font-size: 0.65rem;
    letter-spacing: 1.5px;
    color: var(--neon-cyan);
    margin-left: 4px;
    margin-bottom: 5px;
    text-transform: uppercase;
}
.m-if-label.opt {
    color: var(--neon-violet);
}

.m-if-inner {
    display: flex !important;
    align-items: center !important;
    flex-wrap: nowrap !important;
    gap: 4px !important;
    background: rgba(4, 10, 20, 0.65) !important;
    border: 1px solid rgba(255, 255, 255, 0.07) !important;
    border-radius: 14px !important;
    padding: 0 6px 0 10px !important;
    height: 44px !important;
    transition: border-color 0.25s ease, box-shadow 0.25s ease !important;
}

.m-if-inner:focus-within {
    border-color: rgba(34, 211, 238, 0.4) !important;
    box-shadow: 0 0 12px -2px rgba(34, 211, 238, 0.15),
                inset 0 1px 2px rgba(0, 0, 0, 0.4) !important;
}

.m-input-fuselage.tmdb-box .m-if-inner:focus-within {
    border-color: rgba(155, 108, 255, 0.4) !important;
    box-shadow: 0 0 12px -2px rgba(155, 108, 255, 0.15) !important;
}

.m-if-icon {
    font-size: 0.82rem !important;
    color: var(--text-dim) !important;
    width: 20px !important;
    flex: 0 0 20px !important;
    display: flex !important;
    align-items: center !important;
}
.m-if-field {
    flex: 1 1 auto !important;
    background: transparent !important;
    border: none !important;
    color: #fff !important;
    font-family: 'Outfit', sans-serif !important;
    font-size: 0.85rem !important;
    padding: 0 !important;
    height: 100% !important;
    width: 100% !important;
}
.m-if-field::placeholder {
    color: var(--text-faint) !important;
    font-size: 0.82rem !important;
}

.m-if-action, .m-paste-action {
    display: flex !important;
    align-items: center !important;
    justify-content: center !important;
    width: 32px !important;
    height: 32px !important;
    flex: 0 0 32px !important;
    border-radius: 10px !important;
    background: rgba(255, 255, 255, 0.04) !important;
    border: 1px solid rgba(255, 255, 255, 0.06) !important;
    color: var(--text-dim) !important;
    cursor: pointer !important;
    transition: all 0.2s ease !important;
}
.m-if-action:active, .m-paste-action:active {
    background: rgba(255, 255, 255, 0.1) !important;
    transform: scale(0.92) !important;
}

.m-get-link {
    display: flex !important;
    align-items: center !important;
    gap: 4px !important;
    font-family: 'Rajdhani', sans-serif !important;
    font-weight: 800 !important;
    font-size: 0.64rem !important;
    letter-spacing: 0.8px !important;
    color: var(--neon-cyan) !important;
    border: 1px solid rgba(34, 211, 238, 0.3) !important;
    background: rgba(34, 211, 238, 0.06) !important;
    padding: 6px 10px !important;
    border-radius: 10px !important;
    cursor: pointer !important;
    transition: all 0.2s ease !important;
    height: 32px !important;
}
.m-get-link:active {
    transform: scale(0.95) !important;
    background: rgba(34, 211, 238, 0.15) !important;
}

.m-key-status {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-top: 8px;
    padding: 6px 12px;
    border-radius: 10px;
    background: rgba(0, 0, 0, 0.15);
    border: 1px solid rgba(255, 255, 255, 0.03);
    font-size: 0.72rem;
    color: var(--text-dim);
}
.m-key-status-dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    flex-shrink: 0;
    transition: all 0.3s ease;
}

.m-key-status.idle .m-key-status-dot { background: #64748b; }
.m-key-status.is-checking .m-key-status-dot { background: var(--neon-cyan); box-shadow: 0 0 8px var(--neon-cyan); animation: blinkDot 1s infinite; }
.m-key-status.is-valid {
    border-color: rgba(52, 230, 173, 0.18);
    background: rgba(52, 230, 173, 0.03);
}
.m-key-status.is-valid .m-key-status-dot { background: var(--neon-green); box-shadow: 0 0 8px var(--neon-green); }
.m-key-status.is-valid #m-keyStatusText { color: #fff; }

.m-key-status.is-invalid {
    border-color: rgba(251, 101, 115, 0.18);
    background: rgba(251, 101, 115, 0.03);
}
.m-key-status.is-invalid .m-key-status-dot { background: var(--neon-rose); box-shadow: 0 0 8px var(--neon-rose); }
.m-key-status.is-invalid #m-keyStatusText { color: #fff; }

.m-reactor-grid {
    display: grid !important;
    grid-template-columns: 1fr !important;
    gap: 12px !important;
    margin-bottom: 16px !important;
}

.m-reactor-module {
    display: grid !important;
    grid-template-columns: 58px minmax(0, 1fr) !important;
    align-items: stretch !important;
    min-height: 84px !important;
    border-radius: 16px !important;
    background: linear-gradient(150deg, rgba(14, 22, 40, 0.55) 0%, rgba(6, 11, 23, 0.75) 100%) !important;
    border: 1px solid rgba(255, 255, 255, 0.06) !important;
    position: relative !important;
    overflow: hidden !important;
    box-shadow: 0 6px 18px rgba(0, 0, 0, 0.45),
                inset 0 1px 0 rgba(255, 255, 255, 0.04) !important;
    transition: border-color 0.3s ease,
                box-shadow 0.3s ease,
                transform 0.28s cubic-bezier(0.2, 0.8, 0.2, 1),
                background 0.3s ease !important;
}

.m-reactor-core {
    display: grid !important;
    place-items: center !important;
    margin-left: 12px !important;
    position: relative !important;
    background: none !important;
    border: none !important;
    box-shadow: none !important;
}

.m-provider-glyph,
.m-reactor-core .m-core-icon {
    width: 40px !important;
    height: 40px !important;
    min-width: 40px !important;
    min-height: 40px !important;
    display: grid !important;
    place-items: center !important;
    border-radius: 11px !important;
    font-size: 1.05rem !important;
    background: rgba(255, 255, 255, 0.03) !important;
    border: 1px solid rgba(255, 255, 255, 0.07) !important;
    color: var(--text-dim) !important;
    filter: drop-shadow(0 2px 4px rgba(0,0,0,0.3)) !important;
    transition: all 0.3s cubic-bezier(0.2, 0.8, 0.2, 1) !important;
}

.m-reactor-body {
    padding: 12px 14px 12px 12px !important;
    display: flex !important;
    flex-direction: column !important;
    justify-content: center !important;
    min-width: 0 !important;
    position: relative !important;
    z-index: 2 !important;
}

.m-reactor-top {
    display: flex !important;
    justify-content: space-between !important;
    align-items: center !important;
    margin-bottom: 4px !important;
    gap: 8px !important;
}

.m-reactor-title {
    font-family: 'Rajdhani', sans-serif !important;
    font-weight: 800 !important;
    font-size: 0.94rem !important;
    letter-spacing: 0.4px !important;
    color: #fff !important;
    text-shadow: 0 1px 3px rgba(0, 0, 0, 0.4) !important;
}

.m-reactor-desc {
    font-size: 0.68rem !important;
    color: var(--text-dim) !important;
    line-height: 1.35 !important;
    max-width: 90% !important;
    opacity: 0.8;
}

.m-reactor-module::before {
    content: "" !important;
    display: block !important;
    position: absolute !important;
    top: 0 !important;
    left: 0 !important;
    right: 0 !important;
    height: 3px !important;
    background: linear-gradient(90deg,
        var(--border-color, var(--neon-cyan)),
        color-mix(in srgb, var(--border-color, var(--neon-cyan)) 60%, #fff 10%) 50%,
        var(--border-color, var(--neon-cyan))) !important;
    opacity: 0.8 !important;
    box-shadow: 0 0 10px var(--glow-color, rgba(34, 211, 238, 0.4)) !important;
    z-index: 5 !important;
    pointer-events: none !important;
    transition: opacity 0.3s ease, height 0.3s ease !important;
}

.m-reactor-body::after {
    content: "OFF" !important;
    position: absolute !important;
    right: 14px !important;
    bottom: 12px !important;
    padding: 2px 6px !important;
    border-radius: 999px !important;
    font-family: 'Rajdhani', sans-serif !important;
    font-size: 0.54rem !important;
    font-weight: 900 !important;
    letter-spacing: 0.5px !important;
    color: var(--text-faint) !important;
    border: 1px solid rgba(255, 255, 255, 0.05) !important;
    background: rgba(255, 255, 255, 0.02) !important;
    pointer-events: none !important;
    line-height: 1 !important;
    transition: all 0.3s ease !important;
}

.m-reactor-module.active {
    border-color: var(--border-color-dim, rgba(34, 211, 238, 0.2)) !important;
    background: radial-gradient(circle at 0 0, var(--glow-color-dim, rgba(34, 211, 238, 0.08)), transparent 45%),
                linear-gradient(150deg, rgba(14, 26, 48, 0.7) 0%, rgba(6, 11, 23, 0.85) 100%) !important;
    box-shadow: 0 10px 24px -8px rgba(0, 0, 0, 0.6),
                0 0 18px -10px var(--glow-color, rgba(34, 211, 238, 0.4)),
                inset 0 1px 0 rgba(255, 255, 255, 0.06) !important;
    transform: translateY(-1px) !important;
}

.m-reactor-module.active::before {
    opacity: 1 !important;
    height: 4px !important;
    box-shadow: 0 0 14px var(--glow-color, rgba(34, 211, 238, 0.6)) !important;
}

.m-reactor-module.active .m-provider-glyph,
.m-reactor-module.active .m-reactor-core .m-core-icon {
    background: linear-gradient(135deg, var(--border-color), color-mix(in srgb, var(--border-color) 60%, #000)) !important;
    border-color: transparent !important;
    color: #fff !important;
    transform: scale(1.05) !important;
    box-shadow: 0 4px 10px -2px var(--glow-color, rgba(34, 211, 238, 0.5)),
                inset 0 1px 0 rgba(255, 255, 255, 0.2) !important;
}

.m-reactor-module.active .m-reactor-body::after {
    content: "ON" !important;
    color: #001217 !important;
    background: var(--border-color) !important;
    border-color: transparent !important;
    box-shadow: 0 0 8px var(--glow-color, rgba(34, 211, 238, 0.4)) !important;
}

.m-switch {
    position: relative;
    display: inline-block;
    width: 38px;
    height: 20px;
    flex-shrink: 0;
}
.m-switch input {
    opacity: 0;
    width: 0;
    height: 0;
}
.m-slider {
    position: absolute;
    cursor: pointer;
    inset: 0;
    background: rgba(255, 255, 255, 0.06);
    border: 1px solid rgba(255, 255, 255, 0.08);
    border-radius: 34px;
    transition: .3s cubic-bezier(0.22, 1, 0.36, 1);
}
.m-slider::before {
    position: absolute;
    content: "";
    height: 12px;
    width: 12px;
    left: 3px;
    bottom: 3px;
    background-color: var(--text-dim);
    border-radius: 50%;
    transition: .3s cubic-bezier(0.22, 1, 0.36, 1);
    box-shadow: 0 2px 4px rgba(0, 0, 0, 0.4);
}

.m-switch input:checked + .m-slider {
    background: var(--border-color);
    border-color: transparent;
    box-shadow: 0 0 10px var(--glow-color-dim, rgba(34, 211, 238, 0.25));
}
.m-switch input:checked + .m-slider::before {
    transform: translate3d(18px, 0, 0);
    background-color: #fff;
    box-shadow: 0 0 4px #fff;
}

#mod-vix { --border-color: var(--neon-violet); --border-color-dim: rgba(155, 108, 255, 0.3); --glow-color: rgba(155, 108, 255, 0.7); --glow-color-dim: rgba(155, 108, 255, 0.15); }
#mod-cc { --border-color: #38bdf8; --border-color-dim: rgba(56, 189, 248, 0.3); --glow-color: rgba(56, 189, 248, 0.7); --glow-color-dim: rgba(56, 189, 248, 0.15); }
#mod-ghd { --border-color: var(--neon-cyan); --border-color-dim: rgba(34, 211, 238, 0.3); --glow-color: rgba(34, 211, 238, 0.7); --glow-color-dim: rgba(34, 211, 238, 0.15); }
#mod-gs { --border-color: var(--neon-violet); --border-color-dim: rgba(155, 108, 255, 0.3); --glow-color: rgba(155, 108, 255, 0.7); --glow-color-dim: rgba(155, 108, 255, 0.15); }
#mod-vidxgo { --border-color: #6366f1; --border-color-dim: rgba(99, 102, 241, 0.3); --glow-color: rgba(99, 102, 241, 0.7); --glow-color-dim: rgba(99, 102, 241, 0.15); }
#mod-es { --border-color: #2dd4bf; --border-color-dim: rgba(45, 212, 191, 0.3); --glow-color: rgba(45, 212, 191, 0.7); --glow-color-dim: rgba(45, 212, 191, 0.15); }
#mod-cb01 { --border-color: var(--neon-orange); --border-color-dim: rgba(245, 158, 11, 0.3); --glow-color: rgba(245, 158, 11, 0.7); --glow-color-dim: rgba(245, 158, 11, 0.15); }
#mod-onlineserietv { --border-color: #38bdf8; --border-color-dim: rgba(56, 189, 248, 0.3); --glow-color: rgba(56, 189, 248, 0.7); --glow-color-dim: rgba(56, 189, 248, 0.15); }
#mod-aw { --border-color: #0ea5e9; --border-color-dim: rgba(14, 165, 233, 0.3); --glow-color: rgba(14, 165, 233, 0.7); --glow-color-dim: rgba(14, 165, 233, 0.15); }
#mod-au { --border-color: #ec4899; --border-color-dim: rgba(236, 72, 153, 0.3); --glow-color: rgba(236, 72, 153, 0.7); --glow-color-dim: rgba(236, 72, 153, 0.15); }
#mod-as { --border-color: var(--neon-cyan); --border-color-dim: rgba(34, 211, 238, 0.3); --glow-color: rgba(34, 211, 238, 0.7); --glow-color-dim: rgba(34, 211, 238, 0.15); }
#mod-ti { --border-color: #38bdf8; --border-color-dim: rgba(56, 189, 248, 0.3); --glow-color: rgba(56, 189, 248, 0.7); --glow-color-dim: rgba(56, 189, 248, 0.15); }
#mod-gf { --border-color: #00e676; --border-color-dim: rgba(0, 230, 118, 0.3); --glow-color: rgba(0, 230, 118, 0.7); --glow-color-dim: rgba(0, 230, 118, 0.15); }
#mod-ads { --border-color: #ff4d6d; --border-color-dim: rgba(255, 77, 109, 0.3); --glow-color: rgba(255, 77, 109, 0.7); --glow-color-dim: rgba(255, 77, 109, 0.15); }

#mod-vix .m-core-icon { color: var(--neon-violet); }
#mod-ghd .m-core-icon { color: var(--neon-cyan); }
#mod-gs .m-core-icon { color: var(--neon-violet); }
#mod-aw .m-core-icon { color: #0ea5e9; }
#mod-as .m-core-icon { color: var(--neon-cyan); }
#mod-gf .m-core-icon { color: #00e676; }
#mod-cc .m-core-icon { color: #38bdf8; }
#mod-ads .m-core-icon { color: #ff4d6d; }
#mod-es .m-core-icon { color: #2dd4bf; }
#mod-cb01 .m-core-icon { color: var(--neon-orange); }
#mod-onlineserietv .m-core-icon { color: #38bdf8; }
#mod-au .m-core-icon { color: #ec4899; }
#mod-vidxgo .m-core-icon { color: #6366f1; }
#mod-ti .m-core-icon { color: #38bdf8; }

.m-tag-row {
    display: flex !important;
    gap: 5px !important;
    align-items: center !important;
    margin-top: 6px !important;
}
.m-tech-tag {
    font-family: 'Rajdhani', monospace !important;
    font-size: 0.54rem !important;
    font-weight: 800 !important;
    padding: 2px 6px !important;
    border-radius: 4px !important;
    border: 1px solid !important;
    text-transform: uppercase !important;
    letter-spacing: 0.6px !important;
    line-height: 1 !important;
    display: inline-flex !important;
    align-items: center !important;
    gap: 4px !important;
}
.m-tech-tag i {
    font-size: 0.55rem !important;
}

.tag-noproxy {
    border-color: rgba(255, 255, 255, 0.08) !important;
    color: rgba(255, 255, 255, 0.4) !important;
    background: rgba(255, 255, 255, 0.02) !important;
}
.tag-mfp {
    border-color: rgba(155, 108, 255, 0.25) !important;
    color: var(--neon-violet) !important;
    background: rgba(155, 108, 255, 0.05) !important;
}
.tag-kraken {
    border-color: rgba(34, 211, 238, 0.25) !important;
    color: var(--neon-cyan) !important;
    background: rgba(34, 211, 238, 0.05) !important;
}

.m-flux-grid {
    display: grid !important;
    grid-template-columns: repeat(3, 1fr) !important;
    gap: 8px !important;
    margin-bottom: 12px !important;
}
.m-flux-opt {
    background: rgba(10, 20, 38, 0.4) !important;
    border: 1px solid rgba(255, 255, 255, 0.06) !important;
    border-radius: 12px !important;
    padding: 10px 4px !important;
    text-align: center !important;
    display: flex !important;
    flex-direction: column !important;
    align-items: center !important;
    gap: 4px !important;
    cursor: pointer !important;
    transition: all 0.25s ease !important;
}
.m-flux-opt i {
    font-size: 1.1rem !important;
    color: var(--text-dim) !important;
    transition: transform 0.3s cubic-bezier(0.175, 0.885, 0.32, 1.275) !important;
}
.m-flux-opt span {
    font-family: 'Rajdhani', sans-serif !important;
    font-weight: 800 !important;
    font-size: 0.68rem !important;
    letter-spacing: 0.8px !important;
    color: var(--text-dim) !important;
}

.m-flux-opt.active-bal {
    border-color: var(--neon-cyan) !important;
    background: rgba(34, 211, 238, 0.08) !important;
    box-shadow: 0 0 12px -3px rgba(34, 211, 238, 0.2) !important;
}
.m-flux-opt.active-bal i, .m-flux-opt.active-bal span { color: var(--neon-cyan) !important; }
.m-flux-opt.active-bal i { transform: scale(1.08) !important; }

.m-flux-opt.active-res {
    border-color: #38bdf8 !important;
    background: rgba(56, 189, 248, 0.08) !important;
    box-shadow: 0 0 12px -3px rgba(56, 189, 248, 0.2) !important;
}
.m-flux-opt.active-res i, .m-flux-opt.active-res span { color: #38bdf8 !important; }
.m-flux-opt.active-res i { transform: scale(1.08) !important; }

.m-flux-opt.active-size {
    border-color: var(--neon-violet) !important;
    background: rgba(155, 108, 255, 0.08) !important;
    box-shadow: 0 0 12px -3px rgba(155, 108, 255, 0.2) !important;
}
.m-flux-opt.active-size i, .m-flux-opt.active-size span { color: var(--neon-violet) !important; }
.m-flux-opt.active-size i { transform: scale(1.08) !important; }

.m-flux-opt:active { transform: scale(0.97) !important; }

.m-flux-readout {
    display: flex !important;
    align-items: flex-start !important;
    gap: 10px !important;
    padding: 10px 12px !important;
    border-radius: 12px !important;
    background: rgba(0, 0, 0, 0.2) !important;
    border: 1px solid rgba(255, 255, 255, 0.04) !important;
    transition: all 0.3s ease !important;
}
.m-fr-icon {
    font-size: 0.95rem !important;
    margin-top: 2px !important;
    transition: color 0.3s ease !important;
}
.m-fr-text {
    display: flex !important;
    flex-direction: column !important;
    gap: 2px !important;
}
.m-fr-title {
    font-family: 'Rajdhani', sans-serif !important;
    font-weight: 800 !important;
    font-size: 0.74rem !important;
    letter-spacing: 0.8px !important;
    text-transform: uppercase !important;
}
.m-fr-desc {
    font-size: 0.68rem !important;
    color: var(--text-dim) !important;
    line-height: 1.35 !important;
}

.m-flux-readout.mode-bal { border-left: 3px solid var(--neon-cyan) !important; }
.m-flux-readout.mode-bal .m-fr-icon, .m-flux-readout.mode-bal .m-fr-title { color: var(--neon-cyan) !important; }
.m-flux-readout.mode-res { border-left: 3px solid #38bdf8 !important; }
.m-flux-readout.mode-res .m-fr-icon, .m-flux-readout.mode-res .m-fr-title { color: #38bdf8 !important; }
.m-flux-readout.mode-sz { border-left: 3px solid var(--neon-violet) !important; }
.m-flux-readout.mode-sz .m-fr-icon, .m-flux-readout.mode-sz .m-fr-title { color: var(--neon-violet) !important; }

.m-lang-grid {
    display: grid !important;
    grid-template-columns: repeat(3, 1fr) !important;
    gap: 8px !important;
    margin-bottom: 10px !important;
}
.m-lang-opt {
    background: rgba(10, 20, 38, 0.4) !important;
    border: 1px solid rgba(255, 255, 255, 0.06) !important;
    border-radius: 12px !important;
    padding: 10px 4px !important;
    text-align: center !important;
    cursor: pointer !important;
    display: flex !important;
    flex-direction: column !important;
    align-items: center !important;
    gap: 4px !important;
    transition: all 0.25s ease !important;
}
.m-lang-opt i {
    font-size: 0.95rem !important;
    color: var(--text-dim) !important;
}
.m-lang-txt {
    font-family: 'Rajdhani', sans-serif !important;
    font-weight: 800 !important;
    font-size: 0.68rem !important;
    letter-spacing: 0.5px !important;
    color: var(--text-dim) !important;
}

.m-lang-opt.active-ita {
    border-color: var(--neon-cyan) !important;
    background: rgba(34, 211, 238, 0.08) !important;
}
.m-lang-opt.active-ita i, .m-lang-opt.active-ita .m-lang-txt { color: var(--neon-cyan) !important; }

.m-lang-opt.active-hyb {
    border-color: var(--neon-violet) !important;
    background: rgba(155, 108, 255, 0.08) !important;
}
.m-lang-opt.active-hyb i, .m-lang-opt.active-hyb .m-lang-txt { color: var(--neon-violet) !important; }

.m-lang-opt.active-eng {
    border-color: #38bdf8 !important;
    background: rgba(56, 189, 248, 0.08) !important;
}
.m-lang-opt.active-eng i, .m-lang-opt.active-eng .m-lang-txt { color: #38bdf8 !important; }

.m-lang-opt:active { transform: scale(0.97) !important; }

.m-chip-grid {
    display: flex !important;
    flex-wrap: wrap !important;
    gap: 8px !important;
    margin-bottom: 16px !important;
}
.m-qual-chip {
    font-family: 'Rajdhani', sans-serif !important;
    font-weight: 800 !important;
    font-size: 0.72rem !important;
    letter-spacing: 0.8px !important;
    text-transform: uppercase !important;
    color: #fff !important;
    padding: 6px 12px !important;
    border-radius: 10px !important;
    border: 1px solid rgba(34, 211, 238, 0.25) !important;
    background: rgba(34, 211, 238, 0.08) !important;
    cursor: pointer !important;
    transition: all 0.25s cubic-bezier(0.2, 0.8, 0.2, 1) !important;
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.2),
                inset 0 1px 0 rgba(255, 255, 255, 0.05) !important;
}
.m-qual-chip .mini-tag {
    font-size: 0.52rem !important;
    opacity: 0.7;
    margin-left: 2px !important;
}

.m-qual-chip.excluded {
    border-color: rgba(255, 255, 255, 0.06) !important;
    background: rgba(255, 255, 255, 0.02) !important;
    color: var(--text-faint) !important;
    text-decoration: line-through !important;
    box-shadow: none !important;
    opacity: 0.55 !important;
}
.m-qual-chip:active {
    transform: scale(0.95) !important;
}

.m-sys-grid {
    display: flex !important;
    flex-direction: column !important;
    gap: 12px !important;
    margin-bottom: 14px !important;
}
.m-sys-row, .m-row {
    display: flex !important;
    justify-content: space-between !important;
    align-items: center !important;
    padding: 10px 0 !important;
    border-bottom: 1px solid rgba(255, 255, 255, 0.04) !important;
}
.m-sys-info h4, .m-label h4 {
    margin: 0 !important;
    font-family: 'Rajdhani', sans-serif !important;
    font-weight: 800 !important;
    font-size: 0.86rem !important;
    color: #fff !important;
    display: flex !important;
    align-items: center !important;
    gap: 6px !important;
}
.m-sys-info p, .m-label p {
    margin: 2px 0 0 0 !important;
    font-size: 0.65rem !important;
    color: var(--text-dim) !important;
    opacity: 0.8;
}

.m-status-text {
    font-family: 'Rajdhani', monospace !important;
    font-size: 0.58rem !important;
    font-weight: 900 !important;
    padding: 1px 5px !important;
    border-radius: 4px !important;
    background: rgba(255, 255, 255, 0.05) !important;
    border: 1px solid rgba(255, 255, 255, 0.08) !important;
    color: var(--text-dim) !important;
    margin-left: 6px !important;
    transition: all 0.3s ease !important;
}
.m-status-text.on {
    color: #001217 !important;
    background: var(--neon-cyan) !important;
    border-color: transparent !important;
    box-shadow: 0 0 6px var(--neon-cyan-glow) !important;
}

.m-cloud-mode-panel, .m-gate-wrapper {
    display: none;
    padding: 10px 12px !important;
    border-radius: 12px !important;
    background: rgba(0, 0, 0, 0.18) !important;
    border: 1px solid rgba(255, 255, 255, 0.03) !important;
    margin-top: 6px;
    margin-bottom: 10px;
}
.m-cloud-mode-panel.show, .m-gate-wrapper.show {
    display: block !important;
    animation: slideDownIn 0.3s cubic-bezier(0.175, 0.885, 0.32, 1.275);
}
@keyframes slideDownIn {
    from { opacity: 0; transform: translate3d(0, -6px, 0); }
    to { opacity: 1; transform: translate3d(0, 0, 0); }
}

.m-cloud-mode-grid {
    display: grid !important;
    grid-template-columns: repeat(3, 1fr) !important;
    gap: 6px !important;
    margin-bottom: 8px !important;
}
.m-cloud-mode-btn {
    background: rgba(10, 20, 38, 0.3) !important;
    border: 1px solid rgba(255, 255, 255, 0.05) !important;
    border-radius: 10px !important;
    padding: 8px 2px !important;
    text-align: center !important;
    font-family: 'Rajdhani', sans-serif !important;
    font-weight: 800 !important;
    font-size: 0.72rem !important;
    letter-spacing: 0.4px !important;
    color: var(--text-dim) !important;
    cursor: pointer !important;
    transition: all 0.25s ease !important;
    display: flex !important;
    flex-direction: column !important;
    align-items: center !important;
}
.m-cloud-mode-btn span {
    font-family: 'Outfit', sans-serif !important;
    font-size: 0.52rem !important;
    font-weight: 500 !important;
    opacity: 0.6;
    margin-top: 1px !important;
}
.m-cloud-mode-btn.active {
    border-color: var(--neon-cyan) !important;
    background: rgba(34, 211, 238, 0.08) !important;
    color: #fff !important;
    box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.05),
                0 0 10px rgba(34, 211, 238, 0.1) !important;
}
.m-cloud-mode-btn.active span {
    opacity: 0.8;
}

.m-cloud-note, .m-range-desc {
    margin: 6px 0 0 0 !important;
    font-size: 0.62rem !important;
    line-height: 1.3 !important;
    color: var(--text-faint) !important;
}

.m-gate-control {
    display: flex !important;
    align-items: center !important;
    gap: 10px !important;
}
.m-range {
    flex-grow: 1 !important;
    height: 4px !important;
    border-radius: 2px !important;
    background: rgba(255, 255, 255, 0.08) !important;
    outline: none !important;
    appearance: none !important;
    -webkit-appearance: none !important;
}
.m-range::-webkit-slider-thumb {
    appearance: none !important;
    -webkit-appearance: none !important;
    width: 16px !important;
    height: 16px !important;
    border-radius: 50% !important;
    background: var(--neon-cyan) !important;
    box-shadow: 0 0 8px var(--neon-cyan) !important;
    cursor: pointer !important;
}
.m-range::-moz-range-thumb {
    width: 16px !important;
    height: 16px !important;
    border-radius: 50% !important;
    background: var(--neon-cyan) !important;
    box-shadow: 0 0 8px var(--neon-cyan) !important;
    cursor: pointer !important;
    border: none !important;
}

.m-setup-actions-panel {
    margin-top: 18px;
}
.m-setup-action-row {
    display: flex !important;
    gap: 8px !important;
    margin-bottom: 12px !important;
}
.m-setup-action {
    flex-grow: 1 !important;
    height: 48px !important;
    border: none !important;
    border-radius: 14px !important;
    font-family: 'Rajdhani', sans-serif !important;
    font-weight: 800 !important;
    font-size: 0.95rem !important;
    letter-spacing: 1.5px !important;
    color: #fff !important;
    cursor: pointer !important;
    transition: all 0.25s cubic-bezier(0.2, 0.8, 0.2, 1) !important;
    display: flex !important;
    align-items: center !important;
    justify-content: center !important;
    gap: 8px !important;
}

.m-setup-install {
    background: linear-gradient(135deg, var(--neon-cyan) 0%, #0ea5e9 100%) !important;
    box-shadow: 0 10px 24px -8px rgba(34, 211, 238, 0.5) !important;
}

.m-setup-action:active {
    transform: scale(0.96) !important;
}
.m-setup-install:active {
    box-shadow: 0 4px 10px -3px rgba(34, 211, 238, 0.4) !important;
}

.m-setup-mini-console {
    background: rgba(4, 8, 16, 0.55) !important;
    border: 1px solid rgba(255, 255, 255, 0.05) !important;
    border-radius: 14px !important;
    padding: 10px 12px !important;
    box-shadow: inset 0 1px 3px rgba(0, 0, 0, 0.5) !important;
}
.m-setup-mini-console-head {
    display: flex !important;
    justify-content: space-between !important;
    align-items: center !important;
    margin-bottom: 6px !important;
}
.m-setup-mini-console-title {
    font-family: 'Rajdhani', monospace !important;
    font-size: 0.68rem !important;
    font-weight: 800 !important;
    letter-spacing: 0.6px !important;
    color: var(--text-dim) !important;
    display: flex !important;
    align-items: center !important;
    gap: 5px !important;
}
.m-setup-mini-copy {
    border: 1px solid rgba(34, 211, 238, 0.3) !important;
    background: rgba(34, 211, 238, 0.08) !important;
    color: var(--neon-cyan) !important;
    font-family: 'Rajdhani', sans-serif !important;
    font-weight: 800 !important;
    font-size: 0.6rem !important;
    letter-spacing: 0.6px !important;
    padding: 3px 8px !important;
    border-radius: 6px !important;
    cursor: pointer !important;
    display: flex !important;
    align-items: center !important;
    gap: 4px !important;
    transition: all 0.2s ease !important;
}
.m-setup-mini-copy:active {
    transform: scale(0.93) !important;
    background: rgba(34, 211, 238, 0.18) !important;
}
.m-setup-mini-url {
    width: 100% !important;
    height: 38px !important;
    background: transparent !important;
    border: none !important;
    color: var(--text-dim) !important;
    font-family: 'JetBrains Mono', monospace !important;
    font-size: 0.64rem !important;
    line-height: 1.4 !important;
    resize: none !important;
    overflow-x: auto !important;
    white-space: nowrap !important;
    padding: 0 !important;
}

#m-recalc-layer {
    position: absolute;
    inset: 0;
    background: rgba(0, 0, 0, 0.85);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 100;
    opacity: 0;
    pointer-events: none;
    transition: opacity 0.25s ease;
    border-radius: 14px;
}
#m-recalc-layer.visible {
    opacity: 1;
    pointer-events: auto;
}
.m-fr-recalc-text {
    font-family: 'Rajdhani', monospace;
    font-weight: 800;
    font-size: 0.74rem;
    color: var(--neon-cyan);
    letter-spacing: 1px;
    display: flex;
    align-items: center;
    gap: 6px;
}

#m-preview-box {
    background: rgba(4, 8, 16, 0.5) !important;
    border: 1px solid rgba(255, 255, 255, 0.05) !important;
    border-radius: 14px !important;
    padding: 12px 14px !important;
    position: relative !important;
    box-shadow: inset 0 1px 3px rgba(0,0,0,0.5) !important;
}
.m-prev-header {
    display: flex !important;
    justify-content: space-between !important;
    align-items: center !important;
    margin-bottom: 8px !important;
}
.m-prev-head-text {
    font-family: 'Rajdhani', monospace !important;
    font-size: 0.6rem !important;
    font-weight: 800 !important;
    color: var(--text-dim) !important;
    display: flex !important;
    align-items: center !important;
    gap: 4px !important;
}
.m-prev-head-dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--neon-green);
    box-shadow: 0 0 6px var(--neon-green);
}
#m-prev-mode {
    font-family: 'Rajdhani', monospace !important;
    font-weight: 900 !important;
    font-size: 0.58rem !important;
    letter-spacing: 0.6px !important;
    color: var(--neon-cyan) !important;
    border: 1px solid rgba(34, 211, 238, 0.22) !important;
    background: rgba(34, 211, 238, 0.08) !important;
    padding: 1px 6px !important;
    border-radius: 4px !important;
}

.m-prev-card-body {
    display: flex !important;
    gap: 12px !important;
    align-items: flex-start !important;
}
.m-prev-poster {
    width: 44px !important;
    height: 64px !important;
    border-radius: 6px !important;
    background: linear-gradient(180deg, #101d33, #080f1c) !important;
    border: 1px solid rgba(255, 255, 255, 0.06) !important;
    display: flex !important;
    align-items: center !important;
    justify-content: center !important;
    color: rgba(255, 255, 255, 0.15) !important;
    font-size: 1rem !important;
    flex-shrink: 0 !important;
}
.m-prev-details {
    display: flex !important;
    flex-direction: column !important;
    gap: 3px !important;
    min-width: 0 !important;
}
#m-prev-title {
    font-size: 0.82rem !important;
    font-weight: 700 !important;
    color: #fff !important;
    line-height: 1.2 !important;
}
#m-prev-info {
    font-family: 'JetBrains Mono', monospace !important;
    font-size: 0.65rem !important;
    line-height: 1.4 !important;
    color: var(--text-dim) !important;
    white-space: pre-line !important;
}

.m-cortex-grid {
    display: flex !important;
    flex-wrap: wrap !important;
    gap: 6px !important;
    margin-top: 12px !important;
}
.m-cortex-chip {
    font-family: 'Rajdhani', sans-serif !important;
    font-weight: 800 !important;
    font-size: 0.64rem !important;
    letter-spacing: 0.5px !important;
    text-transform: uppercase !important;
    color: var(--text-dim) !important;
    border: 1px solid rgba(255, 255, 255, 0.06) !important;
    background: rgba(255, 255, 255, 0.02) !important;
    padding: 4px 10px !important;
    border-radius: 8px !important;
    cursor: pointer !important;
    transition: all 0.2s ease !important;
}
.m-cortex-chip.active {
    border-color: var(--neon-cyan) !important;
    background: rgba(34, 211, 238, 0.08) !important;
    color: #fff !important;
    box-shadow: 0 0 8px rgba(34, 211, 238, 0.1) !important;
}
.m-cortex-chip:active { transform: scale(0.96) !important; }

.m-cortex-trigger {
    display: flex !important;
    align-items: center !important;
    gap: 10px !important;
    padding: 10px 12px !important;
    border-radius: 12px !important;
    background: rgba(10, 20, 38, 0.3) !important;
    border: 1px solid rgba(255, 255, 255, 0.05) !important;
    margin-top: 12px !important;
    cursor: pointer !important;
    transition: all 0.25s ease !important;
}
.m-cortex-trigger:hover, .m-cortex-trigger:active {
    border-color: rgba(34, 211, 238, 0.2) !important;
    background: rgba(10, 20, 38, 0.45) !important;
}
.m-ct-icon {
    font-size: 0.85rem !important;
    color: var(--neon-cyan) !important;
    width: 24px !important;
    height: 24px !important;
    border-radius: 6px !important;
    background: rgba(34, 211, 238, 0.08) !important;
    display: grid !important;
    place-items: center !important;
}
.m-ct-text {
    flex-grow: 1 !important;
    display: flex !important;
    flex-direction: column !important;
}
.m-ct-title {
    font-family: 'Rajdhani', sans-serif !important;
    font-weight: 800 !important;
    font-size: 0.74rem !important;
    letter-spacing: 0.6px !important;
    color: #fff !important;
}
.m-ct-desc {
    font-size: 0.6rem !important;
    color: var(--text-dim) !important;
    opacity: 0.8;
    margin-top: 1px !important;
}
.m-ct-status {
    font-family: 'Rajdhani', monospace !important;
    font-size: 0.58rem !important;
    font-weight: 900 !important;
    padding: 1px 6px !important;
    border-radius: 4px !important;
    background: rgba(255, 255, 255, 0.05) !important;
    border: 1px solid rgba(255, 255, 255, 0.08) !important;
    color: var(--text-dim) !important;
}
.m-ct-status.on {
    color: #001217 !important;
    background: var(--neon-cyan) !important;
    border-color: transparent !important;
    box-shadow: 0 0 6px var(--neon-cyan-glow) !important;
}

#m-custom-skin-area {
    display: none;
    margin-top: 8px;
}
.m-custom-tpl-input {
    width: 100% !important;
    padding: 10px 12px !important;
    background: rgba(4, 8, 16, 0.6) !important;
    border: 1px solid rgba(255, 255, 255, 0.08) !important;
    border-radius: 10px !important;
    color: #fff !important;
    font-family: 'JetBrains Mono', monospace !important;
    font-size: 0.72rem !important;
    box-shadow: inset 0 1px 3px rgba(0, 0, 0, 0.4) !important;
}
.m-custom-tpl-input:focus {
    border-color: rgba(34, 211, 238, 0.3) !important;
}
.m-custom-help {
    margin-top: 6px !important;
    padding: 8px 10px !important;
    border-radius: 8px !important;
    background: rgba(0, 0, 0, 0.15) !important;
    border: 1px solid rgba(255, 255, 255, 0.03) !important;
    color: var(--text-faint) !important;
    font-size: 0.6rem !important;
    line-height: 1.4 !important;
    font-family: 'JetBrains Mono', monospace !important;
}
.m-custom-help code {
    color: var(--neon-cyan);
}

#m-priority-panel {
    margin-top: 14px;
}

.m-ghost-panel {
    background: rgba(155, 108, 255, 0.05) !important;
    border: 1px solid rgba(155, 108, 255, 0.15) !important;
    border-left: 4px solid var(--neon-violet) !important;
    border-radius: 12px !important;
    padding: 12px 14px !important;
    margin-top: 14px;
}
.m-ghost-head {
    display: flex !important;
    justify-content: space-between !important;
    align-items: center !important;
    margin-bottom: 6px !important;
}
.m-ghost-title {
    font-family: 'Rajdhani', sans-serif !important;
    font-weight: 800 !important;
    font-size: 0.85rem !important;
    color: #fff !important;
    display: flex !important;
    align-items: center !important;
    gap: 6px !important;
}
.m-ghost-title i {
    color: var(--neon-violet) !important;
}
.m-ghost-status {
    font-family: 'Rajdhani', monospace !important;
    font-size: 0.58rem !important;
    font-weight: 900 !important;
    color: var(--neon-violet) !important;
    border: 1px solid rgba(155, 108, 255, 0.22) !important;
    background: rgba(155, 108, 255, 0.05) !important;
    padding: 1px 6px !important;
    border-radius: 4px !important;
}

.m-field-group {
    margin-bottom: 12px;
}
.m-field-header {
    margin-bottom: 5px;
    margin-left: 4px;
}
.m-field-label {
    font-family: 'Rajdhani', sans-serif;
    font-weight: 800;
    font-size: 0.65rem;
    letter-spacing: 1.5px;
    color: var(--neon-cyan);
    text-transform: uppercase;
}
.m-input-box {
    display: flex !important;
    align-items: center !important;
    background: rgba(4, 10, 20, 0.65) !important;
    border: 1px solid rgba(255, 255, 255, 0.07) !important;
    border-radius: 12px !important;
    height: 40px !important;
    padding: 0 6px 0 10px !important;
    gap: 8px !important;
}
.m-input-ico {
    font-size: 0.8rem !important;
    color: var(--text-dim) !important;
}
.m-input-tech {
    flex-grow: 1 !important;
    background: transparent !important;
    border: none !important;
    color: #fff !important;
    font-family: 'Outfit', sans-serif !important;
    font-size: 0.8rem !important;
    padding: 0 !important;
    height: 100% !important;
}
.m-input-tech::placeholder {
    color: var(--text-faint) !important;
}

.m-credits-section {
    margin-top: 24px;
    padding-bottom: env(safe-area-inset-bottom, 12px);
}
.m-neural-frame {
    background: rgba(10, 20, 38, 0.35) !important;
    border: 1px solid rgba(255, 255, 255, 0.05) !important;
    border-radius: 16px !important;
    padding: 12px 14px !important;
    display: flex !important;
    flex-direction: column !important;
    gap: 10px !important;
}
.m-neural-header {
    display: flex !important;
    justify-content: space-between !important;
    align-items: center !important;
    font-family: 'Rajdhani', monospace !important;
    font-size: 0.58rem !important;
    font-weight: 800 !important;
    color: var(--text-faint) !important;
    border-bottom: 1px solid rgba(255, 255, 255, 0.04) !important;
    padding-bottom: 6px !important;
}

.m-neural-grid {
    display: grid !important;
    grid-template-columns: 2fr 1fr !important;
    gap: 8px !important;
}

.m-dev-module {
    background: rgba(10, 20, 38, 0.45) !important;
    border: 1px solid rgba(255, 255, 255, 0.06) !important;
    border-radius: 12px !important;
    padding: 8px 10px !important;
    display: flex !important;
    align-items: center !important;
    gap: 8px !important;
    text-decoration: none !important;
    position: relative !important;
}
.m-dev-img {
    width: 30px !important;
    height: 30px !important;
    border-radius: 50% !important;
    border: 1px solid rgba(34, 211, 238, 0.3) !important;
    object-fit: cover !important;
}
.m-dev-data {
    display: flex !important;
    flex-direction: column !important;
}
.m-dev-role {
    font-family: 'Rajdhani', sans-serif !important;
    font-weight: 800 !important;
    font-size: 0.52rem !important;
    letter-spacing: 1px;
    color: var(--neon-cyan) !important;
}
.m-dev-nick {
    font-family: 'Outfit', sans-serif !important;
    font-weight: 700 !important;
    font-size: 0.78rem !important;
    color: #fff !important;
}

.m-support-module {
    background: rgba(155, 108, 255, 0.08) !important;
    border: 1px solid rgba(155, 108, 255, 0.2) !important;
    border-radius: 12px !important;
    display: flex !important;
    flex-direction: column !important;
    align-items: center !important;
    justify-content: center !important;
    gap: 3px !important;
    text-decoration: none !important;
    color: #fff !important;
    cursor: pointer !important;
}
.m-kofi-ico {
    font-size: 0.95rem !important;
    color: var(--neon-violet) !important;
    animation: bounceSlow 3s infinite alternate;
}
.m-support-txt {
    font-family: 'Rajdhani', sans-serif !important;
    font-weight: 800 !important;
    font-size: 0.6rem !important;
    letter-spacing: 0.8px !important;
}

.m-star-btn {
    display: flex !important;
    align-items: center !important;
    justify-content: center !important;
    gap: 8px !important;
    height: 38px !important;
    border-radius: 10px !important;
    background: linear-gradient(135deg, rgba(34, 211, 238, 0.08) 0%, rgba(155, 108, 255, 0.08) 100%) !important;
    border: 1px solid rgba(34, 211, 238, 0.16) !important;
    color: #e5f9ff !important;
    font-family: 'Rajdhani', sans-serif !important;
    font-weight: 800 !important;
    font-size: 0.76rem !important;
    letter-spacing: 1.5px !important;
    text-decoration: none !important;
    transition: all 0.2s ease !important;
}
.m-star-btn:active {
    transform: scale(0.97) !important;
    background: linear-gradient(135deg, rgba(34, 211, 238, 0.15) 0%, rgba(155, 108, 255, 0.15) 100%) !important;
}
.spin-star {
    font-size: 0.68rem !important;
    color: var(--neon-cyan) !important;
    animation: rotateStar 8s linear infinite;
}

.m-neural-footer {
    text-align: center !important;
    font-family: 'Rajdhani', monospace !important;
    font-size: 0.54rem !important;
    font-weight: 700 !important;
    color: var(--text-faint) !important;
    letter-spacing: 1px !important;
}

.m-action-modal {
    position: fixed !important;
    inset: 0 !important;
    background: rgba(0, 2, 8, 0.75) !important;
    backdrop-filter: blur(14px) !important;
    -webkit-backdrop-filter: blur(14px) !important;
    display: flex !important;
    align-items: center !important;
    justify-content: center !important;
    padding: 20px !important;
    z-index: 10050 !important;
    opacity: 0 !important;
    pointer-events: none !important;
    transition: opacity 0.3s ease !important;
}
.m-action-modal.show {
    opacity: 1 !important;
    pointer-events: auto !important;
}

.m-am-card {
    width: min(380px, 100%) !important;
    background: var(--glass-card) !important;
    border: 1px solid var(--glass-border) !important;
    border-radius: 20px !important;
    padding: 20px !important;
    box-shadow: 0 24px 60px rgba(0, 0, 0, 0.8),
                0 0 30px rgba(34, 211, 238, 0.05) !important;
    backdrop-filter: var(--glass-blur) !important;
    -webkit-backdrop-filter: var(--glass-blur) !important;
    display: flex !important;
    flex-direction: column !important;
    gap: 12px !important;
    transform: translate3d(0, 15px, 0) scale(0.97) !important;
    transition: transform 0.3s cubic-bezier(0.34, 1.56, 0.64, 1) !important;
}
.m-action-modal.show .m-am-card {
    transform: translate3d(0, 0, 0) scale(1) !important;
}

.m-am-title {
    font-family: 'Rajdhani', sans-serif !important;
    font-weight: 900 !important;
    font-size: 1.15rem !important;
    letter-spacing: 1px !important;
    color: #fff !important;
    text-shadow: 0 0 10px rgba(34, 211, 238, 0.3) !important;
    text-align: center !important;
}
.m-am-subtitle {
    font-size: 0.72rem !important;
    color: var(--text-dim) !important;
    text-align: center !important;
    margin-top: -6px !important;
    opacity: 0.9;
}

.m-flux-terminal {
    background: rgba(4, 8, 16, 0.6) !important;
    border: 1px solid rgba(255, 255, 255, 0.05) !important;
    border-radius: 14px !important;
    padding: 10px 12px !important;
    box-shadow: inset 0 1px 3px rgba(0, 0, 0, 0.5) !important;
}
.m-flux-header {
    display: flex !important;
    justify-content: space-between !important;
    align-items: center !important;
    margin-bottom: 6px !important;
    border-bottom: 1px solid rgba(255, 255, 255, 0.04) !important;
    padding-bottom: 4px !important;
}
.m-flux-header span {
    font-family: 'Rajdhani', monospace !important;
    font-size: 0.64rem !important;
    font-weight: 800 !important;
    color: var(--neon-cyan) !important;
}
.m-flux-header i {
    font-size: 0.64rem !important;
    color: var(--neon-cyan) !important;
}
.m-flux-input {
    width: 100% !important;
    height: 52px !important;
    background: transparent !important;
    border: none !important;
    color: var(--text-dim) !important;
    font-family: 'JetBrains Mono', monospace !important;
    font-size: 0.64rem !important;
    line-height: 1.4 !important;
    resize: none !important;
    overflow-y: auto !important;
    padding: 0 !important;
}

.m-act-btn {
    height: 44px !important;
    border-radius: 12px !important;
    display: flex !important;
    align-items: center !important;
    justify-content: center !important;
    gap: 8px !important;
    font-family: 'Rajdhani', sans-serif !important;
    font-weight: 800 !important;
    font-size: 0.85rem !important;
    letter-spacing: 1px !important;
    cursor: pointer !important;
    border: none !important;
    transition: all 0.2s ease !important;
}
.m-act-copy {
    background: linear-gradient(135deg, var(--neon-cyan) 0%, #0ea5e9 100%) !important;
    color: #fff !important;
    box-shadow: 0 6px 16px -4px rgba(34, 211, 238, 0.4) !important;
}
.m-act-copy:active {
    transform: scale(0.96) !important;
}
.m-act-close {
    background: rgba(255, 255, 255, 0.04) !important;
    border: 1px solid rgba(255, 255, 255, 0.08) !important;
    color: var(--text-dim) !important;
}
.m-act-close:active {
    background: rgba(255, 255, 255, 0.08) !important;
    transform: scale(0.96) !important;
}

.m-toast-container {
    position: fixed !important;
    top: calc(72px + var(--safe-top, 0px)) !important;
    left: 50% !important;
    transform: translate3d(-50%, 0, 0) !important;
    width: auto !important;
    max-width: calc(100% - 32px) !important;
    display: flex !important;
    flex-direction: column !important;
    gap: 8px !important;
    z-index: 10090 !important;
    pointer-events: none !important;
}

.m-toast {
    background: rgba(10, 20, 38, 0.85) !important;
    border: 1px solid rgba(255, 255, 255, 0.08) !important;
    border-radius: 12px !important;
    padding: 10px 14px !important;
    display: flex !important;
    align-items: center !important;
    gap: 8px !important;
    color: #fff !important;
    box-shadow: 0 10px 24px -5px rgba(0, 0, 0, 0.6) !important;
    backdrop-filter: blur(12px) !important;
    -webkit-backdrop-filter: blur(12px) !important;
    animation: toastIn 0.35s cubic-bezier(0.175, 0.885, 0.32, 1.275);
    transition: all 0.3s ease !important;
    pointer-events: auto !important;
    min-width: 240px !important;
}

.m-toast i {
    font-size: 0.95rem !important;
}
.m-toast span {
    font-family: 'Outfit', sans-serif !important;
    font-weight: 600 !important;
    font-size: 0.76rem !important;
}

.m-toast.out {
    opacity: 0 !important;
    transform: translate3d(0, -12px, 0) scale(0.9) !important;
}

.m-toast.info { border-left: 3px solid var(--neon-cyan) !important; }
.m-toast.info i { color: var(--neon-cyan) !important; }

.m-toast.warning { border-left: 3px solid var(--neon-orange) !important; }
.m-toast.warning i { color: var(--neon-orange) !important; }

.m-toast.success { border-left: 3px solid var(--neon-green) !important; }
.m-toast.success i { color: var(--neon-green) !important; }

.m-toast.error { border-left: 3px solid var(--neon-rose) !important; }
.m-toast.error i { color: var(--neon-rose) !important; }

.m-ptr {
    position: absolute;
    top: -70px;
    left: 0;
    width: 100%;
    height: 70px;
    display: flex;
    align-items: flex-end;
    justify-content: center;
    padding-bottom: 15px;
    color: var(--neon-cyan);
    z-index: 10040;
    pointer-events: none;
    opacity: 0;
    transition: opacity 0.2s ease-out;
}
.m-ptr-icon {
    font-size: 1.3rem;
    transition: transform 0.3s cubic-bezier(0.175, 0.885, 0.32, 1.275);
    background: rgba(4, 10, 20, 0.9);
    padding: 10px;
    border-radius: 50%;
    border: 1px solid var(--neon-cyan);
    box-shadow: 0 0 15px rgba(34, 211, 238, 0.3);
}
.m-ptr.loading .m-ptr-icon {
    animation: spin 1s linear infinite;
    border-color: var(--neon-violet);
    box-shadow: 0 0 15px rgba(155, 108, 255, 0.3);
}

.m-input-fuselage.is-p2p {
    opacity: 0.45;
    pointer-events: none;
    filter: grayscale(0.85);
}
`;
const mobileHTML = `
<div id="m-sea-webgl" aria-hidden="true"></div>
<div class="m-caustic" aria-hidden="true">
    <div class="m-caustic-ray" style="--ray-x:8%;--ray-dur:14s;--ray-op:0.55;--ray-from:-12deg;--ray-to:6deg;width:50px;"></div>
    <div class="m-caustic-ray" style="--ray-x:28%;--ray-dur:11s;--ray-op:0.40;--ray-from:-6deg;--ray-to:14deg;width:35px;"></div>
    <div class="m-caustic-ray" style="--ray-x:50%;--ray-dur:16s;--ray-op:0.65;--ray-from:-10deg;--ray-to:8deg;width:65px;"></div>
    <div class="m-caustic-ray" style="--ray-x:68%;--ray-dur:9s;--ray-op:0.35;--ray-from:5deg;--ray-to:-12deg;width:40px;"></div>
    <div class="m-caustic-ray" style="--ray-x:85%;--ray-dur:13s;--ray-op:0.50;--ray-from:8deg;--ray-to:-6deg;width:55px;"></div>
</div>
<div class="m-ocean-particles" id="m-ocean-particles" aria-hidden="true"></div>
<div id="app-container">
    <div class="m-ptr" id="m-ptr-indicator"><i class="fas fa-arrow-down m-ptr-icon"></i></div>
    <div class="m-content-wrapper">

        <div class="m-content">
            <div class="m-hero m-abyss-hero notranslate" aria-label="LEVIATHAN Kit" translate="no" data-no-translate="true">
                <div class="m-hero-panel">
                    <div class="logo-container m-abyss-logo">
                        <span class="m-abyss-crown" aria-hidden="true"></span>
                        <span class="m-cyber-corner cc-tl" aria-hidden="true"></span>
                        <span class="m-cyber-corner cc-tr" aria-hidden="true"></span>
                        <span class="m-cyber-corner cc-bl" aria-hidden="true"></span>
                        <span class="m-cyber-corner cc-br" aria-hidden="true"></span>
                        <img src="${MOBILE_LOGO_URL}" alt="LEVIATHAN Logo" class="logo-image notranslate" translate="no" data-no-translate="true" fetchpriority="high" decoding="sync" loading="eager" width="110" height="110">
                        <div class="logo-particles" aria-hidden="true">
                            <span class="logo-particle" style="left:18%; width:5px; height:5px; animation-delay:0s;"></span>
                            <span class="logo-particle" style="left:38%; width:3px; height:3px; animation-delay:2.4s;"></span>
                            <span class="logo-particle" style="left:63%; width:4px; height:4px; animation-delay:4.1s;"></span>
                            <span class="logo-particle" style="left:78%; width:3px; height:3px; animation-delay:6.2s;"></span>
                        </div>
                    </div>
                    <h1 class="m-brand-title m-abyss-title notranslate" translate="no" lang="zxx" data-brand-lock="LEVIATHAN" data-no-translate="true" aria-label="LEVIATHAN">LEVIATHAN</h1>
                    <div class="m-brand-sub m-abyss-sub">Sovrano degli abissi</div>
                    <div class="m-hero-badges">
                        <span class="m-hero-badge">🐬 Real-Debrid</span>
                        <span class="m-hero-badge">🧊 TorBox</span>
                        <span class="m-hero-badge">🦈 P2P</span>
                    </div>
                    <div class="m-version-tag m-abyss-version" aria-label="Versione 3.2.0">
                        <span class="m-v-dot" aria-hidden="true"></span>
                        <span>v3.2.0</span>
                    </div>
                </div>
            </div>

            <div id="page-setup" class="m-page active">

                <div class="m-hypervisor" style="margin-top:2px;">
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
                            <input type="text" id="m-apiKey" class="m-if-field" placeholder="Incolla key" oninput="handleMobileApiKeyInput()">
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
                            <input type="text" id="m-tmdb" class="m-if-field" placeholder="Personal key" oninput="updateLinkModalContent()">
                            <div class="m-if-action" onclick="pasteTo('m-tmdb')"><i class="fas fa-paste"></i></div>
                            <div class="m-get-link" style="color:var(--m-accent); border-color:var(--m-accent); background:rgba(155, 108, 255,0.05);" onclick="openApiPage('tmdb')">GET <i class="fas fa-external-link-alt"></i></div>
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
                                <span class="m-provider-glyph m-core-icon" aria-hidden="true">🍿</span>
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
</div>
                        </div>

                        <div class="m-reactor-module" id="mod-cc">
                            <div class="m-reactor-core">
                                <span class="m-provider-glyph m-core-icon" aria-hidden="true">🎟️</span>
                            </div>
                            <div class="m-reactor-body">
                                <div class="m-reactor-top">
                                    <span class="m-reactor-title">🎟️ CinemaCity</span>
                                    <label class="m-switch">
                                        <input type="checkbox" id="m-enableCc" onchange="updateStatus('m-enableCc','st-cc'); toggleModuleStyle('m-enableCc', 'mod-cc');">
                                        <span class="m-slider"></span>
                                    </label>
                                </div>
                                <span class="m-reactor-desc">Catalogo Film e Serie TV via CloudflareBypass e proxy CCCDN/Kraken 🎟️.</span>
                                <div class="m-tag-row">
                                    <span class="m-tech-tag tag-noproxy"><i class="fas fa-unlink"></i> NO PROXY</span>
                                </div>
                            </div>
                        </div>

                        <div class="m-reactor-module" id="mod-ghd">
                            <div class="m-reactor-core">
                                <span class="m-provider-glyph m-core-icon" aria-hidden="true">🎬</span>
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
                                <span class="m-provider-glyph m-core-icon" aria-hidden="true">📺</span>
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

                        <div class="m-reactor-module" id="mod-vidxgo">
                            <div class="m-reactor-core">
                                <span class="m-provider-glyph m-core-icon" aria-hidden="true">🎯</span>
                            </div>
                            <div class="m-reactor-body">
                                <div class="m-reactor-top">
                                    <span class="m-reactor-title">🎯 VidxGo</span>
                                    <label class="m-switch">
                                        <input type="checkbox" id="m-enableVidxgo" onchange="updateStatus('m-enableVidxgo','st-vidxgo'); toggleModuleStyle('m-enableVidxgo', 'mod-vidxgo');">
                                        <span class="m-slider m-slider-aqua"></span>
                                    </label>
                                </div>
                                <span class="m-reactor-desc">Player diretto per film e serie TV, flusso risolto dal codice IMDb ⚡.</span>
                                <div class="m-tag-row">
                                    <span class="m-tech-tag tag-noproxy"><i class="fas fa-unlink"></i> NO PROXY</span>
                                </div>
                            </div>
                        </div>

                        <div class="m-reactor-module" id="mod-es">
                            <div class="m-reactor-core">
                                <span class="m-provider-glyph m-core-icon" aria-hidden="true">🌍</span>
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
                                <span class="m-provider-glyph m-core-icon" aria-hidden="true">🎬</span>
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

                        <div class="m-reactor-module" id="mod-onlineserietv">
                            <div class="m-reactor-core">
                                <span class="m-provider-glyph m-core-icon" aria-hidden="true">🖥️</span>
                            </div>
                            <div class="m-reactor-body">
                                <div class="m-reactor-top">
                                    <span class="m-reactor-title">🖥️ OnlineSerieTV</span>
                                    <label class="m-switch">
                                        <input type="checkbox" id="m-enableOnlineserietv" onchange="updateStatus('m-enableOnlineserietv','st-onlineserietv'); toggleModuleStyle('m-enableOnlineserietv', 'mod-onlineserietv');">
                                        <span class="m-slider m-slider-aqua"></span>
                                    </label>
                                </div>
                                <span class="m-reactor-desc">Film e serie TV italiani, risolti via uprot/MaxStream con forward proxy 🛰️.</span>
                                <div class="m-tag-row">
                                    <span class="m-tech-tag tag-kraken"><i class="fas fa-water"></i> KRAKEN</span>
                                </div>
                            </div>
                        </div>

                        <div class="m-reactor-module" id="mod-aw">
                            <div class="m-reactor-core">
                                <span class="m-provider-glyph m-core-icon" aria-hidden="true">⛩️</span>
                            </div>
                            <div class="m-reactor-body">
                                <div class="m-reactor-top">
                                    <span class="m-reactor-title">⛩️ AnimeWorld</span>
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
                                <span class="m-provider-glyph m-core-icon" aria-hidden="true">🌊</span>
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
                                <span class="m-provider-glyph m-core-icon" aria-hidden="true">🪐</span>
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

                        <div class="m-reactor-module" id="mod-ti">
                            <div class="m-reactor-core">
                                <span class="m-provider-glyph m-core-icon" aria-hidden="true">🐙</span>
                            </div>
                            <div class="m-reactor-body">
                                <div class="m-reactor-top">
                                    <span class="m-reactor-title">🐙 ToonItalia</span>
                                    <label class="m-switch">
                                        <input type="checkbox" id="m-enableToonItalia" onchange="updateStatus('m-enableToonItalia','st-ti'); toggleModuleStyle('m-enableToonItalia', 'mod-ti');">
                                        <span class="m-slider m-slider-aqua"></span>
                                    </label>
                                </div>
                                <span class="m-reactor-desc">Cartoon e anime in italiano, con resolver VOE, LoadM/RPMShare e MaxStream.</span>
                                <div class="m-tag-row">
                                    <span class="m-tech-tag tag-kraken"><i class="fas fa-water"></i> KRAKEN</span>
                                </div>
                            </div>
                        </div>

                        <div class="m-reactor-module" id="mod-gf">
                            <div class="m-reactor-core">
                                <span class="m-provider-glyph m-core-icon" aria-hidden="true">🎞️</span>
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

                        <div class="m-reactor-module" id="mod-ads">
                            <div class="m-reactor-core">
                                <span class="m-provider-glyph m-core-icon" aria-hidden="true">📽️</span>
                            </div>
                            <div class="m-reactor-body">
                                <div class="m-reactor-top">
                                    <span class="m-reactor-title">📽️ Altadefinizione</span>
                                    <label class="m-switch">
                                        <input type="checkbox" id="m-enableAltadefinizione" onchange="updateStatus('m-enableAltadefinizione','st-ads'); toggleModuleStyle('m-enableAltadefinizione', 'mod-ads');">
                                        <span class="m-slider"></span>
                                    </label>
                                </div>
                                <span class="m-reactor-desc">Film e serie TV con catalogo aggiornato e navigazione intuitiva 🎟️.</span>
                                <div class="m-tag-row">
                                    <span class="m-tech-tag tag-kraken"><i class="fas fa-water"></i> KRAKEN</span>
                                </div>
                            </div>
                        </div>


                    </div>
                </div>

                <div id="m-priority-panel" class="m-priority-wrapper">
                    <div style="margin-top:5px; padding:15px; border-radius:16px; background:linear-gradient(90deg, rgba(155,108,255,0.1), transparent); border-left:4px solid var(--m-secondary);">
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

                <div class="m-setup-actions-panel" aria-label="Azioni configurazione">
                    <div class="m-setup-action-row">
                        <button class="m-setup-action m-setup-install" onclick="mobileInstall()" type="button">
                            <span>INSTALLA</span>
                            <i class="fas fa-radiation"></i>
                        </button>
                    </div>

                    <div class="m-setup-mini-console" aria-label="Console copia link">
                        <div class="m-setup-mini-console-head">
                            <span class="m-setup-mini-console-title"><i class="fas fa-terminal"></i> LINK CONFIGURAZIONE</span>
                            <button class="m-setup-mini-copy" onclick="copyFromSetupPanel()" type="button">
                                <i class="fas fa-copy"></i>
                                <span>COPIA</span>
                            </button>
                        </div>
                        <div class="m-setup-mini-console-body">
                            <textarea id="m-setupGeneratedUrlBox" class="m-setup-mini-url" readonly>/// WAITING FOR DATA ///</textarea>
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
                        <i class="fas fa-network-wired m-hyp-icon" style="color:var(--m-secondary); border-color:rgba(155,108,255,0.35); background:rgba(155,108,255,0.08);"></i>
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
let mScQuality = '1080';
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

const LEVIATHAN_SEA_SHADER = {
    vertex: `
        attribute vec2 a_position;
        varying vec2 v_uv;
        void main() {
            v_uv = a_position * 0.5 + 0.5;
            gl_Position = vec4(a_position, 0.0, 1.0);
        }
    `,
    fragment: `
        precision mediump float;

        uniform vec2 u_resolution;
        uniform float u_time;
        uniform float u_intensity;
        varying vec2 v_uv;

        float hash(vec2 p) {
            p = fract(p * vec2(123.34, 456.21));
            p += dot(p, p + 45.32);
            return fract(p.x * p.y);
        }

        float noise(vec2 p) {
            vec2 i = floor(p);
            vec2 f = fract(p);
            vec2 u = f * f * (3.0 - 2.0 * f);
            return mix(
                mix(hash(i + vec2(0.0, 0.0)), hash(i + vec2(1.0, 0.0)), u.x),
                mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x),
                u.y
            );
        }

        float fbm(vec2 p) {
            float v = 0.0;
            float a = 0.5;
            mat2 r = mat2(0.80, -0.60, 0.60, 0.80);
            for (int i = 0; i < 5; i++) {
                v += a * noise(p);
                p = r * p * 2.02 + 11.3;
                a *= 0.53;
            }
            return v;
        }

        float caustic(vec2 p, float t) {
            vec2 q = p;
            q += 0.55 * vec2(fbm(p * 1.6 + vec2(t * 0.22, 0.0)), fbm(p * 1.6 + vec2(0.0, t * 0.18)));
            float n1 = fbm(q * 2.4 - vec2(t * 0.12, t * 0.15));
            float n2 = fbm(q * 4.1 + vec2(t * 0.10, -t * 0.08));
            float ridge1 = 1.0 - abs(2.0 * n1 - 1.0);
            float ridge2 = 1.0 - abs(2.0 * n2 - 1.0);
            return pow(ridge1, 3.0) * 0.7 + pow(ridge2, 4.0) * 0.3;
        }

        void main() {
            vec2 res = max(u_resolution.xy, vec2(1.0));
            vec2 uv = gl_FragCoord.xy / res;
            float aspect = res.x / max(res.y, 1.0);

            vec2 autoOffset = vec2(sin(u_time * 0.25) * 0.06, cos(u_time * 0.18) * 0.03);
            vec2 p = vec2((uv.x - 0.5) * aspect, uv.y) - autoOffset;

            float t = u_time * 0.28;

            float depth = uv.y;
            vec3 deep = vec3(0.002, 0.015, 0.038);
            vec3 surf = vec3(0.010, 0.070, 0.130);
            vec3 col = mix(deep, surf, smoothstep(0.0, 1.0, depth));

            float env = smoothstep(0.02, 0.85, depth);

            vec2 cuv = p * 2.1 + vec2(0.0, -u_time * 0.012);
            float c = caustic(cuv, t);
            col += vec3(0.12, 0.48, 0.65) * c * env * 0.45;

            float c2 = caustic(cuv * 0.58 + 8.0, t * 0.65);
            col += vec3(0.07, 0.32, 0.48) * c2 * env * 0.25;

            float rays = 0.0;
            float autoSlope = sin(u_time * 0.15) * 0.22;
            float rx = p.x * 0.75 + sin(u_time * 0.10) * 0.15 - p.y * autoSlope;

            rays += smoothstep(0.55, 0.0, abs(rx + 0.25 + sin(u_time * 0.12) * 0.05));
            rays += smoothstep(0.48, 0.0, abs(rx - 0.20 + sin(u_time * 0.10 + 1.6) * 0.04)) * 0.75;
            rays += smoothstep(0.42, 0.0, abs(rx + 0.75 + sin(u_time * 0.08 + 3.2) * 0.03)) * 0.55;
            rays *= smoothstep(0.05, 1.0, depth) * (0.42 + 0.58 * fbm(vec2(p.x * 2.2, u_time * 0.16)));
            col += vec3(0.15, 0.46, 0.60) * rays * 0.095;

            float motes = smoothstep(0.993, 1.0, hash(floor((p + vec2(0.0, u_time * 0.008)) * 110.0)));
            col += vec3(0.25, 0.55, 0.70) * motes * 0.15;

            col += vec3(0.060, 0.025, 0.110) * smoothstep(0.55, 1.0, uv.x) * 0.18;

            float vign = smoothstep(1.35, 0.22, length((uv - 0.5) * vec2(aspect * 0.42, 1.0)));
            col *= 0.75 + vign * 0.32;

            col *= 0.85 + 0.15 * u_intensity;
            col = pow(max(col, 0.0), vec3(0.88));
            gl_FragColor = vec4(col, 1.0);
        }
    `
};

function leviathanSeaShouldSkip() {
    return true; // Bypassed WebGL to always use the lightweight CSS ocean fallback on mobile
}

function createSeaShaderProgram(gl, vertexSource, fragmentSource) {
    const compile = (type, source) => {
        const shader = gl.createShader(type);
        if (!shader) throw new Error('shader allocation failed');
        gl.shaderSource(shader, source);
        gl.compileShader(shader);
        if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
            const info = gl.getShaderInfoLog(shader) || 'shader compile failed';
            gl.deleteShader(shader);
            throw new Error(info);
        }
        return shader;
    };

    const vertex = compile(gl.VERTEX_SHADER, vertexSource);
    const fragment = compile(gl.FRAGMENT_SHADER, fragmentSource);
    const program = gl.createProgram();
    if (!program) throw new Error('program allocation failed');
    gl.attachShader(program, vertex);
    gl.attachShader(program, fragment);
    gl.linkProgram(program);
    gl.deleteShader(vertex);
    gl.deleteShader(fragment);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
        const info = gl.getProgramInfoLog(program) || 'program link failed';
        gl.deleteProgram(program);
        throw new Error(info);
    }
    return program;
}

function getLeviathanSeaProfile() {
    const cores = navigator.hardwareConcurrency || 8;
    const memory = Number(navigator['deviceMemory'] || 0);
    const lowfx = !!document.body?.classList?.contains('m-lowfx');
    const tiny = (memory > 0 && memory <= 2) || (cores && cores <= 2);
    const lite = lowfx || tiny || (cores && cores <= 4) || (memory && memory <= 4);
    if (tiny) return { dpr: 0.72, fps: 18, intensity: 0.72 };
    if (lite) return { dpr: 0.88, fps: 24, intensity: 0.86 };
    return { dpr: 1.15, fps: 30, intensity: 1.0 };
}

function startLeviathanSeaShader(mount) {
    if (!mount || window.__leviathanSea) return;

    const profile = getLeviathanSeaProfile();
    const canvas = document.createElement('canvas');
    canvas.setAttribute('aria-hidden', 'true');
    canvas.style.width = '100%';
    canvas.style.height = '100%';
    mount.textContent = '';
    mount.appendChild(canvas);

    const gl = canvas.getContext('webgl', {
        alpha: true,
        antialias: false,
        depth: false,
        stencil: false,
        preserveDrawingBuffer: false,
        powerPreference: 'low-power'
    }) || canvas.getContext('experimental-webgl');

    if (!gl) {
        mount.remove();
        window.__leviathanSeaShaderBoot = false;
        activateLeviathanSeaFallback();
        return;
    }

    let program = null;
    let buffer = null;
    let resizeRaf = 0;
    let classObserver = null;
    let disposed = false;
    let contextLost = false;

    try {
        program = createSeaShaderProgram(gl, LEVIATHAN_SEA_SHADER.vertex, LEVIATHAN_SEA_SHADER.fragment);
        buffer = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    } catch (_) {
        try { if (program) gl.deleteProgram(program); } catch (__) {}
        try { if (buffer) gl.deleteBuffer(buffer); } catch (__) {}
        mount.remove();
        window.__leviathanSeaShaderBoot = false;
        activateLeviathanSeaFallback();
        return;
    }

    const locPosition = gl.getAttribLocation(program, 'a_position');
    const locResolution = gl.getUniformLocation(program, 'u_resolution');
    const locTime = gl.getUniformLocation(program, 'u_time');
    const locIntensity = gl.getUniformLocation(program, 'u_intensity');
    const minFrameMs = Math.max(16, Math.round(1000 / Math.max(12, profile.fps || 24)));
    const bornAt = performance.now();

    const state = {
        raf: 0,
        lastFrame: 0,
        paused: false,
        sync: null,
        cleanup: null
    };

    const resize = () => {
        if (disposed || contextLost) return;
        const rect = mount.getBoundingClientRect();
        const dpr = Math.max(0.65, Math.min(window.devicePixelRatio || 1, profile.dpr));
        const width = Math.max(2, Math.floor((rect.width || window.innerWidth || 390) * dpr));
        const height = Math.max(2, Math.floor((rect.height || window.innerHeight || 760) * dpr));
        if (canvas.width !== width || canvas.height !== height) {
            canvas.width = width;
            canvas.height = height;
        }
        gl.viewport(0, 0, width, height);
    };

    const draw = (now) => {
        state.raf = 0;
        if (disposed || contextLost || state.paused) return;
        if (state.lastFrame && now - state.lastFrame < minFrameMs) {
            state.raf = requestAnimationFrame(draw);
            return;
        }
        state.lastFrame = now;

        try {
            resize();
            gl.useProgram(program);
            gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
            gl.enableVertexAttribArray(locPosition);
            gl.vertexAttribPointer(locPosition, 2, gl.FLOAT, false, 0, 0);
            gl.uniform2f(locResolution, canvas.width, canvas.height);
            gl.uniform1f(locTime, (now - bornAt) * 0.001);
            gl.uniform1f(locIntensity, profile.intensity);
            gl.disable(gl.DEPTH_TEST);
            gl.disable(gl.CULL_FACE);
            gl.enable(gl.BLEND);
            gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
            gl.clearColor(0, 0, 0, 0);
            gl.clear(gl.COLOR_BUFFER_BIT);
            gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
        } catch (_) {
            state.cleanup && state.cleanup();
            activateLeviathanSeaFallback();
            return;
        }

        state.raf = requestAnimationFrame(draw);
    };

    const shouldPause = () => document.hidden
        || document.body.classList.contains('m-typing')
        || document.body.classList.contains('m-keyboard-open')
        || document.body.classList.contains('m-page-hidden');

    const stop = () => {
        if (state.paused) return;
        state.paused = true;
        if (state.raf) cancelAnimationFrame(state.raf);
        state.raf = 0;
        mount.classList.add('is-paused');
    };

    const go = () => {
        if (disposed || contextLost || shouldPause()) return stop();
        if (!state.paused && state.raf) return;
        state.paused = false;
        state.lastFrame = 0;
        mount.classList.remove('is-paused');
        state.raf = requestAnimationFrame(draw);
    };

    let pendingSync = 0;
    const sync = () => {
        if (pendingSync || disposed) return;
        pendingSync = requestAnimationFrame(() => {
            pendingSync = 0;
            shouldPause() ? stop() : go();
        });
    };

    const onResize = () => {
        if (resizeRaf) cancelAnimationFrame(resizeRaf);
        resizeRaf = requestAnimationFrame(() => {
            resizeRaf = 0;
            resize();
        });
    };

    const onContextLost = (event) => {
        event.preventDefault();
        contextLost = true;
        stop();
        mount.classList.remove('is-ready');
    };

    const onContextRestored = () => {
        state.cleanup && state.cleanup();
        window.__leviathanSeaShaderBoot = false;
        requestAnimationFrame(createSeaCanvas);
    };

    state.cleanup = () => {
        if (disposed) return;
        disposed = true;
        if (pendingSync) cancelAnimationFrame(pendingSync);
        if (resizeRaf) cancelAnimationFrame(resizeRaf);
        if (state.raf) cancelAnimationFrame(state.raf);
        document.removeEventListener('visibilitychange', sync);
        window.removeEventListener('resize', onResize);
        window.removeEventListener('orientationchange', onResize);
        canvas.removeEventListener('webglcontextlost', onContextLost);
        canvas.removeEventListener('webglcontextrestored', onContextRestored);
        try { classObserver && classObserver.disconnect(); } catch (_) {}
        try { gl.deleteBuffer(buffer); } catch (_) {}
        try { gl.deleteProgram(program); } catch (_) {}
        mount.classList.remove('is-ready', 'is-paused');
        window.__leviathanSea = null;
        window.__leviathanSeaShaderBoot = false;
    };

    state.sync = sync;
    window.__leviathanSea = state;
    window.__leviathanSeaSync = sync;
    window.__leviathanSeaCleanup = state.cleanup;

    document.addEventListener('visibilitychange', sync, { passive: true });
    window.addEventListener('resize', onResize, { passive: true });
    window.addEventListener('orientationchange', onResize, { passive: true });
    canvas.addEventListener('webglcontextlost', onContextLost, false);
    canvas.addEventListener('webglcontextrestored', onContextRestored, false);

    try {
        classObserver = new MutationObserver(sync);
        classObserver.observe(document.body, { attributes: true, attributeFilter: ['class'] });
    } catch (_) {}

    window.addEventListener('pagehide', state.cleanup, { once: true });
    resize();
    requestAnimationFrame(() => {
        mount.classList.add('is-ready');
        deactivateLeviathanSeaFallback();
    });
    sync();
}

function installLeviathanSeaBfcacheRestart() {
    if (window.__leviathanSeaBfcacheRestart) return;
    window.__leviathanSeaBfcacheRestart = true;
    window.addEventListener('pageshow', (event) => {
        if (!event || !event.persisted) return;
        if (window.__leviathanSea && typeof window.__leviathanSea.sync === 'function') {
            window.__leviathanSea.sync();
            return;
        }
        window.__leviathanSeaShaderBoot = false;
        requestAnimationFrame(createSeaCanvas);
    }, { passive: true });
}

function activateLeviathanSeaFallback() {
    if (!document.body) return;
    try {
        let layer = document.getElementById('m-sea-css');
        if (!layer) {
            layer = document.createElement('div');
            layer.id = 'm-sea-css';
            layer.setAttribute('aria-hidden', 'true');
            layer.innerHTML =
                '<div class="m-seacss-caustic"></div>' +
                '<div class="m-seacss-ray r2"></div>' +
                '<div class="m-seacss-ray r1"></div>' +
                '<div class="m-seacss-ray r3"></div>' +
                '<div class="m-seacss-layer m-seacss-swell3"></div>' +
                '<div class="m-seacss-layer m-seacss-swell2"></div>' +
                '<div class="m-seacss-layer m-seacss-swell1"></div>';
            document.body.insertBefore(layer, document.body.firstChild);
        }
        document.body.classList.add('m-sea-fallback');
    } catch (_) {}
}

function deactivateLeviathanSeaFallback() {
    try { document.body.classList.remove('m-sea-fallback'); } catch (_) {}
}

function createSeaCanvas() {
    installLeviathanSeaBfcacheRestart();

    const legacyCanvas = document.getElementById('m-sea-canvas');
    if (legacyCanvas) legacyCanvas.remove();

    if (window.__leviathanSeaShaderBoot) return;
    window.__leviathanSeaShaderBoot = true;

    if (leviathanSeaShouldSkip()) {
        window.__leviathanSeaShaderBoot = false;
        activateLeviathanSeaFallback();
        return;
    }

    let mount = document.getElementById('m-sea-webgl');
    if (!mount) {
        mount = document.createElement('div');
        mount.id = 'm-sea-webgl';
        mount.setAttribute('aria-hidden', 'true');
        document.body.insertBefore(mount, document.body.firstChild);
    }

    const boot = () => requestAnimationFrame(() => startLeviathanSeaShader(mount));
    if (typeof requestIdleCallback === 'function') {
        requestIdleCallback(boot, { timeout: 700 });
    } else {
        setTimeout(boot, 80);
    }
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
        const h = Math.max(72, Math.ceil(rect.height || dock.offsetHeight || 76));
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
            mSetPlaceholder('m-apiKey', "P2P attivo");
            mSetDisabled('m-apiKey', true);
            if(box) box.classList.add('is-p2p');
        } else {
            const placeholders = { 'rd': "Incolla RD key", 'tb': "Incolla TB key" };
            mSetPlaceholder('m-apiKey', placeholders[srv] || "Incolla API key");
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
    const enabled = ['m-enableVix', 'm-enableGhd', 'm-enableGs', 'm-enableVidxgo', 'm-enableEs', 'm-enableCb01', 'm-enableOnlineserietv', 'm-enableAnimeWorld', 'm-enableAnimeUnity', 'm-enableAnimeSaturn', 'm-enableToonItalia', 'm-enableGf', 'm-enableAltadefinizione', 'm-enableCc'].some(id => mChecked(id));
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
    mScQuality = '1080';
    const chk = mChecked('m-enableVix');

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
function setScQuality() {
    mScQuality = '1080';
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
            if(config.customNameTemplate) mSetValue('m-customNameTemplate', config.customNameTemplate);
            if(config.filters) {
                const mJoin = (v) => Array.isArray(v) ? v.join(', ') : (v || '');
                if(config.filters.streamExpression) mSetValue('m-streamExpression', config.filters.streamExpression);
                if(config.filters.preferredResolutions) mSetValue('m-preferredResolutions', mJoin(config.filters.preferredResolutions));
                if(config.filters.preferredLanguages) mSetValue('m-preferredLanguages', mJoin(config.filters.preferredLanguages));
                if(config.filters.preferredQualities || config.filters.preferredVisualTags) mSetValue('m-preferredQualities', mJoin(config.filters.preferredQualities || config.filters.preferredVisualTags));
                if(config.filters.preferredHdr) mSetValue('m-preferredHdr', mJoin(config.filters.preferredHdr));
            }

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

                mSetChecked('m-enableVidxgo', config.filters.enableVidxgo || false);
                toggleModuleStyle('m-enableVidxgo', 'mod-vidxgo');

                mSetChecked('m-enableEs', config.filters.enableEs || false);
                toggleModuleStyle('m-enableEs', 'mod-es');

                mSetChecked('m-enableCb01', config.filters.enableCb01 || false);
                toggleModuleStyle('m-enableCb01', 'mod-cb01');

                mSetChecked('m-enableOnlineserietv', config.filters.enableOnlineserietv || false);
                toggleModuleStyle('m-enableOnlineserietv', 'mod-onlineserietv');

                mSetChecked('m-enableAnimeWorld', config.filters.enableAnimeWorld || false);
                toggleModuleStyle('m-enableAnimeWorld', 'mod-aw');

                mSetChecked('m-enableAnimeUnity', config.filters.enableAnimeUnity || false);
                toggleModuleStyle('m-enableAnimeUnity', 'mod-au');

                mSetChecked('m-enableAnimeSaturn', config.filters.enableAnimeSaturn || false);
                toggleModuleStyle('m-enableAnimeSaturn', 'mod-as');

                mSetChecked('m-enableToonItalia', config.filters.enableToonItalia || false);
                toggleModuleStyle('m-enableToonItalia', 'mod-ti');

                mSetChecked('m-enableGf', config.filters.enableGf || false);
                toggleModuleStyle('m-enableGf', 'mod-gf');

                mSetChecked('m-enableAltadefinizione', config.filters.enableAltadefinizione || false);
                toggleModuleStyle('m-enableAltadefinizione', 'mod-ads');

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
                setScQuality('1080');

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
            updateStatus('m-enableVidxgo', 'st-vidxgo');
            updateStatus('m-enableEs', 'st-es');
            updateStatus('m-enableCb01', 'st-cb01');
            updateStatus('m-enableOnlineserietv', 'st-onlineserietv');
            updateStatus('m-enableAnimeWorld', 'st-aw');
            updateStatus('m-enableAnimeUnity', 'st-au');
            updateStatus('m-enableAnimeSaturn', 'st-as');
            updateStatus('m-enableToonItalia', 'st-ti');
            updateStatus('m-enableGf', 'st-gf');
            updateStatus('m-enableAltadefinizione', 'st-ads');
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
    const webModules = ['m-enableVix', 'm-enableGhd', 'm-enableGs', 'm-enableVidxgo', 'm-enableEs', 'm-enableCb01', 'm-enableOnlineserietv', 'm-enableAnimeWorld', 'm-enableAnimeUnity', 'm-enableAnimeSaturn', 'm-enableToonItalia', 'm-enableGf', 'm-enableAltadefinizione', 'm-enableCc'];
    const webOnlyService = !isP2P && !apiKey && webModules.some(id => mChecked(id));
    const savedCloudEnabled = !isP2P && !!apiKey && ['rd', 'tb'].includes(String(mCurrentService || '').toLowerCase()) && mChecked('m-enableSavedCloud');

    const mCsv = (id) => mValue(id).split(',').map((s) => s.trim()).filter(Boolean);
    const mAdvancedFilters = {};
    const mStreamExpression = mValue('m-streamExpression').trim();
    if (mStreamExpression) mAdvancedFilters.streamExpression = mStreamExpression;
    const mPreferredResolutions = mCsv('m-preferredResolutions');
    if (mPreferredResolutions.length) mAdvancedFilters.preferredResolutions = mPreferredResolutions;
    const mPreferredLanguages = mCsv('m-preferredLanguages');
    if (mPreferredLanguages.length) mAdvancedFilters.preferredLanguages = mPreferredLanguages;
    const mPreferredQualities = mCsv('m-preferredQualities');
    if (mPreferredQualities.length) mAdvancedFilters.preferredQualities = mPreferredQualities;
    const mPreferredHdr = mCsv('m-preferredHdr');
    if (mPreferredHdr.length) mAdvancedFilters.preferredHdr = mPreferredHdr;
    const mCustomNameTemplate = mValue('m-customNameTemplate').trim();

    return {
        service: isP2P ? '' : (webOnlyService ? 'web' : mCurrentService),
        key: apiKey,
        tmdb: mValue('m-tmdb').trim(),
        sort: mSortMode,
        formatter: mSkin,
        customTemplate: mValue('m-customTemplate'),
        ...(mCustomNameTemplate ? { customNameTemplate: mCustomNameTemplate } : {}),
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
            enableVidxgo: mChecked('m-enableVidxgo'),
            enableEs: mChecked('m-enableEs'),
            enableCb01: mChecked('m-enableCb01'),
            enableOnlineserietv: mChecked('m-enableOnlineserietv'),
            enableAnimeWorld: mChecked('m-enableAnimeWorld'),
            enableAnimeUnity: mChecked('m-enableAnimeUnity'),
            enableAnimeSaturn: mChecked('m-enableAnimeSaturn'),
            enableToonItalia: mChecked('m-enableToonItalia'),
            enableGf: mChecked('m-enableGf'),
            enableCc: mChecked('m-enableCc'),
            enableAltadefinizione: mChecked('m-enableAltadefinizione'),
            enableTrailers: false,
            enableSavedCloud: savedCloudEnabled,
            savedCloudMode: savedCloudEnabled ? mSavedCloudMode : 'off',
            savedCloudMax: 6,
            vixLast: mChecked('m-vixLast'),
            scQuality: '1080',
            maxPerQuality: gateActive ? gateVal : 0,
            maxSizeGB: finalMaxSizeGB > 0 ? finalMaxSizeGB : null,
            ...mAdvancedFilters
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

function setGeneratedLinkBoxesValue(value, tone = "primary") {
    ["m-generatedUrlBox", "m-setupGeneratedUrlBox"].forEach(id => {
        const box = document.getElementById(id);
        if (!box) return;
        if ("value" in box) box.value = value;
        box.style.color = tone === "error" ? "var(--m-error)" : "var(--m-primary)";
    });
}

async function updateLinkModalContent(immediate = false) {
    if (!immediate) {
        clearTimeout(_linkModalTimer);
        _linkModalTimer = setTimeout(() => updateLinkModalContent(true), 120);
        return;
    }

    const config = getMobileConfig();
    const isWebEnabled = config.filters.enableVix || config.filters.enableGhd || config.filters.enableGs || config.filters.enableVidxgo || config.filters.enableEs || config.filters.enableCb01 || config.filters.enableOnlineserietv || config.filters.enableAnimeWorld || config.filters.enableAnimeUnity || config.filters.enableAnimeSaturn || config.filters.enableToonItalia || config.filters.enableGf || config.filters.enableAltadefinizione || config.filters.enableCc || config.filters.enableP2P;

    if(!config.key && !isWebEnabled) {
        setGeneratedLinkBoxesValue("/// SYSTEM OFFLINE: WAITING FOR CONFIGURATION DATA ///\n[!] Inserisci API Key o Attiva Sorgenti Web/P2P", "error");
        return;
    }

    const manifestUrl = `${window.location.protocol}//${await getMobileManifestUrl(config)}`;
    setGeneratedLinkBoxesValue(manifestUrl, "primary");
}

async function copyGeneratedLinkValue(value, closeAfter = false) {
    const textToCopy = String(value || "");
    if (!textToCopy) return false;

    if (textToCopy.includes("WAITING FOR") || textToCopy.includes("SYSTEM OFFLINE")) {
        showToast("CONFIGURA PRIMA L'ADDON", "error");
        return false;
    }

    try {
        if (navigator.clipboard && navigator.clipboard.writeText) {
            await navigator.clipboard.writeText(textToCopy);
        } else {
            const dummy = document.createElement("textarea");
            document.body.appendChild(dummy);
            dummy.value = textToCopy;
            dummy.select();
            document.execCommand("copy");
            document.body.removeChild(dummy);
        }
        if (closeAfter) closeLinkModal();
        showToast("LINK COPIATO NEGLI APPUNTI", "success");
        return true;
    } catch (err) {
        showToast("ERRORE COPIA MANUALE", "error");
        return false;
    }
}

async function mobileInstall() {
    const config = getMobileConfig();
    const isWebEnabled = config.filters.enableVix || config.filters.enableGhd || config.filters.enableGs || config.filters.enableVidxgo || config.filters.enableEs || config.filters.enableCb01 || config.filters.enableOnlineserietv || config.filters.enableAnimeWorld || config.filters.enableAnimeUnity || config.filters.enableAnimeSaturn || config.filters.enableToonItalia || config.filters.enableGf || config.filters.enableAltadefinizione || config.filters.enableCc || config.filters.enableP2P;
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

async function copyFromSetupPanel() {
    updateLinkModalContent(true);
    const box = document.getElementById('m-setupGeneratedUrlBox');
    const textToCopy = box && "value" in box ? String(box.value || "") : "";
    await copyGeneratedLinkValue(textToCopy, false);
}

async function copyFromModal() {
    const box = document.getElementById('m-generatedUrlBox');
    const textToCopy = box && "value" in box ? String(box.value || "") : "";
    await copyGeneratedLinkValue(textToCopy, true);
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
        copyFromModal,
        copyFromSetupPanel
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

