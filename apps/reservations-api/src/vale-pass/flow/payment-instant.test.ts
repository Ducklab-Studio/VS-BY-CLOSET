import { describe, expect, test } from 'vitest';
import { PAYMENT_INSTANT_SKEW_MS, resolvePaymentInstant } from './payment-instant';

const now = new Date('2026-10-18T15:00:00.000Z');
const created = new Date('2026-10-18T12:00:00.000Z');

describe('resolvePaymentInstant — o instante real do pagamento (X-Shopify-Triggered-At do orders/paid)', () => {
  test('orders/paid com cabeçalho ISO válido → o instante (nanossegundos da Shopify são aceitos e truncados a ms)', () => {
    expect(resolvePaymentInstant({ topic: 'orders/paid', triggeredAt: '2026-10-18T13:30:00Z', orderCreatedAt: created, now })).toEqual({ at: new Date('2026-10-18T13:30:00.000Z') });
    expect(resolvePaymentInstant({ topic: 'orders/paid', triggeredAt: '2026-10-18T13:30:00.123456789Z', orderCreatedAt: created, now })).toEqual({ at: new Date('2026-10-18T13:30:00.123Z') });
    expect(resolvePaymentInstant({ topic: 'orders/paid', triggeredAt: '2026-10-18T10:30:00-03:00', orderCreatedAt: created, now })).toEqual({ at: new Date('2026-10-18T13:30:00.000Z') });
  });

  test.each(['orders/updated', 'orders/create', 'orders/cancelled', 'refunds/create', 'orders/delete'])('%s NUNCA define o instante do pagamento (atualização genérica ≠ confirmação)', (topic) => {
    expect(resolvePaymentInstant({ topic, triggeredAt: '2026-10-18T13:30:00Z', orderCreatedAt: created, now })).toEqual({ at: null, reason: 'NOT_PAID_TOPIC' });
  });

  test.each([
    [undefined, 'MISSING'],
    [null, 'MISSING'],
    ['', 'MISSING'],
    ['   ', 'MISSING'],
    ['ontem', 'INVALID'],
    ['2026-10-18', 'INVALID'],
    ['2026-10-18 13:30:00', 'INVALID'],
    ['2026-10-18T13:30:00', 'INVALID'], // sem fuso: ambíguo, não se adivinha
    ['1760800000', 'INVALID'],
    ['2026-13-45T00:00:00Z', 'INVALID'],
    ['2026-10-18T25:00:00Z', 'INVALID'],
  ])('cabeçalho %j → sem instante (%s): nada é inventado', (header, reason) => {
    expect(resolvePaymentInstant({ topic: 'orders/paid', triggeredAt: header, orderCreatedAt: created, now })).toEqual({ at: null, reason });
  });

  test('no futuro (além da tolerância de relógio) e anterior à criação do pedido → rejeitados; dentro da tolerância → aceitos', () => {
    const ahead = (ms: number) => new Date(now.getTime() + ms).toISOString();
    const behind = (ms: number) => new Date(created.getTime() - ms).toISOString();
    expect(resolvePaymentInstant({ topic: 'orders/paid', triggeredAt: ahead(PAYMENT_INSTANT_SKEW_MS + 1_000), orderCreatedAt: created, now })).toEqual({ at: null, reason: 'FUTURE' });
    expect(resolvePaymentInstant({ topic: 'orders/paid', triggeredAt: ahead(60_000), orderCreatedAt: created, now }).at).not.toBeNull();
    expect(resolvePaymentInstant({ topic: 'orders/paid', triggeredAt: behind(PAYMENT_INSTANT_SKEW_MS + 1_000), orderCreatedAt: created, now })).toEqual({ at: null, reason: 'BEFORE_ORDER_CREATED' });
    expect(resolvePaymentInstant({ topic: 'orders/paid', triggeredAt: behind(60_000), orderCreatedAt: created, now }).at).not.toBeNull();
  });

  test('reentrega: se o updated_at do payload é válido e mais antigo que o cabeçalho, vale o mais antigo (nunca atrasa o prazo); fora da janela, é ignorado', () => {
    const base = { topic: 'orders/paid', triggeredAt: '2026-10-18T14:00:00Z', orderCreatedAt: created, now };
    expect(resolvePaymentInstant({ ...base, payloadUpdatedAt: new Date('2026-10-18T13:00:00Z') })).toEqual({ at: new Date('2026-10-18T13:00:00Z') });
    expect(resolvePaymentInstant({ ...base, payloadUpdatedAt: new Date('2026-10-18T14:30:00Z') })).toEqual({ at: new Date('2026-10-18T14:00:00.000Z') }); // mais novo: ignorado
    expect(resolvePaymentInstant({ ...base, payloadUpdatedAt: new Date('2026-10-18T01:00:00Z') })).toEqual({ at: new Date('2026-10-18T14:00:00.000Z') }); // antes da criação: ignorado
    expect(resolvePaymentInstant({ ...base, payloadUpdatedAt: null }).at).toEqual(new Date('2026-10-18T14:00:00.000Z'));
  });

  test('sem a data de criação do pedido não há como comparar: aceita (a validação de futuro continua valendo)', () => {
    expect(resolvePaymentInstant({ topic: 'orders/paid', triggeredAt: '2026-10-18T13:30:00Z', orderCreatedAt: null, now }).at).not.toBeNull();
    expect(resolvePaymentInstant({ topic: 'orders/paid', triggeredAt: '2027-01-01T00:00:00Z', orderCreatedAt: null, now })).toEqual({ at: null, reason: 'FUTURE' });
  });
});
