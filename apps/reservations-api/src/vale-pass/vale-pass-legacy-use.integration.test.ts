import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { BadRequestException, ConflictException, ForbiddenException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { ValePassVouchersService } from './vale-pass-vouchers.service';

/**
 * Caminho antigo de "marcar como utilizado" (voucher SEM empresa, modelo anterior ao Valle Pass 2027), em PostgreSQL LOCAL descartável.
 * Sem saldo nem livro-razão, ele não pode virar atalho: só administrador, só ACTIVE e dentro da validade, uma única vez, com auditoria.
 */
const localDatabase = /^postgres(?:ql)?:\/\/[^@]+@(localhost|127\.0\.0\.1)(:\d+)?\/[^/]*(test|audit|operational)/i.test(process.env.DATABASE_URL ?? '');
const localDescribe = localDatabase ? describe : describe.skip;

const prisma = new PrismaService();
const service = new ValePassVouchersService(prisma);
const TAG = `VPLG-${Date.now()}`;
let counter = 0;
let campaignId = '';
const admin = { id: '', name: 'Administrador Teste', role: 'ADMIN' as const };
const staff = { id: '', name: 'Funcionário Teste', role: 'STAFF' as const };

async function legacy(over: { status?: 'ACTIVE' | 'CANCELLED' | 'EXPIRED'; validFrom?: Date | null; expiresAt?: Date } = {}) {
  const n = counter++;
  return prisma.valePass.create({
    data: {
      campaignId,
      code: `VALLE-${TAG.slice(-4)}-L${n}`.toUpperCase(),
      amountCents: 35_000,
      status: over.status ?? 'ACTIVE',
      purchasedAt: new Date(),
      expiresAt: over.expiresAt ?? new Date('2099-01-01T00:00:00Z'),
      validFrom: over.validFrom === undefined ? null : over.validFrom,
      shopifyOrderId: `${TAG}-o${n}`,
    },
  });
}
const reload = (id: string) => prisma.valePass.findUniqueOrThrow({ where: { id } });
const use = (code: string, actor: { id: string; name: string; role: 'ADMIN' | 'STAFF' }) => service.markUsed(code, actor.id, actor.name, { role: actor.role, requireIdentity: true, identityChecked: false });

beforeAll(async () => {
  if (!localDatabase) return;
  admin.id = (await prisma.adminUser.create({ data: { name: admin.name, phone: `${TAG}-admin`, pinHash: 'x', role: 'ADMIN', active: true } })).id;
  staff.id = (await prisma.adminUser.create({ data: { name: staff.name, phone: `${TAG}-staff`, pinHash: 'x', role: 'STAFF', active: true } })).id;
  campaignId = (await prisma.valePassCampaign.create({ data: { name: `${TAG}-camp`, amountCents: 35_000, validityDays: 30, shopifyVariantId: `${TAG}-var`, voucherValidFrom: new Date('2026-01-01'), voucherValidUntil: new Date('2027-09-30') } })).id;
});
afterAll(async () => {
  if (localDatabase) {
    const ids = (await prisma.valePass.findMany({ where: { campaignId }, select: { id: true } })).map((v) => v.id);
    await prisma.adminAuditEvent.deleteMany({ where: { OR: [{ entityId: { in: ids } }, { adminUserId: { in: [admin.id, staff.id] } }] } });
    await prisma.valePassEvent.deleteMany({ where: { valePassId: { in: ids } } });
    await prisma.valePass.deleteMany({ where: { campaignId } });
    await prisma.valePassCampaign.deleteMany({ where: { id: campaignId } });
    await prisma.adminUser.deleteMany({ where: { id: { in: [admin.id, staff.id] } } });
  }
  await prisma.$disconnect();
});

localDescribe('caminho legado: marcar como utilizado voucher sem empresa', () => {
  test('STAFF é recusado (403) e o voucher continua ACTIVE, sem evento nem auditoria', async () => {
    const v = await legacy();
    await expect(use(v.code, staff)).rejects.toBeInstanceOf(ForbiddenException);
    expect((await reload(v.id)).status).toBe('ACTIVE');
    expect(await prisma.valePassEvent.count({ where: { valePassId: v.id, type: 'USED' } })).toBe(0);
    expect(await prisma.adminAuditEvent.count({ where: { entityId: v.id } })).toBe(0);
  });

  test('ADMIN marca como utilizado: USED, evento e auditoria com a marca de voucher sem empresa e o papel, sem o código completo', async () => {
    const v = await legacy();
    const done = await use(v.code, admin);
    expect(done.status).toBe('USED');
    const audit = await prisma.adminAuditEvent.findMany({ where: { entityId: v.id } });
    expect(audit).toHaveLength(1);
    expect(audit[0].action).toBe('VALE_PASS_MARKED_USED');
    expect(audit[0].detail).toMatchObject({ legacyNoCompany: true, role: 'ADMIN' });
    expect(JSON.stringify(audit[0])).not.toContain(v.code);
  });

  test('não se usa duas vezes: o segundo pedido é recusado e nada é regravado', async () => {
    const v = await legacy();
    await use(v.code, admin);
    await expect(use(v.code, admin)).rejects.toBeInstanceOf(BadRequestException);
    expect(await prisma.valePassEvent.count({ where: { valePassId: v.id, type: 'USED' } })).toBe(1);
  });

  test('dois pedidos simultâneos: exatamente um grava USED', async () => {
    const v = await legacy();
    const results = await Promise.allSettled([use(v.code, admin), use(v.code, admin), use(v.code, admin)]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(await prisma.valePassEvent.count({ where: { valePassId: v.id, type: 'USED' } })).toBe(1);
    expect((await reload(v.id)).status).toBe('USED');
  });

  test.each([['CANCELLED'], ['EXPIRED']] as const)('voucher %s não pode ser marcado como utilizado', async (status) => {
    const v = await legacy({ status });
    await expect(use(v.code, admin)).rejects.toBeInstanceOf(BadRequestException);
    expect((await reload(v.id)).status).toBe(status);
  });

  test('antes do início da validade é recusado', async () => {
    const v = await legacy({ validFrom: new Date(Date.now() + 86_400_000) });
    await expect(use(v.code, admin)).rejects.toBeInstanceOf(BadRequestException);
    expect((await reload(v.id)).status).toBe('ACTIVE');
  });

  test('pedido Shopify cancelado/reembolsado impede o uso', async () => {
    const v = await legacy();
    await prisma.valePassOrderCancellation.create({ data: { shopifyOrderId: v.shopifyOrderId as string, topic: 'orders/cancelled' } });
    try {
      await expect(use(v.code, admin)).rejects.toBeInstanceOf(ConflictException);
      expect((await reload(v.id)).status).toBe('ACTIVE');
    } finally {
      await prisma.valePassOrderCancellation.deleteMany({ where: { shopifyOrderId: v.shopifyOrderId as string } });
    }
  });
});
