import { describe, expect, test } from 'vitest';
import { paymentInstantFromTransactions, type ShopifyOrderTransactions, type ShopifyTransaction } from './payment-transactions';

const tx = (over: Partial<ShopifyTransaction> = {}): ShopifyTransaction => ({ id: 'gid://shopify/OrderTransaction/' + Math.random(), kind: 'SALE', status: 'SUCCESS', test: false, processedAt: '2026-10-18T12:00:00Z', amount: '350.00', currency: 'BRL', ...over });
const order = (transactions: ShopifyTransaction[], totalAmount: string | null = '350.00'): ShopifyOrderTransactions => ({ totalAmount, currency: 'BRL', transactions });

describe('paymentInstantFromTransactions — horário do pagamento pela transação financeira bem-sucedida', () => {
  test('cartão: SALE com sucesso cobrindo o total → processedAt', () => {
    expect(paymentInstantFromTransactions(order([tx()]))).toMatchObject({ instant: new Date('2026-10-18T12:00:00Z'), reason: 'OK', used: 1 });
  });
  test('captura posterior: AUTHORIZATION não conta; vale o CAPTURE (a autorização sozinha NÃO é pagamento)', () => {
    const auth = tx({ kind: 'AUTHORIZATION', processedAt: '2026-10-15T10:00:00Z' });
    expect(paymentInstantFromTransactions(order([auth])).reason).toBe('NO_SUCCESS_TRANSACTION');
    const capture = tx({ kind: 'CAPTURE', processedAt: '2026-10-17T09:00:00Z' });
    expect(paymentInstantFromTransactions(order([auth, capture]))).toMatchObject({ instant: new Date('2026-10-17T09:00:00Z'), reason: 'OK' });
  });
  test('Pix: PENDING não conta; só o SUCCESS confirma', () => {
    expect(paymentInstantFromTransactions(order([tx({ status: 'PENDING', processedAt: '2026-10-18T08:00:00Z' })])).reason).toBe('NO_SUCCESS_TRANSACTION');
    expect(paymentInstantFromTransactions(order([tx({ status: 'PENDING' }), tx({ processedAt: '2026-10-18T17:00:00Z' })])).instant).toEqual(new Date('2026-10-18T17:00:00Z'));
  });
  test.each(['FAILURE', 'ERROR', 'AWAITING_RESPONSE', 'UNKNOWN'])('status %s nunca confirma', (status) => {
    expect(paymentInstantFromTransactions(order([tx({ status })])).instant).toBeNull();
  });
  test.each(['VOID', 'REFUND', 'CHANGE', 'SUGGESTED_REFUND', 'EMV_AUTHORIZATION', 'AUTHORIZATION'])('tipo %s nunca confirma pagamento', (kind) => {
    expect(paymentInstantFromTransactions(order([tx({ kind })])).instant).toBeNull();
  });
  test('pagamento DIVIDIDO (cartão + vale): confirmado só quando o último pedaço cobre o total; ordem pelo processedAt', () => {
    const a = tx({ amount: '100.00', processedAt: '2026-10-18T10:00:00Z' });
    const b = tx({ amount: '250.00', processedAt: '2026-10-18T10:30:00Z' });
    expect(paymentInstantFromTransactions(order([b, a]))).toMatchObject({ instant: new Date('2026-10-18T10:30:00Z'), used: 2 });
    expect(paymentInstantFromTransactions(order([a])).reason).toBe('PARTIAL_PAYMENT');
  });
  test('transação de teste não conta (a menos que o ensaio libere)', () => {
    expect(paymentInstantFromTransactions(order([tx({ test: true })])).reason).toBe('ONLY_TEST_TRANSACTIONS');
    expect(paymentInstantFromTransactions(order([tx({ test: true })]), { allowTest: true }).instant).not.toBeNull();
  });
  test('fail-closed: total ausente/zero, processedAt ausente/ilegível, valor ilegível, moeda diferente', () => {
    expect(paymentInstantFromTransactions(order([tx()], null)).reason).toBe('TOTAL_UNKNOWN');
    expect(paymentInstantFromTransactions(order([tx()], '0.00')).reason).toBe('TOTAL_UNKNOWN');
    expect(paymentInstantFromTransactions(order([tx({ processedAt: null })])).reason).toBe('PROCESSED_AT_UNKNOWN');
    expect(paymentInstantFromTransactions(order([tx({ processedAt: 'ontem' })])).reason).toBe('PROCESSED_AT_UNKNOWN');
    expect(paymentInstantFromTransactions(order([tx({ amount: 'abc' })])).reason).toBe('AMOUNT_UNKNOWN');
    expect(paymentInstantFromTransactions(order([tx({ currency: 'USD' })])).reason).toBe('CURRENCY_MISMATCH');
  });
  test('sem transações → NO_SUCCESS_TRANSACTION', () => {
    expect(paymentInstantFromTransactions(order([])).instant).toBeNull();
  });
});
