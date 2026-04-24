const MOBILE_LOGO_URL = "https://i.ibb.co/MbmdvP6/file-0000000018387243a2da8535139f6423.png";
const MOBILE_LOGO_HINTS_ID = "leviathan-mobile-logo-hints";
const MOBILE_LOGO_PRELOAD_ID = "leviathan-mobile-logo-preload";

function ensureMobileLogoHints() {
    try {
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

        let preload = document.getElementById(MOBILE_LOGO_PRELOAD_ID);
        if (!preload) {
            preload = document.createElement("link");
            preload.id = MOBILE_LOGO_PRELOAD_ID;
            preload.rel = "preload";
            preload.as = "image";
            preload.href = MOBILE_LOGO_URL;
            preload.fetchPriority = "high";
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

    if (img.complete) {
        markLoaded();
        return;
    }

    img.setAttribute("data-loading", "1");
    img.addEventListener("load", markLoaded, { once: true });
    img.addEventListener("error", () => img.removeAttribute("data-loading"), { once: true });
}

function applyMobilePerformanceMode() {
    try {
        const cores = navigator.hardwareConcurrency || 0;
        const memory = navigator.deviceMemory || 0;
        const lowFx = (cores && cores <= 4) || (memory && memory <= 4);
        document.body.classList.toggle("m-lowfx", !!lowFx);
    } catch (_) {}
}

const mobileCSS = `
:root {
    --m-bg: #000205;
    --m-bg-deep: #00060c;
    --m-primary: #00f2ff;     /* Ciano Leviathan */
    --m-primary-dim: rgba(0, 242, 255, 0.18);
    --m-secondary: #7000ff;   /* Viola Abisso */
    --m-accent: #b026ff;
    --m-amber: #ffcc00;       /* Gold P2P Warning */
    --m-orange: #ff6600;      /* Blaze Orange (AnimeWorld) */
    --m-cine: #ff0055;
    --m-kofi: #FF5E5B;
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

/* --- CUSTOM THIN SCROLLBAR --- */
* { scrollbar-width: thin; scrollbar-color: rgba(0, 242, 255, 0.4) transparent; }
::-webkit-scrollbar { width: 3px; height: 3px; }
::-webkit-scrollbar-track { background: transparent; }
::-webkit-scrollbar-thumb { background: rgba(0, 242, 255, 0.4); border-radius: 10px; }
::-webkit-scrollbar-thumb:active { background: var(--m-primary); }

/* --- DEEP SEA BACKGROUND --- */
body {
    margin: 0;
    background:
        radial-gradient(ellipse at 50% -10%, rgba(0, 242, 255, 0.18) 0%, rgba(0, 242, 255, 0.04) 22%, transparent 50%),
        radial-gradient(circle at 88% 82%, rgba(112, 0, 255, 0.16) 0%, transparent 38%),
        radial-gradient(circle at 12% 60%, rgba(0, 242, 255, 0.08) 0%, transparent 38%),
        linear-gradient(180deg, #050b14 0%, #02060c 45%, #000205 100%);
    font-family: 'Outfit', sans-serif;
    color: var(--m-text);
    width: 100%;
    height: 100%;
    overscroll-behavior: none;
    overflow: hidden;
}

/* Subtle CRT scan layer */
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
    opacity: 0.45;
    mix-blend-mode: overlay;
}

/* Faint blueprint grid */
body::before {
    content: ''; position: fixed; top: 0; left: 0; width: 100%; height: 100%; z-index: -10;
    background-image:
        linear-gradient(rgba(0, 242, 255, 0.07) 1px, transparent 1px),
        linear-gradient(90deg, rgba(0, 242, 255, 0.07) 1px, transparent 1px);
    background-size: 44px 44px;
    pointer-events: none;
    mask-image: radial-gradient(circle at 50% 30%, black 25%, rgba(0,0,0,0.4) 75%, transparent 100%);
    -webkit-mask-image: radial-gradient(circle at 50% 30%, black 25%, rgba(0,0,0,0.4) 75%, transparent 100%);
    animation: gridDrift 80s linear infinite;
}
@keyframes gridDrift { from { background-position: 0 0; } to { background-position: 44px 44px; } }

/* Floating ocean particles */
.m-ocean-particles { position: fixed; top: 0; left: 0; width: 100%; height: 100%; pointer-events: none; z-index: -5; overflow: hidden; }
.m-ocean-particle {
    position: absolute; bottom: -10px;
    width: 3px; height: 3px; border-radius: 50%;
    background: radial-gradient(circle, rgba(0, 242, 255, 0.85) 0%, rgba(0, 242, 255, 0.15) 60%, transparent 100%);
    box-shadow: 0 0 6px rgba(0, 242, 255, 0.5);
    opacity: 0;
    animation: oceanFloat 18s linear infinite;
}
@keyframes oceanFloat {
    0% { transform: translate3d(0, 0, 0) scale(0.6); opacity: 0; }
    12% { opacity: 0.7; }
    88% { opacity: 0.5; }
    100% { transform: translate3d(8px, -110vh, 0) scale(1.2); opacity: 0; }
}

#app-container { 
    display: flex; flex-direction: column; height: 100dvh; width: 100%; max-width: 100%; position: relative; overflow: hidden; 
}

.m-content-wrapper { 
    flex: 1; display: flex; flex-direction: column; min-height: 0; position: relative; overflow: hidden; z-index: 5; 
}

.m-content {
    flex: 1; overflow-y: auto; overflow-x: hidden;
    padding: 0 14px 150px 14px; width: 100%;
    -webkit-overflow-scrolling: touch;
    scroll-behavior: smooth;
}

/* --- SECTION HEADER (Leviathan signature) --- */
.m-section-head {
    display: flex; align-items: center; justify-content: space-between;
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
.m-section-head .sh-tag.warn { color: var(--m-amber); border-color: rgba(255, 204, 0, 0.4); background: rgba(255, 204, 0, 0.06); }
.m-section-head .sh-tag.violet { color: var(--m-secondary); border-color: rgba(112, 0, 255, 0.4); background: rgba(112, 0, 255, 0.06); }

/* --- FIX PTR Z-INDEX --- */
.m-ptr {
    position: absolute; top: -70px; left: 0; width: 100%; height: 70px;
    display: flex; align-items: flex-end; justify-content: center;
    padding-bottom: 15px; color: var(--m-primary); 
    z-index: 100; /* FIXED: Sopra a tutto, anche al logo */
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

/* --- HERO SECTION --- */
.m-hero {
    text-align: center;
    padding: 30px 10px 22px;
    display: flex;
    flex-direction: column;
    align-items: center;
    width: 100%;
    position: relative;
    overflow: visible;
    z-index: 10;
    isolation: isolate;
}

.m-hero::before {
    content: '';
    position: absolute;
    left: 50%;
    top: 22px;
    transform: translateX(-50%);
    width: min(360px, 92vw);
    height: 300px;
    background:
        radial-gradient(circle at 50% 36%, rgba(0, 242, 255, 0.22) 0%, rgba(0, 242, 255, 0.08) 28%, rgba(112, 0, 255, 0.06) 54%, transparent 76%);
    filter: blur(22px);
    pointer-events: none;
    z-index: -2;
}

/* Horizon line under hero */
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
    width: 174px;
    height: 174px;
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
    inset: 11px;
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
    inset: -10px;
    border-radius: 50%;
    background: radial-gradient(circle, rgba(0, 242, 255, 0.12) 0%, rgba(0, 242, 255, 0.04) 38%, rgba(112, 0, 255, 0.03) 58%, transparent 78%);
    filter: blur(12px);
    z-index: -1;
    pointer-events: none;
}

@keyframes breathe {
    0%, 100% { transform: scale(1); }
    50% { transform: scale(1.018); }
}

.logo-image {
    width: 108%;
    height: auto;
    max-width: 154px;
    object-fit: contain;
    border-radius: 0;
    transform: translateY(5px) scale(1.03);
    filter: drop-shadow(0 10px 18px rgba(0, 0, 0, 0.42)) drop-shadow(0 0 10px rgba(0, 242, 255, 0.14)) brightness(1.05) saturate(1.05);
    animation: pulseGlow 3.1s ease-in-out infinite alternate;
    will-change: transform, filter, opacity;
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
    0% {
        transform: translateY(5px) scale(1.03);
        filter: drop-shadow(0 10px 16px rgba(0, 0, 0, 0.40)) drop-shadow(0 0 8px rgba(0, 242, 255, 0.10)) brightness(1.03) saturate(1.03);
    }
    100% {
        transform: translateY(3px) scale(1.055);
        filter: drop-shadow(0 12px 18px rgba(0, 0, 0, 0.44)) drop-shadow(0 0 12px rgba(0, 242, 255, 0.18)) brightness(1.07) saturate(1.07);
    }
}

.logo-particles {
    position: absolute;
    top: -24px;
    left: -24px;
    width: 222px;
    height: 222px;
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
    font-size: 3.4rem; font-weight: 900; line-height: 0.92;
    background: linear-gradient(180deg, #ffffff 0%, #9efcff 28%, #1fe6ff 58%, #6783ff 100%);
    -webkit-background-clip: text; -webkit-text-fill-color: transparent;
    margin: 6px 0 0 0; letter-spacing: 1px;
    filter: drop-shadow(0 0 14px rgba(0, 242, 255, 0.4));
    position: relative; z-index: 10;
    animation: titleGlow 4.5s ease-in-out infinite alternate;
}
@keyframes titleGlow {
    from { filter: drop-shadow(0 0 12px rgba(0, 242, 255, 0.32)); }
    to { filter: drop-shadow(0 0 22px rgba(0, 242, 255, 0.52)); }
}
.m-brand-sub {
    font-family: 'Rajdhani', sans-serif; font-size: 0.78rem; letter-spacing: 6px;
    color: var(--m-primary); text-transform: uppercase; margin-top: 10px;
    font-weight: 800; opacity: 0.95; display: flex; align-items: center; justify-content: center;
    width: 100%; text-shadow: 0 0 8px var(--m-primary); white-space: nowrap;
    position: relative; z-index: 10;
}
.m-brand-sub::before, .m-brand-sub::after {
    content: ''; display: block; width: 32px; height: 1px;
    background: linear-gradient(90deg, transparent, var(--m-primary));
    margin: 0 12px; flex-shrink: 0; box-shadow: 0 0 10px var(--m-primary);
}
.m-brand-sub::after { background: linear-gradient(90deg, var(--m-primary), transparent); }

.m-brand-desc {
    font-family: 'Outfit', sans-serif; font-size: 0.78rem; color: var(--m-dim);
    line-height: 1.45; margin-top: 10px; margin-bottom: 10px; max-width: 280px;
    opacity: 0.9; position: relative; z-index: 10;
}

.m-version-tag {
    margin-top: 12px; font-family: 'Rajdhani', monospace; font-size: 0.62rem;
    color: #e0f7fa; opacity: 0.95; letter-spacing: 2px;
    background: rgba(0, 242, 255, 0.08); padding: 5px 12px; border-radius: 20px;
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

/* --- COMPONENTS --- */

/* === CREDENTIALS DECK === */
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

/* Active State */
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

/* Specific Colors */
.cred-rd { --opt-color: var(--m-primary); --opt-glow: rgba(0, 242, 255, 0.2); }
.cred-tb { --opt-color: var(--m-accent); --opt-glow: rgba(176, 38, 255, 0.2); }
.cred-p2p { --opt-color: var(--m-amber); --opt-glow: rgba(255, 204, 0, 0.2); }

/* Input Fuselage (Container) */
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

/* Inner Input Wrapper */
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

/* Field Labels Top Right */
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
.m-if-label.opt { color: var(--m-accent); border-color: rgba(176,38,255,0.35); background: linear-gradient(180deg, #07020c, #0a0612); }

/* Link Button */
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
    box-shadow: 0 0 10px rgba(255, 204, 0, 0.4);
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
/* Animated top accent bar */
.m-hypervisor::before {
    content: ''; position: absolute; top: 0; left: 0; width: 100%; height: 2px;
    background: linear-gradient(90deg, transparent 0%, var(--m-primary) 25%, var(--m-secondary) 50%, var(--m-primary) 75%, transparent 100%);
    background-size: 200% 100%;
    box-shadow: 0 0 12px var(--m-primary);
    animation: borderFlow 6s linear infinite;
}
/* Faint blueprint mesh inside */
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

/* --- FLUX STYLES --- */
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

/* Active States for Flux */
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
    background: rgba(255, 153, 0, 0.05); border-color: var(--m-amber);
    box-shadow: 0 0 15px rgba(255, 153, 0, 0.1), inset 0 0 5px rgba(255, 153, 0, 0.05);
}
.m-flux-opt.active-sz i, .m-flux-opt.active-sz span { color: var(--m-amber); text-shadow: 0 0 8px rgba(255,153,0,0.4); }

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

/* Readout Colors */
.m-flux-readout.mode-bal { border-left-color: var(--m-primary); background: linear-gradient(90deg, rgba(0,242,255,0.05), transparent); }
.m-flux-readout.mode-bal .m-fr-icon { color: var(--m-primary); }
.m-flux-readout.mode-res { border-left-color: var(--m-secondary); background: linear-gradient(90deg, rgba(112,0,255,0.05), transparent); }
.m-flux-readout.mode-res .m-fr-icon { color: var(--m-secondary); }
.m-flux-readout.mode-sz { border-left-color: var(--m-amber); background: linear-gradient(90deg, rgba(255,153,0,0.05), transparent); }
.m-flux-readout.mode-sz .m-fr-icon { color: var(--m-amber); }

/* --- LANGUAGE STYLES --- */
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

/* Active Language States */
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
    background: rgba(255, 0, 85, 0.08); border-color: var(--m-cine);
    box-shadow: 0 0 15px rgba(255, 0, 85, 0.15);
}
.m-lang-opt.active-eng i, .m-lang-opt.active-eng .m-lang-txt { color: var(--m-cine); filter: drop-shadow(0 0 5px rgba(255,0,85,0.5)); }

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
.m-sys-info h4 { margin: 0; font-size: 0.85rem; color: #fff; font-family: 'Rajdhani'; font-weight: 700; display: flex; align-items: center; gap: 5px; }
.m-sys-info p { margin: 2px 0 0; font-size: 0.65rem; color: rgba(255,255,255,0.5); }


/* --- REACTOR CORE MODULES (OPTIMIZED & LESS ZOOMED) --- */
.m-reactor-grid {
    display: flex; flex-direction: column; gap: 10px; margin-bottom: 25px;
}

.m-reactor-module {
    /* Base Appearance */
    background: linear-gradient(180deg, rgba(8, 12, 18, 0.96), rgba(3, 6, 11, 0.97));
    border: 1px solid rgba(255,255,255,0.06);
    border-radius: var(--m-radius-md);
    position: relative;
    overflow: hidden;
    transition: all 0.4s cubic-bezier(0.25, 0.8, 0.25, 1);
    display: flex;
    align-items: stretch;
    min-height: 78px;
    box-shadow: 0 6px 16px rgba(0,0,0,0.55), inset 0 1px 0 rgba(255,255,255,0.03);
}
.m-reactor-module:active { transform: scale(0.99); }

/* The "Core" (Left Bar) */
.m-reactor-core {
    width: 45px; /* Reduced from 60px */
    flex-shrink: 0;
    background: #0f1219;
    border-right: 1px solid rgba(255,255,255,0.05);
    display: flex;
    align-items: center;
    justify-content: center;
    position: relative;
    z-index: 2; /* Keeps icon above glow */
    transition: background 0.3s, box-shadow 0.3s;
}

.m-core-icon {
    font-size: 1.1rem; /* Reduced from 1.4rem */
    transition: all 0.4s cubic-bezier(0.34, 1.56, 0.64, 1);
    filter: drop-shadow(0 0 5px rgba(0,0,0,0.5));
    z-index: 3;
    position: relative;
}

/* The Body (Content) */
.m-reactor-body {
    flex: 1;
    padding: 8px 12px; /* Reduced padding */
    display: flex;
    flex-direction: column;
    justify-content: center;
    position: relative;
    z-index: 2;
    background: linear-gradient(90deg, rgba(255,255,255,0.01), transparent);
}

/* Titles & Text */
.m-reactor-top {
    display: flex; justify-content: space-between; align-items: center; margin-bottom: 2px;
}
.m-reactor-title {
    font-family: 'Rajdhani', sans-serif; font-weight: 800; color: #fff; font-size: 0.95rem; /* Reduced from 1rem */
    letter-spacing: 0.5px; text-shadow: 0 2px 5px rgba(0,0,0,0.5);
}
.m-reactor-desc {
    font-family: 'Outfit', sans-serif; font-size: 0.6rem; /* Reduced from 0.65rem */
    color: #666; 
    line-height: 1.3; margin-bottom: 4px; display: block;
}

/* Badges (Tech Tags) */
.m-tag-row { display: flex; gap: 6px; align-items: center; }
.m-tech-tag {
    font-family: 'Rajdhani', monospace; font-size: 0.5rem; font-weight: 700;
    padding: 2px 5px; border-radius: 4px; border: 1px solid;
    text-transform: uppercase; letter-spacing: 1px; line-height: 1;
}
.tag-noproxy { border-color: #444; color: #777; background: rgba(255,255,255,0.02); }
.tag-mfp { border-color: rgba(0, 242, 255, 0.3); color: var(--m-primary); background: rgba(0, 242, 255, 0.05); }
.tag-kraken { border-color: rgba(255, 77, 109, 0.7); color: #ff9fb1; background: rgba(255, 77, 109, 0.12); }

/* --- ACTIVE STATES (THE MAGIC) --- */

/* Background Glow Effect */
.m-reactor-module::after {
    content: ''; position: absolute; top: 0; left: 0; width: 100%; height: 100%;
    background: radial-gradient(circle at 0% 50%, var(--glow-color), transparent 70%);
    opacity: 0; transition: opacity 0.5s ease;
    z-index: 0; pointer-events: none;
}
.m-reactor-module.active::after { opacity: 0.25; }

/* Border Glow */
.m-reactor-module.active {
    border-color: var(--border-color);
    box-shadow: 0 0 20px rgba(0,0,0,0.5), inset 0 0 0 1px var(--border-color-dim);
}

/* Core Activation */
.m-reactor-module.active .m-reactor-core {
    background: var(--core-bg);
    border-right-color: var(--border-color);
    box-shadow: 10px 0 30px -5px var(--glow-color); /* Spills light into body */
}

/* Icon Activation - BOOST BRIGHTNESS but keep color */
.m-reactor-module.active .m-core-icon {
    transform: scale(1.15);
    filter: drop-shadow(0 0 8px var(--border-color)) brightness(1.2);
}

/* Specific Module Colors & ALWAYS ON ICONS */
#mod-vix { --glow-color: rgba(112, 0, 255, 0.8); --border-color: #7000ff; --border-color-dim: rgba(112,0,255,0.3); --core-bg: rgba(112,0,255,0.2); }
#mod-vix .m-core-icon { color: var(--m-secondary); }

#mod-ghd { --glow-color: rgba(0, 242, 255, 0.8); --border-color: #00f2ff; --border-color-dim: rgba(0,242,255,0.3); --core-bg: rgba(0,242,255,0.2); }
#mod-ghd .m-core-icon { color: var(--m-primary); }

#mod-gs { --glow-color: rgba(176, 38, 255, 0.8); --border-color: #b026ff; --border-color-dim: rgba(176,38,255,0.3); --core-bg: rgba(176,38,255,0.2); }
#mod-gs .m-core-icon { color: var(--m-accent); }

/* AnimeWorld - BLAZE ORANGE */
#mod-aw { --glow-color: rgba(255, 102, 0, 0.8); --border-color: #ff6600; --border-color-dim: rgba(255,102,0,0.3); --core-bg: rgba(255,102,0,0.2); }
#mod-aw .m-core-icon { color: var(--m-orange); }

/* AnimeSaturn - COSMIC GOLD */
#mod-as { --glow-color: rgba(255, 204, 0, 0.8); --border-color: #ffcc00; --border-color-dim: rgba(255,204,0,0.3); --core-bg: rgba(255,204,0,0.2); }
#mod-as .m-core-icon { color: var(--m-amber); }

/* GuardaFlix - NEON GREEN */
#mod-gf { --glow-color: rgba(0, 230, 118, 0.8); --border-color: #00e676; --border-color-dim: rgba(0,230,118,0.3); --core-bg: rgba(0,230,118,0.2); }
#mod-gf .m-core-icon { color: #00e676; }

/* CinemaCity - NEON ROSE */
#mod-cc { --glow-color: rgba(255, 77, 109, 0.8); --border-color: #ff4d6d; --border-color-dim: rgba(255,77,109,0.3); --core-bg: rgba(255,77,109,0.2); }
#mod-cc .m-core-icon { color: #ff4d6d; }

/* --- SWITCH OVERRIDE FOR REACTOR --- */
/* Makes the switch fit the theme better */
.m-reactor-top .m-switch { transform: scale(0.85); transform-origin: right center; }

/* --- SC SUBPANEL (FIXED: NO CUT OFF & HIDDEN BY DEFAULT) --- */
.m-sc-subpanel {
    display: none; /* KEY FIX: HIDDEN BY DEFAULT */
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
    margin-bottom: 22px; position: relative;
    background: linear-gradient(165deg, rgba(8, 14, 22, 0.92), rgba(2, 5, 10, 0.97));
    border: 1px solid rgba(0, 242, 255, 0.18);
    border-radius: var(--m-radius-lg); padding: 16px 14px 16px;
    box-shadow: 0 14px 40px rgba(0,0,0,0.55), inset 0 0 24px rgba(0, 242, 255, 0.04);
    overflow: hidden;
}
.m-visual-core-v2::before {
    content: ''; position: absolute; top: 0; left: 0; width: 100%; height: 2px;
    background: linear-gradient(90deg, transparent 0%, var(--m-primary) 25%, var(--m-secondary) 50%, var(--m-primary) 75%, transparent 100%);
    background-size: 200% 100%;
    box-shadow: 0 0 12px var(--m-primary);
    animation: borderFlow 6s linear infinite;
}
.m-visual-preview {
    background: linear-gradient(180deg, #04080d, #02050a);
    border: 1px solid rgba(0,242,255,0.2);
    border-radius: var(--m-radius-md);
    padding: 12px; margin-bottom: 15px;
    display: flex; gap: 12px; align-items: flex-start;
    box-shadow: 0 0 28px rgba(0,0,0,0.65), inset 0 0 18px rgba(0, 242, 255, 0.04);
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

.m-cortex-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 9px; margin-bottom: 20px; padding: 0 2px; }
.m-cortex-chip {
    background: linear-gradient(180deg, rgba(15, 22, 32, 0.92), rgba(2, 6, 12, 0.96));
    border: 1px solid rgba(0, 242, 255, 0.18);
    border-radius: 10px;
    padding: 10px 4px 8px;
    display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 4px;
    cursor: pointer; position: relative; overflow: hidden;
    transition: all 0.25s cubic-bezier(0.25, 0.8, 0.25, 1);
    clip-path: polygon(0 0, 100% 0, 100% calc(100% - 9px), calc(100% - 9px) 100%, 0 100%);
    box-shadow: 0 4px 12px rgba(0,0,0,0.5), inset 0 1px 0 rgba(255,255,255,0.03);
    min-height: 88px;
}
.m-cortex-chip:active { transform: scale(0.94); }
.m-cortex-chip.active {
    background: linear-gradient(180deg, rgba(0, 242, 255, 0.16), rgba(0, 60, 90, 0.18));
    border-color: var(--m-primary);
    box-shadow: 0 0 22px rgba(0, 242, 255, 0.35), inset 0 0 14px rgba(0, 242, 255, 0.08);
}
.m-cortex-chip.active::after {
    content: ''; position: absolute; bottom: 0; right: 0;
    width: 9px; height: 9px;
    background: var(--m-primary);
    box-shadow: 0 0 10px var(--m-primary), 0 0 18px var(--m-primary);
}
.m-chip-icon {
    font-size: 1.4rem; filter: none; opacity: 1;
    transition: 0.3s cubic-bezier(0.34, 1.56, 0.64, 1);
    text-shadow: 0 0 6px rgba(255,255,255,0.3);
}
.m-chip-icon i { font-size: 1em; }
.m-cortex-chip.active .m-chip-icon { transform: scale(1.18); text-shadow: 0 0 14px var(--m-primary); }
.m-chip-label {
    font-family: 'Rajdhani', monospace; font-size: 0.66rem; font-weight: 800;
    color: #fff; text-transform: uppercase; letter-spacing: 1px;
    text-shadow: 0 0 4px rgba(0, 242, 255, 0.4); text-align: center;
}
.m-chip-sub {
    font-family: 'Outfit', sans-serif; font-size: 0.5rem;
    color: var(--m-dim); letter-spacing: 1px; text-transform: uppercase;
    text-align: center; line-height: 1.2;
}
.m-vp-mode { font-family: 'Rajdhani', sans-serif; font-size: 0.58rem; letter-spacing: 1.4px; color: var(--m-primary); margin-bottom: 4px; text-transform: uppercase; font-weight: 800; }

.m-field-group { margin-bottom: 18px; }
.m-field-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 6px; padding: 0 2px; }
.m-field-label { font-family: 'Rajdhani'; font-weight: 700; font-size: 0.7rem; color: var(--m-dim); letter-spacing: 1px; }
.m-field-link { font-family: 'Rajdhani'; font-weight: 700; font-size: 0.65rem; color: var(--m-primary); cursor: pointer; transition: 0.2s; display: flex; align-items: center; gap: 5px; }
.m-input-box { position: relative; width: 100%; }
.m-input-ico { position: absolute; left: 14px; top: 50%; transform: translateY(-50%); color: #555; font-size: 0.9rem; transition: 0.3s; z-index: 2; pointer-events: none; }
.m-input-tech { width: 100%; background: #05080b; border: 1px solid rgba(255,255,255,0.12); border-radius: 10px; padding: 12px 40px 12px 38px; color: #fff; font-family: 'Roboto Mono', monospace; font-size: 0.9rem; transition: all 0.3s; }
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

/* --- P2P MODULE STYLE --- */
.m-p2p-module { background: rgba(255, 204, 0, 0.05); border: 1px solid rgba(255, 204, 0, 0.3); border-radius: 16px; padding: 15px; margin-top: 15px; position: relative; overflow: hidden; transition: all 0.3s; }
.m-p2p-module.active { border-color: var(--m-amber); box-shadow: 0 0 20px rgba(255, 204, 0, 0.2); background: radial-gradient(circle at top right, rgba(255, 204, 0, 0.08), transparent); }
.m-p2p-head { display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px; }
.m-p2p-title { font-family: 'Rajdhani'; font-weight: 800; font-size: 1rem; color: var(--m-amber); display: flex; align-items: center; gap: 8px; text-shadow: 0 0 5px rgba(255,204,0,0.3); }
.m-p2p-status { font-family: 'Rajdhani'; font-weight: 700; font-size: 0.65rem; padding: 3px 6px; border-radius: 4px; background: rgba(255,204,0,0.1); color: var(--m-amber); transition: all 0.3s; border: 1px solid rgba(255,204,0,0.2); }
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
input:checked + .m-slider-purple { background-color: rgba(176, 38, 255, 0.3); border-color: var(--m-accent); box-shadow: inset 0 0 10px rgba(176,38,255,0.4); }
input:checked + .m-slider-purple:before { background-color: var(--m-accent); box-shadow: 0 0 10px var(--m-accent); }

.m-slider-amber { background-color: #1c1c1c; }
input:checked + .m-slider-amber { background-color: rgba(255, 204, 0, 0.3); border-color: var(--m-amber); box-shadow: inset 0 0 10px rgba(255,204,0,0.4); }
input:checked + .m-slider-amber:before { background-color: var(--m-amber); box-shadow: 0 0 10px var(--m-amber); }

.m-slider-pink { background-color: #1c1c1c; }
input:checked + .m-slider-pink { background-color: rgba(255, 0, 85, 0.3); border-color: var(--m-cine); box-shadow: inset 0 0 10px rgba(255,0,85,0.4); }
input:checked + .m-slider-pink:before { background-color: var(--m-cine); box-shadow: 0 0 10px var(--m-cine); }

/* Nuova Slider Green per GuardaFlix */
.m-slider-green { background-color: #1c1c1c; }
input:checked + .m-slider-green { background-color: rgba(0, 230, 118, 0.3); border-color: #00e676; box-shadow: inset 0 0 10px rgba(0,230,118,0.4); }
input:checked + .m-slider-green:before { background-color: #00e676; box-shadow: 0 0 10px #00e676; }

.m-priority-wrapper { max-height: 0; opacity: 0; overflow: hidden; transition: all 0.35s ease; margin: 0 -10px; }
.m-priority-wrapper.show { max-height: 130px; opacity: 1; margin-top: 15px; padding: 0 10px; }

.m-gate-wrapper { width: 100%; overflow: hidden; max-height: 0; opacity: 0; transition: all 0.35s ease; }
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

/* --- UPDATED STAR MODULE --- */
.m-star-btn {
    margin-top: 10px;
    background: linear-gradient(90deg, rgba(255, 153, 0, 0.1), rgba(255, 153, 0, 0.05), rgba(255, 153, 0, 0.1));
    border: 1px solid rgba(255, 153, 0, 0.3);
    border-radius: 12px;
    padding: 10px 15px; /* Compact padding */
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 8px;
    text-decoration: none;
    color: var(--m-amber);
    font-family: 'Rajdhani', sans-serif;
    font-weight: 800;
    letter-spacing: 1px;
    font-size: 0.75rem; /* Smaller Font */
    box-shadow: 0 0 10px rgba(255, 153, 0, 0.1);
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

/* --- COMMAND DOCK --- */
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
    color: #4a5666; width: 64px; transition: all 0.25s cubic-bezier(0.25, 1.5, 0.5, 1);
    position: relative;
    padding: 4px 0;
    cursor: pointer;
}
.m-nav-item i { font-size: 1.05rem; transition: color 0.2s, filter 0.2s; }
.m-nav-item span { font-size: 0.55rem; font-weight: 800; font-family: 'Rajdhani', sans-serif; letter-spacing: 1.6px; text-transform: uppercase; }

.m-nav-item.active { color: #fff; transform: translateY(-3px); }
.m-nav-item.active i { color: var(--m-primary); filter: drop-shadow(0 0 10px var(--m-primary)); }
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

body.m-lowfx .m-hero::after,
body.m-lowfx .logo-particles {
    display: none;
}

body.m-lowfx .logo-container,
body.m-lowfx .logo-image,
body.m-lowfx .m-brand-title,
body.m-lowfx .m-version-tag .m-v-dot {
    animation: none !important;
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
    .m-hero::after {
        animation: none !important;
        transition: none !important;
    }

    body::after,
    body::before,
    .logo-particles {
        display: none !important;
    }
}
`;

const mobileHTML = `
<div class="m-ocean-particles" id="m-ocean-particles" aria-hidden="true"></div>
<div id="app-container">
    <div class="m-content-wrapper">
        <div class="m-ptr" id="m-ptr-indicator"><i class="fas fa-arrow-down m-ptr-icon"></i></div>

        <div class="m-content">
            <div class="m-hero">
                <div class="logo-container">
                    <img src="${MOBILE_LOGO_URL}" alt="Leviathan Logo" class="logo-image" fetchpriority="high" decoding="sync" loading="eager" width="154" height="154">
                    <div class="logo-particles" id="logoParticles"></div>
                </div>

                <h1 class="m-brand-title">LEVIATHAN</h1>
                <div class="m-brand-sub">SOVRANO DEGLI ABISSI</div>
                <div class="m-brand-desc">Il protocollo profondo che domina i flussi digitali</div>
                <div class="m-version-tag"><div class="m-v-dot"></div>CORE v2.7.0</div>
            </div>

            <div id="page-setup" class="m-page active">

                <div class="m-section-head">
                    <div class="sh-titles">
                        <span class="sh-title">Identity Core</span>
                        <span class="sh-sub">Servizi &amp; chiavi di accesso</span>
                    </div>
                    <span class="sh-tag">01 / 03</span>
                </div>

                <div class="m-hypervisor">
                    <div class="m-hyp-header">
                        <span>ACCESS CREDENTIALS</span>
                        <i class="fas fa-fingerprint m-hyp-icon"></i>
                    </div>

                    <div class="m-cred-deck">
                        <div class="m-cred-opt cred-rd m-srv-btn active" onclick="setMService('rd', this)">
                            <div class="m-cred-icon"><i class="fas fa-bolt"></i></div>
                            <div class="m-cred-name">REAL-DEBRID</div>
                        </div>
                        <div class="m-cred-opt cred-tb m-srv-btn" onclick="setMService('tb', this)">
                            <div class="m-cred-icon"><i class="fas fa-anchor"></i></div>
                            <div class="m-cred-name">TORBOX</div>
                        </div>
                        <div class="m-cred-opt cred-p2p m-srv-btn" onclick="setMService('p2p', this)">
                            <div class="m-cred-icon"><i class="fas fa-network-wired"></i></div>
                            <div class="m-cred-name">P2P MODE</div>
                        </div>
                    </div>

                    <div class="m-input-fuselage" id="box-apikey">
                        <div class="m-if-label">API ACCESS KEY</div>
                        <div class="m-if-inner">
                            <div class="m-if-icon"><i class="fas fa-key"></i></div>
                            <input type="text" id="m-apiKey" class="m-if-field" placeholder="INCOLLA KEY..." oninput="handleMobileApiKeyInput()">
                            <div class="m-if-action" onclick="pasteTo('m-apiKey')"><i class="fas fa-paste"></i></div>
                            <div class="m-get-link" onclick="openApiPage()">GET <i class="fas fa-external-link-alt"></i></div>
                        </div>
                        <div class="m-key-status idle" id="m-keyStatus" aria-live="polite" aria-atomic="true">
                            <span class="m-key-status-dot"></span>
                            <span id="m-keyStatusText">Live check disponibile per Real-Debrid e TorBox.</span>
                        </div>
                    </div>

                    <div class="m-input-fuselage tmdb-box" id="box-tmdb">
                        <div class="m-if-label opt">TMDB (OPTIONAL)</div>
                        <div class="m-if-inner">
                            <div class="m-if-icon"><i class="fas fa-film"></i></div>
                            <input type="text" id="m-tmdb" class="m-if-field" placeholder="PERSONAL KEY..." oninput="updateLinkModalContent()">
                            <div class="m-if-action" onclick="pasteTo('m-tmdb')"><i class="fas fa-paste"></i></div>
                            <div class="m-get-link" style="color:var(--m-accent); border-color:var(--m-accent); background:rgba(176,38,255,0.05);" onclick="openApiPage('tmdb')">GET <i class="fas fa-external-link-alt"></i></div>
                        </div>
                    </div>

                </div>

                <div class="m-section-head">
                    <div class="sh-titles">
                        <span class="sh-title">Reactor Modules</span>
                        <span class="sh-sub">Sorgenti web italiane</span>
                    </div>
                    <span class="sh-tag violet">02 / 03</span>
                </div>

                <div class="m-hypervisor">
                     <div class="m-hyp-header">
                        <span>WEB MODULES</span>
                        <i class="fas fa-cubes m-hyp-icon"></i>
                    </div>

                    <div class="m-reactor-grid">
                        
                        <div class="m-reactor-module" id="mod-vix">
                            <div class="m-reactor-core">
                                <i class="fas fa-play-circle m-core-icon"></i>
                            </div>
                            <div class="m-reactor-body">
                                <div class="m-reactor-top">
                                    <span class="m-reactor-title">StreamingCommunity</span>
                                    <label class="m-switch">
                                        <input type="checkbox" id="m-enableVix" onchange="updateStatus('m-enableVix','st-vix'); toggleModuleStyle('m-enableVix', 'mod-vix');">
                                        <span class="m-slider"></span>
                                    </label>
                                </div>
                                <span class="m-reactor-desc">Film, Serie TV & Anime (Catalogo Vasto)</span>
                                <div class="m-tag-row">
                                    <span class="m-tech-tag tag-noproxy"><i class="fas fa-bolt"></i> NO PROXY</span>
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
                                    <span class="m-reactor-title">GuardaHD</span>
                                    <label class="m-switch">
                                        <input type="checkbox" id="m-enableGhd" onchange="updateStatus('m-enableGhd','st-ghd'); toggleModuleStyle('m-enableGhd', 'mod-ghd');">
                                        <span class="m-slider"></span>
                                    </label>
                                </div>
                                <span class="m-reactor-desc">Archivio HD di Film e Serie TV in Italiano. Aggiornamenti quotidiani.</span>
                                <div class="m-tag-row">
                                    <span class="m-tech-tag tag-mfp"><i class="fas fa-shield-alt"></i> MFP</span>
                                </div>
                            </div>
                        </div>

                        <div class="m-reactor-module" id="mod-gs">
                            <div class="m-reactor-core">
                                <i class="fas fa-tv m-core-icon"></i>
                            </div>
                            <div class="m-reactor-body">
                                <div class="m-reactor-top">
                                    <span class="m-reactor-title">GuardoSerie</span>
                                    <label class="m-switch">
                                        <input type="checkbox" id="m-enableGs" onchange="updateStatus('m-enableGs','st-gs'); toggleModuleStyle('m-enableGs', 'mod-gs');">
                                        <span class="m-slider m-slider-purple"></span>
                                    </label>
                                </div>
                                <span class="m-reactor-desc">Specializzato in Serie TV. Catalogo Italiano completo con ultime uscite.</span>
                                <div class="m-tag-row">
                                    <span class="m-tech-tag tag-mfp"><i class="fas fa-shield-alt"></i> MFP</span>
                                </div>
                            </div>
                        </div>

                        <div class="m-reactor-module" id="mod-aw">
                            <div class="m-reactor-core">
                                <i class="fas fa-torii-gate m-core-icon"></i>
                            </div>
                            <div class="m-reactor-body">
                                <div class="m-reactor-top">
                                    <span class="m-reactor-title">AnimeWorld</span>
                                    <label class="m-switch">
                                        <input type="checkbox" id="m-enableAnimeWorld" onchange="updateStatus('m-enableAnimeWorld','st-aw'); toggleModuleStyle('m-enableAnimeWorld', 'mod-aw');">
                                        <span class="m-slider m-slider-amber"></span>
                                    </label>
                                </div>
                                <span class="m-reactor-desc">Anime ITA Database</span>
                                <div class="m-tag-row">
                                    <span class="m-tech-tag tag-noproxy"><i class="fas fa-bolt"></i> NO PROXY</span>
                                </div>
                            </div>
                        </div>

                        <div class="m-reactor-module" id="mod-au">
                            <div class="m-reactor-core">
                                <i class="fas fa-water m-core-icon"></i>
                            </div>
                            <div class="m-reactor-body">
                                <div class="m-reactor-top">
                                    <span class="m-reactor-title">AnimeUnity</span>
                                    <label class="m-switch">
                                        <input type="checkbox" id="m-enableAnimeUnity" onchange="updateStatus('m-enableAnimeUnity','st-au'); toggleModuleStyle('m-enableAnimeUnity', 'mod-au');">
                                        <span class="m-slider m-slider-amber"></span>
                                    </label>
                                </div>
                                <span class="m-reactor-desc">Kitsu + VixCloud</span>
                                <div class="m-tag-row">
                                    <span class="m-tech-tag tag-mfp"><i class="fas fa-route"></i> MFP</span>
                                </div>
                            </div>
                        </div>

                        <div class="m-reactor-module" id="mod-as">
                            <div class="m-reactor-core">
                                <i class="fas fa-satellite-dish m-core-icon"></i>
                            </div>
                            <div class="m-reactor-body">
                                <div class="m-reactor-top">
                                    <span class="m-reactor-title">AnimeSaturn</span>
                                    <label class="m-switch">
                                        <input type="checkbox" id="m-enableAnimeSaturn" onchange="updateStatus('m-enableAnimeSaturn','st-as'); toggleModuleStyle('m-enableAnimeSaturn', 'mod-as');">
                                        <span class="m-slider m-slider-amber"></span>
                                    </label>
                                </div>
                                <span class="m-reactor-desc">Fallback anime con mapping Kitsu, IMDb e TMDb.</span>
                                <div class="m-tag-row">
                                    <span class="m-tech-tag tag-noproxy"><i class="fas fa-bolt"></i> NO PROXY</span>
                                </div>
                            </div>
                        </div>
                        
                        <div class="m-reactor-module" id="mod-gf">
                            <div class="m-reactor-core">
                                <i class="fas fa-play m-core-icon"></i>
                            </div>
                            <div class="m-reactor-body">
                                <div class="m-reactor-top">
                                    <span class="m-reactor-title">GuardaFlix</span>
                                    <label class="m-switch">
                                        <input type="checkbox" id="m-enableGf" onchange="updateStatus('m-enableGf','st-gf'); toggleModuleStyle('m-enableGf', 'mod-gf');">
                                        <span class="m-slider m-slider-green"></span>
                                    </label>
                                </div>
                                <span class="m-reactor-desc">Catalogo esclusivo per i Film. Richiede MediaFlow Proxy configurato.</span>
                                <div class="m-tag-row">
                                    <span class="m-tech-tag tag-mfp"><i class="fas fa-shield-alt"></i> MFP</span>
                                </div>
                            </div>
                        </div>

                        <div class="m-reactor-module" id="mod-cc">
                            <div class="m-reactor-core">
                                <i class="fas fa-city m-core-icon"></i>
                            </div>
                            <div class="m-reactor-body">
                                <div class="m-reactor-top">
                                    <span class="m-reactor-title">CinemaCity</span>
                                    <label class="m-switch">
                                        <input type="checkbox" id="m-enableCc" onchange="updateStatus('m-enableCc','st-cc'); toggleModuleStyle('m-enableCc', 'mod-cc');">
                                        <span class="m-slider"></span>
                                    </label>
                                </div>
                                <span class="m-reactor-desc">Catalogo Film e Serie TV con aggiornamenti costanti e riproduzione ottimizzata per Stremio e TV.</span>
                                <div class="m-tag-row">
                                    <span class="m-tech-tag tag-kraken"><i class="fas fa-shield-alt"></i> KRAKEN</span>
                                </div>
                            </div>
                        </div>

                    </div>
                </div>

                <div id="m-priority-panel" class="m-priority-wrapper">
                    <div style="margin-top:5px; padding:15px; border-radius:16px; background:linear-gradient(90deg, rgba(112,0,255,0.1), transparent); border-left:4px solid var(--m-secondary);">
                        <div style="display:flex; justify-content:space-between; align-items:center;">
                            <div>
                                <h5 style="margin:0; font-family:'Rajdhani'; color:#fff;">PRIORITA WEB</h5>
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

                <div class="m-section-head">
                    <div class="sh-titles">
                        <span class="sh-title">Visual Forge</span>
                        <span class="sh-sub">Skin del formattatore Leviathan</span>
                    </div>
                    <span class="sh-tag">SKIN</span>
                </div>

                <div class="m-visual-core-v2" id="m-visual-core-v2">
                
                     <div class="m-hyp-header" style="margin-bottom:15px; border:none; padding-bottom:0;">
                        <span>VISUAL FORMATTER</span>
                        <i class="fas fa-swatchbook m-hyp-icon"></i>
                     </div>
                
                     <div class="m-aio-lock" id="m-aio-lock-overlay">
                        <i class="fas fa-lock m-lock-icon"></i>
                        <div class="m-lock-text">OVERRIDDEN BY AIO CORE</div>
                        <div class="m-lock-sub">Disabilita "Compatibilita AIO" per sbloccare le skin.</div>
                    </div>

                    <div class="m-visual-preview" id="m-preview-box">
                        <div class="m-recalc-overlay" id="m-recalc-layer">
                            <div class="m-recalc-text"><i class="fas fa-cog fa-spin"></i> UPDATING CORE...</div>
                        </div>
                        
                        <div class="m-vp-icon"><i class="fas fa-film"></i></div>
                        <div class="m-vp-text">
                            <div class="m-vp-mode" id="m-prev-mode">LEVIATHAN CORE</div>
                            <div class="m-vp-title" id="m-prev-title">LEVIATHAN</div>
                            <div class="m-vp-sub" id="m-prev-info">...</div>
                        </div>
                    </div>

                    <div class="m-cortex-grid">
                        <div class="m-cortex-chip active" id="msk_leviathan" onclick="selectMobileSkin('leviathan')">
                            <div class="m-chip-icon"><i class="fas fa-dragon"></i></div>
                            <div class="m-chip-label">Leviathan Core</div>
                            <div class="m-chip-sub">Signature</div>
                        </div>
                        <div class="m-cortex-chip" id="msk_premium" onclick="selectMobileSkin('premium')">
                            <div class="m-chip-icon"><i class="fas fa-trophy"></i></div>
                            <div class="m-chip-label">Apex Prime</div>
                            <div class="m-chip-sub">Flagship</div>
                        </div>
                        <div class="m-cortex-chip" id="msk_cinema" onclick="selectMobileSkin('cinema')">
                            <div class="m-chip-icon"><i class="fas fa-film"></i></div>
                            <div class="m-chip-label">Velvet Cinema</div>
                            <div class="m-chip-sub">Reference</div>
                        </div>
                        <div class="m-cortex-chip" id="msk_ultra_compact" onclick="selectMobileSkin('ultra_compact')">
                            <div class="m-chip-icon"><i class="fas fa-bolt"></i></div>
                            <div class="m-chip-label">Pulse Compact</div>
                            <div class="m-chip-sub">Dense</div>
                        </div>
                        <div class="m-cortex-chip" id="msk_tv_compact" onclick="selectMobileSkin('tv_compact')">
                            <div class="m-chip-icon"><i class="fas fa-tv"></i></div>
                            <div class="m-chip-label">Neon TV</div>
                            <div class="m-chip-sub">Big Screen</div>
                        </div>
                        <div class="m-cortex-chip" id="msk_lev2" onclick="selectMobileSkin('lev2')">
                            <div class="m-chip-icon"><i class="fas fa-sitemap"></i></div>
                            <div class="m-chip-label">Architect</div>
                            <div class="m-chip-sub">Structured</div>
                        </div>
                        <div class="m-cortex-chip" id="msk_fra" onclick="selectMobileSkin('fra')">
                            <div class="m-chip-icon"><i class="fas fa-globe"></i></div>
                            <div class="m-chip-label">Horizon</div>
                            <div class="m-chip-sub">Classic</div>
                        </div>
                        <div class="m-cortex-chip" id="msk_comet" onclick="selectMobileSkin('comet')">
                            <div class="m-chip-icon"><i class="fas fa-star"></i></div>
                            <div class="m-chip-label">Comet</div>
                            <div class="m-chip-sub">Scan</div>
                        </div>
                        <div class="m-cortex-chip" id="msk_stremio_ita" onclick="selectMobileSkin('stremio_ita')">
                            <div class="m-chip-icon"><i class="fas fa-flag"></i></div>
                            <div class="m-chip-label">ITA Mod</div>
                            <div class="m-chip-sub">Compat</div>
                        </div>
                        <div class="m-cortex-chip" id="msk_dav" onclick="selectMobileSkin('dav')">
                            <div class="m-chip-icon"><i class="fas fa-database"></i></div>
                            <div class="m-chip-label">Datastream</div>
                            <div class="m-chip-sub">Verbose</div>
                        </div>
                        <div class="m-cortex-chip" id="msk_pri" onclick="selectMobileSkin('pri')">
                            <div class="m-chip-icon"><i class="fas fa-eye"></i></div>
                            <div class="m-chip-label">Eclipse</div>
                            <div class="m-chip-sub">Hero</div>
                        </div>
                        <div class="m-cortex-chip" id="msk_and" onclick="selectMobileSkin('and')">
                            <div class="m-chip-icon"><i class="fas fa-th-large"></i></div>
                            <div class="m-chip-label">Matrix</div>
                            <div class="m-chip-sub">Minimal</div>
                        </div>
                        <div class="m-cortex-chip" id="msk_lad" onclick="selectMobileSkin('lad')">
                            <div class="m-chip-icon"><i class="fas fa-layer-group"></i></div>
                            <div class="m-chip-label">Compact</div>
                            <div class="m-chip-sub">Lean</div>
                        </div>
                        <div class="m-cortex-chip" id="msk_torrentio" onclick="selectMobileSkin('torrentio')">
                            <div class="m-chip-icon"><i class="fas fa-stream"></i></div>
                            <div class="m-chip-label">Torrentio</div>
                            <div class="m-chip-sub">Familiar</div>
                        </div>
                        <div class="m-cortex-chip" id="msk_vertical" onclick="selectMobileSkin('vertical')">
                            <div class="m-chip-icon"><i class="fas fa-align-justify"></i></div>
                            <div class="m-chip-label">Vertical</div>
                            <div class="m-chip-sub">Poster</div>
                        </div>
                        <div class="m-cortex-chip" id="msk_complex" onclick="selectMobileSkin('complex')">
                            <div class="m-chip-icon"><i class="fas fa-project-diagram"></i></div>
                            <div class="m-chip-label">Template Matrix</div>
                            <div class="m-chip-sub">Analyst</div>
                        </div>
                        <div class="m-cortex-chip" id="msk_android" onclick="selectMobileSkin('android')">
                            <div class="m-chip-icon"><i class="fas fa-th"></i></div>
                            <div class="m-chip-label">Console Grid</div>
                            <div class="m-chip-sub">Legacy TV</div>
                        </div>
                        <div class="m-cortex-chip" id="msk_picture" onclick="selectMobileSkin('picture')">
                            <div class="m-chip-icon"><i class="fas fa-image"></i></div>
                            <div class="m-chip-label">Jurassic Poster</div>
                            <div class="m-chip-sub">Artwork</div>
                        </div>
                        <div class="m-cortex-chip" id="msk_custom" onclick="selectMobileSkin('custom')" style="grid-column: span 3; border-style: dashed; background: rgba(0,0,0,0.3);">
                            <div class="m-chip-icon"><i class="fas fa-tools"></i></div>
                            <div class="m-chip-label">Custom Builder</div>
                            <div class="m-chip-sub">Template override</div>
                        </div>
                    </div>

                    <div id="m-custom-skin-area" class="m-custom-dash">
                        <div class="m-custom-desc">
                            Usa i tag dinamici per costruire il tuo formato. Incolla il template qui sotto:
                        </div>
                        <div class="m-tag-list">
                            <div class="m-tag-item">{title}</div>
                            <div class="m-tag-item">{quality}</div>
                            <div class="m-tag-item">{size}</div>
                            <div class="m-tag-item">{source}</div>
                            <div class="m-tag-item">{service}</div>
                            <div class="m-tag-item">{score_badge}</div>
                            <div class="m-tag-item">{meter}</div>
                            <div class="m-tag-item">{summary}</div>
                        </div>
                        <input type="text" class="m-input" id="m-customTemplate" placeholder="Es: Apex {quality} {score_badge} ||| {title}{n}{summary}" style="padding:10px; font-size:0.9rem; border:1px solid rgba(255,255,255,0.3);" oninput="updateMobilePreview(); updateLinkModalContent()">
                    </div>
                </div>

                <div class="m-section-head">
                    <div class="sh-titles">
                        <span class="sh-title">Hypervisor</span>
                        <span class="sh-sub">Sort &middot; Lingua &middot; Filtri</span>
                    </div>
                    <span class="sh-tag warn">RULES</span>
                </div>

                <div class="m-hypervisor">
                    <div class="m-hyp-header">
                        <span>SYSTEM HYPERVISOR</span>
                        <i class="fas fa-microchip m-hyp-icon"></i>
                    </div>
                    
                    <p class="m-hyp-desc" style="margin-bottom:15px;">
                        Ottimizza l'algoritmo di ricerca in base alle tue preferenze di visione.
                    </p>

                    <div class="m-flux-control">
                        <div class="m-flux-grid">
                            <div class="m-flux-opt active-bal" id="sort-balanced" onclick="setSortMode('balanced')">
                                <i class="fas fa-dragon"></i>
                                <span>BALANCED</span>
                            </div>
                            <div class="m-flux-opt" id="sort-resolution" onclick="setSortMode('resolution')">
                                <i class="fas fa-gem"></i>
                                <span>QUALITY</span>
                            </div>
                            <div class="m-flux-opt" id="sort-size" onclick="setSortMode('size')">
                                <i class="fas fa-hdd"></i>
                                <span>SIZE</span>
                            </div>
                        </div>
                        
                        <div class="m-flux-readout mode-bal" id="flux-readout-box">
                            <i class="fas fa-info-circle m-fr-icon" id="flux-icon-display"></i>
                            <div class="m-fr-text">
                                <span class="m-fr-title" id="flux-title-display">STANDARD MODE</span>
                                <span class="m-fr-desc" id="flux-desc-display">L'algoritmo standard di Leviathan. Bilancia perfettamente qualita e velocita.</span>
                            </div>
                        </div>
                    </div>

                    <div class="m-hyp-header" style="margin-top:25px; border-top:none; padding-top:0; margin-bottom:10px;">
                         <span>AUDIO & LANGUAGE</span>
                         <i class="fas fa-globe-americas m-hyp-icon"></i>
                    </div>
                    
                    <div class="m-lang-grid">
                        <div class="m-lang-opt active-ita" id="lang-ita" onclick="setLangMode('ita')">
                            <i class="fas fa-flag"></i>
                            <span class="m-lang-txt">ITA ONLY</span>
                        </div>
                        <div class="m-lang-opt" id="lang-all" onclick="setLangMode('all')">
                            <i class="fas fa-comments"></i>
                            <span class="m-lang-txt">ITA + ENG</span>
                        </div>
                        <div class="m-lang-opt" id="lang-eng" onclick="setLangMode('eng')">
                            <i class="fas fa-flag-usa"></i>
                            <span class="m-lang-txt">ENG ONLY</span>
                        </div>
                    </div>

                    <div id="lang-desc-container" style="background: rgba(0,0,0,0.2); border-radius: 8px; padding: 10px; margin-bottom: 25px; border-left: 3px solid var(--m-primary);">
                        <p id="lang-description" style="margin:0; font-size: 0.7rem; color: var(--m-dim); line-height: 1.3; font-family:'Outfit';">
                             Cerca solo contenuti in Italiano. Ignora tutto il resto.
                        </p>
                    </div>

                    <div class="m-hyp-label">Resolution Filter (Exclude)</div>
                    <p class="m-hyp-desc">Tocca per escludere risoluzioni specifiche.</p>
                    
                    <div class="m-chip-grid">
                        <div class="m-qual-chip" id="mq-4k" onclick="toggleFilter('mq-4k')">4K UHD</div>
                        <div class="m-qual-chip" id="mq-1080" onclick="toggleFilter('mq-1080')">1080p</div>
                        <div class="m-qual-chip" id="mq-720" onclick="toggleFilter('mq-720')">720p <span class="mini-tag">HD</span></div>
                        <div class="m-qual-chip" id="mq-sd" onclick="toggleFilter('mq-sd')">CAM/SD</div>
                    </div>

                    <div class="m-sys-grid">
                        <div class="m-sys-row">
                            <div class="m-sys-info"><h4><i class="fas fa-layer-group" style="color:var(--m-accent)"></i> AIO Mode <span class="m-status-text" id="st-aio">OFF</span></h4><p>Formatta per AIOStreams</p></div>
                            <label class="m-switch"><input type="checkbox" id="m-aioMode" onchange="updateStatus('m-aioMode','st-aio')"><span class="m-slider m-slider-purple"></span></label>
                        </div>
                        <div class="m-sys-row">
                            <div class="m-sys-info"><h4><i class="fas fa-film" style="color:var(--m-cine)"></i> Trailer Mode <span class="m-status-text" id="st-trailer">OFF</span></h4><p>Cinema Experience</p></div>
                            <label class="m-switch"><input type="checkbox" id="m-enableTrailers" onchange="updateStatus('m-enableTrailers','st-trailer')"><span class="m-slider m-slider-pink"></span></label>
                        </div>
                    </div>

                    <div class="m-row" style="border:none; padding: 5px 0;">
                        <div class="m-label">
                            <h4><i class="fas fa-compress-arrows-alt" style="color:var(--m-error)"></i> Signal Gate <span class="m-status-text" id="st-gate">OFF</span></h4>
                            <p style="font-size:0.65rem; color:var(--m-error);">Filtro Qualita (Max risultati per ris.)</p>
                        </div>
                        <label class="m-switch"><input type="checkbox" id="m-gateActive" onchange="toggleGate()"><span class="m-slider"></span></label>
                    </div>
                    <div id="m-gate-wrapper" class="m-gate-wrapper">
                        <div class="m-gate-control">
                            <span style="font-size:0.8rem; color:#666;">1</span>
                            <input type="range" min="1" max="20" value="3" class="m-range" id="m-gateVal" oninput="updateGateDisplay(this.value)">
                            <span style="font-family:'Rajdhani'; font-weight:800; font-size:1.2rem; color:var(--m-primary); width:30px; text-align:center;" id="m-gate-display">3</span>
                        </div>
                        <p class="m-range-desc">Limita il numero di risultati mostrati per ogni qualita. Utile per dispositivi lenti.</p>
                    </div>

                    <div class="m-row" style="border:none; padding: 5px 0;">
                        <div class="m-label">
                            <h4><i class="fas fa-weight-hanging" style="color:var(--m-amber)"></i> Size Limit <span class="m-status-text" id="st-size">OFF</span></h4>
                            <p style="font-size:0.65rem; color:var(--m-amber);">Filtro Peso Massimo (GB)</p>
                        </div>
                        <label class="m-switch"><input type="checkbox" id="m-sizeActive" onchange="toggleSize()"><span class="m-slider m-slider-amber"></span></label>
                    </div>
                     <div id="m-size-wrapper" class="m-gate-wrapper">
                        <div class="m-gate-control">
                            <span style="font-size:0.8rem; color:#666;">1GB</span>
                            <input type="range" min="1" max="100" step="1" value="0" class="m-range" id="m-sizeVal" oninput="updateSizeDisplay(this.value)" style="background:linear-gradient(90deg, #ff9900, #333)">
                            <span style="font-family:'Rajdhani'; font-weight:800; font-size:1.1rem; color:var(--m-amber); width:45px; text-align:center;" id="m-size-display">INF</span>
                        </div>
                         <p class="m-range-desc">Nasconde automaticamente tutti i file che superano la dimensione selezionata.</p>
                    </div>

                </div>
            </div>

            <div id="page-network" class="m-page">

                <div class="m-section-head">
                    <div class="sh-titles">
                        <span class="sh-title">Deep Bridge</span>
                        <span class="sh-sub">MediaFlow proxy &amp; ghost</span>
                    </div>
                    <span class="sh-tag violet">NET</span>
                </div>

                <div class="m-hypervisor">
                    <div class="m-hyp-header">
                        <span>NETWORK BRIDGE</span>
                        <i class="fas fa-network-wired m-hyp-icon" style="color:var(--m-secondary); border-color:rgba(112,0,255,0.35); background:rgba(112,0,255,0.08);"></i>
                    </div>
                    
                    <div style="padding:0 5px;">
                        <p style="font-size:0.8rem; color:var(--m-dim); margin-bottom:20px; line-height:1.4;">
                            Proxy Server necessario per i moduli Italiani. Se attivo, il <b>Debrid Ghost</b> usera questo server per nascondere il tuo IP reale.
                        </p>

                        <div class="m-field-group">
                            <div class="m-field-header"><span class="m-field-label">SERVER URL</span></div>
                            <div class="m-input-box">
                                <i class="fas fa-server m-input-ico"></i>
                                <input type="text" id="m-mfUrl" class="m-input-tech" placeholder="https://tuo-proxy.com" oninput="updateLinkModalContent()">
                                <div class="m-paste-action" onclick="pasteTo('m-mfUrl')"><i class="fas fa-paste"></i></div>
                            </div>
                        </div>

                        <div class="m-field-group">
                            <div class="m-field-header"><span class="m-field-label">PASSWORD</span></div>
                            <div class="m-input-box">
                                <i class="fas fa-lock m-input-ico"></i>
                                <input type="password" id="m-mfPass" class="m-input-tech" placeholder="********" oninput="updateLinkModalContent()">
                            </div>
                        </div>

                        <div class="m-ghost-panel" id="ghost-zone-box">
                            <div class="m-ghost-head">
                                <div class="m-ghost-title"><i class="fas fa-user-shield"></i> DEBRID GHOST</div>
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
        <div class="m-dock-actions">
            <button class="m-btn-install" onclick="mobileInstall()">
                <i class="fas fa-download"></i> INSTALLA
            </button>
            <button class="m-btn-copy" onclick="openLinkModal()">
                <i class="fas fa-link"></i><span>COPIA</span>
            </button>
        </div>
        <div class="m-dock-nav">
            <div class="m-nav-item active" onclick="navTo('setup', this)">
                <i class="fas fa-sliders-h"></i><span>SETUP</span>
            </div>
            <div class="m-nav-item" onclick="navTo('filters', this)">
                <i class="fas fa-filter"></i><span>FILTRI</span>
            </div>
            <div class="m-nav-item" onclick="navTo('network', this)">
                <i class="fas fa-globe"></i><span>NET</span>
            </div>
        </div>
    </div>
    
    <div class="m-action-modal" id="m-link-modal">
        <div class="m-am-card">
            <div class="m-am-title">LINK GENERATO</div>
            <div class="m-am-subtitle">Scegli come procedere</div>
            
            <div class="m-flux-terminal">
                <div class="m-flux-header">
                    <span>FLUX DATA STREAM</span>
                    <i class="fas fa-network-wired"></i>
                </div>
                <textarea id="m-generatedUrlBox" class="m-flux-input" readonly>/// WAITING FOR DATA ///</textarea>
            </div>
            
            <div class="m-act-btn m-act-copy" onclick="copyFromModal()">
                <i class="fas fa-copy"></i> COPIA NEGLI APPUNTI
            </div>
            
            <div class="m-act-btn m-act-close" onclick="closeLinkModal()">
                CHIUDI
            </div>
        </div>
    </div>
    
    <div class="m-toast-container" id="m-toast-area"></div>

</div>
`;

// --- LOGIC ---

let mCurrentService = 'rd';
let mScQuality = 'all';
let mSortMode = 'balanced';
let mSkin = 'leviathan';
let mLangMode = 'ita';
const mDebridValidationState = {
    timer: null,
    requestId: 0,
    status: 'idle',
    resolvedKey: '',
    resolvedService: ''
};

const fluxData = {
    'balanced': {
        title: "STANDARD MODE",
        desc: "L'algoritmo standard di Leviathan. Bilancia qualita, popolarita del file e velocita.",
        icon: "fa-dragon"
    },
    'resolution': {
        title: "VISUAL FIDELITY",
        desc: "Gerarchia visiva rigida. I risultati 4K UHD appariranno sempre in cima alla lista.",
        icon: "fa-gem"
    },
    'size': {
        title: "DATA HEAVY",
        desc: "Ordina per dimensione del file. Ideale per chi cerca il massimo bitrate possibile.",
        icon: "fa-hdd"
    }
};

const langDescriptions = {
    'ita': "Solo contenuti in Italiano. Ignora tutto il resto.",
    'all': "Cerca prima in Italiano. Se non trova nulla, mostra i risultati in Inglese.",
    'eng': "Solo contenuti in Inglese."
};

function toStylized(text, type = 'std') {
    if (!text) return "";
    text = String(text).trim();

    if (type === 'spaced') {
        return text.toUpperCase().split('').join(' ');
    }
    if (type === 'bold' || type === 'small') return text.toUpperCase();
    return text;
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
    
    if(navigator.vibrate) navigator.vibrate(20);
    
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
    leviathan: { label: 'Leviathan Core', preview: 'LEVIATHAN CORE' },
    premium: { label: 'Apex Prime', preview: 'APEX PRIME' },
    cinema: { label: 'Velvet Cinema', preview: 'VELVET CINEMA' },
    ultra_compact: { label: 'Pulse Compact', preview: 'PULSE COMPACT' },
    tv_compact: { label: 'Neon TV', preview: 'NEON TV' },
    lev2: { label: 'Architect', preview: 'ARCHITECT' },
    fra: { label: 'Horizon', preview: 'HORIZON' },
    comet: { label: 'Comet', preview: 'COMET' },
    stremio_ita: { label: 'ITA Mod', preview: 'ITA MOD' },
    dav: { label: 'Datastream', preview: 'DATASTREAM' },
    pri: { label: 'Eclipse', preview: 'ECLIPSE' },
    and: { label: 'Matrix', preview: 'MATRIX' },
    lad: { label: 'Compact', preview: 'COMPACT' },
    torrentio: { label: 'Torrentio', preview: 'TORRENTIO' },
    vertical: { label: 'Vertical', preview: 'VERTICAL' },
    android: { label: 'Console Grid', preview: 'CONSOLE GRID' },
    picture: { label: 'Jurassic Poster', preview: 'JURASSIC POSTER' },
    complex: { label: 'Template Matrix', preview: 'TEMPLATE MATRIX' },
    custom: { label: 'Custom Builder', preview: 'CUSTOM OVERRIDE' }
};

const MOBILE_FORMATTER_ALIASES = {
    default: 'leviathan',
    pro: 'premium',
    cine: 'cinema',
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
    const isAIO = document.getElementById('m-aioMode').checked;
    
    if (isAIO && skinId !== 'leviathan') {
        const lockOverlay = document.getElementById('m-aio-lock-overlay');
        lockOverlay.classList.remove('m-denied-anim');
        void lockOverlay.offsetWidth; 
        lockOverlay.classList.add('m-denied-anim');
        
        if(navigator.vibrate) navigator.vibrate([50, 50, 50]); 
        showToast("SKIN BLOCCATA DA AIO MODE", "warning");
        return; 
    }

    mSkin = skinId;
    document.querySelectorAll('.m-cortex-chip').forEach(b => b.classList.remove('active'));
    const selectedBtn = document.getElementById('msk_' + skinId);
    if(selectedBtn) selectedBtn.classList.add('active');
    
    const customArea = document.getElementById('m-custom-skin-area');
    if(skinId === 'custom') customArea.style.display = 'block';
    else customArea.style.display = 'none';
    
    const previewBox = document.getElementById('m-preview-box');
    if(previewBox) {
        previewBox.classList.remove('glitching');
        void previewBox.offsetWidth;
        previewBox.classList.add('glitching');
    }
    updateMobilePreview();
    updateLinkModalContent();
    if(navigator.vibrate) navigator.vibrate(10);
}

function updateMobilePreviewLegacy() {
    return updateMobilePreview();

    const skin = resolveMobileFormatterSkin(mSkin);
    let langStr = "ðŸ‡®ðŸ‡¹ ITA";
    if (mLangMode === 'all') langStr = "ðŸ‡®ðŸ‡¹ ITA â€¢ ðŸ‡¬ðŸ‡§ ENG";
    if (mLangMode === 'eng') langStr = "ðŸ‡¬ðŸ‡§ ENG";

    let serviceTag = "RD";
    if (mCurrentService === 'tb') serviceTag = 'TB';
    if (mCurrentService === 'p2p') serviceTag = 'P2P';

    let serviceIconTitle = 'ðŸ¦ˆ';
    if (serviceTag === 'RD') serviceIconTitle = 'ðŸ¬';
    else if (serviceTag === 'TB') serviceIconTitle = 'Ã¢Å¡"';

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
        audioInfo: 'TrueHD Atmos â”ƒ 7.1',
        codec: 'HEVC',
        videoTags: ['ðŸ’Ž ð—¥ð—˜ð— ð—¨ð—«', 'ðŸ‘ï¸ ð——ð—©+ð—›ð——ð—¥', 'âš™ï¸ ð—›ð—˜ð—©ð—–'],
        cleanTags: ['Remux', 'DV+HDR', 'HEVC'],
        seeders: 152,
        seedersStr: 'ðŸ‘¥ 152',
        epTag: '',
        releaseGroup: 'Leviathan',
        sourceLine: `${serviceIconTitle} [${serviceTag}] ilCorSaRoNeRo`,
        providerLabel: 'Netflix',
        streamScore: 94,
        scoreTier: 'S+',
        scoreBadge: 'ðŸ† S+ 94',
        visualMeter: 'Ã¢â€“Â°Ã¢â€“Â°Ã¢â€“Â°Ã¢â€“Â°Ã¢â€“Â°',
        featureSummary: '4K â€¢ DV+HDR â€¢ HEVC â€¢ Atmos'
    };

    const isDebrid = ['RD', 'TB'].includes(p.serviceTag);
    const statusIcon = isDebrid ? 'âš¡' : 'â˜ï¸';
    const qIcon = isDebrid ? p.serviceIconTitle : 'ðŸ¦ˆ';

    const styleLeviathan = (p) => {
        const serviceIcon = p.serviceTag === 'RD' ? 'ðŸ¬' : p.serviceTag === 'TB' ? 'âš“' : 'ðŸ¦ˆ';
        const stateIcon = isDebrid ? serviceIcon : 'â³';
        const brandName = toStylized('LEVIATHAN', 'small');
        const serviceStyled = toStylized(p.serviceTag, 'bold');
        const techLine = [...new Set([p.quality, ...p.cleanTags].filter(Boolean))].map(t => toStylized(t, 'small')).join(' â€¢ ');
        const name = `${stateIcon} ${serviceStyled} ðŸ¦‘ ${brandName}`;
        const lines = [
            `â–¶ï¸ ${toStylized(p.cleanName, 'bold')} ${p.epTag}`.trim(),
            techLine ? `ðŸ”± ${techLine}` : '',
            `ðŸ—£ï¸ ${p.lang}  |  ðŸ«§ ${p.audioTag} ${p.audioChannels}`,
            `ðŸ§² ${p.sizeString}  |  ${p.seedersStr}`,
            `${p.serviceIconTitle} ${p.displaySource} | ðŸ·ï¸ ${toStylized(p.releaseGroup, 'small')}`
        ].filter(Boolean);
        return { name, title: lines.join('\n') };
    };

    const styleComplex = (p) => ({
        name: `ðŸ”² 4K â”‚ â› ${p.sizeString}`,
        title: [
            `â˜° ${joinMobilePreviewParts([p.lang, p.audioTag, p.audioChannels], ' Â· ')}`,
            `â˜² ${joinMobilePreviewParts([p.quality, p.codec, p.cleanTags.join(' Â· ')], ' Â· ')}`,
            `â˜µ ${joinMobilePreviewParts(['Leviathan', p.releaseGroup, p.displaySource, `[${p.serviceTag}]`], ' Â· ')}`,
            `â˜¶ ${joinMobilePreviewParts([p.cleanName, p.epTag], ' Â· ')}`
        ].join('\n')
    });

    const styleAndroid = (p) => ({
        name: joinMobilePreviewParts([p.quality, 'DV+HDR', p.serviceTag], ' | '),
        title: [`ðŸŽžï¸ ${p.codec}`, `ðŸŽ§ ${p.audioTag} ${p.audioChannels}`, `âš™ï¸ ${p.displaySource}`, p.lang, p.fileTitle].join('\n')
    });

    const stylePicture = (p) => ({
        name: `âœ… UHD HDR ATMOS ${p.quality}`,
        title: [`ðŸŽ¬ ${p.cleanName}`, `âœ¨ ${p.quality} ðŸ”† DV | HDR`, `ðŸŽ§ ${p.audioTag} ðŸ”Š ${p.audioChannels}`, 'ðŸ’¿ Blu-ray Remux', `ðŸ“¦ ${p.sizeString}`, `ðŸ·ï¸ Blu-ray Remux T1 (${p.releaseGroup})`, `âš¡ Comet ${p.serviceTag}`].join('\n')
    });

    const stylePremium = (p) => ({
        name: `${statusIcon} ${p.quality} ${p.scoreBadge}`,
        title: [
            `ðŸŽ¬ ${toStylized(p.cleanName, 'bold')}`,
            `ðŸ… ${p.scoreBadge}  ${p.visualMeter}`,
            `ðŸ§ª ${[...new Set([p.quality, ...p.cleanTags, p.codec].filter(Boolean))].slice(0, 4).join(' â€¢ ')}`,
            `ðŸ”Š ${joinMobilePreviewParts([p.audioTag, p.audioChannels, p.lang])}`,
            `ðŸ“¦ ${p.sizeString} â€¢ ${p.seedersStr}`,
            `${statusIcon} ${p.displaySource} â€¢ ${p.releaseGroup} â€¢ ${p.serviceTag}`
        ].join('\n')
    });

    const styleCinema = (p) => ({
        name: joinMobilePreviewParts([qIcon, p.quality, p.cleanTags.includes('Remux') ? 'Reference' : 'Cinema'], ' '),
        title: [
            `ðŸŽžï¸ ${p.cleanName}`,
            `ðŸŒˆ ${joinMobilePreviewParts([p.cleanTags.join(' â€¢ '), p.codec])}`,
            `ðŸŽ§ ${joinMobilePreviewParts([p.audioTag, p.audioChannels, p.lang])}`,
            `ðŸ“Š ${p.scoreBadge} â€¢ ${p.visualMeter}`,
            `ðŸ“¦ ${p.sizeString} â€¢ ${p.seedersStr}`,
            `ðŸ·ï¸ ${joinMobilePreviewParts([p.displaySource, p.releaseGroup, p.providerLabel])}`
        ].join('\n')
    });

    const styleUltraCompact = (p) => ({
        name: joinMobilePreviewParts([statusIcon, p.quality, 'DV+HDR', p.serviceTag, `â€¢${p.scoreTier}`], ' '),
        title: [
            p.cleanName,
            joinMobilePreviewParts([`${p.audioTag} ${p.audioChannels}`, removeMobilePreviewEmoji(p.lang), p.sizeString]),
            joinMobilePreviewParts([p.displaySource, p.seedersStr, p.releaseGroup])
        ].join('\n')
    });

    const styleTVCompact = (p) => ({
        name: joinMobilePreviewParts([p.quality, 'DV+HDR', p.serviceTag], ' | '),
        title: [`ðŸŽžï¸ ${p.codec}`, `ðŸŽ§ ${p.audioTag} ${p.audioChannels}`, `ðŸŒ ${removeMobilePreviewEmoji(p.lang) || p.lang}`, `ðŸ… ${p.scoreBadge}`, `ðŸ“¦ ${p.sizeString} â€¢ ${p.seedersStr}`, `âš™ï¸ ${p.displaySource}`, p.fileTitle].join('\n')
    });

    const styleLeviathanTwo = (p) => ({
        name: `ðŸ¦‘ ${toStylized('LEVIATHAN', 'small')} ${p.serviceIconTitle} â”‚ ${p.quality}`,
        title: [`ðŸŽ¬ ${toStylized(p.cleanName, 'bold')}`, `ðŸ“¦ ${p.sizeString} â”‚ ${p.codec} ${p.cleanTags.filter(x => !String(x).includes(p.codec)).join(' ')}`, `ðŸ”Š ${p.audioTag} ${p.audioChannels} â€¢ ${p.lang}`, `ðŸ”— ${p.sourceLine} ${p.seedersStr}`].join('\n')
    });

    const styleFra = (p) => ({
        name: 'âš¡ï¸ Leviathan 4K',
        title: [`ðŸ“„ â¯ ${p.fileTitle}`, `ðŸŒŽ â¯ ${p.lang} â€¢ ${p.audioTag}`, `âœ¨ â¯ ${p.serviceTag} â€¢ ${p.displaySource}`, `ðŸ”¥ â¯ ${p.quality} â€¢ ${p.cleanTags.join(' â€¢ ')}`, `ðŸ’¾ â¯ ${p.sizeString} / ðŸ‘¥ â¯ ${p.seeders}`].join('\n')
    });

    const styleDav = (p) => ({
        name: 'ðŸŽ¥ 4K UHD HEVC',
        title: [`ðŸ“º ${p.cleanName}`, `ðŸŽ§ ${p.audioTag} ${p.audioChannels} | ðŸŽžï¸ ${p.codec}`, `ðŸ—£ï¸ ${p.lang} | ðŸ“¦ ${p.sizeString}`, `â±ï¸ ${p.seeders} Seeds | ðŸ·ï¸ ${p.displaySource}`, `${p.serviceIconTitle} Leviathan ðŸ“¡ ${p.serviceTag}`, `ðŸ“‚ ${p.fileTitle}`].join('\n')
    });

    const styleAnd = (p) => ({
        name: `ðŸŽ¬ ${p.cleanName}`,
        title: [`${p.quality} ${p.serviceTag === 'RD' ? 'âš¡' : 'â³'}`, 'â”€ â”€ â”€ â”€ â”€ â”€ â”€ â”€ â”€ â”€', `Lingue: ${p.lang}`, `Specifiche: ${p.quality} | ðŸ“º ${p.cleanTags.join(' ')} | ðŸ”Š ${p.audioTag}`, 'â”€ â”€ â”€ â”€ â”€ â”€ â”€ â”€ â”€ â”€', `ðŸ“‚ ${p.sizeString} | â˜ï¸ ${p.serviceTag} | ðŸ›°ï¸ Leviathan`].join('\n')
    });

    const styleLad = (p) => ({
        name: `ðŸ–¥ï¸ ${p.quality} ${p.serviceTag}`,
        title: [`ðŸŽŸï¸ ${p.cleanName}`, `ðŸ“œ ${p.epTag || 'Movie'}`, `ðŸŽ¥ ${p.quality} ðŸŽžï¸ ${p.codec} ðŸŽ§ ${p.audioTag}`, `ðŸ“¦ ${p.sizeString} â€¢ ðŸ”— Leviathan`, `ðŸŒ ${p.lang}`].join('\n')
    });

    const stylePri = (p) => ({
        name: `[${p.serviceTag}]âš¡ï¸â˜ï¸
4KðŸ”¥UHD
[Leviathan]`,
        title: [`ðŸŽ¬ ${p.cleanName}`, `${p.cleanTags.join(' ')}`, `ðŸŽ§ ${p.audioTag} | ðŸ”Š ${p.audioChannels} | ðŸ—£ï¸ ${p.lang}`, `ðŸ“ ${p.sizeString} | ðŸ·ï¸ ${p.displaySource}`, `ðŸ“„ â–¶ï¸ ${p.fileTitle} â—€ï¸`].join('\n')
    });

    const styleComet = (p) => ({
        name: `[${p.serviceTag} Ã¢Å¡Â¡]
Leviathan
${p.quality}`,
        title: [`ðŸ“„ ${p.fileTitle}`, `ðŸ“¹ ${joinMobilePreviewParts([p.codec, ...p.cleanTags].filter(Boolean))} | ${p.audioTag}`, `â­ ${p.displaySource}`, `ðŸ’¾ ${p.sizeString} ðŸ‘¥ ${p.seeders}`, `ðŸŒ ${p.lang}`].join('\n')
    });

    const styleStremioIta = (p) => ({
        name: 'âš¡ï¸ Leviathan 4K',
        title: [`ðŸ“„ â¯ ${p.fileTitle}`, `ðŸŒŽ â¯ ${p.lang.replace(/ITA/gi, 'ita').replace(/ENG/gi, 'eng')}`, `âœ¨ â¯ ${p.serviceTag} â€¢ ${p.displaySource}`, `ðŸ”¥ â¯ ${p.quality} â€¢ ${p.cleanTags.join(' â€¢ ')}`, `ðŸ’¾ â¯ ${p.sizeString}`, `ðŸ”‰ â¯ ${p.audioTag} â€¢ ${p.audioChannels}`].join('\n')
    });

    const styleTorrentio = (p) => ({
        name: `[${p.serviceTag}]
${p.quality}`,
        title: [`ðŸ“„ ${p.fileTitle}`, `ðŸ“¦ ${p.sizeString} ðŸ‘¤ ${p.seeders}`, `ðŸ” ${p.displaySource}`, `ðŸ”Š ${removeMobilePreviewEmoji(p.lang) || p.lang}`].join('\n')
    });

    const styleVertical = (p) => ({
        name: `ðŸ¦‘ Leviathan ${p.quality} ${isDebrid ? 'âš¡' : 'â˜ï¸'} Cached`,
        title: [`ðŸ¿ ${p.cleanName}`, `ðŸ“¼ WEB-DL â€¢ ${p.cleanTags[0]}`, `âš™ï¸ ${p.codec}`, `ðŸ”Š ${p.audioTag} (${p.audioChannels})`, `ðŸ’¬ ${p.lang}`, `ðŸ§² ${p.sizeString}`].join('\n')
    });

    const styleCustom = (p) => {
        let tpl = document.getElementById('m-customTemplate').value || 'Apex {quality} {score_badge} ||| {title}{n}{summary}';
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
        Object.keys(vars).forEach(key => {
            tpl = tpl.replace(new RegExp(key.replace(/[{}]/g, '\$&'), 'g'), vars[key]);
        });
        tpl = tpl.replace(/\n/g, '\n');
        if (tpl.includes('|||')) {
            const parts = tpl.split('|||');
            return { name: parts[0].trim(), title: parts[1].trim() };
        }
        return { name: `Leviathan ${p.quality}`, title: tpl };
    };

    const result = ({
        premium: stylePremium,
        cinema: styleCinema,
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
    }[skin] || styleLeviathan)(p);

    document.getElementById('m-prev-mode').innerText = getMobileFormatterMeta(skin).preview;
    document.getElementById('m-prev-title').innerText = result.name;
    document.getElementById('m-prev-info').innerText = result.title;
}

function updateMobilePreview() {
    const skin = resolveMobileFormatterSkin(mSkin);
    let langStr = 'ITA';
    if (mLangMode === 'all') langStr = 'ITA + ENG';
    if (mLangMode === 'eng') langStr = 'ENG';

    let serviceTag = 'RD';
    if (mCurrentService === 'tb') serviceTag = 'TB';
    if (mCurrentService === 'p2p') serviceTag = 'P2P';

    let serviceName = 'Real-Debrid';
    if (serviceTag === 'TB') serviceName = 'TorBox';
    if (serviceTag === 'P2P') serviceName = 'P2P';

    const p = {
        cleanName: 'Dune Parte Due',
        fileTitle: 'Dune.Parte.Due.2024.2160p.ITA.ENG.TrueHD.7.1.x265-Leviathan',
        quality: '4K',
        sizeString: '67.81 GB',
        displaySource: 'ilCorSaRoNeRo',
        serviceTag,
        serviceName,
        lang: langStr,
        audioTag: 'TrueHD Atmos',
        audioChannels: '7.1',
        audioInfo: 'TrueHD Atmos | 7.1',
        codec: 'HEVC',
        cleanTags: ['Remux', 'DV+HDR', 'HEVC'],
        seeders: 152,
        seedersStr: '152 seeds',
        epTag: '',
        releaseGroup: 'Leviathan',
        sourceLine: `[${serviceTag}] ilCorSaRoNeRo`,
        providerLabel: 'Netflix',
        streamScore: 94,
        scoreTier: 'S+',
        scoreBadge: 'S+ 94',
        visualMeter: '|||||',
        featureSummary: '4K | DV+HDR | HEVC | Atmos'
    };

    const isDebrid = ['RD', 'TB'].includes(p.serviceTag);
    const deliveryLabel = isDebrid ? 'INSTANT' : 'DIRECT';
    const techLine = joinMobilePreviewParts([p.quality, ...p.cleanTags, p.codec], ' | ');
    const audioLine = joinMobilePreviewParts([p.audioTag, p.audioChannels, p.lang], ' | ');
    const sizeLine = joinMobilePreviewParts([p.sizeString, p.seedersStr], ' | ');
    const sourceLine = joinMobilePreviewParts([p.displaySource, p.releaseGroup, p.serviceTag], ' | ');

    const styles = {
        premium: {
            name: `${deliveryLabel} ${p.quality} ${p.scoreBadge}`,
            title: [`TITLE | ${p.cleanName}`, `SCORE | ${p.scoreBadge} ${p.visualMeter}`, `VIDEO | ${techLine}`, `AUDIO | ${audioLine}`, `SIZE | ${sizeLine}`, `SOURCE | ${sourceLine}`].join('\n')
        },
        cinema: {
            name: `${p.quality} | REFERENCE | ${p.serviceTag}`,
            title: [`TITLE | ${p.cleanName}`, `VIDEO | ${techLine}`, `AUDIO | ${audioLine}`, `SCORE | ${p.scoreBadge}`, `SIZE | ${sizeLine}`, `SOURCE | ${joinMobilePreviewParts([p.displaySource, p.releaseGroup, p.providerLabel])}`].join('\n')
        },
        ultra_compact: {
            name: `${p.quality} | DV+HDR | ${p.serviceTag} | ${p.scoreTier}`,
            title: [p.cleanName, joinMobilePreviewParts([`${p.audioTag} ${p.audioChannels}`, removeMobilePreviewEmoji(p.lang), p.sizeString]), joinMobilePreviewParts([p.displaySource, p.seedersStr, p.releaseGroup])].join('\n')
        },
        tv_compact: {
            name: `${p.quality} | TV | ${p.serviceTag}`,
            title: [`VIDEO | ${p.codec}`, `AUDIO | ${p.audioTag} ${p.audioChannels}`, `LANG | ${p.lang}`, `SCORE | ${p.scoreBadge}`, `SIZE | ${sizeLine}`, `SOURCE | ${p.displaySource}`, p.fileTitle].join('\n')
        },
        lev2: {
            name: `LEVIATHAN ${p.serviceTag} | ${p.quality}`,
            title: [`TITLE | ${toStylized(p.cleanName, 'bold')}`, `VIDEO | ${p.sizeString} | ${p.codec}`, `AUDIO | ${audioLine}`, `SOURCE | ${p.sourceLine} | ${p.seedersStr}`].join('\n')
        },
        fra: {
            name: 'LEVIATHAN 4K',
            title: [`FILE | ${p.fileTitle}`, `LANG | ${p.lang} | ${p.audioTag}`, `SOURCE | ${p.serviceTag} | ${p.displaySource}`, `VIDEO | ${techLine}`, `SIZE | ${p.sizeString} / SEEDS | ${p.seeders}`].join('\n')
        },
        dav: {
            name: '4K UHD HEVC',
            title: [`TITLE | ${p.cleanName}`, `AUDIO | ${p.audioTag} ${p.audioChannels} | VIDEO | ${p.codec}`, `LANG | ${p.lang} | SIZE | ${p.sizeString}`, `SEEDS | ${p.seeders} | SOURCE | ${p.displaySource}`, `${p.serviceName} | Leviathan | ${p.serviceTag}`, `FILE | ${p.fileTitle}`].join('\n')
        },
        and: {
            name: p.cleanName,
            title: [`${p.quality} ${deliveryLabel}`, '--------------------', `Lingue: ${p.lang}`, `Specifiche: ${p.quality} | ${p.cleanTags.join(' ')} | ${p.audioTag}`, '--------------------', `File: ${p.sizeString} | ${p.serviceTag} | Leviathan`].join('\n')
        },
        lad: {
            name: `${p.quality} ${p.serviceTag}`,
            title: [`TITLE | ${p.cleanName}`, `TYPE | ${p.epTag || 'Movie'}`, `VIDEO | ${p.quality} | ${p.codec} | AUDIO | ${p.audioTag}`, `SIZE | ${p.sizeString} | Leviathan`, `LANG | ${p.lang}`].join('\n')
        },
        pri: {
            name: `[${p.serviceTag}] ${p.quality} UHD [Leviathan]`,
            title: [`TITLE | ${p.cleanName}`, `${p.cleanTags.join(' ')}`, `AUDIO | ${p.audioTag} | ${p.audioChannels} | LANG | ${p.lang}`, `SIZE | ${p.sizeString} | SOURCE | ${p.displaySource}`, `FILE | ${p.fileTitle}`].join('\n')
        },
        comet: {
            name: `[${p.serviceTag}] Leviathan ${p.quality}`,
            title: [`FILE | ${p.fileTitle}`, `VIDEO | ${techLine} | ${p.audioTag}`, `SOURCE | ${p.displaySource}`, `SIZE | ${sizeLine}`, `LANG | ${p.lang}`].join('\n')
        },
        stremio_ita: {
            name: 'LEVIATHAN 4K',
            title: [`FILE | ${p.fileTitle}`, `LANG | ${p.lang.toLowerCase()}`, `SOURCE | ${p.serviceTag} | ${p.displaySource}`, `VIDEO | ${techLine}`, `SIZE | ${p.sizeString}`, `AUDIO | ${p.audioTag} | ${p.audioChannels}`].join('\n')
        },
        torrentio: {
            name: `[${p.serviceTag}]\n${p.quality}`,
            title: [`FILE | ${p.fileTitle}`, `SIZE | ${p.sizeString} | SEEDS | ${p.seeders}`, `SOURCE | ${p.displaySource}`, `LANG | ${p.lang}`].join('\n')
        },
        vertical: {
            name: `Leviathan ${p.quality} ${deliveryLabel}`,
            title: [`TITLE | ${p.cleanName}`, `VIDEO | WEB-DL | ${p.cleanTags[0]}`, `CODEC | ${p.codec}`, `AUDIO | ${p.audioTag} (${p.audioChannels})`, `LANG | ${p.lang}`, `SIZE | ${p.sizeString}`].join('\n')
        },
        complex: {
            name: `MATRIX | ${p.quality} | ${p.sizeString}`,
            title: [`AUDIO | ${audioLine}`, `VIDEO | ${techLine}`, `SOURCE | ${joinMobilePreviewParts(['Leviathan', p.releaseGroup, p.displaySource, `[${p.serviceTag}]`], ' | ')}`, `TITLE | ${joinMobilePreviewParts([p.cleanName, p.epTag], ' | ')}`].join('\n')
        },
        android: {
            name: joinMobilePreviewParts([p.quality, 'DV+HDR', p.serviceTag], ' | '),
            title: [`VIDEO | ${p.codec}`, `AUDIO | ${p.audioTag} ${p.audioChannels}`, `SOURCE | ${p.displaySource}`, p.lang, p.fileTitle].join('\n')
        },
        picture: {
            name: `UHD HDR ATMOS ${p.quality}`,
            title: [`TITLE | ${p.cleanName}`, `VIDEO | ${p.quality} | DV | HDR`, `AUDIO | ${p.audioTag} | ${p.audioChannels}`, 'SOURCE | Blu-ray Remux', `SIZE | ${p.sizeString}`, `GROUP | Blu-ray Remux T1 (${p.releaseGroup})`, `DELIVERY | ${deliveryLabel} ${p.serviceTag}`].join('\n')
        }
    };

    const styleCustom = () => {
        let tpl = document.getElementById('m-customTemplate').value || 'Apex {quality} {score_badge} ||| {title}{n}{summary}';
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
            tpl = tpl.replace(new RegExp(key.replace(/[{}]/g, '\\$&'), 'g'), vars[key]);
        });
        if (tpl.includes('|||')) {
            const parts = tpl.split('|||');
            return { name: parts[0].trim(), title: parts[1].trim() };
        }
        return { name: `Leviathan ${p.quality}`, title: tpl };
    };

    const result = skin === 'custom'
        ? styleCustom()
        : (styles[skin] || {
            name: `${toStylized(p.serviceTag, 'bold')} ${toStylized('Leviathan', 'small')} | ${p.quality}`,
            title: [`${toStylized(p.cleanName, 'bold')} ${p.epTag}`.trim(), techLine, audioLine, sizeLine, sourceLine].join('\n')
        });

    document.getElementById('m-prev-mode').innerText = getMobileFormatterMeta(skin).preview;
    document.getElementById('m-prev-title').innerText = result.name;
    document.getElementById('m-prev-info').innerText = result.title;
}

function toggleMobileAIOLock() {
    const isAIO = document.getElementById('m-aioMode').checked;
    const lock = document.getElementById('m-aio-lock-overlay');
    if(isAIO) lock.classList.add('active');
    else lock.classList.remove('active');
}

function createLogoParticles() {
    const container = document.getElementById('logoParticles');
    if(!container) return;
    const count = document.body.classList.contains('m-lowfx') ? 0 : 5;
    container.innerHTML = '';
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
    if(!container) return;
    const isLowFx = document.body.classList.contains('m-lowfx');
    const count = isLowFx ? 0 : 14;
    container.innerHTML = '';
    for(let i = 0; i < count; i++) {
        const p = document.createElement('div');
        p.className = 'm-ocean-particle';
        const size = Math.random() * 3 + 1.5;
        p.style.width = `${size}px`;
        p.style.height = `${size}px`;
        p.style.left = `${Math.random() * 100}%`;
        p.style.animationDuration = `${Math.random() * 14 + 14}s`;
        p.style.animationDelay = `-${Math.random() * 18}s`;
        if (Math.random() > 0.7) {
            p.style.background = 'radial-gradient(circle, rgba(176, 38, 255, 0.85) 0%, rgba(112, 0, 255, 0.15) 60%, transparent 100%)';
            p.style.boxShadow = '0 0 6px rgba(176, 38, 255, 0.5)';
        }
        container.appendChild(p);
    }
}

function initMobileInterface() {
    ensureMobileLogoHints();
    primeMobileLogo();

    const styleSheet = document.createElement("style");
    styleSheet.innerText = mobileCSS;
    document.head.appendChild(styleSheet);

    document.body.innerHTML = mobileHTML;
    applyMobilePerformanceMode();
    hydrateMobileLogo();
    createLogoParticles();
    createOceanParticles();
    initPullToRefresh();
    loadMobileConfig();
    updateMobilePreview();
}

function initPullToRefresh() {
    const content = document.querySelector('.m-content');
    const ptr = document.getElementById('m-ptr-indicator');
    const icon = ptr.querySelector('i');
    let startY = 0;
    let pulling = false;
    let threshold = 80;
    let rAF = null;

    content.addEventListener('touchstart', (e) => {
        if (content.scrollTop === 0) { startY = e.touches[0].pageY; pulling = true; }
    }, {passive: true});

    content.addEventListener('touchmove', (e) => {
        if (!pulling) return;
        const currentY = e.touches[0].pageY;
        const diff = currentY - startY;

        if (diff > 0 && content.scrollTop <= 0) {
            if (rAF) return;
            rAF = requestAnimationFrame(() => {
                ptr.style.opacity = Math.min(diff / 100, 1);
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
        const currentY = e.changedTouches[0].pageY;
        const diff = currentY - startY;
        
        if (diff > threshold && content.scrollTop <= 0) {
            ptr.classList.add('loading');
            ptr.style.transform = `translate3d(0, 50px, 0)`;
            if (navigator.vibrate) navigator.vibrate(50);
            setTimeout(() => { location.reload(); }, 500);
        } else {
            ptr.style.transform = ''; ptr.style.opacity = 0;
        }
        if(rAF) { cancelAnimationFrame(rAF); rAF = null; }
    });
}

function navTo(pageId, btn) {
    document.querySelectorAll('.m-page').forEach(p => p.classList.remove('active'));
    document.getElementById('page-' + pageId).classList.add('active');
    document.querySelectorAll('.m-nav-item').forEach(i => i.classList.remove('active'));
    if(btn) btn.classList.add('active');
    document.querySelector('.m-content').scrollTop = 0;
    if(navigator.vibrate) navigator.vibrate(10);
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
    const key = String(document.getElementById('m-apiKey')?.value || '').trim();
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
    if (!keepInput) { document.getElementById('m-apiKey').value = ''; }

    document.querySelectorAll('.m-srv-btn').forEach(b => {
        b.classList.remove('active');
    });
    if(btn) {
        btn.classList.add('active');
    }
    
    const input = document.getElementById('m-apiKey');
    const box = document.getElementById('box-apikey');
    
    if (srv === 'p2p') {
        input.placeholder = "P2P BYPASS MODE";
        input.disabled = true;
        if(box) box.classList.add('is-p2p');
    } else {
        const placeholders = { 'rd': "INCOLLA RD KEY...", 'tb': "INCOLLA TB KEY..." };
        input.placeholder = placeholders[srv];
        input.disabled = false;
        if(box) box.classList.remove('is-p2p');
    }

    updateMobilePreview(); 
    scheduleMobileDebridValidation({ force: true });
    updateLinkModalContent();
    if(navigator.vibrate) navigator.vibrate(10);
}

function updateStatus(inputId, statusId) {
    const chk = document.getElementById(inputId).checked;
    const lbl = document.getElementById(statusId);
    if(lbl) {
        lbl.innerText = chk ? "ON" : "OFF";
        if(chk) lbl.classList.add('on'); else lbl.classList.remove('on');
    }
    
    if(inputId === 'm-enableVix') toggleScOptions();
    if(inputId === 'm-aioMode') toggleMobileAIOLock();
    checkWebPriorityVisibility();
    updateLinkModalContent();
    if(navigator.vibrate) navigator.vibrate(10);
}

function setLangMode(mode) {
    mLangMode = mode;
    const btnIta = document.getElementById('lang-ita');
    const btnHyb = document.getElementById('lang-all');
    const btnEng = document.getElementById('lang-eng');

    // Reset Classes
    [btnIta, btnHyb, btnEng].forEach(b => {
        b.className = 'm-lang-opt';
    });

    // Apply specific Active Class
    if(mode === 'ita') btnIta.classList.add('active-ita');
    if(mode === 'all') btnHyb.classList.add('active-hyb');
    if(mode === 'eng') btnEng.classList.add('active-eng');

    const descEl = document.getElementById('lang-description');
    if(descEl) {
        descEl.style.opacity = 0;
        setTimeout(() => {
            descEl.innerText = langDescriptions[mode];
            descEl.style.opacity = 1;
        }, 200);
    }
    updateMobilePreview();
    updateLinkModalContent();
    if(navigator.vibrate) navigator.vibrate(10);
}

function checkWebPriorityVisibility() {
    const vix = document.getElementById('m-enableVix').checked;
    const ghd = document.getElementById('m-enableGhd').checked;
    const gs = document.getElementById('m-enableGs').checked;
    const aw = document.getElementById('m-enableAnimeWorld').checked;
    const au = document.getElementById('m-enableAnimeUnity').checked;
    const as = document.getElementById('m-enableAnimeSaturn').checked;
    const gf = document.getElementById('m-enableGf').checked;
    const cc = document.getElementById('m-enableCc').checked;
    const panel = document.getElementById('m-priority-panel');
    if (vix || ghd || gs || aw || au || as || gf || cc) panel.classList.add('show');
    else panel.classList.remove('show');
}

function updatePriorityLabel() {
    const isLast = document.getElementById('m-vixLast').checked;
    const desc = document.getElementById('priority-desc');
    desc.innerText = isLast ? "Priorita bassa: risultati dopo i torrent" : "Priorita alta: risultati in cima";
    desc.style.color = isLast ? "var(--m-secondary)" : "var(--m-primary)";
    updateLinkModalContent();
    if(navigator.vibrate) navigator.vibrate([15, 10, 15]);
}

function toggleScOptions() {
    const chk = document.getElementById('m-enableVix').checked;
    const opts = document.getElementById('m-sc-options');
    opts.style.display = chk ? 'block' : 'none';
    
    const lbl = document.getElementById('st-vix');
    if(lbl) {
        lbl.innerText = chk ? "ON" : "OFF";
        if(chk) lbl.classList.add('on'); else lbl.classList.remove('on');
    }
    checkWebPriorityVisibility(); 
}

function toggleGate() {
    const active = document.getElementById('m-gateActive').checked;
    const wrapper = document.getElementById('m-gate-wrapper');
    const lbl = document.getElementById('st-gate');
    
    if(active) { 
        wrapper.classList.add('show'); 
        if(lbl) {lbl.innerText = "ON"; lbl.classList.add('on');}
        showToast("Signal Gate Attivo: Risultati Limitati", "warning");
    } else { 
        wrapper.classList.remove('show'); 
        if(lbl) {lbl.innerText = "OFF"; lbl.classList.remove('on');}
    }
    updateLinkModalContent();
    if(navigator.vibrate) navigator.vibrate(10);
}

function updateGateDisplay(val) { document.getElementById('m-gate-display').innerText = val; updateLinkModalContent(); }

function toggleSize() {
    const active = document.getElementById('m-sizeActive').checked;
    const wrapper = document.getElementById('m-size-wrapper');
    const lbl = document.getElementById('st-size');
    const slider = document.getElementById('m-sizeVal');
    
    if(active) { 
        wrapper.classList.add('show'); 
        if(lbl) {lbl.innerText = "ON"; lbl.classList.add('on');}
        updateSizeDisplay(slider.value);
    } else { 
        wrapper.classList.remove('show'); 
        if(lbl) {lbl.innerText = "OFF"; lbl.classList.remove('on');}
        document.getElementById('m-size-display').innerText = "INF";
    }
    updateLinkModalContent();
    if(navigator.vibrate) navigator.vibrate(10);
}

function updateSizeDisplay(val) {
    const display = document.getElementById('m-size-display');
    if (val == 0) { display.innerText = "INF"; } else { display.innerText = val; }
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
    if(navigator.vibrate) navigator.vibrate(10);
}

function setSortMode(mode) {
    mSortMode = mode;
    ['balanced', 'resolution', 'size'].forEach(m => {
        const btn = document.getElementById('sort-' + m);
        const map = {'balanced':'active-bal', 'resolution':'active-res', 'size':'active-sz'};
        
        // Remove ALL active classes
        btn.classList.remove('active-bal', 'active-res', 'active-sz');
        
        if(m === mode) btn.classList.add(map[m]);
    });
    
    const readout = document.getElementById('flux-readout-box');
    const title = document.getElementById('flux-title-display');
    const desc = document.getElementById('flux-desc-display');
    const icon = document.getElementById('flux-icon-display');
    
    readout.className = "m-flux-readout"; 
    
    // Tiny fade effect
    readout.style.opacity = 0.5;
    setTimeout(() => {
        if(mode === 'balanced') readout.classList.add('mode-bal');
        if(mode === 'resolution') readout.classList.add('mode-res');
        if(mode === 'size') readout.classList.add('mode-sz');
        
        title.innerText = fluxData[mode].title;
        desc.innerText = fluxData[mode].desc;
        icon.className = `fas ${fluxData[mode].icon} m-fr-icon`;
        
        readout.style.opacity = 1;
    }, 150);

    updateLinkModalContent();
    if(navigator.vibrate) navigator.vibrate(10);
}

function updateGhostVisuals() {
    const chk = document.getElementById('m-proxyDebrid').checked;
    const box = document.getElementById('ghost-zone-box');
    const txt = document.getElementById('ghost-status-text');
    
    if(chk) {
        box.classList.add('active');
        if(txt) txt.innerText = "STEALTH";
    } else {
        box.classList.remove('active');
        if(txt) txt.innerText = "VISIBLE";
    }
    
    const lbl = document.getElementById('st-ghost');
    if(lbl) {
         lbl.innerText = chk ? "ON" : "OFF";
         if(chk) lbl.classList.add('on'); else lbl.classList.remove('on');
    }
    if(navigator.vibrate) navigator.vibrate(15);
}

function toggleModuleStyle(inputId, boxId) {
    const chk = document.getElementById(inputId).checked;
    const box = document.getElementById(boxId);
    if(box) {
        if(chk) box.classList.add('active');
        else box.classList.remove('active');
    }
    updateLinkModalContent();
}

function toggleFilter(id) { 
    document.getElementById(id).classList.toggle('excluded'); 
    const isExcluded = document.getElementById(id).classList.contains('excluded');
    if(isExcluded) {
        if(navigator.vibrate) navigator.vibrate(20);
        triggerPreviewUpdateEffect();
    }
    updateLinkModalContent();
}

async function pasteTo(id) {
    const input = document.getElementById(id);
    if (input.disabled) return;
    try {
        const text = await navigator.clipboard.readText();
        input.value = text;
        if(id === 'm-apiKey') scheduleMobileDebridValidation({ force: true });
        updateLinkModalContent();
        
        // Find button relative to input wrapper now
        let btn = null;
        const wrapper = input.closest('.m-if-inner') || input.parentElement;
        if(wrapper) btn = wrapper.querySelector('.m-if-action .fa-paste')?.parentElement;
        if(!btn) btn = wrapper.querySelector('.m-paste-action'); // fallback

        if(btn) {
            const originalHTML = btn.innerHTML;
            btn.innerHTML = '<i class="fas fa-check"></i>';
            setTimeout(() => btn.innerHTML = originalHTML, 1500);
        }
        showToast("INCOLLATO CON SUCCESSO", "success");
    } catch (err) { alert("Impossibile accedere agli appunti. Incolla manualmente."); }
}

function loadMobileConfig() {
    try {
        const pathParts = window.location.pathname.split('/');
        if (pathParts.length >= 2 && pathParts[1].length > 10) {
            const config = JSON.parse(atob(pathParts[1]));
            if(config.service) {
                const srvMap = {'rd':0, 'tb':1}; 
                // Updated selector for new structure
                const railBtns = document.querySelectorAll('#page-setup .m-srv-btn');
                if(railBtns.length > 0 && srvMap[config.service] !== undefined) {
                     setMService(config.service, railBtns[srvMap[config.service]], true);
                }
            } else if (config.filters && config.filters.enableP2P) {
                 // Select P2P if active and no service
                 const railBtns = document.querySelectorAll('#page-setup .m-srv-btn');
                 setMService('p2p', railBtns[2], true);
            }

            if(config.key) document.getElementById('m-apiKey').value = config.key;

            if(config.tmdb) document.getElementById('m-tmdb').value = config.tmdb;
            if(config.aiostreams_mode) document.getElementById('m-aioMode').checked = true;
            
            if(config.sort) setSortMode(config.sort);
            else setSortMode('balanced');
            
            if(config.formatter) selectMobileSkin(config.formatter);
            if(config.customTemplate) document.getElementById('m-customTemplate').value = config.customTemplate;

            if(config.mediaflow) {
                document.getElementById('m-mfUrl').value = config.mediaflow.url || "";
                document.getElementById('m-mfPass').value = config.mediaflow.pass || "";
                document.getElementById('m-proxyDebrid').checked = config.mediaflow.proxyDebrid || false;
            }
            if(config.filters) {
                document.getElementById('m-enableVix').checked = config.filters.enableVix || false;
                toggleModuleStyle('m-enableVix', 'mod-vix');

                document.getElementById('m-enableGhd').checked = config.filters.enableGhd || false;
                toggleModuleStyle('m-enableGhd', 'mod-ghd');

                document.getElementById('m-enableGs').checked = config.filters.enableGs || false;
                toggleModuleStyle('m-enableGs', 'mod-gs');
                
                document.getElementById('m-enableAnimeWorld').checked = config.filters.enableAnimeWorld || false;
                toggleModuleStyle('m-enableAnimeWorld', 'mod-aw');

                document.getElementById('m-enableAnimeUnity').checked = config.filters.enableAnimeUnity || false;
                toggleModuleStyle('m-enableAnimeUnity', 'mod-au');

                document.getElementById('m-enableAnimeSaturn').checked = config.filters.enableAnimeSaturn || false;
                toggleModuleStyle('m-enableAnimeSaturn', 'mod-as');

                document.getElementById('m-enableGf').checked = config.filters.enableGf || false;
                toggleModuleStyle('m-enableGf', 'mod-gf');

                document.getElementById('m-enableCc').checked = config.filters.enableCc || false;
                toggleModuleStyle('m-enableCc', 'mod-cc');

                if(config.filters.language) {
                    setLangMode(config.filters.language);
                } else {
                    setLangMode(config.filters.allowEng ? 'all' : 'ita');
                }

                document.getElementById('m-enableTrailers').checked = config.filters.enableTrailers || false;
                
                if(config.filters.vixLast) {
                    document.getElementById('m-vixLast').checked = true;
                    updatePriorityLabel();
                }

                const qMap = {'no4k':'mq-4k', 'no1080':'mq-1080', 'no720':'mq-720', 'noScr':'mq-sd'};
                for(let k in qMap) if(config.filters[k]) document.getElementById(qMap[k]).classList.add('excluded');
                if(config.filters.scQuality) setScQuality(config.filters.scQuality);
                
                if(config.filters.maxPerQuality && config.filters.maxPerQuality > 0) {
                    const val = config.filters.maxPerQuality;
                    document.getElementById('m-gateActive').checked = true;
                    document.getElementById('m-gateVal').value = val;
                    updateGateDisplay(val);
                    toggleGate();
                } else {
                    document.getElementById('m-gateActive').checked = false;
                    toggleGate();
                }

                if(config.filters.maxSizeGB && config.filters.maxSizeGB > 0) {
                    const valGB = config.filters.maxSizeGB;
                    document.getElementById('m-sizeActive').checked = true;
                    document.getElementById('m-sizeVal').value = valGB;
                    updateSizeDisplay(valGB);
                    toggleSize();
                } else {
                    document.getElementById('m-sizeActive').checked = false;
                    toggleSize();
                }
            }
            
            updateStatus('m-enableVix', 'st-vix');
            updateStatus('m-enableGhd', 'st-ghd');
            updateStatus('m-enableGs', 'st-gs');
            updateStatus('m-enableAnimeWorld', 'st-aw');
            updateStatus('m-enableAnimeUnity', 'st-au');
            updateStatus('m-enableAnimeSaturn', 'st-as');
            updateStatus('m-enableGf', 'st-gf');
            updateStatus('m-enableCc', 'st-cc');
            updateStatus('m-aioMode', 'st-aio');
            updateStatus('m-enableTrailers', 'st-trailer');
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
    const gateActive = document.getElementById('m-gateActive').checked;
    const gateVal = parseInt(document.getElementById('m-gateVal').value);
    const sizeActive = document.getElementById('m-sizeActive').checked;
    const sizeVal = parseInt(document.getElementById('m-sizeVal').value);
    const finalMaxSizeGB = sizeActive ? sizeVal : 0;
    
    const isP2P = mCurrentService === 'p2p';
    const apiKey = document.getElementById('m-apiKey').value.trim();
    const webOnlyService = (
        !isP2P
        && !apiKey
        && (
            document.getElementById('m-enableVix').checked
            || document.getElementById('m-enableGhd').checked
            || document.getElementById('m-enableGs').checked
            || document.getElementById('m-enableAnimeWorld').checked
            || document.getElementById('m-enableAnimeUnity').checked
            || document.getElementById('m-enableAnimeSaturn').checked
            || document.getElementById('m-enableGf').checked
            || document.getElementById('m-enableCc').checked
        )
    );

    return {
        service: isP2P ? '' : (webOnlyService ? 'web' : mCurrentService),
        key: apiKey,
        tmdb: document.getElementById('m-tmdb').value.trim(),
        sort: mSortMode, 
        formatter: mSkin, 
        customTemplate: document.getElementById('m-customTemplate').value,
        aiostreams_mode: document.getElementById('m-aioMode').checked,
        mediaflow: {
            url: document.getElementById('m-mfUrl').value.trim().replace(/\/$/, ""),
            pass: document.getElementById('m-mfPass').value.trim(),
            proxyDebrid: document.getElementById('m-proxyDebrid').checked
        },
        filters: {
            language: mLangMode,
            allowEng: (mLangMode === 'all' || mLangMode === 'eng'), 
            enableP2P: isP2P,
            no4k: document.getElementById('mq-4k').classList.contains('excluded'),
            no1080: document.getElementById('mq-1080').classList.contains('excluded'),
            no720: document.getElementById('mq-720').classList.contains('excluded'),
            noScr: document.getElementById('mq-sd').classList.contains('excluded'),
            noCam: document.getElementById('mq-sd').classList.contains('excluded'),
            enableVix: document.getElementById('m-enableVix').checked,
            enableGhd: document.getElementById('m-enableGhd').checked,
            enableGs: document.getElementById('m-enableGs').checked,
            enableAnimeWorld: document.getElementById('m-enableAnimeWorld').checked,
            enableAnimeUnity: document.getElementById('m-enableAnimeUnity').checked,
            enableAnimeSaturn: document.getElementById('m-enableAnimeSaturn').checked,
            enableGf: document.getElementById('m-enableGf').checked,
            enableCc: document.getElementById('m-enableCc').checked,
            enableTrailers: document.getElementById('m-enableTrailers').checked,
            vixLast: document.getElementById('m-vixLast').checked,
            scQuality: mScQuality,
            maxPerQuality: gateActive ? gateVal : 0,
            maxSizeGB: finalMaxSizeGB > 0 ? finalMaxSizeGB : null
        }
    };
}

function updateLinkModalContent() {
    const box = document.getElementById('m-generatedUrlBox');
    if(!box) return;
    
    const config = getMobileConfig();
    const isWebEnabled = config.filters.enableVix || config.filters.enableGhd || config.filters.enableGs || config.filters.enableAnimeWorld || config.filters.enableAnimeUnity || config.filters.enableAnimeSaturn || config.filters.enableGf || config.filters.enableCc || config.filters.enableP2P;
    
    if(!config.key && !isWebEnabled) {
        box.value = "/// SYSTEM OFFLINE: WAITING FOR CONFIGURATION DATA ///\\n[!] Inserisci API Key o Attiva Sorgenti Web/P2P";
        box.style.color = "var(--m-error)";
        return;
    }
    
    const manifestUrl = `${window.location.protocol}//${window.location.host}/${btoa(JSON.stringify(config))}/manifest.json`;
    box.value = manifestUrl;
    box.style.color = "var(--m-primary)";
}

function mobileInstall() {
    const config = getMobileConfig();
    const isWebEnabled = config.filters.enableVix || config.filters.enableGhd || config.filters.enableGs || config.filters.enableAnimeWorld || config.filters.enableAnimeUnity || config.filters.enableAnimeSaturn || config.filters.enableGf || config.filters.enableCc || config.filters.enableP2P;
    if(!config.key && !isWebEnabled) {
        showToast("ERRORE: API KEY MANCANTE", "error"); return;
    }
    const manifestUrl = `${window.location.host}/${btoa(JSON.stringify(config))}/manifest.json`;
    window.location.href = `stremio://${manifestUrl}`;
}

function openLinkModal() {
    updateLinkModalContent();
    document.getElementById('m-link-modal').classList.add('show');
    if(navigator.vibrate) navigator.vibrate(10);
}

function closeLinkModal() {
    document.getElementById('m-link-modal').classList.remove('show');
}

async function copyFromModal() {
    const box = document.getElementById('m-generatedUrlBox');
    const textToCopy = box.value;
    
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

initMobileInterface();
