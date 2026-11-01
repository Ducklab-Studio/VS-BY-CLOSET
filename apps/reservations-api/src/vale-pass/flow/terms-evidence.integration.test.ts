import { afterAll, afterEach, beforeAll, describe, expect, test } from 'vitest';
import type { ValePassCampaign } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { lockShopifyOrder } from '../../webhooks/shopify-order-lock';
import { loadEmailConfig } from '../email/email-config';
import { ValePassEmailOutboxService } from '../email/email-outbox.service';
import { ValePassFinancialGuard } from '../financial/financial-guard.service';
import { ValePassIssuanceService } from '../vale-pass-issuance.service';
import { ValePassRefundService } from '../refunds/refund.service';
import { ValePassRegularizationService } from '../refunds/regularization.service';
import { ValePassWebhookService } from '../vale-pass-webhook.service';
import type { FlowFlags } from './flow-flags';
import { ValePassPaymentFlowService } from './payment-flow.service';

/**
 * Evidência do aceite dos termos do Valle Pass, em PostgreSQL LOCAL descartável: pagamento → registro do pedido → evento de evidência → emissão ou retenção. Nenhuma Shopify, nenhum e-mail enviado, nada cancelado nem reembolsado.
 */
const localDatabase = /^postgres(?:ql)?:\/\/[^@]+@(localhost|127\.0\.0\.1)(:\d+)?\/[^/]*(test|audit|operational)/i.test(process.env.DATABASE_URL ?? '');
const localDescribe = localDatabase ? describe : describe.skip;

const prisma = new PrismaService();
const issuance = new ValePassIssuanceService();
const outbox = new ValePassEmailOutboxService(prisma, loadEmailConfig({}));
const refunds = new ValePassRefundService(prisma);
const TAG = `VPTE-${Date.now()}`;
let counter = 0;
const campaignIds: string[] = [];
const orderIds: string[] = [];

/** Chaves controladas pelo teste (o padrão de produção é tudo DESLIGADO). */
const flags = { twoVoucher: false };
const flagFns: FlowFlags = {
  twoVoucher: () => flags.twoVoucher,
  unitRefunds: () => false,
  paymentTime: () => ({ mode: 'webhook-agreement', toleranceSeconds: 120 }),
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


const eventsOf = async (orderId: string) => {
  const registry = await prisma.valePassOrder.findUniqueOrThrow({ where: { shopifyOrderId: orderId }, select: { id: true } });
  return prisma.valePassOrderEvent.findMany({ where: { valePassOrderId: registry.id, type: 'TERMS_EVIDENCE_RECORDED' }, orderBy: { createdAt: 'asc' } });
};
const PAID_AT = () => new Date(Date.now() - 5_000).toISOString();
const withAttrs = (payload: Record<string, unknown>, attrs: { name: string; value: string }[]): Record<string, unknown> => ({ ...payload, note_attributes: attrs });

localDescribe('evidência do aceite dos termos (registro, sem bloquear nem inventar consentimento)', () => {
  test('sem atributos: registra ABSENT (nunca presume aceite) e a emissão segue normalmente', async () => {
    flags.twoVoucher = true;
    const campaign = await newCampaign();
    const payload = paidPayload(campaign, 1);
    await runAt(service(), payload, PAID_AT());
    const orderId = String(payload.id);
    const events = await eventsOf(orderId);
    expect(events).toHaveLength(1);
    expect(events[0].detail).toMatchObject({ status: 'ABSENT', source: 'order_note_attributes' });
    expect(await vouchersOf(orderId)).toHaveLength(2);
  });

  test('versão e instante declarados: registra DECLARED (não "aceito") com a versão e o instante, sem dado pessoal', async () => {
    flags.twoVoucher = true;
    const campaign = await newCampaign();
    const acceptedAt = new Date(Date.now() - 30_000).toISOString();
    const payload = withAttrs(paidPayload(campaign, 1), [
      { name: 'valle_pass_terms_version', value: '2027-1' },
      { name: 'valle_pass_terms_accepted_at', value: acceptedAt },
    ]);
    await runAt(service(), payload, PAID_AT());
    const orderId = String(payload.id);
    const [event] = await eventsOf(orderId);
    expect(event.detail).toMatchObject({ status: 'DECLARED', version: '2027-1', acceptedAt });
    expect(JSON.stringify(event.detail)).not.toMatch(/@|Cliente|Sintético/);
    expect(await vouchersOf(orderId)).toHaveLength(2);
  });

  test.each([
    ['só a versão', [{ name: 'valle_pass_terms_version', value: '2027-1' }], 'incomplete'],
    ['só o instante', [{ name: 'valle_pass_terms_accepted_at', value: '2026-01-01T00:00:00Z' }], 'incomplete'],
    ['versão com caracteres inválidos', [{ name: 'valle_pass_terms_version', value: '2027 1; DROP' }, { name: 'valle_pass_terms_accepted_at', value: '2026-01-01T00:00:00Z' }], 'version_invalid'],
    ['instante ilegível', [{ name: 'valle_pass_terms_version', value: '2027-1' }, { name: 'valle_pass_terms_accepted_at', value: 'ontem' }], 'accepted_at_invalid'],
    ['instante no futuro', [{ name: 'valle_pass_terms_version', value: '2027-1' }, { name: 'valle_pass_terms_accepted_at', value: '2099-01-01T00:00:00Z' }], 'accepted_at_in_future'],
  ])('evidência incoerente (%s): MALFORMED com o motivo; nunca vira aceite', async (_label, attrs, reason) => {
    flags.twoVoucher = true;
    const campaign = await newCampaign();
    const payload = withAttrs(paidPayload(campaign, 1), attrs);
    await runAt(service(), payload, PAID_AT());
    const [event] = await eventsOf(String(payload.id));
    expect(event.detail).toMatchObject({ status: 'MALFORMED', reason });
  });

  test('reentrega repetida e simultânea não duplica o registro; quando a evidência MUDA de estado, o novo estado é acrescentado (histórico preservado)', async () => {
    flags.twoVoucher = true;
    const campaign = await newCampaign();
    const bare = paidPayload(campaign, 1);
    const at = PAID_AT();
    await Promise.all(Array.from({ length: 4 }, () => runAt(service(), bare, at)));
    await runAt(service(), bare, at);
    const orderId = String(bare.id);
    expect(await eventsOf(orderId)).toHaveLength(1);
    const acceptedAt = new Date(Date.now() - 30_000).toISOString();
    const later = withAttrs(bare, [{ name: 'valle_pass_terms_version', value: '2027-1' }, { name: 'valle_pass_terms_accepted_at', value: acceptedAt }]);
    await runAt(service(), later, at);
    await runAt(service(), later, at);
    const events = await eventsOf(orderId);
    expect(events.map((e) => (e.detail as { status: string }).status)).toEqual(['ABSENT', 'DECLARED']);
  });

  test('pedido retido (campanha com encerramento/valor divergente) também ganha o registro, e o registro não altera a decisão financeira', async () => {
    flags.twoVoucher = false; // integração desligada → retenção INTEGRATION_DISABLED
    const campaign = await newCampaign();
    const payload = paidPayload(campaign, 1);
    await runAt(service(), payload, PAID_AT());
    const orderId = String(payload.id);
    expect(await eventsOf(orderId)).toHaveLength(1);
    expect(await vouchersOf(orderId)).toHaveLength(0);
    expect(await holdsOf(orderId)).toHaveLength(1);
  });
});
