import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync, readdirSync } from 'node:fs';
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

test('liberação comercial: só com a Shopify aberta E os termos publicados E aprovados (as 8 combinações)', () => {
  const states = ['closed', 'open'];
  const hrefs = [null, '/termos-valle-pass'];
  const approvals = [false, true];
  let releases = 0;
  for (const saleState of states)
    for (const termsHref of hrefs)
      for (const termsApproved of approvals) {
        const gate = offer.valePassPageGate({ saleState, termsHref, termsApproved });
        const expected = saleState === 'open' && termsHref !== null && termsApproved === true;
        assert.equal(gate.purchasable, expected, `${saleState} / ${termsHref} / aprovado=${termsApproved}`);
        if (gate.purchasable) releases++;
      }
  assert.equal(releases, 1, 'exatamente UMA combinação libera a compra');
  assert.deepEqual(offer.valePassPageGate({ saleState: 'closed', termsHref: null, termsApproved: false }), { purchasable: false, reason: 'sale_closed' });
  assert.deepEqual(offer.valePassPageGate({ saleState: 'open', termsHref: null, termsApproved: true }), { purchasable: false, reason: 'terms_pending' });
  assert.deepEqual(offer.valePassPageGate({ saleState: 'open', termsHref: '', termsApproved: true }), { purchasable: false, reason: 'terms_pending' });
  assert.deepEqual(offer.valePassPageGate({ saleState: 'open', termsHref: '/termos-valle-pass', termsApproved: false }), { purchasable: false, reason: 'terms_pending' });
  assert.deepEqual(offer.valePassPageGate({ saleState: 'open', termsHref: '/termos-valle-pass', termsApproved: true }), { purchasable: true, reason: 'ok' });
  // fail closed: valores estranhos nunca liberam
  assert.equal(offer.valePassPageGate({ saleState: undefined, termsHref: '/t', termsApproved: true }).purchasable, false);
  assert.equal(offer.valePassPageGate({ saleState: 'open', termsHref: '/t', termsApproved: 'true' }).purchasable, false);
  assert.equal(offer.valePassPageGate({ saleState: 'open', termsHref: '/t', termsApproved: undefined }).purchasable, false);
});

test('enquanto o texto dos termos for rascunho (TERMS_APPROVED = false), NENHUM caminho pode liberar o checkout', () => {
  const draft = readFileSync(new URL('src/lib/vale-pass-terms-draft.ts', root), 'utf8');
  assert.match(draft, /export const TERMS_APPROVED = false;/, 'o texto oficial ainda não foi aprovado');
});

test('há um ÚNICO caminho para o checkout: só resolveValePassCheckout chama valePassCheckoutHref, e o cartão antigo e a página nova passam por ele', () => {
  const walk = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((entry) => (entry.isDirectory() ? walk(new URL(`${entry.name}/`, dir)) : [new URL(entry.name, dir)]));
  const callers = walk(new URL('src/', root))
    .filter((file) => /\.(ts|tsx)$/.test(file.pathname))
    .filter((file) => /valePassCheckoutHref\(/.test(readFileSync(file, 'utf8')))
    .map((file) => file.pathname.split('/src/')[1])
    .sort();
  assert.deepEqual(callers, ['lib/vale-pass-offer-data.ts', 'lib/vale-pass-product.ts'], 'só a definição e a decisão única podem tocar no permalink do checkout');
  const card = readFileSync(new URL('src/components/ValePassPresentation.tsx', root), 'utf8');
  const page = readFileSync(new URL('src/app/valle-pass/page.tsx', root), 'utf8');
  const data = readFileSync(new URL('src/lib/vale-pass-offer-data.ts', root), 'utf8');
  assert.match(card, /resolveValePassCheckout\(/, 'o cartão usa a decisão única');
  assert.doesNotMatch(card, /valePassCheckoutHref/, 'o cartão não monta o checkout por conta própria');
  assert.match(data, /resolveValePassCheckout\(\{ saleState, variantId: variant\?\.id \}\)/, 'a página usa a decisão única');
  assert.doesNotMatch(page, /valePassCheckoutHref/, 'a página não monta o checkout por conta própria');
  assert.match(data, /termsApproved: TERMS_APPROVED/, 'a decisão exige os termos APROVADOS');
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
  assert.match(note, /somente depois da publicação e da aprovação dos termos e condições/);
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
