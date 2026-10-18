import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright';

/**
 * Reembolsos em revisão do Valle Pass no ClosetAdmin, num navegador de verdade: API e site locais isolados, banco de teste, nenhuma Shopify, nenhum e-mail.
 * As revisões e os vouchers de apoio são gravados direto no banco de teste (nada é emitido nem reembolsado de verdade).
 * Cobre: visualização, validação, erro vindo da API, decisão feliz, aviso de "0 vouchers cancelados", permissão (STAFF), responsividade e tema escuro.
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
if (!localTestDb && !allowedTestHost) throw new Error('O teste de reembolsos exige um banco de TESTE (local ou listado em TEST_DATABASE_ALLOWED_HOSTS).');
for (const key of ['SHOPIFY_STORE_DOMAIN', 'SHOPIFY_CLIENT_ID', 'SHOPIFY_CLIENT_SECRET', 'SHOPIFY_STOREFRONT_TOKEN']) {
  if (process.env[key]) throw new Error('Integrações externas configuradas; teste abortado.');
}

const apiUrl = 'http://127.0.0.1:3356';
const webUrl = 'http://127.0.0.1:3056';
const apiToken = randomBytes(32).toString('hex');
const prefix = `RFB-${Date.now()}`;
const db = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
const children = [];
const userIds = [];
const orderIds = [];
const externalRequests = [];
const errors = [];
let browser;
let campaignId;

const spawnLocal = (cmd, args, cwd, env) => children.push(spawn(cmd, args, { cwd, env, stdio: 'ignore', windowsHide: true }));
async function waitFor(url) {
  for (let i = 0; i < 120; i++) {
    try { if ((await fetch(url, { signal: AbortSignal.timeout(1000) })).ok) return; } catch { /* ainda subindo */ }
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
async function newPage(token, options = {}) {
  const context = await browser.newContext(options);
  await context.route('**/*', (route) => {
    const hostname = new URL(route.request().url()).hostname;
    if (['localhost', '127.0.0.1'].includes(hostname)) return route.continue();
    externalRequests.push(hostname);
    return route.abort();
  });
  await context.addCookies([{ name: 'closetadmin_session', value: token, url: webUrl, httpOnly: true, sameSite: 'Lax' }]);
  const page = await context.newPage();
  page.setDefaultTimeout(30_000);
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(`console: ${m.text()}`); });
  return page;
}

/** Pedido com 1 unidade (2 vouchers) e uma revisão NEEDS_REVIEW propondo essa unidade. `statuses` = situação dos dois vouchers. */
async function seedReview(label, statuses, reasons = ['UNIT_CONFIRMATION_REQUIRED'], proposeUnit = true, quantity = 1) {
  const orderId = `${prefix}-${label}`;
  orderIds.push(orderId);
  await db.valePassOrder.create({ data: { shopifyOrderId: orderId, shopifyOrderGid: `gid://shopify/Order/${orderId}`, shopifyOrderName: `#${label}`, status: 'CONFIRMED', financialStatus: 'paid', quantity, customerName: 'Cliente', customerEmail: 'c@exemplo.invalid', customerPhone: '+5500000000000', lastSyncSource: 'teste', orderCreatedAt: new Date(), statusChangedAt: new Date(), vouchersProcessedAt: new Date() } });
  const groupId = (await db.$queryRaw`SELECT gen_random_uuid()::text AS g`)[0].g;
  const benefits = await db.valePassCampaignBenefit.findMany({ where: { campaignId } });
  const companies = ['VALLE_SHOWROOM', 'VS_BY_CLOSET'];
  for (let i = 0; i < 2; i++) {
    await db.valePass.create({ data: { benefitId: benefits.find((b) => b.company === companies[i]).id, code: `${prefix}-${label}-${i}`, campaignId, amountCents: 5000, status: statuses[i], purchasedAt: new Date(), expiresAt: new Date(Date.now() + 86_400_000), shopifyOrderId: orderId, groupId, company: companies[i], usedAt: statuses[i] === 'USED' ? new Date() : null } });
  }
  return db.valePassRefundApplication.create({ data: { shopifyRefundId: `${prefix}-r-${label}`, shopifyOrderId: orderId, campaignId, classification: 'UNITS', refundedUnits: 1, status: 'NEEDS_REVIEW', reviewReasons: reasons, detail: { reviewGroupIds: proposeUnit ? [groupId] : [], unitsNeedingReview: 1, paidUnits: quantity, unissuedProposed: 0 } } });
}

async function clean() {
  for (const child of children) child.kill();
  await browser?.close();
  await db.adminPresence.deleteMany({ where: { adminUserId: { in: userIds } } }).catch(() => undefined);
  await db.$transaction(async (tx) => {
    await tx.$executeRawUnsafe('SET LOCAL session_replication_role = replica'); // a trilha de reembolsos não é apagável pelo app; só este teste descartável a limpa
    const vouchers = await tx.valePass.findMany({ where: { campaignId }, select: { id: true } });
    const applications = await tx.valePassRefundApplication.findMany({ where: { shopifyOrderId: { in: orderIds } }, select: { id: true } });
    await tx.adminAuditEvent.deleteMany({ where: { OR: [{ entityId: { in: [campaignId, ...applications.map((a) => a.id), ...vouchers.map((v) => v.id)].filter(Boolean) } }, { adminUserId: { in: userIds } }] } });
    await tx.valePassIssuanceHold.deleteMany({ where: { campaignId } });
    await tx.valePassRefundApplication.deleteMany({ where: { shopifyOrderId: { in: orderIds } } });
    await tx.valePassEvent.deleteMany({ where: { valePassId: { in: vouchers.map((v) => v.id) } } });
    await tx.valePass.deleteMany({ where: { campaignId } });
    await tx.valePassOrder.deleteMany({ where: { shopifyOrderId: { in: orderIds } } });
    await tx.valePassCampaignBenefit.deleteMany({ where: { campaignId } });
    await tx.valePassCampaign.deleteMany({ where: { id: campaignId } });
    await tx.adminSession.deleteMany({ where: { adminUserId: { in: userIds } } });
    await tx.adminUser.deleteMany({ where: { id: { in: userIds } } });
  }).catch((e) => console.log('limpeza parcial:', String(e.message).slice(0, 160)));
  await db.$disconnect();
}

const results = [];
const pass = (name) => { results.push(name); console.log(`  ✓ ${name}`); };
const card = (page) => page.locator('article', { hasText: 'Variante Shopify' }).filter({ hasText: `${prefix} Valle Pass` });
const expand = async (page) => {
  await card(page).getByRole('button', { name: /Capacidade, lotes e configuração/ }).click();
  await card(page).getByText('Capacidade', { exact: true }).waitFor();
};
const panel = (page) => page.getByLabel('Reembolsos em revisão');
const statusesOf = async (label) => (await db.valePass.findMany({ where: { shopifyOrderId: `${prefix}-${label}` } })).map((v) => v.status).sort();

try {
  const admin = await createUser(`Admin RFB sintético ${prefix}`, 'ADMIN');
  const staff = await createUser(`Operador RFB sintético ${prefix}`, 'STAFF');
  const campaign = await db.valePassCampaign.create({ data: { name: `${prefix} Valle Pass`, amountCents: 35_000, validityDays: 30, shopifyVariantId: `${prefix}-variant`, globalLimit: 1000, voucherValidFrom: new Date('2027-01-01'), voucherValidUntil: new Date('2027-12-31') } });
  campaignId = campaign.id;
  await db.valePassCampaignBenefit.createMany({ data: [
    { campaignId, code: 'valle_showroom_500', kind: 'VOUCHER', company: 'VALLE_SHOWROOM', label: 'Voucher Valle', amountCents: 50_000, sortOrder: 0 },
    { campaignId, code: 'vs_by_closet_50', kind: 'VOUCHER', company: 'VS_BY_CLOSET', label: 'Voucher VS', amountCents: 5_000, sortOrder: 1 },
  ] });
  const first = await seedReview('1001', ['ACTIVE', 'ACTIVE']);

  const childEnv = {
    ...process.env, DATABASE_URL: databaseUrl, ADMIN_API_TOKEN: apiToken, PICKUP_REMINDER_ENABLED: 'false',
    VALE_PASS_ORDER_SYNC_INTERVAL_MINUTES: '0', CATALOG_SYNC_INTERVAL_MINUTES: '0', SHOPIFY_CLIENT_ID: '', SHOPIFY_CLIENT_SECRET: '',
  };
  spawnLocal(process.execPath, [path.join(apiDir, 'dist/src/main.js')], apiDir, { ...childEnv, PORT: '3356', NODE_ENV: 'development' });
  spawnLocal(process.execPath, [path.join(marketingDir, 'node_modules/next/dist/bin/next'), 'start', '-p', '3056', '-H', '127.0.0.1'], marketingDir, {
    ...childEnv, NODE_ENV: 'production', RESERVATIONS_API_ADMIN_URL: apiUrl, RESERVATIONS_API_URL: apiUrl, NEXT_TELEMETRY_DISABLED: '1', __NEXT_PROCESSED_ENV: 'true',
  });
  await waitFor(`${apiUrl}/health`);
  await waitFor(`${webUrl}/closetadmin/login`);
  browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_BROWSER_CHANNEL ? { channel: process.env.PLAYWRIGHT_BROWSER_CHANNEL } : {}) });

  // 1) ADMIN vê o alerta crítico e o painel (motivo em português, avisando que o resgate está bloqueado)
  const page = await newPage(admin.token, { viewport: { width: 1280, height: 1000 } });
  await page.goto(`${webUrl}/closetadmin/valle-pass`);
  await card(page).waitFor();
  await expand(page);
  await page.getByText('Reembolsos aguardando decisão (1)').waitFor();
  await panel(page).getByText('#1001').waitFor();
  await panel(page).getByText(/vouchers propostos estão bloqueados para resgate/).waitFor();
  await page.getByText(/reembolso\(s\) aguardam decisão de um administrador/).waitFor();
  pass('1) ADMIN vê o alerta crítico e o painel com pedido, unidades e motivo (resgate bloqueado) em português');

  // 2) Justificativa curta é recusada; nada muda
  await page.getByRole('button', { name: 'Decidir' }).click();
  await page.getByRole('button', { name: 'Manter vouchers' }).click();
  await page.getByRole('alert').filter({ hasText: /mínimo de 10 caracteres/ }).waitFor();
  assert.equal((await db.valePassRefundApplication.findUnique({ where: { id: first.id } })).status, 'NEEDS_REVIEW');
  pass('2) justificativa vazia/curta é recusada com mensagem e nada muda no banco');

  // 3) Erro da API: a revisão foi resolvida por outra pessoa com esta tela aberta
  await db.$executeRawUnsafe(`UPDATE vale_pass_refund_applications SET status='RESOLVED', resolution='KEEP_VOUCHERS', resolved_at=now(), resolved_by='${admin.id}', resolution_note='resolvida por outra aba de teste' WHERE id='${first.id}'`);
  await page.getByPlaceholder(/Justificativa/).fill('Decisão tomada nesta aba desatualizada');
  await page.getByRole('button', { name: 'Cancelar ativos' }).click();
  await page.getByRole('alert').filter({ hasText: /já foi resolvida/ }).waitFor();
  assert.deepEqual(await statusesOf('1001'), ['ACTIVE', 'ACTIVE']);
  pass('3) revisão já resolvida por outra pessoa: erro da API exibido e nenhum voucher alterado');

  // 4) Decisão feliz: cancela só o voucher ATIVO; o usado permanece
  const second = await seedReview('1002', ['USED', 'ACTIVE'], ['USED_VOUCHERS']);
  await page.reload();
  await expand(page);
  await panel(page).getByText(/voucher já usado em unidade reembolsada/).waitFor();
  await page.getByRole('button', { name: 'Decidir' }).click();
  await page.getByPlaceholder(/Justificativa/).fill('Reembolso conferido na Shopify, cancelar o ativo');
  await page.getByRole('button', { name: 'Cancelar ativos' }).click();
  await panel(page).waitFor({ state: 'detached' });
  assert.deepEqual(await statusesOf('1002'), ['CANCELLED', 'USED']);
  const row = await db.valePassRefundApplication.findUnique({ where: { id: second.id } });
  assert.equal(row.status, 'RESOLVED');
  assert.equal(row.resolvedBy, admin.id);
  assert.ok(await db.adminAuditEvent.findFirst({ where: { entityId: second.id, action: 'VALE_PASS_REFUND_REVIEW_RESOLVED', adminUserId: admin.id } }));
  pass('4) "Cancelar ativos": só o voucher ativo é cancelado, o usado permanece, decisão e auditoria gravadas');

  // 5) F5: nenhuma unidade com voucher ativo → decisão registrada, aviso explícito de 0 cancelados e de possível providência operacional
  const third = await seedReview('1003', ['USED', 'USED'], ['USED_VOUCHERS']);
  await page.reload();
  await expand(page);
  await page.getByRole('button', { name: 'Decidir' }).click();
  await page.getByPlaceholder(/Justificativa/).fill('Tudo já foi usado, registrar a decisão');
  await page.getByRole('button', { name: 'Cancelar ativos' }).click();
  const notice = page.getByRole('status').filter({ hasText: /NENHUM voucher foi cancelado/ });
  await notice.waitFor();
  await notice.getByText(/não significa que o reembolso esteja resolvido/).waitFor();
  assert.deepEqual(await statusesOf('1003'), ['USED', 'USED']);
  assert.equal((await db.valePassRefundApplication.findUnique({ where: { id: third.id } })).status, 'RESOLVED');
  await notice.getByRole('button', { name: 'Entendi' }).click();
  await panel(page).waitFor({ state: 'detached' });
  pass('5) decisão que cancela 0 vouchers: aviso explícito de providência operacional, sem indicar conclusão financeira, e só some após "Entendi"');

  // 6) STAFF vê o painel sem botões de decisão
  await seedReview('1004', ['ACTIVE', 'ACTIVE']);
  const staffPage = await newPage(staff.token, { viewport: { width: 1280, height: 1000 } });
  await staffPage.goto(`${webUrl}/closetadmin/valle-pass`);
  await card(staffPage).waitFor();
  await expand(staffPage);
  await staffPage.getByText('Reembolsos aguardando decisão (1)').waitFor();
  assert.equal(await staffPage.getByRole('button', { name: 'Decidir' }).count(), 0);
  pass('6) STAFF vê o painel, mas sem botão de decisão (a API também exige ADMIN, coberto nos testes de serviço)');

  // 7) 375px e tema escuro
  const mobile = await newPage(admin.token, { viewport: { width: 375, height: 800 }, colorScheme: 'dark' });
  await mobile.goto(`${webUrl}/closetadmin/valle-pass`);
  await card(mobile).waitFor();
  await expand(mobile);
  await mobile.getByText('Reembolsos aguardando decisão (1)').waitFor();
  await mobile.getByRole('button', { name: 'Decidir' }).click();
  const overflow = await mobile.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  assert.ok(overflow <= 1, `rolagem horizontal de ${overflow}px`);
  const box = await mobile.getByRole('button', { name: 'Cancelar ativos' }).boundingBox();
  assert.ok(box && box.x >= 0 && box.x + box.width <= 376, 'botão fora da tela');
  pass('7) 375px com tema escuro: sem rolagem horizontal e botões dentro da tela');

  // 8) Revisão SEM unidade identificada: o painel avisa que o resgate do pedido todo está bloqueado
  const order = await seedReview('1005', ['ACTIVE', 'ACTIVE'], ['AMOUNT_ONLY_REFUND'], false);
  await page.reload();
  await expand(page);
  await panel(page).getByText('#1005').waitFor();
  await panel(page).getByText(/resgate de TODOS os vouchers deste pedido está bloqueado/).waitFor();
  assert.ok(order.id);
  pass('8) revisão sem unidade identificada: o painel explica que o resgate de todos os vouchers do pedido está bloqueado');

  // 9) Pendências após reembolso parcial: pagas / emitidas / devolvidas antes de emitir / ainda elegíveis, sem dados pessoais
  await seedReview('1006', ['ACTIVE', 'ACTIVE'], ['UNIT_CONFIRMATION_REQUIRED'], true, 3);
  await db.valePassRefundApplication.create({ data: { shopifyRefundId: `${prefix}-r-abs`, shopifyOrderId: `${prefix}-1006`, campaignId, classification: 'UNITS', refundedUnits: 1, status: 'APPLIED', detail: { unissuedAbsorbed: 1, reviewGroupIds: [], paidUnits: 3 } } });
  await page.reload();
  await expand(page);
  const shortfall = page.getByLabel('Pedidos pagos sem todos os passes');
  await shortfall.getByText(/#1006: pagas 3 · emitidas 1 · devolvidas antes de emitir 1/).waitFor();
  await shortfall.getByText('ainda elegíveis 1').waitFor();
  await shortfall.getByText(/não é automática/).waitFor();
  const shortfallText = await shortfall.innerText();
  assert.ok(!/@|\+55|Cliente/.test(shortfallText), 'dados pessoais na lista de pendências');
  pass('9) pendências após reembolso parcial: pagas, emitidas, devolvidas antes de emitir e elegíveis, sem dados pessoais e com aviso de emissão por ADMIN');

  // 10) PR F: pagamento retido porque a integração dos dois vouchers estava DESLIGADA — alerta crítico, motivo em português e "Retomar retenções".
  // O servidor deste teste roda com a chave desligada (padrão): retomar é recusado com explicação e NADA é emitido.
  const heldOrderId = `${prefix}-9001`;
  orderIds.push(heldOrderId);
  await db.valePassOrder.create({ data: { shopifyOrderId: heldOrderId, shopifyOrderGid: `gid://shopify/Order/${heldOrderId}`, shopifyOrderName: '#9001', status: 'CONFIRMED', financialStatus: 'paid', quantity: 2, customerName: 'Cliente', customerEmail: 'c@exemplo.invalid', customerPhone: '+5500000000000', lastSyncSource: 'teste', orderCreatedAt: new Date(), statusChangedAt: new Date(), vouchersProcessedAt: new Date() } });
  const heldHold = await db.valePassIssuanceHold.create({ data: { shopifyOrderId: heldOrderId, campaignId, units: 2, reason: 'FINANCIAL_MISMATCH', status: 'OPEN', openFlag: true, detail: { issues: [{ code: 'INTEGRATION_DISABLED' }] } } });
  await page.reload();
  await expand(page);
  await page.getByText(/integração dos dois vouchers DESLIGADA/).waitFor();
  await page.getByText(/o pagamento chegou com a integração dos dois vouchers desligada/).first().waitFor();
  const resume = page.getByRole('group', { name: 'Retomada das retenções' });
  await resume.getByRole('button', { name: 'Retomar retenções' }).click();
  await resume.getByPlaceholder(/Justificativa/).fill('Tentativa de retomada com a integração ainda desligada');
  await resume.getByRole('button', { name: 'Retomar agora' }).click();
  await resume.getByRole('alert').waitFor();
  assert.match(await resume.getByRole('alert').innerText(), /desligada|ligue/i);
  assert.equal(await db.valePass.count({ where: { shopifyOrderId: heldOrderId } }), 0);
  assert.equal((await db.valePassIssuanceHold.findUnique({ where: { id: heldHold.id } })).status, 'OPEN');
  pass('11) pagamento retido com a integração desligada: alerta crítico, motivo claro e "Retomar retenções" recusado com explicação; nenhum voucher e a retenção segue aberta');

  assert.deepEqual(externalRequests, [], 'houve requisição externa');
  assert.deepEqual(errors, []);
  pass('12) nenhuma requisição externa e nenhum erro de console/página');
  console.log(`\n${results.length} verificações do navegador passaram.`);
} catch (error) {
  console.error('FALHOU:', error.message);
  process.exitCode = 1;
} finally {
  await clean();
}
