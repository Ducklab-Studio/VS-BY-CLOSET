import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';

// Vídeo do hero: lógica pura (decisão, fontes, máquina de estados) e estrutura do componente. Os cenários com navegador real estão em hero-video-browser.mjs.
const root = new URL('../', import.meta.url);
const ts = createRequire(new URL('package.json', root))('typescript');
const exports = {};
runInNewContext(
  ts.transpileModule(readFileSync(new URL('src/lib/hero-media.ts', root), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2021 } }).outputText,
  { exports },
);
const { HERO_VIDEO, decideHeroVideo, shouldLoadHeroVideo, heroVideoSources, heroVideoPosition, heroReducer, initialHeroState, heroShouldRun, heroVideoMounted, heroControl } = exports;

const VIDEO = { mp4: '/editorial/video/hero-v1.mp4', webm: '/editorial/video/hero-v1.webm', mobile: { mp4: '/editorial/video/hero-v1-m.mp4', webm: '/editorial/video/hero-v1-m.webm' } };
const GOOD = { reducedMotion: false, saveData: false, effectiveType: '4g' };
const j = (v) => JSON.parse(JSON.stringify(v));
const play = (events, start = initialHeroState()) => events.reduce((s, e) => heroReducer(s, e), start);
const AUTO = { type: 'INIT', decision: decideHeroVideo(VIDEO, GOOD) };

test('16) vídeo desativado: estado entregue = nenhum vídeo, fase "off", nada montado, nenhum botão', () => {
  assert.equal(HERO_VIDEO, null);
  assert.deepEqual(j(decideHeroVideo(null, GOOD)), { mode: 'off', reason: null });
  const s = play([{ type: 'INIT', decision: decideHeroVideo(null, GOOD) }]);
  assert.equal(s.phase, 'off');
  assert.equal(heroVideoMounted(s), false);
  assert.equal(heroControl(s), 'none');
});

test('11/12/13) decisão: reduzir movimento, economia de dados e conexão lenta viram modo MANUAL (nada baixa sozinho); o resto é automático', () => {
  assert.deepEqual(j(decideHeroVideo(VIDEO, GOOD)), { mode: 'auto', reason: null });
  assert.deepEqual(j(decideHeroVideo(VIDEO, { reducedMotion: false, saveData: false })), { mode: 'auto', reason: null }); // API de rede ausente: não bloqueia
  assert.deepEqual(j(decideHeroVideo(VIDEO, { ...GOOD, reducedMotion: true })), { mode: 'manual', reason: 'reduced-motion' });
  assert.deepEqual(j(decideHeroVideo(VIDEO, { ...GOOD, saveData: true })), { mode: 'manual', reason: 'save-data' });
  for (const slow of ['slow-2g', '2g', '3g']) assert.deepEqual(j(decideHeroVideo(VIDEO, { ...GOOD, effectiveType: slow })), { mode: 'manual', reason: 'slow-connection' }, slow);
  assert.equal(shouldLoadHeroVideo(GOOD), true);
  assert.equal(shouldLoadHeroVideo({ ...GOOD, saveData: true }), false);
  // modo manual: nada é montado/baixado até a pessoa pedir; o botão "Reproduzir" aparece
  const manual = play([{ type: 'INIT', decision: decideHeroVideo(VIDEO, { ...GOOD, reducedMotion: true }) }]);
  assert.equal(manual.phase, 'manual');
  assert.equal(heroVideoMounted(manual), false);
  assert.equal(heroControl(manual), 'play');
});

test('1) autoplay permitido: espera a imagem, monta, só mostra o vídeo no primeiro frame válido e oferece "Pausar"', () => {
  let s = play([AUTO]);
  assert.equal(s.phase, 'waiting-image');
  assert.equal(heroVideoMounted(s), false); // não disputa banda com a imagem (LCP)
  s = play([{ type: 'IMAGE_READY' }], s);
  assert.equal(s.phase, 'loading');
  assert.equal(heroVideoMounted(s), true);
  assert.equal(heroShouldRun(s), true);
  assert.equal(s.shown, false); // sem frame válido a imagem continua visível (nunca tela preta)
  s = play([{ type: 'FRAME' }], s);
  assert.deepEqual(j([s.phase, s.shown, heroControl(s)]), ['playing', true, 'pause']);
});

test('2/3) autoplay recusado (NotAllowedError, inclusive Modo Pouca Energia do iOS): imagem fica, botão "Reproduzir", sem tentar de novo à força', () => {
  const s = play([AUTO, { type: 'IMAGE_READY' }, { type: 'PLAY_REJECTED', name: 'NotAllowedError' }]);
  assert.deepEqual(j([s.phase, s.shown, heroControl(s), heroVideoMounted(s), heroShouldRun(s)]), ['blocked', false, 'play', true, false]);
});

test('4) reprodução manual: do bloqueado e do modo manual, "Reproduzir" monta/toca e o primeiro frame mostra o vídeo', () => {
  const blocked = play([AUTO, { type: 'IMAGE_READY' }, { type: 'PLAY_REJECTED', name: 'NotAllowedError' }]);
  let s = play([{ type: 'USER_PLAY' }], blocked);
  assert.deepEqual(j([s.phase, heroShouldRun(s)]), ['loading', true]);
  s = play([{ type: 'FRAME' }], s);
  assert.deepEqual(j([s.phase, s.shown, heroControl(s)]), ['playing', true, 'pause']);
  const manual = play([{ type: 'INIT', decision: decideHeroVideo(VIDEO, { ...GOOD, saveData: true }) }, { type: 'USER_PLAY' }]);
  assert.deepEqual(j([manual.phase, heroVideoMounted(manual)]), ['loading', true]);
});

test('pausa do usuário é respeitada (sobrepõe visibilidade e aba) e o botão vira "Reproduzir"', () => {
  let s = play([AUTO, { type: 'IMAGE_READY' }, { type: 'FRAME' }, { type: 'USER_PAUSE' }]);
  assert.deepEqual(j([heroShouldRun(s), heroControl(s), s.shown]), [false, 'play', true]); // o último frame fica; nada pisca
  s = play([{ type: 'VIEW', inView: false }, { type: 'VIEW', inView: true }, { type: 'TAB', visible: false }, { type: 'TAB', visible: true }], s);
  assert.equal(heroShouldRun(s), false); // voltar à tela/aba não "despausa" contra a vontade da pessoa
  s = play([{ type: 'USER_PLAY' }], s);
  assert.deepEqual(j([heroShouldRun(s), heroControl(s)]), [true, 'pause']);
});

test('5/6) arquivo ausente ou erro de decodificação (evento "error" do <video>): descarta e fica na imagem, sem botão', () => {
  for (const events of [[AUTO, { type: 'IMAGE_READY' }, { type: 'ERROR' }], [AUTO, { type: 'IMAGE_READY' }, { type: 'FRAME' }, { type: 'ERROR' }]]) {
    const s = play(events);
    assert.deepEqual(j([s.phase, s.shown, heroVideoMounted(s), heroControl(s)]), ['failed', false, false, 'none']);
  }
  // outro erro de play() (não é política): também só imagem
  assert.equal(play([AUTO, { type: 'IMAGE_READY' }, { type: 'PLAY_REJECTED', name: 'NotSupportedError' }]).phase, 'failed');
  // AbortError (play interrompido por pausa/novo load) NÃO é falha
  assert.equal(play([AUTO, { type: 'IMAGE_READY' }, { type: 'PLAY_REJECTED', name: 'AbortError' }]).phase, 'loading');
});

test('7) timeout de carregamento: sem primeiro frame no prazo, desiste e fica na imagem; depois do frame o timeout não faz nada', () => {
  assert.deepEqual(j(((s) => [s.phase, heroVideoMounted(s)])(play([AUTO, { type: 'IMAGE_READY' }, { type: 'TIMEOUT' }]))), ['failed', false]);
  assert.equal(play([AUTO, { type: 'IMAGE_READY' }, { type: 'FRAME' }, { type: 'TIMEOUT' }]).phase, 'playing');
});

test('8) buffer/stall: travou volta à imagem (sem tela preta) e, ao recuperar, o vídeo reaparece', () => {
  let s = play([AUTO, { type: 'IMAGE_READY' }, { type: 'FRAME' }, { type: 'STALL' }]);
  assert.deepEqual(j([s.phase, s.shown, heroVideoMounted(s), heroShouldRun(s)]), ['stalled', false, true, true]); // continua tentando
  s = play([{ type: 'FRAME' }], s);
  assert.deepEqual(j([s.phase, s.shown]), ['playing', true]);
});

test('9/10) aba em segundo plano e hero fora da tela: pausa e retoma sozinho (sem mexer na fase)', () => {
  let s = play([AUTO, { type: 'IMAGE_READY' }, { type: 'FRAME' }]);
  assert.equal(heroShouldRun(s), true);
  s = play([{ type: 'TAB', visible: false }], s);
  assert.deepEqual(j([heroShouldRun(s), s.phase, s.shown]), [false, 'playing', true]);
  s = play([{ type: 'TAB', visible: true }, { type: 'VIEW', inView: false }], s);
  assert.equal(heroShouldRun(s), false);
  s = play([{ type: 'VIEW', inView: true }], s);
  assert.equal(heroShouldRun(s), true);
});

test('mudança de preferência durante a visita: reduzir movimento/economia de dados liga o modo manual e devolve a imagem; relaxar volta ao automático', () => {
  let s = play([AUTO, { type: 'IMAGE_READY' }, { type: 'FRAME' }]);
  s = play([{ type: 'PREF_CHANGE', decision: decideHeroVideo(VIDEO, { ...GOOD, reducedMotion: true }) }], s);
  assert.deepEqual(j([s.phase, s.shown, heroVideoMounted(s), heroControl(s)]), ['manual', false, false, 'play']);
  s = play([{ type: 'PREF_CHANGE', decision: decideHeroVideo(VIDEO, GOOD) }], s);
  assert.equal(s.phase, 'waiting-image');
  // o que já falhou continua falhado (nenhuma tentativa em laço)
  const failed = play([AUTO, { type: 'IMAGE_READY' }, { type: 'ERROR' }, { type: 'PREF_CHANGE', decision: decideHeroVideo(VIDEO, GOOD) }]);
  assert.equal(failed.phase, 'failed');
});

test('14/15/17) fontes: WebM/VP9 antes do MP4 (um download só); sem WebM cai no MP4; celular usa o conjunto menor e, sem ele, o principal', () => {
  assert.deepEqual(j(heroVideoSources(VIDEO, false)), [
    { src: '/editorial/video/hero-v1.webm', type: 'video/webm; codecs="vp9"' },
    { src: '/editorial/video/hero-v1.mp4', type: 'video/mp4' },
  ]);
  assert.deepEqual(j(heroVideoSources(VIDEO, true).map((s) => s.src)), ['/editorial/video/hero-v1-m.webm', '/editorial/video/hero-v1-m.mp4']);
  assert.deepEqual(j(heroVideoSources({ mp4: '/a.mp4' }, false)), [{ src: '/a.mp4', type: 'video/mp4' }]); // só MP4
  assert.deepEqual(j(heroVideoSources({ mp4: '/a.mp4', webm: '/a.webm' }, true).map((s) => s.src)), ['/a.webm', '/a.mp4']); // sem versão mobile
});

test('enquadramento: posições independentes para desktop e celular, com o mesmo padrão da imagem', () => {
  assert.deepEqual(j(heroVideoPosition(null)), { desktop: '67% center', mobile: '67% center' });
  assert.deepEqual(j(heroVideoPosition({ mp4: 'a', position: { desktop: '60% 40%' } })), { desktop: '60% 40%', mobile: '60% 40%' });
  assert.deepEqual(j(heroVideoPosition({ mp4: 'a', position: { desktop: '60% 40%', mobile: '30% 20%' } })), { desktop: '60% 40%', mobile: '30% 20%' });
});

test('componente: imagem sempre renderizada, vídeo mudo/inline, sem áudio, sem foco, sem hacks de autoplay', () => {
  const source = readFileSync(new URL('src/components/HeroMedia.tsx', root), 'utf8');
  assert.match(source, /<Image[\s\S]*priority/);
  assert.match(source, /video && mounted/); // sem vídeo configurado nenhum <video> entra na página
  for (const re of [/\bmuted\b/, /playsInline/, /preload="auto"/, /aria-hidden="true"/, /tabIndex=\{-1\}/, /disablePictureInPicture/, /setAttribute\('playsinline'/, /setAttribute\('muted'/]) assert.match(source, re, String(re));
  assert.match(source, /target instanceof HTMLSourceElement && target\.nextElementSibling !== null/); // falha do WebM não derruba: o MP4 ainda é tentado
  assert.match(source, /requestVideoFrameCallback/); // só mostra com frame apresentado
  assert.match(source, /PLAY_REJECTED/); // a Promise de play() é tratada
  assert.match(source, /IntersectionObserver/);
  assert.match(source, /visibilitychange/);
  assert.match(source, /prefers-reduced-motion/);
  assert.match(source, /aria-label=\{control === 'pause' \? 'Pausar vídeo de fundo' : 'Reproduzir vídeo de fundo'\}/);
  // nada de truques para burlar a política do navegador
  assert.doesNotMatch(source, /\.click\(\)|dispatchEvent|AudioContext|new Audio|unmute|muted\s*=\s*false|volume/);
  const page = readFileSync(new URL('src/app/page.tsx', root), 'utf8');
  assert.match(page, /<HeroMedia[\s\S]*video=\{HERO_VIDEO\}/);
});

test('cache dos vídeos versionados e CSP (media-src próprio) estão configurados', () => {
  const config = readFileSync(new URL('next.config.mjs', root), 'utf8');
  assert.match(config, /source: '\/editorial\/video\/:path\*'/);
  assert.match(config, /public, max-age=31536000, immutable/);
  assert.match(config, /media-src 'self'/);
});
