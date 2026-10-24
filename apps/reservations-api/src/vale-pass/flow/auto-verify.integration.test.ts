import { afterAll, afterEach, beforeAll, describe, expect, test } from 'vitest';
import type { ValePassCampaign } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { lockShopifyOrder } from '../../webhooks/shopify-order-lock';
import { loadEmailConfig } from '../email/email-config';
import { ValePassEmailOutboxService } from '../email/email-outbox.service';
import { ValePassEmailWorkerService } from '../email/email-worker.service';
import type { EmailProvider, SendEmailResult } from '../email/email-provider';
import { ValePassFinancialGuard } from '../financial/financial-guard.service';
import { ValePassHoldsService } from '../vale-pass-holds.service';
import { ValePassIssuanceService } from '../vale-pass-issuance.service';
import { ValePassRefundService } from '../refunds/refund.service';
import { ValePassRegularizationService } from '../refunds/regularization.service';
import { ValePassWebhookService } from '../vale-pass-webhook.service';
import type { ShopifyAdminClient, ShopifyOrderTransactionsResult } from '../../admin-panel/shopify-admin.client';
import { autoVerifyEnabled, type FlowFlags } from './flow-flags';
import { ValePassAutoVerifyScheduler, ValePassAutoVerifyService } from './auto-verify.service';
import { ValePassPaymentFlowService } from './payment-flow.service';
import { ValePassPaymentTimeService } from './payment-time.service';

/**
 * Verificação financeira AUTOMÁTICA (Valle Pass 2027) em PostgreSQL LOCAL descartável. Shopify e provedor de e-mail são FALSOS (nenhuma rede, nenhum envio).
 * Cobre: Pix pendente/aprovado/divergente, cartão autorizado/capturado/recusado/estornado, pagamento manual, pedido de teste, Shopify indisponível,
 * webhooks duplicados/fora de ordem, concorrência, mudança do pedido durante a consulta e falha de envio com recuperação.
 */
const localDatabase = /^postgres(?:ql)?:\/\/[^@]+@(localhost|127\.0\.0\.1)(:\d+)?\/[^/]*(test|audit|operational)/i.test(process.env.DATABASE_URL ?? '');
const localDescribe = localDatabase ? describe : describe.skip;

const prisma = new PrismaService();
const issuance = new ValePassIssuanceService();
const emailConfig = loadEmailConfig({});
const outbox = new ValePassEmailOutboxService(prisma, emailConfig);
const TAG = `VPAV-${Date.now()}`;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
let counter = 0;
let adminId: string;
const ADMIN_NAME = 'Admin Teste Auto';
const campaignIds: string[] = [];
const orderIds: string[] = [];

const flags = { twoVoucher: true, auto: true };
const flagFns: FlowFlags = { twoVoucher: () => flags.twoVoucher, unitRefunds: () => false, paymentTime: () => ({ mode: 'strict', toleranceSeconds: 120 }), autoVerify: () => flags.auto };

type Tx = ShopifyOrderTransactionsResult['transactions'][number];
const fakeTransactions = new Map<string, ShopifyOrderTransactionsResult | null>();
let shopifyBehaviour: (gid: string) => Promise<ShopifyOrderTransactionsResult | null> = async (gid) => fakeTransactions.get(gid) ?? null;
let shopifyCalls = 0;
const fakeShopify = { getOrderPaymentTransactions: async (gid: string) => { shopifyCalls++; return shopifyBehaviour(gid); } } as unknown as ShopifyAdminClient;

const regularization = new ValePassRegularizationService(prisma, new ValePassFinancialGuard(), issuance);
const flow = new ValePassPaymentFlowService(new ValePassFinancialGuard(), issuance, outbox, flagFns, prisma, regularization);
const webhook = new ValePassWebhookService(flow, new ValePassRefundService(prisma), flagFns);
const auto = (settleMs = 0) => new ValePassAutoVerifyService(prisma, fakeShopify, flow, flagFns, settleMs);
const holdsService = new ValePassHoldsService(prisma, issuance, outbox);
const timeService = new ValePassPaymentTimeService(prisma, fakeShopify, flagFns);

const money = (amount: string) => ({ shop_money: { amount, currency_code: 'BRL' }, presentment_money: { amount, currency_code: 'BRL' } });
const hoursAgo = (hours: number) => new Date(Date.now() - hours * HOUR).toISOString();
const gidOf = (orderId: string) => `gid://shopify/Order/${orderId}`;

interface Campaign extends ValePassCampaign { numericVariant: string }
async function newCampaign(): Promise<Campaign> {
  const numericVariant = String(940_000_000_000 + counter++);
  const campaign = await prisma.valePassCampaign.create({
    data: { name: `${TAG}-camp-${counter++}`, amountCents: 35_000, validityDays: 30, globalLimit: 1_000, shopifyVariantId: numericVariant, voucherValidFrom: new Date('2026-01-01T00:00:00.000Z'), voucherValidUntil: new Date('2027-12-31T00:00:00.000Z') },
  });
  campaignIds.push(campaign.id);
  await prisma.valePassCampaignBenefit.createMany({
    data: [
      { campaignId: campaign.id, code: 'valle_showroom_500', kind: 'VOUCHER', company: 'VALLE_SHOWROOM', label: 'Voucher Valle Showroom', amountCents: 50_000, sortOrder: 0 },
      { campaignId: campaign.id, code: 'vs_by_closet_50', kind: 'VOUCHER', company: 'VS_BY_CLOSET', label: 'Voucher VS BY CLOSET', amountCents: 5_000, sortOrder: 1 },
    ],
  });
  return { ...campaign, numericVariant };
}

function paidPayload(campaign: Campaign, quantity: number, over: Record<string, unknown> = {}): Record<string, unknown> {
  const orderId = `${TAG}-o${counter++}`;
  orderIds.push(orderId);
  return {
    id: orderId, admin_graphql_api_id: gidOf(orderId), name: `#${TAG}${counter}`, financial_status: 'paid', cancelled_at: null, currency: 'BRL', presentment_currency: 'BRL',
    created_at: hoursAgo(10), updated_at: hoursAgo(9), test: false, payment_gateway_names: ['Gateway Pix'],
    current_total_price: ((35000 * quantity) / 100).toFixed(2), total_outstanding: '0.00', total_discounts: '0.00', discount_codes: [], refunds: [],
    total_shipping_price_set: money('0.00'), email: `cliente${counter}@exemplo.invalid`, customer: { first_name: 'Cliente', last_name: 'Sintético', email: `cliente${counter}@exemplo.invalid` },
    line_items: [{ variant_id: Number(campaign.numericVariant), product_id: null, quantity, current_quantity: quantity, price: '350.00', price_set: money('350.00'), discount_allocations: [] }],
    ...over,
  };
}

const run = (topic: string, payload: Record<string, unknown>, triggeredAt: string | null) =>
  prisma.$transaction(async (tx) => {
    await lockShopifyOrder(tx, String(payload.id));
    return webhook.handleOrderWebhook(tx, topic, payload, { triggeredAt });
  }, { timeout: 30_000, maxWait: 20_000 });
async function storeEvent(topic: string, payload: Record<string, unknown>) {
  await prisma.webhookEvent.create({ data: { shopifyWebhookId: `${TAG}-wh${counter++}`, storeId: `${TAG}-store`, topic, payload: payload as never, status: 'processed' as never, orderId: String(payload.id) } });
}

const txn = (over: Partial<Tx> = {}): Tx => ({ id: `gid://shopify/OrderTransaction/${counter++}`, kind: 'SALE', status: 'SUCCESS', test: false, processedAt: hoursAgo(9), amount: '350.00', currency: 'BRL', gateway: 'gateway_pix', ...over });
const shopify = (orderId: string, transactions: Tx[], total = '350.00') => fakeTransactions.set(gidOf(orderId), { orderGid: gidOf(orderId), totalAmount: total, currency: 'BRL', transactions });

/** Pedido pago (política ESTRITA de produção), entregue com sinais perfeitos do webhook → retenção PAYMENT_TIME_UNKNOWN. */
async function heldOrder(over: Record<string, unknown> = {}, quantity = 1, paidHoursAgo = 9) {
  const campaign = await newCampaign();
  const paidAt = hoursAgo(paidHoursAgo);
  const payload = paidPayload(campaign, quantity, { created_at: hoursAgo(paidHoursAgo + 1), updated_at: paidAt, ...over });
  const orderId = String(payload.id);
  await run('orders/paid', payload, paidAt);
  await storeEvent('orders/paid', payload);
  return { campaign, payload, orderId, paidAt };
}

const vouchersOf = (orderId: string) => prisma.valePass.findMany({ where: { shopifyOrderId: orderId } });
const holdsOf = (orderId: string) => prisma.valePassIssuanceHold.findMany({ where: { shopifyOrderId: orderId } });
const outboxOf = (orderId: string) => prisma.valePassEmailOutbox.findMany({ where: { shopifyOrderId: orderId } });
const registryOf = (orderId: string) => prisma.valePassOrder.findUniqueOrThrow({ where: { shopifyOrderId: orderId } });
const issueCodes = (hold: { detail: unknown }) => ((hold.detail as { issues?: { code: string }[] } | null)?.issues ?? []).map((issue) => issue.code);
const autoOf = async (orderId: string) => ((await registryOf(orderId)).paymentTimeEvidence as { auto?: { attempts: number; lastReason: string; nextAttemptAt?: string } } | null)?.auto;
const autoAudits = () => prisma.adminAuditEvent.findMany({ where: { action: 'VALE_PASS_PAYMENT_TIME_AUTO_CONFIRMED' } });

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
    const regs = await tx.valePassOrder.findMany({ where: { shopifyOrderId: { in: orders } }, select: { id: true } });
    const outboxRows = await tx.valePassEmailOutbox.findMany({ where: { shopifyOrderId: { in: orders } }, select: { id: true } });
    await tx.valePassEmailEvent.deleteMany({ where: { outboxId: { in: outboxRows.map((row) => row.id) } } });
    await tx.valePassEmailOutbox.deleteMany({ where: { shopifyOrderId: { in: orders } } });
    await tx.adminAuditEvent.deleteMany({ where: { OR: [{ entityId: { in: [...holds.map((h) => h.id), ...vouchers.map((v) => v.id), ...regs.map((r) => r.id)] } }, { adminUserId: adminId }] } });
    await tx.valePassEvent.deleteMany({ where: { valePassId: { in: vouchers.map((v) => v.id) } } });
    await tx.valePass.deleteMany({ where: { campaignId: { in: ids } } });
    await tx.valePassIssuanceHold.deleteMany({ where: { campaignId: { in: ids } } });
    await tx.valePassCampaignBenefit.deleteMany({ where: { campaignId: { in: ids } } });
    await tx.valePassCampaign.deleteMany({ where: { id: { in: ids } } });
    await tx.valePassRefundApplication.deleteMany({ where: { shopifyOrderId: { in: orders } } });
    await tx.valePassOrderEvent.deleteMany({ where: { valePassOrderId: { in: regs.map((r) => r.id) } } });
    await tx.valePassOrderCancellation.deleteMany({ where: { shopifyOrderId: { in: orders } } });
    await tx.valePassOrder.deleteMany({ where: { shopifyOrderId: { in: orders } } });
    await tx.webhookEvent.deleteMany({ where: { storeId: `${TAG}-store` } });
  });
  flags.twoVoucher = true;
  flags.auto = true;
  fakeTransactions.clear();
  shopifyCalls = 0;
  shopifyBehaviour = async (gid) => fakeTransactions.get(gid) ?? null;
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

localDescribe('VERIFICAÇÃO AUTOMÁTICA — desligada por padrão', () => {
  test('sem a chave (ou sem a integração dos dois vouchers) nada é consultado nem emitido', async () => {
    expect(autoVerifyEnabled({ twoVoucher: () => true, unitRefunds: () => false })).toBe(false); // chave ausente = desligada
    expect(autoVerifyEnabled({ twoVoucher: () => false, unitRefunds: () => false, autoVerify: () => true })).toBe(false); // exige as duas
    const { orderId } = await heldOrder();
    shopify(orderId, [txn()]);
    flags.auto = false;
    expect(await auto().runOnce()).toMatchObject({ enabled: false, considered: 0 });
    flags.auto = true;
    flags.twoVoucher = false;
    expect(await auto().runOnce()).toMatchObject({ enabled: false, considered: 0 });
    expect(shopifyCalls).toBe(0);
    expect((await registryOf(orderId)).paymentConfirmedAt).toBeNull();
    expect(await vouchersOf(orderId)).toHaveLength(0);
  });
});

localDescribe('VERIFICAÇÃO AUTOMÁTICA — pagamento aprovado', () => {
  test('Pix/cartão aprovado: confirma o horário PELA TRANSAÇÃO, retoma pelo caminho completo, emite 2 vouchers + 1 e-mail (prazo = transação + 3 dias); auditoria do sistema; idempotente', async () => {
    const { orderId, paidAt } = await heldOrder();
    expect(issueCodes((await holdsOf(orderId))[0])).toEqual(['PAYMENT_TIME_UNKNOWN']);
    shopify(orderId, [txn({ processedAt: paidAt })]);
    const report = await auto().runOnce();
    expect(report).toMatchObject({ enabled: true, considered: 1, confirmed: 1, issued: 1, reclassified: 0 });
    const registry = await registryOf(orderId);
    expect(registry).toMatchObject({ paymentConfirmedSource: 'ADMIN_API_TRANSACTION_AUTO' });
    expect(registry.paymentConfirmedAt?.toISOString()).toBe(paidAt);
    expect(await vouchersOf(orderId)).toHaveLength(2);
    expect((await holdsOf(orderId))[0].status).not.toBe('OPEN');
    const rows = await outboxOf(orderId);
    expect(rows).toHaveLength(1);
    expect(rows[0].deadlineAt.getTime()).toBe(new Date(paidAt).getTime() + 3 * DAY);
    const [audit] = await autoAudits();
    expect(audit).toMatchObject({ adminUserId: null, isCritical: true, entityType: 'ValePassOrder' });
    expect(JSON.stringify(audit)).not.toMatch(/@exemplo/);
    // segunda execução: nada novo (idempotente)
    expect(await auto().runOnce()).toMatchObject({ considered: 0, issued: 0 });
    expect(await vouchersOf(orderId)).toHaveLength(2);
    expect(await autoAudits()).toHaveLength(1);
  });

  test('3 unidades pagas de uma vez (R$ 1.050,00): 6 vouchers e 3 mensagens', async () => {
    const { orderId, paidAt } = await heldOrder({}, 3);
    shopify(orderId, [txn({ processedAt: paidAt, amount: '1050.00' })], '1050.00');
    expect(await auto().runOnce()).toMatchObject({ issued: 1 });
    expect(await vouchersOf(orderId)).toHaveLength(6);
    expect(await outboxOf(orderId)).toHaveLength(3);
  });

  test('cartão capturado depois: a AUTORIZAÇÃO sozinha não emite; o CAPTURE emite', async () => {
    const { orderId, paidAt } = await heldOrder();
    shopify(orderId, [txn({ kind: 'AUTHORIZATION', processedAt: hoursAgo(60) })]);
    expect(await auto().runOnce()).toMatchObject({ considered: 1, issued: 0, held: [{ reason: 'NO_SUCCESS_TRANSACTION' }] });
    expect(await vouchersOf(orderId)).toHaveLength(0);
    shopify(orderId, [txn({ kind: 'AUTHORIZATION', processedAt: hoursAgo(60) }), txn({ kind: 'CAPTURE', processedAt: paidAt })]);
    expect(await auto().runOnce(new Date(Date.now() + 3 * 60_000))).toMatchObject({ issued: 1 });
    expect(await vouchersOf(orderId)).toHaveLength(2);
  });
});

localDescribe('VERIFICAÇÃO AUTOMÁTICA — pagamento NÃO comprovado: a retenção continua e nada é emitido', () => {
  test('Pix pendente: tentativa registrada, próxima em ~1 min (nada de martelar a Shopify); depois do Pix pago, emite', async () => {
    const { orderId, paidAt } = await heldOrder();
    shopify(orderId, [txn({ status: 'PENDING' })]);
    const t0 = new Date();
    expect(await auto().runOnce(t0)).toMatchObject({ considered: 1, issued: 0 });
    expect(await autoOf(orderId)).toMatchObject({ attempts: 1, lastReason: 'NO_SUCCESS_TRANSACTION' });
    expect(new Date((await autoOf(orderId))!.nextAttemptAt!).getTime() - t0.getTime()).toBe(60_000);
    const callsBefore = shopifyCalls;
    expect(await auto().runOnce(new Date(t0.getTime() + 30_000))).toMatchObject({ considered: 0 }); // ainda não venceu
    expect(shopifyCalls).toBe(callsBefore);
    shopify(orderId, [txn({ processedAt: paidAt })]);
    expect(await auto().runOnce(new Date(t0.getTime() + 61_000))).toMatchObject({ issued: 1 });
    expect(await vouchersOf(orderId)).toHaveLength(2);
  });

  test('Pix divergente (processedAt = criação da cobrança, 9 h antes): TRANSACTION_DIVERGENT, motivo visível ao ADMIN, nada emitido', async () => {
    const { orderId } = await heldOrder({}, 1, 1);
    shopify(orderId, [txn({ processedAt: hoursAgo(10) })]);
    expect(await auto().runOnce()).toMatchObject({ held: [{ reason: 'TRANSACTION_DIVERGENT' }] });
    expect((await registryOf(orderId)).paymentConfirmedAt).toBeNull();
    expect(await vouchersOf(orderId)).toHaveLength(0);
    const candidate = (await timeService.candidates()).find((c) => c.orderId === orderId)!;
    expect(candidate.transactionReason).toBe('TRANSACTION_DIVERGENT');
    expect(await autoAudits()).toHaveLength(0);
  });

  test.each([
    ['cartão recusado', [{ status: 'FAILURE' }], 'NO_SUCCESS_TRANSACTION'],
    ['cartão estornado', [{}, { kind: 'REFUND' }], 'REFUND_TRANSACTION_PRESENT'],
    ['transação de teste', [{ test: true }], 'ONLY_TEST_TRANSACTIONS'],
    ['transação com gateway manual', [{ gateway: 'manual' }], 'MANUAL_TRANSACTION'],
    ['pagamento parcial', [{ amount: '100.00' }], 'PARTIAL_PAYMENT'],
    ['pago a mais (duas vendas)', [{}, { processedAt: hoursAgo(8) }], 'AMBIGUOUS_OVERPAYMENT'],
  ] as const)('%s → %s', async (_name, overrides, expected) => {
    const { orderId } = await heldOrder();
    shopify(orderId, overrides.map((o) => txn(o as Partial<Tx>)));
    expect(await auto().runOnce()).toMatchObject({ issued: 0, held: [{ reason: expected }] });
    expect((await registryOf(orderId)).paymentConfirmedAt).toBeNull();
    expect(await vouchersOf(orderId)).toHaveLength(0);
    expect((await holdsOf(orderId))[0].status).toBe('OPEN');
  });

  test('transações de OUTRO pedido, total diferente do preço × quantidade e moeda ≠ BRL → retém', async () => {
    const a = await heldOrder();
    fakeTransactions.set(gidOf(a.orderId), { orderGid: 'gid://shopify/Order/999', totalAmount: '350.00', currency: 'BRL', transactions: [txn({ processedAt: a.paidAt })] });
    const b = await heldOrder();
    shopify(b.orderId, [txn({ processedAt: b.paidAt, amount: '300.00' })], '300.00'); // desconto
    const c = await heldOrder();
    fakeTransactions.set(gidOf(c.orderId), { orderGid: gidOf(c.orderId), totalAmount: '350.00', currency: 'USD', transactions: [txn({ processedAt: c.paidAt, currency: 'USD' })] });
    const report = await auto().runOnce();
    expect(report.held.map((h) => h.reason).sort()).toEqual(['CURRENCY_NOT_BRL', 'ORDER_MISMATCH', 'ORDER_TOTAL_MISMATCH']);
    for (const orderId of [a.orderId, b.orderId, c.orderId]) expect(await vouchersOf(orderId)).toHaveLength(0);
  });

  test('Shopify INDISPONÍVEL (erro de rede) ou pedido não devolvido: retém, registra, tenta de novo depois, nada emitido', async () => {
    const { orderId, paidAt } = await heldOrder();
    shopifyBehaviour = async () => { throw new Error('ECONNRESET'); };
    expect(await auto().runOnce()).toMatchObject({ held: [{ reason: 'SHOPIFY_UNAVAILABLE' }] });
    expect(await vouchersOf(orderId)).toHaveLength(0);
    expect(await autoOf(orderId)).toMatchObject({ lastReason: 'SHOPIFY_UNAVAILABLE' });
    shopifyBehaviour = async () => null;
    expect(await auto().runOnce(new Date(Date.now() + 2 * 60_000))).toMatchObject({ held: [{ reason: 'ORDER_NOT_RETURNED' }] });
    shopify(orderId, [txn({ processedAt: paidAt })]);
    shopifyBehaviour = async (gid) => fakeTransactions.get(gid) ?? null;
    expect(await auto().runOnce(new Date(Date.now() + 8 * 3_600_000))).toMatchObject({ issued: 1 }); // recuperou
    expect(await vouchersOf(orderId)).toHaveLength(2);
  });

  test('reconciliação sem NENHUM sinal de webhook: a transação sozinha não confirma automaticamente (vai para o ADMIN)', async () => {
    const campaign = await newCampaign();
    const base = paidPayload(campaign, 1, { created_at: hoursAgo(31), updated_at: hoursAgo(30) });
    const orderId = String(base.id);
    await run('orders/updated', base, null);
    await storeEvent('orders/updated', base);
    shopify(orderId, [txn({ processedAt: hoursAgo(30) })]);
    expect(await auto().runOnce()).toMatchObject({ issued: 0, held: [{ reason: 'NO_CORROBORATION' }] });
    expect(await vouchersOf(orderId)).toHaveLength(0);
  });
});

localDescribe('VERIFICAÇÃO AUTOMÁTICA — confirmar o horário NÃO libera a emissão: a validação financeira completa continua mandando', () => {
  test('pedido com test: true → horário confirmado, mas a retomada reclassifica como TEST_ORDER; NENHUM voucher; ADMIN não consegue emitir, só descartar', async () => {
    const { orderId, paidAt } = await heldOrder({ test: true });
    shopify(orderId, [txn({ processedAt: paidAt })]);
    expect(await auto().runOnce()).toMatchObject({ confirmed: 1, issued: 0, reclassified: 1 });
    expect(await vouchersOf(orderId)).toHaveLength(0);
    expect(await outboxOf(orderId)).toHaveLength(0);
    const [hold] = await holdsOf(orderId);
    expect(hold.status).toBe('OPEN');
    expect(issueCodes(hold)).toContain('TEST_ORDER');
    await expect(holdsService.issue(hold.id, { note: 'Tentativa de emitir pedido de teste', confirmTotal: 1, expected: {} as never }, adminId, ADMIN_NAME)).rejects.toThrow(/TESTE/);
    await holdsService.dismiss(hold.id, 'Pedido de teste da Shopify, descartado', adminId, ADMIN_NAME);
    expect((await holdsOf(orderId))[0].status).toBe('DISMISSED');
    expect(await vouchersOf(orderId)).toHaveLength(0);
  });

  test('pagamento MANUAL no pedido (payment_gateway_names inclui "manual") → reclassifica como MANUAL_PAYMENT; nenhum voucher automático', async () => {
    const { orderId, paidAt } = await heldOrder({ payment_gateway_names: ['Gateway Pix', 'manual'] });
    shopify(orderId, [txn({ processedAt: paidAt })]);
    expect(await auto().runOnce()).toMatchObject({ issued: 0, reclassified: 1 });
    expect(await vouchersOf(orderId)).toHaveLength(0);
    expect(issueCodes((await holdsOf(orderId))[0])).toContain('MANUAL_PAYMENT');
  });

  test('desconto/total divergente no webhook → a retomada reclassifica (a validação do webhook também vale)', async () => {
    const { orderId, paidAt } = await heldOrder({ total_discounts: '35.00', current_total_price: '315.00' });
    shopify(orderId, [txn({ processedAt: paidAt })]);
    // o total da Shopify (R$ 350) bate com a transação, mas o webhook mostra desconto: o guarda financeiro segura
    const report = await auto().runOnce();
    expect(report.issued).toBe(0);
    expect(await vouchersOf(orderId)).toHaveLength(0);
  });

  test('o ADMIN também não contorna: a retomada manual e a emissão excepcional respeitam TEST_ORDER; a retomada reavalia MANUAL_PAYMENT', async () => {
    const { orderId, paidAt } = await heldOrder({ test: true });
    await timeService.confirmManually({ id: adminId, name: ADMIN_NAME }, { orderId, confirmedAt: paidAt, note: 'Horário conferido (teste)' });
    expect(await flow.resumeHeldPayments({ id: adminId, name: ADMIN_NAME }, { note: 'retomar' })).toMatchObject({ issued: 0 });
    expect(await vouchersOf(orderId)).toHaveLength(0);
    expect((await flow.regularizeOrder({ id: adminId, name: ADMIN_NAME }, { orderId, note: 'Regularizar pedido de teste' })).outcome).toMatchObject({ status: 'HELD' });
    expect(await vouchersOf(orderId)).toHaveLength(0);
  });
});

localDescribe('VERIFICAÇÃO AUTOMÁTICA — webhooks duplicados/fora de ordem, concorrência e mudança do pedido', () => {
  test('orders/paid duplicado + orders/updated antigo depois: uma retenção, uma emissão, dois vouchers', async () => {
    const { orderId, payload, paidAt } = await heldOrder();
    await run('orders/paid', payload, paidAt); // reentrega idêntica
    await run('orders/updated', { ...payload, financial_status: 'pending', updated_at: hoursAgo(20) }, null); // estado mais ANTIGO, chegando depois
    expect(await holdsOf(orderId)).toHaveLength(1);
    shopify(orderId, [txn({ processedAt: paidAt })]);
    expect(await auto().runOnce()).toMatchObject({ issued: 1 });
    await run('orders/paid', payload, paidAt); // reentrega DEPOIS da emissão
    expect(await vouchersOf(orderId)).toHaveLength(2);
    expect(await outboxOf(orderId)).toHaveLength(1);
    expect(await auto().runOnce()).toMatchObject({ considered: 0 });
  });

  test('5 execuções SIMULTÂNEAS: exatamente uma emite; uma auditoria; uma mensagem', async () => {
    const { orderId, paidAt } = await heldOrder();
    shopify(orderId, [txn({ processedAt: paidAt })]);
    const reports = await Promise.all(Array.from({ length: 5 }, () => auto().runOnce()));
    expect(reports.reduce((sum, r) => sum + r.issued, 0)).toBe(1);
    expect(await vouchersOf(orderId)).toHaveLength(2);
    expect(await outboxOf(orderId)).toHaveLength(1);
    expect(await autoAudits()).toHaveLength(1);
  });

  test('execução automática SIMULTÂNEA a uma retomada/confirmação do ADMIN: nunca emite duas vezes', async () => {
    const { orderId, paidAt } = await heldOrder();
    shopify(orderId, [txn({ processedAt: paidAt })]);
    await Promise.all([
      auto().runOnce(),
      timeService.confirmManually({ id: adminId, name: ADMIN_NAME }, { orderId, confirmedAt: paidAt, note: 'Conferido no painel (teste)' }).catch(() => undefined),
    ]);
    await flow.resumeHeldPayments({ id: adminId, name: ADMIN_NAME }, { note: 'retomar' });
    expect(await vouchersOf(orderId)).toHaveLength(2);
    expect(await outboxOf(orderId)).toHaveLength(1);
  });

  test('o pedido MUDA enquanto a Shopify é consultada (quantidade/atualização): a verificação é descartada e nada é emitido; na próxima volta, refaz do zero', async () => {
    const { orderId, paidAt } = await heldOrder();
    shopify(orderId, [txn({ processedAt: paidAt })]);
    shopifyBehaviour = async (gid) => {
      await prisma.valePassOrder.update({ where: { shopifyOrderId: orderId }, data: { shopifyUpdatedAt: new Date() } }); // outro webhook chegou durante a consulta
      return fakeTransactions.get(gid) ?? null;
    };
    expect(await auto().runOnce()).toMatchObject({ issued: 0, held: [{ reason: 'ORDER_CHANGED_DURING_CHECK' }] });
    expect(await vouchersOf(orderId)).toHaveLength(0);
    expect((await registryOf(orderId)).paymentConfirmedAt).toBeNull();
    shopifyBehaviour = async (gid) => fakeTransactions.get(gid) ?? null;
    expect(await auto().runOnce(new Date(Date.now() + 2 * 60_000))).toMatchObject({ issued: 1 });
  });

  test('pedido cancelado/reembolsado ou excluído durante a consulta: nada é emitido', async () => {
    const { orderId, paidAt } = await heldOrder();
    shopify(orderId, [txn({ processedAt: paidAt })]);
    shopifyBehaviour = async (gid) => {
      await prisma.valePassOrder.update({ where: { shopifyOrderId: orderId }, data: { status: 'CANCELLED' } });
      return fakeTransactions.get(gid) ?? null;
    };
    expect(await auto().runOnce()).toMatchObject({ issued: 0 });
    expect(await vouchersOf(orderId)).toHaveLength(0);
  });

  test('só pega retenções cujo ÚNICO motivo é PAYMENT_TIME_UNKNOWN: outras (ex.: capacidade, quantidade) ficam para o ADMIN', async () => {
    const { orderId, paidAt } = await heldOrder();
    shopify(orderId, [txn({ processedAt: paidAt })]);
    const [hold] = await holdsOf(orderId);
    await prisma.valePassIssuanceHold.update({ where: { id: hold.id }, data: { detail: { issues: [{ code: 'PAYMENT_TIME_UNKNOWN' }, { code: 'QUANTITY_INCREASED' }] } } });
    expect(await auto().runOnce()).toMatchObject({ considered: 0 });
    expect(shopifyCalls).toBe(0);
  });
});

localDescribe('VERIFICAÇÃO AUTOMÁTICA — fila justa', () => {
  test('retenções ignoradas (pedido excluído na Shopify) não ocupam o lote: o pedido pago atrás delas ainda é verificado', async () => {
    for (let i = 0; i < 11; i++) {
      const dead = await heldOrder();
      await prisma.valePassOrder.update({ where: { shopifyOrderId: dead.orderId }, data: { deletedInShopifyAt: new Date() } });
    }
    const { orderId, paidAt } = await heldOrder();
    shopify(orderId, [txn({ processedAt: paidAt })]);
    expect(await auto().runOnce()).toMatchObject({ considered: 1, issued: 1 });
    expect(await vouchersOf(orderId)).toHaveLength(2);
  });
});

localDescribe('VERIFICAÇÃO AUTOMÁTICA — falha de envio e recuperação segura', () => {
  test('a emissão grava os vouchers e a fila mesmo se o envio falhar; o worker recupera sem duplicar e sem perder', async () => {
    const { orderId, paidAt } = await heldOrder();
    shopify(orderId, [txn({ processedAt: paidAt })]);
    expect(await auto().runOnce()).toMatchObject({ issued: 1 });
    const results: SendEmailResult[] = [{ kind: 'rejected', status: 503, reason: 'temporarily unavailable', permanent: false }, { kind: 'accepted', messageId: 'msg-1' }];
    const calls: string[] = [];
    const provider: EmailProvider = { send: async (input: { idempotencyKey: string }) => { calls.push(input.idempotencyKey); return results.shift() ?? { kind: 'accepted', messageId: 'msg-x' }; } } as unknown as EmailProvider;
    const config = loadEmailConfig({ VALE_PASS_EMAIL_MODE: 'live', RESEND_API_KEY: 're_test_key', VALE_PASS_EMAIL_DOMAIN_VERIFIED: 'true', VALE_PASS_EMAIL_DAILY_LIMIT: '1000' });
    const worker = new ValePassEmailWorkerService(prisma, new ValePassEmailOutboxService(prisma, config), config, provider);
    worker.rng = () => 0.5;
    await worker.tick(new Date(Date.now() + 5_000));
    expect(await vouchersOf(orderId)).toHaveLength(2); // a falha do envio nunca desfaz a emissão
    await worker.tick(new Date(Date.now() + 6 * 3_600_000));
    expect(new Set(calls).size).toBe(1); // mesma chave de idempotência nas duas tentativas
    expect((await outboxOf(orderId))[0].status).toBe('ACCEPTED');
    expect(await auto().runOnce()).toMatchObject({ considered: 0 });
    expect(await outboxOf(orderId)).toHaveLength(1);
  });
});

localDescribe('VERIFICAÇÃO AUTOMÁTICA — estorno entre a consulta e a emissão (risco residual)', () => {
  const refundOf = (campaign: Campaign, orderId: string) => ({
    id: `${TAG}-rf${counter++}`, order_id: orderId, refund_shipping_lines: [], transactions: [], order_adjustments: [],
    refund_line_items: [{ id: 1, line_item_id: 1, quantity: 1, subtotal: 350, total_tax: 0, restock_type: 'return', line_item: { variant_id: Number(campaign.numericVariant), product_id: null, price: '350.00', quantity: 1 } }],
  });
  const workerWith = (provider: EmailProvider) => {
    const config = loadEmailConfig({ VALE_PASS_EMAIL_MODE: 'live', RESEND_API_KEY: 're_test_key', VALE_PASS_EMAIL_DOMAIN_VERIFIED: 'true', VALE_PASS_EMAIL_DAILY_LIMIT: '1000' });
    const worker = new ValePassEmailWorkerService(prisma, new ValePassEmailOutboxService(prisma, config), config, provider);
    worker.rng = () => 0.5;
    return worker;
  };

  test('estorno PARCIAL já visível na Shopify, com o webhook de reembolso ainda atrasado: a consulta enxerga e RETÉM (webhook atrasado não engana a verificação)', async () => {
    const { orderId, paidAt } = await heldOrder();
    shopify(orderId, [txn({ processedAt: paidAt }), txn({ kind: 'REFUND', amount: '100.00', processedAt: hoursAgo(1) })], '250.00'); // total corrente já reduzido
    expect(await auto().runOnce()).toMatchObject({ issued: 0, held: [{ reason: 'REFUND_TRANSACTION_PRESENT' }] });
    expect(await vouchersOf(orderId)).toHaveLength(0);
    shopify(orderId, [txn({ processedAt: paidAt })], '250.00'); // só o total reduzido (ajuste/estorno sem transação listada)
    expect(await auto().runOnce(new Date(Date.now() + 7 * 3_600_000))).toMatchObject({ issued: 0, held: [{ reason: 'AMBIGUOUS_OVERPAYMENT' }] });
    expect(await vouchersOf(orderId)).toHaveLength(0);
  });

  test('assentamento: o e-mail da emissão automática NÃO sai durante a janela; reembolso que chega nesse intervalo cancela os vouchers e nenhuma mensagem é enviada', async () => {
    const { campaign, orderId, paidAt } = await heldOrder();
    shopify(orderId, [txn({ processedAt: paidAt })]);
    expect(await auto(600_000).runOnce()).toMatchObject({ issued: 1 });
    const [row] = await outboxOf(orderId);
    expect(row.nextAttemptAt.getTime()).toBeGreaterThan(Date.now() + 590_000);
    const sent: string[] = [];
    const provider = { send: async (input: { idempotencyKey: string }): Promise<SendEmailResult> => { sent.push(input.idempotencyKey); return { kind: 'accepted', messageId: 'm' }; } } as unknown as EmailProvider;
    await workerWith(provider).tick(new Date(Date.now() + 30_000));
    expect(sent).toHaveLength(0); // dentro da janela: nada sai
    // o estorno (feito logo depois da consulta) chega pelo webhook atrasado, ainda dentro da janela
    await prisma.$transaction(async (tx) => {
      await lockShopifyOrder(tx, orderId);
      await webhook.handleRefund(tx, refundOf(campaign, orderId) as never);
    }, { timeout: 30_000, maxWait: 20_000 });
    await workerWith(provider).tick(new Date(Date.now() + 11 * 60_000)); // janela já vencida
    expect(sent).toHaveLength(0); // o worker reavaliou o pedido e NÃO enviou
    expect((await outboxOf(orderId))[0]).toMatchObject({ status: 'NEEDS_ATTENTION', lastError: 'refund_under_review' });
    expect((await vouchersOf(orderId)).every((v) => v.status === 'ACTIVE')).toBe(true); // continuam bloqueados para uso pela revisão; só o e-mail foi contido
  });

  test('sem estorno, depois da janela o e-mail sai normalmente (uma vez)', async () => {
    const { orderId, paidAt } = await heldOrder();
    shopify(orderId, [txn({ processedAt: paidAt })]);
    await auto(600_000).runOnce();
    const sent: string[] = [];
    const provider = { send: async (input: { idempotencyKey: string }): Promise<SendEmailResult> => { sent.push(input.idempotencyKey); return { kind: 'accepted', messageId: 'm' }; } } as unknown as EmailProvider;
    await workerWith(provider).tick(new Date(Date.now() + 11 * 60_000));
    expect(sent).toHaveLength(1);
  });
});

localDescribe('VERIFICAÇÃO AUTOMÁTICA — agendador', () => {
  test('o agendador não sobrepõe execuções e nunca derruba o processo', async () => {
    const calls: number[] = [];
    const slow = { runOnce: async () => { calls.push(1); await new Promise((r) => setTimeout(r, 30)); throw new Error('falha qualquer'); } } as unknown as ValePassAutoVerifyService;
    const scheduler = new ValePassAutoVerifyScheduler(slow, flagFns);
    await Promise.all([scheduler.runOnce(), scheduler.runOnce(), scheduler.runOnce()]);
    expect(calls).toHaveLength(1);
    await scheduler.runOnce();
    expect(calls).toHaveLength(2);
  });
});
