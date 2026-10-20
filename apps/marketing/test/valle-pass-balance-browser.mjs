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
      await tx.$executeRaw`DELETE FROM vale_pass_block_events WHERE vale_pass_id = ANY(${passes.map((p) => p.id)}::uuid[])`;
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

  // 5b) Bloqueio administrativo: justificativa + código redigitado; bloqueia o resgate sem mexer em saldo/status; STAFF não vê a ação nem o motivo; desbloqueio.
  await consult(page, A);
  await metric(page, 'Saldo disponível').getByText('R$ 400,00').waitFor();
  await page.getByRole('button', { name: 'Bloquear voucher…' }).click();
  const blockBtn = page.getByRole('button', { name: 'Confirmar bloqueio' });
  await blockBtn.waitFor();
  assert.equal(await blockBtn.isDisabled(), true, 'bloquear exige justificativa e o código redigitado');
  await page.getByLabel(/Justificativa \(mínimo 10/).first().fill('Suspeita de fraude: conferir com a loja');
  await page.getByLabel(/Digite novamente o código do voucher/).fill('VALLE-ERRADO-0000');
  assert.equal(await blockBtn.isDisabled(), true, 'código diferente não habilita');
  await page.getByLabel(/Digite novamente o código do voucher/).fill(A);
  await blockBtn.dblclick(); // duplo clique: um único evento
  await page.getByText(/Voucher bloqueado\. O saldo e o status não mudaram/).waitFor();
  await page.getByText('Voucher bloqueado', { exact: true }).waitFor();
  assert.equal(await page.getByLabel('Valor a utilizar (R$)').count(), 0, 'sem formulário de resgate enquanto bloqueado');
  const blockedRow = await db.valePass.findUniqueOrThrow({ where: { code: A } });
  assert.equal(blockedRow.balanceCents, 40_000);
  assert.equal(blockedRow.status, 'ACTIVE');
  assert.ok(blockedRow.blockedAt);
  assert.equal(await db.valePassBlockEvent.count({ where: { valePass: { code: A } } }), 1, 'duplo clique gravou UM evento');
  await page.getByText(/Motivo: Suspeita de fraude/).first().waitFor();
  const staffCtx = await newContext(staff.token, { viewport: { width: 1280, height: 900 } });
  const staffPage = await newPage(staffCtx, errors);
  await staffPage.goto(vallePass);
  await staffPage.getByLabel('Código do voucher').waitFor();
  await consult(staffPage, A);
  await staffPage.getByText('Voucher bloqueado', { exact: true }).waitFor();
  const staffDesk = await staffPage.locator('section[aria-labelledby="balance-desk-title"]').innerText();
  assert.ok(!/Suspeita de fraude/.test(staffDesk), 'a justificativa do bloqueio não aparece para STAFF');
  assert.equal(await staffPage.getByRole('button', { name: /Desbloquear voucher/ }).count(), 0, 'STAFF não vê a ação de desbloqueio');
  await staffCtx.close();
  await page.getByRole('button', { name: 'Desbloquear voucher…' }).click();
  await page.getByLabel(/Justificativa \(mínimo 10/).first().fill('Conferido com a loja e liberado');
  await page.getByLabel(/Digite novamente o código do voucher/).fill(A);
  await page.getByRole('button', { name: 'Confirmar desbloqueio' }).click();
  await page.getByText(/Voucher desbloqueado\. O saldo e o status não mudaram/).waitFor();
  await page.getByLabel('Valor a utilizar (R$)').waitFor();
  const freed = await db.valePass.findUniqueOrThrow({ where: { code: A } });
  assert.equal(freed.blockedAt, null);
  assert.equal(freed.balanceCents, 40_000);
  assert.deepEqual((await db.valePassBlockEvent.findMany({ where: { valePass: { code: A } }, orderBy: { seq: 'asc' } })).map((e) => e.kind), ['BLOCK', 'UNBLOCK']);
  pass('6b) bloqueio e desbloqueio: justificativa + código redigitado, duplo clique = 1 evento, saldo e status intactos, STAFF sem ação nem motivo');

  // 6c) Operador RESTRITO (ADMIN vinculado só à VS BY CLOSET): na Valle Showroom não há formulário nem botão de reversão e a mensagem de permissão aparece;
  // na VS BY CLOSET opera normalmente; pela API direta (mesmos guards reais) o resgate/reversão/"usado" cruzados dão 403 e nada é gravado.
  {
    const restricted = await createUser(`Operador restrito sintético ${prefix}`, 'ADMIN');
    await db.valePassOperatorScope.create({ data: { adminUserId: restricted.id, company: 'VS_BY_CLOSET', grantedByName: 'teste sintético' } });
    const ctx = await newContext(restricted.token, { viewport: { width: 1280, height: 900 } });
    const rp = await newPage(ctx, errors);
    await rp.goto(vallePass);
    await rp.getByLabel('Código do voucher').waitFor();
    await consult(rp, A);
    await metric(rp, 'Saldo disponível').getByText('R$ 400,00').waitFor();
    await rp.getByText(/não está autorizado a resgatar vouchers da Valle Showroom/).waitFor();
    assert.equal(await rp.getByLabel('Valor a utilizar (R$)').count(), 0, 'sem formulário de resgate na loja não autorizada');
    assert.equal(await rp.getByRole('button', { name: /Reverter este resgate/ }).count(), 0, 'sem botão de reversão na loja não autorizada');
    await shot(rp, '3-operador-restrito');
    await consult(rp, B);
    await metric(rp, 'Saldo disponível').getByText('R$ 30,00').waitFor();
    await rp.getByLabel('Valor a utilizar (R$)').waitFor(); // na loja autorizada o formulário aparece
    assert.equal(await rp.getByText(/não está autorizado a resgatar vouchers/).count(), 0);
    await ctx.close();

    // API direta, com os guards reais (bearer do ClosetAdmin + sessão do operador restrito)
    const call = (method, url, body) => fetch(`${apiUrl}${url}`, { method, headers: { Authorization: `Bearer ${apiToken}`, 'X-Admin-Session': restricted.token, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    const before = await entriesOf(A);
    const cross = await call('POST', `/admin/vale-pass/vouchers/${A}/redeem`, { company: 'VALLE_SHOWROOM', amountCents: 100, reference: 'tentativa cruzada', operationId: `cross-${Date.now()}`, expectedBalanceCents: 40_000, confirmAmountCents: 100 });
    assert.equal(cross.status, 403, 'resgate cruzado pela API direta é recusado');
    assert.equal((await cross.json()).code, 'COMPANY_NOT_AUTHORIZED');
    assert.equal((await call('POST', `/admin/vale-pass/vouchers/${A}/redeem/prepare`, { company: 'VALLE_SHOWROOM', amountCents: 100, reference: 'tentativa cruzada' })).status, 403);
    const someEntry = before[0];
    assert.equal((await call('POST', `/admin/vale-pass/vouchers/${A}/ledger/${someEntry.id}/reverse/prepare`, {})).status, 403, 'reversão cruzada recusada');
    assert.equal((await call('POST', `/admin/vale-pass/vouchers/${A}/use`)).status, 403, 'endpoint legado "usado" não é atalho entre lojas');
    assert.equal((await call('POST', `/admin/vale-pass/operators/${restricted.id}/companies/VALLE_SHOWROOM/grant`, {})).status, 403, 'operador não concede vínculo a si mesmo');
    assert.equal((await call('GET', '/admin/vale-pass/operators')).status, 403, 'a visão de vínculos é só do proprietário');
    assert.equal((await call('POST', `/admin/vale-pass/vouchers/${B}/redeem/prepare`, { company: 'VS_BY_CLOSET', amountCents: 100, reference: 'conferência' })).status, 200, 'na loja autorizada a prévia funciona');
    assert.equal((await entriesOf(A)).length, before.length, 'nenhum lançamento cruzado foi gravado');
    assert.equal((await db.valePass.findUniqueOrThrow({ where: { code: A } })).balanceCents, 40_000);
    pass('6c) operador restrito: sem formulário/reversão e com mensagem na loja não autorizada; opera a sua; API direta (resgate, prévia, reversão, "usado", vínculo) cruzada = 403 e nada gravado');
  }

  // 6d) Proprietário gerencia vínculos pela tela: concede, vê o resultado, revoga; confirmação obrigatória; a API grava a auditoria crítica.
  {
    const target = await createUser(`Operador vinculável sintético ${prefix}`, 'ADMIN');
    const owner = await createUser(`Proprietário sintético ${prefix}`, 'SUPER_ADMIN');
    const ctx = await newContext(owner.token, { viewport: { width: 1280, height: 900 } });
    const op = await newPage(ctx, errors);
    await op.goto(vallePass);
    await op.getByRole('button', { name: /Quem opera cada estabelecimento/ }).click();
    const row = op.locator('[data-testid="operator-row"]', { hasText: `Operador vinculável sintético ${prefix}` });
    await row.waitFor();
    await row.getByText('Sem vínculo: acesso legado às duas lojas.').waitFor();
    await row.getByRole('button', { name: /Valle Showroom: sem vínculo/ }).click();
    await row.getByRole('alertdialog').waitFor();
    assert.equal(await db.valePassOperatorScope.count({ where: { adminUserId: target.id } }), 0, 'nada é gravado antes da confirmação');
    await row.getByRole('button', { name: 'Confirmar' }).dblclick(); // duplo clique: um só vínculo
    await row.getByRole('button', { name: /Valle Showroom: autorizado/ }).waitFor();
    await row.getByText('Restrito às lojas marcadas.').waitFor();
    assert.equal(await db.valePassOperatorScope.count({ where: { adminUserId: target.id, company: 'VALLE_SHOWROOM', revokedAt: null } }), 1);
    const audit = await db.adminAuditEvent.findFirst({ where: { action: 'VALE_PASS_OPERATOR_SCOPE_GRANTED', entityId: target.id } });
    assert.ok(audit && audit.isCritical, 'auditoria crítica da concessão');
    await row.getByRole('button', { name: /Valle Showroom: autorizado/ }).click();
    await row.getByRole('button', { name: 'Cancelar' }).click(); // cancelar não revoga
    assert.equal(await db.valePassOperatorScope.count({ where: { adminUserId: target.id, revokedAt: null } }), 1);
    await row.getByRole('button', { name: /Valle Showroom: autorizado/ }).click();
    await row.getByRole('button', { name: 'Confirmar' }).click();
    await row.getByRole('button', { name: /Valle Showroom: sem vínculo/ }).waitFor();
    assert.equal(await db.valePassOperatorScope.count({ where: { adminUserId: target.id, revokedAt: null } }), 0);
    assert.equal(await db.valePassOperatorScope.count({ where: { adminUserId: target.id } }), 1, 'o histórico da revogação é preservado');
    await shot(op, '4-proprietario-vinculos');
    await ctx.close();
    // administrador e funcionário não veem o painel
    const adminCtx = await newContext(admin.token, { viewport: { width: 1280, height: 900 } });
    const ap = await newPage(adminCtx, errors);
    await ap.goto(vallePass);
    await ap.getByLabel('Código do voucher').waitFor();
    assert.equal(await ap.getByRole('button', { name: /Quem opera cada estabelecimento/ }).count(), 0, 'só o proprietário vê a gestão de vínculos');
    await adminCtx.close();
    pass('6d) proprietário: concede e revoga vínculo pela tela (confirmação, duplo clique, histórico, auditoria crítica); administrador não vê o painel');
  }

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
