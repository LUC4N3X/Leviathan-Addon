'use strict';

const { performance } = require('node:perf_hooks');
const { extractEmbedCandidates } = require('../providers/extractors/semantic_candidate_extractor');
const { dedupeByInfoHash } = require('../core/stream/infohash_deduper');

const SEMANTIC_ITERS = Number(process.argv[2]) || 4000;
const DEDUPE_ITERS = Number(process.argv[3]) || 600;
const DEDUPE_ITEMS = Number(process.argv[4]) || 600;
const SEMANTIC_POOL = 512;

const HOSTERS = [
    'https://mixdrop.ag/e/abc123def456',
    'https://supervideo.cc/embed-xyz789aa.html',
    'https://doodstream.com/e/qwerty0987zz',
    'https://streamtape.com/e/lkjhgf4321mm',
    'https://uqload.io/embed-pppp1111qq.html',
    'https://voe.sx/e/zzzz2222ww',
    'https://vixcloud.co/embed/55555kkk',
    'https://maxstream.video/abc777yyy'
];

const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');
const charcodes = (s) => Array.from(s).map((c) => c.charCodeAt(0)).join(',');

function buildHtml(salt = 0) {
    const H = HOSTERS.map((u) => `${u}?s=${salt}`);
    const parts = ['<html><head><title>watch</title></head><body>'];
    for (let i = 0; i < 3; i += 1) {
        parts.push(`<div class="player"><iframe src="${H[i % H.length]}&t=${i}" allowfullscreen></iframe></div>`);
    }
    parts.push(`<a href="https://example.com/not-a-host-${salt}">x</a>`);
    parts.push(`<script>var sources=[{"file":"${H[1]}","label":"HD"}];</script>`);
    for (let i = 0; i < 8; i += 1) {
        parts.push(`<script>var p${i}=atob("${b64(`player config => ${H[i % H.length]} end`)}");</script>`);
    }
    for (let i = 0; i < 8; i += 1) {
        parts.push(`<script>var c${i}=String.fromCharCode(${charcodes(`redirect=${H[(i + 2) % H.length]}`)});</script>`);
    }
    parts.push(`<script>var u="https://" + "doodstream.com" + "/e/" + "concatHATCH${salt}";</script>`);
    parts.push(`<p>${'lorem ipsum dolor sit amet '.repeat(200)}</p>`);
    parts.push('</body></html>');
    return parts.join('\n');
}

const PAGES = Array.from({ length: SEMANTIC_POOL }, (_, i) => buildHtml(i));
const SEMANTIC_OPTS = { baseUrl: 'https://watchsite.example/movie/123' };

const hex40 = (n) => n.toString(16).padStart(40, '0').slice(-40);

function genItems(n) {
    const titles = [
        'Inception 2010 1080p BluRay x264 AMIABLE',
        'The Matrix 1999 2160p UHD BluRay x265 GROUP',
        'Interstellar 2014 1080p WEBRip x264 TEAM',
        'Dune Part Two 2024 720p HDTV x264 RELEASE'
    ];
    const items = [];
    for (let i = 0; i < n; i += 1) {
        const t = titles[i % titles.length];
        items.push({
            infoHash: hex40(Math.floor(i / 3) + 1),
            title: i % 3 === 0 ? t : `${t} COPY${i % 3}`,
            behaviorHints: { filename: `${t.replace(/\s+/g, '.')}.mkv` },
            size: (1 + (i % 9)) * 1024 * 1024 * 1024,
            seeders: 50 + (i % 100)
        });
    }
    return items;
}

const DEDUPE_LIST = genItems(DEDUPE_ITEMS);
const DEDUPE_OPTS = { enabled: true };

function bench(fn, iters) {
    const warmup = Math.max(3, Math.floor(iters / 10));
    for (let i = 0; i < warmup; i += 1) fn();
    if (global.gc) global.gc();
    const t0 = performance.now();
    let out;
    for (let i = 0; i < iters; i += 1) out = fn();
    const total = performance.now() - t0;
    return { totalMs: total, avgMs: total / iters, opsPerSec: (iters / total) * 1000, last: out };
}

const ms = (n) => `${n.toFixed(4)} ms`;
const k = (n) => n.toLocaleString('en-US', { maximumFractionDigits: 0 });

let semIdx = 0;
const semantic = bench(() => {
    const out = extractEmbedCandidates(PAGES[semIdx], SEMANTIC_OPTS);
    semIdx = (semIdx + 1) % SEMANTIC_POOL;
    return out;
}, SEMANTIC_ITERS);

const dedupe = bench(() => dedupeByInfoHash(DEDUPE_LIST, DEDUPE_OPTS), DEDUPE_ITERS);

console.log('=== hot-path micro-benchmark ===');
console.log(`node ${process.version}`);
console.log('');
console.log('[1] semantic_candidate_extractor.extractEmbedCandidates');
console.log(`    candidates found  : ${semantic.last.length}`);
console.log(`    iterations        : ${k(SEMANTIC_ITERS)}`);
console.log(`    total             : ${ms(semantic.totalMs)}`);
console.log(`    avg / call        : ${ms(semantic.avgMs)}`);
console.log(`    ops / sec         : ${k(semantic.opsPerSec)}`);
console.log('');
console.log('[2] infohash_deduper.dedupeByInfoHash');
console.log(`    items             : ${k(DEDUPE_ITEMS)}`);
console.log(`    removed / groups  : ${dedupe.last.removed} / ${dedupe.last.groups} (keyGroups=${dedupe.last.keyGroups})`);
console.log(`    iterations        : ${k(DEDUPE_ITERS)}`);
console.log(`    total             : ${ms(dedupe.totalMs)}`);
console.log(`    avg / call        : ${ms(dedupe.avgMs)}`);
console.log(`    ops / sec         : ${k(dedupe.opsPerSec)}`);
