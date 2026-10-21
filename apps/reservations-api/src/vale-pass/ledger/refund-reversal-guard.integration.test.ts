import { afterAll, afterEach, beforeAll, describe, expect, test } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { ValePass } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { purgeLedgerForTest } from './ledger-test-utils';
import { ValePassLedgerService } from './ledger.service';
import { ValePassRedemptionService, type Actor } from './redemption.service';
import { ValePassWebhookService } from '../vale-pass-webhook.service';
import { ValePassVouchersService } from '../vale-pass-vouchers.service';

/**
 * Reembolso × reversão de resgate (Valle Pass 2027), em PostgreSQL LOCAL descartável. Garante que, depois que o pedido foi reembolsado/cancelado (ou enquanto o
 * reembolso aguarda decisão de um ADMIN), uma reversão de resgate NÃO devolve saldo nem reativa o voucher (USADO → ATIVO). Nenhum reembolso real, nenhuma Shopify.
 */
const localDatabase = /^postgres(?:ql)?:\/\/[^@]+@(localhost|127\.0\.0\.1)(:\d+)?\/[^/]*(test|audit|operational)/i.test(process.env.DATABASE_URL ?? '');
const localDescribe = localDatabase ? describe : describe.skip;

const prisma = new PrismaService();
const redemption = new ValePassRedemptionService(prisma);
const ledger = new ValePassLedgerService(prisma);
const webhook = new ValePassWebhookService();
const vouchers = new ValePassVouchersService(prisma);
const TAG = `VPRV-${Date.now()}`;
let counter = 0;
let admin: Actor;
const campaignIds: string[] = [];
const orderIds: string[] = [];
const REF = 'Nota 900 (teste)';

async function newUnit(): Promise<{ showroom: ValePass; closet: ValePass; orderId: string; groupId: string }> {
  const campaign = await prisma.valePassCampaign.create({
    data: { name: `${TAG}-camp-${counter++}`, amountCents: 35_000, validityDays: 30, shopifyVariantId: `${TAG}-var-${counter++}`, voucherValidFrom: new Date('2026-01-01'), voucherValidUntil: new Date('2027-09-30') },
  });
  campaignIds.push(campaign.id);
  const [b1, b2] = await Promise.all([
    prisma.valePassCampaignBenefit.create({ data: { campaignId: campaign.id, code: 'valle_showroom_500', kind: 'VOUCHER', company: 'VALLE_SHOWROOM', label: 'Voucher Valle Showroom', amountCents: 50_000, sortOrder: 0 } }),
    prisma.valePassCampaignBenefit.create({ data: { campaignId: campaign.id, code: 'vs_by_closet_50', kind: 'VOUCHER', company: 'VS_BY_CLOSET', label: 'Voucher VS BY CLOSET', amountCents: 5_000, sortOrder: 1 } }),
  ]);
  const orderId = `${TAG}-o${counter++}`;
  orderIds.push(orderId);
  const groupId = randomUUID();
  const common = { campaignId: campaign.id, groupId, shopifyOrderId: orderId, shopifyOrderName: '#T4001', status: 'ACTIVE' as const, purchasedAt: new Date(), expiresAt: new Date('2027-10-01T03:00:00Z'), validFrom: new Date('2026-01-01T03:00:00Z'), customerName: 'Cliente Sintético', customerPhone: '+5500000000000' };
  const showroom = await prisma.valePass.create({ data: { ...common, code: `VALLE-${TAG.slice(-4)}-A${counter++}`.toUpperCase(), amountCents: 50_000, company: 'VALLE_SHOWROOM', benefitId: b1.id } });
  const closet = await prisma.valePass.create({ data: { ...common, code: `VALLE-${TAG.slice(-4)}-B${counter++}`.toUpperCase(), amountCents: 5_000, company: 'VS_BY_CLOSET', benefitId: b2.id } });
  return { showroom, closet, orderId, groupId };
}

const row = (id: string) => prisma.valePass.findUniqueOrThrow({ where: { id } });
const entries = (id: string) => prisma.valePassLedgerEntry.findMany({ where: { valePassId: id }, orderBy: { seq: 'asc' } });
const rejection = (promise: Promise<unknown>) => promise.then(() => null, (err: unknown) => err as { status?: number; response?: { code?: string }; message: string });
async function redeem(v: ValePass, amountCents: number) {
  return redemption.confirmRedeem(v.code, { company: v.company as string, amountCents, reference: REF, operationId: `op-${randomUUID()}`, expectedBalanceCents: (await row(v.id)).balanceCents, confirmAmountCents: amountCents }, admin);
}
async function reverse(v: ValePass, entryId: string) {
  const prep = await redemption.prepareReverse(v.code, entryId, admin);
  return { prep, run: () => redemption.confirmReverse(v.code, entryId, { reason: 'reversão de teste (sintética)', operationId: prep.operationId, expectedBalanceCents: prep.expectedBalanceCents, confirmAmountCents: -(prep.entry?.deltaCents ?? 0) }, admin) };
}
const markOrderRefunded = (orderId: string) => prisma.valePassOrderCancellation.create({ data: { shopifyOrderId: orderId, topic: 'refunds/create' } });

async function cleanRows() {
  const ids = campaignIds.splice(0);
  const orders = orderIds.splice(0);
  await prisma.$transaction(async (tx) => {
    const rows = await tx.valePass.findMany({ where: { campaignId: { in: ids } }, select: { id: true } });
    await purgeLedgerForTest(tx, { campaignIds: ids });
    await tx.valePassEvent.deleteMany({ where: { valePassId: { in: rows.map((r) => r.id) } } });
    await tx.adminAuditEvent.deleteMany({ where: { OR: [{ entityId: { in: rows.map((r) => r.id) } }, { adminUserId: admin?.id }] } });
    await tx.valePassRefundApplication.deleteMany({ where: { shopifyOrderId: { in: orders } } });
    await tx.valePassOrderCancellation.deleteMany({ where: { shopifyOrderId: { in: orders } } });
    await tx.valePass.deleteMany({ where: { campaignId: { in: ids } } });
    await tx.valePassCampaignBenefit.deleteMany({ where: { campaignId: { in: ids } } });
    await tx.valePassCampaign.deleteMany({ where: { id: { in: ids } } });
  });
}
beforeAll(async () => {
  if (!localDatabase) return;
  const user = await prisma.adminUser.create({ data: { name: 'Admin Teste Reembolso', phone: `${TAG}-admin`, pinHash: 'x', role: 'ADMIN', active: true } });
  admin = { id: user.id, name: user.name, role: 'ADMIN' };
});
afterEach(async () => {
  if (localDatabase) await cleanRows();
});
afterAll(async () => {
  if (localDatabase) {
    await cleanRows();
    await prisma.adminUser.deleteMany({ where: { id: admin.id } });
  }
  await prisma.$disconnect();
});

localDescribe('reversão de resgate depois do reembolso', () => {
  test('controle: sem reembolso, a reversão de um resgate total continua funcionando (USADO → ATIVO)', async () => {
    const u = await newUnit();
    const used = await redeem(u.closet, 5_000);
    expect(used.status).toBe('USED');
    const r = await reverse(u.closet, used.entry.id);
    expect(r.prep.canReverse).toBe(true);
    await expect(r.run()).resolves.toMatchObject({ status: 'ACTIVE', balanceCents: 5_000 });
  });

  test('pedido reembolsado/cancelado: a reversão é RECUSADA (ORDER_CANCELLED); o voucher usado NÃO volta a ATIVO e o saldo não é devolvido', async () => {
    const u = await newUnit();
    const used = await redeem(u.closet, 5_000);
    await markOrderRefunded(u.orderId);
    const r = await reverse(u.closet, used.entry.id);
    expect(r.prep.canReverse).toBe(false);
    expect(r.prep.problems.map((p) => p.code)).toContain('ORDER_CANCELLED');
    expect((await rejection(r.run()))?.response?.code).toBe('ORDER_CANCELLED');
    expect(await row(u.closet.id)).toMatchObject({ status: 'USED', balanceCents: 0 });
    expect(await entries(u.closet.id)).toHaveLength(1);
    expect(await ledger.reconcile()).toEqual([]);
  });

  test('resgate parcial + pedido reembolsado: a reversão não devolve saldo ao voucher (cancelado ou não), e o histórico fica como está', async () => {
    const u = await newUnit();
    const partial = await redeem(u.showroom, 20_000);
    await markOrderRefunded(u.orderId);
    await prisma.valePass.update({ where: { id: u.showroom.id }, data: { status: 'CANCELLED', cancelledAt: new Date(), cancelReason: 'refunds/create' } }); // o webhook cancela o ativo
    const r = await reverse(u.showroom, partial.entry.id);
    expect(r.prep.canReverse).toBe(false);
    expect((await rejection(r.run()))?.response?.code).toBe('ORDER_CANCELLED');
    expect(await row(u.showroom.id)).toMatchObject({ status: 'CANCELLED', balanceCents: 30_000 });
    expect(await entries(u.showroom.id)).toHaveLength(1);
  });

  test('reembolso aguardando decisão do ADMIN (revisão aberta): a reversão também espera; depois da decisão "manter" volta a ser possível', async () => {
    const u = await newUnit();
    const used = await redeem(u.closet, 5_000);
    const review = await prisma.valePassRefundApplication.create({
      data: { shopifyRefundId: `${TAG}-r${counter++}`, shopifyOrderId: u.orderId, classification: 'UNITS', refundedUnits: 1, status: 'NEEDS_REVIEW', reviewReasons: ['UNIT_CONFIRMATION_REQUIRED'], detail: { reviewGroupIds: [u.groupId] } },
    });
    const blocked = await reverse(u.closet, used.entry.id);
    expect(blocked.prep.problems.map((p) => p.code)).toContain('REFUND_UNDER_REVIEW');
    expect((await rejection(blocked.run()))?.response?.code).toBe('REFUND_UNDER_REVIEW');
    expect((await row(u.closet.id)).status).toBe('USED');
    await prisma.valePassRefundApplication.update({ where: { id: review.id }, data: { status: 'RESOLVED', resolution: 'KEEP_VOUCHERS', resolvedAt: new Date(), resolvedBy: admin.id, resolutionNote: 'decisão de teste (sintética)' } });
    const free = await reverse(u.closet, used.entry.id);
    expect(free.prep.canReverse).toBe(true);
    await expect(free.run()).resolves.toMatchObject({ status: 'ACTIVE', balanceCents: 5_000 });
  });

  test('revisão de OUTRA unidade do mesmo pedido não bloqueia a reversão desta (só as unidades propostas)', async () => {
    const u = await newUnit();
    const used = await redeem(u.closet, 5_000);
    await prisma.valePassRefundApplication.create({
      data: { shopifyRefundId: `${TAG}-r${counter++}`, shopifyOrderId: u.orderId, classification: 'UNITS', refundedUnits: 1, status: 'NEEDS_REVIEW', reviewReasons: ['UNIT_CONFIRMATION_REQUIRED'], detail: { reviewGroupIds: [randomUUID()] } },
    });
    const r = await reverse(u.closet, used.entry.id);
    expect(r.prep.canReverse).toBe(true);
  });
});

localDescribe('cancelamento/reembolso do pedido pela Shopify com crédito parcialmente utilizado (comportamento ATUAL, documentado)', () => {
  test('o voucher ativo (mesmo parcialmente usado) é cancelado e nunca mais utilizável; saldo e histórico ficam como estavam; reversão e restauração são recusadas; nada some', async () => {
    const u = await newUnit();
    const partial = await redeem(u.showroom, 20_000); // R$ 200 usados da Valle Showroom
    const used = await redeem(u.closet, 5_000); // VS BY CLOSET usado por inteiro
    await prisma.$transaction((tx) => webhook.handleOrderCancelledOrRefunded(tx, u.orderId, 'refunds/create'));

    // o ativo parcialmente usado é cancelado (o saldo restante fica CONGELADO como fato do histórico); o usado por inteiro continua usado
    expect(await row(u.showroom.id)).toMatchObject({ status: 'CANCELLED', balanceCents: 30_000, cancelReason: 'refunds/create' });
    expect(await row(u.closet.id)).toMatchObject({ status: 'USED', balanceCents: 0 });
    expect(await entries(u.showroom.id)).toHaveLength(1);
    expect(await entries(u.closet.id)).toHaveLength(1);
    expect(await ledger.reconcile()).toEqual([]);

    // nenhum caminho devolve o uso: resgate, reversão e restauração
    expect((await rejection(redeem(u.showroom, 1_000)))?.response?.code).toBe('CANCELLED');
    expect((await rejection((await reverse(u.showroom, partial.entry.id)).run()))?.response?.code).toBe('ORDER_CANCELLED');
    expect((await rejection((await reverse(u.closet, used.entry.id)).run()))?.response?.code).toBe('ORDER_CANCELLED');
    await expect(vouchers.restore(u.showroom.code, 'tentativa de restaurar (teste)', admin.id, admin.name)).rejects.toThrow();
    expect((await row(u.showroom.id)).status).toBe('CANCELLED');
    expect(await prisma.valePassOrderCancellation.count({ where: { shopifyOrderId: u.orderId } })).toBe(1);

    // idempotência: o mesmo aviso de novo não muda nada
    await prisma.$transaction((tx) => webhook.handleOrderCancelledOrRefunded(tx, u.orderId, 'refunds/create'));
    expect(await row(u.showroom.id)).toMatchObject({ status: 'CANCELLED', balanceCents: 30_000 });
    expect(await ledger.reconcile()).toEqual([]);
  });
});
