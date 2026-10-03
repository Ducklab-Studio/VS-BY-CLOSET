import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';

// Rascunho x carrinho REAL da Shopify (o TS real, transpilado), com a Cart API
// simulada reproduzindo o caso relatado: variante sem estoque vendável volta
// do cartLinesAdd/cartCreate como linha com quantidade 0 (sem erro).
const root = new URL('../', import.meta.url);
const ts = createRequire(new URL('package.json', root))('typescript');
const transpile = (path) =>
  ts.transpileModule(readFileSync(new URL(path, root), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2021 },
  }).outputText;
// Trava da Shopify real (sem rede) — importada por shopify.ts e cart.ts.
const guardLib = {};
runInNewContext(transpile('src/lib/shopify-network-guard.ts'), { exports: guardLib, URL });
const plain = (value) => JSON.parse(JSON.stringify(value));
const load = (path, globals = {}) => {
  const exports = {};
  runInNewContext(transpile(path), { exports, JSON, Set, Map, Number, Math, Array, String, Object, Error, ...globals });
  return exports;
};

const priceLib = load('src/lib/rental-price.ts');
const selectionLib = load('src/lib/rental-selection.ts', { Date });
const shopifyLib = load('src/lib/shopify.ts', { require: () => guardLib, process: { env: {} }, Intl });
const valePassLib = load('src/lib/vale-pass-product.ts', { process: { env: {} }, require: () => shopifyLib });
const draftLib = load('src/lib/rental-draft.ts', { require: () => priceLib, encodeURIComponent, decodeURIComponent });
const VALE_PASS_VARIANT = 'gid://shopify/ProductVariant/49174518595684';

// ── Shopify simulada ──────────────────────────────────────────────────────
const gid = (n) => `gid://shopify/ProductVariant/${n}`;
/** estoque: ok (rastreado, 1), untracked (quantityAvailable 0 mas à venda), soldout (não à venda), race (pré-checagem diz à venda, mas a linha volta zerada). */
const CATALOG = { 1: ['200.0', 'ok'], 2: ['0.0', 'ok'], 3: ['150.0', 'soldout'], 4: ['90.0', 'untracked'], 5: ['60.0', 'race'], 6: [null, 'ok'] };
function fakeShopify() {
  const state = { lines: [], next: 1, calls: [] };
  const n = (id) => id.split('/').pop();
  const lineOf = (l) => {
    const [price, stock] = CATALOG[n(l.merchandiseId)];
    const zero = stock === 'soldout' || stock === 'race';
    return {
      id: `gid://shopify/CartLine/${state.next++}`, quantity: zero ? 0 : l.quantity, attributes: l.attributes,
      merchandise: {
        id: l.merchandiseId, sku: `VS-${n(l.merchandiseId)}`, title: 'Padrão', availableForSale: stock !== 'soldout',
        quantityAvailable: stock === 'ok' ? 1 : 0, price: price === null ? null : { amount: price, currencyCode: 'BRL' },
        product: { title: `Peça ${n(l.merchandiseId)}`, handle: `peca-${n(l.merchandiseId)}`, featuredImage: null },
      },
    };
  };
  const cart = () => {
    const cents = state.lines.reduce((s, l) => s + (l.merchandise.price ? priceLib.amountToCents(l.merchandise.price.amount) * l.quantity : 0), 0);
    const money = { amount: priceLib.centsToAmount(cents), currencyCode: 'BRL' };
    return { id: 'gid://shopify/Cart/C1', totalQuantity: state.lines.reduce((s, l) => s + l.quantity, 0), cost: { subtotalAmount: money, totalAmount: money }, lines: { nodes: state.lines } };
  };
  const handle = ({ query, variables }) => {
    const op = query.match(/(query Cart|VariantStock|cartCreate|cartLinesAdd|cartLinesUpdate|cartLinesRemove)/)[1];
    state.calls.push({ op, variables });
    if (op === 'VariantStock') return { data: { nodes: variables.ids.map((id) => ({ id, availableForSale: CATALOG[n(id)][1] !== 'soldout' })) } };
    if (op === 'query Cart') return { data: { cart: state.lines.length ? cart() : null } };
    if (op === 'cartCreate') { state.lines = variables.lines.map(lineOf); return { data: { cartCreate: { cart: cart(), userErrors: [] } } }; }
    if (op === 'cartLinesAdd') { state.lines.push(...variables.lines.map(lineOf)); return { data: { cartLinesAdd: { cart: cart(), userErrors: [] } } }; }
    if (op === 'cartLinesUpdate') {
      for (const u of variables.lines) {
        const l = state.lines.find((x) => x.id === u.id);
        if (!l) return { data: { cartLinesUpdate: { cart: null, userErrors: [{ message: 'linha inexistente' }] } } };
        if (u.attributes) l.attributes = u.attributes;
      }
      return { data: { cartLinesUpdate: { cart: cart(), userErrors: [] } } };
    }
    if (op === 'cartLinesRemove') {
      const unknown = variables.lineIds.filter((id) => !state.lines.some((l) => l.id === id));
      if (unknown.length) return { data: { cartLinesRemove: { cart: null, userErrors: [{ message: `linha inexistente: ${unknown}` }] } } };
      state.lines = state.lines.filter((l) => !variables.lineIds.includes(l.id));
      return { data: { cartLinesRemove: { cart: cart(), userErrors: [] } } };
    }
    throw new Error('consulta inesperada');
  };
  return { state, handle, ops: () => state.calls.map((c) => c.op) };
}
// cart.ts consulta o estoque fresco da Shopify (lib/shopify-stock.ts, puro).
const shopifyStockLib = {};
runInNewContext(transpile('src/lib/shopify-stock.ts'), { exports: shopifyStockLib, Number, Object });
function loadCart(shop, storage = new Map()) {
  const exports = {};
  runInNewContext(transpile('src/lib/cart.ts'), {
    AbortController, setTimeout, clearTimeout,
    exports,
    require: (name) => {
      if (name === './rental-selection') return selectionLib;
      if (name === './vale-pass-product') return valePassLib;
      if (name === './shopify-stock') return shopifyStockLib;
      if (name === './shopify-network-guard') return guardLib;
      throw new Error(`import inesperado: ${name}`);
    },
    process: { env: { NEXT_PUBLIC_SHOPIFY_STORE_DOMAIN: 'loja-teste.myshopify.com', NEXT_PUBLIC_SHOPIFY_STOREFRONT_TOKEN: 'token-publico-de-teste' } },
    localStorage: { getItem: (k) => storage.get(k) ?? null, setItem: (k, v) => storage.set(k, v), removeItem: (k) => storage.delete(k) },
    fetch: async (_url, init) => ({ ok: true, status: 200, json: async () => shop.handle(JSON.parse(init.body)) }),
    JSON, Error, Map, Set, Object, Number, Array, String,
  });
  return { lib: exports, storage };
}
const selectionOf = (ns) => ({
  pieces: ns.map((k) => ({ variantId: gid(k), sku: `VS-${k}` })),
  pickup: '2026-10-08', return: '2026-10-10', returnOption: null, pickupLabel: '08/10/2026', returnLabel: '10/10/2026',
});
const piece = (k, priceAmount) => ({ variantId: gid(k), sku: `VS-${k}`, title: `Peça ${k}`, handle: `peca-${k}`, priceAmount, currencyCode: 'BRL' });

// ── 1–3: rascunho não é carrinho ──────────────────────────────────────────
test('1–3) selecionar uma ou duas peças só mexe no rascunho: nenhuma chamada à Shopify, carrinho continua vazio', async () => {
  const shop = fakeShopify();
  const { lib } = loadCart(shop);
  let draft = draftLib.addPiece(draftLib.EMPTY_DRAFT, piece(1, '200.0'), 6, 0).draft;
  assert.equal(draft.pieces.length, 1);
  draft = draftLib.addPiece(draft, piece(2, '0.0'), 6, 0).draft;
  assert.equal(draft.pieces.length, 2);
  assert.equal(plain(priceLib.selectionTotal(draft.pieces)).amount, '200.00'); // total ESTIMADO, só do rascunho
  assert.equal(await lib.getCart(), null); // carrinho real: nenhum
  assert.deepEqual(shop.ops(), []);
});

// ── 4–7: só linhas confirmadas pela Shopify ───────────────────────────────
test('4) uma peça: linha real na Shopify com quantidade 1', async () => {
  const shop = fakeShopify();
  const cart = await loadCart(shop).lib.addRentalSelectionToCart(selectionOf([1]));
  assert.deepEqual(cart.lines.map((l) => [l.merchandise.id, l.quantity]), [[gid(1), 1]]);
  assert.deepEqual(shop.ops(), ['VariantStock', 'cartCreate']);
});

test('5–7) duas peças: duas linhas reais; R$ 200 + R$ 0 = R$ 200 no total da Shopify; a de R$ 0 tem quantidade 1', async () => {
  const shop = fakeShopify();
  const cart = await loadCart(shop).lib.addRentalSelectionToCart(selectionOf([1, 2]));
  assert.equal(cart.lines.length, 2);
  assert.ok(cart.lines.every((l) => l.quantity === 1));
  assert.equal(cart.lines.find((l) => l.merchandise.id === gid(2)).merchandise.price.amount, '0.0');
  assert.equal(cart.cost.totalAmount.amount, '200.00');
  assert.equal(cart.totalQuantity, 2);
});

test('8) preço ausente na Shopify: "Preço a confirmar", nunca R$ 0', async () => {
  const shop = fakeShopify();
  const cart = await loadCart(shop).lib.addRentalSelectionToCart(selectionOf([6]));
  assert.equal(cart.lines[0].quantity, 1);
  assert.equal(shopifyLib.formatPrice(cart.lines[0].merchandise.price?.amount, cart.lines[0].merchandise.price?.currencyCode), '');
  const summary = plain(priceLib.reservationSummary([], { lines: cart.lines, cost: null }));
  assert.equal(summary.rows[0].unitAmount, null);
  assert.equal(summary.total.source, 'unknown');
});

// ── 9: erro não vira sucesso falso ────────────────────────────────────────
test('9) Shopify confirma que a peça não está à venda: nada vai ao carrinho e o erro diz qual', async () => {
  const shop = fakeShopify();
  await assert.rejects(loadCart(shop).lib.addRentalSelectionToCart(selectionOf([1, 3])), (err) => err.code === 'not_added' && plain(err.variantIds).join() === gid(3));
  assert.deepEqual(shop.ops(), ['VariantStock']); // nenhuma mutação
  assert.equal(shop.state.lines.length, 0);
});

test('9) caso relatado: a Shopify devolve a linha com quantidade 0 → não é sucesso; carrinho novo descartado', async () => {
  const shop = fakeShopify();
  const { lib, storage } = loadCart(shop);
  await assert.rejects(lib.addRentalSelectionToCart(selectionOf([1, 5])), (err) => err.code === 'not_added' && plain(err.variantIds).join() === gid(5));
  assert.equal(storage.get('vsc_cart_id'), undefined, 'carrinho com a reserva pela metade não fica salvo');
  assert.equal(await lib.getCart(), null);
});

test('9) carrinho existente: peça zerada pela Shopify é desfeita pelo id real das linhas criadas; as que já estavam ficam intactas', async () => {
  const shop = fakeShopify();
  const { lib } = loadCart(shop);
  await lib.addRentalSelectionToCart(selectionOf([1]));
  const before = plain(shop.state.lines);
  await assert.rejects(lib.addRentalSelectionToCart(selectionOf([1, 2, 5])), (err) => plain(err.variantIds).join() === gid(5));
  const remove = shop.state.calls.find((c) => c.op === 'cartLinesRemove');
  assert.deepEqual(plain(remove.variables.lineIds).sort(), ['gid://shopify/CartLine/2', 'gid://shopify/CartLine/3']); // as duas criadas agora (a de R$ 0 e a zerada)
  assert.deepEqual(plain(shop.state.lines), before);
  assert.ok(!shop.ops().includes('cartLinesUpdate'), 'datas das peças antigas não mudam quando a inclusão falha');
});

test('linha com quantidade 0 que já estava no carrinho: nunca aparece e é limpa pelo id real', async () => {
  const shop = fakeShopify();
  const { lib, storage } = loadCart(shop);
  await lib.addRentalSelectionToCart(selectionOf([1]));
  // Linha zerada deixada por uma tentativa antiga (antes desta correção).
  shop.state.lines.push({ ...plain(shop.state.lines[0]), id: 'gid://shopify/CartLine/ZERO', quantity: 0 });
  storage.set('vsc_cart_id', 'gid://shopify/Cart/C1');
  const cart = await lib.getCart();
  assert.deepEqual(cart.lines.map((l) => l.id), ['gid://shopify/CartLine/1']);
  assert.deepEqual(plain(shop.state.calls.at(-1)), { op: 'cartLinesRemove', variables: { cartId: 'gid://shopify/Cart/C1', lineIds: ['gid://shopify/CartLine/ZERO'] } });
  assert.equal(cart.totalQuantity, 1);
});

// ── 10–13: sem duplicar, remoções corretas ────────────────────────────────
test('10–11) repetir a operação (inclusive em sequência rápida) não duplica linhas', async () => {
  const shop = fakeShopify();
  const { lib } = loadCart(shop);
  await lib.addRentalSelectionToCart(selectionOf([1, 2]));
  const again = await lib.addRentalSelectionToCart(selectionOf([1, 2, 2, 1]));
  assert.equal(again.lines.length, 2);
  assert.deepEqual(shop.ops().filter((op) => op.startsWith('cart')), ['cartCreate']);
});

test('12) remover peça só do rascunho não chama a Shopify', async () => {
  const shop = fakeShopify();
  loadCart(shop);
  const draft = [piece(1, '200.0'), piece(2, '0.0')].reduce((d, p) => draftLib.addPiece(d, p, 6, 0).draft, draftLib.EMPTY_DRAFT);
  assert.deepEqual(plain(draftLib.removePiece(draft, gid(2)).pieces).map((p) => p.sku), ['VS-1']);
  assert.deepEqual(shop.ops(), []);
});

test('13) remover do carrinho usa o id REAL da linha devolvida pela Shopify', async () => {
  const shop = fakeShopify();
  const { lib } = loadCart(shop);
  const cart = await lib.addRentalSelectionToCart(selectionOf([1, 2]));
  const lineId = cart.lines.find((l) => l.merchandise.id === gid(1)).id;
  const after = await lib.removeCartLine(lineId);
  assert.deepEqual(plain(shop.state.calls.at(-1).variables.lineIds), [lineId]);
  assert.deepEqual(after.lines.map((l) => l.merchandise.id), [gid(2)]);
  assert.equal(after.cost.totalAmount.amount, '0.00');
});

// ── 14–17: estoque ────────────────────────────────────────────────────────
function loadStock(fetchImpl, timers = {}) {
  return load('src/lib/rental-stock.ts', {
    fetch: fetchImpl, URLSearchParams, Promise,
    AbortController, setTimeout: timers.setTimeout ?? setTimeout, clearTimeout: timers.clearTimeout ?? clearTimeout,
  });
}
const cartLine = (k, { availableForSale = true, quantityAvailable = 1, quantity = 1 } = {}) => ({
  id: `L${k}`, quantity, attributes: [{ key: '_vsc_pickup', value: '2026-10-08' }],
  merchandise: { id: gid(k), availableForSale, quantityAvailable, price: { amount: '10.0', currencyCode: 'BRL' }, product: { title: `Peça ${k}`, handle: `peca-${k}` } },
});
const cartWith = (lines) => ({ id: 'C1', totalQuantity: lines.reduce((s, l) => s + l.quantity, 0), cost: {}, lines, zeroLineIds: [] });
const availabilityOk = (quantityAvailable) => async (url) => {
  const q = new URL(url, 'http://x').searchParams;
  return { ok: true, json: async () => ({ shopifyVariantId: q.get('shopifyVariantId'), days: [{ date: q.get('from'), quantityAvailable }] }) };
};

test('14) estoque zero CONFIRMADO pela Shopify (não está à venda) → "Esgotada na Shopify"', async () => {
  const stock = loadStock(availabilityOk(1));
  const map = await stock.fetchRentalStock(cartWith([cartLine(3, { availableForSale: false, quantityAvailable: 0 })]));
  assert.equal(map[gid(3)].shopify, 0);
  assert.equal(stock.shopifyStockLabel(map[gid(3)]), 'Esgotada na Shopify');
  assert.equal(map[gid(3)].effective, 0);
});

test('15) inventário não rastreado (à venda, quantityAvailable 0) → não é "Esgotada"; vale a disponibilidade da data', async () => {
  const stock = loadStock(availabilityOk(2));
  const map = await stock.fetchRentalStock(cartWith([cartLine(4, { quantityAvailable: 0 })]));
  assert.equal(map[gid(4)].shopify, null);
  assert.equal(stock.shopifyStockLabel(map[gid(4)]), 'Estoque será validado ao finalizar a reserva.');
  assert.equal(map[gid(4)].effective, 2); // não "Disponível para esta reserva: 0"
});

test('16) erro, HTTP 5xx, dia ausente ou timeout na consulta → estoque físico "a validar" (null), nunca 0', async () => {
  const cart = cartWith([cartLine(1)]);
  const network = loadStock(async () => { throw new Error('rede'); });
  assert.equal((await network.fetchRentalStock(cart))[gid(1)].physical, null);
  const http500 = loadStock(async () => ({ ok: false, status: 500, json: async () => ({}) }));
  assert.equal((await http500.fetchRentalStock(cart))[gid(1)].physical, null);
  const missingDay = loadStock(async () => ({ ok: true, json: async () => ({ days: [] }) }));
  assert.equal((await missingDay.fetchRentalStock(cart))[gid(1)].physical, null);
  // Timeout: a consulta nunca responde; o limite de tempo aborta (relógio simulado dispara na hora).
  const hanging = loadStock(
    (_url, init) => new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(new Error('abortado')))),
    { setTimeout: (fn) => { queueMicrotask(fn); return 0; }, clearTimeout: () => undefined },
  );
  const timedOut = (await hanging.fetchRentalStock(cart))[gid(1)];
  assert.equal(timedOut.physical, null);
  assert.equal(timedOut.effective, 1); // só o que a Shopify confirmou
});

test('17) disponibilidade da data vem da API, separada da quantidade do carrinho', async () => {
  const seen = [];
  const stock = loadStock(async (url) => {
    seen.push(Object.fromEntries(new URL(url, 'http://x').searchParams));
    return availabilityOk(3)(url);
  });
  const map = await stock.fetchRentalStock(cartWith([cartLine(1, { quantity: 2, quantityAvailable: 5 })]));
  assert.equal(map[gid(1)].physical, 3); // a API diz 3 livres na data (não a quantidade 2 do carrinho)
  assert.equal(map[gid(1)].effective, 3);
  assert.equal(seen[0].from, '2026-10-08');
});

// ── 19: Valle Pass ────────────────────────────────────────────────────────
test('19) Valle Pass não entra no carrinho de aluguel (nenhuma chamada à Shopify)', async () => {
  const shop = fakeShopify();
  const selection = { ...selectionOf([1]), pieces: [{ variantId: gid(1), sku: 'VS-1' }, { variantId: VALE_PASS_VARIANT, sku: 'VP' }] };
  await assert.rejects(loadCart(shop).lib.addRentalSelectionToCart(selection), (err) => err.code === 'not_added');
  assert.deepEqual(shop.ops(), []);
});

test('rascunho guarda a devolução só para a quantidade em que foi calculada', () => {
  let draft = [piece(1, '200.0'), piece(2, '0.0')].reduce((d, p) => draftLib.addPiece(d, p, 6, 0).draft, draftLib.EMPTY_DRAFT);
  draft = draftLib.withReturn(draftLib.withDates(draft, '2026-10-08', null), '2026-10-10', 2);
  assert.equal(draftLib.draftReturnDate(draft), '2026-10-10');
  assert.equal(draftLib.draftReturnDate(draftLib.removePiece(draft, gid(2))), null); // quantidade mudou: recalcular
  assert.equal(draftLib.draftReturnDate(draftLib.withDates(draft, '2026-10-09', null)), null); // retirada mudou
  const reloaded = draftLib.parseDraft(JSON.stringify({ ...draft, updatedAt: 1 }));
  assert.equal(draftLib.draftReturnDate(reloaded), '2026-10-10');
});
