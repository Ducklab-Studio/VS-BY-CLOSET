/**
 * `pnpm --filter @valle/marketing build:mock` — o ÚNICO build permitido fora do
 * deploy na Vercel (ver scripts/shopify-build-guard.mjs). Usado na CI e em
 * qualquer validação local.
 *
 *  - O Next NÃO lê o `.env.local`: com NODE_ENV=test ele nem entra na lista de
 *    arquivos carregados (e `.env.test*`/`.env` não existem neste app). O bundle
 *    continua sendo o de produção — o Next grava `production` nele de todo jeito.
 *  - A loja é uma Shopify SIMULADA local (`SHOPIFY_MOCK_DOMAIN`, padrão
 *    127.0.0.1:8443, só host local é aceito) e o bundle sai marcado `mock-only`:
 *    catálogo e carrinho recusam qualquer host que não seja local.
 *  - Rede real bloqueada em todos os processos do build (scripts/no-real-network.mjs):
 *    qualquer tentativa reprova o build, mesmo que o código engula o erro.
 *  - No fim, confere que nenhum arquivo gerado cita um domínio de loja Shopify
 *    real (`*.myshopify.com`). O script também não abre o .env.local.
 */
import { readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runWithoutRealNetwork } from '../../../scripts/no-real-network.mjs';

const marketingDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const mockDomain = (process.env.SHOPIFY_MOCK_DOMAIN ?? '127.0.0.1:8443').trim();
const mockHost = new URL(`https://${mockDomain}`).hostname;
if (!/^(localhost|127(\.\d{1,3}){3}|\[::1\])$/i.test(mockHost)) {
  console.error('SHOPIFY_MOCK_DOMAIN precisa ser um host local (localhost/127.x).');
  process.exit(2);
}
const closed = 'http://127.0.0.1:9';

const env = {
  NODE_ENV: 'test',
  SHOPIFY_MOCK_BUILD: '1',
  NEXT_PUBLIC_SHOPIFY_NETWORK: 'mock-only',
  NEXT_PUBLIC_SHOPIFY_STORE_DOMAIN: mockDomain,
  NEXT_PUBLIC_SHOPIFY_STOREFRONT_TOKEN: 'token-publico-de-teste',
  NEXT_PUBLIC_SHOPIFY_STORE_URL: `https://${mockDomain}`,
  // Nada de deploy/OIDC/API real chega a este build.
  VERCEL: '',
  VERCEL_ENV: '',
  VERCEL_OIDC_TOKEN: '',
  RESERVATIONS_API_ADMIN_URL: closed,
  RESERVATIONS_API_URL: closed,
  ADMIN_API_TOKEN: 'build-simulado',
  NEXT_PUBLIC_AVAILABILITY_URL: process.env.NEXT_PUBLIC_AVAILABILITY_URL ?? '/api/availability',
  NEXT_PUBLIC_RENTAL_PLAN_URL: process.env.NEXT_PUBLIC_RENTAL_PLAN_URL ?? `${closed}/rental-plan`,
  NEXT_PUBLIC_HOLDS_URL: process.env.NEXT_PUBLIC_HOLDS_URL ?? `${closed}/holds`,
  NEXT_PUBLIC_CHECKOUT_URL: process.env.NEXT_PUBLIC_CHECKOUT_URL ?? `${closed}/checkout`,
  NEXT_PUBLIC_RESERVATIONS_URL: process.env.NEXT_PUBLIC_RESERVATIONS_URL ?? `${closed}/reservations`,
};
for (const [key, value] of Object.entries(env)) {
  if (/^NEXT_PUBLIC_(AVAILABILITY|RENTAL_PLAN|HOLDS|CHECKOUT|RESERVATIONS)_URL$/.test(key) && /^https?:\/\//i.test(value)) {
    const host = new URL(value).hostname;
    if (!/^(localhost|127(\.\d{1,3}){3})$/i.test(host)) {
      console.error(`${key} precisa apontar para um host local no build simulado.`);
      process.exit(2);
    }
  }
}

// Saída anterior (inclusive cache de um build antigo) não pode contaminar a conferência.
rmSync(path.join(marketingDir, '.next'), { recursive: true, force: true });
const nextBin = path.join(marketingDir, 'node_modules/next/dist/bin/next');
const status = runWithoutRealNetwork(process.execPath, [nextBin, 'build'], { cwd: marketingDir, env });
if (status !== 0) process.exit(status);

// Domínio de loja real no que foi gerado (bundle, páginas, cache de fetch)? Deve
// ser zero. Procura qualquer `*.myshopify.com` — não precisa abrir o .env.local.
const REAL_STORE = /[a-z0-9-]+\.myshopify\.com/i;
let scanned = 0;
const hits = [];
function scan(dir) {
  for (const name of readdirSync(dir)) {
    const file = path.join(dir, name);
    const info = statSync(file, { throwIfNoEntry: false });
    if (!info) continue;
    // Source maps e o cache do Turbopack só guardam o código-fonte (com seus
    // comentários); o que importa é o que vai para o bundle e o cache de fetch.
    if (info.isDirectory()) {
      if (name !== 'turbopack' && name !== 'webpack') scan(file);
    } else if (!name.endsWith('.map') && info.size < 50_000_000) {
      scanned++;
      if (REAL_STORE.test(readFileSync(file, 'latin1'))) hits.push(path.relative(marketingDir, file));
    }
  }
}
scan(path.join(marketingDir, '.next'));
if (hits.length > 0) {
  console.error(`✖ ${hits.length} arquivo(s) gerado(s) citam um domínio de loja Shopify real: ${hits.slice(0, 5).join(', ')}. Build reprovado.`);
  process.exit(1);
}
console.log(`Build simulado: ${scanned} arquivos gerados conferidos, nenhum com domínio de loja Shopify real.`);
