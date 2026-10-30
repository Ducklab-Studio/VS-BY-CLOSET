import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright';

/**
 * Benefícios simbólicos da campanha de TESTE do Valle Pass no ClosetAdmin, num navegador de verdade: API e site locais isolados, banco de teste,
 * nenhuma Shopify, nenhum e-mail. Prova: o botão oficial segue igual nas outras campanhas; a opção de teste só aparece na campanha com o ID E a variante
 * exatos; a confirmação digitada é exigida; o cadastro grava só os dois vouchers (R$ 5,00 e R$ 0,50, sem o 10%); não há como cadastrar de novo; STAFF
 * não vê a opção; e a consulta de saldo avisa que o voucher é de teste.
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
if (!localTestDb && !allowedTestHost) throw new Error('Este teste exige um banco de TESTE (local ou listado em TEST_DATABASE_ALLOWED_HOSTS).');
for (const key of ['SHOPIFY_STORE_DOMAIN', 'SHOPIFY_CLIENT_ID', 'SHOPIFY_CLIENT_SECRET', 'SHOPIFY_STOREFRONT_TOKEN']) {
  if (process.env[key]) throw new Error('Integrações externas configuradas; teste abortado.');
}

// Os identificadores da campanha de teste real (iguais aos de `src/lib/valle-pass-test-benefits.ts`); aqui existem só no banco DESCARTÁVEL de teste.
const TEST_CAMPAIGN_ID = 'f6f16b3b-2ed0-4e8b-9420-e856adc1bf93';
const TEST_VARIANT = '67916371165284';

const apiUrl = 'http://127.0.0.1:3355';
const webUrl = 'http://127.0.0.1:3055';
const vallePass = `${webUrl}/closetadmin/valle-pass`;
const apiToken = randomBytes(32).toString('hex');
const prefix = `TBEN-${Date.now()}`;
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
  const user = await db.adminUser.create({ data: { name, phone: `${Date.now()}${userIds.length}7`, pinHash: 'synthetic', role, moduleAccess: ['VALLE_PASS'] } });
  userIds.push(user.id);
  const token = generateSessionToken();
  await db.adminSession.create({ data: { adminUserId: user.id, tokenHash: hashSessionToken(token), expiresAt: new Date(Date.now() + 3_600_000) } });
  return { id: user.id, token };
}
async function newContext(token, options = {}) {
  const context = await browser.newContext({ ...(process.env.TZ ? { timezoneId: process.env.TZ } : {}), ...options });
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
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message.slice(0, 60)} @ ${page.url()}`));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });
  return page;
}

const campaignIds = [];
async function clean() {
  for (const child of childProcesses) child.kill();
  await browser?.close();
  if (campaignIds.length) {
    const passes = await db.valePass.findMany({ where: { campaignId: { in: campaignIds } }, select: { id: true } });
    await db.adminAuditEvent.deleteMany({ where: { entityId: { in: [...campaignIds, ...passes.map((p) => p.id)] } } });
    await db.valePassEvent.deleteMany({ where: { valePassId: { in: passes.map((p) => p.id) } } });
    await db.valePass.deleteMany({ where: { campaignId: { in: campaignIds } } });
    await db.valePassCampaignBenefit.deleteMany({ where: { campaignId: { in: campaignIds } } });
    await db.valePassCampaign.deleteMany({ where: { id: { in: campaignIds } } });
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
const card = (page, name) => page.locator('article', { hasText: 'Variante Shopify' }).filter({ hasText: name });
const expand = async (page, name) => {
  await card(page, name).getByRole('button', { name: /Capacidade, lotes e configuração/ }).click();
  await card(page, name).getByText('Capacidade', { exact: true }).waitFor();
};

try {
  const admin = await createUser(`Admin Teste sintético ${prefix}`, 'ADMIN');
  const staff = await createUser(`Operador Teste sintético ${prefix}`, 'STAFF');

  // A campanha "parecida" (nome e preço de teste, mas OUTRO id e OUTRA variante) NÃO pode ganhar a opção de teste; a oficial recebe o botão oficial.
  const lookalike = await db.valePassCampaign.create({ data: { name: `${prefix} Teste parecida do Valle Pass`, amountCents: 10, validityDays: 30, globalLimit: 1, shopifyVariantId: `${prefix}-parecida`, voucherValidFrom: new Date('2026-01-01'), voucherValidUntil: new Date('2027-09-30') } });
  const officialLike = await db.valePassCampaign.create({ data: { name: `${prefix} Valle Pass oficial`, amountCents: 35_000, validityDays: 30, globalLimit: 1000, shopifyVariantId: `${prefix}-oficial`, voucherValidFrom: new Date('2027-04-01'), voucherValidUntil: new Date('2027-10-15') } });
  const testCampaign = await db.valePassCampaign.create({ data: { id: TEST_CAMPAIGN_ID, name: `${prefix} VALLE PASS TESTE`, amountCents: 10, validityDays: 90, globalLimit: 1, shopifyVariantId: TEST_VARIANT, voucherValidFrom: new Date('2026-10-30'), voucherValidUntil: new Date('2027-01-28') } });
  campaignIds.push(lookalike.id, officialLike.id, testCampaign.id);

  const childEnv = {
    ...process.env, DATABASE_URL: databaseUrl, ADMIN_API_TOKEN: apiToken, PICKUP_REMINDER_ENABLED: 'false',
    VALE_PASS_ORDER_SYNC_INTERVAL_MINUTES: '0', CATALOG_SYNC_INTERVAL_MINUTES: '0', SHOPIFY_CLIENT_ID: '', SHOPIFY_CLIENT_SECRET: '',
  };
  spawnLocal(process.execPath, [path.join(apiDir, 'dist/src/main.js')], apiDir, { ...childEnv, PORT: '3355', NODE_ENV: 'development' });
  spawnLocal(process.execPath, [path.join(marketingDir, 'node_modules/next/dist/bin/next'), 'start', '-p', '3055', '-H', '127.0.0.1'], marketingDir, {
    ...childEnv, NODE_ENV: 'production', RESERVATIONS_API_ADMIN_URL: apiUrl, RESERVATIONS_API_URL: apiUrl, NEXT_TELEMETRY_DISABLED: '1', __NEXT_PROCESSED_ENV: 'true',
  });
  await waitFor(`${apiUrl}/health`);
  await waitFor(`${webUrl}/closetadmin/login`);
  browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_BROWSER_CHANNEL ? { channel: process.env.PLAYWRIGHT_BROWSER_CHANNEL } : {}) });

  const errors = [];
  const context = await newContext(admin.token, { viewport: { width: 1280, height: 1300 } });
  const page = await newPage(context, errors);
  await page.goto(vallePass);

  // 1) Campanhas comuns: o botão OFICIAL continua igual e a opção de teste NÃO existe (nem na "parecida").
  for (const name of [`${prefix} Valle Pass oficial`, `${prefix} Teste parecida do Valle Pass`]) {
    await card(page, name).waitFor();
    await expand(page, name);
    await card(page, name).getByRole('button', { name: 'Sugerir modelo Valle Pass 2027' }).waitFor();
    assert.equal(await card(page, name).getByRole('button', { name: /Cadastrar benefícios de TESTE/ }).count(), 0, `${name}: a opção de teste não pode aparecer`);
  }
  pass('campanha oficial e campanha "parecida" (nome/preço de teste, outro ID/variante): botão oficial preservado e SEM opção de teste');

  // 2) Campanha de teste (ID + variante exatos): só a opção de teste; o botão oficial não aparece (não há como cadastrar R$ 500/R$ 50 nela).
  const name = `${prefix} VALLE PASS TESTE`;
  const section = card(page, name);
  await section.waitFor();
  await expand(page, name);
  assert.equal(await section.getByRole('button', { name: 'Sugerir modelo Valle Pass 2027' }).count(), 0, 'o modelo oficial não pode ser oferecido na campanha de teste');
  await section.getByRole('button', { name: 'Cadastrar benefícios de TESTE (R$ 5,00 + R$ 0,50)' }).click();
  assert.equal(await db.valePassCampaignBenefit.count({ where: { campaignId: TEST_CAMPAIGN_ID } }), 0, 'abrir a confirmação não grava nada');
  const confirmButton = section.getByRole('button', { name: 'Confirmar cadastro de teste' });
  assert.equal(await confirmButton.isDisabled(), true, 'a confirmação começa desabilitada');
  await section.getByText(/Voucher de teste, sem valor comercial/).waitFor();
  await section.getByLabel(/Digite/).fill('OFICIAL');
  assert.equal(await confirmButton.isDisabled(), true, 'palavra errada não confirma');
  await section.getByLabel(/Digite/).fill('TESTE');
  assert.equal(await confirmButton.isDisabled(), false);
  pass('campanha de teste (ID + variante exatos): só a opção de teste; o botão oficial não aparece; confirmação digitada exigida e nada é gravado ao abrir');

  // 3) Confirma: grava EXATAMENTE os dois vouchers simbólicos, sem o 10%.
  await confirmButton.click();
  await section.getByText(/TESTE — Voucher Valle Showroom \(sem valor comercial\)/).waitFor();
  await section.getByText(/TESTE — Voucher VS BY CLOSET \(sem valor comercial\)/).waitFor();
  const benefits = await db.valePassCampaignBenefit.findMany({ where: { campaignId: TEST_CAMPAIGN_ID }, orderBy: { sortOrder: 'asc' } });
  assert.deepEqual(benefits.map((b) => [b.code, b.kind, b.company, b.amountCents, b.discountPercent, b.terms]), [
    ['teste_showroom', 'VOUCHER', 'VALLE_SHOWROOM', 500, null, 'Voucher de teste, sem valor comercial'],
    ['teste_closet', 'VOUCHER', 'VS_BY_CLOSET', 50, null, 'Voucher de teste, sem valor comercial'],
  ]);
  assert.equal(await section.getByText(/exclusivo Valle Showroom/).count() > 0, true);
  assert.equal(await db.valePassCampaignBenefit.count({ where: { campaignId: { in: [lookalike.id, officialLike.id] } } }), 0, 'nenhuma outra campanha foi tocada');
  assert.equal(await db.valePassCampaignBenefit.count({ where: { campaignId: TEST_CAMPAIGN_ID, kind: 'DISCOUNT' } }), 0, 'sem o benefício de 10%');
  const audit = await db.adminAuditEvent.findMany({ where: { entityId: TEST_CAMPAIGN_ID, action: { contains: 'BENEFIT' } } });
  assert.ok(audit.length >= 1 && audit.every((e) => e.adminUserId === admin.id), 'cadastro auditado com o autor');
  pass('confirmar grava só os dois vouchers (R$ 5,00 Valle Showroom e R$ 0,50 VS BY CLOSET, condição de teste, sem 10%), sem tocar em outras campanhas, com auditoria');

  // 4) Não há como cadastrar de novo: a opção some e a recarga continua sem ela.
  assert.equal(await section.getByRole('button', { name: /Cadastrar benefícios de TESTE/ }).count(), 0);
  await page.reload();
  await expand(page, name);
  assert.equal(await card(page, name).getByRole('button', { name: /Cadastrar benefícios de TESTE/ }).count(), 0);
  assert.equal(await card(page, name).getByRole('button', { name: 'Sugerir modelo Valle Pass 2027' }).count(), 0);
  assert.equal(await db.valePassCampaignBenefit.count({ where: { campaignId: TEST_CAMPAIGN_ID } }), 2);
  pass('depois de cadastrado, nenhum botão de cadastro (teste ou oficial) reaparece, nem recarregando; os benefícios seguem 2');

  // 5) STAFF não vê a opção (e a ação exige ADMIN no servidor).
  await db.valePassCampaignBenefit.deleteMany({ where: { campaignId: TEST_CAMPAIGN_ID } }); // volta ao estado "sem benefícios" só para o STAFF olhar a mesma campanha
  const staffCtx = await newContext(staff.token, { viewport: { width: 1280, height: 1300 } });
  const staffPage = await newPage(staffCtx, errors);
  await staffPage.goto(vallePass);
  await card(staffPage, name).waitFor();
  await expand(staffPage, name);
  assert.equal(await card(staffPage, name).getByRole('button', { name: /Cadastrar benefícios de TESTE/ }).count(), 0, 'STAFF não vê a opção');
  assert.equal(await db.valePassCampaignBenefit.count({ where: { campaignId: TEST_CAMPAIGN_ID } }), 0, 'STAFF não gravou nada');
  pass('STAFF não vê a opção de cadastro e nada é gravado');

  // 6) Voucher de teste na consulta de saldo: aviso vermelho "sem valor comercial".
  const [b1, b2] = await Promise.all([
    db.valePassCampaignBenefit.create({ data: { campaignId: TEST_CAMPAIGN_ID, code: 'teste_showroom', kind: 'VOUCHER', company: 'VALLE_SHOWROOM', label: 'TESTE — Voucher Valle Showroom (sem valor comercial)', amountCents: 500, sortOrder: 0 } }),
    db.valePassCampaignBenefit.create({ data: { campaignId: TEST_CAMPAIGN_ID, code: 'teste_closet', kind: 'VOUCHER', company: 'VS_BY_CLOSET', label: 'TESTE — Voucher VS BY CLOSET (sem valor comercial)', amountCents: 50, sortOrder: 1 } }),
  ]);
  const orderId = `${prefix}-order`;
  const groupId = randomUUID();
  const suffix = Date.now().toString(36).toUpperCase().slice(-3);
  const common = { campaignId: TEST_CAMPAIGN_ID, groupId, shopifyOrderId: orderId, shopifyOrderName: '#T-TESTE', status: 'ACTIVE', purchasedAt: new Date(), expiresAt: new Date('2027-01-29T03:00:00Z'), validFrom: new Date('2026-10-30T03:00:00Z'), customerName: 'Cliente Sintético Teste', customerPhone: '+5500000000000', customerEmail: 'cliente.teste@exemplo.invalid' };
  const code = `VALLE-T${suffix}-AAAA`;
  await db.valePass.create({ data: { ...common, code, amountCents: 500, balanceCents: 500, company: 'VALLE_SHOWROOM', benefitId: b1.id } });
  await db.valePass.create({ data: { ...common, code: `VALLE-T${suffix}-BBBB`, amountCents: 50, balanceCents: 50, company: 'VS_BY_CLOSET', benefitId: b2.id } });
  await page.goto(vallePass);
  await page.getByLabel('Código do voucher').fill(code);
  await page.getByRole('button', { name: 'Consultar' }).click();
  const warning = page.getByTestId('test-voucher-warning');
  await warning.waitFor();
  assert.match(await warning.innerText(), /VOUCHER DE TESTE — sem valor comercial/);
  pass('consulta de saldo de um voucher de teste mostra o aviso vermelho "sem valor comercial"');

  // 7) Um voucher OFICIAL não mostra o aviso.
  const officialBenefit = await db.valePassCampaignBenefit.create({ data: { campaignId: officialLike.id, code: 'valle_showroom_500', kind: 'VOUCHER', company: 'VALLE_SHOWROOM', label: 'Voucher Valle Showroom', amountCents: 50_000, sortOrder: 0 } });
  const officialCode = `VALLE-O${suffix}-AAAA`;
  await db.valePass.create({ data: { campaignId: officialLike.id, groupId: randomUUID(), shopifyOrderId: `${prefix}-oficial-order`, shopifyOrderName: '#T-OFICIAL', status: 'ACTIVE', purchasedAt: new Date(), expiresAt: new Date('2027-10-16T03:00:00Z'), validFrom: new Date('2027-04-01T03:00:00Z'), customerName: 'Cliente Sintético', code: officialCode, amountCents: 50_000, balanceCents: 50_000, company: 'VALLE_SHOWROOM', benefitId: officialBenefit.id } });
  await page.getByLabel('Código do voucher').fill(officialCode);
  await page.getByRole('button', { name: 'Consultar' }).click();
  await page.getByText('Benefício: Voucher Valle Showroom').waitFor();
  assert.equal(await page.getByTestId('test-voucher-warning').count(), 0);
  pass('voucher OFICIAL na consulta de saldo não mostra o aviso de teste');

  const relevant = errors.filter((e) => !/Failed to load resource/.test(e));
  assert.deepEqual(relevant, [], `erros no navegador: ${relevant.join(' | ')}`);
  assert.deepEqual(externalRequests, [], `requisições externas: ${externalRequests.join(', ')}`);
  pass('nenhum erro de console/página e nenhuma requisição externa');
  console.log(`\nBenefícios de teste no navegador: ${results.length} verificações passaram.`);
} finally {
  await clean();
}
