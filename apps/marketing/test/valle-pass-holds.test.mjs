import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';

// Tempo decorrido e orientação das retenções do Valle Pass (o TS real, transpilado). Sem rede e sem banco.
const root = new URL('../', import.meta.url);
const ts = createRequire(new URL('package.json', root))('typescript');
const exports = {};
runInNewContext(
  ts.transpileModule(readFileSync(new URL('src/lib/valle-pass-holds.ts', root), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2021 },
  }).outputText,
  { exports, Number, Math, Date, String },
);
const { formatElapsed, holdElapsed, holdGuidance, urgencyOf, HOLD_STALE_HOURS, HOLD_NEAR_DEADLINE_HOURS, HOLD_DEADLINE_HOURS } = exports;

const H = 3_600_000;
const NOW = Date.parse('2026-10-26T12:00:00.000Z');
const ago = (ms) => new Date(NOW - ms).toISOString();

test('os limites repetem os da API (24 h parada, 48 h perto do prazo, 72 h = 3 dias do pagamento)', () => {
  assert.equal(HOLD_STALE_HOURS, 24);
  assert.equal(HOLD_NEAR_DEADLINE_HOURS, 48);
  assert.equal(HOLD_DEADLINE_HOURS, 72);
  const api = readFileSync(new URL('../reservations-api/src/vale-pass/vale-pass-lots.service.ts', root), 'utf8');
  assert.match(api, /STALE_HOLD_HOURS = 24/);
  assert.match(api, /HOLD_DEADLINE_HOURS = 72/);
  assert.match(api, /HOLD_NEAR_DEADLINE_HOURS = 48/);
});

test('formata o tempo decorrido em minutos, horas e dias', () => {
  assert.equal(formatElapsed(0), 'há 0 min');
  assert.equal(formatElapsed(25 * 60_000), 'há 25 min');
  assert.equal(formatElapsed(3 * H + 20 * 60_000), 'há 3 h 20 min');
  assert.equal(formatElapsed(5 * H), 'há 5 h');
  assert.equal(formatElapsed(50 * H), 'há 2 dias 2 h');
  assert.equal(formatElapsed(72 * H), 'há 3 dias');
  assert.equal(formatElapsed(-5 * H), 'há 0 min'); // relógio adiantado nunca mostra tempo negativo
});

test('urgência por faixa: normal, atenção (24 h), crítica (48 h) e prazo vencido (72 h)', () => {
  assert.equal(urgencyOf(0), 'NORMAL');
  assert.equal(urgencyOf(23.9), 'NORMAL');
  assert.equal(urgencyOf(24), 'ATTENTION');
  assert.equal(urgencyOf(48), 'CRITICAL');
  assert.equal(urgencyOf(72), 'OVERDUE');
});

test('o relógio conta do PAGAMENTO quando ele é conhecido (prazo de 3 dias) e só então da retenção', () => {
  const paid = holdElapsed({ createdAt: ago(1 * H), paymentConfirmedAt: ago(50 * H) }, NOW);
  assert.equal(paid.basis, 'PAYMENT');
  assert.equal(paid.urgency, 'CRITICAL');
  assert.match(paid.text, /desde o pagamento/);
  assert.match(paid.text, /Falar diretamente com o cliente/);
  const unknown = holdElapsed({ createdAt: ago(2 * H), paymentConfirmedAt: null }, NOW);
  assert.equal(unknown.basis, 'RETENTION');
  assert.equal(unknown.urgency, 'NORMAL');
  assert.match(unknown.text, /instante do pagamento desconhecido/);
  assert.match(unknown.text, /prazo de 3 dias não é calculável/);
});

test('prazo vencido tem a maior prioridade e o texto não promete reembolso nem decide nada', () => {
  const overdue = holdElapsed({ createdAt: ago(80 * H), paymentConfirmedAt: ago(75 * H) }, NOW);
  assert.equal(overdue.urgency, 'OVERDUE');
  assert.match(overdue.text, /VENCEU/);
  assert.doesNotMatch(overdue.text, /reembols/i);
});

test('datas ausentes ou inválidas nunca inventam um tempo', () => {
  assert.equal(holdElapsed({ createdAt: 'lixo', paymentConfirmedAt: null }, NOW), null);
  assert.equal(holdElapsed({ createdAt: ago(H), paymentConfirmedAt: 'lixo' }, NOW).basis, 'RETENTION'); // pagamento inválido cai para a retenção
  assert.equal(holdElapsed({ createdAt: ago(H) }, Number.NaN), null);
});

test('orientação por motivo: validade, capacidade e inconsistência financeira, sem regra comercial nem reembolso automático', () => {
  const validity = holdGuidance('CAMPAIGN_NOT_READY');
  const capacity = holdGuidance('CAPACITY_EXCEEDED');
  const financial = holdGuidance('FINANCIAL_MISMATCH', ['TOTAL_MISMATCH']);
  assert.match(validity, /validade \(início e fim\)/);
  assert.match(validity, /sem reembolso automático/);
  assert.match(capacity, /nunca emite acima do teto/);
  assert.match(capacity, /decisão é humana e comercial/);
  assert.match(financial, /Conferir o pedido na Shopify/);
  assert.match(financial, /o sistema nunca reembolsa/);
  for (const text of [validity, capacity, financial]) assert.doesNotMatch(text, /sete dias|7 dias|arrependimento|reembolso integral|reembolso parcial/i);
  assert.notEqual(validity, capacity);
  assert.notEqual(capacity, financial);
});

test('orientação acrescenta só fatos da retenção: integração desligada, horário desconhecido e pedido de teste', () => {
  assert.match(holdGuidance('FINANCIAL_MISMATCH', ['INTEGRATION_DISABLED']), /integração dos dois vouchers desligada/);
  assert.match(holdGuidance('FINANCIAL_MISMATCH', ['PAYMENT_TIME_UNKNOWN']), /Conferir na Shopify/);
  assert.match(holdGuidance('FINANCIAL_MISMATCH', ['TEST_ORDER']), /pedido de teste/);
  assert.doesNotMatch(holdGuidance('CAPACITY_EXCEEDED', []), /integração|horário|teste/);
});

test('a tela das retenções usa o helper e mostra o tempo e a orientação sem remover o que já existia', () => {
  const src = readFileSync(new URL('src/app/closetadmin/(protected)/valle-pass/HoldsAndBenefits.tsx', root), 'utf8');
  assert.match(src, /from '@\/lib\/valle-pass-holds'/);
  assert.match(src, /data-testid="hold-elapsed"/);
  assert.match(src, /data-testid="hold-guidance"/);
  assert.match(src, /Divergências: /); // continua mostrando as divergências financeiras
  assert.match(src, /Resolver/); // e o botão de resolução humana
});
