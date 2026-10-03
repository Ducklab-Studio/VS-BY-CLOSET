import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';

// Estoque comercial da Shopify (o TS real, transpilado): valores BRUTOS da
// Storefront API para cada caso, a classificação, e a consulta fresca do
// carrinho com a Storefront simulada (timeout, erro, campo recusado).
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
const stock = load('src/lib/shopify-stock.ts');
const selectionLib = load('src/lib/rental-selection.ts', { Date });
const shopifyLib = load('src/lib/shopify.ts', { require: () => guardLib, process: { env: {} }, Intl });
const valePassLib = load('src/lib/vale-pass-product.ts', { process: { env: {} }, require: () => shopifyLib });
const { classifyShopifyStock, shopifyStockText } = stock;
const classify = (raw) => plain(classifyShopifyStock(raw));

// Valores brutos como a Storefront API devolve (ProductVariant). `quantityAvailable`
// já é o "disponível" do admin: em estoque 200 − comprometido 1 = 199.
const RAW = {
  disponivel199: { availableForSale: true, quantityAvailable: 199, currentlyNotInStock: false },
  todoComprometido: { availableForSale: false, quantityAvailable: 0, currentlyNotInStock: false },
  zeroRastreado: { availableForSale: false, quantityAvailable: 0, currentlyNotInStock: false },
  naoVendavel: { availableForSale: false, quantityAvailable: null, currentlyNotInStock: false },
  naoRastreado: { availableForSale: true, quantityAvailable: 0, currentlyNotInStock: false },
  vendeSemEstoque: { availableForSale: true, quantityAvailable: 0, currentlyNotInStock: true },
  falsoComEstoque: { availableForSale: false, quantityAvailable: 5, currentlyNotInStock: false },
};

test('1) estoque 200, comprometido 1, disponível 199: alugável, com a quantidade real', () => {
  assert.deepEqual(classify(RAW.disponivel199), { status: 'available', quantity: 199 });
  assert.equal(shopifyStockText(classifyShopifyStock(RAW.disponivel199)), 'Disponível na Shopify para o carrinho (199 em estoque).');
});

test('2) estoque comprometido: o comprometido já sai do disponível; todo comprometido = não vendável', () => {
  assert.deepEqual(classify({ ...RAW.disponivel199, quantityAvailable: 1 }), { status: 'available', quantity: 1 });
  assert.deepEqual(classify(RAW.todoComprometido), { status: 'sold_out' });
});

test('3–4) estoque zero rastreado e variante não vendável: "Esgotada na Shopify"', () => {
  assert.deepEqual(classify(RAW.zeroRastreado), { status: 'sold_out' });
  assert.deepEqual(classify(RAW.naoVendavel), { status: 'sold_out' });
  assert.equal(shopifyStockText(classifyShopifyStock(RAW.zeroRastreado)), 'Esgotada na Shopify.');
});

test('5) estoque não rastreado ou venda sem estoque: vendável, sem número (nunca "esgotada" nem 0)', () => {
  assert.deepEqual(classify(RAW.naoRastreado), { status: 'available', quantity: null });
  assert.deepEqual(classify(RAW.vendeSemEstoque), { status: 'available', quantity: null });
  assert.equal(shopifyStockText(classifyShopifyStock(RAW.naoRastreado)), 'Disponível na Shopify para o carrinho.');
});

test('6) availableForSale falso com estoque informado: vale a Shopify (o canal não vende; o carrinho zeraria a linha)', () => {
  assert.deepEqual(classify(RAW.falsoComEstoque), { status: 'sold_out' });
});

test('7) campos ausentes, nulos ou de tipo errado: "Estoque será validado", nunca esgotada', () => {
  for (const raw of [null, undefined, {}, { availableForSale: null }, { availableForSale: 'true' }, { quantityAvailable: 199 }]) {
    assert.deepEqual(classify(raw), { status: 'unknown' }, JSON.stringify(raw));
  }
  assert.deepEqual(classify({ availableForSale: true }), { status: 'available', quantity: null });
  assert.deepEqual(classify({ availableForSale: true, quantityAvailable: null }), { status: 'available', quantity: null });
  assert.deepEqual(classify({ availableForSale: true, quantityAvailable: 2.5 }), { status: 'available', quantity: null });
  assert.equal(shopifyStockText(classifyShopifyStock(undefined)), 'Estoque será validado ao finalizar a reserva.');
  assert.equal(shopifyStockText(null), 'Conferindo estoque na Shopify…');
});

// ── consulta fresca da Storefront (cart.ts) ───────────────────────────────
const V = (n) => `gid://shopify/ProductVariant/${n}`;
function loadCart(fetchImpl, timers = {}) {
  const exports = {};
  const storage = new Map();
  runInNewContext(transpile('src/lib/cart.ts'), {
    exports,
    require: (name) => {
      if (name === './rental-selection') return selectionLib;
      if (name === './vale-pass-product') return valePassLib;
      if (name === './shopify-stock') return stock;
      if (name === './shopify-network-guard') return guardLib;
      throw new Error(`import inesperado: ${name}`);
    },
    process: { env: { NEXT_PUBLIC_SHOPIFY_STORE_DOMAIN: 'loja-teste.myshopify.com', NEXT_PUBLIC_SHOPIFY_STOREFRONT_TOKEN: 'token-publico-de-teste' } },
    localStorage: { getItem: (k) => storage.get(k) ?? null, setItem: (k, v) => storage.set(k, v), removeItem: (k) => storage.delete(k) },
    fetch: fetchImpl,
    AbortController,
    setTimeout: timers.setTimeout ?? setTimeout,
    clearTimeout: timers.clearTimeout ?? clearTimeout,
    JSON, Error, Map, Set, Object, Number, Array, String,
  });
  return exports;
}
const reply = (body, ok = true, status = 200) => ({ ok, status, json: async () => body });
const nodesFrom = (table) => async (_url, init) => {
  const { variables } = JSON.parse(init.body);
  return reply({ data: { nodes: variables.ids.map((id) => (table[id] ? { id, ...table[id] } : null)) } });
};

test('consulta fresca devolve os valores brutos classificados (inclusive variante inexistente → validar depois)', async () => {
  const calls = [];
  const cart = loadCart(async (url, init) => {
    calls.push(JSON.parse(init.body));
    return nodesFrom({ [V(1)]: RAW.disponivel199, [V(2)]: RAW.zeroRastreado, [V(3)]: RAW.naoRastreado })(url, init);
  });
  const map = await cart.fetchVariantStock([V(1), V(2), V(3), V(4)]);
  assert.deepEqual(plain(Object.fromEntries(map)), {
    [V(1)]: { status: 'available', quantity: 199 },
    [V(2)]: { status: 'sold_out' },
    [V(3)]: { status: 'available', quantity: null },
    [V(4)]: { status: 'unknown' },
  });
  assert.match(calls[0].query, /availableForSale quantityAvailable currentlyNotInStock/);
});

test('8) timeout da Shopify: a consulta é abortada e o estoque fica "a validar"', async () => {
  const cart = loadCart(
    (_url, init) => new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(new Error('abortado')))),
    { setTimeout: (fn) => { queueMicrotask(fn); return 0; }, clearTimeout: () => undefined },
  );
  assert.deepEqual(plain(Object.fromEntries(await cart.fetchVariantStock([V(1)]))), { [V(1)]: { status: 'unknown' } });
});

test('9) erro da Storefront API: sem rede, HTTP 500 ou GraphQL → "a validar"; campo de estoque recusado → repete só com availableForSale', async () => {
  const offline = loadCart(async () => { throw new Error('rede'); });
  assert.equal((await offline.fetchVariantStock([V(1)])).get(V(1)).status, 'unknown');
  const http500 = loadCart(async () => reply({}, false, 500));
  assert.equal((await http500.fetchVariantStock([V(1)])).get(V(1)).status, 'unknown');
  const graphqlError = loadCart(async () => reply({ errors: [{ message: 'erro interno' }] }));
  assert.equal((await graphqlError.fetchVariantStock([V(1)])).get(V(1)).status, 'unknown');
  // Token sem permissão de inventário: quantityAvailable recusado; availableForSale ainda decide.
  const queries = [];
  const scoped = loadCart(async (url, init) => {
    const body = JSON.parse(init.body);
    queries.push(body.query);
    if (/quantityAvailable/.test(body.query)) return reply({ errors: [{ message: 'Access denied for quantityAvailable field' }] });
    return nodesFrom({ [V(1)]: { availableForSale: true }, [V(2)]: { availableForSale: false } })(url, init);
  });
  const map = await scoped.fetchVariantStock([V(1), V(2)]);
  assert.deepEqual(plain(Object.fromEntries(map)), { [V(1)]: { status: 'available', quantity: null }, [V(2)]: { status: 'sold_out' } });
  assert.equal(queries.length, 2);
});

// ── 1, 12: "Alugar agora" com a variante de 199 unidades ──────────────────
function shopWith(stockByVariant) {
  const state = { lines: [], ops: [] };
  const fetchImpl = async (_url, init) => {
    const { query, variables } = JSON.parse(init.body);
    const op = query.match(/(VariantStock|query Cart|cartCreate)/)?.[1];
    state.ops.push(op);
    if (op === 'VariantStock') return nodesFrom(stockByVariant)(_url, init);
    if (op === 'query Cart') return reply({ data: { cart: null } });
    state.lines = variables.lines.map((l, i) => ({
      id: `gid://shopify/CartLine/${i + 1}`,
      // Como a Shopify: vendável → quantidade pedida; não vendável → linha zerada.
      quantity: stockByVariant[l.merchandiseId]?.availableForSale === true ? l.quantity : 0,
      attributes: l.attributes,
      merchandise: { id: l.merchandiseId, sku: null, title: 'Padrão', availableForSale: true, quantityAvailable: 199, price: { amount: '200.0', currencyCode: 'BRL' }, product: { title: 'x', handle: 'x', featuredImage: null } },
    }));
    return reply({ data: { cartCreate: { cart: { id: 'gid://shopify/Cart/C1', totalQuantity: state.lines.reduce((s, l) => s + l.quantity, 0), cost: { subtotalAmount: { amount: '200.0', currencyCode: 'BRL' }, totalAmount: { amount: '200.0', currencyCode: 'BRL' } }, lines: { nodes: state.lines } }, userErrors: [] } } });
  };
  return { state, fetchImpl };
}
const SELECTION = (ids) => ({ pieces: ids.map((id, i) => ({ variantId: id, sku: `VS-${i}` })), pickup: '2026-10-08', return: '2026-10-10', returnOption: null, pickupLabel: '08/10/2026', returnLabel: '10/10/2026' });

test('1) variante com 199 disponíveis entra no carrinho com quantidade 1', async () => {
  const shop = shopWith({ [V(1)]: RAW.disponivel199 });
  const cart = await loadCart(shop.fetchImpl).addRentalSelectionToCart(SELECTION([V(1)]));
  assert.deepEqual(cart.lines.map((l) => l.quantity), [1]);
  assert.deepEqual(shop.state.ops, ['VariantStock', 'cartCreate']);
});

test('pré-checagem: só a Shopify confirmando "não vendável" bloqueia; timeout/erro deixa seguir para a conferência da linha', async () => {
  const blocked = shopWith({ [V(1)]: RAW.disponivel199, [V(2)]: RAW.zeroRastreado });
  await assert.rejects(loadCart(blocked.fetchImpl).addRentalSelectionToCart(SELECTION([V(1), V(2)])), (err) => err.code === 'not_added' && plain(err.variantIds).join() === V(2));
  assert.deepEqual(blocked.state.ops, ['VariantStock']);
  // Consulta de estoque fora do ar: não bloqueia por suposição…
  const flaky = shopWith({ [V(1)]: RAW.disponivel199 });
  let first = true;
  const cart = await loadCart(async (url, init) => {
    if (first && /VariantStock/.test(JSON.parse(init.body).query)) { first = false; throw new Error('rede'); }
    return flaky.fetchImpl(url, init);
  }).addRentalSelectionToCart(SELECTION([V(1)]));
  assert.equal(cart.lines[0].quantity, 1);
});

test('12) linha devolvida com quantidade 0 nunca é sucesso, mesmo com a pré-checagem inconclusiva', async () => {
  const shop = shopWith({ [V(1)]: { availableForSale: null } }); // pré-checagem: inconclusivo
  await assert.rejects(loadCart(shop.fetchImpl).addRentalSelectionToCart(SELECTION([V(1)])), (err) => err.code === 'not_added' && plain(err.variantIds).join() === V(1));
});
