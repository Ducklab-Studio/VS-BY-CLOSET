// Run against the isolated fixture server, never against production.
// PLAYWRIGHT_MODULE may point to an existing Playwright installation.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { products } = require('./catalog-visual-fixture.cjs');
const base = process.env.CATALOG_TEST_URL || 'http://localhost:3017';
assert.equal(new URL(base).hostname, 'localhost');
const output = path.resolve('artifacts/catalog-audit');
fs.mkdirSync(output, { recursive: true });
const widths = [320, 360, 375, 390, 414, 768, 820, 900, 1024, 1440];
const results = [];
const accessibility = [];
const axeFolder = fs.readdirSync('node_modules/.pnpm').find(name => name.startsWith('axe-core@'));
const axePath = path.resolve('node_modules/.pnpm', axeFolder, 'node_modules/axe-core/axe.min.js');

(async () => {
  const browser = await chromium.launch({ headless: true, channel: process.env.BROWSER_CHANNEL || 'msedge' });
  try {
    const context = await browser.newContext({ reducedMotion: 'reduce' });
    const page = await context.newPage();
    let mode = 'available';
    let cart = null;
    let availabilityCalls = 0;
    const consoleErrors = [];
    page.on('pageerror', error => consoleErrors.push(error.message));
    page.on('console', message => { if (message.type() === 'error' && mode === 'available') consoleErrors.push(message.text()); });
    await context.route('**/*', async route => {
      const request = route.request();
      const url = new URL(request.url());
      if (url.pathname.includes('availability')) {
        availabilityCalls++;
        if (mode === 'loading') await new Promise(resolve => setTimeout(resolve, 2000));
        if (mode === 'error') return route.fulfill({ status: 503, json: { error: 'Simulated unavailable service' } });
        const days = [];
        const start = new Date(url.searchParams.get('from') + 'T12:00:00');
        const end = new Date(url.searchParams.get('to') + 'T12:00:00');
        for (let date = new Date(start); date <= end; date.setDate(date.getDate() + 1)) {
          const iso = date.toISOString().slice(0, 10);
          const ret = new Date(date); ret.setDate(ret.getDate() + 2);
          const bookable = mode !== 'unavailable' && date.getDay() !== 0;
          days.push({ date: iso, bookable, quantityAvailable: bookable ? 3 : 0, reason: bookable ? null : 'occupied', durationDays: 2, calculatedReturnDate: ret.toISOString().slice(0, 10) });
        }
        return route.fulfill({ json: { shopifyVariantId: url.searchParams.get('shopifyVariantId'), countedPieces: 1, unitsTotal: 3, days } });
      }
      if (url.pathname === '/test-duration') return route.fulfill({ json: { durationDays: 2 } });
      if (url.hostname === 'catalog-fixture.invalid') {
        const body = request.postDataJSON();
        if (/mutation/.test(body.query)) {
          const item = products[0];
          const line = body.variables.lines?.[0];
          cart = { id: 'visual-test-cart', totalQuantity: 1, cost: { subtotalAmount: item.variants.nodes[0].price, totalAmount: item.variants.nodes[0].price }, lines: { nodes: [{ id: 'visual-test-line', quantity: 1, attributes: line?.attributes || [], merchandise: { ...item.variants.nodes[0], product: item } }] } };
          return route.fulfill({ json: { data: { cartCreate: { cart, userErrors: [] }, cartLinesAdd: { cart, userErrors: [] } } } });
        }
        return route.fulfill({ json: { data: { cart } } });
      }
      // No request may reach Shopify, a reservation service, or any external host.
      if (url.origin === base && !url.pathname.startsWith('/test-holds') && !url.pathname.startsWith('/test-checkout')) return route.continue();
      return route.abort();
    });

    async function go(route) {
      await page.goto(base + route);
      await page.locator('h1').waitFor();
      await page.addStyleTag({ content: 'nextjs-portal { display: none; }' });
      await page.waitForFunction(() => [...document.querySelectorAll('img')].filter(image => image.loading !== 'lazy').every(image => image.complete));
    }
    async function capture(name, width, fullPage = true) {
      if ([320, 768, 1440].includes(width) && ['catalog', 'product', 'drawer', 'cart', 'valle-pass'].includes(name)) {
        await page.addScriptTag({ path: axePath });
        const violations = await page.evaluate(async () => (await axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'] } })).violations.map(issue => ({ id: issue.id, impact: issue.impact, nodes: issue.nodes.map(node => ({ target: node.target, summary: node.failureSummary })) })));
        accessibility.push({ name, width, violations });
      }
      await page.screenshot({ path: path.join(output, `after-${name}-${width}.png`), fullPage });
    }
    async function fits(label, width) {
      const size = await page.evaluate(() => ({ width: innerWidth, scroll: document.documentElement.scrollWidth }));
      assert.ok(size.scroll <= size.width, `${label} overflows at ${width}: ${JSON.stringify(size)}`);
    }

    for (const width of widths) {
      await page.setViewportSize({ width, height: 900 });
      await go('/pecas');
      await page.locator('.catalog-product').first().waitFor();
      assert.equal(await page.locator('.catalog-product').count(), 8);
      const columns = await page.locator('.catalog-grid').evaluate(element => getComputedStyle(element).gridTemplateColumns.split(' ').length);
      assert.equal(columns, width >= 1100 ? 4 : width >= 768 ? 3 : 2);
      for (const image of await page.locator('.catalog-product img').all()) { await image.scrollIntoViewIfNeeded(); await image.evaluate(element => element.decode()); }
      await page.evaluate(() => window.scrollTo(0, 0));
      await fits('catalog', width);
      await capture('catalog', width);
      if (width < 768) {
        await page.getByRole('button', { name: 'Abrir menu', exact: true }).click();
        await fits('menu', width);
        await capture('menu', width, false);
        await page.keyboard.press('Escape');
        assert.equal(await page.getByRole('button', { name: 'Abrir menu', exact: true }).getAttribute('aria-expanded'), 'false');
      }
      await page.locator('.catalog-product').first().click();
      await page.locator('[data-date]:not([disabled])').first().waitFor();
      await page.locator('.gallery-main img').evaluate(image => image.decode());
      await fits('product', width);
      const placement = await page.locator('.product-detail-grid').evaluate(element => {
        const gallery = element.firstElementChild.getBoundingClientRect();
        const info = element.lastElementChild.getBoundingClientRect();
        return { sideBySide: info.x > gallery.x + 100, galleryBottom: gallery.bottom, infoTop: info.top };
      });
      assert.equal(placement.sideBySide, width >= 768);
      if (width < 768) assert.ok(placement.galleryBottom <= placement.infoTop);
      assert.equal(await page.getByRole('button', { name: 'Alugar agora', exact: true }).isDisabled(), true);
      await capture('product', width);
      await page.getByRole('button', { name: 'Ver foto 2 de Jaqueta Preta', exact: true }).click();
      assert.equal(await page.getByRole('button', { name: 'Ver foto 2 de Jaqueta Preta', exact: true }).getAttribute('aria-pressed'), 'true');
      await page.getByRole('button', { name: 'Ampliar foto de Jaqueta Preta', exact: true }).click();
      await page.getByRole('button', { name: 'Aumentar foto', exact: true }).click();
      await page.keyboard.press('ArrowLeft');
      await capture('lightbox', width, false);
      await page.keyboard.press('Escape');
      assert.equal(await page.locator('.gallery-lightbox').evaluate(element => element.open), false);
      assert.equal(await page.locator('.gallery-main').evaluate(element => element === document.activeElement), true);
      await page.locator('[data-date]:not([disabled])').first().click();
      assert.equal(await page.getByRole('button', { name: 'Alugar agora', exact: true }).isDisabled(), false);
      await page.locator('.rental-calendar').scrollIntoViewIfNeeded();
      await fits('calendar selected', width);
      await capture('calendar', width, false);
      await page.getByRole('button', { name: 'Alugar agora', exact: true }).click();
      await page.getByRole('dialog', { name: 'Seu closet de viagem' }).waitFor();
      await page.locator('.drawer-item').waitFor();
      await fits('cart drawer', width);
      const drawerFits = await page.locator('.cart-drawer').evaluate(element => {
        const rect = element.getBoundingClientRect();
        return rect.left >= 0 && rect.right <= innerWidth && rect.bottom <= innerHeight && element.scrollWidth <= element.clientWidth;
      });
      assert.ok(drawerFits, `drawer at ${width}`);
      await capture('drawer', width, false);
      await page.getByRole('link', { name: /Revisar e finalizar reserva/ }).click();
      await page.getByRole('button', { name: 'Finalizar reserva', exact: true }).waitFor();
      await fits('cart page', width);
      await capture('cart', width);
      await page.evaluate(() => localStorage.clear()); cart = null;
      await go('/pecas/valle-pass-fixture');
      const callsBefore = availabilityCalls;
      await page.getByRole('link', { name: 'Comprar Valle Pass', exact: true }).waitFor();
      assert.equal(await page.locator('.rental-calendar').count(), 0);
      assert.equal(await page.getByRole('link', { name: 'Comprar Valle Pass', exact: true }).getAttribute('href'), 'https://catalog-fixture.invalid/cart/49174518595684:1');
      await fits('Valle Pass', width);
      await capture('valle-pass', width);
      assert.equal(availabilityCalls, callsBefore);
      results.push({ width, columns, overflow: false, product: 'passed', gallery: 'passed', calendar: 'passed', cart: 'passed', vallePass: 'passed' });
      console.log(`PASS ${width}px`);
    }
    await page.setViewportSize({ width: 320, height: 640 });
    for (const state of ['loading', 'error', 'unavailable']) {
      mode = state;
      await go('/pecas/peca-fixture-0');
      if (state === 'loading') await page.getByText('Carregando disponibilidade…', { exact: true }).waitFor();
      if (state === 'error') await page.getByText('Não foi possível consultar a disponibilidade no momento.', { exact: true }).waitFor();
      if (state === 'unavailable') await page.getByText('Não há datas disponíveis neste mês. Fale com o atendimento para verificar outras opções.', { exact: true }).waitFor();
      assert.equal(await page.getByRole('button', { name: 'Alugar agora', exact: true }).isDisabled(), true);
      await fits(state, 320);
      await capture(state, 320);
    }
    mode = 'broken-image';
    await context.route('**/_next/image?**', route => route.abort());
    await go('/pecas/peca-fixture-0');
    await page.locator('.gallery-main .product-image-fallback').waitFor();
    await capture('broken-image', 320);
    await context.unroute('**/_next/image?**');
    mode = 'available';
    await go('/pecas/peca-fixture-4');
    await page.getByText('Sem foto cadastrada', { exact: true }).waitFor();
    await capture('missing-image', 320);
    await go('/pecas');
    await page.locator('.catalog-product').nth(1).click();
    await page.locator('[data-date]:not([disabled])').first().waitFor();
    await page.getByRole('button', { name: /Ver foto 2 de/ }).click();
    await page.locator('[data-date]:not([disabled])').first().click();
    await page.getByRole('navigation', { name: 'Navegação da peça' }).getByRole('link', { name: 'Peças', exact: true }).click();
    await page.locator('.catalog-product').first().click();
    await page.locator('[data-date]:not([disabled])').first().waitFor();
    assert.equal(await page.getByRole('button', { name: 'Ver foto 1 de Jaqueta Preta', exact: true }).getAttribute('aria-pressed'), 'true');
    assert.equal(await page.getByRole('button', { name: 'Alugar agora', exact: true }).isDisabled(), true);
    await go('/pecas');
    await page.getByLabel('Categoria', { exact: true }).selectOption('botas-premium');
    await page.getByText('Nenhuma peça cadastrada neste tipo ainda.', { exact: true }).waitFor();
    await capture('empty-category', 320);
    fs.writeFileSync(path.join(output, 'accessibility-results.json'), JSON.stringify(accessibility, null, 2));
    fs.writeFileSync(path.join(output, 'console-errors.json'), JSON.stringify(consoleErrors, null, 2));
    assert.equal(accessibility.reduce((sum, entry) => sum + entry.violations.length, 0), 0, 'Accessibility violations; see accessibility-results.json');
    console.log('Accessibility: 0 violations');
    assert.equal(consoleErrors.length, 0, 'Unexpected console or hydration errors; see console-errors.json');
    fs.writeFileSync(path.join(output, 'visual-results.json'), JSON.stringify({ fixtures: true, results, states: ['loading', 'error', 'unavailable', 'missing-image', 'empty-category'], consoleErrors }, null, 2));
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
