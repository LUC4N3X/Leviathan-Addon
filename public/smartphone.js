const MOBILE_LOGO_URL = "https://i.ibb.co/YTKfXc1z/logo.png",
    MOBILE_LOGO_HINTS_ID = "leviathan-mobile-logo-hints",
    MOBILE_LOGO_PRELOAD_ID = "leviathan-mobile-logo-preload",
    MOBILE_PERF = {
        maxDpr: 1,
        targetFps: 24,
        lowFxFps: 14,
        keyboardDeltaPx: 110,
        inputIdleMs: 420,
        viewportRaf: 0,
        inputIdleTimer: null,
    };
function isMobileCoarsePointer() {
    try {
        return window.matchMedia && window.matchMedia("(pointer: coarse)").matches;
    } catch (n) {
        return !0;
    }
}
function ensureMobileLogoHints() {
    try {
        if (!document.head) return;
        if (!document.getElementById(MOBILE_LOGO_HINTS_ID)) {
            const n = document.createDocumentFragment(),
                e = document.createElement("link");
            ((e.id = MOBILE_LOGO_HINTS_ID),
                (e.rel = "preconnect"),
                (e.href = "https://i.ibb.co"),
                (e.crossOrigin = "anonymous"),
                n.appendChild(e));
            const t = document.createElement("link");
            ((t.rel = "dns-prefetch"),
                (t.href = "https://i.ibb.co"),
                n.appendChild(t),
                document.head.appendChild(n));
        }
        if (!document.getElementById(MOBILE_LOGO_PRELOAD_ID)) {
            const n = document.createElement("link");
            ((n.id = MOBILE_LOGO_PRELOAD_ID),
                (n.rel = "preload"),
                (n.as = "image"),
                (n.href = MOBILE_LOGO_URL),
                n.setAttribute("fetchpriority", "high"),
                document.head.appendChild(n));
        }
        if (
            !document.getElementById("leviathan-mobile-fonts") &&
            !Array.from(document.querySelectorAll('link[rel="stylesheet"]')).some((n) =>
                (n.href || "").includes("Plus+Jakarta+Sans"),
            )
        ) {
            const n = document.createElement("link");
            ((n.id = "leviathan-mobile-fonts"),
                (n.rel = "stylesheet"),
                (n.href =
                    "https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@500;600;700;800&family=Outfit:wght@300;400;500;600;700;800&family=Rajdhani:wght@500;600;700;800&family=JetBrains+Mono:wght@400;700&display=swap"),
                document.head.appendChild(n));
        }
    } catch (n) {}
}
function primeMobileLogo() {
    ensureMobileLogoHints();
    try {
        const n = new Image();
        ((n.decoding = "async"), (n.fetchPriority = "high"), (n.src = MOBILE_LOGO_URL));
    } catch (n) {}
}
function hydrateMobileLogo() {
    const n = document.querySelector(".logo-image");
    if (!n) return;
    const e = () => {
        (n.classList.add("is-loaded"), n.removeAttribute("data-loading"));
    };
    "complete" in n && n.complete
        ? e()
        : (n.setAttribute("data-loading", "1"),
          n.addEventListener("load", e, { once: !0 }),
          n.addEventListener("error", () => n.removeAttribute("data-loading"), { once: !0 }));
}
const MOBILE_BRAND_LOCK_TEXT = "LEVIATHAN";
function lockMobileBrandTitle() {
    try {
        const n =
            document.querySelector(".m-abyss-title") || document.querySelector(".m-brand-title");
        if (!n) return;
        ("LEVIATHAN" !== n.textContent && (n.textContent = "LEVIATHAN"),
            n.classList.add("notranslate"),
            n.setAttribute("translate", "no"),
            n.setAttribute("lang", "zxx"),
            n.setAttribute("aria-label", "LEVIATHAN"),
            n.setAttribute("data-brand-lock", "LEVIATHAN"),
            n.setAttribute("data-no-translate", "true"));
        const e = n.closest(".m-abyss-hero, .m-hero");
        if (
            (e &&
                (e.classList.add("notranslate"),
                e.setAttribute("translate", "no"),
                e.setAttribute("data-no-translate", "true")),
            window.__leviathanBrandLockObserver)
        )
            return;
        const t = new MutationObserver(() => {
            const n = document.querySelector("[data-brand-lock]");
            n && "LEVIATHAN" !== n.textContent && (n.textContent = "LEVIATHAN");
        });
        (t.observe(n, { childList: !0, characterData: !0, subtree: !0 }),
            (window.__leviathanBrandLockObserver = t));
    } catch (n) {}
}
function applyMobilePerformanceMode() {
    if (document.body)
        try {
            const n = navigator.hardwareConcurrency || 0,
                e = Number(navigator.deviceMemory || 0),
                t = Math.min(window.innerWidth || 390, screen.width || 390),
                a = !(
                    !window.matchMedia ||
                    !window.matchMedia("(prefers-reduced-motion: reduce)").matches
                ),
                i = isMobileCoarsePointer(),
                o = navigator.connection || navigator.mozConnection || navigator.webkitConnection,
                r = !!o?.saveData,
                s = /(^|-)2g$/i.test(String(o?.effectiveType || "")),
                l = Math.min(3, Math.max(1, Number(window.devicePixelRatio || 1))),
                m = a || r || s || (n && n <= 4) || (e && e <= 4) || t <= 380 || (l >= 2.5 && t <= 430),
                d = !m && ((n && n <= 6) || (e && e <= 6) || l >= 2);
            (document.body.classList.add("m-mf-lite", "m-mf-plus", "m-perf-ready"),
                document.body.classList.toggle("m-lowfx", !!m),
                document.body.classList.toggle("m-midfx", !!d),
                document.body.classList.toggle("m-highfx", !m && !d),
                document.body.classList.toggle("m-touch", !!i),
                document.documentElement.style.setProperty("--m-vvh", `${window.innerHeight}px`),
                document.documentElement.style.setProperty("--m-dpr", String(Math.min(l, 2))));
        } catch (n) {
            document.body.classList.add("m-mf-lite", "m-mf-plus", "m-lowfx");
        }
}
function isMobileTextField(n = document.activeElement) {
    return !!n?.matches?.(
        'input:not([type]), input[type="text"], input[type="password"], input[type="search"], input[type="email"], input[type="url"], input[type="tel"], input[type="number"], textarea, [contenteditable="true"]',
    );
}
function mById(n) {
    return document.getElementById(n);
}
function mAsElement(n) {
    return n && 1 === n.nodeType ? n : null;
}
function mClosest(n, e) {
    return mAsElement(n)?.closest?.(e) || null;
}
function mChecked(n, e = !1) {
    const t = mById(n);
    return !!(t && "checked" in t ? t.checked : e);
}
function mSetChecked(n, e) {
    const t = mById(n);
    return (t && "checked" in t && (t.checked = !!e), t);
}
function mValue(n, e = "") {
    const t = mById(n);
    return t && "value" in t ? String(t.value ?? "") : e;
}
function mSetValue(n, e) {
    const t = mById(n);
    return (t && "value" in t && (t.value = null == e ? "" : String(e)), t);
}
function mSetDisabled(n, e) {
    const t = mById(n);
    return (t && "disabled" in t && (t.disabled = !!e), t);
}
function mSetPlaceholder(n, e) {
    const t = mById(n);
    return (t && "placeholder" in t && (t.placeholder = null == e ? "" : String(e)), t);
}
function mSetText(n, e) {
    const t = mById(n);
    return (t && (t.innerText = null == e ? "" : String(e)), t);
}
function mHasClass(n, e) {
    return !!mById(n)?.classList?.contains(e);
}
function mAddClass(n, e) {
    const t = mById(n);
    return (t && t.classList.add(e), t);
}
function mToggleClass(n, e, t) {
    const a = mById(n);
    return (a && a.classList.toggle(e, !!t), a);
}
function mSetStyle(n, e, t) {
    n?.style && (n.style[e] = String(t));
}
function mVibrate(n) {
    try {
        navigator && "function" == typeof navigator.vibrate && navigator.vibrate(n);
    } catch (n) {}
}
const mobileCSS = `
:root {
    --bg-dark: #020713;
    --bg-deep: #00030a;
    --text-main: #f0f7ff;
    --text-dim: #9fb4d7;
    --text-faint: rgba(159, 180, 215, 0.4);

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

    --primary: var(--neon-cyan);
    --primary-glow: var(--neon-cyan-glow);
    --secondary: var(--neon-violet);
    --secondary-glow: var(--neon-violet-glow);

    --glass-card: rgba(10, 20, 38, 0.6);
    --glass-card-hover: rgba(15, 28, 54, 0.7);
    --glass-card-active: rgba(16, 32, 62, 0.85);
    --glass-border: rgba(255, 255, 255, 0.08);
    --glass-border-glow: rgba(34, 211, 238, 0.2);
    --glass-blur: blur(20px);

    --radius-lg: 20px;
    --radius-md: 14px;
    --radius-sm: 10px;

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
    transition: background 0.28s ease, color 0.28s ease, border-color 0.28s ease !important;
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
    padding: 12px 6px 0px 6px;
    display: flex;
    flex-direction: column;
    align-items: center;
    width: 100%;
    position: relative;
}

.m-hero-panel {
    width: 100%;
    max-width: 400px;
    padding: 15px 4px 0px 4px;
    position: relative;
    background: transparent;
    transform: translate3d(0, -14px, 0);
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
    --badge-accent: var(--neon-cyan);
    --badge-glow: rgba(34, 211, 238, 0.22);
    display: inline-flex;
    align-items: center;
    gap: 5px;
    font-family: 'Rajdhani', sans-serif;
    font-weight: 800;
    font-size: 0.65rem;
    letter-spacing: 1.15px;
    text-transform: uppercase;
    color: #ecfbff;
    padding: 4px 12px;
    border-radius: 999px;
    border: 1px solid color-mix(in srgb, var(--badge-accent) 34%, transparent);
    background: linear-gradient(180deg, rgba(14, 28, 52, 0.72), rgba(5, 12, 25, 0.64));
    box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.08),
                0 0 12px -6px var(--badge-glow);
    position: relative;
    overflow: hidden;
}
.m-hero-badge::before {
    content: '';
    position: absolute;
    inset: 0;
    border-radius: inherit;
    background: radial-gradient(circle at 50% 0%, var(--badge-glow), transparent 62%);
    opacity: 0.78;
    pointer-events: none;
}
.m-hero-badge:nth-child(2) {
    --badge-accent: #60a5fa;
    --badge-glow: rgba(96, 165, 250, 0.22);
}
.m-hero-badge:nth-child(3) {
    --badge-accent: var(--neon-violet);
    --badge-glow: rgba(155, 108, 255, 0.24);
}

.m-version-tag {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    margin-top: 11px;
    font-family: 'Rajdhani', monospace;
    font-size: 0.6rem;
    font-weight: 800;
    color: #fff;
    letter-spacing: 1.6px;
    padding: 4px 12px;
    border-radius: 20px;
    border: 1px solid rgba(34, 211, 238, 0.26);
    background: linear-gradient(180deg, rgba(34, 211, 238, 0.1), rgba(4, 12, 24, 0.58));
    box-shadow: 0 0 14px rgba(34, 211, 238, 0.1), inset 0 1px 0 rgba(255, 255, 255, 0.08);
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
    gap: 10px !important;
    margin-bottom: 16px !important;
}
.m-cred-opt {
    background: radial-gradient(circle at 50% -24%, var(--opt-glow-soft, rgba(34, 211, 238, 0.12)), transparent 54%),
                linear-gradient(180deg, rgba(16, 31, 56, 0.76) 0%, rgba(6, 12, 26, 0.92) 100%) !important;
    border: 1px solid rgba(255, 255, 255, 0.075) !important;
    border-radius: 18px !important;
    padding: 13px 5px 11px !important;
    min-height: 124px !important;
    text-align: center !important;
    display: flex !important;
    flex-direction: column !important;
    align-items: center !important;
    justify-content: center !important;
    gap: 6px !important;
    cursor: pointer !important;
    position: relative !important;
    overflow: hidden !important;
    isolation: isolate !important;
    contain: layout paint style !important;
    transition: border-color 0.26s ease,
                background 0.26s ease,
                box-shadow 0.26s ease,
                transform 0.22s cubic-bezier(0.2, 0.8, 0.2, 1) !important;
    box-shadow: 0 10px 22px -12px rgba(0, 0, 0, 0.72),
                inset 0 1px 0 rgba(255, 255, 255, 0.055) !important;
}
.m-cred-opt::before {
    content: '' !important;
    position: absolute !important;
    top: 0 !important;
    left: 11px !important;
    right: 11px !important;
    height: 3px !important;
    border-radius: 0 0 999px 999px !important;
    background: linear-gradient(90deg, transparent, var(--opt-color), rgba(255, 255, 255, 0.7), var(--opt-color), transparent) !important;
    opacity: 0.5 !important;
    box-shadow: 0 0 12px var(--opt-glow) !important;
    z-index: 0 !important;
    pointer-events: none !important;
}
.m-cred-opt::after {
    content: '' !important;
    position: absolute !important;
    inset: 1px !important;
    border-radius: 17px !important;
    background: linear-gradient(135deg, rgba(255,255,255,0.08), transparent 36%, rgba(255,255,255,0.025) 72%, transparent) !important;
    opacity: 0.7 !important;
    pointer-events: none !important;
    z-index: 0 !important;
}
.m-cred-icon {
    width: 54px !important;
    height: 54px !important;
    display: grid !important;
    place-items: center !important;
    border-radius: 18px !important;
    font-size: 1.72rem !important;
    background: radial-gradient(circle at 45% 30%, rgba(255,255,255,0.18), transparent 38%),
                linear-gradient(145deg, rgba(255,255,255,0.08), rgba(0,0,0,0.2)) !important;
    border: 1px solid color-mix(in srgb, var(--opt-color) 34%, transparent) !important;
    box-shadow: 0 8px 18px -12px var(--opt-glow),
                inset 0 1px 0 rgba(255, 255, 255, 0.12) !important;
    filter: drop-shadow(0 4px 7px rgba(0, 0, 0, 0.36)) !important;
    transition: transform 0.24s cubic-bezier(0.2, 0.8, 0.2, 1),
                box-shadow 0.24s ease,
                border-color 0.24s ease !important;
    position: relative !important;
    z-index: 1 !important;
}
.m-cred-name {
    font-family: 'Rajdhani', sans-serif !important;
    font-weight: 900 !important;
    font-size: 0.73rem !important;
    letter-spacing: 1.35px !important;
    line-height: 1.05 !important;
    color: rgba(238, 248, 255, 0.86) !important;
    transition: color 0.24s ease, text-shadow 0.24s ease !important;
    position: relative !important;
    z-index: 1 !important;
}
.m-cred-sub {
    font-family: 'JetBrains Mono', monospace !important;
    font-weight: 700 !important;
    font-size: 0.48rem !important;
    letter-spacing: 1.05px !important;
    color: color-mix(in srgb, var(--opt-color) 78%, #ffffff 8%) !important;
    opacity: 0.75 !important;
    text-transform: uppercase !important;
    line-height: 1 !important;
    position: relative !important;
    z-index: 1 !important;
}

.m-cred-opt.active {
    background: radial-gradient(circle at 50% -18%, var(--opt-glow-soft, rgba(34, 211, 238, 0.18)), transparent 52%),
                radial-gradient(circle at 50% 112%, rgba(255,255,255,0.055), transparent 50%),
                linear-gradient(180deg, rgba(18, 38, 70, 0.86) 0%, rgba(5, 12, 28, 0.95) 100%) !important;
    border-color: color-mix(in srgb, var(--opt-color) 72%, transparent) !important;
    transform: translate3d(0, -3px, 0) !important;
    box-shadow: 0 14px 28px -14px rgba(0, 0, 0, 0.78),
                0 0 20px -8px var(--opt-glow),
                inset 0 1px 0 rgba(255, 255, 255, 0.09) !important;
}
.m-cred-opt.active::before {
    opacity: 1 !important;
    height: 4px !important;
}
.m-cred-opt.active .m-cred-icon {
    transform: translate3d(0, -2px, 0) scale(1.08) !important;
    border-color: color-mix(in srgb, var(--opt-color) 74%, transparent) !important;
    box-shadow: 0 12px 22px -10px var(--opt-glow),
                0 0 15px -6px var(--opt-glow),
                inset 0 1px 0 rgba(255, 255, 255, 0.18) !important;
}
.m-cred-opt.active .m-cred-name {
    color: #fff !important;
    text-shadow: 0 0 10px var(--opt-glow) !important;
}
.m-cred-opt.active .m-cred-sub {
    opacity: 1 !important;
}
.m-cred-opt:active {
    transform: scale(0.965) !important;
}

.cred-rd { --opt-color: var(--neon-cyan); --opt-glow: rgba(34, 211, 238, 0.5); --opt-glow-soft: rgba(34, 211, 238, 0.16); }
.cred-tb { --opt-color: #60a5fa; --opt-glow: rgba(96, 165, 250, 0.5); --opt-glow-soft: rgba(96, 165, 250, 0.15); }
.cred-p2p { --opt-color: var(--neon-violet); --opt-glow: rgba(155, 108, 255, 0.52); --opt-glow-soft: rgba(155, 108, 255, 0.16); }

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
    transition: background-color .3s cubic-bezier(0.22, 1, 0.36, 1), border-color .3s, box-shadow .3s;
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
    transition: background-color .3s cubic-bezier(0.22, 1, 0.36, 1), border-color .3s, box-shadow .3s;
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

#mod-vix .m-core-icon { color: var(--neon-violet); }
#mod-ghd .m-core-icon { color: var(--neon-cyan); }
#mod-gs .m-core-icon { color: var(--neon-violet); }
#mod-aw .m-core-icon { color: #0ea5e9; }
#mod-as .m-core-icon { color: var(--neon-cyan); }
#mod-gf .m-core-icon { color: #00e676; }
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
    from { opacity: 0; transform: translate3d(0, -14px, 0); }
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
 transform: translateZ(0); }
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
 transform: translateZ(0); will-change: transform; }
.m-input-tech::placeholder {
    color: var(--text-faint) !important;
}


.m-credits-section {
    margin-top: 24px;
    padding-bottom: env(safe-area-inset-bottom, 12px);
}
.m-neural-frame {
    background: linear-gradient(145deg, rgba(7, 16, 32, 0.46) 0%, rgba(3, 8, 18, 0.62) 100%) !important;
    border: 1px solid rgba(34, 211, 238, 0.10) !important;
    border-radius: 17px !important;
    padding: 11px 12px 12px 12px !important;
    display: flex !important;
    flex-direction: column !important;
    gap: 9px !important;
    position: relative !important;
    overflow: hidden !important;
    box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.045), 0 10px 26px -19px rgba(0, 0, 0, 0.78), 0 0 18px -16px rgba(34, 211, 238, 0.7) !important;
    contain: layout paint style;
}
.m-neural-frame::before {
    content: "" !important;
    position: absolute !important;
    inset: 0 !important;
    background: radial-gradient(circle at 13% 0%, rgba(34, 211, 238, 0.16), transparent 36%), radial-gradient(circle at 92% 26%, rgba(155, 108, 255, 0.13), transparent 34%), linear-gradient(115deg, transparent 0%, rgba(255, 255, 255, 0.025) 45%, transparent 68%) !important;
    opacity: 0.82 !important;
    pointer-events: none !important;
}
.m-neural-frame::after {
    content: "" !important;
    position: absolute !important;
    left: 13px !important;
    right: 13px !important;
    top: 0 !important;
    height: 1px !important;
    background: linear-gradient(90deg, transparent, rgba(34, 211, 238, 0.55), rgba(155, 108, 255, 0.42), transparent) !important;
    opacity: 0.75 !important;
    pointer-events: none !important;
}
.m-neural-header {
    display: flex !important;
    justify-content: space-between !important;
    align-items: center !important;
    font-family: 'Rajdhani', monospace !important;
    font-size: 0.56rem !important;
    font-weight: 900 !important;
    color: rgba(226, 248, 255, 0.48) !important;
    border-bottom: 1px solid rgba(255, 255, 255, 0.035) !important;
    padding-bottom: 6px !important;
    position: relative !important;
    z-index: 2 !important;
    letter-spacing: 1px !important;
}
.m-neural-grid {
    display: grid !important;
    grid-template-columns: 1fr !important;
    gap: 8px !important;
    position: relative !important;
    z-index: 2 !important;
}
.m-dev-module {
    min-height: 66px !important;
    background: radial-gradient(circle at 0 0, rgba(34, 211, 238, 0.13), transparent 42%), radial-gradient(circle at 100% 100%, rgba(155, 108, 255, 0.11), transparent 45%), linear-gradient(135deg, rgba(10, 20, 38, 0.78) 0%, rgba(6, 11, 24, 0.88) 100%) !important;
    border: 1px solid rgba(34, 211, 238, 0.17) !important;
    border-radius: 15px !important;
    padding: 9px 56px 9px 12px !important;
    display: flex !important;
    align-items: center !important;
    gap: 12px !important;
    text-decoration: none !important;
    position: relative !important;
    overflow: hidden !important;
    box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.065), 0 8px 22px -17px rgba(34, 211, 238, 0.78) !important;
    transform: translateZ(0) !important;
}
.m-dev-module::before {
    content: "" !important;
    position: absolute !important;
    left: 0 !important;
    top: 9px !important;
    bottom: 9px !important;
    width: 3px !important;
    border-radius: 999px !important;
    background: linear-gradient(180deg, #22d3ee, #8b5cf6, #34e6ad) !important;
    box-shadow: 0 0 14px rgba(34, 211, 238, 0.70) !important;
}
.m-dev-module::after {
    content: "" !important;
    position: absolute !important;
    inset: 0 !important;
    background: linear-gradient(110deg, transparent 0%, rgba(34, 211, 238, 0.06) 42%, rgba(155, 108, 255, 0.065) 62%, transparent 100%) !important;
    opacity: 0.78 !important;
    pointer-events: none !important;
}
.m-dev-img {
    width: 46px !important;
    height: 46px !important;
    border-radius: 14px !important;
    clip-path: polygon(50% 0%, 91% 24%, 91% 76%, 50% 100%, 9% 76%, 9% 24%) !important;
    border: 1px solid rgba(34, 211, 238, 0.42) !important;
    object-fit: cover !important;
    position: relative !important;
    z-index: 2 !important;
    background: #020713 !important;
    box-shadow: 0 0 0 3px rgba(34, 211, 238, 0.055), 0 0 15px rgba(34, 211, 238, 0.20), 0 0 20px -8px rgba(155, 108, 255, 0.48) !important;
}
.m-dev-data {
    display: flex !important;
    flex-direction: column !important;
    min-width: 0 !important;
    position: relative !important;
    z-index: 2 !important;
}
.m-dev-role {
    font-family: 'Rajdhani', sans-serif !important;
    font-weight: 900 !important;
    font-size: 0.54rem !important;
    letter-spacing: 1.55px !important;
    color: var(--neon-cyan) !important;
    text-transform: uppercase !important;
    line-height: 1.05 !important;
}
.m-dev-nick {
    font-family: 'Outfit', sans-serif !important;
    font-weight: 900 !important;
    font-size: 0.92rem !important;
    color: #fff !important;
    line-height: 1.12 !important;
    letter-spacing: 0.35px !important;
    text-shadow: 0 0 10px rgba(34, 211, 238, 0.20) !important;
}
.m-dev-meta {
    margin-top: 2px !important;
    font-family: 'Rajdhani', sans-serif !important;
    font-size: 0.54rem !important;
    font-weight: 900 !important;
    letter-spacing: 1.05px !important;
    color: rgba(159, 180, 215, 0.74) !important;
    text-transform: uppercase !important;
    white-space: nowrap !important;
    overflow: hidden !important;
    text-overflow: ellipsis !important;
}
.m-dev-orbit {
    position: absolute !important;
    right: 11px !important;
    top: 50% !important;
    width: 35px !important;
    height: 35px !important;
    transform: translateY(-50%) !important;
    border-radius: 12px !important;
    display: grid !important;
    place-items: center !important;
    background: linear-gradient(145deg, rgba(34, 211, 238, 0.095), rgba(155, 108, 255, 0.075)) !important;
    border: 1px solid rgba(34, 211, 238, 0.13) !important;
    box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.055), 0 0 14px -10px rgba(34, 211, 238, 0.8) !important;
    z-index: 2 !important;
}
.m-dev-github {
    color: rgba(226, 248, 255, 0.62) !important;
    font-size: 1.18rem !important;
    line-height: 1 !important;
}
.m-neural-footer {
    text-align: center !important;
    font-family: 'Rajdhani', monospace !important;
    font-size: 0.52rem !important;
    font-weight: 900 !important;
    color: rgba(159, 180, 215, 0.42) !important;
    letter-spacing: 1.35px !important;
    position: relative !important;
    z-index: 2 !important;
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

.m-reactor-module {
    isolation: isolate !important;
    contain: layout paint style !important;
    content-visibility: auto !important;
    contain-intrinsic-size: 88px !important;
    transform: translateZ(0) !important;
    backface-visibility: hidden !important;
    -webkit-backface-visibility: hidden !important;
}

.m-reactor-module::after {
    content: "" !important;
    position: absolute !important;
    left: 0 !important;
    top: 3px !important;
    bottom: 0 !important;
    width: 5px !important;
    background: linear-gradient(180deg, var(--border-color, var(--neon-cyan)), rgba(255,255,255,0.18), var(--border-color, var(--neon-cyan))) !important;
    box-shadow: 0 0 14px var(--glow-color, rgba(34, 211, 238, 0.45)) !important;
    opacity: 0.52 !important;
    pointer-events: none !important;
    z-index: 4 !important;
}

.m-reactor-module.active::after {
    opacity: 0.92 !important;
    width: 6px !important;
    box-shadow: 0 0 18px var(--glow-color, rgba(34, 211, 238, 0.65)) !important;
}

.m-reactor-module.active {
    background: radial-gradient(circle at 0 0, var(--glow-color-dim, rgba(34, 211, 238, 0.1)), transparent 42%),
                radial-gradient(circle at 100% 20%, rgba(255,255,255,0.035), transparent 38%),
                linear-gradient(150deg, rgba(14, 26, 48, 0.72) 0%, rgba(6, 11, 23, 0.88) 100%) !important;
}

.m-reactor-module.active .m-reactor-title {
    text-shadow: 0 0 10px var(--glow-color-dim, rgba(34, 211, 238, 0.18)), 0 1px 3px rgba(0, 0, 0, 0.5) !important;
}

.m-reactor-module:active,
.m-cred-opt:active,
.m-flux-opt:active,
.m-lang-opt:active,
.m-cortex-chip:active,
.m-act-btn:active,
.m-nav-item:not(.active):active {
    transition-duration: 0.12s !important;
}

.m-content {
    scroll-behavior: auto !important;
    contain: layout paint style !important;
}

.m-hypervisor,
.m-visual-core-v2,
.m-row,
.m-field-group,
.m-ghost-panel,
.m-flux-readout,
.m-cloud-mode-panel {
    contain: layout paint style !important;
}

body.m-scrolling .m-caustic-ray,
body.m-scrolling .logo-particle,
body.m-scrolling .m-seacss-ray,
body.m-scrolling .m-seacss-layer,
body.m-typing .m-caustic-ray,
body.m-typing .logo-particle,
body.m-keyboard-open .m-caustic-ray,
body.m-keyboard-open .logo-particle,
body.m-page-hidden *,
body.m-switching .m-page.active {
    animation-play-state: paused !important;
}

body.m-lowfx {
    --glass-blur: blur(12px);
}

body.m-lowfx .m-hypervisor,
body.m-lowfx .m-visual-core-v2,
body.m-lowfx .m-dock-container {
    backdrop-filter: blur(12px) saturate(128%) !important;
    -webkit-backdrop-filter: blur(12px) saturate(128%) !important;
    box-shadow: 0 8px 22px -8px rgba(0, 0, 0, 0.62), inset 0 1px 0 rgba(255, 255, 255, 0.055) !important;
}

body.m-lowfx .m-caustic-ray:nth-child(n+4),
body.m-lowfx .logo-particle:nth-child(n+3),
body.m-lowfx .m-seacss-ray.r3 {
    display: none !important;
}

body.m-lowfx .m-seacss-caustic,
body.m-lowfx .m-seacss-ray,
body.m-lowfx .m-seacss-layer,
body.m-midfx .m-seacss-layer {
    animation-duration: 28s !important;
}

body.m-lowfx .m-reactor-module,
body.m-lowfx .m-cred-opt,
body.m-lowfx .m-flux-opt,
body.m-lowfx .m-lang-opt {
    box-shadow: 0 5px 14px rgba(0, 0, 0, 0.42), inset 0 1px 0 rgba(255, 255, 255, 0.035) !important;
}

body.m-lowfx .m-reactor-module.active,
body.m-lowfx .m-cred-opt.active {
    transform: translateZ(0) !important;
}

@media (hover: none) and (pointer: coarse) {
    .m-reactor-module,
    .m-cred-opt,
    .m-flux-opt,
    .m-lang-opt,
    .m-cortex-chip,
    .m-row,
    .m-hypervisor,
    .m-visual-core-v2,
    .m-dock-container {
        transform: translateZ(0);
        backface-visibility: hidden;
        -webkit-backface-visibility: hidden;
    }
}

@media (prefers-reduced-motion: reduce) {
    .m-caustic-ray,
    .m-ocean-particle,
    .logo-particle,
    .m-seacss-caustic,
    .m-seacss-ray,
    .m-seacss-layer,
    .logo-container,
    .logo-image,
    .m-abyss-crown,
    .m-v-dot {
        animation: none !important;
    }
}

/* =====================================================================
   MEDIAFUSION-INSPIRED POLISH LAYER
   Keeps the Leviathan abyss identity (cyan + violet) but borrows
   MediaFusion's cleaner card layout: consistent radii, calmer surfaces,
   hairline borders, section accent bars and cohesive gradient accents.
   This block loads last so it refines the components above without
   touching the existing HTML/JS or animations.
   ===================================================================== */
:root {
    --mf-grad: linear-gradient(135deg, var(--neon-cyan) 0%, var(--neon-violet) 100%);
    --mf-hairline: rgba(148, 184, 230, 0.12);
    --mf-hairline-soft: rgba(148, 184, 230, 0.09);
    --mf-radius: 18px;
}

/* --- Cards / panels: softer surface + crisp hairline ----------------- */
.m-hypervisor,
.m-visual-core-v2 {
    border-radius: var(--mf-radius) !important;
    border: 1px solid var(--mf-hairline) !important;
    background:
        linear-gradient(180deg, rgba(255, 255, 255, 0.022), transparent 30%),
        var(--glass-card) !important;
    box-shadow:
        0 1px 0 rgba(255, 255, 255, 0.045) inset,
        0 14px 34px -16px rgba(0, 0, 0, 0.7) !important;
}
.m-hypervisor:focus-within,
.m-visual-core-v2:focus-within {
    border-color: rgba(34, 211, 238, 0.28) !important;
}

/* --- Section header: left accent bar + icon chip (MediaFusion style) -- */
.m-hyp-header {
    gap: 10px !important;
    padding-bottom: 10px !important;
    margin-bottom: 12px !important;
    border-bottom: 1px solid var(--mf-hairline-soft) !important;
}
.m-hyp-header > span:first-child {
    position: relative !important;
    padding-left: 13px !important;
}
.m-hyp-header > span:first-child::before {
    content: '' !important;
    position: absolute !important;
    left: 0 !important;
    top: 50% !important;
    transform: translateY(-50%) !important;
    width: 4px !important;
    height: 15px !important;
    border-radius: 999px !important;
    background: var(--mf-grad) !important;
    box-shadow: 0 0 10px rgba(34, 211, 238, 0.4) !important;
}
.m-hyp-icon {
    width: 26px !important;
    height: 26px !important;
    display: grid !important;
    place-items: center !important;
    border-radius: 9px !important;
    background: rgba(34, 211, 238, 0.08) !important;
    border: 1px solid rgba(34, 211, 238, 0.18) !important;
}
.m-panel-desc {
    opacity: 0.92 !important;
}

/* --- Primary INSTALL button: cohesive cyan -> violet gradient -------- */
.m-setup-install {
    background: var(--mf-grad) !important;
    border-radius: 16px !important;
    box-shadow:
        0 1px 0 rgba(255, 255, 255, 0.25) inset,
        0 12px 26px -10px rgba(34, 211, 238, 0.45),
        0 12px 26px -14px rgba(155, 108, 255, 0.45) !important;
}

/* --- Consistent rounding & hairlines across interactive surfaces ----- */
.m-cred-opt {
    border-radius: 16px !important;
}
.m-reactor-module {
    border-radius: 16px !important;
    border: 1px solid var(--mf-hairline) !important;
}
.m-flux-opt,
.m-lang-opt {
    border-radius: 12px !important;
    border: 1px solid var(--mf-hairline) !important;
}
.m-qual-chip {
    border-radius: 11px !important;
}
.m-if-inner,
.m-input-box {
    border-radius: 13px !important;
}
.m-setup-mini-console,
.m-setup-actions-panel {
    border-radius: 16px !important;
}

/* --- Hero badges: clean pills --------------------------------------- */
.m-hero-badge {
    border-radius: 999px !important;
}
/* ============== END MEDIAFUSION-INSPIRED POLISH LAYER ================ */

/* =====================================================================
   FLUIDITY + MEDIAFUSION POLISH v2
   Goal: make the mobile UI feel noticeably smoother (instant taps, GPU
   compositing, momentum scroll, springy feedback) and push the
   MediaFusion-inspired look further (focus rings, calmer motion,
   cohesive radii, refined inputs/toggles). Additive only: this block
   loads last and never clips the existing outer glows/shadows.
   ===================================================================== */

/* --- Kill tap delay + grey flash everywhere = instant, native feel --- */
* {
    -webkit-tap-highlight-color: transparent !important;
}
.m-nav-item, .m-cred-opt, .m-reactor-module, .m-cortex-chip, .m-qual-chip,
.m-flux-opt, .m-lang-opt, .m-cloud-mode-btn, .m-switch, .m-setup-action,
.m-setup-mini-copy, .m-act-btn, .m-if-action, .m-paste-action, .m-get-link,
.m-srv-btn, button, [onclick] {
    touch-action: manipulation !important;
    -webkit-user-select: none !important;
    user-select: none !important;
}

/* --- Smoother momentum scrolling + clears the floating top dock ------ */
.m-content {
    -webkit-overflow-scrolling: touch !important;
    overscroll-behavior-y: contain !important;
    scroll-padding-top: 64px !important;
}
/* Slim, subtle scrollbar on the rare occasion it shows */
.m-content::-webkit-scrollbar { width: 0px !important; }
.m-custom-tpl-input::-webkit-scrollbar,
.m-flux-input::-webkit-scrollbar { width: 4px !important; }
.m-custom-tpl-input::-webkit-scrollbar-thumb,
.m-flux-input::-webkit-scrollbar-thumb {
    background: rgba(34, 211, 238, 0.25) !important;
    border-radius: 999px !important;
}

/* --- Unified springy press feedback (the core "fluid" tactile cue) --- */
.m-cred-opt, .m-reactor-module, .m-cortex-chip, .m-qual-chip, .m-flux-opt,
.m-lang-opt, .m-cloud-mode-btn, .m-nav-item, .m-setup-mini-copy,
.m-if-action, .m-paste-action, .m-get-link {
    transition: transform 0.16s cubic-bezier(0.22, 1, 0.36, 1),
                background 0.22s ease, border-color 0.22s ease,
                box-shadow 0.22s ease, color 0.22s ease !important;
    will-change: transform !important;
}
.m-cred-opt:active, .m-reactor-module:active, .m-cortex-chip:active,
.m-qual-chip:active, .m-flux-opt:active, .m-lang-opt:active,
.m-cloud-mode-btn:active, .m-if-action:active, .m-paste-action:active,
.m-get-link:active, .m-setup-mini-copy:active {
    transform: scale(0.965) !important;
}
.m-setup-install:active { transform: scale(0.98) translateZ(0) !important; }

/* --- MediaFusion-style focus rings on every input ------------------- */
.m-if-field:focus, .m-input-tech:focus, .m-custom-tpl-input:focus,
.m-setup-mini-url:focus, .m-flux-input:focus {
    outline: none !important;
    border-color: rgba(34, 211, 238, 0.5) !important;
    box-shadow: 0 0 0 3px rgba(34, 211, 238, 0.16),
                inset 0 1px 3px rgba(0, 0, 0, 0.4) !important;
}
.m-if-inner:focus-within, .m-input-box:focus-within {
    border-color: rgba(34, 211, 238, 0.4) !important;
    box-shadow: 0 0 0 3px rgba(34, 211, 238, 0.12) !important;
}

/* --- Calmer, more cohesive page transition (MediaFusion-like motion) - */
.m-page.active {
    animation: mPageFadeV2 0.32s cubic-bezier(0.22, 1, 0.36, 1) both !important;
    will-change: transform, opacity;
}
@keyframes mPageFadeV2 {
    from { opacity: 0; transform: translate3d(0, 8px, 0); }
    to   { opacity: 1; transform: translate3d(0, 0, 0); }
}

/* --- Toggles & active cards animate smoothly ------------------------- */
.m-slider, .m-slider::before {
    transition: background 0.25s ease, transform 0.25s cubic-bezier(0.22, 1, 0.36, 1),
                box-shadow 0.25s ease, border-color 0.25s ease !important;
}
.m-reactor-module {
    transition: transform 0.16s cubic-bezier(0.22, 1, 0.36, 1),
                border-color 0.25s ease, background 0.25s ease,
                box-shadow 0.25s ease !important;
}

/* --- Skins grid: tighter, more MediaFusion (chip rows that breathe) -- */
.m-cortex-grid { gap: 7px !important; }
.m-cortex-chip {
    padding: 6px 11px !important;
    border-radius: 10px !important;
}
.m-cortex-chip.active {
    background: var(--mf-grad) !important;
    border-color: transparent !important;
    color: #001217 !important;
    box-shadow: 0 6px 16px -8px rgba(34, 211, 238, 0.6) !important;
}
#m-preview-box { border-radius: 16px !important; }

/* --- Respect users who prefer less motion --------------------------- */
@media (prefers-reduced-motion: reduce) {
    .m-page.active { animation-duration: 0.01ms !important; }
    .m-cred-opt, .m-reactor-module, .m-cortex-chip, .m-qual-chip,
    .m-flux-opt, .m-lang-opt, .m-nav-item { transition: none !important; }
}
/* ============== END FLUIDITY + MEDIAFUSION POLISH v2 ================ */
`,
    mobileHTML = `\n<div id="m-sea-webgl" aria-hidden="true"></div>\n<div class="m-caustic" aria-hidden="true">\n    <div class="m-caustic-ray" style="--ray-x:8%;--ray-dur:14s;--ray-op:0.55;--ray-from:-12deg;--ray-to:6deg;width:50px;"></div>\n    <div class="m-caustic-ray" style="--ray-x:28%;--ray-dur:11s;--ray-op:0.40;--ray-from:-6deg;--ray-to:14deg;width:35px;"></div>\n    <div class="m-caustic-ray" style="--ray-x:50%;--ray-dur:16s;--ray-op:0.65;--ray-from:-10deg;--ray-to:8deg;width:65px;"></div>\n    <div class="m-caustic-ray" style="--ray-x:68%;--ray-dur:9s;--ray-op:0.35;--ray-from:5deg;--ray-to:-12deg;width:40px;"></div>\n    <div class="m-caustic-ray" style="--ray-x:85%;--ray-dur:13s;--ray-op:0.50;--ray-from:8deg;--ray-to:-6deg;width:55px;"></div>\n</div>\n<div class="m-ocean-particles" id="m-ocean-particles" aria-hidden="true"></div>\n<div id="app-container">\n    <div class="m-ptr" id="m-ptr-indicator"><i class="fas fa-arrow-down m-ptr-icon"></i></div>\n    <div class="m-content-wrapper">\n\n        <div class="m-content">\n            <div class="m-hero m-abyss-hero notranslate" aria-label="LEVIATHAN Kit" translate="no" data-no-translate="true">\n                <div class="m-hero-panel">\n                    <div class="logo-container m-abyss-logo">\n                        <span class="m-abyss-crown" aria-hidden="true"></span>\n                        <span class="m-cyber-corner cc-tl" aria-hidden="true"></span>\n                        <span class="m-cyber-corner cc-tr" aria-hidden="true"></span>\n                        <span class="m-cyber-corner cc-bl" aria-hidden="true"></span>\n                        <span class="m-cyber-corner cc-br" aria-hidden="true"></span>\n                        <img src="${MOBILE_LOGO_URL}" alt="LEVIATHAN Logo" class="logo-image notranslate" translate="no" data-no-translate="true" fetchpriority="high" decoding="sync" loading="eager" width="110" height="110">\n                        <div class="logo-particles" aria-hidden="true">\n                            <span class="logo-particle" style="left:18%; width:5px; height:5px; animation-delay:0s;"></span>\n                            <span class="logo-particle" style="left:38%; width:3px; height:3px; animation-delay:2.4s;"></span>\n                            <span class="logo-particle" style="left:63%; width:4px; height:4px; animation-delay:4.1s;"></span>\n                            <span class="logo-particle" style="left:78%; width:3px; height:3px; animation-delay:6.2s;"></span>\n                        </div>\n                    </div>\n                    <h1 class="m-brand-title m-abyss-title notranslate" translate="no" lang="zxx" data-brand-lock="LEVIATHAN" data-no-translate="true" aria-label="LEVIATHAN">LEVIATHAN</h1>\n                    <div class="m-brand-sub m-abyss-sub">Sovrano degli abissi</div>\n                    <div class="m-hero-badges">\n                        <span class="m-hero-badge">🐬 Real-Debrid</span>\n                        <span class="m-hero-badge">🧊 TorBox</span>\n                        <span class="m-hero-badge">🦈 P2P</span>\n                    </div>\n                    <div class="m-version-tag m-abyss-version" aria-label="Versione 3.2.0">\n                        <span class="m-v-dot" aria-hidden="true"></span>\n                        <span>v3.2.0</span>\n                    </div>\n                </div>\n            </div>\n\n            <div id="page-setup" class="m-page active">\n\n                <div class="m-hypervisor" style="margin-top:2px;">\n                    <div class="m-hyp-header">\n                        <span>🔑 ACCESSO & SERVIZI</span>\n                        <i class="fas fa-fingerprint m-hyp-icon"></i>\n                    </div>\n                    <p class="m-panel-desc"><b>Configura l'accesso</b> scegliendo Real-Debrid, TorBox o P2P. La verifica live ti conferma subito se la chiave è pronta ✨🔐.</p>\n\n                    <div class="m-cred-deck">\n                        <div class="m-cred-opt cred-rd m-srv-btn active" onclick="setMService('rd', this)">\n                            <div class="m-cred-icon">🐬</div>\n                            <div class="m-cred-name">REAL-DEBRID</div>\n                            <div class="m-cred-sub">PREMIUM</div>\n                        </div>\n                        <div class="m-cred-opt cred-tb m-srv-btn" onclick="setMService('tb', this)">\n                            <div class="m-cred-icon">🧊</div>\n                            <div class="m-cred-name">TORBOX</div>\n                            <div class="m-cred-sub">CLOUD</div>\n                        </div>\n                        <div class="m-cred-opt cred-p2p m-srv-btn" onclick="setMService('p2p', this)">\n                            <div class="m-cred-icon">🦈</div>\n                            <div class="m-cred-name">P2P MODE</div>\n                            <div class="m-cred-sub">NO KEY</div>\n                        </div>\n                    </div>\n\n                    <div class="m-input-fuselage" id="box-apikey">\n                        <div class="m-if-label">🔑 API KEY</div>\n                        <div class="m-if-inner">\n                            <div class="m-if-icon"><i class="fas fa-key"></i></div>\n                            <input type="text" id="m-apiKey" class="m-if-field" placeholder="Incolla key" oninput="handleMobileApiKeyInput()">\n                            <div class="m-if-action" onclick="pasteTo('m-apiKey')"><i class="fas fa-paste"></i></div>\n                            <div class="m-get-link" onclick="openApiPage()">GET <i class="fas fa-external-link-alt"></i></div>\n                        </div>\n                        <div class="m-key-status idle" id="m-keyStatus" aria-live="polite" aria-atomic="true">\n                            <span class="m-key-status-dot"></span>\n                            <span id="m-keyStatusText">🐬 RD / 🧊 TB live check disponibile.</span>\n                        </div>\n                    </div>\n\n                    <div class="m-input-fuselage tmdb-box" id="box-tmdb">\n                        <div class="m-if-label opt">🎬 TMDB OPTIONAL</div>\n                        <div class="m-if-inner">\n                            <div class="m-if-icon"><i class="fas fa-film"></i></div>\n                            <input type="text" id="m-tmdb" class="m-if-field" placeholder="Personal key" oninput="updateLinkModalContent()">\n                            <div class="m-if-action" onclick="pasteTo('m-tmdb')"><i class="fas fa-paste"></i></div>\n                            <div class="m-get-link" style="color:var(--m-accent); border-color:var(--m-accent); background:rgba(155, 108, 255,0.05);" onclick="openApiPage('tmdb')">GET <i class="fas fa-external-link-alt"></i></div>\n                        </div>\n                    </div>\n\n                </div>\n\n                <div class="m-hypervisor">\n                     <div class="m-hyp-header">\n                        <span>🍿 PROVIDER STREAMS ✨</span>\n                        <i class="fas fa-cubes m-hyp-icon"></i>\n                    </div>\n                    <p class="m-panel-desc"><b>Scegli le sorgenti da attivare</b>: Leviathan unisce cinema, serie e anime italiani in un catalogo pulito, veloce e facile da controllare 🍿📺✨.</p>\n\n                    <div class="m-reactor-grid">\n\n                        <div class="m-reactor-module" id="mod-vix">\n                            <div class="m-reactor-core">\n                                <span class="m-provider-glyph m-core-icon" aria-hidden="true">🍿</span>\n                            </div>\n                            <div class="m-reactor-body">\n                                <div class="m-reactor-top">\n                                    <span class="m-reactor-title">🍿 StreamingCommunity</span>\n                                    <label class="m-switch">\n                                        <input type="checkbox" id="m-enableVix" onchange="updateStatus('m-enableVix','st-vix'); toggleModuleStyle('m-enableVix', 'mod-vix');">\n                                        <span class="m-slider"></span>\n                                    </label>\n                                </div>\n                                <span class="m-reactor-desc">Film e serie TV in italiano, catalogo ricco e player rapido 🍿.</span>\n                                <div class="m-tag-row">\n                                    <span class="m-tech-tag tag-noproxy"><i class="fas fa-unlink"></i> NO PROXY</span>\n                                </div>\n</div>\n                        </div>\n\n                        <div class="m-reactor-module" id="mod-ghd">\n                            <div class="m-reactor-core">\n                                <span class="m-provider-glyph m-core-icon" aria-hidden="true">🎬</span>\n                            </div>\n                            <div class="m-reactor-body">\n                                <div class="m-reactor-top">\n                                    <span class="m-reactor-title">🎬 GuardaHD</span>\n                                    <label class="m-switch">\n                                        <input type="checkbox" id="m-enableGhd" onchange="updateStatus('m-enableGhd','st-ghd'); toggleModuleStyle('m-enableGhd', 'mod-ghd');">\n                                        <span class="m-slider"></span>\n                                    </label>\n                                </div>\n                                <span class="m-reactor-desc">Film e serie TV in qualità HD, nuove uscite e schede ordinate 🎬.</span>\n                                <div class="m-tag-row">\n                                    <span class="m-tech-tag tag-kraken"><i class="fas fa-water"></i> KRAKEN</span>\n                                </div>\n                            </div>\n                        </div>\n\n                        <div class="m-reactor-module" id="mod-gs">\n                            <div class="m-reactor-core">\n                                <span class="m-provider-glyph m-core-icon" aria-hidden="true">📺</span>\n                            </div>\n                            <div class="m-reactor-body">\n                                <div class="m-reactor-top">\n                                    <span class="m-reactor-title">📺 GuardoSerie</span>\n                                    <label class="m-switch">\n                                        <input type="checkbox" id="m-enableGs" onchange="updateStatus('m-enableGs','st-gs'); toggleModuleStyle('m-enableGs', 'mod-gs');">\n                                        <span class="m-slider m-slider-purple"></span>\n                                    </label>\n                                </div>\n                                <span class="m-reactor-desc">Serie TV italiane organizzate per stagioni ed episodi 📺.</span>\n                                <div class="m-tag-row">\n                                    <span class="m-tech-tag tag-noproxy"><i class="fas fa-unlink"></i> NO PROXY</span>\n                                </div>\n                            </div>\n                        </div>\n\n                        <div class="m-reactor-module" id="mod-vidxgo">\n                            <div class="m-reactor-core">\n                                <span class="m-provider-glyph m-core-icon" aria-hidden="true">🎯</span>\n                            </div>\n                            <div class="m-reactor-body">\n                                <div class="m-reactor-top">\n                                    <span class="m-reactor-title">🎯 VidxGo</span>\n                                    <label class="m-switch">\n                                        <input type="checkbox" id="m-enableVidxgo" onchange="updateStatus('m-enableVidxgo','st-vidxgo'); toggleModuleStyle('m-enableVidxgo', 'mod-vidxgo');">\n                                        <span class="m-slider m-slider-aqua"></span>\n                                    </label>\n                                </div>\n                                <span class="m-reactor-desc">Player diretto per film e serie TV, flusso risolto dal codice IMDb ⚡.</span>\n                                <div class="m-tag-row">\n                                    <span class="m-tech-tag tag-noproxy"><i class="fas fa-unlink"></i> NO PROXY</span>\n                                </div>\n                            </div>\n                        </div>\n\n                        <div class="m-reactor-module" id="mod-es">\n                            <div class="m-reactor-core">\n                                <span class="m-provider-glyph m-core-icon" aria-hidden="true">🌍</span>\n                            </div>\n                            <div class="m-reactor-body">\n                                <div class="m-reactor-top">\n                                    <span class="m-reactor-title">🌍 Eurostreaming</span>\n                                    <label class="m-switch">\n                                        <input type="checkbox" id="m-enableEs" onchange="updateStatus('m-enableEs','st-es'); toggleModuleStyle('m-enableEs', 'mod-es');">\n                                        <span class="m-slider m-slider-aqua"></span>\n                                    </label>\n                                </div>\n                                <span class="m-reactor-desc">Portale italiano storico dedicato a serie TV e contenuti aggiornati ⭐.</span>\n                                <div class="m-tag-row">\n                                    <span class="m-tech-tag tag-kraken"><i class="fas fa-water"></i> KRAKEN</span>\n                                </div>\n                            </div>\n                        </div>\n\n                        <div class="m-reactor-module" id="mod-cb01">\n                            <div class="m-reactor-core">\n                                <span class="m-provider-glyph m-core-icon" aria-hidden="true">🎬</span>\n                            </div>\n                            <div class="m-reactor-body">\n                                <div class="m-reactor-top">\n                                    <span class="m-reactor-title">🎬 CB01</span>\n                                    <label class="m-switch">\n                                        <input type="checkbox" id="m-enableCb01" onchange="updateStatus('m-enableCb01','st-cb01'); toggleModuleStyle('m-enableCb01', 'mod-cb01');">\n                                        <span class="m-slider m-slider-aqua"></span>\n                                    </label>\n                                </div>\n                                <span class="m-reactor-desc">Ampio catalogo di film e serie TV, tra i riferimenti più noti in Italia 🎞️.</span>\n                                <div class="m-tag-row">\n                                    <span class="m-tech-tag tag-kraken"><i class="fas fa-water"></i> KRAKEN</span>\n                                </div>\n                            </div>\n                        </div>\n\n                        <div class="m-reactor-module" id="mod-onlineserietv">\n                            <div class="m-reactor-core">\n                                <span class="m-provider-glyph m-core-icon" aria-hidden="true">🖥️</span>\n                            </div>\n                            <div class="m-reactor-body">\n                                <div class="m-reactor-top">\n                                    <span class="m-reactor-title">🖥️ OnlineSerieTV</span>\n                                    <label class="m-switch">\n                                        <input type="checkbox" id="m-enableOnlineserietv" onchange="updateStatus('m-enableOnlineserietv','st-onlineserietv'); toggleModuleStyle('m-enableOnlineserietv', 'mod-onlineserietv');">\n                                        <span class="m-slider m-slider-aqua"></span>\n                                    </label>\n                                </div>\n                                <span class="m-reactor-desc">Film e serie TV italiani, risolti via uprot/MaxStream con forward proxy 🛰️.</span>\n                                <div class="m-tag-row">\n                                    <span class="m-tech-tag tag-kraken"><i class="fas fa-water"></i> KRAKEN</span>\n                                </div>\n                            </div>\n                        </div>\n\n                        <div class="m-reactor-module" id="mod-aw">\n                            <div class="m-reactor-core">\n                                <span class="m-provider-glyph m-core-icon" aria-hidden="true">⛩️</span>\n                            </div>\n                            <div class="m-reactor-body">\n                                <div class="m-reactor-top">\n                                    <span class="m-reactor-title">⛩️ AnimeWorld</span>\n                                    <label class="m-switch">\n                                        <input type="checkbox" id="m-enableAnimeWorld" onchange="updateStatus('m-enableAnimeWorld','st-aw'); toggleModuleStyle('m-enableAnimeWorld', 'mod-aw');">\n                                        <span class="m-slider m-slider-aqua"></span>\n                                    </label>\n                                </div>\n                                <span class="m-reactor-desc">Anime sub-ita e doppiati, con schede serie e catalogo ampio 🌸.</span>\n                                <div class="m-tag-row">\n                                    <span class="m-tech-tag tag-noproxy"><i class="fas fa-unlink"></i> NO PROXY</span>\n                                </div>\n                            </div>\n                        </div>\n\n                        <div class="m-reactor-module" id="mod-au">\n                            <div class="m-reactor-core">\n                                <span class="m-provider-glyph m-core-icon" aria-hidden="true">🌊</span>\n                            </div>\n                            <div class="m-reactor-body">\n                                <div class="m-reactor-top">\n                                    <span class="m-reactor-title">🌊 AnimeUnity</span>\n                                    <label class="m-switch">\n                                        <input type="checkbox" id="m-enableAnimeUnity" onchange="updateStatus('m-enableAnimeUnity','st-au'); toggleModuleStyle('m-enableAnimeUnity', 'mod-au');">\n                                        <span class="m-slider m-slider-aqua"></span>\n                                    </label>\n                                </div>\n                                <span class="m-reactor-desc">Anime, simulcast e doppiaggi con episodi aggiornati e ordinati 🪄.</span>\n                                <div class="m-tag-row">\n                                    <span class="m-tech-tag tag-noproxy"><i class="fas fa-unlink"></i> NO PROXY</span>\n                                </div>\n                            </div>\n                        </div>\n\n                        <div class="m-reactor-module" id="mod-as">\n                            <div class="m-reactor-core">\n                                <span class="m-provider-glyph m-core-icon" aria-hidden="true">🪐</span>\n                            </div>\n                            <div class="m-reactor-body">\n                                <div class="m-reactor-top">\n                                    <span class="m-reactor-title">🪐 AnimeSaturn</span>\n                                    <label class="m-switch">\n                                        <input type="checkbox" id="m-enableAnimeSaturn" onchange="updateStatus('m-enableAnimeSaturn','st-as'); toggleModuleStyle('m-enableAnimeSaturn', 'mod-as');">\n                                        <span class="m-slider m-slider-aqua"></span>\n                                    </label>\n                                </div>\n                                <span class="m-reactor-desc">Anime classici e recenti, archivio ampio e consultazione rapida 🪐.</span>\n                                <div class="m-tag-row">\n                                    <span class="m-tech-tag tag-noproxy"><i class="fas fa-unlink"></i> NO PROXY</span>\n                                </div>\n                            </div>\n                        </div>\n\n                        <div class="m-reactor-module" id="mod-ti">\n                            <div class="m-reactor-core">\n                                <span class="m-provider-glyph m-core-icon" aria-hidden="true">🐙</span>\n                            </div>\n                            <div class="m-reactor-body">\n                                <div class="m-reactor-top">\n                                    <span class="m-reactor-title">🐙 ToonItalia</span>\n                                    <label class="m-switch">\n                                        <input type="checkbox" id="m-enableToonItalia" onchange="updateStatus('m-enableToonItalia','st-ti'); toggleModuleStyle('m-enableToonItalia', 'mod-ti');">\n                                        <span class="m-slider m-slider-aqua"></span>\n                                    </label>\n                                </div>\n                                <span class="m-reactor-desc">Cartoon e anime in italiano, con resolver VOE, LoadM/RPMShare e MaxStream.</span>\n                                <div class="m-tag-row">\n                                    <span class="m-tech-tag tag-kraken"><i class="fas fa-water"></i> KRAKEN</span>\n                                </div>\n                            </div>\n                        </div>\n\n                        <div class="m-reactor-module" id="mod-gf">\n                            <div class="m-reactor-core">\n                                <span class="m-provider-glyph m-core-icon" aria-hidden="true">🎞️</span>\n                            </div>\n                            <div class="m-reactor-body">\n                                <div class="m-reactor-top">\n                                    <span class="m-reactor-title">🎞️ GuardaFlix</span>\n                                    <label class="m-switch">\n                                        <input type="checkbox" id="m-enableGf" onchange="updateStatus('m-enableGf','st-gf'); toggleModuleStyle('m-enableGf', 'mod-gf');">\n                                        <span class="m-slider m-slider-green"></span>\n                                    </label>\n                                </div>\n                                <span class="m-reactor-desc">Film in streaming con raccolte per genere e ultime uscite 🎥.</span>\n                                <div class="m-tag-row">\n                                    <span class="m-tech-tag tag-noproxy"><i class="fas fa-unlink"></i> NO PROXY</span>\n                                </div>\n                            </div>\n                        </div>\n\n\n\n\n                    </div>\n                </div>\n\n                <div id="m-priority-panel" class="m-priority-wrapper">\n                    <div style="margin-top:5px; padding:15px; border-radius:16px; background:linear-gradient(90deg, rgba(155,108,255,0.1), transparent); border-left:4px solid var(--m-secondary);">\n                        <div style="display:flex; justify-content:space-between; align-items:center;">\n                            <div>\n                                <h5 style="margin:0; font-family:'Rajdhani'; color:#fff;">🚀 PRIORITÀ WEB</h5>\n                                <p id="priority-desc" style="margin:5px 0 0; font-size:0.8rem; color:var(--m-dim);">Mostra Web in cima</p>\n                            </div>\n                            <label class="m-switch">\n                                <input type="checkbox" id="m-vixLast" onchange="updatePriorityLabel()">\n                                <span class="m-slider" style="border-color:var(--m-secondary)"></span>\n                            </label>\n                        </div>\n                    </div>\n                </div>\n\n                <div class="m-setup-actions-panel" aria-label="Azioni configurazione">\n                    <div class="m-setup-action-row">\n                        <button class="m-setup-action m-setup-install" onclick="mobileInstall()" type="button">\n                            <span>INSTALLA</span>\n                            <i class="fas fa-radiation"></i>\n                        </button>\n                    </div>\n\n                    <div class="m-setup-mini-console" aria-label="Console copia link">\n                        <div class="m-setup-mini-console-head">\n                            <span class="m-setup-mini-console-title"><i class="fas fa-terminal"></i> LINK CONFIGURAZIONE</span>\n                            <button class="m-setup-mini-copy" onclick="copyFromSetupPanel()" type="button">\n                                <i class="fas fa-copy"></i>\n                                <span>COPIA</span>\n                            </button>\n                        </div>\n                        <div class="m-setup-mini-console-body">\n                            <textarea id="m-setupGeneratedUrlBox" class="m-setup-mini-url" readonly>/// WAITING FOR DATA ///</textarea>\n                        </div>\n                    </div>\n                </div>\n\n                <div class="m-credits-section">
                    <div class="m-neural-frame">
                        <div class="m-neural-header">
                            <span class="m-nh-title">/// GITHUB SIGNATURE ///</span>
                            <span class="m-nh-id">LUC4N3X</span>
                        </div>

                        <div class="m-neural-grid">
                            <a href="https://github.com/LUC4N3X" target="_blank" rel="noopener noreferrer" class="m-dev-module" aria-label="Profilo GitHub LUC4N3X">
                                <img src="https://github.com/LUC4N3X.png?size=160" alt="LUC4N3X GitHub" class="m-dev-img" loading="lazy" decoding="async" width="46" height="46">
                                <div class="m-dev-data">
                                    <span class="m-dev-role">GITHUB CREATOR</span>
                                    <span class="m-dev-nick">LUC4N3X</span>
                                    <span class="m-dev-meta">LEVIATHAN CORE • OPEN SOURCE</span>
                                </div>
                                <span class="m-dev-orbit" aria-hidden="true"><i class="fab fa-github m-dev-github"></i></span>
                            </a>
                        </div>

                        <div class="m-neural-footer">BUILT BY LUC4N3X</div>
                    </div>
                </div>
            </div>

            <div id="page-filters" class="m-page">\n\n                <div class="m-hypervisor">\n                    <div class="m-hyp-header">\n                        <span>⚙️ REGOLE STREAM</span>\n                        <i class="fas fa-microchip m-hyp-icon"></i>\n                    </div>\n\n                    <p class="m-panel-desc"><b>Controlla cosa mostra Leviathan</b>: ordina per qualità, scegli la lingua, limita i risultati e mantieni la lista pulita anche su smartphone 🎯📱.</p>\n\n                    <div class="m-flux-control">\n                        <div class="m-flux-grid">\n                            <div class="m-flux-opt active-bal" id="sort-balanced" onclick="setSortMode('balanced')">\n                                <i class="fas fa-dragon"></i>\n                                <span>🐉 SMART</span>\n                            </div>\n                            <div class="m-flux-opt" id="sort-resolution" onclick="setSortMode('resolution')">\n                                <i class="fas fa-gem"></i>\n                                <span>💎 QUALITY</span>\n                            </div>\n                            <div class="m-flux-opt" id="sort-size" onclick="setSortMode('size')">\n                                <i class="fas fa-hdd"></i>\n                                <span>💾 SIZE</span>\n                            </div>\n                        </div>\n\n                        <div class="m-flux-readout mode-bal" id="flux-readout-box">\n                            <i class="fas fa-info-circle m-fr-icon" id="flux-icon-display"></i>\n                            <div class="m-fr-text">\n                                <span class="m-fr-title" id="flux-title-display">STANDARD MODE</span>\n                                <span class="m-fr-desc" id="flux-desc-display">L'algoritmo standard di Leviathan ✨. Bilancia perfettamente qualita e velocita ⚡.</span>\n                            </div>\n                        </div>\n                    </div>\n\n                    <div class="m-hyp-header" style="margin-top:25px; border-top:none; padding-top:0; margin-bottom:10px;">\n                         <span>🗣️ AUDIO &amp; LINGUA</span>\n                         <i class="fas fa-globe-americas m-hyp-icon"></i>\n                    </div>\n\n                    <div class="m-lang-grid">\n                        <div class="m-lang-opt active-ita" id="lang-ita" onclick="setLangMode('ita')">\n                            <i class="fas fa-flag"></i>\n                            <span class="m-lang-txt">🇮🇹 ITA</span>\n                        </div>\n                        <div class="m-lang-opt" id="lang-all" onclick="setLangMode('all')">\n                            <i class="fas fa-comments"></i>\n                            <span class="m-lang-txt">🇮🇹+🇬🇧</span>\n                        </div>\n                        <div class="m-lang-opt" id="lang-eng" onclick="setLangMode('eng')">\n                            <i class="fas fa-flag-usa"></i>\n                            <span class="m-lang-txt">🇬🇧 ENG</span>\n                        </div>\n                    </div>\n\n                    <div id="lang-desc-container" style="background: rgba(0,0,0,0.2); border-radius: 8px; padding: 10px; margin-bottom: 25px; border-left: 3px solid var(--m-primary);">\n                        <p id="lang-description" style="margin:0; font-size: 0.7rem; color: var(--m-dim); line-height: 1.3; font-family:'Outfit';">\n                             Cerca solo contenuti in Italiano 🇮🇹. Ignora tutto il resto.\n                        </p>\n                    </div>\n\n                    <div class="m-hyp-label">📺 Resolution Filter</div>\n                    <p class="m-hyp-desc">Tocca per escludere qualità specifiche.</p>\n\n                    <div class="m-chip-grid">\n                        <div class="m-qual-chip" id="mq-4k" onclick="toggleFilter('mq-4k')">💎 4K</div>\n                        <div class="m-qual-chip" id="mq-1080" onclick="toggleFilter('mq-1080')">🎬 1080p</div>\n                        <div class="m-qual-chip" id="mq-720" onclick="toggleFilter('mq-720')">📺 720p <span class="mini-tag">HD</span></div>\n                        <div class="m-qual-chip" id="mq-sd" onclick="toggleFilter('mq-sd')">📼 CAM/SD</div>\n                    </div>\n\n                    <div class="m-sys-grid">\n                        <div class="m-sys-row">\n                            <div class="m-sys-info"><h4><i class="fas fa-layer-group" style="color:var(--m-accent)"></i> 🧩 AIO Mode <span class="m-status-text" id="st-aio">OFF</span></h4><p>Formatta per AIOStreams 🧩</p></div>\n                            <label class="m-switch"><input type="checkbox" id="m-aioMode" onchange="updateStatus('m-aioMode','st-aio')"><span class="m-slider m-slider-purple"></span></label>\n                        </div>\n                        <div class="m-sys-row">\n                            <div class="m-sys-info"><h4><i class="fas fa-cloud" style="color:var(--m-primary)"></i> ☁️ Debrid Cloud <span class="m-status-text" id="st-savedcloud">OFF</span></h4><p>File salvati RD/TorBox 📦. Duplicati sempre esclusi ✨.</p></div>\n                            <label class="m-switch"><input type="checkbox" id="m-enableSavedCloud" onchange="toggleSavedCloud()"><span class="m-slider"></span></label>\n                        </div>\n                        <div class="m-cloud-mode-panel" id="m-savedCloudPanel">\n                            <div class="m-cloud-mode-grid">\n                                <div class="m-cloud-mode-btn active" id="m-cloud-smart" onclick="setSavedCloudMode('smart')">SMART<span>utile e pulito ✨</span></div>\n                                <div class="m-cloud-mode-btn" id="m-cloud-fallback" onclick="setSavedCloudMode('fallback')">FALLBACK<span>solo se trova poco 🪄</span></div>\n                                <div class="m-cloud-mode-btn" id="m-cloud-always" onclick="setSavedCloudMode('always')">ALWAYS<span>sempre no doppioni ✅</span></div>\n                            </div>\n                            <p class="m-cloud-note">Usa solo Real-Debrid/TorBox configurati ☁️. Anche in ALWAYS, se Leviathan ha gia lo stesso hash/file, il Cloud non viene mostrato ✨.</p>\n                        </div>\n                    </div>\n\n                    <div class="m-row" style="border:none; padding: 5px 0;">\n                        <div class="m-label">\n                            <h4><i class="fas fa-compress-arrows-alt" style="color:var(--m-error)"></i> 🚦 Signal Gate <span class="m-status-text" id="st-gate">OFF</span></h4>\n                            <p style="font-size:0.65rem; color:var(--m-error);">Filtro qualità • max risultati per risoluzione 🚦</p>\n                        </div>\n                        <label class="m-switch"><input type="checkbox" id="m-gateActive" onchange="toggleGate()"><span class="m-slider"></span></label>\n                    </div>\n                    <div id="m-gate-wrapper" class="m-gate-wrapper">\n                        <div class="m-gate-control">\n                            <span style="font-size:0.8rem; color:#666;">1</span>\n                            <input type="range" min="1" max="20" value="3" class="m-range" id="m-gateVal" oninput="updateGateDisplay(this.value)">\n                            <span style="font-family:'Rajdhani'; font-weight:800; font-size:1.2rem; color:var(--m-primary); width:30px; text-align:center;" id="m-gate-display">3</span>\n                        </div>\n                        <p class="m-range-desc">Limita il numero di risultati mostrati per ogni qualita 🎯. Utile per dispositivi lenti 📱.</p>\n                    </div>\n\n                    <div class="m-row" style="border:none; padding: 5px 0;">\n                        <div class="m-label">\n                            <h4><i class="fas fa-weight-hanging" style="color:var(--m-amber)"></i> ⚖️ Size Limit <span class="m-status-text" id="st-size">OFF</span></h4>\n                            <p style="font-size:0.65rem; color:var(--m-amber);">Filtro peso massimo • GB ⚖️</p>\n                        </div>\n                        <label class="m-switch"><input type="checkbox" id="m-sizeActive" onchange="toggleSize()"><span class="m-slider m-slider-aqua"></span></label>\n                    </div>\n                     <div id="m-size-wrapper" class="m-gate-wrapper">\n                        <div class="m-gate-control">\n                            <span style="font-size:0.8rem; color:#666;">1GB</span>\n                            <input type="range" min="1" max="100" step="1" value="0" class="m-range" id="m-sizeVal" oninput="updateSizeDisplay(this.value)" style="background:linear-gradient(90deg, #ff9900, #333)">\n                            <span style="font-family:'Rajdhani'; font-weight:800; font-size:1.1rem; color:var(--m-amber); width:45px; text-align:center;" id="m-size-display">INF</span>\n                        </div>\n                         <p class="m-range-desc">Nasconde automaticamente tutti i file che superano la dimensione selezionata 📦.</p>\n                    </div>\n\n                </div>\n            </div>\n\n            <div id="page-network" class="m-page">\n\n                <div class="m-hypervisor">\n                    <div class="m-hyp-header">\n                        <span>🌐 SERVER & PROXY ✨</span>\n                        <i class="fas fa-network-wired m-hyp-icon" style="color:var(--m-secondary); border-color:rgba(155,108,255,0.35); background:rgba(155,108,255,0.08);"></i>\n                    </div>\n                    <p class="m-panel-desc"><b>Imposta un proxy personalizzato</b> solo quando serve. Altrimenti Leviathan resta sulla configurazione standard, più semplice e pulita 🌊.</p>\n\n                    <div style="padding:0 5px;">\n                        <p style="font-size:0.8rem; color:var(--m-dim); margin-bottom:20px; line-height:1.4;">\n                            Configura un endpoint proxy solo se ti serve un bridge personalizzato per le sorgenti italiane 🌊. Lascia vuoto per usare la gestione standard di Leviathan ✨.\n                        </p>\n\n                        <div class="m-field-group">\n                            <div class="m-field-header"><span class="m-field-label">🌐 SERVER URL</span></div>\n                            <div class="m-input-box">\n                                <i class="fas fa-server m-input-ico"></i>\n                                <input type="text" id="m-mfUrl" class="m-input-tech" placeholder="https://tuo-proxy.com" oninput="updateLinkModalContent()">\n                                <div class="m-paste-action" onclick="pasteTo('m-mfUrl')"><i class="fas fa-paste"></i></div>\n                            </div>\n                        </div>\n\n                        <div class="m-field-group">\n                            <div class="m-field-header"><span class="m-field-label">🔒 PASSWORD</span></div>\n                            <div class="m-input-box">\n                                <i class="fas fa-lock m-input-ico"></i>\n                                <input type="password" id="m-mfPass" class="m-input-tech" placeholder="********" oninput="updateLinkModalContent()">\n                            </div>\n                        </div>\n\n                        <div class="m-ghost-panel" id="ghost-zone-box">\n                            <div class="m-ghost-head">\n                                <div class="m-ghost-title"><i class="fas fa-user-shield"></i> 👻 DEBRID GHOST</div>\n                                <div class="m-ghost-status" id="ghost-status-text">VISIBLE</div>\n                            </div>\n                            <div style="display:flex; justify-content:space-between; align-items:center;">\n                                <p style="margin:0; font-size:0.75rem; color:rgba(255,255,255,0.6); max-width:70%;">\n                                    Instrada il traffico Debrid attraverso il Proxy configurato.\n                                </p>\n                                <label class="m-switch">\n                                    <input type="checkbox" id="m-proxyDebrid" onchange="updateGhostVisuals(); updateLinkModalContent()">\n                                    <span class="m-slider m-slider-purple"></span>\n                                </label>\n                            </div>\n                        </div>\n                    </div>\n                </div>\n            </div>\n            <div id="page-skins" class="m-page">\n                <div class="m-hypervisor">\n                    <div class="m-hyp-header">\n                        <span>🎨 STILE RISULTATI</span>\n                        <i class="fas fa-palette m-hyp-icon"></i>\n                    </div>\n                    <p class="m-panel-desc"><b>Scegli come appaiono gli stream</b> in Stremio: tocca una skin e guarda l'anteprima live aggiornarsi all'istante 🎬✨.</p>\n\n                    <div id="m-preview-box">\n                        <div class="m-prev-header">\n                            <span class="m-prev-head-text"><span class="m-prev-head-dot"></span> LIVE PREVIEW</span>\n                            <span id="m-prev-mode">LEVIATHAN</span>\n                        </div>\n                        <div class="m-prev-card-body">\n                            <div class="m-prev-poster"><span id="m-prev-icon">♆</span></div>\n                            <div class="m-prev-details">\n                                <div id="m-prev-title">—</div>\n                                <div id="m-prev-info">—</div>\n                            </div>\n                        </div>\n                    </div>\n\n                    <div class="m-cortex-grid">\n                        <div class="m-cortex-chip active" id="msk_leviathan" onclick="selectMobileSkin('leviathan')">♆ Leviathan</div>\n                        <div class="m-cortex-chip" id="msk_premium" onclick="selectMobileSkin('premium')">👑 Apex Prime</div>\n                        <div class="m-cortex-chip" id="msk_ultra_compact" onclick="selectMobileSkin('ultra_compact')">⚡️ Pulse Compact</div>\n                        <div class="m-cortex-chip" id="msk_tv_compact" onclick="selectMobileSkin('tv_compact')">📺 Neon TV</div>\n                        <div class="m-cortex-chip" id="msk_lev2" onclick="selectMobileSkin('lev2')">🧬 Architect</div>\n                        <div class="m-cortex-chip" id="msk_fra" onclick="selectMobileSkin('fra')">⚡️ Horizon</div>\n                        <div class="m-cortex-chip" id="msk_comet" onclick="selectMobileSkin('comet')">☄️ Comet</div>\n                        <div class="m-cortex-chip" id="msk_stremio_ita" onclick="selectMobileSkin('stremio_ita')">🇮🇹 ITA Mod</div>\n                        <div class="m-cortex-chip" id="msk_dav" onclick="selectMobileSkin('dav')">📼 Datastream</div>\n                        <div class="m-cortex-chip" id="msk_pri" onclick="selectMobileSkin('pri')">👑 Eclipse</div>\n                        <div class="m-cortex-chip" id="msk_and" onclick="selectMobileSkin('and')">🎬 Matrix</div>\n                        <div class="m-cortex-chip" id="msk_lad" onclick="selectMobileSkin('lad')">🎟️ Compact</div>\n                        <div class="m-cortex-chip" id="msk_torrentio" onclick="selectMobileSkin('torrentio')">📜 Torrentio</div>\n                        <div class="m-cortex-chip" id="msk_vertical" onclick="selectMobileSkin('vertical')">📑 Vertical</div>\n                        <div class="m-cortex-chip" id="msk_android" onclick="selectMobileSkin('android')">📺 Android TV</div>\n                        <div class="m-cortex-chip" id="msk_picture" onclick="selectMobileSkin('picture')">🖼️ Picture</div>\n                        <div class="m-cortex-chip" id="msk_complex" onclick="selectMobileSkin('complex')">🔲 Template</div>\n                        <div class="m-cortex-chip" id="msk_custom" onclick="selectMobileSkin('custom')">⌨️ Custom</div>\n                    </div>\n\n                    <div id="m-custom-skin-area">\n                        <textarea id="m-customTemplate" class="m-custom-tpl-input" rows="3" placeholder="Apex {quality} {score_badge} ||| {title}{n}{summary}" oninput="updateMobilePreview(); updateLinkModalContent();"></textarea>\n                        <p class="m-custom-help">Variabili: {title} {quality} {size} {source} {service} {lang} {audio} {seeders} {score_badge} {summary} {n}. Usa <b>|||</b> per separare nome e descrizione.</p>\n                    </div>\n                </div>\n            </div>\n        </div>\n    </div>\n\n    <div class="m-dock-container">\n        <div class="m-dock-nav">\n            <div class="m-nav-item active" onclick="navTo('setup', this)">\n                <span class="mf-nav-emoji">🧩</span><i class="fas fa-sliders-h"></i><span>SETUP</span>\n            </div>\n            <div class="m-nav-item" onclick="navTo('filters', this)">\n                <span class="mf-nav-emoji">🎛️</span><i class="fas fa-filter"></i><span>FILTRI</span>\n            </div>\n            <div class="m-nav-item" onclick="navTo('network', this)">\n                <span class="mf-nav-emoji">🌐</span><i class="fas fa-globe"></i><span>NET</span>\n            </div>\n            <div class="m-nav-item" onclick="navTo('skins', this)">\n                <span class="mf-nav-emoji">🎨</span><i class="fas fa-palette"></i><span>STILE</span>\n            </div>\n        </div>\n    </div>\n\n    <div class="m-action-modal" id="m-link-modal">\n        <div class="m-am-card">\n            <div class="m-am-title">🔗 LINK GENERATO</div>\n            <div class="m-am-subtitle">Installa, copia o condividi la configurazione pronta</div>\n\n            <div class="m-flux-terminal">\n                <div class="m-flux-header">\n                    <span>🌊 OCEAN LINK STREAM</span>\n                    <i class="fas fa-network-wired"></i>\n                </div>\n                <textarea id="m-generatedUrlBox" class="m-flux-input" readonly>/// WAITING FOR DATA ///</textarea>\n            </div>\n\n            <div class="m-act-btn m-act-copy" onclick="copyFromModal()">\n                <i class="fas fa-copy"></i> 📋 COPIA NEGLI APPUNTI\n            </div>\n\n            <div class="m-act-btn m-act-close" onclick="closeLinkModal()">\n                ✕ CHIUDI\n            </div>\n        </div>\n    </div>\n\n    <div class="m-toast-container" id="m-toast-area"></div>\n\n</div>\n`;
let mCurrentService = "rd",
    mScQuality = "1080",
    mSortMode = "balanced",
    mSkin = "leviathan",
    mLangMode = "ita",
    mSavedCloudMode = "smart";
const mDebridValidationState = {
        timer: null,
        requestId: 0,
        status: "idle",
        resolvedKey: "",
        resolvedService: "",
    },
    fluxData = {
        balanced: {
            title: "🐉 SMART BALANCE",
            desc: "Profilo intelligente: bilancia qualità, seed/cache e velocità.",
            icon: "fa-dragon",
        },
        resolution: {
            title: "💎 QUALITY FIRST",
            desc: "4K e 1080p sopra: priorità alla qualità visiva.",
            icon: "fa-gem",
        },
        size: {
            title: "💾 BITRATE HEAVY",
            desc: "Ordina per peso/file: utile per massimo bitrate.",
            icon: "fa-hdd",
        },
    },
    langDescriptions = {
        ita: "🇮🇹 Solo contenuti in Italiano. Ignora tutto il resto.",
        all: "🇮🇹 Prima Italiano, poi 🇬🇧 Inglese se serve.",
        eng: "🇬🇧 Solo contenuti in Inglese.",
    };
function toStylized(n, e = "std") {
    if (!n) return "";
    n = String(n);
    const t = {
        bold: {
            nums: {
                0: "𝟬",
                1: "𝟭",
                2: "𝟮",
                3: "𝟯",
                4: "𝟰",
                5: "𝟱",
                6: "𝟲",
                7: "𝟳",
                8: "𝟴",
                9: "𝟵",
            },
            chars: {
                A: "𝗔",
                B: "𝗕",
                C: "𝗖",
                D: "𝗗",
                E: "𝗘",
                F: "𝗙",
                G: "𝗚",
                H: "𝗛",
                I: "𝗜",
                J: "𝗝",
                K: "𝗞",
                L: "𝗟",
                M: "𝗠",
                N: "𝗡",
                O: "𝗢",
                P: "𝗣",
                Q: "𝗤",
                R: "𝗥",
                S: "𝗦",
                T: "𝗧",
                U: "𝗨",
                V: "𝗩",
                W: "𝗪",
                X: "𝗫",
                Y: "𝗬",
                Z: "𝗭",
                a: "𝗮",
                b: "𝗯",
                c: "𝗰",
                d: "𝗱",
                e: "𝗲",
                f: "𝗳",
                g: "𝗴",
                h: "𝗵",
                i: "𝗶",
                j: "𝗷",
                k: "𝗸",
                l: "𝗹",
                m: "𝗺",
                n: "𝗻",
                o: "𝗼",
                p: "𝗽",
                q: "𝗾",
                r: "𝗿",
                s: "𝘀",
                t: "𝘁",
                u: "𝘂",
                v: "𝘃",
                w: "ᴡ",
                x: "𝘅",
                y: "𝘆",
                z: "𝘇",
            },
        },
        spaced: {
            nums: {
                0: "0",
                1: "1",
                2: "2",
                3: "3",
                4: "4",
                5: "5",
                6: "6",
                7: "7",
                8: "8",
                9: "9",
            },
            chars: {
                A: "𝗔",
                B: "𝗕",
                C: "𝗖",
                D: "𝗗",
                E: "𝗘",
                F: "𝗙",
                G: "𝗚",
                H: "𝗛",
                I: "𝗜",
                J: "𝗝",
                K: "𝗞",
                L: "𝗟",
                M: "𝗠",
                N: "𝗡",
                O: "𝗢",
                P: "𝗣",
                Q: "𝗤",
                R: "𝗥",
                S: "𝗦",
                T: "𝗧",
                U: "𝗨",
                V: "𝗩",
                W: "𝗪",
                X: "𝗫",
                Y: "𝗬",
                Z: "𝗭",
            },
        },
        small: {
            nums: {
                0: "0",
                1: "1",
                2: "2",
                3: "3",
                4: "4",
                5: "5",
                6: "6",
                7: "7",
                8: "8",
                9: "9",
            },
            chars: {
                A: "ᴀ",
                B: "ʙ",
                C: "ᴄ",
                D: "ᴅ",
                E: "ᴇ",
                F: "ꜰ",
                G: "ɢ",
                H: "ʜ",
                I: "ɪ",
                J: "ᴊ",
                K: "ᴋ",
                L: "ʟ",
                M: "ᴍ",
                N: "ɴ",
                O: "ᴏ",
                P: "ᴘ",
                Q: "ǫ",
                R: "ʀ",
                S: "ꜱ",
                T: "ᴛ",
                U: "ᴜ",
                V: "ᴠ",
                W: "ᴡ",
                X: "x",
                Y: "ʏ",
                Z: "ᴢ",
                a: "ᴀ",
                b: "ʙ",
                c: "ᴄ",
                d: "ᴅ",
                e: "ᴇ",
                f: "ꜰ",
                g: "ɢ",
                h: "ʜ",
                i: "ɪ",
                j: "ᴊ",
                k: "ᴋ",
                l: "ʟ",
                m: "ᴍ",
                n: "ɴ",
                o: "ᴏ",
                p: "ᴘ",
                q: "ǫ",
                r: "ʀ",
                s: "ꜱ",
                t: "ᴛ",
                u: "ᴜ",
                v: "ᴠ",
                w: "ᴡ",
                x: "x",
                y: "ʏ",
                z: "ᴢ",
            },
        },
    };
    if ("spaced" === e)
        return n
            .split("")
            .map((n) => {
                const e = t.spaced;
                return ((/[0-9]/.test(n) ? e.nums[n] : e.chars[n]) || n) + " ";
            })
            .join("")
            .trim();
    const a = t[e] || t.bold;
    return n
        .split("")
        .map((n) => (/[0-9]/.test(n) ? a.nums[n] || n : a.chars[n] || n))
        .join("");
}
function showToast(n, e = "info") {
    const t = document.getElementById("m-toast-area");
    if (!t) return;
    const a = document.createElement("div");
    a.className = `m-toast ${e}`;
    let i = "fa-info-circle";
    ("warning" === e && (i = "fa-exclamation-triangle"),
        "error" === e && (i = "fa-bug"),
        "success" === e && (i = "fa-check-circle"),
        (a.innerHTML = `<i class="fas ${i}"></i> <span>${n}</span>`),
        t.appendChild(a),
        mVibrate(20),
        setTimeout(() => {
            (a.classList.add("out"), setTimeout(() => a.remove(), 300));
        }, 3e3));
}
function triggerPreviewUpdateEffect() {
    const n = document.getElementById("m-recalc-layer");
    n &&
        (n.classList.add("visible"),
        setTimeout(() => {
            n.classList.remove("visible");
        }, 400));
}
const MOBILE_FORMATTER_META = {
        leviathan: { label: "Leviathan", preview: "LEVIATHAN", icon: "♆", sub: "Abyssal" },
        premium: { label: "Apex Prime", preview: "APEX PRIME", icon: "👑", sub: "Flagship" },
        ultra_compact: {
            label: "Pulse Compact",
            preview: "PULSE COMPACT",
            icon: "⚡️",
            sub: "Dense",
        },
        tv_compact: { label: "Neon TV", preview: "NEON TV", icon: "📺", sub: "Big Screen" },
        lev2: { label: "Architect", preview: "ARCHITECT", icon: "🧬", sub: "Structured" },
        fra: { label: "Horizon", preview: "HORIZON", icon: "⚡️", sub: "Classic" },
        comet: { label: "Comet", preview: "COMET", icon: "☄️", sub: "Scan" },
        stremio_ita: { label: "ITA Mod", preview: "ITA MOD", icon: "🇮🇹", sub: "Compat" },
        dav: { label: "Datastream", preview: "DATASTREAM", icon: "📼", sub: "Verbose" },
        pri: { label: "Eclipse", preview: "ECLIPSE", icon: "👑", sub: "Prime" },
        and: { label: "Matrix", preview: "MATRIX", icon: "🎬", sub: "Cinema" },
        lad: { label: "Compact", preview: "COMPACT", icon: "🎟️", sub: "Lean" },
        torrentio: { label: "Torrentio", preview: "TORRENTIO", icon: "📜", sub: "Classic" },
        vertical: { label: "Vertical", preview: "VERTICAL", icon: "📑", sub: "Stacked" },
        android: { label: "Android TV", preview: "ANDROID TV", icon: "📺", sub: "Console" },
        picture: { label: "Picture", preview: "PICTURE", icon: "🖼️", sub: "Poster" },
        complex: { label: "Template", preview: "TEMPLATE", icon: "🔲", sub: "Matrix" },
        custom: { label: "Custom Builder", preview: "CUSTOM OVERRIDE", icon: "⌨️", sub: "Manual" },
    },
    MOBILE_FORMATTER_ALIASES = {
        default: "leviathan",
        pro: "premium",
        cine: "premium",
        cinema: "premium",
        ultra: "ultra_compact",
        ultracompact: "ultra_compact",
        compact: "ultra_compact",
        tv: "tv_compact",
        tvcompact: "tv_compact",
        android_tv: "tv_compact",
    };
function resolveMobileFormatterSkin(n) {
    const e = String(n || "leviathan")
        .toLowerCase()
        .trim();
    return MOBILE_FORMATTER_ALIASES[e] || e;
}
function getMobileFormatterMeta(n) {
    const e = resolveMobileFormatterSkin(n);
    return MOBILE_FORMATTER_META[e] || { label: e.toUpperCase(), preview: e.toUpperCase() };
}
function joinMobilePreviewParts(n, e = " | ") {
    return n.filter(Boolean).join(e);
}
function removeMobilePreviewEmoji(n = "") {
    return String(n)
        .replace(/[^A-Za-z0-9\s.\-|+()[\]\/&]/g, "")
        .replace(/\s+/g, " ")
        .trim();
}
function selectMobileSkin(n) {
    if (((n = resolveMobileFormatterSkin(n)), mChecked("m-aioMode") && "leviathan" !== n)) {
        const n = document.getElementById("m-aio-lock-overlay");
        return (
            n &&
                (n.classList.remove("m-denied-anim"),
                n.offsetWidth,
                n.classList.add("m-denied-anim")),
            mVibrate([50, 50, 50]),
            void showToast("SKIN BLOCCATA DA AIO MODE", "warning")
        );
    }
    ((mSkin = n),
        document.querySelectorAll(".m-cortex-chip").forEach((n) => n.classList.remove("active")));
    const e = document.getElementById("msk_" + n);
    e && e.classList.add("active");
    const t = document.getElementById("m-custom-skin-area");
    t && (t.style.display = "custom" === n ? "block" : "none");
    const a = document.getElementById("m-preview-box");
    (a && (a.classList.remove("glitching"), a.offsetWidth, a.classList.add("glitching")),
        updateMobilePreview(),
        updateLinkModalContent(),
        mVibrate(10));
}
function updateMobilePreviewLegacy() {
    return updateMobilePreview();
}
function updateMobilePreview() {
    const n = resolveMobileFormatterSkin(mSkin);
    let e = "🇮🇹 ITA";
    ("all" === mLangMode && (e = "🇮🇹 ITA • 🇬🇧 ENG"), "eng" === mLangMode && (e = "🇬🇧 ENG"));
    let t = "RD";
    ("tb" === mCurrentService && (t = "TB"), "p2p" === mCurrentService && (t = "P2P"));
    let a = "🦈";
    "RD" === t ? (a = "🐬") : "TB" === t && (a = "⚓");
    const i = {
            cleanName: "Dune Parte Due",
            fileTitle: "Dune.Parte.Due.2024.2160p.ITA.ENG.TrueHD.7.1.x265-Leviathan",
            quality: "4K",
            qDetails: "4K",
            sizeString: "67.81 GB",
            displaySource: "ilCorSaRoNeRo",
            serviceTag: t,
            serviceIconTitle: a,
            lang: e,
            audioTag: "TrueHD Atmos",
            audioChannels: "7.1",
            audioInfo: "TrueHD Atmos ┃ 7.1",
            codec: "HEVC",
            videoTags: ["💎 𝗥𝗘𝗠𝗨𝗫", "👁️ 𝗗𝗩+𝗛𝗗𝗥", "⚙️ 𝗛𝗘𝗩𝗖"],
            cleanTags: ["Remux", "DV+HDR", "HEVC"],
            seeders: 152,
            seedersStr: "👥 152",
            epTag: "",
            releaseGroup: "Leviathan",
            sourceLine: `${a} [${t}] ilCorSaRoNeRo`,
            providerLabel: "Netflix",
            streamScore: 94,
            scoreTier: "S+",
            scoreBadge: "🏆 S+ 94",
            visualMeter: "▰▰▰▰▰",
            featureSummary: "4K • DV+HDR • HEVC • Atmos",
        },
        o = ["RD", "TB"].includes(i.serviceTag),
        r = o ? a : "☁️",
        s = () => {
            const n = "RD" === i.serviceTag ? "🐬" : "TB" === i.serviceTag ? "⚓" : "🦈",
                e = o ? n : "⏳",
                t = toStylized("LEVIATHAN", "small"),
                a = toStylized(i.serviceTag, "bold"),
                r = [...new Set([i.quality, ...i.cleanTags].filter(Boolean))]
                    .map((n) => toStylized(n, "small"))
                    .join(" • ");
            return {
                name: `${e} ${a} ♆ ${t}`,
                title: [
                    `▶️ ${toStylized(i.cleanName, "bold")} ${i.epTag}`.trim(),
                    r ? `🔱 ${r}` : "",
                    `🗣️ ${i.lang}  |  🫧 ${i.audioTag} ${i.audioChannels}`,
                    `🧲 ${i.sizeString}  |  ${i.seedersStr}`,
                    `${n} ${i.displaySource} | 🏷️ ${toStylized(i.releaseGroup, "small")}`,
                ]
                    .filter(Boolean)
                    .join("\n"),
            };
        },
        l = (
            {
                premium: () => ({
                    name: `${r} ${i.quality} ${i.scoreBadge}`,
                    title: [
                        `🎬 ${toStylized(i.cleanName, "bold")}`,
                        `🏅 ${i.scoreBadge}  ${i.visualMeter}`,
                        `🧪 ${[...new Set([i.quality, ...i.cleanTags, i.codec].filter(Boolean))].slice(0, 4).join(" • ")}`,
                        `🔊 ${joinMobilePreviewParts([i.audioTag, i.audioChannels, i.lang], " • ")}`,
                        `📦 ${i.sizeString} • ${i.seedersStr}`,
                        `${r} ${i.displaySource} • ${i.releaseGroup} • ${i.serviceTag}`,
                    ].join("\n"),
                }),
                ultra_compact: () => ({
                    name: joinMobilePreviewParts(
                        [r, i.quality, "DV+HDR", i.serviceTag, `•${i.scoreTier}`],
                        " ",
                    ),
                    title: [
                        `🎬 ${i.cleanName}`,
                        joinMobilePreviewParts(
                            [
                                `🔊 ${i.audioTag} ${i.audioChannels}`,
                                removeMobilePreviewEmoji(i.lang),
                                `📦 ${i.sizeString}`,
                            ],
                            " • ",
                        ),
                        joinMobilePreviewParts(
                            [`🌐 ${i.displaySource}`, i.seedersStr, i.releaseGroup],
                            " • ",
                        ),
                    ].join("\n"),
                }),
                tv_compact: () => ({
                    name: joinMobilePreviewParts([i.quality, "DV+HDR", i.serviceTag], " | "),
                    title: [
                        `🎞️ ${i.codec}`,
                        `🎧 ${i.audioTag} ${i.audioChannels}`,
                        `🌐 ${removeMobilePreviewEmoji(i.lang) || i.lang}`,
                        `🏅 ${i.scoreBadge}`,
                        `📦 ${i.sizeString} • ${i.seedersStr}`,
                        `⚙️ ${i.displaySource}`,
                        `📂 ${i.fileTitle}`,
                    ].join("\n"),
                }),
                lev2: () => ({
                    name: `♆ ${toStylized("LEVIATHAN", "small")} ${i.serviceIconTitle} │ ${i.quality}`,
                    title: [
                        `🎬 ${toStylized(i.cleanName, "bold")}`,
                        `📦 ${i.sizeString} │ ${i.codec} ${i.cleanTags.filter((n) => !String(n).includes(i.codec)).join(" ")}`,
                        `🔊 ${i.audioTag} ${i.audioChannels} • ${i.lang}`,
                        `🔗 ${i.sourceLine} ${i.seedersStr}`,
                    ].join("\n"),
                }),
                fra: () => ({
                    name: "⚡️ Leviathan 4K",
                    title: [
                        `📄 ❯ ${i.fileTitle}`,
                        `🌎 ❯ ${i.lang} • ${i.audioTag}`,
                        `✨ ❯ ${i.serviceTag} • ${i.displaySource}`,
                        `🔥 ❯ ${i.quality} • ${i.cleanTags.join(" • ")}`,
                        `💾 ❯ ${i.sizeString} / 👥 ❯ ${i.seeders}`,
                    ].join("\n"),
                }),
                dav: () => ({
                    name: "🎥 4K UHD HEVC",
                    title: [
                        `📺 ${i.cleanName}`,
                        `🎧 ${i.audioTag} ${i.audioChannels} | 🎞️ ${i.codec}`,
                        `🗣️ ${i.lang} | 📦 ${i.sizeString}`,
                        `⏱️ ${i.seeders} Seeds | 🏷️ ${i.displaySource}`,
                        `${i.serviceIconTitle} Leviathan 📡 ${i.serviceTag}`,
                        `📂 ${i.fileTitle}`,
                    ].join("\n"),
                }),
                and: () => ({
                    name: `🎬 ${i.cleanName}`,
                    title: [
                        `${i.quality} ${"RD" === i.serviceTag ? "⚡" : "⏳"}`,
                        "─ ─ ─ ─ ─ ─ ─ ─ ─ ─",
                        `Lingue: ${i.lang}`,
                        `Specifiche: ${i.quality} | 📺 ${i.cleanTags.join(" ")} | 🔊 ${i.audioTag}`,
                        "─ ─ ─ ─ ─ ─ ─ ─ ─ ─",
                        `📂 ${i.sizeString} | ☁️ ${i.serviceTag} | 🛰️ Leviathan`,
                    ].join("\n"),
                }),
                lad: () => ({
                    name: `🖥️ ${i.quality} ${i.serviceTag}`,
                    title: [
                        `🎟️ ${i.cleanName}`,
                        `📜 ${i.epTag || "Movie"}`,
                        `🎥 ${i.quality} 🎞️ ${i.codec} 🎧 ${i.audioTag}`,
                        `📦 ${i.sizeString} • 🔗 Leviathan`,
                        `🌐 ${i.lang}`,
                    ].join("\n"),
                }),
                pri: () => ({
                    name: `[${i.serviceTag}]⚡️☁️\n4K🔥UHD\n[Leviathan]`,
                    title: [
                        `🎬 ${i.cleanName}`,
                        `${i.cleanTags.join(" ")}`,
                        `🎧 ${i.audioTag} | 🔊 ${i.audioChannels} | 🗣️ ${i.lang}`,
                        `📁 ${i.sizeString} | 🏷️ ${i.displaySource}`,
                        `📄 ▶️ ${i.fileTitle} ◀️`,
                    ].join("\n"),
                }),
                comet: () => ({
                    name: `[${i.serviceTag} ⚡]\nLeviathan\n${i.quality}`,
                    title: [
                        `📄 ${i.fileTitle}`,
                        `📹 ${joinMobilePreviewParts([i.codec, ...i.cleanTags].filter(Boolean), " • ")} | ${i.audioTag}`,
                        `⭐ ${i.displaySource}`,
                        `💾 ${i.sizeString} 👥 ${i.seeders}`,
                        `🌍 ${i.lang}`,
                    ].join("\n"),
                }),
                stremio_ita: () => ({
                    name: "⚡️ Leviathan 4K",
                    title: [
                        `📄 ❯ ${i.fileTitle}`,
                        `🌎 ❯ ${String(i.lang || "")
                            .replace(/ITA/gi, "ita")
                            .replace(/ENG/gi, "eng")}`,
                        `✨ ❯ ${i.serviceTag} • ${i.displaySource}`,
                        `🔥 ❯ ${i.quality} • ${i.cleanTags.join(" • ")}`,
                        `💾 ❯ ${i.sizeString}`,
                        `🔉 ❯ ${i.audioTag} • ${i.audioChannels}`,
                    ].join("\n"),
                }),
                torrentio: () => ({
                    name: `[${i.serviceTag}]\n${i.quality}`,
                    title: [
                        `📄 ${i.fileTitle}`,
                        `📦 ${i.sizeString} 👤 ${i.seeders}`,
                        `🔍 ${i.displaySource}`,
                        `🔊 ${removeMobilePreviewEmoji(i.lang) || i.lang}`,
                    ].join("\n"),
                }),
                vertical: () => ({
                    name: `♆ Leviathan ${i.quality} ${o ? "⚡" : "☁️"} Cached`,
                    title: [
                        `🍿 ${i.cleanName}`,
                        `📼 WEB-DL • ${i.cleanTags[0]}`,
                        `⚙️ ${i.codec}`,
                        `🔊 ${i.audioTag} (${i.audioChannels})`,
                        `💬 ${i.lang}`,
                        `🧲 ${i.sizeString}`,
                    ].join("\n"),
                }),
                complex: () => ({
                    name: `🔲 4K │ ⛁ ${i.sizeString}`,
                    title: [
                        `☰ ${joinMobilePreviewParts([i.lang, i.audioTag, i.audioChannels], " · ")}`,
                        `☲ ${joinMobilePreviewParts([i.quality, i.codec, i.cleanTags.join(" · ")], " · ")}`,
                        `☵ ${joinMobilePreviewParts(["Leviathan", i.releaseGroup, i.displaySource, `[${i.serviceTag}]`], " · ")}`,
                        `☶ ${joinMobilePreviewParts([i.cleanName, i.epTag], " · ")}`,
                    ].join("\n"),
                }),
                android: () => ({
                    name: joinMobilePreviewParts([i.quality, "DV+HDR", i.serviceTag], " | "),
                    title: [
                        `🎞️ ${i.codec}`,
                        `🎧 ${i.audioTag} ${i.audioChannels}`,
                        `⚙️ ${i.displaySource}`,
                        i.lang,
                        `📂 ${i.fileTitle}`,
                    ].join("\n"),
                }),
                picture: () => ({
                    name: `✅ UHD HDR ATMOS ${i.quality}`,
                    title: [
                        `🎬 ${i.cleanName}`,
                        `✨ ${i.quality} 🔆 DV | HDR`,
                        `🎧 ${i.audioTag} 🔊 ${i.audioChannels}`,
                        "💿 Blu-ray Remux",
                        `📦 ${i.sizeString}`,
                        `🏷️ Blu-ray Remux T1 (${i.releaseGroup})`,
                        `⚡ Comet ${i.serviceTag}`,
                    ].join("\n"),
                }),
                custom: () => {
                    let n =
                        mValue("m-customTemplate") ||
                        "Apex {quality} {score_badge} ||| {title}{n}{summary}";
                    const e = {
                        "{title}": i.cleanName,
                        "{originalTitle}": i.fileTitle,
                        "{ep}": i.epTag || "",
                        "{quality}": i.quality,
                        "{quality_bold}": toStylized(i.quality, "bold"),
                        "{size}": i.sizeString,
                        "{source}": i.displaySource,
                        "{service}": i.serviceTag,
                        "{lang}": i.lang,
                        "{audio}": i.audioInfo,
                        "{seeders}": i.seedersStr,
                        "{score}": String(i.streamScore),
                        "{score_badge}": i.scoreBadge,
                        "{score_tier}": i.scoreTier,
                        "{meter}": i.visualMeter,
                        "{summary}": i.featureSummary,
                        "{n}": "\n",
                    };
                    if (
                        (Object.keys(e).forEach((t) => {
                            n = n.replace(new RegExp(t.replace(/[{}]/g, "$&"), "g"), e[t]);
                        }),
                        n.includes("|||"))
                    ) {
                        const e = n.split("|||");
                        return { name: e[0].trim(), title: e[1].trim() };
                    }
                    return { name: `Leviathan ${i.quality}`, title: n };
                },
                leviathan: s,
            }[n] || s
        )(),
        m = getMobileFormatterMeta(n),
        d = document.getElementById("m-prev-mode"),
        c = document.getElementById("m-prev-icon"),
        p = document.getElementById("m-prev-title"),
        g = document.getElementById("m-prev-info");
    (d && (d.innerText = m.preview),
        c && (c.innerText = m.icon || "♆"),
        p && (p.innerText = l.name),
        g && (g.innerText = l.title));
}
function toggleMobileAIOLock() {
    const n = mChecked("m-aioMode"),
        e = document.getElementById("m-aio-lock-overlay");
    e && e.classList.toggle("active", n);
}
function createLogoParticles() {
    const n = document.getElementById("logoParticles");
    if (!n) return;
    const e = document.body.classList.contains("m-lowfx") ? 0 : 5;
    n.textContent = "";
    for (let t = 0; t < e; t++) {
        const e = document.createElement("div");
        e.classList.add("logo-particle");
        const t = 4 * Math.random() + 2;
        ((e.style.width = `${t}px`),
            (e.style.height = `${t}px`),
            (e.style.left = 100 * Math.random() + "%"),
            (e.style.animationDuration = 10 * Math.random() + 5 + "s"),
            (e.style.animationDelay = `-${10 * Math.random()}s`));
        const a = 8 * Math.random() - 4;
        ((e.style.transform = `translateX(${a}px)`), n.appendChild(e));
    }
}
function createOceanParticles() {
    const n = document.getElementById("m-ocean-particles");
    n && (n.textContent = "");
}
const LEVIATHAN_SEA_SHADER = {
    vertex: "\n        attribute vec2 a_position;\n        varying vec2 v_uv;\n        void main() {\n            v_uv = a_position * 0.5 + 0.5;\n            gl_Position = vec4(a_position, 0.0, 1.0);\n        }\n    ",
    fragment:
        "\n        precision mediump float;\n\n        uniform vec2 u_resolution;\n        uniform float u_time;\n        uniform float u_intensity;\n        varying vec2 v_uv;\n\n        float hash(vec2 p) {\n            p = fract(p * vec2(123.34, 456.21));\n            p += dot(p, p + 45.32);\n            return fract(p.x * p.y);\n        }\n\n        float noise(vec2 p) {\n            vec2 i = floor(p);\n            vec2 f = fract(p);\n            vec2 u = f * f * (3.0 - 2.0 * f);\n            return mix(\n                mix(hash(i + vec2(0.0, 0.0)), hash(i + vec2(1.0, 0.0)), u.x),\n                mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x),\n                u.y\n            );\n        }\n\n        float fbm(vec2 p) {\n            float v = 0.0;\n            float a = 0.5;\n            mat2 r = mat2(0.80, -0.60, 0.60, 0.80);\n            for (int i = 0; i < 5; i++) {\n                v += a * noise(p);\n                p = r * p * 2.02 + 11.3;\n                a *= 0.53;\n            }\n            return v;\n        }\n\n        float caustic(vec2 p, float t) {\n            vec2 q = p;\n            q += 0.55 * vec2(fbm(p * 1.6 + vec2(t * 0.22, 0.0)), fbm(p * 1.6 + vec2(0.0, t * 0.18)));\n            float n1 = fbm(q * 2.4 - vec2(t * 0.12, t * 0.15));\n            float n2 = fbm(q * 4.1 + vec2(t * 0.10, -t * 0.08));\n            float ridge1 = 1.0 - abs(2.0 * n1 - 1.0);\n            float ridge2 = 1.0 - abs(2.0 * n2 - 1.0);\n            return pow(ridge1, 3.0) * 0.7 + pow(ridge2, 4.0) * 0.3;\n        }\n\n        void main() {\n            vec2 res = max(u_resolution.xy, vec2(1.0));\n            vec2 uv = gl_FragCoord.xy / res;\n            float aspect = res.x / max(res.y, 1.0);\n\n            vec2 autoOffset = vec2(sin(u_time * 0.25) * 0.06, cos(u_time * 0.18) * 0.03);\n            vec2 p = vec2((uv.x - 0.5) * aspect, uv.y) - autoOffset;\n\n            float t = u_time * 0.28;\n\n            float depth = uv.y;\n            vec3 deep = vec3(0.002, 0.015, 0.038);\n            vec3 surf = vec3(0.010, 0.070, 0.130);\n            vec3 col = mix(deep, surf, smoothstep(0.0, 1.0, depth));\n\n            float env = smoothstep(0.02, 0.85, depth);\n\n            vec2 cuv = p * 2.1 + vec2(0.0, -u_time * 0.012);\n            float c = caustic(cuv, t);\n            col += vec3(0.12, 0.48, 0.65) * c * env * 0.45;\n\n            float c2 = caustic(cuv * 0.58 + 8.0, t * 0.65);\n            col += vec3(0.07, 0.32, 0.48) * c2 * env * 0.25;\n\n            float rays = 0.0;\n            float autoSlope = sin(u_time * 0.15) * 0.22;\n            float rx = p.x * 0.75 + sin(u_time * 0.10) * 0.15 - p.y * autoSlope;\n\n            rays += smoothstep(0.55, 0.0, abs(rx + 0.25 + sin(u_time * 0.12) * 0.05));\n            rays += smoothstep(0.48, 0.0, abs(rx - 0.20 + sin(u_time * 0.10 + 1.6) * 0.04)) * 0.75;\n            rays += smoothstep(0.42, 0.0, abs(rx + 0.75 + sin(u_time * 0.08 + 3.2) * 0.03)) * 0.55;\n            rays *= smoothstep(0.05, 1.0, depth) * (0.42 + 0.58 * fbm(vec2(p.x * 2.2, u_time * 0.16)));\n            col += vec3(0.15, 0.46, 0.60) * rays * 0.095;\n\n            float motes = smoothstep(0.993, 1.0, hash(floor((p + vec2(0.0, u_time * 0.008)) * 110.0)));\n            col += vec3(0.25, 0.55, 0.70) * motes * 0.15;\n\n            col += vec3(0.060, 0.025, 0.110) * smoothstep(0.55, 1.0, uv.x) * 0.18;\n\n            float vign = smoothstep(1.35, 0.22, length((uv - 0.5) * vec2(aspect * 0.42, 1.0)));\n            col *= 0.75 + vign * 0.32;\n\n            col *= 0.85 + 0.15 * u_intensity;\n            col = pow(max(col, 0.0), vec3(0.88));\n            gl_FragColor = vec4(col, 1.0);\n        }\n    ",
};
function leviathanSeaShouldSkip() {
    return !0;
}
function createSeaShaderProgram(n, e, t) {
    const a = (e, t) => {
            const a = n.createShader(e);
            if (!a) throw new Error("shader allocation failed");
            if (
                (n.shaderSource(a, t),
                n.compileShader(a),
                !n.getShaderParameter(a, n.COMPILE_STATUS))
            ) {
                const e = n.getShaderInfoLog(a) || "shader compile failed";
                throw (n.deleteShader(a), new Error(e));
            }
            return a;
        },
        i = a(n.VERTEX_SHADER, e),
        o = a(n.FRAGMENT_SHADER, t),
        r = n.createProgram();
    if (!r) throw new Error("program allocation failed");
    if (
        (n.attachShader(r, i),
        n.attachShader(r, o),
        n.linkProgram(r),
        n.deleteShader(i),
        n.deleteShader(o),
        !n.getProgramParameter(r, n.LINK_STATUS))
    ) {
        const e = n.getProgramInfoLog(r) || "program link failed";
        throw (n.deleteProgram(r), new Error(e));
    }
    return r;
}
function getLeviathanSeaProfile() {
    const n = navigator.hardwareConcurrency || 8,
        e = Number(navigator.deviceMemory || 0),
        t = !!document.body?.classList?.contains("m-lowfx"),
        a = (e > 0 && e <= 2) || (n && n <= 2);
    return a
        ? { dpr: 0.72, fps: 18, intensity: 0.72 }
        : t || a || (n && n <= 4) || (e && e <= 4)
          ? { dpr: 0.88, fps: 24, intensity: 0.86 }
          : { dpr: 1.15, fps: 30, intensity: 1 };
}
function startLeviathanSeaShader(n) {
    if (!n || window.__leviathanSea) return;
    const e = getLeviathanSeaProfile(),
        t = document.createElement("canvas");
    (t.setAttribute("aria-hidden", "true"),
        (t.style.width = "100%"),
        (t.style.height = "100%"),
        (n.textContent = ""),
        n.appendChild(t));
    const a =
        t.getContext("webgl", {
            alpha: !0,
            antialias: !1,
            depth: !1,
            stencil: !1,
            preserveDrawingBuffer: !1,
            powerPreference: "low-power",
        }) || t.getContext("experimental-webgl");
    if (!a)
        return (
            n.remove(),
            (window.__leviathanSeaShaderBoot = !1),
            void activateLeviathanSeaFallback()
        );
    let i = null,
        o = null,
        r = 0,
        s = null,
        l = !1,
        m = !1;
    try {
        ((i = createSeaShaderProgram(
            a,
            LEVIATHAN_SEA_SHADER.vertex,
            LEVIATHAN_SEA_SHADER.fragment,
        )),
            (o = a.createBuffer()),
            a.bindBuffer(a.ARRAY_BUFFER, o),
            a.bufferData(
                a.ARRAY_BUFFER,
                new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]),
                a.STATIC_DRAW,
            ));
    } catch (e) {
        try {
            i && a.deleteProgram(i);
        } catch (n) {}
        try {
            o && a.deleteBuffer(o);
        } catch (n) {}
        return (
            n.remove(),
            (window.__leviathanSeaShaderBoot = !1),
            void activateLeviathanSeaFallback()
        );
    }
    const d = a.getAttribLocation(i, "a_position"),
        c = a.getUniformLocation(i, "u_resolution"),
        p = a.getUniformLocation(i, "u_time"),
        g = a.getUniformLocation(i, "u_intensity"),
        u = Math.max(16, Math.round(1e3 / Math.max(12, e.fps || 24))),
        b = performance.now(),
        f = { raf: 0, lastFrame: 0, paused: !1, sync: null, cleanup: null },
        v = () => {
            if (l || m) return;
            const i = n.getBoundingClientRect(),
                o = Math.max(0.65, Math.min(window.devicePixelRatio || 1, e.dpr)),
                r = Math.max(2, Math.floor((i.width || window.innerWidth || 390) * o)),
                s = Math.max(2, Math.floor((i.height || window.innerHeight || 760) * o));
            ((t.width === r && t.height === s) || ((t.width = r), (t.height = s)),
                a.viewport(0, 0, r, s));
        },
        x = (n) => {
            if (((f.raf = 0), !(l || m || f.paused)))
                if (f.lastFrame && n - f.lastFrame < u) f.raf = requestAnimationFrame(x);
                else {
                    f.lastFrame = n;
                    try {
                        (v(),
                            a.useProgram(i),
                            a.bindBuffer(a.ARRAY_BUFFER, o),
                            a.enableVertexAttribArray(d),
                            a.vertexAttribPointer(d, 2, a.FLOAT, !1, 0, 0),
                            a.uniform2f(c, t.width, t.height),
                            a.uniform1f(p, 0.001 * (n - b)),
                            a.uniform1f(g, e.intensity),
                            a.disable(a.DEPTH_TEST),
                            a.disable(a.CULL_FACE),
                            a.enable(a.BLEND),
                            a.blendFunc(a.SRC_ALPHA, a.ONE_MINUS_SRC_ALPHA),
                            a.clearColor(0, 0, 0, 0),
                            a.clear(a.COLOR_BUFFER_BIT),
                            a.drawArrays(a.TRIANGLE_STRIP, 0, 4));
                    } catch (n) {
                        return (f.cleanup && f.cleanup(), void activateLeviathanSeaFallback());
                    }
                    f.raf = requestAnimationFrame(x);
                }
        },
        h = () =>
            document.hidden ||
            document.body.classList.contains("m-typing") ||
            document.body.classList.contains("m-keyboard-open") ||
            document.body.classList.contains("m-page-hidden"),
        y = () => {
            f.paused ||
                ((f.paused = !0),
                f.raf && cancelAnimationFrame(f.raf),
                (f.raf = 0),
                n.classList.add("is-paused"));
        };
    let w = 0;
    const k = () => {
            w ||
                l ||
                (w = requestAnimationFrame(() => {
                    ((w = 0),
                        h()
                            ? y()
                            : (() => {
                                  if (l || m || h()) return y();
                                  (!f.paused && f.raf) ||
                                      ((f.paused = !1),
                                      (f.lastFrame = 0),
                                      n.classList.remove("is-paused"),
                                      (f.raf = requestAnimationFrame(x)));
                              })());
                }));
        },
        S = () => {
            (r && cancelAnimationFrame(r),
                (r = requestAnimationFrame(() => {
                    ((r = 0), v());
                })));
        },
        M = (e) => {
            (e.preventDefault(), (m = !0), y(), n.classList.remove("is-ready"));
        },
        L = () => {
            (f.cleanup && f.cleanup(),
                (window.__leviathanSeaShaderBoot = !1),
                requestAnimationFrame(createSeaCanvas));
        };
    ((f.cleanup = () => {
        if (!l) {
            ((l = !0),
                w && cancelAnimationFrame(w),
                r && cancelAnimationFrame(r),
                f.raf && cancelAnimationFrame(f.raf),
                document.removeEventListener("visibilitychange", k),
                window.removeEventListener("resize", S),
                window.removeEventListener("orientationchange", S),
                t.removeEventListener("webglcontextlost", M),
                t.removeEventListener("webglcontextrestored", L));
            try {
                s && s.disconnect();
            } catch (n) {}
            try {
                a.deleteBuffer(o);
            } catch (n) {}
            try {
                a.deleteProgram(i);
            } catch (n) {}
            (n.classList.remove("is-ready", "is-paused"),
                (window.__leviathanSea = null),
                (window.__leviathanSeaShaderBoot = !1));
        }
    }),
        (f.sync = k),
        (window.__leviathanSea = f),
        (window.__leviathanSeaSync = k),
        (window.__leviathanSeaCleanup = f.cleanup),
        document.addEventListener("visibilitychange", k, { passive: !0 }),
        window.addEventListener("resize", S, { passive: !0 }),
        window.addEventListener("orientationchange", S, { passive: !0 }),
        t.addEventListener("webglcontextlost", M, !1),
        t.addEventListener("webglcontextrestored", L, !1));
    try {
        ((s = new MutationObserver(k)),
            s.observe(document.body, { attributes: !0, attributeFilter: ["class"] }));
    } catch (n) {}
    (window.addEventListener("pagehide", f.cleanup, { once: !0 }),
        v(),
        requestAnimationFrame(() => {
            (n.classList.add("is-ready"), deactivateLeviathanSeaFallback());
        }),
        k());
}
function installLeviathanSeaBfcacheRestart() {
    window.__leviathanSeaBfcacheRestart ||
        ((window.__leviathanSeaBfcacheRestart = !0),
        window.addEventListener(
            "pageshow",
            (n) => {
                n &&
                    n.persisted &&
                    (window.__leviathanSea && "function" == typeof window.__leviathanSea.sync
                        ? window.__leviathanSea.sync()
                        : ((window.__leviathanSeaShaderBoot = !1),
                          requestAnimationFrame(createSeaCanvas)));
            },
            { passive: !0 },
        ));
}
function activateLeviathanSeaFallback() {
    if (document.body)
        try {
            let n = document.getElementById("m-sea-css");
            (n ||
                ((n = document.createElement("div")),
                (n.id = "m-sea-css"),
                n.setAttribute("aria-hidden", "true"),
                (n.innerHTML =
                    '<div class="m-seacss-caustic"></div><div class="m-seacss-ray r2"></div><div class="m-seacss-ray r1"></div><div class="m-seacss-ray r3"></div><div class="m-seacss-layer m-seacss-swell3"></div><div class="m-seacss-layer m-seacss-swell2"></div><div class="m-seacss-layer m-seacss-swell1"></div>'),
                document.body.insertBefore(n, document.body.firstChild)),
                document.body.classList.add("m-sea-fallback"));
        } catch (n) {}
}
function deactivateLeviathanSeaFallback() {
    try {
        document.body.classList.remove("m-sea-fallback");
    } catch (n) {}
}
function createSeaCanvas() {
    installLeviathanSeaBfcacheRestart();
    const n = document.getElementById("m-sea-canvas");
    if ((n && n.remove(), window.__leviathanSeaShaderBoot)) return;
    if (((window.__leviathanSeaShaderBoot = !0), leviathanSeaShouldSkip()))
        return ((window.__leviathanSeaShaderBoot = !1), void activateLeviathanSeaFallback());
    let e = document.getElementById("m-sea-webgl");
    e ||
        ((e = document.createElement("div")),
        (e.id = "m-sea-webgl"),
        e.setAttribute("aria-hidden", "true"),
        document.body.insertBefore(e, document.body.firstChild));
    const t = () => requestAnimationFrame(() => startLeviathanSeaShader(e));
    "function" == typeof requestIdleCallback
        ? requestIdleCallback(t, { timeout: 700 })
        : setTimeout(t, 80);
}
function initMobileViewportGuard() {
    const n = document.documentElement;
    let e = 0,
        t = 0;
    const a = () => {
            if (
                document.body.classList.contains("m-keyboard-open") ||
                (document.activeElement &&
                    document.activeElement.tagName &&
                    ("INPUT" === document.activeElement.tagName ||
                        "TEXTAREA" === document.activeElement.tagName))
            )
                return;
            const e = Math.max(
                320,
                Math.round(window.innerHeight || document.documentElement.clientHeight || 0),
            );
            e && ((t = e), n.style.setProperty("--m-vvh", `${e}px`));
        },
        i = isMobileTextField,
        o = (n = !1) => {
            (window.clearTimeout(e),
                (e = window.setTimeout(() => {
                    (!n && i()) ||
                        document.body.classList.remove(
                            "m-input-active",
                            "m-keyboard-open",
                            "m-typing",
                        );
                }, 250)));
        };
    (a(),
        window.addEventListener("orientationchange", () => window.setTimeout(a, 260), {
            passive: !0,
        }),
        window.visualViewport &&
            window.visualViewport.addEventListener(
                "resize",
                () => {
                    window.visualViewport.height >= 0.8 * (t || window.innerHeight) &&
                        document.body.classList.contains("m-keyboard-open") &&
                        o(!0);
                },
                { passive: !0 },
            ),
        document.addEventListener(
            "focusin",
            (n) => {
                i(mAsElement(n.target)) &&
                    (window.clearTimeout(e),
                    document.body.classList.add("m-input-active", "m-keyboard-open", "m-typing"));
            },
            { passive: !0 },
        ),
        document.addEventListener(
            "focusout",
            (n) => {
                i(mAsElement(n.target)) && o();
            },
            { passive: !0 },
        ),
        document.addEventListener(
            "pointerdown",
            (n) => {
                const e = mAsElement(n.target);
                isMobileTextField(mClosest(e, 'input, textarea, [contenteditable="true"]')) ||
                    mClosest(
                        e,
                        '.m-switch, input[type="checkbox"], button, .m-qual-chip, .m-cloud-mode-btn, .m-reactor-module, .m-flux-opt, .m-lang-opt, .m-cortex-chip, .m-cred-opt, .m-act-btn, .m-nav-item, .m-paste-action, .m-if-action, .m-get-link',
                    ) ||
                    o();
            },
            { passive: !0 },
        ));
}
function installMobileVisibilityGuard() {
    const n = () => document.body.classList.toggle("m-page-hidden", document.hidden);
    (document.addEventListener("visibilitychange", n, { passive: !0 }), n());
}
function installMobileInputPerformanceGuard() {
    const n = isMobileTextField;
    (document.addEventListener(
        "input",
        (e) => {
            const t = mAsElement(e.target);
            var a;
            ((a = t),
                a?.matches?.('input[type="checkbox"], input[type="radio"], input[type="range"]')
                    ? n(document.activeElement) ||
                      (clearTimeout(MOBILE_PERF.inputIdleTimer),
                      document.body.classList.remove(
                          "m-typing",
                          "m-input-active",
                          "m-keyboard-open",
                      ))
                    : n(t) &&
                      (document.body.classList.add("m-typing"),
                      clearTimeout(MOBILE_PERF.inputIdleTimer),
                      (MOBILE_PERF.inputIdleTimer = setTimeout(() => {
                          n(document.activeElement) || document.body.classList.remove("m-typing");
                      }, MOBILE_PERF.inputIdleMs))));
        },
        { passive: !0 },
    ),
        document.addEventListener(
            "touchstart",
            (n) => {
                const e = mClosest(
                    n.target,
                    ".m-if-action, .m-paste-action, .m-get-link, .m-nav-item, .m-btn-install, .m-btn-copy, .m-act-btn",
                );
                e &&
                    (e.classList.add("is-touching"),
                    setTimeout(() => e.classList.remove("is-touching"), 140));
            },
            { passive: !0 },
        ));
}
function installMobileNoFlickerGuard() {
    let n = 0;
    const e = () => {
            (document.body.classList.add("m-switching"),
                isMobileTextField(document.activeElement) ||
                    (clearTimeout(MOBILE_PERF.inputIdleTimer),
                    document.body.classList.remove(
                        "m-typing",
                        "m-input-active",
                        "m-keyboard-open",
                    )),
                clearTimeout(n),
                (n = setTimeout(() => document.body.classList.remove("m-switching"), 360)));
        },
        t = (n) =>
            document.addEventListener(
                n,
                (n) => {
                    mClosest(
                        n.target,
                        '.m-switch, input[type="checkbox"], input[type="radio"], input[type="range"]',
                    ) && e();
                },
                { passive: !0 },
            );
    (t("pointerdown"),
        t("touchstart"),
        t("input"),
        t("change"),
        requestAnimationFrame(() =>
            requestAnimationFrame(() => document.body.classList.add("m-ui-ready")),
        ));
}
function scheduleMobileAfterPaint(n) {
    "function" == typeof requestIdleCallback
        ? requestIdleCallback(n, { timeout: 900 })
        : setTimeout(n, 80);
}
function syncMobileDockMetrics() {
    try {
        const n = document.documentElement,
            e = document.querySelector(".m-dock-container");
        if (!n || !e) return;
        const t = e.getBoundingClientRect(),
            a = Math.max(72, Math.ceil(t.height || e.offsetHeight || 76));
        n.style.setProperty("--m-dock-h", `${a}px`);
    } catch (n) {}
}
function installMobileDockMetricsGuard() {
    try {
        if (
            (syncMobileDockMetrics(),
            requestAnimationFrame(syncMobileDockMetrics),
            setTimeout(syncMobileDockMetrics, 250),
            setTimeout(syncMobileDockMetrics, 900),
            window.addEventListener(
                "resize",
                () => {
                    (clearTimeout(window._dockT),
                        (window._dockT = setTimeout(syncMobileDockMetrics, 150)));
                },
                { passive: !0 },
            ),
            window.addEventListener(
                "orientationchange",
                () => setTimeout(syncMobileDockMetrics, 220),
                { passive: !0 },
            ),
            "ResizeObserver" in window)
        ) {
            const n = document.querySelector(".m-dock-container");
            if (n) {
                const e = new ResizeObserver(() => syncMobileDockMetrics());
                (e.observe(n), (window.__leviathanDockMetricsObserver = e));
            }
        }
    } catch (n) {}
}
function installMobileSmartFxBudget() {
    try {
        if (window.__leviathanMobileSmartFxBudget) return;
        window.__leviathanMobileSmartFxBudget = !0;
        const n = document.querySelector(".m-content");
        let e = 0,
            t = 0;
        const a = () => {
                document.body.classList.add("m-scrolling");
                clearTimeout(e);
                e = setTimeout(() => document.body.classList.remove("m-scrolling"), 180);
            },
            i = () => {
                cancelAnimationFrame(t);
                t = requestAnimationFrame(() => {
                    applyMobilePerformanceMode();
                    syncMobileDockMetrics();
                    window.__leviathanSea && "function" == typeof window.__leviathanSea.sync && window.__leviathanSea.sync();
                });
            };
        n && n.addEventListener("scroll", a, { passive: !0 });
        window.addEventListener("resize", i, { passive: !0 });
        window.addEventListener("orientationchange", () => setTimeout(i, 220), { passive: !0 });
    } catch (n) {}
}
function initMobileInterface() {
    if (!document.head || !document.body) return;
    if (window.__leviathanMobileInitialized) return;
    ((window.__leviathanMobileInitialized = !0), ensureMobileLogoHints(), primeMobileLogo());
    let n = document.getElementById("leviathan-mobile-style");
    (n ||
        ((n = document.createElement("style")),
        (n.id = "leviathan-mobile-style"),
        (n.textContent = mobileCSS),
        document.head.appendChild(n)),
        document.getElementById("app-container") || (document.body.innerHTML = mobileHTML),
        installMobileDockMetricsGuard(),
        lockMobileBrandTitle(),
        applyMobilePerformanceMode(),
        initMobileViewportGuard(),
        installMobileVisibilityGuard(),
        installMobileSmartFxBudget(),
        installMobileInputPerformanceGuard(),
        installMobileNoFlickerGuard(),
        hydrateMobileLogo(),
        initPullToRefresh(),
        loadMobileConfig(),
        updateMobilePreview(),
        scheduleMobileAfterPaint(() => {
            (createLogoParticles(), createOceanParticles(), createSeaCanvas());
        }));
}
function initPullToRefresh() {
    const n = document.querySelector(".m-content"),
        e = document.getElementById("m-ptr-indicator"),
        t = e?.querySelector?.("i");
    if (!n || !e || !t) return;
    let a = 0,
        i = !1,
        o = null;
    (n.addEventListener(
        "touchstart",
        (e) => {
            const t = e.touches?.[0];
            t && 0 === n.scrollTop && ((a = t.pageY), (i = !0));
        },
        { passive: !0 },
    ),
        n.addEventListener(
            "touchmove",
            (r) => {
                if (!i) return;
                const s = r.touches?.[0];
                if (!s) return;
                const l = s.pageY - a;
                if (l > 0 && n.scrollTop <= 0) {
                    if (o) return;
                    o = requestAnimationFrame(() => {
                        e.style.opacity = String(Math.min(l / 100, 1));
                        const n = Math.min(0.4 * l, 80);
                        ((e.style.transform = `translate3d(0, ${n}px, 0)`),
                            (t.style.transform = `rotate(${3 * n}deg)`),
                            l > 80
                                ? (t.classList.remove("fa-arrow-down"),
                                  t.classList.add("fa-sync-alt"))
                                : (t.classList.remove("fa-sync-alt"),
                                  t.classList.add("fa-arrow-down")),
                            (o = null));
                    });
                }
            },
            { passive: !0 },
        ),
        n.addEventListener(
            "touchend",
            (t) => {
                if (!i) return;
                i = !1;
                const r = t.changedTouches?.[0];
                r &&
                    (r.pageY - a > 80 && n.scrollTop <= 0
                        ? (e.classList.add("loading"),
                          (e.style.transform = "translate3d(0, 50px, 0)"),
                          mVibrate(50),
                          setTimeout(() => {
                              location.reload();
                          }, 500))
                        : ((e.style.transform = ""), (e.style.opacity = "0")),
                    o && (cancelAnimationFrame(o), (o = null)));
            },
            { passive: !0 },
        ));
}
function navTo(n, e) {
    (document.querySelectorAll(".m-page").forEach((n) => n.classList.remove("active")),
        document.querySelectorAll(".m-nav-item").forEach((n) => n.classList.remove("active")));
    const t = document.getElementById("page-" + n);
    (t && t.classList.add("active"), e && e.classList.add("active"));
    const a = document.querySelector(".m-content");
    (a && (a.scrollTop = 0), mVibrate(10));
}
function clearMobileDebridValidationTimer() {
    mDebridValidationState.timer &&
        (clearTimeout(mDebridValidationState.timer), (mDebridValidationState.timer = null));
}
function formatMobileValidationExpiration(n) {
    if (!n) return null;
    const e = new Date(n);
    return Number.isNaN(e.getTime())
        ? null
        : e.toLocaleDateString("it-IT", { day: "2-digit", month: "2-digit", year: "numeric" });
}
function getMobileValidationServiceMeta(n) {
    return "tb" === n ? { code: "TB", name: "TorBox" } : { code: "RD", name: "Real-Debrid" };
}
function setMobileDebridValidationStatus(n, e, t = null) {
    const a = document.getElementById("m-keyStatus"),
        i = document.getElementById("m-keyStatusText"),
        o = document.getElementById("box-apikey");
    if (a && i && o)
        if (
            ((a.className = `m-key-status ${n}`),
            (i.innerText = e),
            (mDebridValidationState.status = n),
            o.classList.remove("is-valid", "is-invalid", "is-checking"),
            "valid" === n && o.classList.add("is-valid"),
            "invalid" === n && o.classList.add("is-invalid"),
            "checking" === n && o.classList.add("is-checking"),
            t?.titleParts?.length)
        ) {
            const n = t.titleParts.filter(Boolean);
            a.title = n.join(" | ");
        } else a.removeAttribute("title");
}
async function runMobileDebridValidation(n, e, t) {
    try {
        const a = await fetch("/api/debrid/validate", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ service: e, key: t }),
            }),
            i = await a.json().catch(() => null);
        if (n !== mDebridValidationState.requestId) return;
        if (
            ((mDebridValidationState.resolvedKey = t),
            (mDebridValidationState.resolvedService = e),
            a.ok && i?.ok)
        ) {
            const n = getMobileValidationServiceMeta(e),
                t = formatMobileValidationExpiration(i.expiration);
            let a = `Token ${n.name} valido.`;
            const o = [n.name];
            return (
                "rd" === e &&
                    i.username &&
                    ((a = `Token RD valido | ${i.username}`), o.push(`Account ${i.username}`)),
                "tb" === e &&
                    Number.isFinite(Number(i.items)) &&
                    ((a = `Token TorBox valido | ${Number(i.items)} item cloud`),
                    o.push(`Item cloud ${Number(i.items)}`)),
                t && ((a += ` | ${t}`), o.push(`Scadenza ${t}`)),
                void setMobileDebridValidationStatus("valid", a, { titleParts: o })
            );
        }
        const o = String(i?.code || "").toLowerCase();
        if ("invalid_token" === o)
            return void setMobileDebridValidationStatus(
                "invalid",
                "tb" === e
                    ? "Token TorBox non valido o scaduto."
                    : "Token RD non valido o scaduto.",
            );
        if ("unsupported_service" === o)
            return void setMobileDebridValidationStatus(
                "idle",
                "Live check disponibile solo per RD e TB.",
            );
        setMobileDebridValidationStatus("warning", i?.message || "Verifica non disponibile.");
    } catch (a) {
        if (n !== mDebridValidationState.requestId) return;
        ((mDebridValidationState.resolvedKey = t),
            (mDebridValidationState.resolvedService = e),
            setMobileDebridValidationStatus("warning", "Verifica non disponibile."));
    }
}
function scheduleMobileDebridValidation(n = {}) {
    const e = !0 === n.force,
        t = mValue("m-apiKey").trim(),
        a = String(mCurrentService || "")
            .trim()
            .toLowerCase();
    if ((clearMobileDebridValidationTimer(), (mDebridValidationState.requestId += 1), "p2p" === a))
        return void setMobileDebridValidationStatus("idle", "P2P attivo: nessuna key richiesta.");
    if (!["rd", "tb"].includes(a))
        return void setMobileDebridValidationStatus(
            "idle",
            "Live check disponibile solo per RD e TB.",
        );
    const i = getMobileValidationServiceMeta(a);
    if (!t)
        return void setMobileDebridValidationStatus(
            "idle",
            `Incolla una key ${i.code} per la verifica live.`,
        );
    if (t.length < 8)
        return void setMobileDebridValidationStatus(
            "idle",
            `Completa la key ${i.code} per la verifica.`,
        );
    if (
        !e &&
        mDebridValidationState.resolvedService === a &&
        mDebridValidationState.resolvedKey === t &&
        ["valid", "invalid", "warning"].includes(mDebridValidationState.status)
    )
        return;
    const o = mDebridValidationState.requestId;
    (setMobileDebridValidationStatus("checking", `Verifica token ${i.name}...`),
        (mDebridValidationState.timer = setTimeout(() => {
            runMobileDebridValidation(o, a, t);
        }, 650)));
}
function handleMobileApiKeyInput() {
    (scheduleMobileDebridValidation(), updateLinkModalContent());
}
function setMService(n, e, t = !1) {
    if (mCurrentService === n && !t) return;
    ((mCurrentService = n),
        t || mSetValue("m-apiKey", ""),
        document.querySelectorAll(".m-srv-btn").forEach((n) => {
            n.classList.remove("active");
        }),
        e && e.classList.add("active"));
    const a = document.getElementById("m-apiKey"),
        i = document.getElementById("box-apikey");
    (a &&
        ("p2p" === n
            ? (mSetPlaceholder("m-apiKey", "P2P attivo"),
              mSetDisabled("m-apiKey", !0),
              i && i.classList.add("is-p2p"))
            : (mSetPlaceholder(
                  "m-apiKey",
                  { rd: "Incolla RD key", tb: "Incolla TB key" }[n] || "Incolla API key",
              ),
              mSetDisabled("m-apiKey", !1),
              i && i.classList.remove("is-p2p"))),
        updateMobilePreview(),
        scheduleMobileDebridValidation({ force: !0 }),
        toggleSavedCloud(),
        updateLinkModalContent(),
        mVibrate(10));
}
function updateStatus(n, e) {
    const t = mChecked(n),
        a = document.getElementById(e);
    (a && ((a.innerText = t ? "ON" : "OFF"), a.classList.toggle("on", t)),
        "m-enableVix" === n && toggleScOptions(),
        "m-aioMode" === n && toggleMobileAIOLock(),
        checkWebPriorityVisibility(),
        updateLinkModalContent(),
        mVibrate(10));
}
function setLangMode(n) {
    mLangMode = ["ita", "all", "eng"].includes(n) ? n : "ita";
    const e = document.getElementById("lang-ita"),
        t = document.getElementById("lang-all"),
        a = document.getElementById("lang-eng");
    ([e, t, a].forEach((n) => {
        n && (n.className = "m-lang-opt");
    }),
        "ita" === mLangMode && e && e.classList.add("active-ita"),
        "all" === mLangMode && t && t.classList.add("active-hyb"),
        "eng" === mLangMode && a && a.classList.add("active-eng"));
    const i = document.getElementById("lang-description");
    (i &&
        ((i.style.opacity = "0"),
        setTimeout(() => {
            ((i.innerText = langDescriptions[mLangMode] || langDescriptions.ita),
                (i.style.opacity = "1"));
        }, 200)),
        updateMobilePreview(),
        updateLinkModalContent(),
        mVibrate(10));
}
function checkWebPriorityVisibility() {
    const n = [
            "m-enableVix",
            "m-enableGhd",
            "m-enableGs",
            "m-enableVidxgo",
            "m-enableEs",
            "m-enableCb01",
            "m-enableOnlineserietv",
            "m-enableAnimeWorld",
            "m-enableAnimeUnity",
            "m-enableAnimeSaturn",
            "m-enableToonItalia",
            "m-enableGf",
        ].some((n) => mChecked(n)),
        e = document.getElementById("m-priority-panel");
    e && e.classList.toggle("show", n);
}
function updatePriorityLabel() {
    const n = mChecked("m-vixLast"),
        e = document.getElementById("priority-desc");
    (e &&
        ((e.innerText = n
            ? "Priorita bassa: risultati dopo i torrent"
            : "Priorita alta: risultati in cima"),
        (e.style.color = n ? "var(--m-secondary)" : "var(--m-primary)")),
        updateLinkModalContent(),
        mVibrate([15, 10, 15]));
}
function setSavedCloudMode(n) {
    ((mSavedCloudMode = ["smart", "fallback", "always"].includes(n) ? n : "smart"),
        document
            .querySelectorAll(".m-cloud-mode-btn")
            .forEach((n) => n.classList.remove("active")));
    const e = document.getElementById("m-cloud-" + mSavedCloudMode);
    (e && e.classList.add("active"), updateLinkModalContent(), mVibrate(8));
}
function toggleSavedCloud() {
    const n = document.getElementById("m-enableSavedCloud"),
        e = document.getElementById("m-savedCloudPanel"),
        t = document.getElementById("st-savedcloud");
    if (!n || !e || !t) return;
    const a = mChecked("m-enableSavedCloud");
    (e.classList.toggle("show", a),
        (t.innerText = a ? "ON" : "OFF"),
        t.classList.toggle("on", a),
        a &&
            "p2p" === mCurrentService &&
            showToast("Debrid Cloud richiede RD o TorBox, non P2P.", "warning"),
        updateLinkModalContent(),
        mVibrate(10));
}
function toggleScOptions() {
    mScQuality = "1080";
    const n = mChecked("m-enableVix"),
        e = document.getElementById("st-vix");
    (e && ((e.innerText = n ? "ON" : "OFF"), e.classList.toggle("on", n)),
        checkWebPriorityVisibility());
}
function toggleGate() {
    const n = mChecked("m-gateActive"),
        e = document.getElementById("m-gate-wrapper"),
        t = document.getElementById("st-gate");
    (e && e.classList.toggle("show", n),
        t && ((t.innerText = n ? "ON" : "OFF"), t.classList.toggle("on", n)),
        n && showToast("Signal Gate Attivo: Risultati Limitati", "warning"),
        updateLinkModalContent(),
        mVibrate(10));
}
function updateGateDisplay(n) {
    (mSetText("m-gate-display", n), updateLinkModalContent());
}
function toggleSize() {
    const n = mChecked("m-sizeActive"),
        e = document.getElementById("m-size-wrapper"),
        t = document.getElementById("st-size"),
        a = mValue("m-sizeVal", "0");
    (e && e.classList.toggle("show", n),
        t && ((t.innerText = n ? "ON" : "OFF"), t.classList.toggle("on", n)),
        n ? updateSizeDisplay(a) : mSetText("m-size-display", "INF"),
        updateLinkModalContent(),
        mVibrate(10));
}
function updateSizeDisplay(n) {
    const e = document.getElementById("m-size-display");
    (e && (e.innerText = 0 == n ? "INF" : String(n)), updateLinkModalContent());
}
function openApiPage(n) {
    if ("tmdb" === n) return void window.open("https://www.themoviedb.org/settings/api", "_blank");
    const e = { rd: "https://real-debrid.com/apitoken", tb: "https://torbox.app/settings" };
    e[mCurrentService] && window.open(e[mCurrentService], "_blank");
}
function setScQuality() {
    ((mScQuality = "1080"), updateLinkModalContent(), mVibrate(10));
}
function setSortMode(n) {
    ((mSortMode = fluxData[n] ? n : "balanced"),
        ["balanced", "resolution", "size"].forEach((n) => {
            const e = document.getElementById("sort-" + n);
            e &&
                (e.classList.remove("active-bal", "active-res", "active-sz"),
                n === mSortMode &&
                    e.classList.add(
                        { balanced: "active-bal", resolution: "active-res", size: "active-sz" }[n],
                    ));
        }));
    const e = document.getElementById("flux-readout-box"),
        t = document.getElementById("flux-title-display"),
        a = document.getElementById("flux-desc-display"),
        i = document.getElementById("flux-icon-display");
    (e && ((e.className = "m-flux-readout"), (e.style.opacity = "0.5")),
        setTimeout(() => {
            const n = fluxData[mSortMode] || fluxData.balanced;
            (e &&
                ("balanced" === mSortMode && e.classList.add("mode-bal"),
                "resolution" === mSortMode && e.classList.add("mode-res"),
                "size" === mSortMode && e.classList.add("mode-sz"),
                (e.style.opacity = "1")),
                t && (t.innerText = n.title),
                a && (a.innerText = n.desc),
                i && (i.className = `fas ${n.icon} m-fr-icon`));
        }, 150),
        updateLinkModalContent(),
        mVibrate(10));
}
function updateGhostVisuals() {
    const n = mChecked("m-proxyDebrid"),
        e = document.getElementById("ghost-zone-box"),
        t = document.getElementById("ghost-status-text");
    (e && e.classList.toggle("active", n), t && (t.innerText = n ? "STEALTH" : "VISIBLE"));
    const a = document.getElementById("st-ghost");
    (a && ((a.innerText = n ? "ON" : "OFF"), a.classList.toggle("on", n)), mVibrate(15));
}
function toggleModuleStyle(n, e) {
    const t = mChecked(n),
        a = document.getElementById(e);
    (a && a.classList.toggle("active", t), updateLinkModalContent());
}
function toggleFilter(n) {
    const e = document.getElementById(n);
    e &&
        (e.classList.toggle("excluded"),
        e.classList.contains("excluded") && (mVibrate(20), triggerPreviewUpdateEffect()),
        updateLinkModalContent());
}
async function pasteTo(n) {
    const e = document.getElementById(n);
    if (!(!e || ("disabled" in e && e.disabled)))
        try {
            (mSetValue(n, await navigator.clipboard.readText()),
                e.dispatchEvent(new Event("input", { bubbles: !0 })),
                "m-apiKey" === n && scheduleMobileDebridValidation({ force: !0 }),
                updateLinkModalContent());
            const t = e.closest(".m-if-inner") || e.closest(".m-input-box") || e.parentElement;
            let a = t?.querySelector?.(".m-if-action") || t?.querySelector?.(".m-paste-action");
            if (a) {
                const n = a.innerHTML;
                ((a.innerHTML = '<i class="fas fa-check"></i>'),
                    setTimeout(() => {
                        a.innerHTML = n;
                    }, 900));
            }
            (e.focus({ preventScroll: !0 }), showToast("INCOLLATO", "success"));
        } catch (e) {
            const t = document.getElementById(n);
            (t && t.focus({ preventScroll: !1 }),
                showToast("APPUNTI BLOCCATI: INCOLLA MANUALMENTE", "warning"));
        }
}
const LEVIATHAN_MOBILE_CONFIG_TOKEN_PREFIX = "lcfg1_";
function decodeMobileBase64UrlToBytes(n) {
    const e = String(n || "")
            .trim()
            .replace(/-/g, "+")
            .replace(/_/g, "/"),
        t = e + "=".repeat((4 - (e.length % 4)) % 4),
        a = atob(t),
        i = new Uint8Array(a.length);
    for (let n = 0; n < a.length; n++) i[n] = a.charCodeAt(n);
    return i;
}
function decodeMobileBase64UrlToUtf8(n) {
    return new TextDecoder().decode(decodeMobileBase64UrlToBytes(n));
}
function encodeMobileConfigToPathToken(n) {
    const e = JSON.stringify(n || {}),
        t = new TextEncoder().encode(e);
    let a = "";
    return (
        t.forEach((n) => {
            a += String.fromCharCode(n);
        }),
        btoa(a).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "")
    );
}
function normalizeMobileConfigPathToken(n) {
    try {
        return decodeURIComponent(String(n || "").trim());
    } catch (e) {
        return String(n || "").trim();
    }
}
function extractMobileConfigTokenFromUrlLike(n) {
    const e = normalizeMobileConfigPathToken(n);
    if (!e) return null;
    try {
        const n = e.replace(/^stremio:\/\//i, `${window.location.protocol}//`),
            t = new URL(n, window.location.origin).pathname
                .split("/")
                .filter(Boolean)
                .find((n) => n.length > 10 && !/^(?:configure|manifest\.json)$/i.test(n));
        if (t) return t;
    } catch (n) {}
    const t =
        e.match(/\/([^\/?#]{11,})\/(?:manifest\.json|configure)(?:$|[?#])/i) ||
        e.match(/^([^\/?#]{11,})$/i);
    return t ? t[1] : null;
}
function getMobileConfigTokenFromLocation() {
    const n = window.location.pathname
        .split("/")
        .filter(Boolean)
        .find((n) => n.length > 10 && !/^(?:configure|manifest\.json)$/i.test(n));
    if (n) return n;
    const e = new URLSearchParams(window.location.search || ""),
        t = [
            "conf",
            "config",
            "token",
            "configToken",
            "manifest",
            "manifestUrl",
            "addon",
            "addonUrl",
            "url",
        ];
    for (const n of t) {
        const t = extractMobileConfigTokenFromUrlLike(e.get(n));
        if (t) return t;
    }
    return extractMobileConfigTokenFromUrlLike(
        String(window.location.hash || "").replace(/^#/, ""),
    );
}
async function fetchMobileConfigForEditor(n) {
    const e = await fetch("/api/config/decode", {
        method: "POST",
        cache: "no-store",
        headers: { Accept: "application/json", "Content-Type": "application/json" },
        body: JSON.stringify({ token: n }),
    });
    if (!e.ok) throw new Error(`decode_http_${e.status}`);
    const t = await e.json();
    if (!t || !0 !== t.ok || !t.config) throw new Error("decode_bad_payload");
    return t.config;
}
async function loadMobileConfigFromPathToken(n) {
    const e = normalizeMobileConfigPathToken(n);
    if (!e || "configure" === e || "manifest.json" === e) return null;
    if (/^lcfg1_/i.test(e)) return fetchMobileConfigForEditor(e);
    try {
        return JSON.parse(decodeMobileBase64UrlToUtf8(e));
    } catch (n) {
        return fetchMobileConfigForEditor(e);
    }
}
async function loadMobileConfig() {
    try {
        const n = getMobileConfigTokenFromLocation();
        if (n) {
            const e = await loadMobileConfigFromPathToken(n);
            if (!e) throw new Error("empty_mobile_config_token");
            if (e.service) {
                const n = { rd: 0, tb: 1 },
                    t = document.querySelectorAll("#page-setup .m-srv-btn");
                t.length > 0 &&
                    void 0 !== n[e.service] &&
                    setMService(e.service, t[n[e.service]], !0);
            } else
                e.filters &&
                    e.filters.enableP2P &&
                    setMService("p2p", document.querySelectorAll("#page-setup .m-srv-btn")[2], !0);
            if (
                (e.key && mSetValue("m-apiKey", e.key),
                e.tmdb && mSetValue("m-tmdb", e.tmdb),
                e.aiostreams_mode && mSetChecked("m-aioMode", !0),
                e.sort ? setSortMode(e.sort) : setSortMode("balanced"),
                e.formatter && selectMobileSkin(e.formatter),
                e.customTemplate && mSetValue("m-customTemplate", e.customTemplate),
                e.customNameTemplate && mSetValue("m-customNameTemplate", e.customNameTemplate),
                e.filters)
            ) {
                const n = (n) => (Array.isArray(n) ? n.join(", ") : n || "");
                (e.filters.streamExpression &&
                    mSetValue("m-streamExpression", e.filters.streamExpression),
                    e.filters.preferredResolutions &&
                        mSetValue("m-preferredResolutions", n(e.filters.preferredResolutions)),
                    e.filters.preferredLanguages &&
                        mSetValue("m-preferredLanguages", n(e.filters.preferredLanguages)),
                    (e.filters.preferredQualities || e.filters.preferredVisualTags) &&
                        mSetValue(
                            "m-preferredQualities",
                            n(e.filters.preferredQualities || e.filters.preferredVisualTags),
                        ),
                    e.filters.preferredHdr &&
                        mSetValue("m-preferredHdr", n(e.filters.preferredHdr)));
            }
            if (
                (e.mediaflow &&
                    (mSetValue("m-mfUrl", e.mediaflow.url || ""),
                    mSetValue("m-mfPass", e.mediaflow.pass || ""),
                    mSetChecked("m-proxyDebrid", e.mediaflow.proxyDebrid || !1)),
                e.filters)
            ) {
                (mSetChecked("m-enableVix", e.filters.enableVix || !1),
                    toggleModuleStyle("m-enableVix", "mod-vix"),
                    mSetChecked("m-enableGhd", e.filters.enableGhd || !1),
                    toggleModuleStyle("m-enableGhd", "mod-ghd"),
                    mSetChecked("m-enableGs", e.filters.enableGs || !1),
                    toggleModuleStyle("m-enableGs", "mod-gs"),
                    mSetChecked("m-enableVidxgo", e.filters.enableVidxgo || !1),
                    toggleModuleStyle("m-enableVidxgo", "mod-vidxgo"),
                    mSetChecked("m-enableEs", e.filters.enableEs || !1),
                    toggleModuleStyle("m-enableEs", "mod-es"),
                    mSetChecked("m-enableCb01", e.filters.enableCb01 || !1),
                    toggleModuleStyle("m-enableCb01", "mod-cb01"),
                    mSetChecked("m-enableOnlineserietv", e.filters.enableOnlineserietv || !1),
                    toggleModuleStyle("m-enableOnlineserietv", "mod-onlineserietv"),
                    mSetChecked("m-enableAnimeWorld", e.filters.enableAnimeWorld || !1),
                    toggleModuleStyle("m-enableAnimeWorld", "mod-aw"),
                    mSetChecked("m-enableAnimeUnity", e.filters.enableAnimeUnity || !1),
                    toggleModuleStyle("m-enableAnimeUnity", "mod-au"),
                    mSetChecked("m-enableAnimeSaturn", e.filters.enableAnimeSaturn || !1),
                    toggleModuleStyle("m-enableAnimeSaturn", "mod-as"),
                    mSetChecked("m-enableToonItalia", e.filters.enableToonItalia || !1),
                    toggleModuleStyle("m-enableToonItalia", "mod-ti"),
                    mSetChecked("m-enableGf", e.filters.enableGf || !1),
                    toggleModuleStyle("m-enableGf", "mod-gf"),
                    e.filters.language
                        ? setLangMode(e.filters.language)
                        : setLangMode(e.filters.allowEng ? "all" : "ita"),
                    mSetChecked("m-enableSavedCloud", e.filters.enableSavedCloud || !1),
                    setSavedCloudMode(e.filters.savedCloudMode || "smart"),
                    toggleSavedCloud(),
                    e.filters.vixLast && (mSetChecked("m-vixLast", !0), updatePriorityLabel()));
                const n = { no4k: "mq-4k", no1080: "mq-1080", no720: "mq-720", noScr: "mq-sd" };
                for (let t in n) e.filters[t] && mAddClass(n[t], "excluded");
                if (
                    (setScQuality("1080"), e.filters.maxPerQuality && e.filters.maxPerQuality > 0)
                ) {
                    const n = e.filters.maxPerQuality;
                    (mSetChecked("m-gateActive", !0),
                        mSetValue("m-gateVal", n),
                        updateGateDisplay(n),
                        toggleGate());
                } else (mSetChecked("m-gateActive", !1), toggleGate());
                if (e.filters.maxSizeGB && e.filters.maxSizeGB > 0) {
                    const n = e.filters.maxSizeGB;
                    (mSetChecked("m-sizeActive", !0),
                        mSetValue("m-sizeVal", n),
                        updateSizeDisplay(n),
                        toggleSize());
                } else (mSetChecked("m-sizeActive", !1), toggleSize());
            }
            (updateStatus("m-enableVix", "st-vix"),
                updateStatus("m-enableGhd", "st-ghd"),
                updateStatus("m-enableGs", "st-gs"),
                updateStatus("m-enableVidxgo", "st-vidxgo"),
                updateStatus("m-enableEs", "st-es"),
                updateStatus("m-enableCb01", "st-cb01"),
                updateStatus("m-enableOnlineserietv", "st-onlineserietv"),
                updateStatus("m-enableAnimeWorld", "st-aw"),
                updateStatus("m-enableAnimeUnity", "st-au"),
                updateStatus("m-enableAnimeSaturn", "st-as"),
                updateStatus("m-enableToonItalia", "st-ti"),
                updateStatus("m-enableGf", "st-gf"),
                updateStatus("m-aioMode", "st-aio"),
                toggleSavedCloud(),
                updateGhostVisuals(),
                toggleScOptions(),
                checkWebPriorityVisibility(),
                toggleMobileAIOLock(),
                updateMobilePreview(),
                scheduleMobileDebridValidation({ force: !0 }),
                updateLinkModalContent());
        }
    } catch (n) {
        console.log("No config loaded");
    }
}
function getMobileConfig() {
    const n = mChecked("m-gateActive"),
        e = parseInt(mValue("m-gateVal", "0"), 10) || 0,
        t = mChecked("m-sizeActive"),
        a = parseInt(mValue("m-sizeVal", "0"), 10) || 0,
        i = t ? a : 0,
        o = "p2p" === mCurrentService,
        r = mValue("m-apiKey").trim(),
        s =
            !o &&
            !r &&
            [
                "m-enableVix",
                "m-enableGhd",
                "m-enableGs",
                "m-enableVidxgo",
                "m-enableEs",
                "m-enableCb01",
                "m-enableOnlineserietv",
                "m-enableAnimeWorld",
                "m-enableAnimeUnity",
                "m-enableAnimeSaturn",
                "m-enableToonItalia",
                "m-enableGf",
                ].some((n) => mChecked(n)),
        l =
            !o &&
            !!r &&
            ["rd", "tb"].includes(String(mCurrentService || "").toLowerCase()) &&
            mChecked("m-enableSavedCloud"),
        m = (n) =>
            mValue(n)
                .split(",")
                .map((n) => n.trim())
                .filter(Boolean),
        d = {},
        c = mValue("m-streamExpression").trim();
    c && (d.streamExpression = c);
    const p = m("m-preferredResolutions");
    p.length && (d.preferredResolutions = p);
    const g = m("m-preferredLanguages");
    g.length && (d.preferredLanguages = g);
    const u = m("m-preferredQualities");
    u.length && (d.preferredQualities = u);
    const b = m("m-preferredHdr");
    b.length && (d.preferredHdr = b);
    const f = mValue("m-customNameTemplate").trim();
    return {
        service: o ? "" : s ? "web" : mCurrentService,
        key: r,
        tmdb: mValue("m-tmdb").trim(),
        sort: mSortMode,
        formatter: mSkin,
        customTemplate: mValue("m-customTemplate"),
        ...(f ? { customNameTemplate: f } : {}),
        aiostreams_mode: mChecked("m-aioMode"),
        mediaflow: {
            url: mValue("m-mfUrl").trim().replace(/\/$/, ""),
            pass: mValue("m-mfPass").trim(),
            proxyDebrid: mChecked("m-proxyDebrid"),
        },
        filters: {
            language: mLangMode,
            allowEng: "all" === mLangMode || "eng" === mLangMode,
            enableP2P: o,
            no4k: mHasClass("mq-4k", "excluded"),
            no1080: mHasClass("mq-1080", "excluded"),
            no720: mHasClass("mq-720", "excluded"),
            noScr: mHasClass("mq-sd", "excluded"),
            noCam: mHasClass("mq-sd", "excluded"),
            enableVix: mChecked("m-enableVix"),
            enableGhd: mChecked("m-enableGhd"),
            enableGs: mChecked("m-enableGs"),
            enableVidxgo: mChecked("m-enableVidxgo"),
            enableEs: mChecked("m-enableEs"),
            enableCb01: mChecked("m-enableCb01"),
            enableOnlineserietv: mChecked("m-enableOnlineserietv"),
            enableAnimeWorld: mChecked("m-enableAnimeWorld"),
            enableAnimeUnity: mChecked("m-enableAnimeUnity"),
            enableAnimeSaturn: mChecked("m-enableAnimeSaturn"),
            enableToonItalia: mChecked("m-enableToonItalia"),
            enableGf: mChecked("m-enableGf"),
            enableTrailers: !1,
            enableSavedCloud: l,
            savedCloudMode: l ? mSavedCloudMode : "off",
            savedCloudMax: 6,
            vixLast: mChecked("m-vixLast"),
            scQuality: "1080",
            maxPerQuality: n ? e : 0,
            maxSizeGB: i > 0 ? i : null,
            ...d,
        },
    };
}
function getMobileLegacyManifestUrl(n) {
    return `${window.location.host}/${encodeMobileConfigToPathToken(n)}/manifest.json`;
}
async function getMobileManifestUrl(n) {
    return getMobileLegacyManifestUrl(n);
}
let _linkModalTimer = 0;
function setGeneratedLinkBoxesValue(n, e = "primary") {
    ["m-generatedUrlBox", "m-setupGeneratedUrlBox"].forEach((t) => {
        const a = document.getElementById(t);
        a &&
            ("value" in a && (a.value = n),
            (a.style.color = "error" === e ? "var(--m-error)" : "var(--m-primary)"));
    });
}
async function updateLinkModalContent(n = !1) {
    if (!n)
        return (
            clearTimeout(_linkModalTimer),
            void (_linkModalTimer = setTimeout(() => updateLinkModalContent(!0), 380))
        );
    const e = getMobileConfig(),
        t =
            e.filters.enableVix ||
            e.filters.enableGhd ||
            e.filters.enableGs ||
            e.filters.enableVidxgo ||
            e.filters.enableEs ||
            e.filters.enableCb01 ||
            e.filters.enableOnlineserietv ||
            e.filters.enableAnimeWorld ||
            e.filters.enableAnimeUnity ||
            e.filters.enableAnimeSaturn ||
            e.filters.enableToonItalia ||
            e.filters.enableGf ||
            e.filters.enableP2P;
    e.key || t
        ? setGeneratedLinkBoxesValue(
              `${window.location.protocol}//${await getMobileManifestUrl(e)}`,
              "primary",
          )
        : setGeneratedLinkBoxesValue(
              "/// SYSTEM OFFLINE: WAITING FOR CONFIGURATION DATA ///\n[!] Inserisci API Key o Attiva Sorgenti Web/P2P",
              "error",
          );
}
async function copyGeneratedLinkValue(n, e = !1) {
    const t = String(n || "");
    if (!t) return !1;
    if (t.includes("WAITING FOR") || t.includes("SYSTEM OFFLINE"))
        return (showToast("CONFIGURA PRIMA L'ADDON", "error"), !1);
    try {
        if (navigator.clipboard && navigator.clipboard.writeText)
            await navigator.clipboard.writeText(t);
        else {
            const n = document.createElement("textarea");
            (document.body.appendChild(n),
                (n.value = t),
                n.select(),
                document.execCommand("copy"),
                document.body.removeChild(n));
        }
        return (e && closeLinkModal(), showToast("LINK COPIATO NEGLI APPUNTI", "success"), !0);
    } catch (n) {
        return (showToast("ERRORE COPIA MANUALE", "error"), !1);
    }
}
async function mobileInstall() {
    const n = getMobileConfig(),
        e =
            n.filters.enableVix ||
            n.filters.enableGhd ||
            n.filters.enableGs ||
            n.filters.enableVidxgo ||
            n.filters.enableEs ||
            n.filters.enableCb01 ||
            n.filters.enableOnlineserietv ||
            n.filters.enableAnimeWorld ||
            n.filters.enableAnimeUnity ||
            n.filters.enableAnimeSaturn ||
            n.filters.enableToonItalia ||
            n.filters.enableGf ||
            n.filters.enableP2P;
    if (!n.key && !e) return void showToast("ERRORE: API KEY MANCANTE", "error");
    const t = await getMobileManifestUrl(n);
    window.location.href = `stremio://${t}`;
}
function openLinkModal() {
    updateLinkModalContent(!0);
    const n = document.getElementById("m-link-modal");
    (n && n.classList.add("show"), mVibrate(10));
}
function closeLinkModal() {
    const n = document.getElementById("m-link-modal");
    n && n.classList.remove("show");
}
async function copyFromSetupPanel() {
    updateLinkModalContent(!0);
    const n = document.getElementById("m-setupGeneratedUrlBox"),
        e = n && "value" in n ? String(n.value || "") : "";
    await copyGeneratedLinkValue(e, !1);
}
async function copyFromModal() {
    const n = document.getElementById("m-generatedUrlBox"),
        e = n && "value" in n ? String(n.value || "") : "";
    await copyGeneratedLinkValue(e, !0);
}
function exposeMobileInlineHandlers() {
    "undefined" != typeof window &&
        Object.assign(window, {
            navTo: navTo,
            selectMobileSkin: selectMobileSkin,
            updateMobilePreview: updateMobilePreview,
            toggleMobileAIOLock: toggleMobileAIOLock,
            setMService: setMService,
            handleMobileApiKeyInput: handleMobileApiKeyInput,
            scheduleMobileDebridValidation: scheduleMobileDebridValidation,
            updateStatus: updateStatus,
            setLangMode: setLangMode,
            checkWebPriorityVisibility: checkWebPriorityVisibility,
            updatePriorityLabel: updatePriorityLabel,
            setSavedCloudMode: setSavedCloudMode,
            toggleSavedCloud: toggleSavedCloud,
            toggleScOptions: toggleScOptions,
            toggleGate: toggleGate,
            updateGateDisplay: updateGateDisplay,
            toggleSize: toggleSize,
            updateSizeDisplay: updateSizeDisplay,
            openApiPage: openApiPage,
            setScQuality: setScQuality,
            setSortMode: setSortMode,
            updateGhostVisuals: updateGhostVisuals,
            toggleModuleStyle: toggleModuleStyle,
            toggleFilter: toggleFilter,
            pasteTo: pasteTo,
            getMobileConfig: getMobileConfig,
            getMobileManifestUrl: getMobileManifestUrl,
            updateLinkModalContent: updateLinkModalContent,
            mobileInstall: mobileInstall,
            openLinkModal: openLinkModal,
            closeLinkModal: closeLinkModal,
            copyFromModal: copyFromModal,
            copyFromSetupPanel: copyFromSetupPanel,
        });
}
function startMobileInterfaceWhenReady() {
    exposeMobileInlineHandlers();
    const n = () => initMobileInterface();
    "loading" === document.readyState
        ? document.addEventListener("DOMContentLoaded", n, { once: !0 })
        : n();
}
(startMobileInterfaceWhenReady(),
    (function n() {
        try {
            if ("loading" === document.readyState)
                return void document.addEventListener("DOMContentLoaded", n, { once: !0 });
            (document.getElementById("app-container") || (document.body.innerHTML = mobileHTML),
                document.body.classList.add("m-ui-ready"));
        } catch (n) {}
    })());
