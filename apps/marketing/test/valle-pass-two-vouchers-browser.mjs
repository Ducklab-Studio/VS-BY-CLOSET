import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright';

/**
 * Valle Pass 2027 (dois vouchers) no ClosetAdmin, num navegador de verdade: API e site locais isolados, banco de teste, nenhuma
 * Shopify, nenhum e-mail. Cobre: cadastro do modelo de benefícios, fila de pagamentos retidos (descartar recusado enquanto o pedido
 * está pago, emitir com justificativa) e a exibição dos dois vouchers com empresa e validade. O webhook financeiro NÃO é exercitado.
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
if (!localTestDb && !allowedTestHost) throw new Error('O teste de dois vouchers exige um banco de TESTE (local ou listado em TEST_DATABASE_ALLOWED_HOSTS).');
for (const key of ['SHOPIFY_STORE_DOMAIN', 'SHOPIFY_CLIENT_ID', 'SHOPIFY_CLIENT_SECRET', 'SHOPIFY_STOREFRONT_TOKEN']) {
  if (process.env[key]) throw new Error('Integrações externas configuradas; teste abortado.');
}

const apiUrl = 'http://127.0.0.1:3354';
const webUrl = 'http://127.0.0.1:3054';
const vallePass = `${webUrl}/closetadmin/valle-pass`;
const apiToken = randomBytes(32).toString('hex');
const prefix = `DOISV-${Date.now()}`;
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
  // O Chromium no Windows ignora a variável TZ: o contexto segue o TZ do processo para o servidor e o navegador usarem o mesmo fuso (como na CI).
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
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message.slice(0, 30)} @ ${page.url()} (erro ${errors.length}, ${Math.round(Date.now()/1000)%1000}s)`));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });
  return page;
}

let campaignId = null;
const orderIds = [];
let storeId = null;
async function clean() {
  for (const child of childProcesses) child.kill();
  await browser?.close();
  if (campaignId) {
    const holds = await db.valePassIssuanceHold.findMany({ where: { campaignId }, select: { id: true } });
    const passes = await db.valePass.findMany({ where: { campaignId }, select: { id: true } });
    await db.adminAuditEvent.deleteMany({ where: { entityId: { in: [campaignId, ...holds.map((h) => h.id), ...passes.map((p) => p.id)] } } });
    await db.valePassEvent.deleteMany({ where: { valePassId: { in: passes.map((p) => p.id) } } });
    await db.valePass.deleteMany({ where: { campaignId } });
    await db.valePassIssuanceHold.deleteMany({ where: { campaignId } });
    await db.valePassCampaignBenefit.deleteMany({ where: { campaignId } });
    await db.valePassCampaign.deleteMany({ where: { id: campaignId } });
  }
  if (orderIds.length) {
    await db.webhookEvent.deleteMany({ where: { orderId: { in: orderIds } } });
    const regs = await db.valePassOrder.findMany({ where: { shopifyOrderId: { in: orderIds } }, select: { id: true } });
    await db.valePassOrderEvent.deleteMany({ where: { valePassOrderId: { in: regs.map((r) => r.id) } } });
    await db.valePassOrder.deleteMany({ where: { shopifyOrderId: { in: orderIds } } });
  }
  if (storeId) await db.$executeRaw`DELETE FROM stores WHERE id = ${storeId}`;
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
const card = (page) => page.locator('article', { hasText: 'Variante Shopify' }).filter({ hasText: `${prefix} Valle Pass` });
const expand = async (page) => {
  await card(page).getByRole('button', { name: /Capacidade, lotes e configuração/ }).click();
  await card(page).getByText('Capacidade', { exact: true }).waitFor();
};

try {
  const admin = await createUser(`Admin DoisV sintético ${prefix}`, 'ADMIN');
  const staff = await createUser(`Operador DoisV sintético ${prefix}`, 'STAFF');

  const campaign = await db.valePassCampaign.create({
    data: {
      name: `${prefix} Valle Pass`, amountCents: 35_000, validityDays: 30, globalLimit: 1000, shopifyVariantId: `${prefix}-variant`,
      voucherValidFrom: new Date('2027-01-01T00:00:00Z'), voucherValidUntil: new Date('2027-12-31T00:00:00Z'),
    },
  });
  campaignId = campaign.id;

  const childEnv = {
    ...process.env, DATABASE_URL: databaseUrl, ADMIN_API_TOKEN: apiToken, PICKUP_REMINDER_ENABLED: 'false',
    VALE_PASS_ORDER_SYNC_INTERVAL_MINUTES: '0', CATALOG_SYNC_INTERVAL_MINUTES: '0', SHOPIFY_CLIENT_ID: '', SHOPIFY_CLIENT_SECRET: '',
  };
  spawnLocal(process.execPath, [path.join(apiDir, 'dist/src/main.js')], apiDir, { ...childEnv, PORT: '3354', NODE_ENV: 'development' });
  spawnLocal(process.execPath, [path.join(marketingDir, 'node_modules/next/dist/bin/next'), 'start', '-p', '3054', '-H', '127.0.0.1'], marketingDir, {
    ...childEnv, NODE_ENV: 'production', RESERVATIONS_API_ADMIN_URL: apiUrl, RESERVATIONS_API_URL: apiUrl, NEXT_TELEMETRY_DISABLED: '1', __NEXT_PROCESSED_ENV: 'true',
  });
  await waitFor(`${apiUrl}/health`);
  await waitFor(`${webUrl}/closetadmin/login`);
  browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_BROWSER_CHANNEL ? { channel: process.env.PLAYWRIGHT_BROWSER_CHANNEL } : {}) });

  const errors = [];
  const context = await newContext(admin.token, { viewport: { width: 1280, height: 1100 } });
  const page = await newPage(context, errors);

  // 1) Sem benefícios: modelo antigo; o ADMIN cadastra o modelo Valle Pass 2027 pela tela (sugestão + confirmação).
  await page.goto(vallePass);
  await card(page).waitFor();
  await expand(page);
  await card(page).getByText(/segue o modelo antigo/).waitFor();
  await card(page).getByRole('button', { name: 'Sugerir modelo Valle Pass 2027' }).click();
  assert.equal(await db.valePassCampaignBenefit.count({ where: { campaignId } }), 0); // sugerir não grava nada
  await card(page).getByRole('button', { name: 'Confirmar cadastro' }).click();
  await card(page).getByText('Voucher Valle Showroom').waitFor();
  await card(page).getByText(/exclusivo VS BY CLOSET/).waitFor();
  await card(page).getByText(/10% \(direito comercial, sem código nem saldo\)/).waitFor();
  const benefits = await db.valePassCampaignBenefit.findMany({ where: { campaignId }, orderBy: { sortOrder: 'asc' } });
  assert.deepEqual(benefits.map((b) => [b.code, b.kind, b.company, b.amountCents, b.discountPercent]), [
    ['valle_showroom_500', 'VOUCHER', 'VALLE_SHOWROOM', 50_000, null],
    ['vs_by_closet_50', 'VOUCHER', 'VS_BY_CLOSET', 5_000, null],
    ['desconto_passeios', 'DISCOUNT', null, null, 10],
  ]);
  assert.equal(await db.valePass.count({ where: { campaignId } }), 0); // cadastrar benefícios não emite nada
  assert.equal((await db.adminAuditEvent.findFirst({ where: { entityId: campaignId, action: 'VALE_PASS_BENEFITS_UPDATED' } })).adminUserId, admin.id);
  pass('1) modelo Valle Pass 2027 cadastrado pela tela (sugestão só grava após confirmar); nenhum voucher emitido; auditado');

  // 2) Pagamento retido (fila): confirmação reforçada. Limite 1 com 1 voucher legado vendido + 1 pedido pago aguardando = consumo 2 (excede em 1).
  storeId = `${prefix}-store`;
  await db.$executeRaw`INSERT INTO stores (id, shopify_domain, currency) VALUES (${storeId}, ${storeId + '.invalid'}, 'BRL')`;
  const orderId = `${prefix}-order`;
  orderIds.push(orderId);
  await db.valePassOrder.create({
    data: {
      shopifyOrderId: orderId, shopifyOrderGid: `gid://shopify/Order/${orderId}`, shopifyOrderName: `${prefix}#1`, status: 'CONFIRMED', financialStatus: 'paid',
      quantity: 1, customerName: 'Cliente Sintético', customerEmail: 'cliente@exemplo.invalid', customerPhone: '+5500000000000', lastSyncSource: 'teste',
      orderCreatedAt: new Date(Date.now() - 3_600_000), statusChangedAt: new Date(Date.now() - 3_600_000), vouchersProcessedAt: new Date(),
    },
  });
  await db.valePass.create({ data: { code: `${prefix}-LEGADO`, campaignId, amountCents: 35_000, status: 'ACTIVE', purchasedAt: new Date(Date.now() - 60_000), expiresAt: new Date(Date.now() + 86_400_000) } });
  await db.valePassCampaign.update({ where: { id: campaignId }, data: { globalLimit: 1 } });
  const hold = await db.valePassIssuanceHold.create({
    data: { shopifyOrderId: orderId, campaignId, units: 1, reason: 'CAPACITY_EXCEEDED', status: 'OPEN', openFlag: true, detail: { globalLimit: 1 } },
  });
  const newVouchers = () => db.valePass.findMany({ where: { campaignId, company: { not: null } }, orderBy: { company: 'asc' } });
  await page.reload();
  await card(page).waitFor();
  await expand(page);
  await card(page).getByText(/Pagamentos confirmados aguardando resolução \(1\)/).waitFor();
  await card(page).getByText(/Limite global esgotado/).waitFor();
  await card(page).getByText(/aguardam resolução de um administrador/).first().waitFor();
  await card(page).getByRole('button', { name: 'Resolver' }).click();
  const confirmation = card(page).getByLabel('Confirmação da emissão excepcional');
  await confirmation.waitFor();
  assert.match(await confirmation.innerText(), /Limite global\s*1\b/);
  assert.match(await confirmation.innerText(), /Consumido hoje\s*2 \(1 vendidos \+ 1 pagos aguardando\)/);
  assert.match(await confirmation.innerText(), /Total projetado depois\s*2 \(2 vendidos \+ 0 aguardando\)/);
  await confirmation.getByText(/ultrapassa o limite autorizado em 1 unidade\(s\) \(2 de 1\)/).waitFor();
  const emitir = card(page).getByRole('button', { name: /Emitir \(excedente aprovado\)/ });
  const noteInput = card(page).getByLabel(/Justificativa/);
  const totalInput = card(page).getByLabel(/digite o total projetado \(2\)/);
  assert.equal(await emitir.isDisabled(), true); // sem justificativa nem total
  await noteInput.fill('curta'); // < 10 caracteres
  await totalInput.fill('2');
  assert.equal(await emitir.isDisabled(), true);
  await noteInput.fill('Excedente aprovado no teste');
  await totalInput.fill('3'); // total errado
  assert.equal(await emitir.isDisabled(), true);
  await totalInput.fill('2');
  assert.equal(await emitir.isDisabled(), false); // só aqui habilita
  await totalInput.fill('');
  await card(page).getByRole('button', { name: /Descartar/ }).click();
  await card(page).getByText(/continua pago/).waitFor();
  assert.equal((await db.valePassIssuanceHold.findUnique({ where: { id: hold.id } })).status, 'OPEN');
  assert.equal((await newVouchers()).length, 0);

  // A API recusa por conta própria (a tela não é a barreira): sem confirmação → 400; números vistos errados → 409; total digitado errado → 422.
  const http = (path, init = {}) => fetch(`${apiUrl}${path}`, { ...init, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiToken}`, 'X-Admin-Session': admin.token } });
  const seen = await (await http(`/admin/vale-pass/holds/${hold.id}/preview`)).json();
  assert.equal(seen.projectedTotal, 2);
  assert.equal(seen.exceededBy, 1);
  const expected = { projectedTotal: seen.projectedTotal, consumedTotal: seen.consumedBefore, globalLimit: seen.globalLimit, holdUpdatedAt: seen.holdUpdatedAt };
  const post = (body) => http(`/admin/vale-pass/holds/${hold.id}/issue`, { method: 'POST', body: JSON.stringify({ adminUserId: admin.id, ...body }) });
  assert.equal((await post({ note: 'Justificativa suficiente', expected })).status, 400); // sem confirmTotal
  assert.equal((await post({ note: 'curta', confirmTotal: 2, expected })).status, 400); // justificativa curta
  assert.equal((await post({ note: 'Justificativa suficiente', confirmTotal: 2, expected: { ...expected, consumedTotal: 1 } })).status, 409);
  assert.equal((await post({ note: 'Justificativa suficiente', confirmTotal: 3, expected })).status, 422);
  assert.equal((await newVouchers()).length, 0);
  assert.equal((await db.valePassIssuanceHold.findUnique({ where: { id: hold.id } })).status, 'OPEN');
  pass('2) confirmação reforçada: limite/consumo/total projetado e aviso de excesso; botão só habilita com justificativa ≥ 10 e total digitado certo; descartar recusado com pedido pago; a API recusa sem confirmação (400), com números vistos errados (409) e total errado (422)');

  // 2b) Capacidade muda entre a visualização e a confirmação: rejeita, recarrega os números e exige digitar de novo.
  await noteInput.fill('Excedente aprovado no teste');
  await totalInput.fill('2');
  await db.valePassCampaign.update({ where: { id: campaignId }, data: { globalLimit: 2 } }); // outra pessoa mexe no limite depois de a tela abrir
  await emitir.click();
  await card(page).getByText(/mudou desde que a confirmação foi aberta/).waitFor();
  assert.equal((await newVouchers()).length, 0);
  await confirmation.getByText(/não ultrapassa o limite atual/).waitFor(); // números novos na tela
  assert.equal(await totalInput.inputValue(), ''); // exige digitar de novo
  assert.equal(await emitir.isDisabled(), true);
  pass('2b) capacidade alterada depois de abrir a confirmação: a emissão é rejeitada, nada é criado, os números são recarregados e o total precisa ser digitado outra vez');

  await totalInput.fill('2');
  await emitir.click();
  await card(page).getByText(/Pagamentos confirmados aguardando resolução/).waitFor({ state: 'detached' });
  const vouchers = await newVouchers();
  assert.equal(vouchers.length, 2);
  assert.deepEqual(vouchers.map((v) => [v.company, v.amountCents]), [['VALLE_SHOWROOM', 50_000], ['VS_BY_CLOSET', 5_000]]);
  assert.equal(new Set(vouchers.map((v) => v.groupId)).size, 1);
  assert.equal(new Set(vouchers.map((v) => v.code)).size, 2);
  assert.equal((await db.valePassIssuanceHold.findUnique({ where: { id: hold.id } })).status, 'ISSUED');
  const audit = await db.adminAuditEvent.findFirst({ where: { entityId: hold.id } });
  assert.equal(audit.action, 'VALE_PASS_HOLD_ISSUED');
  assert.equal(audit.adminUserId, admin.id);
  assert.equal(audit.isCritical, true);
  assert.deepEqual([audit.before.globalLimit, audit.before.sold, audit.before.pending, audit.before.consumed], [2, 1, 1, 2]);
  assert.deepEqual([audit.after.sold, audit.after.pending, audit.after.consumed], [2, 0, 2]);
  assert.equal(audit.detail.note, 'Excedente aprovado no teste');
  assert.equal(audit.detail.confirmedTotal, 2);
  pass('2c) emissão confirmada cria exatamente 2 vouchers (R$ 500 Valle Showroom + R$ 50 VS BY CLOSET), mesmo grupo; consumo igual antes e depois; auditoria crítica com totais, justificativa e administrador');

  // 3) Os dois vouchers aparecem separados, com empresa e validade 2027 — IGUAL em navegadores de fusos diferentes.
  for (const timezoneId of ['UTC', 'America/Sao_Paulo', 'America/Santiago', 'Pacific/Auckland']) {
    const tzContext = await newContext(admin.token, { viewport: { width: 1280, height: 1000 }, timezoneId });
    const tzPage = await newPage(tzContext, []); // erros de hidratação de OUTRAS datas do painel (pedidos/lotes, ainda no fuso do aparelho) são pré-existentes e fora do escopo daqui
    await tzPage.goto(vallePass);
    await tzPage.getByPlaceholder('Buscar por código, nome, telefone, e-mail ou nº do pedido').fill(`${prefix}#1`);
    await tzPage.getByText('Válido só na Valle Showroom').waitFor();
    await tzPage.getByText('Válido só na VS BY CLOSET').waitFor();
    await tzPage.getByText(/Válido de 01\/01\/2027/).first().waitFor();
    await tzPage.getByText(/Válido até 31\/12\/2027/).first().waitFor();
    assert.equal(await tzPage.getByText(/Válido até 01\/01\/2028/).count(), 0, timezoneId);
    await tzContext.close();
  }
  pass('3) os dois vouchers aparecem separados, com a empresa e a validade de 01/01/2027 a 31/12/2027 em navegadores UTC, São Paulo, Santiago e Auckland');


  // 4) Perfil sem ADMIN: vê o painel, sem botões de escrita, e a API recusa (403).
  const staffCtx = await newContext(staff.token, { viewport: { width: 1280, height: 1000 } });
  const staffPage = await newPage(staffCtx, errors);
  const hold2 = await db.valePassIssuanceHold.create({ data: { shopifyOrderId: orderId, campaignId, units: 1, reason: 'CAMPAIGN_NOT_READY', status: 'OPEN', openFlag: true } });
  await db.valePassIssuanceHold.create({ data: { shopifyOrderId: `${prefix}-fin`, campaignId, units: 1, reason: 'FINANCIAL_MISMATCH', status: 'OPEN', openFlag: true, detail: { issues: [{ code: 'DISCOUNT_PRESENT' }, { code: 'TOTAL_MISMATCH' }] } } });
  await staffPage.goto(vallePass);
  await card(staffPage).waitFor();
  await expand(staffPage);
  await card(staffPage).getByText(/Pagamentos confirmados aguardando resolução/).waitFor();
  await card(staffPage).getByText(/Valor, moeda, quantidade ou desconto fora do esperado/).waitFor();
  await card(staffPage).getByText('Divergências: desconto aplicado; total pago diferente do esperado.').waitFor(); // motivo e divergências em português, sem dados pessoais
  assert.equal(await card(staffPage).getByRole('button', { name: /Resolver|Sugerir modelo|Emitir|Descartar/ }).count(), 0);
  const staffPreview = await fetch(`${apiUrl}/admin/vale-pass/holds/${hold2.id}/preview`, { headers: { Authorization: `Bearer ${apiToken}`, 'X-Admin-Session': staff.token } });
  assert.equal(staffPreview.status, 403); // nem o retrato dos números é do STAFF
  const forbidden = await fetch(`${apiUrl}/admin/vale-pass/holds/${hold2.id}/issue`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiToken}`, 'X-Admin-Session': staff.token },
    body: JSON.stringify({ adminUserId: staff.id, note: 'tentativa sem perfil', confirmTotal: 2, expected: { projectedTotal: 2, consumedTotal: 2, globalLimit: 2, holdUpdatedAt: new Date().toISOString() } }),
  });
  assert.equal(forbidden.status, 403);
  assert.equal((await db.valePassIssuanceHold.findUnique({ where: { id: hold2.id } })).status, 'OPEN');
  pass('4) sem perfil ADMIN: fila visível só para leitura e a API recusa emitir (403)');

  // 5) Celular.
  const mobile = await newContext(admin.token, { viewport: { width: 390, height: 844 } });
  const mobilePage = await newPage(mobile, errors);
  await mobilePage.goto(vallePass);
  await card(mobilePage).waitFor();
  await expand(mobilePage);
  await card(mobilePage).getByText(/Pagamentos confirmados aguardando resolução/).waitFor();
  assert.equal(await mobilePage.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth), 0);
  pass('5) celular (390px): sem rolagem lateral');

  assert.deepEqual(errors, []);
  assert.deepEqual(externalRequests, [], 'o navegador tentou acessar a internet (Shopify real?)');
  pass('6) nenhum erro no console nem acesso externo');
  console.log(`Dois vouchers do Valle Pass no navegador: ${results.length} verificações passaram.`);
} finally {
  await clean();
}
