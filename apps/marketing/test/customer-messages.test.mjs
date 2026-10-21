import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';

// O cliente do fluxo de aluguel nunca vê quantidade de estoque da Shopify nem texto técnico
// dela; as verificações e os bloqueios internos continuam exatamente como eram.
const root = new URL('../', import.meta.url);
const ts = createRequire(new URL('package.json', root))('typescript');
const transpile = (file) =>
  ts.transpileModule(readFileSync(new URL(file, root), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2021 },
  }).outputText;
const load = (file, globals = {}) => {
  const exports = {};
  runInNewContext(transpile(file), { exports, Number, String, Object, Array, Map, Set, Math, JSON, Promise, Error, ...globals });
  return exports;
};
const read = (file) => readFileSync(new URL(file, root), 'utf8').replace(/\r\n/g, '\n');
const messages = load('src/lib/customer-messages.ts');
const { customerFacingCartError, TEMPORARILY_UNAVAILABLE_MESSAGE } = messages;
const reason = load('src/lib/unavailable-reason.ts');
const stockLib = load('src/lib/rental-stock.ts', { require: () => ({}), process: { env: {} } });

// Texto que o cliente vê (sem comentários): tira /* */ e // para não reprovar explicações no código.
const visibleSource = (file) => read(file).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const CUSTOMER_FILES = [
  'src/app/carrinho/page.tsx',
  'src/components/CartDrawerDialog.tsx',
  'src/components/RentalCalendar.tsx',
  'src/components/RentalVariantPicker.tsx',
  'src/components/ProductCard.tsx',
  'src/lib/unavailable-reason.ts',
  'src/lib/customer-messages.ts',
];
const FORBIDDEN_TEXT = [
  'Estoque Shopify', 'Esgotada na Shopify', 'indisponível na Shopify', 'Disponível na Shopify', 'em estoque',
  'Estoque será validado', 'Conferindo estoque', 'considerando Shopify', 'Estoque físico', 'confirmado pela Shopify', 'carrinho (Shopify)',
];

test('mensagem única de peça indisponível, sem citar a Shopify', () => {
  assert.equal(TEMPORARILY_UNAVAILABLE_MESSAGE, 'Esta peça está temporariamente indisponível para aluguel.');
  assert.equal(reason.SHOPIFY_UNAVAILABLE_MESSAGE, TEMPORARILY_UNAVAILABLE_MESSAGE);
  assert.equal(/shopify|estoque/i.test(TEMPORARILY_UNAVAILABLE_MESSAGE), false);
});

test('telas do cliente (carrinho, gaveta, calendário, cartão): nenhum texto técnico nem quantidade de estoque da Shopify', () => {
  for (const file of CUSTOMER_FILES) {
    const src = visibleSource(file);
    for (const text of FORBIDDEN_TEXT) assert.equal(src.includes(text), false, `${file}: "${text}"`);
  }
  // a quantidade bruta da Shopify nunca é interpolada em texto visível
  for (const file of ['src/app/carrinho/page.tsx', 'src/components/CartDrawerDialog.tsx']) {
    assert.equal(/\$\{\s*(entry|stock|line)\.shopify\s*\}|shopifyStockLabel/.test(visibleSource(file)), false, file);
  }
});

test('aviso do estoque comercial: só "temporariamente indisponível" quando a Shopify confirma não vendável; nunca número', () => {
  const entry = (shopify, physical = 1, effective = 1) => ({ shopify, physical, effective });
  assert.equal(stockLib.rentalStockNotice(entry(0, 3, 0)), TEMPORARILY_UNAVAILABLE_MESSAGE);
  for (const shopify of [null, 1, 5, 199, 200]) assert.equal(stockLib.rentalStockNotice(entry(shopify)), null, String(shopify));
  assert.equal(typeof stockLib.shopifyStockLabel, 'undefined', 'o rótulo com quantidade não existe mais');
});

test('erros do carrinho: CartError (Shopify/rede/config) nunca aparece cru; erro comum das telas mantém o texto; peça não adicionada vira a mensagem única', () => {
  const cartError = (code, text) => Object.assign(new Error(text), { code });
  assert.equal(customerFacingCartError(cartError('shopify', 'Storefront API respondeu 500'), 'Não foi possível alterar a quantidade.'), 'Não foi possível alterar a quantidade.');
  assert.equal(customerFacingCartError(cartError('network', 'Sem resposta da Storefront API.'), 'Tente novamente.'), 'Tente novamente.');
  assert.equal(customerFacingCartError(cartError('config', 'Storefront API não configurada.'), 'Tente novamente.'), 'Tente novamente.');
  assert.equal(customerFacingCartError(cartError('not_added', 'qualquer'), 'x'), TEMPORARILY_UNAVAILABLE_MESSAGE);
  assert.equal(customerFacingCartError(new Error('Não foi possível confirmar a disponibilidade agora. Tente novamente.'), 'x'), 'Não foi possível confirmar a disponibilidade agora. Tente novamente.');
  assert.equal(customerFacingCartError('texto solto', 'fallback'), 'fallback');
  assert.equal(customerFacingCartError(null, 'fallback'), 'fallback');
});

test('as telas usam o filtro de erro; a mensagem interna do carrinho não cita a Shopify nem ids', () => {
  for (const file of ['src/app/carrinho/page.tsx', 'src/components/CartDrawerDialog.tsx']) {
    assert.match(read(file), /customerFacingCartError\(err, 'Não foi possível alterar a quantidade\.'\)/);
    assert.equal(/err instanceof Error \? err\.message/.test(read(file)), false, file);
  }
  const cart = read('src/lib/cart.ts');
  assert.equal(cart.includes('A Shopify não manteve'), false);
  assert.equal(cart.includes('A Shopify não devolveu'), false);
});

test('BLOQUEIOS preservados: estoque da Shopify ainda limita quantidade, bloqueia o envio e o checkout; SKUs, variantes e física seguem', () => {
  const calendar = read('src/components/RentalCalendar.tsx');
  assert.match(calendar, /const soldOut = shopifyStock\?\.status === 'sold_out';/);
  assert.match(calendar, /disabled=\{!canSubmit \|\| busy \|\| soldOut \|\| loading \|\| notRentable\}/);
  assert.match(calendar, /fetchVariantStock\(\[variant\.id\]\)/);
  for (const file of ['src/app/carrinho/page.tsx', 'src/components/CartDrawerDialog.tsx']) {
    const src = read(file);
    assert.match(src, /stock\.effective === null \? null : Math\.max\(0, stock\.effective - otherLinesQuantity\)/, file);
    assert.match(src, /nextQuantity > maxForThisLine/, file);
  }
  const stockSrc = read('src/lib/rental-stock.ts');
  assert.match(stockSrc, /effective: minKnown\(shopify, physical\)/);
  assert.match(stockSrc, /export async function fetchRentalStock/);
});

test('Valle Pass: compra direta intacta (não usa estas mensagens nem o calendário de aluguel)', () => {
  const presentation = read('src/components/ValePassPresentation.tsx');
  assert.equal(/TEMPORARILY_UNAVAILABLE|rentalStockNotice|customerFacingCartError|RentalCalendar/.test(presentation), false);
  assert.match(read('src/app/pecas/[handle]/page.tsx'), /isValePass \?\s*\(\s*<ValePassPresentation/);
  assert.match(read('src/lib/cart.ts'), /O Valle Pass não entra numa reserva de aluguel\./);
});

test('Valle Pass: nenhum texto público fala em vale-presente/presente nem promete transferência (vouchers intransferíveis); a página só afirma fatos confirmados', () => {
  const presentation = read('src/components/ValePassPresentation.tsx');
  assert.equal(/vale[- ]presente|presente(ar)?\b|(?<!in)transfer[ií]ve/i.test(presentation), false, 'vale-presente/transferível na página do Valle Pass');
  assert.match(presentation, /R\$ 500 para a Valle Showroom e um voucher de R\$ 50\s+para a VS BY CLOSET/);
  assert.match(presentation, /intransferíveis/);
  assert.equal(/qualquer peça/i.test(presentation), false, 'o uso não é "em qualquer peça do closet"');
  // nenhum outro arquivo de código do site (fora dos testes) volta a chamar o Valle Pass de vale-presente
  const offenders = [];
  const walk = (dir) => {
    for (const entry of readdirSync(new URL(dir, root), { withFileTypes: true })) {
      const rel = `${dir}${entry.name}`;
      if (entry.isDirectory()) walk(`${rel}/`);
      else if (/\.(tsx?|mjs)$/.test(entry.name) && /vale[- ]presente/i.test(readFileSync(new URL(rel, root), 'utf8'))) offenders.push(rel);
    }
  };
  walk('src/');
  assert.deepEqual(offenders, []);
});
