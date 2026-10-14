import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { RentalRuleConfigService } from '../rental-rule-config/rental-rule-config.service';
import { ValePassWebhookService } from '../vale-pass/vale-pass-webhook.service';
import { ShopifyOrderSyncService } from '../webhooks/shopify-order-sync.service';
import { WebhooksService } from '../webhooks/webhooks.service';
import type { ShopifyOrderPayload } from '../webhooks/shopify-order-payload';
import { resolveReservationBindingSecret } from '../checkout/checkout.config';
import { canonicalItemsFingerprint, computeReservationSignature, generateReservationBindingId } from '../reservation-binding';
import { ReservationExpirySchedulerService } from '../reservation-expiry/reservation-expiry-scheduler.service';
import { addDays, civilDateToISO } from '../rental-rules/civil-date';
import { AdminReservationsService } from './admin-reservations.service';
import { reservationAttentionSql } from './reservation-attention';

process.env.RESERVATION_BINDING_SECRET ??= 'test-reservation-binding-secret-flow';

// Suíte de escrita: nunca roda contra banco hospedado, mesmo se chamada sozinha.
const localDatabase = /^postgres(?:ql)?:\/\/[^@]+@(localhost|127\.0\.0\.1)(:\d+)?\/[^/]*(test|audit|operational)/i.test(process.env.DATABASE_URL ?? '');
const localDescribe = localDatabase ? describe : describe.skip;

const prisma = new PrismaService();
const admin = new AdminReservationsService(prisma, new RentalRuleConfigService(prisma));
const webhooks = new WebhooksService(prisma, new ValePassWebhookService(), new ShopifyOrderSyncService());
const scheduler = new ReservationExpirySchedulerService(prisma);
const PREFIX = `FLW-${Date.now()}`;
let seq = 0;
let orderSeq = 5_000_000;

interface Flow { id: string; variantId: string; unitId: string; bindingId: string; pickup: ReturnType<typeof addDays> }

async function reservation(status: string, opts: { windowElapsed?: boolean; unit?: { variantId: string; unitId: string } } = {}): Promise<Flow> {
  const code = `${PREFIX}-u${seq++}`;
  const variantId = opts.unit?.variantId ?? code;
  const unitId = opts.unit?.unitId ?? (await prisma.rentalUnit.create({ data: { code, name: 'peça de teste', shopifyVariantId: variantId, active: true, reservableOnline: true, countsTowardRentalDuration: true } })).id;
  const pickup = addDays({ year: 2028, month: 9, day: 1 }, 0);
  const bindingId = generateReservationBindingId();
  const window = opts.windowElapsed ? new Date(Date.now() - 5 * 60_000) : new Date(Date.now() + 60 * 60_000);
  const rows = await prisma.$queryRaw<{ id: string }[]>`
    INSERT INTO reservations (id, status, origin_store_id, pickup_date, return_date, checkout_state, shopify_cart_id, payment_expires_at, terms_accepted_at, terms_version, reservation_binding_id)
    VALUES (gen_random_uuid(), ${status}::"reservation_status", 'dev-store', ${civilDateToISO(pickup)}::date, ${civilDateToISO(addDays(pickup, 2))}::date, 'ready'::"checkout_state", ${`${PREFIX}-cart-${seq++}`}, ${window}, now(), 'test', ${bindingId})
    RETURNING id`;
  await prisma.$executeRaw`
    INSERT INTO reservation_items (id, reservation_id, rental_unit_id, status, blocked_range)
    VALUES (gen_random_uuid(), ${rows[0].id}::uuid, ${unitId}::uuid, ${status}::"reservation_status", daterange(${civilDateToISO(addDays(pickup, -3))}::date, ${civilDateToISO(addDays(pickup, 5))}::date, '[)'))`;
  return { id: rows[0].id, variantId, unitId, bindingId, pickup };
}

function paid(f: Flow, id: number): ShopifyOrderPayload {
  const signature = computeReservationSignature(resolveReservationBindingSecret(), {
    reservationId: f.id,
    reservationBindingId: f.bindingId,
    itemsFingerprint: canonicalItemsFingerprint([{ variantId: f.variantId, quantity: 1 }]),
    pickupDate: civilDateToISO(f.pickup),
    effectiveReturnDate: civilDateToISO(addDays(f.pickup, 2)),
  });
  return {
    id,
    admin_graphql_api_id: `gid://shopify/Order/${id}`,
    name: `#${id}`,
    financial_status: 'paid',
    updated_at: '2030-10-01T10:00:00Z',
    note_attributes: [
      { name: 'reservation_id', value: f.id },
      { name: 'reservation_binding_id', value: f.bindingId },
      { name: 'reservation_signature', value: signature },
    ],
    line_items: [{ variant_id: f.variantId, quantity: 1 }],
  };
}
const statusOf = async (f: Flow) => (await prisma.reservation.findUniqueOrThrow({ where: { id: f.id } })).status;
const needsAttention = async (f: Flow) => (await prisma.$queryRaw<{ needs: boolean }[]>(Prisma.sql`SELECT ${reservationAttentionSql('r')} AS needs FROM reservations r WHERE r.id = ${f.id}::uuid`))[0].needs;
const pay = (f: Flow) => webhooks.handleIncoming({ topic: 'orders/paid', shopifyWebhookId: `${PREFIX}-wh-${seq++}`, payload: paid(f, orderSeq++) });

async function cleanup() {
  const rows = await prisma.$queryRaw<{ id: string }[]>`SELECT DISTINCT ri.reservation_id AS id FROM reservation_items ri JOIN rental_units ru ON ru.id = ri.rental_unit_id WHERE ru.code LIKE ${PREFIX + '%'}`;
  const ids = rows.map((r) => r.id);
  const ev = await prisma.$queryRaw<{ id: string }[]>`SELECT id FROM webhook_events WHERE shopify_webhook_id LIKE ${PREFIX + '%'}`;
  const evIds = ev.map((r) => r.id);
  if (ids.length || evIds.length) await prisma.$executeRaw`DELETE FROM reservation_events WHERE reservation_id = ANY(${ids}::uuid[]) OR webhook_event_id = ANY(${evIds}::uuid[])`;
  if (evIds.length) await prisma.$executeRaw`DELETE FROM webhook_events WHERE id = ANY(${evIds}::uuid[])`;
  if (ids.length) {
    await prisma.$executeRaw`DELETE FROM reservation_items WHERE reservation_id = ANY(${ids}::uuid[])`;
    await prisma.$executeRaw`DELETE FROM reservations WHERE id = ANY(${ids}::uuid[])`;
  }
  await prisma.$executeRaw`DELETE FROM rental_units WHERE code LIKE ${PREFIX + '%'}`;
}

localDescribe('PR #84 + PR #85 juntos: expiração automática → pagamento tardio sem a peça → conflito visível', () => {
  beforeAll(cleanup, 60_000);
  afterAll(async () => {
    await cleanup();
    await prisma.$disconnect();
  }, 60_000);

  test('o agendador expira, outra cliente ocupa a peça, o pagamento chega e o conflito aparece sem confirmar nada', async () => {
    const late = await reservation('pending_payment', { windowElapsed: true });
    await scheduler.runOnce();
    expect(await statusOf(late)).toBe('expired');
    const winner = await reservation('confirmed', { unit: { variantId: late.variantId, unitId: late.unitId } });

    await pay(late);

    expect(await statusOf(late)).toBe('late_payment_conflict');
    expect(await statusOf(winner)).toBe('confirmed');
    expect(await needsAttention(late)).toBe(false); // não vira "nova reserva" no menu
    expect((await admin.listReservations({ status: 'late_payment_conflict' })).map((r) => r.id)).toContain(late.id);
    const detail = await admin.getReservationDetail(late.id);
    expect(detail.shopifyOrderId).not.toBeNull();
    expect(detail.events.map((e) => e.type)).toEqual(expect.arrayContaining(['RESERVATION_EXPIRED', 'LATE_PAYMENT_RECEIVED', 'LATE_PAYMENT_CONFLICT']));

    // o agendador seguinte não toca o conflito nem a reserva paga da vencedora
    await scheduler.runOnce();
    expect(await statusOf(late)).toBe('late_payment_conflict');
    expect(await statusOf(winner)).toBe('confirmed');
  });

  test('com a peça livre, o mesmo pagamento tardio é recuperado e NÃO gera conflito', async () => {
    const late = await reservation('pending_payment', { windowElapsed: true });
    await scheduler.runOnce();
    expect(await statusOf(late)).toBe('expired');
    await pay(late);
    expect(await statusOf(late)).toBe('confirmed');
    expect((await admin.listReservations({ status: 'late_payment_conflict' })).map((r) => r.id)).not.toContain(late.id);
  });
});
