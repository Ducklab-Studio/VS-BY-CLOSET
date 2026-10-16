import { describe, expect, test } from 'vitest';
import {
  buildPaymentAlerts,
  isCustomerOrderSource,
  isOrderSettled,
  latestOrderStates,
  type FlaggedReservation,
  type LinkedReservation,
  type OrderState,
} from './payment-alerts';

const at = (iso: string) => new Date(iso);

function order(id: string, overrides: Partial<OrderState> = {}): OrderState {
  return {
    orderId: id,
    name: `#${id}`,
    financialStatus: 'paid',
    cancelledAt: null,
    test: false,
    sourceName: 'channel:27099236',
    totalPrice: '120.00',
    currency: 'BRL',
    refundsCount: 0,
    updatedAt: at('2026-10-16T10:00:00Z'),
    createdAt: at('2026-10-16T09:59:00Z'),
    processedAt: at('2026-10-16T10:00:01Z'),
    ...overrides,
  };
}

const run = (
  orders: OrderState[],
  extra: {
    settled?: string[];
    deleted?: string[];
    valePass?: string[];
    linked?: Record<string, LinkedReservation>;
    flagged?: FlaggedReservation[];
    limit?: number;
    now?: string;
  } = {},
) =>
  buildPaymentAlerts({
    // 5 min depois do `updated_at` padrão dos pedidos: pedidos pagos com reserva em pending_payment ainda são "recentes".
    now: at(extra.now ?? '2026-10-16T10:05:00Z'),
    orders: latestOrderStates(orders),
    settledOrderIds: new Set(extra.settled ?? []),
    deletedOrderIds: new Set(extra.deleted ?? []),
    valePassOrderIds: new Set(extra.valePass ?? []),
    reservationsByOrder: new Map(Object.entries(extra.linked ?? {})),
    flaggedReservations: extra.flagged ?? [],
    limit: extra.limit,
  });

describe('origem do pedido (lista permitida)', () => {
  test('loja virtual e canais headless são de cliente; rascunho, PDV, apps e vazio não', () => {
    expect(isCustomerOrderSource('web')).toBe(true);
    expect(isCustomerOrderSource('WEB')).toBe(true);
    expect(isCustomerOrderSource('channel:27099236')).toBe(true);
    for (const s of ['shopify_draft_order', 'pos', 'shopify_pos', 'iphone', '418819375105', 'subscription_contract', '', null]) {
      expect(isCustomerOrderSource(s as string | null)).toBe(false);
    }
  });
});

describe('estado mais recente do pedido', () => {
  test('vale o maior updated_at, mesmo que o webhook antigo tenha sido processado depois', () => {
    const states = latestOrderStates([
      order('1', { financialStatus: 'paid', updatedAt: at('2026-10-16T10:00:00Z'), processedAt: at('2026-10-16T10:00:05Z') }),
      order('1', { financialStatus: 'paid', cancelledAt: '2026-10-16T10:05:00Z', updatedAt: at('2026-10-16T10:05:00Z'), processedAt: at('2026-10-16T10:05:01Z') }),
      order('1', { financialStatus: 'pending', updatedAt: at('2026-10-16T09:00:00Z'), processedAt: at('2026-10-16T10:06:00Z') }),
    ]);
    expect(states.get('1')?.cancelledAt).toBe('2026-10-16T10:05:00Z');
  });

  test('sem updated_at, vale o processado por último', () => {
    const states = latestOrderStates([
      order('2', { updatedAt: null, financialStatus: 'pending', processedAt: at('2026-10-16T10:00:00Z') }),
      order('2', { updatedAt: null, financialStatus: 'paid', processedAt: at('2026-10-16T10:01:00Z') }),
    ]);
    expect(states.get('2')?.financialStatus).toBe('paid');
  });
});

describe('pedido resolvido', () => {
  test('cancelado, reembolsado (total ou parcial), anulado, com refund ou excluído', () => {
    expect(isOrderSettled('1', order('1'), new Set())).toBe(false);
    expect(isOrderSettled('1', order('1', { cancelledAt: '2026-10-16T10:00:00Z' }), new Set())).toBe(true);
    expect(isOrderSettled('1', order('1', { financialStatus: 'refunded' }), new Set())).toBe(true);
    expect(isOrderSettled('1', order('1', { financialStatus: 'partially_refunded' }), new Set())).toBe(true);
    expect(isOrderSettled('1', order('1', { financialStatus: 'voided' }), new Set())).toBe(true);
    expect(isOrderSettled('1', order('1', { refundsCount: 1 }), new Set())).toBe(true);
    expect(isOrderSettled('1', order('1'), new Set(['1']))).toBe(true);
    expect(isOrderSettled('9', undefined, new Set(['9']))).toBe(true);
    expect(isOrderSettled('9', undefined, new Set())).toBe(false);
  });
});

describe('pedidos pagos sem reserva válida', () => {
  test('pago de cliente sem reserva vira alerta, com número, valor e moeda, sem dados pessoais', () => {
    const { count, alerts } = run([order('10')]);
    expect(count).toBe(1);
    expect(alerts[0]).toMatchObject({ kind: 'PAID_ORDER_WITHOUT_RESERVATION', key: 'order:10', orderName: '#10', amount: '120.00', currency: 'BRL', reservationId: null });
    expect(Object.keys(alerts[0]).sort()).toEqual(['amount', 'currency', 'key', 'kind', 'orderDeleted', 'orderId', 'orderName', 'orderSettled', 'reservationId', 'reservationStatus', 'since']);
  });

  test('não alerta: pendente, de teste, rascunho, PDV, app, Valle Pass', () => {
    const { count } = run(
      [
        order('11', { financialStatus: 'pending' }),
        order('12', { test: true }),
        order('13', { sourceName: 'shopify_draft_order' }),
        order('14', { sourceName: 'pos' }),
        order('15', { sourceName: '418819375105' }),
        order('16'),
      ],
      { valePass: ['16'] },
    );
    expect(count).toBe(0);
  });

  test('resolve sozinho SÓ por cancelamento financeiro ou reembolso', () => {
    const { count } = run(
      [order('20', { cancelledAt: '2026-10-16T11:00:00Z' }), order('21', { financialStatus: 'refunded' }), order('22'), order('23', { refundsCount: 1 })],
      { settled: ['22'] },
    );
    expect(count).toBe(0);
  });

  test('pedido EXCLUÍDO na Shopify mas ainda pago, sem cancelamento nem reembolso, continua alertando (e avisa que foi excluído)', () => {
    const { alerts } = run([order('24'), order('25', { cancelledAt: '2026-10-16T11:00:00Z' }), order('26', { refundsCount: 1 })], { deleted: ['24', '25', '26'] });
    expect(alerts.map((a) => a.key)).toEqual(['order:24']);
    expect(alerts[0].orderDeleted).toBe(true);
    // excluído E reembolsado/cancelado: o dinheiro foi tratado, alerta resolvido
  });

  test('pedido pago com reserva ainda em pending_payment: recente não alerta; passou de 30 min sem confirmação alerta (webhook pode ter falhado)', () => {
    const linked = { '27': { id: 'res-27', status: 'pending_payment', shopifyOrderId: '27' } };
    expect(run([order('27')], { linked }).count).toBe(0);
    const late = run([order('27')], { linked, now: '2026-10-16T10:45:00Z' });
    expect(late.alerts.map((a) => [a.key, a.kind])).toEqual([['order:27', 'PAID_ORDER_INACTIVE_RESERVATION']]);
    // sem updated_at do pedido: vale a hora em que o webhook foi processado
    expect(run([order('28', { updatedAt: null })], { linked: { '28': { id: 'res-28', status: 'pending_payment', shopifyOrderId: '28' } }, now: '2026-10-16T10:45:00Z' }).count).toBe(1);
  });

  test('reserva vinculada cancelada, expirada ou em HOLD → alerta; confirmada, em andamento e pending_payment → não', () => {
    const linked: Record<string, LinkedReservation> = {};
    const orders: OrderState[] = [];
    for (const [i, status] of ['cancelled', 'expired', 'hold', 'confirmed', 'pending_payment', 'picked_up', 'completed'].entries()) {
      const id = String(30 + i);
      orders.push(order(id));
      linked[id] = { id: `res-${id}`, status, shopifyOrderId: id };
    }
    const { alerts } = run(orders, { linked });
    expect(alerts.map((a) => a.key).sort()).toEqual(['order:30', 'order:31', 'order:32']);
    expect(alerts.every((a) => a.kind === 'PAID_ORDER_INACTIVE_RESERVATION')).toBe(true);
    expect(alerts.find((a) => a.key === 'order:30')?.reservationStatus).toBe('cancelled');
  });

  test('pedido de reserva em problem/late_payment_conflict não gera alerta de pedido (o alerta é o da reserva): sem duplicar', () => {
    const flagged: FlaggedReservation[] = [
      { id: 'res-40', status: 'problem', shopifyOrderId: '40', updatedAt: at('2026-10-16T12:00:00Z') },
      { id: 'res-41', status: 'late_payment_conflict', shopifyOrderId: '41', updatedAt: at('2026-10-16T12:01:00Z') },
    ];
    const { count, alerts } = run([order('40'), order('41')], {
      linked: { '40': { id: 'res-40', status: 'problem', shopifyOrderId: '40' }, '41': { id: 'res-41', status: 'late_payment_conflict', shopifyOrderId: '41' } },
      flagged,
    });
    expect(count).toBe(2);
    expect(alerts.map((a) => a.key)).toEqual(['reservation:res-41', 'reservation:res-40']);
    expect(new Set(alerts.map((a) => a.key)).size).toBe(alerts.length);
  });
});

describe('reservas em revisão e conflito de pagamento', () => {
  const flagged = (id: string, status: 'problem' | 'late_payment_conflict', orderId: string | null): FlaggedReservation => ({
    id,
    status,
    shopifyOrderId: orderId,
    updatedAt: at('2026-10-16T12:00:00Z'),
  });

  test('conflito de pagamento vem antes de pago sem reserva, que vem antes de problem; dentro do tipo, o mais antigo primeiro', () => {
    const { alerts } = run([order('50', { createdAt: at('2026-10-16T08:00:00Z') })], {
      flagged: [
        { ...flagged('p-new', 'problem', null), updatedAt: at('2026-10-16T13:00:00Z') },
        { ...flagged('p-old', 'problem', null), updatedAt: at('2026-10-16T09:00:00Z') },
        flagged('c-1', 'late_payment_conflict', null),
      ],
    });
    expect(alerts.map((a) => a.key)).toEqual(['reservation:c-1', 'order:50', 'reservation:p-old', 'reservation:p-new']);
  });

  test('reserva em problem fica sinalizada até a reserva ser efetivamente encerrada, mesmo com o pedido já cancelado/reembolsado; conflito de pagamento some quando o pedido é tratado', () => {
    const link = (id: string, status: string): LinkedReservation => ({ id: `r-${id}`, status, shopifyOrderId: id });
    const { alerts } = run([order('60', { cancelledAt: '2026-10-16T14:00:00Z' }), order('61', { refundsCount: 1 }), order('62'), order('63')], {
      settled: ['62'],
      linked: { '60': link('60', 'problem'), '61': link('61', 'late_payment_conflict'), '62': link('62', 'problem'), '63': link('63', 'problem') },
      flagged: [flagged('r-none', 'problem', null), flagged('r-60', 'problem', '60'), flagged('r-61', 'late_payment_conflict', '61'), flagged('r-62', 'problem', '62'), flagged('r-63', 'problem', '63')],
    });
    // r-61 (conflito + reembolso) some; os `problem` ficam, com `orderSettled` informando que o pedido já foi tratado
    expect(alerts.map((a) => a.key).sort()).toEqual(['reservation:r-60', 'reservation:r-62', 'reservation:r-63', 'reservation:r-none']);
    expect(alerts.find((a) => a.key === 'reservation:r-63')).toMatchObject({ orderName: '#63', amount: '120.00', kind: 'RESERVATION_PROBLEM', orderSettled: false });
    expect(alerts.find((a) => a.key === 'reservation:r-60')?.orderSettled).toBe(true);
    expect(alerts.find((a) => a.key === 'reservation:r-62')?.orderSettled).toBe(true);
  });

  test('reserva em revisão de pedido de TESTE não alerta (não é dinheiro real)', () => {
    const { count } = run([order('64', { test: true })], {
      linked: { '64': { id: 'r-64', status: 'problem', shopifyOrderId: '64' } },
      flagged: [flagged('r-64', 'problem', '64')],
    });
    expect(count).toBe(0);
  });

  test('pedido excluído na Shopify NÃO resolve nada: o alerta da reserva continua e avisa que o pedido foi excluído', () => {
    const { alerts } = run([order('80'), order('81')], {
      deleted: ['80', '81'],
      linked: { '81': { id: 'r-81', status: 'problem', shopifyOrderId: '81' } },
      flagged: [flagged('r-81', 'problem', '81')],
    });
    expect(alerts.map((a) => [a.key, a.orderDeleted])).toEqual([['order:80', true], ['reservation:r-81', true]].sort());
  });

  test('o limite corta a lista, mas count é o total', () => {
    const orders = Array.from({ length: 5 }, (_, i) => order(String(70 + i)));
    const result = run(orders, { limit: 2 });
    expect(result.count).toBe(5);
    expect(result.alerts).toHaveLength(2);
  });
});
