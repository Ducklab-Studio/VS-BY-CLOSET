import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright';

/**
 * Painel "Pronta para vender?" do Valle Pass, de ponta a ponta e SOMENTE LEITURA: API e site locais isolados, banco de teste, campanha sintética gravada
 * direto no banco (nada fala com a Shopify nem com a Resend). Confere a autenticação do endpoint, que ele não escreve nada, o que a tela mostra (técnico x
 * Anderson, nenhum botão) e que nenhuma requisição sai do computador. Roda na CI (Postgres efêmero) ou localmente contra um banco de teste.
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
if (!localTestDb && !allowedTestHost) throw new Error('O teste do painel de prontidão exige um banco de TESTE (local ou listado em TEST_DATABASE_ALLOWED_HOSTS).');
for (const key of ['SHOPIFY_STORE_DOMAIN', 'SHOPIFY_CLIENT_ID', 'SHOPIFY_CLIENT_SECRET', 'SHOPIFY_STOREFRONT_TOKEN']) {
  if (process.env[key]) throw new Error('Integrações externas configuradas; teste abortado.');
}

const apiUrl = 'http://127.0.0.1:3358';
const webUrl = 'http://127.0.0.1:3058';
const vallePass = `${webUrl}/closetadmin/valle-pass`;
const apiToken = randomBytes(32).toString('hex');
const prefix = `READY-${Date.now()}`;
const db = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
const childProcesses = [];
const userIds = [];
const campaignIds = [];
let browser;
/** Requisições do navegador para fora do computador (deve ficar vazio). */
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
async function createUser(name, moduleAccess) {
  const user = await db.adminUser.create({ data: { name, phone: `${Date.now()}${userIds.length}9`, pinHash: 'synthetic', role: 'STAFF', moduleAccess } });
  userIds.push(user.id);
  const token = generateSessionToken();
  await db.adminSession.create({ data: { adminUserId: user.id, tokenHash: hashSessionToken(token), expiresAt: new Date(Date.now() + 3_600_000) } });
  return token;
}
const api = (path_, { session, method = 'GET', bearer = true } = {}) =>
  fetch(`${apiUrl}${path_}`, { method, headers: { ...(bearer ? { authorization: `Bearer ${apiToken}` } : {}), ...(session ? { 'x-admin-session': session } : {}) }, signal: AbortSignal.timeout(15_000) });
/** Contagens que uma leitura jamais pode mexer. */
const writeProbe = () => db.$queryRaw`SELECT (SELECT count(*)::int FROM admin_audit_events) AS audit, (SELECT count(*)::int FROM vale_pass_campaigns) AS campaigns, (SELECT count(*)::int FROM vale_pass_campaign_benefits) AS benefits, (SELECT count(*)::int FROM vale_pass_lots) AS lots, (SELECT count(*)::int FROM vale_passes) AS vouchers, (SELECT count(*)::int FROM vale_pass_orders) AS orders`.then((r) => r[0]);

async function newContext(token) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 1000 } });
  await context.route('**/*', (route) => {
    const hostname = new URL(route.request().url()).hostname;
    if (['localhost', '127.0.0.1'].includes(hostname)) return route.continue();
    externalRequests.push(hostname);
    return route.abort();
  });
  await context.addCookies([{ name: 'closetadmin_session', value: token, url: webUrl, httpOnly: true, sameSite: 'Lax' }]);
  return context;
}

async function clean() {
  for (const child of childProcesses) child.kill();
  await browser?.close();
  if (campaignIds.length) await db.valePassCampaign.deleteMany({ where: { id: { in: campaignIds } } });
  if (userIds.length) {
    await db.adminPresence.deleteMany({ where: { adminUserId: { in: userIds } } }).catch(() => undefined);
    await db.adminAuditEvent.deleteMany({ where: { adminUserId: { in: userIds } } }).catch(() => undefined);
    await db.adminSession.deleteMany({ where: { adminUserId: { in: userIds } } });
    await db.adminUser.deleteMany({ where: { id: { in: userIds } } });
  }
  await db.$disconnect();
}

const pass = (name) => console.log(`  ✓ ${name}`);
let verifications = 0;
const ok = (name) => { verifications++; pass(name); };

try {
  assert.equal(await db.valePassCampaign.count({ where: { active: true } }), 0, 'o banco de teste precisa começar sem campanha ativa');
  const staffToken = await createUser('Operador Valle Pass sintético (prontidão)', ['VALLE_PASS']);
  const noModuleToken = await createUser('Operador sem Valle Pass sintético (prontidão)', ['CALENDAR']);

  const childEnv = {
    ...process.env, DATABASE_URL: databaseUrl, ADMIN_API_TOKEN: apiToken, PICKUP_REMINDER_ENABLED: 'false',
    VALE_PASS_ORDER_SYNC_INTERVAL_MINUTES: '0', CATALOG_SYNC_INTERVAL_MINUTES: '0', SHOPIFY_CLIENT_ID: '', SHOPIFY_CLIENT_SECRET: '',
    // Chaves nos padrões de produção (tudo desligado).
    VALE_PASS_TWO_VOUCHER_FLOW: '', VALE_PASS_AUTO_VERIFY: '', VALE_PASS_EMAIL_MODE: '', VALE_PASS_ALERTS_MODE: '',
  };
  spawnLocal(process.execPath, [path.join(apiDir, 'dist/src/main.js')], apiDir, { ...childEnv, PORT: '3358', NODE_ENV: 'development' });
  spawnLocal(process.execPath, [path.join(marketingDir, 'node_modules/next/dist/bin/next'), 'start', '-p', '3058', '-H', '127.0.0.1'], marketingDir, {
    ...childEnv, NODE_ENV: 'production', RESERVATIONS_API_ADMIN_URL: apiUrl, RESERVATIONS_API_URL: apiUrl, NEXT_TELEMETRY_DISABLED: '1', __NEXT_PROCESSED_ENV: 'true',
  });
  await waitFor(`${apiUrl}/health`);
  await waitFor(`${webUrl}/closetadmin/login`);

  // ── Endpoint: autenticação ──
  assert.equal((await api('/admin/vale-pass/launch-readiness', { bearer: false, session: staffToken })).status, 401);
  assert.equal((await api('/admin/vale-pass/launch-readiness', { session: undefined })).status, 401);
  assert.equal((await api('/admin/vale-pass/launch-readiness', { session: 'sessao-invalida' })).status, 401);
  assert.equal((await api('/admin/vale-pass/launch-readiness', { session: noModuleToken })).status, 403);
  ok('endpoint: sem credencial, sem sessão, sessão inválida e sem o módulo VALLE_PASS são recusados (401/401/401/403)');

  // ── Endpoint: sem campanha ──
  const before = await writeProbe();
  const empty = await (await api('/admin/vale-pass/launch-readiness', { session: staffToken })).json();
  assert.equal(empty.campaign, null);
  assert.equal(empty.readyToSell, false);
  assert.ok(empty.items.some((i) => i.id === 'campaign' && i.status === 'BLOCKED'));
  ok('endpoint: sem campanha cadastrada devolve checklist bloqueado (nunca pronto)');

  // ── Endpoint: campanha sintética nas chaves de produção (tudo desligado) ──
  const campaign = await db.valePassCampaign.create({
    data: { name: `Campanha prontidão ${prefix}`, amountCents: 35_000, validityDays: 30, globalLimit: 1_000, shopifyVariantId: `${prefix}-v`, active: true },
  });
  campaignIds.push(campaign.id);
  const res = await api('/admin/vale-pass/launch-readiness', { session: staffToken });
  assert.equal(res.status, 200);
  const body = await res.json();
  const byId = Object.fromEntries(body.items.map((i) => [i.id, i]));
  assert.equal(body.campaign.id, campaign.id);
  assert.equal(body.readyToSell, false);
  assert.equal(byId['global-limit'].status, 'APPROVED');
  assert.equal(byId.vouchers.status, 'BLOCKED'); // campanha sem benefícios cadastrados
  assert.equal(byId['valid-until'].status, 'BLOCKED');
  assert.equal(byId['flag-two-voucher'].status, 'PENDING');
  assert.equal(byId['email-mode'].status, 'PENDING');
  assert.equal(byId['shopify-stock'].status, 'PENDING');
  for (const id of ['terms-approved', 'refund-policy', 'legal-review', 'real-purchase-test', 'retention-owner', 'staff-policy', 'validity-confirmed']) assert.equal(byId[id].status, 'PENDING', id);
  assert.equal(byId['open-holds'].status, 'APPROVED'); // contagem real: banco de teste sem retenções
  assert.deepEqual(Object.keys(body).sort(), ['campaign', 'generatedAt', 'items', 'readyToSell', 'summary']);
  assert.ok(Math.abs(Date.now() - Date.parse(body.generatedAt)) < 60_000, 'generatedAt é o instante da leitura');
  assert.doesNotMatch(JSON.stringify(body), /postgres(ql)?:\/\/|re_[A-Za-z0-9]{10,}|shpat_|whsec_|Bearer /i);
  ok('endpoint: campanha sintética com as chaves de produção desligadas — itens reais aprovados, decisões do Anderson pendentes, sem segredos na resposta');

  // ── Endpoint: somente leitura ──
  const afterRead = await writeProbe();
  assert.deepEqual({ ...afterRead, campaigns: afterRead.campaigns - 1 }, before, 'a leitura não pode criar nem alterar nada');
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
    const status = (await api('/admin/vale-pass/launch-readiness', { session: staffToken, method })).status;
    assert.ok([404, 405].includes(status), `${method} deveria não existir, veio ${status}`);
  }
  assert.equal((await api('/admin/vale-pass/launch-readiness?campaignId=nao-e-uuid', { session: staffToken })).status, 400);
  assert.equal((await api('/admin/vale-pass/launch-readiness?campaignId=99999999-9999-4999-8999-999999999999', { session: staffToken })).status, 404);
  assert.deepEqual(await writeProbe(), afterRead);
  ok('endpoint: somente leitura (nenhuma gravação; POST/PUT/PATCH/DELETE inexistentes; id inválido 400 e inexistente 404)');

  // ── Tela ──
  browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_BROWSER_CHANNEL ? { channel: process.env.PLAYWRIGHT_BROWSER_CHANNEL } : {}) });
  const errors = [];
  const context = await newContext(staffToken);
  const page = await context.newPage();
  page.setDefaultTimeout(30_000);
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });
  await page.goto(vallePass);
  const panel = page.locator('[data-testid="launch-readiness"]');
  await panel.waitFor();
  const headline = (await page.locator('[data-testid="launch-readiness-headline"]').textContent()) ?? '';
  assert.match(headline, /Pronta para vender\? NÃO/);
  assert.equal((await page.locator('[data-testid="launch-readiness-verdict"]').textContent())?.trim(), 'NÃO PRONTA');
  await panel.locator('summary').click(); // abre o painel (começa fechado quando há dados)
  assert.ok(await panel.locator('[data-owner="TECNICO"]').isVisible());
  assert.ok(await panel.locator('[data-owner="ANDERSON"]').isVisible());
  assert.equal(await panel.locator('[data-owner="ANDERSON"] [data-status="APPROVED"]').count(), 0, 'nada que dependa do Anderson aparece aprovado');
  assert.ok((await panel.locator('[data-owner="TECNICO"] [data-status="APPROVED"]').count()) > 0);
  assert.ok((await panel.locator('[data-status="BLOCKED"]').count()) > 0);
  assert.match((await panel.locator('[data-testid="launch-readiness-notice"]').textContent()) ?? '', /não abre vendas, não altera o estoque da Shopify e não liga chaves/);
  assert.match((await panel.locator('[data-testid="launch-readiness-freshness"]').textContent()) ?? '', /Leitura feita em \d{2}\/\d{2}\/\d{4} \d{2}:\d{2} \(horário de São Paulo\).*recarregue/);
  assert.equal(await panel.locator('button, form, input, select, textarea, a').count(), 0, 'o painel é somente leitura: sem controles');
  ok('tela: painel "Pronta para vender?" com técnico x Anderson, aprovados/pendentes/bloqueados, aviso de somente leitura e nenhum controle');

  // Sem o módulo: nem a tela nem os dados.
  const noModuleContext = await newContext(noModuleToken);
  const noModulePage = await noModuleContext.newPage();
  await noModulePage.goto(vallePass);
  assert.equal(await noModulePage.locator('[data-testid="launch-readiness"]').count(), 0);
  ok('tela: usuário sem o módulo VALLE_PASS não vê o painel');

  assert.deepEqual(errors, [], `erros no navegador: ${errors.join(' | ')}`);
  assert.deepEqual(externalRequests, [], `requisições para fora do computador: ${externalRequests.join(', ')}`);
  ok('navegador: nenhum erro de console e nenhuma requisição externa');
  console.log(`Painel de prontidão do Valle Pass: ${verifications} verificações passaram.`);
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  await clean();
}
