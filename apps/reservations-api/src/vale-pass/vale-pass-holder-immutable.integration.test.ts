import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Titular do voucher imutável depois de definido (migration 20261101100000), em PostgreSQL LOCAL descartável.
 * O gatilho é a última rede: mesmo um UPDATE direto no banco não reescreve nome, e-mail ou telefone já gravados.
 */
const localDatabase = /^postgres(?:ql)?:\/\/[^@]+@(localhost|127\.0\.0\.1)(:\d+)?\/[^/]*(test|audit|operational)/i.test(process.env.DATABASE_URL ?? '');
const localDescribe = localDatabase ? describe : describe.skip;

const prisma = new PrismaService();
const TAG = `VPHD-${Date.now()}`;
let counter = 0;
let campaignId = '';
let benefitId = '';

async function voucher(over: { name?: string | null; email?: string | null; phone?: string | null } = {}) {
  const n = counter++;
  return prisma.valePass.create({
    data: {
      campaignId,
      code: `VALLE-${TAG.slice(-4)}-H${n}`.toUpperCase(),
      amountCents: 5_000,
      status: 'ACTIVE',
      company: 'VS_BY_CLOSET',
      groupId: randomUUID(),
      benefitId,
      shopifyOrderId: `${TAG}-o${n}`,
      purchasedAt: new Date(),
      expiresAt: new Date('2027-10-01T03:00:00Z'),
      validFrom: new Date('2026-01-01T03:00:00Z'),
      customerName: over.name === undefined ? 'Maria da Silva' : over.name,
      customerEmail: over.email === undefined ? 'maria@exemplo.invalid' : over.email,
      customerPhone: over.phone === undefined ? '+5521999990000' : over.phone,
    },
  });
}
const reload = (id: string) => prisma.valePass.findUniqueOrThrow({ where: { id } });

beforeAll(async () => {
  if (!localDatabase) return;
  const c = await prisma.valePassCampaign.create({ data: { name: `${TAG}-camp`, amountCents: 35_000, validityDays: 30, shopifyVariantId: `${TAG}-var`, voucherValidFrom: new Date('2026-01-01'), voucherValidUntil: new Date('2027-09-30') } });
  campaignId = c.id;
  const b = await prisma.valePassCampaignBenefit.create({ data: { campaignId, code: 'vs_by_closet_50', kind: 'VOUCHER', company: 'VS_BY_CLOSET', label: 'Voucher VS BY CLOSET', amountCents: 5_000, sortOrder: 0 } });
  benefitId = b.id;
});
afterAll(async () => {
  if (localDatabase) {
    await prisma.valePassEvent.deleteMany({ where: { valePass: { campaignId } } });
    await prisma.valePass.deleteMany({ where: { campaignId } });
    await prisma.valePassCampaignBenefit.deleteMany({ where: { campaignId } });
    await prisma.valePassCampaign.deleteMany({ where: { id: campaignId } });
  }
  await prisma.$disconnect();
});

localDescribe('titular imutável (gatilho vale_passes_holder_guard)', () => {
  test.each([
    ['nome', { customerName: 'Outra Pessoa' }],
    ['e-mail', { customerEmail: 'outra@exemplo.invalid' }],
    ['telefone', { customerPhone: '+5521988880000' }],
  ])('trocar o %s de um voucher emitido é recusado e nada muda', async (_label, data) => {
    const v = await voucher();
    await expect(prisma.valePass.update({ where: { id: v.id }, data })).rejects.toThrow(/vale_pass_holder_immutable/);
    const after = await reload(v.id);
    expect([after.customerName, after.customerEmail, after.customerPhone]).toEqual([v.customerName, v.customerEmail, v.customerPhone]);
  });

  test.each([['customerName'], ['customerEmail'], ['customerPhone']])('apagar %s (virar NULL) também é recusado', async (field) => {
    const v = await voucher();
    await expect(prisma.valePass.update({ where: { id: v.id }, data: { [field]: null } })).rejects.toThrow(/vale_pass_holder_immutable/);
  });

  test('UPDATE direto por SQL (fora do Prisma) também é recusado', async () => {
    const v = await voucher();
    await expect(prisma.$executeRaw`UPDATE vale_passes SET customer_email = 'x@exemplo.invalid' WHERE id = ${v.id}::uuid`).rejects.toThrow(/vale_pass_holder_immutable/);
    expect((await reload(v.id)).customerEmail).toBe('maria@exemplo.invalid');
  });

  test('regravar o MESMO valor é aceito (sem mudança real)', async () => {
    const v = await voucher();
    await prisma.valePass.update({ where: { id: v.id }, data: { customerName: v.customerName, customerEmail: v.customerEmail } });
    expect((await reload(v.id)).customerName).toBe('Maria da Silva');
  });

  test('campo vazio pode ser preenchido uma vez; depois fica fixo', async () => {
    const v = await voucher({ phone: null });
    await prisma.valePass.update({ where: { id: v.id }, data: { customerPhone: '+5521977770000' } });
    expect((await reload(v.id)).customerPhone).toBe('+5521977770000');
    await expect(prisma.valePass.update({ where: { id: v.id }, data: { customerPhone: '+5521966660000' } })).rejects.toThrow(/vale_pass_holder_immutable/);
  });

  test('operações normais (uso, cancelamento, expiração) continuam funcionando e não tocam o titular', async () => {
    const v = await voucher();
    await prisma.valePass.update({ where: { id: v.id }, data: { status: 'CANCELLED', cancelledAt: new Date() } });
    const after = await reload(v.id);
    expect(after.status).toBe('CANCELLED');
    expect([after.customerName, after.customerEmail, after.customerPhone]).toEqual(['Maria da Silva', 'maria@exemplo.invalid', '+5521999990000']);
  });

  test('voucher sem nenhum dado do titular segue emitido e cancelável', async () => {
    const v = await voucher({ name: null, email: null, phone: null });
    const after = await prisma.valePass.update({ where: { id: v.id }, data: { status: 'EXPIRED' } });
    expect(after.customerEmail).toBeNull();
  });

  test('o registro do pedido (outra tabela) segue editável e NÃO reescreve o voucher', async () => {
    const v = await voucher();
    await prisma.valePassOrder.create({ data: { shopifyOrderId: v.shopifyOrderId as string, status: 'CONFIRMED', quantity: 1, lastSyncSource: 'teste', customerEmail: 'antigo@exemplo.invalid' } });
    try {
      await prisma.valePassOrder.update({ where: { shopifyOrderId: v.shopifyOrderId as string }, data: { customerEmail: 'novo@exemplo.invalid' } });
      expect((await reload(v.id)).customerEmail).toBe('maria@exemplo.invalid');
    } finally {
      await prisma.valePassOrder.deleteMany({ where: { shopifyOrderId: v.shopifyOrderId as string } });
    }
  });
});
