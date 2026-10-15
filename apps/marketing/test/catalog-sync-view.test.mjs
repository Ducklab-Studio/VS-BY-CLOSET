import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';

// Apresentação do painel "Sincronização com a Shopify": lógica pura (sem tocar na reconciliação).
const root = new URL('../', import.meta.url);
const ts = createRequire(new URL('package.json', root))('typescript');
const lib = {};
runInNewContext(
  ts.transpileModule(readFileSync(new URL('src/lib/catalog-sync-view.ts', root), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2021 },
  }).outputText,
  { exports: lib, Number, Date, Array, String, Object },
);
const {
  describeLastSyncOrigin, appliedChanges, pendingChanges, summarizeSync, awaitingPhysicalInventory, awaitingLabel,
  classifySyncFailure, looksCompletedAfterUncertain, UNCERTAIN_MESSAGE,
} = lib;
const plain = (v) => JSON.parse(JSON.stringify(v));

const report = (over = {}) => ({
  generatedAt: '2026-10-15T17:00:00.000Z', lastSyncedAt: '2026-10-15T17:00:00.000Z', lastSyncedByName: null,
  totalShopifyVariants: 6, totalRentalUnitsLinked: 4, divergences: [], ...over,
});
const item = (id, title, status, units, productTitle = 'Jaqueta') => ({ id: `gid://shopify/ProductVariant/${id}`, title, product: { id: `gid://shopify/Product/${id}`, title: productTitle, status }, physicalUnitsTotal: units });

test('1) origem da última sincronização: nunca / manual (com nome) / automática (sem nome)', () => {
  assert.deepEqual(plain(describeLastSyncOrigin({ lastSyncedAt: null, lastSyncedByName: null })), { origin: 'never', label: 'nunca sincronizado' });
  assert.deepEqual(plain(describeLastSyncOrigin({ lastSyncedAt: '2026-10-15T17:00:00Z', lastSyncedByName: 'Anderson' })), { origin: 'manual', label: 'manual, por Anderson' });
  const auto = describeLastSyncOrigin({ lastSyncedAt: '2026-10-15T17:00:00Z', lastSyncedByName: null });
  assert.equal(auto.origin, 'automatic');
  assert.match(auto.label, /automática/);
  // nome só com espaços não é "manual"
  assert.equal(describeLastSyncOrigin({ lastSyncedAt: '2026-10-15T17:00:00Z', lastSyncedByName: '   ' }).origin, 'automatic');
});

test('2) mensagem de sucesso: horário, variantes verificadas e peças atualizadas (singular, plural e zero)', () => {
  const none = summarizeSync(report(), '14:02:11');
  assert.equal(none.text, 'Sincronização concluída às 14:02:11: 6 variantes verificadas, nenhuma peça precisou de atualização.');
  assert.deepEqual([none.variantsChecked, none.updatedUnits, none.pendingUnits], [6, 0, 0]);

  const one = summarizeSync(report({ totalShopifyVariants: 1, divergences: [{ applied: true }] }), '14:02:11');
  assert.equal(one.text, 'Sincronização concluída às 14:02:11: 1 variante verificada, 1 peça atualizada.');

  const many = summarizeSync(report({ divergences: [{ applied: true }, { applied: true }, { applied: false }] }), '09:00:00');
  assert.match(many.text, /2 peças atualizadas; 1 item\(ns\) ainda pedem atenção\.$/);
  assert.deepEqual([appliedChanges(report({ divergences: [{ applied: true }, { applied: false }] })), pendingChanges(report({ divergences: [{ applied: true }, { applied: false }] }))], [1, 1]);
});

test('3) variantes sem inventário físico: só produto ATIVO, sem peça, fora o Valle Pass; rascunho/arquivado e variantes com peça não contam', () => {
  const never = () => false;
  const items = [
    item(1, 'Default Title', 'ACTIVE', 0, 'Jaqueta Nova'),   // conta
    item(2, 'M', 'ACTIVE', 0, 'Sobretudo'),                   // conta
    item(3, 'Default Title', 'ACTIVE', 2, 'Blazer'),          // tem peça: não conta
    item(4, 'Default Title', 'DRAFT', 0, 'Rascunho'),         // rascunho: não conta
    item(5, 'Default Title', 'ARCHIVED', 0, 'Antigo'),        // arquivado: não conta
    item(6, 'Default Title', 'active', 0, 'Minúsculo'),       // status em minúsculas conta como ativo
    item(7, 'Default Title', 'ACTIVE', 0, 'Valle Pass'),      // compra direta: nunca precisa de peça
  ];
  const result = awaitingPhysicalInventory(items, (i) => i.product.title === 'Valle Pass');
  assert.deepEqual(plain(result.map((i) => i.product.title)), ['Jaqueta Nova', 'Sobretudo', 'Minúsculo']);
  assert.deepEqual(awaitingPhysicalInventory(items, never).length, 4, 'sem a regra de compra direta o Valle Pass entraria');
  // estoque da Shopify não entra na conta: o item não tem esse campo e o resultado não depende dele
  assert.deepEqual(plain(awaitingPhysicalInventory(null, never)), []);
  assert.deepEqual(plain(awaitingPhysicalInventory(undefined, never)), []);
  assert.deepEqual(plain(awaitingPhysicalInventory([], never)), []);
});

test('4) rótulo da variante: "Produto — variante"; a variante padrão da Shopify não vira texto', () => {
  assert.equal(awaitingLabel(item(1, 'Default Title', 'ACTIVE', 0, 'Jaqueta Nova')), 'Jaqueta Nova');
  assert.equal(awaitingLabel(item(2, 'M', 'ACTIVE', 0, 'Sobretudo')), 'Sobretudo — M');
  assert.equal(awaitingLabel(item(3, '', 'ACTIVE', 0, 'Blazer')), 'Blazer');
});

test('5) falha: resposta de erro é erro; sem resposta/timeout é "incerto" (pode ter concluído) — nunca falha definitiva', () => {
  assert.equal(classifySyncFailure({ error: 'A Shopify não retornou nenhuma variante.', timedOut: false }), 'error');
  assert.equal(classifySyncFailure({ error: 'x' }), 'error');
  assert.equal(classifySyncFailure({ error: 'demorou', timedOut: true }), 'uncertain');
  assert.match(UNCERTAIN_MESSAGE, /pode ter sido concluída no servidor/);
});

test('6) depois do timeout: "parece concluída" só com data NOVA, de uma pessoa e recente; rodada automática ou data antiga não contam', () => {
  const started = Date.parse('2026-10-15T17:00:00Z');
  const before = { lastSyncedAt: '2026-10-15T16:00:00Z' };
  // concluída: data nova, com nome, depois do clique
  assert.equal(looksCompletedAfterUncertain(before, { lastSyncedAt: '2026-10-15T17:00:05Z', lastSyncedByName: 'Anderson' }, started), true);
  // data igual à de antes: nada mudou
  assert.equal(looksCompletedAfterUncertain(before, { lastSyncedAt: '2026-10-15T16:00:00Z', lastSyncedByName: 'Anderson' }, started), false);
  // rodada automática (sem nome) no mesmo intervalo não prova o clique
  assert.equal(looksCompletedAfterUncertain(before, { lastSyncedAt: '2026-10-15T17:00:05Z', lastSyncedByName: null }, started), false);
  // nova, com nome, mas muito antes do clique (fora da tolerância de relógio de 2 min)
  assert.equal(looksCompletedAfterUncertain(null, { lastSyncedAt: '2026-10-15T16:50:00Z', lastSyncedByName: 'Anderson' }, started), false);
  // dentro da tolerância de relógio
  assert.equal(looksCompletedAfterUncertain(null, { lastSyncedAt: '2026-10-15T16:59:00Z', lastSyncedByName: 'Anderson' }, started), true);
  // sem data / data inválida
  assert.equal(looksCompletedAfterUncertain(before, { lastSyncedAt: null, lastSyncedByName: 'A' }, started), false);
  assert.equal(looksCompletedAfterUncertain(before, { lastSyncedAt: 'lixo', lastSyncedByName: 'A' }, started), false);
});

test('7) o arquivo é puro: sem imports e sem conhecer handles, SKUs ou ids de produtos', () => {
  const src = readFileSync(new URL('src/lib/catalog-sync-view.ts', root), 'utf8');
  assert.equal(/^\s*import\s/m.test(src), false);
  for (const forbidden of ['blazer', 'saint-tropez', 'firenze', 'gid://shopify']) assert.equal(src.toLowerCase().includes(forbidden), false, forbidden);
});
