import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright';

/**
 * Pré-lançamento do Valle Pass (página do produto) num navegador de verdade. Shopify SIMULADA (fixture local): nenhuma rede externa, nenhum pedido, nenhum
 * checkout, nenhuma venda real. O estado da venda (aberta/fechada) é um arquivo de teste lido pela Shopify simulada a cada consulta.
 * Cobre: venda fechada = botão "Em breve" inerte (não é link, o endereço do checkout nem chega ao HTML, clicar não navega), previsão sujeita a confirmação,
 * aviso de indisponibilidade, termos ainda não publicados (sem afirmar que existem); venda aberta = link de compra normal e sem avisos de pré-lançamento;
 * estado ausente = fechado (fail closed); termos com endereço configurado (link em ambos os estados); 375 px sem rolagem horizontal; sem rede externa e
 * sem erros de console.
 */
const marketingDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixture = path.join(marketingDir, 'test/fixtures/size-variants-fixture.cjs');
const port = 3058;
const webUrl = `http://127.0.0.1:${port}`;
const productUrl = `${webUrl}/pecas/valle-pass-fixture`;
const stateDir = mkdtempSync(path.join(tmpdir(), 'valle-pass-state-'));
const stateFile = path.join(stateDir, 'state');
const setSale = (state) => writeFileSync(stateFile, state);
const children = [];
const externalRequests = [];
const errors = [];
let browser;
let server;

const results = [];
const pass = (name) => { results.push(name); console.log(`  ✓ ${name}`); };

async function waitFor(url, up = true) {
  for (let i = 0; i < 240; i++) {
    let ok = false;
    try { ok = (await fetch(url, { signal: AbortSignal.timeout(2000) })).status < 500; } catch { ok = false; }
    if (ok === up) return;
    await delay(500);
  }
  throw new Error(up ? 'Servidor local não iniciou.' : 'Servidor local não encerrou.');
}

async function startServer(extraEnv = {}) {
  const env = {
    ...process.env,
    NODE_OPTIONS: `--require=${fixture}`,
    SIZE_VARIANTS_FIXTURE: '1',
    VALLE_PASS_FIXTURE_STATE_FILE: stateFile,
    NEXT_PUBLIC_SHOPIFY_STORE_DOMAIN: '127.0.0.1:8443',
    NEXT_PUBLIC_SHOPIFY_STORE_URL: 'https://127.0.0.1:8443', // loja simulada: só para montar o permalink do checkout; o teste nunca o abre
    NEXT_PUBLIC_SHOPIFY_STOREFRONT_TOKEN: 'fixture',
    NEXT_TELEMETRY_DISABLED: '1',
    NODE_ENV: 'development',
    ...extraEnv,
  };
  for (const key of ['NEXT_PUBLIC_AVAILABILITY_URL', 'NEXT_PUBLIC_HOLDS_URL', 'RESERVATIONS_API_URL', 'RESERVATIONS_API_ADMIN_URL']) delete env[key];
  if (!('NEXT_PUBLIC_VALE_PASS_TERMS_URL' in extraEnv)) delete env.NEXT_PUBLIC_VALE_PASS_TERMS_URL;
  server = spawn(process.execPath, [path.join(marketingDir, 'node_modules/next/dist/bin/next'), 'dev', '-p', String(port), '-H', '127.0.0.1'], { cwd: marketingDir, env, stdio: 'ignore', windowsHide: true });
  children.push(server);
  await waitFor(productUrl);
}
async function stopServer() {
  if (!server) return;
  server.kill();
  server = undefined;
  await waitFor(productUrl, false);
}

const contexts = [];
async function newPage(options = {}) {
  const context = await browser.newContext(options);
  contexts.push(context);
  await context.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    if (['localhost', '127.0.0.1'].includes(url.hostname) && url.port !== '8443') return route.continue();
    if (url.host === '127.0.0.1:8443') return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ data: { nodes: [] } }) });
    externalRequests.push(url.hostname);
    return route.abort();
  });
  const page = await context.newPage();
  page.setDefaultTimeout(30_000);
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() !== 'error' || /Failed to load resource|favicon|net::ERR/.test(m.text())) return;
    // Achado EXISTENTE (também em origin/main): a página do Valle Pass acusa um aviso de hidratação em desenvolvimento.
    if (/hydrat/i.test(m.text())) return;
    errors.push(`console[${page.url()}]: ${m.text().slice(0, 160)}`);
  });
  return page;
}

try {
  setSale('closed');
  await startServer();
  browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_BROWSER_CHANNEL ? { channel: process.env.PLAYWRIGHT_BROWSER_CHANNEL } : {}) });

  // 1) venda fechada: botão "Em breve" inerte, avisos e valores
  const page = await newPage({ viewport: { width: 1280, height: 1000 } });
  await page.goto(productUrl);
  const section = page.getByTestId('valle-pass-presentation');
  await section.waitFor();
  assert.equal(await section.getAttribute('data-sale-state'), 'closed');
  const cta = page.getByTestId('valle-pass-cta');
  assert.equal(await cta.getAttribute('data-state'), 'closed');
  assert.equal(await cta.evaluate((el) => el.tagName), 'BUTTON', 'fechado: não é um link');
  assert.equal(await cta.isDisabled(), true);
  assert.equal(await cta.getAttribute('aria-disabled'), 'true');
  assert.equal((await cta.innerText()).trim().toLowerCase(), 'em breve');
  assert.equal(await cta.getAttribute('href'), null);
  await page.getByTestId('valle-pass-prelaunch-badge').waitFor();
  assert.match(await page.getByTestId('valle-pass-unavailable').innerText(), /ainda não está disponível para compra/);
  assert.equal(await page.getByTestId('valle-pass-unavailable').getAttribute('role'), 'status');
  assert.match(await page.getByTestId('valle-pass-closed-note').innerText(), /Vendas previstas a partir de 01\/11\/2026 — data sujeita a confirmação\.|A abertura das vendas será anunciada em breve\./);
  const describedBy = await cta.getAttribute('aria-describedby');
  assert.ok(describedBy && (await page.locator(`#${describedBy}`).count()) === 1, 'o botão aponta para o aviso que o explica');
  const values = await page.getByTestId('valle-pass-values').innerText();
  assert.match(values, /350/);
  assert.match(values, /R\$\s?500/);
  assert.match(values, /R\$\s?50(?!\d)/);
  assert.equal(await page.locator('a[href*="/cart/"]').count(), 0, 'nenhum link para o checkout na página');
  pass('1) venda fechada: "Em breve" é botão inerte (não é link), com aviso de indisponibilidade, previsão sujeita a confirmação e valores preservados');

  // 2) o endereço do checkout nem chega ao HTML do servidor; clicar não navega nem chama a Shopify
  const html = await (await fetch(productUrl)).text();
  assert.ok(!/\/cart\/\d+:\d+/.test(html), 'o HTML do servidor não pode conter o permalink do checkout');
  const before = page.url();
  await cta.click({ force: true }).catch(() => {});
  await page.waitForTimeout(400);
  assert.equal(page.url(), before);
  assert.deepEqual(externalRequests.filter((h) => h !== 'www.openstreetmap.org'), []);
  pass('2) venda fechada: o permalink do checkout não existe no HTML e o clique não leva a lugar nenhum');

  // 3) termos ainda não publicados: nada de link nem de afirmação de que existem
  assert.equal(await page.getByTestId('valle-pass-terms-link').count(), 0);
  assert.match(await page.getByTestId('valle-pass-terms-pending').innerText(), /serão publicados antes da abertura das vendas/);
  assert.ok(!/estão disponíveis|disponíveis abaixo/i.test(await section.innerText()));
  pass('3) termos ainda não publicados: a página diz que serão publicados e não aponta para lugar nenhum');

  // 4) celular
  const mobile = await newPage({ viewport: { width: 375, height: 800 } });
  await mobile.goto(productUrl);
  await mobile.getByTestId('valle-pass-cta').waitFor();
  const overflow = await mobile.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  assert.ok(overflow <= 1, `rolagem horizontal de ${overflow}px`);
  const box = await mobile.getByTestId('valle-pass-cta').boundingBox();
  assert.ok(box && box.x >= 0 && box.x + box.width <= 376 && box.height >= 44, 'botão dentro da tela e com área de toque de 44 px');
  pass('4) 375 px: sem rolagem horizontal e botão com área de toque adequada');

  // 5) venda aberta pela Shopify: fluxo normal de compra, sem avisos de pré-lançamento (nenhuma data abre nada: só o estado da Shopify)
  setSale('open');
  await page.reload();
  await page.getByTestId('valle-pass-cta').waitFor();
  assert.equal(await page.getByTestId('valle-pass-presentation').getAttribute('data-sale-state'), 'open');
  const open = page.getByTestId('valle-pass-cta');
  assert.equal(await open.evaluate((el) => el.tagName), 'A');
  assert.equal(await open.getAttribute('data-state'), 'open');
  assert.equal(await open.getAttribute('href'), 'https://127.0.0.1:8443/cart/49174518595684:1');
  assert.match((await open.innerText()).trim(), /^Comprar Valle Pass$/i);
  assert.equal(await page.getByTestId('valle-pass-prelaunch-badge').count(), 0);
  assert.equal(await page.getByTestId('valle-pass-unavailable').count(), 0);
  assert.equal(await page.getByTestId('valle-pass-closed-note').count(), 0);
  assert.equal(await page.getByTestId('valle-pass-terms-pending').count(), 0, 'aberto sem termos: não promete nem afirma termos');
  pass('5) venda aberta pela Shopify: botão volta a ser o link de compra normal, sem avisos de pré-lançamento');

  // 6) fail closed: estado ilegível/ausente = fechado
  rmSync(stateFile);
  await page.reload();
  await page.getByTestId('valle-pass-cta').waitFor();
  assert.equal(await page.getByTestId('valle-pass-presentation').getAttribute('data-sale-state'), 'closed');
  assert.equal(await page.locator('a[href*="/cart/"]').count(), 0);
  pass('6) sem informação de disponibilidade, a página fica fechada (fail closed)');

  // 7) termos publicados (endereço configurado): link nos dois estados, nunca o aviso de "serão publicados"
  // Antes de trocar de servidor: confere os erros das telas anteriores e fecha as páginas (o HMR do servidor antigo reclamaria durante a troca).
  assert.deepEqual(errors, [], 'erros de console/página nas telas anteriores');
  while (contexts.length) await contexts.pop().close();
  await stopServer();
  await startServer({ NEXT_PUBLIC_VALE_PASS_TERMS_URL: '/termos-valle-pass-teste' });
  setSale('closed');
  const withTerms = await newPage({ viewport: { width: 1280, height: 1000 } });
  await withTerms.goto(productUrl);
  await withTerms.getByTestId('valle-pass-terms-link').waitFor();
  assert.equal(await withTerms.getByTestId('valle-pass-terms-link').getAttribute('href'), '/termos-valle-pass-teste');
  assert.equal(await withTerms.getByTestId('valle-pass-terms-pending').count(), 0);
  setSale('open');
  await withTerms.reload();
  await withTerms.getByTestId('valle-pass-terms-link').waitFor();
  assert.equal(await withTerms.getByTestId('valle-pass-cta').getAttribute('data-state'), 'open');
  pass('7) com o endereço dos termos configurado, o link aparece (fechado e aberto) e o aviso "serão publicados" some');

  assert.deepEqual(externalRequests.filter((host) => host !== 'www.openstreetmap.org'), [], 'houve requisição externa');
  assert.deepEqual(errors, []);
  pass('8) nenhuma requisição externa e nenhum erro de console/página');
  console.log(`\n${results.length} verificações do navegador passaram.`);
} catch (error) {
  console.error('FALHOU:', error.message);
  process.exitCode = 1;
} finally {
  await browser?.close();
  for (const child of children) child.kill();
  rmSync(stateDir, { recursive: true, force: true });
}
