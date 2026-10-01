import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { PrismaService } from '../prisma/prisma.service';
import { RentalRuleConfigService } from '../rental-rule-config/rental-rule-config.service';
import { WebhooksService } from '../webhooks/webhooks.service';
import { ShopifyOrderSyncService } from '../webhooks/shopify-order-sync.service';
import { ValePassWebhookService } from '../vale-pass/vale-pass-webhook.service';
import { resolveReservationBindingSecret } from '../checkout/checkout.config';
import { canonicalItemsFingerprint, computeReservationSignature, generateReservationBindingId } from '../reservation-binding';
import { addDays, civilDateToISO, type CivilDate } from '../rental-rules/civil-date';
import type { ShopifyOrderPayload } from '../webhooks/shopify-order-payload';
import { AdminReservationsService } from './admin-reservations.service';
import { ReservationAttentionService } from './reservation-attention.service';
import { reservationNeedsAttention } from './reservation-attention';

process.env.RESERVATION_BINDING_SECRET ??= 'test-reservation-binding-secret-attention';

/**
 * Contador de novas reservas (integração real no banco de teste): as
 * reservas chegam pelo fluxo de verdade — webhook `orders/create` pendente,
 * `orders/paid`, cancelamento, entrega repetida — e a equipe marca como
 * vistas. Nada fala com a Shopify; nenhum HOLD é criado (as reservas de
 * teste já nascem com checkout pronto, como depois de um checkout real).
 */
const prisma = new PrismaService();
const webhooks = new WebhooksService(prisma, new ValePassWebhookService(), new ShopifyOrderSyncService());
const attention = new ReservationAttentionService(prisma);
const admin = new AdminReservationsService(prisma, new RentalRuleConfigService(prisma));
const PREFIX = `ATT-${Date.now()}`;
const actor = { id: randomUUID(), name: 'Equipe de teste' };
const otherActor = { id: randomUUID(), name: 'Outra pessoa da equipe' };
let unitCounter = 0;
let orderCounter = 7_000_000 + (Date.now() % 1_000_000);
let webhookCounter = 0;
const valePassOrderIds: string[] = [];

const nextWebhookId = () => `${PREFIX}-webhook-${webhookCounter++}`;
const nextOrderId = () => orderCounter++;

interface Fixture {
  reservationId: string;
  pickup: CivilDate;
  effectiveReturn: CivilDate;
  bindingId: string;
  itemsFingerprint: string;
  variantIds: string[];
}

async function createReservation(status: string, daysFromToday: number, opts: { source?: 'online' | 'manual_admin'; shopifyOrderId?: string } = {}): Promise<Fixture> {
  const code = `${PREFIX}-u${unitCounter++}`;
  const variantId = `${code}-variant`;
  const unit = await prisma.rentalUnit.create({ data: { code, name: 'peça de teste', shopifyVariantId: variantId, active: true, reservableOnline: true, countsTowardRentalDuration: true } });
  const pickup = addDays({ year: 2027, month: 3, day: 1 }, daysFromToday);
  const effectiveReturn = addDays(pickup, 2);
  const bindingId = generateReservationBindingId();
  const rows = await prisma.$queryRaw<{ id: string }[]>`
    INSERT INTO reservations (id, status, source, origin_store_id, pickup_date, return_date, checkout_state, shopify_cart_id, shopify_order_id, terms_accepted_at, terms_version, reservation_binding_id, payment_expires_at)
    VALUES (gen_random_uuid(), ${status}::"reservation_status", ${opts.source ?? 'online'}::"reservation_source", 'dev-store',
      ${civilDateToISO(pickup)}::date, ${civilDateToISO(effectiveReturn)}::date, 'ready', ${`${PREFIX}-cart-${unitCounter}`}, ${opts.shopifyOrderId ?? null},
      now(), 'test', ${bindingId}, now() + interval '1 day')
    RETURNING id
  `;
  await prisma.$executeRaw`
    INSERT INTO reservation_items (id, reservation_id, rental_unit_id, status, blocked_range)
    VALUES (gen_random_uuid(), ${rows[0].id}::uuid, ${unit.id}::uuid, ${status}::"reservation_status",
      daterange(${civilDateToISO(addDays(pickup, -3))}::date, ${civilDateToISO(addDays(effectiveReturn, 3))}::date, '[)'))
  `;
  return { reservationId: rows[0].id, pickup, effectiveReturn, bindingId, itemsFingerprint: canonicalItemsFingerprint([{ variantId, quantity: 1 }]), variantIds: [variantId] };
}

function signedOrder(f: Fixture, overrides: Partial<ShopifyOrderPayload> & { id: number }): ShopifyOrderPayload {
  const signature = computeReservationSignature(resolveReservationBindingSecret(), {
    reservationId: f.reservationId,
    reservationBindingId: f.bindingId,
    itemsFingerprint: f.itemsFingerprint,
    pickupDate: civilDateToISO(f.pickup),
    effectiveReturnDate: civilDateToISO(f.effectiveReturn),
  });
  return {
    admin_graphql_api_id: `gid://shopify/Order/${overrides.id}`,
    financial_status: 'paid',
    note_attributes: [
      { name: 'reservation_id', value: f.reservationId },
      { name: 'reservation_binding_id', value: f.bindingId },
      { name: 'reservation_signature', value: signature },
    ],
    line_items: f.variantIds.map((variant_id) => ({ variant_id, quantity: 1 })),
    ...overrides,
  };
}

const count = async () => (await attention.attentionCount()).count;
const detail = (id: string) => admin.getReservationDetail(id);
const row = (id: string) => prisma.reservation.findUniqueOrThrow({ where: { id } });
const viewedEvents = (id: string) => prisma.reservationEvent.count({ where: { reservationId: id, type: 'RESERVATION_VIEWED' } });

async function cleanup() {
  const reservations = await prisma.$queryRaw<{ id: string }[]>`
    SELECT DISTINCT ri.reservation_id AS id FROM reservation_items ri JOIN rental_units ru ON ru.id = ri.rental_unit_id WHERE ru.code LIKE ${PREFIX + '%'}
  `;
  const ids = reservations.map((r) => r.id);
  const hooks = (await prisma.$queryRaw<{ id: string }[]>`SELECT id FROM webhook_events WHERE shopify_webhook_id LIKE ${PREFIX + '%'}`).map((r) => r.id);
  if (ids.length || hooks.length) {
    await prisma.$executeRaw`DELETE FROM reservation_events WHERE reservation_id = ANY(${ids}::uuid[]) OR webhook_event_id = ANY(${hooks}::uuid[])`;
  }
  if (hooks.length) await prisma.$executeRaw`DELETE FROM webhook_events WHERE id = ANY(${hooks}::uuid[])`;
  if (ids.length) {
    await prisma.$executeRaw`DELETE FROM reservation_items WHERE reservation_id = ANY(${ids}::uuid[])`;
    await prisma.$executeRaw`DELETE FROM reservations WHERE id = ANY(${ids}::uuid[])`;
  }
  await prisma.$executeRaw`DELETE FROM rental_units WHERE code LIKE ${PREFIX + '%'}`;
  if (valePassOrderIds.length) {
    await prisma.valePassOrderEvent.deleteMany({ where: { valePassOrderId: { in: valePassOrderIds } } });
    await prisma.valePassOrder.deleteMany({ where: { id: { in: valePassOrderIds } } });
  }
}

beforeAll(cleanup);
afterAll(async () => {
  await cleanup();
  await prisma.$disconnect();
}, 60_000);

describe('Contador de novas reservas de aluguel (ClosetAdmin)', () => {
  let base = 0;
  let pending: Fixture;
  let pendingOrderId = 0;

  test('reserva futura pendente: só conta quando o pedido Shopify chega; aparece na lista como pendente e nova', async () => {
    base = await count();
    pending = await createReservation('pending_payment', 10);
    // Checkout pronto, sem pedido ainda (cliente no checkout): não é reserva "da Shopify" ainda.
    expect((await detail(pending.reservationId)).needsAttention).toBe(false);
    expect(await count()).toBe(base);

    pendingOrderId = nextOrderId();
    const res = await webhooks.handleIncoming({ topic: 'orders/create', shopifyWebhookId: nextWebhookId(), payload: signedOrder(pending, { id: pendingOrderId, financial_status: 'pending' }) });
    expect(res.outcome).toBe('processed');
    const r = await row(pending.reservationId);
    expect(r.status).toBe('pending_payment');
    expect(r.shopifyOrderId).toBe(String(pendingOrderId));
    expect(await count()).toBe(base + 1);

    const listed = await admin.listReservations({ code: pending.reservationId.replace(/-/g, '').slice(0, 12) });
    expect(listed.map((l) => [l.id, l.status, l.source, l.itemCount, l.needsAttention])).toEqual([[pending.reservationId, 'pending_payment', 'online', 1, true]]);
    expect(listed[0].pickupDate).toBe(civilDateToISO(pending.pickup));
    expect(listed[0].returnDate).toBe(civilDateToISO(pending.effectiveReturn));
  });

  test('webhook repetido (mesma entrega e nova entrega do mesmo pedido) não duplica reserva nem contador', async () => {
    const webhookId = nextWebhookId();
    const payload = signedOrder(pending, { id: pendingOrderId, financial_status: 'pending' });
    await webhooks.handleIncoming({ topic: 'orders/create', shopifyWebhookId: webhookId, payload });
    const again = await webhooks.handleIncoming({ topic: 'orders/create', shopifyWebhookId: webhookId, payload });
    expect(again.outcome).toBe('duplicate');
    await webhooks.handleIncoming({ topic: 'orders/updated', shopifyWebhookId: nextWebhookId(), payload });
    expect(await prisma.reservation.count({ where: { shopifyOrderId: String(pendingOrderId) } })).toBe(1);
    expect(await count()).toBe(base + 1);
  });

  test('abrir/visualizar marca como vista: sai do contador sem mudar status, pagamento, datas nem peças; um evento de histórico', async () => {
    const before = await row(pending.reservationId);
    const itemsBefore = await prisma.reservationItem.findMany({ where: { reservationId: pending.reservationId } });
    expect(await attention.markViewed([{ id: pending.reservationId, status: 'pending_payment' }], actor)).toEqual({ marked: 1 });

    const after = await row(pending.reservationId);
    expect([after.viewedStatus, after.viewedBy, !!after.viewedAt]).toEqual(['pending_payment', actor.id, true]);
    for (const key of ['status', 'pickupDate', 'returnDate', 'shopifyOrderId', 'paymentExpiresAt', 'confirmedAt', 'checkoutState', 'expiresAt', 'updatedAt', 'archivedAt'] as const) {
      expect(after[key]).toEqual(before[key]);
    }
    expect(await prisma.reservationItem.findMany({ where: { reservationId: pending.reservationId } })).toEqual(itemsBefore);
    expect((await detail(pending.reservationId)).needsAttention).toBe(false);
    expect(await count()).toBe(base);
    expect(await viewedEvents(pending.reservationId)).toBe(1);

    // Já vista: não volta a notificar nem duplica o evento.
    expect(await attention.markViewed([{ id: pending.reservationId, status: 'pending_payment' }], otherActor)).toEqual({ marked: 0 });
    expect((await row(pending.reservationId)).viewedBy).toBe(actor.id);
    expect(await viewedEvents(pending.reservationId)).toBe(1);
  });

  test('reserva futura paga: vira confirmada e a notificação volta (mudou de status depois de vista)', async () => {
    const res = await webhooks.handleIncoming({ topic: 'orders/paid', shopifyWebhookId: nextWebhookId(), payload: signedOrder(pending, { id: pendingOrderId }) });
    expect(res.outcome).toBe('processed');
    expect((await row(pending.reservationId)).status).toBe('confirmed');
    expect((await detail(pending.reservationId)).needsAttention).toBe(true);
    expect(await count()).toBe(base + 1);

    // Tela que ainda mostrava "pendente" não marca a confirmada como vista.
    expect(await attention.markViewed([{ id: pending.reservationId, status: 'pending_payment' }], actor)).toEqual({ marked: 0 });
    expect(await count()).toBe(base + 1);
  });

  test('duas abas/pessoas marcando ao mesmo tempo: grava uma vez, um evento, contador certo', async () => {
    const results = await Promise.all([
      attention.markViewed([{ id: pending.reservationId, status: 'confirmed' }], actor),
      attention.markViewed([{ id: pending.reservationId, status: 'confirmed' }], otherActor),
      attention.markViewed([{ id: pending.reservationId, status: 'confirmed' }, { id: pending.reservationId, status: 'confirmed' }], actor),
    ]);
    expect(results.reduce((sum, r) => sum + r.marked, 0)).toBe(1);
    expect(await viewedEvents(pending.reservationId)).toBe(2); // 1 de "pendente" + 1 de "confirmada"
    expect((await row(pending.reservationId)).viewedStatus).toBe('confirmed');
    expect(await count()).toBe(base);
  });

  test('cancelada ou expirada não gera alerta novo (nem se ninguém tinha visto)', async () => {
    const toCancel = await createReservation('pending_payment', 20);
    const cancelOrderId = nextOrderId();
    await webhooks.handleIncoming({ topic: 'orders/paid', shopifyWebhookId: nextWebhookId(), payload: signedOrder(toCancel, { id: cancelOrderId }) });
    expect((await row(toCancel.reservationId)).status).toBe('confirmed');
    expect(await count()).toBe(base + 1);
    await webhooks.handleIncoming({
      topic: 'orders/cancelled',
      shopifyWebhookId: nextWebhookId(),
      payload: { admin_graphql_api_id: `gid://shopify/Order/${cancelOrderId}`, financial_status: 'voided', cancel_reason: 'customer', cancelled_at: new Date().toISOString(), id: cancelOrderId, note_attributes: [] },
    });
    expect((await row(toCancel.reservationId)).status).toBe('cancelled');
    expect((await detail(toCancel.reservationId)).needsAttention).toBe(false);
    expect(await count()).toBe(base);

    const toExpire = await createReservation('pending_payment', 30);
    await webhooks.handleIncoming({ topic: 'orders/create', shopifyWebhookId: nextWebhookId(), payload: signedOrder(toExpire, { id: nextOrderId(), financial_status: 'pending' }) });
    expect(await count()).toBe(base + 1);
    await prisma.$executeRaw`UPDATE reservations SET status = 'expired' WHERE id = ${toExpire.reservationId}::uuid`;
    expect((await detail(toExpire.reservationId)).needsAttention).toBe(false);
    expect(await count()).toBe(base);
    expect(await attention.markViewed([{ id: toExpire.reservationId, status: 'pending_payment' }], actor)).toEqual({ marked: 0 });
  });

  test('fora do contador: Valle Pass, pedido comum, reserva manual, HOLD e arquivada', async () => {
    const vp = await prisma.valePassOrder.create({ data: { shopifyOrderId: `${PREFIX}-vp`, status: 'PENDING', quantity: 1, lastSyncSource: 'test' } });
    valePassOrderIds.push(vp.id);
    const reservationsBefore = await prisma.reservation.count();
    const common = await webhooks.handleIncoming({
      topic: 'orders/create',
      shopifyWebhookId: nextWebhookId(),
      payload: { id: nextOrderId(), admin_graphql_api_id: 'gid://shopify/Order/1', financial_status: 'pending', note_attributes: [], line_items: [{ variant_id: 'qualquer', quantity: 1 }] },
    });
    expect(common.outcome).toBe('ignored');
    expect(await prisma.reservation.count()).toBe(reservationsBefore);

    const manual = await createReservation('confirmed', 40, { source: 'manual_admin', shopifyOrderId: `${PREFIX}-manual` });
    const hold = await createReservation('hold', 50);
    const archived = await createReservation('confirmed', 60, { shopifyOrderId: `${PREFIX}-archived` });
    await prisma.reservation.update({ where: { id: archived.reservationId }, data: { archivedAt: new Date() } });
    for (const f of [manual, hold, archived]) expect((await detail(f.reservationId)).needsAttention).toBe(false);
    expect(await count()).toBe(base);
  });

  test('regra em memória igual à do banco', () => {
    const base = { source: 'online', shopifyOrderId: '1', status: 'confirmed', archivedAt: null, viewedStatus: null };
    expect(reservationNeedsAttention(base)).toBe(true);
    expect(reservationNeedsAttention({ ...base, viewedStatus: 'confirmed' })).toBe(false);
    expect(reservationNeedsAttention({ ...base, viewedStatus: 'pending_payment' })).toBe(true);
    for (const status of ['hold', 'expired', 'cancelled', 'problem', 'late_payment_conflict', 'picked_up']) expect(reservationNeedsAttention({ ...base, status })).toBe(false);
    expect(reservationNeedsAttention({ ...base, source: 'manual_admin' })).toBe(false);
    expect(reservationNeedsAttention({ ...base, shopifyOrderId: null })).toBe(false);
    expect(reservationNeedsAttention({ ...base, archivedAt: new Date() })).toBe(false);
  });
});
