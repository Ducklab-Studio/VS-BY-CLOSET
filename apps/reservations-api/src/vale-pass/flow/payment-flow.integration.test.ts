import { afterAll, afterEach, beforeAll, describe, expect, test } from 'vitest';
import { ConflictException, Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { ValePassCampaign } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { REQUIRE_ROLE_KEY } from '../../admin/require-role.decorator';
import { lockShopifyOrder } from '../../webhooks/shopify-order-lock';
import { loadEmailConfig } from '../email/email-config';
import { EMAIL_CONFIG_TOKEN } from '../email/email-tokens';
import { ValePassEmailOutboxService } from '../email/email-outbox.service';
import { ValePassFinancialGuard } from '../financial/financial-guard.service';
import { ValePassHoldsService } from '../vale-pass-holds.service';
import { ValePassIssuanceService } from '../vale-pass-issuance.service';
import { ValePassLotsService } from '../vale-pass-lots.service';
import { ValePassRefundService } from '../refunds/refund.service';
import { ValePassWebhookService } from '../vale-pass-webhook.service';
import { FLOW_FLAGS_TOKEN, INTEGRATION_DISABLED, type FlowFlags } from './flow-flags';
import { ValePassFlowController } from './flow.controller';
import { ValePassPaymentFlowService } from './payment-flow.service';

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
const flagFns: FlowFlags = { twoVoucher: () => flags.twoVoucher, unitRefunds: () => flags.unitRefunds };
const service = () => new ValePassWebhookService(new ValePassPaymentFlowService(new ValePassFinancialGuard(), issuance, outbox, flagFns, prisma), refunds, flagFns);
const flowService = () => new ValePassPaymentFlowService(new ValePassFinancialGuard(), issuance, outbox, flagFns, prisma);

const money = (amount: string) => ({ shop_money: { amount, currency_code: 'BRL' }, presentment_money: { amount, currency_code: 'BRL' } });

interface Campaign extends ValePassCampaign { numericVariant: string }
async function newCampaign(withBenefits: boolean, over: Partial<{ globalLimit: number }> = {}): Promise<Campaign> {
  const numericVariant = String(900_000_000_000 + counter++);
  const campaign = await prisma.valePassCampaign.create({
    data: {
      name: `${TAG}-camp-${counter++}`, amountCents: 35_000, validityDays: 30, shopifyVariantId: numericVariant,
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

const run = (svc: ValePassWebhookService, topic: string, payload: unknown) =>
  prisma.$transaction(async (tx) => {
    await lockShopifyOrder(tx, String((payload as { id?: unknown; order_id?: unknown }).order_id ?? (payload as { id: unknown }).id));
    return svc.handleOrderWebhook(tx, topic, payload);
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
    await tx.adminAuditEvent.deleteMany({ where: { OR: [{ entityId: { in: [...holds.map((h) => h.id), ...refundRows.map((r) => r.id), ...vouchers.map((v) => v.id)] } }, { adminUserId: adminId, action: 'VALE_PASS_HOLDS_RESUMED' }] } });
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
    await tx.webhookEvent.deleteMany({ where: { storeId: `${TAG}-store` } });
  });
  flags.twoVoucher = false;
  flags.unitRefunds = false;
}
afterEach(async () => {
  if (localDatabase) await cleanRows();
});
afterAll(async () => {
  if (localDatabase) {
    await cleanRows();
    await prisma.store.deleteMany({ where: { id: `${TAG}-store` } });
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
    const events = await run(service(), 'orders/updated', withStatus(base, 'paid', 2_000)); // pago, mas o orders/paid se perdeu/atrasou
    expect(events.map((e) => e.type)).toContain('VALE_PASS_PAYMENT_RECOVERED');
    expect(await vouchersOf(orderId)).toHaveLength(4);
    await run(service(), 'orders/paid', withStatus(base, 'paid', 1_000)); // chega atrasado (mais antigo)
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
    await prisma.valePassOrder.update({ where: { id: registry.id }, data: { status: 'CONFIRMED', statusChangedAt: new Date() } });
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

  test('cancelamento/reembolso nunca param com a chave ligada ou desligada: legado cancela os vouchers ativos do pedido', async () => {
    flags.twoVoucher = true;
    const campaign = await newCampaign(true);
    const payload = paidPayload(campaign, 2);
    const orderId = String(payload.id);
    await run(service(), 'orders/paid', payload);
    flags.twoVoucher = false; // alguém desligou a chave depois da emissão
    await runRefund(service(), refundFor(campaign, orderId, 1));
    const rows = await vouchersOf(orderId);
    expect(rows.every((v) => v.status === 'CANCELLED')).toBe(true); // legado: cancela tudo (seguro), mesmo com a chave desligada
    expect(await prisma.valePassOrderCancellation.count({ where: { shopifyOrderId: orderId } })).toBe(1);
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

  test('chave desligada (padrão): reembolso de FRETE ainda cancela tudo pelo caminho legado e marca o pedido REFUNDED — comportamento de sempre preservado', async () => {
    const campaign = await newCampaign(true);
    const payload = await issued(campaign, 2);
    const orderId = String(payload.id);
    await runRefund(service(), refundFor(campaign, orderId, 0, { refund_line_items: [], refund_shipping_lines: [{ id: 1, subtotal_amount_set: money('22.00') }] }));
    expect((await vouchersOf(orderId)).every((v) => v.status === 'CANCELLED')).toBe(true);
    expect((await registryOf(orderId)).status).toBe('REFUNDED');
    expect(await prisma.valePassRefundApplication.count({ where: { shopifyOrderId: orderId } })).toBe(0);
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
  test('retenção com mais de 48 h → crítico "perto do prazo"; mais de 72 h → crítico "prazo vencido"; nova (< 24 h) sem alerta de prazo', async () => {
    const campaign = await newCampaign(true);
    const young = paidPayload(campaign, 1);
    const near = paidPayload(campaign, 1);
    const late = paidPayload(campaign, 1);
    for (const p of [young, near, late]) await run(service(), 'orders/paid', p);
    const age = (p: Record<string, unknown>, hours: number) => prisma.$transaction(async (tx) => { await tx.$executeRawUnsafe('SET LOCAL session_replication_role = replica'); await tx.$executeRawUnsafe(`UPDATE vale_pass_issuance_holds SET created_at = now() - interval '${hours} hours' WHERE shopify_order_id = '${String(p.id)}'`); });
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
      const webhook = app.get(ValePassWebhookService) as unknown as { flow: unknown; refunds: unknown };
      expect(webhook.flow).toBeInstanceOf(ValePassPaymentFlowService);
      expect(webhook.refunds).toBeInstanceOf(ValePassRefundService);
    } finally {
      await app.close();
    }
  });
});
