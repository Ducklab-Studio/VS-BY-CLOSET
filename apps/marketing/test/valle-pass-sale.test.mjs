import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

// Regras puras do pré-lançamento do Valle Pass: o estado vem SÓ da disponibilidade da Shopify (fail closed), a data é apenas previsão e os
// termos só aparecem quando houver endereço válido. O TS real é transpilado e executado aqui.
const root = new URL('../', import.meta.url);
const ts = createRequire(new URL('package.json', root))('typescript');
function load(file) {
  const js = ts.transpileModule(readFileSync(new URL(`src/lib/${file}`, root), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  const mod = { exports: {} };
  new Function("module", "exports", "process", js)(mod, mod.exports, { env: {} });
  return mod.exports;
}
const sale = load('vale-pass-sale.ts');
const terms = load('vale-pass-terms.ts');

test('a venda só está aberta quando a Shopify diz explicitamente que a variante está à venda (fail closed)', () => {
  assert.equal(sale.valePassSaleState({ availableForSale: true }), 'open');
  assert.equal(sale.valePassSaleState({ availableForSale: false }), 'closed');
  assert.equal(sale.valePassSaleState({}), 'closed');
  assert.equal(sale.valePassSaleState({ availableForSale: null }), 'closed');
  assert.equal(sale.valePassSaleState(null), 'closed');
  assert.equal(sale.valePassSaleState(undefined), 'closed');
});

test('a data NUNCA abre a venda: o estado não depende de relógio nem de data prevista', () => {
  assert.equal(sale.valePassSaleState.length, 1, 'o estado recebe só a variante');
  const source = readFileSync(new URL('src/lib/vale-pass-sale.ts', root), 'utf8');
  const body = /export function valePassSaleState[\s\S]*?\n}\n/.exec(source)[0];
  assert.ok(!/Date|now|VALE_PASS_EXPECTED_SALES_START/.test(body), 'valePassSaleState não pode olhar para datas');
});

test('previsão de 01/11/2026 aparece como previsão sujeita a confirmação, no fuso comercial de São Paulo', () => {
  assert.equal(sale.VALE_PASS_EXPECTED_SALES_START, '2026-11-01');
  assert.equal(sale.formatIsoDateBr('2026-11-01'), '01/11/2026');
  const previsao = 'Vendas previstas a partir de 01/11/2026 — data sujeita a confirmação.';
  assert.equal(sale.valePassClosedNote(new Date('2026-10-22T12:00:00Z')), previsao);
  assert.equal(sale.valePassClosedNote(new Date('2026-11-01T12:00:00Z')), previsao, 'no próprio dia ainda é previsão');
  // 01/11 23:59 em São Paulo (UTC-3) = 02/11 02:59 UTC: ainda é o dia 1º comercial
  assert.equal(sale.valePassClosedNote(new Date('2026-11-02T02:59:00Z')), previsao);
});

test('depois da data prevista, a página não repete uma data vencida', () => {
  // 02/11 00:00 em São Paulo = 02/11 03:00 UTC
  const depois = 'A abertura das vendas será anunciada em breve.';
  assert.equal(sale.valePassClosedNote(new Date('2026-11-02T03:00:00Z')), depois);
  assert.equal(sale.valePassClosedNote(new Date('2027-02-01T12:00:00Z')), depois);
});

test('termos: só caminho interno ou https; sem endereço, nada é afirmado', () => {
  assert.equal(terms.parseTermsHref(undefined), null);
  assert.equal(terms.parseTermsHref(null), null);
  assert.equal(terms.parseTermsHref(''), null);
  assert.equal(terms.parseTermsHref('   '), null);
  assert.equal(terms.parseTermsHref('/termos-valle-pass'), '/termos-valle-pass');
  assert.equal(terms.parseTermsHref(' /termos/valle-pass '), '/termos/valle-pass');
  assert.equal(terms.parseTermsHref('https://www.vallebycloset.com/termos'), 'https://www.vallebycloset.com/termos');
  for (const ruim of ['//evil.example/termos', 'http://exemplo.com/termos', 'javascript:alert(1)', 'data:text/html,x', '/com espaco', 'termos-sem-barra', 'ftp://x.com/a']) {
    assert.equal(terms.parseTermsHref(ruim), null, ruim);
  }
  assert.equal(terms.VALE_PASS_TERMS_HREF, null, 'sem a variável de ambiente, não há termos publicados');
});
