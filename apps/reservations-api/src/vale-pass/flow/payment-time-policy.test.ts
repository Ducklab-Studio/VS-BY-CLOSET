import { describe, expect, test } from 'vitest';
import { DEFAULT_TOLERANCE_SECONDS, decidePaymentTime, paymentTimeConfigFromEnv, type PaymentTimeConfig } from './payment-time-policy';

const T0 = new Date('2026-10-18T12:00:00.000Z').getTime();
const at = (seconds: number) => new Date(T0 + seconds * 1000);
const strict: PaymentTimeConfig = { mode: 'strict', toleranceSeconds: 120 };
const agreement: PaymentTimeConfig = { mode: 'webhook-agreement', toleranceSeconds: 120 };
const web = (triggered: number | null, updated: number | null) => ({ triggered: triggered === null ? null : at(triggered), updated: updated === null ? null : at(updated) });

describe('paymentTimeConfigFromEnv — padrão ESTRITO; tolerância validada', () => {
  test('sem variável: estrita e 120 s; só o valor exato "webhook-agreement" relaxa; tolerância fora de 1–900 volta ao padrão', () => {
    expect(paymentTimeConfigFromEnv({})).toEqual({ mode: 'strict', toleranceSeconds: DEFAULT_TOLERANCE_SECONDS });
    expect(paymentTimeConfigFromEnv({ VALE_PASS_PAYMENT_TIME_POLICY: 'on' }).mode).toBe('strict');
    expect(paymentTimeConfigFromEnv({ VALE_PASS_PAYMENT_TIME_POLICY: ' Webhook-Agreement ' }).mode).toBe('webhook-agreement');
    for (const bad of ['0', '-5', '901', '1.5', 'abc', '']) expect(paymentTimeConfigFromEnv({ VALE_PASS_PAYMENT_TIME_TOLERANCE_SECONDS: bad }).toleranceSeconds).toBe(DEFAULT_TOLERANCE_SECONDS);
    expect(paymentTimeConfigFromEnv({ VALE_PASS_PAYMENT_TIME_TOLERANCE_SECONDS: '30' }).toleranceSeconds).toBe(30);
    expect(paymentTimeConfigFromEnv({ VALE_PASS_PAYMENT_TIME_TOLERANCE_SECONDS: '900' }).toleranceSeconds).toBe(900);
  });
});

describe('decidePaymentTime — política estrita (padrão): o webhook sozinho NUNCA confirma', () => {
  test('sinais perfeitos do webhook, sem transação → continua desconhecido (WEBHOOK_UNCONFIRMED_STRICT)', () => {
    expect(decidePaymentTime({ config: strict, webhook: web(0, 2), transaction: null })).toEqual({ trusted: null, source: null, reason: 'WEBHOOK_UNCONFIRMED_STRICT' });
  });
  test('nada de sinal → NO_SIGNAL', () => {
    expect(decidePaymentTime({ config: strict, webhook: null, transaction: null }).reason).toBe('NO_SIGNAL');
    expect(decidePaymentTime({ config: strict, webhook: web(null, null), transaction: null }).reason).toBe('NO_SIGNAL');
  });
  test('transação da Admin API concordando com o cabeçalho (≤ tolerância) → vale o horário da TRANSAÇÃO', () => {
    expect(decidePaymentTime({ config: strict, webhook: web(0, 1), transaction: { instant: at(-45), reason: 'OK' } })).toEqual({ trusted: at(-45), source: 'ADMIN_API_TRANSACTION', reason: 'OK' });
  });
  test('transação sem nenhum sinal de webhook (reconciliação) → vale a transação (fonte autoritativa)', () => {
    expect(decidePaymentTime({ config: strict, webhook: null, transaction: { instant: at(-3600), reason: 'OK' } })).toMatchObject({ trusted: at(-3600), source: 'ADMIN_API_TRANSACTION' });
  });
  test('transação DIVERGE do cabeçalho além da tolerância (ex.: processedAt = criação do Pix pendente) → desconhecido, o ADMIN decide', () => {
    expect(decidePaymentTime({ config: strict, webhook: web(0, 0), transaction: { instant: at(-9 * 3600), reason: 'OK' } })).toEqual({ trusted: null, source: null, reason: 'TRANSACTION_DIVERGENT' });
  });
  test('reentrega tardia: o cabeçalho é do novo disparo (+3 h) mas o updated_at original BATE com a transação → a transação vale (duas fontes independentes concordam)', () => {
    expect(decidePaymentTime({ config: strict, webhook: web(3 * 3600, 2), transaction: { instant: at(0), reason: 'OK' } })).toMatchObject({ trusted: at(0), source: 'ADMIN_API_TRANSACTION' });
    expect(decidePaymentTime({ config: strict, webhook: web(3 * 3600, 4000), transaction: { instant: at(0), reason: 'OK' } }).reason).toBe('TRANSACTION_DIVERGENT'); // nenhum sinal concorda
    expect(decidePaymentTime({ config: strict, webhook: web(null, 5), transaction: { instant: at(0), reason: 'OK' } }).trusted).toEqual(at(0)); // só updated_at, concorda
    expect(decidePaymentTime({ config: strict, webhook: web(null, 4000), transaction: { instant: at(0), reason: 'OK' } }).reason).toBe('TRANSACTION_DIVERGENT');
  });
  test('transação que não consegue afirmar o horário (sem sucesso, parcial, só teste…) → TRANSACTION_UNAVAILABLE', () => {
    expect(decidePaymentTime({ config: strict, webhook: web(0, 0), transaction: { instant: null, reason: 'PARTIAL_PAYMENT' } })).toEqual({ trusted: null, source: null, reason: 'TRANSACTION_UNAVAILABLE' });
  });
});

describe('decidePaymentTime — webhook-agreement: os DOIS sinais precisam concordar dentro da tolerância (limites testados)', () => {
  test.each([
    [0, 0, true],
    [0, 3, true], // o que foi observado nos dois orders/paid reais
    [0, 119, true],
    [0, 120, true], // fronteira inclusiva
    [0, 121, false],
    [121, 0, false], // simétrico
    [0, 3600, false], // reentrega 1 h depois
    [0, 180 * 60, false], // reentrega 3 h depois
  ])('cabeçalho +%is e updated_at +%is → confia: %s', (triggered, updated, ok) => {
    const decision = decidePaymentTime({ config: agreement, webhook: web(triggered, updated), transaction: null });
    if (ok) expect(decision).toMatchObject({ trusted: at(Math.min(triggered, updated)), source: 'WEBHOOK_AGREEMENT', reason: 'OK' });
    else expect(decision).toEqual({ trusted: null, source: null, reason: 'WEBHOOK_DISAGREE' });
  });
  test('falta um dos sinais → WEBHOOK_INCOMPLETE (não adivinha com um só)', () => {
    expect(decidePaymentTime({ config: agreement, webhook: web(0, null), transaction: null }).reason).toBe('WEBHOOK_INCOMPLETE');
    expect(decidePaymentTime({ config: agreement, webhook: web(null, 0), transaction: null }).reason).toBe('WEBHOOK_INCOMPLETE');
  });
  test('a tolerância configurada vale (30 s): 31 s de diferença já diverge', () => {
    const tight: PaymentTimeConfig = { mode: 'webhook-agreement', toleranceSeconds: 30 };
    expect(decidePaymentTime({ config: tight, webhook: web(0, 30), transaction: null }).trusted).not.toBeNull();
    expect(decidePaymentTime({ config: tight, webhook: web(0, 31), transaction: null }).trusted).toBeNull();
  });
  test('a transação, quando existe, manda mesmo no modo webhook-agreement (e diverge da mesma forma)', () => {
    expect(decidePaymentTime({ config: agreement, webhook: web(0, 0), transaction: { instant: at(5), reason: 'OK' } })).toMatchObject({ source: 'ADMIN_API_TRANSACTION' });
    expect(decidePaymentTime({ config: agreement, webhook: web(0, 0), transaction: { instant: at(500), reason: 'OK' } }).reason).toBe('TRANSACTION_DIVERGENT');
  });
});
