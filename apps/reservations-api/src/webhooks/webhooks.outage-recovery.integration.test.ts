import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { ValePassWebhookService } from '../vale-pass/vale-pass-webhook.service';
import { resolveReservationBindingSecret } from '../checkout/checkout.config';
import { canonicalItemsFingerprint, computeReservationSignature, generateReservationBindingId } from '../reservation-binding';
import { addDays, civilDateToISO } from '../rental-rules/civil-date';
import { ShopifyOrderSyncService } from './shopify-order-sync.service';
import type { ShopifyOrderPayload } from './shopify-order-payload';
import { WebhooksService } from './webhooks.service';

process.env.RESERVATION_BINDING_SECRET ??= 'test-reservation-binding-secret-outage';

/**
 * Indisponibilidade da API (Railway fora do ar, banco inacessível, reinício) e
 * recuperação — Postgres de TESTE real, Shopify simulada (nenhuma chamada de rede).
 *
 * O contrato com a Shopify: qualquer falha ao processar responde 5xx (ela
 * reentrega por ~4 h com o MESMO X-Shopify-Webhook-Id); o evento só fica
 * "processed" depois de gravado; reentrega, reinício do processo e eventos
 * fora de ordem nunca duplicam nem desfazem um estado mais novo.
 */
const prisma = new PrismaService();
const service = new WebhooksService(prisma, new ValePassWebhookService(), new ShopifyOrderSyncService());
const PREFIX = `OUT-${Date.now()}`;
let seq = 0;
let orderSeq = 3_000_000;
const webhookId = () => `${PREFIX}-wh-${seq++}`;
const orderId = () => orderSeq++;

interface Fixture {
  reservationId: string;
  variantId: string;
  bindingId: string;
  pickup: ReturnType<typeof addDays>;
  effectiveReturn: ReturnType<typeof addDays>;
}

async function reservation(status: string, daysFromToday: number, paymentExpiresAt: Date | null = null): Promise<Fixture> {
  const code = `${PREFIX}-u${seq++}`;
  const variantId = `${code}-variant`;
  const unit = await prisma.rentalUnit.create({ data: { code, name: 'peça de teste', shopifyVariantId: variantId, active: true, reservableOnline: true, countsTowardRentalDuration: true } });
  const pickup = addDays({ year: 2027, month: 3, day: 1 }, daysFromToday);
  const effectiveReturn = addDays(pickup, 2);
  const bindingId = generateReservationBindingId();
  const rows = await prisma.$queryRaw<{ id: string }[]>`
    INSERT INTO reservations (id, status, origin_store_id, pickup_date, return_date, checkout_state, shopify_cart_id, payment_expires_at, terms_accepted_at, terms_version, reservation_binding_id)
    VALUES (gen_random_uuid(), ${status}::"reservation_status", 'dev-store', ${civilDateToISO(pickup)}::date, ${civilDateToISO(effectiveReturn)}::date,
      'ready'::"checkout_state", ${`${PREFIX}-cart-${seq++}`}, ${paymentExpiresAt}, now(), 'test', ${bindingId})
    RETURNING id`;
  await prisma.$executeRaw`
    INSERT INTO reservation_items (id, reservation_id, rental_unit_id, status, blocked_range)
    VALUES (gen_random_uuid(), ${rows[0].id}::uuid, ${unit.id}::uuid, ${status}::"reservation_status",
      daterange(${civilDateToISO(addDays(pickup, -3))}::date, ${civilDateToISO(addDays(effectiveReturn, 3))}::date, '[)'))`;
  return { reservationId: rows[0].id, variantId, bindingId, pickup, effectiveReturn };
}

/** Pedido como a Shopify entrega: atributos assinados pelo servidor no checkout + linhas iguais às peças. */
function order(f: Fixture, id: number, financialStatus: 'paid' | 'pending' = 'paid'): ShopifyOrderPayload {
  const signature = computeReservationSignature(resolveReservationBindingSecret(), {
    reservationId: f.reservationId,
    reservationBindingId: f.bindingId,
    itemsFingerprint: canonicalItemsFingerprint([{ variantId: f.variantId, quantity: 1 }]),
    pickupDate: civilDateToISO(f.pickup),
    effectiveReturnDate: civilDateToISO(f.effectiveReturn),
  });
  return {
    id,
    admin_graphql_api_id: `gid://shopify/Order/${id}`,
    financial_status: financialStatus,
    note_attributes: [
      { name: 'reservation_id', value: f.reservationId },
      { name: 'reservation_binding_id', value: f.bindingId },
      { name: 'reservation_signature', value: signature },
    ],
    line_items: [{ variant_id: f.variantId, quantity: 1 }],
  };
}

const status = async (f: Fixture) => (await prisma.reservation.findUniqueOrThrow({ where: { id: f.reservationId } })).status;
const eventRow = (id: string) => prisma.webhookEvent.findUnique({ where: { shopifyWebhookId: id } });

async function cleanup() {
  const rows = await prisma.$queryRaw<{ id: string }[]>`
    SELECT DISTINCT ri.reservation_id AS id FROM reservation_items ri JOIN rental_units ru ON ru.id = ri.rental_unit_id WHERE ru.code LIKE ${PREFIX + '%'}`;
  const reservationIds = rows.map((r) => r.id);
  const events = await prisma.$queryRaw<{ id: string }[]>`SELECT id FROM webhook_events WHERE shopify_webhook_id LIKE ${PREFIX + '%'}`;
  const eventIds = events.map((r) => r.id);
  if (reservationIds.length || eventIds.length) {
    await prisma.$executeRaw`DELETE FROM reservation_events WHERE reservation_id = ANY(${reservationIds}::uuid[]) OR webhook_event_id = ANY(${eventIds}::uuid[])`;
  }
  if (eventIds.length) await prisma.$executeRaw`DELETE FROM webhook_events WHERE id = ANY(${eventIds}::uuid[])`;
  if (reservationIds.length) {
    await prisma.$executeRaw`DELETE FROM reservation_items WHERE reservation_id = ANY(${reservationIds}::uuid[])`;
    await prisma.$executeRaw`DELETE FROM reservations WHERE id = ANY(${reservationIds}::uuid[])`;
  }
  await prisma.$executeRaw`DELETE FROM rental_units WHERE code LIKE ${PREFIX + '%'}`;
}

beforeAll(cleanup, 60_000);
afterAll(async () => {
  await cleanup();
  await prisma.$disconnect();
}, 60_000);

describe('falha transitória e reentrega (o que a Shopify faz depois de um 5xx)', () => {
  test('falha ao processar → 503 e evento "failed" (nada confirmado); a reentrega com o MESMO id processa; uma terceira é duplicada', async () => {
    const f = await reservation('pending_payment', 1);
    const id = webhookId();
    const payload = order(f, orderId());

    const secret = process.env.RESERVATION_BINDING_SECRET;
    delete process.env.RESERVATION_BINDING_SECRET; // configuração ausente = falha transitória de ambiente
    try {
      await expect(service.handleIncoming({ topic: 'orders/paid', shopifyWebhookId: id, payload })).rejects.toMatchObject({ status: 503 });
    } finally {
      process.env.RESERVATION_BINDING_SECRET = secret;
    }
    expect(await status(f)).toBe('pending_payment');
    expect((await eventRow(id))?.status).toBe('failed');

    const retry = await service.handleIncoming({ topic: 'orders/paid', shopifyWebhookId: id, payload });
    expect(retry.outcome).toBe('processed');
    expect(await status(f)).toBe('confirmed');
    const done = await eventRow(id);
    expect([done?.status, (done?.attemptCount ?? 0) >= 2]).toEqual(['processed', true]);

    const again = await service.handleIncoming({ topic: 'orders/paid', shopifyWebhookId: id, payload });
    expect(again.outcome).toBe('duplicate');
    expect(await status(f)).toBe('confirmed');
  }, 40_000);

  test('reinício do processo: serviço e conexão NOVOS reconhecem o evento já processado (idempotência está no banco, não na memória)', async () => {
    const f = await reservation('pending_payment', 5);
    const id = webhookId();
    const payload = order(f, orderId());
    expect((await service.handleIncoming({ topic: 'orders/paid', shopifyWebhookId: id, payload })).outcome).toBe('processed');

    const restarted = new PrismaService();
    try {
      const fresh = new WebhooksService(restarted, new ValePassWebhookService(), new ShopifyOrderSyncService());
      expect((await fresh.handleIncoming({ topic: 'orders/paid', shopifyWebhookId: id, payload })).outcome).toBe('duplicate');
      expect(await status(f)).toBe('confirmed');
    } finally {
      await restarted.$disconnect();
    }
  }, 40_000);

  test('banco inacessível DE VERDADE (porta fechada): 503 em tempo curto, para a Shopify reentregar — nunca 200', async () => {
    const broken = new PrismaClient({ datasources: { db: { url: 'postgresql://postgres@127.0.0.1:1/inexistente?connect_timeout=2' } } });
    try {
      const down = new WebhooksService(broken as unknown as PrismaService, new ValePassWebhookService(), new ShopifyOrderSyncService());
      const started = Date.now();
      await expect(down.handleIncoming({ topic: 'orders/paid', shopifyWebhookId: webhookId(), payload: { id: orderId() } })).rejects.toMatchObject({ status: 503 });
      expect(Date.now() - started).toBeLessThan(20_000);
    } finally {
      await broken.$disconnect().catch(() => undefined);
    }
  }, 40_000);
});

describe('eventos fora de ordem depois de uma indisponibilidade', () => {
  test('orders/create (pendente) entregue DEPOIS de orders/paid não desfaz a confirmação', async () => {
    const f = await reservation('pending_payment', 9);
    const id = orderId();
    await service.handleIncoming({ topic: 'orders/paid', shopifyWebhookId: webhookId(), payload: order(f, id) });
    expect(await status(f)).toBe('confirmed');
    const stale = await service.handleIncoming({ topic: 'orders/create', shopifyWebhookId: webhookId(), payload: order(f, id, 'pending') });
    expect(stale.outcome).toBe('processed');
    expect(await status(f)).toBe('confirmed');
  }, 40_000);

  test('pagamento entregue DEPOIS do cancelamento: a reserva cancelada continua cancelada (fail closed, nada liberado nem confirmado)', async () => {
    const f = await reservation('pending_payment', 13);
    const id = orderId();
    await service.handleIncoming({ topic: 'orders/create', shopifyWebhookId: webhookId(), payload: order(f, id, 'pending') });
    await service.handleIncoming({ topic: 'orders/cancelled', shopifyWebhookId: webhookId(), payload: { ...order(f, id, 'pending'), cancelled_at: new Date().toISOString() } });
    expect(await status(f)).toBe('cancelled');
    const late = await service.handleIncoming({ topic: 'orders/paid', shopifyWebhookId: webhookId(), payload: order(f, id) });
    expect(late.outcome).toBe('ignored');
    expect(await status(f)).toBe('cancelled');
  }, 40_000);

  test('pagamento que chega dias depois, com a reserva já expirada e a peça livre: recupera (pagamento tardio) — e uma segunda entrega não repete nada', async () => {
    const f = await reservation('pending_payment', 17, new Date(Date.now() - 6 * 86_400_000));
    const id = orderId();
    const first = await service.handleIncoming({ topic: 'orders/paid', shopifyWebhookId: webhookId(), payload: order(f, id) });
    expect(first.outcome).toBe('processed');
    expect(await status(f)).toBe('confirmed');
    const events = await prisma.$queryRaw<{ n: bigint }[]>`SELECT count(*)::bigint AS n FROM reservation_events WHERE reservation_id = ${f.reservationId}::uuid AND type = 'LATE_PAYMENT_RECEIVED'`;
    expect(Number(events[0].n)).toBe(1);
    await service.handleIncoming({ topic: 'orders/paid', shopifyWebhookId: webhookId(), payload: order(f, id) });
    const events2 = await prisma.$queryRaw<{ n: bigint }[]>`SELECT count(*)::bigint AS n FROM reservation_events WHERE reservation_id = ${f.reservationId}::uuid AND type = 'LATE_PAYMENT_RECEIVED'`;
    expect(Number(events2[0].n)).toBe(1);
    expect(await status(f)).toBe('confirmed');
  }, 40_000);
});

describe('concorrência na reentrega', () => {
  test('a mesma entrega chegando em paralelo (reentrega + retry da Shopify) tem um único efeito', async () => {
    const f = await reservation('pending_payment', 21);
    const id = webhookId();
    const payload = order(f, orderId());
    const results = await Promise.allSettled([
      service.handleIncoming({ topic: 'orders/paid', shopifyWebhookId: id, payload }),
      service.handleIncoming({ topic: 'orders/paid', shopifyWebhookId: id, payload }),
      service.handleIncoming({ topic: 'orders/paid', shopifyWebhookId: id, payload }),
    ]);
    const outcomes = results.map((r) => (r.status === 'fulfilled' ? r.value.outcome : 'erro'));
    expect(outcomes.filter((o) => o === 'processed')).toHaveLength(1);
    expect(outcomes.filter((o) => o === 'duplicate')).toHaveLength(2);
    expect(await status(f)).toBe('confirmed');
  }, 40_000);
});
