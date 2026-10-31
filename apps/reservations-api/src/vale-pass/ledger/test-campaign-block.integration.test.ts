import { afterAll, afterEach, beforeAll, describe, expect, test } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { ValePass } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { ValePassVouchersService } from '../vale-pass-vouchers.service';
import { ValePassRedemptionService, type Actor } from './redemption.service';
import { ValePassOperatorScopeService } from './operator-scope.service';
import { ValePassLedgerService } from './ledger.service';
import { grantAllCompaniesForTest, purgeLedgerForTest } from './ledger-test-utils';
import { TEST_CAMPAIGN_ID, TEST_CAMPAIGN_VARIANT_ID } from '../vale-pass-test-campaign';

/**
 * Vouchers da campanha de TESTE nunca funcionam como crédito comercial: o resgate é recusado no servidor para ADMIN, SUPER_ADMIN e STAFF vinculado (prévia, confirmação
 * e o "marcar como utilizado" legado), a campanha é identificada pelo ID e/ou Variant ID (nunca por nome, preço ou rótulo), a OFICIAL segue resgatando normalmente e o
 * cancelamento continua permitido. PostgreSQL LOCAL descartável; nenhum dado real.
 */
const localDatabase = /^postgres(?:ql)?:\/\/[^@]+@(localhost|127\.0\.0\.1)(:\d+)?\/[^/]*(test|audit|operational)/i.test(process.env.DATABASE_URL ?? '');
const localDescribe = localDatabase ? describe : describe.skip;

const prisma = new PrismaService();
const redemption = new ValePassRedemptionService(prisma);
const scopes = new ValePassOperatorScopeService(prisma);
const vouchersService = new ValePassVouchersService(prisma);
const ledger = new ValePassLedgerService(prisma);
const TAG = `VPTC-${Date.now()}`;
let counter = 0;
const campaignIds: string[] = [];
const orderIds: string[] = [];
const userIds: string[] = [];
const REF = 'Nota teste (sintética)';

async function newUser(role: 'SUPER_ADMIN' | 'ADMIN' | 'STAFF'): Promise<Actor> {
  const row = await prisma.adminUser.create({ data: { name: `${role} ${TAG}-${counter}`, phone: `${TAG}-${counter++}`, pinHash: 'x', role, active: true } });
  if (role === 'ADMIN') await grantAllCompaniesForTest(prisma, row.id); // a política exige vínculo para ADMIN resgatar
  userIds.push(row.id);
  return { id: row.id, name: row.name, role };
}

interface Unit { campaignId: string; showroom: ValePass; closet: ValePass }
async function newUnit(campaign: { id?: string; name?: string; amountCents?: number; variant?: string; testLabels?: boolean }): Promise<Unit> {
  const created = await prisma.valePassCampaign.create({
    data: { ...(campaign.id ? { id: campaign.id } : {}), name: campaign.name ?? `${TAG}-camp-${counter++}`, amountCents: campaign.amountCents ?? 35_000, validityDays: 30, shopifyVariantId: campaign.variant ?? `${TAG}-var-${counter++}`, voucherValidFrom: new Date('2026-01-01'), voucherValidUntil: new Date('2027-12-31') },
  });
  campaignIds.push(created.id);
  const prefix = campaign.testLabels ? 'TESTE — ' : '';
  const [b1, b2] = await Promise.all([
    prisma.valePassCampaignBenefit.create({ data: { campaignId: created.id, code: campaign.testLabels ? 'teste_showroom' : 'valle_showroom_500', kind: 'VOUCHER', company: 'VALLE_SHOWROOM', label: `${prefix}Voucher Valle Showroom`, amountCents: 500, sortOrder: 0 } }),
    prisma.valePassCampaignBenefit.create({ data: { campaignId: created.id, code: campaign.testLabels ? 'teste_closet' : 'vs_by_closet_50', kind: 'VOUCHER', company: 'VS_BY_CLOSET', label: `${prefix}Voucher VS BY CLOSET`, amountCents: 50, sortOrder: 1 } }),
  ]);
  const orderId = `${TAG}-o${counter++}`;
  orderIds.push(orderId);
  const common = { campaignId: created.id, groupId: randomUUID(), shopifyOrderId: orderId, shopifyOrderName: '#T-TC', status: 'ACTIVE' as const, purchasedAt: new Date(), expiresAt: new Date('2027-12-31T03:00:00Z'), validFrom: new Date('2026-01-01T03:00:00Z'), customerName: 'Cliente Sintético', customerPhone: '+55 11 90000-0000', customerEmail: 'cliente@exemplo.invalid' };
  const showroom = await prisma.valePass.create({ data: { ...common, code: `VALLE-${TAG.slice(-4)}-A${counter++}`.toUpperCase(), amountCents: 500, company: 'VALLE_SHOWROOM', benefitId: b1.id } });
  const closet = await prisma.valePass.create({ data: { ...common, code: `VALLE-${TAG.slice(-4)}-B${counter++}`.toUpperCase(), amountCents: 50, company: 'VS_BY_CLOSET', benefitId: b2.id } });
  return { campaignId: created.id, showroom, closet };
}

const voucher = (id: string) => prisma.valePass.findUniqueOrThrow({ where: { id } });
const entries = (id: string) => prisma.valePassLedgerEntry.findMany({ where: { valePassId: id } });
const op = () => `op-${randomUUID()}`;
const rejection = async (promise: Promise<unknown>) => promise.then(() => null, (err: unknown) => err as { status?: number; response?: { code?: string }; message: string });
async function redeem(v: ValePass, amountCents: number, actor: Actor) {
  const current = await voucher(v.id);
  return redemption.confirmRedeem(v.code, { company: v.company as string, amountCents, reference: REF, operationId: op(), expectedBalanceCents: current.balanceCents, confirmAmountCents: amountCents }, actor);
}

async function cleanRows() {
  const ids = campaignIds.splice(0);
  const orders = orderIds.splice(0);
  await prisma.$transaction(async (tx) => {
    const rows = await tx.valePass.findMany({ where: { campaignId: { in: ids } }, select: { id: true } });
    await purgeLedgerForTest(tx, { campaignIds: ids });
    await tx.valePassEvent.deleteMany({ where: { valePassId: { in: rows.map((r) => r.id) } } });
    await tx.adminAuditEvent.deleteMany({ where: { OR: [{ entityId: { in: rows.map((r) => r.id) } }, { adminUserId: { in: userIds } }] } });
    await tx.valePassRefundApplication.deleteMany({ where: { shopifyOrderId: { in: orders } } });
    await tx.valePassOrderCancellation.deleteMany({ where: { shopifyOrderId: { in: orders } } });
    await tx.valePass.deleteMany({ where: { campaignId: { in: ids } } });
    await tx.valePassCampaignBenefit.deleteMany({ where: { campaignId: { in: ids } } });
    await tx.valePassCampaign.deleteMany({ where: { id: { in: ids } } });
  });
}
let owner: Actor;
beforeAll(async () => {
  if (!localDatabase) return;
  owner = await newUser('SUPER_ADMIN');
});
afterEach(async () => {
  if (localDatabase) await cleanRows();
});
afterAll(async () => {
  if (localDatabase) {
    await cleanRows();
    await prisma.adminAuditEvent.deleteMany({ where: { adminUserId: { in: userIds } } });
    await prisma.adminUser.deleteMany({ where: { id: { in: userIds } } });
  }
  await prisma.$disconnect();
});

async function expectBlocked(u: Unit, actors: { label: string; actor: Actor }[]) {
  for (const { label, actor } of actors) {
    for (const v of [u.showroom, u.closet]) {
      const preview = await redemption.prepareRedeem(v.code, { company: v.company as string, amountCents: 10, reference: REF }, actor);
      expect(preview.canRedeem, `${label}: prévia`).toBe(false);
      expect(preview.problems.map((p) => p.code), `${label}: motivo`).toContain('TEST_CAMPAIGN');
      expect((await rejection(redeem(v, 10, actor)))?.response?.code, `${label}: confirmação`).toBe('TEST_CAMPAIGN');
      const view = await redemption.lookup(v.code, actor);
      expect(view.restrictions.map((r) => r.code), `${label}: consulta`).toContain('TEST_CAMPAIGN');
    }
  }
  for (const v of [u.showroom, u.closet]) {
    expect(await entries(v.id)).toHaveLength(0);
    expect((await voucher(v.id)).balanceCents).toBe(v.amountCents);
  }
  expect(await ledger.reconcile()).toEqual([]);
}

localDescribe('campanha de TESTE: vouchers sem valor comercial', () => {
  test('identificada pelo ID da campanha: ADMIN, SUPER_ADMIN e STAFF vinculado às duas empresas são recusados na prévia, na confirmação e na consulta; nada é gravado', async () => {
    const u = await newUnit({ id: TEST_CAMPAIGN_ID, variant: `${TAG}-variante-qualquer`, name: 'VALLE PASS TESTE', amountCents: 10, testLabels: true });
    const admin = await newUser('ADMIN');
    const staff = await newUser('STAFF');
    await scopes.grant(staff.id, 'VALLE_SHOWROOM', owner);
    await scopes.grant(staff.id, 'VS_BY_CLOSET', owner);
    await expectBlocked(u, [{ label: 'ADMIN', actor: admin }, { label: 'SUPER_ADMIN', actor: owner }, { label: 'STAFF vinculado', actor: staff }]);
  });

  test('identificada pelo Variant ID (com outro ID de campanha): também bloqueada', async () => {
    const u = await newUnit({ variant: TEST_CAMPAIGN_VARIANT_ID, name: 'Outro nome qualquer', amountCents: 35_000, testLabels: false });
    await expectBlocked(u, [{ label: 'ADMIN', actor: await newUser('ADMIN') }]);
  });

  test('o "marcar como utilizado" legado também é recusado (ADMIN e SUPER_ADMIN) e o voucher segue ATIVO', async () => {
    const u = await newUnit({ id: TEST_CAMPAIGN_ID, variant: `${TAG}-v2`, testLabels: true });
    const admin = await newUser('ADMIN');
    for (const actor of [admin, owner]) {
      const refused = await rejection(vouchersService.markUsed(u.showroom.code, actor.id, actor.name, { role: actor.role }));
      expect(refused?.response?.code).toBe('TEST_CAMPAIGN');
    }
    expect((await voucher(u.showroom.id)).status).toBe('ACTIVE');
  });

  test('o CANCELAMENTO continua permitido (é assim que o voucher de teste é desativado ao final)', async () => {
    const u = await newUnit({ id: TEST_CAMPAIGN_ID, variant: `${TAG}-v3`, testLabels: true });
    const admin = await newUser('ADMIN');
    await vouchersService.cancel(u.showroom.code, 'Encerramento do teste de compra (sintético)', admin.id, admin.name);
    await vouchersService.cancel(u.closet.code, 'Encerramento do teste de compra (sintético)', admin.id, admin.name);
    expect((await voucher(u.showroom.id)).status).toBe('CANCELLED');
    expect((await voucher(u.closet.id)).status).toBe('CANCELLED');
  });

  test('a campanha OFICIAL segue resgatando normalmente (ADMIN e STAFF vinculado), mesmo com nome "TESTE", preço baixo e rótulos "TESTE": a identificação é só ID/variante', async () => {
    const official = await newUnit({ name: 'Valle Pass 2027', amountCents: 35_000 });
    const lookalike = await newUnit({ name: 'VALLE PASS TESTE', amountCents: 10, testLabels: true }); // nome, preço e rótulos de teste, mas ID e variante comuns
    const admin = await newUser('ADMIN');
    const staff = await newUser('STAFF');
    await scopes.grant(staff.id, 'VALLE_SHOWROOM', owner);
    for (const u of [official, lookalike]) {
      expect(await redeem(u.showroom, 100, admin)).toMatchObject({ balanceCents: 400, entry: { kind: 'REDEEM', deltaCents: -100 } });
      expect(await redeem(u.showroom, 50, staff)).toMatchObject({ balanceCents: 350 });
      const view = await redemption.lookup(u.showroom.code, admin);
      expect(view.restrictions.map((r) => r.code)).not.toContain('TEST_CAMPAIGN');
    }
    expect(await ledger.reconcile()).toEqual([]);
  });
});
