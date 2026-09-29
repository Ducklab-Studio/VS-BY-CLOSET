import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import type { ValePassCampaign } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { WebhooksService } from '../webhooks/webhooks.service';
import { ShopifyOrderSyncService } from '../webhooks/shopify-order-sync.service';
import type { ShopifyOrderPayload } from '../webhooks/shopify-order-payload';
import type { ShopifyAdminClient, ShopifyOrderWithLines } from '../admin-panel/shopify-admin.client';
import { REQUIRE_MODULE_KEY } from '../admin/require-module.decorator';
import { REQUIRE_ROLE_KEY } from '../admin/require-role.decorator';
import { KNOWN_VALE_PASS_PRODUCT_ID } from './vale-pass-order-status';
import { ValePassWebhookService } from './vale-pass-webhook.service';
import { ValePassOrdersService } from './vale-pass-orders.service';
import { ValePassOrdersController } from './vale-pass-orders.controller';

/**
 * Pedidos de Valle Pass no ClosetAdmin — webhooks REAIS (WebhooksService
 * inteiro, mesma transação/lock de produção) e reconciliação com uma Shopify
 * FALSA (nenhuma chamada de rede). Nenhum pedido real é consultado ou
 * alterado: ids, nomes e campanha são exclusivos desta bateria, e a limpeza
 * só apaga o que tem o prefixo dela, no banco de teste.
 */
const prisma = new PrismaService();
const webhooks = new WebhooksService(prisma, new ValePassWebhookService(), new ShopifyOrderSyncService());

const SUFFIX = Date.now();
const TAG = `VP-ORD-${SUFFIX}`;
let orderCounter = 3_000_000_000 + (SUFFIX % 1_000_000) * 100;
let variantCounter = 8_000_000 + (SUFFIX % 1_000_000);
let webhookCounter = 0;
const T0 = Date.now() - 3_600_000;

const at = (minute: number) => new Date(T0 + minute * 60_000).toISOString();
const nextOrderId = () => String(orderCounter++);
const nextWebhookId = () => `${TAG}-wh-${webhookCounter++}`;

class FakeShopify {
  listed: ShopifyOrderWithLines[] = [];
  readonly byGid = new Map<string, ShopifyOrderWithLines | null>();
  listCalls = 0;
  async listOrdersWithLinesUpdatedSince() {
    this.listCalls++;
    await new Promise((resolve) => setTimeout(resolve, 20));
    return { orders: this.listed, truncated: false };
  }
  async getOrdersWithLinesByGid(gids: readonly string[]) {
    return new Map(gids.map((gid) => [gid, this.byGid.get(gid) ?? null] as const));
  }
}

const fake = new FakeShopify();
const newService = () => new ValePassOrdersService(prisma, fake as unknown as ShopifyAdminClient, new ValePassWebhookService());
const service = newService();

let campaign: ValePassCampaign;

interface OrderOpts {
  readonly variantId?: string;
  readonly productId?: string;
  readonly quantity?: number;
  readonly financial?: string;
  readonly updated: number;
  readonly created?: number;
  readonly cancelledAt?: number;
  readonly cancelReason?: string;
}

function payload(id: string, opts: OrderOpts): ShopifyOrderPayload {
  return {
    id: Number(id),
    admin_graphql_api_id: `gid://shopify/Order/${id}`,
    name: `${TAG}#${id}`,
    financial_status: opts.financial ?? 'pending',
    created_at: at(opts.created ?? 0),
    updated_at: at(opts.updated),
    cancelled_at: opts.cancelledAt === undefined ? null : at(opts.cancelledAt),
    cancel_reason: opts.cancelReason ?? null,
    line_items: [{ variant_id: Number(opts.variantId ?? campaign.shopifyVariantId), product_id: opts.productId ? Number(opts.productId) : 1, quantity: opts.quantity ?? 1 }],
    email: 'cliente@teste.com',
    customer: { first_name: 'Cliente', last_name: 'Teste', phone: '+5587900000000' },
  };
}

function shopifyOrder(id: string, opts: OrderOpts): ShopifyOrderWithLines {
  return {
    gid: `gid://shopify/Order/${id}`,
    orderId: id,
    name: `${TAG}#${id}`,
    createdAt: at(opts.created ?? 0),
    updatedAt: at(opts.updated),
    cancelledAt: opts.cancelledAt === undefined ? null : at(opts.cancelledAt),
    cancelReason: opts.cancelReason ?? null,
    financialStatus: opts.financial ?? 'pending',
    lines: [{ variantId: opts.variantId ?? campaign.shopifyVariantId, productId: opts.productId ?? '1', quantity: opts.quantity ?? 1 }],
  };
}

const send = (topic: string, body: unknown, shopifyWebhookId = nextWebhookId()) => webhooks.handleIncoming({ topic, shopifyWebhookId, payload: body });
const row = (id: string) => prisma.valePassOrder.findUnique({ where: { shopifyOrderId: id } });
const rowCount = (id: string) => prisma.valePassOrder.count({ where: { shopifyOrderId: id } });
const vouchersOf = (id: string) => prisma.valePass.findMany({ where: { shopifyOrderId: id }, orderBy: { createdAt: 'asc' } });
const historyOf = async (id: string) =>
  (await prisma.valePassOrderEvent.findMany({ where: { order: { shopifyOrderId: id } }, orderBy: { createdAt: 'asc' } })).map((e) => e.type);
const rentalFootprint = async () => {
  const [reservations, items, holdKeys] = await Promise.all([prisma.reservation.count(), prisma.reservationItem.count(), prisma.holdIdempotencyKey.count()]);
  return { reservations, items, holdKeys };
};

async function cleanup() {
  const orders = await prisma.valePassOrder.findMany({ where: { shopifyOrderName: { startsWith: 'VP-ORD-' } }, select: { id: true, shopifyOrderId: true } });
  const orderIds = orders.map((o) => o.shopifyOrderId);
  if (orders.length) {
    await prisma.valePassOrderEvent.deleteMany({ where: { valePassOrderId: { in: orders.map((o) => o.id) } } });
    await prisma.valePassOrder.deleteMany({ where: { id: { in: orders.map((o) => o.id) } } });
    await prisma.valePassOrderCancellation.deleteMany({ where: { shopifyOrderId: { in: orderIds } } });
  }
  const passes = await prisma.valePass.findMany({ where: { campaign: { name: { startsWith: 'Campanha VP-ORD-' } } }, select: { id: true } });
  if (passes.length) {
    await prisma.valePassEvent.deleteMany({ where: { valePassId: { in: passes.map((p) => p.id) } } });
    await prisma.valePass.deleteMany({ where: { id: { in: passes.map((p) => p.id) } } });
  }
  await prisma.valePassCampaign.deleteMany({ where: { name: { startsWith: 'Campanha VP-ORD-' } } });
  await prisma.$executeRaw`DELETE FROM reservation_events WHERE webhook_event_id IN (SELECT id FROM webhook_events WHERE shopify_webhook_id LIKE 'VP-ORD-%')`;
  await prisma.$executeRaw`DELETE FROM webhook_events WHERE shopify_webhook_id LIKE 'VP-ORD-%'`;
}

beforeAll(async () => {
  await cleanup();
  campaign = await prisma.valePassCampaign.create({
    data: { name: `Campanha ${TAG}`, amountCents: 15000, validityDays: 90, shopifyVariantId: String(variantCounter++), active: true },
  });
});

afterAll(async () => {
  await cleanup();
  await prisma.$disconnect();
});

describe('Pedidos de Valle Pass — webhooks', () => {
  test('pedido futuro criado e pendente → aparece como Pendente, sem vale e sem ocupar estoque (nenhuma reserva/HOLD)', async () => {
    const before = await rentalFootprint();
    const id = nextOrderId();

    const result = await send('orders/create', payload(id, { updated: 1 }));

    expect(result.outcome).toBe('processed'); // antes: `ignored` — o pedido sumia
    expect(await row(id)).toMatchObject({ status: 'PENDING', financialStatus: 'pending', quantity: 1, customerName: 'Cliente Teste', customerPhone: '+5587900000000', shopifyOrderName: `${TAG}#${id}` });
    expect(await vouchersOf(id)).toHaveLength(0);
    const listed = (await service.list()).find((o) => o.shopifyOrderId === id);
    expect(listed).toMatchObject({ status: 'PENDING', vouchers: [] });
    expect(await rentalFootprint()).toEqual(before);
    expect(await historyOf(id)).toEqual(['REGISTERED']);
  }, 30_000);

  test('pedido futuro pago → muda para Confirmada e emite o vale uma única vez', async () => {
    const id = nextOrderId();
    await send('orders/create', payload(id, { updated: 1 }));
    await send('orders/paid', payload(id, { updated: 2, financial: 'paid' }));

    const confirmed = await row(id);
    expect(confirmed).toMatchObject({ status: 'CONFIRMED', financialStatus: 'paid' });
    expect(confirmed?.vouchersProcessedAt).not.toBeNull();
    const vouchers = await vouchersOf(id);
    expect(vouchers).toHaveLength(1);
    expect(vouchers[0].status).toBe('ACTIVE');
    expect((await service.list({ status: 'CONFIRMED' })).find((o) => o.shopifyOrderId === id)?.vouchers).toEqual([{ code: vouchers[0].code, status: 'ACTIVE' }]);
    expect(await historyOf(id)).toEqual(['REGISTERED', 'STATUS_CHANGED', 'VOUCHERS_PROCESSED']);
  }, 30_000);

  test('pedido que expira sem pagamento (caso do #1006) → Expirada, sem vale, e continua no histórico', async () => {
    const id = nextOrderId();
    await send('orders/create', payload(id, { updated: 1 }));
    await send('orders/updated', payload(id, { updated: 30, financial: 'expired', cancelledAt: 30, cancelReason: 'other' }));

    expect(await row(id)).toMatchObject({ status: 'EXPIRED', financialStatus: 'expired' });
    expect(await vouchersOf(id)).toHaveLength(0);
    // Reentrega atrasada do orders/create não "ressuscita" o pedido.
    await send('orders/create', payload(id, { updated: 1 }));
    expect((await row(id))?.status).toBe('EXPIRED');

    const expired = await service.list({ status: 'EXPIRED' });
    expect(expired.map((o) => o.shopifyOrderId)).toContain(id);
    expect(await historyOf(id)).toEqual(['REGISTERED', 'STATUS_CHANGED']);
  }, 30_000);

  test('pedido cancelado → Cancelada; pagamento recusado → Recusada; cancelado depois de pago cancela o vale', async () => {
    const cancelled = nextOrderId();
    await send('orders/create', payload(cancelled, { updated: 1 }));
    await send('orders/cancelled', payload(cancelled, { updated: 5, cancelledAt: 5, cancelReason: 'customer' }));
    expect(await row(cancelled)).toMatchObject({ status: 'CANCELLED', cancelReason: 'customer' });

    const declined = nextOrderId();
    await send('orders/create', payload(declined, { updated: 1 }));
    await send('orders/updated', payload(declined, { updated: 5, financial: 'voided', cancelledAt: 5, cancelReason: 'declined' }));
    expect(await row(declined)).toMatchObject({ status: 'DECLINED', cancelReason: 'declined' });

    const paidThenCancelled = nextOrderId();
    await send('orders/paid', payload(paidThenCancelled, { updated: 2, financial: 'paid' }));
    await send('orders/cancelled', payload(paidThenCancelled, { updated: 9, financial: 'refunded', cancelledAt: 9, cancelReason: 'customer' }));
    expect((await row(paidThenCancelled))?.status).toBe('CANCELLED');
    expect((await vouchersOf(paidThenCancelled)).map((v) => v.status)).toEqual(['CANCELLED']);

    for (const id of [cancelled, declined]) expect(await vouchersOf(id)).toHaveLength(0);
  }, 45_000);

  test('pagamento aprovado depois do webhook de criação, sem orders/paid → orders/updated confirma e emite; o orders/paid atrasado não duplica', async () => {
    const id = nextOrderId();
    await send('orders/create', payload(id, { updated: 1 }));
    await send('orders/updated', payload(id, { updated: 3, financial: 'paid' }));

    expect((await row(id))?.status).toBe('CONFIRMED');
    expect(await vouchersOf(id)).toHaveLength(1);

    await send('orders/paid', payload(id, { updated: 2, financial: 'paid' }));
    expect((await row(id))?.status).toBe('CONFIRMED');
    expect(await vouchersOf(id)).toHaveLength(1);
  }, 30_000);

  test('webhook repetido (mesmo id, ou mesmo conteúdo com outro id) → uma linha e um vale', async () => {
    const id = nextOrderId();
    const webhookId = nextWebhookId();
    const body = payload(id, { updated: 2, financial: 'paid' });

    expect((await send('orders/paid', body, webhookId)).outcome).toBe('processed');
    expect((await send('orders/paid', body, webhookId)).outcome).toBe('duplicate');
    await send('orders/paid', body);
    await send('orders/create', payload(id, { updated: 2, financial: 'paid' }));

    expect(await rowCount(id)).toBe(1);
    expect(await vouchersOf(id)).toHaveLength(1);
  }, 30_000);

  test('webhooks fora de ordem: pago antes da criação; cancelado/expirado antes do pago atrasado → nunca fica confirmado nem com vale ativo', async () => {
    const paidFirst = nextOrderId();
    await send('orders/paid', payload(paidFirst, { updated: 2, financial: 'paid' }));
    await send('orders/create', payload(paidFirst, { updated: 1 }));
    expect((await row(paidFirst))?.status).toBe('CONFIRMED');
    expect(await vouchersOf(paidFirst)).toHaveLength(1);

    const cancelledFirst = nextOrderId();
    await send('orders/create', payload(cancelledFirst, { updated: 1 }));
    await send('orders/cancelled', payload(cancelledFirst, { updated: 9, cancelledAt: 9, cancelReason: 'customer' }));
    await send('orders/paid', payload(cancelledFirst, { updated: 5, financial: 'paid' }));
    expect((await row(cancelledFirst))?.status).toBe('CANCELLED');
    expect((await vouchersOf(cancelledFirst)).filter((v) => v.status === 'ACTIVE')).toHaveLength(0);

    const expiredFirst = nextOrderId();
    await send('orders/create', payload(expiredFirst, { updated: 1 }));
    await send('orders/updated', payload(expiredFirst, { updated: 9, financial: 'expired' }));
    await send('orders/paid', payload(expiredFirst, { updated: 5, financial: 'paid' }));
    expect((await row(expiredFirst))?.status).toBe('EXPIRED');
    expect(await vouchersOf(expiredFirst)).toHaveLength(0);
  }, 60_000);

  test('webhooks simultâneos do mesmo pedido (create, paid, updated) → nenhum pedido duplicado, um vale', async () => {
    const id = nextOrderId();
    const results = await Promise.allSettled([
      send('orders/create', payload(id, { updated: 1 })),
      send('orders/paid', payload(id, { updated: 2, financial: 'paid' })),
      send('orders/updated', payload(id, { updated: 3, financial: 'paid' })),
    ]);

    expect(results.every((r) => r.status === 'fulfilled')).toBe(true);
    expect(await rowCount(id)).toBe(1);
    expect((await row(id))?.status).toBe('CONFIRMED');
    expect(await vouchersOf(id)).toHaveLength(1);
  }, 45_000);

  test('pedido excluído na Shopify e reembolso: linha e histórico preservados', async () => {
    const deleted = nextOrderId();
    await send('orders/create', payload(deleted, { updated: 1 }));
    await send('orders/delete', { id: Number(deleted) });
    const gone = await row(deleted);
    expect(gone).toMatchObject({ status: 'CANCELLED', cancelReason: 'deleted_in_shopify' });
    expect(gone?.deletedInShopifyAt).not.toBeNull();
    expect(await historyOf(deleted)).toEqual(['REGISTERED', 'DELETED_IN_SHOPIFY']);

    const refunded = nextOrderId();
    await send('orders/paid', payload(refunded, { updated: 2, financial: 'paid' }));
    await send('refunds/create', { id: Number(refunded) + 1, order_id: Number(refunded), transactions: [{ amount: '150.00' }] });
    expect((await row(refunded))?.status).toBe('REFUNDED');
    expect((await vouchersOf(refunded)).map((v) => v.status)).toEqual(['CANCELLED']);
  }, 30_000);

  test('pedidos de outros produtos não são importados; variante nova do produto Valle Pass é', async () => {
    const other = nextOrderId();
    const otherResult = await send('orders/create', payload(other, { updated: 1, variantId: String(variantCounter++), productId: '424242' }));
    await send('orders/paid', payload(other, { updated: 2, financial: 'paid', variantId: String(variantCounter++), productId: '424242' }));
    expect(otherResult.outcome).toBe('ignored');
    expect(await row(other)).toBeNull();

    const newVariant = nextOrderId();
    await send('orders/create', payload(newVariant, { updated: 1, variantId: String(variantCounter++), productId: KNOWN_VALE_PASS_PRODUCT_ID }));
    expect(await row(newVariant)).toMatchObject({ status: 'PENDING', quantity: 1 });
  }, 30_000);
});

describe('Pedidos de Valle Pass — reconciliação periódica (Shopify simulada)', () => {
  test('webhook perdido recuperado pela reconciliação: pendente, pago (com vale), expirado e cancelado aparecem', async () => {
    const [pending, paid, expired, cancelled] = [nextOrderId(), nextOrderId(), nextOrderId(), nextOrderId()];
    fake.listed = [
      shopifyOrder(pending, { updated: 10 }),
      shopifyOrder(paid, { updated: 10, financial: 'paid' }),
      shopifyOrder(expired, { updated: 10, financial: 'expired', cancelledAt: 10, cancelReason: 'other' }),
      shopifyOrder(cancelled, { updated: 10, cancelledAt: 10, cancelReason: 'customer' }),
    ];

    const report = await service.reconcile();

    expect(report.failed).toBe(0);
    expect(report.created).toBeGreaterThanOrEqual(4);
    expect((await row(pending))?.status).toBe('PENDING');
    expect(await row(paid)).toMatchObject({ status: 'CONFIRMED', lastSyncSource: 'reconciliation' });
    expect(await vouchersOf(paid)).toHaveLength(1);
    expect((await row(expired))?.status).toBe('EXPIRED');
    expect((await row(cancelled))?.status).toBe('CANCELLED');
    for (const id of [pending, expired, cancelled]) expect(await vouchersOf(id)).toHaveLength(0);

    // Nova rodada: nada novo, nada duplicado, vale não reemitido.
    const again = await service.reconcile();
    expect(again.created).toBe(0);
    expect(await vouchersOf(paid)).toHaveLength(1);
    for (const id of [pending, paid, expired, cancelled]) expect(await rowCount(id)).toBe(1);
  }, 60_000);

  test('pendente que parou de mudar é consultado direto e expira; pedido não encontrado fica como está', async () => {
    const stuck = nextOrderId();
    const missing = nextOrderId();
    await send('orders/create', payload(stuck, { updated: 1 }));
    await send('orders/create', payload(missing, { updated: 1 }));
    fake.listed = [];
    fake.byGid.set(`gid://shopify/Order/${stuck}`, shopifyOrder(stuck, { updated: 40, financial: 'expired' }));

    const report = await service.reconcile();

    expect(report.notFound).toBeGreaterThanOrEqual(1);
    expect((await row(stuck))?.status).toBe('EXPIRED');
    expect((await row(missing))?.status).toBe('PENDING');
  }, 45_000);

  test('vários pedidos futuros juntos → todos importados; pedidos de outros produtos e de aluguel ficam de fora', async () => {
    const ids = Array.from({ length: 12 }, () => nextOrderId());
    const rental = nextOrderId();
    const otherProduct = nextOrderId();
    fake.listed = [
      ...ids.map((id, i) => shopifyOrder(id, { updated: 20 + i, financial: i % 3 === 0 ? 'paid' : 'pending' })),
      shopifyOrder(rental, { updated: 20, financial: 'paid', variantId: String(variantCounter++), productId: '515151' }),
      shopifyOrder(otherProduct, { updated: 20, financial: 'pending', variantId: String(variantCounter++), productId: '525252' }),
    ];

    const report = await service.reconcile();

    expect(report.failed).toBe(0);
    for (const [i, id] of ids.entries()) {
      expect((await row(id))?.status).toBe(i % 3 === 0 ? 'CONFIRMED' : 'PENDING');
      expect(await vouchersOf(id)).toHaveLength(i % 3 === 0 ? 1 : 0);
    }
    expect(await row(rental)).toBeNull();
    expect(await row(otherProduct)).toBeNull();
  }, 90_000);

  test('duas reconciliações simultâneas (dois processos) com webhooks chegando junto → nenhuma duplicata, um vale por unidade paga', async () => {
    const ids = Array.from({ length: 6 }, () => nextOrderId());
    fake.listed = ids.map((id, i) => shopifyOrder(id, { updated: 50, financial: i < 3 ? 'paid' : 'pending', quantity: i === 0 ? 2 : 1 }));

    const [a, b] = await Promise.all([
      newService().reconcile(),
      newService().reconcile(),
      send('orders/paid', payload(ids[1], { updated: 50, financial: 'paid' })),
      send('orders/create', payload(ids[4], { updated: 50 })),
    ]);

    expect(a.failed + b.failed).toBe(0);
    for (const [i, id] of ids.entries()) {
      expect(await rowCount(id)).toBe(1);
      expect(await vouchersOf(id)).toHaveLength(i === 0 ? 2 : i < 3 ? 1 : 0);
    }
  }, 90_000);

  test('mesma instância: chamadas simultâneas compartilham a mesma rodada', async () => {
    fake.listed = [];
    const calls = fake.listCalls;
    const [first, second] = await Promise.all([service.reconcile(), service.reconcile()]);
    expect(first).toBe(second);
    expect(fake.listCalls - calls).toBe(1);
  }, 30_000);
});

describe('Pedidos de Valle Pass — acesso no ClosetAdmin', () => {
  test('lista exige o módulo VALLE_PASS; reconciliação manual exige ADMIN; status inválido é ignorado', async () => {
    expect(Reflect.getMetadata(REQUIRE_MODULE_KEY, ValePassOrdersController)).toBe('VALLE_PASS');
    expect(Reflect.getMetadata(REQUIRE_ROLE_KEY, ValePassOrdersController.prototype.reconcile)).toBe('ADMIN');
    expect(Reflect.getMetadata(REQUIRE_ROLE_KEY, ValePassOrdersController.prototype.list)).toBeUndefined();

    const controller = new ValePassOrdersController(service);
    const all = await controller.list('NAO_EXISTE');
    expect(all.length).toBeGreaterThan(0);
    const expired = await controller.list('EXPIRED');
    expect(expired.every((o) => o.status === 'EXPIRED')).toBe(true);
  }, 30_000);
});
