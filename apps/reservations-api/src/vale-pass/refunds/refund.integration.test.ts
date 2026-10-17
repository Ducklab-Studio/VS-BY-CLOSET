import { afterAll, afterEach, beforeAll, describe, expect, test } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { ConflictException, ForbiddenException, UnprocessableEntityException } from '@nestjs/common';
import type { ValePassCampaign } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { REQUIRE_ROLE_KEY } from '../../admin/require-role.decorator';
import { lockShopifyOrder } from '../../webhooks/shopify-order-lock';
import { ValePassFinancialGuard } from '../financial/financial-guard.service';
import { factsFromWebhookPayload } from '../financial/order-facts';
import { ValePassIssuanceService } from '../vale-pass-issuance.service';
import { ValePassLotsService } from '../vale-pass-lots.service';
import { ValePassVouchersService } from '../vale-pass-vouchers.service';
import { factsFromRefundWebhook } from './refund-facts';
import { ValePassRefundReviewsController } from './refund-reviews.controller';
import { ValePassRefundService, type RefundOutcome } from './refund.service';
import { ValePassRegularizationService } from './regularization.service';

/**
 * Reembolso parcial/total por UNIDADE, revisão administrativa e regularização de unidades adicionais, em PostgreSQL LOCAL descartável.
 * Nenhuma Shopify, nenhum e-mail. O módulo é ISOLADO: estes testes o chamam do jeito que a integração futura chamaria.
 */
const localDatabase = /^postgres(?:ql)?:\/\/[^@]+@(localhost|127\.0\.0\.1)(:\d+)?\/[^/]*(test|audit|operational)/i.test(process.env.DATABASE_URL ?? '');
const localDescribe = localDatabase ? describe : describe.skip;

const prisma = new PrismaService();
const issuance = new ValePassIssuanceService();
const refunds = new ValePassRefundService(prisma);
const regularization = new ValePassRegularizationService(prisma, new ValePassFinancialGuard(), issuance);
const lots = new ValePassLotsService(prisma);
const vouchersService = new ValePassVouchersService(prisma);

const TAG = `VPRF-${Date.now()}`;
let counter = 0;
let adminId: string;
let staffId: string;
const ADMIN_NAME = 'Admin Teste Reembolso';
const campaignIds: string[] = [];
const orderIds: string[] = [];

interface Fixture { campaign: ValePassCampaign & { numericVariant: string }; orderId: string; groupIds: string[] }

async function newCampaign(): Promise<ValePassCampaign & { numericVariant: string }> {
  const numericVariant = String(800_000_000_000 + counter++);
  const campaign = await prisma.valePassCampaign.create({
    data: {
      name: `${TAG}-camp-${counter++}`, amountCents: 35_000, validityDays: 30, shopifyVariantId: `gid://shopify/ProductVariant/${numericVariant}`,
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

/** Pedido PAGO com `units` unidades já emitidas (2 vouchers cada) pelo emissor real. Cada unidade tem `created_at` crescente (a mais nova é a última). */
async function paidOrderWithUnits(units: number, existingCampaign?: ValePassCampaign & { numericVariant: string }): Promise<Fixture> {
  const campaign = existingCampaign ?? (await newCampaign());
  const orderId = `${TAG}-o${counter++}`;
  orderIds.push(orderId);
  await prisma.valePassOrder.create({
    data: {
      shopifyOrderId: orderId, shopifyOrderGid: `gid://shopify/Order/${orderId}`, shopifyOrderName: `${TAG}#${counter}`, status: 'CONFIRMED', financialStatus: 'paid', quantity: units,
      customerName: 'Cliente Sintético', customerEmail: `c${counter}@exemplo.invalid`, customerPhone: '+5500000000000', lastSyncSource: 'teste',
      orderCreatedAt: new Date(Date.now() - 3_600_000), statusChangedAt: new Date(Date.now() - 3_600_000), vouchersProcessedAt: new Date(),
    },
  });
  for (let i = 0; i < units; i++) {
    await prisma.$transaction(async (tx) => {
      await lockShopifyOrder(tx, orderId);
      await issuance.issueForCampaign(tx, { campaignId: campaign.id, order: { orderId, orderGid: `gid://shopify/Order/${orderId}`, orderName: `${TAG}#${counter}`, customerName: 'Cliente Sintético', customerPhone: '+5500000000000', customerEmail: `c${counter}@exemplo.invalid` }, units: i + 1, mode: 'enforce' });
    });
    await new Promise((resolve) => setTimeout(resolve, 5)); // created_at estritamente crescente
  }
  const groups = await prisma.valePass.groupBy({ by: ['groupId'], where: { shopifyOrderId: orderId }, _min: { createdAt: true } });
  return { campaign, orderId, groupIds: groups.sort((a, b) => a._min.createdAt!.getTime() - b._min.createdAt!.getTime()).map((g) => g.groupId as string) };
}

const money = (amount: string) => ({ shop_money: { amount, currency_code: 'BRL' }, presentment_money: { amount, currency_code: 'BRL' } });
function refundFor(f: Fixture, over: { id?: string; quantity?: number; lines?: Record<string, unknown>[]; shipping?: string[]; transactions?: Record<string, unknown>[]; subtotal?: number } = {}): Record<string, unknown> {
  const quantity = over.quantity ?? 1;
  return {
    id: over.id ?? `${TAG}-rf${counter++}`, order_id: f.orderId, note: null,
    refund_line_items: over.lines ?? [{ id: 1, line_item_id: 7001, quantity, subtotal: over.subtotal ?? 350 * quantity, total_tax: 50.85, restock_type: 'return', line_item: { variant_id: Number(f.campaign.numericVariant), product_id: null, price: '350.00', quantity: 3 } }],
    refund_shipping_lines: (over.shipping ?? []).map((amount) => ({ id: 1, subtotal_amount_set: money(amount) })),
    transactions: over.transactions ?? [], order_adjustments: [],
  };
}
const apply = (payload: unknown): Promise<RefundOutcome> => prisma.$transaction((tx) => refunds.apply(tx, factsFromRefundWebhook(payload)), { timeout: 30_000, maxWait: 20_000 });
const vouchersOf = (orderId: string) => prisma.valePass.findMany({ where: { shopifyOrderId: orderId }, orderBy: [{ createdAt: 'asc' }, { company: 'asc' }] });
const statusByUnit = async (f: Fixture) => {
  const rows = await vouchersOf(f.orderId);
  return f.groupIds.map((groupId) => rows.filter((v) => v.groupId === groupId).map((v) => v.status).sort().join('+'));
};

beforeAll(async () => {
  if (!localDatabase) return;
  adminId = (await prisma.adminUser.create({ data: { name: ADMIN_NAME, phone: `${TAG}-admin`, pinHash: 'x', role: 'ADMIN', active: true } })).id;
  staffId = (await prisma.adminUser.create({ data: { name: 'Operador Teste Reembolso', phone: `${TAG}-staff`, pinHash: 'x', role: 'STAFF', active: true } })).id;
});

async function cleanRows() {
  const ids = campaignIds.splice(0);
  const orders = orderIds.splice(0);
  await prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe('SET LOCAL session_replication_role = replica'); // a trilha não pode ser apagada pelo app; só este teste descartável a limpa
    const holdRows = await tx.valePassIssuanceHold.findMany({ where: { campaignId: { in: ids } }, select: { id: true } });
    const refundRows = await tx.valePassRefundApplication.findMany({ where: { shopifyOrderId: { in: orders } }, select: { id: true } });
    const vouchers = await tx.valePass.findMany({ where: { campaignId: { in: ids } }, select: { id: true } });
    await tx.adminAuditEvent.deleteMany({ where: { OR: [{ entityId: { in: [...holdRows.map((h) => h.id), ...refundRows.map((r) => r.id), ...vouchers.map((v) => v.id)] } }, { adminUserId: { in: [adminId, staffId] } }] } });
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
  });
}
afterEach(async () => {
  if (localDatabase) await cleanRows();
});
afterAll(async () => {
  if (localDatabase) {
    await cleanRows();
    await prisma.adminUser.deleteMany({ where: { id: { in: [adminId, staffId] } } });
  }
  await prisma.$disconnect();
});

localDescribe('reembolso parcial por UNIDADE: aplicação real', () => {
  test('reembolso de 1 de 3 unidades: cancela os 2 vouchers da unidade mais nova; as outras 2 unidades seguem ATIVAS; capacidade libera 1 unidade', async () => {
    const f = await paidOrderWithUnits(3);
    const before = await lots.getCapacity(f.campaign.id);
    expect(before.totals).toMatchObject({ sold: 3, pending: 0, consumed: 3 });
    const outcome = await apply(refundFor(f, { quantity: 1, transactions: [{ amount: '350.00', kind: 'refund', status: 'success', currency: 'BRL' }] }));
    expect(outcome).toMatchObject({ status: 'APPLIED', cancelledVouchers: 2 });
    expect(await statusByUnit(f)).toEqual(['ACTIVE+ACTIVE', 'ACTIVE+ACTIVE', 'CANCELLED+CANCELLED']); // só a mais nova
    const cancelled = (await vouchersOf(f.orderId)).filter((v) => v.status === 'CANCELLED');
    expect(cancelled.every((v) => v.groupId === f.groupIds[2] && v.cancelledBy === null && v.cancelReason?.startsWith('refund:'))).toBe(true);
    const events = await prisma.valePassEvent.findMany({ where: { valePassId: { in: cancelled.map((v) => v.id) }, type: 'CANCELLED' } });
    expect(events).toHaveLength(2);
    expect(JSON.stringify(events)).not.toMatch(/VALLE-[A-Z0-9]{4}-[A-Z0-9]{4}/); // sem código de voucher
    const after = await lots.getCapacity(f.campaign.id);
    expect(after.totals).toMatchObject({ sold: 2, pending: 0, consumed: 2 }); // a unidade devolvida liberou a capacidade, sem falsa pendência
    const row = await prisma.valePassRefundApplication.findUniqueOrThrow({ where: { shopifyRefundId: (outcome as { application: { shopifyRefundId: string } }).application.shopifyRefundId } });
    expect(row).toMatchObject({ status: 'APPLIED', classification: 'UNITS', refundedUnits: 1, transactionsCents: 35000 });
    expect(row.cancelledGroupIds).toEqual([f.groupIds[2]]);
  });

  test('reembolso de frete / de outro produto NÃO cancela nenhum voucher (só registra)', async () => {
    const f = await paidOrderWithUnits(2);
    const shipping = await apply(refundFor(f, { lines: [], shipping: ['22.00'], transactions: [{ amount: '22.00', kind: 'refund', status: 'success' }] }));
    expect(shipping).toMatchObject({ status: 'APPLIED', cancelledVouchers: 0 });
    const otherProduct = await apply(refundFor(f, { lines: [{ id: 2, line_item_id: 7002, quantity: 1, subtotal: 80, total_tax: 0, restock_type: 'no_restock', line_item: { variant_id: 111, product_id: 222, price: '80.00', quantity: 1 } }], transactions: [{ amount: '80.00', kind: 'refund', status: 'success' }] }));
    expect(otherProduct).toMatchObject({ status: 'APPLIED', cancelledVouchers: 0 });
    expect(await statusByUnit(f)).toEqual(['ACTIVE+ACTIVE', 'ACTIVE+ACTIVE']);
    expect(await prisma.valePassRefundApplication.findMany({ where: { shopifyOrderId: f.orderId }, select: { classification: true, refundedUnits: true } })).toEqual(expect.arrayContaining([{ classification: 'UNRELATED', refundedUnits: 0 }]));
  });

  test('reembolso total (3 de 3): cancela as 3 unidades (6 vouchers) e libera a capacidade; marcado como totalmente reembolsado', async () => {
    const f = await paidOrderWithUnits(3);
    const outcome = await apply(refundFor(f, { quantity: 3 }));
    expect(outcome).toMatchObject({ status: 'APPLIED', cancelledVouchers: 6 });
    expect(await statusByUnit(f)).toEqual(['CANCELLED+CANCELLED', 'CANCELLED+CANCELLED', 'CANCELLED+CANCELLED']);
    expect((outcome as { application: { detail: unknown } }).application.detail).toMatchObject({ orderFullyRefunded: true });
    expect((await lots.getCapacity(f.campaign.id)).totals).toMatchObject({ sold: 0, consumed: 0 });
  });

  test('reembolsos em sequência (1 + 1 + 1) e um 4º acima das unidades pagas → revisão, nada cancelado', async () => {
    const f = await paidOrderWithUnits(3);
    for (let i = 0; i < 3; i++) expect(await apply(refundFor(f, { quantity: 1 }))).toMatchObject({ status: 'APPLIED', cancelledVouchers: 2 });
    expect(await statusByUnit(f)).toEqual(['CANCELLED+CANCELLED', 'CANCELLED+CANCELLED', 'CANCELLED+CANCELLED']);
    const extra = await apply(refundFor(f, { quantity: 1 }));
    expect(extra).toMatchObject({ status: 'NEEDS_REVIEW', cancelledVouchers: 0 });
    expect((extra as { application: { reviewReasons: unknown } }).application.reviewReasons).toEqual(expect.arrayContaining(['PAID_UNITS_EXCEEDED']));
  });

  test('vouchers cancelados NUNCA são reativados nem tocados por um reembolso seguinte; o painel de restauração continua recusando', async () => {
    const f = await paidOrderWithUnits(2);
    await apply(refundFor(f, { quantity: 1 }));
    const cancelledBefore = (await vouchersOf(f.orderId)).filter((v) => v.status === 'CANCELLED');
    await apply(refundFor(f, { quantity: 1 }));
    const afterAll = await vouchersOf(f.orderId);
    for (const v of cancelledBefore) {
      const now = afterAll.find((x) => x.id === v.id)!;
      expect(now).toMatchObject({ status: 'CANCELLED', cancelledAt: v.cancelledAt, cancelReason: v.cancelReason }); // intocado pelo 2º reembolso
    }
    await expect(vouchersService.restore(cancelledBefore[0].code, 'tentando restaurar', adminId, ADMIN_NAME)).rejects.toThrow(/cancelado|Shopify/i); // cancelado automaticamente: nunca restaurável
  });

  test('pedido não pago cancelado (sem vouchers): registra e não gera revisão-ruído; pedido que não é de Valle Pass é ignorado', async () => {
    const f = await paidOrderWithUnits(1);
    await prisma.valePassEvent.deleteMany({ where: { valePass: { shopifyOrderId: f.orderId } } });
    await prisma.valePass.deleteMany({ where: { shopifyOrderId: f.orderId } });
    const outcome = await apply(refundFor(f, { quantity: 1 }));
    expect(outcome).toMatchObject({ status: 'APPLIED', cancelledVouchers: 0 });
    expect((outcome as { application: { classification: string } }).application.classification).toBe('NO_UNITS');
    expect(await apply({ ...refundFor(f), id: `${TAG}-outro`, order_id: '999000999' })).toEqual({ status: 'NOT_VALE_PASS' });
    expect(await apply({ ...refundFor(f), id: null })).toEqual({ status: 'NOT_VALE_PASS' }); // sem id do reembolso não há idempotência: não age
  });

  test('pedido com voucher LEGADO (sem unidade) → LEGACY_ORDER: nenhuma trilha, nenhuma alteração; o caminho antigo segue como era', async () => {
    const f = await paidOrderWithUnits(1);
    const legacy = await prisma.valePass.create({ data: { code: `${TAG}-legado`, campaignId: f.campaign.id, amountCents: 35_000, status: 'ACTIVE', purchasedAt: new Date(), expiresAt: new Date(Date.now() + 86_400_000), shopifyOrderId: f.orderId } });
    const before = await vouchersOf(f.orderId);
    expect(await apply(refundFor(f, { quantity: 1 }))).toEqual({ status: 'LEGACY_ORDER' });
    expect(await vouchersOf(f.orderId)).toEqual(before);
    expect(await prisma.valePass.findUniqueOrThrow({ where: { id: legacy.id } })).toEqual(legacy);
    expect(await prisma.valePassRefundApplication.count({ where: { shopifyOrderId: f.orderId } })).toBe(0);
  });
});

localDescribe('idempotência e concorrência', () => {
  test('o MESMO reembolso entregue várias vezes, ao mesmo tempo: cancela UMA vez (2 vouchers), as demais respostas são DUPLICATE', async () => {
    const f = await paidOrderWithUnits(3);
    const payload = refundFor(f, { quantity: 1, id: `${TAG}-mesmo` });
    const outcomes = await Promise.all(Array.from({ length: 10 }, () => apply(payload)));
    expect(outcomes.filter((o) => o.status === 'APPLIED')).toHaveLength(1);
    expect(outcomes.filter((o) => o.status === 'DUPLICATE')).toHaveLength(9);
    expect((await vouchersOf(f.orderId)).filter((v) => v.status === 'CANCELLED')).toHaveLength(2);
    expect(await prisma.valePassRefundApplication.count({ where: { shopifyRefundId: `${TAG}-mesmo` } })).toBe(1);
    expect(await apply(payload)).toMatchObject({ status: 'DUPLICATE' }); // e depois, também
  });

  test('reembolsos DIFERENTES simultâneos do mesmo pedido: nunca cancelam a mesma unidade duas vezes; total consistente com o acumulado', async () => {
    const f = await paidOrderWithUnits(3);
    const outcomes = await Promise.all([1, 2, 3].map((n) => apply(refundFor(f, { quantity: 1, id: `${TAG}-par${n}` }))));
    expect(outcomes.every((o) => o.status === 'APPLIED')).toBe(true);
    expect(await statusByUnit(f)).toEqual(['CANCELLED+CANCELLED', 'CANCELLED+CANCELLED', 'CANCELLED+CANCELLED']);
    expect((await vouchersOf(f.orderId)).filter((v) => v.status === 'CANCELLED')).toHaveLength(6);
    expect((await prisma.valePassRefundApplication.aggregate({ where: { shopifyOrderId: f.orderId }, _sum: { refundedUnits: true } }))._sum.refundedUnits).toBe(3);
  });

  test('corrida entre USO do voucher e reembolso: nunca fica unidade com voucher usado E cancelado de forma incoerente; usado nunca é cancelado', async () => {
    for (let round = 0; round < 8; round++) {
      const f = await paidOrderWithUnits(2);
      const newest = (await vouchersOf(f.orderId)).filter((v) => v.groupId === f.groupIds[1]);
      const [usedResult, refundResult] = await Promise.allSettled([vouchersService.markUsed(newest[0].code, adminId, ADMIN_NAME), apply(refundFor(f, { quantity: 1, id: `${TAG}-corrida${round}` }))]);
      expect(refundResult.status).toBe('fulfilled');
      const rows = await vouchersOf(f.orderId);
      expect(rows.filter((v) => v.status === 'USED').every((v) => v.cancelledAt === null)).toBe(true); // usado nunca é cancelado
      for (const groupId of f.groupIds) {
        const unit = rows.filter((v) => v.groupId === groupId).map((v) => v.status);
        expect(unit.includes('CANCELLED') && unit.includes('ACTIVE'), `unidade meio cancelada na rodada ${round}`).toBe(false);
      }
      // 2 reembolsos de 1: qualquer ordem de chegada resulta em exatamente 1 unidade cancelada OU 1 em revisão — nunca as duas unidades vivas canceladas por 1 reembolso
      expect(rows.filter((v) => v.status === 'CANCELLED')).toHaveLength(usedResult.status === 'fulfilled' ? 2 : 2);
      await cleanRows();
    }
  });
});

localDescribe('voucher já usado: retenção administrativa (fail-closed) e resolução auditada', () => {
  async function usedScenario() {
    const f = await paidOrderWithUnits(3);
    const newest = (await vouchersOf(f.orderId)).filter((v) => v.groupId === f.groupIds[2]);
    await vouchersService.markUsed(newest.find((v) => v.company === 'VS_BY_CLOSET')!.code, adminId, ADMIN_NAME); // 1 voucher da unidade mais nova já foi usado
    return f;
  }

  test('reembolso total com uma unidade já usada: as 2 intocadas são canceladas; a usada vira REVISÃO (nada do usado é alterado) e o alerta crítico aparece', async () => {
    const f = await usedScenario();
    const outcome = await apply(refundFor(f, { quantity: 3 }));
    expect(outcome).toMatchObject({ status: 'NEEDS_REVIEW', cancelledVouchers: 4 });
    expect(await statusByUnit(f)).toEqual(['CANCELLED+CANCELLED', 'CANCELLED+CANCELLED', 'ACTIVE+USED']);
    const application = (outcome as { application: { id: string; reviewReasons: unknown; detail: unknown } }).application;
    expect(application.reviewReasons).toEqual(['USED_VOUCHERS']);
    expect(application.detail).toMatchObject({ reviewGroupIds: [f.groupIds[2]], unitsNeedingReview: 1 });
    const capacity = await lots.getCapacity(f.campaign.id);
    expect(capacity.alerts.find((a) => a.code === 'REFUND_REVIEW_OPEN')).toMatchObject({ severity: 'critical' });
    expect(capacity.refundReviews).toEqual([expect.objectContaining({ id: application.id, refundedUnits: 3, unitsNeedingReview: 1, reasons: ['USED_VOUCHERS'] })]);
    expect((await refunds.listReviews()).map((r) => r.id)).toEqual([application.id]);
  });

  test('ADMIN decide "manter": nada muda nos vouchers, a revisão fecha com justificativa e auditoria crítica; não resolve duas vezes', async () => {
    const f = await usedScenario();
    const { application } = (await apply(refundFor(f, { quantity: 3 }))) as { application: { id: string } };
    const snapshot = await vouchersOf(f.orderId);
    const item = await refunds.resolveReview(application.id, { action: 'KEEP_VOUCHERS', note: 'Política: voucher usado não se desfaz' }, { id: adminId, name: ADMIN_NAME });
    expect(item).toMatchObject({ status: 'RESOLVED', resolution: 'KEEP_VOUCHERS' });
    expect(await vouchersOf(f.orderId)).toEqual(snapshot);
    const audit = await prisma.adminAuditEvent.findFirstOrThrow({ where: { entityId: application.id, action: 'VALE_PASS_REFUND_REVIEW_RESOLVED' } });
    expect(audit).toMatchObject({ adminUserId: adminId, isCritical: true });
    expect(audit.after).toMatchObject({ resolution: 'KEEP_VOUCHERS', vouchersCancelled: 0 });
    expect((await lots.getCapacity(f.campaign.id)).alerts.map((a) => a.code)).not.toContain('REFUND_REVIEW_OPEN');
    await expect(refunds.resolveReview(application.id, { action: 'KEEP_VOUCHERS', note: 'de novo, mais uma vez' }, { id: adminId, name: ADMIN_NAME })).rejects.toBeInstanceOf(ConflictException);
  });

  test('ADMIN decide "cancelar ativos": só o voucher AINDA ATIVO da unidade proposta é cancelado; o USADO permanece USADO', async () => {
    const f = await usedScenario();
    const { application } = (await apply(refundFor(f, { quantity: 3 }))) as { application: { id: string } };
    const usedBefore = (await vouchersOf(f.orderId)).find((v) => v.status === 'USED')!;
    const item = await refunds.resolveReview(application.id, { action: 'CANCEL_ACTIVE_VOUCHERS', note: 'Devolvido: cancelar o que sobrou' }, { id: adminId, name: ADMIN_NAME });
    expect(item).toMatchObject({ status: 'RESOLVED', resolution: 'CANCEL_ACTIVE_VOUCHERS' });
    expect(await statusByUnit(f)).toEqual(['CANCELLED+CANCELLED', 'CANCELLED+CANCELLED', 'CANCELLED+USED']);
    expect(await prisma.valePass.findUniqueOrThrow({ where: { id: usedBefore.id } })).toMatchObject({ status: 'USED', cancelledAt: null, usedAt: usedBefore.usedAt });
    expect((await prisma.adminAuditEvent.findFirstOrThrow({ where: { entityId: application.id } })).after).toMatchObject({ resolution: 'CANCEL_ACTIVE_VOUCHERS', vouchersCancelled: 1 });
  });

  test('segurança da resolução: STAFF/inativo/inexistente (403), justificativa curta ou ação inválida (422), id inexistente (404); rota só ADMIN', async () => {
    const f = await usedScenario();
    const { application } = (await apply(refundFor(f, { quantity: 3 }))) as { application: { id: string } };
    const note = 'Justificativa suficientemente longa';
    await expect(refunds.resolveReview(application.id, { action: 'KEEP_VOUCHERS', note }, { id: staffId, name: 'Operador' })).rejects.toBeInstanceOf(ForbiddenException);
    await expect(refunds.resolveReview(application.id, { action: 'KEEP_VOUCHERS', note }, { id: '00000000-0000-4000-8000-000000000000', name: 'x' })).rejects.toBeInstanceOf(ForbiddenException);
    await expect(refunds.resolveReview(application.id, { action: 'KEEP_VOUCHERS', note: 'curta' }, { id: adminId, name: ADMIN_NAME })).rejects.toBeInstanceOf(UnprocessableEntityException);
    await expect(refunds.resolveReview(application.id, { action: 'APAGAR' as never, note }, { id: adminId, name: ADMIN_NAME })).rejects.toBeInstanceOf(UnprocessableEntityException);
    await expect(refunds.resolveReview('00000000-0000-4000-8000-000000000000', { action: 'KEEP_VOUCHERS', note }, { id: adminId, name: ADMIN_NAME })).rejects.toThrow(/não encontrada/);
    expect((await prisma.valePassRefundApplication.findUniqueOrThrow({ where: { id: application.id } })).status).toBe('NEEDS_REVIEW'); // nada mudou
    const proto = ValePassRefundReviewsController.prototype as unknown as Record<string, unknown>;
    expect(Reflect.getMetadata(REQUIRE_ROLE_KEY, proto.resolve as object)).toBe('ADMIN');
    expect(Reflect.getMetadata(REQUIRE_ROLE_KEY, proto.list as object)).toBeUndefined();
  });

  test('valor que não fecha (subtotal ≠ quantidade × preço): nada é cancelado automaticamente; a revisão propõe a unidade mais nova', async () => {
    const f = await paidOrderWithUnits(3);
    const outcome = await apply(refundFor(f, { quantity: 1, subtotal: 300 }));
    expect(outcome).toMatchObject({ status: 'NEEDS_REVIEW', cancelledVouchers: 0 });
    expect(await statusByUnit(f)).toEqual(['ACTIVE+ACTIVE', 'ACTIVE+ACTIVE', 'ACTIVE+ACTIVE']);
    const application = (outcome as { application: { id: string; reviewReasons: unknown; detail: unknown } }).application;
    expect(application.reviewReasons).toEqual(['AMOUNT_MISMATCH']);
    expect(application.detail).toMatchObject({ reviewGroupIds: [f.groupIds[2]] });
    await refunds.resolveReview(application.id, { action: 'CANCEL_ACTIVE_VOUCHERS', note: 'Valor conferido na Shopify: unidade devolvida' }, { id: adminId, name: ADMIN_NAME });
    expect(await statusByUnit(f)).toEqual(['ACTIVE+ACTIVE', 'ACTIVE+ACTIVE', 'CANCELLED+CANCELLED']);
  });

  test('dinheiro devolvido sem unidade (valor avulso): só "manter" é possível; "cancelar" não tem unidade proposta', async () => {
    const f = await paidOrderWithUnits(2);
    const outcome = await apply(refundFor(f, { lines: [], transactions: [{ amount: '100.00', kind: 'refund', status: 'success' }] }));
    expect(outcome).toMatchObject({ status: 'NEEDS_REVIEW', cancelledVouchers: 0 });
    const application = (outcome as { application: { id: string; classification: string } }).application;
    expect(application.classification).toBe('AMOUNT_ONLY');
    await expect(refunds.resolveReview(application.id, { action: 'CANCEL_ACTIVE_VOUCHERS', note: 'Tentando cancelar sem unidade' }, { id: adminId, name: ADMIN_NAME })).rejects.toBeInstanceOf(ConflictException);
    expect(await refunds.resolveReview(application.id, { action: 'KEEP_VOUCHERS', note: 'Cortesia: valor devolvido sem relação com as unidades' }, { id: adminId, name: ADMIN_NAME })).toMatchObject({ status: 'RESOLVED' });
    expect(await statusByUnit(f)).toEqual(['ACTIVE+ACTIVE', 'ACTIVE+ACTIVE']);
  });
});

localDescribe('unidades adicionais pagas: regularização segura', () => {
  const money2 = (amount: string) => ({ shop_money: { amount, currency_code: 'BRL' }, presentment_money: { amount, currency_code: 'BRL' } });
  function paidPayload(f: Fixture, quantity: number, over: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      id: f.orderId, financial_status: 'paid', cancelled_at: null, currency: 'BRL', presentment_currency: 'BRL', current_total_price: ((35000 * quantity) / 100).toFixed(2), total_outstanding: '0.00', total_discounts: '0.00',
      discount_codes: [], refunds: [], total_shipping_price_set: money2('0.00'),
      line_items: [{ variant_id: Number(f.campaign.numericVariant), product_id: null, quantity, current_quantity: quantity, price: '350.00', price_set: money2('350.00'), discount_allocations: [] }], ...over,
    };
  }
  const regularize = (f: Fixture, payload: unknown) => prisma.$transaction((tx) => regularization.regularize(tx, { orderId: f.orderId, facts: factsFromWebhookPayload(payload) }));

  test('a compra cresceu de 2 para 3 unidades depois do pagamento: aparece como candidata; com os fatos válidos, emite SÓ a unidade que faltou (2 vouchers); repetir não duplica', async () => {
    const f = await paidOrderWithUnits(2);
    await prisma.valePassOrder.update({ where: { shopifyOrderId: f.orderId }, data: { quantity: 3 } });
    expect(await regularization.findCandidates()).toEqual(expect.arrayContaining([expect.objectContaining({ orderId: f.orderId, quantity: 3, issuedUnits: 2, missing: 1, kind: 'QUANTITY_INCREASED', hasOpenHold: false, legacy: false })]));
    expect(await regularize(f, paidPayload(f, 3))).toEqual({ status: 'ISSUED', issuedUnits: 1, vouchersCreated: 2 });
    expect(await vouchersOf(f.orderId)).toHaveLength(6);
    expect(await regularize(f, paidPayload(f, 3))).toEqual({ status: 'NOTHING_TO_DO' });
    expect(await vouchersOf(f.orderId)).toHaveLength(6);
    expect((await regularization.findCandidates()).some((c) => c.orderId === f.orderId)).toBe(false);
  });

  test('pedido pago e nunca processado (0 unidades): candidato NOT_PROCESSED; regulariza as unidades pagas', async () => {
    const f = await paidOrderWithUnits(1);
    await prisma.valePassEvent.deleteMany({ where: { valePass: { shopifyOrderId: f.orderId } } });
    await prisma.valePass.deleteMany({ where: { shopifyOrderId: f.orderId } });
    await prisma.valePassOrder.update({ where: { shopifyOrderId: f.orderId }, data: { quantity: 2 } });
    expect(await regularization.findCandidates()).toEqual(expect.arrayContaining([expect.objectContaining({ orderId: f.orderId, kind: 'NOT_PROCESSED', missing: 2 })]));
    expect(await regularize(f, paidPayload(f, 2))).toEqual({ status: 'ISSUED', issuedUnits: 2, vouchersCreated: 4 });
  });

  test('unidade devolvida por reembolso NUNCA é reemitida (conta como emitida); a regularização não a recria', async () => {
    const f = await paidOrderWithUnits(3);
    await apply(refundFor(f, { quantity: 1 }));
    expect(await regularize(f, paidPayload(f, 3, { current_total_price: '700.00', financial_status: 'paid' }))).toEqual({ status: 'NOTHING_TO_DO' });
    expect(await statusByUnit(f)).toEqual(['ACTIVE+ACTIVE', 'ACTIVE+ACTIVE', 'CANCELLED+CANCELLED']);
  });

  test('fatos financeiros inválidos (desconto, total diferente, pagamento incompleto, quantidade divergente): vira RETENÇÃO administrativa, nunca emissão silenciosa', async () => {
    const cases: [string, Record<string, unknown>][] = [
      ['desconto', { total_discounts: '35.00', current_total_price: '315.00', discount_codes: [{ code: 'PROMO' }] }],
      ['saldo em aberto (diferença ainda não paga)', { total_outstanding: '350.00', financial_status: 'partially_paid' }],
      ['moeda', { currency: 'USD' }],
    ];
    for (const [label, over] of cases) {
      const f = await paidOrderWithUnits(1);
      await prisma.valePassOrder.update({ where: { shopifyOrderId: f.orderId }, data: { quantity: 2 } });
      const outcome = await regularize(f, paidPayload(f, 2, over));
      expect(outcome, label).toMatchObject({ status: 'HELD', reason: 'FINANCIAL_MISMATCH', missing: 1 });
      expect(await vouchersOf(f.orderId), label).toHaveLength(2); // nada novo emitido
      expect(await prisma.valePassIssuanceHold.findFirst({ where: { shopifyOrderId: f.orderId, status: 'OPEN', reason: 'FINANCIAL_MISMATCH' } }), label).not.toBeNull();
      await cleanRows();
    }
    // payload com quantidade diferente do registro
    const f = await paidOrderWithUnits(1);
    await prisma.valePassOrder.update({ where: { shopifyOrderId: f.orderId }, data: { quantity: 3 } });
    expect(await regularize(f, paidPayload(f, 2))).toMatchObject({ status: 'HELD', reason: 'FINANCIAL_MISMATCH' });
  });

  test('sem capacidade (limite global): retém como CAPACITY_EXCEEDED e a unidade segue contada; sem facts do pedido certo → FACTS_MISMATCH; não pago → NOT_PAID; legado → LEGACY_ORDER', async () => {
    const f = await paidOrderWithUnits(1);
    await prisma.valePassCampaign.update({ where: { id: f.campaign.id }, data: { globalLimit: 1 } });
    await prisma.valePassOrder.update({ where: { shopifyOrderId: f.orderId }, data: { quantity: 2 } });
    expect(await regularize(f, paidPayload(f, 2))).toMatchObject({ status: 'HELD', reason: 'CAPACITY_EXCEEDED', missing: 1 });
    expect(await regularize(f, { ...paidPayload(f, 2), id: 'outro-pedido' })).toEqual({ status: 'FACTS_MISMATCH' });
    await prisma.valePassOrder.update({ where: { shopifyOrderId: f.orderId }, data: { status: 'REFUNDED' } });
    expect(await regularize(f, paidPayload(f, 2))).toEqual({ status: 'NOT_PAID' });

    const legacyFixture = await paidOrderWithUnits(1);
    await prisma.valePass.create({ data: { code: `${TAG}-leg2`, campaignId: legacyFixture.campaign.id, amountCents: 35_000, purchasedAt: new Date(), expiresAt: new Date(Date.now() + 86_400_000), shopifyOrderId: legacyFixture.orderId } });
    await prisma.valePassOrder.update({ where: { shopifyOrderId: legacyFixture.orderId }, data: { quantity: 3 } });
    expect(await regularize(legacyFixture, paidPayload(legacyFixture, 3))).toEqual({ status: 'LEGACY_ORDER' });
    expect((await regularization.findCandidates()).find((c) => c.orderId === legacyFixture.orderId)?.legacy).toBe(true);
  });
});

localDescribe('garantias do banco e isolamento', () => {
  test('trilha: reembolso único, imutável, sem exclusão; revisão resolvida exige decisão e não reabre', async () => {
    const f = await paidOrderWithUnits(2);
    const { application } = (await apply(refundFor(f, { quantity: 1, id: `${TAG}-banco`, subtotal: 300 }))) as { application: { id: string } };
    await expect(prisma.valePassRefundApplication.create({ data: { shopifyRefundId: `${TAG}-banco`, shopifyOrderId: f.orderId, classification: 'UNITS', status: 'APPLIED' } })).rejects.toThrow(/Unique constraint/i);
    await expect(prisma.valePassRefundApplication.update({ where: { id: application.id }, data: { shopifyOrderId: 'outro' } })).rejects.toThrow(/vale_pass_refund_immutable/);
    await expect(prisma.valePassRefundApplication.update({ where: { id: application.id }, data: { shopifyRefundId: 'outro' } })).rejects.toThrow(/vale_pass_refund_immutable/);
    await expect(prisma.valePassRefundApplication.delete({ where: { id: application.id } })).rejects.toThrow(/vale_pass_refund_no_delete/);
    await expect(prisma.valePassRefundApplication.update({ where: { id: application.id }, data: { status: 'RESOLVED' } })).rejects.toThrow(/vra_resolution_fields/); // resolvida sem decisão/justificativa/quem
    await expect(prisma.valePassRefundApplication.update({ where: { id: application.id }, data: { refundedUnits: -1 } })).rejects.toThrow(/vra_units_nonneg/);
    await refunds.resolveReview(application.id, { action: 'KEEP_VOUCHERS', note: 'Conferido e mantido para o teste' }, { id: adminId, name: ADMIN_NAME });
    await expect(prisma.valePassRefundApplication.update({ where: { id: application.id }, data: { status: 'NEEDS_REVIEW', resolution: null, resolvedAt: null, resolvedBy: null, resolutionNote: null } })).rejects.toThrow(/vale_pass_refund_immutable/);
  });

  test('o webhook financeiro, o checkout, o HMAC e a reconciliação NÃO conhecem estes módulos; só o próprio módulo os usa', () => {
    const root = join(__dirname, '..', '..');
    const users: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const full = join(dir, name);
        if (statSync(full).isDirectory()) walk(full);
        else if (full.endsWith('.ts') && !full.endsWith('.test.ts') && /ValePassRefundService|ValePassRegularizationService|planRefund|factsFromRefundWebhook|statusAfterRefund/.test(readFileSync(full, 'utf8'))) users.push(full.slice(root.length + 1).split('\\').join('/'));
      }
    };
    walk(root);
    expect(users.sort()).toEqual(['vale-pass/refunds/refund-facts.ts', 'vale-pass/refunds/refund-plan.ts', 'vale-pass/refunds/refund-reviews.controller.ts', 'vale-pass/refunds/refund.service.ts', 'vale-pass/refunds/regularization.service.ts', 'vale-pass/vale-pass.module.ts']);
    for (const file of ['vale-pass/vale-pass-webhook.service.ts', 'webhooks/webhooks.service.ts', 'webhooks/webhooks.controller.ts', 'webhooks/shopify-hmac.ts', 'vale-pass/vale-pass-orders.service.ts', 'vale-pass/vale-pass-order-registry.ts', 'vale-pass/vale-pass-order-status.ts']) {
      const source = readFileSync(join(root, file), 'utf8');
      for (const name of ['/refunds/', 'ValePassRefundService', 'ValePassRegularizationService', 'planRefund', 'factsFromRefundWebhook', 'statusAfterRefund']) expect(source, `${file} → ${name}`).not.toContain(name);
    }
  });
});
