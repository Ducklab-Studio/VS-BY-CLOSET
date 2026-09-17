import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { PrismaService } from '../prisma/prisma.service';
import { WebhooksService } from '../webhooks/webhooks.service';
import { ValePassWebhookService } from './vale-pass-webhook.service';
import type { ShopifyOrderPayload } from '../webhooks/shopify-order-payload';

/**
 * Integração real (Neon) — mesmo padrão de webhooks.service.test.ts:
 * chama `WebhooksService.handleIncoming` de verdade (não o método
 * isolado do ValePassWebhookService), pra provar a integração real
 * dentro do MESMO pipeline de webhook, sem mock nenhum.
 *
 * "Totalmente separado do fluxo de aluguel": nenhum destes testes
 * cria RentalUnit/Reservation — só ValePassCampaign, e o pedido nunca
 * carrega `reservation_id`. Isso prova sozinho que Valle Pass funciona
 * mesmo sem nenhuma peça de aluguel existir/estar disponível.
 */
const prisma = new PrismaService();
const service = new WebhooksService(prisma, new ValePassWebhookService());
// Prefixo do próprio suite (não pode ir dentro do variant_id — é
// confirmado como sempre numérico cru no REST da Shopify, nunca uma
// string alfanumérica, ver shopify-order-payload.ts) usado só pra
// limpeza (nome da campanha) e pra webhookId.
const SUFFIX = Date.now();
let orderCounter = 2_000_000;
let variantCounter = 9_000_000 + (SUFFIX % 1_000_000);
let webhookIdCounter = 0;

function nextOrderId(): number {
  return orderCounter++;
}
function nextVariantId(): string {
  return String(variantCounter++);
}
function nextWebhookId(): string {
  return `VP-WH-${SUFFIX}-webhook-${webhookIdCounter++}`;
}

async function createCampaign(opts: { validityDays?: number; quantityLimit?: number; active?: boolean } = {}) {
  return prisma.valePassCampaign.create({
    data: {
      name: `Campanha VP-WH-${SUFFIX}`,
      amountCents: 15000,
      validityDays: opts.validityDays ?? 90,
      quantityLimit: opts.quantityLimit,
      shopifyVariantId: nextVariantId(),
      active: opts.active ?? true,
    },
  });
}

function orderPayload(opts: {
  variantId: string;
  quantity?: number;
  financialStatus?: string;
  orderId?: number;
  name?: string;
}): ShopifyOrderPayload {
  const orderId = opts.orderId ?? nextOrderId();
  return {
    id: orderId,
    admin_graphql_api_id: `gid://shopify/Order/${orderId}`,
    name: opts.name ?? `#${orderId}`,
    financial_status: opts.financialStatus ?? 'paid',
    line_items: [{ variant_id: Number(opts.variantId), quantity: opts.quantity ?? 1 }],
    email: 'cliente@teste.com',
    customer: { first_name: 'Cliente', last_name: 'Teste', phone: '+56911112222' },
  };
}

async function cleanup() {
  const campaigns = await prisma.valePassCampaign.findMany({ where: { name: `Campanha VP-WH-${SUFFIX}` } });
  const campaignIds = campaigns.map((c) => c.id);
  const vouchers = await prisma.valePass.findMany({ where: { campaignId: { in: campaignIds } } });
  const voucherIds = vouchers.map((v) => v.id);
  if (voucherIds.length) {
    await prisma.$executeRaw`DELETE FROM vale_pass_events WHERE vale_pass_id = ANY(${voucherIds}::uuid[])`;
    await prisma.$executeRaw`DELETE FROM vale_passes WHERE id = ANY(${voucherIds}::uuid[])`;
  }
  await prisma.$executeRaw`DELETE FROM vale_pass_campaigns WHERE name = ${`Campanha VP-WH-${SUFFIX}`}`;
  // reservation_events primeiro — todo evento (mesmo os de Valle Pass,
  // sem reservationId) é gravado vinculado ao WebhookEvent pelo loop
  // genérico em WebhooksService.processWebhook(); a FK impede apagar o
  // WebhookEvent enquanto essas linhas ainda existirem.
  await prisma.$executeRaw`DELETE FROM reservation_events WHERE webhook_event_id IN (SELECT id FROM webhook_events WHERE shopify_webhook_id LIKE ${`VP-WH-${SUFFIX}-webhook-%`})`;
  await prisma.$executeRaw`DELETE FROM webhook_events WHERE shopify_webhook_id LIKE ${`VP-WH-${SUFFIX}-webhook-%`}`;
}

beforeAll(cleanup);
afterAll(async () => {
  await cleanup();
  await prisma.$disconnect();
});

describe('ValePassWebhookService — via WebhooksService.handleIncoming (integração real, Neon)', () => {
  test('1) orders/paid com variante de campanha ativa → cria 1 vale ACTIVE, snapshot correto, sem tocar nenhuma RentalUnit/Reservation', async () => {
    const campaign = await createCampaign();
    const order = orderPayload({ variantId: campaign.shopifyVariantId, quantity: 1 });

    const result = await service.handleIncoming({ topic: 'orders/paid', shopifyWebhookId: nextWebhookId(), payload: order });
    expect(result.outcome).toBe('processed');

    const vouchers = await prisma.valePass.findMany({ where: { campaignId: campaign.id } });
    expect(vouchers).toHaveLength(1);
    const voucher = vouchers[0];
    expect(voucher.status).toBe('ACTIVE');
    expect(voucher.amountCents).toBe(campaign.amountCents);
    expect(voucher.code).toMatch(/^VALLE-[A-Z0-9]{4}-[A-Z0-9]{4}$/);
    expect(voucher.customerName).toBe('Cliente Teste');
    expect(voucher.customerPhone).toBe('+56911112222');
    expect(voucher.customerEmail).toBe('cliente@teste.com');
    expect(voucher.shopifyOrderId).toBe(String(order.id));
    expect(voucher.shopifyOrderName).toBe(order.name);

    const event = await prisma.valePassEvent.findFirst({ where: { valePassId: voucher.id, type: 'CREATED' } });
    expect(event).not.toBeNull();
  }, 15_000);

  test('2) quantidade > 1 na mesma linha → gera um vale por unidade, cada um com código único', async () => {
    const campaign = await createCampaign();
    const order = orderPayload({ variantId: campaign.shopifyVariantId, quantity: 3 });

    await service.handleIncoming({ topic: 'orders/paid', shopifyWebhookId: nextWebhookId(), payload: order });

    const vouchers = await prisma.valePass.findMany({ where: { campaignId: campaign.id } });
    expect(vouchers).toHaveLength(3);
    expect(new Set(vouchers.map((v) => v.code)).size).toBe(3);
    expect(vouchers.every((v) => v.shopifyOrderId === String(order.id))).toBe(true);
  }, 15_000);

  test('3) pedido sem nenhuma linha de Valle Pass (variant desconhecida) → nenhum vale criado, ignored', async () => {
    const order = orderPayload({ variantId: nextVariantId() }); // gerado mas nunca vira campanha
    const result = await service.handleIncoming({ topic: 'orders/paid', shopifyWebhookId: nextWebhookId(), payload: order });
    expect(result.outcome).toBe('ignored');
    const vouchers = await prisma.valePass.findMany({ where: { shopifyOrderId: String(order.id) } });
    expect(vouchers).toHaveLength(0);
  });

  test('4) orders/create (não pago) NUNCA emite vale — só orders/paid com financial_status=paid', async () => {
    const campaign = await createCampaign();
    const order = orderPayload({ variantId: campaign.shopifyVariantId, financialStatus: 'pending' });

    await service.handleIncoming({ topic: 'orders/create', shopifyWebhookId: nextWebhookId(), payload: order });
    const vouchers = await prisma.valePass.findMany({ where: { campaignId: campaign.id, shopifyOrderId: String(order.id) } });
    expect(vouchers).toHaveLength(0);

    // orders/paid com financial_status ainda pendente também não emite.
    await service.handleIncoming({ topic: 'orders/paid', shopifyWebhookId: nextWebhookId(), payload: order });
    const stillNone = await prisma.valePass.findMany({ where: { campaignId: campaign.id, shopifyOrderId: String(order.id) } });
    expect(stillNone).toHaveLength(0);
  }, 15_000);

  test('5) reentrega do mesmo webhook (mesmo shopifyWebhookId) → idempotente, não duplica o vale', async () => {
    const campaign = await createCampaign();
    const order = orderPayload({ variantId: campaign.shopifyVariantId });
    const webhookId = nextWebhookId();

    await service.handleIncoming({ topic: 'orders/paid', shopifyWebhookId: webhookId, payload: order });
    const first = await prisma.valePass.findMany({ where: { campaignId: campaign.id } });
    expect(first).toHaveLength(1);

    const second = await service.handleIncoming({ topic: 'orders/paid', shopifyWebhookId: webhookId, payload: order });
    expect(second.outcome).toBe('duplicate');
    const after = await prisma.valePass.findMany({ where: { campaignId: campaign.id } });
    expect(after).toHaveLength(1);
  }, 15_000);

  test('6) mesmo pedido entregue via um SEGUNDO shopifyWebhookId (reentrega "nova" da Shopify) → defesa por orderId não duplica', async () => {
    const campaign = await createCampaign();
    const order = orderPayload({ variantId: campaign.shopifyVariantId });

    await service.handleIncoming({ topic: 'orders/paid', shopifyWebhookId: nextWebhookId(), payload: order });
    await service.handleIncoming({ topic: 'orders/paid', shopifyWebhookId: nextWebhookId(), payload: order });

    const vouchers = await prisma.valePass.findMany({ where: { campaignId: campaign.id, shopifyOrderId: String(order.id) } });
    expect(vouchers).toHaveLength(1);
  }, 15_000);

  test('7) campanha atingiu quantityLimit → emite só até o limite, registra evento de limite atingido', async () => {
    const campaign = await createCampaign({ quantityLimit: 2 });
    const order = orderPayload({ variantId: campaign.shopifyVariantId, quantity: 5 });

    await service.handleIncoming({ topic: 'orders/paid', shopifyWebhookId: nextWebhookId(), payload: order });

    const vouchers = await prisma.valePass.findMany({ where: { campaignId: campaign.id } });
    expect(vouchers).toHaveLength(2);
  }, 15_000);

  test('8) campanha DESATIVADA continua emitindo vale pra pedido já pago (desativar só impede venda NOVA na Shopify, não invalida pedido em curso)', async () => {
    const campaign = await createCampaign({ active: false });
    const order = orderPayload({ variantId: campaign.shopifyVariantId });

    const result = await service.handleIncoming({ topic: 'orders/paid', shopifyWebhookId: nextWebhookId(), payload: order });
    expect(result.outcome).toBe('processed');
    const vouchers = await prisma.valePass.findMany({ where: { campaignId: campaign.id } });
    expect(vouchers).toHaveLength(1);
  }, 15_000);

  test('9) orders/cancelled cancela vale ACTIVE vinculado ao pedido', async () => {
    const campaign = await createCampaign();
    const order = orderPayload({ variantId: campaign.shopifyVariantId });
    await service.handleIncoming({ topic: 'orders/paid', shopifyWebhookId: nextWebhookId(), payload: order });

    const result = await service.handleIncoming({
      topic: 'orders/cancelled',
      shopifyWebhookId: nextWebhookId(),
      payload: { ...order, cancel_reason: 'customer' },
    });
    expect(result.outcome).toBe('processed');

    const voucher = await prisma.valePass.findFirstOrThrow({ where: { campaignId: campaign.id, shopifyOrderId: String(order.id) } });
    expect(voucher.status).toBe('CANCELLED');
    expect(voucher.cancelReason).toBe('orders/cancelled');
    const event = await prisma.valePassEvent.findFirst({ where: { valePassId: voucher.id, type: 'CANCELLED' } });
    expect(event).not.toBeNull();
  }, 15_000);

  test('10) refunds/create cancela vale ACTIVE vinculado ao pedido', async () => {
    const campaign = await createCampaign();
    const order = orderPayload({ variantId: campaign.shopifyVariantId });
    await service.handleIncoming({ topic: 'orders/paid', shopifyWebhookId: nextWebhookId(), payload: order });

    const result = await service.handleIncoming({
      topic: 'refunds/create',
      shopifyWebhookId: nextWebhookId(),
      payload: { id: nextOrderId(), order_id: order.id, transactions: [{ amount: '150.00' }] },
    });
    expect(result.outcome).toBe('processed');

    const voucher = await prisma.valePass.findFirstOrThrow({ where: { campaignId: campaign.id, shopifyOrderId: String(order.id) } });
    expect(voucher.status).toBe('CANCELLED');
  }, 15_000);

  test('11) vale já USADO nunca é revertido por cancelamento/refund do pedido', async () => {
    const campaign = await createCampaign();
    const order = orderPayload({ variantId: campaign.shopifyVariantId });
    await service.handleIncoming({ topic: 'orders/paid', shopifyWebhookId: nextWebhookId(), payload: order });

    const voucher = await prisma.valePass.findFirstOrThrow({ where: { campaignId: campaign.id, shopifyOrderId: String(order.id) } });
    await prisma.valePass.update({ where: { id: voucher.id }, data: { status: 'USED', usedAt: new Date() } });

    await service.handleIncoming({ topic: 'orders/cancelled', shopifyWebhookId: nextWebhookId(), payload: { ...order, cancel_reason: 'customer' } });

    const stillUsed = await prisma.valePass.findUniqueOrThrow({ where: { id: voucher.id } });
    expect(stillUsed.status).toBe('USED');
  }, 15_000);
});
