import { describe, expect, test } from 'vitest';
import { decideAutoVerification, nextAttemptAt, TERMINAL_RETRY_MINUTES, type AutoVerifyInput } from './auto-verify-decision';
import type { ShopifyTransaction } from './payment-transactions';
import { STRICT_PAYMENT_TIME_CONFIG } from './payment-time-policy';

const GID = 'gid://shopify/Order/1';
const NOW = new Date('2026-10-18T15:00:00Z');
const PAID = '2026-10-18T12:00:00Z';
const tx = (over: Partial<ShopifyTransaction> = {}): ShopifyTransaction => ({ id: 'gid://shopify/OrderTransaction/' + Math.random(), kind: 'SALE', status: 'SUCCESS', test: false, processedAt: PAID, amount: '350.00', currency: 'BRL', gateway: 'gateway_pix', ...over });
const input = (over: Partial<AutoVerifyInput> = {}, transactions: ShopifyTransaction[] = [tx()], total = '350.00'): AutoVerifyInput => ({
  fetched: { orderGid: GID, totalAmount: total, currency: 'BRL', transactions },
  expectedOrderGid: GID,
  unitPriceCents: 35_000,
  quantity: 1,
  webhook: { triggered: new Date(PAID), updated: new Date(PAID) },
  orderCreatedAt: new Date('2026-10-18T11:55:00Z'),
  config: STRICT_PAYMENT_TIME_CONFIG,
  now: NOW,
  ...over,
});
const reason = (value: ReturnType<typeof decideAutoVerification>) => (value.confirm ? 'OK' : value.reason);

describe('decideAutoVerification — só confirma com TODAS as provas; qualquer dúvida mantém a retenção', () => {
  test('Pix/cartão aprovado e coerente → confirma com o processedAt da transação', () => {
    const decision = decideAutoVerification(input());
    expect(decision).toMatchObject({ confirm: true, instant: new Date(PAID), used: 1 });
  });
  test('quantidade 3 × R$ 350 = R$ 1.050,00 pagos em uma venda → confirma', () => {
    expect(reason(decideAutoVerification(input({ quantity: 3 }, [tx({ amount: '1050.00' })], '1050.00')))).toBe('OK');
  });
  test('Pix pendente (ainda não pago) → retém e tenta de novo em breve (retryable)', () => {
    const decision = decideAutoVerification(input({}, [tx({ status: 'PENDING' })]));
    expect(decision).toMatchObject({ confirm: false, reason: 'NO_SUCCESS_TRANSACTION', retryable: true });
  });
  test('Pix divergente: processedAt muito anterior aos sinais do webhook → TRANSACTION_DIVERGENT (ADMIN decide)', () => {
    const decision = decideAutoVerification(input({}, [tx({ processedAt: '2026-10-18T03:00:00Z' })]));
    expect(decision).toMatchObject({ confirm: false, reason: 'TRANSACTION_DIVERGENT', retryable: false });
  });
  test('cartão só autorizado → não é pagamento; capturado → é', () => {
    expect(reason(decideAutoVerification(input({}, [tx({ kind: 'AUTHORIZATION' })])))).toBe('NO_SUCCESS_TRANSACTION');
    expect(reason(decideAutoVerification(input({}, [tx({ kind: 'AUTHORIZATION', processedAt: '2026-10-17T10:00:00Z' }), tx({ kind: 'CAPTURE' })])))).toBe('OK');
  });
  test.each(['FAILURE', 'ERROR', 'AWAITING_RESPONSE'])('cartão recusado (%s) → nunca confirma', (status) => {
    expect(decideAutoVerification(input({}, [tx({ status })])).confirm).toBe(false);
  });
  test('cartão estornado (SALE + REFUND com sucesso) → REFUND_TRANSACTION_PRESENT, não confirma', () => {
    expect(reason(decideAutoVerification(input({}, [tx(), tx({ kind: 'REFUND', amount: '350.00' })])))).toBe('REFUND_TRANSACTION_PRESENT');
  });
  test('pagamento manual / teste nunca é prova comercial', () => {
    expect(reason(decideAutoVerification(input({}, [tx({ gateway: 'manual' })])))).toBe('MANUAL_TRANSACTION');
    expect(reason(decideAutoVerification(input({}, [tx({ gateway: 'bogus' })])))).toBe('MANUAL_TRANSACTION');
    expect(reason(decideAutoVerification(input({}, [tx({ test: true })])))).toBe('ONLY_TEST_TRANSACTIONS');
    expect(reason(decideAutoVerification(input({}, [tx(), tx({ test: true, amount: '10.00' })])))).toBe('MIXED_TEST_TRANSACTION');
  });
  test('transações de OUTRO pedido (GID diferente ou ausente) → ORDER_MISMATCH', () => {
    expect(reason(decideAutoVerification(input({ fetched: { orderGid: 'gid://shopify/Order/2', totalAmount: '350.00', currency: 'BRL', transactions: [tx()] } })))).toBe('ORDER_MISMATCH');
    expect(reason(decideAutoVerification(input({ fetched: { totalAmount: '350.00', currency: 'BRL', transactions: [tx()] } })))).toBe('ORDER_MISMATCH');
  });
  test('moeda ≠ BRL, valor ≠ preço × quantidade (desconto, frete, quantidade alterada) → retém', () => {
    expect(reason(decideAutoVerification(input({ fetched: { orderGid: GID, totalAmount: '350.00', currency: 'USD', transactions: [tx({ currency: 'USD' })] } })))).toBe('CURRENCY_NOT_BRL');
    expect(reason(decideAutoVerification(input({}, [tx({ amount: '300.00' })], '300.00')))).toBe('ORDER_TOTAL_MISMATCH'); // desconto
    expect(reason(decideAutoVerification(input({}, [tx({ amount: '370.00' })], '370.00')))).toBe('ORDER_TOTAL_MISMATCH'); // frete/taxa
    expect(reason(decideAutoVerification(input({ quantity: 2 })))).toBe('ORDER_TOTAL_MISMATCH'); // registro diz 2, Shopify cobrou 1
    expect(reason(decideAutoVerification(input({ quantity: 0 })))).toBe('REGISTRY_QUANTITY_INVALID');
  });
  test('pago a mais (duas vendas) ou pagamento parcial → ambíguo/parcial, não confirma', () => {
    expect(reason(decideAutoVerification(input({}, [tx(), tx({ processedAt: '2026-10-18T12:05:00Z' })])))).toBe('AMBIGUOUS_OVERPAYMENT');
    expect(decideAutoVerification(input({}, [tx({ amount: '100.00' })]))).toMatchObject({ confirm: false, reason: 'PARTIAL_PAYMENT', retryable: true });
  });
  test('sem sinal do webhook para corroborar → NO_CORROBORATION; só o updated_at já corrobora', () => {
    expect(reason(decideAutoVerification(input({ webhook: { triggered: null, updated: null } })))).toBe('NO_CORROBORATION');
    expect(reason(decideAutoVerification(input({ webhook: { triggered: null, updated: new Date(PAID) } })))).toBe('OK');
  });
  test('instante no futuro ou antes do pedido → retém', () => {
    const future = '2026-10-18T18:00:00Z';
    expect(reason(decideAutoVerification(input({ webhook: { triggered: new Date(future), updated: new Date(future) } }, [tx({ processedAt: future })])))).toBe('INSTANT_IN_FUTURE');
    expect(reason(decideAutoVerification(input({ orderCreatedAt: new Date('2026-10-18T13:00:00Z') })))).toBe('INSTANT_BEFORE_ORDER');
  });
  test('50 transações (limite da página) → ambíguo', () => {
    expect(reason(decideAutoVerification(input({}, Array.from({ length: 50 }, () => tx({ status: 'FAILURE' })))))).toBe('TOO_MANY_TRANSACTIONS');
  });
});

describe('nextAttemptAt — escada de novas tentativas', () => {
  test('retryable: 1, 2, 5, 10, 30, 60 min (teto 60); terminal: 6 h', () => {
    const minutes = [1, 2, 3, 4, 5, 6, 9].map((attempt) => (nextAttemptAt(NOW, attempt, true).getTime() - NOW.getTime()) / 60_000);
    expect(minutes).toEqual([1, 2, 5, 10, 30, 60, 60]);
    expect((nextAttemptAt(NOW, 1, false).getTime() - NOW.getTime()) / 60_000).toBe(TERMINAL_RETRY_MINUTES);
  });
});

describe('decideAutoVerification — Pix com pagamento DEMORADO (a transação traz a cobrança; o evento traz a confirmação)', () => {
  const sale = (at: string) => ({ action: 'sale_success', createdAt: at });
  const pixInput = (chargeAt: string, events: { action: string; createdAt: string }[] | null, over: Partial<AutoVerifyInput> = {}) =>
    input({ fetched: { orderGid: GID, totalAmount: '350.00', currency: 'BRL', transactions: [tx({ processedAt: chargeAt, gateway: 'Gateway Pix' })], successEvents: events }, ...over });

  test('Pix pago 4 h depois da cobrança, webhook no momento da confirmação → CONFIRMA com o instante da confirmação (antes: TRANSACTION_DIVERGENT)', () => {
    const decision = decideAutoVerification(pixInput('2026-10-18T08:00:00Z', [sale(PAID)]));
    expect(decision).toMatchObject({ confirm: true, instant: new Date(PAID), used: 1 });
  });
  test('o caso real (#1013): cobrança 120 s antes do webhook, confirmação 1 s antes → confirma com a tolerância ORIGINAL de 120 s (sem aumentá-la)', () => {
    const decision = decideAutoVerification(
      pixInput('2026-10-30T04:40:01Z', [sale('2026-10-30T04:42:00Z')], { webhook: { triggered: new Date('2026-10-30T04:42:01.058Z'), updated: new Date('2026-10-30T04:42:01Z') }, orderCreatedAt: new Date('2026-10-30T04:40:34Z'), now: new Date('2026-10-30T05:00:00Z') }),
    );
    expect(decision).toMatchObject({ confirm: true, instant: new Date('2026-10-30T04:42:00Z') });
    expect(STRICT_PAYMENT_TIME_CONFIG.toleranceSeconds).toBe(120);
  });
  test('o evento de confirmação precisa CONCORDAR com o webhook: evento a 5 min do webhook → TRANSACTION_DIVERGENT (ADMIN decide); a tolerância não foi ampliada', () => {
    const decision = decideAutoVerification(pixInput('2026-10-18T08:00:00Z', [sale('2026-10-18T11:55:00Z')]));
    expect(decision).toMatchObject({ confirm: false, reason: 'TRANSACTION_DIVERGENT', retryable: false });
  });
  test('Pix SEM evento de confirmação (linha do tempo vazia/duplicada): NÃO confirma — SUCCESS_EVENT_MISMATCH, com nova tentativa em breve', () => {
    expect(decideAutoVerification(pixInput('2026-10-18T08:00:00Z', []))).toMatchObject({ confirm: false, reason: 'SUCCESS_EVENT_MISMATCH', retryable: true });
    expect(decideAutoVerification(pixInput(PAID, [sale(PAID), sale(PAID)]))).toMatchObject({ confirm: false, reason: 'SUCCESS_EVENT_MISMATCH' });
  });
  test('Pix ainda NÃO pago (PENDING + sale_pending) continua bloqueado e tentará de novo', () => {
    const decision = decideAutoVerification(
      input({ fetched: { orderGid: GID, totalAmount: '350.00', currency: 'BRL', transactions: [tx({ status: 'PENDING' })], successEvents: [{ action: 'sale_pending', createdAt: PAID }] } }),
    );
    expect(decision).toMatchObject({ confirm: false, reason: 'NO_SUCCESS_TRANSACTION', retryable: true });
  });
  test('eventos fora de ordem na lista da Shopify e repetição da consulta dão a MESMA decisão', () => {
    const events = [{ action: 'mail_sent', createdAt: PAID }, sale(PAID), { action: 'sale_pending', createdAt: '2026-10-18T08:00:00Z' }];
    const first = decideAutoVerification(pixInput('2026-10-18T08:00:00Z', events));
    const again = decideAutoVerification(pixInput('2026-10-18T08:00:00Z', [...events].reverse()));
    expect(first).toEqual(again);
    expect(first.confirm).toBe(true);
  });
  test('a validação financeira continua valendo: total diferente, moeda ≠ BRL e confirmação no futuro seguem bloqueando', () => {
    expect(reason(decideAutoVerification(pixInput('2026-10-18T08:00:00Z', [sale(PAID)], { unitPriceCents: 1_000 })))).toBe('ORDER_TOTAL_MISMATCH');
    expect(reason(decideAutoVerification(pixInput('2026-10-18T08:00:00Z', [sale('2026-10-18T20:00:00Z')], { webhook: { triggered: new Date('2026-10-18T20:00:00Z'), updated: new Date('2026-10-18T20:00:00Z') } })))).toBe('INSTANT_IN_FUTURE');
  });
});
