import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright';

/**
 * Contador do Valle Pass no menu do ClosetAdmin, num navegador de verdade:
 * API e site locais isolados, pedidos sintéticos gravados direto no banco de
 * teste (nenhum vale, reserva ou HOLD é criado; nada fala com a Shopify).
 * Roda na CI (Postgres efêmero) ou localmente contra um banco de teste
 * listado em TEST_DATABASE_ALLOWED_HOSTS.
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

const apiUrl = 'http://127.0.0.1:3352';
const webUrl = 'http://127.0.0.1:3052';
const dashboard = `${webUrl}/closetadmin`;
const vallePass = `${webUrl}/closetadmin/valle-pass`;
const apiToken = randomBytes(32).toString('hex');
const prefix = `BADGE-${Date.now()}`;
const db = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
const childProcesses = [];
const userIds = [];
let orderCounter = 0;
let browser;

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

/** Pedido sintético direto no registro (sem webhook, sem vale). */
async function createOrder(status) {
  orderCounter++;
  return db.valePassOrder.create({ data: {
    shopifyOrderId: `${Date.now()}${orderCounter}`,
    shopifyOrderName: `${prefix}-${String(orderCounter).padStart(2, '0')}`,
    status,
    financialStatus: status === 'CONFIRMED' ? 'paid' : status === 'EXPIRED' ? 'expired' : 'pending',
    quantity: 1,
    orderCreatedAt: new Date(),
    lastSyncSource: 'test',
  } });
}

const attentionInDb = () => db.$queryRaw`SELECT count(*)::int AS n FROM vale_pass_orders WHERE status IN ('PENDING','CONFIRMED') AND (viewed_at IS NULL OR viewed_at < status_changed_at)`.then((r) => r[0].n);

async function newPage(context, errors) {
  const page = await context.newPage();
  page.setDefaultTimeout(30_000);
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });
  return page;
}
async function newContext(token, options = {}) {
  const context = await browser.newContext(options);
  await context.route('**/*', (route) => ['localhost', '127.0.0.1'].includes(new URL(route.request().url()).hostname) ? route.continue() : route.abort());
  await context.addCookies([{ name: 'closetadmin_session', value: token, url: webUrl, httpOnly: true, sameSite: 'Lax' }]);
  return context;
}

const badge = (page) => page.locator('aside:visible [data-testid="valle-pass-badge"]');
const valleLink = (page) => page.locator('aside:visible a[href="/closetadmin/valle-pass"]');
/** Espera a primeira pergunta do menu terminar (a página carregou e hidratou). */
async function settled(page) {
  await page.waitForLoadState('networkidle');
  await delay(700);
}
async function badgeText(page) {
  return (await badge(page).count()) === 0 ? null : (await badge(page).textContent()).trim();
}

async function clean() {
  for (const child of childProcesses) child.kill();
  await browser?.close();
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
  assert.equal(await attentionInDb(), 0, 'o banco de teste precisa começar sem pedidos de Valle Pass para ver');
  const staffToken = await createUser('Operador Valle Pass sintético', ['VALLE_PASS']);
  const noModuleToken = await createUser('Operador sem Valle Pass sintético', ['RESERVATIONS']);

  const childEnv = {
    ...process.env, DATABASE_URL: databaseUrl, ADMIN_API_TOKEN: apiToken, PICKUP_REMINDER_ENABLED: 'false',
    // Nada automático fala com a Shopify durante o teste.
    VALE_PASS_ORDER_SYNC_INTERVAL_MINUTES: '0', CATALOG_SYNC_INTERVAL_MINUTES: '0', SHOPIFY_CLIENT_ID: '', SHOPIFY_CLIENT_SECRET: '',
  };
  spawnLocal(process.execPath, [path.join(apiDir, 'dist/src/main.js')], apiDir, { ...childEnv, PORT: '3352', NODE_ENV: 'development' });
  spawnLocal(process.execPath, [path.join(marketingDir, 'node_modules/next/dist/bin/next'), 'start', '-p', '3052', '-H', '127.0.0.1'], marketingDir, {
    ...childEnv, NODE_ENV: 'production', RESERVATIONS_API_ADMIN_URL: apiUrl, RESERVATIONS_API_URL: apiUrl, NEXT_TELEMETRY_DISABLED: '1',
  });
  await waitFor(`${apiUrl}/health`);
  await waitFor(`${webUrl}/closetadmin/login`);
  browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_BROWSER_CHANNEL ? { channel: process.env.PLAYWRIGHT_BROWSER_CHANNEL } : {}) });

  const errors = [];
  const context = await newContext(staffToken, { viewport: { width: 1280, height: 900 } });
  const page = await newPage(context, errors);

  // 1 + 14) Vazio: sem badge; tela do Valle Pass com estado vazio.
  await page.goto(dashboard);
  await settled(page);
  assert.equal(await badgeText(page), null);
  await page.goto(vallePass);
  await page.getByText('Nenhum pedido de Valle Pass', { exact: true }).waitFor();
  await settled(page);
  assert.equal(await badgeText(page), null);
  pass('1/14) sem pedido para ver: badge oculto e estado vazio na tela do Valle Pass');

  // 2) Um pedido novo: badge "1", nome acessível do link inclui a contagem.
  await createOrder('PENDING');
  await page.goto(dashboard);
  await badge(page).waitFor();
  assert.equal(await badgeText(page), '1');
  assert.match(await valleLink(page).innerText(), /Valle Pass/);
  assert.match((await valleLink(page).textContent()) ?? '', /1 pedido para ver/);
  pass('2/4) pedido pendente conta: badge "1" e texto acessível "1 pedido para ver"');

  // 3, 5, 6) Vários: +1 pago, +1 pendente; expirado e cancelado não contam.
  await createOrder('CONFIRMED');
  await createOrder('PENDING');
  await createOrder('EXPIRED');
  await createOrder('CANCELLED');
  await page.goto(dashboard, { waitUntil: 'domcontentloaded' });
  const linksBefore = await page.locator('aside:visible nav a').evaluateAll((els) => els.map((el) => { const r = el.getBoundingClientRect(); return [r.top, r.height, r.width]; }));
  await badge(page).waitFor();
  assert.equal(await badgeText(page), '3');
  pass('3/5/6) vários pedidos: pago e pendentes somam 3; expirado e cancelado não contam');

  // 13) Sem layout shift: os itens do menu não se movem quando o badge aparece.
  const linksAfter = await page.locator('aside:visible nav a').evaluateAll((els) => els.map((el) => { const r = el.getBoundingClientRect(); return [r.top, r.height, r.width]; }));
  assert.deepEqual(linksAfter, linksBefore);
  const box = await badge(page).boundingBox();
  const link = await valleLink(page).boundingBox();
  assert.ok(box.x + box.width <= link.x + link.width - 8 && box.x + box.width >= link.x + link.width - 24, 'badge alinhado à direita do item');
  assert.ok(box.height <= 20 && box.y >= link.y && box.y + box.height <= link.y + link.height, 'badge dentro da altura da linha');
  const cls = await page.evaluate(() => new Promise((resolve) => {
    let total = 0;
    new PerformanceObserver((list) => { for (const e of list.getEntries()) if (!e.hadRecentInput) total += e.value; }).observe({ type: 'layout-shift', buffered: true });
    setTimeout(() => resolve(total), 300);
  }));
  assert.ok(cls < 0.01, `layout shift acumulado ${cls}`);
  pass(`13) sem layout shift (itens do menu parados; CLS ${cls.toFixed(4)}); badge à direita, na altura da linha`);

  // 10) Atualização automática: pedido novo aparece sem recarregar (polling de 30 s).
  await createOrder('PENDING');
  await page.waitForFunction(() => document.querySelector('aside [data-testid="valle-pass-badge"]')?.textContent?.trim() === '4', null, { timeout: 45_000 });
  pass('10) pedido novo apareceu no badge sem recarregar a página (4)');

  // Teclado: Tab chega ao item, anel de foco visível, Enter abre a página.
  await page.goto(dashboard);
  await badge(page).waitFor();
  let focused = false;
  for (let i = 0; i < 25 && !focused; i++) {
    await page.keyboard.press('Tab');
    focused = await page.evaluate(() => document.activeElement?.getAttribute('href') === '/closetadmin/valle-pass' && !!document.activeElement.closest('aside'));
  }
  assert.ok(focused, 'o item Valle Pass recebe foco pelo teclado');
  const ring = await page.evaluate(() => getComputedStyle(document.activeElement).boxShadow);
  assert.notEqual(ring, 'none');

  // 11 + 9) Duas abas: a aba B abre o Valle Pass pelo teclado e marca como visto;
  // a aba A (outra página) acompanha sozinha.
  const tabA = await newPage(context, errors);
  await tabA.goto(dashboard);
  await badge(tabA).waitFor();
  assert.equal(await badgeText(tabA), '4');
  await page.keyboard.press('Enter');
  await page.waitForURL(vallePass);
  await page.locator('article[data-new="true"]').first().waitFor();
  assert.equal(await page.locator('article[data-new="true"]').count(), 4);
  await page.waitForFunction(() => !document.querySelector('aside [data-testid="valle-pass-badge"]'), null, { timeout: 15_000 });
  await tabA.waitForFunction(() => !document.querySelector('aside [data-testid="valle-pass-badge"]'), null, { timeout: 15_000 });
  const rows = await db.valePassOrder.findMany({ where: { shopifyOrderName: { startsWith: prefix } } });
  assert.equal(rows.filter((r) => r.viewedAt).length, 4);
  assert.ok(rows.every((r) => r.viewedAt === null || r.viewedBy === userIds[0]));
  assert.deepEqual(rows.map((r) => r.status).sort(), ['CANCELLED', 'CONFIRMED', 'EXPIRED', 'PENDING', 'PENDING', 'PENDING']);
  assert.equal(await db.valePass.count({ where: { shopifyOrderId: { in: rows.map((r) => r.shopifyOrderId) } } }), 0);
  assert.equal(await attentionInDb(), 0);
  pass('9/11) abrir o Valle Pass (via teclado) marca os 4 como vistos, sem mudar status nem criar vale; a outra aba zera sozinha');

  // Recarregar e nova sessão continuam corretos (estado no servidor).
  await tabA.reload();
  await settled(tabA);
  assert.equal(await badgeText(tabA), null);
  pass('recarregar a página mantém a contagem correta (0)');

  // Destaque discreto só com movimento permitido (prefers-reduced-motion).
  for (const [reducedMotion, expected] of [['no-preference', 'pulse'], ['reduce', 'none']]) {
    const ctx = await newContext(staffToken, { viewport: { width: 1280, height: 900 }, reducedMotion });
    const p = await newPage(ctx, errors);
    await createOrder('PENDING');
    await p.goto(dashboard);
    await badge(p).waitFor();
    const before = Number(await badgeText(p));
    await createOrder('PENDING');
    await p.evaluate(() => window.dispatchEvent(new Event('closetadmin:valle-pass-attention')));
    await p.waitForFunction((n) => document.querySelector('aside [data-testid="valle-pass-badge"]')?.textContent?.trim() === String(n), before + 1);
    assert.equal(await badge(p).evaluate((el) => getComputedStyle(el).animationName), expected);
    await ctx.close();
  }
  pass('pedido novo pulsa de leve; com prefers-reduced-motion: reduce, sem animação');

  // 15) Falha: mantém o último número esmaecido; volta ao normal quando a rede volta.
  const failing = await newPage(context, []);
  await failing.goto(dashboard);
  await badge(failing).waitFor();
  const shown = await badgeText(failing);
  await failing.route('**/closetadmin**', (route) => (route.request().method() === 'POST' && route.request().headers()['next-action'] ? route.abort() : route.continue()));
  await failing.evaluate(() => window.dispatchEvent(new Event('closetadmin:valle-pass-attention')));
  await failing.waitForFunction(() => document.querySelector('aside [data-testid="valle-pass-badge"]')?.getAttribute('title'), null, { timeout: 15_000 });
  assert.equal(await badgeText(failing), shown);
  assert.equal(await badge(failing).evaluate((el) => getComputedStyle(el).opacity), '0.6');
  await failing.unroute('**/closetadmin**');
  await failing.evaluate(() => window.dispatchEvent(new Event('closetadmin:valle-pass-attention')));
  await failing.waitForFunction(() => !document.querySelector('aside [data-testid="valle-pass-badge"]')?.getAttribute('title'), null, { timeout: 15_000 });
  await failing.close();
  pass(`15) falha na atualização: mantém "${shown}" esmaecido; recupera sozinho`);

  // Celular e tablet: ponto no botão do menu; badge dentro do menu aberto; sem rolagem lateral.
  for (const width of [390, 768]) {
    const ctx = await newContext(staffToken, { viewport: { width, height: 844 } });
    const p = await newPage(ctx, errors);
    await p.goto(dashboard);
    await p.locator('[data-testid="valle-pass-menu-dot"]').waitFor();
    assert.match((await p.getByRole('button', { name: /Abrir menu/ }).getAttribute('aria-label')) ?? '', /pedidos? para ver/);
    await p.getByRole('button', { name: /Abrir menu/ }).click();
    await badge(p).waitFor();
    const b = await badge(p).boundingBox();
    const l = await valleLink(p).boundingBox();
    assert.ok(b.x + b.width <= l.x + l.width && b.x > l.x + l.width / 2, `badge à direita no menu (${width}px)`);
    assert.equal(await p.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth), 0);
    await ctx.close();
  }
  pass('celular (390px) e tablet (768px): ponto no botão do menu, badge à direita no menu aberto, sem rolagem lateral');

  // 12) Sem permissão: sem item, sem badge e nenhuma consulta ao contador.
  const noModuleErrors = [];
  const ctxNo = await newContext(noModuleToken, { viewport: { width: 1280, height: 900 } });
  const pNo = await newPage(ctxNo, noModuleErrors);
  let actionPosts = 0;
  pNo.on('request', (r) => { if (r.method() === 'POST' && r.headers()['next-action']) actionPosts++; });
  await pNo.goto(dashboard);
  await settled(pNo);
  await delay(2000);
  assert.equal(await valleLink(pNo).count(), 0);
  assert.equal(await pNo.locator('[data-testid="valle-pass-badge"], [data-testid="valle-pass-menu-dot"]').count(), 0);
  assert.equal(actionPosts, 0);
  assert.deepEqual(noModuleErrors, []);
  await ctxNo.close();
  pass('12) sem o módulo VALLE_PASS: sem item, sem badge, nenhuma consulta ao contador');

  // 13) Nenhum erro no console em todo o fluxo (fora a falha simulada de propósito).
  assert.deepEqual(errors, []);
  pass('13) nenhum erro no console nem erro de página');

  console.log(`Contador do Valle Pass no navegador: ${results.length} verificações passaram.`);
} finally {
  await clean();
}
