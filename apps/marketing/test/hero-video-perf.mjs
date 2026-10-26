// Medição de performance do hero (ferramenta MANUAL, não roda na CI): compara 3 variantes com os MESMOS clipes sintéticos servidos pelo próprio Next:
//   A) base      — estado entregue (HERO_VIDEO = null, só imagem)
//   B) anterior  — estrutura do PR #135 (origin/main): vídeo montado 300 ms depois do `load`, preload="metadata", sem versão mobile
//   C) premium   — esta branch
// Mede LCP, CLS, bytes transferidos (imagem × vídeo), requisições de mídia, tempo até começar a tocar e até o 1º frame, com e sem rede lenta (CDP).
// Os clipes são sintéticos (ffmpeg): servem para comparar as variantes entre si, não para prever o peso do vídeo do Orlando.
// Uso: `node test/hero-video-perf.mjs` (precisa de ffmpeg; faz 3 builds). Restaura tudo no final.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const repo = join(root, '../..');
const require = createRequire(join(root, 'package.json'));
const { chromium } = require('playwright');
const PORT = 3059;
const BASE = `http://127.0.0.1:${PORT}`;
const RUNS = Number(process.env.HERO_PERF_RUNS ?? 3);
const files = { comp: 'src/components/HeroMedia.tsx', lib: 'src/lib/hero-media.ts', css: 'src/app/globals.css' };
const save = mkdtempSync(join(tmpdir(), 'hero-perf-save-'));
const clips = join(root, 'public/editorial/video');
let server;
for (const [k, f] of Object.entries(files)) copyFileSync(join(root, f), join(save, k));
const restore = () => { for (const [k, f] of Object.entries(files)) if (existsSync(join(save, k))) copyFileSync(join(save, k), join(root, f)); rmSync(clips, { recursive: true, force: true }); };
const cleanup = () => { try { server?.kill(); } catch {} try { restore(); } catch {} };
process.on('exit', cleanup);
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { cleanup(); process.exit(1); });

if (spawnSync('ffmpeg', ['-version']).status !== 0) { console.log('ffmpeg não encontrado.'); process.exit(0); }
mkdirSync(clips, { recursive: true });
const BUDGET = process.env.HERO_PERF_BUDGET === '1'; // clipes dentro do orçamento de pixels (ver docs/HERO-VIDEO.md)
const D = BUDGET ? [1080, 608] : [1280, 720];
const M = BUDGET ? [480, 854] : [540, 960];
const src = (w, h) => `testsrc2=size=${w}x${h}:rate=24,noise=alls=10:allf=t`;
const enc = (name, w, h, args) => { const r = spawnSync('ffmpeg', ['-loglevel', 'error', '-y', '-f', 'lavfi', '-i', src(w, h), '-t', '6', '-an', ...args, join(clips, name)]); assert.equal(r.status, 0, String(r.stderr)); };
enc('hero-v1.mp4', D[0], D[1], ['-c:v', 'libx264', '-preset', 'medium', '-crf', '30', '-pix_fmt', 'yuv420p', '-g', '48', '-movflags', '+faststart']);
enc('hero-v1.webm', D[0], D[1], ['-c:v', 'libvpx-vp9', '-b:v', '0', '-crf', '38', '-row-mt', '1', '-g', '48']);
enc('hero-v1-m.mp4', M[0], M[1], ['-c:v', 'libx264', '-preset', 'medium', '-crf', '30', '-pix_fmt', 'yuv420p', '-g', '48', '-movflags', '+faststart']);
enc('hero-v1-m.webm', M[0], M[1], ['-c:v', 'libvpx-vp9', '-b:v', '0', '-crf', '38', '-row-mt', '1', '-g', '48']);
const kb = (n) => Math.round(statSync(join(clips, n)).size / 1024);
console.log(`Clipes sintéticos (6 s, 24 fps): desktop mp4 ${kb('hero-v1.mp4')} KB / webm ${kb('hero-v1.webm')} KB · celular mp4 ${kb('hero-v1-m.mp4')} KB / webm ${kb('hero-v1-m.webm')} KB`);

const setHero = (config) => writeFileSync(join(root, files.lib), readFileSync(join(root, files.lib), 'utf8').replace(/^export const HERO_VIDEO: HeroVideo \| null = [^;]*;/m, `export const HERO_VIDEO: HeroVideo | null = ${config};`));
const useOld = () => { for (const [k, f] of Object.entries(files)) writeFileSync(join(root, f), spawnSync('git', ['show', `origin/main:apps/marketing/${f}`], { cwd: repo, encoding: 'utf8', maxBuffer: 1 << 26 }).stdout); };
const useNew = () => { for (const [k, f] of Object.entries(files)) copyFileSync(join(save, k), join(root, f)); };
const build = () => { const b = spawnSync(process.execPath, [join(root, 'scripts/build-mock.mjs')], { cwd: root, encoding: 'utf8' }); assert.equal(b.status, 0, String(b.stdout).slice(-300) + String(b.stderr).slice(-300)); };
const start = async () => {
  try { server?.kill(); } catch {}
  server = spawn(process.execPath, [join(root, 'node_modules/next/dist/bin/next'), 'start', '-p', String(PORT), '-H', '127.0.0.1'], { cwd: root, stdio: 'ignore', env: { ...process.env, NODE_ENV: 'production', NEXT_TELEMETRY_DISABLED: '1', __NEXT_PROCESSED_ENV: 'true' } });
  for (let i = 0; i < 60; i++) { try { if ((await fetch(`${BASE}/`)).ok) return; } catch {} await new Promise((ok) => setTimeout(ok, 1000)); }
  throw new Error('next start não subiu');
};

const PROFILES = {
  'sem throttle': null,
  'Fast 4G (1,6 Mbps, 150 ms)': { latency: 150, down: (1.6 * 1024 * 1024) / 8, up: (750 * 1024) / 8 },
  'Slow 3G (400 kbps, 400 ms)': { latency: 400, down: (400 * 1024) / 8, up: (400 * 1024) / 8 },
};
const VIEWPORTS = { desktop: { width: 1440, height: 900 }, celular: { width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: Number(process.env.HERO_PERF_DPR ?? 2) } };
const INIT = () => {
  window.__m = { cls: 0, lcp: 0, lcpEl: '', playing: null, shown: null };
  new PerformanceObserver((l) => { for (const e of l.getEntries()) if (!e.hadRecentInput) window.__m.cls += e.value; }).observe({ type: 'layout-shift', buffered: true });
  new PerformanceObserver((l) => { for (const e of l.getEntries()) { window.__m.lcp = e.startTime; window.__m.lcpEl = `${e.element?.tagName ?? '?'}:${decodeURIComponent((e.url || '').split('/').pop() || '').slice(0, 42)}`; } }).observe({ type: 'largest-contentful-paint', buffered: true });
  document.addEventListener('playing', () => { if (window.__m.playing === null) window.__m.playing = performance.now(); }, true);
  new MutationObserver(() => { const v = document.querySelector('video.hero-video'); if (v && window.__m.shown === null && (v.getAttribute('data-shown') === 'true' || v.classList.contains('is-playing'))) window.__m.shown = performance.now(); }).observe(document, { subtree: true, attributes: true, childList: true });
};

async function measure(browser, viewport, profile) {
  const v = VIEWPORTS[viewport];
  const ctx = await browser.newContext({ viewport: { width: v.width, height: v.height }, isMobile: !!v.isMobile, hasTouch: !!v.hasTouch, deviceScaleFactor: v.deviceScaleFactor ?? 1 });
  await ctx.addInitScript(INIT);
  const page = await ctx.newPage();
  const cdp = await ctx.newCDPSession(page);
  await cdp.send('Network.enable');
  await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });
  if (PROFILES[profile]) await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: PROFILES[profile].latency, downloadThroughput: PROFILES[profile].down, uploadThroughput: PROFILES[profile].up });
  const reqs = new Map();
  let imageBytes = 0, videoBytes = 0, totalBytes = 0, mediaRequests = 0;
  cdp.on('Network.requestWillBeSent', (e) => { reqs.set(e.requestId, e.request.url); if (e.request.url.includes('/editorial/video/')) mediaRequests++; });
  cdp.on('Network.loadingFinished', (e) => { const url = reqs.get(e.requestId) ?? ''; totalBytes += e.encodedDataLength; if (url.includes('/editorial/video/')) videoBytes += e.encodedDataLength; else if (/\/_next\/image|\.(webp|jpg|png)/.test(url)) imageBytes += e.encodedDataLength; });
  await page.goto(`${BASE}/`, { waitUntil: 'load', timeout: 90000 });
  await page.waitForTimeout(profile.startsWith('Slow') ? 16000 : 8000);
  const m = await page.evaluate(() => window.__m);
  await ctx.close();
  return { lcpEl: m.lcpEl, lcp: Math.round(m.lcp), cls: Number(m.cls.toFixed(4)), playing: m.playing === null ? null : Math.round(m.playing), shown: m.shown === null ? null : Math.round(m.shown), imageKB: Math.round(imageBytes / 1024), videoKB: Math.round(videoBytes / 1024), totalKB: Math.round(totalBytes / 1024), media: mediaRequests };
}
const median = (a) => { const s = a.filter((x) => x !== null).sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : null; };

const variants = [
  ['A base (só imagem)', () => { useNew(); setHero('null'); }],
  ['B anterior (PR #135)', () => { useOld(); setHero("{ mp4: '/editorial/video/hero-v1.mp4', webm: '/editorial/video/hero-v1.webm' }"); }],
  [BUDGET ? 'C premium (esta branch, dentro do orçamento)' : 'C premium (esta branch)', () => { useNew(); setHero("{ mp4: '/editorial/video/hero-v1.mp4', webm: '/editorial/video/hero-v1.webm', mobile: { mp4: '/editorial/video/hero-v1-m.mp4', webm: '/editorial/video/hero-v1-m.webm' } }"); }],
];
const only = (process.env.HERO_PERF_ONLY ?? 'ABC').split('');
const table = [];
try {
  const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
  for (const [name, prepare] of variants) {
    if (!only.includes(name[0])) continue;
    prepare();
    build();
    await start();
    for (const viewport of ['desktop', 'celular']) {
      for (const profile of Object.keys(PROFILES)) {
        if (viewport === 'celular' && profile.startsWith('sem')) continue;
        const runs = [];
        for (let i = 0; i < RUNS; i++) runs.push(await measure(browser, viewport, profile));
        const pick = (k) => median(runs.map((r) => r[k]));
        const row = { variante: name, tela: viewport, rede: profile, LCP_ms: pick('lcp'), elementoLCP: runs[0].lcpEl, CLS: pick('cls'), toca_ms: pick('playing'), frame1_ms: pick('shown'), imagemKB: pick('imageKB'), videoKB: pick('videoKB'), totalKB: pick('totalKB'), reqMidia: pick('media') };
        table.push(row);
        console.log(JSON.stringify(row));
      }
    }
  }
  await browser.close();
  console.log('\n(medianas de ' + RUNS + ' execuções; LCP/toca/frame1 em ms a partir do início da navegação; frame1 = vídeo visível por cima da imagem; null = não aconteceu)');
  console.table(table);
} finally {
  cleanup();
}
