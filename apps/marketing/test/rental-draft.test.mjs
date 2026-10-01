import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';

// "Adicionar outra peça": reserva em montagem (o TS real, transpilado) e o
// carrinho com várias peças, com a Cart API da Shopify simulada — sem rede.
const root = new URL('../', import.meta.url);
const ts = createRequire(new URL('package.json', root))('typescript');
const transpile = (path) =>
  ts.transpileModule(readFileSync(new URL(path, root), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2021 },
  }).outputText;
const plain = (value) => JSON.parse(JSON.stringify(value));

const priceLib = {};
runInNewContext(transpile('src/lib/rental-price.ts'), { exports: priceLib, Set, Map, Number, Math, String });
const draftLib = {};
const draftRequire = (name) => {
  if (name === './rental-price') return priceLib;
  throw new Error(`import inesperado: ${name}`);
};
runInNewContext(transpile('src/lib/rental-draft.ts'), { exports: draftLib, require: draftRequire, JSON, Set, Number, Math, Array, encodeURIComponent, decodeURIComponent });
const selectionLib = {};
runInNewContext(transpile('src/lib/rental-selection.ts'), { exports: selectionLib, Date, Number, Set });
const shopifyLib = {};
runInNewContext(transpile('src/lib/shopify.ts'), { exports: shopifyLib, process: { env: {} }, Number, Intl });
const valePassLib = {};
runInNewContext(transpile('src/lib/vale-pass-product.ts'), { exports: valePassLib, require: () => shopifyLib, process: { env: {} } });
const { EMPTY_DRAFT, RENTAL_DRAFT_TTL_MS, addPiece, removePiece, withDates, selectionWith, atPieceLimit, parseDraft, isDraftExpired, saveDraft, loadDraft, draftCookie, draftRawFromCookie } = draftLib;
const { selectionTotal } = priceLib;

const piece = (n, price = '150.0') => ({ variantId: `gid://shopify/ProductVariant/${n}`, sku: `VS-${n}`, title: `Peça ${n}`, handle: `peca-${n}`, priceAmount: price, currencyCode: 'BRL' });

test('adicionar uma segunda peça e várias peças; a peça da página entra uma vez só', () => {
  let draft = EMPTY_DRAFT;
  const first = addPiece(draft, piece(1), 6, 0);
  assert.equal(first.added, true);
  draft = first.draft;
  draft = addPiece(draft, piece(2), 6, 0).draft;
  draft = addPiece(draft, piece(3), 6, 0).draft;
  assert.deepEqual(plain(selectionWith(draft, piece(4))).map((p) => p.sku), ['VS-1', 'VS-2', 'VS-3', 'VS-4']);
  assert.deepEqual(plain(selectionWith(draft, piece(2))).map((p) => p.sku), ['VS-1', 'VS-2', 'VS-3']);
});

test('impede duplicar a mesma variante', () => {
  const draft = addPiece(EMPTY_DRAFT, piece(1), 6, 0).draft;
  const again = addPiece(draft, piece(1), 6, 0);
  assert.equal(again.added, false);
  assert.equal(again.reason, 'duplicate');
  assert.equal(again.draft.pieces.length, 1);
  // Mesmo guardado duplicado por fora, ao ler vira uma peça só.
  assert.equal(parseDraft(JSON.stringify({ ...draft, pieces: [piece(1), piece(1)], updatedAt: 1 })).pieces.length, 1);
});

test('remover uma peça', () => {
  const draft = [piece(1), piece(2), piece(3)].reduce((d, p) => addPiece(d, p, 6, 0).draft, EMPTY_DRAFT);
  assert.deepEqual(plain(removePiece(draft, piece(2).variantId).pieces).map((p) => p.sku), ['VS-1', 'VS-3']);
});

test('limite de peças por reserva, contando as que já estão no carrinho', () => {
  const five = [1, 2, 3, 4, 5].map((n) => piece(n)).reduce((d, p) => addPiece(d, p, 6, 0).draft, EMPTY_DRAFT);
  assert.equal(addPiece(five, piece(6), 6, 0).added, true);
  assert.equal(addPiece(five, piece(6), 6, 1).reason, 'limit'); // 5 + 1 no carrinho + esta = 7
  assert.equal(atPieceLimit(6, 0, 6), true);
  assert.equal(atPieceLimit(5, 0, 6), false);
  assert.equal(atPieceLimit(5, 1, 6), true);
  assert.equal(atPieceLimit(9, 9, null), false); // API antiga sem máximo: o backend decide
});

test('valor total soma as peças (o valor não muda com os dias); moedas diferentes não somam', () => {
  assert.deepEqual(plain(selectionTotal([piece(1, '150.0'), piece(2, '89.90'), piece(3, '10.05')])), { status: 'ok', cents: 24995, amount: '249.95', currencyCode: 'BRL' });
  assert.deepEqual(plain(selectionTotal([piece(1, '200.0'), piece(2, '0.0')])).amount, '200.00');
  assert.equal(selectionTotal([]).status, 'empty');
  assert.equal(selectionTotal([piece(1), { ...piece(2), currencyCode: 'CLP' }]).status, 'mixed_currency');
});

test('peça com preço zero, ausente ou ilegível continua na seleção (zero é zero; ausente é "a confirmar")', () => {
  const stored = JSON.stringify({ pickup: null, returnOption: null, updatedAt: 1, pieces: [piece(1, '0.0'), piece(2, null), piece(3, ''), piece(4, 'abc'), { ...piece(5, '10'), currencyCode: '' }] });
  const pieces = plain(parseDraft(stored).pieces);
  assert.deepEqual(pieces.map((p) => [p.sku, p.priceAmount]), [['VS-1', '0.0'], ['VS-2', null], ['VS-3', null], ['VS-4', null], ['VS-5', null]]);
  assert.equal(selectionTotal(parseDraft(stored).pieces).status, 'missing');
  assert.equal(selectionTotal(parseDraft(stored).pieces.slice(0, 1)).amount, '0.00');
});

test('retirada e opção de devolução valem para todas as peças; atualizar a página preserva tudo', () => {
  const store = new Map();
  const storage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v), removeItem: (k) => store.delete(k) };
  let draft = addPiece(EMPTY_DRAFT, piece(1), 6, 0).draft;
  draft = withDates(draft, '2026-10-07', 'mondayMorning');
  saveDraft(storage, draft, 1_000);
  const reloaded = loadDraft(storage, 2_000);
  assert.deepEqual(plain(reloaded), { pickup: '2026-10-07', returnOption: 'mondayMorning', pieces: [plain(piece(1))], returnDate: null, returnForPieces: null, updatedAt: 1_000 });
  // Trocar sábado/segunda muda só a opção, mantendo as peças.
  assert.equal(withDates(reloaded, '2026-10-07', 'saturday').returnOption, 'saturday');
  // Data inválida nunca é guardada.
  assert.equal(withDates(reloaded, '07/10/2026', null).pickup, null);
});

test('seleção vencida (3 dias) ou vazia não fica guardada', () => {
  const store = new Map();
  const storage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v), removeItem: (k) => store.delete(k) };
  saveDraft(storage, addPiece(EMPTY_DRAFT, piece(1), 6, 0).draft, 0);
  assert.equal(loadDraft(storage, RENTAL_DRAFT_TTL_MS + 1).pieces.length, 0);
  assert.equal(isDraftExpired('lixo', 5), true);
  saveDraft(storage, EMPTY_DRAFT, 10);
  assert.equal(store.size, 0);
  assert.equal(parseDraft('{"pieces":[{"variantId":1}],"updatedAt":1}').pieces.length, 0);
});

test('cookie espelho: o catálogo do servidor lê a mesma seleção; vencido, vazio ou adulterado não vale', () => {
  const draft = withDates(addPiece(EMPTY_DRAFT, piece(1), 6, 0).draft, '2026-10-08', null);
  const cookie = draftCookie(draft, 5_000);
  const raw = draftRawFromCookie(cookie, 6_000);
  assert.deepEqual(plain(parseDraft(raw)).pieces.map((p) => p.handle), ['peca-1']);
  assert.equal(parseDraft(raw).pickup, '2026-10-08');
  assert.equal(draftRawFromCookie(cookie, 5_000 + RENTAL_DRAFT_TTL_MS + 1), null);
  assert.equal(draftCookie(EMPTY_DRAFT, 1), null);
  assert.equal(draftRawFromCookie('%E0%A4%A', 1), null);
  // Handle vira link: só o formato de handle é aceito.
  const evil = encodeURIComponent(JSON.stringify({ ...draft, pieces: [{ ...piece(1), handle: '../../admin' }], updatedAt: 5_000 }));
  assert.equal(draftRawFromCookie(evil, 6_000), null);
});

// ── carrinho: todas as peças juntas, com as mesmas datas ──────────────────
// cart.ts consulta o estoque fresco da Shopify (lib/shopify-stock.ts, puro).
const shopifyStockLib = {};
runInNewContext(transpile('src/lib/shopify-stock.ts'), { exports: shopifyStockLib, Number, Object });
function loadCart({ storedCartId = null, responses }) {
  const storage = new Map(storedCartId ? [['vsc_cart_id', storedCartId]] : []);
  const calls = [];
  const exports = {};
  runInNewContext(transpile('src/lib/cart.ts'), {
    AbortController, setTimeout, clearTimeout,
    exports,
    require: (name) => {
      if (name === './rental-selection') return selectionLib;
      if (name === './vale-pass-product') return valePassLib;
      if (name === './shopify-stock') return shopifyStockLib;
      throw new Error(`import inesperado: ${name}`);
    },
    process: { env: { NEXT_PUBLIC_SHOPIFY_STORE_DOMAIN: 'loja-teste.myshopify.com', NEXT_PUBLIC_SHOPIFY_STOREFRONT_TOKEN: 'token-publico-de-teste' } },
    localStorage: { getItem: (k) => storage.get(k) ?? null, setItem: (k, v) => storage.set(k, v), removeItem: (k) => storage.delete(k) },
    fetch: async (_url, init) => {
      const body = JSON.parse(init.body);
      // Pré-checagem de estoque (nodes/availableForSale): tudo à venda, sem gastar respostas da fila.
      if (/query VariantStock/.test(body.query)) return { ok: true, status: 200, json: async () => ({ data: { nodes: body.variables.ids.map((id) => ({ id, availableForSale: true })) } }) };
      calls.push(body);
      const next = responses.shift();
      return { ok: true, status: 200, json: async () => (typeof next === 'function' ? next(body) : next) };
    },
    JSON, Error, Map, Set, Object,
  });
  return { cart: exports, calls };
}

const shopLine = (id, variant, pickup, ret, option) => ({
  id, quantity: 1, merchandise: { id: variant, sku: null },
  attributes: [{ key: '_vsc_pickup', value: pickup }, { key: '_vsc_return', value: ret }, ...(option ? [{ key: '_vsc_return_option', value: option }] : [])],
});
const cartOf = (lines) => ({ id: 'gid://shopify/Cart/C1', totalQuantity: lines.length, cost: {}, lines: { nodes: lines } });
/** Aplica as mutações recebidas como a Shopify faria (para o carrinho devolvido refletir o pedido). */
const echoCreate = (body) => ({ data: { cartCreate: { cart: cartOf(body.variables.lines.map((l, i) => shopLine(`N${i}`, l.merchandiseId, ...['_vsc_pickup', '_vsc_return', '_vsc_return_option'].map((k) => l.attributes.find((a) => a.key === k)?.value)))), userErrors: [] } } });
const attrs = (line) => Object.fromEntries(line.attributes.map((a) => [a.key, a.value]));
const SELECTION = {
  pieces: [1, 2, 3].map((n) => ({ variantId: `gid://shopify/ProductVariant/${n}`, sku: `VS-${n}` })),
  pickup: '2026-10-07', return: '2026-10-12', returnOption: 'mondayMorning', pickupLabel: '07/10/2026', returnLabel: '12/10/2026',
};

test('carrinho novo: todas as peças numa única inclusão, cada uma com as datas certas', async () => {
  const { cart, calls } = loadCart({ responses: [echoCreate] });
  const result = await cart.addRentalSelectionToCart(SELECTION);
  assert.equal(calls.length, 1);
  assert.match(calls[0].query, /cartCreate/);
  assert.equal(calls[0].variables.lines.length, 3);
  for (const line of calls[0].variables.lines) {
    assert.deepEqual([attrs(line)._vsc_pickup, attrs(line)._vsc_return, attrs(line)._vsc_return_option], ['2026-10-07', '2026-10-12', 'mondayMorning']);
  }
  assert.equal(result.lines.length, 3);
});

test('carrinho existente: peça que já estava tem as datas atualizadas (sem duplicar), as novas entram, e outra peça da mesma retirada acompanha a devolução', async () => {
  const existing = [
    shopLine('L1', 'gid://shopify/ProductVariant/1', '2026-10-07', '2026-10-10', 'saturday'), // está na seleção
    shopLine('L9', 'gid://shopify/ProductVariant/9', '2026-10-07', '2026-10-10', 'saturday'), // fora da seleção, mesma retirada
    shopLine('L8', 'gid://shopify/ProductVariant/8', '2026-11-20', '2026-11-23'), // outra retirada: intocada
  ];
  const after = [
    shopLine('L1', 'gid://shopify/ProductVariant/1', '2026-10-07', '2026-10-12', 'mondayMorning'),
    shopLine('L9', 'gid://shopify/ProductVariant/9', '2026-10-07', '2026-10-12', 'mondayMorning'),
    existing[2],
  ];
  const newLines = [shopLine('N2', 'gid://shopify/ProductVariant/2', '2026-10-07', '2026-10-12', 'mondayMorning'), shopLine('N3', 'gid://shopify/ProductVariant/3', '2026-10-07', '2026-10-12', 'mondayMorning')];
  const { cart, calls } = loadCart({
    storedCartId: 'gid://shopify/Cart/C1',
    responses: [
      { data: { cart: cartOf(existing) } },
      // Primeiro as peças novas (se a Shopify recusar alguma, nada mais muda)…
      { data: { cartLinesAdd: { cart: cartOf([...existing, ...newLines]), userErrors: [] } } },
      // …depois as datas das que já estavam.
      { data: { cartLinesUpdate: { cart: cartOf([...after, ...newLines]), userErrors: [] } } },
    ],
  });
  await cart.addRentalSelectionToCart(SELECTION);
  assert.deepEqual(calls.map((c) => c.query.match(/(query Cart|cartLinesUpdate|cartLinesAdd|cartCreate)/)[1]), ['query Cart', 'cartLinesAdd', 'cartLinesUpdate']);
  assert.deepEqual(calls[2].variables.lines.map((l) => l.id).sort(), ['L1', 'L9']);
  assert.deepEqual(calls[1].variables.lines.map((l) => l.merchandiseId), ['gid://shopify/ProductVariant/2', 'gid://shopify/ProductVariant/3']);
  assert.ok(!JSON.stringify(calls).includes('"L8"'));
});

test('peça repetida na seleção vira uma linha só; seleção vazia não vai ao carrinho', async () => {
  const { cart, calls } = loadCart({ responses: [echoCreate] });
  await cart.addRentalSelectionToCart({ ...SELECTION, pieces: [SELECTION.pieces[0], SELECTION.pieces[0]] });
  assert.equal(calls[0].variables.lines.length, 1);
  const empty = loadCart({ responses: [] });
  await assert.rejects(empty.cart.addRentalSelectionToCart({ ...SELECTION, pieces: [] }), (err) => err.code === 'not_added');
});

test('a Shopify não gravou uma das peças: erro, nunca sucesso parcial silencioso', async () => {
  const { cart } = loadCart({ responses: [(body) => {
    const reply = echoCreate(body);
    reply.data.cartCreate.cart.lines.nodes.pop();
    return reply;
  }] });
  await assert.rejects(cart.addRentalSelectionToCart(SELECTION), (err) => err.code === 'not_added');
});
