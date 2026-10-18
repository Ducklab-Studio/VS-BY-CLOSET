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
async function paidOrderWithUnits(units: number, existingCampaign?: ValePassCampaign & { numericVariant: string }, paid: number = units): Promise<Fixture> {
  const campaign = existingCampaign ?? (await newCampaign());
  const orderId = `${TAG}-o${counter++}`;
  orderIds.push(orderId);
  await prisma.valePassOrder.create({
    data: {
      shopifyOrderId: orderId, shopifyOrderGid: `gid://shopify/Order/${orderId}`, shopifyOrderName: `${TAG}#${counter}`, status: 'CONFIRMED', financialStatus: 'paid', quantity: paid,
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
const apply = (payload: unknown, policy: 'AUTO_NEWEST' | 'ADMIN_CONFIRM' = 'AUTO_NEWEST'): Promise<RefundOutcome> => prisma.$transaction((tx) => refunds.apply(tx, factsFromRefundWebhook(payload), { policy }), { timeout: 30_000, maxWait: 20_000 });
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
    expect((outcome as { application: { classification: string; detail: unknown } }).application).toMatchObject({ classification: 'UNITS', detail: { unissuedAbsorbed: 1 } });
    expect(await apply({ ...refundFor(f), id: `${TAG}-outro`, order_id: '999000999', refund_line_items: [] })).toEqual({ status: 'NOT_VALE_PASS' }); // sem linha de Valle Pass e sem pedido: não é conosco
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
    expect(users.sort()).toEqual(['vale-pass/refunds/refund-facts.ts', 'vale-pass/refunds/refund-plan.ts', 'vale-pass/refunds/refund-reviews.controller.ts', 'vale-pass/refunds/refund.service.ts', 'vale-pass/refunds/regularization.service.ts', 'vale-pass/vale-pass-webhook.service.ts', 'vale-pass/vale-pass.module.ts']);
    // O webhook de pedidos (ValePassWebhookService) é o ÚNICO ponto de integração, atrás da chave VALE_PASS_UNIT_REFUNDS (desligada por padrão).
    for (const file of ['webhooks/webhooks.service.ts', 'webhooks/webhooks.controller.ts', 'webhooks/shopify-hmac.ts', 'vale-pass/vale-pass-orders.service.ts', 'vale-pass/vale-pass-order-registry.ts', 'vale-pass/vale-pass-order-status.ts']) {
      const source = readFileSync(join(root, file), 'utf8');
      for (const name of ['/refunds/', 'ValePassRefundService', 'ValePassRegularizationService', 'planRefund', 'factsFromRefundWebhook', 'statusAfterRefund']) expect(source, `${file} → ${name}`).not.toContain(name);
    }
  });
});

/** Emissão do jeito do webhook (modo enforce), usada para provar o que acontece DEPOIS de um reembolso. */
const ord = { orderGid: 'g', orderName: 'n', customerName: 'c', customerPhone: 'p', customerEmail: 'e@exemplo.invalid' };
const issueLater = (f: Fixture, units: number, mode: 'enforce' | 'override' = 'enforce') =>
  prisma.$transaction(async (tx) => {
    await lockShopifyOrder(tx, f.orderId);
    return issuance.issueForCampaign(tx, { campaignId: f.campaign.id, order: { orderId: f.orderId, ...ord }, units, mode });
  });
const applyDefault = (payload: unknown) => apply(payload, 'ADMIN_CONFIRM');
const registryOf = (orderId: string) => prisma.valePassOrder.findUniqueOrThrow({ where: { shopifyOrderId: orderId } });

localDescribe('F1 — reembolso ANTES da emissão: a emissão posterior desconta as unidades reembolsadas', () => {
  test('reembolso total antes da emissão: nada é emitido depois; o pedido NÃO é marcado como cancelado; sem retenção', async () => {
    const f = await paidOrderWithUnits(0, undefined, 2);
    const outcome = await applyDefault(refundFor(f, { quantity: 2, transactions: [{ amount: '700.00', kind: 'refund', status: 'success' }] }));
    expect(outcome).toMatchObject({ status: 'APPLIED', cancelledVouchers: 0 });
    expect((outcome as { application: { detail: unknown } }).application.detail).toMatchObject({ unissuedAbsorbed: 2 });
    const issued = await issueLater(f, 2);
    expect(issued).toMatchObject({ mode: 'benefits', issuedUnits: 0, heldUnits: 0, vouchersCreated: 0 });
    expect(await vouchersOf(f.orderId)).toHaveLength(0);
    expect((await registryOf(f.orderId)).status).toBe('CONFIRMED');
    expect(await prisma.valePassOrderCancellation.count({ where: { shopifyOrderId: f.orderId } })).toBe(0); // não presume cancelamento integral
    expect(await prisma.valePassIssuanceHold.count({ where: { shopifyOrderId: f.orderId } })).toBe(0);
    expect((await lots.getCapacity(f.campaign.id)).totals).toMatchObject({ pending: 0, consumed: 0 }); // unidades devolvidas não viram falsa pendência
  });

  test('reembolso PARCIAL antes da emissão (1 de 3): a emissão posterior cria só 2 unidades (4 vouchers), todas ATIVAS', async () => {
    const f = await paidOrderWithUnits(0, undefined, 3);
    expect(await applyDefault(refundFor(f, { quantity: 1 }))).toMatchObject({ status: 'APPLIED' });
    expect(await issueLater(f, 3)).toMatchObject({ issuedUnits: 2, vouchersCreated: 4 });
    expect((await vouchersOf(f.orderId)).map((v) => v.status)).toEqual(['ACTIVE', 'ACTIVE', 'ACTIVE', 'ACTIVE']);
    expect((await lots.getCapacity(f.campaign.id)).totals).toMatchObject({ sold: 2, pending: 0, consumed: 2 });
    expect(await issueLater(f, 3)).toMatchObject({ issuedUnits: 0, vouchersCreated: 0 }); // reprocessar não duplica
  });

  test('2 de 3 unidades já emitidas e reembolso de 1: a unidade ainda não emitida é a absorvida — nenhum voucher emitido é tocado', async () => {
    const f = await paidOrderWithUnits(2, undefined, 3);
    const before = await vouchersOf(f.orderId);
    expect(await applyDefault(refundFor(f, { quantity: 1 }))).toMatchObject({ status: 'APPLIED', cancelledVouchers: 0 });
    expect(await vouchersOf(f.orderId)).toEqual(before);
    expect(await issueLater(f, 3)).toMatchObject({ issuedUnits: 0 }); // a 3ª unidade foi a devolvida: não nasce
    expect(await vouchersOf(f.orderId)).toHaveLength(4);
  });

  test('webhook FORA DE ORDEM: o reembolso chega antes de o pedido existir no registro; ao chegar o pedido, a emissão já desconta', async () => {
    const campaign = await newCampaign();
    const orderId = `${TAG}-fora${counter++}`;
    orderIds.push(orderId);
    const f: Fixture = { campaign, orderId, groupIds: [] };
    expect(await applyDefault(refundFor(f, { quantity: 1 }))).toMatchObject({ status: 'APPLIED', cancelledVouchers: 0 });
    await prisma.valePassOrder.create({ data: { shopifyOrderId: orderId, shopifyOrderGid: `gid://shopify/Order/${orderId}`, shopifyOrderName: 'fora', status: 'CONFIRMED', financialStatus: 'paid', quantity: 2, customerName: 'C', customerEmail: 'c@exemplo.invalid', customerPhone: '+5500000000000', lastSyncSource: 'teste', orderCreatedAt: new Date(), statusChangedAt: new Date() } });
    expect(await issueLater(f, 2)).toMatchObject({ issuedUnits: 1, vouchersCreated: 2 });
  });

  test('reembolsos duplicados e simultâneos antes da emissão: contam UMA vez cada; a emissão desconta exatamente o somado', async () => {
    const f = await paidOrderWithUnits(0, undefined, 4);
    const same = refundFor(f, { quantity: 1, id: `${TAG}-dup` });
    const results = await Promise.all([...Array.from({ length: 6 }, () => apply(same, 'ADMIN_CONFIRM')), apply(refundFor(f, { quantity: 1, id: `${TAG}-dup2` }), 'ADMIN_CONFIRM')]);
    expect(results.filter((r) => r.status === 'APPLIED')).toHaveLength(2);
    expect(results.filter((r) => r.status === 'DUPLICATE')).toHaveLength(5);
    expect(await issueLater(f, 4)).toMatchObject({ issuedUnits: 2, vouchersCreated: 4 });
  });

  test('reembolso antes da emissão com valor que não fecha: NÃO se presume nada — a emissão fica em RETENÇÃO administrativa, sem cancelar o pedido', async () => {
    const f = await paidOrderWithUnits(0, undefined, 3);
    const outcome = await applyDefault(refundFor(f, { quantity: 1, subtotal: 100 }));
    expect(outcome).toMatchObject({ status: 'NEEDS_REVIEW' });
    const held = await issueLater(f, 3);
    expect(held).toMatchObject({ mode: 'benefits', issuedUnits: 0, heldUnits: 3, vouchersCreated: 0 });
    const hold = await prisma.valePassIssuanceHold.findFirstOrThrow({ where: { shopifyOrderId: f.orderId, status: 'OPEN' } });
    expect(hold).toMatchObject({ reason: 'FINANCIAL_MISMATCH', units: 3 });
    expect(JSON.stringify(hold.detail)).toContain('REFUND_PENDING_REVIEW');
    expect(await vouchersOf(f.orderId)).toHaveLength(0);
    expect(await prisma.valePassOrderCancellation.count({ where: { shopifyOrderId: f.orderId } })).toBe(0);
    expect((await lots.getCapacity(f.campaign.id)).totals.consumed).toBe(3); // a retenção segue contando como consumida

    // O ADMIN confirma que o reembolso atingiu unidades não emitidas → a emissão posterior desconta 1 e fecha a retenção.
    const { application } = outcome as { application: { id: string } };
    expect(await refunds.resolveReview(application.id, { action: 'CANCEL_ACTIVE_VOUCHERS', note: 'Conferido na Shopify: 1 unidade devolvida' }, { id: adminId, name: ADMIN_NAME })).toMatchObject({ status: 'RESOLVED', vouchersCancelled: 0, unissuedUnitsApplied: 1 });
    expect(await issueLater(f, 3)).toMatchObject({ issuedUnits: 2, vouchersCreated: 4, heldUnits: 0 });
    expect((await prisma.valePassIssuanceHold.findFirstOrThrow({ where: { shopifyOrderId: f.orderId } })).status).toBe('ISSUED');
  });

  test('revisão resolvida com "manter": nada é descontado e a emissão segue completa', async () => {
    const f = await paidOrderWithUnits(0, undefined, 2);
    const { application } = (await applyDefault(refundFor(f, { quantity: 1, subtotal: 100 }))) as { application: { id: string } };
    await refunds.resolveReview(application.id, { action: 'KEEP_VOUCHERS', note: 'Cortesia: reembolso não altera os vouchers' }, { id: adminId, name: ADMIN_NAME });
    expect(await issueLater(f, 2)).toMatchObject({ issuedUnits: 2, vouchersCreated: 4 });
  });

  test('reconciliação: unidade reembolsada antes da emissão não aparece como candidata nem como pendência; regularizar não a emite', async () => {
    const f = await paidOrderWithUnits(1, undefined, 2);
    await applyDefault(refundFor(f, { quantity: 1 }));
    expect((await regularization.findCandidates()).some((c) => c.orderId === f.orderId)).toBe(false);
    const facts = factsFromWebhookPayload({
      id: f.orderId, financial_status: 'paid', cancelled_at: null, currency: 'BRL', presentment_currency: 'BRL', current_total_price: '350.00', total_outstanding: '0.00', total_discounts: '0.00', discount_codes: [], refunds: [],
      total_shipping_price_set: money('0.00'), line_items: [{ variant_id: Number(f.campaign.numericVariant), product_id: null, quantity: 2, current_quantity: 2, price: '350.00', price_set: money('350.00'), discount_allocations: [] }],
    });
    expect(await prisma.$transaction((tx) => regularization.regularize(tx, { orderId: f.orderId, facts }))).toEqual({ status: 'NOTHING_TO_DO' });
    expect(await vouchersOf(f.orderId)).toHaveLength(2);
    expect((await lots.getCapacity(f.campaign.id)).totals).toMatchObject({ pending: 0, consumed: 1 });
  });
});

localDescribe('F3 — política provisória ADMIN_CONFIRM: o sistema não escolhe sozinho a unidade emitida a cancelar', () => {
  test('reembolso de 1 de 3 emitidas: NADA é cancelado; propõe a mais nova; os vouchers propostos ficam bloqueados; os das outras unidades seguem utilizáveis', async () => {
    const f = await paidOrderWithUnits(3);
    const outcome = await applyDefault(refundFor(f, { quantity: 1 }));
    expect(outcome).toMatchObject({ status: 'NEEDS_REVIEW', cancelledVouchers: 0 });
    const application = (outcome as { application: { id: string; reviewReasons: unknown; detail: unknown } }).application;
    expect(application.reviewReasons).toEqual(['UNIT_CONFIRMATION_REQUIRED']);
    expect(application.detail).toMatchObject({ reviewGroupIds: [f.groupIds[2]], unitsNeedingReview: 1 });
    expect(await statusByUnit(f)).toEqual(['ACTIVE+ACTIVE', 'ACTIVE+ACTIVE', 'ACTIVE+ACTIVE']);
    // F2 junto: o voucher proposto está bloqueado; o de outra unidade é aceito
    const rows = await vouchersOf(f.orderId);
    const proposed = rows.find((v) => v.groupId === f.groupIds[2])!;
    const other = rows.find((v) => v.groupId === f.groupIds[0])!;
    await expect(vouchersService.markUsed(proposed.code, adminId, ADMIN_NAME)).rejects.toBeInstanceOf(ConflictException);
    await expect(vouchersService.markUsed(other.code, adminId, ADMIN_NAME)).resolves.toMatchObject({ status: 'USED' });
    // ADMIN confirma a proposta
    expect(await refunds.resolveReview(application.id, { action: 'CANCEL_ACTIVE_VOUCHERS', note: 'Cliente devolveu a unidade mais recente' }, { id: adminId, name: ADMIN_NAME })).toMatchObject({ vouchersCancelled: 2 });
    expect(await statusByUnit(f)).toEqual(['ACTIVE+USED', 'ACTIVE+ACTIVE', 'CANCELLED+CANCELLED']);
  });
});

localDescribe('F2 — voucher de unidade em revisão NEEDS_REVIEW não pode ser resgatado', () => {
  async function underReview() {
    const f = await paidOrderWithUnits(2);
    const { application } = (await applyDefault(refundFor(f, { quantity: 1 }))) as { application: { id: string } };
    const rows = await vouchersOf(f.orderId);
    return { f, application, blocked: rows.filter((v) => v.groupId === f.groupIds[1]), free: rows.filter((v) => v.groupId === f.groupIds[0]) };
  }

  test('os DOIS vouchers da unidade em revisão são recusados com 409 e nada muda; os da outra unidade e de outros pedidos não são afetados', async () => {
    const { f, blocked, free } = await underReview();
    const other = await paidOrderWithUnits(1);
    for (const voucher of blocked) {
      await expect(vouchersService.markUsed(voucher.code, adminId, ADMIN_NAME)).rejects.toMatchObject({ status: 409 });
    }
    expect((await vouchersOf(f.orderId)).filter((v) => v.groupId === f.groupIds[1]).every((v) => v.status === 'ACTIVE' && v.usedAt === null)).toBe(true);
    await expect(vouchersService.markUsed(free[0].code, adminId, ADMIN_NAME)).resolves.toMatchObject({ status: 'USED' });
    await expect(vouchersService.markUsed((await vouchersOf(other.orderId))[0].code, adminId, ADMIN_NAME)).resolves.toMatchObject({ status: 'USED' });
  });

  test('depois da decisão "manter" o resgate volta a funcionar; vouchers antigos (legados, sem unidade) nunca são bloqueados', async () => {
    const { application, blocked, f } = await underReview();
    await refunds.resolveReview(application.id, { action: 'KEEP_VOUCHERS', note: 'Política: reembolso não afeta vouchers' }, { id: adminId, name: ADMIN_NAME });
    await expect(vouchersService.markUsed(blocked[0].code, adminId, ADMIN_NAME)).resolves.toMatchObject({ status: 'USED' });
    const legacy = await prisma.valePass.create({ data: { code: `${TAG}-LEG3`, campaignId: f.campaign.id, amountCents: 35_000, purchasedAt: new Date(), expiresAt: new Date(Date.now() + 86_400_000), shopifyOrderId: f.orderId } });
    await expect(vouchersService.markUsed(legacy.code, adminId, ADMIN_NAME)).resolves.toMatchObject({ status: 'USED' });
  });

  test('trava no BANCO: UPDATE direto para USED do voucher bloqueado falha; de outra unidade e outras mudanças passam', async () => {
    const { blocked, free } = await underReview();
    await expect(prisma.valePass.update({ where: { id: blocked[0].id }, data: { status: 'USED', usedAt: new Date() } })).rejects.toThrow(/vale_pass_use_blocked_refund_review/);
    await expect(prisma.valePass.update({ where: { id: free[0].id }, data: { status: 'USED', usedAt: new Date() } })).resolves.toMatchObject({ status: 'USED' });
    await expect(prisma.valePass.update({ where: { id: blocked[0].id }, data: { status: 'CANCELLED', cancelledAt: new Date(), cancelReason: 'teste' } })).resolves.toMatchObject({ status: 'CANCELLED' }); // cancelar continua possível
  });

  test('CORRIDA resgate × reembolso (política padrão), repetida: o voucher só termina USADO se a revisão enxergou o uso; nunca USADO dentro de uma proposta limpa', async () => {
    for (let round = 0; round < 10; round++) {
      const f = await paidOrderWithUnits(2);
      const newest = (await vouchersOf(f.orderId)).filter((v) => v.groupId === f.groupIds[1]);
      const [usedResult] = await Promise.allSettled([vouchersService.markUsed(newest[0].code, adminId, ADMIN_NAME), applyDefault(refundFor(f, { quantity: 1, id: `${TAG}-c${round}` }))]);
      const application = await prisma.valePassRefundApplication.findFirstOrThrow({ where: { shopifyOrderId: f.orderId } });
      expect(application.status, `rodada ${round}`).toBe('NEEDS_REVIEW');
      const rows = await vouchersOf(f.orderId);
      const used = rows.filter((v) => v.status === 'USED');
      if (usedResult.status === 'rejected') {
        expect((usedResult.reason as { status?: number }).status).toBe(409);
        expect(used).toHaveLength(0);
        expect(application.reviewReasons).toEqual(['UNIT_CONFIRMATION_REQUIRED']);
      } else {
        expect(JSON.stringify(application.reviewReasons), `rodada ${round}`).toContain('USED_VOUCHERS'); // o uso veio antes: a revisão sabe
        expect(used.every((v) => v.cancelledAt === null)).toBe(true);
      }
      expect(rows.every((v) => v.status !== 'CANCELLED')).toBe(true); // nada cancelado automaticamente
      await cleanRows();
    }
  });

  test('unidade com voucher parcialmente usado e unidade totalmente usada: nunca propostas para cancelamento automático; só o ativo restante é cancelado ao confirmar', async () => {
    const f = await paidOrderWithUnits(2);
    const rows = await vouchersOf(f.orderId);
    const unit0 = rows.filter((v) => v.groupId === f.groupIds[0]);
    const unit1 = rows.filter((v) => v.groupId === f.groupIds[1]);
    await vouchersService.markUsed(unit0[0].code, adminId, ADMIN_NAME); // parcialmente usada
    await vouchersService.markUsed(unit1[0].code, adminId, ADMIN_NAME);
    await vouchersService.markUsed(unit1[1].code, adminId, ADMIN_NAME); // totalmente usada
    const outcome = await applyDefault(refundFor(f, { quantity: 2 }));
    expect(outcome).toMatchObject({ status: 'NEEDS_REVIEW', cancelledVouchers: 0 });
    const application = (outcome as { application: { id: string; reviewReasons: unknown } }).application;
    expect(application.reviewReasons).toEqual(['USED_VOUCHERS']);
    const result = await refunds.resolveReview(application.id, { action: 'CANCEL_ACTIVE_VOUCHERS', note: 'Tentativa: cancelar o que sobrou' }, { id: adminId, name: ADMIN_NAME });
    expect(result).toMatchObject({ vouchersCancelled: 1 }); // só o único ativo restante (da unidade parcialmente usada)
    expect((await vouchersOf(f.orderId)).filter((v) => v.status === 'USED')).toHaveLength(3);
  });

  test('"cancelar ativos" quando não sobra voucher ativo: a API informa vouchersCancelled = 0 (a tela exibe aviso de providência operacional)', async () => {
    const f = await paidOrderWithUnits(1);
    const [a, b] = await vouchersOf(f.orderId);
    await vouchersService.markUsed(a.code, adminId, ADMIN_NAME);
    const { application } = (await applyDefault(refundFor(f, { quantity: 1 }))) as { application: { id: string } };
    await prisma.valePass.update({ where: { id: b.id }, data: { status: 'EXPIRED' } });
    expect(await refunds.resolveReview(application.id, { action: 'CANCEL_ACTIVE_VOUCHERS', note: 'Cancelar o que ainda estiver ativo' }, { id: adminId, name: ADMIN_NAME })).toMatchObject({ vouchersCancelled: 0, unissuedUnitsApplied: 0 });
  });
});

// ── Correções pré-integração financeira ────────────────────────────────────────────────────────────────────────────────────────────────────────────

const amountOnly = (f: Fixture, id?: string) => refundFor(f, { id, lines: [], transactions: [{ amount: '100.00', kind: 'refund', status: 'success' }] });
const markUsed = (code: string) => vouchersService.markUsed(code, adminId, ADMIN_NAME);

localDescribe('revisão SEM unidade identificada bloqueia o resgate do pedido todo', () => {
  test('dinheiro devolvido sem unidade: os 4 vouchers do pedido ficam bloqueados (409) e nada é alterado; outro pedido e voucher legado de outro pedido seguem utilizáveis', async () => {
    const f = await paidOrderWithUnits(2);
    const other = await paidOrderWithUnits(1);
    const otherLegacy = await prisma.valePass.create({ data: { code: `${TAG}-LEGX`, campaignId: other.campaign.id, amountCents: 35_000, purchasedAt: new Date(), expiresAt: new Date(Date.now() + 86_400_000), shopifyOrderId: `${TAG}-sem-pedido` } });
    expect(await applyDefault(amountOnly(f))).toMatchObject({ status: 'NEEDS_REVIEW', cancelledVouchers: 0 });
    const before = await vouchersOf(f.orderId);
    expect(before).toHaveLength(4);
    for (const voucher of before) await expect(markUsed(voucher.code)).rejects.toMatchObject({ status: 409 });
    expect(await vouchersOf(f.orderId)).toEqual(before); // saldo/status intactos
    await expect(markUsed((await vouchersOf(other.orderId))[0].code)).resolves.toMatchObject({ status: 'USED' });
    await expect(markUsed(otherLegacy.code)).resolves.toMatchObject({ status: 'USED' });
  });

  test('trava no BANCO: SQL direto também é recusado para qualquer voucher do pedido; a transição para outros estados continua possível', async () => {
    const f = await paidOrderWithUnits(1);
    await applyDefault(amountOnly(f));
    const [a, b] = await vouchersOf(f.orderId);
    await expect(prisma.valePass.update({ where: { id: a.id }, data: { status: 'USED', usedAt: new Date() } })).rejects.toThrow(/vale_pass_use_blocked_refund_review/);
    await expect(prisma.valePass.update({ where: { id: b.id }, data: { status: 'EXPIRED' } })).resolves.toMatchObject({ status: 'EXPIRED' });
  });

  test('após a decisão do ADMIN ("manter"): só os vouchers que continuam elegíveis voltam a ser utilizáveis — cancelado/expirado seguem recusados', async () => {
    const f = await paidOrderWithUnits(2);
    const [u0a, u0b, u1a, u1b] = await vouchersOf(f.orderId);
    await prisma.valePass.update({ where: { id: u1b.id }, data: { status: 'CANCELLED', cancelledAt: new Date(), cancelledBy: adminId, cancelReason: 'admin' } });
    await prisma.valePass.update({ where: { id: u1a.id }, data: { status: 'EXPIRED' } });
    const { application } = (await applyDefault(amountOnly(f))) as { application: { id: string } };
    await expect(markUsed(u0a.code)).rejects.toMatchObject({ status: 409 });
    await refunds.resolveReview(application.id, { action: 'KEEP_VOUCHERS', note: 'Cortesia: valor devolvido não afeta vouchers' }, { id: adminId, name: ADMIN_NAME });
    await expect(markUsed(u0a.code)).resolves.toMatchObject({ status: 'USED' });
    await expect(markUsed(u0b.code)).resolves.toMatchObject({ status: 'USED' });
    await expect(markUsed(u1a.code)).rejects.toMatchObject({ status: 400 }); // expirado
    await expect(markUsed(u1b.code)).rejects.toMatchObject({ status: 400 }); // cancelado
  });

  test('evento fora de ordem: voucher JÁ usado antes da revisão continua usado (nada é desfeito); os demais ficam bloqueados', async () => {
    const f = await paidOrderWithUnits(1);
    const [a, b] = await vouchersOf(f.orderId);
    await markUsed(a.code);
    await applyDefault(amountOnly(f));
    expect((await vouchersOf(f.orderId)).find((v) => v.id === a.id)).toMatchObject({ status: 'USED' });
    await expect(markUsed(b.code)).rejects.toMatchObject({ status: 409 });
  });

  test('CORRIDA resgate × revisão sem unidade (10 rodadas): quem perdeu a corrida é recusado; DEPOIS da revisão aberta nenhum outro voucher do pedido é aceito', async () => {
    for (let round = 0; round < 10; round++) {
      const f = await paidOrderWithUnits(2);
      const rows = await vouchersOf(f.orderId);
      await Promise.allSettled([markUsed(rows[0].code), applyDefault(amountOnly(f, `${TAG}-sw${round}`))]);
      expect(await prisma.valePassRefundApplication.count({ where: { shopifyOrderId: f.orderId, status: 'NEEDS_REVIEW' } }), `rodada ${round}`).toBe(1);
      for (const voucher of rows.slice(1)) await expect(markUsed(voucher.code), `rodada ${round}`).rejects.toMatchObject({ status: 409 });
      await cleanRows();
    }
  });
});

localDescribe('pedido já cancelado pelo fluxo legado: o reembolso não é contado de novo', () => {
  async function legacyCancelled() {
    const f = await paidOrderWithUnits(2);
    await prisma.valePass.updateMany({ where: { shopifyOrderId: f.orderId }, data: { status: 'CANCELLED', cancelledAt: new Date(), cancelReason: 'shopify:orders/cancelled' } });
    await prisma.valePassOrderCancellation.create({ data: { shopifyOrderId: f.orderId, topic: 'orders/cancelled' } as never });
    return f;
  }

  test('registro auditável sem contagem duplicada, sem revisão, sem alterar vouchers nem capacidade; reentrega e paralelo são idempotentes', async () => {
    const f = await legacyCancelled();
    const capacityBefore = (await lots.getCapacity(f.campaign.id)).totals;
    const vouchersBefore = await vouchersOf(f.orderId);
    const payload = refundFor(f, { quantity: 2, id: `${TAG}-leg-1`, transactions: [{ amount: '700.00', kind: 'refund', status: 'success' }] });
    const results = await Promise.all(Array.from({ length: 5 }, () => applyDefault(payload)));
    expect(results.filter((r) => r.status === 'APPLIED')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'DUPLICATE')).toHaveLength(4);
    const row = await prisma.valePassRefundApplication.findUniqueOrThrow({ where: { shopifyRefundId: `${TAG}-leg-1` } });
    expect(row).toMatchObject({ status: 'APPLIED', classification: 'ALREADY_CANCELLED', refundedUnits: 0, transactionsCents: 70000 });
    expect(row.detail).toMatchObject({ reportedRefundedUnits: 2, legacyCancellationTopic: 'orders/cancelled', unitsNeedingReview: 0 });
    expect(await vouchersOf(f.orderId)).toEqual(vouchersBefore);
    expect((await lots.getCapacity(f.campaign.id)).totals).toEqual(capacityBefore);
    expect((await lots.getCapacity(f.campaign.id)).alerts.map((a) => a.code)).not.toContain('REFUND_REVIEW_OPEN');
    expect((await prisma.valePassRefundApplication.aggregate({ where: { shopifyOrderId: f.orderId }, _sum: { refundedUnits: true } }))._sum.refundedUnits).toBe(0);
  });

  test('reembolsos seguintes (frete, outra mercadoria, unidades) no pedido cancelado também só são registrados', async () => {
    const f = await legacyCancelled();
    expect(await applyDefault(refundFor(f, { lines: [], shipping: ['22.00'] }))).toMatchObject({ status: 'APPLIED', cancelledVouchers: 0 });
    expect(await applyDefault(refundFor(f, { quantity: 1 }))).toMatchObject({ status: 'APPLIED', cancelledVouchers: 0 });
    expect(await applyDefault(refundFor(f, { quantity: 5 }))).toMatchObject({ status: 'APPLIED', cancelledVouchers: 0 }); // sem "QUANTITY_EXCEEDS_UNITS"
    expect(await prisma.valePassRefundApplication.count({ where: { shopifyOrderId: f.orderId, status: 'NEEDS_REVIEW' } })).toBe(0);
    expect(await prisma.valePassRefundApplication.count({ where: { shopifyOrderId: f.orderId } })).toBe(3);
  });

  test('SEM o fato de cancelamento, um reembolso parcial NUNCA é tratado como cancelamento integral (mesmo com uma unidade cancelada à mão)', async () => {
    const f = await paidOrderWithUnits(3);
    await prisma.valePass.updateMany({ where: { shopifyOrderId: f.orderId, groupId: f.groupIds[2] }, data: { status: 'CANCELLED', cancelledAt: new Date(), cancelledBy: adminId, cancelReason: 'admin' } });
    const outcome = await applyDefault(refundFor(f, { quantity: 1 }));
    expect(outcome).toMatchObject({ status: 'NEEDS_REVIEW', cancelledVouchers: 0 });
    expect((outcome as { application: { classification: string; refundedUnits: number } }).application).toMatchObject({ classification: 'UNITS', refundedUnits: 1 });
    expect((await vouchersOf(f.orderId)).filter((v) => v.status === 'ACTIVE')).toHaveLength(4); // as duas outras unidades seguem vivas
  });
});

localDescribe('reembolso parcial com unidades emitidas, devolvidas e ainda pagas: pendências e regularização', () => {
  const partial = async () => {
    const f = await paidOrderWithUnits(1, undefined, 3); // 3 pagas, 1 emitida
    await applyDefault(refundFor(f, { quantity: 1 })); // 1 devolvida antes de emitir → sobra 1 elegível
    return f;
  };
  const ambiguousFacts = (f: Fixture) =>
    factsFromWebhookPayload({
      id: f.orderId, financial_status: 'partially_refunded', cancelled_at: null, currency: 'BRL', presentment_currency: 'BRL', current_total_price: '700.00', total_outstanding: '0.00', total_discounts: '0.00', discount_codes: [], refunds: [{ id: 1 }],
      total_shipping_price_set: money('0.00'), line_items: [{ variant_id: Number(f.campaign.numericVariant), product_id: null, quantity: 3, current_quantity: 2, price: '350.00', price_set: money('350.00'), discount_allocations: [] }],
    });

  test('o painel recebe pagas / emitidas / devolvidas antes de emitir / ainda elegíveis, sem dados pessoais', async () => {
    const f = await partial();
    const capacity = await lots.getCapacity(f.campaign.id);
    const row = capacity.paidOrdersWithoutVoucher.find((o) => o.orderId === f.orderId)!;
    expect(row).toMatchObject({ quantity: 3, issued: 1, absorbed: 1, missing: 1 });
    expect(Object.keys(row).sort()).toEqual(['absorbed', 'issued', 'missing', 'orderId', 'orderName', 'quantity']); // sem nome, e-mail ou telefone
    expect(capacity.totals).toMatchObject({ sold: 1, pending: 1, consumed: 2 }); // a elegível ainda consome capacidade; a devolvida não
  });

  test('o validador financeiro considera o pedido ambíguo → retenção (nada é emitido sozinho); a emissão excepcional do ADMIN emite SÓ a unidade elegível', async () => {
    const f = await partial();
    expect(await prisma.$transaction((tx) => regularization.regularize(tx, { orderId: f.orderId, facts: ambiguousFacts(f) }))).toMatchObject({ status: 'HELD', reason: 'FINANCIAL_MISMATCH', missing: 1 });
    expect(await vouchersOf(f.orderId)).toHaveLength(2); // nada novo
    const hold = await prisma.valePassIssuanceHold.findFirstOrThrow({ where: { shopifyOrderId: f.orderId, status: 'OPEN' } });
    expect(hold.units).toBe(1);
    expect((await lots.getCapacity(f.campaign.id)).holds.map((h) => h.id)).toContain(hold.id);
    await issueLater(f, 3, 'override'); // o que a emissão excepcional do ADMIN executa
    const rows = await vouchersOf(f.orderId);
    expect(new Set(rows.map((v) => v.groupId)).size).toBe(2); // 3 pagas − 1 devolvida = 2 unidades
    expect(rows).toHaveLength(4);
    expect(rows.every((v) => v.status === 'ACTIVE')).toBe(true);
    expect((await lots.getCapacity(f.campaign.id)).paidOrdersWithoutVoucher.some((o) => o.orderId === f.orderId)).toBe(false);
  });

  test('4 pagas, 2 emitidas, 2 devolvidas antes de emitir: nenhuma devolvida recebe voucher; um terceiro reembolso passa a exigir confirmação sobre as emitidas', async () => {
    const f = await paidOrderWithUnits(2, undefined, 4); // 4 pagas, 2 emitidas, 2 por emitir
    const first = (await applyDefault(refundFor(f, { quantity: 2 }))) as { application: { id: string; reviewReasons: unknown } };
    expect(first.application.reviewReasons).toEqual([]); // as duas devolvidas absorvem as 2 não emitidas: nada a revisar
    expect(await issueLater(f, 4)).toMatchObject({ issuedUnits: 0, vouchersCreated: 0 });
    const second = (await applyDefault(refundFor(f, { quantity: 1 }))) as { application: { id: string; reviewReasons: unknown } };
    expect(second.application.reviewReasons).toEqual(['UNIT_CONFIRMATION_REQUIRED']); // já não há unidade por emitir: atinge uma emitida → o ADMIN confirma
    expect(await prisma.valePassRefundApplication.findUniqueOrThrow({ where: { id: second.application.id } })).toMatchObject({ status: 'NEEDS_REVIEW' });
  });

  test('webhook repetido depois da decisão do ADMIN não reabre nem altera nada (DUPLICATE); a revisão resolvida libera o pedido', async () => {
    const f = await paidOrderWithUnits(2);
    const payload = amountOnly(f, `${TAG}-redeliver`);
    const { application } = (await applyDefault(payload)) as { application: { id: string } };
    await refunds.resolveReview(application.id, { action: 'KEEP_VOUCHERS', note: 'Conferido: nenhuma unidade afetada' }, { id: adminId, name: ADMIN_NAME });
    expect(await applyDefault(payload)).toMatchObject({ status: 'DUPLICATE' });
    expect((await prisma.valePassRefundApplication.findUniqueOrThrow({ where: { id: application.id } })).status).toBe('RESOLVED');
    await expect(markUsed((await vouchersOf(f.orderId))[0].code)).resolves.toMatchObject({ status: 'USED' });
  });
});
