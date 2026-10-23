import { afterAll, afterEach, beforeAll, describe, expect, test } from 'vitest';
import { ConflictException, ForbiddenException, Module, ServiceUnavailableException, UnprocessableEntityException } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { ValePassCampaign } from '@prisma/client';
import { createHmac, randomUUID } from 'node:crypto';
import { PrismaService } from '../../prisma/prisma.service';
import { WebhooksController } from '../../webhooks/webhooks.controller';
import { WebhooksService } from '../../webhooks/webhooks.service';
import { ShopifyOrderSyncService } from '../../webhooks/shopify-order-sync.service';
import { REQUIRE_ROLE_KEY } from '../../admin/require-role.decorator';
import { lockShopifyOrder } from '../../webhooks/shopify-order-lock';
import { loadEmailConfig } from '../email/email-config';
import { EMAIL_CONFIG_TOKEN } from '../email/email-tokens';
import { ValePassEmailOutboxService } from '../email/email-outbox.service';
import { ValePassFinancialGuard } from '../financial/financial-guard.service';
import { ValePassHoldsService, type IssueHoldInput } from '../vale-pass-holds.service';
import { ValePassIssuanceService } from '../vale-pass-issuance.service';
import { ValePassLotsService } from '../vale-pass-lots.service';
import { ValePassRefundService } from '../refunds/refund.service';
import { ValePassRegularizationService } from '../refunds/regularization.service';
import { ValePassWebhookService } from '../vale-pass-webhook.service';
import { KNOWN_VALE_PASS_PRODUCT_ID } from '../vale-pass-order-status';
import { FLOW_FLAGS_TOKEN, INTEGRATION_DISABLED, type FlowFlags } from './flow-flags';
import { flagNotices } from './flow.controller';
import { ValePassFlowController } from './flow.controller';
import { ValePassPaymentFlowService } from './payment-flow.service';
import { ValePassPaymentTimeService } from './payment-time.service';
import { ValePassAlertsScheduler, ValePassOperationalAlertsService } from './operational-alerts.service';

/**
 * Integração financeira do Valle Pass 2027 (PR F) em PostgreSQL LOCAL descartável: pagamento → registro do pedido → validação financeira → dois
 * vouchers → caixa de saída de e-mail, e reembolso por unidade — tudo atrás de chaves DESLIGADAS por padrão. Nenhuma Shopify, nenhum e-mail enviado.
 */
const localDatabase = /^postgres(?:ql)?:\/\/[^@]+@(localhost|127\.0\.0\.1)(:\d+)?\/[^/]*(test|audit|operational)/i.test(process.env.DATABASE_URL ?? '');
const localDescribe = localDatabase ? describe : describe.skip;

const prisma = new PrismaService();
const issuance = new ValePassIssuanceService();
const outbox = new ValePassEmailOutboxService(prisma, loadEmailConfig({}));
const refunds = new ValePassRefundService(prisma);
const lots = new ValePassLotsService(prisma);
const TAG = `VPFL-${Date.now()}`;
let counter = 0;
let adminId: string;
const ADMIN_NAME = 'Admin Teste Fluxo';
const campaignIds: string[] = [];
const orderIds: string[] = [];

/** Chaves controladas pelo teste (o padrão de produção é tudo DESLIGADO). */
const flags = { twoVoucher: false, unitRefunds: false };
const PIPELINE_STORE = `${TAG.toLowerCase()}.myshopify.com`;
/** Política do horário do pagamento no teste: padrão do teste = concordância dos dois sinais do webhook (a produção é ESTRITA; ver os testes próprios). */
const paymentTimeCfg: { mode: 'strict' | 'webhook-agreement'; toleranceSeconds: number } = { mode: 'webhook-agreement', toleranceSeconds: 120 };
const flagFns: FlowFlags = { twoVoucher: () => flags.twoVoucher, unitRefunds: () => flags.unitRefunds, paymentTime: () => ({ ...paymentTimeCfg }) };
/** Admin API FALSA (nenhuma rede): transações por GID do pedido. */
const fakeTransactions = new Map<string, import('../../admin-panel/shopify-admin.client').ShopifyOrderTransactionsResult | null>();
const fakeShopify = { getOrderPaymentTransactions: async (gid: string) => fakeTransactions.get(gid) ?? null } as unknown as import('../../admin-panel/shopify-admin.client').ShopifyAdminClient;
const paymentTimeService = () => new ValePassPaymentTimeService(prisma, fakeShopify, flagFns);
const operationalAlerts = new ValePassOperationalAlertsService(prisma);
const regularization = new ValePassRegularizationService(prisma, new ValePassFinancialGuard(), issuance);
const holdsService = new ValePassHoldsService(prisma, issuance, outbox);
const service = () => new ValePassWebhookService(new ValePassPaymentFlowService(new ValePassFinancialGuard(), issuance, outbox, flagFns, prisma, regularization), refunds, flagFns);
const flowService = () => new ValePassPaymentFlowService(new ValePassFinancialGuard(), issuance, outbox, flagFns, prisma, regularization);

const money = (amount: string) => ({ shop_money: { amount, currency_code: 'BRL' }, presentment_money: { amount, currency_code: 'BRL' } });

interface Campaign extends ValePassCampaign { numericVariant: string }
async function newCampaign(withBenefits: boolean, over: Partial<{ globalLimit: number | null }> = {}): Promise<Campaign> {
  const numericVariant = String(900_000_000_000 + counter++);
  const campaign = await prisma.valePassCampaign.create({
    data: {
      name: `${TAG}-camp-${counter++}`, amountCents: 35_000, validityDays: 30, globalLimit: over.globalLimit === undefined ? 1_000 : over.globalLimit, shopifyVariantId: numericVariant,
      voucherValidFrom: new Date('2026-01-01T00:00:00.000Z'), voucherValidUntil: new Date('2027-12-31T00:00:00.000Z'), ...over,
    },
  });
  campaignIds.push(campaign.id);
  if (withBenefits) {
    await prisma.valePassCampaignBenefit.createMany({
      data: [
        { campaignId: campaign.id, code: 'valle_showroom_500', kind: 'VOUCHER', company: 'VALLE_SHOWROOM', label: 'Voucher Valle Showroom', amountCents: 50_000, sortOrder: 0 },
        { campaignId: campaign.id, code: 'vs_by_closet_50', kind: 'VOUCHER', company: 'VS_BY_CLOSET', label: 'Voucher VS BY CLOSET', amountCents: 5_000, sortOrder: 1 },
      ],
    });
  }
  return { ...campaign, numericVariant };
}

let clock = Date.now();
function paidPayload(campaign: Campaign, quantity: number, over: Record<string, unknown> = {}, orderId = `${TAG}-o${counter++}`): Record<string, unknown> {
  orderIds.push(orderId);
  clock += 1000;
  return {
    id: orderId, admin_graphql_api_id: `gid://shopify/Order/${orderId}`, name: `#${TAG}${counter}`, financial_status: 'paid', cancelled_at: null, currency: 'BRL', presentment_currency: 'BRL',
    created_at: new Date(clock - 60_000).toISOString(), updated_at: new Date(clock).toISOString(),
    current_total_price: ((35000 * quantity) / 100).toFixed(2), total_outstanding: '0.00', total_discounts: '0.00', discount_codes: [], refunds: [],
    total_shipping_price_set: money('0.00'), email: `cliente${counter}@exemplo.invalid`, customer: { first_name: 'Cliente', last_name: 'Sintético', email: `cliente${counter}@exemplo.invalid` },
    line_items: [{ variant_id: Number(campaign.numericVariant), product_id: null, quantity, current_quantity: quantity, price: '350.00', price_set: money('350.00'), discount_allocations: [] }],
    ...over,
  };
}
const withStatus = (payload: Record<string, unknown>, financialStatus: string, updatedOffsetMs: number): Record<string, unknown> => ({ ...payload, financial_status: financialStatus, updated_at: new Date(clock + updatedOffsetMs).toISOString() });

/** Entrega REALISTA do orders/paid: o cabeçalho e o updated_at do payload são do MESMO instante (o do pagamento), mesmo que a entrega só aconteça horas depois. */
const runAt = (svc: ValePassWebhookService, payload: unknown, at: string) => run(svc, 'orders/paid', { ...(payload as Record<string, unknown>), updated_at: at }, { triggeredAt: at });
/** `triggeredAt`: o X-Shopify-Triggered-At da entrega. Padrão do teste: orders/paid chega logo após o pagamento (o instante do próprio payload). */
const run = (svc: ValePassWebhookService, topic: string, payload: unknown, meta?: { triggeredAt: string | null }) =>
  prisma.$transaction(async (tx) => {
    await lockShopifyOrder(tx, String((payload as { id?: unknown; order_id?: unknown }).order_id ?? (payload as { id: unknown }).id));
    return svc.handleOrderWebhook(tx, topic, payload, meta ?? { triggeredAt: topic === 'orders/paid' ? String((payload as { updated_at?: unknown }).updated_at ?? '') || null : null });
  }, { timeout: 30_000, maxWait: 20_000 });
/** O que o WebhooksService faz num refunds/create: tratamento do Valle Pass e depois o registro do pedido. */
const runRefund = (svc: ValePassWebhookService, refund: Record<string, unknown>) =>
  prisma.$transaction(async (tx) => {
    await lockShopifyOrder(tx, String(refund.order_id));
    const first = await svc.handleRefund(tx, refund as never);
    const second = await svc.handleOrderWebhook(tx, 'refunds/create', refund);
    return [...first, ...second];
  }, { timeout: 30_000, maxWait: 20_000 });

const refundFor = (campaign: Campaign, orderId: string, quantity: number, over: Record<string, unknown> = {}) => ({
  id: `${TAG}-rf${counter++}`, order_id: orderId, refund_shipping_lines: [], transactions: [], order_adjustments: [],
  refund_line_items: [{ id: 1, line_item_id: 1, quantity, subtotal: 350 * quantity, total_tax: 0, restock_type: 'return', line_item: { variant_id: Number(campaign.numericVariant), product_id: null, price: '350.00', quantity: 3 } }],
  ...over,
});

const vouchersOf = (orderId: string) => prisma.valePass.findMany({ where: { shopifyOrderId: orderId }, orderBy: [{ createdAt: 'asc' }, { company: 'asc' }] });
const holdsOf = (orderId: string) => prisma.valePassIssuanceHold.findMany({ where: { shopifyOrderId: orderId } });
const allOrderEvents = async (orderId: string) => {
  const registry = await prisma.valePassOrder.findUnique({ where: { shopifyOrderId: orderId }, select: { id: true } });
  return (await prisma.valePassOrderEvent.findMany({ where: { valePassOrderId: registry?.id ?? '' }, select: { type: true } })).map((e) => e.type);
};
const outboxOf = (orderId: string) => prisma.valePassEmailOutbox.findMany({ where: { shopifyOrderId: orderId } });
const registryOf = (orderId: string) => prisma.valePassOrder.findUniqueOrThrow({ where: { shopifyOrderId: orderId } });
const issueCodes = (hold: { detail: unknown }) => ((hold.detail as { issues?: { code: string }[] } | null)?.issues ?? []).map((issue) => issue.code);

beforeAll(async () => {
  if (!localDatabase) return;
  adminId = (await prisma.adminUser.create({ data: { name: ADMIN_NAME, phone: `${TAG}-admin`, pinHash: 'x', role: 'ADMIN', active: true } })).id;
  await prisma.store.upsert({ where: { id: `${TAG}-store` }, update: {}, create: { id: `${TAG}-store`, shopifyDomain: `${TAG}.invalid`, currency: 'BRL' } });
});

async function cleanRows() {
  const ids = campaignIds.splice(0);
  const orders = orderIds.splice(0);
  await prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe('SET LOCAL session_replication_role = replica');
    const vouchers = await tx.valePass.findMany({ where: { campaignId: { in: ids } }, select: { id: true } });
    const holds = await tx.valePassIssuanceHold.findMany({ where: { campaignId: { in: ids } }, select: { id: true } });
    const refundRows = await tx.valePassRefundApplication.findMany({ where: { shopifyOrderId: { in: orders } }, select: { id: true } });
    const outboxRows = await tx.valePassEmailOutbox.findMany({ where: { shopifyOrderId: { in: orders } }, select: { id: true } });
    await tx.valePassEmailEvent.deleteMany({ where: { outboxId: { in: outboxRows.map((row) => row.id) } } });
    await tx.valePassEmailOutbox.deleteMany({ where: { shopifyOrderId: { in: orders } } });
    await tx.adminAuditEvent.deleteMany({ where: { OR: [{ entityId: { in: [...holds.map((h) => h.id), ...refundRows.map((r) => r.id), ...vouchers.map((v) => v.id)] } }, { adminUserId: adminId }] } });
    await tx.valePassRefundApplication.deleteMany({ where: { shopifyOrderId: { in: orders } } });
    await tx.valePassEvent.deleteMany({ where: { valePassId: { in: vouchers.map((v) => v.id) } } });
    await tx.valePass.deleteMany({ where: { campaignId: { in: ids } } });
    await tx.valePassIssuanceHold.deleteMany({ where: { campaignId: { in: ids } } });
    await tx.valePassCampaignBenefit.deleteMany({ where: { campaignId: { in: ids } } });
    await tx.valePassCampaign.deleteMany({ where: { id: { in: ids } } });
    const regs = await tx.valePassOrder.findMany({ where: { shopifyOrderId: { in: orders } }, select: { id: true } });
    await tx.valePassOrderEvent.deleteMany({ where: { valePassOrderId: { in: regs.map((r) => r.id) } } });
    await tx.valePassOrderCancellation.deleteMany({ where: { shopifyOrderId: { in: orders } } });
    await tx.valePassOrder.deleteMany({ where: { shopifyOrderId: { in: orders } } });
    await tx.webhookEvent.deleteMany({ where: { OR: [{ storeId: `${TAG}-store` }, { storeId: PIPELINE_STORE }] } });
  });
  flags.twoVoucher = false;
  flags.unitRefunds = false;
  paymentTimeCfg.mode = 'webhook-agreement';
  paymentTimeCfg.toleranceSeconds = 120;
  fakeTransactions.clear();
}
afterEach(async () => {
  if (localDatabase) await cleanRows();
});
afterAll(async () => {
  if (localDatabase) {
    await cleanRows();
    await prisma.store.deleteMany({ where: { id: { in: [`${TAG}-store`, PIPELINE_STORE] } } });
    await prisma.adminUser.deleteMany({ where: { id: adminId } });
  }
  await prisma.$disconnect();
});

/** Guarda um evento como o WebhooksService guardaria (para a retomada reler o estado mais recente do pedido). */
async function storeEvent(topic: string, payload: Record<string, unknown>) {
  await prisma.webhookEvent.create({ data: { shopifyWebhookId: `${TAG}-wh${counter++}`, storeId: `${TAG}-store`, topic, payload: payload as never, status: 'processed' as never, orderId: String(payload.id) } });
}

localDescribe('chave DESLIGADA (padrão): o pagamento nunca some e nunca vira voucher único', () => {
  test('campanha com benefícios + chave desligada → retenção visível; nenhum voucher; nenhuma mensagem de e-mail; pedido registrado como processado', async () => {
    const campaign = await newCampaign(true);
    const payload = paidPayload(campaign, 2);
    const events = await run(service(), 'orders/paid', payload);
    const orderId = String(payload.id);
    expect(events.map((e) => e.type)).toContain('VALE_PASS_ISSUANCE_HELD');
    expect(await vouchersOf(orderId)).toHaveLength(0); // nada de voucher único do caminho legado
    const holds = await holdsOf(orderId);
    expect(holds).toHaveLength(1);
    expect(holds[0]).toMatchObject({ status: 'OPEN', reason: 'FINANCIAL_MISMATCH', units: 2, campaignId: campaign.id });
    expect(issueCodes(holds[0])).toEqual([INTEGRATION_DISABLED]);
    expect(await outboxOf(orderId)).toHaveLength(0);
    expect((await registryOf(orderId)).status).toBe('CONFIRMED');
    // visível no painel: alerta crítico e a unidade conta como consumida
    const capacity = await lots.getCapacity(campaign.id);
    expect(capacity.alerts.find((a) => a.code === 'INTEGRATION_HOLDS_OPEN')).toMatchObject({ severity: 'critical' });
    expect(capacity.holds).toEqual([expect.objectContaining({ id: holds[0].id, units: 2, issues: [INTEGRATION_DISABLED] })]);
    expect(capacity.totals.consumed).toBe(2);
  });

  test('webhook repetido, atrasado (orders/updated) e simultâneo: UMA retenção, mesmas unidades, nada duplicado', async () => {
    const campaign = await newCampaign(true);
    const payload = paidPayload(campaign, 2);
    const orderId = String(payload.id);
    await Promise.all(Array.from({ length: 6 }, () => run(service(), 'orders/paid', payload)));
    await run(service(), 'orders/updated', withStatus(payload, 'paid', 5_000));
    await run(service(), 'orders/paid', payload);
    const holds = await holdsOf(orderId);
    expect(holds).toHaveLength(1);
    expect(holds[0].units).toBe(2);
    expect(await vouchersOf(orderId)).toHaveLength(0);
  });

  test('campanha SEM benefícios (legada): continua emitindo o voucher único de sempre, com a chave ligada ou desligada', async () => {
    const legacy = await newCampaign(false);
    for (const state of [false, true]) {
      flags.twoVoucher = state;
      const payload = paidPayload(legacy, 2);
      await run(service(), 'orders/paid', payload);
      const rows = await vouchersOf(String(payload.id));
      expect(rows, `chave=${state}`).toHaveLength(2);
      expect(rows.every((v) => v.groupId === null && v.benefitId === null && v.status === 'ACTIVE')).toBe(true);
      expect(await holdsOf(String(payload.id))).toHaveLength(0);
    }
  });

  test('pedido legado já emitido não é tocado nem reprocessado', async () => {
    const legacy = await newCampaign(false);
    const payload = paidPayload(legacy, 1);
    await run(service(), 'orders/paid', payload);
    const before = await vouchersOf(String(payload.id));
    flags.twoVoucher = true;
    await run(service(), 'orders/paid', payload);
    await run(service(), 'orders/updated', withStatus(payload, 'paid', 3_000));
    expect(await vouchersOf(String(payload.id))).toEqual(before);
  });
});

localDescribe('chave LIGADA: validação financeira → dois vouchers por unidade → caixa de saída', () => {
  test('pagamento integral em BRL, preço e quantidade certos: exatamente 2 vouchers por unidade (um de cada empresa) e UMA mensagem por unidade, sem enviar nada', async () => {
    flags.twoVoucher = true;
    const campaign = await newCampaign(true);
    const payload = paidPayload(campaign, 3);
    const orderId = String(payload.id);
    const events = await run(service(), 'orders/paid', payload);
    expect(events.map((e) => e.type)).toEqual(expect.arrayContaining(['VALE_PASS_UNITS_ISSUED', 'VALE_PASS_EMAIL_ENQUEUED']));
    const rows = await vouchersOf(orderId);
    expect(rows).toHaveLength(6);
    const groups = new Map<string, string[]>();
    for (const v of rows) groups.set(v.groupId as string, [...(groups.get(v.groupId as string) ?? []), v.company as string]);
    expect(groups.size).toBe(3);
    for (const companies of groups.values()) expect(companies.sort()).toEqual(['VALLE_SHOWROOM', 'VS_BY_CLOSET']);
    const queue = await outboxOf(orderId);
    expect(queue).toHaveLength(3);
    expect(new Set(queue.map((q) => q.groupId))).toEqual(groups.size === 3 ? new Set([...groups.keys()]) : new Set());
    expect(queue.every((q) => q.status === 'QUEUED' && q.attempts === 0 && q.kind === 'INITIAL')).toBe(true); // nada foi enviado
    expect(await holdsOf(orderId)).toHaveLength(0);
    expect((await registryOf(orderId)).quantity).toBe(3);
  });

  test('duplicados e simultâneos (10 entregas) + orders/updated + reconciliação: nunca passa de 2 vouchers e 1 mensagem por unidade', async () => {
    flags.twoVoucher = true;
    const campaign = await newCampaign(true);
    const payload = paidPayload(campaign, 2);
    const orderId = String(payload.id);
    await Promise.all(Array.from({ length: 10 }, () => run(service(), 'orders/paid', payload)));
    await run(service(), 'orders/updated', withStatus(payload, 'paid', 4_000));
    expect(await vouchersOf(orderId)).toHaveLength(4);
    expect(await outboxOf(orderId)).toHaveLength(2);
  });

  test('fora de ordem e Pix: orders/create pendente não emite; o orders/updated pago chega ANTES do orders/paid e emite uma vez; o orders/paid depois não duplica', async () => {
    flags.twoVoucher = true;
    const campaign = await newCampaign(true);
    const base = paidPayload(campaign, 2);
    const orderId = String(base.id);
    await run(service(), 'orders/create', withStatus(base, 'pending', -2_000)); // Pix gerado, ainda não pago
    expect(await vouchersOf(orderId)).toHaveLength(0);
    expect((await registryOf(orderId)).status).toBe('PENDING');
    // pago, mas o orders/paid se perdeu/atrasou: o orders/updated NÃO diz quando o pagamento aconteceu → retenção PAYMENT_TIME_UNKNOWN (nada emitido às cegas)
    const events = await run(service(), 'orders/updated', withStatus(base, 'paid', 2_000));
    expect(events.map((e) => e.type)).toContain('VALE_PASS_PAYMENT_RECOVERED');
    expect(events.map((e) => e.type)).toContain('VALE_PASS_ISSUANCE_HELD');
    expect(await vouchersOf(orderId)).toHaveLength(0);
    expect(issueCodes((await holdsOf(orderId))[0])).toEqual(['PAYMENT_TIME_UNKNOWN']);
    expect((await registryOf(orderId)).paymentConfirmedAt).toBeNull();
    // o orders/paid chega atrasado (updated_at mais antigo) MAS traz o instante real do pagamento: emite uma vez e resolve a retenção
    await run(service(), 'orders/paid', withStatus(base, 'paid', 1_000));
    expect(await vouchersOf(orderId)).toHaveLength(4);
    expect(await outboxOf(orderId)).toHaveLength(2);
    expect((await holdsOf(orderId)).every((hold) => hold.status !== 'OPEN')).toBe(true);
    await run(service(), 'orders/paid', withStatus(base, 'paid', 1_000));
    expect(await vouchersOf(orderId)).toHaveLength(4);
    expect(await outboxOf(orderId)).toHaveLength(2);
  });

  test.each([
    ['desconto aplicado', { total_discounts: '35.00', current_total_price: '665.00', discount_codes: [{ code: 'PROMO' }] }],
    ['moeda diferente de BRL', { currency: 'USD', presentment_currency: 'USD' }],
    ['total pago diferente do esperado', { current_total_price: '600.00' }],
    ['saldo em aberto', { total_outstanding: '350.00' }],
    ['frete ou cobrança extra', { total_shipping_price_set: money('22.00'), current_total_price: '722.00' }],
  ])('validação financeira reprova (%s): retenção FINANCIAL_MISMATCH, nenhum voucher, nenhuma mensagem — o pagamento fica visível', async (_label, over) => {
    flags.twoVoucher = true;
    const campaign = await newCampaign(true);
    const payload = paidPayload(campaign, 2, over as Record<string, unknown>);
    const orderId = String(payload.id);
    await run(service(), 'orders/paid', payload);
    expect(await vouchersOf(orderId)).toHaveLength(0);
    expect(await outboxOf(orderId)).toHaveLength(0);
    const holds = await holdsOf(orderId);
    expect(holds).toHaveLength(1);
    expect(holds[0]).toMatchObject({ status: 'OPEN', reason: 'FINANCIAL_MISMATCH', units: 2 });
    expect(issueCodes(holds[0])).not.toContain(INTEGRATION_DISABLED);
    expect(issueCodes(holds[0]).length).toBeGreaterThan(0);
  });

  test('preço do payload diferente do preço da campanha no banco → retenção (o preço confiável é o do banco)', async () => {
    flags.twoVoucher = true;
    const campaign = await newCampaign(true);
    const payload = paidPayload(campaign, 1);
    (payload.line_items as { price: string; price_set: unknown }[])[0].price = '35.00';
    (payload.line_items as { price: string; price_set: unknown }[])[0].price_set = money('35.00');
    await run(service(), 'orders/paid', { ...payload, current_total_price: '35.00' });
    expect(issueCodes((await holdsOf(String(payload.id)))[0])).toEqual(expect.arrayContaining(['PRICE_MISMATCH']));
    expect(await vouchersOf(String(payload.id))).toHaveLength(0);
  });

  test('a quantidade confiável é a do REGISTRO: payload com unidade removida (current_quantity menor) → retenção QUANTITY_CHANGED, nunca emissão pela contagem do payload', async () => {
    flags.twoVoucher = true;
    const campaign = await newCampaign(true);
    const payload = paidPayload(campaign, 3);
    (payload.line_items as { current_quantity: number }[])[0].current_quantity = 2;
    payload.current_total_price = '700.00';
    await run(service(), 'orders/paid', payload);
    const orderId = String(payload.id);
    expect((await registryOf(orderId)).quantity).toBe(3);
    expect(await vouchersOf(orderId)).toHaveLength(0);
    expect(issueCodes((await holdsOf(orderId))[0])).toEqual(expect.arrayContaining(['QUANTITY_CHANGED']));
  });

  test('capacidade: limite global menor que o pedido → retenção CAPACITY_EXCEEDED (tudo ou nada); nada emitido, nada na caixa de saída', async () => {
    flags.twoVoucher = true;
    const campaign = await newCampaign(true, { globalLimit: 1 });
    const payload = paidPayload(campaign, 2);
    await run(service(), 'orders/paid', payload);
    const orderId = String(payload.id);
    expect(await vouchersOf(orderId)).toHaveLength(0);
    expect(await outboxOf(orderId)).toHaveLength(0);
    expect((await holdsOf(orderId))[0]).toMatchObject({ status: 'OPEN', reason: 'CAPACITY_EXCEEDED', units: 2 });
  });

  test('reconciliação (payload da Admin API sem dados financeiros): nunca emite às cegas — vira retenção por dados financeiros indefinidos', async () => {
    flags.twoVoucher = true;
    const campaign = await newCampaign(true);
    const base = paidPayload(campaign, 1);
    const orderId = String(base.id);
    await run(service(), 'orders/create', withStatus(base, 'pending', -1_000));
    const registry = await registryOf(orderId);
    await prisma.valePassOrder.update({ where: { id: registry.id }, data: { status: 'CONFIRMED', statusChangedAt: new Date(), paymentConfirmedAt: new Date() } });
    // O que a reconciliação monta a partir da Admin API: pedido pago e linhas, SEM os campos financeiros (total, desconto, moeda, saldo).
    const reconciled = { id: orderId, admin_graphql_api_id: `gid://shopify/Order/${orderId}`, name: '#R1', financial_status: 'paid', cancelled_at: null, line_items: [{ variant_id: campaign.numericVariant, product_id: null, quantity: 1 }] };
    const events = await prisma.$transaction(async (tx) => {
      await lockShopifyOrder(tx, orderId);
      return service().issueForConfirmedOrder(tx, await tx.valePassOrder.findUniqueOrThrow({ where: { shopifyOrderId: orderId } }), reconciled as never, 'reconciliation');
    });
    expect(events.map((e) => e.type)).toContain('VALE_PASS_ISSUANCE_HELD');
    expect(await vouchersOf(orderId)).toHaveLength(0);
    expect(issueCodes((await holdsOf(orderId))[0])).toEqual(['FINANCIALS_UNDEFINED']);
  });

  test('reembolso nunca para com a chave ligada ou desligada: desligar a emissão depois não cancela unidade nenhuma — o reembolso vira revisão de um ADMIN', async () => {
    flags.twoVoucher = true;
    const campaign = await newCampaign(true);
    const payload = paidPayload(campaign, 2);
    const orderId = String(payload.id);
    await run(service(), 'orders/paid', payload);
    flags.twoVoucher = false; // alguém desligou a chave depois da emissão
    const refund = refundFor(campaign, orderId, 1);
    await runRefund(service(), refund);
    expect((await vouchersOf(orderId)).every((v) => v.status === 'ACTIVE')).toBe(true); // unidade NÃO reembolsada nunca é cancelada sozinha
    expect(await prisma.valePassOrderCancellation.count({ where: { shopifyOrderId: orderId } })).toBe(0);
    expect(await prisma.valePassRefundApplication.findUniqueOrThrow({ where: { shopifyRefundId: refund.id as string } })).toMatchObject({ status: 'NEEDS_REVIEW', classification: 'UNITS' });
  });
});

localDescribe('retomada das retenções feitas com a chave desligada', () => {
  async function heldOrder(campaign: Campaign, quantity: number, over: Record<string, unknown> = {}) {
    flags.twoVoucher = false;
    const payload = paidPayload(campaign, quantity, over);
    await run(service(), 'orders/paid', payload);
    await storeEvent('orders/paid', payload);
    await new Promise((resolve) => setTimeout(resolve, 15)); // created_at estritamente crescente: a ordem de pagamento
    return payload;
  }

  test('só funciona com a chave LIGADA (409 explicativo); só ADMIN pode chamar a rota', async () => {
    const campaign = await newCampaign(true);
    await heldOrder(campaign, 1);
    await expect(flowService().resumeHeldPayments({ id: adminId, name: ADMIN_NAME })).rejects.toBeInstanceOf(ConflictException);
    const proto = ValePassFlowController.prototype as unknown as Record<string, unknown>;
    expect(Reflect.getMetadata(REQUIRE_ROLE_KEY, proto.resume as object)).toBe('ADMIN');
    expect(Reflect.getMetadata(REQUIRE_ROLE_KEY, proto.status as object)).toBeUndefined();
  });

  test('as mais ANTIGAS primeiro, em lote; cada pedido emite 2 vouchers por unidade + mensagens; repetir é idempotente; o resto continua retido', async () => {
    const campaign = await newCampaign(true);
    const first = await heldOrder(campaign, 1);
    const second = await heldOrder(campaign, 2);
    const third = await heldOrder(campaign, 1);
    flags.twoVoucher = true;
    const report = await flowService().resumeHeldPayments({ id: adminId, name: ADMIN_NAME }, { limit: 2, note: 'Integração ligada: retomar as mais antigas' });
    expect(report).toMatchObject({ considered: 2, issued: 2, reclassified: 0 });
    expect(await vouchersOf(String(first.id))).toHaveLength(2);
    expect(await vouchersOf(String(second.id))).toHaveLength(4);
    expect(await vouchersOf(String(third.id))).toHaveLength(0); // ficou para o próximo lote
    expect(await outboxOf(String(second.id))).toHaveLength(2);
    expect((await holdsOf(String(first.id)))[0].status).toBe('ISSUED');
    expect((await holdsOf(String(third.id)))[0].status).toBe('OPEN');
    const again = await flowService().resumeHeldPayments({ id: adminId, name: ADMIN_NAME }, { limit: 10 });
    expect(again).toMatchObject({ considered: 1, issued: 1 });
    const none = await flowService().resumeHeldPayments({ id: adminId, name: ADMIN_NAME });
    expect(none.considered).toBe(0);
    expect(await vouchersOf(String(first.id))).toHaveLength(2); // nada duplicado
    const audit = await prisma.adminAuditEvent.findFirst({ where: { adminUserId: adminId, action: 'VALE_PASS_HOLDS_RESUMED' } });
    expect(audit).toMatchObject({ isCritical: true });
  });

  test('o que a validação financeira não aceita continua retido (agora com os motivos reais); pedido que deixou de estar pago é pulado; sem evento guardado é pulado', async () => {
    const campaign = await newCampaign(true);
    const discounted = await heldOrder(campaign, 1, { total_discounts: '35.00', current_total_price: '315.00', discount_codes: [{ code: 'PROMO' }] });
    const refundedLater = await heldOrder(campaign, 1);
    await storeEvent('orders/updated', withStatus(refundedLater, 'refunded', 9_000)); // o último evento mostra reembolso
    const noEvents = paidPayload(campaign, 1);
    flags.twoVoucher = false;
    await run(service(), 'orders/paid', noEvents); // retida, mas sem evento guardado
    flags.twoVoucher = true;
    const report = await flowService().resumeHeldPayments({ id: adminId, name: ADMIN_NAME }, { limit: 10 });
    expect(report.issued).toBe(0);
    expect(report.reclassified).toBe(1);
    expect(report.skipped.map((s) => s.reason).join(' | ')).toMatch(/não está pago/);
    expect(report.skipped.map((s) => s.reason).join(' | ')).toMatch(/Nenhum evento/);
    expect(issueCodes((await holdsOf(String(discounted.id)))[0])).toEqual(expect.arrayContaining(['DISCOUNT_PRESENT']));
    expect(await vouchersOf(String(discounted.id))).toHaveLength(0);
    expect(await vouchersOf(String(refundedLater.id))).toHaveLength(0);
    expect(await vouchersOf(String(noEvents.id))).toHaveLength(0);
  });

  test('a resolução administrativa e o descarte de retenção funcionam com a chave desligada (nunca dependem dela)', async () => {
    const campaign = await newCampaign(true);
    const payload = await heldOrder(campaign, 1);
    const hold = (await holdsOf(String(payload.id)))[0];
    flags.twoVoucher = false;
    // O descarte só vale depois de o pedido deixar de estar pago na Shopify (regra da própria retenção); aqui o reembolso já foi registrado.
    await prisma.valePassOrder.update({ where: { shopifyOrderId: String(payload.id) }, data: { status: 'REFUNDED', statusChangedAt: new Date() } });
    const holdsService = new ValePassHoldsService(prisma, issuance);
    const dismissed = await holdsService.dismiss(hold.id, 'Pedido reembolsado na Shopify; descartar a retenção', adminId, ADMIN_NAME);
    expect(dismissed).toMatchObject({ status: 'DISMISSED' });
  });
});

localDescribe('reembolso por unidade integrado ao webhook (chave VALE_PASS_UNIT_REFUNDS)', () => {
  async function issued(campaign: Campaign, quantity: number) {
    flags.twoVoucher = true;
    const payload = paidPayload(campaign, quantity);
    await run(service(), 'orders/paid', payload);
    return payload;
  }

  test('chave desligada (padrão): reembolso de FRETE de pedido dos dois vouchers NÃO cancela nada nem derruba o pedido; o pedido LEGADO segue o caminho de sempre (cancela e marca REFUNDED)', async () => {
    const campaign = await newCampaign(true);
    const payload = await issued(campaign, 2);
    const orderId = String(payload.id);
    await runRefund(service(), refundFor(campaign, orderId, 0, { refund_line_items: [], refund_shipping_lines: [{ id: 1, subtotal_amount_set: money('22.00') }] }));
    expect((await vouchersOf(orderId)).every((v) => v.status === 'ACTIVE')).toBe(true);
    expect((await registryOf(orderId)).status).toBe('CONFIRMED');
    expect(await prisma.valePassRefundApplication.count({ where: { shopifyOrderId: orderId } })).toBe(1);

    const legacy = await newCampaign(false);
    const legacyPayload = paidPayload(legacy, 2);
    await run(service(), 'orders/paid', legacyPayload);
    await runRefund(service(), refundFor(legacy, String(legacyPayload.id), 0, { refund_line_items: [], refund_shipping_lines: [{ id: 1, subtotal_amount_set: money('22.00') }] }));
    expect((await vouchersOf(String(legacyPayload.id))).every((v) => v.status === 'CANCELLED')).toBe(true);
    expect((await registryOf(String(legacyPayload.id))).status).toBe('REFUNDED');
    expect(await prisma.valePassRefundApplication.count({ where: { shopifyOrderId: String(legacyPayload.id) } })).toBe(0);
  });

  test('chave ligada: frete não toca em voucher nem no status do pedido; reembolso parcial vira revisão ADMIN (ADMIN_CONFIRM) e o pedido segue pago; orders/updated partially_refunded não o derruba', async () => {
    const campaign = await newCampaign(true);
    const payload = await issued(campaign, 2);
    const orderId = String(payload.id);
    flags.unitRefunds = true;
    await runRefund(service(), refundFor(campaign, orderId, 0, { refund_line_items: [], refund_shipping_lines: [{ id: 1, subtotal_amount_set: money('22.00') }] }));
    expect((await vouchersOf(orderId)).every((v) => v.status === 'ACTIVE')).toBe(true);
    expect((await registryOf(orderId)).status).toBe('CONFIRMED');
    const partial = refundFor(campaign, orderId, 1);
    await runRefund(service(), partial);
    expect(await prisma.valePassRefundApplication.findUniqueOrThrow({ where: { shopifyRefundId: partial.id as string } })).toMatchObject({ status: 'NEEDS_REVIEW', classification: 'UNITS' });
    expect((await vouchersOf(orderId)).every((v) => v.status === 'ACTIVE')).toBe(true); // nada cancelado sozinho
    await run(service(), 'orders/updated', withStatus(payload, 'partially_refunded', 6_000));
    expect((await registryOf(orderId)).status).toBe('CONFIRMED');
    await runRefund(service(), partial); // reentrega: DUPLICATE, nada muda
    expect(await prisma.valePassRefundApplication.count({ where: { shopifyOrderId: orderId } })).toBe(2);
  });

  test('chave ligada: reembolso TOTAL marca o pedido REFUNDED; pedido legado (voucher sem unidade) segue o caminho legado', async () => {
    const campaign = await newCampaign(true);
    const payload = await issued(campaign, 1);
    const orderId = String(payload.id);
    flags.unitRefunds = true;
    const row = refundFor(campaign, orderId, 1);
    await runRefund(service(), row);
    await refunds.resolveReview((await prisma.valePassRefundApplication.findUniqueOrThrow({ where: { shopifyRefundId: row.id as string } })).id, { action: 'CANCEL_ACTIVE_VOUCHERS', note: 'Confirmado: unidade devolvida' }, { id: adminId, name: ADMIN_NAME });
    expect((await vouchersOf(orderId)).every((v) => v.status === 'CANCELLED')).toBe(true);

    const legacy = await newCampaign(false);
    const legacyPayload = paidPayload(legacy, 1);
    await run(service(), 'orders/paid', legacyPayload);
    await runRefund(service(), refundFor(legacy, String(legacyPayload.id), 1));
    expect((await vouchersOf(String(legacyPayload.id))).every((v) => v.status === 'CANCELLED')).toBe(true);
    expect(await prisma.valePassRefundApplication.count({ where: { shopifyOrderId: String(legacyPayload.id) } })).toBe(0);
    expect((await registryOf(String(legacyPayload.id))).status).toBe('REFUNDED');
  });

  test('reembolso ANTES da emissão (chaves ligadas): o pedido pago depois emite só as unidades não devolvidas', async () => {
    flags.twoVoucher = true;
    flags.unitRefunds = true;
    const campaign = await newCampaign(true);
    const base = paidPayload(campaign, 3);
    const orderId = String(base.id);
    await run(service(), 'orders/create', withStatus(base, 'pending', -3_000));
    await runRefund(service(), refundFor(campaign, orderId, 1));
    await run(service(), 'orders/paid', withStatus(base, 'paid', 2_000));
    // 3 pagas − 1 devolvida antes da emissão = 2 unidades (4 vouchers, 2 mensagens); a devolvida nunca recebe voucher e o pedido não é marcado como cancelado
    const rows = await vouchersOf(orderId);
    expect(rows).toHaveLength(4);
    expect(new Set(rows.map((v) => v.groupId)).size).toBe(2);
    expect(await outboxOf(orderId)).toHaveLength(2);
    expect(await holdsOf(orderId)).toHaveLength(0);
    expect(await prisma.valePassOrderCancellation.count({ where: { shopifyOrderId: orderId } })).toBe(0);
    expect((await registryOf(orderId)).status).toBe('CONFIRMED');
  });
});

localDescribe('alertas de prazo (3 dias)', () => {
  test('retenção cujo PAGAMENTO tem mais de 48 h → crítico "perto do prazo"; mais de 72 h → crítico "prazo vencido"; nova (< 24 h) sem alerta de prazo', async () => {
    const campaign = await newCampaign(true);
    const young = paidPayload(campaign, 1);
    const near = paidPayload(campaign, 1);
    const late = paidPayload(campaign, 1);
    for (const p of [young, near, late]) await run(service(), 'orders/paid', p);
    const age = (p: Record<string, unknown>, hours: number) => prisma.$transaction(async (tx) => { await tx.$executeRawUnsafe('SET LOCAL session_replication_role = replica'); await tx.$executeRawUnsafe(`UPDATE vale_pass_orders SET payment_confirmed_at = now() - interval '${hours} hours' WHERE shopify_order_id = '${String(p.id)}'`); });
    const codes = async () => (await lots.getCapacity(campaign.id)).alerts.map((a) => a.code);
    expect(await codes()).not.toContain('HOLD_NEAR_DEADLINE'); // todas novas
    expect(await codes()).not.toContain('HOLD_DEADLINE_EXCEEDED');
    await age(near, 50);
    const afterNear = await codes();
    expect(afterNear).toContain('HOLD_NEAR_DEADLINE');
    expect(afterNear).not.toContain('HOLD_DEADLINE_EXCEEDED');
    await age(late, 80);
    const afterLate = await codes();
    expect(afterLate).toEqual(expect.arrayContaining(['HOLD_NEAR_DEADLINE', 'HOLD_DEADLINE_EXCEEDED', 'INTEGRATION_HOLDS_OPEN', 'ISSUANCE_HOLD_STALE']));
    expect((await lots.getCapacity(campaign.id)).alerts.filter((a) => a.code.startsWith('HOLD_')).every((a) => a.severity === 'critical')).toBe(true);
  });
});


const hoursAgo = (hours: number) => new Date(Date.now() - hours * 3_600_000).toISOString();
const DAY = 86_400_000;
const storeStaff = async () => (await prisma.adminUser.create({ data: { name: 'Funcionário Teste Fluxo', phone: TAG + '-staff', pinHash: 'x', role: 'STAFF', active: true } })).id;

localDescribe('ALTO-1 — reembolso: pedido dos dois vouchers NUNCA cai no cancelamento integral, em nenhuma combinação das chaves', () => {
  const combos: [boolean, boolean][] = [[false, false], [false, true], [true, false], [true, true]];
  const refundKinds: [string, (campaign: Campaign, orderId: string) => Record<string, unknown>, number][] = [
    ['parcial (1 de 3 unidades)', (campaign, orderId) => refundFor(campaign, orderId, 1), 1],
    ['só de frete', (_campaign, orderId) => ({ id: TAG + '-rf' + counter++, order_id: orderId, refund_line_items: [], refund_shipping_lines: [{ id: 1, subtotal_amount_set: money('22.00') }], transactions: [], order_adjustments: [] }), 0],
    ['de outro produto', (_campaign, orderId) => ({ id: TAG + '-rf' + counter++, order_id: orderId, refund_shipping_lines: [], transactions: [], order_adjustments: [], refund_line_items: [{ id: 9, line_item_id: 9, quantity: 1, subtotal: 80, total_tax: 0, restock_type: 'return', line_item: { variant_id: 777000111, product_id: 555000222, price: '80.00', quantity: 1 } }] }), 0],
  ];
  for (const [two, unit] of combos) {
    for (const [label, build, refundedUnits] of refundKinds) {
      test('TWO_VOUCHER=' + (two ? 'on' : 'off') + ' / UNIT_REFUNDS=' + (unit ? 'on' : 'off') + ' — reembolso ' + label + ': nenhum voucher cancelado, pedido segue pago, fila de e-mail intacta, capacidade igual', async () => {
        flags.twoVoucher = true;
        const campaign = await newCampaign(true, { globalLimit: 10 });
        const payload = paidPayload(campaign, 3);
        const orderId = String(payload.id);
        await run(service(), 'orders/paid', payload);
        expect(await vouchersOf(orderId)).toHaveLength(6);
        const before = (await lots.getCapacity(campaign.id)).totals;
        flags.twoVoucher = two;
        flags.unitRefunds = unit;
        const refund = build(campaign, orderId);
        await runRefund(service(), refund);
        expect((await vouchersOf(orderId)).every((v) => v.status === 'ACTIVE')).toBe(true);
        expect(await prisma.valePassOrderCancellation.count({ where: { shopifyOrderId: orderId } })).toBe(0);
        expect((await registryOf(orderId)).status).toBe('CONFIRMED');
        expect((await outboxOf(orderId)).every((row) => row.status === 'QUEUED')).toBe(true);
        expect((await outboxOf(orderId))).toHaveLength(3);
        expect((await lots.getCapacity(campaign.id)).totals.consumed).toBe(before.consumed);
        const row = await prisma.valePassRefundApplication.findUniqueOrThrow({ where: { shopifyRefundId: refund.id as string } });
        expect(row.refundedUnits).toBe(refundedUnits);
        expect(row.status).toBe(refundedUnits > 0 ? 'NEEDS_REVIEW' : 'APPLIED');
        await runRefund(service(), refund); // reentrega: nada muda
        expect(await prisma.valePassRefundApplication.count({ where: { shopifyOrderId: orderId } })).toBe(1);
        expect((await vouchersOf(orderId)).every((v) => v.status === 'ACTIVE')).toBe(true);
      });
    }
  }

  test('pagamento RETIDO (TWO_VOUCHER desligada) + reembolso parcial com UNIT_REFUNDS desligada: a retenção continua, nada vira "cancelado"; ao ligar, a emissão desconta a unidade devolvida antes da emissão', async () => {
    const campaign = await newCampaign(true);
    const payload = paidPayload(campaign, 3);
    const orderId = String(payload.id);
    flags.twoVoucher = false;
    await run(service(), 'orders/paid', payload);
    await storeEvent('orders/paid', payload);
    const refund = refundFor(campaign, orderId, 1);
    await runRefund(service(), refund);
    expect(await prisma.valePassOrderCancellation.count({ where: { shopifyOrderId: orderId } })).toBe(0);
    expect((await holdsOf(orderId))[0]).toMatchObject({ status: 'OPEN', units: 3 });
    // unidade paga e AINDA NÃO emitida: o reembolso é registrado na trilha e descontado da emissão futura (nenhum voucher existe para cancelar)
    const application = await prisma.valePassRefundApplication.findUniqueOrThrow({ where: { shopifyRefundId: refund.id as string } });
    expect((application.detail as { unissuedAbsorbed?: number }).unissuedAbsorbed).toBe(1);
    flags.twoVoucher = true;
    const report = await flowService().resumeHeldPayments({ id: adminId, name: ADMIN_NAME }, { limit: 5 });
    expect(report.issued).toBe(1);
    expect(new Set((await vouchersOf(orderId)).map((v) => v.groupId)).size).toBe(2); // 3 pagas − 1 devolvida
  });

  test('os avisos das chaves nunca sugerem que desligar uma chave cancela algo, e a combinação TWO on / UNIT off é explicada como segura', () => {
    expect(flagNotices({ twoVoucherFlow: true, unitRefunds: false }).join(' ')).toMatch(/SEMPRE por unidade/);
    expect(flagNotices({ twoVoucherFlow: false, unitRefunds: false }).join(' ')).toMatch(/continuam sendo tratados/);
    expect(flagNotices({ twoVoucherFlow: true, unitRefunds: true })).toEqual([]);
  });
});

localDescribe('ALTO-2 — o prazo de 3 dias conta do PAGAMENTO real (X-Shopify-Triggered-At do orders/paid), nunca do processamento', () => {
  test('webhook 80 h atrasado com a chave LIGADA: emite, mas o prazo do e-mail é pagamento + 3 dias (JÁ vencido), não processamento + 3 dias', async () => {
    flags.twoVoucher = true;
    const campaign = await newCampaign(true);
    const paidAt = hoursAgo(80);
    const payload = paidPayload(campaign, 1, { created_at: hoursAgo(81) });
    await runAt(service(), payload, paidAt);
    const orderId = String(payload.id);
    expect(await vouchersOf(orderId)).toHaveLength(2);
    expect((await registryOf(orderId)).paymentConfirmedAt?.toISOString()).toBe(paidAt);
    const [mail] = await outboxOf(orderId);
    expect(mail.deadlineAt.getTime()).toBe(new Date(paidAt).getTime() + 3 * DAY);
    expect(mail.deadlineAt.getTime()).toBeLessThan(Date.now()); // já venceu: o painel de e-mails mostra "atrasado"
    const event = await prisma.valePassEmailEvent.findFirstOrThrow({ where: { outboxId: mail.id, type: 'ENQUEUED' } });
    expect((event.detail as { deadlineBasis?: string }).deadlineBasis).toBe('PAYMENT');
  });

  test('webhook 80 h atrasado com a chave DESLIGADA: a retenção JÁ nasce com os alertas de prazo vencido (idade desde o pagamento, não desde a retenção)', async () => {
    flags.twoVoucher = false;
    const campaign = await newCampaign(true);
    const payload = paidPayload(campaign, 1, { created_at: hoursAgo(81) });
    await runAt(service(), payload, hoursAgo(80));
    const capacity = await lots.getCapacity(campaign.id);
    const codes = capacity.alerts.map((a) => a.code);
    expect(codes).toEqual(expect.arrayContaining(['HOLD_DEADLINE_EXCEEDED', 'ISSUANCE_HOLD_STALE', 'INTEGRATION_HOLDS_OPEN']));
    expect(codes).not.toContain('PAYMENT_TIME_UNKNOWN');
    expect(capacity.holds[0].paymentConfirmedAt).toBe((await registryOf(String(payload.id))).paymentConfirmedAt?.toISOString());
  });

  test('pagamento entre 48 h e 72 h: alerta "perto do prazo"; menos de 24 h: nenhum alerta de prazo', async () => {
    flags.twoVoucher = false;
    const campaign = await newCampaign(true);
    const fresh = paidPayload(campaign, 1);
    await runAt(service(), fresh, hoursAgo(2));
    const afterFresh = (await lots.getCapacity(campaign.id)).alerts.map((a) => a.code);
    expect(afterFresh).not.toEqual(expect.arrayContaining(['HOLD_NEAR_DEADLINE']));
    const near = paidPayload(campaign, 1, { created_at: hoursAgo(60) });
    await runAt(service(), near, hoursAgo(55));
    const codes = (await lots.getCapacity(campaign.id)).alerts.map((a) => a.code);
    expect(codes).toContain('HOLD_NEAR_DEADLINE');
    expect(codes).not.toContain('HOLD_DEADLINE_EXCEEDED');
  });

  test.each([
    ['cabeçalho ausente', null],
    ['cabeçalho vazio', '   '],
    ['texto que não é data', 'ontem à noite'],
    ['data sem fuso', '2026-10-18T10:00:00'],
    ['data impossível', '2026-13-45T00:00:00Z'],
    ['instante no futuro', new Date(Date.now() + 3_600_000).toISOString()],
    ['instante ANTERIOR à criação do pedido', new Date(Date.now() - 10 * 3_600_000).toISOString()],
  ])('instante do pagamento não confiável (%s): nada é emitido, nenhum horário é inventado, a retenção e o alerta crítico aparecem', async (_label, header) => {
    flags.twoVoucher = true;
    const campaign = await newCampaign(true);
    const payload = paidPayload(campaign, 1, { created_at: hoursAgo(1) });
    const events = await run(service(), 'orders/paid', payload, { triggeredAt: header as string | null });
    const orderId = String(payload.id);
    expect(events.map((e) => e.type)).toEqual(expect.arrayContaining(['VALE_PASS_PAYMENT_INSTANT_UNRELIABLE', 'VALE_PASS_ISSUANCE_HELD']));
    expect(await vouchersOf(orderId)).toHaveLength(0);
    expect(await outboxOf(orderId)).toHaveLength(0);
    expect((await registryOf(orderId)).paymentConfirmedAt).toBeNull();
    expect(issueCodes((await holdsOf(orderId))[0])).toEqual(['PAYMENT_TIME_UNKNOWN']);
    expect((await lots.getCapacity(campaign.id)).alerts.find((a) => a.code === 'PAYMENT_TIME_UNKNOWN')).toMatchObject({ severity: 'critical' });
  });

  test('o instante NÃO vem de orders/updated nem de orders/create (atualização genérica ≠ pagamento), mesmo com o cabeçalho válido', async () => {
    flags.twoVoucher = true;
    const campaign = await newCampaign(true);
    const base = paidPayload(campaign, 1, { created_at: hoursAgo(5) });
    const orderId = String(base.id);
    await run(service(), 'orders/create', withStatus(base, 'pending', -1_000), { triggeredAt: hoursAgo(4) });
    await run(service(), 'orders/updated', withStatus(base, 'paid', 1_000), { triggeredAt: hoursAgo(3) });
    expect((await registryOf(orderId)).paymentConfirmedAt).toBeNull();
    expect(await vouchersOf(orderId)).toHaveLength(0);
    expect(issueCodes((await holdsOf(orderId))[0])).toEqual(['PAYMENT_TIME_UNKNOWN']);
  });

  test('vale o instante MAIS ANTIGO: reentrega ou segundo orders/paid mais tarde nunca empurra o prazo para frente; um mais antigo o corrige', async () => {
    flags.twoVoucher = false;
    const campaign = await newCampaign(true);
    const payload = paidPayload(campaign, 1, { created_at: hoursAgo(10) });
    const orderId = String(payload.id);
    await runAt(service(), payload, hoursAgo(5));
    const first = (await registryOf(orderId)).paymentConfirmedAt as Date;
    await runAt(service(), payload, hoursAgo(1));
    expect((await registryOf(orderId)).paymentConfirmedAt).toEqual(first);
    await runAt(service(), payload, hoursAgo(6));
    expect((await registryOf(orderId)).paymentConfirmedAt?.getTime()).toBeLessThan(first.getTime());
  });

  test('reconciliação tardia (sem orders/paid): pedido pago fica retido como PAYMENT_TIME_UNKNOWN; quando o orders/paid chega, a retomada emite com o prazo do pagamento', async () => {
    flags.twoVoucher = true;
    const campaign = await newCampaign(true);
    const base = paidPayload(campaign, 1, { created_at: hoursAgo(30) });
    const orderId = String(base.id);
    await run(service(), 'orders/updated', withStatus(base, 'paid', 0));
    await storeEvent('orders/updated', withStatus(base, 'paid', 0));
    expect(issueCodes((await holdsOf(orderId))[0])).toEqual(['PAYMENT_TIME_UNKNOWN']);
    expect(await vouchersOf(orderId)).toHaveLength(0);
    const report0 = await flowService().resumeHeldPayments({ id: adminId, name: ADMIN_NAME });
    expect(report0).toMatchObject({ considered: 1, issued: 0, reclassified: 1 }); // sem o instante, continua retido
    const paidAt = hoursAgo(29);
    await prisma.valePassOrder.update({ where: { shopifyOrderId: orderId }, data: { paymentConfirmedAt: new Date(paidAt) } }); // o instante chegou (ex.: orders/paid atrasado)
    const report = await flowService().resumeHeldPayments({ id: adminId, name: ADMIN_NAME });
    expect(report).toMatchObject({ considered: 1, issued: 1 });
    expect(await vouchersOf(orderId)).toHaveLength(2);
    expect((await outboxOf(orderId))[0].deadlineAt.getTime()).toBe(new Date(paidAt).getTime() + 3 * DAY);
  });
});

localDescribe('MÉDIO-1/2 — pagamento sem tratamento: variante sem campanha e aumento de quantidade viram pendência rastreável e regularização ADMIN auditada', () => {
  const prodLine = (variant: number, quantity: number) => ({ variant_id: variant, product_id: Number(KNOWN_VALE_PASS_PRODUCT_ID), quantity, current_quantity: quantity, price: '350.00', price_set: money('350.00'), discount_allocations: [] });
  async function campaignFor(variant: string): Promise<Campaign> {
    const campaign = await prisma.valePassCampaign.create({
      data: { name: TAG + '-camp-' + counter++, amountCents: 35_000, validityDays: 30, globalLimit: 1_000, shopifyVariantId: variant, voucherValidFrom: new Date('2026-01-01T00:00:00.000Z'), voucherValidUntil: new Date('2027-12-31T00:00:00.000Z') },
    });
    campaignIds.push(campaign.id);
    await prisma.valePassCampaignBenefit.createMany({
      data: [
        { campaignId: campaign.id, code: 'valle_showroom_500', kind: 'VOUCHER', company: 'VALLE_SHOWROOM', label: 'Voucher Valle Showroom', amountCents: 50_000, sortOrder: 0 },
        { campaignId: campaign.id, code: 'vs_by_closet_50', kind: 'VOUCHER', company: 'VS_BY_CLOSET', label: 'Voucher VS BY CLOSET', amountCents: 5_000, sortOrder: 1 },
      ],
    });
    return { ...campaign, numericVariant: variant };
  }
  const increased = (payload: Record<string, unknown>, variant: number, quantity: number, total: string, offset = 4_000) => ({ ...payload, line_items: [prodLine(variant, quantity)], current_total_price: total, updated_at: new Date(clock + offset).toISOString() });

  test('NOVA variante do produto Valle Pass sem campanha: pedido pago fica visível em "pagamentos sem tratamento"; regularizar antes de existir campanha não faz nada; com a campanha cadastrada, emite com validação e e-mail enfileirado', async () => {
    flags.twoVoucher = true;
    const variant = 920_000_000_000 + counter++;
    const payload: Record<string, unknown> = { ...paidPayload({ numericVariant: String(variant) } as Campaign, 2), line_items: [prodLine(variant, 2)] };
    const orderId = String(payload.id);
    const events = await run(service(), 'orders/paid', payload);
    expect(events.map((e) => e.type)).toContain('VALE_PASS_ORDER_WITHOUT_CAMPAIGN');
    expect(await vouchersOf(orderId)).toHaveLength(0);
    expect((await registryOf(orderId)).status).toBe('CONFIRMED');
    const overview = await flowService().overview();
    expect(overview.ordersWithoutTreatment.map((o) => o.orderId)).toContain(orderId);
    expect(overview.unitsWithoutTreatment).toBeGreaterThanOrEqual(2);
    await storeEvent('orders/paid', payload);
    const none = await flowService().regularizeOrder({ id: adminId, name: ADMIN_NAME }, { orderId, note: 'Tentativa antes de existir campanha' });
    expect(none.outcome.status).toBe('CAMPAIGN_UNRESOLVED');
    expect(await vouchersOf(orderId)).toHaveLength(0);
    await campaignFor(String(variant)); // a campanha passa a existir
    const done = await flowService().regularizeOrder({ id: adminId, name: ADMIN_NAME }, { orderId, note: 'Campanha cadastrada; pagamento conferido na Shopify' });
    expect(done.outcome).toMatchObject({ status: 'ISSUED', issuedUnits: 2, vouchersCreated: 4 });
    expect(done.emailsQueued).toBe(2);
    expect(await vouchersOf(orderId)).toHaveLength(4);
    expect(await outboxOf(orderId)).toHaveLength(2);
    const audit = await prisma.adminAuditEvent.findFirstOrThrow({ where: { adminUserId: adminId, action: 'VALE_PASS_ORDER_REGULARIZED' } });
    expect(audit).toMatchObject({ isCritical: true });
    expect(JSON.stringify(audit.detail)).toContain('Campanha cadastrada');
    const again = await flowService().regularizeOrder({ id: adminId, name: ADMIN_NAME }, { orderId, note: 'Segunda tentativa (idempotente)' });
    expect(again.outcome.status).toBe('NOTHING_TO_DO');
    expect(await vouchersOf(orderId)).toHaveLength(4);
    expect(await outboxOf(orderId)).toHaveLength(2);
    expect((await flowService().overview()).ordersWithoutTreatment.map((o) => o.orderId)).not.toContain(orderId);
  });

  test('compra que CRESCEU depois da emissão (2 → 3): retenção QUANTITY_INCREASED visível, nada emitido sozinho; a regularização ADMIN valida o pagamento do acréscimo e emite só a unidade que falta (+1 e-mail)', async () => {
    flags.twoVoucher = true;
    const campaign = await newCampaign(true);
    const variant = Number(campaign.numericVariant);
    const payload = paidPayload(campaign, 2);
    const orderId = String(payload.id);
    await run(service(), 'orders/paid', payload);
    expect(await vouchersOf(orderId)).toHaveLength(4);
    const edit = increased(payload, variant, 3, '1050.00');
    const events = await run(service(), 'orders/updated', edit);
    expect(events.map((e) => e.type)).toContain('VALE_PASS_QUANTITY_INCREASE_HELD');
    expect(await vouchersOf(orderId)).toHaveLength(4); // nada emitido sozinho
    const holds = await holdsOf(orderId);
    expect(holds).toHaveLength(1);
    expect(holds[0]).toMatchObject({ status: 'OPEN', units: 1, reason: 'FINANCIAL_MISMATCH' });
    expect(issueCodes(holds[0])).toEqual(['QUANTITY_INCREASED']);
    expect((await flowService().overview()).byCause.quantityIncreased).toBeGreaterThanOrEqual(1);
    await run(service(), 'orders/updated', edit); // reentrega: continua UMA retenção
    expect(await holdsOf(orderId)).toHaveLength(1);

    await storeEvent('orders/updated', edit);
    const done = await flowService().regularizeOrder({ id: adminId, name: ADMIN_NAME }, { orderId, note: 'Pagamento do acréscimo conferido na Shopify' });
    expect(done.outcome).toMatchObject({ status: 'ISSUED', vouchersCreated: 2 });
    expect(await vouchersOf(orderId)).toHaveLength(6);
    expect(new Set((await vouchersOf(orderId)).map((v) => v.groupId)).size).toBe(3);
    expect(await outboxOf(orderId)).toHaveLength(3); // exatamente um e-mail inicial por unidade; as 2 primeiras não foram duplicadas
    expect((await holdsOf(orderId))[0].status).not.toBe('OPEN');
  });

  test('regularização concorrente (duas chamadas simultâneas): exatamente +1 unidade e +1 e-mail', async () => {
    flags.twoVoucher = true;
    const campaign = await newCampaign(true);
    const variant = Number(campaign.numericVariant);
    const payload = paidPayload(campaign, 2);
    const orderId = String(payload.id);
    await run(service(), 'orders/paid', payload);
    const edit = increased(payload, variant, 3, '1050.00');
    await run(service(), 'orders/updated', edit);
    await storeEvent('orders/updated', edit);
    const results = await Promise.allSettled(Array.from({ length: 4 }, () => flowService().regularizeOrder({ id: adminId, name: ADMIN_NAME }, { orderId, note: 'Regularização concorrente de teste' })));
    expect(results.filter((r) => r.status === 'fulfilled' && (r.value as { outcome: { status: string } }).outcome.status === 'ISSUED')).toHaveLength(1);
    expect(await vouchersOf(orderId)).toHaveLength(6);
    expect(await outboxOf(orderId)).toHaveLength(3);
  });

  test('NÃO emite sem comprovante: valor do acréscimo não pago, último evento não pago, sem evento guardado, sem instante do pagamento, chave desligada, funcionário comum ou justificativa curta', async () => {
    flags.twoVoucher = true;
    const campaign = await newCampaign(true);
    const variant = Number(campaign.numericVariant);
    const payload = paidPayload(campaign, 2);
    const orderId = String(payload.id);
    await run(service(), 'orders/paid', payload);
    const actor = { id: adminId, name: ADMIN_NAME };
    const note = 'Conferência administrativa de teste';
    // aumento de quantidade, mas o total pago continua o antigo (acréscimo NÃO pago) → vira retenção com o motivo financeiro, nada emitido
    const unpaid = increased(payload, variant, 3, '700.00');
    await run(service(), 'orders/updated', unpaid);
    await storeEvent('orders/updated', unpaid);
    const held = await flowService().regularizeOrder(actor, { orderId, note });
    expect(held.outcome.status).toBe('HELD');
    expect(await vouchersOf(orderId)).toHaveLength(4);
    expect(issueCodes((await holdsOf(orderId))[0]).length).toBeGreaterThan(0);
    // último evento guardado não está pago
    await storeEvent('orders/updated', { ...increased(payload, variant, 3, '1050.00', 9_000), financial_status: 'partially_paid' });
    await expect(flowService().regularizeOrder(actor, { orderId, note })).rejects.toBeInstanceOf(ConflictException);
    // sem evento guardado
    const bare = paidPayload(campaign, 1);
    await run(service(), 'orders/paid', bare);
    await prisma.valePassOrder.update({ where: { shopifyOrderId: String(bare.id) }, data: { quantity: 2 } });
    await expect(flowService().regularizeOrder(actor, { orderId: String(bare.id), note })).rejects.toThrow(/Nenhum evento/);
    // sem instante do pagamento
    await prisma.valePassOrder.update({ where: { shopifyOrderId: String(bare.id) }, data: { paymentConfirmedAt: null } });
    await expect(flowService().regularizeOrder(actor, { orderId: String(bare.id), note })).rejects.toThrow(/instante real do pagamento/);
    // funcionário comum, justificativa curta, chave desligada, pedido inexistente
    const staffId = await storeStaff();
    try {
      await expect(flowService().regularizeOrder({ id: staffId, name: 'x' }, { orderId, note })).rejects.toBeInstanceOf(ForbiddenException);
    } finally {
      await prisma.adminUser.delete({ where: { id: staffId } });
    }
    await expect(flowService().regularizeOrder(actor, { orderId, note: 'curta' })).rejects.toBeInstanceOf(UnprocessableEntityException);
    await expect(flowService().regularizeOrder(actor, { orderId: 'nao-existe', note })).rejects.toThrow(/não encontrado/);
    flags.twoVoucher = false;
    await expect(flowService().regularizeOrder(actor, { orderId, note })).rejects.toBeInstanceOf(ConflictException);
    expect(await vouchersOf(orderId)).toHaveLength(4);
    const proto = ValePassFlowController.prototype as unknown as Record<string, unknown>;
    expect(Reflect.getMetadata(REQUIRE_ROLE_KEY, proto.regularize as object)).toBe('ADMIN');
  });

  test('pedido de Valle Pass cancelado/reembolsado, excluído ou LEGADO nunca é regularizado; legado e limites da campanha seguem como eram', async () => {
    flags.twoVoucher = true;
    const legacy = await newCampaign(false);
    const lp = paidPayload(legacy, 1);
    await run(service(), 'orders/paid', lp);
    await storeEvent('orders/paid', lp);
    expect((await vouchersOf(String(lp.id))).every((v) => v.groupId === null)).toBe(true);
    // o pedido legado não usa o horário do pagamento (nada é gravado para ele) e a regularização o recusa
    expect((await registryOf(String(lp.id))).paymentTimeEvidence).toBeNull();
    await expect(flowService().regularizeOrder({ id: adminId, name: ADMIN_NAME }, { orderId: String(lp.id), note: 'Pedido legado: não regulariza' })).rejects.toBeInstanceOf(ConflictException);
    expect(await vouchersOf(String(lp.id))).toHaveLength(1);
    expect((await flowService().overview()).ordersWithoutTreatment.map((o) => o.orderId)).not.toContain(String(lp.id));
  });
});

localDescribe('MÉDIO-3 — a emissão excepcional do ADMIN registra a mensagem de e-mail na MESMA transação (sem enviar), uma por unidade', () => {
  test('retenção por capacidade: ao emitir com justificativa, 1 mensagem por unidade; repetir não duplica; a base do prazo é o pagamento', async () => {
    flags.twoVoucher = true;
    const campaign = await newCampaign(true, { globalLimit: 1 });
    const payload = paidPayload(campaign, 2);
    const orderId = String(payload.id);
    const paidAt = hoursAgo(10);
    await runAt(service(), { ...payload, created_at: hoursAgo(11) }, paidAt);
    const [hold] = await holdsOf(orderId);
    expect(hold.reason).toBe('CAPACITY_EXCEEDED');
    expect(await outboxOf(orderId)).toHaveLength(0);
    await prisma.valePassCampaign.update({ where: { id: campaign.id }, data: { globalLimit: 2 } });
    const preview = await holdsService.preview(hold.id);
    const input: IssueHoldInput = { note: 'Capacidade revisada pela diretoria (teste)', confirmTotal: preview.projectedTotal, expected: { projectedTotal: preview.projectedTotal, consumedTotal: preview.consumedBefore, globalLimit: preview.globalLimit, capacityLimit: preview.capacityLimit, holdUpdatedAt: preview.holdUpdatedAt } };
    await holdsService.issue(hold.id, input, adminId, ADMIN_NAME);
    expect(await vouchersOf(orderId)).toHaveLength(4);
    const rows = await outboxOf(orderId);
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.status === 'QUEUED' && row.kind === 'INITIAL')).toBe(true);
    expect(new Set(rows.map((row) => row.groupId)).size).toBe(2);
    expect(rows[0].deadlineAt.toISOString()).toBe(new Date(new Date(paidAt).getTime() + 3 * DAY).toISOString());
    const audit = await prisma.adminAuditEvent.findFirstOrThrow({ where: { adminUserId: adminId, action: 'VALE_PASS_HOLD_ISSUED' } });
    expect((audit.detail as { emailsQueued?: number }).emailsQueued).toBe(2);
    const again = await prisma.$transaction((tx) => outbox.enqueueForOrder(tx, orderId));
    expect(again).toMatchObject({ enqueued: 0, alreadyQueued: 2 });
    await expect(holdsService.issue(hold.id, { ...input, note: 'segunda emissão do mesmo pedido' }, adminId, ADMIN_NAME)).rejects.toBeInstanceOf(ConflictException);
    expect(await outboxOf(orderId)).toHaveLength(2);
    expect(await vouchersOf(orderId)).toHaveLength(4);
  });

  test('sem o instante do pagamento, a base do prazo é o momento em que a retenção foi aberta (registrada na linha do tempo), nunca um horário inventado', async () => {
    flags.twoVoucher = true;
    const campaign = await newCampaign(true);
    const base = paidPayload(campaign, 1, { created_at: hoursAgo(3) });
    const orderId = String(base.id);
    await run(service(), 'orders/updated', withStatus(base, 'paid', 0)); // pagamento visto só por orders/updated
    const [hold] = await holdsOf(orderId);
    expect(issueCodes(hold)).toEqual(['PAYMENT_TIME_UNKNOWN']);
    const preview = await holdsService.preview(hold.id);
    await holdsService.issue(hold.id, { note: 'Pagamento conferido na Shopify (teste)', confirmTotal: preview.projectedTotal, expected: { projectedTotal: preview.projectedTotal, consumedTotal: preview.consumedBefore, globalLimit: preview.globalLimit, capacityLimit: preview.capacityLimit, holdUpdatedAt: preview.holdUpdatedAt } }, adminId, ADMIN_NAME);
    const [mail] = await outboxOf(orderId);
    expect(mail.deadlineAt.getTime()).toBe(hold.createdAt.getTime() + 3 * DAY);
    const event = await prisma.valePassEmailEvent.findFirstOrThrow({ where: { outboxId: mail.id, type: 'ENQUEUED' } });
    expect((event.detail as { deadlineBasis?: string }).deadlineBasis).toBe('HOLD_OPENED');
  });
});

localDescribe('MÉDIO-4 — a auditoria da retomada é gravada na MESMA transação da emissão (uma linha por pedido)', () => {
  test('cada pedido retomado tem o seu evento VALE_PASS_HOLD_RESUMED (crítico) com a retenção e o desfecho', async () => {
    const campaign = await newCampaign(true);
    flags.twoVoucher = false;
    const payload = paidPayload(campaign, 1);
    await run(service(), 'orders/paid', payload);
    await storeEvent('orders/paid', payload);
    flags.twoVoucher = true;
    await flowService().resumeHeldPayments({ id: adminId, name: ADMIN_NAME }, { note: 'Retomada de teste da auditoria' });
    const [hold] = await holdsOf(String(payload.id));
    const audit = await prisma.adminAuditEvent.findFirstOrThrow({ where: { adminUserId: adminId, action: 'VALE_PASS_HOLD_RESUMED', entityId: hold.id } });
    expect(audit).toMatchObject({ isCritical: true });
    expect((audit.after as { outcome?: string }).outcome).toBe('ISSUED');
  });

  test('se a auditoria falhar (ADMIN inexistente), a emissão do pedido é DESFEITA junto: nada de voucher sem trilha; a retenção continua aberta', async () => {
    const campaign = await newCampaign(true);
    flags.twoVoucher = false;
    const payload = paidPayload(campaign, 1);
    await run(service(), 'orders/paid', payload);
    await storeEvent('orders/paid', payload);
    flags.twoVoucher = true;
    await expect(flowService().resumeHeldPayments({ id: '00000000-0000-4000-8000-00000000dead', name: 'Fantasma' }, { note: 'Retomada com ator inexistente' })).rejects.toThrow();
    expect(await vouchersOf(String(payload.id))).toHaveLength(0);
    expect(await outboxOf(String(payload.id))).toHaveLength(0);
    expect((await holdsOf(String(payload.id)))[0].status).toBe('OPEN');
  });
});

localDescribe('GET /admin/vale-pass/flow — estado das duas chaves e pendências (retidos × unidades pendentes × e-mails aguardando)', () => {
  test('mostra as chaves, os avisos, as retenções por causa, as unidades sem tratamento e os e-mails aguardando envio — sem dados pessoais', async () => {
    const campaign = await newCampaign(true);
    flags.twoVoucher = false;
    await run(service(), 'orders/paid', paidPayload(campaign, 2)); // retido (integração desligada)
    flags.twoVoucher = true;
    await run(service(), 'orders/paid', paidPayload(campaign, 1)); // emitido: 1 e-mail QUEUED
    const status = await new ValePassFlowController(flowService(), prisma, paymentTimeService(), operationalAlerts).status();
    expect(status).toMatchObject({ twoVoucherFlow: true, unitRefunds: false });
    expect(status.notices.join(' ')).toMatch(/SEMPRE por unidade/);
    expect(status.byCause.integrationDisabled).toBeGreaterThanOrEqual(1);
    expect(status.heldPayments).toBeGreaterThanOrEqual(1);
    expect(status.heldUnits).toBeGreaterThanOrEqual(2);
    expect(status.emails.awaitingSend).toBeGreaterThanOrEqual(1);
    expect(JSON.stringify(status)).not.toMatch(/cliente\d+@exemplo/);
    flags.twoVoucher = false;
    expect((await new ValePassFlowController(flowService(), prisma, paymentTimeService(), operationalAlerts).status()).twoVoucherFlow).toBe(false);
  });
});

localDescribe('pipeline REAL (WebhooksController → WebhooksService → Valle Pass): o cabeçalho X-Shopify-Triggered-At chega ao registro e ao prazo; reembolso passa pelo tratamento por unidade', () => {
  const SECRET = 'segredo-de-teste-' + TAG;
  const saved = { secret: process.env.SHOPIFY_CLIENT_SECRET, domain: process.env.SHOPIFY_STORE_DOMAIN, currency: process.env.SHOPIFY_STORE_CURRENCY };
  const controller = () => new WebhooksController(new WebhooksService(prisma, service(), new ShopifyOrderSyncService()));
  beforeAll(() => {
    process.env.SHOPIFY_CLIENT_SECRET = SECRET;
    process.env.SHOPIFY_STORE_DOMAIN = PIPELINE_STORE;
    process.env.SHOPIFY_STORE_CURRENCY = 'BRL';
  });
  afterAll(() => {
    for (const [key, value] of [['SHOPIFY_CLIENT_SECRET', saved.secret], ['SHOPIFY_STORE_DOMAIN', saved.domain], ['SHOPIFY_STORE_CURRENCY', saved.currency]] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  const deliver = (topic: string, body: unknown, webhookId: string, triggeredAt?: string) => {
    const raw = Buffer.from(JSON.stringify(triggeredAt && topic === 'orders/paid' ? { ...(body as Record<string, unknown>), updated_at: triggeredAt } : body), 'utf8');
    const hmac = createHmac('sha256', SECRET).update(raw).digest('base64');
    return controller().receive({ rawBody: raw } as never, hmac, topic, webhookId, PIPELINE_STORE, triggeredAt);
  };

  test('orders/paid atrasado 80 h: o instante do cabeçalho vira o prazo; a reentrega do mesmo webhook não duplica nada; sem o cabeçalho o pedido fica retido', async () => {
    flags.twoVoucher = true;
    const campaign = await newCampaign(true);
    const paidAt = hoursAgo(80);
    const payload = paidPayload(campaign, 1, { created_at: hoursAgo(81) });
    const orderId = String(payload.id);
    await deliver('orders/paid', payload, TAG + '-hook-' + counter++, paidAt);
    expect(await vouchersOf(orderId)).toHaveLength(2);
    expect((await registryOf(orderId)).paymentConfirmedAt?.toISOString()).toBe(paidAt);
    expect((await outboxOf(orderId))[0].deadlineAt.getTime()).toBe(new Date(paidAt).getTime() + 3 * DAY);
    const sameHook = TAG + '-hook-' + counter++;
    const second = paidPayload(campaign, 1);
    await deliver('orders/paid', second, sameHook); // sem o cabeçalho
    await deliver('orders/paid', second, sameHook, hoursAgo(1)); // reentrega do MESMO webhook: ignorada como duplicada
    expect(await vouchersOf(String(second.id))).toHaveLength(0);
    expect((await registryOf(String(second.id))).paymentConfirmedAt).toBeNull();
    expect(issueCodes((await holdsOf(String(second.id)))[0])).toEqual(['PAYMENT_TIME_UNKNOWN']);
  });

  test('refunds/create parcial pelo pipeline completo, TWO_VOUCHER ligada e UNIT_REFUNDS desligada: nenhum voucher cancelado', async () => {
    flags.twoVoucher = true;
    const campaign = await newCampaign(true);
    const payload = paidPayload(campaign, 2);
    const orderId = String(payload.id);
    await deliver('orders/paid', payload, TAG + '-hook-' + counter++, new Date().toISOString());
    expect(await vouchersOf(orderId)).toHaveLength(4);
    await deliver('refunds/create', refundFor(campaign, orderId, 1), TAG + '-hook-' + counter++, new Date().toISOString());
    expect((await vouchersOf(orderId)).every((v) => v.status === 'ACTIVE')).toBe(true);
    expect((await registryOf(orderId)).status).toBe('CONFIRMED');
    expect(await prisma.valePassRefundApplication.count({ where: { shopifyOrderId: orderId } })).toBe(1);
  });
});

localDescribe('concorrência e fora de ordem com o instante do pagamento', () => {
  test('8 entregas simultâneas do orders/paid com instantes DIFERENTES (+ orders/updated no meio): uma emissão, 1 e-mail por unidade e vale o instante mais antigo', async () => {
    flags.twoVoucher = true;
    const campaign = await newCampaign(true);
    const payload = paidPayload(campaign, 2, { created_at: hoursAgo(30) });
    const orderId = String(payload.id);
    const instants = [20, 5, 12, 26, 1, 9, 15, 3].map(hoursAgo);
    await Promise.all([
      ...instants.map((at) => runAt(service(), payload, at)),
      run(service(), 'orders/updated', withStatus(payload, 'paid', 3_000)),
    ]);
    expect(await vouchersOf(orderId)).toHaveLength(4);
    expect(await outboxOf(orderId)).toHaveLength(2);
    expect(await holdsOf(orderId)).toHaveLength(0);
    const oldest = Math.min(...instants.map((at) => new Date(at).getTime()));
    expect((await registryOf(orderId)).paymentConfirmedAt?.getTime()).toBe(oldest);
  });

  test('o orders/paid de OUTRO pedido nunca empresta o instante: cada pedido tem o seu', async () => {
    flags.twoVoucher = true;
    const campaign = await newCampaign(true);
    const a = paidPayload(campaign, 1, { created_at: hoursAgo(50) });
    const b = paidPayload(campaign, 1, { created_at: hoursAgo(5) });
    await Promise.all([runAt(service(), a, hoursAgo(48)), runAt(service(), b, hoursAgo(4))]);
    const [ra, rb] = await Promise.all([registryOf(String(a.id)), registryOf(String(b.id))]);
    expect(rb.paymentConfirmedAt!.getTime() - ra.paymentConfirmedAt!.getTime()).toBeGreaterThan(40 * 3_600_000);
  });
});

localDescribe('D1 — pedido LEGADO (voucher sem unidade) segue o caminho antigo mesmo se a campanha ganhou benefícios depois da compra', () => {
  const addBenefits = (campaignId: string) =>
    prisma.valePassCampaignBenefit.createMany({
      data: [
        { campaignId, code: 'valle_showroom_500', kind: 'VOUCHER', company: 'VALLE_SHOWROOM', label: 'Voucher Valle Showroom', amountCents: 50_000, sortOrder: 0 },
        { campaignId, code: 'vs_by_closet_50', kind: 'VOUCHER', company: 'VS_BY_CLOSET', label: 'Voucher VS BY CLOSET', amountCents: 5_000, sortOrder: 1 },
      ],
    });
  const snapshot = async (orderId: string) => ({
    registry: (await registryOf(orderId)).status,
    vouchers: (await vouchersOf(orderId)).map((v) => v.status),
    grouped: (await vouchersOf(orderId)).some((v) => v.groupId !== null),
    cancellations: await prisma.valePassOrderCancellation.count({ where: { shopifyOrderId: orderId } }),
    ledger: await prisma.valePassRefundApplication.count({ where: { shopifyOrderId: orderId } }),
    holds: (await holdsOf(orderId)).length,
  });
  /** Mesma sequência de webhooks em duas campanhas: a que NUNCA teve benefícios (controle) e a que os recebeu DEPOIS da compra. */
  async function bothWays(sequence: (campaign: Campaign, payload: Record<string, unknown>, orderId: string) => Promise<void>, quantity = 2) {
    const control = await newCampaign(false);
    const late = await newCampaign(false);
    const out: Record<string, Awaited<ReturnType<typeof snapshot>>> = {};
    for (const [label, campaign] of [['controle', control], ['benefícios depois', late]] as const) {
      const payload = paidPayload(campaign, quantity);
      const orderId = String(payload.id);
      await run(service(), 'orders/paid', payload);
      if (label === 'benefícios depois') await addBenefits(late.id);
      await sequence(campaign, payload, orderId);
      out[label] = await snapshot(orderId);
    }
    return out;
  }

  for (const unit of [false, true]) {
    test('UNIT_REFUNDS=' + (unit ? 'on' : 'off') + ' — reembolso PARCIAL e orders/updated partially_refunded: o pedido continua REFUNDED e o voucher cancelado (igual ao controle)', async () => {
      flags.unitRefunds = unit;
      const result = await bothWays(async (campaign, payload, orderId) => {
        await runRefund(service(), refundFor(campaign, orderId, 1));
        await run(service(), 'orders/updated', withStatus(payload, 'partially_refunded', 6_000));
      });
      expect(result['benefícios depois']).toEqual(result['controle']);
      expect(result['benefícios depois'].registry).toBe('REFUNDED');
      expect(result['benefícios depois'].vouchers.every((s) => s === 'CANCELLED')).toBe(true);
      expect(result['benefícios depois'].grouped).toBe(false);
    });

    test('UNIT_REFUNDS=' + (unit ? 'on' : 'off') + ' — reembolso TOTAL (refunds/create + orders/updated refunded): igual ao controle', async () => {
      flags.unitRefunds = unit;
      const result = await bothWays(async (campaign, payload, orderId) => {
        await runRefund(service(), refundFor(campaign, orderId, 2));
        await run(service(), 'orders/updated', withStatus(payload, 'refunded', 6_000));
      });
      expect(result['benefícios depois']).toEqual(result['controle']);
      expect(result['benefícios depois'].registry).toBe('REFUNDED');
    });

    test('UNIT_REFUNDS=' + (unit ? 'on' : 'off') + ' — FORA DE ORDEM: orders/updated partially_refunded chega ANTES do refunds/create: mesmo resultado final do controle', async () => {
      flags.unitRefunds = unit;
      const result = await bothWays(async (campaign, payload, orderId) => {
        await run(service(), 'orders/updated', withStatus(payload, 'partially_refunded', 6_000));
        await runRefund(service(), refundFor(campaign, orderId, 1));
        await run(service(), 'orders/updated', withStatus(payload, 'partially_refunded', 7_000));
        await runRefund(service(), refundFor(campaign, orderId, 1)); // segundo reembolso (outro id)
      });
      expect(result['benefícios depois']).toEqual(result['controle']);
      expect(result['benefícios depois'].registry).toBe('REFUNDED');
      expect(result['benefícios depois'].vouchers.every((s) => s === 'CANCELLED')).toBe(true);
    });
  }

  test('o modelo do pedido vem dos vouchers EMITIDOS: pedido legado em campanha com benefícios nunca usa o tratamento por unidade; pedido novo na mesma campanha usa', async () => {
    flags.twoVoucher = true;
    const campaign = await newCampaign(false);
    const legacy = paidPayload(campaign, 1);
    await run(service(), 'orders/paid', legacy); // emitido como LEGADO (a campanha ainda não tinha benefícios)
    await addBenefits(campaign.id);
    const modern = paidPayload(campaign, 1);
    await run(service(), 'orders/paid', modern); // agora é do modelo novo
    const flow = flowService();
    await prisma.$transaction(async (tx) => {
      expect(await flow.usesUnitModel(tx, String(legacy.id), [campaign.numericVariant])).toBe(false);
      expect(await flow.usesUnitModel(tx, String(modern.id), [campaign.numericVariant])).toBe(true);
    });
    expect((await vouchersOf(String(modern.id))).every((v) => v.groupId !== null)).toBe(true);
    flags.unitRefunds = true; // com a chave de reembolso ligada, o pedido legado continua legado
    await prisma.$transaction(async (tx) => {
      expect(await flow.usesUnitModel(tx, String(legacy.id), [campaign.numericVariant])).toBe(false);
    });
  });
});

localDescribe('D2 — retenção aberta acompanha a quantidade do pedido; o ADMIN sempre tem caminho de resolução', () => {
  const editQty = (payload: Record<string, unknown>, variant: string, quantity: number, total: string, offset: number) => ({
    ...payload,
    line_items: [{ ...(payload.line_items as Record<string, unknown>[])[0], variant_id: Number(variant), quantity, current_quantity: quantity }],
    current_total_price: total,
    updated_at: new Date(clock + offset).toISOString(),
  });
  const confirmIssue = async (holdId: string, note = 'Excedente aprovado pela diretoria (teste)'): Promise<IssueHoldInput> => {
    const p = await holdsService.preview(holdId);
    return { note, confirmTotal: p.projectedTotal, expected: { projectedTotal: p.projectedTotal, consumedTotal: p.consumedBefore, globalLimit: p.globalLimit, capacityLimit: p.capacityLimit, holdUpdatedAt: p.holdUpdatedAt } };
  };
  async function capacityHeld(quantity: number, limit = 1) {
    flags.twoVoucher = true;
    const campaign = await newCampaign(true, { globalLimit: limit });
    const payload = paidPayload(campaign, quantity);
    await run(service(), 'orders/paid', payload);
    const orderId = String(payload.id);
    const [hold] = await holdsOf(orderId);
    expect(hold).toMatchObject({ reason: 'CAPACITY_EXCEEDED', status: 'OPEN', units: quantity });
    return { campaign, payload, orderId, hold };
  }

  test('2 → 3 unidades COM pagamento comprovado: retenção acompanha o pedido e só emite após o teto configurado comportar 3', async () => {
    const { campaign, payload, orderId, hold } = await capacityHeld(2);
    const edit = editQty(payload, campaign.numericVariant, 3, '1050.00', 5_000);
    const events = await run(service(), 'orders/updated', edit);
    expect(events.map((e) => e.type)).toContain('VALE_PASS_HOLD_UNITS_UPDATED');
    const [after] = await holdsOf(orderId);
    expect(after).toMatchObject({ id: hold.id, status: 'OPEN', units: 3, reason: 'CAPACITY_EXCEEDED' });
    const detail = after.detail as { unitHistory?: { from: number; to: number; proven: boolean }[] };
    expect(detail.unitHistory).toEqual([expect.objectContaining({ from: 2, to: 3, proven: true })]);
    expect(await vouchersOf(orderId)).toHaveLength(0); // atualizar a retenção nunca emite
    expect((await allOrderEvents(orderId)).filter((type) => type === 'HOLD_UNITS_UPDATED')).toHaveLength(1);
    await prisma.valePassCampaign.update({ where: { id: campaign.id }, data: { globalLimit: 3 } });
    await holdsService.issue(hold.id, await confirmIssue(hold.id), adminId, ADMIN_NAME);
    expect(await vouchersOf(orderId)).toHaveLength(6);
    expect(await outboxOf(orderId)).toHaveLength(3);
    expect((await holdsOf(orderId))[0].status).toBe('ISSUED');
    expect((await lots.getCapacity(campaign.id)).totals.consumed).toBe(3);
  });

  test('2 → 3 unidades SEM comprovação (total pago não cobre): a retenção não cresce; só as 2 comprovadas emitem dentro do teto', async () => {
    const { campaign, payload, orderId, hold } = await capacityHeld(2);
    const edit = editQty(payload, campaign.numericVariant, 3, '700.00', 5_000); // acréscimo não pago
    await run(service(), 'orders/updated', edit);
    await storeEvent('orders/updated', edit);
    const [after] = await holdsOf(orderId);
    expect(after.units).toBe(2);
    expect(issueCodes(after)).toContain('QUANTITY_INCREASED_UNPROVEN');
    const projection = await holdsService.preview(hold.id);
    expect(projection.units).toBe(2);
    await prisma.valePassCampaign.update({ where: { id: campaign.id }, data: { globalLimit: 3 } });
    await holdsService.issue(hold.id, await confirmIssue(hold.id), adminId, ADMIN_NAME); // caminho real de resolução (antes: Conflito eterno)
    expect(await vouchersOf(orderId)).toHaveLength(4);
    expect(new Set((await vouchersOf(orderId)).map((v) => v.groupId)).size).toBe(2);
    const overview = await flowService().overview();
    expect(overview.ordersWithoutTreatment.find((o) => o.orderId === orderId)).toMatchObject({ missing: 1, kind: 'QUANTITY_INCREASED' });
    const regularized = await flowService().regularizeOrder({ id: adminId, name: ADMIN_NAME }, { orderId, note: 'Tentativa de regularizar sem pagamento do acréscimo' });
    expect(regularized.outcome.status).toBe('HELD'); // a validação financeira recusa: nada de unidade sem comprovação
    expect(await vouchersOf(orderId)).toHaveLength(4);
  });

  test('edições sucessivas 2 → 3 → 4 → 3 e reprocessamento do mesmo webhook: idempotente, a retenção sempre igual ao que falta, sem emitir', async () => {
    const { campaign, payload, orderId, hold } = await capacityHeld(2);
    const e3 = editQty(payload, campaign.numericVariant, 3, '1050.00', 4_000);
    const e4 = editQty(payload, campaign.numericVariant, 4, '1400.00', 5_000);
    const e3b = editQty(payload, campaign.numericVariant, 3, '1050.00', 6_000);
    await run(service(), 'orders/updated', e3);
    await run(service(), 'orders/updated', e3); // reprocessamento
    expect((await holdsOf(orderId))[0].units).toBe(3);
    await run(service(), 'orders/updated', e4);
    expect((await holdsOf(orderId))[0].units).toBe(4);
    await run(service(), 'orders/updated', e3b);
    const [after] = await holdsOf(orderId);
    expect(after.units).toBe(3);
    expect(after.id).toBe(hold.id);
    const history = (after.detail as { unitHistory: { from: number; to: number }[] }).unitHistory;
    expect(history.map((h) => [h.from, h.to])).toEqual([[2, 3], [3, 4], [4, 3]]);
    expect(await holdsOf(orderId)).toHaveLength(1);
    expect(await vouchersOf(orderId)).toHaveLength(0);
  });

  test('a quantidade DIMINUI depois (3 → 2): a retenção acompanha; o ADMIN nunca emite unidade que já não foi paga', async () => {
    const { campaign, payload, orderId, hold } = await capacityHeld(3);
    await run(service(), 'orders/updated', editQty(payload, campaign.numericVariant, 2, '700.00', 5_000));
    expect((await holdsOf(orderId))[0].units).toBe(2);
    await prisma.valePassCampaign.update({ where: { id: campaign.id }, data: { globalLimit: 2 } });
    await holdsService.issue(hold.id, await confirmIssue(hold.id), adminId, ADMIN_NAME);
    expect(await vouchersOf(orderId)).toHaveLength(4);
  });

  test('retenção desatualizada que ninguém sincronizou (quantidade menor no registro): a emissão excepcional RECUSA em vez de emitir a mais', async () => {
    const { orderId, hold } = await capacityHeld(3);
    await prisma.valePassOrder.update({ where: { shopifyOrderId: orderId }, data: { quantity: 2 } }); // registro já diz 2; a retenção ainda diz 3
    const input = await confirmIssue(hold.id);
    await expect(holdsService.issue(hold.id, input, adminId, ADMIN_NAME)).rejects.toThrow(/quantidade do pedido diminuiu/);
    expect(await vouchersOf(orderId)).toHaveLength(0);
    expect((await holdsOf(orderId))[0].status).toBe('OPEN');
  });

  test('concorrência: 6 edições simultâneas (2 → 3) e emissão do ADMIN ao mesmo tempo: sem duplicar, sem emitir a mais, estado final consistente', async () => {
    const { campaign, payload, orderId, hold } = await capacityHeld(2);
    const edit = editQty(payload, campaign.numericVariant, 3, '1050.00', 5_000);
    await storeEvent('orders/updated', edit);
    const issueTry = async () => {
      try {
        await holdsService.issue(hold.id, await confirmIssue(hold.id), adminId, ADMIN_NAME);
        return 'ok';
      } catch (err) {
        return err instanceof ConflictException ? 'conflito' : 'erro:' + String(err).slice(0, 60);
      }
    };
    const results = await Promise.all([...Array.from({ length: 6 }, () => run(service(), 'orders/updated', edit)), issueTry()]);
    expect(results[6]).toMatch(/^(ok|conflito)$/);
    const vouchers = await vouchersOf(orderId);
    const units = new Set(vouchers.map((v) => v.groupId)).size;
    expect([0, 2, 3]).toContain(units); // nunca mais que o pago
    expect(vouchers.length).toBe(units * 2);
    const [final] = await holdsOf(orderId);
    expect(final.units).toBeLessThanOrEqual(3);
    expect((await outboxOf(orderId)).length).toBe(units);
    // se o ADMIN emitiu antes da sincronização, o que sobra aparece em "sem tratamento"; senão a retenção segue aberta com 3
    if (units === 2) expect((await flowService().overview()).ordersWithoutTreatment.some((o) => o.orderId === orderId) || final.status === 'OPEN').toBe(true);
    if (units === 0) expect(final).toMatchObject({ status: 'OPEN', units: 3 });
  });
});

localDescribe('HORÁRIO DO PAGAMENTO — política estrita por padrão; fonte autoritativa = transação financeira da Shopify (Admin API, só leitura)', () => {
  const actor = () => ({ id: adminId, name: ADMIN_NAME });
  const note = 'Conferência do horário do pagamento (teste)';
  const gidOf = (orderId: string) => 'gid://shopify/Order/' + orderId;
  const txn = (over: Partial<{ kind: string; status: string; test: boolean; processedAt: string | null; amount: string }> = {}) => ({
    id: 'gid://shopify/OrderTransaction/' + counter++, kind: 'SALE', status: 'SUCCESS', test: false, processedAt: hoursAgo(9), amount: '350.00', currency: 'BRL', ...over,
  });
  const shopify = (orderId: string, transactions: ReturnType<typeof txn>[], total = '350.00') => fakeTransactions.set(gidOf(orderId), { orderGid: gidOf(orderId), totalAmount: total, currency: 'BRL', transactions });
  /** Pedido pago, entregue com sinais PERFEITOS do webhook (cabeçalho = updated_at), na política ESTRITA de produção. */
  async function strictPaid(quantity = 1, paidHoursAgo = 9) {
    paymentTimeCfg.mode = 'strict';
    flags.twoVoucher = true;
    const campaign = await newCampaign(true);
    const payload = paidPayload(campaign, quantity, { created_at: hoursAgo(paidHoursAgo + 1) });
    const orderId = String(payload.id);
    const paidAt = hoursAgo(paidHoursAgo);
    await runAt(service(), payload, paidAt);
    await storeEvent('orders/paid', { ...payload, updated_at: paidAt });
    return { campaign, payload, orderId, paidAt };
  }

  test('ESTRITA (padrão): sinais perfeitos do webhook NÃO bastam — retenção PAYMENT_TIME_UNKNOWN, evidência registrada (diferença entre os sinais), nada emitido', async () => {
    const { orderId, paidAt } = await strictPaid();
    const registry = await registryOf(orderId);
    expect(registry.paymentConfirmedAt).toBeNull();
    expect(registry.paymentSignalAt?.toISOString()).toBe(paidAt);
    expect((registry.paymentTimeEvidence as { webhook: { deltaSeconds: number } }).webhook.deltaSeconds).toBe(0);
    expect(issueCodes((await holdsOf(orderId))[0])).toEqual(['PAYMENT_TIME_UNKNOWN']);
    expect(await vouchersOf(orderId)).toHaveLength(0);
    const status = await new ValePassFlowController(flowService(), prisma, paymentTimeService(), operationalAlerts).status();
    expect(status.paymentTimePolicy).toEqual({ mode: 'strict', toleranceSeconds: 120 });
    expect(status.paymentTimePending.find((c) => c.orderId === orderId)).toMatchObject({ webhookTriggeredAt: paidAt, transactionInstant: null });
    expect(JSON.stringify(status.paymentTimePending)).not.toMatch(/@exemplo/);
  });

  test('cartão: a transação SALE concorda com o webhook → horário CONFIRMADO pela Shopify; a retomada emite e o prazo do e-mail é o da TRANSAÇÃO + 3 dias', async () => {
    const { orderId, paidAt } = await strictPaid();
    const processedAt = new Date(new Date(paidAt).getTime() - 20_000).toISOString(); // a transação precede o disparo em 20 s
    shopify(orderId, [txn({ processedAt })]);
    const outcome = await paymentTimeService().verifyFromShopify(actor(), { orderId, note });
    expect(outcome).toMatchObject({ status: 'CONFIRMED', confirmedAt: processedAt, source: 'ADMIN_API_TRANSACTION' });
    const registry = await registryOf(orderId);
    expect(registry).toMatchObject({ paymentConfirmedSource: 'ADMIN_API_TRANSACTION' });
    expect(registry.paymentConfirmedAt?.toISOString()).toBe(processedAt);
    expect(await vouchersOf(orderId)).toHaveLength(0); // confirmar o horário NÃO emite: a retomada revalida o pagamento
    const report = await flowService().resumeHeldPayments(actor(), { note });
    expect(report).toMatchObject({ considered: 1, issued: 1 });
    expect(await vouchersOf(orderId)).toHaveLength(2);
    expect((await outboxOf(orderId))[0].deadlineAt.getTime()).toBe(new Date(processedAt).getTime() + 3 * DAY);
    const audit = await prisma.adminAuditEvent.findFirstOrThrow({ where: { adminUserId: adminId, action: 'VALE_PASS_PAYMENT_TIME_CONFIRMED' } });
    expect(audit).toMatchObject({ isCritical: true });
    expect(JSON.stringify(audit)).not.toMatch(/@exemplo/);
    expect(await paymentTimeService().verifyFromShopify(actor(), { orderId, note })).toMatchObject({ status: 'ALREADY_CONFIRMED' }); // idempotente
  });

  test('captura posterior: autorização antiga + CAPTURE recente → vale o CAPTURE (a autorização nunca é o horário do pagamento)', async () => {
    const { orderId, paidAt } = await strictPaid(1, 2);
    shopify(orderId, [txn({ kind: 'AUTHORIZATION', processedAt: hoursAgo(70) }), txn({ kind: 'CAPTURE', processedAt: paidAt })]);
    const outcome = await paymentTimeService().verifyFromShopify(actor(), { orderId, note });
    expect(outcome).toMatchObject({ status: 'CONFIRMED', confirmedAt: paidAt });
  });

  test('Pix com processedAt = criação da transação pendente (9 h antes do sucesso): DIVERGE do webhook → continua desconhecido; o ADMIN confirma manualmente e fica ADMIN_MANUAL', async () => {
    const { orderId, paidAt } = await strictPaid(1, 1);
    shopify(orderId, [txn({ processedAt: hoursAgo(10) })]);
    const outcome = await paymentTimeService().verifyFromShopify(actor(), { orderId, note });
    expect(outcome).toMatchObject({ status: 'UNKNOWN', reason: 'TRANSACTION_DIVERGENT' });
    expect((await registryOf(orderId)).paymentConfirmedAt).toBeNull();
    expect(issueCodes((await holdsOf(orderId))[0])).toEqual(['PAYMENT_TIME_UNKNOWN']);
    const candidate = (await paymentTimeService().candidates()).find((c) => c.orderId === orderId)!;
    expect(candidate).toMatchObject({ webhookTriggeredAt: paidAt, transactionReason: 'OK' });
    expect(candidate.transactionInstant).not.toBeNull();
    const confirmed = await paymentTimeService().confirmManually(actor(), { orderId, confirmedAt: paidAt, note: 'Pix confirmado no painel do banco (teste)' });
    expect(confirmed.confirmedAt).toBe(paidAt);
    expect(await registryOf(orderId)).toMatchObject({ paymentConfirmedSource: 'ADMIN_MANUAL' });
    expect((await flowService().resumeHeldPayments(actor(), { note })).issued).toBe(1);
    expect((await outboxOf(orderId))[0].deadlineAt.getTime()).toBe(new Date(paidAt).getTime() + 3 * DAY);
  });

  test('reentrega 3 h depois com payload regerado (cabeçalho +3 h, updated_at original): no modo webhook-agreement DIVERGE → desconhecido; a transação (corroborada pelo updated_at) resolve com o horário certo', async () => {
    paymentTimeCfg.mode = 'webhook-agreement';
    flags.twoVoucher = true;
    const campaign = await newCampaign(true);
    const payload = paidPayload(campaign, 1, { created_at: hoursAgo(6) });
    const orderId = String(payload.id);
    const real = hoursAgo(5);
    await run(service(), 'orders/paid', { ...payload, updated_at: real }, { triggeredAt: hoursAgo(2) }); // reentrega tardia
    expect((await registryOf(orderId)).paymentConfirmedAt).toBeNull();
    expect((await registryOf(orderId)).paymentTimeEvidence).toMatchObject({ webhook: { deltaSeconds: 3 * 3600 } });
    expect(issueCodes((await holdsOf(orderId))[0])).toEqual(['PAYMENT_TIME_UNKNOWN']);
    shopify(orderId, [txn({ processedAt: real })]);
    paymentTimeCfg.mode = 'strict';
    await storeEvent('orders/paid', { ...payload, updated_at: real });
    // a transação (5 h atrás) bate com o updated_at original (5 h atrás), embora o cabeçalho seja da reentrega (2 h atrás): duas fontes independentes concordam
    expect(await paymentTimeService().verifyFromShopify(actor(), { orderId, note })).toMatchObject({ status: 'CONFIRMED', confirmedAt: real });
  });

  test('reconciliação (nenhum sinal de webhook): a transação da Shopify sozinha confirma; sem transação com sucesso, continua desconhecido', async () => {
    paymentTimeCfg.mode = 'strict';
    flags.twoVoucher = true;
    const campaign = await newCampaign(true);
    const base = paidPayload(campaign, 1, { created_at: hoursAgo(31) });
    const orderId = String(base.id);
    await run(service(), 'orders/updated', withStatus(base, 'paid', 0));
    await storeEvent('orders/updated', withStatus(base, 'paid', 0));
    expect((await registryOf(orderId)).paymentTimeEvidence).toBeNull();
    shopify(orderId, [txn({ status: 'PENDING', processedAt: hoursAgo(30) })]);
    expect(await paymentTimeService().verifyFromShopify(actor(), { orderId, note })).toMatchObject({ status: 'UNKNOWN', reason: 'NO_SUCCESS_TRANSACTION' });
    shopify(orderId, [txn({ processedAt: hoursAgo(29) })]);
    expect(await paymentTimeService().verifyFromShopify(actor(), { orderId, note })).toMatchObject({ status: 'CONFIRMED' });
    expect((await flowService().resumeHeldPayments(actor(), { note })).issued).toBe(1);
  });

  test('cautelas: transação de teste, pagamento parcial, pedido sem retorno da Shopify, funcionário comum, justificativa curta, horário manual no futuro/antes do pedido/já confirmado', async () => {
    const { orderId } = await strictPaid(1, 3);
    shopify(orderId, [txn({ test: true })]);
    expect(await paymentTimeService().verifyFromShopify(actor(), { orderId, note })).toMatchObject({ status: 'UNKNOWN', reason: 'ONLY_TEST_TRANSACTIONS' });
    shopify(orderId, [txn({ amount: '100.00' })]);
    expect(await paymentTimeService().verifyFromShopify(actor(), { orderId, note })).toMatchObject({ status: 'UNKNOWN', reason: 'PARTIAL_PAYMENT' });
    fakeTransactions.delete(gidOf(orderId));
    await expect(paymentTimeService().verifyFromShopify(actor(), { orderId, note })).rejects.toBeInstanceOf(ConflictException);
    await expect(paymentTimeService().verifyFromShopify(actor(), { orderId, note: 'curta' })).rejects.toBeInstanceOf(UnprocessableEntityException);
    await expect(paymentTimeService().verifyFromShopify(actor(), { orderId: 'nao-existe', note })).rejects.toThrow(/não encontrado/);
    const staffId = await storeStaff();
    try {
      await expect(paymentTimeService().verifyFromShopify({ id: staffId, name: 'x' }, { orderId, note })).rejects.toBeInstanceOf(ForbiddenException);
      await expect(paymentTimeService().confirmManually({ id: staffId, name: 'x' }, { orderId, confirmedAt: hoursAgo(3), note })).rejects.toBeInstanceOf(ForbiddenException);
    } finally {
      await prisma.adminUser.delete({ where: { id: staffId } });
    }
    await expect(paymentTimeService().confirmManually(actor(), { orderId, confirmedAt: 'ontem', note })).rejects.toBeInstanceOf(UnprocessableEntityException);
    await expect(paymentTimeService().confirmManually(actor(), { orderId, confirmedAt: new Date(Date.now() + 3_600_000).toISOString(), note })).rejects.toThrow(/futuro/);
    await expect(paymentTimeService().confirmManually(actor(), { orderId, confirmedAt: hoursAgo(40), note })).rejects.toThrow(/anterior à criação/);
    await expect(paymentTimeService().confirmManually(actor(), { orderId, confirmedAt: hoursAgo(3), note: 'curta' })).rejects.toBeInstanceOf(UnprocessableEntityException);
    expect((await registryOf(orderId)).paymentConfirmedAt).toBeNull();
    await paymentTimeService().confirmManually(actor(), { orderId, confirmedAt: hoursAgo(3), note });
    await expect(paymentTimeService().confirmManually(actor(), { orderId, confirmedAt: hoursAgo(3), note })).rejects.toBeInstanceOf(ConflictException);
    const proto = ValePassFlowController.prototype as unknown as Record<string, unknown>;
    expect(Reflect.getMetadata(REQUIRE_ROLE_KEY, proto.verifyPaymentTime as object)).toBe('ADMIN');
    expect(Reflect.getMetadata(REQUIRE_ROLE_KEY, proto.confirmPaymentTime as object)).toBe('ADMIN');
  });

  test('concorrência: 5 conferências simultâneas do mesmo pedido → exatamente uma CONFIRMA, as outras são ALREADY_CONFIRMED; uma única auditoria', async () => {
    const { orderId, paidAt } = await strictPaid(1, 2);
    shopify(orderId, [txn({ processedAt: paidAt })]);
    const results = await Promise.all(Array.from({ length: 5 }, () => paymentTimeService().verifyFromShopify(actor(), { orderId, note })));
    expect(results.filter((r) => r.status === 'CONFIRMED')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'ALREADY_CONFIRMED')).toHaveLength(4);
    expect(await prisma.adminAuditEvent.count({ where: { adminUserId: adminId, action: 'VALE_PASS_PAYMENT_TIME_CONFIRMED' } })).toBe(1);
  });

  test('variante NOVA sem campanha na política estrita: o pedido sem voucher e sem retenção aparece em "horário desconhecido"; confirmado o horário e cadastrada a campanha, a regularização emite', async () => {
    paymentTimeCfg.mode = 'strict';
    flags.twoVoucher = true;
    const variant = 930_000_000_000 + counter++;
    const base = paidPayload({ numericVariant: String(variant) } as Campaign, 2, { created_at: hoursAgo(3) });
    const payload: Record<string, unknown> = { ...base, line_items: [{ variant_id: variant, product_id: Number(KNOWN_VALE_PASS_PRODUCT_ID), quantity: 2, current_quantity: 2, price: '350.00', price_set: money('350.00'), discount_allocations: [] }] };
    const orderId = String(payload.id);
    const paidAt = hoursAgo(2);
    await runAt(service(), payload, paidAt);
    await storeEvent('orders/paid', { ...payload, updated_at: paidAt });
    expect((await registryOf(orderId)).paymentConfirmedAt).toBeNull();
    expect((await registryOf(orderId)).paymentTimeEvidence).not.toBeNull();
    expect((await paymentTimeService().candidates()).map((c) => c.orderId)).toContain(orderId);
    // sem horário confiável a regularização é recusada, com a orientação
    await expect(flowService().regularizeOrder(actor(), { orderId, note })).rejects.toThrow(/instante real do pagamento/);
    shopify(orderId, [txn({ processedAt: paidAt, amount: '700.00' })], '700.00');
    expect(await paymentTimeService().verifyFromShopify(actor(), { orderId, note })).toMatchObject({ status: 'CONFIRMED', confirmedAt: paidAt });
    expect((await paymentTimeService().candidates()).map((c) => c.orderId)).not.toContain(orderId);
    const campaign = await prisma.valePassCampaign.create({ data: { name: TAG + '-camp-' + counter++, amountCents: 35_000, validityDays: 30, globalLimit: 1_000, shopifyVariantId: String(variant), voucherValidFrom: new Date('2026-01-01T00:00:00.000Z'), voucherValidUntil: new Date('2027-12-31T00:00:00.000Z') } });
    campaignIds.push(campaign.id);
    await prisma.valePassCampaignBenefit.createMany({ data: [
      { campaignId: campaign.id, code: 'valle_showroom_500', kind: 'VOUCHER', company: 'VALLE_SHOWROOM', label: 'A', amountCents: 50_000, sortOrder: 0 },
      { campaignId: campaign.id, code: 'vs_by_closet_50', kind: 'VOUCHER', company: 'VS_BY_CLOSET', label: 'B', amountCents: 5_000, sortOrder: 1 },
    ] });
    const done = await flowService().regularizeOrder(actor(), { orderId, note });
    expect(done.outcome).toMatchObject({ status: 'ISSUED', vouchersCreated: 4 });
    expect((await outboxOf(orderId))[0].deadlineAt.getTime()).toBe(new Date(paidAt).getTime() + 3 * DAY);
  });

  test('falhas da Shopify: sem credenciais => 409 "não configurada"; erro de rede/HTTP => 503 neutro; em ambos NADA é alterado', async () => {
    const { orderId } = await strictPaid(1, 2);
    const failing = (error: Error) => new ValePassPaymentTimeService(prisma, { getOrderPaymentTransactions: async () => { throw error; } } as never, flagFns);
    await expect(failing(new ServiceUnavailableException('Integração Shopify Admin não configurada no servidor.')).verifyFromShopify(actor(), { orderId, note })).rejects.toBeInstanceOf(ConflictException);
    await expect(failing(new ServiceUnavailableException('Não foi possível consultar o catálogo da Shopify no momento.')).verifyFromShopify(actor(), { orderId, note })).rejects.toBeInstanceOf(ServiceUnavailableException);
    await expect(failing(new Error('ECONNRESET')).verifyFromShopify(actor(), { orderId, note })).rejects.toBeInstanceOf(ServiceUnavailableException);
    const registry = await registryOf(orderId);
    expect(registry.paymentConfirmedAt).toBeNull();
    expect(await prisma.adminAuditEvent.count({ where: { adminUserId: adminId, action: { startsWith: 'VALE_PASS_PAYMENT_TIME' } } })).toBe(0);
  });

  test('o flag da política vem do ambiente: sem variável, a produção é ESTRITA', async () => {
    const { envFlowFlags, paymentTimeOf } = await import('./flow-flags');
    expect(paymentTimeOf(envFlowFlags({}))).toEqual({ mode: 'strict', toleranceSeconds: 120 });
    expect(paymentTimeOf({ twoVoucher: () => false, unitRefunds: () => false })).toEqual({ mode: 'strict', toleranceSeconds: 120 });
    expect(paymentTimeOf(envFlowFlags({ VALE_PASS_PAYMENT_TIME_POLICY: 'webhook-agreement', VALE_PASS_PAYMENT_TIME_TOLERANCE_SECONDS: '60' }))).toEqual({ mode: 'webhook-agreement', toleranceSeconds: 60 });
  });
});

localDescribe('ALERTAS OPERACIONAIS — contador específico e aviso ativo (sem depender de alguém abrir o ClosetAdmin)', () => {
  /** Retenção com o pagamento confirmado há \`hours\` horas (chave de emissão DESLIGADA => retém, e o relógio é o do PAGAMENTO). */
  async function heldPaidHoursAgo(campaign: Campaign, hours: number) {
    flags.twoVoucher = false;
    const payload = paidPayload(campaign, 1, { created_at: hoursAgo(hours + 1) });
    await runAt(service(), payload, hoursAgo(hours));
    return payload;
  }

  test('o contador específico separa: sem benefício, 48–72 h, 72 h vencido, horário desconhecido e e-mail vencido (diferenças sobre o estado do banco de teste)', async () => {
    const campaign = await newCampaign(true);
    const before = await operationalAlerts.snapshot();
    await heldPaidHoursAgo(campaign, 3); // retido, recente
    await heldPaidHoursAgo(campaign, 50); // entre 48 e 72 h
    await heldPaidHoursAgo(campaign, 80); // prazo vencido
    // horário desconhecido (visto só por orders/updated)
    flags.twoVoucher = true;
    const unknown = paidPayload(campaign, 1, { created_at: hoursAgo(5) });
    await run(service(), 'orders/updated', withStatus(unknown, 'paid', 0));
    // sem tratamento nenhum: variante sem campanha do produto conhecido
    const untreated = paidPayload(campaign, 1);
    (untreated.line_items as Record<string, unknown>[])[0] = { variant_id: 988_000_000_000 + counter++, product_id: Number(KNOWN_VALE_PASS_PRODUCT_ID), quantity: 1, current_quantity: 1, price: '350.00', price_set: money('350.00'), discount_allocations: [] };
    await run(service(), 'orders/paid', untreated);
    const after = await operationalAlerts.snapshot();
    expect(after.withoutBenefit.orders - before.withoutBenefit.orders).toBe(5);
    expect(after.withoutBenefit.units - before.withoutBenefit.units).toBe(5);
    expect(after.nearDeadline.orders - before.nearDeadline.orders).toBe(1);
    expect(after.overdue.orders - before.overdue.orders).toBe(1);
    expect(after.paymentTimeUnknown.orders - before.paymentTimeUnknown.orders).toBe(1);
    expect(after.severity).toBe('critical');
    expect(after.oldestHours).toBeGreaterThanOrEqual(80);
    expect(JSON.stringify(after)).not.toMatch(/@exemplo|cliente/i);
    // e-mail inicial vencido (prazo de 3 dias) sem a Resend ter aceitado
    const groupId = randomUUID();
    const mailOrder = String(untreated.id);
    await prisma.valePassEmailOutbox.create({
      data: { id: randomUUID(), shopifyOrderId: mailOrder, campaignId: campaign.id, groupId, kind: 'INITIAL', dedupeKey: 'initial:' + groupId, toEmail: 'x@exemplo.invalid', status: 'QUEUED', attempts: 0, idempotencyKey: 'vpe-' + groupId, deadlineAt: new Date(Date.now() - 3_600_000) },
    });
    expect((await operationalAlerts.snapshot()).emailsOverdue.units - before.emailsOverdue.units).toBe(1);
  });

  test('o pedido regularizado/emitido sai do contador (retomada); a contagem cai', async () => {
    const campaign = await newCampaign(true);
    const before = await operationalAlerts.snapshot();
    const payload = await heldPaidHoursAgo(campaign, 60);
    await storeEvent('orders/paid', { ...payload, updated_at: hoursAgo(60) });
    const held = await operationalAlerts.snapshot();
    expect(held.withoutBenefit.orders - before.withoutBenefit.orders).toBe(1);
    flags.twoVoucher = true;
    await flowService().resumeHeldPayments({ id: adminId, name: ADMIN_NAME }, { note: 'Retomada de teste do contador' });
    const resolved = await operationalAlerts.snapshot();
    expect(resolved.withoutBenefit.orders).toBe(before.withoutBenefit.orders);
  });

  test('o agendador avisa pelo canal configurado: na primeira vez, NÃO repete a mesma foto, avisa quando piora e nunca lança (canal fora do ar)', async () => {
    const campaign = await newCampaign(true);
    await heldPaidHoursAgo(campaign, 55);
    const sent: string[] = [];
    const channel = { channel: 'falso', send: async (text: string) => { sent.push(text); return true; } };
    const scheduler = new ValePassAlertsScheduler(operationalAlerts);
    scheduler.configureForTest({ mode: 'log', intervalMinutes: 15, webhookUrl: null }, [channel]);
    const t0 = new Date();
    expect(await scheduler.runOnce(t0)).toBe(true);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatch(/\[Valle Pass\].*(ATENÇÃO|CRÍTICO)/);
    expect(await scheduler.runOnce(new Date(t0.getTime() + 15 * 60_000))).toBe(false); // mesma foto: silêncio
    expect(sent).toHaveLength(1);
    await heldPaidHoursAgo(campaign, 90); // piora: prazo vencido
    expect(await scheduler.runOnce(new Date(t0.getTime() + 30 * 60_000))).toBe(true);
    expect(sent[1]).toMatch(/CRÍTICO/);
    const broken = new ValePassAlertsScheduler(operationalAlerts);
    broken.configureForTest({ mode: 'log', intervalMinutes: 15, webhookUrl: null }, [{ channel: 'quebrado', send: async () => { throw new Error('canal fora do ar'); } }]);
    await expect(broken.runOnce()).resolves.toBe(true); // a falha do canal não derruba a rodada
  });

  test('GET /admin/vale-pass/flow/alerts: leitura para quem tem o módulo (sem exigir ADMIN)', async () => {
    const proto = ValePassFlowController.prototype as unknown as Record<string, unknown>;
    expect(Reflect.getMetadata(REQUIRE_ROLE_KEY, proto.alerts as object)).toBeUndefined();
    const snapshot = await new ValePassFlowController(flowService(), prisma, paymentTimeService(), operationalAlerts).alerts();
    expect(snapshot).toMatchObject({ withoutBenefit: expect.any(Object), nearDeadline: expect.any(Object), overdue: expect.any(Object) });
  });

  test('desligado por padrão: sem VALE_PASS_ALERTS_MODE o agendador não cria timer nem envia nada', () => {
    const scheduler = new ValePassAlertsScheduler(operationalAlerts);
    const saved = process.env.VALE_PASS_ALERTS_MODE;
    delete process.env.VALE_PASS_ALERTS_MODE;
    try {
      scheduler.onModuleInit();
      expect((scheduler as unknown as { timer: unknown }).timer).toBeNull();
    } finally {
      if (saved !== undefined) process.env.VALE_PASS_ALERTS_MODE = saved;
      scheduler.onModuleDestroy();
    }
  });
});

localDescribe('injeção de dependências REAL do Nest', () => {
  test('o fluxo de pagamento recebe a caixa de saída e o prisma, e o webhook recebe o fluxo e o reembolso (tipo "| null" perderia o token)', async () => {
    @Module({
      providers: [
        { provide: PrismaService, useValue: prisma },
        { provide: EMAIL_CONFIG_TOKEN, useValue: loadEmailConfig({}) },
        { provide: FLOW_FLAGS_TOKEN, useValue: flagFns },
        ValePassEmailOutboxService,
        ValePassFinancialGuard,
        ValePassIssuanceService,
        ValePassRefundService,
        ValePassRegularizationService,
        ValePassPaymentFlowService,
        ValePassWebhookService,
      ],
    })
    class DiModule {}
    const app = await NestFactory.createApplicationContext(DiModule, { logger: false });
    try {
      const flow = app.get(ValePassPaymentFlowService) as unknown as { outbox: unknown; prisma: unknown; guard: unknown; issuance: unknown };
      expect(flow.outbox).toBeInstanceOf(ValePassEmailOutboxService);
      expect(flow.prisma).toBe(prisma);
      expect(flow.guard).toBeInstanceOf(ValePassFinancialGuard);
      expect(flow.issuance).toBeInstanceOf(ValePassIssuanceService);
      expect((flow as unknown as { regularization: unknown }).regularization).toBeInstanceOf(ValePassRegularizationService);
      const webhook = app.get(ValePassWebhookService) as unknown as { flow: unknown; refunds: unknown };
      expect(webhook.flow).toBeInstanceOf(ValePassPaymentFlowService);
      expect(webhook.refunds).toBeInstanceOf(ValePassRefundService);
    } finally {
      await app.close();
    }
  });
});
