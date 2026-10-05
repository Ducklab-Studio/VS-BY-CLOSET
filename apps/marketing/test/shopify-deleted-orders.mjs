import assert from 'node:assert/strict';
import { createHmac, randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright';

/**
 * Pedido excluído na Shopify → ClosetAdmin, num navegador de verdade: API e site
 * locais isolados, reservas e pedidos de Valle Pass sintéticos no banco de teste,
 * e o `orders/delete` entregue ao endpoint local como a Shopify entregaria
 * (assinado com um segredo de teste gerado aqui). Nenhuma chamada à Shopify real:
 * a loja é a de desenvolvimento e as integrações ficam desligadas.
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
if (!localTestDb && !allowedTestHost) throw new Error('O teste de pedidos excluídos exige um banco de TESTE (local ou listado em TEST_DATABASE_ALLOWED_HOSTS).');
for (const key of ['SHOPIFY_STORE_DOMAIN', 'SHOPIFY_CLIENT_ID', 'SHOPIFY_CLIENT_SECRET', 'SHOPIFY_STOREFRONT_TOKEN']) {
  if (process.env[key]) throw new Error('Integrações externas configuradas; teste abortado.');
}

const apiUrl = 'http://127.0.0.1:3354';
const webUrl = 'http://127.0.0.1:3054';
const reservasUrl = `${webUrl}/closetadmin/reservas`;
const vallePassUrl = `${webUrl}/closetadmin/valle-pass`;
const apiToken = randomBytes(32).toString('hex');
const webhookSecret = randomBytes(24).toString('hex');
const DEV_SHOP = 'dev-store.myshopify.com';
const prefix = `DELBROWSER-${Date.now()}`;
const db = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
const childProcesses = [];
const userIds = [];
let counter = 0;
let orderCounter = 9_600_000_000_000 + (Date.now() % 1_000_000) * 10;
let browser;
/** Requisições do navegador para fora do computador (deve ficar vazio). */
const externalRequests = [];

function spawnLocal(command, args, cwd, env) {
  const child = spawn(command, args, { cwd, env, stdio: 'ignore', windowsHide: true });
  childProcesses.push(child);
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
async function createUser(name, moduleAccess) {
  const user = await db.adminUser.create({ data: { name, phone: `${Date.now()}${userIds.length}7`, pinHash: 'synthetic', role: 'STAFF', moduleAccess } });
  userIds.push(user.id);
  const token = generateSessionToken();
  await db.adminSession.create({ data: { adminUserId: user.id, tokenHash: hashSessionToken(token), expiresAt: new Date(Date.now() + 3_600_000) } });
  return token;
}

/** Reserva online sintética já vinculada a um pedido (retirada em 2032, no topo da lista). Já vista: não mexe no contador. */
async function createReservation(status, customer) {
  counter++;
  const orderId = String(orderCounter++);
  const code = `${prefix}-u${counter}`;
  const unit = await db.rentalUnit.create({ data: { code, name: 'peça sintética', shopifyVariantId: `${code}-variant`, active: true, reservableOnline: true, countsTowardRentalDuration: true } });
  const pickup = `2032-0${(counter % 9) + 1}-1${counter % 9}`;
  const rows = await db.$queryRaw`
    INSERT INTO reservations (id, status, source, origin_store_id, pickup_date, return_date, shopify_order_id, customer_name, customer_phone, viewed_status, viewed_at)
    VALUES (gen_random_uuid(), ${status}::"reservation_status", 'online'::"reservation_source", 'dev-store', ${pickup}::date, (${pickup}::date + 3),
      ${orderId}, ${customer}, '+55 11 90000-0000', ${status}::"reservation_status", now())
    RETURNING id
  `;
  await db.$executeRaw`
    INSERT INTO reservation_items (id, reservation_id, rental_unit_id, status, blocked_range)
    VALUES (gen_random_uuid(), ${rows[0].id}::uuid, ${unit.id}::uuid, ${status}::"reservation_status", daterange(${pickup}::date - 3, ${pickup}::date + 6, '[)'))
  `;
  return { id: rows[0].id, orderId };
}
async function createValePassOrder(status) {
  const orderId = String(orderCounter++);
  const name = `${prefix}#${orderId}`;
  await db.valePassOrder.create({
    data: { shopifyOrderId: orderId, shopifyOrderName: name, status, quantity: 1, orderCreatedAt: new Date(), lastSyncSource: 'test', viewedAt: new Date() },
  });
  return { orderId, name };
}

/** Mesmo formato da Shopify: corpo cru assinado (HMAC-SHA256, base64) com o segredo do app. */
async function deliverDelete(orderId) {
  const body = JSON.stringify({ id: Number(orderId) });
  const response = await fetch(`${apiUrl}/webhooks/shopify`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Shopify-Hmac-Sha256': createHmac('sha256', webhookSecret).update(body).digest('base64'),
      'X-Shopify-Topic': 'orders/delete',
      'X-Shopify-Webhook-Id': `${prefix}-wh-${orderId}-${randomBytes(4).toString('hex')}`,
      'X-Shopify-Shop-Domain': DEV_SHOP,
    },
    body,
  });
  assert.equal(response.status, 200, `webhook orders/delete ${orderId}`);
}

async function newPage(context, errors) {
  const page = await context.newPage();
  page.setDefaultTimeout(30_000);
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });
  return page;
}
async function newContext(token, options = {}) {
  const context = await browser.newContext(options);
  await context.route('**/*', (route) => {
    const host = new URL(route.request().url()).hostname;
    if (['localhost', '127.0.0.1'].includes(host)) return route.continue();
    externalRequests.push(host); // navegador tentando sair (Shopify real, CDN...): reprova o teste
    return route.abort();
  });
  await context.addCookies([{ name: 'closetadmin_session', value: token, url: webUrl, httpOnly: true, sameSite: 'Lax' }]);
  return context;
}
const row = (page, id) => page.locator(`tr[data-reservation-id="${id}"]`);
const orderCard = (page, name) => page.locator('article', { hasText: name });

async function clean() {
  for (const child of childProcesses) child.kill();
  await browser?.close();
  const rows = await db.$queryRaw`SELECT DISTINCT ri.reservation_id AS id FROM reservation_items ri JOIN rental_units ru ON ru.id = ri.rental_unit_id WHERE ru.code LIKE ${prefix + '%'}`;
  const ids = rows.map((r) => r.id);
  const hooks = (await db.$queryRaw`SELECT id FROM webhook_events WHERE shopify_webhook_id LIKE ${prefix + '%'}`).map((r) => r.id);
  if (ids.length || hooks.length) await db.$executeRaw`DELETE FROM reservation_events WHERE reservation_id = ANY(${ids}::uuid[]) OR webhook_event_id = ANY(${hooks}::uuid[])`;
  if (hooks.length) await db.$executeRaw`DELETE FROM webhook_events WHERE id = ANY(${hooks}::uuid[])`;
  if (ids.length) {
    await db.$executeRaw`DELETE FROM reservation_items WHERE reservation_id = ANY(${ids}::uuid[])`;
    await db.$executeRaw`DELETE FROM reservations WHERE id = ANY(${ids}::uuid[])`;
  }
  await db.$executeRaw`DELETE FROM rental_units WHERE code LIKE ${prefix + '%'}`;
  const orders = await db.valePassOrder.findMany({ where: { shopifyOrderName: { startsWith: prefix } }, select: { id: true } });
  if (orders.length) {
    await db.valePassOrderEvent.deleteMany({ where: { valePassOrderId: { in: orders.map((o) => o.id) } } });
    await db.valePassOrder.deleteMany({ where: { id: { in: orders.map((o) => o.id) } } });
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

try {
  const token = await createUser('Operador sintético exclusões', ['RESERVATIONS', 'VALLE_PASS']);
  const childEnv = {
    ...process.env, DATABASE_URL: databaseUrl, ADMIN_API_TOKEN: apiToken, PICKUP_REMINDER_ENABLED: 'false',
    VALE_PASS_ORDER_SYNC_INTERVAL_MINUTES: '0', SHOPIFY_ORDER_DELETION_SYNC_INTERVAL_MINUTES: '0', CATALOG_SYNC_INTERVAL_MINUTES: '0',
    SHOPIFY_CLIENT_ID: '', SHOPIFY_CLIENT_SECRET: '',
  };
  spawnLocal(process.execPath, [path.join(apiDir, 'dist/src/main.js')], apiDir, { ...childEnv, SHOPIFY_CLIENT_SECRET: webhookSecret, PORT: '3354', NODE_ENV: 'development' });
  spawnLocal(process.execPath, [path.join(marketingDir, 'node_modules/next/dist/bin/next'), 'start', '-p', '3054', '-H', '127.0.0.1'], marketingDir, {
    ...childEnv, NODE_ENV: 'production', RESERVATIONS_API_ADMIN_URL: apiUrl, RESERVATIONS_API_URL: apiUrl, NEXT_TELEMETRY_DISABLED: '1', __NEXT_PROCESSED_ENV: 'true',
  });
  await waitFor(`${apiUrl}/health`);
  await waitFor(`${webUrl}/closetadmin/login`);
  browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_BROWSER_CHANNEL ? { channel: process.env.PLAYWRIGHT_BROWSER_CHANNEL } : {}) });

  const unpaid = await createReservation('pending_payment', 'Cliente Excluída Pendente');
  const paid = await createReservation('confirmed', 'Cliente Excluída Paga');
  const cancelled = await createReservation('cancelled', 'Cliente Só Cancelada');
  const normal = await createReservation('confirmed', 'Cliente Normal');
  const vpDeleted = await createValePassOrder('PENDING');
  const vpExpired = await createValePassOrder('EXPIRED');

  await deliverDelete(unpaid.orderId);
  await deliverDelete(paid.orderId);
  await deliverDelete(vpDeleted.orderId);
  await deliverDelete(unpaid.orderId); // repetido, outro id de webhook
  await deliverDelete(String(orderCounter++)); // pedido comum da Shopify, nunca importado
  pass('orders/delete assinado entregue ao endpoint local (incluindo repetido e pedido não importado) → 200');

  const errors = [];
  const context = await newContext(token, { viewport: { width: 1280, height: 900 } });
  const page = await newPage(context, errors);

  // Lista ativa: pendente excluída some; paga excluída fica (revisão) com o motivo; cancelada e normal ficam sem etiqueta.
  await page.goto(reservasUrl);
  await row(page, normal.id).waitFor();
  assert.equal(await row(page, unpaid.id).count(), 0, 'pedido excluído sai da lista ativa');
  assert.equal(await row(page, paid.id).locator('[data-testid="shopify-deleted-badge"]').count(), 1);
  assert.match(await row(page, paid.id).innerText(), /Requer atenção/);
  assert.equal(await row(page, cancelled.id).count(), 1, 'pedido só cancelado continua na lista');
  assert.match(await row(page, cancelled.id).innerText(), /Cancelad/i);
  for (const r of [cancelled, normal]) assert.equal(await row(page, r.id).locator('[data-testid="shopify-deleted-badge"]').count(), 0);
  pass('Reservas: excluída e encerrada sai da lista; paga excluída fica em revisão com "Pedido excluído na Shopify"; cancelada e normal intactas');

  // Filtro "Mostrar excluídos da Shopify" (pelo formulário).
  await page.getByLabel('Mostrar excluídos da Shopify').check();
  await page.getByRole('button', { name: 'Aplicar filtros' }).click();
  await page.waitForURL(/shopifyDeletedOnly=true/);
  await row(page, unpaid.id).waitFor();
  for (const r of [unpaid, paid]) assert.equal(await row(page, r.id).locator('[data-testid="shopify-deleted-badge"]').count(), 1);
  for (const r of [cancelled, normal]) assert.equal(await row(page, r.id).count(), 0);
  pass('filtro "Mostrar excluídos da Shopify" traz as duas de volta, com a etiqueta, e só elas');

  // Detalhe: motivo, histórico e vínculo preservados; sem link para um pedido que não existe mais.
  await page.goto(`${reservasUrl}/${unpaid.id}`);
  const reason = page.locator('[data-testid="shopify-deleted-reason"]');
  await reason.waitFor();
  assert.match(await reason.innerText(), /Pedido excluído na Shopify em .*saiu da lista ativa/);
  assert.match(await page.locator('main').innerText(), /Motivo do arquivamento\s*Pedido excluído na Shopify/);
  assert.equal(await page.getByText('Abrir pedido no Shopify').count(), 0);
  assert.doesNotMatch(await reason.innerText(), /Cliente/);
  await page.goto(`${reservasUrl}/${paid.id}`);
  await reason.waitFor();
  assert.match(await reason.innerText(), /continua na lista para revisão.*peça não foi liberada/);
  pass('detalhe mostra "Pedido excluído na Shopify", o motivo do arquivamento ou da revisão, sem dados de cliente no aviso e sem link para o pedido');

  // Valle Pass: excluído fora da lista; expirado continua; "Mostrar excluídos da Shopify" traz de volta com o motivo.
  await page.goto(vallePassUrl);
  await orderCard(page, vpExpired.name).waitFor();
  assert.equal(await orderCard(page, vpDeleted.name).count(), 0);
  await page.getByLabel('Mostrar excluídos da Shopify').check();
  await orderCard(page, vpDeleted.name).waitFor();
  assert.match(await orderCard(page, vpDeleted.name).locator('[data-testid="order-deleted-reason"]').innerText(), /Pedido excluído na Shopify em/);
  assert.match(await orderCard(page, vpDeleted.name).innerText(), /Cancelad/i);
  await page.getByLabel('Mostrar excluídos da Shopify').uncheck();
  await orderCard(page, vpDeleted.name).waitFor({ state: 'detached' });
  pass('Valle Pass: excluído some da lista padrão, expirado continua; o filtro mostra o excluído com o motivo');

  // Celular: filtros e etiqueta sem rolagem lateral.
  const mobile = await newContext(token, { viewport: { width: 390, height: 844 } });
  const mp = await newPage(mobile, errors);
  await mp.goto(`${reservasUrl}?shopifyDeletedOnly=true`);
  await mp.locator('[data-testid="shopify-deleted-badge"]').first().waitFor();
  assert.equal(await mp.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth), 0);
  await mp.goto(`${reservasUrl}/${paid.id}`);
  await mp.locator('[data-testid="shopify-deleted-reason"]').waitFor();
  assert.equal(await mp.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth), 0);
  await mobile.close();
  pass('celular (390px): lista filtrada e detalhe sem rolagem lateral');

  // Nada apagado fisicamente; peça paga não liberada; uma marcação só.
  for (const r of [unpaid, paid, cancelled, normal]) assert.equal(await db.reservation.count({ where: { id: r.id } }), 1);
  assert.equal((await db.reservation.findUniqueOrThrow({ where: { id: paid.id } })).status, 'problem');
  assert.equal(await db.reservationEvent.count({ where: { reservationId: unpaid.id, type: 'ORDER_DELETED' } }), 1);
  assert.equal(await db.valePassOrder.count({ where: { shopifyOrderId: { in: [vpDeleted.orderId, vpExpired.orderId] } } }), 2);
  pass('banco: nenhuma linha apagada, paga continua ocupando (revisão), exclusão repetida registrada uma vez');

  assert.deepEqual(errors, []);
  assert.deepEqual(externalRequests, [], 'o navegador tentou acessar a internet (Shopify real?)');
  pass('nenhum erro no console nem erro de página');
  console.log(`Pedidos excluídos na Shopify no navegador: ${results.length} verificações passaram.`);
} finally {
  await clean();
}
