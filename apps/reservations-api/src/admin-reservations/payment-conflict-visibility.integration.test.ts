import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { Prisma } from '@prisma/client';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { PrismaService } from '../prisma/prisma.service';
import { RentalRuleConfigService } from '../rental-rule-config/rental-rule-config.service';
import { ValePassWebhookService } from '../vale-pass/vale-pass-webhook.service';
import { ShopifyOrderSyncService } from '../webhooks/shopify-order-sync.service';
import { WebhooksService } from '../webhooks/webhooks.service';
import type { ShopifyOrderPayload } from '../webhooks/shopify-order-payload';
import { resolveReservationBindingSecret } from '../checkout/checkout.config';
import { canonicalItemsFingerprint, computeReservationSignature, generateReservationBindingId } from '../reservation-binding';
import { addDays, civilDateToISO } from '../rental-rules/civil-date';
import { AdminReservationsService } from './admin-reservations.service';
import { reservationAttentionSql } from './reservation-attention';
import { ListReservationsQueryDto } from './dto/list-reservations-query.dto';

process.env.RESERVATION_BINDING_SECRET ??= 'test-reservation-binding-secret-conflict';

// Suíte de escrita: nunca roda contra banco hospedado, mesmo se chamada sozinha.
const localDatabase = /^postgres(?:ql)?:\/\/[^@]+@(localhost|127\.0\.0\.1)(:\d+)?\/[^/]*(test|audit|operational)/i.test(process.env.DATABASE_URL ?? '');
const localDescribe = localDatabase ? describe : describe.skip;

const prisma = new PrismaService();
const admin = new AdminReservationsService(prisma, new RentalRuleConfigService(prisma));
const webhooks = new WebhooksService(prisma, new ValePassWebhookService(), new ShopifyOrderSyncService());
const PREFIX = `PCV-${Date.now()}`;
let seq = 0;
let orderSeq = 6_000_000;

interface Flow { id: string; variantId: string; unitId: string; bindingId: string; pickup: ReturnType<typeof addDays> }

/** Reserva ONLINE vinculada a uma peça (checkout pronto). */
async function reservation(status: string, unit?: { variantId: string; unitId: string }, shiftDays = 0): Promise<Flow> {
  const code = `${PREFIX}-u${seq++}`;
  const variantId = unit?.variantId ?? code;
  const unitId = unit?.unitId ?? (await prisma.rentalUnit.create({ data: { code, name: 'peça de teste', shopifyVariantId: variantId, active: true, reservableOnline: true, countsTowardRentalDuration: true } })).id;
  const pickup = addDays({ year: 2028, month: 5, day: 1 }, shiftDays);
  const bindingId = generateReservationBindingId();
  const rows = await prisma.$queryRaw<{ id: string }[]>`
    INSERT INTO reservations (id, status, origin_store_id, pickup_date, return_date, checkout_state, shopify_cart_id, payment_expires_at, terms_accepted_at, terms_version, reservation_binding_id, customer_name, customer_email)
    VALUES (gen_random_uuid(), ${status}::"reservation_status", 'dev-store', ${civilDateToISO(pickup)}::date, ${civilDateToISO(addDays(pickup, 2))}::date,
      'ready'::"checkout_state", ${`${PREFIX}-cart-${seq++}`}, now() + interval '1 hour', now(), 'test', ${bindingId}, 'Cliente Sintética', 'sintetica@example.invalid')
    RETURNING id`;
  await prisma.$executeRaw`
    INSERT INTO reservation_items (id, reservation_id, rental_unit_id, status, blocked_range)
    VALUES (gen_random_uuid(), ${rows[0].id}::uuid, ${unitId}::uuid, ${status}::"reservation_status", daterange(${civilDateToISO(addDays(pickup, -3))}::date, ${civilDateToISO(addDays(pickup, 5))}::date, '[)'))`;
  return { id: rows[0].id, variantId, unitId, bindingId, pickup };
}

function paid(f: Flow, id: number, at = '2030-09-01T10:00:00Z'): ShopifyOrderPayload {
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
    updated_at: at,
    email: 'sintetica@example.invalid',
    note_attributes: [
      { name: 'reservation_id', value: f.id },
      { name: 'reservation_binding_id', value: f.bindingId },
      { name: 'reservation_signature', value: signature },
    ],
    line_items: [{ variant_id: f.variantId, quantity: 1 }],
  };
}

const send = (payload: ShopifyOrderPayload, id = `${PREFIX}-wh-${seq++}`) => webhooks.handleIncoming({ topic: 'orders/paid', shopifyWebhookId: id, payload });
const statusOf = async (f: Flow) => (await prisma.reservation.findUniqueOrThrow({ where: { id: f.id } })).status;
const needsAttention = async (f: Flow) => (await prisma.$queryRaw<{ needs: boolean }[]>(Prisma.sql`SELECT ${reservationAttentionSql('r')} AS needs FROM reservations r WHERE r.id = ${f.id}::uuid`))[0].needs;

/** Expira a reserva, outra cliente ocupa a MESMA peça no mesmo período, e então o pagamento chega. */
async function conflict() {
  const late = await reservation('pending_payment');
  const orderId = orderSeq++;
  await prisma.$executeRaw`UPDATE reservations SET status = 'expired' WHERE id = ${late.id}::uuid`;
  const winner = await reservation('confirmed', { variantId: late.variantId, unitId: late.unitId });
  await send(paid(late, orderId));
  return { late, winner, orderId };
}

async function cleanup() {
  const rows = await prisma.$queryRaw<{ id: string }[]>`
    SELECT DISTINCT ri.reservation_id AS id FROM reservation_items ri JOIN rental_units ru ON ru.id = ri.rental_unit_id WHERE ru.code LIKE ${PREFIX + '%'}`;
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

localDescribe('pagamento recebido com conflito de disponibilidade — visibilidade (PostgreSQL isolado)', () => {
  beforeAll(cleanup, 60_000);
  afterAll(async () => {
    await cleanup();
    await prisma.$disconnect();
  }, 60_000);

  test('o pagamento tardio sem a peça vira late_payment_conflict e preserva o vínculo com o pedido', async () => {
    const { late, winner, orderId } = await conflict();
    expect(await statusOf(late)).toBe('late_payment_conflict');
    expect(await statusOf(winner)).toBe('confirmed');
    const row = await prisma.reservation.findUniqueOrThrow({ where: { id: late.id } });
    expect(row.shopifyOrderId).toBe(String(orderId)); // rastreável até o pedido Shopify
    expect(row.confirmedAt).toBeNull(); // nunca confirmada
  });

  test('NÃO entra no contador de novas reservas (e a confirmada vencedora continua sendo a única ocupante)', async () => {
    const { late, winner } = await conflict();
    expect(await needsAttention(late)).toBe(false);
    expect(await needsAttention(winner)).toBe(false); // criada direto como confirmed sem pedido: não é "nova"
    const occupants = await prisma.$queryRaw<{ reservation_id: string }[]>`
      SELECT reservation_id::text FROM reservation_items WHERE rental_unit_id = ${late.unitId}::uuid AND status::text <> ALL(${['expired', 'cancelled', 'late_payment_conflict']}::text[])`;
    expect(occupants.map((o) => o.reservation_id)).toEqual([winner.id]);
  });

  test('a lista filtra só os conflitos, sem misturar reservas normais nem "problem"', async () => {
    const { late } = await conflict();
    const normal = await reservation('confirmed');
    const review = await reservation('problem');
    const ids = (await admin.listReservations({ status: 'late_payment_conflict', limit: 300 })).map((r) => r.id);
    expect(ids).toContain(late.id);
    expect(ids).not.toContain(normal.id);
    expect(ids).not.toContain(review.id);
    const problemIds = (await admin.listReservations({ status: 'problem', limit: 300 })).map((r) => r.id);
    expect(problemIds).toContain(review.id);
    expect(problemIds).not.toContain(late.id);
    const row = (await admin.listReservations({ status: 'late_payment_conflict', limit: 300 })).find((r) => r.id === late.id)!;
    expect(row.status).toBe('late_payment_conflict');
    expect(row.shopifyOrderId).not.toBeNull();
  });

  test('um conflito ANTIGO continua na consulta filtrada mesmo com mais de 300 reservas mais novas (a lista geral corta em 300)', async () => {
    const { late } = await conflict();
    // 305 reservas mais novas, só para empurrar o conflito para fora da lista geral (sem itens: não ocupam peça)
    await prisma.$executeRaw`
      INSERT INTO reservations (id, status, origin_store_id, pickup_date, return_date, checkout_state, terms_accepted_at, terms_version, created_at)
      SELECT gen_random_uuid(), 'cancelled'::"reservation_status", 'dev-store', '2028-07-01'::date, '2028-07-03'::date, 'none'::"checkout_state", now(), ${PREFIX}, now() + (g || ' seconds')::interval
      FROM generate_series(1, 305) g`;
    try {
      const general = (await admin.listReservations({})).map((r) => r.id);
      expect(general.length).toBe(300);
      expect(general).not.toContain(late.id); // o corte de 300 esconde o conflito na lista geral
      const filtered = (await admin.listReservations({ status: 'late_payment_conflict' })).map((r) => r.id);
      expect(filtered).toContain(late.id); // a consulta filtrada (usada pelos contadores) não perde o conflito
    } finally {
      await prisma.$executeRaw`DELETE FROM reservations WHERE terms_version = ${PREFIX}`;
    }
  });

  test('o filtro da API aceita o status e continua recusando status inválido', async () => {
    const ok = plainToInstance(ListReservationsQueryDto, { status: 'late_payment_conflict' });
    expect(await validate(ok)).toHaveLength(0);
    const bad = plainToInstance(ListReservationsQueryDto, { status: 'pago_sem_peca' });
    expect((await validate(bad)).length).toBeGreaterThan(0);
  });

  test('o detalhe traz os eventos LATE_PAYMENT_RECEIVED e LATE_PAYMENT_CONFLICT, com o motivo e sem dados pessoais', async () => {
    const { late, orderId } = await conflict();
    const detail = await admin.getReservationDetail(late.id);
    expect(detail.status).toBe('late_payment_conflict');
    expect(detail.shopifyOrderId).toBe(String(orderId));
    const received = detail.events.find((e) => e.type === 'LATE_PAYMENT_RECEIVED');
    const conflictEvent = detail.events.find((e) => e.type === 'LATE_PAYMENT_CONFLICT');
    expect(received).toBeDefined();
    expect(conflictEvent).toBeDefined();
    expect((conflictEvent!.detail as { reason: string }).reason).toMatch(/comprometida|conflito|ocupad/i);
    const logged = JSON.stringify([received, conflictEvent]);
    expect(logged).not.toMatch(/sintetica@example|Cliente Sintética|@|\+55/);
    // preserva a trilha completa (nada foi apagado)
    expect(detail.events.some((e) => e.type === 'PAYMENT_CONFIRMED')).toBe(false);
  });

  test('NADA é automático: reentrega, expiração e novas leituras não confirmam, cancelam nem liberam', async () => {
    const { late, winner, orderId } = await conflict();
    const before = await prisma.reservation.findUniqueOrThrow({ where: { id: late.id } });
    // mesma entrega repetida, evento mais antigo e uma leitura da lista/detalhe
    await send(paid(late, orderId, '2030-08-01T10:00:00Z'));
    await send(paid(late, orderId, '2030-09-02T10:00:00Z'));
    await admin.getReservationDetail(late.id);
    await admin.listReservations({ status: 'late_payment_conflict', limit: 300 });
    const after = await prisma.reservation.findUniqueOrThrow({ where: { id: late.id } });
    expect(after.status).toBe('late_payment_conflict');
    expect(after.confirmedAt).toBeNull();
    expect(after.shopifyOrderId).toBe(before.shopifyOrderId);
    expect(await statusOf(winner)).toBe('confirmed');
    // a peça segue com a vencedora; o conflito não ocupa nada (não bloqueia a unidade)
    const items = await prisma.$queryRaw<{ status: string }[]>`SELECT status::text FROM reservation_items WHERE reservation_id = ${late.id}::uuid`;
    expect(items.every((i) => i.status === 'late_payment_conflict')).toBe(true);
  });

  test('reservas normais seguem sem regressão: confirmada, aguardando pagamento e expirada não viram conflito', async () => {
    const confirmed = await reservation('confirmed');
    const pending = await reservation('pending_payment');
    const expired = await reservation('expired');
    expect(await statusOf(confirmed)).toBe('confirmed');
    expect(await statusOf(pending)).toBe('pending_payment');
    const ids = (await admin.listReservations({ status: 'late_payment_conflict', limit: 300 })).map((r) => r.id);
    for (const f of [confirmed, pending, expired]) expect(ids).not.toContain(f.id);
    // pagamento tardio com a peça LIVRE continua sendo recuperado, não vira conflito
    await send(paid(expired, orderSeq++));
    expect(await statusOf(expired)).toBe('confirmed');
  });
});
