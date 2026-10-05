import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';

// Travas contra a Shopify real em builds e testes: o código do site (catálogo e
// carrinho), o `next build` (next.config) e o bloqueio de rede dos processos.
// Nenhuma chamada sai daqui: `fetch` é falso, e os hosts "externos" usam `.invalid`.
const root = new URL('../', import.meta.url);
const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
const marketingDir = fileURLToPath(root);
const ts = createRequire(new URL('package.json', root))('typescript');
const transpile = (path) =>
  ts.transpileModule(readFileSync(new URL(path, root), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2021 },
  }).outputText;
const load = (path, globals = {}) => {
  const exports = {};
  runInNewContext(transpile(path), { exports, JSON, Set, Map, Number, Math, Array, String, Object, Error, URL, ...globals });
  return exports;
};

const guard = load('src/lib/shopify-network-guard.ts');
const REAL = { NEXT_PUBLIC_SHOPIFY_STORE_DOMAIN: 'loja-real.myshopify.com', NEXT_PUBLIC_SHOPIFY_STOREFRONT_TOKEN: 'token-publico-de-teste' };

test('trava pura: em mock-only só host local passa; fora dele, nada muda', () => {
  for (const domain of ['loja-real.myshopify.com', 'https://loja-real.myshopify.com/', 'api.exemplo.invalid']) {
    assert.throws(() => guard.assertShopifyNetworkAllowed(domain, 'mock-only'), /Shopify real bloqueada/);
  }
  for (const domain of ['127.0.0.1:8443', 'localhost:3000', 'https://127.0.0.1:9', 'loja.localhost']) {
    assert.doesNotThrow(() => guard.assertShopifyNetworkAllowed(domain, 'mock-only'));
  }
  assert.doesNotThrow(() => guard.assertShopifyNetworkAllowed('loja-real.myshopify.com', undefined), 'build de deploy: sem trava');
});

test('catálogo (shopify.ts) num bundle mock-only com loja real: recusa sem chamar a rede', async () => {
  let calls = 0;
  const shopify = load('src/lib/shopify.ts', {
    require: () => guard,
    process: { env: { ...REAL, NEXT_PUBLIC_SHOPIFY_NETWORK: 'mock-only' } },
    fetch: async () => { calls++; throw new Error('não deveria chamar'); },
    Intl,
  });
  await assert.rejects(() => shopify.listFeaturedProducts(), /Shopify real bloqueada/);
  await assert.rejects(() => shopify.listAllProductHandles(), /Shopify real bloqueada/);
  assert.equal(calls, 0);
});

test('carrinho (cart.ts) num bundle mock-only com loja real: nenhuma chamada sai', async () => {
  let calls = 0;
  const cart = load('src/lib/cart.ts', {
    require: (name) => {
      if (name === './shopify-network-guard') return guard;
      if (name === './shopify-stock') return load('src/lib/shopify-stock.ts');
      if (name === './rental-selection') return load('src/lib/rental-selection.ts', { Date });
      if (name === './vale-pass-product') return { isValePassProduct: () => false };
      throw new Error(`import inesperado: ${name}`);
    },
    process: { env: { ...REAL, NEXT_PUBLIC_SHOPIFY_NETWORK: 'mock-only' } },
    localStorage: { getItem: () => 'gid://shopify/Cart/1', setItem: () => undefined, removeItem: () => undefined },
    fetch: async () => { calls++; throw new Error('não deveria chamar'); },
    AbortController, setTimeout, clearTimeout,
  });
  await cart.fetchVariantStock(['gid://shopify/ProductVariant/1']).catch(() => undefined);
  await cart.getCart().catch(() => undefined);
  assert.equal(calls, 0);
});

/** Chama o next.config como o `next build` (fase de build) num processo limpo — sem .env do app. */
function buildConfig(env, phase = 'phase-production-build') {
  const config = new URL('next.config.mjs', root).href;
  const script = `import(${JSON.stringify(config)}).then((m) => { try { m.default(${JSON.stringify(phase)}); process.stdout.write('ok'); } catch (e) { process.stdout.write('ERRO: ' + e.message); } })`;
  const clean = Object.fromEntries(
    Object.entries(process.env).filter(([k]) => !k.startsWith('NEXT_PUBLIC_') && !['VERCEL', 'VERCEL_ENV', 'SHOPIFY_MOCK_BUILD', 'NODE_ENV', 'CI'].includes(k) && !k.startsWith('RAILWAY_')),
  );
  const run = spawnSync(process.execPath, ['-e', script], { cwd: marketingDir, env: { ...clean, ...env }, encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  return run.stdout;
}
const MOCK = { SHOPIFY_MOCK_BUILD: '1', NEXT_PUBLIC_SHOPIFY_NETWORK: 'mock-only', NEXT_PUBLIC_SHOPIFY_STORE_DOMAIN: '127.0.0.1:8443' };

test('next build fora da Vercel: só o simulado; credencial real no build simulado também para', () => {
  assert.match(buildConfig(REAL), /^ERRO: Build fora da Vercel bloqueado.*build:mock/);
  assert.match(buildConfig({ CI: 'true', NEXT_PUBLIC_SHOPIFY_STORE_DOMAIN: 'ci-placeholder.myshopify.com' }), /^ERRO: Build fora da Vercel bloqueado/);
  assert.match(buildConfig({ ...MOCK, NEXT_PUBLIC_SHOPIFY_STORE_DOMAIN: 'loja-real.myshopify.com' }), /^ERRO: Build simulado com loja que não é local/);
  assert.equal(buildConfig(MOCK), 'ok');
  assert.equal(buildConfig({ ...REAL, VERCEL: '1', VERCEL_ENV: 'production' }), 'ok', 'deploy na Vercel segue com as variáveis do projeto');
  assert.equal(buildConfig({ ...REAL, VERCEL: '1', VERCEL_ENV: 'preview' }), 'ok');
  assert.match(buildConfig({ ...REAL, VERCEL: '1', VERCEL_ENV: 'development' }), /^ERRO: Build fora da Vercel bloqueado/, '.env.local de `vercel env pull` não libera');
  assert.match(buildConfig({ ...REAL, VERCEL: '1' }), /^ERRO: Build fora da Vercel bloqueado/);
  // Deploy no Railway (serviço @valle/marketing): as variáveis de sistema do Railway liberam; uma só não basta.
  assert.equal(buildConfig({ ...REAL, RAILWAY_PROJECT_ID: 'projeto', RAILWAY_ENVIRONMENT_NAME: 'production' }), 'ok');
  assert.match(buildConfig({ ...REAL, RAILWAY_PROJECT_ID: 'projeto' }), /^ERRO: Build fora da Vercel bloqueado/);
  assert.equal(buildConfig(REAL, 'phase-production-server'), 'ok', 'a trava é só do build');
});

test('bloqueio de rede: tentativa a host externo reprova o comando, mesmo com o erro engolido', () => {
  const runner = fileURLToPath(new URL('scripts/no-real-network.mjs', `file:///${repoRoot.replace(/\\/g, '/')}`));
  const swallow = "fetch('https://loja-real.invalid/api').catch(() => {}).then(() => require('node:https').get('https://outra.invalid/').on('error', () => {}))";
  const blocked = spawnSync(process.execPath, [runner, process.execPath, '-e', swallow], { encoding: 'utf8' });
  assert.equal(blocked.status, 1);
  assert.match(blocked.stderr, /Rede real: \d tentativa\(s\) bloqueada\(s\) \(loja-real\.invalid/);
  const local = spawnSync(process.execPath, [runner, process.execPath, '-e', "fetch('http://127.0.0.1:9/').catch(() => {})"], { encoding: 'utf8' });
  assert.equal(local.status, 0, local.stderr);
  assert.match(local.stdout, /Rede real: 0 chamadas/);
});
