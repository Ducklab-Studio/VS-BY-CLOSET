import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';

// Estrutura do vídeo do hero: hoje SEM vídeo (só imagem); quando houver, só carrega quando não atrapalha e a imagem segue como fallback.
const root = new URL('../', import.meta.url);
const ts = createRequire(new URL('package.json', root))('typescript');
const exports = {};
runInNewContext(
  ts.transpileModule(readFileSync(new URL('src/lib/hero-media.ts', root), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2021 } }).outputText,
  { exports },
);
const { HERO_VIDEO, shouldLoadHeroVideo } = exports;

test('estado atual: nenhum vídeo configurado (nada inventado nem publicado)', () => {
  assert.equal(HERO_VIDEO, null);
});

test('o vídeo só carrega em condições boas: sem "reduzir movimento", sem economia de dados, fora de conexão lenta', () => {
  assert.equal(shouldLoadHeroVideo({ reducedMotion: false, saveData: false, effectiveType: '4g' }), true);
  assert.equal(shouldLoadHeroVideo({ reducedMotion: false, saveData: false }), true);
  assert.equal(shouldLoadHeroVideo({ reducedMotion: false, saveData: false, effectiveType: null }), true);
  assert.equal(shouldLoadHeroVideo({ reducedMotion: true, saveData: false, effectiveType: '4g' }), false);
  assert.equal(shouldLoadHeroVideo({ reducedMotion: false, saveData: true, effectiveType: '4g' }), false);
  for (const slow of ['slow-2g', '2g', '3g']) assert.equal(shouldLoadHeroVideo({ reducedMotion: false, saveData: false, effectiveType: slow }), false, slow);
});

test('o componente mantém a imagem como fallback, não toca áudio e se desliga em caso de erro', () => {
  const source = readFileSync(new URL('src/components/HeroMedia.tsx', root), 'utf8');
  assert.match(source, /<Image[\s\S]*priority/); // imagem sempre renderizada
  assert.match(source, /video && enabled/); // sem vídeo configurado, nenhum <video>
  assert.match(source, /\bmuted\b/);
  assert.match(source, /playsInline/);
  assert.match(source, /preload="metadata"/);
  assert.match(source, /aria-hidden="true"/);
  assert.match(source, /onError=\{[\s\S]*setEnabled\(false\)/);
  assert.match(source, /IntersectionObserver/); // pausa fora da tela
  assert.match(source, /visibilitychange/); // pausa com a aba oculta
  assert.doesNotMatch(source, /autoPlay/); // quem inicia é o efeito, depois do carregamento da página
  const page = readFileSync(new URL('src/app/page.tsx', root), 'utf8');
  assert.match(page, /<HeroMedia[\s\S]*video=\{HERO_VIDEO\}/);
});
