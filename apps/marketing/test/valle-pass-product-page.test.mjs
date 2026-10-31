import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

// Página do PRODUTO Valle Pass (/pecas/<handle>): nada da descrição editável da Shopify, metadados só com o texto aprovado, noindex enquanto a venda não estiver liberada.
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
const productPage = readFileSync(new URL('src/app/pecas/[handle]/page.tsx', root), 'utf8');
const valePassPage = readFileSync(new URL('src/app/valle-pass/page.tsx', root), 'utf8');

test('o texto dos metadados do produto é EXATAMENTE o aprovado de /valle-pass (uma só fonte) e não cita benefício sem condições', () => {
  assert.equal(offer.VALE_PASS_PUBLIC_DESCRIPTION, 'Conheça o Valle Pass 2027: um voucher de R$ 500 para a Valle Showroom e outro de R$ 50 para a VS BY CLOSET.');
  assert.ok(valePassPage.includes(`description: '${offer.VALE_PASS_PUBLIC_DESCRIPTION}'`), '/valle-pass e o produto precisam dizer a mesma coisa');
  assert.doesNotMatch(offer.VALE_PASS_PUBLIC_DESCRIPTION + offer.VALE_PASS_PRODUCT_LABEL, /10\s?%|desconto|passeio|\btransfers?\b|Valle Experience|Valle Compras/i);
  assert.equal(offer.VALE_PASS_PRODUCT_LABEL, 'Valle Pass 2027');
});

test('metadados do produto: título/descrição/Open Graph só do texto aprovado; noindex ENQUANTO NÃO indexável; a imagem do produto é mantida', () => {
  const closed = offer.valePassProductMetadata({ indexable: false, imageUrl: 'https://cdn.example/valle-pass.jpg' });
  assert.deepEqual(closed.robots, { index: false, follow: false });
  assert.equal(closed.title, 'Valle Pass 2027');
  assert.equal(closed.description, offer.VALE_PASS_PUBLIC_DESCRIPTION);
  assert.equal(closed.openGraph.description, offer.VALE_PASS_PUBLIC_DESCRIPTION);
  assert.equal(closed.openGraph.title, 'Valle Pass 2027');
  assert.deepEqual(closed.openGraph.images, [{ url: 'https://cdn.example/valle-pass.jpg' }]);
  assert.equal(offer.valePassProductMetadata({ indexable: false }).openGraph.images, undefined);
  assert.deepEqual(offer.valePassProductMetadata({ indexable: true }).robots, { index: true, follow: true });
});

test('a indexação do produto usa a MESMA regra da página /valle-pass (venda aberta + termos publicados + texto aprovado)', () => {
  const gate = (saleState, termsHref, termsApproved) => offer.valePassPageIndexable({ saleState, termsHref, termsApproved });
  assert.equal(gate('closed', '/termos-valle-pass', true), false);
  assert.equal(gate('open', null, true), false);
  assert.equal(gate('open', '/termos-valle-pass', false), false);
  assert.equal(gate('open', '/termos-valle-pass', true), true);
  // a página do produto decide com `valePassPageIndexable` (nunca com uma regra própria) e falha FECHADO
  assert.match(productPage, /valePassPageIndexable\(\{ saleState: offer\.saleState, termsHref: offer\.termsHref, termsApproved: TERMS_APPROVED \}\)/);
  assert.match(productPage, /catch \{\s*indexable = false;\s*\}/);
});

test('a página do produto: não exibe a descrição da Shopify do Valle Pass, troca o rótulo "O aluguel" e preserva o cartão e o aluguel das demais peças', () => {
  assert.match(productPage, /\{descriptionHtml && !isValePass && \(/, 'a descrição editável não é renderizada para o Valle Pass');
  assert.match(productPage, /\{isValePass \? VALE_PASS_PRODUCT_LABEL : 'O aluguel'\}/, 'o rótulo do aluguel continua para as peças');
  assert.match(productPage, /<ValePassPresentation variant=\{variant\} productTitle=\{product\.title\} \/>/, 'o cartão aprovado e suas travas seguem iguais');
  assert.match(productPage, /return valePassProductMetadata\(\{ indexable, imageUrl: product\.featuredImage\?\.url \?\? null \}\);/);
  // peças de aluguel continuam usando a descrição da Shopify nos metadados
  assert.match(productPage, /description: product\.description\?\.slice\(0, 160\)/);
  // nada do checkout foi mexido por esta página: a decisão continua toda em ValePassPresentation/resolveValePassCheckout
  assert.doesNotMatch(productPage, /valePassCheckoutHref|resolveValePassCheckout/);
});

test('/valle-pass não foi alterada: continua noindex quando não indexável e sem 10%', () => {
  assert.match(valePassPage, /robots: indexable \? \{ index: true, follow: true \} : \{ index: false, follow: false \}/);
  assert.doesNotMatch(valePassPage, /10\s?%|Valle Experience|desconto/i);
});
