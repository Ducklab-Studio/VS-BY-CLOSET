import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright';

/**
 * Página /valle-pass num navegador de verdade. Shopify SIMULADA (fixture local): nenhuma rede externa, nenhum pedido, nenhum checkout, nenhuma venda real.
 * Cobre: pré-lançamento (botão "Em breve" inerte, sem link de checkout no HTML, `noindex`, preço, os dois vouchers, validade PREVISTA, quatro passos, termos
 * ainda não publicados), item "Valle Pass" em destaque no menu (desktop e celular) e chamada compacta na home; venda aberta SEM termos continua fechada; só
 * venda aberta E termos publicados liberam o link de compra (e ainda assim `noindex` enquanto o texto oficial não for aprovado); produto não encontrado na
 * Shopify = fechado (fail closed) com o preço aprovado; nada de promessas não aprovadas no texto; 375 px sem rolagem horizontal; sem rede externa e sem erros.
 */
const marketingDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixture = path.join(marketingDir, 'test/fixtures/size-variants-fixture.cjs');
const port = 3071;
const webUrl = `http://127.0.0.1:${port}`;
const pageUrl = `${webUrl}/valle-pass`;
const stateDir = mkdtempSync(path.join(tmpdir(), 'valle-pass-page-state-'));
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
  for (const key of ['NEXT_PUBLIC_VALE_PASS_TERMS_URL', 'NEXT_PUBLIC_VALE_PASS_PRODUCT_ID']) if (!(key in extraEnv)) delete env[key];
  server = spawn(process.execPath, [path.join(marketingDir, 'node_modules/next/dist/bin/next'), 'dev', '-p', String(port), '-H', '127.0.0.1'], { cwd: marketingDir, env, stdio: 'ignore' });
  children.push(server);
  await waitFor(pageUrl);
}
async function stopServer() {
  if (!server) return;
  server.kill();
  server = undefined;
  await waitFor(pageUrl, false);
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
    if (/hydrat/i.test(m.text())) return; // aviso de hidratação já existente em desenvolvimento (também na página do produto)
    errors.push(`console[${page.url()}]: ${m.text().slice(0, 160)}`);
  });
  return page;
}

/** Texto visível da página: nada que prometa o que ainda não tem texto oficial aprovado. */
const FORBIDDEN = /10\s?%|desconto|reembols|cancelamento|desist|estoque|\blotes?\b|unidades|limitad|restam|últimas/i;
const noForbiddenClaims = async (page, label) => assert.doesNotMatch(await page.getByTestId('vp-page').innerText(), FORBIDDEN, `${label}: promessa não aprovada no texto`);
const robots = (page) => page.locator('meta[name="robots"]').getAttribute('content');

try {
  setSale('closed');
  await startServer();
  browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_BROWSER_CHANNEL ? { channel: process.env.PLAYWRIGHT_BROWSER_CHANNEL } : {}) });

  // 1) pré-lançamento (Shopify fechada, sem termos)
  const page = await newPage({ viewport: { width: 1280, height: 1000 } });
  await page.goto(pageUrl);
  const main = page.getByTestId('vp-page');
  await main.waitFor();
  assert.equal(await main.getAttribute('data-sale-state'), 'closed');
  assert.equal(await main.getAttribute('data-purchasable'), 'no');
  assert.match(await page.locator('h1').innerText(), /Valle Pass\s*2027/);
  assert.match(await page.getByTestId('vp-price').innerText(), /R\$\s?350/);
  await page.getByTestId('vp-badge').waitFor();
  for (const where of ['hero', 'final']) {
    const cta = page.getByTestId(`vp-cta-${where}`);
    assert.equal(await cta.getAttribute('data-state'), 'closed');
    assert.equal(await cta.evaluate((el) => el.tagName), 'BUTTON', 'fechado: não é um link');
    assert.equal(await cta.isDisabled(), true);
    assert.equal(await cta.getAttribute('aria-disabled'), 'true');
    assert.equal(await cta.getAttribute('href'), null);
    assert.equal((await cta.innerText()).trim().toLowerCase(), 'em breve');
    const describedBy = await cta.getAttribute('aria-describedby');
    assert.ok(describedBy && (await page.locator(`#${describedBy}`).count()) === 1, 'o botão aponta para o aviso que o explica');
  }
  assert.match(await page.getByTestId('vp-note-hero').innerText(), /Vendas previstas a partir de 01\/11\/2026 — data sujeita a confirmação\.|A abertura das vendas será anunciada em breve\./);
  const showroom = await page.getByTestId('vp-voucher-valle-showroom').innerText();
  assert.match(showroom, /Valle Showroom/);
  assert.match(showroom, /R\$\s?500/);
  const closet = await page.getByTestId('vp-voucher-vs-by-closet').innerText();
  assert.match(closet, /VS BY CLOSET/);
  assert.match(closet, /R\$\s?50(?!\d)/);
  assert.match(showroom + closet, /Intransferível/i);
  const validity = await page.getByTestId('vp-validity').innerText();
  assert.match(validity, /01\/04\/2027/);
  assert.match(validity, /15\/10\/2027/);
  assert.match(await page.locator('.vp-validity').innerText(), /previstas, sujeitas à confirmação/i);
  assert.equal(await page.getByTestId('vp-step').count(), 4);
  assert.equal(await page.getByTestId('vp-terms-pending').count(), 1, 'termos ainda não publicados: o aviso aparece');
  assert.equal(await page.getByTestId('vp-terms-link').count(), 0);
  assert.equal(await page.locator('a[href*="/cart/"]').count(), 0, 'nenhum link para o checkout na página');
  assert.match((await robots(page)) ?? '', /noindex/);
  await noForbiddenClaims(page, 'pré-lançamento');
  pass('1) pré-lançamento: "Em breve" inerte (não é link), preço, os dois vouchers, validade PREVISTA, 4 passos, aviso de termos, noindex e nada de promessa não aprovada');

  // 2) o endereço do checkout nem chega ao HTML do servidor
  const html = await (await fetch(pageUrl)).text();
  assert.ok(!/\/cart\/\d+:\d+/.test(html), 'o HTML do servidor não pode conter o permalink do checkout');
  assert.match(html, /noindex/);
  pass('2) fechado: o permalink do checkout não existe no HTML do servidor');

  // 3) menu: item "Valle Pass" em destaque (desktop) e marcado como página atual
  const nav = page.getByRole('navigation', { name: 'Principal' });
  const navLink = nav.getByRole('link', { name: 'Valle Pass' });
  assert.equal(await navLink.getAttribute('aria-current'), 'page');
  assert.match((await navLink.getAttribute('class')) ?? '', /is-highlight/);
  pass('3) menu: "Valle Pass" em destaque e marcado como página atual');

  // 4) home: chamada compacta, sem preço nem botão de compra, levando à página; o item do menu navega
  const home = await newPage({ viewport: { width: 1280, height: 1000 } });
  await home.goto(webUrl);
  const callout = home.getByTestId('vp-home-callout');
  await callout.waitFor({ state: 'attached' });
  assert.equal(await callout.locator('a').getAttribute('href'), '/valle-pass');
  assert.equal(await callout.locator('button, a[href*="/cart/"]').count(), 0, 'a chamada da home não tem botão de compra');
  assert.doesNotMatch(await callout.innerText(), /R\$\s?350/, 'o preço vive só na página');
  assert.match(await callout.innerText(), /R\$\s?500/);
  await home.getByRole('navigation', { name: 'Principal' }).getByRole('link', { name: 'Valle Pass' }).click();
  await home.waitForURL('**/valle-pass');
  pass('4) home: chamada compacta aponta para /valle-pass (sem preço nem compra) e o item do menu navega até a página');

  // 5) celular (375 px): sem rolagem horizontal, botão inteiro, menu móvel com o item em destaque
  const phone = await newPage({ viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true });
  await phone.goto(pageUrl);
  await phone.getByTestId('vp-cta-hero').waitFor();
  assert.ok((await phone.evaluate(() => document.documentElement.scrollWidth)) <= 375, 'sem rolagem horizontal em 375 px');
  const box = await phone.getByTestId('vp-cta-hero').boundingBox();
  assert.ok(box && box.x >= 0 && box.x + box.width <= 375, 'o botão cabe na tela');
  await phone.getByRole('button', { name: 'Abrir menu' }).click();
  const mobileLink = phone.getByRole('navigation', { name: 'Menu mobile' }).getByRole('link', { name: /Valle Pass/ });
  assert.match((await mobileLink.getAttribute('class')) ?? '', /is-highlight/);
  pass('5) celular (375 px): sem rolagem horizontal, botão dentro da tela e menu móvel com o item em destaque');

  // 6) Shopify aberta, mas SEM termos publicados: a página continua em pré-lançamento (botão desabilitado, sem checkout no HTML)
  setSale('open');
  await page.goto(pageUrl);
  await page.getByTestId('vp-cta-hero').waitFor();
  assert.equal(await page.getByTestId('vp-page').getAttribute('data-sale-state'), 'open');
  assert.equal(await page.getByTestId('vp-page').getAttribute('data-purchasable'), 'no');
  assert.equal(await page.getByTestId('vp-cta-hero').evaluate((el) => el.tagName), 'BUTTON');
  assert.match(await page.getByTestId('vp-note-hero').innerText(), /somente depois da publicação dos termos e condições/);
  assert.equal(await page.locator('a[href*="/cart/"]').count(), 0);
  assert.ok(!/\/cart\/\d+:\d+/.test(await (await fetch(pageUrl)).text()), 'sem termos, o checkout nem chega ao HTML');
  assert.match((await robots(page)) ?? '', /noindex/);
  pass('6) Shopify aberta sem termos publicados: continua em pré-lançamento (botão desabilitado, sem checkout no HTML, noindex)');

  // 7) produto fora da Shopify (ID desconhecido): fechado, com o preço aprovado de referência
  assert.deepEqual(errors, [], 'erros de console/página nas telas anteriores');
  while (contexts.length) await contexts.pop().close();
  await stopServer();
  await startServer({ NEXT_PUBLIC_VALE_PASS_PRODUCT_ID: '999999999' });
  setSale('open');
  const unknown = await newPage({ viewport: { width: 1280, height: 1000 } });
  await unknown.goto(pageUrl);
  await unknown.getByTestId('vp-cta-hero').waitFor();
  assert.equal(await unknown.getByTestId('vp-page').getAttribute('data-sale-state'), 'closed');
  assert.equal(await unknown.getByTestId('vp-cta-hero').evaluate((el) => el.tagName), 'BUTTON');
  assert.match(await unknown.getByTestId('vp-price').innerText(), /R\$\s?350,00/);
  pass('7) produto não encontrado na Shopify: fechado (fail closed) e com o preço aprovado de referência');

  // 8) venda aberta E termos publicados: só então o link de compra aparece (e continua noindex enquanto o texto oficial não é aprovado)
  assert.deepEqual(errors, [], 'erros de console/página nas telas anteriores');
  while (contexts.length) await contexts.pop().close();
  await stopServer();
  await startServer({ NEXT_PUBLIC_VALE_PASS_TERMS_URL: '/termos-valle-pass-teste' });
  setSale('open');
  const ready = await newPage({ viewport: { width: 1280, height: 1000 } });
  await ready.goto(pageUrl);
  await ready.getByTestId('vp-cta-hero').waitFor();
  assert.equal(await ready.getByTestId('vp-page').getAttribute('data-purchasable'), 'yes');
  const buy = ready.getByTestId('vp-cta-hero');
  assert.equal(await buy.getAttribute('data-state'), 'open');
  assert.match((await buy.getAttribute('href')) ?? '', /\/cart\/49174518595684:1$/);
  assert.equal(await ready.getByTestId('vp-badge').count(), 0, 'pronta para compra: sem selo de pré-lançamento');
  assert.equal(await ready.getByTestId('vp-terms-link').getAttribute('href'), '/termos-valle-pass-teste');
  assert.equal(await ready.getByTestId('vp-terms-pending').count(), 0);
  assert.match(await ready.getByTestId('vp-step').first().innerText(), /checkout oficial/);
  assert.doesNotMatch(await ready.getByTestId('vp-step').first().innerText(), /pré-lançamento/i);
  assert.match((await robots(ready)) ?? '', /noindex/, 'texto oficial ainda não aprovado: continua noindex');
  await noForbiddenClaims(ready, 'venda aberta com termos');
  setSale('closed');
  await ready.reload();
  await ready.getByTestId('vp-cta-hero').waitFor();
  assert.equal(await ready.getByTestId('vp-cta-hero').evaluate((el) => el.tagName), 'BUTTON', 'a Shopify fechou: volta a ficar inerte');
  assert.equal(await ready.getByTestId('vp-terms-link').count(), 1, 'termos publicados continuam aparecendo');
  pass('8) venda aberta E termos publicados: só então o link de compra aparece; fechando a Shopify, volta a ser inerte; continua noindex sem texto aprovado');

  // O único destino externo permitido é o mapa do rodapé (iframe do OpenStreetMap), o mesmo que os outros testes da vitrine já aceitam.
  assert.deepEqual(externalRequests.filter((host) => host !== 'www.openstreetmap.org'), [], `houve requisição externa: ${[...new Set(externalRequests)].join(', ')}`);
  assert.deepEqual(errors, []);
  pass('9) nenhuma requisição externa e nenhum erro de console/página');
  console.log(`\n${results.length} verificações da página do Valle Pass passaram.`);
} catch (error) {
  console.error('FALHOU:', error.message);
  process.exitCode = 1;
} finally {
  await browser?.close();
  for (const child of children) child.kill();
  rmSync(stateDir, { recursive: true, force: true });
}
