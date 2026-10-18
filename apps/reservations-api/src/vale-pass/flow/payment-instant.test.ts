import { describe, expect, test } from 'vitest';
import { PAYMENT_INSTANT_SKEW_MS, parseIsoInstant, resolveWebhookSignal } from './payment-instant';

const now = new Date('2026-10-18T15:00:00.000Z');
const created = new Date('2026-10-18T12:00:00.000Z');
const sig = (over: Partial<Parameters<typeof resolveWebhookSignal>[0]> = {}) =>
  resolveWebhookSignal({ topic: 'orders/paid', triggeredAt: '2026-10-18T13:30:00Z', payloadUpdatedAt: '2026-10-18T13:30:02Z', orderCreatedAt: created, now, ...over });

describe('resolveWebhookSignal — sinais de horário do orders/paid, validados um a um (nenhum prova a confirmação financeira)', () => {
  test('cabeçalho e updated_at válidos → os dois sinais (nanossegundos da Shopify são aceitos e truncados a ms; fuso explícito)', () => {
    expect(sig()).toMatchObject({ triggered: new Date('2026-10-18T13:30:00.000Z'), updated: new Date('2026-10-18T13:30:02.000Z'), triggeredRejected: null, updatedRejected: null });
    expect(sig({ triggeredAt: '2026-10-18T13:30:00.123456789Z' }).triggered).toEqual(new Date('2026-10-18T13:30:00.123Z'));
    expect(sig({ triggeredAt: '2026-10-18T10:30:00-03:00' }).triggered).toEqual(new Date('2026-10-18T13:30:00.000Z'));
  });

  test.each(['orders/updated', 'orders/create', 'orders/cancelled', 'refunds/create', 'orders/delete'])('%s NUNCA produz sinal de pagamento (atualização genérica ≠ confirmação)', (topic) => {
    expect(sig({ topic })).toMatchObject({ triggered: null, updated: null, triggeredRejected: 'NOT_PAID_TOPIC' });
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
  ])('cabeçalho %j → descartado (%s): nada é inventado', (header, reason) => {
    expect(sig({ triggeredAt: header })).toMatchObject({ triggered: null, triggeredRejected: reason });
  });

  test('no futuro (além da tolerância de relógio) e anterior à criação do pedido → descartados; dentro da tolerância → aceitos', () => {
    const ahead = (ms: number) => new Date(now.getTime() + ms).toISOString();
    const behind = (ms: number) => new Date(created.getTime() - ms).toISOString();
    expect(sig({ triggeredAt: ahead(PAYMENT_INSTANT_SKEW_MS + 1_000) })).toMatchObject({ triggered: null, triggeredRejected: 'FUTURE' });
    expect(sig({ triggeredAt: ahead(60_000) }).triggered).not.toBeNull();
    expect(sig({ triggeredAt: behind(PAYMENT_INSTANT_SKEW_MS + 1_000) })).toMatchObject({ triggered: null, triggeredRejected: 'BEFORE_ORDER_CREATED' });
    expect(sig({ triggeredAt: behind(60_000) }).triggered).not.toBeNull();
  });

  test('cada sinal é validado sozinho: updated_at ruim não derruba o cabeçalho bom (e vice-versa)', () => {
    expect(sig({ payloadUpdatedAt: 'lixo' })).toMatchObject({ updated: null, updatedRejected: 'INVALID' });
    expect(sig({ payloadUpdatedAt: 'lixo' }).triggered).not.toBeNull();
    expect(sig({ triggeredAt: null }).updated).not.toBeNull();
  });

  test('sem a data de criação do pedido não há como comparar: aceita (a validação de futuro continua valendo)', () => {
    expect(sig({ orderCreatedAt: null }).triggered).not.toBeNull();
    expect(sig({ orderCreatedAt: null, triggeredAt: '2027-01-01T00:00:00Z' })).toMatchObject({ triggered: null, triggeredRejected: 'FUTURE' });
  });

  test('parseIsoInstant só interpreta ISO com fuso', () => {
    expect(parseIsoInstant('2026-10-18T14:30:00-03:00')).toEqual(new Date('2026-10-18T17:30:00.000Z'));
    expect(parseIsoInstant('18/10/2026 14:30')).toBeNull();
    expect(parseIsoInstant(null)).toBeNull();
  });
});
