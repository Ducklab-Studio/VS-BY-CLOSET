import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { ValidationPipe } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { ensureStoreConfig, resolveStoreConfig } from '../holds/store-config';
import { REQUIRE_MODULE_KEY } from '../admin/require-module.decorator';
import { REQUIRE_ROLE_KEY } from '../admin/require-role.decorator';
import type { ShopifyAdminClient, ShopifyOrderState } from '../admin-panel/shopify-admin.client';
import { ShopifyOrderSyncService } from '../webhooks/shopify-order-sync.service';
import { addDays, civilDateToISO } from '../rental-rules/civil-date';
import { ReconcileShopifyOrdersDto } from './reconcile-shopify-orders.dto';
import { ShopifyReconciliationController } from './shopify-reconciliation.controller';
import { ShopifyReconciliationService } from './shopify-reconciliation.service';

/**
 * Reconciliação por Admin API — banco LOCAL isolado e cliente Shopify FALSO:
 * nenhuma chamada de rede, nenhum pedido real (o #1002 inclusive) é consultado
 * ou alterado. Sem `DATABASE_URL` de loopback com nome de teste, é pulado.
 */
const localDatabase = /^postgres(?:ql)?:\/\/[^@]+@(localhost|127\.0\.0\.1)(:\d+)?\/[^/]*(test|audit|operational)/i.test(process.env.DATABASE_URL ?? '');
const localDescribe = localDatabase ? describe : describe.skip;

const prisma = new PrismaService();
const PREFIX = `RECON-${Date.now()}`;
const ACTOR = { id: '11111111-1111-4111-8111-111111111111', name: 'Admin sintético' };
const SENTINEL_ORDER_ID = '9200000000001';

class FakeShopify {
  readonly states = new Map<string, ShopifyOrderState | null>();
  readonly requested: string[] = [];
  listed: ShopifyOrderState[] = [];
  async getOrdersByGid(gids: readonly string[]) {
    this.requested.push(...gids);
    return new Map(gids.map((gid) => [gid, this.states.get(gid) ?? null] as const));
  }
  async listOrdersCreatedSince() {
    return { orders: this.listed, truncated: false };
  }
}

const fake = new FakeShopify();
const service = new ShopifyReconciliationService(prisma, fake as unknown as ShopifyAdminClient, new ShopifyOrderSyncService());

let unitCounter = 0;
let orderCounter = 9_300_000_000_000;
const nextOrderId = () => String(orderCounter++);

async function createReservation(status: string, opts: { source?: 'online' | 'manual_admin'; createdDaysAgo?: number; orderId?: string } = {}) {
  const orderId = opts.orderId ?? nextOrderId();
  const code = `${PREFIX}-u${unitCounter++}`;
  const unit = await prisma.rentalUnit.create({ data: { code, name: 'peça de teste', shopifyVariantId: `${code}-v`, active: true, reservableOnline: true, countsTowardRentalDuration: true } });
  const pickup = addDays({ year: 2029, month: 1, day: 1 }, unitCounter * 20);
  const [row] = await prisma.$queryRaw<{ id: string }[]>`
    INSERT INTO reservations (id, status, source, origin_store_id, pickup_date, return_date, checkout_state, shopify_cart_id, shopify_order_id, terms_accepted_at, terms_version, created_at)
    VALUES (gen_random_uuid(), ${status}::"reservation_status", ${opts.source ?? 'online'}::"reservation_source", ${resolveStoreConfig().id},
      ${civilDateToISO(pickup)}::date, ${civilDateToISO(addDays(pickup, 2))}::date, 'ready'::"checkout_state",
      ${`${PREFIX}-cart-${unitCounter}`}, ${orderId}, now(), 'test', now() - make_interval(days => ${opts.createdDaysAgo ?? 0}::int))
    RETURNING id
  `;
  await prisma.$executeRaw`
    INSERT INTO reservation_items (id, reservation_id, rental_unit_id, status, blocked_range)
    VALUES (gen_random_uuid(), ${row.id}::uuid, ${unit.id}::uuid, ${status}::"reservation_status",
      daterange(${civilDateToISO(addDays(pickup, -3))}::date, ${civilDateToISO(addDays(pickup, 5))}::date, '[)'))
  `;
  return { id: row.id, orderId };
}

function state(orderId: string, over: Partial<ShopifyOrderState> = {}): ShopifyOrderState {
  return {
    gid: `gid://shopify/Order/${orderId}`,
    orderId,
    name: `#SYNTH-${orderId}`,
    createdAt: '2029-01-01T00:00:00Z',
    updatedAt: '2029-01-02T00:00:00Z',
    cancelledAt: null,
    closedAt: null,
    financialStatus: 'paid',
    reservationId: null,
    ...over,
  };
}
const setState = (orderId: string, over: Partial<ShopifyOrderState> = {}) => fake.states.set(`gid://shopify/Order/${orderId}`, state(orderId, over));

async function reservation(id: string) {
  return prisma.reservation.findUniqueOrThrow({ where: { id } });
}
async function snapshot(ids: string[]) {
  const rows = await Promise.all(ids.map((id) => reservation(id)));
  return rows.map((r) => ({ id: r.id, status: r.status, archivedAt: r.archivedAt }));
}
const kindOf = (report: Awaited<ReturnType<typeof service.reconcile>>, orderId: string) => report.divergences.find((d) => d.orderId === orderId);

async function cleanup() {
  const rows = await prisma.$queryRaw<{ id: string }[]>`
    SELECT DISTINCT ri.reservation_id AS id FROM reservation_items ri JOIN rental_units ru ON ru.id = ri.rental_unit_id WHERE ru.code LIKE ${PREFIX + '%'}
  `;
  const ids = rows.map((r) => r.id);
  if (ids.length) {
    await prisma.$executeRaw`DELETE FROM reservation_events WHERE reservation_id = ANY(${ids}::uuid[])`;
    await prisma.$executeRaw`DELETE FROM reservation_items WHERE reservation_id = ANY(${ids}::uuid[])`;
    await prisma.$executeRaw`DELETE FROM reservations WHERE id = ANY(${ids}::uuid[])`;
  }
  await prisma.$executeRaw`DELETE FROM rental_units WHERE code LIKE ${PREFIX + '%'}`;
}

localDescribe('reconciliação de pedidos Shopify (PostgreSQL isolado, Shopify simulada)', () => {
  beforeAll(async () => {
    await cleanup();
    await ensureStoreConfig(prisma, resolveStoreConfig());
  });
  afterAll(async () => {
    await cleanup();
    await prisma.$disconnect();
  }, 60_000);

  test('relatório encontra pedido inexistente, cancelado, arquivado, com pagamento falho e pago sem confirmação — sem alterar nada', async () => {
    const missing = await createReservation('confirmed');
    const cancelled = await createReservation('confirmed');
    const closed = await createReservation('completed');
    const failed = await createReservation('pending_payment');
    const paid = await createReservation('pending_payment');
    const fine = await createReservation('confirmed');
    setState(cancelled.orderId, { cancelledAt: '2029-01-02T00:00:00Z' });
    setState(closed.orderId, { closedAt: '2029-01-02T00:00:00Z' });
    setState(failed.orderId, { financialStatus: 'voided' });
    setState(paid.orderId, { financialStatus: 'paid' });
    setState(fine.orderId, { closedAt: '2029-01-02T00:00:00Z' }); // fechado + reserva ativa: normal, não é divergência
    const ids = [missing, cancelled, closed, failed, paid, fine];
    const before = await snapshot(ids.map((r) => r.id));

    const report = await service.reconcile({ days: 30, apply: false, orderIds: ids.map((r) => r.orderId) });

    expect(report.mode).toBe('report');
    expect(kindOf(report, missing.orderId)).toMatchObject({ kind: 'missing_in_shopify', action: 'review', applied: false });
    expect(kindOf(report, cancelled.orderId)?.kind).toBe('cancelled_in_shopify');
    expect(kindOf(report, closed.orderId)?.kind).toBe('closed_in_shopify');
    expect(kindOf(report, failed.orderId)?.kind).toBe('payment_failed_in_shopify');
    expect(kindOf(report, paid.orderId)).toMatchObject({ kind: 'paid_in_shopify_not_confirmed', action: 'none' });
    expect(kindOf(report, fine.orderId)).toBeUndefined();
    expect(await snapshot(ids.map((r) => r.id))).toEqual(before);
  });

  test('apply aplica só o subconjunto seguro, audita com origem e ator, e é idempotente', async () => {
    const missing = await createReservation('confirmed');
    const gone = await createReservation('completed');
    const cancelled = await createReservation('confirmed');
    const closed = await createReservation('completed');
    const failed = await createReservation('pending_payment');
    const paid = await createReservation('pending_payment');
    setState(cancelled.orderId, { cancelledAt: '2029-01-02T00:00:00Z' });
    setState(closed.orderId, { closedAt: '2029-01-02T00:00:00Z' });
    setState(failed.orderId, { financialStatus: 'voided' });
    setState(paid.orderId, { financialStatus: 'paid' });
    const scope = [missing, gone, cancelled, closed, failed, paid].map((r) => r.orderId);

    const report = await service.reconcile({ days: 30, apply: true, actor: ACTOR, orderIds: scope });

    expect(report.mode).toBe('apply');
    // pedido inexistente + reserva confirmada: nunca cancela nem libera — vai para revisão
    expect(await snapshot([missing.id])).toEqual([{ id: missing.id, status: 'problem', archivedAt: null }]);
    // pedido inexistente + reserva terminal: só arquiva
    expect((await reservation(gone.id))).toMatchObject({ status: 'completed', archiveReason: 'Shopify: pedido excluído' });
    expect((await reservation(gone.id)).archivedAt).not.toBeNull();
    expect((await reservation(cancelled.id)).status).toBe('cancelled');
    expect((await reservation(closed.id)).archivedAt).not.toBeNull();
    expect((await reservation(failed.id)).status).toBe('expired');
    expect(await snapshot([paid.id])).toEqual([{ id: paid.id, status: 'pending_payment', archivedAt: null }]);
    expect(kindOf(report, paid.orderId)?.applied).toBe(false);
    expect(kindOf(report, missing.orderId)?.applied).toBe(true);

    const audit = await prisma.reservationEvent.findMany({ where: { reservationId: cancelled.id, type: 'SHOPIFY_ORDER_SYNC' } });
    expect(audit).toHaveLength(1);
    expect(audit[0].detail).toMatchObject({ source: 'SHOPIFY', origin: 'shopify_reconciliation', action: 'cancelled', adminUserId: ACTOR.id });
    expect(await prisma.reservation.count({ where: { id: { in: [missing.id, gone.id, cancelled.id, closed.id, failed.id, paid.id] } } })).toBe(6);

    const again = await service.reconcile({ days: 30, apply: true, actor: ACTOR, orderIds: scope });
    expect(again.divergences.filter((d) => d.applied)).toHaveLength(0);
    expect(await prisma.reservationEvent.count({ where: { reservationId: cancelled.id, type: 'SHOPIFY_ORDER_SYNC' } })).toBe(1);
  });

  test('pedido ausente fora da janela de leitura não é tratado como exclusão', async () => {
    const old = await createReservation('confirmed', { createdDaysAgo: 100 });
    const report = await service.reconcile({ days: 30, apply: true, actor: ACTOR, orderIds: [old.orderId] });
    expect(kindOf(report, old.orderId)).toMatchObject({ kind: 'unverifiable_missing', action: 'none', applied: false });
    expect((await reservation(old.id)).status).toBe('confirmed');
  });

  test('se TODOS os pedidos voltam vazios, é tratado como falha de acesso — nada é arquivado', async () => {
    const trio = [await createReservation('confirmed'), await createReservation('confirmed'), await createReservation('confirmed')];
    const report = await service.reconcile({ days: 30, apply: true, actor: ACTOR, orderIds: trio.map((r) => r.orderId) });
    expect(report.divergences.every((d) => d.kind === 'unverifiable_missing' && !d.applied)).toBe(true);
    expect((await snapshot(trio.map((r) => r.id))).every((r) => r.status === 'confirmed' && r.archivedAt === null)).toBe(true);
  });

  test('reserva manual nunca entra na reconciliação, mesmo com shopifyOrderId igual', async () => {
    const manual = await createReservation('confirmed', { source: 'manual_admin' });
    setState(manual.orderId, { cancelledAt: '2029-01-02T00:00:00Z', closedAt: '2029-01-02T00:00:00Z' });
    const report = await service.reconcile({ days: 30, apply: true, actor: ACTOR, orderIds: [manual.orderId] });
    expect(report.divergences).toHaveLength(0);
    expect(await snapshot([manual.id])).toEqual([{ id: manual.id, status: 'confirmed', archivedAt: null }]);
  });

  test('pedido Shopify com reservation_id e sem reserva é só relatado; vinculados e cancelados são ignorados', async () => {
    const linked = await createReservation('confirmed');
    const orphanId = nextOrderId();
    fake.listed = [
      state(orphanId, { reservationId: '22222222-2222-4222-8222-222222222222' }),
      state(linked.orderId, { reservationId: linked.id }),
      state(nextOrderId(), { reservationId: '33333333-3333-4333-8333-333333333333', cancelledAt: '2029-01-02T00:00:00Z' }),
      state(nextOrderId(), { reservationId: null }),
    ];
    const before = await prisma.reservation.count();

    const report = await service.reconcile({ days: 30, apply: false });

    const orphans = report.divergences.filter((d) => d.kind === 'shopify_order_without_reservation');
    expect(orphans.map((d) => d.orderId)).toEqual([orphanId]);
    expect(orphans[0]).toMatchObject({ action: 'none', applied: false });
    expect(await prisma.reservation.count()).toBe(before);
    fake.listed = [];
  });

  test('o pedido sentinela #1002 nunca é consultado nem alterado', async () => {
    const sentinel = await createReservation('confirmed', { orderId: SENTINEL_ORDER_ID });
    const before = await snapshot([sentinel.id]);
    const other = await createReservation('confirmed');
    setState(other.orderId, { cancelledAt: '2029-01-02T00:00:00Z' });
    fake.requested.length = 0;

    await service.reconcile({ days: 30, apply: true, actor: ACTOR, orderIds: [other.orderId] });

    expect(fake.requested).toEqual([`gid://shopify/Order/${other.orderId}`]);
    expect(await snapshot([sentinel.id])).toEqual(before);
    expect(await prisma.reservationEvent.count({ where: { reservationId: sentinel.id } })).toBe(0);
  });

  describe('endpoint administrativo', () => {
    test('exige ADMIN com módulo RESERVATIONS', () => {
      expect(Reflect.getMetadata(REQUIRE_ROLE_KEY, ShopifyReconciliationController)).toBe('ADMIN');
      expect(Reflect.getMetadata(REQUIRE_MODULE_KEY, ShopifyReconciliationController)).toBe('RESERVATIONS');
    });

    test('não aceita dados administrativos vindos do cliente', async () => {
      const pipe = new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true });
      const meta = { type: 'body' as const, metatype: ReconcileShopifyOrdersDto };
      await expect(pipe.transform({ days: 30, adminUserId: '11111111-1111-4111-8111-111111111111' }, meta)).rejects.toThrow();
      await expect(pipe.transform({ orderIds: ['1'] }, meta)).rejects.toThrow();
      await expect(pipe.transform({ days: 999 }, meta)).rejects.toThrow();
      await expect(pipe.transform({ days: 7 }, meta)).resolves.toMatchObject({ days: 7 });
    });
  });
});
