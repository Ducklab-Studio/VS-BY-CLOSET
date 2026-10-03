import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import type { ValePassCampaign } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { ensureStoreConfig, resolveStoreConfig } from '../holds/store-config';
import { addDays, civilDateToISO } from '../rental-rules/civil-date';
import { RentalRuleConfigService } from '../rental-rule-config/rental-rule-config.service';
import { AdminReservationsService } from '../admin-reservations/admin-reservations.service';
import type { ShopifyAdminClient, ShopifyOrderState, ShopifyOrderWithLines } from '../admin-panel/shopify-admin.client';
import { ShopifyReconciliationService } from '../shopify-reconciliation/shopify-reconciliation.service';
import { ValePassWebhookService } from '../vale-pass/vale-pass-webhook.service';
import { ValePassOrdersService } from '../vale-pass/vale-pass-orders.service';
import { SHOPIFY_DELETED_ARCHIVE_REASON, ShopifyOrderSyncService } from './shopify-order-sync.service';
import { WebhooksService } from './webhooks.service';
import type { ShopifyOrderPayload } from './shopify-order-payload';

/**
 * Exclusão de pedido na Shopify → ClosetAdmin (aluguel e Valle Pass). Banco de
 * TESTE e Shopify FALSA: nenhuma chamada de rede, nenhum pedido real. Ids,
 * códigos e nomes são exclusivos desta bateria; a limpeza só apaga o que tem o
 * prefixo dela.
 */
const prisma = new PrismaService();
const sync = new ShopifyOrderSyncService();
const valePassWebhook = new ValePassWebhookService();
const webhooks = new WebhooksService(prisma, valePassWebhook, sync);
const reservations = new AdminReservationsService(prisma, new RentalRuleConfigService(prisma));

const SUFFIX = Date.now();
const PREFIX = `DEL-${SUFFIX}`;
let unitCounter = 0;
let cartCounter = 0;
let webhookCounter = 0;
let orderCounter = 9_400_000_000_000 + (SUFFIX % 1_000_000) * 100;
let variantCounter = 7_000_000 + (SUFFIX % 1_000_000);
const nextOrderId = () => String(orderCounter++);
const nextWebhookId = () => `${PREFIX}-wh-${webhookCounter++}`;
const T0 = Date.now() - 3_600_000;
const at = (minute: number) => new Date(T0 + minute * 60_000).toISOString();

class FakeShopify {
  readonly states = new Map<string, ShopifyOrderState | null>();
  readonly withLines = new Map<string, ShopifyOrderWithLines | null>();
  listedWithLines: ShopifyOrderWithLines[] = [];
  async getOrdersByGid(gids: readonly string[]) {
    return new Map(gids.map((gid) => [gid, this.states.get(gid) ?? null] as const));
  }
  async listOrdersCreatedSince() {
    return { orders: [] as ShopifyOrderState[], truncated: false };
  }
  async listOrdersWithLinesUpdatedSince() {
    return { orders: this.listedWithLines, truncated: false };
  }
  async getOrdersWithLinesByGid(gids: readonly string[]) {
    return new Map(gids.map((gid) => [gid, this.withLines.get(gid) ?? null] as const));
  }
}
const fake = new FakeShopify();
const reconciliation = new ShopifyReconciliationService(prisma, fake as unknown as ShopifyAdminClient, sync);
const valePassOrders = new ValePassOrdersService(prisma, fake as unknown as ShopifyAdminClient, valePassWebhook);
const gid = (orderId: string) => `gid://shopify/Order/${orderId}`;

const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(() => {
  throw new Error('rede proibida nos testes de exclusão');
});

interface Fixture {
  readonly id: string;
  readonly orderId: string;
  readonly variantIds: string[];
}

/** Reserva ONLINE já vinculada ao pedido `orderId` (ou manual), com itens no mesmo status. */
async function createReservation(status: string, opts: { pieces?: number; source?: 'online' | 'manual_admin'; createdDaysAgo?: number } = {}): Promise<Fixture> {
  const orderId = nextOrderId();
  const units: { id: string; variantId: string }[] = [];
  for (let i = 0; i < (opts.pieces ?? 1); i++) {
    const code = `${PREFIX}-u${unitCounter++}`;
    const unit = await prisma.rentalUnit.create({
      data: { code, name: 'peça de teste', shopifyVariantId: `${code}-v`, active: true, reservableOnline: true, countsTowardRentalDuration: true },
    });
    units.push({ id: unit.id, variantId: `${code}-v` });
  }
  const pickup = addDays({ year: 2030, month: 1, day: 1 }, unitCounter * 20);
  const [row] = await prisma.$queryRaw<{ id: string }[]>`
    INSERT INTO reservations (id, status, source, origin_store_id, pickup_date, return_date, checkout_state, shopify_cart_id, shopify_order_id, terms_accepted_at, terms_version, created_at, customer_name, customer_phone)
    VALUES (gen_random_uuid(), ${status}::"reservation_status", ${opts.source ?? 'online'}::"reservation_source", ${resolveStoreConfig().id},
      ${civilDateToISO(pickup)}::date, ${civilDateToISO(addDays(pickup, 2))}::date, 'ready'::"checkout_state",
      ${`${PREFIX}-cart-${cartCounter++}`}, ${orderId}, now(), 'test', now() - make_interval(days => ${opts.createdDaysAgo ?? 0}::int),
      'Cliente Sintética', '+5500000000000')
    RETURNING id
  `;
  for (const unit of units) {
    await prisma.$executeRaw`
      INSERT INTO reservation_items (id, reservation_id, rental_unit_id, status, blocked_range)
      VALUES (gen_random_uuid(), ${row.id}::uuid, ${unit.id}::uuid, ${status}::"reservation_status",
        daterange(${civilDateToISO(addDays(pickup, -3))}::date, ${civilDateToISO(addDays(pickup, 5))}::date, '[)'))
    `;
  }
  return { id: row.id, orderId, variantIds: units.map((u) => u.variantId) };
}

function rentalPayload(fixture: Fixture, overrides: Partial<ShopifyOrderPayload> = {}): ShopifyOrderPayload {
  return {
    id: fixture.orderId,
    admin_graphql_api_id: gid(fixture.orderId),
    name: `${PREFIX}#${fixture.orderId}`,
    financial_status: 'paid',
    line_items: fixture.variantIds.map((variantId) => ({ variant_id: variantId, quantity: 1 })),
    note_attributes: [{ name: 'reservation_id', value: fixture.id }],
    ...overrides,
  };
}

let campaign: ValePassCampaign;
function valePassPayload(orderId: string, opts: { updated: number; financial?: string; created?: number }): ShopifyOrderPayload {
  return {
    id: Number(orderId),
    admin_graphql_api_id: gid(orderId),
    name: `${PREFIX}#${orderId}`,
    financial_status: opts.financial ?? 'pending',
    created_at: at(opts.created ?? 0),
    updated_at: at(opts.updated),
    cancelled_at: null,
    line_items: [{ variant_id: Number(campaign.shopifyVariantId), product_id: 1, quantity: 1 }],
    email: 'cliente@teste.com',
    customer: { first_name: 'Cliente', last_name: 'Teste', phone: '+5587900000000' },
  };
}
function valePassShopifyOrder(orderId: string, opts: { updated: number; financial?: string; created?: number }): ShopifyOrderWithLines {
  return {
    gid: gid(orderId),
    orderId,
    name: `${PREFIX}#${orderId}`,
    createdAt: at(opts.created ?? 0),
    updatedAt: at(opts.updated),
    cancelledAt: null,
    cancelReason: null,
    financialStatus: opts.financial ?? 'pending',
    lines: [{ variantId: campaign.shopifyVariantId, productId: '1', quantity: 1 }],
  };
}

const deliver = (topic: string, body: unknown, shopifyWebhookId = nextWebhookId()) => webhooks.handleIncoming({ topic, shopifyWebhookId, payload: body });
const reservation = (id: string) => prisma.reservation.findUniqueOrThrow({ where: { id } });
const events = (id: string, type?: string) => prisma.reservationEvent.findMany({ where: { reservationId: id, ...(type ? { type } : {}) }, orderBy: { createdAt: 'asc' } });
const actions = async (id: string) => (await events(id, 'SHOPIFY_ORDER_SYNC')).map((e) => (e.detail as { action: string }).action).sort();
const itemStatuses = async (id: string) =>
  (await prisma.$queryRaw<{ status: string }[]>`SELECT status::text AS status FROM reservation_items WHERE reservation_id = ${id}::uuid ORDER BY id`).map((r) => r.status);
const OCCUPYING = ['hold', 'pending_payment', 'confirmed', 'preparing', 'ready_for_pickup', 'picked_up', 'returned', 'cleaning', 'problem'];
const occupies = async (id: string) => (await itemStatuses(id)).some((s) => OCCUPYING.includes(s));
const code = (id: string) => id.replace(/-/g, '').slice(0, 8);
/** A mesma consulta da tela "Reservas", restrita a esta reserva pelo código. */
const listed = (id: string, extra: { includeArchived?: boolean; shopifyDeletedOnly?: boolean } = {}) =>
  reservations.listReservations({ code: code(id), ...extra }).then((rows) => rows.filter((r) => r.id === id));
const valePassRow = (orderId: string) => prisma.valePassOrder.findUnique({ where: { shopifyOrderId: orderId } });
const valePassHistory = async (orderId: string) =>
  (await prisma.valePassOrderEvent.findMany({ where: { order: { shopifyOrderId: orderId } }, orderBy: { createdAt: 'asc' } })).map((e) => e.type);
const vouchersOf = (orderId: string) => prisma.valePass.findMany({ where: { shopifyOrderId: orderId } });

/** Tudo que a bateria criou — no fim, nada disto pode ter sumido. */
const createdReservations: string[] = [];
const createdValePassOrders: string[] = [];
async function track(fixture: Promise<Fixture>): Promise<Fixture> {
  const f = await fixture;
  createdReservations.push(f.id);
  return f;
}

async function cleanup() {
  const rows = await prisma.$queryRaw<{ id: string }[]>`
    SELECT DISTINCT ri.reservation_id AS id FROM reservation_items ri JOIN rental_units ru ON ru.id = ri.rental_unit_id WHERE ru.code LIKE ${PREFIX + '%'}
  `;
  const ids = rows.map((r) => r.id);
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

  const orders = await prisma.valePassOrder.findMany({ where: { shopifyOrderName: { startsWith: PREFIX } }, select: { id: true, shopifyOrderId: true } });
  if (orders.length) {
    await prisma.valePassOrderEvent.deleteMany({ where: { valePassOrderId: { in: orders.map((o) => o.id) } } });
    await prisma.valePassOrder.deleteMany({ where: { id: { in: orders.map((o) => o.id) } } });
    await prisma.valePassOrderCancellation.deleteMany({ where: { shopifyOrderId: { in: orders.map((o) => o.shopifyOrderId) } } });
  }
  const passes = await prisma.valePass.findMany({ where: { campaign: { name: `Campanha ${PREFIX}` } }, select: { id: true } });
  if (passes.length) {
    await prisma.valePassEvent.deleteMany({ where: { valePassId: { in: passes.map((p) => p.id) } } });
    await prisma.valePass.deleteMany({ where: { id: { in: passes.map((p) => p.id) } } });
  }
  await prisma.valePassCampaign.deleteMany({ where: { name: `Campanha ${PREFIX}` } });
}

beforeAll(async () => {
  await cleanup();
  await ensureStoreConfig(prisma, resolveStoreConfig());
  campaign = await prisma.valePassCampaign.create({
    data: { name: `Campanha ${PREFIX}`, amountCents: 15000, validityDays: 90, shopifyVariantId: String(variantCounter++), active: true },
  });
});

afterAll(async () => {
  await cleanup();
  await prisma.$disconnect();
}, 60_000);

describe('orders/delete — aluguel', () => {
  test('pedido excluído sai da lista ativa e continua no histórico, com vínculo, itens e eventos', async () => {
    const r = await track(createReservation('pending_payment'));
    expect(await listed(r.id)).toHaveLength(1);

    expect((await deliver('orders/delete', { id: Number(r.orderId) })).outcome).toBe('processed');

    const row = await reservation(r.id);
    expect(row).toMatchObject({ status: 'cancelled', shopifyOrderId: r.orderId, archiveReason: SHOPIFY_DELETED_ARCHIVE_REASON });
    expect(row.archivedAt).not.toBeNull();
    expect(row.shopifyOrderDeletedAt).not.toBeNull();
    // Lista ativa (padrão da tela): fora. Histórico ("Mostrar arquivadas" / "Mostrar excluídos da Shopify"): dentro.
    expect(await listed(r.id)).toHaveLength(0);
    const [archived] = await listed(r.id, { includeArchived: true });
    expect(archived.shopifyOrderDeletedAt).not.toBeNull();
    expect(await listed(r.id, { shopifyDeletedOnly: true })).toHaveLength(1);
    expect((await reservations.getReservationDetail(r.id)).archiveReason).toBe('Pedido excluído na Shopify');
    // Não iniciada e sem pagamento: a ocupação é liberada (regra de sempre do cancelamento).
    expect(await itemStatuses(r.id)).toEqual(['cancelled']);
    expect(await events(r.id, 'ORDER_DELETED')).toHaveLength(1);
    expect(await actions(r.id)).toEqual(['archived', 'cancelled', 'deleted_in_shopify']);
  });

  test('reserva terminal (concluída) é só arquivada; status e peças intactos', async () => {
    const r = await track(createReservation('completed'));
    await deliver('orders/delete', { id: r.orderId });
    const row = await reservation(r.id);
    expect(row.status).toBe('completed');
    expect(row.archivedAt).not.toBeNull();
    expect(await itemStatuses(r.id)).toEqual(['completed']);
    expect(await listed(r.id)).toHaveLength(0);
  });

  test('pedido apenas cancelado NÃO é apagado nem escondido: fica na lista com o status cancelado', async () => {
    const r = await track(createReservation('confirmed'));
    await deliver('orders/cancelled', rentalPayload(r, { cancelled_at: at(5), updated_at: at(5) }));
    const row = await reservation(r.id);
    expect(row.status).toBe('cancelled');
    expect(row.archivedAt).toBeNull();
    expect(row.shopifyOrderDeletedAt).toBeNull();
    expect(await listed(r.id)).toHaveLength(1);
    expect(await events(r.id, 'ORDER_DELETED')).toHaveLength(0);
  });

  test('pedido apenas expirado (pagamento expirou) NÃO é apagado nem escondido', async () => {
    const r = await track(createReservation('pending_payment'));
    await deliver('orders/updated', rentalPayload(r, { financial_status: 'expired', updated_at: at(5) }));
    const row = await reservation(r.id);
    expect(row.status).toBe('expired');
    expect(row.archivedAt).toBeNull();
    expect(row.shopifyOrderDeletedAt).toBeNull();
    expect(await listed(r.id)).toHaveLength(1);
  });

  test('pedido PAGO excluído: auditoria completa, vai para revisão, peça NÃO liberada e não some da lista em silêncio', async () => {
    const r = await track(createReservation('confirmed', { pieces: 2 }));
    await deliver('orders/delete', { id: r.orderId });

    const row = await reservation(r.id);
    expect(row.status).toBe('problem');
    expect(row.archivedAt).toBeNull();
    expect(row.shopifyOrderDeletedAt).not.toBeNull();
    expect(await occupies(r.id)).toBe(true);
    expect(await itemStatuses(r.id)).toEqual(['problem', 'problem']);
    const [visible] = await listed(r.id);
    expect(visible.shopifyOrderDeletedAt).not.toBeNull();

    const audits = await events(r.id, 'SHOPIFY_ORDER_SYNC');
    const byAction = (action: string) => audits.find((e) => (e.detail as { action: string }).action === action)?.detail;
    expect(byAction('deleted_in_shopify')).toMatchObject({ source: 'SHOPIFY', origin: 'shopify_webhook', topic: 'orders/delete', orderId: r.orderId, from: 'confirmed' });
    expect(byAction('flagged_for_review')).toMatchObject({ from: 'confirmed', to: 'problem' });
    expect(audits.every((e) => e.webhookEventId)).toBe(true);
    // Auditoria sem dados de cliente.
    expect(JSON.stringify(audits.map((e) => e.detail))).not.toMatch(/Cliente Sintética|\+5500000000000/);
  });

  test('HOLD e reserva já retirada: nenhuma liberação insegura', async () => {
    const hold = await track(createReservation('hold'));
    const pickedUp = await track(createReservation('picked_up'));
    const cleaning = await track(createReservation('cleaning'));
    for (const r of [hold, pickedUp, cleaning]) await deliver('orders/delete', { id: r.orderId });

    expect((await reservation(hold.id)).status).toBe('hold');
    expect(await events(hold.id, 'ORDER_DELETE_NOT_APPLIED')).toHaveLength(1);
    expect((await reservation(pickedUp.id)).status).toBe('problem');
    expect((await reservation(cleaning.id)).status).toBe('problem');
    expect(await itemStatuses(cleaning.id)).toEqual(['cleaning']);
    for (const r of [hold, pickedUp, cleaning]) {
      expect(await occupies(r.id)).toBe(true);
      expect((await reservation(r.id)).archivedAt).toBeNull();
      expect((await reservation(r.id)).shopifyOrderDeletedAt).not.toBeNull();
    }
  });

  test('webhook repetido (mesmo id ou outro id) e duas exclusões simultâneas: uma marcação, nenhum evento duplicado', async () => {
    const r = await track(createReservation('confirmed'));
    const webhookId = nextWebhookId();
    await deliver('orders/delete', { id: r.orderId }, webhookId);
    const first = await reservation(r.id);
    const eventsAfterFirst = (await events(r.id)).length;

    expect((await deliver('orders/delete', { id: r.orderId }, webhookId)).outcome).toBe('duplicate');
    await deliver('orders/delete', { id: r.orderId });
    expect((await events(r.id)).length).toBe(eventsAfterFirst);
    expect((await reservation(r.id)).shopifyOrderDeletedAt).toEqual(first.shopifyOrderDeletedAt);

    const concurrent = await track(createReservation('confirmed'));
    const results = await Promise.all(Array.from({ length: 4 }, () => deliver('orders/delete', { id: concurrent.orderId })));
    expect(results.every((x) => x.outcome === 'processed')).toBe(true);
    expect(await events(concurrent.id, 'ORDER_DELETED')).toHaveLength(1);
    expect(await actions(concurrent.id)).toEqual(['deleted_in_shopify', 'flagged_for_review']);
    expect(await prisma.reservation.count({ where: { shopifyOrderId: concurrent.orderId } })).toBe(1);
  }, 60_000);

  test('webhooks atrasados: exclusão depois de outras atualizações funciona; pago/atualizado depois da exclusão não reabre; cancelado depois encerra e arquiva', async () => {
    // Exclusão chega depois de um orders/updated mais novo: aplica do mesmo jeito.
    const late = await track(createReservation('pending_payment'));
    await deliver('orders/updated', rentalPayload(late, { financial_status: 'pending', updated_at: at(30) }));
    await deliver('orders/delete', { id: late.orderId });
    expect((await reservation(late.id)).status).toBe('cancelled');
    expect((await reservation(late.id)).archivedAt).not.toBeNull();

    // orders/paid e orders/updated pagos entregues depois da exclusão: nada muda.
    const r = await track(createReservation('pending_payment'));
    await deliver('orders/delete', { id: r.orderId });
    const before = await reservation(r.id);
    await deliver('orders/paid', rentalPayload(r, { updated_at: at(40) }));
    await deliver('orders/updated', rentalPayload(r, { updated_at: at(41), email: 'outro@example.test' }));
    const after = await reservation(r.id);
    expect(after.status).toBe('cancelled');
    expect(after.confirmedAt).toBeNull();
    expect(after.customerEmail).toBe(before.customerEmail);
    expect(await events(r.id, 'PAYMENT_CONFIRMED')).toHaveLength(0);
    expect((await events(r.id, 'ORDER_SYNC_STALE')).length).toBeGreaterThanOrEqual(2);

    // Pago excluído (em revisão) e depois o orders/cancelled atrasado: a regra de
    // sempre não libera peça de reserva em revisão — continua ocupando e visível.
    const paid = await track(createReservation('confirmed'));
    await deliver('orders/delete', { id: paid.orderId });
    await deliver('orders/cancelled', rentalPayload(paid, { cancelled_at: at(50), updated_at: at(50) }));
    expect(await reservation(paid.id)).toMatchObject({ status: 'problem', archivedAt: null });
    expect(await occupies(paid.id)).toBe(true);
    expect(await events(paid.id, 'ORDER_CANCELLED')).toHaveLength(1);
    expect(await listed(paid.id)).toHaveLength(1);
    expect(await events(paid.id, 'ORDER_DELETED')).toHaveLength(1);
  }, 60_000);

  test('pedido comum da Shopify (não importado) e reserva manual não são afetados', async () => {
    const before = await Promise.all([prisma.reservation.count(), prisma.valePassOrder.count()]);
    expect((await deliver('orders/delete', { id: Number(nextOrderId()) })).outcome).toBe('ignored');
    expect(await Promise.all([prisma.reservation.count(), prisma.valePassOrder.count()])).toEqual(before);

    const manual = await track(createReservation('confirmed', { source: 'manual_admin' }));
    const other = await track(createReservation('confirmed'));
    await deliver('orders/delete', { id: manual.orderId });
    expect(await reservation(manual.id)).toMatchObject({ status: 'confirmed', archivedAt: null, shopifyOrderDeletedAt: null });
    expect(await reservation(other.id)).toMatchObject({ status: 'confirmed', archivedAt: null, shopifyOrderDeletedAt: null });
  });
});

describe('reconciliação — exclusão com webhook perdido', () => {
  test('aluguel: pedido sumido da Shopify é tratado como o webhook faria, uma vez só', async () => {
    const paid = await track(createReservation('confirmed'));
    const done = await track(createReservation('completed'));
    const present = await track(createReservation('confirmed'));
    fake.states.set(gid(present.orderId), {
      gid: gid(present.orderId), orderId: present.orderId, name: '#SYNTH', createdAt: at(0), updatedAt: at(1), cancelledAt: null, closedAt: null, financialStatus: 'paid', reservationId: present.id,
    });
    const scope = [paid, done, present].map((r) => r.orderId);

    const report = await reconciliation.reconcile({ days: 30, apply: true, deletionsOnly: true, orderIds: scope });

    expect(report.divergences.filter((d) => d.applied).map((d) => d.orderId).sort()).toEqual([paid.orderId, done.orderId].sort());
    expect(await reservation(paid.id)).toMatchObject({ status: 'problem', archivedAt: null });
    expect((await reservation(paid.id)).shopifyOrderDeletedAt).not.toBeNull();
    expect(await occupies(paid.id)).toBe(true);
    expect((await reservation(done.id)).archiveReason).toBe(SHOPIFY_DELETED_ARCHIVE_REASON);
    expect(await reservation(present.id)).toMatchObject({ status: 'confirmed', shopifyOrderDeletedAt: null });
    expect((await events(paid.id, 'SHOPIFY_ORDER_SYNC'))[0].detail).toMatchObject({ origin: 'shopify_reconciliation' });

    // Nova rodada e o webhook atrasado depois dela: nada novo.
    const eventCount = (await events(paid.id)).length;
    const again = await reconciliation.reconcile({ days: 30, apply: true, deletionsOnly: true, orderIds: scope });
    await deliver('orders/delete', { id: paid.orderId });
    expect(again.divergences.filter((d) => d.applied)).toHaveLength(0);
    expect((await events(paid.id)).length).toBe(eventCount);

    // A equipe encerra a reserva em revisão → a próxima rodada só arquiva.
    await prisma.$executeRaw`UPDATE reservations SET status = 'cancelled' WHERE id = ${paid.id}::uuid`;
    const third = await reconciliation.reconcile({ days: 30, apply: true, deletionsOnly: true, orderIds: scope });
    expect(third.divergences.find((d) => d.orderId === paid.orderId)?.applied).toBe(true);
    expect((await reservation(paid.id)).archiveReason).toBe(SHOPIFY_DELETED_ARCHIVE_REASON);
    expect(await events(paid.id, 'ORDER_DELETED')).toHaveLength(1);
  }, 60_000);

  test('aluguel: pedido antigo (fora do alcance de leitura) ou consulta toda vazia nunca vira exclusão', async () => {
    const old = await track(createReservation('confirmed', { createdDaysAgo: 100 }));
    const trio = [await track(createReservation('confirmed')), await track(createReservation('confirmed')), await track(createReservation('confirmed'))];
    await reconciliation.reconcile({ days: 30, apply: true, deletionsOnly: true, orderIds: [old.orderId] });
    await reconciliation.reconcile({ days: 30, apply: true, deletionsOnly: true, orderIds: trio.map((r) => r.orderId) });
    for (const r of [old, ...trio]) expect(await reservation(r.id)).toMatchObject({ status: 'confirmed', shopifyOrderDeletedAt: null, archivedAt: null });
  }, 60_000);
});

describe('Valle Pass', () => {
  test('pendente excluído → Cancelado, fora da lista padrão e do contador; aparece com "Mostrar excluídos"', async () => {
    const id = nextOrderId();
    createdValePassOrders.push(id);
    await deliver('orders/create', valePassPayload(id, { updated: 1 }));
    expect((await valePassOrders.list()).some((o) => o.shopifyOrderId === id)).toBe(true);
    const attentionBefore = (await valePassOrders.attentionCount()).count;

    await deliver('orders/delete', { id: Number(id) });

    expect(await valePassRow(id)).toMatchObject({ status: 'CANCELLED', cancelReason: 'deleted_in_shopify' });
    expect((await valePassOrders.list()).some((o) => o.shopifyOrderId === id)).toBe(false);
    const shown = (await valePassOrders.list({ includeDeleted: true })).find((o) => o.shopifyOrderId === id);
    expect(shown?.deletedInShopifyAt).not.toBeNull();
    expect(shown?.needsAttention).toBe(false);
    expect((await valePassOrders.attentionCount()).count).toBe(attentionBefore - 1);
    expect(await valePassHistory(id)).toEqual(['REGISTERED', 'DELETED_IN_SHOPIFY']);

    // Pagamento atrasado depois da exclusão: nunca confirma nem emite vale.
    await deliver('orders/paid', valePassPayload(id, { updated: 9, financial: 'paid' }));
    await deliver('orders/updated', valePassPayload(id, { updated: 10, financial: 'paid' }));
    expect((await valePassRow(id))?.status).toBe('CANCELLED');
    expect(await vouchersOf(id)).toHaveLength(0);
  }, 45_000);

  test('pago excluído → status e vales mantidos (excluir não é cancelar), auditoria registrada uma vez; repetido/simultâneo não duplica', async () => {
    const id = nextOrderId();
    createdValePassOrders.push(id);
    await deliver('orders/paid', valePassPayload(id, { updated: 2, financial: 'paid' }));
    expect(await vouchersOf(id)).toHaveLength(1);

    await Promise.all(Array.from({ length: 3 }, () => deliver('orders/delete', { id: Number(id) })));
    await deliver('orders/delete', { id: Number(id) });

    const row = await valePassRow(id);
    expect(row?.status).toBe('CONFIRMED');
    expect(row?.deletedInShopifyAt).not.toBeNull();
    expect((await vouchersOf(id)).map((v) => v.status)).toEqual(['ACTIVE']);
    expect(await valePassHistory(id)).toEqual(['REGISTERED', 'VOUCHERS_PROCESSED', 'DELETED_IN_SHOPIFY']);
    const deletedEvents = await prisma.valePassOrderEvent.findMany({ where: { order: { shopifyOrderId: id }, type: 'DELETED_IN_SHOPIFY' } });
    expect(deletedEvents).toHaveLength(1);
    expect(deletedEvents[0].detail).toMatchObject({ status: 'CONFIRMED', paid: true, activeVouchers: 1 });
  }, 45_000);

  test('cancelado e expirado continuam na lista com o status; não são marcados como excluídos', async () => {
    const cancelled = nextOrderId();
    const expired = nextOrderId();
    createdValePassOrders.push(cancelled, expired);
    await deliver('orders/create', valePassPayload(cancelled, { updated: 1 }));
    await deliver('orders/cancelled', { ...valePassPayload(cancelled, { updated: 5 }), cancelled_at: at(5), cancel_reason: 'customer' });
    await deliver('orders/create', valePassPayload(expired, { updated: 1 }));
    await deliver('orders/updated', valePassPayload(expired, { updated: 6, financial: 'expired' }));

    const list = await valePassOrders.list();
    expect(list.find((o) => o.shopifyOrderId === cancelled)).toMatchObject({ status: 'CANCELLED', deletedInShopifyAt: null });
    expect(list.find((o) => o.shopifyOrderId === expired)).toMatchObject({ status: 'EXPIRED', deletedInShopifyAt: null });
  }, 45_000);

  test('reconciliação: pedido recente sumido da Shopify é registrado como excluído; antigo ou consulta toda vazia não', async () => {
    const [gone, present, old] = [nextOrderId(), nextOrderId(), nextOrderId()];
    createdValePassOrders.push(gone, present, old);
    await deliver('orders/create', valePassPayload(gone, { updated: 1 }));
    await deliver('orders/create', valePassPayload(present, { updated: 1 }));
    await deliver('orders/create', valePassPayload(old, { updated: 1, created: -100 * 24 * 60 }));
    fake.listedWithLines = [];
    fake.withLines.set(gid(present), valePassShopifyOrder(present, { updated: 1 }));

    const report = await valePassOrders.reconcile();

    expect(report.failed).toBe(0);
    expect(report.deleted).toBeGreaterThanOrEqual(1);
    expect(await valePassRow(gone)).toMatchObject({ status: 'CANCELLED', lastSyncSource: 'reconciliation' });
    expect((await valePassRow(gone))?.deletedInShopifyAt).not.toBeNull();
    expect(await valePassRow(present)).toMatchObject({ status: 'PENDING', deletedInShopifyAt: null });
    expect(await valePassRow(old)).toMatchObject({ status: 'PENDING', deletedInShopifyAt: null });

    // Segunda rodada: nada registrado de novo.
    await valePassOrders.reconcile();
    expect((await valePassHistory(gone)).filter((t) => t === 'DELETED_IN_SHOPIFY')).toHaveLength(1);

    // Tudo vazio (falha de acesso): ninguém é marcado.
    fake.withLines.clear();
    const trio = [nextOrderId(), nextOrderId(), nextOrderId()];
    createdValePassOrders.push(...trio);
    for (const id of trio) await deliver('orders/create', valePassPayload(id, { updated: 1 }));
    await valePassOrders.reconcile();
    for (const id of [...trio, present]) expect((await valePassRow(id))?.deletedInShopifyAt).toBeNull();
  }, 90_000);
});

describe('integridade', () => {
  test('nenhuma reserva, item, evento ou pedido de Valle Pass foi apagado fisicamente; nenhuma rede usada', async () => {
    expect(await prisma.reservation.count({ where: { id: { in: createdReservations } } })).toBe(createdReservations.length);
    const items = await prisma.reservationItem.count({ where: { reservationId: { in: createdReservations } } });
    expect(items).toBeGreaterThanOrEqual(createdReservations.length);
    expect(await prisma.valePassOrder.count({ where: { shopifyOrderId: { in: createdValePassOrders } } })).toBe(createdValePassOrders.length);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
