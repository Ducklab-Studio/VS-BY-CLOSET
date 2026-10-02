import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';

// Motivo de indisponibilidade na vitrine (o TS real, transpilado): a frase que
// o cliente vê para cada código que a API do ClosetAdmin devolve.
const root = new URL('../', import.meta.url);
const ts = createRequire(new URL('package.json', root))('typescript');
const lib = {};
runInNewContext(
  ts.transpileModule(readFileSync(new URL('src/lib/unavailable-reason.ts', root), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2021 },
  }).outputText,
  { exports: lib, Set, Object },
);
const plain = (value) => JSON.parse(JSON.stringify(value));
const { unavailableExplanation, rankedReasons, reasonMessage, SHOPIFY_UNAVAILABLE_MESSAGE } = lib;
const day = (fields) => ({ bookable: false, reason: 'no_units_available', ...fields });

test('reserva confirmada, HOLD, limpeza e bloqueio: a frase de cada motivo', () => {
  assert.equal(unavailableExplanation(day({ unavailableReason: 'reserved', unavailableReasons: ['reserved'] })).message, 'Esta peça já está alugada para outra reserva nesse período.');
  assert.equal(unavailableExplanation(day({ unavailableReason: 'held' })).message, 'Esta peça está temporariamente reservada. Tente outra data.');
  assert.equal(unavailableExplanation(day({ unavailableReason: 'preparation' })).message, 'Esta peça está indisponível para esta data devido ao período de preparação/limpeza.');
  assert.equal(unavailableExplanation(day({ unavailableReason: 'operational_block' })).message, 'Esta peça está indisponível para esta data devido ao período de preparação/limpeza.');
  assert.equal(SHOPIFY_UNAVAILABLE_MESSAGE, 'Esta peça está indisponível na Shopify.');
});

test('mais de um motivo: o prioritário + explicação curta (sem repetir a mesma frase)', () => {
  const both = plain(unavailableExplanation(day({ unavailableReason: 'held', unavailableReasons: ['held', 'reserved'] })));
  assert.deepEqual(both, { message: 'Esta peça já está alugada para outra reserva nesse período.', extra: 'Também há uma reserva temporária em andamento.' });
  assert.deepEqual(plain(rankedReasons(day({ unavailableReasons: ['operational_block', 'preparation', 'held'] }))), ['held', 'preparation', 'operational_block']);
  // Limpeza e bloqueio têm a mesma frase: não vira "também há" repetido.
  assert.equal(unavailableExplanation(day({ unavailableReasons: ['preparation', 'operational_block'] })).extra, null);
});

test('regras da loja (domingo, antecedência) e motivo desconhecido; data disponível não tem motivo', () => {
  assert.match(unavailableExplanation(day({ reason: 'pickup_is_sunday' })).message, /domingos/);
  assert.match(unavailableExplanation(day({ reason: 'pickup_before_minimum_advance' })).message, /antecedência/);
  assert.equal(unavailableExplanation(day({ unavailableReason: 'outra-coisa' })).message, 'Indisponível para esta data.');
  assert.equal(unavailableExplanation({ bookable: true, reason: null }), null);
  assert.equal(unavailableExplanation(undefined), null);
});

test('nunca exibe nada que não seja a frase fixa (campos extras da resposta são ignorados)', () => {
  const withExtra = day({ unavailableReason: 'reserved', customerName: 'Maria Segredo', phone: '+56 9 8765 4321' });
  const text = JSON.stringify(unavailableExplanation(withExtra));
  assert.ok(!text.includes('Maria') && !text.includes('8765'));
  assert.equal(reasonMessage('held'), 'Esta peça está temporariamente reservada. Tente outra data.');
  assert.equal(reasonMessage('<script>'), 'Indisponível para esta data.');
});
