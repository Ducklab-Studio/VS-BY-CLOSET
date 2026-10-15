import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright';

/**
 * Painel "Sincronização com a Shopify" (ClosetAdmin > Peças) no navegador real, contra a API real
 * e o Next real, com PostgreSQL local isolado e a Shopify NÃO configurada (rede real bloqueada).
 * Sem Shopify, o relatório e a sincronização falham de forma previsível (503 do servidor), o que
 * exercita de ponta a ponta o que importa aqui: o painel NÃO some, mostra o erro, deixa
 * "Tentar novamente", exibe o carregamento e trata a resposta que não chega (incerteza) sem
 * declarar falha definitiva. O caminho de sucesso é coberto pelos testes de lógica e de actions.
 */
const marketingDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const apiDir = path.resolve(marketingDir, '../reservations-api');
const requireApi = createRequire(path.join(apiDir, 'package.json'));
const { PrismaClient } = requireApi('@prisma/client');
const { generateSessionToken, hashSessionToken } = requireApi('./dist/src/admin/admin-session-token.js');

const databaseUrl = process.env.DATABASE_URL ?? '';
if (!/^postgres(?:ql)?:\/\/[^@]+@(localhost|127\.0\.0\.1)(:\d+)?\//i.test(databaseUrl)) throw new Error('Este teste exige PostgreSQL local isolado.');
if (!/(test|audit|operational)/i.test(new URL(databaseUrl).pathname)) throw new Error('O nome do banco local precisa identificar uma base de teste.');
for (const key of ['SHOPIFY_STORE_DOMAIN', 'SHOPIFY_CLIENT_ID', 'SHOPIFY_CLIENT_SECRET', 'SHOPIFY_STOREFRONT_TOKEN']) {
  if (process.env[key]) throw new Error('Integrações externas configuradas; teste abortado.');
}

const apiUrl = 'http://127.0.0.1:3353';
const webUrl = 'http://127.0.0.1:3053';
const apiToken = randomBytes(32).toString('hex');
const db = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
const children = [];
const userIds = [];
let browser;

function spawnLocal(command, args, cwd, env) {
  children.push(spawn(command, args, { cwd, env, stdio: 'ignore', windowsHide: true }));
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
async function seedUser(role, name) {
  const user = await db.adminUser.create({ data: { name, phone: `${Date.now()}${Math.floor(Math.random() * 900 + 100)}`, pinHash: 'synthetic', role, moduleAccess: ['PIECES'] } });
  userIds.push(user.id);
  const token = generateSessionToken();
  await db.adminSession.create({ data: { adminUserId: user.id, tokenHash: hashSessionToken(token), expiresAt: new Date(Date.now() + 3_600_000) } });
  return token;
}
async function clean() {
  for (const child of children) child.kill();
  if (browser) await browser.close().catch(() => {});
  if (userIds.length) {
    await db.adminSession.deleteMany({ where: { adminUserId: { in: userIds } } });
    await db.adminUser.deleteMany({ where: { id: { in: userIds } } });
  }
  await db.$disconnect();
}

// Opcional (inspeção visual local): SYNC_PANEL_SHOTS=<pasta> grava capturas dos estados do painel.
const shot = async (page, name) => { if (process.env.SYNC_PANEL_SHOTS) await page.getByTestId('sync-panel').screenshot({ path: path.join(process.env.SYNC_PANEL_SHOTS, `sync-${name}.png`) }); };
const isServerAction = (request) => request.method() === 'POST' && 'next-action' in request.headers();

try {
  const adminToken = await seedUser('ADMIN', 'Admin sintético');
  const staffToken = await seedUser('STAFF', 'Operador sintético');
  const childEnv = { ...process.env, DATABASE_URL: databaseUrl, ADMIN_API_TOKEN: apiToken, PICKUP_REMINDER_ENABLED: 'false', CATALOG_SYNC_INTERVAL_MINUTES: '0' };
  spawnLocal(process.execPath, [path.join(apiDir, 'dist/src/main.js')], apiDir, { ...childEnv, PORT: '3353', NODE_ENV: 'development' });
  spawnLocal(process.execPath, [path.join(marketingDir, 'node_modules/next/dist/bin/next'), 'start', '-p', '3053', '-H', '127.0.0.1'], marketingDir, {
    ...childEnv, NODE_ENV: 'production', RESERVATIONS_API_ADMIN_URL: apiUrl, RESERVATIONS_API_URL: apiUrl, NEXT_TELEMETRY_DISABLED: '1', __NEXT_PROCESSED_ENV: 'true',
  });
  await waitFor(`${apiUrl}/health`);
  await waitFor(`${webUrl}/closetadmin/login`);

  browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_BROWSER_CHANNEL ? { channel: process.env.PLAYWRIGHT_BROWSER_CHANNEL } : {}) });
  const externalRequests = [];

  async function openPage(token, viewport = { width: 1280, height: 900 }) {
    const context = await browser.newContext({ viewport });
    await context.route('**/*', (route) => {
      const host = new URL(route.request().url()).hostname;
      if (['localhost', '127.0.0.1'].includes(host)) return route.continue();
      externalRequests.push(host);
      return route.abort();
    });
    await context.addCookies([{ name: 'closetadmin_session', value: token, url: webUrl, httpOnly: true, sameSite: 'Lax' }]);
    const page = await context.newPage();
    page.setDefaultTimeout(20_000);
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    await page.goto(`${webUrl}/closetadmin/pecas`);
    return { context, page, errors };
  }

  // 1) ADMIN, relatório inicial falhou (Shopify não configurada): o painel NÃO some
  {
    const { context, page, errors } = await openPage(adminToken);
    await page.getByTestId('sync-panel').waitFor();
    assert.equal(await page.getByTestId('sync-load-error').isVisible(), true, 'erro do relatório inicial precisa aparecer');
    assert.match(await page.getByTestId('sync-load-error').innerText(), /Não foi possível carregar o relatório/);
    await shot(page, '1-relatorio-falhou');
    assert.equal(await page.getByTestId('sync-load-retry').isVisible(), true, '"Tentar novamente" do relatório inicial');
    assert.equal(await page.getByTestId('sync-button').isVisible(), true, 'ADMIN continua vendo o botão');
    assert.match(await page.getByTestId('sync-panel').innerText(), /Última sincronização: indisponível agora/);
    // sem catálogo da Shopify não há contagem de inventário físico nem divergências inventadas
    assert.equal(await page.getByTestId('sync-awaiting').count(), 0);
    assert.equal(await page.getByTestId('sync-no-divergence').count(), 0);

    // "Tentar novamente" refaz a leitura e continua mostrando o erro (Shopify ainda indisponível), sem quebrar
    await page.getByTestId('sync-load-retry').click();
    await page.waitForFunction(() => { const b = document.querySelector('[data-testid="sync-load-retry"]'); return !!b && !b.disabled && /Tentar novamente/.test(b.textContent ?? ''); });
    assert.equal(await page.getByTestId('sync-load-error').isVisible(), true, 'continua mostrando o erro enquanto a Shopify estiver indisponível');

    // 2) Carregamento visível + erro com "Tentar novamente" (atrasa só a server action para dar tempo de ver)
    await page.route(`${webUrl}/closetadmin/pecas`, async (route) => {
      if (isServerAction(route.request())) await delay(1500);
      await route.continue();
    });
    await page.getByTestId('sync-button').click();
    await page.getByTestId('sync-loading').waitFor();
    const loading = await page.getByTestId('sync-loading').innerText();
    assert.match(loading, /Sincronizando com a Shopify/);
    assert.match(loading, /Não feche nem recarregue/);
    await shot(page, '2-carregando');
    assert.equal(await page.getByTestId('sync-button').isDisabled(), true, 'botão desabilitado durante a sincronização');
    assert.match(await page.getByTestId('sync-button').innerText(), /Sincronizando…/);
    await page.getByTestId('sync-error').waitFor();
    assert.equal(await page.getByTestId('sync-loading').count(), 0, 'o carregamento some quando termina');
    assert.match(await page.getByTestId('sync-error').innerText(), /Integração Shopify Admin não configurada|Não foi possível sincronizar/);
    assert.equal(await page.getByTestId('sync-button').isEnabled(), true, 'botão volta a funcionar');
    assert.equal(await page.getByTestId('sync-success').count(), 0, 'erro nunca vira mensagem de sucesso');
    await shot(page, '3-erro-tentar-novamente');

    // "Tentar novamente" repete a sincronização (carrega de novo e volta ao erro)
    await page.getByTestId('sync-retry').click();
    await page.getByTestId('sync-loading').waitFor();
    await page.getByTestId('sync-error').waitFor();
    await page.unroute(`${webUrl}/closetadmin/pecas`);

    // 3) Resposta que não chega (plataforma/rede): estado INCERTO, nunca "falhou"; oferece conferir e repetir
    let aborted = 0;
    await page.route(`${webUrl}/closetadmin/pecas`, async (route) => {
      if (isServerAction(route.request()) && aborted === 0) {
        aborted++;
        return route.abort('failed');
      }
      return route.continue();
    });
    await page.getByTestId('sync-button').click();
    await page.getByTestId('sync-uncertain').waitFor();
    // a releitura (somente leitura) falha também (Shopify não configurada): segue incerto, com saídas
    await page.getByTestId('sync-check-again').waitFor();
    const uncertain = await page.getByTestId('sync-uncertain').innerText();
    assert.match(uncertain, /Não foi possível confirmar se a sincronização terminou/);
    assert.equal(await page.getByTestId('sync-error').count(), 0, 'incerteza não é erro definitivo');
    assert.equal(await page.getByTestId('sync-retry').isVisible(), true, '"Sincronizar de novo" disponível (repetir é seguro)');
    assert.equal(aborted, 1);
    await shot(page, '4-incerto');
    await page.unroute(`${webUrl}/closetadmin/pecas`);

    assert.deepEqual(errors, [], `erros de página: ${errors.join(' | ')}`);
    await context.close();
  }

  // 4) STAFF: vê o painel e o erro com "Tentar novamente", mas NÃO o botão de sincronizar
  {
    const { context, page, errors } = await openPage(staffToken);
    await page.getByTestId('sync-panel').waitFor();
    assert.equal(await page.getByTestId('sync-load-error').isVisible(), true);
    assert.equal(await page.getByTestId('sync-load-retry').isVisible(), true);
    assert.equal(await page.getByTestId('sync-button').count(), 0, 'STAFF não vê o botão de sincronizar');
    await page.getByTestId('sync-load-retry').click();
    await page.waitForFunction(() => { const b = document.querySelector('[data-testid="sync-load-retry"]'); return !!b && !b.disabled; });
    assert.equal(await page.getByTestId('sync-load-error').isVisible(), true);
    assert.deepEqual(errors, []);
    await context.close();
  }

  // 5) Celular (390 px): o painel cabe, sem rolagem lateral
  {
    const { context, page } = await openPage(adminToken, { width: 390, height: 844 });
    await page.getByTestId('sync-panel').waitFor();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    assert.ok(overflow <= 1, `rolagem lateral de ${overflow}px no celular`);
    await context.close();
  }

  assert.deepEqual(externalRequests, [], `o navegador tentou sair: ${externalRequests.join(', ')}`);
  console.log('Painel de sincronização: não some com o relatório inicial falho; erro com "Tentar novamente"; carregamento visível; resposta que não chega vira estado incerto (não falha definitiva); STAFF sem botão; celular sem rolagem lateral.');
} finally {
  await clean();
}
