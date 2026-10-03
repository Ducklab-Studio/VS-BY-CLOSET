import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Regressão: a CSP (next.config.mjs) precisa liberar a Storefront API da
// Shopify no `connect-src`, porque o carrinho roda no navegador. Sem isso o
// navegador bloqueava toda chamada e "Alugar agora" falhava em qualquer data.
// Cada caso roda num processo próprio: o config lê o ambiente ao ser importado.
const config = new URL('../next.config.mjs', import.meta.url).href;
const marketingDir = fileURLToPath(new URL('..', import.meta.url));

function connectSrc(env) {
  const script = `import(${JSON.stringify(config)}).then(async (m) => {
    const headers = (await m.default('phase-production-server').headers())[0].headers;
    const csp = headers.find((h) => h.key === 'Content-Security-Policy').value;
    process.stdout.write(csp.split('; ').find((d) => d.startsWith('connect-src')));
  })`;
  const clean = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('NEXT_PUBLIC_') && k !== 'NODE_ENV'));
  const run = spawnSync(process.execPath, ['-e', script], { cwd: marketingDir, env: { ...clean, ...env }, encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  return run.stdout.split(' ');
}

test('libera a Storefront API da loja (domínio puro, como na Vercel)', () => {
  const directive = connectSrc({ NEXT_PUBLIC_SHOPIFY_STORE_DOMAIN: 'loja-teste.myshopify.com', NODE_ENV: 'production' });
  assert.ok(directive.includes('https://loja-teste.myshopify.com'), directive.join(' '));
  assert.ok(directive.includes("'self'"));
  assert.ok(!directive.includes('ws:'), 'sem ws: em produção');
});

test('aceita URL completa ou host com porta; mantém as URLs da API de reservas', () => {
  const directive = connectSrc({
    NEXT_PUBLIC_SHOPIFY_STORE_DOMAIN: 'https://loja-teste.myshopify.com/',
    NEXT_PUBLIC_HOLDS_URL: 'https://api.exemplo.test/holds',
    NODE_ENV: 'production',
  });
  assert.ok(directive.includes('https://loja-teste.myshopify.com'));
  assert.ok(directive.includes('https://api.exemplo.test'));
  assert.ok(connectSrc({ NEXT_PUBLIC_SHOPIFY_STORE_DOMAIN: '127.0.0.1:8443', NODE_ENV: 'production' }).includes('https://127.0.0.1:8443'));
});

test('sem loja configurada ou com http: não libera nada a mais', () => {
  assert.deepEqual(connectSrc({ NODE_ENV: 'production' }), ['connect-src', "'self'"]);
  assert.deepEqual(connectSrc({ NEXT_PUBLIC_SHOPIFY_STORE_DOMAIN: 'http://loja-teste.myshopify.com', NODE_ENV: 'production' }), ['connect-src', "'self'"]);
});
