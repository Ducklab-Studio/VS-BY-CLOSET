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
      await tx.$executeRaw`DELETE FROM vale_pass_cancellation_alerts WHERE campaign_id = ${campaignId}::uuid`;
      await tx.$executeRaw`DELETE FROM vale_pass_validity_extensions WHERE campaign_id = ${campaignId}::uuid`; // histórico imutável: só a limpeza do dado SINTÉTICO (gatilhos desligados nesta transação)
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
  // a política exige vínculo para um ADMIN resgatar: este administrador sintético recebe as duas empresas
  await db.valePassOperatorScope.createMany({ data: ['VALLE_SHOWROOM', 'VS_BY_CLOSET'].map((company) => ({ adminUserId: admin.id, company, grantedByName: 'teste' })) });
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
    await page.getByText(/não está autorizado a resgatar vouchers de nenhum estabelecimento/).waitFor(); // STAFF sem vínculo: a decisão e a mensagem vêm do servidor
    assert.equal(await page.getByLabel('Valor a utilizar (R$)').count(), 0);
    const text = await page.locator('section[aria-labelledby="balance-desk-title"]').innerText();
    assert.ok(text.includes('Maria S.') && !/maria\.souza|91234-5678|Silva/.test(text), 'dados pessoais mascarados no balcão');
    pass('1) STAFF SEM vínculo consulta: saldo R$ 500,00, titular mascarado, sem formulário de resgate e com a mensagem de permissão do servidor');
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
  assert.equal(await confirm.isDisabled(), true, 'sem a conferência de identidade marcada o resgate não pode ser confirmado');
  assert.equal(await page.getByTestId('redeem-identity').isChecked(), false, 'a conferência nunca vem marcada');
  await page.getByTestId('redeem-identity').check();
  assert.equal(await confirm.isDisabled(), false);
  await confirm.dblclick(); // duplo clique: só UM resgate
  await page.getByText('Resgate de R$ 200,00 registrado. Saldo disponível: R$ 300,00.').waitFor();
  assert.equal((await metric(page, 'Saldo disponível').innerText()).trim(), 'R$ 300,00');
  assert.equal((await metric(page, 'Utilizado').innerText()).trim(), 'R$ 200,00');
  assert.equal((await entriesOf(A)).length, 1, 'duplo clique não duplica o lançamento');
  await shot(page, '1-apos-resgate-200');
  pass('2) R$ 500 − R$ 200 = R$ 300 (confirmação exige redigitar o valor; duplo clique gravou UM lançamento)');

  // "Usar saldo total": preenche o valor com o saldo atual (R$ 300,00) sem registrar nada; depois o operador digita o valor real.
  await page.getByTestId('redeem-use-full').click();
  assert.equal(await page.getByLabel('Valor a utilizar (R$)').inputValue(), '300,00');
  assert.equal((await db.valePass.findUniqueOrThrow({ where: { code: A } })).balanceCents, 30_000, 'o botão só preenche o campo: nada é gravado');
  await page.getByLabel('Valor a utilizar (R$)').fill('100');
  await page.getByLabel('Referência da utilização').fill('Nota 124');
  await page.getByRole('button', { name: 'Conferir' }).click();
  await page.getByLabel(/Digite novamente o valor/).fill('100,00');
  // Conferência de identidade: OBRIGATÓRIA e refeita a cada resgate (a do resgate anterior não é herdada).
  assert.equal(await page.getByTestId('redeem-identity').isChecked(), false, 'a conferência nunca vem marcada nem é herdada do resgate anterior');
  assert.equal(await page.getByRole('button', { name: 'Confirmar resgate' }).isDisabled(), true);
  await page.getByTestId('redeem-identity').check();
  await page.getByRole('button', { name: 'Confirmar resgate' }).click();
  await page.getByText('Saldo disponível: R$ 200,00.').waitFor();
  assert.equal((await metric(page, 'Saldo disponível').innerText()).trim(), 'R$ 200,00');
  await page.getByText('Ref.: Nota 124').waitFor();
  assert.equal(await page.locator('li:has-text("Resgate")').count() >= 2, true);
  const ledger = await entriesOf(A);
  assert.deepEqual(ledger.map((e) => [e.seq, e.deltaCents, e.balanceAfterCents]), [[1, -20_000, 30_000], [2, -10_000, 20_000]]);
  const redeemedEvents = await db.valePassEvent.findMany({ where: { valePass: { code: A }, type: 'REDEEMED' }, orderBy: { createdAt: 'asc' } });
  assert.equal(redeemedEvents.length, 2);
  assert.equal(redeemedEvents[0].detail.identityChecked, true, 'o primeiro resgate também só foi gravado com a conferência marcada');
  assert.equal(redeemedEvents[1].detail.identityChecked, true, 'marcada: fica no histórico do voucher');
  const redeemAudit = await db.adminAuditEvent.findMany({ where: { action: 'VALE_PASS_REDEEMED', entityId: redeemedEvents[1].valePassId }, orderBy: { createdAt: 'asc' } });
  assert.equal(redeemAudit.length, 2);
  assert.equal(redeemAudit[1].detail.identityChecked, true, 'e na auditoria administrativa');
  assert.equal(redeemAudit[0].detail.identityChecked, true);
  pass('3) novo resgate de R$ 100 → saldo R$ 200; histórico com valor, saldo resultante, referência e operador; "Usar saldo total" só preenche o campo; identidade conferida é obrigatória, refeita a cada resgate, e fica no histórico e na auditoria');

  // 3) Outra empresa: R$ 50 − R$ 20 = R$ 30, sem tocar no saldo da Valle Showroom.
  await consult(page, B);
  await page.getByText('VS BY CLOSET').first().waitFor();
  await metric(page, 'Saldo disponível').getByText('R$ 50,00').waitFor();
  await page.getByLabel('Valor a utilizar (R$)').fill('20');
  await page.getByLabel('Referência da utilização').fill('Comanda 7');
  await page.getByRole('button', { name: 'Conferir' }).click();
  await page.getByLabel(/Digite novamente o valor/).fill('20');
  await page.getByTestId('redeem-identity').check();
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
    await row.getByText('Sem vínculo: não realiza resgates.').waitFor();
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

  // 6e) Prorrogação de validade (só o proprietário): data digitada manualmente (campo vazio, sem sugestão), prévia com contagens, justificativa + data redigitada,
  // prévia desatualizada recusada, duplo clique = uma prorrogação, saldos/histórico intactos, ADMIN/STAFF sem acesso (tela e API).
  {
    const NEW_UNTIL = '2027-11-30';
    const NEW_EXPIRY = '2027-12-01T03:00:00.000Z';
    // vouchers de apoio: um cancelado e um expirado (ficam de fora); um terceiro entra DEPOIS da prévia para provar a recusa de prévia desatualizada
    await db.valePass.create({ data: { ...common, groupId: randomUUID(), shopifyOrderId: `${prefix}-ext1`, code: `VALLE-X${Date.now().toString(36).toUpperCase().slice(-3)}-CCCC`, amountCents: 5_000, company: 'VS_BY_CLOSET', benefitId: b2.id, status: 'CANCELLED' } });
    await db.valePass.create({ data: { ...common, groupId: randomUUID(), shopifyOrderId: `${prefix}-ext2`, code: `VALLE-X${Date.now().toString(36).toUpperCase().slice(-3)}-DDDD`, amountCents: 5_000, company: 'VS_BY_CLOSET', benefitId: b2.id, status: 'EXPIRED' } });
    const balancesBefore = (await db.valePass.findMany({ where: { campaignId }, orderBy: { code: 'asc' }, select: { code: true, balanceCents: true, status: true } }));
    const ledgerBefore = await db.valePassLedgerEntry.count({ where: { valePass: { campaignId } } });
    const owner2 = await createUser(`Proprietário prorrogação sintético ${prefix}`, 'SUPER_ADMIN');
    const ctx = await newContext(owner2.token, { viewport: { width: 1280, height: 900 } });
    const xp = await newPage(ctx, errors);
    await xp.goto(vallePass);
    await xp.getByRole('button', { name: /Prorrogação de validade/ }).click();
    const panel = xp.locator('section[aria-label="Prorrogação de validade"]');
    await panel.getByLabel('Campanha').selectOption({ label: `${prefix} Valle Pass` });
    await panel.getByTestId('current-validity').getByText('até 30/09/2027').waitFor();
    const dateInput = panel.locator('input[type="date"]');
    assert.equal(await dateInput.inputValue(), '', 'o campo de data nasce vazio: o sistema não sugere data');
    const previewBtn = panel.getByRole('button', { name: 'Ver prévia' });
    assert.equal(await previewBtn.isDisabled(), true, 'sem data não há prévia');
    // data que não aumenta: problema, sem formulário de confirmação
    await dateInput.fill('2027-09-30');
    await previewBtn.click();
    await panel.getByText(/precisa ser posterior à validade atual/).first().waitFor();
    assert.equal(await panel.getByRole('button', { name: 'Confirmar prorrogação' }).count(), 0);
    // prévia válida
    await dateInput.fill(NEW_UNTIL);
    await previewBtn.click();
    await panel.getByTestId('extension-preview').waitFor();
    assert.equal((await panel.getByTestId('eligible-count').innerText()).trim(), '2');
    assert.equal((await panel.getByTestId('excluded-count').innerText()).trim(), '2');
    await panel.getByText(/Expirados.*não.*são reativados/).waitFor();
    await panel.getByText(/Cancelados e reembolsados.*continuam cancelados/).waitFor();
    await panel.getByText(/saldos somados R\$ 430,00/).waitFor(); // 400 + 30 (não mudam)
    const confirmBtn = panel.getByRole('button', { name: 'Confirmar prorrogação' });
    assert.equal(await confirmBtn.isDisabled(), true, 'confirmar exige justificativa e a data redigitada');
    await panel.getByLabel(/Justificativa/).fill('curta');
    await panel.getByLabel(/Digite novamente a nova data/).fill(NEW_UNTIL);
    assert.equal(await confirmBtn.isDisabled(), true, 'justificativa curta não habilita');
    await panel.getByLabel(/Justificativa/).fill('Decisão comercial confirmada por escrito (teste sintético)');
    await panel.getByLabel(/Digite novamente a nova data/).fill('2027-11-29');
    assert.equal(await confirmBtn.isDisabled(), true, 'data diferente não habilita');
    // mudar a data descarta a prévia (nunca se confirma uma prévia de outra data)
    await dateInput.fill('2027-12-31');
    assert.equal(await panel.getByTestId('extension-preview').count(), 0, 'a prévia some quando a data muda');
    await dateInput.fill(NEW_UNTIL);
    await previewBtn.click();
    await panel.getByTestId('extension-preview').waitFor();
    await panel.getByLabel(/Justificativa/).fill('Decisão comercial confirmada por escrito (teste sintético)');
    await panel.getByLabel(/Digite novamente a nova data/).fill(NEW_UNTIL);
    // prévia desatualizada no SERVIDOR: um voucher prorrogável entra depois da prévia
    const late = await db.valePass.create({ data: { ...common, groupId: randomUUID(), shopifyOrderId: `${prefix}-ext3`, code: `VALLE-X${Date.now().toString(36).toUpperCase().slice(-3)}-EEEE`, amountCents: 5_000, company: 'VS_BY_CLOSET', benefitId: b2.id } });
    await confirmBtn.click();
    await panel.getByText(/quantidade de vouchers prorrogáveis mudou/).waitFor();
    assert.equal(await panel.getByTestId('extension-preview').count(), 0, 'prévia desatualizada é descartada');
    assert.equal(await db.valePassValidityExtension.count({ where: { campaignId } }), 0, 'nada foi gravado com prévia desatualizada');
    assert.equal((await db.valePass.findUniqueOrThrow({ where: { id: late.id } })).expiresAt.toISOString(), '2027-10-01T03:00:00.000Z');
    // nova prévia (agora 3) e confirmação com duplo clique
    await previewBtn.click();
    await panel.getByTestId('extension-preview').waitFor();
    assert.equal((await panel.getByTestId('eligible-count').innerText()).trim(), '3');
    await panel.getByLabel(/Justificativa/).fill('Decisão comercial confirmada por escrito (teste sintético)');
    await panel.getByLabel(/Digite novamente a nova data/).fill(NEW_UNTIL);
    await confirmBtn.dblclick();
    await panel.getByText(/Prorrogação registrada: validade até 30\/11\/2027\. 3 voucher\(s\) prorrogado\(s\)/).waitFor();
    await panel.getByTestId('current-validity').getByText('até 30/11/2027').waitFor();
    await panel.getByTestId('extension-history-row').first().getByText(/#1 · 30\/09\/2027 → 30\/11\/2027/).waitFor();
    assert.equal(await db.valePassValidityExtension.count({ where: { campaignId } }), 1, 'duplo clique gravou UMA prorrogação');
    for (const code of [A, B]) assert.equal((await db.valePass.findUniqueOrThrow({ where: { code } })).expiresAt.toISOString(), NEW_EXPIRY);
    const after = await db.valePass.findMany({ where: { campaignId }, orderBy: { code: 'asc' }, select: { code: true, balanceCents: true, status: true, expiresAt: true } });
    for (const b of balancesBefore) {
      const a = after.find((x) => x.code === b.code);
      assert.equal(a.balanceCents, b.balanceCents, 'saldo intacto');
      assert.equal(a.status, b.status, 'status intacto (cancelado/expirado não reativados)');
      if (b.status !== 'ACTIVE') assert.equal(a.expiresAt.toISOString(), '2027-10-01T03:00:00.000Z', 'cancelado/expirado ficam de fora');
    }
    assert.equal(await db.valePassLedgerEntry.count({ where: { valePass: { campaignId } } }), ledgerBefore, 'histórico de resgates intacto');
    assert.ok(await db.adminAuditEvent.findFirst({ where: { action: 'VALE_PASS_VALIDITY_EXTENDED', entityId: campaignId, isCritical: true } }), 'auditoria crítica');
    await shot(xp, '5-prorrogacao');
    await ctx.close();

    // ADMIN e STAFF: a tela não oferece a seção e a API direta (guards reais) recusa prévia, confirmação e histórico
    for (const who of [admin, staff]) {
      const c2 = await newContext(who.token, { viewport: { width: 1280, height: 900 } });
      const p2 = await newPage(c2, errors);
      await p2.goto(vallePass);
      await p2.getByLabel('Código do voucher').waitFor();
      assert.equal(await p2.getByRole('button', { name: /Prorrogação de validade/ }).count(), 0, 'só o proprietário vê a seção');
      await c2.close();
      const call = (method, url, body) => fetch(`${apiUrl}${url}`, { method, headers: { Authorization: `Bearer ${apiToken}`, 'X-Admin-Session': who.token, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
      assert.equal((await call('POST', `/admin/vale-pass/campaigns/${campaignId}/validity-extension/prepare`, { newUntil: '2028-01-31' })).status, 403);
      assert.equal((await call('POST', `/admin/vale-pass/campaigns/${campaignId}/validity-extension`, { newUntil: '2028-01-31', reason: 'tentativa sem permissão', operationId: `try-${Date.now()}`, confirmDate: '2028-01-31', expectedEligibleCount: 3 })).status, 403);
      assert.equal((await call('GET', `/admin/vale-pass/campaigns/${campaignId}/validity-extension`)).status, 403);
    }
    assert.equal(await db.valePassValidityExtension.count({ where: { campaignId } }), 1, 'ADMIN/STAFF não executaram nada');
    pass('6e) prorrogação: data manual (sem sugestão), prévia com contagens e avisos, justificativa + data redigitada, prévia desatualizada recusada, duplo clique = 1, saldos/histórico intactos, ADMIN/STAFF sem acesso (tela e API)');
  }

  // 6f) Alerta de cancelamento/reembolso com crédito já utilizado: aparece na campanha com referência do pedido, empresa, valores utilizados e saldo, SEM código de voucher nem
  // dado pessoal; STAFF só vê; ADMIN confere com justificativa (botão desabilitado sem ela, duplo clique = uma conferência) e o alerta sai da lista; nada de saldo muda.
  {
    const alertRow = await db.valePassCancellationAlert.create({
      data: {
        shopifyOrderId: `${prefix}-alerta`, shopifyOrderName: '#T-9001', campaignId, topic: 'refunds/create', usedCents: 25_000,
        detail: { vouchersWithUse: 2, lines: [{ company: 'VALLE_SHOWROOM', vouchers: 1, amountCents: 50_000, usedCents: 20_000, balanceCents: 30_000 }, { company: 'VS_BY_CLOSET', vouchers: 1, amountCents: 5_000, usedCents: 5_000, balanceCents: 0 }] },
      },
    });
    const balancesBefore = (await db.valePass.findMany({ where: { campaignId }, orderBy: { code: 'asc' }, select: { code: true, balanceCents: true, status: true } }));
    // STAFF: vê o alerta, sem o botão de conferir
    const sctx = await newContext(staff.token, { viewport: { width: 1280, height: 900 } });
    const sp = await newPage(sctx, errors);
    await sp.goto(vallePass);
    await sp.getByRole('button', { name: /Capacidade, lotes e configuração/ }).first().click();
    const sRow = sp.getByTestId('cancellation-alert-row');
    await sRow.waitFor();
    assert.equal(await sRow.getByRole('button', { name: 'Conferir' }).count(), 0, 'STAFF não confere');
    await sctx.close();

    const actx = await newContext(admin.token, { viewport: { width: 1280, height: 900 } });
    const ap = await newPage(actx, errors);
    await ap.goto(vallePass);
    await ap.getByRole('button', { name: /Capacidade, lotes e configuração/ }).first().click();
    const row = ap.getByTestId('cancellation-alert-row');
    await row.waitFor();
    await ap.getByText(/cancelados ou reembolsados DEPOIS de o crédito ser utilizado/).waitFor();
    const text = await row.innerText();
    assert.ok(text.includes('#T-9001') && text.includes(`${prefix}-alerta`) && text.includes('R$ 250,00 já utilizados'), 'referência do pedido e total utilizado');
    assert.ok(/Valle Showroom: emitido R\$ 500,00 · utilizado R\$ 200,00 · saldo R\$ 300,00/.test(text) && /VS BY CLOSET: emitido R\$ 50,00 · utilizado R\$ 50,00 · saldo R\$ 0,00/.test(text), 'empresa, valores utilizados e saldo');
    const section = await ap.locator('section[aria-label="Cancelamentos com crédito utilizado"]').innerText();
    assert.ok(!section.includes(A) && !section.includes(B) && !/Maria|maria\.souza|91234/.test(section), 'sem código de voucher nem dado pessoal');
    await row.getByRole('button', { name: 'Conferir' }).click();
    const ackBtn = row.getByRole('button', { name: 'Marcar como conferido' });
    assert.equal(await ackBtn.isDisabled(), true, 'conferir exige justificativa');
    await row.getByPlaceholder(/Justificativa da conferência/).fill('curta');
    assert.equal(await ackBtn.isDisabled(), true);
    await row.getByPlaceholder(/Justificativa da conferência/).fill('Reembolso conferido com o financeiro (teste sintético)');
    await ackBtn.dblclick(); // duplo clique: uma única conferência
    await ap.getByTestId('cancellation-alert-row').waitFor({ state: 'detached' });
    const done = await db.valePassCancellationAlert.findUniqueOrThrow({ where: { id: alertRow.id } });
    assert.equal(done.status, 'ACKNOWLEDGED');
    assert.equal(await db.adminAuditEvent.count({ where: { action: 'VALE_PASS_CANCELLATION_ALERT_ACKNOWLEDGED', entityId: `${prefix}-alerta` } }), 1, 'uma conferência auditada');
    const after = await db.valePass.findMany({ where: { campaignId }, orderBy: { code: 'asc' }, select: { code: true, balanceCents: true, status: true } });
    assert.deepEqual(after, balancesBefore, 'conferir o alerta não altera saldos nem status');
    await shot(ap, '6-alerta-cancelamento');
    await actx.close();
    pass('6f) alerta de cancelamento com crédito utilizado: referência, empresa, valores e saldo; sem código/dado pessoal; STAFF só vê; ADMIN confere com justificativa (duplo clique = 1); saldos intactos');
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

  // 6g) STAFF VINCULADO só à VS BY CLOSET (decisão do Anderson, 26/10/2026): na loja autorizada vê o formulário e resgata (prévia + valor redigitado); sem botão de
  // reversão; na outra loja a mensagem de permissão e nenhum formulário; pela API direta (guards reais) reversão, bloqueio e resgate cruzado dão 403 e nada é gravado.
  // A API limita as consultas por minuto (60 por IP; o ClosetAdmin chama a API de um único IP): espera a janela do limitador zerar depois dos passos anteriores.
  await new Promise((resolve) => setTimeout(resolve, 62_000));
  {
    const C = `VALLE-S${Date.now().toString(36).toUpperCase().slice(-3)}-CCCC`;
    const D = `VALLE-S${Date.now().toString(36).toUpperCase().slice(-3)}-DDDD`;
    const unitGroup = randomUUID();
    await db.valePass.create({ data: { ...common, groupId: unitGroup, code: C, amountCents: 5_000, company: 'VS_BY_CLOSET', benefitId: b2.id } });
    await db.valePass.create({ data: { ...common, groupId: unitGroup, code: D, amountCents: 50_000, company: 'VALLE_SHOWROOM', benefitId: b1.id } });
    const scopedStaff = await createUser(`Funcionário vinculado sintético ${prefix}`, 'STAFF');
    await db.valePassOperatorScope.create({ data: { adminUserId: scopedStaff.id, company: 'VS_BY_CLOSET', grantedByName: 'teste sintético' } });
    const ctx = await newContext(scopedStaff.token, { viewport: { width: 1280, height: 900 } });
    const sp = await newPage(ctx, errors);
    await sp.goto(vallePass);
    await sp.getByLabel('Código do voucher').waitFor();
    await consult(sp, C);
    await metric(sp, 'Saldo disponível').getByText('R$ 50,00').waitFor();
    await sp.getByLabel('Valor a utilizar (R$)').waitFor(); // loja autorizada: o formulário aparece para o funcionário
    await sp.getByText(/Reversões e bloqueios são feitos por um administrador/).waitFor();
    assert.equal(await sp.getByRole('button', { name: /Bloquear voucher/ }).count(), 0, 'funcionário não vê o bloqueio');
    await sp.getByLabel('Valor a utilizar (R$)').fill('5');
    await sp.getByLabel('Referência da utilização').fill('Comanda STAFF 1');
    await sp.getByRole('button', { name: 'Conferir' }).click();
    await sp.getByLabel(/Digite novamente o valor/).fill('5');
    await sp.getByTestId('redeem-identity').check();
    await sp.getByRole('button', { name: 'Confirmar resgate' }).click();
    await sp.getByText('Saldo disponível: R$ 45,00.').waitFor();
    assert.equal(await sp.getByRole('button', { name: /Reverter este resgate/ }).count(), 0, 'funcionário não reverte o que registrou');
    await shot(sp, '5-staff-vinculado');
    assert.equal((await db.valePass.findUniqueOrThrow({ where: { code: C } })).balanceCents, 4_500);
    const audit = await db.adminAuditEvent.findMany({ where: { adminUserId: scopedStaff.id, action: 'VALE_PASS_REDEEMED' } });
    assert.equal(audit.length, 1);
    assert.equal(audit[0].detail.accessBasis, 'SCOPE');
    assert.equal(audit[0].detail.identityChecked, true, 'o resgate do funcionário só foi gravado com a conferência de identidade registrada');
    await consult(sp, D); // a outra loja
    await sp.getByText(/não está autorizado a resgatar vouchers da Valle Showroom/).waitFor();
    assert.equal(await sp.getByLabel('Valor a utilizar (R$)').count(), 0, 'sem formulário na loja não autorizada');
    await ctx.close();

    const call = (method, url, body) => fetch(`${apiUrl}${url}`, { method, headers: { Authorization: `Bearer ${apiToken}`, 'X-Admin-Session': scopedStaff.token, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    const mine = await entriesOf(C);
    assert.equal(mine.length, 1);
    assert.equal((await call('POST', `/admin/vale-pass/vouchers/${C}/ledger/${mine[0].id}/reverse/prepare`, {})).status, 403, 'funcionário não reverte (guard da rota)');
    assert.equal((await call('POST', `/admin/vale-pass/vouchers/${C}/block/prepare`, {})).status, 403, 'funcionário não bloqueia');
    const cross = await call('POST', `/admin/vale-pass/vouchers/${D}/redeem`, { company: 'VALLE_SHOWROOM', amountCents: 100, reference: 'tentativa cruzada', operationId: `staff-cross-${Date.now()}`, expectedBalanceCents: 50_000, confirmAmountCents: 100 });
    assert.equal(cross.status, 403);
    assert.equal((await cross.json()).code, 'COMPANY_NOT_AUTHORIZED');
    assert.equal((await call('GET', '/admin/vale-pass/operators')).status, 403);
    assert.equal((await call('GET', '/admin/vale-pass/ledger/reconcile')).status, 403);
    assert.equal((await call('POST', `/admin/vale-pass/vouchers/${D}/use`)).status, 403, 'endpoint "usado" cruzado recusado');
    assert.equal((await call('POST', `/admin/vale-pass/vouchers/${C}/use`)).status, 403, 'funcionário não consome o voucher por inteiro pelo endpoint antigo (nem na própria loja)');
    assert.equal((await db.valePass.findUniqueOrThrow({ where: { code: C } })).balanceCents, 4_500, 'saldo da própria loja intacto');
    assert.equal((await entriesOf(D)).length, 0, 'nada gravado na outra loja');
    assert.equal((await db.valePass.findUniqueOrThrow({ where: { code: D } })).balanceCents, 50_000);
    pass('6g) STAFF vinculado: resgata na loja autorizada (prévia + valor redigitado, auditoria SCOPE), sem reversão/bloqueio; outra loja bloqueada; API direta (reverter, bloquear, cruzado, vínculos, conciliação) = 403');
  }

  assert.deepEqual(errors, [], `erros no navegador: ${errors.join(' | ')}`);
  assert.deepEqual([...new Set(externalRequests)], [], 'nenhuma requisição saiu do computador');
  pass('8) nenhum erro de console e nenhum tráfego externo');
  console.log(`\n${results.length} verificações OK`);
} finally {
  await clean();
}
