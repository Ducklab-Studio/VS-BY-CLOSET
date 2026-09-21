import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright';

const marketingDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const apiDir = path.resolve(marketingDir, '../reservations-api');
const requireApi = createRequire(path.join(apiDir, 'package.json'));
const { PrismaClient } = requireApi('@prisma/client');
const { generateSessionToken, hashSessionToken } = requireApi('./dist/src/admin/admin-session-token.js');
const { addDays, civilDateToISO, isSunday } = requireApi('./dist/src/rental-rules/civil-date.js');
const { isOnlineReservationAllowed, today } = requireApi('./dist/src/rental-rules/rental-engine.js');
const { DEFAULT_RENTAL_RULE_CONFIG } = requireApi('./dist/src/rental-rules/rental-rule-config.js');
const pdfParse = requireApi('pdf-parse');

const databaseUrl = process.env.DATABASE_URL ?? '';
if (!/^postgres(?:ql)?:\/\/[^@]+@(localhost|127\.0\.0\.1)(:\d+)?\//i.test(databaseUrl)) {
  throw new Error('O teste de navegador exige PostgreSQL local isolado.');
}
if (!/(test|audit|operational)/i.test(new URL(databaseUrl).pathname)) {
  throw new Error('O nome do banco local precisa identificar uma base de teste.');
}
for (const key of ['SHOPIFY_STORE_DOMAIN', 'SHOPIFY_CLIENT_SECRET', 'SHOPIFY_STOREFRONT_TOKEN']) {
  if (process.env[key]) throw new Error('Integrações externas configuradas; teste abortado.');
}

const apiUrl = 'http://127.0.0.1:3350';
const webUrl = 'http://127.0.0.1:3050';
const apiToken = randomBytes(32).toString('hex');
const prefix = `BROWSER-${Date.now()}`;
const storeId = `${prefix}-store`;
let pickupDate = addDays(today(DEFAULT_RENTAL_RULE_CONFIG), 60);
while (!isOnlineReservationAllowed(pickupDate, DEFAULT_RENTAL_RULE_CONFIG) || isSunday(pickupDate) || isSunday(addDays(pickupDate, 2))) {
  pickupDate = addDays(pickupDate, 1);
}
const pickup = civilDateToISO(pickupDate);
const returnDate = civilDateToISO(addDays(pickupDate, 2));
const blockedFrom = civilDateToISO(addDays(pickupDate, -3));
const blockedUntil = civilDateToISO(addDays(pickupDate, 5));
const db = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
const fixtures = {};
const childProcesses = [];
let browser;
let userId;

function spawnLocal(command, args, cwd, env) {
  const child = spawn(command, args, { cwd, env, stdio: 'ignore', windowsHide: true });
  childProcesses.push(child);
}

async function waitFor(url) {
  for (let i = 0; i < 120; i++) {
    try {
      if ((await fetch(url, { signal: AbortSignal.timeout(1000) })).ok) return;
    } catch { /* server still starting */ }
    await delay(500);
  }
  throw new Error('Serviço local não iniciou.');
}

async function seed() {
  await db.store.create({ data: { id: storeId, shopifyDomain: `${prefix.toLowerCase()}.invalid`, currency: 'BRL' } });
  const user = await db.adminUser.create({ data: {
    name: 'Operador sintético', phone: `${Date.now()}999`, pinHash: 'synthetic',
    role: 'STAFF', moduleAccess: ['RESERVATIONS', 'CALENDAR'],
  } });
  userId = user.id;
  const token = generateSessionToken();
  await db.adminSession.create({ data: { adminUserId: user.id, tokenHash: hashSessionToken(token), expiresAt: new Date(Date.now() + 3_600_000) } });
  for (const [label, status, source] of [
    ['cycle', 'confirmed', 'manual_admin'], ['returnDouble', 'confirmed', 'manual_admin'],
    ['cancelDouble', 'confirmed', 'manual_admin'], ['hold', 'hold', 'manual_admin'],
    ['online', 'confirmed', 'online'],
  ]) {
    const unit = await db.rentalUnit.create({ data: {
      code: `${prefix}-${label}`, name: 'Unidade sintética', shopifyVariantId: `${prefix}-${label}`,
      active: true, reservableOnline: true, countsTowardRentalDuration: true,
    } });
    const reservation = await db.reservation.create({ data: {
      status, source, originStoreId: storeId,
      pickupDate: new Date(pickup), returnDate: new Date(returnDate),
      confirmedAt: status === 'confirmed' ? new Date() : null,
    } });
    await db.$executeRaw`INSERT INTO reservation_items (reservation_id, rental_unit_id, blocked_range, status)
      VALUES (${reservation.id}::uuid, ${unit.id}::uuid, daterange(${blockedFrom}::date, ${blockedUntil}::date, '[)'), ${status}::reservation_status)`;
    fixtures[label] = { id: reservation.id, unitId: unit.id, code: unit.code };
  }
  return token;
}

async function status(label) {
  return (await db.reservation.findUniqueOrThrow({ where: { id: fixtures[label].id } })).status;
}

async function eventCount(label, type) {
  return db.reservationEvent.count({ where: { reservationId: fixtures[label].id, type } });
}

async function availability() {
  const response = await fetch(`${apiUrl}/availability?shopifyVariantId=${fixtures.cycle.code}&countedPieces=1&from=${pickup}&to=${pickup}`);
  assert.equal(response.status, 200);
  return (await response.json()).days[0].quantityAvailable;
}

async function calendarContains(token) {
  const response = await fetch(`${apiUrl}/admin/calendar?from=${blockedFrom}&to=${blockedUntil}`, {
    headers: { Authorization: `Bearer ${apiToken}`, 'X-Admin-Session': token, 'Content-Type': 'application/json' },
  });
  assert.equal(response.status, 200);
  return (await response.json()).some((entry) => entry.reservationId === fixtures.cycle.id);
}

async function clickAction(page, label, double = false, reason) {
  await page.getByRole('button', { name: label, exact: true }).first().click();
  if (reason) await page.getByRole('textbox', { name: 'Motivo' }).fill(reason);
  const confirm = page.getByRole('button', { name: label, exact: true }).last();
  if (double) await confirm.dblclick();
  else await confirm.click();
}

async function clean() {
  for (const child of childProcesses) child.kill();
  await browser?.close();
  const ids = Object.values(fixtures).map((x) => x.id);
  const unitIds = Object.values(fixtures).map((x) => x.unitId);
  if (ids.length) {
    await db.reservationEvent.deleteMany({ where: { reservationId: { in: ids } } });
    await db.$executeRaw`DELETE FROM reservation_items WHERE reservation_id = ANY(${ids}::uuid[])`;
    await db.reservation.deleteMany({ where: { id: { in: ids } } });
  }
  if (unitIds.length) await db.rentalUnit.deleteMany({ where: { id: { in: unitIds } } });
  if (userId) {
    await db.adminSession.deleteMany({ where: { adminUserId: userId } });
    await db.adminUser.delete({ where: { id: userId } });
  }
  await db.store.deleteMany({ where: { id: storeId } });
  await db.$disconnect();
}

try {
  const token = await seed();
  const childEnv = { ...process.env, DATABASE_URL: databaseUrl, ADMIN_API_TOKEN: apiToken, PICKUP_REMINDER_ENABLED: 'false' };
  spawnLocal(process.execPath, [path.join(apiDir, 'dist/src/main.js')], apiDir, { ...childEnv, PORT: '3350', NODE_ENV: 'development' });
  spawnLocal(process.execPath, [path.join(marketingDir, 'node_modules/next/dist/bin/next'), 'start', '-p', '3050', '-H', '127.0.0.1'], marketingDir, {
    ...childEnv, NODE_ENV: 'production', RESERVATIONS_API_ADMIN_URL: apiUrl, RESERVATIONS_API_URL: apiUrl, NEXT_TELEMETRY_DISABLED: '1',
  });
  await waitFor(`${apiUrl}/health`);
  await waitFor(`${webUrl}/closetadmin/login`);

  browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_BROWSER_CHANNEL ? { channel: process.env.PLAYWRIGHT_BROWSER_CHANNEL } : {}) });
  const context = await browser.newContext();
  await context.route('**/*', (route) => ['localhost', '127.0.0.1'].includes(new URL(route.request().url()).hostname) ? route.continue() : route.abort());
  await context.addCookies([{ name: 'closetadmin_session', value: token, url: webUrl, httpOnly: true, sameSite: 'Lax' }]);
  const page = await context.newPage();
  page.setDefaultTimeout(30_000);
  const detail = (label) => `${webUrl}/closetadmin/reservas/${fixtures[label].id}`;

  for (const [label, cancel, receive] of [['hold', false, false], ['online', false, true], ['cycle', true, true]]) {
    await page.goto(detail(label));
    assert.equal(await page.getByRole('button', { name: 'Cancelar reserva', exact: true }).count() > 0, cancel);
    assert.equal(await page.getByRole('button', { name: 'Registrar devolução', exact: true }).count() > 0, receive);
  }

  await page.goto(detail('cycle'));
  assert.equal(await availability(), 0);
  assert.equal(await calendarContains(token), true);
  await clickAction(page, 'Registrar devolução');
  await page.getByRole('button', { name: 'Iniciar higienização', exact: true }).waitFor();
  assert.equal(await status('cycle'), 'returned');
  assert.equal(await availability(), 0);
  assert.equal(await calendarContains(token), true);
  let response = await context.request.get(`${detail('cycle')}/pdf`);
  assert.equal(response.status(), 200);
  assert.match((await pdfParse(await response.body())).text, /Devolvida/);

  await clickAction(page, 'Iniciar higienização');
  await page.getByRole('button', { name: 'Concluir higienização', exact: true }).waitFor();
  assert.equal(await status('cycle'), 'cleaning');
  assert.equal(await availability(), 0);
  assert.equal(await calendarContains(token), true);

  await clickAction(page, 'Concluir higienização');
  await page.getByText('Concluída', { exact: true }).first().waitFor();
  assert.equal(await status('cycle'), 'completed');
  assert.equal(await availability(), 1);
  assert.equal(await calendarContains(token), false);
  response = await context.request.get(`${detail('cycle')}/pdf`);
  assert.match((await pdfParse(await response.body())).text, /Concluída/);
  assert.equal(await eventCount('cycle', 'RESERVATION_ITEM_RETURNED'), 1);
  assert.equal(await eventCount('cycle', 'RESERVATION_ITEM_CLEANING_STARTED'), 1);
  assert.equal(await eventCount('cycle', 'RESERVATION_ITEM_CLEANING_COMPLETED'), 1);

  for (const width of [390, 768, 1280]) {
    await page.setViewportSize({ width, height: 850 });
    await page.goto(detail('returnDouble'));
    assert.equal(await page.getByRole('button', { name: 'Registrar devolução', exact: true }).isVisible(), true);
  }
  let posts = 0;
  page.on('request', (request) => { if (request.method() === 'POST' && request.url().includes(fixtures.returnDouble.id)) posts++; });
  await clickAction(page, 'Registrar devolução', true);
  await page.getByRole('button', { name: 'Iniciar higienização', exact: true }).waitFor();
  assert.equal(posts, 1);
  assert.equal(await eventCount('returnDouble', 'RESERVATION_ITEM_RETURNED'), 1);

  await page.goto(detail('cancelDouble'));
  await clickAction(page, 'Cancelar reserva', true, 'Teste local de duplo clique');
  await page.getByText('Cancelada', { exact: true }).first().waitFor();
  assert.equal(await eventCount('cancelDouble', 'MANUAL_RESERVATION_CANCELLED'), 1);
  console.log('Navegador isolado: fluxo completo, estados, PDF, calendário, disponibilidade, responsividade e duplo clique passaram.');
} finally {
  await clean();
}
