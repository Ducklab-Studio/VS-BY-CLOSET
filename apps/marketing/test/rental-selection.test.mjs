import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';

// Seleção do período de aluguel e carrinho (o TS real, transpilado), com a
// Storefront API da Shopify simulada por um `fetch` falso — nenhuma rede.
const root = new URL('../', import.meta.url);
const ts = createRequire(new URL('package.json', root))('typescript');
const transpile = (path) =>
  ts.transpileModule(readFileSync(new URL(path, root), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2021 },
  }).outputText;
// Trava da Shopify real (sem rede) — importada por shopify.ts e cart.ts.
const guardLib = {};
runInNewContext(transpile('src/lib/shopify-network-guard.ts'), { exports: guardLib, URL });

const selection = {};
runInNewContext(transpile('src/lib/rental-selection.ts'), { exports: selection, Date, Number, Set });
const { isSundayISO, resolveRentalSelection, selectableReturnOptions, planCartChange, returnOptionFromLines } = selection;
// cart.ts recusa o Valle Pass: carrega o detector real (com a loja sem URL configurada).
const valePass = {};
runInNewContext(transpile('src/lib/vale-pass-product.ts'), { exports: valePass, require: () => ({ storeUrl: () => '#' }), process: { env: {} } });
const plain = (value) => JSON.parse(JSON.stringify(value));

// Caso relatado: retirada 07/10/2026, devolução calculada domingo 11/10/2026.
const SUNDAY_DAY = {
  date: '2026-10-07',
  bookable: true,
  calculatedReturnDate: '2026-10-11',
  hasSundayReturnException: true,
  returnOptions: [
    { type: 'saturday', date: '2026-10-10', available: true },
    { type: 'mondayMorning', date: '2026-10-12', window: '10:00–12:00', available: true },
  ],
};

test('retirada com devolução normal: envia a devolução calculada, sem opção', () => {
  const day = { date: '2026-10-06', bookable: true, calculatedReturnDate: '2026-10-09', hasSundayReturnException: false, returnOptions: [] };
  assert.deepEqual(plain(resolveRentalSelection(day, null)), { pickup: '2026-10-06', return: '2026-10-09', returnOption: null });
});

test('devolução no domingo: sem escolha não dá para alugar; domingo nunca é enviado', () => {
  assert.equal(resolveRentalSelection(SUNDAY_DAY, null), null);
  assert.equal(isSundayISO('2026-10-11'), true);
  // Defesa: devolução calculada num domingo sem a exceção marcada nunca sai.
  assert.equal(resolveRentalSelection({ ...SUNDAY_DAY, hasSundayReturnException: false }, null), null);
});

test('sábado à noite: envia 2026-10-10', () => {
  assert.deepEqual(plain(resolveRentalSelection(SUNDAY_DAY, 'saturday')), { pickup: '2026-10-07', return: '2026-10-10', returnOption: 'saturday' });
});

test('segunda-feira: envia 2026-10-12 (nunca 11/10)', () => {
  assert.deepEqual(plain(resolveRentalSelection(SUNDAY_DAY, 'mondayMorning')), { pickup: '2026-10-07', return: '2026-10-12', returnOption: 'mondayMorning' });
});

test('opção indisponível na data dela não pode ser escolhida; dia indisponível também não', () => {
  const mondayTaken = { ...SUNDAY_DAY, returnOptions: [SUNDAY_DAY.returnOptions[0], { ...SUNDAY_DAY.returnOptions[1], available: false }] };
  assert.equal(resolveRentalSelection(mondayTaken, 'mondayMorning'), null);
  assert.deepEqual(plain(selectableReturnOptions(mondayTaken)).map((o) => o.type), ['saturday']);
  assert.equal(resolveRentalSelection({ ...SUNDAY_DAY, bookable: false }, 'saturday'), null);
  // API antiga (sem `available`): continua funcionando.
  const legacy = { ...SUNDAY_DAY, returnOptions: SUNDAY_DAY.returnOptions.map(({ available, ...o }) => o) };
  assert.equal(resolveRentalSelection(legacy, 'mondayMorning').return, '2026-10-12');
});

test('datas civis: o mesmo resultado em qualquer fuso (Chile, UTC, Tóquio)', () => {
  const original = process.env.TZ;
  try {
    for (const tz of ['America/Santiago', 'UTC', 'Asia/Tokyo', 'Pacific/Kiritimati']) {
      process.env.TZ = tz;
      assert.equal(isSundayISO('2026-10-11'), true, tz);
      assert.equal(isSundayISO('2026-10-12'), false, tz);
      assert.equal(resolveRentalSelection(SUNDAY_DAY, 'mondayMorning').return, '2026-10-12', tz);
    }
  } finally {
    if (original === undefined) delete process.env.TZ;
    else process.env.TZ = original;
  }
  assert.equal(isSundayISO('2026-02-30'), true); // data inválida nunca é enviada
});

const line = (id, variant, attrs) => ({ id, merchandise: { id: variant }, attributes: Object.entries(attrs).map(([key, value]) => ({ key, value })) });

test('carrinho: mesma peça nunca vira duas linhas (mesmas datas = nada; outra opção = atualiza a linha)', () => {
  const lines = [line('L1', 'V1', { _vsc_pickup: '2026-10-07', _vsc_return: '2026-10-10', _vsc_return_option: 'saturday' })];
  assert.deepEqual(plain(planCartChange(lines, { variantId: 'V2', pickup: '2026-10-07', return: '2026-10-12' })), { kind: 'add' });
  assert.deepEqual(plain(planCartChange(lines, { variantId: 'V1', pickup: '2026-10-07', return: '2026-10-10', returnOption: 'saturday' })), { kind: 'noop', lineId: 'L1' });
  assert.deepEqual(plain(planCartChange(lines, { variantId: 'V1', pickup: '2026-10-07', return: '2026-10-12', returnOption: 'mondayMorning' })), { kind: 'update', lineId: 'L1' });
});

test('checkout: usa a opção escolhida na peça; linhas em conflito voltam a perguntar', () => {
  assert.equal(returnOptionFromLines([line('L1', 'V1', { _vsc_return_option: 'mondayMorning' }), line('L2', 'V2', {})]), 'mondayMorning');
  assert.equal(returnOptionFromLines([line('L1', 'V1', { _vsc_return_option: 'mondayMorning' }), line('L2', 'V2', { _vsc_return_option: 'saturday' })]), null);
  assert.equal(returnOptionFromLines([line('L1', 'V1', {})]), null);
  assert.equal(returnOptionFromLines([line('L1', 'V1', { _vsc_return_option: 'domingo' })]), null);
});

// ── addRentalToCart com a Storefront API simulada ─────────────────────────
// cart.ts consulta o estoque fresco da Shopify (lib/shopify-stock.ts, puro).
const shopifyStockLib = {};
runInNewContext(transpile('src/lib/shopify-stock.ts'), { exports: shopifyStockLib, Number, Object });
function loadCart({ storedCartId = null, responses }) {
  const storage = new Map(storedCartId ? [['vsc_cart_id', storedCartId]] : []);
  const calls = [];
  const exports = {};
  const env = { NEXT_PUBLIC_SHOPIFY_STORE_DOMAIN: 'loja-teste.myshopify.com', NEXT_PUBLIC_SHOPIFY_STOREFRONT_TOKEN: 'token-publico-de-teste' };
  runInNewContext(transpile('src/lib/cart.ts'), {
    AbortController, setTimeout, clearTimeout,
    exports,
    require: (name) => {
      if (name === './rental-selection') return selection;
      if (name === './vale-pass-product') return valePass;
      if (name === './shopify-stock') return shopifyStockLib;
      if (name === './shopify-network-guard') return guardLib;
      throw new Error(`import inesperado: ${name}`);
    },
    process: { env },
    localStorage: { getItem: (k) => storage.get(k) ?? null, setItem: (k, v) => storage.set(k, v), removeItem: (k) => storage.delete(k) },
    fetch: async (_url, init) => {
      const body = JSON.parse(init.body);
      // Pré-checagem de estoque (nodes/availableForSale): tudo à venda, sem gastar respostas da fila.
      if (/query VariantStock/.test(body.query)) return { ok: true, status: 200, json: async () => ({ data: { nodes: body.variables.ids.map((id) => ({ id, availableForSale: true })) } }) };
      calls.push(body);
      const next = responses.shift();
      if (next instanceof Error) throw next;
      if (typeof next === 'function') return next(body);
      return { ok: true, status: 200, json: async () => next };
    },
    JSON,
    Error,
    Map,
    Set,
    Object,
  });
  return { cart: exports, calls, storage };
}

const cartOf = (lines) => ({ id: 'gid://shopify/Cart/C1', totalQuantity: lines.length, cost: {}, lines: { nodes: lines } });
const shopLine = (id, variant, pickup, ret, option) => ({
  id,
  quantity: 1,
  attributes: [
    { key: '_vsc_pickup', value: pickup },
    { key: '_vsc_return', value: ret },
    ...(option ? [{ key: '_vsc_return_option', value: option }] : []),
  ],
  merchandise: { id: variant },
});
const INPUT = { variantId: 'gid://shopify/ProductVariant/1', sku: '02', pickup: '2026-10-07', return: '2026-10-12', returnOption: 'mondayMorning', pickupLabel: '07/10/2026', returnLabel: '12/10/2026' };
const attrs = (lineInput) => Object.fromEntries(lineInput.attributes.map((a) => [a.key, a.value]));

test('payload do carrinho contém EXATAMENTE a data exibida (segunda 12/10) e a opção', async () => {
  const { cart, calls, storage } = loadCart({
    responses: [{ data: { cartCreate: { cart: cartOf([shopLine('L1', INPUT.variantId, '2026-10-07', '2026-10-12', 'mondayMorning')]), userErrors: [] } } }],
  });
  await cart.addRentalToCart(INPUT);
  assert.equal(calls.length, 1);
  assert.match(calls[0].query, /cartCreate/);
  assert.deepEqual(attrs(calls[0].variables.lines[0]), {
    Retirada: '07/10/2026',
    'Devolução': '12/10/2026',
    _vsc_pickup: '2026-10-07',
    _vsc_return: '2026-10-12',
    _vsc_return_option: 'mondayMorning',
    _vsc_sku: '02',
  });
  assert.equal(storage.get('vsc_cart_id'), 'gid://shopify/Cart/C1');
});

test('trocar sábado → segunda antes do checkout: atualiza a MESMA linha, não adiciona outra', async () => {
  const { cart, calls } = loadCart({
    storedCartId: 'gid://shopify/Cart/C1',
    responses: [
      { data: { cart: cartOf([shopLine('L1', INPUT.variantId, '2026-10-07', '2026-10-10', 'saturday')]) } },
      { data: { cartLinesUpdate: { cart: cartOf([shopLine('L1', INPUT.variantId, '2026-10-07', '2026-10-12', 'mondayMorning')]), userErrors: [] } } },
    ],
  });
  await cart.addRentalToCart(INPUT);
  assert.equal(calls.length, 2);
  assert.match(calls[1].query, /cartLinesUpdate/);
  assert.equal(calls[1].variables.lines[0].id, 'L1');
  assert.equal(attrs(calls[1].variables.lines[0])._vsc_return, '2026-10-12');
  assert.ok(!calls.some((c) => /cartLinesAdd/.test(c.query)));
});

test('clicar de novo com as mesmas datas: nenhuma mutação, nenhum item duplicado', async () => {
  const { cart, calls } = loadCart({
    storedCartId: 'gid://shopify/Cart/C1',
    responses: [{ data: { cart: cartOf([shopLine('L1', INPUT.variantId, '2026-10-07', '2026-10-12', 'mondayMorning')]) } }],
  });
  await cart.addRentalToCart(INPUT);
  assert.equal(calls.length, 1);
  assert.match(calls[0].query, /query Cart/);
});

test('erro da Shopify (userErrors) vira CartError com a mensagem real', async () => {
  const { cart } = loadCart({ responses: [{ data: { cartCreate: { cart: null, userErrors: [{ message: 'Merchandise is not available.' }] } } }] });
  await assert.rejects(cart.addRentalToCart(INPUT), (err) => err.name === 'CartError' && err.code === 'shopify' && /not available/.test(err.message));
});

test('Shopify responde sem erro mas não mantém a peça (estoque da loja): não finge sucesso', async () => {
  const { cart } = loadCart({ responses: [{ data: { cartCreate: { cart: cartOf([]), userErrors: [] } } }] });
  await assert.rejects(cart.addRentalToCart(INPUT), (err) => err.code === 'not_added');
});

test('carrinho salvo que expirou: esquece e cria outro, em vez de falhar para sempre', async () => {
  const { cart, calls, storage } = loadCart({
    storedCartId: 'gid://shopify/Cart/VELHO',
    responses: [
      { data: { cart: null } },
      { data: { cartCreate: { cart: cartOf([shopLine('L9', INPUT.variantId, '2026-10-07', '2026-10-12', 'mondayMorning')]), userErrors: [] } } },
    ],
  });
  await cart.addRentalToCart(INPUT);
  assert.match(calls[1].query, /cartCreate/);
  assert.equal(storage.get('vsc_cart_id'), 'gid://shopify/Cart/C1');
});

test('sem rede e HTTP 5xx da Shopify: CartError explícito', async () => {
  const offline = loadCart({ responses: [new TypeError('Failed to fetch')] });
  await assert.rejects(offline.cart.addRentalToCart(INPUT), (err) => err.code === 'network');
  const down = loadCart({ responses: [() => ({ ok: false, status: 503, json: async () => ({}) })] });
  await assert.rejects(down.cart.addRentalToCart(INPUT), (err) => err.code === 'shopify' && /503/.test(err.message));
});
