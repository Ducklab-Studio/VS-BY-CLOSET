import { afterAll, afterEach, beforeAll, describe, expect, test } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Prisma, type ValePass } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { ConflictException } from '@nestjs/common';
import { ValePassVouchersService } from '../vale-pass-vouchers.service';
import { ValePassLedgerService } from './ledger.service';
import { purgeLedgerForTest } from './ledger-test-utils';

/**
 * Fase 3 / PR A — saldo por voucher e livro-razão IMUTÁVEL, em PostgreSQL LOCAL descartável. Aqui se prova o que o BANCO garante (gatilhos e constraints),
 * independente de qualquer serviço: é a última linha de defesa do saldo.
 */
const localDatabase = /^postgres(?:ql)?:\/\/[^@]+@(localhost|127\.0\.0\.1)(:\d+)?\/[^/]*(test|audit|operational)/i.test(process.env.DATABASE_URL ?? '');
const localDescribe = localDatabase ? describe : describe.skip;

const prisma = new PrismaService();
const ledger = new ValePassLedgerService(prisma);
const vouchersService = new ValePassVouchersService(prisma);
let adminId = '';
const ADMIN_NAME = 'Admin Teste Ledger';
const TAG = `VPLG-${Date.now()}`;
let counter = 0;
const campaignIds: string[] = [];
const orderIds: string[] = [];

interface Unit { campaignId: string; orderId: string; groupId: string; showroom: ValePass; closet: ValePass }

async function newUnit(over: { validFrom?: Date | null; expiresAt?: Date } = {}): Promise<Unit> {
  const campaign = await prisma.valePassCampaign.create({
    data: { name: `${TAG}-camp-${counter++}`, amountCents: 35_000, validityDays: 30, shopifyVariantId: `${TAG}-var-${counter++}`, voucherValidFrom: new Date('2026-01-01'), voucherValidUntil: new Date('2027-09-30') },
  });
  campaignIds.push(campaign.id);
  const benefits = await Promise.all([
    prisma.valePassCampaignBenefit.create({ data: { campaignId: campaign.id, code: 'valle_showroom_500', kind: 'VOUCHER', company: 'VALLE_SHOWROOM', label: 'Voucher Valle Showroom', amountCents: 50_000, sortOrder: 0 } }),
    prisma.valePassCampaignBenefit.create({ data: { campaignId: campaign.id, code: 'vs_by_closet_50', kind: 'VOUCHER', company: 'VS_BY_CLOSET', label: 'Voucher VS BY CLOSET', amountCents: 5_000, sortOrder: 1 } }),
  ]);
  const orderId = `${TAG}-o${counter++}`;
  orderIds.push(orderId);
  const groupId = randomUUID();
  const common = { campaignId: campaign.id, groupId, shopifyOrderId: orderId, status: 'ACTIVE' as const, purchasedAt: new Date(), expiresAt: over.expiresAt ?? new Date('2027-10-01T03:00:00Z'), validFrom: over.validFrom === undefined ? new Date('2026-01-01T03:00:00Z') : over.validFrom };
  const showroom = await prisma.valePass.create({ data: { ...common, code: `${TAG}-A${counter++}`, amountCents: 50_000, company: 'VALLE_SHOWROOM', benefitId: benefits[0].id, balanceCents: 1 } }); // o 1 informado é IGNORADO
  const closet = await prisma.valePass.create({ data: { ...common, code: `${TAG}-B${counter++}`, amountCents: 5_000, company: 'VS_BY_CLOSET', benefitId: benefits[1].id } });
  return { campaignId: campaign.id, orderId, groupId, showroom, closet };
}

let keySeq = 0;
const key = () => `${TAG}-key-${keySeq++}-${randomUUID().slice(0, 8)}`;
/** Lança no livro-razão (seq e saldo resultante são calculados/validados pelo banco). */
const post = (voucherId: string, kind: 'REDEEM' | 'REVERSAL', deltaCents: number, extra: Partial<Prisma.ValePassLedgerEntryUncheckedCreateInput> = {}) =>
  prisma.valePassLedgerEntry.create({ data: { valePassId: voucherId, seq: 1, balanceAfterCents: 0, kind, deltaCents, idempotencyKey: key(), reference: 'teste', ...extra } });
const redeem = (voucherId: string, cents: number, extra: Partial<Prisma.ValePassLedgerEntryUncheckedCreateInput> = {}) => post(voucherId, 'REDEEM', -cents, extra);
const voucher = (id: string) => prisma.valePass.findUniqueOrThrow({ where: { id } });
const entries = (id: string) => prisma.valePassLedgerEntry.findMany({ where: { valePassId: id }, orderBy: { seq: 'asc' } });
const sql = async (statement: Prisma.Sql) => prisma.$transaction(async (tx) => tx.$executeRaw(statement));
/** Altera um voucher "por fora" dos gatilhos (replica) — só para montar cenários impossíveis pelo caminho normal. */
const outOfBand = (statement: (tx: Prisma.TransactionClient) => Promise<unknown>) =>
  prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe('SET LOCAL session_replication_role = replica');
    await statement(tx);
  });

async function cleanRows() {
  const ids = campaignIds.splice(0);
  const orders = orderIds.splice(0);
  await prisma.$transaction(async (tx) => {
    const rows = await tx.valePass.findMany({ where: { campaignId: { in: ids } }, select: { id: true } });
    await purgeLedgerForTest(tx, { campaignIds: ids });
    await tx.valePassEvent.deleteMany({ where: { valePassId: { in: rows.map((r) => r.id) } } });
    await tx.adminAuditEvent.deleteMany({ where: { OR: [{ entityId: { in: rows.map((r) => r.id) } }, { adminUserId: adminId || undefined }] } });
    await tx.valePassRefundApplication.deleteMany({ where: { shopifyOrderId: { in: orders } } });
    await tx.valePass.deleteMany({ where: { campaignId: { in: ids } } });
    await tx.valePassCampaignBenefit.deleteMany({ where: { campaignId: { in: ids } } });
    await tx.valePassCampaign.deleteMany({ where: { id: { in: ids } } });
  });
}
beforeAll(async () => {
  if (!localDatabase) return;
  adminId = (await prisma.adminUser.create({ data: { name: ADMIN_NAME, phone: `${TAG}-admin`, pinHash: 'x', role: 'ADMIN', active: true } })).id;
});
afterEach(async () => {
  if (localDatabase) await cleanRows();
});
afterAll(async () => {
  if (localDatabase) {
    await cleanRows();
    await prisma.adminUser.deleteMany({ where: { id: adminId } });
  }
  await prisma.$disconnect();
});

localDescribe('saldo nasce cheio e é independente por empresa', () => {
  test('R$ 500 = 50000 centavos (Valle Showroom) e R$ 50 = 5000 (VS BY CLOSET); o saldo informado no INSERT é ignorado', async () => {
    const u = await newUnit();
    expect(await voucher(u.showroom.id)).toMatchObject({ amountCents: 50_000, balanceCents: 50_000, company: 'VALLE_SHOWROOM' });
    expect(await voucher(u.closet.id)).toMatchObject({ amountCents: 5_000, balanceCents: 5_000, company: 'VS_BY_CLOSET' });
    expect(await ledger.reconcile()).toEqual([]);
  });

  test('resgate parcial: 500 → 200 → saldo 300 → 100 → saldo 200; o saldo da VS BY CLOSET não se mexe; histórico numerado sem buracos', async () => {
    const u = await newUnit();
    const first = await redeem(u.showroom.id, 20_000, { actorName: 'Operador', reference: 'Nota 1' });
    expect(first).toMatchObject({ seq: 1, kind: 'REDEEM', company: 'VALLE_SHOWROOM', deltaCents: -20_000, balanceAfterCents: 30_000 });
    expect(await voucher(u.showroom.id)).toMatchObject({ balanceCents: 30_000, status: 'ACTIVE', usedAt: null });
    const second = await redeem(u.showroom.id, 10_000);
    expect(second).toMatchObject({ seq: 2, balanceAfterCents: 20_000 });
    expect(await voucher(u.showroom.id)).toMatchObject({ balanceCents: 20_000, status: 'ACTIVE' });
    // a outra empresa: intocada e com seu próprio histórico
    expect(await voucher(u.closet.id)).toMatchObject({ balanceCents: 5_000, status: 'ACTIVE' });
    await redeem(u.closet.id, 2_000);
    expect(await voucher(u.closet.id)).toMatchObject({ balanceCents: 3_000 });
    expect(await voucher(u.showroom.id)).toMatchObject({ balanceCents: 20_000 });
    expect((await entries(u.closet.id)).map((e) => [e.seq, e.company])).toEqual([[1, 'VS_BY_CLOSET']]);
    expect((await entries(u.showroom.id)).map((e) => e.seq)).toEqual([1, 2]);
    expect(await ledger.reconcile()).toEqual([]);
  });

  test('resgate total zera o saldo, marca USED (com data e operador) e a reversão devolve o saldo e reativa', async () => {
    const u = await newUnit();
    const admin = randomUUID();
    const all = await redeem(u.closet.id, 5_000, { actorAdminId: admin });
    expect(await voucher(u.closet.id)).toMatchObject({ balanceCents: 0, status: 'USED', usedBy: admin });
    expect((await voucher(u.closet.id)).usedAt).not.toBeNull();
    await expect(redeem(u.closet.id, 1)).rejects.toThrow(/vale_pass_ledger_not_redeemable/);
    const back = await post(u.closet.id, 'REVERSAL', 5_000, { reversesEntryId: all.id, reason: 'lançado por engano' });
    expect(back).toMatchObject({ seq: 2, balanceAfterCents: 5_000, reversesEntryId: all.id });
    expect(await voucher(u.closet.id)).toMatchObject({ balanceCents: 5_000, status: 'ACTIVE', usedAt: null, usedBy: null });
    expect(await ledger.reconcile()).toEqual([]);
  });
});

localDescribe('o banco recusa o que nunca pode acontecer', () => {
  test('acima do saldo, zero, valor negativo no sentido errado e crédito acima do emitido', async () => {
    const u = await newUnit();
    await redeem(u.showroom.id, 20_000);
    await expect(redeem(u.showroom.id, 30_001)).rejects.toThrow(/vale_pass_ledger_insufficient_balance/);
    expect(await voucher(u.showroom.id)).toMatchObject({ balanceCents: 30_000 });
    await expect(post(u.showroom.id, 'REDEEM', 0)).rejects.toThrow(/delta_nonzero|23514/);
    await expect(post(u.showroom.id, 'REDEEM', 100)).rejects.toThrow(/sign_matches_kind|23514/); // resgate com sinal positivo
    await expect(post(u.showroom.id, 'REVERSAL', -100, { reversesEntryId: (await entries(u.showroom.id))[0].id })).rejects.toThrow(/sign_matches_kind|23514/);
    // limites: o saldo exato (30000) é aceito; 1 centavo a mais não
    await expect(redeem(u.showroom.id, 30_000)).resolves.toMatchObject({ balanceAfterCents: 0 });
    expect(await ledger.reconcile()).toEqual([]);
  });

  test('empresa: o lançamento é sempre da empresa do voucher; informar outra é recusado', async () => {
    const u = await newUnit();
    await expect(redeem(u.closet.id, 100, { company: 'VALLE_SHOWROOM' })).rejects.toThrow(/vale_pass_ledger_company_mismatch/);
    await expect(redeem(u.showroom.id, 100, { company: 'VS_BY_CLOSET' })).rejects.toThrow(/vale_pass_ledger_company_mismatch/);
    await expect(redeem(u.closet.id, 100, { company: 'VS_BY_CLOSET' })).resolves.toMatchObject({ company: 'VS_BY_CLOSET' });
  });

  test('idempotência no banco: a mesma chave não lança duas vezes (e o saldo não é descontado de novo); chave curta é recusada', async () => {
    const u = await newUnit();
    const k = key();
    await redeem(u.showroom.id, 5_000, { idempotencyKey: k });
    await expect(redeem(u.showroom.id, 5_000, { idempotencyKey: k })).rejects.toMatchObject({ code: 'P2002' });
    expect(await voucher(u.showroom.id)).toMatchObject({ balanceCents: 45_000 });
    expect(await entries(u.showroom.id)).toHaveLength(1);
    await expect(redeem(u.showroom.id, 100, { idempotencyKey: 'curta' })).rejects.toThrow(/idempotency_key_len|23514/);
    // a mesma chave em OUTRO voucher é outra operação
    await expect(redeem(u.closet.id, 1_000, { idempotencyKey: k })).resolves.toBeTruthy();
  });

  test('reversão: só de resgate do MESMO voucher, valor exato, uma única vez; reversão de reversão e de lançamento alheio são recusadas', async () => {
    const u = await newUnit();
    const original = await redeem(u.showroom.id, 10_000);
    const other = await redeem(u.closet.id, 1_000);
    await expect(post(u.showroom.id, 'REVERSAL', 9_999, { reversesEntryId: original.id })).rejects.toThrow(/vale_pass_ledger_bad_reversal/);
    await expect(post(u.showroom.id, 'REVERSAL', 1_000, { reversesEntryId: other.id })).rejects.toThrow(/vale_pass_ledger_bad_reversal/);
    const done = await post(u.showroom.id, 'REVERSAL', 10_000, { reversesEntryId: original.id });
    await expect(post(u.showroom.id, 'REVERSAL', 10_000, { reversesEntryId: original.id })).rejects.toThrow(/vale_pass_ledger_already_reversed/); // reversão dupla
    await expect(post(u.showroom.id, 'REVERSAL', 10_000, { reversesEntryId: done.id })).rejects.toThrow(/vale_pass_ledger_bad_reversal/); // reversão de reversão
    await expect(post(u.showroom.id, 'REVERSAL', 10_000, {})).rejects.toThrow(/reversal_reference|23514/); // sem lançamento de origem
    expect(await voucher(u.showroom.id)).toMatchObject({ balanceCents: 50_000 });
    expect(await ledger.reconcile()).toEqual([]);
  });

  test('ADJUSTMENT e REFUND_WRITEOFF estão DESABILITADOS no banco (falta política comercial aprovada)', async () => {
    const u = await newUnit();
    await expect(prisma.valePassLedgerEntry.create({ data: { valePassId: u.showroom.id, seq: 1, balanceAfterCents: 0, kind: 'ADJUSTMENT', deltaCents: -100, idempotencyKey: key() } })).rejects.toThrow(/vale_pass_ledger_kind_disabled/);
    await expect(prisma.valePassLedgerEntry.create({ data: { valePassId: u.showroom.id, seq: 1, balanceAfterCents: 0, kind: 'REFUND_WRITEOFF', deltaCents: -50_000, idempotencyKey: key() } })).rejects.toThrow(/vale_pass_ledger_kind_disabled/);
    expect(await voucher(u.showroom.id)).toMatchObject({ balanceCents: 50_000 });
  });

  test('o histórico é imutável: UPDATE, DELETE e TRUNCATE são recusados', async () => {
    const u = await newUnit();
    const e = await redeem(u.showroom.id, 100);
    await expect(sql(Prisma.sql`UPDATE vale_pass_ledger_entries SET delta_cents = -1 WHERE id = ${e.id}::uuid`)).rejects.toThrow(/vale_pass_ledger_immutable/);
    await expect(sql(Prisma.sql`UPDATE vale_pass_ledger_entries SET reason = 'x'`)).rejects.toThrow(/vale_pass_ledger_immutable/);
    await expect(sql(Prisma.sql`DELETE FROM vale_pass_ledger_entries WHERE id = ${e.id}::uuid`)).rejects.toThrow(/vale_pass_ledger_immutable/);
    await expect(prisma.valePassLedgerEntry.deleteMany({ where: { valePassId: u.showroom.id } })).rejects.toThrow(/vale_pass_ledger_immutable/);
    await expect(prisma.$executeRawUnsafe('TRUNCATE vale_pass_ledger_entries')).rejects.toThrow(/vale_pass_ledger_immutable/);
    expect(await entries(u.showroom.id)).toHaveLength(1);
  });

  test('o saldo só muda por lançamento: UPDATE direto de saldo, USED com saldo e ACTIVE zerado são recusados; excluir voucher com histórico também', async () => {
    const u = await newUnit();
    await expect(prisma.valePass.update({ where: { id: u.showroom.id }, data: { balanceCents: 1 } })).rejects.toThrow(/vale_pass_balance_direct_update/);
    await expect(sql(Prisma.sql`UPDATE vale_passes SET balance_cents = 0 WHERE id = ${u.showroom.id}::uuid`)).rejects.toThrow(/vale_pass_balance_direct_update/);
    await expect(prisma.valePass.update({ where: { id: u.showroom.id }, data: { status: 'USED', usedAt: new Date() } })).rejects.toThrow(/vale_pass_used_requires_zero_balance/);
    await redeem(u.closet.id, 5_000); // zera: vira USED pelo ledger
    await expect(prisma.valePass.update({ where: { id: u.closet.id }, data: { status: 'ACTIVE' } })).rejects.toThrow(/vale_pass_active_requires_balance/);
    await expect(prisma.valePass.update({ where: { id: u.closet.id }, data: { balanceCents: 5_000 } })).rejects.toThrow(/vale_pass_balance_direct_update/);
    await expect(prisma.valePass.delete({ where: { id: u.closet.id } })).rejects.toThrow(); // FK do histórico
    expect(await voucher(u.closet.id)).toMatchObject({ balanceCents: 0, status: 'USED' });
    // o saldo dentro de [0, valor] também é uma constraint
    await expect(outOfBand((tx) => tx.$executeRaw`UPDATE vale_passes SET balance_cents = 50001 WHERE id = ${u.showroom.id}::uuid`)).rejects.toThrow(/balance_within_amount|23514/);
  });
});

localDescribe('o resgate só é aceito em voucher resgatável', () => {
  test('cancelado, expirado (status e data), bloqueado, ainda sem validade e legado (sem empresa) são recusados', async () => {
    const u = await newUnit();
    await prisma.valePass.update({ where: { id: u.showroom.id }, data: { status: 'CANCELLED', cancelledAt: new Date(), cancelReason: 'teste' } });
    await expect(redeem(u.showroom.id, 100)).rejects.toThrow(/vale_pass_ledger_not_redeemable/);
    await prisma.valePass.update({ where: { id: u.closet.id }, data: { blockedAt: new Date(), blockReason: 'suspeita de fraude' } });
    await expect(redeem(u.closet.id, 100)).rejects.toThrow(/vale_pass_ledger_blocked/);
    await prisma.valePass.update({ where: { id: u.closet.id }, data: { blockedAt: null, blockReason: null } });
    await expect(redeem(u.closet.id, 100)).resolves.toBeTruthy();

    const past = await newUnit({ expiresAt: new Date(Date.now() - 3_600_000), validFrom: new Date('2025-01-01') });
    await expect(redeem(past.showroom.id, 100)).rejects.toThrow(/vale_pass_ledger_expired/);
    await prisma.valePass.update({ where: { id: past.closet.id }, data: { status: 'EXPIRED' } });
    await expect(redeem(past.closet.id, 100)).rejects.toThrow(/vale_pass_ledger_not_redeemable/);
    const future = await newUnit({ validFrom: new Date(Date.now() + 86_400_000) });
    await expect(redeem(future.showroom.id, 100)).rejects.toThrow(/vale_pass_ledger_not_yet_valid/);

    const campaign = await prisma.valePassCampaign.findFirstOrThrow({ where: { id: u.campaignId } });
    const legacy = await prisma.valePass.create({ data: { code: `${TAG}-LEG`, campaignId: campaign.id, amountCents: 35_000, purchasedAt: new Date(), expiresAt: new Date(Date.now() + 86_400_000) } });
    expect(await voucher(legacy.id)).toMatchObject({ balanceCents: 35_000, company: null });
    await expect(redeem(legacy.id, 100)).rejects.toThrow(/vale_pass_ledger_legacy_voucher/);
    // o legado continua "tudo ou nada" por status, sem tocar no saldo
    await expect(prisma.valePass.update({ where: { id: legacy.id }, data: { status: 'USED', usedAt: new Date() } })).resolves.toMatchObject({ status: 'USED' });
  });

  test('reembolso em revisão bloqueia QUALQUER resgate (parcial também) da unidade ou do pedido; depois de resolvida, volta', async () => {
    const u = await newUnit();
    const other = await newUnit();
    const review = await prisma.valePassRefundApplication.create({
      data: { shopifyRefundId: `${TAG}-rf-${counter++}`, shopifyOrderId: u.orderId, classification: 'UNITS', refundedUnits: 1, status: 'NEEDS_REVIEW', reviewReasons: ['UNIT_CONFIRMATION_REQUIRED'], detail: { reviewGroupIds: [u.groupId] } },
    });
    await expect(redeem(u.showroom.id, 100)).rejects.toThrow(/vale_pass_use_blocked_refund_review/);
    await expect(redeem(u.closet.id, 100)).rejects.toThrow(/vale_pass_use_blocked_refund_review/);
    await expect(redeem(other.showroom.id, 100)).resolves.toBeTruthy(); // outro pedido não é afetado
    expect(await voucher(u.showroom.id)).toMatchObject({ balanceCents: 50_000 });
    await prisma.valePassRefundApplication.update({ where: { id: review.id }, data: { status: 'RESOLVED', resolution: 'KEEP_VOUCHERS', resolvedAt: new Date(), resolvedBy: randomUUID(), resolutionNote: 'decisão do administrador (teste)' } });
    await expect(redeem(u.showroom.id, 100)).resolves.toBeTruthy();
    // revisão SEM unidade identificada vale para o pedido todo
    await prisma.valePassRefundApplication.create({ data: { shopifyRefundId: `${TAG}-rf-${counter++}`, shopifyOrderId: other.orderId, classification: 'AMOUNT_ONLY', status: 'NEEDS_REVIEW', reviewReasons: ['AMOUNT_ONLY_REFUND'], detail: { reviewGroupIds: [] } } });
    await expect(redeem(other.closet.id, 100)).rejects.toThrow(/vale_pass_use_blocked_refund_review/);
  });
});

localDescribe('compatibilidade: o endpoint legado de "usado" não contorna o livro-razão', () => {
  test('voucher novo ainda não tocado: "marcar como usado" vira resgate INTEGRAL no ledger (USED, saldo 0, operador gravado); repetir não desconta de novo', async () => {
    const u = await newUnit();
    const used = await vouchersService.markUsed(u.showroom.code, adminId, ADMIN_NAME);
    expect(used).toMatchObject({ status: 'USED', balanceCents: 0, usedCents: 50_000, amountCents: 50_000 });
    expect(await entries(u.showroom.id)).toMatchObject([{ kind: 'REDEEM', deltaCents: -50_000, balanceAfterCents: 0, reference: 'LEGACY_USE_ENDPOINT', actorAdminId: adminId, actorName: ADMIN_NAME }]);
    await expect(vouchersService.markUsed(u.showroom.code, adminId, ADMIN_NAME)).rejects.toThrow(/não pode ser utilizado/);
    expect(await entries(u.showroom.id)).toHaveLength(1);
    expect(await voucher(u.closet.id)).toMatchObject({ balanceCents: 5_000, status: 'ACTIVE' }); // o irmão (outra empresa) não é tocado
    expect(await ledger.reconcile()).toEqual([]);
  });

  test('voucher com utilização parcial: "usado" por inteiro e cancelamento são recusados (409) e nada muda', async () => {
    const u = await newUnit();
    await redeem(u.showroom.id, 20_000);
    await expect(vouchersService.markUsed(u.showroom.code, adminId, ADMIN_NAME)).rejects.toBeInstanceOf(ConflictException);
    await expect(vouchersService.cancel(u.showroom.code, 'tentativa de cancelar parcialmente usado', adminId, ADMIN_NAME)).rejects.toBeInstanceOf(ConflictException);
    expect(await voucher(u.showroom.id)).toMatchObject({ balanceCents: 30_000, status: 'ACTIVE', cancelledAt: null });
    expect(await entries(u.showroom.id)).toHaveLength(1);
    // voucher não tocado continua podendo ser cancelado (comportamento de sempre)
    await expect(vouchersService.cancel(u.closet.code, 'cancelamento administrativo (teste)', adminId, ADMIN_NAME)).resolves.toMatchObject({ status: 'CANCELLED' });
  });

  test('cinco "marcar como usado" simultâneos do mesmo voucher: exatamente um vale, um único lançamento', async () => {
    const u = await newUnit();
    const results = await Promise.allSettled(Array.from({ length: 5 }, () => vouchersService.markUsed(u.closet.code, adminId, ADMIN_NAME)));
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(await entries(u.closet.id)).toHaveLength(1);
    expect(await voucher(u.closet.id)).toMatchObject({ status: 'USED', balanceCents: 0 });
  });

  test('voucher LEGADO (sem empresa) continua tudo ou nada, sem lançamentos', async () => {
    const u = await newUnit();
    const legacy = await prisma.valePass.create({ data: { code: `${TAG}-LEGUSE`, campaignId: u.campaignId, amountCents: 35_000, purchasedAt: new Date(), expiresAt: new Date(Date.now() + 86_400_000) } });
    await expect(vouchersService.markUsed(legacy.code, adminId, ADMIN_NAME)).resolves.toMatchObject({ status: 'USED' });
    expect(await entries(legacy.id)).toHaveLength(0);
  });
});

localDescribe('concorrência, conciliação e propriedades', () => {
  test('12 resgates simultâneos de R$ 100 sobre saldo de R$ 500: exatamente 5 passam, saldo 0, seq 1..5 sem buracos, nenhum saldo negativo', async () => {
    const u = await newUnit();
    const results = await Promise.allSettled(Array.from({ length: 12 }, () => redeem(u.showroom.id, 10_000)));
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(5);
    for (const r of results) if (r.status === 'rejected') expect(String(r.reason)).toMatch(/vale_pass_ledger_insufficient_balance|vale_pass_ledger_not_redeemable/);
    expect(await voucher(u.showroom.id)).toMatchObject({ balanceCents: 0, status: 'USED' });
    expect((await entries(u.showroom.id)).map((e) => [e.seq, e.balanceAfterCents])).toEqual([[1, 40_000], [2, 30_000], [3, 20_000], [4, 10_000], [5, 0]]);
    expect(await ledger.reconcile()).toEqual([]);
  });

  test('a MESMA chave de idempotência disparada em paralelo lança uma única vez', async () => {
    const u = await newUnit();
    const k = key();
    const results = await Promise.allSettled(Array.from({ length: 8 }, () => redeem(u.showroom.id, 5_000, { idempotencyKey: k })));
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(await voucher(u.showroom.id)).toMatchObject({ balanceCents: 45_000 });
  });

  test('resgate e reversão simultâneos: o saldo final sempre bate com o livro-razão', async () => {
    const u = await newUnit();
    const base = await redeem(u.showroom.id, 10_000);
    await Promise.allSettled([
      ...Array.from({ length: 6 }, () => redeem(u.showroom.id, 4_000)),
      post(u.showroom.id, 'REVERSAL', 10_000, { reversesEntryId: base.id }),
      post(u.showroom.id, 'REVERSAL', 10_000, { reversesEntryId: base.id }),
    ]);
    const v = await voucher(u.showroom.id);
    const sum = (await entries(u.showroom.id)).reduce((acc, e) => acc + e.deltaCents, 0);
    expect(v.balanceCents).toBe(v.amountCents + sum);
    expect(v.balanceCents).toBeGreaterThanOrEqual(0);
    expect(await ledger.reconcile()).toEqual([]);
  });

  test('conciliação acusa cache adulterado, buraco de sequência, lançamento de outra empresa e status incoerente — e fica vazia quando corrigido', async () => {
    const u = await newUnit();
    await redeem(u.showroom.id, 10_000);
    await redeem(u.showroom.id, 10_000);
    await outOfBand((tx) => tx.$executeRaw`UPDATE vale_passes SET balance_cents = 12345 WHERE id = ${u.showroom.id}::uuid`);
    expect((await ledger.reconcile()).map((p) => p.problem).sort()).toEqual(['SALDO_DIVERGE', 'ULTIMO_SALDO_DIVERGE']);
    await outOfBand((tx) => tx.$executeRaw`UPDATE vale_passes SET balance_cents = 30000 WHERE id = ${u.showroom.id}::uuid`);
    expect(await ledger.reconcile()).toEqual([]);
    await outOfBand((tx) => tx.$executeRaw`UPDATE vale_pass_ledger_entries SET seq = 7 WHERE vale_pass_id = ${u.showroom.id}::uuid AND seq = 2`);
    expect((await ledger.reconcile()).map((p) => p.problem)).toContain('SEQ_COM_BURACO');
    await outOfBand((tx) => tx.$executeRaw`UPDATE vale_pass_ledger_entries SET seq = 2 WHERE vale_pass_id = ${u.showroom.id}::uuid AND seq = 7`);
    await outOfBand((tx) => tx.$executeRaw`UPDATE vale_pass_ledger_entries SET company = 'VS_BY_CLOSET' WHERE vale_pass_id = ${u.showroom.id}::uuid AND seq = 1`);
    expect((await ledger.reconcile()).map((p) => p.problem)).toEqual(['LANCAMENTO_EMPRESA']);
    await outOfBand((tx) => tx.$executeRaw`UPDATE vale_pass_ledger_entries SET company = 'VALLE_SHOWROOM' WHERE vale_pass_id = ${u.showroom.id}::uuid AND seq = 1`);
    await outOfBand((tx) => tx.$executeRaw`UPDATE vale_passes SET status = 'USED' WHERE id = ${u.showroom.id}::uuid`);
    expect((await ledger.reconcile()).map((p) => p.problem)).toEqual(['STATUS_SALDO']);
    await outOfBand((tx) => tx.$executeRaw`UPDATE vale_passes SET status = 'ACTIVE' WHERE id = ${u.showroom.id}::uuid`);
    expect(await ledger.reconcile()).toEqual([]);
  });

  test('propriedade: 300 operações aleatórias (resgates, reversões, valores de borda) nunca violam 0 ≤ saldo ≤ valor e o saldo sempre é valor + Σ lançamentos', async () => {
    const u = await newUnit();
    let seed = 20_271_030;
    const rand = (n: number) => { seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648; return seed % n; };
    const volume = [1, 99, 100, 2_500, 4_999, 5_000, 20_000, 49_999, 50_000, 50_001];
    for (let i = 0; i < 300; i++) {
      const target = rand(2) === 0 ? u.showroom : u.closet;
      const list = await entries(target.id);
      const reversible = list.filter((e) => e.kind === 'REDEEM' && !list.some((r) => r.reversesEntryId === e.id));
      try {
        if (rand(4) === 0 && reversible.length > 0) {
          const pick = reversible[rand(reversible.length)];
          await post(target.id, 'REVERSAL', -pick.deltaCents, { reversesEntryId: pick.id });
        } else {
          await redeem(target.id, volume[rand(volume.length)]);
        }
      } catch (err) {
        expect(String(err)).toMatch(/vale_pass_ledger_(insufficient_balance|not_redeemable|over_credit)/);
      }
      const v = await voucher(target.id);
      const sum = (await entries(target.id)).reduce((acc, e) => acc + e.deltaCents, 0);
      expect(v.balanceCents).toBe(v.amountCents + sum);
      expect(v.balanceCents).toBeGreaterThanOrEqual(0);
      expect(v.balanceCents).toBeLessThanOrEqual(v.amountCents);
      expect(v.status === 'USED').toBe(v.balanceCents === 0);
    }
    expect(await ledger.reconcile()).toEqual([]);
  }, 120_000);

  test('falha no meio da transação: tudo é desfeito (saldo, ledger e status)', async () => {
    const u = await newUnit();
    await expect(
      prisma.$transaction(async (tx) => {
        await tx.valePassLedgerEntry.create({ data: { valePassId: u.closet.id, seq: 1, balanceAfterCents: 0, kind: 'REDEEM', deltaCents: -5_000, idempotencyKey: key(), reference: 'teste' } });
        expect(await tx.valePass.findUniqueOrThrow({ where: { id: u.closet.id } })).toMatchObject({ balanceCents: 0, status: 'USED' });
        throw new Error('falha simulada depois do lançamento');
      }),
    ).rejects.toThrow('falha simulada');
    expect(await voucher(u.closet.id)).toMatchObject({ balanceCents: 5_000, status: 'ACTIVE' });
    expect(await entries(u.closet.id)).toHaveLength(0);
  });
});
