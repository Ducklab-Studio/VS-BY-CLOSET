import { afterAll, afterEach, beforeAll, describe, expect, test } from 'vitest';
import type { ValePassCampaign } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { lockShopifyOrder } from '../../webhooks/shopify-order-lock';
import { loadEmailConfig } from '../email/email-config';
import { ValePassEmailOutboxService } from '../email/email-outbox.service';
import { ValePassFinancialGuard } from '../financial/financial-guard.service';
import { ValePassIssuanceService } from '../vale-pass-issuance.service';
import { ValePassLotsService } from '../vale-pass-lots.service';
import { ValePassRefundService } from '../refunds/refund.service';
import { ValePassRegularizationService } from '../refunds/regularization.service';
import { ValePassWebhookService } from '../vale-pass-webhook.service';
import type { FlowFlags } from './flow-flags';
import { ValePassPaymentFlowService } from './payment-flow.service';

/**
 * Encerramento das vendas (VALE_PASS_SALES_CLOSE_GUARD) e esgotamento do limite global, em PostgreSQL LOCAL descartável: pagamento → registro do pedido →
 * validação financeira → emissão ou RETENÇÃO. Nenhuma Shopify, nenhum e-mail enviado, nada cancelado nem reembolsado.
 */
const localDatabase = /^postgres(?:ql)?:\/\/[^@]+@(localhost|127\.0\.0\.1)(:\d+)?\/[^/]*(test|audit|operational)/i.test(process.env.DATABASE_URL ?? '');
const localDescribe = localDatabase ? describe : describe.skip;

const prisma = new PrismaService();
const issuance = new ValePassIssuanceService();
const outbox = new ValePassEmailOutboxService(prisma, loadEmailConfig({}));
const refunds = new ValePassRefundService(prisma);
const lots = new ValePassLotsService(prisma);
const TAG = `VPSC-${Date.now()}`;
let counter = 0;
const campaignIds: string[] = [];
const orderIds: string[] = [];

/** Chaves controladas pelo teste (o padrão de produção é tudo DESLIGADO). */
const flags = { twoVoucher: false, salesClose: false };
const flagFns: FlowFlags = {
  twoVoucher: () => flags.twoVoucher,
  unitRefunds: () => false,
  paymentTime: () => ({ mode: 'webhook-agreement', toleranceSeconds: 120 }),
  salesCloseGuard: () => flags.salesClose,
};
const regularization = new ValePassRegularizationService(prisma, new ValePassFinancialGuard(), issuance);
const service = () => new ValePassWebhookService(new ValePassPaymentFlowService(new ValePassFinancialGuard(), issuance, outbox, flagFns, prisma, regularization), refunds, flagFns);

const money = (amount: string) => ({ shop_money: { amount, currency_code: 'BRL' }, presentment_money: { amount, currency_code: 'BRL' } });

interface Campaign extends ValePassCampaign { numericVariant: string }
async function newCampaign(over: Partial<{ globalLimit: number | null }> = {}): Promise<Campaign> {
  const numericVariant = String(900_000_000_000 + counter++);
  const campaign = await prisma.valePassCampaign.create({
    data: {
      name: `${TAG}-camp-${counter++}`, amountCents: 35_000, validityDays: 30, globalLimit: over.globalLimit === undefined ? 1_000 : over.globalLimit, shopifyVariantId: numericVariant,
      voucherValidFrom: new Date('2026-01-01T00:00:00.000Z'), voucherValidUntil: new Date('2027-12-31T00:00:00.000Z'),
    },
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

let clock = Date.now();
function paidPayload(campaign: Campaign, quantity: number, orderId = `${TAG}-o${counter++}`): Record<string, unknown> {
  orderIds.push(orderId);
  clock += 1000;
  return {
    id: orderId, admin_graphql_api_id: `gid://shopify/Order/${orderId}`, name: `#${TAG}${counter}`, financial_status: 'paid', cancelled_at: null, currency: 'BRL', presentment_currency: 'BRL',
    created_at: new Date(clock - 60_000).toISOString(), updated_at: new Date(clock).toISOString(),
    current_total_price: ((35000 * quantity) / 100).toFixed(2), total_outstanding: '0.00', total_discounts: '0.00', discount_codes: [], refunds: [],
    total_shipping_price_set: money('0.00'), email: `cliente${counter}@exemplo.invalid`, customer: { first_name: 'Cliente', last_name: 'Sintético', email: `cliente${counter}@exemplo.invalid` },
    line_items: [{ variant_id: Number(campaign.numericVariant), product_id: null, quantity, current_quantity: quantity, price: '350.00', price_set: money('350.00'), discount_allocations: [] }],
  };
}

/** Entrega REALISTA do orders/paid: o cabeçalho e o updated_at do payload são do MESMO instante (o do pagamento). */
const runAt = (svc: ValePassWebhookService, payload: unknown, at: string) =>
  prisma.$transaction(async (tx) => {
    await lockShopifyOrder(tx, String((payload as { id: unknown }).id));
    return svc.handleOrderWebhook(tx, 'orders/paid', { ...(payload as Record<string, unknown>), updated_at: at }, { triggeredAt: at });
  }, { timeout: 30_000, maxWait: 20_000 });

const vouchersOf = (orderId: string) => prisma.valePass.findMany({ where: { shopifyOrderId: orderId }, orderBy: [{ createdAt: 'asc' }, { company: 'asc' }] });
const holdsOf = (orderId: string) => prisma.valePassIssuanceHold.findMany({ where: { shopifyOrderId: orderId } });
const outboxOf = (orderId: string) => prisma.valePassEmailOutbox.findMany({ where: { shopifyOrderId: orderId } });
const registryOf = (orderId: string) => prisma.valePassOrder.findUniqueOrThrow({ where: { shopifyOrderId: orderId } });

beforeAll(async () => {
  if (!localDatabase) return;
  await prisma.store.upsert({ where: { id: `${TAG}-store` }, update: {}, create: { id: `${TAG}-store`, shopifyDomain: `${TAG}.invalid`, currency: 'BRL' } });
});

async function cleanRows() {
  const ids = campaignIds.splice(0);
  const orders = orderIds.splice(0);
  await prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe('SET LOCAL session_replication_role = replica');
    const vouchers = await tx.valePass.findMany({ where: { campaignId: { in: ids } }, select: { id: true } });
    const outboxRows = await tx.valePassEmailOutbox.findMany({ where: { shopifyOrderId: { in: orders } }, select: { id: true } });
    await tx.valePassEmailEvent.deleteMany({ where: { outboxId: { in: outboxRows.map((row) => row.id) } } });
    await tx.valePassEmailOutbox.deleteMany({ where: { shopifyOrderId: { in: orders } } });
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
  flags.salesClose = false;
}
afterEach(async () => {
  if (localDatabase) await cleanRows();
});
afterAll(async () => {
  if (localDatabase) {
    await cleanRows();
    await prisma.store.deleteMany({ where: { id: `${TAG}-store` } });
  }
  await prisma.$disconnect();
});


const issueCodes2 = (hold: { detail: unknown }) => ((hold.detail as { issues?: { code: string }[] } | null)?.issues ?? []).map((issue) => issue.code);
const SALES_END = '2026-05-31';
// 31/05 (ano do teste) 23:59:59 em Brasília (UTC-3) = 01/06 02:59:59Z; 01/06/2027 00:00:00 em Brasília = 03:00:00Z.
const LAST_SECOND = '2026-06-01T02:59:59.000Z';
const FIRST_CLOSED = '2026-06-01T03:00:00.000Z';

async function closingCampaign(over: Partial<{ globalLimit: number | null }> = {}) {
  const campaign = await newCampaign(over);
  await prisma.valePassCampaign.update({ where: { id: campaign.id }, data: { salesEndDate: new Date(`${SALES_END}T00:00:00.000Z`) } });
  return campaign;
}
/** Pedido criado em `createdAt` e pago em `paidAt` (orders/paid realista). */
const paidOrder = async (campaign: Campaign, quantity: number, createdAt: string | null, paidAt: string) => {
  const payload = paidPayload(campaign, quantity);
  await runAt(service(), { ...payload, created_at: createdAt }, paidAt);
  return String(payload.id);
};

localDescribe('encerramento das vendas (chave VALE_PASS_SALES_CLOSE_GUARD)', () => {
  test('DESLIGADA (padrão): pedido criado depois do encerramento emite normalmente (comportamento atual preservado)', async () => {
    flags.twoVoucher = true;
    const campaign = await closingCampaign();
    const orderId = await paidOrder(campaign, 1, FIRST_CLOSED, '2026-06-01T04:00:00.000Z');
    expect(await vouchersOf(orderId)).toHaveLength(2);
    expect(await holdsOf(orderId)).toHaveLength(0);
  });

  test('LIGADA: pedido criado depois do fim do dia 31/05 NÃO emite; fica retido (SALES_CLOSED), sem cancelar nem reembolsar, sem voucher nem e-mail', async () => {
    flags.twoVoucher = true;
    flags.salesClose = true;
    const campaign = await closingCampaign();
    const orderId = await paidOrder(campaign, 2, FIRST_CLOSED, '2026-06-01T03:05:00.000Z');
    expect(await vouchersOf(orderId)).toHaveLength(0);
    expect(await outboxOf(orderId)).toHaveLength(0);
    const holds = await holdsOf(orderId);
    expect(holds).toHaveLength(1);
    expect(holds[0]).toMatchObject({ status: 'OPEN', reason: 'FINANCIAL_MISMATCH', units: 2 });
    expect(issueCodes2(holds[0])).toEqual(['SALES_CLOSED']);
    expect(JSON.stringify(holds[0].detail)).toContain(SALES_END);
    expect((await registryOf(orderId)).status).toBe('CONFIRMED'); // o pedido NÃO é cancelado nem reembolsado
    expect(await prisma.valePassRefundApplication.count({ where: { shopifyOrderId: orderId } })).toBe(0);
    expect(await prisma.valePassOrderCancellation.count({ where: { shopifyOrderId: orderId } })).toBe(0);
    const capacity = await lots.getCapacity(campaign.id);
    expect(capacity.holds).toEqual([expect.objectContaining({ id: holds[0].id, units: 2, issues: ['SALES_CLOSED'] })]);
  });

  test('fronteira: 23:59:59 do dia 31/05 (Brasília) ainda emite; 00:00:00 de 01/06 retém', async () => {
    flags.twoVoucher = true;
    flags.salesClose = true;
    const campaign = await closingCampaign();
    const inTime = await paidOrder(campaign, 1, LAST_SECOND, '2026-06-01T03:10:00.000Z');
    const tooLate = await paidOrder(campaign, 1, FIRST_CLOSED, '2026-06-01T03:10:01.000Z');
    expect(await vouchersOf(inTime)).toHaveLength(2);
    expect(issueCodes2((await holdsOf(tooLate))[0])).toEqual(['SALES_CLOSED']);
    expect(await vouchersOf(tooLate)).toHaveLength(0);
  });

  test('Pix tardio: pedido criado ANTES do encerramento e pago DEPOIS segue emitindo (vale o momento do pedido, nunca o do pagamento)', async () => {
    flags.twoVoucher = true;
    flags.salesClose = true;
    const campaign = await closingCampaign();
    const orderId = await paidOrder(campaign, 1, '2026-05-31T20:00:00.000Z', '2026-06-02T15:00:00.000Z');
    expect(await vouchersOf(orderId)).toHaveLength(2);
    expect(await holdsOf(orderId)).toHaveLength(0);
  });

  test('data de criação ausente: caso ambíguo vai para revisão (SALES_ORDER_DATE_UNKNOWN), nunca emite às cegas', async () => {
    flags.twoVoucher = true;
    flags.salesClose = true;
    const campaign = await closingCampaign();
    const orderId = await paidOrder(campaign, 1, null, '2026-05-20T15:00:00.000Z');
    expect(await vouchersOf(orderId)).toHaveLength(0);
    expect(issueCodes2((await holdsOf(orderId))[0])).toEqual(['SALES_ORDER_DATE_UNKNOWN']);
  });

  test('campanha SEM data de encerramento: a chave ligada não retém nada', async () => {
    flags.twoVoucher = true;
    flags.salesClose = true;
    const campaign = await newCampaign();
    const orderId = await paidOrder(campaign, 1, '2026-07-01T10:00:00.000Z', '2026-07-01T10:05:00.000Z');
    expect(await vouchersOf(orderId)).toHaveLength(2);
  });

  test('reentrega do mesmo webhook e entregas simultâneas: UMA retenção, nada duplicado', async () => {
    flags.twoVoucher = true;
    flags.salesClose = true;
    const campaign = await closingCampaign();
    const payload: Record<string, unknown> = { ...paidPayload(campaign, 1), created_at: FIRST_CLOSED };
    const paidAt = '2026-06-01T03:30:00.000Z';
    await Promise.all(Array.from({ length: 5 }, () => runAt(service(), payload, paidAt)));
    await runAt(service(), payload, paidAt);
    const orderId = String(payload.id);
    expect(await holdsOf(orderId)).toHaveLength(1);
    expect(await vouchersOf(orderId)).toHaveLength(0);
  });
});

localDescribe('esgotamento das 1.000 unidades (limite global, independe da chave)', () => {
  test('com o teto atingido, o pedido seguinte é retido (CAPACITY_EXCEEDED): nada cancelado nem reembolsado, vouchers existentes intactos', async () => {
    flags.twoVoucher = true;
    const campaign = await newCampaign({ globalLimit: 2 });
    const first = await paidOrder(campaign, 2, '2026-04-10T10:00:00.000Z', '2026-04-10T10:05:00.000Z');
    const second = await paidOrder(campaign, 1, '2026-04-10T11:00:00.000Z', '2026-04-10T11:05:00.000Z');
    expect(await vouchersOf(first)).toHaveLength(4);
    expect(await vouchersOf(second)).toHaveLength(0);
    const [hold] = await holdsOf(second);
    expect(hold).toMatchObject({ status: 'OPEN', reason: 'CAPACITY_EXCEEDED', units: 1 });
    expect((await registryOf(second)).status).toBe('CONFIRMED');
    expect(await prisma.valePassRefundApplication.count({ where: { shopifyOrderId: second } })).toBe(0);
    expect((await vouchersOf(first)).every((v) => v.status === 'ACTIVE')).toBe(true);
  });
});
