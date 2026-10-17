import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright';

/**
 * Acompanhamento dos e-mails dos vouchers no ClosetAdmin, num navegador de verdade: API e site locais isolados, banco de teste, nenhuma
 * Shopify, NENHUM e-mail (o envio fica desligado: sem VALE_PASS_EMAIL_MODE). As linhas da caixa de saída são gravadas direto no banco de teste.
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
if (!localTestDb && !allowedTestHost) throw new Error('O teste de e-mails exige um banco de TESTE (local ou listado em TEST_DATABASE_ALLOWED_HOSTS).');
for (const key of ['SHOPIFY_STORE_DOMAIN', 'SHOPIFY_CLIENT_ID', 'SHOPIFY_CLIENT_SECRET', 'SHOPIFY_STOREFRONT_TOKEN', 'RESEND_API_KEY', 'VALE_PASS_EMAIL_MODE']) {
  if (process.env[key]) throw new Error('Integrações externas ou envio de e-mail configurados; teste abortado.');
}

const apiUrl = 'http://127.0.0.1:3355';
const webUrl = 'http://127.0.0.1:3055';
const vallePass = `${webUrl}/closetadmin/valle-pass`;
const apiToken = randomBytes(32).toString('hex');
const prefix = `EMAILS-${Date.now()}`;
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

let campaignId = null;
const orderIds = [];
async function clean() {
  for (const child of childProcesses) child.kill();
  await browser?.close();
  await db.$transaction(async (tx) => {
    await tx.$executeRawUnsafe('SET LOCAL session_replication_role = replica'); // a linha do tempo é append-only; só este teste descartável a limpa
    if (campaignId) {
      await tx.valePassEmailEvent.deleteMany({ where: { outbox: { campaignId } } });
      await tx.valePassEmailOutbox.deleteMany({ where: { campaignId } });
      const passes = await tx.valePass.findMany({ where: { campaignId }, select: { id: true } });
      await tx.adminAuditEvent.deleteMany({ where: { entityType: 'ValePassEmailOutbox' } });
      await tx.valePassEvent.deleteMany({ where: { valePassId: { in: passes.map((p) => p.id) } } });
      await tx.valePass.deleteMany({ where: { campaignId } });
      await tx.valePassCampaignBenefit.deleteMany({ where: { campaignId } });
      await tx.valePassCampaign.deleteMany({ where: { id: campaignId } });
    }
    const regs = await tx.valePassOrder.findMany({ where: { shopifyOrderId: { in: orderIds } }, select: { id: true } });
    await tx.valePassOrderEvent.deleteMany({ where: { valePassOrderId: { in: regs.map((r) => r.id) } } });
    await tx.valePassOrder.deleteMany({ where: { shopifyOrderId: { in: orderIds } } });
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
const DAY = 24 * HOUR;

try {
  const admin = await createUser(`Admin E-mails sintético ${prefix}`, 'ADMIN');
  const staff = await createUser(`Operador E-mails sintético ${prefix}`, 'STAFF');

  const campaign = await db.valePassCampaign.create({
    data: { name: `${prefix} Valle Pass`, amountCents: 35_000, validityDays: 30, shopifyVariantId: `${prefix}-variant`, voucherValidFrom: new Date('2027-01-01T00:00:00Z'), voucherValidUntil: new Date('2027-12-31T00:00:00Z') },
  });
  campaignId = campaign.id;
  const [showroom, closet] = await Promise.all([
    db.valePassCampaignBenefit.create({ data: { campaignId, code: 'valle_showroom_500', kind: 'VOUCHER', company: 'VALLE_SHOWROOM', label: 'Voucher Valle Showroom', amountCents: 50_000, sortOrder: 0 } }),
    db.valePassCampaignBenefit.create({ data: { campaignId, code: 'vs_by_closet_50', kind: 'VOUCHER', company: 'VS_BY_CLOSET', label: 'Voucher VS BY CLOSET', amountCents: 5_000, sortOrder: 1 } }),
  ]);

  /** Pedido pago com uma unidade (2 vouchers) e a mensagem da caixa de saída no estado pedido. */
  async function unit(n, { status, createdAgoMs, deadlineInMs, accepted = false, error = null, email = `cliente${n}@exemplo.invalid` }) {
    const orderId = `${prefix}-o${n}`;
    orderIds.push(orderId);
    await db.valePassOrder.create({
      data: {
        shopifyOrderId: orderId, shopifyOrderGid: `gid://shopify/Order/${orderId}`, shopifyOrderName: `${prefix}#${n}`, status: 'CONFIRMED', financialStatus: 'paid', quantity: 1,
        customerName: 'Cliente Sintético', customerEmail: email, customerPhone: '+5500000000000', lastSyncSource: 'teste',
        orderCreatedAt: new Date(Date.now() - createdAgoMs), statusChangedAt: new Date(Date.now() - createdAgoMs), vouchersProcessedAt: new Date(),
      },
    });
    const groupId = randomUUID();
    const codes = [];
    for (const [benefit, company, amount] of [[showroom, 'VALLE_SHOWROOM', 50_000], [closet, 'VS_BY_CLOSET', 5_000]]) {
      const code = `VALLE-${prefix.slice(-4).toUpperCase().replace(/[^A-Z0-9]/g, 'X')}-${n}${company === 'VS_BY_CLOSET' ? 'B' : 'A'}ZZ`.slice(0, 15);
      codes.push(code);
      await db.valePass.create({
        data: { code, campaignId, amountCents: amount, status: 'ACTIVE', purchasedAt: new Date(), expiresAt: new Date('2028-01-01T03:00:00Z'), validFrom: new Date('2027-01-01T03:00:00Z'), company, groupId, benefitId: benefit.id, shopifyOrderId: orderId },
      });
    }
    const id = randomUUID();
    await db.valePassEmailOutbox.create({
      data: {
        id, shopifyOrderId: orderId, campaignId, groupId, kind: 'INITIAL', dedupeKey: `initial:${groupId}`, toEmail: email, status, attempts: status === 'QUEUED' ? 0 : 2,
        idempotencyKey: `vpe-${id}`, deadlineAt: new Date(Date.now() + deadlineInMs), lastError: error,
        ...(accepted ? { providerMessageId: `em_${n}_${prefix}`, acceptedAt: new Date(), firstAttemptAt: new Date(), lastAttemptAt: new Date() } : {}),
        ...(status === 'DELIVERED' ? { deliveredAt: new Date() } : {}),
      },
    });
    await db.valePassEmailEvent.create({ data: { outboxId: id, type: 'ENQUEUED', detail: { n } } });
    return { id, orderId, email, codes };
  }
  const delivered = await unit(1, { status: 'DELIVERED', createdAgoMs: HOUR, deadlineInMs: 3 * DAY - HOUR, accepted: true });
  const queued = await unit(2, { status: 'QUEUED', createdAgoMs: HOUR, deadlineInMs: 3 * DAY - HOUR });
  const overdue = await unit(3, { status: 'NEEDS_ATTENTION', createdAgoMs: 4 * DAY, deadlineInMs: -DAY, error: 'attempts_exhausted_unknown_result' });
  const failed = await unit(4, { status: 'FAILED', createdAgoMs: 2 * HOUR, deadlineInMs: 3 * DAY, error: 'validation_error' });
  const accepted = await unit(5, { status: 'ACCEPTED', createdAgoMs: 2 * HOUR, deadlineInMs: 3 * DAY, accepted: true });

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
  const context = await newContext(admin.token, { viewport: { width: 1280, height: 1200 } });
  const page = await newPage(context, errors);
  const panel = () => page.getByLabel('E-mails dos vouchers');
  const row = (text) => panel().locator('li').filter({ hasText: text });

  // 1) Resumo e alertas: envio desligado (nada configurado), prazo vencido e mensagens para intervenção.
  await page.goto(vallePass);
  await panel().getByRole('button', { name: /E-mails dos vouchers/ }).click();
  await panel().getByText('Desligado').waitFor();
  await panel().getByText(/sem chave · domínio não verificado/).waitFor();
  await panel().getByText(/Envio real bloqueado: .*VALE_PASS_EMAIL_MODE=live/).waitFor();
  await panel().getByRole('alert').filter({ hasText: /passaram do prazo de 3 dias/ }).waitFor();
  await panel().getByRole('alert').filter({ hasText: /precisam de intervenção/ }).waitFor();
  await panel().getByText(/1 vencido\(s\)/).waitFor();
  pass('1) resumo: envio desligado/sem chave/domínio não verificado, prazo vencido e mensagens para intervenção aparecem como alertas');

  // 2) Lista com estados; e-mails e códigos MASCARADOS (nada completo na tela).
  await row(`${prefix}#1`).getByText('Entregue', { exact: true }).waitFor();
  await row(`${prefix}#2`).getByText('Na fila', { exact: true }).waitFor();
  await row(`${prefix}#3`).getByText('Precisa de atenção', { exact: true }).waitFor();
  await row(`${prefix}#3`).getByText(/PRAZO VENCIDO/).waitFor();
  await row(`${prefix}#4`).getByText('Falhou', { exact: true }).waitFor();
  await row(`${prefix}#5`).getByText('Aceito pela Resend', { exact: true }).waitFor();
  await row(`${prefix}#4`).getByText(/Tentativas: 2 de 8 · último problema: validation_error/).waitFor();
  await row(`${prefix}#1`).getByText(/entregue em/).waitFor();
  await row(`${prefix}#2`).getByText(/Próxima tentativa/).waitFor();
  await row(`${prefix}#1`).getByText('c***@exemplo.invalid').waitFor();
  const text = await panel().innerText();
  for (const f of [delivered, queued, overdue, failed, accepted]) {
    assert.ok(!text.includes(f.email), 'e-mail completo apareceu no painel');
    for (const code of f.codes) assert.ok(!text.includes(code), 'código completo apareceu no painel');
  }
  assert.match(text, /VALLE-[A-Z0-9]{4}-\*{4}/);
  const html = await panel().evaluate((el) => el.outerHTML); // o painel novo; as seções antigas (pedidos/vales) já exibem esses dados por desenho
  for (const f of [delivered, queued, overdue, failed, accepted]) {
    assert.ok(!html.includes(f.email), 'e-mail completo no HTML');
    for (const code of f.codes) assert.ok(!html.includes(code), 'código completo no HTML');
  }
  pass('2) lista com fila, aceitos, entregues, falhas, tentativas e prazo vencido; e-mails e códigos sempre mascarados (tela e HTML do painel)');

  // 3) Filtro e histórico.
  await panel().getByRole('button', { name: /^Na fila \(1\)/ }).click();
  await row(`${prefix}#2`).waitFor();
  await row(`${prefix}#1`).waitFor({ state: 'detached' }); // o filtro recarrega a lista: só a fila fica
  assert.equal(await panel().locator('li').filter({ hasText: 'Tentativas:' }).count(), 1);
  await panel().getByRole('button', { name: 'Todos' }).click();
  await row(`${prefix}#1`).getByRole('button', { name: 'Ver histórico' }).click();
  await row(`${prefix}#1`).getByLabel('Histórico da mensagem').getByText(/ENQUEUED/).waitFor();
  pass('3) filtro por estado e histórico da mensagem');

  // 4) Reenvio autorizado: justificativa e confirmação obrigatórias; cria nova mensagem e audita. NADA é enviado (envio desligado).
  await row(`${prefix}#5`).getByRole('button', { name: 'Reenviar', exact: true }).click();
  const confirmButton = row(`${prefix}#5`).getByRole('button', { name: 'Confirmar reenvio' });
  assert.equal(await confirmButton.isDisabled(), true);
  await row(`${prefix}#5`).getByLabel(/Justificativa/).fill('curta');
  await row(`${prefix}#5`).getByLabel(/Confirmo que quero reenviar/).check();
  assert.equal(await confirmButton.isDisabled(), true); // justificativa < 10
  await row(`${prefix}#5`).getByLabel(/Justificativa/).fill('Cliente não encontrou o e-mail');
  await row(`${prefix}#5`).getByLabel(/Confirmo que quero reenviar/).uncheck();
  assert.equal(await confirmButton.isDisabled(), true); // sem confirmação
  await row(`${prefix}#5`).getByLabel(/Confirmo que quero reenviar/).check();
  assert.equal(await confirmButton.isDisabled(), false);
  await confirmButton.click();
  await row(`${prefix}#5`).getByText(/Reenvio registrado e auditado/).waitFor();
  const resent = await db.valePassEmailOutbox.findFirst({ where: { campaignId, kind: 'RESEND' } });
  assert.ok(resent);
  assert.equal(resent.status, 'QUEUED');
  assert.equal(resent.resendOfId, accepted.id);
  assert.equal(resent.requestedBy, admin.id);
  assert.equal(resent.note, 'Cliente não encontrou o e-mail');
  const audit = await db.adminAuditEvent.findFirst({ where: { entityId: resent.id, action: 'VALE_PASS_EMAIL_RESENT' } });
  assert.equal(audit.adminUserId, admin.id);
  assert.equal(audit.isCritical, true);
  const auditText = JSON.stringify(audit);
  assert.ok(!auditText.includes(accepted.email));
  for (const code of accepted.codes) assert.ok(!auditText.includes(code));
  assert.equal(await db.valePassEmailOutbox.count({ where: { campaignId, status: { in: ['ACCEPTED', 'DELIVERED'] }, kind: 'RESEND' } }), 0); // nada foi enviado
  // mensagem na fila/cancelada não tem botão de reenvio
  assert.equal(await row(`${prefix}#2`).getByRole('button', { name: 'Reenviar', exact: true }).count(), 0);
  pass('4) reenvio exige justificativa ≥ 10 e confirmação; cria nova mensagem ligada à original, auditada sem e-mail/código; nada é enviado (envio desligado)');

  // 5) Perfil sem ADMIN: vê tudo (mascarado), sem botões de reenvio, e a API recusa (403).
  const staffCtx = await newContext(staff.token, { viewport: { width: 1280, height: 1200 } });
  const staffPage = await newPage(staffCtx, errors);
  await staffPage.goto(vallePass);
  await staffPage.getByLabel('E-mails dos vouchers').getByRole('button', { name: /E-mails dos vouchers/ }).click();
  await staffPage.getByLabel('E-mails dos vouchers').getByText('Entregue', { exact: true }).first().waitFor();
  assert.equal(await staffPage.getByLabel('E-mails dos vouchers').getByRole('button', { name: 'Reenviar', exact: true }).count(), 0);
  const forbidden = await fetch(`${apiUrl}/admin/vale-pass/emails/${failed.id}/resend`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiToken}`, 'X-Admin-Session': staff.token },
    body: JSON.stringify({ adminUserId: staff.id, note: 'tentativa sem perfil de administrador' }),
  });
  assert.equal(forbidden.status, 403);
  assert.equal(await db.valePassEmailOutbox.count({ where: { campaignId, kind: 'RESEND' } }), 1);
  // a API também recusa sem justificativa suficiente e com e-mail inválido (400)
  const adminHttp = (body) => fetch(`${apiUrl}/admin/vale-pass/emails/${failed.id}/resend`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiToken}`, 'X-Admin-Session': admin.token }, body: JSON.stringify({ adminUserId: admin.id, ...body }) });
  assert.equal((await adminHttp({ note: 'curta' })).status, 400);
  assert.equal((await adminHttp({ note: 'Justificativa suficiente', toEmail: 'não-é-email' })).status, 400);
  pass('5) sem perfil ADMIN: só leitura e a API recusa reenvio (403); validação de justificativa e e-mail (400)');

  // 6) Celular.
  const mobile = await newContext(admin.token, { viewport: { width: 390, height: 844 } });
  const mobilePage = await newPage(mobile, errors);
  await mobilePage.goto(vallePass);
  await mobilePage.getByLabel('E-mails dos vouchers').getByRole('button', { name: /E-mails dos vouchers/ }).click();
  await mobilePage.getByLabel('E-mails dos vouchers').getByText('Entregue', { exact: true }).first().waitFor();
  assert.equal(await mobilePage.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth), 0);
  pass('6) celular (390px): sem rolagem lateral');

  assert.deepEqual(errors, []);
  assert.deepEqual(externalRequests, [], 'o navegador tentou acessar a internet');
  pass('7) nenhum erro no console nem acesso externo');
  console.log(`E-mails dos vouchers no navegador: ${results.length} verificações passaram.`);
} finally {
  await clean();
}
