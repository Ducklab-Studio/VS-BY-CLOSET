import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright';

/**
 * Campanhas, lotes e capacidade do Valle Pass no ClosetAdmin, num navegador de verdade: API e site locais isolados, banco de
 * teste, nenhuma Shopify, nenhum e-mail. Nada aqui emite vale: os passes de apoio são gravados direto no banco de teste.
 * Roda na CI (Postgres efêmero) ou localmente contra um banco de teste listado em TEST_DATABASE_ALLOWED_HOSTS.
 */
const marketingDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const apiDir = path.resolve(marketingDir, '../reservations-api');
const requireApi = createRequire(path.join(apiDir, 'package.json'));
const { PrismaClient } = requireApi('@prisma/client');
const { generateSessionToken, hashSessionToken } = requireApi('./dist/src/admin/admin-session-token.js');

const databaseUrl = process.env.DATABASE_URL ?? '';
const host = (() => { try { return new URL(databaseUrl).hostname.toLowerCase(); } catch { return ''; } })();
const localTestDb = /^postgres(?:ql)?:\/\/[^@]+@(localhost|127\.0\.0\.1)(:\d+)?\/[^/?]*(test|audit|operational)/i.test(databaseUrl);
const allowedTestHost = (process.env.TEST_DATABASE_ALLOWED_HOSTS ?? '').split(',').map((h) => h.trim().toLowerCase()).filter(Boolean).includes(host);
if (!localTestDb && !allowedTestHost) throw new Error('O teste de lotes exige um banco de TESTE (local ou listado em TEST_DATABASE_ALLOWED_HOSTS).');
for (const key of ['SHOPIFY_STORE_DOMAIN', 'SHOPIFY_CLIENT_ID', 'SHOPIFY_CLIENT_SECRET', 'SHOPIFY_STOREFRONT_TOKEN']) {
  if (process.env[key]) throw new Error('Integrações externas configuradas; teste abortado.');
}

const apiUrl = 'http://127.0.0.1:3353';
const webUrl = 'http://127.0.0.1:3053';
const vallePass = `${webUrl}/closetadmin/valle-pass`;
const apiToken = randomBytes(32).toString('hex');
const prefix = `LOTES-${Date.now()}`;
const db = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
const childProcesses = [];
const userIds = [];
let browser;
/** Requisições do navegador para fora do computador (deve ficar vazio). */
const externalRequests = [];

function spawnLocal(command, args, cwd, env) {
  childProcesses.push(spawn(command, args, { cwd, env, stdio: 'ignore', windowsHide: true }));
}
async function waitFor(url) {
  for (let i = 0; i < 120; i++) {
    try {
      if ((await fetch(url, { signal: AbortSignal.timeout(1000) })).ok) return;
    } catch { /* ainda subindo */ }
    await delay(500);
  }
  throw new Error('Serviço local não iniciou.');
}

async function createUser(name, role) {
  const user = await db.adminUser.create({ data: { name, phone: `${Date.now()}${userIds.length}9`, pinHash: 'synthetic', role, moduleAccess: ['VALLE_PASS'] } });
  userIds.push(user.id);
  const token = generateSessionToken();
  await db.adminSession.create({ data: { adminUserId: user.id, tokenHash: hashSessionToken(token), expiresAt: new Date(Date.now() + 3_600_000) } });
  return { id: user.id, token };
}

async function newContext(token, options = {}) {
  const context = await browser.newContext(options);
  await context.route('**/*', (route) => {
    const hostname = new URL(route.request().url()).hostname;
    if (['localhost', '127.0.0.1'].includes(hostname)) return route.continue();
    externalRequests.push(hostname);
    return route.abort();
  });
  await context.addCookies([{ name: 'closetadmin_session', value: token, url: webUrl, httpOnly: true, sameSite: 'Lax' }]);
  return context;
}
async function newPage(context, errors) {
  const page = await context.newPage();
  page.setDefaultTimeout(30_000);
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });
  return page;
}

let campaignId = null;
async function clean() {
  for (const child of childProcesses) child.kill();
  await browser?.close();
  if (campaignId) {
    const lots = await db.valePassLot.findMany({ where: { campaignId }, select: { id: true } });
    await db.adminAuditEvent.deleteMany({ where: { entityId: { in: [campaignId, ...lots.map((l) => l.id)] } } });
    await db.valePassLot.deleteMany({ where: { campaignId } });
    await db.valePass.deleteMany({ where: { campaignId } });
    await db.valePassCampaign.deleteMany({ where: { id: campaignId } });
  }
  if (userIds.length) {
    await db.adminPresence.deleteMany({ where: { adminUserId: { in: userIds } } }).catch(() => undefined);
    await db.adminAuditEvent.deleteMany({ where: { adminUserId: { in: userIds } } }).catch(() => undefined);
    await db.adminSession.deleteMany({ where: { adminUserId: { in: userIds } } });
    await db.adminUser.deleteMany({ where: { id: { in: userIds } } });
  }
  await db.$disconnect();
}

const results = [];
const pass = (name) => { results.push(name); console.log(`  ✓ ${name}`); };
const card = (page) => page.locator('article', { hasText: 'Variante Shopify' }).filter({ hasText: `${prefix} Valle Pass` });
const expand = async (page) => {
  await card(page).getByRole('button', { name: /Capacidade, lotes e configuração/ }).click();
  await card(page).getByText('Capacidade', { exact: true }).waitFor();
};

try {
  const admin = await createUser(`Admin Lotes sintético ${prefix}`, 'ADMIN');
  const staff = await createUser(`Operador Lotes sintético ${prefix}`, 'STAFF');

  // Campanha de apoio com o limite LEGADO ligado (a configuração de teste encontrada na auditoria) e 3 passes emitidos.
  const campaign = await db.valePassCampaign.create({
    data: { name: `${prefix} Valle Pass`, amountCents: 35_000, validityDays: 30, quantityLimit: 10, shopifyVariantId: `${prefix}-variant` },
  });
  campaignId = campaign.id;
  for (let i = 0; i < 3; i++) {
    await db.valePass.create({ data: { code: `${prefix}-C${i}`, campaignId, amountCents: 35_000, status: i === 2 ? 'CANCELLED' : 'ACTIVE', purchasedAt: new Date(Date.now() - 60_000), expiresAt: new Date(Date.now() + 86_400_000) } });
  }

  const childEnv = {
    ...process.env, DATABASE_URL: databaseUrl, ADMIN_API_TOKEN: apiToken, PICKUP_REMINDER_ENABLED: 'false',
    VALE_PASS_ORDER_SYNC_INTERVAL_MINUTES: '0', CATALOG_SYNC_INTERVAL_MINUTES: '0', SHOPIFY_CLIENT_ID: '', SHOPIFY_CLIENT_SECRET: '',
  };
  spawnLocal(process.execPath, [path.join(apiDir, 'dist/src/main.js')], apiDir, { ...childEnv, PORT: '3353', NODE_ENV: 'development' });
  spawnLocal(process.execPath, [path.join(marketingDir, 'node_modules/next/dist/bin/next'), 'start', '-p', '3053', '-H', '127.0.0.1'], marketingDir, {
    ...childEnv, NODE_ENV: 'production', RESERVATIONS_API_ADMIN_URL: apiUrl, RESERVATIONS_API_URL: apiUrl, NEXT_TELEMETRY_DISABLED: '1', __NEXT_PROCESSED_ENV: 'true',
  });
  await waitFor(`${apiUrl}/health`);
  await waitFor(`${webUrl}/closetadmin/login`);
  browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_BROWSER_CHANNEL ? { channel: process.env.PLAYWRIGHT_BROWSER_CHANNEL } : {}) });

  const errors = [];
  const context = await newContext(admin.token, { viewport: { width: 1280, height: 1000 } });
  const page = await newPage(context, errors);

  // 1) Capacidade: totais, saldo, alerta do limite LEGADO e aviso de que o painel não altera a Shopify.
  await page.goto(vallePass);
  await card(page).waitFor();
  await expand(page);
  await card(page).getByText('Vendidos (não cancelados)').waitFor();
  await card(page).getByText('3 emitidos, 1 cancelados').waitFor(); // vendidos = 3 emitidos − 1 cancelado
  await card(page).getByText(/limite LEGADO/).waitFor();
  await card(page).getByText(/Nenhum limite global configurado/).waitFor();
  await card(page).getByText(/o estoque da Shopify é ajustado à mão/).waitFor();
  pass('1) capacidade: vendidos (3 emitidos − 1 cancelado), alerta do limite legado e aviso de que a Shopify não é alterada');

  // 2) Sem limite global não abre lote (mensagem clara da API); edita a configuração pela tela e define 1.000.
  await card(page).getByPlaceholder('Lote 1').fill('Lote 1');
  await card(page).getByPlaceholder('100', { exact: true }).fill('100');
  await card(page).getByRole('button', { name: 'Criar lote' }).click();
  await card(page).getByText('Lote 1', { exact: true }).waitFor();
  await card(page).getByRole('button', { name: 'Abrir lote' }).click();
  await page.getByRole('button', { name: 'Abrir', exact: true }).click();
  await page.getByText(/Defina o limite global de passes/).first().waitFor();
  assert.equal((await db.valePassLot.findFirst({ where: { campaignId } })).status, 'PLANNED');
  await page.getByRole('button', { name: 'Cancelar', exact: true }).first().click(); // fecha o diálogo
  pass('2) lote criado; abrir sem limite global é recusado com explicação e nada muda no banco');

  await card(page).getByRole('button', { name: 'Editar configuração' }).click();
  await card(page).getByLabel(/Limite GLOBAL/).fill('1000');
  await card(page).getByLabel(/Limite de emissão \(LEGADO\)/).fill('');
  await card(page).getByLabel(/Vouchers válidos de/).fill('2027-01-01');
  await card(page).getByLabel(/^até/).fill('2027-12-31');
  await card(page).getByRole('button', { name: 'Salvar configuração' }).click();
  await card(page).getByText('Limite GLOBAL de passes (todos os lotes)').waitFor({ state: 'detached' });
  const saved = await db.valePassCampaign.findUnique({ where: { id: campaignId } });
  assert.equal(saved.globalLimit, 1000);
  assert.equal(saved.quantityLimit, null);
  assert.equal(saved.voucherValidFrom.toISOString().slice(0, 10), '2027-01-01');
  assert.equal(saved.voucherValidUntil.toISOString().slice(0, 10), '2027-12-31');
  assert.equal(saved.amountCents, 35_000); // valor e validade em dias não mudaram
  assert.equal(await db.valePass.count({ where: { campaignId, amountCents: 35_000 } }), 3); // passes emitidos intactos
  const audit = await db.adminAuditEvent.findFirst({ where: { entityId: campaignId, action: 'VALE_PASS_CAMPAIGN_UPDATED' } });
  assert.deepEqual(audit.after, { quantityLimit: null, globalLimit: 1000, voucherValidFrom: '2027-01-01', voucherValidUntil: '2027-12-31' });
  assert.equal(audit.adminUserId, admin.id);
  pass('2b) editar a configuração pela tela: limite global 1.000, limite legado removido, validade 2027; passes emitidos intactos; auditoria com antes/depois');

  // 3) Abrir o lote, ver o saldo e a recomendação de estoque; encerrar; um lote encerrado não reabre.
  await page.reload();
  await card(page).waitFor();
  await expand(page);
  await card(page).getByText('998', { exact: true }).waitFor(); // saldo global: 1000 − 2 vendidos
  await card(page).getByRole('button', { name: 'Abrir lote' }).click();
  await page.getByRole('button', { name: 'Abrir', exact: true }).click();
  await card(page).getByText('Aberto', { exact: true }).waitFor();
  await card(page).getByText('0/100 vendidos · restam 100').waitFor();
  await card(page).getByText(/Estoque recomendado na Shopify agora/).waitFor();
  assert.equal((await db.valePassLot.findFirst({ where: { campaignId } })).status, 'OPEN');
  await card(page).getByRole('button', { name: 'Encerrar lote' }).click();
  await page.getByRole('button', { name: 'Encerrar', exact: true }).click();
  await card(page).getByText('Encerrado', { exact: true }).waitFor();
  assert.equal(await card(page).getByRole('button', { name: 'Abrir lote' }).count(), 0);
  assert.deepEqual((await db.adminAuditEvent.findMany({ where: { entityType: 'ValePassLot' }, orderBy: { createdAt: 'asc' } })).map((e) => e.action), ['VALE_PASS_LOT_CREATED', 'VALE_PASS_LOT_OPENED', 'VALE_PASS_LOT_CLOSED']);
  pass('3) abrir lote (saldo e estoque recomendado), encerrar, sem botão de reabrir; 3 eventos de auditoria');

  // 4) Versão antiga: outra aba abre/encerra por cima; esta aba (desatualizada) recebe a mensagem e nada é aplicado.
  await card(page).getByPlaceholder('Lote 1').fill('Lote 2');
  await card(page).getByPlaceholder('100', { exact: true }).fill('50');
  await card(page).getByRole('button', { name: 'Criar lote' }).click();
  await card(page).getByText('Lote 2', { exact: true }).waitFor();
  const lot2 = await db.valePassLot.findFirst({ where: { campaignId, name: 'Lote 2' } });
  await db.valePassLot.update({ where: { id: lot2.id }, data: { name: 'Lote 2 (alterado em outra aba)' } }); // muda a versão (updatedAt)
  await card(page).getByRole('button', { name: 'Abrir lote' }).click();
  await page.getByRole('button', { name: 'Abrir', exact: true }).click();
  await page.getByText(/foi alterado por outra pessoa/).first().waitFor();
  assert.equal((await db.valePassLot.findUnique({ where: { id: lot2.id } })).status, 'PLANNED');
  await page.getByRole('button', { name: 'Cancelar', exact: true }).first().click();
  pass('4) ação sobre versão antiga do lote: mensagem "alterado por outra pessoa" e nada é aplicado');

  // 5) Perfil sem ADMIN: vê a capacidade, mas não tem botões de escrita, e a API recusa a escrita (403).
  const staffCtx = await newContext(staff.token, { viewport: { width: 1280, height: 1000 } });
  const staffPage = await newPage(staffCtx, errors);
  await staffPage.goto(vallePass);
  await card(staffPage).waitFor();
  await expand(staffPage);
  await card(staffPage).getByText('Vendidos (não cancelados)').waitFor();
  assert.equal(await card(staffPage).getByRole('button', { name: /Editar configuração|Criar lote|Abrir lote|Encerrar lote|Cancelar lote|Alterar quantidade/ }).count(), 0);
  const current = await db.valePassCampaign.findUnique({ where: { id: campaignId } });
  const forbidden = await fetch(`${apiUrl}/admin/vale-pass/campaigns/${campaignId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiToken}`, 'X-Admin-Session': staff.token },
    body: JSON.stringify({ adminUserId: staff.id, expectedUpdatedAt: current.updatedAt.toISOString(), globalLimit: 5 }),
  });
  assert.equal(forbidden.status, 403);
  assert.equal((await db.valePassCampaign.findUnique({ where: { id: campaignId } })).globalLimit, 1000);
  pass('5) sem perfil ADMIN: só leitura na tela e a API recusa a edição (403), sem alterar nada');

  // 6) Celular: sem rolagem lateral e os botões continuam alcançáveis.
  const mobile = await newContext(admin.token, { viewport: { width: 390, height: 844 } });
  const mobilePage = await newPage(mobile, errors);
  await mobilePage.goto(vallePass);
  await card(mobilePage).waitFor();
  await expand(mobilePage);
  await card(mobilePage).getByRole('button', { name: 'Editar configuração' }).waitFor();
  assert.equal(await mobilePage.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth), 0);
  pass('6) celular (390px): sem rolagem lateral e botões visíveis');

  assert.deepEqual(errors, []);
  assert.deepEqual(externalRequests, [], 'o navegador tentou acessar a internet (Shopify real?)');
  pass('7) nenhum erro no console nem acesso externo');

  console.log(`Lotes do Valle Pass no navegador: ${results.length} verificações passaram.`);
} finally {
  await clean();
}
