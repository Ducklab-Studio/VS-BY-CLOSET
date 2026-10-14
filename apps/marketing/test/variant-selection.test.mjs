import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';

// Escolha de variante (tamanho) na página da peça: lógica pura + guardas de estrutura.
const root = new URL('../', import.meta.url);
const ts = createRequire(new URL('package.json', root))('typescript');
const transpile = (file) =>
  ts.transpileModule(readFileSync(new URL(file, root), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2021 },
  }).outputText;
const lib = {};
runInNewContext(transpile('src/lib/variant-selection.ts'), { exports: lib, String });
const { isDefaultVariantTitle, needsVariantPicker, initialVariantId } = lib;
const read = (file) => readFileSync(new URL(file, root), 'utf8').replace(/\r\n/g, '\n');

const v = (id, title, availableForSale = true) => ({ id: `gid://shopify/ProductVariant/${id}`, title, availableForSale });

test('seletor só aparece com mais de uma variante; uma variante só mantém a tela de antes', () => {
  assert.equal(needsVariantPicker([]), false);
  assert.equal(needsVariantPicker([v(1, 'M')]), false);
  assert.equal(needsVariantPicker([v(1, 'P'), v(2, 'M')]), true);
});

test('título padrão da Shopify ("Default Title") não vira rótulo de tamanho', () => {
  assert.equal(isDefaultVariantTitle('Default Title'), true);
  assert.equal(isDefaultVariantTitle(' default title '), true);
  assert.equal(isDefaultVariantTitle(''), true);
  assert.equal(isDefaultVariantTitle(null), true);
  assert.equal(isDefaultVariantTitle('M'), false);
});

test('variante inicial: a pedida se existir; senão a primeira à venda; senão a primeira; nunca um id que não está na lista', () => {
  const list = [v(1, 'P', false), v(2, 'M'), v(3, 'G')];
  assert.equal(initialVariantId(list), list[1].id);
  assert.equal(initialVariantId(list, list[2].id), list[2].id);
  assert.equal(initialVariantId(list, 'gid://shopify/ProductVariant/999'), list[1].id);
  assert.equal(initialVariantId([v(1, 'P', false), v(2, 'M', false)]), 'gid://shopify/ProductVariant/1');
  assert.equal(initialVariantId([]), null);
});

test('página da peça: usa o seletor, mostra o preço da variante escolhida e não duplica o preço fixo quando há várias', () => {
  const page = read('src/app/pecas/[handle]/page.tsx');
  assert.match(page, /<RentalVariantPicker\s+variants=\{product\.variants\}/);
  assert.match(page, /variant && !multipleVariants/);
  assert.equal(page.includes('variants[0]') && /<RentalCalendar/.test(page), false, 'a página não monta o calendário direto com a primeira variante');
});

test('seletor: cada tamanho reinicia o calendário (key pela variante) — datas de um tamanho nunca vazam para outro', () => {
  const picker = read('src/components/RentalVariantPicker.tsx');
  assert.match(picker, /<RentalCalendar key=\{selected\.id\}/);
  assert.match(picker, /role="radiogroup"/);
  assert.match(picker, /aria-checked=\{active\}/);
  // identificação sempre pelo ID da variante, nunca pelo título ou SKU
  assert.match(picker, /data-variant-option=\{variant\.id\}/);
});
