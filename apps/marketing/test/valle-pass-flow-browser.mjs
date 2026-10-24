import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright';

/**
 * Integração financeira do Valle Pass no ClosetAdmin, num navegador de verdade: estado das DUAS chaves, retidos × unidades sem tratamento × e-mails
 * aguardando envio, regularização de pedido pago (só ADMIN, justificativa) e instante do pagamento nas retenções.
 *
 * API e site locais isolados contra um banco de TESTE (local ou listado em TEST_DATABASE_ALLOWED_HOSTS), nenhuma Shopify, NENHUM e-mail (envio desligado).
 * A segunda instância descartável da API liga a chave APENAS neste processo local de teste (para exercitar a regularização); nada em produção muda.
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
if (!localTestDb && !allowedTestHost) throw new Error('O teste da integração financeira exige um banco de TESTE (local ou listado em TEST_DATABASE_ALLOWED_HOSTS).');
for (const key of ['SHOPIFY_STORE_DOMAIN', 'SHOPIFY_CLIENT_ID', 'SHOPIFY_CLIENT_SECRET', 'SHOPIFY_STOREFRONT_TOKEN', 'RESEND_API_KEY', 'VALE_PASS_EMAIL_MODE', 'VALE_PASS_TWO_VOUCHER_FLOW', 'VALE_PASS_UNIT_REFUNDS']) {
  if (process.env[key]) throw new Error('Integrações externas, envio de e-mail ou chaves financeiras configurados no ambiente; teste abortado.');
}

const API_OFF = 'http://127.0.0.1:3356';
const WEB_OFF = 'http://127.0.0.1:3056';
const API_ON = 'http://127.0.0.1:3357';
const WEB_ON = 'http://127.0.0.1:3057';
const apiToken = randomBytes(32).toString('hex');
const prefix = `FLOWUI-${Date.now()}`;
const db = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
const childProcesses = [];
const userIds = [];
const orderIds = [];
let campaignId = null;
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
async function newContext(token, webUrl, options = {}) {
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
  page.on('console', (m) => { if (m.type() === 'error' && !/status of (409|403)/.test(m.text())) errors.push(`console: ${m.text()}`); });
  return page;
}

async function clean() {
  for (const child of childProcesses) child.kill();
  await browser?.close();
  await db.$transaction(async (tx) => {
    await tx.$executeRawUnsafe('SET LOCAL session_replication_role = replica'); // linhas do tempo são append-only; só este teste descartável as limpa
    if (campaignId) {
      await tx.valePassEmailEvent.deleteMany({ where: { outbox: { campaignId } } });
      await tx.valePassEmailOutbox.deleteMany({ where: { campaignId } });
      const passes = await tx.valePass.findMany({ where: { campaignId }, select: { id: true } });
      const holds = await tx.valePassIssuanceHold.findMany({ where: { campaignId }, select: { id: true } });
      await tx.adminAuditEvent.deleteMany({ where: { OR: [{ entityId: { in: holds.map((h) => h.id) } }, { entityType: 'ValePassOrder' }] } });
      await tx.valePassEvent.deleteMany({ where: { valePassId: { in: passes.map((p) => p.id) } } });
      await tx.valePass.deleteMany({ where: { campaignId } });
      await tx.valePassIssuanceHold.deleteMany({ where: { campaignId } });
      await tx.valePassCampaignBenefit.deleteMany({ where: { campaignId } });
      await tx.valePassCampaign.deleteMany({ where: { id: campaignId } });
    }
    const regs = await tx.valePassOrder.findMany({ where: { shopifyOrderId: { in: orderIds } }, select: { id: true } });
    await tx.valePassOrderEvent.deleteMany({ where: { valePassOrderId: { in: regs.map((r) => r.id) } } });
    await tx.valePassOrder.deleteMany({ where: { shopifyOrderId: { in: orderIds } } });
    await tx.webhookEvent.deleteMany({ where: { storeId: `${prefix}-store` } });
    await tx.store.deleteMany({ where: { id: `${prefix}-store` } });
    if (userIds.length) {
      await tx.adminAuditEvent.deleteMany({ where: { adminUserId: { in: userIds } } });
      await tx.adminSession.deleteMany({ where: { adminUserId: { in: userIds } } });
      await tx.adminUser.deleteMany({ where: { id: { in: userIds } } });
    }
  });
  await db.adminPresence.deleteMany({ where: { adminUserId: { in: userIds } } }).catch(() => undefined);
  await db.$disconnect();
}

const results = [];
const pass = (name) => { results.push(name); console.log(`  ✓ ${name}`); };
const HOUR = 3_600_000;
const money = (amount) => ({ shop_money: { amount, currency_code: 'BRL' }, presentment_money: { amount, currency_code: 'BRL' } });

try {
  const admin = await createUser(`Admin Fluxo sintético ${prefix}`, 'ADMIN');
  const staff = await createUser(`Operador Fluxo sintético ${prefix}`, 'STAFF');

  const variant = String(910_000_000_000 + (Date.now() % 1_000_000));
  const campaign = await db.valePassCampaign.create({
    data: { name: `${prefix} Valle Pass`, amountCents: 35_000, validityDays: 30, globalLimit: 1_000, shopifyVariantId: variant, voucherValidFrom: new Date('2027-01-01T00:00:00Z'), voucherValidUntil: new Date('2027-12-31T00:00:00Z') },
  });
  campaignId = campaign.id;
  const [showroom, closet] = await Promise.all([
    db.valePassCampaignBenefit.create({ data: { campaignId, code: 'valle_showroom_500', kind: 'VOUCHER', company: 'VALLE_SHOWROOM', label: 'Voucher Valle Showroom', amountCents: 50_000, sortOrder: 0 } }),
    db.valePassCampaignBenefit.create({ data: { campaignId, code: 'vs_by_closet_50', kind: 'VOUCHER', company: 'VS_BY_CLOSET', label: 'Voucher VS BY CLOSET', amountCents: 5_000, sortOrder: 1 } }),
  ]);
  await db.store.create({ data: { id: `${prefix}-store`, shopifyDomain: `${prefix.toLowerCase()}.invalid`, currency: 'BRL' } });

  async function order(n, { quantity, paidHoursAgo, status = 'CONFIRMED' }) {
    const shopifyOrderId = `${prefix}-o${n}`;
    orderIds.push(shopifyOrderId);
    await db.valePassOrder.create({
      data: {
        shopifyOrderId, shopifyOrderGid: `gid://shopify/Order/${shopifyOrderId}`, shopifyOrderName: `${prefix}#${n}`, status, financialStatus: 'paid', quantity,
        customerName: 'Cliente Sintético', customerEmail: `cliente${n}@exemplo.invalid`, customerPhone: '+5500000000000', lastSyncSource: 'teste',
        orderCreatedAt: new Date(Date.now() - (paidHoursAgo ?? 1) * HOUR - 60_000), vouchersProcessedAt: new Date(),
        ...(paidHoursAgo == null ? {} : { paymentConfirmedAt: new Date(Date.now() - paidHoursAgo * HOUR) }),
      },
    });
    return shopifyOrderId;
  }
  async function vouchers(orderId, n) {
    const groupId = randomUUID();
    const codes = [];
    for (const [benefit, company, amount] of [[showroom, 'VALLE_SHOWROOM', 50_000], [closet, 'VS_BY_CLOSET', 5_000]]) {
      const code = `VALLE-FL${n}-${company === 'VS_BY_CLOSET' ? 'B' : 'A'}${String(Date.now()).slice(-5)}`;
      codes.push(code);
      await db.valePass.create({ data: { code, campaignId, amountCents: amount, status: 'ACTIVE', purchasedAt: new Date(), expiresAt: new Date('2028-01-01T03:00:00Z'), validFrom: new Date('2027-01-01T03:00:00Z'), company, groupId, benefitId: benefit.id, shopifyOrderId: orderId } });
    }
    return { groupId, codes };
  }
  async function hold(orderId, units, code, createdAgoMs = 0) {
    return db.valePassIssuanceHold.create({
      data: { shopifyOrderId: orderId, campaignId, units, reason: 'FINANCIAL_MISMATCH', status: 'OPEN', openFlag: true, detail: { issues: [{ code }] }, createdAt: new Date(Date.now() - createdAgoMs) },
    });
  }
  async function queuedEmail(orderId, groupId, status, n) {
    const id = randomUUID();
    await db.valePassEmailOutbox.create({
      data: { id, shopifyOrderId: orderId, campaignId, groupId, kind: 'INITIAL', dedupeKey: `initial:${groupId}`, toEmail: `cliente${n}@exemplo.invalid`, status, attempts: 0, idempotencyKey: `vpe-${id}`, deadlineAt: new Date(Date.now() + 70 * HOUR) },
    });
  }

  // o1: retido com a integração desligada (instante do pagamento conhecido, 5 h atrás)
  const o1 = await order(1, { quantity: 1, paidHoursAgo: 5 });
  await hold(o1, 1, 'INTEGRATION_DISABLED');
  // o2: retido sem o instante real do pagamento
  const o2 = await order(2, { quantity: 1, paidHoursAgo: null });
  await hold(o2, 1, 'PAYMENT_TIME_UNKNOWN');
  // o3: a compra cresceu (3 pagas, 1 unidade emitida): retenção das 2 extras
  const o3 = await order(3, { quantity: 3, paidHoursAgo: 8 });
  const g3 = await vouchers(o3, 3);
  await hold(o3, 2, 'QUANTITY_INCREASED');
  // o4: pago, 2 unidades, SEM voucher e SEM retenção (variante antes sem campanha) — com o último evento da Shopify guardado
  const o4 = await order(4, { quantity: 2, paidHoursAgo: 3 });
  const payload4 = {
    id: o4, admin_graphql_api_id: `gid://shopify/Order/${o4}`, name: `${prefix}#4`, financial_status: 'paid', cancelled_at: null, currency: 'BRL', presentment_currency: 'BRL',
    created_at: new Date(Date.now() - 3 * HOUR - 60_000).toISOString(), updated_at: new Date(Date.now() - 3 * HOUR).toISOString(),
    current_total_price: '700.00', total_outstanding: '0.00', total_discounts: '0.00', discount_codes: [], refunds: [], total_shipping_price_set: money('0.00'),
    email: 'cliente4@exemplo.invalid', customer: { first_name: 'Cliente', last_name: 'Sintético', email: 'cliente4@exemplo.invalid' },
    line_items: [{ variant_id: Number(variant), product_id: null, quantity: 2, current_quantity: 2, price: '350.00', price_set: money('350.00'), discount_allocations: [] }],
  };
  await db.webhookEvent.create({ data: { shopifyWebhookId: `${prefix}-wh4`, storeId: `${prefix}-store`, topic: 'orders/paid', payload: payload4, status: 'processed', orderId: o4 } });
  // e-mails: 1 aguardando envio (o3), 1 precisando de atenção
  await queuedEmail(o3, g3.groupId, 'QUEUED', 3);
  const o5 = await order(5, { quantity: 1, paidHoursAgo: 2 });
  const g5 = await vouchers(o5, 5);
  await queuedEmail(o5, g5.groupId, 'NEEDS_ATTENTION', 5);

  const childEnv = {
    ...process.env, DATABASE_URL: databaseUrl, ADMIN_API_TOKEN: apiToken, PICKUP_REMINDER_ENABLED: 'false',
    VALE_PASS_ORDER_SYNC_INTERVAL_MINUTES: '0', CATALOG_SYNC_INTERVAL_MINUTES: '0', SHOPIFY_CLIENT_ID: '', SHOPIFY_CLIENT_SECRET: '',
  };
  const webEnv = (api) => ({ ...childEnv, NODE_ENV: 'production', RESERVATIONS_API_ADMIN_URL: api, RESERVATIONS_API_URL: api, NEXT_TELEMETRY_DISABLED: '1', __NEXT_PROCESSED_ENV: 'true' });
  // instância 1: chaves DESLIGADAS (padrão de produção); instância 2: TWO_VOUCHER ligada só neste processo de teste local
  spawnLocal(process.execPath, [path.join(apiDir, 'dist/src/main.js')], apiDir, { ...childEnv, PORT: '3356', NODE_ENV: 'development' });
  spawnLocal(process.execPath, [path.join(apiDir, 'dist/src/main.js')], apiDir, { ...childEnv, PORT: '3357', NODE_ENV: 'development', VALE_PASS_TWO_VOUCHER_FLOW: 'on' });
  spawnLocal(process.execPath, [path.join(marketingDir, 'node_modules/next/dist/bin/next'), 'start', '-p', '3056', '-H', '127.0.0.1'], marketingDir, webEnv(API_OFF));
  spawnLocal(process.execPath, [path.join(marketingDir, 'node_modules/next/dist/bin/next'), 'start', '-p', '3057', '-H', '127.0.0.1'], marketingDir, webEnv(API_ON));
  await waitFor(`${API_OFF}/health`);
  await waitFor(`${API_ON}/health`);
  await waitFor(`${WEB_OFF}/closetadmin/login`);
  await waitFor(`${WEB_ON}/closetadmin/login`);
  browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_BROWSER_CHANNEL ? { channel: process.env.PLAYWRIGHT_BROWSER_CHANNEL } : {}) });

  const errors = [];
  const context = await newContext(admin.token, WEB_OFF, { viewport: { width: 1280, height: 1400 } });
  const page = await newPage(context, errors);
  const panel = () => page.getByLabel('Integração financeira');
  await page.goto(`${WEB_OFF}/closetadmin/valle-pass`);
  await panel().getByRole('button', { name: /Integração financeira/ }).click();

  // 1) As duas chaves aparecem separadas e DESLIGADAS por padrão, com o que cada uma significa.
  await panel().locator('[data-flag="Emissão dos dois vouchers"]').getByText('DESLIGADA').waitFor();
  await panel().locator('[data-flag^="Reembolso por unidade"]').getByText('DESLIGADA').waitFor();
  await panel().getByText(/ficam RETIDOS; nenhum voucher é emitido/).waitFor();
  await panel().getByText(/SEMPRE tratados por unidade/).waitFor();
  await panel().getByText(/Emissão dos dois vouchers DESLIGADA: pagamentos de campanhas com benefícios ficam retidos/).waitFor();
  pass('1) o ClosetAdmin mostra as duas chaves separadas, DESLIGADAS, e explica que reembolso dos dois vouchers é sempre por unidade');

  // 2) Retidos × unidades sem tratamento × e-mails aguardando envio, separados.
  const summary = panel().getByRole('group', { name: 'Resumo das pendências' });
  await summary.getByText('Pagamentos retidos').waitFor();
  assert.match(await summary.innerText(), /Pagamentos retidos\s*3\b/);
  assert.match(await summary.innerText(), /integração desligada: 1/i);
  assert.match(await summary.innerText(), /instante do pagamento desconhecido: 1/);
  assert.match(await summary.innerText(), /compra aumentou:\s*1/);
  assert.match(await summary.innerText(), /Unidades pagas sem tratamento\s*2\b/);
  assert.match(await summary.innerText(), /E-mails aguardando envio\s*1\b/);
  assert.match(await summary.innerText(), /Precisam de atenção: 1/);
  assert.match(await summary.innerText(), /o envio segue desligado/);
  await panel().getByText(/\d+ pendência\(s\)/).first().waitFor();
  pass('2) pagamentos retidos (por causa), unidades sem tratamento e e-mails aguardando envio aparecem em números separados');

  // 3) Lista de retenções: o instante real do pagamento (ou a falta dele) e os motivos novos em português.
  await page.getByRole('button', { name: /Capacidade, lotes e configuração/ }).first().click();
  const holdRow = (text) => page.locator('li').filter({ hasText: text });
  await holdRow(`${prefix}#2`).getByText(/instante do pagamento DESCONHECIDO/).waitFor();
  await holdRow(`${prefix}#2`).getByText(/instante real do pagamento desconhecido/).waitFor();
  await holdRow(`${prefix}#1`).getByText(/pago em .* \(prazo de 3 dias conta daqui\)/).waitFor();
  await holdRow(`${prefix}#3`).getByText(/a compra aumentou depois da emissão/).waitFor();
  pass('3) retenções mostram "pago em …" (de onde conta o prazo) ou "instante DESCONHECIDO", e os motivos novos');

  // 4) Pedido pago sem tratamento: ADMIN vê "Regularizar"; com a chave DESLIGADA a API recusa com explicação e NADA é emitido.
  const untreated = panel().getByLabel('Pedidos pagos sem tratamento');
  const untreatedRow = untreated.locator('li').filter({ hasText: `${prefix}#4` });
  await untreatedRow.getByText(/2 unidade\(s\) sem voucher de 2 paga\(s\)/).waitFor();
  await untreatedRow.getByRole('button', { name: 'Regularizar', exact: true }).click();
  const runButton = untreatedRow.getByRole('button', { name: 'Regularizar agora' });
  assert.equal(await runButton.isDisabled(), true); // justificativa vazia
  await untreatedRow.getByPlaceholder(/Justificativa/).fill('curta');
  assert.equal(await runButton.isDisabled(), true);
  await untreatedRow.getByPlaceholder(/Justificativa/).fill('Pagamento conferido na Shopify (teste)');
  await runButton.click();
  await untreatedRow.getByRole('alert').filter({ hasText: /integração dos dois vouchers está desligada/ }).waitFor();
  assert.equal(await db.valePass.count({ where: { shopifyOrderId: o4 } }), 0);
  pass('4) regularizar com a chave DESLIGADA: a API recusa com explicação e nenhum voucher é criado');

  // 5) Funcionário sem ADMIN: vê tudo, mas sem botões de ação; a API recusa (403).
  const staffCtx = await newContext(staff.token, WEB_OFF, { viewport: { width: 1280, height: 1400 } });
  const staffPage = await newPage(staffCtx, errors);
  await staffPage.goto(`${WEB_OFF}/closetadmin/valle-pass`);
  await staffPage.getByLabel('Integração financeira').getByRole('button', { name: /Integração financeira/ }).click();
  await staffPage.getByLabel('Integração financeira').getByLabel('Pedidos pagos sem tratamento').getByText(new RegExp(`${prefix}#4`)).waitFor();
  assert.equal(await staffPage.getByLabel('Integração financeira').getByRole('button', { name: 'Regularizar', exact: true }).count(), 0);
  const forbidden = await fetch(`${API_OFF}/admin/vale-pass/flow/regularize`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiToken}`, 'X-Admin-Session': staff.token },
    body: JSON.stringify({ adminUserId: staff.id, orderId: o4, note: 'tentativa sem perfil de administrador' }),
  });
  assert.equal(forbidden.status, 403);
  const forbiddenResume = await fetch(`${API_OFF}/admin/vale-pass/flow/resume`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiToken}`, 'X-Admin-Session': staff.token },
    body: JSON.stringify({ adminUserId: staff.id, note: 'tentativa sem perfil de administrador' }),
  });
  assert.equal(forbiddenResume.status, 403);
  assert.equal(await db.valePass.count({ where: { shopifyOrderId: o4 } }), 0);
  pass('5) sem perfil ADMIN: sem botões; a API recusa regularizar e retomar (403)');

  // 5b) Contador operacional, política do horário e horário do pagamento desconhecido (só ADMIN resolve).
  const counters = page.getByRole('group', { name: 'Alertas operacionais' });
  await counters.waitFor();
  const severity = await counters.getAttribute('data-severity');
  assert.ok(['warning', 'critical'].includes(severity), 'severidade ' + severity);
  assert.match(await counters.innerText(), /Pagamentos confirmados sem benefício:\s*4\s*pedido\(s\)/);
  assert.match(await counters.innerText(), /Horário do pagamento desconhecido:\s*1/);
  assert.match(await page.getByTestId('payment-time-policy').innerText(), /política ESTRITA \(padrão\)/);
  const pending = panel().getByLabel('Horário do pagamento desconhecido');
  const pendingRow = pending.locator('li').filter({ hasText: `${prefix}#2` });
  await pendingRow.getByText(/Webhook: sem sinal válido/).waitFor();
  await pendingRow.getByRole('button', { name: 'Resolver' }).click();
  const verifyButton = pendingRow.getByRole('button', { name: 'Conferir na Shopify' });
  assert.equal(await verifyButton.isDisabled(), true); // justificativa vazia
  await pendingRow.getByPlaceholder(/Justificativa/).fill('Conferindo o horário do pagamento (teste)');
  await verifyButton.click();
  await pendingRow.getByRole('alert').filter({ hasText: /Shopify Admin API não está configurada/ }).waitFor(); // sem credenciais: nada de rede
  const confirmButton = pendingRow.getByRole('button', { name: 'Confirmar manualmente' });
  assert.equal(await confirmButton.isDisabled(), true); // sem horário
  const half = new Date(Date.now() - 30 * 60_000);
  await pendingRow.getByLabel('Horário do pagamento (Brasília)').fill(new Date(half.getTime() - 3 * HOUR).toISOString().slice(0, 16)); // relógio de Brasília (UTC-3)
  await confirmButton.click();
  for (let i = 0; i < 60 && !(await db.valePassOrder.findUnique({ where: { shopifyOrderId: o2 } }))?.paymentConfirmedAt; i++) await delay(500);
  const confirmedOrder = await db.valePassOrder.findUniqueOrThrow({ where: { shopifyOrderId: o2 } });
  assert.equal(confirmedOrder.paymentConfirmedSource, 'ADMIN_MANUAL');
  assert.ok(Math.abs(confirmedOrder.paymentConfirmedAt.getTime() - half.getTime()) < 60_000);
  const timeAudit = await db.adminAuditEvent.findFirst({ where: { action: 'VALE_PASS_PAYMENT_TIME_CONFIRMED', adminUserId: admin.id } });
  assert.ok(timeAudit && timeAudit.isCritical === true);
  assert.equal(await db.valePass.count({ where: { shopifyOrderId: o2 } }), 0); // confirmar o horário NÃO emite nada
  pass('5b) contador operacional, política estrita à vista, "Conferir na Shopify" sem credenciais não faz rede e a confirmação manual do ADMIN fica ADMIN_MANUAL, auditada, sem emitir');

  // 5c) Contador específico no menu (independe de "pedidos novos") e funcionário sem ADMIN não vê "Resolver".
  const financialBadge = page.getByTestId('valle-pass-financial-badge');
  await financialBadge.waitFor();
  assert.match((await financialBadge.innerText()).trim(), /^[1-9]\d?$/);
  assert.equal(await staffPage.getByLabel('Integração financeira').getByRole('button', { name: 'Resolver' }).count(), 0);
  const forbiddenTime = await fetch(`${API_OFF}/admin/vale-pass/flow/payment-time/confirm`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiToken}`, 'X-Admin-Session': staff.token },
    body: JSON.stringify({ adminUserId: staff.id, orderId: o1, confirmedAt: new Date().toISOString(), note: 'tentativa sem perfil de administrador' }),
  });
  assert.equal(forbiddenTime.status, 403);
  pass('5c) contador vermelho do menu aparece; sem ADMIN não há "Resolver" e a API recusa confirmar horário (403)');

  // 6) Chave de emissão LIGADA (processo de teste local): o painel mostra LIGADA e a regularização emite com validação, e-mail só na fila, auditada.
  const onCtx = await newContext(admin.token, WEB_ON, { viewport: { width: 1280, height: 1400 } });
  const onPage = await newPage(onCtx, errors);
  await onPage.goto(`${WEB_ON}/closetadmin/valle-pass`);
  const onPanel = onPage.getByLabel('Integração financeira');
  await onPanel.getByRole('button', { name: /Integração financeira/ }).click();
  await onPanel.locator('[data-flag="Emissão dos dois vouchers"]').getByText('LIGADA').waitFor();
  await onPanel.locator('[data-flag^="Reembolso por unidade"]').getByText('DESLIGADA').waitFor();
  await onPanel.getByText(/Reembolso por unidade para campanhas sem benefícios está desligado; para pedidos dos dois vouchers o reembolso é SEMPRE por unidade/).waitFor();
  const onRow = onPanel.getByLabel('Pedidos pagos sem tratamento').locator('li').filter({ hasText: `${prefix}#4` });
  await onRow.getByRole('button', { name: 'Regularizar', exact: true }).click();
  await onRow.getByPlaceholder(/Justificativa/).fill('Pagamento conferido na Shopify (teste)');
  await onRow.getByRole('button', { name: 'Regularizar agora' }).click();
  const onSummary = onPanel.getByRole('group', { name: 'Resumo das pendências' });
  for (let i = 0; i < 60 && !/Unidades pagas sem tratamento\s*0\b/.test(await onSummary.innerText()); i++) await delay(500); // a lista se atualiza sozinha depois de regularizar
  assert.match(await onSummary.innerText(), /Unidades pagas sem tratamento\s*0\b/);
  assert.equal(await db.valePass.count({ where: { shopifyOrderId: o4 } }), 4);
  const mails = await db.valePassEmailOutbox.findMany({ where: { shopifyOrderId: o4 } });
  assert.equal(mails.length, 2);
  assert.ok(mails.every((m) => m.status === 'QUEUED' && m.kind === 'INITIAL'));
  assert.equal(await db.valePassEmailOutbox.count({ where: { campaignId, status: { in: ['ACCEPTED', 'DELIVERED', 'SENDING'] } } }), 0); // nada foi enviado
  const audit = await db.adminAuditEvent.findFirst({ where: { action: 'VALE_PASS_ORDER_REGULARIZED', adminUserId: admin.id } });
  assert.ok(audit && audit.isCritical === true);
  assert.ok(!JSON.stringify(audit).includes('cliente4@exemplo.invalid'));
  pass('6) com a emissão LIGADA (só no processo de teste): regularização emite 2 unidades, enfileira 2 e-mails (nada enviado), audita sem dados pessoais');

  // 7) Celular.
  const mobile = await newContext(admin.token, WEB_ON, { viewport: { width: 390, height: 844 } });
  const mobilePage = await newPage(mobile, errors);
  await mobilePage.goto(`${WEB_ON}/closetadmin/valle-pass`);
  await mobilePage.getByLabel('Integração financeira').getByRole('button', { name: /Integração financeira/ }).click();
  await mobilePage.getByLabel('Integração financeira').getByText('LIGADA').first().waitFor();
  assert.equal(await mobilePage.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth), 0);
  pass('7) celular (390px): sem rolagem lateral');

  assert.deepEqual(errors, []);
  assert.deepEqual(externalRequests, [], 'o navegador tentou acessar a internet');
  pass('8) nenhum erro no console nem acesso externo');
  console.log(`Integração financeira no navegador: ${results.length} verificações passaram.`);
} finally {
  await clean();
}
