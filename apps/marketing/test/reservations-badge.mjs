import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright';

/**
 * Contador de novas reservas no menu do ClosetAdmin, num navegador de verdade:
 * API e site locais isolados, reservas sintéticas gravadas direto no banco de
 * teste (já com pedido Shopify vinculado, como depois do webhook; nenhum HOLD,
 * checkout ou pedido é criado; nada fala com a Shopify). Roda na CI (Postgres
 * efêmero) ou localmente contra um banco listado em TEST_DATABASE_ALLOWED_HOSTS.
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
if (!localTestDb && !allowedTestHost) throw new Error('O teste do contador exige um banco de TESTE (local ou listado em TEST_DATABASE_ALLOWED_HOSTS).');
for (const key of ['SHOPIFY_STORE_DOMAIN', 'SHOPIFY_CLIENT_ID', 'SHOPIFY_CLIENT_SECRET', 'SHOPIFY_STOREFRONT_TOKEN']) {
  if (process.env[key]) throw new Error('Integrações externas configuradas; teste abortado.');
}

const apiUrl = 'http://127.0.0.1:3353';
const webUrl = 'http://127.0.0.1:3053';
const dashboard = `${webUrl}/closetadmin`;
const reservasUrl = `${webUrl}/closetadmin/reservas`;
const apiToken = randomBytes(32).toString('hex');
const prefix = `RBADGE-${Date.now()}`;
const db = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
const childProcesses = [];
const userIds = [];
const valePassOrderIds = [];
let counter = 0;
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
  const user = await db.adminUser.create({ data: { name, phone: `${Date.now()}${userIds.length}8`, pinHash: 'synthetic', role: 'STAFF', moduleAccess } });
  userIds.push(user.id);
  const token = generateSessionToken();
  await db.adminSession.create({ data: { adminUserId: user.id, tokenHash: hashSessionToken(token), expiresAt: new Date(Date.now() + 3_600_000) } });
  return token;
}

/** Reserva sintética (peça própria, retirada em 2031 para ficar no topo da lista). */
async function createReservation(status, { source = 'online', withOrder = true, customer } = {}) {
  counter++;
  const code = `${prefix}-u${counter}`;
  const unit = await db.rentalUnit.create({ data: { code, name: 'peça sintética', shopifyVariantId: `${code}-variant`, active: true, reservableOnline: true, countsTowardRentalDuration: true } });
  const day = String((counter % 27) + 1).padStart(2, '0');
  const pickup = `2031-0${(counter % 9) + 1}-${day}`;
  const rows = await db.$queryRaw`
    INSERT INTO reservations (id, status, source, origin_store_id, pickup_date, return_date, shopify_order_id, customer_name, customer_phone)
    VALUES (gen_random_uuid(), ${status}::"reservation_status", ${source}::"reservation_source", 'dev-store', ${pickup}::date, (${pickup}::date + 3),
      ${withOrder ? `${prefix}-order-${counter}` : null}, ${customer ?? `Cliente ${prefix} ${counter}`}, '+56 9 0000 0000')
    RETURNING id
  `;
  await db.$executeRaw`
    INSERT INTO reservation_items (id, reservation_id, rental_unit_id, status, blocked_range)
    VALUES (gen_random_uuid(), ${rows[0].id}::uuid, ${unit.id}::uuid, ${status}::"reservation_status", daterange(${pickup}::date - 3, ${pickup}::date + 6, '[)'))
  `;
  return rows[0].id;
}
const attentionInDb = () => db.$queryRaw`
  SELECT count(*)::int AS n FROM reservations WHERE source = 'online' AND shopify_order_id IS NOT NULL AND archived_at IS NULL
    AND status IN ('pending_payment','confirmed') AND viewed_status IS DISTINCT FROM status`.then((r) => r[0].n);
const reservationRow = (id) => db.reservation.findUniqueOrThrow({ where: { id } });

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
const badge = (page) => page.locator('aside:visible [data-testid="reservations-badge"]');
const reservasLink = (page) => page.locator('aside:visible a[href="/closetadmin/reservas"]');
async function settled(page) {
  await page.waitForLoadState('networkidle');
  await delay(700);
}
async function badgeText(page) {
  return (await badge(page).count()) === 0 ? null : (await badge(page).textContent()).trim();
}
const waitBadge = (page, expected, timeout = 45_000) =>
  page.waitForFunction((t) => {
    const el = document.querySelector('aside [data-testid="reservations-badge"]');
    return t === null ? !el : el?.textContent?.trim() === t;
  }, expected, { timeout });
const poke = (page) => page.evaluate(() => window.dispatchEvent(new Event('closetadmin:reservation-attention')));

async function clean() {
  for (const child of childProcesses) child.kill();
  await browser?.close();
  const rows = await db.$queryRaw`SELECT DISTINCT ri.reservation_id AS id FROM reservation_items ri JOIN rental_units ru ON ru.id = ri.rental_unit_id WHERE ru.code LIKE ${prefix + '%'}`;
  const ids = rows.map((r) => r.id);
  if (ids.length) {
    await db.$executeRaw`DELETE FROM reservation_events WHERE reservation_id = ANY(${ids}::uuid[])`;
    await db.$executeRaw`DELETE FROM reservation_items WHERE reservation_id = ANY(${ids}::uuid[])`;
    await db.$executeRaw`DELETE FROM reservations WHERE id = ANY(${ids}::uuid[])`;
  }
  await db.$executeRaw`DELETE FROM rental_units WHERE code LIKE ${prefix + '%'}`;
  if (valePassOrderIds.length) await db.valePassOrder.deleteMany({ where: { id: { in: valePassOrderIds } } });
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
  assert.equal(await attentionInDb(), 0, 'o banco de teste precisa começar sem reservas novas para ver');
  const staffToken = await createUser('Operador Reservas sintético', ['RESERVATIONS']);
  const otherToken = await createUser('Outra pessoa da equipe sintética', ['RESERVATIONS']);
  const vallePassOnlyToken = await createUser('Operador só Valle Pass sintético', ['VALLE_PASS']);

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
  const context = await newContext(staffToken, { viewport: { width: 1280, height: 900 } });
  const page = await newPage(context, errors);

  // Sem nada novo: sem badge.
  await page.goto(dashboard);
  await settled(page);
  assert.equal(await badgeText(page), null);

  // Futura pendente e futura paga (com pedido Shopify) contam; expirada, cancelada,
  // manual, HOLD, checkout sem pedido e Valle Pass não.
  const pendingId = await createReservation('pending_payment', { customer: 'Cliente Pendente' });
  const confirmedId = await createReservation('confirmed', { customer: 'Cliente Confirmada' });
  const expiredId = await createReservation('expired');
  const cancelledId = await createReservation('cancelled');
  await createReservation('confirmed', { source: 'manual_admin', withOrder: false });
  await createReservation('hold', { withOrder: false });
  await createReservation('pending_payment', { withOrder: false });
  const vp = await db.valePassOrder.create({ data: { shopifyOrderId: `${prefix}-vp`, status: 'PENDING', quantity: 1, lastSyncSource: 'test' } });
  valePassOrderIds.push(vp.id);
  const before = Object.fromEntries(await Promise.all([pendingId, confirmedId, expiredId, cancelledId].map(async (id) => [id, await reservationRow(id)])));

  await page.goto(dashboard);
  await badge(page).waitFor();
  assert.equal(await badgeText(page), '2');
  assert.match((await reservasLink(page).textContent()) ?? '', /2 reservas novas/);
  pass('pendente e paga da Shopify contam ("2", "2 reservas novas"); expirada, cancelada, manual, HOLD, checkout sem pedido e Valle Pass não');

  // Atualização automática do contador, sem recarregar (polling de 30 s).
  const thirdId = await createReservation('pending_payment', { customer: 'Cliente Terceira' });
  await waitBadge(page, '3');
  pass('reserva nova apareceu no contador sem recarregar a página (3)');

  // Duas abas: B abre Reservas e marca as novas como vistas; A (painel) zera sozinha.
  const tabB = await newPage(context, errors);
  await tabB.goto(reservasUrl);
  const row = (p, id) => p.locator(`tr[data-reservation-id="${id}"]`);
  await row(tabB, pendingId).waitFor();
  for (const id of [pendingId, confirmedId, thirdId]) assert.equal(await row(tabB, id).locator('[data-testid="reservation-new-tag"]').count(), 1, 'etiqueta "Nova"');
  for (const id of [expiredId, cancelledId]) assert.equal(await row(tabB, id).locator('[data-testid="reservation-new-tag"]').count(), 0);
  const cells = (await row(tabB, pendingId).locator('td').allInnerTexts()).map((t) => t.replace(/\s+/g, ' ').trim());
  assert.match(cells[1], /Cliente Pendente/);
  assert.match(cells[2], /online/i);
  assert.match(cells[3], /Aguardando pagamento.*Nova/i);
  assert.match(cells[4], /\/2031/);
  assert.match(cells[5], /\/2031/);
  assert.equal(cells[6], '1');
  await waitBadge(tabB, null, 15_000);
  await waitBadge(page, null, 15_000);
  assert.equal(await attentionInDb(), 0);
  pass('Reservas mostra cliente, origem, status, retirada, devolução e peças com etiqueta "Nova"; abrir marca como vistas; a outra aba zera sozinha');

  // Só visualização: status, datas, pedido, peças e updated_at intactos; um evento por reserva.
  for (const [id, prev] of Object.entries(before)) {
    const now = await reservationRow(id);
    for (const key of ['status', 'pickupDate', 'returnDate', 'shopifyOrderId', 'confirmedAt', 'updatedAt', 'checkoutState']) assert.deepEqual(now[key], prev[key], `${key} mudou`);
  }
  assert.equal((await reservationRow(pendingId)).viewedStatus, 'pending_payment');
  assert.equal((await reservationRow(confirmedId)).viewedBy, userIds[0]);
  assert.equal((await reservationRow(expiredId)).viewedStatus, null);
  pass('marcar como vista não muda status, datas, pedido nem updated_at; expirada/cancelada nem são tocadas');

  // Etiqueta "Nova" continua até sair da página; recarregar mantém a contagem (0).
  assert.equal(await row(tabB, pendingId).locator('[data-testid="reservation-new-tag"]').count(), 1);
  await page.reload();
  await settled(page);
  assert.equal(await badgeText(page), null);
  pass('recarregar mantém a contagem certa (estado no servidor); a etiqueta segue na tela aberta');

  // Página Reservas aberta: reserva nova aparece sozinha na tabela (sem recarregar) e é marcada como vista.
  const liveId = await createReservation('confirmed', { customer: 'Cliente Ao Vivo' });
  await row(tabB, liveId).waitFor({ timeout: 45_000 });
  await row(tabB, liveId).locator('[data-testid="reservation-new-tag"]').waitFor();
  for (let i = 0; i < 30 && (await reservationRow(liveId)).viewedStatus !== 'confirmed'; i++) await delay(500);
  assert.equal((await reservationRow(liveId)).viewedStatus, 'confirmed');
  pass('com Reservas aberta, a reserva nova entrou na tabela sem recarregar e foi marcada como vista');

  // Mudou de status depois de vista → volta a notificar; abrir o detalhe marca de novo.
  // Antes, o painel (já carregado) precisa estar de fato em 0 — senão o "1" da reserva
  // "ao vivo" do passo anterior passaria pela espera abaixo.
  assert.equal(await attentionInDb(), 0);
  await poke(page);
  await waitBadge(page, null, 15_000);
  await db.$executeRaw`UPDATE reservations SET status = 'confirmed' WHERE id = ${pendingId}::uuid`;
  await poke(page);
  await waitBadge(page, '1', 15_000);
  await tabB.close();
  await page.goto(`${reservasUrl}/${pendingId}`);
  await page.locator('[data-testid="reservation-new-tag"]').waitFor();
  // A marcação vem do servidor; só depois dela o menu (já carregado) pode zerar.
  for (let i = 0; i < 30 && (await reservationRow(pendingId)).viewedStatus !== 'confirmed'; i++) await delay(500);
  assert.equal((await reservationRow(pendingId)).viewedStatus, 'confirmed');
  await settled(page);
  await poke(page);
  await waitBadge(page, null, 15_000);
  pass('pendente paga depois de vista volta a contar (1); abrir o detalhe marca como vista de novo');

  // Expirar/cancelar uma já vista não gera alerta novo.
  await db.$executeRaw`UPDATE reservations SET status = 'expired' WHERE id = ${thirdId}::uuid`;
  await poke(page);
  await settled(page);
  assert.equal(await badgeText(page), null);
  pass('reserva vista que expira não gera alerta novo');

  // Duas pessoas abrindo Reservas ao mesmo tempo: uma marcação e um evento por reserva.
  const raceId = await createReservation('pending_payment', { customer: 'Cliente Corrida' });
  const ctxOther = await newContext(otherToken, { viewport: { width: 1280, height: 900 } });
  const [p1, p2] = await Promise.all([newPage(context, errors), newPage(ctxOther, errors)]);
  await Promise.all([p1.goto(reservasUrl), p2.goto(reservasUrl)]);
  await Promise.all([row(p1, raceId).waitFor(), row(p2, raceId).waitFor()]);
  for (let i = 0; i < 30 && (await reservationRow(raceId)).viewedStatus !== 'pending_payment'; i++) await delay(500);
  await delay(1500);
  assert.equal(await db.reservationEvent.count({ where: { reservationId: raceId, type: 'RESERVATION_VIEWED' } }), 1);
  assert.equal(await attentionInDb(), 0);
  await p1.close();
  await ctxOther.close();
  pass('duas pessoas/abas abrindo juntas: marcada uma vez, um único evento, contador 0');

  // Celular e tablet: ponto no botão do menu; badge à direita no menu aberto; sem rolagem lateral.
  await createReservation('confirmed', { customer: 'Cliente Celular' });
  for (const width of [390, 768]) {
    const ctx = await newContext(staffToken, { viewport: { width, height: 844 } });
    const p = await newPage(ctx, errors);
    await p.goto(dashboard);
    await p.locator('[data-testid="reservations-menu-dot"]').waitFor();
    assert.match((await p.getByRole('button', { name: /Abrir menu/ }).getAttribute('aria-label')) ?? '', /Reservas: 1 reserva nova/);
    await p.getByRole('button', { name: /Abrir menu/ }).click();
    await badge(p).waitFor();
    const b = await badge(p).boundingBox();
    const l = await reservasLink(p).boundingBox();
    assert.ok(b.x + b.width <= l.x + l.width && b.x > l.x + l.width / 2, `badge à direita no menu (${width}px)`);
    assert.ok(b.height <= 20 && b.y >= l.y && b.y + b.height <= l.y + l.height, 'badge dentro da altura da linha');
    assert.equal(await p.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth), 0);
    await ctx.close();
  }
  pass('celular (390px) e tablet (768px): ponto no menu, "Reservas: 1 reserva nova", badge à direita, sem rolagem lateral');

  // Sem o módulo RESERVATIONS: sem item, sem badge e sem ponto de reservas.
  const ctxVp = await newContext(vallePassOnlyToken, { viewport: { width: 1280, height: 900 } });
  const pVp = await newPage(ctxVp, errors);
  await pVp.goto(dashboard);
  await settled(pVp);
  assert.equal(await reservasLink(pVp).count(), 0);
  assert.equal(await pVp.locator('[data-testid="reservations-badge"], [data-testid="reservations-menu-dot"]').count(), 0);
  await ctxVp.close();
  pass('quem não tem o módulo de Reservas não vê item, badge nem ponto de reservas');

  assert.deepEqual(errors, []);
  assert.deepEqual(externalRequests, [], 'o navegador tentou acessar a internet (Shopify real?)');
  pass('nenhum erro no console nem erro de página');
  console.log(`Contador de reservas no navegador: ${results.length} verificações passaram.`);
} finally {
  await clean();
}
