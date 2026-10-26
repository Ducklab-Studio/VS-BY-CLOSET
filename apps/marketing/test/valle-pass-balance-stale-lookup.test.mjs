import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';

// Regressão: depois de um resgate a tela atualiza o voucher em segundo plano. Se a pessoa já consultou OUTRO código, a resposta atrasada não pode
// sobrescrever a tela (voucher errado exibido), e se ela só começou a digitar, o campo de código não pode ser reescrito. Só a consulta mais recente vale.
const source = readFileSync(new URL('../src/app/closetadmin/(protected)/valle-pass/BalanceDesk.tsx', import.meta.url), 'utf8');
const consult = source.slice(source.indexOf('async function consult('), source.indexOf('// Aberto a partir da lista de vouchers'));

test('a consulta de saldo descarta respostas de consultas anteriores', () => {
  assert.match(source, /const lookupSeq = useRef\(0\)/);
  assert.match(consult, /const seq = \+\+lookupSeq\.current/);
  const awaitAt = consult.indexOf('await lookupValePassBalanceAction');
  const guardAt = consult.indexOf('if (seq !== lookupSeq.current) return;');
  const firstSetViewAt = consult.indexOf('setView(');
  assert.ok(awaitAt > 0 && guardAt > awaitAt, 'a guarda vem logo depois da resposta');
  assert.ok(firstSetViewAt > guardAt, 'nenhum setView (nem erro) antes da guarda');
  assert.ok(consult.indexOf('setLookupError(error?.message') > guardAt, 'erro de consulta antiga também é descartado');
});

test('o resgate e a reversão continuam atualizando o voucher pela mesma função (a guarda vale para todos)', () => {
  assert.ok((source.match(/void consult\(/g) ?? []).length >= 2);
});

test('a atualização em segundo plano não reescreve o campo de código que a pessoa está digitando', () => {
  assert.match(consult, /if \(!options\.keepForms\) setCodeInput\(data\.code\)/);
  assert.doesNotMatch(consult, /^\s*setCodeInput\(data\.code\);/m);
});
