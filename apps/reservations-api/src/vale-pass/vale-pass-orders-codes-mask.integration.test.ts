import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { AdminRole } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { ValePassOrdersController } from './vale-pass-orders.controller';
import { ValePassOrdersService } from './vale-pass-orders.service';
import { ValePassWebhookService } from './vale-pass-webhook.service';

/**
 * Lista de pedidos (`GET /admin/vale-pass/orders`): o código completo dos vouchers só vai para ADMIN/SUPER_ADMIN; os demais perfis recebem o código mascarado
 * NA RESPOSTA DA API (não só no front). Em PostgreSQL LOCAL descartável. O formato dos objetos não muda.
 */
const localDatabase = /^postgres(?:ql)?:\/\/[^@]+@(localhost|127\.0\.0\.1)(:\d+)?\/[^/]*(test|audit|operational)/i.test(process.env.DATABASE_URL ?? '');
const localDescribe = localDatabase ? describe : describe.skip;

const prisma = new PrismaService();
// A listagem não usa a Admin API da Shopify.
const controller = new ValePassOrdersController(new ValePassOrdersService(prisma, {} as never, new ValePassWebhookService()));
const TAG = `VPOM-${Date.now()}`;
let campaignId = '';
const fullCodes: string[] = [];
let multiOrderId = '';
let emptyOrderId = '';

const asRole = (role: AdminRole) => ({ adminUser: { id: `${TAG}-${role}`, name: 'Teste', role } });
const MASKED = /^VALLE-[A-Z0-9]{4}-\*{4}$/;

async function seedOrder(units: number): Promise<{ orderId: string; codes: string[] }> {
  const orderId = `${TAG}-o${Math.random().toString(36).slice(2, 8)}`;
  await prisma.valePassOrder.create({
    data: { shopifyOrderId: orderId, shopifyOrderName: `${TAG}#`, status: 'CONFIRMED', financialStatus: 'paid', quantity: units, customerName: 'Maria da Silva', customerEmail: 'maria.silva@exemplo.invalid', customerPhone: '+5587999990000', lastSyncSource: 'teste' },
  });
  const benefits = await prisma.valePassCampaignBenefit.findMany({ where: { campaignId }, orderBy: { sortOrder: 'asc' } });
  const codes: string[] = [];
  for (let unit = 0; unit < units; unit++) {
    const groupId = randomUUID();
    for (const benefit of benefits) {
      const code = `VALLE-${TAG.slice(-3).toUpperCase().replace(/[^A-Z0-9]/g, '0')}${unit}-${benefit.sortOrder}${Math.random().toString(36).slice(2, 5).toUpperCase().replace(/[^A-Z0-9]/g, '0')}`;
      await prisma.valePass.create({
        data: { campaignId, code, amountCents: benefit.amountCents ?? 5_000, status: 'ACTIVE', company: benefit.company, groupId, benefitId: benefit.id, shopifyOrderId: orderId, purchasedAt: new Date(), expiresAt: new Date('2027-10-01T03:00:00Z'), validFrom: new Date('2026-01-01T03:00:00Z') },
      });
      codes.push(code);
    }
  }
  return { orderId, codes };
}

beforeAll(async () => {
  if (!localDatabase) return;
  campaignId = (await prisma.valePassCampaign.create({ data: { name: `${TAG}-camp`, amountCents: 35_000, validityDays: 30, shopifyVariantId: `${TAG}-var`, voucherValidFrom: new Date('2026-01-01'), voucherValidUntil: new Date('2027-09-30') } })).id;
  await prisma.valePassCampaignBenefit.createMany({
    data: [
      { campaignId, code: 'valle_showroom_500', kind: 'VOUCHER', company: 'VALLE_SHOWROOM', label: 'Voucher Valle Showroom', amountCents: 50_000, sortOrder: 0 },
      { campaignId, code: 'vs_by_closet_50', kind: 'VOUCHER', company: 'VS_BY_CLOSET', label: 'Voucher VS BY CLOSET', amountCents: 5_000, sortOrder: 1 },
    ],
  });
  const multi = await seedOrder(2); // 4 vouchers
  multiOrderId = multi.orderId;
  fullCodes.push(...multi.codes);
  const single = await seedOrder(1); // 2 vouchers
  fullCodes.push(...single.codes);
  emptyOrderId = `${TAG}-vazio`;
  await prisma.valePassOrder.create({ data: { shopifyOrderId: emptyOrderId, shopifyOrderName: `${TAG}#`, status: 'PENDING', financialStatus: 'pending', quantity: 1, lastSyncSource: 'teste' } });
});
afterAll(async () => {
  if (localDatabase) {
    await prisma.valePassEvent.deleteMany({ where: { valePass: { campaignId } } });
    await prisma.valePass.deleteMany({ where: { campaignId } });
    await prisma.valePassCampaignBenefit.deleteMany({ where: { campaignId } });
    await prisma.valePassCampaign.deleteMany({ where: { id: campaignId } });
    await prisma.valePassOrderEvent.deleteMany({ where: { order: { shopifyOrderId: { startsWith: TAG } } } });
    await prisma.valePassOrder.deleteMany({ where: { shopifyOrderId: { startsWith: TAG } } });
  }
  await prisma.$disconnect();
});

localDescribe('lista de pedidos: código dos vouchers mascarado para quem não é administrador', () => {
  const mine = (rows: Awaited<ReturnType<typeof controller.list>>) => rows.filter((row) => row.shopifyOrderId.startsWith(TAG));

  test('STAFF: todos os vouchers de pedidos com várias unidades saem mascarados; nenhum código completo aparece na resposta serializada', async () => {
    const rows = mine(await controller.list(asRole('STAFF')));
    expect(rows).toHaveLength(3);
    const multi = rows.find((row) => row.shopifyOrderId === multiOrderId)!;
    expect(multi.vouchers).toHaveLength(4);
    for (const voucher of multi.vouchers) expect(voucher.code).toMatch(MASKED);
    for (const code of fullCodes) expect(JSON.stringify(rows)).not.toContain(code);
    // Pedido sem voucher segue com lista vazia.
    expect(rows.find((row) => row.shopifyOrderId === emptyOrderId)!.vouchers).toEqual([]);
  });

  test('STAFF: o formato é o mesmo (mesmas chaves em pedido e em voucher; status preservado); só o valor do código muda', async () => {
    const forStaff = mine(await controller.list(asRole('STAFF')));
    const forAdmin = mine(await controller.list(asRole('ADMIN')));
    for (const row of forStaff) {
      const original = forAdmin.find((other) => other.shopifyOrderId === row.shopifyOrderId)!;
      expect(Object.keys(row).sort()).toEqual(Object.keys(original).sort());
      expect(row.vouchers.map((v) => v.status)).toEqual(original.vouchers.map((v) => v.status));
      row.vouchers.forEach((voucher) => expect(Object.keys(voucher).sort()).toEqual(['code', 'status']));
    }
    // Dados do cliente continuam mascarados como antes.
    expect(JSON.stringify(forStaff)).not.toContain('maria.silva@exemplo.invalid');
  });

  test.each(['ADMIN', 'SUPER_ADMIN'] as const)('%s continua recebendo os códigos completos, idênticos à listagem do serviço', async (role) => {
    const rows = mine(await controller.list(asRole(role)));
    const multi = rows.find((row) => row.shopifyOrderId === multiOrderId)!;
    expect(multi.vouchers.map((v) => v.code).sort()).toEqual(fullCodes.filter((code) => multi.vouchers.some((v) => v.code === code)).sort());
    expect(multi.vouchers).toHaveLength(4);
    expect(rows.flatMap((row) => row.vouchers.map((v) => v.code)).sort()).toEqual([...fullCodes].sort());
    expect(multi.customerEmail).toBe('maria.silva@exemplo.invalid');
  });

  test('a máscara é feita no servidor: a lista crua do serviço traz o código completo e só o controlador a aplica (nenhum outro endpoint de pedidos devolve código)', async () => {
    const raw = mine(await new ValePassOrdersService(prisma, {} as never, new ValePassWebhookService()).list());
    expect(raw.flatMap((row) => row.vouchers.map((v) => v.code)).sort()).toEqual([...fullCodes].sort());
    const attention = await controller.attention();
    expect(Object.keys(attention)).toEqual(['count']);
  });
});
