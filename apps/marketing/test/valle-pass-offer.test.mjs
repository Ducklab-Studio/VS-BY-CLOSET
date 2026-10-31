import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

// Regras e conteúdo PUROS da página /valle-pass: nada abre sozinho (fail closed), termos pendentes mantêm a oferta fechada e o texto nunca promete o que não
// tem texto oficial aprovado. O TS real é transpilado e executado aqui.
const root = new URL('../', import.meta.url);
const ts = createRequire(new URL('package.json', root))('typescript');
function load(file) {
  const js = ts.transpileModule(readFileSync(new URL(`src/lib/${file}`, root), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  const mod = { exports: {} };
  new Function('module', 'exports', 'process', js)(mod, mod.exports, { env: {} });
  return mod.exports;
}
const offer = load('vale-pass-offer.ts');

test('a oferta só é "pronta para compra" com a Shopify aberta E os termos publicados', () => {
  assert.deepEqual(offer.valePassPageGate({ saleState: 'closed', termsHref: null }), { purchasable: false, reason: 'sale_closed' });
  assert.deepEqual(offer.valePassPageGate({ saleState: 'closed', termsHref: '/termos-valle-pass' }), { purchasable: false, reason: 'sale_closed' });
  assert.deepEqual(offer.valePassPageGate({ saleState: 'open', termsHref: null }), { purchasable: false, reason: 'terms_pending' });
  assert.deepEqual(offer.valePassPageGate({ saleState: 'open', termsHref: '' }), { purchasable: false, reason: 'terms_pending' });
  assert.deepEqual(offer.valePassPageGate({ saleState: 'open', termsHref: '/termos-valle-pass' }), { purchasable: true, reason: 'ok' });
  assert.deepEqual(offer.valePassPageGate({ saleState: undefined, termsHref: '/termos-valle-pass' }), { purchasable: false, reason: 'sale_closed' });
});

test('noindex até a venda estar aberta, os termos publicados E o texto oficial aprovado', () => {
  const base = { saleState: 'open', termsHref: '/termos-valle-pass', termsApproved: true };
  assert.equal(offer.valePassPageIndexable(base), true);
  assert.equal(offer.valePassPageIndexable({ ...base, saleState: 'closed' }), false);
  assert.equal(offer.valePassPageIndexable({ ...base, termsHref: null }), false);
  assert.equal(offer.valePassPageIndexable({ ...base, termsApproved: false }), false);
});

test('aviso do bloqueio por termos pendentes não afirma que os termos existem', () => {
  const note = offer.valePassGateNote('terms_pending');
  assert.match(note, /somente depois da publicação dos termos e condições/);
  assert.equal(offer.valePassGateNote('ok'), null);
  assert.equal(offer.valePassGateNote('sale_closed'), null);
});

test('valores aprovados: R$ 350 de referência, voucher Valle Showroom R$ 500 e VS BY CLOSET R$ 50, intransferíveis por empresa', () => {
  assert.equal(offer.VALE_PASS_FALLBACK_PRICE_LABEL, 'R$ 350,00');
  assert.deepEqual(
    offer.VALE_PASS_VOUCHERS.map((voucher) => [voucher.company, voucher.amountLabel]),
    [
      ['Valle Showroom', 'R$ 500'],
      ['VS BY CLOSET', 'R$ 50'],
    ],
  );
  for (const voucher of offer.VALE_PASS_VOUCHERS) assert.match(voucher.note, /Uso exclusivo na /);
});

test('validade PREVISTA: 01/04/2027 a 15/10/2027, sempre com o aviso de que depende dos termos oficiais', () => {
  assert.equal(offer.formatDateBr('2027-04-01'), '01/04/2027');
  assert.equal(offer.valePassValidityText(), 'De 01/04/2027 a 15/10/2027');
  assert.match(offer.VALE_PASS_VALIDITY_DISCLAIMER, /previstas, sujeitas à confirmação/);
});

test('como funciona: quatro passos; o primeiro acompanha o estado da oferta; nenhum promete o que não foi aprovado', () => {
  const closed = offer.valePassHowItWorks(false);
  const open = offer.valePassHowItWorks(true);
  assert.equal(closed.length, 4);
  assert.equal(open.length, 4);
  assert.match(closed[0].text, /pré-lançamento/);
  assert.doesNotMatch(open[0].text, /pré-lançamento/);
  assert.match(open[0].text, /checkout oficial/);
  assert.deepEqual(closed.slice(1), open.slice(1), 'os demais passos não dependem do estado');
  const everything = [
    ...closed,
    ...open,
    ...offer.VALE_PASS_VOUCHERS.map((voucher) => ({ title: voucher.company, text: `${voucher.amountLabel} ${voucher.note}` })),
    { title: 'validade', text: `${offer.valePassValidityText()} ${offer.VALE_PASS_VALIDITY_DISCLAIMER}` },
    { title: 'bloqueio', text: offer.valePassGateNote('terms_pending') },
  ]
    .map((entry) => `${entry.title} ${entry.text}`)
    .join(' ');
  assert.doesNotMatch(everything, /10\s?%|desconto|reembols|cancelamento|desist|estoque|\blotes?\b|unidades|limitad|restam|últimas/i);
});

test('o módulo é puro (sem imports de runtime) e a página não referencia a lista antiga', () => {
  const source = readFileSync(new URL('src/lib/vale-pass-offer.ts', root), 'utf8');
  assert.doesNotMatch(source, /^import\s+(?!type)/m, 'sem imports de runtime');
  assert.doesNotMatch(readFileSync(new URL('src/app/valle-pass/page.tsx', root), 'utf8'), /VALE_PASS_HOW_IT_WORKS/);
});
