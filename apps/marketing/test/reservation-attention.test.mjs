import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';

// Contador de novas reservas (o TS real, transpilado): textos do menu e quais
// reservas exibidas a tela manda marcar como vistas.
const root = new URL('../', import.meta.url);
const ts = createRequire(new URL('package.json', root))('typescript');
const lib = {};
runInNewContext(
  ts.transpileModule(readFileSync(new URL('src/lib/reservation-attention.ts', root), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2021 },
  }).outputText,
  { exports: lib },
);
const plain = (value) => JSON.parse(JSON.stringify(value));
const { reservationAttentionLabel, rowsToMarkViewed, viewKey, RESERVATION_ATTENTION_EVENT, RESERVATION_ATTENTION_CHANNEL, RESERVATIONS_REFRESH_MS } = lib;

test('texto acessível do item "Reservas" no menu', () => {
  assert.equal(reservationAttentionLabel(null), 'nenhuma reserva nova');
  assert.equal(reservationAttentionLabel(0), 'nenhuma reserva nova');
  assert.equal(reservationAttentionLabel(1), '1 reserva nova');
  assert.equal(reservationAttentionLabel(7), '7 reservas novas');
  assert.equal(reservationAttentionLabel(150), 'mais de 99 reservas novas');
});

test('canais próprios (não se misturam com o Valle Pass) e atualização a cada 30 s', () => {
  assert.equal(RESERVATION_ATTENTION_EVENT, 'closetadmin:reservation-attention');
  assert.equal(RESERVATION_ATTENTION_CHANNEL, 'closetadmin-reservation-attention');
  assert.notEqual(RESERVATION_ATTENTION_EVENT, 'closetadmin:valle-pass-attention');
  assert.equal(RESERVATIONS_REFRESH_MS, 30_000);
});

test('marca como vista só reserva nova exibida, pendente ou confirmada, uma vez por reserva+status', () => {
  const rows = [
    { id: 'a', status: 'pending_payment', needsAttention: true },
    { id: 'b', status: 'confirmed', needsAttention: true },
    { id: 'c', status: 'confirmed', needsAttention: false }, // já vista
    { id: 'd', status: 'expired', needsAttention: true }, // nunca alerta (defesa: o servidor já não marcaria)
    { id: 'e', status: 'cancelled', needsAttention: false },
  ];
  assert.deepEqual(plain(rowsToMarkViewed(rows, new Set())), [{ id: 'a', status: 'pending_payment' }, { id: 'b', status: 'confirmed' }]);
  // Já mandada nesta página: não manda de novo (duas atualizações da lista não duplicam).
  assert.deepEqual(plain(rowsToMarkViewed(rows, new Set([viewKey(rows[0]), viewKey(rows[1])]))), []);
  // Mudou de status depois (pendente → confirmada): é outra chave, manda de novo.
  assert.deepEqual(plain(rowsToMarkViewed([{ id: 'a', status: 'confirmed', needsAttention: true }], new Set([viewKey(rows[0])]))), [{ id: 'a', status: 'confirmed' }]);
});
