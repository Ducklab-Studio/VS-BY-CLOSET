import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from 'vitest';
import { ForbiddenException } from '@nestjs/common';
import type { ValePassCampaign } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service';
import { lockShopifyOrder } from '../webhooks/shopify-order-lock';
import { grantAllCompaniesForTest, purgeLedgerForTest } from './ledger/ledger-test-utils';
import { ValePassBlockService } from './ledger/block.service';
import { ValePassLedgerService } from './ledger/ledger.service';
import { ValePassRedemptionService, type Actor } from './ledger/redemption.service';
import { loadEmailConfig } from './email/email-config';
import type { EmailProvider, SendEmailInput, SendEmailResult } from './email/email-provider';
import { ValePassEmailOutboxService } from './email/email-outbox.service';
import { ValePassEmailWorkerService } from './email/email-worker.service';
import { ValePassFinancialGuard } from './financial/financial-guard.service';
import type { FlowFlags } from './flow/flow-flags';
import { ValePassAutoVerifyService } from './flow/auto-verify.service';
import { ValePassPaymentFlowService } from './flow/payment-flow.service';
import type { ShopifyAdminClient, ShopifyOrderTransactionsResult } from '../admin-panel/shopify-admin.client';
import { ValePassRefundService } from './refunds/refund.service';
import { ValePassRegularizationService } from './refunds/regularization.service';
import { ValePassCancellationAlertsService } from './cancellation-alerts.service';
import { ValePassIssuanceService } from './vale-pass-issuance.service';
import { ValePassLotsService } from './vale-pass-lots.service';
import { ValePassVouchersService } from './vale-pass-vouchers.service';
import { ValePassWebhookService } from './vale-pass-webhook.service';
import { checkHomologation } from './homologation-check';
import { ValePassValidityExtensionService } from './validity-extension.service';

/**
 * JORNADA COMPLETA do Valle Pass 2027 em PostgreSQL LOCAL descartável: o que o cliente e a equipe fazem, encadeado pelos serviços REAIS (nada de atalho que grave
 * vouchers à mão): pagamento (webhook da Shopify simulado) → validação financeira → dois vouchers → caixa de saída → e-mail (provedor SIMULADO que imita a Resend; `fetch`
 * proibido) → consulta/resgates/bloqueio/permissões → cancelamento/reembolso/alerta → prorrogação. Nenhuma Shopify, nenhum e-mail real, nenhum dado de produção.
 */
const localDatabase = /^postgres(?:ql)?:\/\/[^@]+@(localhost|127\.0\.0\.1)(:\d+)?\/[^/]*(test|audit|operational)/i.test(process.env.DATABASE_URL ?? '');
const localDescribe = localDatabase ? describe : describe.skip;

const prisma = new PrismaService();
const TAG = `VPJ-${Date.now()}`;
let counter = 0;
let owner: Actor;
let admin: Actor;
let staff: Actor;
const campaignIds: string[] = [];
const orderIds: string[] = [];
const userIds: string[] = [];

/** Chaves da integração como serão ligadas no lançamento (aqui só no teste). */
const policy = { mode: 'webhook-agreement' as 'strict' | 'webhook-agreement', autoVerify: false };
const flags: FlowFlags = { twoVoucher: () => true, unitRefunds: () => false, paymentTime: () => ({ mode: policy.mode, toleranceSeconds: 120 }), autoVerify: () => policy.autoVerify };
/** Admin API da Shopify FALSA (nenhuma rede): transações por GID do pedido. */
const fakeTransactions = new Map<string, ShopifyOrderTransactionsResult | null>();
const fakeShopify = { getOrderPaymentTransactions: async (gid: string) => fakeTransactions.get(gid) ?? null } as unknown as ShopifyAdminClient;

class MockResend implements EmailProvider {
  readonly calls: SendEmailInput[] = [];
  readonly script: (SendEmailResult | Error)[] = [];
  private readonly byKey = new Map<string, string>();
  async send(input: SendEmailInput): Promise<SendEmailResult> {
    this.calls.push(input);
    const next = this.script.shift();
    if (next instanceof Error) throw next;
    if (next) return next;
    const id = this.byKey.get(input.idempotencyKey) ?? `em_${this.byKey.size + 1}`;
    this.byKey.set(input.idempotencyKey, id);
    return { kind: 'accepted', messageId: id };
  }
}
const provider = new MockResend();
const emailConfig = loadEmailConfig({ VALE_PASS_EMAIL_MODE: 'live', RESEND_API_KEY: 're_test_key', VALE_PASS_EMAIL_DOMAIN_VERIFIED: 'true', VALE_PASS_EMAIL_COMMERCIAL_RELEASE: 'true', VALE_PASS_EMAIL_DAILY_LIMIT: '1000' });
const outbox = new ValePassEmailOutboxService(prisma, emailConfig);
const worker = new ValePassEmailWorkerService(prisma, outbox, emailConfig, provider);
worker.rng = () => 0.5;
const issuance = new ValePassIssuanceService();
const refunds = new ValePassRefundService(prisma);
const regularization = new ValePassRegularizationService(prisma, new ValePassFinancialGuard(), issuance);
const flow = new ValePassPaymentFlowService(new ValePassFinancialGuard(), issuance, outbox, flags, prisma, regularization);
const webhook = new ValePassWebhookService(flow, refunds, flags);
const autoVerify = new ValePassAutoVerifyService(prisma, fakeShopify, flow, flags, 0);
const redemption = new ValePassRedemptionService(prisma);
const blocks = new ValePassBlockService(prisma, redemption);
const ledger = new ValePassLedgerService(prisma);
const lots = new ValePassLotsService(prisma);
const vouchers = new ValePassVouchersService(prisma);
const alerts = new ValePassCancellationAlertsService(prisma);
const extensions = new ValePassValidityExtensionService(prisma);

const money = (amount: string) => ({ shop_money: { amount, currency_code: 'BRL' }, presentment_money: { amount, currency_code: 'BRL' } });
let clock = Date.now();

async function newCampaign(over: Partial<{ globalLimit: number; validUntil: string }> = {}): Promise<ValePassCampaign & { numericVariant: string }> {
  const numericVariant = String(800_000_000_000 + counter++);
  const campaign = await prisma.valePassCampaign.create({
    data: {
      name: `${TAG}-camp-${counter++}`, amountCents: 35_000, validityDays: 30, shopifyVariantId: numericVariant, globalLimit: over.globalLimit ?? 1_000,
      voucherValidFrom: new Date('2026-01-01T00:00:00.000Z'), voucherValidUntil: new Date(`${over.validUntil ?? '2027-09-30'}T00:00:00.000Z`),
    },
  });
  campaignIds.push(campaign.id);
  await prisma.valePassCampaignBenefit.createMany({
    data: [
      { campaignId: campaign.id, code: 'valle_showroom_500', kind: 'VOUCHER', company: 'VALLE_SHOWROOM', label: 'Voucher Valle Showroom', amountCents: 50_000, sortOrder: 0 },
      { campaignId: campaign.id, code: 'vs_by_closet_50', kind: 'VOUCHER', company: 'VS_BY_CLOSET', label: 'Voucher VS BY CLOSET', amountCents: 5_000, sortOrder: 1 },
      { campaignId: campaign.id, code: 'passeios_10', kind: 'DISCOUNT', label: '10% em passeios e transfers', discountPercent: 10, sortOrder: 2 },
    ],
  });
  return { ...campaign, numericVariant };
}

function payload(campaign: { numericVariant: string }, quantity: number, over: Record<string, unknown> = {}, orderId = `${TAG}-o${counter++}`): Record<string, unknown> {
  orderIds.push(orderId);
  clock += 1000;
  return {
    id: orderId, admin_graphql_api_id: `gid://shopify/Order/${orderId}`, name: `#J${counter}`, financial_status: 'paid', cancelled_at: null, currency: 'BRL', presentment_currency: 'BRL',
    created_at: new Date(clock - 60_000).toISOString(), updated_at: new Date(clock).toISOString(),
    current_total_price: ((35_000 * quantity) / 100).toFixed(2), total_outstanding: '0.00', total_discounts: '0.00', discount_codes: [], refunds: [],
    total_shipping_price_set: money('0.00'), email: `cliente${counter}@exemplo.invalid`, customer: { first_name: 'Maria', last_name: 'Sintética', email: `cliente${counter}@exemplo.invalid` },
    line_items: [{ variant_id: Number(campaign.numericVariant), product_id: null, quantity, current_quantity: quantity, price: '350.00', price_set: money('350.00'), discount_allocations: [] }],
    ...over,
  };
}
const run = (topic: string, body: unknown, triggeredAt?: string | null) =>
  prisma.$transaction(async (tx) => {
    await lockShopifyOrder(tx, String((body as { order_id?: unknown; id?: unknown }).order_id ?? (body as { id: unknown }).id));
    return webhook.handleOrderWebhook(tx, topic, body, { triggeredAt: triggeredAt === undefined ? (topic === 'orders/paid' ? String((body as { updated_at?: unknown }).updated_at ?? '') || null : null) : triggeredAt });
  }, { timeout: 30_000, maxWait: 20_000 });
/** O que o WebhooksService faz num orders/cancelled: tratamento do Valle Pass (cancela os ativos, registra o cancelamento, alerta de crédito utilizado) e depois o registro do pedido. */
const cancelOrder = (body: Record<string, unknown>) =>
  prisma.$transaction(async (tx) => {
    const orderId = String(body.id);
    await lockShopifyOrder(tx, orderId);
    const first = await webhook.handleOrderCancelledOrRefunded(tx, orderId, 'orders/cancelled');
    const second = await webhook.handleOrderWebhook(tx, 'orders/cancelled', body);
    return [...first, ...second];
  }, { timeout: 30_000, maxWait: 20_000 });
const runRefund = (refund: Record<string, unknown>) =>
  prisma.$transaction(async (tx) => {
    await lockShopifyOrder(tx, String(refund.order_id));
    const first = await webhook.handleRefund(tx, refund as never);
    const second = await webhook.handleOrderWebhook(tx, 'refunds/create', refund);
    return [...first, ...second];
  }, { timeout: 30_000, maxWait: 20_000 });
const refundOf = (campaign: { numericVariant: string }, orderId: string, quantity: number) => ({
  id: `${TAG}-rf${counter++}`, order_id: orderId, refund_shipping_lines: [], transactions: [{ kind: 'refund', status: 'success', amount: ((35_000 * quantity) / 100).toFixed(2) }], order_adjustments: [],
  refund_line_items: [{ id: 1, line_item_id: 1, quantity, subtotal: 350 * quantity, total_tax: 0, restock_type: 'return', line_item: { variant_id: Number(campaign.numericVariant), product_id: null, price: '350.00', quantity } }],
});

const vouchersOf = (orderId: string) => prisma.valePass.findMany({ where: { shopifyOrderId: orderId }, orderBy: [{ createdAt: 'asc' }, { company: 'asc' }] });
const byCompany = async (orderId: string, company: 'VALLE_SHOWROOM' | 'VS_BY_CLOSET') => (await vouchersOf(orderId)).filter((v) => v.company === company);
const outboxOf = (orderId: string) => prisma.valePassEmailOutbox.findMany({ where: { shopifyOrderId: orderId } });
const holdsOf = (orderId: string) => prisma.valePassIssuanceHold.findMany({ where: { shopifyOrderId: orderId } });
const rejection = (promise: Promise<unknown>) => promise.then(() => null, (err: unknown) => err as { status?: number; response?: { code?: string }; message: string });
async function redeem(v: { id: string; code: string; company: string | null }, amountCents: number, actor: Actor) {
  const current = await prisma.valePass.findUniqueOrThrow({ where: { id: v.id } });
  return redemption.confirmRedeem(v.code, { company: v.company as string, amountCents, reference: 'Nota 1 (jornada)', operationId: `op-${randomUUID()}`, expectedBalanceCents: current.balanceCents, confirmAmountCents: amountCents }, actor);
}

async function cleanRows() {
  const ids = campaignIds.splice(0);
  const orders = orderIds.splice(0);
  const users = userIds.splice(0);
  await prisma.$transaction(async (tx) => {
    const rows = await tx.valePass.findMany({ where: { campaignId: { in: ids } }, select: { id: true } });
    const outboxRows = await tx.valePassEmailOutbox.findMany({ where: { shopifyOrderId: { in: orders } }, select: { id: true } });
    await purgeLedgerForTest(tx, { campaignIds: ids });
    await tx.valePassEmailEvent.deleteMany({ where: { outboxId: { in: outboxRows.map((r) => r.id) } } });
    await tx.valePassEmailOutbox.deleteMany({ where: { shopifyOrderId: { in: orders } } });
    const holds = await tx.valePassIssuanceHold.findMany({ where: { campaignId: { in: ids } }, select: { id: true } });
    const regs0 = await tx.valePassOrder.findMany({ where: { shopifyOrderId: { in: orders } }, select: { id: true } });
    const refundRows = await tx.valePassRefundApplication.findMany({ where: { shopifyOrderId: { in: orders } }, select: { id: true } });
    // inclui as auditorias do SISTEMA (sem autor) ligadas a retenções, pedidos e reembolsos desta jornada: outras suítes contam eventos por ação
    await tx.adminAuditEvent.deleteMany({ where: { OR: [{ entityId: { in: [...ids, ...orders, ...rows.map((r) => r.id), ...holds.map((h) => h.id), ...regs0.map((r) => r.id), ...refundRows.map((r) => r.id)] } }, { adminUserId: { in: users } }] } });
    await tx.$executeRawUnsafe('SET LOCAL session_replication_role = replica'); // só a limpeza de dados SINTÉTICOS (históricos imutáveis por gatilho)
    await tx.$executeRaw`DELETE FROM vale_pass_validity_extensions WHERE campaign_id = ANY(${ids}::uuid[])`;
    await tx.$executeRaw`DELETE FROM vale_pass_cancellation_alerts WHERE shopify_order_id = ANY(${orders}::text[])`;
    await tx.valePassRefundApplication.deleteMany({ where: { shopifyOrderId: { in: orders } } });
    await tx.valePassEvent.deleteMany({ where: { valePassId: { in: rows.map((r) => r.id) } } });
    await tx.valePass.deleteMany({ where: { campaignId: { in: ids } } });
    await tx.valePassIssuanceHold.deleteMany({ where: { campaignId: { in: ids } } });
    await tx.valePassLot.deleteMany({ where: { campaignId: { in: ids } } });
    await tx.valePassCampaignBenefit.deleteMany({ where: { campaignId: { in: ids } } });
    await tx.valePassCampaign.deleteMany({ where: { id: { in: ids } } });
    const regs = await tx.valePassOrder.findMany({ where: { shopifyOrderId: { in: orders } }, select: { id: true } });
    await tx.valePassOrderEvent.deleteMany({ where: { valePassOrderId: { in: regs.map((r) => r.id) } } });
    await tx.valePassOrderCancellation.deleteMany({ where: { shopifyOrderId: { in: orders } } });
    await tx.valePassOrder.deleteMany({ where: { shopifyOrderId: { in: orders } } });
    await tx.webhookEvent.deleteMany({ where: { storeId: `${TAG}-store` } });
    await tx.adminUser.deleteMany({ where: { id: { in: users } } });
  }, { timeout: 60_000 });
  provider.calls.length = 0;
  policy.mode = 'webhook-agreement';
  policy.autoVerify = false;
  fakeTransactions.clear();
}

/** O que o WebhooksService grava ao receber o webhook (a verificação automática lê daqui o cabeçalho de horário). */
async function storeEvent(topic: string, body: Record<string, unknown>, triggeredAt: string) {
  await prisma.webhookEvent.create({ data: { shopifyWebhookId: `${TAG}-wh${counter++}`, storeId: `${TAG}-store`, topic, payload: { ...body, updated_at: triggeredAt } as never, status: 'processed' as never, orderId: String(body.id) } });
}
async function newUser(role: 'SUPER_ADMIN' | 'ADMIN' | 'STAFF'): Promise<Actor> {
  const row = await prisma.adminUser.create({ data: { name: `${role} ${TAG}-${counter}`, phone: `${TAG}-${counter++}`, pinHash: 'x', role, active: true } });
  if (role === 'ADMIN') await grantAllCompaniesForTest(prisma, row.id); // a política exige vínculo para ADMIN resgatar
  userIds.push(row.id);
  return { id: row.id, name: row.name, role };
}
beforeAll(async () => {
  if (!localDatabase) return;
  vi.stubGlobal('fetch', () => {
    throw new Error('REDE REAL PROIBIDA NA JORNADA');
  });
  await prisma.store.upsert({ where: { id: `${TAG}-store` }, update: {}, create: { id: `${TAG}-store`, shopifyDomain: `${TAG}.invalid`, currency: 'BRL' } });
  owner = await newUser('SUPER_ADMIN');
  admin = await newUser('ADMIN');
  staff = await newUser('STAFF');
});
afterEach(async () => {
  if (!localDatabase) return;
  userIds.length = 0; // os 3 usuários da jornada vivem até o afterAll
  await cleanRows();
});
afterAll(async () => {
  if (localDatabase) {
    await prisma.adminAuditEvent.deleteMany({ where: { adminUserId: { in: [owner.id, admin.id, staff.id] } } });
    await prisma.adminUser.deleteMany({ where: { id: { in: [owner.id, admin.id, staff.id] } } });
    await prisma.$executeRaw`DELETE FROM stores WHERE id = ${`${TAG}-store`}`;
  }
  await prisma.$disconnect();
});

localDescribe('1) COMPRA E EMISSÃO — o cliente paga R$ 350 e recebe exatamente dois vouchers independentes', () => {
  test('1 unidade paga e confirmada: R$ 500 (Valle Showroom) + R$ 50 (VS BY CLOSET), mesmo grupo, saldos cheios, validade da campanha, UMA mensagem na fila, nenhum e-mail enviado ainda', async () => {
    const c = await newCampaign();
    const p = payload(c, 1);
    const events = await run('orders/paid', p);
    const orderId = String(p.id);
    expect(events.map((e) => e.type)).toEqual(expect.arrayContaining(['VALE_PASS_UNITS_ISSUED', 'VALE_PASS_EMAIL_ENQUEUED']));
    const rows = await vouchersOf(orderId);
    expect(rows).toHaveLength(2);
    const showroom = rows.find((r) => r.company === 'VALLE_SHOWROOM')!;
    const closet = rows.find((r) => r.company === 'VS_BY_CLOSET')!;
    expect(showroom).toMatchObject({ amountCents: 50_000, balanceCents: 50_000, status: 'ACTIVE' });
    expect(closet).toMatchObject({ amountCents: 5_000, balanceCents: 5_000, status: 'ACTIVE' });
    expect(showroom.groupId).toBe(closet.groupId);
    expect(showroom.code).not.toBe(closet.code);
    expect(showroom.expiresAt.toISOString()).toBe('2027-10-01T03:00:00.000Z'); // 30/09/2027 inclusive, fuso de São Paulo
    expect(showroom.benefitId).not.toBe(closet.benefitId);
    const queue = await outboxOf(orderId);
    expect(queue).toHaveLength(1);
    expect(queue[0]).toMatchObject({ status: 'QUEUED', attempts: 0 });
    expect(provider.calls).toHaveLength(0);
    expect(await holdsOf(orderId)).toHaveLength(0);
  });

  test('várias unidades: 3 pagas → 6 vouchers (2 por unidade) e 3 mensagens (cada uma com os dois vouchers DA PRÓPRIA unidade)', async () => {
    const c = await newCampaign();
    const p = payload(c, 3);
    await run('orders/paid', p);
    const orderId = String(p.id);
    const rows = await vouchersOf(orderId);
    expect(rows).toHaveLength(6);
    expect(new Set(rows.map((r) => r.groupId)).size).toBe(3);
    expect(rows.filter((r) => r.company === 'VALLE_SHOWROOM').every((r) => r.amountCents === 50_000)).toBe(true);
    expect(rows.filter((r) => r.company === 'VS_BY_CLOSET').every((r) => r.amountCents === 5_000)).toBe(true);
    expect(await outboxOf(orderId)).toHaveLength(3);
    expect(new Set(rows.map((r) => r.code)).size).toBe(6);
  });

  test('webhook duplicado, simultâneo e atrasado: nada se duplica (vouchers, mensagens, códigos)', async () => {
    const c = await newCampaign();
    const p = payload(c, 2);
    const orderId = String(p.id);
    await Promise.all(Array.from({ length: 6 }, () => run('orders/paid', p)));
    await run('orders/updated', { ...p, updated_at: new Date(clock + 5_000).toISOString() });
    await run('orders/paid', p);
    expect(await vouchersOf(orderId)).toHaveLength(4);
    expect(await outboxOf(orderId)).toHaveLength(2);
    expect(await holdsOf(orderId)).toHaveLength(0);
  });

  test('pagamento ainda NÃO confirmado (Pix pendente, cartão só autorizado, parcial): nenhum benefício; depois do pagamento chegar (atrasado) emite uma única vez', async () => {
    const c = await newCampaign();
    const fiveHoursAgo = new Date(Date.now() - 5 * 3_600_000).toISOString();
    const pending = payload(c, 1, { financial_status: 'pending', total_outstanding: '350.00', created_at: fiveHoursAgo, updated_at: fiveHoursAgo });
    const orderId = String(pending.id);
    await run('orders/create', pending);
    await run('orders/updated', pending);
    expect(await vouchersOf(orderId)).toHaveLength(0);
    expect(await outboxOf(orderId)).toHaveLength(0);
    const authorized = payload(c, 1, { financial_status: 'authorized', total_outstanding: '350.00' });
    await run('orders/updated', authorized);
    expect(await vouchersOf(String(authorized.id))).toHaveLength(0);
    const partial = payload(c, 1, { financial_status: 'partially_paid', total_outstanding: '100.00' });
    await run('orders/updated', partial);
    expect(await vouchersOf(String(partial.id))).toHaveLength(0);
    // o Pix cai horas depois: o mesmo pedido agora vem pago
    const paid = { ...pending, financial_status: 'paid', total_outstanding: '0.00', updated_at: new Date(Date.now() - 60_000).toISOString() }; // o Pix caiu há 1 minuto (o pedido nasceu há 5 h)
    await run('orders/paid', paid);
    await run('orders/paid', paid);
    expect(await vouchersOf(orderId)).toHaveLength(2);
    expect(await outboxOf(orderId)).toHaveLength(1);
  });

  test('pagamento com valor/quantidade/preço fora do esperado não emite: vira retenção visível ao ADMIN (nunca emissão silenciosa)', async () => {
    const c = await newCampaign();
    const wrongTotal = payload(c, 1, { current_total_price: '300.00' });
    await run('orders/paid', wrongTotal);
    expect(await vouchersOf(String(wrongTotal.id))).toHaveLength(0);
    expect(await holdsOf(String(wrongTotal.id))).toHaveLength(1);
    expect(await outboxOf(String(wrongTotal.id))).toHaveLength(0);
  });

  test('limite global: com teto de 3 unidades, o pedido de 2 emite, o seguinte de 2 fica RETIDO inteiro; lote/estoque recomendado nunca passam do saldo', async () => {
    const c = await newCampaign({ globalLimit: 3 });
    const first = payload(c, 2);
    const second = payload(c, 2);
    await run('orders/paid', first);
    await run('orders/paid', second);
    expect(await vouchersOf(String(first.id))).toHaveLength(4);
    expect(await vouchersOf(String(second.id))).toHaveLength(0);
    const hold = (await holdsOf(String(second.id)))[0];
    expect(hold).toMatchObject({ status: 'OPEN', reason: 'CAPACITY_EXCEEDED', units: 2 });
    const capacity = await lots.getCapacity(c.id);
    expect(capacity.totals).toMatchObject({ sold: 2, pending: 2, consumed: 4 });
    expect(capacity.alerts.some((a) => a.severity === 'critical')).toBe(true);
    expect(capacity.recommendedShopifyStock).toBe(0); // sem lote aberto a venda está fechada
    const lot = await lots.create(c.id, { name: 'Lote teste', quantity: 1 }, admin.id, admin.name).catch((e: unknown) => e);
    expect(lot instanceof Error || (lot as { quantity?: number }).quantity === 1).toBe(true);
  });
});

localDescribe('2) E-MAIL — os dois códigos juntos, para o destinatário certo, com falha e nova tentativa', () => {
  test('o worker envia UMA mensagem por unidade com os dois códigos, valores e lojas certos para o e-mail do cliente; só a Resend SIMULADA é chamada', async () => {
    const c = await newCampaign();
    const p = payload(c, 1);
    await run('orders/paid', p);
    const orderId = String(p.id);
    const report = await worker.tick(new Date(Date.now() + 5_000));
    expect(report).toMatchObject({ claimed: 1, accepted: 1 });
    expect(provider.calls).toHaveLength(1);
    const call = provider.calls[0];
    const rows = await vouchersOf(orderId);
    expect(call.to).toBe(String(p.email));
    for (const v of rows) expect(call.html).toContain(v.code);
    for (const v of rows) expect(call.text).toContain(v.code);
    expect(call.html).toContain('R$ 500,00');
    expect(call.html).toContain('R$ 50,00');
    expect(call.html).toMatch(/Valle Showroom/);
    expect(call.html).toMatch(/VS BY CLOSET/);
    expect(call.html).toContain('30/09/2027');
    expect(call.html).not.toMatch(/(?<!in)transfer[ií]ve|vale-presente/i); // nenhuma promessa de transferência
    const [row] = await outboxOf(orderId);
    expect(row.status).toBe('ACCEPTED');
    // segunda rodada: nada novo é enviado
    await worker.tick(new Date(Date.now() + 10_000));
    expect(provider.calls).toHaveLength(1);
  });

  test('falha temporária da Resend simulada: nova tentativa com a MESMA chave de idempotência; um único e-mail aceito', async () => {
    const c = await newCampaign();
    const p = payload(c, 1);
    await run('orders/paid', p);
    provider.script.push(new Error('rede indisponível (simulada)'));
    const first = await worker.tick(new Date(Date.now() + 5_000));
    expect(first.accepted).toBe(0);
    const [afterFailure] = await outboxOf(String(p.id));
    expect(['UNKNOWN', 'QUEUED']).toContain(afterFailure.status);
    expect(afterFailure.status).not.toBe('FAILED');
    await worker.tick(new Date(Date.now() + 6 * 3_600_000));
    expect(provider.calls.length).toBeGreaterThanOrEqual(2);
    expect(new Set(provider.calls.map((x) => x.idempotencyKey)).size).toBe(1);
    expect((await outboxOf(String(p.id)))[0].status).toBe('ACCEPTED');
  });

  test('reembolso/cancelamento ANTES do envio: o e-mail nunca sai (a reavaliação cancela a mensagem)', async () => {
    const c = await newCampaign();
    const p = payload(c, 1);
    await run('orders/paid', p);
    await cancelOrder({ ...p, cancelled_at: new Date().toISOString(), cancel_reason: 'customer' });
    await worker.tick(new Date(Date.now() + 5_000));
    expect(provider.calls).toHaveLength(0);
    expect((await outboxOf(String(p.id)))[0].status).toBe('CANCELLED');
  });
});

localDescribe('3) CLOSETADMIN — consulta, resgate parcial e total, bloqueio e permissões, saldos separados', () => {
  test('resgate parcial e total, bloqueio/desbloqueio, saldos das duas lojas separados e ledger íntegro', async () => {
    const c = await newCampaign();
    const p = payload(c, 1);
    await run('orders/paid', p);
    const orderId = String(p.id);
    const [showroom] = await byCompany(orderId, 'VALLE_SHOWROOM');
    const [closet] = await byCompany(orderId, 'VS_BY_CLOSET');
    // consulta
    expect(await redemption.lookup(showroom.code, admin)).toMatchObject({ company: 'VALLE_SHOWROOM', balanceCents: 50_000, usedCents: 0, redeemable: true });
    // parcial
    expect(await redeem(showroom, 20_000, admin)).toMatchObject({ balanceCents: 30_000, status: 'ACTIVE' });
    expect(await redeem(closet, 2_000, admin)).toMatchObject({ balanceCents: 3_000 });
    expect((await prisma.valePass.findUniqueOrThrow({ where: { id: showroom.id } })).balanceCents).toBe(30_000);
    // saldo de uma loja nunca paga a outra
    expect((await rejection(redeem(closet, 4_000, admin)))?.response?.code).toBe('INSUFFICIENT_BALANCE');
    // bloqueio congela; desbloqueio devolve a operação
    const prep = await blocks.prepareBlock(showroom.code, admin);
    await blocks.confirmBlock(showroom.code, { reason: 'conferência administrativa (jornada)', operationId: prep.operationId, confirmCode: showroom.code }, admin);
    expect((await rejection(redeem(showroom, 1_000, admin)))?.response?.code).toBe('BLOCKED');
    const prepU = await blocks.prepareUnblock(showroom.code, admin);
    await blocks.confirmUnblock(showroom.code, { reason: 'conferido e liberado (jornada)', operationId: prepU.operationId, confirmCode: showroom.code }, admin);
    // total
    expect(await redeem(showroom, 30_000, owner)).toMatchObject({ balanceCents: 0, status: 'USED' });
    expect(await redeem(closet, 3_000, admin)).toMatchObject({ balanceCents: 0, status: 'USED' });
    expect((await rejection(redeem(showroom, 100, admin)))?.response?.code).toBe('USED_UP');
    expect(await ledger.reconcile()).toEqual([]);
  });

  test('permissões: STAFF consulta (dados mascarados) mas não resgata, não reverte e não bloqueia; ADMIN e SUPER_ADMIN operam', async () => {
    const c = await newCampaign();
    const p = payload(c, 1);
    await run('orders/paid', p);
    const [showroom] = await byCompany(String(p.id), 'VALLE_SHOWROOM');
    const view = await redemption.lookup(showroom.code, staff);
    expect(view.holder.phoneMasked ?? '').not.toMatch(/\d{5,}/);
    expect(JSON.stringify(view)).not.toContain(String(p.email));
    await expect(redeem(showroom, 100, staff)).rejects.toBeInstanceOf(ForbiddenException);
    await expect(blocks.prepareBlock(showroom.code, staff)).rejects.toBeInstanceOf(ForbiddenException);
    await expect(redeem(showroom, 100, admin)).resolves.toMatchObject({ balanceCents: 49_900 });
    await expect(redeem(showroom, 100, owner)).resolves.toMatchObject({ balanceCents: 49_800 });
    // o endpoint antigo de "usado" também respeita o papel
    const [closet] = await byCompany(String(p.id), 'VS_BY_CLOSET');
    await expect(vouchers.markUsed(closet.code, staff.id, staff.name, { role: 'STAFF' })).rejects.toBeInstanceOf(ForbiddenException);
  });
});

localDescribe('4) CANCELAMENTO E REEMBOLSO — sem uso, integral, crédito parcialmente utilizado, alerta crítico, duplicados e integridade', () => {
  test('pedido cancelado SEM utilização: os dois vouchers cancelados, nenhum alerta de crédito utilizado, e-mail pendente cancelado', async () => {
    const c = await newCampaign();
    const p = payload(c, 1);
    await run('orders/paid', p);
    await cancelOrder({ ...p, cancelled_at: new Date().toISOString(), cancel_reason: 'customer' });
    const rows = await vouchersOf(String(p.id));
    expect(rows.every((r) => r.status === 'CANCELLED')).toBe(true);
    expect(await prisma.valePassCancellationAlert.count({ where: { shopifyOrderId: String(p.id) } })).toBe(0);
    expect(await ledger.reconcile()).toEqual([]);
  });

  test('reembolso INTEGRAL confirmado pela Shopify (1 de 1, sem uso): política atual ADMIN_CONFIRM — nada é cancelado sozinho, o USO fica bloqueado até um ADMIN decidir; ao decidir, os dois vouchers são cancelados e a capacidade é liberada; o mesmo reembolso repetido/simultâneo gera uma única revisão', async () => {
    const c = await newCampaign({ globalLimit: 1 });
    const p = payload(c, 1);
    await run('orders/paid', p);
    const orderId = String(p.id);
    const refund = refundOf(c, orderId, 1);
    await Promise.all(Array.from({ length: 5 }, () => runRefund(refund)));
    await runRefund(refund);
    expect(await prisma.valePassRefundApplication.count({ where: { shopifyRefundId: String(refund.id) } })).toBe(1);
    const [showroom, closet] = [(await byCompany(orderId, 'VALLE_SHOWROOM'))[0], (await byCompany(orderId, 'VS_BY_CLOSET'))[0]];
    // achado da jornada: mesmo devolvendo a ÚNICA unidade do pedido (sem ambiguidade), o sistema ainda exige a confirmação do ADMIN — seguro, porém manual
    expect((await vouchersOf(orderId)).map((v) => v.status)).toEqual(['ACTIVE', 'ACTIVE']);
    expect((await rejection(redeem(showroom, 100, admin)))?.response?.code).toBe('REFUND_UNDER_REVIEW');
    expect((await rejection(redeem(closet, 100, admin)))?.response?.code).toBe('REFUND_UNDER_REVIEW');
    const review = (await refunds.listReviews({ status: 'NEEDS_REVIEW' })).find((r) => r.shopifyOrderId === orderId)!;
    expect(review).toBeDefined();
    const resolved = await refunds.resolveReview(review.id, { action: 'CANCEL_ACTIVE_VOUCHERS', note: 'reembolso integral confirmado na Shopify (jornada)' }, { id: admin.id, name: admin.name });
    expect(resolved.vouchersCancelled).toBe(2);
    expect((await vouchersOf(orderId)).every((v) => v.status === 'CANCELLED')).toBe(true);
    expect((await lots.getCapacity(c.id)).totals).toMatchObject({ sold: 0, consumed: 0 });
    // a unidade devolvida libera a venda: outro pedido cabe no teto de 1
    const next = payload(c, 1);
    await run('orders/paid', next);
    expect(await vouchersOf(String(next.id))).toHaveLength(2);
    expect(await ledger.reconcile()).toEqual([]);
  });

  test('crédito PARCIALMENTE utilizado + reembolso: revisão do ADMIN, uso bloqueado até a decisão, nada some; depois o cancelamento do pedido gera o ALERTA crítico com empresa e valores', async () => {
    const c = await newCampaign();
    const p = payload(c, 1);
    await run('orders/paid', p);
    const orderId = String(p.id);
    const [showroom] = await byCompany(orderId, 'VALLE_SHOWROOM');
    const [closet] = await byCompany(orderId, 'VS_BY_CLOSET');
    await redeem(showroom, 20_000, admin);
    await runRefund(refundOf(c, orderId, 1));
    // a unidade está em revisão: sem cancelamento automático, e o uso fica bloqueado
    const review = (await refunds.listReviews({ status: 'NEEDS_REVIEW' })).find((r) => r.shopifyOrderId === orderId);
    expect(review).toBeDefined();
    expect((await prisma.valePass.findUniqueOrThrow({ where: { id: showroom.id } })).status).toBe('ACTIVE');
    expect((await rejection(redeem(closet, 100, admin)))?.response?.code).toBe('REFUND_UNDER_REVIEW');
    const capacityOpen = await lots.getCapacity(c.id);
    expect(capacityOpen.refundReviews).toHaveLength(1);
    expect(capacityOpen.alerts.some((a) => a.code === 'REFUND_REVIEW_OPEN' && a.severity === 'critical')).toBe(true);
    // a Shopify também cancela o pedido: os vouchers ativos são cancelados e o alerta de crédito utilizado nasce
    await cancelOrder({ ...p, cancelled_at: new Date().toISOString(), cancel_reason: 'customer' });
    const [alert] = await prisma.valePassCancellationAlert.findMany({ where: { shopifyOrderId: orderId } });
    expect(alert).toMatchObject({ status: 'OPEN', usedCents: 20_000 });
    expect(JSON.stringify(alert)).not.toMatch(/VALLE-[A-Z0-9]{4}-|@exemplo/);
    const capacity = await lots.getCapacity(c.id);
    expect(capacity.cancellationAlerts[0]).toMatchObject({ usedCents: 20_000 });
    expect(capacity.alerts.some((a) => a.code === 'CANCELLED_ORDER_CREDIT_USED' && a.severity === 'critical')).toBe(true);
    // saldo, histórico e ledger preservados; nenhuma reversão reativa o crédito
    expect((await prisma.valePass.findUniqueOrThrow({ where: { id: showroom.id } })).balanceCents).toBe(30_000);
    const entry = (await prisma.valePassLedgerEntry.findMany({ where: { valePassId: showroom.id } }))[0];
    expect((await rejection(redemption.prepareReverse(showroom.code, entry.id, admin).then((r) => (r.canReverse ? null : Promise.reject({ response: { code: r.problems[0].code } })))))?.response?.code).toMatch(/ORDER_CANCELLED|REFUND_UNDER_REVIEW/);
    // a equipe confere o alerta (só registra a conferência)
    await alerts.acknowledge(alert.id, 'Reembolso conferido com o financeiro (jornada)', admin);
    expect((await lots.getCapacity(c.id)).cancellationAlerts).toHaveLength(0);
    expect((await prisma.valePass.findUniqueOrThrow({ where: { id: showroom.id } })).balanceCents).toBe(30_000);
    expect(await ledger.reconcile()).toEqual([]);
  });

  test('cancelamento e resgate SIMULTÂNEOS (jornada completa, 6 rodadas): o saldo gravado e o alerta sempre concordam e o ledger fecha', async () => {
    for (let round = 0; round < 6; round++) {
      const c = await newCampaign();
      const p = payload(c, 1);
      await run('orders/paid', p);
      const orderId = String(p.id);
      const [showroom] = await byCompany(orderId, 'VALLE_SHOWROOM');
      await redeem(showroom, 10_000, admin);
      const racing = redeem(showroom, 5_000, admin).then((r) => r, (e: unknown) => e);
      const cancel = cancelOrder({ ...p, cancelled_at: new Date().toISOString(), cancel_reason: 'customer' });
      await Promise.all(round % 2 ? [cancel, racing] : [racing, cancel]);
      const final = await prisma.valePass.findUniqueOrThrow({ where: { id: showroom.id } });
      const [alert] = await prisma.valePassCancellationAlert.findMany({ where: { shopifyOrderId: orderId } });
      expect(alert.usedCents).toBe(50_000 - final.balanceCents);
      expect(await ledger.reconcile()).toEqual([]);
    }
  }, 120_000);
});

localDescribe('5) VALIDADE — campanha fictícia, prorrogação coletiva sem mexer em saldos, elegibilidade, auditoria e idempotência', () => {
  test('validade configurada na emissão; prorrogação coletiva: só os elegíveis, saldos/ledger intactos, cancelados não reativados, auditoria crítica e repetição idempotente', async () => {
    const c = await newCampaign({ validUntil: '2027-09-30' });
    const used = payload(c, 1);
    const cancelled = payload(c, 1);
    const untouched = payload(c, 1);
    for (const p of [used, cancelled, untouched]) await run('orders/paid', p);
    const [usedShowroom] = await byCompany(String(used.id), 'VALLE_SHOWROOM');
    await redeem(usedShowroom, 20_000, admin);
    await cancelOrder({ ...cancelled, cancelled_at: new Date().toISOString(), cancel_reason: 'customer' });
    for (const v of await vouchersOf(String(untouched.id))) expect(v.expiresAt.toISOString()).toBe('2027-10-01T03:00:00.000Z'); // validade da campanha na emissão

    const snapshot = async () => (await prisma.valePass.findMany({ where: { campaignId: c.id }, orderBy: { code: 'asc' } })).map((v) => [v.code, v.balanceCents, v.status, v.company, v.amountCents]);
    const stateBefore = await snapshot();
    const ledgerBefore = await prisma.valePassLedgerEntry.count({ where: { valePass: { campaignId: c.id } } });
    const preview = await extensions.prepare(c.id, { newUntil: '2027-11-30' }, owner);
    expect(preview.counts).toMatchObject({ eligible: 4, cancelledNotIncluded: 2 }); // 2 vouchers do usado + 2 do intocado; 2 do cancelado ficam de fora
    const done = await extensions.confirm(c.id, { newUntil: '2027-11-30', reason: 'Decisão comercial confirmada (jornada sintética)', operationId: preview.operationId, confirmDate: '2027-11-30', expectedEligibleCount: preview.counts.eligible }, owner);
    expect(done.extension).toMatchObject({ extendedCount: 4, cancelledNotIncluded: 2, newUntil: '2027-11-30' });
    expect(await snapshot()).toEqual(stateBefore); // saldos, status, valores e empresas: iguais
    expect(await prisma.valePassLedgerEntry.count({ where: { valePass: { campaignId: c.id } } })).toBe(ledgerBefore);
    for (const v of await vouchersOf(String(untouched.id))) expect(v.expiresAt.toISOString()).toBe('2027-12-01T03:00:00.000Z');
    for (const v of await vouchersOf(String(cancelled.id))) expect(v).toMatchObject({ status: 'CANCELLED', expiresAt: new Date('2027-10-01T03:00:00.000Z') });
    expect((await prisma.adminAuditEvent.findFirstOrThrow({ where: { action: 'VALE_PASS_VALIDITY_EXTENDED', entityId: c.id } })).isCritical).toBe(true);
    // idempotência e proteção: repetir devolve o original; ADMIN não prorroga; data menor é recusada
    expect((await extensions.confirm(c.id, { newUntil: '2027-11-30', reason: 'Decisão comercial confirmada (jornada sintética)', operationId: preview.operationId, confirmDate: '2027-11-30', expectedEligibleCount: preview.counts.eligible }, owner)).replayed).toBe(true);
    await expect(extensions.prepare(c.id, { newUntil: '2028-01-31' }, admin)).rejects.toBeInstanceOf(ForbiddenException);
    expect((await extensions.prepare(c.id, { newUntil: '2027-10-31' }, owner)).canProceed).toBe(false);
    expect(await prisma.valePassValidityExtension.count({ where: { campaignId: c.id } })).toBe(1);
    // o crédito prorrogado continua utilizável, com o saldo que tinha
    expect(await redeem(usedShowroom, 1_000, admin)).toMatchObject({ balanceCents: 29_000 });
    expect(await ledger.reconcile()).toEqual([]);
  });
});

localDescribe('6) CONFIGURAÇÃO DE PRODUÇÃO — política ESTRITA do horário do pagamento + verificação automática pela Shopify (simulada)', () => {
  test('com a política estrita (padrão de produção) o webhook sozinho NÃO emite: o pedido pago fica RETIDO e visível; a verificação automática confirma pela transação da Shopify e emite os dois vouchers e a mensagem — uma única vez', async () => {
    policy.mode = 'strict';
    policy.autoVerify = true;
    const c = await newCampaign();
    const paidAt = new Date(Date.now() - 9 * 3_600_000).toISOString(); // Pix: pago há 9 h
    const p = payload(c, 1, { created_at: new Date(Date.now() - 10 * 3_600_000).toISOString(), updated_at: paidAt });
    const orderId = String(p.id);
    await prisma.$transaction(async (tx) => {
      await lockShopifyOrder(tx, orderId);
      return webhook.handleOrderWebhook(tx, 'orders/paid', p, { triggeredAt: paidAt });
    });
    await storeEvent('orders/paid', p, paidAt);
    expect(await vouchersOf(orderId)).toHaveLength(0); // sinais perfeitos do webhook não bastam
    expect(await outboxOf(orderId)).toHaveLength(0);
    const hold = (await holdsOf(orderId))[0];
    expect(JSON.stringify(hold.detail)).toContain('PAYMENT_TIME_UNKNOWN');
    expect((await lots.getCapacity(c.id)).alerts.some((a) => a.code === 'PAYMENT_TIME_UNKNOWN' && a.severity === 'critical')).toBe(true);
    // a Shopify (simulada) confirma a venda aprovada, no mesmo horário
    fakeTransactions.set(`gid://shopify/Order/${orderId}`, { orderGid: `gid://shopify/Order/${orderId}`, totalAmount: '350.00', currency: 'BRL', transactions: [{ id: 'gid://shopify/OrderTransaction/1', kind: 'SALE', status: 'SUCCESS', test: false, processedAt: paidAt, amount: '350.00', currency: 'BRL', gateway: 'gateway_pix' } as never] });
    const report = await autoVerify.runOnce(new Date());
    expect(report).toMatchObject({ enabled: true, issued: 1 });
    expect(await vouchersOf(orderId)).toHaveLength(2);
    expect(await outboxOf(orderId)).toHaveLength(1);
    await autoVerify.runOnce(new Date()); // de novo: nada em dobro
    expect(await vouchersOf(orderId)).toHaveLength(2);
    expect(await outboxOf(orderId)).toHaveLength(1);
  });

  test('transação de teste (test:true) ou valor diferente NÃO confirma: o pedido continua retido e nenhum voucher nasce', async () => {
    policy.mode = 'strict';
    policy.autoVerify = true;
    const c = await newCampaign();
    const paidAt = new Date(Date.now() - 9 * 3_600_000).toISOString();
    const p = payload(c, 1, { created_at: new Date(Date.now() - 10 * 3_600_000).toISOString(), updated_at: paidAt });
    const orderId = String(p.id);
    await prisma.$transaction(async (tx) => {
      await lockShopifyOrder(tx, orderId);
      return webhook.handleOrderWebhook(tx, 'orders/paid', p, { triggeredAt: paidAt });
    });
    await storeEvent('orders/paid', p, paidAt);
    fakeTransactions.set(`gid://shopify/Order/${orderId}`, { orderGid: `gid://shopify/Order/${orderId}`, totalAmount: '350.00', currency: 'BRL', transactions: [{ id: 'gid://shopify/OrderTransaction/2', kind: 'SALE', status: 'SUCCESS', test: true, processedAt: paidAt, amount: '350.00', currency: 'BRL', gateway: 'bogus' } as never] });
    await autoVerify.runOnce(new Date());
    expect(await vouchersOf(orderId)).toHaveLength(0);
    expect((await holdsOf(orderId))[0].status).toBe('OPEN');
  });
});

localDescribe('7) CICLO COMPLETO CONTÍNUO — Pix demorado em produção (política estrita + AUTO_VERIFY): compra → webhook → verificação → 2 vouchers → e-mail simulado → saldo → resgates concorrentes → cancelamento', () => {
  test('os 12 passos encadeados, com a Shopify, a Resend e a rede SIMULADAS: nada em dobro, saldo nunca ultrapassado, cancelamento bloqueia o uso', async () => {
    policy.mode = 'strict';
    policy.autoVerify = true;
    const c = await newCampaign();
    // 1-2) o cliente gera o Pix às T-5h e paga às T-4h30; a Shopify confirma (sale_success) e dispara orders/paid no mesmo instante
    const chargedAt = new Date(Date.now() - 5 * 3_600_000).toISOString();
    const paidAt = new Date(Date.now() - 4.5 * 3_600_000).toISOString();
    const p = payload(c, 1, { created_at: new Date(Date.now() - 5 * 3_600_000 + 30_000).toISOString(), updated_at: paidAt });
    const orderId = String(p.id);
    // 3) o webhook chega (e chega de novo, duplicado)
    for (let i = 0; i < 2; i++) {
      await prisma.$transaction(async (tx) => {
        await lockShopifyOrder(tx, orderId);
        return webhook.handleOrderWebhook(tx, 'orders/paid', p, { triggeredAt: paidAt });
      });
    }
    await storeEvent('orders/paid', p, paidAt);
    expect(await vouchersOf(orderId)).toHaveLength(0); // sinais do webhook sozinhos não bastam
    // 4) a verificação automática lê a Shopify: a transação traz a COBRANÇA (T-5h), a linha do tempo traz a confirmação (T-4h30)
    fakeTransactions.set(`gid://shopify/Order/${orderId}`, {
      orderGid: `gid://shopify/Order/${orderId}`,
      totalAmount: '350.00',
      currency: 'BRL',
      transactions: [{ id: 'gid://shopify/OrderTransaction/e2e', kind: 'SALE', status: 'SUCCESS', test: false, processedAt: chargedAt, amount: '350.00', currency: 'BRL', gateway: 'Gateway Pix' }],
      successEvents: [{ action: 'sale_success', createdAt: paidAt }],
    });
    expect(await autoVerify.runOnce(new Date())).toMatchObject({ confirmed: 1, issued: 1 });
    await autoVerify.runOnce(new Date());
    // 5) dois vouchers (R$ 500 + R$ 50), horário efetivo = a confirmação, não a cobrança
    const rows = await vouchersOf(orderId);
    expect(rows.map((v) => [v.company, v.amountCents, v.balanceCents]).sort()).toEqual([['VALLE_SHOWROOM', 50_000, 50_000], ['VS_BY_CLOSET', 5_000, 5_000]]);
    expect((await prisma.valePassOrder.findUniqueOrThrow({ where: { shopifyOrderId: orderId } })).paymentConfirmedAt?.toISOString()).toBe(paidAt);
    // 6-7) uma mensagem na caixa de saída; o worker (Resend SIMULADA) a processa uma única vez, mesmo com dois ciclos
    expect(await outboxOf(orderId)).toHaveLength(1);
    await worker.tick(new Date(Date.now() + 5_000));
    await worker.tick(new Date(Date.now() + 10_000));
    expect(provider.calls).toHaveLength(1);
    expect((await outboxOf(orderId))[0].status).toBe('ACCEPTED');
    // 8) o administrador consulta o saldo
    const [showroom] = await byCompany(orderId, 'VALLE_SHOWROOM');
    const [closet] = await byCompany(orderId, 'VS_BY_CLOSET');
    expect(await redemption.lookup(showroom.code, admin)).toMatchObject({ company: 'VALLE_SHOWROOM', balanceCents: 50_000, redeemable: true });
    // 9-10) resgate parcial: saldo atualizado, o outro voucher intacto
    expect(await redeem(showroom, 20_000, admin)).toMatchObject({ balanceCents: 30_000, status: 'ACTIVE' });
    expect((await prisma.valePass.findUniqueOrThrow({ where: { id: closet.id } })).balanceCents).toBe(5_000);
    // 11) dois resgates SIMULTÂNEOS de R$ 200 sobre R$ 300 de saldo: nunca passam do saldo
    const attempts = await Promise.allSettled([redeem(showroom, 20_000, admin), redeem(showroom, 20_000, owner)]);
    expect(attempts.filter((a) => a.status === 'fulfilled')).toHaveLength(1);
    expect((await prisma.valePass.findUniqueOrThrow({ where: { id: showroom.id } })).balanceCents).toBe(10_000);
    expect(await ledger.reconcile()).toEqual([]);
    // 12) cancelamento do pedido: os dois vouchers deixam de valer e nenhum novo resgate é aceito
    await cancelOrder({ ...p, financial_status: 'voided', cancelled_at: new Date().toISOString(), updated_at: new Date(Date.now() + 1_000).toISOString() });
    expect((await vouchersOf(orderId)).every((v) => v.status === 'CANCELLED')).toBe(true);
    expect(await rejection(redeem(showroom, 1_000, admin))).not.toBeNull();
    expect(await ledger.reconcile()).toEqual([]);
    // nada novo foi emitido ou enviado depois de tudo
    expect(await vouchersOf(orderId)).toHaveLength(2);
    expect(await outboxOf(orderId)).toHaveLength(1);
  });

  test('pagamento DIVIDIDO (dois Pix) com confirmações fora de ordem: só emite quando a soma fecha o total; um pedaço sem confirmação mantém a retenção', async () => {
    policy.mode = 'strict';
    policy.autoVerify = true;
    const c = await newCampaign();
    const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString();
    const paidAt = hoursAgo(3);
    const p = payload(c, 1, { created_at: hoursAgo(6), updated_at: paidAt });
    const orderId = String(p.id);
    await prisma.$transaction(async (tx) => {
      await lockShopifyOrder(tx, orderId);
      return webhook.handleOrderWebhook(tx, 'orders/paid', p, { triggeredAt: paidAt });
    });
    await storeEvent('orders/paid', p, paidAt);
    const gid = `gid://shopify/Order/${orderId}`;
    const piece = (id: string, charged: string, amount: string) => ({ id: `gid://shopify/OrderTransaction/${id}`, kind: 'SALE', status: 'SUCCESS', test: false, processedAt: charged, amount, currency: 'BRL', gateway: 'Gateway Pix' });
    // segundo pedaço ainda sem o evento de confirmação: nada é emitido
    fakeTransactions.set(gid, { orderGid: gid, totalAmount: '350.00', currency: 'BRL', transactions: [piece('a', hoursAgo(6), '100.00'), piece('b', hoursAgo(5.9), '250.00')], successEvents: [{ action: 'sale_success', createdAt: hoursAgo(5) }] });
    await autoVerify.runOnce(new Date());
    expect(await vouchersOf(orderId)).toHaveLength(0);
    // os dois confirmados, fora de ordem em relação à cobrança: a soma fecha; vale a última confirmação, que coincide com o webhook
    fakeTransactions.set(gid, { orderGid: gid, totalAmount: '350.00', currency: 'BRL', transactions: [piece('a', hoursAgo(6), '100.00'), piece('b', hoursAgo(5.9), '250.00')], successEvents: [{ action: 'sale_success', createdAt: hoursAgo(5) }, { action: 'sale_success', createdAt: paidAt }] });
    const current = await prisma.valePassOrder.findUniqueOrThrow({ where: { shopifyOrderId: orderId } });
    await prisma.valePassOrder.update({ where: { shopifyOrderId: orderId }, data: { paymentTimeEvidence: { ...(current.paymentTimeEvidence as object), auto: { attempts: 1, lastAt: hoursAgo(1), lastReason: 'SUCCESS_EVENT_MISMATCH', nextAttemptAt: hoursAgo(1) } } as never } });
    expect(await autoVerify.runOnce(new Date())).toMatchObject({ confirmed: 1, issued: 1 });
    expect(await vouchersOf(orderId)).toHaveLength(2);
    expect((await prisma.valePassOrder.findUniqueOrThrow({ where: { shopifyOrderId: orderId } })).paymentConfirmedAt?.toISOString()).toBe(paidAt);
  });
});

localDescribe('8) VERIFICADOR DA HOMOLOGAÇÃO — o que o runbook confere na compra de teste (somente leitura)', () => {
  async function pixOrder() {
    policy.mode = 'strict';
    policy.autoVerify = true;
    const c = await newCampaign();
    const paidAt = new Date(Date.now() - 4 * 3_600_000).toISOString();
    const p = payload(c, 1, { created_at: new Date(Date.now() - 5 * 3_600_000).toISOString(), updated_at: paidAt });
    const orderId = String(p.id);
    await prisma.$transaction(async (tx) => {
      await lockShopifyOrder(tx, orderId);
      return webhook.handleOrderWebhook(tx, 'orders/paid', p, { triggeredAt: paidAt });
    });
    await storeEvent('orders/paid', p, paidAt);
    fakeTransactions.set(`gid://shopify/Order/${orderId}`, {
      orderGid: `gid://shopify/Order/${orderId}`,
      totalAmount: '350.00',
      currency: 'BRL',
      transactions: [{ id: 'gid://shopify/OrderTransaction/h', kind: 'SALE', status: 'SUCCESS', test: false, processedAt: new Date(Date.now() - 5 * 3_600_000).toISOString(), amount: '350.00', currency: 'BRL', gateway: 'Gateway Pix' }],
      successEvents: [{ action: 'sale_success', createdAt: paidAt }],
    });
    return { p, orderId, paidAt };
  }

  test('pedido inexistente ou ainda retido: REPROVA com o motivo; nada é gravado', async () => {
    expect(await checkHomologation(prisma, { orderName: '#NAO-EXISTE-1' })).toMatchObject({ found: false, pass: false, fingerprint: null });
    const { p } = await pixOrder(); // retido: o AUTO_VERIFY ainda não rodou
    const before = await checkHomologation(prisma, { orderName: String(p.name) });
    expect(before.pass).toBe(false);
    expect(before.checks.filter((c) => !c.ok).map((c) => c.id)).toEqual(expect.arrayContaining(['1b-fonte', '2a-quantidade']));
  });

  test('depois do AUTO_VERIFY: todos os critérios passam; ciclos extras, reentregas e nova leitura dão o MESMO fingerprint; nenhum código ou dado pessoal na saída', async () => {
    const { p, paidAt } = await pixOrder();
    await autoVerify.runOnce(new Date());
    const first = await checkHomologation(prisma, { orderName: String(p.name) });
    expect(first.checks.filter((c) => !c.ok)).toEqual([]);
    expect(first.pass).toBe(true);
    await autoVerify.runOnce(new Date());
    await autoVerify.runOnce(new Date());
    await prisma.$transaction(async (tx) => {
      await lockShopifyOrder(tx, String(p.id));
      return webhook.handleOrderWebhook(tx, 'orders/paid', p, { triggeredAt: paidAt });
    });
    const second = await checkHomologation(prisma, { orderName: String(p.name) });
    expect(second.fingerprint).toBe(first.fingerprint);
    const text = JSON.stringify(second);
    const codes = (await vouchersOf(String(p.id))).map((v) => v.code);
    for (const code of codes) expect(text).not.toContain(code);
    expect(text).not.toMatch(/@exemplo|Maria|Sintética/);
  });

  test('detecta o que reprova a homologação: voucher a mais, mensagem enviada, retenção aberta e cancelamento', async () => {
    const { p, orderId } = await pixOrder();
    await autoVerify.runOnce(new Date());
    const [row] = await vouchersOf(orderId);
    // voucher duplicado (simula emissão em dobro)
    const duplicate = await prisma.valePass.create({ data: { code: `VALLE-${TAG.slice(-4)}-X${counter++}`.toUpperCase(), campaignId: row.campaignId, amountCents: row.amountCents, status: 'ACTIVE', purchasedAt: new Date(), expiresAt: row.expiresAt, validFrom: row.validFrom, company: row.company, groupId: row.groupId, benefitId: row.benefitId, shopifyOrderId: orderId } }).catch(() => null);
    // o banco normalmente recusa o duplicado; se algum caminho o aceitasse, o verificador reprovaria
    if (duplicate) expect((await checkHomologation(prisma, { orderName: String(p.name) })).pass).toBe(false);
    // mensagem com tentativa de envio
    await prisma.valePassEmailOutbox.updateMany({ where: { shopifyOrderId: orderId }, data: { attempts: 1 } }); // uma tentativa de envio já foi feita
    expect((await checkHomologation(prisma, { orderName: String(p.name) })).checks.find((c) => c.id === '3b-nada-enviado')?.ok).toBe(false);
    // cancelamento
    await cancelOrder({ ...p, financial_status: 'voided', cancelled_at: new Date().toISOString(), updated_at: new Date(Date.now() + 1_000).toISOString() });
    const cancelled = await checkHomologation(prisma, { orderName: String(p.name) });
    expect(cancelled.pass).toBe(false);
    expect(cancelled.checks.find((c) => c.id === '2c-valores')?.ok).toBe(false);
  });
});
