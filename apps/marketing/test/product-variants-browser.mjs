import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright';

/**
 * Escolha de variante (tamanho, tamanho × cor) na página da peça, num navegador de verdade. Shopify SIMULADA (fixture local no servidor do Next e rota
 * no navegador): nenhuma rede externa, nenhum pedido, nenhum HOLD. Cobre: nenhuma variante escolhida por padrão, esgotado riscado e não selecionável,
 * preço da variante escolhida, calendário só com a variante exata, escolha no endereço (?v=) e recarga, teclado, combinação de duas opções, peça de
 * variante única sem seletor, Valle Pass sem seletor nem calendário, e 375 px sem rolagem horizontal.
 */
const marketingDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixture = path.join(marketingDir, 'test/fixtures/size-variants-fixture.cjs');
const webUrl = 'http://127.0.0.1:3057';
const children = [];
const externalRequests = [];
const errors = [];
let browser;

async function waitFor(url) {
  for (let i = 0; i < 180; i++) {
    try {
      if ((await fetch(url, { signal: AbortSignal.timeout(2000) })).status < 500) return;
    } catch { /* subindo */ }
    await delay(500);
  }
  throw new Error('Servidor local não iniciou.');
}

const results = [];
const pass = (name) => { results.push(name); console.log(`  ✓ ${name}`); };
const idOf = (n) => `gid://shopify/ProductVariant/${n}`;
const stock = { 70013: false, 70024: false };

async function newPage(options = {}) {
  const context = await browser.newContext(options);
  await context.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    if (['localhost', '127.0.0.1'].includes(url.hostname) && url.port !== '8443') return route.continue();
    if (url.host === '127.0.0.1:8443') {
      // consulta de estoque fresco feita pelo navegador (a Shopify simulada responde)
      const body = JSON.parse(route.request().postData() || '{}');
      const ids = body.variables?.ids ?? [];
      const nodes = ids.map((id) => {
        const n = Number(String(id).split('/').pop());
        const available = stock[n] !== false;
        return { id, availableForSale: available, quantityAvailable: available ? 3 : 0, currentlyNotInStock: !available };
      });
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ data: { nodes } }) });
    }
    externalRequests.push(url.hostname);
    return route.abort();
  });
  const page = await context.newPage();
  page.setDefaultTimeout(30_000);
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource|favicon|net::ERR/.test(m.text())) {
      // Achado EXISTENTE (também em origin/main, sem relação com a escolha de variante): a página do Valle Pass acusa um aviso de hidratação em desenvolvimento.
      if (/hydrat/i.test(m.text()) && page.url().includes('/valle-pass-fixture')) return;
      errors.push(`console[${page.url()}]: ${m.text().slice(0, 160)}`);
    }; });
  return page;
}
const option = (page, group, value) => page.locator(`[data-option="${group}"] button[role="radio"][data-value="${value.toLowerCase()}"]`);

try {
  const env = {
    ...process.env,
    NODE_OPTIONS: `--require=${fixture}`,
    SIZE_VARIANTS_FIXTURE: '1',
    NEXT_PUBLIC_SHOPIFY_STORE_DOMAIN: '127.0.0.1:8443',
    NEXT_PUBLIC_SHOPIFY_STOREFRONT_TOKEN: 'fixture',
    NEXT_TELEMETRY_DISABLED: '1',
    NODE_ENV: 'development',
  };
  for (const key of ['NEXT_PUBLIC_AVAILABILITY_URL', 'NEXT_PUBLIC_HOLDS_URL', 'RESERVATIONS_API_URL', 'RESERVATIONS_API_ADMIN_URL']) delete env[key];
  children.push(spawn(process.execPath, [path.join(marketingDir, 'node_modules/next/dist/bin/next'), 'dev', '-p', '3057', '-H', '127.0.0.1'], { cwd: marketingDir, env, stdio: 'ignore', windowsHide: true }));
  await waitFor(`${webUrl}/pecas/peca-unica`);
  browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_BROWSER_CHANNEL ? { channel: process.env.PLAYWRIGHT_BROWSER_CHANNEL } : {}) });

  // 1) Várias variantes: nenhuma vem escolhida; "a partir de"; calendário só convida a escolher
  const page = await newPage({ viewport: { width: 1280, height: 1000 } });
  await page.goto(`${webUrl}/pecas/peca-tamanhos`);
  const picker = page.getByTestId('variant-picker');
  await picker.waitFor();
  assert.equal(await picker.getAttribute('data-complete'), 'false');
  assert.equal(await page.locator('button[role="radio"][aria-checked="true"]').count(), 0);
  await page.getByTestId('variant-price').filter({ hasText: /a partir de/i }).waitFor();
  await page.getByTestId('rental-choose-variant').waitFor();
  assert.equal(await page.locator('#rental-calendar [role="group"]').count(), 0);
  pass('1) várias variantes: nenhuma vem escolhida, preço "a partir de" e o calendário só convida a escolher');

  // 2) esgotado: riscado, marcado como indisponível e não selecionável
  const soldOut = option(page, 'Tamanho', 'G');
  assert.equal(await soldOut.getAttribute('data-state'), 'soldout');
  assert.equal(await soldOut.getAttribute('aria-disabled'), 'true');
  assert.match(await soldOut.getAttribute('aria-label'), /indisponível/);
  await soldOut.click({ force: true }); // aria-disabled: o Playwright recusa clicar sem "force"; o app é quem tem de ignorar
  assert.equal(await picker.getAttribute('data-complete'), 'false');
  await page.getByTestId('variant-status').filter({ hasText: /indisponível/ }).waitFor();
  pass('2) tamanho esgotado aparece riscado, avisa "indisponível" e não pode ser escolhido');

  // 3) escolher M: preço da variante, calendário com a variante exata, endereço com ?v=
  await option(page, 'Tamanho', 'M').click();
  await page.getByTestId('variant-chosen').filter({ hasText: 'M' }).waitFor();
  assert.equal(await picker.getAttribute('data-complete'), 'true');
  await page.waitForFunction(() => document.querySelector('[data-testid="variant-price"]')?.getAttribute('data-variant-id')?.endsWith('/70012'));
  assert.match(await page.getByTestId('variant-price').innerText(), /150/);
  await page.locator('#rental-calendar').waitFor();
  assert.equal(await page.getByTestId('rental-choose-variant').count(), 0);
  await page.waitForFunction(() => new URL(location.href).searchParams.get('v') === '70012');
  pass('3) escolher M: preço e calendário são os da variante M e o endereço guarda ?v=70012');

  // 4) recarregar: a mesma escolha volta; trocar para P troca preço e variante
  await page.reload();
  await page.getByTestId('variant-chosen').filter({ hasText: 'M' }).waitFor();
  await option(page, 'Tamanho', 'P').click();
  await page.getByTestId('variant-chosen').filter({ hasText: 'P' }).waitFor();
  await page.waitForFunction(() => document.querySelector('[data-testid="variant-price"]')?.getAttribute('data-variant-id')?.endsWith('/70011'));
  assert.match(await page.getByTestId('variant-price').innerText(), /140/);
  pass('4) a escolha volta ao recarregar; trocar de tamanho troca preço e variante');

  // 5) variante esgotada pedida pelo endereço NÃO é aceita
  await page.goto(`${webUrl}/pecas/peca-tamanhos?v=70013`);
  await picker.waitFor();
  await page.waitForTimeout(800);
  assert.equal(await picker.getAttribute('data-complete'), 'false');
  assert.equal(await page.locator('button[role="radio"][aria-checked="true"]').count(), 0);
  pass('5) ?v= de uma variante esgotada não é aceito: nada fica escolhido');

  // 6) teclado: seta move para a próxima opção disponível
  await page.goto(`${webUrl}/pecas/peca-tamanhos?v=70011`);
  await page.getByTestId('variant-chosen').filter({ hasText: 'P' }).waitFor();
  await option(page, 'Tamanho', 'P').focus();
  await page.keyboard.press('ArrowRight');
  await page.getByTestId('variant-chosen').filter({ hasText: 'M' }).waitFor();
  pass('6) teclado: a seta direita escolhe a próxima opção disponível');

  // 7) duas opções: a combinação sem estoque (M + Vinho) não pode ser formada; precisa das duas escolhas
  const duo = await newPage({ viewport: { width: 1280, height: 1000 } });
  await duo.goto(`${webUrl}/pecas/peca-duas-opcoes`);
  await duo.getByTestId('variant-picker').waitFor();
  assert.equal(await duo.locator('[data-option]').count(), 2);
  await option(duo, 'Tamanho', 'M').click();
  assert.equal(await duo.getByTestId('variant-picker').getAttribute('data-complete'), 'false'); // falta a cor
  assert.equal(await option(duo, 'Cor', 'Vinho').getAttribute('data-state'), 'soldout'); // M + Vinho esgotou
  await option(duo, 'Cor', 'Preto').click();
  await duo.waitForFunction(() => document.querySelector('[data-testid="variant-price"]')?.getAttribute('data-variant-id')?.endsWith('/70023'));
  assert.equal(await duo.getByTestId('variant-picker').getAttribute('data-complete'), 'true');
  pass('7) duas opções: só com as duas escolhidas há variante; a combinação esgotada fica riscada');

  // 8) variante única: sem seletor, calendário direto; Valle Pass: sem seletor e sem calendário
  const single = await newPage({ viewport: { width: 1280, height: 1000 } });
  await single.goto(`${webUrl}/pecas/peca-unica`);
  await single.locator('#rental-calendar').waitFor();
  assert.equal(await single.getByTestId('variant-picker').count(), 0);
  assert.equal(await single.getByTestId('rental-choose-variant').count(), 0);
  const vp = await newPage({ viewport: { width: 1280, height: 1000 } });
  await vp.goto(`${webUrl}/pecas/valle-pass-fixture`);
  await vp.getByRole('heading', { name: /Valle Pass/i }).first().waitFor();
  await vp.waitForTimeout(1500);
  assert.equal(await vp.getByTestId('variant-picker').count(), 0);
  assert.equal(await vp.locator('#rental-calendar').count(), 0);
  pass('8) variante única segue sem seletor; o Valle Pass não tem seletor nem calendário de aluguel');

  // 9) celular: 375 px sem rolagem horizontal
  const mobile = await newPage({ viewport: { width: 375, height: 800 } });
  await mobile.goto(`${webUrl}/pecas/peca-duas-opcoes`);
  await mobile.getByTestId('variant-picker').waitFor();
  const overflow = await mobile.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  assert.ok(overflow <= 1, `rolagem horizontal de ${overflow}px`);
  pass('9) 375 px: sem rolagem horizontal');

  // O mapa de retirada da página tenta carregar o OpenStreetMap; a rota do teste o ABORTA (nada sai). Qualquer outro host externo reprova.
  assert.deepEqual(externalRequests.filter((host) => host !== 'www.openstreetmap.org'), [], 'houve requisição externa');
  assert.deepEqual(errors, []);
  pass('10) nenhuma requisição externa e nenhum erro de console/página');
  console.log(`\n${results.length} verificações do navegador passaram.`);
} catch (error) {
  console.error('FALHOU:', error.message);
  process.exitCode = 1;
} finally {
  await browser?.close();
  for (const child of children) child.kill();
}
