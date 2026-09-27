import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';

// URL das fotos de produto na CDN da Shopify (o TS real, transpilado).
const root = new URL('../', import.meta.url);
const ts = createRequire(new URL('package.json', root))('typescript');
const exports = {};
runInNewContext(
  ts.transpileModule(readFileSync(new URL('src/lib/product-image.ts', root), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2021 },
  }).outputText,
  { exports, URL },
);
const { isShopifyCdnUrl, shopifyImageUrl } = exports;
const SRC = 'https://cdn.shopify.com/s/files/1/0001/files/blazer.jpg?v=1712345678';

test('só a CDN da Shopify usa o redimensionamento dela', () => {
  assert.equal(isShopifyCdnUrl(SRC), true);
  assert.equal(isShopifyCdnUrl('https://res.cloudinary.com/demo/image.jpg'), false);
  assert.equal(isShopifyCdnUrl('/brand/logo-mark.svg'), false);
  assert.equal(isShopifyCdnUrl('http://cdn.shopify.com/x.jpg'), false);
  assert.equal(isShopifyCdnUrl('https://cdn.shopify.com.evil.example/x.jpg'), false);
});

test('pede a largura do srcset e preserva a versão do arquivo', () => {
  const url = new URL(shopifyImageUrl(SRC, 828, 2400));
  assert.equal(url.searchParams.get('width'), '828');
  assert.equal(url.searchParams.get('v'), '1712345678');
  assert.equal(url.hostname, 'cdn.shopify.com');
  assert.equal(url.searchParams.has('height'), false); // proporção sempre a original
});

test('nunca pede mais que a largura original (sem upscaling artificial)', () => {
  assert.equal(new URL(shopifyImageUrl(SRC, 3840, 1200)).searchParams.get('width'), '1200');
  assert.equal(new URL(shopifyImageUrl(SRC, 640, 1200)).searchParams.get('width'), '640');
  // Sem largura original conhecida (dados antigos): usa a do srcset; a CDN não amplia.
  assert.equal(new URL(shopifyImageUrl(SRC, 1920, null)).searchParams.get('width'), '1920');
  assert.equal(new URL(shopifyImageUrl(SRC, 1920, 0)).searchParams.get('width'), '1920');
});
