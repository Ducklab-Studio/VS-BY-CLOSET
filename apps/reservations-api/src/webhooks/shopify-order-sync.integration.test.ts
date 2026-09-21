import { createHmac } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import { BadRequestException, UnauthorizedException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { ensureStoreConfig, resolveStoreConfig } from '../holds/store-config';
import { ValePassWebhookService } from '../vale-pass/vale-pass-webhook.service';
import { resolveReservationBindingSecret } from '../checkout/checkout.config';
import { canonicalItemsFingerprint, computeReservationSignature, generateReservationBindingId } from '../reservation-binding';
import { addDays, civilDateToISO } from '../rental-rules/civil-date';
import { ShopifyOrderSyncService } from './shopify-order-sync.service';
import { WebhooksController } from './webhooks.controller';
import { WebhooksService } from './webhooks.service';
import type { ShopifyOrderPayload } from './shopify-order-payload';

process.env.RESERVATION_BINDING_SECRET ??= 'test-reservation-binding-secret-order-sync';

/**
 * Sincronização Shopify → reserva (cancelamento, expiração, arquivamento,
 * exclusão, pago/atualizado). Banco LOCAL isolado (nunca a produção): sem
 * `DATABASE_URL` de loopback com nome de teste, o arquivo inteiro é pulado.
 * Nenhum teste toca a rede — `fetch` é monitorado e não pode ser chamado.
 *
 * O pedido real #1002 nunca é usado como fixture. Uma reserva SENTINELA sintética,
 * que representa esse pedido, fica no banco durante toda a bateria e o último teste
 * prova que nada nela mudou — a localização é sempre pelo `shopifyOrderId`.
 */
const localDatabase = /^postgres(?:ql)?:\/\/[^@]+@(localhost|127\.0\.0\.1)(:\d+)?\/[^/]*(test|audit|operational)/i.test(process.env.DATABASE_URL ?? '');
const localDescribe = localDatabase ? describe : describe.skip;

const prisma = new PrismaService();
const sync = new ShopifyOrderSyncService();
const service = new WebhooksService(prisma, new ValePassWebhookService(), sync);
const PREFIX = `SYNC-${Date.now()}`;
const REAL_ORDER_NAME = '#1002';
const SENTINEL_ORDER_ID = '9000000000001';

let unitCounter = 0;
let orderCounter = 9_100_000_000_000;
let webhookCounter = 0;
let cartCounter = 0;
const nextOrderId = () => String(orderCounter++);
const nextWebhookId = () => `${PREFIX}-wh-${webhookCounter++}`;

interface Fixture {
  id: string;
  orderId: string;
  itemIds: string[];
  variantIds: string[];
  bindingId: string | null;
  pickup: { year: number; month: number; day: number };
  effectiveReturn: { year: number; month: number; day: number };
}

async function createUnit() {
  const code = `${PREFIX}-u${unitCounter++}`;
  const unit = await prisma.rentalUnit.create({
    data: { code, name: 'peça de teste', shopifyVariantId: `${code}-variant`, active: true, reservableOnline: true, countsTowardRentalDuration: true },
  });
  return { id: unit.id, variantId: `${code}-variant` };
}

/** Reserva ONLINE (ou manual) já vinculada a `orderId`, com itens e binding assinável. */
async function createReservation(
  status: string,
  opts: { pieces?: number; orderId?: string | null; source?: 'online' | 'manual_admin'; itemStatuses?: string[]; createdDaysAgo?: number } = {},
): Promise<Fixture> {
  const pieces = opts.pieces ?? 1;
  const orderId = opts.orderId === undefined ? nextOrderId() : opts.orderId;
  const units = [];
  for (let i = 0; i < pieces; i++) units.push(await createUnit());
  const pickup = addDays({ year: 2028, month: 1, day: 1 }, unitCounter * 20);
  const effectiveReturn = addDays(pickup, 2);
  const blockedFrom = addDays(pickup, -3);
  const blockedUntil = addDays(effectiveReturn, 3);
  const bindingId = generateReservationBindingId();
  const source = opts.source ?? 'online';

  const [row] = await prisma.$queryRaw<{ id: string }[]>`
    INSERT INTO reservations (id, status, source, origin_store_id, pickup_date, return_date, checkout_state, shopify_cart_id, shopify_order_id, terms_accepted_at, terms_version, reservation_binding_id, created_at, customer_email)
    VALUES (gen_random_uuid(), ${status}::"reservation_status", ${source}::"reservation_source", ${resolveStoreConfig().id},
      ${civilDateToISO(pickup)}::date, ${civilDateToISO(effectiveReturn)}::date, 'ready'::"checkout_state",
      ${`${PREFIX}-cart-${cartCounter++}`}, ${orderId}, now(), 'test', ${bindingId},
      now() - make_interval(days => ${opts.createdDaysAgo ?? 0}::int), 'antes@example.test')
    RETURNING id
  `;
  const itemIds: string[] = [];
  for (const [index, unit] of units.entries()) {
    const itemStatus = opts.itemStatuses?.[index] ?? status;
    const [item] = await prisma.$queryRaw<{ id: string }[]>`
      INSERT INTO reservation_items (id, reservation_id, rental_unit_id, status, blocked_range)
      VALUES (gen_random_uuid(), ${row.id}::uuid, ${unit.id}::uuid, ${itemStatus}::"reservation_status",
        daterange(${civilDateToISO(blockedFrom)}::date, ${civilDateToISO(blockedUntil)}::date, '[)'))
      RETURNING id
    `;
    itemIds.push(item.id);
  }
  return { id: row.id, orderId: orderId ?? '', itemIds, variantIds: units.map((u) => u.variantId), bindingId, pickup, effectiveReturn };
}

function payload(fixture: Fixture, overrides: Partial<ShopifyOrderPayload> = {}): ShopifyOrderPayload {
  return {
    id: fixture.orderId,
    admin_graphql_api_id: `gid://shopify/Order/${fixture.orderId}`,
    name: `#SYNTH-${fixture.orderId}`,
    financial_status: 'pending',
    line_items: fixture.variantIds.map((variantId) => ({ variant_id: variantId, quantity: 1 })),
    note_attributes: [{ name: 'reservation_id', value: fixture.id }],
    ...overrides,
  };
}

function signedPayload(fixture: Fixture, overrides: Partial<ShopifyOrderPayload> = {}): ShopifyOrderPayload {
  const signature = computeReservationSignature(resolveReservationBindingSecret(), {
    reservationId: fixture.id,
    reservationBindingId: fixture.bindingId as string,
    itemsFingerprint: canonicalItemsFingerprint(fixture.variantIds.map((variantId) => ({ variantId, quantity: 1 }))),
    pickupDate: civilDateToISO(fixture.pickup),
    effectiveReturnDate: civilDateToISO(fixture.effectiveReturn),
  });
  return payload(fixture, {
    note_attributes: [
      { name: 'reservation_id', value: fixture.id },
      { name: 'reservation_binding_id', value: fixture.bindingId as string },
      { name: 'reservation_signature', value: signature },
    ],
    ...overrides,
  });
}

const deliver = (topic: string, body: unknown, webhookId = nextWebhookId()) => service.handleIncoming({ topic, shopifyWebhookId: webhookId, payload: body });
const stamp = (minutes: number) => new Date(Date.UTC(2028, 0, 1, 12, minutes)).toISOString();

async function reservation(id: string) {
  return prisma.reservation.findUniqueOrThrow({ where: { id } });
}
async function itemStatuses(id: string): Promise<string[]> {
  const rows = await prisma.$queryRaw<{ status: string }[]>`SELECT status FROM reservation_items WHERE reservation_id = ${id}::uuid ORDER BY created_at, id`;
  return rows.map((r) => r.status);
}
async function events(id: string, type: string) {
  return prisma.reservationEvent.findMany({ where: { reservationId: id, type }, orderBy: { createdAt: 'asc' } });
}
async function reservationCount(orderId: string): Promise<number> {
  return prisma.reservation.count({ where: { shopifyOrderId: orderId } });
}

async function cleanup() {
  const rows = await prisma.$queryRaw<{ id: string }[]>`
    SELECT DISTINCT ri.reservation_id AS id FROM reservation_items ri
    JOIN rental_units ru ON ru.id = ri.rental_unit_id WHERE ru.code LIKE ${PREFIX + '%'}
  `;
  const reservationIds = rows.map((r) => r.id);
  const webhooks = await prisma.$queryRaw<{ id: string }[]>`SELECT id FROM webhook_events WHERE shopify_webhook_id LIKE ${PREFIX + '%'}`;
  const webhookIds = webhooks.map((r) => r.id);
  if (reservationIds.length || webhookIds.length) {
    await prisma.$executeRaw`DELETE FROM reservation_events WHERE reservation_id = ANY(${reservationIds}::uuid[]) OR webhook_event_id = ANY(${webhookIds}::uuid[])`;
  }
  if (webhookIds.length) await prisma.$executeRaw`DELETE FROM webhook_events WHERE id = ANY(${webhookIds}::uuid[])`;
  if (reservationIds.length) {
    await prisma.$executeRaw`DELETE FROM reservation_items WHERE reservation_id = ANY(${reservationIds}::uuid[])`;
    await prisma.$executeRaw`DELETE FROM reservations WHERE id = ANY(${reservationIds}::uuid[])`;
  }
  await prisma.$executeRaw`DELETE FROM rental_units WHERE code LIKE ${PREFIX + '%'}`;
}

const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(() => {
  throw new Error('rede proibida nos testes de sincronização');
});
let sentinel: Fixture;
let sentinelBefore: { status: string; archivedAt: Date | null; updatedAt: Date; events: number; items: string[] };

async function sentinelState() {
  const row = await reservation(sentinel.id);
  return {
    status: row.status,
    archivedAt: row.archivedAt,
    updatedAt: row.updatedAt,
    events: await prisma.reservationEvent.count({ where: { reservationId: sentinel.id } }),
    items: await itemStatuses(sentinel.id),
  };
}

localDescribe('sincronização Shopify → reserva (PostgreSQL isolado)', () => {
  beforeAll(async () => {
    await cleanup();
    await ensureStoreConfig(prisma, resolveStoreConfig());
    sentinel = await createReservation('confirmed', { orderId: SENTINEL_ORDER_ID });
    sentinelBefore = await sentinelState();
  });
  afterAll(async () => {
    await cleanup();
    await prisma.store.deleteMany({ where: { id: 'order-sync-test.myshopify.com' } });
    await prisma.$disconnect();
  }, 60_000);

  describe('orders/cancelled', () => {
    test('cancela a reserva, libera a peça e audita com origem Shopify', async () => {
      const r = await createReservation('confirmed');
      expect((await deliver('orders/cancelled', payload(r, { cancelled_at: stamp(1) }))).outcome).toBe('processed');

      expect((await reservation(r.id)).status).toBe('cancelled');
      expect(await itemStatuses(r.id)).toEqual(['cancelled']);
      const [audit] = await events(r.id, 'SHOPIFY_ORDER_SYNC');
      expect(audit.detail).toMatchObject({ source: 'SHOPIFY', action: 'cancelled', from: 'confirmed', to: 'cancelled', orderId: r.orderId });
      expect(audit.webhookEventId).not.toBeNull();
    });

    test('webhook duplicado (mesmo id) é ignorado; reprocesso com outro id não repete a mudança', async () => {
      const r = await createReservation('confirmed');
      const webhookId = nextWebhookId();
      await deliver('orders/cancelled', payload(r, { cancelled_at: stamp(1) }), webhookId);
      expect((await deliver('orders/cancelled', payload(r, { cancelled_at: stamp(1) }), webhookId)).outcome).toBe('duplicate');
      await deliver('orders/cancelled', payload(r, { cancelled_at: stamp(1) }));

      expect((await reservation(r.id)).status).toBe('cancelled');
      expect(await events(r.id, 'SHOPIFY_ORDER_SYNC')).toHaveLength(1);
      expect(await reservationCount(r.orderId)).toBe(1);
    });

    test('entregas concorrentes do mesmo pedido: um único cancelamento', async () => {
      const r = await createReservation('confirmed');
      const results = await Promise.all([
        ...Array.from({ length: 4 }, () => deliver('orders/cancelled', payload(r, { cancelled_at: stamp(1) }))),
        deliver('orders/updated', payload(r, { cancelled_at: stamp(1), closed_at: stamp(2), updated_at: stamp(2) })),
      ]);
      expect(results.every((x) => x.outcome === 'processed' || x.outcome === 'duplicate')).toBe(true);
      expect((await reservation(r.id)).status).toBe('cancelled');
      expect(await events(r.id, 'SHOPIFY_ORDER_SYNC')).toHaveLength(2); // cancelled + archived, cada um uma vez
      expect((await events(r.id, 'RESERVATION_ARCHIVED')).length).toBe(1);
    });

    test('peça já recebida (ciclo físico) → problem, sem apagar o progresso da peça', async () => {
      const r = await createReservation('confirmed', { pieces: 2, itemStatuses: ['returned', 'confirmed'] });
      await deliver('orders/cancelled', payload(r, { cancelled_at: stamp(1) }));

      expect((await reservation(r.id)).status).toBe('problem');
      expect((await itemStatuses(r.id)).sort()).toEqual(['problem', 'returned']);
      const [audit] = await events(r.id, 'SHOPIFY_ORDER_SYNC');
      expect(audit.detail).toMatchObject({ action: 'flagged_for_review', to: 'problem' });
    });

    test('reserva retirada (picked_up) → problem, nunca cancelled', async () => {
      const r = await createReservation('picked_up');
      await deliver('orders/cancelled', payload(r, { cancelled_at: stamp(1) }));
      expect((await reservation(r.id)).status).toBe('problem');
    });
  });

  describe('orders/updated', () => {
    test('pagamento falho: aguardando pagamento → expired e libera a peça', async () => {
      const r = await createReservation('pending_payment');
      await deliver('orders/updated', payload(r, { financial_status: 'voided', updated_at: stamp(1) }));

      expect((await reservation(r.id)).status).toBe('expired');
      expect(await itemStatuses(r.id)).toEqual(['expired']);
      const [audit] = await events(r.id, 'SHOPIFY_ORDER_SYNC');
      expect(audit.detail).toMatchObject({ action: 'expired', from: 'pending_payment', to: 'expired', source: 'SHOPIFY' });
    });

    test('pagamento expirado na Shopify também expira; já confirmada vai para revisão', async () => {
      const pending = await createReservation('pending_payment');
      await deliver('orders/updated', payload(pending, { financial_status: 'expired', updated_at: stamp(1) }));
      expect((await reservation(pending.id)).status).toBe('expired');

      const confirmed = await createReservation('confirmed');
      await deliver('orders/updated', payload(confirmed, { financial_status: 'voided', updated_at: stamp(1) }));
      expect((await reservation(confirmed.id)).status).toBe('problem');
    });

    test('pedido arquivado (closed_at) com reserva cancelada → arquiva sem apagar nada', async () => {
      const r = await createReservation('confirmed');
      await deliver('orders/updated', payload(r, { cancelled_at: stamp(1), closed_at: stamp(1), updated_at: stamp(1) }));

      const row = await reservation(r.id);
      expect(row.status).toBe('cancelled');
      expect(row.archivedAt).not.toBeNull();
      expect(row.archivedBy).toBeNull();
      expect(row.archiveReason).toBe('Shopify: pedido arquivado');
      expect(row.shopifyOrderId).toBe(r.orderId);
      expect(await itemStatuses(r.id)).toEqual(['cancelled']);
      const [archived] = await events(r.id, 'RESERVATION_ARCHIVED');
      expect(archived.detail).toMatchObject({ origin: 'shopify_webhook', topic: 'orders/updated', orderId: r.orderId });
    });

    test('pedido arquivado com reserva ainda ativa → NÃO arquiva; registra o motivo', async () => {
      const r = await createReservation('confirmed');
      await deliver('orders/updated', payload(r, { financial_status: 'paid', closed_at: stamp(1), updated_at: stamp(1) }));

      const row = await reservation(r.id);
      expect(row.status).toBe('confirmed');
      expect(row.archivedAt).toBeNull();
      const [skipped] = await events(r.id, 'ORDER_ARCHIVE_SKIPPED');
      expect(skipped.detail).toMatchObject({ status: 'confirmed' });
    });

    test('reserva concluída + pedido arquivado → arquiva; restaurada manualmente não é re-arquivada', async () => {
      const r = await createReservation('completed');
      await deliver('orders/updated', payload(r, { financial_status: 'paid', closed_at: stamp(1), updated_at: stamp(1) }));
      expect((await reservation(r.id)).archivedAt).not.toBeNull();

      await prisma.reservation.update({ where: { id: r.id }, data: { archivedAt: null, archiveReason: null } });
      await prisma.reservationEvent.create({ data: { reservationId: r.id, type: 'RESERVATION_RESTORED', detail: {} } });
      await deliver('orders/updated', payload(r, { financial_status: 'paid', closed_at: stamp(2), updated_at: stamp(2) }));
      expect((await reservation(r.id)).archivedAt).toBeNull();
    });

    test('pedido pago sincroniza estado e cliente sem duplicar a reserva', async () => {
      const r = await createReservation('pending_payment');
      await deliver('orders/updated', payload(r, { financial_status: 'paid', email: 'novo@example.test', updated_at: stamp(1) }));

      const row = await reservation(r.id);
      expect(row.status).toBe('confirmed');
      expect(row.customerEmail).toBe('novo@example.test');
      expect(await reservationCount(r.orderId)).toBe(1);
      const [synced] = await events(r.id, 'ORDER_CUSTOMER_SYNCED');
      expect(synced.detail).toMatchObject({ fields: ['customerEmail'] });
      expect(JSON.stringify(synced.detail)).not.toContain('novo@example.test');

      await deliver('orders/updated', payload(r, { financial_status: 'paid', email: 'novo@example.test', updated_at: stamp(2) }));
      expect(await events(r.id, 'ORDER_CUSTOMER_SYNCED')).toHaveLength(1);
      expect(await events(r.id, 'PAYMENT_CONFIRMED')).toHaveLength(1);
    });

    test('pedido ainda não vinculado é vinculado pela mesma correlação assinada, sem duplicar', async () => {
      const r = await createReservation('pending_payment', { orderId: null });
      const orderId = nextOrderId();
      const fixture = { ...r, orderId };
      await deliver('orders/updated', signedPayload(fixture, { financial_status: 'paid', updated_at: stamp(1) }));
      await deliver('orders/updated', signedPayload(fixture, { financial_status: 'paid', updated_at: stamp(2) }));

      const row = await reservation(r.id);
      expect(row.shopifyOrderId).toBe(orderId);
      expect(row.status).toBe('confirmed');
      expect(await reservationCount(orderId)).toBe(1);
    });

    test('linhas do pedido divergentes das peças → problem (nunca altera itens)', async () => {
      const r = await createReservation('confirmed');
      await deliver('orders/updated', payload(r, { financial_status: 'paid', line_items: [{ variant_id: 'variante-outra', quantity: 1 }], updated_at: stamp(1) }));

      expect((await reservation(r.id)).status).toBe('problem');
      expect(await events(r.id, 'ORDER_ITEMS_DIVERGED')).toHaveLength(1);
    });

    test('entrega fora de ordem (updated_at mais antigo) não desfaz o estado mais novo', async () => {
      const r = await createReservation('pending_payment');
      await deliver('orders/updated', payload(r, { financial_status: 'voided', updated_at: stamp(10) }));
      expect((await reservation(r.id)).status).toBe('expired');

      await deliver('orders/updated', payload(r, { financial_status: 'paid', updated_at: stamp(5) }));
      expect((await reservation(r.id)).status).toBe('expired');
      expect(await events(r.id, 'ORDER_SYNC_STALE')).toHaveLength(1);
    });
  });

  describe('orders/delete', () => {
    test('arquiva a reserva sem hard delete e preserva itens, vínculo e auditoria', async () => {
      const r = await createReservation('confirmed');
      await deliver('orders/updated', payload(r, { financial_status: 'paid', updated_at: stamp(1) }));
      expect((await deliver('orders/delete', { id: r.orderId })).outcome).toBe('processed');

      const row = await reservation(r.id);
      expect(row.status).toBe('cancelled');
      expect(row.archivedAt).not.toBeNull();
      expect(row.archiveReason).toBe('Shopify: pedido excluído');
      expect(row.shopifyOrderId).toBe(r.orderId);
      expect(await itemStatuses(r.id)).toEqual(['cancelled']);
      expect(await prisma.reservationEvent.count({ where: { reservationId: r.id } })).toBeGreaterThan(2);
      expect((await events(r.id, 'ORDER_DELETED'))[0].detail).toMatchObject({ origin: 'shopify_webhook', topic: 'orders/delete' });
    });

    test('duplicado e reprocessado: mesmo resultado, uma única mudança de estado e um único arquivamento', async () => {
      const r = await createReservation('confirmed');
      const webhookId = nextWebhookId();
      await deliver('orders/delete', { id: r.orderId }, webhookId);
      expect((await deliver('orders/delete', { id: r.orderId }, webhookId)).outcome).toBe('duplicate');
      await deliver('orders/delete', { id: r.orderId });

      expect((await reservation(r.id)).status).toBe('cancelled');
      expect(await events(r.id, 'RESERVATION_ARCHIVED')).toHaveLength(1);
      expect((await events(r.id, 'SHOPIFY_ORDER_SYNC')).map((e) => (e.detail as { action: string }).action).sort()).toEqual(['archived', 'cancelled']);
      expect(await prisma.reservation.count({ where: { id: r.id } })).toBe(1);
    });

    test('peça já recebida: vai para revisão e NÃO é arquivada', async () => {
      const r = await createReservation('confirmed', { itemStatuses: ['returned'] });
      await deliver('orders/delete', { id: r.orderId });
      const row = await reservation(r.id);
      expect(row.status).toBe('problem');
      expect(row.archivedAt).toBeNull();
      expect(await events(r.id, 'ORDER_ARCHIVE_SKIPPED')).toHaveLength(1);
    });

    test('pedido desconhecido → ignored, nada é tocado', async () => {
      expect((await deliver('orders/delete', { id: nextOrderId() })).outcome).toBe('ignored');
    });
  });

  describe('reservas manuais e outros pedidos', () => {
    test('nenhum tópico altera reserva manual, mesmo com shopifyOrderId igual', async () => {
      const manual = await createReservation('confirmed', { source: 'manual_admin' });
      const body = payload(manual, { financial_status: 'voided', cancelled_at: stamp(1), closed_at: stamp(1), updated_at: stamp(1) });
      await deliver('orders/updated', body);
      await deliver('orders/cancelled', body);
      await deliver('orders/delete', { id: manual.orderId });
      await deliver('refunds/create', { id: 1, order_id: manual.orderId, transactions: [{ amount: '10.00' }] });

      const row = await reservation(manual.id);
      expect(row.status).toBe('confirmed');
      expect(row.archivedAt).toBeNull();
      expect(await itemStatuses(manual.id)).toEqual(['confirmed']);
      expect(await events(manual.id, 'SHOPIFY_ORDER_SYNC')).toHaveLength(0);
    });

    test('só o pedido correto é afetado', async () => {
      const a = await createReservation('confirmed');
      const b = await createReservation('confirmed');
      await deliver('orders/delete', { id: a.orderId });
      expect((await reservation(b.id)).status).toBe('confirmed');
      expect((await reservation(b.id)).archivedAt).toBeNull();
    });
  });

  describe('autenticação HMAC do endpoint', () => {
    const SECRET = 'segredo-de-teste-order-sync';
    const DOMAIN = 'order-sync-test.myshopify.com';
    const saved = { secret: process.env.SHOPIFY_CLIENT_SECRET, domain: process.env.SHOPIFY_STORE_DOMAIN };
    const controller = new WebhooksController(service);
    const sign = (body: string) => createHmac('sha256', SECRET).update(Buffer.from(body, 'utf8')).digest('base64');

    beforeAll(async () => {
      process.env.SHOPIFY_CLIENT_SECRET = SECRET;
      process.env.SHOPIFY_STORE_DOMAIN = DOMAIN;
      process.env.SHOPIFY_STORE_CURRENCY = 'BRL';
      await ensureStoreConfig(prisma, resolveStoreConfig());
    });
    afterAll(() => {
      delete process.env.SHOPIFY_STORE_CURRENCY;
      if (saved.secret === undefined) delete process.env.SHOPIFY_CLIENT_SECRET; else process.env.SHOPIFY_CLIENT_SECRET = saved.secret;
      if (saved.domain === undefined) delete process.env.SHOPIFY_STORE_DOMAIN; else process.env.SHOPIFY_STORE_DOMAIN = saved.domain;
    });

    test.each(['orders/updated', 'orders/delete'])('%s com assinatura inválida ou sem corpo cru → 401, nada muda', async (topic) => {
      const r = await createReservation('confirmed');
      const body = JSON.stringify({ id: r.orderId });
      await expect(controller.receive({ rawBody: Buffer.from(body) }, sign(body + 'x'), topic, nextWebhookId(), DOMAIN)).rejects.toBeInstanceOf(UnauthorizedException);
      await expect(controller.receive({}, sign(body), topic, nextWebhookId(), DOMAIN)).rejects.toBeInstanceOf(UnauthorizedException);
      expect((await reservation(r.id)).status).toBe('confirmed');
    });

    test('assinatura válida de OUTRA loja é recusada; de loja correta é processada', async () => {
      const r = await createReservation('confirmed');
      const body = JSON.stringify({ id: r.orderId });
      await expect(controller.receive({ rawBody: Buffer.from(body) }, sign(body), 'orders/delete', nextWebhookId(), 'outra-loja.myshopify.com')).rejects.toBeInstanceOf(UnauthorizedException);
      expect((await reservation(r.id)).archivedAt).toBeNull();

      await expect(controller.receive({ rawBody: Buffer.from(body) }, sign(body), 'orders/delete', nextWebhookId(), DOMAIN)).resolves.toEqual({ ok: true });
      expect((await reservation(r.id)).archivedAt).not.toBeNull();
    });

    test('corpo assinado mas malformado → 400', async () => {
      const body = '{nao-json';
      await expect(controller.receive({ rawBody: Buffer.from(body) }, sign(body), 'orders/delete', nextWebhookId(), DOMAIN)).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe('proteção do pedido real #1002', () => {
    test('nenhuma fixture usa o nome do pedido real e nenhuma chamada de rede foi feita', async () => {
      expect(REAL_ORDER_NAME).toBe('#1002');
      const rows = await prisma.webhookEvent.findMany({ where: { shopifyWebhookId: { startsWith: PREFIX } }, select: { payload: true } });
      expect(rows.length).toBeGreaterThan(10);
      expect(rows.some((row) => (row.payload as { name?: string } | null)?.name === REAL_ORDER_NAME)).toBe(false);
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    test('o pedido sentinela #1002 permaneceu idêntico após toda a bateria', async () => {
      expect(await sentinelState()).toEqual(sentinelBefore);
      expect(await prisma.webhookEvent.count({ where: { orderId: SENTINEL_ORDER_ID } })).toBe(0);
    });
  });
});
