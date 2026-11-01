import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service';
import { ValePassLotsService } from './vale-pass-lots.service';

/**
 * Alerta de invariante ACTIVE_VOUCHERS_ORDER_NOT_PAID (somente leitura, sem dado pessoal), em PostgreSQL LOCAL descartável: voucher ativo cujo pedido
 * está cancelado/expirado/pendente nunca deveria existir. Pedido confirmado e pedido REFUNDED (decisão do ADMIN, outro alerta) não disparam.
 */
const localDatabase = /^postgres(?:ql)?:\/\/[^@]+@(localhost|127\.0\.0\.1)(:\d+)?\/[^/]*(test|audit|operational)/i.test(process.env.DATABASE_URL ?? '');
const localDescribe = localDatabase ? describe : describe.skip;

const prisma = new PrismaService();
const lots = new ValePassLotsService(prisma);
const TAG = `VPAU-${Date.now()}`;
let counter = 0;
const campaignIds: string[] = [];
const orderIds: string[] = [];

async function scenario(orderStatus: 'CONFIRMED' | 'CANCELLED' | 'EXPIRED' | 'PENDING' | 'REFUNDED' | null, over: { cancellationRow?: boolean; voucherStatus?: 'ACTIVE' | 'CANCELLED' } = {}) {
  const n = counter++;
  const campaign = await prisma.valePassCampaign.create({ data: { name: `${TAG}-c${n}`, amountCents: 35_000, validityDays: 30, globalLimit: 1_000, shopifyVariantId: `${TAG}-v${n}`, voucherValidFrom: new Date('2026-01-01'), voucherValidUntil: new Date('2027-09-30') } });
  campaignIds.push(campaign.id);
  const benefit = await prisma.valePassCampaignBenefit.create({ data: { campaignId: campaign.id, code: 'vs_by_closet_50', kind: 'VOUCHER', company: 'VS_BY_CLOSET', label: 'Voucher VS BY CLOSET', amountCents: 5_000, sortOrder: 0 } });
  const orderId = `${TAG}-o${n}`;
  orderIds.push(orderId);
  if (orderStatus) await prisma.valePassOrder.create({ data: { shopifyOrderId: orderId, status: orderStatus, quantity: 1, lastSyncSource: 'teste' } });
  if (over.cancellationRow) await prisma.valePassOrderCancellation.create({ data: { shopifyOrderId: orderId, topic: 'orders/cancelled' } });
  await prisma.valePass.create({
    data: {
      campaignId: campaign.id, code: `VALLE-${TAG.slice(-4)}-U${n}`.toUpperCase(), amountCents: 5_000, status: over.voucherStatus ?? 'ACTIVE', company: 'VS_BY_CLOSET', groupId: randomUUID(), benefitId: benefit.id,
      shopifyOrderId: orderId, purchasedAt: new Date(), expiresAt: new Date('2027-10-01T03:00:00Z'), validFrom: new Date('2026-01-01T03:00:00Z'),
      ...(over.voucherStatus === 'CANCELLED' ? { cancelledAt: new Date() } : {}),
    },
  });
  return campaign.id;
}
const alertOf = async (campaignId: string) => (await lots.getCapacity(campaignId)).alerts.find((a) => a.code === 'ACTIVE_VOUCHERS_ORDER_NOT_PAID');

afterAll(async () => {
  if (localDatabase) {
    await prisma.valePassEvent.deleteMany({ where: { valePass: { campaignId: { in: campaignIds } } } });
    await prisma.valePass.deleteMany({ where: { campaignId: { in: campaignIds } } });
    await prisma.valePassOrderCancellation.deleteMany({ where: { shopifyOrderId: { in: orderIds } } });
    await prisma.valePassOrder.deleteMany({ where: { shopifyOrderId: { in: orderIds } } });
    await prisma.valePassCampaignBenefit.deleteMany({ where: { campaignId: { in: campaignIds } } });
    await prisma.valePassCampaign.deleteMany({ where: { id: { in: campaignIds } } });
  }
  await prisma.$disconnect();
});
beforeAll(() => undefined);

localDescribe('alerta: voucher ativo com pedido não pago', () => {
  test.each([['CANCELLED'], ['EXPIRED'], ['PENDING']] as const)('pedido %s com voucher ATIVO → alerta crítico, sem dado pessoal nem código', async (status) => {
    const id = await scenario(status);
    const a = await alertOf(id);
    expect(a).toMatchObject({ severity: 'critical' });
    expect(a?.message).toContain('1 voucher(s) ATIVO(S) de 1 pedido(s)');
    expect(JSON.stringify(a)).not.toMatch(/VALLE-[A-Z0-9]{4}-/);
  });

  test('cancelamento confirmado na tabela de cancelamentos também dispara, mesmo com o registro do pedido ainda CONFIRMED', async () => {
    expect(await alertOf(await scenario('CONFIRMED', { cancellationRow: true }))).toBeDefined();
  });

  test('pedido CONFIRMED saudável, pedido REFUNDED (revisão do ADMIN), voucher já CANCELADO e voucher sem registro de pedido NÃO disparam', async () => {
    expect(await alertOf(await scenario('CONFIRMED'))).toBeUndefined();
    expect(await alertOf(await scenario('REFUNDED'))).toBeUndefined();
    expect(await alertOf(await scenario('CANCELLED', { voucherStatus: 'CANCELLED' }))).toBeUndefined();
    expect(await alertOf(await scenario(null))).toBeUndefined();
  });
});
