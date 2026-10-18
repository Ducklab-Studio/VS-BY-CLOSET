import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { runInNewContext } from 'node:vm';

// Opções e variantes da peça (o TS real, transpilado): tamanhos vêm SÓ do que a
// Shopify devolve (nome, valor, ordem e id da variante), nunca de uma lista no código.
const root = new URL('../', import.meta.url);
const ts = createRequire(new URL('package.json', root))('typescript');
const transpile = (file) =>
  ts.transpileModule(readFileSync(new URL(file, root), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2021 },
  }).outputText;
const lib = {};
runInNewContext(transpile('src/lib/product-options.ts'), { exports: lib, Object, Number, String, Array, Map, Set, RegExp });
const { optionGroups, findVariant, valueSellable, selectionFor, optionLabel, numericId, variantFromParam, productHref, priceSummary } = lib;
const plain = (value) => JSON.parse(JSON.stringify(value));

const gid = (n) => `gid://shopify/ProductVariant/${n}`;
const price = (amount) => ({ amount, currencyCode: 'BRL' });
/** Variante como a Storefront API devolve: `selectedOptions` com nome e valor reais. */
const variant = (n, options, extra = {}) => ({ id: gid(n), sku: `SKU-${n}`, title: options.map((o) => o[1]).join(' / ') || 'Default Title', availableForSale: true, price: price('100.0'), selectedOptions: options.map(([name, value]) => ({ name, value })), ...extra });

test('P, M e G: um grupo, valores na ordem da Shopify, cada um ligado à sua variante', () => {
  const variants = [variant(1, [['Tamanho', 'P']]), variant(2, [['Tamanho', 'M']]), variant(3, [['Tamanho', 'G']])];
  const groups = optionGroups(variants);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].name, 'Tamanho');
  assert.deepEqual(plain(groups[0].values.map((v) => v.label)), ['P', 'M', 'G']);
  assert.equal(groups[0].sizeLike, true);
  for (const [value, id] of [['P', 1], ['M', 2], ['G', 3]]) {
    const picked = findVariant(variants, groups, { [groups[0].key]: groups[0].values.find((v) => v.label === value).key });
    assert.equal(picked.id, gid(id), `tamanho ${value} → variante ${id}`);
  }
});

test('P, M, G e GG; ordem e rótulos exatamente como cadastrados (não reordena, não reescreve)', () => {
  const variants = [variant(10, [['Tamanho', 'GG']]), variant(11, [['Tamanho', 'P']]), variant(12, [['Tamanho', 'G']]), variant(13, [['Tamanho', 'M']])];
  const [group] = optionGroups(variants);
  assert.deepEqual(plain(group.values.map((v) => v.label)), ['GG', 'P', 'G', 'M']);
});

test('o nome da opção é o que a Shopify cadastrou: Size, Tamanhos ou qualquer outro', () => {
  for (const name of ['Size', 'Tamanhos', 'Numeração', 'Medida da bota']) {
    const [group] = optionGroups([variant(1, [[name, '38']]), variant(2, [[name, '40']])]);
    assert.equal(group.name, name);
    assert.deepEqual(plain(group.values.map((v) => v.label)), ['38', '40']);
  }
  assert.equal(optionGroups([variant(1, [['Numeração', '38']]), variant(2, [['Numeração', '40']])])[0].sizeLike, false);
  assert.equal(optionGroups([variant(1, [['Size', 'S']]), variant(2, [['Size', 'L']])])[0].sizeLike, true);
});

test('tamanho único, uma variante e peça sem opção: sem seletor', () => {
  assert.deepEqual(plain(optionGroups([variant(1, [['Tamanho', 'Único']])])), []);
  assert.deepEqual(plain(optionGroups([variant(1, [['Title', 'Default Title']])])), []);
  assert.deepEqual(plain(optionGroups([variant(1, [])])), []);
  assert.deepEqual(plain(optionGroups([])), []);
  // O espaço reservado da Shopify nunca vira opção, mesmo com várias variantes iguais.
  assert.deepEqual(plain(optionGroups([variant(1, [['Title', 'Default Title']]), variant(2, [['Title', 'Default Title']])])), []);
});

test('nomes que só diferem em caixa/espaço não duplicam o tamanho; a primeira escrita é a exibida', () => {
  const variants = [variant(1, [['Tamanho', 'M']]), variant(2, [['tamanho ', ' m ']]), variant(3, [['Tamanho', 'G']])];
  const groups = optionGroups(variants);
  assert.equal(groups.length, 1);
  assert.deepEqual(plain(groups[0].values.map((v) => v.label)), ['M', 'G']);
  // Duplicada: escolhe a primeira à venda.
  const sold = [variant(1, [['Tamanho', 'M']], { availableForSale: false }), variant(2, [['Tamanho', 'm']]), variant(3, [['Tamanho', 'G']])];
  const g = optionGroups(sold);
  const mKey = g[0].values[0].key;
  assert.equal(findVariant(sold, g, { [g[0].key]: mKey }, (v) => v.availableForSale).id, gid(2));
});

test('nenhuma variante é escolhida sozinha: sem escolha completa, não há variante', () => {
  const variants = [variant(1, [['Tamanho', 'P']]), variant(2, [['Tamanho', 'M']])];
  const groups = optionGroups(variants);
  assert.equal(findVariant(variants, groups, {}), null);
  const colors = [variant(1, [['Cor', 'Preto'], ['Tamanho', 'P']]), variant(2, [['Cor', 'Preto'], ['Tamanho', 'M']]), variant(3, [['Cor', 'Vinho'], ['Tamanho', 'P']]), variant(4, [['Cor', 'Vinho'], ['Tamanho', 'M']])];
  const cg = optionGroups(colors);
  assert.deepEqual(plain(cg.map((g) => g.name)), ['Tamanho', 'Cor'], 'tamanho primeiro, o resto na ordem da Shopify');
  const size = cg.find((g) => g.name === 'Tamanho');
  const color = cg.find((g) => g.name === 'Cor');
  assert.equal(findVariant(colors, cg, { [size.key]: size.values[1].key }), null, 'só o tamanho: falta a cor');
  assert.equal(findVariant(colors, cg, { [size.key]: size.values[1].key, [color.key]: color.values[1].key }).id, gid(4));
});

test('estoque: tamanho esgotado fica indisponível (não some) e não pode ser a variante escolhida', () => {
  const variants = [variant(1, [['Tamanho', 'P']]), variant(2, [['Tamanho', 'M']], { availableForSale: false }), variant(3, [['Tamanho', 'G']])];
  const groups = optionGroups(variants);
  const g = groups[0];
  const sellable = (v) => v.availableForSale;
  assert.equal(g.values.length, 3, 'o esgotado continua na lista');
  assert.deepEqual(plain(g.values.map((v) => valueSellable(variants, groups, {}, g.key, v.key, sellable))), [true, false, true]);
  assert.equal(findVariant(variants, groups, { [g.key]: g.values[1].key }, sellable), null);
});

test('com duas opções, a disponibilidade de cada valor respeita o que já foi escolhido', () => {
  const variants = [
    variant(1, [['Cor', 'Preto'], ['Tamanho', 'P']]),
    variant(2, [['Cor', 'Preto'], ['Tamanho', 'M']], { availableForSale: false }),
    variant(3, [['Cor', 'Vinho'], ['Tamanho', 'P']], { availableForSale: false }),
    variant(4, [['Cor', 'Vinho'], ['Tamanho', 'M']]),
  ];
  const groups = optionGroups(variants);
  const size = groups.find((g) => g.name === 'Tamanho');
  const color = groups.find((g) => g.name === 'Cor');
  const sellable = (v) => v.availableForSale;
  const preto = { [color.key]: color.values[0].key };
  assert.equal(valueSellable(variants, groups, preto, size.key, size.values[0].key, sellable), true, 'Preto + P');
  assert.equal(valueSellable(variants, groups, preto, size.key, size.values[1].key, sellable), false, 'Preto + M esgotado');
  assert.equal(valueSellable(variants, groups, {}, size.key, size.values[1].key, sellable), true, 'sem cor: M existe em Vinho');
});

test('a escolha volta a ser a mesma variante (restauração) e rótulos mostram nome e valor reais', () => {
  const variants = [variant(1, [['Cor', 'Preto'], ['Tamanho', 'P']]), variant(2, [['Cor', 'Preto'], ['Tamanho', 'M']])];
  const groups = optionGroups(variants);
  const selection = selectionFor(variants[1], groups);
  assert.equal(findVariant(variants, groups, selection).id, gid(2));
  assert.equal(optionLabel(variants[1].selectedOptions), 'Cor: Preto · Tamanho: M');
  assert.equal(optionLabel([{ name: 'Title', value: 'Default Title' }]), null);
  assert.equal(optionLabel([]), null);
  assert.equal(optionLabel(undefined), null);
});

test('id na URL: só variante desta peça; lixo é ignorado; link leva o tamanho', () => {
  const variants = [variant(111, [['Tamanho', 'P']]), variant(222, [['Tamanho', 'M']])];
  assert.equal(numericId(gid(222)), '222');
  assert.equal(variantFromParam(variants, '222').id, gid(222));
  for (const bad of ['999', '', null, undefined, '22x', '../222', '222 OR 1', '9'.repeat(40)]) assert.equal(variantFromParam(variants, bad), null, String(bad));
  assert.equal(productHref('vestido-x', gid(222)), '/pecas/vestido-x?v=222');
  assert.equal(productHref('vestido-x', null), '/pecas/vestido-x');
});

test('preço sem escolha: igual se todas iguais, senão "a partir de" o menor; zero é preço válido; nunca a primeira variante', () => {
  assert.deepEqual(plain(priceSummary([{ price: price('120.0') }, { price: price('120.0') }])), { kind: 'single', amount: '120.0', currencyCode: 'BRL' });
  assert.deepEqual(plain(priceSummary([{ price: price('300.0') }, { price: price('150.0') }, { price: price('220.0') }])), { kind: 'from', amount: '150.0', currencyCode: 'BRL' });
  assert.deepEqual(plain(priceSummary([{ price: price('80.0') }, { price: price('0.0') }])), { kind: 'from', amount: '0.0', currencyCode: 'BRL' });
  assert.deepEqual(plain(priceSummary([{ price: price('0.0') }, { price: price('0.0') }])), { kind: 'single', amount: '0.0', currencyCode: 'BRL' });
  assert.equal(priceSummary([]), null);
  assert.equal(priceSummary([{ price: null }, { price: price('abc') }]), null);
});

test('sem selectedOptions (dado antigo) e várias variantes: escolhe pelo título, sem adivinhar', () => {
  const legacy = [
    { id: gid(1), title: 'A', availableForSale: true },
    { id: gid(2), title: 'B', availableForSale: true },
  ];
  const groups = optionGroups(legacy);
  assert.equal(groups.length, 1);
  assert.deepEqual(plain(groups[0].values.map((v) => v.label)), ['A', 'B']);
  assert.equal(findVariant(legacy, groups, {}), null);
  assert.equal(findVariant(legacy, groups, { [groups[0].key]: groups[0].values[1].key }).id, gid(2));
});

test('nenhuma lista fixa de tamanhos no código do site (P/M/G/GG...)', () => {
  const src = fileURLToPath(new URL('src/', root));
  const walk = (dir) =>
    readdirSync(dir).flatMap((name) => {
      const file = path.join(dir, name);
      return statSync(file).isDirectory() ? walk(file) : /\.(ts|tsx)$/.test(name) ? [file] : [];
    });
  const sizeLiteral = /['"`](?:PP|P|M|G|GG|XG|XGG|EG|EGG|XS|S|L|XL|XXL)['"`]/;
  const offenders = walk(src).filter((file) => sizeLiteral.test(readFileSync(file, 'utf8')));
  assert.deepEqual(offenders.map((f) => path.relative(src, f)), []);
});
