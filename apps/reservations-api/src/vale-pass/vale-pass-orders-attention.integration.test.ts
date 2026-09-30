import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { PrismaService } from '../prisma/prisma.service';
import { WebhooksService } from '../webhooks/webhooks.service';
import { ShopifyOrderSyncService } from '../webhooks/shopify-order-sync.service';
import { lockShopifyOrder } from '../webhooks/shopify-order-lock';
import type { ShopifyAdminClient } from '../admin-panel/shopify-admin.client';
import { REQUIRE_MODULE_KEY } from '../admin/require-module.decorator';
import { REQUIRE_ROLE_KEY } from '../admin/require-role.decorator';
import { KNOWN_VALE_PASS_PRODUCT_ID } from './vale-pass-order-status';
import type { ValePassOrderSnapshot } from './vale-pass-order-registry';
import { ValePassWebhookService } from './vale-pass-webhook.service';
import { ValePassOrdersService } from './vale-pass-orders.service';
import { ValePassOrdersController } from './vale-pass-orders.controller';
import { MarkValePassOrdersViewedDto } from './dto/mark-vale-pass-orders-viewed.dto';

/**
 * Contador do Valle Pass no menu ("pedidos para ver") — banco de teste,
 * nenhuma chamada à Shopify. Os pedidos entram pelo registro/webhooks reais,
 * mas pelo PRODUTO do Valle Pass numa variante sem campanha: nenhum vale é
 * emitido (o contador nunca cria vale, reserva ou HOLD).
 */
const prisma = new PrismaService();
const valePass = new ValePassWebhookService();
const webhooks = new WebhooksService(prisma, valePass, new ShopifyOrderSyncService());
const service = new ValePassOrdersService(prisma, {} as ShopifyAdminClient, valePass);
const ACTOR = { id: '22222222-2222-4222-8222-222222222222', name: 'Operador sintético' };
const OTHER = { id: '33333333-3333-4333-8333-333333333333', name: 'Outra aba' };

const SUFFIX = Date.now();
const TAG = `VP-ATT-${SUFFIX}`;
let orderCounter = 4_000_000_000 + (SUFFIX % 1_000_000) * 100;
let webhookCounter = 0;
const T0 = Date.now() - 3_600_000;
const at = (minute: number) => new Date(T0 + minute * 60_000);
const nextOrderId = () => String(orderCounter++);
const VARIANT = String(9_900_000 + (SUFFIX % 100_000));

function snapshot(id: string, financialStatus: string, minute: number, cancel?: string): ValePassOrderSnapshot {
  return {
    orderId: id,
    orderGid: `gid://shopify/Order/${id}`,
    orderName: `${TAG}#${id}`,
    financialStatus,
    cancelledAt: cancel ? at(minute).toISOString() : null,
    cancelReason: cancel ?? null,
    createdAt: at(0),
    updatedAt: at(minute),
    quantity: 1,
    customerName: null,
    customerPhone: null,
    customerEmail: null,
  };
}

/** Mesmo caminho do webhook/reconciliação: lock do pedido + registro. */
const register = (id: string, financialStatus: string, minute: number, cancel?: string) =>
  prisma.$transaction(async (tx) => {
    await lockShopifyOrder(tx, id);
    return (await valePass.orders.apply(tx, snapshot(id, financialStatus, minute, cancel), 'test')).order;
  });

const webhookOrder = (id: string, productId: string, financialStatus = 'pending') => ({
  id: Number(id),
  admin_graphql_api_id: `gid://shopify/Order/${id}`,
  name: `${TAG}#${id}`,
  financial_status: financialStatus,
  updated_at: at(1).toISOString(),
  line_items: [{ variant_id: Number(VARIANT), product_id: Number(productId), quantity: 1 }],
});

const count = async () => (await service.attentionCount()).count;
const shown = (order: { id: string; statusChangedAt: Date }) => ({ id: order.id, statusChangedAt: order.statusChangedAt.toISOString() });

async function cleanup() {
  const orders = await prisma.valePassOrder.findMany({ where: { shopifyOrderName: { startsWith: 'VP-ATT-' } }, select: { id: true } });
  if (orders.length) {
    await prisma.valePassOrderEvent.deleteMany({ where: { valePassOrderId: { in: orders.map((o) => o.id) } } });
    await prisma.valePassOrder.deleteMany({ where: { id: { in: orders.map((o) => o.id) } } });
  }
  await prisma.$executeRaw`DELETE FROM reservation_events WHERE webhook_event_id IN (SELECT id FROM webhook_events WHERE shopify_webhook_id LIKE 'VP-ATT-%')`;
  await prisma.$executeRaw`DELETE FROM webhook_events WHERE shopify_webhook_id LIKE 'VP-ATT-%'`;
}

beforeAll(cleanup);
afterAll(async () => {
  await cleanup();
  await prisma.$disconnect();
});

describe('Contador do Valle Pass (pedidos para ver)', () => {
  test('pendente e pago contam; vários pedidos somam; expirado, cancelado, recusado e reembolsado não contam', async () => {
    const base = await count();
    await register(nextOrderId(), 'pending', 1);
    expect(await count()).toBe(base + 1);
    await register(nextOrderId(), 'paid', 1);
    await register(nextOrderId(), 'pending', 1);
    expect(await count()).toBe(base + 3);

    await register(nextOrderId(), 'expired', 1);
    await register(nextOrderId(), 'pending', 1, 'customer');
    await register(nextOrderId(), 'voided', 1, 'declined');
    await register(nextOrderId(), 'refunded', 1);
    expect(await count()).toBe(base + 3);

    // Pendente que expira sai da contagem sem ninguém ver.
    const expiring = nextOrderId();
    await register(expiring, 'pending', 1);
    expect(await count()).toBe(base + 4);
    await register(expiring, 'expired', 9);
    expect(await count()).toBe(base + 3);
  }, 45_000);

  test('pedido comum da Shopify não conta; webhook repetido não duplica; nenhum vale é criado', async () => {
    const base = await count();
    const common = nextOrderId();
    await webhooks.handleIncoming({ topic: 'orders/create', shopifyWebhookId: `${TAG}-wh-${webhookCounter++}`, payload: webhookOrder(common, '424242') });
    expect(await count()).toBe(base);

    const id = nextOrderId();
    const webhookId = `${TAG}-wh-${webhookCounter++}`;
    const body = webhookOrder(id, KNOWN_VALE_PASS_PRODUCT_ID);
    expect((await webhooks.handleIncoming({ topic: 'orders/create', shopifyWebhookId: webhookId, payload: body })).outcome).toBe('processed');
    expect((await webhooks.handleIncoming({ topic: 'orders/create', shopifyWebhookId: webhookId, payload: body })).outcome).toBe('duplicate');
    await webhooks.handleIncoming({ topic: 'orders/create', shopifyWebhookId: `${TAG}-wh-${webhookCounter++}`, payload: body });
    await webhooks.handleIncoming({ topic: 'orders/updated', shopifyWebhookId: `${TAG}-wh-${webhookCounter++}`, payload: body });
    expect(await count()).toBe(base + 1);
    expect(await prisma.valePass.count({ where: { shopifyOrderId: { in: [common, id] } } })).toBe(0);
  }, 45_000);

  test('abrir o Valle Pass marca como visto: sai da contagem sem mudar status, pagamento ou vale', async () => {
    const pending = await register(nextOrderId(), 'pending', 1);
    const paid = await register(nextOrderId(), 'paid', 1);
    const base = await count();

    const listed = (await service.list()).filter((o) => o.id === pending.id || o.id === paid.id);
    expect(listed.map((o) => o.needsAttention)).toEqual([true, true]);

    expect(await service.markViewed([shown(pending), shown(paid)], ACTOR)).toEqual({ marked: 2 });
    expect(await count()).toBe(base - 2);

    for (const before of [pending, paid]) {
      const after = await prisma.valePassOrder.findUniqueOrThrow({ where: { id: before.id } });
      expect([after.status, after.financialStatus, after.statusChangedAt.getTime(), after.vouchersProcessedAt, after.viewedBy]).toEqual([
        before.status,
        before.financialStatus,
        before.statusChangedAt.getTime(),
        before.vouchersProcessedAt,
        ACTOR.id,
      ]);
    }
    expect(await prisma.valePass.count({ where: { shopifyOrderId: { in: [pending.shopifyOrderId, paid.shopifyOrderId] } } })).toBe(0);
    const events = await prisma.valePassOrderEvent.findMany({ where: { valePassOrderId: pending.id, type: 'VIEWED' } });
    expect(events).toHaveLength(1);
    expect(events[0].detail).toMatchObject({ adminUserId: ACTOR.id });
    expect((await service.list()).find((o) => o.id === pending.id)?.needsAttention).toBe(false);

    // Marcar de novo não grava nada.
    expect(await service.markViewed([shown(pending)], ACTOR)).toEqual({ marked: 0 });
  }, 45_000);

  test('pendente visto que é pago depois volta a contar; tela com status antigo não esconde o pagamento', async () => {
    const id = nextOrderId();
    const pending = await register(id, 'pending', 1);
    await service.markViewed([shown(pending)], ACTOR);
    const base = await count();

    const paid = await register(id, 'paid', 5);
    expect(paid.status).toBe('CONFIRMED');
    expect(await count()).toBe(base + 1);

    // A tela ainda mostrava o pedido pendente (statusChangedAt antigo): não marca o pago.
    expect(await service.markViewed([shown(pending)], ACTOR)).toEqual({ marked: 0 });
    expect(await count()).toBe(base + 1);
    expect(await service.markViewed([shown(paid)], ACTOR)).toEqual({ marked: 1 });
    expect(await count()).toBe(base);
  }, 45_000);

  test('duas abas marcando ao mesmo tempo: um único registro de visto, contagem consistente', async () => {
    const order = await register(nextOrderId(), 'pending', 1);
    const base = await count();
    const [a, b] = await Promise.all([service.markViewed([shown(order)], ACTOR), service.markViewed([shown(order)], OTHER)]);
    expect(a.marked + b.marked).toBe(1);
    expect(await prisma.valePassOrderEvent.count({ where: { valePassOrderId: order.id, type: 'VIEWED' } })).toBe(1);
    expect(await count()).toBe(base - 1);
  }, 45_000);

  test('acesso: só o módulo VALLE_PASS vê o contador e marca visto (qualquer papel com o módulo)', () => {
    expect(Reflect.getMetadata(REQUIRE_MODULE_KEY, ValePassOrdersController)).toBe('VALLE_PASS');
    expect(Reflect.getMetadata(REQUIRE_ROLE_KEY, ValePassOrdersController.prototype.attention)).toBeUndefined();
    expect(Reflect.getMetadata(REQUIRE_ROLE_KEY, ValePassOrdersController.prototype.markViewed)).toBeUndefined();
  });

  test('corpo de "marcar visto": só ids e datas válidos, sem campos extras, no máximo 300', async () => {
    const check = (body: unknown) => validate(plainToInstance(MarkValePassOrdersViewedDto, body), { whitelist: true, forbidNonWhitelisted: true });
    const valid = { id: '44444444-4444-4444-8444-444444444444', statusChangedAt: '2026-09-29T10:00:00.000Z' };
    expect(await check({ orders: [valid] })).toHaveLength(0);
    expect(await check({ orders: [{ ...valid, id: 'x' }] })).not.toHaveLength(0);
    expect(await check({ orders: [{ ...valid, statusChangedAt: 'ontem' }] })).not.toHaveLength(0);
    expect(await check({ orders: [{ ...valid, status: 'CONFIRMED' }] })).not.toHaveLength(0);
    expect(await check({ orders: [valid], adminUserId: ACTOR.id })).not.toHaveLength(0);
    expect(await check({ orders: Array.from({ length: 301 }, () => valid) })).not.toHaveLength(0);
  });
});
