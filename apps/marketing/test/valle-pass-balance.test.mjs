import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';

// Helpers puros do saldo/resgate do Valle Pass (o TS real, transpilado).
const root = new URL('../', import.meta.url);
const ts = createRequire(new URL('package.json', root))('typescript');
const exports = {};
runInNewContext(
  ts.transpileModule(readFileSync(new URL('src/lib/valle-pass-balance.ts', root), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2021 },
  }).outputText,
  { exports, Number, Math, String, Intl, RegExp },
);
const { parseReaisToCents, formatCents, describeBalanceError, usedPercent, BALANCE_ERROR_TEXT, MAX_OPERATION_CENTS } = exports;

test('reais digitados viram centavos INTEIROS, só no formato pt-BR', () => {
  assert.equal(parseReaisToCents('200'), 20000);
  assert.equal(parseReaisToCents('200,5'), 20050);
  assert.equal(parseReaisToCents('200,50'), 20050);
  assert.equal(parseReaisToCents('0,01'), 1);
  assert.equal(parseReaisToCents('1.234,56'), 123456);
  assert.equal(parseReaisToCents('1.000'), 100000);
  assert.equal(parseReaisToCents('R$ 50,00'), 5000);
  assert.equal(parseReaisToCents('  500  '), 50000);
  assert.equal(parseReaisToCents('1000000'), MAX_OPERATION_CENTS); // teto da API (R$ 1.000.000,00)
});

test('entradas que NÃO viram dinheiro: vazio, zero, negativo, letras, 3 casas, ponto decimal ambíguo, notação científica, acima do teto', () => {
  for (const bad of ['', ' ', '0', '0,00', '-10', '10-', 'abc', '10,555', '200.50', '1e3', '1,2,3', ',50', '10,', '1.23', '1000000,01', '9999999999', 'R$', '12 34']) {
    assert.equal(parseReaisToCents(bad), null, `"${bad}" deveria ser recusado`);
  }
});

test('sem erro de ponto flutuante: 0,10 + 0,20 e valores típicos de centavos', () => {
  assert.equal(parseReaisToCents('0,10') + parseReaisToCents('0,20'), 30);
  assert.equal(parseReaisToCents('19,99'), 1999);
  assert.equal(parseReaisToCents('349,99') + 1, 35000);
});

test('formatação BRL e porcentagem de uso', () => {
  assert.equal(formatCents(50000), 'R$ 500,00');
  assert.equal(formatCents(5000), 'R$ 50,00');
  assert.equal(formatCents(123456), 'R$ 1.234,56');
  assert.equal(formatCents(0), 'R$ 0,00');
  assert.equal(usedPercent(50000, 30000), 40);
  assert.equal(usedPercent(50000, 50000), 0);
  assert.equal(usedPercent(50000, 0), 100);
  assert.equal(usedPercent(0, 0), 0);
  assert.equal(usedPercent(5000, 6000), 0); // nunca negativo
});

test('erros da API: código conhecido vira texto claro; desconhecido usa a mensagem; todos os códigos de recusa têm texto', () => {
  assert.match(describeBalanceError('INSUFFICIENT_BALANCE', 'x'), /Saldo insuficiente/);
  assert.equal(describeBalanceError('CODIGO_NOVO', 'Mensagem da API'), 'Mensagem da API');
  assert.equal(describeBalanceError(null, 'Mensagem da API'), 'Mensagem da API');
  for (const code of ['COMPANY_MISMATCH', 'BALANCE_CHANGED', 'IDEMPOTENCY_CONFLICT', 'ALREADY_REVERSED', 'REFUND_UNDER_REVIEW', 'BLOCKED', 'EXPIRED', 'CANCELLED', 'USED_UP', 'ORDER_CANCELLED', 'NOT_YET_VALID', 'LEGACY_NO_BALANCE', 'ALREADY_BLOCKED', 'NOT_BLOCKED']) {
    assert.ok(BALANCE_ERROR_TEXT[code], code);
  }
});
