// Cenários de navegador do vídeo do hero (Playwright). NÃO usa vídeo real: gera clipes sintéticos com ffmpeg numa pasta temporária, serve-os por `page.route`
// e liga `HERO_VIDEO` só durante a execução (o arquivo é restaurado no final, mesmo em caso de falha). Nada é commitado nem publicado.
//
// Limite real: isto roda em Chromium/Edge. Emular um iPhone aqui NÃO prova o comportamento do Safari/iOS (autoplay, Modo Pouca Energia); isso exige teste físico
// (ver docs/HERO-VIDEO.md). A política "autoplay só com gesto" é simulada fazendo play() recusar com NotAllowedError quando não há ativação do usuário.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const require = createRequire(join(root, 'package.json'));
const { chromium } = require('playwright');
const PORT = Number(process.env.HERO_TEST_PORT ?? 3057);
const BASE = `http://127.0.0.1:${PORT}`;
const libPath = join(root, 'src/lib/hero-media.ts');
const backup = join(mkdtempSync(join(tmpdir(), 'hero-')), 'hero-media.orig.ts');
const work = mkdtempSync(join(tmpdir(), 'hero-clips-'));
const results = [];
const pass = (name) => { results.push(name); console.log(`  ✓ ${name}`); };

const ffmpeg = spawnSync('ffmpeg', ['-version']);
if (ffmpeg.status !== 0) { console.log('ffmpeg não encontrado: cenários de navegador do vídeo ignorados.'); process.exit(0); }
const encode = (name, args) => { const r = spawnSync('ffmpeg', ['-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=24', '-t', '3', '-an', ...args, join(work, name)]); assert.equal(r.status, 0, `ffmpeg ${name}: ${r.stderr}`); };
const encodeM = (name, args) => { const r = spawnSync('ffmpeg', ['-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=360x640:rate=24', '-t', '3', '-an', ...args, join(work, name)]); assert.equal(r.status, 0, `ffmpeg ${name}: ${r.stderr}`); };
encode('hero-v1.webm', ['-c:v', 'libvpx-vp9', '-b:v', '300k']);
encode('hero-v1.mp4', ['-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', '+faststart']);
encodeM('hero-v1-m.webm', ['-c:v', 'libvpx-vp9', '-b:v', '200k']);
encodeM('hero-v1-m.mp4', ['-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', '+faststart']);
const file = (name) => readFileSync(join(work, name));
const CT = (name) => (name.endsWith('.webm') ? 'video/webm' : 'video/mp4');

const CONFIG = `{ mp4: '/editorial/video/hero-v1.mp4', webm: '/editorial/video/hero-v1.webm', mobile: { mp4: '/editorial/video/hero-v1-m.mp4', webm: '/editorial/video/hero-v1-m.webm' }, timeoutMs: 2500, stallMs: 1200, position: { desktop: '60% 40%', mobile: '50% 30%' } }`;
let server;
const restore = () => { if (existsSync(backup)) copyFileSync(backup, libPath); };
const cleanup = () => { try { restore(); } catch {} try { server?.kill(); } catch {} try { rmSync(work, { recursive: true, force: true }); } catch {} };
process.on('exit', cleanup);
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { cleanup(); process.exit(1); });

const buildAndStart = async () => {
  try { server?.kill(); } catch {}
  if (!process.env.HERO_REUSE_BUILD) {
    const build = spawnSync(process.execPath, [join(root, 'scripts/build-mock.mjs')], { cwd: root, encoding: 'utf8' });
    assert.equal(build.status, 0, `build:mock falhou: ${String(build.stdout).slice(-400)}${String(build.stderr).slice(-400)}`);
  }
  server = spawn(process.execPath, [join(root, 'node_modules/next/dist/bin/next'), 'start', '-p', String(PORT), '-H', '127.0.0.1'], { cwd: root, stdio: 'ignore', env: { ...process.env, NODE_ENV: 'production', NEXT_TELEMETRY_DISABLED: '1', __NEXT_PROCESSED_ENV: 'true' } });
  for (let i = 0; i < 60; i++) { try { const r = await fetch(`${BASE}/`); if (r.ok) return; } catch {} await new Promise((ok) => setTimeout(ok, 1000)); }
  throw new Error('next start não subiu');
};
const setConfig = (value) => { writeFileSync(libPath, readFileSync(backup, 'utf8').replace('export const HERO_VIDEO: HeroVideo | null = null;', `export const HERO_VIDEO: HeroVideo | null = ${value};`)); };

const SERVE = (page, { missing = false, garbage = false, delayMs = 0, abortWebm = false, requests = [] } = {}) =>
  page.route('**/editorial/video/**', async (route) => {
    const name = new URL(route.request().url()).pathname.split('/').pop();
    requests.push(name);
    if (abortWebm && name.endsWith('.webm')) return route.abort('failed');
    if (missing) return route.fulfill({ status: 404, body: 'nao' });
    if (delayMs) await new Promise((ok) => setTimeout(ok, delayMs));
    requests.fulfilledAt = Date.now();
    if (garbage) return route.fulfill({ status: 200, contentType: CT(name), body: Buffer.from(Array.from({ length: 4000 }, (_, i) => (i * 37) % 251)) });
    return route.fulfill({ status: 200, contentType: CT(name), body: file(name), headers: { 'accept-ranges': 'none' } });
  });

const VIEWPORTS = { desktop: { width: 1440, height: 900 }, mobile: { width: 390, height: 844, isMobile: true, hasTouch: true } };
async function open(browser, { viewport = 'desktop', reducedMotion = false, connection, init, route = {} } = {}) {
  const v = VIEWPORTS[viewport];
  const ctx = await browser.newContext({ viewport: { width: v.width, height: v.height }, isMobile: !!v.isMobile, hasTouch: !!v.hasTouch, reducedMotion: reducedMotion ? 'reduce' : 'no-preference' });
  if (connection) await ctx.addInitScript((c) => Object.defineProperty(navigator, 'connection', { value: c, configurable: true }), connection);
  if (init) await ctx.addInitScript(init);
  const page = await ctx.newPage();
  const requests = [];
  const errors = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${String(e).slice(0, 120)}`));
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource|net::ERR|MEDIA_ELEMENT_ERROR|the server responded/i.test(m.text())) errors.push(`console: ${m.text().slice(0, 120)}`); });
  await SERVE(page, { ...route, requests });
  return { ctx, page, requests, errors };
}
const goto = async (page) => { await page.goto(`${BASE}/`, { waitUntil: 'load' }); };
const phase = (page) => page.evaluate(() => document.querySelector('video.hero-video')?.getAttribute('data-phase') ?? null);
const waitPhase = async (page, wanted, timeout = 9000) => {
  try { await page.waitForFunction((w) => document.querySelector('video.hero-video')?.getAttribute('data-phase') === w, wanted, { timeout }); }
  catch (error) { throw new Error(`esperava a fase "${wanted}", mas está em "${await phase(page)}" ${await page.evaluate(() => JSON.stringify({ rejeitados: window.__rejected ?? null, gesto: window.__gesture }))} (${error.message.split(String.fromCharCode(10))[0]})`); }
};
const waitShown = (page, shown, timeout = 9000) => page.waitForFunction((s) => document.querySelector('video.hero-video')?.getAttribute('data-shown') === s, String(shown), { timeout });
const snap = (page) => page.evaluate(() => {
  const v = document.querySelector('video.hero-video');
  const img = document.querySelector('.hero-photo img.campaign-image');
  const b = document.querySelector('.hero-video-control');
  const hero = document.querySelector('.editorial-hero').getBoundingClientRect();
  return { video: !!v, paused: v ? v.paused : null, src: v?.currentSrc?.split('/').pop() ?? null, opacity: v ? Number(getComputedStyle(v).opacity) : null, imgOk: !!img && img.complete && img.naturalWidth > 0, button: b ? b.getAttribute('aria-label') : null, heroH: Math.round(hero.height), scrollW: document.documentElement.scrollWidth, innerW: innerWidth };
});
const media = (requests) => [...new Set(requests)];

const run = async (browserName, browser, label) => {
  console.log(`\n== ${label}`);
  const canMp4 = browserName === 'edge';

  // 1) autoplay permitido (desktop e celular): imagem primeiro, vídeo só com frame válido, sem layout shift, sem erros, um download só
  for (const vp of ['desktop', 'mobile']) {
    const { ctx, page, requests, errors } = await open(browser, { viewport: vp });
    await goto(page);
    const before = await snap(page);
    await waitPhase(page, 'playing');
    await waitShown(page, true);
    await page.waitForTimeout(500);
    const s = await snap(page);
    assert.equal(s.paused, false);
    assert.equal(s.opacity > 0.9, true, 'vídeo visível');
    assert.equal(s.imgOk, true, 'a imagem segue por baixo');
    assert.equal(s.button, 'Pausar vídeo de fundo');
    assert.equal(s.heroH, before.heroH, 'a altura do hero não muda quando o vídeo entra');
    assert.equal(s.scrollW, s.innerW, 'sem rolagem horizontal');
    const wantFile = vp === 'mobile' ? '-m.' : 'hero-v1.';
    assert.ok(media(requests).every((n) => n.includes(wantFile)), `conjunto ${vp}: ${media(requests)}`);
    assert.equal(media(requests).length, 1, `um único arquivo baixado (sem duplicar webm+mp4): ${media(requests)}`);
    // o vídeo só é pedido DEPOIS que a imagem do hero (LCP) terminou de carregar
    const order = await page.evaluate(() => {
      const entries = performance.getEntriesByType('resource');
      const image = entries.find((e) => decodeURIComponent(e.name).includes('winter-campaign'));
      const clip = entries.find((e) => e.name.includes('/editorial/video/'));
      return { imageEnd: image?.responseEnd ?? null, clipStart: clip?.startTime ?? null };
    });
    assert.ok(order.imageEnd !== null && order.clipStart !== null && order.clipStart >= order.imageEnd - 5, `vídeo pedido depois da imagem: ${JSON.stringify(order)}`);
    assert.deepEqual(errors, []);
    await ctx.close();
  }
  pass('1/17) autoplay permitido em desktop e celular: imagem primeiro, vídeo só no frame válido, hero sem mudar de altura, 1 download (conjunto certo), sem erros');

  // 2/3) autoplay recusado (NotAllowedError) e Modo Pouca Energia (recusa sem gesto do usuário) + 4) reprodução manual com interação real
  const lowPower = () => {
    const original = HTMLMediaElement.prototype.play;
    window.__rejected = 0;
    window.__gesture = false;
    for (const type of ['pointerdown', 'keydown', 'touchstart', 'click']) window.addEventListener(type, (event) => { if (event.isTrusted) window.__gesture = true; }, true);
    // sem gesto do usuário o sistema também ignora o atributo autoplay (Modo Pouca Energia): simula os dois caminhos
    Object.defineProperty(HTMLMediaElement.prototype, 'autoplay', { get() { return false; }, set() {}, configurable: true });
    const setAttribute = Element.prototype.setAttribute;
    Element.prototype.setAttribute = function (name, value) { if (this instanceof HTMLVideoElement && String(name).toLowerCase() === 'autoplay') return undefined; return setAttribute.call(this, name, value); };
    HTMLMediaElement.prototype.play = function () {
      if (!window.__gesture) { window.__rejected++; return Promise.reject(new DOMException('autoplay bloqueado', 'NotAllowedError')); }
      return original.call(this);
    };
  };
  for (const vp of ['desktop', 'mobile']) {
    const { ctx, page, errors } = await open(browser, { viewport: vp, init: lowPower });
    await goto(page);
    await waitPhase(page, 'blocked');
    let s = await snap(page);
    assert.equal(s.imgOk, true);
    assert.equal(s.opacity, 0, 'vídeo invisível: a imagem continua (nunca tela preta)');
    assert.equal(s.button, 'Reproduzir vídeo de fundo');
    assert.equal(await page.evaluate(() => window.__rejected) >= 1, true);
    await page.waitForTimeout(1500);
    assert.equal(await phase(page), 'blocked', 'não insiste nem contorna a restrição');
    await page.locator('.hero-video-control').click(); // interação real
    await waitPhase(page, 'playing');
    await waitShown(page, true);
    s = await snap(page);
    assert.deepEqual([s.paused, s.button], [false, 'Pausar vídeo de fundo']);
    assert.deepEqual(errors, []);
    await ctx.close();
  }
  pass('2/3/4) play() recusado (NotAllowedError/Pouca Energia, sem gesto): imagem + botão "Reproduzir", sem insistir; o clique real inicia e o botão vira "Pausar"');

  // botão pausar/reproduzir
  {
    const { ctx, page } = await open(browser);
    await goto(page);
    await waitShown(page, true);
    await page.locator('.hero-video-control').click();
    await page.waitForFunction(() => document.querySelector('video.hero-video').paused);
    assert.equal((await snap(page)).button, 'Reproduzir vídeo de fundo');
    assert.equal(await page.evaluate(() => document.querySelector('video.hero-video').getAttribute('data-shown')), 'true', 'o último frame fica, sem piscar');
    await page.locator('.hero-video-control').click();
    await page.waitForFunction(() => !document.querySelector('video.hero-video').paused);
    await ctx.close();
  }
  pass('pausa e retomada pelo botão acessível (rótulo muda; sem piscar)');

  // 11/12/13) reduzir movimento, economia de dados, conexão lenta: nada baixa até pedir; o pedido manual baixa e toca
  const modes = [
    ['reduzir movimento', { reducedMotion: true }],
    ['economia de dados', { connection: { saveData: true, effectiveType: '4g' } }],
    ['conexão 3g', { connection: { saveData: false, effectiveType: '3g' } }],
  ];
  for (const [name, opts] of modes) {
    for (const vp of ['desktop', 'mobile']) {
      const { ctx, page, requests, errors } = await open(browser, { viewport: vp, ...opts });
      await goto(page);
      await page.waitForTimeout(1800);
      let s = await snap(page);
      assert.deepEqual([s.video, s.imgOk, s.button, requests.length], [false, true, 'Reproduzir vídeo de fundo', 0], `${name}/${vp}: nada baixa sozinho`);
      await page.locator('.hero-video-control').click();
      await waitShown(page, true);
      s = await snap(page);
      assert.deepEqual([s.paused, requests.length > 0], [false, true], `${name}/${vp}: manual toca`);
      assert.deepEqual(errors, []);
      await ctx.close();
    }
  }
  pass('11/12/13) reduzir movimento, economia de dados e 3g (desktop e celular): zero requisições de mídia até o clique; o clique baixa e toca');

  // 5) arquivo ausente / 6) erro de decodificação
  for (const [name, route] of [['arquivo ausente (404)', { missing: true }], ['erro de decodificação', { garbage: true }]]) {
    const { ctx, page, errors } = await open(browser, { route });
    await goto(page);
    await page.waitForFunction(() => !document.querySelector('video.hero-video'), null, { timeout: 9000 });
    await page.waitForTimeout(500);
    const s = await snap(page);
    assert.deepEqual([s.video, s.imgOk, s.button], [false, true, null], name);
    assert.deepEqual(errors, [], name);
    await ctx.close();
  }
  pass('5/6) arquivo ausente (404) e erro de decodificação: vídeo descartado, imagem fica, sem botão e sem erro de JavaScript');

  // 7) timeout de carregamento (resposta mais lenta que timeoutMs = 2,5 s): desiste ANTES de a resposta chegar e não ressuscita depois
  {
    const { ctx, page, requests, errors } = await open(browser, { route: { delayMs: 6000 } });
    await goto(page);
    for (let i = 0; i < 50 && requests.length === 0; i++) await page.waitForTimeout(100); // espera o vídeo ser pedido
    assert.ok(requests.length >= 1, 'o vídeo chegou a ser pedido');
    await page.waitForFunction(() => !document.querySelector('video.hero-video'), null, { timeout: 7000 });
    const removedAt = Date.now();
    assert.ok(!requests.fulfilledAt || removedAt < requests.fulfilledAt, 'desistiu antes de a resposta lenta chegar (timeout, não término)');
    await page.waitForTimeout(4500); // a resposta lenta termina nesse intervalo: o vídeo não pode voltar
    const s = await snap(page);
    assert.deepEqual([s.video, s.imgOk, s.button], [false, true, null]);
    assert.deepEqual(errors, []);
    await ctx.close();
  }
  pass('7) timeout: sem primeiro frame em 2,5 s, desiste antes da resposta lenta, solta o download, fica na imagem e não ressuscita');

  // 8) stall/buffer: "waiting" prolongado volta à imagem; ao recuperar, o vídeo reaparece
  {
    const { ctx, page, errors } = await open(browser);
    await goto(page);
    await waitShown(page, true);
    await page.evaluate(() => { const v = document.querySelector('video.hero-video'); window.__orig = v.play; v.dispatchEvent(new Event('waiting')); });
    await waitShown(page, false);
    assert.equal(await phase(page), 'stalled');
    assert.equal((await snap(page)).imgOk, true);
    await page.evaluate(() => document.querySelector('video.hero-video').dispatchEvent(new Event('playing')));
    await waitShown(page, true);
    assert.equal(await phase(page), 'playing');
    // um "waiting" curto (recupera antes de 1,2 s) NÃO derruba o vídeo
    await page.evaluate(() => { const v = document.querySelector('video.hero-video'); v.dispatchEvent(new Event('waiting')); setTimeout(() => v.dispatchEvent(new Event('playing')), 300); });
    await page.waitForTimeout(1800);
    assert.equal(await phase(page), 'playing');
    assert.deepEqual(errors, []);
    await ctx.close();
  }
  pass('8) stall: travou >1,2 s volta à imagem; recuperou, o vídeo reaparece; travada curta não derruba');

  // 9) aba em segundo plano / 10) fora da viewport
  {
    const { ctx, page } = await open(browser);
    await goto(page);
    await waitShown(page, true);
    await page.evaluate(() => { Object.defineProperty(document, 'hidden', { value: true, configurable: true }); document.dispatchEvent(new Event('visibilitychange')); });
    await page.waitForFunction(() => document.querySelector('video.hero-video').paused);
    await page.evaluate(() => { Object.defineProperty(document, 'hidden', { value: false, configurable: true }); document.dispatchEvent(new Event('visibilitychange')); });
    await page.waitForFunction(() => !document.querySelector('video.hero-video').paused);
    await page.evaluate(() => window.scrollTo(0, 3000));
    await page.waitForFunction(() => document.querySelector('video.hero-video').paused);
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForFunction(() => !document.querySelector('video.hero-video').paused);
    await ctx.close();
  }
  pass('9/10) aba oculta e hero fora da viewport pausam; voltar retoma sozinho');

  // 14/15) sem WebM: o navegador cai no MP4
  if (canMp4) {
    const { ctx, page, requests, errors } = await open(browser, { route: { abortWebm: true } });
    await goto(page);
    await waitShown(page, true);
    const s = await snap(page);
    assert.equal(s.src, 'hero-v1.mp4');
    assert.deepEqual(errors, []);
    assert.ok(requests.includes('hero-v1.webm') && requests.includes('hero-v1.mp4'));
    await ctx.close();
    pass('14/15) WebM indisponível: cai no MP4/H.264 e toca');
  } else {
    // o Chromium do Playwright não decodifica H.264; só confirma que o WebM é o escolhido e que MP4 não é baixado em paralelo
    const { ctx, page, requests } = await open(browser);
    await goto(page);
    await waitShown(page, true);
    assert.equal((await snap(page)).src, 'hero-v1.webm');
    assert.ok(!requests.includes('hero-v1.mp4'), 'MP4 não é baixado quando o WebM toca');
    await ctx.close();
    pass('14) com WebM suportado só ele é baixado (o MP4 não é pedido)');
  }

  // 18) posição configurável (a imagem e o vídeo usam o mesmo enquadramento)
  {
    const { ctx, page } = await open(browser);
    await goto(page);
    await waitShown(page, true);
    const pos = await page.evaluate(() => [getComputedStyle(document.querySelector('.hero-photo img.campaign-image')).objectPosition, getComputedStyle(document.querySelector('video.hero-video')).objectPosition]);
    assert.deepEqual(pos[0], pos[1]);
    assert.match(pos[0], /60%\s+40%/);
    await ctx.close();
    const m = await open(browser, { viewport: 'mobile' });
    await goto(m.page);
    await waitShown(m.page, true);
    const posM = await m.page.evaluate(() => [getComputedStyle(document.querySelector('.hero-photo img.campaign-image')).objectPosition, getComputedStyle(document.querySelector('video.hero-video')).objectPosition]);
    assert.deepEqual(posM[0], posM[1]);
    assert.match(posM[0], /50%\s+30%/);
    await m.ctx.close();
  }
  pass('enquadramento: imagem e vídeo com a mesma posição (desktop 60% 40%, celular 50% 30%)');
};

const matrix = async (browser) => {
  console.log('\n== matriz de telas (layout, botão e texto)');
  const sizes = [['iPhone SE', 375, 667, true], ['iPhone 14', 390, 844, true], ['iPhone Pro Max', 430, 932, true], ['Android 360', 360, 800, true], ['Android 412', 412, 915, true], ['iPad', 820, 1180, false], ['tablet paisagem', 1024, 768, false], ['notebook', 1366, 768, false], ['desktop 1440', 1440, 900, false], ['ultrawide', 3440, 1440, false]];
  for (const [name, width, height, mobile] of sizes) {
    const ctx = await browser.newContext({ viewport: { width, height }, isMobile: mobile, hasTouch: mobile });
    const page = await ctx.newPage();
    await SERVE(page);
    await goto(page);
    const before = await page.evaluate(() => Math.round(document.querySelector('.editorial-hero').getBoundingClientRect().height));
    await page.waitForFunction(() => document.querySelector('video.hero-video')?.getAttribute('data-shown') === 'true', null, { timeout: 9000 });
    const r = await page.evaluate(() => {
      const rect = (el) => { const b = el.getBoundingClientRect(); return { l: b.left, t: b.top, r: b.right, b: b.bottom, w: b.width, h: b.height }; };
      const hit = (a, b) => !(a.r <= b.l || a.l >= b.r || a.b <= b.t || a.t >= b.b);
      const btn = rect(document.querySelector('.hero-video-control'));
      const texts = ['.hero-copy h1', '.hero-copy .editorial-button', '.hero-copy .hero-description'].map((s) => document.querySelector(s)).filter(Boolean).map(rect);
      return { heroH: Math.round(document.querySelector('.editorial-hero').getBoundingClientRect().height), scrollW: document.documentElement.scrollWidth, innerW: innerWidth, btnInside: btn.l >= 0 && btn.r <= innerWidth && btn.t >= 0, btnSize: Math.round(Math.min(btn.w, btn.h)), overlapsText: texts.some((t) => hit(btn, t)) };
    });
    assert.equal(r.heroH, before, `${name}: altura do hero igual com o vídeo`);
    assert.equal(r.scrollW, r.innerW, `${name}: sem rolagem horizontal`);
    assert.equal(r.btnInside, true, `${name}: botão dentro da tela`);
    assert.ok(r.btnSize >= 44, `${name}: alvo de toque ≥ 44 px`);
    assert.equal(r.overlapsText, false, `${name}: o botão não cobre título/CTA`);
    await ctx.close();
  }
  pass(`10 tamanhos (iPhone SE→ultrawide): sem rolagem lateral, hero com a mesma altura com o vídeo, botão visível (≥44 px) e sem cobrir título/CTA`);
};

let browsers = [];
try {
  copyFileSync(libPath, backup);
  // 16) vídeo desativado (estado entregue) — antes de ligar a configuração de teste
  await buildAndStart();
  if (!process.env.HERO_REUSE_BUILD) {
    const b = await chromium.launch();
    for (const vp of ['desktop', 'mobile']) {
      const { ctx, page, requests, errors } = await open(b, { viewport: vp });
      await goto(page);
      await page.waitForTimeout(2500);
      const s = await snap(page);
      assert.deepEqual([s.video, s.button, s.imgOk, requests.length, s.scrollW === s.innerW], [false, null, true, 0, true]);
      assert.deepEqual(errors, []);
      await ctx.close();
    }
    await b.close();
    pass('16) vídeo desativado (HERO_VIDEO=null): sem <video>, sem botão, imagem OK, 0 requisições de mídia, sem erros');
  }
  setConfig(CONFIG);
  await buildAndStart();
  const chromiumBrowser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
  browsers.push(chromiumBrowser);
  await run('chromium', chromiumBrowser, 'Chromium (WebM/VP9)');
  await matrix(chromiumBrowser);
  let edge = null;
  try { edge = await chromium.launch({ channel: 'msedge', args: ['--autoplay-policy=no-user-gesture-required'] }); } catch { console.log('\nMicrosoft Edge não disponível: cenário MP4/H.264 ignorado.'); }
  if (edge) { browsers.push(edge); await run('edge', edge, 'Microsoft Edge (H.264 + WebM)'); }
  console.log(`\nVídeo do hero no navegador: ${results.length} verificações passaram.`);
} finally {
  for (const b of browsers) await b.close().catch(() => {});
  cleanup();
}
