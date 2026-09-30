import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';

// Valor da reserva de aluguel: soma exata de TODAS as peças (o TS real,
// transpilado) e o carrinho com a Cart API da Shopify simulada — sem rede.
const root = new URL('../', import.meta.url);
const ts = createRequire(new URL('package.json', root))('typescript');
const transpile = (path) =>
  ts.transpileModule(readFileSync(new URL(path, root), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2021 },
  }).outputText;
const plain = (value) => JSON.parse(JSON.stringify(value));
const load = (path, globals = {}) => {
  const exports = {};
  runInNewContext(transpile(path), { exports, JSON, Set, Map, Number, Math, Array, String, Object, Error, ...globals });
  return exports;
};

const price = load('src/lib/rental-price.ts');
const selectionLib = load('src/lib/rental-selection.ts', { Date });
const shopifyLib = load('src/lib/shopify.ts', { process: { env: {} }, Intl });
const VALE_PASS_VARIANT = 'gid://shopify/ProductVariant/49174518595684';
const valePassLib = load('src/lib/vale-pass-product.ts', { process: { env: {} }, require: () => shopifyLib });
const { amountToCents, parseCents, centsToAmount, sumPrices, selectionTotal, reservationSummary } = price;

const item = (id, amount, currencyCode = 'BRL', quantity) => ({ id, amount, currencyCode, ...(quantity ? { quantity } : {}) });
const totalOf = (...amounts) => plain(sumPrices(amounts.map((a, i) => item(`p${i}`, a))));
const ok = (amount, cents) => ({ status: 'ok', cents, amount, currencyCode: 'BRL' });

test('produto de R$ 200 sozinho e produto de R$ 0 sozinho', () => {
  assert.deepEqual(totalOf('200.0'), ok('200.00', 20000));
  // Zero é preço válido: total R$ 0,00 — não "a confirmar", não ausente.
  assert.deepEqual(totalOf('0.0'), ok('0.00', 0));
  assert.equal(shopifyLib.formatPrice('0.0', 'BRL'), shopifyLib.formatPrice('0', 'BRL'));
  assert.match(shopifyLib.formatPrice('0.0', 'BRL'), /0,00/);
});

test('R$ 200 + R$ 0 = R$ 200 e R$ 0 + R$ 200 = R$ 200 (o zero não zera as outras peças)', () => {
  assert.deepEqual(totalOf('200.0', '0.0'), ok('200.00', 20000));
  assert.deepEqual(totalOf('0.0', '200.0'), ok('200.00', 20000));
});

test('R$ 200 + R$ 150 = R$ 350; três preços diferentes; ordem nunca muda o total', () => {
  assert.deepEqual(totalOf('200.0', '150.0'), ok('350.00', 35000));
  const three = ['200.0', '0.0', '89.90'];
  const permutations = [[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]];
  for (const order of permutations) assert.deepEqual(totalOf(...order.map((i) => three[i])), ok('289.90', 28990));
  // Centavos inteiros: 0,10 + 0,20 é 0,30 exatos (no ponto flutuante seria 0,30000000000000004).
  assert.deepEqual(totalOf('0.10', '0.20'), ok('0.30', 30));
  assert.deepEqual(totalOf('10.05', '89.90', '150'), ok('249.95', 24995));
});

test('preço como string, número e casas decimais', () => {
  for (const [input, cents] of [['200', 20000], ['200.0', 20000], ['200.00', 20000], [' 200.00 ', 20000], ['0', 0], ['0.0', 0], ['89.9', 8990], ['1.005', 101], ['0.999', 100], [200, 20000], [0, 0], [89.9, 8990]]) {
    assert.equal(amountToCents(input), cents, `amountToCents(${JSON.stringify(input)})`);
  }
  assert.equal(centsToAmount(8990), '89.90');
  assert.equal(centsToAmount(5), '0.05');
  assert.equal(centsToAmount(0), '0.00');
});

test('preço em centavos', () => {
  assert.equal(parseCents(20000), 20000);
  assert.equal(parseCents('20000'), 20000);
  assert.equal(parseCents(0), 0);
  for (const bad of [200.5, -1, '200.00', '', null, undefined, NaN]) assert.equal(parseCents(bad), null, `parseCents(${String(bad)})`);
  // Um valor em centavos vira o texto decimal da Shopify e soma como qualquer outro.
  assert.deepEqual(totalOf(centsToAmount(parseCents(20000)), centsToAmount(parseCents('0')), centsToAmount(15000)), ok('350.00', 35000));
});

test('preço nulo, ausente ou ilegível nunca vira zero (e nunca some com as outras peças)', () => {
  for (const bad of [null, undefined, '', '   ', 'abc', '200,00', '-5', -5, NaN, Infinity, '1e3', {}]) {
    assert.equal(amountToCents(bad), null, `amountToCents(${String(bad)})`);
  }
  // Com uma peça sem preço o total fica "a confirmar" — não R$ 0 e não só o das outras.
  assert.deepEqual(plain(sumPrices([item('a', '200.0'), item('b', null)])), { status: 'missing', missing: ['b'] });
  assert.deepEqual(plain(sumPrices([item('a', '200.0'), item('b', undefined)])), { status: 'missing', missing: ['b'] });
  assert.deepEqual(plain(sumPrices([item('a', '200.0'), item('b', '')])), { status: 'missing', missing: ['b'] });
  assert.deepEqual(plain(sumPrices([item('a', '200.0'), item('b', '0', null)])), { status: 'missing', missing: ['b'] });
  assert.deepEqual(plain(sumPrices([item('a', '200.0'), item('b', '0', 'CLP')])), { status: 'mixed_currency' });
  assert.deepEqual(plain(sumPrices([])), { status: 'empty' });
  // Formatação: ausente não é exibido como "R$ 0,00"; moeda inválida não derruba a página.
  assert.equal(shopifyLib.formatPrice('', 'BRL'), '');
  assert.equal(shopifyLib.formatPrice(null, 'BRL'), '');
  assert.equal(shopifyLib.formatPrice(undefined, 'BRL'), '');
  assert.equal(shopifyLib.formatPrice('200.0', null), '');
});

test('quantidade multiplica o preço da linha', () => {
  assert.deepEqual(plain(sumPrices([item('a', '200.0', 'BRL', 2), item('b', '0.0', 'BRL', 3), item('c', '50', 'BRL', 0)])), ok('450.00', 45000));
});

// ── resumo da reserva: seleção + carrinho, Shopify como fonte de verdade ──
const piece = (n, priceAmount, currencyCode = 'BRL') => ({ variantId: `gid://shopify/ProductVariant/${n}`, title: `Peça ${n}`, handle: `peca-${n}`, priceAmount, currencyCode });
const cartLine = (n, amount, quantity = 1, id = `L${n}`) => ({
  id, quantity, attributes: [],
  merchandise: { id: `gid://shopify/ProductVariant/${n}`, price: { amount, currencyCode: 'BRL' }, product: { title: `Peça ${n}`, handle: `peca-${n}` } },
});
const cartWith = (lines, totalAmount) => ({ lines, cost: { totalAmount: { amount: totalAmount, currencyCode: 'BRL' } } });

test('regressão: depois de "Alugar agora" o total é o do carrinho (R$ 200), não o preço da última peça (R$ 0)', () => {
  // Página da peça B (R$ 0), seleção já no carrinho junto com A (R$ 200).
  const after = plain(reservationSummary([piece(2, '0.0')], cartWith([cartLine(1, '200.0'), cartLine(2, '0.0')], '200.0')));
  assert.equal(after.total.source, 'shopify');
  assert.equal(after.total.amount, '200.00');
  assert.equal(after.pieces, 2);
  assert.deepEqual(after.rows.map((r) => [r.title, r.unitAmount, r.inCart]), [['Peça 2', '0.00', true], ['Peça 1', '200.00', true]]);
  // Antes de alugar: A escolhida + B desta página, carrinho vazio → prévia R$ 200.
  const before = plain(reservationSummary([piece(1, '200.0'), piece(2, '0.0')], null));
  assert.deepEqual([before.total.source, before.total.amount], ['preview', '200.00']);
  // A no carrinho, B ainda fora: prévia soma as duas (R$ 200), não só a peça da página.
  const mixed = plain(reservationSummary([piece(2, '0.0')], cartWith([cartLine(1, '200.0')], '200.0')));
  assert.deepEqual([mixed.total.source, mixed.total.amount, mixed.pieces], ['preview', '200.00', 2]);
});

test('ordem diferente dos produtos: mesmo resumo e mesmo total', () => {
  const ab = plain(reservationSummary([piece(1, '200.0'), piece(2, '0.0'), piece(3, '150.0')], null));
  const ba = plain(reservationSummary([piece(3, '150.0'), piece(2, '0.0'), piece(1, '200.0')], null));
  assert.equal(ab.total.amount, '350.00');
  assert.equal(ba.total.amount, '350.00');
  assert.equal(plain(selectionTotal([piece(2, '0.0'), piece(1, '200.0')])).amount, '200.00');
});

test('Shopify retornando total diferente da prévia: vale o da Shopify', () => {
  // Preços da vitrine somam R$ 200, mas o carrinho da Shopify fechou em R$ 180 (ex.: desconto).
  const summary = plain(reservationSummary([piece(1, '200.0'), piece(2, '0.0')], cartWith([cartLine(1, '200.0'), cartLine(2, '0.0')], '180.0')));
  assert.equal(summary.total.source, 'shopify');
  assert.equal(summary.total.amount, '180.00');
  assert.equal(summary.total.previewCents, 20000);
  // A linha já no carrinho usa o preço da Shopify, não o da vitrine.
  const repriced = plain(reservationSummary([piece(1, '250.0')], cartWith([cartLine(1, '200.0')], '200.0')));
  assert.equal(repriced.rows[0].unitAmount, '200.00');
  // Total oficial ilegível: nunca inventa; volta para a prévia.
  assert.equal(plain(reservationSummary([piece(1, '200.0')], cartWith([cartLine(1, '200.0')], ''))).total.source, 'preview');
});

test('mesma variante em duas linhas do carrinho: uma linha no resumo, com a quantidade somada', () => {
  const summary = plain(reservationSummary([piece(1, '200.0')], cartWith([cartLine(1, '200.0', 1, 'La'), cartLine(1, '200.0', 1, 'Lb')], '400.0')));
  assert.equal(summary.rows.length, 1);
  assert.equal(summary.pieces, 2);
  assert.equal(summary.total.amount, '400.00');
});

// ── carrinho (Cart API simulada, com custo calculado como a Shopify) ──────
const PRICES = { 1: '200.0', 2: '0.0', 3: '150.0' };
function fakeShopify() {
  const state = { lines: [], next: 1, mutations: [] };
  const numberOf = (gid) => gid.split('/').pop();
  const lineOf = (l) => ({
    id: `gid://shopify/CartLine/${state.next++}`, quantity: l.quantity, attributes: l.attributes,
    merchandise: { id: l.merchandiseId, sku: null, title: 'Padrão', availableForSale: true, quantityAvailable: 1, price: { amount: PRICES[numberOf(l.merchandiseId)], currencyCode: 'BRL' }, product: { title: `Peça ${numberOf(l.merchandiseId)}`, handle: `peca-${numberOf(l.merchandiseId)}`, featuredImage: null } },
  });
  const cart = () => {
    const cents = state.lines.reduce((sum, l) => sum + amountToCents(l.merchandise.price.amount) * l.quantity, 0);
    const money = { amount: centsToAmount(cents), currencyCode: 'BRL' };
    return { id: 'gid://shopify/Cart/C1', totalQuantity: state.lines.reduce((s, l) => s + l.quantity, 0), cost: { subtotalAmount: money, totalAmount: money }, lines: { nodes: state.lines } };
  };
  const handle = ({ query, variables }) => {
    if (/mutation/.test(query)) state.mutations.push(query.match(/(cartCreate|cartLinesAdd|cartLinesUpdate|cartLinesRemove)/)[1]);
    if (/query Cart/.test(query)) return { data: { cart: state.lines.length ? cart() : null } };
    if (/cartCreate/.test(query)) { state.lines = variables.lines.map(lineOf); return { data: { cartCreate: { cart: cart(), userErrors: [] } } }; }
    if (/cartLinesAdd/.test(query)) { state.lines.push(...variables.lines.map(lineOf)); return { data: { cartLinesAdd: { cart: cart(), userErrors: [] } } }; }
    if (/cartLinesUpdate/.test(query)) {
      for (const u of variables.lines) {
        const l = state.lines.find((x) => x.id === u.id);
        if (u.attributes) l.attributes = u.attributes;
        if (u.quantity) l.quantity = u.quantity;
      }
      return { data: { cartLinesUpdate: { cart: cart(), userErrors: [] } } };
    }
    if (/cartLinesRemove/.test(query)) { state.lines = state.lines.filter((l) => !variables.lineIds.includes(l.id)); return { data: { cartLinesRemove: { cart: cart(), userErrors: [] } } }; }
    throw new Error('consulta inesperada');
  };
  return { state, handle };
}
function loadCart(shop) {
  const storage = new Map();
  const exports = {};
  runInNewContext(transpile('src/lib/cart.ts'), {
    exports,
    require: (name) => {
      if (name === './rental-selection') return selectionLib;
      if (name === './vale-pass-product') return valePassLib;
      throw new Error(`import inesperado: ${name}`);
    },
    process: { env: { NEXT_PUBLIC_SHOPIFY_STORE_DOMAIN: 'loja-teste.myshopify.com', NEXT_PUBLIC_SHOPIFY_STOREFRONT_TOKEN: 'token-publico-de-teste' } },
    localStorage: { getItem: (k) => storage.get(k) ?? null, setItem: (k, v) => storage.set(k, v), removeItem: (k) => storage.delete(k) },
    fetch: async (_url, init) => ({ ok: true, status: 200, json: async () => shop.handle(JSON.parse(init.body)) }),
    JSON, Error, Map, Set, Object, Number, Array, String,
  });
  return exports;
}
const selectionOf = (ns, ret = '2026-10-10') => ({
  pieces: ns.map((n) => ({ variantId: `gid://shopify/ProductVariant/${n}`, sku: `VS-${n}` })),
  pickup: '2026-10-08', return: ret, returnOption: null, pickupLabel: '08/10/2026', returnLabel: ret.split('-').reverse().join('/'),
});
const summaryOf = (cart, selectionNs) => plain(reservationSummary(selectionNs.map((n) => piece(n, PRICES[n])), cart));

test('carrinho: R$ 200 + R$ 0 entram juntos e a Shopify devolve R$ 200; o resumo mostra esse total oficial', async () => {
  const shop = fakeShopify();
  const cart = await loadCart(shop).addRentalSelectionToCart(selectionOf([1, 2]));
  assert.equal(cart.lines.length, 2);
  assert.equal(cart.cost.totalAmount.amount, '200.00');
  assert.deepEqual(shop.state.mutations, ['cartCreate']);
  // Página da peça 2 (a última adicionada), seleção já limpa: total oficial R$ 200.
  const summary = summaryOf(cart, [2]);
  assert.deepEqual([summary.total.source, summary.total.amount, summary.pieces], ['shopify', '200.00', 2]);
});

test('carrinho: ordem 0 + 200 e 200 + 150 + 0 também somam certo', async () => {
  const a = fakeShopify();
  assert.equal((await loadCart(a).addRentalSelectionToCart(selectionOf([2, 1]))).cost.totalAmount.amount, '200.00');
  const b = fakeShopify();
  const cart = await loadCart(b).addRentalSelectionToCart(selectionOf([1, 3, 2]));
  assert.equal(cart.cost.totalAmount.amount, '350.00');
  assert.equal(summaryOf(cart, [3]).total.amount, '350.00');
});

test('reprocessamento sem duplicar: a mesma seleção de novo não cria linhas e o total continua o mesmo', async () => {
  const shop = fakeShopify();
  const lib = loadCart(shop);
  await lib.addRentalSelectionToCart(selectionOf([1, 2]));
  const again = await lib.addRentalSelectionToCart(selectionOf([1, 2]));
  assert.equal(again.lines.length, 2);
  assert.equal(again.cost.totalAmount.amount, '200.00');
  assert.deepEqual(shop.state.mutations, ['cartCreate']);
});

test('atualização do carrinho: nova devolução/terceira peça recalculam o total pela Shopify', async () => {
  const shop = fakeShopify();
  const lib = loadCart(shop);
  await lib.addRentalSelectionToCart(selectionOf([1, 2]));
  // Terceira peça: devolução passa a 12/10 para todas; linhas existentes atualizadas, nova adicionada.
  const cart = await lib.addRentalSelectionToCart(selectionOf([1, 2, 3], '2026-10-12'));
  assert.deepEqual(shop.state.mutations, ['cartCreate', 'cartLinesUpdate', 'cartLinesAdd']);
  assert.equal(cart.lines.length, 3);
  assert.equal(cart.cost.totalAmount.amount, '350.00');
  assert.ok(cart.lines.every((l) => l.attributes.find((a) => a.key === '_vsc_return').value === '2026-10-12'));
  // Quantidade alterada no carrinho: o total oficial acompanha.
  const updated = await lib.updateCartLineQuantity(cart.lines.find((l) => l.merchandise.id.endsWith('/3')).id, 2);
  assert.equal(updated.cost.totalAmount.amount, '500.00');
  assert.equal(summaryOf(updated, [1]).total.amount, '500.00');
});

test('remoção de um produto: o total volta a ser a soma das restantes (inclusive R$ 0 legítimo)', async () => {
  const shop = fakeShopify();
  const lib = loadCart(shop);
  const cart = await lib.addRentalSelectionToCart(selectionOf([1, 2]));
  const withoutA = await lib.removeCartLine(cart.lines.find((l) => l.merchandise.id.endsWith('/1')).id);
  assert.equal(withoutA.cost.totalAmount.amount, '0.00');
  assert.deepEqual([summaryOf(withoutA, [2]).total.source, summaryOf(withoutA, [2]).total.amount], ['shopify', '0.00']);
  // Remover da seleção (antes do carrinho): a prévia recalcula.
  assert.equal(plain(selectionTotal([piece(1, '200.0'), piece(3, '150.0')].filter((p) => !p.variantId.endsWith('/3')))).amount, '200.00');
});

test('Valle Pass nunca entra numa reserva de aluguel', async () => {
  const shop = fakeShopify();
  const lib = loadCart(shop);
  const selection = { ...selectionOf([1]), pieces: [{ variantId: 'gid://shopify/ProductVariant/1', sku: 'VS-1' }, { variantId: VALE_PASS_VARIANT, sku: 'VP' }] };
  await assert.rejects(lib.addRentalSelectionToCart(selection), (err) => err.code === 'not_added');
  assert.deepEqual(shop.state.mutations, []);
});
