import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

/**
 * Regra visual do SKU (item pedido após a correção do badge "Livre"):
 * peça active=false com variante Shopify ausente (shopifyVariantMissingAt)
 * nunca mostra o SKU como se estivesse ativo — mostra "SKU desvinculado" no
 * lugar, tanto no card (mobile) quanto na linha da tabela (desktop). O
 * valor antigo continua só no banco (histórico/restauração), nunca
 * renderizado. Puro fetch de HTML server-renderizado — sem Playwright: a
 * regra é toda SSR, o card e a tabela já saem os dois no mesmo HTML (só
 * classes Tailwind md:hidden/hidden md:block escondem um dos dois por
 * CSS), então não precisa de navegador real nem de emular viewport.
 */
const marketingDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const apiDir = path.resolve(marketingDir, '../reservations-api');
const requireApi = createRequire(path.join(apiDir, 'package.json'));
const { PrismaClient } = requireApi('@prisma/client');
const { generateSessionToken, hashSessionToken } = requireApi('./dist/src/admin/admin-session-token.js');

const databaseUrl = process.env.DATABASE_URL ?? '';
if (!/^postgres(?:ql)?:\/\/[^@]+@(localhost|127\.0\.0\.1)(:\d+)?\//i.test(databaseUrl)) {
  throw new Error('Este teste exige PostgreSQL local isolado.');
}
if (!/(test|audit|operational)/i.test(new URL(databaseUrl).pathname)) {
  throw new Error('O nome do banco local precisa identificar uma base de teste.');
}
for (const key of ['SHOPIFY_STORE_DOMAIN', 'SHOPIFY_CLIENT_SECRET', 'SHOPIFY_STOREFRONT_TOKEN']) {
  if (process.env[key]) throw new Error('Integrações externas configuradas; teste abortado.');
}

const apiUrl = 'http://127.0.0.1:3351';
const webUrl = 'http://127.0.0.1:3051';
const apiToken = randomBytes(32).toString('hex');
const prefix = `SKU-${Date.now()}`;
const db = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
const childProcesses = [];
let userId;

function spawnLocal(command, args, cwd, env) {
  const child = spawn(command, args, { cwd, env, stdio: 'ignore', windowsHide: true });
  childProcesses.push(child);
}
async function waitFor(url) {
  for (let i = 0; i < 120; i++) {
    try {
      if ((await fetch(url, { signal: AbortSignal.timeout(1000) })).ok) return;
    } catch { /* server ainda subindo */ }
    await delay(500);
  }
  throw new Error('Serviço local não iniciou.');
}

const STALE_SKU = `${prefix}-STALE-SKU`;
const LIVE_SKU = `${prefix}-LIVE-SKU`;

async function seed() {
  const user = await db.adminUser.create({ data: {
    name: 'Operador sintético', phone: `${Date.now()}998`, pinHash: 'synthetic',
    role: 'STAFF', moduleAccess: ['PIECES'],
  } });
  userId = user.id;
  const token = generateSessionToken();
  await db.adminSession.create({ data: { adminUserId: user.id, tokenHash: hashSessionToken(token), expiresAt: new Date(Date.now() + 3_600_000) } });

  // Peça desativada pela sincronização de catálogo (variante removida da
  // Shopify) — exatamente o estado que shopify-catalog-sync.service.ts
  // grava: active=false + shopifyVariantMissingAt preenchido. O SKU antigo
  // continua no registro — é isso que o teste prova que NÃO aparece na tela.
  await db.rentalUnit.create({ data: {
    code: `${prefix}-inactive`, name: 'Peça desvinculada de teste',
    shopifyProductId: `${prefix}-inactive-product`, shopifyVariantId: `${prefix}-inactive-variant`, shopifySku: STALE_SKU,
    active: false, reservableOnline: true, countsTowardRentalDuration: true,
    shopifyVariantMissingAt: new Date(),
  } });

  // Peça ativa comum, pro contraste: o SKU dela precisa continuar aparecendo normalmente.
  await db.rentalUnit.create({ data: {
    code: `${prefix}-active`, name: 'Peça ativa de teste',
    shopifyProductId: `${prefix}-active-product`, shopifyVariantId: `${prefix}-active-variant`, shopifySku: LIVE_SKU,
    active: true, reservableOnline: true, countsTowardRentalDuration: true,
  } });

  return token;
}

async function clean() {
  for (const child of childProcesses) child.kill();
  await db.rentalUnit.deleteMany({ where: { code: { startsWith: prefix } } });
  if (userId) {
    await db.adminSession.deleteMany({ where: { adminUserId: userId } });
    await db.adminUser.delete({ where: { id: userId } });
  }
  await db.$disconnect();
}

try {
  const token = await seed();
  const childEnv = { ...process.env, DATABASE_URL: databaseUrl, ADMIN_API_TOKEN: apiToken, PICKUP_REMINDER_ENABLED: 'false' };
  spawnLocal(process.execPath, [path.join(apiDir, 'dist/src/main.js')], apiDir, { ...childEnv, PORT: '3351', NODE_ENV: 'development' });
  spawnLocal(process.execPath, [path.join(marketingDir, 'node_modules/next/dist/bin/next'), 'start', '-p', '3051', '-H', '127.0.0.1'], marketingDir, {
    ...childEnv, NODE_ENV: 'production', RESERVATIONS_API_ADMIN_URL: apiUrl, RESERVATIONS_API_URL: apiUrl, NEXT_TELEMETRY_DISABLED: '1',
  });
  await waitFor(`${apiUrl}/health`);
  await waitFor(`${webUrl}/closetadmin/login`);

  const response = await fetch(`${webUrl}/closetadmin/pecas`, { headers: { Cookie: `closetadmin_session=${token}` } });
  assert.equal(response.status, 200);
  const fullHtml = await response.text();
  // O HTML de streaming do App Router embute, além do markup renderizado,
  // um payload serializado (RSC/"flight") em <script> pra hidratação —
  // ele repete o mesmo texto de novo, o que dobraria qualquer contagem.
  // Removendo os <script> sobra só o markup real (card + tabela).
  const html = fullHtml.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '');

  // Nunca o valor antigo do SKU chega ao cliente — nem no markup renderizado,
  // nem no payload de hidratação (RSC/"flight") embutido nos <script>. Checa
  // no HTML completo (sem tirar os <script>): garantia mais forte que só
  // "não aparece visível" — o valor não é sequer transmitido.
  assert.equal(fullHtml.includes(STALE_SKU), false, 'SKU antigo da peça desativada foi transmitido ao cliente');

  // "SKU desvinculado" aparece exatamente 2 vezes: uma no card (mobile),
  // outra na linha da tabela (desktop) — os dois saem no mesmo HTML SSR,
  // só um fica escondido por CSS conforme a largura da tela.
  const label = 'SKU desvinculado';
  const occurrences = html.split(label).length - 1;
  assert.equal(occurrences, 2, `esperava "${label}" 2x (card + tabela), achei ${occurrences}`);

  // Contraste: a peça ATIVA continua mostrando o SKU real, também nos dois lugares.
  const liveOccurrences = html.split(LIVE_SKU).length - 1;
  assert.equal(liveOccurrences, 2, `esperava o SKU da peça ativa 2x (card + tabela), achei ${liveOccurrences}`);

  console.log('SKU inativo: card e tabela mostram "SKU desvinculado", valor antigo nunca aparece, peça ativa mostra o SKU real.');
} finally {
  await clean();
}
