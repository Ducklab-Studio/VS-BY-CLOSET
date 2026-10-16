import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { PrismaService } from '../prisma/prisma.service';
import { WebhooksService } from '../webhooks/webhooks.service';
import { ShopifyOrderSyncService } from '../webhooks/shopify-order-sync.service';
import { ValePassWebhookService } from '../vale-pass/vale-pass-webhook.service';
import { generateReservationBindingId } from '../reservation-binding';
import { civilDateToISO, addDays } from '../rental-rules/civil-date';
import { PaymentAlertsService } from './payment-alerts.service';
import type { PaymentAlert } from './payment-alerts';

/**
 * Alertas financeiros (integração real no banco de teste): os pedidos chegam pelo fluxo de verdade (webhooks da
 * Shopify processados pelo WebhooksService) e as reservas são gravadas como depois de um checkout real. Nada fala
 * com a Shopify; o serviço de alertas só LÊ. O banco de teste pode ter outros dados: cada teste olha só os alertas
 * dos seus próprios pedidos/reservas (pelo prefixo).
 */
const prisma = new PrismaService();
const webhooks = new WebhooksService(prisma, new ValePassWebhookService(), new ShopifyOrderSyncService());
const alertsService = new PaymentAlertsService(prisma);
alertsService.cacheTtlMs = 0;
const PREFIX = `PAL-${Date.now()}`;
let orderCounter = 8_000_000 + (Date.now() % 1_000_000);
let hookCounter = 0;
let unitCounter = 0;
const valePassIds: string[] = [];
const mine = new Set<string>();

const nextHook = () => `${PREFIX}-hook-${hookCounter++}`;
const nextOrderId = () => {
  const id = orderCounter++;
  mine.add(String(id));
  return id;
};

function paid(id: number, overrides: Record<string, unknown> = {}) {
  return {
    id,
    admin_graphql_api_id: `gid://shopify/Order/${id}`,
    name: `#${id}`,
    financial_status: 'paid',
    source_name: 'web',
    test: false,
    total_price: '120.00',
    currency: 'BRL',
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    cancelled_at: null,
    line_items: [{ variant_id: 1, quantity: 1 }],
    ...overrides,
  };
}

const send = (topic: string, payload: unknown) => webhooks.handleIncoming({ topic, shopifyWebhookId: nextHook(), payload });

async function alerts(): Promise<PaymentAlert[]> {
  const { alerts: all } = await alertsService.list({ limit: 1000, fresh: true });
  return all.filter((a) => (a.orderId && mine.has(a.orderId)) || (a.reservationId && ownReservations.has(a.reservationId)));
}
const ownReservations = new Set<string>();
const byOrder = async (id: number) => (await alerts()).filter((a) => a.orderId === String(id));

async function createReservation(status: string, opts: { orderId?: number; archived?: boolean } = {}): Promise<string> {
  const code = `${PREFIX}-u${unitCounter++}`;
  const unit = await prisma.rentalUnit.create({ data: { code, name: 'peça de teste', shopifyVariantId: `${code}-variant`, active: true, reservableOnline: true, countsTowardRentalDuration: true } });
  const pickup = addDays({ year: 2028, month: 3, day: 1 }, unitCounter * 10);
  const ret = addDays(pickup, 2);
  const rows = await prisma.$queryRaw<{ id: string }[]>`
    INSERT INTO reservations (id, status, source, origin_store_id, pickup_date, return_date, checkout_state, shopify_cart_id, shopify_order_id, terms_accepted_at, terms_version, reservation_binding_id, payment_expires_at, archived_at)
    VALUES (gen_random_uuid(), ${status}::"reservation_status", 'online'::"reservation_source", 'dev-store',
      ${civilDateToISO(pickup)}::date, ${civilDateToISO(ret)}::date, 'ready', ${`${PREFIX}-cart-${unitCounter}`}, ${opts.orderId ? String(opts.orderId) : null},
      now(), 'test', ${generateReservationBindingId()}, now() + interval '1 day', ${opts.archived ? new Date() : null})
    RETURNING id
  `;
  // Itens só para quem ocupa a peça (a restrição de ocupação vale para esses status).
  const occupying = ['hold', 'pending_payment', 'confirmed', 'problem'].includes(status);
  await prisma.$executeRaw`
    INSERT INTO reservation_items (id, reservation_id, rental_unit_id, status, blocked_range)
    VALUES (gen_random_uuid(), ${rows[0].id}::uuid, ${unit.id}::uuid, ${(occupying ? status : 'cancelled')}::"reservation_status",
      daterange(${civilDateToISO(addDays(pickup, -3))}::date, ${civilDateToISO(addDays(ret, 3))}::date, '[)'))
  `;
  ownReservations.add(rows[0].id);
  return rows[0].id;
}

async function cleanup() {
  const reservations = await prisma.$queryRaw<{ id: string }[]>`
    SELECT DISTINCT ri.reservation_id AS id FROM reservation_items ri JOIN rental_units ru ON ru.id = ri.rental_unit_id WHERE ru.code LIKE ${PREFIX + '%'}
  `;
  const ids = reservations.map((r) => r.id);
  const hooks = (await prisma.$queryRaw<{ id: string }[]>`SELECT id FROM webhook_events WHERE shopify_webhook_id LIKE ${PREFIX + '%'}`).map((r) => r.id);
  if (ids.length || hooks.length) await prisma.$executeRaw`DELETE FROM reservation_events WHERE reservation_id = ANY(${ids}::uuid[]) OR webhook_event_id = ANY(${hooks}::uuid[])`;
  if (hooks.length) await prisma.$executeRaw`DELETE FROM webhook_events WHERE id = ANY(${hooks}::uuid[])`;
  if (ids.length) {
    await prisma.$executeRaw`DELETE FROM reservation_items WHERE reservation_id = ANY(${ids}::uuid[])`;
    await prisma.$executeRaw`DELETE FROM reservations WHERE id = ANY(${ids}::uuid[])`;
  }
  await prisma.$executeRaw`DELETE FROM rental_units WHERE code LIKE ${PREFIX + '%'}`;
  if (valePassIds.length) {
    await prisma.valePassOrderEvent.deleteMany({ where: { valePassOrderId: { in: valePassIds } } });
    await prisma.valePassOrder.deleteMany({ where: { id: { in: valePassIds } } });
  }
}

beforeAll(cleanup);
afterAll(async () => {
  await cleanup();
  await prisma.$disconnect();
}, 60_000);

describe('Pagamentos a tratar — pedidos pagos sem reserva válida', () => {
  test('pedido pago da loja/Headless sem reserva alerta; cancelado depois, o alerta desaparece', async () => {
    const id = nextOrderId();
    expect((await send('orders/paid', paid(id, { source_name: 'channel:27099236' }))).outcome).toBe('ignored');
    const [alert] = await byOrder(id);
    expect(alert).toMatchObject({ kind: 'PAID_ORDER_WITHOUT_RESERVATION', orderName: `#${id}`, amount: '120.00', currency: 'BRL', reservationId: null });
    // sem dados pessoais: só estes campos
    expect(Object.keys(alert).sort()).toEqual(['amount', 'currency', 'key', 'kind', 'orderDeleted', 'orderId', 'orderName', 'orderSettled', 'reservationId', 'reservationStatus', 'since']);

    await send('orders/cancelled', paid(id, { source_name: 'channel:27099236', cancelled_at: new Date().toISOString(), cancel_reason: 'customer', updated_at: new Date(Date.now() + 1000).toISOString() }));
    expect(await byOrder(id)).toHaveLength(0);
  }, 30_000);

  test('reembolso criado (refunds/create) resolve o alerta', async () => {
    const id = nextOrderId();
    await send('orders/paid', paid(id));
    expect(await byOrder(id)).toHaveLength(1);
    await send('refunds/create', { id: id + 1, order_id: id, transactions: [] });
    expect(await byOrder(id)).toHaveLength(0);
  }, 30_000);

  test('pedido EXCLUÍDO na Shopify (orders/delete) mas ainda pago NÃO resolve o alerta (avisa que foi excluído); cancelado ou reembolsado, resolve', async () => {
    const id = nextOrderId();
    await send('orders/paid', paid(id));
    expect(await byOrder(id)).toHaveLength(1);
    await send('orders/delete', { id });
    const [stillThere] = await byOrder(id);
    expect(stillThere).toMatchObject({ kind: 'PAID_ORDER_WITHOUT_RESERVATION', orderDeleted: true });

    const refunded = nextOrderId();
    await send('orders/paid', paid(refunded));
    await send('orders/delete', { id: refunded });
    await send('refunds/create', { id: refunded + 1, order_id: refunded, transactions: [] });
    expect(await byOrder(refunded)).toHaveLength(0);
  }, 40_000);

  test('pedido pago com reserva em pending_payment: recente não alerta; sem confirmação há mais de 30 min alerta', async () => {
    const recent = nextOrderId();
    const stale = nextOrderId();
    await createReservation('pending_payment', { orderId: recent });
    await createReservation('pending_payment', { orderId: stale });
    await send('orders/paid', paid(recent));
    await send('orders/paid', paid(stale, { updated_at: new Date(Date.now() - 45 * 60_000).toISOString() }));
    expect(await byOrder(recent)).toHaveLength(0);
    expect((await byOrder(stale))[0]).toMatchObject({ kind: 'PAID_ORDER_INACTIVE_RESERVATION', reservationStatus: 'pending_payment' });
  }, 40_000);

  test('financial_status refunded/partially_refunded em atualização posterior também resolve', async () => {
    const a = nextOrderId();
    const b = nextOrderId();
    await send('orders/paid', paid(a));
    await send('orders/paid', paid(b));
    expect(await byOrder(a)).toHaveLength(1);
    await send('orders/updated', paid(a, { financial_status: 'refunded', updated_at: new Date(Date.now() + 2000).toISOString() }));
    await send('orders/updated', paid(b, { financial_status: 'partially_refunded', updated_at: new Date(Date.now() + 2000).toISOString() }));
    expect(await byOrder(a)).toHaveLength(0);
    expect(await byOrder(b)).toHaveLength(0);
  }, 30_000);

  test('NÃO alerta: rascunho, PDV, pedido de aplicativo, pedido de teste e ainda não pago', async () => {
    const ids = [
      [nextOrderId(), { source_name: 'shopify_draft_order' }],
      [nextOrderId(), { source_name: 'pos' }],
      [nextOrderId(), { source_name: '418819375105' }],
      [nextOrderId(), { test: true }],
      [nextOrderId(), { financial_status: 'pending' }],
    ] as const;
    for (const [id, overrides] of ids) await send('orders/create', paid(id, overrides));
    for (const [id] of ids) expect(await byOrder(id)).toHaveLength(0);
  }, 30_000);

  test('Valle Pass nunca alerta como aluguel', async () => {
    const id = nextOrderId();
    const vp = await prisma.valePassOrder.create({ data: { shopifyOrderId: String(id), status: 'PENDING', quantity: 1, lastSyncSource: 'test' } });
    valePassIds.push(vp.id);
    await send('orders/paid', paid(id));
    expect(await byOrder(id)).toHaveLength(0);
  }, 30_000);

  test('pedido pago com reserva vinculada cancelada/expirada/HOLD alerta; confirmada/pendente/em andamento não', async () => {
    const expectations: [string, boolean][] = [['cancelled', true], ['expired', true], ['hold', true], ['confirmed', false], ['pending_payment', false], ['picked_up', false]];
    for (const [status, shouldAlert] of expectations) {
      const id = nextOrderId();
      await createReservation(status, { orderId: id });
      await send('orders/paid', paid(id));
      const found = await byOrder(id);
      expect(found.length, `status ${status}`).toBe(shouldAlert ? 1 : 0);
      if (shouldAlert) expect(found[0]).toMatchObject({ kind: 'PAID_ORDER_INACTIVE_RESERVATION', reservationStatus: status });
    }
  }, 60_000);
});

describe('Pagamentos a tratar — reservas em revisão e conflito de pagamento', () => {
  test('problem e late_payment_conflict alertam; arquivada não; sem duplicar com o alerta do pedido', async () => {
    const problemOrder = nextOrderId();
    const conflictOrder = nextOrderId();
    const problem = await createReservation('problem', { orderId: problemOrder });
    const conflict = await createReservation('late_payment_conflict', { orderId: conflictOrder });
    const archived = await createReservation('problem', { archived: true });
    const noOrder = await createReservation('problem');
    await send('orders/paid', paid(problemOrder));
    await send('orders/paid', paid(conflictOrder));

    const found = await alerts();
    const keys = found.map((a) => a.key);
    expect(keys).toContain(`reservation:${problem}`);
    expect(keys).toContain(`reservation:${conflict}`);
    expect(keys).toContain(`reservation:${noOrder}`);
    expect(keys).not.toContain(`reservation:${archived}`);
    // o pedido pago dessas reservas NÃO gera um segundo alerta (order:...)
    expect(keys).not.toContain(`order:${problemOrder}`);
    expect(keys).not.toContain(`order:${conflictOrder}`);
    expect(new Set(keys).size).toBe(keys.length);
    expect(found.find((a) => a.reservationId === conflict)).toMatchObject({ kind: 'LATE_PAYMENT_CONFLICT', amount: '120.00' });
    expect(found.find((a) => a.reservationId === problem)).toMatchObject({ kind: 'RESERVATION_PROBLEM' });
  }, 60_000);

  test('conflito de pagamento some quando o pedido é reembolsado; reserva em problem continua sinalizada mesmo com o pedido cancelado', async () => {
    const cancelledOrder = nextOrderId();
    const refundedOrder = nextOrderId();
    const a = await createReservation('problem', { orderId: cancelledOrder });
    const b = await createReservation('late_payment_conflict', { orderId: refundedOrder });
    await send('orders/paid', paid(cancelledOrder));
    await send('orders/paid', paid(refundedOrder));
    let found = await alerts();
    expect(found.map((x) => x.key)).toEqual(expect.arrayContaining([`reservation:${a}`, `reservation:${b}`]));
    expect(found.find((x) => x.reservationId === a)?.orderSettled).toBe(false);

    await send('orders/cancelled', paid(cancelledOrder, { cancelled_at: new Date().toISOString(), updated_at: new Date(Date.now() + 1000).toISOString() }));
    await send('refunds/create', { id: refundedOrder + 1, order_id: refundedOrder, transactions: [] });
    found = await alerts();
    const problem = found.find((x) => x.reservationId === a);
    expect(problem).toMatchObject({ kind: 'RESERVATION_PROBLEM', orderSettled: true }); // segue pedindo revisão: a peça continua presa
    expect(found.map((x) => x.key)).not.toContain(`reservation:${b}`);
  }, 60_000);

  test('reserva em problem de pedido de TESTE não alerta', async () => {
    const id = nextOrderId();
    const r = await createReservation('problem', { orderId: id });
    await send('orders/paid', paid(id, { test: true }));
    expect((await alerts()).map((x) => x.reservationId)).not.toContain(r);
  }, 40_000);
});

describe('Leitura apenas e contagem', () => {
  test('count bate com a lista (sem limite), a leitura repetida não altera dados e o cache reaproveita a resposta', async () => {
    const before = await prisma.$queryRaw<{ n: number }[]>`SELECT (SELECT count(*) FROM webhook_events)::int + (SELECT count(*) FROM reservations)::int + (SELECT count(*) FROM reservation_events)::int AS n`;
    const full = await alertsService.list({ limit: 1000, fresh: true });
    expect(full.count).toBe(full.alerts.length);
    expect(new Set(full.alerts.map((a) => a.key)).size).toBe(full.alerts.length);
    expect((await alertsService.count()).count).toBe((await alertsService.list({ fresh: true })).count);
    const after = await prisma.$queryRaw<{ n: number }[]>`SELECT (SELECT count(*) FROM webhook_events)::int + (SELECT count(*) FROM reservations)::int + (SELECT count(*) FROM reservation_events)::int AS n`;
    expect(after[0].n).toBe(before[0].n);

    const cached = new PaymentAlertsService(prisma);
    const first = await cached.list();
    expect(await cached.list()).toBe(first); // mesma referência: reaproveitou a leitura
    expect(randomUUID()).toBeTruthy();
  }, 60_000);
});
