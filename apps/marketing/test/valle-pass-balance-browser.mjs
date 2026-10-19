import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright';

/**
 * Saldo e resgate parcial do Valle Pass no ClosetAdmin, num navegador de verdade: API e site locais isolados, vouchers sintéticos gravados direto no banco de
 * teste (nenhuma Shopify, nenhum e-mail, nenhum pagamento). Cobre consulta, resgates parciais (R$ 500 → 200 → 100; R$ 50 → 20), erros, duplo clique,
 * reversão, STAFF somente consulta, celular e ausência de tráfego externo.
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
if (!localTestDb && !allowedTestHost) throw new Error('O teste de saldo exige um banco de TESTE (local ou listado em TEST_DATABASE_ALLOWED_HOSTS).');
for (const key of ['SHOPIFY_STORE_DOMAIN', 'SHOPIFY_CLIENT_ID', 'SHOPIFY_CLIENT_SECRET', 'SHOPIFY_STOREFRONT_TOKEN']) {
  if (process.env[key]) throw new Error('Integrações externas configuradas; teste abortado.');
}

const apiUrl = 'http://127.0.0.1:3356';
const webUrl = 'http://127.0.0.1:3056';
const vallePass = `${webUrl}/closetadmin/valle-pass`;
const apiToken = randomBytes(32).toString('hex');
const prefix = `SALDO-${Date.now()}`;
const shotDir = process.env.BALANCE_SHOT_DIR;
const db = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
const childProcesses = [];
const userIds = [];
let browser;
let campaignId = null;
const orderId = `${prefix}-order`;
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
  const user = await db.adminUser.create({ data: { name, phone: `${Date.now()}${userIds.length}5`, pinHash: 'synthetic', role, moduleAccess: ['VALLE_PASS'] } });
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
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });
  return page;
}

async function clean() {
  for (const child of childProcesses) child.kill();
  await browser?.close();
  if (campaignId) {
    const passes = await db.valePass.findMany({ where: { campaignId }, select: { id: true } });
    await db.$transaction(async (tx) => {
      await tx.$executeRawUnsafe('SET LOCAL session_replication_role = replica');
      await tx.$executeRaw`DELETE FROM vale_pass_ledger_entries WHERE vale_pass_id = ANY(${passes.map((p) => p.id)}::uuid[])`;
    });
    await db.adminAuditEvent.deleteMany({ where: { entityId: { in: passes.map((p) => p.id) } } });
    await db.valePassEvent.deleteMany({ where: { valePassId: { in: passes.map((p) => p.id) } } });
    await db.valePass.deleteMany({ where: { campaignId } });
    await db.valePassCampaignBenefit.deleteMany({ where: { campaignId } });
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
const entriesOf = (code) => db.valePassLedgerEntry.findMany({ where: { valePass: { code } }, orderBy: { seq: 'asc' } });
const shot = async (page, name) => { if (shotDir) { mkdirSync(shotDir, { recursive: true }); await page.screenshot({ path: path.join(shotDir, `${name}.png`), fullPage: true }); } };

async function consult(page, code) {
  await page.getByLabel('Código do voucher').fill(code);
  await page.getByRole('button', { name: 'Consultar' }).click();
}
const metric = (page, label) => page.locator('dt', { hasText: label }).locator('xpath=following-sibling::dd[1]');

try {
  const admin = await createUser(`Admin Saldo sintético ${prefix}`, 'ADMIN');
  const staff = await createUser(`Operador Saldo sintético ${prefix}`, 'STAFF');

  // ── vouchers sintéticos (uma unidade: R$ 500 Valle Showroom + R$ 50 VS BY CLOSET) ──
  const campaign = await db.valePassCampaign.create({
    data: { name: `${prefix} Valle Pass`, amountCents: 35_000, validityDays: 30, shopifyVariantId: `${prefix}-var`, voucherValidFrom: new Date('2026-01-01'), voucherValidUntil: new Date('2027-09-30') },
  });
  campaignId = campaign.id;
  const [b1, b2] = await Promise.all([
    db.valePassCampaignBenefit.create({ data: { campaignId, code: 'valle_showroom_500', kind: 'VOUCHER', company: 'VALLE_SHOWROOM', label: 'Voucher Valle Showroom', amountCents: 50_000, sortOrder: 0 } }),
    db.valePassCampaignBenefit.create({ data: { campaignId, code: 'vs_by_closet_50', kind: 'VOUCHER', company: 'VS_BY_CLOSET', label: 'Voucher VS BY CLOSET', amountCents: 5_000, sortOrder: 1 } }),
  ]);
  const groupId = randomUUID();
  const common = { campaignId, groupId, shopifyOrderId: orderId, shopifyOrderName: '#T-SALDO', status: 'ACTIVE', purchasedAt: new Date(), expiresAt: new Date('2027-10-01T03:00:00Z'), validFrom: new Date('2026-01-01T03:00:00Z'), customerName: 'Maria da Silva Souza', customerPhone: '+55 11 91234-5678', customerEmail: 'maria.souza@exemplo.invalid' };
  const A = `VALLE-S${Date.now().toString(36).toUpperCase().slice(-3)}-AAAA`;
  const B = `VALLE-S${Date.now().toString(36).toUpperCase().slice(-3)}-BBBB`;
  await db.valePass.create({ data: { ...common, code: A, amountCents: 50_000, company: 'VALLE_SHOWROOM', benefitId: b1.id } });
  await db.valePass.create({ data: { ...common, code: B, amountCents: 5_000, company: 'VS_BY_CLOSET', benefitId: b2.id } });

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
  const errors = [];

  // 1) STAFF: só consulta, dados mascarados, sem formulário de resgate (nada decorativo).
  {
    const context = await newContext(staff.token, { viewport: { width: 1280, height: 900 } });
    const page = await newPage(context, errors);
    await page.goto(vallePass);
    await page.getByLabel('Código do voucher').waitFor();
    await consult(page, A);
    await metric(page, 'Saldo disponível').getByText('R$ 500,00').waitFor();
    await page.getByText('exigem um administrador').waitFor();
    assert.equal(await page.getByLabel('Valor a utilizar (R$)').count(), 0);
    const text = await page.locator('section[aria-labelledby="balance-desk-title"]').innerText();
    assert.ok(text.includes('Maria S.') && !/maria\.souza|91234-5678|Silva/.test(text), 'dados pessoais mascarados no balcão');
    pass('1) STAFF consulta: saldo R$ 500,00, titular mascarado, sem formulário de resgate (explícito)');
    await context.close();
  }

  // 2) ADMIN: resgates parciais 500 → 200 → 300 → 100 → 200; empresas separadas.
  const context = await newContext(admin.token, { viewport: { width: 1280, height: 900 } });
  const page = await newPage(context, errors);
  await page.goto(vallePass);
  await page.getByLabel('Código do voucher').waitFor();
  await consult(page, A);
  await metric(page, 'Valor inicial').getByText('R$ 500,00').waitFor();
  assert.equal((await metric(page, 'Saldo disponível').innerText()).trim(), 'R$ 500,00');
  await page.getByLabel('Valor a utilizar (R$)').fill('200');
  await page.getByLabel('Referência da utilização').fill('Nota 123');
  await page.getByRole('button', { name: 'Conferir' }).click();
  await page.getByText('Saldo antes').waitFor();
  const confirm = page.getByRole('button', { name: 'Confirmar resgate' });
  assert.equal(await confirm.isDisabled(), true, 'confirmar fica desabilitado até digitar o valor de novo');
  await page.getByLabel(/Digite novamente o valor/).fill('150');
  assert.equal(await confirm.isDisabled(), true, 'valor diferente não habilita');
  await page.getByLabel(/Digite novamente o valor/).fill('200');
  await confirm.dblclick(); // duplo clique: só UM resgate
  await page.getByText('Resgate de R$ 200,00 registrado. Saldo disponível: R$ 300,00.').waitFor();
  assert.equal((await metric(page, 'Saldo disponível').innerText()).trim(), 'R$ 300,00');
  assert.equal((await metric(page, 'Utilizado').innerText()).trim(), 'R$ 200,00');
  assert.equal((await entriesOf(A)).length, 1, 'duplo clique não duplica o lançamento');
  await shot(page, '1-apos-resgate-200');
  pass('2) R$ 500 − R$ 200 = R$ 300 (confirmação exige redigitar o valor; duplo clique gravou UM lançamento)');

  await page.getByLabel('Valor a utilizar (R$)').fill('100');
  await page.getByLabel('Referência da utilização').fill('Nota 124');
  await page.getByRole('button', { name: 'Conferir' }).click();
  await page.getByLabel(/Digite novamente o valor/).fill('100,00');
  await page.getByRole('button', { name: 'Confirmar resgate' }).click();
  await page.getByText('Saldo disponível: R$ 200,00.').waitFor();
  assert.equal((await metric(page, 'Saldo disponível').innerText()).trim(), 'R$ 200,00');
  await page.getByText('Ref.: Nota 124').waitFor();
  assert.equal(await page.locator('li:has-text("Resgate")').count() >= 2, true);
  const ledger = await entriesOf(A);
  assert.deepEqual(ledger.map((e) => [e.seq, e.deltaCents, e.balanceAfterCents]), [[1, -20_000, 30_000], [2, -10_000, 20_000]]);
  pass('3) novo resgate de R$ 100 → saldo R$ 200; histórico com valor, saldo resultante, referência e operador');

  // 3) Outra empresa: R$ 50 − R$ 20 = R$ 30, sem tocar no saldo da Valle Showroom.
  await consult(page, B);
  await page.getByText('VS BY CLOSET').first().waitFor();
  await metric(page, 'Saldo disponível').getByText('R$ 50,00').waitFor();
  await page.getByLabel('Valor a utilizar (R$)').fill('20');
  await page.getByLabel('Referência da utilização').fill('Comanda 7');
  await page.getByRole('button', { name: 'Conferir' }).click();
  await page.getByLabel(/Digite novamente o valor/).fill('20');
  await page.getByRole('button', { name: 'Confirmar resgate' }).click();
  await page.getByText('Saldo disponível: R$ 30,00.').waitFor();
  assert.equal((await db.valePass.findUniqueOrThrow({ where: { code: A } })).balanceCents, 20_000);
  assert.equal((await db.valePass.findUniqueOrThrow({ where: { code: B } })).balanceCents, 3_000);
  pass('4) VS BY CLOSET: R$ 50 − R$ 20 = R$ 30; saldo da Valle Showroom intacto (R$ 200)');

  // 4) Erros: acima do saldo, valor inválido, código inexistente.
  await consult(page, A);
  await metric(page, 'Saldo disponível').getByText('R$ 200,00').waitFor();
  await page.getByLabel('Valor a utilizar (R$)').fill('300');
  await page.getByLabel('Referência da utilização').fill('Nota 125');
  await page.getByRole('button', { name: 'Conferir' }).click();
  await page.getByText(/Saldo insuficiente/).waitFor();
  assert.equal(await page.getByText('Saldo antes').count(), 0, 'sem prévia quando o saldo não basta');
  await page.getByLabel('Valor a utilizar (R$)').fill('200.50');
  await page.getByRole('button', { name: 'Conferir' }).click();
  await page.getByText(/Informe um valor válido em reais/).waitFor();
  await page.getByLabel('Valor a utilizar (R$)').fill('0');
  await page.getByRole('button', { name: 'Conferir' }).click();
  await page.getByText(/Informe um valor válido em reais/).waitFor();
  await consult(page, 'VALLE-ZZZZ-ZZZZ');
  await page.getByText('Voucher não encontrado.').waitFor();
  assert.equal(await page.locator('section[aria-labelledby="balance-desk-title"]').getByText('Saldo disponível').count(), 0, 'nenhum dado do voucher anterior fica no balcão');
  assert.equal((await entriesOf(A)).length, 2);
  pass('5) acima do saldo, valor inválido (200.50, 0) e código inexistente: mensagens claras, nada gravado');

  // 5) Reversão auditada.
  await consult(page, A);
  await metric(page, 'Saldo disponível').getByText('R$ 200,00').waitFor();
  await page.getByRole('button', { name: 'Reverter este resgate' }).last().click(); // o mais antigo (#1, R$ 200)
  await page.getByLabel(/Justificativa/).waitFor();
  await page.getByLabel(/Justificativa/).fill('Lançado por engano na nota 123');
  await page.getByLabel(/Digite novamente o valor/).fill('200');
  await page.getByRole('button', { name: 'Confirmar reversão' }).click();
  await page.getByText('Reversão registrada. Saldo disponível: R$ 400,00.').waitFor();
  await page.getByText('Revertido').first().waitFor();
  const after = await entriesOf(A);
  assert.deepEqual(after.map((e) => [e.kind, e.deltaCents, e.balanceAfterCents]), [['REDEEM', -20_000, 30_000], ['REDEEM', -10_000, 20_000], ['REVERSAL', 20_000, 40_000]]);
  assert.equal(after[2].reversesEntryId, after[0].id);
  assert.equal(await page.getByRole('button', { name: 'Reverter este resgate' }).count(), 1, 'o resgate já revertido não oferece nova reversão');
  pass('6) reversão: justificativa + valor redigitado; saldo R$ 400,00; histórico preservado; não reverte duas vezes');

  // 6) Celular: sem rolagem horizontal; resgate e histórico legíveis.
  const mobile = await newContext(admin.token, { viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true });
  const mp = await newPage(mobile, errors);
  await mp.goto(vallePass);
  await mp.getByLabel('Código do voucher').waitFor();
  await consult(mp, A);
  await metric(mp, 'Saldo disponível').getByText('R$ 400,00').waitFor();
  const overflow = await mp.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  assert.ok(overflow <= 1, `sem rolagem horizontal no celular (excesso ${overflow}px)`);
  await shot(mp, '2-celular');
  pass('7) celular (375 px): sem rolagem horizontal, saldo e histórico visíveis');
  await mobile.close();

  assert.deepEqual(errors, [], `erros no navegador: ${errors.join(' | ')}`);
  assert.deepEqual([...new Set(externalRequests)], [], 'nenhuma requisição saiu do computador');
  pass('8) nenhum erro de console e nenhum tráfego externo');
  console.log(`\n${results.length} verificações OK`);
} finally {
  await clean();
}
