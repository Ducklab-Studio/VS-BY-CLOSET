import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright';

/**
 * Valle Pass 2027 (dois vouchers) no ClosetAdmin, num navegador de verdade: API e site locais isolados, banco de teste, nenhuma
 * Shopify, nenhum e-mail. Cobre: cadastro do modelo de benefícios, fila de pagamentos retidos (descartar recusado enquanto o pedido
 * está pago, emitir com justificativa) e a exibição dos dois vouchers com empresa e validade. O webhook financeiro NÃO é exercitado.
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
if (!localTestDb && !allowedTestHost) throw new Error('O teste de dois vouchers exige um banco de TESTE (local ou listado em TEST_DATABASE_ALLOWED_HOSTS).');
for (const key of ['SHOPIFY_STORE_DOMAIN', 'SHOPIFY_CLIENT_ID', 'SHOPIFY_CLIENT_SECRET', 'SHOPIFY_STOREFRONT_TOKEN']) {
  if (process.env[key]) throw new Error('Integrações externas configuradas; teste abortado.');
}

const apiUrl = 'http://127.0.0.1:3354';
const webUrl = 'http://127.0.0.1:3054';
const vallePass = `${webUrl}/closetadmin/valle-pass`;
const apiToken = randomBytes(32).toString('hex');
const prefix = `DOISV-${Date.now()}`;
const db = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
const childProcesses = [];
const userIds = [];
let browser;
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
const orderIds = [];
let storeId = null;
async function clean() {
  for (const child of childProcesses) child.kill();
  await browser?.close();
  if (campaignId) {
    const holds = await db.valePassIssuanceHold.findMany({ where: { campaignId }, select: { id: true } });
    const passes = await db.valePass.findMany({ where: { campaignId }, select: { id: true } });
    await db.adminAuditEvent.deleteMany({ where: { entityId: { in: [campaignId, ...holds.map((h) => h.id), ...passes.map((p) => p.id)] } } });
    await db.valePassEvent.deleteMany({ where: { valePassId: { in: passes.map((p) => p.id) } } });
    await db.valePass.deleteMany({ where: { campaignId } });
    await db.valePassIssuanceHold.deleteMany({ where: { campaignId } });
    await db.valePassCampaignBenefit.deleteMany({ where: { campaignId } });
    await db.valePassCampaign.deleteMany({ where: { id: campaignId } });
  }
  if (orderIds.length) {
    await db.webhookEvent.deleteMany({ where: { orderId: { in: orderIds } } });
    const regs = await db.valePassOrder.findMany({ where: { shopifyOrderId: { in: orderIds } }, select: { id: true } });
    await db.valePassOrderEvent.deleteMany({ where: { valePassOrderId: { in: regs.map((r) => r.id) } } });
    await db.valePassOrder.deleteMany({ where: { shopifyOrderId: { in: orderIds } } });
  }
  if (storeId) await db.$executeRaw`DELETE FROM stores WHERE id = ${storeId}`;
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
  const admin = await createUser(`Admin DoisV sintético ${prefix}`, 'ADMIN');
  const staff = await createUser(`Operador DoisV sintético ${prefix}`, 'STAFF');

  const campaign = await db.valePassCampaign.create({
    data: {
      name: `${prefix} Valle Pass`, amountCents: 35_000, validityDays: 30, globalLimit: 1000, shopifyVariantId: `${prefix}-variant`,
      voucherValidFrom: new Date('2027-01-01T00:00:00Z'), voucherValidUntil: new Date('2027-12-31T00:00:00Z'),
    },
  });
  campaignId = campaign.id;

  const childEnv = {
    ...process.env, DATABASE_URL: databaseUrl, ADMIN_API_TOKEN: apiToken, PICKUP_REMINDER_ENABLED: 'false',
    VALE_PASS_ORDER_SYNC_INTERVAL_MINUTES: '0', CATALOG_SYNC_INTERVAL_MINUTES: '0', SHOPIFY_CLIENT_ID: '', SHOPIFY_CLIENT_SECRET: '',
  };
  spawnLocal(process.execPath, [path.join(apiDir, 'dist/src/main.js')], apiDir, { ...childEnv, PORT: '3354', NODE_ENV: 'development' });
  spawnLocal(process.execPath, [path.join(marketingDir, 'node_modules/next/dist/bin/next'), 'start', '-p', '3054', '-H', '127.0.0.1'], marketingDir, {
    ...childEnv, NODE_ENV: 'production', RESERVATIONS_API_ADMIN_URL: apiUrl, RESERVATIONS_API_URL: apiUrl, NEXT_TELEMETRY_DISABLED: '1', __NEXT_PROCESSED_ENV: 'true',
  });
  await waitFor(`${apiUrl}/health`);
  await waitFor(`${webUrl}/closetadmin/login`);
  browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_BROWSER_CHANNEL ? { channel: process.env.PLAYWRIGHT_BROWSER_CHANNEL } : {}) });

  const errors = [];
  const context = await newContext(admin.token, { viewport: { width: 1280, height: 1100 } });
  const page = await newPage(context, errors);

  // 1) Sem benefícios: modelo antigo; o ADMIN cadastra o modelo Valle Pass 2027 pela tela (sugestão + confirmação).
  await page.goto(vallePass);
  await card(page).waitFor();
  await expand(page);
  await card(page).getByText(/segue o modelo antigo/).waitFor();
  await card(page).getByRole('button', { name: 'Sugerir modelo Valle Pass 2027' }).click();
  assert.equal(await db.valePassCampaignBenefit.count({ where: { campaignId } }), 0); // sugerir não grava nada
  await card(page).getByRole('button', { name: 'Confirmar cadastro' }).click();
  await card(page).getByText('Voucher Valle Showroom').waitFor();
  await card(page).getByText(/exclusivo VS BY CLOSET/).waitFor();
  await card(page).getByText(/10% \(direito comercial, sem código nem saldo\)/).waitFor();
  const benefits = await db.valePassCampaignBenefit.findMany({ where: { campaignId }, orderBy: { sortOrder: 'asc' } });
  assert.deepEqual(benefits.map((b) => [b.code, b.kind, b.company, b.amountCents, b.discountPercent]), [
    ['valle_showroom_500', 'VOUCHER', 'VALLE_SHOWROOM', 50_000, null],
    ['vs_by_closet_50', 'VOUCHER', 'VS_BY_CLOSET', 5_000, null],
    ['desconto_passeios', 'DISCOUNT', null, null, 10],
  ]);
  assert.equal(await db.valePass.count({ where: { campaignId } }), 0); // cadastrar benefícios não emite nada
  assert.equal((await db.adminAuditEvent.findFirst({ where: { entityId: campaignId, action: 'VALE_PASS_BENEFITS_UPDATED' } })).adminUserId, admin.id);
  pass('1) modelo Valle Pass 2027 cadastrado pela tela (sugestão só grava após confirmar); nenhum voucher emitido; auditado');

  // 2) Pagamento retido (fila): descartar é recusado enquanto o pedido está pago; emitir exige justificativa e cria os DOIS vouchers.
  storeId = `${prefix}-store`;
  await db.$executeRaw`INSERT INTO stores (id, shopify_domain, currency) VALUES (${storeId}, ${storeId + '.invalid'}, 'BRL')`;
  const orderId = `${prefix}-order`;
  orderIds.push(orderId);
  await db.valePassOrder.create({
    data: {
      shopifyOrderId: orderId, shopifyOrderGid: `gid://shopify/Order/${orderId}`, shopifyOrderName: `${prefix}#1`, status: 'CONFIRMED', financialStatus: 'paid',
      quantity: 1, customerName: 'Cliente Sintético', customerEmail: 'cliente@exemplo.invalid', customerPhone: '+5500000000000', lastSyncSource: 'teste',
      orderCreatedAt: new Date(Date.now() - 3_600_000), statusChangedAt: new Date(Date.now() - 3_600_000), vouchersProcessedAt: new Date(),
    },
  });
  const hold = await db.valePassIssuanceHold.create({
    data: { shopifyOrderId: orderId, campaignId, units: 1, reason: 'CAPACITY_EXCEEDED', status: 'OPEN', openFlag: true, detail: { globalLimit: 1000 } },
  });
  await page.reload();
  await card(page).waitFor();
  await expand(page);
  await card(page).getByText(/Pagamentos confirmados aguardando resolução \(1\)/).waitFor();
  await card(page).getByText(/Limite global esgotado/).waitFor();
  await card(page).getByText(/ISSUANCE_HOLDS_OPEN|aguardam resolução de um administrador/).first().waitFor();
  await card(page).getByRole('button', { name: 'Resolver' }).click();
  const emitir = card(page).getByRole('button', { name: /Emitir \(excedente aprovado\)/ });
  assert.equal(await emitir.isDisabled(), true); // sem justificativa não habilita
  await card(page).getByLabel(/Justificativa/).fill('Teste: pedido ainda pago');
  await card(page).getByRole('button', { name: /Descartar/ }).click();
  await card(page).getByText(/continua pago/).waitFor();
  assert.equal((await db.valePassIssuanceHold.findUnique({ where: { id: hold.id } })).status, 'OPEN');
  assert.equal(await db.valePass.count({ where: { campaignId } }), 0);
  pass('2) pagamento retido listado; descartar recusado enquanto o pedido está pago; sem justificativa não habilita');

  await card(page).getByLabel(/Justificativa/).fill('Excedente aprovado no teste');
  await emitir.click();
  await card(page).getByText(/Pagamentos confirmados aguardando resolução/).waitFor({ state: 'detached' });
  const vouchers = await db.valePass.findMany({ where: { campaignId }, orderBy: { company: 'asc' } });
  assert.equal(vouchers.length, 2);
  assert.deepEqual(vouchers.map((v) => [v.company, v.amountCents]), [['VALLE_SHOWROOM', 50_000], ['VS_BY_CLOSET', 5_000]]);
  assert.equal(new Set(vouchers.map((v) => v.groupId)).size, 1);
  assert.equal(new Set(vouchers.map((v) => v.code)).size, 2);
  assert.equal((await db.valePassIssuanceHold.findUnique({ where: { id: hold.id } })).status, 'ISSUED');
  const audit = await db.adminAuditEvent.findFirst({ where: { entityId: hold.id } });
  assert.equal(audit.action, 'VALE_PASS_HOLD_ISSUED');
  assert.equal(audit.adminUserId, admin.id);
  pass('2b) emitir com justificativa cria exatamente 2 vouchers (R$ 500 Valle Showroom + R$ 50 VS BY CLOSET), mesmo grupo, retenção fechada e auditada');

  // 3) Os dois vouchers aparecem separados, com empresa e validade 2027; a busca pelo pedido os encontra.
  await page.reload();
  await page.getByPlaceholder('Buscar por código, nome, telefone, e-mail ou nº do pedido').fill(`${prefix}#1`);
  await page.getByText('Válido só na Valle Showroom').waitFor();
  await page.getByText('Válido só na VS BY CLOSET').waitFor();
  await page.getByText(/Válido de 01\/01\/2027/).first().waitFor();
  await page.getByText(/Válido até 31\/12\/2027/).first().waitFor();
  pass('3) os dois vouchers aparecem separados, com a empresa e a validade de 01/01/2027 a 31/12/2027');

  // 4) Perfil sem ADMIN: vê o painel, sem botões de escrita, e a API recusa (403).
  const staffCtx = await newContext(staff.token, { viewport: { width: 1280, height: 1000 } });
  const staffPage = await newPage(staffCtx, errors);
  const hold2 = await db.valePassIssuanceHold.create({ data: { shopifyOrderId: orderId, campaignId, units: 1, reason: 'CAMPAIGN_NOT_READY', status: 'OPEN', openFlag: true } });
  await staffPage.goto(vallePass);
  await card(staffPage).waitFor();
  await expand(staffPage);
  await card(staffPage).getByText(/Pagamentos confirmados aguardando resolução/).waitFor();
  assert.equal(await card(staffPage).getByRole('button', { name: /Resolver|Sugerir modelo|Emitir|Descartar/ }).count(), 0);
  const forbidden = await fetch(`${apiUrl}/admin/vale-pass/holds/${hold2.id}/issue`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiToken}`, 'X-Admin-Session': staff.token },
    body: JSON.stringify({ adminUserId: staff.id, note: 'tentativa sem perfil' }),
  });
  assert.equal(forbidden.status, 403);
  assert.equal((await db.valePassIssuanceHold.findUnique({ where: { id: hold2.id } })).status, 'OPEN');
  pass('4) sem perfil ADMIN: fila visível só para leitura e a API recusa emitir (403)');

  // 5) Celular.
  const mobile = await newContext(admin.token, { viewport: { width: 390, height: 844 } });
  const mobilePage = await newPage(mobile, errors);
  await mobilePage.goto(vallePass);
  await card(mobilePage).waitFor();
  await expand(mobilePage);
  await card(mobilePage).getByText(/Pagamentos confirmados aguardando resolução/).waitFor();
  assert.equal(await mobilePage.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth), 0);
  pass('5) celular (390px): sem rolagem lateral');

  assert.deepEqual(errors, []);
  assert.deepEqual(externalRequests, [], 'o navegador tentou acessar a internet (Shopify real?)');
  pass('6) nenhum erro no console nem acesso externo');
  console.log(`Dois vouchers do Valle Pass no navegador: ${results.length} verificações passaram.`);
} finally {
  await clean();
}
